// ts/src/demo/transparent-sort-checks.ts — the checks on an
// `engine.debug.readTransparentSort()` answer (design 2026-09-27 §7.3.3).
//
// Every check reads the `frame` snapshot of the SAME answer: the CPU rows of
// the frame the GPU sorted, copied before any await. `verifySortReadback`
// covers (a)-(f) and (i); (g) is `sameIdOrder` over two answers read in
// consecutive frames; (h) is the churn scene of the 2D Twins tab.

import { extractFrustumPlanes, isSphereInFrustum } from '../camera';
import { CAP, PASSES, RADIX } from '../render/passes/transparent-sort-constants';
import { sortableZBits, digitOf, oracleOrder } from '../render/passes/transparent-sort-reference';
import type { TransparentSortReadback } from '../render/transparent-sort-probe';

const TRANSPARENT_BIT = 0x100;
/** Box shadow. 6 (Light2D), and every type the cull clamps to it, stays with LightAccumStage. */
const LAST_SORTED_TYPE = 5;
const LIGHT2D = 6;
const REGION_CLASSES = 12;
/** deriveLightGroups' conservative sphere test (light-groups.ts): every entity the GPU draws passes it. */
const ENLARGED = { scale: 1.01, add: 1e-3 };
/** The other side of the margin: every entity that passes it is certainly drawn. */
const REDUCED = { scale: 0.99, add: -1e-3 };
/** Offenders spelled out per failure; the rest are counted. */
const LISTED = 3;

/** The gather region of a row, 0-11 for types 0-5: type × 2 + (tier > 0 or overflow), as cull.wgsl files it. */
export function regionClass(meta1: number, texIndex: number): number {
  const type = Math.min(meta1 & 0xff, LIGHT2D);
  const tier = (texIndex >>> 16) & 7;
  const overflow = texIndex >>> 31;
  return type * 2 + (tier > 0 || overflow !== 0 ? 1 : 0);
}

/**
 * The failures of one answer, empty when it passes. `exactSet`: every
 * transparent row of type 0-5 inside the ENLARGED frustum must be gathered —
 * for scenes with nothing near the edge of the view. `requireAllRegions`:
 * all 12 (type, textured) classes must be non-empty.
 */
