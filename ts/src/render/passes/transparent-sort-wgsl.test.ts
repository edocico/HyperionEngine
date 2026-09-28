import { describe, it, expect } from 'vitest';
import gatherSource from '../../shaders/transparent-gather.wgsl?raw';
import sortSource from '../../shaders/transparent-sort.wgsl?raw';
import { bindingDecls, functionBody, reachableFrom, stripComments } from '../../shaders/wgsl-analysis';
import {
  ARG_FIRST_INSTANCE, ARG_INSTANCE_COUNT, ARG_WORDS,
  CAP, DIAG_SCAN_MISMATCH, DIAG_SCATTER_OOB, DIAG_WORDS, DIGIT_BASE_OFFSET, FIRST_TRANSPARENT_ARG,
  GATHER_REGIONS, HEADER_BYTES, HEADER_WORDS, HIST_WORDS, H_DISPATCH, H_DRAW, H_LIMIT, H_OVERFLOW, H_RAW,
  H_STAMP, LAST_PASS, LO_PASSES, MASK_WORDS, PASSES, RADIX, ROUNDS, SCAN_CHUNK, TILE, TILES_OFFSET, WORKGROUP_SIZE,
} from './transparent-sort-constants';
import {
  cpuGather, cpuScan, cpuScatter, cpuUpsweep, digitOf,
  type Schedule, type SortModelBuffers, type SortModelInput,
} from './transparent-sort-reference';
import { BUCKETS_PER_TYPE, TOTAL_DRAW_BUCKETS, TRANSPARENT_BUCKET_OFFSET } from './cull-pass';
import { MAX_EXTERNAL_ID, MAX_GPU_ENTITIES } from '../../types';

// The sort kernels (Phase 5b, design 2026-09-27 §5.3) cannot run headless, and
// the CPU model in transparent-sort-reference.ts is a second codebase that
// mirrors them phase by phase. These tests read the WGSL as TEXT and hold it to
// the shared constants, to the binding tables of §5.3 and to the barrier
// structure the model assumes. Compiling it is Chrome's and naga's job (§7.3.2).

// ── Text helpers ───────────────────────────────────────────────────

/** `const NAME: u32 = EXPR;` of a module, unevaluated. */
function constDefs(src: string): Map<string, string> {
  const defs = new Map<string, string>();
  for (const m of stripComments(src).matchAll(/\bconst\s+(\w+)\s*:\s*u32\s*=\s*([^;]+);/g)) {
    defs.set(m[1], m[2].trim());
  }
  return defs;
}

/** A product of u32 literals and consts of the module: `256u`, `0xFFu`, `RADIX * MASK_WORDS`. */
function evaluate(expr: string, defs: Map<string, string>): number {
  return expr.split('*').reduce((product, factor) => {
    const f = factor.trim();
    const literal = /^(0x[0-9a-fA-F]+|\d+)u?$/.exec(f);
    if (literal) return product * Number(literal[1]);
    const def = defs.get(f);
    if (def === undefined) throw new Error(`'${f}' is neither a u32 literal nor a const of the module`);
    return product * evaluate(def, defs);
  }, 1);
}

function wgslConst(src: string, name: string): number {
  const defs = constDefs(src);
  const def = defs.get(name);
  if (def === undefined) throw new Error(`the module declares no 'const ${name}: u32'`);
  return evaluate(def, defs);
}

/** A function's body, comments stripped. */
function body(src: string, fn: string): string {
  const text = functionBody(src, fn);
  if (text === null) throw new Error(`the module has no fn ${fn}`);
  return stripComments(text);
}

function entryPoints(src: string): Array<{ name: string; size: string }> {
  return [...stripComments(src).matchAll(/@compute\s+@workgroup_size\((\w+)\)\s+fn\s+(\w+)\s*\(/g)]
    .map((m) => ({ size: m[1], name: m[2] }));
}

/** Every `@group @binding var<...> name: TYPE;` as [group, binding, space, name, type], spaces removed. */
function declaredBindings(src: string) {
  return [...stripComments(src).matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var<([^>]+)>\s+(\w+)\s*:\s*([^;]+);/g)]
    .map((m) => [Number(m[1]), Number(m[2]), m[3].replace(/\s+/g, ''), m[4], m[5].replace(/\s+/g, '')] as const);
}

