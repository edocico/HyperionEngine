// docs/plans/assets/2026-09-30-step6/step6-stats.mjs
//
// Offline statistics of the step-6 bench (round 2026-09-27, step 6:
// directional shadows), over what docs/plans/assets/2026-09-30-step6-directional-bench.js
// returns (format 'hyperion-step6-bench/1'). Pure, no dependency; its
// node:test is step6-stats.test.mjs, next to it.
//
//   node step6-stats.mjs <cost|penumbra|regress|edgepop> <bench.json>
//   node step6-stats.mjs details <harness.json> <statuses.json>
//
// Each prints a JSON summary on stdout. `regress` and `details` are gates:
// they exit 1 when a point or a check is out of tolerance. Every string and
// verdict is in English; the plan's documents translate them.
//
// Light-buffer values are linear RGBA (the probe's). "Luminance" is Rec. 709,
// as the harness's probe checks weigh a colour (ts/src/demo/probe-checks.ts),
// and a difference "in sun" is a difference in luminance over the sun's.
//
// A step budget in the bench's output is a LightingQuality.shadowSteps value.
// The evidence of 795b066 was read while a sun marched shadowSteps; with
// HEAD's light-accum.wgsl a sun marches 4x it (sub-decision 2 (b)).

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** t(0.975; dof): the two-sided 95 % quantile of Student's t, for 1 to 12 degrees of freedom. */
export const T975 = Object.freeze({
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447,
  7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179,
});

/** The Lighting tab's checks of step 3, whose details must not move (Task 10). */
export const STEP3_CHECKS = ['Lit vs unlit', 'Layer shadow on screen', 'Light layers'];

