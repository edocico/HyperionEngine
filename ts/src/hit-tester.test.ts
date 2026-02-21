import { describe, it, expect } from 'vitest';
import { Ray, hitTestRay } from './hit-tester';

describe('hitTestRay', () => {
  // Helper: orthographic ray straight down -Z at (x, y)
  function orthoRay(x: number, y: number): Ray {
    return { origin: [x, y, 100], direction: [0, 0, -1] };
  }

  it('returns null when no entities', () => {
    const bounds = new Float32Array(0);
    const entityIds = new Uint32Array(0);
    expect(hitTestRay(orthoRay(0, 0), bounds, entityIds)).toBe(null);
  });

  it('returns entityId when ray hits bounding sphere', () => {
    const bounds = new Float32Array([5, 5, 0, 2]);
    const entityIds = new Uint32Array([42]);
    const result = hitTestRay(orthoRay(5, 5), bounds, entityIds);
    expect(result).toBe(42);
  });

  it('returns null when ray misses all bounding spheres', () => {
    // Sphere at (5, 5, 0) r=1 — ray at (0, 0) is far away
    const bounds = new Float32Array([5, 5, 0, 1]);
    const entityIds = new Uint32Array([42]);
    expect(hitTestRay(orthoRay(0, 0), bounds, entityIds)).toBe(null);
  });

  it('returns closest entity along ray (smallest t)', () => {
    // Entity A at z=0, Entity B at z=5 — ray from z=100 hits B first (higher z = closer to origin)
    const bounds = new Float32Array([5, 5, 0, 3, 5, 5, 5, 3]);
    const entityIds = new Uint32Array([10, 20]);
    expect(hitTestRay(orthoRay(5, 5), bounds, entityIds)).toBe(20);
  });

  it('handles edge case: ray tangent to sphere', () => {
    // Sphere at (1, 0, 0) r=1 — ray at (0, 0) going -Z is tangent (distance to center = 1 = r)
    const bounds = new Float32Array([1, 0, 0, 1]);
    const entityIds = new Uint32Array([99]);
    const result = hitTestRay(orthoRay(0, 0), bounds, entityIds);
    // Tangent: discriminant = 0, single intersection point
    expect(result).toBe(99);
  });

  it('handles non-axis-aligned rays (future 3D perspective)', () => {
    // Sphere at (10, 0, -10) r=2, ray from origin pointing (1, 0, -1) normalized
    const bounds = new Float32Array([10, 0, -10, 2]);
    const entityIds = new Uint32Array([77]);
    const d = Math.SQRT1_2;
    const ray: Ray = { origin: [0, 0, 0], direction: [d, 0, -d] };
    expect(hitTestRay(ray, bounds, entityIds)).toBe(77);
  });

  it('returns null for ray pointing away from sphere', () => {
    // Sphere at (0, 0, -10), ray at origin pointing +Z (away from sphere)
    const bounds = new Float32Array([0, 0, -10, 2]);
    const entityIds = new Uint32Array([55]);
    const ray: Ray = { origin: [0, 0, 0], direction: [0, 0, 1] };
    expect(hitTestRay(ray, bounds, entityIds)).toBe(null);
  });

  it('handles 10k entities efficiently', () => {
    // Spread 10k entities along X axis, hit the one at x=5000
    const count = 10000;
    const bounds = new Float32Array(count * 4);
    const entityIds = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      bounds[i * 4] = i * 10;
      bounds[i * 4 + 1] = 0;
      bounds[i * 4 + 2] = 0;
      bounds[i * 4 + 3] = 1;
      entityIds[i] = i;
    }
    expect(hitTestRay(orthoRay(5000, 0), bounds, entityIds)).toBe(500);
  });
});
