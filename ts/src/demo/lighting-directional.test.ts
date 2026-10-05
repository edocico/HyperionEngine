import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkDirectional, directionalShadowVerdict, edgePopVerdict, shadowLengthVerdict, sunPoints,
} from './lighting-directional';
import { createTestReporter } from './types';
import { Camera } from '../camera';
import { CameraAPI } from '../camera-api';
import type { Hyperion } from '../hyperion';
import type { EntityHandle } from '../entity-handle';
import type { Rgba } from './probe-checks';
import type { Rgb } from './blend-expect';

// The light buffer of the Lighting tab: the ambient plus its weak global
// light (floor), and the sub-scene's sun on top of it where it reaches.
const floor: Rgb = [0.185, 0.17, 0.295];
const sun: Rgb = [1, 0.9, 0.7];
const lit: Rgb = [floor[0] + sun[0], floor[1] + sun[1], floor[2] + sun[2]];

/** The light buffer where the sun arrives at strength f: floor + f·sun. */
const at = (f: number): Rgba => [floor[0] + f * sun[0], floor[1] + f * sun[1], floor[2] + f * sun[2], 1];

const ONE_SET = { groups: 1, sdfSets: 1 };

describe('sunPoints', () => {
  it('sunPoints: S downwind, U upwind, Rx and Ry the mirrors across the axes', () => {
    const theta = -Math.PI / 6;
    const c: [number, number] = [0, 200];
    const points = sunPoints(c, theta, 2.5);
    const dir = [Math.cos(theta), Math.sin(theta)];
    // Along the sun, and across it (a quarter turn counter-clockwise).
    const frame = ([x, y]: [number, number]) => [
      (x - c[0]) * dir[0] + (y - c[1]) * dir[1],
      -(x - c[0]) * dir[1] + (y - c[1]) * dir[0],
    ];
    const want = { S: [2.5, 0], U: [-2.5, 0], Ry: [1.25, 2.165], Rx: [-1.25, -2.165] } as const;
    for (const key of ['S', 'U', 'Ry', 'Rx'] as const) {
      const [along, across] = frame(points[key]);
      expect(along, `${key} along`).toBeCloseTo(want[key][0], 3);
      expect(across, `${key} across`).toBeCloseTo(want[key][1], 3);
    }
  });
});

describe('directionalShadowVerdict', () => {
  it('directionalShadowVerdict: a sun behind a wall darkens the far side', () => {
    const v = directionalShadowVerdict({ S: at(0), U: at(1), Rx: at(1), Ry: at(1) }, floor, sun, ONE_SET);
    expect(v.ok, v.detail).toBe(true);
    expect(v.detail).toContain('1 group, 1 SDF set');
  });

  it('directionalShadowVerdict names the bug', () => {
    const upwind = directionalShadowVerdict({ S: at(1), U: at(0), Rx: at(1), Ry: at(1) }, floor, sun, ONE_SET);
    expect(upwind.ok).toBe(false);
    expect(upwind.detail).toContain('upwind');
    const yMirror = directionalShadowVerdict({ S: at(1), U: at(1), Rx: at(1), Ry: at(0) }, floor, sun, ONE_SET);
    expect(yMirror.ok).toBe(false);
    expect(yMirror.detail).toContain('y-mirror');
    const xMirror = directionalShadowVerdict({ S: at(1), U: at(1), Rx: at(0), Ry: at(1) }, floor, sun, ONE_SET);
    expect(xMirror.ok).toBe(false);
    expect(xMirror.detail).toContain('x-mirror');
  });

  it('directionalShadowVerdict: no SDF set means the grouping does not count the sun as shadowed', () => {
    // Even with the pixels right: the counts are a condition of their own.
    const shadowed = { S: at(0), U: at(1), Rx: at(1), Ry: at(1) };
    const noSet = directionalShadowVerdict(shadowed, floor, sun, { groups: 1, sdfSets: 0 });
    expect(noSet.ok).toBe(false);
    expect(noSet.detail).toContain('does not count the directional light as shadowed');
    const split = directionalShadowVerdict(shadowed, floor, sun, { groups: 2, sdfSets: 2 });
    expect(split.ok).toBe(false);
    expect(split.detail).toContain('2 groups, 2 SDF sets (expected 1 and 1)');
  });
});

