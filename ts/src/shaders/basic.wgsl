// Instanced quad shader with GPU-driven visibility indirection
// and multi-tier Texture2DArray sampling.

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

// Set to true only by the OccluderSeedPass pipelines, which run this module
// with the fs_occluder entry point. The ForwardPass pipelines keep the default,
// and the check below folds away.
override OCCLUDER_PASS: bool = false;
// renderMeta[slot*2+1] bit 9 (castsShadow). It must match
// RENDER_META_CASTS_SHADOW_BIT in components.rs; occluder-seed-pass.test.ts
// compares the two.
const CASTS_SHADOW_BIT: u32 = 1u << 9u;
// renderMeta[slot*2+1] bit 10 (receivesLight), RENDER_META_RECEIVES_LIGHT_BIT
// in components.rs; forward-pass.test.ts compares the two.
const RECEIVES_LIGHT_BIT: u32 = 1u << 10u;

// Group 2: the light buffer (Phase 17), accumulated by LightAccumPass at half
// resolution and cleared to the ambient light. Only fs_main reads it:
// OccluderSeedPass runs this module through fs_occluder on a layout of two
// groups, where a binding used by that entry point would fail validation.
// Scalars only: see src/shaders/uniform-layout.test.ts.
struct LightingUniform {
    enabled: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(2) @binding(0) var lightBuffer: texture_2d<f32>;
@group(2) @binding(1) var lightSampler: sampler;
@group(2) @binding(2) var<uniform> lighting: LightingUniform;

struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) entityIdx: u32,
    @location(2) @interpolate(flat) texTier: u32,
    @location(3) @interpolate(flat) texLayer: u32,
    @location(4) @interpolate(flat) isOverflow: u32,
    // This fragment's position on screen in [0,1], y down: the seed that
    // fs_occluder writes, and where fs_main reads the light buffer.
    @location(5) screenUV: vec2f,
};

@vertex
fn vs_main(
    @location(0) position: vec3f,
    @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
    let entityIdx = visibleIndices[instanceIdx];
    var out: VertexOutput;

    // In the occluder pass an entity that casts no shadow emits a degenerate
    // triangle, so nothing of it is rasterised.
    if (OCCLUDER_PASS && (renderMeta[entityIdx * 2u + 1u] & CASTS_SHADOW_BIT) == 0u) {
        out.clipPosition = vec4f(0.0, 0.0, 0.0, 1.0);
        return out;
    }

    let model = transforms[entityIdx];

    // Decode texture tier and layer from packed u32
    let packed = texLayerIndices[entityIdx];
    let isOverflow = (packed >> 31u) & 1u;
    let tier = (packed >> 16u) & 0x7u;
    let layer = packed & 0xFFFFu;

    out.clipPosition = camera.viewProjection * model * vec4f(position, 1.0);
    let ndc = out.clipPosition.xy / out.clipPosition.w;
    out.screenUV = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    out.uv = position.xy + 0.5;
    out.entityIdx = entityIdx;
    out.texTier = tier;
    out.texLayer = layer;
    out.isOverflow = isOverflow;

    return out;
}

// The quad's colour and coverage. Shared by both entry points: a sprite casts
// the shadow of exactly the texels it draws.
fn shade(in: VertexOutput) -> vec4f {
    // Packed index 0 (tier 0, layer 0, not overflow) means "untextured": layer
    // 0 is reserved and never holds a real texture. Answer it here instead of
    // sampling. On a compressed tier (BC7/ASTC) layer 0 is never filled
    // (writeTexture cannot take raw pixels there), and an all-zero BC7 block
    // decodes to transparent black. The varyings are flat, so the branch is
    // uniform across the quad.
    if (in.isOverflow == 0u && in.texTier == 0u && in.texLayer == 0u) {
        return vec4f(1.0);
    }

    var texColor: vec4f;

    // Sample from the correct tier's Texture2DArray (with overflow support).
    // textureSampleLevel with explicit LOD 0 avoids the uniform-control-flow
    // requirement of textureSample (texTier/isOverflow vary per-instance).
    if (in.isOverflow == 0u) {
        switch in.texTier {
            case 1u: { texColor = textureSampleLevel(tier1Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 2u: { texColor = textureSampleLevel(tier2Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 3u: { texColor = textureSampleLevel(tier3Tex, texSampler, in.uv, in.texLayer, 0.0); }
            default: { texColor = textureSampleLevel(tier0Tex, texSampler, in.uv, in.texLayer, 0.0); }
        }
    } else {
        switch in.texTier {
            case 1u: { texColor = textureSampleLevel(ovf1Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 2u: { texColor = textureSampleLevel(ovf2Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 3u: { texColor = textureSampleLevel(ovf3Tex, texSampler, in.uv, in.texLayer, 0.0); }
            default: { texColor = textureSampleLevel(ovf0Tex, texSampler, in.uv, in.texLayer, 0.0); }
        }
    }

    return texColor;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let color = shade(in);
    // entityIdx is flat, so the branch is uniform across the quad. Unlit
    // entities skip the lookup, and keep their full colour.
    if (lighting.enabled == 1u && (renderMeta[in.entityIdx * 2u + 1u] & RECEIVES_LIGHT_BIT) != 0u) {
        // A subtractive light can push the buffer below zero: clamp before tinting.
        let light = max(textureSampleLevel(lightBuffer, lightSampler, in.screenUV, 0.0).rgb, vec3f(0.0));
        return vec4f(color.rgb * light, color.a);
    }
    return color;
}

// OccluderSeedPass entry: a seed wherever the quad is at least half covered.
// (u, v, valid, inside) — the layout the SDF chain floods (design §9.4).
@fragment
fn fs_occluder(in: VertexOutput) -> @location(0) vec4f {
    if (shade(in).a < 0.5) {
        discard;
    }
    return vec4f(in.screenUV, 1.0, 1.0);
}
