/**
 * CPU model of the transparent sort (phase 5b, design §5 and §7.1): the gather
 * and the three radix kernels, simulated phase by phase. They are the SAME
 * kernels as `transparent-gather.wgsl` (`gather_main`) and
 * `transparent-sort.wgsl` (`upsweep_main`, `scan_main`, `scatter_main`), line
 * for line: a change to one is a change to the other.
 *
 * - A phase is the code between two `workgroupBarrier()`: here, a loop over the
 *   256 lanes, in an order the caller picks (`Schedule.laneOrder`). The
 *   workgroups of a dispatch run one after the other, in an order the caller
 *   picks too (`Schedule.workgroupOrder`).
 * - `SharedMemory` throws when a lane touches a workgroup word another lane
 *   wrote in the same phase: the model only runs if no result depends on the
 *   lane order. Atomics commute with each other.
 * - `GlobalConflictChecker` throws when a storage word written by one
 *   invocation is touched by another in the same dispatch
 *   (`workgroupBarrier()` orders workgroup memory only).
 *
 * The buffers are Uint32Arrays with the GPU layout word for word, so a
 * readback compares with them directly: `header` = `transparent-args`, `keysA`
 * / `keysB` = `sort-keys-a` / `sort-keys-b` (lo at [0, CAP), hi at [CAP,
 * 2·CAP)), `valsA` = `sort-vals-a`, `valsB` = `transparent-order`, `hist` =
 * `sort-hist` (diag, digitBase, tiles).
 */
import {
  ARG_FIRST_INSTANCE,
  ARG_INSTANCE_COUNT,
  ARG_WORDS,
  CAP,
  DIAG_SCAN_MISMATCH,
  DIAG_SCATTER_OOB,
  DIAG_WORDS,
  DIGIT_BASE_OFFSET,
  FIRST_TRANSPARENT_ARG,
  GATHER_REGIONS,
  H_DISPATCH,
  H_DRAW,
  H_LIMIT,
  H_OVERFLOW,
  H_RAW,
  H_STAMP,
  HEADER_WORDS,
  HIST_WORDS,
  LAST_PASS,
  LO_PASSES,
  MASK_WORDS,
  PASSES,
  RADIX,
  ROUNDS,
  SCAN_CHUNK,
  STAMP_SENTINEL,
  TILE,
  TILES_OFFSET,
  WORKGROUP_SIZE,
} from './transparent-sort-constants';

// ── Keys ─────────────────────────────────────────────────────────────────────

/**
 * The z key (design §5.1), from the bits of `entity-bounds[slot].z` as the
 * gather computes it: -0 becomes +0 by an integer compare (no float operation
 * touches z), then the flip that makes unsigned order follow float order — a
 * negative z has every bit inverted, a positive one gets the sign bit set.
 */
export function sortableZBits(bits: number): number {
  let zb = bits >>> 0;
  if (zb === 0x80000000) zb = 0;
  return ((zb & 0x80000000) !== 0 ? ~zb : zb | 0x80000000) >>> 0;
}

/** The 8-bit digit of pass `pass`: passes 0-2 read `lo` (the id), 3-6 read `hi` (the z key). */
export function digitOf(lo: number, hi: number, pass: number): number {
  return pass < LO_PASSES
    ? (lo >>> (8 * pass)) & 0xFF
    : (hi >>> (8 * (pass - LO_PASSES))) & 0xFF;
}

/**
 * The oracle: `vals[0..n)` sorted by (hi, lo), ties in input order. With
 * unique ids there are no ties, so the result is the one permutation the GPU
 * sort must produce.
 */
export function oracleOrder(vals: Uint32Array, lo: Uint32Array, hi: Uint32Array, n: number): Uint32Array {
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => (hi[a] - hi[b]) || (lo[a] - lo[b]) || (a - b));
  const out = new Uint32Array(n);
  for (let j = 0; j < n; j++) out[j] = vals[idx[j]];
  return out;
}

// ── Inputs, buffers, schedule ────────────────────────────────────────────────

