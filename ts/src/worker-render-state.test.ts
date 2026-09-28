import { describe, it, expect } from 'vitest';
import {
  captureRenderState, toGPURenderState, type WasmEngine, type WorkerRenderState,
} from './worker-render-state';

/**
 * A WASM stand-in: `count` entities whose entity-ids column (at byte 1024 of a
 * real WebAssembly.Memory) holds 10, 11, ...; the other columns are empty
 * (pointer 0). `sort` adds the two phase-5b exports.
 */
function fakeWasm(count: number, sort?: { transparent: number; generation: number }): WasmEngine {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const IDS_PTR = 1024;
  new Uint32Array(memory.buffer, IDS_PTR, count).set(Array.from({ length: count }, (_, i) => 10 + i));
  const zero = () => 0;
  const wasm = {
    default: async () => {},
    engine_init() {}, engine_push_commands() {}, engine_update() {},
    engine_tick_count: () => 1n,
    engine_render_state_count: zero, engine_render_state_ptr: zero, engine_render_state_f32_len: zero,
    engine_gpu_entity_count: () => count,
    engine_gpu_transforms_ptr: zero, engine_gpu_transforms_f32_len: zero,
    engine_gpu_bounds_ptr: zero, engine_gpu_bounds_f32_len: zero,
    engine_gpu_render_meta_ptr: zero, engine_gpu_render_meta_len: zero,
    engine_gpu_tex_indices_ptr: zero, engine_gpu_tex_indices_len: zero,
    engine_gpu_prim_params_ptr: zero, engine_gpu_prim_params_f32_len: zero,
    engine_gpu_entity_ids_ptr: () => (count > 0 ? IDS_PTR : 0),
    engine_gpu_entity_ids_len: () => count,
    engine_listener_x: zero, engine_listener_y: zero, engine_listener_z: zero,
    engine_memory: () => memory,
  } as WasmEngine;
  if (sort) {
    wasm.engine_gpu_transparent_count = () => sort.transparent;
    wasm.engine_gpu_entity_ids_generation = () => sort.generation;
  }
  return wasm;
}

describe('captureRenderState (engine worker, Modes A and B)', () => {
  it('carries the transparent count and the ids generation in a non-empty state', () => {
    const { renderState, transfer } = captureRenderState(fakeWasm(3, { transparent: 2, generation: 41 }));
    expect(renderState.entityCount).toBe(3);
    expect(renderState.transparentCount).toBe(2);
    expect(renderState.entityIdsGeneration).toBe(41);
    expect(Array.from(new Uint32Array(renderState.entityIds!))).toEqual([10, 11, 12]);
    expect(transfer).toContain(renderState.entityIds);
    expect(transfer).toHaveLength(6);
  });

  it('carries them in the empty-world state too, which transfers nothing', () => {
    const { renderState, transfer } = captureRenderState(fakeWasm(0, { transparent: 0, generation: 42 }));
    expect(renderState.entityCount).toBe(0);
    expect(renderState.transparentCount).toBe(0);
    expect(renderState.entityIdsGeneration).toBe(42);
    expect(renderState.entityIds).toBeUndefined();
    expect(transfer).toEqual([]);
  });

  it('sends NaN, never 0, when the WASM build lacks the exports', () => {
    for (const count of [3, 0]) {
      const { renderState } = captureRenderState(fakeWasm(count));
      expect(renderState.transparentCount, `count ${count}`).toBeNaN();
      expect(renderState.entityIdsGeneration, `count ${count}`).toBeNaN();
    }
  });
});

describe('toGPURenderState (Mode A render worker)', () => {
  const forwarded = (extra: Partial<WorkerRenderState>): WorkerRenderState => ({
    entityCount: 1,
    transforms: new Float32Array(16).buffer, bounds: new Float32Array(4).buffer,
    renderMeta: new Uint32Array(2).buffer, texIndices: new Uint32Array(1).buffer,
    primParams: new Float32Array(8).buffer, entityIds: new Uint32Array([9]).buffer,
    listenerX: 0, listenerY: 0, listenerZ: 0,
    ambientR: 0, ambientG: 0, ambientB: 0, ambientIntensity: 1, lightingBackend: 0,
    transparentCount: 1, entityIdsGeneration: 5,
    ...extra,
  });

  it('keeps the two phase-5b fields', () => {
    const s = toGPURenderState(forwarded({ transparentCount: 1, entityIdsGeneration: 5 }));
    expect(s.transparentCount).toBe(1);
    expect(s.entityIdsGeneration).toBe(5);
    expect(Array.from(s.entityIds)).toEqual([9]);
    expect(s.dirtyCount).toBe(0);
    expect(s.stagingData).toBeNull();
  });

  it('turns fields a stale engine worker never sent into NaN', () => {
    // What arrives through the port is untyped: an old worker omits the fields.
    const old = forwarded({}) as Partial<WorkerRenderState>;
    delete old.transparentCount;
    delete old.entityIdsGeneration;
    const s = toGPURenderState(old as WorkerRenderState);
    expect(s.transparentCount).toBeNaN();
    expect(s.entityIdsGeneration).toBeNaN();
  });
});
