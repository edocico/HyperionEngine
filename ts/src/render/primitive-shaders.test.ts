import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PRIMITIVE_LIBRARIES, UBER_DIRECTIVE, pieceMarker, composeTypeModule, composeTypeModules, composeUberModule,
  type PrimitivePieces,
} from './primitive-shaders';
import { primitiveGroup0LayoutEntries, textureTierLayoutEntries } from './primitive-bindings';
import { RenderPrimitiveType } from '../entity-handle';
import {
  stripComments, topLevelDecls, functionBody, callGraph, reachableFrom, bindingDecls, localNames, directives,
} from '../shaders/wgsl-analysis';

// Nothing here compiles WGSL (vitest cannot): these checks read the text the
// composer produces, and the call graph built from it. The GPU validation of
// the same modules is step 1's gate (design §7.3.2).

const g = globalThis as Record<string, unknown>;
g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

const files = import.meta.glob('../shaders/primitives/*.wgsl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const piece = (name: string): string => files[`../shaders/primitives/${name}.wgsl`] ?? '';
const libraries: Record<number, string> = {};
for (const l of PRIMITIVE_LIBRARIES) libraries[l.type] = piece(l.name);
const pieces: PrimitivePieces = { prelude: piece('prelude'), libraries };

const typeModules = composeTypeModules(pieces);
const uber = composeUberModule(pieces);
const allModules: Array<[string, string]> = [
  ...PRIMITIVE_LIBRARIES.map((l): [string, string] => [`type ${l.type} (${l.name})`, typeModules[l.type]]),
  ['uber', uber],
];

const preludeNames = new Set(topLevelDecls(pieces.prelude).map((d) => d.name));
const ENTRY_POINTS = new Set(['vs_main', 'fs_main', 'fs_occluder']);
/** Library names carry the prefix; SCREAMING_CASE constants carry it upper-cased (LINE_STROKE_TIE_EPS). */
const hasPrefix = (name: string, prefix: string): boolean => name.startsWith(prefix) || name.startsWith(prefix.toUpperCase());
/** The group-2 names: every @group(2) binding the prelude declares, and the helper that reads the table. */
const GROUP2_NAMES = [...bindingDecls(pieces.prelude).filter((b) => b.group === 2).map((b) => b.name), 'lightGroupOf'];
const BRANCH = /\b(?:if|switch|for|while|loop|discard)\b/;
const indexOrInfinity = (i: number): number => (i < 0 ? Infinity : i);

describe('primitive pieces', () => {
  it('finds the prelude and the six libraries, and nothing else', () => {
    const names = Object.keys(files).map((f) => f.replace('../shaders/primitives/', '').replace('.wgsl', '')).sort();
    expect(names).toEqual(['prelude', ...PRIMITIVE_LIBRARIES.map((l) => l.name)].sort());
    for (const name of names) expect(piece(name).trim().length, name).toBeGreaterThan(0);
  });

  it('PRIMITIVE_LIBRARIES: types 0-5 in RenderPrimitiveType order, quad and gradient lit', () => {
    expect(PRIMITIVE_LIBRARIES.map((l) => l.type)).toEqual([
      RenderPrimitiveType.Quad, RenderPrimitiveType.Line, RenderPrimitiveType.SDFGlyph,
      RenderPrimitiveType.BezierPath, RenderPrimitiveType.Gradient, RenderPrimitiveType.BoxShadow,
    ]);
    expect(PRIMITIVE_LIBRARIES.map((l) => l.prefix)).toEqual(['quad_', 'line_', 'msdf_', 'bezier_', 'gradient_', 'boxshadow_']);
    expect(PRIMITIVE_LIBRARIES.filter((l) => l.lit).map((l) => l.name)).toEqual(['quad', 'gradient']);
  });
});

describe('composer', () => {
  it('marks every piece, so a compiler error line can be traced to it', () => {
    expect(pieceMarker('line')).toBe('// --- piece: line ---');
    expect(uber).toContain(`${pieceMarker('prelude')}\n${pieces.prelude}`);
    for (const l of PRIMITIVE_LIBRARIES) {
      expect(uber).toContain(`${pieceMarker(l.name)}\n${pieces.libraries[l.type]}`);
      expect(typeModules[l.type]).toContain(`${pieceMarker(l.name)}\n${pieces.libraries[l.type]}`);
    }
  });

  it.each(allModules)('%s contains the prelude verbatim', (_label, module) => {
    expect(module.includes(pieces.prelude)).toBe(true);
  });

  it('composes one module per library type, each with its own library only', () => {
    expect(Object.keys(typeModules).map(Number)).toEqual(PRIMITIVE_LIBRARIES.map((l) => l.type));
    for (const l of PRIMITIVE_LIBRARIES) {
      expect(typeModules[l.type]).toBe(composeTypeModule(pieces, l.type));
      const foreign = topLevelDecls(typeModules[l.type])
        .map((d) => d.name)
        .filter((n) => !preludeNames.has(n) && !ENTRY_POINTS.has(n) && !hasPrefix(n, l.prefix));
      expect(foreign).toEqual([]);
    }
  });

  it('is total: empty or missing pieces and unknown types compose without throwing', () => {
    const empty: PrimitivePieces = { prelude: '', libraries: {} };
    expect(() => composeTypeModules(empty)).not.toThrow();
    expect(() => composeUberModule(empty)).not.toThrow();
    expect(composeUberModule(empty).split('\n')[0]).toBe(UBER_DIRECTIVE);
    expect(composeTypeModule(pieces, RenderPrimitiveType.Light2D)).toBe('');
    expect(composeTypeModule(pieces, -1)).toBe('');
  });
});

describe('the derivative_uniformity directive', () => {
  it('is the first line of the uber module, and its only directive', () => {
    expect(uber.split('\n')[0]).toBe(UBER_DIRECTIVE);
    expect(directives(uber)).toEqual([UBER_DIRECTIVE]);
  });

  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l.type] as const))('is absent from the %s module: its library compiles under the strict analysis', (_name, type) => {
    expect(directives(typeModules[type])).toEqual([]);
    expect(stripComments(typeModules[type])).not.toMatch(/\bdiagnostic\s*\(/);
  });
});

