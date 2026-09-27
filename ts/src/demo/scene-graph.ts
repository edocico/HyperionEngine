// ts/src/demo/scene-graph.ts — Demo section: parenting, velocity, rotation, scale, nested transforms
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';
import type { HookFn } from '../game-loop';
import { pixelCheck, near, fmt, frames } from './probe-checks';

/** The clear colour of scene-hdr (ForwardPass). */
const BACKGROUND = 0.067;

const entities: EntityHandle[] = [];
const hooks: { phase: 'preTick' | 'postTick' | 'frameEnd'; fn: HookFn }[] = [];

const section: DemoSection = {
  name: 'scene-graph',
  label: 'Scene Graph (Parenting / Rotation / Velocity / Scale)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    // Every check below reads where the GPU drew each entity: the world
    // positions follow from composing the transforms by hand.

    // ── 1. Parent/child hierarchy ──────────────────────────────────────
    engine.batch(() => {
      const parent = engine.spawn()
        .position(0, 6, 0)
        .scale(2, 2, 1);
      entities.push(parent);

      const child1 = engine.spawn()
        .position(-2, 0, 0)
        .scale(0.8, 0.8, 1)
        .parent(parent.id);
      entities.push(child1);

      const child2 = engine.spawn()
        .position(2, 0, 0)
        .scale(0.8, 0.8, 1)
        .parent(parent.id);
      entities.push(child2);
    });

    // ── 2. Velocity ────────────────────────────────────────────────────
    const moverX0 = -8;
    let mover: EntityHandle | null = null;
    engine.batch(() => {
      mover = engine.spawn()
        .position(moverX0, 2, 0)
        .scale(1, 1, 1)
        .velocity(2, 0, 0);
      entities.push(mover);
    });

    // Mark as pending — resolved asynchronously via postTick hook
    reporter.pending('Velocity');

    const moverId = mover!.id;
    const velocityHook: HookFn = (_dt, views) => {
      if (!views) return;
      for (let i = 0; i < views.entityCount; i++) {
        if (views.entityIds[i] === moverId) {
          const currentX = views.transforms[i * 16 + 12];
          if (currentX !== moverX0) {
            reporter.check(
              'Velocity',
              true,
              `position moved from ${moverX0} to ${currentX.toFixed(2)}`,
            );
            // Stop checking once we've confirmed movement
            engine.removeHook('postTick', velocityHook);
            const idx = hooks.findIndex(h => h.fn === velocityHook);
            if (idx >= 0) hooks.splice(idx, 1);
          }
          break;
        }
      }
    };
    engine.addHook('postTick', velocityHook);
    hooks.push({ phase: 'postTick', fn: velocityHook });

    // ── 3. Rotation ────────────────────────────────────────────────────
    // 45-degree Z-rotation: quaternion (0, 0, sin(pi/8), cos(pi/8))
    const angle = Math.PI / 4;
    const sinZ = Math.sin(angle / 2);
    const cosZ = Math.cos(angle / 2);
    engine.batch(() => {
      entities.push(engine.spawn()
        .position(-4, -2, 0)
        .scale(2, 2, 1)
        .rotation(0, 0, sinZ, cosZ));
    });

    // ── 4. Scale ───────────────────────────────────────────────────────
    const scales: [number, number, number][] = [
      [0.5, 0.5, 1],
      [1, 1, 1],
      [2, 2, 1],
      [3, 1, 1],
    ];
    engine.batch(() => {
      for (let i = 0; i < scales.length; i++) {
        const [sx, sy, sz] = scales[i];
        entities.push(engine.spawn()
          .position(4 + i * 3, -2, 0)
          .scale(sx, sy, sz));
      }
    });

    // ── 5. Nested transforms (3-level hierarchy) ───────────────────────
    engine.batch(() => {
      const grandparent = engine.spawn()
        .position(0, -6, 0)
        .scale(3, 3, 1);
      entities.push(grandparent);

      const mid = engine.spawn()
        .position(1, 0, 0)
        .scale(0.6, 0.6, 1)
        .parent(grandparent.id);
      entities.push(mid);

      const leaf = engine.spawn()
        .position(0.5, 0, 0)
        .scale(0.5, 0.5, 1)
        .parent(mid.id);
      entities.push(leaf);
    });

    // ── Camera: position to show scene graph content ───────────────────
    engine.cam.position(2, 0, 0);
    engine.cam.zoom(1);
    await frames(4);

    const white = (p: number[]) => p[0] > 0.9;
    const clear = (p: number[]) => near(p[0], BACKGROUND, 0.01);

    await pixelCheck(reporter, 'Parent/child hierarchy', engine, async (probe) => {
      // Children at local (+-2, 0), scale 0.8, under a parent at (0, 6) with
      // scale 2: world (+-4, 6), 1.6 wide. (+-2, 6) is where a child drawn
      // without its parent's scale would sit.
      const v = await probe('scene-hdr', [[0, 6], [-4, 6], [4, 6], [-2, 6], [2, 6]]);
      const ok = white(v[0]) && white(v[1]) && white(v[2]) && clear(v[3]) && clear(v[4]);
      return { ok, detail: `parent ${fmt([v[0][0]])}, children ${fmt([v[1][0], v[2][0]])}, between ${fmt([v[3][0], v[4][0]])}` };
    });

    await pixelCheck(reporter, 'Rotation', engine, async (probe) => {
      // A 2x2 square turned 45 deg is a diamond with vertices 1.41 from its
      // centre: (+1.2, 0) is inside only if it turned, the unturned corner
      // (+0.9, +0.9) outside only if it turned.
      const v = await probe('scene-hdr', [[-4 + 1.2, -2], [-4 + 0.9, -2 + 0.9], [-4, -2]]);
      const ok = white(v[0]) && clear(v[1]) && white(v[2]);
      return { ok, detail: `on the diamond's vertex axis ${fmt([v[0][0]])}, unturned corner ${fmt([v[1][0]])}, centre ${fmt([v[2][0]])}` };
    });

    await pixelCheck(reporter, 'Scale', engine, async (probe) => {
      // Quads at x = 4, 7, 10, 13 with scales 0.5, 1, 2 and 3x1.
      const v = await probe('scene-hdr', [
        [4, -2], [4 + 0.4, -2],        // 0.5: centre drawn, 0.4 out already clear
        [10 + 0.9, -2],                // 2: 0.9 from the centre still drawn
        [13 + 1.4, -2], [13, -2 + 0.7], // 3x1: wide, but not tall
      ]);
      const ok = white(v[0]) && clear(v[1]) && white(v[2]) && white(v[3]) && clear(v[4]);
      return { ok, detail: `0.5x ${fmt([v[0][0], v[1][0]])}, 2x edge ${fmt([v[2][0]])}, 3x1 ${fmt([v[3][0], v[4][0]])}` };
    });

    await pixelCheck(reporter, 'Nested transforms', engine, async (probe) => {
      // grandparent (0,-6) x3 -> mid local (1,0) x0.6 = world (3,-6), 1.8 wide
      // -> leaf local (0.5,0) x0.5 = world (3.9,-6), 0.9 wide. (4.25,-6) lies
      // past the mid's edge (3.9): only a leaf composed through BOTH parents covers it.
      const v = await probe('scene-hdr', [[0, -6], [3, -6], [4.25, -6], [4.6, -6]]);
      const ok = white(v[0]) && white(v[1]) && white(v[2]) && clear(v[3]);
      return { ok, detail: `grandparent ${fmt([v[0][0]])}, mid ${fmt([v[1][0]])}, leaf ${fmt([v[2][0]])}, past the leaf ${fmt([v[3][0]])}` };
    });
  },

  teardown(engine: Hyperion) {
    for (const { phase, fn } of hooks) engine.removeHook(phase, fn);
    hooks.length = 0;
    for (const e of entities) e.destroy();
    entities.length = 0;
    engine.cam.position(0, 0, 0);
    engine.cam.zoom(1);
  },
};

export default section;
