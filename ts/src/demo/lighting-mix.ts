// ts/src/demo/lighting-mix.ts — the Lighting tab's checks of the light list
// and the mix blend (round 2026-09-27, step 7)
//
// They run on a sub-scene of their own, centred on MIX_SCENE, out of reach of
// the tab's point, spot and layer-1 lights. The tab's global light, never
// culled, lights it too: it is part of `floor`, the light buffer where no
// light of the sub-scene reaches (ambient + global light). Four 2D point
// lights: M, a mix light on the left; R, an add light; P and Q, two mix
// lights that overlap over R, P marked `.transparent()`.
//
// - 'Mix light replaces the light buffer': at weight 1 (falloff 0) M brings
//   the layer to its target, its colour × energy, whatever is below it (the
//   ambient and the global light); at a weight w (falloff 1) to
//   floor·(1 − w) + target·w, LightAccumStage's premultiplied "over"; turned
//   global, still mix, it brings its whole layer to its target.
// - 'Mix order follows depth': where P and Q overlap the nearer one is on
//   top, over ORDER_READS reads, and the other one once their depths swap at
//   runtime (crossed, so that each change is needed, and read back in the rows
//   of that frame); R, nearer than both but an add light, is under both (add
//   and sub before mix), and P's `.transparent()` does not move P. A pass is
//   no evidence of stability: P and Q sit in adjacent slots, where the M2's
//   cull did not reorder lights (ORDER_READS).
// - 'Light list: exact cull, id at equal depth': M is drawn just inside the
//   limit of the cull's exact sphere test (the far plane + its range) and not
//   just outside it, where the grouping's margin would still keep it; at
//   equal depths the higher external id is on top, read in a frame where slot
//   order puts the other light on top.
//
// Every colour and target is exact in fp16 (the light buffer is
// rgba16float), and so is a mix light's result at weight 1, c·1 + dst·0: the
// weight-1 reads are held to one fp16 ULP, and M's target is above 1 so that
// a clamp shows. A partial weight is read at the centre of the light-buffer
// texel under its point, where the shader evaluated it, and compared with the
// floor read in the same frame, within PARTIAL_TOL.
// The sub-scene's five entities take fresh ids: the tabs after Lighting see
// ids 5 higher than before step 7.
import type { Hyperion } from '../hyperion';
import type { EntityHandle, LightOptions } from '../entity-handle';
import type { TestReporter } from './types';
import { composite, maxChannelDiff, straight, type Rgb } from './blend-expect';
import { halfResolution } from '../render/passes/occluder-seed-stage';
import { pixelCheck, fmt, fitView, frames, viewBounds, type Rgba } from './probe-checks';

/** A point in world units: from MIX_SCENE in the constants below. */
type Xy = readonly [number, number];

/**
 * The sub-scene's centre: below the tab's scene, whose lights reach down to
 * y ≈ −24 (its global light reaches everywhere, and is part of `floor`), and
 * far from the step-6 sun's sub-scene at (0, 200).
 */
export const MIX_SCENE: [number, number] = [0, -200];
/** The tab's own framing (zoom 1 at 16:9): every probe point, from x = −16 (FLOOR) to 9 (Q_ONLY), in view at any aspect. */
const SUB_HALF_WIDTH = 17.6;
/** M, a point mix light: its colour × energy is M_TARGET. */
const M_LIGHT = { color: [1, 0.5, 0.25] as Rgb, energy: 2, range: 3 };
/** M's colour × energy, where a mix light at weight 1 brings the light buffer: above 1, so that a clamp shows, and exact in fp16. */
export const M_TARGET: Rgb = [2, 1, 0.5];
/**
 * P's colour, a mix light at energy 1. P and Q differ by more than 0.1 in a
 * channel (0.75 in red and blue), over three times TOL: an overlap read near
 * one of them is never near the other.
 */
export const P_COLOR: Rgb = [1, 0.25, 0.25];
/** Q's colour, a mix light at energy 1. */
export const Q_COLOR: Rgb = [0.25, 0.25, 1];
/** R's colour, an add light at energy 1. */
export const R_COLOR: Rgb = [0, 0.5, 0];
/** M's centre, from MIX_SCENE: far from R, P and Q. */
const M_AT: Xy = [-10, 0];
/** R's centre, from MIX_SCENE: under P and Q. */
const R_AT: Xy = [6, 0];
/** P's centre, from MIX_SCENE. */
const P_AT: Xy = [4.5, 0];
/** Q's centre, from MIX_SCENE: 3 right of P, so the two overlap around OVERLAP. */
const Q_AT: Xy = [7.5, 0];
/** R's range: it reaches P_ONLY, OVERLAP, Q_ONLY and R_ONLY. */
const R_RANGE = 5;
/** P's and Q's range: OVERLAP lies 1.5 from each centre. */
const PQ_RANGE = 3;
/** R's depth: the nearest of R, P and Q (a root 2D light's world z is −depth), yet drawn under P and Q, as an add light. */
const R_DEPTH = 0.5;
/** P's depth before the swap: nearer than Q, so on top of it where they overlap. 'Light list' puts both lights at it. */
const P_DEPTH = 1;
/** Q's depth before the swap: the farthest. */
const Q_DEPTH = 4;
/**
 * P's depth after the swap, which puts Q nearer. P and Q cross over rather
 * than trade places, so that Q comes on top only when both SetDepth commands
 * reach the rows: P's change alone leaves P at 3 and Q at 4, Q's alone P at 1
 * and Q at 2, P nearer either way. Traded depths (1 and 2) put the two lights
 * at equal depths after one lost SetDepth, where Q, the higher id, is on top
 * as after a full swap.
 */
