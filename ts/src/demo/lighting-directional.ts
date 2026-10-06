// ts/src/demo/lighting-directional.ts — the Lighting tab's checks of a
// directional light's shadow (round 2026-09-27, step 6)
//
// They run on a sub-scene of their own, centred on SUN_SCENE, out of reach of
// the tab's point and spot lights, where the shadowed sun is the only shadowed
// light in view. The tab's global light, never culled, lights it too: it is
// part of `floor`, the light buffer where the sun does not reach (ambient +
// global light). On the tab's scene the shadowed point light already gives
// the floor's light group an SDF set, so a light-groups gate that did not
// count a shadowed directional light would go unseen: the sun would march
// that set anyway. Here the sun's group has no SDF set without the gate, and
// no shadow.
//
// - 'Directional shadow': a wall thin along a sun at -30 degrees darkens the
//   point behind it (S) and none of the three points where a sign error would
//   put the shadow: U in front (a reversed march), Ry and Rx, the mirrors of S
//   across the axes (the texel ray's y or x negated).
// - 'Directional shadow length': at range 6 the shadow is dark past the
//   caster, half faded 5.25 past it (the middle of its last quarter, where
//   it fades) and gone past its end.
// - 'Directional edge pop (measured)': a caster casts only while it is on
//   screen (the occluder seed rasterises what is in view), so the shadow of
//   one entering from the sun's side appears across the view at once. The
//   check measures that pop and pins the rule of step 6: a caster wholly off
//   screen casts nothing, and a ray that leaves the SDF counts as lit (E).
//
// The geometry and the thresholds come from the CPU model of the march,
// docs/plans/assets/2026-09-30-step6/march-model.mjs, whose node:test pins
// what it predicts here, the same at the 192 steps the sun marches (4 x the
// tab's shadowSteps 48, light-accum.wgsl sunShadow) as at 48: S 0 and U, Rx,
// Ry 1; 0, 0, 0, 0.50 and 1 along the short shadow at 1080p (the 0.50 moves
// on coarser canvases: FADE_SHARE); a pop of 1 over the whole width, E 1. If
// the march read past the SDF, at the sun's 192 steps E would read 0.26 and
// the open row it is compared with 0.93 (E 0.20 at 48 steps).
// The sub-scene's five entities take fresh ids: the tabs after Lighting see
// ids 5 higher than before step 6.
import type { Hyperion } from '../hyperion';
import type { EntityHandle, LightOptions } from '../entity-handle';
import type { TestReporter } from './types';
import type { Rgb } from './blend-expect';
import { halfResolution } from '../render/passes/occluder-seed-stage';
import { pixelCheck, fmt, fitView, frames, luminance, viewBounds, type Rgba } from './probe-checks';

/**
 * The sub-scene's centre. The spheres of the tab's point and spot lights stay
 * below y ≈ 16 (its global light reaches everywhere, and is part of `floor`),
 * and the view above y ≈ 140 even at an aspect of 0.3.
 */
