// Instanced line shader — a quad expanded across the segment from line parameters.
// PrimParams layout for Line:
//   [0]=startX, [1]=startY, [2]=endX, [3]=endY, [4]=width, [5]=dashLen, [6]=gapLen,
//   [7]=width unit: 0 = local units (scaled by the entity and the zoom), 1 = screen pixels

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

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> texLayerIndices: array<u32>;
@group(0) @binding(4) var<storage, read> renderMeta: array<u32>;
@group(0) @binding(5) var<storage, read> primParams: array<f32>;

// Texture bindings (needed for bind group compatibility, unused by lines)
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

// Set to true only by the occluder pipelines (OccluderSeedStage), which run this module
// with the fs_occluder entry point. The ForwardPass pipelines keep the default,
// and the check below folds away.
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

struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) entityIdx: u32,
    @location(2) @interpolate(flat) texTier: u32,
    @location(3) @interpolate(flat) texLayer: u32,
    @location(4) @interpolate(flat) isOverflow: u32,
    // This fragment's position on screen in [0,1], y down: the seed that
    // fs_occluder writes. Unused by fs_main.
    @location(5) screenUV: vec2f,
    // Maps the quad's uv.y onto the stroke: the quad is wider than the stroke
    // by an AA margin, and edge = 1 falls at the stroke's true edge.
    @location(6) edgeScale: f32,
    // renderMeta bit 8: the entity draws in the alpha-blended pipeline.
    @location(7) @interpolate(flat) transparent: u32,
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
    if (OCCLUDER_PASS && !castsInto(renderMeta[entityIdx * 2u + 1u], camera.occluderLayers)) {
        out.clipPosition = vec4f(0.0, 0.0, 0.0, 1.0);
        return out;
    }

    let model = transforms[entityIdx];

    // Read line params
    let base = entityIdx * 8u;
    let startX = primParams[base + 0u];
    let startY = primParams[base + 1u];
    let endX   = primParams[base + 2u];
    let endY   = primParams[base + 3u];
    let width  = primParams[base + 4u];

    // Line direction and perpendicular
    let dir = vec2f(endX - startX, endY - startY);
    let len = length(dir);
    let d = select(vec2f(1.0, 0.0), dir / len, len > 0.001);
    let perp = vec2f(-d.y, d.x);

    // Unit quad position.xy maps [-0.5, 0.5] to line segment:
    //   x: along line (0 = start, 1 = end)
    //   y: across line (-0.5 = left, 0.5 = right)
    let along = position.x + 0.5;   // [0, 1]
    let across = position.y;         // [-0.5, 0.5]

    // Pixel width: offset across the segment as it lies ON SCREEN, by
    // width/2 pixels turned into NDC. A missing viewport falls back to local units.
    let viewport = vec2f(camera.viewportWidth, camera.viewportHeight);
    let hasViewport = viewport.x > 0.0 && viewport.y > 0.0;
    let pixelWidth = primParams[base + 7u] > 0.5 && hasViewport;

    // Pixels per local unit across the stroke (orthographic camera: w = 1).
    let acrossClip = camera.viewProjection * model * vec4f(perp, 0.0, 0.0);
    let pxPerUnit = length(acrossClip.xy * viewport * 0.5);
    let unitsPerPx = select(0.0, 1.0 / pxPerUnit, hasViewport && pxPerUnit > 1e-6);

    // strokeWidth: what is drawn. The occluder seed renders at half
    // resolution, so there a stroke is at least one of its texels (2 px) wide,
    // or it could fall between texel centres and cast nothing.
    // quadWidth: the stroke plus an AA margin of one pixel (half each side),
    // so the OUTER half of the edge ramp is rasterised too; without it a pixel
    // centred on the edge followed the rasteriser's tie rule.
    var strokeWidth = width;
    var quadWidth = width;
    if (pixelWidth) {
        strokeWidth = select(width, max(width, 2.0), OCCLUDER_PASS);
        quadWidth = strokeWidth + 1.0;
    } else {
        strokeWidth = select(width, max(width, 2.0 * unitsPerPx), OCCLUDER_PASS);
        quadWidth = strokeWidth + unitsPerPx;
    }
    out.edgeScale = select(1.0, quadWidth / strokeWidth, strokeWidth > 0.0);
    out.transparent = select(0u, 1u, (renderMeta[entityIdx * 2u + 1u] & 0x100u) != 0u);

    let worldPos = vec2f(startX, startY)
        + d * along * len
        + perp * across * quadWidth;

    // Decode texture tier and layer from packed u32
    let packed = texLayerIndices[entityIdx];
    let isOverflow = (packed >> 31u) & 1u;
    let tier = (packed >> 16u) & 0x7u;
    let layer = packed & 0xFFFFu;

    if (pixelWidth) {
        let c0 = camera.viewProjection * model * vec4f(startX, startY, 0.0, 1.0);
        let c1 = camera.viewProjection * model * vec4f(endX, endY, 0.0, 1.0);
        let s = (c1.xy / c1.w - c0.xy / c0.w) * viewport;  // on-screen direction, pixels
        let sl = length(s);
        let sd = select(vec2f(1.0, 0.0), s / sl, sl > 0.001);
        let clip = mix(c0, c1, along);
        let offsetNdc = vec2f(-sd.y, sd.x) * across * quadWidth * 2.0 / viewport;
        out.clipPosition = vec4f(clip.xy + offsetNdc * clip.w, clip.zw);
    } else {
        out.clipPosition = camera.viewProjection * model * vec4f(worldPos, 0.0, 1.0);
    }
    let ndc = out.clipPosition.xy / out.clipPosition.w;
    out.screenUV = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    out.uv = vec2f(along, across + 0.5);
    out.entityIdx = entityIdx;
    out.texTier = tier;
    out.texLayer = layer;
    out.isOverflow = isOverflow;

    return out;
}

