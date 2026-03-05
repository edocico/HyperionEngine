# Phase 13: Optimization Tier 3 + Leftover Completions — Design

> **Date**: 2026-03-05
> **Scope**: 7 optimization items (5 Tier 3 + 2 leftover from Tiers 1/2)
> **Ordering**: #5 -> #13 -> #14 -> #11 -> #12 || #10 -> #15
> **Effort**: ~5-6 weeks
> **Benchmark targets**: Canvas (10k): frame time <=3ms | Game (100k): frame time <=5ms, max entities >=280k

---

## 1. Overview

Phase 13 completes the optimization strategy from the masterplan (section 17). It includes all 5 Tier 3 items plus 2 leftover items from Tiers 1/2 that were deferred:

| # | Item | Area | Headroom | Effort |
|---|------|------|----------|--------|
| 5 | Command coalescing | Ring Buffer | 30-50% less traffic | 1-2 days |
| 13 | 2D component optimization | ECS | 2x iteration throughput | 1-1.5 weeks |
| 14 | GPU radix sort for transparency | Rendering | Correct alpha compositing | 1 week |
| 11 | Temporal culling coherence | Rendering | ~50% culling cost | 1 week |
| 12 | Sized binding arrays | Textures | (stub only — proposal-stage) | 2 days |
| 10 | Texture streaming | Assets | Eliminate startup stutter | 1 week |
| 15 | Time-travel debug integration | DX | Zero overhead in prod | 2-3 days |

**Benchmark baseline requirement**: Before measuring Tier 3 impact, validate that Tier 1+2 optimizations (SIMD128, subgroups, scatter upload, material sort, compressed transforms) are active in the benchmark build. Baseline = `build:wasm:release` + production Vite build.

---

## 2. Ordering Rationale

```
#5 Command Coalescing (TS-only, enables profiling baseline)
    |
#13 Transform2D + Depth (Rust ECS + consumer, heaviest item)
    |
#14 GPU Radix Sort + Transparent (depends on Depth from #13)
    |
#11 Temporal Culling Coherence (GPU rendering, independent post-#13)
    |
#12 Sized Binding Arrays --+-- (parallel, both texture system)
#10 Texture Streaming -----+
    |
#15 Time-Travel Debug Integration (cleanup, no deps)
```

- **#5 before #13**: Coalescing provides a normalized profiling baseline. With coalescing active, ring buffer stats show real command counts post-dedup, isolating #13's iteration throughput improvement from ring buffer noise.
- **#13 before #14**: The `Depth(f32)` component introduced by #13 is the sort key for #14's radix sort. Without #13, depth would have to be extracted from `Position.z` — the exact waste #13 eliminates.
- **#12 || #10**: Both are texture system changes with no mutual dependency. Parallelizable.
- **#15 last**: Cleanup pass with no functional dependencies. Best done after all other items stabilize.

---

## 3. #5 Command Coalescing

### Goal

Reduce ring buffer commands per frame by 30-50% via last-write-wins deduplication.

### Design

`BackpressuredProducer` already has `overwrites: Map<number, Command>` with key `entityId * 256 + cmdType` as a backpressure fallback. Promote this to the default write path:

```
Current:  setPosition() -> write directly to ring buffer
          (overflow) -> queue in overwrites -> flush later

New:      setPosition() -> write to overwrites map (always)
          flush() (once/frame) -> drain map to ring buffer
```

**Lifecycle commands** (`SpawnEntity`, `DespawnEntity`) bypass coalescing — they go to the ordered `critical` queue since ordering matters.

### Edge Case: Despawn Purge

When `DespawnEntity(eid)` is enqueued, purge all pending overwrites for that entity:

```typescript
enqueue(cmd: Command): void {
    if (cmd.type === CommandType.DespawnEntity) {
        this.critical.push(cmd);
        this.purgeEntity(cmd.entityId);
    } else if (cmd.type === CommandType.SpawnEntity) {
        this.critical.push(cmd);
    } else {
        this.overwrites.set(cmd.entityId * 256 + cmd.type, cmd);
    }
}

private purgeEntity(entityId: number): void {
    for (let cmdType = 0; cmdType < MAX_COMMAND_TYPE; cmdType++) {
        this.overwrites.delete(entityId * 256 + cmdType);
    }
}
```

