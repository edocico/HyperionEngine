import { describe, it, expect, beforeAll } from 'vitest';
import { LightGroupsPass } from './light-groups-pass';
import { LightAccumStage } from './light-accum-stage';
import { SdfChainStage } from './sdf-chain-stage';
import { ResourcePool } from '../resource-pool';
import type { FrameState } from '../render-pass';
import type { LightGroups } from '../light-groups';
import lightShaderSource from '../../shaders/light-accum.wgsl?raw';
import sdfShaderSource from '../../shaders/sdf-jfa.wgsl?raw';

// LightGroupsPass (design 2026-09-26) is the one graph node of the lit
// backend. Per frame it runs SET-MAJOR: for each SDF set, seed its occluders,
// flood the SDF, then accumulate every light group that uses that set into its
// own layer of the light buffer; the groups with no set last, against a
// "no occluder" SDF. One seed and one ping-pong pair serve every set, so the
// SDF memory does not grow with the number of sets.

const OCCLUDER = 'fn fs_occluder(in: VertexOutput) -> @location(0) vec4f { return vec4f(0.0); }';

type Tex = { desc: GPUTextureDescriptor; destroyed: boolean; views: View[] };
type View = { tex: Tex; d: GPUTextureViewDescriptor | undefined };

function setUp() {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 };
  g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
  g.GPUTextureUsage ??= { COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

  const textures: Tex[] = [];
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, usage: d.usage, destroy() {} }),
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => ({ d }),
    createBindGroup: (d: GPUBindGroupDescriptor) => ({ entries: [...d.entries] }),
    createTexture: (desc: GPUTextureDescriptor) => {
      const t: Tex = { desc, destroyed: false, views: [] };
      textures.push(t);
      return {
        createView: (d?: GPUTextureViewDescriptor) => { const v: View = { tex: t, d }; t.views.push(v); return v; },
        destroy() { t.destroyed = true; },
      };
    },
    queue: { writeBuffer() {}, writeTexture() {} },
  } as unknown as GPUDevice;

  const pool = new ResourcePool();
  for (const name of ['entity-transforms', 'visible-indices', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params']) {
    pool.setBuffer(name, {} as GPUBuffer);
  }
  for (const name of ['tier0', 'tier1', 'tier2', 'tier3', 'ovf0', 'ovf1', 'ovf2', 'ovf3']) {
    pool.setTextureView(name, { name } as unknown as GPUTextureView);
  }
  pool.setSampler('texSampler', {} as GPUSampler);

  const pass = new LightGroupsPass({ 0: OCCLUDER });
  pass.setup(device, pool);

  /** Render one frame. Returns the events: one per render pass (its target) or stage name. */
  const frame = (lightGroups: LightGroups | undefined, w = 128, h = 64, withStage = false) => {
    const f = { canvasWidth: w, canvasHeight: h, cameraViewProjection: new Float32Array(16), lightGroups } as unknown as FrameState;
    const events: Array<{ kind: 'pass'; target: View; sdf?: View } | { kind: 'stage'; name: string }> = [];
    const encoder = {
      beginRenderPass: (desc: GPURenderPassDescriptor) => {
        const ev = { kind: 'pass' as const, target: [...desc.colorAttachments][0]!.view as unknown as View, sdf: undefined as View | undefined };
        events.push(ev);
        return {
          setPipeline() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexedIndirect() {}, draw() {}, end() {},
          setBindGroup: (_i: number, bg: { entries: GPUBindGroupEntry[] }) => {
            const sdf = bg.entries.find((e) => e.binding === 5);
            if (sdf) ev.sdf = sdf.resource as unknown as View;
          },
        };
      },
    } as unknown as GPUCommandEncoder;
    pass.prepare(device, f);
    pass.execute(encoder, f, pool, withStage ? (name: string) => { events.push({ kind: 'stage', name }); } : undefined);
    return events;
  };
  const label = (v: View) => `${v.tex.desc.label}${v.d?.baseArrayLayer !== undefined ? `#${v.d.baseArrayLayer}` : ''}`;
  const passes = (events: ReturnType<typeof frame>) =>
    events.filter((e): e is { kind: 'pass'; target: View; sdf?: View } => e.kind === 'pass');
  return { pass, pool, textures, frame, label, passes, device };
}

function groups(gs: Array<[number, number]>, sets: number[]): LightGroups {
  return {
    groups: gs.map(([layers, sdfSet]) => ({ layers, sdfSet })),
    sdfSets: sets.map((occluderLayers) => ({ occluderLayers })),
    layerToGroup: [0, 0], multiBitReceiver: false, lightMasks: [], occluderMasks: [],
  };
}

