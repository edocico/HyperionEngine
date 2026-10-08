import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deriveLightGroups, receiverLayer, LIT_PRIMITIVE_TYPES, SHADOWED_LIGHT_TYPES, BLEND_MIX, type LightGroupsInput } from './light-groups';
import { PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule } from './primitive-shaders';
import { loadPrimitivePieces } from './primitive-pieces.fixture';
import { bindingDecls, callGraph, functionBody, reachableFrom, stripComments } from '../shaders/wgsl-analysis';
import { extractFrustumPlanes, isSphereInFrustum, orthographic } from '../camera';

// Light layers (design 2026-09-26): layers with the same lights and, where a
// shadowed light reaches them, the same casters share a light buffer. Unity
// batches sorting layers the same way (LayerUtility.CanBatchLightsInLayer),
// minus its "consecutive layers" rule, which exists only because Unity draws
// sprites per sorting-layer range. Roles of the one mask field:
//   light    — the layers it lights; 0 lights nothing
//   receiver — ONE layer, its lowest bit; 0 is layer 0
//   occluder — the layers it shadows; 0 is every layer

const LIGHT = 6, CAST = 1 << 9, RECV = 1 << 10;
const POINT = 0, DIRECTIONAL = 2, GLOBAL = 3;
/** Light blend modes on the wire, renderMeta bits 14-15 (LightBlendMode in components.rs). */
const ADD = 0, SUB = 1, MIX = 2;

type E = {
  kind: 'light' | 'drawable'; mask?: number; flags?: number; type?: number; shadow?: number; range?: number;
  x?: number; y?: number; z?: number; r?: number;
  /** The row's z as raw f32 bits (-0, NaN), in place of `z`. */
  zBits?: number;
  /** The external id; default: the row. */
  id?: number;
  blend?: number;
};

