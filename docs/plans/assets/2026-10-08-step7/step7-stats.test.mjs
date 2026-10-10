// docs/plans/assets/2026-10-08-step7/step7-stats.test.mjs
// Run: node --test docs/plans/assets/2026-10-08-step7/step7-stats.test.mjs
//
// The offline summaries of the step-7 bench (step7-stats.mjs) on small
// synthetic outputs in the format of
// docs/plans/assets/2026-10-08-step7-light-order-bench.js
// ('hyperion-step7-bench/1'), their refusals, the CLI's exit codes, and two
// helpers of the bench itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CENTRE_CELL, DETAILS_TOL, HARNESS_CANVAS, LIGHTING_DETAIL_CHECKS, WORKGROUP,
  summarizeDetails, summarizeOrder, summarizePermute, summarizeRegress,
} from './step7-stats.mjs';
import { decodeGrid } from '../2026-09-30-step6/step6-stats.mjs';

const SCRIPT = fileURLToPath(new URL('./step7-stats.mjs', import.meta.url));
const BENCH = new URL('../2026-10-08-step7-light-order-bench.js', import.meta.url);

/**
 * One function of the bench, evaluated (as step6-stats.test.mjs does). The
 * bench is the body of an evaluate_script call, not a module, so the
 * definition is read from the file: `const <name> = (<arg>) => { … };` at its
 * indentation. It must be self-contained (no free name but globals).
 */
function benchFunction(name) {
  const text = readFileSync(BENCH, 'utf8');
  const m = new RegExp(`\\n  const ${name} = (\\(\\w+\\) => \\{\\n[\\s\\S]*?\\n  \\});\\n`).exec(text);
  assert.ok(m, `the bench defines ${name}`);
  return new Function(`return ${m[1]};`)();
}

/** A grid as the bench stores it: float32 RGBA, little-endian, base64. */
function grid(values) {
  const f = new Float32Array(values.length * 4);
  values.forEach((v, i) => f.set(v, 4 * i));
  return { encoding: 'f32-rgba-base64', count: values.length, data: Buffer.from(f.buffer).toString('base64') };
}
const BASE = [[0.5, 0.25, 0.125, 1], [1.5, 0.75, 0.375, 1], [0.0625, 0.07, 0.12, 1]];
/** BASE with point `i`'s red channel `steps`·2^-11 up: `steps` fp16 steps for point 0, whose red (0.5) is in [0.5, 1), where one step is 2^-11. */
const moved = (i, steps) => BASE.map((p, k) => (k === i ? [p[0] + steps * 2 ** -11, p[1], p[2], p[3]] : p));
const bench = (results) => ({ format: 'hyperion-step7-bench/1', results });
/** Lights as the bench records them. */
const at = (...pairs) => pairs.map(([id, slot]) => ({ id, slot }));

// ── order ────────────────────────────────────────────────────────────────

const orderResult = (over) => ({
  task: 'order', K: 3, apart: 256, blend: 'add', reads: 4, cullPath: 'subgroup', sequence: [0, 0, 0, 0],
  distinct: [{ hash: 'a', firstRead: 0, grid: grid(BASE) }], list: null, lights: at([11, 1], [12, 257], [13, 513]), ...over,
});

test('summarizeOrder: one grid over every read is stable; two grids name the points that moved and by how many fp16 steps', () => {
  const stable = summarizeOrder(bench([orderResult({})]));
  assert.deepEqual(stable.map(({ distinctGrids, changedReads, unstablePoints, maxSteps, refusals }) => ({ distinctGrids, changedReads, unstablePoints, maxSteps, refusals })),
    [{ distinctGrids: 1, changedReads: 0, unstablePoints: 0, maxSteps: 0, refusals: [] }]);
  const moving = summarizeOrder(bench([orderResult({
    reads: 5, cullPath: 'atomic', sequence: [0, 1, 0, 2, 1],
    distinct: [{ hash: 'a', firstRead: 0, grid: grid(BASE) }, { hash: 'b', firstRead: 1, grid: grid(moved(0, 1)) },
      { hash: 'c', firstRead: 3, grid: grid(moved(0, 2)) }],
  })]))[0];
  assert.equal(moving.distinctGrids, 3);
  assert.equal(moving.changedReads, 3);
  assert.equal(moving.unstablePoints, 1);
  assert.equal(moving.maxSteps, 2);
  assert.equal(moving.overflow, false);
  assert.equal(moving.cullPath, 'atomic');
});