// Shift of the stroke's half-open interval (edge units): see insideStroke.
const STROKE_TIE_EPS: f32 = 1e-3;

// Whether this fragment is inside the stroke, as a rasteriser decides a tie:
// the interval is half-open, [-1, 1), so a pixel centre exactly on an edge
// belongs to one side only, and an opaque W-px stroke covers exactly W pixel
// rows at any sub-pixel alignment (an alpha >= 0.5 test counted a tie on both
// sides). Both ends are shifted by the same tiny amount, so interpolation
// rounding at an exact tie cannot drop both edge pixels.
fn insideStroke(in: VertexOutput) -> bool {
    let d = (in.uv.y - 0.5) * 2.0 * in.edgeScale;
    return d >= -1.0 - STROKE_TIE_EPS && d < 1.0 - STROKE_TIE_EPS;
}

// The line's colour and coverage. Shared by both entry points: a line casts
// the shadow of exactly what it draws, dash gaps and anti-aliased edges included.
fn shade(in: VertexOutput) -> vec4f {
    // Edge anti-aliasing: distance from the centre line, 0 there and 1 at the
    // edge, faded over one screen pixel whatever the width unit. The rate is
    // taken on the LINEAR uv.y (edge changes twice as fast): fwidth of the
    // abs() would collapse at the centre's kink inside a 2x2 quad and make a
    // thin line's opacity follow pixel parity. Derivatives need uniform
    // control flow: first, before any branch.
    let edge = abs(in.uv.y - 0.5) * 2.0 * in.edgeScale;
    let edgeAA = max(2.0 * in.edgeScale * fwidth(in.uv.y), 1e-4);

    // Read line params for potential dash pattern
    let base = in.entityIdx * 8u;
    let dashLen = primParams[base + 5u];
    let gapLen = primParams[base + 6u];

    // Read color from texture (with overflow support).
    // textureSampleLevel avoids uniform-control-flow requirement.
    // Packed index 0 (tier 0, layer 0, not overflow) means "untextured": white.
    // Layer 0 of a compressed tier (BC7/ASTC) is never filled and decodes to
    // transparent black; see basic.wgsl. Only the colour is replaced here — the
    // stroke's coverage below still applies.
    let untextured = in.isOverflow == 0u && in.texTier == 0u && in.texLayer == 0u;
    var color = vec4f(1.0);
    if (untextured) {
        // keep white
    } else if (in.isOverflow == 0u) {
        switch in.texTier {
            case 1u: { color = textureSampleLevel(tier1Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 2u: { color = textureSampleLevel(tier2Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 3u: { color = textureSampleLevel(tier3Tex, texSampler, in.uv, in.texLayer, 0.0); }
            default: { color = textureSampleLevel(tier0Tex, texSampler, in.uv, in.texLayer, 0.0); }
        }
    } else {
        switch in.texTier {
            case 1u: { color = textureSampleLevel(ovf1Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 2u: { color = textureSampleLevel(ovf2Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 3u: { color = textureSampleLevel(ovf3Tex, texSampler, in.uv, in.texLayer, 0.0); }
            default: { color = textureSampleLevel(ovf0Tex, texSampler, in.uv, in.texLayer, 0.0); }
        }
    }

    // SDF dash pattern (if dashLen > 0)
    if (dashLen > 0.0) {
        let totalLen = dashLen + gapLen;
        let along = in.uv.x;
        let lineLen = length(vec2f(
            primParams[base + 2u] - primParams[base + 0u],
            primParams[base + 3u] - primParams[base + 1u]
        ));
        let pos = along * lineLen;
        let phase = pos % totalLen;
        if (phase > dashLen) {
            discard;
        }
    }

    // Centred on the edge: alpha is 0.5 exactly there, so the stroke keeps its
    // full width and every fragment of the quad has alpha >= 0.5 (the occluder
    // seed then covers the whole stroke).
    color.a *= 1.0 - smoothstep(1.0 - edgeAA * 0.5, 1.0 + edgeAA * 0.5, edge);

    return color;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let color = shade(in);
    // The opaque pipeline has no blending, so an AA-margin fragment would be
    // drawn solid and the line one pixel wider: keep exactly the stroke. The
    // transparent pipeline blends the ramp instead.
    if (in.transparent == 0u && !insideStroke(in)) {
        discard;
    }
    return color;
}

// OccluderSeedStage entry: a seed exactly where the opaque stroke is drawn
// (insideStroke; shade() discards dash gaps).
// (u, v, valid, inside) — the layout the SDF chain floods (design §9.4).
@fragment
fn fs_occluder(in: VertexOutput) -> @location(0) vec4f {
    // A texel with no alpha (a textured line) casts nothing either.
    let color = shade(in);
    if (color.a <= 0.0 || !insideStroke(in)) {
        discard;
    }
    return vec4f(in.screenUV, 1.0, 1.0);
}
