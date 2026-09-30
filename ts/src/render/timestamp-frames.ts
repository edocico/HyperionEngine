/**
 * What a resolved frame of timestamps is worth (design
 * docs/plans/2026-09-29-gpu-profiler-timestamp-writes-design.md, §6): the
 * validity rules, the per-index history of the last values read, and the
 * rolling window the profiler reports from. Pure: no GPU object.
 */
import type { TimedPair } from './timestamp-intercept';

/** Frames of history kept per pass for the rolling mean. */
export const WINDOW = 120;

export interface PassTiming {
  /** The pass's node name, or `node/stage` for a named stage. */
  name: string;
  /**
   * Rolling mean over the last valid frames (up to {@link WINDOW}), in ms.
   * **Quote this rather than `lastMs`**: over the window, the timestamp
   * quantization of Chrome without `--enable-webgpu-developer-features` or
   * `--enable-unsafe-webgpu` averages out.
   */
  averageMs: number;
  /** Most recent valid frame, in ms. Noisy on its own. */
  lastMs: number;
  /** How many frames the average is over. Below ~30, treat it as warming up. */
  sampleCount: number;
}

/** The frame span: from the first measured beginning to the last measured end. */
export interface GpuFrameTiming {
  /** Rolling mean over the same frames as {@link PassTiming.averageMs}, in ms. */
  averageMs: number;
  /** Most recent span, in ms. */
  lastMs: number;
  /** How many frames the mean is over. */
  sampleCount: number;
}

/**
 * A frame with several reasons counts under the first of these (design §6.4).
 * The one source of the reasons: {@link DiscardReason} is derived from it, so a
 * reason cannot be missing from the order (it would rank -1 and outrank all).
 */
export const DISCARD_ORDER = ['unexecuted', 'truncated', 'zero', 'reversed', 'stale', 'empty'] as const;

export type DiscardReason = (typeof DISCARD_ORDER)[number];

export interface ResolvedFrame {
  /** Pair k's stamps at 2k (beginning) and 2k + 1 (end), in nanoseconds. */
  readonly stamps: BigUint64Array;
  readonly pairs: readonly TimedPair[];
  readonly truncated: boolean;
  /** The frame's seal came back: its command buffer ran (design §4.6). */
  readonly executed: boolean;
}

export type FrameVerdict =
  | { readonly ok: true; readonly totalsMs: ReadonlyMap<string, number>; readonly spanMs: number }
  | { readonly ok: false; readonly reason: DiscardReason; readonly pass?: string };

/**
 * The last value read for every query index. A stamp equal to it was not
 * refreshed by its pass: on Metal an unsampled pass leaves stale stamps (a
 * compute pass both, a render pass its end; probe 2). Only a safety net: the
 * work rule is the real defence (design §6.2).
 */
export class StampHistory {
  private readonly last: BigUint64Array;
  private readonly known: Uint8Array;

  constructor(size: number) {
    this.last = new BigUint64Array(size);
    this.known = new Uint8Array(size);
  }

  /** True when `value` is exactly the last value read at `index`. */
  isStale(index: number, value: bigint): boolean {
    return this.known[index] === 1 && this.last[index] === value;
  }

  /**
   * The values of an executed frame, in submission order.
   * @throws RangeError when there are more stamps than indices: a wiring bug,
   *   and the tail would otherwise be dropped without a word.
   */
  record(stamps: BigUint64Array): void {
    if (stamps.length > this.last.length) {
      throw new RangeError(`StampHistory.record: ${stamps.length} stamps for a history of ${this.last.length} indices`);
    }
    for (let i = 0; i < stamps.length; i++) {
      this.last[i] = stamps[i];
      this.known[i] = 1;
    }
  }

  /** Indices 0..count-1 are unknown: a readback was lost. */
  forget(count: number): void {
    this.known.fill(0, 0, count);
  }

  forgetAll(): void {
    this.known.fill(0);
  }
}

const rank = (reason: DiscardReason) => DISCARD_ORDER.indexOf(reason);

/**
 * Keep or discard one frame (design §6.2-§6.5). Does not touch the history.
 * @throws RangeError when the frame holds fewer stamps than two per pair: a
 *   wiring bug, not a reason to discard, and the missing stamps would otherwise
 *   be read as `undefined`.
 */
