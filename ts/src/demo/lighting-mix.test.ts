import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkMix, fp16Ulp, lightTexelCentre, listVerdict, mixOrderVerdict, mixReplacesVerdict, pointWeight,
  M_TARGET, P_COLOR, Q_COLOR, R_COLOR, ORDER_READS, type ListReads, type OrderRead, type SwapRead,
} from './lighting-mix';
import { createTestReporter } from './types';
import { Camera, orthographic } from '../camera';
import { CameraAPI } from '../camera-api';
import { composite, lightLayer, lightsBackToFront, straight, type LightBlend, type Rgb } from './blend-expect';
import type { Hyperion } from '../hyperion';
import type { EntityHandle } from '../entity-handle';
import type { Rgba } from './probe-checks';

// The Lighting tab's floor (ambient + its global light) under the sub-scene.
const F: Rgb = [0.185, 0.17, 0.295];
// The tab's ambient (lighting.ts, intensity 1) and its global light, an add light: F is their sum.
const AMBIENT: Rgb = [0.06, 0.07, 0.12];
const GLOBAL_LIGHT = { color: [0.25, 0.2, 0.35] as Rgb, energy: 0.5 };
// What the global light adds everywhere: F − AMBIENT.
const G: Rgb = [0.125, 0.1, 0.175];
const rgba = (c: readonly number[]): Rgba => [c[0], c[1], c[2], 1];
const sum = (...cs: Rgb[]): Rgb => cs.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]);

describe('fp16Ulp, pointWeight, lightTexelCentre', () => {
  it('fp16Ulp: 2^(floor(log2|v|) - 10), 2^-24 below the normal range', () => {
    expect(fp16Ulp(1)).toBe(2 ** -10);
    expect(fp16Ulp(2)).toBe(2 ** -9);
    expect(fp16Ulp(0.5)).toBe(2 ** -11);
    expect(fp16Ulp(-1.5)).toBe(2 ** -10);
    expect(fp16Ulp(0)).toBe(2 ** -24);
  });

  it('pointWeight: (1 - d/range)^falloff inside the range, 0 from it on; falloff 0 is 1 inside', () => {
    expect(pointWeight([1, 0], [0, 0], 4, 1)).toBeCloseTo(0.75, 12);
    expect(pointWeight([0, 2], [0, 0], 4, 2)).toBeCloseTo(0.25, 12);
    expect(pointWeight([3.9, 0], [0, 0], 4, 0)).toBe(1);
    expect(pointWeight([4, 0], [0, 0], 4, 0)).toBe(0);
  });

  it('lightTexelCentre: the centre of the light-buffer texel under a point, at most half a texel away', () => {
    const vp = orthographic(-160 / 9, 160 / 9, -10, 10, -1, 1000);
    const size: [number, number] = [960, 540];
    const texel = 20 / 540;  // world units per texel at this view
    for (const p of [[0.3, -0.7], [-10, 1], [5.55, 3.21]] as const) {
      const c = lightTexelCentre(p, vp, size);
      expect(Math.abs(c[0] - p[0])).toBeLessThanOrEqual(texel / 2 + 1e-9);
      expect(Math.abs(c[1] - p[1])).toBeLessThanOrEqual(texel / 2 + 1e-9);
      const again = lightTexelCentre(c, vp, size);
      expect(again[0]).toBeCloseTo(c[0], 9);
      expect(again[1]).toBeCloseTo(c[1], 9);
    }
  });
});

