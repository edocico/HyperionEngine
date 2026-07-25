/**
 * Physics debug rendering plugin (Phase 16 Track A).
 *
 * Toggles rapier's debug wireframes (collider shapes, joints, body axes)
 * with a keyboard key (default F3). The heavy lifting happens elsewhere:
 * CommandType 47 flips collection on the WASM side (physics-debug builds
 * only), the bridges ship `GPURenderState.physicsDebugLines` to the
 * renderer, and `DebugLinePass` draws them on top of the scene.
 *
 * Graceful no-op when there is no renderer (headless / Mode A main thread)
 * or when the WASM build lacks the physics-debug feature (the command is
 * silently ignored engine-side and no lines ever arrive).
 */
import type { HyperionPlugin, PluginCleanup } from '../plugin';
import type { PluginContext } from '../plugin-context';
import { DebugLinePass } from '../render/passes/debug-line-pass';

export interface PhysicsDebugOptions {
  /** Keyboard key to toggle visualization. Default: 'F3'. */
  toggleKey?: string;
  /** Start with debug rendering enabled. Default: false. */
  startEnabled?: boolean;
  /** Maximum debug lines per frame. Default: 8192. */
  maxLines?: number;
}

const DEFAULT_OPTIONS: Required<PhysicsDebugOptions> = {
  toggleKey: 'F3',
  startEnabled: false,
  maxLines: 8192,
};

/** Structural view of the Hyperion facade bits this plugin touches. */
interface EngineLike {
  input?: { onKey(key: string, fn: (code: string) => void): () => void };
  debug?: { setPhysicsDebugRender?(enabled: boolean): void } | null;
}

/**
 * Physics debug plugin — F3 toggles collider/joint wireframes.
 * Part of @hyperion-plugin/devtools alongside the F1 debug camera,
 * F2 bounds visualizer, and F12 ECS inspector.
 */
export function physicsDebugPlugin(options?: PhysicsDebugOptions): HyperionPlugin {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return {
    name: 'physics-debug',
    version: '0.1.0',

    install(ctx: PluginContext): PluginCleanup | void {
      // Graceful degrade if no renderer
      if (!ctx.rendering || !ctx.gpu) return;

      const engine = ctx.engine as EngineLike;
      const pass = new DebugLinePass(opts.maxLines);
      let enabled = opts.startEnabled;

      const apply = () => {
        // Toggle WASM-side line collection (CommandType 47, coalescable).
        engine.debug?.setPhysicsDebugRender?.(enabled);
        pass.setEnabled(enabled);
      };

      // Toggle via keyboard
      let unsubKey: (() => void) | undefined;
      if (engine.input?.onKey) {
        unsubKey = engine.input.onKey(opts.toggleKey, () => {
          enabled = !enabled;
          apply();
        });
      }

      ctx.rendering.addPass(pass);
      apply();

      return () => {
        if (enabled) {
          enabled = false;
          engine.debug?.setPhysicsDebugRender?.(false);
        }
        ctx.rendering!.removePass('physics-debug');
        unsubKey?.();
        pass.destroy();
      };
    },
  };
}
