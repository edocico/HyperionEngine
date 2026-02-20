import { ExecutionMode } from "./capabilities";
import {
  createRingBuffer,
  RingBufferProducer,
  extractUnread,
} from "./ring-buffer";
import { BackpressuredProducer } from "./backpressure";
import { WorkerSupervisor } from "./supervisor";

const RING_BUFFER_CAPACITY = 64 * 1024; // 64KB command buffer

/** Render state transferred from the engine each frame (SoA layout). */
export interface GPURenderState {
  entityCount: number;
  transforms: Float32Array;    // 16 f32/entity (mat4x4)
  bounds: Float32Array;        // 4 f32/entity (xyz + radius)
  renderMeta: Uint32Array;     // 2 u32/entity (meshHandle + renderPrimitive)
  texIndices: Uint32Array;     // 1 u32/entity
}

export interface EngineBridge {
  mode: ExecutionMode;
  commandBuffer: BackpressuredProducer;
  /** Send a tick signal. In Mode C, this runs synchronously. */
  tick(dt: number): void;
  /** Wait for the engine to be ready. */
  ready(): Promise<void>;
  /** Shut down the engine. */
  destroy(): void;
  /** Get the latest render state (SoA: transforms, bounds, renderMeta, texIndices). */
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
  const commandBuffer = new BackpressuredProducer(producer);

  const supervisor = new WorkerSupervisor(sab, {
    // TODO(Phase 5): escalate to worker restart or user-visible error state
    onTimeout: (workerId) => {
      console.warn(`[Hyperion] Worker ${workerId} heartbeat timeout`);
    },
  });
  const supervisorInterval = setInterval(() => supervisor.check(), 1000);

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
        transforms: new Float32Array(msg.renderState.transforms),
        bounds: new Float32Array(msg.renderState.bounds),
        renderMeta: new Uint32Array(msg.renderState.renderMeta),
        texIndices: new Uint32Array(msg.renderState.texIndices),
      };
    }
  };

  worker.postMessage({ type: "init", commandBuffer: sab });

  return {
    mode,
    commandBuffer,
    tick(dt: number) {
      commandBuffer.flush();
      worker.postMessage({ type: "tick", dt });
    },
    async ready() {
      await readyPromise;
    },
    destroy() {
      clearInterval(supervisorInterval);
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
  const commandBuffer = new BackpressuredProducer(producer);

  const supervisor = new WorkerSupervisor(sab, {
    // TODO(Phase 5): escalate to worker restart or user-visible error state
    onTimeout: (workerId) => {
      console.warn(`[Hyperion] Worker ${workerId} heartbeat timeout`);
    },
  });
  const supervisorInterval = setInterval(() => supervisor.check(), 1000);

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
        [msg.renderState.transforms, msg.renderState.bounds, msg.renderState.renderMeta, msg.renderState.texIndices]
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
    commandBuffer,
    tick(dt: number) {
      commandBuffer.flush();
      ecsWorker.postMessage({ type: "tick", dt });
    },
    async ready() {
      await readyPromise;
    },
    destroy() {
      clearInterval(supervisorInterval);
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
  const commandBuffer = new BackpressuredProducer(producer);

  const wasm = await import("../wasm/hyperion_core.js");
  await wasm.default();

  const engine = wasm as unknown as {
    engine_init(): void;
    engine_push_commands(data: Uint8Array): void;
    engine_update(dt: number): void;
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
  };

  engine.engine_init();

  let latestRenderState: GPURenderState | null = null;

  return {
    mode: ExecutionMode.SingleThread,
    commandBuffer,
    tick(dt: number) {
      commandBuffer.flush();
      const { bytes } = extractUnread(buffer as SharedArrayBuffer);
      if (bytes.length > 0) {
        engine.engine_push_commands(bytes);
      }
      engine.engine_update(dt);

      const count = engine.engine_gpu_entity_count();
      if (count > 0) {
        const tPtr = engine.engine_gpu_transforms_ptr();
        const tLen = engine.engine_gpu_transforms_f32_len();
        const bPtr = engine.engine_gpu_bounds_ptr();
        const bLen = engine.engine_gpu_bounds_f32_len();
        const mPtr = engine.engine_gpu_render_meta_ptr();
        const mLen = engine.engine_gpu_render_meta_len();
        const texPtr = engine.engine_gpu_tex_indices_ptr();
        const texLen = engine.engine_gpu_tex_indices_len();

        // Copy from WASM memory — live views become stale after next engine_update().
        latestRenderState = {
          entityCount: count,
          transforms: tPtr ? new Float32Array(new Float32Array(engine.memory.buffer, tPtr, tLen)) : new Float32Array(0),
          bounds: bPtr ? new Float32Array(new Float32Array(engine.memory.buffer, bPtr, bLen)) : new Float32Array(0),
          renderMeta: mPtr ? new Uint32Array(new Uint32Array(engine.memory.buffer, mPtr, mLen)) : new Uint32Array(0),
          texIndices: texPtr ? new Uint32Array(new Uint32Array(engine.memory.buffer, texPtr, texLen)) : new Uint32Array(0),
        };
      } else {
        latestRenderState = {
          entityCount: 0,
          transforms: new Float32Array(0),
          bounds: new Float32Array(0),
          renderMeta: new Uint32Array(0),
          texIndices: new Uint32Array(0),
        };
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
