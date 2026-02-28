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
cargo test -p hyperion-core                  # All Rust unit tests (110 tests)
cargo clippy -p hyperion-core                # Lint check (treat warnings as errors)
cargo build -p hyperion-core                 # Build crate (native, not WASM)
cargo doc -p hyperion-core --open            # Generate and open API docs

# Run specific test groups
cargo test -p hyperion-core ring_buffer      # Ring buffer tests only (19 tests)
cargo test -p hyperion-core engine           # Engine tests only (9 tests)
cargo test -p hyperion-core render_state     # Render state tests only (36 tests)
cargo test -p hyperion-core command_proc     # Command processor tests only (17 tests)
cargo test -p hyperion-core systems          # Systems tests only (7 tests)
cargo test -p hyperion-core components       # Component tests only (23 tests)

# Run a single test by full path
cargo test -p hyperion-core engine::tests::spiral_of_death_capped
```

### WASM

```bash
# Compile Rust to WebAssembly (outputs to ts/wasm/)
cd ts && npm run build:wasm
# Equivalent to: wasm-pack build ../crates/hyperion-core --target web --out-dir ../../ts/wasm

# Optimized release build (wasm-pack + wasm-opt -O3 --strip-debug --enable-simd)
cd ts && npm run build:wasm:release

# Check binary size (CI gate: <200KB gzipped)
cd ts && npm run check:wasm-size

# After building, check generated TypeScript types
cat ts/wasm/hyperion_core.d.ts
```

### TypeScript

```bash
cd ts && npm test                            # All vitest tests (632 tests)
cd ts && npm run test:watch                  # Watch mode (re-runs on file change)
cd ts && npx tsc --noEmit                    # Type-check only (no output files)
cd ts && npm run build                       # Production build (tsc + vite build)
cd ts && npm run dev                         # Vite dev server with COOP/COEP headers

# Run specific test files
cd ts && npx vitest run src/ring-buffer.test.ts               # Ring buffer producer (17 tests)
cd ts && npx vitest run src/ring-buffer-utils.test.ts         # extractUnread helper (4 tests)
cd ts && npx vitest run src/camera.test.ts                    # Camera math + frustum + ray (19 tests)
cd ts && npx vitest run src/capabilities.test.ts              # Capability detection + compressed format + subgroups (11 tests)
cd ts && npx vitest run src/integration.test.ts               # E2E integration (5 tests)
cd ts && npx vitest run src/frustum.test.ts                   # Frustum culling accuracy (7 tests)
cd ts && npx vitest run src/texture-manager.test.ts           # Texture manager + KTX2/compressed (36 tests)
cd ts && npx vitest run src/backpressure.test.ts              # Backpressure queue + producer (22 tests)
cd ts && npx vitest run src/supervisor.test.ts                # Worker supervisor (5 tests)
cd ts && npx vitest run src/render/render-pass.test.ts        # RenderPass + ResourcePool (6 tests)
cd ts && npx vitest run src/render/render-graph.test.ts       # RenderGraph DAG (8 tests)
cd ts && npx vitest run src/render/passes/cull-pass.test.ts   # CullPass extraction + subgroup helpers + 2-bucket sort (12 tests)
cd ts && npx vitest run src/render/passes/scatter-pass.test.ts # ScatterPass compute (2 tests)
cd ts && npx vitest run src/render/passes/forward-pass.test.ts # ForwardPass multi-pipeline (2 tests)
cd ts && npx vitest run src/render/passes/fxaa-tonemap-pass.test.ts  # FXAATonemapPass (3 tests)
cd ts && npx vitest run src/render/passes/selection-seed-pass.test.ts # SelectionSeedPass (3 tests)
cd ts && npx vitest run src/render/passes/jfa-pass.test.ts    # JFA pass iterations (9 tests)
cd ts && npx vitest run src/render/passes/outline-composite-pass.test.ts # OutlineComposite (6 tests)
cd ts && npx vitest run src/render/passes/prefix-sum.test.ts  # Blelloch prefix sum (6 tests)
cd ts && npx vitest run src/hyperion.test.ts                  # Hyperion facade (65 tests)
cd ts && npx vitest run src/entity-handle.test.ts             # EntityHandle fluent API (30 tests)
cd ts && npx vitest run src/entity-pool.test.ts               # EntityHandle pool recycling (5 tests)
cd ts && npx vitest run src/game-loop.test.ts                 # GameLoop RAF lifecycle (12 tests)
cd ts && npx vitest run src/raw-api.test.ts                   # RawAPI numeric interface (4 tests)
cd ts && npx vitest run src/camera-api.test.ts                # CameraAPI zoom (3 tests)
cd ts && npx vitest run src/system-views.test.ts              # SystemViews typed views (1 test)
cd ts && npx vitest run src/plugin.test.ts                    # PluginRegistry + dependency resolution (13 tests)
cd ts && npx vitest run src/leak-detector.test.ts             # LeakDetector backstop (2 tests)
cd ts && npx vitest run src/types.test.ts                     # Config types + defaults (4 tests)
cd ts && npx vitest run src/selection.test.ts                 # SelectionManager (10 tests)
cd ts && npx vitest run src/input-manager.test.ts             # InputManager keyboard+pointer+callbacks (27 tests)
cd ts && npx vitest run src/hit-tester.test.ts                # CPU ray-sphere hit testing + spatial grid (9 tests)
cd ts && npx vitest run src/immediate-state.test.ts           # Immediate mode shadow state + bounds patching (10 tests)
cd ts && npx vitest run src/input-picking.test.ts             # Input→picking integration (3 tests)
cd ts && npx vitest run src/text/text-layout.test.ts          # MSDF text layout (3 tests)
cd ts && npx vitest run src/audio-types.test.ts               # Audio branded types + defaults (3 tests)
cd ts && npx vitest run src/sound-registry.test.ts            # SoundRegistry load/decode/dedup (13 tests)
cd ts && npx vitest run src/playback-engine.test.ts           # PlaybackEngine play/stop/spatial (26 tests)
cd ts && npx vitest run src/audio-manager.test.ts             # AudioManager facade + lifecycle (25 tests)
cd ts && npx vitest run src/event-bus.test.ts                 # EventBus pub/sub (5 tests)
cd ts && npx vitest run src/plugin-context.test.ts            # PluginContext + sub-APIs (10 tests)
cd ts && npx vitest run src/profiler.test.ts                  # ProfilerOverlay DOM management (4 tests)
cd ts && npx vitest run src/plugins/fps-counter.test.ts       # Example FPS counter plugin (3 tests)
cd ts && npx vitest run src/render/passes/bloom-pass.test.ts   # BloomPass (7 tests)
cd ts && npx vitest run src/particle-types.test.ts              # Particle types (3 tests)
cd ts && npx vitest run src/particle-system.test.ts             # ParticleSystem (5 tests)
cd ts && npx vitest run src/ktx2-parser.test.ts                # KTX2 container parser (10 tests)
cd ts && npx vitest run src/basis-transcoder.test.ts            # Basis Universal transcoder (11 tests)
cd ts && npx vitest run src/debug/tlv-parser.test.ts            # TLV binary parser (4 tests)
cd ts && npx vitest run src/debug/ecs-inspector.test.ts         # ECS Inspector plugin (3 tests)
cd ts && npx vitest run src/debug/debug-camera.test.ts          # Debug Camera plugin (3 tests)
cd ts && npx vitest run src/debug/bounds-visualizer.test.ts    # Bounds visualizer plugin (6 tests)
cd ts && npx vitest run src/prim-params-schema.test.ts         # Prim params schema (9 tests)
cd ts && npx vitest run src/prefab/types.test.ts               # Prefab types + validation (6 tests)
cd ts && npx vitest run src/prefab/instance.test.ts            # PrefabInstance (8 tests)
cd ts && npx vitest run src/prefab/registry.test.ts            # PrefabRegistry (15 tests)
cd ts && npx vitest run src/prefab/integration.test.ts         # Prefab facade integration (3 tests)
cd ts && npx vitest run src/replay/command-tape.test.ts        # CommandTapeRecorder circular buffer (7 tests)
cd ts && npx vitest run src/replay/replay-player.test.ts       # ReplayPlayer deterministic replay (6 tests)
cd ts && npx vitest run src/replay/snapshot-manager.test.ts    # SnapshotManager periodic capture (5 tests)
cd ts && npx vitest run src/hmr/hot-system.test.ts             # createHotSystem HMR helper (6 tests)
cd ts && npx vitest run src/asset-pipeline/ktx2-node.test.ts   # Node.js KTX2 parser (4 tests)
cd ts && npx vitest run src/asset-pipeline/scanner.test.ts     # Texture scanner (5 tests)
cd ts && npx vitest run src/asset-pipeline/codegen.test.ts     # Code generator (3 tests)
cd ts && npx vitest run src/asset-pipeline/vite-plugin.test.ts # Vite plugin (4 tests)
cd ts && npx vitest run src/spatial-grid.test.ts               # SpatialGrid broadphase (8 tests)
cd ts && npx vitest run src/texture-priority.test.ts           # TexturePriorityQueue (10 tests)
cd ts && npx vitest run src/ring-buffer-bench.test.ts          # Ring buffer saturation benchmark (2 tests)
cd ts && npx vitest run src/demo/types.test.ts                 # Demo types + TestReporter (4 tests)
cd ts && npx vitest run src/demo/report.test.ts                # ReportBuilder JSON export (2 tests)

