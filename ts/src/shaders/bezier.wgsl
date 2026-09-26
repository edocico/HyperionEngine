// Instanced quadratic Bezier curve shader — analytical SDF (Inigo Quilez).
// PrimParams layout for BezierPath:
//   [0]=p0x, [1]=p0y, [2]=p1x, [3]=p1y, [4]=p2x, [5]=p2y, [6]=width, [7]=_pad
// All control points in UV space [0,1].

struct CameraUniform {
    viewProjection: mat4x4f,
    // The layers the occluder set being seeded shadows (OccluderSeedStage).
    // 0 in ForwardPass, which never reads it. Scalars only: see
    // src/shaders/uniform-layout.test.ts.
    occluderLayers: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> texLayerIndices: array<u32>;
@group(0) @binding(4) var<storage, read> renderMeta: array<u32>;
@group(0) @binding(5) var<storage, read> primParams: array<f32>;

// Texture bindings (needed for bind group compatibility)
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

// --- Quadratic Bezier SDF (Inigo Quilez) ---
// Returns the unsigned distance from point `pos` to the quadratic Bezier
// defined by control points a, b, c.
// Reference: https://iquilezles.org/articles/distfunctions2d/

fn dot2(v: vec2f) -> f32 {
    return dot(v, v);
}

fn sdBezier(pos: vec2f, a: vec2f, b: vec2f, c: vec2f) -> f32 {
    let A = b - a;
    let B = a - 2.0 * b + c;
    let C = A * 2.0;
    let D = a - pos;

    // Cubic coefficients: k * t^3 + ... = 0
    let kk = 1.0 / dot(B, B);
    let kx = kk * dot(A, B);
    let ky = kk * (2.0 * dot(A, A) + dot(D, B)) / 3.0;
    let kz = kk * dot(D, A);

    var res: f32 = 0.0;

    let p = ky - kx * kx;
    let q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
    let p3 = p * p * p;
    let q2 = q * q;
    var h: f32 = q2 + 4.0 * p3;

    if (h >= 0.0) {
        // One real root
        h = sqrt(h);
        let x = (vec2f(h, -h) - q) / 2.0;
        let uv2 = sign(x) * pow(abs(x), vec2f(1.0 / 3.0));
        let t = clamp(uv2.x + uv2.y - kx, 0.0, 1.0);
        let qp = D + (C + B * t) * t;
        res = dot2(qp);
    } else {
        // Three real roots — use trigonometric solution
        let z = sqrt(-p);
        let v = acos(q / (p * z * 2.0)) / 3.0;
        let m = cos(v);
        let n = sin(v) * 1.732050808; // sqrt(3)
        let t0 = clamp(vec3f(m + m, -n - m, n - m) * z - kx, vec3f(0.0), vec3f(1.0));

        // Only 2 of 3 roots need evaluation (third is provably suboptimal
        // for this parametric formulation — matches Quilez reference).
        let qx = D + (C + B * t0.x) * t0.x;
        let qy = D + (C + B * t0.y) * t0.y;
        let dx = dot2(qx);
        let dy = dot2(qy);
        res = min(dx, dy);
    }

    return sqrt(res);
}

// The curve's colour and coverage. Shared by both entry points: a bezier casts
// the shadow of exactly the stroke it draws.
fn shade(in: VertexOutput) -> vec4f {
    // Read Bezier control points and width from primParams
    let base = in.entityIdx * 8u;
    let p0 = vec2f(primParams[base + 0u], primParams[base + 1u]);
    let p1 = vec2f(primParams[base + 2u], primParams[base + 3u]);
    let p2 = vec2f(primParams[base + 4u], primParams[base + 5u]);
    let width = primParams[base + 6u];

    // Compute unsigned distance from fragment to Bezier curve
    let d = sdBezier(in.uv, p0, p1, p2);

    // Anti-aliased stroke: fwidth gives screen-space-adaptive 1px edge
    let halfWidth = width * 0.5;
    let edge = fwidth(d);
    let aa = 1.0 - smoothstep(halfWidth - edge, halfWidth + edge, d);

    if (aa < 0.01) {
        discard;
    }

    // Sample color from texture tier (with overflow support).
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

    color.a *= aa;
    return color;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    return shade(in);
}

// OccluderSeedPass entry: a seed wherever the stroke is at least half covered.
// (u, v, valid, inside) — the layout the SDF chain floods (design §9.4).
@fragment
fn fs_occluder(in: VertexOutput) -> @location(0) vec4f {
    if (shade(in).a < 0.5) {
        discard;
    }
    return vec4f(in.screenUV, 1.0, 1.0);
}
