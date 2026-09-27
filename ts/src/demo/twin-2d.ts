// ts/src/demo/twin-2d.ts — Demo section: the Transform2D archetype (spawn({ mode: '2d' }))
//
// Every 2D entity has a 3D twin with the same transform, a whole number of
// pixels to the right. Both must draw the same pixels: the 2D archetype is a
// compact encoding (20 bytes, 6 floats on the scatter path), not another look.
// Two of the ten entities per block move, so in Mode C most frames upload
// through the scatter pass — where root 2D rows travel compressed (format 0).
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';
import { worldToUv } from '../render/debug-probe';
import { pixelCheck, fmt, frames, fitView, type Rgba } from './probe-checks';

const entities: EntityHandle[] = [];

/** Centre of the 2D block; the 3D block sits about 12 units to the right. */
const BLOCK_X = -6;
const GAP = 12;
const CELL = 3.2;

/** One cell of a block: how to build it, on a handle of either archetype. */
interface Cell {
  build(h: EntityHandle): void;
  /** A child built under the cell's entity, if any. */
  child?(h: EntityHandle): void;
}

const CELLS: Cell[] = [
  { build: (h) => h.rotation(0.3).scale(2, 1) },
  { build: (h) => h.rotation(Math.PI / 4).scale(1.5, 1.5) },
  { build: (h) => h.rotation(1.2).scale(0.6, 2.2) },
  { build: (h) => h.rotation(0.4).scale(2, 2).gradient(0, 0, [0, 0, 0, 1, 1, 1]) },
  // A 2D parent with a 2D child: the child travels as a full mat4 (format 1).
  { build: (h) => h.rotation(0.5).scale(1.2, 1.2), child: (c) => c.position(0.9, 0).scale(0.4, 0.4) },
  { build: (h) => h.rotation(0.2).line(-1, -1, 1, 1, 0.15) },
  // The movers: dirty every frame, so they ride every scatter upload.
  { build: (h) => h.scale(0.8, 0.8).velocity(0.1, 0) },
  { build: (h) => h.rotation(0.6).scale(0.8, 0.8).velocity(0, -0.1) },
  { build: (h) => h.rotation(0.3).scale(2, 2).transparent().boxShadow(0.8, 0.8, 0.1, 0.05, 0.9, 0.5, 0.2, 0.9) },
];

const cellCentre = (i: number): [number, number] => [BLOCK_X + ((i % 3) - 1) * CELL, (Math.floor(i / 3) - 1) * CELL];