describe('generated entry points of the per-type modules', () => {
  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l] as const))('%s: occluder early-out, primType, fs_main and fs_occluder', (_name, l) => {
    const module = typeModules[l.type];
    const decls = topLevelDecls(module).map((d) => d.name);
    for (const entry of ENTRY_POINTS) expect(decls.filter((n) => n === entry), entry).toHaveLength(1);
    const vs = functionBody(module, 'vs_main')!;
    expect(vs).toContain('if (OCCLUDER_PASS && !castsInto(renderMeta[entityIdx * 2u + 1u], camera.occluderLayers)) { return culledVertex(); }');
    expect(vs).toContain(`var out = ${l.prefix}vs(position, entityIdx);`);
    expect(vs).toContain(`out.primType = ${l.type}u;`);
    // OccluderSeedStage selects its modules with code.includes('fn fs_occluder').
    expect(module).toMatch(/@fragment\s+fn fs_occluder\s*\(/);
    expect(module).toMatch(/@fragment\s+fn fs_main\s*\(/);
    expect(module).toMatch(/@vertex\s+fn vs_main\s*\(/);
    expect(functionBody(module, 'fs_main')!.trim()).toBe(`return ${l.prefix}fs(in);`);
    expect(functionBody(module, 'fs_occluder')!.trim()).toBe(`return ${l.prefix}occluder(in);`);
  });
});

describe('uber module', () => {
  it('has unique top-level names, every library name carrying its prefix', () => {
    const names = topLevelDecls(uber).map((d) => d.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    const unowned = names.filter((n) => !preludeNames.has(n) && n !== 'vs_main' && n !== 'fs_main'
      && !PRIMITIVE_LIBRARIES.some((l) => hasPrefix(n, l.prefix)));
    expect(unowned).toEqual([]);
    for (const l of PRIMITIVE_LIBRARIES) {
      for (const d of topLevelDecls(pieces.libraries[l.type])) expect(names).toContain(d.name);
    }
  });

  it('has no fs_occluder: it never seeds occluders', () => {
    expect(uber.includes('fn fs_occluder')).toBe(false);
  });

  it('clamps the type like cull.wgsl, and culls type 6 (Light2D) in the vertex stage', () => {
    const cull = readFileSync(new URL('../shaders/cull.wgsl', import.meta.url), 'utf8');
    const numPrimTypes = Number(/const NUM_PRIM_TYPES\s*:\s*u32\s*=\s*(\d+)u;/.exec(cull)?.[1]);
    expect(cull).toMatch(/min\(metaVal & 0xFFu, NUM_PRIM_TYPES - 1u\)/);
    const vs = functionBody(uber, 'vs_main')!;
    const clamp = /min\(renderMeta\[entityIdx \* 2u \+ 1u\] & 0xFFu, (\d+)u\)/.exec(vs);
    expect(Number(clamp?.[1])).toBe(numPrimTypes - 1);
    expect(Number(clamp?.[1])).toBe(RenderPrimitiveType.Light2D);
    for (const l of PRIMITIVE_LIBRARIES) {
      expect(vs).toContain(`case ${l.type}u: { out = ${l.prefix}vs(position, entityIdx); }`);
    }
    expect(vs).toContain('out.primType = primType;');
    expect(vs).not.toMatch(/OCCLUDER_PASS/);
  });

  it('has exactly one default in each switch: culledVertex in vs_main, a returned colour in fs_main', () => {
    const vs = functionBody(uber, 'vs_main')!;
    const fs = functionBody(uber, 'fs_main')!;
    expect(vs.match(/\bdefault\b/g)).toHaveLength(1);
    expect(fs.match(/\bdefault\b/g)).toHaveLength(1);
    expect(/default\s*:?\s*\{([^{}]*)\}/.exec(vs)?.[1].trim()).toBe('return culledVertex();');
    // Not a bare `discard;`: its behaviour is {Next}, and fs_main would not compile.
    expect(/default\s*:?\s*\{([^{}]*)\}/.exec(fs)?.[1].trim()).toMatch(/^return \w+_fs\(in\);$/);
    expect(fs).toMatch(/switch in\.primType \{/);
    for (const l of PRIMITIVE_LIBRARIES) {
      expect(fs).toMatch(new RegExp(`case ${l.type}u(?:, default)?: \\{ return ${l.prefix}fs\\(in\\); \\}`));
    }
  });

  it('fs_main calls the libraries\' fs and nothing else: no lighting after the switch', () => {
    const refs = [...callGraph(uber).get('fs_main')!].sort();
    expect(refs).toEqual(['VertexOutput', ...PRIMITIVE_LIBRARIES.map((l) => `${l.prefix}fs`)].sort());
  });
});

describe('library contract', () => {
  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l] as const))('%s: prefixed names, the four functions, no binding, entry point, directive or lighting', (_name, l) => {
    const lib = pieces.libraries[l.type];
    const p = l.prefix;
    const decls = topLevelDecls(lib);
    expect(decls.length).toBeGreaterThanOrEqual(4);
    expect(decls.map((d) => d.name).filter((n) => !hasPrefix(n, p))).toEqual([]);

    const code = stripComments(lib);
    expect(code).toMatch(new RegExp(`\\bfn ${p}vs\\(position: vec3f, entityIdx: u32\\) -> VertexOutput \\{`));
    expect(code).toMatch(new RegExp(`\\bfn ${p}fs\\(in: VertexOutput\\) -> vec4f \\{`));
    expect(code).toMatch(new RegExp(`\\bfn ${p}occluder\\(in: VertexOutput\\) -> vec4f \\{`));
    expect(code).toMatch(new RegExp(`\\bfn ${p}shade\\(in: VertexOutput\\) -> vec4f \\{`));

    expect(bindingDecls(lib)).toEqual([]);
    expect(code).not.toMatch(/@(?:group|binding)\s*\(/);
    expect(code).not.toMatch(/@(?:vertex|fragment|compute)\b/);
    expect(directives(lib)).toEqual([]);
    expect(code).not.toMatch(/^\s*(?:enable|requires|diagnostic)\b/m);
    expect(code).not.toMatch(new RegExp(`\\b(?:${GROUP2_NAMES.join('|')})\\b`));
  });

  it.each([['prelude', pieces.prelude], ...PRIMITIVE_LIBRARIES.map((l) => [l.name, pieces.libraries[l.type]])])(
    '%s never contains "fn fs_occluder", not even in a comment', (_name, src) => {
      // OccluderSeedStage takes any module containing that text for a caster.
      expect(src.includes('fn fs_occluder')).toBe(false);
    },
  );

  it('the prelude declares no entry point and no directive', () => {
    expect(stripComments(pieces.prelude)).not.toMatch(/@(?:vertex|fragment|compute)\b/);
    expect(directives(pieces.prelude)).toEqual([]);
  });

  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l] as const))('%s: only <prefix>fs may call applyLighting, and only if lit', (_name, l) => {
    const graph = callGraph(typeModules[l.type]);
    for (const d of topLevelDecls(pieces.libraries[l.type]).filter((x) => x.kind === 'fn')) {
      const calls = graph.get(d.name)!.has('applyLighting');
      expect(calls, d.name).toBe(d.name === `${l.prefix}fs` && l.lit);
    }
  });
});