describe('mixReplacesVerdict', () => {
  const ws = [0.75, 0.5];
  const read = (partial: (w: number) => Rgb, full: Rgb = M_TARGET, global: Rgb = M_TARGET) => ({
    full: rgba(full),
    floor: rgba(F),
    partial: ws.map((w) => ({ read: rgba(partial(w)), w })),
    partialFloor: rgba(F),
    global: [rgba(global), rgba(global), rgba(global)],
  });
  const right = (w: number) => composite(F, [straight(M_TARGET, w)]);

  it('passes the rule: the target at weight 1, floor·(1 − w) + target·w, the whole layer as a global light', () => {
    const v = mixReplacesVerdict(read(right), F, M_TARGET);
    expect(v.ok).toBe(true);
    expect(v.detail).toContain('0.0 fp16 ULP from 2.000, 1.000, 0.500');
  });

  it('names the defect at weight 1: added like add, not drawn, the target clamped', () => {
    const cases: Array<[Rgb, string]> = [
      [sum(F, M_TARGET), 'the mix light is added like add'],
      [F, 'the mix light is not drawn'],
      [[1, 1, 0.5], 'the target is clamped at 1'],
    ];
    for (const [full, cause] of cases) {
      const v = mixReplacesVerdict(read(right, full), F, M_TARGET);
      expect(v.ok, cause).toBe(false);
      expect(v.detail).toContain(cause);
      for (const [, other] of cases.filter(([, c]) => c !== cause)) expect(v.detail).not.toContain(other);
    }
  });

  it('names the defect at a partial weight: the weight ignored, added like add, not premultiplied', () => {
    const cases: Array<[(w: number) => Rgb, string]> = [
      [() => M_TARGET, 'the weight is ignored'],
      [(w) => sum(F, M_TARGET.map((c) => c * w) as Rgb), 'added like add'],
      [(w) => sum(M_TARGET, F.map((c) => c * (1 - w)) as Rgb), 'not premultiplied'],
    ];
    for (const [partial, cause] of cases) {
      const v = mixReplacesVerdict(read(partial), F, M_TARGET);
      expect(v.ok, cause).toBe(false);
      expect(v.detail).toContain(cause);
      for (const [, other] of cases.filter(([, c]) => c !== cause)) expect(v.detail).not.toContain(other);
    }
  });

  it('fails when the global mix light does not bring the whole layer to its target', () => {
    const v = mixReplacesVerdict(read(right, M_TARGET, sum(F, M_TARGET)), F, M_TARGET);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('does not bring its whole layer to its target');
  });

  it('refuses partial points away from weights 0.75 and 0.5: a missing canvas snaps both to the view centre, w = 0', () => {
    // At w = 0 the reference is the floor itself, which FLOOR always matches.
    const at = (w0: number, w1: number) => mixReplacesVerdict({ ...read(right), partial: [w0, w1].map((w) => ({ read: rgba(right(w)), w })) }, F, M_TARGET);
    const centre = at(0, 0);
    expect(centre.ok).toBe(false);
    expect(centre.detail).toContain('the partial points sit at w 0.000 and 0.000, not 0.750 and 0.500');
    // The texel snapping moves a weight by up to 0.029 (half a texel's diagonal at 8 texels per unit, over range 3).
    expect(at(0.73, 0.52).ok).toBe(true);
    expect(at(0.75, 0.46).detail).toContain('the partial points sit at w 0.750 and 0.460');
  });

  it('prints the FLOOR the partial reads are judged against, and holds it to one fp16 ULP of the first FLOOR read', () => {
    expect(mixReplacesVerdict(read(right), F, M_TARGET).detail).toContain('target·w against FLOOR 0.185, 0.170, 0.295 read in the same frame');
    const moved: Rgb = sum(F, [0.1, 0.1, 0.1]);
    // Partial reads consistent with a reference moved by 0.1: every one within PARTIAL_TOL of it.
    const consistent = mixReplacesVerdict({ ...read((w) => composite(moved, [straight(M_TARGET, w)])), partialFloor: rgba(moved) }, F, M_TARGET);
    expect(consistent.ok).toBe(false);
    expect(consistent.detail).toContain('target·w against FLOOR 0.285, 0.270, 0.395 read in the same frame');
    expect(consistent.detail).toContain('the FLOOR read with the partial weights, 0.285, 0.270, 0.395, is not the FLOOR read first, 0.185, 0.170, 0.295');
    // Right reads against a moved reference: the reference shows why they fail.
    const moving = mixReplacesVerdict({ ...read(right), partialFloor: rgba(moved) }, F, M_TARGET);
    expect(moving.ok).toBe(false);
    expect(moving.detail).toContain('against FLOOR 0.285, 0.270, 0.395 read in the same frame');
    // One fp16 ULP apart is the same texel colour still.
    const ulp = F.map((c) => c + fp16Ulp(c)) as Rgb;
    expect(mixReplacesVerdict({ ...read((w) => composite(ulp, [straight(M_TARGET, w)])), partialFloor: rgba(ulp) }, F, M_TARGET).ok).toBe(true);
  });
});

