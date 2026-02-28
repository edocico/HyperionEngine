# Phase 12 — Optimization Tier 2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transition RenderState from immediate-mode to retained-mode with GPU compute scatter, add batch spawn, compressed transforms, material sort, and texture streaming.

**Architecture:** Stable slot mapping in Rust enables DirtyTracker-based partial GPU upload. A WGSL compute scatter shader writes dirty entity data to SoA buffers. Batch spawn auto-detection, compressed 2D transforms, 2-bucket material sort, and priority-based texture streaming complete Tier 2.

**Tech Stack:** Rust (hecs, bytemuck, glam), WGSL compute shaders, TypeScript (WebGPU), vitest

**Design doc:** `docs/plans/2026-02-28-phase12-optimization-tier2-design.md`

**Implementation order:** #1 Scatter Upload → #4 Batch Spawn → #2 Compressed Transforms → #3 Material Sort → #5 Texture Streaming

---

## Optimization #1: GPU Compute Scatter Upload

### Task 1: Add stable slot mapping fields to RenderState

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs:170-186`

**Step 1: Add new fields to RenderState struct**

Add after line 185 (`pub dirty_tracker: DirtyTracker`):

```rust
pub struct RenderState {
    // ... existing fields (lines 173-185) ...

    // Stable slot mapping (new)
    slot_to_entity: Vec<hecs::Entity>,
    entity_to_slot: Vec<u32>,         // indexed by entity.id(), u32::MAX = unassigned
    pending_despawns: Vec<hecs::Entity>,
}
```

**Step 2: Update `new()` (line 189)**

Add to the constructor:

```rust
slot_to_entity: Vec::new(),
entity_to_slot: Vec::new(),
pending_despawns: Vec::new(),
```

**Step 3: Run tests**

Run: `cargo test -p hyperion-core render_state`
Expected: All 27 existing tests PASS (no behavior change)

**Step 4: Commit**

```bash
git add crates/hyperion-core/src/render_state.rs
git commit -m "refactor: add stable slot mapping fields to RenderState"
```

---

### Task 2: Implement assign_slot and slot accessors

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs`
- Test: inline `#[cfg(test)] mod tests`

**Step 1: Write failing tests**

Add to the test module (after existing tests):

```rust
#[test]
fn assign_slot_returns_sequential_indices() {
    let mut rs = RenderState::new();
    let mut world = World::new();
    let e0 = world.spawn((Position::default(), Active));
    let e1 = world.spawn((Position::default(), Active));
    assert_eq!(rs.assign_slot(e0), 0);
    assert_eq!(rs.assign_slot(e1), 1);
    assert_eq!(rs.gpu_entity_count(), 2);
}

#[test]
fn entity_to_slot_lookup() {
    let mut rs = RenderState::new();
    let mut world = World::new();
    let e0 = world.spawn((Position::default(), Active));
    let e1 = world.spawn((Position::default(), Active));
    rs.assign_slot(e0);
    rs.assign_slot(e1);
    assert_eq!(rs.get_slot(e0), Some(0));
    assert_eq!(rs.get_slot(e1), Some(1));
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p hyperion-core render_state::tests::assign_slot`
Expected: FAIL (method not defined)

**Step 3: Implement assign_slot and get_slot**

Add to `impl RenderState` (before `shrink_to_fit`):

```rust
/// Assign a stable GPU slot to an entity. Returns the slot index.
pub fn assign_slot(&mut self, entity: hecs::Entity) -> u32 {
    let slot = self.gpu_count;
    self.gpu_count += 1;

    // Grow slot_to_entity
    if slot as usize >= self.slot_to_entity.len() {
        self.slot_to_entity.resize(
            (slot as usize + 1).next_power_of_two(),
            hecs::Entity::DANGLING,
        );
    }
    self.slot_to_entity[slot as usize] = entity;

    // Grow entity_to_slot
    let eid = entity.id() as usize;
    if eid >= self.entity_to_slot.len() {
        self.entity_to_slot.resize(eid + 1, u32::MAX);
    }
    self.entity_to_slot[eid] = slot;

    // Grow SoA buffers to match
    self.gpu_transforms.resize((self.gpu_count as usize) * 16, 0.0);
    self.gpu_bounds.resize((self.gpu_count as usize) * 4, 0.0);
    self.gpu_render_meta.resize((self.gpu_count as usize) * 2, 0);
    self.gpu_tex_indices.resize(self.gpu_count as usize, 0);
    self.gpu_prim_params.resize((self.gpu_count as usize) * 8, 0.0);
    self.gpu_entity_ids.resize(self.gpu_count as usize, 0);

    // Mark all dirty
    self.dirty_tracker.ensure_capacity(self.gpu_count as usize);
    self.dirty_tracker.mark_transform_dirty(slot as usize);
    self.dirty_tracker.mark_bounds_dirty(slot as usize);
    self.dirty_tracker.mark_meta_dirty(slot as usize);

    slot
}

/// Look up the GPU slot for an entity. Returns None if not assigned.
pub fn get_slot(&self, entity: hecs::Entity) -> Option<u32> {
    let eid = entity.id() as usize;
    if eid >= self.entity_to_slot.len() {
        return None;
    }
    let slot = self.entity_to_slot[eid];
    if slot == u32::MAX { None } else { Some(slot) }
}
```

