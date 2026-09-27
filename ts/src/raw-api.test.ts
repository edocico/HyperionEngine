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
    expect(p.spawnEntity).toHaveBeenCalledWith(0, false);
  });

  it('spawn({ mode: "2d" }) spawns a Transform2D entity', () => {
    const p = mockProducer();
    const raw = new RawAPI(p, () => 4);
    raw.spawn({ mode: '2d' });
    expect(p.spawnEntity).toHaveBeenCalledWith(4, true);
  });

  it('spawn rejects an unknown mode before allocating an id', () => {
    const p = mockProducer();
    const allocate = vi.fn(() => 4);
    const raw = new RawAPI(p, allocate);
    expect(() => raw.spawn({ mode: '4d' as never })).toThrow(/mode/);
    expect(allocate).not.toHaveBeenCalled();
    expect(p.spawnEntity).not.toHaveBeenCalled();
  });

  it('z is optional: setPosition/setVelocity default 0, setScale sz 1', () => {
    const p = mockProducer();
    const raw = new RawAPI(p, () => 0);
    raw.setPosition(0, 1, 2);
    raw.setVelocity(0, 3, 4);
    raw.setScale(0, 2, 3);
    expect(p.setPosition).toHaveBeenCalledWith(0, 1, 2, 0);
    expect(p.setVelocity).toHaveBeenCalledWith(0, 3, 4, 0);
    expect(p.setScale).toHaveBeenCalledWith(0, 2, 3, 1);
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

describe('RawAPI with id hooks (id reuse)', () => {
  function hooks(live: Set<number>) {
    let next = 0;
    return {
      allocate: vi.fn(() => { const id = next++; live.add(id); return id; }),
      release: vi.fn((id: number) => live.delete(id)),
      isLive: (id: number) => live.has(id),
    };
  }

  it('despawn sends the command only when the id was released', () => {
    const p = mockProducer();
    const live = new Set<number>();
    const raw = new RawAPI(p, hooks(live));
    const id = raw.spawn();
    raw.despawn(id);
    raw.despawn(id);
    raw.despawn(99);
    expect(p.despawnEntity).toHaveBeenCalledTimes(1);
    expect(p.despawnEntity).toHaveBeenCalledWith(id);
  });

  it('drops setters addressed to an id that is not live', () => {
    const p = mockProducer();
    const live = new Set<number>();
    const raw = new RawAPI(p, hooks(live));
    const id = raw.spawn();
    raw.setPosition(id, 1, 2, 3);
    raw.despawn(id);
    raw.setPosition(id, 4, 5, 6);
    raw.setVelocity(id, 1, 1, 1);
    raw.setParent(id, 0);
    expect(p.setPosition).toHaveBeenCalledTimes(1);
    expect(p.setVelocity).not.toHaveBeenCalled();
    expect(p.setParent).not.toHaveBeenCalled();
  });
});