/** Every `if (cond) { block }` of a comment-blanked WGSL body, `else if` and nested ones included. */
function branches(body: string): { cond: string; block: string }[] {
  const close = (s: string, from: number, open: string, shut: string): number => {
    for (let i = from, depth = 0; i < s.length; i++) {
      if (s[i] === open) depth++;
      else if (s[i] === shut && --depth === 0) return i;
    }
    return s.length;
  };
  return [...body.matchAll(/\bif\s*\(/g)].map((m) => {
    const p0 = m.index! + m[0].length - 1;
    const p1 = close(body, p0, '(', ')');
    const b0 = body.indexOf('{', p1);
    return { cond: body.slice(p0 + 1, p1), block: body.slice(b0, close(body, b0, '{', '}') + 1) };
  });
}

/**
 * A scene in the SoA layout of GPURenderState. The view spans x, y in [-10, 10],
 * and clip z = z: a sphere of radius r is in view for z in [-r, 1 + r]. A
 * light's range defaults to light()'s 100, an entity's external id to its row.
 */
function scene(es: E[]): LightGroupsInput {
  const n = es.length;
  const renderMeta = new Uint32Array(n * 2), primParams = new Float32Array(n * 8), bounds = new Float32Array(n * 4);
  const boundsBits = new Uint32Array(bounds.buffer);
  const entityIds = new Uint32Array(n);
  es.forEach((e, i) => {
    const mask = (e.mask ?? (e.kind === 'light' ? 0xffff : 0)) << 16;
    const lightWord = LIGHT | ((e.type ?? POINT) << 11) | ((e.blend ?? ADD) << 14);
    renderMeta[i * 2 + 1] = ((e.kind === 'light' ? lightWord : e.flags ?? 0) | mask) >>> 0;
    if (e.kind === 'light') primParams[i * 8 + 3] = e.range ?? 100;
    primParams[i * 8 + 7] = e.shadow ?? 0;
    bounds[i * 4] = e.x ?? 0;
    bounds[i * 4 + 1] = e.y ?? 0;
    if (e.zBits !== undefined) boundsBits[i * 4 + 2] = e.zBits;
    else bounds[i * 4 + 2] = e.z ?? 0;
    bounds[i * 4 + 3] = e.r ?? 1;
    entityIds[i] = e.id ?? i;
  });
  const cameraViewProjection = new Float32Array([0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return { entityCount: n, renderMeta, primParams, bounds, cameraViewProjection, entityIds };
}

const light = (mask?: number, shadow = 0, extra: Partial<E> = {}): E => ({ kind: 'light', mask, shadow, ...extra });
const drawable = (flags: number, mask = 0, extra: Partial<E> = {}): E => ({ kind: 'drawable', flags, mask, ...extra });

describe('deriveLightGroups', () => {
  it('default scene: one group, one SDF set — exactly today', () => {
    const g = deriveLightGroups(scene([light(undefined, 1), drawable(CAST | RECV)]));
    expect(g.groups).toEqual([{ layers: 1, sdfSet: 0 }]);
    expect(g.sdfSets).toEqual([{ occluderLayers: 1 }]);
    expect(g.layerToGroup).toEqual([0, 0]);
    expect(g.shadowedGlobalLight).toBe(false);
  });

  it('no shadowed light: no SDF set at all', () => {
    const g = deriveLightGroups(scene([light(undefined, 0), drawable(CAST | RECV)]));
    expect(g.groups).toEqual([{ layers: 1, sdfSet: -1 }]);
    expect(g.sdfSets).toEqual([]);
  });

  it('a light on layer 1 splits layers 0 and 1', () => {
    const g = deriveLightGroups(scene([light(0b01), light(0b10), drawable(RECV, 0b01), drawable(RECV, 0b10)]));
    expect(g.groups).toEqual([{ layers: 0b01, sdfSet: -1 }, { layers: 0b10, sdfSet: -1 }]);
    expect(g.layerToGroup[0]).toBe(0 | (1 << 4));
  });

  it('same lights, different casters: two groups, two SDF sets', () => {
    const g = deriveLightGroups(scene([
      light(0xffff, 1), drawable(RECV, 0b01), drawable(RECV, 0b10), drawable(CAST, 0b01), drawable(CAST, 0b10),
    ]));
    expect(g.groups).toEqual([{ layers: 0b01, sdfSet: 0 }, { layers: 0b10, sdfSet: 1 }]);
    expect(g.sdfSets).toEqual([{ occluderLayers: 0b01 }, { occluderLayers: 0b10 }]);
  });

  it('same lights and casters on two layers: one group', () => {
    const g = deriveLightGroups(scene([light(0xffff, 1), drawable(RECV, 0b01), drawable(RECV, 0b10), drawable(CAST, 0)]));
    expect(g.groups).toEqual([{ layers: 0b11, sdfSet: 0 }]);
    expect(g.sdfSets).toEqual([{ occluderLayers: 0b11 }]);
  });

  it('a shadowed layer that no caster shadows needs no SDF: an empty flood would change nothing', () => {
    // Found on the GPU: layer 1 got a set of its own with an empty seed, a
    // whole ~1.8 ms flood for nothing. Marching "no occluder" gives the same.
    const g = deriveLightGroups(scene([light(0xffff, 1), drawable(RECV, 0b01), drawable(RECV, 0b10), drawable(CAST, 0b01)]));
    expect(g.groups).toEqual([{ layers: 0b01, sdfSet: 0 }, { layers: 0b10, sdfSet: -1 }]);
    expect(g.sdfSets).toEqual([{ occluderLayers: 0b01 }]);
    const none = deriveLightGroups(scene([light(0xffff, 1), drawable(RECV)]));
    expect(none.groups).toEqual([{ layers: 1, sdfSet: -1 }]);
  });

  it('casters do not split layers that no shadowed light reaches', () => {
    const g = deriveLightGroups(scene([
      light(0xffff, 0), drawable(RECV, 0b01), drawable(RECV, 0b10), drawable(CAST, 0b01), drawable(CAST, 0b10),
    ]));
    expect(g.groups).toEqual([{ layers: 0b11, sdfSet: -1 }]);
  });

  it('mask 0 per role: an occluder shadows every layer, an explicit light mask 0 lights nothing', () => {
    const g = deriveLightGroups(scene([light(0, 1), drawable(CAST, 0), drawable(RECV, 0)]));
    expect(g.occluderMasks).toEqual([0xffff]);
    expect(g.lightMasks).toEqual([0]);
    // No light reaches layer 0, so no shadowed light either: no SDF.
    expect(g.groups).toEqual([{ layers: 1, sdfSet: -1 }]);
  });

  it('a receiver belongs to its lowest bit, and a multi-bit mask is flagged', () => {
    const one = deriveLightGroups(scene([light(0xffff), drawable(RECV, 0b100)]));
    expect(one.groups).toEqual([{ layers: 0b100, sdfSet: -1 }]);
    expect(one.multiBitReceiver).toBe(false);
    const multi = deriveLightGroups(scene([light(0xffff), drawable(RECV, 0b110)]));
    expect(multi.groups).toEqual([{ layers: 0b010, sdfSet: -1 }]);
    expect(multi.multiBitReceiver).toBe(true);
  });

  it('frustum: a light out of view does not split groups; a global light always counts', () => {
    const base = [light(0xffff), drawable(RECV, 0b01), drawable(RECV, 0b10)];
    const far = deriveLightGroups(scene([...base, light(0b10, 0, { x: 100, r: 5 })]));
    expect(far.groups).toHaveLength(1);
    const global = deriveLightGroups(scene([...base, light(0b10, 0, { x: 100, r: 3.4e38, type: GLOBAL })]));
    expect(global.groups).toHaveLength(2);
  });

  it('frustum is conservative at the edge: the CPU keeps every light the GPU could draw', () => {
    const base = [light(0xffff), drawable(RECV, 0b01), drawable(RECV, 0b10)];
    // The view ends at x = 10: a sphere of radius 5 touches it up to x = 15.
    expect(deriveLightGroups(scene([...base, light(0b10, 0, { x: 15.02, r: 5 })])).groups).toHaveLength(2);
    expect(deriveLightGroups(scene([...base, light(0b10, 0, { x: 15.2, r: 5 })])).groups).toHaveLength(1);
  });

  it('occluders out of view do not create SDF sets', () => {
    const g = deriveLightGroups(scene([
      light(0xffff, 1), drawable(RECV, 0b01), drawable(RECV, 0b10), drawable(CAST, 0), drawable(CAST, 0b10, { x: 100 }),
    ]));
    expect(g.sdfSets).toHaveLength(1);
    expect(g.groups).toEqual([{ layers: 0b11, sdfSet: 0 }]);
  });

  it('receivers out of view occupy no layer: an off-screen layer costs no group and no SDF flood', () => {
    // Review 2026-09-26: with the layer-1 receiver off screen, the layer-0-only
    // caster still split layer 1 into a set of its own — a whole flood (~1.8 ms)
    // for pixels nobody samples.
    const onScreen = [light(0xffff, 1), drawable(RECV, 0b01), drawable(CAST, 0), drawable(CAST, 0b01)];
    const g = deriveLightGroups(scene([...onScreen, drawable(RECV, 0b10, { x: 100 })]));
    expect(g.groups).toEqual([{ layers: 0b01, sdfSet: 0 }]);
    expect(g.sdfSets).toEqual([{ occluderLayers: 0b01 }]);
    // Conservative at the edge, like lights: a receiver the GPU could draw keeps its layer.
    const edge = deriveLightGroups(scene([...onScreen, drawable(RECV, 0b10, { x: 15.02, r: 5 })]));
    expect(edge.groups).toHaveLength(2);
    expect(edge.layerToGroup[0]).toBe(0 | (1 << 4));
  });

  it('a multi-bit receiver is flagged even out of view', () => {
    expect(deriveLightGroups(scene([light(0xffff), drawable(RECV, 0b110, { x: 100 })])).multiBitReceiver).toBe(true);
  });

  it('a transparent caster or light counts like an opaque one: the stages draw both blend modes', () => {
    const TRANSPARENT = 1 << 8;
    const g = deriveLightGroups(scene([
      light(0xffff, 1), drawable(RECV, 0b01), drawable(RECV, 0b10), drawable(CAST | TRANSPARENT, 0b01),
    ]));
    expect(g.groups).toEqual([{ layers: 0b01, sdfSet: 0 }, { layers: 0b10, sdfSet: -1 }]);
  });

  it('a receiver whose primitive never samples the light buffer occupies no layer', () => {
    // Review 2026-09-26: a line on layer 1 with receivesLight split a group off
    // for pixels that never read the light buffer (only quad and gradient do).
    const LINE = 1, GRADIENT = 4;
    const g = deriveLightGroups(scene([light(0xffff), light(0b10), drawable(RECV, 0b01), drawable(RECV | LINE, 0b110)]));
    expect(g.groups).toEqual([{ layers: 0b01, sdfSet: -1 }]);
    expect(g.multiBitReceiver).toBe(false);
    const lit = deriveLightGroups(scene([light(0xffff), light(0b10), drawable(RECV, 0b01), drawable(RECV | GRADIENT, 0b10)]));
    expect(lit.groups).toHaveLength(2);
  });

  it('LIT_PRIMITIVE_TYPES come from PRIMITIVE_LIBRARIES: quad and gradient', () => {
    expect([...LIT_PRIMITIVE_TYPES]).toEqual(PRIMITIVE_LIBRARIES.filter((l) => l.lit).map((l) => l.type));
    expect([...LIT_PRIMITIVE_TYPES]).toEqual([0, 4]);
  });

  it('LIT_PRIMITIVE_TYPES are exactly the types whose composed fs_main reaches the light buffer', () => {
    // Every composed module DECLARES group 2 (the prelude does): what makes a
    // type lit is that its fs_main reaches it. Names from the prelude's own
    // group-2 declarations, plus the helper that reads the group table.
    const pieces = loadPrimitivePieces();
    const prelude = stripComments(pieces.prelude);
    const light = [...bindingDecls(prelude).filter((b) => b.group === 2).map((b) => b.name), 'lightGroupOf'];
    expect(light).toHaveLength(4);
    const reaches = (src: string, entry: string): boolean => {
      const reached = reachableFrom(src, entry);
      return light.some((name) => reached.has(name));
    };
    const modules = composeTypeModules(pieces);
    expect(PRIMITIVE_LIBRARIES.filter((l) => reaches(stripComments(modules[l.type]), 'fs_main')).map((l) => l.type))
      .toEqual([...LIT_PRIMITIVE_TYPES]);
    // The uber draws every type through its <prefix>_fs: the same rule per case.
    const uber = stripComments(composeUberModule(pieces));
    expect(PRIMITIVE_LIBRARIES.filter((l) => reaches(uber, `${l.prefix}fs`)).map((l) => l.type))
      .toEqual([...LIT_PRIMITIVE_TYPES]);
  });

  it('renderer.ts registers each library piece under its own type, and composes in place', () => {
    const renderer = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
    const files = new Map<string, string>();
    for (const m of renderer.matchAll(/import (\w+) from '\.\/shaders\/primitives\/([\w-]+)\.wgsl\?raw'/g)) files.set(m[1], m[2]);
    const block = /const primitivePieces: PrimitivePieces = \{\s*prelude: (\w+),\s*libraries: \{([^}]*)\}/.exec(renderer);
    expect(block, 'the primitivePieces literal in renderer.ts').not.toBeNull();
    expect(files.get(block![1])).toBe('prelude');
    const registered = [...block![2].matchAll(/(\d+):\s*(\w+)/g)].map((m) => [Number(m[1]), files.get(m[2])] as const);
    expect(registered).toEqual(PRIMITIVE_LIBRARIES.map((l) => [l.type, l.name] as const));
    // In place, never reassigned: LightGroupsPass and the probes hold the object.
    expect(renderer).toMatch(/Object\.assign\(ForwardPass\.SHADER_SOURCES, composeTypeModules\(primitivePieces\)\)/);
    expect(renderer).toMatch(/ForwardPass\.UBER_SOURCE = composeUberModule\(primitivePieces\)/);
    expect(renderer).not.toMatch(/ForwardPass\.SHADER_SOURCES\s*=(?!=)/);
  });

  it('classifies the primitive type exactly as cull.wgsl does: anything past Light2D is a light', () => {
    // Rust now rejects SetRenderPrimitive > 6, but a value that still arrives
    // (an old snapshot) is drawn by LightAccumStage as a light: the grouping
    // must count it as one, or it lights layers its group was not keyed for.
    const cull = readFileSync(new URL('../shaders/cull.wgsl', import.meta.url), 'utf8');
    expect(cull).toMatch(/primType = min\(metaVal & 0xFFu, NUM_PRIM_TYPES - 1u\);/);
    const PAST_LAST = 7;
    const g = deriveLightGroups(scene([light(0xffff), drawable(RECV, 0b01), drawable(RECV, 0b10), drawable(PAST_LAST | CAST, 0b10)]));
    expect(g.lightMasks).toContain(0b10);
    expect(g.occluderMasks).toEqual([]);
    expect(g.groups).toHaveLength(2);
  });

  it('a light on an unoccupied layer changes nothing', () => {
    const g = deriveLightGroups(scene([light(0xffff, 1), light(0b1000), drawable(CAST | RECV)]));
    expect(g.groups).toEqual([{ layers: 1, sdfSet: 0 }]);
    expect(g.lightMasks).toContain(0b1000);
  });

  it('zero receivers: one fictitious group, so the light buffer stays valid', () => {
    const g = deriveLightGroups(scene([light(0xffff, 1), drawable(CAST)]));
    expect(g.groups).toEqual([{ layers: 1, sdfSet: -1 }]);
    expect(g.sdfSets).toEqual([]);
    expect(deriveLightGroups(scene([])).groups).toEqual([{ layers: 1, sdfSet: -1 }]);
  });

  it('16 layers, 16 groups, 16 sets: every nibble of the table used', () => {
    const es: E[] = [];
    for (let b = 0; b < 16; b++) es.push(drawable(CAST | RECV, 1 << b), light(1 << b, 1));
    const g = deriveLightGroups(scene(es));
    expect(g.groups).toHaveLength(16);
    expect(g.sdfSets).toHaveLength(16);
    expect(g.layerToGroup).toEqual([0x76543210, 0xfedcba98]);
  });

  it('receiverLayer: the lowest set bit, 0 for mask 0', () => {
    expect(receiverLayer(0)).toBe(0);
    expect(receiverLayer(0b1000)).toBe(3);
    expect(receiverLayer(0b1010)).toBe(1);
    expect(receiverLayer(0x8000)).toBe(15);
  });

  it('a shadowed directional light gets an SDF set like a point, wherever its transform is', () => {
    const sun = (shadow: number) => light(0xffff, shadow, { type: DIRECTIONAL, x: 100, r: 3.4e38 });
    const on = deriveLightGroups(scene([sun(1), drawable(CAST | RECV)]));
    expect(on.groups).toEqual([{ layers: 1, sdfSet: 0 }]);
    expect(on.sdfSets).toEqual([{ occluderLayers: 1 }]);
    expect(deriveLightGroups(scene([sun(0), drawable(CAST | RECV)])).groups).toEqual([{ layers: 1, sdfSet: -1 }]);
  });

  it('a sun whose shadow has no length (range <= 0) gets no SDF set: nothing would read the flood', () => {
    // Review wf_cf354af4-c53 [5]: such a sun cost a seed and a full flood
    // (~1.8 ms at 1080p) every frame for an image identical to shadow 0.
    const sun = (range: number) => light(0xffff, 1, { type: DIRECTIONAL, x: 100, r: 3.4e38, range });
    for (const range of [0, -5]) {
      const g = deriveLightGroups(scene([sun(range), drawable(CAST | RECV)]));
      expect(g.sdfSets, `range ${range}`).toEqual([]);
      expect(g.groups, `range ${range}`).toEqual([{ layers: 1, sdfSet: -1 }]);
    }
    expect(deriveLightGroups(scene([sun(0.5), drawable(CAST | RECV)])).sdfSets).toEqual([{ occluderLayers: 1 }]);
    // Why the shader reads no SDF for it: the range is clamped at 0, so the
    // ray's length is 0, and sunShadow returns before its first read.
    const wgsl = stripComments(readFileSync(new URL('../shaders/light-accum.wgsl', import.meta.url), 'utf8'));
    expect(functionBody(wgsl, 'directionalRay')).toMatch(/min\(\s*max\(\s*primParams\[e \* 8u \+ 3u\]\s*,\s*0\.0\s*\)/);
    expect(functionBody(wgsl, 'sunShadow')).toMatch(/if\s*\(\s*travel\s*<\s*1\.0\s*\)\s*\{\s*return\s+1\.0\s*;/);
  });

  it('a sun shadows only the layers in its mask', () => {
    const g = deriveLightGroups(scene([
      light(0b10, 1, { type: DIRECTIONAL, r: 3.4e38 }), light(0b01), drawable(RECV, 0b01), drawable(RECV, 0b10), drawable(CAST, 0),
    ]));
    expect(g.groups).toEqual([{ layers: 0b01, sdfSet: -1 }, { layers: 0b10, sdfSet: 0 }]);
  });

  it('counts as shadowed exactly the light types light-accum.wgsl marches (shadowedLightType ↔ SHADOWED_LIGHT_TYPES)', () => {
    // The shader gate and this one must change together: a type the shader
    // shadows but the grouping does not count gets no SDF set and never
    // shadows; the other way round, a flood nobody reads (~1.8 ms).
    const wgsl = stripComments(readFileSync(new URL('../shaders/light-accum.wgsl', import.meta.url), 'utf8'));
    const ids = new Map([...wgsl.matchAll(/const\s+([A-Z_]+)\s*:\s*u32\s*=\s*(\d+)u\s*;/g)].map((m) => [m[1], Number(m[2])]));
    expect(ids.get('LIGHT_TYPE_SHIFT')).toBe(11);
    const gate = functionBody(wgsl, 'shadowedLightType');
    expect(gate, 'fn shadowedLightType in light-accum.wgsl').not.toBeNull();
    const types = [...gate!.matchAll(/kind\s*==\s*([A-Z_]+)/g)].map((m) => ids.get(m[1]));
    expect(types.every((t) => t !== undefined)).toBe(true);
    expect([...types].sort()).toEqual([...SHADOWED_LIGHT_TYPES].sort());
    expect(types).not.toContain(ids.get('GLOBAL'));
    // Each gated type reaches a march in fs_main. A type both lists count but
    // no branch marches (a sprite light added to the gates in step 8 without
    // its branch) floods an SDF set nothing reads, and never shadows.
    const main = functionBody(wgsl, 'fs_main')!;
    const marched = new Set<number | undefined>();
    for (const { cond, block } of branches(main)) {
      if (!/\b(?:pointShadow|sunShadow)\(/.test(block)) continue;
      for (const m of cond.matchAll(/kind\s*==\s*([A-Z_]+)/g)) marched.add(ids.get(m[1]));
    }
    expect([...marched].sort()).toEqual([...types].sort());
    // …and no other march: one call of each, from fs_main only.
    expect(main.match(/\b(?:pointShadow|sunShadow)\(/g)).toHaveLength(2);
    for (const [fn, callees] of callGraph(wgsl)) {
      if (fn !== 'fs_main') expect(callees.has('pointShadow') || callees.has('sunShadow'), `${fn} calls a march`).toBe(false);
    }
    // One road to a shadow: slot 7 read once, through the gate.
    expect(wgsl.match(/primParams\[p \+ 7u\]/g)).toHaveLength(1);
    expect(wgsl).toMatch(/select\(0\.0, clamp\(primParams\[p \+ 7u\], 0\.0, 1\.0\), shadowedLightType\(kind\)\)/);
    // And in behaviour, over all eight wire values of the type field.
    for (let t = 0; t < 8; t++) {
      const g = deriveLightGroups(scene([light(0xffff, 1, { type: t, r: 3.4e38 }), drawable(CAST | RECV)]));
      expect(g.sdfSets.length, `light type ${t}`).toBe(types.includes(t) ? 1 : 0);
    }
  });

  it('a global light never shadows: its shadowIntensity makes no SDF set and raises shadowedGlobalLight', () => {
    const glob = (shadow: number) => light(0xffff, shadow, { type: GLOBAL, r: 3.4e38 });
    const g = deriveLightGroups(scene([glob(1), drawable(CAST | RECV)]));
    expect(g.groups).toEqual([{ layers: 1, sdfSet: -1 }]);
    expect(g.sdfSets).toEqual([]);
    expect(g.shadowedGlobalLight).toBe(true);
    expect(deriveLightGroups(scene([glob(0), drawable(CAST | RECV)])).shadowedGlobalLight).toBe(false);
    const withPoint = deriveLightGroups(scene([glob(1), light(0xffff, 1), drawable(CAST | RECV)]));
    expect(withPoint.groups).toEqual([{ layers: 1, sdfSet: 0 }]);
    expect(withPoint.shadowedGlobalLight).toBe(true);
  });

  it('renderer.ts warns once, in dev builds, about a shadowed global light', () => {
    // createRenderer needs a GPU: the wiring is pinned on the text, like the
    // piece registration above.
    const renderer = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
    expect(renderer).toMatch(/let warnedShadowedGlobalLight = false;/);
    const block = renderer.slice(renderer.indexOf('frameState.lightGroups = deriveLightGroups(frameState);'));
    expect(block).toMatch(/if \(dev && frameState\.lightGroups\.shadowedGlobalLight && !warnedShadowedGlobalLight\) \{\s*warnedShadowedGlobalLight = true;\s*console\.warn\(/);
  });
});

// ── The light list (round step 7) ────────────────────────────────────────────
// Every light is drawn from ONE list deriveLightGroups builds in its scan: the
// lights the cull's EXACT sphere test keeps (no grouping margin), ordered by
// blend class (add and sub before mix), world z back to front, then external
// id, the higher id last (round plan §2, "Passo 7").

/** mulberry32, as transparent-sort-reference.test.ts: a failure replays. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The external ids of a frame's light list, in draw order. */
const drawn = (input: LightGroupsInput): number[] => [...deriveLightGroups(input).lightIds];

/** The default camera's projection at 16:9, at the origin (CameraAPI: 20 units tall at zoom 1, near -1, far 1000). */
const ENGINE_VIEW = orthographic(-160 / 9, 160 / 9, -10, 10, -1, 1000);

describe('deriveLightGroups: the light list (round step 7)', () => {
  it('lists the slots of the lights in view in draw order, with their ids, in fresh arrays', () => {
    const s = scene([drawable(RECV), light(0xffff, 0, { id: 7 }), drawable(CAST), light(0xffff, 0, { id: 3, x: 100 }), light(0xffff, 0, { id: 9 })]);
    const g = deriveLightGroups(s);
    // A call on another scene must not touch what an earlier call returned:
    // arrays reused across calls (subarray views of one module buffer, say)
    // would rewrite them, and the renderer and engine.lighting.groups each
    // hold one.
    const other = deriveLightGroups(scene([light(0xffff, 0, { id: 3 })]));
    expect([...g.lightOrder]).toEqual([1, 4]);
    expect([...g.lightIds]).toEqual([7, 9]);
    expect(other.lightOrder.buffer).not.toBe(g.lightOrder.buffer);
    expect(other.lightIds.buffer).not.toBe(g.lightIds.buffer);
    g.lightOrder[0] = 99;  // the caller owns what it got: the next frame's list is new
    expect([...deriveLightGroups(s).lightOrder]).toEqual([1, 4]);
  });

  it("takes the cull's exact sphere test, not the grouping margin: a light in the margin keys the groups but is not drawn", () => {
    const g = deriveLightGroups(scene([
      light(0b01), light(0b10, 0, { x: 15.02, r: 5 }), light(0b100, 0, { x: 14.98, r: 5 }),
      drawable(RECV, 0b01), drawable(RECV, 0b10), drawable(RECV, 0b100),
    ]));
    expect([...g.lightOrder]).toEqual([0, 2]);
    expect([...g.lightMasks].sort((a, b) => a - b)).toEqual([0b01, 0b10, 0b100]);
    // The same strict test on both sides: a sphere is culled when dist < -radius.
    const cull = stripComments(readFileSync(new URL('../shaders/cull.wgsl', import.meta.url), 'utf8'));
    expect(cull).toMatch(/let dist = dot\(plane\.xyz, center\) \+ plane\.w;\s*if \(dist < -radius\)/);
    expect(readFileSync(new URL('../camera.ts', import.meta.url), 'utf8')).toMatch(/if \(dist < -radius\) return false;/);
  });

  it('lists exactly the spheres isSphereInFrustum keeps at their bare radius, near every plane of the default camera', () => {
    // 600 spheres within 0.05 of tangency with one of the six planes (near -1,
    // far 1000 included): the margin, or any other test, lists another set.
    const rand = mulberry32(7);
    // [axis, the plane's coordinate, +1 when the view lies above it on that axis]
    const planes: Array<[number, number, number]> = [[0, -160 / 9, 1], [0, 160 / 9, -1], [1, -10, 1], [1, 10, -1], [2, 1, -1], [2, -1000, 1]];
    const lights: E[] = [];
    for (let k = 0; k < 600; k++) {
      const [axis, at, inward] = planes[k % 6];
      const r = 0.5 + 19.5 * rand();
      const c = [(rand() * 2 - 1) * 8, (rand() * 2 - 1) * 5, -rand() * 500];
      c[axis] = at - inward * (r + (rand() * 2 - 1) * 0.05);
      lights.push(light(0xffff, 0, { x: c[0], y: c[1], z: c[2], r }));
    }
    const s = { ...scene(lights), cameraViewProjection: ENGINE_VIEW };
    const fp = extractFrustumPlanes(ENGINE_VIEW);
    const b = s.bounds;
    const want = lights.map((_, i) => i).filter((i) => isSphereInFrustum(fp, b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]));
    expect(want.length).toBeGreaterThan(100);
    expect(want.length).toBeLessThan(500);
    expect([...deriveLightGroups(s).lightOrder].sort((x, y) => x - y)).toEqual(want);
  });

  it('add and sub before mix, whatever their z or id', () => {
    expect(drawn(scene([
      light(0xffff, 0, { id: 1, blend: MIX, z: 0 }), light(0xffff, 0, { id: 2, z: 0.9 }),
      light(0xffff, 0, { id: 3, blend: SUB, z: 0.5 }), light(0xffff, 0, { id: 4, blend: MIX, z: -0.5 }),
    ]))).toEqual([3, 2, 4, 1]);
  });

  it('within a class, back to front: the smaller world z first (a 2D light: the larger depth)', () => {
    expect(drawn(scene([
      light(0xffff, 0, { id: 1, z: 0.75, r: 5 }), light(0xffff, 0, { id: 2, z: -0.5, r: 5 }),
      light(0xffff, 0, { id: 3, z: -3, r: 5 }), light(0xffff, 0, { id: 4, z: 0.25, r: 5 }),
    ]))).toEqual([3, 2, 4, 1]);
  });

  it('at equal z the higher external id is drawn later, in front (the 5b rule); -0 equals +0', () => {
    expect(drawn(scene([light(0xffff, 0, { id: 40 }), light(0xffff, 0, { id: 7 }), light(0xffff, 0, { id: 1000 })]))).toEqual([7, 40, 1000]);
    // sortableZBits maps -0 to +0, as the 5b gather does. Without that step
    // -0 keys 0x7FFFFFFF, below +0's 0x80000000, and is drawn first whatever
    // its id: so the -0 light has the HIGHER id, in the earlier slot.
    expect(drawn(scene([light(0xffff, 0, { id: 9, zBits: 0x80000000 }), light(0xffff, 0, { id: 4, z: 0 })]))).toEqual([4, 9]);
    expect(drawn(scene([light(0xffff, 0, { id: 4, zBits: 0x80000000 }), light(0xffff, 0, { id: 9, z: 0 })]))).toEqual([4, 9]);
  });

  it('keys z by its bits as the GPU holds them: a NaN z has a fixed place, never left to the sort', () => {
    // sortableZBits: +NaN after +Inf, -NaN before -Inf. A float comparator is
    // inconsistent with a NaN, and the order would depend on the sort algorithm.
    const s = scene([
      light(0xffff, 0, { zBits: 0x7fc00000 }), light(0xffff, 0, { z: 0.5 }),
      light(0xffff, 0, { zBits: 0xffc00000 }), light(0xffff, 0, { z: -0.5 }),
    ]);
    expect([...deriveLightGroups(s).lightOrder]).toEqual([2, 3, 1, 0]);
  });

  it('is a function of the ECS state: the same lights in other slots give the same ids in the same order', () => {
    // A despawn swap-removes rows (render_state.rs), snapshot_restore reassigns the slots.
    const lights = [
      light(0xffff, 0, { id: 11, z: 0.5, blend: MIX }), light(0xffff, 0, { id: 12, z: 0.5 }), light(0xffff, 0, { id: 13, z: 0.1, blend: MIX }),
      light(0xffff, 0, { id: 14, z: 0.1, blend: SUB }), light(0xffff, 0, { id: 15, z: 0.5, blend: MIX }),
    ];
    for (const perm of [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 4, 0, 3, 2]]) {
      expect(drawn(scene(perm.map((p) => lights[p]))), perm.join()).toEqual([14, 12, 13, 11, 15]);
    }
  });

  it('lists what the cull draws as a light: a mask-0 light, a sprite light, a type past Light2D; the unclaimed blend 3 sorts with add', () => {
    // vs_main drops a mask-0 light in every group, fs_main discards a sprite
    // light until step 8, and cull.wgsl clamps a type past 6 to Light2D.
    const SPRITE = 4, PAST_LAST = 7;
    expect(drawn(scene([light(0, 0, { id: 1 }), light(0xffff, 0, { id: 2, type: SPRITE }), drawable(PAST_LAST, 0xffff, { id: 3 }), drawable(RECV, 0, { id: 4 })])))
      .toEqual([1, 2, 3]);
    // Rust stores a 3 (masked, never rejected): light-accum.wgsl draws it like add, so it sorts with add.
    expect(drawn(scene([light(0xffff, 0, { id: 1, blend: MIX }), light(0xffff, 0, { id: 2, blend: 3 })]))).toEqual([2, 1]);
  });

  it('lists a global or directional light wherever its transform is (radius f32::MAX), ordered by z like any other', () => {
    expect(drawn(scene([
      light(0xffff, 0, { id: 1, type: GLOBAL, x: 1e6, z: 5, r: 3.4e38 }),
      light(0xffff, 0, { id: 2, type: DIRECTIONAL, x: -1e6, r: 3.4e38 }),
    ]))).toEqual([2, 1]);
  });

  it('a light whose z leaves near or far by more than its radius is not listed (decision 4)', () => {
    // scene()'s camera keeps z in [-r, 1 + r].
    expect(drawn(scene([
      light(0xffff, 0, { id: 1, z: -1 }), light(0xffff, 0, { id: 2, z: -1.0001 }),
      light(0xffff, 0, { id: 3, z: 2 }), light(0xffff, 0, { id: 4, z: 2.0001 }),
    ]))).toEqual([1, 3]);
    // The default camera (near -1, far 1000, at z 0): a light of range 5 is listed for z in [-1005, 6].
    expect(drawn({ ...scene([
      light(0xffff, 0, { id: 1, z: 6, r: 5 }), light(0xffff, 0, { id: 2, z: 6.01, r: 5 }),
      light(0xffff, 0, { id: 3, z: -1005, r: 5 }), light(0xffff, 0, { id: 4, z: -1005.01, r: 5 }),
    ]), cameraViewProjection: ENGINE_VIEW })).toEqual([3, 1]);
  });

  it('without a usable id column the slot stands in for every id: all or nothing, never read past it', () => {
    const s = scene([light(0xffff, 0, { id: 50 }), light(0xffff, 0, { id: 2 }), light(0xffff, 0, { id: 99, z: -0.5 })]);
    expect([...deriveLightGroups(s).lightIds]).toEqual([99, 2, 50]);
    for (const entityIds of [undefined, new Uint32Array(0), s.entityIds!.slice(0, 2)]) {
      const g = deriveLightGroups({ ...s, entityIds });
      expect([...g.lightOrder], `${entityIds?.length ?? 'no'} ids`).toEqual([2, 0, 1]);
      expect([...g.lightIds]).toEqual([2, 0, 1]);
    }
  });

  it('an empty world, or no light in view: empty lists', () => {
    for (const s of [scene([]), scene([drawable(RECV), light(0xffff, 0, { x: 100 })])]) {
      const g = deriveLightGroups(s);
      expect(g.lightOrder).toHaveLength(0);
      expect(g.lightIds).toHaveLength(0);
    }
  });

  it("BLEND_MIX and the blend field's shift are Rust's (LightBlendMode, RENDER_META_LIGHT_BLEND_SHIFT)", () => {
    const rust = readFileSync(new URL('../../../crates/hyperion-core/src/components.rs', import.meta.url), 'utf8');
    expect(Number(/pub const RENDER_META_LIGHT_BLEND_SHIFT: u32 = (\d+);/.exec(rust)?.[1])).toBe(14);
    const modes = new Map([.../pub enum LightBlendMode \{([^}]*)\}/.exec(rust)![1].matchAll(/(\w+)\s*=\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
    expect(modes).toEqual(new Map([['Add', ADD], ['Sub', SUB], ['Mix', MIX]]));
    expect(BLEND_MIX).toBe(modes.get('Mix'));
  });

  it('renderer.ts hands the slot -> id column to the grouping: FrameState.entityIds = state.entityIds', () => {
    // createRenderer needs a GPU: the wiring is pinned on the text.
    const renderer = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
    // Bounded to the literal: renderer.ts already says `entityIds: state.entityIds,`
    // twice further down (the sort probe's snapshot, the debug probe).
    const start = renderer.indexOf('const frameState: FrameState = {');
    expect(start).toBeGreaterThan(-1);
    const literal = renderer.slice(start, renderer.indexOf('};', start));
    expect(literal).toMatch(/\n\s*entityIds: state\.entityIds,\n/);
    expect(renderer).toMatch(/frameState\.lightGroups = deriveLightGroups\(frameState\);/);
  });
});
