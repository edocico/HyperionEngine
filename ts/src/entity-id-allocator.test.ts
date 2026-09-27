import { describe, it, expect } from 'vitest';
import { EntityIdAllocator } from './entity-id-allocator';
import { MAX_EXTERNAL_ID } from './types';

/**
 * Frees `id` and walks it through the whole quarantine: its despawn is written
 * into tick `seq`, that tick is processed at fixed-tick count `tick`, and a
 * later tick advances the count. Returns what the last advance released.
 */
function quarantineThrough(ids: EntityIdAllocator, id: number, seq: number, tick: number): number[] {
  ids.free(id);
  ids.written(id, seq);
  ids.advance(seq, tick);
  return ids.advance(seq + 1, tick + 1);
}

describe('EntityIdAllocator', () => {
  it('hands out fresh ids in order from 0, up to MAX_EXTERNAL_ID by default', () => {
    const ids = new EntityIdAllocator();
    expect([ids.allocate('handle'), ids.allocate('raw'), ids.allocate('handle')]).toEqual([0, 1, 2]);
    expect(ids.maxId).toBe(MAX_EXTERNAL_ID);
  });

  it('prefers fresh ids: a released id is not reused while fresh ones remain', () => {
    const ids = new EntityIdAllocator(3);
    const a = ids.allocate('handle');
    expect(quarantineThrough(ids, a, 1, 10)).toEqual([a]);
    expect(ids.allocate('handle')).toBe(1);
  });

  it('once the fresh ids run out, reuses released ids in FIFO order', () => {
    const ids = new EntityIdAllocator(3);
    for (let i = 0; i <= 3; i++) ids.allocate('handle');
    ids.free(2);
    ids.free(0);
    ids.written(2, 1);
    ids.written(0, 1);
    ids.advance(1, 10);
    expect(ids.advance(2, 11)).toEqual([2, 0]);
    expect([ids.allocate('handle'), ids.allocate('handle')]).toEqual([2, 0]);
  });

  it('reports whether the next id is a fresh one', () => {
    const ids = new EntityIdAllocator(0);
    expect(ids.hasFreshIds).toBe(true);
    ids.allocate('handle');
    expect(ids.hasFreshIds).toBe(false);
  });

  it('throws once every id is live or in quarantine', () => {
    const ids = new EntityIdAllocator(1);
    ids.allocate('handle');
    ids.allocate('handle');
    ids.free(0);
    expect(() => ids.allocate('handle')).toThrow(/id space exhausted/);
  });

  it('never releases an id whose despawn has not been written', () => {
    const ids = new EntityIdAllocator(3);
    const a = ids.allocate('handle');
    ids.free(a);
    ids.advance(100, 1000);
    expect(ids.advance(101, 1001)).toEqual([]);
    expect(ids.isQuarantined(a)).toBe(true);
  });

  it('releases only after the consuming tick is processed AND a later fixed tick ran', () => {
    const ids = new EntityIdAllocator(3);
    const a = ids.allocate('handle');
    ids.free(a);
    ids.written(a, 5);
    expect(ids.advance(4, 100)).toEqual([]); // tick 5 not processed yet
    expect(ids.advance(5, 100)).toEqual([]); // processed now, at fixed tick 100
    expect(ids.advance(6, 100)).toEqual([]); // a frame with no fixed tick
    expect(ids.advance(7, 101)).toEqual([a]);
    expect(ids.isQuarantined(a)).toBe(false);
  });

  it('frees only live ids: a double free or a never-allocated id is a no-op', () => {
    const ids = new EntityIdAllocator(1);
    const a = ids.allocate('raw');
    expect(ids.free(a)).toBe(true);
    expect(ids.free(a)).toBe(false);
    expect(ids.free(1)).toBe(false);
    ids.written(a, 1);
    ids.written(a, 1);
    ids.advance(1, 1);
    expect(ids.advance(2, 2)).toEqual([a]);
    ids.allocate('raw'); // the fresh 1
    expect(ids.allocate('raw')).toBe(a);
    expect(() => ids.allocate('raw')).toThrow(/id space exhausted/);
  });

  it('ignores a written despawn for an id it did not free', () => {
    const ids = new EntityIdAllocator(3);
    const a = ids.allocate('handle');
    ids.written(a, 1);
    ids.advance(1, 1);
    expect(ids.advance(2, 2)).toEqual([]);
    expect(ids.isLive(a)).toBe(true);
  });

  it('tracks who owns a live id', () => {
    const ids = new EntityIdAllocator(3);
    const h = ids.allocate('handle');
    const r = ids.allocate('raw');
    expect([ids.ownerOf(h), ids.ownerOf(r), ids.ownerOf(2)]).toEqual(['handle', 'raw', null]);
    ids.free(h);
    expect(ids.ownerOf(h)).toBeNull();
    expect(ids.isLive(h)).toBe(false);
    expect(ids.isQuarantined(h)).toBe(true);
  });

  it('keeps the FIFO order across several advances', () => {
    const ids = new EntityIdAllocator(9);
    for (let i = 0; i <= 9; i++) ids.allocate('handle');
    ids.free(4);
    ids.written(4, 1);
    ids.advance(1, 10);
    ids.free(1);
    ids.written(1, 2);
    expect(ids.advance(2, 11)).toEqual([4]);
    expect(ids.advance(3, 12)).toEqual([1]);
    expect([ids.allocate('raw'), ids.allocate('raw')]).toEqual([4, 1]);
  });
});