const SUN_SCENE: [number, number] = [0, 200];
/** The sun's colour, at energy 1: what it adds to the light buffer where nothing shadows it. */
const SUN_COLOR: Rgb = [1, 0.9, 0.7];
/** The sun shines along -30 degrees. */
const SUN_ROTATION = -Math.PI / 6;
/** Wall A, at the centre: thin along the sun (its far face 0.25 from the centre), 1.2 to either side across it. */
const WALL_A: [number, number] = [0.5, 2.4];
const FAR_FACE = WALL_A[0] / 2;
/** S, U, Rx and Ry, from the centre: S is 2.25 behind wall A's far face. */
const PROBE_DISTANCE = 2.5;
/** The shadow's length in the length check, world units. */
const SHORT_RANGE = 6;
/** The length check's points, world units past wall A's far face: the fade runs from 4.5 to 6. */
const LENGTH_DISTANCES = [0.5, 2, 4, 5.25, 7.5];
/** The length check's point inside the fade, 5.25 past the caster: the middle of the last quarter. */
const FADE_POINT = 3;
/**
 * The sun's share of the light allowed at FADE_POINT. The march model gives
 * 0.503 there at 1080p, 27 light-buffer texels per world unit, and 0.499 on a
 * 1960x1248 canvas, 28 per unit. The share moves with where the point falls in
 * its texel and with the SDF's quantisation, both larger as the texels per
 * unit fall: the march model, read in either texel where the point lies on a
 * texel's edge, puts correct code at about 0.44 to 0.72 from 8 texels per unit
 * up, and at about 0.47 to 0.61 from 16 up (the model's bounds, rounded:
 * march-model.test.mjs pins the extremes of two grids of canvases, which lie
 * inside them). On the M2 GPU (2026-10-06, at 6fb0480, Mode B, backing stores
 * set by engine.resize) ten canvases from 565x320 to 4800x960, at 8 to 28
 * texels per unit, read 0.455 to 0.655, among them 1960x1248 0.508, 800x600
 * 0.655, 699x349 0.455 and 565x320 0.534; the full readings go into
 * docs/plans/assets/2026-09-30-step6/length-canvases-m2.json (step 6, Task 10).
 *
 * The window is validated from 8 light-buffer texels per world unit up. With
 * this tab's framing that is a canvas (its backing store) at least 320 px
 * tall where fitView keeps zoom 1 (an aspect of 1.76 or more), or about 564
 * px wide or more where it zooms out. Below 8 texels per unit the window is
 * not guaranteed in either direction: at 290x580 (4.1 per unit) correct code
 * reads 0.85, and a range 0.5 too long 0.45; at zoom 1 correct code first
 * leaves it between 5 and 6 per unit (425x212: 0.754). A failure on such a
 * canvas may mean the canvas, not a bug, and a pass there does not rule one
 * out. The check's detail prints the run's texels per unit, and marks a run
 * below VALIDATED_TEXELS_PER_UNIT.
 *
 * From 8 texels per unit up every defect the check names lies outside: a
 * shadow half its range long is gone by then (1); a hard cut, or a shadow
 * twice its range, is still whole (0); a range 0.5 off reads about 0.31 or
 * less, or 0.87 or more (the model's bounds, rounded); a fade from the caster
 * about 0.9.
 */
const FADE_SHARE: readonly [number, number] = [0.4, 0.75];
/** The light-buffer texels per world unit from which FADE_SHARE is validated (see FADE_SHARE). */
const VALIDATED_TEXELS_PER_UNIT = 8;
/** The edge check's sun keeps LightOptions' default range. */
const DEFAULT_RANGE = 100;
/** The tab's own framing: the same zoom, so the same texels per unit as the CPU model at 16:9. */
const SUB_HALF_WIDTH = 17.6;
/** Per-channel tolerance on light-buffer values. */
const TOL = 0.03;

export type SunPoint = 'S' | 'U' | 'Rx' | 'Ry';

interface Verdict {
  ok: boolean;
  detail: string;
}

const lum = (c: readonly number[]): number => luminance([c[0], c[1], c[2], 1]);
const close = (a: readonly number[], b: readonly number[]): boolean => [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= TOL);
const rgb = (c: readonly number[]): string => fmt([c[0], c[1], c[2]]);
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The four points of the shadow check, `distance` from `center` for a sun at
 * rotation `theta` (shining along (cos, sin)): S downwind, behind a wall at
 * the centre; U upwind, where a reversed march puts the shadow; Ry and Rx, S
 * mirrored across the x and the y axis, where a texel ray with its y or its x
 * negated puts it.
 */
export function sunPoints(center: readonly [number, number], theta: number, distance: number): Record<SunPoint, [number, number]> {
  const [cx, cy] = center;
  const c = distance * Math.cos(theta);
  const s = distance * Math.sin(theta);
  return { S: [cx + c, cy + s], U: [cx - c, cy - s], Ry: [cx + c, cy - s], Rx: [cx - c, cy + s] };
}

/**
 * 'Directional shadow': S in the shadow (at most floor + 0.1·sun, and under
 * half the darkest of the others), U, Rx and Ry lit alike and U at floor + sun
 * (a sun has no falloff: it adds its colour), and the sun's group with an SDF
 * set of its own: 1 light group, 1 SDF set.
 */