describe('mixOrderVerdict', () => {
  const at = (front: Rgb, extra: Partial<Record<keyof OrderRead, Rgb>> = {}): OrderRead => ({
    pOnly: rgba(extra.pOnly ?? P_COLOR),
    overlap: rgba(extra.overlap ?? front),
    qOnly: rgba(extra.qOnly ?? Q_COLOR),
    rOnly: rgba(extra.rOnly ?? sum(F, R_COLOR)),
    floor: rgba(extra.floor ?? F),
  });
  const reads = (front: Rgb, extra: Partial<Record<keyof OrderRead, Rgb>> = {}) => Array.from({ length: ORDER_READS }, () => at(front, extra));
  // The read after the swap, with P's and Q's row z in its frame: by default the swapped depths, P at 2 and Q at 1.
  const swap = (front: Rgb, extra: Partial<Record<keyof OrderRead, Rgb>> = {}, rowZ = { p: -2, q: -1 }): SwapRead => ({ ...at(front, extra), rowZ });

  it('passes the rule: P over the overlap while nearer, Q after the swap; R under both', () => {
    const v = mixOrderVerdict(reads(P_COLOR), swap(Q_COLOR), F, AMBIENT);
    expect(v.ok).toBe(true);
    expect(v.detail).toContain('overlap P over 10 reads with P nearer, Q after the swap');
  });

  it('names the rule the overlap follows instead', () => {
    const cases: Array<[Rgb, Rgb, string]> = [
      [Q_COLOR, P_COLOR, 'the order is reversed'],
      [Q_COLOR, Q_COLOR, 'follows the ids or the slots'],
      [P_COLOR, P_COLOR, 'P stays on top'],
    ];
    for (const [before, after, cause] of cases) {
      const v = mixOrderVerdict(reads(before), swap(after), F, AMBIENT);
      expect(v.ok, cause).toBe(false);
      expect(v.detail).toContain(cause);
      for (const [, , other] of cases.filter(([, , c]) => c !== cause)) expect(v.detail).not.toContain(other);
    }
  });

  it('names a class order broken (R after the mix lights) and mix lights added like add', () => {
    // A floor with no global light (the ambient alone): P_ONLY reads P + R.
    const late = mixOrderVerdict(reads(sum(P_COLOR, R_COLOR), { pOnly: sum(P_COLOR, R_COLOR), qOnly: sum(Q_COLOR, R_COLOR) }),
      swap(sum(Q_COLOR, R_COLOR), { pOnly: sum(P_COLOR, R_COLOR), qOnly: sum(Q_COLOR, R_COLOR) }), F, F);
    expect(late.ok).toBe(false);
    expect(late.detail).toContain('R is drawn after the mix lights');
    expect(late.detail).not.toContain('added like add');
    const summed = sum(F, R_COLOR, P_COLOR);
    const added = mixOrderVerdict(reads(sum(F, R_COLOR, P_COLOR, Q_COLOR), { pOnly: summed }), swap(sum(F, R_COLOR, P_COLOR, Q_COLOR), { pOnly: summed }), F, AMBIENT);
    expect(added.ok).toBe(false);
    expect(added.detail).toContain('the mix lights are added like add');
    expect(added.detail).not.toContain('R is drawn after');
  });

  it("names a class order broken under the tab's global light, which is drawn after the mix lights too", () => {
    // The tab's real reads with mix before add (harness-check-auditor's executed mutant): P_ONLY = P + R + the global light's share.
    const pOnly = sum(P_COLOR, R_COLOR, G);
    const qOnly = sum(Q_COLOR, R_COLOR, G);
    const v = mixOrderVerdict(reads(pOnly, { pOnly, qOnly }), swap(qOnly, { pOnly, qOnly }), F, AMBIENT);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('before 0 (11 of 11 reads): R is drawn after the mix lights: add and sub come first '
      + '(P_ONLY − P = 0.125, 0.600, 0.175 = R + floor − ambient, R and the global light)');
    expect(v.detail).not.toContain('is not its own light');
    expect(v.detail).not.toContain('added like add');
  });

  it('fails an overlap that changes from read to read', () => {
    const before = reads(P_COLOR);
    before[4] = at(Q_COLOR);
    const v = mixOrderVerdict(before, swap(Q_COLOR), F, AMBIENT);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('changes from read to read');
  });

  it('names both phases, with the colour read in each, when the overlap is neither P nor Q', () => {
    const odd: Rgb = [0.7, 0.25, 0.7];
    const cases: Array<[Rgb, Rgb, string]> = [
      [Q_COLOR, odd, 'with P nearer 0.250, 0.250, 1.000 (Q, want P), after the swap 0.700, 0.250, 0.700 (neither, want Q)'],
      [odd, Q_COLOR, 'with P nearer 0.700, 0.250, 0.700 (neither, want P), after the swap 0.250, 0.250, 1.000 (Q)'],
      [odd, P_COLOR, 'with P nearer 0.700, 0.250, 0.700 (neither, want P), after the swap 1.000, 0.250, 0.250 (P, want Q)'],
    ];
    for (const [before, after, phases] of cases) {
      const v = mixOrderVerdict(reads(before), swap(after), F, AMBIENT);
      expect(v.ok).toBe(false);
      expect(v.detail).toContain(`the overlap is neither P nor Q in a phase: ${phases}`);
    }
  });

  it('gives each cause the values it judged, and prints a read before the swap too', () => {
    // R_ONLY and FLOOR wrong before the swap only, P_ONLY wrong in every read.
    const odd: Rgb = [0.5, 0.5, 0.5];
    const v = mixOrderVerdict(reads(P_COLOR, { pOnly: odd, rOnly: sum(F, [0, 0.25, 0]), floor: [0.1, 0.1, 0.1] }), swap(Q_COLOR, { pOnly: odd }), F, AMBIENT);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('before it (read 0) P_ONLY 0.500, 0.500, 0.500; Q_ONLY 0.250, 0.250, 1.000; R_ONLY 0.185, 0.420, 0.295; FLOOR 0.100, 0.100, 0.100; '
      + 'after it P_ONLY 0.500, 0.500, 0.500; Q_ONLY 0.250, 0.250, 1.000; R_ONLY 0.185, 0.670, 0.295; FLOOR 0.185, 0.170, 0.295');
    expect(v.detail).toContain('before 0 (11 of 11 reads): P_ONLY is not its own light (0.500, 0.500, 0.500 against P 1.000, 0.250, 0.250, 1024.0 fp16 ULP off)');
    expect(v.detail).toContain('before 0 (10 of 11 reads): R_ONLY is not floor + R (0.185, 0.420, 0.295 against 0.185, 0.670, 0.295)');
    expect(v.detail).toContain("before 0 (10 of 11 reads): FLOOR is not the tab's floor (0.100, 0.100, 0.100 against 0.185, 0.170, 0.295)");
  });

  it('names the values of the class-order and added-like-add causes too', () => {
    const late = mixOrderVerdict(reads(P_COLOR, { pOnly: sum(P_COLOR, R_COLOR) }), swap(Q_COLOR), F, F);
    expect(late.detail).toContain('R is drawn after the mix lights: add and sub come first (P_ONLY − P = 0.000, 0.500, 0.000 = R + floor − ambient, R and the global light)');
    const added = mixOrderVerdict(reads(P_COLOR, { qOnly: sum(F, R_COLOR, Q_COLOR) }), swap(Q_COLOR), F, AMBIENT);
    expect(added.detail).toContain('the mix lights are added like add (Q_ONLY 0.435, 0.920, 1.295 = floor + R + Q)');
  });

  it("prints P's and Q's row z after the swap, and names a stale list and a lost swap next to P's .transparent()", () => {
    const v = mixOrderVerdict(reads(P_COLOR), swap(P_COLOR), F, AMBIENT);
    expect(v.detail).toContain('after it P_ONLY 1.000, 0.250, 0.250; Q_ONLY 0.250, 0.250, 1.000; R_ONLY 0.185, 0.670, 0.295; FLOOR 0.185, 0.170, 0.295; row z P -2.000, Q -1.000');
    expect(v.detail).toContain('P stays on top whatever the depths: its .transparent() moves it after Q, the light list is stale '
      + '(its buffer rewritten only when the light count changes), or the swap never reached the rows (row z P -2.000, Q -1.000 after it; want -2.000, -1.000)');
    // The rows say which: here they never took the swap. The row z only informs: a light with no row reads 'none'.
    const lost = mixOrderVerdict(reads(P_COLOR), swap(P_COLOR, {}, { p: -1, q: -2 }), F, AMBIENT);
    expect(lost.detail).toContain('(row z P -1.000, Q -2.000 after it; want -2.000, -1.000)');
    const none = mixOrderVerdict(reads(P_COLOR), swap(Q_COLOR, {}, { p: NaN, q: -1 }), F, AMBIENT);
    expect(none.ok).toBe(true);
    expect(none.detail).toContain('row z P none, Q -1.000');
  });
});

