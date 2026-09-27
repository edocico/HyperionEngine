# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

### Quick Reference

```bash
# Full validation (run before committing) — the single definition of "validated"
scripts/preflight.sh          # feature matrix + clippy -D warnings + TS + protocol check
scripts/preflight.sh --full   # + release WASM builds and size gates (~1 min more)

# Full rebuild + visual test
cd ts && npm run build:wasm && npm run dev

# Cross-version physics determinism (for rapier/parry/glam upgrades)
node scripts/determinism-cross-version.mjs <wasmDir> <scenario>   # wasm-vs-wasm, 7 scenarios
```

### Rust

```bash
cargo test -p hyperion-core                  # All Rust unit tests (198 tests, 276 with physics-2d, 227 with dev-tools, 320 with all features)
cargo test -p hyperion-core --all-features   # + 91 integration tests across 7 files (320 lib + 91 = 411 total)
cargo clippy -p hyperion-core                # Lint check (treat warnings as errors)
cargo build -p hyperion-core                 # Build crate (native, not WASM)
cargo doc -p hyperion-core --open            # Generate and open API docs

# Run specific test groups
cargo test -p hyperion-core ring_buffer      # Ring buffer tests only (42 tests)
cargo test -p hyperion-core engine           # Engine tests only (16 tests, 25 with physics-2d, 64 with physics-2d+dev-tools)
cargo test -p hyperion-core render_state     # Render state tests only (55 tests)
cargo test -p hyperion-core command_proc     # Command processor tests only (40 tests, 41 with physics-2d)
cargo test -p hyperion-core systems          # Systems tests only (19 tests, 21 with physics-2d)
cargo test -p hyperion-core components       # Component tests only (28 tests)

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

# Compile with physics (outputs to ts/wasm-physics/)
cd ts && npm run build:wasm:physics
cd ts && npm run build:wasm:physics:release

# After building, check generated TypeScript types
cat ts/wasm/hyperion_core.d.ts
```

### TypeScript