# Debug/dev-tools (requires feature flag)
cargo test -p hyperion-core --features dev-tools   # Includes dev-tools gated tests (120 tests)
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
# - wasm-opt: cargo install wasm-opt (used by build:wasm:opt for --strip-debug --enable-simd)
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
| `lib.rs` | WASM exports: `engine_init`, `engine_attach_ring_buffer`, `engine_update`, `engine_tick_count`, `engine_gpu_data_ptr/f32_len/entity_count`, `engine_gpu_tex_indices_ptr/len`, `engine_gpu_entity_ids_ptr/len`, `engine_compact_entity_map`, `engine_compact_render_state`, `engine_entity_map_capacity`, `engine_listener_x/y/z`, `engine_dirty_count/ratio`, `engine_staging_ptr/u32_len`, `engine_staging_indices_ptr/len`. Dev-tools: `engine_reset`, `engine_snapshot_create`, `engine_snapshot_restore` |
| `engine.rs` | `Engine` struct with fixed-timestep accumulator, ties together ECS + commands + systems. Wires `propagate_transforms` for scene graph hierarchy. Listener position state with velocity derivation and extrapolation. Dev-tools: `reset()`, `snapshot_create()`, `snapshot_restore()` for time-travel debug |
| `command_processor.rs` | `EntityMap` (external ID ↔ hecs Entity with free-list recycling, `shrink_to_fit()`, `iter_mapped()`) + `process_commands` (including `SetParent` with parent/child bookkeeping) |
| `ring_buffer.rs` | SPSC consumer with atomic read/write heads, `CommandType` enum (14 variants incl. `SetParent`, `SetPrimParams0`, `SetPrimParams1`, `SetListenerPosition`), `Command` struct |
| `components.rs` | `Position(Vec3)`, `Rotation(Quat)`, `Scale(Vec3)`, `Velocity(Vec3)`, `ModelMatrix([f32;16])`, `BoundingRadius(f32)`, `TextureLayerIndex(u32)`, `MeshHandle(u32)`, `RenderPrimitive(u32)`, `PrimitiveParams([f32;8])`, `ExternalId(u32)`, `Active`, `Parent(u32)`, `Children` (fixed 32-slot inline array), `LocalMatrix([f32;16])` — all `#[repr(C)]` Pod. `OverflowChildren(Vec<u32>)` — heap fallback for 33+ children, NOT `#[repr(C)]`/Pod |
| `systems.rs` | `velocity_system`, `transform_system`, `count_active`, `propagate_transforms` (scene graph hierarchy) |
| `render_state.rs` | `collect()` for legacy matrices, `collect_gpu()` for SoA GPU buffers (transforms/bounds/renderMeta/texIndices/primParams/entityIds) + `BitSet`/`DirtyTracker` for partial upload optimization + stable slot mapping (`assign_slot`/`get_slot`/`flush_pending_despawns` with swap-remove) + `collect_dirty_staging()` for GPU scatter upload (128B/entity staging buffer) + `write_slot()` for in-place SoA updates + `shrink_to_fit()` for memory compaction |

### TypeScript: ts/src/

#### Core & Public API