describe('listVerdict', () => {
  const right: ListReads = {
    inside: rgba(M_TARGET), outside: rgba(F), limit: 1003, depths: { inside: 1002.985, outside: 1003.015 },
    overlap: rgba(Q_COLOR), slots: { p: 15, q: 13 }, ids: { p: 120, q: 121 }, rows: { ids: 16, count: 16 },
  };

  it('passes the rule: listed just inside the limit, not just outside; at equal depths the higher id, against the slots', () => {
    expect(listVerdict(right, F, M_TARGET).ok).toBe(true);
  });

  it('fails the grouping margin (drawn just outside), a light not drawn inside, and slot order', () => {
    const margin = listVerdict({ ...right, outside: rgba(M_TARGET) }, F, M_TARGET);
    expect(margin.ok).toBe(false);
    expect(margin.detail).toContain('still drawn');
    const missing = listVerdict({ ...right, inside: rgba(F) }, F, M_TARGET);
    expect(missing.detail).toContain('is not drawn');
    const slots = listVerdict({ ...right, overlap: rgba(P_COLOR) }, F, M_TARGET);
    expect(slots.ok).toBe(false);
    expect(slots.detail).toContain('follows the slots');
  });

  it('fails when the slots agree with the ids: the read cannot tell the two rules apart', () => {
    const v = listVerdict({ ...right, slots: { p: 13, q: 15 } }, F, M_TARGET);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('cannot tell the id rule from slot order');
  });

  it("prints M's listed limit, FAR_EPS and M's two depths, and the rows' ids against their count", () => {
    expect(listVerdict(right, F, M_TARGET).detail).toBe('M 2.000, 1.000, 0.500 just inside its listed limit, at depth 1002.985, '
      + 'and 0.185, 0.170, 0.295 just outside, at depth 1003.015 (limit 1003.000, the far plane + its range; FAR_EPS 0.015); '
      + 'overlap Q at equal depths; ids P 120, Q 121; slots P 15, Q 13; 16 ids for 16 rows');
  });

  it('tells M drawn off its target just inside its limit from M not drawn there', () => {
    // M under the tab's global light (the class order inverted, or the list drawn reversed): drawn, 358 ULP off.
    const off = listVerdict({ ...right, inside: rgba(sum(M_TARGET, G)) }, F, M_TARGET);
    expect(off.ok).toBe(false);
    expect(off.detail).toContain('M is drawn just inside its listed limit, but not at its target: 358.4 fp16 ULP off');
    expect(off.detail).not.toContain('is not drawn');
    // A clamped light buffer: drawn too.
    expect(listVerdict({ ...right, inside: rgba([1, 1, 0.5]) }, F, M_TARGET).detail).toContain('but not at its target: 512.0 fp16 ULP off');
    const missing = listVerdict({ ...right, inside: rgba(F) }, F, M_TARGET);
    expect(missing.detail).toContain('M is not drawn just inside its listed limit, the far plane + its range');
    expect(missing.detail).not.toContain('not at its target');
  });

  it('names a short ids column when P or Q has no slot', () => {
    const v = listVerdict({ ...right, slots: { p: -1, q: -1 }, rows: { ids: 13, count: 16 } }, F, M_TARGET);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('slots P -1, Q -1; 13 ids for 16 rows');
    expect(v.detail).toContain('P or Q has no slot in the rows read back: their ids column is short, 13 ids for 16 rows');
  });
});

