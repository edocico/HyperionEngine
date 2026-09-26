import { describe, it, expect } from 'vitest';
import { deriveLightGroups, receiverLayer, type LightGroupsInput } from './light-groups';

// Light layers (design 2026-09-26): layers with the same lights and, where a
// shadowed light reaches them, the same casters share a light buffer. Unity
// batches sorting layers the same way (LayerUtility.CanBatchLightsInLayer),
// minus its "consecutive layers" rule, which exists only because Unity draws
// sprites per sorting-layer range. Roles of the one mask field:
//   light    — the layers it lights; 0 lights nothing
//   receiver — ONE layer, its lowest bit; 0 is layer 0
//   occluder — the layers it shadows; 0 is every layer

const LIGHT = 6, CAST = 1 << 9, RECV = 1 << 10;
const POINT = 0, GLOBAL = 3;

type E = { kind: 'light' | 'drawable'; mask?: number; flags?: number; type?: number; shadow?: number; x?: number; r?: number };

/** A scene in the SoA layout of GPURenderState. The view spans x, y in [-10, 10]. */
function scene(es: E[]): LightGroupsInput {
  const n = es.length;
  const renderMeta = new Uint32Array(n * 2), primParams = new Float32Array(n * 8), bounds = new Float32Array(n * 4);
  es.forEach((e, i) => {
    const mask = (e.mask ?? (e.kind === 'light' ? 0xffff : 0)) << 16;
    renderMeta[i * 2 + 1] = ((e.kind === 'light' ? LIGHT | ((e.type ?? POINT) << 11) : e.flags ?? 0) | mask) >>> 0;
    primParams[i * 8 + 7] = e.shadow ?? 0;
    bounds[i * 4] = e.x ?? 0;
    bounds[i * 4 + 3] = e.r ?? 1;
  });
  const cameraViewProjection = new Float32Array([0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return { entityCount: n, renderMeta, primParams, bounds, cameraViewProjection };
}

const light = (mask?: number, shadow = 0, extra: Partial<E> = {}): E => ({ kind: 'light', mask, shadow, ...extra });
const drawable = (flags: number, mask = 0, extra: Partial<E> = {}): E => ({ kind: 'drawable', flags, mask, ...extra });

describe('deriveLightGroups', () => {
  it('default scene: one group, one SDF set — exactly today', () => {
    const g = deriveLightGroups(scene([light(undefined, 1), drawable(CAST | RECV)]));
    expect(g.groups).toEqual([{ layers: 1, sdfSet: 0 }]);
    expect(g.sdfSets).toEqual([{ occluderLayers: 1 }]);
    expect(g.layerToGroup).toEqual([0, 0]);
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
});
