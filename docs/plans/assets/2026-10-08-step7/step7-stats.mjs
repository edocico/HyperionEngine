// docs/plans/assets/2026-10-08-step7/step7-stats.mjs
//
// Offline summaries of the step-7 bench (round 2026-09-27, step 7: one light
// list for every 2D light, and the mix blend), over what
// docs/plans/assets/2026-10-08-step7-light-order-bench.js returns (format
// 'hyperion-step7-bench/1'). Pure but for the CLI at the bottom; its node:test
// is step7-stats.test.mjs, next to it. The grid helpers are the step-6 ones
// (docs/plans/assets/2026-09-30-step6/step6-stats.mjs), unchanged.
//
//   node step7-stats.mjs order <bench.json>
//   node step7-stats.mjs permute <bench.json> [--cull subgroup|atomic]
//   node step7-stats.mjs regress <master.json> <step7.json>
//   node step7-stats.mjs details <harness.json> <statuses.json>
//
// Each prints its summary as JSON on stdout. Exit codes: 0 fine; 1 out of
// tolerance (`regress` not ok, a `details` number beyond DETAILS_TOL); 2 bad
// usage, or nothing to summarise: a file that cannot be read or parsed, a
// summary that throws (no `regress` result on a side, runs that read
// different numbers of layers), an `order` or `permute` file holding no
// result of its task; no JSON then, and `step7-stats: <message>` on stderr;
// 3 refused: a summary with `refusals`, a run without the precondition its
// numbers stand on (where its lights sit in the cull's workgroups, the cull
// path, the canvas). A refused run is run again, and its numbers are not
// read. Every string is in English; the plan's documents translate them.
//
// Light-buffer values are linear RGBA (the probe's), held as rgba16float on
// the GPU: a step is one fp16 step, counted exactly by compareGrids.

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareGrids, decodeGrid, detailsDiff, STEP3_CHECKS } from '../2026-09-30-step6/step6-stats.mjs';

/**
 * The Lighting tab's checks whose printed details step 7 must not move: the
 * three of step 3 and the three of step 6.
 */
export const LIGHTING_DETAIL_CHECKS = Object.freeze([
  ...STEP3_CHECKS, 'Directional shadow', 'Directional shadow length', 'Directional edge pop (measured)',
]);

/**
 * The cell of the bench's 64x36 grid (row 18, column 32) where every light of
 * an `order` scene overlaps: the lights sit on y = 0 around x = 0, and the
 * cell's centre is at uv (0.508, 0.514).
 */
export const CENTRE_CELL = 18 * 64 + 32;

/**
 * The cull's workgroup, in slots. The subgroup path orders the lanes inside a
 * workgroup; across workgroups one atomicAdd per workgroup decides. Lights in
 * one workgroup can show no reorder across workgroups.
 */
export const WORKGROUP = 256;

/**
 * The `details` tolerance: 0.002 as printed, plus the margin of the float
 * subtraction (1.100 - 1.098 is 0.0020000000000000018 in doubles).
 */
export const DETAILS_TOL = 0.002 + 1e-9;

/**
 * The canvas the step-6 base printed its Lighting details on: a 1200x689 CSS
 * window at dpr 2. Those details depend on the canvas.
 */
export const HARNESS_CANVAS = Object.freeze([1960, 1248]);

const resultsOf = (bench, task) => (bench?.results ?? []).filter((r) => r.task === task);
const isSlot = (slot) => Number.isInteger(slot) && slot >= 0;
const workgroupOf = (slot) => (isSlot(slot) ? Math.floor(slot / WORKGROUP) : null);

/** compareGrids' identity rule for one point: every channel equal, a NaN equal only to a NaN. */
function samePoint(a, b) {
  const pa = typeof a === 'number' ? [a] : a;
  const pb = typeof b === 'number' ? [b] : b;
  if (pa.length !== pb.length) return false;
  return pa.every((x, c) => x === pb[c] || (Number.isNaN(x) && Number.isNaN(pb[c])));
}

/** A refusal per light the bench found in no row (slot -1 or missing), and one if it recorded none. */
function slotRefusals(lights, whose = '') {
  if (!Array.isArray(lights) || lights.length === 0) {
    return [`no ${whose}lights recorded: the run carries no slots to check its precondition with`];
  }
  return lights.filter((l) => !isSlot(l.slot))
    .map((l) => `no slot for ${whose}light ${l.id}: the bench found it in no row of the render state`);
}

