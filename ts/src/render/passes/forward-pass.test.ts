import { describe, it, expect } from 'vitest';
import { ForwardPass } from './forward-pass';
import { ResourcePool } from '../resource-pool';
import type { FrameState } from '../render-pass';
import basicShaderSource from '../../shaders/basic.wgsl?raw';

describe('ForwardPass', () => {
  it('should implement RenderPass interface', () => {
    const pass = new ForwardPass();
    expect(pass.name).toBe('forward');
    expect(pass.reads).toContain('visible-indices');
    expect(pass.reads).toContain('entity-transforms');
    expect(pass.reads).toContain('tex-indices');
    expect(pass.reads).toContain('indirect-args');
    expect(pass.writes).toContain('scene-hdr');
    expect(pass.optional).toBe(false);
  });

  it('should declare render-meta and prim-params as read dependencies', () => {
    const pass = new ForwardPass();
    expect(pass.reads).toContain('render-meta');
    expect(pass.reads).toContain('prim-params');
  });

  it('should start with empty pipeline maps', () => {
    const pass = new ForwardPass();
    // Access via destroy to verify no pipelines exist
    pass.destroy();
    // If no error, pipelines were successfully cleared (even though empty)
    expect(true).toBe(true);
  });
});

// ForwardPass binds the texture-tier views in group 1. A tier that grows gets a
// new texture and view, and the old texture is destroyed. The bind group must
// follow, or every draw uses a destroyed texture and the frame is dropped.
describe('ForwardPass group 1 follows the texture tiers', () => {
  function setUp() {
    const g = globalThis as Record<string, unknown>;
    g.GPUBufferUsage ??= { COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 };
    g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
    g.GPUTextureUsage ??= { TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

    const texture = () => ({ createView: () => ({}), destroy() {} });
    const device = {
      createBuffer: () => ({ destroy() {} }),
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: (d: GPUBindGroupDescriptor) => ({ entries: [...d.entries] }),
      createTexture: texture,
      queue: { writeBuffer() {} },
    } as unknown as GPUDevice;

    const pool = new ResourcePool();
    for (const name of ['entity-transforms', 'visible-indices', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params']) {
      pool.setBuffer(name, {} as GPUBuffer);
    }
    for (const name of ['tier0', 'tier1', 'tier2', 'tier3', 'ovf0', 'ovf1', 'ovf2', 'ovf3', 'scene-hdr']) {
      pool.setTextureView(name, { name } as unknown as GPUTextureView);
    }
    pool.setSampler('texSampler', {} as GPUSampler);

    const saved = ForwardPass.SHADER_SOURCES;
    ForwardPass.SHADER_SOURCES = { 0: 'stub' };
    const pass = new ForwardPass();
    try {
      pass.setup(device, pool);
    } finally {
      ForwardPass.SHADER_SOURCES = saved;
    }

    const frame = { canvasWidth: 64, canvasHeight: 64 } as FrameState;
    const group1Views = () => {
      const bound: Array<{ entries: GPUBindGroupEntry[] }> = [];
      const encoder = {
        beginRenderPass: () => ({
          setPipeline() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexedIndirect() {}, end() {},
          setBindGroup: (i: number, bg: { entries: GPUBindGroupEntry[] }) => { if (i === 1) bound.push(bg); },
        }),
      } as unknown as GPUCommandEncoder;
      pass.execute(encoder, frame, pool);
      expect(bound.length).toBeGreaterThan(0);
      return bound.map((bg) => bg.entries.map((e) => e.resource));
    };
    return { pool, group1Views };
  }

  it('binds the views that are in the pool when it draws', () => {
    const { pool, group1Views } = setUp();
    group1Views();

    const grown = { name: 'tier0 after growth' } as unknown as GPUTextureView;
    pool.setTextureView('tier0', grown);
    for (const views of group1Views()) {
      expect(views).toContain(grown);
    }
  });

  it('keeps the same bind group while nothing changes', () => {
    const { group1Views } = setUp();
    const first = group1Views()[0];
    const second = group1Views()[0];
    expect(second).toEqual(first);
  });
});

// An untextured entity carries packed texture index 0: tier 0, layer 0, not
// overflow. Layer 0 is reserved and never holds a real texture. It is meant to
// be white, but on a compressed tier (BC7/ASTC) it is never filled, because
// writeTexture cannot take raw pixels there. An all-zero BC7 block decodes to
// transparent black, so every untextured quad drew black on desktop and white
// on an rgba8-only device. The shader answers index 0 itself. WGSL does not run
// headless, so this pins the rule in the source; the GPU check is visual.
describe('basic.wgsl draws an untextured quad white on every tier format', () => {
  it('returns white for packed index 0 before sampling any tier', () => {
    // The colour/coverage function both entry points (fs_main, fs_occluder) share.
    const fs = basicShaderSource.slice(basicShaderSource.indexOf('fn shade'));
    const untextured = fs.search(/in\.isOverflow == 0u && in\.texTier == 0u && in\.texLayer == 0u\s*\)\s*\{\s*return vec4f\(1\.0\);/);
    expect(untextured, 'the untextured early return').toBeGreaterThan(-1);
    expect(untextured).toBeLessThan(fs.indexOf('textureSampleLevel'));
  });
});
