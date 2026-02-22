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
cargo test -p hyperion-core                  # All Rust unit tests (99 tests)
cargo clippy -p hyperion-core                # Lint check (treat warnings as errors)
cargo build -p hyperion-core                 # Build crate (native, not WASM)
cargo doc -p hyperion-core --open            # Generate and open API docs

# Run specific test groups
cargo test -p hyperion-core ring_buffer      # Ring buffer tests only (19 tests)
cargo test -p hyperion-core engine           # Engine tests only (9 tests)
cargo test -p hyperion-core render_state     # Render state tests only (27 tests)
cargo test -p hyperion-core command_proc     # Command processor tests only (15 tests)
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

# After building, check generated TypeScript types
cat ts/wasm/hyperion_core.d.ts
```

### TypeScript

```bash
cd ts && npm test                            # All vitest tests (409 tests)
cd ts && npm run test:watch                  # Watch mode (re-runs on file change)
cd ts && npx tsc --noEmit                    # Type-check only (no output files)
cd ts && npm run build                       # Production build (tsc + vite build)
cd ts && npm run dev                         # Vite dev server with COOP/COEP headers

# Run specific test files
cd ts && npx vitest run src/ring-buffer.test.ts               # Ring buffer producer (17 tests)
cd ts && npx vitest run src/ring-buffer-utils.test.ts         # extractUnread helper (4 tests)
cd ts && npx vitest run src/camera.test.ts                    # Camera math + frustum + ray (19 tests)
cd ts && npx vitest run src/capabilities.test.ts              # Capability detection (4 tests)
cd ts && npx vitest run src/integration.test.ts               # E2E integration (5 tests)
cd ts && npx vitest run src/frustum.test.ts                   # Frustum culling accuracy (7 tests)
cd ts && npx vitest run src/texture-manager.test.ts           # Texture manager (16 tests)
cd ts && npx vitest run src/backpressure.test.ts              # Backpressure queue + producer (18 tests)
cd ts && npx vitest run src/supervisor.test.ts                # Worker supervisor (5 tests)
cd ts && npx vitest run src/render/render-pass.test.ts        # RenderPass + ResourcePool (6 tests)
cd ts && npx vitest run src/render/render-graph.test.ts       # RenderGraph DAG (8 tests)
cd ts && npx vitest run src/render/passes/cull-pass.test.ts   # CullPass extraction (2 tests)
cd ts && npx vitest run src/render/passes/forward-pass.test.ts # ForwardPass multi-pipeline (2 tests)
cd ts && npx vitest run src/render/passes/fxaa-tonemap-pass.test.ts  # FXAATonemapPass (3 tests)
cd ts && npx vitest run src/render/passes/selection-seed-pass.test.ts # SelectionSeedPass (3 tests)
cd ts && npx vitest run src/render/passes/jfa-pass.test.ts    # JFA pass iterations (9 tests)
cd ts && npx vitest run src/render/passes/outline-composite-pass.test.ts # OutlineComposite (6 tests)
cd ts && npx vitest run src/render/passes/prefix-sum.test.ts  # Blelloch prefix sum (6 tests)
cd ts && npx vitest run src/hyperion.test.ts                  # Hyperion facade (55 tests)
cd ts && npx vitest run src/entity-handle.test.ts             # EntityHandle fluent API (28 tests)
cd ts && npx vitest run src/entity-pool.test.ts               # EntityHandle pool recycling (5 tests)
cd ts && npx vitest run src/game-loop.test.ts                 # GameLoop RAF lifecycle (11 tests)
cd ts && npx vitest run src/raw-api.test.ts                   # RawAPI numeric interface (4 tests)
cd ts && npx vitest run src/camera-api.test.ts                # CameraAPI zoom (3 tests)
cd ts && npx vitest run src/plugin.test.ts                    # PluginRegistry + dependency resolution (13 tests)
cd ts && npx vitest run src/leak-detector.test.ts             # LeakDetector backstop (2 tests)
cd ts && npx vitest run src/types.test.ts                     # Config types + defaults (4 tests)
cd ts && npx vitest run src/selection.test.ts                 # SelectionManager (10 tests)
cd ts && npx vitest run src/input-manager.test.ts             # InputManager keyboard+pointer+callbacks (24 tests)
cd ts && npx vitest run src/hit-tester.test.ts                # CPU ray-sphere hit testing (8 tests)
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
| `lib.rs` | WASM exports: `engine_init`, `engine_attach_ring_buffer`, `engine_update`, `engine_tick_count`, `engine_gpu_data_ptr/f32_len/entity_count`, `engine_gpu_tex_indices_ptr/len`, `engine_gpu_entity_ids_ptr/len`, `engine_compact_entity_map`, `engine_compact_render_state`, `engine_entity_map_capacity`, `engine_listener_x/y/z` |
| `engine.rs` | `Engine` struct with fixed-timestep accumulator, ties together ECS + commands + systems. Wires `propagate_transforms` for scene graph hierarchy. Listener position state with velocity derivation and extrapolation |
| `command_processor.rs` | `EntityMap` (external ID ↔ hecs Entity with free-list recycling, `shrink_to_fit()`, `iter_mapped()`) + `process_commands` (including `SetParent` with parent/child bookkeeping) |
| `ring_buffer.rs` | SPSC consumer with atomic read/write heads, `CommandType` enum (14 variants incl. `SetParent`, `SetPrimParams0`, `SetPrimParams1`, `SetListenerPosition`), `Command` struct |
| `components.rs` | `Position(Vec3)`, `Rotation(Quat)`, `Scale(Vec3)`, `Velocity(Vec3)`, `ModelMatrix([f32;16])`, `BoundingRadius(f32)`, `TextureLayerIndex(u32)`, `MeshHandle(u32)`, `RenderPrimitive(u32)`, `PrimitiveParams([f32;8])`, `ExternalId(u32)`, `Active`, `Parent(u32)`, `Children` (fixed 32-slot inline array), `LocalMatrix([f32;16])` — all `#[repr(C)]` Pod. `OverflowChildren(Vec<u32>)` — heap fallback for 33+ children, NOT `#[repr(C)]`/Pod |
| `systems.rs` | `velocity_system`, `transform_system`, `count_active`, `propagate_transforms` (scene graph hierarchy) |
| `render_state.rs` | `collect()` for legacy matrices, `collect_gpu()` for SoA GPU buffers (transforms/bounds/renderMeta/texIndices/primParams/entityIds) + `BitSet`/`DirtyTracker` for partial upload optimization + `shrink_to_fit()` for memory compaction |