export function directionalShadowVerdict(
  values: Record<SunPoint, Rgba>,
  floor: Rgb,
  sun: Rgb,
  counts: { groups: number; sdfSets: number },
): Verdict {
  const { S, U, Rx, Ry } = values;
  const lit = [0, 1, 2].map((i) => floor[i] + sun[i]);
  const grouped = counts.groups === 1 && counts.sdfSets === 1;
  const grouping = counts.sdfSets === 0
    ? "no SDF set for the sun's group: deriveLightGroups does not count the directional light as shadowed"
    : `${plural(counts.groups, 'group')}, ${plural(counts.sdfSets, 'SDF set')}${grouped ? '' : ' (expected 1 and 1)'}`;
  // Where a sign error puts the shadow: a point there under half the lit value.
  const misplaced = ([
    [U, 'the shadow falls upwind: the march runs away from the light'],
    [Ry, 'the shadow falls on the y-mirror: the y of the texel ray has the wrong sign (toScreenUV flips y)'],
    [Rx, 'the shadow falls on the x-mirror: the x of the texel ray has the wrong sign'],
  ] as const).filter(([value]) => lum(value) < 0.5 * lum(lit)).map(([, message]) => message);
  const problems: string[] = [...misplaced];
  const dark = 2 * lum(S) < Math.min(lum(U), lum(Rx), lum(Ry)) && [0, 1, 2].every((i) => S[i] <= floor[i] + 0.1 * sun[i]);
  if (!dark) problems.push('S, behind the wall, is not in its shadow');
  // A misplaced shadow already explains these two.
  if (misplaced.length === 0) {
    if (!(close(U, Rx) && close(U, Ry) && close(Rx, Ry))) problems.push(`U, Rx and Ry differ by more than ${TOL}`);
    if (!close(U, lit)) problems.push(`U is not floor + sun (${rgb(lit)})`);
  }
  const detail = `S ${rgb(S)}; U ${rgb(U)}; Rx ${rgb(Rx)}; Ry ${rgb(Ry)}; ${grouping}`;
  return { ok: grouped && problems.length === 0, detail: problems.length > 0 ? `${detail}; ${problems.join('; ')}` : detail };
}

/**
 * 'Directional shadow length', on the points LENGTH_DISTANCES past the caster
 * at range 6: dark at the first, `lit` at the last, never darker than the
 * point before (by more than 0.02 in luminance), and half faded at FADE_POINT:
 * there the sun's share of the light, (lum − lum(floor)) / lum(sun) with
 * floor = lit − sun, lies in FADE_SHARE.
 *
 * `texelsPerUnit`, the run's light-buffer texels per world unit
 * (lightBufferTexelsPerUnit), only adds a part to the detail: the value, and
 * below VALIDATED_TEXELS_PER_UNIT a mark that the run is outside the window's
 * validated domain. The verdict never reads it.
 */
export function shadowLengthVerdict(profile: readonly Rgba[], lit: readonly number[], sun: Rgb, texelsPerUnit?: number): Verdict {
  const lums = profile.map(lum);
  const problems: string[] = [];
  const darker = lums.findIndex((l, i) => i > 0 && l < lums[i - 1] - 0.02);
  if (darker > 0) {
    problems.push(`darker at ${LENGTH_DISTANCES[darker]} than at ${LENGTH_DISTANCES[darker - 1]}: the shadow grows stronger away from its caster`);
  }
  if (!(lums[0] < lum(lit) - 0.5 * lum(sun))) {
    problems.push(`not in shadow ${LENGTH_DISTANCES[0]} past the caster: no shadow, or one much shorter than its range`);
  }
  // `lit` is U, read in the same frame: floor + sun.
  const share = (lums[FADE_POINT] - (lum(lit) - lum(sun))) / lum(sun);
  if (!(share >= FADE_SHARE[0] && share <= FADE_SHARE[1])) {
    problems.push(`the sun's share ${LENGTH_DISTANCES[FADE_POINT]} past the caster is not ${FADE_SHARE.join('-')} `
      + '(the march model: 0.503 at 1080p, about 0.44-0.72 from 8 light-buffer texels per unit up; below 8 the window is not guaranteed either way): '
      + (share > FADE_SHARE[1]
        ? 'the shadow is shorter than its range, or fades before its last quarter'
        : 'no fade, or a shadow longer than its range'));
  }
  const last = profile.length - 1;
  if (!close(profile[last], lit)) problems.push(`still shadowed ${LENGTH_DISTANCES[last]} past the caster: the shadow runs past its range`);
  // One part, without a ';' of its own: the tests strip it to compare the rest.
  const density = texelsPerUnit === undefined
    ? ''
    : `; light buffer ${fmt([texelsPerUnit])} texels per world unit`
      + (texelsPerUnit < VALIDATED_TEXELS_PER_UNIT
        ? `, below the window's validated domain (${VALIDATED_TEXELS_PER_UNIT} and up), where it can fail correct code or pass a wrong range`
        : '');
  const detail = `luminance at ${LENGTH_DISTANCES.join(', ')} past the caster: ${fmt(lums)}; `
    + `the sun's share ${LENGTH_DISTANCES[FADE_POINT]} past the caster ${fmt([share])}; lit ${fmt([lum(lit)])}; range ${SHORT_RANGE}`
    + density;
  return { ok: problems.length === 0, detail: problems.length > 0 ? `${detail}; ${problems.join('; ')}` : detail };
}

