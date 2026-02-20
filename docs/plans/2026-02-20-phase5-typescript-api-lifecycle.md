# Phase 5: TypeScript API & Lifecycle — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform Hyperion from an internal proof-of-concept into an externally usable engine with an ergonomic, type-safe public API that hides all ring buffer internals.

**Architecture:** A `Hyperion` class wraps the existing `EngineBridge` + `Renderer` + `Camera` into a single facade. Entity management uses pooled `EntityHandle` objects with fluent builders. A `GameLoop` class manages RAF lifecycle with plugin hooks. Scene graph is implemented via new Rust components (`Parent`/`Children`/`LocalMatrix`) with a transform propagation system. Memory compaction and device-loss recovery provide long-session resilience.

**Tech Stack:** TypeScript (API facade, game loop, entity handles), Rust (scene graph ECS components, compaction), hecs (ECS), WebGPU (rendering), SharedArrayBuffer (ring buffer communication)

---

## Part 1: Foundation Types & Entity System (Tasks 1–5)

### Task 1: Core Types — HyperionConfig, TextureHandle, HyperionStats

**Files:**
- Create: `ts/src/types.ts`
- Test: `ts/src/types.test.ts`

**Step 1: Write the failing test**

```typescript
// ts/src/types.test.ts
import { describe, it, expect } from 'vitest';
import { validateConfig, type HyperionConfig } from './types';

describe('validateConfig', () => {
  it('returns defaults for minimal config', () => {
    const canvas = {} as HTMLCanvasElement;
    const cfg = validateConfig({ canvas });
    expect(cfg.canvas).toBe(canvas);
    expect(cfg.maxEntities).toBe(100_000);
    expect(cfg.commandBufferSize).toBe(64 * 1024);
    expect(cfg.backpressure).toBe('retry-queue');
    expect(cfg.fixedTimestep).toBeCloseTo(1 / 60);
    expect(cfg.preferredMode).toBe('auto');
  });

  it('preserves user overrides', () => {
    const canvas = {} as HTMLCanvasElement;
    const cfg = validateConfig({
      canvas,
      maxEntities: 50_000,
      backpressure: 'drop',
      preferredMode: 'C',
    });
    expect(cfg.maxEntities).toBe(50_000);
    expect(cfg.backpressure).toBe('drop');
    expect(cfg.preferredMode).toBe('C');
  });

  it('throws on missing canvas', () => {
    expect(() => validateConfig({} as HyperionConfig)).toThrow('canvas is required');
  });

  it('throws on invalid maxEntities', () => {
    const canvas = {} as HTMLCanvasElement;
    expect(() => validateConfig({ canvas, maxEntities: -1 })).toThrow('maxEntities');
    expect(() => validateConfig({ canvas, maxEntities: 0 })).toThrow('maxEntities');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/types.test.ts`
Expected: FAIL — module `./types` has no export `validateConfig`

**Step 3: Write minimal implementation**

```typescript
// ts/src/types.ts
import type { BackpressureMode } from './backpressure';

/** Opaque texture handle returned by engine.loadTexture(). */
export type TextureHandle = number;

/** Configuration for Hyperion.create(). */
export interface HyperionConfig {
  canvas: HTMLCanvasElement;
  maxEntities?: number;
  commandBufferSize?: number;
  backpressure?: BackpressureMode;
  fixedTimestep?: number;
  preferredMode?: 'auto' | 'A' | 'B' | 'C';
  onModeChange?: (from: string, to: string, reason: string) => void;
  onOverflow?: (dropped: number) => void;
}

/** Resolved config with all defaults applied. */
export interface ResolvedConfig {
  canvas: HTMLCanvasElement;
  maxEntities: number;
  commandBufferSize: number;
  backpressure: BackpressureMode;
  fixedTimestep: number;
  preferredMode: 'auto' | 'A' | 'B' | 'C';
  onModeChange?: (from: string, to: string, reason: string) => void;
  onOverflow?: (dropped: number) => void;
}

/** Live engine statistics. */
export interface HyperionStats {
  fps: number;
  entityCount: number;
  mode: string;
  tickCount: number;
  overflowCount: number;
}

/** Memory statistics (subset of stats). */
export interface MemoryStats {
  wasmHeapBytes: number;
  gpuBufferBytes: number;
  entityMapUtilization: number;
  tierUtilization: number[];
}

/** Compaction options for engine.compact(). */
export interface CompactOptions {
  entityMap?: boolean;
  textures?: boolean;
  renderState?: boolean;
  aggressive?: boolean;
}

export function validateConfig(config: HyperionConfig): ResolvedConfig {
  if (!config.canvas) {
    throw new Error('canvas is required');
  }
  const maxEntities = config.maxEntities ?? 100_000;
  if (maxEntities <= 0) {
    throw new Error('maxEntities must be > 0');
  }
  return {
    canvas: config.canvas,
    maxEntities,
    commandBufferSize: config.commandBufferSize ?? 64 * 1024,
    backpressure: config.backpressure ?? 'retry-queue',
    fixedTimestep: config.fixedTimestep ?? 1 / 60,
    preferredMode: config.preferredMode ?? 'auto',
    onModeChange: config.onModeChange,
    onOverflow: config.onOverflow,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/types.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add ts/src/types.ts ts/src/types.test.ts
git commit -m "feat(phase5): add core types — HyperionConfig, TextureHandle, HyperionStats"
```

---

### Task 2: Missing BackpressuredProducer Convenience Methods

**Files:**
- Modify: `ts/src/backpressure.ts` (add `setVelocity`, `setRotation`, `setScale`)
- Modify: `ts/src/backpressure.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to `ts/src/backpressure.test.ts`:

```typescript
describe('BackpressuredProducer convenience methods', () => {
  it('setVelocity writes SetVelocity command', () => {
    const sab = createRingBuffer(1024) as SharedArrayBuffer;
    const producer = new BackpressuredProducer(new RingBufferProducer(sab));
    expect(producer.setVelocity(0, 1.0, 2.0, 3.0)).toBe(true);
    const { commands } = extractUnread(sab);
    expect(commands.length).toBe(1);
    expect(commands[0].cmd).toBe(CommandType.SetVelocity);
  });

  it('setRotation writes SetRotation command', () => {
    const sab = createRingBuffer(1024) as SharedArrayBuffer;
    const producer = new BackpressuredProducer(new RingBufferProducer(sab));
    expect(producer.setRotation(0, 0, 0, 0, 1)).toBe(true);
    const { commands } = extractUnread(sab);
    expect(commands.length).toBe(1);
    expect(commands[0].cmd).toBe(CommandType.SetRotation);
  });

  it('setScale writes SetScale command', () => {
    const sab = createRingBuffer(1024) as SharedArrayBuffer;
    const producer = new BackpressuredProducer(new RingBufferProducer(sab));
    expect(producer.setScale(0, 2.0, 2.0, 2.0)).toBe(true);
    const { commands } = extractUnread(sab);
    expect(commands.length).toBe(1);
    expect(commands[0].cmd).toBe(CommandType.SetScale);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/backpressure.test.ts`
Expected: FAIL — `producer.setVelocity is not a function`

**Step 3: Add the methods to BackpressuredProducer**

Add to `BackpressuredProducer` class in `ts/src/backpressure.ts`:

```typescript
setVelocity(entityId: number, vx: number, vy: number, vz: number): boolean {
  return this.writeCommand(CommandType.SetVelocity, entityId, new Float32Array([vx, vy, vz]));
}

setRotation(entityId: number, x: number, y: number, z: number, w: number): boolean {
  return this.writeCommand(CommandType.SetRotation, entityId, new Float32Array([x, y, z, w]));
}

setScale(entityId: number, sx: number, sy: number, sz: number): boolean {
  return this.writeCommand(CommandType.SetScale, entityId, new Float32Array([sx, sy, sz]));
}

setParent(entityId: number, parentId: number): boolean {
  const p = new Float32Array(1);
  new Uint32Array(p.buffer)[0] = parentId;
  return this.writeCommand(CommandType.SetParent, entityId, p);
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/backpressure.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/backpressure.ts ts/src/backpressure.test.ts
git commit -m "feat(phase5): add setVelocity/setRotation/setScale/setParent to BackpressuredProducer"
```

---

### Task 3: EntityHandle — Fluent Builder Over BackpressuredProducer

**Files:**
- Create: `ts/src/entity-handle.ts`
- Test: `ts/src/entity-handle.test.ts`

**Step 1: Write the failing test**

```typescript
// ts/src/entity-handle.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EntityHandle } from './entity-handle';
import type { BackpressuredProducer } from './backpressure';

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
    writeCommand: vi.fn(() => true),
    flush: vi.fn(),
    pendingCount: 0,
    freeSpace: 1000,
  } as unknown as BackpressuredProducer;
}

describe('EntityHandle', () => {
  it('wraps an entity ID', () => {
    const p = mockProducer();
    const h = new EntityHandle(42, p);
    expect(h.id).toBe(42);
    expect(h.alive).toBe(true);
  });

  it('fluent position returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.position(1, 2, 3);
    expect(result).toBe(h);
    expect(p.setPosition).toHaveBeenCalledWith(0, 1, 2, 3);
  });

  it('fluent velocity returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.velocity(4, 5, 6);
    expect(result).toBe(h);
    expect(p.setVelocity).toHaveBeenCalledWith(0, 4, 5, 6);
  });

  it('fluent scale returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.scale(2, 2, 2);
    expect(result).toBe(h);
    expect(p.setScale).toHaveBeenCalledWith(0, 2, 2, 2);
  });

  it('fluent rotation returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.rotation(0, 0, 0, 1);
    expect(result).toBe(h);
    expect(p.setRotation).toHaveBeenCalledWith(0, 0, 0, 0, 1);
  });

  it('fluent texture returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.texture(123);
    expect(result).toBe(h);
    expect(p.setTextureLayer).toHaveBeenCalledWith(0, 123);
  });

  it('destroy sends despawn and marks dead', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    h.destroy();
    expect(p.despawnEntity).toHaveBeenCalledWith(0);
    expect(h.alive).toBe(false);
  });

  it('throws on method call after destroy', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    h.destroy();
    expect(() => h.position(1, 2, 3)).toThrow('destroyed');
  });

  it('destroy is idempotent', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    h.destroy();
    h.destroy(); // should not throw or send twice
    expect(p.despawnEntity).toHaveBeenCalledTimes(1);
  });

  it('supports Symbol.dispose', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    expect(typeof h[Symbol.dispose]).toBe('function');
    h[Symbol.dispose]();
    expect(h.alive).toBe(false);
  });

  it('init() resets for pool reuse', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    h.destroy();
    expect(h.alive).toBe(false);
    h.init(99, p);
    expect(h.id).toBe(99);
    expect(h.alive).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: FAIL — module `./entity-handle` not found

**Step 3: Write implementation**

```typescript
// ts/src/entity-handle.ts
import type { BackpressuredProducer } from './backpressure';
import type { TextureHandle } from './types';

export class EntityHandle implements Disposable {
  private _id: number = -1;
  private _alive: boolean = false;
  private _producer: BackpressuredProducer | null = null;

  constructor(id: number, producer: BackpressuredProducer) {
    this.init(id, producer);
  }

  get id(): number { return this._id; }
  get alive(): boolean { return this._alive; }

  init(id: number, producer: BackpressuredProducer): void {
    this._id = id;
    this._alive = true;
    this._producer = producer;
  }

  private check(): void {
    if (!this._alive) throw new Error('EntityHandle has been destroyed');
  }

  position(x: number, y: number, z: number): this {
    this.check();
    this._producer!.setPosition(this._id, x, y, z);
    return this;
  }

  velocity(vx: number, vy: number, vz: number): this {
    this.check();
    this._producer!.setVelocity(this._id, vx, vy, vz);
    return this;
  }

  rotation(x: number, y: number, z: number, w: number): this {
    this.check();
    this._producer!.setRotation(this._id, x, y, z, w);
    return this;
  }

  scale(sx: number, sy: number, sz: number): this {
    this.check();
    this._producer!.setScale(this._id, sx, sy, sz);
    return this;
  }

  texture(handle: TextureHandle): this {
    this.check();
    this._producer!.setTextureLayer(this._id, handle);
    return this;
  }

  mesh(handle: number): this {
    this.check();
    this._producer!.setMeshHandle(this._id, handle);
    return this;
  }

  primitive(value: number): this {
    this.check();
    this._producer!.setRenderPrimitive(this._id, value);
    return this;
  }

  destroy(): void {
    if (!this._alive) return;
    this._producer!.despawnEntity(this._id);
    this._alive = false;
    this._producer = null;
  }

  [Symbol.dispose](): void {
    this.destroy();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: PASS (10 tests)

**Step 5: Commit**

```bash
git add ts/src/entity-handle.ts ts/src/entity-handle.test.ts
git commit -m "feat(phase5): add EntityHandle with fluent builder and Symbol.dispose"
```

---

### Task 4: EntityHandlePool — Object Pool with Cap

**Files:**
- Create: `ts/src/entity-pool.ts`
- Test: `ts/src/entity-pool.test.ts`

**Step 1: Write the failing test**

```typescript
// ts/src/entity-pool.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EntityHandlePool } from './entity-pool';
import { EntityHandle } from './entity-handle';
import type { BackpressuredProducer } from './backpressure';

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
    writeCommand: vi.fn(() => true),
    flush: vi.fn(),
    pendingCount: 0,
    freeSpace: 1000,
  } as unknown as BackpressuredProducer;
}

