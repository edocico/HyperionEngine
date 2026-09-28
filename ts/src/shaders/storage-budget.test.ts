import { describe, it, expect } from 'vitest';
import { composedPrimitiveModules } from '../render/primitive-pieces.fixture';

// `requestDevice` asks for no limits, so every stage gets the spec default of
// 8 storage buffers. Going over it does not throw: the pipeline comes back
// invalid and the error arrives asynchronously, which is how cull.wgsl sat at
// 9 from 4ea6cb5 to 2026-09-26 without anyone noticing. The limit is per shader
// stage, so counting per module is a conservative upper bound. A module that
// needs more than 8 and splits them across stages must refine this check, not
// delete it.
//
// The top-level modules by glob ('./*.wgsl' does not descend into primitives/,
// whose pieces are not modules), plus the seven composed primitive modules
// (render/primitive-shaders.ts) the GPU really compiles, the uber included.
const SPEC_MIN_STORAGE_BUFFERS_PER_STAGE = 8;

const shaders = import.meta.glob('./*.wgsl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const composed = composedPrimitiveModules();

function storageBufferCount(wgsl: string): number {
  return (wgsl.replace(/\/\/[^\n]*/g, '').match(/var<storage\b/g) ?? []).length;
}

describe('storage-buffer budget of every shader', () => {
  it('counts storage declarations, and not the ones in comments', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `@group(0) @binding(${i}) var<storage, read> b${i}: array<u32>;`).join('\n');
    expect(storageBufferCount(nine)).toBe(9);
    expect(storageBufferCount('// var<storage, read> gone: array<u32>;')).toBe(0);
  });

  it('finds the top-level shaders, and no piece', () => {
    expect(Object.keys(shaders).filter((f) => f.includes('primitives/'))).toEqual([]);
    expect(Object.keys(shaders).length).toBeGreaterThanOrEqual(16);
  });

  it('composes the seven primitive modules: six per type and the uber', () => {
    expect(Object.keys(composed)).toHaveLength(7);
  });

  it.each(Object.entries({ ...shaders, ...composed }))('%s declares at most 8 storage buffers', (_file, source) => {
    expect(storageBufferCount(source)).toBeLessThanOrEqual(SPEC_MIN_STORAGE_BUFFERS_PER_STAGE);
  });
});
