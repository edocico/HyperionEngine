/**
 * Per-pass GPU timing for the RenderGraph, built on the `timestamp-query`
 * WebGPU feature (design docs/plans/2026-09-29-gpu-profiler-timestamp-writes-design.md).
 *
 * ## How it works
 *
 * In a measured frame the graph hands the profiler its command encoder
 * (`instrument`), and every render or compute pass opened on it gets a pair
 * of timestamp queries through its own `timestampWrites`: the beginning and
 * the end of the pass itself (timestamp-intercept.ts). The profiler resolves
 * the pairs at the end of the frame, reads them back a few frames later, and
 * keeps the frame only if its command buffer ran (the seal) and every pass
 * that did work has non-zero, ordered, refreshed stamps (timestamp-frames.ts).
 * An unmeasured frame is untouched: no query, no wrapper.
 *
 * Until 2026-09-29 the profiler put empty compute passes between the graph's
 * passes as markers. On Metal a pass without work is never sampled, so every
 * marker read 0 and nothing was ever reported (Mac M2 tests, M7).
 *
 * ## Three things that decide how much to trust a number
 *
 * 1. **The entries do not add up to the frame.** Independent passes overlap
 *    on some GPUs (the Apple M2 does), so a pass's duration includes time it
 *    shared with others. The frame is {@link GpuProfiler.frameTiming}: from
 *    the first beginning to the last end.
 * 2. **Quantization.** Chrome without `--enable-webgpu-developer-features`
 *    rounds timestamps: to 65 536 ns on macOS/Metal (Chrome 154, 2026-09-29),
 *    to about 1 us on Linux/Vulkan. Quote `averageMs`: over {@link WINDOW}
 *    frames the rounding averages out.
 * 3. **Only passes with work are measured.** A pass that recorded no draw or
 *    dispatch (a clear alone) is not sampled on Metal: its name counts 0 ms.
 *
 * ## Cost when disabled
 *
 * Zero: `createRenderer` builds no GpuProfiler until `enableGpuProfiling()`,
 * and the graph calls nothing on an unmeasured frame.
 */
import { FrameRecorder, instrumentEncoder, type TimedPair } from './timestamp-intercept';
import {
  StampHistory, TimingWindow, evaluateFrame, WINDOW,
  type DiscardReason, type GpuFrameTiming, type PassTiming,
} from './timestamp-frames';

export { WINDOW, DISCARD_ORDER } from './timestamp-frames';
export type { DiscardReason, GpuFrameTiming, PassTiming } from './timestamp-frames';

/** Readback buffers in flight before the profiler starts skipping frames. */
const READBACK_SLOTS = 3;
/** Bytes per timestamp (u64 nanoseconds). */
const TIMESTAMP_SIZE = 8;
/** The seal: a u32 sequence number, copied to a readback's tail. */
const SEAL_BYTES = 4;
/** Room after the stamps in a readback: the seal, kept 8-byte aligned. */
const READBACK_TAIL = 8;
/** Discarded frames in a row before the one warning: two seconds at 60 fps. */
const WARN_AFTER = WINDOW;

/** The next frame's seal: 1..0xFFFFFFFF, never 0, which is what a rejected frame reads. */
export function nextSeal(previous: number): number {
  return previous >= 0xffffffff ? 1 : previous + 1;
}

function describeDiscard(reason: DiscardReason, pass: string | undefined): string {
  const who = pass !== undefined ? `pass '${pass}'` : 'a pass';
  switch (reason) {
    case 'unexecuted': return "the frames' command buffers did not run (a GPU validation error in the frame)";
    case 'truncated': return 'every frame opened more passes than the profiler has query pairs for';
    case 'zero': return `${who} did work but read back a zero timestamp (this browser does not serve timestamps)`;
    case 'reversed': return `${who} read back an end timestamp before its beginning`;
    case 'stale': return `${who} did work but its timestamps were not refreshed`;
    case 'empty': return 'no measured pass recorded any work';
  }
}

