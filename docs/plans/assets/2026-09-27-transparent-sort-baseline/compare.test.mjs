// docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.test.mjs
// Run: node --test docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABS, comparePixels, compareStatuses, framingDiff, main, parseJsonOutput } from './compare.mjs';

const VP = [0.05, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, -0.001, 0, 0, 0, 0, 1];
const GREY = [0.067, 0.067, 0.067, 1];

/** A capture of a 2x2 grid (4 points, no check points) with the given RGBA per point. */
function capture(values, extra = {}) {
  const f = new Float32Array(values.flat());
  return {
    format: 'hyperion-5b-capture/1', tab: 'primitives', mode: 'B',
    canvasSize: [100, 50], targetSize: [100, 50], dpr: 1.25, viewProjection: VP,
    gridSize: [2, 2], checkPoints: [], dropped: [], bitExact: true,
    bitsB64: Buffer.from(f.buffer).toString('base64'),
    unstable: [], moving: [], movers: [], transparent: [],
    ...extra,
  };
}
const four = () => [GREY, GREY, GREY, GREY];
const withPoint = (i, rgba) => four().map((p, k) => (k === i ? rgba : p));

test('identical captures pass with every point in C', () => {
  const r = comparePixels(capture(four()), capture(four()), 1);
  assert.equal(r.ok, true);
  assert.equal(r.c, 4);
});

test('a point that changed inside the base window is not compared', () => {
  const r = comparePixels(capture(four(), { unstable: [1] }), capture(withPoint(1, [1, 1, 1, 1])), 1);
  assert.equal(r.ok, true);
  assert.equal(r.c, 3);
});

test('a point in either motion footprint is not compared', () => {
  const r = comparePixels(capture(four()), capture(withPoint(2, [1, 0, 0, 1]), { moving: [2] }), 1);
  assert.equal(r.ok, true);
  assert.equal(r.c, 3);
});

test('a differing point of C fails and is reported', () => {
  const r = comparePixels(capture(four()), capture(withPoint(3, [0.5, 0.067, 0.067, 1])), 1);
  assert.equal(r.ok, false);
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0].index, 3);
  assert.deepEqual(r.mismatches[0].uv, [0.75, 0.75]);
});

test('+0 and -0 are different bits', () => {
  const r = comparePixels(capture(withPoint(0, [0, 0, 0, 1])), capture(withPoint(0, [-0, 0, 0, 1])), 2);
  assert.equal(r.ok, false);
});

test('step 4: a point of C ∩ T within 1/255 passes, beyond it fails', () => {
  const base = capture(withPoint(0, [0.5, 0.5, 0.5, 1]), { transparent: [0] });
  const near = capture(withPoint(0, [0.5 + 1 / 512, 0.5, 0.5, 1]));
  const far = capture(withPoint(0, [0.5 + 2 / 255, 0.5, 0.5, 1]));
  assert.equal(comparePixels(base, near, 4).ok, true);
  assert.equal(comparePixels(base, near, 3).ok, false);
  assert.equal(comparePixels(base, far, 4).ok, false);
});

test('step 4 keeps C \\ T bit-exact', () => {
  const base = capture(withPoint(0, [0.5, 0.5, 0.5, 1]));
  const run = capture(withPoint(0, [0.5 + 1 / 512, 0.5, 0.5, 1]));
  assert.equal(comparePixels(base, run, 4).ok, false);
});

test('a tab without bit-exact points (Lighting) is excluded, not failed', () => {
  const base = capture(four(), { tab: 'lighting', bitExact: false });
  const run = capture(withPoint(0, [1, 1, 1, 1]), { tab: 'lighting', bitExact: false });
  const r = comparePixels(base, run, 1);
  assert.equal(r.ok, true);
  assert.equal(r.c, 0);
  assert.match(r.excluded, /Lighting/);
});

test('any other tab with a moving camera fails instead of being excluded', () => {
  const run = capture(withPoint(0, [0.9, 0.9, 0.9, 1]), { tab: 'twin-2d', bitExact: false });
  const r = comparePixels(capture(four(), { tab: 'twin-2d' }), run, 4);
  assert.equal(r.ok, false);
  assert.equal(r.excluded, null);
  assert.match(r.problems[0], /run is not bit-exact/);
});

