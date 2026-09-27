// ts/src/demo/lifecycle.ts — Demo section: spawn/destroy, batch, compact, immediate mode, entity data, prefabs
//
// The lifecycle checks read what the GPU drew before and after each step
// (engine.debug.probe on scene-hdr): a handle's `alive` flag says nothing
// about whether the entity is on screen.
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';
import { pixelCheck, near, fmt, frames, fitView } from './probe-checks';

const entities: EntityHandle[] = [];

/** The clear colour of scene-hdr (ForwardPass). */
const BACKGROUND = 0.067;
const white = (p: number[]) => p[0] > 0.9;
const clear = (p: number[]) => near(p[0], BACKGROUND, 0.01);

/** Batch grid: 5 rows x 10 columns of 0.5x0.5 quads, 1.5 apart, rows from y = 5. */
const cell = (row: number, col: number): [number, number] => [(col - 4.5) * 1.5, (row - 2) * 1.5 + 8];

const section: DemoSection = {
  name: 'lifecycle',
  label: 'Lifecycle & DX (Spawn/Destroy / Batch / Compact / Immediate / Prefabs)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    // Probe points span x -12..12.25: fit them at any aspect.
    fitView(engine, 0, 0, 13.5);

    // ── 1. Spawn + destroy: drawn, then gone ───────────────────────────
    await pixelCheck(reporter, 'Spawn + destroy', engine, async (probe) => {
      const e = engine.spawn().position(-12, -6, 0);
      try {
        await frames(4);
        const [drawn] = await probe('scene-hdr', [[-12, -6]]);
        e.destroy();
        await frames(4);
        const [gone] = await probe('scene-hdr', [[-12, -6]]);
        return { ok: white(drawn) && clear(gone), detail: `after spawn ${fmt([drawn[0]])}, after destroy ${fmt([gone[0]])}` };
      } finally {
        if (e.alive) e.destroy(); // a skipped or failed probe must not leave it on screen
      }
    });

    // ── 2. Batch operation ─────────────────────────────────────────────
    engine.batch(() => {
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 10; col++) {
          entities.push(engine.spawn().position(...cell(row, col), 0).scale(0.5, 0.5, 1));
        }
      }
    });
    await frames(4);
    await pixelCheck(reporter, 'Batch operation', engine, async (probe) => {
      // Rows 0-3 (row 4 is above the view).
      const points: [number, number][] = [];
      for (let row = 0; row < 4; row++) for (let col = 0; col < 10; col++) points.push(cell(row, col));
      const drawn = (await probe('scene-hdr', points)).filter(white).length;
      return { ok: drawn === points.length, detail: `${drawn}/${points.length} batch quads drawn in view` };
    });

    // ── 3. Compact: the destroyed are gone, the survivors still drawn ──
    const toDestroy = entities.splice(0, 25); // rows 0-1 and half of row 2
    for (const d of toDestroy) d.destroy();
    let compactThrew: string | null = null;
    try {
      engine.compact({ entityMap: true, renderState: true });
    } catch (err) {
      compactThrew = err instanceof Error ? err.message : String(err);
    }
    await frames(4);
    if (compactThrew) {
      reporter.check('Compact', false, `compact threw: ${compactThrew}`);
    } else {
      await pixelCheck(reporter, 'Compact', engine, async (probe) => {
        const [destroyedA, destroyedB, survivorA, survivorB] = await probe('scene-hdr', [
          cell(0, 0), cell(2, 4), cell(2, 5), cell(3, 9),
        ]);
        const ok = clear(destroyedA) && clear(destroyedB) && white(survivorA) && white(survivorB);
        return { ok, detail: `destroyed ${fmt([destroyedA[0], destroyedB[0]])}, survivors ${fmt([survivorA[0], survivorB[0]])}` };
      });
    }

    // ── 4. Immediate mode: drawn at the immediate position ─────────────
    const imm = engine.spawn().position(0, 0, 0).scale(1, 1, 1);
    entities.push(imm);
    try {
      imm.positionImmediate(5, 5, 0);
      await frames(4);
      await pixelCheck(reporter, 'Immediate mode', engine, async (probe) => {
        const [there, origin] = await probe('scene-hdr', [[5, 5], [0, 0]]);
        return { ok: white(there) && clear(origin), detail: `at (5, 5) ${fmt([there[0]])}, at the spawn point ${fmt([origin[0]])}` };
      });
      imm.clearImmediate();
    } catch (err) {
      reporter.check('Immediate mode', false, `immediate mode threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── 5. EntityHandle.data() ─────────────────────────────────────────
    const dataEnt = engine.spawn().position(2, 0, 0).scale(1, 1, 1);
    entities.push(dataEnt);
    dataEnt.data('key', 42);
    const readBack = dataEnt.data('key');
    reporter.check('EntityHandle.data()', readBack === 42, `wrote 42, read back ${String(readBack)}`);

    // ── 6. Prefab lifecycle: moved with its children, then gone ────────
    try {
      engine.prefabs.register('demo-test', {
        root: { position: [5, -2, 0], scale: [1.5, 1.5, 1] },
        children: {
          left: { position: [-1.5, 0, 0], scale: [0.5, 0.5, 1] },
          right: { position: [1.5, 0, 0], scale: [0.5, 0.5, 1] },
        },
      });
      const instance = engine.prefabs.spawn('demo-test', { x: 5, y: -2 });
      instance.moveTo(10, -4);
      await frames(4);
      await pixelCheck(reporter, 'Prefab lifecycle', engine, async (probe) => {
        // Children at local (+-1.5, 0) under a 1.5-scaled root: world 10 +- 2.25.
        const [root, left, right, oldPlace] = await probe('scene-hdr', [[10, -4], [7.75, -4], [12.25, -4], [5, -2]]);
        instance.destroyAll();
        await frames(4);
        const [afterDestroy] = await probe('scene-hdr', [[10, -4]]);
        const ok = white(root) && white(left) && white(right) && clear(oldPlace) && clear(afterDestroy);
        return {
          ok,
          detail: `moved: root ${fmt([root[0]])}, children ${fmt([left[0], right[0]])}, old place ${fmt([oldPlace[0]])}; after destroyAll ${fmt([afterDestroy[0]])}`,
        };
      });
      if (instance.root.alive) instance.destroyAll();
      engine.prefabs.unregister('demo-test');
    } catch (err) {
      reporter.check('Prefab lifecycle', false, `prefab lifecycle threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  teardown(engine: Hyperion) {
    engine.cam.position(0, 0, 0);
    engine.cam.zoom(1);
    for (const e of entities) {
      if (e.alive) e.destroy();
    }
    entities.length = 0;
    try { engine.prefabs.unregister('demo-test'); } catch { /* may not exist */ }
  },
};

export default section;