```bash
cd ts && npm test                            # All vitest tests (1275 tests + 5 skipped, 93 files)
cd ts && npm run test:watch                  # Watch mode (re-runs on file change)
cd ts && npx tsc --noEmit                    # Type-check only (no output files)
cd ts && npm run build                       # Production build (tsc + vite build)
cd ts && npm run dev                         # Vite dev server with COOP/COEP headers

# Run a specific test file (pattern: npx vitest run src/<path>.test.ts)
# 93 test files colocated with source across src/, src/render/, src/render/passes/, src/shaders/, src/debug/, src/prefab/, src/replay/, src/demo/, src/asset-pipeline/, src/text/, src/hmr/, src/plugins/
cd ts && npx vitest run src/hyperion.test.ts                  # e.g. Hyperion facade (86 tests)
cd ts && npx vitest run src/backpressure.test.ts              # e.g. Backpressure queue (100 tests)
cd ts && npx vitest run src/entity-handle.test.ts             # e.g. EntityHandle fluent API (74 tests)
cd ts && npx vitest run src/render/passes/cull-pass.test.ts   # e.g. CullPass (42 tests)
cd ts && npx vitest run src/physics-api.test.ts               # e.g. PhysicsAPI events + queries (20 tests)
cd ts && npx vitest run src/lighting-api.test.ts              # e.g. LightingAPI backend/ambient/quality/groups (21 tests)

# Physics tests (requires feature flag)
cargo test -p hyperion-core --features physics-2d  # Includes physics simulation tests (276 lib tests, 358 with integration)
cargo clippy -p hyperion-core --features physics-2d

# Physics debug rendering (requires physics-debug feature, implies physics-2d)
cargo test -p hyperion-core --features "physics-debug dev-tools"   # 320 lib tests (411 with integration)
cd ts && npm run build:wasm:physics:dev            # dev WASM build with physics-2d + dev-tools + physics-debug

# Debug/dev-tools (requires feature flag)
cargo test -p hyperion-core --features dev-tools   # Includes dev-tools gated tests (227 lib tests, 268 with integration)
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

# Pinned toolchains (do not use ad-hoc versions)
# - Rust:  rust-toolchain.toml pins 1.97.1 + wasm32 target + clippy/rustfmt (rustup auto-installs)
# - Node:  ts/package.json "engines": "^24" + ts/.nvmrc; ts/.npmrc sets engine-strict=true
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
- **FinalizationRegistry as backstop only:** Primary cleanup is explicit `destroy()` (or `using`, i.e. `[Symbol.dispose]()`). GC-based cleanup is unreliable per spec.
- **`addr_of_mut!()` for static mut access:** Required by Rust 2024 edition; avoids creating references to uninitialized statics.

### Crate: hyperion-core

| Module | Role |
|---|---|
| `lib.rs` | WASM exports: `engine_init`, `engine_push_commands` (the live command path), `engine_memory`, `engine_attach_ring_buffer` (unused — see Gotchas), `engine_update`, `engine_tick_count`, `engine_gpu_transforms_ptr/f32_len`, `engine_gpu_bounds_ptr/f32_len`, `engine_gpu_render_meta_ptr/len`, `engine_gpu_prim_params_ptr/f32_len`, `engine_gpu_entity_count`, `engine_rejected_command_count`, `engine_dropped_command_bytes`, `engine_gpu_tex_indices_ptr/len`, `engine_gpu_entity_ids_ptr/len`, `engine_compact_entity_map`, `engine_compact_render_state`, `engine_entity_map_capacity`, `engine_listener_x/y/z`, `engine_ambient_r/g/b/intensity`, `engine_lighting_backend`, `engine_dirty_count/ratio`, `engine_staging_ptr/u32_len`, `engine_staging_indices_ptr/len`, `engine_gpu_depths_ptr/f32_len`. Physics (physics-2d): `engine_physics_configure`, `engine_physics_body_count`, `engine_collision_events_ptr/count`, `engine_contact_force_events_ptr/count`, `engine_physics_raycast/raycast_result_ptr`, `engine_physics_overlap_aabb/overlap_circle/overlap_results_ptr`, `engine_character_grounded`, `engine_character_sliding`. Dev-tools: `engine_reset`, `engine_snapshot_create`, `engine_snapshot_restore`, `engine_state_hash` (u64→BigInt). Physics-debug: `engine_physics_debug_ptr/f32_len` (8 f32/line: [ax,ay,bx,by,r,g,b,a]) |
| `engine.rs` | `Engine` struct with fixed-timestep accumulator, ties together ECS + commands + systems. Wires `propagate_transforms` for scene graph hierarchy + 2D system variants (`velocity_system_2d`, `transform_system_2d`). Listener position state with velocity derivation and extrapolation. Lighting engine-level state: `ambient_light: [f32;4]` and `lighting_backend: u8`, set by CommandType 55/56 intercepted before ECS dispatch on the `entity_id = 0` sentinel (same shape as `SetListenerPosition`); NOT in the HSNP trailer — see Gotchas. `#[cfg(feature = "physics-2d")]`: `HyperionPhysicsWorld` field, `physics_sync_pre`/`step`/`physics_sync_post` in tick loop, filtered velocity systems, physics dirty marking, despawn cleanup. Dev-tools: `reset()`, `snapshot_create()`/`snapshot_restore()` (HSNP v3: u32 mask, 2D archetype, is_2d flags, physics section rebuilt-from-state, GPU slot reassignment, integrity trailer, v1/v2 read back-compat), `state_hash()` (FNV-1a 64 over ext-ID-ordered bit patterns). Physics-debug: `debug_render_enabled` flag (CommandType 47), `debug_lines: Vec<f32>` regenerated once per frame |
| `command_processor.rs` | `EntityMap` (external ID ↔ hecs Entity; binds the ids TS chooses and allocates none, `shrink_to_fit()`, `iter_mapped()`, `is_2d` flag per entity) + `process_commands` (including `SetParent`, 2D/3D command routing, batch spawn partitioning) |
| `ring_buffer.rs` | SPSC consumer with atomic read/write heads, `CommandType` enum (57 variants: 17 core (0-16) + 36 physics/debug (17-52) + 4 lighting (53-56), ending at `SetLightingBackend`(56) incl. `CreateRigidBody`, `CreateCollider`, `ApplyForce`, `CreateRevoluteJoint`, `SetSpringParams`, `SetJointAnchorA/B`, `CreateCharacterController`, `SetCharacterConfig`, `MoveCharacter`, `SetLightFlags`, `SetAmbientLight`), `Command` struct |
| `physics.rs` | `#[cfg(feature = "physics-2d")]` — `PendingRigidBody`, `PendingCollider` (defaults+override staging+`from_payload`), `PhysicsBodyHandle`, `PhysicsColliderHandle`, `PhysicsControlled` marker. `JointEntry` (rapier handle + entity_a/b pair + `kind` byte recorded at creation), `PendingJointType` (5 variants: Revolute/Prismatic/Fixed/Rope/Spring), `PendingJoint` (type + joint_id + entity pair + anchors + params). `CharacterState` (grounded/sliding booleans), `CharacterEntry` (controller + state), `character_map: HashMap<u32, CharacterEntry>`, `pending_moves: Vec<(u32, f32, f32)>`. `HyperionCollisionEvent` (#[repr(C)] 12-byte: entity_a/b, event_type, is_sensor), `HyperionContactForceEvent` (#[repr(C)] 20-byte: entity_a/b, max_force_magnitude, max_force_direction_x/y). `HyperionPhysicsWorld` (wraps all Rapier2D state: body/collider/joint sets, pipeline, events, `joint_map: HashMap<u32, JointEntry>`, `pending_joints: Vec<PendingJoint>` + `raycast()`/`overlap_aabb()`/`overlap_circle()` scene queries). Static buffers: `RAYCAST_RESULT`, `OVERLAP_RESULTS`. `physics_sync_pre` (consumes pending→Rapier bodies/colliders/joints [Pass 4], kinematic sync, character controller move_shape [Pass 5]), `physics_sync_post` (Rapier→ECS writeback), `build_collider_shape` (shape type→ColliderBuilder). `snapshot` module (physics-2d+dev-tools): `serialize_physics`/`restore_physics` — readback-from-Rapier physics section (world config, bodies, colliders, joints incl. full GenericJoint state, character controllers). `debug` module (physics-debug): `HyperionPhysicsWorld::debug_render()` via persistent `DebugRenderPipeline`, HSLA→RGBA conversion |
| `physics_commands.rs` | `#[cfg(feature = "physics-2d")]` — `process_physics_commands`: second-pass command router for 25 live-body Rapier commands — body forces/params (ApplyForce, ApplyImpulse, ApplyTorque, SetGravityScale, SetLinearDamping, SetAngularDamping, SetCCDEnabled) + collider overrides (SetColliderSensor, SetColliderDensity, SetColliderRestitution, SetColliderFriction, SetCollisionGroups, SetColliderEvents) + TeleportBody + joint commands (RemoveJoint, SetJointMotor, SetJointLimits, SetSpringParams, SetJointAnchorA, SetJointAnchorB) + character controller commands (CreateCharacterController, SetCharacterConfig, MoveCharacter, DestroyCharacterController, SetCharacterUp [44-46, 51-52]) |
| `components.rs` | `Position(Vec3)`, `Rotation(Quat)`, `Scale(Vec3)`, `Velocity(Vec3)`, `ModelMatrix([f32;16])`, `BoundingRadius(f32)`, `TextureLayerIndex(u32)`, `MeshHandle(u32)`, `RenderPrimitive(u32)`, `PrimitiveParams([f32;8])`, `ExternalId(u32)`, `Active`, `Parent(u32)`, `Children` (fixed 32-slot inline array), `LocalMatrix([f32;16])`, `Transform2D { x, y, rot, sx, sy }` (20 bytes, compact 2D archetype), `Depth(f32)` (opt-in 2.5D), `Transparent(u8)` (blend mode flag), `LightFlags(u32)` (renderMeta bits 9-31, pre-shifted) — all `#[repr(C)]` Pod. Plus `LightType`/`LightBlendMode` enums, the `RENDER_META_*` bit-layout constants and `PRIM_TYPE_LIGHT2D`. `OverflowChildren(Vec<u32>)` — heap fallback for 33+ children, NOT `#[repr(C)]`/Pod |
| `systems.rs` | `velocity_system`, `velocity_system_2d`, `velocity_system_filtered`, `velocity_system_2d_filtered`, `transform_system`, `transform_system_2d`, `count_active`, `propagate_transforms` (scene graph hierarchy, arbitrary depth), `update_bounding_radii` (per-frame radius from world matrix, **plus** a second query that derives a `Light2D`'s radius from `PrimitiveParams[3]` instead — order between the two is a correctness invariant, see Gotchas; global and directional lights get `f32::MAX`, so they are never culled) |
| `render_state.rs` | `collect()` for legacy matrices, `collect_gpu()` for SoA GPU buffers (transforms/bounds/renderMeta/texIndices/primParams/entityIds) + `BitSet`/`DirtyTracker` for partial upload optimization + stable slot mapping (`assign_slot`/`get_slot`/`flush_pending_despawns` with swap-remove) + `collect_dirty_staging()` for GPU scatter upload (128B/entity staging buffer) + `write_slot()` for in-place SoA updates + `shrink_to_fit()` for memory compaction |

### TypeScript: ts/src/

#### Core & Public API

| Module | Role |
|---|---|
| `hyperion.ts` | `Hyperion` — public facade: `create()`, `spawn()`, `batch()`, `start/pause/resume/destroy`, `use()/unuse()`, `addHook/removeHook`, `loadTexture/loadTextures`, `compact()`, `resize()`, `selection`, `enableOutlines/disableOutlines`, `enableBloom/disableBloom`, `createParticleEmitter/destroyParticleEmitter`, `input`, `picking`, `audio`, `physics` (PhysicsAPI), `lighting` (LightingAPI), `prefabs`, `enableProfiler/disableProfiler`, `gpuProfilingSupported`/`enableGpuProfiling`/`disableGpuProfiling`/`getGpuTimings`, `recompileShader`, `compressionFormat`, `debug` (recording tap). `fromParts()` test factory |
| `entity-handle.ts` | `EntityHandle` — fluent builder (`.position/.velocity/.rotation/.scale/.texture/.mesh/.primitive/.parent/.unparent/.line/.gradient/.boxShadow/.bezier/.data/.positionImmediate/.clearImmediate`). Physics: `.rigidBody()/.collider()/.gravityScale()/.linearDamping()/.applyForce()/.applyImpulse()`. Joints: `.revoluteJoint()/.prismaticJoint()/.fixedJoint()/.ropeJoint()/.springJoint()` (return `JointHandle`). Character controller: `.characterController()/.characterConfig()/.moveCharacter()`. Lighting: `.light()/.shadows()/.castsShadow()/.receivesLight()/.lightLayers()` + the `LightOptions`/`LightType`/`LightBlendMode` types. `RenderPrimitiveType` enum (0-6, 6 = Light2D). Implements `Disposable` |
| `raw-api.ts` | `RawAPI` — low-level numeric ID entity management bypassing EntityHandle overhead. Takes `RawIdHooks` (allocate/release/isLive) from the facade: `despawn` of a non-live id is a no-op (dev warning), of an EntityHandle's id throws; setters to a non-live id are dropped. A bare allocator function still works (no checks) |
| `entity-id-allocator.ts` | `EntityIdAllocator` — external ids, fresh first, then released ids FIFO after a quarantine (`free` → `written(id, seq)` → `advance(processedSeq, tickCount)`); a live-state byte per id, so a double free is a no-op; owner `handle`/`raw` |
| `tick-sequencer.ts` | `TickSequencer` — numbers the ticks a bridge sends and records the engine's echo (`processed: {seq, tickCount}`); `nextSeq` stamps a written despawn |
| `types.ts` | `HyperionConfig`, `ResolvedConfig`, `HyperionStats`, `MemoryStats`, `CompactOptions`, `TextureHandle` |
| `index.ts` | Barrel export (includes `BloomConfig`, `ParticleEmitterConfig`, `ParticleHandle`, `DEFAULT_PARTICLE_CONFIG`, `KTX2Container`, `BasisTranscoder`, `detectCompressedFormat`, `PrefabRegistry`, `boundsVisualizerPlugin`, `CommandTapeRecorder`, `ReplayPlayer`, `SnapshotManager`, `createHotSystem`, `PhysicsAPI`, `CollisionEvent`, `ContactForceEvent`, `RaycastHit`, `JointHandle`, `drainCollisionEvents`, `drainContactForceEvents`, `CharacterControllerConfig`, `LightingAPI`, `DEFAULT_LIGHTING_QUALITY`, `LightingBackend`, `LightingQuality`, `LightOptions`, `LightType`, `LightBlendMode`) |
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
| `game-loop.ts` | `GameLoop` — RAF lifecycle with preTick/postTick/frameEnd hooks, FPS/frame-time tracking. Hooks run isolated (`runHooks`): a hook that throws is reported when it starts failing and removed after `MAX_CONSECUTIVE_HOOK_FAILURES` (60) throws in a row — a success resets the count, and each registration counts its own. `removeHook` is safe from inside any hook (a removal during its phase leaves a `null`, compacted when the phase ends); a hook added during its phase first runs on the next frame. `tickFn` is NOT isolated |
| `camera.ts` | Orthographic camera, `extractFrustumPlanes()`, `isSphereInFrustum()`, `mat4Inverse()`, `screenToRay()` |
| `camera-api.ts` | `CameraAPI` — zoom support (min 0.01), `x`/`y` position getters |
| `capabilities.ts` | Browser feature detection, selects ExecutionMode A/B/C, `detectCompressedFormat()` for BC7/ASTC probing, `detectSubgroupSupport()` with `hasSubgroupId` for Chrome 144+ builtins, `detectSizedBindingArrays()` with empirical size probing (256→1024) |
| `leak-detector.ts` | `LeakDetector` — `FinalizationRegistry` backstop for undisposed EntityHandles |
| `main.ts` | Tab-based verification harness: 9-section switcher (through `demo/section-switcher.ts`), lazy-loaded demo sections, check panel, JSON report export. Runs in **Mode B by default** (`demo/preferred-mode.ts`, override `?mode=A|B|C|auto`): Chrome would pick Mode A, whose main thread has no renderer, so profiling/outlines/bloom/particles/overlays could not be checked |

#### Bridge & Workers

| Module | Role |
|---|---|
| `ring-buffer.ts` | `RingBufferProducer` — serializes commands into SharedArrayBuffer with Atomics. `CommandType` const enum (57 variants), `PAYLOAD_SIZES` record |
| `backpressure.ts` | `PrioritizedCommandQueue` + `BackpressuredProducer` — wraps RingBufferProducer with priority queuing + `setRecordingTap()` for command tape recording + `isNonCoalescable()` for physics commands + 36 physics producer methods total: 16 body/collider (17-32) + 11 joint (33-43) + 5 character controller (44-46, 51-52) + 4 audit-2026-07 additions (setPhysicsDebugRender 47, setColliderEvents 48, teleportBody 49, setBoundingRadius 50). Plus 4 lighting producer methods (53-56) and `ENGINE_LEVEL_COMMANDS`, which exempts the `entity_id = 0` sentinel commands from `purgeEntity()`. Id reuse: `setDespawnWrittenListener` (fired when a DespawnEntity is WRITTEN, in `drainTo`), `setReferenceGuard` (refuses a SetParent to a quarantined id), and a parent → pending-SetParent index so a despawn purges the SetParents pointing at it |
| `worker-bridge.ts` | `EngineBridge` interface — `createFullIsolationBridge(canvas)` (A), `createWorkerBridge()` (B), `createDirectBridge()` (C). `GPURenderState` type. `nextTickSeq`/`processed` (a `TickSequencer` per bridge; Mode A acks before its `entityCount > 0` filter) drive the id quarantine |
| `engine-worker.ts` | Web Worker: loads WASM, calls `engine_init`/`engine_update`, heartbeat counter. Echoes the tick's `seq` in both `tick-done` branches |
| `render-worker.ts` | Mode A: OffscreenCanvas + `createRenderer()`. Receives `lighting-quality` (from `EngineBridge.setLightingQuality`) and applies it, also when it arrives before the renderer exists |
| `supervisor.ts` | `WorkerSupervisor` — heartbeat monitoring + timeout detection |
| `ring-buffer-bench.ts` | `measureRingBufferSaturation()` — stress benchmark for ring buffer utilization. Verdict: no-action/monitor/optimize |

#### Rendering Pipeline

| Module | Role |
|---|---|
| `renderer.ts` | RenderGraph coordinator: ResourcePool, CullPass+ForwardPass+FXAATonemapPass, optional outlines/bloom, optional lighting (graph mode `lighting`, requested when `GPURenderState.lightingBackend` CHANGES — `followLightingBackend`; `FrameState.ambient`/`shadowSteps`/`lightGroups` (from `deriveLightGroups`, only while the live graph is lit, with a one-time warning for multi-bit receivers); `setLightingQuality()`, `lightingEnabled`; the lit graph is ONE node, `LightGroupsPass`, which sizes its own textures) — the graph is owned by `RenderGraphHost` (a new one goes live only after GPU validation) and requests/hot-reload by `GraphRequests`; `shaderSlots` table (source accessor + throwaway probe pass + which modes use it); `addPass()/removePass()` for caller-owned passes (plugin overlays); particle shaders reloaded with their own GPU-validated rollback, ParticleSystem integration, shader HMR (19 WGSL files imported, 18 hot-reloadable; the `sdf-jfa`/`light-accum` slots and the primitive slots probe a throwaway `LightGroupsPass`), device-lost recovery, compressed texture format detection + overflow views |
| `texture-manager.ts` | Multi-tier Texture2DArray with compressed format support (BC7/ASTC), overflow tiers for mixed-mode, lazy allocation (0→16→32→64→128→256), KTX2 load path, `createImageBitmap` pipeline, `TexturePriorityQueue` min-heap for viewport-distance-based load ordering |
| `render/render-pass.ts` | `RenderPass` interface + `FrameState` type. A pass may expose `profileStages(frame)` and then receives `mark(encoder)` as the 4th `execute` argument (GPU profiler stages). `FrameState.lightGroups` (light layers) |
| `render/resource-pool.ts` | `ResourcePool` — named GPU resource registry |
| `render/render-graph.ts` | `RenderGraph` — DAG scheduling with Kahn's topological sort + dead-pass culling + optional `setProfiler()` GPU timing hook. One blind writer per resource; later writers must also READ it (read-modify-write chain, ordered by registration). `detachPass()` removes without destroying |
| `render/graph-assembly.ts` | `composeRenderGraph(mode, factories, external)` — PURE composition + compile, no GPU work (factories only construct passes): exactly one final composite (outline-composite > bloom > fxaa-tonemap), external passes registered last. `GraphMode.lighting` is orthogonal to the composite: it adds `factories.lighting()` (one `LightGroupsPass`) and `factories.scene(mode)` builds a ForwardPass that reads `light-buffer` |
| `render/graph-host.ts` | `RenderGraphHost` — owns the live graph and at most one pending one. `request(mode)`: compose → `prepare` (JFA/bloom textures) → `setup` inside GPU error scopes → the new graph goes live only when the GPU reports no error ('swapped' / 'rejected' / 'superseded'). `addExternal` validates against every mode's graph (3 composites × lighting on/off) and joins the graphs only once the GPU has validated the pass's set-up. `createGpuValidation(device)` — pushes/pops the internal, out-of-memory and validation scopes; a rejected pop counts as an error |
| `render/graph-requests.ts` | `GraphRequests` — requested vs live mode (`requested` getter, fallback on rejection, off-intents: a switched-off feature is requested off again if a later request is rejected before a graph without it goes live, unless that exact graph is the one rejected), in-place option updates (outline colour/width, `BloomPass.configure`), `reloadShader()`: each shader validated ALONE via a throwaway probe pass; its new source is in the static slot only for the synchronous probe; a graph is rebuilt only if the requested mode uses it; a rejected graph restores every slot to the live graph's sources. `setLighting(enabled)` keeps the composite and its options; switching the composite keeps lighting |
| `render/lighting-backend.ts` | `followLightingBackend(apply, warn)` — turns the per-frame backend id into graph requests on CHANGE only (a rejected lit graph is not retried every frame); `gi` runs unlit with one warning. `unsupportedLightingQuality()` — the quality keys the lit backend ignores (`bufferScale`, `sdfOversize`) |
| `render/formats.ts` | `SCENE_HDR_FORMAT` (`rgba16float`, for `scene-hdr` + the bloom mip chain) and `JFA_FORMAT` (selection-seed + jump-flood ping-pong). Single source of truth for both pairs of pipeline-format / texture-format |
| `render/gpu-profiler.ts` | `GpuProfiler` — per-pass GPU timing via `timestamp-query`. Empty compute passes as markers between graph passes; a staged pass (`profileStages`) marks its own stages, reported as `pass/stage` and SUMMED when a name repeats in a frame; a name missing from a frame counts as 0 ms in it, and one seen for the first time as 0 ms in the window's earlier frames, so every mean is per frame and every entry has the same `sampleCount`; a name missing for a whole window is forgotten; a frame whose marks do not match its names is dropped (and its readback buffer always unmapped); 256 markers by default; 3 rotating readback buffers; `WINDOW`=120 rolling mean; generation counter invalidates in-flight frames on `reset()`. `PassTiming` type |
| `render/passes/cull-pass.ts` | GPU frustum culling compute, 7 primitive types, per-type DrawIndirectArgs. `prepareShaderSource()` — prepends `enable subgroups;` when supported, **strips** the `BEGIN/END-SUBGROUPS-ONLY` region when not |
| `render/passes/forward-pass.ts` | Multi-pipeline forward pass, `SHADER_SOURCES` per RenderPrimitiveType, renders to `scene-hdr`. Three-group layout: group 2 = light buffer as a `texture_2d_array` (one layer per light group), filtering sampler, 16-byte `LightingUniform {enabled, groupTableLo, groupTableHi}` rewritten every frame from `FrameState.lightGroups.layerToGroup`; bound for EVERY pipeline. `new ForwardPass({ lit: true })` reads `light-buffer` and follows its view; unlit binds a 1×1 white 2d-array placeholder. Camera uniform 80 B |
| `render/passes/fxaa-tonemap-pass.ts` | Full-screen FXAA + tonemap (none/PBR-neutral/ACES), reads `scene-hdr` → `swapchain` |
| `render/passes/selection-seed-pass.ts` | Renders selected entities as JFA seeds |
| `render/light-groups.ts` | `deriveLightGroups(input)` — PURE: light layers → groups (layers with the same lights and, where a shadowed light arrives, the same casters) and SDF sets (groups with the same casters), from the distinct mask VALUES of lights/occluders in view and the layers of the receivers in view (one conservative sphere-frustum test for all three: every entity the GPU draws is kept). A receiver counts only if its primitive samples the light buffer (`LIT_PRIMITIVE_TYPES` = quad, gradient; a test checks it against the shaders declaring `@group(2)`); transparent casters and lights count like opaque ones, because the stages draw both blend modes. Unity's layer batching minus its consecutive-layers rule. Also `layerToGroup` (16 × 4 bits), `multiBitReceiver`, `receiverLayer()`. A shadowed layer with no caster gets no set |
| `render/passes/light-groups-pass.ts` | `LightGroupsPass` — the lit backend's ONE graph node, writes `light-buffer` (rgba16float 2d-array, one layer per group; it grows with the group count and is recreated at the current count only on a resize). Set-major: per SDF set, seed → flood → accumulate its groups; then the groups without a set against a 1×1 "no occluder" SDF. One seed + one ping-pong pair for every set (constant SDF memory, no cap on sets); chain length from the size every frame (no rebuild on resize or on a group-count change). Stages `seed`/`sdf`/`accum` for the profiler |
| `render/passes/occluder-seed-stage.ts` | `OccluderSeedStage` — seeds the occluders of ONE set: each primitive's own module through `fs_occluder` (`OCCLUDER_PASS = 1`), one 256-byte camera slice per set carrying `occluderLayers`. Opaque AND transparent buckets (`.transparent()` is a blend flag; a transparent caster still casts its alpha ≥ 0.5 coverage). `halfResolution()` |
| `render/primitive-bindings.ts` | The bind group layouts every primitive shader shares (group 0 columns, group 1 texture tiers), and `TextureTierBinding`, the group-1 bind group that rebinds when a tier's view changes. Used by `ForwardPass` and `OccluderSeedStage`. Group-0 binding 0 (camera) has `minBindingSize: 80` |
| `render/passes/light-accum-stage.ts` | `LightAccumStage` — accumulates ONE light group into one light-buffer layer: indirect-args slots 12-13 and 26-27 (`LIGHT2D_ARG_SLOTS`: a light marked `.transparent()` lands in the transparent buckets and still lights), `SCENE_HDR_FORMAT`, additive, cleared to `FrameState.ambient`; one 256-byte `LightUniform` slice per group with `groupLayers` (the vertex stage drops lights whose mask misses the group). A point or spot light is a quad of its range, a global or directional light covers the screen. `light-accum.wgsl` applies (1 − d/range)^falloff and the spot cone, and when `shadowIntensity > 0` it sphere-marches the signed SDF with Quilez's original h/t term (not Aaltonen) against the light's angle `min(1/k, sourceRadius / D)`, `sourceRadius = LIGHT_SOURCE_FRACTION × range`; a pixel inside an occluder leaves it first, and penumbra distances run from that exit; a march out of steps extrapolates its last clearance to the light. Not yet: the `sprite` light type, the `mix` blend mode, shadows from global/directional lights |
| `render/passes/sdf-chain-stage.ts` | `SdfChainStage` — floods a seed into the SIGNED SDF over a given ping-pong pair: (nearest-opposite u, v, valid, inside), Godot's single-chain trick, 1+JFA (a step-1 `LOAD_PASS` first). Power-of-two steps (`steps(maxDim)`, reach 2^m − 1); length and param slices from the target size each frame; returns the view holding the result. On GPU it matched an exact distance transform to within 0.1 texel on 100% of texels, sign always right |
| `render/passes/jfa-pass.ts` | `JfaIterationPass` (base: pipeline, params, ping-pong naming) + `JFAPass`, the outline chain: single JFA iteration, ping-pong textures, `iterationsForDimension()` helper. The lighting SDF is `SdfChainStage`, not a graph chain |
| `render/passes/outline-composite-pass.ts` | SDF distance outline from JFA + scene, built-in FXAA |
| `render/passes/bloom-pass.ts` | Dual Kawase bloom (6-step chain), mutually exclusive with outlines |
| `render/passes/prefix-sum-reference.ts` | `exclusiveScanCPU()` — CPU reference of Blelloch exclusive scan. `exclusiveScanSubgroupSimCPU()` — subgroup-simulated 3-phase scan reference |
| `render/passes/radix-sort-pass.ts` | GPU radix sort pass for transparent entities. CPU references: `floatToSortKey()`, `makeTransparentSortKey()`, `cpuRadixSort()`. Ping-pong buffer pairs, 4-pass 8-bit radix |
| `render/passes/scatter-pass.ts` | GPU scatter compute pass: writes dirty staging data to SoA buffers, grow-only buffers, 2-bind-group layout |
| `render/passes/debug-line-pass.ts` | `LineBatchPass` (shared line-list pipeline, camera uniform, loadOp:'load' overlay) + `DebugLinePass` (physics wireframes, auto-feeds from `FrameState.physicsDebugLines`) |
| `particle-types.ts` | `ParticleHandle`, `ParticleEmitterConfig`, `DEFAULT_PARTICLE_CONFIG`, `PARTICLE_STRIDE_BYTES=48` |
| `particle-system.ts` | GPU particle system: per-emitter buffers, compute simulate+spawn, instanced point-sprite render, entity tracking, spawn accumulator, `forgetEntity(id)` (the facade calls it when an id is freed) |
| `ktx2-parser.ts` | Custom KTX2 container parser: magic validation, header/level reading, `isKTX2()` detection, `VK_FORMAT` constants |
| `basis-transcoder.ts` | Singleton Basis Universal WASM transcoder wrapper, lazy-loaded, `transcode()` with BC7/ASTC/RGBA8 targets |
| `ktx2-stream-loader.ts` | HTTP Range-based progressive KTX2 loader: 3-phase fetch (header→SGD→mip levels), `isRangeSupported()` detection |
| `texture-streaming.ts` | `StreamingScheduler` — bandwidth-budgeted progressive texture loading. State machine: pending→header-fetched→sgd-loaded→partial-mips→complete |

#### Input & Picking

| Module | Role |
|---|---|
| `input-manager.ts` | Keyboard/pointer/scroll state + callbacks (`onKey`/`onClick`/`onPointerMove`/`onScroll`), DOM lifecycle |
| `hit-tester.ts` | `hitTestRay()` — CPU ray-sphere intersection, returns closest entityId or null. Optional `SpatialGrid` parameter for O(1) broadphase. Optional `renderMeta`: Light2D entities are never hit (their sphere is their range; a global light's covers the world) — `engine.picking` passes it |
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

#### Physics API

| Module | Role |
|---|---|
| `physics-api.ts` | `PhysicsAPI` — collision/contact-force event dispatch with two-phase drain (copy WASM data before firing callbacks), sensor sugar (`onSensorEnter`/`onSensorExit`), scene queries (`raycast`/`queryAABB`/`queryCircle`). `JointHandle` branded type + 6 joint convenience methods (`setMotor`/`setLimits`/`setSpringParams`/`setAnchorA`/`setAnchorB`/`removeJoint`). `CharacterControllerConfig` type + `isGrounded(entityId)`/`isSlidingDownSlope(entityId)` state query methods. `drainCollisionEvents()`/`drainContactForceEvents()` standalone helpers. `_forgetEntity(id)` drops the sensor callbacks of an id released for reuse |

#### Lighting API

| Module | Role |
|---|---|
| `lighting-api.ts` | `LightingAPI` — engine-wide lighting state only; individual lights are ECS entities via `engine.spawn().light({...})`. `setBackend()`/`backend` (`'off'`/`'lit'`/`'gi'`) and `setAmbient()`/`ambient` travel through the ring buffer as `entity_id = 0` engine-level commands, so the getters read WASM back rather than keeping a TS copy (a `ReplayPlayer` run drives them from the tape). `setQuality()`/`quality` + `LightingQuality`/`DEFAULT_LIGHTING_QUALITY` are renderer-side only and emit no command; `_needsRebuild`/`_clearRebuildFlag()` are the renderer's handshake (in Mode A the facade forwards the quality through `EngineBridge.setLightingQuality`). `groups` — the light groups/SDF sets of the latest frame (`deriveLightGroups` on `latestRenderState` + the main-thread camera), the debug readout for what splits them. Safe no-ops before `_init()`, like `AudioManager` |

#### Plugins

| Module | Role |
|---|---|
| `plugin.ts` | `HyperionPlugin` interface + `PluginRegistry` — dependency resolution, error boundaries |
| `plugin-context.ts` | `PluginContext` with 5 sub-APIs: systems, events, rendering (nullable), gpu (nullable), storage |
| `event-bus.ts` | Typed pub/sub (`on`/`off`/`once`/`emit`/`destroy`), shared between PluginContexts. The facade emits `entity:released` (data: the id) when a freed id leaves quarantine: plugins keying state by entity id drop it there |
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
| `demo/section-switcher.ts` | `SectionSwitcher` — tab switches run one at a time and only the latest requested, so a teardown never overtakes the async `setup()` it undoes (which used to leave hooks on destroyed handles) |
| `demo/report.ts` | `ReportBuilder` — collects section reports, builds JSON, downloads file |
| `demo/primitives.ts` | Quads, gradients, box shadows, lines, beziers, MSDF text (6 checks) |
| `demo/scene-graph.ts` | Parent/child, velocity, rotation, scale, nested transforms (5 checks) |
| `demo/input.ts` | Keyboard, click, pointer, scroll, hit-test, selection (6 checks) |
| `demo/audio.ts` | Load, play, spatial, suspend/resume (4 checks) |
| `demo/particles.ts` | Create, multiple, destroy, entity tracking (4 checks) |
| `demo/rendering-fx.ts` | Bloom, outlines, tonemap, resize (4 checks) |
| `demo/debug-tools.ts` | Profiler, bounds, inspector, debug-cam, time-travel (5 checks) |
| `demo/lifecycle.ts` | Spawn/destroy, batch, compact, immediate, data, prefabs (6 checks) |
| `demo/lighting.ts` | Frames the scene for any canvas aspect (zoom ≤ 1). Backend `lit`: moving point + sweeping layer-0 spot with shadows, off-screen global light, walls, lit vs unlit gradient, a tall layer-1 sprite lit by a layer-1 blue light through two symmetric pillars, one shadowing layer 0 only and one both layers, so the sprite shows ONE shadow band (measured: the two sides match until the band, then 2.3x darker on the `0b11` pillar's side); shadow slider + lit toggle panel (5 checks, incl. light layers: 2 groups, 2 SDF sets) |

#### Debug (`ts/src/debug/`, dev-tools only)

| Module | Role |
|---|---|
| `debug/debug-camera.ts` | `debugCameraPlugin` — WASD movement + scroll zoom, F1 toggle |
| `debug/tlv-parser.ts` | `parseTLV()` — decodes TLV binary from `engine_debug_get_components()`. 15 component types |
| `debug/ecs-inspector.ts` | `ecsInspectorPlugin` — HTML overlay panel, F12 toggle, dual data channels (SystemViews fast + WASM slow) |
| `debug/bounds-visualizer.ts` | `boundsVisualizerPlugin` — wireframe bounding sphere visualization, F2 toggle. Draws via `LineBatchPass` (Phase 16 closed the 10b draw stub) |
| `debug/physics-debug.ts` | `physicsDebugPlugin` — rapier collider/joint wireframes, F3 toggle, CommandType 47 + `FrameState.physicsDebugLines` |

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
| `basic.wgsl` | Quad render: SoA transforms, visibility indirection, multi-tier Texture2DArray. `shade()` is the colour/coverage shared by `fs_main` and `fs_occluder`. `override OCCLUDER_PASS` drops non-casters in the vertex stage (occluder pipelines only). Packed texture index 0 answers white. Group 2 (light buffer, a 2d-array) read in `fs_main` only, gated on `RECEIVES_LIGHT_BIT` (bit 10), at the layer `lightGroupOf(mask)` gives. `CameraUniform` is 80 B in all six primitive shaders (`occluderLayers` for the seed stage; `castsInto()`) |
| `line.wgsl` | Screen-space quad expansion, SDF dash pattern |
| `gradient.wgsl` | 2-stop gradient (linear/radial/conic). Lit like `basic.wgsl`: group 2 (2d-array + `lightGroupOf`) in `fs_main` only |
| `box-shadow.wgsl` | SDF box shadow (Evan Wallace erf) |
| `bezier.wgsl` | Quadratic Bezier SDF (Inigo Quilez), `fwidth()` anti-aliased stroke |
| `msdf-text.wgsl` | MSDF median(r,g,b) signed distance + screen-pixel-range AA |
| `cull.wgsl` | Compute: sphere-frustum culling, 7 primitive types, 28 DrawIndirectArgs. Array sizes are const-expressions of `NUM_PRIM_TYPES`, not literals |
| `fxaa-tonemap.wgsl` | FXAA (Lottes) + PBR Neutral/ACES tonemap |
| `selection-seed.wgsl` | Selected entity UV-encoded seeds for JFA |
| `jfa.wgsl` | Jump Flood: 9-neighbor sampling at ±step |
| `outline-composite.wgsl` | SDF distance outline + FXAA |
| `bloom.wgsl` | Dual Kawase bloom (5 entry points), tonemap + FXAA |
| `particle-simulate.wgsl` | Compute: PCG hash PRNG, gravity, color/size interpolation (48 B/particle) |
| `particle-render.wgsl` | Instanced point-sprite circles, dead particle clipping |
| `prefix-sum.wgsl` | Blelloch prefix sum (workgroup-level, 512 elements) + `prefix_sum_subgroups` entry point with `subgroupExclusiveAdd` |
| `basic-binding-array.wgsl` | Design artifact: sized binding array texture sampling (not wired into ForwardPass, documents target WGSL structure) |
| `radix-sort.wgsl` | Compute: GPU radix sort for transparent entity ordering. 3 entry points (histogram, prefix_sum, scatter), float_to_sort_key sign-aware conversion, composite sort key |
| `scatter.wgsl` | Compute: dirty entity data scatter from compact staging to SoA buffers, format=0 compressed 2D reconstruct / format=1 direct mat4x4 copy |
| `debug-line.wgsl` | Debug lines: line-list, per-vertex color, camera VP uniform (LineBatchPass/DebugLinePass + bounds visualizer) |
| `sdf-jfa.wgsl` | Signed jump flood (Phase 17): `(nearest-opposite u, v, valid, inside)`, Godot single-chain, `override LOAD_PASS` converts the raw occluder seed in the first (step-1) pass. `textureLoad` only |
| `light-accum.wgsl` | Light accumulation (Phase 17): per-light quad of its range (full screen for global/directional), attenuation + spot cone, sphere-marched soft shadows on the signed SDF (see the shadow-march gotcha), Sub blend as a negative contribution. `LightUniform.groupLayers`: `vs_main` drops a light whose mask misses the group being accumulated |

`vite-env.d.ts` — Type declarations for WGSL `?raw` imports, Vite client, and vendored Basis Universal WASM module.

## Gotchas

### Critical — will cause bugs or errors if ignored

- **Never use `grep -P` in scripts** — hooks and CI run under `sh`, where `/usr/bin/grep` is BSD and rejects `-P`. The interactive shell's `grep` is a ugrep wrapper that *does* support it, so `-P` works when tested by hand and fails silently in the script. Use `grep -oE`. This left six PostToolUse hooks dead.
- **Quote `--include` globs** — the interactive shell is zsh, which expands `--include=*.ts` itself and aborts with `no matches found` *before* grep runs. That reads exactly like a clean empty result. Use `--include="*.ts"`.
- **After a scripted edit to a long doc, check `git diff --numstat`** — a Python rewrite from an anchor silently dropped 142 lines of the Phase 17 design (`714a8cf`, restored in `4be94c1`); an unexpected deletion count is the tell.
- **Every npm/npx command must run from `ts/`** — the repo root has no `package.json`, and the Bash working directory does not reliably survive between calls, so prefix each one (`cd ts && npm test`) — but that form itself breaks when the cwd has *already* moved into `ts/` (`cd:1: no such file or directory: ts`). The cwd-independent form is better: `npm --prefix ts test`, `npx --prefix ts vitest run --root ts src/x.test.ts`. Running `npx tsc --noEmit` from the root does not error out: it installs and runs an unrelated `tsc@2.0.4` that prints "This is not the tsc command you are looking for".
- **Claude Code hooks receive the payload as JSON on stdin**, not in an env var. Parse with `jq -r '.tool_input.file_path'`; resolve the repo root from `$CLAUDE_PROJECT_DIR`. There is no `$CLAUDE_TOOL_INPUT`.
- **`.claude/agents/*.md` require YAML frontmatter (`name`, `description`)** or the agent is silently never registered — it simply does not appear as invokable.
- **`--all-targets` matters for clippy, not for `cargo test`** — `cargo test` already compiles and runs `tests/`. Plain `cargo clippy` lints only the lib target, leaving all test code unlinted. Always pair it: `cargo clippy -p hyperion-core --all-features --all-targets`; `--all-targets` *without* `--all-features` reports a false dead-code warning for `make_position_cmd`.
- **`--all-features` and `--features "physics-debug dev-tools"` are the same build** — `physics-debug` implies `physics-2d`, so cargo emits identical binary hashes. Document one number for both, not two.
- **Per-module test counts need `--lib`** — `cargo test -p hyperion-core engine` runs 7 test binaries and prints 7 result lines; `--lib engine` prints one. And `--all-features` is NOT the same as `--features "physics-2d dev-tools"` per module (engine: 67 vs 62 — `physics-debug` adds 5). Match the exact config CLAUDE.md names before refreshing a number. A configuration's total over all test binaries: `cargo test -p hyperion-core --all-features 2>&1 | grep -oE 'ok. [0-9]+ passed' | awk '{s+=$2} END {print s}'`.
- **hecs 0.11 `query_mut`** returns component tuples directly, NOT `(Entity, components)`. Use `for (pos, vel) in world.query_mut::<(&mut Position, &Velocity)>()`.
- **Rust `u64` → JS `BigInt`** via wasm-bindgen. Wrap with `Number()` on TS side (safe for values < 2^53).
- **`wasm-bindgen` can't export `unsafe fn`** — use `#[allow(clippy::not_unsafe_ptr_arg_deref)]` for functions taking raw pointers.
- **TS `const enum` has no reverse mapping** — `CommandType[value]` fails (TS2476). Log numeric values directly.
- **`@webgpu/types` Float32Array strictness** — `writeBuffer` requires `Float32Array<ArrayBuffer>` cast when the source might be `Float32Array<ArrayBufferLike>`.
- **Indirect draw buffer needs STORAGE | INDIRECT | COPY_DST** — compute shader writes instanceCount (STORAGE), render pass reads it (INDIRECT), CPU resets it each frame (COPY_DST).
- **Multi-pipeline ForwardPass shared bind group layout** — All primitive type shaders MUST declare identical bind group layouts (group 0: camera, transforms, visibleIndices, texIndices, renderMeta, primParams; group 1: tier0-tier3 texture arrays + sampler + ovf0-ovf3 overflow arrays). Unused bindings must still be declared. Group 2 (light buffer) is the exception: the layout has it for every pipeline, but only the lit shaders (basic, gradient) declare it — a layout may hold groups a shader never uses.
- **SoA buffers parallel indexed** — All SoA buffers (transforms, bounds, texIndices, entityIds) must use the same entity index. Populated via retained `write_slot()` in Rust (or legacy `collect_gpu()`). Entity IDs are CPU-only (not uploaded to GPU).
- **PrimitiveParams split across two commands** — `SetPrimParams0` for f32[0..4], `SetPrimParams1` for f32[4..8], due to 16-byte ring buffer payload limit.
- **A light's range lives in `primParams[3]` and nowhere else** — it is both what the accumulation shader reads and what drives `BoundingRadius`. Mirroring it into the radius from the TypeScript producer would hold until someone set range through `raw-api.ts` and forgot the second write, at which point the light culls against a stale radius and pops at the frustum edge. Light2D slots: `[colorR, colorG, colorB, range, innerCos, outerCos, falloff, shadowIntensity]`, colour with energy premultiplied — that premultiplication is what frees slot 7, and it happens at the wire boundary only: the TS API keeps `color` and `energy` apart.
- **ForwardPass group 2 (light buffer) is read in `fs_main` ONLY** — `OccluderSeedStage` runs the same six modules through `fs_occluder` on a TWO-group layout, and WebGPU rejects a pipeline whose entry points statically use a binding its layout lacks. Moving the lookup into `shade()` (which `fs_occluder` calls) makes every lit graph fail GPU validation — the request is rejected and lighting silently stays off. `forward-pass.test.ts` pins it. The other half: `setBindGroup(2, …)` is issued for EVERY ForwardPass pipeline, including the four shaders that never declare group 2, or the draw fails validation.
- **Light layers: one mask field, three roles, grouped automatically** (design `2026-09-26-phase17-light-layer-groups-design.md`) — a light lights the layers in its mask (0: none; global/directional obey it too); a receiver belongs to ONE layer, its lowest bit (0: layer 0), and only quads and gradients receive at all; an occluder shadows the layers in its mask (0: all), and is ABSENT from other layers' SDF (no false penumbra). `deriveLightGroups` forms the groups every frame from the mask VALUES in view, like Unity's layer batches; the default scene (lights 0xFFFF, drawables 0) is 1 group, 1 set — pixel-identical to before. **There is no cap on SDF sets: each distinct caster set costs a full flood (+1.84 ms at 1080p on the AMD iGPU)**; read `engine.lighting.groups` to see which masks split them. A group sharing a set costs its clear + its lights redrawn (+0.34 ms measured). Never sum several layers for one receiver: it samples exactly one.
- **Light-buffer layers are rendered through `2d` views of a `2d-array` texture** — created with `textureBindingViewDimension: '2d-array'` (sampled as one array in ForwardPass), rendered one layer at a time via `createView({dimension: '2d', baseArrayLayer: g, arrayLayerCount: 1})`. SDF textures stay SEPARATE textures (compatibility mode cannot sample a single-layer view of a multi-layer array). Per-set/per-group uniforms are 256-byte slices written ONCE per frame (the BloomPass writeBuffer gotcha).
- **`CameraUniform` is 80 bytes in all six primitive shaders** — `viewProjection` + `occluderLayers` + pads. ForwardPass writes 0, OccluderSeedStage the set's layers. Group-0 binding 0 declares `minBindingSize: 80`, so a 64-byte buffer fails at bind-group creation instead of at draw time. Changing the struct means all six shaders, both passes and the layout together.
- **A graph pass can time its own stages — `profileStages(frame)` + the `mark` argument** — the profiler brackets each graph pass with timestamp markers, which cannot see inside one node. `LightGroupsPass` lists its stages for this frame (`seed`/`sdf`/`accum` per set, one more `accum` for set-less groups) and calls `mark(encoder)` before each. The graph reports them as `light-groups/seed` etc., summed when the name repeats. The list must match the `mark` calls one for one: `GpuProfiler.endFrame` drops a frame whose marker count differs, so a mismatch shows up as no timings at all. The profiler holds 256 markers.
- **The lit graph follows the engine backend on CHANGE, not on value** — `followLightingBackend` in `render/lighting-backend.ts`. The GPU can reject a lit graph (the renderer then falls back to unlit) while `GPURenderState.lightingBackend` keeps saying 1; following the value would re-request, and be rejected again, every frame or two. To retry, set the backend `'off'` then `'lit'` again.
- **The SDF chain must reach the whole texture, or far shadows vanish** — an unreached texel stays `valid = 0`, which `light-accum.wgsl` reads as "no occluder within 1e6". Steps fixed at composition (`floor(maxDim / 2^i)`) broke after ANY growth (review 2026-09-26). `SdfChainStage` now uses power-of-two steps and takes its length from the target size EVERY FRAME, inside `LightGroupsPass`: a resize never needs a new graph. The OUTLINE chain still takes its steps at composition; there only pixels near a selected entity matter.
- **Shadow march: three rules that each fixed a visible defect (2026-09-26)** — (1) the light's apparent angle is `min(1/k, sourceRadius / D)`: Quilez's k alone is a light whose radius grows with the pixel's distance, and a light beside a wall darkened the open side 23-42% in radial bands. (2) A pixel inside an occluder leaves it (steps of |h|, a lower bound on the exit) and then marches, with penumbra distances measured from the exit: returning "lit" there left every caster-and-receiver sprite fully lit inside a wall's shadow. (3) A march out of steps assumes its last clearance holds to the light, never "lit". Rays grazing a face spend the budget 1-2 texels at a time: `shadowSteps` defaults to 48, which removed every leaking pixel of the repro for +2% light-accum time; 24 leaked.
- **Global and directional lights have `BoundingRadius = f32::MAX`** — the only way through the sphere-frustum test wherever their transform is (`light-accum.wgsl` draws them full-screen). Finite on purpose: `state_hash` and the snapshot see no infinity. Consequence for any CPU consumer of `bounds`: never iterate over a radius. `SpatialGrid.rebuild` inserts an entity into every cell its sphere covers and would effectively never return — it is not in the live path (`engine.picking` calls `hitTestRay` without a grid), and `hitTestRay` skips Light2D when given `renderMeta`.
- **`rotation(angle)` is a rotation about Z on ANY entity, and it replaces the whole rotation** — the one-argument form sends `SetRotation2D`. On a `Transform2D` entity it sets `rot`; on a 3D entity (everything `engine.spawn()` makes) it sets `Rotation = Quat::from_rotation_z(angle)`, dropping any X/Y tilt. Until 2026-09-26 it was IGNORED on 3D entities, so on every entity the public API could create: the Lighting demo's spot pointed along +X for that reason. Old command tapes that sent it to 3D entities now replay a rotation. Physics bodies: see the next bullet.
- **An out-of-range render primitive is rejected** — `SetRenderPrimitive` past `PRIM_TYPE_LIGHT2D` (6) keeps the old type and counts in `engine_rejected_command_count`. `cull.wgsl` clamps the type to the last one, so a 7 used to render as an invisible Light2D; `deriveLightGroups` applies the same clamp to whatever still reaches it.
- **`SetParent` uses `0xFFFFFFFF` for unparent** — Special value meaning "remove parent". Same command type for parenting and unparenting.
- **Multi-tier textures require switch in WGSL** — WGSL cannot dynamically index texture bindings. Adding new tiers requires updating the shader `switch`.
- **AudioContext requires user gesture** — Browsers block creation/resumption without user gesture. `AudioManager` lazily creates context on first `load()` or `play()`.
- **Bloom and outlines are mutually exclusive** — each is the graph's single final composite onto `swapchain` and replaces `FXAATonemapPass`, which `composeRenderGraph` then does not register. `enableBloom()` disables outlines and vice versa. Console warning issued.
- **`scene-hdr` is `rgba16float`, and its format lives in `render/formats.ts`** — it used to be `getPreferredCanvasFormat()`, which clamped the whole scene to [0,1] and left bloom's threshold and the ACES/PBR tonemap with nothing to do. `SCENE_HDR_FORMAT` is consumed by BOTH `ForwardPass`'s 12 pipelines and the `scene-hdr` texture in `renderer.ts`, and by BOTH the bloom mip pipelines and the bloom mip textures. Change it in one place only and you get a pipeline/attachment format mismatch — a hard validation error at draw time that **no test can catch**, since WebGPU cannot run headless. Same pairing for `JFA_FORMAT` across `SelectionSeedPass`, `JFAPass` and the `jfa-a`/`jfa-b` textures. Anything targeting the **swapchain** (bloom composite, `FXAATonemapPass`, `OutlineCompositePass`, `LineBatchPass`, particles) must keep using `getPreferredCanvasFormat()`.
- **FXAA runs on display-space values, after tonemapping — do not "simplify" it back** — Lottes' contrast test `lumaRange < max(0.0312, lumaMax * 0.125)` has an absolute floor tuned for [0,1]. With `scene-hdr` unbounded, running it on raw HDR is hypersensitive in bright regions and blind in dark ones. Both `fxaa-tonemap.wgsl` and `bloom.wgsl` therefore tonemap **every tap** at the point of sampling (`resolveTexel()` / `resolveComposite()`) and return the result with no second tonemap. Cost: up to 9 tonemaps per pixel; in the bloom composite also 2 samples per tap, because bloom must be added before the edges are detected.
- **`timestamp-query` on a stock Chrome is platform-dependent** — on Linux/Vulkan (Chrome 154, RTX 4060, 2026-09-26) it returns real values in ~1.024 µs steps with no extra flag. On macOS/Metal it resolves to all zeroes, verified 2026-08-04: the adapter advertises the feature, `requestDevice` accepts it, `resolveQuerySet` raises no validation error, and every value reads back as exactly 0 (including with `endOfPassWriteIndex`). So `GpuProfiler` correctly reports nothing at all. Launch Chrome with `--enable-webgpu-developer-features` for real numbers; `GpuProfiler.discardedFrames` distinguishes this from a warm-up and warns once after 120 such frames.
- **Optional GPU features must be re-checked on the `device`, never the `adapter`** — `createRenderer` catches a failed `requestDevice` and retries with a reduced feature set, so an adapter that advertises a feature can still yield a device without it. `GpuProfiler.isSupported(device.features)` exists for exactly this; reading `adapter.features` instead builds a profiler on a device that cannot serve one and takes down the whole renderer, not just profiling.
- **Check the adapter line in the console before trusting a GPU session** — `createRenderer` logs `describeAdapter(adapter.info)` (vendor / architecture, subgroup sizes) and WARNS on a software fallback. On this Linux machine Chrome with only `--enable-unsafe-webgpu` hands out SwiftShader, which renders fine but has the wrong timings and features; hardware WebGPU needs `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan`. On this Fedora box the NVIDIA adapter cannot present to a canvas (the compositor runs on the AMD iGPU): for visual checks navigate with the initScript `GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)`. It does not reach workers, so Mode A cannot be checked visually here.
- **WebGPU can't be tested in headless browsers** — `requestAdapter()` returns null. Visual testing requires a real browser (`npm run dev` → Chrome).
- **WGSL *can* be validated without anything rendering** — `npm run dev`, then one chrome-devtools `evaluate_script`: `const code = (await import('/src/shaders/x.wgsl?raw')).default` → `await device.createShaderModule({code}).getCompilationInfo()` returns compile errors with line numbers. Wrap `createRenderPipeline` in `device.pushErrorScope('validation')` / `await device.popErrorScope()` to catch pipeline-vs-attachment format mismatches — the failure class the test suite structurally cannot see. Both work even when the canvas draws nothing. Three details that each cost a round-trip: an adapter is **consumed** by `requestDevice()`, so call `requestAdapter()` once per device; `cull.wgsl` must go through `prepareShaderSource()` first (the raw source does not compile); and its entry point is `cull_main`, not `main`.
- **Driving the harness from chrome-devtools** — `window.__hyperion` (dev builds) is the live facade; switch sections by clicking `document.querySelectorAll('.tab')`; each tab's result is its `N/M passed` text. Input stays at 2/6 (4 checks wait for real keyboard/pointer/scroll) and `favicon.ico` 404 is the only expected console error.
- **Pixel checks from `take_screenshot`** — screenshot px = CSS px × `devicePixelRatio` (1.25 here); map world → CSS with `engine.cam.viewProjection` and the canvas `getBoundingClientRect()`. With animated lights, compare symmetric points within ONE screenshot, not across two.
- **The harness loads `ts/wasm` (`build:wasm`, no `physics-2d`)** — rebuild it after any Rust change before a GPU check; physics behaviour is covered only by the Rust tests (`verify_physics.rs`).
- **A destroyed `EntityHandle` is dead for good** — `destroy()` calls the release callback `Hyperion.spawn` hands it (unregister from the LeakDetector, `entityCount--`), once. Handles are never recycled: `EntityHandlePool` and `init()` were removed on 2026-09-27, so a stale reference can never alias a newer entity, and `.data()` lives as long as the handle. The id itself IS reused later, under quarantine (the "Freed entity ids are reused under quarantine" bullet): a dead handle's `.id` stays readable, but that number may address another entity afterwards. Until then `destroy()` released nothing: `entityCount` only grew, so `spawn()` threw "Entity limit reached" after `maxEntities` CUMULATIVE spawns, and every collected handle raised a false leak warning — hidden because the tests called `returnHandle()` by hand. `RawAPI` spawns are not counted.
- **A primitive casts shadows only if its shader exposes `fs_occluder` AND declares `override OCCLUDER_PASS`** — `OccluderSeedStage` builds an occluder pipeline for every `SHADER_SOURCES` entry containing `fn fs_occluder` and sets `OCCLUDER_PASS = 1`. A module with the entry but without the override fails pipeline creation, since setting an unknown constant is a validation error. The pattern, as in `basic.wgsl`: move the fragment body into a shared coverage function; `fs_main` returns it; `fs_occluder` discards below alpha 0.5 and returns `vec4f(screenUV, 1, 1)`; `vs_main` emits a degenerate triangle when `OCCLUDER_PASS` is set and `castsInto(meta1, camera.occluderLayers)` is false (bit 9 clear, or a mask that misses the set). The bit is `CASTS_SHADOW_BIT` in WGSL and `RENDER_META_CASTS_SHADOW_BIT` in Rust, and a test compares the two.
- **Adding a new primitive type requires 3 steps** — (1) add WGSL shader, (2) register in `ForwardPass.SHADER_SOURCES[RenderPrimitiveType]`, (3) optionally extend `EntityHandle`. Types: 0=Quad, 1=Line, 2=SDFGlyph, 3=BezierPath, 4=Gradient, 5=BoxShadow, 6=Light2D. Type 6 is the one exception to step (2): no shader is registered for it, so `ForwardPass` never draws it and `LightAccumStage` reads its bucket directly.
- **`createImageBitmap` not available in Workers on all browsers** — Safari has partial support. `TextureManager` should only be instantiated where available.
- **Bezier control points in PrimParams are UV-space** — [0,1] range relative to entity's bounding quad. Entity position+scale define world-space bounding box.
- **GPU particles are NOT ECS entities** — Particles live in GPU storage buffers, rendered outside the RenderGraph. Avoids ring buffer saturation.
- **KTX2 files must have block-aligned dimensions** — BC7/ASTC 4x4 require width/height divisible by 4. Tier sizes (64-512) satisfy this.
- **Basis Universal WASM loaded lazily** — Only fetched on first KTX2 texture with BasisLZ/UASTC supercompression. Pre-compressed KTX2 (scheme=0) bypasses the transcoder entirely.
- **`KTX2File.close()` AND `.delete()` both required** — Missing `.delete()` leaks WASM heap memory.
- **Compressed texture tier growth needs standard WebGPU** — `copyTextureToTexture` for compressed formats is disallowed in compatibility mode. Falls back to rgba8unorm.
- **`createRingBuffer()` is unusable in vitest** — it reads `crossOriginIsolated`, which the node test environment does not define (`ReferenceError`, not a falsy check). Tests build the buffer directly: `new SharedArrayBuffer(32 + capacity)`.
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
- **Cull shader subgroup code is textually STRIPPED, not merely gated** — `override USE_SUBGROUPS` decides which branch *runs*, but WGSL validates every builtin call in the module regardless of any override value, so `subgroupAdd` left in the text is a hard compile error on a device without the feature — not dead code. From Phase 14a until `f64b02f` this took down the whole renderer on **all Firefox and all Safari**, and silently: `createRenderer` catches the failure and yields a null renderer, so the symptom was a blank canvas with no message. `prepareShaderSource()` now deletes the `BEGIN/END-SUBGROUPS-ONLY` region when the feature is absent, and prepends `enable subgroups;` when it is present (the directive is NOT in the file — adding it unconditionally fails validation the other way round). Those markers are load-bearing. WGSL has no preprocessor and `override` covers only scalars, so textual stripping is the only tool.
- **Subgroup `requestDevice` requires `'subgroups'` in `requiredFeatures`** — Detection via `detectSubgroupSupport()` checks `adapter.features`, but the feature must also be requested at device creation. Use retry-without fallback if request fails.
- **The cull subgroup path is correct ONLY at exactly 32 lanes — `subgroupCullSupported(adapter.info)` gates it** — `cull.wgsl` derives the subgroup index as `lid / SUBGROUP_SIZE` with SUBGROUP_SIZE = 32. With any other width the per-bucket COUNTS stay right, while the visible indices land in the wrong slots: duplicates and holes, with no error. On the AMD RDNA 3 iGPU here (`subgroups 32-64`) this showed as one line out of 10 and no bezier; the atomic path draws all of them. The path first ran after `6331b5c`: until then the cull pipeline was invalid. A GPU check that compares only per-bucket counts CANNOT see this. Compare the set of written indices. Properly supporting other widths means wiring `USE_SUBGROUP_ID` (declared, never read) and sizing `MAX_SUBGROUPS` for the narrowest width.
- **`subgroupBroadcastFirst` always broadcasts from thread 0** — In compute shaders, ALL invocations are active. `subgroupBroadcastFirst(x)` returns thread 0's value, NOT the first thread where `x != 0`. Use `subgroupElect()` to gate the writer so thread 0 is always the one with the result.
- **SpatialGrid `cellEntities` may realloc on oversized entities** — Default 4x buffer covers typical cases. Entities with radius >> cellSize can span O((r/cellSize)^2) cells, exceeding the buffer. The grid auto-reallocs but this breaks zero-alloc-per-frame for that one frame.
- **`flush_pending_despawns()` must be called before `collect_dirty_staging()`** — Despawns create stale slot references. The descending slot order in batch despawn is a correctness invariant (guarantees `last` is always live).
- **A compute pipeline gets at most 8 storage buffers, and an UNREAD binding still counts** — `maxStorageBuffersPerShaderStage` is 8 by default and `requestDevice` asks for no more. The limit is counted on the bind group layout entries, not on what the shader reads. Going over it does not throw: the pipeline comes back invalid. `cull.wgsl` sat at 9 from `4ea6cb5` until 2026-09-26, and one of the 9 was a `transforms` binding it never read. In that time no cull pipeline ran, and after `b4db737` every graph rebuild (bloom, outlines, hot-reload) was rejected by GPU validation. `cull-pass.test.ts` "storage-buffer budget" checks the WGSL text and the layouts `setup()` hands the device. Do not raise `requiredLimits` to make room: the failure would move to devices at the spec minimum, which a development machine offering 16 never exercises.
- **Scatter shader @group(1) must match CullPass read layout** — ScatterPass writes to the same SoA buffers CullPass reads. Both must agree on buffer names in ResourcePool.
- **Compressed transforms use format flag at staging[31]** — `0` = compressed 2D (pos+rot+scale, root entities), `1` = pre-computed mat4x4 (child entities). Scatter shader reconstructs mat4x4 from 6 f32 for format=0.
- **`process_commands` takes `&mut RenderState` as 4th parameter** — All callers (engine.rs, tests) must provide it. Dirty marking happens at command level, not system level.
- **`collect_gpu()` destroys retained slot mapping** — Never call `collect_gpu()` in the retained-slot path. It rebuilds SoA in hecs iteration order (arbitrary), overwriting `write_slot()` slot assignments. The update flow is: `mark_post_system_dirty()` → `collect()` → `collect_and_cache_dirty()`. `collect_gpu()` is legacy-only.
- **Systems bypass command_processor dirty marking** — `velocity_system`, `transform_system`, and `propagate_transforms` modify components directly. Call `mark_post_system_dirty()` after systems run to mark velocity-driven entities and children of dirty parents.
- **SoA length accessors use `gpu_count * stride`, not `vec.len()`** — Retained-slot Vecs grow via `assign_slot()` but never shrink (except `shrink_to_fit()`). `vec.len()` may include stale trailing data. All 7 WASM exports (`gpu_transforms_f32_len`, `gpu_depths_f32_len`, etc.) use `gpu_count * stride`.
- **Transform2D entities have no `Position` component** — Queries on `&Position` skip 2D entities. Use `Transform2D.x/y` for position data. `collect_gpu()` (legacy) only queries `&Position` — 2D entities invisible in legacy path.
- **SpawnEntity payload is 1 byte (2D flag)** — `payload[0]`: 1=2D (Transform2D archetype), 0=3D (Position+Rotation+Scale). The `is_2d` flag routes all subsequent commands to the correct component type.
- **Indirect args are 28 entries (560 bytes)** — 7 prim types × 2 material buckets (tier0 vs other) × 2 blend modes. Opaque = entries 0-13, transparent = entries 14-27. `firstInstance` encodes the visible-indices region offset — non-zero for every bucket but 0, which is only legal with the **`indirect-first-instance` feature**. Without it the spec makes each such draw a silent no-op (no validation error, no error-scope hit): until 2026-09-26 the device never requested it, so in Chrome and Firefox only opaque tier-0 quads could ever draw. `selectDeviceFeatures` requests it, `retryDeviceFeatures` keeps it on the fallback, and `indirectFirstInstanceWarning` warns when the DEVICE lacks it. Safari does not enforce the rule, so a Safari check hides the bug. Authoritative source is `NUM_PRIM_TYPES` in `cull.wgsl`: since Phase 17 the array sizes are const-expressions derived from it (`array<DrawIndirectArgs, TOTAL_BUCKETS>`), so it is ONE number to change rather than four literals — and `cull-pass.test.ts` asserts the WGSL text and the TS constant agree, which is the only check available without a browser. Light2D claims 4 buckets and a plain light fills one, 12 (13 with a tier > 0 texture, 26/27 when marked `.transparent()`; `LightAccumStage` draws all four): uniform waste beats a per-type bucket count, which would break the flat indexing and branch the hot loop.
- **`MAX_COMMAND_TYPE` must be updated when adding commands** — Now defined in BOTH `ring_buffer.rs` (`pub const MAX_COMMAND_TYPE: u8 = 53`) and `backpressure.ts` (53), and a Rust test asserts it is exactly one past the last discriminant.
- **Depth SoA column not in scatter staging buffer** — The 32 u32/entity staging format has no room for depth. Depth is updated via `write_slot`/`write_slot_2d` only, not the GPU scatter path.
- **Culling is stateless: every frame tests every sphere against the frustum** — temporal culling (visible last frame + not dirty ⇒ skip the test) was removed on 2026-09-26. Measured on an RTX 4060 at equal visibility, skipping every bounds read saved 0 µs at 100k and at 1M entities: the kernel runs at 76-95 of 256 GB/s, so it is not bandwidth-bound. It also cost ~19 µs of CPU per frame at 100k. Its rule was wrong as well: camera motion never invalidated it, and dirty bits reached the GPU only in Mode C. Do not reintroduce frame-to-frame visibility state without measuring a benefit first, on the target GPU. The full analysis is in `docs/plans/2026-09-26-cull-temporal-firstinstance-brief.md`.
- **`__DEV__` is a Vite compile-time constant** — `true` in dev/test, `false` in production builds. Use `typeof __DEV__ !== 'undefined'` guard when checking outside Vite context.
- **`prefix_sum_subgroups` entry point requires `enable subgroups;`** — The directive is NOT in `prefix-sum.wgsl`. Must be prepended at pipeline creation time (same pattern as `cull.wgsl`). Without it, WGSL validation fails on non-subgroup devices.
- **Cull shader shared-memory arrays sized for MAX_SUBGROUPS=8** — `sg_counts` / `sg_prefixes` are `TOTAL_BUCKETS * MAX_SUBGROUPS` = 224 u32 (28 buckets × 8 subgroups), `wg_bases` is 28. ~1.9 KB, well inside the 16 KiB limit. They derive from the constants, so a `NUM_PRIM_TYPES` change carries them along; only a hardware change to >8 subgroups per workgroup at size 256 needs a manual edit.
- **`detectSizedBindingArrays` uses try/catch on `createBindGroupLayout`** — The W3C proposal (`bindingArraySize`) isn't finalized. The probe creates throwaway layouts. Safe on current Chrome/Firefox (throws cleanly). Cast to `any` bypasses TypeScript strict typing.
- **`basic-binding-array.wgsl` is a design artifact only** — NOT imported anywhere. Not in `renderer.ts` SHADER_SOURCES. Exists to document target WGSL structure for when browsers ship `bindingArraySize`.
- **`loro-spike` crate is NOT part of the main build** — In workspace but not a dependency of `hyperion-core`. The WASM output (`ts/loro-spike-wasm/`) is gitignored. The crate exists solely for binary size measurement.
- **`rapier-spike` crate is NOT part of the main build** — Like `loro-spike`, exists solely for API validation and binary size measurement. The WASM output (`ts/rapier-spike-wasm/`) is gitignored. Rapier2D production dependency is in `hyperion-core` behind `physics-2d` feature flag.
- **`rapier2d` has NO `wasm-bindgen` feature** — The spike proved this feature does not exist in rapier2d 0.32. Only use `features = ["simd-stable"]`. The design doc incorrectly specifies `wasm-bindgen`.
- **Physics CommandTypes are 17-47 plus 48-52 (audit 2026-07)** — `SetColliderEvents`(48), `TeleportBody`(49), `SetBoundingRadius`(50), `DestroyCharacterController`(51), `SetCharacterUp`(52).
- **Collision events are OPT-IN** — colliders are built with `ActiveEvents::empty()`. Nothing fires until `SetColliderEvents` (48) is sent for that entity. `EntityHandle.collider({ sensor: true })` opts in automatically.
- **`SetPosition` on a physics body teleports it** — for an entity with `PhysicsControlled`, `SetPosition`, `SetRotation2D` and `SetRotation` enqueue a Rapier reposition (momentum preserved). A rotation takes its angle from the COMMAND (`SetRotation`: its Z angle, `Rotation::z_angle`), since a 3D pose carries none; a non-finite one queues nothing. Repositions of one body are MERGED until the next tick, in call order, `TeleportBody` included (it used to be applied in a second pass, after everything else): the last call wins field by field, `teleport(t).position(p)` ends at `p` with the teleport's zeroed velocity, `rotation(a).position(p)` keeps the angle. A body is BUILT at the entity's rotation too, so a rotation sent in the creation batch (a tilted ramp) lands. `verify_physics.rs` P18-P18h, P19-P19d. `TeleportBody` (49) additionally clears velocity and forces.
- **`SetVelocity` does NOT move a physics body** — `velocity_system_filtered` skips `PhysicsControlled` entities, so `SetVelocity` only writes the ECS `Velocity` component and never reaches Rapier (there is no handler for it in `physics_commands.rs`). Drive physics bodies with gravity, `ApplyForce`/`ApplyImpulse`, or `TeleportBody`. A test or demo built on `SetVelocity` leaves the bodies stationary and passes while exercising nothing.
- **`engine_push_commands(&[u8])` is the live command path — `engine_attach_ring_buffer` has zero call sites** — TS keeps the SAB on the JS side and pushes unread bytes (`extractUnread` → `engine_push_commands`); it never hands WASM a pointer. Use `engine_push_commands` for any harness. `engine_memory()` returns the `WebAssembly.Memory` (wasm-bindgen `--target web` does not export `memory`), needed to read the SoA pointers.
- **Physics bit-exactness holds PER TARGET, not across targets** — the same scenario settles at y=2992.6257 on wasm32 and y=2992.6294 on native aarch64. Compare wasm-vs-wasm when validating an upgrade, and never pin a `state_hash` as a golden value in a test — assert behavioural invariants instead (see `tests/verify_determinism.rs`).
- **`HyperionPhysicsWorld::raycast()` returns `i32`, not `Option`** — the external entity id, or `-1` for "no hit" (also returned for a degenerate zero-length direction, which is rejected before reaching rapier).
- **Character controller `up` follows gravity** — derived as `-normalize(gravity)`, falling back to +Y for zero gravity. Override per entity with `SetCharacterUp` (52). The engine's documented default gravity is (0, +980), i.e. +Y is DOWN.
- **`BoundingRadius` is recomputed every frame** from the world matrix by `systems::update_bounding_radii` — except for `Light2D`, whose radius comes from `PrimitiveParams[3]` (range) and deliberately ignores transform scale, because a light's extent IS its range. That is a *second* query inside the same function, and it must run AFTER the matrix-derived one: every entity gets a `ModelMatrix` at spawn, so the first query matches lights too and would otherwise win. The ordering is a correctness invariant with a test on it (`light_radius_ignores_transform_scale`). Pin any radius with `SetBoundingRadius` (50), which attaches `BoundsOverride` and wins over both queries; a negative value releases it.
- **Staging format is chosen by representability** — format 0 (compressed) only for ROOT `Transform2D` entities; everything else, 2D children included, uses format 1 (full mat4). A 2D child's `Transform2D` is local to its parent, so format 0 would draw it at the wrong place. Both emit 16 words, so there is no bandwidth difference.
- **GPU rows are world-space: every parented entity takes its transform AND its culling-sphere centre from `ModelMatrix`** — `RenderState::write_world_matrix`. `Position` and `Transform2D` are local for a child. The exception is a physics body: `physics_sync_post` writes Rapier's WORLD pose into them, so `propagate_transforms` treats it as a root (`pose_is_world`). A parented body is drawn on its collider, and its children compose on top of it (`verify_physics.rs` P17). Until 2026-09-26 the writers used them anyway: a 2D child was drawn at its local offset from the origin, and every child, 2D or 3D, was culled against a sphere at its local position, so it could vanish while on screen (`verify_hier.rs` H6/H7). A 2D root still builds its row from `Transform2D`, which is fresh at command time, when `ModelMatrix` is still last frame's.
- **`staging_ptr` / `staging_indices_ptr` are valid for ONE frame** and return null when empty.
- **External entity ids are capped at `MAX_EXTERNAL_ID` (1_048_575)** — `EntityMap` is a sparse Vec indexed by the id. Out-of-range spawns are rejected and counted (`engine_rejected_command_count`), which TS never reads, so TS never sends one: `EntityIdAllocator` throws "Entity id space exhausted" when every id is live or in quarantine. The TS mirror is `MAX_EXTERNAL_ID` in `types.ts`; `hyperion.test.ts` checks it against the Rust source.
- **Freed entity ids are reused under quarantine — fresh ids first** (design `docs/plans/2026-09-27-id-reuse-design.md`) — `EntityIdAllocator` (`entity-id-allocator.ts`) hands out 0, 1, 2… up to `MAX_EXTERNAL_ID` exactly as before, and only then the released ids, oldest first: below a million spawns ids, `state_hash` and tapes are independent of timing, mode and backpressure. A freed id (`destroy()`, `raw.despawn()`) is released only when (1) its DespawnEntity has been WRITTEN (`setDespawnWrittenListener`, fired in `drainTo` — under backpressure it waits in the TS queue), (2) the bridge has processed the tick that consumed it (`TickSequencer`: Mode A/B workers echo the tick's `seq` in `tick-done`, Mode C acks synchronously; `EngineBridge.nextTickSeq`/`processed`, optional — a bridge without them never releases), and (3) a LATER fixed tick ran (Rapier emits the last `Stopped` naming the old entity at the next step). At free: `ImmediateState`, selection and particle-emitter tracking forget the id; at release: sensor callbacks (`PhysicsAPI._forgetEntity`) and the `entity:released` EventBus event for plugins. While quarantined, a `SetParent` to the id is refused (`setReferenceGuard`) and a pending one is purged by the despawn (a parent → children index in the queue); joint methods throw on a dead target; `raw.*` commands to a non-live id are dropped. A stale RAW id still aliases the entity that reuses it — only a generation in the id could stop that, and the wire format has no room for one yet.
- **An unknown opcode discards the rest of the batch** — counted by `engine_dropped_command_bytes()`. A non-zero value almost always means the TS command table is ahead of the WASM build.
- **`propagate_transforms` handles arbitrary depth** — three passes (snapshot locals → compute depth → apply shallowest-first), capped at `MAX_HIERARCHY_DEPTH` (64). `SetParent` rejects self-parenting and cycles.
- **Physics CommandTypes are 17-52 (36 commands)** — NOT 14-39 as the design doc says. SetRotation2D=14, SetTransparent=15, SetDepth=16 already occupied 14-16. SetPhysicsDebugRender=47 (Phase 16); 48-52 added by audit 2026-07. Lighting takes 53-56 (Phase 17).
- **`isNonCoalescable()` classifies physics commands** — Create/Destroy (17-20), ApplyForce/Impulse/Torque (25-27), Joint lifecycle (33-37), CreateCharacterController (44) are non-coalescable. MoveCharacter (46) is coalescable (last-write-wins). ALL joint commands (33-43) are non-coalescable — the entity-based coalescing key collides when one entity owns two joints. TeleportBody (49) and DestroyCharacterController (51) are also non-coalescable. SetCharacterConfig (45), SetPhysicsDebugRender (47), SetColliderEvents (48), SetBoundingRadius (50), SetCharacterUp (52) and the remaining physics commands (21-24, 28-32) coalesce via last-write-wins. The four lighting commands (53-56) are all coalescable: none accumulates, none is a lifecycle edge, none carries a secondary id — and an ambient slider dragged under backpressure must collapse to one command per frame rather than flooding the critical queue. **But 53/54 are partial updates** (preserve bits: bit 7 of bytes 0-1 for 53, bits 2-3 for 54), so `enqueue` *merges* them field by field via `mergePartialPayload` instead of replacing — plain last-write-wins turned `castsShadow(true).receivesLight(true)` in one frame into receivesLight only. A preserved field is copied from the older payload WHOLE, preserve bit included. Any new command with preserve bits must be added to `isPartialUpdate()` and taught to the merge; `backpressure.test.ts` checks the merge against `foldLighting`, a reference model of the Rust handlers.
- **`CreateCollider` payload limits to 3 f32 params** — 1B shapeType + 3×4B params = 13B within the 16B payload. Segment shapes (4 params = 17B total) exceed the limit. Design resolution needed in milestone 15b.
- **Rapier2d's math *types* are glam, but the `vector![]` / `point![]` *macros* are still nalgebra** — corrected 2026-08-02, and the two halves are independent. (a) The type aliases are glam-backed since parry 0.26 / rapier 0.32: `Isometry<Real>`→`Pose`, `Point<Real>`→`Vector`, `Rotation<Real>`→`Rotation`, and `Vector` **is** `glam::Vec2` (`parry2d/src/math/mod.rs`). (b) But `vector![]` / `point![]` are nalgebra's macros and still expand to `nalgebra::SVector<f32, 2>` — verified by compile probe: `let v: glam::Vec2 = vector![1.0f32, 2.0f32]` fails with ``expected `Vec2`, found `Matrix<f32, Const<2>, Const<1>, ArrayStorage<f32,2,1>>` ``. So the two `.into()` calls in `physics.rs` (the `PrismaticJointBuilder` axis and the revolute `local_anchor1`) **are** genuine nalgebra→glam bridges, supplied by `glamx` — that is exactly what `glamx` is in the graph for. nalgebra is therefore reachable from our own code path, not only from the multibody jacobians we do not use. `step()` takes gravity by value (Copy), not by reference.
- **Since the glam unification, `rapier2d::math::Vector` and our `glam::Vec2` are the SAME type** — glam 0.33 + rapier 0.34 collapsed two compiled glam copies (ours 0.29 + rapier's 0.30) into one 0.33.2. `physics.gravity` now assigns straight into a `glam::Vec2` with no conversion. Before the upgrade they were distinct types that merely looked alike. Any comment claiming a "version-mismatch conversion" is pre-upgrade.
- **What the rapier 0.34 upgrade actually removed from the graph — `arrayvec`, `downcast-rs` and `num-derive` did NOT leave** — commit `11e2741` lists them as removed; they are still linked, because `parry2d` declares all three as non-optional in both 0.26 and 0.29. Measured with `cargo tree -p hyperion-core --all-features --edges normal --target wasm32-unknown-unknown`, the crates that really left are: `allocator-api2`, `bit-vec`, `equivalent`, `paste`, `robust`, `rustc-hash`, `safe_arch`, `spade`, `vec_map` (59→50 on wasm32; 62→52 on x86_64, where `safe_arch` stays because `wide` needs it — **the count is target-dependent, always state the target**). The mechanism is not "six crates disappeared" but rapier 0.34 dropping seven of its own direct dependencies and switching parry to `default-features = false`. Only the `paste` removal is security-relevant (RUSTSEC-2024-0436, genuinely resolved).
- **`physics-2d` feature flag is zero-cost when unused** — Rapier is fully tree-shaken by wasm-opt. Physics WASM build is same size as standard until WASM exports actually call Rapier functions.
- **Rapier `apply_torque_impulse` not `apply_torque`** — The method is `rb.apply_torque_impulse(torque, wake_up)`. `apply_torque` does not exist (verified through rapier2d 0.34).
- **Our physics world struct is `HyperionPhysicsWorld` — do NOT rename it back to `PhysicsWorld`** — rapier 0.33 added its own `PhysicsWorld` to `rapier2d::prelude` (undeclared breaking change). While ours shared the name, every scope globbing both needed an explicit `use super::PhysicsWorld;` (13 such imports existed). Worse, the failure mode was **not uniform**: in a *module* scope you got `E0659: PhysicsWorld is ambiguous`, but in a *function body* the rapier glob silently **won** — the bare name resolved to rapier's unrelated type with no error at all. That silent case was live at `physics_sync_pre` and `build_collider_shape`, where the prelude glob sits inside the function body. The rename (2026-08-02) retires the whole class; the only surviving `use super::HyperionPhysicsWorld;` is in `mod debug`, which has no `use super::*` and genuinely needs it. The same clash exists for `Rotation`: `rapier2d::prelude` exports one, so inside `physics_sync_pre` (which globs both preludes) write `crate::components::Rotation`.
- **glam `Vec3A`/`Mat3A` Pod-ness depends on `+simd128`** — since glam **0.30** those two types are `Pod` on SIMD backends but only `AnyBitPattern` on `scalar-math` (we hit it at 0.33 because that is when we upgraded, but the split is older). On wasm32 **without** `-C target-feature=+simd128` the scalar backend is selected. Our `.cargo/config.toml` forces `+simd128`, so we are on the right backend — but it is an implicit dependency: do not drop that flag. (We currently use neither type; this matters if that changes.)
- **`rustflags` is NOT additive between `[build]` and `[target.*]`** — `.cargo/config.toml` sets `+simd128` under `[target.wasm32-unknown-unknown]`. If `--cfg=web_sys_unstable_apis` is ever needed (WebGPU in web-sys), it must go into **that same array**, not a separate `[build]` section, or `+simd128` is silently lost.
- **Dynamic bodies need a collider for mass** — A Rapier dynamic body without a collider has zero mass and won't move under gravity or forces. Always pair `CreateRigidBody` with `CreateCollider`.
- **`process_commands` has cfg-conditional signature** — With `physics-2d`: 5 params (includes `&mut HyperionPhysicsWorld`). Without: 4 params. `process_single_command_physics` wraps the base handler to intercept physics commands.
- **Physics events cleared at frame start, accumulated across ticks** — `frame_collision_events`/`frame_contact_force_events` cleared in `Engine::update()` before the tick loop; `HyperionPhysicsWorld::step()` accumulates events from all N ticks in that frame.
- **`InteractionGroups::new()` takes 3 args in rapier2d 0.32** — `InteractionGroups::new(membership, filter, InteractionTestMode::And)`. The design doc had 2 args.
- **Two-phase event dispatch in PhysicsAPI** — Phase 1: drain ALL data from WASM memory into JS arrays. Phase 2: fire callbacks from copied data. This prevents `memory.grow` (triggered by callbacks spawning entities) from invalidating DataView mid-iteration.
- **`HyperionCollisionEvent` is 12 bytes `#[repr(C)]`** — `entity_a: u32, entity_b: u32, event_type: u8, is_sensor: u8, _pad: [u8; 2]`. Read via DataView at 12-byte stride. `event_type`: 0=started, 1=stopped.
- **`HyperionContactForceEvent` is 20 bytes `#[repr(C)]`** — `entity_a: u32, entity_b: u32, max_force_magnitude: f32, max_force_direction_x: f32, max_force_direction_y: f32`. Read at 20-byte stride.
- **Scene query static buffers are module-level `static mut`** — `RAYCAST_RESULT: [f32; 3]` and `OVERLAP_RESULTS: Vec<u32>` persist between calls. WASM exports read via `addr_of_mut!()`. Safe because wasm32 is single-threaded.
- **`QueryPipeline` is ephemeral, NOT stored** — Created on-the-fly via `broad_phase.as_query_pipeline()` for each query call. Holds borrows on `rigid_body_set`/`collider_set` so cannot persist.
- **`overlap_aabb` deduplicates by entity** — Rapier returns collider handles; multiple colliders can map to the same entity. Results deduplicated via `sort_unstable()` + `dedup()`.
- **`drainCollisionEvents`/`drainContactForceEvents` are standalone functions** — Separated from `PhysicsAPI` class for Mode B/A bridge seam reuse.
- **Joint commands (33-43) are ALL non-coalescable** — CreateRevoluteJoint, CreatePrismaticJoint, CreateFixedJoint, CreateRopeJoint, CreateSpringJoint are lifecycle commands. RemoveJoint, SetJointMotor, SetJointLimits, SetSpringParams, SetJointAnchorA/B carry the joint_id in the PAYLOAD and entity A (`JointHandle._entityA`) in the entity_id field, so an entity-keyed coalescing map would silently drop one of two joints on the same entity.
- **`JointAxis::AngX` not `AngZ` for 2D revolute motors** — Rapier2D maps angular axis to `JointAxis::AngX` (X in its internal representation). Using `AngZ` silently does nothing.
- **`SpringJointBuilder::new()` takes 3 args** — `SpringJointBuilder::new(rest_length, stiffness, damping)`. NOT 2 args as some docs suggest.
- **`impulse_joints.get_mut()` takes 2 args in Rapier 0.32** — `get_mut(handle, true)` where the second arg is `wake_up: bool`. NOT 1 arg.
- **`pending_joints` consumed in `physics_sync_pre` Pass 4** — After bodies (Pass 1), colliders (Pass 2), kinematic sync (Pass 3). Joint creation requires both body handles to exist.
- **`joint_map.retain()` cleanup on despawn** — When a body is despawned, `joint_map.retain(|_, entry| entry.entity_a != ext_id && entry.entity_b != ext_id)` removes orphaned joints. Rapier cascades joint removal when a body is removed.
- **Double joint removal is safe** — `impulse_joints.remove(handle, true)` returns `None` for already-removed joints. No need to check existence before removing.
- **A `SpawnEntity` on a live id retires the old entity, physics included, and a command reaches only the NEWEST entity with its id** (id reuse, 2026-09-27, `verify_reuse.rs` R1-R6) — the retire runs `despawn_physics_cleanup` (body, colliders, joints, controller, pending moves/teleports) like a despawn, and a spawn run naming an id twice creates only its last spawn. The physics second pass (`process_physics_commands`) resolves ids against the map at the END of the batch, so it skips every command for X placed before the last `SpawnEntity` of X in that batch (joint property commands excepted: they address the joint named in their payload, and their entity_id is only its owner A). `MoveCharacter` for an unmapped id is dropped, and a `Create*Joint` needs BOTH ends mapped when it arrives, like `SetParent`: a joint to an entity spawned LATER in the batch is rejected. Rust allocates no ids: the dead `EntityMap::allocate` + free list, which handed out live ids, was removed.
- **`JointHandle` is opaque branded type** — `number & { __brand: 'JointHandle' }`. The numeric value is the internal joint_id counter, NOT a Rapier handle index.
- **Joint fluent methods return `JointHandle`, not `this`** — Unlike other `EntityHandle` methods that return `this` for chaining, `.revoluteJoint()` etc. return a `JointHandle`. Chain breaks at joint creation.
- **`PrismaticJointBuilder` takes `Vector` not `UnitVector`** — `PrismaticJointBuilder::new(axis)` where axis is `vector![x, y].into()`. Rapier normalizes internally.
- **CC moves once per frame, not per tick** — `pending_moves` populated by `process_commands()` (1×/frame), drained in first tick's `physics_sync_pre` Pass 5. Kinematic body reaches corrected position at first `step()`.
- **`move_shape()` uses `FIXED_DT`, not frame dt** — User controls movement magnitude via `desired_translation`. Controller's internal dt is always the fixed physics timestep.
- **CC shape from first collider, no-collider = no-op** — `body.colliders()[0]` is the main collider. Entity without collider silently skips `MoveCharacter`.
- **CC only valid on kinematic bodies** — Pass 5 guards with `body.is_kinematic()`. Non-kinematic bodies silently ignored.
- **`MoveCharacter` is coalescable (last-write-wins)** — Unlike `ApplyForce` (accumulates), `MoveCharacter` replaces. Two calls in one frame = only last desired translation matters.
- **`DestroyCharacterController` is CommandType 51 (0-byte payload)** — explicit teardown added by audit 2026-07, handled in `physics_commands.rs` and non-coalescable. Despawn also still cascades cleanup via `character_map.remove(&ext_id)`.
- **`MAX_COMMAND_TYPE` is 57** — defined in both `ring_buffer.rs` and `backpressure.ts`, and this bullet is the single place that states it: it used to be repeated four times, which is exactly how it went stale. A Rust test asserts it is one past the last discriminant (`SetLightingBackend = 56`), and `guard-protocol-drift.sh` blocks a commit where the two files disagree.
- **Borrow checker: copy shape+pos before QueryPipeline** — `as_query_pipeline()` borrows `rigid_body_set` + `collider_set`. Shape and position must be copied out first to avoid overlapping borrows.

### Implementation Notes — design decisions and internal details

- **Public types with parameterless `new()`** must also impl `Default` (Clippy `new_without_default`).
- **`wasm-pack --out-dir`** is relative to the crate directory, not the workspace root.
- **Frustum extraction lives in `camera.ts`** — `CullPass` imports `extractFrustumPlanes` from `camera.ts`.
- **Depth texture lazy recreation** — `ForwardPass.ensureDepthTexture()` recreates when canvas dimensions change. `resize()` invalidates dimension tracking.
- **No rendering fallback without WebGPU** — Engine runs ECS/WASM simulation but rendering is disabled (`renderer` stays `null`). Future: WebGL 2 fallback.
- **Retained-slot partial upload (Phase 12)** — DirtyTracker + stable slots + scatter shader replace full re-upload. Remaining future optimizations: double-buffering with `mapAsync`, CPU-side frustum pre-culling.
- **Texture2DArray maxTextureArrayLayers varies by device** — WebGPU spec guarantees minimum 256. Future: query `device.limits.maxTextureArrayLayers`.
- **A texture tier that grows DESTROYS its old texture — every holder of the old view must rebind** — `ensureTierCapacity`/`ensureOverflowCapacity` replace the tier's texture and view, including the 1-layer placeholder handed out at init. `TextureManager.onViewsChanged` fires after each growth, `createRenderer` re-registers `tier0-3`/`ovf0-3` in the pool, and `ForwardPass.bindTextureTiers` rebuilds group 1 when the pool's views differ from what it was built with (checked per frame). Until 2026-09-26 none of this existed: the first `loadTexture` gave "Destroyed texture used in a submit" on every frame. It was never seen because no demo tab loads a texture. A new pass binding tier views must do the same.
- **Packed texture index 0 = untextured = white, answered by the shader** — `basic.wgsl` returns `vec4f(1.0)` for tier 0 / layer 0 / not overflow, before any sampling. Layer 0 is reserved as the "default white", but on a compressed tier (BC7/ASTC) it is never filled, because `writeTexture` cannot take raw pixels there. An all-zero BC7 block decodes to transparent black. Until 2026-09-26 every untextured quad was black on desktop and white on rgba8-only devices. `line.wgsl` and `bezier.wgsl` do the same, replacing only the COLOUR: their stroke coverage (AA, dashes, discard) still applies. A new shader that samples the tiers must answer index 0 the same way; `forward-pass.test.ts` checks every tier-sampling shader.
- **TextureManager lazy allocation** — Growth: 0→16→32→64→128→256 layers per tier. `getTierView()` creates 1-layer placeholder for bind group validity.
- **ResourcePool buffer naming** — CullPass: reads `entity-bounds`/`render-meta`/`tex-indices`, writes `visible-indices`/`indirect-args`. ForwardPass: reads `entity-transforms`/`visible-indices`/`indirect-args`/`tex-indices`/`render-meta`/`prim-params`, writes `scene-hdr`. Post-process passes read `scene-hdr`, write `swapchain`. Texture views: `tier0`-`tier3`, `ovf0`-`ovf3`, `scene-hdr`, `selection-seed`, `jfa-a`/`jfa-b`, `bloom-half`/`bloom-quarter`/`bloom-eighth`, `light-buffer` (a 2d-array view, LightGroupsPass; its seed/SDF textures are private). Sampler: `texSampler`.
- **Coalesced commands keep the position of their FIRST call, and that is load-bearing** — under backpressure the keys a flush could not write drain ahead of the others at the next one, so every entity gets through. Moving an overwritten key to the end (tried and reverted 2026-09-26) starved the tail of any update loop larger than the 64 KB ring buffer, and the audio listener with it. Where call order matters — two command types writing the same state — `SUPERSEDES` in `backpressure.ts` makes the newer REPLACE the pending older: `SetRotation` ↔ `SetRotation2D`, and `TeleportBody` (critical, so drained before every overwrite) replaces a pending `SetPosition`/rotation of its entity. A new command that writes existing state belongs in that table.
- **BackpressuredProducer wraps RingBufferProducer** — All bridge factories use it. `flush()` called at start of every `tick()`.
- **Worker heartbeat via ring buffer header** — Engine-worker increments atomic counter after each tick. `WorkerSupervisor` checks every 1s. Currently logs warnings only.
- **`Hyperion.fromParts()` vs `Hyperion.create()`** — `fromParts()` is the test factory; `create()` is production (capability detection + bridge + renderer init).
- **Plugin teardown order** — `pluginRegistry.destroyAll()` runs before bridge/renderer destroy. Plugins can still access engine resources during cleanup.
- **`GameLoop` first-frame sentinel** — `lastTime = -1` to detect first RAF callback, sets dt=0 to avoid massive first-frame spike.
- **`Children` 32-slot inline array + `OverflowChildren` heap fallback** — `Children.remove()` returns `bool`; if `false`, handler checks `OverflowChildren`. Empty overflow removed automatically.
- **JFA iteration count = ceil(log2(max(width, height)))** — ~11 for 1080p. Each iteration is a separate `JFAPass` node with unique resource name.
- **RenderGraph: one blind writer per resource, then read-modify-writes** — `compile()` checks writers BEFORE dead-pass culling, so culling can never resolve a conflict. Until 2026-09-23 the renderer always added `FXAATonemapPass` next to outline/bloom and trusted culling to drop it: `enableOutlines()`/`enableBloom()` threw, and so did the first frame with a debug overlay installed. A throw inside `render()` (inside `tickFn`) still stops the engine for good — `GameLoop.frame` isolates hooks (2026-09-27) but not `tickFn`, so `requestAnimationFrame` is never re-armed and `start()` is a no-op while `_running` stays true. It stayed hidden on macOS because Chrome picked Mode A, where the main thread has no renderer. A pass that draws on top of the graph's output (loadOp `'load'`) must list `swapchain` in `reads` AND `writes`; that is what orders it after the composite. Only the next link of a chain sees an intermediate version — a pass needing the pre-layering image must read a separately named resource, or the dependency is a cycle.
- **Plugin overlays go through `renderer.addPass()`, never `renderer.graph.addPass()`** — the graph object is replaced on every rebuild, and nothing else runs `setup()` on the pass: until 2026-09-23 no overlay had ever drawn (null pipeline, early return in `execute()`), which headless tests cannot see. `RenderGraphHost.addExternal` sets each pass up once and validates it at add time against the graph of EVERY mode — so a bad declaration, or a name like `bloom`/`jfa-N` that only clashes in another mode, throws inside the plugin's `install()`, not in the RAF callback or at the next mode switch. It carries overlays over every swap and never destroys them: `removePass()` only detaches, the plugin destroys.
- **A new render graph goes live only after the GPU validates it** — WebGPU never throws on a broken WGSL shader or pipeline: it returns invalid objects and reports asynchronously. `RenderGraphHost.request` sets the new graph up inside error scopes and keeps it PENDING while the old one draws; on an error it is discarded. Consequences: `enableBloom()`/`enableOutlines()`/`recompileShader()` take effect a frame or two later; the `bloomEnabled`/`outlinesEnabled` getters report the REQUESTED mode and fall back on a rejection; per-frame state (`scatterPass`, `jfaPasses`, resize handling) follows the LIVE graph (`host.mode`). A newer request supersedes a pending one. The initial graph is built synchronously — nothing to fall back to, errors are only logged.
- **Shader hot-reload validates each shader on its own, before any graph sees it** — `GraphRequests.reloadShader` writes the new source into the static slot only for the synchronous duration of a throwaway probe pass's `setup()`, then puts the old one back; it keeps the new one only when the GPU reports no error. So a Save All with one broken file drops just that file, and a shader of a mode that is off (`bloom.wgsl` while bloom is off) is still validated — it used to be logged "hot-reloaded" unchecked, then make `disableBloom()` fail. Adding a hot-reloadable shader means a `shaderSlots` entry with a `probe` and `usedBy`. `GraphRequests` numbers its requests: a verdict booked after a newer request (the host acts on it one microtask earlier) never undoes that request's state. Particle shaders follow the same rule through `ParticleSystem.buildSimulate/buildRender` + `installPipelines`, which also rebinds every emitter — their pipelines use `layout: 'auto'`, whose bind group layouts fit only the pipeline that made them, so a reload used to leave every live emitter failing validation.
- **A uniform struct must have NO implicit padding between members — use scalars, not a `vec2f` after an odd number of f32** — every TS writer packs its fields back to back (`f32[0], f32[1], ...`), but WGSL aligns `vec2` to 8 and `vec3`/`vec4`/`mat` to 16. So a `texelSize: vec2f` after one f32 lands 4 bytes later than the writer puts it, and the struct outgrows its buffer. That fails validation at DRAW time, which no setup check or headless test sees. Until 2026-09-26 it dropped every frame with outlines on, twice over (`jfa.wgsl` `JFAParams` 24 B against 16, then `outline-composite.wgsl` `OutlineParams` 48 B against 32): outlines had never rendered. `src/shaders/uniform-layout.test.ts` computes every uniform struct's layout with the WGSL rules and rejects interior padding.
- **`queue.writeBuffer` lands before the NEXT submit, so rewriting one buffer between passes of the same frame does nothing** — every pass in the command buffer reads the LAST write. `BloomPass` wrote its params 6 times into one 32-byte buffer, and all 6 sub-passes read the composite's full-resolution texel size: the blur was 2-8x narrower than designed. Give each pass its own slice (256-byte aligned, `offset` in the bind group entry) and write them once. Its sibling trap: a placeholder bound to an unused binding must never be the pass's own render target. Bloom's placeholder was `bloom-eighth`, which sub-pass 3 renders into. That invalidated the whole command buffer, so every bloom frame was dropped (250 errors in ~4 s). It went unseen until 2026-09-26 because no bloom graph had ever gone live. `bloom-pass.test.ts` guards both.
- **Validation cannot see draw-time errors** — no buffer layout sets `minBindingSize`, so WebGPU checks a uniform/storage struct against its buffer only at draw/dispatch time. A hot-reload that grows a struct past the buffer the TS side allocates passes validation, goes live, and then invalidates every frame's command buffer (black canvas). Set `minBindingSize` on a layout entry to close that for its pass. GPU particles are composited after the whole graph, so they still draw over overlays. Editing `debug-line.wgsl` does not reach installed overlays. Dead-pass culling still drops optional passes whose outputs nothing alive reads (e.g. `RadixSortPass`).
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
- **Engine-level commands share the `entity_id = 0` sentinel with real entity 0** — `SetListenerPosition` (13), `SetPhysicsDebugRender` (47), `SetAmbientLight` (55) and `SetLightingBackend` (56) address the engine, not an entity, but 0 is also a perfectly valid external id. `PrioritizedCommandQueue.purgeEntity()` therefore used to drop a pending listener position as collateral when entity 0 was despawned. `ENGINE_LEVEL_COMMANDS` in `backpressure.ts` now exempts them; add any future engine-level command to that set.
- **Lighting ambient and backend are NOT in the HSNP trailer** — the trailer is fixed-size (accumulator + listener), so adding them means HSNP v4. Consequence: `snapshot_restore` followed by replay only reproduces them if they were set *after* the snapshot point. Deliberately deferred; the rest of the lighting state rides along for free because lights are ECS entities.
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
- **CommandTapeRecorder circular buffer** — Uses modular indexing with configurable `maxEntries` (default 1_000_000 = ~16.7 min at 60fps × 1000 cmds/tick). Oldest entries silently evicted.
- **SnapshotManager interval-based capture** — Captures at tick multiples of `intervalTicks`. `findNearest(targetTick)` returns closest snapshot at or before target for gap replay.
- **Snapshot binary format is HSNP v3 (audit 2026-07)** — `[magic "HSNP"][version:u32=3][tick:u64][entity_count:u32][entity_map: (ext_id:u32, hecs_id:u64, flags:u8 bit0=is_2d)][per-entity: hecs_id:u64 + component_mask:u32 + data][physics_present:u8][section_len:u32][physics section][40-byte integrity trailer]`. 20 component types in bitmask (bits 15-18: Transform2D/Depth/Transparent/OverflowChildren; bit 19: LightFlags, added Phase 17 with no version bump — v1/v2 masks simply never set it, so an old snapshot restores unlit entities, which is what it described). `SNAPSHOT_VERSION = 3`; v3 is always written. v1 (u16 mask, no flags, no physics byte) and v2 (u32 mask, no trailer) still restore; the trailer is validated only when `version >= SNAPSHOT_VERSION`.
- **Snapshot physics restore is rebuild-from-state, NOT byte-exact continuation** — Solver warm-start caches are not serialized. restore(T)+N ticks == restore(T)+N ticks (bit-identical), but != the uninterrupted original run at T+N. ReplayPlayer comparisons must restore on both sides. The physics section is length-prefixed: non-physics builds skip it wholesale.
- **`snapshot_restore` replaces HyperionPhysicsWorld wholesale** — Fixes the pre-Phase-16 orphan-body bug (Rapier bodies surviving restore with dead entities). It also reassigns GPU render slots for restored entities (they were invisible in the retained-slot path before Phase 16).
- **`state_hash()` orders everything by external ID / joint ID** — hecs archetype iteration order must NEVER leak into the hash (Invariant I-2). Floats hash by bit pattern (`to_bits`): -0.0 != 0.0 and NaN payloads count.
- **Physics debug lines are per-FRAME, not per-tick** — `Engine::update()` runs `DebugRenderPipeline` once after the tick loop when enabled (CommandType 47). Rapier debug colors are HSLA; the Rust backend converts to RGBA before export.
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
- **`mark_post_system_dirty()` three-pass approach — the descendant pass must run LAST** — Pass 1: entities with non-zero `Velocity` get transform+bounds dirty. Pass 2 (physics-2d only): non-sleeping physics bodies written back by `physics_sync_post`. Pass 3: descendants of dirty parents at ANY depth, looped to a fixpoint bounded by `MAX_HIERARCHY_DEPTH` (matches multi-level `propagate_transforms`). It can only follow parents that are already marked. Until 2026-09-26 physics came after it, so the children of a Rapier-moved body stayed frozen on the GPU (`verify_physics.rs` P16).
- **Batch spawn auto-detection in `process_commands`** — Consecutive `SpawnEntity` commands are batched via `hecs::World::spawn_batch()`. Threshold: 2+ consecutive.
- **TexturePriorityQueue is standalone** — Min-heap with `urlToIndex` map for O(log n) update. Integrated into TextureManager alongside FIFO `fetchQueue`.
- **Progressive KTX2 is a TODO** — Priority queue is implemented; HTTP Range-based progressive loading deferred to future work.
- **Cull shader override constants** — `USE_SUBGROUPS` and `SUBGROUP_SIZE` are pipeline-overridable. `if (USE_SUBGROUPS)` is compile-time branching (dead code eliminated). `subgroupElect()` + `subgroupBroadcastFirst()` ensure atomic-doer and broadcast source match.
- **Ring buffer benchmark confirms 22% peak utilization** — At 10k entities / 100% movement / 1MB buffer. Transport layer is not the bottleneck.
- **Cull shader Phase 14a: 3-phase shared-memory prefix-sum replaces per-subgroup atomics** — Phase 1: intra-subgroup `subgroupAdd(vote)`, leader writes to `sg_counts`. Phase 2: the first TOTAL_BUCKETS (28) threads compute exclusive prefix across subgroups, one `atomicAdd` per active bucket. Phase 3: deterministic scatter via `wg_base + sg_prefix + intra_offset`. ~8× fewer atomics at 80%+ visibility. **Measured 2026-09-26 on an RTX 4060, this speedup does NOT hold at partial visibility:** at 50% visible the plain atomic path was faster (100k: 37-41 vs 42-47 µs; 1M: 314-319 vs 334-338 µs). The subgroup path wins only near 100% visibility. Measure before building on it.
- **`SizedBindingArraySupport.maxSize` probed empirically** — Tries 256, 512, 1024 via `createBindGroupLayout`. Stops at first failure. Current browsers return `supported=false` (proposal-stage).
- **Loro CRDT WASM binary: 664KB gzipped (5.7× over budget)** — Monolithic, 127 transitive deps. Not viable in WASM. Alternative: JS-side sync library as optional plugin via hook-based integration.

## Conventions

- All ECS components are `#[repr(C)]` with `bytemuck::Pod` + `Zeroable` for GPU-uploadable memory layout.
- Rust tests are inline `#[cfg(test)] mod tests` in each source file. TypeScript tests are `*.test.ts` colocated in `ts/src/`.
- `CommandType` enum values must stay synchronized between Rust (`ring_buffer.rs`) and TypeScript (`ring-buffer.ts`).
- Little-endian byte order everywhere for cross-architecture safety (ring buffer uses `DataView` on TS side).
- WASM singletons (`static mut ENGINE/RING_BUFFER`) are safe because wasm32 is single-threaded; every `unsafe` block has a SAFETY comment.
- Vite dev server must serve COOP/COEP headers for SharedArrayBuffer access (`vite.config.ts`).
- WGSL shaders live in `ts/src/shaders/`, loaded at dev time via Vite `?raw` imports.

## Claude Code Automations

### Hooks (`.claude/settings.json` → `.claude/hooks/*.sh`)

Hook logic lives in standalone, directly testable scripts — see [`.claude/hooks/README.md`](.claude/hooks/README.md). Each reads the payload as JSON on **stdin** and resolves the root from `$CLAUDE_PROJECT_DIR`.

| Script | Event | Behaviour |
|---|---|---|
| `guard-generated.sh` | PreToolUse `Edit\|Write` | **Blocks** edits under `ts/wasm/`, `ts/wasm-physics/`, and the two spike output dirs |
| `guard-protocol-drift.sh` | PreToolUse `Bash` | **Blocks `git commit`** when the Rust and TS `CommandType` tables disagree, or `MAX_COMMAND_TYPE` is not one past the last discriminant. Bypass once with `touch .claude/.skip-drift-guard` (flag is consumed) |
| `guard-stale-wasm.sh` | PreToolUse chrome-devtools `navigate_page` | Advisory: adds context when `ts/wasm` is older than the Rust source (by mtime, like cargo: a checkout also trips it) |
| `post-edit-rust.sh` | PostToolUse | `cargo clippy` on `.rs` edits + feature-matrix warning when `cfg(feature = ...)` code is touched |
| `post-edit-ts.sh` | PostToolUse | Colocated vitest file on `ts/src/**/*.ts` edits. A failure after editing a `*.test.ts` is reported as context (the expected TDD RED), after a source edit as an error |
| `post-edit-notices.sh` | PostToolUse | WGSL bind-group, protocol-sync, physics and structural-file reminders |
| `guard-doc-shrink.sh` | PostToolUse `Bash\|Edit\|Write` | Warns once when a `*.md` lost ≥ 40 lines and more than twice what it gained (working tree, and the commit just made); the `714a8cf` truncation is the only hit in the history |

> Verify a hook by making it **fire**, not by observing silence. A script that fails early exits non-zero with no output, which is indistinguishable from "ran clean" — that is how the previous generation of hooks (using `grep -oP`, unsupported by macOS `/usr/bin/grep`, and a hardcoded Linux path) stayed silently dead.

### Skills

- `/build-wasm` — Rebuild Rust→WASM and optionally start dev server
- `/validate` — Full Rust + TypeScript validation pipeline (run before committing)
- `/validate-physics` — Full validation pipeline including `--features physics-2d`
- `/check-size` — Audit WASM binary sizes for both standard and physics builds
- `/new-primitive` — Add a new RenderPrimitiveType (shader + pipeline + API, 7-step checklist)
- `/new-command` — Add a new ring-buffer CommandType end-to-end (Rust enum + handler + TS producer + fluent API + tests)
- `/start-phase` — Begin a new engine development phase from the masterplan (9-step workflow)
- `/close-phase` — Close a phase: full feature matrix, refresh every stale count, append the MEMORY.md record, stage the commit
- `/gpu-check` — Real-WebGPU check in the harness: rebuild a stale `ts/wasm`, AMD adapter, every tab's `N/M passed`, console errors, pixel sampling at world coordinates (`scripts/pixels.py`)

### Agents

All agent files require YAML frontmatter (`name`, `description`) to be registered — without it they are silently not loadable.

- `protocol-sync-checker` — Validates Rust↔TypeScript protocol consistency (CommandType, ring buffer layout, WASM exports)
- `wgsl-validator` — Cross-validates all 21 WGSL shaders for bind group layout consistency, ResourcePool naming, and tier coverage
- `physics-integration-checker` — Validates Rapier2D integration consistency (component lifecycle, handle tracking, despawn cleanup, event ordering, command routing)
- `webgpu-pass-reviewer` — Reviews TS render passes against the GPU contract headless tests cannot see (uniform padding, minBindingSize, per-pass slices, placeholders, view dimensions, storage budget, indirect offsets, missing bind groups). Complements `wgsl-validator`
- `claude-md-auditor` — Audits this file for factual drift: stale constants, wrong enum/test counts, phantom symbols, and self-contradictory bullets. Read-only. Tell it the merge-base: it will build a worktree there and run the same commands on both sides, which separates drift this branch caused from drift that was already present — otherwise the pre-existing errors stay invisible.

### MCP (`.mcp.json`)

`.mcp.json` is the single source of truth for MCP servers; the equivalent plugins are disabled in `.claude/settings.json` to avoid loading every tool twice.

- **Context7** — Live documentation lookup for WebGPU, KTX2, wasm-bindgen, and other specs
- **Playwright** (`@playwright/mcp`) — Browser automation for DOM-based checks in the demo harness. Until 2026-09-26 `.mcp.json` named `@anthropic-ai/mcp-playwright`, which does not exist (npm 404), so the server never connected
- **chrome-devtools** — Real Chrome with GPU access. Preferred for anything WebGPU: `requestAdapter()` returns null headless, and this exposes console messages (WGSL validation errors), performance traces, and `evaluate_script` against the live `Hyperion` facade

### Workflows (`.claude/workflows/`)

- `adversarial-review` — one finder per lens over a git range, one skeptical verifier per finding (defaults to refuted), confirmed findings ranked by severity. `args: {range, spec?, plan?, context?, accepted?, lenses?}`; default lenses `webgpu`, `protocol`, `physics`, `docs`. Run with `Workflow({name: 'adversarial-review', args})` (or by `scriptPath` if the registry has not picked it up yet). Grade the findings yourself and fix Critical/Important with a failing test first

### Claude Code plugins

`.claude/settings.json` carries an explicit `enabledPlugins` map listing **all** installed plugins — 21 enabled, 87 disabled. `github` is disabled because it needs a token this machine does not provide (it failed with "Authorization header is badly formatted"); `git` and `gh` cover the work. It is project-scoped, so the global `~/.claude/settings.json` is untouched. Every plugin is listed explicitly (rather than only the disabled ones) so the result is identical whether Claude Code merges the map per-key or replaces it wholesale.

### Formatting

- No ESLint, Prettier, or Biome configured. Do not attempt to run formatters.
- **`cargo fmt` is not clean either** — ~280 diff sites across nearly every file, including untouched ones. Running it produces a huge unrelated diff; `--check` failing is the normal state, not a regression you introduced.
- **`cargo clippy --workspace` fails on `loro-spike`** (pre-existing `thread_local` const-init lint). `preflight.sh` scopes clippy to `-p hyperion-core`, which IS clean — say which scope you mean when claiming "clippy pulito".
- **`cargo-audit` is not installed here** — `cargo audit` results cannot be reproduced without `cargo install cargo-audit` first.

## Implementation Status

**Current: Phase 17 complete and merged to master (2026-09-26), light layers included — lights render: occluder seeds from each primitive's exact shape, signed SDF (1+JFA, power-of-two steps), light accumulation with soft shadows, lit sprites and gradients, backend `'lit'` as graph mode `lighting` in ONE node (`LightGroupsPass`), light layers as automatic per-group light buffers (Unity-style), a Lighting tab in the harness, GPU cost measured (design §13.2). Open: `sprite` lights, the `mix` blend, shadows from global/directional lights. Phase 16 + Audit 2026-07 are on master.**

### Audit 2026-07 — remediation summary

A full logic review of `crates/hyperion-core/src` found 39 defects, all reproduced with tests before being fixed. Branch `fix/core-audit-2026-07`. Highlights, by what changed observably:

| Area | What was broken | What changed |
|---|---|---|
| Entity ↔ GPU slot | `entity_to_slot` keyed by generation-stripped `entity.id()` + immediate despawn / deferred slot release → despawn+spawn in one batch made the new entity invisible forever and eventually panicked (WASM trap) | slot resolved at command time (`queue_despawn`), `get_slot` validates the full `hecs::Entity`, `assign_slot` idempotent |
| Physics commands | 5 collider-override commands had no handler; `active_events` unreachable; body params in the creation batch dropped | handlers added; `Pending*` components now really accumulate; `SetColliderEvents` |
| Joints | motors/limits always on `AngX`; `SetSpringParams` zeroed the stiffness | axis chosen from `JointEntry.kind`; `set_motor_position` for springs; `max_force` → `set_motor_max_force` |
| Character controller | `up` == gravity direction so `grounded` was never true; `MoveCharacter` cancelled on 30 fps frames and halved at 144 Hz | `up` derived from gravity; `physics_sync_post` runs per tick; moves accumulate per frame |
| Rendering | root 3D entities lost X/Y rotation and `scale.z`; the exported dirty bitfield was always zero (the export later went away with temporal culling, 2026-09-26); `BoundingRadius` never left 0.5 | format by representability; per-frame bitfield snapshot; radius derived from the world matrix |
| Hierarchy | one level deep only; despawn left dangling links; cycles accepted | multi-level propagation; full unlink on despawn; cycle/self guards |
| Robustness | `snapshot_restore` could panic or abort on hostile bytes; NaN/Inf flowed to the GPU; an unknown opcode killed the stream silently | bounds/`checked_*` everywhere, HSNP v3 trailer, input validation, error counters |

Regression coverage: 91 tests in `crates/hyperion-core/tests/verify_*.rs` (verify_findings 19, verify_physics 37, verify_ring 8, verify_hier 8, verify_snapshot 5, verify_determinism 4, verify_reuse 10) — each asserts the corrected behaviour of a defect. P16/P17/P18-P18h/P19-P19d and H6-H8 (2026-09-26) are later than the audit, and so is `verify_reuse` (2026-09-27, id reuse R1-R6). `verify_determinism` is newer (2026-08-02, rapier 0.34 upgrade) and guards the narrowphase deltas rather than an audit finding; it needs BOTH `physics-2d` and `dev-tools`, so it only runs under `--all-features`.

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
| 13 | Optimization Tier 3 | Command coalescing, Transform2D (20B 2D archetype), GPU radix sort (transparency), temporal culling (skip-bounds — removed 2026-09-26: invalid pipeline until then, 0 µs measured benefit, see `docs/plans/2026-09-26-cull-temporal-firstinstance-brief.md`), sized binding array stub, KTX2 streaming (Range requests + mipmap), `__DEV__` debug elimination |
| 14a | Tech Integrations: Subgroups v2 + Binding Arrays | Cull shader shared-memory prefix-sum compaction (8× fewer atomics), `hasSubgroupId` detection for Chrome 144+ builtins, `USE_SUBGROUP_ID` override constant, `SizedBindingArraySupport` with empirical probing, `basic-binding-array.wgsl` design artifact |
| 14b | Tech Integrations: Loro CRDT Spike | Feasibility spike: 664KB gzipped (5.7× over 120KB budget) — **FAIL**. Loro monolithic, no container cherry-picking. Recommendation: JS-side sync plugin (Yjs/Automerge/Loro-JS) via `Hyperion.onCommand` hook |
| 15-spike | Physics: Rapier 0.32 Spike | API validation + binary size: +219KB gzipped (GO, under 400KB gate). 5 API divergences documented. `wasm-bindgen` feature does not exist. |
| 15a | Physics: Protocol & Scaffolding | 25 physics CommandTypes (17-41), `isNonCoalescable()`, `physics-2d` feature flag + rapier2d optional dep, dual WASM build, 25 physics producer methods, `PendingRigidBody`/`PendingCollider` types |
| 15b | Physics: Core Simulation | `HyperionPhysicsWorld` (Rapier2D state wrapper), `physics_sync_pre`/`physics_sync_post` (ECS↔Rapier sync), `process_physics_commands` (live-body routing), `velocity_system_filtered` (excludes `PhysicsControlled`), `despawn_physics_cleanup`, WASM exports (`engine_physics_configure`/`engine_physics_body_count`), `EntityHandle` fluent physics API (`.rigidBody()/.collider()/.applyForce()/.applyImpulse()`) |
| 15c | Physics: Events & Scene Queries | `#[repr(C)]` event structs (`HyperionCollisionEvent` 12B, `HyperionContactForceEvent` 20B), 9 WASM exports (4 event + 5 query), `HyperionPhysicsWorld.raycast()`/`overlap_aabb()`/`overlap_circle()`, `PhysicsAPI` class (two-phase dispatch, sensor sugar, `onCollisionStart/End`/`onContactForce`/`onSensorEnter/Exit`), `drainCollisionEvents()`/`drainContactForceEvents()` standalone helpers |
| 15d | Physics: Joints | 5 joint types (Revolute/Prismatic/Fixed/Rope/Spring), `JointEntry`+`PendingJoint` types, `joint_map`+`pending_joints` in HyperionPhysicsWorld, Pass 4 joint consumption in `physics_sync_pre`, 6 joint property commands (`RemoveJoint`/`SetJointMotor`/`SetJointLimits`/`SetSpringParams`/`SetJointAnchorA`/`SetJointAnchorB`), `JointHandle` branded type, 5 `EntityHandle` fluent joint methods, 6 `PhysicsAPI` joint convenience methods |
| 15e | Physics: Character Controller | 3 CommandTypes (44-46), `KinematicCharacterController` integration, `move_shape()` Pass 5, grounded/sliding state queries, `CharacterControllerConfig`, `EntityHandle` fluent CC API |
| 16 | Physics Debug + Determinism + Snapshot v2 | HSNP v2 — *superseded by HSNP v3 in audit 2026-07, see the Gotchas entry for the current format* — (u32 mask, 2D archetype + is_2d, physics section rebuilt-from-state, orphan-body fix, GPU slot reassignment), `JointEntry.kind`, `engine_state_hash` (FNV-1a 64, ext-ID ordered) + `EngineBridge.getStateHash()`, `physics-debug` feature (rapier `DebugRenderPipeline`, CommandType 47, `GPURenderState.physicsDebugLines`), `LineBatchPass`/`DebugLinePass` (closed 10b bounds stub), `physicsDebugPlugin` (F3), `build:wasm:physics:dev` |
| 17-A | 2D Lighting: data model & protocol (Track A) | Lights are ECS entities: `RenderPrimitive(6)` = Light2D, `LightFlags` in `renderMeta` bits 9-31 (castsShadow/receivesLight/lightType/blendMode/16-bit lightMask), range in `primParams[3]` driving `BoundingRadius`, CommandTypes 53-56 (`SetLightFlags`/`SetLightingFlags` per-entity + `SetAmbientLight`/`SetLightingBackend` engine-level), `indirect-args` 24 -> 28 buckets, 5 WASM exports, `LightingAPI` facade, `EntityHandle.light()/.shadows()/.castsShadow()/.receivesLight()/.lightLayers()`, HSNP bit 19 + `state_hash` coverage. **Nothing renders yet** — Tracks B (occluder seed + signed SDF) and C (light accumulation + `@group(2)`) are open |
| 17-B/C | 2D Lighting: occluders, signed SDF, light accumulation (Tracks B, C) | (Graph passes since folded into `LightGroupsPass` stages, see 17-E.) `OccluderSeedPass` (each primitive's own module through `fs_occluder`, `override OCCLUDER_PASS`), `SdfJfaPass` + `sdf-jfa.wgsl` (signed single-chain JFA, 1+JFA, `LOAD_PASS`), `LightAccumPass` + `light-accum.wgsl` (half-res `light-buffer` cleared to ambient, additive, sphere-marched Quilez shadows), ForwardPass `@group(2)` (basic + gradient, `fs_main` only), graph mode `lighting` + `GraphRequests.setLighting`, `followLightingBackend`, global/directional lights never culled (`f32::MAX`), picking skips lights. Along the way: temporal culling removed, `indirect-first-instance` requested, outline/bloom/particle draw-time errors fixed, uniform-layout test. Adversarial review of Track C (2026-09-26, 5 confirmed findings, all fixed): caster+receiver sprites now shadowed by other occluders, SDF chain covers the texture after a resize, switch-off intents survive a rejected request, quality reaches Mode A's render worker; plus the light-beside-a-wall penumbra and step-budget leaks found on GPU |
| 17-D | 2D Lighting: harness + measurement (Task 11) | `demo/lighting.ts` tab; GPU cost on the AMD iGPU at 1080p: SDF chain 1.77 ms, light-accum 0.22 ms, occluder-seed 0.03 ms, forward +0.30 ms with a full-screen lit floor — backend `lit` ≈ 2.3 ms (design §13.2) |
| 17-E | 2D Lighting: light layers | `lightLayers()` takes effect: `deriveLightGroups` (automatic groups + SDF sets from mask values in view), `LightGroupsPass` (one set-major node; stages `OccluderSeedStage`/`SdfChainStage`/`LightAccumStage`; light buffer as a 2d-array), ForwardPass samples its group's layer, `CameraUniform` 80 B with occluder layers, staged GPU profiling, `engine.lighting.groups`, demo check. Default scene pixel-identical; +1.84 ms per extra SDF set, +0.34 ms per extra group (1080p, iGPU) |

## Documentation

- `PROJECT_ARCHITECTURE.md` — Deep technical architecture doc. Reference for onboarding and implementation decisions.
- `docs/plans/hyperion-engine-design-v3.md` — Full vision design doc v3 (all phases). Reference for future phase implementation.
- `docs/plans/hyperion-engine-roadmap-unified-v3.md` — Unified roadmap v3. Phase-by-phase feature breakdown.
- `docs/deployment-guide.md` — Deployment guide for 7 platforms with COOP/COEP headers and WASM caching.
- `docs/plans/` — Completed phase plans (0-1, 3, 4.5, 5.5, 6, 7, 7.5, 9, 10, 10c, 11, 12, 13, 14, 15-spike/15a/15b/15c/15d, 16). Historical reference for implementation decisions.
- `docs/plans/2026-03-06-phase14b-loro-results.md` — Loro CRDT feasibility spike results (FAIL: 664KB gzipped, 5.7× over budget).
- `docs/plans/2026-03-07-phase15-physics-rapier2d-design.md` — Phase 15 physics integration design (Rapier2D). NOTE: Contains known errors (CommandType range 14-39 should be 17-41, `&gravity` should be by-value).
- `docs/plans/2026-03-07-phase15-physics-rapier2d-plan.md` — Phase 15 implementation plan (spike + 15a tasks).
- `docs/plans/2026-03-07-phase15-rapier-spike-results.md` — Rapier 0.32 spike results (GO: +219KB gzipped).
- `docs/plans/2026-03-07-phase15b-core-simulation-design.md` — Phase 15b core simulation design (PhysicsWorld, sync pre/post, command routing).
- `docs/plans/2026-03-07-phase15b-core-simulation-plan.md` — Phase 15b implementation plan (10 tasks).
- `docs/plans/2026-03-07-phase15c-events-queries-design.md` — Phase 15c events & scene queries design (#[repr(C)] events, two-phase dispatch, raycast/AABB/circle queries).
- `docs/plans/2026-03-07-phase15c-events-queries-plan.md` — Phase 15c implementation plan (10 tasks).
- `docs/plans/2026-07-25-phase16-physics-debug-determinism-snapshot-design.md` — Phase 16 design (debug render, determinism harness, snapshot v2). NOTE: OverflowChildren count is u32 in the implementation, not u8 as the design says.
- `docs/plans/2026-07-25-phase16-physics-debug-determinism-snapshot-plan.md` — Phase 16 implementation plan (10 tasks, 3 tracks).
- `docs/plans/2026-08-04-phase17-lighting-2d-design.md` — Phase 17 design: six lighting architectures evaluated against the engine as it is, then the chosen one (screen-space light buffer + JFA SDF ray march). §0 records what a second research pass corrected in the first draft.
- `docs/plans/2026-09-26-phase17-light-layer-groups-design.md` — Light layers design: one light buffer per group of layers (Unity-style batching), the user's decisions (lights AND shadows per layer, no cap on SDF sets, per-role mask 0, lowest-bit receivers, one set-major node), research on Unity 2D and Godot 4 sources.
- `docs/plans/2026-09-26-phase17-light-layer-groups-plan.md` — Light layers implementation plan (11 tasks).
- `docs/plans/2026-08-04-phase17-lighting-2d-plan.md` — Phase 17 implementation plan (11 tasks, 3 tracks). ⚠️ Decision **D1** is wrong: it claims the `Without<..., &BoundsOverride>` query already skips lights. It does not — every entity gets a `ModelMatrix` at spawn. What makes it correct is the ORDER of the two queries; see the `BoundingRadius` gotcha.
- `docs/plans/2026-03-17-phase15d-joints-design.md` — Phase 15d joints design (5 joint types, joint_map, pending_joints, Pass 4 consumption).
- `docs/plans/2026-03-17-phase15d-joints-plan.md` — Phase 15d implementation plan.
- `hyperion-masterplan.md` — Authoritative high-level reference for all phases (0-20+). Optimization strategy in §17.
