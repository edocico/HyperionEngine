//! Collects render-ready data from the ECS into contiguous GPU-uploadable buffers.
//!
//! GPU data is laid out as Structure-of-Arrays (SoA): four independent buffers
//! (transforms, bounds, renderMeta, texIndices) instead of one interleaved buffer.
//! This enables partial upload, better GPU cache performance, and extensibility.

use hecs::World;

use crate::components::{
    Active, BoundingRadius, ExternalId, MeshHandle, ModelMatrix, Parent, Position, PrimitiveParams,
    RenderPrimitive, Rotation, Scale, TextureLayerIndex,
};

/// Compact bitset for tracking dirty flags per entity slot.
///
/// Uses one bit per entity, packed into `u64` words. At 100k entities this
/// consumes only ~12.5 KB, making clear() a fast `memset` of 1563 words.
pub struct BitSet {
    bits: Vec<u64>,
    count: usize,
}

impl BitSet {
    /// Create a new bitset with capacity for at least `capacity` bits, all unset.
    pub fn new(capacity: usize) -> Self {
        let words = capacity.div_ceil(64);
        Self {
            bits: vec![0u64; words],
            count: 0,
        }
    }

    /// Mark bit at `index` as set. Idempotent: only increments count on first set.
    pub fn set(&mut self, index: usize) {
        self.ensure_capacity(index + 1);
        let word = index / 64;
        let bit = index % 64;
        let mask = 1u64 << bit;
        if self.bits[word] & mask == 0 {
            self.bits[word] |= mask;
            self.count += 1;
        }
    }

    /// Check if bit at `index` is set. Returns false for out-of-bounds indices.
    pub fn get(&self, index: usize) -> bool {
        let word = index / 64;
        if word >= self.bits.len() {
            return false;
        }
        let bit = index % 64;
        self.bits[word] & (1u64 << bit) != 0
    }

    /// Clear all bits and reset count to zero.
    pub fn clear(&mut self) {
        for w in &mut self.bits {
            *w = 0;
        }
        self.count = 0;
    }

    /// Number of set bits.
    pub fn count(&self) -> usize {
        self.count
    }

    /// Grow the bitset if needed to hold at least `capacity` bits.
    pub fn ensure_capacity(&mut self, capacity: usize) {
        let words_needed = capacity.div_ceil(64);
        if words_needed > self.bits.len() {
            self.bits.resize(words_needed, 0);
        }
    }
}

/// Tracks which entity slots have been modified since the last frame.
///
/// Maintains three independent dirty bitsets corresponding to the SoA GPU buffers:
/// - `transform_dirty`: entity model matrix changed
/// - `bounds_dirty`: entity position or bounding radius changed
/// - `meta_dirty`: entity mesh handle, render primitive, or texture index changed
///
/// Used to determine whether a full or partial GPU buffer upload is beneficial.
/// Rule of thumb: if `transform_dirty_ratio(total) < 0.3`, a partial upload wins.
pub struct DirtyTracker {
    transform_dirty: BitSet,
    bounds_dirty: BitSet,
    meta_dirty: BitSet,
}

impl DirtyTracker {
    /// Create a new tracker pre-sized for `capacity` entity slots.
    pub fn new(capacity: usize) -> Self {
        Self {
            transform_dirty: BitSet::new(capacity),
            bounds_dirty: BitSet::new(capacity),
            meta_dirty: BitSet::new(capacity),
        }
    }

    /// Mark entity at `idx` as having a dirty transform (model matrix changed).
    pub fn mark_transform_dirty(&mut self, idx: usize) {
        self.transform_dirty.set(idx);
    }

    /// Mark entity at `idx` as having dirty bounds (position or radius changed).
    pub fn mark_bounds_dirty(&mut self, idx: usize) {
        self.bounds_dirty.set(idx);
    }

    /// Mark entity at `idx` as having dirty metadata (mesh, primitive, or texture changed).
    pub fn mark_meta_dirty(&mut self, idx: usize) {
        self.meta_dirty.set(idx);
    }

    /// Check if entity at `idx` has a dirty transform.
    pub fn is_transform_dirty(&self, idx: usize) -> bool {
        self.transform_dirty.get(idx)
    }

    /// Check if entity at `idx` has dirty bounds.
    pub fn is_bounds_dirty(&self, idx: usize) -> bool {
        self.bounds_dirty.get(idx)
    }

    /// Check if entity at `idx` has dirty metadata (mesh, primitive, or texture).
    pub fn is_meta_dirty(&self, idx: usize) -> bool {
        self.meta_dirty.get(idx)
    }

    /// Fraction of entities with dirty transforms: `dirty_count / total`.
    /// Returns 0.0 if `total` is 0.
    pub fn transform_dirty_ratio(&self, total: usize) -> f32 {
        if total == 0 {
            return 0.0;
        }
        self.transform_dirty.count() as f32 / total as f32
    }

    /// Fraction of entities with dirty metadata: `dirty_count / total`.
    /// Returns 0.0 if `total` is 0.
    pub fn meta_dirty_ratio(&self, total: usize) -> f32 {
        if total == 0 {
            return 0.0;
        }
        self.meta_dirty.count() as f32 / total as f32
    }

    /// Pre-size all internal bitsets to hold at least `capacity` entity slots.
    ///
    /// Call this before the query loop each frame to avoid incremental
    /// allocations when `mark_*_dirty()` is called during iteration.
    pub fn ensure_capacity(&mut self, capacity: usize) {
        self.transform_dirty.ensure_capacity(capacity);
        self.bounds_dirty.ensure_capacity(capacity);
        self.meta_dirty.ensure_capacity(capacity);
    }

