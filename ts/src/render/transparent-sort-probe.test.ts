import { describe, it, expect, vi, beforeAll, afterEach, type Mock } from 'vitest';
import { TransparentSortProbe, type SortProbeSource } from './transparent-sort-probe';
import { TransparentSortPass, SORT_READBACK_BYTES, type SortReadbackTarget } from './passes/transparent-sort-pass';
import { ResourcePool } from './resource-pool';
import { nextFrameStamp } from './frame-inputs';
import type { FrameState } from './render-pass';
import {
  CAP, HEADER_BYTES, TILE, TILES_OFFSET, DIGIT_BASE_OFFSET, DIAG_WORDS, PASSES, RADIX,
  H_DRAW, H_DISPATCH, H_RAW, H_LIMIT, H_OVERFLOW, H_STAMP, STAMP_SENTINEL,
} from './passes/transparent-sort-constants';

// WebGPU bitflag globals for Node/vitest, as in debug-probe.test.ts.
beforeAll(() => {
  if (typeof globalThis.GPUBufferUsage === 'undefined') {
    (globalThis as any).GPUBufferUsage = {
      MAP_READ: 0x0001, MAP_WRITE: 0x0002,
      COPY_SRC: 0x0004, COPY_DST: 0x0008,
      INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040,
      STORAGE: 0x0080, INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
    };
  }
  if (typeof globalThis.GPUMapMode === 'undefined') {
    (globalThis as any).GPUMapMode = { READ: 0x0001, WRITE: 0x0002 };
  }
  if (typeof globalThis.GPUShaderStage === 'undefined') {
    (globalThis as any).GPUShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
  }
});

interface FakeBuffer {
  size: number;
  usage: number;
  label?: string;
  data: ArrayBuffer;
  destroyed: boolean;
  mapAsync: Mock;
  getMappedRange: () => ArrayBuffer;
  unmap: Mock;
  destroy: () => void;
}

const STAGING = ['gatherKeys', 'gatherVals', 'header', 'hist', 'order'] as const;

/** Anything the pass asks the device for besides buffers (modules, layouts, pipelines, bind groups): inert. */
function opaque(): any {
  return new Proxy(function () {}, {
    get: (_t, key) => (key === 'then' ? undefined : opaque()),
    apply: () => opaque(),
  });
}

/** Buffers are real memory the test fills as the GPU would; everything else is inert. */
function mockDevice() {
  const buffers: FakeBuffer[] = [];
  const base = {
    createBuffer: (d: GPUBufferDescriptor): FakeBuffer => {
      const b: FakeBuffer = {
        size: d.size, usage: d.usage, label: d.label, data: new ArrayBuffer(d.size), destroyed: false,
        mapAsync: vi.fn(async () => {}),
        getMappedRange: () => b.data,
        unmap: vi.fn(),
        destroy: () => { b.destroyed = true; },
      };
      buffers.push(b);
      return b;
    },
    queue: { writeBuffer: vi.fn(), submit: vi.fn() },
  };
  const device = new Proxy(base, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : key === 'then' ? undefined : () => opaque()),
  }) as unknown as GPUDevice;
  return { device, buffers };
}

const fake = (b: GPUBuffer): FakeBuffer => b as unknown as FakeBuffer;
const words = (b: GPUBuffer): Uint32Array => new Uint32Array(fake(b).data);

interface GpuResult {
  stamp: number;
  n: number;
  raw?: number;
  limit?: number;
  overflow?: boolean;
  lo?: number[];
  hi?: number[];
  vals?: number[];
  order?: number[];
  /** [index into the PASSES × RADIX rows, value] */
  digitBase?: Array<[number, number]>;
  diag?: number[];
}

/** What the copies of a served frame leave in its staging buffers, with garbage past n the answer must not show. */
function writeGpu(t: SortReadbackTarget, g: GpuResult): void {
  const header = words(t.header);
  header.fill(0);
  header.set([6, g.n, 0, 0, 0], H_DRAW);
  header.set([Math.ceil(g.n / TILE), 1, 1], H_DISPATCH);
  header[H_RAW] = g.raw ?? g.n;
  header[H_LIMIT] = g.limit ?? g.n;
  header[H_OVERFLOW] = g.overflow ? 1 : 0;
  header[H_STAMP] = g.stamp;
  const keys = words(t.gatherKeys);
  keys.fill(0xdead);
  keys.set(g.lo ?? [], 0);
  keys.set(g.hi ?? [], CAP);
  const vals = words(t.gatherVals);
  vals.fill(0xbeef);
  vals.set(g.vals ?? [], 0);
  const hist = words(t.hist);
  hist.set(g.diag ?? [], 0);
  for (const [i, v] of g.digitBase ?? []) hist[DIGIT_BASE_OFFSET + i] = v;
  const order = words(t.order);
  order.fill(77);
  order.set(g.order ?? [], 0);
}

