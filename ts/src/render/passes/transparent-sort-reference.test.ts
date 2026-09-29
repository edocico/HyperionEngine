import { describe, it, expect } from 'vitest';
import { MAX_GPU_ENTITIES } from '../../types';
import {
  ARG_WORDS,
  CAP,
  DIAG_SCAN_MISMATCH,
  DIAG_SCATTER_OOB,
  DIAG_WORDS,
  DIGIT_BASE_OFFSET,
  DISPATCH_OFFSET_BYTES,
  FIRST_TRANSPARENT_ARG,
  GATHER_REGIONS,
  H_DISPATCH,
  H_DRAW,
  H_STAMP,
  HEADER_BYTES,
  HEADER_WORDS,
  HIST_WORDS,
  LAST_PASS,
  NUM_TILES,
  PASSES,
  RADIX,
  STAMP_SENTINEL,
  TILE,
  TILES_OFFSET,
  WORKGROUP_SIZE,
} from './transparent-sort-constants';
import {
  GlobalConflictChecker,
  STALE_WORD,
  SharedMemory,
  cpuGather,
  cpuPrepare,
  cpuScan,
  cpuScatter,
  cpuUpsweep,
  createSortModelBuffers,
  digitOf,
  oracleOrder,
  runSortModel,
  sortableZBits,
  type Schedule,
  type SortModelBuffers,
  type SortModelInput,
} from './transparent-sort-reference';

// ── Seeded randomness: no Math.random, a failure must replay ─────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rand: () => number, n: number): number {
  return Math.floor(rand() * n);
}

function identity(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

function shuffleInPlace(a: { length: number; [i: number]: number }, rand: () => number): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rand, i + 1);
    const x = a[i];
    a[i] = a[j];
    a[j] = x;
  }
}

/** Workgroups shuffled per dispatch; lanes from a pool of 16 shuffled permutations (cheap at 100k). */
function shuffledSchedule(seed: number): Schedule {
  const rand = mulberry32(seed);
  const pool: number[][] = [];
  for (let k = 0; k < 16; k++) {
    const p = identity(WORKGROUP_SIZE);
    shuffleInPlace(p, rand);
    pool.push(p);
  }
  return {
    workgroupOrder: (count) => {
      const p = identity(count);
      shuffleInPlace(p, rand);
      return p;
    },
    laneOrder: (workgroup, phase) => pool[(Math.imul(workgroup, 7) + Math.imul(phase, 13)) & 15],
  };
}

const REVERSED_LANES = identity(WORKGROUP_SIZE).reverse();
const reversedSchedule: Schedule = {
  workgroupOrder: (count) => identity(count).reverse(),
  laneOrder: () => REVERSED_LANES,
};

// ── Scenes: the cull's output as the gather sees it ──────────────────────────

const F32 = new Float32Array(1);
const F32_BITS = new Uint32Array(F32.buffer);
function f32Bits(x: number): number {
  F32[0] = x;
  return F32_BITS[0];
}
function bitsF32(bits: number): number {
  F32_BITS[0] = bits;
  return F32[0];
}

type Distribution =
  | 'equal' | 'two' | 'distinct' | 'descending' | 'extreme-ids' | 'signed-zero' | 'denormal' | 'infinite';
const DISTRIBUTIONS: Distribution[] = [
  'equal', 'two', 'distinct', 'descending', 'extreme-ids', 'signed-zero', 'denormal', 'infinite',
];
// ±0, the smallest and largest denormals, the smallest normals.
const DENORMAL_BITS = [
  0x00000000, 0x80000000, 0x00000001, 0x00000002, 0x007FFFFF,
  0x80000001, 0x80000002, 0x807FFFFF, 0x00800000, 0x80800000,
];
// ±Inf, ±FLT_MAX, 0, ±1.
const INFINITE_BITS = [0x7F800000, 0xFF800000, 0x7F7FFFFF, 0xFF7FFFFF, 0x00000000, 0x3F800000, 0xBF800000];

/** z bits of the e-th gathered element (of `count`). */
function zGenerator(dist: Distribution, count: number, rand: () => number): (e: number) => number {
  switch (dist) {
    case 'equal':
    case 'extreme-ids':
      return () => f32Bits(1.5);
    case 'two':
      return () => f32Bits(rand() < 0.5 ? -2 : 3);
    case 'distinct': {
      const perm = identity(count);
      shuffleInPlace(perm, rand);
      return (e) => f32Bits((perm[e] - count / 2) * 0.25);
    }
    case 'descending':
      return (e) => f32Bits((count - e) * 0.5);
    case 'signed-zero':
      return () => (rand() < 0.5 ? 0x00000000 : 0x80000000);
    case 'denormal':
      return () => DENORMAL_BITS[randInt(rand, DENORMAL_BITS.length)];
    case 'infinite':
      return () => INFINITE_BITS[randInt(rand, INFINITE_BITS.length)];
  }
}

const TOTAL_ARGS = 28;
const TRANSPARENT_BUCKETS = identity(GATHER_REGIONS).map((k) => FIRST_TRANSPARENT_ARG + k);
/** Opaque buckets and the transparent Light2D ones: filled on purpose, never read. */
const POISON_BUCKETS = [...identity(FIRST_TRANSPARENT_ARG), 26, 27];
const POISON_PER_BUCKET = 5;
/** Between regions: a slot no row has, so reading one is an out-of-range read. */
const GAP_WORD = 0xFFFFFFFF;