/**
 * The light buffer's texels per world unit in this run: its rows
 * (halfResolution of the canvas' backing store, as edgePopVerdict sizes it)
 * over the view's height in world units (viewBounds of the camera's
 * view-projection). It is march-model.mjs's `texPerUnit`, the density
 * FADE_SHARE is validated against.
 */
function lightBufferTexelsPerUnit(engine: Hyperion): number {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const [, rows] = halfResolution(canvas?.width ?? 0, canvas?.height ?? 0);
  const [, , yMin, yMax] = viewBounds(engine.cam.viewProjection);
  return rows / (yMax - yMin);
}

/** The three rows of the edge check, read at the same d, and E. */
export interface EdgeRows {
  /** Along W_out, wholly off screen on the sun's side. */
  out: readonly Rgba[];
  /** Along W_in, 0.5 inside the view on the sun's side. */
  inn: readonly Rgba[];
  /** Along no caster. */
  ref: readonly Rgba[];
  /** Beside W_in at d = 1, 0.4 off its row. */
  e: Rgba;
}

/** Where the edge check ran, for its detail. */
export interface EdgeMeta {
  /** The view's width, world units. */
  viewWidth: number;
  zoom: number;
  /** The canvas' backing store, pixels. */
  canvas: readonly [number, number];
}

/**
 * 'Directional edge pop (measured)': pop[i] = (lum(out[i]) − lum(inn[i])) /
 * lum(sun), how much of the sun W_in's shadow takes at `ds[i]` from the edge.
 * It measures the pop, and it fails on the step-6 rule only: E is lit like
 * the open row (the march stops at the SDF's exit), the off-screen caster
 * casts nothing (its row is not darker than the open row), and the caster in
 * view does cast (pop ≥ 0.5 at the first d).
 *
 * The off-screen rule is one-sided because the open row darkens by itself:
 * 1.5 below W_in, it lies in W_in's penumbra, about 0.02·d wide, from d ≈ 76,
 * which a canvas of about 4:1 reaches (the view is 20·aspect units wide), and
 * along the clamped edge when the march reads past the SDF; W_out's row, 4
 * below W_in, does neither (march-model.test.mjs, up to 5:1). When E fails
 * the open row is no reference, and the off-screen rule is not read.
 */
export function edgePopVerdict(rows: EdgeRows, ds: readonly number[], sun: Rgb, meta: EdgeMeta): Verdict & { pop: number[] } {
  const pop = ds.map((_, i) => (lum(rows.out[i]) - lum(rows.inn[i])) / lum(sun));
  const problems: string[] = [];
  const pastSdf = !close(rows.e, rows.ref[0]);
  if (pastSdf) {
    problems.push('the march reads past the SDF: E, beside the caster at the edge, is darker than the open row');
  } else {
    const casting = ds.filter((_, i) => [0, 1, 2].some((c) => rows.out[i][c] < rows.ref[i][c] - TOL));
    if (casting.length > 0) {
      problems.push(`an off-screen caster already casts (d = ${casting.join(', ')}): padding? update this check in step 8c`);
    }
  }
  if (!(pop[0] >= 0.5)) problems.push('the caster in view casts nothing');
  const last = pop.length - 1;
  const share = Math.round((100 * pop.filter((p) => p >= 0.1).length) / pop.length);
  const [bufferW, bufferH] = halfResolution(meta.canvas[0], meta.canvas[1]);
  const detail = `pop ${fmt([Math.max(...pop)])} max, ${fmt([pop[last]])} at the far edge (d = ${ds[last]}), >= 0.1 over ${share}% of the width; `
    + `view ${meta.viewWidth.toFixed(1)} units at zoom ${meta.zoom.toFixed(3)}, range ${DEFAULT_RANGE}, `
    + `canvas ${meta.canvas[0]}×${meta.canvas[1]}, light buffer ${bufferW}×${bufferH}`;
  return { ok: problems.length === 0, detail: problems.length > 0 ? `${detail}; ${problems.join('; ')}` : detail, pop };
}

/**
 * The three checks of a directional light's shadow, on their sub-scene: the
 * camera moves there, and `restoreView` brings it back at the end. Every
 * handle also goes into `entities`, the tab's list, and is destroyed here
 * whatever happens. `floor` is the light buffer where the sun does not reach:
 * the ambient plus the tab's global light.
 *
 * Each check is a `pixelCheck`, skipped where the probe does not exist (Mode
 * A, production). The sub-scene is built in Mode A all the same: the sun,
 * never culled, then lights the tab's scene in the render worker for a few
 * frames, a visual effect only.
 */