describe('no local or parameter shadows a module-scope name', () => {
  it.each(allModules)('%s', (_label, module) => {
    const globals = new Set(topLevelDecls(module).map((d) => d.name));
    const clashes = localNames(module).filter((l) => globals.has(l.name)).map((l) => `${l.fn}: ${l.kind} ${l.name}`);
    expect(clashes).toEqual([]);
  });

  it('catches one (the check is not vacuous)', () => {
    const bad = { ...pieces, libraries: { ...pieces.libraries, 0: `${pieces.libraries[0]}\nfn quad_extra(lighting: f32) -> f32 { let camera = lighting; return camera; }\n` } };
    const module = composeTypeModule(bad, 0);
    const globals = new Set(topLevelDecls(module).map((d) => d.name));
    expect(localNames(module).filter((l) => globals.has(l.name)).map((l) => l.name)).toEqual(['lighting', 'camera']);
  });
});

describe('group 2 (the light buffer) is reached from fs_main only, and only by lit types', () => {
  it('takes the group-2 names from the prelude declarations', () => {
    expect(bindingDecls(pieces.prelude).filter((b) => b.group === 2)).toHaveLength(3);
    expect(GROUP2_NAMES).toContain('lightGroupOf');
  });

  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l] as const))('%s module', (_name, l) => {
    const module = typeModules[l.type];
    const fromFs = reachableFrom(module, 'fs_main');
    if (l.lit) for (const name of GROUP2_NAMES) expect(fromFs.has(name), name).toBe(true);
    else for (const name of GROUP2_NAMES) expect(fromFs.has(name), name).toBe(false);
    for (const entry of ['fs_occluder', 'vs_main']) {
      const reached = reachableFrom(module, entry);
      expect(GROUP2_NAMES.filter((n) => reached.has(n)), entry).toEqual([]);
    }
  });

  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l] as const))('uber case %s', (_name, l) => {
    const reached = reachableFrom(uber, `${l.prefix}fs`);
    expect(GROUP2_NAMES.some((n) => reached.has(n))).toBe(l.lit);
  });

  it('uber vs_main', () => {
    const reached = reachableFrom(uber, 'vs_main');
    expect(GROUP2_NAMES.filter((n) => reached.has(n))).toEqual([]);
  });
});

