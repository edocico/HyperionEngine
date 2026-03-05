import { describe, it, expect } from 'vitest';
import { CullPass, computeWorkgroupSize, prepareShaderSource, BUCKETS_PER_TYPE, BLEND_MODES, OPAQUE_DRAW_BUCKETS, TOTAL_DRAW_BUCKETS, TRANSPARENT_BUCKET_OFFSET, extractTransparentFlag, extractPrimType } from './cull-pass';

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

describe('opaque/transparent split constants', () => {
  it('has 2 buckets per primitive type (tier0 vs other)', () => {
    expect(BUCKETS_PER_TYPE).toBe(2);
  });

  it('has 2 blend modes (opaque and transparent)', () => {
    expect(BLEND_MODES).toBe(2);
  });

  it('has 12 opaque draw buckets (6 prim types x 2 buckets)', () => {
    expect(OPAQUE_DRAW_BUCKETS).toBe(12);
  });

  it('has 24 total draw buckets (12 opaque + 12 transparent)', () => {
    expect(TOTAL_DRAW_BUCKETS).toBe(24);
  });

  it('transparent bucket offset starts at 12', () => {
    expect(TRANSPARENT_BUCKET_OFFSET).toBe(12);
  });

  it('produces 480-byte indirect args buffer (24 x 5 u32 x 4 bytes)', () => {
    expect(TOTAL_DRAW_BUCKETS * 5 * 4).toBe(480);
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

  it('transparent entities route to correct bucket offset', () => {
    // For a transparent entity with primType=2, bucket=1:
    // argSlot = TRANSPARENT_BUCKET_OFFSET + 2 * BUCKETS_PER_TYPE + 1 = 12 + 4 + 1 = 17
    const primType = 2;
    const bucket = 1;
    const argSlot = TRANSPARENT_BUCKET_OFFSET + primType * BUCKETS_PER_TYPE + bucket;
    expect(argSlot).toBe(17);
  });

  it('opaque entities route to correct bucket offset', () => {
    // For an opaque entity with primType=2, bucket=1:
    // argSlot = 0 + 2 * 2 + 1 = 5
    const primType = 2;
    const bucket = 1;
    const argSlot = primType * BUCKETS_PER_TYPE + bucket;
    expect(argSlot).toBe(5);
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