const P_DEPTH_AFTER = 3;
/** Q's depth after the swap: nearer than P's (P_DEPTH_AFTER), farther than R's. */
const Q_DEPTH_AFTER = 2;
/** How far P's and Q's row z after the swap may sit from −depth: correct code writes exact f32 integers. */
const SWAP_Z_EPS = 1e-6;
/**
 * The probe points, from MIX_SCENE. Each lies at least 1 unit from the edge
 * of every disc that contains it: M_IN in M only; P_ONLY in P and R; OVERLAP
 * in P, Q and R; Q_ONLY in Q and R; R_ONLY in R only; FLOOR and AWAY in none.
 */
export const POINTS: { mIn: Xy; floor: Xy; away: Xy; pOnly: Xy; overlap: Xy; qOnly: Xy; rOnly: Xy } = {
  mIn: [-10, 1],
  floor: [-16, 0],
  away: [-4, 6],
  pOnly: [3, 0],
  overlap: [6, 0],
  qOnly: [9, 0],
  rOnly: [6, 4],
};
/** The partial-weight points, world units right of M: weights about 0.75 and 0.5 at falloff 1. */
const PARTIAL_OFFSETS = [0.75, 1.5];
/** M's weights at PARTIAL_OFFSETS, falloff 1: 1 − offset/range, 0.75 and 0.5. */
const PARTIAL_WEIGHTS = PARTIAL_OFFSETS.map((dx) => 1 - dx / M_LIGHT.range);
/**
 * The coarsest light buffer WEIGHT_TOL is derived for, in texels per world
 * unit: the density the tab's 'Directional shadow length' check is validated
 * from (VALIDATED_TEXELS_PER_UNIT in lighting-directional.ts), which this
 * framing (SUB_HALF_WIDTH, the same) reaches on a canvas at least 320 px tall
 * at zoom 1, or about 564 px wide where fitView zooms out.
 */
const MIN_TEXELS_PER_UNIT = 8;
/**
 * How far a partial point's weight may sit from PARTIAL_WEIGHTS: the point is
 * read at the centre of its light-buffer texel, at most half a texel away on
 * each axis, √2/2 of a texel in all, and a weight 1 − d/range moves by at
 * most that over the range. At MIN_TEXELS_PER_UNIT that is √2/16 world units,
 * 0.029 of weight (the M2's 1960×1248 canvas, 28 texels per unit, moved them
 * by 0.002 at most). A missing or zero-sized canvas snaps both points to the
 * view centre, beyond M's range: w = 0, where the reference is FLOOR itself.
 * Below MIN_TEXELS_PER_UNIT the snapping alone can move a weight further: a
 * refusal there may mean the canvas. The detail prints the run's texels per
 * unit (lightTexelsPerUnit), and marks a run below MIN_TEXELS_PER_UNIT.
 */
const WEIGHT_TOL = Math.SQRT1_2 / (MIN_TEXELS_PER_UNIT * M_LIGHT.range);
/**
 * The order check's reads before the depth swap: the overlap must hold over
 * all of them. They are no evidence of stability: P and Q sit in adjacent
 * slots (15 and 16 on the M2), and with lights 1 slot apart master's cull, on
 * the M2's subgroup path, drew one light buffer over 240 reads
 * (docs/plans/assets/2026-10-08-step7/master-B.order.stats.json), so 'changes
 * from read to read' cannot fire here. A regression to the cull's order shows
 * in the depth swap instead: Q on top in both phases in slot order, P in both
 * through the cull's buckets (P's `.transparent()` bucket comes after Q's).
 * Stability is shown by the committed bench's `order` task, with the lights
 * 256 or more slots apart (the plan's exit criterion, Task 9).
 */
export const ORDER_READS = 10;
/** Per-channel tolerance on a light-buffer value that sums lights, and for naming what a wrong read looks like. */
const TOL = 0.03;
/**
 * Per-channel tolerance at a partial weight, against floor·(1 − w) + target·w
 * from the floor read in the same frame: 2 fp16 ULP at the target's red (2),
 * 4 in [1, 2), where the partial reads' red lies.
 */
const PARTIAL_TOL = 0.004;
/**
 * How far M's depth goes past its listed limit, either way: well above the
 * f32 rounding of the limit near depth 1000 (about 1e-4), and inside the
 * grouping's margin (range × 1.01 + 0.001, 0.031 at range 3), so that a list
 * that took the margin would still draw M just outside the limit.
 */
const FAR_EPS = 0.015;
/**
 * How far M's row z may sit from −depth before 'Light list' blames M's depth
 * rather than the list: its depths near 1003 are no f32 integers, and f32
 * values there lie 6.1e-5 apart.
 */
const M_ROW_Z_TOL = 1e-3;
/** The points of the global read, in order. */
const GLOBAL_POINTS = ['FLOOR', 'M_IN', 'AWAY'];

/** A check's verdict: the values read, then each cause found, separated by `; `. */
interface Verdict {
  ok: boolean;
  detail: string;
}

