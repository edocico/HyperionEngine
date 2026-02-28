# Phase 12 — Optimization Tier 2: Design Document

> **Date**: 28 February 2026
> **Status**: Approved
> **Prerequisite**: Phase 11 (Optimization Tier 1) complete
> **Implementation order**: #1 → #4 → #2 → #3 → #5

---

## Overview

Five optimizations targeting GPU upload bandwidth, mass spawn throughput, and asset loading latency. The foundational change is transitioning `RenderState` from immediate-mode (full re-upload every frame) to retained-mode (stable slots + dirty tracking + GPU scatter).

### Impact Summary

| # | Optimization | Approach | Impact | Effort |
|---|---|---|---|---|
| 1 | Scatter upload | DirtyTracker + GPU compute scatter | 10–20× sparse updates | 1 week |
| 2 | Compressed transforms | 32B compressed in staging, reconstruct in scatter shader | –33% upload bandwidth | 1 week |
| 3 | Material sort keys | 2-bucket split (tier0 vs other) in cull shader | –10–30% fragment divergence | 3–5 days |
| 4 | Batch spawn | Auto-detection in Rust, hecs `spawn_batch()` | 10–100× mass spawn | 2–3 days |
| 5 | Texture streaming | Priority queue + progressive KTX2 | Eliminate startup stutter | 1 week |

---

## 1. GPU Compute Scatter Upload

### Problem

`collect_gpu()` clears and repopulates all 6 SoA buffers every frame:

```
transforms (64B/entity) + bounds (16B) + render_meta (8B) +
tex_indices (4B) + prim_params (32B) + entity_ids (4B) = 128 bytes/entity

At 10k entities: 1.28 MB/frame × 60fps = ~77 MB/s wasted bandwidth
```

In a typical canvas scene, <5% of entities move per frame.

### Prerequisite: Stable Slot Mapping

The current `collect_gpu()` iterates hecs in non-deterministic order — entity GPU indices are unstable across frames. DirtyTracker bits would refer to different entities each frame. **Stable slots are a hard prerequisite.**

New fields in `RenderState`:

```rust
slot_to_entity: Vec<Entity>,   // slot → hecs Entity
entity_to_slot: Vec<u32>,      // entity.id() → slot (u32::MAX = unassigned)
pending_despawns: Vec<Entity>,  // collected by process_commands, consumed by collect_gpu_dirty
entity_count: u32,              // always == number of live slots (no gaps)
```

`entity_to_slot` uses `Vec<u32>` indexed by `entity.id()` — O(1) lookup, zero hashing, 400KB at 100k entities. Sentinel `u32::MAX` for unassigned.

### Dirty Marking Points

| Mutation point | Dirty set | Why |
|---|---|---|
| `process_commands` — SetPosition/SetRotation/SetScale | transforms + bounds | Position and bounding change |
| `process_commands` — SetTextureLayer/SetMeshHandle/SetRenderPrimitive | meta | Render metadata only |
| `process_commands` — SetPrimParams0/1 | meta | Primitive parameters |
| `process_commands` — SpawnEntity | all | New entity = everything dirty |
| `velocity_system()` | transforms + bounds | Movement from velocity |
| `propagate_transforms()` — child of dirty parent | transforms + bounds | Hierarchical propagation |

`entity_ids` is write-once at spawn — no dirty tracking needed.

**DirtyTracker**: Keep the existing per-buffer `BitSet` (transforms, bounds, meta) for profiling granularity. Union all BitSets for the scatter decision and threshold calculation. Physical scatter is a single unified dispatch.

### Batch Despawn with Swap-Remove

Despawned entities leave "ghost data" in GPU buffers. Swap-remove maintains compact buffers (zero gaps = zero wasted cull shader threads).

**Timing**: `process_commands()` collects despawns in `pending_despawns`. `collect_gpu_dirty()` processes them in batch before writing dirty data. This maintains clean separation: hecs world is the simulation source of truth, SoA buffers are a read-only GPU projection synchronized at one precise point per frame.

**Descending slot order invariant**: Process despawn slots from highest to lowest. This guarantees `last = entity_count - 1` always points to a live entity — no need to check if the swap source is also pending despawn.

