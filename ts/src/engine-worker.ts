/// <reference lib="webworker" />

/**
 * Engine Logic Worker.
 * Loads the WASM module, extracts commands from the shared ring buffer,
 * and runs the engine tick loop. After each tick, exports SoA GPU data
 * (transforms, bounds, renderMeta, texIndices) as transferable ArrayBuffers.
 */

import { extractUnread, HEARTBEAT_W1_OFFSET } from "./ring-buffer";
import { captureRenderState, type WasmEngine } from "./worker-render-state";

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

      const tickCount = Number(wasm.engine_tick_count());
      // One message per tick, empty world included (its renderState carries
      // no arrays and transfers nothing): see worker-render-state.ts.
      const { renderState, transfer } = captureRenderState(wasm);
      self.postMessage(
        { type: "tick-done", dt: msg.dt, seq: msg.seq, tickCount, renderState },
        transfer
      );
      break;
    }
  }
};
