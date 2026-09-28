/**
 * The `renderState` of a `tick-done` message, at both ends of the wire.
 *
 * The engine worker (Modes A and B) builds it with `captureRenderState`;
 * Mode A's render worker turns the forwarded copy back into a
 * `GPURenderState` with `toGPURenderState`. Both used to be inline literals in
 * the two worker modules, where no test could reach them — and a field one
 * of them forgets still compiles, because the receiving end is untyped
 * (phase 5b §4.2: `transparentCount` and `entityIdsGeneration`).
 */
import type { GPURenderState } from './worker-bridge';

/** The WASM exports the engine worker calls. */
export interface WasmEngine {
  default(): Promise<void>;
  engine_init(): void;
  engine_push_commands(data: Uint8Array): void;
  /** Command bytes discarded because of an unknown opcode (protocol skew). */
  engine_dropped_command_bytes?(): number;
  /** Commands rejected for an out-of-range external entity id. */
  engine_rejected_command_count?(): number;
  engine_update(dt: number): void;
  engine_tick_count(): bigint;
  engine_render_state_count(): number;
  engine_render_state_ptr(): number;
  engine_render_state_f32_len(): number;
  engine_gpu_entity_count(): number;
  // SoA exports
  engine_gpu_transforms_ptr(): number;
  engine_gpu_transforms_f32_len(): number;
  engine_gpu_bounds_ptr(): number;
  engine_gpu_bounds_f32_len(): number;
  engine_gpu_render_meta_ptr(): number;
  engine_gpu_render_meta_len(): number;
  engine_gpu_tex_indices_ptr(): number;
  engine_gpu_tex_indices_len(): number;
  engine_gpu_prim_params_ptr(): number;
  engine_gpu_prim_params_f32_len(): number;
  engine_gpu_entity_ids_ptr(): number;
  engine_gpu_entity_ids_len(): number;
  // Listener position exports
  engine_listener_x(): number;
  engine_listener_y(): number;
  engine_listener_z(): number;
  // Lighting engine-level exports (Phase 17). Optional: a WASM build predating
  // them still satisfies this interface.
  engine_ambient_r?(): number;
  engine_ambient_g?(): number;
  engine_ambient_b?(): number;
  engine_ambient_intensity?(): number;
  engine_lighting_backend?(): number;
  // Transparent sort inputs (phase 5b). Optional for the same reason: without
  // them the renderer sizes the sort from entityCount and uploads the entity
  // ids every frame (render/frame-inputs.ts).
  engine_gpu_transparent_count?(): number;
  engine_gpu_entity_ids_generation?(): number;
  // Physics debug exports (physics-debug builds only)
  engine_physics_debug_ptr?(): number;
  engine_physics_debug_f32_len?(): number;
  // Determinism harness export (dev-tools builds only)
  engine_state_hash?(): bigint;
  engine_memory(): WebAssembly.Memory;
}

/** `renderState` of a `tick-done` message. */
export interface WorkerRenderState {
  entityCount: number;
  // The SoA columns, as transferable buffers. Absent on an empty world:
  // nothing is transferred then.
  transforms?: ArrayBuffer;
  bounds?: ArrayBuffer;
  renderMeta?: ArrayBuffer;
  texIndices?: ArrayBuffer;
  primParams?: ArrayBuffer;
  entityIds?: ArrayBuffer;
  listenerX: number;
  listenerY: number;
  listenerZ: number;
  ambientR: number;
  ambientG: number;
  ambientB: number;
  ambientIntensity: number;
  lightingBackend: number;
  /**
   * Phase 5b. NaN when the WASM build lacks the export, never 0: the renderer
   * normalises NaN to "count = entityCount" and "upload every frame".
   */
  transparentCount: number;
  entityIdsGeneration: number;
  physicsDebugLines?: ArrayBuffer;
  /**
   * Never set by the engine worker: `tickCount` travels on the message, and
   * Mode A's bridge forwards only `{ renderState }`, so its render worker reads 0.
   */
  tickCount?: number;
}

/**
 * Copy this frame's render state out of WASM memory into transferable
 * buffers. `transfer` lists the buffers to hand to `postMessage` (empty for
 * an empty world). Call it after `engine_update`: the pointers are valid for
 * that frame only.
 */
