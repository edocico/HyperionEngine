import { describe, it, expect } from 'vitest';
import type { SystemViews } from './system-views';

describe('SystemViews', () => {
  it('interface has all required fields', () => {
    const views: SystemViews = {
      entityCount: 3,
      transforms: new Float32Array(48),
      bounds: new Float32Array(12),
      texIndices: new Uint32Array(3),
      renderMeta: new Uint32Array(6),
      primParams: new Float32Array(24),
      entityIds: new Uint32Array(3),
    };
    expect(views.entityCount).toBe(3);
    expect(views.transforms.length).toBe(48);
    expect(views.bounds.length).toBe(12);
    expect(views.entityIds.length).toBe(3);
  });
});
