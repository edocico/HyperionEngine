import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkMix, fp16Ulp, lightTexelCentre, lightTexelsPerUnit, listVerdict, mixOrderVerdict, mixReplacesVerdict, pointWeight,
  M_TARGET, P_COLOR, Q_COLOR, R_COLOR, ORDER_READS, type ListReads, type MixReads, type OrderRead, type SwapRead,
} from './lighting-mix';
import { createTestReporter } from './types';
import { Camera, orthographic } from '../camera';
import { CameraAPI } from '../camera-api';
import { composite, lightLayer, lightsBackToFront, over, straight, type LightBlend, type Rgb } from './blend-expect';
import { BLEND_MIX, deriveLightGroups } from '../render/light-groups';
import type { Hyperion } from '../hyperion';
import { RenderPrimitiveType, type EntityHandle } from '../entity-handle';
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

/**
 * `x` rounded toward zero to an fp16 value: how the M2 stores its light-buffer
 * blends. The grow gate's centres (docs/plans/assets/2026-10-08-step7/
 * gate-m2-grow-B.json), one add blend over the ambient each, sit on the
 * largest fp16 at or below the exact sum; harness-task5-B.json's R_ONLY, two
 * add blends, reads 0.669 in green where rounding each to nearest gives 0.670.
 * Math.f16round rounds to nearest.
 */
function f16TowardZero(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  const a = Math.abs(x);
  if (a >= 65504) return Math.sign(x) * 65504;
  // floor(log2) can land one too high just below a power of two.
  let e = Math.floor(Math.log2(a));
  if (2 ** e > a) e--;
  else if (2 ** (e + 1) <= a) e++;
  const ulp = 2 ** (Math.max(e, -14) - 10);
  return Math.sign(x) * Math.floor(a / ulp) * ulp;
}

describe("f16TowardZero (the model's fp16 rounding)", () => {
  it('keeps every fp16 value and takes any other to the next fp16 value toward zero', () => {
    for (const v of [1, 0.25, 2, 1.5, 0.669921875, 2 ** -24, 3 * 2 ** -20, -0.5]) expect(f16TowardZero(v)).toBe(v);
    expect(f16TowardZero(0.67)).toBe(0.669921875);
    expect(f16TowardZero(0.1)).toBe(0.0999755859375);
    // Round to nearest gives -0.300048828125 and 0.0001000165939331: toward zero stays below in magnitude.
    expect(f16TowardZero(-0.3)).toBe(-0.2998046875);
    expect(f16TowardZero(1e-4)).toBe(0.00009995698928833008);
    // Just below a power of two, where floor(log2) is one too high.
    expect(f16TowardZero(8 - 2 ** -49)).toBe(8 - 2 ** -8);
    expect(f16TowardZero(1.5 * 2 ** -24)).toBe(2 ** -24);
  });
});

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

  it("lightTexelsPerUnit: the light buffer's texels per world unit on its coarser axis", () => {
    // The 1080p view, 35.56 x 20 units: 960 x 540 texels are 27 per unit on both axes (vp is f32: 5 digits).
    const vp = orthographic(-160 / 9, 160 / 9, -10, 10, -1, 1000);
    expect(lightTexelsPerUnit(vp, [960, 540])).toBeCloseTo(27, 5);
    expect(lightTexelsPerUnit(vp, [480, 540])).toBeCloseTo(13.5, 5);
    expect(lightTexelsPerUnit(vp, [960, 270])).toBeCloseTo(13.5, 5);
    // A missing canvas: halfResolution gives a 1 x 1 light buffer.
    expect(lightTexelsPerUnit(vp, [1, 1])).toBeCloseTo(9 / 320, 5);
  });
});

