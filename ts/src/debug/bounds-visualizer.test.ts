// ts/src/debug/bounds-visualizer.test.ts
import { describe, it, expect, vi } from 'vitest';
import { boundsVisualizerPlugin } from './bounds-visualizer';
import type { PluginContext } from '../plugin-context';

function mockCtx(): PluginContext {
  const hooks: Array<{ phase: string; fn: Function }> = [];
  return {
    engine: {
      input: { onKey: vi.fn(() => vi.fn()) },
    },
    systems: {
      addPostTick: vi.fn((fn) => hooks.push({ phase: 'postTick', fn })),
      removePostTick: vi.fn(),
      addPreTick: vi.fn(),
      removePreTick: vi.fn(),
      addFrameEnd: vi.fn(),
      removeFrameEnd: vi.fn(),
    },
    events: { on: vi.fn(), off: vi.fn(), once: vi.fn(), emit: vi.fn() },
    rendering: {
      addPass: vi.fn(),
      removePass: vi.fn(),
    },
    gpu: {
      device: {} as GPUDevice,
      createBuffer: vi.fn(() => ({ destroy: vi.fn(), size: 0, mapState: 'unmapped' })),
      createTexture: vi.fn(),
      destroyTracked: vi.fn(),
    },
    storage: {
      createMap: vi.fn(() => new Map()),
      getMap: vi.fn(),
      destroyAll: vi.fn(),
    },
  } as unknown as PluginContext;
}

describe('boundsVisualizerPlugin', () => {
  it('returns a valid HyperionPlugin', () => {
    const plugin = boundsVisualizerPlugin();
    expect(plugin.name).toBe('bounds-visualizer');
    expect(typeof plugin.install).toBe('function');
  });

  it('accepts custom options', () => {
    const plugin = boundsVisualizerPlugin({ toggleKey: 'F3', maxEntities: 500 });
    expect(plugin.name).toBe('bounds-visualizer');
  });

  it('registers a postTick hook on install', () => {
    const ctx = mockCtx();
    const plugin = boundsVisualizerPlugin();
    plugin.install(ctx);
    expect(ctx.systems.addPostTick).toHaveBeenCalled();
  });

  it('registers a render pass on install', () => {
    const ctx = mockCtx();
    const plugin = boundsVisualizerPlugin();
    plugin.install(ctx);
    expect(ctx.rendering!.addPass).toHaveBeenCalled();
  });

  it('cleanup removes hook and pass', () => {
    const ctx = mockCtx();
    const plugin = boundsVisualizerPlugin();
    const cleanup = plugin.install(ctx) as () => void;
    expect(typeof cleanup).toBe('function');
    cleanup();
    expect(ctx.systems.removePostTick).toHaveBeenCalled();
    expect(ctx.rendering!.removePass).toHaveBeenCalledWith('bounds-visualizer');
  });

  it('returns void when no rendering API (headless)', () => {
    const ctx = mockCtx();
    (ctx as any).rendering = null;
    (ctx as any).gpu = null;
    const plugin = boundsVisualizerPlugin();
    const result = plugin.install(ctx);
    // Should gracefully degrade — no pass registered
    expect(result).toBeUndefined();
  });
});
