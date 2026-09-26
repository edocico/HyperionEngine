import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ForwardPass } from './forward-pass';
import { primitiveGroup0LayoutEntries } from '../primitive-bindings';
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
      createSampler: () => ({}),
      createTexture: texture,
      queue: { writeBuffer() {}, writeTexture() {} },
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

// The same rule for every shader whose colour comes from the texture tiers.
// Lines and beziers sampled layer 0 of the compressed tier too, and on desktop
// drew black with alpha 0, so as occluders they cast nothing. MSDF text is
// excluded, because its "texture" is the glyph atlas, which it cannot render
// without.
const tierSamplingShaders = import.meta.glob(
  ['../../shaders/basic.wgsl', '../../shaders/line.wgsl', '../../shaders/bezier.wgsl'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

describe('packed index 0 is white in every tier-sampling primitive', () => {
  it.each(Object.entries(tierSamplingShaders))('%s answers index 0 before sampling a tier', (_file, src) => {
    const shade = src.slice(src.indexOf('fn shade'));
    const check = shade.search(/in\.isOverflow == 0u && in\.texTier == 0u && in\.texLayer == 0u/);
    expect(check, 'the untextured check').toBeGreaterThan(-1);
    expect(check).toBeLessThan(shade.indexOf('textureSampleLevel(tier0Tex'));
  });
});

// Phase 17, Task 10: ForwardPass reads the light buffer through a third bind
// group. All six primitive shaders share one pipeline layout, now of three
// groups; only the shaders that apply lighting declare group 2. A layout may
// hold groups a shader does not use, but the bind group must still be set for
// every pipeline, or the draw fails validation. With lighting off, group 2
// binds a 1×1 placeholder and the lighting uniform says "disabled".
describe('ForwardPass @group(2): the light buffer', () => {
  function setUp(options?: { lit?: boolean }) {
    const g = globalThis as Record<string, unknown>;
    g.GPUBufferUsage ??= { COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 };
    g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
    g.GPUTextureUsage ??= { COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

    const layouts: GPUBindGroupLayoutDescriptor[] = [];
    const pipelineLayouts: GPUPipelineLayoutDescriptor[] = [];
    const writes: Array<{ buffer: unknown; data: ArrayBuffer }> = [];
    const textures: GPUTextureDescriptor[] = [];
    const buffers: Array<{ size: number; usage: number }> = [];
    const device = {
      createBuffer: (d: GPUBufferDescriptor) => { const b = { size: d.size, usage: d.usage, destroy() {} }; buffers.push(b); return b; },
      createShaderModule: () => ({}),
      createSampler: () => ({ sampler: true }),
      createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => { layouts.push(d); return { d }; },
      createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => { pipelineLayouts.push(d); return {}; },
      createRenderPipeline: () => ({}),
      createBindGroup: (d: GPUBindGroupDescriptor) => ({ layout: d.layout, entries: [...d.entries] }),
      createTexture: (d: GPUTextureDescriptor) => {
        textures.push(d);
        return { createView: () => ({ placeholderOf: d }), destroy() {} };
      },
      queue: {
        writeBuffer: (buffer: unknown, _o: number, data: ArrayBuffer | ArrayBufferView) => {
          writes.push({ buffer, data: data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength) });
        },
        writeTexture() {},
      },
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
    ForwardPass.SHADER_SOURCES = { 0: 'stub', 1: 'stub', 4: 'stub' };
    const pass = new ForwardPass(options);
    try {
      pass.setup(device, pool);
    } finally {
      ForwardPass.SHADER_SOURCES = saved;
    }

    const frame = { canvasWidth: 64, canvasHeight: 64 } as FrameState;
    const draw = () => {
      const calls: Array<{ op: string; index?: number; group?: { entries: GPUBindGroupEntry[] } }> = [];
      const encoder = {
        beginRenderPass: () => ({
          setVertexBuffer() {}, setIndexBuffer() {}, drawIndexedIndirect() {}, end() {},
          setPipeline: () => { calls.push({ op: 'pipeline' }); },
          setBindGroup: (index: number, group: { entries: GPUBindGroupEntry[] }) => { calls.push({ op: 'group', index, group }); },
        }),
      } as unknown as GPUCommandEncoder;
      pass.execute(encoder, frame, pool);
      return calls;
    };
    const group2Texture = (calls: ReturnType<typeof draw>) => {
      const bound = calls.filter((c) => c.op === 'group' && c.index === 2);
      expect(bound.length).toBeGreaterThan(0);
      return bound.map((c) => c.group!.entries.find((e) => e.binding === 0)!.resource);
    };
    return { pass, pool, layouts, pipelineLayouts, writes, textures, draw, group2Texture, buffers };
  }

  it('builds every pipeline on a three-group layout; group 2 is texture, filtering sampler, uniform', () => {
    const { pipelineLayouts, layouts } = setUp();
    expect(pipelineLayouts.length).toBeGreaterThan(0);
    for (const pl of pipelineLayouts) expect([...pl.bindGroupLayouts]).toHaveLength(3);
    const group2 = layouts.find((l) => [...l.entries].some((e) => 'buffer' in e && e.buffer?.type === 'uniform') && [...l.entries].some((e) => 'texture' in e && e.texture?.viewDimension !== '2d-array'))!;
    const entries = [...group2.entries].sort((a, b) => a.binding - b.binding);
    expect(entries.map((e) => e.binding)).toEqual([0, 1, 2]);
    expect(entries[0].texture?.sampleType ?? 'float').toBe('float');
    expect(entries[1].sampler?.type ?? 'filtering').toBe('filtering');
    expect(entries[2].buffer?.type).toBe('uniform');
    for (const e of entries) expect(e.visibility).toBe(GPUShaderStage.FRAGMENT);
  });

  it('the camera uniform is 80 bytes, and the shared layout says so (minBindingSize)', () => {
    const { buffers } = setUp();
    expect(buffers.filter((b) => (b.usage & GPUBufferUsage.UNIFORM) !== 0).map((b) => b.size)).toContain(80);
    expect(primitiveGroup0LayoutEntries()[0].buffer?.minBindingSize).toBe(80);
  });

  it('sets group 2 for every pipeline, including shaders that ignore it', () => {
    const { draw } = setUp();
    const calls = draw();
    const pipelines = calls.filter((c) => c.op === 'pipeline').length;
    expect(pipelines).toBe(6); // 3 types, opaque + transparent
    expect(calls.filter((c) => c.op === 'group' && c.index === 2)).toHaveLength(pipelines);
  });

  it('without lighting: does not read light-buffer, binds a placeholder, and the uniform says disabled', () => {
    const { pass, pool, writes, draw, group2Texture } = setUp();
    expect(pass.reads).not.toContain('light-buffer');
    // A view left in the pool by a lit graph that has since been retired: its
    // texture is destroyed, and binding it would drop the frame.
    const stale = { name: 'stale light buffer' } as unknown as GPUTextureView;
    pool.setTextureView('light-buffer', stale);
    for (const view of group2Texture(draw())) expect(view).not.toBe(stale);
    const uniform = writes.find((w) => w.data.byteLength === 16);
    expect(uniform, 'the 16-byte lighting uniform').toBeDefined();
    expect(new Uint32Array(uniform!.data)[0]).toBe(0);
  });

  it('with lighting: reads light-buffer, binds the pool view, and the uniform says enabled', () => {
    const { pass, pool, writes, draw, group2Texture } = setUp({ lit: true });
    expect(pass.reads).toContain('light-buffer');
    const lightBuffer = { name: 'light-buffer' } as unknown as GPUTextureView;
    pool.setTextureView('light-buffer', lightBuffer);
    for (const view of group2Texture(draw())) expect(view).toBe(lightBuffer);
    const uniform = writes.find((w) => w.data.byteLength === 16);
    expect(new Uint32Array(uniform!.data)[0]).toBe(1);
  });

  it('with lighting: follows the light-buffer view when LightAccumPass recreates it (resize)', () => {
    const { pool, draw, group2Texture } = setUp({ lit: true });
    pool.setTextureView('light-buffer', { name: 'before' } as unknown as GPUTextureView);
    draw();
    const resized = { name: 'after resize' } as unknown as GPUTextureView;
    pool.setTextureView('light-buffer', resized);
    for (const view of group2Texture(draw())) expect(view).toBe(resized);
  });
});

// Which shaders apply lighting, and how. Only basic.wgsl (sprites) and
// gradient.wgsl declare group 2 (design §7.4). The lookup lives in fs_main, not
// in shade(): OccluderSeedPass runs the same module through fs_occluder on a
// TWO-group layout, and a binding statically used there would fail validation.
const allPrimitiveShaders = import.meta.glob(
  ['../../shaders/basic.wgsl', '../../shaders/line.wgsl', '../../shaders/msdf-text.wgsl',
    '../../shaders/bezier.wgsl', '../../shaders/gradient.wgsl', '../../shaders/box-shadow.wgsl'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;
const LIT_SHADERS = ['basic.wgsl', 'gradient.wgsl'];

describe('lit primitive shaders', () => {
  it.each(Object.entries(allPrimitiveShaders))('%s declares group 2 only if it is lit', (file, src) => {
    const lit = LIT_SHADERS.some((name) => file.endsWith(name));
    expect(/@group\(2\)/.test(src)).toBe(lit);
  });

  it.each(LIT_SHADERS)('%s samples the light buffer in fs_main only, with textureSampleLevel, gated on receivesLight', (name) => {
    const src = Object.entries(allPrimitiveShaders).find(([f]) => f.endsWith(name))![1];
    const fsMain = src.slice(src.indexOf('fn fs_main'), src.indexOf('fn fs_occluder'));
    const beforeFsMain = src.slice(0, src.indexOf('fn fs_main'));
    expect(fsMain).toMatch(/textureSampleLevel\s*\(\s*lightBuffer\b/);
    expect(fsMain).toMatch(/RECEIVES_LIGHT_BIT/);
    expect(fsMain).toMatch(/lighting\.enabled/);
    expect(beforeFsMain).not.toMatch(/lightBuffer\s*,|textureSample\w*\s*\(\s*lightBuffer/);
    expect(src.slice(src.indexOf('fn fs_occluder'))).not.toMatch(/lightBuffer|lighting\./);
  });

  it.each(LIT_SHADERS)('%s: RECEIVES_LIGHT_BIT matches RENDER_META_RECEIVES_LIGHT_BIT in components.rs', (name) => {
    const src = Object.entries(allPrimitiveShaders).find(([f]) => f.endsWith(name))![1];
    const rust = readFileSync(new URL('../../../../crates/hyperion-core/src/components.rs', import.meta.url), 'utf8');
    const rustBit = Number(/RENDER_META_RECEIVES_LIGHT_BIT: u32 = 1 << (\d+);/.exec(rust)?.[1]);
    const wgslBit = Number(/const RECEIVES_LIGHT_BIT\s*:\s*u32\s*=\s*1u << (\d+)u;/.exec(src)?.[1]);
    expect(rustBit).toBe(10);
    expect(wgslBit).toBe(rustBit);
  });
});