```rust
fn flush_pending_despawns(&mut self) {
    if self.pending_despawns.is_empty() { return; }

    // Collect valid slot indices
    let mut despawn_slots: Vec<u32> = self.pending_despawns.drain(..)
        .filter_map(|e| {
            let slot = self.entity_to_slot[e.id() as usize];
            if slot != u32::MAX { Some(slot) } else { None }
        })
        .collect();

    // Descending order: last always points to a live entity
    despawn_slots.sort_unstable_by(|a, b| b.cmp(a));

    for slot in despawn_slots {
        let last = self.entity_count - 1;
        let dead_entity = self.slot_to_entity[slot as usize];

        if slot != last {
            // Swap-remove: copy SoA data from last → slot
            self.copy_soa_slot(last, slot);

            let moved_entity = self.slot_to_entity[last as usize];
            self.slot_to_entity[slot as usize] = moved_entity;
            self.entity_to_slot[moved_entity.id() as usize] = slot;

            self.dirty.mark_all(slot); // slot has new data
        }

        self.entity_to_slot[dead_entity.id() as usize] = u32::MAX;
        self.entity_count -= 1;
    }
    // Dirty bits beyond entity_count are harmless — never read
}
```

### Scatter Strategy

**Decision**: GPU compute scatter (Strategy B). CPU compacts dirty data into a contiguous staging buffer, uploads with 2 `writeBuffer` calls (staging + indices), GPU compute scatters to correct SoA offsets in parallel.

**Why not CPU scatter (Strategy A)**: N×6 `writeBuffer` calls for sparse entities — can be worse than full upload.
**Why not mapAsync (Strategy C)**: 1-frame latency unacceptable for interactive canvas (drag latency must be <33ms).

**Threshold**: Fixed at 0.3 with `HyperionConfig.scatterThreshold` override. Adaptive calibration rejected — the first 2 seconds are critical for first impression, and alternating strategies during warm-up introduces visible jitter.

### Staging Buffer Layout

128 bytes (32 u32) per dirty entity, cache-line aligned:

```
Offset  Field            Size     Note
────────────────────────────────────────
 0..15  transforms       64B      mat4x4 column-major (or compressed, see §2)
16..19  bounds            16B     xyz position + radius
20..21  render_meta        8B     meshHandle + primitiveType
22      tex_indices        4B     packed tier/layer/overflow
23..30  prim_params       32B     primitive-specific parameters
31      _pad               4B     cache-line alignment
────────────────────────────────────────
Total: 32 u32 = 128 bytes = 1 GPU cache line
```

### WGSL Scatter Shader

```wgsl
// scatter.wgsl

struct ScatterUniforms {
    dirty_count: u32,
}

// @group(0): source data
@group(0) @binding(0) var<uniform> uniforms: ScatterUniforms;
@group(0) @binding(1) var<storage, read> staging: array<u32>;
@group(0) @binding(2) var<storage, read> dirty_indices: array<u32>;

// @group(1): destination SoA buffers (shared layout with CullPass)
@group(1) @binding(0) var<storage, read_write> transforms: array<u32>;
@group(1) @binding(1) var<storage, read_write> bounds: array<u32>;
@group(1) @binding(2) var<storage, read_write> render_meta: array<u32>;
@group(1) @binding(3) var<storage, read_write> tex_indices: array<u32>;
@group(1) @binding(4) var<storage, read_write> prim_params: array<u32>;

const STAGING_STRIDE: u32 = 32u;

@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= uniforms.dirty_count) { return; }

    let dst = dirty_indices[i];
    let src = i * STAGING_STRIDE;

    // Transforms: 16 u32
    let t = dst * 16u;
    for (var j = 0u; j < 16u; j++) {
        transforms[t + j] = staging[src + j];
    }

    // Bounds: 4 u32
    let b = dst * 4u;
    for (var j = 0u; j < 4u; j++) {
        bounds[b + j] = staging[src + 16u + j];
    }

    // RenderMeta: 2 u32
    let m = dst * 2u;
    render_meta[m]      = staging[src + 20u];
    render_meta[m + 1u] = staging[src + 21u];

    // TexIndices: 1 u32
    tex_indices[dst] = staging[src + 22u];

    // PrimParams: 8 u32
    let p = dst * 8u;
    for (var j = 0u; j < 8u; j++) {
        prim_params[p + j] = staging[src + 23u + j];
    }
}
```

**Binding count**: @group(0) has 1 uniform + 2 storage = 3 bindings. @group(1) has 5 storage = 5 bindings. Total 7 storage buffers, well under `maxStorageBuffersPerShaderStage` minimum (8). Two bind groups leaves room for future buffers.

**Future optimization**: Replace `array<u32>` with `array<vec4<u32>>` for vectorized 128-bit load/store. Improves codegen on mobile GPUs (Mali). Not blocking for initial implementation.