export interface SortModelInput {
  /** `indirect-args`: 28 DrawIndexedIndirect records (cull.wgsl). */
  indirectArgs: Uint32Array;
  /** `visible-indices`: each record's region of slots, from its firstInstance. */
  visibleIndices: Uint32Array;
  /** `entity-bounds` read as u32 bits: 4 words per slot, z at word 2. */
  boundsBits: Uint32Array;
  /** `entity-ids`: slot → external id. */
  entityIds: Uint32Array;
  /** `GatherParams.limit` = B = min(normalised transparentCount, CAP). */
  limit: number;
  /** `GatherParams.stamp` = `FrameState.frameStamp`, in [1, 0xFFFFFFFE]. */
  stamp: number;
}

export interface SortModelBuffers {
  header: Uint32Array;
  keysA: Uint32Array;
  keysB: Uint32Array;
  valsA: Uint32Array;
  valsB: Uint32Array;
  hist: Uint32Array;
}

/**
 * The order the model runs things in. Every order is legal on a GPU, so a
 * correct kernel gives the same buffers under every schedule.
 */
export interface Schedule {
  /** The workgroup ids of a dispatch ('gather', 'upsweep:p', 'scan:p', 'scatter:p'), in run order. */
  workgroupOrder?(count: number, dispatch: string): number[];
  /** The 256 lanes of phase `phase` (0-based, per workgroup) of workgroup `workgroup`, in run order. */
  laneOrder?(workgroup: number, phase: number): number[];
}

/** What the model puts in a buffer before a run: the previous frame's contents, which nothing may read. */
export const STALE_WORD = 0xDEADBEEF;

/** Buffers of the GPU sizes, filled with `fill`. */
export function createSortModelBuffers(fill: number = STALE_WORD): SortModelBuffers {
  const make = (words: number) => new Uint32Array(words).fill(fill);
  return {
    header: make(HEADER_WORDS),
    keysA: make(2 * CAP),
    keysB: make(2 * CAP),
    valsA: make(CAP),
    valsB: make(CAP),
    hist: make(HIST_WORDS),
  };
}

/** `TransparentSortPass.prepare()`: the header reset (stamp = sentinel) and diag zeroed. */
export function cpuPrepare(bufs: SortModelBuffers, limit: number): void {
  bufs.header.set([6, 0, 0, 0, 0, 0, 1, 1, 0, limit, 0, STAMP_SENTINEL, 0, 0, 0, 0]);
  bufs.hist.fill(0, 0, DIAG_WORDS);
}

// ── Race checkers ────────────────────────────────────────────────────────────

// Access classes. Two accesses to one word by different actors in the same
// epoch (a phase, or a dispatch) commute only when both are in the same class:
// reads (plain or atomicLoad), atomicAdd, atomicOr, or atomicStore of one
// value. A plain write commutes with nothing another actor does.
const C_READ = 1;
const C_ADD = 2;
const C_OR = 3;
const C_STORE = 4;
const C_WRITE = 5;
const C_MIXED = 6;

/** Per word: who touched it in the current epoch, and how. Epochs make a reset free. */
class AccessTracker {
  private readonly epoch: Uint32Array;
  private readonly first: Int32Array;
  private readonly second: Int32Array;
  private readonly cls: Uint8Array;
  private readonly stored: Uint32Array;

  constructor(size: number) {
    this.epoch = new Uint32Array(size);
    this.first = new Int32Array(size);
    this.second = new Int32Array(size);
    this.cls = new Uint8Array(size);
    this.stored = new Uint32Array(size);
  }

  /** -1 when the access commutes with every other access to `addr` in epoch `now`, else the actor it races with. */
  touch(addr: number, now: number, actor: number, c: number, value: number): number {
    if (this.epoch[addr] !== now) {
      this.epoch[addr] = now;
      this.first[addr] = actor;
      this.second[addr] = -1;
      this.cls[addr] = c;
      this.stored[addr] = value;
      return -1;
    }
    let cls = this.cls[addr];
    if (cls !== c || (c === C_STORE && this.stored[addr] !== value)) cls = C_MIXED;
    this.cls[addr] = cls;
    const first = this.first[addr];
    if (actor !== first && this.second[addr] === -1) this.second[addr] = actor;
    if (this.second[addr] !== -1 && (cls === C_MIXED || cls === C_WRITE)) {
      return actor !== first ? first : this.second[addr];
    }
    return -1;
  }
}

