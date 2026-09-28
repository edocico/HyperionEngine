// Prelude of every primitive module (Phase 5b). render/primitive-shaders.ts
// composes it with the libraries in this directory into the six per-type
// modules (one library each, plus generated vs_main/fs_main/fs_occluder) and
// the uber module (all six libraries, one switch on the primitive type). The
// bindings live HERE only: a library declares none, no entry point, no
// directive, and prefixes every name of its own. The names here are unprefixed.

struct CameraUniform {
    viewProjection: mat4x4f,
    // The layers the occluder set being seeded shadows (OccluderSeedStage).
    // 0 in ForwardPass, which never reads it. Scalars only: see
    // src/shaders/uniform-layout.test.ts.
    occluderLayers: u32,
    // The FULL canvas size in pixels (both writers), for pixel-wide lines.
    viewportWidth: f32,
    viewportHeight: f32,
    _pad2: u32,
};

// camera, transforms and visibleIndices are visible to the VERTEX stage only
// (primitive-bindings.ts): no fragment code may read them.
@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> texLayerIndices: array<u32>;
@group(0) @binding(4) var<storage, read> renderMeta: array<u32>;
@group(0) @binding(5) var<storage, read> primParams: array<f32>;

// Tier 0-3 texture arrays (64, 128, 256, 512 px). Group 1 is FRAGMENT only.
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

// Set to true only by the occluder pipelines (OccluderSeedStage), which run the
// per-type modules with the fs_occluder entry point. The ForwardPass pipelines
// keep the default, and the checks on it fold away. Declared here, not in the
// generated entry points: line_vs reads it too, also in the uber module.
override OCCLUDER_PASS: bool = false;
// renderMeta[slot*2+1] bit 9 (castsShadow). It must match
// RENDER_META_CASTS_SHADOW_BIT in components.rs; occluder-seed-stage.test.ts
// compares the two.
const CASTS_SHADOW_BIT: u32 = 1u << 9u;
// Whether an entity is in the occluder set being seeded: it casts, and its
// mask (renderMeta bits 16-31, 0 = every layer) meets the set's layers.
fn castsInto(meta1: u32, layers: u32) -> bool {
    let mask = select(meta1 >> 16u, 0xFFFFu, (meta1 >> 16u) == 0u);
    return (meta1 & CASTS_SHADOW_BIT) != 0u && (mask & layers) != 0u;
}
// renderMeta[slot*2+1] bit 10 (receivesLight), RENDER_META_RECEIVES_LIGHT_BIT
// in components.rs; forward-pass.test.ts compares the two.
const RECEIVES_LIGHT_BIT: u32 = 1u << 10u;

// Group 2: the light buffer (Phase 17), accumulated by LightGroupsPass at half
// resolution and cleared to the ambient light. Only fs_main may reach it
// (through applyLighting): OccluderSeedStage runs the per-type modules through
// fs_occluder on a layout of two groups, where a binding used by that entry
// point would fail validation. Declaring it in every module is valid; reaching
// it is what counts. Scalars only: see src/shaders/uniform-layout.test.ts.
struct LightingUniform {
    enabled: u32,
    // Light layers: receiver layer → light-buffer layer (its light group),
    // 4 bits per layer. Layers 0-7 here, 8-15 in the next word.
    groupTableLo: u32,
    groupTableHi: u32,
    _pad0: u32,
};

// One layer per light group (LightGroupsPass).
@group(2) @binding(0) var lightBuffer: texture_2d_array<f32>;
@group(2) @binding(1) var lightSampler: sampler;
@group(2) @binding(2) var<uniform> lighting: LightingUniform;

// A receiver belongs to ONE layer, the lowest bit of its mask (renderMeta bits
// 16-31; 0 = layer 0), and samples the light-buffer layer of that layer's group.
fn lightGroupOf(mask: u32) -> u32 {
    let layer = select(firstTrailingBit(mask), 0u, mask == 0u);
    let word = select(lighting.groupTableLo, lighting.groupTableHi, layer >= 8u);
    return (word >> (4u * (layer % 8u))) & 0xFu;
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) entityIdx: u32,
    @location(2) @interpolate(flat) texTier: u32,
    @location(3) @interpolate(flat) texLayer: u32,
    @location(4) @interpolate(flat) isOverflow: u32,
    // This fragment's position on screen in [0,1], y down: the seed that
    // fs_occluder writes, and where applyLighting reads the light buffer.
    @location(5) screenUV: vec2f,
    // Lines only (line_vs; 0 elsewhere). Maps the quad's uv.y onto the stroke:
    // the quad is wider than the stroke by an AA margin, and edge = 1 falls at
    // the stroke's true edge. Perspective-interpolated, NOT flat: line's
    // half-open edge test compares its interpolated bits.
    @location(6) edgeScale: f32,
    // Lines only: renderMeta bit 8, the entity draws in the alpha-blended pipeline.
    @location(7) @interpolate(flat) transparent: u32,
    // The primitive type, set by the generated vs_main: the uber fs_main
    // switches on it.
    @location(8) @interpolate(flat) primType: u32,
};