### Pipeline Integration

```
Frame timeline:

1. CPU: process_commands + velocity_system + transform_system + propagate_transforms
2. CPU: collect_gpu_dirty → staging buffer + dirty_indices + dirty_count
3. CPU → GPU:
   IF dirty_ratio ≤ 0.3:
     writeBuffer(staging, dirty_count × 128B)
     writeBuffer(dirty_indices, dirty_count × 4B)
     writeBuffer(uniforms, { dirty_count })
     GPU Compute: ScatterPass — dispatch(ceil(dirty_count / 64), 1, 1)
   ELSE (fallback):
     writeBuffer(transforms, entity_count × 64B)
     writeBuffer(bounds, entity_count × 16B)
     writeBuffer(render_meta, entity_count × 8B)
     writeBuffer(tex_indices, entity_count × 4B)
     writeBuffer(prim_params, entity_count × 32B)
4. GPU Compute: CullPass (reads updated SoA)
5. GPU Render: ForwardPass + post-processing
```

**Ordering guarantee**: ScatterPass and CullPass are encoded as separate compute passes (begin/end) in the same `GPUCommandEncoder`. Per WebGPU spec §21.1 "Command Encoding", passes within a command buffer execute sequentially. This guarantees ScatterPass completes before CullPass reads the SoA buffers. No explicit barriers required.

### GPU Buffer Changes

The 5 destination SoA buffers already exist with `GPUBufferUsage.STORAGE`. The scatter shader binds them as `read_write` — this is a binding-level declaration, not a buffer-level flag change. New bind group for ScatterPass references the same buffers.

Two new GPU buffers:
- `scatter-staging`: `STORAGE | COPY_DST`, pre-allocated for max dirty count
- `scatter-indices`: `STORAGE | COPY_DST`, pre-allocated for max dirty count

---

## 2. Compressed 2D Transforms

### Problem

Full mat4x4 (64 bytes) for entities that are 2D: position + Z rotation + scale. 50% of the transform data is constant zeros.

### Compressed Representation

8 f32 = 32 bytes:

```
Offset  Field         Type    Note
────────────────────────────────────
0       position.x    f32     world X
1       position.y    f32     world Y
2       position.z    f32     z-layer (depth sorting)
3       rotation      f32     angle in radians (around Z)
4       scale.x       f32
5       scale.y       f32
6       _reserved     f32     (future: skew, anchor)
7       _reserved     f32
────────────────────────────────────
```

### Approach: Reconstruct in Scatter Shader

The scatter shader receives compressed data and writes full mat4x4 to the `transforms` buffer. Consumer shaders (cull, forward, all 6 primitive types) are **unchanged** — they read mat4x4 as today.

Rationale: the scatter shader is memory-bound (writing 128B per entity). The mat4x4 reconstruction is ~15 ALU ops — effectively free because ALU is idle waiting for memory writes.

### Root vs Child Entity Handling

Entities with a `Parent` component receive their mat4x4 from `propagate_transforms()` (LocalMatrix × ParentModelMatrix). These cannot use compressed representation — they already have a pre-computed mat4x4.

**Solution**: A format flag bit in the staging data distinguishes compressed vs pre-computed. The flag lives in the `_pad` field at staging offset 31:

```
staging[src + 31] == 0  →  slots 0..15 contain compressed (8 f32 + 24 padding)
staging[src + 31] == 1  →  slots 0..15 contain full mat4x4 (16 f32)
```

The scatter shader branches on this flag:

