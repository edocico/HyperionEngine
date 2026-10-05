// docs/plans/assets/2026-09-30-step6/step6-stats.test.mjs
// Run: node --test docs/plans/assets/2026-09-30-step6/step6-stats.test.mjs
//
// The offline statistics of the step-6 bench (step6-stats.mjs), on values
// worked out by hand, then its CLI summaries on small synthetic bench outputs
// in the format of docs/plans/assets/2026-09-30-step6-directional-bench.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  T975, STEP3_CHECKS, LEGACY_SUN_STEP_MULTIPLIERS, luminance, numbersIn, detailsDiff, abbaEffects, tSummary, width1090,
  maxRelDiff, countAbove, gridSummary, popSummary, fp16Ulp, compareGrids, decodeGrid,
  summarizeCost, summarizePenumbra, summarizeRegress, summarizeEdgepop,
} from './step6-stats.mjs';

const SCRIPT = fileURLToPath(new URL('./step6-stats.mjs', import.meta.url));
const BENCH = new URL('../2026-09-30-step6-directional-bench.js', import.meta.url);
const SHADER = new URL('../../../../ts/src/shaders/light-accum.wgsl', import.meta.url);

/**
 * One function of the bench, evaluated. The bench is the body of an
 * evaluate_script call, not a module, so the definition is read from the
 * file: `const <name> = (<arg>) => { … };` at its indentation. It must be
 * self-contained (no free name but globals).
 */
function benchFunction(name) {
  const text = readFileSync(BENCH, 'utf8');
  const m = new RegExp(`\\n  const ${name} = (\\(\\w+\\) => \\{\\n[\\s\\S]*?\\n  \\});\\n`).exec(text);
  assert.ok(m, `the bench defines ${name}`);
  return new Function(`return ${m[1]};`)();
}

function close(actual, want, eps, what) {
  assert.ok(Math.abs(actual - want) <= eps, `${what}: ${actual} is not within ${eps} of ${want}`);
}

/** The bench's sun: [1, 0.95, 0.85] at energy 1, Rec. 709 luminance 0.95341. */
const SUN = [1, 0.95, 0.85];
const SUN_LUM = 0.2126 + 0.7152 * 0.95 + 0.0722 * 0.85;
const AMBIENT = [0.06, 0.07, 0.12];
/** ambient + f * sun, alpha 1: the light buffer where the sun's shadow factor is f. */
const lit = (f) => [AMBIENT[0] + f * SUN[0], AMBIENT[1] + f * SUN[1], AMBIENT[2] + f * SUN[2], 1];
/** `x`, checked to be an fp16 value (what an rgba16float texel holds): a whole number of fp16 ULPs. */
const half = (x) => {
  assert.ok(Number.isInteger(x / fp16Ulp(x)), `${x} is not an fp16 value`);
  return x;
};

// ── The functions of the brief ─────────────────────────────────────────────

