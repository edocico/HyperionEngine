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
        res = bezier_dot2(qp);
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
        let dx = bezier_dot2(qx);
        let dy = bezier_dot2(qy);
        res = min(dx, dy);
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