```wgsl
let format = staging[src + 31u];
if (format == 0u) {
    // Compressed: reconstruct mat4x4
    let px = bitcast<f32>(staging[src]);
    let py = bitcast<f32>(staging[src + 1u]);
    let pz = bitcast<f32>(staging[src + 2u]);
    let angle = bitcast<f32>(staging[src + 3u]);
    let sx = bitcast<f32>(staging[src + 4u]);
    let sy = bitcast<f32>(staging[src + 5u]);

    let c = cos(angle);
    let s = sin(angle);

    // Column-major: rotation(Z) × scale, then translate
    transforms[t]      = bitcast<u32>(sx * c);    // [0][0]
    transforms[t + 1u] = bitcast<u32>(sx * s);    // [1][0]
    transforms[t + 2u] = 0u;                       // [2][0]
    transforms[t + 3u] = 0u;                       // [3][0]
    transforms[t + 4u] = bitcast<u32>(-sy * s);   // [0][1]
    transforms[t + 5u] = bitcast<u32>(sy * c);    // [1][1]
    transforms[t + 6u] = 0u;                       // [2][1]
    transforms[t + 7u] = 0u;                       // [3][1]
    transforms[t + 8u]  = 0u;
    transforms[t + 9u]  = 0u;
    transforms[t + 10u] = bitcast<u32>(1.0);       // [2][2]
    transforms[t + 11u] = 0u;
    transforms[t + 12u] = bitcast<u32>(px);        // [3][0] translation
    transforms[t + 13u] = bitcast<u32>(py);        // [3][1]
    transforms[t + 14u] = bitcast<u32>(pz);        // [3][2]
    transforms[t + 15u] = bitcast<u32>(1.0);       // [3][3]
} else {
    // Pre-computed mat4x4: copy directly
    for (var j = 0u; j < 16u; j++) {
        transforms[t + j] = staging[src + j];
    }
}
```

### Staging Buffer: Maintained at 128B

The stride stays at 128 bytes (32 u32) regardless of compression. Compressed entities use only 8 of the 16 transform slots — the remaining 8 are padding (zero cost in practice, already allocated). This preserves the cache-line alignment from §1 and avoids divergent stride computation in the shader.

### Bandwidth Impact

- Staging upload: –33% for the transform portion (compressed entities upload 32B of meaningful data vs 64B, though the staging stride stays 128B for alignment — the real saving comes from Rust writing fewer bytes to the staging buffer region for compressed entities)
- GPU memory: unchanged (transforms buffer stays mat4x4)

### Full Upload Fallback (dirty_ratio > 0.3)

Rust expands compressed transforms to mat4x4 on CPU side (as today). The full `writeBuffer` path writes mat4x4 directly — no branching in hot path.

---

## 3. Material Sort Keys (2-Bucket)

### Problem

Within each primitive type, visible entity indices in the `visible-indices` buffer are unordered (depends on cull shader thread scheduling). The fragment shader `switch(tierIdx)` causes warp divergence when adjacent threads access different texture tiers.

### Approach: 2-Bucket Split (tier0 vs other)

The vast majority of entities (>90%) use tier 0 (the primary compressed tier). Create two pipeline variants per primitive type:
- **Pipeline A**: `tier0` hardcoded — zero switch, zero divergence
- **Pipeline B**: dynamic tier switch — as today, for minority entities

The cull shader buckets visible indices into two regions per primitive type:

```
visible-indices layout:
  [Quad-tier0 | Quad-other | Line-tier0 | Line-other | ...]
```

Indirect draw args: 12 total (6 types × 2 buckets × 20 bytes = 240 bytes).

### Pipeline Count

6 primitive types × 2 variants = 12 `GPURenderPipeline` objects.

**Critical**: Pre-compile all 12 pipelines during `createRenderer()` init, not lazily. WebGPU pipeline compilation (especially on Chrome/Dawn) is async and causes stutter on first use. Pre-compilation eliminates this.

### Cull Shader Changes

The cull shader already maintains per-type atomic counters. Extend to per-type × 2-bucket:

```wgsl
// 12 atomic counters: type * 2 + bucket
var<workgroup> counters: array<atomic<u32>, 12>;

// In cull body:
let bucket = select(1u, 0u, tierIdx == 0u);  // 0 = tier0, 1 = other
let counterIdx = primType * 2u + bucket;
let slot = atomicAdd(&counters[counterIdx], 1u);
let offset = (primType * 2u + bucket) * maxEntitiesPerBucket;
visibleIndices[offset + slot] = entityIdx;
```

### Implementation Priority

**Measure before implementing.** If GPU profiling doesn't show significant fragment divergence, this optimization is premature. Implement after #1, #2, #4, only if profiler data justifies it.

---

## 4. Batch Spawn (Auto-Detection)

### Problem

Spawning 1000 entities = 1000 individual `world.spawn()` calls with archetype resize checks at each insertion. hecs `spawn_batch()` pre-allocates once for the entire batch.

### Approach: Zero Protocol Change

Detect consecutive `SpawnEntity` commands in `process_commands()` automatically. No ring buffer format changes. TS side unchanged.

