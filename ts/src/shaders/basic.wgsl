// Phase 2: Instanced colored quads.
// Each entity is a unit quad transformed by its model matrix.
// Color is derived from instance index for visual distinction.

struct CameraUniform {
  viewProjection: mat4x4f,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) color: vec3f,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> models: array<mat4x4f>;

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @builtin(instance_index) idx: u32,
) -> VertexOutput {
  var out: VertexOutput;
  let model = models[idx];
  out.clipPosition = camera.viewProjection * model * vec4f(position, 1.0);

  // Deterministic color from instance index
  let r = f32((idx * 7u + 3u) % 11u) / 10.0;
  let g = f32((idx * 13u + 5u) % 11u) / 10.0;
  let b = f32((idx * 17u + 7u) % 11u) / 10.0;
  out.color = vec3f(r, g, b);

  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