test('a different framing fails the tab', () => {
  const run = capture(four(), { viewProjection: VP.map((x, i) => (i === 0 ? 0.04 : x)) });
  const r = comparePixels(capture(four()), run, 1);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /framing differs: viewProjection/);
});

test('C must keep at least half of the grid', () => {
  const r = comparePixels(capture(four(), { moving: [0, 1, 2] }), capture(four()), 1);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /C keeps 1\/4 grid points/);
});

/** A capture of the real 64x36 grid (2304 points), every point at the clear colour. */
function gridCapture(extra = {}) {
  const f = new Float32Array(64 * 36 * 4);
  for (let i = 0; i < 64 * 36; i++) f.set(GREY, 4 * i);
  return capture([], { tab: 'audio', gridSize: [64, 36], bitsB64: Buffer.from(f.buffer).toString('base64'), ...extra });
}
const mover = (id) => ({ id, from: [0, 0], to: [1, 0], radius: 1 });

test('instability new in the run fails instead of shrinking C (600 points of audio, the review repro)', () => {
  const unstable = Array.from({ length: 600 }, (_, i) => i);
  const r = comparePixels(gridCapture(), gridCapture({ unstable }), 1);
  assert.equal(r.c, 1704);
  assert.equal(r.ok, false);
  assert.equal(r.newUnstable.length, 600);
  assert.match(r.problems.join('\n'), /600 points unstable in the run only/);
});

test('run instability inside the baseline instability or either motion footprint is allowed', () => {
  const base = gridCapture({ unstable: [0], moving: [1] });
  const run = gridCapture({ unstable: [0, 1, 2], moving: [2] });
  const r = comparePixels(base, run, 1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.newUnstable, []);
  assert.equal(r.c, 2301);
});

test('a different set of mover ids fails and names both sets', () => {
  const r = comparePixels(capture(four(), { movers: [mover(47)] }), capture(four(), { movers: [mover(48)] }), 1);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /mover ids differ: baseline \[47\], run \[48\]/);
  const extra = comparePixels(capture(four(), { movers: [mover(47)] }), capture(four(), { movers: [mover(47), mover(50)] }), 1);
  assert.equal(extra.ok, false);
  assert.match(extra.problems.join('\n'), /mover ids differ: baseline \[47\], run \[47,50\]/);
});

test('the same mover ids in another order pass', () => {
  const r = comparePixels(capture(four(), { movers: [mover(2), mover(1)] }), capture(four(), { movers: [mover(1), mover(2)] }), 1);
  assert.equal(r.ok, true);
});

/** Statuses of every tab: one passing check each, Input with its 4 interaction checks pending. */
function statuses(overrides = {}) {
  const tabs = {};
  for (const tab of TABS) tabs[tab] = { summary: '1/1 passed', checks: [{ name: 'A', status: 'pass' }], unexpectedPending: [] };
  tabs.input = {
    summary: '1/5 passed',
    checks: [
      { name: 'Keyboard callback', status: 'pending' }, { name: 'Click callback', status: 'pending' },
      { name: 'Pointer move callback', status: 'pending' }, { name: 'Scroll callback', status: 'pending' },
      { name: 'Hit testing', status: 'pass' },
    ],
    unexpectedPending: [],
  };
  tabs['rendering-fx'] = { summary: '1/2 passed · 1 skipped', checks: [{ name: 'A', status: 'pass' }, { name: 'Tonemap switch', status: 'skip' }], unexpectedPending: [] };
  return { format: 'hyperion-5b-statuses/1', mode: 'B', tabs: { ...tabs, ...overrides } };
}
const tabWith = (checks) => ({ summary: '', checks, unexpectedPending: [] });

test('equal statuses pass, pending and skipped checks included', () => {
  assert.deepEqual(compareStatuses(statuses(), statuses()), { ok: true, problems: [] });
});

test('a check that passed and now fails is a regression', () => {
  const r = compareStatuses(statuses(), statuses({ primitives: tabWith([{ name: 'A', status: 'fail' }]) }));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /'A' was pass, now fail/);
});