| Module | Role |
|---|---|
| `hyperion.ts` | `Hyperion` — public facade: `create()`, `spawn()`, `batch()`, `start/pause/resume/destroy`, `use()/unuse()`, `addHook/removeHook`, `loadTexture/loadTextures`, `compact()`, `resize()`, `selection`, `enableOutlines/disableOutlines`, `enableBloom/disableBloom`, `createParticleEmitter/destroyParticleEmitter`, `input`, `picking`, `audio`, `prefabs`, `enableProfiler/disableProfiler`, `recompileShader`, `compressionFormat`, `debug` (recording tap). `fromParts()` test factory |
| `entity-handle.ts` | `EntityHandle` — fluent builder (`.position/.velocity/.rotation/.scale/.texture/.mesh/.primitive/.parent/.unparent/.line/.gradient/.boxShadow/.bezier/.data/.positionImmediate/.clearImmediate`). `RenderPrimitiveType` enum. Implements `Disposable` |
| `entity-pool.ts` | `EntityHandlePool` — object pool (cap 1024) for EntityHandle recycling |
| `raw-api.ts` | `RawAPI` — low-level numeric ID entity management bypassing EntityHandle overhead |
| `types.ts` | `HyperionConfig`, `ResolvedConfig`, `HyperionStats`, `MemoryStats`, `CompactOptions`, `TextureHandle` |
| `index.ts` | Barrel export (includes `BloomConfig`, `ParticleEmitterConfig`, `ParticleHandle`, `DEFAULT_PARTICLE_CONFIG`, `KTX2Container`, `BasisTranscoder`, `detectCompressedFormat`, `PrefabRegistry`, `boundsVisualizerPlugin`, `CommandTapeRecorder`, `ReplayPlayer`, `SnapshotManager`, `createHotSystem`) |
| `prim-params-schema.ts` | `PRIM_PARAMS_SCHEMA` + `resolvePrimParams()` — shared parameter name → f32[8] slot registry |

#### Prefabs (`ts/src/prefab/`)

| Module | Role |
|---|---|
| `prefab/types.ts` | `PrefabTemplate`, `PrefabNode`, `SpawnOverrides`, `validateTemplate()` |
| `prefab/instance.ts` | `PrefabInstance` — spawned prefab handle with `moveTo()`, `destroyAll()` |
| `prefab/registry.ts` | `PrefabRegistry` — register/spawn/unregister prefab templates |

#### Asset Pipeline (`ts/src/asset-pipeline/`, build-time only)

| Module | Role |
|---|---|
| `asset-pipeline/ktx2-node.ts` | `parseKTX2Header()` — Node.js build-time KTX2 header parser |
| `asset-pipeline/scanner.ts` | `scanTextures()` — directory scanner with PascalCase naming |
| `asset-pipeline/codegen.ts` | `generateAssetCode()` — TypeScript constant file generator |
| `asset-pipeline/vite-plugin.ts` | `hyperionAssets()` — Vite plugin with watch mode |

#### Engine Runtime

| Module | Role |
|---|---|
| `system-views.ts` | `SystemViews` — read-only typed views into GPU SoA buffers (transforms/bounds/entityIds/renderMeta). Updated once per tick cycle |
| `game-loop.ts` | `GameLoop` — RAF lifecycle with preTick/postTick/frameEnd hooks, FPS/frame-time tracking |
| `camera.ts` | Orthographic camera, `extractFrustumPlanes()`, `isSphereInFrustum()`, `mat4Inverse()`, `screenToRay()` |
| `camera-api.ts` | `CameraAPI` — zoom support (min 0.01), `x`/`y` position getters |
| `capabilities.ts` | Browser feature detection, selects ExecutionMode A/B/C, `detectCompressedFormat()` for BC7/ASTC probing, `detectSubgroupSupport()` for WebGPU subgroups |
| `leak-detector.ts` | `LeakDetector` — `FinalizationRegistry` backstop for undisposed EntityHandles |
| `main.ts` | Tab-based verification harness: 8-section switcher, lazy-loaded demo sections, check panel, JSON report export |

#### Bridge & Workers

| Module | Role |
|---|---|
| `ring-buffer.ts` | `RingBufferProducer` — serializes commands into SharedArrayBuffer with Atomics |
| `backpressure.ts` | `PrioritizedCommandQueue` + `BackpressuredProducer` — wraps RingBufferProducer with priority queuing + `setRecordingTap()` for command tape recording |
| `worker-bridge.ts` | `EngineBridge` interface — `createFullIsolationBridge(canvas)` (A), `createWorkerBridge()` (B), `createDirectBridge()` (C). `GPURenderState` type |
| `engine-worker.ts` | Web Worker: loads WASM, calls `engine_init`/`engine_update`, heartbeat counter |
| `render-worker.ts` | Mode A: OffscreenCanvas + `createRenderer()` |
| `supervisor.ts` | `WorkerSupervisor` — heartbeat monitoring + timeout detection |
| `ring-buffer-bench.ts` | `measureRingBufferSaturation()` — stress benchmark for ring buffer utilization. Verdict: no-action/monitor/optimize |

#### Rendering Pipeline

| Module | Role |
|---|---|
| `renderer.ts` | RenderGraph coordinator: ResourcePool, CullPass+ForwardPass+FXAATonemapPass, optional outlines/bloom, ParticleSystem integration, shader HMR (14 WGSL files), device-lost recovery, compressed texture format detection + overflow views |
| `texture-manager.ts` | Multi-tier Texture2DArray with compressed format support (BC7/ASTC), overflow tiers for mixed-mode, lazy allocation (0→16→32→64→128→256), KTX2 load path, `createImageBitmap` pipeline, `TexturePriorityQueue` min-heap for viewport-distance-based load ordering |
| `render/render-pass.ts` | `RenderPass` interface + `FrameState` type |
| `render/resource-pool.ts` | `ResourcePool` — named GPU resource registry |
| `render/render-graph.ts` | `RenderGraph` — DAG scheduling with Kahn's topological sort + dead-pass culling |
| `render/passes/cull-pass.ts` | GPU frustum culling compute, 6 primitive types, per-type DrawIndirectArgs |
| `render/passes/forward-pass.ts` | Multi-pipeline forward pass, `SHADER_SOURCES` per RenderPrimitiveType, renders to `scene-hdr` |
| `render/passes/fxaa-tonemap-pass.ts` | Full-screen FXAA + tonemap (none/PBR-neutral/ACES), reads `scene-hdr` → `swapchain` |
| `render/passes/selection-seed-pass.ts` | Renders selected entities as JFA seeds |
| `render/passes/jfa-pass.ts` | Single JFA iteration, ping-pong textures, `iterationsForDimension()` helper |
| `render/passes/outline-composite-pass.ts` | SDF distance outline from JFA + scene, built-in FXAA |
| `render/passes/bloom-pass.ts` | Dual Kawase bloom (6-step chain), mutually exclusive with outlines |
| `render/passes/prefix-sum-reference.ts` | `exclusiveScanCPU()` — CPU reference of Blelloch exclusive scan |
| `render/passes/scatter-pass.ts` | GPU scatter compute pass: writes dirty staging data to SoA buffers, grow-only buffers, 2-bind-group layout |
| `particle-types.ts` | `ParticleHandle`, `ParticleEmitterConfig`, `DEFAULT_PARTICLE_CONFIG`, `PARTICLE_STRIDE_BYTES=48` |
| `particle-system.ts` | GPU particle system: per-emitter buffers, compute simulate+spawn, instanced point-sprite render, entity tracking, spawn accumulator |
| `ktx2-parser.ts` | Custom KTX2 container parser: magic validation, header/level reading, `isKTX2()` detection, `VK_FORMAT` constants |
| `basis-transcoder.ts` | Singleton Basis Universal WASM transcoder wrapper, lazy-loaded, `transcode()` with BC7/ASTC/RGBA8 targets |

