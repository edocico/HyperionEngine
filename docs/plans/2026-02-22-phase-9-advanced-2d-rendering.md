# Phase 9: Advanced 2D Rendering — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deepen Hyperion's 2D rendering capabilities with quadratic Bézier curves, Dual Kawase bloom post-processing, and a GPU particle system.

**Architecture:** Three independent tracks. Track A fills the reserved `BezierPath = 3` primitive type with an SDF-based quadratic Bézier shader. Track B adds a self-contained bloom post-processing node to the RenderGraph (reads `scene-hdr`, writes `swapchain`, dead-culls `FXAATonemapPass`). Track C introduces a standalone GPU particle system with compute simulation that renders after the graph onto the swapchain. Bloom and outlines are mutually exclusive post-processing chains (same dead-culling pattern).

**Tech Stack:** WebGPU (WGSL shaders), TypeScript, Vitest, existing RenderGraph/ForwardPass infrastructure.

---

## Track A: Quadratic Bézier Curves (Tasks 1–5)

### Task 1: Create `bezier.wgsl` Shader

**Files:**
- Create: `ts/src/shaders/bezier.wgsl`

This shader renders quadratic Bézier curves using an analytical signed distance function (Inigo Quilez approach). The control points and stroke width are encoded in `primParams[0..6]`. The vertex shader is the standard ForwardPass vertex shader (same as `basic.wgsl`); only the fragment SDF logic differs.

**Step 1: Create the shader file**

```wgsl
// bezier.wgsl — Quadratic Bézier curve SDF rendering
//
// PrimParams layout (per entity):
//   [0] p0x  — Start point X (local space)
//   [1] p0y  — Start point Y (local space)
//   [2] p1x  — Control point X (local space)
//   [3] p1y  — Control point Y (local space)
//   [4] p2x  — End point X (local space)
//   [5] p2y  — End point Y (local space)
//   [6] width — Stroke width (local space units)
//   [7] _pad

// --- Bind Group 0 (shared with all ForwardPass shaders) ---
struct CameraUniforms { viewProjection: mat4x4f }
@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> texIndices: array<u32>;
@group(0) @binding(4) var<storage, read> renderMeta: array<u32>;
@group(0) @binding(5) var<storage, read> primParams: array<f32>;

// --- Bind Group 1 (texture tiers + sampler — unused for Bézier but required for layout compat) ---
@group(1) @binding(0) var tier0: texture_2d_array<f32>;
@group(1) @binding(1) var tier1: texture_2d_array<f32>;
@group(1) @binding(2) var tier2: texture_2d_array<f32>;
@group(1) @binding(3) var tier3: texture_2d_array<f32>;
@group(1) @binding(4) var texSampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) entityIndex: u32,
}

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let idx = visibleIndices[instanceIndex];
  let model = transforms[idx];

  // Unit quad corners
  let corners = array<vec2f, 4>(
    vec2f(-0.5, -0.5), vec2f(0.5, -0.5),
    vec2f(-0.5,  0.5), vec2f(0.5,  0.5),
  );
  let corner = corners[vertexIndex % 4u];

  let worldPos = model * vec4f(corner, 0.0, 1.0);
  var out: VertexOutput;
  out.position = camera.viewProjection * worldPos;
  out.uv = corner + vec2f(0.5); // [0,1] range
  out.entityIndex = idx;
  return out;
}

// --- Quadratic Bézier SDF (Inigo Quilez) ---
fn sdBezier(pos: vec2f, A: vec2f, B: vec2f, C: vec2f) -> f32 {
  let a = B - A;
  let b = A - 2.0 * B + C;
  let c = a * 2.0;
  let d = A - pos;

  let kk = 1.0 / dot(b, b);
  let kx = kk * dot(a, b);
  let ky = kk * (2.0 * dot(a, a) + dot(d, b)) / 3.0;
  let kz = kk * dot(d, a);

  let p = ky - kx * kx;
  let q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
  let p3 = p * p * p;
  var h = q * q + 4.0 * p3;

  if (h >= 0.0) {
    h = sqrt(h);
    let x = (vec2f(h, -h) - vec2f(q)) * 0.5;
    let uv_roots = sign(x) * pow(abs(x), vec2f(1.0 / 3.0));
    let t = clamp(uv_roots.x + uv_roots.y - kx, 0.0, 1.0);
    let qp = d + (c + b * t) * t;
    return length(qp);
  }

  let z = sqrt(-p);
  let v = acos(q / (p * z * 2.0)) / 3.0;
  let m = cos(v);
  let n = sin(v) * 1.732050808; // sqrt(3)
  let t3 = clamp(vec3f(m + m, -n - m, n - m) * z - vec3f(kx), vec3f(0.0), vec3f(1.0));

  let qx = d + (c + b * t3.x) * t3.x;
  let qy = d + (c + b * t3.y) * t3.y;
  return sqrt(min(dot(qx, qx), dot(qy, qy)));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  let idx = in.entityIndex;
  let base = idx * 8u;

  let p0 = vec2f(primParams[base + 0u], primParams[base + 1u]);
  let p1 = vec2f(primParams[base + 2u], primParams[base + 3u]);
  let p2 = vec2f(primParams[base + 4u], primParams[base + 5u]);
  let strokeWidth = primParams[base + 6u];

  let dist = sdBezier(in.uv, p0, p1, p2);
  let halfW = strokeWidth * 0.5;
  let edge = fwidth(dist);
  let alpha = 1.0 - smoothstep(halfW - edge, halfW + edge, dist);

  if (alpha < 0.01) { discard; }

  // Sample color from texture tier 0 (solid color via 1x1 texture)
  let texInfo = texIndices[idx];
  let tier = texInfo >> 16u;
  let layer = texInfo & 0xFFFFu;
  var color: vec4f;
  switch (tier) {
    case 0u: { color = textureSample(tier0, texSampler, in.uv, layer); }
    case 1u: { color = textureSample(tier1, texSampler, in.uv, layer); }
    case 2u: { color = textureSample(tier2, texSampler, in.uv, layer); }
    case 3u: { color = textureSample(tier3, texSampler, in.uv, layer); }
    default: { color = vec4f(1.0); }
  }

  return vec4f(color.rgb, color.a * alpha);
}
```

**Step 2: Verify file exists**

Run: `ls ts/src/shaders/bezier.wgsl`
Expected: File listed.

---

### Task 2: `EntityHandle.bezier()` — Test + Implement

**Files:**
- Modify: `ts/src/entity-handle.test.ts` (add tests after line 258)
- Modify: `ts/src/entity-handle.ts` (add method after line 178)

**Step 1: Write the failing test**

Add to `ts/src/entity-handle.test.ts` inside the `'primitive params'` describe block (after the `boxShadow()` test):

```typescript
    it('bezier() sets render primitive and params', () => {
      const p = mockProducer();
      const h = new EntityHandle(1, p);
      const result = h.bezier(0.1, 0.2, 0.5, 0.8, 0.9, 0.3, 0.05);
      expect(result).toBe(h);
      expect(p.setRenderPrimitive).toHaveBeenCalledWith(1, 3); // BezierPath = 3
      expect(p.setPrimParams0).toHaveBeenCalledWith(1, 0.1, 0.2, 0.5, 0.8);
      expect(p.setPrimParams1).toHaveBeenCalledWith(1, 0.9, 0.3, 0.05, 0);
    });

    it('bezier() throws after destroy', () => {
      const p = mockProducer();
      const h = new EntityHandle(1, p);
      h.destroy();
      expect(() => h.bezier(0, 0, 0.5, 0.5, 1, 1, 0.02)).toThrow('destroyed');
    });
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: FAIL — `h.bezier is not a function`

**Step 3: Write minimal implementation**

Add to `ts/src/entity-handle.ts` after the `boxShadow()` method (after line 178):

```typescript
  /**
   * Configure this entity as a quadratic Bézier curve.
   * Control points are in local space (relative to entity position/scale).
   * @param p0x - Start point X
   * @param p0y - Start point Y
   * @param p1x - Control point X
   * @param p1y - Control point Y
   * @param p2x - End point X
   * @param p2y - End point Y
   * @param width - Stroke width (local space units)
   */
  bezier(p0x: number, p0y: number, p1x: number, p1y: number,
         p2x: number, p2y: number, width: number): this {
    this.check();
    this._producer!.setRenderPrimitive(this._id, RenderPrimitiveType.BezierPath);
    this._producer!.setPrimParams0(this._id, p0x, p0y, p1x, p1y);
    this._producer!.setPrimParams1(this._id, p2x, p2y, width, 0);
    return this;
  }
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/entity-handle.ts ts/src/entity-handle.test.ts ts/src/shaders/bezier.wgsl
git commit -m "$(cat <<'EOF'
feat(phase9): add quadratic Bézier curve primitive

Adds bezier.wgsl shader with analytical quadratic Bézier SDF (Inigo
Quilez algorithm) and EntityHandle.bezier() convenience method.
Fills the reserved RenderPrimitiveType.BezierPath = 3 slot.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Register Bézier Shader in Renderer + ForwardPass