O(15) per despawn (iterate over ~15 CommandType values), not O(map.size).

### Inter-Command Ordering Invariant

The `Map` in JS iterates in insertion order of the first write per key. For different command types on the same entity in the same frame, drain order matches call order. Documented as invariant — if it becomes a problem in the future, a mini topological sort per command type in drain would fix it, but not needed now.

### Profiling

`flush()` returns stats with three counters:
- `coalescedCount`: commands deduplicated (writes that overwrote a previous value)
- `writtenCount`: commands actually written to ring buffer
- `purgedByDespawn`: overwrites dropped due to entity despawn in same frame

### Testing

Extend `backpressure.test.ts` (22 existing tests). New tests: last-write-wins semantics, spawn/destroy bypass, despawn purge, profiling counters.

---

## 4. #13 Transform2D + Depth

### Goal

2x ECS iteration throughput via compact 2D archetype.

### New Components (Rust)

```rust
#[repr(C)] #[derive(Pod, Zeroable, Clone, Copy)]
struct Transform2D {
    x: f32, y: f32,    // position
    rot: f32,           // angle in radians
    sx: f32, sy: f32,   // scale
}  // 20 bytes

#[repr(C)] #[derive(Pod, Zeroable, Clone, Copy)]
struct Depth(f32);  // 4 bytes, opt-in for 2.5D z-ordering
```

### Three Archetypes

| Archetype | Components | Input Size | Use Case |
|-----------|-----------|------------|----------|
| 2D (hot) | `Transform2D` + `ModelMatrix` + ... | 20B | 99% of entities |
| 2.5D | `Transform2D` + `Depth` + `ModelMatrix` + ... | 24B | Layered/transparent |
| 3D (cold) | `Position` + `Rotation` + `Scale` + `ModelMatrix` + ... | 40B | Future, few entities |

### 2x Throughput Breakdown

Three factors combine:
1. **Lookup halved**: 2 component array lookups (Transform2D + ModelMatrix) vs 4 (Position + Rotation + Scale + ModelMatrix)
2. **Bandwidth halved**: 20B vs 40B input per entity. For 100k entities at streaming access: 1.9MB vs 3.8MB (both exceed L2)
3. **Compute reduced**: `sin/cos` of a single angle vs quaternion-to-matrix decomposition

### New Ring Buffer Command

`SetRotation2D = 14` — payload: `f32` (angle in radians). **Mandatory**, not optional.

Rationale: `SetRotation` with quaternion on 2D entities requires `atan2(2*(qw*qz + qx*qy), 1 - 2*(qy*qy + qz*qz))` extraction. This formula is correct ONLY for pure Z-axis rotations (qx=0, qy=0). Non-pure-Z quaternions produce silently wrong angles — a correctness bug, not just an ergonomics issue.

Consumer routing:
- `SetRotation2D` writes `transform.rot` directly; if entity is 3D, log + ignore.
- `SetRotation` (quat) on 2D entity remains supported as compatibility fallback with atan2 conversion, but the TS API no longer generates it for 2D entities.

### Ring Buffer: SpawnEntity Flag

`SpawnEntity` gains a 1-bit flag in the payload to indicate 2D vs 3D archetype. Room exists in reserved bits.

### Command Routing in Consumer

- `SetPosition(eid, x, y, z)`: 2D writes `transform.x/y`, ignores z. 3D writes `Position(Vec3)`.
- `SetRotation2D(eid, angle)`: writes `transform.rot` directly. 3D: error.
- `SetRotation(eid, qx, qy, qz, qw)`: 3D writes `Rotation(Quat)`. 2D: atan2 fallback.
- `SetScale(eid, sx, sy, sz)`: 2D writes `transform.sx/sy`. 3D writes `Scale(Vec3)`.

New command: `SetDepth(eid, z: f32)` — sets `Depth` component. Only valid for 2.5D entities.

### EntityMap BitVec

`EntityMap` tracks 2D vs 3D per entity via a `BitVec` indexed by entity slot (1 bit per entity). ~12.5KB for 100k entities. Must be `pub(crate)` for forward-compatibility with future physics sync.

### System Changes

