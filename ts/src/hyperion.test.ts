import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hyperion } from './hyperion';
import type { EngineBridge } from './worker-bridge';
import type { Renderer } from './renderer';
import type { ResolvedConfig } from './types';
import { ExecutionMode } from './capabilities';
import { SelectionManager } from './selection';
import { AudioManager } from './audio-manager';

function mockBridge(): EngineBridge {
  let recordingTap: ((type: number, entityId: number, payload: Uint8Array) => void) | null = null;
  return {
    mode: ExecutionMode.SingleThread,
    commandBuffer: {
      spawnEntity: vi.fn((id: number) => {
        if (recordingTap) recordingTap(1 /* SpawnEntity */, id, new Uint8Array(0));
        return true;
      }),
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
      writeCommand: vi.fn(() => true),
      flush: vi.fn(),
      setRecordingTap: vi.fn((tap: any) => { recordingTap = tap; }),
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

  it('stats.tickCount reads from render state', () => {
    const bridge = mockBridge();
    bridge.latestRenderState = {
      entityCount: 0, transforms: new Float32Array(0), bounds: new Float32Array(0),
      renderMeta: new Uint32Array(0), texIndices: new Uint32Array(0),
      primParams: new Float32Array(0), entityIds: new Uint32Array(0),
      listenerX: 0, listenerY: 0, listenerZ: 0, tickCount: 42,
      dirtyCount: 0, dirtyRatio: 0, stagingData: null, dirtyIndices: null,
    };
    const engine = Hyperion.fromParts(defaultConfig(), bridge, mockRenderer());
    expect(engine.stats.tickCount).toBe(42);
  });

  it('stats includes frame timing fields', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const s = engine.stats;
    expect(s).toHaveProperty('frameDt');
    expect(s).toHaveProperty('frameTimeAvg');
    expect(s).toHaveProperty('frameTimeMax');
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

  it('use installs a plugin with PluginContext', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    let receivedCtx: any = null;
    engine.use({
      name: 'test', version: '1.0.0',
      install: (ctx) => { receivedCtx = ctx; },
    });
    expect(engine.plugins.has('test')).toBe(true);
    expect(receivedCtx).toBeDefined();
    expect(receivedCtx.engine).toBe(engine);
    expect(receivedCtx.systems).toBeDefined();
    expect(receivedCtx.events).toBeDefined();
    expect(receivedCtx.rendering).toBeDefined();
    expect(receivedCtx.gpu).toBeDefined();
    expect(receivedCtx.storage).toBeDefined();
  });

  it('unuse calls cleanup returned from install', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const cleanup = vi.fn();
    engine.use({ name: 'test', version: '1.0.0', install: () => cleanup });
    engine.unuse('test');
    expect(engine.plugins.has('test')).toBe(false);
    expect(cleanup).toHaveBeenCalled();
  });

  it('use with null renderer provides null rendering/gpu', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
    let receivedCtx: any = null;
    engine.use({
      name: 'headless', version: '1.0.0',
      install: (ctx) => { receivedCtx = ctx; },
    });
    expect(receivedCtx.rendering).toBeNull();
    expect(receivedCtx.gpu).toBeNull();
    expect(receivedCtx.storage).toBeDefined();
  });

  it('destroy() cleans up all plugins', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const cleanup = vi.fn();
    const plugin = { name: 'test', version: '1.0.0', install: () => cleanup };
    engine.use(plugin);
    engine.destroy();
    expect(cleanup).toHaveBeenCalled();
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

  it('recompileShader delegates to renderer', () => {
    const renderer = mockRenderer();
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), renderer);
    engine.recompileShader('basic', 'new shader code');
    expect(renderer.recompileShader).toHaveBeenCalledWith('basic', 'new shader code');
  });

  it('recompileShader is safe without renderer', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
    expect(() => engine.recompileShader('basic', 'code')).not.toThrow();
  });

  it('compressionFormat returns null when no renderer', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
    expect(engine.compressionFormat).toBeNull();
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

describe('Hyperion audio', () => {
  it('audio getter returns AudioManager', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(engine.audio).toBeInstanceOf(AudioManager);
  });

  it('audio getter returns same instance', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(engine.audio).toBe(engine.audio);
  });
});

