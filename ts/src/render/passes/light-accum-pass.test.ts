import { describe, it, expect, beforeAll } from 'vitest';
import { LightAccumPass, LIGHT2D_ARG_SLOTS } from './light-accum-pass';
import { ResourcePool } from '../resource-pool';
import { SCENE_HDR_FORMAT } from '../formats';
import type { FrameState } from '../render-pass';
import lightShaderSource from '../../shaders/light-accum.wgsl?raw';

// LightAccumPass (Phase 17, Task 9) accumulates every visible Light2D into
// `light-buffer`: half resolution, the same texels as the signed SDF, additive
// blend, cleared to the ambient light. Each point or spot light is one quad
// covering its range, drawn instanced from the Light2D bucket the CullPass
// fills. Shadows are a sphere march on the SDF toward the light.

function setUp() {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 };
  g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
  g.GPUTextureUsage ??= { TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

  const pipelines: GPURenderPipelineDescriptor[] = [];
  const textures: Array<{ desc: GPUTextureDescriptor; destroyed: boolean }> = [];
  const writes: Array<{ buffer: unknown; data: ArrayBuffer }> = [];
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, destroy() {} }),
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => { pipelines.push(d); return { d }; },
    createBindGroup: (d: GPUBindGroupDescriptor) => ({ entries: [...d.entries] }),
    createTexture: (desc: GPUTextureDescriptor) => {
      const t = { desc, destroyed: false };
      textures.push(t);
      return { createView: () => ({ of: t }), destroy() { t.destroyed = true; } };
    },
    queue: {
      writeBuffer: (buffer: unknown, _o: number, data: ArrayBuffer | ArrayBufferView) => {
        writes.push({ buffer, data: data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength) });
      },
    },
  } as unknown as GPUDevice;

  const pool = new ResourcePool();
  for (const name of ['entity-transforms', 'visible-indices', 'indirect-args', 'render-meta', 'prim-params']) {
    pool.setBuffer(name, { name } as unknown as GPUBuffer);
  }
  pool.setTextureView('sdf-final', { name: 'sdf' } as unknown as GPUTextureView);

  const pass = new LightAccumPass('sdf-final');
  pass.setup(device, pool);

  const record = (frame: Partial<FrameState>) => {
    const passes: Array<{ desc: GPURenderPassDescriptor; draws: number[] }> = [];
    const encoder = {
      beginRenderPass: (desc: GPURenderPassDescriptor) => {
        const rec = { desc, draws: [] as number[] };
        passes.push(rec);
        return {
          setPipeline() {}, setVertexBuffer() {}, setIndexBuffer() {}, setBindGroup() {}, end() {},
          drawIndexedIndirect: (_b: GPUBuffer, offset: number) => { rec.draws.push(offset); },
        };
      },
    } as unknown as GPUCommandEncoder;
    const f = { canvasWidth: 800, canvasHeight: 600, cameraViewProjection: new Float32Array(16), ...frame } as FrameState;
    pass.prepare(device, f);
    pass.execute(encoder, f, pool);
    return passes;
  };
  return { pass, pool, pipelines, textures, writes, record };
}

describe('LightAccumPass', () => {
  beforeAll(() => { LightAccumPass.SHADER_SOURCE = lightShaderSource; });

  it('writes light-buffer from the light columns and the signed SDF, and is culled when nothing reads it', () => {
    const pass = new LightAccumPass('sdf-iter-9');
    expect(pass.name).toBe('light-accum');
    expect(pass.optional).toBe(true);
    expect(pass.writes).toEqual(['light-buffer']);
    for (const r of ['visible-indices', 'entity-transforms', 'indirect-args', 'prim-params', 'render-meta', 'sdf-iter-9']) {
      expect(pass.reads).toContain(r);
    }
  });

  it('blends additively into an HDR target', () => {
    const { pipelines } = setUp();
    const target = [...(pipelines[0].fragment?.targets ?? [])][0]!;
    expect(target.format).toBe(SCENE_HDR_FORMAT);
    expect(target.blend?.color).toEqual({ operation: 'add', srcFactor: 'one', dstFactor: 'one' });
  });

  it('draws the Light2D buckets and nothing else', () => {
    const { record } = setUp();
    const [light] = record({});
    expect(LIGHT2D_ARG_SLOTS).toEqual([12, 13]);   // primType 6, both material buckets
    expect(light.draws).toEqual([240, 260]);       // 20 bytes per DrawIndexedIndirect entry
  });

  it('clears to the ambient light, scaled by its intensity', () => {
    const { record } = setUp();
    const [light] = record({ ambient: [0.2, 0.3, 0.4, 0.5] });
    const attachment = [...light.desc.colorAttachments][0]!;
    expect(attachment.loadOp).toBe('clear');
    expect(attachment.clearValue).toEqual({ r: 0.1, g: 0.15, b: 0.2, a: 1 });
  });

  it('clears to black when no ambient is given', () => {
    const { record } = setUp();
    const [light] = record({});
    expect([...light.desc.colorAttachments][0]!.clearValue).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('renders into a half-resolution light-buffer, recreated only when the canvas size changes', () => {
    const { record, textures, pool } = setUp();
    const [light] = record({ canvasWidth: 801, canvasHeight: 600 });
    record({ canvasWidth: 801, canvasHeight: 600 });
    const targets = textures.filter((t) => t.desc.format === SCENE_HDR_FORMAT);
    expect(targets).toHaveLength(1);
    expect(targets[0].desc.size).toEqual({ width: 400, height: 300 });
    expect([...light.desc.colorAttachments][0]!.view).toBe(pool.getTextureView('light-buffer'));
    record({ canvasWidth: 1024, canvasHeight: 768 });
    expect(textures.filter((t) => t.desc.format === SCENE_HDR_FORMAT)).toHaveLength(2);
    expect(targets[0].destroyed).toBe(true);
  });

  it('uploads the camera and the shadow step count', () => {
    const { record, writes } = setUp();
    const vp = new Float32Array(16).map((_, i) => i + 1);
    record({ cameraViewProjection: vp, shadowSteps: 17 });
    const u = writes.at(-1)!.data;
    expect([...new Float32Array(u, 0, 16)]).toEqual([...vp]);
    expect(new Uint32Array(u, 64, 1)[0]).toBe(17);
  });
});

describe('light-accum.wgsl', () => {
  it('reads the SDF with textureLoad: filtering would blend seed coordinates', () => {
    expect(lightShaderSource).toMatch(/textureLoad\s*\(\s*sdf\b/);
    expect(lightShaderSource).not.toMatch(/textureSample[^L]/);
  });

  it('uses the original Quilez soft-shadow term, not the Aaltonen correction', () => {
    // The correction assumes an exact SDF. A jump-flood field over-estimates,
    // and y = h*h / (2*ph) amplifies that (design §7.3, A2).
    expect(lightShaderSource).toMatch(/min\(\s*res\s*,[^;]*\*\s*h\s*\/\s*t\s*\)/);
    expect(lightShaderSource).not.toMatch(/h\s*\*\s*h\s*\/\s*\(\s*2\.0\s*\*/);
  });
});
