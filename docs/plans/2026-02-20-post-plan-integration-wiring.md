# Post-Plan Integration & Wiring — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire Phase 4.5's standalone abstractions (RenderGraph, CullPass, ForwardPass, BackpressuredProducer, WorkerSupervisor) into the live engine, replacing the monolithic renderer pipeline.

**Architecture:** The monolithic `createRenderer()` becomes a thin factory that internally builds a `RenderGraph` with `CullPass` + `ForwardPass`. Shared GPU buffers live in a `ResourcePool`. Entity data switches fully to SoA layout (separate transforms, bounds, texIndices buffers). The render shader (`basic.wgsl`) drops the monolithic `EntityData` struct and reads directly from `array<mat4x4f>`. Backpressure wraps the ring buffer producer to automatically queue overflow commands. WorkerSupervisor monitors worker heartbeats from the bridges.

**Tech Stack:** TypeScript (Vitest), WebGPU (WGSL), SharedArrayBuffer (Atomics)

---

### Task 1: BackpressuredProducer — Write Failing Tests

**Files:**
- Modify: `ts/src/backpressure.test.ts` (append new describe block)

**Step 1: Write the failing tests**

Add new imports at the top of `ts/src/backpressure.test.ts` (merge with existing imports):

```ts
import { BackpressuredProducer } from './backpressure';
import { RingBufferProducer, createRingBuffer, extractUnread } from './ring-buffer';
```

Add a new describe block at the end of the file:

```ts
describe('BackpressuredProducer', () => {
  function createSmallProducer(): { bp: BackpressuredProducer; sab: SharedArrayBuffer } {
    // Tiny ring buffer: 32-byte header + 64 bytes data (fits ~3 commands)
    const sab = createRingBuffer(64) as SharedArrayBuffer;
    const inner = new RingBufferProducer(sab);
    const bp = new BackpressuredProducer(inner);
    return { bp, sab };
  }

  it('should pass commands through when ring buffer has space', () => {
    const { bp } = createSmallProducer();
    expect(bp.spawnEntity(1)).toBe(true);
    expect(bp.pendingCount).toBe(0);
  });

  it('should queue commands when ring buffer is full', () => {
    const { bp } = createSmallProducer();
    // Fill the buffer — 17 bytes each (1 cmd + 4 id + 12 payload)
    for (let i = 0; i < 20; i++) {
      bp.setPosition(i, 1, 2, 3);
    }
    expect(bp.pendingCount).toBeGreaterThan(0);
  });

  it('should drain queued commands on flush', () => {
    const { bp, sab } = createSmallProducer();
    // Fill buffer until overflow
    for (let i = 0; i < 20; i++) {
      bp.setPosition(i, 1, 2, 3);
    }
    const pending = bp.pendingCount;
    expect(pending).toBeGreaterThan(0);

    // Free the ring buffer by extracting all unread bytes
    extractUnread(sab);
    bp.flush();
    expect(bp.pendingCount).toBeLessThan(pending);
  });

  it('should be a no-op to flush an empty queue', () => {
    const { bp } = createSmallProducer();
    bp.spawnEntity(1);
    bp.flush(); // nothing queued
    expect(bp.pendingCount).toBe(0);
  });

  it('should expose freeSpace from inner producer', () => {
    const { bp } = createSmallProducer();
    expect(bp.freeSpace).toBeGreaterThan(0);
    bp.spawnEntity(1);
    expect(bp.freeSpace).toBeLessThan(64);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/backpressure.test.ts -v`
Expected: FAIL — `BackpressuredProducer` is not exported from `./backpressure`

**Step 3: Commit**

```bash
git add ts/src/backpressure.test.ts
git commit -m "test(backpressure): add failing tests for BackpressuredProducer

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: BackpressuredProducer — Implementation

**Files:**
- Modify: `ts/src/backpressure.ts` (add class at end of file)

**Step 1: Implement BackpressuredProducer**

Append to the end of `ts/src/backpressure.ts`:

```ts
/**
 * Wraps a RingBufferProducer with automatic overflow queuing.
 *
 * When writeCommand() fails (ring buffer full), the command is enqueued
 * into a PrioritizedCommandQueue. Call flush() at the start of each tick
 * to drain queued commands back into the ring buffer.
 */
export class BackpressuredProducer {
  private readonly inner: RingBufferProducer;
  private readonly queue = new PrioritizedCommandQueue();