#### Input & Picking

| Module | Role |
|---|---|
| `input-manager.ts` | Keyboard/pointer/scroll state + callbacks (`onKey`/`onClick`/`onPointerMove`/`onScroll`), DOM lifecycle |
| `hit-tester.ts` | `hitTestRay()` — CPU ray-sphere intersection, returns closest entityId or null. Optional `SpatialGrid` parameter for O(1) broadphase |
| `spatial-grid.ts` | `SpatialGrid` — zero-alloc uniform 2D hash grid for hit-testing broadphase. Flat `Int32Array` backing, 3-pass rebuild, 3×3 neighborhood query |
| `immediate-state.ts` | Shadow position map for zero-latency rendering, `patchTransforms()` + `patchBounds()` |
| `selection.ts` | `SelectionManager` — CPU `Set<number>` with dirty tracking + GPU mask upload |

#### Audio

| Module | Role |
|---|---|
| `audio-types.ts` | Branded types `SoundHandle`/`PlaybackId`, `PlaybackOptions`, `SpatialConfig` |
| `sound-registry.ts` | URL-deduplicated audio buffer management with DI, bidirectional handle-URL maps |
| `playback-engine.ts` | Web Audio node graph, 2D spatial (StereoPanner + distance attenuation), `setTargetAtTime` smoothing |
| `audio-manager.ts` | Public facade: lazy AudioContext, safe no-ops before init, suspend/resume/destroy lifecycle |

#### Plugins

| Module | Role |
|---|---|
| `plugin.ts` | `HyperionPlugin` interface + `PluginRegistry` — dependency resolution, error boundaries |
| `plugin-context.ts` | `PluginContext` with 5 sub-APIs: systems, events, rendering (nullable), gpu (nullable), storage |
| `event-bus.ts` | Typed pub/sub (`on`/`off`/`once`/`emit`/`destroy`), shared between PluginContexts |
| `profiler.ts` | `ProfilerOverlay` — DOM performance stats (4 corner positions) |
| `plugins/fps-counter.ts` | Example plugin: postTick hook + EventBus emit |

#### Text

| Module | Role |
|---|---|
| `text/font-atlas.ts` | `FontAtlas` + `GlyphMetrics`, `parseFontAtlas()`, `loadFontAtlas()` |
| `text/text-layout.ts` | `layoutText()` — glyph positioning from atlas metrics |
| `text/text-manager.ts` | `TextManager` — font atlas cache for MSDF text rendering |

#### Demo / Verification Harness (`ts/src/demo/`)

| Module | Role |
|---|---|
| `demo/types.ts` | `DemoSection`, `TestReporter`, `TestResult`, `SectionStatus`, `createTestReporter()` |
| `demo/report.ts` | `ReportBuilder` — collects section reports, builds JSON, downloads file |
| `demo/primitives.ts` | Quads, gradients, box shadows, lines, beziers, MSDF text (6 checks) |
| `demo/scene-graph.ts` | Parent/child, velocity, rotation, scale, nested transforms (5 checks) |
| `demo/input.ts` | Keyboard, click, pointer, scroll, hit-test, selection (6 checks) |
| `demo/audio.ts` | Load, play, spatial, suspend/resume (4 checks) |
| `demo/particles.ts` | Create, multiple, destroy, entity tracking (4 checks) |
| `demo/rendering-fx.ts` | Bloom, outlines, tonemap, resize (4 checks) |
| `demo/debug-tools.ts` | Profiler, bounds, inspector, debug-cam, time-travel (5 checks) |
| `demo/lifecycle.ts` | Spawn/destroy, batch, compact, immediate, data, prefabs (6 checks) |

#### Debug (`ts/src/debug/`, dev-tools only)

| Module | Role |
|---|---|
| `debug/debug-camera.ts` | `debugCameraPlugin` — WASD movement + scroll zoom, F1 toggle |
| `debug/tlv-parser.ts` | `parseTLV()` — decodes TLV binary from `engine_debug_get_components()`. 15 component types |
| `debug/ecs-inspector.ts` | `ecsInspectorPlugin` — HTML overlay panel, F12 toggle, dual data channels (SystemViews fast + WASM slow) |
| `debug/bounds-visualizer.ts` | `boundsVisualizerPlugin` — wireframe bounding sphere visualization, F2 toggle |

#### Replay / Time-Travel (`ts/src/replay/`, dev-tools only)

| Module | Role |
|---|---|
| `replay/command-tape.ts` | `CommandTapeRecorder` — circular buffer recording of ring-buffer commands. `TapeEntry` + `CommandTape` types |
| `replay/replay-player.ts` | `ReplayPlayer` — deterministic tick-by-tick replay of `CommandTape`. Groups entries by tick, serializes binary batches |
| `replay/snapshot-manager.ts` | `SnapshotManager` — periodic ECS snapshot capture in circular buffer. `findNearest()` for fast seek |

#### HMR (`ts/src/hmr/`)

| Module | Role |
|---|---|
| `hmr/hot-system.ts` | `createHotSystem()` — Vite HMR state preservation helper. Schema evolution via spread merge |

#### Shaders (`ts/src/shaders/`, loaded via Vite `?raw`)

