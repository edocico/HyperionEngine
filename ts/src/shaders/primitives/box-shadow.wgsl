// Box shadow (type 5, prefix boxshadow_): SDF shadow, Evan Wallace erf() technique.
// PrimParams layout for BoxShadow:
//   [0]=rectW, [1]=rectH, [2]=cornerRadius, [3]=blur
//   [4]=colorR, [5]=colorG, [6]=colorB, [7]=colorA
// A library of the primitive modules: see prelude.wgsl.

fn boxshadow_vs(position: vec3f, entityIdx: u32) -> VertexOutput {
    return unitQuadVertex(position, entityIdx, position.xy + 0.5);
}

// Abramowitz-Stegun erf() approximation
fn boxshadow_erf(x: f32) -> f32 {
    let a1 =  0.254829592;
    let a2 = -0.284496736;
    let a3 =  1.421413741;
    let a4 = -1.453152027;
    let a5 =  1.061405429;
    let p  =  0.3275911;
    let s = sign(x);
    let ax = abs(x);
    let t = 1.0 / (1.0 + p * ax);
    let y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * exp(-ax * ax);
    return s * y;
}

fn boxshadow_integral(x: f32, sigma: f32) -> f32 {
    let s = x / (sigma * 1.4142135);
    return boxshadow_erf(s);
}

fn boxshadow_box2d(uv: vec2f, rectSize: vec2f, cornerRadius: f32, blur: f32) -> f32 {
    let sigma = blur * 0.5;
    if (sigma < 0.001) {
        // Sharp shadow — SDF rounded box
        let q = abs(uv) - rectSize * 0.5 + cornerRadius;
        let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - cornerRadius;
        return select(0.0, 1.0, d < 0.0);
    }
    let half = rectSize * 0.5 - cornerRadius;
    let ax = boxshadow_integral(uv.x + half.x, sigma) - boxshadow_integral(uv.x - half.x, sigma);
    let ay = boxshadow_integral(uv.y + half.y, sigma) - boxshadow_integral(uv.y - half.y, sigma);
    return ax * ay * 0.25;
}

// The box shadow's colour and coverage. Shared by both entry points: a box
// shadow casts the shadow of exactly the pixels it draws.
fn boxshadow_shade(in: VertexOutput) -> vec4f {
    let base = in.entityIdx * 8u;
    let rectW = primParams[base + 0u];
    let rectH = primParams[base + 1u];
    let cornerRadius = primParams[base + 2u];
    let blur = primParams[base + 3u];
    let colorR = primParams[base + 4u];
    let colorG = primParams[base + 5u];
    let colorB = primParams[base + 6u];
    let colorA = primParams[base + 7u];

    let localPos = (in.uv - 0.5) * vec2f(rectW + blur * 4.0, rectH + blur * 4.0);
    let alpha = boxshadow_box2d(localPos, vec2f(rectW, rectH), cornerRadius, blur);
    return vec4f(colorR, colorG, colorB, colorA * alpha);
}

fn boxshadow_fs(in: VertexOutput) -> vec4f {
    return boxshadow_shade(in);
}

// A seed wherever the box shadow is at least half covered.
fn boxshadow_occluder(in: VertexOutput) -> vec4f {
    return occluderSeed(in, boxshadow_shade(in).a);
}
