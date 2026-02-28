import { describe, it, expect } from 'vitest';
import { CullPass, computeWorkgroupSize, prepareShaderSource } from './cull-pass';

describe('CullPass', () => {
  it('should implement RenderPass interface', () => {
    const pass = new CullPass();
    expect(pass.name).toBe('cull');
    expect(pass.reads).toContain('entity-transforms');
    expect(pass.reads).toContain('entity-bounds');
    expect(pass.writes).toContain('visible-indices');
    expect(pass.writes).toContain('indirect-args');
    expect(pass.optional).toBe(false);
  });

  it('should declare render-meta as a read dependency', () => {
    const pass = new CullPass();
    expect(pass.reads).toContain('render-meta');
  });
});

describe('computeWorkgroupSize', () => {
  it('returns 256 when subgroups not used', () => {
    expect(computeWorkgroupSize(false, 32)).toBe(256);
  });
  it('returns 64 for subgroupSize=8 (Intel iGPU)', () => {
    expect(computeWorkgroupSize(true, 8)).toBe(64);
  });
  it('returns 256 for subgroupSize=32 (NVIDIA/Apple)', () => {
    expect(computeWorkgroupSize(true, 32)).toBe(256);
  });
  it('returns 256 for subgroupSize=64 (AMD)', () => {
    expect(computeWorkgroupSize(true, 64)).toBe(256);
  });
});

describe('prepareShaderSource', () => {
  it('returns unchanged source when subgroups not used', () => {
    const src = 'override USE_SUBGROUPS: bool = false;';
    expect(prepareShaderSource(src, false)).toBe(src);
  });
  it('prepends enable subgroups when used', () => {
    const src = 'override USE_SUBGROUPS: bool = false;';
    const result = prepareShaderSource(src, true);
    expect(result).toBe('enable subgroups;\n' + src);
  });
});
