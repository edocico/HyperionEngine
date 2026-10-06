// docs/plans/assets/2026-09-30-step6/march-model.test.mjs
// Run: node --test docs/plans/assets/2026-09-30-step6/march-model.test.mjs
//
// The numbers the step-6 plan (docs/plans/2026-09-30-step6-directional-shadows-plan.md)
// quotes from the CPU model of the march: the geometry of the Lighting tab's sun
// checks (Task 5), the predictions of the GPU A/B (Task 6), risk 1 and
// sub-decision 2 (the x4 sun budget, 192 steps); and, since the Task 9 fixes,
// the canvases on which the length check's window holds. Counts exactly,
// values within 0.005: the plan prints them to two or three decimals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FADE_START, makeCamera, fitViewCamera, buildSdf, shadow, sunShadowAt, sunGrid } from './march-model.mjs';

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
  // The M4 canvas, 1960x1248 (980x624 CSS at dpr 2, inside the 1200x689 CSS
  // window; docs/plans/assets/2026-09-29-mac-m2/README.md, M4): its light buffer
  // is halfResolution of the canvas, 31.2 texels per unit at zoom 1. (At the sun
  // sub-scene's fitView zoom, 0.89234, check 2's named canvases pin 27.841.)
  const m4 = makeCamera(0, 0, 1960, 1248);
  assert.deepEqual([m4.w, m4.h], [980, 624]);
  near(m4.texPerUnit, 31.2, 'texels per unit on the M4 canvas at zoom 1');
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

// Check 2 on the tab's own framing. Review of Task 9fix (Important 1): the
// sun's share 5.25 past the face moves with where the point falls in its
// texel and with the SDF's quantisation, both larger as the light buffer's
// texels per world unit fall. The tab frames the sub-scene with
// fitView(engine, 0, 200, SUB_HALF_WIDTH), which zooms out below an aspect of
// 1.76 (the view is then 2 x 17.6 units wide): there the density falls with
// the canvas' width, above it with its height. The tab judges the share
// against FADE_SHARE, which these tests read from its source. Its window is
// validated from 8 texels per unit up; below 8 it is not guaranteed in either
// direction. The sweeps below run on grids of canvases: the extremes they pin
// are the grids', and a finer sweep reaches a little past them (the model's
// bounds, rounded: correct code about 0.44 to 0.72 from 8 texels per unit up
// and 0.47 to 0.61 from 16 up, a range 0.5 off about 0.31 or less, or 0.87 or
// more).

/** The distances of check 2 past wall A's far face, and the one inside the fade. */
const LENGTH = [0.5, 2, 4, 5.25, 7.5];
const FADE_AT = 3;

/** The point `d` past wall A's far face, along the sun. */
const pastFace = (d) => [C[0] + DIR[0] * (0.25 + d), C[1] + DIR[1] * (0.25 + d)];

/** The sun's shadow factor `d` past wall A's far face, range `range`, at the sun's 192 steps. */
const alongSun = (cam, sdf, d, range) => sunShadowAt(cam, sdf, ...pastFace(d), SUN, range, ANGLE, SUN_STEPS);

/**
 * The centres of the texels a probe of (x, y) may read, as world points: the
 * texel under it or, when (x, y) lies on a texel's edge (to 1e-6 texel), the
 * texels on both sides of that edge. On an edge the GPU's f32 (debug-probe.ts
 * worldToUv, pixel-probe.wgsl texelAt) picks either side, and sunShadowAt's
 * f64 may pick the other: check 2's points lie on edges at some densities (5.25
 * past the face is 2.75 units below the centre, 22 texels at 8 per unit).
 */
function probeTexels(cam, x, y) {
  const [u, v] = cam.toTexel(x, y);
  const sides = (t, n) => {
    const k = Math.round(t);
    return Math.abs(t - k) < 1e-6 && k > 0 && k < n ? [k - 1, k] : [Math.min(Math.floor(t), n - 1)];
  };
  return sides(u, cam.w).flatMap((i) => sides(v, cam.h).map((j) => [
    cam.cx + ((i + 0.5) / cam.w - 0.5) * 2 * cam.hw,
    cam.cy - ((j + 0.5) / cam.h - 0.5) * 2 * cam.hh,
  ]));
}

