# Architettura Tecnica: Hyperion Engine (v0.1.0)

> **Ultimo aggiornamento**: 2026-02-22 | **Versione**: 0.11.0 (Phase 0-8 complete) | **99 test Rust across 7 moduli + 409 test TypeScript across 41 file**

---

## 1. Panoramica Architetturale

### Scopo

Hyperion e un **game engine web general-purpose** che punta a performance di livello nativo dentro il browser. La simulazione ECS gira in Rust compilato a WebAssembly, la comunicazione tra TypeScript e WASM avviene tramite un ring buffer lock-free su SharedArrayBuffer, e il rendering e gestito da TypeScript via WebGPU con instanced draw calls e WGSL shaders.

L'obiettivo architetturale primario e la **separazione fisica** tra UI, logica di simulazione e rendering: tre thread indipendenti che comunicano senza lock, con degradazione automatica a single-thread quando il browser non supporta le API necessarie.

### Cosa NON fa (attualmente)

- Non supporta networking o multiplayer
- Non compila con SIMD128 attivo (richiede flag target-feature specifici per wasm-pack)
- Non supporta mesh 3D — solo primitive 2D (quad, line, gradient, box shadow, MSDF text)
- Non supporta camera prospettica — solo ortografica (forward-compatible con prospettica via `mat4Inverse`)

### Design Principle: "Command Buffer Architecture"

Il principio architetturale fondamentale e la **separazione tra mutazioni e simulazione** attraverso un protocollo binario su memoria condivisa. TypeScript non chiama mai funzioni WASM per singole mutazioni di entita. Serializza invece comandi in un ring buffer che Rust consuma in batch all'inizio di ogni frame.

```
TypeScript (Main Thread)            SharedArrayBuffer              Rust/WASM (Worker)
+-------------------------+    +----------------------------+    +-------------------------+
| RingBufferProducer      |    | [write_head][read_head]    |    | RingBufferConsumer      |
|   .spawnEntity(id)      |--->| [capacity  ][padding    ]  |--->|   .drain()              |
|   .setPosition(id,x,y,z)|    | [cmd|eid|payload|cmd|...]  |    |                         |
|   .despawnEntity(id)    |    +----------------------------+    | process_commands()      |
+-------------------------+                                      | Engine.update(dt)       |
                                                                 +-------------------------+
```

Questo elimina due problemi critici:

1. **Overhead FFI per-call**: Ogni chiamata JS→WASM ha un costo di context switching misurabile. A 10k+ mutazioni/frame, il costo supera il tempo di simulazione. Il ring buffer riduce il crossing a uno per frame.
2. **Invalidazione delle viste**: `memory.grow` in WASM invalida silenziosamente tutte le `TypedArray` JS esistenti. Il ring buffer vive su un `SharedArrayBuffer` statico, separato dalla memoria lineare WASM.

| Caratteristica | FFI Sincrona (scartata) | Ring Buffer (adottato) |
|---|---|---|
| Context switching | Uno per mutazione di proprieta | Un singolo batch read per frame |
| Rischio memory detachment | Alto (`memory.grow` invalida le viste) | Nessuno (SharedArrayBuffer statico) |
| Scalabilita multi-thread | Impossibile | Lock-free SPSC nativo |
| Throughput | Degrada sopra 10k mutazioni/frame | Limitato solo dalla bandwidth di memoria |

### Stack Tecnologico

| Dipendenza | Scopo | Perche questa |
|---|---|---|
| **Rust** (edition 2024, `wasm-bindgen`) | Linguaggio per il core WASM | Sicurezza di memoria senza GC, compilazione a WASM con overhead minimo, SIMD nativo via `glam` |
| **`hecs`** 0.11 | ECS (Entity Component System) | Binary footprint minimo per WASM (~50KB vs ~200KB di `bevy_ecs`). `bevy_ecs` perde il parallelismo su `wasm32` (fallback a single-thread) aggiungendo solo binary bloat. `hecs` ha velocita di iterazione single-thread equivalente |
| **`glam`** 0.29 (feat: `bytemuck`) | Matematica 3D (Vec3, Quat, Mat4) | Tipi SIMD-accelerated, layout `repr(C)`, zero-cost conversion a byte slice via `bytemuck` per upload diretto a GPU |
| **`bytemuck`** 1.x (feat: `derive`) | Cast sicuro struct ↔ byte slice | Garantisce che i componenti ECS siano `Pod` + `Zeroable` per upload GPU senza copie. Derive macro elimina boilerplate |
| **TypeScript** (ES2022, strict) | Browser integration | Type safety per la API di coordinamento (Worker messages, ring buffer protocol), moduli ESM nativi |
| **Vite** 6.x | Dev server + bundler | Hot reload, supporto Worker ESM nativo, header COOP/COEP configurabili per SharedArrayBuffer |
| **`vitest`** 4.x | Test runner TypeScript | Compatibile con SharedArrayBuffer e Atomics in ambiente Node.js (critico per testare il ring buffer) |
| **`@webgpu/types`** | Type definitions WebGPU | TypeScript type declarations per l'API WebGPU (`GPUDevice`, `GPURenderPipeline`, etc.). Richiede cast `Float32Array<ArrayBuffer>` per `writeBuffer` |
| **`wasm-pack`** | Build pipeline Rust → WASM | Genera JS glue code + `.wasm` binary + `.d.ts` types in un singolo comando |

### Perche hecs e non bevy_ecs?

La scelta di `hecs` rispetto a `bevy_ecs` non e ovvia — Bevy e l'ecosistema Rust ECS dominante. Ma su `wasm32-unknown-unknown`:

1. **Parallelismo perso**: `bevy_ecs` usa `rayon` per iterazione parallela dei sistemi. Su WASM, `rayon` fallisce silenziosamente a single-thread. Si paga il costo dell'infrastruttura di scheduling (trait objects, task graph) senza il beneficio.
2. **Binary bloat**: `bevy_ecs` con le sue dipendenze transitive aggiunge ~150KB al `.wasm` compresso. Su una CDN, 150KB extra sono ~50ms di download addizionale su 3G.
3. **Velocita di iterazione**: In single-thread, `hecs::query_mut` e `bevy_ecs::Query` hanno throughput comparabile — il collo di bottiglia e la cache locality dei componenti, non l'overhead del query system.

La migrazione futura a `bevy_ecs` o `flecs-rs` richiederebbe solo la riscrittura del layer di sistema (`systems.rs`, `command_processor.rs`), non dell'intera architettura.

---

## 2. Esecuzione Adattiva: Tre Modi Runtime

L'engine seleziona automaticamente uno di tre modi di esecuzione al startup, basandosi sul feature detection del browser. La logica di selezione risiede in `ts/src/capabilities.ts`.

### Tabella Decisionale

```
+-------------------------------------------------------------------+
|               Browser Feature Detection                            |
+-------------------------------------------------------------------+
| SharedArrayBuffer? ──NO──> Mode C (Single Thread)                  |
|       |                                                            |
|      YES                                                           |
|       |                                                            |
| WebGPU in Worker? ──NO──> Mode B (Partial Isolation)               |
|       |                                                            |
|      YES                                                           |
|       |                                                            |
| OffscreenCanvas? ──NO──> Mode B (Partial Isolation)                |
|       |                                                            |
|      YES                                                           |
|       v                                                            |
| Mode A (Full Isolation)                                            |
+-------------------------------------------------------------------+
```

### Mode A — Full Isolation (Optimale)

- **Richiede**: `SharedArrayBuffer` + `OffscreenCanvas` + WebGPU in Worker
- **Layout**: Main Thread (UI/Input) → Worker 1 (ECS/WASM) → Worker 2 (Render/WebGPU)
- **Comunicazione**: Ring Buffer SPSC su SharedArrayBuffer

```
+------------------+     Ring Buffer (SAB)     +------------------+     Render State     +------------------+
|   Main Thread    |  ======================>  |    Worker 1      |  ================>   |    Worker 2      |
|   UI + Input     |   [commands: binary]      |   ECS + Physics  |   [model matrices]   |   WebGPU Render  |
|   RAF loop       |                           |   WASM module    |                      |   OffscreenCanvas|
+------------------+                           +------------------+                      +------------------+
```

### Mode B — Partial Isolation (Firefox)

- **Richiede**: `SharedArrayBuffer` + WebGPU su Main Thread
- **Layout**: Main Thread (UI + Render) → Worker 1 (ECS/WASM)
- **Comunicazione**: Ring Buffer per comandi, `postMessage` con `ArrayBuffer` trasferibile per render state

### Mode C — Single Thread (Fallback Massima Compatibilita)

- **Richiede**: Solo WebGPU su Main Thread
- **Layout**: Main Thread esegue tutto sequenzialmente: Input → ECS tick → Render
- **Comunicazione**: Chiamate dirette, nessun Ring Buffer necessario
- **Nota**: Viabile per scene sotto ~10k entita a 60fps

### Requisito di Deploy: COOP/COEP

I Mode A e B richiedono `crossOriginIsolated === true` nel browser. Senza gli header HTTP corretti, `SharedArrayBuffer` non e disponibile e l'engine degrada a Mode C con un warning chiaro nella console.

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite dev server li configura automaticamente (`ts/vite.config.ts`). In produzione, il CDN/web server deve servirli.

### Rilevamento Capabilities

`detectCapabilities()` (`ts/src/capabilities.ts:18`) sonda le API del browser:

| Capability | Come la rileva | Note |
|---|---|---|
| `crossOriginIsolated` | `globalThis.crossOriginIsolated` | Prerequisito per SAB |
| `sharedArrayBuffer` | `crossOriginIsolated && typeof SharedArrayBuffer !== "undefined"` | SAB disponibile solo se isolato |
| `offscreenCanvas` | `typeof OffscreenCanvas !== "undefined"` | Per render in Worker |
| `webgpu` | `"gpu" in navigator` | API WebGPU presente |
| `webgpuInWorker` | Euristica UA (Chrome/Edge = si, Firefox = no) | Non testabile dal Main Thread; usa heuristic conservativa |

La detection di `webgpuInWorker` usa una euristica basata su User-Agent perche non esiste un modo affidabile per testare WebGPU in un Worker dal Main Thread senza avviare effettivamente un Worker e tentare `navigator.gpu.requestAdapter()`.

---

## 3. Struttura dei File

```
HyperionEngine/
├── Cargo.toml                          # Workspace root (edition 2024, fat LTO in release)
├── Cargo.lock                          # Lockfile delle dipendenze Rust
├── CLAUDE.md                           # Istruzioni per Claude Code
├── PROJECT_ARCHITECTURE.md             # Questo documento
├── docs/
│   ├── deployment-guide.md                                   # Deployment guide for 7 platforms
│   └── plans/
│       ├── hyperion-engine-design-v3.md                     # Architectural Design Document v3 (completo)
│       ├── hyperion-engine-roadmap-unified-v3.md            # Unified roadmap v3 (all phases)
│       ├── 2026-02-17-hyperion-engine-phase0-phase1.md      # Implementation plan Phase 0-1 (completato)
│       ├── 2026-02-17-hyperion-engine-phase2.md             # Implementation plan Phase 2 (completato)
│       ├── 2026-02-17-hyperion-engine-phase3.md             # Implementation plan Phase 3 (completato)
│       ├── 2026-02-17-hyperion-engine-phase4.md             # Implementation plan Phase 4 (completato)
│       ├── 2026-02-18-phase-4.5-stabilization-arch-foundations.md  # Phase 4.5 (completato)
│       ├── 2026-02-20-phase5-typescript-api-lifecycle.md    # Phase 5 (completato)
│       ├── 2026-02-20-post-plan-integration-wiring.md       # Post-Plan Integration (completato)
│       ├── 2026-02-20-phase-5.5-rendering-primitives.md     # Phase 5.5 (completato)
│       ├── 2026-02-21-phase-6-input-system.md               # Phase 6 Input (completato)
│       ├── 2026-02-21-phase-7-audio-system.md               # Phase 7 Audio (completato)
│       ├── 2026-02-21-phase-7.5-stability-bugfix-design.md  # Phase 7.5 Design (completato)
│       └── 2026-02-21-phase-7.5-stability-bugfix.md         # Phase 7.5 Implementation (completato)
├── crates/
│   └── hyperion-core/
│       ├── Cargo.toml                  # Crate config: wasm-bindgen, hecs, glam, bytemuck
│       └── src/
│           ├── lib.rs                  # WASM exports: engine_init, engine_update, engine_gpu_data_ptr,
│           │                           #   engine_gpu_tex_indices_ptr, engine_tick_count,
│           │                           #   engine_compact_entity_map, engine_compact_render_state,
│           │                           #   engine_entity_map_capacity + altri
│           ├── engine.rs               # Engine struct: fixed-timestep accumulator, tick loop,
│           │                           #   spiral-of-death cap, interpolation alpha,
│           │                           #   propagate_transforms wired into update(),
│           │                           #   listener position with velocity derivation + extrapolation
│           ├── command_processor.rs     # EntityMap (sparse Vec + free-list + shrink_to_fit +
│           │                           #   iter_mapped) + process_commands() incl. SetParent
│           ├── ring_buffer.rs          # SPSC consumer: atomic heads, circular read, CommandType enum
│           │                           #   (14 variants incl. SetParent, SetPrimParams0/1,
│           │                           #   SetListenerPosition), parse_commands()
│           ├── components.rs           # Position, Rotation, Scale, Velocity, ModelMatrix,
│           │                           #   BoundingRadius, TextureLayerIndex, MeshHandle,
│           │                           #   RenderPrimitive, PrimitiveParams, ExternalId,
│           │                           #   Active, Parent, Children, LocalMatrix
│           │                           #   — tutti #[repr(C)] Pod.
│           │                           #   OverflowChildren(Vec<u32>) — heap fallback (NOT Pod)
│           ├── systems.rs              # velocity_system, transform_system, count_active,
│           │                           #   propagate_transforms (scene graph hierarchy)
│           └── render_state.rs         # RenderState: collect() per legacy matrices,
│                                       #   collect_gpu() per SoA buffers (transforms/bounds/
│                                       #   renderMeta/texIndices/primParams/entityIds) +
│                                       #   BitSet/DirtyTracker + shrink_to_fit()
└── ts/
    ├── package.json                    # Scripts: dev, build, build:wasm, test
    ├── tsconfig.json                   # strict, ES2022, bundler moduleResolution
    ├── vite.config.ts                  # COOP/COEP headers, esnext target
    ├── index.html                      # Canvas + info overlay + module script entry
    └── src/
        ├── index.ts                    # Barrel export for public API surface
        ├── hyperion.ts                 # Hyperion class: public API facade with create(), spawn(),
        │                               #   batch(), start/pause/resume/destroy, use()/unuse(),
        │                               #   addHook/removeHook, loadTexture/loadTextures, compact(),
        │                               #   resize(), enableOutlines/disableOutlines,
        │                               #   enablePostProcessing, selection, input, picking, audio
        ├── hyperion.test.ts            # 55 test: facade lifecycle, spawn, batch, hooks, plugins,
        │                               #   destroy, stats, compact, resize, outlines, selection,
        │                               #   input, picking, audio, immediate-mode, profiler, shader
        ├── entity-handle.ts            # EntityHandle: fluent builder over BackpressuredProducer
        │                               #   with .position/.velocity/.rotation/.scale/.texture/
        │                               #   .mesh/.primitive/.parent/.unparent/.data/.line/
        │                               #   .gradient/.boxShadow/.positionImmediate/.clearImmediate.
        │                               #   Disposable. RenderPrimitiveType enum
        ├── entity-handle.test.ts       # 28 test: fluent API, dispose, data, pool recycling,
        │                               #   line/gradient/boxShadow, immediate-mode
        ├── entity-pool.ts              # EntityHandlePool: object pool (cap 1024) for recycling
        ├── entity-pool.test.ts         # 5 test: acquire/release, capacity, init reset
        ├── game-loop.ts                # GameLoop: RAF lifecycle with preTick/postTick/frameEnd
        │                               #   hook phases, FPS tracking, lastTime=-1 sentinel
        ├── game-loop.test.ts           # 11 test: RAF lifecycle, hooks, FPS tracking, frame timing
        ├── camera-api.ts               # CameraAPI: wrapper around Camera with zoom (min 0.01),
        │                               #   x/y position getters for audio listener tracking
        ├── camera-api.test.ts          # 3 test: zoom clamping, viewProjection delegation
        ├── raw-api.ts                  # RawAPI: low-level numeric ID entity management
        ├── raw-api.test.ts             # 4 test: spawn/despawn/setPosition/setVelocity
        ├── plugin.ts                   # HyperionPlugin interface (v2: PluginContext) +
        │                               #   PluginRegistry: dependency resolution, error boundaries
        ├── plugin.test.ts              # 13 test: install, cleanup, dependencies, error boundaries
        ├── types.ts                    # Core types: HyperionConfig, ResolvedConfig, HyperionStats,
        │                               #   MemoryStats, CompactOptions, TextureHandle
        ├── types.test.ts               # 4 test: config defaults, type validation
        ├── leak-detector.ts            # LeakDetector: FinalizationRegistry backstop for undisposed
        │                               #   EntityHandles
        ├── leak-detector.test.ts       # 2 test: registration, cleanup callback
        ├── selection.ts                # SelectionManager: CPU-side Set<number> with dirty tracking
        │                               #   + GPU mask upload. select/deselect/toggle/clear
        ├── selection.test.ts           # 10 test: select, deselect, toggle, clear, dirty tracking
        ├── input-manager.ts            # InputManager: keyboard (isKeyDown), pointer (pointerX/Y,
        │                               #   isButtonDown), scroll (scrollDeltaX/Y) + callbacks
        │                               #   (onKey/onClick/onPointerMove/onScroll). DOM lifecycle
        ├── input-manager.test.ts       # 24 test: keyboard+pointer+scroll state, callbacks, DOM
        ├── hit-tester.ts               # hitTestRay(): CPU ray-sphere intersection against SoA
        │                               #   bounds buffer. Returns closest hit entityId or null
        ├── hit-tester.test.ts          # 8 test: ray-sphere hits, misses, depth ordering
        ├── immediate-state.ts          # ImmediateState: shadow position map for zero-latency
        │                               #   rendering. patchTransforms() patches SoA column 3
        ├── immediate-state.test.ts     # 8 test: shadow state, patch transforms
        ├── input-picking.test.ts       # 3 test: input-to-picking integration
        ├── audio-types.ts              # Branded types SoundHandle, PlaybackId (zero runtime
        │                               #   overhead), PlaybackOptions, SpatialConfig interfaces
        ├── audio-types.test.ts         # 3 test: branded types + defaults
        ├── sound-registry.ts           # SoundRegistry: URL-deduplicated audio buffer management
        │                               #   with DI (AudioDecoder, AudioFetcher). O(1) bidirectional
        │                               #   handle<->URL mapping
        ├── sound-registry.test.ts      # 13 test: load/decode/dedup/unload/destroy
        ├── playback-engine.ts          # PlaybackEngine: Web Audio node graph (source -> gain ->
        │                               #   panner -> masterGain -> destination). 2D spatial audio
        │                               #   with StereoPannerNode + distance attenuation
        ├── playback-engine.test.ts     # 26 test: play/stop/spatial/volume/pitch/mute
        ├── audio-manager.ts            # AudioManager: public facade wrapping SoundRegistry +
        │                               #   PlaybackEngine. Lazy AudioContext init. Lifecycle:
        │                               #   suspend/resume/destroy
        ├── audio-manager.test.ts       # 25 test: facade lifecycle, lazy init, spatial config
        ├── event-bus.ts                # EventBus: typed pub/sub (on/off/once/emit/destroy)
        ├── event-bus.test.ts           # 5 test: subscribe, emit, once, off, destroy
        ├── plugin-context.ts           # PluginContext: 5 sub-APIs (systems, events, rendering,
        │                               #   gpu, storage). Passed to plugin.install()
        ├── plugin-context.test.ts      # 10 test: sub-APIs, null when headless, storage
        ├── profiler.ts                 # ProfilerOverlay: DOM-based perf stats display.
        │                               #   show/hide/update/destroy, configurable position
        ├── profiler.test.ts            # 4 test: DOM management, position, update, destroy
        ├── plugins/
        │   ├── fps-counter.ts          # fpsCounterPlugin(): example plugin factory using
        │   │                           #   PluginSystemsAPI + PluginEventAPI
        │   └── fps-counter.test.ts     # 3 test: install, postTick hook, cleanup
        ├── main.ts                     # Entry point: uses Hyperion public API. Demonstrates
        │                               #   click-to-select with spatial audio, WASD camera, zoom
        ├── capabilities.ts             # detectCapabilities(), selectExecutionMode(), logCapabilities()
        ├── capabilities.test.ts        # 4 test: mode selection across capability combinations
        ├── ring-buffer.ts              # RingBufferProducer: Atomics-based SPSC producer, CommandType enum
        ├── ring-buffer.test.ts         # 16 test: write/read/overflow/sequential/texture layer/fast path/
        │                               #   SetPrimParams wrap-around
        ├── ring-buffer-utils.test.ts   # 4 test: ring buffer utility functions
        ├── backpressure.ts             # PrioritizedCommandQueue + BackpressuredProducer:
        │                               #   priority-based command queuing + RingBufferProducer wrapper
        ├── backpressure.test.ts        # 18 test: priority ordering, limits, critical bypass,
        │                               #   BackpressuredProducer pass-through/overflow/flush,
        │                               #   setParent/setMeshHandle/setRenderPrimitive/setPrimParams
        ├── supervisor.ts               # WorkerSupervisor: heartbeat monitoring + timeout
        ├── supervisor.test.ts          # 5 test: heartbeat, timeout detection, configurable threshold
        ├── worker-bridge.ts            # EngineBridge + GPURenderState, createWorkerBridge(),
        │                               #   createFullIsolationBridge(), createDirectBridge().
        │                               #   Uses BackpressuredProducer + WorkerSupervisor (Mode A/B)
        ├── engine-worker.ts            # Web Worker: WASM init + tick loop dispatch.
        │                               #   Increments heartbeat counter after each tick
        ├── renderer.ts                 # RenderGraph-based coordinator: ResourcePool + CullPass +
        │                               #   ForwardPass + FXAATonemapPass + selection outline
        │                               #   pipeline. Multi-primitive. SelectionManager integration.
        │                               #   onDeviceLost callback + device.lost listener
        ├── texture-manager.ts          # TextureManager: multi-tier Texture2DArray with lazy
        │                               #   allocation + exponential growth, concurrency limiter.
        │                               #   Added retainBitmaps option for device-lost recovery
        ├── texture-manager.test.ts     # 16 test: tier selection, packing, lazy alloc, growth
        ├── camera.ts                   # Orthographic camera, extractFrustumPlanes(),
        │                               #   isSphereInFrustum(), mat4Inverse(), screenToRay()
        ├── camera.test.ts              # 19 test: camera math, frustum planes, ray casting,
        │                               #   mat4Inverse, screenToRay
        ├── frustum.test.ts             # 7 test: frustum culling accuracy (sphere-plane tests)
        ├── render-worker.ts            # Mode A render worker: OffscreenCanvas + createRenderer().
        │                               #   Wraps ArrayBuffers to typed arrays for GPURenderState
        ├── vite-env.d.ts               # Type declarations for WGSL ?raw imports and Vite client
        ├── text/
        │   ├── font-atlas.ts           # FontAtlas + GlyphMetrics, parseFontAtlas(), loadFontAtlas()
        │   ├── text-layout.ts          # layoutText(): positions glyphs, returns LayoutGlyph[]
        │   ├── text-layout.test.ts     # 3 test: MSDF text layout
        │   └── text-manager.ts         # TextManager: loads and caches font atlases
        ├── render/
        │   ├── render-pass.ts          # RenderPass interface + FrameState type
        │   ├── render-pass.test.ts     # 6 test: ResourcePool CRUD, pass contract
        │   ├── resource-pool.ts        # ResourcePool: named GPU resource registry
        │   ├── render-graph.ts         # RenderGraph: DAG pass scheduling (Kahn's sort)
        │   ├── render-graph.test.ts    # 8 test: ordering, dead-pass culling, cycles
        │   └── passes/
        │       ├── cull-pass.ts        # CullPass: GPU frustum culling compute pass with
        │       │                       #   per-primitive-type grouping (6 types). prepare() +
        │       │                       #   execute()
        │       ├── cull-pass.test.ts   # 2 test: CullPass construction + type grouping
        │       ├── forward-pass.ts     # ForwardPass: multi-pipeline forward rendering with
        │       │                       #   SHADER_SOURCES per primitive type, SoA transforms,
        │       │                       #   per-type drawIndexedIndirect. Writes scene-hdr
        │       ├── forward-pass.test.ts # 2 test: ForwardPass construction + multi-pipeline
        │       ├── fxaa-tonemap-pass.ts  # FXAATonemapPass: full-screen triangle post-process.
        │       │                         #   Reads scene-hdr, writes swapchain. Configurable
        │       │                         #   tonemap (none/PBR-neutral/ACES). Optional pass
        │       ├── fxaa-tonemap-pass.test.ts  # 3 test: construction, tonemap modes
        │       ├── selection-seed-pass.ts # SelectionSeedPass: renders selected entities as
        │       │                          #   JFA seeds. Reads selection-mask, writes selection-seed
        │       ├── selection-seed-pass.test.ts # 3 test: seed pass construction
        │       ├── jfa-pass.ts         # JFAPass: single JFA iteration, ping-pong textures.
        │       │                       #   iterationsForDimension() helper
        │       ├── jfa-pass.test.ts    # 9 test: JFA iteration counts, resource naming
        │       ├── outline-composite-pass.ts  # OutlineCompositePass: SDF distance outline from
        │       │                              #   JFA result + scene. Built-in FXAA. Dead-pass
        │       │                              #   culls FXAATonemapPass when active
        │       ├── outline-composite-pass.test.ts # 6 test: composite, dead-pass culling
        │       ├── prefix-sum-reference.ts # CPU Blelloch exclusive scan reference
        │       └── prefix-sum.test.ts  # 6 test: Blelloch scan correctness
        ├── shaders/
        │   ├── basic.wgsl              # Quad render: SoA transforms, visibility indirection,
        │   │                           #   renderMeta + primParams, multi-tier Texture2DArray
        │   ├── line.wgsl               # Line render: screen-space quad expansion from primParams,
        │   │                           #   SDF dash pattern, anti-aliased edges
        │   ├── gradient.wgsl           # 2-stop gradient (linear, radial, conic)
        │   ├── box-shadow.wgsl         # SDF box shadow (Evan Wallace erf approximation)
        │   ├── msdf-text.wgsl          # MSDF text: median(r,g,b) signed distance + AA
        │   ├── fxaa-tonemap.wgsl       # Combined FXAA (Lottes) + PBR Neutral/ACES tonemapping
        │   ├── selection-seed.wgsl     # Selection seed: UV-encoded seed positions for JFA
        │   ├── jfa.wgsl                # Jump Flood Algorithm: 9 neighbors at ±step
        │   ├── outline-composite.wgsl  # SDF distance outline from JFA result + built-in FXAA
        │   ├── cull.wgsl               # Compute: sphere-frustum culling (SoA), per-type grouping,
        │   │                           #   6 DrawIndirectArgs, atomicAdd
        │   └── prefix-sum.wgsl         # Compute: Blelloch exclusive scan (workgroup-level)
        └── integration.test.ts         # 5 test: binary protocol, texture pipeline, GPU data format
```