/** A three-row frame; row 3 is stale data past entityCount, which the snapshot must drop. */
function makeSource(stamp: number): SortProbeSource {
  return {
    tickCount: 42, stamp, entityCount: 3, transparentCount: 3, idsGeneration: 9, idsUploaded: true, usedScatter: true,
    viewProjection: Float32Array.from({ length: 16 }, (_, i) => i),
    bounds: new Float32Array([0, 0, 0, 1, 1, 1, -1, 1, 2, 2, -2, 1, 9, 9, 9, 9]),
    entityIds: new Uint32Array([10, 11, 12, 99]),
    renderMeta: new Uint32Array([0, 0x100, 0, 0x101, 0, 0x104, 0, 0]),
    texIndices: new Uint32Array([0, 0, 1 << 16, 0]),
  };
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('TransparentSortProbe', () => {
  it('take() hands the head request fresh MAP_READ | COPY_DST buffers, sized for what the pass copies', () => {
    const { device, buffers } = mockDevice();
    const probe = new TransparentSortProbe(device);
    expect(probe.take(1)).toBeNull(); // nothing queued: nothing allocated
    expect(buffers).toHaveLength(0);
    void probe.request();
    void probe.request();
    expect(probe.hasPending).toBe(true);
    const t = probe.take(1)!;
    expect(t.stamp).toBe(1);
    // The literal sizes check them independently of the pass; SORT_READBACK_BYTES is what the pass copies.
    const sizes = { gatherKeys: 2 * CAP * 4, gatherVals: CAP * 4, header: HEADER_BYTES, hist: TILES_OFFSET * 4, order: CAP * 4 };
    for (const key of STAGING) {
      expect(fake(t[key]).size, key).toBe(sizes[key]);
      expect(fake(t[key]).size, key).toBe(SORT_READBACK_BYTES[key]);
      expect(fake(t[key]).usage, key).toBe(GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    }
    expect(buffers).toHaveLength(5);
    // Nothing is mapped before the frame is submitted.
    for (const b of buffers) expect(b.mapAsync).not.toHaveBeenCalled();
    // One request per frame: the second waits for the next frame.
    expect(probe.take(1)).toBeNull();
    expect(probe.hasPending).toBe(true);
  });

  it('finish() maps after the frame and answers with a snapshot of the frame taken at once, every array cut to n', async () => {
    const { device, buffers } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const pending = probe.request();
    const t = probe.take(5)!;
    writeGpu(t, {
      stamp: 5, n: 2, raw: 2, limit: 3, lo: [11, 12], hi: [0x80000000, 0x7fffffff], vals: [1, 2], order: [2, 1],
      digitBase: [[3 * RADIX + 5, 1]],
    });
    const source = makeSource(5);
    probe.finish(source, Promise.resolve([]));
    for (const b of buffers) expect(b.mapAsync).toHaveBeenCalledWith(GPUMapMode.READ);
    // The renderer's arrays belong to the next frame from here on.
    source.bounds[0] = 123;
    source.entityIds[0] = 999;
    source.viewProjection[0] = -1;
    const r = await pending;
    expect([r.n, r.raw, r.limit, r.overflow]).toEqual([2, 2, 3, false]);
    expect(Array.from(r.gathered.lo)).toEqual([11, 12]);
    expect(Array.from(r.gathered.hi)).toEqual([0x80000000, 0x7fffffff]);
    expect(Array.from(r.gathered.vals)).toEqual([1, 2]);
    expect(Array.from(r.order)).toEqual([2, 1]);
    expect(r.digitBase).toHaveLength(PASSES * RADIX);
    expect(r.digitBase[3 * RADIX + 5]).toBe(1);
    expect(r.diag).toHaveLength(DIAG_WORDS);
    expect(r.frame).toMatchObject({
      tickCount: 42, stamp: 5, entityCount: 3, transparentCount: 3, idsGeneration: 9, idsUploaded: true, usedScatter: true,
    });
    expect(Array.from(r.frame.bounds)).toEqual([0, 0, 0, 1, 1, 1, -1, 1, 2, 2, -2, 1]);
    expect(Array.from(r.frame.entityIds)).toEqual([10, 11, 12]);
    expect(Array.from(r.frame.renderMeta)).toEqual([0, 0x100, 0, 0x101, 0, 0x104]);
    expect(Array.from(r.frame.texIndices)).toEqual([0, 0, 1 << 16]);
    expect(r.frame.viewProjection[0]).toBe(0);
    for (const b of buffers) {
      expect(b.unmap).toHaveBeenCalled();
      expect(b.destroyed).toBe(true);
    }
  });

  it('two requests issued together read two consecutive frames, each in its own buffers', async () => {
    const { device } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const first = probe.request();
    const second = probe.request();
    let secondSettled = false;
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });

    const t1 = probe.take(1)!;
    writeGpu(t1, { stamp: 1, n: 1, lo: [10], hi: [5], vals: [0], order: [0] });
    probe.finish(makeSource(1), Promise.resolve([]));
    const r1 = await first;
    await settled();
    expect(secondSettled).toBe(false); // still queued, not rejected
    expect(probe.hasPending).toBe(true);

    const t2 = probe.take(nextFrameStamp(1))!;
    for (const key of STAGING) expect(t2[key]).not.toBe(t1[key]);
    writeGpu(t2, { stamp: 2, n: 1, lo: [10], hi: [5], vals: [0], order: [0] });
    probe.finish(makeSource(2), Promise.resolve([]));
    const r2 = await second;
    expect(r2.frame.stamp).toBe(nextFrameStamp(r1.frame.stamp));
  });

  it('a frame whose sort did not run rejects only the head of the queue', async () => {
    const { device } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const a = probe.request();
    const b = probe.request();
    probe.finish(makeSource(1), null); // nothing taken: count 0
    await expect(a).rejects.toThrow(/no transparent entities this frame/);
    expect(probe.hasPending).toBe(true);
    const t = probe.take(2)!;
    writeGpu(t, { stamp: 2, n: 0 });
    probe.finish(makeSource(2), Promise.resolve([]));
    await expect(b).resolves.toMatchObject({ n: 0 });
    probe.finish(makeSource(3), null); // an empty queue: nothing to reject
  });

  it('a frame whose render threw rejects the taken request and every queued one, and frees the taken buffers', async () => {
    const { device, buffers } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const a = probe.request();
    const b = probe.request();
    const t = probe.take(1)!;
    probe.failFrame(new Error('encoder exploded'));
    await expect(a).rejects.toThrow(/encoder exploded/);
    await expect(b).rejects.toThrow(/encoder exploded/);
    expect(probe.hasPending).toBe(false);
    for (const key of STAGING) expect(fake(t[key]).destroyed).toBe(true);
    for (const buf of buffers) expect(buf.mapAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['the copies never ran (header word 11 is 0, fresh staging), even at the first stamp', 1, 0, /copy never ran/],
    ['the gather never ran (header word 11 is still the sentinel)', 5, STAMP_SENTINEL, /gather never ran/],
    ["the header is another frame's", 5, 4, /stamp 4, not this frame's 5/],
  ])('rejects, instead of answering zeros, when %s', async (_what, stamp, word, message) => {
    const { device, buffers } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const pending = probe.request();
    const t = probe.take(stamp)!;
    if (word !== 0) writeGpu(t, { stamp: word, n: 1, lo: [1], hi: [1], vals: [0], order: [0] });
    probe.finish(makeSource(stamp), Promise.resolve([]));
    await expect(pending).rejects.toThrow(message);
    for (const b of buffers) expect(b.destroyed).toBe(true);
  });

  it('rejects when the frame failed GPU validation, or when the snapshot is of another frame', async () => {
    const { device } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const invalid = probe.request();
    const t = probe.take(3)!;
    writeGpu(t, { stamp: 3, n: 1, lo: [1], hi: [1], vals: [0], order: [0] });
    probe.finish(makeSource(3), Promise.resolve(['Destroyed buffer used in a submit']));
    await expect(invalid).rejects.toThrow(/GPU validation: Destroyed buffer used in a submit/);

    const mismatched = probe.request();
    probe.take(4);
    probe.finish(makeSource(5), Promise.resolve([]));
    await expect(mismatched).rejects.toThrow(/snapshot has stamp 5, the sort was read at 4/);
  });

  it('destroy() rejects every request: queued, taken, and still mapping', async () => {
    const { device, buffers } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const mapping = probe.request();
    const taken = probe.request();
    const queued = probe.request();
    const t1 = probe.take(1)!;
    for (const key of STAGING) fake(t1[key]).mapAsync.mockImplementation(() => new Promise(() => {}));
    probe.finish(makeSource(1), Promise.resolve([]));
    probe.take(2);
    probe.destroy();
    await expect(mapping).rejects.toThrow(/destroyed/);
    await expect(taken).rejects.toThrow(/destroyed/);
    await expect(queued).rejects.toThrow(/destroyed/);
    for (const b of buffers) expect(b.destroyed).toBe(true);
    await expect(probe.request()).rejects.toThrow(/destroyed/);
    expect(probe.take(3)).toBeNull();
  });
});

describe('TransparentSortPass with the probe (fake device)', () => {
  const saved = { gather: TransparentSortPass.GATHER_SOURCE, sort: TransparentSortPass.SORT_SOURCE };
  afterEach(() => {
    TransparentSortPass.GATHER_SOURCE = saved.gather;
    TransparentSortPass.SORT_SOURCE = saved.sort;
  });

  type Call = { method: string; args: unknown[] };

  /** A device, the pool buffers the renderer creates (renderer.ts step 3), a recording encoder, a frame. */
  function rig(transparentCount: number) {
    TransparentSortPass.GATHER_SOURCE = 'gather';
    TransparentSortPass.SORT_SOURCE = 'sort';
    const { device, buffers } = mockDevice();
    const U = GPUBufferUsage;
    const pool = new ResourcePool();
    const add = (name: string, size: number, usage: number): void =>
      pool.setBuffer(name, device.createBuffer({ size, usage, label: name }));
    add('indirect-args', 28 * 5 * 4, U.STORAGE | U.INDIRECT | U.COPY_DST);
    add('visible-indices', 28 * CAP * 4, U.STORAGE);
    add('entity-bounds', CAP * 16, U.STORAGE | U.COPY_DST);
    add('entity-ids', CAP * 4, U.STORAGE | U.COPY_DST | U.COPY_SRC);
    add('transparent-order', CAP * 4, U.STORAGE | U.COPY_SRC);
    add('transparent-args', HEADER_BYTES, U.STORAGE | U.INDIRECT | U.COPY_DST | U.COPY_SRC);
    const calls: Call[] = [];
    const recorder = (): any => new Proxy({}, {
      get: (_t, key) => (key === 'then' ? undefined : (...args: unknown[]) => {
        calls.push({ method: String(key), args });
        return key === 'beginComputePass' ? recorder() : opaque();
      }),
    });
    const frame = { entityCount: transparentCount, transparentCount, frameStamp: 3 } as unknown as FrameState;
    return { device, buffers, pool, calls, encoder: recorder() as GPUCommandEncoder, frame };
  }
  const copies = (calls: Call[]): Call[] => calls.filter((c) => c.method === 'copyBufferToBuffer');
  /** copyBufferToBuffer(src, srcOffset, dst, dstOffset, size), or the (src, dst, size) overload. */
  const destination = (c: Call): FakeBuffer => (typeof c.args[1] === 'number' ? c.args[2] : c.args[1]) as FakeBuffer;
  const isStaging = (b: FakeBuffer): boolean => (b.usage & GPUBufferUsage.MAP_READ) !== 0;

  it('prepare() and execute() never map; the copies of a readback frame land only in the buffers the request owns', () => {
    const { device, buffers, pool, calls, encoder, frame } = rig(10);
    const probe = new TransparentSortProbe(device);
    const take = vi.spyOn(probe, 'take');
    void probe.request();
    const pass = new TransparentSortPass(probe);
    pass.setup(device, pool);
    pass.prepare(device, frame);
    pass.execute(encoder, frame, pool);
    expect(take).toHaveBeenCalledWith(3); // FrameState.frameStamp
    for (const b of buffers) expect(b.mapAsync).not.toHaveBeenCalled();
    const staging = buffers.filter(isStaging);
    expect(staging).toHaveLength(5); // made by take(), for this request
    const targets = new Set(copies(calls).map(destination));
    expect(targets.size).toBe(5);
    for (const b of targets) expect(staging).toContain(b);
    for (const c of copies(calls)) expect(isStaging(c.args[0] as FakeBuffer)).toBe(false);
    expect(probe.hasPending).toBe(false);
    // A pass destroyed by a graph swap leaves the request's buffers alone.
    pass.destroy();
    for (const b of staging) expect(b.destroyed).toBe(false);
  });

  it('a pass built without the probe (the hot-reload probe pass) never touches the requests', () => {
    const { device, buffers, pool, calls, encoder, frame } = rig(10);
    const probe = new TransparentSortProbe(device);
    void probe.request();
    const pass = new TransparentSortPass();
    pass.setup(device, pool);
    pass.prepare(device, frame);
    pass.execute(encoder, frame, pool);
    expect(probe.hasPending).toBe(true);
    expect(buffers.filter(isStaging)).toHaveLength(0);
    expect(copies(calls)).toHaveLength(0);
    pass.destroy();
  });

  it('with no transparent entity the pass takes nothing, and finish() rejects the head only', async () => {
    const { device, pool, encoder, frame } = rig(0);
    const probe = new TransparentSortProbe(device);
    const head = probe.request();
    void probe.request();
    const pass = new TransparentSortPass(probe);
    pass.setup(device, pool);
    pass.prepare(device, frame);
    pass.execute(encoder, frame, pool);
    probe.finish(makeSource(3), Promise.resolve([]));
    await expect(head).rejects.toThrow(/no transparent entities this frame/);
    expect(probe.hasPending).toBe(true);
    pass.destroy();
  });
});
