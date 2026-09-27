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

  it('deselecting an id that is not selected leaves the mask clean (no 400 KB re-upload)', () => {
    const sm = new SelectionManager(100);
    sm.select(5);
    sm.uploadMask({ queue: { writeBuffer() {} } } as unknown as GPUDevice, {} as GPUBuffer);
    sm.deselect(7);
    expect(sm.isDirty).toBe(false);
    sm.deselect(5);
    expect(sm.isDirty).toBe(true);
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

describe('SelectionManager mask by GPU slot', () => {
  /** A device that records each mask upload as a plain array. */
  function recorder() {
    const uploads: number[][] = [];
    const device = {
      queue: {
        writeBuffer: (_b: unknown, _o: number, data: Uint32Array, dataOffset = 0, size?: number) => {
          uploads.push(Array.from(data.subarray(dataOffset, dataOffset + (size ?? data.length))));
        },
      },
    } as unknown as GPUDevice;
    return { uploads, device };
  }

  it('marks the SLOT that holds a selected entity (selection-seed.wgsl reads the mask by slot)', () => {
    const { uploads, device } = recorder();
    const sm = new SelectionManager(100);
    sm.select(7);
    sm.uploadMask(device, {} as GPUBuffer, new Uint32Array([5, 9, 7]), 3);
    expect(uploads.at(-1)).toEqual([0, 0, 1]);
  });

  it('follows a slot change without a selection change', () => {
    const { uploads, device } = recorder();
    const sm = new SelectionManager(100);
    sm.select(7);
    sm.uploadMask(device, {} as GPUBuffer, new Uint32Array([5, 9, 7]), 3);
    sm.uploadMask(device, {} as GPUBuffer, new Uint32Array([7, 5]), 2);
    expect(uploads.at(-1)).toEqual([1, 0]);
  });

  it('with nothing selected, clears the mask once and then uploads nothing', () => {
    const { uploads, device } = recorder();
    const sm = new SelectionManager(100);
    sm.select(7);
    sm.uploadMask(device, {} as GPUBuffer, new Uint32Array([7]), 1);
    sm.deselect(7);
    sm.uploadMask(device, {} as GPUBuffer, new Uint32Array([7]), 1);
    expect(uploads.at(-1)!.every((v) => v === 0)).toBe(true);
    const before = uploads.length;
    sm.uploadMask(device, {} as GPUBuffer, new Uint32Array([7]), 1);
    expect(uploads.length).toBe(before);
  });
});
