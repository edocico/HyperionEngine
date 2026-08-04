import { describe, it, expect } from 'vitest';
import { CullPass, computeWorkgroupSize, prepareShaderSource, NUM_PRIM_TYPES, BUCKETS_PER_TYPE, BLEND_MODES, OPAQUE_DRAW_BUCKETS, TOTAL_DRAW_BUCKETS, TRANSPARENT_BUCKET_OFFSET, extractTransparentFlag, extractPrimType, computeInvalidationFlag, visibilityBufferSize } from './cull-pass';
import cullShaderSource from '../../shaders/cull.wgsl?raw';

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

  it('has 7 primitive types (Phase 17 added Light2D = 6)', () => {
    expect(NUM_PRIM_TYPES).toBe(7);
  });

  it('has 14 opaque draw buckets (7 prim types x 2 buckets)', () => {
    expect(OPAQUE_DRAW_BUCKETS).toBe(14);
  });

  it('has 28 total draw buckets (14 opaque + 14 transparent)', () => {
    expect(TOTAL_DRAW_BUCKETS).toBe(28);
  });

  it('transparent bucket offset starts at 14', () => {
    expect(TRANSPARENT_BUCKET_OFFSET).toBe(14);
  });

  it('produces 560-byte indirect args buffer (28 x 5 u32 x 4 bytes)', () => {
    expect(TOTAL_DRAW_BUCKETS * 5 * 4).toBe(560);
  });
});

