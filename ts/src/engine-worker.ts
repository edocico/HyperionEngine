/// <reference lib="webworker" />

/**
 * Engine Logic Worker.
 * Loads the WASM module, extracts commands from the shared ring buffer,
 * and runs the engine tick loop. After each tick, exports GPU entity data
 * (20 floats per entity: mat4x4 + vec4 boundingSphere) as a transferable ArrayBuffer.
 */

import { extractUnread } from "./ring-buffer";

interface WasmEngine {
  default(): Promise<void>;
  engine_init(): void;
  engine_push_commands(data: Uint8Array): void;
  engine_update(dt: number): void;
  engine_tick_count(): bigint;
  // Legacy render state exports (backward compat)
  engine_render_state_count(): number;
  engine_render_state_ptr(): number;
  engine_render_state_f32_len(): number;
  // GPU entity data exports (20 floats per entity: mat4x4 + vec4 boundingSphere)
  engine_gpu_entity_count(): number;
  engine_gpu_data_ptr(): number;
  engine_gpu_data_f32_len(): number;
  // Texture layer indices (1 u32 per entity)
  engine_gpu_tex_indices_ptr(): number;
  engine_gpu_tex_indices_len(): number;
  memory: WebAssembly.Memory;
}

let wasm: WasmEngine | null = null;
let commandBuffer: SharedArrayBuffer | null = null;

interface InitMessage {
  type: "init";
  commandBuffer: SharedArrayBuffer;
}

interface TickMessage {
  type: "tick";
  dt: number;
}

type WorkerMessage = InitMessage | TickMessage;

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

    case "tick": {
      if (!wasm || !commandBuffer) return;

      // 1. Extract unread commands from the SAB ring buffer.
      const { bytes } = extractUnread(commandBuffer);
      if (bytes.length > 0) {
        wasm.engine_push_commands(bytes);
      }

      // 2. Run physics + transform + collect render state.
      wasm.engine_update(msg.dt);

      // 3. Read GPU entity data from WASM memory (20 floats per entity).
      const count = wasm.engine_gpu_entity_count();
      const ptr = wasm.engine_gpu_data_ptr();
      const f32Len = wasm.engine_gpu_data_f32_len();
      const texPtr = wasm.engine_gpu_tex_indices_ptr();
      const texLen = wasm.engine_gpu_tex_indices_len();
      const tickCount = Number(wasm.engine_tick_count());

      let renderState: { entityCount: number; entityData: ArrayBuffer; texIndices: ArrayBuffer } | null = null;

      if (count > 0 && ptr !== 0) {
        const wasmData = new Float32Array(wasm.memory.buffer, ptr, f32Len);
        // Copy to a transferable buffer (WASM memory can't be transferred).
        const transferBuf = new Float32Array(f32Len);
        transferBuf.set(wasmData);

        let texBuf: Uint32Array;
        if (texPtr !== 0 && texLen > 0) {
          const wasmTex = new Uint32Array(wasm.memory.buffer, texPtr, texLen);
          texBuf = new Uint32Array(texLen);
          texBuf.set(wasmTex);
        } else {
          texBuf = new Uint32Array(count);
        }

        renderState = {
          entityCount: count,
          entityData: transferBuf.buffer as ArrayBuffer,
          texIndices: texBuf.buffer as ArrayBuffer,
        };
      }

      if (renderState) {
        self.postMessage(
          {
            type: "tick-done",
            dt: msg.dt,
            tickCount,
            renderState,
          },
          [renderState.entityData, renderState.texIndices]
        );
      } else {
        self.postMessage({
          type: "tick-done",
          dt: msg.dt,
          tickCount,
          renderState: null,
        });
      }
      break;
    }
  }
};
