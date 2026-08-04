// Combined FXAA + tonemapping post-process pass.
// Full-screen triangle: vertex shader generates a quad covering the screen.

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: FxaaParams;

struct FxaaParams {
    texelSize: vec2f,     // 1.0 / resolution
    tonemapMode: u32,     // 0=none, 1=PBR-neutral, 2=ACES
    _pad: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

// Full-screen triangle trick: 3 vertices cover the entire screen
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

// Khronos PBR Neutral tonemapping
fn pbrNeutralTonemap(color: vec3f) -> vec3f {
    let startCompression = 0.8 - 0.04;
    let desaturation = 0.15;

    let x = min(color.r, min(color.g, color.b));
    let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
    var c = color - offset;

    let peak = max(c.r, max(c.g, c.b));
    if (peak < startCompression) {
        return c;
    }

    let d = 1.0 - startCompression;
    let newPeak = 1.0 - d * d / (peak + d - startCompression);
    c *= newPeak / peak;

    let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(c, vec3f(newPeak), g);
}

// ACES filmic tonemapping (Krzysztof Narkowicz approximation)
fn acesTonemap(x: vec3f) -> vec3f {
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return saturate((x * (a * x + b)) / (x * (c * x + d) + e));
}

// Map scene radiance to display space: the exact values that reach the
// swapchain. Mode 0 clamps rather than passing through, because the 8-bit unorm
// swapchain clamps on write anyway — doing it here keeps the FXAA contrast test
// below meaningful in all three modes instead of only two.
fn tonemap(color: vec3f) -> vec3f {
    if (params.tonemapMode == 1u) {
        return pbrNeutralTonemap(color);
    }
    if (params.tonemapMode == 2u) {
        return acesTonemap(color);
    }
    return clamp(color, vec3f(0.0), vec3f(1.0));
}

// One FXAA tap, already in display space. Every sample the filter looks at must
// go through here — see the note on fs_main.
fn resolveTexel(uv: vec2f) -> vec3f {
    return tonemap(textureSampleLevel(inputTex, inputSampler, uv, 0.0).rgb);
}

// FXAA runs on tonemapped output, not on raw HDR.
//
// Lottes' filter is specified over display-space LDR. Its contrast test,
// `lumaRange < max(0.0312, lumaMax * 0.125)`, carries an absolute floor tuned
// for a [0,1] range. `scene-hdr` is rgba16float, so its values are unbounded:
// run the test on them directly and it goes hypersensitive in bright regions
// and blind in dark ones. Tonemapping after the filter — which is what this
// shader used to do — leaves every luma comparison and the edge blend itself
// computed in the wrong space.
//
// So each tap is tonemapped at the point of sampling and all the FXAA maths
// happens in display space. There is deliberately no tonemap at the end: what
// this function returns is already the final pixel.
//
// Cost: up to 9 tonemap evaluations per pixel instead of 1. The alternative is
// splitting this into a tonemap pass plus a separate FXAA pass, which needs an
// extra full-screen pass and an intermediate LDR target, and puts a third
// writer on `swapchain` where BloomPass and OutlineCompositePass already
// contend.
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let uv = in.uv;
    let ts = params.texelSize;

    // --- FXAA (Lottes, simplified) ---
    let rgbM  = resolveTexel(uv);
    let rgbNW = resolveTexel(uv + vec2f(-ts.x, -ts.y));
    let rgbNE = resolveTexel(uv + vec2f( ts.x, -ts.y));
    let rgbSW = resolveTexel(uv + vec2f(-ts.x,  ts.y));
    let rgbSE = resolveTexel(uv + vec2f( ts.x,  ts.y));

    let lumaM  = fxaaLuma(rgbM);
    let lumaNW = fxaaLuma(rgbNW);
    let lumaNE = fxaaLuma(rgbNE);
    let lumaSW = fxaaLuma(rgbSW);
    let lumaSE = fxaaLuma(rgbSE);

    let lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
    let lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
    let lumaRange = lumaMax - lumaMin;

    // Early exit for low contrast regions
    if (lumaRange < max(0.0312, lumaMax * 0.125)) {
        return vec4f(rgbM, 1.0);
    }

    // Edge direction
    let dirSwMinusNe = lumaSW - lumaNE;
    let dirSeMinusNw = lumaSE - lumaNW;
    let dir = vec2f(dirSwMinusNe + dirSeMinusNw, dirSwMinusNe - dirSeMinusNw);
    let dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.25 * 0.25, 1.0 / 128.0);
    let rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    let d = clamp(dir * rcpDirMin, vec2f(-8.0), vec2f(8.0)) * ts;

    let rgbA = 0.5 * (
        resolveTexel(uv + d * (1.0/3.0 - 0.5)) +
        resolveTexel(uv + d * (2.0/3.0 - 0.5))
    );
    let rgbB = rgbA * 0.5 + 0.25 * (
        resolveTexel(uv + d * -0.5) +
        resolveTexel(uv + d *  0.5)
    );

    let lumaB = fxaaLuma(rgbB);
    if (lumaB < lumaMin || lumaB > lumaMax) {
        return vec4f(rgbA, 1.0);
    }
    return vec4f(rgbB, 1.0);
}
