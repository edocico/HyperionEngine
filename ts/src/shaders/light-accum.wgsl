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
    // A light's source radius as a fraction of its range (LIGHT_SOURCE_FRACTION).
    sourceFraction: f32,
    // The light group being accumulated (design 2026-09-26): a light draws only
    // if its mask (renderMeta bits 16-31) meets these layers.
    groupLayers: u32,
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
    // Not in this group's layers: a degenerate triangle, nothing rasterised.
    // A light with mask 0 lights nothing.
    if (((renderMeta[e * 2u + 1u] >> 16u) & u.groupLayers) == 0u) {
        out.position = vec4f(0.0, 0.0, 0.0, 1.0);
        return out;
    }
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
// term: h/t is the angle the nearest occluder subtends from the current point,
// compared with the light's own angular radius. That comparison is what makes
// the penumbra.
//
// The light's angular radius is min(1/k, sourceRadius / travel). Quilez's k
// alone is the first term, a CONSTANT angle, i.e. a light whose radius grows
// with the pixel's distance (travel/k). Right for a sun, wrong for a torch: a
// light beside a wall then darkened pixels on the far side of it, because the
// last steps of their march pass within h of the wall. Measured 2026-09-26:
// free rays 23-42% darker, in radial bands. The second term is the light's
// real size, so a far pixel sees a small light.
//
// This is deliberately the ORIGINAL form, not the Aaltonen correction
// (y = h*h / (2*ph), d = sqrt(h*h - y*y), ...). That correction assumes an
// exact SDF, and a jump-flood field only ever over-estimates h (design §6.2,
// A1). The y term amplifies exactly that error, so the "better" formula would
// make shadows worse here (§7.3, A2).
fn shadow(fromUV: vec2f, toUV: vec2f, sourceRadius: f32) -> f32 {
    let size = vec2i(textureDimensions(sdf));
    let fsize = vec2f(size);
    let origin = fromUV * fsize;
    let lightPos = toUV * fsize;
    let travel = distance(origin, lightPos);
    if (travel < 1.0) {
        return 1.0;
    }
    let dir = (lightPos - origin) / travel;
    let angle = min(1.0 / u.shadowHardness, sourceRadius / travel);
    var t = 0.0;
    var h = sdfDistance(vec2i(origin), size);
    var i = 0u;
    // A pixel inside an occluder (a sprite that both casts and receives) is not
    // shadowed by the occluder it belongs to, but must be by every other one:
    // leave it first, then march. Inside, |h| is the distance to the nearest
    // free texel, a lower bound on the way out in any direction, so a step of
    // |h| never overshoots the exit. Returning "lit" here instead left every
    // such sprite fully lit inside a wall's shadow.
    while (h <= 0.0 && i < u.shadowSteps) {
        t += max(-h, 1.0);
        if (t >= travel) {
            return 1.0;  // the light is inside the same occluder
        }
        h = sdfDistance(vec2i(origin + dir * t), size);
        i++;
    }
    if (h <= 0.0) {
        return 1.0;  // never got out: no other occluder was tested
    }
    // Penumbra distances run from where the ray leaves its own occluder (the
    // pixel itself, for a pixel in free space). Measured from the pixel, a
    // sprite would go dark along its own outline, where h is ~0.
    let start = t;
    var res = 1.0;
    t += max(h, 1.0);
    for (; i < u.shadowSteps; i++) {
        if (t >= travel) {
            break;
        }
        h = sdfDistance(vec2i(origin + dir * t), size);
        if (h <= 0.0) {
            return 0.0;
        }
        res = min(res, h / ((t - start) * angle));
        t += h;
    }
    // Out of steps before reaching the light: the rest of the ray is unproven.
    // A ray hugging a long wall spends its steps 1-2 texels at a time, and the
    // running `res` alone lit pixels squarely behind the wall. Returning 0
    // would darken long rays through open space instead. Assume the clearance
    // stays the last one seen, all the way to the light.
    if (t < travel) {
        res = min(res, h / ((travel - start) * angle));
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
            // The source radius in SDF texels: a fraction of the range, so it
            // follows the light's size and the zoom like the rest of the world.
            let size = vec2f(textureDimensions(sdf));
            let edgeUV = toScreenUV(u.viewProjection * vec4f(center + vec2f(range, 0.0), 0.0, 1.0));
            let sourceRadius = max(1.0, distance(lightUV * size, edgeUV * size) * u.sourceFraction);
            intensity *= mix(1.0, shadow(in.screenUV, lightUV, sourceRadius), shadowStrength);
        }
    }

    var c = color * intensity;
    if (((renderMeta[e * 2u + 1u] >> LIGHT_BLEND_SHIFT) & 3u) == BLEND_SUB) {
        c = -c;
    }
    // Alpha 0: the buffer's alpha stays at the clear value (1).
    return vec4f(c, 0.0);
}