/**
 * The `var<workgroup>` arrays of one kernel, laid out back to back. Zeroed by
 * `reset()` (WGSL zero-initialises workgroup memory for every workgroup). An
 * access racing with another lane's in the same phase throws, and so does a
 * plain access to an `atomic<u32>` array or an atomic one to a plain array.
 */
export class SharedMemory {
  readonly words: Uint32Array;
  private readonly atomic: Uint8Array;
  private readonly tracker: AccessTracker;
  private readonly regions: Array<{ name: string; base: number; size: number }> = [];
  private now = 1;
  private lane = 0;

  constructor(layout: ReadonlyArray<readonly [name: string, words: number, atomic: boolean]>) {
    let size = 0;
    for (const [name, words] of layout) {
      this.regions.push({ name, base: size, size: words });
      size += words;
    }
    this.words = new Uint32Array(size);
    this.atomic = new Uint8Array(size);
    layout.forEach(([, words, atomic], k) => {
      if (atomic) this.atomic.fill(1, this.regions[k].base, this.regions[k].base + words);
    });
    this.tracker = new AccessTracker(size);
  }

  /** First word of the array called `name`. */
  base(name: string): number {
    const region = this.regions.find((r) => r.name === name);
    if (!region) throw new Error(`no workgroup array '${name}'`);
    return region.base;
  }

  /** A new workgroup: zeroed words, and nothing before races with anything after. */
  reset(): void {
    this.words.fill(0);
    this.now++;
  }

  /** `workgroupBarrier()`: nothing before it races with anything after it. */
  barrier(): void {
    this.now++;
  }

  /** The lane whose accesses follow. */
  setLane(lane: number): void {
    this.lane = lane;
  }

  load(addr: number): number {
    this.check(addr, 0, C_READ, 0, 'read');
    return this.words[addr];
  }

  store(addr: number, value: number): void {
    this.check(addr, 0, C_WRITE, 0, 'write');
    this.words[addr] = value;
  }

  atomicLoad(addr: number): number {
    this.check(addr, 1, C_READ, 0, 'atomicLoad');
    return this.words[addr];
  }

  atomicStore(addr: number, value: number): void {
    this.check(addr, 1, C_STORE, value >>> 0, 'atomicStore');
    this.words[addr] = value;
  }

  atomicAdd(addr: number, value: number): number {
    this.check(addr, 1, C_ADD, 0, 'atomicAdd');
    const old = this.words[addr];
    this.words[addr] = old + value;
    return old;
  }

  atomicOr(addr: number, value: number): number {
    this.check(addr, 1, C_OR, 0, 'atomicOr');
    const old = this.words[addr];
    this.words[addr] = old | value;
    return old;
  }

  private check(addr: number, atomic: number, c: number, value: number, what: string): void {
    if ((addr >>> 0) !== addr || addr >= this.words.length) {
      throw new RangeError(`workgroup memory: ${what} at ${addr}, outside the ${this.words.length} words`);
    }
    if (this.atomic[addr] !== atomic) {
      throw new Error(`workgroup memory: ${what} of ${this.describe(addr)}, which is ${this.atomic[addr] ? 'atomic<u32>' : 'u32'}`);
    }
    const other = this.tracker.touch(addr, this.now, this.lane, c, value);
    if (other !== -1) {
      throw new Error(`workgroup race on ${this.describe(addr)}: lanes ${other} and ${this.lane} in one phase (${what})`);
    }
  }

  private describe(addr: number): string {
    const region = this.regions.find((r) => addr >= r.base && addr < r.base + r.size);
    return region ? `${region.name}[${addr - region.base}]` : `word ${addr}`;
  }
}

let dispatchEpoch = 0;
// Trackers are shared by every binding with the same name and length: an epoch
// is unique to its dispatch, so an entry of an older dispatch is stale by
// construction, and a test run allocates each tracker once.
const globalTrackers = new Map<string, AccessTracker>();

