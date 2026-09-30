import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  TransparentSortPass, SORT_READBACK_BYTES, type SortReadbackTaker, type SortReadbackTarget,
} from './transparent-sort-pass';
import { ResourcePool } from '../resource-pool';
import type { FrameState } from '../render-pass';
import { TOTAL_DRAW_BUCKETS } from './cull-pass';
import {
  CAP, DIAG_WORDS, DISPATCH_OFFSET_BYTES, HEADER_BYTES, HIST_WORDS, PASSES, PASS_PARAMS_STRIDE,
  STAMP_SENTINEL, TILES_OFFSET,
} from './transparent-sort-constants';
import gatherSource from '../../shaders/transparent-gather.wgsl?raw';
import sortSource from '../../shaders/transparent-sort.wgsl?raw';

// TransparentSortPass (Phase 5b, design 2026-09-27 §5) on a recording device.
// WebGPU cannot run headless; what these tests hold is the contract the GPU
// does not report back cleanly: uniforms written only where writeBuffer is safe
// (never in execute), one PassParams slice per pass, the A/B direction, the
// dispatch sizes, the profiler's stage list, minBindingSize everywhere, and a
// setup() that never writes the pool it reads.

const USAGE = {
  MAP_READ: 0x1, MAP_WRITE: 0x2, COPY_SRC: 0x4, COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20,
  UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100, QUERY_RESOLVE: 0x200,
};
const STAGE = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

type Buf = { label: string; size: number; usage: number; destroyed: boolean; destroy(): void };
type Layout = { desc: GPUBindGroupLayoutDescriptor };
type Group = { desc: GPUBindGroupDescriptor };
type Pipeline = { desc: GPUComputePipelineDescriptor };
type Write = { buffer: Buf; offset: number; words: number[] };
type Copy = { kind: 'copy'; src: Buf; srcOffset: number; dst: Buf; dstOffset: number; size: number };
type Cmd =
  | { kind: 'pass' }
  | { kind: 'end' }
  | { kind: 'stage'; name: string }
  | { kind: 'pipeline'; entry: string }
  | { kind: 'group'; index: number; group: Group }
  | { kind: 'dispatch'; x: number }
  | { kind: 'indirect'; buffer: Buf; offset: number }
  | Copy;

function fakeBuffer(label: string, size: number, usage = 0): Buf {
  const b: Buf = { label, size, usage, destroyed: false, destroy() { b.destroyed = true; } };
  return b;
}

/** A device that records what the pass creates and writes. */
function makeDevice() {
  Object.assign(globalThis, { GPUBufferUsage: USAGE, GPUShaderStage: STAGE });
  const buffers: Buf[] = [];
  const layouts: Layout[] = [];
  const groups: Group[] = [];
  const pipelines: Pipeline[] = [];
  const writes: Write[] = [];
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => {
      const b = fakeBuffer(d.label ?? '', d.size, d.usage);
      buffers.push(b);
      return b;
    },
    createShaderModule: (d: GPUShaderModuleDescriptor) => ({ code: d.code }),
    createBindGroupLayout: (desc: GPUBindGroupLayoutDescriptor) => { const l = { desc }; layouts.push(l); return l; },
    createPipelineLayout: (desc: GPUPipelineLayoutDescriptor) => ({ desc }),
    createComputePipeline: (desc: GPUComputePipelineDescriptor) => { const p = { desc }; pipelines.push(p); return p; },
    createBindGroup: (desc: GPUBindGroupDescriptor) => { const g = { desc }; groups.push(g); return g; },
    queue: {
      // Copied at call time, like the real queue: the pass reuses its arrays.
      writeBuffer: (buffer: Buf, offset: number, data: Uint32Array) => {
        writes.push({ buffer, offset, words: Array.from(data) });
      },
    },
  } as unknown as GPUDevice;
  const byLabel = (label: string): Buf => {
    const b = buffers.find((x) => x.label === label);
    if (!b) throw new Error(`the pass created no buffer '${label}'`);
    return b;
  };
  return { device, buffers, layouts, groups, pipelines, writes, byLabel };
}