---

## 4. Core Pipeline: Flusso di un Frame

### Diagramma Completo

```
                              MAIN THREAD
                    ┌─────────────────────────────┐
                    │         main.ts              │
                    │                              │
                    │  requestAnimationFrame(frame) │
                    │         │                    │
                    │         ▼                    │
                    │  dt = (now - lastTime) / 1000│
                    │         │                    │
                    │         ▼                    │
                    │  bridge.tick(dt)              │
                    └──────────┬──────────────────-┘
                               │
                   ┌───────────┴───────────┐
                   │ Mode A/B              │ Mode C
                   ▼                       ▼
    ┌────────────────────────┐  ┌────────────────────────┐
    │ worker.postMessage(    │  │ (direct function call)  │
    │   { type:"tick", dt }) │  │                        │
    └──────────┬─────────────┘  └──────────┬─────────────┘
               │                           │
               ▼                           ▼
              ENGINE WORKER (o Main Thread in Mode C)
    ┌────────────────────────────────────────────────────┐
    │                engine_update(dt)                    │
    │                                                    │
    │  ┌─── Phase 1: Command Drain ──────────────────┐   │
    │  │  RingBufferConsumer.drain()                  │   │
    │  │    ▼ read write_head (Acquire)               │   │
    │  │    ▼ while read_head != write_head:          │   │
    │  │        parse [cmd_type: u8]                  │   │
    │  │        parse [entity_id: u32 LE]             │   │
    │  │        parse [payload: 0-16 bytes]           │   │
    │  │    ▼ store read_head (Release)               │   │
    │  │  Output: Vec<Command>                        │   │
    │  └─────────────────────────────────────────────┘   │
    │                      │                             │
    │                      ▼                             │
    │  ┌─── Phase 2: Command Processing ─────────────┐   │
    │  │  process_commands(&commands, &world, &map)   │   │
    │  │    for cmd in commands:                      │   │
    │  │      SpawnEntity     → world.spawn(archetype)│   │
    │  │      DespawnEntity   → world.despawn(entity) │   │
    │  │      SetPosition     → pos.0 = Vec3::new(..)│   │
    │  │      SetRotation     → rot.0 = Quat::new(..)│   │
    │  │      SetScale        → scale.0 = Vec3::new()│   │
    │  │      SetVelocity     → vel.0 = Vec3::new(..)│   │
    │  │      SetTextureLayer → tex.0 = u32           │   │
    │  └─────────────────────────────────────────────┘   │
    │                      │                             │
    │                      ▼                             │
    │  ┌─── Phase 3: Fixed-Timestep Tick Loop ───────┐   │
    │  │  accumulator += dt                           │   │
    │  │  cap: accumulator = min(acc, FIXED_DT * 10)  │   │
    │  │                                              │   │
    │  │  while accumulator >= FIXED_DT:              │   │
    │  │    ┌── fixed_tick() ──────────────────────┐  │   │
    │  │    │  velocity_system(&world, FIXED_DT)   │  │   │
    │  │    │    pos.0 += vel.0 * dt               │  │   │
    │  │    └──────────────────────────────────────┘  │   │
    │  │    accumulator -= FIXED_DT                   │   │
    │  │    tick_count += 1                           │   │
    │  └──────────────────────────────────────────────┘   │
    │                      │                             │
    │                      ▼                             │
    │  ┌─── Phase 4: Transform Recomputation ────────┐   │
    │  │  transform_system(&world)                    │   │
    │  │    Mat4::from_scale_rotation_translation(    │   │
    │  │        scale.0, rot.0, pos.0)                │   │
    │  │    matrix.0 = m.to_cols_array()              │   │
    │  │  Output: ModelMatrix — GPU-ready [f32; 16]   │   │
    │  └──────────────────────────────────────────────┘   │
    │                      │                             │
    │                      ▼                             │
    │  ┌─── Phase 5: Render State Collection ──────-┐   │
    │  │  RenderState::collect_gpu(&world)           │   │
    │  │    for (pos, matrix, radius, tex, _active)  │   │
    │  │      gpu_data: 16 f32 (matrix)              │   │
    │  │              + 4 f32 (bounding sphere)       │   │
    │  │      gpu_tex_indices: 1 u32 (packed tier|    │   │
    │  │                               layer)        │   │
    │  │  Output: [f32] buffer (20/entity) +          │   │
    │  │          [u32] tex indices + count           │   │
    │  └──────────────────────────────────────────────┘   │
    └────────────────────────────────────────────────────┘
                               │
                               ▼
              RENDER THREAD (o Main Thread in Mode B/C)
    ┌────────────────────────────────────────────────────┐
    │  ┌─── Phase 6: GPU Compute Culling ───────────┐   │
    │  │  cull.wgsl (compute shader, WG=256)         │   │
    │  │    per-entity: sphere vs 6 frustum planes   │   │
    │  │    visible → atomicAdd(instanceCount)       │   │
    │  │    → write visibleIndices[slot] = entityIdx  │   │
    │  │  Output: visibleIndices[], indirect args     │   │
    │  └──────────────────────────────────────────────┘   │
    │                      │                             │
    │                      ▼                             │
    │  ┌─── Phase 7: GPU Draw (Indirect) ───────────┐   │
    │  │  basic.wgsl (vertex + fragment shader)      │   │
    │  │    vertex: visibleIndices → transforms[idx]  │   │
    │  │      → decode packed texIdx (tier, layer)   │   │
    │  │      → transform + project                   │   │
    │  │    fragment: switch(tier) → sample tex array │   │
    │  │  drawIndexedIndirect(indirectBuffer)         │   │
    │  └──────────────────────────────────────────────┘   │
    └────────────────────────────────────────────────────┘
```

### Phase 1: Command Drain

**File**: `crates/hyperion-core/src/ring_buffer.rs` — `RingBufferConsumer::drain()`

Il consumer legge `write_head` con `Ordering::Acquire` (garanzia: tutte le scritture del producer prima dello store di `write_head` sono visibili). Poi itera il buffer circolare decodificando messaggi:

```
Byte 0:     cmd_type (u8)  — discriminant CommandType
Bytes 1-4:  entity_id (u32, little-endian)
Bytes 5+:   payload (0, 12, o 16 bytes a seconda di cmd_type)
```

Ogni messaggio ha dimensione variabile determinata da `CommandType::message_size()`. Il consumer gestisce il wrap-around modulo `capacity` sia per il byte singolo che per letture multi-byte. Al termine, aggiorna `read_head` con `Ordering::Release` per segnalare al producer che lo spazio e stato liberato.

**Gestione errori**: Se `CommandType::from_u8()` restituisce `None` (byte corrotto), il consumer salta a `write_head` (recovery) e interrompe il drain. Se il messaggio e incompleto (meno byte disponibili di `message_size`), il drain si ferma e ritenta al frame successivo.

### Phase 2: Command Processing

**File**: `crates/hyperion-core/src/command_processor.rs` — `process_commands()`

Itera il `Vec<Command>` e muta il mondo ECS via pattern matching sul `CommandType`:

| CommandType | Azione ECS | Payload |
|---|---|---|
| `SpawnEntity` (1) | `world.spawn((Position, Rotation, Scale, Velocity, ModelMatrix, BoundingRadius, TextureLayerIndex, Active))` + `entity_map.insert(id, entity)` | Nessuno |
| `DespawnEntity` (2) | `world.despawn(entity)` + `entity_map.remove(id)` | Nessuno |
| `SetPosition` (3) | `pos.0 = Vec3::new(x, y, z)` | 12 bytes: 3 × f32 LE |
| `SetRotation` (4) | `rot.0 = Quat::from_xyzw(x, y, z, w)` | 16 bytes: 4 × f32 LE |
| `SetScale` (5) | `scale.0 = Vec3::new(x, y, z)` | 12 bytes: 3 × f32 LE |
| `SetVelocity` (6) | `vel.0 = Vec3::new(x, y, z)` | 12 bytes: 3 × f32 LE |
| `SetTextureLayer` (7) | `tex.0 = u32` (packed: `tier << 16 \| layer`) | 4 bytes: 1 × u32 LE |
| `SetMeshHandle` (8) | `mesh.0 = u32` | 4 bytes: 1 × u32 LE |
| `SetRenderPrimitive` (9) | `prim.0 = u32` | 4 bytes: 1 × u32 LE |
| `SetParent` (10) | Set parent + update Children; `0xFFFFFFFF` = unparent | 4 bytes: 1 × u32 LE |
| `SetPrimParams0` (11) | `prim_params.0[0..4] = [f32; 4]` | 16 bytes: 4 × f32 LE |
| `SetPrimParams1` (12) | `prim_params.0[4..8] = [f32; 4]` | 16 bytes: 4 × f32 LE |
| `SetListenerPosition` (13) | Engine-level: updates `listener_pos`, derives velocity | 12 bytes: 3 × f32 LE (x, y, z). entity_id=0 (sentinel) |
| `Noop` (0) | Nulla | Nessuno |

I comandi su entita inesistenti vengono silenziosamente ignorati (nessun panic). Questo e intenzionale: tra la scrittura del comando su JS e il suo processamento su Rust, l'entita potrebbe essere stata gia despawnata.

### Phase 3: Fixed-Timestep Tick Loop

**File**: `crates/hyperion-core/src/engine.rs` — `Engine::update()`

Il pattern **fixed-timestep con accumulatore** garantisce determinismo fisico indipendentemente dal framerate. `dt` (variabile, da `requestAnimationFrame`) viene accumulato. Quando l'accumulatore supera `FIXED_DT` (1/60s = 16.67ms), uno o piu tick fissi vengono eseguiti:

```
dt: 33ms (30 FPS)
accumulator prima: 0ms
accumulator dopo += 33ms
tick 1: accumulator 33ms >= 16.67ms → velocity_system(FIXED_DT) → accumulator = 16.33ms
tick 2: accumulator 16.33ms >= 16.67ms? NO → esce
tick_count: +1
accumulator residuo: 16.33ms (usato per interpolation_alpha)
```

**Spiral of death cap**: Se il frame impiega troppo (es. tab in background per secondi), `accumulator` verrebbe saturato causando centinaia di tick di recupero. Il cap `FIXED_DT * 10` limita a massimo 10 tick per frame, sacrificando la correttezza temporale per evitare il freeze.

### Phase 4: Transform Recomputation

**File**: `crates/hyperion-core/src/systems.rs` — `transform_system()`

Eseguita **una volta dopo tutti i tick** (non per-tick), computa la `ModelMatrix` 4×4 da Position + Rotation + Scale usando `glam::Mat4::from_scale_rotation_translation()`. Il risultato e un array `[f32; 16]` in layout colonna-maggiore, pronto per upload diretto in un `StorageBuffer` WebGPU.

---

## 5. Algoritmi e Logica Chiave

### 5.1 Ring Buffer: Protocollo Binario SPSC

Il ring buffer implementa il pattern **Single-Producer Single-Consumer** (SPSC) senza lock, basandosi esclusivamente sulle garanzie di ordering degli atomics.

**Layout memoria** (SharedArrayBuffer):

```
Offset (bytes)    Dimensione    Descrizione
+──────────────────────────────────────────────────────────+
| 0                4 bytes       write_head (u32, atomic)  |  ← scritto da JS
| 4                4 bytes       read_head  (u32, atomic)  |  ← scritto da Rust
| 8                4 bytes       capacity   (u32, const)   |
| 12               4 bytes       padding (allineamento)    |
| 16               4 bytes       heartbeat_w1 (u32, atomic)|  ← Worker 1 heartbeat counter
| 20               4 bytes       heartbeat_w2 (u32, atomic)|  ← Worker 2 heartbeat counter
| 24               4 bytes       supervisor_flags (u32)    |  ← Flag per WorkerSupervisor
| 28               4 bytes       overflow_counter (u32)    |  ← Contatore overflow ring buffer
+──────────────────────────────────────────────────────────+
| 32               capacity      data region (comandi)     |
+──────────────────────────────────────────────────────────+
```

L'header e stato esteso da 16 a **32 byte** in Phase 4.5 per supportare il monitoraggio heartbeat dei Worker e il contatore di overflow. `HEADER_SIZE = 32` in entrambi i lati (Rust e TypeScript).

**Protocollo di sincronizzazione**:

```
                    JS (Producer)                         Rust (Consumer)
                    ─────────────                         ───────────────
                    1. Scrivi dati nella data region
                    2. Atomics.store(write_head, new_pos)
                       ↓ [Release semantics]
                                                          3. AtomicU32.load(write_head, Acquire)
                                                             ↓ [vede tutte le scritture prima del Release]
                                                          4. Leggi dati dalla data region
                                                          5. AtomicU32.store(read_head, new_pos, Release)
                       ↓ [next frame]
                    6. Atomics.load(read_head)
                       ↓ [sa quanto spazio e libero]
```

**Formato messaggio** (variable-length):

```
+----------+-----------+-------------------+
| cmd_type | entity_id |     payload       |
|  1 byte  |  4 bytes  |  0-16 bytes       |
|   u8     |  u32 LE   |  f32[] LE         |
+----------+-----------+-------------------+
```

**Distinzione full vs empty**: Il buffer riserva sempre 1 byte — `freeSpace = capacity - 1` quando vuoto. Questo evita l'ambiguita tra `write_head == read_head` (vuoto) e `write_head == read_head` dopo un giro completo (pieno).

**Wrap-around**: Sia il producer che il consumer applicano `offset % capacity` su ogni accesso alla data region. Per letture multi-byte che attraversano il confine, il consumer legge byte per byte con wrap individuale (non `memcpy` — sarebbe scorretto ai confini).

### 5.2 EntityMap: Sparse Vec con Free-List Recycling

**File**: `crates/hyperion-core/src/command_processor.rs` — `EntityMap`

Il problema: TypeScript assegna ID sequenziali alle entita (0, 1, 2, ...). `hecs` usa `Entity` opachi interni. Serve un mapping bidirezionale veloce.

**Soluzione**: `Vec<Option<hecs::Entity>>` indicizzato dall'ID esterno (O(1) lookup) + free-list `Vec<u32>` per riciclare ID dopo despawn.

```
                EntityMap
                ┌───────────────────────────────────┐
  map (Vec):    │ Some(E0) │ None │ Some(E2) │ None │
  index:        │    0     │  1   │    2     │  3   │
                └───────────────────────────────────┘
  free_list:    [1, 3]    ← ID riciclabili (LIFO)
  next_id:      4         ← prossimo ID se free_list vuota

  allocate() → pop free_list → 3
  allocate() → pop free_list → 1
  allocate() → free_list vuota → next_id++ → 4
```

**Perche non una HashMap?** Per 100k entita, una `HashMap<u32, Entity>` ha overhead di hashing e chaining. Un `Vec` indicizzato direttamente ha lookup O(1) con cache-friendliness perfetta. Il costo e spazio — se gli ID sono sparsi, il Vec ha buchi. Ma con la free-list, gli ID vengono riciclati mantenendo il Vec compatto.

### 5.3 Timestep Fisso con Accumulatore

**File**: `crates/hyperion-core/src/engine.rs`

L'algoritmo e il classico "Fix Your Timestep" (Fiedler, 2004):

```
const FIXED_DT: f32 = 1.0 / 60.0;  // 16.67ms

fn update(&mut self, dt: f32, commands: &[Command]) {
    process_commands(commands, ...);     // 1. Muta il mondo

    self.accumulator += dt;              // 2. Accumula tempo variabile

    // 3. Cap anti spiral-of-death
    if self.accumulator > FIXED_DT * 10.0 {
        self.accumulator = FIXED_DT * 10.0;
    }

    // 4. Tick fissi deterministici
    while self.accumulator >= FIXED_DT {
        self.fixed_tick();               //    velocity_system(FIXED_DT)
        self.accumulator -= FIXED_DT;
        self.tick_count += 1;
    }

    transform_system(&mut self.world);   // 5. Model matrix (una volta)
}
```

**Perche il transform_system e fuori dal loop dei tick?** Le model matrix servono solo per il rendering, che avviene una volta per frame. Ricalcolarle per ogni tick fisso sprecherebbe cicli — il rendering vedra solo lo stato dell'ultimo tick.

**Interpolation alpha**: `accumulator / FIXED_DT` (range 0.0–1.0) rappresenta quanto del prossimo tick e gia accumulato. Utile per il rendering interpolato tra tick fissi (smooth visual motion a framerate superiori a 60fps). Esposto come `Engine::interpolation_alpha()`.

### 5.4 Transform System: SRT → Mat4 Column-Major

**File**: `crates/hyperion-core/src/systems.rs` — `transform_system()`

```rust
let m = Mat4::from_scale_rotation_translation(scale.0, rot.0, pos.0);
matrix.0 = m.to_cols_array();
```

`glam::Mat4::from_scale_rotation_translation()` compone la matrice nell'ordine standard GPU: **Scale → Rotate → Translate**. Il risultato e un array `[f32; 16]` in layout **colonna-maggiore** (column-major), che e il formato nativo di WebGPU/WGSL:

```
Indice:  [0]  [1]  [2]  [3]  [4]  [5]  [6]  [7]  [8]  [9]  [10] [11] [12] [13] [14] [15]
Layout:  sx   0    0    0    0    sy   0    0    0    0    sz   0    tx   ty   tz   1
         ├── col 0 ──┤  ├── col 1 ──┤  ├── col 2 ──┤  ├── col 3 ──┤
         (X axis)       (Y axis)       (Z axis)       (Translation)
```

