/**
 * Timestamp interception for one measured frame (design
 * docs/plans/2026-09-29-gpu-profiler-timestamp-writes-design.md, §4).
 *
 * `instrumentEncoder` overrides `beginRenderPass`/`beginComputePass` as OWN
 * properties of one command encoder, never its prototype: every pass opened on
 * it gets a pair of timestamp queries, and the pass encoder it returns has its
 * work commands wrapped, so the frame knows which passes did work. On Metal a
 * pass without work is not sampled and keeps its indices' previous stamps
 * (Mac M2 tests, probes 2 and 4): a pair counts only if its pass did work.
 */

/** The timestamp writes of pair k: index 2k at the beginning, 2k + 1 at the end. */
interface PairWrites {
  querySet: GPUQuerySet;
  beginningOfPassWriteIndex: number;
  endOfPassWriteIndex: number;
}

/** One measured pass: its profiler name, and whether it recorded any work. */
export interface TimedPair {
  readonly name: string;
  work: boolean;
}

/** WebIDL reads a GPUSize32 argument ([EnforceRange] unsigned long) as its integer part. */
const integer = (value: number): number => Math.trunc(value);

/** Whether `draw`/`drawIndexed` with these counts makes the GPU sample the pass. */
export function drawDoesWork(count: number, instanceCount = 1): boolean {
  return integer(count) > 0 && integer(instanceCount) > 0;
}

/** Whether `dispatchWorkgroups` with these sizes makes the GPU sample the pass. */
export function dispatchDoesWork(x: number, y = 1, z = 1): boolean {
  return integer(x) > 0 && integer(y) > 0 && integer(z) > 0;
}

/**
 * The bookkeeping of ONE measured frame: which pass owns which query pair, and
 * under which name. The GPU objects stay in GpuProfiler.
 */
export class FrameRecorder {
  readonly pairs: TimedPair[] = [];
  /** A pass found every pair taken: the frame cannot be complete. */
  truncated = false;
  private node: string | null = null;
  private current: string | null = null;

  constructor(private readonly querySet: GPUQuerySet, private readonly maxPairs: number) {}

  /** Passes opened from now on belong to `name`; none is timed when `profiled` is false. */
  enterNode(name: string, profiled: boolean): void {
    this.node = profiled ? name : null;
    this.current = this.node;
  }

  /** Passes opened from now on are named `node/stage`. Ignored outside a profiled node. */
  enterStage(stage: string): void {
    if (this.node !== null) this.current = `${this.node}/${stage}`;
  }

  /**
   * The descriptor for the native `begin*Pass`, and the pair it carries: null
   * (and the original descriptor) when the pass is not timed.
   */
  derive<D extends object>(desc: D | undefined): { desc: D | undefined; pair: TimedPair | null } {
    if (this.current === null) return { desc, pair: null };
    if (desc !== undefined && (desc as { timestampWrites?: unknown }).timestampWrites !== undefined) {
      return { desc, pair: null };
    }
    if (this.pairs.length >= this.maxPairs) {
      this.truncated = true;
      return { desc, pair: null };
    }
    const k = this.pairs.length;
    const pair: TimedPair = { name: this.current, work: false };
    this.pairs.push(pair);
    const timestampWrites: PairWrites = {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 2 * k,
      endOfPassWriteIndex: 2 * k + 1,
    };
    // The original is never written: its members are read through the prototype
    // (WebIDL reads dictionary members with [[Get]]; Chrome accepts it, probe 2).
    const derived = Object.create(desc ?? {}, {
      timestampWrites: { value: timestampWrites, enumerable: true },
    }) as D;
    return { desc: derived, pair };
  }
}

/**
 * Replace method `key` of `obj` with an own property that calls `before` with
 * the arguments, then the original with them (or with what `before` returns).
 * A method the object lacks is left alone.
 */
function wrap(obj: object, key: string, before: (args: unknown[]) => unknown[] | void): void {
  const target = obj as unknown as Record<string, unknown>;
  const original = target[key];
  if (typeof original !== 'function') return;
  target[key] = (...args: unknown[]) => {
    const forwarded = before(args) ?? args;
    return (original as (...a: unknown[]) => unknown).apply(obj, forwarded);
  };
}

function trackRenderWork(pass: GPURenderPassEncoder, pair: TimedPair): void {
  const draw = (args: unknown[]) => {
    if (drawDoesWork(args[0] as number, args[1] as number | undefined)) pair.work = true;
  };
  wrap(pass, 'draw', draw);
  wrap(pass, 'drawIndexed', draw);
  // Indirect commands are sampled even at a count of 0 (probe 2).
  wrap(pass, 'drawIndirect', () => { pair.work = true; });
  wrap(pass, 'drawIndexedIndirect', () => { pair.work = true; });
  // A bundle's content cannot be seen: an empty one leaves a stale end stamp,
  // which the frame checks catch (design §4.4).
  wrap(pass, 'executeBundles', (args) => {
    const bundles = Array.from(args[0] as Iterable<GPURenderBundle>);
    if (bundles.length > 0) pair.work = true;
    return [bundles];
  });
}

function trackComputeWork(pass: GPUComputePassEncoder, pair: TimedPair): void {
  wrap(pass, 'dispatchWorkgroups', (args) => {
    if (dispatchDoesWork(args[0] as number, args[1] as number | undefined, args[2] as number | undefined)) {
      pair.work = true;
    }
  });
  wrap(pass, 'dispatchWorkgroupsIndirect', () => { pair.work = true; });
}

/**
 * Time every pass opened on `encoder` from now on, through `recorder`. Own
 * properties of this encoder only: other encoders (particles, the debug
 * probe) and the prototype stay native, and the encoder dies with finish().
 */
export function instrumentEncoder(encoder: GPUCommandEncoder, recorder: FrameRecorder): void {
  const nativeRender = encoder.beginRenderPass;
  const nativeCompute = encoder.beginComputePass;
  encoder.beginRenderPass = (descriptor: GPURenderPassDescriptor): GPURenderPassEncoder => {
    const { desc, pair } = recorder.derive(descriptor);
    const pass = nativeRender.call(encoder, desc as GPURenderPassDescriptor);
    if (pair) trackRenderWork(pass, pair);
    return pass;
  };
  encoder.beginComputePass = (descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder => {
    const { desc, pair } = recorder.derive(descriptor);
    const pass = nativeCompute.call(encoder, desc);
    if (pair) trackComputeWork(pass, pair);
    return pass;
  };
}
