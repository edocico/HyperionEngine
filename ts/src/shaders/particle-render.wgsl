// particle-render.wgsl — GPU particle rendering (point sprites as quads)

struct Particle {
  position: vec2f,
  velocity: vec2f,
  color: vec4f,
  lifetime: f32,
  age: f32,
  size: f32,
  _pad: f32,
}

struct CameraUniforms {
  viewProjection: mat4x4f,
}

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> camera: CameraUniforms;
@group(0) @binding(2) var<storage, read> aliveCount: array<u32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) uv: vec2f,
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let p = particles[instanceIndex];

  if (p.age >= p.lifetime || p.size <= 0.0) {
    var out: VertexOutput;
    out.position = vec4f(0.0, 0.0, -2.0, 1.0);
    out.color = vec4f(0.0);
    out.uv = vec2f(0.0);
    return out;
  }

  let corners = array<vec2f, 4>(
    vec2f(-0.5, -0.5), vec2f(0.5, -0.5),
    vec2f(-0.5,  0.5), vec2f(0.5,  0.5),
  );
  let corner = corners[vertexIndex % 4u];

  let worldPos = vec4f(p.position + corner * p.size, 0.0, 1.0);

  var out: VertexOutput;
  out.position = camera.viewProjection * worldPos;
  out.color = p.color;
  out.uv = corner + vec2f(0.5);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let center = vec2f(0.5);
  let dist = length(in.uv - center);
  let edge = fwidth(dist);
  let alpha = 1.0 - smoothstep(0.45 - edge, 0.45 + edge, dist);

  if (alpha < 0.01) { discard; }

  return vec4f(in.color.rgb, in.color.a * alpha);
}
