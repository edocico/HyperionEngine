import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import { TOTAL_DRAW_BUCKETS } from './cull-pass';
import {
  CAP, DIAG_WORDS, DISPATCH_OFFSET_BYTES, HEADER_BYTES, HEADER_WORDS, HIST_WORDS, H_DISPATCH, H_DRAW, H_LIMIT,
  H_STAMP, PASSES, PASS_PARAMS_STRIDE, STAMP_SENTINEL, TILES_OFFSET, WORKGROUP_SIZE,
} from './transparent-sort-constants';

/** One u32 per slot: entity-ids, the value columns, transparent-order. */
const COLUMN_BYTES = CAP * 4;
/** The keys, SoA in one buffer: lo (the id) at [0, CAP), hi (the z key) at [CAP, 2·CAP). */
const KEYS_BYTES = 2 * COLUMN_BYTES;
const HIST_BYTES = HIST_WORDS * 4;
/** GatherParams, and each PassParams slice: 4 × u32. */
const PARAMS_BYTES = 16;
/** The pool buffers the gather reads, sized as createRenderer allocates them. */
const INDIRECT_ARGS_BYTES = TOTAL_DRAW_BUCKETS * 5 * 4;
const VISIBLE_INDICES_BYTES = TOTAL_DRAW_BUCKETS * CAP * 4;
const BOUNDS_BYTES = CAP * 4 * 4;
/** DrawIndexedIndirect.indexCount of the unit quad. */
const QUAD_INDEX_COUNT = 6;

type SortStage = 'upsweep' | 'scan' | 'scatter';
const SORT_STAGES: readonly SortStage[] = ['upsweep', 'scan', 'scatter'];
/** What profileStages names when the sort runs: 22, in encoding order. */
const PROFILE_STAGES: readonly string[] = ['gather', ...Array.from({ length: PASSES }, () => SORT_STAGES).flat()];

/**
 * The staging buffers of one `engine.debug.readTransparentSort()` request
 * (`TransparentSortProbe`, dev builds only): MAP_READ | COPY_DST, owned by the
 * request and never by the pass, so a pass destroyed while a map is pending
 * cannot break it.
 */
export interface SortReadbackTarget {
  /** The frame it was served in (`FrameState.frameStamp`); header word 11 must say the same. */
  stamp: number;
  /** sort-keys-a after the gather: lo at [0, CAP), hi at [CAP, 2·CAP). */
  gatherKeys: GPUBuffer;
  /** sort-vals-a after the gather: the gathered slots. */
  gatherVals: GPUBuffer;
  /** transparent-args after the sort. */
  header: GPUBuffer;
  /** sort-hist words [0, TILES_OFFSET): diag, then digitBase (7 × 256). */
  hist: GPUBuffer;
  /** transparent-order: the sorted slots. */
  order: GPUBuffer;
}

/** What the pass needs of `TransparentSortProbe`: the head request, taken only in a frame the sort runs. */
export interface SortReadbackTaker {
  take(stamp: number): SortReadbackTarget | null;
}

/** Bytes copied into each {@link SortReadbackTarget} buffer, i.e. the size to create each with. */
export const SORT_READBACK_BYTES = {
  gatherKeys: KEYS_BYTES,
  gatherVals: COLUMN_BYTES,
  header: HEADER_BYTES,
  hist: TILES_OFFSET * 4,
  order: COLUMN_BYTES,
} as const;

/** B: how many transparents the gather may collect this frame (0 = skip the sort). */
function sortBound(frame: FrameState): number {
  const bound = Math.min(frame.transparentCount, CAP);
  return bound > 0 ? Math.floor(bound) : 0;
}

/**
 * Back-to-front order of the transparent primitives (Phase 5b, design
 * 2026-09-27 §5). All on the GPU: a gather of CullPass's transparent buckets
 * 14..25, then a stable 7-pass LSD radix sort on (z key, external id).
 *
 *   gather           ceil(B / 256) workgroups, B = min(transparentCount, CAP)
 *   7 × upsweep      indirect: ceil(n / 1024) tiles (transparent-args at 20 B)
 *       scan         1 workgroup
 *       scatter      indirect, like upsweep
 *
 * Writes `transparent-order` (the sorted slots; ForwardPass's uber draw reads
 * them in place of visible-indices) and `transparent-args` (draw args
 * {6, n, 0, 0, 0}, dispatch args, raw/limit/overflow and the frame stamp).
 * Both are the RENDERER's pool buffers. A hot-reload probe runs setup() and then
 * destroy() on the live pool, so a pass must never register or destroy them.
 *
 * Uniforms are written only where writeBuffer is safe: the 7 PassParams slices
 * once in setup(), and GatherParams, the header reset and diag in prepare().
 * execute() never writes. A writeBuffer lands before the NEXT submit, so one
 * made between passes of a frame is what all of them read.
 *
 * Encoding: one compute pass, in which each dispatch is its own usage scope and
 * sees the writes of the one before. Two passes when a readback takes this
 * frame: the gather's output is copied before pass 1 overwrites it. One pass per
 * stage, 22 in all, while the GPU profiler measures, each after its own `mark`;
 * `profileStages` lists the same 22, or `[]` when the sort is skipped. With a
 * bound of 0 nothing is encoded (a direct `dispatchWorkgroups(0)` is a Dawn
 * warning), and the header written by prepare() already draws 0 instances.
 */