/** Rec. 709 luminance of an RGB(A) value; a number is taken as a luminance already. */
export function luminance(v) {
  return typeof v === 'number' ? v : 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

/** Milliseconds to three decimals, as the plan quotes them. */
const ms = (x) => x.toFixed(3);

/** The numbers a check's detail prints, in order. */
export function numbersIn(text) {
  return (String(text ?? '').match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
}

/**
 * The checks of the Lighting tab, from a harness run (`lighting`, Task 10's
 * runner), a statuses capture (`tabs.lighting.checks`, the M4 base), or an
 * array of checks.
 */
function lightingChecks(x) {
  if (Array.isArray(x)) return x;
  if (Array.isArray(x?.lighting)) return x.lighting;
  if (Array.isArray(x?.tabs?.lighting?.checks)) return x.tabs.lighting.checks;
  if (Array.isArray(x?.checks)) return x.checks;
  throw new Error('no Lighting checks: expected a harness run (lighting), a statuses capture (tabs.lighting.checks) or an array');
}

/**
 * For each check named, the numbers printed in its detail in the run and in
 * the base (`tabs.lighting` of the M4 statuses), their differences, and `ok`:
 * as many numbers on both sides, each difference at most `tol`.
 */
export function detailsDiff(checks, baseStatuses, names = STEP3_CHECKS, tol = 0.002) {
  const run = lightingChecks(checks);
  const base = lightingChecks(baseStatuses);
  return names.map((name) => {
    const r = run.find((c) => c.name === name);
    const b = base.find((c) => c.name === name);
    const rn = r ? numbersIn(r.detail) : null;
    const bn = b ? numbersIn(b.detail) : null;
    if (!r || !b) {
      return { name, run: rn, base: bn, diffs: [], ok: false, reason: `missing in the ${r ? 'base' : 'run'}` };
    }
    if (rn.length !== bn.length) {
      return { name, run: rn, base: bn, diffs: [], ok: false, reason: `${rn.length} numbers against ${bn.length}` };
    }
    const diffs = rn.map((v, i) => v - bn[i]);
    return { name, run: rn, base: bn, diffs, ok: diffs.every((d) => Math.abs(d) <= tol) };
  });
}

/**
 * The effect of each ABBA block, `(on1 + on2 - off1 - off2) / 2`. A block is
 * its four window spans in run order, `[on1, off1, off2, on2]` (ON, OFF, OFF,
 * ON), or `{ on1, off1, off2, on2 }`.
 */
export function abbaEffects(blocks) {
  return blocks.map((block) => {
    const [on1, off1, off2, on2] = Array.isArray(block) ? block : [block.on1, block.off1, block.off2, block.on2];
    return (on1 + on2 - off1 - off2) / 2;
  });
}

/**
 * Mean, sample SD, SE and the 95 % t interval of the block effects (ms).
 * The verdict: the cost with its SE when the interval is above 0; a negative
 * effect when it is below 0 (ON cheaper than OFF: the conditions are suspect);
 * otherwise "below resolution", bounded by the interval's upper end.
 */
export function tSummary(effects) {
  const n = effects.length;
  const dof = n - 1;
  const mean = n > 0 ? effects.reduce((s, e) => s + e, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(effects.reduce((s, e) => s + (e - mean) ** 2, 0) / dof) : NaN;
  const se = sd / Math.sqrt(n);
  const t = T975[dof] ?? NaN;
  const lo = mean - t * se;
  const hi = mean + t * se;
  let verdict;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    verdict = `no 95% interval: n = ${n} (the t table covers 2 to 13 blocks)`;
  } else if (lo > 0) {
    verdict = `${ms(mean)} ± ${ms(se)} ms (95% CI [${ms(lo)}, ${ms(hi)}], n = ${n})`;
  } else if (hi < 0) {
    verdict = `negative effect: ${ms(mean)} ± ${ms(se)} ms (95% CI [${ms(lo)}, ${ms(hi)}], n = ${n}): check the ON/OFF conditions`;
  } else {
    verdict = `below resolution: < ${ms(hi)} ms (mean ${ms(mean)} ± ${ms(se)}, 95% CI [${ms(lo)}, ${ms(hi)}], n = ${n})`;
  }
  return { n, mean, sd, se, dof, t, lo, hi, verdict };
}

/**
 * The 10-90 % width of a penumbra profile: `profile` is `[x, value]` points
 * ordered by x (a value is a luminance or an RGB(A) light-buffer value),
 * `lo` and `hi` the luminance of full shadow and of full light. Returns the x
 * distance between the first crossings of lo + 0.1·(hi − lo) and
 * lo + 0.9·(hi − lo), interpolated linearly between samples; a falling profile
 * is read from its other end. NaN when the profile crosses either level nowhere.
 */
export function width1090(profile, lo, hi) {
  const span = hi - lo;
  if (!(Math.abs(span) > 0) || profile.length < 2) return NaN;
  let points = profile.map(([x, v]) => [x, (luminance(v) - lo) / span]);
  if (points[points.length - 1][1] < points[0][1]) points = points.slice().reverse();
  const crossing = (level) => {
    for (let i = 1; i < points.length; i++) {
      const [x0, f0] = points[i - 1];
      const [x1, f1] = points[i];
      if (f0 < level && f1 >= level) return x0 + ((level - f0) / (f1 - f0)) * (x1 - x0);
    }
    return NaN;
  };
  return Math.abs(crossing(0.9) - crossing(0.1));
}

function sameLength(a, b) {
  if (a.length !== b.length) throw new Error(`${a.length} points against ${b.length}`);
}

/** The largest |lum(a) − lum(b)| over the points, in units of `scale` (the sun's luminance). */
export function maxRelDiff(a, b, scale) {
  sameLength(a, b);
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(luminance(a[i]) - luminance(b[i])) / scale);
  return max;
}

/** How many points have |lum(a) − lum(b)| / scale above `thr`. */
export function countAbove(a, b, scale, thr) {
  sameLength(a, b);
  let count = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(luminance(a[i]) - luminance(b[i])) / scale > thr) count++;
  return count;
}

/**
 * A grid read at one step budget (`steps`) against the reference grid: the
 * points off by more than 0.1 sun in luminance (`above01`, and their share),
 * the largest difference in sun, and how many of the points off are darker or
 * lighter than the reference (lighter: light leaking past a caster). A point
 * whose difference is not finite (a NaN or an infinity on either side) counts
 * in `nonFinite` and as off by more than 0.1, never in `max`: above01 =
 * darker + lighter + nonFinite.
 */
export function gridSummary(steps, ref, sunLum) {
  sameLength(steps, ref);
  let above01 = 0;
  let darker = 0;
  let lighter = 0;
  let nonFinite = 0;
  let max = 0;
  for (let i = 0; i < steps.length; i++) {
    const e = (luminance(steps[i]) - luminance(ref[i])) / sunLum;
    if (!Number.isFinite(e)) {
      nonFinite++;
      above01++;
      continue;
    }
    max = Math.max(max, Math.abs(e));
    if (Math.abs(e) > 0.1) {
      above01++;
      if (e < 0) darker++;
      else lighter++;
    }
  }
  return { n: steps.length, above01, fracAbove01: above01 / steps.length, max, darker, lighter, nonFinite };
}