(Con rotazione e scale non-unitaria la struttura e piu complessa, ma le colonne 12-14 sono sempre la traslazione.)

---

## 6. Strutture Dati Chiave

### ECS Components

Tutti i componenti spaziali sono `#[repr(C)]` con `bytemuck::Pod` + `Zeroable`. Questo garantisce:
- **Layout deterministico** indipendente dal compilatore (nessun padding arbitrario)
- **Cast sicuro a byte slice** per upload diretto in `StorageBuffer` GPU
- **Nessun campo non-Pod** (no String, no Vec, no puntatori) — solo dati plain

```rust
#[repr(C)] struct Position(pub Vec3);            // 12 bytes (3 × f32)
#[repr(C)] struct Rotation(pub Quat);            // 16 bytes (4 × f32)
#[repr(C)] struct Scale(pub Vec3);               // 12 bytes (3 × f32)
#[repr(C)] struct Velocity(pub Vec3);            // 12 bytes (3 × f32)
#[repr(C)] struct ModelMatrix(pub [f32; 16]);    // 64 bytes (4×4 matrix)
#[repr(C)] struct BoundingRadius(pub f32);       // 4 bytes — per frustum culling
#[repr(C)] struct TextureLayerIndex(pub u32);    // 4 bytes — packed (tier << 16) | layer
#[repr(C)] struct PrimitiveParams(pub [f32; 8]); // 32 bytes — per-entity shader params
#[repr(C)] struct ExternalId(pub u32);            // 4 bytes — immutable external entity ID
#[repr(C)] struct Parent(pub u32);               // 4 bytes — external parent entity ID
#[repr(C)] struct Children { count: u32, ids: [u32; 32] } // 132 bytes — fixed inline array
            struct OverflowChildren { items: Vec<u32> } // heap fallback for 33+ children (NOT #[repr(C)]/Pod)
#[repr(C)] struct LocalMatrix(pub [f32; 16]);    // 64 bytes — local-space model matrix
            struct Active;                        // 0 bytes (tag component)
```

| Componente | Default | Scopo |
|---|---|---|
| `Position` | `Vec3::ZERO` | Posizione world-space |
| `Rotation` | `Quat::IDENTITY` | Rotazione come quaternione |
| `Scale` | `Vec3::ONE` | Scala non-uniforme |
| `Velocity` | `Vec3::ZERO` | Velocita lineare (unita/secondo) |
| `ModelMatrix` | `Mat4::IDENTITY` | Matrice 4×4 per la GPU, ricalcolata ogni frame |
| `BoundingRadius` | `0.5` | Raggio della bounding sphere per GPU frustum culling |
| `TextureLayerIndex` | `0` | Indice texture packed: `(tier << 16) \| layer`. Tier seleziona il Texture2DArray, layer la slice |
| `PrimitiveParams` | `[0.0; 8]` | 8 float per entity, usati dai shader di linee/gradienti/box shadow/MSDF text. Split in due comandi ring buffer (SetPrimParams0 per [0..4], SetPrimParams1 per [4..8]) |
| `ExternalId` | Assegnato da SpawnEntity | ID esterno immutabile, set una volta allo spawn. Usato per SoA entity ID tracking (picking, immediate-mode) |
| `Parent` | — (not spawned by default) | External parent entity ID. Added via `SetParent` command |
| `Children` | `count: 0, ids: [0; 32]` | Fixed 32-slot inline array of child external IDs. No heap allocation. `remove()` returns `bool` |
| `OverflowChildren` | `items: Vec::new()` | Heap fallback for 33+ children. NOT `#[repr(C)]`/Pod. Attached when `Children.add()` returns false. Removed when empty |
| `LocalMatrix` | `Mat4::IDENTITY` | Local-space model matrix before parent transform. Used by `propagate_transforms` |
| `Active` | — | Marker component: entita attiva e simulabile |

**Perche `Active` e un marker component e non un bool?** In un ECS, i marker component permettono di filtrare le query senza overhead. `world.query::<&Active>()` itera solo le entita con il tag, usando l'archetype index di `hecs`. Un `bool` richiederebbe un branch per entita.

### CommandType (sincronizzato Rust ↔ TypeScript)

```
      Rust (ring_buffer.rs)                TypeScript (ring-buffer.ts)
      ─────────────────────                ─────────────────────────────
      #[repr(u8)]                          const enum CommandType {
      pub enum CommandType {                 Noop = 0,
          Noop = 0,                          SpawnEntity = 1,
          SpawnEntity = 1,                   DespawnEntity = 2,
          DespawnEntity = 2,                 SetPosition = 3,
          SetPosition = 3,                   SetRotation = 4,
          SetRotation = 4,                   SetScale = 5,
          SetScale = 5,                      SetVelocity = 6,
          SetVelocity = 6,                   SetTextureLayer = 7,
          SetTextureLayer = 7,               SetMeshHandle = 8,
          SetMeshHandle = 8,                 SetRenderPrimitive = 9,
          SetRenderPrimitive = 9,            SetParent = 10,
          SetParent = 10,                    SetPrimParams0 = 11,
          SetPrimParams0 = 11,               SetPrimParams1 = 12,
          SetPrimParams1 = 12,               SetListenerPosition = 13,
          SetListenerPosition = 13,        }
      }
```

I discriminanti `u8` **devono restare sincronizzati manualmente**. Non esiste code generation automatica tra Rust e TypeScript. Aggiungere un comando richiede la modifica di entrambi i file + la tabella `PAYLOAD_SIZES` in TypeScript + `payload_size()` in Rust.

**Payload sizes per CommandType**:

| CommandType | payload_size | message_size (1 + 4 + payload) |
| --- | --- | --- |
| Noop (0) | 0 | 5 |
| SpawnEntity (1) | 0 | 5 |
| DespawnEntity (2) | 0 | 5 |
| SetPosition (3) | 12 (3 × f32) | 17 |
| SetRotation (4) | 16 (4 × f32) | 21 |
| SetScale (5) | 12 (3 × f32) | 17 |
| SetVelocity (6) | 12 (3 × f32) | 17 |
| SetTextureLayer (7) | 4 (1 × u32) | 9 |
| SetMeshHandle (8) | 4 (1 × u32) | 9 |
| SetRenderPrimitive (9) | 4 (1 × u32) | 9 |
| SetParent (10) | 4 (1 × u32, 0xFFFFFFFF = unparent) | 9 |
| SetPrimParams0 (11) | 16 (4 × f32) | 21 |
| SetPrimParams1 (12) | 16 (4 × f32) | 21 |
| SetListenerPosition (13) | 12 (3 × f32) | 17 |

### Command

```rust
pub struct Command {
    pub cmd_type: CommandType,  // Discriminante del comando
    pub entity_id: u32,         // ID entita esterna (dal TS)
    pub payload: [u8; 16],      // Max 16 bytes (quaternione). Solo i primi
                                // cmd_type.payload_size() bytes sono significativi.
}
```

Il payload e un array fisso di 16 byte (il massimo — `SetRotation` usa 4 × f32 = 16). I comandi con payload piu piccolo (o nessuno) usano solo i primi N byte; il resto e zero-padded.

### EngineBridge (TypeScript)

```typescript
interface GPURenderState {
    entityCount: number;
    transforms: Float32Array;      // SoA: 16 f32/entity (mat4x4)
    bounds: Float32Array;          // SoA: 4 f32/entity (x, y, z, radius)
    renderMeta: Uint32Array;       // SoA: 1 u32/entity (packed render flags)
    texIndices: Uint32Array;       // SoA: 1 u32/entity (packed tier|layer)
    primParams: Float32Array;      // SoA: 8 f32/entity (shader params per primitive type)
    entityIds: Uint32Array;        // SoA: 1 u32/entity (external ID, CPU-only for picking)
    listenerX: number;             // Audio listener X (WASM-extrapolated)
    listenerY: number;             // Audio listener Y (WASM-extrapolated)
    listenerZ: number;             // Audio listener Z (WASM-extrapolated)
}

interface EngineBridge {
    mode: ExecutionMode;           // "A", "B", o "C"
    commandBuffer: BackpressuredProducer;  // Wraps RingBufferProducer con overflow queue
    tick(dt: number): void;        // flush() + Worker: postMessage. Mode C: sync call.
    ready(): Promise<void>;        // Risolve quando WASM e caricato.
    destroy(): void;               // Worker: terminate(). Mode C: noop.
    latestRenderState: GPURenderState | null;  // Ultimo stato render dal WASM
}
```

`EngineBridge` e il **contratto uniforme** tra il main loop e il backend di esecuzione. Il codice in `main.ts` non sa (e non deve sapere) se gira in Worker o in single-thread. Le factory `createWorkerBridge()`, `createFullIsolationBridge()` o `createDirectBridge()` restituiscono l'implementazione corretta. `latestRenderState` espone i dati GPU-ready (SoA buffers: transforms, bounds, renderMeta, texIndices) prodotti dall'ultimo tick WASM. Tutte e tre le factory wrappano `RingBufferProducer` in `BackpressuredProducer` per gestire overflow con coda prioritizzata. In Mode A/B, un `WorkerSupervisor` monitora il heartbeat del Worker con check ogni 1 secondo.

### Engine (Rust)

```rust
pub struct Engine {
    pub world: World,              // hecs ECS world
    pub entity_map: EntityMap,     // ID esterno → Entity interno
    accumulator: f32,              // Tempo residuo non ancora consumato da tick fissi
    tick_count: u64,               // Contatore monotono di tick fissi eseguiti
    listener_pos: [f32; 3],        // Audio listener position (from SetListenerPosition)
    listener_prev_pos: [f32; 3],   // Previous position (for velocity derivation)
    listener_vel: [f32; 3],        // Derived velocity (pos - prev) / FIXED_DT
}
```

**Audio listener extrapolation**: `process_commands()` intercepts `SetListenerPosition` before entity lookup (entity_id=0 is a sentinel). It derives velocity from `(new_pos - prev_pos) / FIXED_DT`. During `fixed_tick()`, the listener position is extrapolated: `listener_pos += listener_vel * FIXED_DT`. WASM exports `engine_listener_x/y/z()` expose the extrapolated position for TypeScript to read and forward to `PlaybackEngine`.

L'Engine e il **Mediator** che coordina tutti i sottosistemi. Non e un singleton nel senso classico — e wrappato in un `Option<Engine>` statico mutable solo perche WASM richiede un punto di accesso globale per le funzioni `#[wasm_bindgen]`. Su wasm32 (single-threaded per definizione), `static mut` e sicuro con adeguati commenti `// SAFETY`.

---

## 7. WASM Layer: Singletoni e Safety

**File**: `crates/hyperion-core/src/lib.rs`

Il layer WASM espone 27 funzioni esterne + 1 smoke test:

```rust
static mut ENGINE: Option<Engine> = None;
static mut RING_BUFFER: Option<RingBufferConsumer> = None;

// Core lifecycle
#[wasm_bindgen] pub fn engine_init()
#[wasm_bindgen] pub fn engine_attach_ring_buffer(ptr: *mut u8, capacity: usize)
#[wasm_bindgen] pub fn engine_push_commands(data: &[u8])
#[wasm_bindgen] pub fn engine_update(dt: f32)
#[wasm_bindgen] pub fn engine_tick_count() -> u64

// Legacy render state (model matrices only, 16 f32/entity)
#[wasm_bindgen] pub fn engine_render_state_count() -> u32
#[wasm_bindgen] pub fn engine_render_state_ptr() -> *const f32
#[wasm_bindgen] pub fn engine_render_state_f32_len() -> u32

// GPU-driven SoA buffers — transforms (16 f32/entity)
#[wasm_bindgen] pub fn engine_gpu_transforms_ptr() -> *const f32
#[wasm_bindgen] pub fn engine_gpu_transforms_f32_len() -> u32

// GPU-driven SoA buffers — bounds (4 f32/entity: x, y, z, radius)
#[wasm_bindgen] pub fn engine_gpu_bounds_ptr() -> *const f32
#[wasm_bindgen] pub fn engine_gpu_bounds_f32_len() -> u32

// GPU-driven SoA buffers — render meta (2 u32/entity)
#[wasm_bindgen] pub fn engine_gpu_render_meta_ptr() -> *const u32
#[wasm_bindgen] pub fn engine_gpu_render_meta_len() -> u32

// Entity count
#[wasm_bindgen] pub fn engine_gpu_entity_count() -> u32

// Texture layer indices (1 u32/entity, packed tier|layer)
#[wasm_bindgen] pub fn engine_gpu_tex_indices_ptr() -> *const u32
#[wasm_bindgen] pub fn engine_gpu_tex_indices_len() -> u32

// Primitive params (8 f32/entity, shader params)
#[wasm_bindgen] pub fn engine_gpu_prim_params_ptr() -> *const f32
#[wasm_bindgen] pub fn engine_gpu_prim_params_f32_len() -> u32

// Entity IDs (1 u32/entity, external ID for picking)
#[wasm_bindgen] pub fn engine_gpu_entity_ids_ptr() -> *const u32
#[wasm_bindgen] pub fn engine_gpu_entity_ids_len() -> u32

// Memory compaction (Phase 5)
#[wasm_bindgen] pub fn engine_compact_entity_map()
#[wasm_bindgen] pub fn engine_compact_render_state()
#[wasm_bindgen] pub fn engine_entity_map_capacity() -> u32

// Audio listener position (Phase 7.5) — extrapolated by WASM fixed ticks
#[wasm_bindgen] pub fn engine_listener_x() -> f32
#[wasm_bindgen] pub fn engine_listener_y() -> f32
#[wasm_bindgen] pub fn engine_listener_z() -> f32

#[wasm_bindgen] pub fn add(a: i32, b: i32) -> i32  // smoke test
```

Le funzioni GPU-driven espongono 6 buffer SoA paralleli. `engine_gpu_transforms_*` e `engine_gpu_bounds_*` sono i dati geometrici, `engine_gpu_render_meta_*` contiene mesh handle + primitive type packed, `engine_gpu_tex_indices_*` le texture, `engine_gpu_prim_params_*` i parametri shader, e `engine_gpu_entity_ids_*` gli ID esterni per picking. Tutti i buffer sono indicizzati con lo stesso ordine delle entita in `engine_gpu_entity_count()`.

**Perche `static mut` e safe qui?** `wasm32-unknown-unknown` e single-threaded per specifica. Non esiste parallelismo reale — anche con `SharedArrayBuffer`, il modulo WASM gira su un singolo thread. Ogni `unsafe` block ha un commento `// SAFETY` che documenta questa invariante.

**Perche `addr_of_mut!()` invece di `&mut`?** Rust 2024 edition rende UB la creazione di riferimenti a `static mut` non inizializzati. `addr_of_mut!(ENGINE).write(Some(...))` scrive attraverso un raw pointer senza mai creare un `&mut Option<Engine>`, evitando il problema.

**Perche `engine_tick_count()` restituisce `u64` (che diventa `BigInt` in JS)?** Il tick counter puo superare 2^32 dopo ~828 giorni di esecuzione continua. `wasm-bindgen` mappa `u64` a `BigInt` automaticamente. Il Worker wrappa con `Number(...)` che e safe per valori < 2^53 (~2.85 × 10^8 anni).

---

## 8. Worker Architecture

### Ciclo di Vita del Worker

**File**: `ts/src/engine-worker.ts`

```
Main Thread                                  Engine Worker
────────────                                 ─────────────
postMessage({type:"init", commandBuffer})
    ──────────────────────────────────>
                                             import("../wasm/hyperion_core.js")
                                             await wasm.default()
                                             wasm.engine_init()
                                             store commandBufferRef
    <──────────────────────────────────
postMessage({type:"ready"})

[RAF loop starts]

postMessage({type:"tick", dt: 0.016})
    ──────────────────────────────────>
                                             wasm.engine_update(msg.dt)
                                             tickCount = Number(wasm.engine_tick_count())
    <──────────────────────────────────
postMessage({type:"tick-done", dt, tickCount})
```

### Messaggi Worker

| Messaggio | Direzione | Payload | Scopo |
|---|---|---|---|
| `init` | Main → Worker | `{ commandBuffer: SharedArrayBuffer }` | Passa il SAB e avvia init WASM |
| `ready` | Worker → Main | `{}` | Segnala che WASM e pronto |
| `error` | Worker → Main | `{ error: string }` | Errore durante init |
| `tick` | Main → Worker | `{ dt: number }` | Richiede un frame update |
| `tick-done` | Worker → Main | `{ dt, tickCount }` | Conferma completamento frame |

### Stato del Ring Buffer nel Worker

Il collegamento ring buffer SAB → WASM e stato completato in Phase 2 tramite il pattern `engine_push_commands`:

1. Il Worker riceve il SAB durante `init` e lo conserva in `commandBufferRef`
2. Prima di ogni `engine_update(dt)`, il Worker legge i comandi dal SAB e li serializza nella memoria lineare WASM via `engine_push_commands(ptr, len)`
3. `engine_update(dt)` consuma i comandi dal buffer interno e processa la simulazione

Questo evita il problema di passare un puntatore SAB direttamente nella memoria lineare WASM (che `wasm-bindgen` non supporta nativamente per SharedArrayBuffer). Il Worker funge da intermediario: legge dal SAB con `DataView`, poi scrive nella memoria WASM con `Uint8Array`.

---

## 9. Architettura a Strati (Layered)

```
+═══════════════════════════════════════════════════════════════+
║                    Browser Entry (HTML + Vite)                ║
║  index.html → <script type="module" src="main.ts">           ║
+═══════════════════════════════════════════════════════════════+
║                   Public API Layer (TS — Phase 5-8)            ║
║  hyperion.ts   → Hyperion facade (create, spawn, batch,      ║
║                   start/pause/resume/destroy, plugins, hooks, ║
║                   selection, input, picking, audio, outlines, ║
║                   profiler, recompileShader)                  ║
║  entity-handle → EntityHandle fluent builder + EntityPool     ║
║  game-loop.ts  → GameLoop (RAF + hooks + frame time tracking)║
║  camera-api.ts → CameraAPI (zoom, viewProjection, x/y pos)  ║
║  raw-api.ts    → RawAPI (low-level numeric entity mgmt)      ║
║  plugin.ts     → PluginRegistry (v2: PluginContext, deps,    ║
║                   error boundaries)                           ║
║  plugin-context → PluginContext (5 sub-APIs: systems, events,║
║                   rendering, gpu, storage)                    ║
║  event-bus.ts  → EventBus (typed pub/sub for plugins)        ║
║  profiler.ts   → ProfilerOverlay (DOM-based perf stats)      ║
║  types.ts      → HyperionConfig, HyperionStats, MemoryStats ║
║  leak-detector → LeakDetector (FinalizationRegistry backstop)║
║  index.ts      → Barrel export                               ║
+═══════════════════════════════════════════════════════════════+
║               Input & Selection Layer (TS — Phase 6)          ║
║  input-manager  → InputManager (keyboard/pointer/scroll)     ║
║  hit-tester     → hitTestRay() CPU ray-sphere picking        ║
║  immediate-state→ ImmediateState shadow position map          ║
║  selection      → SelectionManager (CPU Set + GPU mask)       ║
+═══════════════════════════════════════════════════════════════+
║                  Audio Layer (TS — Phase 7)                   ║
║  audio-manager  → AudioManager facade (lazy AudioContext)     ║
║  sound-registry → SoundRegistry (URL-deduplicated buffers)   ║
║  playback-engine→ PlaybackEngine (Web Audio node graph)      ║
║  audio-types    → SoundHandle, PlaybackId branded types      ║
+═══════════════════════════════════════════════════════════════+
║                   Orchestration Layer (TS)                    ║
║  main.ts → Hyperion.create() → engine.start()                ║
+═══════════════════════════════════════════════════════════════+
║                   Bridge Layer (TS)                           ║
║  worker-bridge.ts → EngineBridge + GPURenderState interface   ║
║    createWorkerBridge() — Mode B (Worker + SAB)               ║
║    createFullIsolationBridge() — Mode A (Worker + Render Wkr) ║
║    createDirectBridge() — Mode C (direct + ArrayBuffer)       ║
+═══════════════════════════════════════════════════════════════+
║               Communication Layer (TS ↔ Rust)                 ║
║  ring-buffer.ts → RingBufferProducer (Atomics, DataView)      ║
║  ring_buffer.rs → RingBufferConsumer (AtomicU32, raw ptr)     ║
║  SharedArrayBuffer: [header 32B][data region]                 ║
+═══════════════════════════════════════════════════════════════+
║               GPU-Driven Render Layer (TS + WebGPU)           ║
║  renderer.ts         → RenderGraph coordinator (multi-pipeline)║
║  texture-manager.ts  → Multi-tier Texture2DArray (lazy alloc) ║
║  render/render-graph  → DAG pass scheduling (Kahn's sort)     ║
║  render/render-pass   → RenderPass interface + ResourcePool   ║
║  render/passes/       → CullPass, ForwardPass, FXAATonemapPass║
║                         SelectionSeedPass, JFAPass,           ║
║                         OutlineCompositePass, prefix-sum       ║
║  camera.ts           → Orthographic projection + frustum +    ║
║                         mat4Inverse + screenToRay             ║
║  backpressure.ts     → PrioritizedCommandQueue                ║
║  supervisor.ts       → Worker heartbeat monitoring            ║
║  text/               → FontAtlas + text layout + TextManager  ║
║  shaders/            → cull, basic, line, gradient, box-shadow║
║                        msdf-text, fxaa-tonemap, selection-seed║
║                        jfa, outline-composite, prefix-sum     ║
+═══════════════════════════════════════════════════════════════+
║                   Simulation Layer (Rust/WASM)                ║
║  lib.rs       → WASM exports (engine_init, engine_update,     ║
║                  engine_gpu_data_ptr, engine_gpu_tex_indices)  ║
║  engine.rs    → Fixed-timestep accumulator, tick loop         ║
║  command_processor.rs → EntityMap + process_commands()         ║
║  render_state.rs → collect_gpu(): SoA buffers (transforms/    ║
║                    bounds/meta/texIndices) + DirtyTracker      ║
+═══════════════════════════════════════════════════════════════+
║                     ECS Layer (Rust)                          ║
║  components.rs → Position, Rotation, Scale, Velocity,         ║
║                   ModelMatrix, BoundingRadius,                 ║
║                   TextureLayerIndex, MeshHandle,               ║
║                   RenderPrimitive, PrimitiveParams,            ║
║                   ExternalId, Active, Parent,                  ║
║                   Children, OverflowChildren, LocalMatrix      ║
║  systems.rs    → velocity_system, transform_system,           ║
║                   propagate_transforms, count_active           ║
║  hecs::World   → Archetype storage, component queries         ║
+═══════════════════════════════════════════════════════════════+
║                    Math Foundation (Rust)                     ║
║  glam::Vec3, glam::Quat, glam::Mat4 — SIMD-accelerated      ║
║  bytemuck::Pod — safe transmute to GPU-uploadable bytes       ║
+═══════════════════════════════════════════════════════════════+
```