export function verifySortReadback(
  r: TransparentSortReadback,
  opts: { exactSet?: boolean; requireAllRegions?: boolean } = {},
): string[] {
  const { frame, n } = r;
  const { lo, hi, vals } = r.gathered;
  if (lo.length !== n || hi.length !== n || vals.length !== n || r.order.length !== n || r.digitBase.length !== PASSES * RADIX) {
    return [`readback shape: n ${n}, lo ${lo.length}, hi ${hi.length}, vals ${vals.length}, order ${r.order.length}, `
      + `digitBase ${r.digitBase.length} (want ${PASSES * RADIX})`];
  }
  const count = frame.entityCount;
  const failures: string[] = [];
  const report = (label: string, offenders: string[]): void => {
    if (offenders.length === 0) return;
    const more = offenders.length > LISTED ? ` (+${offenders.length - LISTED} more)` : '';
    failures.push(`${label}: ${offenders.slice(0, LISTED).join('; ')}${more}`);
  };
  const meta1 = (s: number): number => frame.renderMeta[s * 2 + 1];
  const sorted = (s: number): boolean => (meta1(s) & TRANSPARENT_BIT) !== 0 && (meta1(s) & 0xff) <= LAST_SORTED_TYPE;
  const planes = extractFrustumPlanes(frame.viewProjection);
  const b = frame.bounds;
  const inView = (s: number, margin: { scale: number; add: number }): boolean =>
    isSphereInFrustum(planes, b[s * 4], b[s * 4 + 1], b[s * 4 + 2], b[s * 4 + 3] * margin.scale + margin.add);
  const who = (s: number): string => `slot ${s} (id ${frame.entityIds[s]})`;

  // (a) The gathered set: unique slots of transparent primitives 0-5, and `order` a permutation of it.
  const gathered = new Set<number>();
  const badSet: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = vals[i];
    if (gathered.has(s)) badSet.push(`slot ${s} gathered twice`);
    gathered.add(s);
    if (s >= count) badSet.push(`slot ${s} is past entityCount ${count}`);
    else if (!sorted(s)) badSet.push(`slot ${s} is not a transparent primitive of type 0-5 (meta1 0x${meta1(s).toString(16)})`);
  }
  report('(a) gathered set', badSet);
  const orderSlots = Array.from(r.order).sort((x, y) => x - y);
  const valSlots = Array.from(vals).sort((x, y) => x - y);
  if (orderSlots.some((s, i) => s !== valSlots[i])) failures.push('(a) order is not a permutation of the gathered slots');

  // (b) Superset: nothing gathered that the GPU cull could not have kept.
  const outside: string[] = [];
  for (const s of gathered) if (s < count && !inView(s, ENLARGED)) outside.push(who(s));
  report('(b) gathered but outside the enlarged frustum', outside);

  // (c) Subset: nothing on screen left out. The exact set closes the margin.
  const missing: string[] = [];
  for (let s = 0; s < count; s++) {
    if (!sorted(s) || gathered.has(s)) continue;
    if (inView(s, opts.exactSet ? ENLARGED : REDUCED)) missing.push(who(s));
  }
  report(opts.exactSet
    ? '(c) in view (enlarged frustum, exact set) but not gathered'
    : '(c) on screen (reduced frustum) but not gathered', missing);

  // (d) Counts and the kernels' diagnostics.
  if (r.overflow) failures.push(`(d) overflow: raw ${r.raw} > limit ${r.limit}`);
  if (n !== r.raw) failures.push(`(d) n ${n} != raw ${r.raw}`);
  if (r.raw > frame.transparentCount) failures.push(`(d) raw ${r.raw} > transparentCount ${frame.transparentCount}`);
  const bound = Math.min(frame.transparentCount, CAP);
  if (r.limit !== bound) failures.push(`(d) limit ${r.limit} != min(transparentCount, CAP) ${bound}`);
  report('(d) diag', Array.from(r.diag).flatMap((w, k) => (w !== 0 ? [`diag[${k}] = 0x${w.toString(16)}`] : [])));

  // (e) Keys, element by element, recomputed from the frame: the id column,
  // and the z bits read as integers (no float operation touches them).
  const zBits = new Uint32Array(b.buffer, b.byteOffset, b.length);
  const keyLo = new Uint32Array(n);
  const keyHi = new Uint32Array(n);
  const badKeys: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = vals[i];
    if (s >= count) continue;
    keyLo[i] = frame.entityIds[s];
    keyHi[i] = sortableZBits(zBits[s * 4 + 2]);
    if (lo[i] !== keyLo[i]) badKeys.push(`lo[${i}] = ${lo[i]}, slot ${s} has id ${keyLo[i]}`);
    if (hi[i] !== keyHi[i]) badKeys.push(`hi[${i}] = 0x${hi[i].toString(16)}, slot ${s} has zKey 0x${keyHi[i].toString(16)}`);
  }
  report('(e) keys', badKeys);

  // (f) The order against the oracle on the recomputed keys, and digitBase
  // against the exclusive scan of each pass's digit histogram (order-free).
  const want = oracleOrder(vals, keyLo, keyHi, n);
  for (let i = 0; i < n; i++) {
    if (r.order[i] !== want[i]) {
      failures.push(`(f) order differs from the oracle at ${i}: slot ${r.order[i]}, the oracle has slot ${want[i]}`);
      break;
    }
  }
  for (let p = 0; p < PASSES; p++) {
    const hist = new Uint32Array(RADIX);
    for (let i = 0; i < n; i++) hist[digitOf(keyLo[i], keyHi[i], p)]++;
    let base = 0;
    for (let d = 0; d < RADIX; d++) {
      const got = r.digitBase[p * RADIX + d];
      if (got !== base) {
        failures.push(`(f) digitBase of pass ${p}, digit ${d}: ${got}, the exclusive scan gives ${base}`);
        break;
      }
      base += hist[d];
    }
  }

  // (i) Every gather region walked: the 12 (type, textured) classes all non-empty.
  if (opts.requireAllRegions) {
    const perClass = new Uint32Array(REGION_CLASSES);
    for (const s of gathered) {
      if (s >= count) continue;
      const c = regionClass(meta1(s), frame.texIndices[s]);
      if (c < REGION_CLASSES) perClass[c]++;
    }
    report('(i) empty region classes', Array.from(perClass).flatMap((k, c) =>
      (k === 0 ? [`type ${c >> 1} ${c & 1 ? 'textured' : 'untextured'}`] : [])));
  }
  return failures;
}

/** (g): the same external ids in the same order — slots may differ between the two frames. */
export function sameIdOrder(a: TransparentSortReadback, b: TransparentSortReadback): boolean {
  if (a.n !== b.n) return false;
  for (let i = 0; i < a.n; i++) {
    if (a.frame.entityIds[a.order[i]] !== b.frame.entityIds[b.order[i]]) return false;
  }
  return true;
}

/**
 * Reads answers until one satisfies `accept` (the frame holds the scene):
 * Mode B renders a state a tick behind, and a frame with no transparent
 * entity rejects the request. Any other rejection is thrown at once.
 */
export async function readSortFrame(
  read: () => Promise<TransparentSortReadback>,
  accept: (r: TransparentSortReadback) => boolean,
  timeoutMs: number,
  now: () => number = () => performance.now(),
): Promise<TransparentSortReadback> {
  const deadline = now() + timeoutMs;
  let last = 'no answer yet';
  while (now() < deadline) {
    try {
      const r = await read();
      if (accept(r)) return r;
      last = `frame ${r.frame.stamp} (tick ${r.frame.tickCount}) does not hold the scene`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no transparent entities this frame/.test(msg)) throw err;
      last = msg;
    }
  }
  throw new Error(`no served frame held the scene within ${timeoutMs} ms (last: ${last})`);
}
