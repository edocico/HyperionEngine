// Quadratic Bezier curve (type 3, prefix bezier_): analytical SDF (Inigo Quilez).
// PrimParams layout for BezierPath:
//   [0]=p0x, [1]=p0y, [2]=p1x, [3]=p1y, [4]=p2x, [5]=p2y, [6]=width, [7]=_pad
// All control points in UV space [0,1].
// A library of the primitive modules: see prelude.wgsl.

fn bezier_vs(position: vec3f, entityIdx: u32) -> VertexOutput {
    return unitQuadVertex(position, entityIdx, position.xy + 0.5);
}

// --- Quadratic Bezier SDF (Inigo Quilez) ---
// Returns the unsigned distance from point `pos` to the quadratic Bezier
// defined by control points a, b, c.
// Reference: https://iquilezles.org/articles/distfunctions2d/

fn bezier_dot2(v: vec2f) -> f32 {
    return dot(v, v);
}

fn bezier_sd(pos: vec2f, a: vec2f, b: vec2f, c: vec2f) -> f32 {
    let A = b - a;
    let B = a - 2.0 * b + c;
    let C = A * 2.0;
    let D = a - pos;

    var res: f32 = 0.0;

    if (dot(B, B) < 1e-9) {
        // The control point sits (within 1.6e-5) at the middle of the chord:
        // the curve IS the chord a-c, to within |B| / 4 < 8e-6 in uv. The
        // cubic below would divide by dot(B, B) = 0, and near it its terms
        // grow like 1 / |B|^6 and overflow f32 (a straight curve drew a dot
        // around a on Metal, NaN elsewhere). Squared distance to the segment;
        // to the point a when a == c.
        let ba = c - a;
        let h = clamp(dot(-D, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
        res = bezier_dot2(D + ba * h);
    } else {
        // Cubic coefficients: k * t^3 + ... = 0
        let kk = 1.0 / dot(B, B);
        let kx = kk * dot(A, B);
        let ky = kk * (2.0 * dot(A, A) + dot(D, B)) / 3.0;
        let kz = kk * dot(D, A);

        let p = ky - kx * kx;
        let q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
        let p3 = p * p * p;
        let q2 = q * q;
        var h: f32 = q2 + 4.0 * p3;

        if (h >= 0.0) {
            // One real root, t = u + v - kx, where u^3 and v^3 are (h - q) / 2
            // and (-h - q) / 2, and u v = -p. The one whose two terms have
            // opposite signs is a difference of terms ~|q|: where |p|^3 << q^2
            // only its rounding error is left, and the cube root magnifies it
            // (1e-8 becomes 2e-3). A strongly curved curve lost pixels of a
            // thin stroke where p crosses 0, and a near-straight one most of
            // its stroke at 35.26 or 144.74 degrees between A and B, where p's
            // leading terms cancel all along it (Mac M2, 2026-09-29). So only
            // the other one is rooted, and v follows from u v = -p; u = 0 only
            // when q = h = 0, and then p = 0 too.
            h = sqrt(h);
            let w = -0.5 * (q + select(-h, h, q >= 0.0));
            let u = sign(w) * pow(abs(w), 1.0 / 3.0);
            let v = select(0.0, -p / u, u != 0.0);
            let t = clamp(u + v - kx, 0.0, 1.0);
            let qp = D + (C + B * t) * t;
            res = bezier_dot2(qp);
        } else {
            // Three real roots — use trigonometric solution
            let z = sqrt(-p);
            // Rounding can push the cosine past ±1, and acos is NaN there.
            let v = acos(clamp(q / (p * z * 2.0), -1.0, 1.0)) / 3.0;
            let m = cos(v);
            let n = sin(v) * 1.732050808; // sqrt(3)
            let t0 = clamp(vec3f(m + m, -n - m, n - m) * z - kx, vec3f(0.0), vec3f(1.0));

            // Only 2 of 3 roots need evaluation (third is provably suboptimal
            // for this parametric formulation — matches Quilez reference).
            let qx = D + (C + B * t0.x) * t0.x;
            let qy = D + (C + B * t0.y) * t0.y;
            let dx = bezier_dot2(qx);
            let dy = bezier_dot2(qy);
            res = min(dx, dy);
        }

        // A second candidate, for near-straight curves: there kx ~ 1 / |B| is
        // large, and t = u + v - kx keeps only the absolute precision of
        // u + v (in an f32 emulation, 4e-4 uv at |B| = 2e-4 without this
        // candidate, 3e-8 with it). The projection on the chord, polished by
        // two Newton steps on g(t) = (P(t) - pos).P'(t), is exact for such
        // curves. Any t in [0, 1] is a point of the curve, so the smaller
        // distance is never below the true one, and a NaN from the roots (the
        // comparison fails) always loses to this candidate.
        let ba = c - a;
        var tn = clamp(dot(-D, ba) / max(dot(ba, ba), 1e-12), 0.0, 1.0);
        for (var i = 0; i < 2; i = i + 1) {
            let toCurve = D + (C + B * tn) * tn;  // P(t) - pos
            let tangent = C + 2.0 * B * tn;       // P'(t)
            let slope = dot(tangent, tangent) + 2.0 * dot(toCurve, B);
            tn = clamp(tn - dot(toCurve, tangent) / max(slope, 1e-12), 0.0, 1.0);
        }
        res = min(select(1e30, res, res < 1e30), bezier_dot2(D + (C + B * tn) * tn));
    }

    return sqrt(res);
}

// The curve's colour and coverage. Shared by both entry points: a bezier casts
// the shadow of exactly the stroke it draws.
fn bezier_shade(in: VertexOutput) -> vec4f {
    // Read Bezier control points and width from primParams
    let base = in.entityIdx * 8u;
    let p0 = vec2f(primParams[base + 0u], primParams[base + 1u]);
    let p1 = vec2f(primParams[base + 2u], primParams[base + 3u]);
    let p2 = vec2f(primParams[base + 4u], primParams[base + 5u]);
    let width = primParams[base + 6u];

    // Compute unsigned distance from fragment to Bezier curve
    let d = bezier_sd(in.uv, p0, p1, p2);

    // Anti-aliased stroke: fwidth gives screen-space-adaptive 1px edge
    let halfWidth = width * 0.5;
    let edge = fwidth(d);
    let aa = 1.0 - smoothstep(halfWidth - edge, halfWidth + edge, d);

    if (aa < 0.01) {
        discard;
    }

    // Sample color from texture tier (with overflow support); packed index 0
    // is white (sampleTierOrWhite). Only the colour is replaced here — the
    // stroke's coverage below still applies.
    var color = sampleTierOrWhite(in);

    color.a *= aa;
    return color;
}

fn bezier_fs(in: VertexOutput) -> vec4f {
    return bezier_shade(in);
}

// A seed wherever the stroke is at least half covered.
fn bezier_occluder(in: VertexOutput) -> vec4f {
    return occluderSeed(in, bezier_shade(in).a);
}