/** The cull workgroups the lights with a slot fall in, each with the ids in it. */
function workgroupsOf(lights) {
  const byWorkgroup = new Map();
  for (const l of lights) {
    const w = workgroupOf(l.slot);
    if (w === null) continue;
    if (!byWorkgroup.has(w)) byWorkgroup.set(w, []);
    byWorkgroup.get(w).push(l.id);
  }
  return [...byWorkgroup.entries()].sort((a, b) => a[0] - b[0]);
}

/** The ids of `lights` in slot order, as text: what two reads compare to see a slot permutation. */
const slotOrder = (lights) => [...lights].sort((a, b) => a.slot - b.slot).map((l) => l.id).join(', ');

/**
 * `order`: per result, whether the light buffer stayed one grid over its N
 * reads of a static scene. One grid: the cull drew the lights in the same
 * order every frame (or the order does not show in the texels: `permute`
 * calibrates that). More: `changedReads` reads differed from the first,
 * `unstablePoints` points moved, at most `maxSteps` fp16 steps.
 *
 * Each result: { label, K, apart, blend, reads, cullPath, distinctGrids
 * (the grids kept: at most 8, more when `overflow`), overflow (a read matched
 * none of the kept grids: -1 in `sequence`), changedReads (reads whose grid is
 * not the first's), unstablePoints (points that differ from the first grid in
 * some grid), maxSteps (the largest worst.ulps of compareGrids(first, g)),
 * centre (the first grid's CENTRE_CELL, null on a smaller grid), list (the
 * page's light list, null on master), lights: [{ id, slot, workgroup }]
 * (workgroup = floor(slot / WORKGROUP)), minSlotDistance (null below two
 * lights with a slot), refusals }.
 *
 * Refused: a light without a slot; `apart` >= WORKGROUP with two lights in
 * one workgroup (the scene was spawned rotated: it cannot show a reorder
 * across workgroups); the `apart` 1 control with its lights in more than one
 * workgroup.
 */
export function summarizeOrder(bench) {
  return resultsOf(bench, 'order').map((r) => {
    const grids = (r.distinct ?? []).map((d) => decodeGrid(d.grid));
    const first = grids[0] ?? null;
    const sequence = r.sequence ?? [];
    let maxSteps = 0;
    const unstable = new Set();
    for (const g of grids.slice(1)) {
      const c = compareGrids(first, g);
      if (c.worst && !(c.worst.ulps <= maxSteps)) maxSteps = c.worst.ulps;
      g.forEach((p, i) => {
        if (!samePoint(first[i], p)) unstable.add(i);
      });
    }
    const lights = (r.lights ?? []).map(({ id, slot }) => ({ id, slot, workgroup: workgroupOf(slot) }));
    const slots = lights.filter((l) => l.workgroup !== null).map((l) => l.slot).sort((a, b) => a - b);
    let minSlotDistance = null;
    for (let i = 1; i < slots.length; i++) {
      const d = slots[i] - slots[i - 1];
      if (minSlotDistance === null || d < minSlotDistance) minSlotDistance = d;
    }
    const refusals = slotRefusals(r.lights);
    const workgroups = workgroupsOf(lights);
    if (r.apart >= WORKGROUP) {
      for (const [w, ids] of workgroups) {
        if (ids.length > 1) {
          refusals.push(`apart ${r.apart}, but lights ${ids.join(' and ')} share a cull workgroup (${w}): the run cannot show a reorder across workgroups (a scene spawned in the update that despawned the previous one is rotated)`);
        }
      }
    }
    if (r.apart === 1 && workgroups.length > 1) {
      refusals.push(`apart 1, but the lights span ${workgroups.length} cull workgroups (${workgroups.map(([w]) => w).join(', ')}): the control needs them in one`);
    }
    return {
      label: r.label ?? null,
      K: r.K,
      apart: r.apart,
      blend: r.blend,
      reads: r.reads ?? sequence.length,
      cullPath: r.cullPath ?? null,
      distinctGrids: grids.length,
      overflow: sequence.includes(-1),
      changedReads: sequence.filter((s) => s !== 0).length,
      unstablePoints: unstable.size,
      maxSteps,
      centre: first && first.length > CENTRE_CELL ? first[CENTRE_CELL] : null,
      list: r.list ?? null,
      lights,
      minSlotDistance,
      refusals,
    };
  });
}

/**
 * `permute`: the calibration of the observable. The same three overlapping
 * `add` lights read twice, before and after a despawn below them rotated
 * their slots: how many texels the new summation order changed (`changed`,
 * of `n`), by at most `maxSteps` fp16 steps (`maxAbs` in value). With 0 the
 * grids cannot show a reorder at all.
 *
 * Each result: { label, cullPath, n, changed, maxSteps, maxAbs, lights:
 * { first, second }, permuted, refusals }, `permuted` = the lights' slot
 * order differs between the two reads.
 *
 * Refused: a run without the permutation (its "0 texels changed" would prove
 * nothing), a light without a slot, and a cull path other than `cull` (a
 * forced atomic path left by an earlier task, say). Safari has no subgroups:
 * its runs are summarised with `{ cull: 'atomic' }`.
 */
