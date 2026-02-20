import { describe, it, expect, vi } from 'vitest';
import { Hyperion } from './hyperion';
import type { EngineBridge } from './worker-bridge';
import type { Renderer } from './renderer';
import type { ResolvedConfig } from './types';
import { ExecutionMode } from './capabilities';

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
});

describe('Hyperion.create', () => {
  it('is an async static factory', () => {
    expect(typeof Hyperion.create).toBe('function');
  });
});
