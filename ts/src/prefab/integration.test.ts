import { describe, it, expect, vi } from 'vitest';
import { Hyperion } from '../hyperion';
import type { EngineBridge } from '../worker-bridge';
import type { Renderer } from '../renderer';
import type { ResolvedConfig } from '../types';
import { ExecutionMode } from '../capabilities';
import { SelectionManager } from '../selection';

function mockBridge(): EngineBridge {
  return {
    mode: ExecutionMode.SingleThread,
    commandBuffer: {
      spawnEntity: vi.fn(() => true),
      despawnEntity: vi.fn(() => true),
      setPosition: vi.fn(() => true),
      setVelocity: vi.fn(() => true),
      setRotation: vi.fn(() => true),
      setScale: vi.fn(() => true),
      setTextureLayer: vi.fn(() => true),
      setMeshHandle: vi.fn(() => true),
      setRenderPrimitive: vi.fn(() => true),
      setParent: vi.fn(() => true),
      setListenerPosition: vi.fn(() => true),
      setPrimParams0: vi.fn(() => true),
      setPrimParams1: vi.fn(() => true),
      writeCommand: vi.fn(() => true),
      flush: vi.fn(),
      pendingCount: 0,
      freeSpace: 1000,
    } as any,
    tick: vi.fn(),
    ready: vi.fn(async () => {}),
    destroy: vi.fn(),
    latestRenderState: null,
  };
}

function mockRenderer(): Renderer {
  return {
    render: vi.fn(),
    textureManager: {
      loadTexture: vi.fn(async () => 0),
      getTierView: vi.fn(),
      getSampler: vi.fn(),
      destroy: vi.fn(),
    } as any,
    selectionManager: new SelectionManager(100_000),
    particleSystem: {
      createEmitter: vi.fn(() => 1),
      destroyEmitter: vi.fn(),
      emitterCount: 0,
      destroy: vi.fn(),
    } as any,
    graph: { addPass: vi.fn(), removePass: vi.fn(), destroy: vi.fn() } as any,
    device: {} as any,
    enableOutlines: vi.fn(),
    disableOutlines: vi.fn(),
    outlinesEnabled: false,
    enableBloom: vi.fn(),
    disableBloom: vi.fn(),
    bloomEnabled: false,
    recompileShader: vi.fn(),
    destroy: vi.fn(),
  };
}

function defaultConfig(): ResolvedConfig {
  return {
    canvas: {} as HTMLCanvasElement,
    maxEntities: 100_000,
    commandBufferSize: 64 * 1024,
    backpressure: 'retry-queue',
    fixedTimestep: 1 / 60,
    preferredMode: 'auto',
    scatterThreshold: 0.3,
  };
}

describe('Prefab facade integration', () => {
  it('engine.prefabs is defined and has register/spawn methods', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(engine.prefabs).toBeDefined();
    expect(typeof engine.prefabs.register).toBe('function');
    expect(typeof engine.prefabs.spawn).toBe('function');
    engine.destroy();
  });

  it('spawns a prefab with children through the facade', () => {
    const bridge = mockBridge();
    const engine = Hyperion.fromParts(defaultConfig(), bridge, mockRenderer());

    engine.prefabs.register('player', {
      root: { position: [10, 20, 0], scale: 2 },
      children: {
        weapon: { position: [1, 0, 0] },
        shield: { position: [-1, 0, 0], scale: [0.5, 0.5, 0.5] },
      },
    });

    const instance = engine.prefabs.spawn('player');
    expect(instance.root.alive).toBe(true);
    expect(instance.child('weapon')?.alive).toBe(true);
    expect(instance.child('shield')?.alive).toBe(true);
    expect(instance.childNames).toEqual(['weapon', 'shield']);

    // 3 entities spawned: root + 2 children
    expect(bridge.commandBuffer.spawnEntity).toHaveBeenCalledTimes(3);

    engine.destroy();
  });

  it('destroyAll despawns all entities', () => {
    const bridge = mockBridge();
    const engine = Hyperion.fromParts(defaultConfig(), bridge, mockRenderer());

    engine.prefabs.register('npc', {
      root: { position: [0, 0, 0] },
      children: {
        hat: { position: [0, 1, 0] },
      },
    });

    const instance = engine.prefabs.spawn('npc');
    instance.destroyAll();

    // 2 despawnEntity calls: child first, then root
    expect(bridge.commandBuffer.despawnEntity).toHaveBeenCalledTimes(2);

    engine.destroy();
  });
});