/** A struct's members as [name, type], the type without spaces. */
function structMembers(src: string, name: string): Array<[string, string]> {
  const m = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(stripComments(src));
  if (!m) throw new Error(`the module has no struct ${name}`);
  // Split at top-level commas only: `array<u32, N>` has one inside.
  const fields: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of m[1]) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) { fields.push(cur); cur = ''; } else cur += ch;
  }
  fields.push(cur);
  return fields.map((f) => f.trim()).filter(Boolean).map((f) => {
    const [n, ...type] = f.split(':');
    return [n.trim(), type.join(':').replace(/\s+/g, '')] as [string, string];
  });
}

/** Every `var<workgroup>` with its size in bytes. */
function workgroupVars(src: string): Array<{ name: string; bytes: number }> {
  const code = stripComments(src);
  const defs = constDefs(src);
  const vars = [...code.matchAll(/var<workgroup>\s+(\w+)\s*:\s*array<\s*(?:atomic<u32>|u32)\s*,\s*([^;]+)>\s*;/g)]
    .map((m) => ({ name: m[1], bytes: 4 * evaluate(m[2], defs) }));
  expect(vars.length, 'a var<workgroup> this test cannot size').toBe((code.match(/var<workgroup>/g) ?? []).length);
  return vars;
}

/** Index of the `}` that closes the `{` at `open`. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces');
}

function textBarriers(text: string): number {
  return (text.match(/workgroupBarrier\s*\(\s*\)/g) ?? []).length;
}

/** Trip count of a counted `for` header: `var x = A; x < B; x++` or `x <<= 1u`. */
function tripCount(header: string, defs: Map<string, string>): number {
  const m = /^for\s*\(\s*var\s+(\w+)\s*=\s*([^;]+?)\s*;\s*(\w+)\s*<\s*([^;]+?)\s*;\s*(\w+)\s*(\+\+|<<=\s*1u)\s*\)$/
    .exec(header.trim());
  if (!m || m[1] !== m[3] || m[1] !== m[5]) throw new Error(`a barrier inside a loop this test cannot count: ${header.trim()}`);
  const start = evaluate(m[2], defs);
  const bound = evaluate(m[4], defs);
  const doubling = m[6] !== '++';
  if (doubling && start === 0) throw new Error(`'${header.trim()}' never ends`);
  let trips = 0;
  for (let v = start; v < bound; v = doubling ? v * 2 : v + 1) trips++;
  return trips;
}

/**
 * Barriers a body EXECUTES per workgroup: a barrier in a `for` counts once per
 * trip; one under an `if`/`else` or in a bare block throws. Every barrier of
 * these kernels sits at the top level or in a constant-trip loop: that is what
 * keeps them in uniform control flow.
 */
