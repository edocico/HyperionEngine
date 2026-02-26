/**
 * Read-only typed views into the GPU SoA buffers produced by collect_gpu().
 * Views reflect the most recent GPURenderState delivered from WASM,
 * which updates once per tick cycle. Both preTick and postTick see the
 * same snapshot — views do NOT reflect the current tick's changes.
 *
 * entityIds is always populated regardless of picking state.
 */
export interface SystemViews {
  readonly entityCount: number;
  readonly transforms: Float32Array;   // 16 f32/entity (model matrix, col-major)
  readonly bounds: Float32Array;       // 4 f32/entity (xyz + radius)
  readonly texIndices: Uint32Array;    // 1 u32/entity
  readonly renderMeta: Uint32Array;    // 2 u32/entity (meshHandle + renderPrimitive)
  readonly primParams: Float32Array;   // 8 f32/entity
  readonly entityIds: Uint32Array;     // 1 u32/entity (external IDs, always populated)
}
