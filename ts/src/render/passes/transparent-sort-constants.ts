/**
 * Shared constants of the transparent sort (phase 5b, design §5): the shape of
 * the kernels and the word layout of their buffers. `TransparentSortPass`
 * sizes and binds with them, the CPU model (`transparent-sort-reference.ts`)
 * simulates with them, and the text-agreement tests pin the `const` literals
 * of `transparent-gather.wgsl` / `transparent-sort.wgsl` against them.
 */
import { MAX_GPU_ENTITIES } from '../../types';

// ── Kernel shape ─────────────────────────────────────────────────────────────

/** Threads per workgroup, in every kernel of the sort. */
export const WORKGROUP_SIZE = 256;
/** Elements per tile: one upsweep/scatter workgroup takes ROUNDS × WORKGROUP_SIZE. */
export const TILE = 1024;
/** Rounds per tile: a lane handles element `t·TILE + r·WORKGROUP_SIZE + lid` in round r. */
export const ROUNDS = 4;
/** Values of one digit (8-bit digits). */
export const RADIX = 256;
/**
 * LSD passes: 3 over `lo` (the 20-bit external id), 4 over `hi` (the z key).
 * Odd, so the last pass writes B, which is `transparent-order`.
 */
export const PASSES = 7;
/** The last pass writes the values only: nothing reads its keys. */
export const LAST_PASS = 6;
/** Passes 0..LO_PASSES-1 take their digit from `lo`, the others from `hi`. */
export const LO_PASSES = 3;
/** Scatter mask words per digit: one bit per lane. */
export const MASK_WORDS = WORKGROUP_SIZE / 32;
/** Tiles the scan's column loop loads per chunk. */
export const SCAN_CHUNK = 8;

// ── What the gather reads from the cull ──────────────────────────────────────

/** First transparent record of `indirect-args`: cull.wgsl puts the 14 opaque buckets first. */
export const FIRST_TRANSPARENT_ARG = 14;
/**
 * Transparent regions the gather reads: types 0-5 × 2 texture buckets, records
 * 14-25. Records 26/27 (a `.transparent()` Light2D) stay LightAccumStage's.
 */
export const GATHER_REGIONS = 12;
/** Words of one DrawIndexedIndirect record of `indirect-args`. */
export const ARG_WORDS = 5;
/** The record word holding the region's element count (instanceCount). */
export const ARG_INSTANCE_COUNT = 1;
/** The record word holding the region's first `visible-indices` word (firstInstance). */
export const ARG_FIRST_INSTANCE = 4;

// ── Buffers ──────────────────────────────────────────────────────────────────

/** Elements the sort holds: the GPU row capacity. Keys are SoA: lo at [0, CAP), hi at [CAP, 2·CAP). */
export const CAP = MAX_GPU_ENTITIES;
/** Tiles of a full sort (98 at CAP = 100 000). */
export const NUM_TILES = Math.ceil(CAP / TILE);

/** `transparent-args`, word by word (design §5.2). */
export const HEADER_WORDS = 16;
export const HEADER_BYTES = 64;
/** Words 0-4: DrawIndexedIndirect {6, n, 0, 0, 0} of the uber draw. */
export const H_DRAW = 0;
/** Words 5-7: DispatchIndirect {ceil(n / TILE), 1, 1} of the upsweep and the scatter. */
export const H_DISPATCH = 5;
/** Word 8: raw, the sum of the 12 region counts. */
export const H_RAW = 8;
/** Word 9: limit (= B). */
export const H_LIMIT = 9;
/** Word 10: 1 when raw > limit. */
export const H_OVERFLOW = 10;
/** Word 11: the frame's stamp, written by the gather only (prepare() writes STAMP_SENTINEL). */
export const H_STAMP = 11;
/** Byte offset of the DispatchIndirect args in `transparent-args`. */
export const DISPATCH_OFFSET_BYTES = 20;
/** What prepare() writes in word 11: a stamp is never this value. */
export const STAMP_SENTINEL = 0xFFFFFFFF;

/** `sort-hist`: diag (16 atomic words), then digitBase (one 256-word row per pass), then the tile table. */
export const DIAG_WORDS = 16;
export const DIGIT_BASE_OFFSET = 16;
export const TILES_OFFSET = DIGIT_BASE_OFFSET + PASSES * RADIX;
export const HIST_WORDS = TILES_OFFSET + NUM_TILES * RADIX;
/** diag[0] bit 0: a scan's total differs from n. */
export const DIAG_SCAN_MISMATCH = 1;
/** diag[0] bit 1: a scatter destination was >= n. */
export const DIAG_SCATTER_OOB = 2;

/** Bytes per `sort-pass-params` slice (the uniform offset alignment). */
export const PASS_PARAMS_STRIDE = 256;