/**
 * The edge pop along a row (pop[i] at ds[i], in sun): the largest, the one at
 * the far edge and its d, and the share of the d where the pop is at least
 * 0.1, as the Lighting tab's edge check counts it.
 */
export function popSummary(ds, pop) {
  sameLength(ds, pop);
  if (pop.length === 0) throw new Error('an empty row');
  const last = pop.length - 1;
  return {
    maxPop: Math.max(...pop),
    popFar: pop[last],
    dFar: ds[last],
    fracAbove01: pop.filter((p) => p >= 0.1).length / pop.length,
  };
}

/**
 * The fp16 exponent of the magnitude `a` (>= 0): floor(log2 a) from the
 * smallest normal, 2^-14, up; -14 below it, where the subnormals share the
 * smallest normal's spacing (zero included).
 */
function fp16Exponent(a) {
  if (!(a >= 2 ** -14)) return -14;
  let e = Math.floor(Math.log2(a));
  // log2 can round across a power of two: settle the exponent exactly.
  if (2 ** e > a) e--;
  else if (2 ** (e + 1) <= a) e++;
  return e;
}

/**
 * One fp16 ULP at `v`: 2^(floor(log2|v|) − 10) for a normal fp16 value, and
 * the subnormal spacing 2^-24 below 2^-14 (zero included).
 */
export function fp16Ulp(v) {
  return 2 ** (fp16Exponent(Math.abs(v)) - 10);
}

/**
 * Where a finite `v` sits on the fp16 line: for an fp16 value, its bit
 * pattern read as an integer (a subnormal's is a / 2^-24, a normal value's
 * (e + 15)·1024 + (a / 2^e − 1)·1024), negated below zero, so -0 and +0 are
 * both 0; linear in between.
 */
function fp16Position(v) {
  const a = Math.abs(v);
  const e = fp16Exponent(a);
  const p = a < 2 ** -14 ? a * 2 ** 24 : 1024 * (e + 15) + (a / 2 ** e - 1) * 1024;
  return v < 0 ? -p : p;
}

/**
 * How many fp16 steps lie between `a` and `b`: between two fp16 values, the
 * difference of their bit patterns, through zero when their signs differ.
 * Exact where the step changes at a power of two (0.5 − 2^-11 is two steps
 * below 0.5, 0.5 + 2^-11 one above it). Infinity when the two differ and
 * either is not finite.
 */
function fp16Steps(a, b) {
  if (a === b) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(fp16Position(a) - fp16Position(b));
}

/** The channels of a grid point: an RGBA array, or one number. */
const channels = (p) => (typeof p === 'number' ? [p] : p);

/**
 * Two light-buffer grids point by point, channel by channel: how many points
 * are identical, how many are within 1 fp16 ULP on every channel (identical
 * ones included): at most one fp16 step apart, counted exactly (fp16Steps),
 * the largest absolute difference, and the channel furthest out in fp16
 * steps (`ulps`; null when every point is identical). A NaN is identical only
 * to a NaN, and never within a step of anything else.
 */
export function compareGrids(a, b) {
  sameLength(a, b);
  let identical = 0;
  let withinUlp = 0;
  let maxAbs = 0;
  let worst = null;
  for (let i = 0; i < a.length; i++) {
    const pa = channels(a[i]);
    const pb = channels(b[i]);
    if (pa.length !== pb.length) throw new Error(`point ${i}: ${pa.length} channels against ${pb.length}`);
    let same = true;
    let within = true;
    for (let c = 0; c < pa.length; c++) {
      const x = pa[c];
      const y = pb[c];
      if (x === y || (Number.isNaN(x) && Number.isNaN(y))) continue;
      same = false;
      const abs = Math.abs(x - y);
      const ulps = fp16Steps(x, y);
      if (!(ulps <= 1)) within = false;
      if (abs > maxAbs) maxAbs = abs;
      if (worst === null || !(ulps <= worst.ulps)) worst = { index: i, channel: c, a: x, b: y, abs, ulps };
    }
    if (same) identical++;
    if (within) withinUlp++;
  }
  return { n: a.length, identical, withinUlp, maxAbs, worst };
}

/**
 * A grid as the bench stores it: an array of RGBA values as it is, or
 * `{ encoding: 'f32-rgba-base64', count, data }`, the float32 RGBA of `count`
 * points, little-endian, in base64 (the 9216-point grids).
 */