const rgb = (c: readonly number[]): string => fmt([c[0], c[1], c[2]]);
const rgbOf = (c: readonly number[]): Rgb => [c[0], c[1], c[2]];
const plus = (a: readonly number[], b: readonly number[]): Rgb => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const minus = (a: readonly number[], b: readonly number[]): Rgb => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const times = (a: readonly number[], k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k];
const close = (a: readonly number[], b: readonly number[], tol = TOL): boolean => maxChannelDiff(a, b) <= tol;
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** One fp16 ULP at `v`: 2^(⌊log2|v|⌋ − 10), and 2^−24 below the normal range (2^−14). */
export function fp16Ulp(v: number): number {
  const a = Math.abs(v);
  return a < 2 ** -14 ? 2 ** -24 : 2 ** (Math.floor(Math.log2(a)) - 10);
}

/** How many fp16 ULP of `want` the farthest of the first three channels is off. */
function ulpsOff(got: readonly number[], want: readonly number[]): number {
  return Math.max(...[0, 1, 2].map((c) => Math.abs(got[c] - want[c]) / fp16Ulp(want[c])));
}

/** Each of the first three channels within one fp16 ULP of `want`'s. */
function withinUlp(got: readonly number[], want: readonly number[]): boolean {
  return [0, 1, 2].every((c) => Math.abs(got[c] - want[c]) <= fp16Ulp(want[c]));
}

/**
 * A point light's weight at `at`, as light-accum.wgsl computes it: 0 from
 * `range` on, (1 − d/range)^falloff inside (falloff 0 is 1 inside).
 */
export function pointWeight(at: readonly [number, number], centre: readonly [number, number], range: number, falloff: number): number {
  const d = Math.hypot(at[0] - centre[0], at[1] - centre[1]);
  return d >= range ? 0 : (1 - d / range) ** Math.max(falloff, 0);
}

/**
 * The centre of the light-buffer texel under `world`, in world units: the
 * texel the probe reads, floor(uv · size), where the shader evaluated the
 * light. `vp` is an orthographic, unrotated view-projection (as viewBounds
 * reads it), `size` the light buffer's (halfResolution of the canvas).
 */
export function lightTexelCentre(world: readonly [number, number], vp: Float32Array, size: readonly [number, number]): [number, number] {
  const u = (vp[0] * world[0] + vp[12]) / 2 + 0.5;
  const v = 0.5 - (vp[5] * world[1] + vp[13]) / 2;
  const uc = (Math.floor(u * size[0]) + 0.5) / size[0];
  const vc = (Math.floor(v * size[1]) + 0.5) / size[1];
  return [(2 * uc - 1 - vp[12]) / vp[0], (1 - 2 * vc - vp[13]) / vp[5]];
}

/**
 * The light buffer's texels per world unit on its coarser axis: `size`
 * (halfResolution of the canvas) over the world rectangle `vp` shows
 * (viewBounds). WEIGHT_TOL holds from MIN_TEXELS_PER_UNIT up.
 */
export function lightTexelsPerUnit(vp: Float32Array, size: readonly [number, number]): number {
  const [xMin, xMax, yMin, yMax] = viewBounds(vp);
  return Math.min(size[0] / (xMax - xMin), size[1] / (yMax - yMin));
}

/** 'P' or 'Q' for a read within TOL of that light's colour, its values otherwise. */
function overlapLabel(value: Rgba): string {
  if (close(value, P_COLOR)) return 'P';
  if (close(value, Q_COLOR)) return 'Q';
  return rgb(value);
}

/** What 'Mix light replaces the light buffer' read. */
export interface MixReads {
  /** M_IN with M a point mix light of falloff 0 (weight 1). */
  full: Rgba;
  /** FLOOR, in the same read: the ambient plus the tab's global light. */
  floor: Rgba;
  /** With falloff 1: each point at its texel centre and M's weight there, and FLOOR in the same read. */
  partial: Array<{ read: Rgba; w: number }>;
  partialFloor: Rgba;
  /** M turned global, still mix: FLOOR, M_IN and AWAY, where no other light of the sub-scene reaches. */
  global: Rgba[];
  /** The light buffer's texels per world unit in this run (lightTexelsPerUnit). */
  texelsPerUnit: number;
}

/** Why M_IN, M at weight 1, is not M's target: recognised in this order. */
function fullCause(full: Rgba, base: Rgb, target: Rgb): string {
  if (close(full, plus(base, target))) return 'the mix light is added like add: M_IN is floor + target';
  if (close(full, base)) return 'the mix light is not drawn: M_IN is the floor';
  if (close(full, target.map((c) => Math.min(c, 1)))) return 'the target is clamped at 1';
  return "M_IN is not M's target";
}

/** Why a read at weight w is not floor·(1 − w) + target·w: recognised in this order, within PARTIAL_TOL. */
function partialCause(read: Rgba, base: Rgb, target: Rgb, w: number): string {
  const like = (v: readonly number[]): boolean => close(read, v, PARTIAL_TOL);
  if (like(target)) return 'the weight is ignored: read as the target';
  if (like(plus(base, times(target, w)))) return 'the mix light is added like add: floor + target·w';
  if (like(plus(target, times(base, 1 - w)))) return 'the colour is not premultiplied: target + floor·(1 − w)';
  return 'not floor·(1 − w) + target·w';
}