| Shader | Role |
|---|---|
| `basic.wgsl` | Quad render: SoA transforms, visibility indirection, multi-tier Texture2DArray |
| `line.wgsl` | Screen-space quad expansion, SDF dash pattern |
| `gradient.wgsl` | 2-stop gradient (linear/radial/conic) |
| `box-shadow.wgsl` | SDF box shadow (Evan Wallace erf) |
| `bezier.wgsl` | Quadratic Bezier SDF (Inigo Quilez), `fwidth()` anti-aliased stroke |
| `msdf-text.wgsl` | MSDF median(r,g,b) signed distance + screen-pixel-range AA |
| `cull.wgsl` | Compute: sphere-frustum culling, 6 DrawIndirectArgs |
| `fxaa-tonemap.wgsl` | FXAA (Lottes) + PBR Neutral/ACES tonemap |
| `selection-seed.wgsl` | Selected entity UV-encoded seeds for JFA |
| `jfa.wgsl` | Jump Flood: 9-neighbor sampling at ±step |
| `outline-composite.wgsl` | SDF distance outline + FXAA |
| `bloom.wgsl` | Dual Kawase bloom (5 entry points), tonemap + FXAA |
| `particle-simulate.wgsl` | Compute: PCG hash PRNG, gravity, color/size interpolation (48 B/particle) |
| `particle-render.wgsl` | Instanced point-sprite circles, dead particle clipping |
| `prefix-sum.wgsl` | Blelloch prefix sum (workgroup-level, 512 elements) |
| `scatter.wgsl` | Compute: dirty entity data scatter from compact staging to SoA buffers, format=0 compressed 2D reconstruct / format=1 direct mat4x4 copy |

`vite-env.d.ts` — Type declarations for WGSL `?raw` imports, Vite client, and vendored Basis Universal WASM module.

## Gotchas

### Critical — will cause bugs or errors if ignored

- **hecs 0.11 `query_mut`** returns component tuples directly, NOT `(Entity, components)`. Use `for (pos, vel) in world.query_mut::<(&mut Position, &Velocity)>()`.
- **Rust `u64` → JS `BigInt`** via wasm-bindgen. Wrap with `Number()` on TS side (safe for values < 2^53).
- **`wasm-bindgen` can't export `unsafe fn`** — use `#[allow(clippy::not_unsafe_ptr_arg_deref)]` for functions taking raw pointers.
- **TS `const enum` has no reverse mapping** — `CommandType[value]` fails (TS2476). Log numeric values directly.
- **`@webgpu/types` Float32Array strictness** — `writeBuffer` requires `Float32Array<ArrayBuffer>` cast when the source might be `Float32Array<ArrayBufferLike>`.
- **Indirect draw buffer needs STORAGE | INDIRECT | COPY_DST** — compute shader writes instanceCount (STORAGE), render pass reads it (INDIRECT), CPU resets it each frame (COPY_DST).
- **Multi-pipeline ForwardPass shared bind group layout** — All primitive type shaders MUST declare identical bind group layouts (group 0: camera, transforms, visibleIndices, texIndices, renderMeta, primParams; group 1: tier0-tier3 texture arrays + sampler + ovf0-ovf3 overflow arrays). Unused bindings must still be declared.
- **SoA buffers parallel indexed** — All SoA buffers (transforms, bounds, texIndices, entityIds) must use the same entity index. Populated via retained `write_slot()` in Rust (or legacy `collect_gpu()`). Entity IDs are CPU-only (not uploaded to GPU).
- **PrimitiveParams split across two commands** — `SetPrimParams0` for f32[0..4], `SetPrimParams1` for f32[4..8], due to 16-byte ring buffer payload limit.
- **`SetParent` uses `0xFFFFFFFF` for unparent** — Special value meaning "remove parent". Same command type for parenting and unparenting.
- **Multi-tier textures require switch in WGSL** — WGSL cannot dynamically index texture bindings. Adding new tiers requires updating the shader `switch`.
- **AudioContext requires user gesture** — Browsers block creation/resumption without user gesture. `AudioManager` lazily creates context on first `load()` or `play()`.
- **Bloom and outlines are mutually exclusive** — Both write to `swapchain`, dead-culling `FXAATonemapPass`. `enableBloom()` disables outlines and vice versa. Console warning issued.
- **WebGPU can't be tested in headless browsers** — `requestAdapter()` returns null. Visual testing requires a real browser (`npm run dev` → Chrome).
- **`EntityHandle.data()` cleared on pool `init()`** — Recycled handles reset their data map. Plugins storing data via `.data(key, value)` must handle this.
- **Adding a new primitive type requires 3 steps** — (1) add WGSL shader, (2) register in `ForwardPass.SHADER_SOURCES[RenderPrimitiveType]`, (3) optionally extend `EntityHandle`. Types: 0=Quad, 1=Line, 2=SDFGlyph, 3=BezierPath, 4=Gradient, 5=BoxShadow.
- **`createImageBitmap` not available in Workers on all browsers** — Safari has partial support. `TextureManager` should only be instantiated where available.
- **Bezier control points in PrimParams are UV-space** — [0,1] range relative to entity's bounding quad. Entity position+scale define world-space bounding box.
- **GPU particles are NOT ECS entities** — Particles live in GPU storage buffers, rendered outside the RenderGraph. Avoids ring buffer saturation.
- **KTX2 files must have block-aligned dimensions** — BC7/ASTC 4x4 require width/height divisible by 4. Tier sizes (64-512) satisfy this.
- **Basis Universal WASM loaded lazily** — Only fetched on first KTX2 texture with BasisLZ/UASTC supercompression. Pre-compressed KTX2 (scheme=0) bypasses the transcoder entirely.
- **`KTX2File.close()` AND `.delete()` both required** — Missing `.delete()` leaks WASM heap memory.
- **Compressed texture tier growth needs standard WebGPU** — `copyTextureToTexture` for compressed formats is disallowed in compatibility mode. Falls back to rgba8unorm.
- **`tsc --noEmit` reports TS2307 for WASM imports** — `../wasm/hyperion_core.js` errors are expected when WASM isn't compiled. These are pre-existing and safe to ignore. Filter: `npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`.
- **`export { X } from './mod'` doesn't use a top-level import** — A re-export statement is self-contained. Adding `import { X } from './mod'` alongside it causes TS6133 (unused import). Use only the re-export.
- **macOS/Metal requires `textureSampleLevel` in non-fragment stages** — `textureSample` is fragment-only per spec. Metal enforces this strictly; Vulkan/Linux tolerates it. All WGSL shaders must use `textureSampleLevel(tex, sampler, uv, 0.0)` in vertex/compute stages.
- **Compressed textures cannot have RENDER_ATTACHMENT usage** — BC7/ASTC textures fail `createTexture` on Metal if `RENDER_ATTACHMENT` is included. Only use `TEXTURE_BINDING | COPY_DST`.
- **Orthographic near plane must be negative for z=0 entities** — WebGPU clip volume is z ∈ [0, w]. With `near=0.1`, entities at z=0 map to z_clip ≈ -0.0001, outside valid range. macOS/Metal clips strictly; Linux/Vulkan has guard bands. Default `near=-1` places the near plane behind z=0.
- **Mode A: main thread has no renderer** — `createParticleEmitter()` returns `null` (not throw). `renderer` stays `null` on main thread; rendering happens in Render Worker.
- **Mode A: main thread copies ALL SoA arrays** — `latestRenderState` copies transforms, bounds, renderMeta, texIndices, primParams, entityIds before transferring originals to Render Worker (which neuters them). SystemViews, immediate-mode patches, and plugin hooks all require this data.
- **GameLoop postTick/frameEnd see current-frame views** — `_systemViews` is re-read AFTER `tickFn()` for postTick/frameEnd hooks. preTick sees previous frame (captured before tickFn). Do not cache `_systemViews` once for all hook phases.
- **Snapshot binary uses `pod_read_unaligned`** — Snapshot byte buffers have no alignment guarantees. `bytemuck::from_bytes` panics on unaligned data; always use `pod_read_unaligned` for reading Pod types from snapshot data.
- **Bridge tick count is on `latestRenderState`** — Use `bridge.latestRenderState?.tickCount ?? 0`, NOT `bridge.tickCount()`. The bridge interface has no direct `tickCount()` method.
- **SpatialGrid cell size is world-space, not viewport-space** — `sqrt(worldArea / entityCount) * 2`. Viewport-space breaks with camera zoom. Grid rebuilds fully each frame (no incremental yet).
- **SpatialGrid `query()` returns aliased buffer** — The returned `indices` Int32Array is an internal buffer reused across calls. Copy with `.slice()` if you need to retain results.
- **Cull shader `enable subgroups;` must be prepended at pipeline creation** — The directive is NOT in `cull.wgsl`. Adding it would fail WGSL validation on non-subgroup devices. `prepareShaderSource()` handles this.
- **Subgroup `requestDevice` requires `'subgroups'` in `requiredFeatures`** — Detection via `detectSubgroupSupport()` checks `adapter.features`, but the feature must also be requested at device creation. Use retry-without fallback if request fails.
- **`subgroupBroadcastFirst` always broadcasts from thread 0** — In compute shaders, ALL invocations are active. `subgroupBroadcastFirst(x)` returns thread 0's value, NOT the first thread where `x != 0`. Use `subgroupElect()` to gate the writer so thread 0 is always the one with the result.
- **SpatialGrid `cellEntities` may realloc on oversized entities** — Default 4x buffer covers typical cases. Entities with radius >> cellSize can span O((r/cellSize)^2) cells, exceeding the buffer. The grid auto-reallocs but this breaks zero-alloc-per-frame for that one frame.
- **`flush_pending_despawns()` must be called before `collect_dirty_staging()`** — Despawns create stale slot references. The descending slot order in batch despawn is a correctness invariant (guarantees `last` is always live).
- **Scatter shader @group(1) must match CullPass read layout** — ScatterPass writes to the same SoA buffers CullPass reads. Both must agree on buffer names in ResourcePool.
- **Compressed transforms use format flag at staging[31]** — `0` = compressed 2D (pos+rot+scale, root entities), `1` = pre-computed mat4x4 (child entities). Scatter shader reconstructs mat4x4 from 6 f32 for format=0.
- **2-bucket cull: 12 indirect args entries** — 6 primitive types × 2 buckets (tier0 vs other). Indirect args buffer is 240 bytes. `firstInstance` encodes visible-indices region offset.
- **`process_commands` takes `&mut RenderState` as 4th parameter** — All callers (engine.rs, tests) must provide it. Dirty marking happens at command level, not system level.
- **`collect_gpu()` destroys retained slot mapping** — Never call `collect_gpu()` in the retained-slot path. It rebuilds SoA in hecs iteration order (arbitrary), overwriting `write_slot()` slot assignments. The update flow is: `mark_post_system_dirty()` → `collect()` → `collect_and_cache_dirty()`. `collect_gpu()` is legacy-only.
- **Systems bypass command_processor dirty marking** — `velocity_system`, `transform_system`, and `propagate_transforms` modify components directly. Call `mark_post_system_dirty()` after systems run to mark velocity-driven entities and children of dirty parents.
- **SoA length accessors use `gpu_count * stride`, not `vec.len()`** — Retained-slot Vecs grow via `assign_slot()` but never shrink (except `shrink_to_fit()`). `vec.len()` may include stale trailing data. All 6 WASM exports (`gpu_transforms_f32_len`, etc.) use `gpu_count * stride`.