  constructor(inner: RingBufferProducer) {
    this.inner = inner;
  }

  get pendingCount(): number {
    return this.queue.criticalCount + this.queue.overwriteCount;
  }

  get freeSpace(): number {
    return this.inner.freeSpace;
  }

  flush(): void {
    this.queue.drainTo(this.inner);
  }

  writeCommand(cmd: CommandType, entityId: number, payload?: Float32Array): boolean {
    const ok = this.inner.writeCommand(cmd, entityId, payload);
    if (!ok) {
      this.queue.enqueue(cmd, entityId, payload);
    }
    return ok;
  }

  spawnEntity(entityId: number): boolean {
    return this.writeCommand(CommandType.SpawnEntity, entityId);
  }

  despawnEntity(entityId: number): boolean {
    return this.writeCommand(CommandType.DespawnEntity, entityId);
  }

  setPosition(entityId: number, x: number, y: number, z: number): boolean {
    return this.writeCommand(CommandType.SetPosition, entityId, new Float32Array([x, y, z]));
  }

  setTextureLayer(entityId: number, packedIndex: number): boolean {
    const p = new Float32Array(1);
    new Uint32Array(p.buffer)[0] = packedIndex;
    return this.writeCommand(CommandType.SetTextureLayer, entityId, p);
  }

  setMeshHandle(entityId: number, handle: number): boolean {
    const p = new Float32Array(1);
    new Uint32Array(p.buffer)[0] = handle;
    return this.writeCommand(CommandType.SetMeshHandle, entityId, p);
  }

  setRenderPrimitive(entityId: number, primitive: number): boolean {
    const p = new Float32Array(1);
    new Uint32Array(p.buffer)[0] = primitive;
    return this.writeCommand(CommandType.SetRenderPrimitive, entityId, p);
  }
}
```

Note: change the existing `import type { RingBufferProducer }` on line 1 to a value import:
```ts
import { RingBufferProducer, CommandType } from './ring-buffer';
```
(Remove the separate `import { CommandType }` on line 2 and merge into one import.)

**Step 2: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/backpressure.test.ts -v`
Expected: ALL PASS

**Step 3: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add ts/src/backpressure.ts
git commit -m "feat(backpressure): add BackpressuredProducer with overflow queue

Wraps RingBufferProducer to automatically queue commands that fail
due to ring buffer being full. flush() drains the queue in priority
order (critical first, then overwrites).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Wire Backpressure into EngineBridge

**Files:**
- Modify: `ts/src/worker-bridge.ts:1-7` (update imports)
- Modify: `ts/src/worker-bridge.ts:19-21` (update interface)
- Modify: `ts/src/worker-bridge.ts:35-88` (Mode B bridge)
- Modify: `ts/src/worker-bridge.ts:94-183` (Mode A bridge)
- Modify: `ts/src/worker-bridge.ts:188-268` (Mode C bridge)

**Step 1: Update imports**

At the top of `worker-bridge.ts`, add `BackpressuredProducer` import:

```ts
import { BackpressuredProducer } from "./backpressure";
```

**Step 2: Update EngineBridge interface**

Change `commandBuffer: RingBufferProducer` to `commandBuffer: BackpressuredProducer` in the interface.

**Step 3: Update all three bridge factories**

In each factory function:
1. After creating the `RingBufferProducer`, wrap it:
   ```ts
   const commandBuffer = new BackpressuredProducer(producer);
   ```
2. In the `tick()` method, add `commandBuffer.flush()` as the FIRST line before any other logic.
3. Return `commandBuffer` instead of `producer`.

For `createWorkerBridge`:
```ts
tick(dt: number) {
  commandBuffer.flush();
  worker.postMessage({ type: "tick", dt });
},
```

For `createFullIsolationBridge`:
```ts
tick(dt: number) {
  commandBuffer.flush();
  ecsWorker.postMessage({ type: "tick", dt });
},
```

For `createDirectBridge`:
```ts
tick(dt: number) {
  commandBuffer.flush();
  const { bytes } = extractUnread(buffer as SharedArrayBuffer);
  // ... rest unchanged
},
```

**Step 4: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 5: Run all tests**

Run: `cd ts && npm test`
Expected: ALL PASS (90 tests)

**Step 6: Commit**

