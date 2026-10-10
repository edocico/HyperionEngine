import { extractFrustumPlanes, isSphereInFrustum } from '../camera';
import { PRIMITIVE_LIBRARIES } from './primitive-shaders';
import { sortableZBits } from './passes/transparent-sort-constants';

/**
 * Light layers (Phase 17, design 2026-09-26): which receiver layers share a
 * light buffer, and which of those share an SDF.
 *
 * The one mask field in renderMeta word 1, bits 16-31, has a role per entity:
 * - light (primType 6): the layers it lights; 0 lights nothing;
 * - receiver (bit 10, on a primitive in LIT_PRIMITIVE_TYPES): ONE layer, its
 *   lowest bit; 0 is layer 0;
 * - occluder (bit 9): the layers it shadows; 0 is every layer.
 *
 * Two occupied layers share a group when the same lights reach them and, if a
 * shadowed light reaches them, the same casters shadow them. That is Unity's
 * `LayerUtility.CanBatchLightsInLayer`, minus its "consecutive layers" rule:
 * Unity draws sprites per sorting-layer range, Hyperion in one ForwardPass.
 * Groups whose caster part is the same share one SDF set; a group that no
 * shadowed light reaches has none.
 *
 * Keys come from the distinct mask VALUES, not from entities, so moving things
 * around does not regroup by itself. The groups change when a value appears or
 * goes, or when a light, an occluder or a lit receiver enters or leaves the
 * view — a lone receiver on its own layer can bring a whole SDF set with it.
 *
 * The same scan builds the frame's light list (round step 7): the order in
 * which LightAccumStage draws every light, into every group. It holds each
 * Light2D the cull's EXACT sphere-frustum test keeps (cull.wgsl; the grouping
 * keeps its margin), sorted by blend class (add and sub before mix), then world
 * z back to front, then external id, the higher id last: the 5b rule of the
 * transparent sort, and a function of the ECS state, never of the slots or of
 * the cull's atomics.
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
  /**
   * A global light in view has shadowIntensity > 0. The lit backend ignores it:
   * a global light has no position and no direction to cast from. The renderer
   * warns once (dev builds); use a directional light for a sun.
   */
  shadowedGlobalLight: boolean;
  /** The distinct light mask values in view: what splits the groups. */
  lightMasks: number[];
  /** The distinct occluder mask values in view, 0 normalised to 0xFFFF. */
  occluderMasks: number[];
  /**
   * The light list (round step 7): the slots of the lights the cull's exact
   * sphere-frustum test keeps, whatever their mask or type, in draw order —
   * blend class (add and sub before mix), then sortableZBits of the row's z,
   * then external id, the higher id last. A new array on every call.
   */
  lightOrder: Uint32Array<ArrayBuffer>;
  /**
   * The external ids of `lightOrder`, in the same order (a new array too). The
   * slot stands in for every id when `entityIds` is missing or shorter than
   * `entityCount`.
   */
  lightIds: Uint32Array<ArrayBuffer>;
}

/** The SoA columns of `GPURenderState` / `FrameState` the grouping and the light list read. */
export interface LightGroupsInput {
  entityCount: number;
  renderMeta: Uint32Array;
  primParams: Float32Array;
  bounds: Float32Array;
  cameraViewProjection: Float32Array;
  /**
   * Slot -> external id: the light list's tie-break. A column shorter than
   * `entityCount`, or none, is ignored whole, and the slot stands in for the
   * id: an order that holds from frame to frame, but not across a despawn or a
   * restore.
   */
  entityIds?: Uint32Array;
}

/**
 * The Light2D primitive type, the last one: PRIM_TYPE_LIGHT2D in components.rs,
 * NUM_PRIM_TYPES - 1 in cull.wgsl, RenderPrimitiveType.Light2D. Since round
 * step 7 the light list's type gate, so what LightAccumStage draws as a light:
 * light-accum.wgsl tests no primitive type. light-groups.test.ts pins it to all
 * three. A plain number, not the const enum: the scan runs every frame, and a
 * const enum imported from another module is not inlined by vitest's per-file
 * transform.
 */
