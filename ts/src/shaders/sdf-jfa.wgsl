// Signed Jump Flood: one iteration of the signed-SDF chain (Phase 17, Task 8).
//
// Every texel stores (nearest-opposite u, v, valid, inside):
//   inside  this texel's own kind, 1 under an occluder and 0 in free space.
//           It never changes along the chain, and it is the sign of the SDF.
//   u, v    the nearest texel of the OPPOSITE kind found so far, in [0,1].
//   valid   1 once (u, v) holds something.
// A neighbour of the opposite kind is itself a candidate (Godot's
// canvas_sdf.glsl), so the inside and outside fronts flood together in one
// chain.
//
// The first pass (LOAD_PASS) reads the raw occluder seed instead. There,
// occluder texels are (u, v, 1, 1) and free texels are zero, so a texel's kind
// is alpha. There are no candidates yet: rg and b mean something else there,
// and must be ignored.
//
// Distances are measured in TEXELS, not in uv. uv is anisotropic on a
// non-square target, and the ray march that reads this field needs a distance
// that means the same in every direction.
//
// Seeds are read with textureLoad: filtering would blend seed coordinates.

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: JFAParams;

// Four scalars, 16 bytes, at the offsets SdfChainStage.prepare() writes
// (0, 4, 8, 12), one 256-byte slice per step. A vec2f member would be 8-aligned, pushing it to offset 8 and
// the struct to 24 bytes: larger than the 16-byte buffer, which fails
// validation at draw time.
struct JFAParams {
    stepSize: f32,
    texelSizeX: f32,
    texelSizeY: f32,
    _pad: f32,
};

// True only for the first pass of the chain, which reads the raw occluder seed
// (LightGroupsPass's private `light-seed` texture).
override LOAD_PASS: bool = false;

struct VertexOutput {
    @builtin(position) position: vec4f,
};

// Full-screen triangle: 3 vertices cover the entire target.
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(vertexIndex & 1u) * 4 - 1);
    let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
    out.position = vec4f(x, y, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let size = vec2i(textureDimensions(inputTex));
    let texSize = vec2f(size);
    let texel = vec2i(in.position.xy);           // fragment centres sit at +0.5
    let here = (vec2f(texel) + 0.5) / texSize;   // this texel's uv
    let own = textureLoad(inputTex, texel, 0);
    let inside = own.a > 0.5;

    var best = vec4f(0.0, 0.0, 0.0, select(0.0, 1.0, inside));
    var bestDist = 1e30;
    if (!LOAD_PASS && own.b > 0.5) {
        best = own;
        bestDist = length((own.rg - here) * texSize);
    }

    let step = i32(params.stepSize);
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) { continue; }
            let q = texel + vec2i(dx, dy) * step;
            if (any(q < vec2i(0)) || any(q >= size)) { continue; }
            let n = textureLoad(inputTex, q, 0);

            var candidate: vec2f;
            if ((n.a > 0.5) != inside) {
                // Opposite kind: the neighbour is itself the nearest opposite so far.
                candidate = (vec2f(q) + 0.5) / texSize;
            } else if (!LOAD_PASS && n.b > 0.5) {
                candidate = n.rg;
            } else {
                continue;
            }

            let d = length((candidate - here) * texSize);
            if (d < bestDist) {
                bestDist = d;
                best = vec4f(candidate, 1.0, best.a);
            }
        }
    }
    return best;
}
