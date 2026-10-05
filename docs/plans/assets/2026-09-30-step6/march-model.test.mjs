// docs/plans/assets/2026-09-30-step6/march-model.test.mjs
// Run: node --test docs/plans/assets/2026-09-30-step6/march-model.test.mjs
//
// The numbers the step-6 plan (docs/plans/2026-09-30-step6-directional-shadows-plan.md)
// quotes from the CPU model of the march: the geometry of the Lighting tab's sun
// checks (Task 5), the predictions of the GPU A/B (Task 6), risk 1 and
// sub-decision 2 (the x4 sun budget, 192 steps). Counts exactly, values within
// 0.005: the plan prints them to two or three decimals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FADE_START, makeCamera, buildSdf, shadow, sunShadowAt, sunGrid } from './march-model.mjs';

const TOL = 0.005;

function near(actual, want, what) {
  assert.ok(Math.abs(actual - want) <= TOL, `${what}: ${actual} is not within ${TOL} of ${want}`);
}

/** A caster `w` x `h` world units centred on (x, y), turned by `rot` radians. */
const rect = (x, y, w, h, rot = 0) => ({ x, y, hx: w / 2, hy: h / 2, rot });

/** u.sourceFraction: the sun's penumbra angle, in radians. */
const ANGLE = 0.02;
/** The harness's shadowSteps. */
const STEPS = 48;
/**
 * The sun's march budget in the harness: light-accum.wgsl sunShadow marches
 * 4u * u.shadowSteps (sub-decision 2 (b)), 4 x the harness's 48.
 */
const SUN_STEPS = 4 * STEPS;

test('the camera: 20 world units tall at zoom 1, on the half-resolution light buffer, y flipped like toScreenUV', () => {
  const cam = makeCamera(0, 200);
  assert.deepEqual([cam.w, cam.h, cam.texPerUnit], [960, 540, 27]);
  near(cam.xL, -160 / 9, 'xL (17.78 units each side at 16:9)');
  assert.deepEqual(cam.toTexel(0, 200), [480, 270]);
  assert.deepEqual(cam.toTexel(cam.xL, 210), [0, 0]); // the top-left texel: the texture's y runs down
  // The M4 window (1200x689 CSS at dpr 2): halfResolution of the canvas.
  const m4 = makeCamera(0, 0, 2400, 1378);
  assert.deepEqual([m4.w, m4.h], [1200, 689]);
  near(m4.texPerUnit, 34.45, 'texels per unit in the M4 window');
});

test('FADE_START is the shader constant SUN_FADE_START', () => {
  assert.equal(FADE_START, 0.75);
  const wgsl = readFileSync(new URL('../../../../ts/src/shaders/light-accum.wgsl', import.meta.url), 'utf8');
  const constant = /const SUN_FADE_START: f32 = ([0-9.]+);/.exec(wgsl);
  assert.ok(constant, 'SUN_FADE_START is declared in light-accum.wgsl');
  assert.equal(Number(constant[1]), FADE_START);
});

test("SUN_STEPS is the shader's rule: sunShadow marches 4u * u.shadowSteps, 192 at the harness's 48", () => {
  assert.equal(SUN_STEPS, 192);
  const wgsl = readFileSync(new URL('../../../../ts/src/shaders/light-accum.wgsl', import.meta.url), 'utf8');
  const rule = /return shadow\(origin, ray\.xy, travel, u\.sourceFraction, ray\.z, (\d+)u \* u\.shadowSteps\);/.exec(wgsl);
  assert.ok(rule, 'sunShadow hands shadow() a multiple of u.shadowSteps');
  assert.equal(Number(rule[1]) * STEPS, SUN_STEPS);
});

// ── Task 5: the Lighting tab's sub-scene, centred on C = (0, 200) ──────────
// Wall A (0.5 x 2.4, thin along the sun), the sun at rotation(-PI/6), range 100.

const C = [0, 200];
const SUN = -Math.PI / 6;
const WALL_A = rect(C[0], C[1], 0.5, 2.4, SUN);
const DIR = [Math.cos(SUN), Math.sin(SUN)];