interface PendingReadback {
  buffer: GPUBuffer;
  pairs: readonly TimedPair[];
  truncated: boolean;
  seal: number;
  /**
   * Value of {@link GpuProfiler.generation} when the frame was queued
   * (`endFrame`). `beginFrame()` and `endFrame()` run inside one synchronous
   * `RenderGraph.render()`, and `reset()` is never called during it, so it is
   * also the generation the frame was opened under.
   */
  generation: number;
}

export class GpuProfiler {
  /**
   * Whether a device (or adapter) exposes `timestamp-query`. Takes anything
   * with `has()`, so it works with `GPUSupportedFeatures` and a plain `Set`.
   */
  static isSupported(features: { has(name: string): boolean }): boolean {
    return features.has('timestamp-query');
  }

  private readonly maxPairs: number;
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly sealBuffer: GPUBuffer;
  private readonly allReadbacks: GPUBuffer[] = [];
  private readonly freeReadbacks: GPUBuffer[] = [];
  private readonly pending: PendingReadback[] = [];
  private readonly window = new TimingWindow();
  private readonly history: StampHistory;
  private readonly discards: Record<DiscardReason, number> = {
    unexecuted: 0, truncated: 0, zero: 0, reversed: 0, stale: 0, empty: 0,
  };

  private recorder: FrameRecorder | null = null;
  private destroyed = false;
  private polling = false;
  /**
   * Bumped by {@link reset}: the frames still in flight were measured under a
   * graph that no longer exists, and are dropped when read.
   */
  private generation = 0;
  private seal = 0;
  private skipped = 0;
  /** The current run of discarded frames: its length, and per reason how many and the last pass blamed. */
  private streak = 0;
  private readonly streakReasons = new Map<DiscardReason, { count: number; pass?: string }>();
  private warned = false;
  private warnedTruncation = false;
  /** A failure while reading a mapped frame was already reported: once per profiler. */
  private reportedReadFailure = false;