export class TransparentSortPass implements RenderPass {
  readonly name = 'transparent-sort';
  readonly reads = ['indirect-args', 'visible-indices', 'entity-bounds', 'entity-ids'];
  readonly writes = ['transparent-order', 'transparent-args'];
  readonly optional = true;

  /** `transparent-gather.wgsl` (`gather_main`). Set before setup(): renderer.ts, from the `?raw` import. */
  static GATHER_SOURCE = '';
  /** `transparent-sort.wgsl` (`upsweep_main`, `scan_main`, `scatter_main`). */
  static SORT_SOURCE = '';

  private gatherPipeline: GPUComputePipeline | null = null;
  private stagePipelines: Record<SortStage, GPUComputePipeline> | null = null;
  private gatherBindGroup: GPUBindGroup | null = null;
  /** Bind group p: PassParams slice p, A → B for even p, B → A for odd p. */
  private passBindGroups: GPUBindGroup[] = [];
  private keysA: GPUBuffer | null = null;
  private keysB: GPUBuffer | null = null;
  private valsA: GPUBuffer | null = null;
  private hist: GPUBuffer | null = null;
  private gatherParams: GPUBuffer | null = null;
  private passParams: GPUBuffer | null = null;
  /** Pool buffers owned by the renderer: never destroyed here. */
  private args: GPUBuffer | null = null;
  private order: GPUBuffer | null = null;
  private readonly gatherData = new Uint32Array(PARAMS_BYTES / 4);
  private readonly headerData = new Uint32Array(HEADER_WORDS);
  private readonly diagZeros = new Uint32Array(DIAG_WORDS);

  /**
   * @param probe the readback requests of `engine.debug.readTransparentSort()`
   *   (dev builds, the live graph's pass only). A pass built without one, like
   *   the hot-reload probe's, never takes a request.
   */
  constructor(private readonly probe: SortReadbackTaker | null = null) {}