**Step 4: Run tests**

Run: `cargo test -p hyperion-core render_state`
Expected: All tests PASS including 2 new ones

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/render_state.rs
git commit -m "feat: add assign_slot and get_slot to RenderState"
```

---

### Task 3: Implement batch despawn with swap-remove

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs`

**Step 1: Write failing tests**

```rust
#[test]
fn swap_remove_single_despawn() {
    let mut rs = RenderState::new();
    let mut world = World::new();
    let e0 = world.spawn((Position::default(), Active));
    let e1 = world.spawn((Position::default(), Active));
    let e2 = world.spawn((Position::default(), Active));
    rs.assign_slot(e0);
    rs.assign_slot(e1);
    rs.assign_slot(e2);

    // Write known data to slot 1 (entity e1) bounds
    let s1 = 1usize;
    rs.gpu_bounds[s1 * 4] = 99.0;

    // Write known data to slot 2 (entity e2) bounds
    let s2 = 2usize;
    rs.gpu_bounds[s2 * 4] = 77.0;

    // Despawn e1 (slot 1) — e2 (slot 2, last) should swap into slot 1
    rs.pending_despawns.push(e1);
    rs.flush_pending_despawns();

    assert_eq!(rs.gpu_entity_count(), 2);
    assert_eq!(rs.get_slot(e0), Some(0));
    assert_eq!(rs.get_slot(e2), Some(1)); // e2 moved to slot 1
    assert_eq!(rs.get_slot(e1), None);    // e1 gone
    // e2's data now at slot 1
    assert_eq!(rs.gpu_bounds[1 * 4], 77.0);
}

#[test]
fn swap_remove_batch_descending() {
    let mut rs = RenderState::new();
    let mut world = World::new();
    let entities: Vec<_> = (0..5).map(|_| world.spawn((Position::default(), Active))).collect();
    for &e in &entities {
        rs.assign_slot(e);
    }
    // Despawn slots 1 and 3 — descending order should handle correctly
    rs.pending_despawns.push(entities[1]);
    rs.pending_despawns.push(entities[3]);
    rs.flush_pending_despawns();

    assert_eq!(rs.gpu_entity_count(), 3);
    assert_eq!(rs.get_slot(entities[0]), Some(0));
    assert_eq!(rs.get_slot(entities[1]), None);
    assert_eq!(rs.get_slot(entities[3]), None);
}

#[test]
fn swap_remove_last_slot() {
    let mut rs = RenderState::new();
    let mut world = World::new();
    let e0 = world.spawn((Position::default(), Active));
    let e1 = world.spawn((Position::default(), Active));
    rs.assign_slot(e0);
    rs.assign_slot(e1);

    // Despawn last slot — no swap needed, just shrink
    rs.pending_despawns.push(e1);
    rs.flush_pending_despawns();

    assert_eq!(rs.gpu_entity_count(), 1);
    assert_eq!(rs.get_slot(e0), Some(0));
    assert_eq!(rs.get_slot(e1), None);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p hyperion-core render_state::tests::swap_remove`
Expected: FAIL

**Step 3: Implement flush_pending_despawns and copy_soa_slot**

```rust
/// Process all pending despawns via batch swap-remove.
/// Must be called once per frame before collect_gpu_dirty.
/// Processes in descending slot order to maintain the invariant that
/// `last` always points to a live entity.
pub fn flush_pending_despawns(&mut self) {
    if self.pending_despawns.is_empty() {
        return;
    }

    let mut despawn_slots: Vec<u32> = self
        .pending_despawns
        .drain(..)
        .filter_map(|e| {
            let eid = e.id() as usize;
            if eid >= self.entity_to_slot.len() {
                return None;
            }
            let slot = self.entity_to_slot[eid];
            if slot == u32::MAX { None } else { Some(slot) }
        })
        .collect();

    despawn_slots.sort_unstable_by(|a, b| b.cmp(a));

    for slot in despawn_slots {
        let last = self.gpu_count - 1;
        let dead_entity = self.slot_to_entity[slot as usize];

        if slot != last {
            self.copy_soa_slot(last, slot);
            let moved_entity = self.slot_to_entity[last as usize];
            self.slot_to_entity[slot as usize] = moved_entity;
            self.entity_to_slot[moved_entity.id() as usize] = slot;
            self.dirty_tracker.mark_transform_dirty(slot as usize);
            self.dirty_tracker.mark_bounds_dirty(slot as usize);
            self.dirty_tracker.mark_meta_dirty(slot as usize);
        }

        self.entity_to_slot[dead_entity.id() as usize] = u32::MAX;
        self.gpu_count -= 1;
    }
}

fn copy_soa_slot(&mut self, src: u32, dst: u32) {
    let s = src as usize;
    let d = dst as usize;

    // transforms: 16 f32 per slot
    let (ts, td) = (s * 16, d * 16);
    self.gpu_transforms.copy_within(ts..ts + 16, td);

    // bounds: 4 f32 per slot
    let (bs, bd) = (s * 4, d * 4);
    self.gpu_bounds.copy_within(bs..bs + 4, bd);

    // render_meta: 2 u32 per slot
    let (ms, md) = (s * 2, d * 2);
    self.gpu_render_meta.copy_within(ms..ms + 2, md);

    // tex_indices: 1 u32 per slot
    self.gpu_tex_indices[d] = self.gpu_tex_indices[s];

    // prim_params: 8 f32 per slot
    let (ps, pd) = (s * 8, d * 8);
    self.gpu_prim_params.copy_within(ps..ps + 8, pd);

    // entity_ids: 1 u32 per slot
    self.gpu_entity_ids[d] = self.gpu_entity_ids[s];
}
```

