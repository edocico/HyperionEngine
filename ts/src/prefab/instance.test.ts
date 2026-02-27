import { describe, it, expect, vi } from 'vitest';
import { PrefabInstance } from './instance';
import type { EntityHandle } from '../entity-handle';

function mockHandle(id: number): EntityHandle {
  return {
    id,
    alive: true,
    position: vi.fn().mockReturnThis(),
    velocity: vi.fn().mockReturnThis(),
    rotation: vi.fn().mockReturnThis(),
    scale: vi.fn().mockReturnThis(),
    texture: vi.fn().mockReturnThis(),
    mesh: vi.fn().mockReturnThis(),
    primitive: vi.fn().mockReturnThis(),
    parent: vi.fn().mockReturnThis(),
    unparent: vi.fn().mockReturnThis(),
    data: vi.fn().mockReturnThis(),
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
}

describe('PrefabInstance', () => {
  it('exposes root handle', () => {
    const root = mockHandle(10);
    const inst = new PrefabInstance('ship', root, new Map());
    expect(inst.root).toBe(root);
  });

  it('returns named child by key', () => {
    const root = mockHandle(10);
    const turret = mockHandle(11);
    const children = new Map([['turret', turret]]);
    const inst = new PrefabInstance('ship', root, children);
    expect(inst.child('turret')).toBe(turret);
  });

  it('returns undefined for unknown child key', () => {
    const root = mockHandle(10);
    const inst = new PrefabInstance('ship', root, new Map());
    expect(inst.child('nonexistent')).toBeUndefined();
  });

  it('moveTo delegates to root.position', () => {
    const root = mockHandle(10);
    const inst = new PrefabInstance('ship', root, new Map());
    inst.moveTo(5, 7);
    expect(root.position).toHaveBeenCalledWith(5, 7, 0);
  });

  it('moveTo preserves z from constructor', () => {
    const root = mockHandle(10);
    const inst = new PrefabInstance('ship', root, new Map(), 42);
    inst.moveTo(1, 2);
    expect(root.position).toHaveBeenCalledWith(1, 2, 42);
  });

  it('destroyAll destroys root and all children', () => {
    const root = mockHandle(10);
    const c1 = mockHandle(11);
    const c2 = mockHandle(12);
    const children = new Map([['a', c1], ['b', c2]]);
    const inst = new PrefabInstance('ship', root, children);
    inst.destroyAll();
    expect(root.destroy).toHaveBeenCalled();
    expect(c1.destroy).toHaveBeenCalled();
    expect(c2.destroy).toHaveBeenCalled();
  });

  it('destroyAll destroys children before root', () => {
    const order: string[] = [];
    const root = mockHandle(10);
    (root.destroy as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('root'));
    const c1 = mockHandle(11);
    (c1.destroy as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('child'));
    const children = new Map([['a', c1]]);
    const inst = new PrefabInstance('ship', root, children);
    inst.destroyAll();
    expect(order).toEqual(['child', 'root']);
  });

  it('lists child keys', () => {
    const root = mockHandle(10);
    const children = new Map([['turret', mockHandle(11)], ['shield', mockHandle(12)]]);
    const inst = new PrefabInstance('ship', root, children);
    expect(inst.childNames).toEqual(['turret', 'shield']);
  });
});