```bash
git add ts/src/worker-bridge.ts
git commit -m "feat(bridge): wire BackpressuredProducer into all bridges

Commands that fail due to ring buffer full are now automatically
queued and retried at the start of each tick via flush().

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Engine-Worker Heartbeat

**Files:**
- Modify: `ts/src/engine-worker.ts:10` (add import)
- Modify: `ts/src/engine-worker.ts:76` (add heartbeat after engine_update)

**Step 1: Add heartbeat import**

At the top of `engine-worker.ts`, add:
```ts
import { extractUnread, HEARTBEAT_W1_OFFSET } from "./ring-buffer";
```

**Step 2: Increment heartbeat after engine_update**

In the `case "tick"` handler, after `wasm.engine_update(msg.dt)` (line 76), add:

```ts
      // Increment heartbeat for supervisor monitoring
      const header = new Int32Array(commandBuffer!, 0, 8);
      Atomics.add(header, HEARTBEAT_W1_OFFSET, 1);
```

**Step 3: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add ts/src/engine-worker.ts
git commit -m "feat(engine-worker): increment heartbeat after each tick

Writes to HEARTBEAT_W1_OFFSET in the SAB header so the
WorkerSupervisor on the main thread can detect stalls.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Wire Supervisor into Bridges

**Files:**
- Modify: `ts/src/worker-bridge.ts` (add supervisor to Mode A and Mode B)

**Step 1: Add supervisor import**

Add at the top of `worker-bridge.ts`:
```ts
import { WorkerSupervisor } from "./supervisor";
```

**Step 2: Add supervisor to Mode B bridge (createWorkerBridge)**

After creating the `BackpressuredProducer`, add:
```ts
  const supervisor = new WorkerSupervisor(sab, {
    onTimeout: (workerId) => {
      console.warn(`[Hyperion] Worker ${workerId} heartbeat timeout`);
    },
  });
  const supervisorInterval = setInterval(() => supervisor.check(), 1000);
```

In `destroy()`:
```ts
    destroy() {
      clearInterval(supervisorInterval);
      worker.terminate();
    },
```

**Step 3: Add supervisor to Mode A bridge (createFullIsolationBridge)**

Same pattern — create supervisor with `sab`, start interval, clear on destroy:
```ts
  const supervisor = new WorkerSupervisor(sab, {
    onTimeout: (workerId) => {
      console.warn(`[Hyperion] Worker ${workerId} heartbeat timeout`);
    },
  });
  const supervisorInterval = setInterval(() => supervisor.check(), 1000);
```

In `destroy()`:
```ts
    destroy() {
      clearInterval(supervisorInterval);
      ecsWorker.terminate();
      renderWorker.terminate();
    },
```

Mode C (`createDirectBridge`) does NOT get a supervisor — no workers to monitor.

**Step 4: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add ts/src/worker-bridge.ts
git commit -m "feat(bridge): wire WorkerSupervisor into Mode A/B bridges

Supervisor checks ECS worker heartbeat every 1s. Logs a warning
if 3 consecutive checks find no heartbeat increment.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Update basic.wgsl for SoA Transforms

**Files:**
- Modify: `ts/src/shaders/basic.wgsl`

**Context:** The render shader currently uses `entities: array<EntityData>` where EntityData is `{ model: mat4x4f, boundingSphere: vec4f }` (20 floats/entity). Only the `model` field is ever read. Switching to `transforms: array<mat4x4f>` eliminates the monolithic entity buffer, letting the forward pass share the SoA transforms buffer with the cull pass.

**Step 1: Update the shader**

Replace the EntityData struct and binding with SoA transforms:

```wgsl
// Remove this:
struct EntityData {
    model: mat4x4f,
    boundingSphere: vec4f,
};
@group(0) @binding(1) var<storage, read> entities: array<EntityData>;

// Replace with:
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
```

Update the vertex shader body — change:
```wgsl
    let model = entities[entityIdx].model;
```
to:
```wgsl
    let model = transforms[entityIdx];
```

**Step 2: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors (shader is loaded as raw string)

**Step 3: Commit**

```bash
git add ts/src/shaders/basic.wgsl
git commit -m "refactor(shader): switch render shader to SoA transforms

Remove EntityData struct, read model matrix directly from
transforms: array<mat4x4f>. Eliminates the monolithic entity buffer
so forward pass shares the SoA transforms buffer with cull pass.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Complete CullPass.prepare()

**Files:**
- Modify: `ts/src/render/passes/cull-pass.ts`

**Step 1: Add stored reference for indirect buffer**