**Step 4: Run tests**

Run: `cargo test -p hyperion-core render_state`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/render_state.rs
git commit -m "feat: implement batch despawn with swap-remove in RenderState"
```

---

### Task 4: Implement write_slot for in-place SoA updates

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs`

**Step 1: Write failing test**

```rust
#[test]
fn write_slot_updates_soa_in_place() {
    let mut rs = RenderState::new();
    let mut world = World::new();
    let e = world.spawn((
        Position(Vec3::new(5.0, 10.0, 0.0)),
        Rotation::default(),
        Scale(Vec3::ONE),
        ModelMatrix::default(),
        BoundingRadius(2.0),
        TextureLayerIndex(7),
        MeshHandle(3),
        RenderPrimitive(1),
        PrimitiveParams::default(),
        ExternalId(42),
        Active,
    ));
    let slot = rs.assign_slot(e);
    rs.write_slot(slot, &world, e);

    // Check bounds: position (5, 10, 0) + radius 2
    assert_eq!(rs.gpu_bounds[slot as usize * 4], 5.0);
    assert_eq!(rs.gpu_bounds[slot as usize * 4 + 1], 10.0);
    assert_eq!(rs.gpu_bounds[slot as usize * 4 + 3], 2.0);
    // Check entity_ids
    assert_eq!(rs.gpu_entity_ids[slot as usize], 42);
}
```

**Step 2: Implement write_slot**

```rust
/// Write all SoA data for an entity into its assigned slot.
/// Used for initial population and dirty updates.
pub fn write_slot(&mut self, slot: u32, world: &World, entity: hecs::Entity) {
    let s = slot as usize;

    if let Ok(matrix) = world.get::<&ModelMatrix>(entity) {
        let t = s * 16;
        self.gpu_transforms[t..t + 16].copy_from_slice(&matrix.0);
    }

    if let Ok(pos) = world.get::<&Position>(entity) {
        let b = s * 4;
        self.gpu_bounds[b] = pos.0.x;
        self.gpu_bounds[b + 1] = pos.0.y;
        self.gpu_bounds[b + 2] = pos.0.z;
    }
    if let Ok(radius) = world.get::<&BoundingRadius>(entity) {
        self.gpu_bounds[s * 4 + 3] = radius.0;
    }

    if let Ok(mesh) = world.get::<&MeshHandle>(entity) {
        self.gpu_render_meta[s * 2] = mesh.0;
    }
    if let Ok(prim) = world.get::<&RenderPrimitive>(entity) {
        self.gpu_render_meta[s * 2 + 1] = prim.0 as u32;
    }

    if let Ok(tex) = world.get::<&TextureLayerIndex>(entity) {
        self.gpu_tex_indices[s] = tex.0;
    }

    if let Ok(params) = world.get::<&PrimitiveParams>(entity) {
        let p = s * 8;
        self.gpu_prim_params[p..p + 8].copy_from_slice(&params.0);
    }

    if let Ok(ext_id) = world.get::<&ExternalId>(entity) {
        self.gpu_entity_ids[s] = ext_id.0;
    }
}
```

**Step 3: Run tests**

Run: `cargo test -p hyperion-core render_state`
Expected: PASS

**Step 4: Commit**

```bash
git add crates/hyperion-core/src/render_state.rs
git commit -m "feat: add write_slot for in-place SoA updates"
```

---

### Task 5: Wire dirty marking into process_commands

**Files:**
- Modify: `crates/hyperion-core/src/command_processor.rs:98-312`
- Modify: `crates/hyperion-core/src/render_state.rs` (add `mark_dirty_*` helpers)

**Step 1: Extend process_commands signature to accept RenderState**

Change the function signature at line 98 from:

```rust
pub fn process_commands(commands: &[Command], world: &mut World, entity_map: &mut EntityMap)
```

to:

```rust
pub fn process_commands(
    commands: &[Command],
    world: &mut World,
    entity_map: &mut EntityMap,
    render_state: &mut RenderState,
)
```

**Step 2: Update SpawnEntity handler (lines 101-119)**

After `entity_map.insert(cmd.entity_id, entity)`, add:

```rust
let slot = render_state.assign_slot(entity);
render_state.write_slot(slot, world, entity);
```

**Step 3: Update DespawnEntity handler (lines 121-126)**

Before `world.despawn(entity)`, add:

```rust
render_state.pending_despawns.push(entity);
```

**Step 4: Update SetPosition/SetVelocity/SetRotation/SetScale handlers**

After each component mutation, add dirty marking:

```rust
// After setting position:
if let Some(slot) = render_state.get_slot(entity) {
    render_state.dirty_tracker.mark_transform_dirty(slot as usize);
    render_state.dirty_tracker.mark_bounds_dirty(slot as usize);
}
```

For SetTextureLayer/SetMeshHandle/SetRenderPrimitive/SetPrimParams:

```rust
if let Some(slot) = render_state.get_slot(entity) {
    render_state.dirty_tracker.mark_meta_dirty(slot as usize);
}
```

**Step 5: Update caller in engine.rs line 66**

From: `process_commands(commands, &mut self.world, &mut self.entity_map);`
To: `process_commands(commands, &mut self.world, &mut self.entity_map, &mut self.render_state);`

**Step 6: Fix all existing tests in command_processor.rs**

Every test that calls `process_commands()` needs the extra `&mut RenderState::new()` parameter:

```rust
let mut rs = RenderState::new();
process_commands(&cmds, &mut world, &mut entity_map, &mut rs);
```

**Step 7: Run tests**

Run: `cargo test -p hyperion-core`
Expected: All 99 tests PASS

**Step 8: Commit**

```bash
git add crates/hyperion-core/src/command_processor.rs crates/hyperion-core/src/engine.rs
git commit -m "feat: wire dirty marking into process_commands"
```

---

### Task 6: Implement collect_gpu_dirty

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs`

**Step 1: Write failing test**

```rust
#[test]
fn collect_gpu_dirty_writes_only_dirty_slots() {
    let mut rs = RenderState::new();
    let mut world = World::new();

    let e0 = world.spawn((
        Position(Vec3::new(1.0, 0.0, 0.0)), Rotation::default(), Scale(Vec3::ONE),
        Velocity::default(), ModelMatrix::default(), BoundingRadius(1.0),
        TextureLayerIndex(0), MeshHandle(0), RenderPrimitive(0),
        PrimitiveParams::default(), ExternalId(0), Parent::default(),
        Children::default(), Active,
    ));
    let e1 = world.spawn((
        Position(Vec3::new(2.0, 0.0, 0.0)), Rotation::default(), Scale(Vec3::ONE),
        Velocity::default(), ModelMatrix::default(), BoundingRadius(1.0),
        TextureLayerIndex(0), MeshHandle(0), RenderPrimitive(0),
        PrimitiveParams::default(), ExternalId(1), Parent::default(),
        Children::default(), Active,
    ));
    rs.assign_slot(e0);
    rs.assign_slot(e1);

    // Write initial data
    transform_system(&mut world);
    rs.write_slot(0, &world, e0);
    rs.write_slot(1, &world, e1);

    // Clear dirty, then dirty only e0
    rs.dirty_tracker.clear();
    rs.dirty_tracker.mark_transform_dirty(0);
    rs.dirty_tracker.mark_bounds_dirty(0);

    let result = rs.collect_dirty_staging(&world);
    assert_eq!(result.dirty_count, 1);
    assert_eq!(result.dirty_indices[0], 0); // slot 0
}
```

**Step 2: Implement DirtyStagingResult and collect_dirty_staging**

```rust
/// Result of collect_dirty_staging: compact staging buffer + indices for GPU scatter.
pub struct DirtyStagingResult {
    /// 32 u32 per dirty entity (128 bytes each): transforms(16) + bounds(4) + meta(2) + tex(1) + params(8) + pad(1)
    pub staging: Vec<u32>,
    /// Destination slot index for each dirty entity
    pub dirty_indices: Vec<u32>,
    /// Number of dirty entities
    pub dirty_count: u32,
    /// Union dirty ratio (for threshold decision)
    pub dirty_ratio: f32,
}