```rust
// Hot path -- 2D (vast majority)
fn transform_system_2d(world: &mut World) {
    for (t, matrix) in world.query_mut::<(&Transform2D, &mut ModelMatrix)>() {
        let (sin, cos) = t.rot.sin_cos();
        // 6 multiplications: scale * rotation_2d * translation
    }
}

// Cold path -- 3D (few entities)
fn transform_system_3d(world: &mut World) {
    for (pos, rot, scale, matrix) in
        world.query_mut::<(&Position, &Rotation, &Scale, &mut ModelMatrix)>() {
        // Unchanged from today
    }
}
```

`velocity_system` splits similarly: 2D applies `Velocity.x/y` to `Transform2D.x/y`, 3D to `Position`.

### propagate_transforms Is Unchanged

**Architectural invariant**: `propagate_transforms` reads `ModelMatrix` + `LocalMatrix` + `Parent` — it is agnostic to the source archetype. No 2D/3D split needed. Documented explicitly to prevent unnecessary refactoring.

### Velocity Stays Vec3

Deliberate trade-off: `Velocity` remains `Vec3`, wasting 4 bytes of z per entity. Creating `Velocity2D` would duplicate the archetype-split problem across velocity_system, future physics sync, and every system reading velocity. For 100k entities with 20% having Velocity = 80KB waste — acceptable. Documented to prevent future "optimize Velocity2D" scope creep.

### SoA / Render State Impact

`collect_dirty_staging()` and `write_slot()` produce `ModelMatrix` — agnostic to source archetype. **No changes to scatter shader, cull shader, or forward pass.** The compressed 2D transform path in `scatter.wgsl` (format=0) maps naturally to `Transform2D` fields.

### TS-Side API

```typescript
// Default: 2D (no breaking change)
engine.spawn()
  .position(100, 200)
  .rotation(Math.PI / 4)     // angle, not quaternion
  .texture(handle)

// 2.5D: opt-in depth
engine.spawn()
  .position(100, 200)
  .depth(5)                   // adds Depth component
  .texture(handle)

// EntityHandle.rotation() overload
rotation(angleOrQx: number, qy?: number, qz?: number, qw?: number): this {
    if (qy === undefined) {
        // 2D: single angle
        this.producer.enqueue(CommandType.SetRotation2D, this.id, angleOrQx);
    } else {
        // 3D: quaternion
        this.producer.enqueue(CommandType.SetRotation, this.id, angleOrQx, qy, qz, qw);
    }
    return this;
}
```

### Forward Compatibility: Physics

The `EntityMap` BitVec must be accessible from future `physics_sync_post` (behind `#[cfg(feature = "physics-2d")]`). Design the BitVec access as `pub(crate)` now.

### Risk

Most pervasive change. Touches: `components.rs`, `command_processor.rs`, `ring_buffer.rs`, `systems.rs`, `render_state.rs`, `engine.rs`, `ring-buffer.ts`, `entity-handle.ts`, `backpressure.ts`. 110+ Rust tests and ~632 TS tests must pass.

---

## 5. #14 GPU Radix Sort for Transparency

### Goal

Correct alpha compositing for semi-transparent ECS entities via `Transparent` component flag + GPU radix sort on the flagged subset.

### Strategy: Sort Only When Needed (Option C)

The CullPass produces indices grouped by `RenderPrimitiveType` via stream compaction. The `Transparent` flag splits each type into opaque and transparent subsets. The radix sort applies only to the transparent subset (typically 1-5% of entities). For opaque-heavy scenes, the sort is never invoked — zero cost.

Render order: opaque front-to-back (early-Z, via existing material sort keys from Phase 12) then transparent back-to-front (via radix sort).

### Transparent Flag: renderMeta Bit 8

No new SoA buffer. The existing `renderMeta` u32 per entity has 24 unused bits (primitive type uses bits 0-7). Bit 8 encodes transparency:

```wgsl
let is_transparent = (renderMeta[entity_idx] & 0x100u) != 0u;
```

Rust `write_slot()` sets bit 8 when entity has the `Transparent` component. Zero new buffers, bindings, or uploads.

### New Component (Rust)

```rust
#[repr(C)] #[derive(Pod, Zeroable, Clone, Copy)]
struct Transparent(u8);  // 1 byte marker (hecs requires non-ZST for Pod)
```

### New Ring Buffer Command