// Every binding an entry point reaches must be in the layout of the pipeline
// that runs it, with that stage visible. WebGPU reports a miss only when the
// pipeline is created, which no headless test sees.
type Layout = Map<number, Map<number, number>>;
function layoutOf(groups: Array<Array<{ binding: number; visibility: number }>>): Layout {
  return new Map(groups.map((entries, group) => [group, new Map(entries.map((e) => [e.binding, e.visibility]))]));
}
// ForwardPass's group 2 (forward-pass.ts setup): three FRAGMENT-only entries.
// forward-pass.test.ts ('group 2 is texture, filtering sampler, uniform') pins
// the pass side; this pins the shader side against the same visibility.
const forwardGroup2 = [0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT }));
const FORWARD_LAYOUT = layoutOf([primitiveGroup0LayoutEntries(), textureTierLayoutEntries(), forwardGroup2]);
const OCCLUDER_LAYOUT = layoutOf([primitiveGroup0LayoutEntries(), textureTierLayoutEntries()]);

function bindingViolations(module: string, entry: string, stage: number, layout: Layout): string[] {
  const reached = reachableFrom(module, entry);
  return bindingDecls(module).filter((b) => reached.has(b.name)).flatMap((b) => {
    const visibility = layout.get(b.group)?.get(b.binding);
    if (visibility === undefined) return [`${entry} reaches ${b.name} (group ${b.group}, binding ${b.binding}): not in the layout`];
    if ((visibility & stage) === 0) return [`${entry} reaches ${b.name}: not visible to its stage`];
    return [];
  });
}