**Files:**
- Modify: `ts/src/renderer.ts` (lines 1, 137, 310)

**Step 1: Add shader import**

At the top of `ts/src/renderer.ts` (after line 5):

```typescript
import bezierShaderCode from './shaders/bezier.wgsl?raw';
```

**Step 2: Register in SHADER_SOURCES**

In the `ForwardPass.SHADER_SOURCES` assignment (after line 142):

```typescript
    3: bezierShaderCode,        // BezierPath (quadratic Bézier SDF)
```

**Step 3: Add recompileShader case**

In the `recompileShader` switch (after the `'msdf-text'` case around line 312):

```typescript
        case 'bezier':
          ForwardPass.SHADER_SOURCES[3] = shaderCode;
          break;
```

**Step 4: Verify build**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors.

---

### Task 4: Add Vite HMR for `bezier.wgsl`

**Files:**
- Modify: `ts/src/renderer.ts` (HMR section, after line 458)

**Step 1: Add HMR accept entry**

After the `box-shadow.wgsl` HMR entry (around line 458):

```typescript
    import.meta.hot.accept('./shaders/bezier.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('bezier', mod.default);
    });
```

**Step 2: Verify build**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors.

---

### Task 5: Commit Bézier Renderer Integration

```bash
git add ts/src/renderer.ts
git commit -m "$(cat <<'EOF'
feat(phase9): register Bézier shader in renderer + HMR

Adds bezier shader to ForwardPass.SHADER_SOURCES[3], recompileShader
support, and Vite HMR wiring.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Track B: Bloom Post-Processing (Tasks 6–14)

The bloom implementation follows the Dual Kawase algorithm:
1. **Extract** bright pixels from `scene-hdr` (luminance threshold)
2. **Downsample** through 3 mip levels (half → quarter → eighth)
3. **Upsample** back through 2 levels (eighth → quarter → half)
4. **Composite** bloom result with scene + tonemapping + FXAA

All 6 GPU operations run inside a single `BloomPass.execute()`. The pass declares `reads: ['scene-hdr'], writes: ['swapchain']`, dead-culling `FXAATonemapPass` when active. Intermediate bloom textures are managed by the renderer coordinator in `ResourcePool`.

**Bloom is mutually exclusive with outline post-processing** (same dead-culling pattern). `enableBloom()` disables outlines and vice versa.

### Task 6: Create `bloom.wgsl` Shader

**Files:**
- Create: `ts/src/shaders/bloom.wgsl`

Contains one vertex shader and four fragment shaders for the bloom pipeline stages.

**Step 1: Create the shader file**

```wgsl
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
  let color = textureSample(inputTex, samp, in.uv);
  let lum = luminance(color.rgb);
  let contrib = max(lum - params.threshold, 0.0);
  let scale = contrib / max(lum, 0.001);
  return vec4f(color.rgb * scale, 1.0);
}

// --- Kawase Downsample (4-tap, half-texel offset) ---
@fragment
fn fs_downsample(in: VertexOutput) -> @location(0) vec4f {
  let o = params.texelSize * 0.5;
  var color = textureSample(inputTex, samp, in.uv) * 4.0;
  color += textureSample(inputTex, samp, in.uv + vec2f(-o.x, -o.y));
  color += textureSample(inputTex, samp, in.uv + vec2f( o.x, -o.y));
  color += textureSample(inputTex, samp, in.uv + vec2f(-o.x,  o.y));
  color += textureSample(inputTex, samp, in.uv + vec2f( o.x,  o.y));
  return color / 8.0;
}

