import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrefabRegistry } from './registry';
import type { Hyperion } from '../hyperion';
import type { EntityHandle } from '../entity-handle';
import type { BackpressuredProducer } from '../backpressure';
import type { PrefabTemplate } from './types';
import { RenderPrimitiveType } from '../prim-params-schema';

function mockProducer(): BackpressuredProducer {
  return {
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
    setPrimParams0: vi.fn(() => true),
    setPrimParams1: vi.fn(() => true),
    setListenerPosition: vi.fn(() => true),
    writeCommand: vi.fn(() => true),
    flush: vi.fn(),
    pendingCount: 0,
    freeSpace: 1000,
  } as unknown as BackpressuredProducer;
}

let nextId = 0;
const producer = mockProducer();

function mockHandle(): EntityHandle {
  const id = nextId++;
  const dataMap = new Map<string, unknown>();
  const handle = {
    id,
    alive: true,
    _producer: producer,
    position: vi.fn().mockReturnThis(),
    velocity: vi.fn().mockReturnThis(),
    rotation: vi.fn().mockReturnThis(),
    scale: vi.fn().mockReturnThis(),
    texture: vi.fn().mockReturnThis(),
    mesh: vi.fn().mockReturnThis(),
    primitive: vi.fn().mockReturnThis(),
    parent: vi.fn().mockReturnThis(),
    unparent: vi.fn().mockReturnThis(),
    data: vi.fn((key: string, value?: unknown) => {
      if (value !== undefined) {
        dataMap.set(key, value);
        return handle;
      }
      return dataMap.get(key);
    }),
    destroy: vi.fn(),
    init: vi.fn(),
    positionImmediate: vi.fn().mockReturnThis(),
    clearImmediate: vi.fn().mockReturnThis(),
    line: vi.fn().mockReturnThis(),
    gradient: vi.fn().mockReturnThis(),
    boxShadow: vi.fn().mockReturnThis(),
    bezier: vi.fn().mockReturnThis(),
    [Symbol.dispose]: vi.fn(),
  } as unknown as EntityHandle;
  return handle;
}

function mockEngine(): Hyperion {
  return {
    spawn: vi.fn(() => mockHandle()),
  } as unknown as Hyperion;
}

