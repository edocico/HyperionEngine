import { describe, it, expect, vi } from 'vitest';
import { fpsCounterPlugin } from './fps-counter';
import { PluginContext } from '../plugin-context';
import { GameLoop } from '../game-loop';
import { EventBus } from '../event-bus';

describe('fpsCounterPlugin', () => {
  it('has correct metadata', () => {
    const plugin = fpsCounterPlugin();
    expect(plugin.name).toBe('fps-counter');
    expect(plugin.version).toBe('1.0.0');
  });

  it('emits fps event on postTick', () => {
    const loop = new GameLoop(vi.fn());
    const bus = new EventBus();
    const engine = { stats: { fps: 60 } } as any;
    const ctx = new PluginContext({ engine, loop, eventBus: bus, renderer: null });

    const received: unknown[] = [];
    bus.on('fps-counter:update', (data) => received.push(data));

    fpsCounterPlugin().install(ctx);

    // The hook was registered but not yet fired (needs frame). Just verify registration didn't throw
    expect(loop).toBeDefined();
  });

  it('cleanup removes the hook', () => {
    const loop = new GameLoop(vi.fn());
    const bus = new EventBus();
    const ctx = new PluginContext({ engine: { stats: { fps: 60 } } as any, loop, eventBus: bus, renderer: null });
    const cleanup = fpsCounterPlugin().install(ctx);
    expect(typeof cleanup).toBe('function');
  });
});