describe('LightGroupsPass', () => {
  beforeAll(() => {
    LightAccumStage.SHADER_SOURCE = lightShaderSource;
    SdfChainStage.SHADER_SOURCE = sdfShaderSource;
  });

  it('is the lit backend\'s one node: reads the scene columns, writes light-buffer, culled when unread', () => {
    const pass = new LightGroupsPass({});
    expect(pass.name).toBe('light-groups');
    expect(pass.writes).toEqual(['light-buffer']);
    expect(pass.optional).toBe(true);
    for (const r of ['visible-indices', 'entity-transforms', 'indirect-args', 'render-meta', 'tex-indices', 'prim-params']) {
      expect(pass.reads).toContain(r);
    }
  });

  it('runs set-major: seed, flood, then the groups of that set; the groups without a set last', () => {
    const { frame, label, passes } = setUp();
    const lg = groups([[1, 0], [2, 1], [4, 0], [8, -1]], [5, 2]);
    const got = passes(frame(lg)).map((e) => label(e.target));
    // 128x64 canvas: a 64x32 SDF, 1 + 6 steps.
    const chain = ['light-sdf-a', 'light-sdf-b', 'light-sdf-a', 'light-sdf-b', 'light-sdf-a', 'light-sdf-b', 'light-sdf-a'];
    expect(got).toEqual([
      'light-seed', ...chain, 'light-buffer#0', 'light-buffer#2',
      'light-seed', ...chain, 'light-buffer#1',
      'light-buffer#3',
    ]);
  });

  it('accumulates each group against its set\'s final SDF, and a group without a set against "no occluder"', () => {
    const { frame, label, passes } = setUp();
    const accum = passes(frame(groups([[1, 0], [2, -1]], [1]))).filter((e) => label(e.target).startsWith('light-buffer'));
    expect(label(accum[0].sdf!)).toBe('light-sdf-a');
    expect(label(accum[1].sdf!)).toBe('light-no-occluder');
  });

  it('reuses ONE seed and ONE ping-pong pair for every set', () => {
    const { frame, textures } = setUp();
    frame(groups([[1, 0], [2, 1], [4, 2]], [1, 2, 4]));
    for (const name of ['light-seed', 'light-sdf-a', 'light-sdf-b']) {
      expect(textures.filter((t) => t.desc.label === name)).toHaveLength(1);
    }
  });

  it('the light buffer is a 2d-array, one layer per group, rendered one layer at a time', () => {
    const { frame, textures, pool, label, passes } = setUp();
    const events = frame(groups([[1, 0], [2, 0], [4, -1]], [3]));
    const buffer = textures.find((t) => t.desc.label === 'light-buffer')!;
    expect((buffer.desc.size as GPUExtent3DDict).depthOrArrayLayers).toBe(3);
    expect(buffer.desc.textureBindingViewDimension).toBe('2d-array');
    for (const e of passes(events).filter((p) => label(p.target).startsWith('light-buffer'))) {
      expect(e.target.d).toMatchObject({ dimension: '2d', arrayLayerCount: 1 });
    }
    const sampled = pool.getTextureView('light-buffer') as unknown as View;
    expect(sampled.tex).toBe(buffer);
    expect(sampled.d?.dimension).toBe('2d-array');
  });

  it('without lightGroups, one group of every layer over one set of every caster: today\'s frame', () => {
    const { frame, label, passes } = setUp();
    const got = passes(frame(undefined)).map((e) => label(e.target));
    expect(got[0]).toBe('light-seed');
    expect(got.at(-1)).toBe('light-buffer#0');
    expect(got.filter((l) => l.startsWith('light-buffer'))).toHaveLength(1);
  });

  it('no shadowed light: no seed and no flood at all', () => {
    const { frame, label, passes } = setUp();
    expect(passes(frame(groups([[1, -1]], []))).map((e) => label(e.target))).toEqual(['light-buffer#0']);
  });

  it('group count oscillates without reallocation: the array grows, never shrinks, views are reused', () => {
    const { frame, textures, passes } = setUp();
    const one = groups([[1, -1]], []);
    const three = groups([[1, -1], [2, -1], [4, -1]], []);
    const first = passes(frame(one))[0].target;
    frame(three);
    const afterGrow = passes(frame(one))[0].target;
    frame(three);
    const buffers = textures.filter((t) => t.desc.label === 'light-buffer');
    expect(buffers).toHaveLength(2);           // 1 layer, then 3: never back to 1
    expect(buffers[1].destroyed).toBe(false);
    expect(first.tex).toBe(buffers[0]);
    expect(passes(frame(one))[0].target).toBe(afterGrow);
  });

  it('resize recreates every texture and view, and the pool follows', () => {
    const { frame, textures, pool } = setUp();
    frame(groups([[1, 0], [2, 0]], [3]), 128, 64);
    const before = pool.getTextureView('light-buffer');
    const old = textures.slice();
    frame(groups([[1, 0], [2, 0]], [3]), 256, 64);
    for (const t of old.filter((t) => t.desc.label !== 'light-no-occluder')) expect(t.destroyed).toBe(true);
    expect(pool.getTextureView('light-buffer')).not.toBe(before);
    const seed = textures.filter((t) => t.desc.label === 'light-seed').at(-1)!;
    expect(seed.desc.size).toMatchObject({ width: 128, height: 32 });
  });

  it('names each stage for the profiler just before it runs: seed, sdf, accum per set, then accum for set-less groups', () => {
    const { frame } = setUp();
    const lg = groups([[1, 0], [2, 1], [4, -1]], [1, 2]);
    const events = frame(lg, 128, 64, true);
    const names = events.flatMap((e) => (e.kind === 'stage' ? [e.name] : []));
    expect(names).toEqual(['seed', 'sdf', 'accum', 'seed', 'sdf', 'accum', 'accum']);
    expect(events[0].kind).toBe('stage');
  });
});