export function summarizePermute(bench, { cull = 'subgroup' } = {}) {
  return resultsOf(bench, 'permute').map((r) => {
    const c = compareGrids(decodeGrid(r.first.grid), decodeGrid(r.second.grid));
    const first = r.first.lights ?? [];
    const second = r.second.lights ?? [];
    const refusals = [...slotRefusals(r.first.lights, 'the first read\'s '), ...slotRefusals(r.second.lights, 'the second read\'s ')];
    const permuted = refusals.length === 0 && slotOrder(first) !== slotOrder(second);
    if (refusals.length === 0 && !permuted) {
      refusals.push(`the permutation never happened: the lights kept their slot order (${slotOrder(first)}) across the two reads, so a count of changed texels proves nothing`);
    }
    if (r.cullPath !== cull) refusals.push(`cull path ${r.cullPath}, want ${cull}`);
    return {
      label: r.label ?? null,
      cullPath: r.cullPath ?? null,
      n: c.n,
      changed: c.n - c.identical,
      maxSteps: c.worst ? c.worst.ulps : 0,
      maxAbs: c.maxAbs,
      lights: { first, second },
      permuted,
      refusals,
    };
  });
}

/**
 * `regress`: add and sub must stay bit for bit. The last `regress` result of
 * each run, layer by layer, in three legs of compareGrids (the reference
 * first):
 * - whole: step 7 against master;
 * - stage: master's shader in step 7's stage against master (the same shader:
 *   the blend state, the list's order and the direct draw change);
 * - shader: step 7 against master's shader in the same stage, on the same
 *   page (only the shader changes).
 * `ok` only without refusals and with every point of every leg identical.
 *
 * Refused: master's lights, by slot, not in id order (in this scene, add and
 * sub at z 0, id order is the list's order: master's cull then drew another
 * order, and a difference would be the order's, not step 7's); master's
 * lights in more than one cull workgroup; a cull path other than `cull` on
 * either side; a step-7 run without `oldShaderLayers` (stage and shader are
 * then null); a step-7 run whose old shader is not the one master ran, when
 * both runs recorded its FNV-1a hash (`shaders.old` on the step-7 page,
 * `shaders.live` on master's). Throws without a `regress` result on either
 * side, or when the runs read different numbers of layers.
 */
export function summarizeRegress(master, step7, { cull = 'subgroup' } = {}) {
  const m = resultsOf(master, 'regress').at(-1);
  const s = resultsOf(step7, 'regress').at(-1);
  if (!m || !s) throw new Error(`no regress result in the ${m ? 'step-7' : 'master'} bench output`);
  const mLayers = m.layers ?? [];
  const sLayers = s.layers ?? [];
  if (sLayers.length !== mLayers.length) throw new Error(`${sLayers.length} layers against ${mLayers.length}`);
  const old = s.oldShaderLayers ?? null;
  if (old && old.length !== mLayers.length) throw new Error(`${old.length} oldShaderLayers against ${mLayers.length} layers`);

  const refusals = slotRefusals(m.lights, 'master\'s ');
  if (refusals.length === 0) {
    const ids = [...m.lights].sort((a, b) => a.slot - b.slot).map((l) => l.id);
    if (!ids.every((id, i) => i === 0 || ids[i - 1] < id)) {
      refusals.push(`master's lights by slot are ${ids.join(', ')}, not in id order: master's cull drew another order than the list's, so a difference would be the order's, not step 7's`);
    }
    const workgroups = workgroupsOf(m.lights);
    if (workgroups.length > 1) {
      refusals.push(`master's lights span ${workgroups.length} cull workgroups (${workgroups.map(([w]) => w).join(', ')}): the order across workgroups is the cull's atomics', not the slots'`);
    }
  }
  if (m.cullPath !== cull) refusals.push(`master's cull path is ${m.cullPath}, want ${cull}`);
  if (s.cullPath !== cull) refusals.push(`step 7's cull path is ${s.cullPath}, want ${cull}`);
  if (!old) refusals.push("the step-7 run has no oldShaderLayers: run regress on the step-7 page with window.__step7OldLightAccum set (master's light-accum.wgsl)");
  const oldHash = s.shaders?.old;
  const masterHash = m.shaders?.live;
  if (typeof oldHash === 'string' && typeof masterHash === 'string' && oldHash !== masterHash) {
    refusals.push(`step 7's old shader (${oldHash}) is not the shader master ran (${masterHash}): the stage and shader legs would compare against another shader`);
  }
  if (mLayers.length === 0) refusals.push('no layer was read');

  const layers = mLayers.map((mg, i) => {
    const want = decodeGrid(mg);
    const got = decodeGrid(sLayers[i]);
    const oldShader = old ? decodeGrid(old[i]) : null;
    return {
      whole: compareGrids(want, got),
      stage: oldShader ? compareGrids(want, oldShader) : null,
      shader: oldShader ? compareGrids(oldShader, got) : null,
    };
  });
  const identical = (c) => c !== null && c.identical === c.n;
  const ok = refusals.length === 0 && layers.every((l) => identical(l.whole) && identical(l.stage) && identical(l.shader));
  return {
    ok,
    refusals,
    layers,
    cullPath: { master: m.cullPath ?? null, step7: s.cullPath ?? null },
    labels: { master: m.label ?? null, step7: s.label ?? null },
  };
}

