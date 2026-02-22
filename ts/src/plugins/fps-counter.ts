// fps-counter.ts — Example plugin that emits FPS data via EventBus on each postTick

import type { HyperionPlugin } from '../plugin';
import type { PluginContext } from '../plugin-context';
import type { Hyperion } from '../hyperion';

export function fpsCounterPlugin(): HyperionPlugin {
  return {
    name: 'fps-counter',
    version: '1.0.0',
    install(ctx: PluginContext) {
      const engine = ctx.engine as Hyperion;
      const hook = () => {
        ctx.events.emit('fps-counter:update', { fps: engine.stats.fps });
      };
      ctx.systems.addPostTick(hook);
      return () => ctx.systems.removePostTick(hook);
    },
  };
}
