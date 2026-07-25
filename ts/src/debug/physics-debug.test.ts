// ts/src/debug/physics-debug.test.ts
import { describe, it, expect, vi } from 'vitest';
import { physicsDebugPlugin } from './physics-debug';
import type { PluginContext } from '../plugin-context';

function mockCtx(overrides?: { debug?: unknown }): {
  ctx: PluginContext;
  setDebug: ReturnType<typeof vi.fn>;
  keyHandlers: Map<string, (code: string) => void>;
} {
  const setDebug = vi.fn();
  const keyHandlers = new Map<string, (code: string) => void>();
  const ctx = {
    engine: {
      input: {
        onKey: vi.fn((key: string, fn: (code: string) => void) => {
          keyHandlers.set(key, fn);
          return vi.fn();
        }),
      },
      debug: overrides && 'debug' in overrides
        ? overrides.debug
        : { setPhysicsDebugRender: setDebug },
    },
    systems: {
      addPostTick: vi.fn(),
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
      createBuffer: vi.fn(),
      createTexture: vi.fn(),
      destroyTracked: vi.fn(),
    },
    storage: {
      createMap: vi.fn(() => new Map()),
      getMap: vi.fn(),
      destroyAll: vi.fn(),
    },
  } as unknown as PluginContext;
  return { ctx, setDebug, keyHandlers };
}

describe('physicsDebugPlugin', () => {
  it('returns a valid HyperionPlugin', () => {
    const plugin = physicsDebugPlugin();
    expect(plugin.name).toBe('physics-debug');
    expect(typeof plugin.install).toBe('function');
  });

  it('registers the DebugLinePass on install', () => {
    const { ctx } = mockCtx();
    physicsDebugPlugin().install(ctx);
    expect(ctx.rendering!.addPass).toHaveBeenCalledTimes(1);
    const pass = (ctx.rendering!.addPass as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pass.name).toBe('physics-debug');
  });

  it('starts disabled by default and sends the disable command once', () => {
    const { ctx, setDebug } = mockCtx();
    physicsDebugPlugin().install(ctx);
    expect(setDebug).toHaveBeenCalledWith(false);
  });

  it('startEnabled: true sends the enable command on install', () => {
    const { ctx, setDebug } = mockCtx();
    physicsDebugPlugin({ startEnabled: true }).install(ctx);
    expect(setDebug).toHaveBeenCalledWith(true);
  });

  it('F3 toggles the debug command on and off', () => {
    const { ctx, setDebug, keyHandlers } = mockCtx();
    physicsDebugPlugin().install(ctx);
    setDebug.mockClear();

    keyHandlers.get('F3')!('F3');
    expect(setDebug).toHaveBeenLastCalledWith(true);
    keyHandlers.get('F3')!('F3');
    expect(setDebug).toHaveBeenLastCalledWith(false);
  });

  it('respects a custom toggle key', () => {
    const { ctx, keyHandlers } = mockCtx();
    physicsDebugPlugin({ toggleKey: 'F9' }).install(ctx);
    expect(keyHandlers.has('F9')).toBe(true);
    expect(keyHandlers.has('F3')).toBe(false);
  });

  it('cleanup removes the pass and disables debug rendering', () => {
    const { ctx, setDebug } = mockCtx();
    const cleanup = physicsDebugPlugin({ startEnabled: true }).install(ctx) as () => void;
    setDebug.mockClear();
    cleanup();
    expect(setDebug).toHaveBeenCalledWith(false);
    expect(ctx.rendering!.removePass).toHaveBeenCalledWith('physics-debug');
  });

  it('returns void when no rendering API (headless)', () => {
    const { ctx } = mockCtx();
    (ctx as never as { rendering: null }).rendering = null;
    (ctx as never as { gpu: null }).gpu = null;
    const result = physicsDebugPlugin().install(ctx);
    expect(result).toBeUndefined();
  });

  it('no-ops gracefully when the facade lacks the debug API (prod build)', () => {
    const { ctx } = mockCtx({ debug: null });
    expect(() => physicsDebugPlugin().install(ctx)).not.toThrow();
  });
});