export function captureRenderState(wasm: WasmEngine): {
  renderState: WorkerRenderState;
  transfer: ArrayBuffer[];
} {
  const count = wasm.engine_gpu_entity_count();
  const scalars = {
    listenerX: wasm.engine_listener_x(),
    listenerY: wasm.engine_listener_y(),
    listenerZ: wasm.engine_listener_z(),
    ambientR: wasm.engine_ambient_r?.() ?? 0,
    ambientG: wasm.engine_ambient_g?.() ?? 0,
    ambientB: wasm.engine_ambient_b?.() ?? 0,
    ambientIntensity: wasm.engine_ambient_intensity?.() ?? 1,
    lightingBackend: wasm.engine_lighting_backend?.() ?? 0,
    transparentCount: wasm.engine_gpu_transparent_count?.() ?? NaN,
    entityIdsGeneration: wasm.engine_gpu_entity_ids_generation?.() ?? NaN,
  };
  if (count === 0) {
    return { renderState: { entityCount: 0, ...scalars }, transfer: [] };
  }

  const tPtr = wasm.engine_gpu_transforms_ptr();
  const tLen = wasm.engine_gpu_transforms_f32_len();
  const bPtr = wasm.engine_gpu_bounds_ptr();
  const bLen = wasm.engine_gpu_bounds_f32_len();
  const mPtr = wasm.engine_gpu_render_meta_ptr();
  const mLen = wasm.engine_gpu_render_meta_len();
  const texPtr = wasm.engine_gpu_tex_indices_ptr();
  const texLen = wasm.engine_gpu_tex_indices_len();

  // Copy from WASM memory into transferable buffers
  const transforms = new Float32Array(tLen);
  if (tPtr) transforms.set(new Float32Array(wasm.engine_memory().buffer, tPtr, tLen));

  const bounds = new Float32Array(bLen);
  if (bPtr) bounds.set(new Float32Array(wasm.engine_memory().buffer, bPtr, bLen));

  const renderMeta = new Uint32Array(mLen);
  if (mPtr) renderMeta.set(new Uint32Array(wasm.engine_memory().buffer, mPtr, mLen));

  const texIndices = new Uint32Array(texLen);
  if (texPtr) texIndices.set(new Uint32Array(wasm.engine_memory().buffer, texPtr, texLen));

  const ppPtr = wasm.engine_gpu_prim_params_ptr();
  const ppLen = wasm.engine_gpu_prim_params_f32_len();
  const primParams = new Float32Array(ppLen);
  if (ppPtr) primParams.set(new Float32Array(wasm.engine_memory().buffer, ppPtr, ppLen));

  const eidPtr = wasm.engine_gpu_entity_ids_ptr();
  const eidLen = wasm.engine_gpu_entity_ids_len();
  const entityIds = new Uint32Array(eidLen);
  if (eidPtr) entityIds.set(new Uint32Array(wasm.engine_memory().buffer, eidPtr, eidLen));

  // Physics debug lines (physics-debug builds only, empty when disabled)
  let physicsDebugLines: Float32Array | null = null;
  const dbgLen = wasm.engine_physics_debug_f32_len?.() ?? 0;
  if (dbgLen > 0) {
    const dbgPtr = wasm.engine_physics_debug_ptr!();
    physicsDebugLines = new Float32Array(dbgLen);
    if (dbgPtr) physicsDebugLines.set(new Float32Array(wasm.engine_memory().buffer, dbgPtr, dbgLen));
  }

  const renderState: WorkerRenderState = {
    entityCount: count,
    transforms: transforms.buffer as ArrayBuffer,
    bounds: bounds.buffer as ArrayBuffer,
    renderMeta: renderMeta.buffer as ArrayBuffer,
    texIndices: texIndices.buffer as ArrayBuffer,
    primParams: primParams.buffer as ArrayBuffer,
    entityIds: entityIds.buffer as ArrayBuffer,
    ...scalars,
    ...(physicsDebugLines ? { physicsDebugLines: physicsDebugLines.buffer as ArrayBuffer } : {}),
  };
  const transfer = [
    renderState.transforms!, renderState.bounds!, renderState.renderMeta!,
    renderState.texIndices!, renderState.primParams!, renderState.entityIds!,
  ];
  if (renderState.physicsDebugLines) transfer.push(renderState.physicsDebugLines);
  return { renderState, transfer };
}

/**
 * Mode A's render worker: the forwarded state as a `GPURenderState`, with
 * fresh views over the transferred buffers. It keeps no staging data (every
 * frame is a full upload there) and no physics debug lines, as before.
 */
export function toGPURenderState(rs: WorkerRenderState): GPURenderState {
  return {
    entityCount: rs.entityCount,
    transforms: rs.transforms ? new Float32Array(rs.transforms) : new Float32Array(0),
    bounds: rs.bounds ? new Float32Array(rs.bounds) : new Float32Array(0),
    renderMeta: rs.renderMeta ? new Uint32Array(rs.renderMeta) : new Uint32Array(0),
    texIndices: rs.texIndices ? new Uint32Array(rs.texIndices) : new Uint32Array(0),
    primParams: rs.primParams ? new Float32Array(rs.primParams) : new Float32Array(0),
    entityIds: rs.entityIds ? new Uint32Array(rs.entityIds) : new Uint32Array(0),
    listenerX: rs.listenerX ?? 0,
    listenerY: rs.listenerY ?? 0,
    listenerZ: rs.listenerZ ?? 0,
    ambientR: rs.ambientR ?? 0,
    ambientG: rs.ambientG ?? 0,
    ambientB: rs.ambientB ?? 0,
    ambientIntensity: rs.ambientIntensity ?? 1,
    lightingBackend: rs.lightingBackend ?? 0,
    // The stored state came through an untyped port: `?? NaN`, never `?? 0`.
    transparentCount: rs.transparentCount ?? NaN,
    entityIdsGeneration: rs.entityIdsGeneration ?? NaN,
    tickCount: rs.tickCount ?? 0,
    dirtyCount: 0,
    dirtyRatio: 0,
    stagingData: null,
    dirtyIndices: null,
  };
}
