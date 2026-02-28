import { describe, it, expect } from 'vitest';
import { SpatialGrid } from './spatial-grid';

describe('SpatialGrid', () => {
  function makeBounds(entities: Array<[number, number, number, number]>): Float32Array {
    const b = new Float32Array(entities.length * 4);
    for (let i = 0; i < entities.length; i++) {
      b[i * 4] = entities[i][0];
      b[i * 4 + 1] = entities[i][1];
      b[i * 4 + 2] = entities[i][2];
      b[i * 4 + 3] = entities[i][3];
    }
    return b;
  }

  it('returns empty candidates for empty grid', () => {
    const grid = new SpatialGrid(1024);
    grid.rebuild(new Float32Array(0), 0);
    const result = grid.query(0, 0);
    expect(result.count).toBe(0);
  });

  it('finds entity at query position', () => {
    const grid = new SpatialGrid(1024);
    const bounds = makeBounds([[100, 200, 0, 10]]);
    grid.rebuild(bounds, 1);
    const result = grid.query(100, 200);
    expect(result.count).toBeGreaterThan(0);
    const indices = Array.from(result.indices.subarray(0, result.count));
    expect(indices).toContain(0);
  });

  it('does not find entity far from query position', () => {
    const grid = new SpatialGrid(1024);
    const bounds = makeBounds([[100, 200, 0, 10]]);
    grid.rebuild(bounds, 1);
    const result = grid.query(5000, 5000);
    const indices = Array.from(result.indices.subarray(0, result.count));
    expect(indices).not.toContain(0);
  });

  it('finds entity straddling cell boundary via 3x3 neighborhood', () => {
    const grid = new SpatialGrid(64);
    const bounds = makeBounds([[50, 50, 0, 40]]);
    grid.rebuild(bounds, 1);
    const result = grid.query(85, 50);
    const indices = Array.from(result.indices.subarray(0, result.count));
    expect(indices).toContain(0);
  });

  it('skips entities with zero radius', () => {
    const grid = new SpatialGrid(1024);
    const bounds = makeBounds([[100, 100, 0, 0], [200, 200, 0, 10]]);
    grid.rebuild(bounds, 2);
    const result = grid.query(100, 100);
    const indices = Array.from(result.indices.subarray(0, result.count));
    expect(indices).not.toContain(0);
  });

  it('handles many entities without throwing', () => {
    const grid = new SpatialGrid(4096);
    const count = 1000;
    const entities: Array<[number, number, number, number]> = [];
    for (let i = 0; i < count; i++) {
      entities.push([i * 10, (i % 100) * 10, 0, 5]);
    }
    grid.rebuild(makeBounds(entities), count);
    const result = grid.query(500, 50);
    expect(result.count).toBeGreaterThan(0);
  });

  it('matches brute-force results for random queries', () => {
    const grid = new SpatialGrid(2048);
    const count = 500;
    const bounds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      bounds[i * 4] = Math.random() * 1000;
      bounds[i * 4 + 1] = Math.random() * 1000;
      bounds[i * 4 + 2] = 0;
      bounds[i * 4 + 3] = 5 + Math.random() * 20;
    }
    grid.rebuild(bounds, count);

    for (let q = 0; q < 100; q++) {
      const qx = Math.random() * 1000;
      const qy = Math.random() * 1000;
      const result = grid.query(qx, qy);
      const gridIndices = new Set(Array.from(result.indices.subarray(0, result.count)));

      for (let i = 0; i < count; i++) {
        const cx = bounds[i * 4];
        const cy = bounds[i * 4 + 1];
        const r = bounds[i * 4 + 3];
        if (r <= 0) continue;
        const dx = qx - cx;
        const dy = qy - cy;
        if (dx * dx + dy * dy <= r * r) {
          expect(gridIndices.has(i)).toBe(true);
        }
      }
    }
  });
});
