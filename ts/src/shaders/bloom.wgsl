// bloom.wgsl — Dual Kawase Bloom (extract + downsample + upsample + composite)
//
// Entry points:
//   vs_main        — full-screen triangle vertex shader (shared)
//   fs_extract      — bright pixel extraction with luminance threshold
//   fs_downsample   — Kawase 4-tap downsample filter
//   fs_upsample     — Kawase 9-tap tent upsample filter
//   fs_composite    — additive bloom blend + tonemap, then FXAA over the result

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
// The same function as fxaa-tonemap.wgsl's (bloom-pass.test.ts compares them),
// so that both composites apply the same curve whenever both run mode 1. By
// default they do not: FXAATonemapPass clamps (mode 0) and this composite
// applies PBR Neutral (BloomPass default, kept on 2026-09-29), so turning bloom
// on also re-tones pixels it does not touch (the 0.067 clear becomes 0.028).
// The two FXAA variants differ at edges as well (luminance and taps).
fn pbrNeutralTonemap(color: vec3f) -> vec3f {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;

  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var c = color - offset;

  let peak = max(c.r, max(c.g, c.b));
  if (peak < startCompression) {
    return c;
  }

  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  c *= newPeak / peak;

  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(c, vec3f(newPeak), g);
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

// The composite's final colour at `uv`: scene plus its bloom contribution,
// tonemapped into display space. This is what the pixel will actually be, and
// therefore the only thing FXAA may legitimately look at.
fn resolveComposite(uv: vec2f) -> vec3f {
  let scene = textureSampleLevel(inputTex, samp, uv, 0.0).rgb;
  let bloom = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb;
  let hdr = scene + bloom * params.intensity;

  if (params.tonemapMode == 1u) {
    return pbrNeutralTonemap(hdr);
  }
  if (params.tonemapMode == 2u) {
    return acesTonemap(hdr);
  }
  return clamp(hdr, vec3f(0.0), vec3f(1.0));
}

// --- FXAA (Lottes), over the resolved composite ---
//
// This pass previously ran FXAA on the raw HDR scene, *then* added bloom, *then*
// tonemapped — so the filter was deciding where the edges were by looking at an
// image that was neither the final one nor in the range its thresholds assume.
// Bloom in particular is what creates the brightest edges in the frame, and it
// was not yet present when those edges were detected.
//
// Every tap now goes through resolveComposite(), so edge detection and blending
// both happen on the finished pixel. The cost is two texture samples per tap
// instead of one, plus a tonemap per tap: up to 18 samples and 9 tonemaps in the
// worst case, against 10 samples and 1 tonemap before.
fn fxaaComposite(uv: vec2f, ts: vec2f) -> vec3f {
  let rgbM = resolveComposite(uv);
  let rgbN = resolveComposite(uv - vec2f(0.0, ts.y));
  let rgbS = resolveComposite(uv + vec2f(0.0, ts.y));
  let rgbE = resolveComposite(uv + vec2f(ts.x, 0.0));
  let rgbW = resolveComposite(uv - vec2f(ts.x, 0.0));

  let lumaM = luminance(rgbM);
  let lumaN = luminance(rgbN);
  let lumaS = luminance(rgbS);
  let lumaE = luminance(rgbE);
  let lumaW = luminance(rgbW);

  let rangeMin = min(lumaM, min(min(lumaS, lumaN), min(lumaE, lumaW)));
  let rangeMax = max(lumaM, max(max(lumaS, lumaN), max(lumaE, lumaW)));
  let range = rangeMax - rangeMin;

  if (range < max(0.0312, rangeMax * 0.125)) {
    return rgbM;
  }

  let dir = vec2f(
    -((lumaN + lumaS) - (lumaE + lumaW)),
    (lumaN + lumaS) + (lumaE + lumaW) - 4.0 * lumaM,
  );
  let dirReduce = max((lumaN + lumaS + lumaE + lumaW) * 0.25 * 0.25, 1.0 / 128.0);
  let rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  let d = clamp(dir * rcpDirMin, vec2f(-8.0), vec2f(8.0)) * ts;

  let rgbA = (resolveComposite(uv + d * (1.0 / 3.0 - 0.5))
            + resolveComposite(uv + d * (2.0 / 3.0 - 0.5))) * 0.5;
  let rgbB = rgbA * 0.5 + (resolveComposite(uv + d * -0.5)
                         + resolveComposite(uv + d * 0.5)) * 0.25;

  let lumaB = luminance(rgbB);
  if (lumaB < rangeMin || lumaB > rangeMax) {
    return rgbA;
  }
  return rgbB;
}

// --- Composite: blend bloom + tonemap, then antialias the result ---
@fragment
fn fs_composite(in: VertexOutput) -> @location(0) vec4f {
  return vec4f(fxaaComposite(in.uv, params.texelSize), 1.0);
}
