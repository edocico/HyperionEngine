// docs/plans/assets/2026-10-14-step8/tools/step8-compare.mjs: the offline gates
// of the step-8 GPU legs (round step 8, the sprite light). Prints JSON; exits 0
// fine, 1 out of tolerance, 2 bad usage or input, 3 refused.
//   node step8-compare.mjs details <harness.json> <statuses.json>
//     The Lighting details of steps 3, 6 and 7 against the step-7 base, within
//     DETAILS_TOL; refused off the 1960x1248 canvas. The light-list check's
//     external ids are masked: they depend on the tabs a page ran before.
//   node step8-compare.mjs mix <step7-bench.json> <step8-bench.json>
//     The last `order` run with blend 'mix' of each side (the step-7 bench):
//     one grid over its reads and the same scene (refused otherwise), then
//     every point identical.
import { readFileSync } from 'node:fs';
import { compareGrids, decodeGrid, detailsDiff } from '../../2026-09-30-step6/step6-stats.mjs';
import { DETAILS_TOL, HARNESS_CANVAS, LIGHTING_DETAIL_CHECKS } from '../../2026-10-08-step7/step7-stats.mjs';

const NAMES = [...LIGHTING_DETAIL_CHECKS, 'Mix light replaces the light buffer', 'Mix order follows depth', 'Light list: exact cull, id at equal depth'];
const lighting = (x) => (x?.lighting ?? x?.tabs?.lighting?.checks ?? [])
  .map((c) => ({ ...c, detail: String(c.detail ?? '').replace(/ids P \d+, Q \d+/g, 'ids P, Q') }));
const mixRun = (bench) => (bench?.results ?? []).filter((r) => r.task === 'order' && r.blend === 'mix').at(-1);
const slots = (r) => (r.lights ?? []).map((l) => l.slot).join();
const [command, fileA, fileB] = process.argv.slice(2);
let out;
try {
  const [a, b] = [fileA, fileB].map((f) => JSON.parse(readFileSync(f, 'utf8')));
  if (command === 'details') {
    const c = a.canvas ?? [];
    const refusals = c[0] === HARNESS_CANVAS[0] && c[1] === HARNESS_CANVAS[1] ? [] : [`a ${c.join('x') || 'missing'} canvas, want ${HARNESS_CANVAS.join('x')}`];
    const checks = detailsDiff(lighting(a), lighting(b), NAMES, DETAILS_TOL);
    out = { ok: checks.every((x) => x.ok), refusals, checks };
  } else if (command === 'mix') {
    const [s7, s8] = [mixRun(a), mixRun(b)];
    if (!s7 || !s8) throw new Error("no order run with blend 'mix' on a side");
    const refusals = [s7, s8].filter((r) => r.distinct?.length !== 1).map((r) => `${r.distinct?.length ?? 0} grids over ${r.reads} reads, want 1`);
    if (slots(s7) !== slots(s8) || s7.K !== s8.K || s7.apart !== s8.apart) refusals.push(`another scene: slots ${slots(s7)} against ${slots(s8)}`);
    const c = refusals.length ? null : compareGrids(decodeGrid(s7.distinct[0].grid), decodeGrid(s8.distinct[0].grid));
    out = { ok: c !== null && c.identical === c.n, refusals, n: c?.n ?? 0, identical: c?.identical ?? 0, maxAbs: c?.maxAbs ?? null };
  } else {
    throw new Error('usage: details <harness.json> <statuses.json> | mix <step7-bench.json> <step8-bench.json>');
  }
} catch (err) {
  console.error(`step8-compare: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
console.log(JSON.stringify(out, null, 2));
process.exitCode = out.refusals.length > 0 ? 3 : out.ok ? 0 : 1;