Ogni strato dipende solo dallo strato immediatamente inferiore. I componenti ECS non sanno nulla del ring buffer. Il ring buffer non sa nulla del Worker. Il bridge non sa nulla di `requestAnimationFrame`. Questo permette di testare ogni strato in isolamento.

---

## 10. Pipeline di Rendering (Phase 2-4: GPU-Driven)

### Scelta Architetturale: WebGPU da TypeScript, non Rust wgpu

La scelta di gestire il rendering interamente da TypeScript con l'API WebGPU nativa del browser, invece di compilare `wgpu` (la libreria Rust) a WASM, e motivata da tre fattori:

1. **Binary bloat**: `wgpu` compilato a WASM aggiunge ~1MB al `.wasm` compresso. La API WebGPU del browser e gia disponibile nativamente — wrappare la stessa API con un layer Rust e puro overhead.
2. **Accesso diretto**: TypeScript ha accesso diretto a `navigator.gpu`, `GPUDevice`, `GPUBuffer`, `GPURenderPipeline` senza FFI. Ogni chiamata Rust→JS per operazioni GPU attraverserebbe il boundary WASM inutilmente.
3. **Ecosistema shader**: WGSL e il linguaggio shader nativo di WebGPU. Caricare shader `.wgsl` da TypeScript via Vite `?raw` e zero-overhead. Da Rust, servirebbe un meccanismo di embedding o di passaggio stringa attraverso FFI.

La separazione e netta: Rust/WASM produce dati GPU-ready (entity data come buffer contigui di f32/u32), TypeScript li uploada nella GPU e gestisce l'intera pipeline di rendering.

### Architettura del Renderer (RenderGraph Coordinator)

**File**: `ts/src/renderer.ts`

Il renderer usa un pattern **RenderGraph coordinator** con compute culling e indirect draw. `createRenderer()` crea un `ResourcePool` con buffer GPU condivisi, wires `CullPass` + `ForwardPass`, compila un `RenderGraph` DAG, e restituisce un'interfaccia `Renderer`. Ogni frame: (1) uploada i buffer SoA nella GPU, (2) `CullPass` esegue frustum culling per-entity, (3) `ForwardPass` renderizza le entita visibili via `drawIndexedIndirect`.

```
                renderer.render(state: GPURenderState, camera)
                                         │
          ┌──────────────────────────────┼────────────────────────────┐
          ▼                              ▼                            ▼
  writeBuffer(transforms)     writeBuffer(bounds)         setTextureView('swapchain')
  16 f32/entity (mat4x4)     4 f32/entity (sphere)        context.getCurrentTexture()
          │                              │                            │
          ▼                              ▼                            │
  writeBuffer(texIndices)     writeBuffer(renderMeta)                 │
  1 u32/entity                1 u32/entity                           │
          │                              │                            │
          └──────────────┬───────────────┘                            │
                         ▼                                            │
              ┌─── CullPass.prepare() ──────────────┐                 │
              │  extractFrustumPlanes(camera.vp)     │                 │
              │  writeBuffer(cullUniforms, planes+N) │                 │
              │  writeBuffer(indirectArgs, reset)     │                 │
              └────────────────────┬────────────────┘                  │
                                   ▼                                   │
              ┌─── CullPass.execute() ──────────────┐                  │
              │  cull.wgsl: workgroup_size(256)       │                  │
              │  per-entity: sphere vs 6 planes      │                  │
              │  visible → atomicAdd(instanceCount)  │                  │
              │         → visibleIndices[slot] = idx │                  │
              │  Output: indirect draw args           │                  │
              └────────────────────┬────────────────┘                  │
                                   ▼                                   │
              ┌─── ForwardPass.prepare() ───────────┐                  │
              │  writeBuffer(cameraBuf, viewProj)    │                  │
              └────────────────────┬────────────────┘                  │
                                   ▼                                   │
              ┌─── ForwardPass.execute() ───────────┐                  │
              │  ensureDepthTexture(w, h)            │◄─────────────────┘
              │  vertex: visibleIndices[inst_id]     │
              │    → transforms[idx] → model mat    │
              │    → texLayerIndices[idx] → tier,lay│
              │  fragment: switch(tier)               │
              │    → textureSample(tierN, uv, layer) │
              │  drawIndexedIndirect(indirectBuffer)  │
              └────────────────────┬────────────────┘
                                   ▼
                   graph.render(device, frameState, resources)
                                   ▼
                         queue.submit([encoder])
```

**Costanti**:

| Costante | Valore | Scopo |
| --- | --- | --- |
| `MAX_ENTITIES` | 100,000 | Limite massimo entita supportate |
| `INDIRECT_BUFFER_SIZE` | 120 bytes | 6 tipi × 5 × u32 (drawIndexedIndirect args per tipo primitivo) |

**Buffer layout GPU (SoA — Structure of Arrays)**:

| Buffer | Nome ResourcePool | Tipo | Contenuto | Aggiornamento |
| --- | --- | --- | --- | --- |
| Transforms | `entity-transforms` | `STORAGE \| COPY_DST` | `[mat4×4]` × N (16 f32/entity) | Ogni frame via `writeBuffer` |
| Bounds | `entity-bounds` | `STORAGE \| COPY_DST` | `[vec4f]` × N (x, y, z, radius) | Ogni frame via `writeBuffer` |
| Render meta | `render-meta` | `STORAGE \| COPY_DST` | `[u32]` × N (packed render flags) | Ogni frame via `writeBuffer` |
| Tex indices | `tex-indices` | `STORAGE \| COPY_DST` | `[u32 packed]` × N (tier\|layer) | Ogni frame via `writeBuffer` |
| Prim params | `prim-params` | `STORAGE \| COPY_DST` | `[f32]` × 8N (shader params) | Ogni frame via `writeBuffer` |
| Selection mask | `selection-mask` | `STORAGE \| COPY_DST` | `[u32]` × ceil(N/32) (bitfield) | Su dirty flag via `SelectionManager.uploadMask()` |
| Cull uniforms | (CullPass internal) | `UNIFORM \| COPY_DST` | 6 × vec4 frustum planes + u32 count | Ogni frame in `CullPass.prepare()` |
| Camera uniform | (ForwardPass internal) | `UNIFORM \| COPY_DST` | `mat4×4 viewProjection` | Ogni frame in `ForwardPass.prepare()` |
| Visible indices | `visible-indices` | `STORAGE` | `[u32]` × MAX_ENTITIES | Scritto dal compute shader |
| Indirect draw args | `indirect-args` | `STORAGE \| INDIRECT \| COPY_DST` | 6 × 5 × u32 (120 bytes, per-type) | Reset in `CullPass.prepare()` + atomicAdd dal compute |
| Depth texture | (ForwardPass internal) | `GPUTexture` | `depth24plus` | Lazy creato/ricreato al resize via `ensureDepthTexture()` |
| Vertex/Index buffer | (ForwardPass internal) | `VERTEX \| INDEX` | Unit quad (4 vertices + 6 indices) | Creato in `ForwardPass.setup()`, immutabile |
| Scene HDR | `scene-hdr` | `GPUTexture` (rgba16float) | HDR render target | ForwardPass output, FXAATonemapPass/OutlineComposite input |
| Selection seed | `selection-seed` | `GPUTexture` | JFA seed positions | SelectionSeedPass output, JFAPass input |
| JFA ping-pong | `jfa-a`, `jfa-b` | `GPUTexture` | JFA iteration textures | Ping-pong between JFA iterations |
| Texture views | `tier0`–`tier3` | `GPUTextureView` | Texture2DArray tier views | Registrati in ResourcePool da coordinator |
| Sampler | `texSampler` | `GPUSampler` | Linear filtering sampler | Registrato in ResourcePool da coordinator |
| Swapchain | `swapchain` | `GPUTextureView` | Current frame's swapchain texture view | Settato ogni frame dal coordinator |

### Pipeline Compute: Frustum Culling (cull.wgsl)

**File**: `ts/src/shaders/cull.wgsl`

Il compute shader esegue frustum culling sulla GPU, testando la bounding sphere di ogni entita contro i 6 piani del frustum. Ogni thread processa una singola entita. I buffer di input sono **SoA** (Structure of Arrays): transforms e bounds sono buffer separati, non un monolitico `EntityData`.

```
// SoA bindings (non piu EntityData monolitico)
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;    // model matrices
@group(0) @binding(2) var<storage, read> bounds: array<vec4f>;            // xyz=pos, w=radius

struct CullUniforms {
    frustumPlanes: array<vec4f, 6>,
    totalEntities: u32,
    _pad0: u32, _pad1: u32, _pad2: u32   // allineamento a 16 bytes
}

struct DrawIndirectArgs {
    indexCount: u32,
    instanceCount: atomic<u32>,   // scritto atomicamente dai thread
    firstIndex: u32,
    baseVertex: u32,
    firstInstance: u32,
}
```

**Algoritmo** (per-thread):

1. `global_id.x >= totalEntities` → return (guard)
2. Leggi `bounds[entity_idx]` per ottenere center (xyz) e raggio (w)
3. Per ognuno dei 6 piani del frustum: `dist = dot(plane.xyz, center) + plane.w`
4. Se `dist < -radius` per qualsiasi piano → entita completamente fuori → skip
5. Altrimenti: `slot = atomicAdd(&drawArgs.instanceCount, 1)` → `visibleIndices[slot] = entity_idx`

**Bind group del compute** (group 0):

- Binding 0: Cull uniforms (uniform, read)
- Binding 1: Transforms — `array<mat4x4f>` (storage, read)
- Binding 2: Bounds — `array<vec4f>` (storage, read)
- Binding 3: Visible indices (storage, read-write)
- Binding 4: Indirect draw args (storage, read-write)

**CullPass lifecycle**: `setup()` crea il pipeline e bind group. `prepare()` estrae i frustum planes da `frame.cameraViewProjection` via `extractFrustumPlanes()` (importata da `camera.ts`), uploada i cull uniforms, e resetta i **6 × 5 u32** indirect draw args (uno per tipo primitivo: Quad, Line, SDFGlyph, BezierPath, Gradient, BoxShadow). Il compute shader scrive `visibleIndices` e incrementa atomicamente `instanceCount` nell'args del tipo corrispondente. `execute()` dispatcha `ceil(entityCount / 256)` workgroups.

### Pipeline Render: Visibility Indirection (basic.wgsl)

**File**: `ts/src/shaders/basic.wgsl`

Il render shader usa **visibility indirection**: il vertex shader non legge direttamente dall'instance_index, ma lo usa come indice nel `visibleIndices` buffer per ottenere l'indice reale dell'entita nei buffer SoA.

```
// Bind Group 0 (Vertex stage) — SoA layout
@group(0) @binding(0) var<uniform> camera: CameraUniform;        // viewProjection mat4x4
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;    // SoA: model matrices
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;     // dal compute
@group(0) @binding(3) var<storage, read> texLayerIndices: array<u32>;    // packed tier|layer

// Bind Group 1 (Fragment stage) — Multi-tier Texture2DArrays
@group(1) @binding(0) var tier0Tex: texture_2d_array<f32>;   // 64×64
@group(1) @binding(1) var tier1Tex: texture_2d_array<f32>;   // 128×128
@group(1) @binding(2) var tier2Tex: texture_2d_array<f32>;   // 256×256
@group(1) @binding(3) var tier3Tex: texture_2d_array<f32>;   // 512×512
@group(1) @binding(4) var texSampler: sampler;

@vertex fn vs_main(@builtin(instance_index) instIdx: u32, ...) -> VertexOutput {
    let entityIdx = visibleIndices[instIdx];           // indirection
    let model = transforms[entityIdx];                  // SoA: direct mat4x4f
    let packed = texLayerIndices[entityIdx];             // texture index
    let tier = packed >> 16u;
    let layer = packed & 0xFFFFu;
    // transform position, compute UV, pass tier+layer as flat
}

@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    switch(in.texTier) {                                // WGSL non supporta dynamic indexing
        case 0u: { return textureSample(tier0Tex, texSampler, in.uv, in.texLayer); }
        case 1u: { return textureSample(tier1Tex, texSampler, in.uv, in.texLayer); }
        case 2u: { return textureSample(tier2Tex, texSampler, in.uv, in.texLayer); }
        case 3u: { return textureSample(tier3Tex, texSampler, in.uv, in.texLayer); }
        default: { return vec4f(1.0, 0.0, 1.0, 1.0); } // magenta = errore
    }
}
```

Il `drawIndexedIndirect` legge `instanceCount` dal buffer indirect — gia scritto dal compute shader. Solo le entita che hanno passato il frustum culling vengono renderizzate. Il vertex shader risolve l'indice reale tramite `visibleIndices[instance_index]`.

**ForwardPass lifecycle**: `setup()` crea **multiple render pipeline** (una per tipo primitivo registrato in `SHADER_SOURCES: Record<number, string>`), vertex/index buffer (unit quad), camera buffer, e bind groups condivisi. `prepare()` uploada `frame.cameraViewProjection` nel camera buffer. `execute()` assicura la depth texture via `ensureDepthTexture()`, poi per ogni tipo primitivo registrato: seleziona il pipeline corrispondente e chiama `drawIndexedIndirect(indirectBuffer, primType * 20)`. Scrive su `scene-hdr` (non direttamente su swapchain).

### TextureManager: Multi-Tier Texture2DArray

**File**: `ts/src/texture-manager.ts`

`TextureManager` gestisce un sistema di texture organizzato in **4 tier** (livelli di risoluzione), ognuno implementato come `GPUTexture` di tipo `texture_2d_array`. Ogni tier supporta fino a 256 layer (slice).

| Tier | Risoluzione | GPU Memory (RGBA8, 256 layers) |
| --- | --- | --- |
| 0 | 64 × 64 | ~4 MB |
| 1 | 128 × 128 | ~16 MB |
| 2 | 256 × 256 | ~64 MB |
| 3 | 512 × 512 | ~256 MB |

**Algoritmo di selezione tier**: `selectTier(width, height)` sceglie il tier piu piccolo che contiene `max(width, height)`. Immagini > 512px vengono clamped al tier 3.

**Indice packed (u32)**: `(tier << 16) | layer`. Il tier seleziona quale Texture2DArray usare; il layer seleziona la slice. Questo encoding e lo stesso usato da `TextureLayerIndex` in Rust.

**Pipeline di caricamento texture**:

1. `fetch(url)` → `Response.blob()`
2. `createImageBitmap(blob, { resizeWidth, resizeHeight })` — ridimensiona alla risoluzione del tier
3. `device.queue.copyExternalImageToTexture(imageBitmap, { texture, origin: [0, 0, layer] })`
4. Ritorna il packed index `(tier << 16) | layer`

**Features**:

- **Layer 0 di ogni tier**: texture bianca di default (1×1 px espanso)
- **Concurrency limiter**: massimo 6 fetch concorrenti
- **URL caching**: deduplicazione — stessa URL → stesso packed index
- **Progress callback**: `onProgress(loaded, total)` per loading bars
- **Tier override manuale**: per forzare la risoluzione

### RenderState: Ponte Rust → TypeScript per i Dati GPU

**File Rust**: `crates/hyperion-core/src/render_state.rs`

`RenderState` colleziona i dati GPU di tutte le entita attive in buffer SoA (Structure-of-Arrays) paralleli:

```rust
pub struct RenderState {
    pub matrices: Vec<[f32; 16]>,      // Legacy: solo model matrices
    gpu_transforms: Vec<f32>,          // SoA: 16 f32/entity (mat4x4 column-major)
    gpu_bounds: Vec<f32>,              // SoA: 4 f32/entity (x, y, z, radius)
    gpu_render_meta: Vec<u32>,         // SoA: 2 u32/entity (mesh_handle + primitive)
    gpu_tex_indices: Vec<u32>,         // SoA: 1 u32/entity (packed tier|layer)
    gpu_prim_params: Vec<f32>,         // SoA: 8 f32/entity (shader params)
    gpu_entity_ids: Vec<u32>,          // SoA: 1 u32/entity (external ID, CPU-only)
    gpu_count: u32,                    // Numero entita nei buffer GPU
    pub dirty_tracker: DirtyTracker,   // BitSet per partial upload optimization
}
```

`collect_gpu()` itera tutte le entita con `(Position, ModelMatrix, BoundingRadius, TextureLayerIndex, MeshHandle, RenderPrimitive, PrimitiveParams, ExternalId, Active)`:

- **gpu_transforms**: 16 f32 per entita (model matrix column-major)
- **gpu_bounds**: 4 f32 per entita (position.x, position.y, position.z, radius)
- **gpu_render_meta**: 2 u32 per entita (mesh_handle packed con primitive type)
- **gpu_tex_indices**: 1 u32 per entita, packed `(tier << 16) | layer`
- **gpu_prim_params**: 8 f32 per entita (parametri shader per linee/gradienti/box shadow/MSDF)
- **gpu_entity_ids**: 1 u32 per entita (external ID per picking e immediate-mode, CPU-only)

Tutti i buffer sono indicizzati con lo stesso ordine — l'entita all'indice N in `gpu_transforms` corrisponde all'indice N in tutti gli altri buffer.

**Trasferimento dati per Execution Mode**:

| Mode | Meccanismo di Trasferimento | Latenza |
| --- | --- | --- |
| **Mode C** (Single Thread) | Vista diretta sulla WASM linear memory via `engine_gpu_data_ptr()` + `Float32Array` view | Zero-copy |
| **Mode B** (Partial Isolation) | `postMessage` con `ArrayBuffer` trasferibile dal Worker al Main Thread | Transfer (no copy) |
| **Mode A** (Full Isolation) | `MessageChannel` tra ECS Worker e Render Worker, con `ArrayBuffer` trasferibile | Transfer (no copy) |

In Mode C, il renderer accede direttamente alla memoria WASM. I dati vengono raccolti come `GPURenderState` (SoA buffers) e passati al renderer:

```typescript
// Il bridge Mode C raccoglie i buffer SoA dal WASM e li espone come latestRenderState
// renderer.render() accetta GPURenderState + camera
renderer.render(bridge.latestRenderState, camera);
```

### Sistema Camera: Proiezione Ortografica + Frustum Planes

**File**: `ts/src/camera.ts`

La camera usa una **proiezione ortografica** appropriata per un engine 2D/2.5D. Espone anche l'estrazione dei piani del frustum per il compute culling.

**Funzioni esportate**:

- `orthographic(left, right, bottom, top, near, far): Float32Array` — matrice 4×4
- `extractFrustumPlanes(vp: Float32Array): Float32Array` — 24 float (6 piani × vec4)
- `isPointInFrustum(planes, x, y, z): boolean` — test punto
- `isSphereInFrustum(planes, cx, cy, cz, radius): boolean` — test sfera (usato dal CPU fallback)
- `class Camera` — `setOrthographic()`, `setPosition()`, `get viewProjection`

**Parametri**:

| Parametro | Default | Descrizione |
| --- | --- | --- |
| `width` | Canvas width | Larghezza del frustum in unita mondo |
| `height` | Canvas height | Altezza del frustum |
| `near` | 0.0 | Piano near (WebGPU depth range 0..1) |
| `far` | 100.0 | Piano far |
| `position` | `[0, 0, 0]` | Posizione della camera nello spazio mondo |

**Depth range 0..1**: WebGPU usa un depth range normalizzato `[0.0, 1.0]` (a differenza di OpenGL che usa `[-1.0, 1.0]`). La matrice ortografica mappa `[near, far]` a `[0.0, 1.0]` usando la formula:

```
depth_ndc = (z - near) / (far - near)
```

**Estrazione piani del frustum**: `extractFrustumPlanes()` estrae i 6 piani (left, right, bottom, top, near, far) dalla matrice view-projection usando il metodo di Gribb-Hartmann. Ogni piano e normalizzato (normal.length = 1) per permettere il test di distanza sfera-piano nel compute shader. `CullPass` importa `extractFrustumPlanes` direttamente da `camera.ts` — non ci sono piu duplicazioni.

### Pattern `engine_push_commands`: Bridge SAB → WASM

Il collegamento tra il ring buffer su SharedArrayBuffer e la memoria lineare WASM e stato il problema architetturale piu significativo risolto in Phase 2. `wasm-bindgen` non supporta il passaggio diretto di puntatori a SharedArrayBuffer nella memoria lineare WASM.

**Soluzione adottata**: Il Worker TypeScript funge da intermediario.

```
                TS (Producer)              Worker (Intermediario)              WASM (Consumer)
                ─────────────              ──────────────────────              ────────────────
                RingBufferProducer
                .spawnEntity(id)
                      │
                      ▼
                SharedArrayBuffer
                [write_head][read_head]
                [cmd|eid|payload|...]
                                           1. Leggi write_head dal SAB
                                           2. Leggi comandi dal SAB
                                              (DataView, little-endian)
                                           3. Crea Uint8Array con i comandi
                                              │
                                              ▼
                                           4. wasm.engine_push_commands(ptr, len)
                                              Copia i byte nella WASM
                                              linear memory
                                                                               5. Engine::push_commands()
                                                                                  Parsa i comandi dal buffer
                                                                               6. engine_update(dt)
                                                                                  Consuma i comandi
```

`engine_push_commands(ptr, len)` riceve un puntatore alla WASM linear memory dove il Worker ha scritto i byte dei comandi. La funzione WASM decodifica i comandi dal buffer binario (stesso formato del ring buffer) e li aggiunge al `Vec<Command>` interno dell'Engine.

