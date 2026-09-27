// ts/src/demo/rendering-fx.ts — Demo section: bloom, outlines, tonemap, and resize
//
// The effect checks read the displayed image (engine.debug.probe on the
// swapchain, 0-1 values) after the graph carrying the effect has gone live:
// an effect request only says a graph was asked for, and the GPU may reject it.
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';
import { pixelCheck, fmt, frames } from './probe-checks';

const entities: EntityHandle[] = [];

/** 4x4 grid of 1x1 white quads, 3 apart: centres at -4.5, -1.5, 1.5, 4.5. */
const at = (row: number, col: number): [number, number] => [(col - 1.5) * 3, (row - 1.5) * 3];

const section: DemoSection = {
  name: 'rendering-fx',
  label: 'Rendering FX (Bloom / Outlines / Tonemap / Resize)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    engine.batch(() => {
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
          entities.push(engine.spawn().position(...at(row, col), 0).scale(1, 1, 1));
        }
      }
    });
    engine.cam.position(0, 0, 0);
    engine.cam.zoom(1);
    await frames(4);

    const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
    const worldPerPx = () => 2 / engine.cam.viewProjection[5] / (canvas?.height ?? 1);
    // Just outside the right edge of the quad at `at(0, 0)`.
    const [qx, qy] = at(0, 0);
    const outside = (px: number): [number, number] => [qx + 0.5 + px * worldPerPx(), qy];

    // ── 1. Bloom: a glow outside a white quad, where there was none ─────
    try {
      await pixelCheck(reporter, 'Bloom', engine, async (probe) => {
        const [before] = await probe('swapchain', [outside(6)]);
        engine.enableBloom({ threshold: 0.8, intensity: 0.5 });
        await frames(8); // the bloom graph goes live once the GPU validated it
        const [after, centre] = await probe('swapchain', [outside(6), [qx, qy]]);
        engine.disableBloom();
        await frames(4);
        return {
          ok: after[0] > before[0] + 0.01 && centre[0] > 0.9,
          detail: `6 px outside a white quad: ${fmt([before[0]])} without bloom, ${fmt([after[0]])} with it`,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('no renderer')) reporter.skip('Bloom', 'no renderer available');
      else reporter.check('Bloom', false, `threw: ${msg}`);
    }

    // ── 2. Outline: around the selected quad, and only there ────────────
    try {
      const selected = entities[0];
      engine.selection?.select(selected.id);
      engine.enableOutlines({ color: [1, 0.5, 0, 1], width: 3 });
      await frames(8);
      await pixelCheck(reporter, 'Outline', engine, async (probe) => {
        // 1.5 px outside the selected quad's edge, and the same offset from
        // an unselected neighbour. The mask is indexed by GPU slot: indexed
        // by entity id it outlined whatever sat in that slot, or nothing.
        const [x1] = at(0, 1);
        const px = 1.5 * worldPerPx();
        const [ring, neighbour] = await probe('swapchain', [[qx + 0.5 + px, qy], [x1 + 0.5 + px, qy]]);
        const orange = ring[0] > 0.6 && ring[1] > 0.2 && ring[1] < 0.8 && ring[2] < 0.3;
        return {
          ok: orange && neighbour[0] < 0.2,
          detail: `beside the selected quad (${fmt(ring.slice(0, 3))}), beside an unselected one (${fmt(neighbour.slice(0, 3))})`,
        };
      });
      engine.disableOutlines();
      engine.selection?.clear();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('no renderer')) reporter.skip('Outline', 'no renderer available');
      else reporter.check('Outline', false, `threw: ${msg}`);
    }

    // ── 3. Tonemap: the API is a stub ───────────────────────────────────
    reporter.skip('Tonemap switch', 'enablePostProcessing is a stub: the renderer fixes the tonemap mode');

    // ── 4. Resize: scene-hdr follows the canvas ─────────────────────────
    const origW = canvas?.width ?? 1280;
    const origH = canvas?.height ?? 720;
    try {
      await pixelCheck(reporter, 'Resize', engine, async (probe) => {
        const sizeOf = async () => {
          await probe('scene-hdr', [[0, 0]]);
          return (await engine.debug!.probe({ target: 'scene-hdr', uv: [[0.5, 0.5]] })).targetSize;
        };
        engine.resize(800, 600);
        await frames(3);
        const small = await sizeOf();
        engine.resize(origW, origH);
        await frames(3);
        const restored = await sizeOf();
        const ok = small[0] === 800 && small[1] === 600 && restored[0] === origW && restored[1] === origH;
        return { ok, detail: `scene-hdr ${small.join('x')} after resize(800, 600), ${restored.join('x')} restored` };
      });
    } catch (err) {
      engine.resize(origW, origH);
      reporter.check('Resize', false, `threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Bloom on while the section is displayed, for the eye.
    try {
      engine.enableBloom({ threshold: 0.6, intensity: 0.4 });
    } catch {
      // No renderer — fine
    }
  },

  teardown(engine: Hyperion) {
    try { engine.disableBloom(); } catch { /* may not have renderer */ }
    try { engine.disableOutlines(); } catch { /* may not have renderer */ }
    engine.selection?.clear();
    for (const e of entities) e.destroy();
    entities.length = 0;
  },
};

export default section;