test("check 1: behind wall A S is dark and U, Ry, Rx are lit, at 48 steps and at the sun's 192; each sign mutant darkens only its own point", () => {
  const cam = makeCamera(...C);
  const sdf = buildSdf(cam, [WALL_A]);
  const at = (a, b) => [C[0] + 2.5 * a, C[1] + 2.5 * b];
  const points = { S: at(DIR[0], DIR[1]), U: at(-DIR[0], -DIR[1]), Ry: at(0.866, 0.5), Rx: at(-0.866, -0.5) };
  // A mutant is a sun whose texel ray toward the light is wrong in one way:
  // reversed (theta + PI), its y negated (-theta) or its x negated (PI - theta).
  const cases = [
    ['the sun', SUN, { S: 0, U: 1, Ry: 1, Rx: 1 }],
    ['a reversed march', SUN + Math.PI, { S: 1, U: 0, Ry: 1, Rx: 1 }],
    ['a y of the wrong sign', -SUN, { S: 1, U: 1, Ry: 0, Rx: 1 }],
    ['an x of the wrong sign', Math.PI - SUN, { S: 1, U: 1, Ry: 1, Rx: 0 }],
  ];
  for (const steps of [STEPS, SUN_STEPS]) {
    for (const [what, theta, want] of cases) {
      for (const [k, [x, y]] of Object.entries(points)) {
        near(sunShadowAt(cam, sdf, x, y, theta, 100, ANGLE, steps), want[k], `${what}, ${k}, ${steps} steps`);
      }
    }
  }
});

test("check 2 (range 6): full strength for three quarters of the length, faded out by its end, at 48 steps and at the sun's 192", () => {
  const cam = makeCamera(...C);
  const sdf = buildSdf(cam, [WALL_A]);
  // Distances past wall A's far face, which is 0.25 from C along the sun.
  for (const steps of [STEPS, SUN_STEPS]) {
    for (const [d, want] of [[0.5, 0], [2, 0], [4, 0], [5.25, 0.503], [7.5, 1]]) {
      const s = 0.25 + d;
      near(sunShadowAt(cam, sdf, C[0] + DIR[0] * s, C[1] + DIR[1] * s, SUN, 6, ANGLE, steps), want, `${d} past the face, ${steps} steps`);
    }
  }
});

test('check 3: a caster at the sun-side edge casts across the view only once on screen, and E needs the SDF exit (48 steps and the sun\'s 192)', () => {
  const cam = makeCamera(...C);
  const { xL } = cam;
  // W_out wholly off screen (right face 0.25 out), W_in 0.5 in; the sun at rotation(0).
  const sdf = buildSdf(cam, [WALL_A, rect(xL - 0.55, C[1] + 3, 0.6, 2), rect(xL + 0.2, C[1] + 8, 0.6, 2)]);
  const rows = { out: C[1] + 3, inn: C[1] + 8, ref: C[1] + 5.5 };
  const lastD = Math.floor(2 * cam.hw - 0.5);
  assert.equal(lastD, 35);
  const [ex, ey] = [xL + 1, C[1] + 6.6];
  for (const steps of [STEPS, SUN_STEPS]) {
    const at = (x, y, range) => sunShadowAt(cam, sdf, x, y, 0, range, ANGLE, steps);
    const pop = (d, range) => at(xL + d, rows.out, range) - at(xL + d, rows.inn, range);
    for (let d = 1; d <= lastD; d++) {
      near(pop(d, 100), 1, `pop at d = ${d}, range 100, ${steps} steps`);
      near(at(xL + d, rows.out, 100), at(xL + d, rows.ref, 100), `L_out against L_ref at d = ${d}, ${steps} steps`);
    }
    near(pop(8, 10), 1, `pop at d = 8, range 10, ${steps} steps`);
    near(pop(12, 10), 0, `pop at d = 12, range 10, ${steps} steps`);
    near(at(ex, ey, 100), 1, `E, marching to the SDF exit, ${steps} steps`);
  }
  // E, 0.4 below W_in: its ray leaves the SDF after one unit. Marched on to the
  // range instead, it reads the clamped edge column beside W_in until it runs
  // out of steps, and the out-of-steps rule darkens it. At the sun's 192 steps
  // the open row's ray at d = 1, which the tab's check compares E with, runs
  // out of steps too, but stays far lighter than E.
  const reach = 100 * cam.texPerUnit;
  const toRange = (x, y, steps) => {
    const [u, v] = cam.toTexel(x, y);
    return shadow(sdf, Math.floor(u) + 0.5, Math.floor(v) + 0.5, -1, 0, reach, ANGLE, reach, steps);
  };
  near(toRange(ex, ey, STEPS), 0.204, 'E, marching to the range, 48 steps');
  near(toRange(ex, ey, SUN_STEPS), 0.256, 'E, marching to the range, 192 steps');
  near(toRange(xL + 1, rows.ref, SUN_STEPS), 0.931, 'the open row at d = 1, marching to the range, 192 steps');
});

