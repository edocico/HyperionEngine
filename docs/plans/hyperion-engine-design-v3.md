# Hyperion Engine v3.0 â€” Architectural Design Document

**Status:** Approved
**Date:** 2026-02-18
**Supersedes:** v2.1 (2026-02-17)
**Origin:** Integration of Architectural Design v2.1 + Roadmap Operativa Unificata v3.0 (informed by *Rendering Algorithms for the Hyperion Engine: WebGPU Graphics Pipeline and Roadmap Analysis*). Plugin extensibility informed by *Plugin System Design — Hyperion Engine*.
**Stack:** Rust (WebAssembly + SIMD + Atomics), WebGPU (WGSL Compute Shaders), TypeScript (OffscreenCanvas, AudioWorklet, FinalizationRegistry)

---

## 1. Executive Summary

Hyperion is a **universal graphics engine for web technologies** delivering native-class performance inside the browser. It delegates simulation logic to a Rust WebAssembly module and leverages WebGPU to offload scene organization onto the GPU's compute units via GPU-Driven Rendering.

### Vision: Three Markets

Hyperion is not "yet another web game engine." It serves three distinct markets:

1. **Game engine**: 2D/2.5D game development targeting 100k+ entities at 60fps
2. **Application rendering**: Rendering engine for professional applications (Figma, Miro, Excalidraw) â€” canvas with thousands of interactive elements, fluid zoom/pan
3. **Desktop embedding**: Rendering engine integrated into Electron/Tauri applications for advanced 2D/3D rendering beyond Canvas 2D and SVG limits

### Primary Objectives

- **Zero-Blocking Architecture:** Physical separation between UI, Engine Logic, and Rendering via SharedArrayBuffer and OffscreenCanvas, with graceful degradation to single-thread.
- **GPU-Driven Scale:** 100,000+ volumetric entities via WGSL Frustum Culling and Indirect Drawing, eliminating CPU-side draw call orchestration.
- **Memory Safety Synchronized:** High-level TypeScript API protected from memory leaks via explicit disposal, entity pooling, and FinalizationRegistry backstop.
- **Adaptive Execution:** Three runtime modes (Full Isolation, Partial Isolation, Single Thread) selected via feature detection at startup, with dynamic degradation on failure.
- **Multi-Primitive Rendering:** Not limited to textured quads â€” supports text (MSDF), lines, gradients, box shadows, and selection outlines via extensible RenderPrimitive system.
- **Long-Running Session Support:** Memory compaction, tier shrinking, and dirty tracking designed for professional applications running 8+ hours.
- **Plugin Extensibility:** Third-party plugins can add custom render passes, system hooks, input handlers, and GPU resources without recompiling the WASM binary, via a structured `HyperionPlugin` interface.

### Architectural Constraints

| Constraint | Motivation | Impact on Decisions |
|-----------|-----------|-------------------|
| **Zero TS runtime dependencies** | The engine is a primitive â€” integrators don't want transitive deps | No additional TS libraries, everything internal |
| **WASM binary < 200KB gzipped** | Download time on 3G: 200KB â‰ˆ 65ms. Every KB matters for first paint | hecs over bevy_ecs, no compiled wgpu |
| **No GC pressure in game loop** | Professional applications run for hours â€” GC pauses cause visible micro-jank | Object pooling, pre-allocated buffers, zero allocations in hot path |
| **Mandatory graceful degradation** | A Figma-like app cannot crash if a Worker dies | Supervisor, heartbeat, degradation Aâ†’Bâ†’C |
| **Ergonomic type-safe API** | Consumer developers don't want to manipulate ring buffers | Facade API hiding the binary protocol |
| **Embeddable** | The engine must work in any `<div>`, not own the entire page | No global state, canvas injection, explicit lifecycle |
| **Plugin-extensible** | Third-party code must extend rendering, logic, and input without recompiling WASM | Two-level model: Rust closed (core), TS open (plugins). Zero-cost predispositions in Phase 4.5/5 |

---

## 2. Adaptive Multi-Thread Architecture

The engine operates in one of three execution modes, selected at startup via feature detection.

### Mode A â€” Full Isolation (Optimal)

- **Requires:** `SharedArrayBuffer` available, `OffscreenCanvas.transferControlToOffscreen()` supported, WebGPU in Workers enabled
- **Layout:** Main Thread (UI/Input) â†’ Worker 1 (ECS + Physics via WASM) â†’ Worker 2 (Render via WASM + wgpu)
- **Communication:** Lock-free MPSC Ring Buffers on `SharedArrayBuffer`

### Mode B â€” Partial Isolation (Firefox fallback)

- **Requires:** `SharedArrayBuffer` available, WebGPU on Main Thread only
- **Layout:** Main Thread (UI/Input + Render via wgpu) â†’ Worker 1 (ECS + Physics via WASM)
- **Communication:** Ring Buffer for commands, `postMessage` with transferable `ArrayBuffer` for render state snapshot

### Mode C â€” Single Thread (Maximum compatibility)

- **Requires:** WebGPU on Main Thread
- **Layout:** Main Thread runs everything sequentially: Input â†’ ECS tick â†’ Render
- **Communication:** Direct function calls, no Ring Buffer needed
- **Note:** Viable for scenes under ~10k entities at 60fps

### Mode C without WebGPU â€” Simulation Only

When WebGPU is unavailable, Mode C still runs the full ECS/WASM simulation (commands, physics, transforms) but rendering is disabled. The engine currently displays a text overlay with FPS and entity count. A future phase should introduce a fallback renderer:

- **WebGL 2 fallback (preferred):** Near-universal browser support. Requires GLSL shaders instead of WGSL and CPU-side frustum culling (no compute shaders in WebGL 2). The `Renderer` interface in `renderer.ts` is already decoupled from the bridge, so a `WebGLRenderer` implementing the same interface would slot in transparently.
- **Canvas 2D fallback (minimal):** Trivial to implement, useful only for debug/wireframe visualization. Not suitable for production rendering.

The Rust WASM module is agnostic to which thread it runs on. It consumes a command buffer and produces a render state buffer, regardless of transport.

### Worker Supervisor and Dynamic Degradation

In Modes A and B, Workers can terminate from uncaught exceptions, OOM conditions, or GPU device loss. The engine implements a **Worker Supervisor** with two complementary mechanisms:

**Heartbeat Atomic (primary):** Each Worker increments an atomic counter on the SharedArrayBuffer at every completed tick. The Main Thread reads the counter every ~60 frames (~1 second) and verifies it has advanced. Three consecutive missed heartbeats (3 seconds) trigger recovery.

```
SharedArrayBuffer Layout (extended header â€” 32 bytes):
Offset 0-15:   Ring Buffer header (existing: write_head, read_head, capacity, padding)
Offset 16-19:  heartbeat_counter (u32, atomic) â€” Worker 1 writes, Main reads
Offset 20-23:  heartbeat_counter_w2 (u32, atomic) â€” Worker 2 writes, Main reads
Offset 24-27:  supervisor_flags (u32, atomic) â€” Main writes commands to supervisor
Offset 28-31:  reserved (padding for future extensions)
Offset 32+:    Ring Buffer data region
```

**`Worker.onerror` + `Worker.onmessageerror` (complementary):** Catches explicit crashes with diagnostic information. Zero overhead but cannot detect freezes or deadlocks.

