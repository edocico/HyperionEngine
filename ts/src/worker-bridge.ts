import { ExecutionMode } from "./capabilities";
import {
  createRingBuffer,
  RingBufferProducer,
  extractUnread,
} from "./ring-buffer";

const RING_BUFFER_CAPACITY = 64 * 1024; // 64KB command buffer

/** Render state transferred from the engine each frame. */
export interface GPURenderState {
  entityCount: number;
  entityData: Float32Array;  // 20 floats per entity (mat4x4 + vec4 boundingSphere)
  texIndices: Uint32Array;   // 1 u32 per entity (packed tier|layer)
}

/** @deprecated Use GPURenderState instead */
export type RenderStateSnapshot = GPURenderState;

export interface EngineBridge {
  mode: ExecutionMode;
  commandBuffer: RingBufferProducer;
  /** Send a tick signal. In Mode C, this runs synchronously. */
  tick(dt: number): void;
  /** Wait for the engine to be ready. */
  ready(): Promise<void>;
  /** Shut down the engine. */
  destroy(): void;
  /** Get the latest render state (GPU entity data: 20 floats per entity). */
  latestRenderState: GPURenderState | null;
}

/**
 * Create the engine bridge for Mode B (Partial Isolation: Worker ECS + Main Thread Render).
 */
export function createWorkerBridge(
  mode: ExecutionMode.PartialIsolation
): EngineBridge {
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

  let latestRenderState: GPURenderState | null = null;

  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "ready") {
      readyResolve();
    } else if (msg.type === "error") {
      console.error("Engine Worker error:", msg.error);
    } else if (msg.type === "tick-done" && msg.renderState) {
      latestRenderState = {
        entityCount: msg.renderState.entityCount,
        entityData: new Float32Array(msg.renderState.entityData),
        texIndices: new Uint32Array(msg.renderState.texIndices),
      };
    }
  };

  worker.postMessage({ type: "init", commandBuffer: sab });

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
    get latestRenderState() {
      return latestRenderState;
    },
  };
}

/**
 * Create the engine bridge for Mode A (Full Isolation: ECS Worker + Render Worker).
 * The canvas is transferred to the Render Worker via OffscreenCanvas.
 */
export function createFullIsolationBridge(
  canvas: HTMLCanvasElement
): EngineBridge {
  const sab = createRingBuffer(RING_BUFFER_CAPACITY) as SharedArrayBuffer;
  const producer = new RingBufferProducer(sab);

  const offscreen = canvas.transferControlToOffscreen();

  const ecsWorker = new Worker(
    new URL("./engine-worker.ts", import.meta.url),
    { type: "module" }
  );
  const renderWorker = new Worker(
    new URL("./render-worker.ts", import.meta.url),
    { type: "module" }
  );

  // MessageChannel: ECS Worker tick-done -> Render Worker.
  const channel = new MessageChannel();

  let readyResolve: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  let ecsReady = false;
  let renderReady = false;
  function checkBothReady() {
    if (ecsReady && renderReady) readyResolve();
  }

  ecsWorker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "ready") {
      ecsReady = true;
      checkBothReady();
    } else if (msg.type === "error") {
      console.error("ECS Worker error:", msg.error);
    } else if (msg.type === "tick-done" && msg.renderState) {
      // Forward render state to Render Worker.
      channel.port1.postMessage(
        { renderState: msg.renderState },
        [msg.renderState.entityData, msg.renderState.texIndices]
      );
    }
  };

  renderWorker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "ready") {
      renderReady = true;
      checkBothReady();
    } else if (msg.type === "error") {
      console.error("Render Worker error:", msg.error);
    }
  };

  const dpr = window.devicePixelRatio || 1;
  renderWorker.postMessage(
    {
      type: "init",
      canvas: offscreen,
      width: Math.floor(canvas.clientWidth * dpr),
      height: Math.floor(canvas.clientHeight * dpr),
      ecsPort: channel.port2,
    },
    [offscreen, channel.port2]
  );

  ecsWorker.postMessage({ type: "init", commandBuffer: sab });

  return {
    mode: ExecutionMode.FullIsolation,
    commandBuffer: producer,
    tick(dt: number) {
      ecsWorker.postMessage({ type: "tick", dt });
    },
    async ready() {
      await readyPromise;
    },
    destroy() {
      ecsWorker.terminate();
      renderWorker.terminate();
    },
    get latestRenderState() {
      // In Mode A, rendering is in the Render Worker. Main thread has no state.
      return null;
    },
  };
}

/**
 * Create the engine bridge for Mode C (single-thread, no Worker).
 */
export async function createDirectBridge(): Promise<EngineBridge> {
  const buffer = createRingBuffer(RING_BUFFER_CAPACITY);
  const producer = new RingBufferProducer(buffer as SharedArrayBuffer);

  const wasm = await import("../wasm/hyperion_core.js");
  await wasm.default();

  const engine = wasm as unknown as {
    engine_init(): void;
    engine_push_commands(data: Uint8Array): void;
    engine_update(dt: number): void;
    // Legacy render state exports (backward compat)
    engine_render_state_count(): number;
    engine_render_state_ptr(): number;
    engine_render_state_f32_len(): number;
    // GPU entity data exports (20 floats per entity)
    engine_gpu_entity_count(): number;
    engine_gpu_data_ptr(): number;
    engine_gpu_data_f32_len(): number;
    // Texture layer indices (1 u32 per entity)
    engine_gpu_tex_indices_ptr(): number;
    engine_gpu_tex_indices_len(): number;
    memory: WebAssembly.Memory;
  };

  engine.engine_init();

  let latestRenderState: GPURenderState | null = null;

  return {
    mode: ExecutionMode.SingleThread,
    commandBuffer: producer,
    tick(dt: number) {
      // 1. Extract commands from ring buffer.
      const { bytes } = extractUnread(buffer as SharedArrayBuffer);
      if (bytes.length > 0) {
        engine.engine_push_commands(bytes);
      }

      // 2. Run physics + transforms + collect render state.
      engine.engine_update(dt);

      // 3. Read GPU entity data directly from WASM memory (20 floats per entity).
      const count = engine.engine_gpu_entity_count();
      const ptr = engine.engine_gpu_data_ptr();
      const f32Len = engine.engine_gpu_data_f32_len();
      const texPtr = engine.engine_gpu_tex_indices_ptr();
      const texLen = engine.engine_gpu_tex_indices_len();

      if (count > 0 && ptr !== 0) {
        const wasmView = new Float32Array(engine.memory.buffer, ptr, f32Len);
        const texView = texPtr !== 0
          ? new Uint32Array(engine.memory.buffer, texPtr, texLen)
          : new Uint32Array(count);
        latestRenderState = {
          entityCount: count,
          entityData: new Float32Array(wasmView),
          texIndices: new Uint32Array(texView),
        };
      } else {
        latestRenderState = { entityCount: 0, entityData: new Float32Array(0), texIndices: new Uint32Array(0) };
      }
    },
    async ready() {
      // Already ready.
    },
    destroy() {
      // Nothing to terminate.
    },
    get latestRenderState() {
      return latestRenderState;
    },
  };
}