describe('bindings against the pipeline layouts', () => {
  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l.type] as const))('%s module: ForwardPass (groups 0-2) and occluder (groups 0-1)', (_name, type) => {
    const module = typeModules[type];
    expect(bindingViolations(module, 'vs_main', GPUShaderStage.VERTEX, FORWARD_LAYOUT)).toEqual([]);
    expect(bindingViolations(module, 'fs_main', GPUShaderStage.FRAGMENT, FORWARD_LAYOUT)).toEqual([]);
    expect(bindingViolations(module, 'vs_main', GPUShaderStage.VERTEX, OCCLUDER_LAYOUT)).toEqual([]);
    expect(bindingViolations(module, 'fs_occluder', GPUShaderStage.FRAGMENT, OCCLUDER_LAYOUT)).toEqual([]);
    // Not vacuous: the vertex stage reads the camera and the transforms.
    expect(reachableFrom(module, 'vs_main').has('camera')).toBe(true);
  });

  it('uber module: ForwardPass (groups 0-2)', () => {
    expect(bindingViolations(uber, 'vs_main', GPUShaderStage.VERTEX, FORWARD_LAYOUT)).toEqual([]);
    expect(bindingViolations(uber, 'fs_main', GPUShaderStage.FRAGMENT, FORWARD_LAYOUT)).toEqual([]);
  });

  it('catches group 2 reached from fs_occluder, and the camera read in a fragment', () => {
    const lit = `${pieces.libraries[0]}\nfn quad_extra(in: VertexOutput) -> vec4f { return applyLighting(in, vec4f(camera.viewportWidth)); }\n`;
    const bad = { ...pieces, libraries: { ...pieces.libraries, 0: lit.replace('occluderSeed(in, quad_shade(in).a)', 'occluderSeed(in, quad_extra(in).a)') } };
    const module = composeTypeModule(bad, 0);
    const violations = bindingViolations(module, 'fs_occluder', GPUShaderStage.FRAGMENT, OCCLUDER_LAYOUT);
    expect(violations.some((v) => v.includes('lightBuffer'))).toBe(true);
    expect(violations.some((v) => v.includes('camera') && v.includes('stage'))).toBe(true);
  });
});