Questo pattern aggiunge un singolo passaggio di copia (SAB → WASM linear memory), ma:
- E una copia contigua in memoria (molto cache-friendly)
- Avviene una volta per frame, non per comando
- E l'unica soluzione che rispetta i vincoli di `wasm-bindgen`

---

## 11. Testing

### Struttura (99 test Rust across 7 moduli + 409 test TypeScript across 41 file)

Il test suite e organizzato in due livelli per linguaggio:

**Rust** — Unit test inline `#[cfg(test)] mod tests` in ogni modulo:

```
crates/hyperion-core/src/
  ring_buffer.rs          19 test: empty drain, spawn read, position+payload, multiple cmds,
                                   read_head advance, parse_commands (spawn, position, multiple,
                                   incomplete, empty, set_texture_layer, set_parent, set_mesh_handle,
                                   set_render_primitive, set_listener_position), header size,
                                   set_prim_params round-trip
  components.rs           23 test: default values, Pod transmute, texture layer pack/unpack,
                                   MeshHandle/RenderPrimitive defaults + custom values,
                                   PrimitiveParams Pod + default, ExternalId,
                                   Parent/Children/LocalMatrix defaults + Pod + child add/remove,
                                   OverflowChildren heap fallback
  command_processor.rs    15 test: spawn, set position, despawn, ID recycling, set_texture_layer,
                                   set_mesh_handle, set_render_primitive, nonexistent entity safety,
                                   set_parent with child bookkeeping, shrink_to_fit,
                                   process_set_prim_params, spawn_sets_external_id,
                                   set_parent_with_max_sentinel_unparents,
                                   overflow_children heap fallback, set_listener_position
  engine.rs                9 test: commands+ticks integration, accumulator, spiral-of-death, model matrix,
                                   render_state collected after update, propagate parent transforms,
                                   listener position extrapolation
  systems.rs               7 test: velocity moves position, transform→matrix, transform applies scale,
                                   count_active, propagate_transforms applies parent matrix,
                                   propagate_transforms skips unparented
  render_state.rs         27 test: collect matrices, clear previous, ptr null/valid, collect_gpu single/
                                   multiple, skip without bounding radius, texture layer indices,
                                   empty tex indices, SoA buffers, bounds, render meta, prim params,
                                   entity IDs, BitSet (set/get, idempotent, OOB, clear, ensure_capacity),
                                   DirtyTracker (mark/check, clear, ratio, ensure_capacity, meta),
                                   shrink_to_fit
```

**TypeScript** — File `.test.ts` colocati in `ts/src/`:

```
ts/src/
  capabilities.test.ts              4 test: Mode A/B/C selection across capability combinations
  ring-buffer.test.ts               17 test: free space, spawn write, position+payload, overflow, sequential,
                                           SetTextureLayer, TypedArray fast path, wrap-around,
                                           SetListenerPosition
  ring-buffer-utils.test.ts          4 test: ring buffer utility functions (extractUnread)
  camera.test.ts                    19 test: orthographic NDC mapping, Camera class, frustum planes,
                                           mat4Inverse, screenToRay
  frustum.test.ts                    7 test: frustum culling accuracy (sphere-plane tests)
  texture-manager.test.ts           16 test: tier selection, packing/unpacking, lazy alloc, exponential growth,
                                           retainBitmaps option
  backpressure.test.ts              18 test: priority ordering, soft/hard limits, critical bypass,
                                           BackpressuredProducer pass-through/overflow/flush,
                                           setParent/setMeshHandle/setRenderPrimitive/setPrimParams convenience
  supervisor.test.ts                 5 test: heartbeat monitoring, timeout detection, configurable threshold
  render/render-pass.test.ts         6 test: ResourcePool CRUD, pass contract validation
  render/render-graph.test.ts        8 test: topological ordering, dead-pass culling, cycle detection,
                                           lazy recompile, duplicate names, empty graph, multiple writers
  render/passes/cull-pass.test.ts    2 test: CullPass construction, extraction
  render/passes/forward-pass.test.ts 2 test: ForwardPass construction, multi-pipeline
  render/passes/fxaa-tonemap-pass.test.ts   3 test: FXAATonemapPass construction, tonemap modes
  render/passes/selection-seed-pass.test.ts 3 test: SelectionSeedPass construction, seed rendering
  render/passes/jfa-pass.test.ts            9 test: JFA iterations, ping-pong, iterationsForDimension
  render/passes/outline-composite-pass.test.ts 6 test: OutlineComposite construction, SDF outline, FXAA
  render/passes/prefix-sum.test.ts   6 test: Blelloch scan correctness (simple, all-visible, all-invisible,
                                           single element, non-power-of-2, compacted indices)
  integration.test.ts                5 test: binary protocol, texture pipeline, GPU data format
  hyperion.test.ts                  55 test: Hyperion facade lifecycle, spawn, batch, hooks,
                                           plugins, destroy, stats, compact, resize, input, picking,
                                           audio, selection, outlines, immediate mode, profiler,
                                           shader hot-reload, PluginContext
  entity-handle.test.ts             28 test: fluent API, dispose, data map, pool recycling,
                                           positionImmediate, clearImmediate, line, gradient, boxShadow
  entity-pool.test.ts                5 test: acquire/release, capacity limit, init reset
  game-loop.test.ts                 11 test: RAF lifecycle, hook phases, FPS tracking, frame timing
  raw-api.test.ts                    4 test: spawn/despawn/setPosition/setVelocity
  camera-api.test.ts                 3 test: zoom clamping, viewProjection delegation
  plugin.test.ts                    13 test: install, cleanup, destroyAll, dependency resolution,
                                           error boundaries
  types.test.ts                      4 test: config defaults, type validation
  leak-detector.test.ts              2 test: registration, cleanup callback
  selection.test.ts                 10 test: select/deselect/toggle/clear, dirty tracking, GPU mask upload
  input-manager.test.ts             24 test: keyboard isKeyDown, pointer position/buttons, scroll deltas,
                                           onKey/onClick/onPointerMove/onScroll callbacks, DOM lifecycle
  hit-tester.test.ts                 8 test: ray-sphere intersection, closest hit, miss, 2.5D depth ordering
  immediate-state.test.ts           10 test: shadow position map, patchTransforms, patchBounds, set/get/clear
  input-picking.test.ts              3 test: input→picking integration, screenToRay→hitTest pipeline
  text/text-layout.test.ts           3 test: MSDF text layout, glyph positioning, atlas metrics
  audio-types.test.ts                3 test: branded types SoundHandle/PlaybackId, defaults
  sound-registry.test.ts            13 test: load/decode/dedup, unload, destroy, bidirectional maps
  playback-engine.test.ts           26 test: play/stop, setVolume/setPitch, spatial pan/attenuation,
                                           setListenerPosition, master volume, mute/unmute
  audio-manager.test.ts             25 test: facade lifecycle, lazy AudioContext, suspend/resume/destroy,
                                           safe no-ops before init, SpatialConfig forwarding
  event-bus.test.ts                  5 test: subscribe, emit, once, off, destroy
  plugin-context.test.ts            10 test: PluginContext sub-APIs, null when headless, storage
  profiler.test.ts                   4 test: ProfilerOverlay DOM management, position, update
  plugins/fps-counter.test.ts        3 test: install, postTick hook, cleanup
```

### Pattern di Test: Cross-Boundary Protocol Verification

I test di integrazione TypeScript verificano che i byte prodotti da `RingBufferProducer` corrispondano esattamente al formato atteso dal consumer Rust. Non testano il consumer Rust direttamente (non possono — sono in processi diversi), ma asseriscono sugli offset, sui valori dei byte e sull'avanzamento dell'`write_head`:

```typescript
// Verifica che spawn(0) + setPosition(0, ...) + despawn(0) producano esattamente 27 bytes
// e che i discriminanti siano nelle posizioni corrette
expect(writeHead).toBe(27);           // 5 + 17 + 5
expect(data[0]).toBe(CommandType.SpawnEntity);   // offset 0
expect(data[5]).toBe(CommandType.SetPosition);   // offset 5
expect(data[22]).toBe(CommandType.DespawnEntity); // offset 22
```

I test Rust verificano il lato consumer con buffer simulati in memoria heap (non veri SharedArrayBuffer — non disponibili in `cargo test`). I test impostano `write_head` e dati manualmente, poi chiamano `drain()` e asseriscono sul contenuto dei `Command` parsati.

### Convenzioni

- **Inline**: I test Rust vivono nel file del modulo che testano, dentro `#[cfg(test)] mod tests {}`. Nessuna directory `tests/` separata.
- **Colocated**: I test TypeScript vivono accanto al modulo (es. `ring-buffer.ts` → `ring-buffer.test.ts`). Nessuna directory `__tests__/`.
- **Factory helpers**: Sia Rust che TypeScript usano funzioni helper per creare fixture con defaults sensati (`make_spawn_cmd()`, `makeCaps()`, `makeBuffer()`).
- **Nessun mock I/O**: Tutti i test sono puri — nessun mock di filesystem, network o browser API.

### Comandi

```bash
# Rust — 99 test
cargo test -p hyperion-core                           # Tutti
cargo test -p hyperion-core engine::tests::spiral_of_death_capped  # Singolo
cargo test -p hyperion-core ring_buffer               # Ring buffer (19 test)
cargo test -p hyperion-core render_state              # Render state (27 test)
cargo test -p hyperion-core components                # Components (23 test)
cargo test -p hyperion-core command_proc              # Command processor (15 test)
cargo test -p hyperion-core systems                   # Systems (7 test)
cargo clippy -p hyperion-core                         # Lint

# TypeScript — 409 test
cd ts && npm test                                     # Tutti (vitest run)
cd ts && npm run test:watch                           # Watch mode
cd ts && npx vitest run src/ring-buffer.test.ts       # Singolo file
cd ts && npx vitest run src/frustum.test.ts           # Frustum culling
cd ts && npx vitest run src/texture-manager.test.ts   # Texture manager
cd ts && npx vitest run src/render/render-graph.test.ts # RenderGraph DAG
cd ts && npx vitest run src/hyperion.test.ts          # Hyperion facade (55 test)
cd ts && npx vitest run src/entity-handle.test.ts     # EntityHandle (28 test)
cd ts && npx vitest run src/game-loop.test.ts         # GameLoop (11 test)
cd ts && npx vitest run src/plugin.test.ts            # PluginRegistry (13 test)
cd ts && npx vitest run src/selection.test.ts         # SelectionManager (10 test)
cd ts && npx vitest run src/input-manager.test.ts     # InputManager (24 test)
cd ts && npx vitest run src/audio-manager.test.ts     # AudioManager (25 test)
cd ts && npx tsc --noEmit                             # Type-check solo

# Visual testing — build WASM + dev server
cd ts && npm run build:wasm && npm run dev
```

---

## 12. Build Pipeline

### WASM Build

```bash
cd ts && npm run build:wasm
# Equivale a:
wasm-pack build ../crates/hyperion-core --target web --out-dir ../../ts/wasm
```

**Output** in `ts/wasm/`:

| File | Scopo |
|---|---|
| `hyperion_core.js` | JS glue code (ESM) — init(), funzioni wrapper |
| `hyperion_core_bg.wasm` | Binary WASM compilato |
| `hyperion_core.d.ts` | Type declarations per TypeScript |
| `hyperion_core_bg.wasm.d.ts` | Types per il modulo raw WASM |
| `package.json` | Metadata wasm-pack |

**Nota `--out-dir`**: Il path e relativo alla directory del crate (`crates/hyperion-core/`), non alla workspace root. `../../ts/wasm` naviga due livelli su e poi in `ts/wasm`.

### Profili di Compilazione Rust

```toml
# Cargo.toml (workspace root)
[profile.release]
opt-level = 3        # Massima ottimizzazione
lto = "fat"          # Link-Time Optimization cross-crate
codegen-units = 1    # Singola unita per migliore inlining

[profile.dev]
opt-level = 1        # Minima ottimizzazione (build veloce ma non lento a runtime)
debug = true         # Debug symbols per stack traces leggibili
```

`lto = "fat"` e `codegen-units = 1` in release sono critici per WASM: permettono al compilatore di eliminare tutto il dead code cross-crate, riducendo significativamente la dimensione del `.wasm`.

### Dev Server

```bash
cd ts && npm run dev   # vite
```

Il Vite dev server serve gli header COOP/COEP necessari per SharedArrayBuffer e compila TypeScript e il Worker ESM al volo. Il Worker usa `new URL("./engine-worker.ts", import.meta.url)` — Vite riconosce il pattern e bundla il Worker separatamente.

---

## 13. Decisioni Architetturali Chiave

| Decisione | Alternative Valutate | Motivazione |
|---|---|---|
| **hecs** per ECS | `bevy_ecs`, `specs`, `legion` | `bevy_ecs` perde parallelismo su WASM + binary bloat. `hecs` ha iterazione single-thread equivalente con footprint minimo |
| **Ring buffer su SAB** | FFI sincrona, `postMessage` con transferable | FFI: overhead per-call insostenibile a scale. `postMessage`: serialization cost + nessun shared state |
| **Fixed timestep 1/60s** | Variable timestep, timestep adattivo | Determinismo fisico. Replay possibile. Nessun jitter dipendente dal framerate |
| **Spiral-of-death cap a 10 tick** | Cap a 3, nessun cap, time scaling | 10 e un compromesso: permette catch-up dopo brevi stall senza freeze catastrofici |
| **`addr_of_mut!()` per static mut** | `lazy_static`, `OnceCell`, raw pointers | Required da Rust 2024 edition. `lazy_static` e `OnceCell` aggiungono overhead di inizializzazione che non serve su wasm32 single-threaded |
| **`#[repr(C)]` + `Pod` su tutti i componenti** | `repr(Rust)`, serde serialization | Upload GPU diretto senza copie. `bytemuck::bytes_of()` costa zero runtime |
| **`const enum` in TypeScript** | `enum`, string union, numeric constants | `const enum` e inlinato dal compiler — zero overhead runtime, nessun reverse mapping (non serve) |
| **Vite (non webpack/esbuild)** | webpack 5, esbuild standalone | Vite ha supporto nativo per Worker ESM, header custom, e HMR. Webpack richiederebbe plugin per Worker bundling |
| **Sparse Vec + free-list per EntityMap** | `HashMap<u32, Entity>`, `SlotMap` | O(1) lookup con cache-friendliness perfetta. Free-list mantiene ID compatti senza frammentazione |
| **WebGPU da TypeScript (non Rust wgpu)** | `wgpu` compilato a WASM, Emscripten WebGPU bindings | `wgpu` wrappa la stessa API browser con ~1MB overhead di binary bloat. WebGPU da TS ha accesso diretto e zero overhead |
| **WGSL caricato via Vite `?raw`** | Embedding in stringhe Rust, file separati con fetch | `?raw` inlinea lo shader come stringa al build time, zero richieste runtime, hot-reload in dev mode |
| **`engine_push_commands` pattern** | Passaggio diretto SAB pointer a WASM, `postMessage` serializzazione | SAB pointer non supportato da `wasm-bindgen`. Il Worker legge dal SAB e scrive nella WASM linear memory — zero copie aggiuntive rispetto al necessario |
| **Camera ortografica (non prospettica)** | Proiezione prospettica, proiezione ibrida | Per un engine 2D/2.5D, l'ortografica elimina distorsione prospettica e semplifica il coordinate mapping |
| **GPU compute culling (non CPU)** | CPU-side frustum culling, nessun culling | Compute shader scala linearmente con le entita senza overhead JS. 100k entita testate in <0.5ms su GPU vs ~5ms su CPU |
| **drawIndexedIndirect (non draw diretto)** | `draw(N)` con N = totale entita | Il compute shader scrive `instanceCount` atomicamente — solo entita visibili sono renderizzate. Zero overhead CPU per il conteggio |
| **Multi-tier Texture2DArray** | Singola texture atlas, array di texture individuali | Atlas ha problemi di bleeding ai bordi e spreca spazio. Texture individuali richiedono bind group switch per-texture. Texture2DArray permette un singolo bind group con fino a 256 texture per tier |
| **4 tier fissi (64/128/256/512)** | Tier dinamici, singola risoluzione | 4 tier coprono la maggior parte dei casi d'uso 2D. Il costo e lo switch nel fragment shader, ma WGSL non supporta dynamic indexing sulle texture bindings |
| **Packed texture index (tier<<16\|layer)** | Due u32 separati, struct | Un singolo u32 per entita riduce la bandwidth GPU e semplifica il buffer layout. 16 bit per tier (max 65k tier, ne usiamo 4) e 16 bit per layer (max 65k layer, ne usiamo 256) |
| **Facade pattern per API pubblica** | Export diretto dei moduli interni, factory functions | La Facade `Hyperion` nasconde la complessita interna (bridge, renderer, camera, loop, pool, plugins) dietro un'interfaccia singola. L'utente non deve sapere di `BackpressuredProducer` o `EngineBridge` |
| **EntityHandle pool con cap 1024** | Nessun pool (GC), pool illimitato, WeakRef pool | 1024 e sufficiente per scene tipiche. Cap evita memory leak da pool mai svuotato. GC-only causerebbe pressione GC inaccettabile con spawn/despawn frequenti |
| **`Children` inline [u32; 32] (no heap)** | `Vec<u32>`, `SmallVec`, heap-allocated list | Array inline e `#[repr(C)]` Pod (GPU-uploadable), zero allocazioni, cache-friendly. 32 slot coprono la maggior parte dei casi. Trade-off: limite rigido di 32 figli |
| **`fromParts()` factory per test** | Mock objects, dependency injection framework | Factory esplicita che accetta componenti pre-costruiti. Semplice, nessuna dipendenza aggiuntiva. I test possono fornire stub minimali senza WASM/WebGPU |
| **Plugin cleanup in ordine LIFO** | FIFO, ordine arbitrario, nessun ordine garantito | LIFO e il pattern standard per middleware/plugin stack: le dipendenze installate prima vengono pulite per ultime, evitando use-after-free di risorse condivise |

---

## 14. Gotchas e Insidie

