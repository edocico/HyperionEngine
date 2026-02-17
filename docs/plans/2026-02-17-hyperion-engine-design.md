# Hyperion Engine v2.1 — Architectural Design Document

**Status:** Approved
**Date:** 2026-02-17
**Stack:** Rust (WebAssembly + SIMD + Atomics), WebGPU (WGSL Compute Shaders), TypeScript (OffscreenCanvas, AudioWorklet, FinalizationRegistry)

---

## 1. Executive Summary

Hyperion is a general-purpose game engine delivering native-class performance inside the web browser. It delegates simulation logic to a Rust WebAssembly module and leverages WebGPU to offload scene organization onto the GPU's compute units via GPU-Driven Rendering.

### Primary Objectives

- **Zero-Blocking Architecture:** Physical separation between UI, Engine Logic, and Rendering via SharedArrayBuffer and OffscreenCanvas, with graceful degradation to single-thread.
- **GPU-Driven Scale:** 100,000+ volumetric entities via WGSL Frustum Culling and Indirect Drawing, eliminating CPU-side draw call orchestration.
- **Memory Safety Synchronized:** High-level TypeScript API protected from memory leaks via explicit disposal, entity pooling, and FinalizationRegistry backstop.
- **Adaptive Execution:** Three runtime modes (Full Isolation, Partial Isolation, Single Thread) selected via feature detection at startup.

---

## 2. Adaptive Multi-Thread Architecture

The engine operates in one of three execution modes, selected at startup via feature detection.

### Mode A — Full Isolation (Optimal)

- **Requires:** `SharedArrayBuffer` available, `OffscreenCanvas.transferControlToOffscreen()` supported, WebGPU in Workers enabled
- **Layout:** Main Thread (UI/Input) -> Worker 1 (ECS + Physics via WASM) -> Worker 2 (Render via WASM + wgpu)
- **Communication:** Lock-free MPSC Ring Buffers on `SharedArrayBuffer`

### Mode B — Partial Isolation (Firefox fallback)

- **Requires:** `SharedArrayBuffer` available, WebGPU on Main Thread only
- **Layout:** Main Thread (UI/Input + Render via wgpu) -> Worker 1 (ECS + Physics via WASM)
- **Communication:** Ring Buffer for commands, `postMessage` with transferable `ArrayBuffer` for render state snapshot

### Mode C — Single Thread (Maximum compatibility)

- **Requires:** WebGPU on Main Thread
- **Layout:** Main Thread runs everything sequentially: Input -> ECS tick -> Render
- **Communication:** Direct function calls, no Ring Buffer needed
- **Note:** Viable for scenes under ~10k entities at 60fps

The Rust WASM module is agnostic to which thread it runs on. It consumes a command buffer and produces a render state buffer, regardless of transport.

### Deployment Requirement

Modes A and B require cross-origin isolation (COOP/COEP HTTP headers). The engine detects `crossOriginIsolated` at startup and falls back gracefully, logging a clear warning to the developer console.

---

## 3. Memory Bridge — Ring Buffer on SharedArrayBuffer

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

### Endianness Safety

The Ring Buffer protocol uses `DataView` for all cross-boundary reads/writes, ensuring correct behavior regardless of host architecture endianness.

---

## 4. ECS Core — `hecs` with Migration Path

### Selection Rationale

`bevy_ecs` loses its parallelism advantage on `wasm32-unknown-unknown` (falls back to single-thread execution) while introducing transitive dependency issues and larger binary size. `hecs` provides:

- Minimal binary footprint (critical for WASM download size)
- No transitive dependency conflicts on WASM targets
- Equivalent single-thread iteration speed
- Simpler integration model

### Migration Path

The ECS interface is wrapped behind an internal `trait World` abstraction (not exposed to users). Future migration to `bevy_ecs` or `flecs-rs` requires changing only the adapter implementation.

### Data-Oriented Enforcement

- No `dyn Trait` in components (destroys cache contiguity)
- Pure Struct of Arrays layout with `glam` SIMD types
- All spatial abstractions use 3D coordinates with quaternions
- 2D projection via orthographic cameras manipulating Z for hardware depth testing
- Behavior modeled through component presence/absence, processed by dedicated Systems

---

## 5. Object Lifecycle — Dual-Strategy Resource Management

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

---

## 6. Rendering Pipeline — GPU-Driven Model

### Compute Culling Stage

Each frame, entity spatial data from the ECS populates a `StorageBuffer` uploaded to VRAM. A WGSL Compute Shader launches one invocation per entity, performing Frustum Culling against the camera's view planes. Visible entities are appended to a visibility list via `atomicAdd`.

