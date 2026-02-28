// ts/src/demo/scene-graph.ts — Demo section: parenting, velocity, rotation, scale, nested transforms
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';
import type { HookFn } from '../game-loop';

const entities: EntityHandle[] = [];
const hooks: { phase: 'preTick' | 'postTick' | 'frameEnd'; fn: HookFn }[] = [];

const section: DemoSection = {
  name: 'scene-graph',
  label: 'Scene Graph (Parenting / Rotation / Velocity / Scale)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    // ── 1. Parent/child hierarchy ──────────────────────────────────────
    let parentChildOk = false;
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

      parentChildOk = parent.alive && child1.alive && child2.alive;
    });
    reporter.check(
      'Parent/child hierarchy',
      parentChildOk,
      'spawned parent + 2 children with .parent(parentId)',
    );

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
    let rotationOk = false;
    engine.batch(() => {
      const rotated = engine.spawn()
        .position(-4, -2, 0)
        .scale(2, 2, 1)
        .rotation(0, 0, sinZ, cosZ);
      entities.push(rotated);
      rotationOk = rotated.alive;
    });
    reporter.check(
      'Rotation',
      rotationOk,
      `45deg Z-rotation (quat: 0, 0, ${sinZ.toFixed(3)}, ${cosZ.toFixed(3)})`,
    );

    // ── 4. Scale ───────────────────────────────────────────────────────
    const scales: [number, number, number][] = [
      [0.5, 0.5, 1],
      [1, 1, 1],
      [2, 2, 1],
      [3, 1, 1],
    ];
    let scaleCount = 0;
    engine.batch(() => {
      for (let i = 0; i < scales.length; i++) {
        const [sx, sy, sz] = scales[i];
        const e = engine.spawn()
          .position(4 + i * 3, -2, 0)
          .scale(sx, sy, sz);
        entities.push(e);
        scaleCount++;
      }
    });
    reporter.check(
      'Scale',
      scaleCount === 4,
      `spawned ${scaleCount} entities with scales 0.5, 1, 2, 3x1`,
    );

    // ── 5. Nested transforms (3-level hierarchy) ───────────────────────
    let nestedOk = false;
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

      nestedOk = grandparent.alive && mid.alive && leaf.alive;
    });
    reporter.check(
      'Nested transforms',
      nestedOk,
      '3-level hierarchy: grandparent -> mid -> leaf',
    );

    // ── Camera: position to show scene graph content ───────────────────
    engine.cam.position(2, 0, 0);
    engine.cam.zoom(1);
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