/** The pool buffers the pass reads, sized as createRenderer allocates them. */
const POOL_SIZES: Record<string, number> = {
  'indirect-args': TOTAL_DRAW_BUCKETS * 5 * 4,
  'visible-indices': TOTAL_DRAW_BUCKETS * CAP * 4,
  'entity-bounds': CAP * 16,
  'entity-ids': CAP * 4,
  'transparent-args': HEADER_BYTES,
  'transparent-order': CAP * 4,
};

function makePool(omit?: string) {
  const pool = new ResourcePool();
  const named: Record<string, Buf> = {};
  for (const [name, size] of Object.entries(POOL_SIZES)) {
    if (name === omit) continue;
    named[name] = fakeBuffer(name, size);
    pool.setBuffer(name, named[name] as unknown as GPUBuffer);
  }
  return { pool, named };
}

function setUp(probe: SortReadbackTaker | null = null) {
  const gpu = makeDevice();
  const { pool, named } = makePool();
  const pass = new TransparentSortPass(probe);
  pass.setup(gpu.device, pool);
  return { ...gpu, pool, named, pass };
}

const frameOf = (transparentCount: number, frameStamp = 7) =>
  ({ transparentCount, frameStamp, entityCount: transparentCount }) as unknown as FrameState;

/** An encoder that records passes, dispatches, copies and profiler stage names in order. */
function record() {
  const cmds: Cmd[] = [];
  const encoder = {
    beginComputePass: () => {
      cmds.push({ kind: 'pass' });
      return {
        setPipeline: (p: Pipeline) => { cmds.push({ kind: 'pipeline', entry: p.desc.compute.entryPoint! }); },
        setBindGroup: (index: number, group: Group) => { cmds.push({ kind: 'group', index, group }); },
        dispatchWorkgroups: (x: number) => { cmds.push({ kind: 'dispatch', x }); },
        dispatchWorkgroupsIndirect: (buffer: Buf, offset: number) => { cmds.push({ kind: 'indirect', buffer, offset }); },
        end: () => { cmds.push({ kind: 'end' }); },
      };
    },
    copyBufferToBuffer: (src: Buf, srcOffset: number, dst: Buf, dstOffset: number, size: number) => {
      cmds.push({ kind: 'copy', src, srcOffset, dst, dstOffset, size });
    },
  } as unknown as GPUCommandEncoder;
  const stage = (name: string) => { cmds.push({ kind: 'stage', name }); };
  return { encoder, cmds, stage };
}

/**
 * One entry per dispatch: its pipeline's entry point, its bind group 0, its size or indirect source.
 * A pass starts with nothing set, and a dispatch needs both set inside ITS OWN pass: carried across
 * passes, the two would let a refactor that stopped setting them in each of the 22 measured passes
 * go unseen headless, while on the GPU it drops every measured frame.
 */
function dispatches(cmds: Cmd[]) {
  const out: Array<{ entry: string; group: Group; x?: number; indirect?: { buffer: Buf; offset: number } }> = [];
  let entry = '';
  let group: Group | null = null;
  const dispatchAt = (i: number) => {
    if (entry === '' || group === null) {
      throw new Error(`command ${i}: a dispatch with no pipeline and bind group 0 set in its own pass`);
    }
    return { entry, group };
  };
  cmds.forEach((c, i) => {
    if (c.kind === 'pass') { entry = ''; group = null; }
    else if (c.kind === 'pipeline') entry = c.entry;
    else if (c.kind === 'group' && c.index === 0) group = c.group;
    else if (c.kind === 'dispatch') out.push({ ...dispatchAt(i), x: c.x });
    else if (c.kind === 'indirect') out.push({ ...dispatchAt(i), indirect: { buffer: c.buffer, offset: c.offset } });
  });
  return out;
}

