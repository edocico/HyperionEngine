/**
 * Per-pass GPU timing for the RenderGraph, built on the `timestamp-query`
 * WebGPU feature.
 *
 * ## How it works, and why it looks odd
 *
 * WebGPU has no `encoder.writeTimestamp()`. The proposal that would allow
 * timestamps *inside* a pass (`timestamp-query-inside-passes`) is Inactive, so
 * the only timestamps available are `beginningOfPassWriteIndex` and
 * `endOfPassWriteIndex` on a pass descriptor.
 *
 * Threading a `timestampWrites` object through every `RenderPass` would mean
 * editing ten pass implementations, several of which (BloomPass) open six
 * sub-passes of their own. Instead this profiler inserts **empty compute
 * passes as markers** between the graph's passes. An empty compute pass
 * dispatches no work; it exists only to carry one timestamp. Pass `i`'s
 * duration is then `marker[i+1] - marker[i]`.
 *
 * ## Two caveats that decide how much to trust a number
 *
 * 1. **Markers measure command-stream boundaries, not isolated pass cost.**
 *    A delta is "how long until the GPU reached this point", not "how long
 *    this pass owned the GPU" — adjacent work can overlap. Good enough to
 *    answer "what fraction of the frame does the JFA chain cost"; not good
 *    enough to attribute microseconds to a single draw call.
 *
 * 2. **Chrome quantizes timestamps to 100 microseconds** by default, as a
 *    side-channel mitigation. A pass costing 60us reads as 0 or 100us on any
 *    given frame. This is why {@link PassTiming.averageMs} exists and is the
 *    number to quote: over {@link WINDOW} frames the quantization averages
 *    out. For unquantized values, run Chrome with the
 *    `--enable-webgpu-developer-features` flag (never in production).
 *
 * ## Cost when disabled
 *
 * Zero. The RenderGraph holds `profiler: GpuProfiler | null`; when the device
 * lacks `timestamp-query`, or profiling was never enabled, no marker passes
 * are encoded and no buffers are allocated.
 */

/** Frames of history kept per pass for the rolling mean. */
export const WINDOW = 120;

/** Readback buffers in flight before the profiler starts skipping frames. */
const READBACK_SLOTS = 3;

/** Bytes per timestamp (u64 nanoseconds). */
const TIMESTAMP_SIZE = 8;

export interface PassTiming {
  /** RenderPass name, as registered in the graph. */
  name: string;
  /**
   * Rolling mean over the last resolved frames (up to {@link WINDOW}), in ms.
   * **This is the number to trust** — see the caveat about Chrome's 100us
   * quantization in the module docs.
   */
  averageMs: number;
  /** Most recent resolved sample, in ms. Noisy on its own. */
  lastMs: number;
  /** How many samples the average is over. Below ~30, treat it as warming up. */
  sampleCount: number;
}

interface PendingReadback {
  buffer: GPUBuffer;
  names: string[];
  markerCount: number;
}

export class GpuProfiler {
  /**
   * Whether a device (or adapter) exposes `timestamp-query`.
   *
   * Takes anything with `has()` so it works with both `GPUSupportedFeatures`
   * and a plain `Set` in tests.
   */
  static isSupported(features: { has(name: string): boolean }): boolean {
    return features.has('timestamp-query');
  }

  private readonly capacity: number;
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly allReadbacks: GPUBuffer[] = [];
  private readonly freeReadbacks: GPUBuffer[] = [];
  private readonly pending: PendingReadback[] = [];

  private readonly history = new Map<string, number[]>();
  private readonly latest = new Map<string, number>();

  private frameNames: string[] = [];
  private markerIndex = 0;
  private active = false;
  private destroyed = false;
  private polling = false;

  /** Frames dropped because every readback buffer was still in flight. */
  private skipped = 0;

  constructor(device: GPUDevice, maxPasses = 32) {
    // One marker before each pass, plus a closing marker after the last.
    this.capacity = maxPasses + 1;
    const byteSize = this.capacity * TIMESTAMP_SIZE;

    this.querySet = device.createQuerySet({ type: 'timestamp', count: this.capacity });
    this.resolveBuffer = device.createBuffer({
      size: byteSize,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      label: 'gpu-profiler-resolve',
    });

    for (let i = 0; i < READBACK_SLOTS; i++) {
      const buffer = device.createBuffer({
        size: byteSize,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        label: `gpu-profiler-readback-${i}`,
      });
      this.allReadbacks.push(buffer);
      this.freeReadbacks.push(buffer);
    }
  }

  /** True while the current frame is being measured. */
  get measuring(): boolean {
    return this.active;
  }

  /** Frames skipped because all readback buffers were busy. */
  get skippedFrames(): number {
    return this.skipped;
  }