impl RenderState {
    /// Collect dirty entity data into a compact staging buffer for GPU scatter upload.
    /// Call flush_pending_despawns() before this.
    pub fn collect_dirty_staging(&mut self, world: &World) -> DirtyStagingResult {
        let total = self.gpu_count as usize;
        if total == 0 {
            return DirtyStagingResult {
                staging: Vec::new(),
                dirty_indices: Vec::new(),
                dirty_count: 0,
                dirty_ratio: 0.0,
            };
        }

        // Union all dirty bitsets
        let mut dirty_count = 0u32;
        let mut dirty_indices = Vec::new();
        for slot in 0..total {
            let t = self.dirty_tracker.is_transform_dirty(slot);
            let b = self.dirty_tracker.is_bounds_dirty(slot);
            let m = self.dirty_tracker.is_meta_dirty(slot);
            if t || b || m {
                dirty_indices.push(slot as u32);
                dirty_count += 1;
            }
        }

        let dirty_ratio = dirty_count as f32 / total as f32;

        // Build staging buffer: 32 u32 per dirty entity
        let mut staging = Vec::with_capacity(dirty_count as usize * 32);
        for &slot in &dirty_indices {
            let s = slot as usize;
            let entity = self.slot_to_entity[s];

            // First update SoA from world (in case systems modified components)
            self.write_slot(slot, world, entity);

            // Pack into staging: transforms (16) + bounds (4) + meta (2) + tex (1) + params (8) + pad (1)
            // Transforms as u32 (bitwise)
            let t = s * 16;
            for j in 0..16 {
                staging.push(self.gpu_transforms[t + j].to_bits());
            }
            // Bounds as u32
            let b = s * 4;
            for j in 0..4 {
                staging.push(self.gpu_bounds[b + j].to_bits());
            }
            // RenderMeta
            let m = s * 2;
            staging.push(self.gpu_render_meta[m]);
            staging.push(self.gpu_render_meta[m + 1]);
            // TexIndices
            staging.push(self.gpu_tex_indices[s]);
            // PrimParams as u32
            let p = s * 8;
            for j in 0..8 {
                staging.push(self.gpu_prim_params[p + j].to_bits());
            }
            // Pad to 32 u32
            staging.push(0); // format flag: 0 = compressed transform (default for now)
        }

        self.dirty_tracker.clear();

        DirtyStagingResult {
            staging,
            dirty_indices,
            dirty_count,
            dirty_ratio,
        }
    }
}
```

**Step 3: Run tests**

Run: `cargo test -p hyperion-core render_state`
Expected: PASS

**Step 4: Commit**

```bash
git add crates/hyperion-core/src/render_state.rs
git commit -m "feat: implement collect_dirty_staging for GPU scatter upload"
```

---

### Task 7: Add new WASM exports for dirty staging data

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs` (add staging buffer fields + accessors)
- Modify: `crates/hyperion-core/src/lib.rs` (add WASM exports)
- Modify: `crates/hyperion-core/src/engine.rs` (update `update()` flow)

**Step 1: Add cached staging fields to RenderState**

```rust
// In RenderState struct:
staging_cache: Vec<u32>,
staging_indices_cache: Vec<u32>,
staging_dirty_count: u32,
staging_dirty_ratio: f32,
```

**Step 2: Add collect_and_cache_dirty method**

```rust
pub fn collect_and_cache_dirty(&mut self, world: &World) {
    self.flush_pending_despawns();
    let result = self.collect_dirty_staging(world);
    self.staging_cache = result.staging;
    self.staging_indices_cache = result.dirty_indices;
    self.staging_dirty_count = result.dirty_count;
    self.staging_dirty_ratio = result.dirty_ratio;
}
```

**Step 3: Add WASM export pointer accessors**

Add to `render_state.rs`:

```rust
pub fn staging_ptr(&self) -> *const u32 { self.staging_cache.as_ptr() }
pub fn staging_u32_len(&self) -> u32 { self.staging_cache.len() as u32 }
pub fn staging_indices_ptr(&self) -> *const u32 { self.staging_indices_cache.as_ptr() }
pub fn staging_indices_len(&self) -> u32 { self.staging_indices_cache.len() as u32 }
pub fn dirty_count(&self) -> u32 { self.staging_dirty_count }
pub fn dirty_ratio(&self) -> f32 { self.staging_dirty_ratio }
```

**Step 4: Add WASM exports to lib.rs**

```rust
#[wasm_bindgen]
pub fn engine_dirty_count() -> u32 { /* ... */ }
#[wasm_bindgen]
pub fn engine_dirty_ratio() -> f32 { /* ... */ }
#[wasm_bindgen]
pub fn engine_staging_ptr() -> *const u32 { /* ... */ }
#[wasm_bindgen]
pub fn engine_staging_u32_len() -> u32 { /* ... */ }
#[wasm_bindgen]
pub fn engine_staging_indices_ptr() -> *const u32 { /* ... */ }
#[wasm_bindgen]
pub fn engine_staging_indices_len() -> u32 { /* ... */ }
```

**Step 5: Update engine.rs `update()` method (line 97-101)**

Replace:
```rust
self.render_state.collect(&self.world);
self.render_state.collect_gpu(&self.world);
```

With:
```rust
self.render_state.collect(&self.world);
self.render_state.collect_and_cache_dirty(&self.world);
// Legacy full collect for backward compatibility (Modes A/B)
self.render_state.collect_gpu(&self.world);
```

Note: `collect_gpu()` remains for backward compatibility. The dirty path runs first (for Mode C scatter), then the full path runs (for Modes A/B transfer). In a later optimization pass, Modes A/B can switch to transferring only dirty data.

**Step 6: Run tests**

Run: `cargo test -p hyperion-core`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add crates/hyperion-core/src/render_state.rs crates/hyperion-core/src/lib.rs crates/hyperion-core/src/engine.rs
git commit -m "feat: add WASM exports for dirty staging data"
```

---

### Task 8: Create scatter.wgsl shader

**Files:**
- Create: `ts/src/shaders/scatter.wgsl`

**Step 1: Write the shader**

```wgsl
// scatter.wgsl — GPU compute scatter for dirty entity data