```rust
fn process_commands(&mut self, ring: &mut RingBufferConsumer) {
    let commands = ring.drain();
    let mut spawn_batch: Vec<u32> = Vec::new(); // external IDs

    for cmd in commands {
        match cmd.cmd_type {
            CommandType::SpawnEntity => {
                spawn_batch.push(cmd.entity_id);
            }
            other => {
                if !spawn_batch.is_empty() {
                    self.flush_spawn_batch(&mut spawn_batch);
                }
                self.process_single(other, cmd);
            }
        }
    }
    if !spawn_batch.is_empty() {
        self.flush_spawn_batch(&mut spawn_batch);
    }
}

fn flush_spawn_batch(&mut self, batch: &mut Vec<u32>) {
    // hecs batch: single archetype resize
    let entities: Vec<Entity> = self.world.spawn_batch(
        batch.iter().map(|_| default_component_bundle())
    ).collect();

    for (i, entity) in entities.iter().enumerate() {
        self.entity_map.insert(batch[i], *entity);
        self.render_state.assign_slot(*entity);
    }
    batch.clear();
}
```

### Archetype Constraint

`world.spawn_batch()` in hecs requires all entities in the batch to have the **same archetype** (identical component set). In Hyperion, all entities are spawned with the same default bundle (Position, Rotation, Scale, Velocity, ModelMatrix, BoundingRadius, TextureLayerIndex, MeshHandle, RenderPrimitive, PrimitiveParams, ExternalId, Active). Components are then modified via subsequent ring buffer commands (SetPosition, SetTextureLayer, etc.).

**Verification needed during implementation**: Confirm that `SpawnEntity` in `process_commands()` always spawns the same component bundle. If any spawn path adds optional components conditionally, the batch must be partitioned by archetype.

### BackpressuredProducer Synergy

When the ring buffer fills up, `BackpressuredProducer` queues critical commands (spawn/despawn) in a FIFO list and flushes them together at the start of the next tick. This naturally creates batches of consecutive SpawnEntity commands — the auto-detection captures these for free.

### Optional TS-Side Enhancement

A `Hyperion.spawnBatch(count)` method that writes N consecutive SpawnEntity commands guarantees they arrive contiguous to Rust. Not strictly necessary if auto-detection works, but useful as explicit API for "load scene with 5000 entities" use cases.

---

## 5. Texture Streaming (Priority Queue + Progressive KTX2)

### Problem

Loading is all-or-nothing, FIFO ordered. 50 textures to load → the texture visible at screen center waits behind 49 off-screen textures.

### Priority Queue

Replace FIFO `pendingQueue` with a min-heap ordered by viewport-based priority:

```typescript
interface TextureLoadRequest {
    url: string;
    priority: number;        // lower = load first
    tierIndex: number;
    callback: (handle: TextureHandle) => void;
}

class TextureManager {
    private pendingQueue: PriorityQueue<TextureLoadRequest>;

    updatePriorities(frustumPlanes: Float32Array, cameraPos: [number, number]) {
        for (const req of this.pendingQueue) {
            req.priority = this.computePriority(req, frustumPlanes, cameraPos);
        }
        this.pendingQueue.reheap();
    }

    private computePriority(
        req: TextureLoadRequest,
        frustum: Float32Array,
        cam: [number, number]
    ): number {
        // In-frustum entities: distance from camera center
        // Out-of-frustum entities: distance + 10000 penalty
        // Already referenced by visible entities: –1000 bonus
    }
}
```

**Reheap frequency**: Only when camera moves significantly (delta > threshold), NOT every frame. With 500 pending textures, `reheap()` is O(n log n) ≈ 4500 comparisons — acceptable but wasteful if camera is stationary.

### Progressive KTX2 Loading

KTX2 files with mipmaps store levels from largest (level 0) to smallest (level N-1). Load the smallest mip first as a placeholder:

```
Phase 1: Parse KTX2 header → seek to level N-1 → load 4×4 mip (~64 bytes)
          Upload as placeholder → entity visible immediately (blurry)
Phase 2: Load level 0 (full resolution) → swap into same texture layer
          Entity upgrades to full quality
```

### HTTP Range Request Caveat

Progressive loading requires reading specific byte ranges from the KTX2 file. This relies on server support for `Accept-Ranges: bytes`:
- **CDNs** (CloudFront, Cloudflare, Vercel): generally supported
- **Arbitrary hosting**: not guaranteed

**Fallback**: If range requests fail (HTTP 200 instead of 206, or CORS error), fall back to full-file loading as today. The progressive path is an optimization, not a requirement.

### Implementation

