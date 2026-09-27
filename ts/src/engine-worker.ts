/// <reference lib="webworker" />

/**
 * Engine Logic Worker.
 * Loads the WASM module, extracts commands from the shared ring buffer,
 * and runs the engine tick loop. After each tick, exports SoA GPU data
 * (transforms, bounds, renderMeta, texIndices) as transferable ArrayBuffers.
 */

import { extractUnread, HEARTBEAT_W1_OFFSET } from "./ring-buffer";

interface WasmEngine {
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
  // Physics debug exports (physics-debug builds only)
  engine_physics_debug_ptr?(): number;
  engine_physics_debug_f32_len?(): number;
  // Determinism harness export (dev-tools builds only)
  engine_state_hash?(): bigint;
  engine_memory(): WebAssembly.Memory;
}

let wasm: WasmEngine | null = null;
let commandBuffer: SharedArrayBuffer | null = null;

interface InitMessage {
  type: "init";
  commandBuffer: SharedArrayBuffer;
}

interface StateHashMessage {
  type: "state-hash";
  requestId: number;
}

interface TickMessage {
  type: "tick";
  dt: number;
  /** The bridge's number for this tick, echoed in `tick-done` (TickSequencer). */
  seq?: number;
}

type WorkerMessage = InitMessage | TickMessage | StateHashMessage;

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case "init": {
      try {
        const wasmModule = await import("../wasm/hyperion_core.js");
        await wasmModule.default();
        wasm = wasmModule as unknown as WasmEngine;
        commandBuffer = msg.commandBuffer;

        wasm.engine_init();

        self.postMessage({ type: "ready" });
      } catch (e) {
        self.postMessage({ type: "error", error: String(e) });
      }
      break;
    }

    case "state-hash": {
      // Determinism harness (Phase 16): dev-tools builds only.
      const hash = wasm?.engine_state_hash?.() ?? null;
      self.postMessage({
        type: "state-hash-result",
        requestId: msg.requestId,
        // BigInt does not survive structured clone limits in all targets —
        // ship as string, parse bridge-side.
        hash: hash === null ? null : hash.toString(),
      });
      break;
    }

    case "tick": {
      if (!wasm || !commandBuffer) return;

      const { bytes } = extractUnread(commandBuffer);
      if (bytes.length > 0) {
        wasm.engine_push_commands(bytes);
      }
      wasm.engine_update(msg.dt);

      // Increment heartbeat for supervisor monitoring
      const header = new Int32Array(commandBuffer, 0, 8);
      Atomics.add(header, HEARTBEAT_W1_OFFSET, 1);

      const count = wasm.engine_gpu_entity_count();
      const tickCount = Number(wasm.engine_tick_count());

      let renderState: {
        entityCount: number;
        transforms: ArrayBuffer;
        bounds: ArrayBuffer;
        renderMeta: ArrayBuffer;
        texIndices: ArrayBuffer;
        primParams: ArrayBuffer;
        entityIds: ArrayBuffer;
        listenerX: number;
        listenerY: number;
        listenerZ: number;
        ambientR: number;
        ambientG: number;
        ambientB: number;
        ambientIntensity: number;
        lightingBackend: number;
        physicsDebugLines?: ArrayBuffer;
      } | null = null;

      if (count > 0) {
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

        renderState = {
          entityCount: count,
          transforms: transforms.buffer as ArrayBuffer,
          bounds: bounds.buffer as ArrayBuffer,
          renderMeta: renderMeta.buffer as ArrayBuffer,
          texIndices: texIndices.buffer as ArrayBuffer,
          primParams: primParams.buffer as ArrayBuffer,
          entityIds: entityIds.buffer as ArrayBuffer,
          listenerX: wasm!.engine_listener_x(),
          listenerY: wasm!.engine_listener_y(),
          listenerZ: wasm!.engine_listener_z(),
          ambientR: wasm!.engine_ambient_r?.() ?? 0,
          ambientG: wasm!.engine_ambient_g?.() ?? 0,
          ambientB: wasm!.engine_ambient_b?.() ?? 0,
          ambientIntensity: wasm!.engine_ambient_intensity?.() ?? 1,
          lightingBackend: wasm!.engine_lighting_backend?.() ?? 0,
          ...(physicsDebugLines ? { physicsDebugLines: physicsDebugLines.buffer as ArrayBuffer } : {}),
        };
      }

      if (renderState) {
        const transfer = [renderState.transforms, renderState.bounds, renderState.renderMeta, renderState.texIndices, renderState.primParams, renderState.entityIds];
        if (renderState.physicsDebugLines) transfer.push(renderState.physicsDebugLines);
        self.postMessage(
          { type: "tick-done", dt: msg.dt, seq: msg.seq, tickCount, renderState },
          transfer
        );
      } else {
        self.postMessage({
          type: "tick-done",
          dt: msg.dt,
          seq: msg.seq,
          tickCount,
          renderState: {
            entityCount: 0,
            listenerX: wasm!.engine_listener_x(),
            listenerY: wasm!.engine_listener_y(),
            listenerZ: wasm!.engine_listener_z(),
            ambientR: wasm!.engine_ambient_r?.() ?? 0,
            ambientG: wasm!.engine_ambient_g?.() ?? 0,
            ambientB: wasm!.engine_ambient_b?.() ?? 0,
            ambientIntensity: wasm!.engine_ambient_intensity?.() ?? 1,
            lightingBackend: wasm!.engine_lighting_backend?.() ?? 0,
          },
        });
      }
      break;
    }
  }
};