test('summarizeOrder: the centre cell of a full 64x36 grid, where every light of the scene overlaps', () => {
  assert.equal(CENTRE_CELL, 1184);
  const values = Array.from({ length: 64 * 36 }, () => [0.06, 0.07, 0.12, 1]);
  values[CENTRE_CELL] = [0.25, 0.5, 1, 1];
  const r = summarizeOrder(bench([orderResult({ apart: 1, blend: 'mix', reads: 1, sequence: [0], lights: at([11, 1], [12, 2], [13, 3]),
    distinct: [{ hash: 'a', firstRead: 0, grid: grid(values) }] })]))[0];
  assert.deepEqual(r.centre, [0.25, 0.5, 1, 1]);
  assert.equal(summarizeOrder(bench([orderResult({ sequence: [0], distinct: [{ grid: grid(BASE) }] })]))[0].centre, null);
});

test('summarizeOrder: a read past the kept grids (-1) is counted as changed and flagged', () => {
  const r = summarizeOrder(bench([orderResult({ K: 2, apart: 1, blend: 'mix', reads: 3, sequence: [0, -1, 0], lights: at([11, 1], [12, 2]) })]))[0];
  assert.equal(r.changedReads, 1);
  assert.equal(r.overflow, true);
});

test("summarizeOrder: each light's slot and cull workgroup, and the smallest slot distance", () => {
  const r = summarizeOrder(bench([orderResult({})]))[0];
  assert.equal(WORKGROUP, 256);
  assert.deepEqual(r.lights, [{ id: 11, slot: 1, workgroup: 0 }, { id: 12, slot: 257, workgroup: 1 }, { id: 13, slot: 513, workgroup: 2 }]);
  assert.equal(r.minSlotDistance, 256);
});

test('summarizeOrder refuses apart >= 256 with two lights in one workgroup (a rotated scene), and the apart-1 control across two', () => {
  // A scene spawned in the update that despawned the previous one: L2 at 3, L0 at 5, L1 at 261.
  const rotated = summarizeOrder(bench([orderResult({ lights: at([11, 5], [12, 261], [13, 3]) })]))[0];
  assert.match(rotated.refusals.join(), /share a cull workgroup/);
  const control = summarizeOrder(bench([orderResult({ apart: 1, lights: at([11, 254], [12, 255], [13, 256]) })]))[0];
  assert.match(control.refusals.join(), /apart 1, but the lights span 2 cull workgroups/);
  const unknown = summarizeOrder(bench([orderResult({ lights: at([11, 1], [12, -1], [13, 513]) })]))[0];
  assert.match(unknown.refusals.join(), /no slot for light 12/);
});

// ── permute ──────────────────────────────────────────────────────────────

const permuteResult = (over) => ({
  task: 'permute', cullPath: 'subgroup',
  first: { grid: grid(BASE), lights: at([21, 2], [22, 3], [23, 4]) },
  second: { grid: grid(moved(0, 2)), lights: at([21, 2], [22, 3], [23, 1]) },
  ...over,
});

test('summarizePermute: the texels a slot permutation changed, and by how many fp16 steps', () => {
  const diff = summarizePermute(bench([permuteResult({})]))[0];
  assert.equal(diff.permuted, true);
  assert.deepEqual(diff.refusals, []);
  assert.equal(diff.changed, 1);
  assert.equal(diff.maxSteps, 2);
  const same = summarizePermute(bench([permuteResult({ second: { grid: grid(BASE), lights: at([21, 2], [22, 3], [23, 1]) } })]))[0];
  assert.equal(same.changed, 0);
  assert.deepEqual(same.refusals, []);
});

test("summarizePermute refuses a run whose lights' slot order did not change, and a cull path other than the expected one", () => {
  // The filler destroyed was not below the lights: the floor moved, the lights kept their order.
  const vacuous = summarizePermute(bench([permuteResult({ second: { grid: grid(BASE), lights: at([21, 1], [22, 2], [23, 3]) } })]))[0];
  assert.equal(vacuous.permuted, false);
  assert.match(vacuous.refusals.join(), /the permutation never happened/);
  const atomic = summarizePermute(bench([permuteResult({ cullPath: 'atomic' })]))[0];
  assert.match(atomic.refusals.join(), /cull path atomic, want subgroup/);
  // Safari has no subgroups: its runs are summarised with { cull: 'atomic' }.
  assert.deepEqual(summarizePermute(bench([permuteResult({ cullPath: 'atomic' })]), { cull: 'atomic' })[0].refusals, []);
});

// ── regress ──────────────────────────────────────────────────────────────

const LIGHTS = at([5, 4], [6, 5], [7, 6], [8, 7], [9, 8]);
const masterRun = (over = {}) => bench([{ task: 'regress', cullPath: 'subgroup', lights: LIGHTS, layers: [grid(BASE), grid(BASE)], ...over }]);
const step7Run = (over = {}) => bench([{
  task: 'regress', cullPath: 'subgroup', lights: LIGHTS, layers: [grid(BASE), grid(BASE)], oldShaderLayers: [grid(BASE), grid(BASE)], ...over,
}]);

