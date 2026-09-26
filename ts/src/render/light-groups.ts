import { extractFrustumPlanes, isSphereInFrustum } from '../camera';

/**
 * Light layers (Phase 17, design 2026-09-26): which receiver layers share a
 * light buffer, and which of those share an SDF.
 *
 * The one mask field in renderMeta word 1, bits 16-31, has a role per entity:
 * - light (primType 6): the layers it lights; 0 lights nothing;
 * - receiver (bit 10): ONE layer, its lowest bit; 0 is layer 0;
 * - occluder (bit 9): the layers it shadows; 0 is every layer.
 *
 * Two occupied layers share a group when the same lights reach them and, if a
 * shadowed light reaches them, the same casters shadow them. That is Unity's
 * `LayerUtility.CanBatchLightsInLayer`, minus its "consecutive layers" rule:
 * Unity draws sprites per sorting-layer range, Hyperion in one ForwardPass.
 * Groups whose caster part is the same share one SDF set; a group that no
 * shadowed light reaches has none.
 *
 * Keys come from the distinct mask VALUES, not from entities, so the groups do
 * not change while things move — only when a value appears or goes, or a light
 * or occluder enters or leaves the view.
 */

export interface LightGroup {
  /** The receiver layers of this group, as a 16-bit mask. */
  layers: number;
  /** Index into `sdfSets`, or -1: no shadowed light reaches this group. */
  sdfSet: number;
}

export interface LightGroups {
  /** At least one: a fictitious `{layers: 1, sdfSet: -1}` when there is no receiver. */
  groups: LightGroup[];
  /** One per distinct caster set. `occluderLayers`: the layers of the groups that use it. */
  sdfSets: Array<{ occluderLayers: number }>;
  /** Layer → group index, 4 bits per layer: [layers 0-7, layers 8-15]. */
  layerToGroup: [number, number];
  /** A receiver had more than one layer bit: only its lowest counts. */
  multiBitReceiver: boolean;
  /** The distinct light mask values in view: what splits the groups. */
  lightMasks: number[];
  /** The distinct occluder mask values in view, 0 normalised to 0xFFFF. */
  occluderMasks: number[];
}

/** The SoA columns of `GPURenderState` / `FrameState` the grouping reads. */
export interface LightGroupsInput {
  entityCount: number;
  renderMeta: Uint32Array;
  primParams: Float32Array;
  bounds: Float32Array;
  cameraViewProjection: Float32Array;
}

const LIGHT2D = 6;
const CASTS_SHADOW = 1 << 9;
const RECEIVES_LIGHT = 1 << 10;
const LIGHT_TYPE_SHIFT = 11;
const POINT = 0;
const SPOT = 1;
/**
 * The CPU keeps every light the GPU CullPass could draw, and a few more: the
 * same sphere-frustum test with a slightly larger radius. A light the GPU draws
 * but the CPU left out of the keys could land in a group whose layers it does
 * not all light.
 */
const MARGIN_SCALE = 1.01;
const MARGIN_ADD = 1e-3;

/** A receiver's layer: the lowest set bit of its mask, 0 for mask 0. */
export function receiverLayer(mask: number): number {
  return mask === 0 ? 0 : 31 - Math.clz32(mask & -mask);
}

export function deriveLightGroups(input: LightGroupsInput): LightGroups {
  const { entityCount, renderMeta, primParams, bounds } = input;
  const planes = extractFrustumPlanes(input.cameraViewProjection);
  const inView = (i: number): boolean => isSphereInFrustum(
    planes, bounds[i * 4], bounds[i * 4 + 1], bounds[i * 4 + 2], bounds[i * 4 + 3] * MARGIN_SCALE + MARGIN_ADD,
  );

  const lightMasks = new Set<number>();
  const occluderMasks = new Set<number>();
  let shadowedLayers = 0;
  let receiverLayers = 0;
  let multiBitReceiver = false;

  for (let i = 0; i < entityCount; i++) {
    const word = renderMeta[i * 2 + 1];
    const mask = word >>> 16;
    if ((word & 0xff) === LIGHT2D) {
      if (!inView(i)) continue;
      lightMasks.add(mask);
      // The shader's test: point or spot, with a shadow strength above 0.
      const type = (word >>> LIGHT_TYPE_SHIFT) & 7;
      const strength = Math.min(Math.max(primParams[i * 8 + 7], 0), 1);
      if ((type === POINT || type === SPOT) && strength > 0) shadowedLayers |= mask;
      continue;
    }
    // The SDF is screen-space: an occluder out of view contributes nothing,
    // and counting it could only split groups and add SDF floods.
    if ((word & CASTS_SHADOW) !== 0 && inView(i)) occluderMasks.add(mask === 0 ? 0xffff : mask);
    if ((word & RECEIVES_LIGHT) !== 0) {
      // A layer nobody on screen samples would still get a group, and its own
      // SDF set if the casters in view split it off. Same conservative test
      // as lights, so every receiver the GPU draws keeps its layer mapped.
      if (inView(i)) receiverLayers |= 1 << receiverLayer(mask);
      if ((mask & (mask - 1)) !== 0) multiBitReceiver = true;
    }
  }

  const lights = [...lightMasks];
  const occluders = [...occluderMasks];
  const groups: LightGroup[] = [];
  const sdfSets: Array<{ occluderLayers: number }> = [];
  const groupByKey = new Map<string, number>();
  const setByKey = new Map<string, number>();
  const table = [0, 0];

  for (let layer = 0; layer < 16; layer++) {
    if (((receiverLayers >>> layer) & 1) === 0) continue;
    let lightKey = '';
    for (const m of lights) lightKey += (m >>> layer) & 1;
    // Casters matter only where a shadowed light arrives: elsewhere they would
    // split groups for nothing (Unity splits on any differing caster).
    let casterKey = '-';
    if (((shadowedLayers >>> layer) & 1) !== 0) {
      casterKey = '';
      for (const o of occluders) casterKey += (o >>> layer) & 1;
      // No caster shadows this layer: marching "no occluder" gives the same
      // light as an SDF flooded from an empty seed, for none of its ~1.8 ms.
      if (!casterKey.includes('1')) casterKey = '-';
    }
    const key = `${lightKey}|${casterKey}`;
    let group = groupByKey.get(key);
    if (group === undefined) {
      let set = -1;
      if (casterKey !== '-') {
        set = setByKey.get(casterKey) ?? -1;
        if (set === -1) {
          set = sdfSets.length;
          setByKey.set(casterKey, set);
          sdfSets.push({ occluderLayers: 0 });
        }
      }
      group = groups.length;
      groupByKey.set(key, group);
      groups.push({ layers: 0, sdfSet: set });
    }
    groups[group].layers |= 1 << layer;
    const set = groups[group].sdfSet;
    if (set >= 0) sdfSets[set].occluderLayers |= 1 << layer;
    table[layer >> 3] = (table[layer >> 3] | (group << ((layer & 7) * 4))) >>> 0;
  }

  if (groups.length === 0) groups.push({ layers: 1, sdfSet: -1 });

  return {
    groups,
    sdfSets,
    layerToGroup: [table[0] >>> 0, table[1] >>> 0],
    multiBitReceiver,
    lightMasks: lights,
    occluderMasks: occluders,
  };
}
