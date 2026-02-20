# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

### Quick Reference

```bash
# Full validation (run before committing)
cargo test -p hyperion-core && cargo clippy -p hyperion-core && cd ts && npm test && npx tsc --noEmit

# Full rebuild + visual test
cd ts && npm run build:wasm && npm run dev
```

### Rust

```bash
cargo test -p hyperion-core                  # All Rust unit tests (81 tests)
cargo clippy -p hyperion-core                # Lint check (treat warnings as errors)
cargo build -p hyperion-core                 # Build crate (native, not WASM)
cargo doc -p hyperion-core --open            # Generate and open API docs

# Run specific test groups
cargo test -p hyperion-core ring_buffer      # Ring buffer tests only (15 tests)
cargo test -p hyperion-core engine           # Engine tests only (6 tests)
cargo test -p hyperion-core render_state     # Render state tests only (25 tests)
cargo test -p hyperion-core command_proc     # Command processor tests only (11 tests)
cargo test -p hyperion-core systems          # Systems tests only (6 tests)
cargo test -p hyperion-core components       # Component tests only (19 tests)

# Run a single test by full path
cargo test -p hyperion-core engine::tests::spiral_of_death_capped
```

### WASM

```bash
# Compile Rust to WebAssembly (outputs to ts/wasm/)
cd ts && npm run build:wasm
# Equivalent to: wasm-pack build ../crates/hyperion-core --target web --out-dir ../../ts/wasm

# After building, check generated TypeScript types
cat ts/wasm/hyperion_core.d.ts
```

### TypeScript

```bash
cd ts && npm test                            # All vitest tests (175 tests)
cd ts && npm run test:watch                  # Watch mode (re-runs on file change)
cd ts && npx tsc --noEmit                    # Type-check only (no output files)
cd ts && npm run build                       # Production build (tsc + vite build)
cd ts && npm run dev                         # Vite dev server with COOP/COEP headers

# Run specific test files
cd ts && npx vitest run src/ring-buffer.test.ts               # Ring buffer producer (14 tests)
cd ts && npx vitest run src/ring-buffer-utils.test.ts         # extractUnread helper (4 tests)
cd ts && npx vitest run src/camera.test.ts                    # Camera math + frustum (10 tests)
cd ts && npx vitest run src/capabilities.test.ts              # Capability detection (4 tests)
cd ts && npx vitest run src/integration.test.ts               # E2E integration (5 tests)
cd ts && npx vitest run src/frustum.test.ts                   # Frustum culling accuracy (7 tests)
cd ts && npx vitest run src/texture-manager.test.ts           # Texture manager (16 tests)
cd ts && npx vitest run src/backpressure.test.ts              # Backpressure queue + producer (16 tests)
cd ts && npx vitest run src/supervisor.test.ts                # Worker supervisor (5 tests)
cd ts && npx vitest run src/render/render-pass.test.ts        # RenderPass + ResourcePool (6 tests)
cd ts && npx vitest run src/render/render-graph.test.ts       # RenderGraph DAG (8 tests)
cd ts && npx vitest run src/render/passes/cull-pass.test.ts   # CullPass extraction (1 test)
cd ts && npx vitest run src/render/passes/forward-pass.test.ts # ForwardPass skeleton (1 test)
cd ts && npx vitest run src/render/passes/prefix-sum.test.ts  # Blelloch prefix sum (6 tests)
cd ts && npx vitest run src/hyperion.test.ts                  # Hyperion facade (26 tests)
cd ts && npx vitest run src/entity-handle.test.ts             # EntityHandle fluent API (17 tests)
cd ts && npx vitest run src/entity-pool.test.ts               # EntityHandle pool recycling (5 tests)
cd ts && npx vitest run src/game-loop.test.ts                 # GameLoop RAF lifecycle (6 tests)
cd ts && npx vitest run src/raw-api.test.ts                   # RawAPI numeric interface (4 tests)
cd ts && npx vitest run src/camera-api.test.ts                # CameraAPI zoom (3 tests)
cd ts && npx vitest run src/plugin.test.ts                    # PluginRegistry (5 tests)
cd ts && npx vitest run src/leak-detector.test.ts             # LeakDetector backstop (2 tests)
cd ts && npx vitest run src/types.test.ts                     # Config types + defaults (4 tests)
```

