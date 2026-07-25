// Debug line rendering (Phase 16 Track A).
// Line-list topology, per-vertex color, world-space positions transformed
// by the camera view-projection. Used by DebugLinePass (physics debug) and
// BoundsVisualizerPass (bounding-sphere wireframes).

struct Camera {
  viewProjection: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
) -> VSOut {
  var out: VSOut;
  out.position = camera.viewProjection * vec4<f32>(position, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
