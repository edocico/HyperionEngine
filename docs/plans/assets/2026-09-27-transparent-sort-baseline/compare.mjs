#!/usr/bin/env node
// docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs
//
// Compares a capture run (capture.js, one page load per mode) against the
// step-0 baseline of Phase 5b (spec §7.3.1, §7.3.5):
//   C = S_base ∩ S_run \ (M_base ∪ M_run)     T = T_base ∪ T_run
//   --step 0..3: every point of C bit-identical (the f32 bits of the f16 texel)
//   --step 4:    C \ T bit-identical, C ∩ T within 1/255 per channel
// plus the check statuses of every tab (statuses-<mode>.json).
//
// Usage: node compare.mjs --base <dir> --run <dir> --mode B|C --step 0|1|2|3|4
//                         [--allow-new-skip '<check name>' ...]
// A check the baseline does not have must pass; --allow-new-skip names a new
// check that may be 'skip' instead (a Mode C-only check, run in Mode B).
// Exit code: 0 PASS, 1 FAIL, 2 bad arguments or unreadable files.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const TABS = ['primitives', 'scene-graph', 'input', 'audio', 'particles', 'rendering-fx', 'lighting', 'debug-tools', 'lifecycle', 'twin-2d'];
/** C must keep at least this fraction of the UV grid, or the gate says nothing. */
export const MIN_C_FRACTION = 0.5;
export const TRANSPARENT_TOLERANCE = 1 / 255;

/** evaluate_script's filePath output is plain JSON; tolerate a text wrapper or a JSON string around it. */
export function parseJsonOutput(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('no JSON object in the file');
    value = JSON.parse(text.slice(start, end + 1));
  }
  if (typeof value === 'string') value = JSON.parse(value);
  return value;
}

export function gridCount(cap) {
  return cap.gridSize[0] * cap.gridSize[1];
}

export function pointCount(cap) {
  return gridCount(cap) + cap.checkPoints.length;
}

export function uvOf(cap, i) {
  const [gw] = cap.gridSize;
  if (i < gridCount(cap)) return [((i % gw) + 0.5) / gw, (Math.floor(i / gw) + 0.5) / cap.gridSize[1]];
  const p = cap.checkPoints[i - gridCount(cap)];
  return [p.u, p.v];
}