describe('fragment-only operations stay out of the vertex stage', () => {
  it.each(allModules)('%s', (_label, module) => {
    const fns = ['vs_main', ...reachableFrom(module, 'vs_main')].filter((n) => functionBody(module, n) !== null);
    const offenders = fns.filter((n) => /\bdiscard\b|\b(?:dpdx|dpdy|fwidth)(?:Coarse|Fine)?\s*\(|\btextureSample\s*\(/.test(functionBody(module, n)!));
    expect(offenders).toEqual([]);
  });
});

describe('coverage: a primitive casts exactly what it draws', () => {
  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l] as const))('%s: fs and occluder both reach <prefix>shade, first thing', (_name, l) => {
    const module = typeModules[l.type];
    for (const fn of [`${l.prefix}fs`, `${l.prefix}occluder`]) {
      expect(reachableFrom(module, fn).has(`${l.prefix}shade`), fn).toBe(true);
      // shade holds the derivatives: called before any branch, it runs in
      // uniform control flow in the per-type module.
      const body = functionBody(module, fn)!;
      const call = body.indexOf(`${l.prefix}shade(`);
      expect(call, fn).toBeGreaterThanOrEqual(0);
      expect(call, fn).toBeLessThan(indexOrInfinity(body.search(BRANCH)));
    }
  });
});

describe('behaviour kept from the six shaders', () => {
  it('line_shade takes fwidth(in.uv.y) before any branch', () => {
    const body = functionBody(typeModules[RenderPrimitiveType.Line], 'line_shade')!;
    const derivative = body.search(/fwidth\(\s*in\.uv\.y\s*\)/);
    expect(derivative).toBeGreaterThanOrEqual(0);
    expect(derivative).toBeLessThan(indexOrInfinity(body.search(BRANCH)));
  });

  it('msdf_shade samples the tier RAW: sampleTier, never sampleTierOrWhite', () => {
    const module = typeModules[RenderPrimitiveType.SDFGlyph];
    const calls = callGraph(module).get('msdf_shade')!;
    expect(calls.has('sampleTier')).toBe(true);
    expect(calls.has('sampleTierOrWhite')).toBe(false);
    expect(reachableFrom(module, 'fs_main').has('sampleTierOrWhite')).toBe(false);
  });

  it('quad, line and bezier answer packed index 0 white; gradient and box shadow never sample', () => {
    const answersWhite = (l: (typeof PRIMITIVE_LIBRARIES)[number]) => reachableFrom(typeModules[l.type], `${l.prefix}shade`).has('sampleTierOrWhite');
    const samples = (l: (typeof PRIMITIVE_LIBRARIES)[number]) => reachableFrom(typeModules[l.type], `${l.prefix}shade`).has('sampleTier');
    expect(PRIMITIVE_LIBRARIES.filter(answersWhite).map((l) => l.name)).toEqual(['quad', 'line', 'bezier']);
    expect(PRIMITIVE_LIBRARIES.filter(samples).map((l) => l.name)).toEqual(['quad', 'line', 'msdf-text', 'bezier']);
  });

  it('line_vs computes transparent from renderMeta bit 8 and keeps edgeScale perspective-interpolated', () => {
    const vs = functionBody(typeModules[RenderPrimitiveType.Line], 'line_vs')!;
    expect(vs).toContain('out.transparent = select(0u, 1u, (renderMeta[entityIdx * 2u + 1u] & 0x100u) != 0u);');
    expect(vs).toMatch(/OCCLUDER_PASS/);
    const output = /struct VertexOutput \{([\s\S]*?)\}/.exec(stripComments(pieces.prelude))![1];
    expect(output).toMatch(/@location\(6\) edgeScale: f32,/);
    expect(output).toMatch(/@location\(7\) @interpolate\(flat\) transparent: u32,/);
    expect(output).toMatch(/@location\(8\) @interpolate\(flat\) primType: u32,/);
  });
});
