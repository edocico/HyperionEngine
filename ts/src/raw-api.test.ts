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
