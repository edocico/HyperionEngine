import { describe, it, expect } from 'vitest';
import { ScatterPass } from './scatter-pass';

describe('ScatterPass', () => {
  it('declares correct read/write resources', () => {
    const pass = new ScatterPass();
    expect(pass.name).toBe('scatter');
    expect(pass.reads).toContain('entity-transforms');
    expect(pass.reads).toContain('entity-bounds');
    expect(pass.reads).toContain('render-meta');
    expect(pass.reads).toContain('tex-indices');
    expect(pass.reads).toContain('prim-params');
    expect(pass.writes).toContain('entity-transforms');
    expect(pass.writes).toContain('entity-bounds');
    expect(pass.writes).toContain('render-meta');
    expect(pass.writes).toContain('tex-indices');
    expect(pass.writes).toContain('prim-params');
    expect(pass.optional).toBe(true);
  });

  it('computes correct workgroup count', () => {
    expect(ScatterPass.workgroupCount(0)).toBe(0);
    expect(ScatterPass.workgroupCount(1)).toBe(1);
    expect(ScatterPass.workgroupCount(64)).toBe(1);
    expect(ScatterPass.workgroupCount(65)).toBe(2);
    expect(ScatterPass.workgroupCount(1000)).toBe(16);
  });
});