/** The first read of a capture: RGBA per point, as f32 values and as their bits. */
export function decodeBits(b64, points) {
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  if (bytes.length !== points * 16) throw new Error(`bitsB64 holds ${bytes.length} bytes, want ${points * 16}`);
  return { u32: new Uint32Array(bytes.buffer), f32: new Float32Array(bytes.buffer) };
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/** Null when base and run sample the same texels with the same camera, else what differs. */
export function framingDiff(base, run) {
  if (base.mode !== run.mode) return `mode ${base.mode} vs ${run.mode}`;
  if (!sameList(base.canvasSize, run.canvasSize)) return `canvas ${base.canvasSize} vs ${run.canvasSize}`;
  if (!sameList(base.targetSize, run.targetSize)) return `scene-hdr ${base.targetSize} vs ${run.targetSize}`;
  if (base.dpr !== run.dpr) return `devicePixelRatio ${base.dpr} vs ${run.dpr}`;
  if (!sameList(base.gridSize, run.gridSize)) return `grid ${base.gridSize} vs ${run.gridSize}`;
  if (!sameList(base.viewProjection, run.viewProjection)) return 'viewProjection';
  if (base.checkPoints.length !== run.checkPoints.length) return `${base.checkPoints.length} vs ${run.checkPoints.length} check points`;
  for (let k = 0; k < base.checkPoints.length; k++) {
    const a = base.checkPoints[k];
    const b = run.checkPoints[k];
    if (a.u !== b.u || a.v !== b.v) return `check point ${k} (${a.check}) at uv ${a.u},${a.v} vs ${b.u},${b.v}`;
  }
  return null;
}

/** Pixel verdict of one tab. */
export function comparePixels(base, run, step) {
  const result = { excluded: null, c: 0, cMinusT: 0, cAndT: 0, gridInC: 0, grid: gridCount(base), mismatches: [], problems: [], ok: false };
  const framing = framingDiff(base, run);
  if (framing) {
    result.problems.push(`framing differs: ${framing}`);
    return result;
  }
  if (base.tab === 'lighting') {
    result.excluded = 'Lighting: statuses only';
    result.ok = true;
    return result;
  }
  if (!base.bitExact || !run.bitExact) {
    result.problems.push(`the ${base.bitExact ? 'run' : 'baseline'} is not bit-exact: the camera or the scene-hdr size changed during the window (cameraStable false): capture it again`);
    return result;
  }
  const n = pointCount(base);
  const out = new Set([...base.unstable, ...run.unstable, ...base.moving, ...run.moving]);
  const t = new Set([...base.transparent, ...run.transparent]);
  const bb = decodeBits(base.bitsB64, n);
  const rb = decodeBits(run.bitsB64, n);
  for (let i = 0; i < n; i++) {
    if (out.has(i)) continue;
    result.c++;
    if (i < result.grid) result.gridInC++;
    const inT = t.has(i);
    if (inT) result.cAndT++;
    else result.cMinusT++;
    let bad = false;
    for (let k = 0; k < 4; k++) {
      const w = 4 * i + k;
      bad ||= step === 4 && inT
        ? !(Math.abs(bb.f32[w] - rb.f32[w]) <= TRANSPARENT_TOLERANCE)
        : bb.u32[w] !== rb.u32[w];
    }
    if (bad) {
      result.mismatches.push({
        index: i, uv: uvOf(base, i), inT,
        base: Array.from(bb.f32.subarray(4 * i, 4 * i + 4)),
        run: Array.from(rb.f32.subarray(4 * i, 4 * i + 4)),
      });
    }
  }
  if (result.gridInC < MIN_C_FRACTION * result.grid) {
    result.problems.push(`C keeps ${result.gridInC}/${result.grid} grid points (< ${MIN_C_FRACTION * 100}%): too unstable to gate on`);
  }
  if (result.mismatches.length > 0) result.problems.push(`${result.mismatches.length} points of C differ`);
  result.ok = result.problems.length === 0;
  return result;
}

/** Status verdict (spec §7.3.5) over every tab: base and run are statuses-<mode>.json. */
export function compareStatuses(base, run, allowNewSkip = []) {
  const problems = [];
  if (base.mode !== run.mode) problems.push(`mode ${base.mode} vs ${run.mode}`);
  for (const tab of TABS) {
    const b = base.tabs?.[tab];
    const r = run.tabs?.[tab];
    if (!b || !r) {
      problems.push(`${tab}: missing from the ${b ? 'run' : 'baseline'} statuses`);
      continue;
    }
    for (const [who, x] of [['baseline', b], ['run', r]]) {
      if (x.unexpectedPending.length > 0) problems.push(`${tab}: the ${who} was captured with pending checks (${x.unexpectedPending.join(', ')}): capture it again`);
    }
    const now = new Map(r.checks.map((c) => [c.name, c.status]));
    const known = new Set(b.checks.map((c) => c.name));
    for (const c of b.checks) {
      const status = now.get(c.name);
      if (c.status === 'fail') problems.push(`${tab}: '${c.name}' fails in the baseline`);
      else if (status === undefined) problems.push(`${tab}: '${c.name}' is missing`);
      else if (status !== c.status) problems.push(`${tab}: '${c.name}' was ${c.status}, now ${status}`);
    }
    for (const c of r.checks) {
      if (known.has(c.name) || c.status === 'pass') continue;
      if (c.status === 'skip' && allowNewSkip.includes(c.name)) continue;
      problems.push(`${tab}: new check '${c.name}' is ${c.status}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function load(dir, file) {
  return parseJsonOutput(readFileSync(join(dir, file), 'utf8'));
}

export function main(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        base: { type: 'string' },
        run: { type: 'string' },
        mode: { type: 'string' },
        step: { type: 'string' },
        'allow-new-skip': { type: 'string', multiple: true },
      },
    }).values;
  } catch (err) {
    console.error(String(err));
    return 2;
  }
  const step = Number(args.step);
  if (!args.base || !args.run || !['B', 'C'].includes(args.mode) || ![0, 1, 2, 3, 4].includes(step)) {
    console.error("usage: node compare.mjs --base <dir> --run <dir> --mode B|C --step 0|1|2|3|4 [--allow-new-skip '<check>' ...]");
    return 2;
  }
  let ok = true;
  try {
    for (const tab of TABS) {
      const base = load(args.base, `${args.mode}-${tab}.json`);
      const run = load(args.run, `${args.mode}-${tab}.json`);
      const r = comparePixels(base, run, step);
      ok &&= r.ok;
      const sizes = r.excluded
        ? `excluded (${r.excluded})`
        : `C=${r.c} (grid ${r.gridInC}/${r.grid}) C\\T=${r.cMinusT} C∩T=${r.cAndT} movers ${base.movers.length}/${run.movers.length}`;
      console.log(`${args.mode} ${tab.padEnd(13)} ${r.ok ? 'OK  ' : 'FAIL'} ${sizes}`);
      for (const p of r.problems) console.log(`    ${p}`);
      for (const m of r.mismatches.slice(0, 8)) {
        console.log(`    point ${m.index} uv ${m.uv.map((x) => x.toFixed(4))}${m.inT ? ' (T)' : ''}: ${m.base} -> ${m.run}`);
      }
    }
    const s = compareStatuses(
      load(args.base, `statuses-${args.mode}.json`),
      load(args.run, `statuses-${args.mode}.json`),
      args['allow-new-skip'] ?? [],
    );
    ok &&= s.ok;
    console.log(`${args.mode} statuses      ${s.ok ? 'OK' : 'FAIL'}`);
    for (const p of s.problems) console.log(`    ${p}`);
  } catch (err) {
    console.error(String(err));
    return 2;
  }
  console.log(ok ? 'PASS' : 'FAIL');
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