interface Scene {
  input: SortModelInput;
  /** The slots in gather order: region 0's content, then region 1's, … */
  gathered: Uint32Array;
  /** Per transparent region k: its size and its firstInstance. */
  sizes: number[];
  bases: number[];
}

interface SceneOptions {
  seed?: number;
  /** Region sizes (must sum to n); random by default, some regions empty. */
  sizes?: number[];
  /** Default: n + 37, capped at CAP — the CPU count is an upper bound (offscreen transparents count). */
  limit?: number;
  /** 'compact' (default): regions in a shuffled order with gaps. 'cull': region b at b × CAP, like cull-pass.ts. */
  layout?: 'compact' | 'cull';
}

function randomSplit(n: number, parts: number, rand: () => number): number[] {
  const sizes = new Array<number>(parts).fill(0);
  if (n === 0) return sizes;
  // Cuts at random points: uneven regions, some of them empty.
  const cuts = [0, n];
  for (let k = 0; k < parts - 1; k++) cuts.push(randInt(rand, n + 1));
  cuts.sort((a, b) => a - b);
  for (let k = 0; k < parts; k++) sizes[k] = cuts[k + 1] - cuts[k];
  return sizes;
}

/** Moves external id `value` to `row`, keeping the ids unique. */
function placeId(ids: Uint32Array, row: number, value: number): void {
  const at = ids.indexOf(value);
  if (at >= 0) ids[at] = ids[row];
  ids[row] = value;
}

function buildScene(n: number, dist: Distribution, options: SceneOptions = {}): Scene {
  const rand = mulberry32(options.seed ?? n * 31 + DISTRIBUTIONS.indexOf(dist) + 1);
  const sizes = options.sizes ?? randomSplit(n, GATHER_REGIONS, rand);
  if (sizes.length !== GATHER_REGIONS || sizes.reduce((a, b) => a + b, 0) !== n) throw new Error('sizes must sum to n');
  const rows = n + POISON_BUCKETS.length * POISON_PER_BUCKET;
  const rowOrder = identity(rows);
  shuffleInPlace(rowOrder, rand);

  const content: number[][] = Array.from({ length: TOTAL_ARGS }, () => []);
  let next = 0;
  TRANSPARENT_BUCKETS.forEach((b, k) => {
    for (let j = 0; j < sizes[k]; j++) content[b].push(rowOrder[next++]);
  });
  for (const b of POISON_BUCKETS) {
    for (let j = 0; j < POISON_PER_BUCKET; j++) content[b].push(rowOrder[next++]);
  }

  const bases = new Array<number>(TOTAL_ARGS).fill(0);
  let visibleIndices: Uint32Array;
  if (options.layout === 'cull') {
    for (let b = 0; b < TOTAL_ARGS; b++) bases[b] = b * CAP;
    visibleIndices = new Uint32Array(TOTAL_ARGS * CAP).fill(GAP_WORD);
  } else {
    const placement = identity(TOTAL_ARGS);
    shuffleInPlace(placement, rand);
    let offset = 0;
    for (const b of placement) {
      offset += randInt(rand, 4);
      bases[b] = offset;
      offset += content[b].length;
    }
    visibleIndices = new Uint32Array(offset + 3).fill(GAP_WORD);
  }
  const indirectArgs = new Uint32Array(TOTAL_ARGS * ARG_WORDS);
  for (let b = 0; b < TOTAL_ARGS; b++) {
    indirectArgs.set([6, content[b].length, 0, 0, bases[b]], b * ARG_WORDS);
    visibleIndices.set(content[b], bases[b]);
  }

  const boundsBits = new Uint32Array(rows * 4);
  const entityIds = new Uint32Array(rows);
  const idOffset = randInt(rand, 1 << 20);
  for (let r = 0; r < rows; r++) {
    // An odd multiplier is a bijection on [0, 2^20): the ids are unique.
    entityIds[r] = (Math.imul(r, 0x9E3B5) + idOffset) & 0xFFFFF;
    boundsBits[r * 4] = f32Bits(r);
    boundsBits[r * 4 + 1] = f32Bits(-r);
    boundsBits[r * 4 + 2] = f32Bits(-1e30); // a gathered poison row would sort first
    boundsBits[r * 4 + 3] = f32Bits(0.5);
  }
  const gathered = Uint32Array.from(TRANSPARENT_BUCKETS.flatMap((b) => content[b]));
  const zOf = zGenerator(dist, gathered.length, rand);
  gathered.forEach((slot, e) => {
    boundsBits[slot * 4 + 2] = zOf(e);
  });
  if (dist === 'extreme-ids' && gathered.length > 0) {
    placeId(entityIds, gathered[0], 0);
    placeId(entityIds, gathered[gathered.length - 1], 0xFFFFF);
  }
  return {
    input: {
      indirectArgs,
      visibleIndices,
      boundsBits,
      entityIds,
      limit: options.limit ?? Math.min(CAP, n + 37),
      stamp: 1 + randInt(rand, 0xFFFFFFFE),
    },
    gathered,
    sizes,
    bases: TRANSPARENT_BUCKETS.map((b) => bases[b]),
  };
}

