// MSDF text rendering shader — median(r,g,b) SDF with screen-pixel-range AA.
// PrimParams layout for SDFGlyph (type 2):
//   [0]=atlasU0, [1]=atlasV0, [2]=atlasU1, [3]=atlasV1  — atlas UV rect
//   [4]=screenPxRange  — SDF range in screen pixels
//   [5]=colorR, [6]=colorG, [7]=colorB  — text color

struct CameraUniform {
    viewProjection: mat4x4f,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> texLayerIndices: array<u32>;
@group(0) @binding(4) var<storage, read> renderMeta: array<u32>;
@group(0) @binding(5) var<storage, read> primParams: array<f32>;

// Tier 0-3 texture arrays (64, 128, 256, 512 px)
@group(1) @binding(0) var tier0Tex: texture_2d_array<f32>;
@group(1) @binding(1) var tier1Tex: texture_2d_array<f32>;
@group(1) @binding(2) var tier2Tex: texture_2d_array<f32>;
@group(1) @binding(3) var tier3Tex: texture_2d_array<f32>;
@group(1) @binding(4) var texSampler: sampler;
// Overflow tiers (rgba8unorm, for mixed-mode dev)
@group(1) @binding(5) var ovf0Tex: texture_2d_array<f32>;
@group(1) @binding(6) var ovf1Tex: texture_2d_array<f32>;
@group(1) @binding(7) var ovf2Tex: texture_2d_array<f32>;
@group(1) @binding(8) var ovf3Tex: texture_2d_array<f32>;

struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) entityIdx: u32,
    @location(2) @interpolate(flat) texTier: u32,
    @location(3) @interpolate(flat) texLayer: u32,
    @location(4) @interpolate(flat) isOverflow: u32,
};

fn median3(r: f32, g: f32, b: f32) -> f32 {
    return max(min(r, g), min(max(r, g), b));
}

@vertex
fn vs_main(
    @location(0) position: vec3f,
    @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
    let entityIdx = visibleIndices[instanceIdx];
    let model = transforms[entityIdx];

    // Read atlas UV rect from primParams
    let base = entityIdx * 8u;
    let atlasU0 = primParams[base + 0u];
    let atlasV0 = primParams[base + 1u];
    let atlasU1 = primParams[base + 2u];
    let atlasV1 = primParams[base + 3u];

    // Map unit quad UVs to atlas UV rect
    let localUV = position.xy + 0.5;

    // Decode texture tier and layer from packed u32
    let packed = texLayerIndices[entityIdx];
    let isOverflow = (packed >> 31u) & 1u;
    let tier = (packed >> 16u) & 0x7u;
    let layer = packed & 0xFFFFu;

    var out: VertexOutput;
    out.clipPosition = camera.viewProjection * model * vec4f(position, 1.0);
    out.uv = vec2f(
        mix(atlasU0, atlasU1, localUV.x),
        mix(atlasV0, atlasV1, localUV.y),
    );
    out.entityIdx = entityIdx;
    out.texTier = tier;
    out.texLayer = layer;
    out.isOverflow = isOverflow;

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let base = in.entityIdx * 8u;
    let screenPxRange = primParams[base + 4u];
    let colorR = primParams[base + 5u];
    let colorG = primParams[base + 6u];
    let colorB = primParams[base + 7u];

    // Sample MSDF texture from the correct tier (with overflow support).
    // textureSampleLevel avoids uniform-control-flow requirement.
    var msdf: vec4f;
    if (in.isOverflow == 0u) {
        switch in.texTier {
            case 1u: { msdf = textureSampleLevel(tier1Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 2u: { msdf = textureSampleLevel(tier2Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 3u: { msdf = textureSampleLevel(tier3Tex, texSampler, in.uv, in.texLayer, 0.0); }
            default: { msdf = textureSampleLevel(tier0Tex, texSampler, in.uv, in.texLayer, 0.0); }
        }
    } else {
        switch in.texTier {
            case 1u: { msdf = textureSampleLevel(ovf1Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 2u: { msdf = textureSampleLevel(ovf2Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 3u: { msdf = textureSampleLevel(ovf3Tex, texSampler, in.uv, in.texLayer, 0.0); }
            default: { msdf = textureSampleLevel(ovf0Tex, texSampler, in.uv, in.texLayer, 0.0); }
        }
    }

    let sd = median3(msdf.r, msdf.g, msdf.b);

    // Compute screen-space texel size for anti-aliasing
    let screenTexSize = vec2f(
        length(vec2f(dpdx(in.uv.x), dpdy(in.uv.x))),
        length(vec2f(dpdx(in.uv.y), dpdy(in.uv.y)))
    );
    let avgScreenTexSize = 0.5 * (screenTexSize.x + screenTexSize.y);
    let screenPxDistance = screenPxRange * (sd - 0.5);
    let opacity = clamp(screenPxDistance / avgScreenTexSize + 0.5, 0.0, 1.0);

    if (opacity < 0.01) {
        discard;
    }

    return vec4f(colorR, colorG, colorB, opacity);
}