describe('shadowLengthVerdict', () => {
  it('shadowLengthVerdict: dark at the caster, half faded 5.25 past it, lit past the range, never darker farther away', () => {
    // The march model (march-model.test.mjs, check 2) and the M2's read (step 6).
    for (const f of [[0, 0, 0, 0.503, 1], [0, 0, 0, 0.508, 1]]) {
      const v = shadowLengthVerdict(f.map(at), lit, sun);
      expect(v.ok, v.detail).toBe(true);
      expect(v.detail).toContain('range 6');
      expect(v.detail).toContain(`the sun's share 5.25 past the caster ${f[3].toFixed(3)}`);
    }
  });

  it('shadowLengthVerdict fails a shadow half its range long, a hard cut, a fade from the caster, and a shadow twice its range', () => {
    // Review wf_cf354af4-c53 [7], [9]: the first two passed every rule. The
    // profiles are the march model's at a reach of 3 (directionalRay's
    // `* 0.25 * size` mutant) and of 12 (`size` without its 0.5); a hard cut
    // and a linear fade from the caster (SUN_FADE_START 0, not 0.75) by hand.
    const short = shadowLengthVerdict([0, 0, 1, 1, 1].map(at), lit, sun);
    expect(short.ok).toBe(false);
    expect(short.detail).toContain('shorter than its range');
    const hardCut = shadowLengthVerdict([0, 0, 0, 0, 1].map(at), lit, sun);
    expect(hardCut.ok).toBe(false);
    expect(hardCut.detail).toContain('no fade');
    expect(shadowLengthVerdict([0.08, 0.33, 0.67, 0.88, 1].map(at), lit, sun).ok).toBe(false);
    expect(shadowLengthVerdict([0, 0, 0, 0, 0].map(at), lit, sun).ok).toBe(false);
  });

  it('shadowLengthVerdict fails a shadow that never ends, or ends too early', () => {
    expect(shadowLengthVerdict([0, 0, 0, 0, 0].map(at), lit, sun).ok).toBe(false);
    expect(shadowLengthVerdict([1, 1, 1, 1, 1].map(at), lit, sun).ok).toBe(false);
  });

  it('shadowLengthVerdict fails a shadow that gets darker farther from its caster', () => {
    const v = shadowLengthVerdict([0, 0.5, 0.2, 0.8, 1].map(at), lit, sun);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('darker at 4 than at 2');
  });
});

describe('edgePopVerdict', () => {
  const ds = Array.from({ length: 34 }, (_, i) => i + 1);
  const meta = { viewWidth: 35.2, zoom: 0.99, canvas: [2400, 1378] as [number, number] };
  /** W_in casts across the whole row, W_out (off screen) nothing, E lit. */
  const rows = () => ({ out: ds.map(() => at(1)), inn: ds.map(() => at(0)), ref: ds.map(() => at(1)), e: at(1) });

  it('edgePopVerdict measures the pop and pins the step-6 edge rule', () => {
    const v = edgePopVerdict(rows(), ds, sun, meta);
    expect(v.ok, v.detail).toBe(true);
    for (const p of v.pop) expect(p).toBeCloseTo(1, 6);
    for (const part of ['max', 'far edge', '% of the width', 'range 100', '2400×1378', '1200×689']) {
      expect(v.detail).toContain(part);
    }
  });

  it('edgePopVerdict fails when the march reads past the SDF, an off-screen caster casts, or the caster in view casts nothing', () => {
    const pastSdf = edgePopVerdict({ ...rows(), e: at(0.2) }, ds, sun, meta);
    expect(pastSdf.ok).toBe(false);
    expect(pastSdf.detail).toContain('past the SDF');
    // Padding (step 8c): W_out's shadow reaches into the view too.
    const offScreen = edgePopVerdict({ ...rows(), out: ds.map(() => at(0)) }, ds, sun, meta);
    expect(offScreen.ok).toBe(false);
    expect(offScreen.detail).toMatch(/off-screen caster already casts .*step 8c/);
    const nothing = edgePopVerdict({ ...rows(), inn: ds.map(() => at(1)) }, ds, sun, meta);
    expect(nothing.ok).toBe(false);
    expect(nothing.detail).toContain('casts nothing');
  });
});

/** A handle of the fake engine: every builder call chains, `destroy` is recorded. */
interface FakeHandle {
  destroyed: boolean;
  position(): FakeHandle;
  rotation(): FakeHandle;
  scale(): FakeHandle;
  castsShadow(): FakeHandle;
  receivesLight(): FakeHandle;
  light(): FakeHandle;
  destroy(): void;
}

interface ProbeRequest {
  target: string;
  world: [number, number][];
  layer?: number;
}

/**
 * An engine with the real camera (the sub-scene is placed from its
 * view-projection at 16:9), the given probe and light groups, and handles
 * that record their destruction.
 */
function fakeEngine(
  probe: (request: ProbeRequest) => Promise<{ values: Rgba[] }>,
  groups: unknown,
): { engine: Hyperion; handles: FakeHandle[] } {
  const handles: FakeHandle[] = [];
  const spawn = () => {
    const h: FakeHandle = {
      destroyed: false,
      position: () => h,
      rotation: () => h,
      scale: () => h,
      castsShadow: () => h,
      receivesLight: () => h,
      light: () => h,
      destroy: () => {
        h.destroyed = true;
      },
    };
    handles.push(h);
    return h;
  };
  const cam = new CameraAPI(new Camera());
  cam.setOrthographic((20 * 1280) / 720, 20);
  const engine = { batch: (fn: () => void) => fn(), spawn, cam, lighting: { groups }, debug: { probe } } as unknown as Hyperion;
  return { engine, handles };
}