export function decodeGrid(grid) {
  if (Array.isArray(grid)) return grid;
  if (grid?.encoding !== 'f32-rgba-base64') throw new Error(`unknown grid encoding: ${JSON.stringify(grid?.encoding)}`);
  const bytes = Uint8Array.from(Buffer.from(grid.data, 'base64'));
  const f = new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4));
  if (f.length !== grid.count * 4) throw new Error(`the grid says ${grid.count} points, but the data holds ${f.length / 4}`);
  return Array.from({ length: grid.count }, (_, i) => [f[4 * i], f[4 * i + 1], f[4 * i + 2], f[4 * i + 3]]);
}

// ── The summaries of the CLI, one per bench task ──────────────────────────

const resultsOf = (bench, task) => (bench.results ?? []).filter((r) => r.task === task);
const sunLumOf = (sun) => luminance(sun.color) * (sun.energy ?? 1);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * `cost`: per pair, the ABBA effect of every valid block and its t interval,
 * the mean ON and OFF spans, the windows thrown out and why; and, as context,
 * the `set` effect minus the `march` effect (about the cost of one SDF set).
 */
export function summarizeCost(bench) {
  const pairs = resultsOf(bench, 'cost').map((r) => {
    const blocks = r.blocks ?? [];
    const effects = abbaEffects(blocks);
    const windows = r.windows ?? [];
    const invalid = windows.filter((w) => !w.valid)
      .map((w) => ({ block: w.block, attempt: w.attempt, slot: w.slot, condition: w.condition, reasons: w.reasons }));
    return {
      label: r.label ?? null,
      pair: r.pair,
      ...(r.pair === 'uber' ? { entities: r.n, quadPx: r.quadPx } : {}),
      outsideCriterion: Boolean(r.outsideCriterion),
      blocks: blocks.length,
      windows: windows.length,
      invalidWindows: invalid.length,
      invalid,
      redos: r.redos ?? 0,
      stopped: r.stopped ?? null,
      spanOn: blocks.length > 0 ? mean(blocks.flatMap((b) => [b.on1, b.on2])) : NaN,
      spanOff: blocks.length > 0 ? mean(blocks.flatMap((b) => [b.off1, b.off2])) : NaN,
      effects,
      ...tSummary(effects),
    };
  });
  const last = (pair) => pairs.filter((p) => p.pair === pair).at(-1);
  const march = last('march');
  const set = last('set');
  return { pairs, context: march && set ? { setMinusMarch: set.mean - march.mean } : null };
}

/** The values of `profiles` at budget `steps`, concatenated. */
const valuesAt = (profiles, steps) => profiles.flatMap((p) => p.values[String(steps)]);
const pointsOf = (profiles) => profiles.flatMap((p) => p.points);

/**
 * One `penumbra` run at one angle: the w10-90 width of the wall's profiles at
 * 48 steps and its slope w/d against 0.8·angle (ratio 1: a linear penumbra
 * angle·d wide), the largest error of 48 steps against the reference on the
 * wall and on the diagonal, and on the platform parallel to the rays the same
 * error, the points off by more than 0.1 sun and the band's top above the face.
 * The rule of the plan: the errors at most 0.05 sun on the wall and the
 * diagonal, the ratio within ±50 % at d = 12 and 26.
 */
function summarizeAngle(r) {
  const sunLum = sunLumOf(r.sun);
  const lo = luminance(r.ambient);
  const ref = r.ref;
  const of = (kind) => r.profiles.filter((p) => p.kind === kind);
  const wall = of('wall');
  const platform = of('platform');
  const diagonal = of('diagonal');
  const widths = wall.map((p) => {
    const w = (steps) => width1090(p.points.map(([, y], k) => [y, p.values[String(steps)][k]]), lo, lo + sunLum);
    const w48 = w(48);
    const slope = w48 / p.d;
    return { d: p.d, w48, wRef: w(ref), slope, ratio: slope / (0.8 * r.angle) };
  });
  const ruled = widths.filter((w) => w.d === 12 || w.d === 26);
  const slopeOk = ruled.length === 2 && ruled.every((w) => w.ratio >= 0.5 && w.ratio <= 1.5);
  const wallMax = maxRelDiff(valuesAt(wall, 48), valuesAt(wall, ref), sunLum);
  const diagonalMax = maxRelDiff(valuesAt(diagonal, 48), valuesAt(diagonal, ref), sunLum);
  const p48 = valuesAt(platform, 48);
  const pRef = valuesAt(platform, ref);
  const heights = platform.flatMap((p) => p.heights);
  let bandTop = 0;
  p48.forEach((v, k) => {
    if (Math.abs(luminance(v) - luminance(pRef[k])) / sunLum > 0.1) bandTop = Math.max(bandTop, heights[k]);
  });
  return {
    label: r.label ?? null,
    angle: r.angle,
    patched: Boolean(r.patched),
    ref,
    wall: { widths, max: wallMax },
    diagonal: { max: diagonalMax },
    platform: { points: p48.length, max: maxRelDiff(p48, pRef, sunLum), above01: countAbove(p48, pRef, sunLum, 0.1), bandTop },
    slopeOk,
    passesRule: slopeOk && wallMax <= 0.05 && diagonalMax <= 0.05,
  };
}

