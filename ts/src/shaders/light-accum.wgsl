// Light accumulation (Phase 17, Task 9): every visible Light2D, added into the
// half-resolution light buffer. The buffer is cleared to the ambient light, and
// ForwardPass multiplies lit sprites by it.
//
// Point and spot lights are a quad covering their range, around the light's
// position. The transform's scale is ignored, because a light's extent IS its
// range (the same rule as its culling radius). Global and directional lights
// cover the screen. Light2D primParams: [colorR, colorG, colorB] with energy
// premultiplied, range, innerCos, outerCos, falloff, shadowIntensity.
//
// Not yet: the `sprite` light type (discarded), the `mix` blend mode (added
// like `add`), and shadows from global/directional lights.

// Scalars after the matrix only: see src/shaders/uniform-layout.test.ts.
struct LightUniform {
    viewProjection: mat4x4f,
    shadowSteps: u32,
    shadowHardness: f32,
    _pad0: f32,
    _pad1: f32,
};

@group(0) @binding(0) var<uniform> u: LightUniform;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> primParams: array<f32>;
@group(0) @binding(4) var<storage, read> renderMeta: array<u32>;
// The signed SDF: (nearest-opposite u, v, valid, inside), see sdf-jfa.wgsl.
@group(0) @binding(5) var sdf: texture_2d<f32>;

// Light fields of renderMeta[slot*2+1] (RENDER_META_LIGHT_* in components.rs).
const LIGHT_TYPE_SHIFT: u32 = 11u;
const LIGHT_BLEND_SHIFT: u32 = 14u;
const POINT: u32 = 0u;
const SPOT: u32 = 1u;
const DIRECTIONAL: u32 = 2u;
const GLOBAL: u32 = 3u;
const SPRITE: u32 = 4u;
const BLEND_SUB: u32 = 1u;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) world: vec2f,
    @location(1) screenUV: vec2f,
    @location(2) @interpolate(flat) entityIdx: u32,
};

fn lightType(e: u32) -> u32 {
    return (renderMeta[e * 2u + 1u] >> LIGHT_TYPE_SHIFT) & 7u;
}

fn toScreenUV(clip: vec4f) -> vec2f {
    let ndc = clip.xy / clip.w;
    return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

@vertex
fn vs_main(
    @location(0) position: vec3f,
    @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
    let e = visibleIndices[instanceIdx];
    var out: VertexOutput;
    out.entityIdx = e;
    let kind = lightType(e);
    if (kind == GLOBAL || kind == DIRECTIONAL) {
        out.position = vec4f(position.xy * 2.0, 0.0, 1.0);
    } else {
        let center = transforms[e][3].xy;
        let range = primParams[e * 8u + 3u];
        out.world = center + position.xy * 2.0 * range;
        out.position = u.viewProjection * vec4f(out.world, 0.0, 1.0);
    }
    out.screenUV = toScreenUV(out.position);
    return out;
}

// Signed distance, in SDF texels, at `texel`: negative inside an occluder.
// Returns a large distance when the field found no texel of the other kind
// anywhere, which means there is no occluder in view.
fn sdfDistance(texel: vec2i, size: vec2i) -> f32 {
    let q = clamp(texel, vec2i(0), size - vec2i(1));
    let s = textureLoad(sdf, q, 0);
    if (s.b < 0.5) {
        return 1e6;
    }
    let here = (vec2f(q) + 0.5) / vec2f(size);
    let d = length((s.rg - here) * vec2f(size));
    return select(d, -d, s.a > 0.5);
}

// How much of the light reaches a pixel, 0..1. A sphere march on the signed SDF
// from the pixel toward the light, in SDF texels, with Quilez's soft-shadow
// term res = min(res, k*h/t): k*h/t is the angle the nearest occluder subtends
// from the current point, which is what makes the penumbra.
//
// This is deliberately the ORIGINAL form, not the Aaltonen correction
// (y = h*h / (2*ph), d = sqrt(h*h - y*y), ...). That correction assumes an
// exact SDF, and a jump-flood field only ever over-estimates h (design §6.2,
// A1). The y term amplifies exactly that error, so the "better" formula would
// make shadows worse here (§7.3, A2).
fn shadow(fromUV: vec2f, toUV: vec2f) -> f32 {
    let size = vec2i(textureDimensions(sdf));
    let fsize = vec2f(size);
    let origin = fromUV * fsize;
    let lightPos = toUV * fsize;
    let travel = distance(origin, lightPos);
    if (travel < 1.0) {
        return 1.0;
    }
    // A pixel on or inside an occluder is lit on the side it shows: no self-shadow.
    let h0 = sdfDistance(vec2i(origin), size);
    if (h0 <= 0.0) {
        return 1.0;
    }
    let dir = (lightPos - origin) / travel;
    var res = 1.0;
    var t = max(h0, 1.0);
    for (var i = 0u; i < u.shadowSteps; i++) {
        if (t >= travel) {
            break;
        }
        let h = sdfDistance(vec2i(origin + dir * t), size);
        if (h <= 0.0) {
            return 0.0;
        }
        res = min(res, u.shadowHardness * h / t);
        t += h;
    }
    return clamp(res, 0.0, 1.0);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let e = in.entityIdx;
    let p = e * 8u;
    let kind = lightType(e);
    if (kind == SPRITE) {
        discard;
    }
    let color = vec3f(primParams[p], primParams[p + 1u], primParams[p + 2u]);

    var intensity = 1.0;
    if (kind == POINT || kind == SPOT) {
        let m = transforms[e];
        let center = m[3].xy;
        let range = primParams[p + 3u];
        let d = distance(in.world, center);
        if (d >= range) {
            discard;
        }
        intensity = pow(1.0 - d / range, max(primParams[p + 6u], 0.0));

        if (kind == SPOT) {
            // The light faces along its local +x axis.
            let axis = m[0].xy;
            let facing = select(vec2f(1.0, 0.0), normalize(axis), length(axis) > 1e-6);
            let toPixel = select(facing, (in.world - center) / d, d > 1e-4);
            let cosAngle = dot(facing, toPixel);
            let innerCos = primParams[p + 4u];
            let outerCos = primParams[p + 5u];
            // smoothstep is undefined when its edges meet: a hard cone then.
            let cone = select(step(outerCos, cosAngle), smoothstep(outerCos, innerCos, cosAngle), innerCos > outerCos + 1e-5);
            intensity *= cone;
        }

        let shadowStrength = clamp(primParams[p + 7u], 0.0, 1.0);
        if (shadowStrength > 0.0 && intensity > 0.0) {
            let lightUV = toScreenUV(u.viewProjection * vec4f(center, 0.0, 1.0));
            intensity *= mix(1.0, shadow(in.screenUV, lightUV), shadowStrength);
        }
    }

    var c = color * intensity;
    if (((renderMeta[e * 2u + 1u] >> LIGHT_BLEND_SHIFT) & 3u) == BLEND_SUB) {
        c = -c;
    }
    // Alpha 0: the buffer's alpha stays at the clear value (1).
    return vec4f(c, 0.0);
}
