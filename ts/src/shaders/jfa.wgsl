// Jump Flood Algorithm -- one iteration per dispatch.
// Reads from input texture, writes to output texture via full-screen triangle.
// Ping-pong between two textures across iterations.
//
// Each pixel stores (seedU, seedV, isSeed, 1.0) where B > 0.5 indicates
// a valid seed.  The algorithm propagates nearest-seed information by
// sampling 9 neighbors at +/- stepSize texels.

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var<uniform> params: JFAParams;

struct JFAParams {
    stepSize: f32,
    texelSize: vec2f,
    _pad: f32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

// Full-screen triangle: 3 vertices cover the entire screen
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(vertexIndex & 1u) * 4 - 1);
    let y = f32(i32(vertexIndex >> 1u) * 4 - 1);
    out.position = vec4f(x, y, 0.0, 1.0);
    out.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let step = params.stepSize * params.texelSize;
    var bestSeed = textureSample(inputTex, inputSampler, in.uv);
    var bestDist = 1e10;

    if (bestSeed.b > 0.5) {
        bestDist = length(in.uv - bestSeed.rg);
    }

    // Sample 9 neighbors (3x3 at step distance)
    for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) { continue; }
            let offset = vec2f(f32(dx), f32(dy)) * step;
            let sampleUV = in.uv + offset;

            // Skip out-of-bounds samples
            if (sampleUV.x < 0.0 || sampleUV.x > 1.0 ||
                sampleUV.y < 0.0 || sampleUV.y > 1.0) {
                continue;
            }

            let s = textureSample(inputTex, inputSampler, sampleUV);
            if (s.b > 0.5) {
                let dist = length(in.uv - s.rg);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestSeed = s;
                }
            }
        }
    }

    return bestSeed;
}
