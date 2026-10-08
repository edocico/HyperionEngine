import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkMix, fp16Ulp, lightTexelCentre, listVerdict, mixOrderVerdict, mixReplacesVerdict, pointWeight,
  M_TARGET, P_COLOR, Q_COLOR, R_COLOR, ORDER_READS, type OrderRead,
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

  it('passes the rule: P over the overlap while nearer, Q after the swap; R under both', () => {
    const v = mixOrderVerdict(reads(P_COLOR), at(Q_COLOR), F);
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
      const v = mixOrderVerdict(reads(before), at(after), F);
      expect(v.ok, cause).toBe(false);
      expect(v.detail).toContain(cause);
      for (const [, , other] of cases.filter(([, , c]) => c !== cause)) expect(v.detail).not.toContain(other);
    }
  });

  it('names a class order broken (R after the mix lights) and mix lights added like add', () => {
    const late = mixOrderVerdict(reads(sum(P_COLOR, R_COLOR), { pOnly: sum(P_COLOR, R_COLOR), qOnly: sum(Q_COLOR, R_COLOR) }),
      at(sum(Q_COLOR, R_COLOR), { pOnly: sum(P_COLOR, R_COLOR), qOnly: sum(Q_COLOR, R_COLOR) }), F);
    expect(late.ok).toBe(false);
    expect(late.detail).toContain('R is drawn after the mix lights');
    expect(late.detail).not.toContain('added like add');
    const summed = sum(F, R_COLOR, P_COLOR);
    const added = mixOrderVerdict(reads(sum(F, R_COLOR, P_COLOR, Q_COLOR), { pOnly: summed }), at(sum(F, R_COLOR, P_COLOR, Q_COLOR), { pOnly: summed }), F);
    expect(added.ok).toBe(false);
    expect(added.detail).toContain('the mix lights are added like add');
    expect(added.detail).not.toContain('R is drawn after');
  });

  it('fails an overlap that changes from read to read', () => {
    const before = reads(P_COLOR);
    before[4] = at(Q_COLOR);
    const v = mixOrderVerdict(before, at(Q_COLOR), F);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('changes from read to read');
  });
});

describe('listVerdict', () => {
  const right = { inside: rgba(M_TARGET), outside: rgba(F), overlap: rgba(Q_COLOR), slots: { p: 15, q: 13 }, ids: { p: 120, q: 121 } };

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

/**
 * An engine whose probe reads a model of the light buffer: the floor, then
 * every light the exact far-plane test keeps, in the order `rule` gives
 * ('list': the step-7 rule, blend-expect's oracle; 'slot': the rows), each
 * through lightLayer at its weight (pointWeight, a global light 1).
 */
function modelEngine(rule: 'list' | 'slot', probeUnavailable = false) {
  const rows: FakeHandle[] = [];
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
    const ordered = rule === 'list' ? lightsBackToFront(lights) : lights;
    return rgba(composite(F, ordered.map((l) => lightLayer(l))));
  };
  const probe = async (request: { target: string; world: [number, number][]; layer?: number }) => {
    requests.push(request);
    if (probeUnavailable) throw new Error('The debug probe needs the main-thread renderer of a dev build');
    return { values: request.world.map(lightBufferAt) };
  };
  const readEntityTransforms = async () => ({ entityIds: Uint32Array.from(rows.map((h) => h.id)) });
  const engine = {
    batch: (fn: () => void) => fn(), spawn, cam,
    lighting: { groups: { groups: [{ layers: 1, sdfSet: -1 }], sdfSets: [], layerToGroup: [0x10, 0] } },
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
    const { engine, handles } = modelEngine('list', true);
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
});