/**
 * 'Mix light replaces the light buffer': FLOOR within TOL of the tab's
 * `floor`; M_IN within one fp16 ULP of `target` at weight 1; the partial
 * points at weights within WEIGHT_TOL of PARTIAL_WEIGHTS, and each partial
 * read within PARTIAL_TOL of floor·(1 − w) + target·w, the floor read in the
 * same frame, itself within one fp16 ULP of the first FLOOR read: one texel
 * of a still scene, where no light of the sub-scene reaches and the tab's
 * lights stand still until its checks end; and the three global reads within
 * one fp16 ULP of `target`.
 *
 * `reads.texelsPerUnit` only adds a part to the detail: the value, and below
 * MIN_TEXELS_PER_UNIT a mark that the run is outside the domain WEIGHT_TOL is
 * derived for, where the snapping alone can refuse correct code. The verdict
 * never reads it.
 */
export function mixReplacesVerdict(reads: MixReads, floor: Rgb, target: Rgb): Verdict {
  const problems: string[] = [];
  if (!close(reads.floor, floor)) problems.push(`FLOOR is not the tab's floor, ${rgb(floor)}`);
  if (!withinUlp(reads.full, target)) problems.push(fullCause(reads.full, rgbOf(reads.floor), target));
  const ws = reads.partial.map(({ w }) => w);
  if (!(ws.length === PARTIAL_WEIGHTS.length && ws.every((w, i) => Math.abs(w - PARTIAL_WEIGHTS[i]) <= WEIGHT_TOL))) {
    problems.push(`the partial points sit at w ${ws.map((w) => w.toFixed(3)).join(' and ')}, `
      + `not ${PARTIAL_WEIGHTS.map((w) => w.toFixed(3)).join(' and ')} (the texel snapping moves a weight by at most `
      + `${WEIGHT_TOL.toFixed(3)} from ${MIN_TEXELS_PER_UNIT} texels per unit up; this light buffer has ${fmt([reads.texelsPerUnit])})`);
  }
  const base = rgbOf(reads.partialFloor);
  if (!withinUlp(base, reads.floor)) {
    problems.push(`the FLOOR read with the partial weights, ${rgb(base)}, is not the FLOOR read first, ${rgb(reads.floor)}: `
      + `${ulpsOff(base, reads.floor).toFixed(1)} fp16 ULP apart, where one texel of a still scene reads the same`);
  }
  const partial = reads.partial.map(({ read, w }) => ({ read, w, off: maxChannelDiff(read, composite(base, [straight(target, w)])) }));
  for (const { read, w, off } of partial) {
    if (!(off <= PARTIAL_TOL)) problems.push(`w ${fmt([w])}: ${partialCause(read, base, target, w)}`);
  }
  const missed = reads.global.flatMap((g, i) => (withinUlp(g, target) ? [] : [GLOBAL_POINTS[i] ?? `#${i}`]));
  if (missed.length > 0) problems.push(`the global mix light does not bring its whole layer to its target (${missed.join(', ')})`);
  // One part, without a ';' of its own: the tests strip it to compare the rest.
  const density = `light buffer ${fmt([reads.texelsPerUnit])} texels per world unit`
    + (reads.texelsPerUnit < MIN_TEXELS_PER_UNIT
      ? `, below the partial weights' validated domain (${MIN_TEXELS_PER_UNIT} and up), `
        + `where the texel snapping alone can move a weight by more than ${WEIGHT_TOL.toFixed(3)} and fail correct code`
      : '');
  const detail = `M ${rgb(reads.full)}, ${ulpsOff(reads.full, target).toFixed(1)} fp16 ULP from ${rgb(target)}; `
    + `FLOOR ${rgb(reads.floor)}; `
    + `${partial.map(({ read, w }) => `w = ${fmt([w])}: ${rgb(read)}`).join(' / ')}, `
    + `at most ${Math.max(0, ...partial.map(({ off }) => off)).toFixed(4)} from floor·(1 − w) + target·w `
    + `against FLOOR ${rgb(base)} read in the same frame; ${density}; `
    + `global ${reads.global.map((g, i) => `${GLOBAL_POINTS[i] ?? `#${i}`} ${rgb(g)}`).join(' / ')}`;
  return { ok: problems.length === 0, detail: problems.length > 0 ? `${detail}; ${problems.join('; ')}` : detail };
}

/** One read of the order check. */
export interface OrderRead {
  pOnly: Rgba;
  overlap: Rgba;
  qOnly: Rgba;
  rOnly: Rgba;
  floor: Rgba;
}

/** The read after the depth swap, with P's and Q's row z in its frame (readEntityTransforms; NaN for a light with no row). */
export interface SwapRead extends OrderRead {
  rowZ: { p: number; q: number };
}

/** A cause of 'Mix order follows depth', and the values it judged. */
interface Cause {
  cause: string;
  values: string;
}

/**
 * Why P_ONLY or Q_ONLY, where only its own mix light and the add lights reach
 * (R, and the tab's global light, floor − ambient), is not that light's colour:
 * the add lights drawn after it (light + R + floor − ambient) or the mix light
 * added like add (floor + R + light), whichever formula is nearer the read,
 * and only within TOL. The two differ by the ambient alone (the tab's is 0.12
 * at most, 4 × TOL): with an ambient within TOL in every channel both can be
 * within it. On a tie (no ambient: one formula) the class order is named.
 */