test('a skipped check must stay skipped', () => {
  const run = statuses({ 'rendering-fx': tabWith([{ name: 'A', status: 'pass' }, { name: 'Tonemap switch', status: 'pass' }]) });
  assert.equal(compareStatuses(statuses(), run).ok, false);
});

test('a new check must pass, and a missing one fails', () => {
  const added = (status) => statuses({ 'twin-2d': tabWith([{ name: 'A', status: 'pass' }, { name: 'Depth orders transparent sprites', status }]) });
  assert.equal(compareStatuses(statuses(), added('pass')).ok, true);
  assert.equal(compareStatuses(statuses(), added('fail')).ok, false);
  assert.equal(compareStatuses(statuses(), statuses({ 'twin-2d': tabWith([]) })).ok, false);
});

test('a new skipped check passes only when it is allowed by name', () => {
  const run = statuses({ 'twin-2d': tabWith([{ name: 'A', status: 'pass' }, { name: 'Mode C only', status: 'skip' }]) });
  assert.equal(compareStatuses(statuses(), run).ok, false);
  assert.equal(compareStatuses(statuses(), run, ['Mode C only']).ok, true);
});

test('a capture with an unexpected pending check is invalid', () => {
  const run = statuses({ 'scene-graph': { summary: '', checks: [{ name: 'A', status: 'pass' }], unexpectedPending: ['Velocity'] } });
  const r = compareStatuses(statuses(), run);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /capture it again/);
});

test('parseJsonOutput reads plain, wrapped and double-encoded JSON', () => {
  assert.deepEqual(parseJsonOutput('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonOutput('Script ran on page and returned:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonOutput(JSON.stringify(JSON.stringify({ a: 1 }))), { a: 1 });
});

test('framingDiff names a canvas and a devicePixelRatio difference, and passes equal framings', () => {
  assert.equal(framingDiff(capture(four()), capture(four())), null);
  assert.equal(framingDiff(capture(four()), capture(four(), { canvasSize: [120, 50] })), 'canvas 100,50 vs 120,50');
  assert.equal(framingDiff(capture(four()), capture(four(), { dpr: 1.5 })), 'devicePixelRatio 1.25 vs 1.5');
});

/** A capture directory for mode B: the ten tabs and the statuses; `change(tab, cap)` edits one capture. */
function captureDir(change = (_tab, cap) => cap) {
  const dir = mkdtempSync(join(tmpdir(), 'compare-test-'));
  for (const tab of TABS) writeFileSync(join(dir, `B-${tab}.json`), JSON.stringify(change(tab, capture(four(), { tab }))));
  writeFileSync(join(dir, 'statuses-B.json'), JSON.stringify(statuses()));
  return dir;
}
/** main() with its console output swallowed. */
function quietMain(argv) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return main(argv);
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('main exits 0 on PASS, 1 on FAIL and 2 on bad arguments or unreadable files', () => {
  const base = captureDir();
  const same = captureDir();
  const changed = captureDir((tab, cap) => (tab === 'primitives' ? capture(withPoint(0, [1, 1, 1, 1]), { tab }) : cap));
  const args = (run, step = '0') => ['--base', base, '--run', run, '--mode', 'B', '--step', step];
  assert.equal(quietMain(args(same)), 0);
  assert.equal(quietMain(args(changed)), 1);
  assert.equal(quietMain(['--base', base, '--run', same, '--step', '0']), 2);
  assert.equal(quietMain(['--base', base, '--run', same, '--mode', 'X', '--step', '0']), 2);
  assert.equal(quietMain(args(same, '5')), 2);
  assert.equal(quietMain([...args(same), '--bogus']), 2);
  assert.equal(quietMain(args(mkdtempSync(join(tmpdir(), 'compare-test-empty-')))), 2);
});

test('the CLI runs main() when compare.mjs is reached through a symlink', () => {
  // Through a link process.argv[1] is not the module's real path: the old guard
  // skipped main() and the process exited 0 in silence, so a failing gate looked
  // like a pass. No arguments make main() print the usage and return 2.
  const dir = mkdtempSync(join(tmpdir(), 'compare-test-link-'));
  try {
    const link = join(dir, 'compare-link.mjs');
    symlinkSync(fileURLToPath(new URL('./compare.mjs', import.meta.url)), link);
    const run = spawnSync(process.execPath, [link], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /^usage: node compare\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
