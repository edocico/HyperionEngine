// SDF box shadow shader — Evan Wallace erf() technique for smooth shadows.
// PrimParams layout for BoxShadow:
//   [0]=rectW, [1]=rectH, [2]=cornerRadius, [3]=blur
//   [4]=colorR, [5]=colorG, [6]=colorB, [7]=colorA

struct CameraUniform {
    viewProjection: mat4x4f,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> texLayerIndices: array<u32>;
@group(0) @binding(4) var<storage, read> renderMeta: array<u32>;
@group(0) @binding(5) var<storage, read> primParams: array<f32>;

// Texture bindings (needed for bind group compatibility, unused by box shadow)
@group(1) @binding(0) var tier0Tex: texture_2d_array<f32>;
@group(1) @binding(1) var tier1Tex: texture_2d_array<f32>;
@group(1) @binding(2) var tier2Tex: texture_2d_array<f32>;
@group(1) @binding(3) var tier3Tex: texture_2d_array<f32>;
@group(1) @binding(4) var texSampler: sampler;

struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) entityIdx: u32,
    @location(2) @interpolate(flat) texTier: u32,
    @location(3) @interpolate(flat) texLayer: u32,
};

@vertex
fn vs_main(
    @location(0) position: vec3f,
    @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
    let entityIdx = visibleIndices[instanceIdx];
    let model = transforms[entityIdx];

    // Decode texture tier and layer from packed u32
    let packed = texLayerIndices[entityIdx];
    let tier = packed >> 16u;
    let layer = packed & 0xFFFFu;

    var out: VertexOutput;
    out.clipPosition = camera.viewProjection * model * vec4f(position, 1.0);
    out.uv = position.xy + 0.5;
    out.entityIdx = entityIdx;
    out.texTier = tier;
    out.texLayer = layer;

    return out;
}

// Abramowitz-Stegun erf() approximation
fn erf_approx(x: f32) -> f32 {
    let a1 =  0.254829592;
    let a2 = -0.284496736;
    let a3 =  1.421413741;
    let a4 = -1.453152027;
    let a5 =  1.061405429;
    let p  =  0.3275911;
    let s = sign(x);
    let ax = abs(x);
    let t = 1.0 / (1.0 + p * ax);
    let y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * exp(-ax * ax);
    return s * y;
}

fn shadowIntegral(x: f32, sigma: f32) -> f32 {
    let s = x / (sigma * 1.4142135);
    return erf_approx(s);
}

fn boxShadow2D(uv: vec2f, rectSize: vec2f, cornerRadius: f32, blur: f32) -> f32 {
    let sigma = blur * 0.5;
    if (sigma < 0.001) {
        // Sharp shadow — SDF rounded box
        let q = abs(uv) - rectSize * 0.5 + cornerRadius;
        let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - cornerRadius;
        return select(0.0, 1.0, d < 0.0);
    }
    let half = rectSize * 0.5 - cornerRadius;
    let ax = shadowIntegral(uv.x + half.x, sigma) - shadowIntegral(uv.x - half.x, sigma);
    let ay = shadowIntegral(uv.y + half.y, sigma) - shadowIntegral(uv.y - half.y, sigma);
    return ax * ay * 0.25;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let base = in.entityIdx * 8u;
    let rectW = primParams[base + 0u];
    let rectH = primParams[base + 1u];
    let cornerRadius = primParams[base + 2u];
    let blur = primParams[base + 3u];
    let colorR = primParams[base + 4u];
    let colorG = primParams[base + 5u];
    let colorB = primParams[base + 6u];
    let colorA = primParams[base + 7u];

    let localPos = (in.uv - 0.5) * vec2f(rectW + blur * 4.0, rectH + blur * 4.0);
    let alpha = boxShadow2D(localPos, vec2f(rectW, rectH), cornerRadius, blur);
    return vec4f(colorR, colorG, colorB, colorA * alpha);
}
