// ts/src/demo/primitives.ts — Demo section: all 6 render primitive types
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';

const entities: EntityHandle[] = [];

const section: DemoSection = {
  name: 'primitives',
  label: 'Primitives (Quad / Line / Gradient / BoxShadow / Bezier)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    // ── 1. Quad grid (5x5) ─────────────────────────────────────────────
    engine.batch(() => {
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
          const x = (col - 2) * 2.5;
          const y = (row - 2) * 2.5;
          const e = engine.spawn()
            .position(x, y, 0)
            .scale(1, 1, 1);
          entities.push(e);
        }
      }
    });
    reporter.check(
      'Quad grid (5x5)',
      entities.length >= 25,
      `spawned ${entities.length} quads`,
    );

    // ── 2. Gradients (3 types) ─────────────────────────────────────────
    const gradientsBefore = entities.length;
    engine.batch(() => {
      // Linear gradient (type=0), angle ~45 deg
      entities.push(
        engine.spawn()
          .position(-15, 4, 0)
          .scale(3, 3, 1)
          .gradient(0, 0.785, [1, 0, 0, 1, 0, 0]),
      );
      // Radial gradient (type=1)
      entities.push(
        engine.spawn()
          .position(-15, 0, 0)
          .scale(3, 3, 1)
          .gradient(1, 0, [0, 1, 0, 1, 0, 1]),
      );
      // Conic gradient (type=2)
      entities.push(
        engine.spawn()
          .position(-15, -4, 0)
          .scale(3, 3, 1)
          .gradient(2, 0, [0, 0, 1, 1, 1, 0]),
      );
    });
    const gradientsSpawned = entities.length - gradientsBefore;
    reporter.check(
      'Gradients (linear/radial/conic)',
      gradientsSpawned === 3,
      `spawned ${gradientsSpawned} gradients`,
    );

    // ── 3. Box shadows (3 variants) ────────────────────────────────────
    const shadowsBefore = entities.length;
    engine.batch(() => {
      // Sharp shadow: no blur, no corner radius
      entities.push(
        engine.spawn()
          .position(-8, 4, 0)
          .scale(3, 3, 1)
          .boxShadow(0.8, 0.8, 0, 0, 0.2, 0.2, 0.2, 0.9),
      );
      // Soft shadow: large blur
      entities.push(
        engine.spawn()
          .position(-8, 0, 0)
          .scale(3, 3, 1)
          .boxShadow(0.7, 0.7, 0, 0.3, 0.1, 0.1, 0.4, 0.8),
      );
      // Rounded shadow: corner radius + moderate blur
      entities.push(
        engine.spawn()
          .position(-8, -4, 0)
          .scale(3, 3, 1)
          .boxShadow(0.6, 0.6, 0.2, 0.15, 0.4, 0.1, 0.1, 0.85),
      );
    });
    const shadowsSpawned = entities.length - shadowsBefore;
    reporter.check(
      'Box shadows (sharp/soft/rounded)',
      shadowsSpawned === 3,
      `spawned ${shadowsSpawned} box shadows`,
    );

    // ── 4. Lines (6 vertical + 4 horizontal) ──────────────────────────
    const linesBefore = entities.length;
    engine.batch(() => {
      // 6 vertical lines spread across x = 10..20
      for (let i = 0; i < 6; i++) {
        const x = 10 + i * 2;
        entities.push(
          engine.spawn()
            .position(x, 0, 0)
            .scale(1, 10, 1)
            .line(0, -1, 0, 1, 2),
        );
      }
      // 4 horizontal lines stacked vertically
      for (let i = 0; i < 4; i++) {
        const y = -3 + i * 2;
        entities.push(
          engine.spawn()
            .position(15, y, 0)
            .scale(10, 1, 1)
            .line(-1, 0, 1, 0, 2),
        );
      }
    });
    const linesSpawned = entities.length - linesBefore;
    reporter.check(
      'Lines (6V + 4H)',
      linesSpawned === 10,
      `spawned ${linesSpawned} lines`,
    );

    // ── 5. Bezier curves (arch, S-curve, wave) ────────────────────────
    const beziersBefore = entities.length;
    engine.batch(() => {
      // Arch: control point at top-center
      entities.push(
        engine.spawn()
          .position(22, 4, 0)
          .scale(4, 4, 1)
          .bezier(0, 0, 0.5, 1, 1, 0, 0.04),
      );
      // S-curve: control point offset to the right
      entities.push(
        engine.spawn()
          .position(22, 0, 0)
          .scale(4, 4, 1)
          .bezier(0, 0, 1, 0.5, 0, 1, 0.04),
      );
      // Wave: control point dips below
      entities.push(
        engine.spawn()
          .position(22, -4, 0)
          .scale(4, 4, 1)
          .bezier(0, 0.5, 0.5, 0, 1, 0.5, 0.04),
      );
    });
    const beziersSpawned = entities.length - beziersBefore;
    reporter.check(
      'Bezier curves (arch/S/wave)',
      beziersSpawned === 3,
      `spawned ${beziersSpawned} bezier curves`,
    );

    // ── 6. MSDF text — skip (no font atlas in demo assets) ────────────
    reporter.skip('MSDF text', 'no font atlas in demo assets');

    // ── Camera: position to show most content ─────────────────────────
    engine.cam.position(3, 0, 0);
    engine.cam.zoom(1);
  },

  teardown(engine: Hyperion) {
    for (const e of entities) e.destroy();
    entities.length = 0;
    engine.cam.position(0, 0, 0);
    engine.cam.zoom(1);
  },
};

export default section;
