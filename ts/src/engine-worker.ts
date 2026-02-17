/// <reference lib="webworker" />

/**
 * Engine Logic Worker.
 * Loads the WASM module, extracts commands from the shared ring buffer,
 * and runs the engine tick loop. After each tick, exports render state
 * (model matrices) as a transferable ArrayBuffer.
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

      // 3. Export render state as transferable ArrayBuffer.
      const count = wasm.engine_render_state_count();
      const tickCount = Number(wasm.engine_tick_count());

      if (count > 0) {
        const ptr = wasm.engine_render_state_ptr();
        const f32Len = wasm.engine_render_state_f32_len();
        const wasmMatrices = new Float32Array(wasm.memory.buffer, ptr, f32Len);

        // Copy to a transferable buffer (WASM memory can't be transferred).
        const transferBuf = new Float32Array(f32Len);
        transferBuf.set(wasmMatrices);

        self.postMessage(
          {
            type: "tick-done",
            dt: msg.dt,
            tickCount,
            renderState: { count, matrices: transferBuf.buffer },
          },
          [transferBuf.buffer]
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