// --- Kawase Upsample (9-tap tent filter) ---
@fragment
fn fs_upsample(in: VertexOutput) -> @location(0) vec4f {
  let o = params.texelSize;
  var color = textureSample(inputTex, samp, in.uv + vec2f(-o.x, -o.y));
  color += textureSample(inputTex, samp, in.uv + vec2f( 0.0, -o.y)) * 2.0;
  color += textureSample(inputTex, samp, in.uv + vec2f( o.x, -o.y));
  color += textureSample(inputTex, samp, in.uv + vec2f(-o.x,  0.0)) * 2.0;
  color += textureSample(inputTex, samp, in.uv) * 4.0;
  color += textureSample(inputTex, samp, in.uv + vec2f( o.x,  0.0)) * 2.0;
  color += textureSample(inputTex, samp, in.uv + vec2f(-o.x,  o.y));
  color += textureSample(inputTex, samp, in.uv + vec2f( 0.0,  o.y)) * 2.0;
  color += textureSample(inputTex, samp, in.uv + vec2f( o.x,  o.y));
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
  let lumaS = luminance(textureSample(tex, s, uv + vec2f(0.0, ts.y)).rgb);
  let lumaN = luminance(textureSample(tex, s, uv - vec2f(0.0, ts.y)).rgb);
  let lumaE = luminance(textureSample(tex, s, uv + vec2f(ts.x, 0.0)).rgb);
  let lumaW = luminance(textureSample(tex, s, uv - vec2f(ts.x, 0.0)).rgb);
  let lumaM = luminance(textureSample(tex, s, uv).rgb);

  let rangeMin = min(lumaM, min(min(lumaS, lumaN), min(lumaE, lumaW)));
  let rangeMax = max(lumaM, max(max(lumaS, lumaN), max(lumaE, lumaW)));
  let range = rangeMax - rangeMin;

  if (range < max(0.0312, rangeMax * 0.125)) {
    return textureSample(tex, s, uv);
  }

  let dir = vec2f(
    -((lumaN + lumaS) - (lumaE + lumaW)),
    (lumaN + lumaS) + (lumaE + lumaW) - 4.0 * lumaM,
  );
  let dirReduce = max((lumaN + lumaS + lumaE + lumaW) * 0.25 * 0.25, 1.0 / 128.0);
  let rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  let d = clamp(dir * rcpDirMin, vec2f(-8.0), vec2f(8.0)) * ts;

  let a = textureSample(tex, s, uv + d * (1.0 / 3.0 - 0.5));
  let b = textureSample(tex, s, uv + d * (2.0 / 3.0 - 0.5));
  let rgbA = (a + b) * 0.5;
  let c = textureSample(tex, s, uv + d * -0.5);
  let dd = textureSample(tex, s, uv + d * 0.5);
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
  let bloom = textureSample(bloomTex, samp, in.uv);
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
```

**Step 2: Verify file exists**

Run: `ls ts/src/shaders/bloom.wgsl`
Expected: File listed.

---

### Task 7: BloomPass Class — Construction + Setup Test

**Files:**
- Create: `ts/src/render/passes/bloom-pass.test.ts`
- Create: `ts/src/render/passes/bloom-pass.ts`

**Step 1: Write the failing test**

```typescript
// bloom-pass.test.ts
import { describe, it, expect } from 'vitest';
import { BloomPass } from './bloom-pass';

describe('BloomPass', () => {
  it('should be optional (dead-pass culled when unused)', () => {
    const pass = new BloomPass();
    expect(pass.optional).toBe(true);
  });

  it('should read scene-hdr and write swapchain', () => {
    const pass = new BloomPass();
    expect(pass.reads).toContain('scene-hdr');
    expect(pass.writes).toContain('swapchain');
  });

  it('should have name "bloom"', () => {
    const pass = new BloomPass();
    expect(pass.name).toBe('bloom');
  });

  it('should accept configuration', () => {
    const pass = new BloomPass({ threshold: 0.5, intensity: 1.5, levels: 2 });
    expect(pass.threshold).toBe(0.5);
    expect(pass.intensity).toBe(1.5);
  });

  it('should use sensible defaults', () => {
    const pass = new BloomPass();
    expect(pass.threshold).toBe(0.7);
    expect(pass.intensity).toBe(1.0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/render/passes/bloom-pass.test.ts`
Expected: FAIL — `Cannot find module './bloom-pass'`

**Step 3: Write minimal implementation**

```typescript
// bloom-pass.ts
import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';

export interface BloomConfig {
  threshold?: number;
  intensity?: number;
  levels?: number;       // mip levels for blur chain (2 or 3)
  tonemapMode?: number;  // 0=none, 1=PBR Neutral, 2=ACES
}

export class BloomPass implements RenderPass {
  static SHADER_SOURCE = '';

  readonly name = 'bloom';
  readonly reads = ['scene-hdr'];
  readonly writes = ['swapchain'];
  readonly optional = true;

  threshold: number;
  intensity: number;
  levels: number;
  tonemapMode: number;

  private extractPipeline: GPURenderPipeline | null = null;
  private downsamplePipeline: GPURenderPipeline | null = null;
  private upsamplePipeline: GPURenderPipeline | null = null;
  private compositePipeline: GPURenderPipeline | null = null;
  private paramBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;

  constructor(config?: BloomConfig) {
    this.threshold = config?.threshold ?? 0.7;
    this.intensity = config?.intensity ?? 1.0;
    this.levels = config?.levels ?? 3;
    this.tonemapMode = config?.tonemapMode ?? 1; // PBR Neutral
  }

  setup(device: GPUDevice, _resources: ResourcePool): void {
    const module = device.createShaderModule({ code: BloomPass.SHADER_SOURCE });
    const format = navigator.gpu.getPreferredCanvasFormat();

    // Bind group layout: params uniform + input texture + bloom texture + sampler
    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const vertex = { module, entryPoint: 'vs_main' };

    // Intermediate passes use bgra8unorm format (same as swapchain)
    const makeFragPipeline = (entryPoint: string, targetFormat: GPUTextureFormat = format) =>
      device.createRenderPipeline({
        layout,
        vertex,
        fragment: {
          module,
          entryPoint,
          targets: [{ format: targetFormat }],
        },
        primitive: { topology: 'triangle-list' },
      });

    this.extractPipeline = makeFragPipeline('fs_extract');
    this.downsamplePipeline = makeFragPipeline('fs_downsample');
    this.upsamplePipeline = makeFragPipeline('fs_upsample');
    this.compositePipeline = makeFragPipeline('fs_composite');

    this.paramBuffer = device.createBuffer({
      size: 32, // BloomParams: vec2f + f32 + f32 + u32 + 3 × u32 padding
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  execute(
    device: GPUDevice,
    _frame: FrameState,
    resources: ResourcePool,
    encoder: GPUCommandEncoder,
  ): void {
    // Implementation in Task 9-10
    void device; void resources; void encoder;
  }

  destroy(): void {
    this.paramBuffer?.destroy();
    this.extractPipeline = null;
    this.downsamplePipeline = null;
    this.upsamplePipeline = null;
    this.compositePipeline = null;
    this.paramBuffer = null;
    this.sampler = null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/render/passes/bloom-pass.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/shaders/bloom.wgsl ts/src/render/passes/bloom-pass.ts ts/src/render/passes/bloom-pass.test.ts
git commit -m "$(cat <<'EOF'
feat(phase9): add BloomPass skeleton with Dual Kawase shader

Adds bloom.wgsl with 4 fragment entry points (extract, downsample,
upsample, composite) and BloomPass class with construction + setup.
Execute is stubbed — full implementation follows.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: BloomPass Execute — Full Blur Chain

**Files:**
- Modify: `ts/src/render/passes/bloom-pass.ts` (replace `execute()`)
- Modify: `ts/src/render/passes/bloom-pass.test.ts` (add execute test)

**Step 1: Write the failing test**

Add to `bloom-pass.test.ts`:

```typescript
  it('execute() should not throw with valid resources', () => {
    const pass = new BloomPass();
    // We can't fully test GPU operations in headless environment,
    // but we can verify the method exists and the config is applied
    expect(typeof pass.execute).toBe('function');
  });

  it('setTonemapMode updates the mode', () => {
    const pass = new BloomPass();
    pass.tonemapMode = 2; // ACES
    expect(pass.tonemapMode).toBe(2);
  });
```

**Step 2: Run test to verify it passes** (these are non-GPU tests)

Run: `cd ts && npx vitest run src/render/passes/bloom-pass.test.ts`
Expected: ALL PASS

**Step 3: Implement the full execute method**

Replace the stub `execute()` in `bloom-pass.ts` with the full implementation. The key logic:

```typescript
  execute(
    device: GPUDevice,
    _frame: FrameState,
    resources: ResourcePool,
    encoder: GPUCommandEncoder,
  ): void {
    if (!this.extractPipeline || !this.paramBuffer || !this.sampler) return;

    const sceneView = resources.getTextureView('scene-hdr')!;
    const swapchainView = resources.getTextureView('swapchain')!;
    const bloomHalfView = resources.getTextureView('bloom-half')!;
    const bloomQuarterView = resources.getTextureView('bloom-quarter')!;
    const bloomEighthView = resources.getTextureView('bloom-eighth')!;

    // Dummy view for unused bloom texture binding (extract/downsample/upsample don't use it)
    const dummyView = bloomEighthView;

    const runPass = (
      pipeline: GPURenderPipeline,
      inputView: GPUTextureView,
      bloomView: GPUTextureView,
      outputView: GPUTextureView,
      texelW: number,
      texelH: number,
    ) => {
      const paramData = new ArrayBuffer(32);
      const f32 = new Float32Array(paramData);
      const u32 = new Uint32Array(paramData);
      f32[0] = texelW;
      f32[1] = texelH;
      f32[2] = this.threshold;
      f32[3] = this.intensity;
      u32[4] = this.tonemapMode;
      device.queue.writeBuffer(this.paramBuffer!, 0, paramData);

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.paramBuffer! } },
          { binding: 1, resource: inputView },
          { binding: 2, resource: bloomView },
          { binding: 3, resource: this.sampler! },
        ],
      });

      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: outputView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3); // full-screen triangle
      pass.end();
    };

    const w = _frame.canvasWidth;
    const h = _frame.canvasHeight;

    // 1. Extract: scene-hdr → bloom-half
    runPass(this.extractPipeline!, sceneView, dummyView, bloomHalfView,
            1.0 / (w / 2), 1.0 / (h / 2));

    // 2. Downsample: bloom-half → bloom-quarter
    runPass(this.downsamplePipeline!, bloomHalfView, dummyView, bloomQuarterView,
            1.0 / (w / 4), 1.0 / (h / 4));

    // 3. Downsample: bloom-quarter → bloom-eighth
    runPass(this.downsamplePipeline!, bloomQuarterView, dummyView, bloomEighthView,
            1.0 / (w / 8), 1.0 / (h / 8));

    // 4. Upsample: bloom-eighth → bloom-quarter (overwrite)
    runPass(this.upsamplePipeline!, bloomEighthView, dummyView, bloomQuarterView,
            1.0 / (w / 4), 1.0 / (h / 4));

    // 5. Upsample: bloom-quarter → bloom-half (overwrite)
    runPass(this.upsamplePipeline!, bloomQuarterView, dummyView, bloomHalfView,
            1.0 / (w / 2), 1.0 / (h / 2));

    // 6. Composite: scene-hdr + bloom-half → swapchain
    runPass(this.compositePipeline!, sceneView, bloomHalfView, swapchainView,
            1.0 / w, 1.0 / h);
  }
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/render/passes/bloom-pass.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/render/passes/bloom-pass.ts ts/src/render/passes/bloom-pass.test.ts
git commit -m "$(cat <<'EOF'
feat(phase9): implement BloomPass execute with 3-level blur chain

6 GPU operations: extract → 2× downsample → 2× upsample → composite.
Composite includes PBR Neutral tonemapping + FXAA. Intermediate textures
(bloom-half, bloom-quarter, bloom-eighth) read from ResourcePool.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Renderer Bloom Wiring — `enableBloom` / `disableBloom`

**Files:**
- Modify: `ts/src/renderer.ts` (add bloom import, bloom textures, enableBloom/disableBloom, rebuildGraph changes)

**Step 1: Add imports and types**

At the top of `renderer.ts`, add the import:

```typescript
import { BloomPass } from './render/passes/bloom-pass';
import type { BloomConfig } from './render/passes/bloom-pass';
import bloomShaderCode from './shaders/bloom.wgsl?raw';
```

Extend the `Renderer` interface:

```typescript
export interface BloomOptions {
  threshold?: number;
  intensity?: number;
  tonemapMode?: number;
}

export interface Renderer {
  // ... existing methods ...
  enableBloom(options?: BloomOptions): void;
  disableBloom(): void;
  readonly bloomEnabled: boolean;
}
```

**Step 2: Add bloom state and textures in `createRenderer()`**

After the JFA texture variables (around line 165), add:

```typescript
  let bloomActive = false;
  let bloomPass: BloomPass | null = null;
  let bloomHalfTexture: GPUTexture | null = null;
  let bloomQuarterTexture: GPUTexture | null = null;
  let bloomEighthTexture: GPUTexture | null = null;

  function ensureBloomTextures(w: number, h: number): void {
    bloomHalfTexture?.destroy();
    bloomQuarterTexture?.destroy();
    bloomEighthTexture?.destroy();

    const fmt = format; // same as canvas format (bgra8unorm)
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;

    bloomHalfTexture = device.createTexture({
      size: { width: Math.max(1, w >> 1), height: Math.max(1, h >> 1) },
      format: fmt, usage,
    });
    bloomQuarterTexture = device.createTexture({
      size: { width: Math.max(1, w >> 2), height: Math.max(1, h >> 2) },
      format: fmt, usage,
    });
    bloomEighthTexture = device.createTexture({
      size: { width: Math.max(1, w >> 3), height: Math.max(1, h >> 3) },
      format: fmt, usage,
    });

    resources.setTextureView('bloom-half', bloomHalfTexture.createView());
    resources.setTextureView('bloom-quarter', bloomQuarterTexture.createView());
    resources.setTextureView('bloom-eighth', bloomEighthTexture.createView());
  }
```

**Step 3: Update `rebuildGraph()` to support bloom**

Change `rebuildGraph` signature to accept bloom state. After the outline chain and before adding FXAATonemapPass:

```typescript
  function rebuildGraph(withOutlines: boolean, options?: OutlineOptions): void {
    graph.destroy();
    jfaPasses = [];
    selectionSeedPass = null;
    outlineCompositePass = null;
    bloomPass = null;

    const newCullPass = new CullPass();
    const newForwardPass = new ForwardPass();
    newCullPass.setup(device, resources);
    newForwardPass.setup(device, resources);

    graph = new RenderGraph();
    graph.addPass(newCullPass);
    graph.addPass(newForwardPass);

    if (bloomActive && !withOutlines) {
      // Bloom is mutually exclusive with outlines
      ensureBloomTextures(canvas.width, canvas.height);
      BloomPass.SHADER_SOURCE = bloomShaderCode;
      bloomPass = new BloomPass({
        threshold: bloomOptions?.threshold,
        intensity: bloomOptions?.intensity,
        tonemapMode: bloomOptions?.tonemapMode,
      });
      bloomPass.setup(device, resources);
      graph.addPass(bloomPass);
    }

    if (withOutlines) {
      // ... existing outline setup (unchanged) ...
    }

    const newFxaaPass = new FXAATonemapPass();
    newFxaaPass.setup(device, resources);
    graph.addPass(newFxaaPass);

    graph.compile();
  }
```

**Step 4: Add `enableBloom` / `disableBloom` to the renderer object**

```typescript
    enableBloom(options?: BloomOptions): void {
      if (bloomActive && bloomPass) {
        // Just update parameters without rebuilding
        if (options?.threshold !== undefined) bloomPass.threshold = options.threshold;
        if (options?.intensity !== undefined) bloomPass.intensity = options.intensity;
        if (options?.tonemapMode !== undefined) bloomPass.tonemapMode = options.tonemapMode;
        return;
      }
      bloomActive = true;
      bloomOptions = options;
      if (outlinesActive) {
        console.warn('[Hyperion] Bloom enabled — outlines disabled (mutually exclusive)');
        outlinesActive = false;
      }
      rebuildGraph(false);
    },

    disableBloom(): void {
      if (!bloomActive) return;
      bloomActive = false;
      bloomOptions = undefined;
      rebuildGraph(outlinesActive);
    },

    get bloomEnabled(): boolean {
      return bloomActive;
    },
```

Also update `enableOutlines` to disable bloom:

```typescript
    enableOutlines(options: OutlineOptions): void {
      // ... existing check ...
      if (bloomActive) {
        console.warn('[Hyperion] Outlines enabled — bloom disabled (mutually exclusive)');
        bloomActive = false;
        bloomOptions = undefined;
      }
      outlinesActive = true;
      rebuildGraph(true, options);
    },
```

**Step 5: Add bloom textures to destroy()**

```typescript
    destroy() {
      bloomHalfTexture?.destroy();
      bloomQuarterTexture?.destroy();
      bloomEighthTexture?.destroy();
      // ... existing destroy ...
    },
```

**Step 6: Verify type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors.

**Step 7: Commit**

```bash
git add ts/src/renderer.ts
git commit -m "$(cat <<'EOF'
feat(phase9): wire bloom into renderer with enable/disable API

Adds bloom texture management, rebuildGraph bloom integration,
enableBloom/disableBloom methods. Bloom and outlines are mutually
exclusive — enabling one disables the other with console warning.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Hyperion Bloom Facade — Test + Implement

**Files:**
- Modify: `ts/src/hyperion.test.ts` (add bloom tests)
- Modify: `ts/src/hyperion.ts` (add enableBloom/disableBloom)

**Step 1: Write the failing test**

Add to `hyperion.test.ts` in the main describe block:

```typescript
  describe('bloom', () => {
    it('enableBloom delegates to renderer', () => {
      const renderer = {
        enableBloom: vi.fn(),
        disableBloom: vi.fn(),
        // ... existing mock properties ...
      };
      // Use fromParts with the mock renderer
      const engine = Hyperion.fromParts({ renderer, /* other parts */ });
      engine.enableBloom({ threshold: 0.5, intensity: 1.2 });
      expect(renderer.enableBloom).toHaveBeenCalledWith({ threshold: 0.5, intensity: 1.2 });
    });

    it('disableBloom delegates to renderer', () => {
      const renderer = {
        enableBloom: vi.fn(),
        disableBloom: vi.fn(),
        // ... existing mock properties ...
      };
      const engine = Hyperion.fromParts({ renderer, /* other parts */ });
      engine.disableBloom();
      expect(renderer.disableBloom).toHaveBeenCalled();
    });

    it('enableBloom throws when no renderer', () => {
      // Engine without renderer (headless mode)
      const engine = Hyperion.fromParts({ renderer: null, /* other parts */ });
      expect(() => engine.enableBloom()).toThrow('no renderer');
    });
  });
```

> **Note:** Adapt the test to match the exact `fromParts` signature and mock renderer shape in `hyperion.test.ts`. Reference existing `enableOutlines` tests for the pattern.

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `engine.enableBloom is not a function`

**Step 3: Implement on Hyperion class**

Add to `hyperion.ts` after `disableOutlines()`:

```typescript
  /**
   * Enable Dual Kawase bloom post-processing.
   * Mutually exclusive with outlines — enabling bloom disables outlines.
   */
  enableBloom(options?: BloomOptions): void {
    this.checkDestroyed();
    if (!this.renderer) throw new Error('Cannot enable bloom: no renderer available');
    this.renderer.enableBloom(options);
  }

  /** Disable bloom post-processing. */
  disableBloom(): void {
    this.checkDestroyed();
    this.renderer?.disableBloom();
  }
```

Also add the import for `BloomOptions` from `renderer.ts`.

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "$(cat <<'EOF'
feat(phase9): add enableBloom/disableBloom to Hyperion facade

Delegates to renderer. Throws when no renderer available (headless).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Bloom HMR + `recompileShader` Support

**Files:**
- Modify: `ts/src/renderer.ts` (add bloom case to recompileShader + HMR entry)

**Step 1: Add recompileShader case**

In the `recompileShader` switch (around the `'outline-composite'` case):

```typescript
        case 'bloom':
          BloomPass.SHADER_SOURCE = shaderCode;
          break;
```

**Step 2: Add HMR entry**

After the existing HMR entries:

```typescript
    import.meta.hot.accept('./shaders/bloom.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('bloom', mod.default);
    });
```

**Step 3: Verify build**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors.

**Step 4: Commit**

```bash
git add ts/src/renderer.ts
git commit -m "$(cat <<'EOF'
feat(phase9): add bloom shader hot-reload support

Adds 'bloom' case to recompileShader and Vite HMR wiring.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Track C: GPU Particle System (Tasks 12–24)

The particle system is standalone — it does NOT use the ECS entity pipeline. Particles live entirely on the GPU:
- **Emitter** = an entity ID whose position is read from `GPURenderState`
- **Particles** = GPU storage buffer managed by a compute shader
- **Rendering** = happens AFTER the RenderGraph, drawn on top of the swapchain

This avoids ring buffer saturation (thousands of particles would flood the SPSC buffer) and enables GPU-native simulation at 60fps.

### Task 12: Particle Types — Test + Implement

**Files:**
- Create: `ts/src/particle-types.ts`
- Create: `ts/src/particle-types.test.ts`

**Step 1: Write the failing test**

```typescript
// particle-types.test.ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PARTICLE_CONFIG,
  type ParticleEmitterConfig,
  type ParticleHandle,
} from './particle-types';

describe('Particle Types', () => {
  it('DEFAULT_PARTICLE_CONFIG has sensible defaults', () => {
    const cfg = DEFAULT_PARTICLE_CONFIG;
    expect(cfg.maxParticles).toBe(1000);
    expect(cfg.emissionRate).toBe(100);
    expect(cfg.lifetime).toEqual([0.5, 2.0]);
    expect(cfg.gravity).toEqual([0, 0]);
  });

  it('ParticleEmitterConfig is structurally typed', () => {
    const cfg: ParticleEmitterConfig = {
      maxParticles: 500,
      emissionRate: 50,
      lifetime: [1, 3],
      velocityMin: [-10, -10],
      velocityMax: [10, 10],
      colorStart: [1, 0.5, 0, 1],
      colorEnd: [1, 0, 0, 0],
      sizeStart: 4,
      sizeEnd: 0,
      gravity: [0, -50],
    };
    expect(cfg.maxParticles).toBe(500);
  });

  it('ParticleHandle is a branded number', () => {
    const handle = 42 as ParticleHandle;
    expect(handle).toBe(42);
    // Branded type ensures type safety at compile time
    expect(typeof handle).toBe('number');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/particle-types.test.ts`
Expected: FAIL — `Cannot find module './particle-types'`

**Step 3: Implement**

```typescript
// particle-types.ts

/** Branded handle for particle emitters (compile-time safety, zero runtime cost). */
export type ParticleHandle = number & { readonly __brand: 'ParticleHandle' };

/** Configuration for a particle emitter. */
export interface ParticleEmitterConfig {
  /** Maximum alive particles for this emitter. Default: 1000. */
  maxParticles: number;
  /** Particles spawned per second. Default: 100. */
  emissionRate: number;
  /** [min, max] lifetime in seconds. Default: [0.5, 2.0]. */
  lifetime: [number, number];
  /** Minimum initial velocity [vx, vy]. Default: [-20, -20]. */
  velocityMin: [number, number];
  /** Maximum initial velocity [vx, vy]. Default: [20, 20]. */
  velocityMax: [number, number];
  /** Start color RGBA (0-1). Default: [1, 1, 1, 1]. */
  colorStart: [number, number, number, number];
  /** End color RGBA (0-1). Default: [1, 1, 1, 0]. */
  colorEnd: [number, number, number, number];
  /** Start size in pixels. Default: 4. */
  sizeStart: number;
  /** End size in pixels. Default: 0. */
  sizeEnd: number;
  /** Gravity [gx, gy] in units/s². Default: [0, 0]. */
  gravity: [number, number];
}

/** Sensible defaults for particle emitters. */
export const DEFAULT_PARTICLE_CONFIG: ParticleEmitterConfig = {
  maxParticles: 1000,
  emissionRate: 100,
  lifetime: [0.5, 2.0],
  velocityMin: [-20, -20],
  velocityMax: [20, 20],
  colorStart: [1, 1, 1, 1],
  colorEnd: [1, 1, 1, 0],
  sizeStart: 4,
  sizeEnd: 0,
  gravity: [0, 0],
};

/**
 * GPU particle struct layout (48 bytes per particle):
 *   position: vec2f   (8 bytes)
 *   velocity: vec2f   (8 bytes)
 *   color:    vec4f   (16 bytes)
 *   lifetime: f32     (4 bytes)
 *   age:      f32     (4 bytes)
 *   size:     f32     (4 bytes)
 *   _pad:     f32     (4 bytes)
 */
export const PARTICLE_STRIDE_FLOATS = 12;
export const PARTICLE_STRIDE_BYTES = PARTICLE_STRIDE_FLOATS * 4; // 48 bytes
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/particle-types.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/particle-types.ts ts/src/particle-types.test.ts
git commit -m "$(cat <<'EOF'
feat(phase9): add particle type definitions

ParticleHandle branded type, ParticleEmitterConfig interface,
DEFAULT_PARTICLE_CONFIG, GPU particle struct layout (48 bytes/particle).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Create `particle-simulate.wgsl` Compute Shader

**Files:**
- Create: `ts/src/shaders/particle-simulate.wgsl`

**Step 1: Create the shader file**

```wgsl
// particle-simulate.wgsl — GPU particle simulation compute shader
//
// Each particle: position(2f), velocity(2f), color(4f), lifetime(f), age(f), size(f), pad(f)
// Total: 12 f32 = 48 bytes per particle

struct Particle {
  position: vec2f,
  velocity: vec2f,
  color: vec4f,
  lifetime: f32,
  age: f32,
  size: f32,
  _pad: f32,
}

struct EmitterConfig {
  emitterPos: vec2f,      // world position of emitter
  dt: f32,                // frame delta time
  emissionRate: f32,      // particles per second
  lifetimeMin: f32,
  lifetimeMax: f32,
  velocityMinX: f32,
  velocityMinY: f32,
  velocityMaxX: f32,
  velocityMaxY: f32,
  colorStartR: f32,
  colorStartG: f32,
  colorStartB: f32,
  colorStartA: f32,
  colorEndR: f32,
  colorEndG: f32,
  colorEndB: f32,
  colorEndA: f32,
  sizeStart: f32,
  sizeEnd: f32,
  gravityX: f32,
  gravityY: f32,
  maxParticles: u32,
  spawnCount: u32,        // how many to spawn this frame
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> config: EmitterConfig;
@group(0) @binding(2) var<storage, read_write> counter: array<atomic<u32>>;
// counter[0] = alive count (for rendering)
// counter[1] = next free slot (for spawning)

// PCG hash for randomness
fn pcg_hash(input: u32) -> u32 {
  var state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand_f32(seed: u32) -> f32 {
  return f32(pcg_hash(seed)) / 4294967295.0;
}

fn rand_range(seed: u32, lo: f32, hi: f32) -> f32 {
  return lo + rand_f32(seed) * (hi - lo);
}

@compute @workgroup_size(64)
fn simulate(@builtin(global_invocation_id) id: vec3u) {
  let idx = id.x;
  if (idx >= config.maxParticles) { return; }

  var p = particles[idx];

  // Dead particle — skip
  if (p.age >= p.lifetime && p.lifetime > 0.0) { return; }
  // Uninitialized particle (lifetime == 0) — skip
  if (p.lifetime <= 0.0) { return; }

  // Simulate
  p.age += config.dt;

  // Kill check
  if (p.age >= p.lifetime) {
    particles[idx] = p;
    return;
  }

  // Physics
  p.velocity += vec2f(config.gravityX, config.gravityY) * config.dt;
  p.position += p.velocity * config.dt;

  // Interpolate color and size
  let t = clamp(p.age / p.lifetime, 0.0, 1.0);
  p.color = mix(
    vec4f(config.colorStartR, config.colorStartG, config.colorStartB, config.colorStartA),
    vec4f(config.colorEndR, config.colorEndG, config.colorEndB, config.colorEndA),
    t,
  );
  p.size = mix(config.sizeStart, config.sizeEnd, t);

  particles[idx] = p;

  // Count alive for rendering
  atomicAdd(&counter[0], 1u);
}

@compute @workgroup_size(64)
fn spawn(@builtin(global_invocation_id) id: vec3u) {
  let spawnIdx = id.x;
  if (spawnIdx >= config.spawnCount) { return; }

  // Find a free slot (linear scan from a hash-based start)
  let startSlot = pcg_hash(spawnIdx * 1000u + atomicLoad(&counter[1])) % config.maxParticles;
  var slot = startSlot;
  for (var i = 0u; i < config.maxParticles; i++) {
    let candidate = (slot + i) % config.maxParticles;
    let p = particles[candidate];
    if (p.lifetime <= 0.0 || p.age >= p.lifetime) {
      // Found a dead/empty slot — initialize particle
      let seed = pcg_hash(spawnIdx * 7919u + candidate * 6271u);
      var np: Particle;
      np.position = config.emitterPos;
      np.velocity = vec2f(
        rand_range(seed, config.velocityMinX, config.velocityMaxX),
        rand_range(seed + 1u, config.velocityMinY, config.velocityMaxY),
      );
      np.color = vec4f(config.colorStartR, config.colorStartG, config.colorStartB, config.colorStartA);
      np.lifetime = rand_range(seed + 2u, config.lifetimeMin, config.lifetimeMax);
      np.age = 0.0;
      np.size = config.sizeStart;
      np._pad = 0.0;
      particles[candidate] = np;
      atomicAdd(&counter[1], 1u);
      return;
    }
  }
  // No free slot found — particle dropped
}
```

**Step 2: Verify file exists**

Run: `ls ts/src/shaders/particle-simulate.wgsl`
Expected: File listed.

---

### Task 14: Create `particle-render.wgsl` Shader

**Files:**
- Create: `ts/src/shaders/particle-render.wgsl`

**Step 1: Create the shader file**

```wgsl
// particle-render.wgsl — GPU particle rendering (point sprites as quads)
//
// Each particle instance is a screen-space quad expanded from particle position + size.
// Uses the Particle struct from particle-simulate.wgsl.

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

  // Skip dead particles (size 0 or expired)
  if (p.age >= p.lifetime || p.size <= 0.0) {
    var out: VertexOutput;
    out.position = vec4f(0.0, 0.0, -2.0, 1.0); // clip away
    out.color = vec4f(0.0);
    out.uv = vec2f(0.0);
    return out;
  }

  // Unit quad corners (triangle strip order)
  let corners = array<vec2f, 4>(
    vec2f(-0.5, -0.5), vec2f(0.5, -0.5),
    vec2f(-0.5,  0.5), vec2f(0.5,  0.5),
  );
  let corner = corners[vertexIndex % 4u];

  let worldPos = vec4f(p.position + corner * p.size, 0.0, 1.0);

  var out: VertexOutput;
  out.position = camera.viewProjection * worldPos;
  out.color = p.color;
  out.uv = corner + vec2f(0.5); // [0,1] range
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  // Circle SDF for round particles
  let center = vec2f(0.5);
  let dist = length(in.uv - center);
  let edge = fwidth(dist);
  let alpha = 1.0 - smoothstep(0.45 - edge, 0.45 + edge, dist);

  if (alpha < 0.01) { discard; }

  return vec4f(in.color.rgb, in.color.a * alpha);
}
```

**Step 2: Verify file exists + commit shaders**

```bash
git add ts/src/shaders/particle-simulate.wgsl ts/src/shaders/particle-render.wgsl
git commit -m "$(cat <<'EOF'
feat(phase9): add GPU particle compute + render shaders

particle-simulate.wgsl: PCG-hash PRNG, simulate + spawn compute entry
points with gravity, color/size interpolation, and alive counting.
particle-render.wgsl: instanced point sprite quads with circle SDF.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: ParticleSystem Class — Construction + Buffer Management

**Files:**
- Create: `ts/src/particle-system.ts`
- Create: `ts/src/particle-system.test.ts`

**Step 1: Write the failing test**

```typescript
// particle-system.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ParticleSystem } from './particle-system';
import { DEFAULT_PARTICLE_CONFIG } from './particle-types';
import type { ParticleHandle } from './particle-types';

function mockDevice(): GPUDevice {
  return {
    createBuffer: vi.fn(() => ({
      destroy: vi.fn(),
      size: 0,
      mapAsync: vi.fn(),
      getMappedRange: vi.fn(),
      unmap: vi.fn(),
    })),
    createShaderModule: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({
      getBindGroupLayout: vi.fn(() => ({})),
    })),
    createRenderPipeline: vi.fn(() => ({
      getBindGroupLayout: vi.fn(() => ({})),
    })),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    queue: { writeBuffer: vi.fn() },
  } as unknown as GPUDevice;
}

describe('ParticleSystem', () => {
  it('constructs without errors', () => {
    const device = mockDevice();
    const system = new ParticleSystem(device);
    expect(system).toBeDefined();
  });

  it('createEmitter returns a handle', () => {
    const device = mockDevice();
    const system = new ParticleSystem(device);
    const handle = system.createEmitter(DEFAULT_PARTICLE_CONFIG);
    expect(typeof handle).toBe('number');
  });

  it('destroyEmitter removes the emitter', () => {
    const device = mockDevice();
    const system = new ParticleSystem(device);
    const handle = system.createEmitter(DEFAULT_PARTICLE_CONFIG);
    system.destroyEmitter(handle);
    // Should not throw on double destroy
    system.destroyEmitter(handle);
  });

  it('emitterCount tracks active emitters', () => {
    const device = mockDevice();
    const system = new ParticleSystem(device);
    expect(system.emitterCount).toBe(0);
    const h1 = system.createEmitter(DEFAULT_PARTICLE_CONFIG);
    expect(system.emitterCount).toBe(1);
    const h2 = system.createEmitter(DEFAULT_PARTICLE_CONFIG);
    expect(system.emitterCount).toBe(2);
    system.destroyEmitter(h1);
    expect(system.emitterCount).toBe(1);
    system.destroyEmitter(h2);
    expect(system.emitterCount).toBe(0);
  });

  it('destroy cleans up all emitters', () => {
    const device = mockDevice();
    const system = new ParticleSystem(device);
    system.createEmitter(DEFAULT_PARTICLE_CONFIG);
    system.createEmitter(DEFAULT_PARTICLE_CONFIG);
    system.destroy();
    expect(system.emitterCount).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/particle-system.test.ts`
Expected: FAIL — `Cannot find module './particle-system'`

**Step 3: Implement ParticleSystem**

```typescript
// particle-system.ts
import {
  PARTICLE_STRIDE_BYTES,
  type ParticleEmitterConfig,
  type ParticleHandle,
} from './particle-types';

interface EmitterState {
  config: ParticleEmitterConfig;
  particleBuffer: GPUBuffer;
  counterBuffer: GPUBuffer;
  configBuffer: GPUBuffer;
  spawnAccumulator: number; // fractional spawn carry-over
  entityId: number | null;  // optional entity to follow
}

export class ParticleSystem {
  private device: GPUDevice;
  private emitters = new Map<number, EmitterState>();
  private nextHandle = 1;

  private simulatePipeline: GPUComputePipeline | null = null;
  private spawnPipeline: GPUComputePipeline | null = null;
  private renderPipeline: GPURenderPipeline | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /** Initialize compute + render pipelines. Call after construction with shader sources. */
  setupPipelines(simulateSource: string, renderSource: string, format: GPUTextureFormat): void {
    const simModule = this.device.createShaderModule({ code: simulateSource });
    const renderModule = this.device.createShaderModule({ code: renderSource });

    this.simulatePipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: simModule, entryPoint: 'simulate' },
    });

    this.spawnPipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: simModule, entryPoint: 'spawn' },
    });

    this.renderPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'vs_main' },
      fragment: {
        module: renderModule,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-strip', stripIndexFormat: 'uint16' },
    });
  }

  createEmitter(config: ParticleEmitterConfig, entityId?: number): ParticleHandle {
    const handle = this.nextHandle++ as ParticleHandle;
    const bufferSize = config.maxParticles * PARTICLE_STRIDE_BYTES;

    const particleBuffer = this.device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Counter buffer: [aliveCount, nextFreeSlot] — 8 bytes, needs STORAGE + COPY_DST + COPY_SRC
    const counterBuffer = this.device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });

    // Config uniform buffer: 26 floats + 4 u32 = 104 bytes, round to 112 (align 16)
    const configBuffer = this.device.createBuffer({
      size: 112,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.emitters.set(handle, {
      config,
      particleBuffer,
      counterBuffer,
      configBuffer,
      spawnAccumulator: 0,
      entityId: entityId ?? null,
    });

    return handle;
  }

  destroyEmitter(handle: ParticleHandle): void {
    const emitter = this.emitters.get(handle);
    if (!emitter) return;
    emitter.particleBuffer.destroy();
    emitter.counterBuffer.destroy();
    emitter.configBuffer.destroy();
    this.emitters.delete(handle);
  }

  get emitterCount(): number {
    return this.emitters.size;
  }

  /**
   * Simulate all emitters and render particles.
   * Called by the renderer after the RenderGraph completes.
   *
   * @param encoder - GPU command encoder
   * @param swapchainView - Current frame's swapchain texture view (loadOp: 'load')
   * @param cameraVP - Camera view-projection matrix
   * @param dt - Frame delta time in seconds
   * @param renderState - Current frame's render state (for reading entity positions)
   */
  update(
    encoder: GPUCommandEncoder,
    swapchainView: GPUTextureView,
    cameraVP: Float32Array,
    dt: number,
    entityPositions?: { transforms: Float32Array; entityIds: Uint32Array; entityCount: number },
  ): void {
    if (this.emitters.size === 0) return;
    if (!this.simulatePipeline || !this.spawnPipeline || !this.renderPipeline) return;

    for (const [, emitter] of this.emitters) {
      // Resolve emitter position from entity (if attached)
      let emitterX = 0, emitterY = 0;
      if (emitter.entityId !== null && entityPositions) {
        // Find entity position in SoA transforms
        const { transforms, entityIds, entityCount } = entityPositions;
        for (let i = 0; i < entityCount; i++) {
          if (entityIds[i] === emitter.entityId) {
            // Model matrix column 3 (translation): index i*16 + 12, +13, +14
            emitterX = transforms[i * 16 + 12];
            emitterY = transforms[i * 16 + 13];
            break;
          }
        }
      }

      // Calculate spawn count
      emitter.spawnAccumulator += emitter.config.emissionRate * dt;
      const spawnCount = Math.floor(emitter.spawnAccumulator);
      emitter.spawnAccumulator -= spawnCount;

      // Upload emitter config
      this.uploadConfig(emitter, emitterX, emitterY, dt, spawnCount);

      // Reset counter
      this.device.queue.writeBuffer(emitter.counterBuffer, 0, new Uint32Array([0, 0]));

      // Compute: simulate existing particles
      const simBindGroup = this.device.createBindGroup({
        layout: this.simulatePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: emitter.particleBuffer } },
          { binding: 1, resource: { buffer: emitter.configBuffer } },
          { binding: 2, resource: { buffer: emitter.counterBuffer } },
        ],
      });

      const simPass = encoder.beginComputePass();
      simPass.setPipeline(this.simulatePipeline);
      simPass.setBindGroup(0, simBindGroup);
      simPass.dispatchWorkgroups(Math.ceil(emitter.config.maxParticles / 64));
      simPass.end();

      // Compute: spawn new particles
      if (spawnCount > 0) {
        const spawnBindGroup = this.device.createBindGroup({
          layout: this.spawnPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: emitter.particleBuffer } },
            { binding: 1, resource: { buffer: emitter.configBuffer } },
            { binding: 2, resource: { buffer: emitter.counterBuffer } },
          ],
        });

        const spawnPass = encoder.beginComputePass();
        spawnPass.setPipeline(this.spawnPipeline);
        spawnPass.setBindGroup(0, spawnBindGroup);
        spawnPass.dispatchWorkgroups(Math.ceil(spawnCount / 64));
        spawnPass.end();
      }

      // Render particles onto swapchain
      const cameraBuffer = this.device.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(cameraBuffer.getMappedRange()).set(cameraVP);
      cameraBuffer.unmap();

      const renderBindGroup = this.device.createBindGroup({
        layout: this.renderPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: emitter.particleBuffer } },
          { binding: 1, resource: { buffer: cameraBuffer } },
          { binding: 2, resource: { buffer: emitter.counterBuffer } },
        ],
      });

      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: swapchainView,
          loadOp: 'load',  // preserve existing scene
          storeOp: 'store',
        }],
      });
      renderPass.setPipeline(this.renderPipeline);
      renderPass.setBindGroup(0, renderBindGroup);
      // Draw maxParticles instances; dead particles are clipped by vertex shader
      renderPass.draw(4, emitter.config.maxParticles);
      renderPass.end();

      // Cleanup temp buffer (will be destroyed when encoder is submitted)
      // Note: in production, camera buffer should be reused across emitters
    }
  }

  private uploadConfig(
    emitter: EmitterState,
    emitterX: number, emitterY: number,
    dt: number, spawnCount: number,
  ): void {
    const cfg = emitter.config;
    const data = new ArrayBuffer(112);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);

    f[0] = emitterX;           // emitterPos.x
    f[1] = emitterY;           // emitterPos.y
    f[2] = dt;                 // dt
    f[3] = cfg.emissionRate;   // emissionRate
    f[4] = cfg.lifetime[0];    // lifetimeMin
    f[5] = cfg.lifetime[1];    // lifetimeMax
    f[6] = cfg.velocityMin[0]; // velocityMinX
    f[7] = cfg.velocityMin[1]; // velocityMinY
    f[8] = cfg.velocityMax[0]; // velocityMaxX
    f[9] = cfg.velocityMax[1]; // velocityMaxY
    f[10] = cfg.colorStart[0]; // colorStartR
    f[11] = cfg.colorStart[1]; // colorStartG
    f[12] = cfg.colorStart[2]; // colorStartB
    f[13] = cfg.colorStart[3]; // colorStartA
    f[14] = cfg.colorEnd[0];   // colorEndR
    f[15] = cfg.colorEnd[1];   // colorEndG
    f[16] = cfg.colorEnd[2];   // colorEndB
    f[17] = cfg.colorEnd[3];   // colorEndA
    f[18] = cfg.sizeStart;     // sizeStart
    f[19] = cfg.sizeEnd;       // sizeEnd
    f[20] = cfg.gravity[0];    // gravityX
    f[21] = cfg.gravity[1];    // gravityY
    u[22] = cfg.maxParticles;  // maxParticles
    u[23] = spawnCount;        // spawnCount
    u[24] = 0;                 // _pad0
    u[25] = 0;                 // _pad1

    this.device.queue.writeBuffer(emitter.configBuffer, 0, data);
  }

  destroy(): void {
    for (const [handle] of this.emitters) {
      this.destroyEmitter(handle as ParticleHandle);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/particle-system.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/particle-system.ts ts/src/particle-system.test.ts
git commit -m "$(cat <<'EOF'
feat(phase9): implement ParticleSystem with GPU buffer management

createEmitter/destroyEmitter lifecycle, per-emitter GPU buffers
(particles, counter, config), compute simulation dispatch, and
instanced render with loadOp:load for swapchain compositing.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Wire Particles into Renderer

**Files:**
- Modify: `ts/src/renderer.ts` (add particle system import, setup, render call)

**Step 1: Add imports**

```typescript
import { ParticleSystem } from './particle-system';
import particleSimulateCode from './shaders/particle-simulate.wgsl?raw';
import particleRenderCode from './shaders/particle-render.wgsl?raw';
```

**Step 2: Create ParticleSystem in `createRenderer()`**

After pass setup (around line 154):

```typescript
  // --- Particle System ---
  const particleSystem = new ParticleSystem(device);
  particleSystem.setupPipelines(particleSimulateCode, particleRenderCode, format);
```

**Step 3: Call particle update in `render()`**

In the render method, after `graph.render(device, frameState, resources)`, add:

```typescript
      // Render particles on top of the scene (after graph completes)
      if (particleSystem.emitterCount > 0) {
        const swapchainView = resources.getTextureView('swapchain')!;
        const encoder = device.createCommandEncoder();
        particleSystem.update(
          encoder,
          swapchainView,
          camera.viewProjection,
          frameState.deltaTime,
          {
            transforms: state.transforms,
            entityIds: state.entityIds,
            entityCount: state.entityCount,
          },
        );
        device.queue.submit([encoder.finish()]);
      }
```

> **Important:** The graph's render already submits one command buffer. Particles submit a second. This ordering is correct because `graph.render()` completes before particle commands are recorded.

**Step 4: Expose particle system on Renderer interface**

Add to `Renderer` interface:

```typescript
  readonly particleSystem: ParticleSystem;
```

And on the renderer object:

```typescript
    get particleSystem() { return particleSystem; },
```

**Step 5: Add particle cleanup to destroy()**

```typescript
    destroy() {
      particleSystem.destroy();
      // ... existing destroy ...
    },
```

**Step 6: Add HMR entries**

```typescript
    import.meta.hot.accept('./shaders/particle-simulate.wgsl?raw', (mod) => {
      if (mod) {
        particleSystem.setupPipelines(mod.default, particleRenderCode, format);
        console.log('[Hyperion] Particle simulate shader hot-reloaded');
      }
    });
    import.meta.hot.accept('./shaders/particle-render.wgsl?raw', (mod) => {
      if (mod) {
        particleSystem.setupPipelines(particleSimulateCode, mod.default, format);
        console.log('[Hyperion] Particle render shader hot-reloaded');
      }
    });
```

**Step 7: Verify build**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors.

**Step 8: Commit**

```bash
git add ts/src/renderer.ts
git commit -m "$(cat <<'EOF'
feat(phase9): wire particle system into renderer

Creates ParticleSystem in createRenderer(), dispatches particle
simulation + rendering after RenderGraph completes. Adds HMR for
both particle shaders.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Hyperion Particle Facade — Test + Implement

**Files:**
- Modify: `ts/src/hyperion.test.ts` (add particle tests)
- Modify: `ts/src/hyperion.ts` (add particle methods)

**Step 1: Write the failing test**

Add to `hyperion.test.ts`:

```typescript
  describe('particles', () => {
    it('createParticleEmitter delegates to renderer.particleSystem', () => {
      // Build mock renderer with particleSystem mock
      const particleSystem = {
        createEmitter: vi.fn(() => 1),
        destroyEmitter: vi.fn(),
        emitterCount: 0,
        destroy: vi.fn(),
      };
      const renderer = {
        particleSystem,
        // ... other mock properties from existing tests ...
      };
      const engine = Hyperion.fromParts({ renderer, /* other parts */ });
      const handle = engine.createParticleEmitter({ maxParticles: 500 });
      expect(particleSystem.createEmitter).toHaveBeenCalled();
      expect(handle).toBe(1);
    });

    it('destroyParticleEmitter delegates correctly', () => {
      const particleSystem = {
        createEmitter: vi.fn(() => 1),
        destroyEmitter: vi.fn(),
        emitterCount: 0,
        destroy: vi.fn(),
      };
      const renderer = { particleSystem, /* ... */ };
      const engine = Hyperion.fromParts({ renderer, /* ... */ });
      engine.destroyParticleEmitter(1);
      expect(particleSystem.destroyEmitter).toHaveBeenCalledWith(1);
    });

    it('createParticleEmitter throws when no renderer', () => {
      const engine = Hyperion.fromParts({ renderer: null, /* ... */ });
      expect(() => engine.createParticleEmitter({})).toThrow('no renderer');
    });
  });
```

> **Note:** Adapt the mock shape to match the exact `fromParts` signature.

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `engine.createParticleEmitter is not a function`

**Step 3: Implement on Hyperion class**

Add to `hyperion.ts`:

```typescript
  /**
   * Create a GPU particle emitter.
   * Particles are simulated and rendered entirely on the GPU.
   *
   * @param config - Emitter configuration (merged with defaults)
   * @param entityId - Optional entity ID to follow (emitter position = entity position)
   * @returns ParticleHandle for later destruction
   */
  createParticleEmitter(config: Partial<ParticleEmitterConfig>, entityId?: number): ParticleHandle {
    this.checkDestroyed();
    if (!this.renderer) throw new Error('Cannot create particle emitter: no renderer available');
    const merged = { ...DEFAULT_PARTICLE_CONFIG, ...config };
    return this.renderer.particleSystem.createEmitter(merged, entityId);
  }

  /** Destroy a particle emitter and free its GPU resources. */
  destroyParticleEmitter(handle: ParticleHandle): void {
    this.checkDestroyed();
    this.renderer?.particleSystem.destroyEmitter(handle);
  }
```

Add the imports:
```typescript
import { DEFAULT_PARTICLE_CONFIG, type ParticleEmitterConfig, type ParticleHandle } from './particle-types';
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "$(cat <<'EOF'
feat(phase9): add createParticleEmitter/destroyParticleEmitter to facade

Merges config with DEFAULT_PARTICLE_CONFIG. Optional entityId for
position tracking. Throws when no renderer (headless mode).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Export New Types from Index

**Files:**
- Modify: `ts/src/index.ts`

**Step 1: Add exports**

```typescript
export type { BloomConfig } from './render/passes/bloom-pass';
export type { ParticleEmitterConfig, ParticleHandle } from './particle-types';
export { DEFAULT_PARTICLE_CONFIG } from './particle-types';
```

**Step 2: Verify build**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add ts/src/index.ts
git commit -m "$(cat <<'EOF'
feat(phase9): export BloomConfig, ParticleEmitterConfig, ParticleHandle

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Track D: Demo, Documentation & Validation (Tasks 19–24)

### Task 19: Update Demo with Bézier + Bloom + Particles

**Files:**
- Modify: `ts/src/main.ts`

Add demonstration code showing all three new features. The demo should:

1. Spawn a few quadratic Bézier curves connecting entities
2. Enable bloom with visible glow on bright entities
3. Create a particle emitter on a clicked entity (visual sparkle effect)

**Step 1: Add Bézier curve demo entities**

After existing entity spawning in `main.ts`:

```typescript
// --- Bézier curve demo ---
engine.spawn()
  .position(200, 200, 0)
  .scale(200, 200, 1)
  .bezier(0.0, 0.5, 0.5, 0.0, 1.0, 0.5, 0.03);

engine.spawn()
  .position(500, 300, 0)
  .scale(150, 100, 1)
  .bezier(0.0, 0.0, 0.5, 1.0, 1.0, 0.0, 0.02);
```

**Step 2: Enable bloom**

```typescript
// --- Bloom demo ---
engine.enableBloom({ threshold: 0.6, intensity: 1.2 });
```

**Step 3: Add particle emitter on click**

```typescript
// --- Particle demo ---
let particleHandle: ParticleHandle | null = null;
engine.input.onClick((x, y) => {
  // Destroy previous emitter
  if (particleHandle !== null) {
    engine.destroyParticleEmitter(particleHandle);
  }
  // Create sparkle emitter at click position
  const sparkle = engine.spawn().position(x, y, 0).scale(1, 1, 1);
  particleHandle = engine.createParticleEmitter({
    maxParticles: 200,
    emissionRate: 80,
    lifetime: [0.3, 1.0],
    velocityMin: [-50, -80],
    velocityMax: [50, -10],
    colorStart: [1, 0.8, 0.2, 1],
    colorEnd: [1, 0.2, 0, 0],
    sizeStart: 6,
    sizeEnd: 0,
    gravity: [0, 100],
  }, sparkle.id);
});
```

**Step 4: Verify build**

Run: `cd ts && npm run build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add ts/src/main.ts
git commit -m "$(cat <<'EOF'
feat(phase9): update demo with Bézier curves, bloom, and particles

Demo shows: quadratic Bézier curve entities, bloom post-processing
with threshold 0.6, and click-to-spawn particle emitters with
fire/sparkle configuration.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: Run Full Test Suite

**Step 1: Run Rust tests**

Run: `cargo test -p hyperion-core`
Expected: 99 tests pass.

**Step 2: Run TypeScript tests**

Run: `cd ts && npm test`
Expected: All tests pass (previous 409 + new tests).

**Step 3: Run TypeScript type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors.

**Step 4: Run Rust clippy**

Run: `cargo clippy -p hyperion-core`
Expected: No warnings.

---

### Task 21: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

Add the following to the Architecture table, module descriptions, Gotchas, and Implementation Status:

**New modules to add:**
- `shaders/bezier.wgsl` — Quadratic Bézier SDF shader with Inigo Quilez distance function
- `shaders/bloom.wgsl` — Dual Kawase bloom (extract/downsample/upsample/composite + tonemap + FXAA)
- `shaders/particle-simulate.wgsl` — GPU particle compute simulation (simulate + spawn entry points, PCG PRNG)
- `shaders/particle-render.wgsl` — Instanced point sprite particle rendering with circle SDF
- `render/passes/bloom-pass.ts` — `BloomPass` — single RenderGraph node with internal 6-step blur chain (extract → 2× down → 2× up → composite). reads: scene-hdr, writes: swapchain. Includes PBR Neutral tonemapping + FXAA. Dead-culls FXAATonemapPass when active. Mutually exclusive with outline pipeline
- `particle-types.ts` — `ParticleHandle` branded type, `ParticleEmitterConfig`, `DEFAULT_PARTICLE_CONFIG`, GPU struct layout (48 bytes/particle)
- `particle-system.ts` — `ParticleSystem` — GPU particle management. Per-emitter buffers, compute simulation (simulate + spawn passes), instanced rendering after RenderGraph. Particles are GPU-only (not ECS entities)

**New test commands to add:**
```
cd ts && npx vitest run src/render/passes/bloom-pass.test.ts   # BloomPass (N tests)
cd ts && npx vitest run src/particle-types.test.ts              # Particle types (N tests)
cd ts && npx vitest run src/particle-system.test.ts             # ParticleSystem (N tests)
```

**New Gotchas to add:**
- **Bloom and outlines are mutually exclusive** — Both write to `swapchain`, dead-culling `FXAATonemapPass`. `enableBloom()` disables outlines; `enableOutlines()` disables bloom. Console warning issued.
- **Bloom intermediate textures at 3 fixed mip levels** — bloom-half (1/2 res), bloom-quarter (1/4 res), bloom-eighth (1/8 res). All use canvas format. Must be recreated on resize.
- **GPU particles are NOT ECS entities** — Particles live in GPU storage buffers, simulated by compute shader, rendered outside the RenderGraph. This avoids ring buffer saturation. Emitters optionally follow an ECS entity's position.
- **Particle spawn uses PCG hash PRNG** — `pcg_hash()` in WGSL. Not cryptographically secure. Seed is derived from spawn index + free slot counter for deterministic-per-frame results.
- **Particle render uses loadOp: 'load' on swapchain** — Particles are drawn on top of the scene after the RenderGraph completes. They are NOT affected by bloom or FXAA (rendered after post-processing).
- **Bézier control points in PrimParams are UV-space** — The quadratic Bézier SDF expects control points in [0,1]² range relative to the entity's bounding quad. The entity's position+scale define the world-space bounding box.

**Update Implementation Status** to include Phase 9.

---

### Task 22: Update PROJECT_ARCHITECTURE.md

**Files:**
- Modify: `PROJECT_ARCHITECTURE.md`

Add Phase 9 subsections covering:
- Quadratic Bézier SDF algorithm overview
- Dual Kawase bloom pipeline (6-step internal chain)
- GPU particle system architecture (compute → render, GPU-only)
- New shader files and their roles

---

### Task 23: Documentation Commit

```bash
git add CLAUDE.md PROJECT_ARCHITECTURE.md
git commit -m "$(cat <<'EOF'
docs(phase9): update CLAUDE.md and PROJECT_ARCHITECTURE.md for Phase 9

Adds Bézier curve, bloom post-processing, and GPU particle system
documentation. New modules, gotchas, test commands, and architecture
sections.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 24: Final Validation

**Step 1: Full validation pipeline**

Run: `cargo test -p hyperion-core && cargo clippy -p hyperion-core && cd ts && npm test && npx tsc --noEmit`
Expected: ALL PASS, no warnings, no type errors.

**Step 2: Verify git status is clean**

Run: `git status`
Expected: Clean working tree.

---

## Summary

| Track | Tasks | New Files | Modified Files | Key Deliverable |
|-------|-------|-----------|----------------|-----------------|
| A: Bézier | 1–5 | `bezier.wgsl` | `entity-handle.ts`, `renderer.ts` | Quadratic Bézier SDF rendering (slot 3) |
| B: Bloom | 6–11 | `bloom.wgsl`, `bloom-pass.ts` | `renderer.ts`, `hyperion.ts` | Dual Kawase bloom (extract → blur → composite + tonemap + FXAA) |
| C: Particles | 12–18 | `particle-*.wgsl`, `particle-types.ts`, `particle-system.ts` | `renderer.ts`, `hyperion.ts`, `index.ts` | GPU compute particle system |
| D: Polish | 19–24 | — | `main.ts`, `CLAUDE.md`, `PROJECT_ARCHITECTURE.md` | Demo + docs + validation |

**Estimated test additions:** ~30 new tests across 3 test files.

**Design decisions for future phases:**
- **HDR rendering** (rgba16float scene-hdr): Deferred. Current LDR bloom works for 2D. HDR upgrade is a cross-cutting change best tackled when 3D PBR materials need it.
- **Stencil clip paths**: Deferred. Requires depth format change (depth24plus → depth24plus-stencil8) across all passes + new RenderPass interface concepts.
- **Bloom + outlines combined**: Deferred. Requires either RenderGraph append-write semantics or intermediate compositing buffer.
- **Cubic Bézier**: Could be added to `bezier.wgsl` with a mode flag in primParams[7]. Quartic SDF is complex; practical approach is subdivision into quadratics.