### Development Workflow

```bash
# 1. Make Rust changes → test → rebuild WASM
cargo test -p hyperion-core && cd ts && npm run build:wasm

# 2. Make TypeScript changes → test → type-check
cd ts && npm test && npx tsc --noEmit

# 3. Visual testing in browser (http://localhost:5173)
cd ts && npm run dev

# 4. Full pipeline: Rust → WASM → dev server
cd ts && npm run build:wasm && npm run dev
```

### Dependencies

```bash
# Install TypeScript dependencies (run once after clone)
cd ts && npm install

# Required global tools
# - wasm-pack: cargo install wasm-pack
# - Rust with wasm32-unknown-unknown target: rustup target add wasm32-unknown-unknown
```

## Architecture

Hyperion is a web game engine: Rust/WASM handles simulation, TypeScript handles browser integration and WebGPU rendering.

### Execution Modes

The engine selects one of three modes at startup based on browser capabilities:

- **Mode A (Full Isolation):** Main Thread (UI) + Worker 1 (ECS/WASM) + Worker 2 (Render). Requires SharedArrayBuffer + OffscreenCanvas + WebGPU in Workers.
- **Mode B (Partial Isolation):** Main Thread (UI + Render) + Worker 1 (ECS/WASM). Requires SharedArrayBuffer.
- **Mode C (Single Thread):** Everything on Main Thread. Fallback.

### Data Flow

```
TS: RingBufferProducer.spawnEntity(id)  →  SharedArrayBuffer  →  Rust: RingBufferConsumer.drain()
                                                                       ↓
                                                                  process_commands()  →  hecs::World mutations
                                                                       ↓
                                                                  velocity_system(dt)  ×  N fixed ticks
                                                                       ↓
                                                                  transform_system()  →  ModelMatrix (GPU-ready)
                                                                       ↓
                                                                  RenderState.collect_gpu()  →  SoA buffers (transforms/bounds/meta/texIndices)
                                                                       ↓
                                                                  TS: GPU compute cull  →  visibleIndices  →  drawIndexedIndirect
```

Commands flow through a lock-free SPSC ring buffer on SharedArrayBuffer. The ring buffer binary protocol: `[cmd_type: u8][entity_id: u32 LE][payload: 0-16 bytes]`. Header is 32 bytes (write_head atomic, read_head atomic, capacity, version, flags, reserved × 3), data region follows.

### Key Design Decisions

- **hecs over bevy_ecs:** bevy_ecs loses parallelism on wasm32 (falls back to single-thread) while adding binary bloat.
- **Ring buffer over direct FFI:** Batches mutations per frame instead of per-call, avoiding wasm FFI overhead at scale. Static SharedArrayBuffer avoids `memory.grow` invalidating JS views.
- **Fixed timestep (1/60s) with accumulator:** Deterministic physics. Spiral-of-death capped at 10 ticks.
- **FinalizationRegistry as backstop only:** Primary cleanup is explicit `.dispose()`. GC-based cleanup is unreliable per spec.
- **`addr_of_mut!()` for static mut access:** Required by Rust 2024 edition; avoids creating references to uninitialized statics.

### Crate: hyperion-core