**Degradation Protocol:**

```
1. worker.terminate()                        // Force termination
2. Flush ring buffer (set read_head = write_head)  // Prevent stale commands
3. Attempt restart:
   a. Create new Worker
   b. Re-send init message with SAB
   c. Await "ready" with 5s timeout
4. If restart OK:
   a. Re-synchronize state (re-spawn active entities)
   b. Log warning for developer
5. If restart FAILS:
   a. Degrade mode: Aâ†’B (merge render to main), Bâ†’C (everything on main)
   b. Notify developer via callback onModeChange(oldMode, newMode, reason)
   c. Log error with diagnostics
```

Dynamic degradation is fundamental for professional applications. A Figma-like tool cannot afford to crash â€” it must keep running even at reduced performance.

**Note on `transferControlToOffscreen()`:** This call is irrevocable â€” once a canvas is transferred, the Main Thread cannot reclaim it. Therefore, degradation from Mode A after canvas transfer requires full engine restart via `destroy()` + re-initialization. The Supervisor handles this transparently.

### Deployment Requirement

Modes A and B require cross-origin isolation (COOP/COEP HTTP headers). The engine detects `crossOriginIsolated` at startup and falls back gracefully, logging a clear warning with the exact headers needed to the developer console.

---

## 3. Memory Bridge â€” Ring Buffer on SharedArrayBuffer

### Problem: FFI Overhead and Memory Detachment

Synchronous FFI calls between JS and WASM have measurable per-call cost. At 10,000+ calls per frame, these negate Rust's speed gains. Additionally, `memory.grow` in WASM invalidates all existing JS `Float32Array` views, causing silent runtime crashes.

### Solution: Command Buffer Architecture

TypeScript serializes mutation commands into a lock-free MPSC Ring Buffer allocated on a statically-sized `SharedArrayBuffer`. Rust consumes the entire buffer in batch at the start of each simulation step.

| Characteristic | Synchronous FFI (rejected) | Ring Buffer (adopted) |
|---|---|---|
| Context Switching | One transition per property mutation | Single batch read per frame |
| Memory Detachment Risk | High (depends on `memory.grow`) | None (static SharedArrayBuffer) |
| Multi-Thread Scalability | Impossible | Lock-free MPSC native |
| Throughput | Degrades above 10k mutations/frame | Limited only by memory bandwidth |

### Backpressure â€” Prioritized Retry Queue

The Ring Buffer implements a **Prioritized Retry Queue** (default) with an optional **drop-with-counter** mode for high-frequency gaming.

When the buffer is full, dropped commands are enqueued in a TypeScript-side priority queue drained at the next frame. Critical commands (Spawn, Despawn) have high priority and are never lost; repeatable commands (SetPosition, SetVelocity) have low priority and are overwritten by the latest value per entity.

```typescript
const engine = Hyperion.create({
    backpressure: 'retry-queue'  // default for professional apps
    // or
    backpressure: 'drop'         // for high-frequency gaming
});
```

An atomic overflow counter on the SAB tracks how many commands were deferred, exposed via `engine.stats.overflowCount`.

### Buffer Sizing

```
Worst case gaming:     100k entities Ã— SetPosition (17 bytes) = 1.7 MB/frame
Typical gaming:        5k mutations/frame Ã— avg 15 bytes      = 75 KB/frame
Typical app:           500 mutations/frame Ã— avg 15 bytes     = 7.5 KB/frame
```

**Decision:** Default buffer size **2 MB** (configurable via `commandBufferSize`). This covers the typical case with 10Ã—+ headroom.

### Endianness Safety â€” TypedArray Fast Path

The Ring Buffer uses a **dual-path strategy** for cross-boundary reads/writes:

- **Header fields:** Always via `DataView` (safety-critical, few operations)
- **Payload data:** Via `TypedArray` on little-endian platforms (99.97% of modern devices), falling back to `DataView` on big-endian

```typescript
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
```

This yields a ~4Ã— speedup on payload-heavy operations (e.g., 3 floats for SetPosition = 12 bytes) with no correctness compromise.

### Command Types

```
SpawnEntity        = 1    // payload: 0 bytes
DespawnEntity      = 2    // payload: 0 bytes
SetPosition        = 3    // payload: 12 bytes (3 Ã— f32 LE)
SetVelocity        = 4    // payload: 12 bytes (3 Ã— f32 LE)
SetRotation        = 5    // payload: 4 bytes (f32 LE â€” Z rotation)
SetScale           = 6    // payload: 12 bytes (3 Ã— f32 LE)
SetTexture         = 7    // payload: 4 bytes (u32 LE â€” packed tier|layer)
SetMeshHandle      = 8    // payload: 4 bytes (u32 LE)
SetRenderPrimitive = 9    // payload: 4 bytes (u8, padded to 4 for alignment)
SetParent          = 10   // payload: 4 bytes (parent entity ID; 0xFFFFFFFF = unparent)
// Reserved 11-15 for future ECS commands
InputKeyDown       = 16   // payload: 4 bytes (key code)
InputKeyUp         = 17   // payload: 4 bytes (key code)
InputPointerMove   = 18   // payload: 8 bytes (2 Ã— f32 â€” x, y)
InputPointerDown   = 19   // payload: 12 bytes (2 Ã— f32 + u32 â€” x, y, button)
InputPointerUp     = 20   // payload: 12 bytes (2 Ã— f32 + u32 â€” x, y, button)
InputScroll        = 21   // payload: 8 bytes (2 Ã— f32 â€” deltaX, deltaY)
```

---

## 4. ECS Core â€” `hecs` with Migration Path

### Selection Rationale

`bevy_ecs` loses its parallelism advantage on `wasm32-unknown-unknown` (falls back to single-thread execution) while introducing transitive dependency issues and larger binary size. `hecs` provides:

- Minimal binary footprint (critical for WASM download size)
- No transitive dependency conflicts on WASM targets
- Equivalent single-thread iteration speed
- Simpler integration model

### Migration Path

The current implementation uses `hecs::World` directly throughout the codebase. The ECS surface area is small (spawn, despawn, query by component type, add/remove component) and concentrated in `engine.rs`, `command_processor.rs`, `render_state.rs`, and `systems.rs`. Future migration to `bevy_ecs` or `flecs-rs` would require updating these four files. A `trait World` abstraction is intentionally deferred â€” introducing it before a concrete migration need would create a leaky abstraction across fundamentally different storage models (archetype vs sparse set).

### Data-Oriented Enforcement

- No `dyn Trait` in components (destroys cache contiguity)
- Pure Struct of Arrays layout with `glam` SIMD types
- All spatial abstractions use 3D coordinates with quaternions
- 2D projection via orthographic cameras manipulating Z for hardware depth testing
- Behavior modeled through component presence/absence, processed by dedicated Systems

### Component Registry