// ── checkMix, end to end on a model of the light buffer ──────────────────────

interface FakeLight {
  type?: string;
  blend?: LightBlend;
  color?: readonly number[];
  energy?: number;
  range?: number;
  falloff?: number;
}

/**
 * A handle of the fake engine: it records what the check sets, and its row
 * moves like Rust's (swap-remove). `calls` logs depth, transparent, light
 * (`<type>/<falloff or ->`) and destroy, nothing else (not position); destroy
 * is idempotent, like EntityHandle.destroy(), and logs its first call only.
 */
interface FakeHandle {
  id: number;
  is2D: boolean;
  x: number;
  y: number;
  d: number;
  isTransparent: boolean;
  lightOptions: FakeLight | null;
  destroyed: boolean;
  calls: string[];
}

/** The light orders the model draws in: `modelEngine`'s doc says which is which. */
type Rule = 'list' | 'slot' | 'mixFirst';

/**
 * An engine whose probe reads a model of the light buffer: the ambient, then
 * every light the exact far-plane test keeps, in the order `rule` gives
 * ('list': the step-7 rule, blend-expect's oracle; 'slot': the rows;
 * 'mixFirst': the class order inverted, mix before add and sub, then back to
 * front and by id), each through lightLayer at its weight (pointWeight, a
 * global light 1). The tab's global light is one of them, as on the GPU: a 3D
 * add light at z 0, spawned before the sub-scene (slot 0, a lower id), never
 * culled. readEntityTransforms holds each row's translation (a 2D row's z is
 * −depth) and every id.
 */
