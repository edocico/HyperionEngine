// Light accumulation (Phase 17, Task 9; directional shadows: round 2026-09-27,
// step 6): every visible Light2D, added into the half-resolution light buffer.
// The buffer is cleared to the ambient light, and ForwardPass multiplies lit
// sprites by it.
//
// Point and spot lights are a quad covering their range, around the light's
// position. The transform's scale is ignored, because a light's extent IS its
// range (the same rule as its culling radius). Global and directional lights
// cover the screen. Light2D primParams: [colorR, colorG, colorB] with energy
// premultiplied, range, innerCos, outerCos, falloff, shadowIntensity.
//
// Spot and directional lights shine toward their local +x axis (lightFacing).
// A directional light (a sun) has no position: each caster's shadow runs
// along that axis, away from the light, for `range` world units and fades out
// over the last quarter, at a fixed apparent angle, u.sourceFraction. Its
// march gets 4x the step budget of a point or spot light (sunShadow). Global
// lights never cast shadows in the lit backend: their shadowIntensity is
// ignored.
//
// Not yet: the `sprite` light type (discarded) and the `mix` blend mode (added
// like `add`).

// Scalars after the matrix only: see src/shaders/uniform-layout.test.ts.
struct LightUniform {
    viewProjection: mat4x4f,
    shadowSteps: u32,
    shadowHardness: f32,
    // A light's source radius as a fraction of its range (LIGHT_SOURCE_FRACTION),
    // and a directional light's penumbra angle in radians (sunShadow): the
    // penumbra's width per unit of distance, about the source's angular diameter.
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
// Visible to the vertex stage too: directionalRay reads its size.
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

// A sun's shadow keeps full strength for this fraction of its length, then
// fades out (sunFade).
const SUN_FADE_START: f32 = 0.75;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) world: vec2f,
    @location(1) screenUV: vec2f,
    @location(2) @interpolate(flat) entityIdx: u32,
    // A directional light's shadow ray (directionalRay), once per light.
    @location(3) @interpolate(flat) sunRay: vec3f,
};

fn lightType(e: u32) -> u32 {
    return (renderMeta[e * 2u + 1u] >> LIGHT_TYPE_SHIFT) & 7u;
}

