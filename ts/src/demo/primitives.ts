// ts/src/demo/primitives.ts — Demo section: all 6 render primitive types
//
// Every check reads what the GPU drew (engine.debug.probe on scene-hdr, linear
// values): the clear is 0.067, an untextured primitive 1.0. Checks that only
// counted spawns passed with nothing on screen.
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';
import { pixelCheck, near, fmt, frames, fitView, type Rgba } from './probe-checks';

const entities: EntityHandle[] = [];

/** The clear colour of scene-hdr (ForwardPass). */
const BACKGROUND = 0.067;
/** Half the width of the scene below, margin included: it fits any aspect. */
const SCENE_HALF_WIDTH = 19;
const SCENE_CENTER_X = 4.5;

const GRADIENT_X = -12.5;
const SHADOW_X = -8;
const LINE_X0 = 8;
const BEZIER_X = 21;
/** The wave's control points (uv) and every curve's width; 'Straight bezier' restores the wave from these. */
const WAVE: readonly [number, number, number, number, number, number] = [0, 0.5, 0.5, 0, 1, 0.5];
const BEZIER_WIDTH = 0.04;

const section: DemoSection = {
  name: 'primitives',
  label: 'Primitives (Quad / Line / Gradient / BoxShadow / Bezier)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    let wave!: EntityHandle;
    engine.batch(() => {
      // ── 1. Quad grid (5x5), 1x1 white quads 2.5 apart ─────────────────
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
          entities.push(engine.spawn().position((col - 2) * 2.5, (row - 2) * 2.5, 0));
        }
      }

      // ── 2. Gradients: stop0 at 0, stop1 at 1 (stop1 green/blue ride in the
      // texture index, so the API gives stop1 red only) ─────────────────────
      // Linear, angle 0: blue on the left to red on the right.
      entities.push(engine.spawn().position(GRADIENT_X, 4, 0).scale(3, 3, 1).gradient(0, 0, [0, 0, 0, 1, 1, 1]));
      // Radial: white at the centre to black at the edge.
      entities.push(engine.spawn().position(GRADIENT_X, 0, 0).scale(3, 3, 1).gradient(1, 0, [0, 1, 1, 1, 1, 0]));
      // Conic: a hard seam on the left radius (green just on one side, red on the
      // other), half red, half green on the right.
      entities.push(engine.spawn().position(GRADIENT_X, -4, 0).scale(3, 3, 1).gradient(2, 0, [0, 0, 1, 0, 1, 1]));

      // ── 3. Box shadows: alpha-blended, or the opaque pipeline draws a solid square
      entities.push(engine.spawn().position(SHADOW_X, 4, 0).scale(3, 3, 1).transparent()
        .boxShadow(0.8, 0.8, 0, 0, 0.2, 0.2, 0.2, 0.9));   // sharp
      entities.push(engine.spawn().position(SHADOW_X, 0, 0).scale(3, 3, 1).transparent()
        .boxShadow(0.7, 0.7, 0, 0.3, 0.1, 0.1, 0.4, 0.8));  // soft
      // Rounded, and crisp: the box-shadow library rounds the corners only in its
      // no-blur branch (the blurred one ignores cornerRadius).
      entities.push(engine.spawn().position(SHADOW_X, -4, 0).scale(3, 3, 1).transparent()
        .boxShadow(0.6, 0.6, 0.2, 0, 0.4, 0.1, 0.1, 0.85)); // rounded

      // ── 4. Lines: 6 vertical, 0.15 world units wide (scale with the zoom);
      // 4 horizontal, 3 screen pixels wide at every zoom ────────────────────
      for (let i = 0; i < 6; i++) {
        entities.push(engine.spawn().position(LINE_X0 + i * 2, 0, 0).line(0, -5, 0, 5, 0.15));
      }
      for (let i = 0; i < 4; i++) {
        entities.push(engine.spawn().position(LINE_X0 + 5, -3 + i * 2, 0).line(-5, 0, 5, 0, 3, { unit: 'px' }));
      }

      // ── 5. Bezier curves: the arch and the S pass through their quad's
      // centre at t = 0.5 ─────────────────────────────────────────────────
      entities.push(engine.spawn().position(BEZIER_X, 4, 0).scale(4, 4, 1).bezier(0, 0, 0.5, 1, 1, 0, BEZIER_WIDTH));   // arch
      entities.push(engine.spawn().position(BEZIER_X, 0, 0).scale(4, 4, 1).bezier(0, 0, 1, 0.5, 0, 1, BEZIER_WIDTH));   // S
      wave = engine.spawn().position(BEZIER_X, -4, 0).scale(4, 4, 1).bezier(...WAVE, BEZIER_WIDTH);
      entities.push(wave);
    });

    fitView(engine, SCENE_CENTER_X, 0, SCENE_HALF_WIDTH);
    await frames(4);

    await pixelCheck(reporter, 'Quad grid (5x5)', engine, async (probe) => {
      const centres: [number, number][] = [];
      for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) centres.push([(col - 2) * 2.5, (row - 2) * 2.5]);
      const gaps: [number, number][] = [[1.25, 1.25], [-1.25, -1.25], [3.75, 1.25], [-3.75, 3.75]];
      const v = await probe('scene-hdr', [...centres, ...gaps]);
      const white = v.slice(0, 25).filter((p) => near(p[0], 1, 0.02) && near(p[1], 1, 0.02) && near(p[2], 1, 0.02)).length;
      const clear = v.slice(25).filter((p) => near(p[0], BACKGROUND, 0.01)).length;
      return { ok: white === 25 && clear === gaps.length, detail: `${white}/25 centres white, ${clear}/${gaps.length} gaps at the clear` };
    });

    await pixelCheck(reporter, 'Gradients (linear/radial/conic)', engine, async (probe) => {
      const at = (y: number, dx: number, dy = 0): [number, number] => [GRADIENT_X + dx * 3, y + dy * 3];
      const [linL, linR, radC, radE, seamA, seamB, conR] = await probe('scene-hdr', [
        at(4, -0.3), at(4, 0.3),         // linear: 20% and 80% across
        at(0, 0), at(0, 0.45),           // radial: centre and near the edge
        // conic: both sides of the seam, 0.15 world units off it (a probe ON
        // the seam read red or green depending on the canvas height), and the
        // opposite side (t = 0.5)
        at(-4, -0.3, 0.05), at(-4, -0.3, -0.05), at(-4, 0.3),
      ]);
      const linear = linL[2] > linL[0] + 0.3 && linR[0] > linR[2] + 0.3;
      const radial = radC[0] > 0.9 && radE[0] < 0.2;
      const green = (p: Rgba) => p[1] > 0.8 && p[0] < 0.2;
      const red = (p: Rgba) => p[0] > 0.8 && p[1] < 0.2;
      const conic = ((green(seamA) && red(seamB)) || (red(seamA) && green(seamB))) && near(conR[0], 0.5, 0.15);
      const conL = seamA;
      const show = (p: Rgba) => `(${fmt(p.slice(0, 3))})`;
      return {
        ok: linear && radial && conic,
        detail: `linear ${show(linL)} -> ${show(linR)}; radial ${show(radC)} -> ${show(radE)}; conic seam ${show(conL)} | ${show(seamB)}, opposite ${show(conR)}`,
      };
    });

    await pixelCheck(reporter, 'Box shadows (sharp/soft/rounded)', engine, async (probe) => {
      const at = (y: number, dx: number, dy = 0): [number, number] => [SHADOW_X + dx * 3, y + dy * 3];
      // Rounded (crisp, rect = the quad): 0.29 of 0.3 out along an edge is
      // inside; the same inset at the corner is outside the 0.2 radius.
      const inset = 0.29 / 0.6;
      const [sharpC, sharpOut, softC, softEdge, roundEdge, roundCorner] = await probe('scene-hdr', [
        // sharp: inside, and just outside the entity quad — with no blur the
        // rect fills the quad (it spans rect + 2 * blur per side)
        at(4, 0), at(4, 0.55, 0.55),
        at(0, 0), at(0, 0.47),           // soft: centre, where the blur has faded
        at(-4, inset), at(-4, inset, inset), // rounded: along an edge, in the cut-off corner
      ]);
      // Alpha-blended over the clear: bg * (1 - a) + colour * a.
      const blend = (c: number, a: number) => BACKGROUND * (1 - a) + c * a;
      const sharp = near(sharpC[0], blend(0.2, 0.9), 0.02) && near(sharpOut[0], BACKGROUND, 0.01);
      const soft = near(softC[2], blend(0.4, 0.8), 0.03) && softEdge[2] < softC[2] - 0.1;
      const rounded = near(roundEdge[0], blend(0.4, 0.85), 0.02) && near(roundCorner[0], BACKGROUND, 0.01);
      return {
        ok: sharp && soft && rounded,
        detail: `sharp ${fmt([sharpC[0], sharpOut[0]])} (want ${fmt([blend(0.2, 0.9), BACKGROUND])}); soft b ${fmt([softC[2], softEdge[2]])}; rounded r edge ${fmt([roundEdge[0]])} (want ${fmt([blend(0.4, 0.85)])}), corner ${fmt([roundCorner[0]])}`,
      };
    });

    await pixelCheck(reporter, 'Lines (6V world + 4H 3px)', engine, async (probe) => {
      // A vertical line at x = LINE_X0 between two horizontals (y = 1 and 3).
      const [onV, besideV] = await probe('scene-hdr', [[LINE_X0, 2], [LINE_X0 + 0.3, 2]]);
      // The horizontal line at y = 1, one screen pixel apart, across it.
      const vp = engine.cam.viewProjection;
      const worldPerPx = 2 / vp[5] / (document.querySelector('canvas')?.height ?? 1);
      const column: [number, number][] = [];
      for (let k = -4; k <= 4; k++) column.push([LINE_X0 + 1, 1 + k * worldPerPx]);
      const rows = (await probe('scene-hdr', column)).filter((p) => p[0] > 0.5).length;
      const ok = near(onV[0], 1, 0.02) && near(besideV[0], BACKGROUND, 0.01) && rows === 3;
      return { ok, detail: `vertical ${fmt([onV[0], besideV[0]])}; horizontal covers ${rows} pixel rows (want 3)` };
    });

    await pixelCheck(reporter, 'Bezier curves (arch/S/wave)', engine, async (probe) => {
      // Arch and S pass through their quad's centre; both off-curve points
      // below are off the curve whichever way the quad's v runs. The wave
      // passes (0.5, 0.25) in uv: one unit above or below the centre (by the
      // quad's v direction), never through it.
      const [archC, archOff1, archOff2, sC, waveMid, waveUp, waveDown] = await probe('scene-hdr', [
        [BEZIER_X, 4], [BEZIER_X, 4 + 0.45 * 4], [BEZIER_X, 4 - 0.45 * 4],
        [BEZIER_X, 0],
        [BEZIER_X, -4], [BEZIER_X, -3], [BEZIER_X, -5],
      ]);
      const wave = near(waveMid[0], BACKGROUND, 0.01) && ((waveUp[0] > 0.5) !== (waveDown[0] > 0.5));
      const ok = archC[0] > 0.5 && near(archOff1[0], BACKGROUND, 0.01) && near(archOff2[0], BACKGROUND, 0.01) && sC[0] > 0.5 && wave;
      return { ok, detail: `arch centre ${fmt([archC[0]])}, off-curve ${fmt([archOff1[0], archOff2[0]])}; S centre ${fmt([sC[0]])}; wave centre ${fmt([waveMid[0]])}, one unit off ${fmt([waveUp[0], waveDown[0]])}` };
    });

    await pixelCheck(reporter, 'Straight bezier', engine, async (probe) => {
      // A quadratic whose control point is the middle of its chord IS that
      // chord, and bezier_sd's cubic loses its leading term there
      // (B = p0 - 2 p1 + p2 = 0, which it divided by). On Metal (Mac M2,
      // 2026-09-29) such a curve drew a dot around p0 instead of the segment.
      // The wave is made straight, then nearly straight, for this check only
      // and restored after it: no entity is spawned, so ids stay those of the
      // M4 baseline. The line runs along v = 0.5, the quad's middle row,
      // whichever way its v runs; world x = BEZIER_X + (u - 0.5) * 4.
      const onLine: [number, number][] = [[BEZIER_X, -4], [BEZIER_X - 0.8, -4]];                    // u = 0.5, 0.3
      const offLine: [number, number][] = [[BEZIER_X, -3.6], [BEZIER_X, -4.4], [BEZIER_X + 1.8, -4]]; // v ± 0.1, u = 0.95 (past p2)
      const parts: string[] = [];
      let ok = true;
      try {
        for (const [label, dv] of [['straight', 0], ['1e-5 off', 1e-5], ['1e-4 off', 1e-4], ['1e-3 off', 1e-3], ['1e-2 off', 1e-2]] as const) {
          wave.bezier(0.1, 0.5, 0.5, 0.5 + dv, 0.9, 0.5, BEZIER_WIDTH);
          await frames(4);
          const values = await probe('scene-hdr', [...onLine, ...offLine]);
          const on = values.slice(0, onLine.length).map((p) => p[0]);
          const off = values.slice(onLine.length).map((p) => p[0]);
          ok = ok && on.every((v) => v > 0.5) && off.every((v) => near(v, BACKGROUND, 0.01));
          parts.push(`${label}: on ${fmt(on)}, off ${fmt(off)}`);
        }
      } finally {
        wave.bezier(...WAVE, BEZIER_WIDTH);
        await frames(4);
      }
      return { ok, detail: parts.join('; ') };
    });

    await pixelCheck(reporter, 'Near-straight bezier (35.26°)', engine, async (probe) => {
      // bezier_sd's cubic coefficient p = ky - kx^2 is the difference of two
      // terms ~1/|B|^2 that cancel when the control point's offset from the
      // chord's middle makes 35.26° (cos^2 = 2/3) or 144.74° with the chord:
      // there f32 left only rounding error, and on the Mac M2 (2026-09-29) a
      // near-straight curve drew noise (70% of the stroke missing and pixels
      // lit around it at an offset of 1e-4, holes up to 2e-2). Same method as
      // 'Straight bezier': the wave is reshaped and restored, nothing spawned.
      // The curve stays within |B|/4 = offset/2 of its chord.
      const inside: [number, number][] = [];
      const outside: [number, number][] = [];
      for (let u = 0.15; u <= 0.8501; u += 0.05) {
        for (const dv of [0, 0.008, -0.008]) inside.push([BEZIER_X + (u - 0.5) * 4, -4 + dv * 4]);
      }
      for (let u = 0.2; u <= 0.8001; u += 0.1) {
        for (const dv of [0.05, -0.05, 0.1, -0.1]) outside.push([BEZIER_X + (u - 0.5) * 4, -4 + dv * 4]);
      }
      const parts: string[] = [];
      let ok = true;
      try {
        for (const deg of [35.26, 144.74]) {
          for (const offset of [1e-4, 1e-3, 5e-3]) {
            const a = (deg * Math.PI) / 180;
            wave.bezier(0.1, 0.5, 0.5 + offset * Math.cos(a), 0.5 + offset * Math.sin(a), 0.9, 0.5, BEZIER_WIDTH);
            await frames(4);
            const values = await probe('scene-hdr', [...inside, ...outside]);
            const holes = values.slice(0, inside.length).filter((p) => p[0] <= 0.5).length;
            const ghosts = values.slice(inside.length).filter((p) => !near(p[0], BACKGROUND, 0.01)).length;
            ok = ok && holes === 0 && ghosts === 0;
            parts.push(`${deg}° ${offset}: ${holes}/${inside.length} holes, ${ghosts}/${outside.length} lit outside`);
          }
        }
      } finally {
        wave.bezier(...WAVE, BEZIER_WIDTH);
        await frames(4);
      }
      return { ok, detail: parts.join('; ') };
    });

    // ── 6. MSDF text — skip (no font atlas in demo assets) ────────────
    reporter.skip('MSDF text', 'no font atlas in demo assets');
  },

  teardown(engine: Hyperion) {
    for (const e of entities) e.destroy();
    entities.length = 0;
    engine.cam.position(0, 0, 0);
    engine.cam.zoom(1);
  },
};

export default section;
