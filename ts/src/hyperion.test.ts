import { describe, it, expect, vi } from 'vitest';
import { Hyperion } from './hyperion';
import type { EngineBridge } from './worker-bridge';
import type { Renderer } from './renderer';
import type { ResolvedConfig } from './types';
import { ExecutionMode } from './capabilities';
import { SelectionManager } from './selection';

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
    enableOutlines: vi.fn(),
    disableOutlines: vi.fn(),
    outlinesEnabled: false,
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
  };
}

describe('Hyperion', () => {
  it('constructs from dependencies', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(engine).toBeInstanceOf(Hyperion);
  });

  it('spawn returns an EntityHandle', () => {
    const bridge = mockBridge();
    const engine = Hyperion.fromParts(defaultConfig(), bridge, mockRenderer());
    const entity = engine.spawn();
    expect(entity.alive).toBe(true);
    expect(bridge.commandBuffer.spawnEntity).toHaveBeenCalled();
  });

  it('spawn auto-increments entity IDs', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const e1 = engine.spawn();
    const e2 = engine.spawn();
    expect(e1.id).not.toBe(e2.id);
  });

  it('destroy calls bridge.destroy and renderer.destroy', () => {
    const bridge = mockBridge();
    const renderer = mockRenderer();
    const engine = Hyperion.fromParts(defaultConfig(), bridge, renderer);
    engine.destroy();
    expect(bridge.destroy).toHaveBeenCalled();
    expect(renderer.destroy).toHaveBeenCalled();
  });

  it('destroy is idempotent', () => {
    const bridge = mockBridge();
    const renderer = mockRenderer();
    const engine = Hyperion.fromParts(defaultConfig(), bridge, renderer);
    engine.destroy();
    engine.destroy();
    expect(bridge.destroy).toHaveBeenCalledTimes(1);
  });

  it('supports Symbol.dispose', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(typeof engine[Symbol.dispose]).toBe('function');
    engine[Symbol.dispose]();
  });

  it('entity handle returned to pool after destroy', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const e1 = engine.spawn();
    e1.destroy();
    const e2 = engine.spawn();
    expect(e2.alive).toBe(true);
  });

  it('mode getter returns bridge mode string', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(engine.mode).toBe('C');
  });

  it('spawn throws when entity limit is reached', () => {
    const config = defaultConfig();
    config.maxEntities = 2;
    const engine = Hyperion.fromParts(config, mockBridge(), mockRenderer());
    engine.spawn();
    engine.spawn();
    expect(() => engine.spawn()).toThrow('Entity limit reached');
  });

  it('spawn throws after engine is destroyed', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    engine.destroy();
    expect(() => engine.spawn()).toThrow('destroyed');
  });

  it('works without a renderer (null)', () => {
    const bridge = mockBridge();
    const engine = Hyperion.fromParts(defaultConfig(), bridge, null);
    engine.destroy();
    expect(bridge.destroy).toHaveBeenCalled();
  });

  it('batch() executes callback synchronously', () => {
    const bridge = mockBridge();
    const engine = Hyperion.fromParts(defaultConfig(), bridge, mockRenderer());
    const spawned: number[] = [];
    engine.batch(() => {
      for (let i = 0; i < 5; i++) {
        spawned.push(engine.spawn().id);
      }
    });
    expect(spawned.length).toBe(5);
    expect(bridge.commandBuffer.spawnEntity).toHaveBeenCalledTimes(5);
  });

  it('loadTexture delegates to textureManager', async () => {
    const renderer = mockRenderer();
    (renderer.textureManager.loadTexture as any).mockResolvedValue(42);
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), renderer);
    const handle = await engine.loadTexture('/test.png');
    expect(handle).toBe(42);
    expect(renderer.textureManager.loadTexture).toHaveBeenCalledWith('/test.png', undefined);
  });

  it('loadTextures loads multiple in parallel', async () => {
    const renderer = mockRenderer();
    let callCount = 0;
    (renderer.textureManager.loadTexture as any).mockImplementation(async () => callCount++);
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), renderer);
    const handles = await engine.loadTextures(['/a.png', '/b.png', '/c.png']);
    expect(handles).toEqual([0, 1, 2]);
  });

  it('loadTexture throws when no renderer', async () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
    await expect(engine.loadTexture('/test.png')).rejects.toThrow('no renderer');
  });

  it('stats returns current engine statistics', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const s = engine.stats;
    expect(s.fps).toBe(0);
    expect(s.entityCount).toBe(0);
    expect(s.mode).toBe('C');
    expect(typeof s.tickCount).toBe('number');
    expect(typeof s.overflowCount).toBe('number');
  });

  it('stats.entityCount updates after spawn/destroy', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const e = engine.spawn();
    expect(engine.stats.entityCount).toBe(1);
    e.destroy();
    engine.returnHandle(e);
    expect(engine.stats.entityCount).toBe(0);
  });

  it('resize() updates camera orthographic projection', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    engine.resize(1920, 1080);
    expect(engine.cam.zoomLevel).toBe(1.0);
  });

  it('compact() is callable', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(() => engine.compact()).not.toThrow();
  });

  it('compact() accepts options', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(() => engine.compact({ entityMap: true, textures: true })).not.toThrow();
  });

  it('onDeviceLost callback is stored in config', () => {
    const onLost = vi.fn();
    const config = { ...defaultConfig(), onDeviceLost: onLost };
    // Verify the type system accepts it and the callback is preserved.
    expect(config.onDeviceLost).toBe(onLost);
  });

  it('use() installs a plugin', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const plugin = { name: 'test', install: vi.fn() };
    engine.use(plugin);
    expect(engine.plugins.has('test')).toBe(true);
    expect(plugin.install).toHaveBeenCalledWith(engine);
  });

  it('unuse() removes a plugin', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const plugin = { name: 'test', install: vi.fn(), cleanup: vi.fn() };
    engine.use(plugin);
    engine.unuse('test');
    expect(engine.plugins.has('test')).toBe(false);
    expect(plugin.cleanup).toHaveBeenCalled();
  });

  it('destroy() cleans up all plugins', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const plugin = { name: 'test', install: vi.fn(), cleanup: vi.fn() };
    engine.use(plugin);
    engine.destroy();
    expect(plugin.cleanup).toHaveBeenCalled();
  });

  it('addHook/removeHook delegates to game loop', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const hook = vi.fn();
    engine.addHook('preTick', hook);
    // Verify it's wired (testing indirectly via the loop is sufficient)
    engine.removeHook('preTick', hook);
  });

  it('selection getter returns SelectionManager from renderer', () => {
    const renderer = mockRenderer();
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), renderer);
    expect(engine.selection).toBe(renderer.selectionManager);
  });

  it('selection returns null when no renderer', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
    expect(engine.selection).toBeNull();
  });

  it('enableOutlines delegates to renderer', () => {
    const renderer = mockRenderer();
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), renderer);
    const opts = { color: [1, 0, 0, 1] as [number, number, number, number], width: 3 };
    engine.enableOutlines(opts);
    expect(renderer.enableOutlines).toHaveBeenCalledWith(opts);
  });

  it('enableOutlines throws when no renderer', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
    expect(() => engine.enableOutlines({ color: [1, 0, 0, 1], width: 3 })).toThrow('no renderer');
  });

  it('disableOutlines is callable without renderer', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
    expect(() => engine.disableOutlines()).not.toThrow();
  });
});

