// pixel-probe.wgsl — dev-only readback for engine.debug.probe (render/debug-probe.ts).
//
// Reads a texture at UV points ((0,0) = top-left texel) with textureLoad, so it
// works on any sampled view (scene-hdr, the swapchain configured with
// TEXTURE_BINDING in dev builds, one layer of the light-buffer array) at any
// resolution: the texel comes from textureDimensions, and the last output
// element carries the size, so the caller needs to know neither.

@group(0) @binding(0) var<storage, read> points: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> results: array<vec4f>;
@group(0) @binding(2) var src2d: texture_2d<f32>;
@group(0) @binding(3) var srcArray: texture_2d_array<f32>;

struct ProbeParams {
  layer: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}
@group(0) @binding(4) var<uniform> params: ProbeParams;

fn texelAt(uv: vec2f, dims: vec2u) -> vec2u {
  let t = vec2u(clamp(uv * vec2f(dims), vec2f(0.0), vec2f(dims - vec2u(1u))));
  return t;
}

@compute @workgroup_size(64)
fn probe_2d(@builtin(global_invocation_id) id: vec3u) {
  let count = arrayLength(&points);
  let dims = textureDimensions(src2d);
  if (id.x == 0u) {
    results[count] = vec4f(f32(dims.x), f32(dims.y), 0.0, 0.0);
  }
  if (id.x >= count) { return; }
  results[id.x] = textureLoad(src2d, texelAt(points[id.x], dims), 0);
}

@compute @workgroup_size(64)
fn probe_array(@builtin(global_invocation_id) id: vec3u) {
  let count = arrayLength(&points);
  let dims = textureDimensions(srcArray);
  if (id.x == 0u) {
    results[count] = vec4f(f32(dims.x), f32(dims.y), 0.0, 0.0);
  }
  if (id.x >= count) { return; }
  results[id.x] = textureLoad(srcArray, texelAt(points[id.x], dims), params.layer, 0);
}
