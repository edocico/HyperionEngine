import { describe, it, expect } from 'vitest';
import { ImmediateState } from './immediate-state';

describe('ImmediateState', () => {
  it('starts empty', () => {
    const state = new ImmediateState();
    expect(state.count).toBe(0);
    expect(state.has(1)).toBe(false);
    expect(state.get(1)).toBeUndefined();
  });

  it('stores and retrieves position override', () => {
    const state = new ImmediateState();
    state.set(42, 1.5, 2.5, 3.5);
    expect(state.count).toBe(1);
    expect(state.has(42)).toBe(true);
    expect(state.get(42)).toEqual([1.5, 2.5, 3.5]);
  });

  it('overwrites existing override', () => {
    const state = new ImmediateState();
    state.set(10, 1, 2, 3);
    state.set(10, 4, 5, 6);
    expect(state.count).toBe(1);
    expect(state.get(10)).toEqual([4, 5, 6]);
  });

  it('clears a single entity override', () => {
    const state = new ImmediateState();
    state.set(10, 1, 2, 3);
    state.set(20, 4, 5, 6);
    state.clear(10);
    expect(state.count).toBe(1);
    expect(state.has(10)).toBe(false);
    expect(state.has(20)).toBe(true);
  });

  it('clears all overrides', () => {
    const state = new ImmediateState();
    state.set(10, 1, 2, 3);
    state.set(20, 4, 5, 6);
    state.set(30, 7, 8, 9);
    state.clearAll();
    expect(state.count).toBe(0);
    expect(state.has(10)).toBe(false);
    expect(state.has(20)).toBe(false);
    expect(state.has(30)).toBe(false);
  });

  it('patchTransforms modifies transform buffer at correct offsets', () => {
    const state = new ImmediateState();
    // 2 entities, each with a 4x4 identity matrix (column-major)
    const transforms = new Float32Array(2 * 16);
    // Set identity matrices
    for (let e = 0; e < 2; e++) {
      const base = e * 16;
      transforms[base + 0] = 1; // m00
      transforms[base + 5] = 1; // m11
      transforms[base + 10] = 1; // m22
      transforms[base + 15] = 1; // m33
      // Column 3 (translation) starts at offset 12
      transforms[base + 12] = 0;
      transforms[base + 13] = 0;
      transforms[base + 14] = 0;
    }

    const entityIds = new Uint32Array([10, 20]);

    // Override entity 20 to position (7, 8, 9)
    state.set(20, 7, 8, 9);

    state.patchTransforms(transforms, entityIds, 2);

    // Entity 10 (index 0) should be unchanged
    expect(transforms[0 * 16 + 12]).toBe(0);
    expect(transforms[0 * 16 + 13]).toBe(0);
    expect(transforms[0 * 16 + 14]).toBe(0);

    // Entity 20 (index 1) should have overridden position
    expect(transforms[1 * 16 + 12]).toBe(7);
    expect(transforms[1 * 16 + 13]).toBe(8);
    expect(transforms[1 * 16 + 14]).toBe(9);

    // Rest of the identity matrix for entity 20 should be intact
    expect(transforms[1 * 16 + 0]).toBe(1); // m00
    expect(transforms[1 * 16 + 5]).toBe(1); // m11
    expect(transforms[1 * 16 + 10]).toBe(1); // m22
    expect(transforms[1 * 16 + 15]).toBe(1); // m33
  });

  it('patchTransforms skips entities not in SoA', () => {
    const state = new ImmediateState();
    // 2 entities
    const transforms = new Float32Array(2 * 16);
    // Set known values at translation columns
    transforms[0 * 16 + 12] = 100;
    transforms[0 * 16 + 13] = 200;
    transforms[0 * 16 + 14] = 300;
    transforms[1 * 16 + 12] = 400;
    transforms[1 * 16 + 13] = 500;
    transforms[1 * 16 + 14] = 600;

    const entityIds = new Uint32Array([10, 20]);

    // Override entity 999 which is NOT in the SoA
    state.set(999, 7, 8, 9);

    state.patchTransforms(transforms, entityIds, 2);

    // All original values should be unchanged — no corruption
    expect(transforms[0 * 16 + 12]).toBe(100);
    expect(transforms[0 * 16 + 13]).toBe(200);
    expect(transforms[0 * 16 + 14]).toBe(300);
    expect(transforms[1 * 16 + 12]).toBe(400);
    expect(transforms[1 * 16 + 13]).toBe(500);
    expect(transforms[1 * 16 + 14]).toBe(600);
  });
});
