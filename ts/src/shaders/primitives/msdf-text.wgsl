// MSDF text (type 2, prefix msdf_): median(r,g,b) SDF with screen-pixel-range AA.
// PrimParams layout for SDFGlyph (type 2):
//   [0]=atlasU0, [1]=atlasV0, [2]=atlasU1, [3]=atlasV1  — atlas UV rect
//   [4]=screenPxRange  — SDF range in screen pixels
//   [5]=colorR, [6]=colorG, [7]=colorB  — text color
// A library of the primitive modules: see prelude.wgsl.

fn msdf_median3(r: f32, g: f32, b: f32) -> f32 {
    return max(min(r, g), min(max(r, g), b));
}

fn msdf_vs(position: vec3f, entityIdx: u32) -> VertexOutput {
    // Read atlas UV rect from primParams
    let base = entityIdx * 8u;
    let atlasU0 = primParams[base + 0u];
    let atlasV0 = primParams[base + 1u];
    let atlasU1 = primParams[base + 2u];
    let atlasV1 = primParams[base + 3u];

    // Map unit quad UVs to atlas UV rect
    let localUV = position.xy + 0.5;

    return unitQuadVertex(position, entityIdx, vec2f(
        mix(atlasU0, atlasU1, localUV.x),
        mix(atlasV0, atlasV1, localUV.y),
    ));
}

// The glyph's colour and coverage. Shared by both entry points: a glyph casts
// the shadow of exactly the outline it draws.
fn msdf_shade(in: VertexOutput) -> vec4f {
    let base = in.entityIdx * 8u;
    let screenPxRange = primParams[base + 4u];
    let colorR = primParams[base + 5u];
    let colorG = primParams[base + 6u];
    let colorB = primParams[base + 7u];

    // The MSDF texel, RAW (sampleTier, never sampleTierOrWhite): the texel is
    // the glyph's coverage, and a white answer for packed index 0 would draw a
    // solid box where today an unfilled layer is discarded.
    let msdf = sampleTier(in);

    let sd = msdf_median3(msdf.r, msdf.g, msdf.b);

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

fn msdf_fs(in: VertexOutput) -> vec4f {
    return msdf_shade(in);
}

// A seed wherever the glyph is at least half covered.
fn msdf_occluder(in: VertexOutput) -> vec4f {
    return occluderSeed(in, msdf_shade(in).a);
}
