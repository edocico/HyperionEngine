// ts/src/demo/twin-2d.ts — Demo section: the Transform2D archetype (spawn({ mode: '2d' }))
//
// Every 2D entity has a 3D twin with the same transform, a whole number of
// pixels to the right. Both must draw the same pixels: the 2D archetype is a
// compact ECS component (20 bytes against 40), not another look. The 2D parent
// and its child move, so in Mode C most frames upload through the scatter
// pass: the parent as a root 2D row (format 0, rebuilt on the GPU from 6
// words), the child as a full matrix (format 1). A third check, off to the
// right, orders overlapping 2D sprites by depth (z = -depth).
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
  /** Where the child's centre lands, relative to the cell centre: scanned too. */
  childAt?: [number, number];
}

/** The parent of cell 4: turned 0.5 rad, scale 1.2; its child sits at local (0.9, 0). */
const PARENT_ROT = 0.5;
const PARENT_SCALE = 1.2;
const CHILD_LOCAL_X = 0.9;

const CELLS: Cell[] = [
  { build: (h) => h.rotation(0.3).scale(2, 1) },
  { build: (h) => h.rotation(Math.PI / 4).scale(1.5, 1.5) },
  { build: (h) => h.rotation(1.2).scale(0.6, 2.2) },
  { build: (h) => h.rotation(0.4).scale(2, 2).gradient(0, 0, [0, 0, 0, 1, 1, 1]) },
  // The movers: a 2D parent (a root, format 0 in a scatter upload) and its 2D
  // child (format 1: its Transform2D is local, so it travels as a full
  // matrix), dirty every frame. The only movers: 4 of the 20 entities, under
  // the 30% scatter threshold.
  {
    build: (h) => h.rotation(PARENT_ROT).scale(PARENT_SCALE, PARENT_SCALE).velocity(0.1, 0),
    child: (c) => c.position(CHILD_LOCAL_X, 0).scale(0.4, 0.4),
    childAt: [PARENT_SCALE * CHILD_LOCAL_X * Math.cos(PARENT_ROT), PARENT_SCALE * CHILD_LOCAL_X * Math.sin(PARENT_ROT)],
  },
  { build: (h) => h.rotation(0.2).line(-1, -1, 1, 1, 0.15) },
  { build: (h) => h.scale(0.8, 0.8) },
  { build: (h) => h.rotation(0.6).scale(0.8, 0.8) },
  { build: (h) => h.rotation(0.3).scale(2, 2).transparent().boxShadow(0.8, 0.8, 0.1, 0.05, 0.9, 0.5, 0.2, 0.9) },
];

const cellCentre = (i: number): [number, number] => [BLOCK_X + ((i % 3) - 1) * CELL, (Math.floor(i / 3) - 1) * CELL];

/** Centre of the depth scene, off to the right of the twins. */
const DEPTH_X = 40;

/**
 * Green and blue gradients (green / blue at their left end, fading to black):
 * the colour at a point says which sprite is in front. Depth is a distance
 * into the screen (z = -depth), so the SMALLER depth wins.
 */
