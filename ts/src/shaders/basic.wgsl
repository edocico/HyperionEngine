// Instanced colored quad shader with GPU-driven visibility indirection.

struct CameraUniform {
    viewProjection: mat4x4f,
};

struct EntityData {
    model: mat4x4f,
    boundingSphere: vec4f,  // xyz = position, w = radius (unused in render)
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> entities: array<EntityData>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;

struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) color: vec4f,
    @location(1) uv: vec2f,
};

@vertex
fn vs_main(
    @location(0) position: vec3f,
    @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
    // Indirection: instance_index → visible slot → entity index
    let entityIdx = visibleIndices[instanceIdx];
    let model = entities[entityIdx].model;

    var out: VertexOutput;
    out.clipPosition = camera.viewProjection * model * vec4f(position, 1.0);

    // Deterministic color from entity index (not instance index)
    let r = f32((entityIdx * 7u + 3u) % 11u) / 10.0;
    let g = f32((entityIdx * 13u + 5u) % 11u) / 10.0;
    let b = f32((entityIdx * 17u + 7u) % 11u) / 10.0;
    out.color = vec4f(r, g, b, 1.0);

    // UV for future texture sampling
    out.uv = position.xy + 0.5;

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    return in.color;
}
