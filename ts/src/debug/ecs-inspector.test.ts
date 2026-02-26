import { describe, it, expect, vi } from 'vitest';
import { ecsInspectorPlugin } from './ecs-inspector';

describe('ECS Inspector Plugin', () => {
  it('has correct name and version', () => {
    expect(ecsInspectorPlugin().name).toBe('ecs-inspector');
  });

  it('install returns cleanup function', () => {
    const ctx = mockCtx();
    const cleanup = ecsInspectorPlugin().install(ctx);
    expect(typeof cleanup).toBe('function');
  });

  it('registers postTick hook on install', () => {
    const ctx = mockCtx();
    ecsInspectorPlugin().install(ctx);
    expect(ctx.systems.addPostTick).toHaveBeenCalled();
  });
});

function mockCtx() {
  return {
    engine: {
      input: { onKey: vi.fn(() => () => {}) },
      selection: { select: vi.fn(), deselect: vi.fn(), selectedIds: vi.fn(() => new Set()) },
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
