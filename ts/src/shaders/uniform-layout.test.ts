import { describe, it, expect } from 'vitest';
import { composedPrimitiveModules } from '../render/primitive-pieces.fixture';

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

type Layout = { align: number; size: number };

const SCALARS: Record<string, Layout> = {
  f32: { align: 4, size: 4 }, u32: { align: 4, size: 4 }, i32: { align: 4, size: 4 },
};

function stripComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, '');
}

function structs(src: string): Map<string, Array<[string, string]>> {
  const out = new Map<string, Array<[string, string]>>();
  for (const m of stripComments(src).matchAll(/struct\s+(\w+)\s*\{([^}]*)\}/g)) {
    // Split at top-level commas only: `array<vec4f, 6>` has one inside.
    const fields: string[] = [];
    let depth = 0; let cur = '';
    for (const ch of m[2]) {
      if (ch === '<') depth++;
      if (ch === '>') depth--;
      if (ch === ',' && depth === 0) { fields.push(cur); cur = ''; } else cur += ch;
    }
    fields.push(cur);
    const members = fields
      .map((f) => /(?:@\w+(?:\([^)]*\))?\s*)*(\w+)\s*:\s*(.+)/s.exec(f.trim()))
      .filter((mm): mm is RegExpExecArray => mm !== null)
      .map((mm) => [mm[1], mm[2].trim()] as [string, string]);
    out.set(m[1], members);
  }
  return out;
}

function roundUp(n: number, k: number): number {
  return Math.ceil(n / k) * k;
}

function layoutOf(type: string, defs: Map<string, Array<[string, string]>>): Layout {
  const t = type.replace(/\s+/g, '');
  if (SCALARS[t]) return SCALARS[t];
  const vec = /^vec([234])(?:f|u|i|<(?:f32|u32|i32)>)$/.exec(t);
  if (vec) {
    const n = Number(vec[1]);
    return { align: n === 2 ? 8 : 16, size: n * 4 };
  }
  const mat = /^mat([234])x([234])(?:f|<f32>)$/.exec(t);
  if (mat) {
    const cols = Number(mat[1]); const rows = Number(mat[2]);
    const col = layoutOf(`vec${rows}f`, defs);
    return { align: col.align, size: cols * roundUp(col.size, col.align) };
  }
  const arr = /^array<(.+),(\w+)>$/.exec(t);
  if (arr) {
    const el = layoutOf(arr[1], defs);
    const n = Number(arr[2]);
    if (!Number.isFinite(n)) throw new Error(`array length '${arr[2]}' is not a literal`);
    return { align: el.align, size: n * roundUp(el.size, el.align) };
  }
  const members = defs.get(t);
  if (!members) throw new Error(`unknown type '${type}'`);
  return structLayout(members, defs).layout;
}

function structLayout(members: Array<[string, string]>, defs: Map<string, Array<[string, string]>>) {
  let offset = 0; let align = 1; const gaps: string[] = [];
  for (const [name, type] of members) {
    const l = layoutOf(type, defs);
    const at = roundUp(offset, l.align);
    if (at !== offset) gaps.push(`${name} at ${at}, not ${offset}`);
    offset = at + l.size; align = Math.max(align, l.align);
  }
  return { layout: { align, size: roundUp(offset, align) }, gaps };
}

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