function modelEngine(rule: Rule, opts: { probeUnavailable?: boolean } = {}) {
  const unavailable = 'The debug probe needs the main-thread renderer of a dev build';
  const global: FakeHandle = {
    id: 119, is2D: false, x: 500, y: 500, d: 0, isTransparent: false,
    lightOptions: { type: 'global', blend: 'add', ...GLOBAL_LIGHT }, destroyed: false, calls: [],
  };
  const rows: FakeHandle[] = [global];
  const handles: FakeHandle[] = [];
  const requests: Array<{ target: string; world: [number, number][]; layer?: number }> = [];
  let nextId = 120;
  const spawn = (opts?: { mode?: '2d' | '3d' }) => {
    const h: FakeHandle = { id: nextId++, is2D: opts?.mode === '2d', x: 0, y: 0, d: 0, isTransparent: false, lightOptions: null, destroyed: false, calls: [] };
    rows.push(h);
    handles.push(h);
    const api = {
      get id() { return h.id; },
      position: (x: number, y: number) => { h.x = x; h.y = y; return api; },
      scale: () => api,
      receivesLight: () => api,
      depth: (d: number) => { h.d = d; h.calls.push(`depth ${d}`); return api; },
      transparent: () => { h.isTransparent = true; h.calls.push('transparent'); return api; },
      light: (o: FakeLight) => { h.lightOptions = o; h.calls.push(`light ${o.type}/${o.falloff ?? '-'}`); return api; },
      destroy: () => {
        if (h.destroyed) return;
        h.destroyed = true;
        h.calls.push('destroy');
        const i = rows.indexOf(h);
        const last = rows.pop()!;
        if (last !== h) rows[i] = last;
      },
    };
    return api;
  };
  const cam = new CameraAPI(new Camera());
  cam.setOrthographic((20 * 1920) / 1080, 20);
  const lightBufferAt = ([x, y]: [number, number]): Rgba => {
    const vp = cam.viewProjection;
    const farDepth = (vp[14] - 1) / vp[10];
    const lights = rows.filter((h) => h.lightOptions !== null).map((h) => {
      const o = h.lightOptions!;
      const range = o.range ?? 100;
      const weight = o.type === 'global' ? 1 : pointWeight([x, y], [h.x, h.y], range, o.falloff ?? 1);
      const energy = o.energy ?? 1;
      const color = (o.color ?? [1, 1, 1]).map((c) => c * energy) as Rgb;
      return { h, blend: o.blend ?? 'add', depth: h.d, id: h.id, color, weight, listed: o.type === 'global' || h.d <= farDepth + range };
    }).filter((l) => l.listed);
    const mixLast = (l: { blend: LightBlend }): number => (l.blend === 'mix' ? 1 : 0);
    const ordered = rule === 'list' ? lightsBackToFront(lights)
      : rule === 'mixFirst' ? [...lights].sort((a, b) => (mixLast(b) - mixLast(a)) || (b.depth - a.depth) || (a.id - b.id))
      : lights;
    return rgba(composite(AMBIENT, ordered.map((l) => lightLayer(l))));
  };
  const probe = async (request: { target: string; world: [number, number][]; layer?: number }) => {
    requests.push(request);
    if (opts.probeUnavailable) throw new Error(unavailable);
    return { values: request.world.map(lightBufferAt) };
  };
  const readEntityTransforms = async () => {
    if (opts.probeUnavailable) throw new Error(unavailable);
    const cpuRows = new Float32Array(rows.length * 16);
    rows.forEach((h, s) => cpuRows.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, h.x, h.y, h.is2D ? -h.d : 0, 1], s * 16));
    return { entityIds: Uint32Array.from(rows.map((h) => h.id)), entityCount: rows.length, cpuRows, gpuRows: cpuRows, usedScatter: false };
  };
  const engine = {
    batch: (fn: () => void) => fn(), spawn, cam,
    lighting: { groups: { groups: [{ layers: 1, sdfSet: -1 }], sdfSets: [], layerToGroup: [0x10, 0] }, ambient: [...AMBIENT, 1] },
    debug: { probe, readEntityTransforms, readTransparentSort: async () => ({}) },
  } as unknown as Hyperion;
  return { engine, handles, rows, requests };
}

