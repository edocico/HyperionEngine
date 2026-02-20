import { describe, it, expect } from 'vitest';
import { SelectionManager } from './selection';

describe('SelectionManager', () => {
  it('should track selected entities', () => {
    const sm = new SelectionManager(100);
    sm.select(5);
    sm.select(10);
    expect(sm.isSelected(5)).toBe(true);
    expect(sm.isSelected(10)).toBe(true);
    expect(sm.isSelected(3)).toBe(false);
    expect(sm.count).toBe(2);
  });

  it('should deselect entities', () => {
    const sm = new SelectionManager(100);
    sm.select(5);
    sm.deselect(5);
    expect(sm.isSelected(5)).toBe(false);
    expect(sm.count).toBe(0);
  });

  it('should clear all selections', () => {
    const sm = new SelectionManager(100);
    sm.select(1);
    sm.select(2);
    sm.select(3);
    sm.clear();
    expect(sm.count).toBe(0);
  });

  it('should handle duplicate select calls', () => {
    const sm = new SelectionManager(100);
    sm.select(5);
    sm.select(5);
    expect(sm.count).toBe(1);
  });

  it('should handle deselect of non-selected entity', () => {
    const sm = new SelectionManager(100);
    sm.deselect(99);
    expect(sm.count).toBe(0);
  });

  it('should toggle selection state', () => {
    const sm = new SelectionManager(100);
    const first = sm.toggle(5);
    expect(first).toBe(true);
    expect(sm.isSelected(5)).toBe(true);

    const second = sm.toggle(5);
    expect(second).toBe(false);
    expect(sm.isSelected(5)).toBe(false);
  });

  it('should track dirty state', () => {
    const sm = new SelectionManager(100);
    // Fresh manager is not dirty
    expect(sm.isDirty).toBe(false);

    sm.select(1);
    expect(sm.isDirty).toBe(true);
  });

  it('should iterate over selected IDs', () => {
    const sm = new SelectionManager(100);
    sm.select(3);
    sm.select(7);
    sm.select(11);

    const ids = new Set<number>();
    for (const id of sm.selectedIds) {
      ids.add(id);
    }
    expect(ids).toEqual(new Set([3, 7, 11]));
  });

  it('should clean up on destroy', () => {
    const sm = new SelectionManager(100);
    sm.select(1);
    sm.select(2);
    sm.destroy();
    expect(sm.count).toBe(0);
    expect(sm.isDirty).toBe(false);
  });

  it('clear on empty set should be no-op (not dirty)', () => {
    const sm = new SelectionManager(100);
    sm.clear();
    expect(sm.isDirty).toBe(false);
  });
});
