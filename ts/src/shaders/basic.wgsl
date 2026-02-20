// Instanced quad shader with GPU-driven visibility indirection
// and multi-tier Texture2DArray sampling.

struct CameraUniform {
    viewProjection: mat4x4f,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> texLayerIndices: array<u32>;

// Tier 0-3 texture arrays (64, 128, 256, 512 px)
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
    var texColor: vec4f;

    // Sample from the correct tier's Texture2DArray
    switch in.texTier {
        case 1u: {
            texColor = textureSample(tier1Tex, texSampler, in.uv, in.texLayer);
        }
        case 2u: {
            texColor = textureSample(tier2Tex, texSampler, in.uv, in.texLayer);
        }
        case 3u: {
            texColor = textureSample(tier3Tex, texSampler, in.uv, in.texLayer);
        }
        default: {
            texColor = textureSample(tier0Tex, texSampler, in.uv, in.texLayer);
        }
    }

    return texColor;
}