/** The same scene with each region's content shuffled (what the cull's atomics do from frame to frame). */
function shuffleRegions(scene: Scene, seed: number): SortModelInput {
  const rand = mulberry32(seed);
  const visibleIndices = scene.input.visibleIndices.slice();
  scene.sizes.forEach((size, k) => shuffleInPlace(visibleIndices.subarray(scene.bases[k], scene.bases[k] + size), rand));
  return { ...scene.input, visibleIndices };
}

/**
 * The oracle, independent of the model: `Array.sort` of the first `count`
 * gathered slots by (float z, id). -0 === +0 and ±Inf compare as floats.
 */
function floatOracle(scene: Scene, count = scene.gathered.length): Uint32Array {
  const { boundsBits, entityIds } = scene.input;
  const slots = scene.gathered.subarray(0, count);
  const z = Array.from(slots, (s) => bitsF32(boundsBits[s * 4 + 2]));
  const id = Array.from(slots, (s) => entityIds[s]);
  const idx = identity(count);
  idx.sort((a, b) => (z[a] - z[b]) || (id[a] - id[b]));
  return Uint32Array.from(idx, (e) => slots[e]);
}

/** null when equal, else where they first differ (cheaper and clearer than toEqual at 100k). */
function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): string | null {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return `index ${i}: ${a[i]} vs ${b[i]}`;
  }
  return null;
}

function expectSorted(scene: Scene, bufs: SortModelBuffers): void {
  const n = scene.gathered.length;
  const { limit, stamp } = scene.input;
  expect(Array.from(bufs.header.subarray(0, 12))).toEqual(
    [6, n, 0, 0, 0, Math.ceil(n / TILE), 1, 1, n, limit, 0, stamp],
  );
  expect(Array.from(bufs.hist.subarray(0, DIAG_WORDS))).toEqual(new Array(DIAG_WORDS).fill(0));
  expect(firstDifference(bufs.valsB.subarray(0, n), floatOracle(scene))).toBeNull();
  // Nothing past n: transparent-order keeps the last frame's words there.
  expect(bufs.valsB.subarray(n).every((w) => w === STALE_WORD)).toBe(true);
}

/** Stable counting sort of `vals` by digit `pass`: what one scatter must produce. */
function stableCountingSort(lo: Uint32Array, hi: Uint32Array, vals: Uint32Array, pass: number) {
  const n = vals.length;
  const start = new Uint32Array(RADIX);
  for (let i = 0; i < n; i++) start[digitOf(lo[i], hi[i], pass)]++;
  let running = 0;
  for (let d = 0; d < RADIX; d++) {
    const c = start[d];
    start[d] = running;
    running += c;
  }
  const out = { lo: new Uint32Array(n), hi: new Uint32Array(n), vals: new Uint32Array(n) };
  for (let i = 0; i < n; i++) {
    const at = start[digitOf(lo[i], hi[i], pass)]++;
    out.lo[at] = lo[i];
    out.hi[at] = hi[i];
    out.vals[at] = vals[i];
  }
  return out;
}

function passBuffers(bufs: SortModelBuffers, pass: number) {
  const even = pass % 2 === 0;
  return {
    keysIn: even ? bufs.keysA : bufs.keysB,
    valsIn: even ? bufs.valsA : bufs.valsB,
    keysOut: even ? bufs.keysB : bufs.keysA,
    valsOut: even ? bufs.valsB : bufs.valsA,
  };
}

