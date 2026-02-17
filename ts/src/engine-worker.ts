/// <reference lib="webworker" />

/**
 * Engine Logic Worker.
 * Loads the WASM module, attaches the shared ring buffer,
 * and runs the engine tick loop on each frame signal.
 */

interface WasmEngine {
  engine_init(): void;
  engine_attach_ring_buffer(ptr: number, capacity: number): void;
  engine_update(dt: number): void;
  engine_tick_count(): bigint;
  memory: WebAssembly.Memory;
}

let wasm: WasmEngine | null = null;
let commandBufferRef: SharedArrayBuffer | null = null;

/** Ring buffer header size in bytes (write_head + read_head + capacity + padding). */
const HEADER_SIZE = 16;

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

        wasm.engine_init();

        // Store the command buffer for Phase 2 ring buffer attachment.
        commandBufferRef = msg.commandBuffer;

        // Note: Ring buffer attachment requires passing the SAB pointer
        // into WASM memory. For Phase 0-1, the ring buffer consumer
        // reads directly from the SAB. Full integration with
        // engine_attach_ring_buffer requires wasm-bindgen SharedArrayBuffer
        // support, which will be completed in Phase 2.
        void commandBufferRef;
        void HEADER_SIZE;

        self.postMessage({ type: "ready" });
      } catch (e) {
        self.postMessage({ type: "error", error: String(e) });
      }
      break;
    }

    case "tick": {
      if (!wasm) return;

      wasm.engine_update(msg.dt);

      self.postMessage({
        type: "tick-done",
        dt: msg.dt,
        tickCount: Number(wasm.engine_tick_count()),
      });
      break;
    }
  }
};