// A vertex that rasterises nothing: every vertex of the triangle lands on the
// same point. Every other field is zero.
fn culledVertex() -> VertexOutput {
    var out: VertexOutput;
    out.clipPosition = vec4f(0.0, 0.0, 0.0, 1.0);
    return out;
}

// The common tail of a vertex function: the clip position and uv it computed,
// plus the packed texture decode, the screen position and the flat fields.
fn finishVertex(clip: vec4f, uv: vec2f, entityIdx: u32) -> VertexOutput {
    var out: VertexOutput;

    // Decode texture tier and layer from packed u32
    let packed = texLayerIndices[entityIdx];
    let isOverflow = (packed >> 31u) & 1u;
    let tier = (packed >> 16u) & 0x7u;
    let layer = packed & 0xFFFFu;

    out.clipPosition = clip;
    let ndc = out.clipPosition.xy / out.clipPosition.w;
    out.screenUV = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    out.uv = uv;
    out.entityIdx = entityIdx;
    out.texTier = tier;
    out.texLayer = layer;
    out.isOverflow = isOverflow;

    return out;
}

// A vertex of the entity's unit quad, through its model matrix.
fn unitQuadVertex(position: vec3f, entityIdx: u32, uv: vec2f) -> VertexOutput {
    let model = transforms[entityIdx];
    return finishVertex(camera.viewProjection * model * vec4f(position, 1.0), uv, entityIdx);
}

// The texel at in.uv from the entity's tier (with overflow support), RAW: a
// packed index 0 samples tier 0 layer 0 like any other. textureSampleLevel
// with explicit LOD 0 avoids the uniform-control-flow requirement of
// textureSample (texTier/isOverflow vary per-instance).
fn sampleTier(in: VertexOutput) -> vec4f {
    var texColor: vec4f;
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

// The entity's colour: white for packed index 0 (tier 0, layer 0, not
// overflow), which means "untextured": layer 0 is reserved and never holds a
// real texture. Answered here instead of sampling: on a compressed tier
// (BC7/ASTC) layer 0 is never filled (writeTexture cannot take raw pixels
// there), and an all-zero BC7 block decodes to transparent black. The varyings
// are flat, so the branch is uniform across the quad. msdf_shade must NOT use
// this: a glyph's coverage is its texel, and white would draw a solid box.
fn sampleTierOrWhite(in: VertexOutput) -> vec4f {
    if (in.isOverflow == 0u && in.texTier == 0u && in.texLayer == 0u) {
        return vec4f(1.0);
    }
    return sampleTier(in);
}

// The occluder seed of a fragment at least half covered: (u, v, valid,
// inside), the layout the SDF chain floods (design §9.4). Nothing below.
fn occluderSeed(in: VertexOutput, alpha: f32) -> vec4f {
    if (alpha < 0.5) {
        discard;
    }
    return vec4f(in.screenUV, 1.0, 1.0);
}

// The light buffer applied to a receiver's colour. Only the lit libraries'
// <prefix>_fs call it (quad_fs, gradient_fs: LIT_PRIMITIVE_TYPES), never a
// shade or occluder function, and never the uber after its switch: every other
// type would then be lit, which deriveLightGroups does not model.
fn applyLighting(in: VertexOutput, color: vec4f) -> vec4f {
    let meta1 = renderMeta[in.entityIdx * 2u + 1u];
    // entityIdx is flat, so the branch is uniform across the quad. Unlit
    // entities skip the lookup, and keep their full colour.
    if (lighting.enabled == 1u && (meta1 & RECEIVES_LIGHT_BIT) != 0u) {
        // A subtractive light can push the buffer below zero: clamp before tinting.
        let light = max(textureSampleLevel(lightBuffer, lightSampler, in.screenUV, lightGroupOf(meta1 >> 16u), 0.0).rgb, vec3f(0.0));
        return vec4f(color.rgb * light, color.a);
    }
    return color;
}