/** alongSun at every texel a probe of that point may read. */
const probedAlongSun = (cam, sdf, d, range) => probeTexels(cam, ...pastFace(d)).map(([x, y]) => sunShadowAt(cam, sdf, x, y, SUN, range, ANGLE, SUN_STEPS));

/** The tab's framing and window, from lighting-directional.ts: fitView's half width and FADE_SHARE. */
function tabCheck2() {
  const tab = readFileSync(new URL('../../../../ts/src/demo/lighting-directional.ts', import.meta.url), 'utf8');
  const halfWidth = /const SUB_HALF_WIDTH = ([0-9.]+);/.exec(tab);
  const share = /const FADE_SHARE: readonly \[number, number\] = \[([0-9.]+), ([0-9.]+)\];/.exec(tab);
  assert.ok(halfWidth && share, 'SUB_HALF_WIDTH and FADE_SHARE are declared in lighting-directional.ts');
  return { halfWidth: Number(halfWidth[1]), lo: Number(share[1]), hi: Number(share[2]) };
}

/** Canvases `h0` to `h1` px tall in steps of `dh`, at aspects `a0` to `a1` tenths in steps of `da`: [width, height]. */
function canvasGrid(h0, h1, dh, a0, a1, da) {
  const out = [];
  for (let h = h0; h <= h1; h += dh) for (let a = a0; a <= a1; a += da) out.push([Math.round((h * a) / 10), h]);
  return out;
}

/**
 * Check 2 on the `canvases` whose light buffer has `minTpu` to `maxTpu`
 * (excluded) texels per unit, read at every texel a probe may read: dark 0.5,
 * 2 and 4 past the face, lit at 7.5, the share at 5.25 in FADE_SHARE, and a
 * reach halved or doubled, or a range 0.5 off, outside it. Returns the counts
 * and, for the extremes, the value and its canvas.
 */
function sweepCheck2(canvases, minTpu, maxTpu) {
  const { halfWidth, lo, hi } = tabCheck2();
  const s = { canvases: 0, onEdge: 0, above: 0, low: [Infinity], high: [-Infinity], shortest: [Infinity], longest: [-Infinity] };
  for (const [w, h] of canvases) {
    const cam = fitViewCamera(C[0], C[1], w, h, halfWidth);
    if (cam.texPerUnit < minTpu || cam.texPerUnit >= maxTpu) continue;
    s.canvases++;
    const sdf = buildSdf(cam, [WALL_A]);
    const what = `${w}x${h} (${cam.texPerUnit.toFixed(2)} texels per unit)`;
    const f = LENGTH.map((d) => probedAlongSun(cam, sdf, d, 6));
    // The verdict's other rules: dark near the face, lit past the range.
    for (const k of [0, 1, 2]) for (const v of f[k]) near(v, 0, `${what}: ${LENGTH[k]} past the face`);
    for (const v of f[4]) near(v, 1, `${what}: ${LENGTH[4]} past the face`);
    const shares = f[FADE_AT];
    if (shares.length > 1) s.onEdge++;
    if (shares.some((v) => v > 0.6)) s.above++;
    for (const v of shares) {
      assert.ok(v >= lo && v <= hi, `${what}: the share ${v} lies outside FADE_SHARE [${lo}, ${hi}]`);
      if (v < s.low[0]) s.low = [v, `${w}x${h}`];
      if (v > s.high[0]) s.high = [v, `${w}x${h}`];
    }
    // A reach halved (directionalRay's `* 0.25 * size`) or doubled (`size` without its 0.5).
    for (const v of probedAlongSun(cam, sdf, 5.25, 3)) near(v, 1, `${what}: a halved reach`);
    for (const v of probedAlongSun(cam, sdf, 5.25, 12)) near(v, 0, `${what}: a doubled reach`);
    for (const v of probedAlongSun(cam, sdf, 5.25, 5.5)) {
      assert.ok(v > hi, `${what}: range 5.5 gives ${v}, inside FADE_SHARE [${lo}, ${hi}]`);
      if (v < s.shortest[0]) s.shortest = [v, `${w}x${h}`];
    }
    for (const v of probedAlongSun(cam, sdf, 5.25, 6.5)) {
      assert.ok(v < lo, `${what}: range 6.5 gives ${v}, inside FADE_SHARE [${lo}, ${hi}]`);
      if (v > s.longest[0]) s.longest = [v, `${w}x${h}`];
    }
  }
  return s;
}