Add a private field:
```ts
  private indirectBuffer: GPUBuffer | null = null;
```

In `setup()`, after `const indirectBuffer = resources.getBuffer('indirect-args');`, add:
```ts
    this.indirectBuffer = indirectBuffer;
```

**Step 2: Add frustum extraction function**

Add at the top of the file (after imports):
```ts
/** Extract 6 normalized frustum planes from a 4x4 view-projection matrix. */
function extractFrustumPlanes(vp: Float32Array): Float32Array {
  const planes = new Float32Array(24);
  const m = vp;
  // Left, Right, Bottom, Top, Near, Far
  planes[0]  = m[3]+m[0];  planes[1]  = m[7]+m[4];  planes[2]  = m[11]+m[8];  planes[3]  = m[15]+m[12];
  planes[4]  = m[3]-m[0];  planes[5]  = m[7]-m[4];  planes[6]  = m[11]-m[8];  planes[7]  = m[15]-m[12];
  planes[8]  = m[3]+m[1];  planes[9]  = m[7]+m[5];  planes[10] = m[11]+m[9];  planes[11] = m[15]+m[13];
  planes[12] = m[3]-m[1];  planes[13] = m[7]-m[5];  planes[14] = m[11]-m[9];  planes[15] = m[15]-m[13];
  planes[16] = m[2];       planes[17] = m[6];        planes[18] = m[10];       planes[19] = m[14];
  planes[20] = m[3]-m[2];  planes[21] = m[7]-m[6];  planes[22] = m[11]-m[10]; planes[23] = m[15]-m[14];
  for (let i = 0; i < 6; i++) {
    const o = i * 4;
    const len = Math.sqrt(planes[o]**2 + planes[o+1]**2 + planes[o+2]**2);
    if (len > 0) { planes[o] /= len; planes[o+1] /= len; planes[o+2] /= len; planes[o+3] /= len; }
  }
  return planes;
}
```

**Step 3: Implement prepare()**

Replace the empty `prepare()` body:
```ts
  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.cullUniformBuffer || !this.indirectBuffer) return;

    // Upload frustum planes (6 × vec4f = 96 bytes) + entityCount (u32 + 3 padding)
    const CULL_UNIFORM_SIZE = 112;
    const data = new ArrayBuffer(CULL_UNIFORM_SIZE);
    const floats = new Float32Array(data, 0, 24);
    floats.set(extractFrustumPlanes(frame.cameraViewProjection));
    const uints = new Uint32Array(data, 96, 4);
    uints[0] = frame.entityCount;
    device.queue.writeBuffer(this.cullUniformBuffer, 0, data);

    // Reset indirect draw args: indexCount=6 (quad), instanceCount=0 (filled by compute)
    device.queue.writeBuffer(this.indirectBuffer, 0, new Uint32Array([6, 0, 0, 0, 0]));
  }
```

**Step 4: Update destroy() for new field**

Add to destroy():
```ts
    this.indirectBuffer = null;
```

**Step 5: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 6: Run existing CullPass test**

Run: `cd ts && npx vitest run src/render/passes/cull-pass.test.ts -v`
Expected: PASS (1 test)

**Step 7: Commit**

```bash
git add ts/src/render/passes/cull-pass.ts
git commit -m "feat(cull-pass): complete prepare() — frustum upload + indirect reset

Uploads 6 frustum planes + entity count to uniform buffer and
resets indirect draw args each frame. Stores indirect buffer
reference from ResourcePool for use during prepare.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Complete ForwardPass — SoA + Swapchain

**Files:**
- Modify: `ts/src/render/passes/forward-pass.ts`

**Step 1: Update resource reads to SoA**

Change the `reads` array:
```ts
  readonly reads = ['visible-indices', 'entity-transforms', 'tex-indices', 'indirect-args'];
```

In `setup()`, change:
```ts
    // Old:
    const entityBuffer = resources.getBuffer('entity-data');
    if (!entityBuffer) throw new Error("ForwardPass.setup: missing 'entity-data' in ResourcePool");
    // New:
    const transformBuffer = resources.getBuffer('entity-transforms');
    if (!transformBuffer) throw new Error("ForwardPass.setup: missing 'entity-transforms' in ResourcePool");
```

And update the bind group entry to use `transformBuffer`:
```ts
        { binding: 1, resource: { buffer: transformBuffer } },