    /// Clear all dirty flags for the next frame.
    pub fn clear(&mut self) {
        self.transform_dirty.clear();
        self.bounds_dirty.clear();
        self.meta_dirty.clear();
    }
}

/// Contiguous buffers of render data for all active entities.
/// Updated once per frame after all physics ticks and transform recomputation.
pub struct RenderState {
    /// Flat buffer: each entry is 16 f32s (one 4x4 column-major matrix).
    /// Used by the legacy collect() path.
    pub matrices: Vec<[f32; 16]>,

    // SoA GPU buffers
    gpu_transforms: Vec<f32>,    // 16 f32/entity (mat4x4)
    gpu_bounds: Vec<f32>,        // 4 f32/entity (xyz + radius)
    gpu_render_meta: Vec<u32>,   // 2 u32/entity (mesh_handle + primitive)
    gpu_tex_indices: Vec<u32>,   // 1 u32/entity (texture layer index)
    gpu_prim_params: Vec<f32>,   // 8 f32/entity (primitive-specific parameters)
    gpu_entity_ids: Vec<u32>,    // 1 u32/entity (external entity ID for picking)
    gpu_count: u32,

    /// Per-buffer dirty tracking for partial upload optimization.
    pub dirty_tracker: DirtyTracker,

    // Stable slot mapping (Phase 12: retained-mode GPU buffers)
    slot_to_entity: Vec<hecs::Entity>,
    entity_to_slot: Vec<u32>,         // indexed by entity.id(), u32::MAX = unassigned
    pub(crate) pending_despawns: Vec<hecs::Entity>,

    // Dirty staging cache (populated by collect_and_cache_dirty)
    staging_cache: Vec<u32>,
    staging_indices_cache: Vec<u32>,
    staging_dirty_count: u32,
    staging_dirty_ratio: f32,
}

/// Result of collect_dirty_staging: compact staging buffer + indices for GPU scatter.
pub struct DirtyStagingResult {
    /// 32 u32 per dirty entity (128 bytes each): transforms(16) + bounds(4) + meta(2) + tex(1) + params(8) + format(1)
    /// Format flag at offset 31: 0 = compressed 2D (pos+rot+scale), 1 = pre-computed mat4x4
    pub staging: Vec<u32>,
    /// Destination slot index for each dirty entity
    pub dirty_indices: Vec<u32>,
    /// Number of dirty entities
    pub dirty_count: u32,
    /// Union dirty ratio (for threshold decision)
    pub dirty_ratio: f32,
}

impl RenderState {
    pub fn new() -> Self {
        Self {
            matrices: Vec::new(),
            gpu_transforms: Vec::new(),
            gpu_bounds: Vec::new(),
            gpu_render_meta: Vec::new(),
            gpu_tex_indices: Vec::new(),
            gpu_prim_params: Vec::new(),
            gpu_entity_ids: Vec::new(),
            gpu_count: 0,
            dirty_tracker: DirtyTracker::new(0),
            slot_to_entity: Vec::new(),
            entity_to_slot: Vec::new(),
            pending_despawns: Vec::new(),
            staging_cache: Vec::new(),
            staging_indices_cache: Vec::new(),
            staging_dirty_count: 0,
            staging_dirty_ratio: 0.0,
        }
    }

    /// Collect model matrices from all active entities.
    /// Clears previous data and repopulates from the current world state.
    pub fn collect(&mut self, world: &World) {
        self.matrices.clear();
        for (matrix, _active) in world.query::<(&ModelMatrix, &Active)>().iter() {
            self.matrices.push(matrix.0);
        }
    }

    /// Number of active entities with render data.
    pub fn count(&self) -> u32 {
        self.matrices.len() as u32
    }

    /// Raw pointer to the matrix data, for WASM memory export.
    /// Returns null if empty.
    pub fn as_ptr(&self) -> *const f32 {
        if self.matrices.is_empty() {
            std::ptr::null()
        } else {
            self.matrices.as_ptr() as *const f32
        }
    }

    /// Total number of f32 values (count * 16).
    pub fn f32_len(&self) -> u32 {
        (self.matrices.len() * 16) as u32
    }

