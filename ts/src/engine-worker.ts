/// <reference lib="webworker" />

/**
 * Engine Logic Worker.
 * Runs the WASM ECS module, consuming commands from the ring buffer
 * and producing render state.
 */

let wasmModule: typeof import("../wasm/hyperion_core.js") | null = null;

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
        const wasm = await import("../wasm/hyperion_core.js");
        await wasm.default();
        wasmModule = wasm;
        self.postMessage({ type: "ready" });
      } catch (e) {
        self.postMessage({ type: "error", error: String(e) });
      }
      break;
    }

    case "tick": {
      if (!wasmModule) return;
      // Phase 1 will add: consume ring buffer, run ECS tick, emit render state.
      // For now, acknowledge the tick.
      self.postMessage({ type: "tick-done", dt: msg.dt });
      break;
    }
  }
};
