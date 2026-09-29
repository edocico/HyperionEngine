// ts/src/render/transparent-sort-probe.ts
//
// Dev-only readback behind `engine.debug.readTransparentSort()` (design
// 2026-09-27 §6.5). The requests live here, in an object the renderer owns, so
// they outlive graph swaps. The live TransparentSortPass takes the head of the
// queue in execute() and encodes its copies into the fresh staging buffers
// take() hands it; right after the graph's submit the renderer calls finish(),
// and only then is anything mapped — a buffer pending a map at submit time
// would invalidate the whole frame. One request per frame, FIFO: N requests
// issued together read N consecutive frames.

import {
  CAP, H_DRAW, H_RAW, H_LIMIT, H_OVERFLOW, H_STAMP, STAMP_SENTINEL,
  DIAG_WORDS, DIGIT_BASE_OFFSET, PASSES, RADIX,
} from './passes/transparent-sort-constants';
// The target and the staging sizes are the pass's (Task 15): one definition,
// so the bytes the pass copies and the bytes take() allocates cannot drift apart.
import { SORT_READBACK_BYTES, type SortReadbackTarget } from './passes/transparent-sort-pass';

export type { SortReadbackTarget };

/** The CPU side of a frame, as the renderer had it right after the graph's submit. */
export interface SortProbeSource {
  tickCount: number;
  /** `FrameState.frameStamp`: what the gather writes into header word 11. */
  stamp: number;
  entityCount: number;
  /** Normalised (`normalizeTransparentCount`): the bound the gather was sized with. */
  transparentCount: number;
  /** Normalised (`normalizeIdsGeneration`): NaN when the state carried none. */
  idsGeneration: number;
  /** The `entity-ids` column was uploaded in this frame. */
  idsUploaded: boolean;
  /** This frame uploaded through the scatter pass (Mode C, few dirty rows). */
  usedScatter: boolean;
  viewProjection: Float32Array;
  bounds: Float32Array;
  entityIds: Uint32Array;
  renderMeta: Uint32Array;
  texIndices: Uint32Array;
}

export interface TransparentSortReadback {
  /** Copied in finish(), before any await: every array holds `entityCount` rows. */
  frame: SortProbeSource;
  /** Elements sorted and drawn: header word 1, min(raw, limit). */
  n: number;
  /** The 12 transparent region counts summed (header word 8). */
  raw: number;
  /** The gather's bound, min(transparentCount, CAP) (header word 9). */
  limit: number;
  /** raw > limit: the CPU count was wrong (header word 10). */
  overflow: boolean;
  /** `sort-hist` diag: word 0 bit 0 = scan sum != n, bit 1 = scatter out of range. */
  diag: Uint32Array;
  /** The gather's output: element i has key (lo = external id, hi = zKey) and value = slot. */
  gathered: { lo: Uint32Array; hi: Uint32Array; vals: Uint32Array };
  /** Every pass's `digitBase`: PASSES rows of RADIX words. */
  digitBase: Uint32Array;
  /** `transparent-order`: the slots, back to front. */
  order: Uint32Array;
}

/** The five staging buffers of a target; `SORT_READBACK_BYTES` sizes each. */
type StagingKey = Exclude<keyof SortReadbackTarget, 'stamp'>;

/** Also the order finish() maps and decodes them in. */
const STAGING_KEYS: readonly StagingKey[] = ['gatherKeys', 'gatherVals', 'header', 'hist', 'order'];

interface Pending {
  resolve: (value: TransparentSortReadback) => void;
  reject: (err: Error) => void;
}

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));
const stagingOf = (target: SortReadbackTarget): GPUBuffer[] => STAGING_KEYS.map((key) => target[key]);

export class TransparentSortProbe {
  private queue: Pending[] = [];
  /** The request the live pass took in the current frame; finish() clears it. */
  private taken: { pending: Pending; target: SortReadbackTarget } | null = null;
  /** Requests whose buffers are being mapped, with those buffers. */
  private readonly mapping = new Map<Pending, GPUBuffer[]>();
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {}

  /** A request is waiting: the renderer then runs the frame inside GPU error scopes. */
  get hasPending(): boolean {
    return this.queue.length > 0;
  }

  /** Reads the sort of the next rendered frame (rejected if that frame's sort does not run). */
  request(): Promise<TransparentSortReadback> {
    if (this.destroyed) return Promise.reject(new Error('TransparentSortProbe destroyed'));
    return new Promise<TransparentSortReadback>((resolve, reject) => this.queue.push({ resolve, reject }));
  }

  /**
   * Called by the live pass in execute(), when it runs the sort: hands the head
   * request fresh staging buffers, owned by the request and not by the pass (a
   * pass destroyed by a graph swap cannot cut a map short). At most one per frame.
   */
  take(stamp: number): SortReadbackTarget | null {
    if (this.destroyed || this.taken || this.queue.length === 0) return null;
    const pending = this.queue.shift()!;
    const make = (key: StagingKey): GPUBuffer => this.device.createBuffer({
      size: SORT_READBACK_BYTES[key],
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      label: `transparent-sort-readback-${key}`,
    });
    const target: SortReadbackTarget = {
      stamp,
      gatherKeys: make('gatherKeys'),
      gatherVals: make('gatherVals'),
      header: make('header'),
      hist: make('hist'),
      order: make('order'),
    };
    this.taken = { pending, target };
    return target;
  }