fn toScreenUV(clip: vec4f) -> vec2f {
    let ndc = clip.xy / clip.w;
    return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

// The way a light's light travels: its local +x axis, column 0 of the world
// matrix (sx * (cos, sin)). A spot's cone axis and a directional light's
// direction: one rule for both. The scale enters only through its sign (a
// negative x-scale mirrors the light); a zero x-scale falls back to world +x.
fn lightFacing(m: mat4x4f) -> vec2f {
    let axis = m[0].xy;
    return select(vec2f(1.0, 0.0), normalize(axis), length(axis) > 1e-6);
}

// A directional light's shadow ray, computed once per light in vs_main: the
// unit direction TOWARD the light in texels of the bound SDF (xy), and the
// shadow's length, `range` world units, in those texels (z). The facing is
// projected as a vector (w = 0), so the camera's translation drops out; the y
// flip is toScreenUV's (the world is y-up, the texture y-down).
fn directionalRay(e: u32) -> vec3f {
    let size = vec2f(textureDimensions(sdf));
    let clip = (u.viewProjection * vec4f(-lightFacing(transforms[e]), 0.0, 0.0)).xy;
    let perUnit = vec2f(clip.x, -clip.y) * 0.5 * size;  // one world unit toward the light, in texels
    let texels = length(perUnit);
    if (texels < 1e-6) {
        return vec3f(0.0);  // a degenerate camera: no shadow
    }
    // The shadow's length in texels. Rust accepts any finite range, and
    // CameraAPI.zoom has no upper bound: bound the PRODUCT without computing it
    // first (1e30 / texels is finite for texels >= 1e-6). A range of 0 or less
    // casts no shadow.
    let reach = min(max(primParams[e * 8u + 3u], 0.0), 1e30 / texels) * texels;
    return vec3f(perUnit / texels, reach);
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
        if (kind == DIRECTIONAL) {
            out.sunRay = directionalRay(e);
        }
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

// A caster t texels from the pixel casts at this strength. `reach` <= 0: full
// strength everywhere (point and spot lights). A sun: full strength for the
// first SUN_FADE_START of its shadow's length, then a smoothstep down to 0 at
// the end (C1 at both ends: no Mach band on a smooth floor). The early return
// keeps smoothstep from ever seeing equal edges.
fn sunFade(t: f32, reach: f32) -> f32 {
    if (reach <= 0.0) {
        return 1.0;
    }
    return 1.0 - smoothstep(SUN_FADE_START * reach, reach, t);
}

// How much of the light reaches a pixel, 0..1. A sphere march on the signed SDF
// from `origin` along the unit `dir`, in SDF texels, for `travel` texels, with
// Quilez's soft-shadow term: h/t is the angle the nearest occluder subtends
// from the current point, compared with `angle`. That comparison is what makes
// the penumbra: it ramps from 0 to 1 over angle * t texels on the lit side of
// the edge, the width a source of angular DIAMETER `angle` would give (the
// penumbra's width per texel of distance).
//
// pointShadow and sunShadow choose origin, dir, travel, angle and the step
// budget; everything below is shared. `fadeReach` > 0 (a sun): a caster t
// texels away casts at strength sunFade(t, fadeReach). 0 (point, spot): every
// select below takes its false operand, exactly the arithmetic of before step
// 6. `steps`: the SDF reads after the first, both loops together:
// u.shadowSteps for a point or spot light, as before step 6; 4x that for a
// sun (sunShadow).
//
// This is deliberately the ORIGINAL form, not the Aaltonen correction
// (y = h*h / (2*ph), d = sqrt(h*h - y*y), ...). That correction assumes an
// exact SDF, and a jump-flood field only ever over-estimates h (design §6.2,
// A1). The y term amplifies exactly that error, so the "better" formula would
// make shadows worse here (§7.3, A2).
fn shadow(origin: vec2f, dir: vec2f, travel: f32, angle: f32, fadeReach: f32, steps: u32) -> f32 {
    let size = vec2i(textureDimensions(sdf));
    let fading = fadeReach > 0.0;
    var t = 0.0;
    var h = sdfDistance(vec2i(origin), size);
    var i = 0u;
    // A pixel inside an occluder (a sprite that both casts and receives) is not
    // shadowed by the occluder it belongs to, but must be by every other one:
    // leave it first, then march. Inside, |h| is the distance to the nearest
    // free texel, a lower bound on the way out in any direction, so a step of
    // |h| never overshoots the exit. Returning "lit" here instead left every
    // such sprite fully lit inside a wall's shadow.
    while (h <= 0.0 && i < steps) {
        t += max(-h, 1.0);
        if (t >= travel) {
            return 1.0;  // the light (a sun: the end of the ray) is inside the same occluder
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
    for (; i < steps; i++) {
        if (t >= travel) {
            break;
        }
        h = sdfDistance(vec2i(origin + dir * t), size);
        if (h <= 0.0) {
            // Every later caster is farther away, so fainter: this is the minimum.
            return select(0.0, min(res, 1.0 - sunFade(t, fadeReach)), fading);
        }
        let q = h / ((t - start) * angle);
        res = min(res, select(q, 1.0 - sunFade(t, fadeReach) * (1.0 - q), fading));
        t += h;
    }
    // Out of steps before the end of the ray: the rest of it is unproven. A
    // ray hugging a long wall spends its steps 1-2 texels at a time, and the
    // running `res` alone lit pixels squarely behind the wall. Returning 0
    // would darken long rays through open space instead. Assume the clearance
    // stays the last one seen, all the way to the end of the ray (a sun: at
    // the fade of the point where the steps ran out, the darkest one left).
    if (t < travel) {
        let q = h / ((travel - start) * angle);
        res = min(res, select(q, 1.0 - sunFade(t, fadeReach) * (1.0 - q), fading));
    }
    return clamp(res, 0.0, 1.0);
}

// A point or spot light: from the pixel toward the light's centre, at the
// light's apparent angle min(1/k, sourceRadius / travel). Quilez's k alone
// is a CONSTANT angle, the apparent size of a light at infinity; for a torch
// it is a light whose radius grows with the pixel's distance (travel/k), and a
// light beside a wall then darkened pixels on the far side of it, because the
// last steps of their march pass within h of the wall. Measured 2026-09-26:
// free rays 23-42% darker, in radial bands. The second term is the light's
// real size, so a far pixel sees a small light.
fn pointShadow(fromUV: vec2f, toUV: vec2f, sourceRadius: f32) -> f32 {
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
    return shadow(origin, dir, travel, angle, 0.0, u.shadowSteps);
}

// Texels from `origin` (inside the texture) to where a ray along the unit
// `dir` leaves the size.x x size.y rectangle: a slab test. An axis the ray
// does not move along never ends it; a unit dir moves along at least one.
fn exitDistance(origin: vec2f, dir: vec2f, size: vec2f) -> f32 {
    let moving = abs(dir) > vec2f(1e-6);
    let side = select(vec2f(0.0), size, dir > vec2f(0.0));
    let t = select(vec2f(1e30), (side - origin) / select(vec2f(1.0), dir, moving), moving);
    return min(t.x, t.y);
}

// A directional light: from the pixel toward the light, for the shadow's
// length (`ray.z`, its range) or until the ray leaves the SDF, whichever comes
// first. Beyond the SDF nothing is known, and it counts as lit: the clamped
// read would repeat the edge texel forever, and a light at infinity would make
// the out-of-steps rule 0. A light at infinity has a constant apparent size:
// u.sourceFraction (0.02 rad, about 1.15 degrees), the penumbra's width per
// unit of distance, i.e. about the source's angular diameter; the same angle
// every point light has at the edge of its range (not 1/k: 0.125 rad is 13x
// the real sun's diameter, 0.0093 rad).
//
// A sun marches 4x the budget of a point or spot light (sub-decision 2 (b) of
// round step 6). An axis-aligned sun's rays graze the faces parallel to them
// (an unrotated caster's) for their whole length, 1-2 texels a step: at the
// default 48 steps they ran out of steps over ~1% of the step-6 bench's light
// buffer (off by more than 0.1 sun), at 192 over 0.1% at most (GPU A/B,
// docs/plans/assets/2026-09-30-step6/penumbra-ab-m2.json). Point and spot
// lights keep u.shadowSteps: their pixels are those of before step 6.
fn sunShadow(fromUV: vec2f, ray: vec3f) -> f32 {
    let fsize = vec2f(textureDimensions(sdf));
    let origin = fromUV * fsize;
    let travel = min(ray.z, exitDistance(origin, ray.xy, fsize));
    if (travel < 1.0) {
        return 1.0;
    }
    return shadow(origin, ray.xy, travel, u.sourceFraction, ray.z, 4u * u.shadowSteps);
}

// The light types that cast shadows in the lit backend. Never GLOBAL: it has
// no position and no direction to cast from, and its shadowIntensity is
// ignored. light-groups.ts counts exactly these as shadowed
// (SHADOWED_LIGHT_TYPES); light-groups.test.ts ties the two lists.
fn shadowedLightType(kind: u32) -> bool {
    return kind == POINT || kind == SPOT || kind == DIRECTIONAL;
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
    // The one read of shadowIntensity (slot 7), through the type gate.
    let shadowStrength = select(0.0, clamp(primParams[p + 7u], 0.0, 1.0), shadowedLightType(kind));

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
            let facing = lightFacing(m);
            let toPixel = select(facing, (in.world - center) / d, d > 1e-4);
            let cosAngle = dot(facing, toPixel);
            let innerCos = primParams[p + 4u];
            let outerCos = primParams[p + 5u];
            // smoothstep is undefined when its edges meet: a hard cone then.
            let cone = select(step(outerCos, cosAngle), smoothstep(outerCos, innerCos, cosAngle), innerCos > outerCos + 1e-5);
            intensity *= cone;
        }

        if (shadowStrength > 0.0 && intensity > 0.0) {
            let lightUV = toScreenUV(u.viewProjection * vec4f(center, 0.0, 1.0));
            // The source radius in SDF texels: a fraction of the range, so it
            // follows the light's size and the zoom like the rest of the world.
            let size = vec2f(textureDimensions(sdf));
            let edgeUV = toScreenUV(u.viewProjection * vec4f(center + vec2f(range, 0.0), 0.0, 1.0));
            let sourceRadius = max(1.0, distance(lightUV * size, edgeUV * size) * u.sourceFraction);
            intensity *= mix(1.0, pointShadow(in.screenUV, lightUV, sourceRadius), shadowStrength);
        }
    } else if (kind == DIRECTIONAL && shadowStrength > 0.0) {
        intensity *= mix(1.0, sunShadow(in.screenUV, in.sunRay), shadowStrength);
    }

    var c = color * intensity;
    if (((renderMeta[e * 2u + 1u] >> LIGHT_BLEND_SHIFT) & 3u) == BLEND_SUB) {
        c = -c;
    }
    // Alpha 0: the buffer's alpha stays at the clear value (1).
    return vec4f(c, 0.0);
}