### TypeScript: ts/src/

| Module | Role |
|---|---|
| `hyperion.ts` | `Hyperion` class — public API facade with `create()`, `spawn()`, `batch()`, `start/pause/resume/destroy`, `use()/unuse()`, `addHook/removeHook`, `loadTexture/loadTextures`, `compact()`, `resize()`, `selection`, `enableOutlines()/disableOutlines()`, `enablePostProcessing()`, `input` (InputManager), `picking` (hitTest API), `audio` (AudioManager), `enableProfiler(config?)`/`disableProfiler()` (DOM profiler overlay via postTick hook), `recompileShader(passName, shaderCode)` (delegates to renderer), `EventBus` for inter-plugin communication, immediate-mode transform + bounds patching, ring-buffer-driven audio listener. `fromParts()` test factory |
| `entity-handle.ts` | `EntityHandle` — fluent builder over `BackpressuredProducer` with `.position/.velocity/.rotation/.scale/.texture/.mesh/.primitive/.parent/.unparent/.line/.gradient/.boxShadow/.data/.positionImmediate/.clearImmediate`. `RenderPrimitiveType` enum. Implements `Disposable` |
| `entity-pool.ts` | `EntityHandlePool` — object pool (cap 1024) for EntityHandle recycling via `init()` |
| `game-loop.ts` | `GameLoop` — RAF lifecycle with preTick/postTick/frameEnd hook phases, FPS tracking, `frameDt`/`frameTimeAvg`/`frameTimeMax` getters for frame time tracking |
| `camera-api.ts` | `CameraAPI` — wrapper around Camera with zoom support (clamped to min 0.01), `x`/`y` position getters for audio listener tracking |
| `raw-api.ts` | `RawAPI` — low-level numeric ID entity management bypassing EntityHandle overhead |
| `plugin.ts` | `HyperionPlugin` interface (upgraded: `install(ctx: PluginContext): PluginCleanup \| void`, `version`, `dependencies?`) + `PluginRegistry` — dependency resolution, error boundaries (install catches + wraps, cleanup catches + warns), `destroyAll()` for shutdown |
| `types.ts` | Core types: `HyperionConfig`, `ResolvedConfig`, `HyperionStats` (with `frameDt`/`frameTimeAvg`/`frameTimeMax`), `MemoryStats` (with `entityMapUtilization`), `CompactOptions`, `TextureHandle` |
| `leak-detector.ts` | `LeakDetector` — `FinalizationRegistry` backstop for undisposed EntityHandles |
| `index.ts` | Barrel export for public API surface |
| `capabilities.ts` | Detects browser features, selects ExecutionMode A/B/C |
| `ring-buffer.ts` | `RingBufferProducer` — serializes commands into SharedArrayBuffer with Atomics |
| `worker-bridge.ts` | `EngineBridge` interface — `createWorkerBridge()` (Modes A/B) or `createDirectBridge()` (Mode C). Uses `BackpressuredProducer` for command buffering and `WorkerSupervisor` for heartbeat monitoring (Modes A/B). `GPURenderState` includes `entityIds: Uint32Array` and `listenerX/Y/Z: number` |
| `engine-worker.ts` | Web Worker that loads WASM, calls `engine_init`/`engine_update` per frame. Increments heartbeat counter after each tick for supervisor monitoring |
| `main.ts` | Entry point: uses Hyperion public API (`Hyperion.create()`, `spawn()`, `start()`). Demonstrates click-to-select with spatial audio, WASD camera, scroll-zoom |
| `renderer.ts` | RenderGraph-based coordinator: creates shared GPU buffers in `ResourcePool`, wires `CullPass` + `ForwardPass` + `FXAATonemapPass`, delegates rendering via `graph.render()`. Accepts SoA `GPURenderState`. Multi-primitive pipeline with per-type shaders. Optional JFA selection outline pipeline (`SelectionSeedPass` → `JFAPass×N` → `OutlineCompositePass`). `SelectionManager` integration + `enableOutlines`/`disableOutlines` API. `recompileShader(passName, shaderCode)` updates static shader sources then `rebuildGraph()`. Vite HMR wiring: `import.meta.hot.accept()` for all 10 WGSL files. `onDeviceLost` callback + `device.lost` listener |
| `texture-manager.ts` | `TextureManager` — multi-tier Texture2DArray with lazy allocation + exponential growth (0→16→32→64→128→256 layers), `createImageBitmap` loading pipeline, concurrency limiter. Added `retainBitmaps` option for device-lost recovery |
| `camera.ts` | Orthographic camera, `extractFrustumPlanes()`, `isSphereInFrustum()`, `mat4Inverse()`, `screenToRay()` (pixel → world-space `Ray`). Forward-compatible with perspective cameras |
| `render-worker.ts` | Mode A render worker: OffscreenCanvas + `createRenderer()`. Converts ArrayBuffer render state to typed arrays for `GPURenderState` |
| `backpressure.ts` | `PrioritizedCommandQueue` + `BackpressuredProducer` — priority-based command queuing with automatic overflow handling. `BackpressuredProducer` wraps `RingBufferProducer` with convenience methods (spawnEntity, setPosition, setListenerPosition, etc.) |
| `supervisor.ts` | `WorkerSupervisor` — Worker heartbeat monitoring + timeout detection with configurable intervals |
| `render/render-pass.ts` | `RenderPass` interface + `FrameState` type — modular rendering pipeline abstraction with reads/writes resource declarations |
| `render/resource-pool.ts` | `ResourcePool` — named registry for GPU resources (GPUBuffer, GPUTexture, GPUTextureView, GPUSampler) |
| `render/render-graph.ts` | `RenderGraph` — DAG-based pass scheduling with Kahn's topological sort + dead-pass culling |
| `render/passes/cull-pass.ts` | `CullPass` — GPU frustum culling compute pass with per-primitive-type grouping (6 types). `prepare()` uploads frustum planes + resets 6 × DrawIndirectArgs. `execute()` dispatches compute workgroups |
| `render/passes/forward-pass.ts` | `ForwardPass` — Multi-pipeline forward pass. `SHADER_SOURCES: Record<number, string>` maps primitive type → WGSL source. Per-type `drawIndexedIndirect` at offset `primType * 20`. Shared bind group layout (camera, transforms, visibleIndices, texIndices, renderMeta, primParams). Renders to `scene-hdr` |
| `render/passes/fxaa-tonemap-pass.ts` | `FXAATonemapPass` — Full-screen triangle post-process. Reads `scene-hdr`, writes `swapchain`. Configurable tonemap mode (none/PBR-neutral/ACES). Optional pass |
| `render/passes/selection-seed-pass.ts` | `SelectionSeedPass` — Renders selected entities as JFA seeds. Reads `selection-mask` buffer, writes `selection-seed` texture. Optional pass |
| `render/passes/jfa-pass.ts` | `JFAPass` — Single JFA iteration. Ping-pong between textures. Constructor takes iteration index, `iterationsForDimension()` helper. Each iteration has unique resource name (`jfa-iter-N`). Optional pass |
| `render/passes/outline-composite-pass.ts` | `OutlineCompositePass` — Reads `scene-hdr` + JFA result, writes `swapchain`. SDF distance outline with configurable color/width. Includes built-in FXAA. Dead-pass culls `FXAATonemapPass` when active |
| `render/passes/prefix-sum-reference.ts` | `exclusiveScanCPU()` — CPU reference implementation of Blelloch exclusive scan |
| `input-manager.ts` | `InputManager` — keyboard (`isKeyDown`), pointer (`pointerX/Y`, `isButtonDown`), scroll (`scrollDeltaX/Y`) state tracking + callback registration (`onKey`/`onClick`/`onPointerMove`/`onScroll` with unsubscribe). DOM `attach`/`detach`/`destroy` lifecycle |
| `hit-tester.ts` | `hitTestRay()` — CPU ray-sphere intersection against SoA bounds buffer. Returns closest hit entityId (smallest positive t) or null. `Ray` interface. 2.5D/3D-ready |
| `immediate-state.ts` | `ImmediateState` — Shadow position map (`Map<entityId, [x,y,z]>`) for zero-latency rendering. `patchTransforms()` patches SoA transform column 3 before GPU upload. `patchBounds()` patches SoA bounds xyz (stride 4, preserves radius) for consistent picking |
| `selection.ts` | `SelectionManager` — CPU-side `Set<number>` with dirty tracking + GPU mask upload. `select()/deselect()/toggle()/clear()`, `uploadMask()` |
| `audio-types.ts` | Branded types `SoundHandle`, `PlaybackId` (zero runtime overhead), `PlaybackOptions`, `SpatialConfig` interfaces, `DEFAULT_PLAYBACK_OPTIONS`, `DEFAULT_SPATIAL_CONFIG` |
| `sound-registry.ts` | `SoundRegistry` — URL-deduplicated audio buffer management with DI (`AudioDecoder`, `AudioFetcher`). `load()`/`loadAll()`/`unload()`/`destroy()`. O(1) bidirectional handle↔URL mapping |
| `playback-engine.ts` | `PlaybackEngine` — Web Audio node graph (`source → gain → panner → masterGain → destination`). `play()`/`stop()`/`setVolume()`/`setPitch()`/`setSoundPosition()`/`setListenerPosition()`. 2D spatial: `pan = clamp(dx/panSpread, -1, 1)`, distance attenuation `gain = baseVolume / (1 + distance/rolloff)`. Spatial updates use `setTargetAtTime` smoothing (15ms TAU) to avoid zipper artifacts. Master volume + mute/unmute |
| `audio-manager.ts` | `AudioManager` — Public facade wrapping `SoundRegistry` + `PlaybackEngine`. Lazy `AudioContext` init (respects browser autoplay policy). All control methods are safe no-ops before init (optional chaining). `suspend()`/`resume()`/`destroy()` lifecycle. Configurable `SpatialConfig` |
| `event-bus.ts` | `EventBus` — simple typed pub/sub (`on`/`off`/`once`/`emit`/`destroy`). Shared between PluginContexts for inter-plugin communication |
| `plugin-context.ts` | `PluginContext` — passed to `plugin.install()` with 5 sub-APIs: `systems` (hook registration), `events` (EventBus delegate), `rendering` (RenderGraph pass management, null when headless), `gpu` (tracked GPUBuffer/GPUTexture creation, null when headless), `storage` (entity side-tables via `Map<number, T>`) |
| `profiler.ts` | `ProfilerOverlay` — DOM-based performance stats display. `show(canvas)`/`hide()`/`update(stats)`/`destroy()`. Configurable position (4 corners). `pointerEvents: none` overlay with monospace green-on-black styling |
| `plugins/fps-counter.ts` | `fpsCounterPlugin()` — Example plugin factory. Uses `PluginSystemsAPI.addPostTick` + `PluginEventAPI.emit('fps-counter:update')`. Returns cleanup function |
| `text/font-atlas.ts` | `FontAtlas` + `GlyphMetrics` types, `parseFontAtlas()`, `loadFontAtlas()` for MSDF atlas JSON loading |
| `text/text-layout.ts` | `layoutText()` — Positions glyphs using atlas metrics, returns `LayoutGlyph[]` |
| `text/text-manager.ts` | `TextManager` — Loads and caches font atlases for MSDF text rendering |
| `shaders/basic.wgsl` | Quad render shader with SoA `transforms: array<mat4x4f>`, visibility indirection, renderMeta + primParams bindings, multi-tier Texture2DArray sampling |
| `shaders/line.wgsl` | Line render shader with screen-space quad expansion from primParams, SDF dash pattern, anti-aliased edges |
| `shaders/gradient.wgsl` | 2-stop gradient shader (linear, radial, conic). PrimParams: type, angle, stop positions + colors |
| `shaders/box-shadow.wgsl` | SDF box shadow shader (Evan Wallace erf approximation). PrimParams: rect size, corner radius, blur, color |
| `shaders/msdf-text.wgsl` | MSDF text shader with median(r,g,b) signed distance + screen-pixel-range anti-aliasing |
| `shaders/fxaa-tonemap.wgsl` | Combined FXAA (Lottes) + PBR Neutral/ACES tonemapping post-process |
| `shaders/selection-seed.wgsl` | Selection seed pass: renders selected entity pixels with UV-encoded seed positions for JFA |
| `shaders/jfa.wgsl` | Jump Flood Algorithm iteration: samples 9 neighbors at ±step, propagates nearest seed |
| `shaders/outline-composite.wgsl` | Outline composite: SDF distance outline from JFA result + scene, built-in FXAA |
| `shaders/cull.wgsl` | WGSL compute shader: sphere-frustum culling with per-primitive-type grouping, 6 DrawIndirectArgs, SoA bindings |
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
- **SoA buffers parallel indexed** — All SoA buffers (transforms, bounds, texIndices, entityIds) must be indexed by the same entity index. All are populated in the same `collect_gpu()` loop in Rust, ensuring alignment. The `ResourcePool` stores them under `entity-transforms`, `entity-bounds`, `tex-indices`. Entity IDs are CPU-only (used for picking/immediate-mode, not uploaded to GPU).
- **ResourcePool buffer naming convention** — CullPass reads `entity-transforms` + `entity-bounds` + `render-meta`, writes `visible-indices` + `indirect-args`. ForwardPass reads `entity-transforms` + `visible-indices` + `tex-indices` + `indirect-args` + `render-meta` + `prim-params`, writes `scene-hdr`. FXAATonemapPass reads `scene-hdr`, writes `swapchain`. Texture views: `tier0`-`tier3`, `scene-hdr`, `selection-seed`, `jfa-a`/`jfa-b`. Sampler: `texSampler`. Swapchain view: `swapchain` (set per-frame by coordinator).
- **BackpressuredProducer wraps RingBufferProducer** — All three bridge factories (`createWorkerBridge`, `createFullIsolationBridge`, `createDirectBridge`) use `BackpressuredProducer` instead of raw `RingBufferProducer`. `flush()` is called at the start of every `tick()`.
- **Worker heartbeat via ring buffer header** — Engine-worker increments `Atomics.add(header, HEARTBEAT_W1_OFFSET, 1)` after each tick. `WorkerSupervisor` checks heartbeat counters every 1s via `setInterval`. Currently logs warnings only; escalation is TODO(Phase 5).
- **`EntityHandle.data()` cleared on `init()`** — When EntityHandles are recycled from the pool, `init()` resets the data map. Plugins that store data via `.data(key, value)` must handle the case where data disappears after pool reuse.
- **`Hyperion.fromParts()` vs `Hyperion.create()`** — `fromParts()` is the test factory that accepts pre-built components (bridge, renderer, etc.) for unit testing without real WASM/WebGPU. `create()` is the production factory that performs capability detection, bridge creation, and renderer initialization.
- **Plugin teardown order** — `pluginRegistry.destroyAll()` runs before bridge/renderer destroy in `Hyperion.destroy()`. This ensures plugins can still access engine resources during their cleanup phase.
- **`GameLoop` first-frame sentinel** — `GameLoop` uses `lastTime = -1` sentinel to detect the first RAF callback and set dt=0, avoiding a massive first-frame dt spike (which would be `performance.now()` milliseconds).
- **Scene graph `SetParent` uses `0xFFFFFFFF` for unparent** — The `SetParent` command payload is a `u32` parent entity ID. The special value `0xFFFFFFFF` means "remove parent" (unparent). This allows the same command type for both parenting and unparenting.
- **`Children` component uses fixed 32-slot inline array with `OverflowChildren` heap fallback** — No heap allocation for child lists up to 32. When the 33rd child is added, an `OverflowChildren(Vec<u32>)` component is attached as a heap-backed fallback. `Children.remove()` returns `bool`; if `false`, the `SetParent` handler checks `OverflowChildren`. Empty `OverflowChildren` is removed automatically.
- **Multi-pipeline ForwardPass shared bind group layout** — All primitive type shaders (quad, line, MSDF, gradient, box shadow) MUST declare identical bind group layouts (group 0: camera, transforms, visibleIndices, texIndices, renderMeta, primParams; group 1: tier0-tier3 texture arrays + sampler). Unused bindings must still be declared for bind group compatibility when switching pipelines within the same render pass.
- **ForwardPass.SHADER_SOURCES keyed by RenderPrimitiveType** — `Record<number, string>` where keys are `RenderPrimitiveType` values (0=Quad, 1=Line, 2=SDFGlyph, 4=Gradient, 5=BoxShadow). Type 3 (BezierPath) is reserved but not yet implemented. Adding a new primitive type requires: (1) add WGSL shader, (2) register in `ForwardPass.SHADER_SOURCES`, (3) optionally extend `EntityHandle` with a convenience method.
- **Per-type indirect draw at offset `primType * 20`** — CullPass writes 6 consecutive `DrawIndirectArgs` (5 u32 each = 20 bytes). ForwardPass issues `drawIndexedIndirect(buffer, primType * 20)` for each registered type.
- **JFA iteration count = ceil(log₂(max(width, height)))** — For 1080p, ~11 iterations. Each iteration is a separate `JFAPass` node in the RenderGraph with a unique resource name (`jfa-iter-N`). The renderer maps these logical resources to two physical ping-pong textures in the ResourcePool.
- **RenderGraph dead-pass culling enables pipeline switching** — When outlines are enabled, `OutlineCompositePass` writes to `swapchain`, which dead-pass culls `FXAATonemapPass`. When outlines are disabled, the outline passes are removed from the graph and `FXAATonemapPass` is restored automatically.
- **PrimitiveParams is 8 floats per entity** — Split across two ring buffer commands (`SetPrimParams0` for f32[0..4], `SetPrimParams1` for f32[4..8]) due to the 16-byte payload limit of the ring buffer protocol.
- **MSDF text requires external atlas** — `loadFontAtlas(jsonUrl, textureUrl)` loads msdf-atlas-gen JSON metadata + texture. The atlas must be generated externally using msdf-atlas-gen. Glyph UV rectangles are passed via PrimitiveParams.
- **Immediate-mode patches both transforms and bounds** — `ImmediateState.patchTransforms()` patches SoA transform column 3, and `patchBounds()` patches SoA bounds xyz (stride 4, preserving radius). Both are called in `Hyperion.tick()`. Picking during immediate-mode drag now uses the patched position, not the WASM-reported position (1-2 frame stale).
- **InputManager.resetFrame() called per tick** — Scroll deltas accumulate within a frame and reset at the end of each tick. Read `scrollDeltaX/Y` in `preTick` hooks, not `frameEnd`.
- **ExternalId is immutable** — Set once on SpawnEntity, never updated. If entity recycling via free list changes the external ID, a new ExternalId is spawned with the new entity.
- **Duplicate Ray interface** — `Ray` is defined in both `camera.ts` and `hit-tester.ts` with identical shape `{ origin: [n,n,n], direction: [n,n,n] }`. TypeScript structural typing makes them interchangeable. Future: consolidate to single definition.
- **mat4Inverse uses general cofactor expansion** — NOT an orthographic-specific shortcut. ~50 lines but forward-compatible with perspective cameras. Returns `null` for singular matrices.
- **AudioContext requires user gesture** — Browsers block `AudioContext` creation/resumption without a user gesture. `AudioManager` lazily creates the context on first `load()` or `play()`, which is typically triggered by a click. If audio doesn't play, ensure the first audio call happens inside a user-initiated event handler.
- **AudioManager.destroy() nullifies before await** — `destroy()` nullifies `ctx`/`engine`/`registry` references before `await ctx.close()` to prevent concurrent callers from touching dead objects during the async teardown.
- **StereoPannerNode browser support** — `StereoPannerNode` is supported in all modern browsers (Chrome 42+, Firefox 52+, Safari 14.1+). Older Safari versions may need a polyfill.
- **SoundRegistry uses bidirectional maps** — `urlToHandle` + `handleToUrl` for O(1) both directions. Both maps must stay in sync during `load()`/`unload()`/`destroy()`.
- **PlaybackEngine accepts optional SpatialConfig** — Constructor takes `(ctx: AudioContext, spatial?: SpatialConfig)`. `AudioManager` forwards its merged config. Default: `panSpread=20, rolloff=10, maxDistance=100`.
- **Audio listener is ring-buffer driven with WASM extrapolation** — In `Hyperion.tick()`, camera position is sent to WASM via `SetListenerPosition` ring buffer command. WASM derives velocity from position delta and extrapolates during fixed ticks. The extrapolated position is read back from `GPURenderState.listenerX/Y/Z` and forwarded to `PlaybackEngine.setListenerPosition()`. This keeps spatial audio in sync with the WASM simulation clock, not the JS render clock.
- **`source.onended` auto-cleans finished playbacks** — `PlaybackEngine` registers an `onended` handler on each `AudioBufferSourceNode` that calls `cleanup()`. Non-looping sounds are automatically removed from the active map when they finish. No explicit `stop()` needed for fire-and-forget sounds.
- **`SetListenerPosition` uses entity_id=0 as sentinel** — The `SetListenerPosition` command (discriminant 13) carries 12-byte payload (x, y, z as f32). The entity_id field is always 0 because this is engine-level state, not entity-specific. WASM intercepts it in `process_commands()` before entity lookup.
- **Plugin install returns cleanup function (not property)** — React useEffect pattern: `install(ctx)` may return `() => void`. PluginRegistry stores and calls it on uninstall/destroyAll.
- **PluginRenderingAPI and PluginGpuAPI are null when headless** — When `renderer` is null (no WebGPU), `ctx.rendering` and `ctx.gpu` are null. Plugins must null-check before using GPU/rendering APIs.
- **PluginGpuAPI tracks resources** — `createBuffer()`/`createTexture()` return real GPU resources but track them. `destroyTracked()` destroys all tracked resources. Plugin authors should use `ctx.gpu` instead of raw `device` to ensure cleanup.
- **Shader hot-reload rebuilds entire render graph** — `recompileShader()` calls `rebuildGraph()`, destroying and recreating all passes. Not incremental — acceptable for dev tooling, not production runtime.
- **ProfilerOverlay requires canvas with parentElement** — `show(canvas)` early-returns if `canvas.parentElement` is null. The parent should have `position: relative` for absolute positioning to work correctly.
- **EventBus emit iterates spread copy** — `emit()` spreads the listener array before iterating, so `once()` self-removal during emit is safe.