function describeInvocation(invocation: number): string {
  return `(wg ${Math.floor(invocation / WORKGROUP_SIZE)}, lane ${invocation % WORKGROUP_SIZE})`;
}

/**
 * The storage buffers of one dispatch. A word written by one invocation and
 * touched by another in the same dispatch throws: nothing orders two
 * invocations' storage accesses inside a dispatch. Between dispatches every
 * write is visible (each dispatch is its own usage scope).
 */
export class GlobalConflictChecker {
  readonly epoch = ++dispatchEpoch;
  private current = 0;

  constructor(readonly dispatch: string) {}

  /** `workgroup · 256 + lane` of the invocation whose accesses follow. */
  get invocation(): number {
    return this.current;
  }

  setInvocation(workgroup: number, lane: number): void {
    this.current = workgroup * WORKGROUP_SIZE + lane;
  }

  /** A binding: `'read'` is `var<storage, read>` (a write throws), `'read_write'` is tracked. */
  bind(name: string, data: Uint32Array, access: 'read' | 'read_write'): GlobalBinding {
    let tracker: AccessTracker | null = null;
    if (access === 'read_write') {
      const key = `${name}:${data.length}`;
      tracker = globalTrackers.get(key) ?? null;
      if (!tracker) {
        tracker = new AccessTracker(data.length);
        globalTrackers.set(key, tracker);
      }
    }
    return new GlobalBinding(this, name, data, tracker);
  }
}

/** One storage binding of a dispatch; every access is range-checked, a read_write one is also tracked. */
export class GlobalBinding {
  constructor(
    private readonly checker: GlobalConflictChecker,
    readonly name: string,
    readonly data: Uint32Array,
    private readonly tracker: AccessTracker | null,
  ) {}

  read(addr: number): number {
    this.check(addr, C_READ, 'read');
    return this.data[addr];
  }

  write(addr: number, value: number): void {
    this.check(addr, C_WRITE, 'write');
    this.data[addr] = value;
  }

  atomicOr(addr: number, value: number): number {
    this.check(addr, C_OR, 'atomicOr');
    const old = this.data[addr];
    this.data[addr] = old | value;
    return old;
  }

  private check(addr: number, c: number, what: string): void {
    const { dispatch, invocation } = this.checker;
    if ((addr >>> 0) !== addr || addr >= this.data.length) {
      throw new RangeError(`${dispatch}: ${what} of ${this.name}[${addr}], outside its ${this.data.length} words`);
    }
    if (this.tracker === null) {
      if (c !== C_READ) throw new Error(`${dispatch}: ${what} of ${this.name}, which is bound read-only`);
      return;
    }
    const other = this.tracker.touch(addr, this.checker.epoch, invocation, c, 0);
    if (other !== -1) {
      throw new Error(
        `${dispatch}: ${this.name}[${addr}] touched by invocations ${describeInvocation(other)} and ` +
        `${describeInvocation(invocation)}, one of them writing (${what})`,
      );
    }
  }
}

// ── Driver ───────────────────────────────────────────────────────────────────

const IDENTITY_LANES: readonly number[] = Array.from({ length: WORKGROUP_SIZE }, (_, i) => i);
const checkedLaneOrders = new WeakSet<object>();

function assertPermutation(order: readonly number[], count: number, what: string): void {
  if (order.length !== count) throw new Error(`${what}: ${order.length} entries, expected ${count}`);
  const seen = new Uint8Array(count);
  for (const x of order) {
    if (!Number.isInteger(x) || x < 0 || x >= count || seen[x]) {
      throw new Error(`${what}: not a permutation of 0..${count - 1}`);
    }
    seen[x] = 1;
  }
}

/** One workgroup of a dispatch. */
class WorkgroupRun {
  private phaseIndex = 0;

  constructor(
    private readonly wid: number,
    private readonly schedule: Schedule | undefined,
    private readonly shared: SharedMemory,
    private readonly global: GlobalConflictChecker,
  ) {}

