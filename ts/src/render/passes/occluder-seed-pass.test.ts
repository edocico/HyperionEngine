import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OccluderSeedPass } from './occluder-seed-pass';
import { ResourcePool } from '../resource-pool';
import { JFA_FORMAT } from '../formats';
import type { FrameState } from '../render-pass';
import basicShaderSource from '../../shaders/basic.wgsl?raw';

// OccluderSeedPass rasterises every shadow-casting entity into `occluder-seed`,
// the seed texture the SDF chain floods (Phase 17, Task 7). It runs each
// primitive's OWN shader, through a second fragment entry point `fs_occluder`
// that reuses the primitive's coverage. A sprite therefore casts its
// silhouette, and a bezier its curve, rather than its bounding quad (design
// §6.2). Types whose shader has no `fs_occluder` yet cast nothing.

const OCCLUDER_SHADER = 'fn fs_occluder(in: VertexOutput) -> @location(0) vec4f { return vec4f(0.0); }';

function setUp(sources: Record<number, string>) {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 };
  g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
  g.GPUTextureUsage ??= { TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

  const pipelines: GPURenderPipelineDescriptor[] = [];
  const textures: Array<{ desc: GPUTextureDescriptor; destroyed: boolean }> = [];
  const device = {
    createBuffer: () => ({ destroy() {} }),
    createShaderModule: (d: GPUShaderModuleDescriptor) => ({ code: d.code }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => { pipelines.push(d); return { d }; },
    createBindGroup: (d: GPUBindGroupDescriptor) => ({ entries: [...d.entries] }),
    createTexture: (desc: GPUTextureDescriptor) => {
      const t = { desc, destroyed: false };
      textures.push(t);
      return { createView: () => ({ of: t }), destroy() { t.destroyed = true; } };
    },
    queue: { writeBuffer() {} },
  } as unknown as GPUDevice;

  const pool = new ResourcePool();
  for (const name of ['entity-transforms', 'visible-indices', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params']) {
    pool.setBuffer(name, {} as GPUBuffer);
  }
  for (const name of ['tier0', 'tier1', 'tier2', 'tier3', 'ovf0', 'ovf1', 'ovf2', 'ovf3']) {
    pool.setTextureView(name, { name } as unknown as GPUTextureView);
  }
  pool.setSampler('texSampler', {} as GPUSampler);

  const pass = new OccluderSeedPass(sources);
  pass.setup(device, pool);

  const frame = (w: number, h: number) => ({ canvasWidth: w, canvasHeight: h, cameraViewProjection: new Float32Array(16) }) as unknown as FrameState;
  const record = (w = 800, h = 600) => {
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
    pass.prepare(device, frame(w, h));
    pass.execute(encoder, frame(w, h), pool);
    return passes;
  };
  return { pass, pool, pipelines, textures, record };
}

describe('OccluderSeedPass', () => {
  it('writes occluder-seed from the scene columns, and is culled when nothing reads it', () => {
    const pass = new OccluderSeedPass({});
    expect(pass.name).toBe('occluder-seed');
    expect(pass.optional).toBe(true);
    expect(pass.writes).toEqual(['occluder-seed']);
    for (const r of ['visible-indices', 'entity-transforms', 'indirect-args', 'render-meta', 'tex-indices', 'prim-params']) {
      expect(pass.reads).toContain(r);
    }
  });

  it('builds one pipeline per primitive whose shader has fs_occluder, and none for the others', () => {
    const { pipelines } = setUp({ 0: OCCLUDER_SHADER, 1: 'no occluder entry here', 3: OCCLUDER_SHADER });
    expect(pipelines).toHaveLength(2);
    for (const p of pipelines) {
      expect(p.fragment?.entryPoint).toBe('fs_occluder');
      expect([...(p.fragment?.targets ?? [])][0]?.format).toBe(JFA_FORMAT);
      // The vertex stage drops entities that do not cast a shadow.
      expect(p.vertex.constants?.OCCLUDER_PASS).toBe(1);
      expect(p.depthStencil).toBeUndefined();
    }
  });

  it('draws both opaque buckets of each occluder type, and no transparent bucket', () => {
    const { record } = setUp({ 0: OCCLUDER_SHADER, 3: OCCLUDER_SHADER });
    const [seed] = record();
    // argSlot = primType * 2 + bucket; 20 bytes per DrawIndexedIndirect entry.
    expect(seed.draws.sort((a, b) => a - b)).toEqual([0, 20, 120, 140]);
  });

  it('renders into a half-resolution occluder-seed, cleared to "no seed"', () => {
    const { record, pool, textures } = setUp({ 0: OCCLUDER_SHADER });
    const [seed] = record(801, 600);
    const target = textures.find((t) => t.desc.format === JFA_FORMAT)!;
    expect(target.desc.size).toEqual({ width: 400, height: 300 });
    const attachment = [...seed.desc.colorAttachments][0]!;
    expect(attachment.loadOp).toBe('clear');
    expect(attachment.clearValue).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(attachment.view).toBe(pool.getTextureView('occluder-seed'));
  });

  it('recreates the target only when the canvas size changes', () => {
    const { record, textures } = setUp({ 0: OCCLUDER_SHADER });
    record(800, 600);
    record(800, 600);
    expect(textures.filter((t) => t.desc.format === JFA_FORMAT)).toHaveLength(1);
    record(1024, 768);
    const seeds = textures.filter((t) => t.desc.format === JFA_FORMAT);
    expect(seeds).toHaveLength(2);
    expect(seeds[0].destroyed).toBe(true);
  });

  it('still clears the target when no primitive can occlude, so readers see an empty scene', () => {
    const { record } = setUp({ 1: 'no occluder entry here' });
    const [seed] = record();
    expect(seed).toBeDefined();
    expect(seed.draws).toEqual([]);
  });
});

describe('basic.wgsl occluder entry', () => {
  it('drops non-casters in the vertex stage only when the pipeline asks for it', () => {
    // Default false: the ForwardPass pipelines constant-fold the check away.
    expect(basicShaderSource).toMatch(/override OCCLUDER_PASS\s*:\s*bool\s*=\s*false;/);
  });

  it('agrees with Rust on the castsShadow bit of renderMeta', () => {
    const rust = readFileSync(new URL('../../../../crates/hyperion-core/src/components.rs', import.meta.url), 'utf8');
    const rustBit = Number(/RENDER_META_CASTS_SHADOW_BIT: u32 = 1 << (\d+);/.exec(rust)?.[1]);
    const wgslBit = Number(/const CASTS_SHADOW_BIT\s*:\s*u32\s*=\s*1u << (\d+)u;/.exec(basicShaderSource)?.[1]);
    expect(rustBit).toBe(9);
    expect(wgslBit).toBe(rustBit);
  });

  it('exposes fs_occluder', () => {
    expect(basicShaderSource).toMatch(/fn fs_occluder\s*\(/);
  });
});
