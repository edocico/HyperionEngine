import { describe, it, expect, vi } from 'vitest';
import { EntityHandle } from './entity-handle';
import { ImmediateState } from './immediate-state';
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
    setPrimParams0: vi.fn(() => true),
    setPrimParams1: vi.fn(() => true),
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

  it('fluent mesh returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.mesh(5);
    expect(result).toBe(h);
    expect(p.setMeshHandle).toHaveBeenCalledWith(0, 5);
  });

  it('fluent primitive returns this', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    const result = h.primitive(2);
    expect(result).toBe(h);
    expect(p.setRenderPrimitive).toHaveBeenCalledWith(0, 2);
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

  it('data() stores and retrieves plugin data', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    expect(h.data('physics')).toBeUndefined();
    const result = h.data('physics', { mass: 10 });
    expect(result).toBe(h); // fluent setter
    expect(h.data('physics')).toEqual({ mass: 10 });
  });

  it('init() clears plugin data', () => {
    const p = mockProducer();
    const h = new EntityHandle(0, p);
    h.data('physics', { mass: 10 });
    expect(h.data('physics')).toEqual({ mass: 10 });
    h.init(99, p);
    expect(h.data('physics')).toBeUndefined();
  });

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

  describe('immediate mode', () => {
    it('positionImmediate sends setPosition to producer', () => {
      const p = mockProducer();
      const imm = new ImmediateState();
      const h = new EntityHandle(7, p, imm);
      const result = h.positionImmediate(10, 20, 30);
      expect(result).toBe(h); // fluent
      expect(p.setPosition).toHaveBeenCalledWith(7, 10, 20, 30);
    });

    it('positionImmediate updates immediate state', () => {
      const p = mockProducer();
      const imm = new ImmediateState();
      const h = new EntityHandle(7, p, imm);
      h.positionImmediate(10, 20, 30);
      expect(imm.has(7)).toBe(true);
      expect(imm.get(7)).toEqual([10, 20, 30]);
    });

    it('positionImmediate works without immediate state (optional)', () => {
      const p = mockProducer();
      const h = new EntityHandle(7, p); // no ImmediateState
      expect(() => h.positionImmediate(1, 2, 3)).not.toThrow();
      expect(p.setPosition).toHaveBeenCalledWith(7, 1, 2, 3);
    });

    it('clearImmediate removes override', () => {
      const p = mockProducer();
      const imm = new ImmediateState();
      const h = new EntityHandle(7, p, imm);
      h.positionImmediate(10, 20, 30);
      expect(imm.has(7)).toBe(true);
      const result = h.clearImmediate();
      expect(result).toBe(h); // fluent
      expect(imm.has(7)).toBe(false);
    });

    it('destroy clears immediate state', () => {
      const p = mockProducer();
      const imm = new ImmediateState();
      const h = new EntityHandle(7, p, imm);
      h.positionImmediate(10, 20, 30);
      expect(imm.has(7)).toBe(true);
      h.destroy();
      expect(imm.has(7)).toBe(false);
    });

    it('positionImmediate throws after destroy', () => {
      const p = mockProducer();
      const imm = new ImmediateState();
      const h = new EntityHandle(7, p, imm);
      h.destroy();
      expect(() => h.positionImmediate(1, 2, 3)).toThrow('destroyed');
    });

    it('clearImmediate throws after destroy', () => {
      const p = mockProducer();
      const imm = new ImmediateState();
      const h = new EntityHandle(7, p, imm);
      h.destroy();
      expect(() => h.clearImmediate()).toThrow('destroyed');
    });
  });

  describe('primitive params', () => {
    it('line() sets render primitive and params', () => {
      const p = mockProducer();
      const h = new EntityHandle(1, p);
      const result = h.line(0, 0, 100, 100, 2);
      expect(result).toBe(h);
      expect(p.setRenderPrimitive).toHaveBeenCalledWith(1, 1); // Line = 1
      expect(p.setPrimParams0).toHaveBeenCalledWith(1, 0, 0, 100, 100);
      expect(p.setPrimParams1).toHaveBeenCalledWith(1, 2, 0, 0, 0);
    });

    it('gradient() sets render primitive and params', () => {
      const p = mockProducer();
      const h = new EntityHandle(1, p);
      const result = h.gradient(0, 45, [0, 1, 0, 0, 0.5, 0]);
      expect(result).toBe(h);
      expect(p.setRenderPrimitive).toHaveBeenCalledWith(1, 4); // Gradient = 4
      expect(p.setPrimParams0).toHaveBeenCalledWith(1, 0, 45, 0, 1);
      expect(p.setPrimParams1).toHaveBeenCalledWith(1, 0, 0, 0.5, 0);
    });

    it('boxShadow() sets render primitive and params', () => {
      const p = mockProducer();
      const h = new EntityHandle(1, p);
      const result = h.boxShadow(100, 80, 8, 20, 0, 0, 0, 0.5);
      expect(result).toBe(h);
      expect(p.setRenderPrimitive).toHaveBeenCalledWith(1, 5); // BoxShadow = 5
      expect(p.setPrimParams0).toHaveBeenCalledWith(1, 100, 80, 8, 20);
      expect(p.setPrimParams1).toHaveBeenCalledWith(1, 0, 0, 0, 0.5);
    });

    it('line() throws after destroy', () => {
      const p = mockProducer();
      const h = new EntityHandle(1, p);
      h.destroy();
      expect(() => h.line(0, 0, 100, 100, 2)).toThrow('destroyed');
    });
  });
});