describe('checkMix', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubs = () => {
    vi.stubGlobal('document', { getElementById: () => ({ width: 1920, height: 1080 }) });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  };

  it('in Mode A: three skips, every handle destroyed, the view restored', async () => {
    stubs();
    const { engine, handles } = modelEngine('list', { probeUnavailable: true });
    const reporter = createTestReporter();
    const entities: EntityHandle[] = [];
    const restoreView = vi.fn();
    await checkMix(engine, reporter, entities, F, restoreView);
    expect(reporter.results().map(({ name, status }) => [name, status])).toEqual([
      ['Mix light replaces the light buffer', 'skip'],
      ['Mix order follows depth', 'skip'],
      ['Light list: exact cull, id at equal depth', 'skip'],
    ]);
    // The floor, M, R, P and Q.
    expect(handles).toHaveLength(5);
    expect(handles.every((h) => h.destroyed)).toBe(true);
    expect(entities).toHaveLength(5);
    expect(restoreView).toHaveBeenCalledTimes(1);
  });

  it('on the step-7 rule: three passes, every read on the floor group, and the scene put back', async () => {
    stubs();
    const { engine, handles, requests } = modelEngine('list');
    const reporter = createTestReporter();
    const restoreView = vi.fn();
    await checkMix(engine, reporter, [], F, restoreView);
    expect(reporter.results().map(({ name, status, detail }) => [name, status, status === 'pass' ? '' : detail])).toEqual([
      ['Mix light replaces the light buffer', 'pass', ''],
      ['Mix order follows depth', 'pass', ''],
      ['Light list: exact cull, id at equal depth', 'pass', ''],
    ]);
    // layerToGroup [0x10, 0]: layer 0 is group 0 (and layer 1 group 1): every read asks for the floor's.
    expect(new Set(requests.map((r) => `${r.target}#${r.layer}`))).toEqual(new Set(['light-buffer#0']));
    // The first check reports the frame's groups and SDF sets (report only, never gated).
    expect(reporter.results()[0].detail).toContain('1 group, 0 SDF sets');
    const [, m, r, p, q] = handles;
    expect(r.calls).toEqual(['depth 0.5', 'light point/0', 'destroy']);
    // P nearer, then the swap, then equal depths; `.transparent()` must not move P after Q.
    expect(p.calls).toEqual(['depth 1', 'transparent', 'light point/0', 'depth 2', 'depth 1', 'destroy']);
    expect(q.calls).toEqual(['depth 2', 'light point/0', 'depth 1', 'depth 1', 'destroy']);
    // Weight 1, weight w, global, back to weight 1; then just inside and just outside its listed limit, and despawned.
    expect(m.calls.slice(0, 4)).toEqual(['light point/0', 'light point/1', 'light global/-', 'light point/0']);
    expect(m.calls.slice(4, 6).map((c) => Number(c.split(' ')[1]))).toEqual([expect.closeTo(1002.985, 3), expect.closeTo(1003.015, 3)]);
    expect(m.calls.at(-1)).toBe('destroy');
    expect(handles.every((h) => h.destroyed)).toBe(true);
    expect(restoreView).toHaveBeenCalledTimes(1);
    // What the details print from the rows and the view: P's and Q's row z after the swap, M's listed
    // limit, the ids column (the tab's global light, the floor, Q, R and P after M's despawn).
    const [replaces, order, list] = reporter.results();
    expect(replaces.detail).toContain('against FLOOR 0.185, 0.170, 0.295 read in the same frame');
    expect(order.detail).toContain('row z P -2.000, Q -1.000');
    expect(list.detail).toContain('(limit 1003.000, the far plane + its range; FAR_EPS 0.015)');
    expect(list.detail).toContain('slots P 4, Q 2; 5 ids for 5 rows');
  });

  it('on slot order (the cull of a small scene on a 32-lane GPU): the order and the tie fail', async () => {
    stubs();
    const { engine } = modelEngine('slot');
    const reporter = createTestReporter();
    await checkMix(engine, reporter, [], F, vi.fn());
    expect(reporter.results().map(({ name, status }) => [name, status])).toEqual([
      ['Mix light replaces the light buffer', 'pass'],
      ['Mix order follows depth', 'fail'],
      ['Light list: exact cull, id at equal depth', 'fail'],
    ]);
    expect(reporter.results()[2].detail).toContain('follows the slots');
  });

  it("on the class order inverted, mix before add, under the tab's global light: the checks name the class order and M drawn off its target", async () => {
    stubs();
    const { engine } = modelEngine('mixFirst');
    const reporter = createTestReporter();
    await checkMix(engine, reporter, [], F, vi.fn());
    const [replaces, order, list] = reporter.results();
    expect([replaces.status, order.status, list.status]).toEqual(['fail', 'fail', 'fail']);
    // R and the global light both land on P after it: the reads the M2 would give, not P + R.
    expect(order.detail).toContain('R is drawn after the mix lights: add and sub come first (P_ONLY − P = 0.125, 0.600, 0.175 = R + floor − ambient, R and the global light)');
    expect(order.detail).not.toContain('is not its own light');
    expect(list.detail).toContain('M is drawn just inside its listed limit, but not at its target');
    expect(list.detail).not.toContain('M is not drawn');
  });
});