export function evaluateFrame(frame: ResolvedFrame, history: StampHistory): FrameVerdict {
  if (frame.stamps.length < 2 * frame.pairs.length) {
    throw new RangeError(`evaluateFrame: ${frame.stamps.length} stamps for ${frame.pairs.length} pairs (two per pair)`);
  }
  if (!frame.executed) return { ok: false, reason: 'unexecuted' };
  if (frame.truncated) return { ok: false, reason: 'truncated' };
  let found: { reason: DiscardReason; pass: string } | null = null;
  const totalsMs = new Map<string, number>();
  let first = 0n;
  let last = 0n;
  let measured = false;
  for (let k = 0; k < frame.pairs.length; k++) {
    const pair = frame.pairs[k];
    if (!totalsMs.has(pair.name)) totalsMs.set(pair.name, 0);
    if (!pair.work) continue;
    const begin = frame.stamps[2 * k];
    const end = frame.stamps[2 * k + 1];
    let reason: DiscardReason | null = null;
    if (begin === 0n || end === 0n) reason = 'zero';
    else if (end < begin) reason = 'reversed';
    else if (history.isStale(2 * k, begin) || history.isStale(2 * k + 1, end)) reason = 'stale';
    if (reason !== null) {
      if (found === null || rank(reason) < rank(found.reason)) found = { reason, pass: pair.name };
      continue;
    }
    totalsMs.set(pair.name, totalsMs.get(pair.name)! + Number(end - begin) / 1e6);
    if (!measured || begin < first) first = begin;
    if (!measured || end > last) last = end;
    measured = true;
  }
  if (found !== null) return { ok: false, reason: found.reason, pass: found.pass };
  if (!measured) return { ok: false, reason: 'empty' };
  return { ok: true, totalsMs, spanMs: Number(last - first) / 1e6 };
}

/**
 * The rolling window of valid frames. Every mean is a mean per frame over the
 * same frames: a name missing from a frame took 0 ms in it, a name seen for
 * the first time took 0 ms in the window's earlier frames, and a name missing
 * for a whole window is forgotten (LightGroupsPass drops seed/sdf when its SDF
 * sets go to zero, with no graph change).
 */
export class TimingWindow {
  private readonly samples = new Map<string, number[]>();
  private readonly latest = new Map<string, number>();
  private readonly missing = new Map<string, number>();
  private readonly spans: number[] = [];
  private lastSpan = 0;
  private frames = 0;

  push(totalsMs: ReadonlyMap<string, number>, spanMs: number): void {
    this.frames++;
    for (const [name, samples] of this.samples) {
      if (totalsMs.has(name)) continue;
      this.latest.set(name, 0);
      samples.push(0);
      if (samples.length > WINDOW) samples.shift();
      const missing = (this.missing.get(name) ?? 0) + 1;
      if (missing >= WINDOW) {
        this.samples.delete(name);
        this.latest.delete(name);
        this.missing.delete(name);
      } else {
        this.missing.set(name, missing);
      }
    }
    for (const [name, ms] of totalsMs) {
      this.latest.set(name, ms);
      this.missing.delete(name);
      let samples = this.samples.get(name);
      if (!samples) {
        samples = new Array<number>(Math.min(this.frames - 1, WINDOW - 1)).fill(0);
        this.samples.set(name, samples);
      }
      samples.push(ms);
      if (samples.length > WINDOW) samples.shift();
    }
    this.lastSpan = spanMs;
    this.spans.push(spanMs);
    if (this.spans.length > WINDOW) this.spans.shift();
  }

  timings(): PassTiming[] {
    const out: PassTiming[] = [];
    for (const [name, samples] of this.samples) {
      if (samples.length === 0) continue;
      let sum = 0;
      for (const s of samples) sum += s;
      out.push({ name, averageMs: sum / samples.length, lastMs: this.latest.get(name) ?? 0, sampleCount: samples.length });
    }
    return out;
  }

  frameTiming(): GpuFrameTiming | null {
    if (this.spans.length === 0) return null;
    let sum = 0;
    for (const s of this.spans) sum += s;
    return { averageMs: sum / this.spans.length, lastMs: this.lastSpan, sampleCount: this.spans.length };
  }

  clear(): void {
    this.samples.clear();
    this.latest.clear();
    this.missing.clear();
    this.spans.length = 0;
    this.lastSpan = 0;
    this.frames = 0;
  }
}
