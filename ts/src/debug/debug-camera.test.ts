import { describe, it, expect, vi } from 'vitest';
import { debugCameraPlugin } from './debug-camera';

function mockPluginContext() {
  return {
    engine: {
      input: {
        isKeyDown: vi.fn(() => false),
        onKey: vi.fn(() => () => {}),
        onScroll: vi.fn(() => () => {}),
      },
      cam: { position: vi.fn(), x: 0, y: 0, zoomLevel: 1, zoom: vi.fn() },
    },
    systems: {
      addPreTick: vi.fn(), removePreTick: vi.fn(),
      addPostTick: vi.fn(), removePostTick: vi.fn(),
      addFrameEnd: vi.fn(), removeFrameEnd: vi.fn(),
    },
    events: { on: vi.fn(), off: vi.fn(), once: vi.fn(), emit: vi.fn() },
    rendering: null, gpu: null,
    storage: { createMap: vi.fn(), getMap: vi.fn(), destroyAll: vi.fn() },
  } as any;
}

describe('debugCameraPlugin', () => {
  it('has correct name and version', () => {
    const plugin = debugCameraPlugin();
    expect(plugin.name).toBe('debug-camera');
    expect(plugin.version).toBeDefined();
  });

  it('registers a preTick hook on install', () => {
    const ctx = mockPluginContext();
    debugCameraPlugin().install(ctx);
    expect(ctx.systems.addPreTick).toHaveBeenCalled();
  });

  it('returns cleanup function that removes hooks', () => {
    const ctx = mockPluginContext();
    const cleanup = debugCameraPlugin().install(ctx);
    expect(typeof cleanup).toBe('function');
    cleanup!();
    expect(ctx.systems.removePreTick).toHaveBeenCalled();
  });
});