/** The rule of sub-decision 1, fixed before the run (plan, Task 6, Step 5). */
function angleVerdict(angles) {
  if (angles.length === 0) return 'no angle run';
  if (angles.every((a) => !a.slopeOk)) {
    return 'the w10-90 slope fails at every angle: a defect, investigate it (superpowers:systematic-debugging) before anything else';
  }
  const at = (angle) => angles.filter((a) => Math.abs(a.angle - angle) < 1e-12).at(-1);
  const a02 = at(0.02);
  if (!a02) return 'no run at 0.02 rad';
  if (a02.passesRule) {
    return '0.02 rad confirmed: at 48 steps the wall and diagonal errors are at most 0.05 sun, and the slope is within ±50 % of 0.8·0.02 at d = 12 and 26';
  }
  const passing = [...new Set(angles.filter((a) => a.passesRule).map((a) => a.angle))];
  if (passing.length === 0) return '0.02 rad not confirmed, and no other angle passes: investigate';
  return `0.02 rad not confirmed; ${passing.join(', ')} rad pass: apply the fallback of sub-decision 1 (b), a WGSL constant SUN_ANGLE, and write it in the final report`;
}

/** A `convergence` run: the reference budget against its check over every profile point. */
function summarizeConvergence(r) {
  const sunLum = sunLumOf(r.sun);
  const max = maxRelDiff(valuesAt(r.profiles, r.conv), valuesAt(r.profiles, r.ref), sunLum);
  const ok = max <= 0.01;
  return {
    label: r.label ?? null,
    angle: r.angle,
    ref: r.ref,
    conv: r.conv,
    points: pointsOf(r.profiles).length,
    max,
    ok,
    verdict: ok
      ? `${r.ref} and ${r.conv} steps agree within 0.01 sun`
      : `${r.ref} and ${r.conv} steps differ by ${max.toFixed(3)} sun (> 0.01): make 4096 the reference and redo`,
  };
}

/** A `grid` run: per sun, gridSummary at every budget below the reference, and the reference against its check. */
function summarizeGrid(r) {
  const sunLum = sunLumOf(r.sun);
  const suns = r.suns.map((sun) => {
    const ref = decodeGrid(sun.grids[String(r.ref)]);
    const conv = decodeGrid(sun.grids[String(r.conv)]);
    const budgets = r.budgets.filter((s) => s !== r.ref && s !== r.conv)
      .map((steps) => ({ steps, ...gridSummary(decodeGrid(sun.grids[String(steps)]), ref, sunLum) }));
    const max = maxRelDiff(conv, ref, sunLum);
    return {
      name: sun.name,
      rotation: sun.rotation,
      budgets,
      convergence: { ref: r.ref, conv: r.conv, max, above001: countAbove(conv, ref, sunLum, 0.01), ok: max <= 0.01 },
    };
  });
  return { label: r.label ?? null, angle: r.angle, ref: r.ref, conv: r.conv, gridSize: r.gridSize ?? null, suns };
}

/**
 * Sub-decision 2, decided on the model's numbers at rotation(-PI/2), the
 * JSDoc's example: the GPU confirms the model when, at 48 steps, more than
 * 0.1 % of the grid is off by more than 0.1 sun (model: 0.84 %). It reads the
 * grid's budgets as the sun's: true of a grid read with the shader of before
 * the x4 rule (penumbra-ab-m2.json, 795b066). With HEAD's, a sun marches
 * 4 x shadowSteps, and the grid's 48 is the sun's 192.
 */