export const LIGHT2D = 6;
const CASTS_SHADOW = 1 << 9;
const RECEIVES_LIGHT = 1 << 10;
const LIGHT_TYPE_SHIFT = 11;
/** renderMeta word 1, bits 14-15: the light's blend mode (RENDER_META_LIGHT_BLEND_SHIFT in components.rs). */
const LIGHT_BLEND_SHIFT = 14;
/**
 * The wire value of the `mix` blend mode (LightBlendMode::Mix, LIGHT_BLEND_IDS,
 * BLEND_MIX in light-accum.wgsl): the one class drawn after the others. Add
 * (0), sub (1) and the unclaimed 3, which light-accum.wgsl draws like add,
 * come first.
 */
export const BLEND_MIX = 2;
const POINT = 0;
const SPOT = 1;
const DIRECTIONAL = 2;
const GLOBAL = 3;
/**
 * The light types whose shadowIntensity makes light-accum.wgsl march the SDF:
 * its `shadowedLightType`, which light-groups.test.ts compares with this list.
 * Never GLOBAL: a global light has no position and no direction to cast from.
 * Sprite lights join in round step 8, on both sides in the same commit.
 */
export const SHADOWED_LIGHT_TYPES: readonly number[] = [POINT, SPOT, DIRECTIONAL];
const SHADOWED = new Uint8Array(8);
for (const type of SHADOWED_LIGHT_TYPES) SHADOWED[type] = 1;
/**
 * The grouping keeps every entity the GPU could draw, and a few more: the
 * cull's sphere-frustum test with a slightly larger radius. A receiver or a
 * caster the GPU draws but the CPU left out of the keys could land in a group
 * it was not keyed for. Lights are drawn from the light list, which takes the
 * exact test (round step 7): every listed light is inside this margin too, so
 * its mask is among the keys.
 */
const MARGIN_SCALE = 1.01;
const MARGIN_ADD = 1e-3;

/**
 * The primitive types whose shader samples the light buffer: the `lit` rows of
 * PRIMITIVE_LIBRARIES (Quad and Gradient), whose `<prefix>_fs` calls the
 * prelude's `applyLighting`. A receiver of any other type is drawn unlit
 * whatever its flag, so its layer needs no group. `light-groups.test.ts`
 * checks the table against what the composed modules' fs_main reaches.
 */
export const LIT_PRIMITIVE_TYPES: readonly number[] = PRIMITIVE_LIBRARIES.filter((l) => l.lit).map((l) => l.type);
const LIT = new Uint8Array(256);
for (const type of LIT_PRIMITIVE_TYPES) LIT[type] = 1;

/** A receiver's layer: the lowest set bit of its mask, 0 for mask 0. */
export function receiverLayer(mask: number): number {
  return mask === 0 ? 0 : 31 - Math.clz32(mask & -mask);
}

/**
 * The light list's order: blend class, then sortableZBits of the row's z (the
 * bits the GPU holds: a view over `bounds`, no float round trip, so -0 is +0
 * and a NaN has a fixed place), then the id, then the slot. Every key is an
 * integer and the slots are unique, so the comparator is a total order: one
 * sorted permutation, whatever the sort algorithm.
 */