/**
 * `details`: the Lighting tab's details that step 7 must not move
 * (LIGHTING_DETAIL_CHECKS), printed in a harness run against the base's,
 * number by number within DETAILS_TOL (step6-stats' detailsDiff). Refuses a
 * harness whose canvas is not HARNESS_CANVAS: those details depend on it.
 */
export function summarizeDetails(harness, statuses) {
  const refusals = [];
  const canvas = harness?.canvas;
  if (!Array.isArray(canvas) || canvas[0] !== HARNESS_CANVAS[0] || canvas[1] !== HARNESS_CANVAS[1]) {
    refusals.push(`a ${Array.isArray(canvas) ? canvas.join('x') : 'missing'} canvas, want ${HARNESS_CANVAS.join('x')}: the Lighting details depend on the canvas (the base printed them in a 1200x689 CSS window at dpr 2)`);
  }
  const checks = detailsDiff(harness, statuses, LIGHTING_DETAIL_CHECKS, DETAILS_TOL);
  return { ok: refusals.length === 0 && checks.every((c) => c.ok), refusals, checks };
}

// ── The command line ──────────────────────────────────────────────────────

const USAGE = `usage: node step7-stats.mjs order <bench.json>
       node step7-stats.mjs permute <bench.json> [--cull subgroup|atomic]
       node step7-stats.mjs regress <master.json> <step7.json>
       node step7-stats.mjs details <harness.json> <statuses.json>`;
const CULL_PATHS = ['subgroup', 'atomic'];

/** `summary`, the results of `task` in `file`; none is an error, not a passing `[]`. */
function nonEmpty(summary, task, file) {
  if (summary.length === 0) throw new Error(`no ${task} result in ${file}`);
  return summary;
}

/**
 * The summary of a command, and whether it is out of tolerance; null: bad
 * usage. Throws when there is nothing to summarise (main exits 2).
 */
function summarize(command, args, read) {
  if (command === 'order' && args.length === 1) {
    return { summary: nonEmpty(summarizeOrder(read(args[0])), 'order', args[0]), outOfTolerance: false };
  }
  if (command === 'permute' && (args.length === 1 || (args.length === 3 && args[1] === '--cull'))) {
    const cull = args.length === 3 ? args[2] : 'subgroup';
    if (!CULL_PATHS.includes(cull)) return null;
    return { summary: nonEmpty(summarizePermute(read(args[0]), { cull }), 'permute', args[0]), outOfTolerance: false };
  }
  if (command === 'regress' && args.length === 2) {
    const summary = summarizeRegress(read(args[0]), read(args[1]));
    return { summary, outOfTolerance: !summary.ok };
  }
  if (command === 'details' && args.length === 2) {
    const summary = summarizeDetails(read(args[0]), read(args[1]));
    return { summary, outOfTolerance: summary.checks.some((c) => !c.ok) };
  }
  return null;
}

function main(argv) {
  const [command, ...args] = argv;
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
  let result;
  try {
    result = summarize(command, args, read);
  } catch (err) {
    // Not 1: with nothing summarised there is nothing out of tolerance.
    console.error(`step7-stats: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (!result) {
    console.error(USAGE);
    return 2;
  }
  const { summary, outOfTolerance } = result;
  console.log(JSON.stringify(summary, null, 2));
  // Refused first: a run without its precondition has no numbers to judge.
  const refused = (Array.isArray(summary) ? summary : [summary]).some((s) => s.refusals.length > 0);
  if (refused) return 3;
  return outOfTolerance ? 1 : 0;
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
