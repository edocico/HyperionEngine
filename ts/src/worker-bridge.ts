import { ExecutionMode } from "./capabilities";
import { createRingBuffer, RingBufferProducer } from "./ring-buffer";

const RING_BUFFER_CAPACITY = 64 * 1024; // 64KB command buffer

export interface EngineBridge {
  mode: ExecutionMode;
  commandBuffer: RingBufferProducer;
  /** Send a tick signal. In Mode C, this runs synchronously. */
  tick(dt: number): void;
  /** Wait for the engine to be ready. */
  ready(): Promise<void>;
  /** Shut down the engine. */
  destroy(): void;
}

/**
 * Create the engine bridge for Modes A/B (Worker-based).
 */
export function createWorkerBridge(mode: ExecutionMode.FullIsolation | ExecutionMode.PartialIsolation): EngineBridge {
  const sab = createRingBuffer(RING_BUFFER_CAPACITY) as SharedArrayBuffer;
  const producer = new RingBufferProducer(sab);

  const worker = new Worker(
    new URL("./engine-worker.ts", import.meta.url),
    { type: "module" }
  );

  let readyResolve: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "ready") {
      readyResolve();
    } else if (msg.type === "error") {
      console.error("Engine Worker error:", msg.error);
    }
  };

  // Initialize the worker with the shared command buffer.
  worker.postMessage({ type: "init", commandBuffer: sab } satisfies { type: "init"; commandBuffer: SharedArrayBuffer });

  return {
    mode,
    commandBuffer: producer,
    tick(dt: number) {
      worker.postMessage({ type: "tick", dt });
    },
    async ready() {
      await readyPromise;
    },
    destroy() {
      worker.terminate();
    },
  };
}

/**
 * Create the engine bridge for Mode C (single-thread, no Worker).
 */
export async function createDirectBridge(): Promise<EngineBridge> {
  const buffer = createRingBuffer(RING_BUFFER_CAPACITY);
  // In Mode C, RingBufferProducer works on a regular ArrayBuffer too,
  // but we use it for API consistency. Commands are consumed synchronously.
  const producer = new RingBufferProducer(buffer as SharedArrayBuffer);

  const wasm = await import("../wasm/hyperion_core.js");
  await wasm.default();

  return {
    mode: ExecutionMode.SingleThread,
    commandBuffer: producer,
    tick(_dt: number) {
      // Phase 1: synchronously consume ring buffer and run ECS tick.
    },
    async ready() {
      // Already ready — WASM loaded synchronously above.
    },
    destroy() {
      // Nothing to terminate in single-thread mode.
    },
  };
}
