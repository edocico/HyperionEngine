// Gradient (type 4, prefix gradient_): linear, radial, and conic gradients via primParams.
// PrimParams layout for Gradient:
//   [0]=type (0=linear, 1=radial, 2=conic)
//   [1]=angle (degrees)
//   [2]=stop0_pos, [3]=stop0_r, [4]=stop0_g, [5]=stop0_b
//   [6]=stop1_pos, [7]=stop1_r
// stop1 G,B are packed into texLayerIndices (low bytes)
// A library of the primitive modules: see prelude.wgsl. Lit: gradient_fs
// applies the light buffer.

fn gradient_vs(position: vec3f, entityIdx: u32) -> VertexOutput {
    return unitQuadVertex(position, entityIdx, position.xy + 0.5);
}

// The gradient's colour and coverage. Shared by both entry points: a gradient
// casts the shadow of exactly the pixels it draws.
fn gradient_shade(in: VertexOutput) -> vec4f {
    let base = in.entityIdx * 8u;
    let gradType = u32(primParams[base + 0u]);
    let angle = primParams[base + 1u];
    let stop0Pos = primParams[base + 2u];
    let stop0 = vec3f(primParams[base + 3u], primParams[base + 4u], primParams[base + 5u]);
    let stop1Pos = primParams[base + 6u];
    let stop1R = primParams[base + 7u];
    let packed = texLayerIndices[in.entityIdx];
    let stop1G = f32((packed >> 8u) & 0xFFu) / 255.0;
    let stop1B = f32(packed & 0xFFu) / 255.0;
    let stop1 = vec3f(stop1R, stop1G, stop1B);

    var t: f32;
    if (gradType == 0u) {
        // Linear gradient
        let rad = angle * 3.14159265 / 180.0;
        let dir = vec2f(cos(rad), sin(rad));
        t = dot(in.uv - 0.5, dir) + 0.5;
    } else if (gradType == 1u) {
        // Radial gradient
        t = length(in.uv - 0.5) * 2.0;
    } else {
        // Conic gradient
        let rad = angle * 3.14159265 / 180.0;
        let centered = in.uv - 0.5;
        t = (atan2(centered.y, centered.x) + 3.14159265 - rad) / (2.0 * 3.14159265);
        t = fract(t);
    }

    let s = clamp((t - stop0Pos) / max(stop1Pos - stop0Pos, 0.001), 0.0, 1.0);
    let color = mix(stop0, stop1, s);
    return vec4f(color, 1.0);
}

fn gradient_fs(in: VertexOutput) -> vec4f {
    return applyLighting(in, gradient_shade(in));
}

// A seed wherever the gradient is at least half covered.
fn gradient_occluder(in: VertexOutput) -> vec4f {
    return occluderSeed(in, gradient_shade(in).a);
}