function onlyCause(point: 'P_ONLY' | 'Q_ONLY', value: Rgba, name: 'P' | 'Q', light: Rgb, floor: Rgb, ambient: Rgb): Cause {
  // Every add light drawn after the mix light: R and the global light both land on it.
  const late = maxChannelDiff(value, plus(light, plus(R_COLOR, minus(floor, ambient))));
  const added = maxChannelDiff(value, plus(plus(floor, R_COLOR), light));
  if (Math.min(late, added) <= TOL) {
    return late <= added
      ? {
          cause: 'R is drawn after the mix lights: add and sub come first',
          values: `${point} − ${name} = ${rgb(minus(value, light))} = R + floor − ambient, R and the global light`,
        }
      : { cause: 'the mix lights are added like add', values: `${point} ${rgb(value)} = floor + R + ${name}` };
  }
  return {
    cause: `${point} is not its own light`,
    values: `${rgb(value)} against ${name} ${rgb(light)}, ${ulpsOff(value, light).toFixed(1)} fp16 ULP off`,
  };
}

/** The values of one read of the order check, all but its overlap. */
function orderValues(read: OrderRead): string {
  return `P_ONLY ${rgb(read.pOnly)}; Q_ONLY ${rgb(read.qOnly)}; R_ONLY ${rgb(read.rOnly)}; FLOOR ${rgb(read.floor)}`;
}

/** The z of `slot`'s row in rows read back (readEntityTransforms: column 3 of its matrix); NaN for no slot. */
const rowZAt = (cpuRows: Float32Array, slot: number): number => (slot < 0 ? NaN : cpuRows[slot * 16 + 14] ?? NaN);

/** A row's z for a detail: 'none' for a light with no row. */
const rowZText = (z: number): string => (Number.isNaN(z) ? 'none' : z.toFixed(3));

/**
 * 'Mix order follows depth'. In every read P_ONLY and Q_ONLY within one fp16
 * ULP of their light (a mix light at weight 1 covers R and the floor),
 * R_ONLY within TOL of floor + R and FLOOR of `floor`; and the overlap P in
 * every read before the swap, while P is nearer, and Q after it. The overlap
 * is read as 'P' or 'Q' within TOL (P_COLOR and Q_COLOR are far enough apart
 * for that), otherwise as its values, and a wrong overlap names the rule it
 * follows instead. P's and Q's row z after the swap, read in the same frame,
 * must hold the depths it set (z = −depth, within SWAP_Z_EPS): otherwise the
 * read is refused whatever its overlap, which was drawn at other depths than
 * the ones it is judged against; a light with no row (NaN) is only printed. A
 * cause found in several reads is named once, at the first, with the values
 * it judged there and how many reads show it. `ambient` is the light buffer's
 * clear: floor − ambient is what the tab's global light adds, which a broken
 * class order draws after the mix lights too.
 */
export function mixOrderVerdict(before: readonly OrderRead[], after: SwapRead, floor: Rgb, ambient: Rgb): Verdict {
  const found = new Map<string, { where: string; values: string; reads: number }>();
  const all = [...before.map((read, i) => ({ read, where: `before ${i}` })), { read: after, where: 'after' }];
  for (const { read, where } of all) {
    // Once per read, with the first values: P_ONLY and Q_ONLY often show the same cause.
    const causes = new Map<string, string>();
    const add = ({ cause, values }: Cause): void => {
      if (!causes.has(cause)) causes.set(cause, values);
    };
    if (!withinUlp(read.pOnly, P_COLOR)) add(onlyCause('P_ONLY', read.pOnly, 'P', P_COLOR, floor, ambient));
    if (!withinUlp(read.qOnly, Q_COLOR)) add(onlyCause('Q_ONLY', read.qOnly, 'Q', Q_COLOR, floor, ambient));
    if (!close(read.rOnly, plus(floor, R_COLOR))) {
      add({ cause: 'R_ONLY is not floor + R', values: `${rgb(read.rOnly)} against ${rgb(plus(floor, R_COLOR))}` });
    }
    if (!close(read.floor, floor)) add({ cause: "FLOOR is not the tab's floor", values: `${rgb(read.floor)} against ${rgb(floor)}` });
    for (const [cause, values] of causes) {
      const seen = found.get(cause);
      if (seen) seen.reads++;
      else found.set(cause, { where, values, reads: 1 });
    }
  }
  const labels = before.map((read) => overlapLabel(read.overlap));
  const steady = labels.every((label) => label === labels[0]);
  const first = steady ? labels[0] : labels.join(' / ');
  const last = overlapLabel(after.overlap);
  const isPq = (label: string): boolean => label === 'P' || label === 'Q';
  // One phase of the overlap: the colour read, and what it is against what it should be.
  const phase = (label: string, value: Rgba, want: 'P' | 'Q'): string =>
    `${rgb(value)} (${label === want ? want : `${isPq(label) ? label : 'neither'}, want ${want}`})`;
  // The rows after the swap, against the z its depths give.
  const rowsAfter = `row z P ${rowZText(after.rowZ.p)}, Q ${rowZText(after.rowZ.q)} after it`;
  const wantZ = { p: -P_DEPTH_AFTER, q: -Q_DEPTH_AFTER };
  const wantAfter = `want ${wantZ.p.toFixed(3)}, ${wantZ.q.toFixed(3)}`;
  const unswapped = (['p', 'q'] as const).some((k) => Number.isFinite(after.rowZ[k]) && Math.abs(after.rowZ[k] - wantZ[k]) > SWAP_Z_EPS);
  let rule: string | null = null;
  if (!steady) rule = 'the overlap changes from read to read: the order does not come from the ECS state alone';
  else if (first === 'Q' && last === 'P') rule = 'the order is reversed: the nearer mix light is drawn first';
  else if (first === 'Q' && last === 'Q') rule = 'the overlap follows the ids or the slots, not the depths: Q has the higher id and the later slot';
  else if (first === 'P' && last === 'P') {
    rule = 'P stays on top whatever the depths: its .transparent() moves it after Q, the light list is stale '
      + `(its buffer rewritten only when the light count changes), or the swap never reached the rows (${rowsAfter}; ${wantAfter})`;
  } else if (!(first === 'P' && last === 'Q')) {
    rule = `the overlap is neither P nor Q in a phase: with P nearer ${before.length > 0 ? phase(first, before[0].overlap, 'P') : 'no read'}, `
      + `after the swap ${phase(last, after.overlap, 'Q')}`;
  }
  const problems = [
    ...(rule === null ? [] : [rule]),
    ...(unswapped ? [`the depth swap did not reach the rows: ${rowsAfter}, ${wantAfter}`] : []),
    ...[...found].map(([cause, { where, values, reads }]) => `${where}${reads > 1 ? ` (${reads} of ${all.length} reads)` : ''}: ${cause} (${values})`),
  ];
  const detail = `overlap ${first} over ${before.length} reads with P nearer, ${last} after the swap; `
    + (before.length > 0 ? `before it (read 0) ${orderValues(before[0])}; ` : '')
    + `after it ${orderValues(after)}; row z P ${rowZText(after.rowZ.p)}, Q ${rowZText(after.rowZ.q)}`;
  return { ok: problems.length === 0, detail: problems.length > 0 ? `${detail}; ${problems.join('; ')}` : detail };
}