function subDecision2(grids) {
  const down = grids.at(-1)?.suns.find((s) => Math.abs(s.rotation + Math.PI / 2) < 1e-9);
  const at48 = down?.budgets.find((b) => b.steps === 48);
  if (!at48) return null;
  const pct = `${(100 * at48.fracAbove01).toFixed(2)}%`;
  const confirmsModel = at48.fracAbove01 > 0.001;
  return {
    sun: down.name,
    steps: 48,
    fracAbove01: at48.fracAbove01,
    confirmsModel,
    verdict: confirmsModel
      ? `the GPU confirms the model at ${down.name}, 48 steps: ${pct} of the grid off by more than 0.1 sun (> 0.1%; model 0.84%): step 6 runs the branch chosen for sub-decision 2`
      : `the GPU contradicts the model at ${down.name}, 48 steps: ${pct} of the grid off by more than 0.1 sun (<= 0.1%; model 0.84%): stop and ask sub-decision 2 again, with these numbers`,
  };
}

/** `penumbra`: every angle run, the convergence runs, the grids, and the verdicts of sub-decisions 1 and 2. */
export function summarizePenumbra(bench) {
  const runs = resultsOf(bench, 'penumbra');
  const angles = runs.filter((r) => r.kind === 'profiles').map(summarizeAngle);
  const grids = runs.filter((r) => r.kind === 'grid').map(summarizeGrid);
  return {
    angles,
    angleVerdict: angleVerdict(angles),
    convergence: runs.filter((r) => r.kind === 'convergence').map(summarizeConvergence),
    grids,
    subDecision2: subDecision2(grids),
  };
}

/** `regress`: the light buffer with the shader of 2f43e42 against HEAD's, identical or within 1 fp16 ULP. */
export function summarizeRegress(bench) {
  return resultsOf(bench, 'regress').map((r) => {
    const c = compareGrids(decodeGrid(r.old), decodeGrid(r.new));
    const ok = c.withinUlp === c.n;
    let verdict = 'identical';
    if (c.identical !== c.n) {
      verdict = ok ? 'within 1 fp16 ULP' : `${c.n - c.withinUlp} of ${c.n} points beyond 1 fp16 ULP: investigate before going on`;
    }
    return { label: r.label ?? null, ...c, ok, verdict };
  });
}

/**
 * `edgepop`: per range, the pop of W_in's shadow along the row (popSummary),
 * the last d where it is at least 0.1 (the band's end), and the step-6 edge
 * rule: W_out's row lit like the open row (the largest difference, in sun) and
 * E against the open row at d = 1 (negative: the march read past the SDF).
 */
export function summarizeEdgepop(bench) {
  return resultsOf(bench, 'edgepop').map((r) => {
    const sunLum = sunLumOf(r.sun);
    const one = r.ds.indexOf(1);
    const ranges = r.rows.map((row) => {
      const pop = r.ds.map((_, i) => (luminance(row.out[i]) - luminance(row.inn[i])) / sunLum);
      const band = r.ds.filter((_, i) => pop[i] >= 0.1);
      return {
        range: row.range,
        ...popSummary(r.ds, pop),
        bandEnd: band.length > 0 ? band[band.length - 1] : null,
        outVsRef: maxRelDiff(row.out, row.ref, sunLum),
        eVsRef: one >= 0 ? (luminance(row.e) - luminance(row.ref[one])) / sunLum : null,
      };
    });
    return { label: r.label ?? null, W: r.W, zoom: r.zoom, canvas: r.canvas, lightBuffer: r.lightBuffer, ranges };
  });
}

const SUMMARIES = { cost: summarizeCost, penumbra: summarizePenumbra, regress: summarizeRegress, edgepop: summarizeEdgepop };

const USAGE = `usage: node step6-stats.mjs <cost|penumbra|regress|edgepop> <bench.json>
       node step6-stats.mjs details <harness.json> <statuses.json>`;

function main(argv) {
  const [command, ...files] = argv;
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
  if (command === 'details' && files.length === 2) {
    const checks = detailsDiff(read(files[0]), read(files[1]));
    const ok = checks.every((c) => c.ok);
    console.log(JSON.stringify({ ok, checks }, null, 2));
    return ok ? 0 : 1;
  }
  if (SUMMARIES[command] && files.length === 1) {
    const summary = SUMMARIES[command](read(files[0]));
    console.log(JSON.stringify(summary, null, 2));
    if (command === 'regress') return summary.every((r) => r.ok) ? 0 : 1;
    return 0;
  }
  console.error(USAGE);
  return 2;
}

/**
 * Whether node was started with this file, under any path: node runs a script
 * under its real path (import.meta.url) and leaves process.argv[1] as given,
 * so a symlink would otherwise skip main() and exit 0, a gate passing silently.
 */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