| Insidia | Causa | Soluzione Adottata |
| --- | --- | --- |
| `hecs 0.11 query_mut` restituisce component tuples direttamente | API breaking tra 0.10 e 0.11 | `for (pos, vel) in world.query_mut::<(&mut Position, &Velocity)>()` — NO `(Entity, components)` |
| `u64` Rust → `BigInt` JS via wasm-bindgen | wasm-bindgen non ha altra scelta per u64 | Wrappare con `Number(wasm.engine_tick_count())` nel Worker (safe per valori < 2^53) |
| `wasm-bindgen` non puo esportare `unsafe fn` | Limitazione del proc macro | `#[allow(clippy::not_unsafe_ptr_arg_deref)]` su `engine_attach_ring_buffer` |
| `const enum` TS non ha reverse mapping | `CommandType[3]` non funziona (TS2476) | Loggare valori numerici direttamente, non tentare lookup inverso |
| `wasm-pack --out-dir` e relativo al crate | Non alla workspace root | Path `../../ts/wasm` nel script `build:wasm` |
| `SharedArrayBuffer` richiede COOP/COEP | Security policy del browser | Headers in `vite.config.ts`; in produzione serve configurazione server |
| `Atomics` non disponibili senza cross-origin isolation | Conseguenza di COOP/COEP mancanti | Fallback a `ArrayBuffer` + Mode C in `createRingBuffer()` |
| `static mut` in Rust 2024 | Creating references to `static mut` is UB | `addr_of_mut!()` per scrivere senza creare `&mut` |
| Tipi public con `new()` senza parametri | Clippy `new_without_default` | `impl Default` esplicito su `Engine` e `EntityMap` |
| `@webgpu/types` `Float32Array` strictness | `writeBuffer` richiede `Float32Array<ArrayBuffer>`, non `Float32Array<ArrayBufferLike>` | Cast esplicito `as Float32Array<ArrayBuffer>` quando la sorgente potrebbe essere `ArrayBufferLike` |
| Indirect draw buffer richiede `STORAGE \| INDIRECT \| COPY_DST` | Il compute shader scrive instanceCount (STORAGE), il render pass lo legge (INDIRECT), la CPU lo resetta a zero ogni frame (COPY_DST) | Combinare tutti e tre gli usage flags alla creazione del buffer |
| Frustum extraction vive in `camera.ts` | `extractFrustumPlanes()` e definita solo in `camera.ts`. La vecchia `extractFrustumPlanesInternal` in `renderer.ts` e stata rimossa | `CullPass` importa direttamente da `camera.ts` |
| WebGPU non testabile in headless | Playwright/Puppeteer headless non ha GPU adapter — `requestAdapter()` ritorna null | Test visuali WebGPU solo con browser reale (`npm run dev` → Chrome) |
| Depth texture lazy recreation | `ForwardPass.ensureDepthTexture()` crea/ricrea la depth texture quando le dimensioni del canvas cambiano | `resize()` invalida il tracking, `execute()` ricrea al frame successivo. **Bug risolto** (prima la depth texture era creata una sola volta all'init) |
| `createImageBitmap` non disponibile ovunque nei Worker | Firefox e Chrome supportano, Safari ha supporto parziale | `TextureManager` va istanziato solo dove `createImageBitmap` e disponibile |
| WGSL non supporta dynamic indexing su texture bindings | Limitazione del linguaggio | `switch(tier)` nel fragment shader — aggiungere nuovi tier richiede aggiornare lo shader |
| `Texture2DArray maxTextureArrayLayers` varia per device | WebGPU spec garantisce minimo 256 | `TextureManager` alloca 256 layer per tier. Su device con meno layer, il caricamento fallira |
| `EntityHandle.data()` cleared on pool reuse | `EntityHandlePool.init()` resets the data map | Plugins that store data via `.data(key, value)` must handle disappearing data after pool recycling |
| `Hyperion.fromParts()` vs `Hyperion.create()` | Two factory methods serve different purposes | `fromParts()` is the test factory (pre-built components, no WASM/WebGPU). `create()` is production (capability detection, bridge, renderer) |
| Plugin teardown order matters | Plugins may reference engine resources during cleanup | `pluginRegistry.destroyAll()` runs before bridge/renderer destroy in `Hyperion.destroy()` |
| `GameLoop` first-frame dt spike | `performance.now()` would be the entire page lifetime | Uses `lastTime = -1` sentinel to detect first RAF callback and set dt=0 |
| `SetParent` uses `0xFFFFFFFF` for unparent | Same command type for both parenting and unparenting | Payload is parent entity ID; special value `0xFFFFFFFF` means "remove parent" |
| `Children` fixed 32-slot inline array + `OverflowChildren` heap fallback | Cache performance trade-off with safety net | Inline array for up to 32 children; `OverflowChildren(Vec<u32>)` heap fallback for 33+. `remove()` returns `bool`, handler checks overflow on `false` |

---

## 15. Limitazioni Note e Blind Spot

| Limitazione | Causa | Impatto | Stato |
| --- | --- | --- | --- |
| Nessun rendering fallback senza WebGPU | Solo WebGPU supportato | Senza WebGPU il renderer e `null`, solo la simulazione ECS gira | Futuro: WebGL 2 fallback |
| `webgpuInWorker` detection via UA string | Non esiste API per testare WebGPU in Worker dal Main Thread | Falsi negativi su browser non-Chromium con supporto futuro | Aggiornare euristica quando Firefox supporta |
| `RingBufferConsumer::drain()` alloca `Vec` per frame | Nessun object pool | Pressione GC minima (il Vec e in Rust, non JS) ma non zero-alloc | Ottimizzazione futura con pre-allocated buffer |
| Entity IDs non compattati dopo molti spawn/despawn | Free-list LIFO puo lasciare buchi nel Vec | Spreco di memoria per mappe molto sparse | **Mitigato**: `EntityMap.shrink_to_fit()` + `Hyperion.compact()` in Phase 5 |
| Nessuna validazione del quaternione in `SetRotation` | Il payload e accettato cosi com'e | Quaternioni non normalizzati producono scale anomale nella model matrix | Aggiungere normalizzazione in `process_commands` |
| Full SoA buffer re-upload ogni frame | Il coordinator in `renderer.ts` uploada tutti e 4 i buffer SoA (transforms, bounds, renderMeta, texIndices) ogni frame via `writeBuffer` | Nessuna ottimizzazione partial upload | Futuro: usare `DirtyTracker` (gia in Rust) per partial upload quando `transform_dirty_ratio < 0.3` |
| Texture indices buffer parallelo al entity buffer | I due buffer devono essere indicizzati nello stesso ordine | Entrambi popolati nello stesso loop `collect_gpu()` — allineamento garantito | **Risolto by design** |

---

## 16. Stato di Implementazione

### Roadmap Fasi

| Fase | Nome | Stato | Deliverables |
| --- | --- | --- | --- |
| **0** | Scaffold & Execution Harness | **Completata** | Workspace Rust, Vite dev server, capability detection, mode selection A/B/C, ring buffer SPSC, Worker bridge |
| **1** | ECS Core | **Completata** | `hecs` integration, componenti SoA, transform system, tick loop deterministico, command processor |
| **2** | Render Core | **Completata** | WebGPU renderer, instanced quad pipeline, WGSL shader, camera ortografica, RenderState, SAB→WASM bridge (`engine_push_commands`), Mode A/B/C render paths |
| **3** | GPU-Driven Pipeline | **Completata** | WGSL compute culling (`cull.wgsl`), StorageBuffer layout (20 f32/entity), `drawIndexedIndirect`, visibility indirection (`basic.wgsl`), `BoundingRadius` component, `extractFrustumPlanes()`, frustum test suite |
| **4** | Asset Pipeline & Textures | **Completata** | `TextureManager` (multi-tier Texture2DArray 64/128/256/512), `createImageBitmap` loading pipeline, `TextureLayerIndex` component, `SetTextureLayer` command, packed texture index encoding (tier<<16\|layer), multi-tier WGSL sampling, concurrency limiter, URL caching |
| **4.5** | Stabilization & Arch Foundations | **Completata** | SoA GPU buffer layout, `MeshHandle`/`RenderPrimitive` components, extended ring buffer (32B header), `RenderPass`/`ResourcePool` abstractions, `RenderGraph` DAG (Kahn's sort + dead-pass culling), `CullPass`/`ForwardPass` extraction, Blelloch prefix sum shader, `TextureManager` lazy allocation (exponential growth), `BitSet`/`DirtyTracker`, `PrioritizedCommandQueue`, `WorkerSupervisor` |
| **Post-Plan** | Integration & Wiring | **Completata** | Wired Phase 4.5 abstractions into live renderer: `renderer.ts` rewritten as RenderGraph coordinator (357→145 lines), `basic.wgsl` SoA transforms, `CullPass`/`ForwardPass` full prepare/execute, `BackpressuredProducer` in all bridges, `WorkerSupervisor` heartbeat in Mode A/B, depth texture resize fix via lazy recreation |
| **5** | TypeScript API & Lifecycle | **Completata** | `Hyperion` facade, `EntityHandle` fluent builder + pool, `GameLoop` RAF lifecycle with hooks, `CameraAPI` zoom, `RawAPI` low-level numeric API, `PluginRegistry`, `LeakDetector`, barrel export, scene graph (`Parent`/`Children`/`LocalMatrix`/`propagate_transforms`/`SetParent`), memory compaction (`shrink_to_fit` + WASM exports), device-lost recovery plumbing |
| **5.5** | Rendering Primitives | **Completata** | `PrimitiveParams([f32;8])` component + `SetPrimParams0/1` commands, multi-type CullPass (6 types × DrawIndirectArgs), multi-pipeline ForwardPass (`SHADER_SOURCES`), line rendering (screen-space expansion + SDF dash), MSDF text (FontAtlas + text layout + median SDF), gradient (linear/radial/conic), box shadow (Evan Wallace erf), FXAA + tonemapping (PBR Neutral/ACES), JFA selection outlines (SelectionSeedPass → JFAPass×N → OutlineCompositePass), `SelectionManager`, `enableOutlines()/disableOutlines()` API |
| **6** | Input System | **Completata** | `ExternalId(u32)` ECS component, `entityIds` SoA buffer, `InputManager` (keyboard/pointer/scroll + callbacks), `Camera.screenToRay()` + `mat4Inverse`, `hitTestRay()` CPU ray-sphere picking, `ImmediateState` shadow position map + transform patching, `SelectionManager` CPU-side + GPU mask, `EntityHandle.positionImmediate()/clearImmediate()`, public API `engine.input`/`engine.picking.hitTest()` |
| **7** | Audio System | **Completata** | `SoundRegistry` (URL-deduplicated buffer management, DI), `PlaybackEngine` (Web Audio node graph, 2D spatial pan + distance attenuation), `AudioManager` facade (lazy AudioContext, browser autoplay policy), branded types (`SoundHandle`/`PlaybackId`), audio listener auto-update from camera, `pause()`/`resume()`/`destroy()` lifecycle wiring, public API `engine.audio` |
| **7.5** | Stability Bugfix | **Completata** | `OverflowChildren(Vec<u32>)` heap fallback for 33+ children (`Children.remove()` returns bool), `ImmediateState.patchBounds()` for consistent picking during drag, ring-buffer-driven audio listener via `SetListenerPosition` command (discriminant 13) with WASM velocity derivation + extrapolation, `engine_listener_x/y/z()` exports, `GPURenderState.listenerX/Y/Z`, `setTargetAtTime` smoothing in PlaybackEngine |
| **8** | Polish, DX & Production Readiness | **Completata** | Plugin System v2 (`PluginContext` with 5 sub-APIs: systems, events, rendering, GPU, storage), `EventBus` inter-plugin communication, dependency resolution + error boundaries in `PluginRegistry`. Shader hot-reload via `recompileShader()` + Vite HMR for all 10 WGSL files. `ProfilerOverlay` DOM-based perf stats (`enableProfiler`/`disableProfiler`). Stats: tickCount from WASM, frame time tracking (`frameDt`/`frameTimeAvg`/`frameTimeMax`), `MemoryStats` getter. Example `fpsCounterPlugin()`. Deployment guide for 7 platforms. Vite preview COOP/COEP headers |
| **9** | TBD | Pianificata | — |

### Metriche Attuali

| Metrica | Valore |
| --- | --- |
| Test Rust | 99 (tutti passanti) |
| Test TypeScript | 409 (tutti passanti) |
| Moduli Rust | 7 (`lib`, `engine`, `command_processor`, `ring_buffer`, `components`, `systems`, `render_state`) |
| Moduli TypeScript | 45+ (`hyperion`, `entity-handle`, `entity-pool`, `game-loop`, `camera-api`, `raw-api`, `plugin`, `plugin-context`, `event-bus`, `profiler`, `plugins/fps-counter`, `types`, `leak-detector`, `selection`, `index`, `main`, `capabilities`, `ring-buffer`, `worker-bridge`, `engine-worker`, `renderer`, `texture-manager`, `camera`, `render-worker`, `backpressure`, `supervisor`, `text/font-atlas`, `text/text-layout`, `text/text-manager`, `render/render-pass`, `render/resource-pool`, `render/render-graph`, `render/passes/cull-pass`, `render/passes/forward-pass`, `render/passes/fxaa-tonemap-pass`, `render/passes/selection-seed-pass`, `render/passes/jfa-pass`, `render/passes/outline-composite-pass`, `render/passes/prefix-sum-reference`, `shaders/*.wgsl` x 11, `vite-env.d.ts`) |
| File test TypeScript | 41 (`capabilities`, `ring-buffer`, `ring-buffer-utils`, `camera`, `frustum`, `texture-manager`, `backpressure`, `supervisor`, `render-pass`, `render-graph`, `cull-pass`, `forward-pass`, `fxaa-tonemap-pass`, `selection-seed-pass`, `jfa-pass`, `outline-composite-pass`, `prefix-sum`, `integration`, `hyperion`, `entity-handle`, `entity-pool`, `game-loop`, `raw-api`, `camera-api`, `plugin`, `types`, `leak-detector`, `selection`, `input-manager`, `hit-tester`, `immediate-state`, `input-picking`, `text-layout`, `audio-types`, `sound-registry`, `playback-engine`, `audio-manager`, `event-bus`, `plugin-context`, `profiler`, `plugins/fps-counter`) |
| Dipendenze Rust (runtime) | 4 (`wasm-bindgen`, `hecs`, `glam`, `bytemuck`) |
| Dipendenze TypeScript (dev) | 4 (`typescript`, `vite`, `vitest`, `@webgpu/types`) |
| Dipendenze TypeScript (runtime) | 0 |
| WASM exports | 28 (27 engine functions + 1 smoke test) |
| ECS Components | 16 (Position, Rotation, Scale, Velocity, ModelMatrix, BoundingRadius, TextureLayerIndex, MeshHandle, RenderPrimitive, PrimitiveParams, ExternalId, Active, Parent, Children, OverflowChildren, LocalMatrix) |
| CommandType variants | 14 (Noop + 13 comandi, incl. SetPrimParams0/1, SetListenerPosition) |
| WGSL Shaders | 11 (basic, line, gradient, box-shadow, msdf-text, fxaa-tonemap, selection-seed, jfa, outline-composite, cull, prefix-sum) |
| Render Passes | 6 (CullPass, ForwardPass, FXAATonemapPass, SelectionSeedPass, JFAPass, OutlineCompositePass) |

---

## 17. Guida all'Estendibilita

### 17.1 Aggiungere un Nuovo Comando

Per aggiungere un comando (es. `SetColor(r, g, b, a)`):

**Rust** (`ring_buffer.rs`): Aggiungere variante a `CommandType`: `SetColor = 14`, aggiungere `from_u8`: `14 => Some(Self::SetColor)`, aggiungere `payload_size`: `Self::SetColor => 16` (4 × f32).

**Rust** (`command_processor.rs`): Aggiungere branch nel match di `process_commands`.

**TypeScript** (`ring-buffer.ts`): Aggiungere a `CommandType`: `SetColor = 14`, aggiungere a `PAYLOAD_SIZES`: `[CommandType.SetColor]: 16`. Opzionale: aggiungere convenience method su `RingBufferProducer`.

**Test**: Test Rust in `ring_buffer.rs::tests` per il parsing. Test Rust in `command_processor.rs::tests` per la mutazione ECS. Test TypeScript in `ring-buffer.test.ts` per la serializzazione. Test in `integration.test.ts` per la verifica cross-boundary degli offset.

**Nota**: Il prossimo discriminante libero e `14` — `SetListenerPosition` (13) e l'ultimo assegnato.

### 17.2 Aggiungere un Nuovo Componente ECS

1. Definire la struct in `components.rs` con `#[derive(Debug, Clone, Copy, Pod, Zeroable)]` e `#[repr(C)]`
2. Implementare `Default`
3. Aggiungere al bundle di spawn in `command_processor.rs` (se ogni entita lo ha)
4. Scrivere un sistema in `systems.rs` che opera sul nuovo componente
5. Registrare il sistema nel tick loop in `engine.rs` (`fixed_tick()` o `update()`)

### 17.3 Aggiungere un Nuovo Sistema ECS

I sistemi sono funzioni pure che prendono `&mut World` (e opzionalmente `dt`):

```rust
pub fn my_system(world: &mut World, dt: f32) {
    for (comp_a, comp_b) in world.query_mut::<(&mut CompA, &CompB)>() {
        // logica
    }
}
```

**Dove registrarlo**:
- Se deve girare a **frequenza fissa** (fisca, collision): dentro `Engine::fixed_tick()`
- Se deve girare **una volta per frame** (rendering prep, UI sync): dentro `Engine::update()`, dopo il loop dei tick

### 17.4 Aggiungere un Nuovo Execution Mode

Se emergesse la necessita di un Mode D (es. WebTransport per cloud rendering):

1. Aggiungere variante a `ExecutionMode` in `capabilities.ts`
2. Aggiungere logica di selezione in `selectExecutionMode()`
3. Creare nuova factory `createMyBridge()` in `worker-bridge.ts` che restituisca `EngineBridge`
4. Aggiungere branch in `main.ts`

Il codice del main loop non cambia — opera solo sull'interfaccia `EngineBridge`.

### 17.5 Aggiungere un Nuovo Tier di Texture

Se servisse un tier 4 (es. 1024×1024):

**TypeScript** (`texture-manager.ts`): Aggiungere `1024` a `TIER_SIZES`: `[64, 128, 256, 512, 1024]`. `NUM_TIERS` si aggiorna automaticamente (`TIER_SIZES.length`). Il costruttore `TextureManager` crea automaticamente il nuovo tier array.

**TypeScript** (`renderer.ts`): Registrare `tier4` view nel `ResourcePool` del coordinator. Aggiungere binding per `tier4Tex` nel bind group layout di `ForwardPass.setup()`. Aggiungere `resources.getTextureView('tier4')` alla creazione del bind group 1.

**WGSL** (`basic.wgsl`): Aggiungere `@group(1) @binding(5) var tier4Tex: texture_2d_array<f32>;`. Aggiungere `case 4u:` nel `switch(in.texTier)` del fragment shader.

**Attenzione**: WGSL non supporta dynamic indexing su texture bindings. Ogni nuovo tier richiede un case esplicito nello switch. Il costo GPU e minimo (branch prediction uniforme per-quad), ma la manutenzione e manuale.

---

## 18. Phase 5: TypeScript API & Lifecycle

### Panoramica

Phase 5 aggiunge un **Public API Layer** completo sopra i componenti interni dell'engine. Prima di Phase 5, l'utente doveva interagire direttamente con `BackpressuredProducer`, `EngineBridge`, `Camera`, e `createRenderer()` — API interne progettate per la comunicazione tra moduli, non per l'ergonomia utente. Phase 5 wrappa tutto in una singola classe `Hyperion` con un'API fluente e opinionata.

### 18.1 Hyperion Facade

**File**: `ts/src/hyperion.ts`

`Hyperion` e il punto di ingresso unico per gli utenti dell'engine. Espone due factory method:

- **`Hyperion.create(canvas, config?)`** — Factory di produzione. Rileva le capabilities del browser, crea bridge e renderer, inizializza il game loop. Asincrona (ritorna `Promise<Hyperion>`).
- **`Hyperion.fromParts(parts)`** — Factory di test. Accetta componenti pre-costruiti (bridge, renderer, camera, etc.) per unit testing senza WASM/WebGPU reale.

**Metodi principali**:

| Metodo | Scopo |
|---|---|
| `spawn()` | Crea un `EntityHandle` (da pool se disponibile) |
| `batch(fn)` | Esegue operazioni in batch, flush alla fine |
| `start()` | Avvia il game loop (RAF) |
| `pause()` | Sospende il game loop |
| `resume()` | Riprende il game loop |
| `destroy()` | Teardown completo: plugins → loop → bridge → renderer |
| `use(plugin)` | Installa un plugin |
| `unuse(plugin)` | Rimuove un plugin |
| `addHook(phase, fn)` | Registra un hook (preTick/postTick/frameEnd) |
| `removeHook(phase, fn)` | Rimuove un hook |
| `loadTexture(url)` | Carica una texture, ritorna `TextureHandle` |
| `loadTextures(urls)` | Carica texture in batch |
| `compact(options?)` | Compatta EntityMap + RenderState (chiama WASM exports) |
| `resize(w, h)` | Ridimensiona canvas + camera + renderer |
| `stats` | Getter per `HyperionStats` (fps, entityCount, mode, etc.) |

**Ordine di teardown in `destroy()`**:
1. `pluginRegistry.destroyAll()` — plugin cleanup (possono ancora accedere all'engine)
2. `gameLoop.stop()` — ferma RAF
3. `bridge.destroy()` — termina Worker
4. `renderer.destroy()` — rilascia risorse GPU

### 18.2 EntityHandle: Fluent Builder

**File**: `ts/src/entity-handle.ts`

`EntityHandle` wrappa un entity ID numerico e un riferimento al `BackpressuredProducer`, esponendo un'API fluent per configurare le proprieta:

```typescript
const entity = engine.spawn()
    .position(10, 20, 0)
    .velocity(1, 0, 0)
    .scale(2, 2, 1)
    .texture(textureHandle)
    .parent(otherEntity);
```

Ogni metodo ritorna `this` per il chaining. `EntityHandle` implementa `Disposable` — `.dispose()` invia `DespawnEntity` e rilascia l'handle al pool.

**Data map**: `.data(key, value)` permette di associare dati arbitrari a un handle (es. per plugin). La data map viene resettata quando l'handle viene riciclato dal pool via `init()`.

### 18.3 EntityHandlePool: Object Pooling

**File**: `ts/src/entity-pool.ts`

Per evitare pressione GC in scene con frequenti spawn/despawn, `EntityHandlePool` implementa un object pool LIFO con capacita massima di 1024 handle.

- `acquire()` → pop dal pool (se disponibile) oppure crea nuovo
- `release(handle)` → push nel pool (se sotto capacita) oppure scarta

`init(id, producer)` resetta un handle riciclato: nuovo entity ID, stesso producer, data map pulita.

### 18.4 GameLoop: RAF Lifecycle con Hook

**File**: `ts/src/game-loop.ts`

`GameLoop` gestisce il ciclo `requestAnimationFrame` con tre fasi di hook:

1. **preTick** — prima di `bridge.tick(dt)` (input processing, AI updates)
2. **postTick** — dopo `bridge.tick(dt)`, prima del rendering (state sync)
3. **frameEnd** — dopo il rendering (debug overlay, stats collection)

**FPS tracking**: Calcola FPS con smoothing esponenziale. Espone `fps` getter.

**Sentinel `lastTime = -1`**: Il primo callback RAF riceve `performance.now()` che e il tempo dall'inizio della pagina. Senza il sentinel, il primo dt sarebbe enorme (centinaia di ms), causando uno spike di simulazione. Il sentinel forza dt=0 al primo frame.

### 18.5 Plugin System (v2 — aggiornato in Phase 8)

**File**: `ts/src/plugin.ts`, `ts/src/plugin-context.ts`, `ts/src/event-bus.ts`

```typescript
interface HyperionPlugin {
    name: string;
    version?: string;
    dependencies?: string[];
    install(ctx: PluginContext): PluginCleanup | void;
}
```

**Nota**: L'interfaccia originale (`install(engine)`) e stata sostituita in Phase 8 con `install(ctx: PluginContext)`. Vedi Section 23 per i dettagli completi del Plugin System v2 (PluginContext, 5 sub-API, dependency resolution, error boundaries, EventBus).

`PluginRegistry` gestisce il lifecycle dei plugin:

- `install(plugin, ctx)` → verifica dipendenze, chiama `plugin.install(ctx)` con error boundary, registra cleanup
- `uninstall(plugin)` → chiama cleanup function se presente, deregistra
- `destroyAll()` → cleanup di tutti i plugin in ordine inverso di installazione con error boundary

**Ordine inverso**: I plugin installati per ultimi vengono distrutti per primi (LIFO), come in uno stack di middleware.

### 18.6 Scene Graph (Rust)

Phase 5 aggiunge un scene graph minimale basato su tre nuovi componenti ECS:

| Componente | Layout | Scopo |
|---|---|---|
| `Parent(u32)` | 4 bytes | External entity ID del parent |
| `Children { count, ids: [u32; 32] }` | 132 bytes | Lista figli inline (no heap) |
| `LocalMatrix([f32; 16])` | 64 bytes | Model matrix nello spazio locale |

**`SetParent` command (discriminante 10)**:

Il payload e un `u32`:
- Valore valido → set parent: aggiunge `Parent(parent_id)` al figlio, aggiunge il figlio ai `Children` del parent
- `0xFFFFFFFF` → unparent: rimuove `Parent`, rimuove il figlio dai `Children` del vecchio parent

**`propagate_transforms` system**:

Eseguito in `Engine::update()` dopo `transform_system()`. Per ogni entita con `Parent`:
1. Legge la `ModelMatrix` del parent (lookup via `ext_to_entity` HashMap)
2. Moltiplica: `model_matrix = parent_matrix * local_matrix`
3. Scrive il risultato nella `ModelMatrix` del figlio

Questo produce model matrix world-space corrette per la GPU, anche con gerarchie annidate (propagazione ricorsiva indiretta: i parent vengono processati prima dei figli grazie all'ordinamento naturale degli archetype di hecs).

**Overflow handling**: `Children` usa un array inline di 32 slot per cache performance. Quando il 33esimo figlio viene aggiunto e `Children.add()` ritorna `false`, il handler `SetParent` attacca un componente `OverflowChildren(Vec<u32>)` come fallback heap-allocated. Alla rimozione, `Children.remove()` ritorna `bool`; se `false`, il handler controlla `OverflowChildren`. Componenti `OverflowChildren` vuoti vengono rimossi automaticamente.

### 18.7 Memory Compaction

Phase 5 aggiunge la capacita di compattare le strutture dati interne dopo molti spawn/despawn:

**Rust**:
- `EntityMap::shrink_to_fit()` — rilascia capacita in eccesso nel Vec e nella free-list
- `RenderState::shrink_to_fit()` — rilascia capacita in eccesso in tutti i buffer SoA

**WASM exports**:
- `engine_compact_entity_map()` — chiama `EntityMap::shrink_to_fit()`
- `engine_compact_render_state()` — chiama `RenderState::shrink_to_fit()`
- `engine_entity_map_capacity()` → `u32` — ritorna la capacita attuale dell'EntityMap

**TypeScript**: `Hyperion.compact(options?)` chiama i WASM exports appropriati. Puo essere invocato manualmente dall'utente quando sa di aver rilasciato molte entita.

### 18.8 Device-Lost Recovery (Plumbing)

Phase 5 aggiunge il plumbing per il recovery da device-lost GPU (non il recovery completo):

- **`renderer.ts`**: `createRenderer()` accetta un parametro `onDeviceLost` callback. Registra un listener su `device.lost` che invoca il callback.
- **`texture-manager.ts`**: Nuova opzione `retainBitmaps` nel costruttore. Quando attiva, `TextureManager` conserva le `ImageBitmap` originali dopo l'upload, permettendo il re-upload dopo un recovery di device.

Il recovery completo (ricreazione di device, re-upload di tutti i buffer, ricreazione di pipeline) e pianificato per una fase futura.

### 18.9 RawAPI: Low-Level Numeric Interface

**File**: `ts/src/raw-api.ts`

Per scenari ad alte prestazioni dove l'overhead di `EntityHandle` e il GC pressure del pool non sono accettabili (es. sistemi particellari con 100k+ entita), `RawAPI` espone un'interfaccia numerica diretta:

```typescript
const raw = engine.raw;
const id = raw.spawn();
raw.setPosition(id, 10, 20, 0);
raw.setVelocity(id, 1, 0, 0);
raw.despawn(id);
```

Nessun oggetto allocato per entita. Nessun pool. Solo numeri e chiamate dirette al `BackpressuredProducer`.

### 18.10 LeakDetector

**File**: `ts/src/leak-detector.ts`

`LeakDetector` usa `FinalizationRegistry` come backstop per rilevare `EntityHandle` non disposed correttamente. Quando un handle viene garbage-collected senza essere stato disposed, il detector logga un warning con l'entity ID.

**Nota**: `FinalizationRegistry` non e un meccanismo di cleanup affidabile per spec — il GC non garantisce che il callback venga mai invocato. Per questo il detector e un **backstop diagnostico**, non il meccanismo primario di cleanup. Il cleanup primario e `.dispose()` esplicito.

---

## 19. Glossario

| Termine | Significato |
|---|---|
| **SPSC** | Single-Producer Single-Consumer — pattern di ring buffer dove un solo thread scrive e un solo thread legge |
| **SAB** | SharedArrayBuffer — buffer di memoria condiviso tra thread (Main Thread e Worker) |
| **COOP/COEP** | Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy — header HTTP necessari per `crossOriginIsolated` |
| **ECS** | Entity Component System — pattern architetturale dove le entita sono ID, i componenti sono dati puri, i sistemi sono funzioni che iterano sui componenti |
| **SoA** | Struct of Arrays — layout di memoria dove componenti dello stesso tipo sono contigui, massimizzando cache hits |
| **Pod** | Plain Old Data — tipo che puo essere copiato bit-a-bit senza effetti collaterali (nessun Drop, nessun puntatore) |
| **FFI** | Foreign Function Interface — meccanismo di chiamata tra linguaggi diversi (qui JS ↔ WASM) |
| **Fixed timestep** | Simulazione a passo temporale fisso (1/60s) per determinismo, indipendente dal framerate di rendering |
| **Spiral of death** | Condizione dove il tempo accumulato cresce piu velocemente di quanto i tick fissi possano consumarlo, causando freeze esponenziale |
| **Accumulator** | Variabile `f32` che accumula il tempo di frame non ancora consumato da tick fissi |
| **Interpolation alpha** | Rapporto `accumulator / FIXED_DT` (0.0–1.0) usato per interpolare visivamente tra due tick fissi |
| **Column-major** | Layout di matrice dove le colonne sono contigue in memoria — formato nativo di WebGPU/WGSL e OpenGL |
| **EntityMap** | Mapping bidirezionale tra ID entita esterni (TypeScript, u32 sequenziali) e Entity interni (hecs, opachi) |
| **Free-list** | Stack LIFO di ID riciclabili dopo despawn, per evitare frammentazione degli ID |
| **EngineBridge** | Interfaccia TypeScript che astrae il transport (Worker `postMessage` vs chiamata diretta) |
| **Marker component** | Componente senza dati (`Active`) usato come filtro per le query ECS |
| **wasm-bindgen** | Macro e toolchain Rust che generano il JS glue code per le funzioni `#[wasm_bindgen]` |
| **addr_of_mut!()** | Macro Rust per ottenere un raw pointer a un `static mut` senza creare un riferimento (richiesto da edition 2024) |
| **WGSL** | WebGPU Shading Language — linguaggio shader nativo di WebGPU, successore di GLSL/HLSL per il web |
| **Instanced drawing** | Tecnica GPU dove una singola draw call renderizza N copie di una mesh con dati per-instance diversi (model matrix, colore) |
| **Indirect draw** | `drawIndexedIndirect` — draw call i cui parametri (instanceCount) risiedono in un GPU buffer scritto dal compute shader, non dalla CPU |
| **Compute culling** | Frustum culling eseguito da un compute shader sulla GPU. Testa la bounding sphere di ogni entita contro i 6 piani del frustum |
| **Visibility indirection** | Pattern dove il vertex shader legge un indice da `visibleIndices[instance_index]` per ottenere l'indice reale dell'entita nel buffer dati |
| **Bounding sphere** | Sfera che racchiude un'entita, definita da centro (xyz) e raggio (w). Usata per il frustum culling approssimato |
| **Frustum planes** | 6 piani (left, right, bottom, top, near, far) estratti dalla matrice view-projection. Ogni piano e vec4 normalizzato (nx, ny, nz, d) |
| **Texture2DArray** | Tipo di texture GPU che contiene N layer (slice) della stessa dimensione. Accesso via `textureSample(tex, sampler, uv, layer)` |
| **TextureManager** | Classe TypeScript che gestisce 4 tier di Texture2DArray (64/128/256/512px) con lazy allocation ed exponential growth, loading asincrono e deduplicazione URL |
| **Packed texture index** | Singolo u32 che codifica tier e layer: `(tier << 16) \| layer`. I 16 bit alti sono il tier, i 16 bassi il layer |
| **RenderState** | Struttura Rust che raccoglie SoA GPU buffers (transforms/bounds/renderMeta/texIndices) + DirtyTracker per partial upload optimization |
| **BitSet** | Struttura compatta per dirty flags per entity slot: un bit per entita, packed in u64 words (~12.5 KB per 100k entita) |
| **DirtyTracker** | Tre BitSet indipendenti (transform, bounds, meta) per tracking granulare delle modifiche per-buffer |
| **RenderPass** | Interfaccia TypeScript per pass modulari del rendering pipeline: dichiara reads/writes su risorse nominate |
| **ResourcePool** | Registry nominato per risorse GPU (GPUBuffer, GPUTexture, GPUTextureView, GPUSampler) |
| **RenderGraph** | DAG di RenderPass con ordinamento topologico (Kahn's algorithm) e dead-pass culling |
| **Blelloch scan** | Algoritmo prefix sum esclusivo work-efficient (O(n) work, O(log n) span) per stream compaction GPU |
| **PrioritizedCommandQueue** | Coda comandi con 4 livelli di priorita (critical > high > normal > low) e limiti soft/hard configurabili |
| **BackpressuredProducer** | Wrapper di `RingBufferProducer` che usa `PrioritizedCommandQueue` come overflow buffer. Metodi convenience (spawnEntity, setPosition, etc.) e `flush()` per drenare la coda nel ring buffer |
| **WorkerSupervisor** | Monitor heartbeat per Worker con detection timeout configurabile. Controlla i contatori heartbeat nel ring buffer header ogni 1 secondo |
| **GPURenderState** | Interfaccia TypeScript per i dati SoA dal WASM: transforms (Float32Array), bounds (Float32Array), renderMeta (Uint32Array), texIndices (Uint32Array), entityCount |
| **NDC** | Normalized Device Coordinates — spazio di coordinate normalizzato dopo la proiezione. WebGPU: X/Y in [-1, 1], Z in [0, 1] |
| **Orthographic projection** | Proiezione che preserva dimensioni degli oggetti indipendentemente dalla distanza — nessuna distorsione prospettica |
| **`?raw` import** | Direttiva Vite che importa un file come stringa grezza al build time, usata per caricare shader WGSL senza richieste runtime |
| **GPU-driven rendering** | Pattern dove la GPU decide cosa renderizzare (compute culling) e quante istanze (indirect draw), riducendo il coinvolgimento della CPU |
| **Facade pattern** | Pattern dove una singola classe (`Hyperion`) espone un'interfaccia semplificata sopra un sottosistema complesso (bridge, renderer, camera, loop, plugins) |
| **EntityHandle** | Wrapper fluent sopra un entity ID numerico. Metodi chainable (`.position().velocity().scale()`). Implementa `Disposable` per cleanup automatico |
| **EntityHandlePool** | Object pool LIFO (cap 1024) per riciclare `EntityHandle` senza pressione GC. `acquire()` riusa, `release()` rimette nel pool |
| **GameLoop** | Gestore del ciclo `requestAnimationFrame` con hook system (preTick/postTick/frameEnd) e FPS tracking |
| **HyperionPlugin** | Interfaccia per plugin dell'engine: `install(engine)` per setup, `cleanup()` opzionale per teardown. Gestiti da `PluginRegistry` |
| **Scene graph** | Gerarchia parent-child tra entita. `Parent` + `Children` components + `propagate_transforms` system. Le model matrix dei figli sono moltiplicate per la matrix del parent |
| **LeakDetector** | Backstop diagnostico via `FinalizationRegistry` per rilevare EntityHandle non disposed. Non garantito dalla spec — solo warning |
| **RawAPI** | Interfaccia numerica diretta per entity management senza overhead di oggetti. Per scenari ad alte prestazioni (100k+ entita) |
| **Memory compaction** | Processo di rilascio della capacita in eccesso nelle strutture dati interne (`EntityMap.shrink_to_fit`, `RenderState.shrink_to_fit`) dopo molti spawn/despawn |
| **PrimitiveParams** | `[f32; 8]` per-entity component per parametri specifici del tipo di primitiva. Split in due ring buffer commands (`SetPrimParams0` + `SetPrimParams1`) per il limite di 16 byte payload |
| **RenderPrimitiveType** | Enum che identifica il tipo di primitiva: Quad=0, Line=1, SDFGlyph=2, BezierPath=3, Gradient=4, BoxShadow=5. Usato dal CullPass per raggruppare le entita e dal ForwardPass per selezionare la pipeline |
| **Multi-pipeline ForwardPass** | Architettura dove ogni tipo di primitiva ha la propria `GPURenderPipeline` con shader dedicato, ma tutte condividono lo stesso bind group layout. `drawIndexedIndirect` per tipo a offset `type * 20` bytes |
| **JFA (Jump Flood Algorithm)** | Algoritmo GPU per calcolare distance field in O(log₂ N) pass. Usato per outline di selezione. Ping-pong tra due texture, ogni pass dimezza il step size |
| **MSDF (Multi-channel Signed Distance Field)** | Tecnica di rendering testo che codifica la distanza dal bordo del glifo in 3 canali (RGB). `median(r,g,b)` produce un SDF pulito per anti-aliasing indipendente dalla scala |
| **SelectionManager** | Classe CPU-side che traccia entita selezionate (`Set<number>`) con dirty tracking e upload maschera GPU. Interfaccia per `SelectionSeedPass` |
| **Dead-pass culling** | Feature del RenderGraph che elimina automaticamente i pass opzionali i cui output non sono consumati da nessun pass vivo. Abilita lo switching dinamico tra pipeline con/senza outline |

---

## 20. Phase 5.5: Rendering Primitives

### 20.0 Panoramica

Phase 5.5 estende il rendering engine da quad-only a **multi-primitiva**. Ogni tipo di primitiva (linea, testo MSDF, gradiente, box shadow) ha il proprio shader WGSL e pipeline GPU, ma tutte condividono lo stesso bind group layout e lo stesso meccanismo di culling.

### 20.1 PrimitiveParams: Dati Per-Primitiva

**Rust**: `PrimitiveParams([f32; 8])` component in `components.rs` — 8 float configurabili per entita. Significato dipende dal `RenderPrimitive` type:

| Tipo | Params 0-3 | Params 4-7 |
| --- | --- | --- |
| **Line** (1) | startX, startY, endX, endY | width, dashLen, gapLen, \_pad |
| **SDFGlyph** (2) | atlasU0, atlasV0, atlasU1, atlasV1 | distRange, fontSize, \_pad, \_pad |
| **Gradient** (4) | type, angle, stop0_pos, stop0_r | stop0_g, stop0_b, stop1_pos, stop1_r |
| **BoxShadow** (5) | rectW, rectH, cornerRadius, blur | colorR, colorG, colorB, colorA |

**Ring buffer**: Due comandi (`SetPrimParams0` discriminante 11, `SetPrimParams1` discriminante 12) perche il ring buffer ha un limite di 16 byte per payload e PrimitiveParams occupa 32 byte.

**WASM exports**: `engine_gpu_prim_params_ptr()` e `engine_gpu_prim_params_f32_len()` espongono il buffer SoA per l'upload a GPU.

### 20.2 Multi-Type CullPass

Il CullPass ora raggruppa le entita visibili per tipo di primitiva. Il compute shader:

1. Legge `renderMeta[idx * 2 + 1]` per ottenere il tipo di primitiva
2. Incrementa atomicamente `drawArgs[primType].instanceCount`
3. Scrive l'indice entita nella regione per-tipo: `visibleIndices[primType * maxEntitiesPerType + slot]`

Il buffer `indirect-args` contiene 6 × `DrawIndirectArgs` (5 u32 ciascuno = 120 bytes totali). Il `prepare()` resetta tutti gli `instanceCount` a zero ogni frame.

### 20.3 Multi-Pipeline ForwardPass

`ForwardPass.SHADER_SOURCES: Record<number, string>` mappa tipo di primitiva → codice WGSL. Al `setup()`, viene creata una `GPURenderPipeline` per ogni tipo registrato, tutte con lo stesso `pipelineLayout` (stessi bind group layout).

Nell'`execute()`, il pass itera su ogni pipeline registrata:

```typescript
for (const [primType, pipeline] of this.pipelines) {
    renderPass.setPipeline(pipeline);
    renderPass.drawIndexedIndirect(indirectBuffer, primType * 20);
}
```

Questo permette di aggiungere nuovi tipi di primitiva senza toccare il codice del pass — basta registrare un nuovo shader.

### 20.4 Post-Processing: FXAA + Tonemapping

Il `ForwardPass` ora scrive a `scene-hdr` (texture intermedia) invece che a `swapchain`. Il `FXAATonemapPass` legge `scene-hdr`, applica FXAA (Lottes) + tonemapping opzionale (PBR Neutral o ACES), e scrive a `swapchain`.

La pipeline completa senza outline: `CullPass → ForwardPass (→ scene-hdr) → FXAATonemapPass (→ swapchain)`

### 20.5 JFA Selection Outlines

Quando le outline sono abilitate, la pipeline diventa:

```text
CullPass → ForwardPass (→ scene-hdr)
         → SelectionSeedPass (→ selection-seed)
         → JFAPass-0 (→ jfa-iter-0)
         → JFAPass-1 (→ jfa-iter-1)
         → ...
         → JFAPass-N (→ jfa-iter-N)
         → OutlineCompositePass (scene-hdr + jfa-iter-N → swapchain)
```

`FXAATonemapPass` viene eliminato automaticamente dal dead-pass culling del RenderGraph perche `OutlineCompositePass` scrive a `swapchain`. Il composite shader include il proprio FXAA.

**JFA iterations**: `ceil(log₂(max(width, height)))` — circa 11 per 1080p. Ogni iterazione e un nodo separato nel RenderGraph con nome risorsa unico (`jfa-iter-N`). Il renderer mappa queste risorse logiche a due texture fisiche di ping-pong nel ResourcePool.

**SelectionManager** (`ts/src/selection.ts`): `Set<number>` CPU-side con dirty tracking. `uploadMask(device, buffer)` scrive una maschera u32 (0/1 per entita) nel buffer `selection-mask`. Il seed shader controlla questa maschera nel vertex shader e emette triangoli degeneri per entita non selezionate.

### 20.6 MSDF Text Rendering

Il subsistema di testo MSDF:

1. **FontAtlas** (`text/font-atlas.ts`): Parser per JSON di `msdf-atlas-gen`. Contiene metriche per glifo (unicode, advance, planeBounds, atlasBounds) + `glyphMap` per lookup O(1).
2. **Text Layout** (`text/text-layout.ts`): `layoutText(text, atlas, fontSize, startX, startY)` posiziona i glifi usando le metriche dell'atlas. Ritorna `LayoutGlyph[]`.
3. **TextManager** (`text/text-manager.ts`): Cache per font atlas caricati.
4. **Shader** (`shaders/msdf-text.wgsl`): Vertex shader mappa UV del quad alla regione dell'atlas via PrimitiveParams. Fragment shader campiona la texture MSDF, calcola `median(r,g,b)`, e applica anti-aliasing basato su screen-pixel-range (`dpdx`/`dpdy`).

---

## 21. Input System (Phase 6)

### 21.1 ExternalId e SoA Entity ID Buffer

Per abilitare il picking CPU-side, serve mappare indici SoA → ID entita TypeScript. Il componente `ExternalId(u32)` viene aggiunto a ogni entita durante `SpawnEntity`:

```rust
CommandType::SpawnEntity => {
    world.spawn((Position::default(), ..., ExternalId(cmd.entity_id)));
}
```

`collect_gpu()` include `ExternalId` nella query hecs e popola un buffer `gpu_entity_ids: Vec<u32>` parallel-indexed con gli altri buffer SoA. Esposto via WASM tramite `engine_gpu_entity_ids_ptr()`/`engine_gpu_entity_ids_len()`. Il buffer `entityIds` e CPU-only — non viene uploadato alla GPU.

### 21.2 InputManager

`InputManager` (`ts/src/input-manager.ts`) gestisce tre canali di input:

- **Keyboard**: `Set<string>` di code correntemente premuti. `isKeyDown(code)` per polling.
- **Pointer**: posizione `(pointerX, pointerY)`, bottoni attivi `Set<number>`. `isButtonDown(button)` per polling.
- **Scroll**: delta accumulato `(scrollDeltaX, scrollDeltaY)` che si resetta ogni frame via `resetFrame()`.

**Lifecycle DOM**:

- `attach(target)` registra `keydown/keyup/pointermove/pointerdown/pointerup/wheel` sul target
- `detach()` rimuove tutti i listener
- `destroy()` chiama `detach()` e pulisce lo stato

**Callback registration**: `onKey(code, fn)` (supporta wildcard `*`), `onClick(fn)`, `onPointerMove(fn)`, `onScroll(fn)`. Ogni metodo ritorna una funzione `Unsubscribe`.

**Integrazione Hyperion**:

- `Hyperion.create()` crea l'InputManager e lo attacca al canvas
- `engine.input` espone l'InputManager
- `resetFrame()` viene chiamato alla fine di ogni `tick()`

### 21.3 CPU Hit Testing (Ray-Sphere)

Il picking CPU-side usa ray-sphere intersection per compatibilita 2.5D e futura estensibilita 3D.

**Pipeline di picking**:

```text
Pixel (x, y)  →  Camera.screenToRay()  →  Ray { origin, direction }
                                               ↓
                               hitTestRay(ray, bounds, entityIds)
                                               ↓
                                         entityId | null
```

**`Camera.screenToRay()`** (`ts/src/camera.ts`):

1. Pixel → NDC (Y-flipped): `ndcX = px/w * 2 - 1`, `ndcY = -(py/h * 2 - 1)`
2. Calcola inverse VP tramite `mat4Inverse()` (espansione per cofattori, NON shortcut ortografico)
3. Unproject near (z=0) e far (z=1) — range depth WebGPU [0,1]
4. Direction = normalize(far - near)

Per camera ortografica, tutti i raggi sono paralleli (direzione costante, origini diverse). Per camera prospettica futura, i raggi divergono dall'occhio — zero cambiamenti API necessari.

**`hitTestRay()`** (`ts/src/hit-tester.ts`):

- Scansione lineare O(n) su tutti i bounding sphere nel buffer SoA `bounds`
- Intersezione quadratica: `a*t² + b*t + c = 0` dove `a = dot(d,d) = 1` (normalizzato)
- Ritorna l'entityId con il t positivo minore (frontmost hit)
- Discriminante negativo = miss, `t < 0` = dietro al raggio

**API pubblica**: `engine.picking.hitTest(pixelX, pixelY)` — combina screenToRay + hitTestRay usando lo stato SoA corrente.

### 21.4 Immediate Mode

Il "immediate mode" permette di bypassare il loop WASM di 1-2 frame per visual feedback istantaneo (es. drag-and-drop):

```text
EntityHandle.positionImmediate(x, y, z)
    ↓
RingBuffer command (per WASM)  +  ImmediateState.set(id, x, y, z) (shadow)
    ↓
In tick(), DOPO bridge.tick() e PRIMA di renderer.render():
    immediateState.patchTransforms(transforms, entityIds, entityCount)
    immediateState.patchBounds(bounds, entityIds, entityCount)
    ↓
Scansione SoA: se entityIds[i] ha override, patcha colonna 3 di transforms[i*16+12..14]
                e patcha bounds[i*4+0..2] (xyz, preservando radius in bounds[i*4+3])
```

**`ImmediateState`** (`ts/src/immediate-state.ts`):

- Backing store: `Map<number, [number, number, number]>`
- `set(id, x, y, z)` / `clear(id)` / `clearAll()`
- `patchTransforms(transforms, entityIds, count)` modifica il buffer SoA transforms in-place
- `patchBounds(bounds, entityIds, count)` modifica il buffer SoA bounds xyz in-place (stride 4, preserva radius)

Entrambi i metodi vengono chiamati in `Hyperion.tick()`. Il picking durante drag ora usa la posizione patchata, non quella WASM (1-2 frame stale).

**EntityHandle integration**: `.positionImmediate(x, y, z)` invia sia il comando ring buffer sia aggiorna lo shadow state. `.clearImmediate()` rimuove l'override. Il cleanup e automatico su `destroy()`.

### 21.5 Click-to-Select Workflow

L'intero flusso dalla pressione del mouse alla outline sullo schermo:

```text
1. Mouse click  →  InputManager.onClick callback
2. engine.picking.hitTest(px, py)  →  Camera.screenToRay  →  hitTestRay  →  entityId
3. engine.selection.toggle(entityId)  →  SelectionManager.dirty = true
4. Next frame: uploadMask(device, buffer)  →  GPU selection-mask buffer
5. SelectionSeedPass  →  JFA iterations  →  OutlineCompositePass  →  outline visible
```

Tutto il picking e CPU-side (nessun readback GPU). Il flusso completo richiede 1-2 frame per mostrare l'outline dopo il click.

---

## 22. Audio System (Phase 7)

### 22.1 Architecture Overview

Il sistema audio usa la Web Audio API del browser con un'architettura a tre strati:

```text
AudioManager (facade pubblica — engine.audio)
    ├── SoundRegistry (gestione buffer audio con URL dedup)
    └── PlaybackEngine (grafo nodi Web Audio + audio spaziale 2D)
            ├── AudioBufferSourceNode × N (playback attivi)
            ├── GainNode × N (volume per-suono con attenuazione spaziale)
            ├── StereoPannerNode × N (panning stereo)
            └── masterGain → AudioContext.destination
```

**Decisione architetturale**: Web Audio API nativa (non WASM AudioWorklet DSP, previsto nel design doc §10). Motivazione: (a) Web Audio gia gira su thread audio dedicato del browser, (b) mixing nativo e piu veloce di WASM, (c) ~70% meno codice, (d) stessa API surface — WASM DSP puo essere aggiunto in futuro.

### 22.2 Branded Types

```typescript
type SoundHandle  = number & { readonly __brand: 'SoundHandle' };
type PlaybackId   = number & { readonly __brand: 'PlaybackId' };
```

Zero-overhead a runtime (solo `number`), ma impediscono mix accidentali a compile-time. Creati via cast: `this.nextHandle++ as SoundHandle`.

### 22.3 SoundRegistry

Gestisce il caricamento, decodifica, e caching dei buffer audio.

- **URL deduplication**: `urlToHandle: Map<string, SoundHandle>` + `handleToUrl: Map<SoundHandle, string>` (bidirezionale, O(1) in entrambe le direzioni)
- **Dependency Injection**: `AudioDecoder = (data: ArrayBuffer) => Promise<AudioBuffer>`, `AudioFetcher = (url: string) => Promise<ArrayBuffer>` — iniettati nel costruttore per testabilita (i test girano in Node.js senza Web Audio API)
- **Batch loading**: `loadAll(urls, { onProgress })` carica sequenzialmente con callback di progresso

### 22.4 PlaybackEngine

Gestisce i playback attivi con grafo nodi Web Audio.

**Catena nodi per ogni `play()`**:
```text
AudioBufferSourceNode → GainNode → StereoPannerNode → masterGain → destination
```

**Audio spaziale 2D**:

```text
pan = clamp(dx / panSpread, -1, 1)     // dx = soundX - listenerX
gain = baseVolume / (1 + distance / rolloff)
if (distance > maxDistance) gain = 0
```

Parametri default: `panSpread = 20`, `rolloff = 10`, `maxDistance = 100`.

**Lifecycle automatico**: `source.onended` chiama `cleanup(id)` — i suoni non-loop vengono rimossi automaticamente dalla mappa attiva quando finiscono.

### 22.5 AudioManager

Facade pubblica (`engine.audio`) che wrappa SoundRegistry + PlaybackEngine.

- **Lazy init**: `AudioContext` creato al primo `load()` o `play()`, rispettando la policy autoplay del browser
- **Safe no-ops**: tutti i metodi di controllo usano optional chaining (`this.engine?.stop(id)`) — sicuri prima dell'inizializzazione
- **Destroy ordering**: nullifica `ctx`/`engine`/`registry` PRIMA di `await ctx.close()` per prevenire accesso concorrente durante teardown asincrono
- **SpatialConfig forwarding**: la config spaziale viene passata dal costruttore di AudioManager a PlaybackEngine

### 22.6 Integrazione con Hyperion

```typescript
// hyperion.ts
private readonly audioManager: AudioManager;

get audio(): AudioManager { return this.audioManager; }

pause()   { this.loop.pause();   void this.audioManager.suspend(); }
resume()  { this.loop.resume();  void this.audioManager.resume(); }
destroy() { /* ... */ void this.audioManager.destroy(); /* ... */ }

private tick(dt: number) {
  // 1. Send camera position to WASM via ring buffer
  this.bridge.commandBuffer.setListenerPosition(this.cameraApi.x, this.cameraApi.y, 0);
  // 2. bridge.tick() → WASM derives velocity, extrapolates during fixed ticks
  this.bridge.tick(dt);
  // 3. Read extrapolated position from WASM render state
  const rs = this.bridge.latestRenderState;
  if (rs && this.audioManager.isInitialized) {
    this.audioManager.setListenerPosition(rs.listenerX, rs.listenerY);
  }
}
```

**Ring-buffer-driven listener** (Phase 7.5): la posizione del listener audio NON viene letta direttamente dalla camera. Viene inviata al WASM tramite `SetListenerPosition` command (discriminante 13), dove l'Engine deriva la velocita dal delta posizionale e la extrapola durante i tick fissi. La posizione extrapolata viene letta da `GPURenderState.listenerX/Y/Z` e inoltrata al `PlaybackEngine`. Questo mantiene l'audio spaziale sincronizzato con il clock di simulazione WASM, non con il clock di rendering JS. `PlaybackEngine.applySpatial()` usa `setTargetAtTime` (TAU 15ms) invece di assegnamento diretto `.value =` per evitare artefatti zipper.

### 22.7 Testabilita

Tutti e tre i layer audio usano dependency injection per testare in Node.js senza browser:

| Classe | DI Points |
| ------ | --------- |
| `SoundRegistry` | `AudioDecoder`, `AudioFetcher` |
| `PlaybackEngine` | `AudioContext` (mock con `createBufferSource`/`createGain`/`createStereoPanner` finti) |
| `AudioManager` | `contextFactory: () => AudioContext` |

67 test audio totali (3 types + 13 registry + 26 playback + 25 manager).

---

## 23. Plugin System v2 (Phase 8)

### 23.1 Panoramica

Phase 8 sostituisce l'interfaccia plugin semplice (`install(engine)`) con un sistema v2 basato su `PluginContext` — un oggetto strutturato con 5 sotto-API che controllano l'accesso del plugin alle risorse dell'engine. Questo elimina il pattern "god object" dove i plugin ricevevano l'intera istanza `Hyperion`.

### 23.2 PluginContext Architecture

**File**: `ts/src/plugin-context.ts`

```typescript
interface HyperionPlugin {
    name: string;
    version?: string;
    dependencies?: string[];
    install(ctx: PluginContext): PluginCleanup | void;
}

type PluginCleanup = () => void;
```

`PluginContext` espone 5 sotto-API:

| Sub-API | Classe | Scopo | Null quando headless? |
| --- | --- | --- | --- |
| `ctx.systems` | `PluginSystemsAPI` | `addPreTick`/`removePreTick`, `addPostTick`/`removePostTick`, `addFrameEnd`/`removeFrameEnd` | No |
| `ctx.events` | `PluginEventAPI` | `on`/`off`/`once`/`emit` — delega all'EventBus condiviso | No |
| `ctx.rendering` | `PluginRenderingAPI` | `addPass`/`removePass` — gestione pass nel RenderGraph | Si |
| `ctx.gpu` | `PluginGpuAPI` | `device`, `createBuffer`/`createTexture`/`destroyTracked` — risorse GPU tracciate | Si |
| `ctx.storage` | `PluginStorageAPI` | `createMap<T>`/`getMap<T>`/`destroyAll` — side-table per entity data | No |

### 23.3 Dependency Resolution

**File**: `ts/src/plugin.ts` — `PluginRegistry`

`PluginRegistry.install()` verifica che tutti i plugin elencati in `dependencies[]` siano gia installati prima di procedere. L'algoritmo e una semplice verifica lineare:

1. Per ogni nome in `plugin.dependencies`, controlla se e presente nella mappa dei plugin installati
2. Se manca una dipendenza, lancia un errore descrittivo con il nome del plugin e della dipendenza mancante
3. I plugin senza `dependencies` vengono installati senza controlli

### 23.4 Error Boundaries

`PluginRegistry` isola i fallimenti dei plugin:

- **Install**: `try/catch` intorno a `plugin.install(ctx)`. Se fallisce, il plugin viene rimosso dalla mappa e l'errore viene wrappato con il nome del plugin e re-lanciato
- **Cleanup**: `try/catch` intorno alla cleanup function. Se fallisce, logga un warning ma continua con i plugin successivi (non blocca il teardown)
- **destroyAll()**: itera tutti i plugin in ordine LIFO, chiamando cleanup con error boundary su ognuno

### 23.5 EventBus

**File**: `ts/src/event-bus.ts`

`EventBus` implementa un pub/sub tipizzato minimale:

- `on(event, listener)` — registra listener, ritorna `Unsubscribe`
- `off(event, listener)` — rimuove listener
- `once(event, listener)` — registra listener che si auto-rimuove dopo la prima invocazione
- `emit(event, ...args)` — notifica tutti i listener. Itera su una copia spread dell'array per sicurezza durante `once()` self-removal
- `destroy()` — pulisce tutte le registrazioni

L'`EventBus` e condiviso tra tutti i `PluginContext` tramite la `PluginEventAPI`, permettendo comunicazione inter-plugin senza accoppiamento diretto.

---

## 24. Shader Hot-Reload (Phase 8)

### 24.1 Meccanismo

**File**: `ts/src/renderer.ts` — `recompileShader(passName, shaderCode)`

Il flusso di hot-reload:

1. L'utente (o Vite HMR) chiama `recompileShader(passName, newWgslSource)`
2. Il renderer aggiorna la sorgente statica nello store interno (es. `ForwardPass.SHADER_SOURCES[type] = newSource`)
3. Chiama `rebuildGraph()` che distrugge tutti i pass esistenti e li ricrea con le nuove sorgenti
4. Il frame successivo usa le pipeline ricompilate

**Non incrementale**: `rebuildGraph()` distrugge e ricrea l'intero grafo di rendering. Questo e accettabile per uno strumento di sviluppo (la ricompilazione avviene solo durante l'editing), ma non per modifiche runtime in produzione.

### 24.2 Vite HMR Integration

Tutti i 10 file WGSL in `ts/src/shaders/` hanno handler `import.meta.hot.accept()` che:

1. Ricevono il nuovo modulo quando Vite rileva una modifica al file
2. Chiamano `renderer.recompileShader(passName, newSource)` con il nome del pass corrispondente
3. Il rendering si aggiorna istantaneamente senza refresh della pagina

Esposto sulla facade `Hyperion` come `recompileShader(passName, shaderCode)` che delega al renderer.

---

## 25. Performance Profiler (Phase 8)

### 25.1 ProfilerOverlay

**File**: `ts/src/profiler.ts`

`ProfilerOverlay` e un overlay DOM-based per visualizzare statistiche di performance in tempo reale:

- **`show(canvas)`** — crea un `<div>` posizionato assolutamente sopra il canvas (richiede `canvas.parentElement` con `position: relative`)
- **`hide()`** — rimuove l'overlay dal DOM
- **`update(stats: HyperionStats)`** — aggiorna il contenuto con FPS, entity count, frame timing, mode
- **`destroy()`** — pulisce e rimuove

**Stile**: monospace, verde su nero semi-trasparente, `pointerEvents: none` per non intercettare click.

**Posizionamento configurabile**: `ProfilerConfig.position` accetta `'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'`.

### 25.2 Integrazione con Hyperion

`Hyperion.enableProfiler(config?)` registra un hook `postTick` che chiama `overlay.update(this.stats)` ogni frame. `disableProfiler()` rimuove l'hook e distrugge l'overlay.

### 25.3 Stats e Metriche (Phase 8)

**GameLoop frame timing** (`ts/src/game-loop.ts`): `frameDt` (delta time dell'ultimo frame in secondi), `frameTimeAvg` (media mobile), `frameTimeMax` (massimo registrato, resettabile).

**HyperionStats** (`ts/src/types.ts`): Esteso con `frameDt`, `frameTimeAvg`, `frameTimeMax` da GameLoop. `tickCount` wired da `GPURenderState` (proveniente da WASM).

**MemoryStats** (`ts/src/types.ts`): `entityMapUtilization` — rapporto tra entita attive e capacita dell'EntityMap.

---

## 26. Phase 9: Advanced 2D Rendering

Phase 9 aggiunge tre feature avanzate di rendering: curve Bezier SDF, bloom post-processing, e un sistema particellare GPU-only.

### 26.1 Quadratic Bezier SDF (Track A)

**File**: `ts/src/shaders/bezier.wgsl`, `ts/src/entity-handle.ts`

#### Algoritmo (Inigo Quilez)

Il rendering delle curve Bezier quadratiche utilizza la distanza SDF analitica di Inigo Quilez. Dato un punto `pos` e tre punti di controllo `a, b, c`:

1. **Riduzione a cubica**: I coefficienti `A = b - a`, `B = a - 2b + c`, `C = 2A`, `D = a - pos` portano a un'equazione cubica nella variabile parametrica `t`
2. **Discriminante**: `h = q^2 + 4p^3` distingue tra una radice reale (`h >= 0`, soluzione via Cardano) e tre radici reali (`h < 0`, soluzione trigonometrica con `acos/cos/sin`)
3. **Clamp e distanza**: Il parametro `t` viene clampato a `[0, 1]` e la distanza euclidea dal punto piu vicino sulla curva viene calcolata

#### Anti-aliasing

Lo stroke e reso con `smoothstep()` basato su `fwidth()` per un bordo anti-aliasato di 1 pixel indipendente dalla risoluzione. I frammenti con alpha < 0.01 vengono scartati con `discard`.

#### Coordinate UV-Space

I punti di controllo sono in spazio UV `[0,1]^2` relativo al quad dell'entita. La posizione e scala dell'entita definiscono il bounding box in world-space. Questo permette curve consistenti indipendentemente dalla trasformazione.

#### PrimParams Layout

| Offset | Campo | Tipo |
|--------|-------|------|
| 0 | p0x | f32 |
| 1 | p0y | f32 |
| 2 | p1x | f32 |
| 3 | p1y | f32 |
| 4 | p2x | f32 |
| 5 | p2y | f32 |
| 6 | width (stroke) | f32 |
| 7 | _pad | f32 |

`EntityHandle.bezier(p0x, p0y, p1x, p1y, p2x, p2y, width)` imposta `RenderPrimitiveType.BezierPath` (3) e scrive i PrimParams via `SetPrimParams0`/`SetPrimParams1`.

### 26.2 Dual Kawase Bloom (Track B)

**File**: `ts/src/shaders/bloom.wgsl`, `ts/src/render/passes/bloom-pass.ts`, `ts/src/renderer.ts`

#### Pipeline a 6 Step

Il bloom usa la tecnica Dual Kawase con una catena interna di 6 sub-pass:

1. **Extract** (`fs_extract`): Estrae pixel luminosi con soglia configurabile. Formula: `contrib = max(luminance - threshold, 0)`, scalato per preservare il rapporto cromatico
2. **Downsample 1** (`fs_downsample`): scene-hdr (full) -> bloom-half (1/2 res). Kawase 4-tap con half-texel offset: `(center * 4 + 4 corners) / 8`
3. **Downsample 2** (`fs_downsample`): bloom-half -> bloom-quarter (1/4 res). Stesso filtro
4. **Upsample 1** (`fs_upsample`): bloom-quarter -> bloom-half. Kawase 9-tap tent filter: `(corners + edges*2 + center*4) / 16`
5. **Upsample 2** (`fs_upsample`): bloom-quarter -> bloom-half. Output used as final bloom contribution in composite step
6. **Composite** (`fs_composite`): Combina scene (con FXAA) + bloom additivo, poi applica tonemapping

#### Texture Intermedie

Tre texture `rgba16float` gestite dal renderer coordinator:

- `bloom-half`: `floor(w/2) x floor(h/2)`
- `bloom-quarter`: `floor(w/4) x floor(h/4)`
- `bloom-eighth`: `floor(w/8) x floor(h/8)`

Ricreate automaticamente al resize del canvas.

#### BloomParams Uniform (32 bytes)

| Offset | Campo | Tipo |
|--------|-------|------|
| 0 | texelSize.x | f32 |
| 4 | texelSize.y | f32 |
| 8 | threshold | f32 |
| 12 | intensity | f32 |
| 16 | tonemapMode | u32 |
| 20-28 | padding | u32 x 3 |

`tonemapMode`: 0=none, 1=PBR Neutral (Khronos), 2=ACES filmic.

#### Mutua Esclusivita con Outlines

Bloom e outlines sono mutuamente esclusivi: entrambi scrivono su `swapchain`, causando dead-pass culling di `FXAATonemapPass`. `enableBloom()` disabilita outlines e viceversa, con warning in console. API sulla facade: `engine.enableBloom(config?)` / `engine.disableBloom()`.

#### BloomConfig

```typescript
interface BloomConfig {
  threshold?: number;   // default 0.7
  intensity?: number;   // default 1.0
  levels?: number;      // reserved, default 3
  tonemapMode?: number; // 0=none, 1=PBR Neutral, 2=ACES
}
```

### 26.3 GPU Particle System (Track C)

**File**: `ts/src/shaders/particle-simulate.wgsl`, `ts/src/shaders/particle-render.wgsl`, `ts/src/particle-types.ts`, `ts/src/particle-system.ts`

#### Architettura: Compute -> Render

Le particelle sono interamente GPU-side, **non** entita ECS. Questo evita saturazione del ring buffer e overhead WASM per migliaia di particelle per frame.

```text
ParticleSystem.update(encoder, swapchainView, cameraVP, dt, entityPositions)
  |
  +-- Per ogni emitter:
       |
       +-- Upload config uniform (112 bytes)
       +-- Upload camera VP (64 bytes)
       +-- Reset counters a [0, 0]
       |
       +-- Compute: simulate (workgroup_size=64)
       |     -> Avanza eta, applica gravita, interpola colore/dimensione
       |     -> Incrementa atomicAdd(&counter[0]) per particelle vive
       |
       +-- Compute: spawn (workgroup_size=64)
       |     -> Cerca slot liberi (age >= lifetime) con probing lineare
       |     -> Inizializza posizione/velocita/colore da config con PRNG
       |
       +-- Render: instanced point sprites
             -> Triangle strip (4 vertici), instanceCount = maxParticles
             -> Dead particles clippate a z = -2.0
             -> Circle SDF con fwidth() anti-aliasing
             -> Alpha blending additivo (src-alpha, one-minus-src-alpha)
```

#### Particle Struct (48 bytes = 12 f32)

| Campo | Tipo | Offset |
|-------|------|--------|
| position | vec2f | 0 |
| velocity | vec2f | 8 |
| color | vec4f | 16 |
| lifetime | f32 | 32 |
| age | f32 | 36 |
| size | f32 | 40 |
| _pad | f32 | 44 |

#### PCG Hash PRNG

```wgsl
fn pcg_hash(input: u32) -> u32 {
  var state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
```

Il seed e derivato da `spawnIdx * 7919 + candidateSlot * 6271`, garantendo distribuzione uniforme per-frame. Non crittograficamente sicuro, ma adeguato per effetti visivi.

#### Spawn Accumulator

A 60fps con `emissionRate=100`, `Math.floor(100 * 0.0167) = 1` per frame, ma il valore esatto e 1.67. Senza accumulatore si perdono ~40% delle particelle.

```typescript
state.spawnAccumulator += state.config.emissionRate * dt;
const spawnCount = Math.floor(state.spawnAccumulator);
state.spawnAccumulator -= spawnCount;
```

Il resto frazionario viene portato al frame successivo.

#### Entity Position Tracking

Gli emitter possono opzionalmente seguire la posizione di un'entita ECS:

```typescript
engine.createParticleEmitter({
  maxParticles: 200,
  emissionRate: 80,
  // ...
}, entityHandle.id); // <- segue questa entita
```

In `ParticleSystem.update()`, una mappa `entityId -> [x, y]` viene costruita dai transform SoA e usata per risolvere la posizione dell'emitter.

#### Rendering dopo il RenderGraph

Le particelle vengono renderizzate **dopo** che il RenderGraph ha completato il pass compositing (FXAA/bloom/outlines). Il render pass usa `loadOp: 'load'` sul swapchain, disegnando sopra la scena. Questo significa che le particelle **non** sono influenzate da bloom o FXAA.

#### Buffer GPU per Emitter

Ogni emitter alloca 4 buffer:

- **Particle storage** (`maxParticles * 48` bytes): dati particella read/write
- **Counter** (8 bytes): `[aliveCount: atomic<u32>, spawnCounter: atomic<u32>]`
- **Config uniform** (112 bytes): parametri emitter allineati a 16 byte
- **Camera uniform** (64 bytes): `mat4x4f` view-projection

### 26.4 Nuovi Shader e HMR

Phase 9 aggiunge 4 nuovi file WGSL e 5 nuovi handler `import.meta.hot.accept()`:

| Shader | Entry Points | HMR Pass Name |
|--------|-------------|----------------|
| `bezier.wgsl` | `vs_main`, `fs_main` | `bezier` |
| `bloom.wgsl` | `vs_main`, `fs_extract`, `fs_downsample`, `fs_upsample`, `fs_composite` | `bloom` |
| `particle-simulate.wgsl` | `simulate`, `spawn` | `particle-simulate` |
| `particle-render.wgsl` | `vs_main`, `fs_main` | `particle-render` |

Total WGSL files with HMR: 14 (up from 10 in Phase 8). `prefix-sum.wgsl` is excluded (CPU reference only).