  /** The code up to the next `workgroupBarrier()`, for all 256 lanes, in the schedule's order. */
  phase(body: (lid: number) => void): void {
    const order = this.schedule?.laneOrder?.(this.wid, this.phaseIndex) ?? IDENTITY_LANES;
    if (order !== IDENTITY_LANES && !checkedLaneOrders.has(order)) {
      assertPermutation(order, WORKGROUP_SIZE, `laneOrder(${this.wid}, ${this.phaseIndex})`);
      checkedLaneOrders.add(order);
    }
    for (let j = 0; j < WORKGROUP_SIZE; j++) {
      const lid = order[j];
      this.shared.setLane(lid);
      this.global.setInvocation(this.wid, lid);
      body(lid);
    }
    this.phaseIndex++;
    this.shared.barrier();
  }
}

function runDispatch(
  name: string,
  count: number,
  schedule: Schedule | undefined,
  shared: SharedMemory,
  global: GlobalConflictChecker,
  kernel: (wid: number, wg: WorkgroupRun) => void,
): void {
  const order = schedule?.workgroupOrder?.(count, name) ?? Array.from({ length: count }, (_, i) => i);
  assertPermutation(order, count, `workgroupOrder(${count}, '${name}')`);
  for (const wid of order) {
    shared.reset();
    kernel(wid, new WorkgroupRun(wid, schedule, shared, global));
  }
}

// ── Gather ───────────────────────────────────────────────────────────────────

/**
 * `gather_main`: ceil(limit / 256) workgroups. Element i of the output is the
 * i-th slot of the 12 transparent regions laid end to end, keyed (id, zKey).
 */
export function cpuGather(input: SortModelInput, bufs: SortModelBuffers, schedule?: Schedule): void {
  const { limit, stamp } = input; // b0: GatherParams
  if ((limit >>> 0) !== limit || limit > CAP) throw new RangeError(`limit ${limit} outside [0, CAP]: the pass clamps B to CAP`);
  const g = new GlobalConflictChecker('gather');
  const indirectArgs = g.bind('indirect-args', input.indirectArgs, 'read'); // b1
  const visibleIndices = g.bind('visible-indices', input.visibleIndices, 'read'); // b2
  const bounds = g.bind('entity-bounds', input.boundsBits, 'read'); // b3
  const entityIds = g.bind('entity-ids', input.entityIds, 'read'); // b4
  const keysA = g.bind('sort-keys-a', bufs.keysA, 'read_write'); // b5
  const valsA = g.bind('sort-vals-a', bufs.valsA, 'read_write'); // b6
  const header = g.bind('transparent-args', bufs.header, 'read_write'); // b7
  const shared = new SharedMemory([['regionEnd', GATHER_REGIONS, false], ['regionBase', GATHER_REGIONS, false]]);
  const END = shared.base('regionEnd');
  const BASE = shared.base('regionBase');

  runDispatch('gather', Math.ceil(limit / WORKGROUP_SIZE), schedule, shared, g, (wid, wg) => {
    // Lane 0 turns the 12 transparent records into region ends (inclusive
    // prefix of the counts) and bases (their firstInstance).
    wg.phase((lid) => {
      if (lid !== 0) return;
      let end = 0;
      for (let k = 0; k < GATHER_REGIONS; k++) {
        const arg = (FIRST_TRANSPARENT_ARG + k) * ARG_WORDS;
        end = (end + indirectArgs.read(arg + ARG_INSTANCE_COUNT)) >>> 0;
        shared.store(END + k, end);
        shared.store(BASE + k, indirectArgs.read(arg + ARG_FIRST_INSTANCE));
      }
    });
    // workgroupBarrier() — the only one, at top level.
    wg.phase((lid) => {
      const raw = shared.load(END + GATHER_REGIONS - 1);
      const n = Math.min(raw, limit);
      if (wid === 0 && lid === 0) {
        header.write(H_DRAW, 6);
        header.write(H_DRAW + 1, n);
        header.write(H_DRAW + 2, 0);
        header.write(H_DRAW + 3, 0);
        header.write(H_DRAW + 4, 0);
        header.write(H_DISPATCH, Math.floor((n + TILE - 1) / TILE));
        header.write(H_DISPATCH + 1, 1);
        header.write(H_DISPATCH + 2, 1);
        header.write(H_RAW, raw);
        header.write(H_LIMIT, limit);
        header.write(H_OVERFLOW, raw > limit ? 1 : 0);
        header.write(H_STAMP, stamp);
      }
      const i = wid * WORKGROUP_SIZE + lid;
      if (i >= n) return;
      let k = 0;
      for (let q = 0; q < GATHER_REGIONS; q++) {
        if (shared.load(END + q) <= i) k++;
      }
      let start = 0;
      if (k > 0) start = shared.load(END + k - 1);
      const slot = visibleIndices.read((shared.load(BASE + k) + i - start) >>> 0);
      const zKey = sortableZBits(bounds.read(slot * 4 + 2));
      keysA.write(i, entityIds.read(slot));
      keysA.write(CAP + i, zKey);
      valsA.write(i, slot);
    });
  });
}

