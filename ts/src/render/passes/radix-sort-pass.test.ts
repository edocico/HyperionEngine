import { describe, it, expect } from 'vitest';
import {
  floatToSortKey,
  makeTransparentSortKey,
  cpuRadixSort,
  RadixSortPass,
} from './radix-sort-pass';

describe('RadixSortPass', () => {
  describe('floatToSortKey', () => {
    it('preserves order for positive floats', () => {
      expect(floatToSortKey(0.5)).toBeLessThan(floatToSortKey(1.0));
      expect(floatToSortKey(1.0)).toBeLessThan(floatToSortKey(2.0));
      expect(floatToSortKey(2.0)).toBeLessThan(floatToSortKey(100.0));
    });

    it('preserves order for negative floats', () => {
      expect(floatToSortKey(-100.0)).toBeLessThan(floatToSortKey(-2.0));
      expect(floatToSortKey(-2.0)).toBeLessThan(floatToSortKey(-1.0));
      expect(floatToSortKey(-1.0)).toBeLessThan(floatToSortKey(-0.5));
    });

    it('handles negative to positive transition', () => {
      expect(floatToSortKey(-1.0)).toBeLessThan(floatToSortKey(0.0));
      expect(floatToSortKey(0.0)).toBeLessThan(floatToSortKey(1.0));
      expect(floatToSortKey(-0.001)).toBeLessThan(floatToSortKey(0.001));
    });

    it('handles zero', () => {
      const key = floatToSortKey(0.0);
      expect(key).toBeLessThan(floatToSortKey(0.001));
      expect(key).toBeGreaterThan(floatToSortKey(-0.001));
    });

    it('returns a non-negative u32', () => {
      expect(floatToSortKey(1.0)).toBeGreaterThanOrEqual(0);
      expect(floatToSortKey(-1.0)).toBeGreaterThanOrEqual(0);
      expect(floatToSortKey(0.0)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('makeTransparentSortKey', () => {
    it('groups by primitive type first', () => {
      const key0 = makeTransparentSortKey(0, 5.0);
      const key1 = makeTransparentSortKey(1, 5.0);
      const key2 = makeTransparentSortKey(2, 5.0);
      expect(key0).toBeLessThan(key1);
      expect(key1).toBeLessThan(key2);
    });

    it('sorts back-to-front within same type (descending depth)', () => {
      // Larger depth = farther away = should sort first (smaller key)
      const keyFar = makeTransparentSortKey(0, 100.0);
      const keyNear = makeTransparentSortKey(0, 1.0);
      expect(keyFar).toBeLessThan(keyNear); // far objects first = back-to-front
    });

    it('handles depth ordering across a range of values', () => {
      const keys = [1.0, 5.0, 10.0, 50.0, 100.0].map(d => makeTransparentSortKey(0, d));
      // Back-to-front: 100 < 50 < 10 < 5 < 1
      for (let i = 0; i < keys.length - 1; i++) {
        expect(keys[i]).toBeGreaterThan(keys[i + 1]);
      }
    });

    it('handles negative depths correctly', () => {
      const keyNeg = makeTransparentSortKey(0, -5.0);
      const keyPos = makeTransparentSortKey(0, 5.0);
      // +5 is farther in the positive direction, so in descending order
      // it should sort first (smaller key)
      expect(keyPos).toBeLessThan(keyNeg);
    });

    it('primitive type takes priority over depth', () => {
      // Type 1 at depth 1000 should still sort after type 0 at depth 0.001
      const key0near = makeTransparentSortKey(0, 0.001);
      const key1far = makeTransparentSortKey(1, 1000.0);
      expect(key0near).toBeLessThan(key1far);
    });

    it('returns a non-negative u32', () => {
      expect(makeTransparentSortKey(0, 1.0)).toBeGreaterThanOrEqual(0);
      expect(makeTransparentSortKey(5, -10.0)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('cpuRadixSort', () => {
    it('sorts empty arrays', () => {
      const result = cpuRadixSort(new Uint32Array(0), new Uint32Array(0));
      expect(result.keys.length).toBe(0);
      expect(result.vals.length).toBe(0);
    });

    it('sorts a single element', () => {
      const result = cpuRadixSort(new Uint32Array([42]), new Uint32Array([7]));
      expect(Array.from(result.keys)).toEqual([42]);
      expect(Array.from(result.vals)).toEqual([7]);
    });

    it('sorts keys in ascending order and carries values', () => {
      const keys = new Uint32Array([300, 100, 200]);
      const vals = new Uint32Array([0, 1, 2]);
      const result = cpuRadixSort(keys, vals);
      expect(Array.from(result.keys)).toEqual([100, 200, 300]);
      expect(Array.from(result.vals)).toEqual([1, 2, 0]);
    });

    it('handles duplicate keys (stable sort)', () => {
      const keys = new Uint32Array([5, 5, 5, 5]);
      const vals = new Uint32Array([10, 20, 30, 40]);
      const result = cpuRadixSort(keys, vals);
      expect(Array.from(result.keys)).toEqual([5, 5, 5, 5]);
      // Radix sort is stable — values should stay in original order
      expect(Array.from(result.vals)).toEqual([10, 20, 30, 40]);
    });

    it('sorts large key values spanning all 32 bits', () => {
      const keys = new Uint32Array([0xFFFFFFFF, 0x00000001, 0x80000000, 0x00000000]);
      const vals = new Uint32Array([0, 1, 2, 3]);
      const result = cpuRadixSort(keys, vals);
      expect(Array.from(result.keys)).toEqual([0x00000000, 0x00000001, 0x80000000, 0xFFFFFFFF]);
      expect(Array.from(result.vals)).toEqual([3, 1, 2, 0]);
    });

    it('correctly sorts transparent sort keys for back-to-front order', () => {
      // Simulate 4 transparent entities at different depths, 2 primitive types
      const depths = [10.0, 1.0, 50.0, 5.0];
      const types = [0, 1, 0, 1];
      const keys = new Uint32Array(4);
      const vals = new Uint32Array(4);
      for (let i = 0; i < 4; i++) {
        keys[i] = makeTransparentSortKey(types[i], depths[i]);
        vals[i] = i; // entity index
      }

      const result = cpuRadixSort(keys, vals);

      // Expected order: type 0 back-to-front, then type 1 back-to-front
      // Type 0: depth 50 (idx 2), depth 10 (idx 0)
      // Type 1: depth 5 (idx 3), depth 1 (idx 1)
      expect(Array.from(result.vals)).toEqual([2, 0, 3, 1]);
    });
  });

  describe('class structure', () => {
    it('declares correct read/write resources', () => {
      const pass = new RadixSortPass();
      expect(pass.name).toBe('radix-sort');
      expect(pass.reads).toContain('transparent-keys');
      expect(pass.reads).toContain('transparent-vals-in');
      expect(pass.writes).toContain('transparent-vals-sorted');
      expect(pass.optional).toBe(true);
    });

    it('computes correct workgroup count', () => {
      expect(RadixSortPass.workgroupCount(0)).toBe(0);
      expect(RadixSortPass.workgroupCount(1)).toBe(1);
      expect(RadixSortPass.workgroupCount(256)).toBe(1);
      expect(RadixSortPass.workgroupCount(257)).toBe(2);
      expect(RadixSortPass.workgroupCount(1000)).toBe(4);
      expect(RadixSortPass.workgroupCount(5000)).toBe(20);
    });

    it('has correct static constants', () => {
      expect(RadixSortPass.RADIX_PASSES).toBe(4);
      expect(RadixSortPass.HISTOGRAM_BUCKETS).toBe(256);
      expect(RadixSortPass.WORKGROUP_SIZE).toBe(256);
    });
  });
});