  setup(device: GPUDevice, resources: ResourcePool): void {
    if (!TransparentSortPass.GATHER_SOURCE || !TransparentSortPass.SORT_SOURCE) {
      throw new Error('TransparentSortPass.GATHER_SOURCE and SORT_SOURCE must be set before calling setup()');
    }
    // Read from the pool, never written to it (see the class comment). Looked
    // up first, so a missing one throws before anything is allocated.
    const pooled = (name: string): GPUBuffer => {
      const buffer = resources.getBuffer(name);
      if (!buffer) throw new Error(`TransparentSortPass.setup: missing '${name}' in ResourcePool`);
      return buffer;
    };
    const indirectArgs = pooled('indirect-args');
    const visibleIndices = pooled('visible-indices');
    const bounds = pooled('entity-bounds');
    const entityIds = pooled('entity-ids');
    const args = pooled('transparent-args');
    const order = pooled('transparent-order');

    const dev = typeof __DEV__ !== 'undefined' && __DEV__;
    // COPY_SRC in dev builds: engine.debug.readTransparentSort() copies them out.
    const readback = dev ? GPUBufferUsage.COPY_SRC : 0;
    const keysA = device.createBuffer({ label: 'sort-keys-a', size: KEYS_BYTES, usage: GPUBufferUsage.STORAGE | readback });
    const keysB = device.createBuffer({ label: 'sort-keys-b', size: KEYS_BYTES, usage: GPUBufferUsage.STORAGE | readback });
    const valsA = device.createBuffer({ label: 'sort-vals-a', size: COLUMN_BYTES, usage: GPUBufferUsage.STORAGE | readback });
    const hist = device.createBuffer({
      label: 'sort-hist', size: HIST_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | readback,
    });
    const gatherParams = device.createBuffer({
      label: 'sort-gather-params', size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const passParams = device.createBuffer({
      label: 'sort-pass-params', size: PASSES * PASS_PARAMS_STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.keysA = keysA;
    this.keysB = keysB;
    this.valsA = valsA;
    this.hist = hist;
    this.gatherParams = gatherParams;
    this.passParams = passParams;
    this.args = args;
    this.order = order;

    // The 7 PassParams slices, {passIndex, 0, 0, 0} each at 256·p, written once:
    // they never change, and bind group p pins slice p.
    const slices = new Uint32Array((PASSES * PASS_PARAMS_STRIDE) / 4);
    for (let p = 0; p < PASSES; p++) slices[(p * PASS_PARAMS_STRIDE) / 4] = p;
    device.queue.writeBuffer(passParams, 0, slices);

    // minBindingSize on every entry: a buffer smaller than the kernel expects
    // then fails at bind group creation, not at dispatch time.
    const entry = (binding: number, type: GPUBufferBindingType, minBindingSize: number): GPUBindGroupLayoutEntry =>
      ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type, minBindingSize } });
    const gatherLayout = device.createBindGroupLayout({
      label: 'transparent-gather',
      entries: [
        entry(0, 'uniform', PARAMS_BYTES),                      // GatherParams
        entry(1, 'read-only-storage', INDIRECT_ARGS_BYTES),     // indirect-args
        entry(2, 'read-only-storage', VISIBLE_INDICES_BYTES),   // visible-indices
        entry(3, 'read-only-storage', BOUNDS_BYTES),            // entity-bounds, read as vec4<u32>
        entry(4, 'read-only-storage', COLUMN_BYTES),            // entity-ids
        entry(5, 'storage', KEYS_BYTES),                        // sort-keys-a
        entry(6, 'storage', COLUMN_BYTES),                      // sort-vals-a
        entry(7, 'storage', HEADER_BYTES),                      // transparent-args
      ],
    });
    const sortLayout = device.createBindGroupLayout({
      label: 'transparent-sort',
      entries: [
        entry(0, 'uniform', PARAMS_BYTES),                      // PassParams, slice p
        entry(1, 'read-only-storage', KEYS_BYTES),              // keys in
        entry(2, 'read-only-storage', COLUMN_BYTES),            // values in
        entry(3, 'storage', KEYS_BYTES),                        // keys out
        entry(4, 'storage', COLUMN_BYTES),                      // values out
        entry(5, 'read-only-storage', HEADER_BYTES),            // transparent-args: n, uniform
        entry(6, 'storage', HIST_BYTES),                        // sort-hist
      ],
    });

    const gatherModule = device.createShaderModule({ label: 'transparent-gather', code: TransparentSortPass.GATHER_SOURCE });
    const sortModule = device.createShaderModule({ label: 'transparent-sort', code: TransparentSortPass.SORT_SOURCE });
    this.gatherPipeline = device.createComputePipeline({
      label: 'transparent-sort/gather',
      layout: device.createPipelineLayout({ bindGroupLayouts: [gatherLayout] }),
      compute: { module: gatherModule, entryPoint: 'gather_main' },
    });
    const sortPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [sortLayout] });
    const stage = (entryPoint: string): GPUComputePipeline => device.createComputePipeline({
      label: `transparent-sort/${entryPoint}`,
      layout: sortPipelineLayout,
      compute: { module: sortModule, entryPoint },
    });
    this.stagePipelines = { upsweep: stage('upsweep_main'), scan: stage('scan_main'), scatter: stage('scatter_main') };

