import { stripComments } from './wgsl-analysis';

/**
 * WGSL host-shareable layout of the structs a shader declares, with the real
 * alignment rules: a vec2 is 8-aligned, a vec3/vec4/mat 16-aligned, a struct
 * as aligned as its most aligned member and its size rounded up to that.
 * Headless tests use it where WebGPU would only complain at draw time: the
 * uniform padding check (uniform-layout.test.ts) and the `minBindingSize` a
 * layout declares for a struct (forward-pass.test.ts).
 */

export type Layout = { align: number; size: number };

/** A struct's members as `[name, type]`, in declaration order. */
export type Members = Array<[string, string]>;

const SCALARS: Record<string, Layout> = {
  f32: { align: 4, size: 4 }, u32: { align: 4, size: 4 }, i32: { align: 4, size: 4 },
};

/** Every struct `src` declares, by name. */
export function structs(src: string): Map<string, Members> {
  const out = new Map<string, Members>();
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

/** Alignment and size of `type`; `defs` resolves struct names. */
export function layoutOf(type: string, defs: Map<string, Members>): Layout {
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

/**
 * The layout of a struct with `members`, and its implicit padding BETWEEN two
 * members (`gaps`, one line per member that does not start where the previous
 * one ended). Trailing padding is part of `size`, not a gap.
 */
export function structLayout(members: Members, defs: Map<string, Members>): { layout: Layout; gaps: string[] } {
  let offset = 0; let align = 1; const gaps: string[] = [];
  for (const [name, type] of members) {
    const l = layoutOf(type, defs);
    const at = roundUp(offset, l.align);
    if (at !== offset) gaps.push(`${name} at ${at}, not ${offset}`);
    offset = at + l.size; align = Math.max(align, l.align);
  }
  return { layout: { align, size: roundUp(offset, align) }, gaps };
}

/** Size in bytes of the struct `name` declared in `src`. */
export function structSize(src: string, name: string): number {
  const defs = structs(src);
  const members = defs.get(name);
  if (!members) throw new Error(`no struct '${name}' in the source`);
  return structLayout(members, defs).layout.size;
}