// ── Task 6: the `penumbra` scene, the sun at rotation(0) ───────────────────
// The wall's far face is x = -11.7 and its shadow band's upper edge y = -1;
// the platform's top face is y = 5.25 and its upwind end x = -12.

const PENUMBRA = [rect(-12, -4, 0.6, 6), rect(0, 5, 24, 0.5)];
const ANGLES = [0.01, 0.02, 0.04];
const DIAGONAL = (-20 * Math.PI) / 180;

/** The 10-90 % width of a profile that rises with y, interpolated linearly. */
function width1090(ys, values) {
  const crossing = (f) => {
    for (let i = 1; i < values.length; i++) {
      if (values[i - 1] < f && values[i] >= f) {
        return ys[i - 1] + ((f - values[i - 1]) / (values[i] - values[i - 1])) * (ys[i] - ys[i - 1]);
      }
    }
    return NaN;
  };
  return crossing(0.9) - crossing(0.1);
}

/** The largest |a - b| over the points, and how many exceed 0.1. */
function compare(a, b) {
  let max = 0;
  let over = 0;
  for (let k = 0; k < a.length; k++) {
    const e = Math.abs(a[k] - b[k]);
    max = Math.max(max, e);
    if (e > 0.1) over++;
  }
  return { max, over };
}

test('penumbra, wall: 48 steps match 1024, and w10-90 is 0.98-1.03 times 0.8·angle·d at d = 12 and 26', () => {
  const cam = makeCamera(0, 0);
  const sdf = buildSdf(cam, PENUMBRA);
  const ys = Array.from({ length: 41 }, (_, k) => -2 + k * 0.05);
  for (const angle of ANGLES) {
    for (const d of [2, 12, 26]) {
      const profile = (steps) => ys.map((y) => sunShadowAt(cam, sdf, -11.7 + d, y, 0, 100, angle, steps));
      const v48 = profile(48);
      near(compare(v48, profile(1024)).max, 0, `angle ${angle}, d = ${d}: max |48 - 1024|`);
      if (d === 2) continue;
      const ratio = width1090(ys, v48) / (0.8 * angle * d);
      assert.ok(ratio >= 0.98 - TOL && ratio <= 1.03 + TOL, `angle ${angle}, d = ${d}: w10-90 / (0.8·angle·d) = ${ratio}`);
    }
  }
});

test('penumbra, platform: the 125 reading points at 0.02 rad, and the diagonal sun', () => {
  const cam = makeCamera(0, 0);
  const sdf = buildSdf(cam, PENUMBRA);
  const points = [];
  for (const D of [2, 6, 9.5, 16, 22]) for (let k = 0; k < 25; k++) points.push([-12 + D, 5.25 + 0.02 + k * 0.04]);
  assert.equal(points.length, 125);
  const read = (theta, angle, steps) => points.map(([x, y]) => sunShadowAt(cam, sdf, x, y, theta, 100, angle, steps));
  const v48 = read(0, ANGLE, 48);
  const v1024 = read(0, ANGLE, 1024);
  const { max, over } = compare(v48, v1024);
  near(max, 0.69, 'max |48 - 1024|');
  assert.equal(over, 20);
  const highest = Math.max(...points.filter((_, k) => Math.abs(v48[k] - v1024[k]) > 0.1).map(([, y]) => y - 5.25));
  near(highest, 0.42, 'the highest of them above the face');
  for (const angle of ANGLES) {
    near(compare(read(DIAGONAL, angle, 48), read(DIAGONAL, angle, 1024)).max, 0, `the sun at -20 degrees, angle ${angle}`);
  }
});