    this.gatherBindGroup = device.createBindGroup({
      label: 'transparent-gather',
      layout: gatherLayout,
      entries: [
        { binding: 0, resource: { buffer: gatherParams } },
        { binding: 1, resource: { buffer: indirectArgs } },
        { binding: 2, resource: { buffer: visibleIndices } },
        { binding: 3, resource: { buffer: bounds } },
        { binding: 4, resource: { buffer: entityIds } },
        { binding: 5, resource: { buffer: keysA } },
        { binding: 6, resource: { buffer: valsA } },
        { binding: 7, resource: { buffer: args } },
      ],
    });
    // A = (sort-keys-a, sort-vals-a), B = (sort-keys-b, transparent-order).
    this.passBindGroups = Array.from({ length: PASSES }, (_, p) => {
      const even = p % 2 === 0;
      return device.createBindGroup({
        label: `transparent-sort-${p}`,
        layout: sortLayout,
        entries: [
          { binding: 0, resource: { buffer: passParams, offset: p * PASS_PARAMS_STRIDE, size: PARAMS_BYTES } },
          { binding: 1, resource: { buffer: even ? keysA : keysB } },
          { binding: 2, resource: { buffer: even ? valsA : order } },
          { binding: 3, resource: { buffer: even ? keysB : keysA } },
          { binding: 4, resource: { buffer: even ? order : valsA } },
          { binding: 5, resource: { buffer: args } },
          { binding: 6, resource: { buffer: hist } },
        ],
      });
    });
  }

  profileStages(frame: FrameState): readonly string[] {
    // Must match execute()'s mark calls one for one, or GpuProfiler drops the frame.
    return sortBound(frame) > 0 && this.ready ? PROFILE_STAGES : [];
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.gatherParams || !this.args || !this.hist) return;
    const bound = sortBound(frame);
    this.gatherData[0] = bound;
    this.gatherData[1] = frame.frameStamp;
    device.queue.writeBuffer(this.gatherParams, 0, this.gatherData);
    // What the frame draws if the gather does not run: nothing. The gather
    // overwrites words 0-11; the stamp sentinel lets a readback tell it did not.
    const h = this.headerData;
    h.fill(0);
    h[H_DRAW] = QUAD_INDEX_COUNT;
    h[H_DISPATCH + 1] = 1;
    h[H_DISPATCH + 2] = 1;
    h[H_LIMIT] = bound;
    h[H_STAMP] = STAMP_SENTINEL;
    device.queue.writeBuffer(this.args, 0, h);
    device.queue.writeBuffer(this.hist, 0, this.diagZeros);
  }

  execute(
    encoder: GPUCommandEncoder,
    frame: FrameState,
    _resources: ResourcePool,
    mark?: (encoder: GPUCommandEncoder) => void,
  ): void {
    const bound = sortBound(frame);
    if (bound === 0 || !this.ready) return;
    // Only in a frame the sort runs: a request left in the queue waits for one.
    const target = this.probe?.take(frame.frameStamp) ?? null;

    if (mark) {
      mark(encoder);
      const gather = encoder.beginComputePass({ label: 'transparent-sort/gather' });
      this.encodeGather(gather, bound);
      gather.end();
      if (target) this.copyGathered(encoder, target);
      for (let p = 0; p < PASSES; p++) {
        for (const stage of SORT_STAGES) {
          mark(encoder);
          const pass = encoder.beginComputePass({ label: `transparent-sort/${stage}` });
          this.encodeStage(pass, stage, p);
          pass.end();
        }
      }
    } else {
      let pass = encoder.beginComputePass({ label: 'transparent-sort' });
      this.encodeGather(pass, bound);
      if (target) {
        // Pass 1 overwrites sort-keys-a / sort-vals-a: copy the gather's output first.
        pass.end();
        this.copyGathered(encoder, target);
        pass = encoder.beginComputePass({ label: 'transparent-sort' });
      }
      for (let p = 0; p < PASSES; p++) {
        for (const stage of SORT_STAGES) this.encodeStage(pass, stage, p);
      }
      pass.end();
    }
    if (target) this.copyResults(encoder, target);
  }

  resize(_width: number, _height: number): void {
    // Fixed-size buffers: nothing follows the canvas.
  }

  destroy(): void {
    this.keysA?.destroy();
    this.keysB?.destroy();
    this.valsA?.destroy();
    this.hist?.destroy();
    this.gatherParams?.destroy();
    this.passParams?.destroy();
    this.keysA = null;
    this.keysB = null;
    this.valsA = null;
    this.hist = null;
    this.gatherParams = null;
    this.passParams = null;
    this.args = null;   // the renderer's pool buffer: not ours to destroy
    this.order = null;  // likewise
    this.gatherPipeline = null;
    this.stagePipelines = null;
    this.gatherBindGroup = null;
    this.passBindGroups = [];
  }

  private get ready(): boolean {
    return this.gatherPipeline !== null && this.stagePipelines !== null && this.gatherBindGroup !== null
      && this.passBindGroups.length === PASSES && this.args !== null;
  }

  private encodeGather(pass: GPUComputePassEncoder, bound: number): void {
    pass.setPipeline(this.gatherPipeline!);
    pass.setBindGroup(0, this.gatherBindGroup!);
    pass.dispatchWorkgroups(Math.ceil(bound / WORKGROUP_SIZE));
  }

  private encodeStage(pass: GPUComputePassEncoder, stage: SortStage, p: number): void {
    pass.setPipeline(this.stagePipelines![stage]);
    pass.setBindGroup(0, this.passBindGroups[p]);
    if (stage === 'scan') pass.dispatchWorkgroups(1);
    else pass.dispatchWorkgroupsIndirect(this.args!, DISPATCH_OFFSET_BYTES);
  }

  private copyGathered(encoder: GPUCommandEncoder, target: SortReadbackTarget): void {
    encoder.copyBufferToBuffer(this.keysA!, 0, target.gatherKeys, 0, SORT_READBACK_BYTES.gatherKeys);
    encoder.copyBufferToBuffer(this.valsA!, 0, target.gatherVals, 0, SORT_READBACK_BYTES.gatherVals);
  }

  private copyResults(encoder: GPUCommandEncoder, target: SortReadbackTarget): void {
    encoder.copyBufferToBuffer(this.args!, 0, target.header, 0, SORT_READBACK_BYTES.header);
    encoder.copyBufferToBuffer(this.hist!, 0, target.hist, 0, SORT_READBACK_BYTES.hist);
    encoder.copyBufferToBuffer(this.order!, 0, target.order, 0, SORT_READBACK_BYTES.order);
  }
}