### Implementation Notes — design decisions and internal details

- **Public types with parameterless `new()`** must also impl `Default` (Clippy `new_without_default`).
- **`wasm-pack --out-dir`** is relative to the crate directory, not the workspace root.
- **Frustum extraction lives in `camera.ts`** — `CullPass` imports `extractFrustumPlanes` from `camera.ts`.
- **Depth texture lazy recreation** — `ForwardPass.ensureDepthTexture()` recreates when canvas dimensions change. `resize()` invalidates dimension tracking.
- **No rendering fallback without WebGPU** — Engine runs ECS/WASM simulation but rendering is disabled (`renderer` stays `null`). Future: WebGL 2 fallback.
- **Retained-slot partial upload (Phase 12)** — DirtyTracker + stable slots + scatter shader replace full re-upload. Remaining future optimizations: double-buffering with `mapAsync`, CPU-side frustum pre-culling.
- **Texture2DArray maxTextureArrayLayers varies by device** — WebGPU spec guarantees minimum 256. Future: query `device.limits.maxTextureArrayLayers`.
- **TextureManager lazy allocation** — Growth: 0→16→32→64→128→256 layers per tier. `getTierView()` creates 1-layer placeholder for bind group validity.
- **ResourcePool buffer naming** — CullPass: reads `entity-transforms`/`entity-bounds`/`render-meta`, writes `visible-indices`/`indirect-args`. ForwardPass: reads those + `tex-indices`/`prim-params`, writes `scene-hdr`. Post-process passes read `scene-hdr`, write `swapchain`. Texture views: `tier0`-`tier3`, `ovf0`-`ovf3`, `scene-hdr`, `selection-seed`, `jfa-a`/`jfa-b`, `bloom-half`/`bloom-quarter`/`bloom-eighth`. Sampler: `texSampler`.
- **BackpressuredProducer wraps RingBufferProducer** — All bridge factories use it. `flush()` called at start of every `tick()`.
- **Worker heartbeat via ring buffer header** — Engine-worker increments atomic counter after each tick. `WorkerSupervisor` checks every 1s. Currently logs warnings only.
- **`Hyperion.fromParts()` vs `Hyperion.create()`** — `fromParts()` is the test factory; `create()` is production (capability detection + bridge + renderer init).
- **Plugin teardown order** — `pluginRegistry.destroyAll()` runs before bridge/renderer destroy. Plugins can still access engine resources during cleanup.
- **`GameLoop` first-frame sentinel** — `lastTime = -1` to detect first RAF callback, sets dt=0 to avoid massive first-frame spike.
- **`Children` 32-slot inline array + `OverflowChildren` heap fallback** — `Children.remove()` returns `bool`; if `false`, handler checks `OverflowChildren`. Empty overflow removed automatically.
- **Per-type indirect draw at offset `primType * 20`** — 6 consecutive `DrawIndirectArgs` (5 u32 each = 20 bytes).
- **JFA iteration count = ceil(log2(max(width, height)))** — ~11 for 1080p. Each iteration is a separate `JFAPass` node with unique resource name.
- **RenderGraph dead-pass culling** — `OutlineCompositePass` writing to `swapchain` culls `FXAATonemapPass`. Removing outline passes restores it.
- **MSDF text requires external atlas** — Generated by msdf-atlas-gen. Glyph UV rectangles passed via PrimitiveParams.
- **Immediate-mode patches both transforms and bounds** — `patchTransforms()` patches SoA column 3, `patchBounds()` patches bounds xyz (stride 4). Both called in `tick()`.
- **InputManager.resetFrame() called per tick** — Read `scrollDeltaX/Y` in `preTick` hooks, not `frameEnd`.
- **ExternalId is immutable** — Set once on SpawnEntity, never updated.
- **Duplicate Ray interface** — Defined in both `camera.ts` and `hit-tester.ts` with identical shape. Structural typing makes them interchangeable.
- **mat4Inverse uses general cofactor expansion** — Forward-compatible with perspective cameras. Returns `null` for singular matrices.
- **AudioManager.destroy() nullifies before await** — Prevents concurrent callers from touching dead objects during async teardown.
- **SoundRegistry uses bidirectional maps** — `urlToHandle` + `handleToUrl`. Both must stay in sync.
- **Audio listener is ring-buffer driven** — Camera position → WASM via `SetListenerPosition` → velocity derivation + extrapolation → read back via `GPURenderState.listenerX/Y/Z`.
- **`source.onended` auto-cleans finished playbacks** — Non-looping sounds automatically removed from active map.
- **`SetListenerPosition` uses entity_id=0 as sentinel** — Engine-level state, not entity-specific. WASM intercepts before entity lookup.
- **Plugin install returns cleanup function** — React useEffect pattern: `install(ctx)` may return `() => void`.
- **PluginRenderingAPI and PluginGpuAPI are null when headless** — Plugins must null-check before using GPU/rendering APIs.
- **PluginGpuAPI tracks resources** — `destroyTracked()` cleans up. Use `ctx.gpu` instead of raw `device`.
- **Shader hot-reload rebuilds entire render graph** — Not incremental. Acceptable for dev, not production.
- **EventBus emit iterates spread copy** — `once()` self-removal during emit is safe.
- **Bloom intermediate textures at 3 fixed mip levels** — bloom-half (1/2), bloom-quarter (1/4), bloom-eighth (1/8). All `rgba16float`. Recreate on resize.
- **Particle render uses `loadOp: 'load'`** — Drawn on top of scene. NOT affected by bloom or FXAA.
- **Particle spawnAccumulator preserves fractional spawns** — Raw `Math.floor(rate * dt)` loses ~40% at 60fps. Accumulator carries remainder across frames.
- **Overflow tiers are dev-mode only** — In production (all KTX2), overflow arrays never allocate. PNG/JPEG on compression-capable devices go to lazy rgba8unorm overflow tiers.
- **Packed texture index overflow flag** — bit 31 = overflow (0=primary compressed, 1=rgba8 overflow), bits 18-16 = tier (3 bits), bits 15-0 = layer. Backward compatible with old encoding.
- **KTX2 direct upload fast path** — When vkFormat matches device (e.g., BC7 file on BC7 device), no transcoder WASM loaded. Raw level data uploaded via `writeTexture`.
- **ResourcePool overflow views** — `ovf0`-`ovf3` registered alongside `tier0`-`tier3`. ForwardPass bind group reads all 9 texture views.
- **BasisTranscoder singleton race protection** — `initPromise` caches the entire init flow, not just the module load. Prevents concurrent `getInstance()` from double-initializing.
- **Mode A Render Worker has its own Camera** — `render-worker.ts` creates a separate `Camera` instance. Main-thread `CameraAPI` changes (zoom, position) do NOT propagate to Mode A rendering. Camera sync requires a message protocol (not yet implemented).
- **Recording tap fires on both direct writes and queued flushes** — `BackpressuredProducer.setRecordingTap()` captures the complete command stream regardless of whether commands were written directly or queued due to backpressure.
- **CommandTapeRecorder circular buffer** — Uses modular indexing with configurable `maxEntries` (default 600000 = ~10min at 60fps × 1000 cmds/tick). Oldest entries silently evicted.
- **SnapshotManager interval-based capture** — Captures at tick multiples of `intervalTicks`. `findNearest(targetTick)` returns closest snapshot at or before target for gap replay.
- **Snapshot binary format** — `[magic "HSNP"][version:u32][tick:u64][entity_count:u32][entity_map][per-entity: ext_id:u32 + component_mask:u16 + component data]`. 15 component types in bitmask.
- **`createHotSystem` schema evolution** — `{ ...initialState(), ...savedState }` merge: new fields get defaults, removed fields silently dropped. No migration code needed.
- **`Hyperion.debug` API** — `isRecording`, `startRecording(config?)`, `stopRecording(): CommandTape`. Zero overhead when not recording (null tap).
- **Demo reporter resets on tab re-entry** — `switchSection()` calls `reporter.reset()` when re-entering a cached section. All reporter methods (`check`/`skip`/`pending`) deduplicate by name.
- **Demo audio uses `sfx/click.wav`** — A minimal 0.1s 440Hz WAV file in `ts/public/sfx/`. Not `.ogg`.
- **SIMD128 activated via `.cargo/config.toml`** — `[target.wasm32-unknown-unknown] rustflags = ["-C", "target-feature=+simd128"]`. Only affects wasm32 target, native tests unaffected. glam auto-detects and emits v128 ops.
- **wasm-opt runs twice** — wasm-pack runs wasm-opt internally in release mode. `build:wasm:opt` runs it again with `--strip-debug --enable-simd`. The second pass has marginal effect (±1% size).
- **SpatialGrid hash uses `Math.imul`** — `(Math.imul(ix, 92837111) ^ Math.imul(iy, 689287499)) & cellMask`. Standard idiom for int32 hash in JS. Power-of-2 mask for fast modulo.
- **SpatialGrid 3-pass rebuild** — Count entries per cell → exclusive prefix sum → scatter entity indices. `cellEntities` reallocs on overflow (pathological case only).
- **Stable slot mapping uses `entity_to_slot: Vec<u32>`** — Indexed by `entity.id()`, `u32::MAX` sentinel for unassigned. Power-of-two growth for `slot_to_entity`.
- **Batch despawn processes in descending slot order** — `despawn_slots.sort_unstable_by(|a, b| b.cmp(a))`. This guarantees the "last" entity being swapped is always live.
- **DirtyTracker 3 BitSets: transforms, bounds, meta** — Union of all 3 determines scatter upload set. Individual BitSets kept for profiling.
- **Scatter staging buffer: 32 u32 per entity (128 bytes)** — Cache-line aligned. Layout: transforms[16] + bounds[4] + meta[2] + tex[1] + params[8] + format[1].
- **ScatterPass grow-only buffers** — Staging and indices GPU buffers never shrink. Destroyed and recreated only when larger size needed.
- **`mark_post_system_dirty()` two-pass approach** — Pass 1: entities with non-zero `Velocity` get transform+bounds dirty. Pass 2: children whose parent's transform is dirty get transform+bounds dirty. Single-level propagation matches `propagate_transforms` (which is also single-level).
- **Batch spawn auto-detection in `process_commands`** — Consecutive `SpawnEntity` commands are batched via `hecs::World::spawn_batch()`. Threshold: 2+ consecutive.
- **TexturePriorityQueue is standalone** — Min-heap with `urlToIndex` map for O(log n) update. Integrated into TextureManager alongside FIFO `fetchQueue`.
- **Progressive KTX2 is a TODO** — Priority queue is implemented; HTTP Range-based progressive loading deferred to future work.
- **Cull shader override constants** — `USE_SUBGROUPS` and `SUBGROUP_SIZE` are pipeline-overridable. `if (USE_SUBGROUPS)` is compile-time branching (dead code eliminated). `subgroupElect()` + `subgroupBroadcastFirst()` ensure atomic-doer and broadcast source match.
- **Ring buffer benchmark confirms 22% peak utilization** — At 10k entities / 100% movement / 1MB buffer. Transport layer is not the bottleneck.