### Indirect Drawing

The rendering pass uses `draw_indexed_indirect`, reading vertex/instance counts directly from GPU buffers populated by the Compute Shader. The CPU never touches draw call parameters.

### Texture Management — Texture2DArray

Sprite textures are packed into `Texture2DArray` resources (single GPU descriptor, multiple independent layers). Each entity's fragment shader samples the correct layer via a component-driven Z-index. This eliminates:

- Mipmap bleeding (inherent to texture atlases)
- Texture bind state changes
- Complex atlas packing algorithms

Bindless textures are deferred until WebGPU standardization matures.

### Storage Buffer Budget

At 64 bytes per entity, 100k entities = ~6.4MB (well within WebGPU's guaranteed 128MB `maxStorageBufferBindingSize`). For scenes exceeding ~500k entities, a spatial streaming system uploads only entities within the camera's extended frustum.

### Mode B/C Compatibility

Compute culling executes on GPU regardless of execution mode. The only difference is whether `device.queue.submit()` is called from a Worker or the Main Thread.

---

## 7. Asset Pipeline — Native Browser Decoding

### Rejected Approach

Decoding compressed images (PNG, JPEG, WebP) inside WASM via the `image` crate wastes CPU cycles, blocks the simulation thread, and inflates the WASM binary.

### Adopted Approach

```
fetch() -> Blob -> createImageBitmap() -> device.queue.copyExternalImageToTexture()
```

- `createImageBitmap()` decodes asynchronously on the browser's internal thread pool with hardware acceleration
- Decoded bitmap transfers directly from browser memory to VRAM
- Pixels never traverse WASM linear memory
- Future: KTX2/Basis Universal support for GPU-compressed textures that remain compressed in VRAM

---

## 8. Audio Subsystem — AudioWorklet Isolation

### Problem

Audio requires buffer fills with <3ms latency tolerance. Running DSP in the same cycle as physics/rendering causes buffer underruns (audible artifacts) during compute spikes.

### Solution

- Dedicated `AudioWorkletProcessor` running a specialized, minimal Rust/WASM binary for synthesis and mixing
- Communication via lock-free Ring Buffer on `SharedArrayBuffer`
- Game events (spatial audio triggers, pitch changes) are written as non-blocking commands by the ECS
- AudioWorklet reads commands independently at sample rate (44.1kHz), immune to graphics framerate variance

---

## 9. Input Latency Mitigation — Predictive Input Layer

### Problem

In Modes A and B, user input traverses: Main Thread -> Ring Buffer -> Worker 1 (ECS) -> Shared Buffer -> Worker 2 (Renderer). This introduces 2-3 frames of latency between input and visual response.

### Solution

The Main Thread maintains a lightweight "shadow state" for player-controlled entities:

1. Input event fires on Main Thread
2. Event is serialized into Ring Buffer for authoritative ECS processing
3. Simultaneously, Main Thread applies input to shadow state via simplified movement model
4. Shadow state is sent to Renderer as a priority override for specific entity IDs
5. When authoritative ECS state arrives (1-2 frames later), shadow snaps to it via exponential smoothing

In Mode C, this layer is bypassed (input flows directly into the ECS tick).

---

## 10. Compilation Strategy

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

---

## 11. Implementation Roadmap

| Phase | Name | Deliverables |
|-------|------|-------------|
| 0 | Scaffold & Execution Harness | Project structure, COOP/COEP dev server, capability detection, adaptive mode selection (A/B/C), SharedArrayBuffer Ring Buffer, Web Worker instantiation |
| 1 | ECS Core (Worker 1) | `hecs` integration, SoA components, transform system, spatial hashing, deterministic tick loop, command buffer consumption |
| 2 | Render Core (Worker 2 / Main) | wgpu initialization, OffscreenCanvas transfer (Mode A) or Main Thread context (Mode B/C), basic draw pipeline, debug overlay |
| 3 | GPU-Driven Pipeline | WGSL compute culling shader, Storage Buffer layout, indirect draw, Texture2DArray system |
| 4 | Asset Pipeline & Textures | `createImageBitmap` flow, Texture Array packing, KTX2/Basis Universal support |
| 5 | TypeScript API & Lifecycle | Phaser-like consumer API, `dispose()` + `using` support, FinalizationRegistry backstop, entity pooling |
| 6 | Audio & Input | AudioWorklet isolation, dedicated audio WASM binary, predictive input layer, input reconciliation |
| 7 | Polish & DX | Shader hot-reload, dev watch mode, performance profiler, documentation |

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