function fakeTarget(stamp: number): SortReadbackTarget {
  const staging = (label: string, size: number) =>
    fakeBuffer(label, size, USAGE.MAP_READ | USAGE.COPY_DST) as unknown as GPUBuffer;
  return {
    stamp,
    gatherKeys: staging('rb-gather-keys', SORT_READBACK_BYTES.gatherKeys),
    gatherVals: staging('rb-gather-vals', SORT_READBACK_BYTES.gatherVals),
    header: staging('rb-header', SORT_READBACK_BYTES.header),
    hist: staging('rb-hist', SORT_READBACK_BYTES.hist),
    order: staging('rb-order', SORT_READBACK_BYTES.order),
  };
}

function bufferBinding(g: Group, binding: number): GPUBufferBinding {
  const e = [...g.desc.entries].find((x) => x.binding === binding);
  if (!e) throw new Error(`${g.desc.label}: no binding ${binding}`);
  return e.resource as GPUBufferBinding;
}
const bufferOf = (g: Group, binding: number) => bufferBinding(g, binding).buffer as unknown as Buf;

const STAGES = ['gather', ...Array.from({ length: PASSES }, () => ['upsweep', 'scan', 'scatter']).flat()];
const ENTRY: Record<string, string> = {
  gather: 'gather_main', upsweep: 'upsweep_main', scan: 'scan_main', scatter: 'scatter_main',
};

beforeAll(() => {
  TransparentSortPass.GATHER_SOURCE = gatherSource;
  TransparentSortPass.SORT_SOURCE = sortSource;
});
afterAll(() => {
  TransparentSortPass.GATHER_SOURCE = '';
  TransparentSortPass.SORT_SOURCE = '';
});

describe('TransparentSortPass as a graph node', () => {
  it('reads the cull outputs, the bounds and the id column; writes the two pool buffers; optional', () => {
    const pass = new TransparentSortPass();
    expect(pass.name).toBe('transparent-sort');
    expect(pass.reads).toEqual(['indirect-args', 'visible-indices', 'entity-bounds', 'entity-ids']);
    expect(pass.writes).toEqual(['transparent-order', 'transparent-args']);
    expect(pass.optional).toBe(true);
  });

  it('a pass never set up writes nothing and encodes nothing, measured or not', () => {
    const { device, writes } = makeDevice();
    const pass = new TransparentSortPass();
    const { encoder, cmds, stage } = record();
    pass.prepare(device, frameOf(10));
    pass.execute(encoder, frameOf(10), new ResourcePool(), stage);
    pass.execute(encoder, frameOf(10), new ResourcePool());
    expect(writes).toEqual([]);
    expect(cmds).toEqual([]);
  });
});

