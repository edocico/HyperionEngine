import type { HyperionPlugin, PluginCleanup } from '../plugin';
import type { PluginContext } from '../plugin-context';
import type { HookFn } from '../game-loop';
import { LineBatchPass } from '../render/passes/debug-line-pass';

export interface BoundsVisualizerOptions {
  /** Keyboard key to toggle visualization. Default: 'F2'. */
  toggleKey?: string;
  /** Maximum entities to visualize. Default: 1000. */
  maxEntities?: number;
}

const DEFAULT_OPTIONS: Required<BoundsVisualizerOptions> = {
  toggleKey: 'F2',
  maxEntities: 1000,
};

/**
 * Bounds Visualizer RenderPass — draws circle wireframes for bounding spheres.
 *
 * Uses the existing SystemViews bounds data (from GPU SoA buffers) to generate
 * circle vertices on the TS side. Drawing is inherited from LineBatchPass
 * (Phase 16), which closed the Phase 10b stub with a real line-list pipeline.
 */
class BoundsVisualizerPass extends LineBatchPass {
  constructor(maxEntities: number) {
    const VERTS_PER_ENTITY = 32; // 16 segments * 2 endpoints
    super('bounds-visualizer', maxEntities * VERTS_PER_ENTITY);
  }

  /** Generate circle vertices from SystemViews bounds data (TS-side). */
  generateFromBounds(bounds: Float32Array, entityCount: number): void {
    const SEGMENTS = 16;
    const TAU = Math.PI * 2;
    let written = 0;
    const max = Math.min(entityCount, this.maxVerts / 32);

    for (let i = 0; i < max; i++) {
      const base = i * 4;
      const cx = bounds[base];
      const cy = bounds[base + 1];
      const cz = bounds[base + 2];
      const r = bounds[base + 3];

      if (r <= 0) continue;

      for (let seg = 0; seg < SEGMENTS; seg++) {
        const a0 = TAU * seg / SEGMENTS;
        const a1 = TAU * (seg + 1) / SEGMENTS;

        const vi = (written + seg * 2) * 3;
        const ci = (written + seg * 2) * 4;

        this.vertStaging[vi] = cx + r * Math.cos(a0);
        this.vertStaging[vi + 1] = cy + r * Math.sin(a0);
        this.vertStaging[vi + 2] = cz;

        this.vertStaging[vi + 3] = cx + r * Math.cos(a1);
        this.vertStaging[vi + 4] = cy + r * Math.sin(a1);
        this.vertStaging[vi + 5] = cz;

        // Green for all (TS side doesn't know active/inactive)
        this.colorStaging[ci] = 0; this.colorStaging[ci + 1] = 1;
        this.colorStaging[ci + 2] = 0; this.colorStaging[ci + 3] = 0.8;
        this.colorStaging[ci + 4] = 0; this.colorStaging[ci + 5] = 1;
        this.colorStaging[ci + 6] = 0; this.colorStaging[ci + 7] = 0.8;
      }

      written += SEGMENTS * 2;
    }

    this.vertexCount = written;
  }

}

/**
 * Bounds Visualizer plugin — shows bounding sphere wireframes for all entities.
 * Toggle with F2 (configurable). Part of @hyperion-plugin/devtools.
 *
 * Uses SystemViews bounds data (zero-cost, already available) for circle generation.
 * No entity lifecycle management, no pool pressure.
 */
export function boundsVisualizerPlugin(options?: BoundsVisualizerOptions): HyperionPlugin {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return {
    name: 'bounds-visualizer',
    version: '0.1.0',

    install(ctx: PluginContext): PluginCleanup | void {
      // Graceful degrade if no renderer
      if (!ctx.rendering || !ctx.gpu) return;

      const pass = new BoundsVisualizerPass(opts.maxEntities);
      let enabled = true;

      // Toggle via keyboard
      const engine = ctx.engine as { input?: { onKey(key: string, fn: (code: string) => void): () => void } };
      let unsubKey: (() => void) | undefined;
      if (engine.input?.onKey) {
        unsubKey = engine.input.onKey(opts.toggleKey, () => {
          enabled = !enabled;
          pass.setEnabled(enabled);
        });
      }

      // PostTick hook: generate vertices from SystemViews bounds
      // An empty world regenerates too (zero circles): returning early left the
      // last frame's circles drawn over it.
      const hookFn: HookFn = (_dt, views) => {
        if (!enabled || !views) return;
        pass.generateFromBounds(views.bounds, views.entityCount);
      };

      ctx.systems.addPostTick(hookFn);
      ctx.rendering.addPass(pass);

      return () => {
        ctx.systems.removePostTick(hookFn);
        ctx.rendering!.removePass('bounds-visualizer');
        unsubKey?.();
        pass.destroy();
      };
    },
  };
}