```

**Step 2: Implement prepare() — camera upload + lazy depth texture**

```ts
  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.cameraBuffer) return;

    // Upload camera view-projection matrix
    device.queue.writeBuffer(
      this.cameraBuffer, 0,
      frame.cameraViewProjection as Float32Array<ArrayBuffer>,
    );

    // Lazy depth texture creation (or resize)
    if (!this.depthTexture ||
        this.depthTexture.width !== frame.canvasWidth ||
        this.depthTexture.height !== frame.canvasHeight) {
      this.depthTexture?.destroy();
      this.depthTexture = device.createTexture({
        size: { width: frame.canvasWidth, height: frame.canvasHeight },
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
  }
```

**Step 3: Implement execute() — render pass with swapchain**

```ts
  execute(encoder: GPUCommandEncoder, _frame: FrameState, resources: ResourcePool): void {
    if (!this.pipeline || !this.vertexBuffer || !this.indexBuffer ||
        !this.cameraBuffer || !this.bindGroup0 || !this.depthTexture) return;
    if (!this.bindGroup1) return; // texture tiers not yet populated

    const indirectBuffer = resources.getBuffer('indirect-args');
    const swapchainView = resources.getTextureView('swapchain');
    if (!indirectBuffer || !swapchainView) return;

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: swapchainView,
        loadOp: 'clear' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
        clearValue: { r: 0.067, g: 0.067, b: 0.067, a: 1 },
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthLoadOp: 'clear' as GPULoadOp,
        depthStoreOp: 'store' as GPUStoreOp,
        depthClearValue: 1.0,
      },
    });
    renderPass.setPipeline(this.pipeline);
    renderPass.setVertexBuffer(0, this.vertexBuffer);
    renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
    renderPass.setBindGroup(0, this.bindGroup0);
    renderPass.setBindGroup(1, this.bindGroup1);
    renderPass.drawIndexedIndirect(indirectBuffer, 0);
    renderPass.end();
  }
```

**Step 4: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add ts/src/render/passes/forward-pass.ts
git commit -m "feat(forward-pass): complete prepare/execute with SoA + swapchain

- Switch from monolithic entity-data to SoA entity-transforms
- prepare(): uploads camera uniform, creates/resizes depth texture
- execute(): acquires swapchain from ResourcePool, runs render pass
- Fixes depth texture resize bug (lazy recreation on dimension change)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 9: Refactor createRenderer() → RenderGraph

**Files:**
- Modify: `ts/src/renderer.ts` (major refactor)

**Context:** This is the largest task. The monolithic `createRenderer()` becomes a thin factory that builds a `RenderGraph` with `CullPass` + `ForwardPass`, populates a `ResourcePool` with shared GPU buffers, and delegates `render()` to the graph.

**Step 1: Update imports**

Replace the top of `renderer.ts`:
```ts
import shaderCode from './shaders/basic.wgsl?raw';
import cullShaderCode from './shaders/cull.wgsl?raw';
import { TextureManager } from './texture-manager';
import type { GPURenderState } from './worker-bridge';
import { RenderGraph } from './render/render-graph';
import { ResourcePool } from './render/resource-pool';
import { CullPass } from './render/passes/cull-pass';
import { ForwardPass } from './render/passes/forward-pass';
import type { FrameState } from './render/render-pass';
```

**Step 2: Update Renderer interface**

```ts
export interface Renderer {
  render(
    state: GPURenderState,
    camera: { viewProjection: Float32Array },
  ): void;
  readonly textureManager: TextureManager;
  destroy(): void;
}
```

**Step 3: Rewrite createRenderer() body**

Replace the entire function body. The new implementation:

1. Gets adapter + device, configures canvas context (same as before)
2. Creates `TextureManager` (same as before)
3. Creates shared GPU buffers and populates `ResourcePool`
4. Sets shader sources, creates `CullPass` + `ForwardPass`, calls `setup()`
5. Creates `RenderGraph`, adds passes, compiles
6. Returns `Renderer` whose `render()` uploads SoA data → calls `graph.render()`

```ts
const MAX_ENTITIES = 100_000;

export interface Renderer {
  render(
    state: GPURenderState,
    camera: { viewProjection: Float32Array },
  ): void;
  readonly textureManager: TextureManager;
  destroy(): void;
}