// ── Radix passes ─────────────────────────────────────────────────────────────

function assertPass(pass: number): void {
  if (!Number.isInteger(pass) || pass < 0 || pass >= PASSES) throw new RangeError(`pass ${pass} outside 0..${PASSES - 1}`);
}

/** The shared layout of upsweep, scan and scatter: A → B on even passes, B → A on odd ones. */
function sortBindings(g: GlobalConflictChecker, pass: number, bufs: SortModelBuffers) {
  const even = pass % 2 === 0;
  return {
    keysIn: g.bind(even ? 'sort-keys-a' : 'sort-keys-b', even ? bufs.keysA : bufs.keysB, 'read'), // b1
    valsIn: g.bind(even ? 'sort-vals-a' : 'transparent-order', even ? bufs.valsA : bufs.valsB, 'read'), // b2
    keysOut: g.bind(even ? 'sort-keys-b' : 'sort-keys-a', even ? bufs.keysB : bufs.keysA, 'read_write'), // b3
    valsOut: g.bind(even ? 'transparent-order' : 'sort-vals-a', even ? bufs.valsB : bufs.valsA, 'read_write'), // b4
    header: g.bind('transparent-args', bufs.header, 'read'), // b5: read-only, so n is uniform
    hist: g.bind('sort-hist', bufs.hist, 'read_write'), // b6
  };
}

/** Only the word the digit comes from: `keysIn[i]` for passes 0-2, `keysIn[CAP + i]` for 3-6. */
function keyDigit(keysIn: GlobalBinding, i: number, pass: number): number {
  return pass < LO_PASSES
    ? (keysIn.read(i) >>> (8 * pass)) & 0xFF
    : (keysIn.read(CAP + i) >>> (8 * (pass - LO_PASSES))) & 0xFF;
}

/** WGSL `countOneBits` on a u32. */
function countOneBits(x: number): number {
  let v = x >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0F0F0F0F;
  return Math.imul(v, 0x01010101) >>> 24;
}

/** `upsweep_main`, pass `pass`: header[5] workgroups; tile t's digit histogram into `tiles[t·256 + d]`. */
export function cpuUpsweep(pass: number, bufs: SortModelBuffers, schedule?: Schedule): void {
  assertPass(pass);
  const g = new GlobalConflictChecker(`upsweep:${pass}`);
  const { keysIn, header, hist } = sortBindings(g, pass, bufs);
  const shared = new SharedMemory([['wgHist', RADIX, true]]);
  const HIST = shared.base('wgHist');

  runDispatch(`upsweep:${pass}`, bufs.header[H_DISPATCH], schedule, shared, g, (t, wg) => {
    const n = header.read(H_DRAW + 1);
    if (t * TILE >= n) return; // uniform: workgroup id and a read-only word
    wg.phase((lid) => {
      shared.atomicStore(HIST + lid, 0);
    });
    wg.phase((lid) => {
      for (let r = 0; r < ROUNDS; r++) {
        const i = t * TILE + r * WORKGROUP_SIZE + lid;
        if (i < n) shared.atomicAdd(HIST + keyDigit(keysIn, i, pass), 1);
      }
    });
    wg.phase((lid) => {
      hist.write(TILES_OFFSET + t * RADIX + lid, shared.atomicLoad(HIST + lid));
    });
  });
}

