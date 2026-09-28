// docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.test.mjs
// Run: node --test docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABS, comparePixels, compareStatuses, parseJsonOutput } from './compare.mjs';

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