| Module | Role |
|---|---|
| `lib.rs` | WASM exports: `engine_init`, `engine_attach_ring_buffer`, `engine_update`, `engine_tick_count`, `engine_gpu_data_ptr/f32_len/entity_count`, `engine_gpu_tex_indices_ptr/len`, `engine_compact_entity_map`, `engine_compact_render_state`, `engine_entity_map_capacity` |
| `engine.rs` | `Engine` struct with fixed-timestep accumulator, ties together ECS + commands + systems. Wires `propagate_transforms` for scene graph hierarchy |
| `command_processor.rs` | `EntityMap` (external ID ↔ hecs Entity with free-list recycling, `shrink_to_fit()`, `iter_mapped()`) + `process_commands` (including `SetParent` with parent/child bookkeeping) |
| `ring_buffer.rs` | SPSC consumer with atomic read/write heads, `CommandType` enum (11 variants incl. `SetParent`), `Command` struct |
| `components.rs` | `Position(Vec3)`, `Rotation(Quat)`, `Scale(Vec3)`, `Velocity(Vec3)`, `ModelMatrix([f32;16])`, `BoundingRadius(f32)`, `TextureLayerIndex(u32)`, `MeshHandle(u32)`, `RenderPrimitive(u32)`, `Active`, `Parent(u32)`, `Children` (fixed 32-slot inline array), `LocalMatrix([f32;16])` — all `#[repr(C)]` Pod |
| `systems.rs` | `velocity_system`, `transform_system`, `count_active`, `propagate_transforms` (scene graph hierarchy) |
| `render_state.rs` | `collect()` for legacy matrices, `collect_gpu()` for SoA GPU buffers (transforms/bounds/renderMeta/texIndices) + `BitSet`/`DirtyTracker` for partial upload optimization + `shrink_to_fit()` for memory compaction |

### TypeScript: ts/src/

| Module | Role |
|---|---|
| `hyperion.ts` | `Hyperion` class — public API facade with `create()`, `spawn()`, `batch()`, `start/pause/resume/destroy`, `use()/unuse()`, `addHook/removeHook`, `loadTexture/loadTextures`, `compact()`, `resize()`. `fromParts()` test factory |
| `entity-handle.ts` | `EntityHandle` — fluent builder over `BackpressuredProducer` with `.position/.velocity/.rotation/.scale/.texture/.mesh/.primitive/.parent/.unparent/.data`. Implements `Disposable` |
| `entity-pool.ts` | `EntityHandlePool` — object pool (cap 1024) for EntityHandle recycling via `init()` |
| `game-loop.ts` | `GameLoop` — RAF lifecycle with preTick/postTick/frameEnd hook phases, FPS tracking |
| `camera-api.ts` | `CameraAPI` — wrapper around Camera with zoom support (clamped to min 0.01) |
| `raw-api.ts` | `RawAPI` — low-level numeric ID entity management bypassing EntityHandle overhead |
| `plugin.ts` | `HyperionPlugin` interface + `PluginRegistry` — plugin lifecycle with install/cleanup |
| `types.ts` | Core types: `HyperionConfig`, `ResolvedConfig`, `HyperionStats`, `MemoryStats`, `CompactOptions`, `TextureHandle` |
| `leak-detector.ts` | `LeakDetector` — `FinalizationRegistry` backstop for undisposed EntityHandles |
| `index.ts` | Barrel export for public API surface |
| `capabilities.ts` | Detects browser features, selects ExecutionMode A/B/C |
| `ring-buffer.ts` | `RingBufferProducer` — serializes commands into SharedArrayBuffer with Atomics |
| `worker-bridge.ts` | `EngineBridge` interface — `createWorkerBridge()` (Modes A/B) or `createDirectBridge()` (Mode C). Uses `BackpressuredProducer` for command buffering and `WorkerSupervisor` for heartbeat monitoring (Modes A/B) |
| `engine-worker.ts` | Web Worker that loads WASM, calls `engine_init`/`engine_update` per frame. Increments heartbeat counter after each tick for supervisor monitoring |
| `main.ts` | Entry point: uses Hyperion public API (`Hyperion.create()`, `spawn()`, `start()`). ~50 lines, down from 140 |
| `renderer.ts` | RenderGraph-based coordinator: creates shared GPU buffers in `ResourcePool`, wires `CullPass` + `ForwardPass`, delegates rendering via `graph.render()`. Accepts SoA `GPURenderState`. Added `onDeviceLost` callback + `device.lost` listener |
| `texture-manager.ts` | `TextureManager` — multi-tier Texture2DArray with lazy allocation + exponential growth (0→16→32→64→128→256 layers), `createImageBitmap` loading pipeline, concurrency limiter. Added `retainBitmaps` option for device-lost recovery |
| `camera.ts` | Orthographic camera, `extractFrustumPlanes()`, `isSphereInFrustum()` |
| `render-worker.ts` | Mode A render worker: OffscreenCanvas + `createRenderer()`. Converts ArrayBuffer render state to typed arrays for `GPURenderState` |
| `backpressure.ts` | `PrioritizedCommandQueue` + `BackpressuredProducer` — priority-based command queuing with automatic overflow handling. `BackpressuredProducer` wraps `RingBufferProducer` with convenience methods (spawnEntity, setPosition, etc.) |
| `supervisor.ts` | `WorkerSupervisor` — Worker heartbeat monitoring + timeout detection with configurable intervals |
| `render/render-pass.ts` | `RenderPass` interface + `FrameState` type — modular rendering pipeline abstraction with reads/writes resource declarations |
| `render/resource-pool.ts` | `ResourcePool` — named registry for GPU resources (GPUBuffer, GPUTexture, GPUTextureView, GPUSampler) |
| `render/render-graph.ts` | `RenderGraph` — DAG-based pass scheduling with Kahn's topological sort + dead-pass culling |
| `render/passes/cull-pass.ts` | `CullPass` — GPU frustum culling compute pass. `prepare()` uploads frustum planes + resets indirect args. `execute()` dispatches compute workgroups |
| `render/passes/forward-pass.ts` | `ForwardPass` — Forward rendering pass with SoA transforms, lazy depth texture, camera uniform upload, and full render pass encoding via `drawIndexedIndirect` |
| `render/passes/prefix-sum-reference.ts` | `exclusiveScanCPU()` — CPU reference implementation of Blelloch exclusive scan |
| `shaders/basic.wgsl` | Render shader with SoA `transforms: array<mat4x4f>`, visibility indirection, multi-tier Texture2DArray sampling |
| `shaders/cull.wgsl` | WGSL compute shader: sphere-frustum culling with SoA bindings, atomicAdd for indirect draw |
| `shaders/prefix-sum.wgsl` | WGSL Blelloch prefix sum compute shader (workgroup-level, 512 elements per workgroup) |
| `vite-env.d.ts` | Type declarations for WGSL ?raw imports and Vite client |

