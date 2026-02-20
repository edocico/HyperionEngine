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

  it('respects max pool size', () => {
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

  it('default max pool size is 1024', () => {
    const pool = new EntityHandlePool();
    expect(pool.maxSize).toBe(1024);
  });
});
