// Design artifact: sized binding array texture sampling.
// NOT wired into ForwardPass — documents the target WGSL structure
// for when browsers ship `bindingArraySize` in GPUBindGroupLayoutEntry.
//
// Current encoding: (overflow<<31) | (tier<<16) | layer
// Target encoding: flat global index [0, N)
//
// Migration path when activated:
// - TextureManager allocates individual texture_2d per texture (no Texture2DArray tiers)
// - ForwardPass bind group: 8 texture views (4 tiers + 4 overflow) -> 1 binding array
// - CullPass: no tier-based material bucketing needed
// - All 6 fragment shaders simplified: single texture_sample with flat index

@group(0) @binding(0) var<uniform> camera: mat4x4f;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> texIndices: array<u32>;

// Sized binding array: all textures in a single indexable binding
@group(1) @binding(0) var textures: binding_array<texture_2d<f32>, 256>;
@group(1) @binding(1) var texSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) texIndex: u32,
};

@vertex
fn vs_main(
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
    let entityIdx = visibleIndices[instanceIndex];
    let model = transforms[entityIdx];
    let texIdx = texIndices[entityIdx]; // flat global index [0, N)

    // Standard quad vertices (2 triangles)
    let quadPos = array<vec2f, 6>(
        vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5),
        vec2f(-0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5),
    );
    let quadUV = array<vec2f, 6>(
        vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
        vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(0.0, 0.0),
    );

    let pos = quadPos[vertexIndex];
    let worldPos = model * vec4f(pos, 0.0, 1.0);

    var out: VertexOutput;
    out.position = camera * worldPos;
    out.uv = quadUV[vertexIndex];
    out.texIndex = texIdx;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    // Single indexed texture sample — no tier/layer decomposition, no switch
    return textureSampleLevel(textures[in.texIndex], texSampler, in.uv, 0.0);
}