test("fitViewCamera is the harness's fitView: the facade's view 20 units tall at zoom 1, centred, zoomed out, never in, to fit the half width, through CameraAPI.zoom", () => {
  // The code fitViewCamera reproduces: if it changes, the model must too.
  const read = (path) => readFileSync(new URL(`../../../../ts/src/${path}`, import.meta.url), 'utf8');
  const resize = read('hyperion.ts');
  assert.match(resize, /const aspect = width \/ height;\s*this\.cameraApi\.setOrthographic\(20 \* aspect, 20\);/);
  assert.match(read('camera-api.ts'), /zoom\(level: number\): void \{\s*this\._zoom = Math\.max\(0\.01, level\);/);
  const fit = /export function fitView\(engine: Hyperion, cx: number, cy: number, halfWidth: number\): void \{([^}]*)\}/.exec(read('demo/probe-checks.ts'));
  assert.ok(fit, 'fitView is declared in probe-checks.ts');
  assert.equal(
    fit[1].replace(/\s+/g, ' ').trim(),
    'engine.cam.position(cx, cy, 0); engine.cam.zoom(1); const visibleHalfWidth = 1 / engine.cam.viewProjection[0]; engine.cam.zoom(Math.min(1, visibleHalfWidth / halfWidth));',
  );
  // 1 / viewProjection[0] at zoom 1 is the half width of a view 20 · aspect
  // wide. [canvas, half width, zoom, the half width shown]
  for (const [w, h, half, zoom, shown] of [
    [1920, 1080, 17.6, 1, 160 / 9], // the view already fits
    [800, 600, 17.6, 40 / 3 / 17.6, 17.6], // zoomed out until it fits
    [1000, 1000, 2, 1, 10], // never zoomed in
    [10, 1000, 17.6, 0.01, 10], // CameraAPI.zoom's floor
  ]) {
    const cam = fitViewCamera(5, -3, w, h, half);
    const what = `${w}x${h}, half width ${half}`;
    assert.ok(Math.abs(cam.zoom - zoom) < 1e-12, `${what}: zoom ${cam.zoom}, not ${zoom}`);
    assert.deepEqual([cam.cx, cam.cy], [5, -3], `${what}: centred`);
    assert.ok(Math.abs(cam.hh - 10 / zoom) < 1e-9 && Math.abs(cam.xR - cam.cx - shown) < 1e-9, `${what}: the view's half height ${cam.hh} and width ${cam.xR - cam.cx}`);
  }
});

test("check 2 on the tab's framing (fitView), the sun's 192 steps: at named canvases the share 5.25 past the face lies in FADE_SHARE, and a reach halved or doubled, or a range 0.5 off, does not", () => {
  const { halfWidth, lo, hi } = tabCheck2();
  assert.equal(halfWidth, 17.6);
  // [canvas, fitView's zoom, texels per unit, the share 5.25 past the face]
  const cases = [
    [1920, 1080, 1, 27, 0.503], // makeCamera's default
    [1960, 1248, 0.8923, 27.841, 0.499], // the M2's GPU run (round step 6, Task 5): it read 0.508
    [999, 999, 0.5682, 14.176, 0.607],
    [800, 600, 0.7576, 11.364, 0.635],
    [700, 500, 0.7955, 9.943, 0.627],
    [588, 420, 0.7955, 8.352, 0.448], // the lowest share on the grid of the 8-16 sweep below
    [576, 320, 1, 8, 0.709], // that grid's highest, on a texel's edge: the sweep reads both texels
  ];
  for (const [w, h, zoom, tpu, share] of cases) {
    const cam = fitViewCamera(C[0], C[1], w, h, halfWidth);
    near(cam.zoom, zoom, `${w}x${h}: fitView's zoom`);
    near(cam.texPerUnit, tpu, `${w}x${h}: texels per unit`);
    const sdf = buildSdf(cam, [WALL_A]);
    const profile = (range) => LENGTH.map((d) => alongSun(cam, sdf, d, range));
    const f = profile(6);
    f.forEach((v, k) => near(v, [0, 0, 0, share, 1][k], `${w}x${h}, range 6: ${LENGTH[k]} past the face`));
    assert.ok(f[FADE_AT] >= lo && f[FADE_AT] <= hi, `${w}x${h}: the share ${f[FADE_AT]} lies outside FADE_SHARE [${lo}, ${hi}]`);
    // A reach halved (directionalRay's `* 0.25 * size`) or doubled (`size` without its 0.5).
    profile(3).forEach((v, k) => near(v, [0, 0, 1, 1, 1][k], `${w}x${h}, range 3: ${LENGTH[k]} past the face`));
    profile(12).forEach((v, k) => near(v, 0, `${w}x${h}, range 12: ${LENGTH[k]} past the face`));
    const [shorter, longer] = [alongSun(cam, sdf, 5.25, 5.5), alongSun(cam, sdf, 5.25, 6.5)];
    assert.ok(shorter > hi && longer < lo, `${w}x${h}: ranges 5.5 and 6.5 give ${shorter} and ${longer}, not both outside [${lo}, ${hi}]`);
  }
});