  /**
   * @param maxPairs timestamp pairs per frame, one per measured pass. 512:
   *   the worst frame the design estimates opens about 250 (§4.5). The query
   *   set is 8 KB and exists only while profiling.
   */
  constructor(private readonly device: GPUDevice, maxPairs = 512) {
    this.maxPairs = maxPairs;
    const queries = 2 * maxPairs;
    const stampBytes = queries * TIMESTAMP_SIZE;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: queries, label: 'gpu-profiler' });
    this.resolveBuffer = device.createBuffer({
      size: stampBytes,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      label: 'gpu-profiler-resolve',
    });
    this.sealBuffer = device.createBuffer({
      size: SEAL_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      label: 'gpu-profiler-seal',
    });
    this.history = new StampHistory(queries);
    for (let i = 0; i < READBACK_SLOTS; i++) {
      const buffer = device.createBuffer({
        size: stampBytes + READBACK_TAIL,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        label: `gpu-profiler-readback-${i}`,
      });
      this.allReadbacks.push(buffer);
      this.freeReadbacks.push(buffer);
    }
  }

  /** True while the current frame is being measured. */
  get measuring(): boolean {
    return this.recorder !== null;
  }

  /** Frames skipped because all readback buffers were busy. */
  get skippedFrames(): number {
    return this.skipped;
  }

  /** Frames read back and discarded, for any reason (see {@link discardReasons}). */
  get discardedFrames(): number {
    let total = 0;
    for (const n of Object.values(this.discards)) total += n;
    return total;
  }

  /** Discarded frames by reason, since the profiler was created: survives {@link reset}. */
  get discardReasons(): Readonly<Record<DiscardReason, number>> {
    return { ...this.discards };
  }

  /** Frames discarded because they opened more passes than `maxPairs`. */
  get truncatedFrames(): number {
    return this.discards.truncated;
  }

  /**
   * Open a measured frame. Returns false, and the caller must then call none
   * of the other frame methods, when there is no free readback buffer.
   */
  beginFrame(): boolean {
    if (this.destroyed || this.recorder) return false;
    if (this.freeReadbacks.length === 0) {
      this.skipped++;
      return false;
    }
    this.recorder = new FrameRecorder(this.querySet, this.maxPairs);
    return true;
  }

  /** Time every pass opened on `encoder` from now on (the frame's encoder, once per frame). */
  instrument(encoder: GPUCommandEncoder): void {
    if (this.recorder) instrumentEncoder(encoder, this.recorder);
  }

  /** The passes opened from now on belong to node `name`; not timed when `profiled` is false. */
  enterNode(name: string, profiled: boolean): void {
    this.recorder?.enterNode(name, profiled);
  }

  /** The passes opened from now on are named `node/stage`. */
  enterStage(stage: string): void {
    this.recorder?.enterStage(stage);
  }

  /**
   * Abandon the frame opened by {@link beginFrame}: a pass threw, and the
   * encoder is discarded without a submit, so the GPU wrote nothing.
   */
  abortFrame(): void {
    this.recorder = null;
  }

  /**
   * Queue the resolve, the copy and the seal. Call on the frame's encoder,
   * after the last pass and before `encoder.finish()`.
   */
  endFrame(encoder: GPUCommandEncoder): void {
    const recorder = this.recorder;
    if (!recorder) return;
    this.recorder = null;
    const buffer = this.freeReadbacks.pop();
    if (!buffer) return;
    const pairs = recorder.pairs.length;
    const stampBytes = 2 * pairs * TIMESTAMP_SIZE;
    this.seal = nextSeal(this.seal);
    // Queue writes run even when the frame's command buffer is rejected; the
    // copies below run only with it. A rejected frame reads 0 where its seal
    // should be, and an older frame's stamps before it (design §4.6).
    this.device.queue.writeBuffer(buffer, stampBytes, new Uint32Array([0]));
    this.device.queue.writeBuffer(this.sealBuffer, 0, new Uint32Array([this.seal]));
    if (pairs > 0) {
      encoder.resolveQuerySet(this.querySet, 0, 2 * pairs, this.resolveBuffer, 0);
      encoder.copyBufferToBuffer(this.resolveBuffer, 0, buffer, 0, stampBytes);
    }
    encoder.copyBufferToBuffer(this.sealBuffer, 0, buffer, stampBytes, SEAL_BYTES);
    this.pending.push({
      buffer, pairs: recorder.pairs, truncated: recorder.truncated, seal: this.seal, generation: this.generation,
    });
  }

  /**
   * Map and read the frames queued so far. Fire-and-forget after
   * `queue.submit()`; a call while another is still reading does nothing.
   */
  async poll(): Promise<void> {
    if (this.polling || this.destroyed) return;
    this.polling = true;
    // Drain synchronously, so that a concurrent endFrame() cannot change the batch mid-await.
    const batch = this.pending.splice(0, this.pending.length);
    try {
      for (const entry of batch) {
        if (this.destroyed) return;
        let mapped = false;
        try {
          await entry.buffer.mapAsync(GPUMapMode.READ);
          mapped = true;
          // Unmapped whatever consume() does: a buffer back in the pool
          // still mapped would fail every later copy into it.
          try {
            this.consume(entry);
          } finally {
            entry.buffer.unmap();
          }
        } catch (err) {
          // Two different failures land here, and the frame is gone in both,
          // with what its queries held (design §6.3). Before the map: the
          // device was lost, or the buffer destroyed mid-flight; expected,
          // and silent. After it: reading the mapped range failed, which is
          // a bug and not a lost device, and it would stop all reporting
          // with no discard counted and no warning: reported, once.
          this.history.forget(2 * entry.pairs.length);
          if (mapped && !this.reportedReadFailure) {
            this.reportedReadFailure = true;
            console.error('[Hyperion] GPU profiler: reading a resolved frame failed; its timings are dropped.', err);
          }
        } finally {
          if (!this.destroyed) this.freeReadbacks.push(entry.buffer);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private consume(entry: PendingReadback): void {
    const stampBytes = 2 * entry.pairs.length * TIMESTAMP_SIZE;
    const data = entry.buffer.getMappedRange(0, stampBytes + SEAL_BYTES).slice(0);
    const stamps = new BigUint64Array(data, 0, 2 * entry.pairs.length);
    const executed = new Uint32Array(data, stampBytes, 1)[0] === entry.seal;
    const verdict = evaluateFrame(
      { stamps, pairs: entry.pairs, truncated: entry.truncated, executed },
      this.history,
    );
    // Every executed frame wrote its queries, discarded or not: the history
    // follows the query set in submission order (design §6.3).
    if (executed) this.history.record(stamps);
    // Measured under a graph that has since been reset: no sample, no count.
    if (entry.generation !== this.generation) return;
    if (!verdict.ok) {
      this.noteDiscard(verdict.reason, verdict.pass);
      return;
    }
    this.streak = 0;
    this.streakReasons.clear();
    this.window.push(verdict.totalsMs, verdict.spanMs);
  }

  private noteDiscard(reason: DiscardReason, pass: string | undefined): void {
    this.discards[reason]++;
    if (reason === 'truncated' && !this.warnedTruncation) {
      this.warnedTruncation = true;
      console.warn(
        `[Hyperion] GPU profiling: a frame opened more than ${this.maxPairs} passes, so its timings ` +
        `were dropped. Build the GpuProfiler with a larger maxPairs.`,
      );
    }
    this.streak++;
    const entry = this.streakReasons.get(reason) ?? { count: 0 };
    entry.count++;
    if (pass !== undefined) entry.pass = pass;
    this.streakReasons.set(reason, entry);
    if (this.warned || this.streak < WARN_AFTER) return;
    this.warned = true;
    let top = reason;
    let topCount = 0;
    for (const [r, e] of this.streakReasons) {
      if (e.count > topCount) {
        top = r;
        topCount = e.count;
      }
    }
    console.warn(
      `[Hyperion] GPU profiling is enabled but the last ${this.streak} frames were discarded: ` +
      `${describeDiscard(top, this.streakReasons.get(top)?.pass)}. No timings will be reported until that changes.`,
    );
  }

  /**
   * Current timings, one entry per pass or stage measured in the last
   * {@link WINDOW} valid frames. A frame without it counts as 0 ms, so
   * `averageMs` is a mean per frame, and every entry has the same `sampleCount`.
   */
  timings(): PassTiming[] {
    return this.window.timings();
  }

  /** Same data as {@link timings}, keyed by name. */
  getTimingsByName(): Map<string, PassTiming> {
    const map = new Map<string, PassTiming>();
    for (const t of this.timings()) map.set(t.name, t);
    return map;
  }

  /** The frame span over the same frames as {@link timings}; null before the first valid frame. */
  frameTiming(): GpuFrameTiming | null {
    return this.window.frameTiming();
  }

  /**
   * Drop the accumulated history and invalidate every frame still in flight.
   * Call after changing the graph or the resolution. Discard counts survive:
   * they describe what this browser does, not what one graph measured.
   */
  reset(): void {
    this.window.clear();
    this.skipped = 0;
    this.generation++;
    // The frames in flight are never read, so the history cannot follow the
    // queries they wrote.
    this.history.forgetAll();
    // Recycle their buffers: dropping only the entries would shrink the pool
    // until every frame is skipped. A buffer that still has a copy encoded
    // against it is safe to reuse: the GPU runs that copy before the next one.
    for (const entry of this.pending) this.freeReadbacks.push(entry.buffer);
    this.pending.length = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.recorder = null;
    this.pending.length = 0;
    this.freeReadbacks.length = 0;
    for (const buffer of this.allReadbacks) buffer.destroy();
    this.allReadbacks.length = 0;
    this.resolveBuffer.destroy();
    this.sealBuffer.destroy();
    this.querySet.destroy();
    this.window.clear();
  }
}