describe('PrefabRegistry', () => {
  beforeEach(() => {
    nextId = 100;
    vi.clearAllMocks();
  });

  it('registers and checks existence', () => {
    const engine = mockEngine();
    const reg = new PrefabRegistry(engine);
    const t: PrefabTemplate = { root: {} };
    reg.register('bullet', t);
    expect(reg.has('bullet')).toBe(true);
    expect(reg.has('missile')).toBe(false);
  });

  it('lists registered names', () => {
    const engine = mockEngine();
    const reg = new PrefabRegistry(engine);
    reg.register('a', { root: {} });
    reg.register('b', { root: {} });
    expect(reg.list()).toEqual(['a', 'b']);
  });

  it('throws on duplicate registration', () => {
    const engine = mockEngine();
    const reg = new PrefabRegistry(engine);
    reg.register('x', { root: {} });
    expect(() => reg.register('x', { root: {} })).toThrow("Prefab 'x' is already registered");
  });

  it('unregisters a template', () => {
    const engine = mockEngine();
    const reg = new PrefabRegistry(engine);
    reg.register('tmp', { root: {} });
    expect(reg.has('tmp')).toBe(true);
    reg.unregister('tmp');
    expect(reg.has('tmp')).toBe(false);
  });

  it('spawns root-only prefab with position and velocity', () => {
    const handles: EntityHandle[] = [];
    const engine = {
      spawn: vi.fn(() => { const h = mockHandle(); handles.push(h); return h; }),
    } as unknown as Hyperion;
    const reg = new PrefabRegistry(engine);
    reg.register('ship', { root: { position: [1, 2, 3], velocity: [4, 5, 6] } });
    const inst = reg.spawn('ship');
    expect(engine.spawn).toHaveBeenCalledTimes(1);
    expect(inst.root).toBe(handles[0]);
    expect(handles[0].position).toHaveBeenCalledWith(1, 2, 3);
    expect(handles[0].velocity).toHaveBeenCalledWith(4, 5, 6);
  });

  it('spawns prefab with children attached to root', () => {
    const handles: EntityHandle[] = [];
    const engine = {
      spawn: vi.fn(() => { const h = mockHandle(); handles.push(h); return h; }),
    } as unknown as Hyperion;
    const reg = new PrefabRegistry(engine);
    reg.register('tank', {
      root: { position: [0, 0, 0] },
      children: { turret: { position: [0, 1, 0] } },
    });
    const inst = reg.spawn('tank');
    // 1 root + 1 child = 2 spawns
    expect(engine.spawn).toHaveBeenCalledTimes(2);
    const rootId = handles[0].id;
    // child was parented to root
    expect(handles[1].parent).toHaveBeenCalledWith(rootId);
    // child is accessible by name
    expect(inst.child('turret')).toBe(handles[1]);
  });

  it('applies spawn overrides to root position', () => {
    const handles: EntityHandle[] = [];
    const engine = {
      spawn: vi.fn(() => { const h = mockHandle(); handles.push(h); return h; }),
    } as unknown as Hyperion;
    const reg = new PrefabRegistry(engine);
    reg.register('dot', { root: { position: [10, 20, 30] } });
    reg.spawn('dot', { x: 99, y: 88, z: 77 });
    // The override position call happens after the template position call
    const positionCalls = (handles[0].position as ReturnType<typeof vi.fn>).mock.calls;
    // Last call should be the override
    const lastCall = positionCalls[positionCalls.length - 1];
    expect(lastCall).toEqual([99, 88, 77]);
  });

  it('spawn override x/y replaces root position x/y, preserves z', () => {
    const handles: EntityHandle[] = [];
    const engine = {
      spawn: vi.fn(() => { const h = mockHandle(); handles.push(h); return h; }),
    } as unknown as Hyperion;
    const reg = new PrefabRegistry(engine);
    reg.register('dot', { root: { position: [10, 20, 30] } });
    reg.spawn('dot', { x: 99, y: 88 });
    const positionCalls = (handles[0].position as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = positionCalls[positionCalls.length - 1];
    // x/y overridden, z preserved from template
    expect(lastCall).toEqual([99, 88, 30]);
  });

  it('applies uniform scale', () => {
    const handles: EntityHandle[] = [];
    const engine = {
      spawn: vi.fn(() => { const h = mockHandle(); handles.push(h); return h; }),
    } as unknown as Hyperion;
    const reg = new PrefabRegistry(engine);
    reg.register('big', { root: { scale: 3 } });
    reg.spawn('big');
    expect(handles[0].scale).toHaveBeenCalledWith(3, 3, 3);
  });

  it('applies 3-component scale', () => {
    const handles: EntityHandle[] = [];
    const engine = {
      spawn: vi.fn(() => { const h = mockHandle(); handles.push(h); return h; }),
    } as unknown as Hyperion;
    const reg = new PrefabRegistry(engine);
    reg.register('wide', { root: { scale: [2, 1, 0.5] } });
    reg.spawn('wide');
    expect(handles[0].scale).toHaveBeenCalledWith(2, 1, 0.5);
  });

  it('applies rotation as z-axis quaternion', () => {
    const handles: EntityHandle[] = [];
    const engine = {
      spawn: vi.fn(() => { const h = mockHandle(); handles.push(h); return h; }),
    } as unknown as Hyperion;
    const reg = new PrefabRegistry(engine);
    const angle = Math.PI / 2;
    reg.register('rotated', { root: { rotation: angle } });
    reg.spawn('rotated');
    const half = angle / 2;
    expect(handles[0].rotation).toHaveBeenCalledWith(0, 0, Math.sin(half), Math.cos(half));
  });

  it('applies texture, mesh, primitive', () => {
    const handles: EntityHandle[] = [];
    const engine = {
      spawn: vi.fn(() => { const h = mockHandle(); handles.push(h); return h; }),
    } as unknown as Hyperion;
    const reg = new PrefabRegistry(engine);
    reg.register('textured', { root: { texture: 42, mesh: 7, primitive: RenderPrimitiveType.Quad } });
    reg.spawn('textured');
    expect(handles[0].texture).toHaveBeenCalledWith(42);
    expect(handles[0].mesh).toHaveBeenCalledWith(7);
    expect(handles[0].primitive).toHaveBeenCalledWith(RenderPrimitiveType.Quad);
  });

  it('applies named primParams via PRIM_PARAMS_SCHEMA', () => {
    const handles: EntityHandle[] = [];
    const engine = {
      spawn: vi.fn(() => { const h = mockHandle(); handles.push(h); return h; }),
    } as unknown as Hyperion;
    const reg = new PrefabRegistry(engine);
    reg.register('shadow', {
      root: {
        primitive: RenderPrimitiveType.BoxShadow,
        primParams: { rectW: 48, rectH: 16, blur: 8, a: 0.5 },
      },
    });
    reg.spawn('shadow');
    expect(handles[0].primitive).toHaveBeenCalledWith(RenderPrimitiveType.BoxShadow);
    // resolvePrimParams for BoxShadow: rectW=0, rectH=1, cornerRadius=2, blur=3, r=4, g=5, b=6, a=7
    // So result should be [48, 16, 0, 8, 0, 0, 0, 0.5]
    expect(producer.setPrimParams0).toHaveBeenCalledWith(handles[0].id, 48, 16, 0, 8);
    expect(producer.setPrimParams1).toHaveBeenCalledWith(handles[0].id, 0, 0, 0, 0.5);
  });

  it('applies data map', () => {
    const handles: EntityHandle[] = [];
    const engine = {
      spawn: vi.fn(() => { const h = mockHandle(); handles.push(h); return h; }),
    } as unknown as Hyperion;
    const reg = new PrefabRegistry(engine);
    reg.register('tagged', { root: { data: { team: 'red', hp: 100 } } });
    reg.spawn('tagged');
    expect(handles[0].data).toHaveBeenCalledWith('team', 'red');
    expect(handles[0].data).toHaveBeenCalledWith('hp', 100);
  });

  it('throws on spawn of unregistered prefab', () => {
    const engine = mockEngine();
    const reg = new PrefabRegistry(engine);
    expect(() => reg.spawn('ghost')).toThrow("Prefab 'ghost' is not registered");
  });
});
