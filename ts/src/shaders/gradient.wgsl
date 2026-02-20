// Gradient shader — linear, radial, and conic gradients via primParams.
// PrimParams layout for Gradient:
//   [0]=type (0=linear, 1=radial, 2=conic)
//   [1]=angle (degrees)
//   [2]=stop0_pos, [3]=stop0_r, [4]=stop0_g, [5]=stop0_b
//   [6]=stop1_pos, [7]=stop1_r
// stop1 G,B are packed into texLayerIndices (low bytes)

struct CameraUniform {
    viewProjection: mat4x4f,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> texLayerIndices: array<u32>;
@group(0) @binding(4) var<storage, read> renderMeta: array<u32>;
@group(0) @binding(5) var<storage, read> primParams: array<f32>;

// Texture bindings (needed for bind group compatibility, unused by gradients)
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

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let base = in.entityIdx * 8u;
    let gradType = u32(primParams[base + 0u]);
    let angle = primParams[base + 1u];
    let stop0Pos = primParams[base + 2u];
    let stop0 = vec3f(primParams[base + 3u], primParams[base + 4u], primParams[base + 5u]);
    let stop1Pos = primParams[base + 6u];
    let stop1R = primParams[base + 7u];
    let packed = texLayerIndices[in.entityIdx];
    let stop1G = f32((packed >> 8u) & 0xFFu) / 255.0;
    let stop1B = f32(packed & 0xFFu) / 255.0;
    let stop1 = vec3f(stop1R, stop1G, stop1B);

    var t: f32;
    if (gradType == 0u) {
        // Linear gradient
        let rad = angle * 3.14159265 / 180.0;
        let dir = vec2f(cos(rad), sin(rad));
        t = dot(in.uv - 0.5, dir) + 0.5;
    } else if (gradType == 1u) {
        // Radial gradient
        t = length(in.uv - 0.5) * 2.0;
    } else {
        // Conic gradient
        let rad = angle * 3.14159265 / 180.0;
        let centered = in.uv - 0.5;
        t = (atan2(centered.y, centered.x) + 3.14159265 - rad) / (2.0 * 3.14159265);
        t = fract(t);
    }

    let s = clamp((t - stop0Pos) / max(stop1Pos - stop0Pos, 0.001), 0.0, 1.0);
    let color = mix(stop0, stop1, s);
    return vec4f(color, 1.0);
}