test('T975: t(0.975; dof) for 1 to 12 degrees of freedom', () => {
  assert.equal(T975[7], 2.365);
  assert.equal(T975[3], 3.182);
  assert.equal(T975[1], 12.706);
  assert.equal(T975[12], 2.179);
  assert.deepEqual(Object.keys(T975).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('luminance: Rec. 709 of an RGB(A) value; a number is already one', () => {
  close(luminance(SUN), SUN_LUM, 1e-12, 'the sun');
  close(luminance([0.5, 0.5, 0.5, 1]), 0.5, 1e-12, 'grey');
  assert.equal(luminance(0.25), 0.25);
});

test('abbaEffects: (on1 + on2 - off1 - off2) / 2 per block, from [ON, OFF, OFF, ON]', () => {
  // [on1, off1, off2, on2] in run order, or named.
  const effects = abbaEffects([[10.4, 10.1, 10.2, 10.5], { on1: 3, off1: 2, off2: 2.5, on2: 3.5 }]);
  assert.equal(effects.length, 2);
  close(effects[0], 0.3, 1e-12, '(10.4 + 10.5 - 10.1 - 10.2) / 2');
  close(effects[1], 1, 1e-12, '(3 + 3.5 - 2 - 2.5) / 2');
});

test('tSummary: n = 8, mean 0.325, 7 dof, t 2.365, a CI above 0 gives the cost with its SE', () => {
  const s = tSummary([0.30, 0.25, 0.40, 0.35, 0.20, 0.30, 0.45, 0.35]);
  assert.equal(s.n, 8);
  close(s.mean, 0.325, 1e-12, 'mean');
  // Squared deviations sum to 0.045: sd = sqrt(0.045 / 7), se = sd / sqrt(8).
  close(s.sd, Math.sqrt(0.045 / 7), 1e-12, 'sd');
  close(s.se, Math.sqrt(0.045 / 7) / Math.sqrt(8), 1e-12, 'se');
  assert.equal(s.dof, 7);
  assert.equal(s.t, 2.365);
  close(s.lo, 0.325 - 2.365 * s.se, 1e-12, 'lo');
  close(s.hi, 0.325 + 2.365 * s.se, 1e-12, 'hi');
  assert.ok(s.lo > 0);
  assert.equal(s.verdict, '0.325 ± 0.028 ms (95% CI [0.258, 0.392], n = 8)');
});

test('tSummary: effects straddling 0 are below resolution, bounded by the upper end of the CI', () => {
  const s = tSummary([0.10, -0.08, 0.05, -0.04, 0.02, -0.06, 0.07, -0.03]);
  close(s.mean, 0.00375, 1e-12, 'mean');
  assert.ok(s.lo <= 0 && s.hi > 0);
  assert.ok(s.verdict.startsWith(`below resolution: < ${s.hi.toFixed(3)} ms (mean 0.004 ± `), s.verdict);
  assert.match(s.verdict, /95% CI \[-0\.\d{3}, 0\.\d{3}\], n = 8\)$/);
});

test('tSummary: a CI wholly below 0 is a negative effect, not "below resolution": the ON/OFF conditions are suspect', () => {
  const s = tSummary([-0.30, -0.25, -0.40, -0.35, -0.20, -0.30, -0.45, -0.35]);
  close(s.mean, -0.325, 1e-12, 'mean');
  assert.ok(s.hi < 0);
  assert.equal(s.verdict, 'negative effect: -0.325 ± 0.028 ms (95% CI [-0.392, -0.258], n = 8): check the ON/OFF conditions');
});

test('tSummary: a single block has no interval', () => {
  const s = tSummary([0.3]);
  assert.equal(s.n, 1);
  assert.ok(Number.isNaN(s.lo) && Number.isNaN(s.hi));
  assert.match(s.verdict, /^no 95% interval/);
});

test('detailsDiff: the M4 detail of "Lit vs unlit" against itself, a number moved by 0.001 and by 0.003, a number missing', () => {
  const M4 = 'lit 0.489, 0.101, unlit x light 0.489, 0.101 (light 0.813, 0.672, 0.630)';
  const base = { format: 'hyperion-5b-statuses/1', mode: 'B', tabs: { lighting: { checks: [{ name: 'Lit vs unlit', status: 'pass', detail: M4 }] } } };
  const run = (detail) => [{ name: 'Lit vs unlit', status: 'pass', detail }];

  const [same] = detailsDiff(run(M4), base, ['Lit vs unlit']);
  assert.equal(same.name, 'Lit vs unlit');
  assert.deepEqual(same.run, [0.489, 0.101, 0.489, 0.101, 0.813, 0.672, 0.63]);
  assert.deepEqual(same.base, same.run);
  assert.deepEqual(same.diffs, [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(same.ok, true);

  const [moved1] = detailsDiff(run(M4.replace('lit 0.489', 'lit 0.490')), base, ['Lit vs unlit']);
  assert.equal(moved1.ok, true);
  close(moved1.diffs[0], 0.001, 1e-12, 'the moved number');

  const [moved3] = detailsDiff(run(M4.replace('lit 0.489', 'lit 0.492')), base, ['Lit vs unlit']);
  assert.equal(moved3.ok, false);

  const [fewer] = detailsDiff(run('lit 0.489, 0.101, unlit x light 0.489, 0.101 (light 0.813, 0.672)'), base, ['Lit vs unlit']);
  assert.equal(fewer.ok, false);
  assert.match(fewer.reason, /6 numbers against 7/);
});

test('detailsDiff: the step-3 checks by default, from a harness JSON; a check missing on either side is not ok', () => {
  assert.deepEqual(STEP3_CHECKS, ['Lit vs unlit', 'Layer shadow on screen', 'Light layers']);
  const harness = {
    format: 'hyperion-step6-harness/1',
    lighting: [
      { name: 'Light layers', status: 'pass', detail: '2 groups, 2 SDF sets' },
      { name: 'Layer shadow on screen', status: 'pass', detail: 'blue: in the band 0.295, mirrored point 1.097' },
    ],
  };
  const base = { tabs: { lighting: { checks: [
    { name: 'Lit vs unlit', status: 'pass', detail: 'lit 0.489, 0.101' },
    { name: 'Layer shadow on screen', status: 'pass', detail: 'blue: in the band 0.295, mirrored point 1.098' },
    { name: 'Light layers', status: 'pass', detail: '2 groups, 2 SDF sets' },
  ] } } };
  const out = detailsDiff(harness, base);
  assert.deepEqual(out.map((c) => c.name), STEP3_CHECKS);
  assert.equal(out[0].ok, false);
  assert.match(out[0].reason, /missing in the run/);
  assert.equal(out[1].ok, true);
  assert.deepEqual(out[2].run, [2, 2]);
  assert.equal(out[2].ok, true);
});

test('numbersIn: the numbers a check prints, signs and exponents included', () => {
  assert.deepEqual(numbersIn('S 0.185, -0.170; 2 groups; 1e-3'), [0.185, -0.17, 2, 0.001]);
  assert.deepEqual(numbersIn(null), []);
});

test('width1090: a linear ramp from 0.2 to 0.8 over x in [0.5, 1.5] is 0.8 wide, rising or falling', () => {
  const xs = Array.from({ length: 21 }, (_, k) => k * 0.1);
  const ramp = (x) => 0.2 + 0.6 * Math.min(Math.max(x - 0.5, 0), 1);
  const rising = xs.map((x) => [x, ramp(x)]);
  close(width1090(rising, 0.2, 0.8), 0.8, 1e-9, 'rising');
  const falling = xs.map((x) => [x, ramp(2 - x)]);
  close(width1090(falling, 0.2, 0.8), 0.8, 1e-9, 'falling');
  // RGB values go through their luminance: grey 0.2 -> 0.8.
  close(width1090(xs.map((x) => [x, [ramp(x), ramp(x), ramp(x), 1]]), 0.2, 0.8), 0.8, 1e-9, 'RGBA');
  // A profile that never reaches 90 % has no width.
  assert.ok(Number.isNaN(width1090(xs.map((x) => [x, 0.2 + 0.4 * Math.min(x, 1)]), 0.2, 0.8)));
});

test('maxRelDiff and countAbove: |a - b| in units of `scale`', () => {
  close(maxRelDiff([1, 2, 3], [1, 2.5, 2], 2), 0.5, 1e-12, 'max');
  assert.equal(countAbove([1, 2, 3], [1, 2.5, 2], 2, 0.3), 1);
  assert.equal(countAbove([1, 2, 3], [1, 2.5, 2], 2, 0.2), 2);
  // RGBA through luminance.
  close(maxRelDiff([lit(0.5)], [lit(0.25)], SUN_LUM), 0.25, 1e-12, 'a quarter of the sun');
});

test('gridSummary: one point 0.2 sun darker, one 0.2 lighter, one 0.05 off: 2 above 0.1, one darker and one lighter', () => {
  const ref = [lit(0.5), lit(0.5), lit(0.5), lit(0.5)];
  const steps = [lit(0.3), lit(0.7), lit(0.55), lit(0.5)];
  const s = gridSummary(steps, ref, SUN_LUM);
  assert.equal(s.n, 4);
  assert.equal(s.above01, 2);
  assert.equal(s.fracAbove01, 0.5);
  close(s.max, 0.2, 1e-12, 'max');
  assert.equal(s.darker, 1);
  assert.equal(s.lighter, 1);
  assert.equal(s.nonFinite, 0);
});

test('gridSummary: a NaN point is counted (nonFinite) and above the threshold, and the max stays over the finite points', () => {
  const ref = [lit(0.5), lit(0.5), lit(0.5), lit(0.5)];
  const steps = [lit(0.3), [NaN, NaN, NaN, 1], lit(0.55), lit(0.5)];
  const s = gridSummary(steps, ref, SUN_LUM);
  assert.equal(s.nonFinite, 1);
  assert.equal(s.above01, 2);
  assert.equal(s.fracAbove01, 0.5);
  close(s.max, 0.2, 1e-12, 'max over the finite points');
  assert.equal(s.darker, 1);
  assert.equal(s.lighter, 0);
});

test('popSummary: the largest pop, the pop at the far edge and its d, the share of the d where it is at least 0.1', () => {
  const s = popSummary([0.5, 1, 1.5, 2, 2.5, 3], [1, 1, 0.98, 0.4, 0.05, 0]);
  assert.deepEqual(s, { maxPop: 1, popFar: 0, dFar: 3, fracAbove01: 4 / 6 });
});

test('fp16Ulp: 2^(floor(log2|v|) - 10), and the subnormal spacing below 2^-14', () => {
  assert.equal(fp16Ulp(1), 2 ** -10);
  assert.equal(fp16Ulp(0.75), 2 ** -11);
  assert.equal(fp16Ulp(-0.5), 2 ** -11);
  assert.equal(fp16Ulp(1.999), 2 ** -10);
  assert.equal(fp16Ulp(2), 2 ** -9);
  assert.equal(fp16Ulp(0), 2 ** -24);
  assert.equal(fp16Ulp(2 ** -20), 2 ** -24);
});

test('compareGrids: identical; 1 fp16 ULP apart (withinUlp); 3 ULP apart (out)', () => {
  const a = [[0.5, 0.25, 1, 1], [0.06, 0.07, 0.12, 1]];
  assert.deepEqual(compareGrids(a, a.map((p) => [...p])), { n: 2, identical: 2, withinUlp: 2, maxAbs: 0, worst: null });

  const one = compareGrids(a, [[0.5 + 2 ** -11, 0.25, 1, 1], a[1]]);
  assert.equal(one.identical, 1);
  assert.equal(one.withinUlp, 2);
  assert.equal(one.maxAbs, 2 ** -11);
  assert.deepEqual(one.worst, { index: 0, channel: 0, a: 0.5, b: 0.5 + 2 ** -11, abs: 2 ** -11, ulps: 1 });

  const three = compareGrids(a, [[0.5 + 3 * 2 ** -11, 0.25, 1, 1], a[1]]);
  assert.equal(three.identical, 1);
  assert.equal(three.withinUlp, 1);
  assert.equal(three.worst.ulps, 3);

  // A NaN is never within a ULP of a number.
  assert.equal(compareGrids([[NaN]], [[0.5]]).withinUlp, 0);
  assert.throws(() => compareGrids(a, [a[0]]), /2 points against 1/);
});

test('compareGrids: exact across a power of two, where the fp16 step halves below it (0.5 is 2^-12 above its lower neighbour, 2^-11 below its upper one)', () => {
  // 0.5 - 2^-11 is two fp16 steps below 0.5 (the step is 2^-12 there),
  // although 2^-11 is the step above 0.5: out.
  const twoBelow = compareGrids([[half(0.5)]], [[half(0.5 - 2 ** -11)]]);
  assert.equal(twoBelow.withinUlp, 0);
  assert.equal(twoBelow.worst.ulps, 2);
  // One step below, one step above: in.
  const oneBelow = compareGrids([[0.5]], [[half(0.5 - 2 ** -12)]]);
  assert.equal(oneBelow.withinUlp, 1);
  assert.equal(oneBelow.worst.ulps, 1);
  const oneAbove = compareGrids([[0.5]], [[half(0.5 + 2 ** -11)]]);
  assert.equal(oneAbove.withinUlp, 1);
  assert.equal(oneAbove.worst.ulps, 1);
  // The steps between two fp16 values are the difference of their bit
  // patterns: 1 is 0x3c00 and 0.5 0x3800; 2^-14, the smallest normal, is
  // 0x0400 (every subnormal lies below it); the largest finite, 65504, 0x7bff.
  // Opposite signs count through zero.
  assert.equal(compareGrids([[1]], [[0.5]]).worst.ulps, 0x3c00 - 0x3800);
  assert.equal(compareGrids([[2 ** -14]], [[0]]).worst.ulps, 0x0400);
  assert.equal(compareGrids([[65504]], [[1]]).worst.ulps, 0x7bff - 0x3c00);
  assert.equal(compareGrids([[-(2 ** -24)]], [[2 ** -24]]).worst.ulps, 2);
});

test('decodeGrid: the bench\'s base64 float32 RGBA grids, and plain arrays as they are', () => {
  const values = [[0.1, 0.2, 0.3, 1], [0.5, 0.25, 0.125, 1]];
  const data = Buffer.from(new Float32Array(values.flat()).buffer).toString('base64');
  const decoded = decodeGrid({ encoding: 'f32-rgba-base64', count: 2, data });
  assert.deepEqual(decoded, values.map((p) => p.map(Math.fround)));
  assert.equal(decodeGrid(values), values);
  assert.throws(() => decodeGrid({ encoding: 'f32-rgba-base64', count: 3, data }), /3 points, but the data holds 2/);
  assert.throws(() => decodeGrid({ encoding: 'png', data }), /unknown grid encoding/);
});

// ── The CLI summaries, on synthetic bench outputs ──────────────────────────

/** A penumbra profile over `points`, its values per budget from `f(point, steps)`. */
function profile(fields, points, budgets, f) {
  return { ...fields, points, values: Object.fromEntries(budgets.map((s) => [String(s), points.map((p) => lit(f(p, s)))])) };
}

/**
 * The bench's `penumbra` profiles at `angle` (kind 'profiles'). The wall's
 * shadow band ends at y = -1, with a linear penumbra angle·d·widthScale wide
 * above it; `wallError` darkens its lit part (y > -0.4) at 48 steps. The
 * platform is lit, except `bandPoints` points at its lowest heights, 0.6 sun
 * darker at 48 steps. The diagonal is lit, `diagonalError` darker at 48 steps.
 */
function penumbraEntry(angle, { wallError = 0, diagonalError = 0, bandPoints = 0, widthScale = 1 } = {}) {
  const budgets = [48, 1024];
  const ys = Array.from({ length: 41 }, (_, k) => -2 + k * 0.05);
  const ramp = (y, d) => Math.min(Math.max((y + 1) / (angle * d * widthScale), 0), 1);
  const wall = [2, 12, 26].map((d) => profile({ kind: 'wall', d }, ys.map((y) => [-11.7 + d, y]), budgets,
    ([, y], s) => ramp(y, d) - (s === 48 && y > -0.4 ? wallError : 0)));
  const heights = Array.from({ length: 25 }, (_, k) => 0.02 + k * 0.04);
  const platform = [2, 6, 9.5, 16, 22].map((D) => profile({ kind: 'platform', D, face: 5.25, heights },
    heights.map((h) => [-12 + D, 5.25 + h]), budgets, () => 1));
  let band = bandPoints;
  for (const p of platform) {
    p.values['48'] = p.values['48'].map((v, k) => {
      if (k >= 3 || band === 0) return v;
      band--;
      return lit(0.4);
    });
  }
  const diagonal = [2, 6, 9.5, 16, 22].map((D) => profile({ kind: 'diagonal', D, face: 5.25, heights, rotation: (-20 * Math.PI) / 180 },
    heights.map((h) => [-12 + D, 5.25 + h]), budgets, (_, s) => (s === 48 ? 1 - diagonalError : 1)));
  return {
    task: 'penumbra', kind: 'profiles', label: 'test', angle, patched: true, ref: 1024, budgets,
    ambient: AMBIENT, sun: { color: SUN, energy: 1, range: 100 }, profiles: [...wall, ...platform, ...diagonal],
  };
}

test('summarizePenumbra: per angle the w10-90 slope against 0.8·angle·d, the errors at 48 steps, the platform band; 0.02 confirmed', () => {
  const bench = { results: [penumbraEntry(0.01), penumbraEntry(0.02, { bandPoints: 4 }), penumbraEntry(0.04)] };
  const s = summarizePenumbra(bench);
  assert.equal(s.angles.length, 3);
  const a = s.angles[1];
  assert.equal(a.angle, 0.02);
  assert.deepEqual(a.wall.widths.map((w) => w.d), [2, 12, 26]);
  // The fixture's ramp rises from y = -1 over 0.02·d. Its 10 % and 90 %
  // crossings, interpolated between samples 0.05 apart, by hand: at d = 12 the
  // 90 % one falls in [-0.80, -0.75], the interval that holds the ramp's top
  // (-0.76), so it is -0.78, not -0.784, and w10-90 is 0.196 (against
  // 0.8·0.24 = 0.192); at d = 26 both fall inside the ramp: 0.416 = 0.8·0.52.
  const want = { 12: 0.196, 26: 0.416 };
  for (const w of a.wall.widths.filter((x) => x.d !== 2)) {
    close(w.ratio, 1, 0.1, `d = ${w.d}: w10-90 / (0.8·angle·d)`);
    close(w.w48, want[w.d], 1e-9, `d = ${w.d}: w10-90`);
    close(w.slope, want[w.d] / w.d, 1e-9, `d = ${w.d}: slope = w10-90 / d`);
  }
  close(a.wall.max, 0, 1e-12, 'wall error');
  close(a.diagonal.max, 0, 1e-12, 'diagonal error');
  assert.equal(a.platform.points, 125);
  assert.equal(a.platform.above01, 4);
  close(a.platform.max, 0.6, 1e-12, 'platform error');
  close(a.platform.bandTop, 0.10, 1e-12, 'the band reaches the third height (0.02, 0.06, 0.10)');
  assert.equal(a.passesRule, true);
  assert.match(s.angleVerdict, /^0\.02 rad confirmed/);
});

test('summarizePenumbra: 0.02 failing while another angle passes takes the fallback of sub-decision 1; a slope failing everywhere is a defect', () => {
  const fallback = summarizePenumbra({ results: [penumbraEntry(0.01), penumbraEntry(0.02, { diagonalError: 0.2 })] });
  assert.equal(fallback.angles[1].passesRule, false);
  close(fallback.angles[1].diagonal.max, 0.2, 1e-9, 'diagonal error');
  assert.match(fallback.angleVerdict, /^0\.02 rad not confirmed; 0\.01 rad pass/);
  assert.match(fallback.angleVerdict, /SUN_ANGLE/);

  const wide = summarizePenumbra({ results: [penumbraEntry(0.02, { widthScale: 3 }), penumbraEntry(0.04, { widthScale: 3 })] });
  assert.equal(wide.angles.every((x) => !x.slopeOk), true);
  assert.match(wide.angleVerdict, /slope fails at every angle/);

  const wallLeak = summarizePenumbra({ results: [penumbraEntry(0.02, { wallError: 0.1 })] });
  close(wallLeak.angles[0].wall.max, 0.1, 1e-9, 'wall error');
  assert.equal(wallLeak.angles[0].passesRule, false);
});

test('summarizePenumbra: the convergence of the reference, and the grids per sun at every budget against it', () => {
  const conv = penumbraEntry(0.02);
  conv.kind = 'convergence';
  conv.budgets = [1024, 2048];
  for (const p of conv.profiles) p.values = { 1024: p.values['1024'], 2048: p.values['1024'].map((v) => [...v]) };
  conv.ref = 1024;
  conv.conv = 2048;

  const n = 2000;
  const ref = Array.from({ length: n }, () => lit(1));
  const at48 = ref.map((v, k) => (k < 4 ? lit(0.4) : v));   // 4 of 2000 = 0.2 % off by 0.6 sun
  const at96 = ref.map((v, k) => (k < 1 ? lit(0.95) : v));  // 0.05 sun: none above 0.1
  const encoded = (values) => ({ encoding: 'f32-rgba-base64', count: values.length, data: Buffer.from(new Float32Array(values.flat()).buffer).toString('base64') });
  // Read while a sun marched shadowSteps: its budgets are the sun's (x1).
  const grid = {
    task: 'penumbra', kind: 'grid', label: 'test', angle: 0.02, patched: false, sunStepMultiplier: 1, ref: 1024, conv: 2048,
    budgets: [48, 96, 192, 1024, 2048], gridSize: [50, 40], ambient: AMBIENT, sun: { color: SUN, energy: 1, range: 100 },
    suns: [
      { name: 'rotation(0)', rotation: 0, grids: { 48: ref, 96: ref, 192: ref, 1024: ref, 2048: ref } },
      { name: 'rotation(-PI/2)', rotation: -Math.PI / 2, grids: { 48: encoded(at48), 96: at96, 192: ref, 1024: ref, 2048: ref.map((v, k) => (k === 7 ? lit(0.98) : v)) } },
    ],
  };
  const s = summarizePenumbra({ results: [conv, grid] });
  assert.equal(s.convergence.length, 1);
  assert.equal(s.convergence[0].ok, true);
  close(s.convergence[0].max, 0, 1e-12, 'profiles 1024 vs 2048');

  const g = s.grids[0];
  const down = g.suns[1];
  assert.deepEqual(down.budgets.map((b) => b.steps), [48, 96, 192]);
  assert.equal(down.budgets[0].above01, 4);
  close(down.budgets[0].fracAbove01, 0.002, 1e-12, 'fraction at 48 steps');
  close(down.budgets[0].max, 0.6, 1e-6, 'max at 48 steps');
  assert.equal(down.budgets[0].darker, 4);
  assert.equal(down.budgets[1].above01, 0);
  close(down.budgets[1].max, 0.05, 1e-6, 'max at 96 steps');
  // One point 0.02 sun off between the reference and its check: 1024 is not converged there.
  assert.equal(down.convergence.ok, false);
  assert.equal(down.convergence.above001, 1);
  assert.equal(g.suns[0].convergence.ok, true);
  assert.equal(s.subDecision2.confirmsModel, true);
  assert.match(s.subDecision2.verdict, /confirms the model/);

  grid.suns[1].grids['48'] = ref;
  const contradicted = summarizePenumbra({ results: [grid] });
  assert.equal(contradicted.subDecision2.confirmsModel, false);
  assert.match(contradicted.subDecision2.verdict, /ask sub-decision 2 again/);
});

/** A `penumbra` grid of 2000 points at rotation(-PI/2): `off` of them 0.6 sun darker at 48, the rest exact. */
function gridEntry(fields = {}, off = 4) {
  const ref = Array.from({ length: 2000 }, () => lit(1));
  return {
    task: 'penumbra', kind: 'grid', label: 'test', angle: 0.02, patched: false, shader: '0badc0de', ref: 1024, conv: 2048,
    budgets: [48, 96, 1024, 2048], gridSize: [50, 40], ambient: AMBIENT, sun: { color: SUN, energy: 1, range: 100 },
    suns: [{ name: 'rotation(-PI/2)', rotation: -Math.PI / 2, grids: { 48: ref.map((v, k) => (k < off ? lit(0.4) : v)), 96: ref, 1024: ref, 2048: ref } }],
    ...fields,
  };
}

test("summarizePenumbra: a grid's sun steps are its budgets times the sun's step multiplier the bench recorded, and sub-decision 2 is judged on a x1 grid only", () => {
  // x1 (the shader of before 7e7be7d): the budgets are the sun's own.
  const x1 = summarizePenumbra({ results: [gridEntry({ sunStepMultiplier: 1 })] });
  assert.equal(x1.grids[0].sunStepMultiplier, 1);
  assert.deepEqual(x1.grids[0].suns[0].budgets.map((b) => [b.steps, b.sunSteps]), [[48, 48], [96, 96]]);
  assert.equal(x1.subDecision2.sunSteps, 48);
  assert.equal(x1.subDecision2.confirmsModel, true);
  assert.match(x1.subDecision2.verdict, /^the GPU confirms the model/);
  const clean = summarizePenumbra({ results: [gridEntry({ sunStepMultiplier: 1 }, 0)] });
  assert.equal(clean.subDecision2.confirmsModel, false);
  assert.match(clean.subDecision2.verdict, /ask sub-decision 2 again/);
  // x4 (HEAD's sunShadow): the grid's 48 is the sun's 192, never the 48 the decision was taken on.
  for (const off of [0, 4]) {
    const x4 = summarizePenumbra({ results: [gridEntry({ sunStepMultiplier: 4 }, off)] });
    assert.deepEqual(x4.grids[0].suns[0].budgets.map((b) => [b.steps, b.sunSteps]), [[48, 192], [96, 384]]);
    assert.equal(x4.subDecision2.sunSteps, 192);
    assert.equal(x4.subDecision2.confirmsModel, null);
    assert.match(x4.subDecision2.verdict, /^not applicable: grid read with the x4 sun budget/);
  }
  // No record, and a shader the stats do not know: no verdict on the model at all.
  const unknown = summarizePenumbra({ results: [gridEntry({}, 0)] });
  assert.equal(unknown.grids[0].sunStepMultiplier, null);
  assert.equal(unknown.grids[0].suns[0].budgets[0].sunSteps, null);
  assert.equal(unknown.subDecision2.confirmsModel, null);
  assert.match(unknown.subDecision2.verdict, /^unknown multiplier/);
  assert.doesNotMatch(unknown.subDecision2.verdict, /contradicts|ask sub-decision 2 again/);
  assert.throws(() => summarizePenumbra({ results: [gridEntry({ sunStepMultiplier: 0 })] }), /sunStepMultiplier must be a whole number >= 1/);
});

test('the committed evidence: penumbra-ab-m2.json, a x1 grid by its shader, confirms the model; grid-x4-m2.json records no multiplier, and never contradicts it', () => {
  // Review wf_cf354af4-c53 [10]: grid-x4-m2.json, read with the x4 shader,
  // printed "the GPU contradicts the model ... stop and ask sub-decision 2 again".
  const evidence = (name) => summarizePenumbra(JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')));
  const ab = evidence('penumbra-ab-m2.json');
  assert.equal(ab.grids[0].shader, '8e68370e');
  assert.equal(ab.grids[0].sunStepMultiplier, 1);
  assert.equal(ab.subDecision2.confirmsModel, true);
  assert.match(ab.subDecision2.verdict, /^the GPU confirms the model at rotation\(-PI\/2\), 48 steps: 0\.86% /);
  const x4 = evidence('grid-x4-m2.json');
  assert.equal(x4.grids[0].sunStepMultiplier, null);
  assert.equal(x4.subDecision2.confirmsModel, null);
  assert.match(x4.subDecision2.verdict, /^unknown multiplier/);
  assert.doesNotMatch(x4.subDecision2.verdict, /contradicts|ask sub-decision 2 again/);
});

test("the bench's sunStepMultiplier: the N of `Nu * u.shadowSteps` in sunShadow's return line, 1 where it hands shadow() no step count", () => {
  const multiplier = benchFunction('sunStepMultiplier');
  const head = readFileSync(SHADER, 'utf8');
  assert.equal(multiplier(head), 4);  // sub-decision 2 (b)
  const line = 'return shadow(origin, ray.xy, travel, u.sourceFraction, ray.z, 4u * u.shadowSteps);';
  assert.equal(head.split(line).length, 2, "sunShadow's return line, once");
  const returning = (args) => head.replace(line, `return shadow(${args});`);
  // Before 7e7be7d the march read u.shadowSteps itself: a sun marched shadowSteps.
  assert.equal(multiplier(returning('origin, ray.xy, travel, u.sourceFraction, ray.z')), 1);
  assert.equal(multiplier(returning('origin, ray.xy, travel, u.sourceFraction, ray.z, u.shadowSteps')), 1);
  assert.equal(multiplier(returning('origin, ray.xy, travel, 0.01, ray.z, 8u * u.shadowSteps')), 8);
  assert.throws(() => multiplier(returning('origin, ray.xy, travel, u.sourceFraction, ray.z, u.shadowSteps * 4u')), /update the bench/);
  assert.throws(() => multiplier(head.replace('fn sunShadow(', 'fn sunShadowElsewhere(')), /update the bench/);
});

test("LEGACY_SUN_STEP_MULTIPLIERS: 8e68370e is the bench's fnv1a of f61654d's light-accum.wgsl, whose sunShadow the bench reads as x1", (t) => {
  // penumbra-ab-m2.json predates the bench's sunStepMultiplier: its shader
  // says what its grid's budgets were. Needs the history (a shallow clone skips).
  const git = spawnSync('git', ['show', 'f61654d:ts/src/shaders/light-accum.wgsl'],
    { cwd: fileURLToPath(new URL('../../../../', import.meta.url)), encoding: 'utf8' });
  if (git.status !== 0) {
    t.skip(`git show f61654d failed: ${String(git.stderr ?? git.error).trim()}`);
    return;
  }
  assert.deepEqual({ ...LEGACY_SUN_STEP_MULTIPLIERS }, { '8e68370e': 1 });
  assert.equal(benchFunction('fnv1a')(git.stdout), '8e68370e');
  assert.equal(benchFunction('sunStepMultiplier')(git.stdout), 1);
});

test('summarizeRegress: the old and the new light buffer, point by point, on rgba16float values', () => {
  // Q = 1065·2^-12 (0.260009765625) and its upper fp16 neighbour, one step (2^-12) away.
  const Q = half(1065 * 2 ** -12);
  const grid = [[Q, 0.25, 0.5, 1], [0.9375, 0.875, 0.75, 1]].map((p) => p.map(half));
  const at = (x) => [[x, 0.25, 0.5, 1], grid[1]];
  const s = summarizeRegress({ results: [
    { task: 'regress', label: 'same', old: grid, new: grid.map((v) => [...v]) },
    { task: 'regress', label: 'one fp16 step', old: grid, new: at(half(Q + 2 ** -12)) },
    // The gate at a power of two: 0.5 - 2^-11 is two fp16 steps below 0.5.
    { task: 'regress', label: 'two fp16 steps below 0.5', old: at(0.5), new: at(half(0.5 - 2 ** -11)) },
    { task: 'regress', label: 'off', old: grid, new: at(half(0.3125)) },
    { task: 'scene' },
  ] });
  const beyond = '1 of 2 points beyond 1 fp16 ULP: investigate before going on';
  assert.deepEqual(s.map((r) => r.verdict), ['identical', 'within 1 fp16 ULP', beyond, beyond]);
  assert.deepEqual(s.map((r) => r.ok), [true, true, false, false]);
});

test('summarizeEdgepop: per range the pop of W_in\'s shadow, where it ends, and the step-6 rule (W_out and E lit like the open row)', () => {
  const ds = [0.5, 1, 1.5, 2, 2.5, 3];
  const row = (range, inn) => ({ range, out: ds.map(() => lit(1)), inn: inn.map(lit), ref: ds.map(() => lit(1)), e: lit(1) });
  // The march reading past the SDF: E, beside W_in at d = 1, darker than the open row there.
  const pastSdf = { ...row(30, [0, 0, 0, 0, 0, 0]), e: lit(0.2) };
  pastSdf.ref[0] = lit(0.2);  // the open row at d = 0.5 is not E's reference
  const s = summarizeEdgepop({ results: [{
    task: 'edgepop', label: 'test', W: 3.5, ds, sun: { color: SUN, energy: 1 }, zoom: 1, canvas: [1920, 1080], lightBuffer: [960, 540],
    rows: [row(100, [0, 0, 0, 0, 0, 0]), row(2, [0, 0, 0.5, 0.95, 1, 1]), pastSdf],
  }] });
  const [far, short, past] = s[0].ranges;
  close(far.maxPop, 1, 1e-12, 'pop at range 100: the whole sun');
  assert.equal(far.fracAbove01, 1);
  assert.equal(far.bandEnd, 3);
  assert.equal(far.outVsRef, 0);
  assert.equal(far.eVsRef, 0);
  assert.equal(short.bandEnd, 1.5);
  close(short.fracAbove01, 3 / 6, 1e-12, 'share of the width');
  assert.equal(short.dFar, 3);
  close(past.eVsRef, -0.8, 1e-9, 'E against the open row at d = 1');
  close(past.outVsRef, 0.8, 1e-9, 'W_out\'s row against the open row');
});

test('summarizeCost: the ABBA effect and its t interval per pair, the spans ON and OFF, and set minus march', () => {
  const blocks = (effect) => Array.from({ length: 8 }, (_, b) => ({ block: b, on1: 10 + effect + b * 0.01, off1: 10, off2: 10.02, on2: 10.02 + effect }));
  const window = (condition, valid) => ({ condition, valid, reasons: valid ? [] : ['3 frames discarded'] });
  const s = summarizeCost({ results: [
    { task: 'cost', pair: 'march', label: 'test', outsideCriterion: false, blocks: blocks(0.3), windows: [window('on', false), ...Array(32).fill(window('on', true))], redos: 1, stopped: null },
    { task: 'cost', pair: 'set', label: 'test', outsideCriterion: false, blocks: blocks(1.1), windows: [], redos: 0, stopped: null },
    { task: 'cost', pair: 'uber', label: 'test', outsideCriterion: true, n: 10000, quadPx: 2, blocks: blocks(0), windows: [], redos: 0, stopped: null },
  ] });
  const [march, set, uber] = s.pairs;
  assert.equal(march.n, 8);
  assert.equal(march.dof, 7);
  assert.equal(march.invalidWindows, 1);
  assert.deepEqual(march.invalid[0].reasons, ['3 frames discarded']);
  // Each effect is (on1 + on2 - off1 - off2) / 2 = effect + b·0.005.
  close(march.mean, 0.3 + 0.005 * 3.5, 1e-9, 'march mean');
  close(set.mean - march.mean, 0.8, 1e-9, 'set minus march');
  close(s.context.setMinusMarch, 0.8, 1e-9, 'P2 - P1');
  assert.match(march.verdict, /^0\.\d{3} ± 0\.\d{3} ms \(95% CI/);
  assert.equal(uber.quadPx, 2);
  assert.equal(uber.outsideCriterion, true);
  close(march.spanOff, 10.01, 1e-9, 'mean OFF span');
});

// ── The command line ───────────────────────────────────────────────────────

test('CLI: `regress <file>` prints the summary as JSON, `details` compares the step-3 checks, both exit 1 out of tolerance, bad usage exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step6-stats-'));
  try {
    const regressFile = join(dir, 'regress.json');
    writeFileSync(regressFile, JSON.stringify({ format: 'hyperion-step6-bench/1', results: [{ task: 'regress', old: [lit(0.5)], new: [lit(0.5)] }] }));
    const run = spawnSync(process.execPath, [SCRIPT, 'regress', regressFile], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout)[0].verdict, 'identical');
    writeFileSync(regressFile, JSON.stringify({ format: 'hyperion-step6-bench/1', results: [{ task: 'regress', old: [lit(0.5)], new: [lit(0.6)] }] }));
    const off = spawnSync(process.execPath, [SCRIPT, 'regress', regressFile], { encoding: 'utf8' });
    assert.equal(off.status, 1);
    assert.equal(JSON.parse(off.stdout)[0].ok, false);

    const harnessFile = join(dir, 'harness.json');
    const statusesFile = join(dir, 'statuses.json');
    const checks = [
      { name: 'Lit vs unlit', status: 'pass', detail: 'lit 0.489, 0.101' },
      { name: 'Layer shadow on screen', status: 'pass', detail: 'blue: in the band 0.295, mirrored point 1.098' },
      { name: 'Light layers', status: 'pass', detail: '2 groups, 2 SDF sets' },
    ];
    writeFileSync(harnessFile, JSON.stringify({ format: 'hyperion-step6-harness/1', lighting: checks }));
    writeFileSync(statusesFile, JSON.stringify({ format: 'hyperion-5b-statuses/1', tabs: { lighting: { checks } } }));
    const details = spawnSync(process.execPath, [SCRIPT, 'details', harnessFile, statusesFile], { encoding: 'utf8' });
    assert.equal(details.status, 0, details.stderr);
    const out = JSON.parse(details.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.checks.length, 3);
    writeFileSync(harnessFile, JSON.stringify({ format: 'hyperion-step6-harness/1', lighting: [{ ...checks[0], detail: 'lit 0.492, 0.101' }, checks[1], checks[2]] }));
    const moved = spawnSync(process.execPath, [SCRIPT, 'details', harnessFile, statusesFile], { encoding: 'utf8' });
    assert.equal(moved.status, 1);
    assert.equal(JSON.parse(moved.stdout).checks[0].ok, false);

    const usage = spawnSync(process.execPath, [SCRIPT, 'nonsense'], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: run through a symlink, the gate still runs and still fails out of tolerance (never a silent exit 0)', () => {
  // node runs the script under its real path (import.meta.url), while
  // process.argv[1] keeps the symlink's.
  const dir = mkdtempSync(join(tmpdir(), 'step6-stats-link-'));
  try {
    const link = join(dir, 'step6-stats-link.mjs');
    symlinkSync(SCRIPT, link);
    const regressFile = join(dir, 'regress.json');
    writeFileSync(regressFile, JSON.stringify({ format: 'hyperion-step6-bench/1', results: [{ task: 'regress', old: [lit(0.5)], new: [lit(0.6)] }] }));
    const off = spawnSync(process.execPath, [link, 'regress', regressFile], { encoding: 'utf8' });
    assert.equal(off.status, 1, `exit ${off.status}, stdout ${JSON.stringify(off.stdout)}, stderr ${JSON.stringify(off.stderr)}`);
    assert.equal(JSON.parse(off.stdout)[0].ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