`SetTransparent = 15` — payload: `u8` (1 = transparent, 0 = opaque). Toggleable at runtime.

### f32 Sort Key: Sign-Aware Bit Manipulation

IEEE 754 float interpreted as u32 sorts correctly only for positive floats. Negative depth values invert the order. **Correctness requirement**:

```wgsl
fn float_to_sort_key(f: f32) -> u32 {
    let bits = bitcast<u32>(f);
    let mask = select(0x80000000u, 0xFFFFFFFFu, (bits & 0x80000000u) != 0u);
    return bits ^ mask;
}
```

For back-to-front (descending): `~float_to_sort_key(depth)`.

### Composite Sort Key

The ForwardPass dispatches per-type with different pipelines. A single-depth sort would mix types, breaking per-type dispatch. Composite key preserves per-type contiguity:

```wgsl
fn make_transparent_sort_key(prim_type: u32, depth: f32) -> u32 {
    let depth_bits = float_to_sort_key(depth);
    let depth_descending = ~depth_bits;
    // Top 8 bits: primitive type, bottom 24 bits: inverted depth
    return (prim_type << 24u) | (depth_descending >> 8u);
}
```

After sort, entities are contiguous per type and ordered back-to-front within each type. CullPass counts transparent entities per type and populates indirect args with correct offsets.

### CullPass Changes

Indirect args: from 6 (one per type) to 12 (6 types x 2 blend modes). Buffer grows from 120 bytes to 240 bytes.

Cull shader routes entities to opaque or transparent region of visible-indices based on renderMeta bit 8.

### Radix Sort Pass (New)

`RadixSortPass` — new compute pass. 4 passes for 32-bit keys (8-bit radix per pass):
1. Histogram: count digits per bucket (256 buckets)
2. Prefix sum: exclusive scan (reuses Blelloch from `prefix-sum.wgsl`)
3. Scatter: write key+value pairs to sorted positions

New shader: `ts/src/shaders/radix-sort.wgsl`.

For typical transparent subset (500-5000 entities at 100k total): <0.2ms.

### ForwardPass Changes