/** What 'Light list: exact cull, id at equal depth' read. */
export interface ListReads {
  /** M_IN with M just inside its listed limit, then just outside it. */
  inside: Rgba;
  outside: Rgba;
  /** M's listed limit, the far plane's depth + its range, and the two depths M was read at, limit ∓ FAR_EPS. */
  limit: number;
  depths: { inside: number; outside: number };
  /**
   * At each of those reads, M's row z, read back in the same frame (NaN: no
   * row), and whether M's id was in the light list
   * (`engine.lighting.groups.lightIds`) right after the probe resolved.
   */
  mRowZ: { inside: number; outside: number };
  mListed: { inside: boolean; outside: boolean };
  /** OVERLAP with P and Q at equal depths after M's despawn, and their slots, ids and row z (NaN: no row) in that frame. */
  overlap: Rgba;
  slots: { p: number; q: number };
  ids: { p: number; q: number };
  rowZ: { p: number; q: number };
  /** The rows read back in that frame: how many ids their column holds, and how many rows there are. */
  rows: { ids: number; count: number };
}

/**
 * 'Light list: exact cull, id at equal depth': M_IN within one fp16 ULP of
 * `target` with M just inside its listed limit (otherwise: not drawn, near
 * `floor`, or drawn off its target), and within TOL of `floor` just outside
 * it. M drawn just outside is blamed on its depth when M's row z there, read
 * in the same frame, is not −depth (beyond M_ROW_Z_TOL: a lost SetDepth, a
 * clamped depth); otherwise on the list's test when M was listed though
 * outside (the grouping's margin), on LightAccumStage when M was drawn though
 * unlisted. M's row z and listing at both reads are printed. The overlap at
 * equal depths counts only with both lights in the rows read back, at the
 * same row z there (read in the same frame: a SetDepth that never reached its
 * row leaves the nearer light on top, which may be the higher id), and where
 * slot order and the ids disagree, (id Q > id P) !== (slot Q > slot P); it
 * must then be the light with the higher id. The lower id on top follows the
 * slots or the ids reversed: it has the later slot, so a slot tie-break and a
 * reversed id tie-break give the same read. When it is P, P's
 * `.transparent()` may put it there too (a transparent-last order), which
 * 'Mix order follows depth' tells apart (P on top in both its phases).
 */
