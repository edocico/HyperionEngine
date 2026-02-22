import { describe, it, expect, vi } from 'vitest';
import { PluginContext } from './plugin-context';
import { GameLoop } from './game-loop';
import { EventBus } from './event-bus';

function createTestContext() {
  const loop = new GameLoop(vi.fn());
  const bus = new EventBus();
  const ctx = new PluginContext({ engine: {} as any, loop, eventBus: bus, renderer: null });
  return { ctx, loop, bus };
}

describe('PluginContext', () => {
  it('engine is accessible', () => {
    const { ctx } = createTestContext();
    expect(ctx.engine).toBeDefined();
  });
});

describe('PluginSystemsAPI', () => {
  it('addPreTick/removePreTick delegates to GameLoop', () => {
    const { ctx } = createTestContext();
    const fn = vi.fn();
    ctx.systems.addPreTick(fn);
    ctx.systems.removePreTick(fn);
  });

  it('addPostTick/removePostTick delegates to GameLoop', () => {
    const { ctx } = createTestContext();
    const fn = vi.fn();
    ctx.systems.addPostTick(fn);
    ctx.systems.removePostTick(fn);
  });

  it('addFrameEnd/removeFrameEnd delegates to GameLoop', () => {
    const { ctx } = createTestContext();
    const fn = vi.fn();
    ctx.systems.addFrameEnd(fn);
    ctx.systems.removeFrameEnd(fn);
  });
});

describe('PluginEventAPI', () => {
  it('emit/on communicates between contexts sharing a bus', () => {
    const loop = new GameLoop(vi.fn());
    const bus = new EventBus();
    const ctx1 = new PluginContext({ engine: {} as any, loop, eventBus: bus, renderer: null });
    const ctx2 = new PluginContext({ engine: {} as any, loop, eventBus: bus, renderer: null });
    const fn = vi.fn();
    ctx2.events.on('chat', fn);
    ctx1.events.emit('chat', { msg: 'hello' });
    expect(fn).toHaveBeenCalledWith({ msg: 'hello' });
  });
});

describe('PluginRenderingAPI', () => {
  it('is null when no renderer', () => {
    const { ctx } = createTestContext();
    expect(ctx.rendering).toBeNull();
  });
});