const section: DemoSection = {
  name: 'twin-2d',
  label: '2D archetype (Transform2D vs 3D twins)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    fitView(engine, BLOCK_X + GAP / 2, 0, GAP / 2 + CELL * 1.5 + 1.5);
    const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
    const width = canvas?.width ?? 1;
    const height = canvas?.height ?? 1;
    const vp = engine.cam.viewProjection;
    // The twin offset, rounded to whole pixels: sampled at matching texel
    // centres, the two blocks must then agree texel for texel.
    const worldPerPx = 2 / (vp[0] * width);
    const offsetPx = Math.round(GAP / worldPerPx);
    const offset = offsetPx * worldPerPx;

    const ids2D: number[] = [];
    engine.batch(() => {
      CELLS.forEach((cell, i) => {
        const [x, y] = cellCentre(i);
        for (const mode of ['2d', '3d'] as const) {
          const h = engine.spawn({ mode }).position(mode === '2d' ? x : x + offset, y);
          cell.build(h);
          entities.push(h);
          if (mode === '2d') ids2D.push(h.id);
          if (cell.child) {
            const c = engine.spawn({ mode }).parent(h.id);
            cell.child(c);
            entities.push(c);
            if (mode === '2d') ids2D.push(c.id);
          }
        }
      });
    });
    await frames(4);

    // ── 1. Same pixels ─────────────────────────────────────────────────
    await pixelCheck(reporter, 'Twins draw the same pixels', engine, async (probe) => {
      // World points snapped to texel centres (the probe floors uv * size).
      const snap = (x: number, y: number): [number, number] => {
        const [u, v] = worldToUv(x, y, vp);
        const cu = (Math.floor(u * width) + 0.5) / width;
        const cv = (Math.floor(v * height) + 0.5) / height;
        return [((cu - 0.5) * 2 - vp[12]) / vp[0], ((0.5 - cv) * 2 - vp[13]) / vp[5]];
      };
      // Per cell: a 9x9 lattice 0.3 apart, plus one row and one column of
      // CONSECUTIVE texels through the centre — those cross every edge, where
      // a sub-pixel difference between the twins would show.
      const LATTICE = 81;
      const half = 1.6;
      const steps = Math.ceil((2 * half) / worldPerPx);
      const cells: [number, number][][] = CELLS.map((_, i) => {
        const [cx, cy] = cellCentre(i);
        const pts: [number, number][] = [];
        for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) pts.push(snap(cx + a * 0.3, cy + b * 0.3));
        // Row and column interleaved from index LATTICE on: row k, column k.
        const [rx, ry] = snap(cx - half, cy);
        const [qx, qy] = snap(cx, cy - half);
        for (let k = 0; k <= steps; k++) pts.push([rx + k * worldPerPx, ry], [qx, qy + k * worldPerPx]);
        return pts;
      });
      const left = cells.flat();
      const right = left.map(([x, y]): [number, number] => [x + offset, y]);
      const [l, r] = await Promise.all([probe('scene-hdr', left), probe('scene-hdr', right)]);
      const peak = (p: Rgba) => Math.max(p[0], p[1], p[2]);
      let mismatches = 0;
      let worst = 0;
      let edges = 0;
      const emptyCells: number[] = [];
      let base = 0;
      cells.forEach((pts, cell) => {
        let drawn = 0;
        for (let n = 0; n < pts.length; n++) {
          const k = base + n;
          const d = Math.max(...[0, 1, 2].map((c) => Math.abs(l[k][c] - r[k][c])));
          worst = Math.max(worst, d);
          if (d > 0.02) mismatches++;
          if (peak(l[k]) > 0.1) drawn++;
          // An edge the scans cross: two consecutive texels of the row (or the
          // column) on either side of it. Quads have hard edges, so a shift of
          // the twin by a fraction of a pixel would move it by a whole texel.
          if (n >= LATTICE + 2 && Math.abs(peak(l[k]) - peak(l[k - 2])) > 0.3) edges++;
        }
        if (drawn === 0) emptyCells.push(cell);
        base += pts.length;
      });
      return {
        ok: mismatches === 0 && emptyCells.length === 0 && edges >= CELLS.length,
        detail: `${l.length - mismatches}/${l.length} texels match (worst ${fmt([worst])}), the scans crossing ${edges} edges; `
          + `twin offset ${offsetPx} px${emptyCells.length ? `; nothing drawn in cells ${emptyCells.join(', ')}` : ''}`,
      };
    });

    // ── 2. The rows the GPU holds ──────────────────────────────────────
    await pixelCheck(reporter, 'GPU rows of 2D entities', engine, async (_probe, readTransforms) => {
      const wanted = new Set(ids2D);
      let frameCount = 0;
      let scatterFrames = 0;
      let worst = 0;
      for (let f = 0; f < 12; f++) {
        const t = await readTransforms();
        frameCount++;
        if (t.usedScatter) scatterFrames++;
        for (let s = 0; s < t.entityCount; s++) {
          if (!wanted.has(t.entityIds[s])) continue;
          for (let w = 0; w < 16; w++) {
            const a = t.gpuRows[s * 16 + w];
            const b = t.cpuRows[s * 16 + w];
            worst = Math.max(worst, Math.abs(a - b) / Math.max(1, Math.abs(b)));
          }
        }
      }
      // Only Mode C uploads through the scatter pass; there the compressed
      // rows are the point of the check.
      const needScatter = engine.mode === 'C';
      return {
        ok: worst < 1e-5 && (!needScatter || scatterFrames > 0),
        detail: `${frameCount} frames, ${scatterFrames} via scatter (Mode ${engine.mode}); worst GPU/CPU difference ${worst.toExponential(1)}`,
      };
    });
  },

  teardown(engine: Hyperion) {
    for (const e of entities) if (e.alive) e.destroy();
    entities.length = 0;
    engine.cam.position(0, 0, 0);
    engine.cam.zoom(1);
  },
};

export default section;