Two sub-passes:
1. **Opaque front-to-back**: depth write ON, alpha blend OFF. Uses opaque visible-indices. Front-to-back ordering is a byproduct of the existing material sort key (Phase 12 #7) — no separate mechanism needed.
2. **Transparent back-to-front**: depth write OFF (read-only), alpha blend ON (`src-alpha`, `one-minus-src-alpha`). Uses sorted transparent visible-indices.

### Depth Source

- 2D entities: `Depth(f32)` component from #13. Default `0.0` if absent.
- 3D entities: `Position.z`.

Depth written to a new SoA column in `render_state.rs`, populated by `write_slot()`.

### TS-Side API

```typescript
engine.spawn()
  .position(100, 200)
  .depth(3)
  .transparent()
  .texture(handle)
```

### Risk

- Indirect args buffer doubles (120 -> 240 bytes) — trivial.
- Radix sort dispatches 4 passes per frame when transparent entities exist, 0 when none.
- Cull shader complexity increases (transparent read + dual output).

---

## 6. #11 Temporal Culling Coherence

### Goal

~50% reduction in GPU culling cost by skipping bounds reads for stable entities.

### Core Insight: Bandwidth, Not ALU

The CullPass bottleneck is memory bandwidth, not ALU:
- Read `bounds[i]`: 16 bytes (vec4f: xyz + radius) — 70-80% of cull cost
- 6 dot products: ~24 FMA ops — ~2 nanoseconds on modern GPU
- For 100k entities (1.6MB bounds buffer), bandwidth dominates

A temporal test that still reads bounds saves only the ALU portion (~20-30% of cull time). To achieve 50% savings, we must **skip bounds reads entirely** for stable entities.

### Design: Skip-Bounds via DirtyTracker

The `DirtyTracker` in `render_state.rs` already maintains a `BitSet` for transform-dirty entities. Upload this bitfield to the GPU and use it in the cull shader:

```wgsl
@group(N) @binding(0) var<storage, read> visibility_prev: array<u32>;  // bitfield
@group(N) @binding(1) var<storage, read> dirty_bits: array<u32>;       // from DirtyTracker

fn cull_entity(entity_idx: u32) {
    let word = entity_idx / 32u;
    let bit = entity_idx % 32u;

    let was_visible = (visibility_prev[word] >> bit) & 1u;
    let is_dirty = (dirty_bits[word] >> bit) & 1u;

    var visible: bool;

    if (invalidate_all || is_dirty == 1u || was_visible == 0u) {
        // Full test: entity moved, wasn't visible, or camera teleported
        let b = bounds[entity_idx];
        visible = sphere_frustum_test(b.xyz, b.w, planes);
    } else {
        // Entity was visible AND hasn't moved AND camera didn't teleport
        // Skip bounds read entirely
        visible = true;
    }

    // Write result for next frame
    if (visible) {
        atomicOr(&visibility_out[word], 1u << bit);
        let slot = atomicAdd(&drawArgs[prim_type].instanceCount, 1u);
        visibleIndices[slot] = entity_idx;
    }
}
```

### Invalidation

Full re-cull (all entities) when:
- Camera teleports: `|camera.x - prevCamera.x| > frustumWidth * 0.5`
- `resize()` changes frustum aspect ratio
- First frame after pause/resume

### Conservative `visible = true` Edge Case

A static entity at the frustum edge with slow camera pan may stay marked visible for a few frames after leaving the frustum. This wastes a draw call (entity is rendered but clipped), not a correctness bug. Self-corrects when camera exceeds the invalidation threshold. For a 2D engine culling thousands of entities, the impact of a few extra quads is immeasurable.

### Buffer Management

- Two visibility buffers: `visibility-a`, `visibility-b` in ResourcePool
- Ping-pong: swap references after each frame (not data copy)
- `visibility-curr` cleared to 0 at frame start via `encoder.clearBuffer()`
- Dirty bits: `writeBuffer` per frame, 12.5KB for 100k entities

### Tick Loop Ordering Invariant

```
render_state.collect_gpu() -> upload SoA buffers -> upload dirty bits -> DirtyTracker.clear() -> cull dispatch
```

`DirtyTracker.clear()` MUST happen AFTER dirty bits upload to GPU. If clear happens before upload, the cull shader sees everything as "clean" and skips too aggressively.

### Bind Group: Separate from ForwardPass

Visibility and dirty buffers go in a CullPass-specific bind group (not group 0). ForwardPass does not declare them. The RenderGraph already supports per-pass bind groups.

### Metrics

| Scenario | Entities on fast path | Effective cull savings |
|----------|----------------------|----------------------|
| Static camera, static scene | ~99.9% | ~50% |
| Smooth camera pan, 10% moving entities | ~85% | ~40% |
| Camera teleport | 0% (full invalidation) | 0% (no regression) |

---

## 7. #12 Sized Binding Arrays (Stub)

### Status (March 2026)

- W3C proposal: active, no browser implementation
- Chrome Platform Status: https://chromestatus.com/feature/6213121689518080
- Spec proposal: https://github.com/gpuweb/gpuweb/blob/main/proposals/sized-binding-arrays.md

### Deliverables

1. **Detection stub** in `capabilities.ts`:

```typescript
export function detectSizedBindingArrays(device: GPUDevice): boolean {
    // Sized binding arrays (W3C proposal, not yet shipped)
    // When available, detection will likely be via:
    //   adapter.features.has('sized-binding-arrays')  -- if feature-gated
    //   OR: try createBindGroupLayout with bindingArraySize, catch -- if limit-based
    //
    // See: gpuweb/proposals/sized-binding-arrays.md
    // Hyperion tracking: hyperion-2026-tech-integration-design.md section 4
    return false;
}
```

2. **Status note** referencing existing design doc (`hyperion-2026-tech-integration-design.md` sections 4.1-4.7) which already covers the full migration path: current tier system, future sized binding arrays, bind group layout, WGSL changes, feature detection, and fallback.

3. **Quarterly check cadence**: Monitor Chrome Canary flags for experimental support.

### Migration Summary (When Available)

- `TextureManager`: replace tier logic with flat slot allocator
- `ForwardPass` bind group: replace 8 texture + sampler bindings with 1 binding array + 1 sampler
- WGSL: replace `switch(tierIndex)` with direct `textures[texIndex]` array access
- Runtime: `detectSizedBindingArrays()` chooses path, tier system as fallback

### Effort When Available

3-5 days. Risk: dual-path testing requires `--force-tier-fallback` flag since sized binding arrays can't be tested in CI until browsers ship.

---

## 8. #10 Texture Streaming (HTTP Range Progressive KTX2)

### Goal

Eliminate startup stutter for texture-heavy scenes via progressive KTX2 loading with HTTP Range requests.

### Prerequisite: Mipmap Support in TextureManager

The current `TextureManager` creates `Texture2DArray` with `mipLevelCount: 1`. Progressive loading requires mipmaps. This is a 2-3 day sub-task:
- Create tiers with appropriate `mipLevelCount` based on tier size
- Tier resize (lazy growth) must copy all mip levels per layer
- Sampler change: `mipmapFilter: 'linear'`
- ForwardPass bind group updated for new sampler config

### Three-Phase Fetch

KTX2 with supercompression (Zstandard, default for UASTC in toktx/basisu) requires the supercompression global data (SGD) section before any mip can be decoded.

```
Phase 1: Fetch bytes 0-255, parse header + level index
Phase 2: If supercompressionScheme > 0:
           Read sgdByteOffset + sgdByteLength from header
           Fetch Range sgdOffset to sgdOffset+sgdByteLength
           Cache SGD for all subsequent mip decodes
Phase 3: Fetch smallest mip -> transcode with SGD (if needed) -> upload
         Subsequent frames: fetch progressively larger mips
```

For files without supercompression (scheme == 0): Phase 2 is skipped. For BasisLZ (scheme == 1): SGD is mandatory, typically 1-10KB.

### Per-Level Basis Transcoding

The Basis Universal transcoder C API supports `transcodeImage(imageIndex, levelIndex, format)`. Verify that the existing WASM wrapper (`ktx2-parser.ts`) exposes per-level granularity. If it only wraps full-file `transcode()`, the interface needs refactoring to support `transcodeImage(0, mipLevel, targetFormat)` per mip level.

### Bandwidth Budget

Configurable `streamingBudgetBytesPerFrame` (default: 500KB/frame at 60fps = ~30MB/s). Prevents fetch storms.

The `StreamingScheduler` processes textures in `TexturePriorityQueue` order:
1. If no header: fetch header (Phase 1)
2. If header but no SGD (and supercompression > 0): fetch SGD (Phase 2)
3. If ready but no data: fetch smallest mip, upload placeholder
4. If partial mips: fetch next larger mip, upload
5. If fully loaded: skip

Budget exhausted -> stop until next frame.

### New Modules

**`KTX2StreamLoader`** (`ts/src/ktx2-stream-loader.ts`):
- `fetchHeader(url): Promise<KTX2Header>`
- `fetchMipLevel(url, header, level): Promise<ArrayBuffer>`
- `isRangeSupported(url): Promise<boolean>` (HEAD request)

**`StreamingScheduler`** (`ts/src/texture-streaming.ts`):
- Wraps `TexturePriorityQueue`
- `tick(budgetBytes)` called once per frame from `GameLoop`
- Tracks per-texture state: header-only / sgd-loaded / partial-mips / complete

### Server Requirements & Fallback

HTTP Range requires: `Accept-Ranges: bytes` header, correct `Range: bytes=start-end` handling, CORS allows `Range` header.

**Fallback**: If server returns 200 instead of 206, or lacks `Accept-Ranges`, fall back to full-file fetch. Streaming degrades gracefully to current behavior.

### TS-Side API

```typescript
const engine = await Hyperion.create({
    textureStreaming: true,
    streamingBudgetBytesPerFrame: 500_000,  // optional
});
```

No changes to `loadTexture()` / `loadTextures()` signatures.

### Out of Scope

- **VRAM eviction** (textures off-frustum unloaded after timeout) — requires reference counting on tier layers and compaction. Deferred to post-Phase 13.

### Testing

- `ktx2-stream-loader.test.ts` — mock fetch, Range detection, header parse, mip fetch
- `texture-streaming.test.ts` — scheduler budget, priority ordering, fallback, SGD handling
- Manual visual: load 50+ KTX2 textures, observe progressive refinement

### Risk

- CORS + Range may not work on all CDNs (Cloudflare/S3 support it; custom servers may not). Fallback essential.
- BasisTranscoder per-level interface may need refactoring.
- Mipmap prerequisite adds 2-3 days to the timeline.

---

## 9. #15 Time-Travel Debug Integration

### Goal

Zero runtime cost of debug/replay infrastructure in production builds via three independent layers of elimination.

### Layer 1: Rust `dev-tools` Feature

`#[cfg(feature = "dev-tools")]` already gates snapshot exports, TLV debug exports, and debug-only code. Phase 13 adds an **explicit audit task**:

- **Migrate any `#[cfg(debug_assertions)]` to `#[cfg(feature = "dev-tools")]`**. These have different semantics: `debug_assertions` is profile-dependent (off in `--release`), `dev-tools` is an explicit feature flag (can be enabled in release builds for "developer edition" distributions).
- Verify: snapshot binary serialization, debug-only `Engine` fields, debug-only branches in `process_commands` are all behind `dev-tools`.
- Verify: `build:wasm:release` does NOT include `--features dev-tools`.

### Layer 2: TS `__DEV__` Compile-Time Constant

New in `vite.config.ts`:
```typescript
define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
}
```

New in `ts/src/vite-env.d.ts`:
```typescript
declare const __DEV__: boolean;
```

Files requiring `__DEV__` guards:
- `replay/command-tape.ts`, `replay/replay-player.ts`, `replay/snapshot-manager.ts`
- `debug/ecs-inspector.ts`, `debug/debug-camera.ts`, `debug/bounds-visualizer.ts`, `debug/tlv-parser.ts`
- `hyperion.ts` — `Hyperion.debug` API

### Tape Recorder Tap Point: No Debug Import in Core

The `CommandTapeRecorder` tap point lives in `backpressure.ts` (core module). To prevent static import dependency on the replay module:

```typescript
// backpressure.ts -- core module, zero debug imports
private _debugTapeRecorder: unknown = null;

setDebugTapeRecorder(recorder: unknown): void {
    this._debugTapeRecorder = recorder;
}

flush(): FlushStats {
    // ...
    if (__DEV__ && this._debugTapeRecorder) {
        (this._debugTapeRecorder as { record(tick: number, data: Uint8Array): void })
            .record(tick, rawBytes);
    }
}
```

Type is `unknown`, not `CommandTapeRecorder`. Duck typing behind `__DEV__` prevents the bundler from including the replay module in production builds.

### Layer 3: Tree-Shakeable Module Structure

Debug modules are in separate files (`ts/src/replay/`, `ts/src/debug/`). Requirements:
- No unconditional import from core modules (`hyperion.ts` must NOT import replay/debug at top level)
- `Hyperion.debug` getter guarded by `__DEV__`, returns `null` in prod
- No side-effect imports that prevent tree-shaking
- `@hyperion-plugin/replay`, `@hyperion-plugin/debug-camera`, `@hyperion-plugin/devtools`: `sideEffects: false` in `package.json`

### CI Verification

Production bundle grep check (all must return 0 matches):
- `CommandTapeRecorder`
- `ReplayPlayer`
- `SnapshotManager`
- `debug_query_entity`
- `debug_dump_scene_tree`
- `__DEV__` literal (should be replaced by `false` and eliminated)

### Testing

- `wasm-objdump` or binary size diff on `build:wasm:release` to verify no snapshot/debug symbols
- `npm run build && grep -c "pattern" dist/*.js` for each pattern above
- Existing tests run in dev mode (`__DEV__ = true`) — no test changes needed

### Risk

- `__DEV__` is a new convention — document in CLAUDE.md
- If a future contributor adds unconditional import of debug module in `hyperion.ts`, tree-shaking breaks silently. CI grep catches this.

---

## 10. Success Metrics

| Metric | Canvas (10k) | Game (100k) |
|--------|-------------|-------------|
| Frame time | <=3ms | <=5ms |
| Max entities @60fps | -- | >=280k |
| Ring buffer cmds/frame | <=0.6x baseline | <=0.6x baseline |
| Cull cost (static camera) | <=50% baseline | <=50% baseline |
| Prod bundle debug symbols | 0 | 0 |
| WASM prod binary debug symbols | 0 | 0 |

Baseline = `build:wasm:release` + production Vite build with Tier 1+2 optimizations active.
