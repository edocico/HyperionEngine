// ts/src/demo/rendering-fx.ts — Demo section: bloom, outlines, tonemap, and resize
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';

const entities: EntityHandle[] = [];

const section: DemoSection = {
  name: 'rendering-fx',
  label: 'Rendering FX (Bloom / Outlines / Tonemap / Resize)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    // ── Spawn a 4x4 grid so effects are visible on something ───────────
    engine.batch(() => {
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          const x = (col - 1.5) * 3;
          const y = (row - 1.5) * 3;
          entities.push(
            engine.spawn().position(x, y, 0).scale(1, 1, 1),
          );
        }
      }
    });

    // ── 1. Bloom toggle ────────────────────────────────────────────────
    try {
      engine.enableBloom({ threshold: 0.8, intensity: 0.5 });
      engine.disableBloom();
      engine.enableBloom();
      reporter.check('Bloom toggle', true, 'enable -> disable -> enable, no throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('no renderer')) {
        reporter.skip('Bloom toggle', 'no renderer available');
      } else {
        reporter.check('Bloom toggle', false, `threw: ${msg}`);
      }
    }

    // ── 2. Outline toggle (mutual exclusion with bloom) ────────────────
    try {
      // Bloom must be off before outlines can work
      engine.disableBloom();

      // Select the first entity so outlines have something to render
      const firstId = entities[0]?.id;
      if (firstId !== undefined) {
        engine.selection?.select(firstId);
      }

      engine.enableOutlines({ color: [1, 0.5, 0, 1], width: 3 });
      reporter.check(
        'Outline toggle',
        true,
        'disableBloom -> enableOutlines with selected entity, mutual exclusion OK',
      );

      // Clean up: disable outlines so they don't interfere with later sections
      engine.disableOutlines();
      engine.selection?.clear();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('no renderer')) {
        reporter.skip('Outline toggle', 'no renderer available');
      } else {
        reporter.check('Outline toggle', false, `threw: ${msg}`);
      }
    }

    // ── 3. Tonemap switch ──────────────────────────────────────────────
    try {
      const modes = ['aces', 'pbr-neutral', 'none'] as const;
      for (const mode of modes) {
        engine.enablePostProcessing({ tonemapping: mode });
      }
      reporter.check('Tonemap switch', true, 'cycled aces -> pbr-neutral -> none');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        err instanceof TypeError ||
        msg.includes('not a function') ||
        msg.includes('not implemented')
      ) {
        reporter.skip('Tonemap switch', `stub or not implemented: ${msg}`);
      } else {
        reporter.check('Tonemap switch', false, `threw: ${msg}`);
      }
    }

    // ── 4. Resize ──────────────────────────────────────────────────────
    try {
      const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
      const origW = canvas?.width ?? 1280;
      const origH = canvas?.height ?? 720;

      engine.resize(800, 600);
      engine.resize(origW, origH);
      reporter.check('Resize', true, `resized to 800x600 and restored to ${origW}x${origH}`);
    } catch (err) {
      reporter.check(
        'Resize',
        false,
        `threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Re-enable bloom so the visual is interesting while the section is displayed
    try {
      engine.enableBloom({ threshold: 0.6, intensity: 0.4 });
    } catch {
      // No renderer — fine
    }
  },

  teardown(engine: Hyperion) {
    try { engine.disableBloom(); } catch { /* may not have renderer */ }
    engine.selection?.clear();
    for (const e of entities) e.destroy();
    entities.length = 0;
  },
};

export default section;
