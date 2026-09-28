// Line (type 1, prefix line_): a quad expanded across the segment from line parameters.
// PrimParams layout for Line:
//   [0]=startX, [1]=startY, [2]=endX, [3]=endY, [4]=width, [5]=dashLen, [6]=gapLen,
//   [7]=width unit: 0 = local units (scaled by the entity and the zoom), 1 = screen pixels
// A library of the primitive modules: see prelude.wgsl. Its fs and occluder
// are its own, not the common pattern: the opaque stroke is exactly
// line_insideStroke.

fn line_vs(position: vec3f, entityIdx: u32) -> VertexOutput {
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

    let worldPos = vec2f(startX, startY)
        + d * along * len
        + perp * across * quadWidth;

    var clipPosition: vec4f;
    if (pixelWidth) {
        let c0 = camera.viewProjection * model * vec4f(startX, startY, 0.0, 1.0);
        let c1 = camera.viewProjection * model * vec4f(endX, endY, 0.0, 1.0);
        let s = (c1.xy / c1.w - c0.xy / c0.w) * viewport;  // on-screen direction, pixels
        let sl = length(s);
        let sd = select(vec2f(1.0, 0.0), s / sl, sl > 0.001);
        let clip = mix(c0, c1, along);
        let offsetNdc = vec2f(-sd.y, sd.x) * across * quadWidth * 2.0 / viewport;
        clipPosition = vec4f(clip.xy + offsetNdc * clip.w, clip.zw);
    } else {
        clipPosition = camera.viewProjection * model * vec4f(worldPos, 0.0, 1.0);
    }

    var out = finishVertex(clipPosition, vec2f(along, across + 0.5), entityIdx);
    out.edgeScale = select(1.0, quadWidth / strokeWidth, strokeWidth > 0.0);
    // Computed from renderMeta bit 8, never assumed: the uber draws only
    // transparent entities today, but this must not depend on who draws it.
    out.transparent = select(0u, 1u, (renderMeta[entityIdx * 2u + 1u] & 0x100u) != 0u);
    return out;
}

// Shift of the stroke's half-open interval (edge units): see line_insideStroke.
const LINE_STROKE_TIE_EPS: f32 = 1e-3;

// Whether this fragment is inside the stroke, as a rasteriser decides a tie:
// the interval is half-open, [-1, 1), so a pixel centre exactly on an edge
// belongs to one side only, and an opaque W-px stroke covers exactly W pixel
// rows at any sub-pixel alignment (an alpha >= 0.5 test counted a tie on both
// sides). Both ends are shifted by the same tiny amount, so interpolation
// rounding at an exact tie cannot drop both edge pixels.
fn line_insideStroke(in: VertexOutput) -> bool {
    let d = (in.uv.y - 0.5) * 2.0 * in.edgeScale;
    return d >= -1.0 - LINE_STROKE_TIE_EPS && d < 1.0 - LINE_STROKE_TIE_EPS;
}

// The line's colour and coverage. Shared by both entry points: a line casts
// the shadow of exactly what it draws, dash gaps and anti-aliased edges included.
fn line_shade(in: VertexOutput) -> vec4f {
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

    // Read color from texture (with overflow support); packed index 0 is
    // white (sampleTierOrWhite). Only the colour is replaced here — the
    // stroke's coverage below still applies.
    var color = sampleTierOrWhite(in);

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

fn line_fs(in: VertexOutput) -> vec4f {
    let color = line_shade(in);
    // The opaque pipeline has no blending, so an AA-margin fragment would be
    // drawn solid and the line one pixel wider: keep exactly the stroke. The
    // transparent pipeline blends the ramp instead.
    if (in.transparent == 0u && !line_insideStroke(in)) {
        discard;
    }
    return color;
}

// A seed exactly where the opaque stroke is drawn (line_insideStroke;
// line_shade discards dash gaps).
fn line_occluder(in: VertexOutput) -> vec4f {
    // A texel with no alpha (a textured line) casts nothing either.
    let color = line_shade(in);
    if (color.a <= 0.0 || !line_insideStroke(in)) {
        discard;
    }
    return vec4f(in.screenUV, 1.0, 1.0);
}