## Conventions

- All ECS components are `#[repr(C)]` with `bytemuck::Pod` + `Zeroable` for GPU-uploadable memory layout.
- Rust tests are inline `#[cfg(test)] mod tests` in each source file. TypeScript tests are `*.test.ts` colocated in `ts/src/`.
- `CommandType` enum values must stay synchronized between Rust (`ring_buffer.rs`) and TypeScript (`ring-buffer.ts`).
- Little-endian byte order everywhere for cross-architecture safety (ring buffer uses `DataView` on TS side).
- WASM singletons (`static mut ENGINE/RING_BUFFER`) are safe because wasm32 is single-threaded; every `unsafe` block has a SAFETY comment.
- Vite dev server must serve COOP/COEP headers for SharedArrayBuffer access (`vite.config.ts`).
- WGSL shaders live in `ts/src/shaders/`, loaded at dev time via Vite `?raw` imports.

## Implementation Status

Phases 0-5.5, Phase 4.5 (Stabilization & Architecture Foundations), Post-Plan Integration, Phase 6 (Input System), Phase 7 (Audio System), Phase 7.5 (Stability Bugfix), and Phase 8 (Polish, DX & Production Readiness) are complete. Phase 5.5 (Rendering Primitives) extended the engine from quad-only to multi-primitive rendering: `PrimitiveParams([f32;8])` component on Rust side with `SetPrimParams0/1` ring buffer commands, multi-type CullPass (6 primitive types with per-type indirect draw args), multi-pipeline ForwardPass (`SHADER_SOURCES: Record<number, string>`), line rendering (screen-space expansion + SDF dash), MSDF text rendering (FontAtlas + text layout + median SDF shader), gradient rendering (linear/radial/conic), box shadow rendering (Evan Wallace erf technique), FXAA + tonemapping post-processing (PBR Neutral/ACES), and JFA selection outlines (SelectionSeedPass → JFAPass×N → OutlineCompositePass with dead-pass culling). Phase 6 (Input System) added: `ExternalId(u32)` ECS component for SoA entity ID tracking, `entityIds` buffer plumbed through WASM exports and all three bridge modes, `InputManager` (keyboard/pointer/scroll state + callback registration with DOM lifecycle), `Camera.screenToRay()` with general `mat4Inverse` (forward-compatible with perspective cameras), `hitTestRay()` CPU ray-sphere picking (2.5D depth ordering), `ImmediateState` shadow position map with transform patching for zero-latency rendering, `EntityHandle.positionImmediate()`/`clearImmediate()`. Public API: `engine.input`, `engine.picking.hitTest()`. Demo updated with click-to-select, WASD camera, scroll-zoom. Phase 7 (Audio System) added: Web Audio API integration with three-layer architecture (`SoundRegistry` for buffer management, `PlaybackEngine` for node graph + spatial audio, `AudioManager` as public facade). Branded types (`SoundHandle`, `PlaybackId`) for type safety. Lazy `AudioContext` initialization respecting browser autoplay policy. 2D spatial audio with `StereoPannerNode` (`pan = clamp(dx/panSpread, -1, 1)`, distance attenuation `gain = baseVolume / (1 + distance/rolloff)`). Full lifecycle wiring: `pause()` suspends, `resume()` resumes, `destroy()` tears down audio. DI-based testability (AudioDecoder, AudioFetcher, contextFactory). Public API: `engine.audio`. Phase 7.5 (Stability Bugfix) fixed three real defects: (1) `OverflowChildren(Vec<u32>)` heap fallback for entities with 33+ children (Children.remove() now returns bool), (2) `ImmediateState.patchBounds()` patches SoA bounds buffer for consistent picking during drag, (3) ring-buffer-driven audio listener via `SetListenerPosition` command (discriminant 13) with WASM-side velocity derivation and extrapolation, `engine_listener_x/y/z()` exports, `setTargetAtTime` smoothing in PlaybackEngine. Phase 8 (Polish, DX & Production Readiness) added: Plugin System v2 with `PluginContext` and 5 extension APIs (systems, events, rendering, GPU, storage), `EventBus` for inter-plugin communication, dependency resolution and error boundaries in `PluginRegistry`. Shader hot-reload via `recompileShader()` + Vite HMR wiring for all 10 WGSL files. Performance profiler overlay (`enableProfiler`/`disableProfiler`). Stats wiring: tickCount from WASM, frame time tracking in GameLoop, MemoryStats getter. Deployment guide for 7 platforms. Example fps-counter plugin. **Next: Phase 9.**

