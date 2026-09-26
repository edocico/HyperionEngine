import { describe, it, expect, vi } from 'vitest';
import { BloomPass } from './bloom-pass';
import type { FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';

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

  it('execute() should not throw with valid resources', () => {
    const pass = new BloomPass();
    expect(typeof pass.execute).toBe('function');
  });

  it('setTonemapMode updates the mode', () => {
    const pass = new BloomPass();
    pass.tonemapMode = 2;
    expect(pass.tonemapMode).toBe(2);
  });
});

// ── What each sub-pass actually binds ──────────────────────────────
//
// Both defects below are invisible to setup-time validation: WebGPU checks
// them at draw time, and with bloom on it then drops every frame's command
// buffer. They stayed hidden until 2026-09-26, because until then no graph with
// bloom in it ever went live. This fake device keeps the semantics that matter:
// `queue.writeBuffer` is a queue operation, so every write in a frame lands
// before the command buffer that reads it runs.
function recordBloomFrame(width = 800, height = 600) {
  const g = globalThis as Record<string, unknown>;
  g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
  g.GPUBufferUsage ??= { COPY_DST: 0x0008, UNIFORM: 0x0040 };
  g.GPUTextureUsage ??= { TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };
  vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });

  type FakeBuffer = { bytes: Uint8Array };
  const passes: Array<{ target: unknown; entries: GPUBindGroupEntry[] }> = [];
  const device = {
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createSampler: () => ({ kind: 'sampler' }),
    createBuffer: (d: GPUBufferDescriptor): FakeBuffer => ({ bytes: new Uint8Array(d.size) }),
    createTexture: (d: GPUTextureDescriptor) => ({ createView: () => ({ texture: d }) }),
    createBindGroup: (d: GPUBindGroupDescriptor) => ({ entries: [...d.entries] }),
    queue: {
      writeBuffer: (b: FakeBuffer, offset: number, data: ArrayBuffer | ArrayBufferView) => {
        const src = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        b.bytes.set(src, offset);
      },
    },
  } as unknown as GPUDevice;
  const encoder = {
    beginRenderPass: (d: GPURenderPassDescriptor) => {
      const rec = { target: [...d.colorAttachments][0]!.view, entries: [] as GPUBindGroupEntry[] };
      passes.push(rec);
      return {
        setPipeline() {},
        setBindGroup: (_i: number, bg: { entries: GPUBindGroupEntry[] }) => { rec.entries = bg.entries; },
        draw() {},
        end() {},
      };
    },
  } as unknown as GPUCommandEncoder;
  const views: Record<string, object> = {};
  const resources = {
    getTextureView: (name: string) => (views[name] ??= { name }),
  } as unknown as ResourcePool;

  const saved = BloomPass.SHADER_SOURCE;
  BloomPass.SHADER_SOURCE = 'stub';
  try {
    const pass = new BloomPass();
    pass.setup(device, resources);
    pass.prepare(device, { canvasWidth: width, canvasHeight: height } as FrameState);
    pass.execute(encoder, { canvasWidth: width, canvasHeight: height } as FrameState, resources);
  } finally {
    BloomPass.SHADER_SOURCE = saved;
    vi.unstubAllGlobals();
  }
  return { passes, views };
}

describe('BloomPass sub-passes', () => {
  it('runs the six sub-passes of the dual Kawase chain', () => {
    const { passes, views } = recordBloomFrame();
    expect(passes.map((p) => (p.target as { name: string }).name)).toEqual(
      ['bloom-half', 'bloom-quarter', 'bloom-eighth', 'bloom-quarter', 'bloom-half', 'swapchain'],
    );
    expect(views['swapchain']).toBeDefined();
  });

  it('never samples the texture a sub-pass renders into', () => {
    // Binding 2 is in the shared layout, so a pass that does not use it still
    // needs a placeholder. It used to be bloom-eighth, which pass 3 renders into.
    const { passes } = recordBloomFrame();
    passes.forEach((p, i) => {
      const sampled = p.entries.filter((e) => e.binding === 1 || e.binding === 2).map((e) => e.resource);
      expect(sampled, `sub-pass ${i + 1}`).not.toContain(p.target);
    });
  });

  it('gives each sub-pass the texel size of its own target', () => {
    // All params are written before the single submit. A shared buffer at one
    // offset therefore left every sub-pass reading the composite's full-res texel size.
    const w = 800, h = 600;
    const { passes } = recordBloomFrame(w, h);
    const divisors = [2, 4, 8, 4, 2, 1];
    passes.forEach((p, i) => {
      const ub = p.entries.find((e) => e.binding === 0)!.resource as GPUBufferBinding & { buffer: { bytes: Uint8Array } };
      const f32 = new Float32Array(ub.buffer.bytes.buffer, ub.offset ?? 0, 2);
      expect([f32[0], f32[1]], `sub-pass ${i + 1}`).toEqual([
        Math.fround(1 / (w / divisors[i])), Math.fround(1 / (h / divisors[i])),
      ]);
    });
  });
});