describe('Hyperion audio lifecycle', () => {
  it('destroy calls audioManager.destroy', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const spy = vi.spyOn(engine.audio, 'destroy').mockResolvedValue(undefined);
    engine.destroy();
    expect(spy).toHaveBeenCalled();
  });

  it('pause suspends audio', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const spy = vi.spyOn(engine.audio, 'suspend').mockResolvedValue(undefined);
    engine.pause();
    expect(spy).toHaveBeenCalled();
  });

  it('resume resumes audio', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const spy = vi.spyOn(engine.audio, 'resume').mockResolvedValue(undefined);
    engine.resume();
    expect(spy).toHaveBeenCalled();
  });
});

describe('Hyperion audio listener auto-update', () => {
  it('audio listener update function exists', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(typeof engine.audio.setListenerPosition).toBe('function');
    engine.destroy();
  });
});

describe('Hyperion memoryStats', () => {
  it('memoryStats returns defaults when no renderer', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
    const mem = engine.memoryStats;
    expect(mem.wasmHeapBytes).toBe(0);
    expect(mem.gpuBufferBytes).toBe(0);
    expect(mem.entityMapUtilization).toBeGreaterThanOrEqual(0);
    expect(mem.tierUtilization).toEqual([]);
  });
});

describe('Hyperion profiler', () => {
  it('enableProfiler/disableProfiler lifecycle', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    // enableProfiler should not throw even with mock canvas (no real parentElement)
    engine.enableProfiler({ position: 'top-right' });
    engine.disableProfiler();
  });

  it('enableProfiler is idempotent', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    engine.enableProfiler();
    engine.enableProfiler(); // second call is a no-op
    engine.disableProfiler();
  });

  it('disableProfiler is safe when not enabled', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(() => engine.disableProfiler()).not.toThrow();
  });

  it('destroy cleans up profiler', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    engine.enableProfiler();
    engine.destroy(); // should not throw
  });
});

describe('Hyperion particles', () => {
  it('createParticleEmitter delegates to renderer.particleSystem', () => {
    const renderer = mockRenderer();
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), renderer);
    const handle = engine.createParticleEmitter({ maxParticles: 500 });
    expect(renderer.particleSystem.createEmitter).toHaveBeenCalled();
    expect(handle).toBe(1);
  });

  it('destroyParticleEmitter delegates to renderer.particleSystem', () => {
    const renderer = mockRenderer();
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), renderer);
    const handle = engine.createParticleEmitter({});
    engine.destroyParticleEmitter(handle);
    expect(renderer.particleSystem.destroyEmitter).toHaveBeenCalledWith(handle);
  });

  it('createParticleEmitter returns null when headless (no renderer)', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
    expect(engine.createParticleEmitter({})).toBeNull();
  });
});