test("check 2 on the tab's framing, the sun's 192 steps, 8 to 16 texels per unit (a grid of canvases: heights 300 to 1000 px every 20 px, aspects 0.5 to 2.4 in tenths): 0, 0, 0, a share in FADE_SHARE, 1, at every texel a probe may read; no reach or range error lies in it", () => {
  const s = sweepCheck2(canvasGrid(300, 1000, 20, 5, 24, 1), 8, 16);
  // 23 put the point 5.25 past the face on a texel's edge. The window [0.40,
  // 0.60] of the first fix failed correct code on 58. The extremes are this
  // grid's: off it the model reads 0.716 at 565x320 and 0.437 at 699x349,
  // and a range 0.5 off 0.306 (565x320) and 0.868 (699x349).
  assert.deepEqual([s.canvases, s.onEdge, s.above], [326, 23, 58]);
  const extremes = { low: [0.448, '588x420'], high: [0.709, '576x320'], shortest: [0.877, '588x420'], longest: [0.3, '576x320'] };
  for (const [k, [value, canvas]] of Object.entries(extremes)) {
    near(s[k][0], value, `${k} (range ${{ shortest: 5.5, longest: 6.5 }[k] ?? 6})`);
    assert.equal(s[k][1], canvas, `${k}: its canvas`);
  }
});

test("check 2 on the tab's framing, the sun's 192 steps, 16 or more texels per unit (a grid of canvases: heights 640 to 1440 px every 80 px, aspects 0.5 to 2.3 in steps of 0.3): the same, the share on this grid 0.47 to 0.60", () => {
  const s = sweepCheck2(canvasGrid(640, 1440, 80, 5, 23, 3), 16, Infinity);
  // The extremes are this grid's: off it the model reads 0.4672 at 2154x718
  // (17.95 texels per unit) and 0.6024 at 1281x640 (16.0).
  assert.deepEqual([s.canvases, s.onEdge, s.above], [47, 16, 0]);
  const extremes = { low: [0.47, '1152x1440'], high: [0.599, '1280x640'], shortest: [0.893, '1152x1440'], longest: [0.206, '1280x640'] };
  for (const [k, [value, canvas]] of Object.entries(extremes)) {
    near(s[k][0], value, `${k} (range ${{ shortest: 5.5, longest: 6.5 }[k] ?? 6})`);
    assert.equal(s[k][1], canvas, `${k}: its canvas`);
  }
});