struct ScatterUniforms {
    dirty_count: u32,
}

// @group(0): source data
@group(0) @binding(0) var<uniform> uniforms: ScatterUniforms;
@group(0) @binding(1) var<storage, read> staging: array<u32>;
@group(0) @binding(2) var<storage, read> dirty_indices: array<u32>;

// @group(1): destination SoA buffers
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

**Step 2: Add `?raw` import to vite-env.d.ts if not already covered**

The existing WGSL `?raw` declarations in `ts/src/vite-env.d.ts` should already cover this. Verify.

**Step 3: Commit**

```bash
git add ts/src/shaders/scatter.wgsl
git commit -m "feat: add scatter.wgsl compute shader for dirty entity upload"
```

---

### Task 9: Implement ScatterPass class

**Files:**
- Create: `ts/src/render/passes/scatter-pass.ts`
- Create: `ts/src/render/passes/scatter-pass.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect } from 'vitest';
import { ScatterPass } from './scatter-pass';

describe('ScatterPass', () => {
  it('declares correct read/write resources', () => {
    const pass = new ScatterPass();
    expect(pass.reads).toContain('entity-transforms');
    expect(pass.writes).toContain('entity-transforms');
  });

  it('computes correct workgroup count', () => {
    expect(ScatterPass.workgroupCount(0)).toBe(0);
    expect(ScatterPass.workgroupCount(1)).toBe(1);
    expect(ScatterPass.workgroupCount(64)).toBe(1);
    expect(ScatterPass.workgroupCount(65)).toBe(2);
    expect(ScatterPass.workgroupCount(1000)).toBe(16);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/render/passes/scatter-pass.test.ts`
Expected: FAIL

**Step 3: Implement ScatterPass**

Create `ts/src/render/passes/scatter-pass.ts` with the class implementing `RenderPass` interface. It should:
- Create pipeline from `scatter.wgsl`
- Create bind group layouts for @group(0) and @group(1)
- Provide `setup()`, `prepare()`, and `execute()` methods
- `execute()` dispatches `ceil(dirtyCount / 64)` workgroups
- Static `workgroupCount(n)` helper

**Step 4: Run tests**

Run: `cd ts && npx vitest run src/render/passes/scatter-pass.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/render/passes/scatter-pass.ts ts/src/render/passes/scatter-pass.test.ts
git commit -m "feat: add ScatterPass compute pass for dirty entity scatter"
```

---

### Task 10: Integrate ScatterPass into renderer

**Files:**
- Modify: `ts/src/renderer.ts`
- Modify: `ts/src/worker-bridge.ts` (add dirty staging fields to GPURenderState)

**Step 1: Extend GPURenderState type**

Add to `GPURenderState` interface in `worker-bridge.ts`:

```typescript
// Dirty staging data (for scatter upload path)
dirtyCount: number;
dirtyRatio: number;
stagingData: Uint32Array | null;    // 32 u32 per dirty entity
dirtyIndices: Uint32Array | null;   // slot index per dirty entity
```

**Step 2: Update Mode C bridge to read dirty data from WASM**

In the Mode C tick function, after reading SoA data, also read:

```typescript
dirtyCount: engine.engine_dirty_count(),
dirtyRatio: engine.engine_dirty_ratio(),
stagingData: /* read from WASM memory via engine_staging_ptr/len */,
dirtyIndices: /* read from WASM memory via engine_staging_indices_ptr/len */,
```

**Step 3: Update renderer.ts upload logic**

In the `render()` method (around lines 486-527), add scatter path:

```typescript
const SCATTER_THRESHOLD = this.config.scatterThreshold ?? 0.3;

if (state.dirtyCount > 0 && state.dirtyRatio <= SCATTER_THRESHOLD && this.scatterPass) {
    // Scatter path: upload staging + indices, dispatch compute
    device.queue.writeBuffer(this.scatterStagingBuf, 0, state.stagingData!);
    device.queue.writeBuffer(this.scatterIndicesBuf, 0, state.dirtyIndices!);
    device.queue.writeBuffer(this.scatterUniformBuf, 0,
        new Uint32Array([state.dirtyCount]));
    // ScatterPass will be executed by RenderGraph before CullPass
} else {
    // Full upload path (existing code)
    device.queue.writeBuffer(transformBuf, 0, state.transforms, ...);
    // ... existing 5 writeBuffer calls ...
}
```

**Step 4: Add ScatterPass to RenderGraph before CullPass**

```typescript
if (this.scatterPass) {
    graph.addPass(this.scatterPass);
}
```

Ensure ScatterPass writes `entity-transforms` etc. and CullPass reads them — the DAG will order them correctly.

**Step 5: Add `scatterThreshold` to HyperionConfig**

In `ts/src/types.ts`:

```typescript
scatterThreshold?: number;  // default 0.3
```

**Step 6: Run full test suite**