## Gotchas

- **hecs 0.11 `query_mut`** returns component tuples directly, NOT `(Entity, components)`. Use `for (pos, vel) in world.query_mut::<(&mut Position, &Velocity)>()`.
- **Rust `u64` → JS `BigInt`** via wasm-bindgen. Wrap with `Number()` on TS side (safe for values < 2^53).
- **`wasm-bindgen` can't export `unsafe fn`** — use `#[allow(clippy::not_unsafe_ptr_arg_deref)]` for functions taking raw pointers.
- **TS `const enum` has no reverse mapping** — `CommandType[value]` fails (TS2476). Log numeric values directly.
- **Public types with parameterless `new()`** must also impl `Default` (Clippy `new_without_default`).
- **`wasm-pack --out-dir`** is relative to the crate directory, not the workspace root.
- **`@webgpu/types` Float32Array strictness** — `writeBuffer` requires `Float32Array<ArrayBuffer>` cast when the source might be `Float32Array<ArrayBufferLike>`.
- **Indirect draw buffer needs STORAGE | INDIRECT | COPY_DST** — compute shader writes instanceCount (STORAGE), render pass reads it (INDIRECT), CPU resets it each frame (COPY_DST).
- **Frustum extraction lives in `camera.ts`** — `CullPass` imports `extractFrustumPlanes` from `camera.ts`. The old `extractFrustumPlanesInternal` in `renderer.ts` has been removed.
- **WebGPU can't be tested in headless browsers** — Playwright/Puppeteer headless mode has no GPU adapter. `requestAdapter()` returns null. Visual WebGPU testing requires a real browser with GPU acceleration (e.g., `npm run dev` → open Chrome).
- **Depth texture lazy recreation** — `ForwardPass.ensureDepthTexture()` creates/recreates the depth texture when canvas dimensions change. `resize()` invalidates the dimension tracking, triggering recreation on the next `execute()`. This fixes the old bug where `renderer.ts` created the depth texture only once at initialization.
- **No rendering fallback without WebGPU** — When WebGPU is unavailable, the engine runs the ECS/WASM simulation but rendering is completely disabled (`renderer` stays `null`). A future phase should add a WebGL 2 fallback renderer (CPU-side culling, GLSL shaders) implementing the same `Renderer` interface. Canvas 2D is an option for debug/wireframe only.
- **Full entity buffer re-upload every frame** — `renderer.ts` uploads all SoA buffers via `writeBuffer` each frame, even if most entities haven't moved. Future optimizations: (1) use `DirtyTracker` (now in Rust) for partial upload when `transform_dirty_ratio < 0.3`, (2) stable entity slots in GPU buffer via `EntityMap` free-list, (3) double-buffering with `mapAsync` to eliminate `writeBuffer` internal copies, (4) CPU-side frustum pre-culling to skip off-screen entities before upload.
- **`createImageBitmap` not available in Workers on all browsers** — Firefox and Chrome support it. Safari has partial support. The `TextureManager` should only be instantiated where `createImageBitmap` is available.
- **Texture2DArray maxTextureArrayLayers varies by device** — WebGPU spec guarantees minimum 256. The `TextureManager` allocates 256 layers per tier. On devices with fewer layers, loading will fail. Future: query `device.limits.maxTextureArrayLayers`.
- **TextureManager lazy allocation** — Tiers are now lazily allocated (no GPU textures created until first use). Growth follows exponential steps: 0→16→32→64→128→256 layers per tier. `getTierView()` creates a minimal 1-layer placeholder for bind group validity. Resize copies existing layers via `copyTextureToTexture`.
- **Multi-tier textures require switch in WGSL** — WGSL cannot dynamically index texture bindings. The fragment shader uses a `switch` on the tier value. Adding new tiers requires updating the shader.
- **SoA buffers parallel indexed** — All SoA buffers (transforms, bounds, texIndices) must be indexed by the same entity index. All are populated in the same `collect_gpu()` loop in Rust, ensuring alignment. The `ResourcePool` stores them under `entity-transforms`, `entity-bounds`, `tex-indices`.
- **ResourcePool buffer naming convention** — CullPass reads `entity-transforms` + `entity-bounds`, writes `visible-indices` + `indirect-args`. ForwardPass reads `entity-transforms` + `visible-indices` + `tex-indices` + `indirect-args`, writes `swapchain`. Texture views: `tier0`-`tier3`. Sampler: `texSampler`. Swapchain view: `swapchain` (set per-frame by coordinator).
- **BackpressuredProducer wraps RingBufferProducer** — All three bridge factories (`createWorkerBridge`, `createFullIsolationBridge`, `createDirectBridge`) use `BackpressuredProducer` instead of raw `RingBufferProducer`. `flush()` is called at the start of every `tick()`.
- **Worker heartbeat via ring buffer header** — Engine-worker increments `Atomics.add(header, HEARTBEAT_W1_OFFSET, 1)` after each tick. `WorkerSupervisor` checks heartbeat counters every 1s via `setInterval`. Currently logs warnings only; escalation is TODO(Phase 5).
- **`EntityHandle.data()` cleared on `init()`** — When EntityHandles are recycled from the pool, `init()` resets the data map. Plugins that store data via `.data(key, value)` must handle the case where data disappears after pool reuse.
- **`Hyperion.fromParts()` vs `Hyperion.create()`** — `fromParts()` is the test factory that accepts pre-built components (bridge, renderer, etc.) for unit testing without real WASM/WebGPU. `create()` is the production factory that performs capability detection, bridge creation, and renderer initialization.
- **Plugin teardown order** — `pluginRegistry.destroyAll()` runs before bridge/renderer destroy in `Hyperion.destroy()`. This ensures plugins can still access engine resources during their cleanup phase.
- **`GameLoop` first-frame sentinel** — `GameLoop` uses `lastTime = -1` sentinel to detect the first RAF callback and set dt=0, avoiding a massive first-frame dt spike (which would be `performance.now()` milliseconds).
- **Scene graph `SetParent` uses `0xFFFFFFFF` for unparent** — The `SetParent` command payload is a `u32` parent entity ID. The special value `0xFFFFFFFF` means "remove parent" (unparent). This allows the same command type for both parenting and unparenting.
- **`Children` component uses fixed 32-slot inline array** — No heap allocation for child lists. Entities with more than 32 children will silently drop additional children. This is a design trade-off for cache performance.