export async function createRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): Promise<Renderer> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();

  const context = canvas instanceof HTMLCanvasElement
    ? canvas.getContext("webgpu")!
    : (canvas as OffscreenCanvas).getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const textureManager = new TextureManager(device);

  // --- Shared GPU Buffers → ResourcePool ---
  const resources = new ResourcePool();

  const transformBuffer = device.createBuffer({
    size: MAX_ENTITIES * 16 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  resources.setBuffer('entity-transforms', transformBuffer);

  const boundsBuffer = device.createBuffer({
    size: MAX_ENTITIES * 4 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  resources.setBuffer('entity-bounds', boundsBuffer);

  const visibleIndicesBuffer = device.createBuffer({
    size: MAX_ENTITIES * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  resources.setBuffer('visible-indices', visibleIndicesBuffer);

  const indirectBuffer = device.createBuffer({
    size: 20,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  });
  resources.setBuffer('indirect-args', indirectBuffer);

  const texIndexBuffer = device.createBuffer({
    size: MAX_ENTITIES * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  resources.setBuffer('tex-indices', texIndexBuffer);

  // TextureManager tier views + sampler
  resources.setTextureView('tier0', textureManager.getTierView(0));
  resources.setTextureView('tier1', textureManager.getTierView(1));
  resources.setTextureView('tier2', textureManager.getTierView(2));
  resources.setTextureView('tier3', textureManager.getTierView(3));
  resources.setSampler('texSampler', textureManager.getSampler());

  // --- RenderGraph with CullPass + ForwardPass ---
  CullPass.SHADER_SOURCE = cullShaderCode;
  ForwardPass.SHADER_SOURCE = shaderCode;

  const cullPass = new CullPass();
  cullPass.setup(device, resources);

  const forwardPass = new ForwardPass();
  forwardPass.setup(device, resources);

  const graph = new RenderGraph();
  graph.addPass(cullPass);
  graph.addPass(forwardPass);
  graph.compile();

  // Reusable zero-filled fallback for texture indices
  const defaultTexIndices = new Uint32Array(MAX_ENTITIES);

  return {
    textureManager,

    render(state, camera) {
      if (state.entityCount === 0) return;

      // Upload SoA entity data to shared GPU buffers
      device.queue.writeBuffer(
        transformBuffer, 0,
        state.transforms as Float32Array<ArrayBuffer>, 0,
        state.entityCount * 16,
      );
      device.queue.writeBuffer(
        boundsBuffer, 0,
        state.bounds as Float32Array<ArrayBuffer>, 0,
        state.entityCount * 4,
      );

      const texIdx = state.texIndices.length > 0 ? state.texIndices : defaultTexIndices;
      device.queue.writeBuffer(
        texIndexBuffer, 0,
        texIdx as Uint32Array<ArrayBuffer>, 0,
        state.entityCount,
      );

      // Update per-frame swapchain view
      const swapchainView = context.getCurrentTexture().createView();
      resources.setTextureView('swapchain', swapchainView);

      // Build FrameState
      const frame: FrameState = {
        entityCount: state.entityCount,
        transforms: state.transforms,
        bounds: state.bounds,
        renderMeta: state.renderMeta,
        texIndices: state.texIndices,
        cameraViewProjection: camera.viewProjection,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        deltaTime: 0,
      };

      graph.render(device, frame, resources);
    },

    destroy() {
      graph.destroy();
      resources.destroy();
      textureManager.destroy();
      device.destroy();
    },
  };
}
```

Delete the old `createDepthTexture()` and `extractFrustumPlanesInternal()` helper functions from the bottom of the file — they are no longer needed (CullPass has its own frustum extraction, ForwardPass creates depth texture lazily).

**Step 4: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add ts/src/renderer.ts
git commit -m "refactor(renderer): delegate to RenderGraph with CullPass + ForwardPass

createRenderer() now builds a RenderGraph internally. Shared GPU
buffers live in a ResourcePool. The monolithic 20-float entity buffer
is eliminated — renderer uploads SoA transforms/bounds/texIndices
directly. The render() signature accepts GPURenderState.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 10: Update main.ts + render-worker.ts

**Files:**
- Modify: `ts/src/main.ts:120-129` (render call)
- Modify: `ts/src/render-worker.ts:72-79` (render call)

**Step 1: Update main.ts render call**

Replace the render block in the `frame()` function (around lines 120-131):

```ts
    if (renderer && bridge.latestRenderState && bridge.latestRenderState.entityCount > 0) {
      renderer.render(bridge.latestRenderState, camera);
    }
```

Remove the TODO comment. This is now correct — `renderer.render()` accepts `GPURenderState` directly.

**Step 2: Update render-worker.ts render call**

Replace the render block in the `renderFrame()` function (around lines 72-79):

```ts
    if (renderer && latestRenderState && latestRenderState.entityCount > 0) {
      const state = {
        entityCount: latestRenderState.entityCount,
        transforms: new Float32Array(latestRenderState.transforms),
        bounds: new Float32Array(latestRenderState.bounds),
        renderMeta: new Uint32Array(latestRenderState.renderMeta),
        texIndices: new Uint32Array(latestRenderState.texIndices),
      };
      renderer.render(state, camera);
    }
```

Remove the TODO comment.

**Step 3: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add ts/src/main.ts ts/src/render-worker.ts
git commit -m "feat(main): pass GPURenderState directly to renderer

Both main.ts (Mode B/C) and render-worker.ts (Mode A) now pass
the full SoA render state to renderer.render() instead of the
old monolithic entity data workaround.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 11: WASM Rebuild + Full Validation

**Files:** None (verification only)

**Step 1: WASM rebuild**

Run: `cd ts && npm run build:wasm`
Expected: Build succeeds (no Rust changes, but ensures WASM is fresh)

**Step 2: Rust tests**

Run: `cargo test -p hyperion-core`
Expected: 68 tests PASS

**Step 3: Rust lints**

Run: `cargo clippy -p hyperion-core`
Expected: No warnings

**Step 4: TypeScript tests**

Run: `cd ts && npm test`
Expected: ALL PASS (90+ tests — new BackpressuredProducer tests added)

**Step 5: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 6: Commit (if any test fixes were needed)**

If everything passes cleanly, no commit needed. If fixes were required, commit them with an appropriate message.

---

### Task 12: Visual Regression Test

**Files:** None (manual browser verification)

**Step 1: Start dev server**

Run: `cd ts && npm run dev`

**Step 2: Open browser**

Navigate to `http://localhost:5173` in Chrome with WebGPU enabled.

**Step 3: Verify rendering**

Check:
- [ ] 50 colored quads visible in a grid (inside frustum)
- [ ] FPS counter showing reasonable values (30+)
- [ ] No console errors related to WebGPU
- [ ] Overlay shows correct entity count (100)
- [ ] Mode detection works (A/B/C depending on browser)

**Step 4: Verify culling**

50 entities are positioned outside the frustum. The overlay should show 100 entities total, but only ~50 should be visible as colored quads (the cull shader hides the rest).

**Step 5: Stop dev server**

`Ctrl+C` to stop.

---

## Summary of Changes

| File | Change Type | Description |
|------|------------|-------------|
| `ts/src/backpressure.ts` | Add class | `BackpressuredProducer` wrapper |
| `ts/src/backpressure.test.ts` | Add tests | 5 tests for `BackpressuredProducer` |
| `ts/src/worker-bridge.ts` | Modify | `BackpressuredProducer` + `WorkerSupervisor` wiring |
| `ts/src/engine-worker.ts` | Modify | Heartbeat increment after tick |
| `ts/src/shaders/basic.wgsl` | Modify | SoA `transforms` replaces monolithic `EntityData` |
| `ts/src/render/passes/cull-pass.ts` | Modify | Complete `prepare()` — frustum + indirect reset |
| `ts/src/render/passes/forward-pass.ts` | Modify | Complete `prepare()`/`execute()`, SoA + swapchain |
| `ts/src/renderer.ts` | Rewrite | `RenderGraph` delegation, new `render()` signature |
| `ts/src/main.ts` | Modify | Pass `GPURenderState` to renderer |
| `ts/src/render-worker.ts` | Modify | Pass `GPURenderState` to renderer |

## Validation Checklist

- [ ] BackpressuredProducer queues overflow and drains on flush
- [ ] WorkerSupervisor monitors heartbeat from bridges
- [ ] Engine worker increments heartbeat after each tick
- [ ] Render shader uses SoA transforms (no monolithic buffer)
- [ ] CullPass uploads frustum planes and resets indirect args
- [ ] ForwardPass acquires swapchain, handles depth resize
- [ ] RenderGraph executes CullPass → ForwardPass in order
- [ ] All 68 Rust tests pass
- [ ] All TypeScript tests pass (90+ including new ones)
- [ ] Type-check clean (`tsc --noEmit`)
- [ ] Visual rendering unchanged in browser (50 visible quads)