Run: `cd ts && npm test`
Expected: All 616+ tests PASS

**Step 7: Commit**

```bash
git add ts/src/renderer.ts ts/src/worker-bridge.ts ts/src/types.ts
git commit -m "feat: integrate ScatterPass into renderer with threshold fallback"
```

---

## Optimization #4: Batch Spawn

### Task 11: Add batch spawn auto-detection

**Files:**
- Modify: `crates/hyperion-core/src/command_processor.rs`

**Step 1: Write failing test**

```rust
#[test]
fn batch_spawn_detection() {
    let mut world = World::new();
    let mut entity_map = EntityMap::new();
    let mut rs = RenderState::new();
    let cmds = vec![spawn_cmd(0), spawn_cmd(1), spawn_cmd(2)];
    process_commands(&cmds, &mut world, &mut entity_map, &mut rs);
    assert_eq!(rs.gpu_entity_count(), 3);
    // All three entities should exist
    assert!(entity_map.get(0).is_some());
    assert!(entity_map.get(1).is_some());
    assert!(entity_map.get(2).is_some());
}

#[test]
fn batch_spawn_interrupted_by_other_command() {
    let mut world = World::new();
    let mut entity_map = EntityMap::new();
    let mut rs = RenderState::new();
    let cmds = vec![
        spawn_cmd(0),
        spawn_cmd(1),
        make_position_cmd(0, 5.0, 0.0, 0.0), // interrupts batch
        spawn_cmd(2),
    ];
    process_commands(&cmds, &mut world, &mut entity_map, &mut rs);
    assert_eq!(rs.gpu_entity_count(), 3);
    let e0 = entity_map.get(0).unwrap();
    let pos = world.get::<&Position>(e0).unwrap();
    assert!((pos.0.x - 5.0).abs() < 0.001);
}
```

**Step 2: Implement batch detection in process_commands**

Refactor `process_commands` to detect consecutive `SpawnEntity` commands and batch them using `world.spawn_batch()`. See design doc §4 for the full pattern.

Key: when a non-SpawnEntity command is encountered, flush the accumulated batch first, then process the command normally.

**Step 3: Run tests**

Run: `cargo test -p hyperion-core`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add crates/hyperion-core/src/command_processor.rs
git commit -m "feat: auto-detect consecutive spawns for hecs batch insert"
```

---

## Optimization #2: Compressed 2D Transforms

### Task 12: Add compressed transform support to scatter shader

**Files:**
- Modify: `ts/src/shaders/scatter.wgsl`
- Modify: `crates/hyperion-core/src/render_state.rs` (set format flag in staging)

**Step 1: Add format flag branching to scatter.wgsl**

At the end of the scatter function, replace the transform copy loop with:

```wgsl
let format = staging[src + 31u];
if (format == 0u) {
    // Compressed 2D: reconstruct mat4x4 from pos(3f) + rot(1f) + scale(2f)
    let px = bitcast<f32>(staging[src]);
    let py = bitcast<f32>(staging[src + 1u]);
    let pz = bitcast<f32>(staging[src + 2u]);
    let angle = bitcast<f32>(staging[src + 3u]);
    let sx = bitcast<f32>(staging[src + 4u]);
    let sy = bitcast<f32>(staging[src + 5u]);
    let c = cos(angle);
    let s_val = sin(angle);
    transforms[t]      = bitcast<u32>(sx * c);
    transforms[t + 1u] = bitcast<u32>(sx * s_val);
    transforms[t + 2u] = 0u;
    transforms[t + 3u] = 0u;
    transforms[t + 4u] = bitcast<u32>(-sy * s_val);
    transforms[t + 5u] = bitcast<u32>(sy * c);
    transforms[t + 6u] = 0u;
    transforms[t + 7u] = 0u;
    transforms[t + 8u]  = 0u;
    transforms[t + 9u]  = 0u;
    transforms[t + 10u] = bitcast<u32>(1.0);
    transforms[t + 11u] = 0u;
    transforms[t + 12u] = bitcast<u32>(px);
    transforms[t + 13u] = bitcast<u32>(py);
    transforms[t + 14u] = bitcast<u32>(pz);
    transforms[t + 15u] = bitcast<u32>(1.0);
} else {
    // Pre-computed mat4x4: copy directly
    for (var j = 0u; j < 16u; j++) {
        transforms[t + j] = staging[src + j];
    }
}
```

**Step 2: Update collect_dirty_staging in Rust**

For root entities (no Parent or Parent == u32::MAX), write compressed format:
- staging[0..5] = pos.x, pos.y, pos.z, rotation_angle, scale.x, scale.y
- staging[6..15] = 0 (padding)
- staging[31] = 0 (compressed flag)

For child entities (has Parent != u32::MAX), write pre-computed mat4x4:
- staging[0..15] = ModelMatrix values
- staging[31] = 1 (pre-computed flag)

**Step 3: Write Rust test for compressed output**

```rust
#[test]
fn collect_dirty_staging_compressed_root() {
    // Setup root entity with known pos/rot/scale
    // Verify staging[31] == 0 and staging[0..6] match pos+rot+scale
}