  /**
   * Called by the renderer right after the graph's submit, every frame. A
   * taken request: snapshot `source` now, then map. Nothing taken while
   * requests wait (the sort did not run): the HEAD is rejected, the others
   * wait for the next frames.
   */
  finish(source: SortProbeSource | null, frameErrors: Promise<string[]> | null): void {
    const taken = this.taken;
    this.taken = null;
    if (!taken) {
      this.queue.shift()?.reject(new Error('no transparent entities this frame: the sort did not run, there is nothing to read'));
      return;
    }
    const { pending, target } = taken;
    const buffers = stagingOf(target);
    const free = (): void => { for (const b of buffers) b.destroy(); };
    if (!source || source.stamp !== target.stamp) {
      free();
      pending.reject(new Error(source
        ? `The frame snapshot has stamp ${source.stamp}, the sort was read at ${target.stamp}`
        : 'No frame snapshot came with the frame that took the readback'));
      return;
    }
    const frame = snapshot(source);
    this.mapping.set(pending, buffers);
    const settle = (fn: () => void): void => {
      this.mapping.delete(pending);
      free();
      fn();
    };
    Promise.all([
      frameErrors ?? Promise.resolve<string[]>([]),
      Promise.all(buffers.map((b) => b.mapAsync(GPUMapMode.READ))),
    ]).then(([errors]) => {
      const words = buffers.map((b) => new Uint32Array(b.getMappedRange().slice(0)));
      for (const b of buffers) b.unmap();
      if (errors.length > 0) {
        throw new Error(`The frame of the transparent-sort readback failed GPU validation: ${errors.join('; ')}`);
      }
      const readback = decode(frame, target.stamp, words);
      settle(() => pending.resolve(readback));
    }).catch((err: unknown) => settle(() => pending.reject(toError(err))));
  }

  /** host.graph.render() threw: the taken request and every queued one are rejected. */
  failFrame(err: Error): void {
    this.rejectAll(new Error(`The frame of the transparent-sort readback threw: ${err.message}`), false);
  }

  destroy(): void {
    this.destroyed = true;
    this.rejectAll(new Error('TransparentSortProbe destroyed before the request was served'), true);
  }

  private rejectAll(err: Error, mappingToo: boolean): void {
    if (this.taken) {
      for (const b of stagingOf(this.taken.target)) b.destroy();
      this.taken.pending.reject(err);
      this.taken = null;
    }
    const queued = this.queue;
    this.queue = [];
    for (const p of queued) p.reject(err);
    if (!mappingToo) return;
    for (const [p, buffers] of this.mapping) {
      for (const b of buffers) b.destroy();
      p.reject(err);
    }
    this.mapping.clear();
  }
}

function snapshot(s: SortProbeSource): SortProbeSource {
  const n = s.entityCount;
  return {
    tickCount: s.tickCount,
    stamp: s.stamp,
    entityCount: n,
    transparentCount: s.transparentCount,
    idsGeneration: s.idsGeneration,
    idsUploaded: s.idsUploaded,
    usedScatter: s.usedScatter,
    viewProjection: s.viewProjection.slice(0, 16),
    bounds: s.bounds.slice(0, n * 4),
    entityIds: s.entityIds.slice(0, n),
    renderMeta: s.renderMeta.slice(0, n * 2),
    texIndices: s.texIndices.slice(0, n),
  };
}

/** Rejects (throws) instead of answering zeros: header word 11 must be this frame's stamp. */
function decode(frame: SortProbeSource, stamp: number, [keys, vals, header, hist, order]: Uint32Array[]): TransparentSortReadback {
  const word = header[H_STAMP];
  if (word === 0) throw new Error('The transparent-sort readback copy never ran: header word 11 is 0, as in fresh staging');
  if (word === STAMP_SENTINEL) throw new Error('The transparent-sort gather never ran this frame: header word 11 is still the sentinel');
  if (word !== stamp) throw new Error(`The transparent-sort header carries stamp ${word}, not this frame's ${stamp}`);
  const n = header[H_DRAW + 1];
  if (n > CAP) throw new Error(`The transparent-sort header says n = ${n}, past the capacity ${CAP}`);
  return {
    frame,
    n,
    raw: header[H_RAW],
    limit: header[H_LIMIT],
    overflow: header[H_OVERFLOW] !== 0,
    diag: hist.slice(0, DIAG_WORDS),
    gathered: { lo: keys.slice(0, n), hi: keys.slice(CAP, CAP + n), vals: vals.slice(0, n) },
    digitBase: hist.slice(DIGIT_BASE_OFFSET, DIGIT_BASE_OFFSET + PASSES * RADIX),
    order: order.slice(0, n),
  };
}