// ⚠️ `cull.wgsl` declares NUM_PRIM_TYPES independently of `cull-pass.ts`, and
// WebGPU cannot be exercised headless — so nothing at runtime would notice the
// two drifting apart until a draw call read past the end of the indirect
// buffer. These assertions read the shader source as text, which is the only
// check available without a browser. Check #4 of the `wgsl-validator` agent.
describe('cull.wgsl agrees with cull-pass.ts on the bucket count', () => {
  function wgslConst(name: string): number {
    const m = cullShaderSource.match(new RegExp(`const\\s+${name}\\s*:\\s*u32\\s*=\\s*(\\d+)u`));
    if (!m) throw new Error(`cull.wgsl no longer declares a literal '${name}'`);
    return Number(m[1]);
  }

  it('declares the same NUM_PRIM_TYPES', () => {
    expect(wgslConst('NUM_PRIM_TYPES')).toBe(NUM_PRIM_TYPES);
  });

  it('declares the same BUCKETS_PER_TYPE', () => {
    expect(wgslConst('BUCKETS_PER_TYPE')).toBe(BUCKETS_PER_TYPE);
  });

  it('sizes drawArgs and workgroup storage by const-expression, not by literal', () => {
    // Deriving them is what makes NUM_PRIM_TYPES the single number to change.
    // A literal creeping back in is the regression this guards.
    expect(cullShaderSource).toContain('array<DrawIndirectArgs, TOTAL_BUCKETS>');
    expect(cullShaderSource).toContain('array<u32, TOTAL_BUCKETS * MAX_SUBGROUPS>');
    expect(cullShaderSource).toContain('array<u32, TOTAL_BUCKETS>');
  });

  it('keeps workgroup storage inside the 16 KiB limit', () => {
    const MAX_SUBGROUPS = 8;
    const bytes = (TOTAL_DRAW_BUCKETS * MAX_SUBGROUPS * 2 + TOTAL_DRAW_BUCKETS) * 4;
    expect(bytes).toBeLessThan(16 * 1024);
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
    // argSlot = TRANSPARENT_BUCKET_OFFSET + 2 * BUCKETS_PER_TYPE + 1 = 14 + 4 + 1 = 19
    const primType = 2;
    const bucket = 1;
    const argSlot = TRANSPARENT_BUCKET_OFFSET + primType * BUCKETS_PER_TYPE + bucket;
    expect(argSlot).toBe(19);
  });

  it('Light2D (type 6) claims the last opaque bucket pair', () => {
    // Its transparent pair exists too and stays empty — see TOTAL_DRAW_BUCKETS.
    expect(6 * BUCKETS_PER_TYPE + 0).toBe(12);
    expect(6 * BUCKETS_PER_TYPE + 1).toBe(13);
    expect(TRANSPARENT_BUCKET_OFFSET + 6 * BUCKETS_PER_TYPE + 1).toBe(27);
    // Every bucket index stays inside the buffer.
    expect(TRANSPARENT_BUCKET_OFFSET + 6 * BUCKETS_PER_TYPE + 1).toBeLessThan(TOTAL_DRAW_BUCKETS);
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

describe('prepareShaderSource v2 (3-level)', () => {
  it('returns unchanged source for no subgroups', () => {
    const src = 'override USE_SUBGROUPS: bool = false;';
    expect(prepareShaderSource(src, false, false)).toBe(src);
  });

  it('prepends enable subgroups when subgroups used but no subgroup_id', () => {
    const src = 'override USE_SUBGROUPS: bool = false;';
    const result = prepareShaderSource(src, true, false);
    expect(result).toBe('enable subgroups;\n' + src);
  });

  it('prepends enable subgroups + requires subgroup_id when both available', () => {
    const src = 'override USE_SUBGROUPS: bool = false;';
    const result = prepareShaderSource(src, true, true);
    expect(result).toBe('enable subgroups;\nrequires subgroup_id;\n' + src);
  });

  it('ignores subgroup_id when subgroups not supported', () => {
    const src = 'fn main() {}';
    expect(prepareShaderSource(src, false, true)).toBe(src);
  });
});

// The engine ran for four phases believing `override USE_SUBGROUPS = false` was
// enough to make the subgroup branch harmless on a device without the feature.
// It is not: WGSL validates every builtin call in the module no matter what an
// override is set to, so `subgroupAdd` in the text is a hard compile error
// there — and `createRenderer` swallows it into a null renderer, so the symptom
// was a blank canvas, not a message. That covers all of Firefox and Safari.
//
// Verified against a real driver via chrome-devtools `getCompilationInfo()`
// (the method in CLAUDE.md); these tests are the cheap standing guard.
describe('prepareShaderSource strips subgroup-only code from the real shader', () => {
  const SUBGROUP_BUILTIN = /subgroup(Add|Elect|ExclusiveAdd|BroadcastFirst)\s*\(/;

  it('the shader really does call subgroup builtins — otherwise this is all moot', () => {
    expect(cullShaderSource).toMatch(SUBGROUP_BUILTIN);
  });

  it('carries both region markers, in order', () => {
    const begin = cullShaderSource.indexOf('// BEGIN-SUBGROUPS-ONLY');
    const end = cullShaderSource.indexOf('// END-SUBGROUPS-ONLY');
    expect(begin, 'BEGIN-SUBGROUPS-ONLY marker missing').toBeGreaterThan(-1);
    expect(end, 'END-SUBGROUPS-ONLY marker missing').toBeGreaterThan(begin);
  });

  it('leaves no subgroup builtin behind when the feature is absent', () => {
    const stripped = prepareShaderSource(cullShaderSource, false);
    expect(stripped).not.toMatch(SUBGROUP_BUILTIN);
    expect(stripped.length).toBeLessThan(cullShaderSource.length);
  });

  it('keeps the atomic fallback that the stripped shader has to run', () => {
    const stripped = prepareShaderSource(cullShaderSource, false);
    expect(stripped).toContain('atomicAdd(&drawArgs[argSlot].instanceCount, 1u)');
    // Braces still balance, i.e. the region was removed as a whole block.
    const open = (stripped.match(/\{/g) ?? []).length;
    const close = (stripped.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });

  it('leaves the subgroup path untouched when the feature is present', () => {
    const enabled = prepareShaderSource(cullShaderSource, true);
    expect(enabled).toMatch(SUBGROUP_BUILTIN);
    expect(enabled).toBe('enable subgroups;\n' + cullShaderSource);
  });

  it('never emits the enable directive on the stripped path', () => {
    // Doing so would fail validation on exactly the devices this path targets.
    // Checked at the start of the source, not anywhere in it: the shader's own
    // header comment names the directive while explaining why it is not there.
    expect(prepareShaderSource(cullShaderSource, false).startsWith('enable ')).toBe(false);
    expect(prepareShaderSource(cullShaderSource, false, true).startsWith('enable ')).toBe(false);
    expect(prepareShaderSource(cullShaderSource, true).startsWith('enable subgroups;\n')).toBe(true);
  });
});

describe('temporal culling', () => {
  it('computeInvalidationFlag returns true when camera teleports in X', () => {
    const prev = { x: 0, y: 0, frustumWidth: 1000 };
    const curr = { x: 600, y: 0, frustumWidth: 1000 };
    expect(computeInvalidationFlag(prev, curr)).toBe(true);
  });

  it('computeInvalidationFlag returns false for smooth pan', () => {
    const prev = { x: 0, y: 0, frustumWidth: 1000 };
    const curr = { x: 5, y: 3, frustumWidth: 1000 };
    expect(computeInvalidationFlag(prev, curr)).toBe(false);
  });

  it('computeInvalidationFlag returns true for Y teleport', () => {
    const prev = { x: 0, y: 0, frustumWidth: 1000 };
    const curr = { x: 0, y: 600, frustumWidth: 1000 };
    expect(computeInvalidationFlag(prev, curr)).toBe(true);
  });

  it('computeInvalidationFlag at exact threshold is false (strict >)', () => {
    const prev = { x: 0, y: 0, frustumWidth: 1000 };
    const curr = { x: 500, y: 0, frustumWidth: 1000 };
    // dx == threshold (500 == 1000*0.5), > is strict so not exceeded
    expect(computeInvalidationFlag(prev, curr)).toBe(false);
  });
});

describe('visibilityBufferSize', () => {
  it('returns 4 bytes for 1 entity (1 u32 word)', () => {
    expect(visibilityBufferSize(1)).toBe(4);
  });

  it('returns 4 bytes for 32 entities (exactly 1 u32 word)', () => {
    expect(visibilityBufferSize(32)).toBe(4);
  });

  it('returns 8 bytes for 33 entities (2 u32 words)', () => {
    expect(visibilityBufferSize(33)).toBe(8);
  });

  it('returns 12500 bytes for 100000 entities', () => {
    // ceil(100000/32) * 4 = 3125 * 4 = 12500
    expect(visibilityBufferSize(100000)).toBe(12500);
  });

  it('returns 0 bytes for 0 entities', () => {
    expect(visibilityBufferSize(0)).toBe(0);
  });
});