test('summarizeRegress: three legs per layer (whole, stage, shader); ok only if every point of every leg is identical', () => {
  const same = summarizeRegress(masterRun(), step7Run());
  assert.equal(same.ok, true);
  assert.deepEqual(same.refusals, []);
  assert.deepEqual(same.layers.map((l) => [l.whole.identical, l.stage.identical, l.shader.identical]), [[3, 3, 3], [3, 3, 3]]);
  // Step 7 off by an fp16 step against master, in both its own run and the old shader's: whole and stage move, shader does not.
  const stage = summarizeRegress(masterRun(), step7Run({ layers: [grid(BASE), grid(moved(0, 1))], oldShaderLayers: [grid(BASE), grid(moved(0, 1))] }));
  assert.equal(stage.ok, false);
  assert.deepEqual(stage.layers.map((l) => [l.whole.identical, l.stage.identical, l.shader.identical]), [[3, 3, 3], [2, 2, 3]]);
  assert.equal(stage.layers[1].whole.withinUlp, 3);
  // The shader alone: the old shader's grid equals master's, step 7's does not.
  const shader = summarizeRegress(masterRun(), step7Run({ layers: [grid(moved(2, 1)), grid(BASE)] }));
  assert.equal(shader.ok, false);
  assert.deepEqual(shader.layers[0].shader.identical, 2);
  assert.throws(() => summarizeRegress(masterRun(), step7Run({ layers: [grid(BASE)], oldShaderLayers: [grid(BASE)] })), /1 layers against 2/);
});