## Documentation

- `PROJECT_ARCHITECTURE.md` — Deep technical architecture doc (algorithms, data structures, protocol details, design rationale). Reference for onboarding and implementation decisions.
- `docs/plans/hyperion-engine-design-v3.md` — Full vision design doc v3 (all phases). Reference for future phase implementation.
- `docs/plans/hyperion-engine-roadmap-unified-v3.md` — Unified roadmap v3. Phase-by-phase feature breakdown.
- `docs/plans/2026-02-17-hyperion-engine-phase0-phase1.md` — Phase 0-1 implementation plan (completed). Shows task-by-task build sequence.
- `docs/plans/2026-02-17-hyperion-engine-phase3.md` — Phase 3 implementation plan (completed). GPU-driven pipeline with compute culling.
- `docs/plans/2026-02-18-phase-4.5-stabilization-arch-foundations.md` — Phase 4.5 implementation plan (completed). 15 tasks for stabilization and architecture foundations.
- `docs/plans/2026-02-20-phase-5.5-rendering-primitives.md` — Phase 5.5 implementation plan (completed). 45 tasks for multi-primitive rendering, post-processing, and selection outlines.
- `docs/plans/2026-02-21-phase-6-input-system.md` — Phase 6 implementation plan (completed). 24 tasks for input system, CPU picking, and immediate mode.
- `docs/plans/2026-02-21-phase-7-audio-system.md` — Phase 7 implementation plan (completed). 22 tasks for Web Audio API integration, spatial audio, and engine lifecycle wiring.
- `docs/plans/2026-02-21-phase-7.5-stability-bugfix-design.md` — Phase 7.5 design doc. Three defect analyses with fix strategies.
- `docs/plans/2026-02-21-phase-7.5-stability-bugfix.md` — Phase 7.5 implementation plan (completed). 24 tasks for OverflowChildren, immediate-mode bounds patching, and ring-buffer-driven audio listener.
- `docs/deployment-guide.md` — Deployment guide for 7 platforms (Vercel, Netlify, Cloudflare Pages, GitHub Pages, Electron, Tauri, Nginx/Apache) with COOP/COEP header configs and WASM caching.