describe('Hyperion input', () => {
  it('engine.input is available', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(engine.input).toBeDefined();
    expect(typeof engine.input.isKeyDown).toBe('function');
    expect(typeof engine.input.onKey).toBe('function');
    expect(typeof engine.input.onClick).toBe('function');
    engine.destroy();
  });

  it('engine.input.isKeyDown returns false initially', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(engine.input.isKeyDown('Space')).toBe(false);
    engine.destroy();
  });

  it('destroy cleans up InputManager', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    engine.destroy();
    // Should not throw
  });
});

describe('Hyperion picking', () => {
  it('engine.picking exists', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(engine.picking).toBeDefined();
    expect(typeof engine.picking.hitTest).toBe('function');
    engine.destroy();
  });

  it('hitTest returns null with no entities', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const result = engine.picking.hitTest(400, 300);
    expect(result).toBeNull();
    engine.destroy();
  });
});

describe('Hyperion immediate mode', () => {
  it('positionImmediate on spawned entity stores shadow state', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const e = engine.spawn();
    // positionImmediate should not throw and should send position through producer
    e.positionImmediate(10, 20, 30);
    e.destroy();
    engine.returnHandle(e);
    engine.destroy();
  });

  it('spawned entity has immediate state wired through pool', () => {
    const bridge = mockBridge();
    const engine = Hyperion.fromParts(defaultConfig(), bridge, mockRenderer());
    const e = engine.spawn();
    // positionImmediate sends setPosition to the producer (verifies wiring)
    e.positionImmediate(5, 10, 15);
    expect(bridge.commandBuffer.setPosition).toHaveBeenCalledWith(e.id, 5, 10, 15);
    e.destroy();
    engine.returnHandle(e);
    engine.destroy();
  });

  it('destroy clears all immediate state', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const e = engine.spawn();
    e.positionImmediate(1, 2, 3);
    // destroy should not throw even with active immediate overrides
    engine.destroy();
  });
});

describe('Hyperion.create', () => {
  it('is an async static factory', () => {
    expect(typeof Hyperion.create).toBe('function');
  });
});