export function listVerdict(reads: ListReads, floor: Rgb, target: Rgb): Verdict {
  const { inside, outside, limit, depths, mRowZ, mListed, overlap, slots, ids, rowZ, rows } = reads;
  const problems: string[] = [];
  if (!withinUlp(inside, target)) {
    problems.push(close(inside, floor)
      ? 'M is not drawn just inside its listed limit, the far plane + its range'
      : `M is drawn just inside its listed limit, but not at its target: ${ulpsOff(inside, target).toFixed(1)} fp16 ULP off`);
  }
  if (!close(outside, floor)) {
    if (Number.isFinite(mRowZ.outside) && Math.abs(mRowZ.outside + depths.outside) > M_ROW_Z_TOL) {
      problems.push(`M's depth did not reach its row (row z ${rowZText(mRowZ.outside)}, set depth ${depths.outside.toFixed(3)})`);
    } else if (mListed.outside) {
      problems.push("M is still drawn just outside its listed limit, listed though outside: the list keeps the grouping's margin, not the cull's exact test");
    } else {
      problems.push('M is still drawn just outside its listed limit, drawn though unlisted: LightAccumStage draws beyond the list');
    }
  }
  const seen = overlapLabel(overlap);
  const [higher, lower] = ids.q > ids.p ? ['Q', 'P'] : ['P', 'Q'];
  if (slots.p < 0 || slots.q < 0) {
    problems.push(`P or Q has no slot in the rows read back${rows.ids < rows.count ? `: their ids column is short, ${rows.ids} ids for ${rows.count} rows` : ''}`);
  } else if (!(rowZ.p === rowZ.q)) {
    // A SetDepth that never reached its row: the nearer light is on top, whatever the tie-break.
    problems.push(`P and Q are not at equal depths in the rows (row z P ${rowZText(rowZ.p)}, Q ${rowZText(rowZ.q)})`);
  } else if ((ids.q > ids.p) === (slots.q > slots.p)) problems.push('the slots agree with the ids: the read cannot tell the id rule from slot order');
  else if (seen === lower) {
    // The lower id has the later slot here: slot order and a reversed id tie-break both draw it last. P is
    // `.transparent()`: an order that draws such a light after the others of its class puts P on top too.
    problems.push(`at equal depths ${lower}, the lower id, is on top: the order follows the slots or the ids reversed `
      + '(one read cannot tell those two apart)'
      + (lower === 'P' ? ", or P's .transparent() moves it after Q (check 'Mix order follows depth' tells that one apart)" : ''));
  } else if (seen !== higher) problems.push('at equal depths the overlap is neither P nor Q');
  // M's row and its place in the light list at one read.
  const mAt = (read: 'inside' | 'outside'): string => `row z ${rowZText(mRowZ[read])}, ${mListed[read] ? 'listed' : 'unlisted'}`;
  const detail = `M ${rgb(inside)} just inside its listed limit, at depth ${depths.inside.toFixed(3)} (${mAt('inside')}), `
    + `and ${rgb(outside)} just outside, at depth ${depths.outside.toFixed(3)} (${mAt('outside')}) `
    + `(limit ${limit.toFixed(3)}, the far plane + its range; FAR_EPS ${FAR_EPS}); `
    + `overlap ${seen} at equal depths (row z P ${rowZText(rowZ.p)}, Q ${rowZText(rowZ.q)}); `
    + `ids P ${ids.p}, Q ${ids.q}; slots P ${slots.p}, Q ${slots.q}; ${rows.ids} ids for ${rows.count} rows`;
  return { ok: problems.length === 0, detail: problems.length > 0 ? `${detail}; ${problems.join('; ')}` : detail };
}

/** The latest frame's light groups and SDF sets, for a check's detail: reported, never gated. */
function groupCounts(engine: Hyperion): string {
  const groups = engine.lighting.groups;
  return `${plural(groups?.groups.length ?? 0, 'group')}, ${plural(groups?.sdfSets.length ?? 0, 'SDF set')}`;
}

/**
 * The three checks of the light list and the mix blend, on their sub-scene:
 * the camera moves there, and `restoreView` brings it back at the end. Every
 * handle also goes into `entities`, the tab's list, and is destroyed here
 * whatever happens. `floor` is the light buffer where no light of the
 * sub-scene reaches: the ambient plus the tab's global light.
 *
 * Each check is a `pixelCheck`, skipped where the probe does not exist (Mode
 * A, production). In Mode A each check stops at its first probe (the third
 * moves M's depth before it): M never turns global, and the sub-scene, out of
 * the render worker's view, is only built and destroyed.
 */