test("summarizeRegress refuses when master's lights are not in id order by slot, span two workgroups, or a run took another cull path", () => {
  // The rotated layout of a regress spawned right after `permute`: the point light (id 5) last.
  const rotated = summarizeRegress(masterRun({ lights: at([5, 8], [6, 0], [7, 1], [8, 2], [9, 3]) }), step7Run());
  assert.equal(rotated.ok, false);
  assert.match(rotated.refusals.join(), /master's lights by slot are 6, 7, 8, 9, 5, not in id order/);
  const spread = summarizeRegress(masterRun({ lights: at([5, 250], [6, 251], [7, 252], [8, 253], [9, 256]) }), step7Run());
  assert.match(spread.refusals.join(), /span 2 cull workgroups/);
  const atomic = summarizeRegress(masterRun({ cullPath: 'atomic' }), step7Run());
  assert.match(atomic.refusals.join(), /master's cull path is atomic, want subgroup/);
  const noLeg = summarizeRegress(masterRun(), step7Run({ oldShaderLayers: undefined }));
  assert.equal(noLeg.ok, false);
  assert.match(noLeg.refusals.join(), /no oldShaderLayers/);
  assert.equal(noLeg.layers[0].stage, null);
});

// ── details ──────────────────────────────────────────────────────────────

test('LIGHTING_DETAIL_CHECKS: the step-3 and the step-6 checks of the Lighting tab, whose details step 7 must not move', () => {
  assert.deepEqual(LIGHTING_DETAIL_CHECKS, [
    'Lit vs unlit', 'Layer shadow on screen', 'Light layers',
    'Directional shadow', 'Directional shadow length', 'Directional edge pop (measured)',
  ]);
  assert.deepEqual(HARNESS_CANVAS, [1960, 1248]);
});

const detailRun = (printed, canvas = HARNESS_CANVAS) => ({
  canvas, lighting: LIGHTING_DETAIL_CHECKS.map((name, i) => ({ name, status: 'pass', detail: `${name} 0.500, ${i === 1 ? printed : '1.098'}` })),
});
const detailBase = { tabs: { lighting: { checks: detailRun('1.098').lighting } } };

test('summarizeDetails: a printed 1.098 -> 1.100 passes (0.002 within float rounding), 0.003 fails; any other canvas is refused', () => {
  assert.ok(Math.abs(1.1 - 1.098) > 0.002, 'the float subtraction overshoots 0.002');
  assert.ok(DETAILS_TOL > 0.002 && DETAILS_TOL < 0.0021);
  assert.equal(summarizeDetails(detailRun('1.100'), detailBase).ok, true);
  assert.equal(summarizeDetails(detailRun('1.101'), detailBase).ok, false);
  const bench1080 = summarizeDetails(detailRun('1.098', [1920, 1080]), detailBase);
  assert.equal(bench1080.ok, false);
  assert.match(bench1080.refusals.join(), /1920x1080 canvas, want 1960x1248/);
});

// ── The bench's own helpers ──────────────────────────────────────────────

test("the bench's encodeGrid and fnv1a: a grid round-trips through decodeGrid, equal grids hash alike, one fp16 step apart they do not", () => {
  const encodeGrid = benchFunction('encodeGrid');
  const fnv1a = benchFunction('fnv1a');
  const values = Array.from({ length: 64 * 36 }, (_, i) => [i / 7, 0.25, -0.125, 1]);
  const g = encodeGrid(values);
  assert.equal(g.encoding, 'f32-rgba-base64');
  assert.equal(g.count, values.length);
  assert.deepEqual(decodeGrid(g), values.map((p) => p.map(Math.fround)));
  assert.equal(fnv1a(encodeGrid(values.map((p) => [...p])).data), fnv1a(g.data));
  const step = values.map((p) => [...p]);
  step[1000][1] = 0.25 + 2 ** -12;  // one fp16 step at 0.25
  assert.notEqual(fnv1a(encodeGrid(step).data), fnv1a(g.data));
  assert.match(fnv1a('light-accum'), /^[0-9a-f]{8}$/);
});

// ── CLI ──────────────────────────────────────────────────────────────────

/**
 * `body({ dir, write, run })` in a scratch directory `dir`, removed
 * afterwards: `write` puts a value there as JSON (a string as is) and returns
 * its path, `run` spawns the CLI.
 */
function withCli(body) {
  const dir = mkdtempSync(join(tmpdir(), 'step7-stats-'));
  try {
    const write = (name, value) => {
      const file = join(dir, name);
      writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
      return file;
    };
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    body({ dir, write, run });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI: `regress` exits 0, 1 out of tolerance, 3 refused; `details` 0, 1 and 3; `permute --cull atomic`; bad usage exits 2', () => {
  withCli(({ write, run }) => {
    const master = write('master.json', masterRun());
    assert.equal(run('regress', master, write('same.json', step7Run())).status, 0);
    assert.equal(run('regress', master, write('off.json', step7Run({ layers: [grid(moved(1, 1)), grid(BASE)] }))).status, 1);
    assert.equal(run('regress', write('rotated.json', masterRun({ lights: at([5, 8], [6, 0], [7, 1], [8, 2], [9, 3]) })), write('s.json', step7Run())).status, 3);
    const base = write('base.json', detailBase);
    assert.equal(run('details', write('h.json', detailRun('1.100')), base).status, 0);
    assert.equal(run('details', write('shifted.json', detailRun('1.101')), base).status, 1);
    assert.equal(run('details', write('h1080.json', detailRun('1.098', [1920, 1080])), base).status, 3);
    const safari = write('safari.json', bench([permuteResult({ cullPath: 'atomic' })]));
    assert.equal(run('permute', safari).status, 3);
    assert.equal(run('permute', safari, '--cull', 'atomic').status, 0);
    assert.equal(run('regress', master).status, 2);
    assert.equal(run('permute', safari, '--cull', 'nonsense').status, 2);
  });
});

test('CLI: a summary that throws exits 2 (not 1, out of tolerance) with `step7-stats: <message>` on stderr and no JSON', () => {
  withCli(({ dir, write, run }) => {
    const noRegress = run('regress', write('order.json', bench([orderResult({})])), write('s.json', step7Run()));
    assert.equal(noRegress.status, 2);
    assert.equal(noRegress.stderr, 'step7-stats: no regress result in the master bench output\n');
    assert.equal(noRegress.stdout, '');
    const layers = run('regress', write('m.json', masterRun()), write('one-layer.json', step7Run({ layers: [grid(BASE)], oldShaderLayers: [grid(BASE)] })));
    assert.equal(layers.status, 2);
    assert.equal(layers.stderr, 'step7-stats: 1 layers against 2\n');
    const missing = run('order', join(dir, 'missing.json'));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /^step7-stats: ENOENT: no such file or directory, open '.*missing\.json'\n$/);
    const garbage = run('order', write('garbage.json', '{"results": ['));
    assert.equal(garbage.status, 2);
    assert.match(garbage.stderr, /^step7-stats: [^\n]+\n$/);
  });
});

test('CLI: `order` and `permute` on a file holding no result of their task exit 2, `step7-stats: no <task> result in <file>`, never an empty []', () => {
  withCli(({ write, run }) => {
    const permuteOnly = write('permute.json', bench([permuteResult({})]));
    const orderOnly = write('order.json', bench([orderResult({})]));
    const noOrder = run('order', permuteOnly);
    assert.equal(noOrder.status, 2);
    assert.equal(noOrder.stderr, `step7-stats: no order result in ${permuteOnly}\n`);
    assert.equal(noOrder.stdout, '');
    const noPermute = run('permute', orderOnly);
    assert.equal(noPermute.status, 2);
    assert.equal(noPermute.stderr, `step7-stats: no permute result in ${orderOnly}\n`);
    assert.equal(noPermute.stdout, '');
    assert.equal(run('permute', orderOnly, '--cull', 'atomic').status, 2);
    // Each still summarises a file of its own task.
    assert.equal(run('order', orderOnly).status, 0);
    assert.equal(run('permute', permuteOnly).status, 0);
  });
});
