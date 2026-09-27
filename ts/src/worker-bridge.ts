import { ExecutionMode } from "./capabilities";
import type { LightingQuality } from "./lighting-api";
import {
  createRingBuffer,
  RingBufferProducer,
  extractUnread,
} from "./ring-buffer";
import { BackpressuredProducer } from "./backpressure";
import { WorkerSupervisor } from "./supervisor";
import { TickSequencer } from "./tick-sequencer";

const RING_BUFFER_CAPACITY = 64 * 1024; // 64KB command buffer

/** Render state transferred from the engine each frame (SoA layout). */
export interface GPURenderState {
  entityCount: number;
  transforms: Float32Array;    // 16 f32/entity (mat4x4)
  bounds: Float32Array;        // 4 f32/entity (xyz + radius)
  renderMeta: Uint32Array;     // 2 u32/entity (meshHandle + renderPrimitive)
  texIndices: Uint32Array;     // 1 u32/entity
  primParams: Float32Array;    // 8 f32/entity (primitive parameters)
  entityIds: Uint32Array;      // 1 u32/entity (external entity ID)
  listenerX: number;           // audio listener world-space X
  listenerY: number;           // audio listener world-space Y
  listenerZ: number;           // audio listener world-space Z
  tickCount: number;           // cumulative WASM fixed-timestep tick count
  // Dirty staging data (for scatter upload path)
  dirtyCount: number;
  dirtyRatio: number;
  stagingData: Uint32Array | null;    // 32 u32 per dirty entity
  dirtyIndices: Uint32Array | null;   // slot index per dirty entity
  // Physics debug lines (Phase 16): 8 f32 per line [ax,ay,bx,by,r,g,b,a].
  // Non-null only on physics-debug builds while debug rendering is enabled.
  physicsDebugLines?: Float32Array | null;
  // Lighting engine-level state (Phase 17). Read back from WASM rather than
  // kept as a TypeScript copy for the same reason as the audio listener:
  // during a `ReplayPlayer` run the commands come off the tape, so a local
  // copy on this side would be stale.
  ambientR: number;
  ambientG: number;
  ambientB: number;
  ambientIntensity: number;
  lightingBackend: number;     // 0=off, 1=lit, 2=gi
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
  /** Resize the rendering surface. Only needed for Mode A (render worker). */
  resize?(width: number, height: number): void;
  /**
   * Lighting quality for a renderer that is not on this thread: Mode A's
   * render worker. `LightingAPI.setQuality` emits no ring-buffer command.
   */
  setLightingQuality?(quality: LightingQuality): void;
  /**
   * Determinism harness (Phase 16): canonical FNV-1a 64 state hash.
   * Resolves null on non-dev-tools WASM builds. Optional: present on all
   * built-in bridges.
   */
  getStateHash?(): Promise<bigint | null>;
  /**
   * The number the next tick will carry: a command written now (every flush
   * happens inside `tick()`, before the tick is sent) is consumed by that tick
   * or a later one. With `processed`, it drives the entity id quarantine.
   * Optional: a bridge without it never releases a freed id.
   */
  readonly nextTickSeq?: number;
  /** The latest tick the engine has fully processed, and its fixed-tick count after it. */
  readonly processed?: { readonly seq: number; readonly tickCount: number };
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

  const hashRequests = new Map<number, (hash: bigint | null) => void>();
  let nextHashRequestId = 1;

  let readyResolve: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  let latestRenderState: GPURenderState | null = null;