function executedBarriers(text: string, defs: Map<string, string>): number {
  const token = /\bfor\s*\(|\bif\s*\(|\belse\b|workgroupBarrier\s*\(\s*\)|\{/g;
  let count = 0;
  let at = 0;
  for (;;) {
    token.lastIndex = at;
    const m = token.exec(text);
    if (!m) return count;
    if (m[0].startsWith('workgroupBarrier')) {
      count++;
      at = m.index + m[0].length;
      continue;
    }
    const open = text.indexOf('{', m.index);
    const close = matchBrace(text, open);
    const inner = executedBarriers(text.slice(open + 1, close), defs);
    if (inner > 0) {
      if (!m[0].startsWith('for')) throw new Error(`a barrier under '${m[0]}': not provably uniform`);
      count += inner * tripCount(text.slice(m.index, open), defs);
    }
    at = close + 1;
  }
}

// ── Constants ──────────────────────────────────────────────────────

describe('the kernels declare the constants of transparent-sort-constants.ts', () => {
  const shared: Array<[string, number]> = [
    ['WORKGROUP_SIZE', WORKGROUP_SIZE], ['CAP', CAP], ['TILE', TILE], ['HEADER_WORDS', HEADER_WORDS],
    ['H_INSTANCES', H_DRAW + ARG_INSTANCE_COUNT], // DrawIndexedIndirect.instanceCount: n
  ];
  const gatherOnly: Array<[string, number]> = [
    ['FIRST_TRANSPARENT_ARG', FIRST_TRANSPARENT_ARG], ['GATHER_REGIONS', GATHER_REGIONS],
    ['H_DRAW', H_DRAW], ['H_DISPATCH', H_DISPATCH], ['H_RAW', H_RAW], ['H_LIMIT', H_LIMIT],
    ['H_OVERFLOW', H_OVERFLOW], ['H_STAMP', H_STAMP],
    // DrawIndexedIndirect: indexCount, instanceCount, firstIndex, baseVertex, firstInstance
    ['ARG_WORDS', ARG_WORDS], ['ARG_INSTANCE_COUNT', ARG_INSTANCE_COUNT], ['ARG_FIRST_INSTANCE', ARG_FIRST_INSTANCE],
    ['QUAD_INDEX_COUNT', 6], // the unit quad's index buffer
  ];
  const sortOnly: Array<[string, number]> = [
    ['ROUNDS', ROUNDS], ['RADIX', RADIX], ['PASSES', PASSES], ['LAST_PASS', LAST_PASS],
    ['DIAG_WORDS', DIAG_WORDS], ['DIAG_SCAN_MISMATCH', DIAG_SCAN_MISMATCH], ['DIAG_SCATTER_OOB', DIAG_SCATTER_OOB],
    ['MASK_WORDS', MASK_WORDS], ['LO_PASSES', LO_PASSES], ['SCAN_CHUNK', SCAN_CHUNK],
    ['DIGIT_BITS', Math.log2(RADIX)], ['DIGIT_MASK', RADIX - 1],
  ];

  it('MASK_WORDS is one bit per lane of the workgroup', () => {
    expect(MASK_WORDS).toBe(WORKGROUP_SIZE / 32);
  });

  it.each([...shared, ...gatherOnly])('gather: %s = %i', (name, value) => {
    expect(wgslConst(gatherSource, name)).toBe(value);
  });

  it.each([...shared, ...sortOnly])('sort: %s = %i', (name, value) => {
    expect(wgslConst(sortSource, name)).toBe(value);
  });

  it('CAP is MAX_GPU_ENTITIES in TS and in both modules', () => {
    expect(CAP).toBe(MAX_GPU_ENTITIES);
    expect(wgslConst(gatherSource, 'CAP')).toBe(MAX_GPU_ENTITIES);
    expect(wgslConst(sortSource, 'CAP')).toBe(MAX_GPU_ENTITIES);
  });

  it('LO_PASSES and DIGIT_BITS are where and how the CPU model takes its digits', () => {
    const loPasses = wgslConst(sortSource, 'LO_PASSES');
    const bits = wgslConst(sortSource, 'DIGIT_BITS');
    const fromId = Array.from({ length: PASSES }, (_, p) => digitOf(0xFFFFFFFF, 0, p) === 0xFF);
    expect(fromId.filter(Boolean)).toHaveLength(loPasses);
    for (let p = 0; p < PASSES; p++) {
      const shift = p < loPasses ? p * bits : (p - loPasses) * bits;
      const word = (1 << shift) >>> 0;
      expect(p < loPasses ? digitOf(word, 0, p) : digitOf(0, word, p), `pass ${p}`).toBe(1);
    }
  });

  it('the id passes cover every external id, the z passes the whole 32-bit z key', () => {
    const loPasses = wgslConst(sortSource, 'LO_PASSES');
    const bits = wgslConst(sortSource, 'DIGIT_BITS');
    expect(2 ** (loPasses * bits)).toBeGreaterThan(MAX_EXTERNAL_ID);
    expect((PASSES - loPasses) * bits).toBe(32);
  });

  it('PASSES is odd and the last pass is PASSES - 1, so the result lands in B = transparent-order', () => {
    expect(PASSES % 2).toBe(1);
    expect(LAST_PASS).toBe(PASSES - 1);
  });

  it('one lane per digit, ROUNDS rounds of one workgroup per tile', () => {
    expect(RADIX).toBe(WORKGROUP_SIZE);
    expect(TILE).toBe(ROUNDS * WORKGROUP_SIZE);
  });

  it('the gather reads the transparent buckets of types 0-5 and nothing else', () => {
    expect(FIRST_TRANSPARENT_ARG).toBe(TRANSPARENT_BUCKET_OFFSET);
    expect(GATHER_REGIONS).toBe(6 * BUCKETS_PER_TYPE);
    // 26/27 (Light2D) stay LightAccumStage's.
    expect(FIRST_TRANSPARENT_ARG + GATHER_REGIONS).toBe(TOTAL_DRAW_BUCKETS - BUCKETS_PER_TYPE);
  });

  it('the header array is HEADER_BYTES long', () => {
    expect(HEADER_WORDS * 4).toBe(HEADER_BYTES);
  });
});

// ── Entry points and bindings ──────────────────────────────────────

describe('entry points and bindings (§5.3 tables)', () => {
  it('gather has gather_main, sort has upsweep_main, scan_main, scatter_main, all at 256 lanes', () => {
    expect(entryPoints(gatherSource).map((e) => e.name)).toEqual(['gather_main']);
    expect(entryPoints(sortSource).map((e) => e.name)).toEqual(['upsweep_main', 'scan_main', 'scatter_main']);
    for (const src of [gatherSource, sortSource]) {
      expect(entryPoints(src)).toHaveLength((stripComments(src).match(/@compute/g) ?? []).length);
      for (const e of entryPoints(src)) expect(evaluate(e.size, constDefs(src))).toBe(WORKGROUP_SIZE);
    }
  });

  it('gather: b0 uniform, b1-b4 read-only inputs, b5-b7 its outputs', () => {
    expect(declaredBindings(gatherSource).map((b) => [...b])).toEqual([
      [0, 0, 'uniform', 'params', 'GatherParams'],
      [0, 1, 'storage,read', 'indirectArgs', 'array<u32>'],
      [0, 2, 'storage,read', 'visibleIndices', 'array<u32>'],
      [0, 3, 'storage,read', 'bounds', 'array<vec4<u32>>'],
      [0, 4, 'storage,read', 'entityIds', 'array<u32>'],
      [0, 5, 'storage,read_write', 'keysOut', 'array<u32>'],
      [0, 6, 'storage,read_write', 'valsOut', 'array<u32>'],
      [0, 7, 'storage,read_write', 'header', 'array<u32,HEADER_WORDS>'],
    ]);
  });

  it('sort: one layout for the three kernels, the header READ-ONLY so n is uniform', () => {
    expect(declaredBindings(sortSource).map((b) => [...b])).toEqual([
      [0, 0, 'uniform', 'params', 'PassParams'],
      [0, 1, 'storage,read', 'keysIn', 'array<u32>'],
      [0, 2, 'storage,read', 'valsIn', 'array<u32>'],
      [0, 3, 'storage,read_write', 'keysOut', 'array<u32>'],
      [0, 4, 'storage,read_write', 'valsOut', 'array<u32>'],
      [0, 5, 'storage,read', 'header', 'array<u32,HEADER_WORDS>'],
      [0, 6, 'storage,read_write', 'hist', 'SortHist'],
    ]);
  });

  it.each([['gather', 7, gatherSource], ['sort', 6, sortSource]] as const)(
    '%s: %i storage buffers, within the 8 a stage gets by default',
    (_name, storage, src) => {
      const count = declaredBindings(src).filter(([, , space]) => space.startsWith('storage')).length;
      expect(count).toBe(storage);
      expect(count).toBeLessThanOrEqual(8);
    },
  );

  it.each([['gather', gatherSource], ['sort', sortSource]] as const)(
    '%s: wgsl-analysis sees the same bindings, and an entry point reaches every one (a dead one still counts)',
    (_name, src) => {
      expect(bindingDecls(src).map((b) => [b.group, b.binding, b.name]))
        .toEqual(declaredBindings(src).map(([g, b, , name]) => [g, b, name]));
      const reached = new Set(entryPoints(src).flatMap((e) => [...reachableFrom(src, e.name)]));
      expect(bindingDecls(src).map((b) => b.name).filter((name) => !reached.has(name))).toEqual([]);
    },
  );

  it('each sort kernel reaches only the bindings its stage needs', () => {
    const bindingsOf = (entry: string) => {
      const reach = reachableFrom(sortSource, entry);
      return bindingDecls(sortSource).map((b) => b.name).filter((name) => reach.has(name)).sort();
    };
    expect(bindingsOf('upsweep_main')).toEqual(['header', 'hist', 'keysIn', 'params']);
    expect(bindingsOf('scan_main')).toEqual(['header', 'hist', 'params']);
    expect(bindingsOf('scatter_main')).toEqual(['header', 'hist', 'keysIn', 'keysOut', 'params', 'valsIn', 'valsOut']);
    expect([...reachableFrom(gatherSource, 'gather_main')]).toEqual(
      expect.arrayContaining(bindingDecls(gatherSource).map((b) => b.name)),
    );
  });
});

// ── Struct layouts ─────────────────────────────────────────────────

describe('struct layouts', () => {
  it('GatherParams and PassParams are 4 × u32 with explicit pads (uniform-layout rules)', () => {
    expect(structMembers(gatherSource, 'GatherParams'))
      .toEqual([['limit', 'u32'], ['stamp', 'u32'], ['_pad0', 'u32'], ['_pad1', 'u32']]);
    expect(structMembers(sortSource, 'PassParams'))
      .toEqual([['passIndex', 'u32'], ['_pad0', 'u32'], ['_pad1', 'u32'], ['_pad2', 'u32']]);
  });

  it('SortHist: diag, then digitBase at DIGIT_BASE_OFFSET, then the tiles at TILES_OFFSET', () => {
    const defs = constDefs(sortSource);
    const members = structMembers(sortSource, 'SortHist');
    expect(members.map(([n]) => n)).toEqual(['diag', 'digitBase', 'tiles']);
    const length = (type: string): number => {
      const m = /^array<(?:atomic<u32>|u32),(.+)>$/.exec(type);
      if (!m) throw new Error(`not a sized u32 array: ${type}`);
      return evaluate(m[1], defs);
    };
    expect(members[0][1]).toMatch(/^array<atomic<u32>,/);
    expect(length(members[0][1])).toBe(DIAG_WORDS);
    expect(DIAG_WORDS).toBe(DIGIT_BASE_OFFSET);
    expect(length(members[1][1])).toBe(PASSES * RADIX);
    expect(DIGIT_BASE_OFFSET + length(members[1][1])).toBe(TILES_OFFSET);
    expect(members[2][1]).toBe('array<u32>');
  });
});

// ── Workgroup memory ───────────────────────────────────────────────

describe('workgroup memory per entry point', () => {
  const bytesOf = (src: string, entry: string): number => {
    const reach = reachableFrom(src, entry);
    return workgroupVars(src).filter((v) => reach.has(v.name)).reduce((sum, v) => sum + v.bytes, 0);
  };

  it('gather 96 B, upsweep 1024 B, scan 1024 B, scatter 9216 B — all within 16 KiB', () => {
    expect(bytesOf(gatherSource, 'gather_main')).toBe(96);
    expect(bytesOf(sortSource, 'upsweep_main')).toBe(1024);
    expect(bytesOf(sortSource, 'scan_main')).toBe(1024);
    expect(bytesOf(sortSource, 'scatter_main')).toBe(9216);
    for (const [src, entry] of [[gatherSource, 'gather_main'], [sortSource, 'upsweep_main'],
      [sortSource, 'scan_main'], [sortSource, 'scatter_main']] as const) {
      expect(bytesOf(src, entry)).toBeLessThanOrEqual(16_384);
    }
  });
});

// ── Kernel bodies ──────────────────────────────────────────────────

describe('gather_main (§5.3 gather)', () => {
  const b = body(gatherSource, 'gather_main');

  it('lane 0 reads the 12 regions from the args; no region size is assumed', () => {
    expect(b).toContain('for (var region = 0u; region < GATHER_REGIONS; region++)');
    expect(b).toContain('let arg = (FIRST_TRANSPARENT_ARG + region) * ARG_WORDS;');
    expect(b).toContain('acc += indirectArgs[arg + ARG_INSTANCE_COUNT];');
    expect(b).toContain('regionBase[region] = indirectArgs[arg + ARG_FIRST_INSTANCE];');
    // The module declares CAP = 100000u (pinned above); the kernel body names no literal size.
    expect(functionBody(stripComments(gatherSource), 'gather_main')).not.toMatch(/100000|100_000/);
  });

  it('one barrier, at the top level, before the lanes past n return', () => {
    expect(textBarriers(b)).toBe(1);
    expect(executedBarriers(b, constDefs(gatherSource))).toBe(1);
    expect(b.indexOf('workgroupBarrier')).toBeLessThan(b.indexOf('return'));
    expect(b).toContain('let raw = regionEnd[GATHER_REGIONS - 1u];');
    expect(b).toContain('let n = min(raw, params.limit);');
    expect(b).toContain('if (i >= n) { return; }');
  });

  it('only lane 0 of workgroup 0 writes the header, words 0-11 including the stamp', () => {
    const at = b.search(/if\s*\(\s*wid\.x\s*==\s*0u\s*&&\s*lid\s*==\s*0u\s*\)\s*\{/);
    expect(at).toBeGreaterThan(-1);
    const open = b.indexOf('{', at);
    const close = matchBrace(b, open);
    const block = b.slice(open + 1, close);
    for (const w of [...b.matchAll(/header\[/g)].map((m) => m.index!)) {
      expect(w).toBeGreaterThan(open);
      expect(w).toBeLessThan(close);
    }
    for (const line of [
      'header[H_DRAW] = QUAD_INDEX_COUNT;',
      'header[H_INSTANCES] = n;',
      'header[H_DRAW + 2u] = 0u;',
      'header[H_DRAW + 3u] = 0u;',
      'header[H_DRAW + 4u] = 0u;',
      'header[H_DISPATCH] = (n + TILE - 1u) / TILE;',
      'header[H_DISPATCH + 1u] = 1u;',
      'header[H_DISPATCH + 2u] = 1u;',
      'header[H_RAW] = raw;',
      'header[H_LIMIT] = params.limit;',
      'header[H_OVERFLOW] = select(0u, 1u, raw > params.limit);',
      'header[H_STAMP] = params.stamp;',
    ]) expect(block).toContain(line);
  });

  it('finds the region of element i without select over an index, then writes lo, hi and the slot', () => {
    expect(b).toContain('if (regionEnd[q] <= i) { k += 1u; }');
    expect(b).toContain('if (k > 0u) { start = regionEnd[k - 1u]; }');
    expect(b).not.toMatch(/select\([^;]*regionEnd\[k - 1u\]/);
    expect(b).toContain('let slot = visibleIndices[regionBase[k] + i - start];');
    expect(b).toContain('keysOut[i] = entityIds[slot];');
    expect(b).toContain('keysOut[CAP + i] = sortableZBits(bounds[slot].z);');
    expect(b).toContain('valsOut[i] = slot;');
  });

  it('never lets a float operation touch the z: it stays bits', () => {
    expect(stripComments(gatherSource)).not.toMatch(/\bf32\b|vec[234]f\b|bitcast/);
    const z = body(gatherSource, 'sortableZBits');
    expect(z).toContain('if (zb == 0x80000000u) { zb = 0u; }');
    expect(z).toContain('return select(zb | 0x80000000u, ~zb, (zb & 0x80000000u) != 0u);');
  });
});

describe('upsweep_main, scan_main, scatter_main (§5.3 sort)', () => {
  const defs = constDefs(sortSource);

  it('digitOf takes the id for passes 0-2, the z key after', () => {
    expect(body(sortSource, 'digitOf')).toContain('select(hi, lo, p < LO_PASSES)');
  });

  it.each(['upsweep_main', 'scatter_main'])('%s: the tile guard depends only on workgroup_id and the read-only header', (entry) => {
    const b = body(sortSource, entry);
    expect(b).toContain('let n = header[H_INSTANCES];');
    expect(b).toContain('let t = wid.x;');
    const guard = b.indexOf('if (t * TILE >= n) { return; }');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(b.indexOf('workgroupBarrier'));
    expect(b.split('return')).toHaveLength(2); // the guard is the only return
  });

  it('upsweep: zero, barrier, count reading only the digit word, barrier, store the tile — 2 barriers', () => {
    const b = body(sortSource, 'upsweep_main');
    expect(textBarriers(b)).toBe(2);
    expect(executedBarriers(b, defs)).toBe(2);
    expect(b).toContain('let wordBase = select(CAP, 0u, p < LO_PASSES);');
    expect(b).toContain('atomicAdd(&wgHist[(keysIn[wordBase + i] >> shift) & DIGIT_MASK], 1u);');
    expect(b).toContain('hist.tiles[t * RADIX + lid] = atomicLoad(&wgHist[lid]);');
  });

  it('scan: 3 barriers in the text, 2 in the Hillis-Steele loop — read into v, barrier, add, barrier — 17 executed', () => {
    const b = body(sortSource, 'scan_main');
    expect(b).not.toContain('return');
    expect(textBarriers(b)).toBe(3);
    const header = /for\s*\(\s*var\s+off\s*=\s*1u\s*;\s*off\s*<\s*RADIX\s*;\s*off\s*<<=\s*1u\s*\)\s*\{/.exec(b);
    expect(header, 'the Hillis-Steele loop').not.toBeNull();
    const open = header!.index + header![0].length - 1;
    const loop = b.slice(open + 1, matchBrace(b, open));
    const parts = loop.split(/workgroupBarrier\s*\(\s*\)\s*;/);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/if\s*\(\s*d\s*>=\s*off\s*\)\s*\{\s*v\s*=\s*totals\[\s*d\s*-\s*off\s*\]\s*;\s*\}/);
    // select() evaluates totals[d - off] for d < off too: an out-of-range read.
    expect(parts[0]).not.toContain('select(');
    expect(parts[1]).toMatch(/totals\[\s*d\s*\]\s*\+=\s*v\s*;/);
    expect(parts[2].trim()).toBe('');
    const before = b.slice(0, header!.index);
    expect(textBarriers(before)).toBe(1);
    expect(before.lastIndexOf('totals[d] = sum;')).toBeLessThan(before.lastIndexOf('workgroupBarrier'));
    // Executed, from the loop bounds read above: 1 + 2 × log2(RADIX).
    expect(executedBarriers(b, defs)).toBe(1 + 2 * Math.log2(RADIX));
    expect(executedBarriers(b, defs)).toBe(17);
    expect(b).toContain('hist.digitBase[p * RADIX + d] = incl - sum;');
    expect(b).toMatch(/if \(d == RADIX - 1u && incl != n\) \{\s*atomicOr\(&hist\.diag\[0\], DIAG_SCAN_MISMATCH\);\s*\}/);
  });

  it('scatter: B0, then per round (a) mark, (b) count and read the cursor — no writes —, (c) write and move the cursor: 13', () => {
    const b = body(sortSource, 'scatter_main');
    expect(textBarriers(b)).toBe(4);
    expect(executedBarriers(b, defs)).toBe(1 + 3 * ROUNDS);
    expect(executedBarriers(b, defs)).toBe(13);
    const loops = [...b.matchAll(/for\s*\(\s*var\s+r\s*=\s*0u\s*;\s*r\s*<\s*ROUNDS\s*;\s*r\+\+\s*\)\s*\{/g)];
    const roundLoops = loops
      .map((m) => ({ at: m.index!, open: m.index! + m[0].length - 1 }))
      .map(({ at, open }) => ({ at, text: b.slice(open + 1, matchBrace(b, open)) }))
      .filter((l) => textBarriers(l.text) > 0);
    expect(roundLoops).toHaveLength(1);
    // Phase 0, before B0: preload, seed the cursors, clear the masks.
    const phase0 = b.slice(0, roundLoops[0].at);
    expect(textBarriers(phase0)).toBe(1);
    expect(phase0).toContain('cursor[lid] = hist.digitBase[p * RADIX + lid] + hist.tiles[t * RADIX + lid];');
    expect(phase0).toContain('atomicStore(&masks[lid * MASK_WORDS + w], 0u);');
    const [a, count, write, rest] = roundLoops[0].text.split(/workgroupBarrier\s*\(\s*\)\s*;/);
    expect(a).toContain('atomicOr(&masks[d * MASK_WORDS + word], bit);');
    expect(a).not.toMatch(/cursor\[|Out\[/);
    expect(count).toContain('rank += countOneBits(atomicLoad(&masks[d * MASK_WORDS + word]) & (bit - 1u));');
    expect(count).toContain('base = cursor[d];');
    expect(count).not.toMatch(/atomicStore|atomicOr|atomicAdd|Out\[|cursor\[[^\]]*\]\s*=[^=]/);
    expect(write).toContain('let dst = base + rank;');
    expect(write).toContain('atomicStore(&masks[d * MASK_WORDS + word], 0u);');
    expect(write).toContain('if (rank == total - 1u) { cursor[d] = base + total; }');
    expect(write).toContain('atomicOr(&hist.diag[0], DIAG_SCATTER_OOB);');
    expect(rest.trim()).toBe('');
  });

  it('scatter: the last pass writes the values only — every key write sits under p != LAST_PASS', () => {
    const b = body(sortSource, 'scatter_main');
    const at = b.search(/if\s*\(\s*p\s*!=\s*LAST_PASS\s*\)\s*\{/);
    expect(at).toBeGreaterThan(-1);
    const open = b.indexOf('{', at);
    const close = matchBrace(b, open);
    const keyWrites = [...b.matchAll(/keysOut\[/g)].map((m) => m.index!);
    expect(keyWrites).toHaveLength(2);
    for (const w of keyWrites) {
      expect(w).toBeGreaterThan(open);
      expect(w).toBeLessThan(close);
    }
    const guarded = b.slice(open + 1, close);
    expect(guarded).toContain('keysOut[dst] = lo[r];');
    expect(guarded).toContain('keysOut[CAP + dst] = hi[r];');
    const vals = b.indexOf('valsOut[dst] = val[r];');
    expect(vals).toBeGreaterThan(-1);
    expect(vals < open || vals > close).toBe(true);
  });

  it('the barrier counter multiplies loops and refuses a barrier under an if', () => {
    const toy = new Map([['N', '4u']]);
    expect(executedBarriers('workgroupBarrier(); for (var i = 0u; i < N; i++) { workgroupBarrier(); }', toy)).toBe(5);
    expect(executedBarriers('for (var s = 1u; s < 256u; s <<= 1u) { workgroupBarrier(); workgroupBarrier(); }', toy)).toBe(16);
    expect(() => executedBarriers('if (x) { workgroupBarrier(); }', toy)).toThrow();
  });
});

// ── The CPU model mirrors the barrier structure ────────────────────

describe('the CPU model has the phases the WGSL barriers make', () => {
  const N = 1100; // two tiles: one full, one partial

  function fixture(): { input: SortModelInput; bufs: SortModelBuffers } {
    const indirectArgs = new Uint32Array(TOTAL_DRAW_BUCKETS * ARG_WORDS);
    // Every element in the gather's first region (bucket 14), from visible-indices[0].
    indirectArgs[FIRST_TRANSPARENT_ARG * ARG_WORDS] = 6;
    indirectArgs[FIRST_TRANSPARENT_ARG * ARG_WORDS + ARG_INSTANCE_COUNT] = N;
    const bounds = new Float32Array(4 * N);
    for (let i = 0; i < N; i++) bounds[4 * i + 2] = (i * 7) % 13;
    const input: SortModelInput = {
      indirectArgs,
      visibleIndices: Uint32Array.from({ length: N }, (_, i) => i),
      boundsBits: new Uint32Array(bounds.buffer),
      entityIds: Uint32Array.from({ length: N }, (_, i) => (i * 37) % (MAX_EXTERNAL_ID + 1)),
      limit: N,
      stamp: 1,
    };
    const bufs: SortModelBuffers = {
      header: new Uint32Array(HEADER_WORDS),
      keysA: new Uint32Array(2 * CAP),
      keysB: new Uint32Array(2 * CAP),
      valsA: new Uint32Array(CAP),
      valsB: new Uint32Array(CAP),
      hist: new Uint32Array(HIST_WORDS),
    };
    return { input, bufs };
  }

  /** Distinct phases the model ran in its busiest workgroup, seen through the lane-order hook. */
  function phases(run: (schedule: Schedule) => void): number {
    const seen = new Map<number, Set<number>>();
    run({
      laneOrder(workgroup: number, phase: number): number[] {
        const set = seen.get(workgroup) ?? new Set<number>();
        set.add(phase);
        seen.set(workgroup, set);
        return Array.from({ length: WORKGROUP_SIZE }, (_, lane) => lane);
      },
    });
    return Math.max(0, ...[...seen.values()].map((s) => s.size));
  }

  const barriers = (src: string, entry: string) => executedBarriers(body(src, entry), constDefs(src));

  it('gather: 2 phases around its 1 barrier', () => {
    const { input, bufs } = fixture();
    const n = phases((s) => cpuGather(input, bufs, s));
    expect(n).toBe(2);
    expect(n - 1).toBe(barriers(gatherSource, 'gather_main'));
  });

  it('upsweep: 3 phases around its 2 barriers', () => {
    const { input, bufs } = fixture();
    cpuGather(input, bufs);
    const n = phases((s) => cpuUpsweep(0, bufs, s));
    expect(n).toBe(3);
    expect(n - 1).toBe(barriers(sortSource, 'upsweep_main'));
  });

  it('scan: 18 phases — the 17 barriers scan_main executes are its phase boundaries', () => {
    const { input, bufs } = fixture();
    cpuGather(input, bufs);
    cpuUpsweep(0, bufs);
    const n = phases((s) => cpuScan(0, bufs, s));
    expect(n - 1).toBe(barriers(sortSource, 'scan_main'));
    expect(n - 1).toBe(17);
  });

  it('scatter: phase 0 then (a), (b), (c) per round — 13 phases for 13 barriers, the last B3 closing round 3', () => {
    const { input, bufs } = fixture();
    cpuGather(input, bufs);
    cpuUpsweep(0, bufs);
    cpuScan(0, bufs);
    const n = phases((s) => cpuScatter(0, bufs, s));
    expect(n).toBe(1 + 3 * ROUNDS);
    expect(barriers(sortSource, 'scatter_main')).toBe(n);
  });
});
