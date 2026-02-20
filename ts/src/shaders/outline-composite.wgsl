// Outline composite: reads the scene (scene-hdr) and the JFA result texture,
// computes distance to nearest seed at each pixel, and draws an outline
// where distance is within outlineWidth.
//
// When outlines are active, this pass writes directly to the swapchain,
// dead-pass culling the FXAATonemapPass.  Basic FXAA is included here so
// that anti-aliasing still applies to the composited output.

@group(0) @binding(0) var sceneTex: texture_2d<f32>;
@group(0) @binding(1) var jfaTex: texture_2d<f32>;
@group(0) @binding(2) var inputSampler: sampler;
@group(0) @binding(3) var<uniform> params: OutlineParams;

struct OutlineParams {
    outlineColor: vec4f,
    outlineWidth: f32,
    texelSize: vec2f,
    _pad: f32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

// Full-screen triangle: 3 vertices cover the entire screen
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(vertexIndex & 1u) * 4 - 1);
    let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
    out.position = vec4f(x, y, 0.0, 1.0);
    out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

// FXAA luminance (perceptual)
fn fxaaLuma(color: vec3f) -> f32 {
    return dot(color, vec3f(0.299, 0.587, 0.114));
}

// Simplified FXAA pass
fn applyFXAA(uv: vec2f, ts: vec2f) -> vec3f {
    let rgbM  = textureSample(sceneTex, inputSampler, uv).rgb;
    let rgbNW = textureSample(sceneTex, inputSampler, uv + vec2f(-ts.x, -ts.y)).rgb;
    let rgbNE = textureSample(sceneTex, inputSampler, uv + vec2f( ts.x, -ts.y)).rgb;
    let rgbSW = textureSample(sceneTex, inputSampler, uv + vec2f(-ts.x,  ts.y)).rgb;
    let rgbSE = textureSample(sceneTex, inputSampler, uv + vec2f( ts.x,  ts.y)).rgb;

    let lumaM  = fxaaLuma(rgbM);
    let lumaNW = fxaaLuma(rgbNW);
    let lumaNE = fxaaLuma(rgbNE);
    let lumaSW = fxaaLuma(rgbSW);
    let lumaSE = fxaaLuma(rgbSE);

    let lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
    let lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
    let lumaRange = lumaMax - lumaMin;

    if (lumaRange < max(0.0312, lumaMax * 0.125)) {
        return rgbM;
    }

    let dirSwMinusNe = lumaSW - lumaNE;
    let dirSeMinusNw = lumaSE - lumaNW;
    let dir = vec2f(dirSwMinusNe + dirSeMinusNw, dirSwMinusNe - dirSeMinusNw);
    let dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.25 * 0.25, 1.0 / 128.0);
    let rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    let d = clamp(dir * rcpDirMin, vec2f(-8.0), vec2f(8.0)) * ts;

    let rgbA = 0.5 * (
        textureSample(sceneTex, inputSampler, uv + d * (1.0/3.0 - 0.5)).rgb +
        textureSample(sceneTex, inputSampler, uv + d * (2.0/3.0 - 0.5)).rgb
    );
    let rgbB = rgbA * 0.5 + 0.25 * (
        textureSample(sceneTex, inputSampler, uv + d * -0.5).rgb +
        textureSample(sceneTex, inputSampler, uv + d *  0.5).rgb
    );

    let lumaB = fxaaLuma(rgbB);
    if (lumaB < lumaMin || lumaB > lumaMax) {
        return rgbA;
    }
    return rgbB;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let ts = params.texelSize;

    // Apply FXAA to the scene
    let scene = vec4f(applyFXAA(in.uv, ts), 1.0);

    // Read JFA result
    let jfa = textureSample(jfaTex, inputSampler, in.uv);

    // If no seed was propagated here, return scene as-is
    if (jfa.b < 0.5) {
        return scene;
    }

    // Compute distance to nearest seed in pixel units
    let dist = length((in.uv - jfa.rg) / ts);

    // Check if current pixel is part of the selected entity itself
    // (distance very small = on-surface seed)
    let seedSample = textureSample(jfaTex, inputSampler, in.uv);
    let selfDist = length((in.uv - seedSample.rg) / ts);
    if (selfDist < 1.0 && seedSample.b > 0.5) {
        // On the selected entity surface -- don't draw outline
        return scene;
    }

    // Smooth outline band
    let outlineAlpha = smoothstep(params.outlineWidth + 1.0, params.outlineWidth - 1.0, dist);

    return mix(scene, params.outlineColor, outlineAlpha * params.outlineColor.a);
}