/** Gathers `scene` into fresh buffers (prepare + gather). */
function gatherScene(scene: Scene, schedule?: Schedule): SortModelBuffers {
  const bufs = createSortModelBuffers();
  cpuPrepare(bufs, scene.input.limit);
  cpuGather(scene.input, bufs, schedule);
  return bufs;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('transparent-sort constants', () => {
  it('match the design (§5.2) and the GPU capacity', () => {
    expect(CAP).toBe(MAX_GPU_ENTITIES);
    expect(NUM_TILES).toBe(98);
    expect(PASSES % 2).toBe(1); // odd: the last pass writes B = transparent-order
    expect(LAST_PASS).toBe(PASSES - 1);
    expect(TILE).toBe(4 * WORKGROUP_SIZE);
    expect(HEADER_BYTES).toBe(HEADER_WORDS * 4);
    expect(DISPATCH_OFFSET_BYTES).toBe(H_DISPATCH * 4);
    expect(HIST_WORDS * 4).toBe(107_584);
    expect(TILES_OFFSET).toBe(DIGIT_BASE_OFFSET + PASSES * RADIX);
    expect(FIRST_TRANSPARENT_ARG + GATHER_REGIONS).toBe(26); // records 26/27 are Light2D
  });
});

describe('sortableZBits', () => {
  it('maps -0 and +0 to one key', () => {
    expect(sortableZBits(0x80000000)).toBe(sortableZBits(0x00000000));
    expect(sortableZBits(0)).toBe(0x80000000);
  });

  it('orders keys like floats, infinities and denormals included', () => {
    const ascending = [
      -Infinity, -3.4028234663852886e38, -1, -1.1754943508222875e-38, -1e-45, 0,
      1e-45, 1.1754943508222875e-38, 1, 3.4028234663852886e38, Infinity,
    ];
    const keys = ascending.map((x) => sortableZBits(f32Bits(x)));
    for (let i = 1; i < keys.length; i++) expect(keys[i]).toBeGreaterThan(keys[i - 1]);
  });

  it('agrees with float comparison on random pairs', () => {
    const rand = mulberry32(11);
    // A magnitude below the +Inf pattern and a random sign: finite, never NaN.
    const finite = () => bitsF32((randInt(rand, 0x7F800000) | (rand() < 0.5 ? 0x80000000 : 0)) >>> 0);
    for (let i = 0; i < 2000; i++) {
      const a = finite();
      const b = finite();
      const ka = sortableZBits(f32Bits(a));
      const kb = sortableZBits(f32Bits(b));
      expect(Math.sign(ka - kb)).toBe(Math.sign(a - b));
    }
  });
});

describe('digitOf', () => {
  it('reads lo in passes 0-2 and hi in passes 3-6', () => {
    const lo = 0x000ABCDE;
    const hi = 0x12345678;
    expect([0, 1, 2, 3, 4, 5, 6].map((p) => digitOf(lo, hi, p))).toEqual([0xDE, 0xBC, 0x0A, 0x78, 0x56, 0x34, 0x12]);
  });
});

describe('oracleOrder', () => {
  it('sorts by hi, then lo, keeping input order on equal keys', () => {
    const vals = Uint32Array.from([10, 11, 12, 13]);
    const lo = Uint32Array.from([5, 1, 5, 0]);
    const hi = Uint32Array.from([2, 2, 2, 1]);
    expect(Array.from(oracleOrder(vals, lo, hi, 4))).toEqual([13, 11, 10, 12]);
  });
});

describe('SharedMemory (workgroup race checker)', () => {
  function lanes(shm: SharedMemory, order: number[], body: (lane: number) => void): void {
    for (const lane of order) {
      shm.setLane(lane);
      body(lane);
    }
  }

  it('lets every lane atomicAdd, atomicOr or read one word in the same phase', () => {
    const shm = new SharedMemory([['h', 2, true], ['p', 1, false]]);
    shm.reset();
    lanes(shm, identity(256), () => shm.atomicAdd(0, 1));
    lanes(shm, identity(256), (l) => shm.atomicOr(1, 1 << (l & 31)));
    shm.barrier();
    lanes(shm, identity(256), () => shm.atomicLoad(0));
    lanes(shm, identity(256), () => shm.load(2));
    expect(shm.words[0]).toBe(256);
    expect(shm.words[1]).toBe(0xFFFFFFFF);
  });

  it('lets several lanes atomicStore the same value, not different ones', () => {
    const shm = new SharedMemory([['m', 1, true]]);
    shm.reset();
    lanes(shm, [3, 7, 9], () => shm.atomicStore(0, 0));
    shm.barrier();
    expect(() => lanes(shm, [3, 7], (l) => shm.atomicStore(0, l))).toThrow(/race on m\[0\]/);
  });

  it('rejects an atomicLoad next to another lane\'s atomicAdd (order-dependent)', () => {
    const shm = new SharedMemory([['h', 1, true]]);
    shm.reset();
    shm.setLane(0);
    shm.atomicAdd(0, 1);
    shm.setLane(1);
    expect(() => shm.atomicLoad(0)).toThrow(/race on h\[0\]: lanes 0 and 1/);
  });

  it('rejects a plain write touched by another lane, in either order', () => {
    const w = new SharedMemory([['t', 4, false]]);
    w.reset();
    w.setLane(0);
    w.store(1, 5);
    w.setLane(1);
    expect(() => w.load(1)).toThrow(/race on t\[1\]/);

    const r = new SharedMemory([['t', 4, false]]);
    r.reset();
    r.setLane(1);
    r.load(1);
    r.setLane(0);
    expect(() => r.store(1, 5)).toThrow(/race on t\[1\]/);
  });

  it('lets one lane read and write its own word, and a barrier separates phases', () => {
    const shm = new SharedMemory([['t', 2, false]]);
    shm.reset();
    shm.setLane(0);
    shm.store(0, 1);
    shm.store(0, shm.load(0) + 1);
    shm.barrier();
    shm.setLane(1);
    expect(shm.load(0)).toBe(2);
  });

  it('enforces atomic<u32> versus u32 and the array bounds', () => {
    const shm = new SharedMemory([['a', 1, true], ['p', 1, false]]);
    shm.reset();
    expect(() => shm.load(0)).toThrow(/a\[0\], which is atomic<u32>/);
    expect(() => shm.atomicLoad(1)).toThrow(/p\[0\], which is u32/);
    expect(() => shm.load(2)).toThrow(RangeError);
    expect(() => shm.load(-1)).toThrow(RangeError);
  });

  it('zeroes the words on reset (a new workgroup)', () => {
    const shm = new SharedMemory([['t', 2, false]]);
    shm.reset();
    shm.store(0, 9);
    shm.reset();
    expect(shm.words[0]).toBe(0);
  });

  describe('Hillis-Steele over 256 totals in place', () => {
    const REVERSED = identity(256).reverse();
    const SHUFFLED = identity(256);
    shuffleInPlace(SHUFFLED, mulberry32(5));

    it.each([['ascending', identity(256)], ['descending', REVERSED], ['shuffled', SHUFFLED]])(
      'the two-barrier step (read into v, then write) passes with %s lanes',
      (_name, order) => {
        const shm = new SharedMemory([['totals', 256, false]]);
        shm.reset();
        lanes(shm, order, (d) => shm.store(d, 1));
        shm.barrier();
        const v = new Uint32Array(256);
        for (let off = 1; off < 256; off <<= 1) {
          lanes(shm, order, (d) => {
            v[d] = 0;
            if (d >= off) v[d] = shm.load(d - off);
          });
          shm.barrier();
          lanes(shm, order, (d) => shm.store(d, shm.load(d) + v[d]));
          shm.barrier();
        }
        expect(Array.from(shm.words)).toEqual(identity(256).map((d) => d + 1));
      },
    );

    it.each([['ascending', identity(256)], ['descending', REVERSED], ['shuffled', SHUFFLED]])(
      'an injected one-barrier step (totals[d] += totals[d - off]) throws with %s lanes',
      (_name, order) => {
        const shm = new SharedMemory([['totals', 256, false]]);
        shm.reset();
        lanes(shm, order, (d) => shm.store(d, 1));
        shm.barrier();
        expect(() => {
          for (let off = 1; off < 256; off <<= 1) {
            lanes(shm, order, (d) => {
              if (d >= off) shm.store(d, shm.load(d) + shm.load(d - off));
            });
            shm.barrier();
          }
        }).toThrow(/workgroup race on totals\[/);
      },
    );
  });
});

describe('GlobalConflictChecker (storage conflicts within a dispatch)', () => {
  it('rejects a word written by one workgroup and read by another', () => {
    const g = new GlobalConflictChecker('test');
    const buf = g.bind('buf', new Uint32Array(8), 'read_write');
    g.setInvocation(0, 3);
    buf.write(5, 1);
    g.setInvocation(1, 3);
    expect(() => buf.read(5)).toThrow(/buf\[5\] touched by invocations \(wg 0, lane 3\) and \(wg 1, lane 3\)/);
  });

  it('rejects two writers of one word, even in one workgroup', () => {
    const g = new GlobalConflictChecker('test');
    const buf = g.bind('buf', new Uint32Array(8), 'read_write');
    g.setInvocation(2, 0);
    buf.write(1, 1);
    g.setInvocation(2, 1);
    expect(() => buf.write(1, 2)).toThrow(/touched by invocations/);
  });

  it('allows read-after-write by the same invocation, shared reads and atomicOr from all', () => {
    const g = new GlobalConflictChecker('test');
    const buf = g.bind('buf', new Uint32Array(8), 'read_write');
    g.setInvocation(0, 0);
    buf.write(0, 4);
    expect(buf.read(0)).toBe(4);
    for (let wg = 0; wg < 3; wg++) {
      g.setInvocation(wg, 9);
      buf.read(1);
      buf.atomicOr(2, 1 << wg);
    }
    expect(buf.data[2]).toBe(7);
  });

  it('forgets everything at the next dispatch', () => {
    const data = new Uint32Array(4);
    const first = new GlobalConflictChecker('first');
    first.setInvocation(0, 0);
    first.bind('buf', data, 'read_write').write(0, 1);
    const second = new GlobalConflictChecker('second');
    second.setInvocation(5, 5);
    expect(second.bind('buf', data, 'read_write').read(0)).toBe(1);
  });

  it('rejects a write through a read-only binding and any out-of-range access', () => {
    const g = new GlobalConflictChecker('test');
    const ro = g.bind('ro', new Uint32Array(4), 'read');
    expect(() => ro.write(0, 1)).toThrow(/bound read-only/);
    expect(() => ro.read(4)).toThrow(RangeError);
    expect(() => ro.read(0xFFFFFFFF)).toThrow(RangeError);
  });
});

/** Phases per workgroup (by workgroup id), from the lane orders the driver asks the schedule for. */
function countPhases(run: (schedule: Schedule) => void): number[] {
  const phases = new Map<number, number>();
  run({
    laneOrder: (workgroup, phase) => {
      phases.set(workgroup, Math.max(phases.get(workgroup) ?? 0, phase + 1));
      return identity(WORKGROUP_SIZE);
    },
  });
  return [...phases.keys()].sort((a, b) => a - b).map((wg) => phases.get(wg) ?? 0);
}

describe('the driver', () => {
  it('rejects a lane order that is not a permutation of the 256 lanes', () => {
    const scene = buildScene(10, 'two');
    const bad: Schedule = { laneOrder: () => identity(255) };
    expect(() => gatherScene(scene, bad)).toThrow(/laneOrder\(0, 0\): 255 entries/);
  });

  it('rejects a workgroup order that is not a permutation', () => {
    const scene = buildScene(600, 'two'); // limit 637: 3 gather workgroups
    const bad: Schedule = { workgroupOrder: (count) => new Array<number>(count).fill(0) };
    expect(() => gatherScene(scene, bad)).toThrow(/workgroupOrder\(3, 'gather'\): not a permutation/);
  });

  it('runs the gather in 2 phases per workgroup: one barrier', () => {
    const scene = buildScene(1500, 'two');
    expect(countPhases((s) => gatherScene(scene, s)))
      .toEqual(new Array<number>(Math.ceil(scene.input.limit / WORKGROUP_SIZE)).fill(2));
  });
});

describe('cpuGather', () => {
  it('lays the 12 regions end to end: slot, id and z key per element, nothing past n', () => {
    const scene = buildScene(2047, 'distinct');
    const bufs = gatherScene(scene, shuffledSchedule(1));
    const n = scene.gathered.length;
    const { boundsBits, entityIds } = scene.input;
    expect(firstDifference(bufs.valsA.subarray(0, n), scene.gathered)).toBeNull();
    expect(firstDifference(bufs.keysA.subarray(0, n), Array.from(scene.gathered, (s) => entityIds[s]))).toBeNull();
    expect(firstDifference(
      bufs.keysA.subarray(CAP, CAP + n),
      Array.from(scene.gathered, (s) => sortableZBits(boundsBits[s * 4 + 2])),
    )).toBeNull();
    expect(bufs.valsA.subarray(n).every((w) => w === STALE_WORD)).toBe(true);
    expect(bufs.keysA.subarray(n, CAP).every((w) => w === STALE_WORD)).toBe(true);
    expect(bufs.keysA.subarray(CAP + n).every((w) => w === STALE_WORD)).toBe(true);
    expect(Array.from(bufs.header.subarray(0, 12))).toEqual(
      [6, n, 0, 0, 0, Math.ceil(n / TILE), 1, 1, n, scene.input.limit, 0, scene.input.stamp],
    );
  });

  it('reads only the count and firstInstance of records 14-25, and only inside their regions', () => {
    const scene = buildScene(1025, 'two');
    const argReads = new Set<number>();
    const indexReads = new Set<number>();
    const record = (data: Uint32Array, log: Set<number>): Uint32Array => new Proxy(data, {
      get(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) log.add(Number(prop));
        return Reflect.get(target, prop);
      },
    });
    const input = {
      ...scene.input,
      indirectArgs: record(scene.input.indirectArgs, argReads),
      visibleIndices: record(scene.input.visibleIndices, indexReads),
    };
    const bufs = createSortModelBuffers();
    cpuPrepare(bufs, input.limit);
    cpuGather(input, bufs, shuffledSchedule(2));

    const allowedArgs = new Set(TRANSPARENT_BUCKETS.flatMap((b) => [b * ARG_WORDS + 1, b * ARG_WORDS + 4]));
    expect([...argReads].filter((w) => !allowedArgs.has(w))).toEqual([]);
    const inRegion = (w: number) => scene.sizes.some((size, k) => w >= scene.bases[k] && w < scene.bases[k] + size);
    expect([...indexReads].filter((w) => !inRegion(w))).toEqual([]);
    expect(indexReads.size).toBe(scene.gathered.length);
    // The poison records (opaque 0-13, Light2D 26/27) hold 5 slots each: none is gathered.
    expect(firstDifference(bufs.valsA.subarray(0, scene.gathered.length), scene.gathered)).toBeNull();
  });

  it('takes each region base from its firstInstance: the cull layout (region b at b × CAP)', () => {
    const scene = buildScene(3000, 'two', { layout: 'cull' });
    const bufs = gatherScene(scene, shuffledSchedule(3));
    expect(firstDifference(bufs.valsA.subarray(0, scene.gathered.length), scene.gathered)).toBeNull();
  });

  it('writes the frame stamp into word 11, at both ends of its range', () => {
    for (const stamp of [1, 0xFFFFFFFE, 0x12345]) {
      const scene = buildScene(300, 'two');
      const bufs = gatherScene({ ...scene, input: { ...scene.input, stamp } });
      expect(bufs.header[H_STAMP]).toBe(stamp);
    }
  });

  it('rejects a limit above CAP: the pass clamps B', () => {
    const scene = buildScene(10, 'two');
    const bufs = createSortModelBuffers();
    expect(() => cpuGather({ ...scene.input, limit: CAP + 1 }, bufs)).toThrow(RangeError);
  });
});

describe('the radix kernels', () => {
  it('run the barrier structure of the WGSL: upsweep 3 phases, scan 18, scatter 13', () => {
    const scene = buildScene(1500, 'two');
    const bufs = gatherScene(scene);
    expect(countPhases((s) => cpuUpsweep(0, bufs, s))).toEqual([3, 3]);
    // 18 phases = 17 barriers: 1 after the column scan, then 2 per Hillis-Steele step × 8.
    expect(countPhases((s) => cpuScan(0, bufs, s))).toEqual([18]);
    // 13 phases: phase 0, then (a), (b), (c) × 4 rounds.
    expect(countPhases((s) => cpuScatter(0, bufs, s))).toEqual([13, 13]);
  });

  it('reject a pass outside 0..6', () => {
    expect(() => cpuUpsweep(PASSES, createSortModelBuffers())).toThrow(RangeError);
  });
});

describe('runSortModel against the oracle (Array.sort by z, then id)', () => {
  const SIZES = [0, 1, 2, 255, 256, 257, 1023, 1024, 1025, 2047, 4097];
  describe.each(SIZES)('n = %i', (n) => {
    it.each(DISTRIBUTIONS)('%s', (dist) => {
      const scene = buildScene(n, dist);
      expectSorted(scene, runSortModel(scene.input, shuffledSchedule(n * 97 + DISTRIBUTIONS.indexOf(dist))));
    });
  });

  it('with limit exactly n (a CPU count with nothing offscreen)', () => {
    const scene = buildScene(1024, 'equal', { limit: 1024 });
    expectSorted(scene, runSortModel(scene.input, reversedSchedule));
  });

  it('on the cull layout (region b at b × CAP)', () => {
    const scene = buildScene(3000, 'two', { layout: 'cull' });
    expectSorted(scene, runSortModel(scene.input, shuffledSchedule(3)));
  });
});

// Under a second per run here, but a loaded machine can triple it: an explicit
// timeout, like the ring-buffer bench.
describe('runSortModel at CAP: 100 000 elements, 98 full tiles', { timeout: 60_000 }, () => {
  it.each(['equal', 'distinct'] as const)('%s z, shuffled workgroups and lanes', (dist) => {
    const scene = buildScene(CAP, dist);
    expect(scene.input.limit).toBe(CAP);
    expectSorted(scene, runSortModel(scene.input, shuffledSchedule(dist === 'equal' ? 100 : 101)));
  });
});

describe('invariants', () => {
  it.each([[4097, 'two'], [3000, 'extreme-ids']] as const)(
    'n = %i, %s: each scatter is a stable counting sort on its digit, digitBase the exclusive scan of its histogram',
    (n, dist) => {
      const scene = buildScene(n, dist);
      const schedule = shuffledSchedule(n);
      const bufs = gatherScene(scene, schedule);
      const tiles = Math.ceil(n / TILE);
      for (let p = 0; p < PASSES; p++) {
        const { keysIn, valsIn, keysOut, valsOut } = passBuffers(bufs, p);
        const lo = keysIn.slice(0, n);
        const hi = keysIn.slice(CAP, CAP + n);
        const vals = valsIn.slice(0, n);
        const keysOutBefore = keysOut.slice();

        // Upsweep: tile t's histogram of digit p.
        const tileHist = new Uint32Array(tiles * RADIX);
        for (let i = 0; i < n; i++) tileHist[Math.floor(i / TILE) * RADIX + digitOf(lo[i], hi[i], p)]++;
        cpuUpsweep(p, bufs, schedule);
        expect(firstDifference(bufs.hist.subarray(TILES_OFFSET, TILES_OFFSET + tiles * RADIX), tileHist)).toBeNull();

        // Scan: every column becomes its exclusive prefix over the tiles; digitBase the exclusive scan of the totals.
        const columnPrefix = new Uint32Array(tiles * RADIX);
        const totals = new Uint32Array(RADIX);
        for (let t = 0; t < tiles; t++) {
          for (let d = 0; d < RADIX; d++) {
            columnPrefix[t * RADIX + d] = totals[d];
            totals[d] += tileHist[t * RADIX + d];
          }
        }
        const digitBase = new Uint32Array(RADIX);
        for (let d = 1; d < RADIX; d++) digitBase[d] = digitBase[d - 1] + totals[d - 1];
        cpuScan(p, bufs, schedule);
        expect(firstDifference(bufs.hist.subarray(TILES_OFFSET, TILES_OFFSET + tiles * RADIX), columnPrefix)).toBeNull();
        const row = DIGIT_BASE_OFFSET + p * RADIX;
        expect(firstDifference(bufs.hist.subarray(row, row + RADIX), digitBase)).toBeNull();

        // Scatter: the stable counting sort; the last pass leaves the keys alone.
        cpuScatter(p, bufs, schedule);
        const expected = stableCountingSort(lo, hi, vals, p);
        expect(firstDifference(valsOut.subarray(0, n), expected.vals)).toBeNull();
        if (p !== LAST_PASS) {
          expect(firstDifference(keysOut.subarray(0, n), expected.lo)).toBeNull();
          expect(firstDifference(keysOut.subarray(CAP, CAP + n), expected.hi)).toBeNull();
        } else {
          expect(firstDifference(keysOut, keysOutBefore)).toBeNull();
        }
      }
      expect(bufs.hist[0]).toBe(0);
      expect(firstDifference(bufs.valsB.subarray(0, n), floatOracle(scene))).toBeNull();
    },
  );

  it('gives the same buffers, word for word, under every schedule and region shuffle (raw <= limit)', () => {
    const scene = buildScene(5000, 'two', { seed: 77 });
    const reference = runSortModel(scene.input);
    const runs = [
      runSortModel(scene.input, reversedSchedule),
      runSortModel(scene.input, shuffledSchedule(8)),
      runSortModel(shuffleRegions(scene, 9), shuffledSchedule(10)),
    ];
    for (const run of runs) {
      expect(firstDifference(run.header, reference.header)).toBeNull();
      expect(firstDifference(run.valsB, reference.valsB)).toBeNull();
      // The gathered order differs after a region shuffle; the sort erases it from pass 0 on.
      expect(firstDifference(run.keysB, reference.keysB)).toBeNull();
      expect(firstDifference(run.hist.subarray(0, TILES_OFFSET), reference.hist.subarray(0, TILES_OFFSET))).toBeNull();
    }
    expectSorted(scene, reference);
  });

  it('overflow (raw > limit): n = B, flag raised, draw {6, B, 0, 0, 0}, the gathered prefix sorted', () => {
    // Region ends 500, 1500, 3000, …, 3007: a limit of 2000 cuts inside region 2.
    const sizes = [500, 1000, 1500, 0, 0, 0, 0, 0, 0, 0, 0, 7];
    const scene = buildScene(3007, 'distinct', { sizes, limit: 2000 });
    const bufs = runSortModel(scene.input, shuffledSchedule(4));
    expect(Array.from(bufs.header.subarray(0, 12))).toEqual([6, 2000, 0, 0, 0, 2, 1, 1, 3007, 2000, 1, scene.input.stamp]);
    expect(bufs.hist[0]).toBe(0);
    const order = bufs.valsB.slice(0, 2000);
    expect(firstDifference(order, floatOracle(scene, 2000))).toBeNull();

    // The region shuffle invariance does NOT hold here: reversing region 2 moves the cut.
    const input = scene.input;
    const reversed = input.visibleIndices.slice();
    reversed.subarray(scene.bases[2], scene.bases[2] + 1500).reverse();
    const other = runSortModel({ ...input, visibleIndices: reversed }).valsB.slice(0, 2000);
    const set = (a: Uint32Array) => Array.from(a).sort((x, y) => x - y);
    expect(set(other)).not.toEqual(set(order));
  });

  it('empty input, B = 0: nothing runs; draw {6, 0, 0, 0, 0}, the sentinel stays in word 11', () => {
    const scene = buildScene(0, 'two', { limit: 0 });
    const bufs = runSortModel(scene.input);
    expect(Array.from(bufs.header)).toEqual([6, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, STAMP_SENTINEL, 0, 0, 0, 0]);
    for (const b of [bufs.keysA, bufs.keysB, bufs.valsA, bufs.valsB]) expect(b.every((w) => w === STALE_WORD)).toBe(true);
    expect(bufs.hist.subarray(0, DIAG_WORDS).every((w) => w === 0)).toBe(true);
    expect(bufs.hist.subarray(DIAG_WORDS).every((w) => w === STALE_WORD)).toBe(true);
  });

  it('nothing visible, B > 0: the header says n = 0, no key or value is written, digitBase is zero', () => {
    const scene = buildScene(0, 'two', { limit: 300 });
    const bufs = runSortModel(scene.input, shuffledSchedule(6));
    expect(Array.from(bufs.header)).toEqual([6, 0, 0, 0, 0, 0, 1, 1, 0, 300, 0, scene.input.stamp, 0, 0, 0, 0]);
    for (const b of [bufs.keysA, bufs.keysB, bufs.valsA, bufs.valsB]) expect(b.every((w) => w === STALE_WORD)).toBe(true);
    expect(bufs.hist.subarray(DIGIT_BASE_OFFSET, TILES_OFFSET).every((w) => w === 0)).toBe(true);
    expect(bufs.hist[0]).toBe(0);
  });

  it('diag bit 0: a tile table whose total is not n', () => {
    const bufs = createSortModelBuffers();
    cpuPrepare(bufs, 1000);
    bufs.header[H_DRAW + 1] = 1000;
    bufs.header[H_DISPATCH] = 1;
    bufs.hist.fill(0, TILES_OFFSET, TILES_OFFSET + RADIX); // tile 0 counts nothing
    cpuScan(0, bufs);
    expect(bufs.hist[0] & DIAG_SCAN_MISMATCH).toBe(DIAG_SCAN_MISMATCH);
  });

  it('diag bit 1: a destination >= n is flagged and never written', () => {
    const bufs = createSortModelBuffers();
    cpuPrepare(bufs, 10);
    bufs.header[H_DRAW + 1] = 10;
    bufs.header[H_DISPATCH] = 1;
    for (let i = 0; i < 10; i++) {
      bufs.keysA[i] = 0; // every element has digit 0 in pass 0
      bufs.keysA[CAP + i] = 0x80000000;
      bufs.valsA[i] = 100 + i;
    }
    bufs.hist.fill(0, DIGIT_BASE_OFFSET, DIGIT_BASE_OFFSET + RADIX);
    bufs.hist[DIGIT_BASE_OFFSET] = 5; // digit 0 starts at 5: elements 0-4 land at 5-9, 5-9 at 10-14 (>= n)
    bufs.hist.fill(0, TILES_OFFSET, TILES_OFFSET + RADIX);
    cpuScatter(0, bufs);
    expect(bufs.hist[0] & DIAG_SCATTER_OOB).toBe(DIAG_SCATTER_OOB);
    expect(Array.from(bufs.valsB.subarray(5, 10))).toEqual([100, 101, 102, 103, 104]);
    expect(bufs.valsB.subarray(10).every((w) => w === STALE_WORD)).toBe(true);
  });
});