function orderLights(
  slots: readonly number[],
  renderMeta: Uint32Array,
  bounds: Float32Array,
  ids: Uint32Array | null,
): { lightOrder: Uint32Array<ArrayBuffer>; lightIds: Uint32Array<ArrayBuffer> } {
  const k = slots.length;
  const lightOrder = new Uint32Array(k);
  const lightIds = new Uint32Array(k);
  if (k === 0) return { lightOrder, lightIds };
  const zBits = new Uint32Array(bounds.buffer, bounds.byteOffset, bounds.length);
  const cls = new Uint8Array(k);
  const zKey = new Uint32Array(k);
  const id = new Uint32Array(k);
  for (let j = 0; j < k; j++) {
    const s = slots[j];
    cls[j] = ((renderMeta[s * 2 + 1] >>> LIGHT_BLEND_SHIFT) & 3) === BLEND_MIX ? 1 : 0;
    zKey[j] = sortableZBits(zBits[s * 4 + 2]);
    id[j] = ids === null ? s : ids[s];
  }
  const idx = Array.from({ length: k }, (_, j) => j);
  idx.sort((a, b) => (cls[a] - cls[b]) || (zKey[a] - zKey[b]) || (id[a] - id[b]) || (slots[a] - slots[b]));
  for (let j = 0; j < k; j++) {
    lightOrder[j] = slots[idx[j]];
    lightIds[j] = id[idx[j]];
  }
  return { lightOrder, lightIds };
}

export function deriveLightGroups(input: LightGroupsInput): LightGroups {
  const { entityCount, renderMeta, primParams, bounds } = input;
  const planes = extractFrustumPlanes(input.cameraViewProjection);
  const inView = (i: number): boolean => isSphereInFrustum(
    planes, bounds[i * 4], bounds[i * 4 + 1], bounds[i * 4 + 2], bounds[i * 4 + 3] * MARGIN_SCALE + MARGIN_ADD,
  );
  // All or nothing: a short column is a transport bug, and mixing ids with
  // slots as keys would compare two numberings.
  const ids = input.entityIds !== undefined && input.entityIds.length >= entityCount ? input.entityIds : null;
  const listed: number[] = [];

  const lightMasks = new Set<number>();
  const occluderMasks = new Set<number>();
  let shadowedLayers = 0;
  let receiverLayers = 0;
  let multiBitReceiver = false;
  let shadowedGlobalLight = false;

  for (let i = 0; i < entityCount; i++) {
    const word = renderMeta[i * 2 + 1];
    const mask = word >>> 16;
    // cull.wgsl's own clamp: a type past the last one is drawn as the last,
    // Light2D. Rust rejects such a type, but the grouping must agree with the
    // GPU on whatever reaches it.
    const primType = Math.min(word & 0xff, LIGHT2D);
    if (primType === LIGHT2D) {
      // The cull's own test, radius as is: the light list decides what is drawn.
      const drawn = isSphereInFrustum(planes, bounds[i * 4], bounds[i * 4 + 1], bounds[i * 4 + 2], bounds[i * 4 + 3]);
      // `drawn ||` keeps every listed light among the keys, whatever its radius.
      if (!drawn && !inView(i)) continue;
      if (drawn) listed.push(i);
      lightMasks.add(mask);
      // The shader's gate (shadowedLightType in light-accum.wgsl): point, spot
      // or directional, with a shadow strength above 0. A global light's
      // strength is ignored there: flag it for the renderer's warning.
      const type = (word >>> LIGHT_TYPE_SHIFT) & 7;
      const strength = Math.min(Math.max(primParams[i * 8 + 7], 0), 1);
      if (strength > 0) {
        if (SHADOWED[type] === 1) {
          // A sun's shadow is `range` long: at 0 or less sunShadow returns
          // before its first SDF read, so its flood would be read by nobody.
          if (type !== DIRECTIONAL || primParams[i * 8 + 3] > 0) shadowedLayers |= mask;
        } else if (type === GLOBAL) {
          shadowedGlobalLight = true;
        }
      }
      continue;
    }
    // The SDF is screen-space: an occluder out of view contributes nothing,
    // and counting it could only split groups and add SDF floods.
    if ((word & CASTS_SHADOW) !== 0 && inView(i)) occluderMasks.add(mask === 0 ? 0xffff : mask);
    if ((word & RECEIVES_LIGHT) !== 0 && LIT[primType] === 1) {
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
    shadowedGlobalLight,
    lightMasks: lights,
    occluderMasks: occluders,
    ...orderLights(listed, renderMeta, bounds, ids),
  };
}
