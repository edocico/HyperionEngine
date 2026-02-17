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
cargo test -p hyperion-core                  # All Rust unit tests (32 tests)
cargo clippy -p hyperion-core                # Lint check (treat warnings as errors)
cargo build -p hyperion-core                 # Build crate (native, not WASM)
cargo doc -p hyperion-core --open            # Generate and open API docs

# Run specific test groups
cargo test -p hyperion-core ring_buffer      # Ring buffer tests only (12 tests)
cargo test -p hyperion-core engine           # Engine tests only (5 tests)
cargo test -p hyperion-core render_state     # Render state tests only (4 tests)
cargo test -p hyperion-core command_proc     # Command processor tests only (5 tests)
cargo test -p hyperion-core systems          # Systems tests only (3 tests)
cargo test -p hyperion-core components       # Component tests only (3 tests)

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
cd ts && npm test                            # All vitest tests (20 tests)
cd ts && npm run test:watch                  # Watch mode (re-runs on file change)
cd ts && npx tsc --noEmit                    # Type-check only (no output files)
cd ts && npm run build                       # Production build (tsc + vite build)
cd ts && npm run dev                         # Vite dev server with COOP/COEP headers

# Run specific test files
cd ts && npx vitest run src/ring-buffer.test.ts        # Ring buffer producer (5 tests)
cd ts && npx vitest run src/ring-buffer-utils.test.ts  # extractUnread helper (4 tests)
cd ts && npx vitest run src/camera.test.ts             # Camera math (5 tests)
cd ts && npx vitest run src/capabilities.test.ts       # Capability detection (4 tests)
cd ts && npx vitest run src/integration.test.ts        # E2E integration (2 tests)
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
                                                                  RenderState.collect()  →  model matrices buffer
                                                                       ↓
                                                                  TS: WebGPU renderer  →  GPU draw
```

Commands flow through a lock-free SPSC ring buffer on SharedArrayBuffer. The ring buffer binary protocol: `[cmd_type: u8][entity_id: u32 LE][payload: 0-16 bytes]`. Header is 16 bytes (write_head atomic, read_head atomic, capacity, padding), data region follows.

### Key Design Decisions

- **hecs over bevy_ecs:** bevy_ecs loses parallelism on wasm32 (falls back to single-thread) while adding binary bloat.
- **Ring buffer over direct FFI:** Batches mutations per frame instead of per-call, avoiding wasm FFI overhead at scale. Static SharedArrayBuffer avoids `memory.grow` invalidating JS views.
- **Fixed timestep (1/60s) with accumulator:** Deterministic physics. Spiral-of-death capped at 10 ticks.
- **FinalizationRegistry as backstop only:** Primary cleanup is explicit `.dispose()`. GC-based cleanup is unreliable per spec.
- **`addr_of_mut!()` for static mut access:** Required by Rust 2024 edition; avoids creating references to uninitialized statics.

### Crate: hyperion-core

| Module | Role |
|---|---|
| `lib.rs` | WASM exports: `engine_init`, `engine_attach_ring_buffer`, `engine_update`, `engine_tick_count` |
| `engine.rs` | `Engine` struct with fixed-timestep accumulator, ties together ECS + commands + systems |
| `command_processor.rs` | `EntityMap` (external ID ↔ hecs Entity with free-list recycling) + `process_commands` |
| `ring_buffer.rs` | SPSC consumer with atomic read/write heads, `CommandType` enum, `Command` struct |
| `components.rs` | `Position(Vec3)`, `Rotation(Quat)`, `Scale(Vec3)`, `Velocity(Vec3)`, `ModelMatrix([f32;16])`, `Active` — all `#[repr(C)]` Pod |
| `systems.rs` | `velocity_system`, `transform_system`, `count_active` |
| `render_state.rs` | Collects model matrices into contiguous GPU-uploadable buffer |

### TypeScript: ts/src/