    /// Collect entity data for GPU-driven pipeline using SoA layout.
    ///
    /// Populates four independent buffers:
    /// - `gpu_transforms`: 16 f32/entity (model matrix)
    /// - `gpu_bounds`: 4 f32/entity (position xyz + bounding radius)
    /// - `gpu_render_meta`: 2 u32/entity (mesh handle + render primitive)
    /// - `gpu_tex_indices`: 1 u32/entity (texture layer index)
    pub fn collect_gpu(&mut self, world: &World) {
        self.dirty_tracker.clear();

        self.gpu_transforms.clear();
        self.gpu_bounds.clear();
        self.gpu_render_meta.clear();
        self.gpu_tex_indices.clear();
        self.gpu_prim_params.clear();
        self.gpu_entity_ids.clear();

        // Pre-allocate based on previous frame's entity count to avoid reallocation.
        let hint = self.gpu_count as usize;
        self.gpu_transforms.reserve(hint * 16);
        self.gpu_bounds.reserve(hint * 4);
        self.gpu_render_meta.reserve(hint * 2);
        self.gpu_tex_indices.reserve(hint);
        self.gpu_prim_params.reserve(hint * 8);
        self.gpu_entity_ids.reserve(hint);
        self.dirty_tracker.ensure_capacity(hint);
        self.gpu_count = 0;

        for (pos, matrix, radius, tex, mesh, prim, pp, ext_id, _active) in world
            .query::<(
                &Position,
                &ModelMatrix,
                &BoundingRadius,
                &TextureLayerIndex,
                &MeshHandle,
                &RenderPrimitive,
                &PrimitiveParams,
                &ExternalId,
                &Active,
            )>()
            .iter()
        {
            // Buffer A: Transform (16 f32)
            self.gpu_transforms.extend_from_slice(&matrix.0);

            // Buffer B: Bounds (4 f32)
            self.gpu_bounds
                .extend_from_slice(&[pos.0.x, pos.0.y, pos.0.z, radius.0]);

            // Buffer C: RenderMeta (2 u32)
            self.gpu_render_meta.push(mesh.0);
            self.gpu_render_meta.push(prim.0 as u32);

            // Texture indices (1 u32)
            self.gpu_tex_indices.push(tex.0);

            // Primitive params (8 f32)
            self.gpu_prim_params.extend_from_slice(&pp.0);

            // Entity ID (1 u32)
            self.gpu_entity_ids.push(ext_id.0);

            self.gpu_count += 1;
        }

        debug_assert_eq!(self.gpu_count as usize * 16, self.gpu_transforms.len());
        debug_assert_eq!(self.gpu_count as usize * 4, self.gpu_bounds.len());
        debug_assert_eq!(self.gpu_count as usize * 2, self.gpu_render_meta.len());
        debug_assert_eq!(self.gpu_count as usize, self.gpu_tex_indices.len());
        debug_assert_eq!(self.gpu_count as usize * 8, self.gpu_prim_params.len());
        debug_assert_eq!(self.gpu_count as usize, self.gpu_entity_ids.len());
    }

    /// Number of entities in the GPU buffer.
    pub fn gpu_entity_count(&self) -> u32 {
        self.gpu_count
    }

    // --- SoA buffer accessors: transforms ---

    /// Slice of transform data (16 f32 per entity, column-major mat4x4).
    pub fn gpu_transforms(&self) -> &[f32] {
        &self.gpu_transforms
    }

    /// Pointer to the transforms buffer for WASM export. Returns null if empty.
    pub fn gpu_transforms_ptr(&self) -> *const f32 {
        if self.gpu_transforms.is_empty() {
            std::ptr::null()
        } else {
            self.gpu_transforms.as_ptr()
        }
    }

    /// Number of f32 values in the transforms buffer.
    pub fn gpu_transforms_f32_len(&self) -> u32 {
        self.gpu_transforms.len() as u32
    }

    // --- SoA buffer accessors: bounds ---

    /// Slice of bounds data (4 f32 per entity: xyz position + radius).
    pub fn gpu_bounds(&self) -> &[f32] {
        &self.gpu_bounds
    }

    /// Pointer to the bounds buffer for WASM export. Returns null if empty.
    pub fn gpu_bounds_ptr(&self) -> *const f32 {
        if self.gpu_bounds.is_empty() {
            std::ptr::null()
        } else {
            self.gpu_bounds.as_ptr()
        }
    }

    /// Number of f32 values in the bounds buffer.
    pub fn gpu_bounds_f32_len(&self) -> u32 {
        self.gpu_bounds.len() as u32
    }

    // --- SoA buffer accessors: render meta ---

    /// Slice of render metadata (2 u32 per entity: mesh handle + primitive).
    pub fn gpu_render_meta(&self) -> &[u32] {
        &self.gpu_render_meta
    }

    /// Pointer to the render meta buffer for WASM export. Returns null if empty.
    pub fn gpu_render_meta_ptr(&self) -> *const u32 {
        if self.gpu_render_meta.is_empty() {
            std::ptr::null()
        } else {
            self.gpu_render_meta.as_ptr()
        }
    }

    /// Number of u32 values in the render meta buffer.
    pub fn gpu_render_meta_len(&self) -> u32 {
        self.gpu_render_meta.len() as u32
    }

    // --- SoA buffer accessors: texture indices ---

    /// Texture layer indices, one per GPU entity (parallel to other SoA buffers).
    pub fn gpu_tex_indices(&self) -> &[u32] {
        &self.gpu_tex_indices
    }

    /// Raw pointer to the texture layer indices for WASM export. Returns null if empty.
    pub fn gpu_tex_indices_ptr(&self) -> *const u32 {
        if self.gpu_tex_indices.is_empty() {
            std::ptr::null()
        } else {
            self.gpu_tex_indices.as_ptr()
        }
    }

    /// Number of texture layer indices (same as gpu_entity_count).
    pub fn gpu_tex_indices_len(&self) -> u32 {
        self.gpu_tex_indices.len() as u32
    }

    // --- SoA buffer accessors: primitive params ---

    /// Primitive params data (8 f32 per entity).
    pub fn gpu_prim_params(&self) -> &[f32] {
        &self.gpu_prim_params
    }

    /// Raw pointer to the primitive params buffer for WASM export. Returns null if empty.
    pub fn gpu_prim_params_ptr(&self) -> *const f32 {
        if self.gpu_prim_params.is_empty() {
            std::ptr::null()
        } else {
            self.gpu_prim_params.as_ptr()
        }
    }

    /// Number of f32 values in the primitive params buffer.
    pub fn gpu_prim_params_f32_len(&self) -> u32 {
        self.gpu_prim_params.len() as u32
    }

    // --- SoA buffer accessors: entity IDs ---

