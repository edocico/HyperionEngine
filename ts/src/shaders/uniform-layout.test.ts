import { describe, it, expect } from 'vitest';
import { composedPrimitiveModules } from '../render/primitive-pieces.fixture';
import { structs, structLayout } from './uniform-layout';
import { stripComments } from './wgsl-analysis';

// Every TypeScript writer of a uniform buffer packs its fields back to back:
// f32[0], f32[1], ... WGSL does not. A vec2 is 8-aligned and a vec3/vec4/mat is
// 16-aligned, so a `texelSize: vec2f` after a single f32 lands 4 bytes later
// than the writer puts it. The struct also grows past the buffer, which fails
// validation at DRAW time. That is invisible headless, and it dropped every
// frame of the outline chain (jfa.wgsl, then outline-composite.wgsl) until
// 2026-09-26.
//
// The bug has one signature: implicit padding BETWEEN two members. This test
// computes every uniform struct's layout with the real WGSL rules and rejects
// it. Trailing padding (struct size rounded up) is fine: the writers allocate
// the rounded size, and pad fields at the end are harmless.
//
// Two sources. The top-level modules, by glob: './*.wgsl' does not descend
// into primitives/, whose pieces are not modules. And the seven modules the
// composer makes of those pieces (render/primitive-shaders.ts), six per type
// and the uber: what the GPU compiles.

const shaders = import.meta.glob('./*.wgsl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const composed = composedPrimitiveModules();

function uniformStructsOf(modules: Record<string, string>) {
  return Object.entries(modules).flatMap(([file, src]) => {
    const defs = structs(src);
    return [...stripComments(src).matchAll(/var<uniform>\s+\w+\s*:\s*(\w+)\s*;/g)]
      .map((m) => ({ file, struct: m[1], members: defs.get(m[1]), defs }))
      .filter((u) => u.members);
  });
}

const topLevelUniforms = uniformStructsOf(shaders);
const composedUniforms = uniformStructsOf(composed);

describe('uniform structs have no implicit padding between members', () => {
  it('finds the uniform structs of the top-level modules, and no piece', () => {
    expect(Object.keys(shaders).filter((f) => f.includes('primitives/'))).toEqual([]);
    expect(topLevelUniforms.length).toBeGreaterThanOrEqual(14);
  });

  it('finds CameraUniform and LightingUniform in each of the seven composed modules', () => {
    expect(Object.keys(composed)).toHaveLength(7);
    for (const label of Object.keys(composed)) {
      expect(composedUniforms.filter((u) => u.file === label).map((u) => u.struct).sort(), label)
        .toEqual(['CameraUniform', 'LightingUniform']);
    }
  });

  it.each([...topLevelUniforms, ...composedUniforms].map((u) => [`${u.file} ${u.struct}`, u] as const))('%s', (_label, u) => {
    expect(structLayout(u.members!, u.defs).gaps).toEqual([]);
  });
});
