// bloom.wgsl — Dual Kawase Bloom (extract + downsample + upsample + composite)
//
// Entry points:
//   vs_main        — full-screen triangle vertex shader (shared)
//   fs_extract      — bright pixel extraction with luminance threshold
//   fs_downsample   — Kawase 4-tap downsample filter
//   fs_upsample     — Kawase 9-tap tent upsample filter
//   fs_composite    — additive bloom blend + PBR Neutral tonemapping + FXAA

// --- Shared uniforms ---
struct BloomParams {
  texelSize: vec2f,    // 1.0 / textureSize for current operation
  threshold: f32,      // brightness threshold for extract (default 0.7)
  intensity: f32,      // bloom strength multiplier (default 1.0)
  tonemapMode: u32,    // 0=none, 1=PBR Neutral, 2=ACES
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<uniform> params: BloomParams;
@group(0) @binding(1) var inputTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;  // used by composite only
@group(0) @binding(3) var samp: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

// --- Full-screen triangle (covers viewport with 3 vertices, no index buffer) ---
@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  let uv = vec2f(
    f32((vertexIndex << 1u) & 2u),
    f32(vertexIndex & 2u),
  );
  out.position = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(uv.x, 1.0 - uv.y); // flip Y for texture coords
  return out;
}

// --- Extract: threshold bright pixels ---
fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_extract(in: VertexOutput) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTex, samp, in.uv, 0.0);
  let lum = luminance(color.rgb);
  let contrib = max(lum - params.threshold, 0.0);
  let scale = contrib / max(lum, 0.001);
  return vec4f(color.rgb * scale, 1.0);
}

// --- Kawase Downsample (4-tap, half-texel offset) ---
@fragment
fn fs_downsample(in: VertexOutput) -> @location(0) vec4f {
  let o = params.texelSize * 0.5;
  var color = textureSampleLevel(inputTex, samp, in.uv, 0.0) * 4.0;
  color += textureSampleLevel(inputTex, samp, in.uv + vec2f(-o.x, -o.y), 0.0);
  color += textureSampleLevel(inputTex, samp, in.uv + vec2f( o.x, -o.y), 0.0);
  color += textureSampleLevel(inputTex, samp, in.uv + vec2f(-o.x,  o.y), 0.0);
  color += textureSampleLevel(inputTex, samp, in.uv + vec2f( o.x,  o.y), 0.0);
  return color / 8.0;
}

// --- Kawase Upsample (9-tap tent filter) ---
@fragment
fn fs_upsample(in: VertexOutput) -> @location(0) vec4f {
  let o = params.texelSize;
  var color = textureSampleLevel(inputTex, samp, in.uv + vec2f(-o.x, -o.y), 0.0);
  color += textureSampleLevel(inputTex, samp, in.uv + vec2f( 0.0, -o.y), 0.0) * 2.0;
  color += textureSampleLevel(inputTex, samp, in.uv + vec2f( o.x, -o.y), 0.0);
  color += textureSampleLevel(inputTex, samp, in.uv + vec2f(-o.x,  0.0), 0.0) * 2.0;
  color += textureSampleLevel(inputTex, samp, in.uv, 0.0) * 4.0;
  color += textureSampleLevel(inputTex, samp, in.uv + vec2f( o.x,  0.0), 0.0) * 2.0;
  color += textureSampleLevel(inputTex, samp, in.uv + vec2f(-o.x,  o.y), 0.0);
  color += textureSampleLevel(inputTex, samp, in.uv + vec2f( 0.0,  o.y), 0.0) * 2.0;
  color += textureSampleLevel(inputTex, samp, in.uv + vec2f( o.x,  o.y), 0.0);
  return color / 16.0;
}

// --- PBR Neutral tonemap (Khronos) ---
fn pbrNeutralTonemap(color: vec3f) -> vec3f {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  let x = min(color, vec3f(startCompression));
  let over = max(color - vec3f(startCompression), vec3f(0.0));
  let compressed = x + over / (1.0 + over);
  let peak = max(compressed.r, max(compressed.g, compressed.b));
  let g = max(1.0 / (desaturation * (peak - startCompression) + 1.0), 0.0);
  return mix(vec3f(peak), compressed, g);
}

// --- ACES filmic tonemap ---
fn acesTonemap(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3f(0.0), vec3f(1.0));
}

// --- FXAA (Lottes) ---
fn fxaaTexel(tex: texture_2d<f32>, s: sampler, uv: vec2f, ts: vec2f) -> vec4f {
  let lumaS = luminance(textureSampleLevel(tex, s, uv + vec2f(0.0, ts.y), 0.0).rgb);
  let lumaN = luminance(textureSampleLevel(tex, s, uv - vec2f(0.0, ts.y), 0.0).rgb);
  let lumaE = luminance(textureSampleLevel(tex, s, uv + vec2f(ts.x, 0.0), 0.0).rgb);
  let lumaW = luminance(textureSampleLevel(tex, s, uv - vec2f(ts.x, 0.0), 0.0).rgb);
  let lumaM = luminance(textureSampleLevel(tex, s, uv, 0.0).rgb);

  let rangeMin = min(lumaM, min(min(lumaS, lumaN), min(lumaE, lumaW)));
  let rangeMax = max(lumaM, max(max(lumaS, lumaN), max(lumaE, lumaW)));
  let range = rangeMax - rangeMin;

  if (range < max(0.0312, rangeMax * 0.125)) {
    return textureSampleLevel(tex, s, uv, 0.0);
  }

  let dir = vec2f(
    -((lumaN + lumaS) - (lumaE + lumaW)),
    (lumaN + lumaS) + (lumaE + lumaW) - 4.0 * lumaM,
  );
  let dirReduce = max((lumaN + lumaS + lumaE + lumaW) * 0.25 * 0.25, 1.0 / 128.0);
  let rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  let d = clamp(dir * rcpDirMin, vec2f(-8.0), vec2f(8.0)) * ts;

  let a = textureSampleLevel(tex, s, uv + d * (1.0 / 3.0 - 0.5), 0.0);
  let b = textureSampleLevel(tex, s, uv + d * (2.0 / 3.0 - 0.5), 0.0);
  let rgbA = (a + b) * 0.5;
  let c = textureSampleLevel(tex, s, uv + d * -0.5, 0.0);
  let dd = textureSampleLevel(tex, s, uv + d * 0.5, 0.0);
  let rgbB = rgbA * 0.5 + (c + dd) * 0.25;

  let lumaB = luminance(rgbB.rgb);
  if (lumaB < rangeMin || lumaB > rangeMax) {
    return rgbA;
  }
  return rgbB;
}

// --- Composite: blend bloom + tonemap + FXAA ---
@fragment
fn fs_composite(in: VertexOutput) -> @location(0) vec4f {
  // Scene color (FXAA applied to scene)
  let scene = fxaaTexel(inputTex, samp, in.uv, params.texelSize);
  // Bloom contribution
  let bloom = textureSampleLevel(bloomTex, samp, in.uv, 0.0);
  // Additive blend
  var hdr = scene.rgb + bloom.rgb * params.intensity;

  // Tonemapping
  var ldr: vec3f;
  switch (params.tonemapMode) {
    case 1u: { ldr = pbrNeutralTonemap(hdr); }
    case 2u: { ldr = acesTonemap(hdr); }
    default: { ldr = clamp(hdr, vec3f(0.0), vec3f(1.0)); }
  }

  return vec4f(ldr, 1.0);
}