    /// External entity IDs, one per GPU entity (parallel to other SoA buffers).
    /// Maps SoA index back to external entity ID for hit testing and picking.
    pub fn gpu_entity_ids(&self) -> &[u32] {
        &self.gpu_entity_ids
    }

    /// Raw pointer to the entity IDs buffer for WASM export. Returns null if empty.
    pub fn gpu_entity_ids_ptr(&self) -> *const u32 {
        if self.gpu_entity_ids.is_empty() {
            std::ptr::null()
        } else {
            self.gpu_entity_ids.as_ptr()
        }
    }

    /// Number of entity IDs (same as gpu_entity_count).
    pub fn gpu_entity_ids_len(&self) -> u32 {
        self.gpu_entity_ids.len() as u32
    }

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

        // Sort descending so highest-numbered slots are removed first.
        // This guarantees that when we swap the "last" entity into the dead slot,
        // "last" is always a live entity (not one pending removal).
        despawn_slots.sort_unstable_by(|a, b| b.cmp(a));

        for slot in despawn_slots {
            let last = self.gpu_count - 1;
            let dead_entity = self.slot_to_entity[slot as usize];

            if slot != last {
                // Swap last entity's data into the dead slot
                self.copy_soa_slot(last, slot);
                let moved_entity = self.slot_to_entity[last as usize];
                self.slot_to_entity[slot as usize] = moved_entity;
                self.entity_to_slot[moved_entity.id() as usize] = slot;
                self.dirty_tracker.mark_transform_dirty(slot as usize);
                self.dirty_tracker.mark_bounds_dirty(slot as usize);
                self.dirty_tracker.mark_meta_dirty(slot as usize);
            }

            // Remove the dead entity from the mapping
            self.entity_to_slot[dead_entity.id() as usize] = u32::MAX;
            self.gpu_count -= 1;
        }
    }

    /// Copy all SoA buffer data from slot `src` to slot `dst`.
    /// Must stay in sync with any new SoA buffers added in the future.
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

    /// Look up the GPU slot for an entity. Returns None if not assigned.
    pub fn get_slot(&self, entity: hecs::Entity) -> Option<u32> {
        let eid = entity.id() as usize;
        if eid >= self.entity_to_slot.len() {
            return None;
        }
        let slot = self.entity_to_slot[eid];
        if slot == u32::MAX { None } else { Some(slot) }
    }

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

            // Check if entity is a root (no Parent or Parent == u32::MAX)
            let is_root = world
                .get::<&Parent>(entity)
                .map(|p| p.0 == u32::MAX)
                .unwrap_or(true); // no Parent component = root

            if is_root {
                // Compressed 2D format (format=0): pos(3) + rot_angle(1) + scale(2) + padding(10)
                let pos = world
                    .get::<&Position>(entity)
                    .map(|p| p.0)
                    .unwrap_or(glam::Vec3::ZERO);
                let rot = world
                    .get::<&Rotation>(entity)
                    .map(|r| r.0)
                    .unwrap_or(glam::Quat::IDENTITY);
                let scale = world
                    .get::<&Scale>(entity)
                    .map(|s| s.0)
                    .unwrap_or(glam::Vec3::ONE);

                // Extract z-rotation angle from quaternion
                let (angle, _, _) = rot.to_euler(glam::EulerRot::ZYX);

                staging.push(pos.x.to_bits());
                staging.push(pos.y.to_bits());
                staging.push(pos.z.to_bits());
                staging.push(angle.to_bits());
                staging.push(scale.x.to_bits());
                staging.push(scale.y.to_bits());
                // Padding: 10 zeros to reach offset 16
                staging.extend(std::iter::repeat_n(0u32, 10));
            } else {
                // Pre-computed mat4x4 (format=1): copy from SoA transforms
                let t = s * 16;
                for j in 0..16 {
                    staging.push(self.gpu_transforms[t + j].to_bits());
                }
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
            // Format flag: 0 = compressed 2D, 1 = pre-computed mat4x4
            staging.push(if is_root { 0 } else { 1 });
        }

        self.dirty_tracker.clear();

        DirtyStagingResult {
            staging,
            dirty_indices,
            dirty_count,
            dirty_ratio,
        }
    }

    /// Flush pending despawns and collect dirty staging data into internal cache.
    /// Call this once per frame after systems run but before GPU data is read.
    pub fn collect_and_cache_dirty(&mut self, world: &World) {
        self.flush_pending_despawns();
        let result = self.collect_dirty_staging(world);
        self.staging_cache = result.staging;
        self.staging_indices_cache = result.dirty_indices;
        self.staging_dirty_count = result.dirty_count;
        self.staging_dirty_ratio = result.dirty_ratio;
    }

    /// Pointer to the staging cache buffer for WASM export.
    pub fn staging_ptr(&self) -> *const u32 {
        self.staging_cache.as_ptr()
    }

    /// Number of u32 values in the staging cache buffer.
    pub fn staging_u32_len(&self) -> u32 {
        self.staging_cache.len() as u32
    }

    /// Pointer to the dirty indices cache buffer for WASM export.
    pub fn staging_indices_ptr(&self) -> *const u32 {
        self.staging_indices_cache.as_ptr()
    }

    /// Number of u32 values in the dirty indices cache buffer.
    pub fn staging_indices_len(&self) -> u32 {
        self.staging_indices_cache.len() as u32
    }

    /// Number of dirty entities in the last staging collection.
    pub fn dirty_count(&self) -> u32 {
        self.staging_dirty_count
    }

    /// Ratio of dirty entities to total entities in the last staging collection.
    pub fn dirty_ratio(&self) -> f32 {
        self.staging_dirty_ratio
    }

    /// Release excess heap memory from all internal buffers.
    /// Call after a large batch of entity despawns to reclaim memory.
    pub fn shrink_to_fit(&mut self) {
        self.matrices.shrink_to_fit();
        self.gpu_transforms.shrink_to_fit();
        self.gpu_bounds.shrink_to_fit();
        self.gpu_render_meta.shrink_to_fit();
        self.gpu_tex_indices.shrink_to_fit();
        self.gpu_prim_params.shrink_to_fit();
        self.gpu_entity_ids.shrink_to_fit();
    }
}