## Conventions

- All ECS components are `#[repr(C)]` with `bytemuck::Pod` + `Zeroable` for GPU-uploadable memory layout.
- Rust tests are inline `#[cfg(test)] mod tests` in each source file. TypeScript tests are `*.test.ts` colocated in `ts/src/`.
- `CommandType` enum values must stay synchronized between Rust (`ring_buffer.rs`) and TypeScript (`ring-buffer.ts`).
- Little-endian byte order everywhere for cross-architecture safety (ring buffer uses `DataView` on TS side).
- WASM singletons (`static mut ENGINE/RING_BUFFER`) are safe because wasm32 is single-threaded; every `unsafe` block has a SAFETY comment.
- Vite dev server must serve COOP/COEP headers for SharedArrayBuffer access (`vite.config.ts`).
- WGSL shaders live in `ts/src/shaders/`, loaded at dev time via Vite `?raw` imports.

## Implementation Status

**Current: Phase 12 (Optimization Tier 2) complete. Next: Phase 13 per masterplan.**

| Phase | Name | Key Additions |
|-------|------|---------------|
| 0–3 | Core + GPU Pipeline | ECS/WASM, ring buffer, fixed timestep, compute culling, indirect draw |
| 4.5 | Stabilization | Scene graph, BackpressuredProducer, WorkerSupervisor, EntityHandlePool |
| 5.5 | Rendering Primitives | 6 primitive types (quad/line/MSDF/bezier/gradient/box-shadow), FXAA+tonemap, JFA outlines |
| 6 | Input System | InputManager, CPU ray-sphere picking, ImmediateState, ExternalId |
| 7 | Audio System | SoundRegistry + PlaybackEngine + AudioManager, 2D spatial audio, branded types |
| 7.5 | Stability Bugfix | OverflowChildren, patchBounds, ring-buffer-driven audio listener |
| 8 | Polish & DX | Plugin System v2 (PluginContext + 5 APIs), EventBus, shader HMR, profiler overlay |
| 9 | Advanced 2D | Bézier SDF curves, Dual Kawase bloom, GPU particle system |
| 10 | Asset Pipeline | KTX2/Basis Universal compressed textures (BC7/ASTC), overflow tiers, `compressionFormat` API |
| 10a-DX | DX Foundations | SystemViews, debug camera, ECS inspector (TLV + panel), WASM debug exports (`dev-tools` feature) |
| 10b-DX | DX Features | Prefabs (PrefabRegistry/Instance), build-time Asset Pipeline (Vite plugin), bounds visualizer, PRIM_PARAMS_SCHEMA |
| 10c-DX | Time-Travel Debug | CommandTapeRecorder, ReplayPlayer, SnapshotManager (`engine_reset/snapshot_create/snapshot_restore`), `createHotSystem` HMR helper, `Hyperion.debug` API |
| — | Verification Harness | 8-tab demo covering 40+ checks across all engine features, JSON report export |
| 11 | Optimization Tier 1 | SIMD128 activation, wasm-opt build pipeline, SpatialGrid broadphase, ring buffer profiling, WebGPU subgroup compute path |
| 12 | Optimization Tier 2 | GPU scatter upload (DirtyTracker + stable slots + swap-remove), compressed 2D transforms, 2-bucket material sort, batch spawn, texture priority queue |

## Documentation

- `PROJECT_ARCHITECTURE.md` — Deep technical architecture doc. Reference for onboarding and implementation decisions.
- `docs/plans/hyperion-engine-design-v3.md` — Full vision design doc v3 (all phases). Reference for future phase implementation.
- `docs/plans/hyperion-engine-roadmap-unified-v3.md` — Unified roadmap v3. Phase-by-phase feature breakdown.
- `docs/deployment-guide.md` — Deployment guide for 7 platforms with COOP/COEP headers and WASM caching.
- `docs/plans/` — Completed phase plans (0-1, 3, 4.5, 5.5, 6, 7, 7.5, 9, 10, 10c, 11). Historical reference for implementation decisions.
- `hyperion-masterplan.md` — Authoritative high-level reference for all phases (0-20+). Optimization strategy in §17.
