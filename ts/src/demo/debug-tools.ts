// ts/src/demo/debug-tools.ts — Demo section: profiler, bounds visualizer, ECS inspector, debug camera, time-travel recording
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';
import { boundsVisualizerPlugin } from '../debug/bounds-visualizer';
import { debugCameraPlugin } from '../debug/debug-camera';
import { ecsInspectorPlugin } from '../debug/ecs-inspector';

const entities: EntityHandle[] = [];
const pluginNames: string[] = [];

const section: DemoSection = {
  name: 'debug-tools',
  label: 'Debug Tools (Profiler / Inspector / Bounds / Time-Travel)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    // ── Spawn a 4x3 grid so debug tools have something to display ──────
    engine.batch(() => {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 4; col++) {
          const x = (col - 1.5) * 3;
          const y = (row - 1) * 3;
          entities.push(
            engine.spawn().position(x, y, 0).scale(1, 1, 1),
          );
        }
      }
    });

    // ── 1. Profiler overlay ────────────────────────────────────────────
    try {
      engine.enableProfiler({ position: 'bottom-right' });
      reporter.check('Profiler overlay', true, 'enableProfiler succeeded');
    } catch (err) {
      reporter.check(
        'Profiler overlay',
        false,
        `threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 2. Bounds visualizer ───────────────────────────────────────────
    try {
      const plugin = boundsVisualizerPlugin();
      engine.use(plugin);
      pluginNames.push('bounds-visualizer');
      reporter.check('Bounds visualizer', true, 'plugin installed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('no renderer') || msg.includes('renderer')) {
        reporter.skip('Bounds visualizer', 'no renderer available');
      } else {
        reporter.check('Bounds visualizer', false, `threw: ${msg}`);
      }
    }

    // ── 3. ECS Inspector ───────────────────────────────────────────────
    try {
      const plugin = ecsInspectorPlugin({ toggleKey: 'F12' });
      engine.use(plugin);
      pluginNames.push('ecs-inspector');
      reporter.check('ECS Inspector', true, 'plugin installed');
    } catch (err) {
      reporter.check(
        'ECS Inspector',
        false,
        `threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 4. Debug camera ────────────────────────────────────────────────
    try {
      const plugin = debugCameraPlugin({ enableKey: 'F1' });
      engine.use(plugin);
      pluginNames.push('debug-camera');
      reporter.check('Debug camera', true, 'plugin installed');
    } catch (err) {
      reporter.check(
        'Debug camera',
        false,
        `threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 5. Time-travel record ──────────────────────────────────────────
    try {
      engine.debug.startRecording();
      await new Promise(resolve => setTimeout(resolve, 200));
      const tape = engine.debug.stopRecording();
      reporter.check(
        'Time-travel record',
        tape !== null,
        tape
          ? `captured ${tape.entries.length} entries`
          : 'stopRecording returned null (was not recording)',
      );
    } catch (err) {
      reporter.check(
        'Time-travel record',
        false,
        `threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },

  teardown(engine: Hyperion) {
    try { engine.disableProfiler(); } catch { /* already disabled */ }
    for (const name of pluginNames) {
      try { engine.unuse(name); } catch { /* may not exist */ }
    }
    pluginNames.length = 0;
    for (const e of entities) e.destroy();
    entities.length = 0;
  },
};

export default section;
