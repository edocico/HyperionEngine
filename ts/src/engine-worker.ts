/// <reference lib="webworker" />

/**
 * Engine Logic Worker.
 * Loads the WASM module, extracts commands from the shared ring buffer,
 * and runs the engine tick loop. After each tick, exports SoA GPU data
 * (transforms, bounds, renderMeta, texIndices) as transferable ArrayBuffers.
 */

import { extractUnread } from "./ring-buffer";

interface WasmEngine {
  default(): Promise<void>;
  engine_init(): void;
  engine_push_commands(data: Uint8Array): void;
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

      const { bytes } = extractUnread(commandBuffer);
      if (bytes.length > 0) {
        wasm.engine_push_commands(bytes);
      }
      wasm.engine_update(msg.dt);

      const count = wasm.engine_gpu_entity_count();
      const tickCount = Number(wasm.engine_tick_count());

      let renderState: {
        entityCount: number;
        transforms: ArrayBuffer;
        bounds: ArrayBuffer;
        renderMeta: ArrayBuffer;
        texIndices: ArrayBuffer;
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
        if (tPtr) transforms.set(new Float32Array(wasm.memory.buffer, tPtr, tLen));

        const bounds = new Float32Array(bLen);
        if (bPtr) bounds.set(new Float32Array(wasm.memory.buffer, bPtr, bLen));

        const renderMeta = new Uint32Array(mLen);
        if (mPtr) renderMeta.set(new Uint32Array(wasm.memory.buffer, mPtr, mLen));

        const texIndices = new Uint32Array(texLen);
        if (texPtr) texIndices.set(new Uint32Array(wasm.memory.buffer, texPtr, texLen));

        renderState = {
          entityCount: count,
          transforms: transforms.buffer as ArrayBuffer,
          bounds: bounds.buffer as ArrayBuffer,
          renderMeta: renderMeta.buffer as ArrayBuffer,
          texIndices: texIndices.buffer as ArrayBuffer,
        };
      }

      if (renderState) {
        self.postMessage(
          { type: "tick-done", dt: msg.dt, tickCount, renderState },
          [renderState.transforms, renderState.bounds, renderState.renderMeta, renderState.texIndices]
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