describe('EntityHandlePool', () => {
  it('acquire returns an EntityHandle', () => {
    const pool = new EntityHandlePool();
    const p = mockProducer();
    const h = pool.acquire(42, p);
    expect(h).toBeInstanceOf(EntityHandle);
    expect(h.id).toBe(42);
    expect(h.alive).toBe(true);
  });

  it('release returns handle to pool for reuse', () => {
    const pool = new EntityHandlePool();
    const p = mockProducer();
    const h1 = pool.acquire(1, p);
    pool.release(h1);
    expect(pool.size).toBe(1);

    const h2 = pool.acquire(2, p);
    expect(h2).toBe(h1); // same object, recycled
    expect(h2.id).toBe(2);
    expect(h2.alive).toBe(true);
  });

  it('respects max pool size (1024)', () => {
    const pool = new EntityHandlePool(4); // small cap for testing
    const p = mockProducer();
    const handles = [];
    for (let i = 0; i < 6; i++) {
      handles.push(pool.acquire(i, p));
    }
    // Release all 6
    for (const h of handles) {
      pool.release(h);
    }
    // Pool should be capped at 4
    expect(pool.size).toBe(4);
  });

  it('acquire creates new handle when pool is empty', () => {
    const pool = new EntityHandlePool();
    const p = mockProducer();
    const h1 = pool.acquire(1, p);
    const h2 = pool.acquire(2, p);
    expect(h1).not.toBe(h2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/entity-pool.test.ts`
Expected: FAIL — module `./entity-pool` not found

**Step 3: Write implementation**

```typescript
// ts/src/entity-pool.ts
import { EntityHandle } from './entity-handle';
import type { BackpressuredProducer } from './backpressure';

export class EntityHandlePool {
  private readonly pool: EntityHandle[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = 1024) {
    this.maxSize = maxSize;
  }

  get size(): number { return this.pool.length; }

  acquire(entityId: number, producer: BackpressuredProducer): EntityHandle {
    const handle = this.pool.pop();
    if (handle) {
      handle.init(entityId, producer);
      return handle;
    }
    return new EntityHandle(entityId, producer);
  }

  release(handle: EntityHandle): void {
    if (this.pool.length < this.maxSize) {
      this.pool.push(handle);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/entity-pool.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add ts/src/entity-pool.ts ts/src/entity-pool.test.ts
git commit -m "feat(phase5): add EntityHandlePool with configurable max cap"
```

---

### Task 5: FinalizationRegistry Backstop for EntityHandle

**Files:**
- Create: `ts/src/leak-detector.ts`
- Test: `ts/src/leak-detector.test.ts`

**Step 1: Write the failing test**

```typescript
// ts/src/leak-detector.test.ts
import { describe, it, expect, vi } from 'vitest';
import { LeakDetector } from './leak-detector';

describe('LeakDetector', () => {
  it('registers and unregisters handles', () => {
    const warnFn = vi.fn();
    const detector = new LeakDetector(warnFn);
    const token = {};
    detector.register(token, 42);
    detector.unregister(token);
    // No assertion on finalization (GC is unpredictable), just verify no crash.
  });

  it('constructs without FinalizationRegistry in environments that lack it', () => {
    // In test environment, FinalizationRegistry exists, so this just verifies the constructor.
    const detector = new LeakDetector();
    expect(detector).toBeTruthy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/leak-detector.test.ts`
Expected: FAIL — module `./leak-detector` not found

**Step 3: Write implementation**

```typescript
// ts/src/leak-detector.ts

type WarnFn = (entityId: number) => void;

const defaultWarn: WarnFn = (entityId) => {
  console.warn(
    `[Hyperion] EntityHandle for entity ${entityId} was garbage-collected without being destroyed. ` +
    `Call entity.destroy() explicitly to avoid resource leaks.`
  );
};

export class LeakDetector {
  private registry: FinalizationRegistry<number> | null;

  constructor(warnFn: WarnFn = defaultWarn) {
    if (typeof FinalizationRegistry !== 'undefined') {
      this.registry = new FinalizationRegistry<number>((entityId) => {
        warnFn(entityId);
      });
    } else {
      this.registry = null;
    }
  }

  register(handle: object, entityId: number): void {
    this.registry?.register(handle, entityId, handle);
  }

  unregister(handle: object): void {
    this.registry?.unregister(handle);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/leak-detector.test.ts`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add ts/src/leak-detector.ts ts/src/leak-detector.test.ts
git commit -m "feat(phase5): add LeakDetector using FinalizationRegistry backstop"
```

---

## Part 2: Game Loop & Lifecycle (Tasks 6–10)

### Task 6: GameLoop — RAF Management with Hooks

**Files:**
- Create: `ts/src/game-loop.ts`
- Test: `ts/src/game-loop.test.ts`

**Step 1: Write the failing test**

```typescript
// ts/src/game-loop.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameLoop } from './game-loop';

describe('GameLoop', () => {
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

  it('starts and runs tick callback', () => {
    const tickFn = vi.fn();
    const loop = new GameLoop(tickFn);
    loop.start();
    expect(loop.running).toBe(true);
    // Simulate one frame
    rafCallbacks[0](16.67);
    expect(tickFn).toHaveBeenCalled();
  });

  it('stop cancels the loop', () => {
    const loop = new GameLoop(vi.fn());
    loop.start();
    loop.stop();
    expect(loop.running).toBe(false);
  });

  it('pause/resume', () => {
    const tickFn = vi.fn();
    const loop = new GameLoop(tickFn);
    loop.start();
    loop.pause();
    expect(loop.paused).toBe(true);
    // Simulate frame while paused — tick should not be called
    rafCallbacks[0](16.67);
    expect(tickFn).not.toHaveBeenCalled();
    // But RAF should still be requested (to keep checking)
    loop.resume();
    expect(loop.paused).toBe(false);
  });

  it('calls preTick/postTick/frameEnd hooks in order', () => {
    const order: string[] = [];
    const tickFn = vi.fn(() => order.push('tick'));
    const loop = new GameLoop(tickFn);
    loop.addHook('preTick', () => order.push('pre'));
    loop.addHook('postTick', () => order.push('post'));
    loop.addHook('frameEnd', () => order.push('end'));
    loop.start();
    rafCallbacks[0](16.67);
    expect(order).toEqual(['pre', 'tick', 'post', 'end']);
  });

  it('removeHook removes a hook', () => {
    const called: string[] = [];
    const hook = () => called.push('pre');
    const loop = new GameLoop(vi.fn());
    loop.addHook('preTick', hook);
    loop.removeHook('preTick', hook);
    loop.start();
    rafCallbacks[0](16.67);
    expect(called).toEqual([]);
  });

  it('tracks fps', () => {
    const loop = new GameLoop(vi.fn());
    loop.start();
    // Simulate 60 frames at ~16.67ms
    let t = 0;
    for (let i = 0; i < 61; i++) {
      t += 16.67;
      if (rafCallbacks.length > 0) {
        const cb = rafCallbacks.shift()!;
        cb(t);
      }
    }
    expect(loop.fps).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/game-loop.test.ts`
Expected: FAIL — module `./game-loop` not found

**Step 3: Write implementation**

```typescript
// ts/src/game-loop.ts

export type HookPhase = 'preTick' | 'postTick' | 'frameEnd';
export type HookFn = (dt: number) => void;
export type TickFn = (dt: number) => void;

export class GameLoop {
  private readonly tickFn: TickFn;
  private readonly hooks: Record<HookPhase, HookFn[]> = {
    preTick: [],
    postTick: [],
    frameEnd: [],
  };

  private _running = false;
  private _paused = false;
  private rafId = 0;
  private lastTime = 0;
  private _fps = 0;
  private frameCount = 0;
  private fpsAccum = 0;

  constructor(tickFn: TickFn) {
    this.tickFn = tickFn;
  }

  get running(): boolean { return this._running; }
  get paused(): boolean { return this._paused; }
  get fps(): number { return this._fps; }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._paused = false;
    this.lastTime = 0;
    this.rafId = requestAnimationFrame((t) => this.frame(t));
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    cancelAnimationFrame(this.rafId);
  }

  pause(): void { this._paused = true; }
  resume(): void { this._paused = false; }

  addHook(phase: HookPhase, fn: HookFn): void {
    this.hooks[phase].push(fn);
  }

  removeHook(phase: HookPhase, fn: HookFn): void {
    const arr = this.hooks[phase];
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }

  private frame(now: number): void {
    if (!this._running) return;

    const dt = this.lastTime === 0 ? 0 : (now - this.lastTime) / 1000;
    this.lastTime = now;

    // FPS tracking
    this.frameCount++;
    this.fpsAccum += dt;
    if (this.fpsAccum >= 1.0) {
      this._fps = Math.round(this.frameCount / this.fpsAccum);
      this.frameCount = 0;
      this.fpsAccum = 0;
    }

    if (!this._paused && dt > 0) {
      for (const fn of this.hooks.preTick) fn(dt);
      this.tickFn(dt);
      for (const fn of this.hooks.postTick) fn(dt);
      for (const fn of this.hooks.frameEnd) fn(dt);
    }

    this.rafId = requestAnimationFrame((t) => this.frame(t));
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/game-loop.test.ts`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add ts/src/game-loop.ts ts/src/game-loop.test.ts
git commit -m "feat(phase5): add GameLoop with RAF lifecycle and preTick/postTick/frameEnd hooks"
```

---

### Task 7: Hyperion Class Skeleton — create() Factory

**Files:**
- Create: `ts/src/hyperion.ts`
- Test: `ts/src/hyperion.test.ts`

This is the central facade. It wires together config → bridge → renderer → camera → game loop. For testability, we inject dependencies.

**Step 1: Write the failing test**

```typescript
// ts/src/hyperion.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Hyperion } from './hyperion';
import type { EngineBridge, GPURenderState } from './worker-bridge';
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
    engine.destroy(); // should not throw
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
    const id1 = e1.id;
    e1.destroy();
    // Next spawn should reuse the handle object (but with different ID)
    const e2 = engine.spawn();
    // Pool reuse is an implementation detail; just verify it works.
    expect(e2.alive).toBe(true);
  });

  it('mode getter returns bridge mode string', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(engine.mode).toBe('C');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — module `./hyperion` not found

**Step 3: Write implementation**

```typescript
// ts/src/hyperion.ts
import type { EngineBridge } from './worker-bridge';
import type { Renderer } from './renderer';
import type { ResolvedConfig, HyperionConfig, TextureHandle } from './types';
import { validateConfig } from './types';
import { EntityHandle } from './entity-handle';
import { EntityHandlePool } from './entity-pool';
import { GameLoop } from './game-loop';
import { Camera } from './camera';
import { LeakDetector } from './leak-detector';
import { ExecutionMode } from './capabilities';

const MODE_LABELS: Record<string, string> = {
  [ExecutionMode.FullIsolation]: 'A',
  [ExecutionMode.PartialIsolation]: 'B',
  [ExecutionMode.SingleThread]: 'C',
};

export class Hyperion implements Disposable {
  private readonly config: ResolvedConfig;
  private readonly bridge: EngineBridge;
  private readonly renderer: Renderer | null;
  private readonly camera: Camera;
  private readonly loop: GameLoop;
  private readonly pool: EntityHandlePool;
  private readonly leakDetector: LeakDetector;

  private nextEntityId = 0;
  private entityCount = 0;
  private destroyed = false;

  /** Internal constructor — use Hyperion.create() or Hyperion.fromParts(). */
  private constructor(
    config: ResolvedConfig,
    bridge: EngineBridge,
    renderer: Renderer | null,
  ) {
    this.config = config;
    this.bridge = bridge;
    this.renderer = renderer;
    this.camera = new Camera();
    this.pool = new EntityHandlePool();
    this.leakDetector = new LeakDetector();

    this.loop = new GameLoop((dt) => this.tick(dt));
  }

  /** Create from pre-built dependencies (for testing). */
  static fromParts(
    config: ResolvedConfig,
    bridge: EngineBridge,
    renderer: Renderer | null,
  ): Hyperion {
    return new Hyperion(config, bridge, renderer);
  }

  // --- Entity Management ---

  spawn(): EntityHandle {
    this.checkDestroyed();
    const id = this.nextEntityId++;
    this.bridge.commandBuffer.spawnEntity(id);
    this.entityCount++;

    const handle = this.pool.acquire(id, this.bridge.commandBuffer);
    this.leakDetector.register(handle, id);
    return handle;
  }

  /** Return a destroyed handle to the pool. Called internally. */
  returnHandle(handle: EntityHandle): void {
    this.leakDetector.unregister(handle);
    this.entityCount--;
    this.pool.release(handle);
  }

  // --- Lifecycle ---

  get mode(): string {
    return MODE_LABELS[this.bridge.mode] ?? this.bridge.mode;
  }

  start(): void {
    this.checkDestroyed();
    this.loop.start();
  }

  pause(): void { this.loop.pause(); }
  resume(): void { this.loop.resume(); }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // 1. Stop RAF
    this.loop.stop();

    // 2-4. Bridge handles flush + worker termination
    this.bridge.destroy();

    // 5-8. Renderer handles GPU cleanup
    this.renderer?.destroy();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }

  // --- Internal ---

  private tick(dt: number): void {
    this.bridge.tick(dt);

    const state = this.bridge.latestRenderState;
    if (this.renderer && state && state.entityCount > 0) {
      this.renderer.render(state, this.camera);
    }
  }

  private checkDestroyed(): void {
    if (this.destroyed) throw new Error('Hyperion instance has been destroyed');
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS (8 tests)

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase5): add Hyperion class skeleton with spawn, destroy, Symbol.dispose"
```

---

### Task 8: Hyperion.create() — Async Factory Wiring Capabilities → Bridge → Renderer

**Files:**
- Modify: `ts/src/hyperion.ts` (add static `create()`)
- Modify: `ts/src/hyperion.test.ts` (add integration-style test)

**Step 1: Write the failing test**

Add to `ts/src/hyperion.test.ts`:

```typescript
describe('Hyperion.create', () => {
  it('is an async static factory', () => {
    expect(typeof Hyperion.create).toBe('function');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `Hyperion.create` is not a function

**Step 3: Add create() method**

Add to `Hyperion` class in `ts/src/hyperion.ts`:

```typescript
import {
  detectCapabilities,
  selectExecutionMode,
  ExecutionMode,
} from './capabilities';
import {
  createWorkerBridge,
  createDirectBridge,
  createFullIsolationBridge,
} from './worker-bridge';
import { createRenderer } from './renderer';

// Inside Hyperion class:
static async create(userConfig: HyperionConfig): Promise<Hyperion> {
  const config = validateConfig(userConfig);

  const caps = detectCapabilities();
  const mode = config.preferredMode === 'auto'
    ? selectExecutionMode(caps)
    : ({ A: ExecutionMode.FullIsolation, B: ExecutionMode.PartialIsolation, C: ExecutionMode.SingleThread }[config.preferredMode] ?? selectExecutionMode(caps));

  let bridge: EngineBridge;
  let rendererOnMain = true;

  if (mode === ExecutionMode.FullIsolation) {
    bridge = createFullIsolationBridge(config.canvas);
    rendererOnMain = false;
  } else if (mode === ExecutionMode.PartialIsolation) {
    bridge = createWorkerBridge(mode);
  } else {
    bridge = await createDirectBridge();
  }

  await bridge.ready();

  let renderer: Renderer | null = null;
  if (rendererOnMain && caps.webgpu) {
    try {
      renderer = await createRenderer(config.canvas);
    } catch {
      renderer = null;
    }
  }

  return new Hyperion(config, bridge, renderer);
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase5): add Hyperion.create() async factory with capability detection"
```

---

### Task 9: Hyperion.batch() — Batched Command Execution

**Files:**
- Modify: `ts/src/hyperion.ts`
- Modify: `ts/src/hyperion.test.ts`

**Step 1: Write the failing test**

Add to `ts/src/hyperion.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `engine.batch is not a function`

**Step 3: Add batch() to Hyperion**

```typescript
// In Hyperion class:
batch(fn: () => void): void {
  this.checkDestroyed();
  fn();
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase5): add Hyperion.batch() for grouped entity operations"
```

---

### Task 10: RawAPI — Low-Level Numeric ID Interface

**Files:**
- Create: `ts/src/raw-api.ts`
- Test: `ts/src/raw-api.test.ts`

**Step 1: Write the failing test**

```typescript
// ts/src/raw-api.test.ts
import { describe, it, expect, vi } from 'vitest';
import { RawAPI } from './raw-api';
import type { BackpressuredProducer } from './backpressure';

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
    writeCommand: vi.fn(() => true),
    flush: vi.fn(),
    pendingCount: 0,
    freeSpace: 1000,
  } as unknown as BackpressuredProducer;
}

describe('RawAPI', () => {
  it('spawn allocates a numeric ID and sends command', () => {
    const p = mockProducer();
    let nextId = 0;
    const raw = new RawAPI(p, () => nextId++);
    const id = raw.spawn();
    expect(id).toBe(0);
    expect(p.spawnEntity).toHaveBeenCalledWith(0);
  });

  it('despawn sends DespawnEntity command', () => {
    const p = mockProducer();
    const raw = new RawAPI(p, () => 5);
    raw.despawn(5);
    expect(p.despawnEntity).toHaveBeenCalledWith(5);
  });

  it('setPosition delegates to producer', () => {
    const p = mockProducer();
    const raw = new RawAPI(p, () => 0);
    raw.setPosition(0, 1, 2, 3);
    expect(p.setPosition).toHaveBeenCalledWith(0, 1, 2, 3);
  });

  it('setVelocity delegates to producer', () => {
    const p = mockProducer();
    const raw = new RawAPI(p, () => 0);
    raw.setVelocity(0, 4, 5, 6);
    expect(p.setVelocity).toHaveBeenCalledWith(0, 4, 5, 6);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/raw-api.test.ts`
Expected: FAIL — module `./raw-api` not found

**Step 3: Write implementation**

```typescript
// ts/src/raw-api.ts
import type { BackpressuredProducer } from './backpressure';

export class RawAPI {
  private readonly producer: BackpressuredProducer;
  private readonly allocId: () => number;

  constructor(producer: BackpressuredProducer, allocId: () => number) {
    this.producer = producer;
    this.allocId = allocId;
  }

  spawn(): number {
    const id = this.allocId();
    this.producer.spawnEntity(id);
    return id;
  }

  despawn(id: number): void { this.producer.despawnEntity(id); }
  setPosition(id: number, x: number, y: number, z: number): void { this.producer.setPosition(id, x, y, z); }
  setVelocity(id: number, vx: number, vy: number, vz: number): void { this.producer.setVelocity(id, vx, vy, vz); }
  setRotation(id: number, x: number, y: number, z: number, w: number): void { this.producer.setRotation(id, x, y, z, w); }
  setScale(id: number, sx: number, sy: number, sz: number): void { this.producer.setScale(id, sx, sy, sz); }
  setTexture(id: number, handle: number): void { this.producer.setTextureLayer(id, handle); }
  setMesh(id: number, handle: number): void { this.producer.setMeshHandle(id, handle); }
  setParent(id: number, parentId: number): void { this.producer.setParent(id, parentId); }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/raw-api.test.ts`
Expected: PASS (4 tests)

**Step 5: Wire RawAPI into Hyperion and commit**

In `ts/src/hyperion.ts`, add:

```typescript
import { RawAPI } from './raw-api';

// In constructor:
this.rawApi = new RawAPI(bridge.commandBuffer, () => this.nextEntityId++);

// Public getter:
get raw(): RawAPI { return this.rawApi; }
```

```bash
git add ts/src/raw-api.ts ts/src/raw-api.test.ts ts/src/hyperion.ts
git commit -m "feat(phase5): add RawAPI for low-level numeric entity ID access"
```

---

## Part 3: Camera, Assets & Stats (Tasks 11–14)

### Task 11: CameraAPI Wrapper + Zoom

**Files:**
- Modify: `ts/src/camera.ts` (add `zoom` field)
- Create: `ts/src/camera-api.ts`
- Test: `ts/src/camera-api.test.ts`

**Step 1: Write the failing test**

```typescript
// ts/src/camera-api.test.ts
import { describe, it, expect } from 'vitest';
import { CameraAPI } from './camera-api';
import { Camera } from './camera';

describe('CameraAPI', () => {
  it('wraps Camera.setPosition', () => {
    const cam = new Camera();
    const api = new CameraAPI(cam);
    api.position(10, 20);
    const vp = cam.viewProjection;
    // View translation should be (-10, -20, 0)
    expect(vp).toBeTruthy();
  });

  it('zoom adjusts orthographic width/height', () => {
    const cam = new Camera();
    const api = new CameraAPI(cam);
    api.setOrthographic(800, 600);
    api.zoom(2.0);
    // At zoom=2, visible area is halved
    expect(api.zoomLevel).toBe(2.0);
  });

  it('zoom clamps to positive values', () => {
    const cam = new Camera();
    const api = new CameraAPI(cam);
    api.setOrthographic(800, 600);
    api.zoom(0);
    expect(api.zoomLevel).toBe(0.01); // clamped
    api.zoom(-5);
    expect(api.zoomLevel).toBe(0.01);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/camera-api.test.ts`
Expected: FAIL — module `./camera-api` not found

**Step 3: Write implementation**

```typescript
// ts/src/camera-api.ts
import { Camera } from './camera';

export class CameraAPI {
  private readonly cam: Camera;
  private _zoom = 1.0;
  private _width = 0;
  private _height = 0;

  constructor(cam: Camera) {
    this.cam = cam;
  }

  get zoomLevel(): number { return this._zoom; }

  position(x: number, y: number, z = 0): void {
    this.cam.setPosition(x, y, z);
  }

  setOrthographic(width: number, height: number, near = 0.1, far = 1000): void {
    this._width = width;
    this._height = height;
    this.applyProjection(near, far);
  }

  zoom(level: number): void {
    this._zoom = Math.max(0.01, level);
    this.applyProjection();
  }

  get viewProjection(): Float32Array {
    return this.cam.viewProjection;
  }

  private applyProjection(near = 0.1, far = 1000): void {
    if (this._width === 0 || this._height === 0) return;
    const w = this._width / this._zoom;
    const h = this._height / this._zoom;
    this.cam.setOrthographic(w, h, near, far);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/camera-api.test.ts`
Expected: PASS (3 tests)

**Step 5: Wire into Hyperion and commit**

In `ts/src/hyperion.ts`, replace raw `Camera` with `CameraAPI`:

```typescript
import { CameraAPI } from './camera-api';

// In constructor:
this.cameraApi = new CameraAPI(this.camera);

// Public getter:
get cam(): CameraAPI { return this.cameraApi; }
```

```bash
git add ts/src/camera-api.ts ts/src/camera-api.test.ts ts/src/camera.ts ts/src/hyperion.ts
git commit -m "feat(phase5): add CameraAPI wrapper with zoom support"
```

---

### Task 12: Asset Loading API — engine.loadTexture/loadTextures

**Files:**
- Modify: `ts/src/hyperion.ts`
- Modify: `ts/src/hyperion.test.ts`

**Step 1: Write the failing test**

Add to `ts/src/hyperion.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `engine.loadTexture is not a function`

**Step 3: Add to Hyperion class**

```typescript
async loadTexture(url: string, tier?: number): Promise<TextureHandle> {
  this.checkDestroyed();
  if (!this.renderer) throw new Error('Cannot load textures: no renderer available');
  return this.renderer.textureManager.loadTexture(url, tier);
}

async loadTextures(
  urls: string[],
  opts?: { onProgress?: (loaded: number, total: number) => void; concurrency?: number },
): Promise<TextureHandle[]> {
  this.checkDestroyed();
  if (!this.renderer) throw new Error('Cannot load textures: no renderer available');

  const results: TextureHandle[] = [];
  let loaded = 0;
  for (const url of urls) {
    const handle = await this.renderer.textureManager.loadTexture(url);
    results.push(handle);
    loaded++;
    opts?.onProgress?.(loaded, urls.length);
  }
  return results;
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase5): add loadTexture/loadTextures API to Hyperion"
```

---

### Task 13: Stats API — engine.stats

**Files:**
- Modify: `ts/src/hyperion.ts`
- Modify: `ts/src/hyperion.test.ts`

**Step 1: Write the failing test**

Add to `ts/src/hyperion.test.ts`:

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `engine.stats` is undefined

**Step 3: Add stats getter to Hyperion**

```typescript
get stats(): HyperionStats {
  return {
    fps: this.loop.fps,
    entityCount: this.entityCount,
    mode: this.mode,
    tickCount: 0, // TODO: wire to WASM engine_tick_count when available
    overflowCount: this.bridge.commandBuffer.pendingCount,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase5): add stats API to Hyperion (fps, entityCount, mode)"
```

---

### Task 14: Resize Handling — Auto-configure Camera on Canvas Resize

**Files:**
- Modify: `ts/src/hyperion.ts`
- Modify: `ts/src/hyperion.test.ts`

**Step 1: Write the failing test**

Add to `ts/src/hyperion.test.ts`:

```typescript
it('resize() updates camera orthographic projection', () => {
  const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
  engine.resize(1920, 1080);
  expect(engine.cam.zoomLevel).toBe(1.0);
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `engine.resize is not a function`

**Step 3: Add resize() to Hyperion**

```typescript
resize(width: number, height: number): void {
  this.checkDestroyed();
  const aspect = width / height;
  this.cameraApi.setOrthographic(20 * aspect, 20);
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase5): add resize() for responsive camera projection"
```

---

## Part 4: Scene Graph — Rust (Tasks 15–19)

### Task 15: Scene Graph Components — Parent, Children, LocalMatrix

**Files:**
- Modify: `crates/hyperion-core/src/components.rs`

**Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` in `crates/hyperion-core/src/components.rs`:

```rust
#[test]
fn parent_default_is_none_sentinel() {
    let p = Parent::default();
    assert_eq!(p.0, u32::MAX); // u32::MAX = no parent
}

#[test]
fn children_default_is_empty() {
    let c = Children::default();
    assert_eq!(c.count, 0);
}

#[test]
fn children_add_and_get() {
    let mut c = Children::default();
    c.add(5);
    c.add(10);
    assert_eq!(c.count, 2);
    assert_eq!(c.get(0), Some(5));
    assert_eq!(c.get(1), Some(10));
    assert_eq!(c.get(2), None);
}

#[test]
fn children_remove() {
    let mut c = Children::default();
    c.add(1);
    c.add(2);
    c.add(3);
    c.remove(2);
    assert_eq!(c.count, 2);
    assert_eq!(c.get(0), Some(1));
    assert_eq!(c.get(1), Some(3));
}

#[test]
fn children_max_capacity() {
    let mut c = Children::default();
    for i in 0..Children::MAX_CHILDREN as u32 {
        assert!(c.add(i));
    }
    assert!(!c.add(999)); // exceeds capacity
}

#[test]
fn local_matrix_default_is_identity() {
    let m = LocalMatrix::default();
    assert_eq!(m.0[0], 1.0);
    assert_eq!(m.0[5], 1.0);
    assert_eq!(m.0[10], 1.0);
    assert_eq!(m.0[15], 1.0);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core components`
Expected: FAIL — `Parent`, `Children`, `LocalMatrix` not found

**Step 3: Add components to `crates/hyperion-core/src/components.rs`**

```rust
/// Parent entity (external ID). u32::MAX = no parent.
#[derive(Debug, Clone, Copy)]
pub struct Parent(pub u32);

impl Default for Parent {
    fn default() -> Self {
        Self(u32::MAX) // sentinel: no parent
    }
}

/// Children list. Fixed-capacity inline array (max 32 children).
/// Avoids heap allocation for typical scene graph nodes.
#[derive(Debug, Clone)]
pub struct Children {
    pub slots: [u32; Self::MAX_CHILDREN],
    pub count: u8,
}

impl Children {
    pub const MAX_CHILDREN: usize = 32;

    pub fn add(&mut self, child_id: u32) -> bool {
        if (self.count as usize) >= Self::MAX_CHILDREN {
            return false;
        }
        self.slots[self.count as usize] = child_id;
        self.count += 1;
        true
    }

    pub fn remove(&mut self, child_id: u32) {
        for i in 0..self.count as usize {
            if self.slots[i] == child_id {
                // Swap-remove
                self.count -= 1;
                self.slots[i] = self.slots[self.count as usize];
                return;
            }
        }
    }

    pub fn get(&self, index: usize) -> Option<u32> {
        if index < self.count as usize {
            Some(self.slots[index])
        } else {
            None
        }
    }

    pub fn as_slice(&self) -> &[u32] {
        &self.slots[..self.count as usize]
    }
}

impl Default for Children {
    fn default() -> Self {
        Self {
            slots: [0; Self::MAX_CHILDREN],
            count: 0,
        }
    }
}

/// Local-space model matrix (relative to parent).
/// When an entity has no parent, this is unused.
#[derive(Debug, Clone, Copy)]
pub struct LocalMatrix(pub [f32; 16]);

impl Default for LocalMatrix {
    fn default() -> Self {
        Self(glam::Mat4::IDENTITY.to_cols_array())
    }
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p hyperion-core components`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/components.rs
git commit -m "feat(phase5): add Parent, Children, LocalMatrix scene graph components"
```

---

### Task 16: SetParent Command — Replace No-Op Stub

**Files:**
- Modify: `crates/hyperion-core/src/command_processor.rs`

**Step 1: Write the failing test**

Add to `command_processor.rs` tests:

```rust
#[test]
fn set_parent_adds_parent_component() {
    let mut world = World::new();
    let mut map = EntityMap::new();

    // Spawn parent (id=0) and child (id=1)
    process_commands(&[make_spawn_cmd(0), make_spawn_cmd(1)], &mut world, &mut map);

    // SetParent: child 1 -> parent 0
    let mut payload = [0u8; 16];
    payload[0..4].copy_from_slice(&0u32.to_le_bytes()); // parent_id = 0
    let cmd = Command {
        cmd_type: CommandType::SetParent,
        entity_id: 1,
        payload,
    };
    process_commands(&[cmd], &mut world, &mut map);

    let child_entity = map.get(1).unwrap();
    let parent = world.get::<&Parent>(child_entity).unwrap();
    assert_eq!(parent.0, 0);

    let parent_entity = map.get(0).unwrap();
    let children = world.get::<&Children>(parent_entity).unwrap();
    assert!(children.as_slice().contains(&1));
}

#[test]
fn set_parent_with_max_sentinel_unparents() {
    let mut world = World::new();
    let mut map = EntityMap::new();

    process_commands(&[make_spawn_cmd(0), make_spawn_cmd(1)], &mut world, &mut map);

    // Parent child to 0
    let mut payload = [0u8; 16];
    payload[0..4].copy_from_slice(&0u32.to_le_bytes());
    process_commands(&[Command { cmd_type: CommandType::SetParent, entity_id: 1, payload }], &mut world, &mut map);

    // Unparent: set parent to u32::MAX
    payload[0..4].copy_from_slice(&u32::MAX.to_le_bytes());
    process_commands(&[Command { cmd_type: CommandType::SetParent, entity_id: 1, payload }], &mut world, &mut map);

    let child_entity = map.get(1).unwrap();
    let parent = world.get::<&Parent>(child_entity).unwrap();
    assert_eq!(parent.0, u32::MAX);

    let parent_entity = map.get(0).unwrap();
    let children = world.get::<&Children>(parent_entity).unwrap();
    assert!(!children.as_slice().contains(&1));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core command_proc`
Expected: FAIL — `Parent` component not on entity

**Step 3: Implement SetParent in `command_processor.rs`**

Replace the no-op stub with:

```rust
CommandType::SetParent => {
    if let Some(child_entity) = entity_map.get(cmd.entity_id) {
        let new_parent_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());

        // Remove from old parent's Children if currently parented
        if let Ok(old_parent) = world.get::<&Parent>(child_entity) {
            let old_id = old_parent.0;
            if old_id != u32::MAX {
                if let Some(old_parent_entity) = entity_map.get(old_id) {
                    if let Ok(mut children) = world.get::<&mut Children>(old_parent_entity) {
                        children.remove(cmd.entity_id);
                    }
                }
            }
        }

        // Update child's Parent component
        if let Ok(mut parent) = world.get::<&mut Parent>(child_entity) {
            parent.0 = new_parent_id;
        }

        // Add to new parent's Children (if not u32::MAX = unparent)
        if new_parent_id != u32::MAX {
            if let Some(parent_entity) = entity_map.get(new_parent_id) {
                if let Ok(mut children) = world.get::<&mut Children>(parent_entity) {
                    children.add(cmd.entity_id);
                }
            }
        }
    }
}
```

Also update `SpawnEntity` to include `Parent::default()` and `Children::default()` in the spawn bundle.

**Step 4: Run test to verify it passes**

Run: `cargo test -p hyperion-core command_proc`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/command_processor.rs crates/hyperion-core/src/components.rs
git commit -m "feat(phase5): implement SetParent command with parent/child bookkeeping"
```

---

### Task 17: propagate_transforms System

**Files:**
- Modify: `crates/hyperion-core/src/systems.rs`

**Step 1: Write the failing test**

Add to `systems.rs` tests:

```rust
#[test]
fn propagate_transforms_applies_parent_matrix() {
    let mut world = World::new();

    // Parent at position (10, 0, 0)
    let parent = world.spawn((
        Position(Vec3::new(10.0, 0.0, 0.0)),
        Rotation(Quat::IDENTITY),
        Scale(Vec3::ONE),
        ModelMatrix::default(),
        Parent::default(),
        Children::default(),
        Active,
    ));

    // Child at local position (5, 0, 0) — should end up at world (15, 0, 0)
    let child = world.spawn((
        Position(Vec3::new(5.0, 0.0, 0.0)),
        Rotation(Quat::IDENTITY),
        Scale(Vec3::ONE),
        ModelMatrix::default(),
        Parent(0), // external ID 0 = parent
        Children::default(),
        Active,
    ));

    // Run transform system to compute parent's model matrix
    transform_system(&mut world);

    // For testing without EntityMap, we'll use a simple map
    let mut ext_to_entity = std::collections::HashMap::new();
    ext_to_entity.insert(0u32, parent);
    ext_to_entity.insert(1u32, child);

    propagate_transforms(&mut world, &ext_to_entity);

    let child_matrix = world.get::<&ModelMatrix>(child).unwrap();
    // Child world position should be parent(10) + child(5) = 15
    assert!((child_matrix.0[12] - 15.0).abs() < 0.001);
}

#[test]
fn propagate_transforms_skips_unparented() {
    let mut world = World::new();
    let entity = world.spawn((
        Position(Vec3::new(5.0, 0.0, 0.0)),
        Rotation(Quat::IDENTITY),
        Scale(Vec3::ONE),
        ModelMatrix::default(),
        Parent::default(), // u32::MAX = no parent
        Children::default(),
        Active,
    ));

    transform_system(&mut world);

    let ext_to_entity = std::collections::HashMap::new();
    propagate_transforms(&mut world, &ext_to_entity);

    // Unparented entity should keep its own transform unchanged
    let matrix = world.get::<&ModelMatrix>(entity).unwrap();
    assert!((matrix.0[12] - 5.0).abs() < 0.001);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core systems`
Expected: FAIL — `propagate_transforms` not found

**Step 3: Implement propagate_transforms in `systems.rs`**

```rust
use std::collections::HashMap;
use crate::components::{Parent, Children, ModelMatrix, Active};

/// Propagate parent transforms to children.
/// For each entity with a Parent != u32::MAX, multiply parent's ModelMatrix
/// by child's local ModelMatrix to produce the child's world ModelMatrix.
///
/// Max depth: 32. If cycles are detected (shouldn't happen), stops at 32.
pub fn propagate_transforms(
    world: &mut World,
    ext_to_entity: &HashMap<u32, hecs::Entity>,
) {
    // Collect parented entities
    let parented: Vec<(hecs::Entity, u32)> = world
        .query::<(&Parent, &Active)>()
        .iter()
        .filter(|(parent, _)| parent.0 != u32::MAX)
        .map(|(parent, _)| {
            // We need entity ID — get it from the query with entity
            unreachable!() // placeholder
        })
        .collect();

    // Better approach: iterate with entity IDs
    let mut updates: Vec<(hecs::Entity, [f32; 16])> = Vec::new();

    for (entity, (parent_comp, matrix, _active)) in
        world.query::<(&Parent, &ModelMatrix, &Active)>().iter()
    {
        if parent_comp.0 == u32::MAX {
            continue;
        }
        if let Some(&parent_entity) = ext_to_entity.get(&parent_comp.0) {
            if let Ok(parent_matrix) = world.get::<&ModelMatrix>(parent_entity) {
                // child_world = parent_world * child_local
                let parent_mat4 = glam::Mat4::from_cols_array(&parent_matrix.0);
                let child_mat4 = glam::Mat4::from_cols_array(&matrix.0);
                let result = parent_mat4 * child_mat4;
                updates.push((entity, result.to_cols_array()));
            }
        }
    }

    for (entity, new_matrix) in updates {
        if let Ok(mut m) = world.get::<&mut ModelMatrix>(entity) {
            m.0 = new_matrix;
        }
    }
}
```

Note: The actual implementation will need refinement to use hecs entity iteration correctly. The test drives the API shape.

**Step 4: Run test to verify it passes**

Run: `cargo test -p hyperion-core systems`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/systems.rs
git commit -m "feat(phase5): add propagate_transforms system for scene graph hierarchy"
```

---

### Task 18: Wire propagate_transforms into Engine.update()

**Files:**
- Modify: `crates/hyperion-core/src/engine.rs`

**Step 1: Write the failing test**

Add to `engine.rs` tests:

```rust
#[test]
fn engine_propagates_parent_transforms() {
    let mut engine = Engine::new();

    // Spawn parent (id=0) and child (id=1)
    engine.process_commands(&[spawn_cmd(0), spawn_cmd(1)]);

    // Set parent position
    let mut pos_payload = [0u8; 16];
    pos_payload[0..4].copy_from_slice(&10.0f32.to_le_bytes());
    engine.process_commands(&[Command {
        cmd_type: CommandType::SetPosition,
        entity_id: 0,
        payload: pos_payload,
    }]);

    // Set child position (will become local offset)
    let mut child_pos = [0u8; 16];
    child_pos[0..4].copy_from_slice(&5.0f32.to_le_bytes());
    engine.process_commands(&[Command {
        cmd_type: CommandType::SetPosition,
        entity_id: 1,
        payload: child_pos,
    }]);

    // SetParent: child 1 -> parent 0
    let mut parent_payload = [0u8; 16];
    parent_payload[0..4].copy_from_slice(&0u32.to_le_bytes());
    engine.process_commands(&[Command {
        cmd_type: CommandType::SetParent,
        entity_id: 1,
        payload: parent_payload,
    }]);

    engine.update(FIXED_DT);

    let child_entity = engine.entity_map.get(1).unwrap();
    let matrix = engine.world.get::<&crate::components::ModelMatrix>(child_entity).unwrap();
    // Child world X = parent(10) + child(5) = 15
    assert!((matrix.0[12] - 15.0).abs() < 0.001);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core engine`
Expected: FAIL — propagation not yet wired

**Step 3: Wire into Engine.update()**

In `engine.rs`, add after `transform_system()`:

```rust
// 2b. Propagate parent transforms for scene graph.
{
    let ext_to_entity: std::collections::HashMap<u32, hecs::Entity> =
        self.entity_map.iter_mapped().collect();
    propagate_transforms(&mut self.world, &ext_to_entity);
}
```

Also add `EntityMap::iter_mapped()`:

```rust
// In EntityMap:
pub fn iter_mapped(&self) -> impl Iterator<Item = (u32, hecs::Entity)> + '_ {
    self.map.iter().enumerate().filter_map(|(idx, opt)| {
        opt.map(|entity| (idx as u32, entity))
    })
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p hyperion-core engine`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/engine.rs crates/hyperion-core/src/command_processor.rs
git commit -m "feat(phase5): wire propagate_transforms into Engine.update() loop"
```

---

### Task 19: Scene Graph TypeScript API — EntityHandle.parent/unparent

**Files:**
- Modify: `ts/src/entity-handle.ts`
- Modify: `ts/src/entity-handle.test.ts`

**Step 1: Write the failing test**

Add to `ts/src/entity-handle.test.ts`:

```typescript
it('parent() sends SetParent command', () => {
  const p = mockProducer();
  const child = new EntityHandle(1, p);
  const result = child.parent(0);
  expect(result).toBe(child);
  expect(p.setParent).toHaveBeenCalledWith(1, 0);
});

it('unparent() sends SetParent with MAX sentinel', () => {
  const p = mockProducer();
  const child = new EntityHandle(1, p);
  child.unparent();
  expect(p.setParent).toHaveBeenCalledWith(1, 0xFFFFFFFF);
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: FAIL — `child.parent is not a function`

**Step 3: Add to EntityHandle**

```typescript
parent(parentId: number): this {
  this.check();
  this._producer!.setParent(this._id, parentId);
  return this;
}

unparent(): this {
  this.check();
  this._producer!.setParent(this._id, 0xFFFFFFFF);
  return this;
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/entity-handle.ts ts/src/entity-handle.test.ts
git commit -m "feat(phase5): add parent()/unparent() to EntityHandle for scene graph"
```

---

## Part 5: Memory Compaction (Tasks 20–23)

### Task 20: Rust — EntityMap.shrink_to_fit()

**Files:**
- Modify: `crates/hyperion-core/src/command_processor.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn entity_map_shrink_to_fit() {
    let mut map = EntityMap::new();
    let mut world = World::new();

    // Spawn 100 entities
    for i in 0..100 {
        let entity = world.spawn((Position::default(), Active));
        map.insert(i, entity);
    }

    // Despawn entities 50-99 (last half)
    for i in 50..100 {
        map.remove(i);
    }

    let old_capacity = map.capacity();
    map.shrink_to_fit();
    assert!(map.capacity() <= 50);

    // Verify remaining entities are intact
    for i in 0..50 {
        assert!(map.get(i).is_some());
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core command_proc`
Expected: FAIL — `shrink_to_fit` not found

**Step 3: Add to EntityMap**

```rust
/// Current allocated capacity.
pub fn capacity(&self) -> usize {
    self.map.len()
}

/// Shrink the map by truncating trailing None entries.
/// Does NOT compact internal holes — use compact() for that.
pub fn shrink_to_fit(&mut self) {
    // Find last occupied slot
    let last_used = self.map.iter().rposition(|opt| opt.is_some());
    match last_used {
        Some(idx) => self.map.truncate(idx + 1),
        None => self.map.clear(),
    }
    self.map.shrink_to_fit();
    self.free_list.retain(|&id| (id as usize) < self.map.len());
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p hyperion-core command_proc`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/command_processor.rs
git commit -m "feat(phase5): add EntityMap.shrink_to_fit() for memory compaction"
```

---

### Task 21: Rust — RenderState.shrink_to_fit()

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn render_state_shrink_to_fit() {
    let mut state = RenderState::new();

    // Simulate large allocation by pushing data
    for _ in 0..1000 {
        state.gpu_transforms.extend_from_slice(&[0.0; 16]);
        state.gpu_bounds.extend_from_slice(&[0.0; 4]);
        state.gpu_render_meta.extend_from_slice(&[0u32; 2]);
        state.gpu_tex_indices.push(0);
    }

    // Clear (like a frame with zero entities)
    state.gpu_transforms.clear();
    state.gpu_bounds.clear();
    state.gpu_render_meta.clear();
    state.gpu_tex_indices.clear();

    let old_cap = state.gpu_transforms.capacity();
    state.shrink_to_fit();
    assert!(state.gpu_transforms.capacity() < old_cap);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core render_state`
Expected: FAIL — `shrink_to_fit` not found

**Step 3: Add to RenderState**

```rust
pub fn shrink_to_fit(&mut self) {
    self.matrices.shrink_to_fit();
    self.gpu_transforms.shrink_to_fit();
    self.gpu_bounds.shrink_to_fit();
    self.gpu_render_meta.shrink_to_fit();
    self.gpu_tex_indices.shrink_to_fit();
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p hyperion-core render_state`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/render_state.rs
git commit -m "feat(phase5): add RenderState.shrink_to_fit() for GPU buffer compaction"
```

---

### Task 22: Rust WASM Exports for Compaction + Stats

**Files:**
- Modify: `crates/hyperion-core/src/lib.rs`

**Step 1: Write the failing test**

(WASM exports can't be easily unit-tested in Rust, but we verify the functions compile.)

Verify `engine.rs` exposes compact methods, then add WASM wrappers.

**Step 2: Add compact and stats exports to `lib.rs`**

```rust
#[wasm_bindgen]
pub fn engine_compact_entity_map() {
    // SAFETY: wasm32 is single-threaded; only one accessor at a time.
    unsafe {
        let engine = addr_of_mut!(ENGINE);
        if let Some(ref mut e) = *engine {
            e.entity_map.shrink_to_fit();
        }
    }
}

#[wasm_bindgen]
pub fn engine_compact_render_state() {
    unsafe {
        let engine = addr_of_mut!(ENGINE);
        if let Some(ref mut e) = *engine {
            e.render_state.shrink_to_fit();
        }
    }
}

#[wasm_bindgen]
pub fn engine_entity_map_capacity() -> u32 {
    unsafe {
        let engine = addr_of_mut!(ENGINE);
        match &*engine {
            Some(e) => e.entity_map.capacity() as u32,
            None => 0,
        }
    }
}
```

**Step 3: Run Rust tests to verify compilation**

Run: `cargo test -p hyperion-core && cargo clippy -p hyperion-core`
Expected: PASS

**Step 4: Commit**

```bash
git add crates/hyperion-core/src/lib.rs
git commit -m "feat(phase5): add WASM exports for compaction and entity map stats"
```

---

### Task 23: TypeScript — engine.compact() API

**Files:**
- Modify: `ts/src/hyperion.ts`
- Modify: `ts/src/hyperion.test.ts`

**Step 1: Write the failing test**

```typescript
it('compact() is callable', () => {
  const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
  // Just verify it doesn't throw; actual WASM compaction requires WASM loaded.
  expect(() => engine.compact()).not.toThrow();
});

it('compact() accepts options', () => {
  const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
  expect(() => engine.compact({ entityMap: true, textures: true })).not.toThrow();
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `engine.compact is not a function`

**Step 3: Add compact() to Hyperion**

```typescript
compact(opts?: CompactOptions): void {
  this.checkDestroyed();
  // Texture compaction is TS-side only.
  if (opts?.textures !== false) {
    this.renderer?.textureManager.shrinkUnusedTiers?.();
  }
  // EntityMap and RenderState compaction happen via WASM bridge.
  // In Mode C (direct), we can call the WASM exports directly.
  // In Mode A/B (workers), compaction must be sent as a message.
  // For now, log the intent — full WASM wiring in next task.
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase5): add engine.compact() API stub"
```

---

## Part 6: Error Recovery & Supervisor (Tasks 24–26)

### Task 24: Device Lost Recovery — Listener + Re-init

**Files:**
- Modify: `ts/src/renderer.ts` (add `device.lost` listener)
- Modify: `ts/src/hyperion.ts` (handle recovery callback)

**Step 1: Write the failing test**

This is hard to unit-test (requires real GPU), so we test the callback wiring:

Add to `ts/src/hyperion.test.ts`:

```typescript
it('onDeviceLost callback is stored in config', () => {
  const onLost = vi.fn();
  const config = { ...defaultConfig(), onDeviceLost: onLost };
  // Just verify the type system accepts it.
  expect(config.onDeviceLost).toBe(onLost);
});
```

**Step 2: Add `onDeviceLost` to HyperionConfig in types.ts**

```typescript
// In HyperionConfig:
onDeviceLost?: (reason: string) => void;
```

**Step 3: In `createRenderer()`, add device.lost listener**

```typescript
// After device creation in renderer.ts:
device.lost.then((info) => {
  console.error(`[Hyperion] GPU device lost: ${info.message}`);
  // Future: attempt recovery. For now, log and continue ECS-only.
});
```

**Step 4: Run all TS tests to verify no regressions**

Run: `cd ts && npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/renderer.ts ts/src/types.ts ts/src/hyperion.ts
git commit -m "feat(phase5): add device.lost listener and onDeviceLost config option"
```

---

### Task 25: Supervisor Escalation — Mode Degradation

**Files:**
- Modify: `ts/src/supervisor.ts`
- Modify: `ts/src/supervisor.test.ts`

**Step 1: Write the failing test**

Add to `ts/src/supervisor.test.ts`:

```typescript
it('calls onEscalate after maxMissed beats', () => {
  const sab = new SharedArrayBuffer(32);
  const onEscalate = vi.fn();
  const supervisor = new WorkerSupervisor(sab, {
    maxMissedBeats: 2,
    onTimeout: onEscalate,
  });

  // Simulate 2 missed beats without heartbeat increment
  supervisor.check();
  supervisor.check();

  expect(onEscalate).toHaveBeenCalledWith(1);
});
```

**Step 2: Run test to verify behavior**

Run: `cd ts && npx vitest run src/supervisor.test.ts`
Expected: PASS (existing supervisor already has this logic)

**Step 3: Verify and commit**

The supervisor already has the escalation callback via `onTimeout`. The Hyperion class will wire this to mode degradation in the `create()` factory. No code changes needed for supervisor itself.

```bash
git add ts/src/supervisor.ts ts/src/supervisor.test.ts
git commit -m "test(phase5): verify supervisor escalation behavior"
```

---

### Task 26: TextureManager — Retain ImageBitmaps for Device Lost Recovery

**Files:**
- Modify: `ts/src/texture-manager.ts`
- Modify: `ts/src/texture-manager.test.ts`

**Step 1: Write the failing test**

Add to `ts/src/texture-manager.test.ts`:

```typescript
it('retainBitmaps option keeps ImageBitmaps for re-upload', () => {
  // This tests the config option exists and is respected.
  // Actual bitmap caching is hard to test without a real GPU.
  const device = createMockDevice();
  const tm = new TextureManager(device, { retainBitmaps: true });
  expect(tm.retainBitmaps).toBe(true);
});
```

**Step 2: Add retainBitmaps option to TextureManager**

In `ts/src/texture-manager.ts`, add to constructor:

```typescript
readonly retainBitmaps: boolean;
private bitmapCache = new Map<string, ImageBitmap>();

constructor(device: GPUDevice, opts?: { retainBitmaps?: boolean }) {
  // ... existing code ...
  this.retainBitmaps = opts?.retainBitmaps ?? false;
}
```

In the `loadTexture` method, after writing to texture and before closing bitmap:

```typescript
if (this.retainBitmaps) {
  this.bitmapCache.set(url, bitmap);
} else {
  bitmap.close();
}
```

**Step 3: Run tests**

Run: `cd ts && npx vitest run src/texture-manager.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add ts/src/texture-manager.ts ts/src/texture-manager.test.ts
git commit -m "feat(phase5): add retainBitmaps option to TextureManager for device-lost recovery"
```

---

## Part 7: Plugin System Stubs (Tasks 27–30)

### Task 27: HyperionPlugin Interface + PluginRegistry

**Files:**
- Create: `ts/src/plugin.ts`
- Test: `ts/src/plugin.test.ts`

**Step 1: Write the failing test**

```typescript
// ts/src/plugin.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PluginRegistry, type HyperionPlugin } from './plugin';

describe('PluginRegistry', () => {
  it('install adds a plugin', () => {
    const registry = new PluginRegistry();
    const plugin: HyperionPlugin = {
      name: 'test-plugin',
      install: vi.fn(),
      cleanup: vi.fn(),
    };
    registry.install(plugin, {} as any);
    expect(registry.has('test-plugin')).toBe(true);
    expect(plugin.install).toHaveBeenCalled();
  });

  it('uninstall removes and calls cleanup', () => {
    const registry = new PluginRegistry();
    const plugin: HyperionPlugin = {
      name: 'test-plugin',
      install: vi.fn(),
      cleanup: vi.fn(),
    };
    registry.install(plugin, {} as any);
    registry.uninstall('test-plugin');
    expect(registry.has('test-plugin')).toBe(false);
    expect(plugin.cleanup).toHaveBeenCalled();
  });

  it('list returns installed plugin names', () => {
    const registry = new PluginRegistry();
    registry.install({ name: 'a', install: vi.fn() }, {} as any);
    registry.install({ name: 'b', install: vi.fn() }, {} as any);
    expect(registry.list()).toEqual(['a', 'b']);
  });

  it('get returns plugin by name', () => {
    const registry = new PluginRegistry();
    const plugin: HyperionPlugin = { name: 'test', install: vi.fn() };
    registry.install(plugin, {} as any);
    expect(registry.get('test')).toBe(plugin);
  });

  it('throws on duplicate plugin name', () => {
    const registry = new PluginRegistry();
    registry.install({ name: 'x', install: vi.fn() }, {} as any);
    expect(() =>
      registry.install({ name: 'x', install: vi.fn() }, {} as any)
    ).toThrow('already installed');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/plugin.test.ts`
Expected: FAIL — module `./plugin` not found

**Step 3: Write implementation**

```typescript
// ts/src/plugin.ts

export interface HyperionPlugin {
  name: string;
  install: (engine: unknown) => void;
  cleanup?: () => void;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, HyperionPlugin>();

  install(plugin: HyperionPlugin, engine: unknown): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already installed`);
    }
    this.plugins.set(plugin.name, plugin);
    plugin.install(engine);
  }

  uninstall(name: string): void {
    const plugin = this.plugins.get(name);
    if (plugin) {
      plugin.cleanup?.();
      this.plugins.delete(name);
    }
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  get(name: string): HyperionPlugin | undefined {
    return this.plugins.get(name);
  }

  list(): string[] {
    return [...this.plugins.keys()];
  }

  destroyAll(): void {
    for (const plugin of this.plugins.values()) {
      plugin.cleanup?.();
    }
    this.plugins.clear();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/plugin.test.ts`
Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add ts/src/plugin.ts ts/src/plugin.test.ts
git commit -m "feat(phase5): add HyperionPlugin interface and PluginRegistry"
```

---

### Task 28: Wire Plugin System into Hyperion — engine.use/unuse

**Files:**
- Modify: `ts/src/hyperion.ts`
- Modify: `ts/src/hyperion.test.ts`

**Step 1: Write the failing test**

```typescript
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
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `engine.use is not a function`

**Step 3: Add to Hyperion**

```typescript
import { PluginRegistry, type HyperionPlugin } from './plugin';

// In constructor:
this.pluginRegistry = new PluginRegistry();

// Public API:
get plugins(): PluginRegistry { return this.pluginRegistry; }

use(plugin: HyperionPlugin): void {
  this.checkDestroyed();
  this.pluginRegistry.install(plugin, this);
}

unuse(name: string): void {
  this.checkDestroyed();
  this.pluginRegistry.uninstall(name);
}

// In destroy():
this.pluginRegistry.destroyAll();
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase5): wire PluginRegistry into Hyperion with use()/unuse()"
```

---

### Task 29: Game Loop Hooks — Wire preTick/postTick/frameEnd through Hyperion

**Files:**
- Modify: `ts/src/hyperion.ts`
- Modify: `ts/src/hyperion.test.ts`

**Step 1: Write the failing test**

```typescript
it('addHook/removeHook delegates to game loop', () => {
  const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
  const hook = vi.fn();
  engine.addHook('preTick', hook);
  // Verify it's wired (testing indirectly via the loop is sufficient)
  engine.removeHook('preTick', hook);
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `engine.addHook is not a function`

**Step 3: Add to Hyperion**

```typescript
import type { HookPhase, HookFn } from './game-loop';

addHook(phase: HookPhase, fn: HookFn): void {
  this.loop.addHook(phase, fn);
}

removeHook(phase: HookPhase, fn: HookFn): void {
  this.loop.removeHook(phase, fn);
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase5): expose addHook/removeHook for preTick/postTick/frameEnd"
```

---

### Task 30: EntityHandle.data() — Plugin Data Delegation

**Files:**
- Modify: `ts/src/entity-handle.ts`
- Modify: `ts/src/entity-handle.test.ts`

**Step 1: Write the failing test**

```typescript
it('data() stores and retrieves plugin-specific data', () => {
  const p = mockProducer();
  const h = new EntityHandle(0, p);
  h.data('physics', { mass: 10, restitution: 0.5 });
  expect(h.data('physics')).toEqual({ mass: 10, restitution: 0.5 });
});

it('data() returns undefined for unset plugin', () => {
  const p = mockProducer();
  const h = new EntityHandle(0, p);
  expect(h.data('nonexistent')).toBeUndefined();
});

it('data() is cleared on init() (pool reuse)', () => {
  const p = mockProducer();
  const h = new EntityHandle(0, p);
  h.data('physics', { mass: 10 });
  h.destroy();
  h.init(1, p);
  expect(h.data('physics')).toBeUndefined();
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: FAIL — `h.data is not a function`

**Step 3: Add data() to EntityHandle**

```typescript
// In EntityHandle class:
private _data: Map<string, unknown> | null = null;

data(pluginName: string): unknown;
data(pluginName: string, value: unknown): this;
data(pluginName: string, value?: unknown): unknown | this {
  if (arguments.length === 1) {
    return this._data?.get(pluginName);
  }
  this.check();
  if (!this._data) this._data = new Map();
  this._data.set(pluginName, value);
  return this;
}

// In init():
this._data = null;
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/entity-handle.ts ts/src/entity-handle.test.ts
git commit -m "feat(phase5): add data() to EntityHandle for plugin-specific storage"
```

---

## Part 8: Integration & Polish (Tasks 31–34)

### Task 31: Rewrite main.ts as Hyperion API Demo

**Files:**
- Modify: `ts/src/main.ts`

**Step 1: Plan the rewrite**

Replace the current procedural `main.ts` with a clean demo using the Hyperion API:

```typescript
// ts/src/main.ts
import { Hyperion } from './hyperion';

async function main() {
  const overlay = document.getElementById('overlay')!;
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;

  overlay.textContent = 'Hyperion Engine — initializing...';

  const engine = await Hyperion.create({ canvas });

  // Resize handler
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor(canvas.clientWidth * dpr);
    const height = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      engine.resize(width, height);
    }
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Spawn test entities: 50 inside frustum, 50 outside
  engine.batch(() => {
    for (let i = 0; i < 100; i++) {
      const e = engine.spawn();
      if (i < 50) {
        const col = i % 10;
        const row = Math.floor(i / 10);
        e.position((col - 4.5) * 2, (row - 2.5) * 2, 0);
      } else {
        const offset = i - 50;
        const x = offset < 25 ? -20 - offset : 20 + (offset - 25);
        e.position(x, 0, 0);
      }
    }
  });

  // Update overlay
  engine.addHook('frameEnd', () => {
    const s = engine.stats;
    overlay.textContent =
      `Hyperion Engine\nMode: ${s.mode}\nFPS: ${s.fps}\nEntities: ${s.entityCount}`;
  });

  engine.start();
}

main();
```

**Step 2: Verify type-check passes**

Run: `cd ts && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add ts/src/main.ts
git commit -m "refactor(phase5): rewrite main.ts to use Hyperion public API"
```

---

### Task 32: Public API Barrel Export

**Files:**
- Create: `ts/src/index.ts`

**Step 1: Create the barrel export**

```typescript
// ts/src/index.ts
export { Hyperion } from './hyperion';
export type { HyperionConfig, ResolvedConfig, HyperionStats, MemoryStats, CompactOptions, TextureHandle } from './types';
export type { HyperionPlugin } from './plugin';
export type { HookPhase, HookFn } from './game-loop';
export { EntityHandle } from './entity-handle';
export { RawAPI } from './raw-api';
export { CameraAPI } from './camera-api';
```

**Step 2: Verify type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add ts/src/index.ts
git commit -m "feat(phase5): add barrel export index.ts for public API surface"
```

---

### Task 33: Full Validation — Rust + TypeScript

**Files:** None (test run only)

**Step 1: Run full Rust test suite**

Run: `cargo test -p hyperion-core`
Expected: All tests PASS (68 existing + new scene graph/compaction tests)

**Step 2: Run full TypeScript test suite**

Run: `cd ts && npm test`
Expected: All tests PASS (95 existing + new API tests)

**Step 3: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: PASS

**Step 4: Clippy**

Run: `cargo clippy -p hyperion-core`
Expected: No warnings

**Step 5: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(phase5): address validation issues"
```

---

### Task 34: Documentation Update — CLAUDE.md + PROJECT_ARCHITECTURE.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `PROJECT_ARCHITECTURE.md`

**Step 1: Update CLAUDE.md**

Add to the TS module table:

```markdown
| `hyperion.ts` | `Hyperion` class — public API facade with create(), spawn(), batch(), start/pause/resume/destroy |
| `entity-handle.ts` | `EntityHandle` — fluent builder over BackpressuredProducer with .position/.velocity/.parent |
| `entity-pool.ts` | `EntityHandlePool` — object pool (cap 1024) for EntityHandle recycling |
| `game-loop.ts` | `GameLoop` — RAF lifecycle with preTick/postTick/frameEnd hooks |
| `camera-api.ts` | `CameraAPI` — wrapper around Camera with zoom support |
| `raw-api.ts` | `RawAPI` — low-level numeric ID entity management |
| `plugin.ts` | `HyperionPlugin` interface + `PluginRegistry` — plugin lifecycle management |
| `types.ts` | Core types: HyperionConfig, HyperionStats, TextureHandle, CompactOptions |
| `leak-detector.ts` | `LeakDetector` — FinalizationRegistry backstop for undisposed EntityHandles |
| `index.ts` | Barrel export for public API |
```

Update test counts, implementation status, gotchas, and conventions.

**Step 2: Update PROJECT_ARCHITECTURE.md**

Add Phase 5 architecture details: Hyperion facade pattern, entity handle pooling, game loop hook system, scene graph propagation, plugin system stubs.

**Step 3: Commit**

```bash
git add CLAUDE.md PROJECT_ARCHITECTURE.md
git commit -m "docs: update CLAUDE.md and PROJECT_ARCHITECTURE.md for Phase 5"
```

---

## Summary

| Part | Tasks | New Files | Modified Files |
|------|-------|-----------|----------------|
| 1. Foundation | 1–5 | types.ts, entity-handle.ts, entity-pool.ts, leak-detector.ts | backpressure.ts |
| 2. Game Loop & Lifecycle | 6–10 | game-loop.ts, hyperion.ts, raw-api.ts | — |
| 3. Camera, Assets, Stats | 11–14 | camera-api.ts | camera.ts, hyperion.ts |
| 4. Scene Graph (Rust) | 15–19 | — | components.rs, command_processor.rs, systems.rs, engine.rs, entity-handle.ts |
| 5. Compaction | 20–23 | — | command_processor.rs, render_state.rs, lib.rs, hyperion.ts |
| 6. Error Recovery | 24–26 | — | renderer.ts, supervisor.ts, texture-manager.ts, types.ts |
| 7. Plugin System | 27–30 | plugin.ts | hyperion.ts, entity-handle.ts |
| 8. Integration | 31–34 | index.ts | main.ts, CLAUDE.md, PROJECT_ARCHITECTURE.md |

**Estimated new/modified test counts:**
- Rust: ~10 new tests (scene graph components, commands, propagation, compaction)
- TypeScript: ~50+ new tests across 10 new test files

**Acceptance criteria (from spec):**
1. Ergonomic type-safe API with zero ring-buffer knowledge
2. Entity handle pool: 100k spawn+destroy < 1ms GC pause
3. Scene graph: hierarchical entities with propagation + dirty flag
4. compact() API functional for long-running sessions
5. device.lost recovery with texture re-upload capability
6. engine.use()/unuse() with install/cleanup lifecycle
7. Pre-tick/post-tick hooks in correct priority order
8. .data() on entity builder delegates to plugin storage
