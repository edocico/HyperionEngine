import type { HyperionPlugin, PluginCleanup } from '../plugin';
import type { PluginContext } from '../plugin-context';
import type { HookFn } from '../game-loop';

export interface DebugCameraOptions {
  moveSpeed?: number;
  zoomSpeed?: number;
  enableKey?: string;
}

export function debugCameraPlugin(options?: DebugCameraOptions): HyperionPlugin {
  const moveSpeed = options?.moveSpeed ?? 300;
  const zoomSpeed = options?.zoomSpeed ?? 0.1;
  const enableKey = options?.enableKey ?? 'F1';

  return {
    name: 'debug-camera',
    version: '1.0.0',

    install(ctx: PluginContext): PluginCleanup {
      const engine = ctx.engine as {
        input: {
          isKeyDown(code: string): boolean;
          onKey(code: string, fn: (code: string) => void): () => void;
          onScroll(fn: (dx: number, dy: number) => void): () => void;
        };
        cam: {
          position(x: number, y: number, z: number): void;
          x: number; y: number; zoomLevel: number;
          zoom(level: number): void;
        };
      };

      let enabled = true;
      let camX = engine.cam.x;
      let camY = engine.cam.y;

      const unsubKey = engine.input.onKey(enableKey, () => { enabled = !enabled; });
      const unsubScroll = engine.input.onScroll((_dx, dy) => {
        if (!enabled) return;
        engine.cam.zoom(engine.cam.zoomLevel * (1 - dy * zoomSpeed));
      });

      const hook: HookFn = (dt) => {
        if (!enabled) return;
        let dx = 0, dy = 0;
        if (engine.input.isKeyDown('KeyW') || engine.input.isKeyDown('ArrowUp'))    dy += moveSpeed * dt;
        if (engine.input.isKeyDown('KeyS') || engine.input.isKeyDown('ArrowDown'))  dy -= moveSpeed * dt;
        if (engine.input.isKeyDown('KeyA') || engine.input.isKeyDown('ArrowLeft'))  dx -= moveSpeed * dt;
        if (engine.input.isKeyDown('KeyD') || engine.input.isKeyDown('ArrowRight')) dx += moveSpeed * dt;
        if (dx !== 0 || dy !== 0) {
          camX += dx;
          camY += dy;
          engine.cam.position(camX, camY, 0);
        }
      };

      ctx.systems.addPreTick(hook);

      return () => {
        ctx.systems.removePreTick(hook);
        unsubKey();
        unsubScroll();
      };
    },
  };
}