describe('TransparentSortPass.setup', () => {
  it('throws without its shader sources', () => {
    const saved = TransparentSortPass.SORT_SOURCE;
    TransparentSortPass.SORT_SOURCE = '';
    try {
      expect(() => setUp()).toThrow(/SORT_SOURCE/);
    } finally {
      TransparentSortPass.SORT_SOURCE = saved;
    }
  });

  it.each(Object.keys(POOL_SIZES))('throws naming a missing pool buffer (%s), before allocating anything', (name) => {
    const gpu = makeDevice();
    const { pool } = makePool(name);
    expect(() => new TransparentSortPass().setup(gpu.device, pool)).toThrow(name);
    expect(gpu.buffers).toEqual([]);
  });

  it('reads the pool and never writes it: a hot-reload probe runs setup() on the LIVE pool', () => {
    const gpu = makeDevice();
    const { pool } = makePool();
    const spies = [
      vi.spyOn(pool, 'setBuffer'), vi.spyOn(pool, 'setTexture'),
      vi.spyOn(pool, 'setTextureView'), vi.spyOn(pool, 'setSampler'),
    ];
    new TransparentSortPass().setup(gpu.device, pool);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('allocates its private buffers at CAP, with COPY_SRC in dev for the readback', () => {
    const { buffers, byLabel } = setUp();
    expect(buffers).toHaveLength(6);
    expect(byLabel('sort-keys-a')).toMatchObject({ size: 2 * CAP * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
    expect(byLabel('sort-keys-b')).toMatchObject({ size: 2 * CAP * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
    expect(byLabel('sort-vals-a')).toMatchObject({ size: CAP * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
    expect(byLabel('sort-hist')).toMatchObject({
      size: HIST_WORDS * 4, usage: USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC,
    });
    expect(HIST_WORDS * 4).toBe(107_584);
    expect(byLabel('sort-gather-params')).toMatchObject({ size: 16, usage: USAGE.UNIFORM | USAGE.COPY_DST });
    expect(byLabel('sort-pass-params')).toMatchObject({
      size: PASSES * PASS_PARAMS_STRIDE, usage: USAGE.UNIFORM | USAGE.COPY_DST,
    });
  });

  it('writes the 7 PassParams slices once, slice p = {p, 0, 0, 0} at 256·p, and nothing else', () => {
    const { writes, byLabel } = setUp();
    const params = byLabel('sort-pass-params');
    expect(writes).toHaveLength(1);
    expect(writes[0].buffer).toBe(params);
    expect(writes[0].offset).toBe(0);
    const W = PASS_PARAMS_STRIDE / 4;
    expect(writes[0].words).toHaveLength(PASSES * W);
    for (let p = 0; p < PASSES; p++) expect(writes[0].words.slice(p * W, p * W + 4)).toEqual([p, 0, 0, 0]);
  });

  it('builds the four pipelines on their entry points: gather on its layout, the three stages on the other', () => {
    const { pipelines, layouts } = setUp();
    expect(pipelines.map((p) => p.desc.compute.entryPoint)).toEqual(['gather_main', 'upsweep_main', 'scan_main', 'scatter_main']);
    const code = (p: Pipeline) => (p.desc.compute.module as unknown as { code: string }).code;
    expect(code(pipelines[0])).toBe(gatherSource);
    for (const p of pipelines.slice(1)) expect(code(p)).toBe(sortSource);
    const groupLayouts = (p: Pipeline) =>
      [...(p.desc.layout as unknown as { desc: GPUPipelineLayoutDescriptor }).desc.bindGroupLayouts];
    const byName = (label: string) => layouts.find((l) => l.desc.label === label);
    expect(groupLayouts(pipelines[0])).toEqual([byName('transparent-gather')]);
    for (const p of pipelines.slice(1)) expect(groupLayouts(p)[0]).toBe(byName('transparent-sort'));
  });

  it('gives every layout entry a minBindingSize, and binds buffers at least that big', () => {
    const { layouts, groups } = setUp();
    expect(layouts).toHaveLength(2);
    for (const l of layouts) {
      for (const e of l.desc.entries) {
        expect(e.buffer?.minBindingSize, `${l.desc.label} b${e.binding}`).toBeGreaterThan(0);
        expect(e.visibility).toBe(STAGE.COMPUTE);
      }
    }
    for (const g of groups) {
      const layout = (g.desc.layout as unknown as Layout).desc;
      for (const e of g.desc.entries) {
        const le = [...layout.entries].find((x) => x.binding === e.binding)!;
        const r = e.resource as GPUBufferBinding;
        const size = r.size ?? (r.buffer as unknown as Buf).size - (r.offset ?? 0);
        expect(size, `${g.desc.label} b${e.binding}`).toBeGreaterThanOrEqual(le.buffer!.minBindingSize!);
      }
    }
    // The fixed-size bindings are exactly their WGSL size.
    const min = (label: string, binding: number) =>
      [...layouts.find((l) => l.desc.label === label)!.desc.entries].find((e) => e.binding === binding)!.buffer!.minBindingSize;
    expect(min('transparent-gather', 0)).toBe(16);
    expect(min('transparent-gather', 7)).toBe(HEADER_BYTES);
    expect(min('transparent-sort', 0)).toBe(16);
    expect(min('transparent-sort', 5)).toBe(HEADER_BYTES);
  });

  it.each([['transparent-gather', 7, gatherSource], ['transparent-sort', 6, sortSource]] as const)(
    '%s: the layout entries match the WGSL declarations, %i storage buffers',
    (label, storage, src) => {
      const { layouts } = setUp();
      const WGSL_TO_LAYOUT: Record<string, GPUBufferBindingType> = {
        'uniform': 'uniform', 'storage,read': 'read-only-storage', 'storage,read_write': 'storage',
      };
      const declared = [...src.replace(/\/\/[^\n]*/g, '').matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var<([^>]+)>/g)]
        .map((m) => ({ group: Number(m[1]), binding: Number(m[2]), type: WGSL_TO_LAYOUT[m[3].replace(/\s+/g, '')] }));
      expect(declared.every((d) => d.group === 0)).toBe(true);
      const entries = [...layouts.find((l) => l.desc.label === label)!.desc.entries];
      expect(entries.map((e) => [e.binding, e.buffer!.type])).toEqual(declared.map((d) => [d.binding, d.type]));
      expect(entries.filter((e) => e.buffer!.type !== 'uniform')).toHaveLength(storage);
    },
  );

  it('creates 8 bind groups: the gather\'s, then one per pass with its slice and its direction', () => {
    const { groups, named } = setUp();
    expect(groups).toHaveLength(1 + PASSES);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((b) => bufferOf(groups[0], b).label)).toEqual([
      'sort-gather-params', 'indirect-args', 'visible-indices', 'entity-bounds', 'entity-ids',
      'sort-keys-a', 'sort-vals-a', 'transparent-args',
    ]);
    for (let p = 0; p < PASSES; p++) {
      const g = groups[1 + p];
      expect(bufferOf(g, 0).label).toBe('sort-pass-params');
      expect(bufferBinding(g, 0)).toMatchObject({ offset: p * PASS_PARAMS_STRIDE, size: 16 });
      const io = p % 2 === 0
        ? ['sort-keys-a', 'sort-vals-a', 'sort-keys-b', 'transparent-order']   // A → B
        : ['sort-keys-b', 'transparent-order', 'sort-keys-a', 'sort-vals-a'];  // B → A
      expect([1, 2, 3, 4, 5, 6].map((b) => bufferOf(g, b).label)).toEqual([...io, 'transparent-args', 'sort-hist']);
    }
    // PASSES is odd: the last pass writes its values into transparent-order.
    expect(bufferOf(groups[PASSES], 4)).toBe(named['transparent-order']);
  });
});

describe('TransparentSortPass.prepare', () => {
  it('writes GatherParams, the header reset and the zeroed diag — once each, every frame', () => {
    const { pass, device, writes } = setUp();
    const before = writes.length;
    pass.prepare(device, frameOf(1234, 42));
    const w = writes.slice(before);
    expect(w.map((x) => x.buffer.label)).toEqual(['sort-gather-params', 'transparent-args', 'sort-hist']);
    expect(w[0]).toMatchObject({ offset: 0, words: [1234, 42, 0, 0] });
    expect(w[1]).toMatchObject({
      offset: 0, words: [6, 0, 0, 0, 0, 0, 1, 1, 0, 1234, 0, STAMP_SENTINEL, 0, 0, 0, 0],
    });
    expect(w[2]).toMatchObject({ offset: 0, words: new Array(DIAG_WORDS).fill(0) });

    pass.prepare(device, frameOf(5, 43));
    const w2 = writes.slice(before + 3);
    expect(w2).toHaveLength(3);
    expect(w2[0].words).toEqual([5, 43, 0, 0]);
    expect(w2[1].words[9]).toBe(5);
  });

  it('bounds the gather at CAP', () => {
    const { pass, device, writes } = setUp();
    const before = writes.length;
    pass.prepare(device, frameOf(250_000, 1));
    const w = writes.slice(before);
    expect(w[0].words[0]).toBe(CAP);
    expect(w[1].words[9]).toBe(CAP);
  });

  it('still resets the header at count 0: the draw args say 0 instances', () => {
    const { pass, device, writes } = setUp();
    const before = writes.length;
    pass.prepare(device, frameOf(0, 2));
    const w = writes.slice(before);
    expect(w).toHaveLength(3);
    expect(w[1].words.slice(0, 5)).toEqual([6, 0, 0, 0, 0]);
  });
});

describe('TransparentSortPass.execute', () => {
  it('at 100000: one compute pass — gather 391, then per pass upsweep and scatter indirect at 20, scan 1', () => {
    const { pass, device, pool, groups, named } = setUp();
    const f = frameOf(100_000);
    pass.prepare(device, f);
    const { encoder, cmds } = record();
    pass.execute(encoder, f, pool);
    expect(cmds.filter((c) => c.kind === 'pass')).toHaveLength(1);
    const d = dispatches(cmds);
    expect(d).toHaveLength(1 + 3 * PASSES);
    expect(d[0]).toMatchObject({ entry: 'gather_main', x: 391 });
    expect(d[0].group).toBe(groups[0]);
    expect(DISPATCH_OFFSET_BYTES).toBe(20);
    for (let p = 0; p < PASSES; p++) {
      const [up, scan, scatter] = d.slice(1 + 3 * p, 4 + 3 * p);
      expect(up.entry).toBe('upsweep_main');
      expect(up.indirect).toEqual({ buffer: named['transparent-args'], offset: 20 });
      expect(scan).toMatchObject({ entry: 'scan_main', x: 1 });
      expect(scatter.entry).toBe('scatter_main');
      expect(scatter.indirect).toEqual({ buffer: named['transparent-args'], offset: 20 });
      for (const s of [up, scan, scatter]) expect(s.group).toBe(groups[1 + p]);
    }
  });

  it.each([[1000, 4], [256, 1], [257, 2]])('sizes the gather from the bound: %i → %i workgroups', (count, workgroups) => {
    const { pass, device, pool } = setUp();
    pass.prepare(device, frameOf(count));
    const { encoder, cmds } = record();
    pass.execute(encoder, frameOf(count), pool);
    expect(dispatches(cmds)[0]).toMatchObject({ entry: 'gather_main', x: workgroups });
  });

  it('never writes a buffer: a writeBuffer lands before the NEXT submit', () => {
    const target = fakeTarget(3);
    const { pass, device, pool, writes } = setUp({ take: () => target });
    const f = frameOf(4000, 3);
    pass.prepare(device, f);
    const before = writes.length;
    for (const withStage of [false, true]) {
      const { encoder, stage } = record();
      pass.execute(encoder, f, pool, withStage ? stage : undefined);
    }
    expect(writes.length).toBe(before);
  });

  it.each([0, Number.NaN])('count %s: encodes nothing, measured or not', (count) => {
    const { pass, device, pool } = setUp();
    const f = frameOf(count);
    pass.prepare(device, f);
    const { encoder, cmds, stage } = record();
    pass.execute(encoder, f, pool);
    pass.execute(encoder, f, pool, stage);
    expect(cmds).toEqual([]);
  });

  it('with the profiler: 22 compute passes, each right after its stage name — gather, then upsweep/scan/scatter seven times', () => {
    const { pass, device, pool } = setUp();
    const f = frameOf(5000);
    pass.prepare(device, f);
    const { encoder, cmds, stage } = record();
    pass.execute(encoder, f, pool, stage);
    const names = cmds.flatMap((c) => (c.kind === 'stage' ? [c.name] : []));
    expect(names).toEqual(STAGES);
    expect(names).toHaveLength(22);
    expect(cmds.filter((c) => c.kind === 'pass')).toHaveLength(22);
    cmds.forEach((c, i) => { if (c.kind === 'stage') expect(cmds[i + 1].kind).toBe('pass'); });
    expect(dispatches(cmds).map((d) => d.entry)).toEqual(STAGES.map((s) => ENTRY[s]));
  });

  it('with a readback request: gather, its output copied, the sort in a second pass, then header, hist and order', () => {
    const target = fakeTarget(9);
    const probe = { take: vi.fn((_stamp: number): SortReadbackTarget | null => target) };
    const { pass, device, pool } = setUp(probe);
    const f = frameOf(3000, 9);
    pass.prepare(device, f);
    const { encoder, cmds } = record();
    pass.execute(encoder, f, pool);
    expect(probe.take).toHaveBeenCalledTimes(1);
    expect(probe.take).toHaveBeenCalledWith(9);
    expect(cmds.filter((c) => c.kind === 'pass' || c.kind === 'end' || c.kind === 'copy').map((c) => c.kind))
      .toEqual(['pass', 'end', 'copy', 'copy', 'pass', 'end', 'copy', 'copy', 'copy']);
    const copies = cmds.filter((c): c is Copy => c.kind === 'copy');
    expect(copies.map((c) => [c.src.label, c.srcOffset, c.dst.label, c.dstOffset, c.size])).toEqual([
      ['sort-keys-a', 0, 'rb-gather-keys', 0, 2 * CAP * 4],
      ['sort-vals-a', 0, 'rb-gather-vals', 0, CAP * 4],
      ['transparent-args', 0, 'rb-header', 0, HEADER_BYTES],
      ['sort-hist', 0, 'rb-hist', 0, TILES_OFFSET * 4],
      ['transparent-order', 0, 'rb-order', 0, CAP * 4],
    ]);
    const firstEnd = cmds.findIndex((c) => c.kind === 'end');
    expect(dispatches(cmds.slice(0, firstEnd)).map((d) => d.entry)).toEqual(['gather_main']);
    expect(dispatches(cmds.slice(firstEnd))).toHaveLength(3 * PASSES);
  });

  it('with a readback request and the profiler: 22 passes, the gather output copied right after the first', () => {
    const target = fakeTarget(5);
    const { pass, device, pool } = setUp({ take: () => target });
    const f = frameOf(2000, 5);
    pass.prepare(device, f);
    const { encoder, cmds, stage } = record();
    pass.execute(encoder, f, pool, stage);
    expect(cmds.filter((c) => c.kind === 'pass')).toHaveLength(22);
    expect(cmds.filter((c) => c.kind === 'stage')).toHaveLength(22);
    const firstEnd = cmds.findIndex((c) => c.kind === 'end');
    expect(cmds.slice(firstEnd + 1, firstEnd + 3).map((c) => c.kind)).toEqual(['copy', 'copy']);
    expect(cmds[firstEnd + 3].kind).toBe('stage');
    expect(cmds.slice(-3).map((c) => c.kind)).toEqual(['copy', 'copy', 'copy']);
  });

  it('asks the probe only in a frame the sort runs, once; no request means no copy and one pass', () => {
    const probe = { take: vi.fn((_stamp: number): SortReadbackTarget | null => null) };
    const { pass, device, pool } = setUp(probe);
    const { encoder, cmds } = record();
    pass.prepare(device, frameOf(0, 11));
    pass.execute(encoder, frameOf(0, 11), pool);
    expect(probe.take).not.toHaveBeenCalled();
    pass.prepare(device, frameOf(10, 12));
    pass.execute(encoder, frameOf(10, 12), pool);
    expect(probe.take).toHaveBeenCalledTimes(1);
    expect(probe.take).toHaveBeenCalledWith(12);
    expect(cmds.filter((c) => c.kind === 'copy')).toEqual([]);
    expect(cmds.filter((c) => c.kind === 'pass')).toHaveLength(1);
  });

  it('in a production build (__DEV__ false) never takes a request, even with a probe: its buffers lack COPY_SRC', () => {
    vi.stubGlobal('__DEV__', false);
    try {
      const target = fakeTarget(4);
      const probe = { take: vi.fn((_stamp: number): SortReadbackTarget | null => target) };
      const { pass, device, pool, byLabel } = setUp(probe);
      expect(byLabel('sort-keys-a').usage & USAGE.COPY_SRC).toBe(0);
      const f = frameOf(3000, 4);
      pass.prepare(device, f);
      for (const withStage of [false, true]) {
        const { encoder, cmds, stage } = record();
        pass.execute(encoder, f, pool, withStage ? stage : undefined);
        expect(cmds.filter((c) => c.kind === 'copy')).toEqual([]);
        // The sort itself still runs: one pass, or one per stage with the profiler.
        expect(dispatches(cmds)).toHaveLength(1 + 3 * PASSES);
        expect(cmds.filter((c) => c.kind === 'pass')).toHaveLength(withStage ? 22 : 1);
      }
      expect(probe.take).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('copies diag + digitBase of sort-hist, never the tiles', () => {
    expect(SORT_READBACK_BYTES).toEqual({
      gatherKeys: 2 * CAP * 4, gatherVals: CAP * 4, header: HEADER_BYTES, hist: TILES_OFFSET * 4, order: CAP * 4,
    });
    expect(TILES_OFFSET).toBe(DIAG_WORDS + PASSES * 256);
  });
});

describe('TransparentSortPass.destroy', () => {
  it('destroys its own buffers, never the pool\'s, and encodes nothing afterwards', () => {
    const { pass, pool, buffers, named } = setUp();
    pass.destroy();
    expect(buffers.every((b) => b.destroyed)).toBe(true);
    for (const b of Object.values(named)) expect(b.destroyed).toBe(false);
    const { encoder, cmds } = record();
    pass.execute(encoder, frameOf(10), pool);
    expect(cmds).toEqual([]);
  });
});

// createRenderer needs a GPU, so its wiring is checked as text, as
// light-groups.test.ts already does for renderer.ts. A missing accept block
// turns every kernel edit into a full page reload, which on this machine loses
// the device.
describe('renderer wiring', () => {
  const renderer = readFileSync(new URL('../../renderer.ts', import.meta.url), 'utf8');

  it('imports both kernels and publishes them before GraphRequests seeds its good sources', () => {
    const gather = /import (\w+) from '\.\/shaders\/transparent-gather\.wgsl\?raw';/.exec(renderer);
    const sort = /import (\w+) from '\.\/shaders\/transparent-sort\.wgsl\?raw';/.exec(renderer);
    expect(gather).not.toBeNull();
    expect(sort).not.toBeNull();
    const requests = renderer.indexOf('new GraphRequests<');
    for (const publish of [
      `TransparentSortPass.GATHER_SOURCE = ${gather![1]};`,
      `TransparentSortPass.SORT_SOURCE = ${sort![1]};`,
    ]) {
      expect(renderer.indexOf(publish), publish).toBeGreaterThan(-1);
      expect(renderer.indexOf(publish), publish).toBeLessThan(requests);
    }
  });

  it('creates transparent-order and transparent-args in the pool before the first graph is set up', () => {
    const host = renderer.indexOf('new RenderGraphHost(');
    for (const name of ['transparent-order', 'transparent-args']) {
      const at = renderer.indexOf(`resources.setBuffer('${name}'`);
      expect(at, name).toBeGreaterThan(-1);
      expect(at, name).toBeLessThan(host);
    }
  });

  it('runs the sort between cull and forward in the scene factory', () => {
    expect(renderer).toMatch(/new CullPass\(\), new TransparentSortPass\([^)]*\), new ForwardPass\(/);
  });

  it('gives each kernel a hot-reload slot probed by a throwaway pass, and an accept block', () => {
    for (const name of ['transparent-gather', 'transparent-sort']) {
      expect(renderer).toMatch(new RegExp(
        `'${name}': \\{[\\s\\S]*?probe: probe\\(\\(\\) => new TransparentSortPass\\(\\)\\),[\\s\\S]*?usedBy: inEveryMode`,
      ));
      expect(renderer).toContain(`import.meta.hot.accept('./shaders/${name}.wgsl?raw'`);
      expect(renderer).toContain(`recompileShader('${name}', mod.default)`);
    }
  });

  it('keeps no trace of RadixSortPass', () => {
    expect(renderer).not.toMatch(/RadixSort|radix-sort|radixSort/);
  });

  // Review wf_61c6a580-afa #4/#7/#8: the Rust docs described the transparents
  // as unsorted, a RadixSortPass, and gpu_depths feeding the sort. The sort
  // reads entity-bounds.z (TransparentSortPass); gpu_depths feeds nothing.
  it('the Rust sources name no RadixSortPass or radix sort, and never call transparents unsorted', () => {
    const dir = new URL('../../../../crates/hyperion-core/src/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.rs'));
    expect(files).toContain('components.rs');
    for (const file of files) {
      const src = readFileSync(new URL(file, dir), 'utf8');
      expect(src, file).not.toMatch(/RadixSortPass|radix[- ]sort/i);
      expect(src, file).not.toMatch(/NOT sorted/);
    }
  });
});