async function checkDepth(engine: Hyperion, reporter: TestReporter): Promise<void> {
  const green = (h: EntityHandle) => h.gradient(0, 0, [0, 0, 1, 0, 1, 0]);
  const blue = (h: EntityHandle) => h.gradient(0, 0, [0, 0, 0, 1, 1, 0]);
  let a!: EntityHandle;
  let parent!: EntityHandle;
  engine.batch(() => {
    // A pair: green at depth 1 over blue at depth 2, the same 2x2 square.
    a = engine.spawn({ mode: '2d' }).position(DEPTH_X - 3, 0).scale(2, 2).depth(1);
    green(a);
    const b = engine.spawn({ mode: '2d' }).position(DEPTH_X - 3, 0).scale(2, 2).depth(2);
    blue(b);
    // A family: a white parent (depth 5), its green child at RELATIVE depth -1
    // (world 4) and a blue sibling root at 4.5 between them.
    parent = engine.spawn({ mode: '2d' }).position(DEPTH_X + 3, 0).scale(3, 3).depth(5);
    const child = engine.spawn({ mode: '2d' }).parent(parent.id).scale(0.3, 0.3).depth(-1);
    green(child);
    const sibling = engine.spawn({ mode: '2d' }).position(DEPTH_X + 3, 0).scale(1.8, 1.8).depth(4.5);
    blue(sibling);
    entities.push(a, b, parent, child, sibling);
  });
  fitView(engine, DEPTH_X, 0, 6);
  await frames(4);

  const colour = ([r, g, b]: Rgba) =>
    r > 0.9 && g > 0.9 && b > 0.9 ? 'white' : g > 0.5 && b < 0.2 ? 'green' : b > 0.5 && g < 0.2 ? 'blue' : `(${fmt([r, g, b])})`;
  // Near each gradient's left end (t ~ 0.1), where its colour is ~0.9.
  const pairPoint: [number, number] = [DEPTH_X - 3 - 0.8, 0];
  const childPoint: [number, number] = [DEPTH_X + 3 - 0.36, 0];   // inside the child (0.9 wide)
  const siblingPoint: [number, number] = [DEPTH_X + 3 - 0.72, 0]; // in the sibling, outside the child
  const parentPoint: [number, number] = [DEPTH_X + 3 - 1.2, 0];   // in the parent only

  await pixelCheck(reporter, 'Depth orders 2D sprites', engine, async (probe) => {
    const read = async () => (await probe('scene-hdr', [pairPoint, childPoint, siblingPoint, parentPoint])).map(colour);
    // Stable: the same winners on 10 consecutive frames.
    const first = await read();
    let stable = true;
    for (let f = 0; f < 9; f++) if ((await read()).join() !== first.join()) stable = false;
    // Swapped at runtime: blue in front of the pair; the parent moves to 3.5,
    // so its child follows to 2.5 and the sibling (4.5) goes behind the parent.
    a.depth(3);
    parent.depth(3.5);
    await frames(4);
    const after = await read();
    const want = ['green', 'green', 'blue', 'white'];
    const wantAfter = ['blue', 'green', 'white', 'white'];
    return {
      ok: stable && first.join() === want.join() && after.join() === wantAfter.join(),
      detail: `pair/child/sibling/parent: ${first.join(', ')}${stable ? ' (10 frames)' : ' (UNSTABLE)'}; after swapping depths: ${after.join(', ')}`,
    };
  });
}

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
      // Per cell: a 9x9 lattice 0.3 apart, plus scans of CONSECUTIVE texels —
      // one row and one column through the centre, and through the child where
      // there is one. Scans cross the edges, where a sub-pixel difference
      // between the twins would show: quads have hard edges, so a fraction of
      // a pixel moves an edge by a whole texel.
      const half = 1.6;
      const steps = Math.ceil((2 * half) / worldPerPx);
      const scanRow = (x: number, y: number): [number, number][] => {
        const [sx, sy] = snap(x - half, y);
        return Array.from({ length: steps + 1 }, (_, k): [number, number] => [sx + k * worldPerPx, sy]);
      };
      const scanColumn = (x: number, y: number): [number, number][] => {
        const [sx, sy] = snap(x, y - half);
        return Array.from({ length: steps + 1 }, (_, k): [number, number] => [sx, sy + k * worldPerPx]);
      };
      interface Group { cell: number; points: [number, number][]; scan: boolean; child: boolean }
      const groups: Group[] = [];
      CELLS.forEach((c, cell) => {
        const [cx, cy] = cellCentre(cell);
        const lattice: [number, number][] = [];
        for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) lattice.push(snap(cx + a * 0.3, cy + b * 0.3));
        groups.push({ cell, points: lattice, scan: false, child: false });
        groups.push({ cell, points: scanRow(cx, cy), scan: true, child: false });
        groups.push({ cell, points: scanColumn(cx, cy), scan: true, child: false });
        if (c.childAt) {
          const [dx, dy] = c.childAt;
          groups.push({ cell, points: scanRow(cx + dx, cy + dy), scan: true, child: true });
          groups.push({ cell, points: scanColumn(cx + dx, cy + dy), scan: true, child: true });
        }
      });
      const left = groups.flatMap((g) => g.points);
      const right = left.map(([x, y]): [number, number] => [x + offset, y]);
      const [l, r] = await Promise.all([probe('scene-hdr', left), probe('scene-hdr', right)]);
      const peak = (p: Rgba) => Math.max(p[0], p[1], p[2]);
      let mismatches = 0;
      let worst = 0;
      let edges = 0;
      const childEdges: number[] = [];
      const drawnPerCell = new Array<number>(CELLS.length).fill(0);
      let base = 0;
      for (const g of groups) {
        let groupEdges = 0;
        for (let n = 0; n < g.points.length; n++) {
          const k = base + n;
          const d = Math.max(...[0, 1, 2].map((c) => Math.abs(l[k][c] - r[k][c])));
          worst = Math.max(worst, d);
          if (d > 0.02) mismatches++;
          if (peak(l[k]) > 0.1) drawnPerCell[g.cell]++;
          if (g.scan && n > 0 && Math.abs(peak(l[k]) - peak(l[k - 1])) > 0.3) groupEdges++;
        }
        edges += groupEdges;
        if (g.child) childEdges.push(groupEdges);
        base += g.points.length;
      }
      const emptyCells = drawnPerCell.flatMap((n, cell) => (n === 0 ? [cell] : []));
      // The child is small (0.48 wide): each scan through it must cross both of its edges.
      const childCrossed = childEdges.length > 0 && childEdges.every((e) => e >= 2);
      return {
        ok: mismatches === 0 && emptyCells.length === 0 && edges >= CELLS.length && childCrossed,
        detail: `${l.length - mismatches}/${l.length} texels match (worst ${fmt([worst])}), the scans crossing ${edges} edges `
          + `(through the 2D child: ${childEdges.join(', ')}); twin offset ${offsetPx} px`
          + (emptyCells.length ? `; nothing drawn in cells ${emptyCells.join(', ')}` : ''),
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

    // ── 3. Depth: overlapping 2D sprites in depth order ────────────────
    await checkDepth(engine, reporter);
    fitView(engine, BLOCK_X + GAP / 2, 0, GAP / 2 + CELL * 1.5 + 1.5);
  },

  teardown(engine: Hyperion) {
    for (const e of entities) if (e.alive) e.destroy();
    entities.length = 0;
    engine.cam.position(0, 0, 0);
    engine.cam.zoom(1);
  },
};

export default section;