test('penumbra, platform sampled densely (2205 points, against 2048 steps): the band at 48 steps, and at 96', () => {
  const cam = makeCamera(0, 0);
  const sdf = buildSdf(cam, PENUMBRA);
  const points = [];
  for (let m = 0; m <= 44; m++) for (let k = 1; k <= 49; k++) points.push([-12 + 1 + 0.5 * m, 5.25 + 0.02 * k]);
  assert.equal(points.length, 2205);
  const read = (angle, steps) => points.map(([x, y]) => sunShadowAt(cam, sdf, x, y, 0, 100, angle, steps));
  let highest = 0;
  for (const [angle, steps, over, max] of [[0.01, 48, 241, 0.60], [0.02, 48, 368, 0.69], [0.04, 48, 180, 0.34], [0.02, 96, 80, 0.27]]) {
    const values = read(angle, steps);
    const ref = read(angle, 2048);
    const c = compare(values, ref);
    assert.equal(c.over, over, `angle ${angle}, ${steps} steps: points off by more than 0.1`);
    near(c.max, max, `angle ${angle}, ${steps} steps: max`);
    if (steps === 48) {
      for (let k = 0; k < points.length; k++) {
        if (Math.abs(values[k] - ref[k]) > 0.1) highest = Math.max(highest, points[k][1] - 5.25);
      }
    }
  }
  near(highest, 0.48, 'the highest of them above the face (risk 1: "~0.5")');
});

// ── Task 6: the committed bench `scene`, its whole light buffer ────────────
// A 128x72 UV grid of cell centres, the sun only (the point light's shadow
// off): 9216 points, against 1024 steps.

const SCENE = [
  rect(-12, -1, 0.6, 5), rect(-2, -4, 0.6, 4), rect(9, 5, 0.6, 4),
  rect(-4, 6.5, 10, 0.5), rect(6, -6.5, 12, 0.5),
  rect(-8, -6, 1.5, 1.5), rect(13, -1, 1.5, 1.5),
];

test('the grid of `scene`: points off by more than 0.1 sun at 48, 96 and 192 steps (the x4 budget), and 1024 against 2048', () => {
  const cam = makeCamera(0, 0);
  const sdf = buildSdf(cam, SCENE);
  const suns = [
    ['rotation(0)', 0, [[48, 95, 1], [96, 53, 0.58], [192, 9, 0.27]]],
    ['rotation(-PI/2)', -Math.PI / 2, [[48, 77, 1], [96, 10, 0.22], [192, 0, 0]]],
    ['rotation(-PI/6)', -Math.PI / 6, [[48, 0, 0], [96, 0, 0], [192, 0, 0]]],
  ];
  for (const [name, theta, budgets] of suns) {
    const grid = (steps) => sunGrid(cam, sdf, theta, 100, ANGLE, steps);
    const ref = grid(1024);
    assert.equal(ref.length, 9216);
    for (const [steps, over, max] of budgets) {
      const c = compare(grid(steps), ref);
      assert.equal(c.over, over, `${name}, ${steps} steps: points off by more than 0.1`);
      near(c.max, max, `${name}, ${steps} steps: max`);
    }
    assert.equal(compare(ref, grid(2048)).over, 0, `${name}: 1024 against 2048`);
  }
});

test('the grid of `scene` at rotation(-PI/2), 48 steps: of the 75 free points off, 45 darker and 30 lighter (light leaking past)', () => {
  const cam = makeCamera(0, 0);
  const sdf = buildSdf(cam, SCENE);
  const g48 = sunGrid(cam, sdf, -Math.PI / 2, 100, ANGLE, 48);
  const ref = sunGrid(cam, sdf, -Math.PI / 2, 100, ANGLE, 1024);
  let darker = 0;
  let lighter = 0;
  for (let j = 0; j < 72; j++) {
    for (let i = 0; i < 128; i++) {
      const k = j * 128 + i;
      // The SDF at the grid point's texel: positive outside every caster.
      const free = sdf.dist[Math.floor(((j + 0.5) / 72) * cam.h) * cam.w + Math.floor(((i + 0.5) / 128) * cam.w)] > 0;
      if (!free || Math.abs(g48[k] - ref[k]) <= 0.1) continue;
      if (g48[k] < ref[k]) darker++;
      else lighter++;
    }
  }
  assert.deepEqual({ darker, lighter }, { darker: 45, lighter: 30 });
});