/**
 * Mode A: the canvas belongs to the render worker, so the main thread has no
 * renderer and `engine.debug.probe` rejects.
 */
function modeAEngine(): { engine: Hyperion; handles: FakeHandle[] } {
  return fakeEngine(() => Promise.reject(new Error('The debug probe needs the main-thread renderer of a dev build')), null);
}

describe('checkDirectional', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('checkDirectional in Mode A: three skips, every handle destroyed, the view restored', async () => {
    vi.stubGlobal('document', { getElementById: () => ({ width: 1280, height: 720 }) });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    const { engine, handles } = modeAEngine();
    const reporter = createTestReporter();
    const entities: EntityHandle[] = [];
    const restoreView = vi.fn();
    await checkDirectional(engine, reporter, entities, floor, restoreView);
    expect(reporter.results().map(({ name, status }) => [name, status])).toEqual([
      ['Directional shadow', 'skip'],
      ['Directional shadow length', 'skip'],
      ['Directional edge pop (measured)', 'skip'],
    ]);
    // The floor, wall A, the sun, W_out and W_in.
    expect(handles).toHaveLength(5);
    for (const h of handles) {
      expect(h.destroyed).toBe(true);
      expect(entities).toContain(h);
    }
    expect(entities).toHaveLength(5);
    expect(restoreView).toHaveBeenCalledTimes(1);
  });

  it('checkDirectional with a probe: one read of the light buffer per check, at the sub-scene\'s points, three passes', async () => {
    vi.stubGlobal('document', { getElementById: () => ({ width: 1920, height: 1080 }) });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    // What the CPU model of the march predicts, read by read.
    const answers = [
      () => [at(0), at(1), at(1), at(1)], // S, U, Rx, Ry
      () => [at(0), at(0), at(0), at(0.5), at(1), at(1)], // five points along the short shadow, then U
      (n: number) => [...Array(n).fill(at(1)), ...Array(n).fill(at(0)), ...Array(n).fill(at(1)), at(1)], // out, in, ref, E
    ];
    const requests: ProbeRequest[] = [];
    const probe = async (request: ProbeRequest) => {
      requests.push(request);
      return { values: answers[requests.length - 1]((request.world.length - 1) / 3) };
    };
    const { engine, handles } = fakeEngine(probe, { groups: [{ layers: 1, sdfSet: 0 }], sdfSets: [{ occluderLayers: 1 }], layerToGroup: [0, 0] });
    const reporter = createTestReporter();
    const restoreView = vi.fn();
    await checkDirectional(engine, reporter, [], floor, restoreView);

    expect(reporter.results().map(({ name, status }) => [name, status])).toEqual([
      ['Directional shadow', 'pass'],
      ['Directional shadow length', 'pass'],
      ['Directional edge pop (measured)', 'pass'],
    ]);
    expect(requests.map(({ target, layer }) => [target, layer])).toEqual(Array(3).fill(['light-buffer', 0]));
    const near = (p: [number, number], want: [number, number]) => {
      expect(p[0]).toBeCloseTo(want[0], 3);
      expect(p[1]).toBeCloseTo(want[1], 3);
    };
    // 1: S, U, Rx, Ry around (0, 200), the sun along (cos, sin)(-30 degrees).
    const [c, s] = [2.5 * Math.cos(-Math.PI / 6), 2.5 * Math.sin(-Math.PI / 6)];
    const [S, U, Rx, Ry] = requests[0].world;
    near(S, [c, 200 + s]);
    near(U, [-c, 200 - s]);
    near(Rx, [-c, 200 + s]);
    near(Ry, [c, 200 - s]);
    // 2: 0.5, 2, 4, 5.25 and 7.5 past wall A's far face (0.25 from the centre), then U.
    [0.5, 2, 4, 5.25, 7.5].forEach((d, i) => near(requests[1].world[i], [(c / 2.5) * (0.25 + d), 200 + (s / 2.5) * (0.25 + d)]));
    near(requests[1].world[5], U);
    // 3: the three rows from d = 1 to 35 (the view is 35.56 wide at 16:9), then E.
    const xL = -(20 * 1920) / 1080 / 2;
    const edge = requests[2].world;
    expect(edge).toHaveLength(3 * 35 + 1);
    near(edge[0], [xL + 1, 203]);
    near(edge[34], [xL + 35, 203]);
    near(edge[35], [xL + 1, 208]);
    near(edge[70], [xL + 1, 205.5]);
    near(edge[105], [xL + 1, 206.6]);
    expect(reporter.results()[2].detail).toContain('canvas 1920×1080, light buffer 960×540');
    expect(handles.every((h) => h.destroyed)).toBe(true);
    expect(restoreView).toHaveBeenCalledTimes(1);
  });
});