describe('mixReplacesVerdict', () => {
  const ws = [0.75, 0.5];
  // The M2's 1960 x 1248 canvas: a light buffer 980 texels wide over the 35.2 units fitView shows.
  const M2_DENSITY = 980 / 35.2;
  const read = (partial: (w: number) => Rgb, full: Rgb = M_TARGET, global: Rgb = M_TARGET): MixReads => ({
    full: rgba(full),
    floor: rgba(F),
    partial: ws.map((w) => ({ read: rgba(partial(w)), w })),
    partialFloor: rgba(F),
    global: [rgba(global), rgba(global), rgba(global)],
    texelsPerUnit: M2_DENSITY,
  });
  const right = (w: number) => composite(F, [straight(M_TARGET, w)]);
  const below = "below the partial weights' validated domain (8 and up)";

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
    const at = (w0: number, w1: number, texelsPerUnit = M2_DENSITY) =>
      mixReplacesVerdict({ ...read(right), partial: [w0, w1].map((w) => ({ read: rgba(right(w)), w })), texelsPerUnit }, F, M_TARGET);
    // No canvas: a 1 x 1 light buffer over the 35.56 units of the 1080p view, far below 8 texels per unit.
    const centre = at(0, 0, 9 / 320);
    expect(centre.ok).toBe(false);
    expect(centre.detail).toContain('the partial points sit at w 0.000 and 0.000, not 0.750 and 0.500 '
      + '(the texel snapping moves a weight by at most 0.029 from 8 texels per unit up; this light buffer has 0.028)');
    expect(centre.detail).toContain(`light buffer 0.028 texels per world unit, ${below}`);
    // The texel snapping moves a weight by up to 0.029 (half a texel's diagonal at 8 texels per unit, over range 3).
    expect(at(0.73, 0.52).ok).toBe(true);
    expect(at(0.75, 0.46).detail).toContain('the partial points sit at w 0.750 and 0.460');
    // At the M2's density too: no other weight passes, however dense the light buffer.
    expect(at(0, 0).ok).toBe(false);
  });

  it("prints the light buffer's texels per world unit, and marks a run below 8, where the snapping alone can refuse correct code", () => {
    // The weights the texel centres get on a 305 x 612 canvas (4.318 texels per unit), read where the shader evaluated them.
    const coarse: MixReads = { ...read(right), partial: [0.713, 0.483].map((w) => ({ read: rgba(right(w)), w })), texelsPerUnit: 152 / 35.2 };
    const refused = mixReplacesVerdict(coarse, F, M_TARGET);
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain('target·w against FLOOR 0.185, 0.170, 0.295 read in the same frame; '
      + `light buffer 4.318 texels per world unit, ${below}, where the texel snapping alone can move a weight by more than 0.029 and fail correct code; global`);
    expect(refused.detail).toContain('the partial points sit at w 0.713 and 0.483, not 0.750 and 0.500 '
      + '(the texel snapping moves a weight by at most 0.029 from 8 texels per unit up; this light buffer has 4.318)');
    // The M2's 28 texels per unit, weights 0.750 and 0.498: no mark.
    const m2 = mixReplacesVerdict({ ...read(right), partial: [0.75, 0.498].map((w) => ({ read: rgba(right(w)), w })) }, F, M_TARGET);
    expect(m2.ok).toBe(true);
    expect(m2.detail).toContain('read in the same frame; light buffer 27.841 texels per world unit; global');
    expect(m2.detail).not.toContain('below the');
    // 8 is the domain's edge, inside it.
    expect(mixReplacesVerdict({ ...read(right), texelsPerUnit: 8 }, F, M_TARGET).detail).not.toContain('below the');
  });

  it('the texels per unit change no verdict, and only add their part to the detail', () => {
    const densityPart = /; light buffer [^;]*/;
    const fixtures: MixReads[] = [
      read(right), read(() => M_TARGET), read(right, F), read(right, M_TARGET, sum(F, M_TARGET)),
      { ...read(right), partial: [0.713, 0.483].map((w) => ({ read: rgba(right(w)), w })) },
      { ...read(right), partial: [0, 0].map((w) => ({ read: rgba(right(w)), w })) },
      { ...read(right), partialFloor: rgba(sum(F, [0.1, 0.1, 0.1])) },
    ];
    for (const [i, f] of fixtures.entries()) {
      const at = (texelsPerUnit: number) => mixReplacesVerdict({ ...f, texelsPerUnit }, F, M_TARGET);
      const dense = at(M2_DENSITY);
      for (const texelsPerUnit of [8, 7.99, 152 / 35.2, 9 / 320]) {
        const v = at(texelsPerUnit);
        expect(v.ok, `fixture ${i} at ${texelsPerUnit} texels per unit`).toBe(dense.ok);
        expect(v.detail.replace(densityPart, '').replace(/; this light buffer has [\d.]+/, ''), `fixture ${i}`)
          .toBe(dense.detail.replace(densityPart, '').replace(/; this light buffer has [\d.]+/, ''));
      }
    }
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
  // The read after the swap, with P's and Q's row z in its frame: by default the swapped depths, P at 3 and Q at 2.
  const swap = (front: Rgb, extra: Partial<Record<keyof OrderRead, Rgb>> = {}, rowZ = { p: -3, q: -2 }): SwapRead => ({ ...at(front, extra), rowZ });

  it('passes the rule: P over the overlap while nearer, Q after the swap; R under both', () => {
    const v = mixOrderVerdict(reads(P_COLOR), swap(Q_COLOR), F, AMBIENT);
    expect(v.ok).toBe(true);
    expect(v.detail).toContain('overlap P over 10 reads with P nearer, Q after the swap');
  });

  it('refuses the read after the swap unless its rows hold both swapped depths, whatever the overlap shows', () => {
    // P 1 -> 3 and Q 4 -> 2: P's change lost, Q's lost, both lost, and a swap that left both lights at P's old
    // depth (where Q, the higher id, is on top by the tie-break).
    for (const rowZ of [{ p: -1, q: -2 }, { p: -3, q: -4 }, { p: -1, q: -4 }, { p: -1, q: -1 }, { p: -3.001, q: -2 }]) {
      const v = mixOrderVerdict(reads(P_COLOR), swap(Q_COLOR, {}, rowZ), F, AMBIENT);
      expect(v.ok, JSON.stringify(rowZ)).toBe(false);
      expect(v.detail).toContain(`the depth swap did not reach the rows: row z P ${rowZ.p.toFixed(3)}, Q ${rowZ.q.toFixed(3)} after it, `
        + 'want -3.000, -2.000');
    }
    // A light with no row (NaN) is only printed: the other one is still checked.
    expect(mixOrderVerdict(reads(P_COLOR), swap(Q_COLOR, {}, { p: NaN, q: -2 }), F, AMBIENT).ok).toBe(true);
    expect(mixOrderVerdict(reads(P_COLOR), swap(Q_COLOR, {}, { p: NaN, q: -4 }), F, AMBIENT).detail)
      .toContain('the depth swap did not reach the rows: row z P none, Q -4.000 after it, want -3.000, -2.000');
    // The full swap passes, and so does a row within 1e-6 of it.
    expect(mixOrderVerdict(reads(P_COLOR), swap(Q_COLOR), F, AMBIENT).ok).toBe(true);
    expect(mixOrderVerdict(reads(P_COLOR), swap(Q_COLOR, {}, { p: -3 - 5e-7, q: -2 + 5e-7 }), F, AMBIENT).ok).toBe(true);
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

  it('names the nearer of the class order and added like add: with an ambient within TOL only it tells them apart', () => {
    // floor + R + P (added like add) lies 0.02 from P + R + (floor − ambient) (the class order) in every channel.
    const ambient: Rgb = [0.02, 0.02, 0.02];
    const summed = sum(F, R_COLOR, P_COLOR);
    const added = mixOrderVerdict(reads(P_COLOR, { pOnly: summed }), swap(Q_COLOR, { pOnly: summed }), F, ambient);
    expect(added.ok).toBe(false);
    expect(added.detail).toContain('the mix lights are added like add (P_ONLY 1.185, 0.920, 0.545 = floor + R + P)');
    expect(added.detail).not.toContain('R is drawn after');
    // The class order, under the same ambient: nearer its own formula, named as before.
    const late = sum(P_COLOR, R_COLOR, F.map((c, i) => c - ambient[i]) as Rgb);
    const order = mixOrderVerdict(reads(P_COLOR, { pOnly: late }), swap(Q_COLOR, { pOnly: late }), F, ambient);
    expect(order.ok).toBe(false);
    expect(order.detail).toContain('R is drawn after the mix lights: add and sub come first (P_ONLY − P = 0.165, 0.650, 0.275 = R + floor − ambient');
    expect(order.detail).not.toContain('added like add');
    // No ambient: the two formulas are one, and the tie names the class order.
    const tie = mixOrderVerdict(reads(P_COLOR, { pOnly: summed }), swap(Q_COLOR, { pOnly: summed }), F, [0, 0, 0]);
    expect(tie.ok).toBe(false);
    expect(tie.detail).toContain('R is drawn after the mix lights: add and sub come first');
    expect(tie.detail).not.toContain('added like add');
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

  it("prints P's and Q's row z after the swap, and offers a lost swap next to P's .transparent() and a stale list only where a row is missing", () => {
    // Both rows hold the swap: the rule does not offer a swap that never reached them.
    const v = mixOrderVerdict(reads(P_COLOR), swap(P_COLOR), F, AMBIENT);
    expect(v.detail).toContain('after it P_ONLY 1.000, 0.250, 0.250; Q_ONLY 0.250, 0.250, 1.000; R_ONLY 0.185, 0.670, 0.295; FLOOR 0.185, 0.170, 0.295; row z P -3.000, Q -2.000');
    expect(v.detail).toContain('P stays on top whatever the depths: its .transparent() moves it after Q, or the light list is stale '
      + '(its buffer rewritten only when the light count changes)');
    expect(v.detail).not.toContain('the swap never reached the rows');
    expect(v.detail).not.toContain('the depth swap did not reach the rows');
    // Both rows present, off the swap: the read is refused for it, and the rows are named once.
    const lost = mixOrderVerdict(reads(P_COLOR), swap(P_COLOR, {}, { p: -1, q: -4 }), F, AMBIENT);
    expect(lost.detail).toContain('P stays on top whatever the depths: its .transparent() moves it after Q, or the light list is stale '
      + '(its buffer rewritten only when the light count changes)');
    expect(lost.detail).toContain('the depth swap did not reach the rows: row z P -1.000, Q -4.000 after it, want -3.000, -2.000');
    expect(lost.detail).not.toContain('the swap never reached the rows');
    // A row missing and the other at its depth: the rows cannot decide, and the rule still offers a lost swap.
    const missing = mixOrderVerdict(reads(P_COLOR), swap(P_COLOR, {}, { p: NaN, q: -2 }), F, AMBIENT);
    expect(missing.detail).toContain('P stays on top whatever the depths: its .transparent() moves it after Q, the light list is stale '
      + '(its buffer rewritten only when the light count changes), or the swap never reached the rows (row z P none, Q -2.000 after it; want -3.000, -2.000)');
    expect(missing.detail).not.toContain('the depth swap did not reach the rows');
    // A row missing and the other off its depth: the refusal names the rows, the rule does not.
    const missed = mixOrderVerdict(reads(P_COLOR), swap(P_COLOR, {}, { p: NaN, q: -4 }), F, AMBIENT);
    expect(missed.detail).toContain('the depth swap did not reach the rows: row z P none, Q -4.000 after it, want -3.000, -2.000');
    expect(missed.detail).not.toContain('the swap never reached the rows');
    // A light with no row reads 'none'.
    const none = mixOrderVerdict(reads(P_COLOR), swap(Q_COLOR, {}, { p: NaN, q: -2 }), F, AMBIENT);
    expect(none.ok).toBe(true);
    expect(none.detail).toContain('row z P none, Q -2.000');
  });
});

describe('listVerdict', () => {
  const right: ListReads = {
    inside: rgba(M_TARGET), outside: rgba(F), limit: 1003, depths: { inside: 1002.985, outside: 1003.015 },
    mRowZ: { inside: -1002.985, outside: -1003.015 }, mListed: { inside: true, outside: false },
    overlap: rgba(Q_COLOR), slots: { p: 15, q: 13 }, ids: { p: 120, q: 121 }, rowZ: { p: -1, q: -1 }, rows: { ids: 16, count: 16 },
  };
  const margin = "M is still drawn just outside its listed limit, listed though outside: the list's test keeps it "
    + "(the grouping's margin instead of the cull's exact test, or a bounds z other than M's row z)";

  it('passes the rule: listed just inside the limit, not just outside; at equal depths the higher id, against the slots', () => {
    expect(listVerdict(right, F, M_TARGET).ok).toBe(true);
  });

  it('fails the grouping margin (drawn just outside), a light not drawn inside, and slot order', () => {
    // A list with the grouping's margin keeps M just outside its limit, and draws it.
    const kept = listVerdict({ ...right, outside: rgba(M_TARGET), mListed: { inside: true, outside: true } }, F, M_TARGET);
    expect(kept.ok).toBe(false);
    expect(kept.detail).toContain(margin);
    expect(kept.detail).not.toContain("M's depth did not reach its row");
    const missing = listVerdict({ ...right, inside: rgba(F) }, F, M_TARGET);
    expect(missing.detail).toContain('is not drawn');
    const slots = listVerdict({ ...right, overlap: rgba(P_COLOR) }, F, M_TARGET);
    expect(slots.ok).toBe(false);
    expect(slots.detail).toContain('follows the slots');
  });

  it("blames M's depth, not the list, for M drawn just outside when M's row z is not -depth there", () => {
    // M's SetDepth lost (M left at depth 0, so listed and drawn), or a 2D depth clamped to 1000.
    const cases: Array<[{ inside: number; outside: number }, string]> = [
      [{ inside: 0, outside: 0 }, "M's depth did not reach its row (row z 0.000, set depth 1003.015)"],
      [{ inside: -1000, outside: -1000 }, "M's depth did not reach its row (row z -1000.000, set depth 1003.015)"],
    ];
    for (const [mRowZ, cause] of cases) {
      const v = listVerdict({ ...right, outside: rgba(M_TARGET), mRowZ, mListed: { inside: true, outside: true } }, F, M_TARGET);
      expect(v.ok).toBe(false);
      expect(v.detail).toContain(cause);
      expect(v.detail).not.toContain("grouping's margin");
    }
    // The f32 row of a depth that did reach it (1003.015 is no f32 integer): within 1e-3, so the list is named.
    const f32 = listVerdict({ ...right, outside: rgba(M_TARGET), mRowZ: { inside: Math.fround(-1002.985), outside: Math.fround(-1003.015) },
      mListed: { inside: true, outside: true } }, F, M_TARGET);
    expect(f32.detail).toContain(margin);
    expect(f32.detail).not.toContain("M's depth did not reach its row");
  });

  it("refuses the inside read when M's row z there is not -depth, whatever M_IN shows", () => {
    // M's first runtime SetDepth lost: M left at depth 0, drawn at its target, never near its limit.
    const lost = listVerdict({ ...right, mRowZ: { inside: 0, outside: -1003.015 } }, F, M_TARGET);
    expect(lost.ok).toBe(false);
    expect(lost.detail).toContain("M's depth did not reach its row at the inside read (row z 0.000, set depth 1002.985)");
    // A depth that went past the limit leaves M undrawn: its depth is named, not the list.
    const past = listVerdict({ ...right, inside: rgba(F), mRowZ: { inside: -2005.97, outside: -1003.015 } }, F, M_TARGET);
    expect(past.ok).toBe(false);
    expect(past.detail).toContain("M's depth did not reach its row at the inside read (row z -2005.970, set depth 1002.985)");
    expect(past.detail).not.toContain('M is not drawn just inside its listed limit');
    // Correct reads still pass, on the f32 rows the engine writes too; a missing row is only printed.
    expect(listVerdict(right, F, M_TARGET).ok).toBe(true);
    expect(listVerdict({ ...right, mRowZ: { inside: Math.fround(-1002.985), outside: Math.fround(-1003.015) } }, F, M_TARGET).ok).toBe(true);
    expect(listVerdict({ ...right, mRowZ: { inside: NaN, outside: -1003.015 } }, F, M_TARGET).ok).toBe(true);
  });

  it('blames LightAccumStage for M drawn just outside its limit though the list left it out', () => {
    const v = listVerdict({ ...right, outside: rgba(M_TARGET) }, F, M_TARGET);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('M is still drawn just outside its listed limit, drawn though unlisted: LightAccumStage draws beyond the list');
    expect(v.detail).not.toContain("grouping's margin");
  });

  it('fails when the slots agree with the ids: the read cannot tell the two rules apart', () => {
    const v = listVerdict({ ...right, slots: { p: 13, q: 15 } }, F, M_TARGET);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('cannot tell the id rule from slot order');
  });

  it("names the slots or the ids reversed when the lower id is on top, and P's .transparent() too when it is P", () => {
    // Where the slots and the ids disagree the lower id has the later slot: a reversed id tie-break puts it on top as
    // surely as slot order does. P (.transparent()) has the lower id: a transparent-last order puts it on top too.
    const p = listVerdict({ ...right, overlap: rgba(P_COLOR) }, F, M_TARGET);
    expect(p.ok).toBe(false);
    expect(p.detail).toContain('at equal depths P, the lower id, is on top: the order follows the slots or the ids reversed '
      + "(one read cannot tell those two apart), or P's .transparent() moves it after Q (check 'Mix order follows depth' tells that one apart)");
    // Q with the lower id and the later slot: P's .transparent() would put P on top, not Q.
    const q = listVerdict({ ...right, overlap: rgba(Q_COLOR), ids: { p: 121, q: 120 }, slots: { p: 13, q: 15 } }, F, M_TARGET);
    expect(q.ok).toBe(false);
    expect(q.detail).toContain('at equal depths Q, the lower id, is on top: the order follows the slots or the ids reversed '
      + '(one read cannot tell those two apart)');
    expect(q.detail).not.toContain('.transparent()');
  });

  it("prints M's listed limit, FAR_EPS, M's two depths with its row z and listing at each, P's and Q's row z, and the rows' ids against their count", () => {
    expect(listVerdict(right, F, M_TARGET).detail).toBe('M 2.000, 1.000, 0.500 just inside its listed limit, at depth 1002.985 (row z -1002.985, listed), '
      + 'and 0.185, 0.170, 0.295 just outside, at depth 1003.015 (row z -1003.015, unlisted) (limit 1003.000, the far plane + its range; FAR_EPS 0.015); '
      + 'overlap Q at equal depths (row z P -1.000, Q -1.000); ids P 120, Q 121; slots P 15, Q 13; 16 ids for 16 rows');
    // M with no row: 'none'.
    expect(listVerdict({ ...right, mRowZ: { inside: NaN, outside: NaN } }, F, M_TARGET).detail)
      .toContain('at depth 1002.985 (row z none, listed), and 0.185, 0.170, 0.295 just outside, at depth 1003.015 (row z none, unlisted)');
  });

  it('refuses the tie unless P and Q hold the same z in the rows read in its frame, whichever light is on top', () => {
    // Q's SetDepth reached its row (z -1) and P's did not, P left farther (at 3, its depth after the swap, or
    // at 2): Q, nearer, is on top by depth, and the tie-break is never tested.
    for (const rowZ of [{ p: -2, q: -1 }, { p: -3, q: -1 }]) {
      const v = listVerdict({ ...right, rowZ }, F, M_TARGET);
      expect(v.ok, JSON.stringify(rowZ)).toBe(false);
      expect(v.detail).toContain(`P and Q are not at equal depths in the rows (row z P ${rowZ.p.toFixed(3)}, Q -1.000)`);
    }
    // P's reached and Q's did not: P, nearer, is on top, and the order is not blamed for it.
    const lost = listVerdict({ ...right, overlap: rgba(P_COLOR), rowZ: { p: -1, q: -2 } }, F, M_TARGET);
    expect(lost.ok).toBe(false);
    expect(lost.detail).toContain('overlap P at equal depths (row z P -1.000, Q -2.000)');
    expect(lost.detail).toContain('P and Q are not at equal depths in the rows (row z P -1.000, Q -2.000)');
    expect(lost.detail).not.toContain('the lower id');
    // A light with no row: 'none', and the missing slot is what is named.
    const none = listVerdict({ ...right, slots: { p: -1, q: 13 }, rowZ: { p: NaN, q: -1 } }, F, M_TARGET);
    expect(none.detail).toContain('(row z P none, Q -1.000)');
    expect(none.detail).toContain('P or Q has no slot in the rows read back');
    expect(none.detail).not.toContain('not at equal depths');
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
 * moves like Rust's (swap-remove). `calls` logs depth (a lost one too),
 * transparent, light (`<type>/<falloff or ->`) and destroy, nothing else (not
 * position); destroy is idempotent, like EntityHandle.destroy(), and logs its
 * first call only.
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
type Rule = 'list' | 'slot' | 'mixFirst' | 'transparentLast' | 'bucket' | 'idDesc';

/**
 * An engine whose probe reads a model of the light buffer: the ambient, then
 * every light the exact far-plane test keeps, in the order `rule` gives
 * ('list': the step-7 rule, blend-expect's oracle; 'slot': the rows;
 * 'mixFirst': the class order inverted, mix before add and sub, then back to
 * front and by id; 'transparentLast': the class, then `.transparent()` last,
 * then back to front and by id; 'bucket': the cull's buckets as master drew
 * the lights on a 32-lane GPU, opaque rows then transparent rows, each in slot
 * order; 'idDesc': the step-7 rule with its id tie-break reversed, the lower
 * id drawn last), each through lightLayer at its weight (pointWeight, a
 * global light 1). The tab's global light is one of them, as on the GPU: a 3D
 * add light at z 0, spawned before the sub-scene (slot 0, a lower id), never
 * culled.
 * readEntityTransforms holds each row's translation (a 2D row's z is −depth)
 * and every id. With `fp16TowardZero` each blend's result is stored as the M2
 * stores it, rounded toward zero to fp16; without it, exact. With `lostDepth`,
 * the `depth()` calls of the lights named there after the spawn batch never
 * reach their rows: a runtime SetDepth lost.
 */
function modelEngine(rule: Rule, opts: { probeUnavailable?: boolean; fp16TowardZero?: boolean; lostDepth?: ReadonlyArray<'M' | 'P' | 'Q'> } = {}) {
  const unavailable = 'The debug probe needs the main-thread renderer of a dev build';
  const global: FakeHandle = {
    id: 119, is2D: false, x: 500, y: 500, d: 0, isTransparent: false,
    lightOptions: { type: 'global', blend: 'add', ...GLOBAL_LIGHT }, destroyed: false, calls: [],
  };
  const rows: FakeHandle[] = [global];
  const handles: FakeHandle[] = [];
  const requests: Array<{ target: string; world: [number, number][]; layer?: number }> = [];
  // checkMix spawns the floor, M, R, P and Q in this order, in one batch.
  const names = ['floor', 'M', 'R', 'P', 'Q'];
  const lost = new Set<string>(opts.lostDepth);
  let spawned = false;
  let nextId = 120;
  const spawn = (opts?: { mode?: '2d' | '3d' }) => {
    const h: FakeHandle = { id: nextId++, is2D: opts?.mode === '2d', x: 0, y: 0, d: 0, isTransparent: false, lightOptions: null, destroyed: false, calls: [] };
    const name = names[handles.length];
    rows.push(h);
    handles.push(h);
    const api = {
      get id() { return h.id; },
      position: (x: number, y: number) => { h.x = x; h.y = y; return api; },
      scale: () => api,
      receivesLight: () => api,
      depth: (d: number) => {
        h.calls.push(`depth ${d}`);
        if (!(spawned && lost.has(name))) h.d = d;
        return api;
      },
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
  // The light list's members: every light the exact far-plane test keeps (a global light always), in row order.
  const listed = (): FakeHandle[] => {
    const vp = cam.viewProjection;
    const farDepth = (vp[14] - 1) / vp[10];
    return rows.filter((h) => h.lightOptions !== null && (h.lightOptions.type === 'global' || h.d <= farDepth + (h.lightOptions.range ?? 100)));
  };
  const lightBufferAt = ([x, y]: [number, number]): Rgba => {
    const lights = listed().map((h) => {
      const o = h.lightOptions!;
      const range = o.range ?? 100;
      const weight = o.type === 'global' ? 1 : pointWeight([x, y], [h.x, h.y], range, o.falloff ?? 1);
      const energy = o.energy ?? 1;
      const color = (o.color ?? [1, 1, 1]).map((c) => c * energy) as Rgb;
      return { h, blend: o.blend ?? 'add', depth: h.d, id: h.id, color, weight };
    });
    const mixLast = (l: { blend: LightBlend }): number => (l.blend === 'mix' ? 1 : 0);
    const order: Record<Rule, () => typeof lights> = {
      list: () => lightsBackToFront(lights),
      slot: () => lights,
      mixFirst: () => [...lights].sort((a, b) => (mixLast(b) - mixLast(a)) || (b.depth - a.depth) || (a.id - b.id)),
      transparentLast: () => [...lights].sort((a, b) => (mixLast(a) - mixLast(b))
        || (Number(a.h.isTransparent) - Number(b.h.isTransparent)) || (b.depth - a.depth) || (a.id - b.id)),
      bucket: () => [...lights.filter((l) => !l.h.isTransparent), ...lights.filter((l) => l.h.isTransparent)],
      idDesc: () => [...lights].sort((a, b) => (mixLast(a) - mixLast(b)) || (b.depth - a.depth) || (b.id - a.id)),
    };
    const ordered = order[rule]();
    // Each blend's result stored in fp16 (toward zero, as on the M2) or kept exact.
    const store = (c: Rgb): Rgb => (opts.fp16TowardZero ? c.map(f16TowardZero) as Rgb : c);
    return rgba(ordered.reduce<Rgb>((dst, l) => store(over(dst, lightLayer(l))), AMBIENT));
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
    batch: (fn: () => void) => {
      fn();
      spawned = true;
    },
    spawn, cam,
    lighting: {
      // Read live, like LightingAPI.groups: the list's ids follow the depths set so far.
      get groups() {
        return { groups: [{ layers: 1, sdfSet: -1 }], sdfSets: [], layerToGroup: [0x10, 0], lightIds: Uint32Array.from(listed().map((h) => h.id)) };
      },
      ambient: [...AMBIENT, 1],
    },
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
    // P nearer, then the swap (crossed: P 1 -> 3, Q 4 -> 2), then equal depths; `.transparent()` must not move P after Q.
    expect(p.calls).toEqual(['depth 1', 'transparent', 'light point/0', 'depth 3', 'depth 1', 'destroy']);
    expect(q.calls).toEqual(['depth 4', 'light point/0', 'depth 2', 'depth 1', 'destroy']);
    // Weight 1, weight w, global, back to weight 1; then just inside and just outside its listed limit, and despawned.
    expect(m.calls.slice(0, 4)).toEqual(['light point/0', 'light point/1', 'light global/-', 'light point/0']);
    expect(m.calls.slice(4, 6).map((c) => Number(c.split(' ')[1]))).toEqual([expect.closeTo(1002.985, 3), expect.closeTo(1003.015, 3)]);
    expect(m.calls.at(-1)).toBe('destroy');
    expect(handles.every((h) => h.destroyed)).toBe(true);
    expect(restoreView).toHaveBeenCalledTimes(1);
    // What the details print from the rows and the view: P's and Q's row z after the swap, M's listed
    // limit, the ids column (the tab's global light, the floor, Q, R and P after M's despawn).
    const [replaces, order, list] = reporter.results();
    // The 1920 x 1080 canvas: a 960 x 540 light buffer over the 35.56 x 20 units of the view.
    expect(replaces.detail).toContain('against FLOOR 0.185, 0.170, 0.295 read in the same frame; light buffer 27.000 texels per world unit; global');
    expect(order.detail).toContain('row z P -3.000, Q -2.000');
    expect(list.detail).toContain('(limit 1003.000, the far plane + its range; FAR_EPS 0.015)');
    expect(list.detail).toContain('slots P 4, Q 2; 5 ids for 5 rows');
    // M's row (f32) and its place in the light list, read with each of its two probes.
    expect(list.detail).toContain('at depth 1002.985 (row z -1002.985, listed), and 0.185, 0.170, 0.295 just outside, '
      + 'at depth 1003.015 (row z -1003.015, unlisted)');
  });

  it("with no canvas: both partial points at the view centre, w = 0, and the first check fails naming the 1 x 1 light buffer's density", async () => {
    stubs();
    vi.stubGlobal('document', { getElementById: () => null });
    const { engine } = modelEngine('list');
    const reporter = createTestReporter();
    await checkMix(engine, reporter, [], F, vi.fn());
    const [replaces] = reporter.results();
    expect(replaces.status).toBe('fail');
    expect(replaces.detail).toContain('the partial points sit at w 0.000 and 0.000, not 0.750 and 0.500 '
      + '(the texel snapping moves a weight by at most 0.029 from 8 texels per unit up; this light buffer has 0.028)');
    expect(replaces.detail).toContain("light buffer 0.028 texels per world unit, below the partial weights' validated domain (8 and up)");
  });

  it('on plain slot order, every light in row order: the order and the tie fail', async () => {
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

  it.each([
    ['transparentLast', "a .transparent() light after the others of its class (a class key with renderMeta bit 8)"],
    ['bucket', "the cull's buckets, opaque before transparent, as master drew the lights on a 32-lane GPU"],
  ] as const)("on %s, %s: 'Mix order' names P's .transparent(), 'Light list' does not blame the slots alone", async (rule, _order) => {
    stubs();
    const { engine } = modelEngine(rule);
    const reporter = createTestReporter();
    await checkMix(engine, reporter, [], F, vi.fn());
    const [replaces, order, list] = reporter.results();
    expect([replaces.status, order.status, list.status]).toEqual(['pass', 'fail', 'fail']);
    expect(order.detail).toContain('P stays on top whatever the depths: its .transparent() moves it after Q');
    expect(list.detail).toContain('at equal depths P, the lower id, is on top: the order follows the slots or the ids reversed '
      + "(one read cannot tell those two apart), or P's .transparent() moves it after Q (check 'Mix order follows depth' tells that one apart)");
  });

  it("on the id tie-break reversed, the lower id drawn last: 'Mix order' passes, 'Light list' names the ids reversed next to the slots, over equal row z", async () => {
    stubs();
    const { engine } = modelEngine('idDesc');
    const reporter = createTestReporter();
    await checkMix(engine, reporter, [], F, vi.fn());
    const [replaces, order, list] = reporter.results();
    // P has the lower id and the later slot (4 against Q's 2): the reversed ids put it on top as the slots would,
    // and with P's and Q's depths apart, check 2 sees no tie at all.
    expect([replaces.status, order.status, list.status]).toEqual(['pass', 'pass', 'fail']);
    expect(list.detail).toContain('at equal depths P, the lower id, is on top: the order follows the slots or the ids reversed '
      + "(one read cannot tell those two apart), or P's .transparent() moves it after Q (check 'Mix order follows depth' tells that one apart)");
    // The premise, read in the same frame: P's and Q's rows hold the same z.
    expect(list.detail).toContain('overlap P at equal depths (row z P -1.000, Q -1.000); ids P 123, Q 124; slots P 4, Q 2');
  });

  it("with P's runtime SetDepth lost: 'Mix order' fails, P staying nearer, and names the rows that missed the swap", async () => {
    stubs();
    const { engine } = modelEngine('list', { lostDepth: ['P'] });
    const reporter = createTestReporter();
    await checkMix(engine, reporter, [], F, vi.fn());
    const [replaces, order, list] = reporter.results();
    // P stays at depth 1, nearer than Q at 2: P on top after the swap too. 'Light list' then moves Q to P's depth.
    expect([replaces.status, order.status, list.status]).toEqual(['pass', 'fail', 'pass']);
    expect(order.detail).toContain('overlap P over 10 reads with P nearer, P after the swap');
    expect(order.detail).toContain('the depth swap did not reach the rows: row z P -1.000, Q -2.000 after it, want -3.000, -2.000');
  });

  it("with Q's runtime SetDepth lost: both order checks fail, and 'Light list' names the unequal rows, not the order", async () => {
    stubs();
    const { engine } = modelEngine('list', { lostDepth: ['Q'] });
    const reporter = createTestReporter();
    await checkMix(engine, reporter, [], F, vi.fn());
    const [replaces, order, list] = reporter.results();
    // Q stays at depth 4: P (3 after the swap, 1 for the tie) stays nearer, and on top.
    expect([replaces.status, order.status, list.status]).toEqual(['pass', 'fail', 'fail']);
    expect(order.detail).toContain('the depth swap did not reach the rows: row z P -3.000, Q -4.000 after it, want -3.000, -2.000');
    expect(list.detail).toContain('P and Q are not at equal depths in the rows (row z P -1.000, Q -4.000)');
    expect(list.detail).not.toContain('the lower id');
  });

  it("with M's runtime SetDepth lost: 'Light list' blames M's depth, read in M's row, not the list's margin", async () => {
    stubs();
    const { engine } = modelEngine('list', { lostDepth: ['M'] });
    const reporter = createTestReporter();
    await checkMix(engine, reporter, [], F, vi.fn());
    const [replaces, order, list] = reporter.results();
    // M stays at depth 0: listed and drawn at both of its reads, which are both refused for it.
    expect([replaces.status, order.status, list.status]).toEqual(['pass', 'pass', 'fail']);
    expect(list.detail).toContain('at depth 1002.985 (row z 0.000, listed), and 2.000, 1.000, 0.500 just outside, at depth 1003.015 (row z 0.000, listed)');
    expect(list.detail).toContain("M's depth did not reach its row at the inside read (row z 0.000, set depth 1002.985)");
    expect(list.detail).toContain("M's depth did not reach its row (row z 0.000, set depth 1003.015)");
    expect(list.detail).not.toContain("grouping's margin");
  });

  it('with every blend rounded toward zero in fp16, as on the M2: three passes, and R_ONLY reads as it did there', async () => {
    stubs();
    const { engine } = modelEngine('list', { fp16TowardZero: true });
    const reporter = createTestReporter();
    await checkMix(engine, reporter, [], F, vi.fn());
    expect(reporter.results().map(({ name, status, detail }) => [name, status, status === 'pass' ? '' : detail])).toEqual([
      ['Mix light replaces the light buffer', 'pass', ''],
      ['Mix order follows depth', 'pass', ''],
      ['Light list: exact cull, id at equal depth', 'pass', ''],
    ]);
    // R, then the global light (back to front), each sum rounded down: 0.669 in green, as harness-task5-B.json
    // printed on the M2, where round to nearest gives 0.670.
    expect(reporter.results()[1].detail).toContain('R_ONLY 0.185, 0.669, 0.295');
  });

  it("puts M's row at its listed limit ± FAR_EPS through the real deriveLightGroups: listed just inside; just outside, unlisted but among the group keys", async () => {
    stubs();
    const { engine, handles } = modelEngine('list');
    await checkMix(engine, createTestReporter(), [], F, vi.fn());
    // The two depths checkMix gave M around its listed limit, and the view it read M in (restoreView is a mock: the camera stays).
    const m = handles[1];
    const [inside, outside] = m.calls.filter((c) => c.startsWith('depth ')).map((c) => Number(c.slice('depth '.length)));
    const groupsAt = (depth: number) => deriveLightGroups({
      entityCount: 1,
      // A point mix light (type bits 11-13 zero) on every layer.
      renderMeta: Uint32Array.of(0, (RenderPrimitiveType.Light2D | (BLEND_MIX << 14) | (0xffff << 16)) >>> 0),
      primParams: Float32Array.of(...M_TARGET, m.lightOptions!.range!, 0, 0, 0, 0),
      // A root 2D light's row: z = -depth in f32, as the engine stores it; its radius, its range.
      bounds: Float32Array.of(m.x, m.y, -depth, m.lightOptions!.range!),
      cameraViewProjection: engine.cam.viewProjection,
      entityIds: Uint32Array.of(m.id),
    });
    expect([...groupsAt(inside).lightIds]).toEqual([m.id]);
    const culled = groupsAt(outside);
    expect([...culled.lightOrder]).toEqual([]);
    // The grouping's margin (range x 1.01 + 0.001) still keeps it: its mask stays a group key.
    expect(culled.lightMasks).toEqual([0xffff]);
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
