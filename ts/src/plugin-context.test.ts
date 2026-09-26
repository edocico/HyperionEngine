import { describe, it, expect, vi } from 'vitest';
import { PluginContext } from './plugin-context';
import { GameLoop } from './game-loop';
import { EventBus } from './event-bus';
import { RenderGraph } from './render/render-graph';
import { LineBatchPass } from './render/passes/debug-line-pass';

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

  it('routes passes through the renderer, not into the graph it will replace', () => {
    // The renderer swaps in a new RenderGraph on every outline/bloom toggle;
    // a pass added to the current graph directly died with it.
    const graph = new RenderGraph();
    const renderer = { graph, device: {} as GPUDevice, addPass: vi.fn(), removePass: vi.fn() };
    const ctx = new PluginContext({
      engine: {} as any, loop: new GameLoop(vi.fn()), eventBus: new EventBus(), renderer: renderer as any,
    });
    const pass = new LineBatchPass('overlay', 8);

    ctx.rendering!.addPass(pass);
    ctx.rendering!.removePass('overlay');

    expect(renderer.addPass).toHaveBeenCalledWith(pass);
    expect(renderer.removePass).toHaveBeenCalledWith('overlay');
    expect(graph.compile()).toEqual([]);
  });
});

describe('PluginGpuAPI', () => {
  it('is null when no renderer', () => {
    const { ctx } = createTestContext();
    expect(ctx.gpu).toBeNull();
  });
});

describe('PluginStorageAPI', () => {
  it('createMap returns a Map', () => {
    const { ctx } = createTestContext();
    const map = ctx.storage.createMap<number>('health');
    expect(map).toBeInstanceOf(Map);
  });

  it('getMap retrieves existing map', () => {
    const { ctx } = createTestContext();
    const m1 = ctx.storage.createMap<string>('names');
    const m2 = ctx.storage.getMap<string>('names');
    expect(m1).toBe(m2);
  });

  it('destroyAll clears all maps', () => {
    const { ctx } = createTestContext();
    const map = ctx.storage.createMap<number>('hp');
    map.set(1, 100);
    ctx.storage.destroyAll();
    expect(ctx.storage.getMap('hp')).toBeUndefined();
  });
});