```rust
// Core spatial components (existing)
pub struct Position(pub Vec3);
pub struct Velocity(pub Vec3);
pub struct Rotation(pub Quat);
pub struct Scale(pub Vec3);
pub struct ModelMatrix(pub Mat4);
pub struct BoundingSphere(pub Vec4);    // xyz = center, w = radius
pub struct TextureLayerIndex(pub u32);  // packed: tier << 16 | layer

// Rendering extensibility components (Phase 4.5)
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct MeshHandle(pub u32);         // 0 = unit quad (default)

#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct RenderPrimitive(pub u8);     // See RenderPrimitiveType enum

#[repr(u8)]
pub enum RenderPrimitiveType {
    Quad = 0,           // Phase 4 (current)
    Line = 1,           // Phase 5.5: lines with thickness
    SDFGlyph = 2,       // Phase 5.5: MSDF text
    BezierPath = 3,     // Future: vector curves (Loop-Blinn)
    Gradient = 4,       // Phase 5.5: gradient fill
    BoxShadow = 5,      // Phase 5.5: SDF shadows
    // Future:
    // Mesh3D = 6,       // Phase 7+ â€” arbitrary 3D meshes
    // Particle = 7,     // Phase 7+ â€” GPU particles
}

// Scene graph components (Phase 5 â€” opt-in)
pub struct Parent(pub u32);                   // External entity ID
pub struct Children(pub SmallVec<[u32; 4]>);  // Inline for â‰¤4 children
pub struct LocalMatrix(pub [f32; 16]);
```

---

## 5. Object Lifecycle â€” Dual-Strategy Resource Management

### Problem: GC-Rust Asymmetry

Rust has no awareness of JavaScript's Garbage Collector. When a JS wrapper object is collected, the corresponding Rust entity persists indefinitely, creating memory leaks.

### Solution: Three-Tier Cleanup

```
Primary:   sprite.dispose()  ->  Ring Buffer DROP_ENTITY  ->  Rust frees entity
Backstop:  GC collects sprite ->  FinalizationRegistry     ->  Ring Buffer DROP_ENTITY
Pooling:   sprite.dispose()  ->  Rust marks recyclable     ->  Reused on next spawn
```

**Entity Pooling:** Rust maintains a free-list of recycled entity IDs. `spawn()` checks the free-list before allocating new slots. This reduces allocation pressure and GC churn.

**TypeScript API surfaces disposal via:**
- `using` keyword (TC39 Explicit Resource Management, Stage 4): `using sprite = engine.spawn(...)`
- Explicit `.dispose()` method on all engine objects
- `FinalizationRegistry` silently catches anything that falls through

### Why Not FinalizationRegistry Alone?

The TC39 specification warns: finalizer callbacks might not happen immediately, might not happen in order, and might not happen at all. Cloudflare engineering recommends against using it for critical resource cleanup. It serves as a safety net, not a primary mechanism.

### Memory Compaction for Long-Running Sessions

Professional applications (Figma-like) run for 8+ hours. The memory profile differs fundamentally from games:

```
Game (2 hours):
  Entities: peak 100k, stable after loading
  Textures: loaded at init, never released
  WASM memory: grows during loading, then stable

Professional app (8+ hours):
  Entities: fluctuates between 100 and 50k (opening/closing documents)
  Textures: loaded and released continuously (file change, undo/redo)
  WASM memory: grows and never returns (memory.grow is unidirectional)
  Spawn/despawn: millions cumulative (each user operation)
```

**Solution â€” Explicit Compaction API:**

```typescript
engine.compact({
    entityMap: true,      // Rebuild EntityMap, eliminate holes
    textures: true,       // Shrink tiers with <50% utilization
    renderState: true,    // Release excess capacity on SoA buffers
    aggressive: false,    // If true, full rebuild (more expensive)
});

engine.stats.memory;      // { wasmHeap, gpuEstimate, entityMapUtil, tierUtil[] }
```

In Rust:
- `EntityMap::shrink_to_fit()`: Truncates trailing None, releases excess capacity (safe, no remapping)
- `EntityMap::compact()`: Rebuilds eliminating holes (aggressive, requires ID remapping)
- `RenderState::shrink_to_fit()`: Releases excess capacity on all SoA buffers

---

## 6. Rendering Pipeline â€” GPU-Driven Model

### Architecture: Modular RenderGraph DAG

The rendering pipeline is organized as a **Directed Acyclic Graph** with resource lifetime management and dead-pass culling, rather than a monolithic renderer. This architecture supports the diverse pipeline configurations required by the three target markets:

```
Today:       [CullPass] â†’ [ForwardPass]
Figma app:   [CullPass] â†’ [ForwardPass] â†’ [SelectionSeed] â†’ [JFA Ã—10] â†’ [OutlineComposite] â†’ [FXAA] â†’ [UI]
Game:        [CullPass] â†’ [ShadowMap] â†’ [ForwardPass] â†’ [Bloom Extract â†’ Blur] â†’ [Tonemap + FXAA] â†’ [UI]
```

```
ts/src/
  render/
    render-graph.ts        â†’ DAG with resource lifetime + dead-pass culling
    render-pass.ts         â†’ RenderPass interface + FrameState
    resource-pool.ts       â†’ Pool of reusable GPU buffers + transient textures
    passes/
      cull-pass.ts         â†’ Compute culling + prefix sum + stream compaction
      forward-pass.ts      â†’ Main render pass with per-primitive-type pipelines
```

**RenderPass Interface:**

```typescript
interface RenderPass {
    readonly name: string;
    readonly reads: string[];       // Logical resource names read
    readonly writes: string[];      // Logical resource names written
    readonly optional: boolean;     // Disableable without invalidating graph
    setup(device: GPUDevice, resources: ResourcePool): void;
    prepare(device: GPUDevice, frame: FrameState): void;
    execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool): void;
    resize(width: number, height: number): void;
    destroy(): void;
}
```