#[test]
fn collect_dirty_staging_precomputed_child() {
    // Setup child entity with Parent != u32::MAX
    // Verify staging[31] == 1 and staging[0..16] match ModelMatrix
}
```

**Step 4: Run tests**

Run: `cargo test -p hyperion-core render_state && cd ts && npm test`
Expected: All PASS

**Step 5: Commit**

```bash
git add ts/src/shaders/scatter.wgsl crates/hyperion-core/src/render_state.rs
git commit -m "feat: add compressed 2D transform support to scatter shader"
```

---

## Optimization #3: Material Sort (2-Bucket)

### Task 13: Add 2-bucket cull shader variant

**Files:**
- Modify: `ts/src/shaders/cull.wgsl`
- Modify: `ts/src/render/passes/cull-pass.ts`
- Modify: `ts/src/render/passes/forward-pass.ts`

**IMPORTANT:** Measure fragment divergence first. If profiling shows no significant texture-tier divergence, skip this task.

**Step 1: Extend cull shader indirect args from 6 to 12**

Each primitive type gets 2 buckets: tier0 and other. Atomic counters: `primType * 2 + bucket`.

**Step 2: Update CullPass to reset 12 indirect args**

Modify the indirect args reset (lines 137-145 of cull-pass.ts) to reset 12 entries instead of 6.

**Step 3: Update ForwardPass to draw 12 calls**

Modify ForwardPass to create 2 pipeline variants per type (12 total). Pre-compile all during `setup()`.

**Step 4: Add tests**

```typescript
// cull-pass.test.ts additions
it('supports 2-bucket indirect args', () => { /* ... */ });
```

**Step 5: Run tests**

Run: `cd ts && npm test`
Expected: All PASS

**Step 6: Commit**

```bash
git add ts/src/shaders/cull.wgsl ts/src/render/passes/cull-pass.ts ts/src/render/passes/forward-pass.ts
git commit -m "feat: add 2-bucket material sort to cull shader"
```

---

## Optimization #5: Texture Streaming

### Task 14: Add priority queue to TextureManager

**Files:**
- Modify: `ts/src/texture-manager.ts`
- Create: `ts/src/texture-priority.test.ts`

**Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';

describe('TexturePriorityQueue', () => {
  it('dequeues lowest priority first', () => {
    // Create queue, add items with priorities 10, 5, 20
    // Dequeue should return priority 5 first
  });

  it('reheap updates order after priority changes', () => {
    // Add items, change a priority, reheap, verify new order
  });
});
```

**Step 2: Implement PriorityQueue and integrate into TextureManager**

Replace the FIFO array in `drainFetchQueue()` with a min-heap. Add `updatePriorities()` method that accepts frustum planes and camera position.

**Step 3: Add progressive KTX2 loading**

Modify the KTX2 load path to:
1. First load smallest mip level as placeholder (if range requests supported)
2. Then load full resolution and swap

Add fallback: if HTTP 206 not received, load full file as today.

**Step 4: Run tests**

Run: `cd ts && npx vitest run src/texture-priority.test.ts && npm test`
Expected: All PASS

**Step 5: Commit**

```bash
git add ts/src/texture-manager.ts ts/src/texture-priority.test.ts
git commit -m "feat: add priority queue and progressive KTX2 to TextureManager"
```

---

## Finalization

### Task 15: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update Implementation Status table**

Add Phase 12 row:
```
| 12 | Optimization Tier 2 | GPU scatter upload (DirtyTracker + stable slots + swap-remove), compressed 2D transforms, 2-bucket material sort, batch spawn, texture streaming |
```

**Step 2: Add new test commands**

Add scatter-pass, texture-priority tests to the test reference.

**Step 3: Add gotchas**

- Scatter shader @group(1) must match CullPass read layout
- Compressed transforms use format flag at staging[31]: 0=compressed, 1=mat4x4
- `flush_pending_despawns()` must be called before `collect_dirty_staging()`
- Descending slot order in batch despawn is a correctness invariant

**Step 4: Update test counts**

Update Rust test count (new tests) and TypeScript test count.

**Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Phase 12 Optimization Tier 2"
```

---

### Task 16: Run full validation

**Step 1: Run all Rust tests**

Run: `cargo test -p hyperion-core`
Expected: All tests PASS (99+ base + new)

**Step 2: Run all Rust tests with dev-tools**

Run: `cargo test -p hyperion-core --features dev-tools`
Expected: All tests PASS (109+ base + new)

**Step 3: Run clippy**

Run: `cargo clippy -p hyperion-core`
Expected: No warnings

**Step 4: Run all TypeScript tests**

Run: `cd ts && npm test`
Expected: All 616+ tests PASS

**Step 5: Type-check**

Run: `cd ts && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: No errors

**Step 6: Build WASM**

Run: `cd ts && npm run build:wasm`
Expected: Successful build

**Step 7: Check binary size**

Run: `cd ts && npm run check:wasm-size`
Expected: < 200KB gzipped
