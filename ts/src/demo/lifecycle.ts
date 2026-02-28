// ts/src/demo/lifecycle.ts — Demo section: spawn/destroy, batch, compact, immediate mode, entity data, prefabs
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';

const entities: EntityHandle[] = [];

const section: DemoSection = {
  name: 'lifecycle',
  label: 'Lifecycle & DX (Spawn/Destroy / Batch / Compact / Immediate / Prefabs)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    // ── 1. Spawn + destroy ─────────────────────────────────────────────
    const e = engine.spawn().position(0, 0, 0).scale(1, 1, 1);
    const wasAlive = e.alive;
    e.destroy();
    const isDead = !e.alive;
    reporter.check(
      'Spawn + destroy',
      wasAlive && isDead,
      `alive before destroy: ${wasAlive}, alive after destroy: ${!isDead}`,
    );

    // ── 2. Batch operation ─────────────────────────────────────────────
    const batchBefore = entities.length;
    engine.batch(() => {
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 10; col++) {
          const x = (col - 4.5) * 1.5;
          const y = (row - 2) * 1.5 + 8;
          const ent = engine.spawn()
            .position(x, y, 0)
            .scale(0.5, 0.5, 1);
          entities.push(ent);
        }
      }
    });
    const batchCount = entities.length - batchBefore;
    reporter.check(
      'Batch operation',
      batchCount === 50,
      `spawned ${batchCount} entities in batch`,
    );

    // ── 3. Compact ─────────────────────────────────────────────────────
    // Destroy 25 entities from the batch, then compact
    const toDestroy = entities.splice(0, 25);
    for (const d of toDestroy) d.destroy();

    let compactOk = false;
    try {
      engine.compact({ entityMap: true, renderState: true });
      compactOk = true;
    } catch (err) {
      reporter.check(
        'Compact',
        false,
        `compact threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (compactOk) {
      reporter.check('Compact', true, 'destroyed 25, compact({ entityMap, renderState }) succeeded');
    }

    // ── 4. Immediate mode ──────────────────────────────────────────────
    const imm = engine.spawn().position(0, 0, 0).scale(1, 1, 1);
    entities.push(imm);

    let immediateOk = false;
    try {
      imm.positionImmediate(5, 5, 0);
      imm.clearImmediate();
      immediateOk = true;
    } catch (err) {
      reporter.check(
        'Immediate mode',
        false,
        `immediate mode threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (immediateOk) {
      reporter.check('Immediate mode', true, 'positionImmediate + clearImmediate succeeded');
    }

    // ── 5. EntityHandle.data() ─────────────────────────────────────────
    const dataEnt = engine.spawn().position(2, 0, 0).scale(1, 1, 1);
    entities.push(dataEnt);

    dataEnt.data('key', 42);
    const readBack = dataEnt.data('key');
    reporter.check(
      'EntityHandle.data()',
      readBack === 42,
      `wrote 42, read back ${String(readBack)}`,
    );

    // ── 6. Prefab lifecycle ────────────────────────────────────────────
    let prefabOk = false;
    try {
      engine.prefabs.register('demo-test', {
        root: { position: [5, -2, 0], scale: [1.5, 1.5, 1] },
        children: {
          left: { position: [-1.5, 0, 0], scale: [0.5, 0.5, 1] },
          right: { position: [1.5, 0, 0], scale: [0.5, 0.5, 1] },
        },
      });

      const instance = engine.prefabs.spawn('demo-test', { x: 5, y: -2 });
      const hasChildren = instance.childNames.length === 2;
      const hasLeft = instance.child('left') !== undefined;
      const hasRight = instance.child('right') !== undefined;

      instance.moveTo(10, -4);
      instance.destroyAll();
      engine.prefabs.unregister('demo-test');

      prefabOk = hasChildren && hasLeft && hasRight;
    } catch (err) {
      reporter.check(
        'Prefab lifecycle',
        false,
        `prefab lifecycle threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (prefabOk) {
      reporter.check(
        'Prefab lifecycle',
        true,
        'register -> spawn -> moveTo -> destroyAll -> unregister succeeded',
      );
    }
  },

  teardown(engine: Hyperion) {
    for (const e of entities) {
      if (e.alive) e.destroy();
    }
    entities.length = 0;
    try { engine.prefabs.unregister('demo-test'); } catch { /* may not exist */ }
  },
};

export default section;