- Replace `Array`-based queue with binary heap (`PriorityQueue<TextureLoadRequest>`)
- Add `updatePriorities()` call in `tick()`, gated by camera movement threshold
- Modify KTX2 load path: first load small mip, then queue full resolution
- Existing concurrent fetch limit (MAX_CONCURRENT_FETCHES = 6) unchanged
- `onProgress` callback already exists for UI feedback

---

## Frame Flow Summary (Post-Tier 2)

```
1. process_commands(ring_buffer)
   - SpawnEntity → world.spawn() / batch detect + assign_slot() + dirty.mark_all()
   - DespawnEntity → world.despawn() + pending_despawns.push()
   - SetPosition/etc → world.get_mut() + dirty.mark_transform(slot)

2. velocity_system(dt) — dirty.mark_transform(slot) for moved entities

3. transform_system() — rebuild ModelMatrix only for dirty entities

4. propagate_transforms() — dirty parent → mark children dirty

5. collect_gpu_dirty()
   a. flush_pending_despawns() — batch swap-remove, descending slot order
   b. Compact dirty entities into staging buffer (compressed or mat4x4)
   c. Generate dirty_indices list
   d. If dirty_ratio > 0.3 → fallback: full buffer export
   e. Export: staging_data, dirty_indices, dirty_count
   f. Reset dirty bits

6. [TS] Upload to GPU
   IF scatter path:
     writeBuffer(staging) + writeBuffer(dirty_indices) + writeBuffer(uniforms)
     Compute: ScatterPass — scatter + reconstruct compressed transforms
   ELSE full path:
     writeBuffer × 5 (transforms, bounds, render_meta, tex_indices, prim_params)

7. [GPU] Compute: CullPass (2-bucket: tier0 vs other)

8. [GPU] Render: ForwardPass (12 pipelines: 6 types × 2 buckets) + post-processing

9. [Background] TextureManager: priority-queue drain, progressive KTX2
```

---

## Implementation Order

**#1 Scatter Upload → #4 Batch Spawn → #2 Compressed Transforms → #3 Material Sort → #5 Texture Streaming**

Rationale:
- **#1 first**: Foundational architectural change (immediate → retained mode). All other optimizations have reduced impact without it.
- **#4 second**: Near-zero effort, immediately enables "load scene with thousands of entities" use case.
- **#2 third**: Builds on #1 (modifies the scatter shader). Cannot be implemented without stable slots.
- **#3 fourth**: Measure with profiler before implementing. Only justified if fragment divergence is measurable.
- **#5 fifth**: Independent from the others. Impact depends on asset loading patterns of the target application.

---

## Test Strategy

### Rust Tests (hyperion-core)

- `render_state::tests::stable_slot_assignment` — spawn entities, verify slot indices
- `render_state::tests::swap_remove_single` — despawn middle entity, verify swap
- `render_state::tests::swap_remove_batch_descending` — batch despawn, verify descending invariant
- `render_state::tests::swap_remove_last_slot` — despawn last entity, verify shrink-only
- `render_state::tests::dirty_tracker_marking` — verify mark/reset/ratio
- `render_state::tests::collect_gpu_dirty_partial` — dirty_ratio < 0.3 → staging output
- `render_state::tests::collect_gpu_dirty_full_fallback` — dirty_ratio > 0.3 → full output
- `render_state::tests::compressed_transform_reconstruction` — verify mat4x4 matches for pos+rot+scale
- `command_processor::tests::batch_spawn_detection` — consecutive spawns → single hecs batch
- `command_processor::tests::batch_spawn_interrupted` — spawn-move-spawn → two batches

### TypeScript Tests

- `scatter-pass.test.ts` — ScatterPass dispatch, staging buffer layout, bind group creation
- `render-state-slots.test.ts` — slot assignment, swap-remove, entity_to_slot mapping
- `texture-manager-priority.test.ts` — priority queue ordering, reheap on camera move
- `cull-pass-2bucket.test.ts` — 2-bucket visible index output, draw arg counts

---

## Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| `maxStorageBuffersPerShaderStage` hit on edge devices | Low | High | 2-bind-group layout keeps scatter at 7 total |
| hecs `spawn_batch` requires same archetype | Low | Medium | Verify during #4 implementation; fallback to individual spawn |
| Compressed transform branching causes scatter divergence | Medium | Low | Branch is uniform per-entity (root vs child); not per-thread divergent |
| Progressive KTX2 fails without range request support | Medium | Low | Graceful fallback to full-file loading |
| Material sort 2-bucket adds complexity without measurable gain | Medium | Medium | Measure first (#3 is last in implementation order) |