**RenderGraph** compiles the execution order via topological sort (Kahn's algorithm) on read/write dependencies, computes transient resource lifetimes, plans allocations with aliasing, and culls dead passes (optional passes whose outputs are unread). With 2 passes (current Phase 4.5), the DAG degenerates to a sequence â€” zero runtime overhead. Complexity pays off when Phase 5.5 adds nodes.

### GPU Buffer Layout â€” Structure of Arrays (SoA)

Entity data on the GPU is organized as **four independent storage buffers** (SoA) rather than a single interleaved struct (AoS). This solves three problems: partial update efficiency, compute shader cache performance on mobile GPUs, and extensibility for new primitives.

```
Buffer A â€” Transform (16 f32/entity, 64 bytes):
  [mat4x4f] Ã— N

Buffer B â€” BoundingSphere (4 f32/entity, 16 bytes):
  [vec4f center_radius] Ã— N

Buffer C â€” RenderMeta (2 u32/entity, 8 bytes):
  [meshHandle, renderPrimitive] Ã— N

Buffer D â€” PrimitiveParams (8 f32/entity, 32 bytes) [Phase 5.5]:
  [param0..param7] Ã— N   // Interpretation depends on renderPrimitive
```

**Total: 88 bytes/entity** (equivalent to monolithic, but independently addressable).

**Bind Group Layout:**

```
Bind Group 0 â€” Frame-level (camera, time, frustum):
  @binding(0) camera: uniform
  @binding(1) frustumPlanes: uniform
  @binding(2) frameParams: uniform

Bind Group 1 â€” Entity data (SoA):
  @binding(0) transforms: storage<read>
  @binding(1) bounds: storage<read>
  @binding(2) renderMeta: storage<read>
  @binding(3) primParams: storage<read>

Bind Group 2 â€” Textures:
  @binding(0) textureArray: texture_2d_array
  @binding(1) sampler: sampler
  @binding(2) texIndices: storage<read>

Bind Group 3 â€” Pass-specific (varies per pass):
  // CullPass: indirect draw buffer, visibility buffer
  // PickingPass: picking output texture
  // OutlinePass: JFA textures
```

### FrameState

```typescript
interface FrameState {
    entityCount: number;
    transforms: Float32Array;      // 16 f32/entity
    bounds: Float32Array;          // 4 f32/entity
    renderMeta: Uint32Array;       // 2 u32/entity
    primParams: Float32Array;      // 8 f32/entity (zero-filled for quad)
    texIndices: Uint32Array;       // 1 u32/entity
    camera: Camera;
    canvasWidth: number;
    canvasHeight: number;
    deltaTime: number;
}
```

### Dirty Tracking per-Buffer

```rust
pub struct DirtyTracker {
    transform_dirty: BitSet,    // Position/rotation/scale changed
    bounds_dirty: BitSet,       // Bounding sphere changed (rare after init)
    meta_dirty: BitSet,         // MeshHandle/RenderPrimitive changed (very rare)
    params_dirty: BitSet,       // Primitive params changed
}
```

In practice, after initialization, `bounds_dirty` and `meta_dirty` are almost always empty â€” the engine uploads only transforms of moving entities. Threshold: if <30% of entities are dirty, upload partial per-buffer; otherwise full per-buffer upload. BitSet cost: 100k/8 = 12.5 KB per buffer â€” negligible.

### GPU Upload Strategy

**Decision:** `queue.writeBuffer()` is the **exclusive upload method**. The Chrome GPU team confirms this is the recommended path for WASM â€” the browser manages staging internally. `mapAsync` is removed from the roadmap to reduce decision surface area.

With SoA layout, worst case (all entities dirty) requires 4 `writeBuffer()` calls â€” ~20Î¼s total (~5Î¼s per call). The delta versus a single call on a monolithic buffer is negligible.

### Compute Culling Stage â€” Prefix Sum + Stream Compaction

Each frame, entity spatial data from the ECS populates the SoA storage buffers. A WGSL Compute Shader performs **Frustum Culling** reading only `transforms` and `bounds` buffers (no superfluous data in cache).

The culling pipeline uses **prefix sum (Blelloch algorithm)** and **stream compaction** to produce GPU-side compact draw lists:

```wgsl
// Step 1: Predicate (frustum test)
visibility[i] = frustumTest(bounds[i], frustumPlanes) ? 1u : 0u;

// Step 2: Prefix sum (Blelloch â€” O(n) work, O(2 log n) depth)
// Input:  [0, 1, 1, 0, 1, 0, 1, 1]
// Output: [0, 0, 1, 2, 2, 3, 3, 4]  (exclusive scan)

// Step 3: Scatter
if (visibility[i] == 1u) {
    compactedIndices[prefixSum[i]] = i;
}
// Output: [1, 2, 4, 6, 7]  (only visible indices, grouped by RenderPrimitive type)
```

**Subgroup optimization (optional):** Chrome 134+ supports `subgroupExclusiveAdd` for 2â€“3Ã— acceleration on compatible hardware. Implemented as feature-detected enhancement:

```typescript
const hasSubgroups = device.features.has('subgroups');
const prefixSumShader = hasSubgroups ? prefixSumSubgroups : prefixSumBlelloch;
```

### Indirect Drawing â€” Single Buffer

The rendering pass uses `draw_indexed_indirect`, reading vertex/instance counts directly from GPU buffers populated by the Compute Shader. The CPU never touches draw call parameters.

**Critical:** All indirect draw arguments are packed into a **single GPU buffer** with different offsets per draw call. The research documents a 300Ã— performance improvement on Chrome/Dawn versus separate buffers (~3ms â†’ ~10Î¼s for validation).

```typescript
const indirectBuffer = device.createBuffer({
    size: MAX_DRAW_CALLS * 20,  // 5 u32 per drawIndexedIndirect call
    usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE,
});
```

The compute shader populates the buffer with arguments for each draw call grouped by `RenderPrimitive` type. The ForwardPass executes N `drawIndexedIndirect` calls from the same buffer with different offsets.

### Forward Pass â€” Per-Primitive-Type Pipelines

The ForwardPass maintains a separate `GPURenderPipeline` for each `RenderPrimitiveType`. Entities are grouped by type and dispatched as one draw call per group. **Zero shader branching** â€” each pipeline has its own specialized vertex/fragment shader. The CullPass (stream compaction) produces indices already grouped by type as a natural byproduct.

### Texture Management â€” Texture2DArray

Sprite textures are packed into `Texture2DArray` resources (single GPU descriptor, multiple independent layers). Each entity's fragment shader samples the correct layer via a component-driven Z-index. This eliminates:

- Mipmap bleeding (inherent to texture atlases)
- Texture bind state changes
- Complex atlas packing algorithms

Bindless textures are deferred until WebGPU standardization matures.

### Texture2DArray Size-Tiering

All layers in a `Texture2DArray` must share identical dimensions (GPU hardware constraint). To support sprites of varying resolutions, textures are grouped into size tiers:

| Tier | Dimensions | Typical use                         |
|------|------------|-------------------------------------|
| 0    | 64x64      | Icons, particles, small UI elements |
| 1    | 128x128    | Standard sprites, tiles             |
| 2    | 256x256    | Large sprites, detailed characters  |
| 3    | 512x512    | Backgrounds, large assets           |

Each tier is a separate `Texture2DArray` with up to `maxTextureArrayLayers` layers (at least 256 per WebGPU spec). Sprites that don't match a tier exactly are resized to the nearest tier at load time. The entity's `textureLayerIndex` component encodes both tier and layer as a packed u32 (`tier << 16 | layer`).

### TextureManager: Lazy Allocation with Chunk Growth

Upfront allocation of 256 layers for all 4 tiers would consume **356 MB** â€” dealbreaker on mobile. The TextureManager uses **lazy allocation per tier with exponential chunk growth**:

```
Growth: 0 â†’ 16 â†’ 32 â†’ 64 â†’ 128 â†’ 256 layers per tier

Initial allocation (lazy, 16 layers per used tier):
Tier 0: 64Ã—64Ã—4 Ã— 16   =  0.26 MB   (vs 4.19 MB)
Tier 1: 128Ã—128Ã—4 Ã— 16  =  1.05 MB   (vs 16.78 MB)
Tier 2: not allocated    =  0 MB      (vs 67.11 MB)
Tier 3: not allocated    =  0 MB      (vs 268.44 MB)
                  TOTAL:   1.31 MB   (vs 356.52 MB)
                  REDUCTION: 99.6%
```

When a tier is reallocated, the bind group becomes invalid. A lazy rebuild mechanism with a `texBindGroupDirty` flag handles this at negligible cost (~microsecond, only on tier resize).

For long-running sessions, `TextureManager::shrinkTier()` reallocates with copy if <50% of layers are in use.

### Storage Buffer Budget

At 88 bytes per entity (SoA total), 100k entities = 8.4 MB (well within WebGPU's guaranteed 128MB `maxStorageBufferBindingSize`). For scenes exceeding ~500k entities, a spatial streaming system uploads only entities within the camera's extended frustum.

### Mode B/C Compatibility

Compute culling executes on GPU regardless of execution mode. The only difference is whether `device.queue.submit()` is called from a Worker or the Main Thread.

---

## 7. Scene Graph â€” Opt-in Hierarchical Transforms

### Problem

In a Figma-like application, entities have **hierarchical relationships**: a frame contains groups that contain shapes. Moving the frame moves all content. In the flat ECS, every entity has an independent model matrix â€” there is no parent-child concept.

### Solution: Flat-by-Default, Hierarchy-on-Demand

```
Flat entity (default):        Entity â†’ ModelMatrix (computed from Position/Rotation/Scale)
                              Zero overhead, cache-friendly, perfect for games

Hierarchical entity (opt-in): Entity â†’ Parent(EntityId) + LocalTransform
                              â†’ propagate_transforms() computes world ModelMatrix
                              Cost: proportional to tree depth, not to total entities
```

Those who don't use hierarchy pay nothing. Those who use it activate a `TransformHierarchy` that adds `Parent`, `Children`, and `LocalTransform` components and a propagation system.

**API Design:**

```typescript
const frame = engine.spawn().position(0, 0, 0);
const child = engine.spawn()
    .parent(frame)              // Makes it a child of frame
    .localPosition(10, 20, 0);  // Position relative to parent

child.parent(otherFrame);       // Reparenting
child.unparent();               // Back to flat
frame.children;                 // EntityHandle[]
child.worldPosition;            // Computed world-space position (read-only)
```

**Decision:** `position()` is world space for flat entities, local space for entities with a parent. `worldPosition` (read-only) is available for hierarchical entities.

**Performance mitigations:** Propagation only if dirty, sorted array for depth-first traversal, maximum depth limit of 32 levels.

---

## 8. Asset Pipeline â€” Native Browser Decoding

### Rejected Approach

Decoding compressed images (PNG, JPEG, WebP) inside WASM via the `image` crate wastes CPU cycles, blocks the simulation thread, and inflates the WASM binary.

### Adopted Approach

```
fetch() -> Blob -> createImageBitmap() -> device.queue.copyExternalImageToTexture()
```

- `createImageBitmap()` decodes asynchronously on the browser's internal thread pool with hardware acceleration
- Decoded bitmap transfers directly from browser memory to VRAM
- Pixels never traverse WASM linear memory

### Asset Loading Manager

Loading at scale requires concurrency control and prioritization:

- **Concurrency limiter:** Maximum 6â€“8 parallel `fetch()` calls to avoid saturating the network and causing jank
- **Priority queue:** Visible assets (inside current frustum) load first, off-screen assets load at idle, prefetch uses `requestIdleCallback`
- **Progress tracking:** `onProgress(loaded, total)` callback for loading screens
- **Browser caching:** Assets are fetched with standard HTTP caching headers; the browser's disk cache handles persistence transparently

### KTX2/Basis Universal (GPU-Compressed Textures)

GPU-compressed textures (BC7 on desktop, ASTC on mobile, ETC2 as fallback) remain compressed in VRAM, reducing memory usage 4â€“8Ã—.

| GPU | Format | Compression | Quality |
|-----|---------|------------|---------|
| Desktop (BC7) | `bc7-rgba-unorm` | 4:1 | Excellent |
| Mobile (ASTC 4Ã—4) | `astc-4x4-unorm` | 5.33:1 | Very good |
| Fallback | `rgba8unorm` | 1:1 | Perfect |

KTX2 container + Basis Universal codec. Transcoder WASM (~200KB) loaded **lazily** only when KTX2 is requested. Feature detection: `device.features.has('texture-compression-bc')` / `'texture-compression-astc'`.

---

## 9. Rendering Primitives (Phase 5.5)

The engine supports multiple rendering primitives beyond textured quads. Each primitive type has its own GPU pipeline (zero shader branching) and uses the `PrimitiveParams` SoA buffer for per-entity parameters.

### MSDF Text Rendering

MSDF (Multi-channel Signed Distance Field) encodes distance information on three RGB channels with edge coloring, preserving sharp corners. The fragment shader reconstructs distance with `median(r, g, b)` and applies anti-aliasing via screen-pixel-range scaling. Each glyph is an instanced quad â€” natively supported by Hyperion. A text block becomes a single draw call per atlas page.

**Atlas management:** `msdf-atlas-gen` offline â†’ atlas PNG + JSON metadata. Runtime: shelf packing via `etagere` crate (from Mozilla WebRender).

**Text layout engine:** Minimal custom layout (kerning table, greedy line breaking) with hook for external engines: `engine.text.setLayoutEngine(customLayoutFn)`.

### JFA Selection Outlines

Jump Flood Algorithm: iteratively propagates the nearest seed position with halving steps. After logâ‚‚(maxDim) passes, every pixel knows the nearest seed. Performance: ~530Î¼s at 1080p for 100px outline, constant time with respect to width.

Pipeline in RenderGraph: `[SelectionSeedPass] â†’ [JFA Pass Ã—10] â†’ [OutlineCompositePass]`

All three passes are `optional: true` â€” disabled when no selection is active (dead-pass culling removes them automatically).

### Instanced Line Rendering

Instanced screen-space expansion: each segment becomes a quad expanded perpendicularly in the vertex shader. Dash pattern via SDF in the fragment shader. Phase 5.5: butt caps only, no joins. Round caps and joins are future optimizations.

### Gradients and SDF Box Shadows

**Gradients:** 1D LUT texture (or 2D texture as array of rows, 256Ã—256) with hardware linear interpolation. Supports linear, radial, and conic gradients.

**SDF Box Shadows:** Evan Wallace technique â€” closed-form convolution of Gaussian 1D with box function using the error function (erf). Blur radius 2 or 200 â€” same cost. `erf()` approximated via Abramowitz-Stegun polynomial (6 terms, max error ~1.5Ã—10â»â·).

### FXAA + Tonemapping Post-Processing

FXAA (Lottes, NVIDIA): single full-screen pass, compute luma + edge detection + blend. Combined with tonemapping in the same pass to avoid additional texture reads.

- **Khronos PBR Neutral**: 1:1 color reproduction, 13 lines shader. For canvas/design.
- **ACES**: filmic look with highlight desaturation. For games.

---

## 10. Audio Subsystem â€” AudioWorklet Isolation

### Problem

Audio requires buffer fills with <3ms latency tolerance. Running DSP in the same cycle as physics/rendering causes buffer underruns (audible artifacts) during compute spikes.

### Solution

- Dedicated `AudioWorkletProcessor` running a specialized, minimal Rust/WASM binary for synthesis and mixing
- Communication via lock-free Ring Buffer on `SharedArrayBuffer`
- Game events (spatial audio triggers, pitch changes) are written as non-blocking commands by the ECS
- AudioWorklet reads commands independently at sample rate (44.1kHz), immune to graphics framerate variance

### Build System â€” Dual WASM Binary

```
HyperionEngine/
â”œâ”€â”€ Cargo.toml                    # [workspace]
â”œâ”€â”€ crates/
â”‚   â”œâ”€â”€ hyperion-core/            # Engine WASM (~150KB gzipped)
â”‚   â””â”€â”€ hyperion-audio/           # Audio DSP WASM (~30-50KB gzipped)
```

Audio binary loaded lazily only when audio features are requested.

---

## 11. Input System

### Three Paradigms

1. **Game input (polling):** Input events buffered via Ring Buffer, consumed by ECS at fixed timestep
2. **Application input (hit testing):** GPU-based picking via Color ID render pass (off-screen, entityID encoded as RGB)
3. **Hybrid:** Both polling and hit testing active simultaneously

### Input Latency Mitigation â€” Predictive Input Layer

In Modes A and B, user input traverses: Main Thread â†’ Ring Buffer â†’ Worker 1 (ECS) â†’ Shared Buffer â†’ Worker 2 (Renderer). This introduces 2-3 frames of latency.

**Solution â€” Dual strategy:**

- **Immediate mode (default for UI):** `setPositionImmediate()` applies shadow state on Main Thread + sends via ring buffer. Zero visual latency for drag/resize/pan/zoom.
- **Dead reckoning (for gameplay):** Main Thread applies simplified movement model, exponential smoothing when authoritative ECS state arrives 1-2 frames later.

```typescript
entity.setPositionImmediate(x, y, z);  // Shadow state + ring buffer (zero latency)
entity.setPosition(x, y, z);           // Ring buffer only (1-2 frame latency)
```

In Mode C, the predictive layer is bypassed (input flows directly into the ECS tick).

### GPU-Based Picking

Secondary off-screen render pass with entityID encoded as color RGB. `readPixel` on click returns the entity ID. Opt-in â€” not all applications need it.

Interaction with JFA Outlines: picking selects, outline highlights. Shared set:

```typescript
engine.input.onClick((e) => {
    const entityId = engine.picking.hitTest(e.x, e.y);
    if (entityId) engine.selection.select(entityId);
});
```

---

## 12. Compilation Strategy

### Release Build

```toml
[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
```

**Target features:** `+atomics,+bulk-memory,+simd128`

**Post-compilation:** `wasm-opt -O3` for bytecode pruning. Network compression (Brotli) handled by CDN infrastructure.

### Development Build

```toml
[profile.dev]
opt-level = 1
debug = true
```

- Watch mode via `cargo-watch` + `wasm-pack` with automatic browser reload
- WGSL shaders loaded as text resources at runtime (embedded at compile time in release)
- Debug overlay (`#[cfg(debug_assertions)]`): entity count, FPS, draw calls, buffer utilization
- Shader hot-reload via Vite HMR with `?raw` imports for `.wgsl` files

---

## 13. Error Recovery

### GPU Device Loss

WebGPU devices can be lost due to driver crashes, GPU hang recovery, or resource exhaustion. The `GPUDevice.lost` promise resolves with a `GPUDeviceLostInfo` indicating the reason. The engine must:

1. Listen to `device.lost` on initialization
2. Stop submitting command buffers immediately
3. Attempt re-initialization: `requestAdapter()` â†’ `requestDevice()` â†’ recreate all pipelines, buffers, and textures
4. TextureManager maintains CPU-side cache of `ImageBitmap` for re-uploading after device.lost (cost: ~2Ã— texture memory, but mandatory for the "universal engine" vision)
5. If re-initialization fails, disable rendering and continue running ECS-only (same behavior as Mode C without WebGPU)
6. Notify the consuming application via an `onDeviceLost` callback

### Shader Compilation Errors

WGSL shader compilation is validated at `createShaderModule()` time. Errors are surfaced via `GPUCompilationInfo` using `shaderModule.getCompilationInfo()` with detailed errors (line, column, source). Since shaders are bundled (not user-authored), compilation failures indicate a browser/driver incompatibility. The engine should log the full `GPUCompilationMessage` array and fall back to rendering disabled.

### Ring Buffer Corruption

If the consumer encounters an unknown command type byte, `drain()` stops processing and returns all commands decoded so far. This prevents a single corrupted byte from cascading into subsequent frames. The producer's `writeCommand()` validates `CommandType` at compile time (TypeScript `const enum`), making corruption a symptom of a deeper memory safety issue rather than a normal error path.

---

## 14. TypeScript Public API

### Design Principles

1. **Zero-knowledge of ring buffer:** The user doesn't know `entity.setPosition(x, y, z)` serializes 17 bytes
2. **Fluent chaining:** `world.spawn().position(x, y, z).velocity(vx, vy, vz)`
3. **Type-safe with inference:** TypeScript infers types without manual annotations
4. **Embeddable:** The engine attaches to an existing canvas
5. **Disposable:** `using` (TC39 Explicit Resource Management) for automatic lifecycle
6. **Dual-level:** Opaque EntityHandle (ergonomic default) + numeric ID (raw, performance-critical)

### API Surface

```typescript
// â”€â”€ Entry Point â”€â”€
import { Hyperion, type HyperionConfig } from 'hyperion-engine';

const engine = await Hyperion.create({
    canvas: document.getElementById('game-canvas') as HTMLCanvasElement,
    maxEntities: 100_000,
    commandBufferSize: 2 * 1024 * 1024,
    backpressure: 'retry-queue',
    fixedTimestep: 1 / 60,
    preferredMode: 'auto',
    onModeChange: (from, to, reason) => {},
    onOverflow: (dropped) => {},
    plugins: [],                  // Phase 7: HyperionPlugin[] — installed at init
});

// â”€â”€ Entity Management â”€â”€
const entity = engine.spawn()
    .position(100, 200, 0)
    .scale(2, 2, 1)
    .velocity(50, 0, 0)
    .texture(myTextureHandle);

engine.batch(() => {
    for (let i = 0; i < 1000; i++) {
        engine.spawn().position(i * 10, 0, 0);
    }
});

entity.destroy();

// â”€â”€ Scene Graph (opt-in) â”€â”€
const frame = engine.spawn().position(0, 0, 0);
const child = engine.spawn().parent(frame).localPosition(10, 20, 0);

// â”€â”€ Rendering Primitives â”€â”€
engine.spawn().primitive('text').text('Hello', { font, size: 24, color: [1,1,1,1] });
engine.spawn().primitive('line').line({ start: [100,200], end: [300,400], width: 2 });
engine.spawn().primitive('gradient').gradient({ type: 'linear', stops: [...] });
engine.spawn().primitive('box-shadow').boxShadow({ blur: 20, cornerRadius: 8 });

// â”€â”€ Post-Processing â”€â”€
engine.postProcessing.enable({ fxaa: true, tonemapping: 'pbr-neutral' });

// â”€â”€ Selection & Outlines â”€â”€
engine.outlines.enable({ color: [0.2, 0.5, 1.0, 1.0], width: 3 });
engine.selection.select(entity);

// â”€â”€ Raw API (performance-critical) â”€â”€
const id = engine.raw.spawn();
engine.raw.setPosition(id, 100, 200, 0);

// â”€â”€ Camera â”€â”€
engine.camera.position(0, 0);
engine.camera.zoom(2.0);

// â”€â”€ Lifecycle â”€â”€
engine.start();
engine.pause();
engine.resume();
engine.destroy();
{ using engine = await Hyperion.create({ canvas }); }

// â”€â”€ Memory & Stats â”€â”€
engine.compact({ entityMap: true, textures: true, renderState: true });
engine.stats;           // { fps, entityCount, mode, tickCount, overflowCount }
engine.stats.memory;    // { wasmHeap, gpuEstimate, entityMapUtil, tierUtil[] }
```

---

## 15. Plugin System — Extensibility Architecture

### Design Philosophy

The plugin system is not scheduled for full implementation before Phase 7+. However, **the decisions that preclude it are made in Phase 4.5 and Phase 5**. The principle is: add zero-cost indirections today to avoid precluding high-value extensibility paths tomorrow.

Full design details are specified in the companion document *Plugin System Design — Hyperion Engine*. This section summarizes the architectural decisions that affect the core engine.

### The Fundamental Boundary: Rust is Closed, TypeScript is Open

The ECS (`hecs`) lives in Rust/WASM. Components are `#[repr(C)]` with `Pod + Zeroable`. A third-party plugin **cannot** add new Rust components at runtime — the WASM binary is immutable after compilation. This imposes a two-level model:

- **Level 1 — Core Primitives (Rust, compiled in WASM):** Position, Velocity, Rotation, Scale, MeshHandle, RenderPrimitive, etc. Extensible only by recompiling the WASM binary.
- **Level 2 — Plugin Layer (TypeScript + WGSL):** Custom RenderPass, custom shaders, custom data buffers, custom input handlers, lifecycle hooks. Extensible by anyone via `engine.use(plugin)`. Communicates with Level 1 via public API (not ring buffer directly).

### Plugin Interface

```typescript
interface HyperionPlugin {
    readonly name: string;
    readonly version: string;
    readonly dependencies?: string[];
    install(ctx: PluginContext): PluginCleanup | void;
}

interface PluginContext {
    readonly engine: HyperionEngine;
    readonly rendering: PluginRenderingAPI;   // addPass, removePass, createPipeline
    readonly systems: PluginSystemsAPI;       // addPreTick, addPostTick, addFrameEnd
    readonly input: PluginInputAPI;           // addHandler, removeHandler
    readonly storage: PluginStorageAPI;       // createMap, createGpuBuffer (entity side-tables)
    readonly gpu: PluginGpuAPI;              // device access for custom resources
    readonly events: PluginEventAPI;         // inter-plugin communication
}
```

### Game Loop with Plugin Hooks

```
Per frame:
  ├─ Input handlers (plugin + built-in)
  ├─ Pre-tick hooks (plugin systems, priority-ordered)
  ├─ ECS tick (Rust/WASM — NOT extensible by plugins)
  ├─ Post-tick hooks (plugin systems, priority-ordered)
  ├─ RenderGraph execute:
  │    ├─ CullPass (built-in)
  │    ├─ ForwardPass (built-in)
  │    ├─ [Plugin RenderPass A] ← inserted by plugin via addPass()
  │    ├─ [Plugin RenderPass B] ← inserted by plugin via addPass()
  │    ├─ FXAA (built-in, optional)
  │    └─ Present
  └─ Frame-end hooks (plugin systems)
```

### Predispositions by Phase

| Phase | Predisposition | Cost |
|-------|---------------|------|
| 4.5 | `RenderGraph.addPass()`/`removePass()` with lazy recompilation | Zero (natural RenderGraph API) |
| 4.5 | `RenderPrimitiveType` enum: range 0–31 core, 32–63 extended, 64–127 plugin | Zero (enum value allocation) |
| 4.5 | Bind Group 3 documented as available for plugin data in pass-specific contexts | Zero (documentation) |
| 4.5 | `RenderPass.optional` flag — dead-pass culling handles it | Zero (already planned) |
| 5 | `HyperionConfig.plugins` field (optional array) | Trivial (type addition) |
| 5 | `engine.use()`/`engine.unuse()` stubs calling install()/cleanup() | Low |
| 5 | `engine.plugins` namespace (has/get/list) | Low |
| 5 | `.data()` on entity builder delegating to plugin storage | Low |
| 5 | `CommandType` range 64–127 documented as reserved | Zero (documentation) |
| 5 | Pre-tick/post-tick hooks in game loop (array of callbacks, O(n) per frame) | Low |
| 5.5 | Built-in primitives (MSDF, JFA, Lines) implemented as `RenderPass` — dogfooding the plugin interface | Zero (validates the design) |
| 7 | Full `PluginContext` with all 5 APIs, dependency resolution, error boundaries, docs | Medium |

### Constraints on Plugins

Plugins **cannot**: modify core ECS components, access the ring buffer directly, replace non-optional built-in passes (CullPass, ForwardPass), create additional Workers, or register network endpoints. These constraints protect engine stability and the degradation model A→B→C.

### Anti-Patterns

- Plugin GPU resource leaks mitigated by tracked `PluginGpuAPI` with automatic cleanup on `destroy()`
- Plugin main-thread blocking mitigated by 2ms budget per system hook with warning + automatic downgrade
- Conflicting RenderGraph writes detected by DAG validation at compile-time

---

## 16. Performance Targets

### Benchmark Suite

| Benchmark | Measures | Target (desktop) | Target (mobile mid) |
|-----------|---------|-------------------|---------------------|
| `ring-buffer-throughput` | Commands/sec in ring buffer | > 5M cmds/sec | > 1M cmds/sec |
| `ecs-tick-10k` | `engine_update` time with 10k entities | < 2ms | < 5ms |
| `ecs-tick-100k` | `engine_update` time with 100k entities | < 16ms | < 40ms |
| `spawn-despawn-churn` | 1000 spawn + 1000 despawn per frame, 600 frames | No memory leak | No leak |
| `gpu-upload-100k` | `writeBuffer` time for 100kÃ—88 byte (SoA) | < 3ms | < 8ms |
| `compute-cull-100k` | Compute pass culling 100k entities | < 0.5ms | < 2ms |
| `prefix-sum-100k` | Blelloch scan on 100k entities | < 0.3ms | < 1ms |
| `full-frame-100k` | Total frame time 100k entities (tick+render) | < 16ms | N/A (30fps target) |
| `mode-c-10k` | Frame time Mode C with 10k entities | < 16ms | < 33ms |

### Hardware Targets

| Tier | Reference device | Frame budget | Entity target |
|------|-----------------|--------------|---------------|
| Desktop high | MacBook Pro M3, RTX 3060 | 16ms (60fps) | 100k |
| Desktop mid | Intel UHD 630, GTX 1050 | 16ms (60fps) | 50k |
| Mobile high | iPhone 15, Galaxy S24 | 16ms (60fps) | 20k |
| Mobile mid | iPhone 12, Galaxy A54 | 33ms (30fps) | 10k |
| Electron/Tauri | Varies (desktop GPU) | 16ms (60fps) | 100k |

---

## 17. Implementation Roadmap

| Phase | Name | Duration | Deliverables |
|-------|------|----------|-------------|
| 0-4 | âœ… Completed | â€” | Project structure, COOP/COEP dev server, capability detection, adaptive mode selection (A/B/C), SharedArrayBuffer Ring Buffer, Web Worker instantiation, `hecs` integration, SoA components, transform system, spatial hashing, deterministic tick loop, command buffer consumption, wgpu initialization, OffscreenCanvas transfer, basic draw pipeline, debug overlay, WGSL compute culling, Storage Buffer layout, indirect draw, Texture2DArray system, `createImageBitmap` flow, Texture Array packing |
| 4.5 | Stabilization & Arch Foundations | 4â€“5 weeks | Worker Supervisor + heartbeat, backpressure retry queue, TypedArray fast path, TextureManager lazy allocation, SoA buffer layout, MeshHandle + RenderPrimitive components, `writeBuffer` as exclusive upload, RenderGraph DAG, indirect draw single buffer (Dawn 300Ã— fix), prefix sum (Blelloch) + stream compaction, scene graph opt-in design, memory compaction design, benchmark suite + test matrix |
| 4b | KTX2/Basis Universal | 2â€“3 weeks (parallel) | KTX2 container, Basis Universal transcoder, lazy WASM loading, feature detection per format |
| 5 | TypeScript API & Lifecycle | 4â€“6 weeks | Public API facade, entity handle pooling, `dispose()` + `using`, scene graph opt-in implementation, dirty-flag partial upload, `compact()` API, `device.lost` recovery, error handling |
| 5.5 | Rendering Primitives | 5â€“6 weeks | MSDF text rendering, JFA selection outlines, instanced line rendering, gradients + SDF box shadows, FXAA + tonemapping |
| 6 | Input & Audio | 3â€“4 weeks | Input buffering + shared state, GPU-based picking (Color ID), immediate mode + dead reckoning, AudioWorklet isolation, dual WASM binary (Cargo workspace) |
| 7 | Polish & DX | 3â€“4 weeks | Shader hot-reload, dev watch mode, performance profiler, deployment guide (7 platforms), documentation |

**Total estimated: 19â€“25 weeks (5â€“6 months)**

### Phase Dependencies

```
Phase 4.5 â”€â”€> Phase 5       (API depends on backpressure + supervisor + SoA + RenderGraph)
Phase 4.5 â”€â”€> Phase 4b      (lazy allocation enables compression without OOM)
Phase 4.5 â”€â”€> Phase 5.5     (SoA buffer, RenderPrimitive, prefix sum, RenderGraph are prerequisites)
Phase 5   â”€â”€> Phase 5.5     (public API, scene graph, entity handles needed for rendering API)
Phase 5   â”€â”€> Phase 6       (input API depends on entity handle system + scene graph for hit testing)
Phase 5.5 â”€â”€> Phase 6       (JFA outlines + picking pass form coherent unit with input system)
Phase 5   â”€â”€> Phase 7       (profiler depends on metrics exposed by API)
Phase 4b  â”€â”€> Phase 6       (audio may require compressed assets)
Phase 5.5 â”€â”€> Phase 7       (FXAA/tonemapping are prerequisites for "production readiness")
```

---

## 18. Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| WebGPU unavailable on Safari mobile | Medium | High | WebGL 2 fallback renderer (Phase 7+) |
| `SharedArrayBuffer` deprecated or restricted | Low | Critical | Mode C must remain functional as complete fallback |
| Basis Universal transcoder WASM too large (>200KB) | Medium | Medium | Lazy loading of transcoder |
| Performance Mode C on mid mobile below target | High | High | Benchmark in Phase 4.5; if fails, document limits |
| `device.lost` recovery doesn't work on all browsers | Medium | High | Test on Chrome/Firefox/Safari; fallback to page reload |
| Ring buffer 2MB insufficient for extreme scenarios | Low | Medium | API for override + warning at >75% utilization |
| GPU buffer 88B/entity too large for mobile | Low | Medium | 88B Ã— 100k = 8.4MB â€” within budget. Monitor |
| Renderer refactor introduces visual regressions | Medium | Medium | Screenshot comparison tests before/after |
| Scene graph propagation degrades with deep trees | Low | Medium | Depth limit 32, sorted array, global dirty flag |
| WASM linear memory not releasable after peak | High | Medium | Internal memory pool, documented limits |
| MSDF atlas too large for mobile (2048Ã—2048) | Low | Medium | 1024Ã—1024 default, 2048 opt-in. LRU eviction |
| JFA performance insufficient on mobile GPU | Medium | Medium | Reduce JFA resolution to half (quarter-res, bilinear upsample) |
| WGSL branching divergence with primitive mix | Medium | Medium | Separate pipelines per type (zero branching) |
| Missing WGSL preprocessor makes shaders verbose | High | Medium | `naga_oil` (#import, #ifdef) or TS template strings |
| RenderGraph DAG overhead for only 2 passes | Low | Low | DAG with 2 nodes degenerates to sequence â€” zero overhead |
| `erf()` not built-in in WGSL | Medium | Low | Abramowitz-Stegun approximation (error ~1.5Ã—10â»â·) |

---

## References

- [Bevy WASM Platform Guide](https://bevy-cheatbook.github.io/platforms/wasm.html)
- [Firefox WebGPU in Workers (Bug 1818042)](https://bugzilla.mozilla.org/show_bug.cgi?id=1818042)
- [COOP/COEP Cross-Origin Isolation](https://web.dev/articles/coop-coep)
- [FinalizationRegistry MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry)
- [Cloudflare on FinalizationRegistry](https://blog.cloudflare.com/we-shipped-finalizationregistry-in-workers-why-you-should-never-use-it/)
- [WebGPU Limits (wgpu)](https://docs.rs/wgpu/latest/wgpu/struct.Limits.html)
- [WebGPU Indirect Draw Best Practices](https://toji.dev/webgpu-best-practices/indirect-draws.html)
- [WebGPU Browser Support](https://www.webgpu.com/news/webgpu-hits-critical-mass-all-major-browsers/)
- [TC39 WeakRefs Proposal](https://github.com/tc39/proposal-weakrefs)
- [TC39 Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management)
- [GPU-Driven Rendering (ImgTec)](https://docs.imgtec.com/sdk-documentation/html/whitepapers/GPUControlledRendering.html)
- [Texture Arrays Explained](https://medium.com/@yves.albuquerque/texture-arrays-the-gpus-favorite-stack-of-pancakes-62b0646a10f2)
- [Ring Buffers in Rust](https://ntietz.com/blog/whats-in-a-ring-buffer/)
- [Rust + WASM Multithreading](https://web.dev/articles/webassembly-threads)
- [WASM Memory Growth Issue](https://github.com/rustwasm/wasm-bindgen/issues/2222)
- [Evan Wallace SDF Box Shadows](https://madebyevan.com/shaders/fast-rounded-rectangle-shadows/)
- [MSDF Text Rendering](https://github.com/Chlumsky/msdfgen)
- [Jump Flood Algorithm](https://blog.demofox.org/2016/02/29/fast-voronoi-diagrams-and-distance-field-textures-on-the-gpu-with-the-jump-flooding-algorithm/)
- [Blelloch Prefix Sum](https://developer.nvidia.com/gpugems/gpugems3/part-vi-gpu-computing/chapter-39-parallel-prefix-sum-scan-cuda)
- [Chrome Dawn Indirect Draw Performance](https://bugs.chromium.org/p/dawn/issues)
- [Khronos PBR Neutral Tonemapping](https://modelviewer.dev/examples/tone-mapping)
- [FXAA (Lottes, NVIDIA)](https://developer.download.nvidia.com/assets/gamedev/files/sdk/11/FXAA_WhitePaper.pdf)
- [Bevy Plugin System](https://bevyengine.org/learn/book/getting-started/plugins/) — Inspiration for plugin lifecycle and dependency resolution
- Plugin System Design — Hyperion Engine (companion document)