| Module | Role |
|---|---|
| `capabilities.ts` | Detects browser features, selects ExecutionMode A/B/C |
| `ring-buffer.ts` | `RingBufferProducer` — serializes commands into SharedArrayBuffer with Atomics |
| `worker-bridge.ts` | `EngineBridge` interface — `createWorkerBridge()` (Modes A/B) or `createDirectBridge()` (Mode C) |
| `engine-worker.ts` | Web Worker that loads WASM, calls `engine_init`/`engine_update` per frame |
| `main.ts` | Entry point: detect capabilities → create bridge → requestAnimationFrame loop |
| `renderer.ts` | WebGPU renderer: pipeline, buffers, instanced quad drawing |
| `camera.ts` | Orthographic camera with view-projection matrix |
| `render-worker.ts` | Mode A render worker: OffscreenCanvas + WebGPU pipeline |
| `shaders/basic.wgsl` | Instanced colored quad WGSL shader |
| `vite-env.d.ts` | Type declarations for WGSL ?raw imports and Vite client |

## Gotchas

- **Ring buffer SAB not yet attached to WASM memory** — `engine_worker.ts` stores the SAB ref but doesn't call `engine_attach_ring_buffer()`. Commands aren't flowing TS→Rust in the Worker yet. Phase 2 will complete this.
- **hecs 0.11 `query_mut`** returns component tuples directly, NOT `(Entity, components)`. Use `for (pos, vel) in world.query_mut::<(&mut Position, &Velocity)>()`.
- **Rust `u64` → JS `BigInt`** via wasm-bindgen. Wrap with `Number()` on TS side (safe for values < 2^53).
- **`wasm-bindgen` can't export `unsafe fn`** — use `#[allow(clippy::not_unsafe_ptr_arg_deref)]` for functions taking raw pointers.
- **TS `const enum` has no reverse mapping** — `CommandType[value]` fails (TS2476). Log numeric values directly.
- **Public types with parameterless `new()`** must also impl `Default` (Clippy `new_without_default`).
- **`wasm-pack --out-dir`** is relative to the crate directory, not the workspace root.
- **`@webgpu/types` Float32Array strictness** — `writeBuffer` requires `Float32Array<ArrayBuffer>` cast when the source might be `Float32Array<ArrayBufferLike>`.

## Conventions

- All ECS components are `#[repr(C)]` with `bytemuck::Pod` + `Zeroable` for GPU-uploadable memory layout.
- Rust tests are inline `#[cfg(test)] mod tests` in each source file. TypeScript tests are `*.test.ts` colocated in `ts/src/`.
- `CommandType` enum values must stay synchronized between Rust (`ring_buffer.rs`) and TypeScript (`ring-buffer.ts`).
- Little-endian byte order everywhere for cross-architecture safety (ring buffer uses `DataView` on TS side).
- WASM singletons (`static mut ENGINE/RING_BUFFER`) are safe because wasm32 is single-threaded; every `unsafe` block has a SAFETY comment.
- Vite dev server must serve COOP/COEP headers for SharedArrayBuffer access (`vite.config.ts`).
- WGSL shaders live in `ts/src/shaders/`, loaded at dev time via Vite `?raw` imports.

## Implementation Status

Phases 0-2 are complete. The architecture design doc is at `docs/plans/2026-02-17-hyperion-engine-design.md`. Phase 3 (GPU-Driven Pipeline) is next.

## Documentation

- `PROJECT_ARCHITECTURE.md` — Deep technical architecture doc (algorithms, data structures, protocol details, design rationale). Reference for onboarding and implementation decisions.
- `docs/plans/2026-02-17-hyperion-engine-design.md` — Full vision design doc (all 8 phases). Reference for future phase implementation.
- `docs/plans/2026-02-17-hyperion-engine-phase0-phase1.md` — Phase 0-1 implementation plan (completed). Shows task-by-task build sequence.