  /**
   * Open a measured frame. Returns false — and the caller must then skip
   * {@link mark} and {@link endFrame} — when there is no free readback buffer
   * or the graph has more passes than this profiler was sized for.
   */
  beginFrame(passNames: readonly string[]): boolean {
    if (this.destroyed || this.active) return false;
    if (passNames.length + 1 > this.capacity) return false;
    if (this.freeReadbacks.length === 0) {
      this.skipped++;
      return false;
    }
    this.frameNames = [...passNames];
    this.markerIndex = 0;
    this.active = true;
    return true;
  }

  /** Encode one timestamp marker. Call immediately before each pass executes. */
  mark(encoder: GPUCommandEncoder): void {
    if (!this.active || this.markerIndex >= this.capacity) return;
    encoder
      .beginComputePass({
        label: `gpu-profiler-marker-${this.markerIndex}`,
        timestampWrites: {
          querySet: this.querySet,
          beginningOfPassWriteIndex: this.markerIndex,
        },
      })
      .end();
    this.markerIndex++;
  }

  /**
   * Write the closing marker and queue the resolve + copy. Must be called on
   * the same encoder as the marks, before `encoder.finish()`.
   */
  endFrame(encoder: GPUCommandEncoder): void {
    if (!this.active) return;
    this.mark(encoder);

    const markerCount = this.markerIndex;
    this.active = false;

    // Fewer than two markers means nothing to diff.
    if (markerCount < 2) return;

    const buffer = this.freeReadbacks.pop();
    if (!buffer) return;

    encoder.resolveQuerySet(this.querySet, 0, markerCount, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(
      this.resolveBuffer, 0,
      buffer, 0,
      markerCount * TIMESTAMP_SIZE,
    );
    this.pending.push({ buffer, names: this.frameNames, markerCount });
  }

  /**
   * Map and parse any resolved frames. Fire-and-forget after `queue.submit()`.
   * Re-entrant calls are no-ops while a previous poll is still awaiting.
   */
  async poll(): Promise<void> {
    if (this.polling || this.destroyed) return;
    this.polling = true;

    // Drain synchronously so a concurrent endFrame() cannot mutate mid-await.
    const batch = this.pending.splice(0, this.pending.length);

    try {
      for (const entry of batch) {
        if (this.destroyed) return;
        try {
          await entry.buffer.mapAsync(GPUMapMode.READ);
          this.consume(entry);
          entry.buffer.unmap();
        } catch {
          // Device lost, or the buffer was destroyed mid-flight. Drop the
          // frame — timing data is never worth surfacing an error for.
        } finally {
          if (!this.destroyed) this.freeReadbacks.push(entry.buffer);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private consume(entry: PendingReadback): void {
    const stamps = new BigInt64Array(
      entry.buffer.getMappedRange(0, entry.markerCount * TIMESTAMP_SIZE).slice(0),
    );

    // A zero timestamp means the query never got written (feature disabled
    // mid-flight, or a driver quirk). Treat the whole frame as invalid rather
    // than reporting a bogus multi-second delta.
    for (let i = 0; i < stamps.length; i++) {
      if (stamps[i] === 0n) return;
    }

    for (let i = 0; i < entry.names.length; i++) {
      const deltaNs = stamps[i + 1] - stamps[i];
      // Timestamps are not guaranteed monotonic across passes; clamp.
      const ms = deltaNs > 0n ? Number(deltaNs) / 1e6 : 0;
      const name = entry.names[i];

      this.latest.set(name, ms);
      let samples = this.history.get(name);
      if (!samples) {
        samples = [];
        this.history.set(name, samples);
      }
      samples.push(ms);
      if (samples.length > WINDOW) samples.shift();
    }
  }

  /** Current timings, one entry per pass measured at least once. */
  timings(): PassTiming[] {
    const out: PassTiming[] = [];
    for (const [name, samples] of this.history) {
      if (samples.length === 0) continue;
      let sum = 0;
      for (const s of samples) sum += s;
      out.push({
        name,
        averageMs: sum / samples.length,
        lastMs: this.latest.get(name) ?? 0,
        sampleCount: samples.length,
      });
    }
    return out;
  }

  /** Same data as {@link timings}, keyed by pass name for direct lookup. */
  getTimingsByName(): Map<string, PassTiming> {
    const map = new Map<string, PassTiming>();
    for (const t of this.timings()) map.set(t.name, t);
    return map;
  }

  /** Sum of every pass average — an approximate GPU frame cost, in ms. */
  totalAverageMs(): number {
    let total = 0;
    for (const t of this.timings()) total += t.averageMs;
    return total;
  }

  /** Drop accumulated history. Call after changing the graph or resolution. */
  reset(): void {
    this.history.clear();
    this.latest.clear();
    this.skipped = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.active = false;
    this.pending.length = 0;
    this.freeReadbacks.length = 0;
    for (const buffer of this.allReadbacks) buffer.destroy();
    this.allReadbacks.length = 0;
    this.resolveBuffer.destroy();
    this.querySet.destroy();
    this.history.clear();
    this.latest.clear();
  }
}
