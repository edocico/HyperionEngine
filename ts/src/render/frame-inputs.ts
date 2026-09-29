/**
 * The per-frame inputs of the transparent sort (phase 5b §4.2), as the
 * renderer takes them from a `GPURenderState`.
 *
 * Worker messages are untyped (`msg.renderState` is `any`), so `tsc` cannot
 * see a transport site that drops a field. The rule: a missing field may cost
 * time, never correctness. A missing count sorts as if every entity were
 * transparent; a missing generation uploads the entity ids every frame. A
 * constant default (0) would do neither — 0 transparents draws nothing, and a
 * generation stuck at 0 freezes the id upload after the first frame.
 */
import type { GPURenderState } from '../worker-bridge';
import { MAX_GPU_ENTITIES } from '../types';

/** The gather's bound: a finite count as a non-negative integer, else `entityCount`. */
export function normalizeTransparentCount(count: number | undefined, entityCount: number): number {
  return typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : entityCount;
}

/**
 * A finite generation as is, else NaN. `NaN !== NaN`, so a missing generation
 * never equals the uploaded marker and the ids are uploaded on every frame.
 */
export function normalizeIdsGeneration(generation: number | undefined): number {
  return typeof generation === 'number' && Number.isFinite(generation) ? generation : NaN;
}

/**
 * The next frame stamp: in [1, 0xFFFFFFFE], never 0 (a fresh staging buffer
 * reads 0) and never 0xFFFFFFFF (the header sentinel `prepare()` writes).
 * 0 -> 1 -> 2 -> ... -> 0xFFFFFFFE -> 1.
 */
export function nextFrameStamp(prev: number): number {
  return (prev % 0xFFFFFFFE) + 1;
}

/**
 * Upload the slot -> external id column when its generation moved (phase 5b
 * §4.3, D6), the whole live part of it. Returns the generation the GPU now
 * holds and whether this frame wrote. The renderer calls it on EVERY frame
 * kind, scatter frames included: the 32-word scatter staging has no room for
 * the id, and a swap-remove moves rows between slots.
 *
 * A column shorter than `entityCount` (or missing) is uploaded as far as it
 * goes: asking `writeBuffer` for more elements than the array holds throws
 * synchronously inside render(), and that stops the frame loop. The generation
 * is then NOT recorded (the returned one is `uploadedGeneration`), so the next
 * full column is uploaded, and `warning` names both lengths for the renderer's
 * one-time dev warning.
 */
export function uploadEntityIds(
  queue: Pick<GPUQueue, 'writeBuffer'>,
  buffer: GPUBuffer,
  state: Pick<GPURenderState, 'entityIds' | 'entityCount' | 'entityIdsGeneration'>,
  uploadedGeneration: number,
): { generation: number; uploaded: boolean; warning?: string } {
  const generation = normalizeIdsGeneration(state.entityIdsGeneration);
  // NaN never equals the marker: a missing generation uploads every frame.
  if (generation === uploadedGeneration || state.entityCount === 0) {
    return { generation, uploaded: false };
  }
  const length = state.entityIds?.length ?? 0;
  if (length >= state.entityCount) {
    queue.writeBuffer(buffer, 0, state.entityIds as Uint32Array<ArrayBuffer>, 0, state.entityCount);
    return { generation, uploaded: true };
  }
  if (length > 0) queue.writeBuffer(buffer, 0, state.entityIds as Uint32Array<ArrayBuffer>, 0, length);
  return {
    generation: uploadedGeneration,
    uploaded: length > 0,
    warning: `[Hyperion] entityIds holds ${length} ids but entityCount is ${state.entityCount}: `
      + 'only those were uploaded, and the column is uploaded again on the next frame. '
      + 'A transport site trims or drops GPURenderState.entityIds.',
  };
}

/**
 * The phase-5b fields a render state lacks (absent or not finite): a WASM
 * build older than the exports, or a transport site that drops them. The
 * renderer warns once, in dev.
 */
export function missingSortInputs(
  state: Pick<GPURenderState, 'transparentCount' | 'entityIdsGeneration'>,
): string[] {
  const missing: string[] = [];
  if (!Number.isFinite(state.transparentCount)) missing.push('transparentCount');
  if (!Number.isFinite(state.entityIdsGeneration)) missing.push('entityIdsGeneration');
  return missing;
}

/**
 * The one-time warning for a frame with more rows than the GPU buffers hold,
 * or null. The facade refuses spawns past `maxEntities` (≤ MAX_GPU_ENTITIES),
 * but raw spawns are not counted; past the capacity every SoA `writeBuffer`
 * fails validation, so the frame is lost anyway.
 */
export function overCapacityWarning(entityCount: number): string | null {
  if (entityCount <= MAX_GPU_ENTITIES) return null;
  return `[Hyperion] ${entityCount} entities exceed MAX_GPU_ENTITIES (${MAX_GPU_ENTITIES}): `
    + 'the GPU buffers hold that many rows, so the uploads of these frames fail validation. '
    + 'Raw spawns (engine.raw) are not counted against maxEntities.';
}