export async function checkMix(
  engine: Hyperion,
  reporter: TestReporter,
  entities: EntityHandle[],
  floor: Rgb,
  restoreView: () => void,
): Promise<void> {
  const [cx, cy] = MIX_SCENE;
  const at = ([x, y]: Xy): [number, number] => [cx + x, cy + y];
  const scene: EntityHandle[] = [];
  const keep = (h: EntityHandle): EntityHandle => {
    scene.push(h);
    entities.push(h);
    return h;
  };
  const mPoint = (falloff: number): LightOptions => ({ type: 'point', blend: 'mix', ...M_LIGHT, falloff });
  const pqLight = (color: Rgb): LightOptions => ({ type: 'point', blend: 'mix', color, energy: 1, range: PQ_RANGE, falloff: 0 });
  // The light group of layer 0, the floor's (4 bits per layer), read right
  // before each probe.
  const floorGroup = (): number => (engine.lighting.groups?.layerToGroup[0] ?? 0) & 0xf;
  try {
    fitView(engine, cx, cy, SUB_HALF_WIDTH);
    let m!: EntityHandle;
    let p!: EntityHandle;
    let q!: EntityHandle;
    engine.batch(() => {
      // A receiver in view: without one there is no light group.
      keep(engine.spawn().position(cx, cy, -0.5).scale(200, 100, 1).receivesLight(true));
      m = keep(engine.spawn({ mode: '2d' }).position(...at(M_AT)).light(mPoint(0)));
      keep(engine.spawn({ mode: '2d' }).position(...at(R_AT)).depth(R_DEPTH)
        .light({ type: 'point', blend: 'add', color: R_COLOR, energy: 1, range: R_RANGE, falloff: 0 }));
      p = keep(engine.spawn({ mode: '2d' }).position(...at(P_AT)).depth(P_DEPTH).transparent().light(pqLight(P_COLOR)));
      q = keep(engine.spawn({ mode: '2d' }).position(...at(Q_AT)).depth(Q_DEPTH).light(pqLight(Q_COLOR)));
    });
    await frames(4);

    // ── 1. A mix light replaces the light buffer by its weight ──────────
    await pixelCheck(reporter, 'Mix light replaces the light buffer', engine, async (probe) => {
      const [full, floorRead] = await probe('light-buffer', [at(POINTS.mIn), at(POINTS.floor)], floorGroup());
      try {
        // Weight w: falloff 1, each point read at the centre of its texel.
        m.light(mPoint(1));
        await frames(4);
        const mAt = at(M_AT);
        const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
        const size = halfResolution(canvas?.width ?? 0, canvas?.height ?? 0);
        const vp = engine.cam.viewProjection;
        const points = PARTIAL_OFFSETS.map((dx) => lightTexelCentre([mAt[0] + dx, mAt[1]], vp, size));
        const partialRead = await probe('light-buffer', [...points, at(POINTS.floor)], floorGroup());
        // Global, still mix: the whole layer.
        m.light({ type: 'global', blend: 'mix', color: M_LIGHT.color, energy: M_LIGHT.energy });
        await frames(4);
        const global = await probe('light-buffer', [at(POINTS.floor), at(POINTS.mIn), at(POINTS.away)], floorGroup());
        const counts = groupCounts(engine);
        const verdict = mixReplacesVerdict({
          full,
          floor: floorRead,
          partial: points.map((point, i) => ({ read: partialRead[i], w: pointWeight(point, mAt, M_LIGHT.range, 1) })),
          partialFloor: partialRead[points.length],
          global,
          texelsPerUnit: lightTexelsPerUnit(vp, size),
        }, floor, M_TARGET);
        return { ok: verdict.ok, detail: `${verdict.detail}; ${counts}` };
      } finally {
        // M back at weight 1 whatever happened: the next two checks read it there.
        m.light(mPoint(0));
        await frames(4);
      }
    });

    // ── 2. The nearer mix light is on top, and follows a depth swap ─────
    await pixelCheck(reporter, 'Mix order follows depth', engine, async (probe, readTransforms) => {
      const points = [POINTS.pOnly, POINTS.overlap, POINTS.qOnly, POINTS.rOnly, POINTS.floor].map(at);
      const read = async (): Promise<OrderRead> => {
        const [pOnly, overlap, qOnly, rOnly, floorRead] = await probe('light-buffer', points, floorGroup());
        return { pOnly, overlap, qOnly, rOnly, floor: floorRead };
      };
      const before: OrderRead[] = [];
      for (let i = 0; i < ORDER_READS; i++) before.push(await read());
      p.depth(P_DEPTH_AFTER);
      q.depth(Q_DEPTH_AFTER);
      await frames(4);
      // The rows of the same frame: P's and Q's z (column 3 of their matrix) must hold both new depths.
      const [after, rows] = await Promise.all([read(), readTransforms()]);
      const rowZ = (id: number): number => rowZAt(rows.cpuRows, rows.entityIds.indexOf(id));
      // The light buffer's clear, the ambient: floor − ambient is the tab's global light.
      const [ar, ag, ab, intensity] = engine.lighting.ambient;
      const ambient: Rgb = [ar * intensity, ag * intensity, ab * intensity];
      return mixOrderVerdict(before, { ...after, rowZ: { p: rowZ(p.id), q: rowZ(q.id) } }, floor, ambient);
    });

    // ── 3. The list takes the cull's exact test; equal depths go by id ──
    await pixelCheck(reporter, 'Light list: exact cull, id at equal depth', engine, async (probe, readTransforms) => {
      // A root 2D light's world z is −depth: past the far plane's depth,
      // (vp[14] − 1) / vp[10], by more than its range, the exact test culls it.
      const vp = engine.cam.viewProjection;
      const limit = (vp[14] - 1) / vp[10] + M_LIGHT.range;
      const depths = { inside: limit - FAR_EPS, outside: limit + FAR_EPS };
      // M_IN with M at `depth`, M's row z in the same frame, and whether the
      // light list held M right after the probe resolved.
      const readM = async (depth: number): Promise<{ value: Rgba; rowZ: number; listed: boolean }> => {
        m.depth(depth);
        await frames(4);
        const [[value, listed], rows] = await Promise.all([
          probe('light-buffer', [at(POINTS.mIn)], floorGroup())
            .then(([v]) => [v, engine.lighting.groups?.lightIds.includes(m.id) ?? false] as const),
          readTransforms(),
        ]);
        return { value, rowZ: rowZAt(rows.cpuRows, rows.entityIds.indexOf(m.id)), listed };
      };
      const inside = await readM(depths.inside);
      const outside = await readM(depths.outside);
      // M's despawn moves the last row, Q's, into its slot (swap-remove): Q's
      // slot falls below P's while its id stays the higher.
      m.destroy();
      p.depth(P_DEPTH);
      q.depth(P_DEPTH);
      await frames(4);
      const [[overlap], rows] = await Promise.all([
        probe('light-buffer', [at(POINTS.overlap)], floorGroup()),
        readTransforms(),
      ]);
      const ids = { p: p.id, q: q.id };
      const slots = { p: rows.entityIds.indexOf(ids.p), q: rows.entityIds.indexOf(ids.q) };
      // Their rows' z in that frame: the tie counts only if they are equal.
      const rowZ = { p: rowZAt(rows.cpuRows, slots.p), q: rowZAt(rows.cpuRows, slots.q) };
      return listVerdict({
        inside: inside.value,
        outside: outside.value,
        limit,
        depths,
        mRowZ: { inside: inside.rowZ, outside: outside.rowZ },
        mListed: { inside: inside.listed, outside: outside.listed },
        overlap, slots, ids, rowZ, rows: { ids: rows.entityIds.length, count: rows.entityCount },
      }, floor, M_TARGET);
    });
  } finally {
    // M is gone already after the third check: destroy() is idempotent.
    for (const h of scene) h.destroy();
    await frames(4);
    restoreView();
  }
}
