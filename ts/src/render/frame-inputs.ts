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
