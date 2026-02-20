import { describe, it, expect } from 'vitest';
import { SelectionSeedPass } from './selection-seed-pass';

describe('SelectionSeedPass', () => {
  it('should be optional (dead-pass culled when unused)', () => {
    const pass = new SelectionSeedPass();
    expect(pass.optional).toBe(true);
  });

  it('should declare correct reads and writes', () => {
    const pass = new SelectionSeedPass();
    expect(pass.reads).toContain('visible-indices');
    expect(pass.reads).toContain('entity-transforms');
    expect(pass.reads).toContain('indirect-args');
    expect(pass.reads).toContain('selection-mask');
    expect(pass.writes).toContain('selection-seed');
  });

  it('should have the correct name', () => {
    const pass = new SelectionSeedPass();
    expect(pass.name).toBe('selection-seed');
  });
});