/**
 * `scan_main`, pass `pass`: one workgroup; lane d owns digit d. Column scan of
 * the tile table in place, then an in-place Hillis-Steele over the 256 totals
 * (two phases per step: read into v, then write), then `digitBase`.
 */
export function cpuScan(pass: number, bufs: SortModelBuffers, schedule?: Schedule): void {
  assertPass(pass);
  const g = new GlobalConflictChecker(`scan:${pass}`);
  const { header, hist } = sortBindings(g, pass, bufs);
  const shared = new SharedMemory([['totals', RADIX, false]]);
  const TOTALS = shared.base('totals');
  const sum = new Uint32Array(WORKGROUP_SIZE); // per-lane `var sum`
  const v = new Uint32Array(WORKGROUP_SIZE); // per-lane `var v`
  const chunk = new Uint32Array(SCAN_CHUNK); // one lane's `var c`: lanes run one at a time here

  runDispatch(`scan:${pass}`, 1, schedule, shared, g, (_wid, wg) => {
    const n = header.read(H_DRAW + 1);
    const tiles = Math.floor((n + TILE - 1) / TILE);
    wg.phase((d) => {
      let s = 0;
      for (let t0 = 0; t0 < tiles; t0 += SCAN_CHUNK) {
        for (let j = 0; j < SCAN_CHUNK; j++) {
          if (t0 + j < tiles) chunk[j] = hist.read(TILES_OFFSET + (t0 + j) * RADIX + d);
        }
        for (let j = 0; j < SCAN_CHUNK; j++) {
          if (t0 + j < tiles) {
            hist.write(TILES_OFFSET + (t0 + j) * RADIX + d, s);
            s = (s + chunk[j]) >>> 0;
          }
        }
      }
      sum[d] = s;
      shared.store(TOTALS + d, s);
    });
    for (let off = 1; off < RADIX; off <<= 1) {
      wg.phase((d) => {
        v[d] = 0;
        if (d >= off) v[d] = shared.load(TOTALS + d - off);
      });
      wg.phase((d) => {
        shared.store(TOTALS + d, (shared.load(TOTALS + d) + v[d]) >>> 0);
      });
    }
    wg.phase((d) => {
      const incl = shared.load(TOTALS + d);
      hist.write(DIGIT_BASE_OFFSET + pass * RADIX + d, (incl - sum[d]) >>> 0);
      if (d === RADIX - 1 && incl !== n) hist.atomicOr(0, DIAG_SCAN_MISMATCH);
    });
  });
}

/**
 * `scatter_main`, pass `pass`: header[5] workgroups. Phase 0 preloads and
 * sets the cursors; each of the 4 rounds marks (a), ranks (b), writes (c).
 * The last pass writes the values only.
 */