impl Default for RenderState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::*;
    use crate::systems::transform_system;
    use glam::{Quat, Vec3};

    #[test]
    fn collect_gathers_active_matrices() {
        let mut world = World::new();
        world.spawn((
            Position(Vec3::new(1.0, 0.0, 0.0)),
            Rotation::default(),
            Scale::default(),
            ModelMatrix::default(),
            Active,
        ));
        world.spawn((
            Position(Vec3::new(2.0, 0.0, 0.0)),
            Rotation::default(),
            Scale::default(),
            ModelMatrix::default(),
            Active,
        ));
        // Entity without Active — should NOT be collected
        world.spawn((
            Position(Vec3::new(3.0, 0.0, 0.0)),
            ModelMatrix::default(),
        ));

        let mut rs = RenderState::new();
        rs.collect(&world);
        assert_eq!(rs.count(), 2);
        assert_eq!(rs.f32_len(), 32);
    }

    #[test]
    fn collect_clears_previous_data() {
        let mut world = World::new();
        world.spawn((ModelMatrix::default(), Active));

        let mut rs = RenderState::new();
        rs.collect(&world);
        assert_eq!(rs.count(), 1);

        // Despawn all entities
        let entities: Vec<_> = world.iter().map(|e| e.entity()).collect();
        for e in entities {
            world.despawn(e).unwrap();
        }

        rs.collect(&world);
        assert_eq!(rs.count(), 0);
    }

    #[test]
    fn as_ptr_returns_null_when_empty() {
        let rs = RenderState::new();
        assert!(rs.as_ptr().is_null());
    }

    #[test]
    fn as_ptr_returns_valid_pointer() {
        let mut world = World::new();
        world.spawn((ModelMatrix::default(), Active));

        let mut rs = RenderState::new();
        rs.collect(&world);
        assert!(!rs.as_ptr().is_null());

        // Read back via pointer
        let slice = unsafe { std::slice::from_raw_parts(rs.as_ptr(), 16) };
        // Default ModelMatrix is identity — element [0] should be 1.0
        assert_eq!(slice[0], 1.0);
    }

    #[test]
    fn collect_gpu_produces_entity_gpu_data() {
        let mut world = World::new();
        world.spawn((
            Position(Vec3::new(1.0, 2.0, 3.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            Velocity::default(),
            ModelMatrix::default(),
            BoundingRadius(0.5),
            TextureLayerIndex::default(),
            MeshHandle::default(),
            RenderPrimitive::default(),
            PrimitiveParams::default(),
            ExternalId(0),
            Active,
        ));

        // Run transform to compute the model matrix
        crate::systems::transform_system(&mut world);

        let mut state = RenderState::new();
        state.collect_gpu(&world);

        assert_eq!(state.gpu_entity_count(), 1);

        // SoA: transforms has 16 f32 for one entity
        let transforms = state.gpu_transforms();
        assert_eq!(transforms.len(), 16);

        // Model matrix translation (column-major: indices 12, 13, 14)
        assert_eq!(transforms[12], 1.0); // pos.x
        assert_eq!(transforms[13], 2.0); // pos.y
        assert_eq!(transforms[14], 3.0); // pos.z

        // SoA: bounds has 4 f32 for one entity
        let bounds = state.gpu_bounds();
        assert_eq!(bounds.len(), 4);
        assert_eq!(bounds[0], 1.0); // pos.x
        assert_eq!(bounds[1], 2.0); // pos.y
        assert_eq!(bounds[2], 3.0); // pos.z
        assert_eq!(bounds[3], 0.5); // radius

        // Texture indices
        assert_eq!(state.gpu_tex_indices().len(), 1);
    }

    #[test]
    fn collect_gpu_multiple_entities() {
        let mut world = World::new();
        for i in 0..3 {
            world.spawn((
                Position(Vec3::new(i as f32, 0.0, 0.0)),
                Rotation(Quat::IDENTITY),
                Scale(Vec3::ONE),
                Velocity::default(),
                ModelMatrix::default(),
                BoundingRadius(1.0),
                TextureLayerIndex::default(),
                MeshHandle::default(),
                RenderPrimitive::default(),
                PrimitiveParams::default(),
                ExternalId(i as u32),
                Active,
            ));
        }
        crate::systems::transform_system(&mut world);

        let mut state = RenderState::new();
        state.collect_gpu(&world);

        assert_eq!(state.gpu_entity_count(), 3);
        assert_eq!(state.gpu_transforms().len(), 48); // 3 * 16
        assert_eq!(state.gpu_bounds().len(), 12);      // 3 * 4
        assert_eq!(state.gpu_render_meta().len(), 6);  // 3 * 2
        assert_eq!(state.gpu_tex_indices().len(), 3);  // 3 * 1
        assert_eq!(state.gpu_prim_params().len(), 24);   // 3 * 8
    }

    #[test]
    fn collect_gpu_skips_entities_without_bounding_radius() {
        let mut world = World::new();
        // Full entity with all required components
        world.spawn((
            Position(Vec3::ZERO),
            Rotation::default(),
            Scale::default(),
            Velocity::default(),
            ModelMatrix::default(),
            BoundingRadius(1.0),
            TextureLayerIndex::default(),
            MeshHandle::default(),
            RenderPrimitive::default(),
            PrimitiveParams::default(),
            ExternalId(0),
            Active,
        ));
        // Entity missing BoundingRadius, MeshHandle, RenderPrimitive — visible to collect() but not collect_gpu()
        world.spawn((
            Position(Vec3::ZERO),
            Rotation::default(),
            Scale::default(),
            Velocity::default(),
            ModelMatrix::default(),
            Active,
        ));

        let mut state = RenderState::new();
        state.collect(&world);
        assert_eq!(state.count(), 2);

        state.collect_gpu(&world);
        assert_eq!(state.gpu_entity_count(), 1);
    }

    #[test]
    fn collect_gpu_gathers_texture_layer_indices() {
        let mut world = World::new();
        world.spawn((
            Position(Vec3::new(1.0, 0.0, 0.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            Velocity::default(),
            ModelMatrix::default(),
            BoundingRadius(0.5),
            TextureLayerIndex((2 << 16) | 10), // tier 2, layer 10
            MeshHandle::default(),
            RenderPrimitive::default(),
            PrimitiveParams::default(),
            ExternalId(0),
            Active,
        ));
        world.spawn((
            Position(Vec3::new(2.0, 0.0, 0.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            Velocity::default(),
            ModelMatrix::default(),
            BoundingRadius(0.5),
            TextureLayerIndex(0), // default
            MeshHandle::default(),
            RenderPrimitive::default(),
            PrimitiveParams::default(),
            ExternalId(1),
            Active,
        ));
        crate::systems::transform_system(&mut world);

        let mut state = RenderState::new();
        state.collect_gpu(&world);

        assert_eq!(state.gpu_entity_count(), 2);
        let indices = state.gpu_tex_indices();
        assert_eq!(indices.len(), 2);
        // Order depends on hecs archetype iteration, but both values should be present
        assert!(indices.contains(&((2 << 16) | 10)));
        assert!(indices.contains(&0));
    }

    #[test]
    fn gpu_tex_indices_empty_when_no_entities() {
        let world = World::new();
        let mut state = RenderState::new();
        state.collect_gpu(&world);
        assert!(state.gpu_tex_indices().is_empty());
        assert!(state.gpu_tex_indices_ptr().is_null());
    }

    // --- New SoA-specific tests ---

    #[test]
    fn collect_gpu_soa_produces_separate_buffers() {
        let mut world = World::new();
        world.spawn((
            Position(Vec3::new(1.0, 2.0, 3.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix(glam::Mat4::from_translation(Vec3::new(1.0, 2.0, 3.0)).to_cols_array()),
            BoundingRadius(0.5),
            TextureLayerIndex(0),
            MeshHandle::default(),
            RenderPrimitive::default(),
            PrimitiveParams::default(),
            ExternalId(0),
            Active,
        ));

        let mut rs = RenderState::new();
        rs.collect_gpu(&world);

        assert_eq!(rs.gpu_entity_count(), 1);
        assert_eq!(rs.gpu_transforms().len(), 16);
        assert_eq!(rs.gpu_bounds().len(), 4);
        assert_eq!(rs.gpu_render_meta().len(), 2);
        assert_eq!(rs.gpu_tex_indices().len(), 1);
    }

    #[test]
    fn soa_bounds_contain_position_and_radius() {
        let mut world = World::new();
        world.spawn((
            Position(Vec3::new(10.0, 20.0, 30.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix(glam::Mat4::IDENTITY.to_cols_array()),
            BoundingRadius(2.5),
            TextureLayerIndex(0),
            MeshHandle::default(),
            RenderPrimitive::default(),
            PrimitiveParams::default(),
            ExternalId(0),
            Active,
        ));

        let mut rs = RenderState::new();
        rs.collect_gpu(&world);
        let bounds = rs.gpu_bounds();
        assert_eq!(bounds[0], 10.0);
        assert_eq!(bounds[1], 20.0);
        assert_eq!(bounds[2], 30.0);
        assert_eq!(bounds[3], 2.5);
    }

    #[test]
    fn soa_render_meta_packs_mesh_and_primitive() {
        let mut world = World::new();
        world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix(glam::Mat4::IDENTITY.to_cols_array()),
            BoundingRadius(0.5),
            TextureLayerIndex(0),
            MeshHandle(7),
            RenderPrimitive(2),
            PrimitiveParams::default(),
            ExternalId(0),
            Active,
        ));

        let mut rs = RenderState::new();
        rs.collect_gpu(&world);
        let meta = rs.gpu_render_meta();
        assert_eq!(meta[0], 7);
        assert_eq!(meta[1], 2);
    }

    // --- BitSet tests ---

    #[test]
    fn bitset_set_and_get() {
        let mut bs = BitSet::new(128);
        assert!(!bs.get(0));
        assert!(!bs.get(63));
        assert!(!bs.get(64));
        bs.set(0);
        bs.set(63);
        bs.set(64);
        assert!(bs.get(0));
        assert!(bs.get(63));
        assert!(bs.get(64));
        assert_eq!(bs.count(), 3);
    }

    #[test]
    fn bitset_set_idempotent() {
        let mut bs = BitSet::new(64);
        bs.set(10);
        bs.set(10);
        bs.set(10);
        assert_eq!(bs.count(), 1);
    }

    #[test]
    fn bitset_get_out_of_bounds() {
        let bs = BitSet::new(64);
        assert!(!bs.get(9999));
    }

    #[test]
    fn bitset_clear() {
        let mut bs = BitSet::new(128);
        bs.set(0);
        bs.set(64);
        bs.set(127);
        assert_eq!(bs.count(), 3);
        bs.clear();
        assert_eq!(bs.count(), 0);
        assert!(!bs.get(0));
        assert!(!bs.get(64));
        assert!(!bs.get(127));
    }

    #[test]
    fn bitset_ensure_capacity_grows() {
        let mut bs = BitSet::new(64);
        // Setting beyond initial capacity should auto-grow
        bs.set(200);
        assert!(bs.get(200));
        assert_eq!(bs.count(), 1);
    }

    // --- DirtyTracker tests ---

    #[test]
    fn dirty_tracker_marks_transform_dirty() {
        let mut tracker = DirtyTracker::new(100);
        assert!(!tracker.is_transform_dirty(0));
        tracker.mark_transform_dirty(0);
        assert!(tracker.is_transform_dirty(0));
    }

    #[test]
    fn dirty_tracker_clear_resets_all() {
        let mut tracker = DirtyTracker::new(100);
        tracker.mark_transform_dirty(0);
        tracker.mark_transform_dirty(50);
        tracker.mark_bounds_dirty(25);
        tracker.clear();
        assert!(!tracker.is_transform_dirty(0));
        assert!(!tracker.is_transform_dirty(50));
        assert!(!tracker.is_bounds_dirty(25));
    }

    #[test]
    fn dirty_tracker_dirty_ratio() {
        let mut tracker = DirtyTracker::new(100);
        for i in 0..30 {
            tracker.mark_transform_dirty(i);
        }
        assert!((tracker.transform_dirty_ratio(100) - 0.3).abs() < 0.01);
    }

    #[test]
    fn dirty_tracker_ensure_capacity_pre_sizes_bitsets() {
        let mut tracker = DirtyTracker::new(0);
        // Start with zero capacity — marking should still work (BitSet auto-grows),
        // but ensure_capacity avoids repeated small allocations.
        tracker.ensure_capacity(256);
        tracker.mark_transform_dirty(200);
        tracker.mark_bounds_dirty(200);
        tracker.mark_meta_dirty(200);
        assert!(tracker.is_transform_dirty(200));
        assert!(tracker.is_bounds_dirty(200));
        assert!(tracker.is_meta_dirty(200));
    }

    #[test]
    fn dirty_tracker_is_meta_dirty() {
        let mut tracker = DirtyTracker::new(100);
        assert!(!tracker.is_meta_dirty(5));
        tracker.mark_meta_dirty(5);
        assert!(tracker.is_meta_dirty(5));
        assert!(!tracker.is_meta_dirty(6));
    }

    #[test]
    fn render_state_shrink_to_fit() {
        let mut state = RenderState::new();

        for _ in 0..1000 {
            state.gpu_transforms.extend_from_slice(&[0.0; 16]);
            state.gpu_bounds.extend_from_slice(&[0.0; 4]);
            state.gpu_render_meta.extend_from_slice(&[0u32; 2]);
            state.gpu_tex_indices.push(0);
            state.gpu_prim_params.extend_from_slice(&[0.0; 8]);
        }

        state.gpu_transforms.clear();
        state.gpu_bounds.clear();
        state.gpu_render_meta.clear();
        state.gpu_tex_indices.clear();
        state.gpu_prim_params.clear();

        let old_transform_cap = state.gpu_transforms.capacity();
        let old_prim_cap = state.gpu_prim_params.capacity();
        state.shrink_to_fit();
        assert!(state.gpu_transforms.capacity() < old_transform_cap);
        assert!(state.gpu_prim_params.capacity() < old_prim_cap);
    }

    #[test]
    fn collect_gpu_includes_prim_params() {
        let mut world = World::new();
        let mut pp = PrimitiveParams::default();
        pp.0[0] = 42.0;
        pp.0[7] = 99.0;

        world.spawn((
            Position(glam::Vec3::ZERO),
            ModelMatrix([1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]),
            BoundingRadius(1.0),
            TextureLayerIndex(0),
            MeshHandle(0),
            RenderPrimitive(0),
            pp,
            ExternalId(0),
            Active,
        ));

        let mut rs = RenderState::new();
        rs.collect_gpu(&world);

        assert_eq!(rs.gpu_entity_count(), 1);
        let params = rs.gpu_prim_params();
        assert_eq!(params.len(), 8); // 8 f32 per entity
        assert_eq!(params[0], 42.0);
        assert_eq!(params[7], 99.0);
    }

    #[test]
    fn dirty_tracker_meta_dirty_ratio() {
        let mut tracker = DirtyTracker::new(100);
        assert_eq!(tracker.meta_dirty_ratio(0), 0.0);
        for i in 0..50 {
            tracker.mark_meta_dirty(i);
        }
        assert!((tracker.meta_dirty_ratio(100) - 0.5).abs() < 0.01);
    }

    #[test]
    fn collect_gpu_includes_entity_ids() {
        use crate::command_processor::{process_commands, EntityMap};
        use crate::ring_buffer::{Command, CommandType};

        let mut world = World::new();
        let mut entity_map = EntityMap::new();
        let mut rs = RenderState::new();

        // Spawn two entities with external IDs 10 and 20
        for &ext_id in &[10u32, 20] {
            let cmd = Command {
                cmd_type: CommandType::SpawnEntity,
                entity_id: ext_id,
                payload: [0u8; 16],
            };
            process_commands(&[cmd], &mut world, &mut entity_map, &mut rs);
        }

        let mut state = RenderState::new();
        state.collect_gpu(&world);

        assert_eq!(state.gpu_entity_count(), 2);
        assert_eq!(state.gpu_entity_ids().len(), 2);
        // Order may vary (hecs iteration), but both IDs must be present
        let mut ids = state.gpu_entity_ids().to_vec();
        ids.sort();
        assert_eq!(ids, vec![10, 20]);
    }

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

    #[test]
    fn collect_dirty_staging_writes_only_dirty_slots() {
        let mut rs = RenderState::new();
        let mut world = World::new();

        let e0 = world.spawn((
            Position(Vec3::new(1.0, 0.0, 0.0)),
            Rotation::default(),
            Scale(Vec3::ONE),
            Velocity::default(),
            ModelMatrix::default(),
            BoundingRadius(1.0),
            TextureLayerIndex(0),
            MeshHandle(0),
            RenderPrimitive(0),
            PrimitiveParams::default(),
            ExternalId(0),
            Parent::default(),
            Children::default(),
            Active,
        ));
        let e1 = world.spawn((
            Position(Vec3::new(2.0, 0.0, 0.0)),
            Rotation::default(),
            Scale(Vec3::ONE),
            Velocity::default(),
            ModelMatrix::default(),
            BoundingRadius(1.0),
            TextureLayerIndex(0),
            MeshHandle(0),
            RenderPrimitive(0),
            PrimitiveParams::default(),
            ExternalId(1),
            Parent::default(),
            Children::default(),
            Active,
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

    #[test]
    fn collect_dirty_staging_compressed_root() {
        let mut rs = RenderState::new();
        let mut world = World::new();

        let e = world.spawn((
            Position(Vec3::new(10.0, 20.0, 0.0)),
            Rotation(Quat::from_rotation_z(std::f32::consts::FRAC_PI_4)), // 45 degrees
            Scale(Vec3::new(2.0, 3.0, 1.0)),
            Velocity::default(),
            ModelMatrix::default(),
            BoundingRadius(1.0),
            TextureLayerIndex(0),
            MeshHandle(0),
            RenderPrimitive(0),
            PrimitiveParams::default(),
            ExternalId(0),
            Parent::default(), // u32::MAX = no parent = root
            Children::default(),
            Active,
        ));
        rs.assign_slot(e);

        // Clear dirty from assign, then mark dirty
        rs.dirty_tracker.clear();
        rs.dirty_tracker.mark_transform_dirty(0);
        rs.dirty_tracker.mark_bounds_dirty(0);

        let result = rs.collect_dirty_staging(&world);
        assert_eq!(result.dirty_count, 1);

        // Format flag at position 31 should be 0 (compressed)
        assert_eq!(result.staging[31], 0);

        // Position at [0..2]
        assert_eq!(f32::from_bits(result.staging[0]), 10.0);
        assert_eq!(f32::from_bits(result.staging[1]), 20.0);
        assert_eq!(f32::from_bits(result.staging[2]), 0.0);

        // Rotation angle at [3] — should be ~PI/4 (0.785...)
        let angle = f32::from_bits(result.staging[3]);
        assert!(
            (angle - std::f32::consts::FRAC_PI_4).abs() < 0.001,
            "expected ~PI/4, got {angle}"
        );

        // Scale at [4..5]
        assert_eq!(f32::from_bits(result.staging[4]), 2.0);
        assert_eq!(f32::from_bits(result.staging[5]), 3.0);

        // Padding [6..15] should be 0
        for i in 6..16 {
            assert_eq!(result.staging[i], 0, "padding at index {i} should be 0");
        }
    }

    #[test]
    fn collect_dirty_staging_precomputed_child() {
        let mut rs = RenderState::new();
        let mut world = World::new();

        // Parent entity
        let parent = world.spawn((
            Position(Vec3::new(100.0, 0.0, 0.0)),
            Rotation::default(),
            Scale(Vec3::ONE),
            Velocity::default(),
            ModelMatrix::default(),
            BoundingRadius(1.0),
            TextureLayerIndex(0),
            MeshHandle(0),
            RenderPrimitive(0),
            PrimitiveParams::default(),
            ExternalId(0),
            Parent::default(),
            Children::default(),
            Active,
        ));
        rs.assign_slot(parent);

        // Child entity with Parent(0) — not root
        let child = world.spawn((
            Position(Vec3::new(5.0, 0.0, 0.0)),
            Rotation::default(),
            Scale(Vec3::ONE),
            Velocity::default(),
            ModelMatrix::default(),
            BoundingRadius(1.0),
            TextureLayerIndex(0),
            MeshHandle(0),
            RenderPrimitive(0),
            PrimitiveParams::default(),
            ExternalId(1),
            Parent(0), // Has parent — child entity
            Children::default(),
            Active,
        ));
        rs.assign_slot(child);

        // Transform system to populate matrices
        transform_system(&mut world);

        // Clear and mark only child dirty
        rs.dirty_tracker.clear();
        rs.dirty_tracker.mark_transform_dirty(1);

        let result = rs.collect_dirty_staging(&world);
        assert_eq!(result.dirty_count, 1);

        // Format flag at position 31 should be 1 (pre-computed mat4x4)
        assert_eq!(result.staging[31], 1);

        // staging[0..16] should contain ModelMatrix values (translation at [12])
        assert_eq!(f32::from_bits(result.staging[12]), 5.0); // child's x position in mat4
    }
}