  const ticks = new TickSequencer();

  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "tick-done") ticks.ack(msg.seq, msg.tickCount);
    if (msg.type === "ready") {
      readyResolve();
    } else if (msg.type === "error") {
      console.error("Engine Worker error:", msg.error);
    } else if (msg.type === "state-hash-result") {
      const pending = hashRequests.get(msg.requestId);
      if (pending) {
        hashRequests.delete(msg.requestId);
        pending(msg.hash === null || msg.hash === undefined ? null : BigInt(msg.hash));
      }
    } else if (msg.type === "tick-done" && msg.renderState) {
      const rs = msg.renderState;
      latestRenderState = {
        entityCount: rs.entityCount,
        transforms: rs.transforms ? new Float32Array(rs.transforms) : new Float32Array(0),
        bounds: rs.bounds ? new Float32Array(rs.bounds) : new Float32Array(0),
        renderMeta: rs.renderMeta ? new Uint32Array(rs.renderMeta) : new Uint32Array(0),
        texIndices: rs.texIndices ? new Uint32Array(rs.texIndices) : new Uint32Array(0),
        primParams: rs.primParams ? new Float32Array(rs.primParams) : new Float32Array(0),
        entityIds: rs.entityIds ? new Uint32Array(rs.entityIds) : new Uint32Array(0),
        listenerX: rs.listenerX ?? 0,
        listenerY: rs.listenerY ?? 0,
        listenerZ: rs.listenerZ ?? 0,
        ambientR: rs.ambientR ?? 0,
        ambientG: rs.ambientG ?? 0,
        ambientB: rs.ambientB ?? 0,
        ambientIntensity: rs.ambientIntensity ?? 1,
        lightingBackend: rs.lightingBackend ?? 0,
        tickCount: msg.tickCount ?? 0,
        dirtyCount: rs.dirtyCount ?? 0,
        dirtyRatio: rs.dirtyRatio ?? 0,
        stagingData: rs.stagingData ? new Uint32Array(rs.stagingData) : null,
        dirtyIndices: rs.dirtyIndices ? new Uint32Array(rs.dirtyIndices) : null,
        physicsDebugLines: rs.physicsDebugLines ? new Float32Array(rs.physicsDebugLines) : null,
      };
    }
  };

  worker.postMessage({ type: "init", commandBuffer: sab });

  return {
    mode,
    commandBuffer,
    tick(dt: number) {
      commandBuffer.flush();
      worker.postMessage({ type: "tick", dt, seq: ticks.send() });
    },
    get nextTickSeq() {
      return ticks.nextSeq;
    },
    get processed() {
      return ticks.processed;
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
    getStateHash() {
      return new Promise<bigint | null>((resolve) => {
        const requestId = nextHashRequestId++;
        hashRequests.set(requestId, resolve);
        worker.postMessage({ type: "state-hash", requestId });
      });
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

  const hashRequestsA = new Map<number, (hash: bigint | null) => void>();
  let nextHashRequestIdA = 1;

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
  let readyReject: (err: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  let ecsReady = false;
  let renderReady = false;
  function checkBothReady() {
    if (ecsReady && renderReady) readyResolve();
  }

  let latestRenderState: GPURenderState | null = null;
  const ticksA = new TickSequencer();

  ecsWorker.onmessage = (event) => {
    const msg = event.data;
    // Before the entityCount filter below: an empty world still processed the tick.
    if (msg.type === "tick-done") ticksA.ack(msg.seq, msg.tickCount);
    if (msg.type === "ready") {
      ecsReady = true;
      checkBothReady();
    } else if (msg.type === "error") {
      console.error("ECS Worker error:", msg.error);
      readyReject(new Error(`ECS Worker failed: ${msg.error}`));
    } else if (msg.type === "state-hash-result") {
      const pending = hashRequestsA.get(msg.requestId);
      if (pending) {
        hashRequestsA.delete(msg.requestId);
        pending(msg.hash === null || msg.hash === undefined ? null : BigInt(msg.hash));
      }
    } else if (msg.type === "tick-done" && msg.renderState && msg.renderState.entityCount > 0) {
      const rs = msg.renderState;

      // Copy all SoA data for main-thread SystemViews, picking + audio
      // before transferring the ArrayBuffers to the render worker.
      latestRenderState = {
        entityCount: rs.entityCount,
        transforms: rs.transforms ? new Float32Array(new Float32Array(rs.transforms)) : new Float32Array(0),
        bounds: rs.bounds ? new Float32Array(new Float32Array(rs.bounds)) : new Float32Array(0),
        renderMeta: rs.renderMeta ? new Uint32Array(new Uint32Array(rs.renderMeta)) : new Uint32Array(0),
        texIndices: rs.texIndices ? new Uint32Array(new Uint32Array(rs.texIndices)) : new Uint32Array(0),
        primParams: rs.primParams ? new Float32Array(new Float32Array(rs.primParams)) : new Float32Array(0),
        entityIds: rs.entityIds ? new Uint32Array(new Uint32Array(rs.entityIds)) : new Uint32Array(0),
        listenerX: rs.listenerX ?? 0,
        listenerY: rs.listenerY ?? 0,
        listenerZ: rs.listenerZ ?? 0,
        ambientR: rs.ambientR ?? 0,
        ambientG: rs.ambientG ?? 0,
        ambientB: rs.ambientB ?? 0,
        ambientIntensity: rs.ambientIntensity ?? 1,
        lightingBackend: rs.lightingBackend ?? 0,
        tickCount: msg.tickCount ?? 0,
        dirtyCount: rs.dirtyCount ?? 0,
        dirtyRatio: rs.dirtyRatio ?? 0,
        stagingData: rs.stagingData ? new Uint32Array(new Uint32Array(rs.stagingData)) : null,
        dirtyIndices: rs.dirtyIndices ? new Uint32Array(new Uint32Array(rs.dirtyIndices)) : null,
        physicsDebugLines: rs.physicsDebugLines ? new Float32Array(new Float32Array(rs.physicsDebugLines)) : null,
      };

      // Forward full render state to Render Worker.
      const transferables = [rs.transforms, rs.bounds, rs.renderMeta, rs.texIndices];
      if (rs.primParams) transferables.push(rs.primParams);
      if (rs.entityIds) transferables.push(rs.entityIds);
      channel.port1.postMessage(
        { renderState: rs },
        transferables,
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
      readyReject(new Error(`Render Worker failed: ${msg.error}`));
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
      ecsWorker.postMessage({ type: "tick", dt, seq: ticksA.send() });
    },
    get nextTickSeq() {
      return ticksA.nextSeq;
    },
    get processed() {
      return ticksA.processed;
    },
    getStateHash() {
      return new Promise<bigint | null>((resolve) => {
        const requestId = nextHashRequestIdA++;
        hashRequestsA.set(requestId, resolve);
        ecsWorker.postMessage({ type: "state-hash", requestId });
      });
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
      return latestRenderState;
    },
    resize(width: number, height: number) {
      renderWorker.postMessage({ type: "resize", width, height });
    },
    setLightingQuality(quality: LightingQuality) {
      renderWorker.postMessage({ type: "lighting-quality", quality });
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
    /** Command bytes discarded because of an unknown opcode (protocol skew). */
    engine_dropped_command_bytes?(): number;
    /** Commands rejected for an out-of-range external entity id. */
    engine_rejected_command_count?(): number;
  /** Command bytes discarded because of an unknown opcode (protocol skew). */
  engine_dropped_command_bytes?(): number;
  /** Commands rejected for an out-of-range external entity id. */
  engine_rejected_command_count?(): number;
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
    engine_gpu_prim_params_ptr(): number;
    engine_gpu_prim_params_f32_len(): number;
    engine_gpu_entity_ids_ptr(): number;
    engine_gpu_entity_ids_len(): number;
    // Listener position exports
    engine_listener_x(): number;
    engine_listener_y(): number;
    engine_listener_z(): number;
    // Lighting engine-level exports (Phase 17). Optional so a WASM build
    // predating them still satisfies this interface.
    engine_ambient_r?(): number;
    engine_ambient_g?(): number;
    engine_ambient_b?(): number;
    engine_ambient_intensity?(): number;
    engine_lighting_backend?(): number;
    engine_tick_count(): bigint;
    engine_memory(): WebAssembly.Memory;
    // Dirty staging exports
    engine_dirty_count(): number;
    engine_dirty_ratio(): number;
    engine_staging_ptr(): number;
    engine_staging_u32_len(): number;
    engine_staging_indices_ptr(): number;
    engine_staging_indices_len(): number;
    // Physics debug exports (physics-debug builds only)
    engine_physics_debug_ptr?(): number;
    engine_physics_debug_f32_len?(): number;
    // Determinism harness export (dev-tools builds only)
    engine_state_hash?(): bigint;
  };

  engine.engine_init();

  let latestRenderState: GPURenderState | null = null;
  const ticksC = new TickSequencer();

  return {
    mode: ExecutionMode.SingleThread,
    commandBuffer,
    getStateHash() {
      return Promise.resolve(engine.engine_state_hash?.() ?? null);
    },
    tick(dt: number) {
      commandBuffer.flush();
      const seq = ticksC.send();
      const { bytes } = extractUnread(buffer as SharedArrayBuffer);
      if (bytes.length > 0) {
        engine.engine_push_commands(bytes);
      }
      engine.engine_update(dt);

      const tickCount = Number(engine.engine_tick_count());
      ticksC.ack(seq, tickCount); // push and update are synchronous here
      const count = engine.engine_gpu_entity_count();

      // Read dirty staging data from WASM
      const dirtyCount = engine.engine_dirty_count();
      const dirtyRatio = engine.engine_dirty_ratio();
      let stagingData: Uint32Array | null = null;
      let dirtyIndicesArr: Uint32Array | null = null;

      if (dirtyCount > 0) {
        const stagingPtr = engine.engine_staging_ptr();
        const stagingLen = engine.engine_staging_u32_len();
        const indicesPtr = engine.engine_staging_indices_ptr();
        const indicesLen = engine.engine_staging_indices_len();

        // Copy from WASM memory (same pattern as SoA data — views become stale after next engine_update)
        const mem = engine.engine_memory();
        stagingData = stagingPtr
          ? new Uint32Array(new Uint32Array(mem.buffer, stagingPtr, stagingLen))
          : null;
        dirtyIndicesArr = indicesPtr
          ? new Uint32Array(new Uint32Array(mem.buffer, indicesPtr, indicesLen))
          : null;
      }

      if (count > 0) {
        const tPtr = engine.engine_gpu_transforms_ptr();
        const tLen = engine.engine_gpu_transforms_f32_len();
        const bPtr = engine.engine_gpu_bounds_ptr();
        const bLen = engine.engine_gpu_bounds_f32_len();
        const mPtr = engine.engine_gpu_render_meta_ptr();
        const mLen = engine.engine_gpu_render_meta_len();
        const texPtr = engine.engine_gpu_tex_indices_ptr();
        const texLen = engine.engine_gpu_tex_indices_len();
        const ppPtr = engine.engine_gpu_prim_params_ptr();
        const ppLen = engine.engine_gpu_prim_params_f32_len();
        const eidPtr = engine.engine_gpu_entity_ids_ptr();
        const eidLen = engine.engine_gpu_entity_ids_len();

        // Copy from WASM memory — live views become stale after next engine_update().
        latestRenderState = {
          entityCount: count,
          transforms: tPtr ? new Float32Array(new Float32Array(engine.engine_memory().buffer, tPtr, tLen)) : new Float32Array(0),
          bounds: bPtr ? new Float32Array(new Float32Array(engine.engine_memory().buffer, bPtr, bLen)) : new Float32Array(0),
          renderMeta: mPtr ? new Uint32Array(new Uint32Array(engine.engine_memory().buffer, mPtr, mLen)) : new Uint32Array(0),
          texIndices: texPtr ? new Uint32Array(new Uint32Array(engine.engine_memory().buffer, texPtr, texLen)) : new Uint32Array(0),
          primParams: ppPtr ? new Float32Array(new Float32Array(engine.engine_memory().buffer, ppPtr, ppLen)) : new Float32Array(0),
          entityIds: eidPtr ? new Uint32Array(new Uint32Array(engine.engine_memory().buffer, eidPtr, eidLen)) : new Uint32Array(0),
          listenerX: engine.engine_listener_x(),
          listenerY: engine.engine_listener_y(),
          listenerZ: engine.engine_listener_z(),
          ambientR: engine.engine_ambient_r?.() ?? 0,
          ambientG: engine.engine_ambient_g?.() ?? 0,
          ambientB: engine.engine_ambient_b?.() ?? 0,
          ambientIntensity: engine.engine_ambient_intensity?.() ?? 1,
          lightingBackend: engine.engine_lighting_backend?.() ?? 0,
          tickCount,
          dirtyCount,
          dirtyRatio,
          stagingData,
          dirtyIndices: dirtyIndicesArr,
          physicsDebugLines: (() => {
            const len = engine.engine_physics_debug_f32_len?.() ?? 0;
            if (len === 0) return null;
            const ptr = engine.engine_physics_debug_ptr!();
            return ptr ? new Float32Array(new Float32Array(engine.engine_memory().buffer, ptr, len)) : null;
          })(),
        };
      } else {
        latestRenderState = {
          entityCount: 0,
          transforms: new Float32Array(0),
          bounds: new Float32Array(0),
          renderMeta: new Uint32Array(0),
          texIndices: new Uint32Array(0),
          primParams: new Float32Array(0),
          entityIds: new Uint32Array(0),
          listenerX: engine.engine_listener_x(),
          listenerY: engine.engine_listener_y(),
          listenerZ: engine.engine_listener_z(),
          ambientR: engine.engine_ambient_r?.() ?? 0,
          ambientG: engine.engine_ambient_g?.() ?? 0,
          ambientB: engine.engine_ambient_b?.() ?? 0,
          ambientIntensity: engine.engine_ambient_intensity?.() ?? 1,
          lightingBackend: engine.engine_lighting_backend?.() ?? 0,
          tickCount,
          dirtyCount: 0,
          dirtyRatio: 0,
          stagingData: null,
          dirtyIndices: null,
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
    get nextTickSeq() {
      return ticksC.nextSeq;
    },
    get processed() {
      return ticksC.processed;
    },
  };
}