export function cpuScatter(pass: number, bufs: SortModelBuffers, schedule?: Schedule): void {
  assertPass(pass);
  const g = new GlobalConflictChecker(`scatter:${pass}`);
  const { keysIn, valsIn, keysOut, valsOut, header, hist } = sortBindings(g, pass, bufs);
  const shared = new SharedMemory([['masks', RADIX * MASK_WORDS, true], ['cursor', RADIX, false]]);
  const MASKS = shared.base('masks');
  const CURSOR = shared.base('cursor');
  // Per-lane `var`s: the preloaded (lo, hi, val) of each round, then the
  // round's digit, rank, total and base.
  const lo = new Uint32Array(WORKGROUP_SIZE * ROUNDS);
  const hi = new Uint32Array(WORKGROUP_SIZE * ROUNDS);
  const val = new Uint32Array(WORKGROUP_SIZE * ROUNDS);
  const digit = new Uint32Array(WORKGROUP_SIZE);
  const rank = new Uint32Array(WORKGROUP_SIZE);
  const total = new Uint32Array(WORKGROUP_SIZE);
  const base = new Uint32Array(WORKGROUP_SIZE);

  runDispatch(`scatter:${pass}`, bufs.header[H_DISPATCH], schedule, shared, g, (t, wg) => {
    const n = header.read(H_DRAW + 1);
    if (t * TILE >= n) return;
    // Phase 0, then B0.
    wg.phase((lid) => {
      for (let r = 0; r < ROUNDS; r++) {
        const i = t * TILE + r * WORKGROUP_SIZE + lid;
        if (i < n) {
          lo[lid * ROUNDS + r] = keysIn.read(i);
          hi[lid * ROUNDS + r] = keysIn.read(CAP + i);
          val[lid * ROUNDS + r] = valsIn.read(i);
        }
      }
      const cursor = hist.read(DIGIT_BASE_OFFSET + pass * RADIX + lid) + hist.read(TILES_OFFSET + t * RADIX + lid);
      shared.store(CURSOR + lid, cursor >>> 0);
      for (let w = 0; w < MASK_WORDS; w++) shared.atomicStore(MASKS + lid * MASK_WORDS + w, 0);
    });
    for (let r = 0; r < ROUNDS; r++) {
      const active = (lid: number) => t * TILE + r * WORKGROUP_SIZE + lid < n;
      // (a) mark, then B1.
      wg.phase((lid) => {
        if (!active(lid)) return;
        const d = digitOf(lo[lid * ROUNDS + r], hi[lid * ROUNDS + r], pass);
        digit[lid] = d;
        shared.atomicOr(MASKS + d * MASK_WORDS + (lid >>> 5), (1 << (lid & 31)) >>> 0);
      });
      // (b) rank, no writes to shared memory, then B2.
      wg.phase((lid) => {
        if (!active(lid)) return;
        const d = digit[lid];
        const word = lid >>> 5;
        let tot = 0;
        let rk = 0;
        for (let w = 0; w < MASK_WORDS; w++) {
          const c = countOneBits(shared.atomicLoad(MASKS + d * MASK_WORDS + w));
          tot += c;
          if (w < word) rk += c;
        }
        rk += countOneBits(shared.atomicLoad(MASKS + d * MASK_WORDS + word) & (((1 << (lid & 31)) >>> 0) - 1));
        rank[lid] = rk;
        total[lid] = tot;
        base[lid] = shared.load(CURSOR + d);
      });
      // (c) write, clear the mark, advance the cursor (one writer per digit), then B3.
      wg.phase((lid) => {
        if (!active(lid)) return;
        const d = digit[lid];
        const dst = base[lid] + rank[lid];
        if (dst < n) {
          valsOut.write(dst, val[lid * ROUNDS + r]);
          if (pass !== LAST_PASS) {
            keysOut.write(dst, lo[lid * ROUNDS + r]);
            keysOut.write(CAP + dst, hi[lid * ROUNDS + r]);
          }
        } else {
          hist.atomicOr(0, DIAG_SCATTER_OOB);
        }
        shared.atomicStore(MASKS + d * MASK_WORDS + (lid >>> 5), 0);
        if (rank[lid] === total[lid] - 1) shared.store(CURSOR + d, base[lid] + total[lid]);
      });
    }
  });
}

/**
 * One frame of `TransparentSortPass`: prepare, then — when B > 0 — the gather
 * and 7 × (upsweep, scan, scatter). `valsB` ends up holding the order. The
 * buffers start as STALE_WORD, like a GPU buffer holding the last frame.
 */
export function runSortModel(input: SortModelInput, schedule?: Schedule): SortModelBuffers {
  const bufs = createSortModelBuffers(STALE_WORD);
  cpuPrepare(bufs, input.limit);
  if (input.limit === 0) return bufs; // B = 0: the pass encodes nothing
  cpuGather(input, bufs, schedule);
  for (let p = 0; p < PASSES; p++) {
    cpuUpsweep(p, bufs, schedule);
    cpuScan(p, bufs, schedule);
    cpuScatter(p, bufs, schedule);
  }
  return bufs;
}