export async function checkDirectional(
  engine: Hyperion,
  reporter: TestReporter,
  entities: EntityHandle[],
  floor: Rgb,
  restoreView: () => void,
): Promise<void> {
  const [cx, cy] = SUN_SCENE;
  const scene: EntityHandle[] = [];
  const keep = (h: EntityHandle): EntityHandle => {
    scene.push(h);
    entities.push(h);
    return h;
  };
  const sunLight = (range?: number): LightOptions => ({
    type: 'directional', color: SUN_COLOR, energy: 1, shadowIntensity: 1, range,
  });
  // The light group of layer 0, the floor's (4 bits per layer), read before
  // a probe; the counts are read after it, so that Mode A skips first.
  const floorGroup = (): number => (engine.lighting.groups?.layerToGroup[0] ?? 0) & 0xf;
  try {
    fitView(engine, cx, cy, SUB_HALF_WIDTH);
    let sun!: EntityHandle;
    engine.batch(() => {
      // A receiver in view: without one there is no light group, and no SDF set.
      keep(engine.spawn().position(cx, cy, -0.5).scale(200, 100, 1).receivesLight(true));
      keep(engine.spawn().position(cx, cy).rotation(SUN_ROTATION).scale(...WALL_A).castsShadow(true));
      sun = keep(engine.spawn().rotation(SUN_ROTATION).light(sunLight()));
    });
    await frames(4);

    // ── 1. The shadow falls behind the wall, along the sun ──────────────
    const points = sunPoints(SUN_SCENE, SUN_ROTATION, PROBE_DISTANCE);
    await pixelCheck(reporter, 'Directional shadow', engine, async (probe) => {
      const [S, U, Rx, Ry] = await probe('light-buffer', [points.S, points.U, points.Rx, points.Ry], floorGroup());
      const groups = engine.lighting.groups;
      return directionalShadowVerdict({ S, U, Rx, Ry }, floor, SUN_COLOR, {
        groups: groups?.groups.length ?? 0,
        sdfSets: groups?.sdfSets.length ?? 0,
      });
    });

    // ── 2. The shadow's length is its range ─────────────────────────────
    sun.light(sunLight(SHORT_RANGE));
    await frames(4);
    await pixelCheck(reporter, 'Directional shadow length', engine, async (probe) => {
      const [dx, dy] = [Math.cos(SUN_ROTATION), Math.sin(SUN_ROTATION)];
      const along = LENGTH_DISTANCES.map((d): [number, number] => [cx + dx * (FAR_FACE + d), cy + dy * (FAR_FACE + d)]);
      // U, lit in the same frame: what "lit" is.
      const read = await probe('light-buffer', [...along, points.U], floorGroup());
      return shadowLengthVerdict(read.slice(0, along.length), read[along.length], SUN_COLOR, lightBufferTexelsPerUnit(engine));
    });

    // ── 3. A caster entering from the sun's side ────────────────────────
    // The sun shines to the right: its side is the left edge. Two 0.6 x 2
    // casters there: W_out wholly off screen (its right face 0.25 out), W_in
    // with its right face 0.5 in.
    sun.rotation(0).light(sunLight());
    const [xL, xR] = viewBounds(engine.cam.viewProjection);
    engine.batch(() => {
      keep(engine.spawn().position(xL - 0.55, cy + 3).scale(0.6, 2).castsShadow(true));
      keep(engine.spawn().position(xL + 0.2, cy + 8).scale(0.6, 2).castsShadow(true));
    });
    await frames(4);
    await pixelCheck(reporter, 'Directional edge pop (measured)', engine, async (probe) => {
      const viewWidth = xR - xL;
      const ds = Array.from({ length: Math.floor(viewWidth - 0.5) }, (_, i) => i + 1);
      // Along W_out, along W_in, between them along no caster; E 0.4 below W_in.
      const row = (dy: number) => ds.map((d): [number, number] => [xL + d, cy + dy]);
      const read = await probe('light-buffer', [...row(3), ...row(8), ...row(5.5), [xL + 1, cy + 6.6]], floorGroup());
      const n = ds.length;
      const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
      return edgePopVerdict(
        { out: read.slice(0, n), inn: read.slice(n, 2 * n), ref: read.slice(2 * n, 3 * n), e: read[3 * n] },
        ds,
        SUN_COLOR,
        { viewWidth, zoom: engine.cam.zoomLevel, canvas: [canvas?.width ?? 0, canvas?.height ?? 0] },
      );
    });
  } finally {
    for (const h of scene) h.destroy();
    await frames(4);
    restoreView();
  }
}