test("check 2 below 8 texels per unit, where the window is not guaranteed: at 290x580 (4.12 per unit) FADE_SHARE fails correct code and passes a range 0.5 too long", () => {
  const { halfWidth, lo, hi } = tabCheck2();
  const cam = fitViewCamera(C[0], C[1], 290, 580, halfWidth);
  near(cam.texPerUnit, 4.119, 'texels per unit');
  const sdf = buildSdf(cam, [WALL_A]);
  assert.equal(probeTexels(cam, ...pastFace(5.25)).length, 1, 'off any texel edge');
  const correct = alongSun(cam, sdf, 5.25, 6);
  const longer = alongSun(cam, sdf, 5.25, 6.5);
  near(correct, 0.85, 'correct code');
  near(longer, 0.45, 'range 6.5');
  assert.ok(correct > hi && longer >= lo && longer <= hi, `correct ${correct} outside, range 6.5 ${longer} inside [${lo}, ${hi}]`);
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
  // out of steps, and the out-of-steps rule darkens it. The open row's ray at
  // d = 1, which the tab's check compares E with, reaches the range at the
  // sun's 192 steps (0.93); only at 48 does it run out of steps too (0.76),
  // still far lighter than E.
  const reach = 100 * cam.texPerUnit;
  const toRange = (x, y, steps) => {
    const [u, v] = cam.toTexel(x, y);
    return shadow(sdf, Math.floor(u) + 0.5, Math.floor(v) + 0.5, -1, 0, reach, ANGLE, reach, steps);
  };
  near(toRange(ex, ey, STEPS), 0.204, 'E, marching to the range, 48 steps');
  near(toRange(ex, ey, SUN_STEPS), 0.256, 'E, marching to the range, 192 steps');
  near(toRange(xL + 1, rows.ref, SUN_STEPS), 0.931, 'the open row at d = 1, marching to the range, 192 steps');
});

test("check 3 on wide canvases, the sun's 192 steps: W_out's row stays lit at every d up to 5:1, while W_in's penumbra darkens the open row from d = 76", () => {
  // Review wf_cf354af4-c53 [8]. The view is 20·aspect units wide (fitView
  // never zooms in), so d reaches about 4·20 on a 4:1 canvas, where W_in's
  // penumbra, about 0.02·d wide, reaches the open row 1.5 below it. W_out's
  // row is 4 below W_in, and W_out, wholly off screen, casts nothing. So the
  // tab's off-screen rule is one-sided: W_out's row darker than the open row.
  // `lighter` is how much lighter W_out's row gets, at most: above the tab's
  // tolerance of 0.03 on every one of these canvases (the two real ones of
  // the review are 4.11:1: half a 1440p screen, a 32:9 monitor).
  const cases = [[3840, 960, 79, 0.0434], [4800, 960, 99, 0.0762], [2340, 569, 81, 0.0735], [3620, 881, 81, 0.0616]];
  for (const [w, h, lastD, lighter] of cases) {
    const cam = makeCamera(C[0], C[1], w, h);
    const { xL } = cam;
    const sdf = buildSdf(cam, [WALL_A, rect(xL - 0.55, C[1] + 3, 0.6, 2), rect(xL + 0.2, C[1] + 8, 0.6, 2)]);
    assert.equal(Math.floor(2 * cam.hw - 0.5), lastD);
    const at = (x, y) => sunShadowAt(cam, sdf, x, y, 0, 100, ANGLE, SUN_STEPS);
    let most = 0;
    for (let d = 1; d <= lastD; d++) {
      const out = at(xL + d, C[1] + 3);
      near(out, 1, `${w}x${h}: W_out's row at d = ${d}`);
      most = Math.max(most, out - at(xL + d, C[1] + 5.5));
    }
    near(most, lighter, `${w}x${h}: W_out's row lighter than the open row, at most`);
    near(at(xL + 1, C[1] + 3) - at(xL + 1, C[1] + 8), 1, `${w}x${h}: the pop at d = 1`);
    near(at(xL + 1, C[1] + 6.6), 1, `${w}x${h}: E`);
  }
  // The 3840x960 rows of lighting-directional.test.ts: the open row 1 and
  // W_in's row 0, but at d = 76 to 79.
  const cam = makeCamera(C[0], C[1], 3840, 960);
  const { xL } = cam;
  const sdf = buildSdf(cam, [WALL_A, rect(xL - 0.55, C[1] + 3, 0.6, 2), rect(xL + 0.2, C[1] + 8, 0.6, 2)]);
  const at = (x, y) => sunShadowAt(cam, sdf, x, y, 0, 100, ANGLE, SUN_STEPS);
  const ref = { 76: 0.9921, 77: 0.9795, 78: 0.9673, 79: 0.9566 };
  const inn = { 76: 0.0014, 77: 0.0107, 78: 0.0287, 79: 0.055 };
  for (let d = 1; d <= 79; d++) {
    near(at(xL + d, C[1] + 5.5), ref[d] ?? 1, `3840x960: the open row at d = ${d}`);
    near(at(xL + d, C[1] + 8), inn[d] ?? 0, `3840x960: W_in's row at d = ${d}`);
  }
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