## Conventions

- All ECS components are `#[repr(C)]` with `bytemuck::Pod` + `Zeroable` for GPU-uploadable memory layout.
- Rust tests are inline `#[cfg(test)] mod tests` in each source file. TypeScript tests are `*.test.ts` colocated in `ts/src/`.
- `CommandType` enum values must stay synchronized between Rust (`ring_buffer.rs`) and TypeScript (`ring-buffer.ts`).
- Little-endian byte order everywhere for cross-architecture safety (ring buffer uses `DataView` on TS side).
- WASM singletons (`static mut ENGINE/RING_BUFFER`) are safe because wasm32 is single-threaded; every `unsafe` block has a SAFETY comment.
- Vite dev server must serve COOP/COEP headers for SharedArrayBuffer access (`vite.config.ts`).
- WGSL shaders live in `ts/src/shaders/`, loaded at dev time via Vite `?raw` imports.

## Implementation Status

Phases 0-5, Phase 4.5 (Stabilization & Architecture Foundations), and Post-Plan Integration are complete. Phase 5 (TypeScript API & Lifecycle) added a complete public API facade over the engine internals: `Hyperion` class with `create()/spawn()/batch()/start/pause/resume/destroy`, `EntityHandle` fluent builder with object pooling (`EntityHandlePool`), `GameLoop` with preTick/postTick/frameEnd hooks, `CameraAPI` with zoom, `RawAPI` for low-level numeric entity management, `PluginRegistry` for plugin lifecycle, `LeakDetector` via `FinalizationRegistry`, and a barrel export via `index.ts`. On the Rust side: scene graph support (`Parent`/`Children`/`LocalMatrix` components, `propagate_transforms` system, `SetParent` command), memory compaction (`EntityMap.shrink_to_fit`, `RenderState.shrink_to_fit`, new WASM exports), and device-lost recovery plumbing (`onDeviceLost` callback, `retainBitmaps`). `main.ts` rewritten to use the Hyperion public API (~50 lines, down from 140). **Next: Phase 6 (Audio & Input).**

## Documentation

- `PROJECT_ARCHITECTURE.md` — Deep technical architecture doc (algorithms, data structures, protocol details, design rationale). Reference for onboarding and implementation decisions.
- `docs/plans/hyperion-engine-design-v3.md` — Full vision design doc v3 (all phases). Reference for future phase implementation.
- `docs/plans/hyperion-engine-roadmap-unified-v3.md` — Unified roadmap v3. Phase-by-phase feature breakdown.
- `docs/plans/2026-02-17-hyperion-engine-phase0-phase1.md` — Phase 0-1 implementation plan (completed). Shows task-by-task build sequence.
- `docs/plans/2026-02-17-hyperion-engine-phase3.md` — Phase 3 implementation plan (completed). GPU-driven pipeline with compute culling.
- `docs/plans/2026-02-18-phase-4.5-stabilization-arch-foundations.md` — Phase 4.5 implementation plan (completed). 15 tasks for stabilization and architecture foundations.
