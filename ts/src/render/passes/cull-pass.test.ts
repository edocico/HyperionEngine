import { describe, it, expect } from 'vitest';
import { CullPass, computeWorkgroupSize, prepareShaderSource, BUCKETS_PER_TYPE, TOTAL_DRAW_BUCKETS, extractTransparentFlag, extractPrimType } from './cull-pass';

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

  it('should declare tex-indices as a read dependency for 2-bucket sort', () => {
    const pass = new CullPass();
    expect(pass.reads).toContain('tex-indices');
  });
});

describe('2-bucket material sort constants', () => {
  it('has 2 buckets per primitive type (tier0 vs other)', () => {
    expect(BUCKETS_PER_TYPE).toBe(2);
  });

  it('has 12 total draw buckets (6 prim types x 2 buckets)', () => {
    expect(TOTAL_DRAW_BUCKETS).toBe(12);
  });

  it('produces 240-byte indirect args buffer (12 x 5 u32 x 4 bytes)', () => {
    expect(TOTAL_DRAW_BUCKETS * 5 * 4).toBe(240);
  });
});

describe('transparent flag extraction', () => {
  it('extractTransparentFlag reads bit 8 from renderMeta', () => {
    const meta = (5 << 0) | (1 << 8); // primType=5, transparent=true
    expect(extractTransparentFlag(meta)).toBe(true);
    expect(extractPrimType(meta)).toBe(5);
  });

  it('non-transparent entity has bit 8 = 0', () => {
    const meta = 3; // primType=3, transparent=false
    expect(extractTransparentFlag(meta)).toBe(false);
    expect(extractPrimType(meta)).toBe(3);
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