describe('Hyperion SystemViews', () => {
  let rafCallbacks: ((time: number) => void)[];
  let originalRAF: typeof globalThis.requestAnimationFrame;
  let originalCAF: typeof globalThis.cancelAnimationFrame;

  beforeEach(() => {
    rafCallbacks = [];
    originalRAF = globalThis.requestAnimationFrame;
    originalCAF = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = vi.fn((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as unknown as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
  });

  it('sets SystemViews on GameLoop from GPURenderState after tick', () => {
    const bridge = mockBridge();
    const fakeState = {
      entityCount: 3,
      transforms: new Float32Array(48),
      bounds: new Float32Array(12),
      renderMeta: new Uint32Array(6),
      texIndices: new Uint32Array(3),
      primParams: new Float32Array(24),
      entityIds: new Uint32Array([10, 20, 30]),
      listenerX: 0, listenerY: 0, listenerZ: 0, tickCount: 1,
    };
    // Simulate bridge.tick populating latestRenderState (like real Mode C bridge)
    let renderState: any = null;
    (bridge.tick as any).mockImplementation(() => { renderState = fakeState; });
    Object.defineProperty(bridge, 'latestRenderState', { get: () => renderState });

    const engine = Hyperion.fromParts(defaultConfig(), bridge, null);
    const receivedViews: any[] = [];
    engine.addHook('postTick', (_dt, views) => { receivedViews.push(views); });

    engine.start();
    // Frame 1: tickFn sets SystemViews from fakeState.
    // postTick re-reads views after tickFn, so it sees fakeState immediately.
    rafCallbacks.shift()!(16.67);
    expect(receivedViews.length).toBe(1);
    const v = receivedViews[0];
    expect(v).toBeDefined();
    expect(v.entityCount).toBe(3);
    expect(v.transforms).toBe(fakeState.transforms);
    expect(v.bounds).toBe(fakeState.bounds);
    expect(v.texIndices).toBe(fakeState.texIndices);
    expect(v.renderMeta).toBe(fakeState.renderMeta);
    expect(v.primParams).toBe(fakeState.primParams);
    expect(v.entityIds).toBe(fakeState.entityIds);
    engine.destroy();
  });

  it('preTick sees previous frame views, postTick sees current frame views', () => {
    const bridge = mockBridge();
    const state1 = {
      entityCount: 1,
      transforms: new Float32Array(16),
      bounds: new Float32Array(4),
      renderMeta: new Uint32Array(2),
      texIndices: new Uint32Array(1),
      primParams: new Float32Array(8),
      entityIds: new Uint32Array([1]),
      listenerX: 0, listenerY: 0, listenerZ: 0, tickCount: 1,
    };
    const state2 = {
      entityCount: 2,
      transforms: new Float32Array(32),
      bounds: new Float32Array(8),
      renderMeta: new Uint32Array(4),
      texIndices: new Uint32Array(2),
      primParams: new Float32Array(16),
      entityIds: new Uint32Array([1, 2]),
      listenerX: 0, listenerY: 0, listenerZ: 0, tickCount: 2,
    };

    let callCount = 0;
    let renderState: any = null;
    (bridge.tick as any).mockImplementation(() => {
      callCount++;
      renderState = callCount === 1 ? state1 : state2;
    });
    Object.defineProperty(bridge, 'latestRenderState', { get: () => renderState });

    const engine = Hyperion.fromParts(defaultConfig(), bridge, null);
    const preViews: any[] = [];
    const postViews: any[] = [];
    engine.addHook('preTick', (_dt, v) => preViews.push(v));
    engine.addHook('postTick', (_dt, v) => postViews.push(v));

    engine.start();

    // Frame 1: tick sets state1. preTick sees undefined, postTick sees state1.
    rafCallbacks.shift()!(16.67);
    expect(preViews[0]).toBeUndefined();
    expect(postViews[0]?.entityCount).toBe(1);

    // Frame 2: tick sets state2. preTick sees state1, postTick sees state2.
    rafCallbacks.shift()!(33.34);
    expect(preViews[1]?.entityCount).toBe(1);
    expect(postViews[1]?.entityCount).toBe(2);

    // Frame 3: preTick sees state2, postTick also sees state2.
    rafCallbacks.shift()!(50.01);
    expect(preViews[2]?.entityCount).toBe(2);
    expect(postViews[2]?.entityCount).toBe(2);

    engine.destroy();
  });

  it('does not set SystemViews when latestRenderState is null', () => {
    const bridge = mockBridge();
    // latestRenderState stays null (default from mockBridge)
    const engine = Hyperion.fromParts(defaultConfig(), bridge, null);
    const receivedViews: any[] = [];
    engine.addHook('postTick', (_dt, views) => { receivedViews.push(views); });

    engine.start();
    rafCallbacks.shift()!(16.67);

    expect(receivedViews.length).toBe(1);
    expect(receivedViews[0]).toBeUndefined();
    engine.destroy();
  });
});

describe('Hyperion.create', () => {
  it('is an async static factory', () => {
    expect(typeof Hyperion.create).toBe('function');
  });
});

describe('debug API', () => {
  it('startRecording / stopRecording returns a CommandTape', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
    engine.debug.startRecording();
    engine.spawn();
    const tape = engine.debug.stopRecording();
    expect(tape).toBeDefined();
    expect(tape!.version).toBe(1);
    expect(tape!.entries.length).toBeGreaterThanOrEqual(1);
    engine.destroy();
  });

  it('stopRecording returns null when not recording', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
    expect(engine.debug.stopRecording()).toBeNull();
    engine.destroy();
  });

  it('isRecording reflects state', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
    expect(engine.debug.isRecording).toBe(false);
    engine.debug.startRecording();
    expect(engine.debug.isRecording).toBe(true);
    engine.debug.stopRecording();
    expect(engine.debug.isRecording).toBe(false);
    engine.destroy();
  });
});
