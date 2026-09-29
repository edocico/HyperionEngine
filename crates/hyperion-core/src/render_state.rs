//! Collects render-ready data from the ECS into contiguous GPU-uploadable buffers.
//!
//! GPU data is laid out as Structure-of-Arrays (SoA): four independent buffers
//! (transforms, bounds, renderMeta, texIndices) instead of one interleaved buffer.
//! This enables partial upload, better GPU cache performance, and extensibility.

use hecs::World;

use crate::components::{
    Active, BoundingRadius, Depth, ExternalId, LightFlags, MeshHandle, ModelMatrix, Parent,
    Position, PrimitiveParams, RenderPrimitive, TextureLayerIndex, Transform2D, Transparent,
    RENDER_META_TRANSPARENT_BIT,
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
    gpu_depths: Vec<f32>,        // 1 f32/entity (Depth, else Position.z; read by nothing on the TS side)
    gpu_count: u32,

    /// Per-buffer dirty tracking for partial upload optimization.
    pub dirty_tracker: DirtyTracker,

    // Stable slot mapping (Phase 12: retained-mode GPU buffers)
    slot_to_entity: Vec<hecs::Entity>,
    entity_to_slot: Vec<u32>,         // indexed by entity.id(), u32::MAX = unassigned
    /// Despawns queued this frame, as `(entity, slot)` pairs.
    ///
    /// The slot is resolved by `queue_despawn()` at command time, while the
    /// entity is still live and `entity_to_slot` still points at it. Resolving
    /// it later (at flush time) was the 2026-07 P0-1 defect: hecs recycles
    /// `entity.id()` immediately on despawn, so a spawn later in the same frame
    /// overwrote the dead entity's `entity_to_slot` entry and the flush then
    /// evicted the *live* entity instead.
    pub(crate) pending_despawns: Vec<(hecs::Entity, u32)>,

    // Dirty staging cache (populated by collect_and_cache_dirty)
    staging_cache: Vec<u32>,
    staging_indices_cache: Vec<u32>,
    staging_dirty_count: u32,
    staging_dirty_ratio: f32,

    /// Raised when the slot -> entity mapping (so the entity-ids column)
    /// changed: `assign_slot`, a flush that removed a row, `collect_gpu`.
    /// `Engine::update` consumes it with `take_ids_changed` and bumps its
    /// ids generation at most once per frame (phase 5b §4.1).
    ids_changed: bool,
    /// Live rows whose render-meta word 1 has the Transparent bit (bit 8).
    /// Recounted by `recount_transparent`, never maintained incrementally.
    transparent_count: u32,
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
            gpu_depths: Vec::new(),
            gpu_count: 0,
            dirty_tracker: DirtyTracker::new(0),
            slot_to_entity: Vec::new(),
            entity_to_slot: Vec::new(),
            pending_despawns: Vec::new(),
            staging_cache: Vec::new(),
            staging_indices_cache: Vec::new(),
            staging_dirty_count: 0,
            staging_dirty_ratio: 0.0,
            ids_changed: false,
            transparent_count: 0,
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

    /// LEGACY full rebuild of the SoA buffers in hecs iteration order.
    ///
    /// `Engine::update` no longer calls this — the retained-slot path
    /// (`write_slot` + `collect_and_cache_dirty`) keeps the buffers current
    /// incrementally. It is kept for tests and for a one-shot full repopulate.
    ///
    /// It RESETS the stable slot mapping, because it re-packs every entity in
    /// archetype order: keeping the old `entity_to_slot` / `slot_to_entity`
    /// around left `get_slot` and `flush_pending_despawns` pointing at wrong or
    /// out-of-range slots (audit 2026-07, P3-1). Callers must treat every slot
    /// index they were holding as invalid afterwards.
    pub fn collect_gpu(&mut self, world: &World) {
        self.dirty_tracker.clear();
        // Every slot is re-packed in archetype order: the id column changes.
        self.ids_changed = true;
        // The slot mapping describes the OLD packing; leaving it in place made
        // every later `get_slot` lookup wrong (audit 2026-07, P3-1).
        self.slot_to_entity.clear();
        self.entity_to_slot.clear();
        self.pending_despawns.clear();

        self.gpu_transforms.clear();
        self.gpu_bounds.clear();
        self.gpu_render_meta.clear();
        self.gpu_tex_indices.clear();
        self.gpu_prim_params.clear();
        self.gpu_entity_ids.clear();
        self.gpu_depths.clear();

        // Pre-allocate based on previous frame's entity count to avoid reallocation.
        let hint = self.gpu_count as usize;
        self.gpu_transforms.reserve(hint * 16);
        self.gpu_bounds.reserve(hint * 4);
        self.gpu_render_meta.reserve(hint * 2);
        self.gpu_tex_indices.reserve(hint);
        self.gpu_prim_params.reserve(hint * 8);
        self.gpu_entity_ids.reserve(hint);
        self.gpu_depths.reserve(hint);
        self.dirty_tracker.ensure_capacity(hint);
        self.gpu_count = 0;

        for (entity, pos, matrix, radius, tex, mesh, prim, pp, ext_id, _active) in world
            .query::<(
                hecs::Entity,
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

            // Buffer C: RenderMeta (2 u32).
            // Bit 8 carries the Transparent flag and bits 9-31 the lighting
            // flags, exactly as `write_slot` does — the population paths used to
            // disagree here (audit 2026-07, P3-1).
            self.gpu_render_meta.push(mesh.0);
            let transparent_bit =
                u32::from(world.get::<&Transparent>(entity).is_ok()) * RENDER_META_TRANSPARENT_BIT;
            let light_bits = world
                .get::<&LightFlags>(entity)
                .map(|f| f.bits())
                .unwrap_or(0);
            self.gpu_render_meta
                .push(prim.0 as u32 | transparent_bit | light_bits);

            // Texture indices (1 u32)
            self.gpu_tex_indices.push(tex.0);

            // Primitive params (8 f32)
            self.gpu_prim_params.extend_from_slice(&pp.0);

            // Entity ID (1 u32)
            self.gpu_entity_ids.push(ext_id.0);

            // Depth (1 f32) — legacy path uses position.z as fallback
            self.gpu_depths.push(pos.0.z);

            // Rebuild the slot mapping for the new packing.
            let slot = self.gpu_count;
            if slot as usize >= self.slot_to_entity.len() {
                self.slot_to_entity
                    .resize((slot as usize + 1).next_power_of_two(), hecs::Entity::DANGLING);
            }
            self.slot_to_entity[slot as usize] = entity;
            let eid = entity.id() as usize;
            if eid >= self.entity_to_slot.len() {
                self.entity_to_slot.resize(eid + 1, u32::MAX);
            }
            self.entity_to_slot[eid] = slot;

            self.gpu_count += 1;
        }

        debug_assert_eq!(self.gpu_count as usize * 16, self.gpu_transforms.len());
        debug_assert_eq!(self.gpu_count as usize * 4, self.gpu_bounds.len());
        debug_assert_eq!(self.gpu_count as usize * 2, self.gpu_render_meta.len());
        debug_assert_eq!(self.gpu_count as usize, self.gpu_tex_indices.len());
        debug_assert_eq!(self.gpu_count as usize * 8, self.gpu_prim_params.len());
        debug_assert_eq!(self.gpu_count as usize, self.gpu_entity_ids.len());
        debug_assert_eq!(self.gpu_count as usize, self.gpu_depths.len());
        self.recount_transparent();
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

    /// Number of f32 values in the transforms buffer (16 per entity).
    pub fn gpu_transforms_f32_len(&self) -> u32 {
        self.gpu_count * 16
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

    /// Number of f32 values in the bounds buffer (4 per entity).
    pub fn gpu_bounds_f32_len(&self) -> u32 {
        self.gpu_count * 4
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

    /// Number of u32 values in the render meta buffer (2 per entity).
    pub fn gpu_render_meta_len(&self) -> u32 {
        self.gpu_count * 2
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
        self.gpu_count
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

    /// Number of f32 values in the primitive params buffer (8 per entity).
    pub fn gpu_prim_params_f32_len(&self) -> u32 {
        self.gpu_count * 8
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
        self.gpu_count
    }

    // --- SoA buffer accessors: depths ---

    /// Depth values, one f32 per GPU entity (parallel to other SoA buffers):
    /// a 2D entity's `Depth` (+depth, not composed with its parent's), else
    /// `Position.z`, else 0. Exported, but read by nothing on the TS side: the
    /// transparent sort keys on the world z in `entity-bounds` (phase 5b).
    pub fn gpu_depths(&self) -> &[f32] {
        &self.gpu_depths
    }

    /// Raw pointer to the depths buffer for WASM export. Returns null if empty.
    pub fn gpu_depths_ptr(&self) -> *const f32 {
        if self.gpu_depths.is_empty() {
            std::ptr::null()
        } else {
            self.gpu_depths.as_ptr()
        }
    }

    /// Number of f32 values in the depths buffer (same as gpu_entity_count).
    pub fn gpu_depths_f32_len(&self) -> usize {
        self.gpu_count as usize
    }

    /// Assign a stable GPU slot to an entity. Returns the slot index.
    ///
    /// Idempotent: an entity that already owns a valid slot gets that slot back
    /// instead of a second one. Before the 2026-07 audit a duplicate
    /// `SpawnEntity` for a live external id allocated a second slot and orphaned
    /// the first, which could then never be released (P2-4).
    pub fn assign_slot(&mut self, entity: hecs::Entity) -> u32 {
        if let Some(existing) = self.get_slot(entity) {
            return existing;
        }

        let slot = self.gpu_count;
        self.gpu_count += 1;
        // A new row: the id column gains an entry (phase 5b §4.1).
        self.ids_changed = true;

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

        // Grow SoA buffers to match. `Vec::resize` only grows when the target
        // length exceeds the current one — after despawns the buffers are longer
        // than `gpu_count * stride`, so a recycled slot would silently inherit
        // the previous occupant's bytes for every column the new entity has no
        // component for. Zero the slot explicitly (audit 2026-07, P3-3).
        self.gpu_transforms.resize((self.gpu_count as usize) * 16, 0.0);
        self.gpu_bounds.resize((self.gpu_count as usize) * 4, 0.0);
        self.gpu_render_meta.resize((self.gpu_count as usize) * 2, 0);
        self.gpu_tex_indices.resize(self.gpu_count as usize, 0);
        self.gpu_prim_params.resize((self.gpu_count as usize) * 8, 0.0);
        self.gpu_entity_ids.resize(self.gpu_count as usize, 0);
        self.gpu_depths.resize(self.gpu_count as usize, 0.0);
        self.clear_slot(slot);

        // Mark all dirty
        self.dirty_tracker.ensure_capacity(self.gpu_count as usize);
        self.dirty_tracker.mark_transform_dirty(slot as usize);
        self.dirty_tracker.mark_bounds_dirty(slot as usize);
        self.dirty_tracker.mark_meta_dirty(slot as usize);

        slot
    }

    /// Zero every SoA column of a slot so a recycled slot never leaks the
    /// previous occupant's data through columns the new entity doesn't write.
    fn clear_slot(&mut self, slot: u32) {
        let s = slot as usize;
        self.gpu_transforms[s * 16..s * 16 + 16].fill(0.0);
        self.gpu_bounds[s * 4..s * 4 + 4].fill(0.0);
        self.gpu_render_meta[s * 2..s * 2 + 2].fill(0);
        self.gpu_tex_indices[s] = 0;
        self.gpu_prim_params[s * 8..s * 8 + 8].fill(0.0);
        self.gpu_entity_ids[s] = 0;
        self.gpu_depths[s] = 0.0;
    }

    /// Write a world matrix into slot `s`, and centre the culling sphere on its
    /// translation.
    ///
    /// Both must be world-space. Taking the centre from `Position` or
    /// `Transform2D` instead is right only for a root: for a child those are
    /// local to the parent, and the sphere ended up somewhere the child is not,
    /// so the child could be culled while on screen.
    fn write_world_matrix(&mut self, s: usize, matrix: &[f32; 16]) {
        self.gpu_transforms[s * 16..s * 16 + 16].copy_from_slice(matrix);
        self.gpu_bounds[s * 4..s * 4 + 3].copy_from_slice(&matrix[12..15]);
    }

    /// Write all SoA data for an entity into its assigned slot.
    /// Used for initial population and dirty updates.
    pub fn write_slot(&mut self, slot: u32, world: &World, entity: hecs::Entity) {
        let s = slot as usize;

        if let Ok(matrix) = world.get::<&ModelMatrix>(entity) {
            self.write_world_matrix(s, &matrix.0);
        } else if let Ok(pos) = world.get::<&Position>(entity) {
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
        // Rebuild the word from scratch: the transparency and lighting bits must
        // never be OR-ed onto a stale value left by a previous occupant of this
        // slot, and an entity without `RenderPrimitive` must not keep a sticky
        // bit 8 (audit 2026-07, P3-2).
        let prim_word = world
            .get::<&RenderPrimitive>(entity)
            .map(|p| p.0 as u32)
            .unwrap_or(0);
        // Bit 8 = Transparent, bits 9-31 = LightFlags.
        let transparent_bit =
            u32::from(world.get::<&Transparent>(entity).is_ok()) * RENDER_META_TRANSPARENT_BIT;
        let light_bits = world
            .get::<&LightFlags>(entity)
            .map(|f| f.bits())
            .unwrap_or(0);
        self.gpu_render_meta[s * 2 + 1] = prim_word | transparent_bit | light_bits;

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

        // Depth: prefer Depth component, fall back to Position.z, else 0.0
        if let Ok(depth) = world.get::<&Depth>(entity) {
            self.gpu_depths[s] = depth.0;
        } else if let Ok(pos) = world.get::<&Position>(entity) {
            self.gpu_depths[s] = pos.0.z;
        } else {
            self.gpu_depths[s] = 0.0;
        }
    }

    /// Write all SoA data for a 2D entity (Transform2D archetype) into its assigned slot.
    ///
    /// A root builds its matrix directly from Transform2D, which is fresh even
    /// at command time, before the systems have run. A child cannot do that:
    /// its Transform2D is local to the parent. Its world matrix is the
    /// ModelMatrix that `propagate_transforms` composes.
    pub fn write_slot_2d(&mut self, slot: u32, world: &World, entity: hecs::Entity) {
        let s = slot as usize;

        let parented = world
            .get::<&Parent>(entity)
            .map(|p| p.0 != u32::MAX)
            .unwrap_or(false);
        if parented {
            if let Ok(matrix) = world.get::<&ModelMatrix>(entity) {
                self.write_world_matrix(s, &matrix.0);
            }
        } else if let Ok(transform) = world.get::<&Transform2D>(entity) {
            let (sin, cos) = transform.rot.sin_cos();
            let z = world.get::<&Depth>(entity).map_or(0.0, |d| d.z());
            let t = s * 16;
            // Column-major 4x4 (same format as transform_system_2d in systems.rs)
            self.gpu_transforms[t]     = transform.sx * cos;
            self.gpu_transforms[t + 1] = transform.sx * sin;
            self.gpu_transforms[t + 2] = 0.0;
            self.gpu_transforms[t + 3] = 0.0;
            self.gpu_transforms[t + 4] = -transform.sy * sin;
            self.gpu_transforms[t + 5] = transform.sy * cos;
            self.gpu_transforms[t + 6] = 0.0;
            self.gpu_transforms[t + 7] = 0.0;
            self.gpu_transforms[t + 8] = 0.0;
            self.gpu_transforms[t + 9] = 0.0;
            self.gpu_transforms[t + 10] = 1.0;
            self.gpu_transforms[t + 11] = 0.0;
            self.gpu_transforms[t + 12] = transform.x;
            self.gpu_transforms[t + 13] = transform.y;
            self.gpu_transforms[t + 14] = z;
            self.gpu_transforms[t + 15] = 1.0;

            // Bounds from Transform2D position
            let b = s * 4;
            self.gpu_bounds[b] = transform.x;
            self.gpu_bounds[b + 1] = transform.y;
            self.gpu_bounds[b + 2] = z;
        }

        // Remaining SoA fields are identical to write_slot()
        if let Ok(radius) = world.get::<&BoundingRadius>(entity) {
            self.gpu_bounds[s * 4 + 3] = radius.0;
        }
        if let Ok(mesh) = world.get::<&MeshHandle>(entity) {
            self.gpu_render_meta[s * 2] = mesh.0;
        }
        // Rebuild the word from scratch: the transparency and lighting bits must
        // never be OR-ed onto a stale value left by a previous occupant of this
        // slot, and an entity without `RenderPrimitive` must not keep a sticky
        // bit 8 (audit 2026-07, P3-2).
        let prim_word = world
            .get::<&RenderPrimitive>(entity)
            .map(|p| p.0 as u32)
            .unwrap_or(0);
        // Bit 8 = Transparent, bits 9-31 = LightFlags.
        let transparent_bit =
            u32::from(world.get::<&Transparent>(entity).is_ok()) * RENDER_META_TRANSPARENT_BIT;
        let light_bits = world
            .get::<&LightFlags>(entity)
            .map(|f| f.bits())
            .unwrap_or(0);
        self.gpu_render_meta[s * 2 + 1] = prim_word | transparent_bit | light_bits;
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

        // 2D entities: prefer Depth component, else 0.0
        if let Ok(depth) = world.get::<&Depth>(entity) {
            self.gpu_depths[s] = depth.0;
        } else {
            self.gpu_depths[s] = 0.0;
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

        let mut queued: Vec<(hecs::Entity, u32)> = std::mem::take(&mut self.pending_despawns);

        // Sort descending so highest-numbered slots are removed first.
        // This guarantees that when we swap the "last" entity into the dead slot,
        // "last" is always a live entity (not one pending removal).
        queued.sort_unstable_by_key(|&(_, slot)| std::cmp::Reverse(slot));
        // A slot can only be released once. A duplicate would swap-remove an
        // already-dead slot and hand a live entity an out-of-range index, which
        // later panicked in `copy_soa_slot` — a WASM trap (audit 2026-07, P0-2).
        queued.dedup_by_key(|(_, slot)| *slot);

        for (dead_entity, slot) in queued {
            // Defensive: `gpu_count` can have shrunk below a queued slot if the
            // caller queued the same entity twice through different paths.
            if self.gpu_count == 0 || slot >= self.gpu_count {
                continue;
            }
            let last = self.gpu_count - 1;
            // A row leaves: the id at `slot` becomes the moved entity's, or the
            // column just shrinks (phase 5b §4.1).
            self.ids_changed = true;

            // Clear the dead entity's mapping FIRST. If the entity that gets
            // swapped into this slot shares `entity.id()` with the dead one
            // (same id, newer generation — hecs recycles ids), clearing after
            // the swap would wipe the live entity's mapping.
            let dead_id = dead_entity.id() as usize;
            if dead_id < self.entity_to_slot.len() && self.entity_to_slot[dead_id] == slot {
                self.entity_to_slot[dead_id] = u32::MAX;
            }

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

            self.slot_to_entity[last as usize] = hecs::Entity::DANGLING;
            self.gpu_count -= 1;
        }
    }

    /// Queue an entity for slot release at the next `flush_pending_despawns()`.
    ///
    /// MUST be called while the entity is still live in the world — it resolves
    /// the GPU slot immediately, because hecs recycles `entity.id()` the moment
    /// `world.despawn()` returns.
    pub fn queue_despawn(&mut self, entity: hecs::Entity) {
        if let Some(slot) = self.get_slot(entity) {
            self.pending_despawns.push((entity, slot));
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

        // depths: 1 f32 per slot
        self.gpu_depths[d] = self.gpu_depths[s];
    }

    /// Look up the GPU slot for an entity. Returns None if not assigned.
    ///
    /// `entity_to_slot` is keyed by `entity.id()`, which hecs recycles across
    /// despawns, so the candidate slot is validated against `slot_to_entity`.
    /// `hecs::Entity` equality includes the generation, so a stale entity whose
    /// id now belongs to a different entity resolves to `None` rather than to
    /// the live entity's slot (audit 2026-07, P0-1).
    pub fn get_slot(&self, entity: hecs::Entity) -> Option<u32> {
        let eid = entity.id() as usize;
        if eid >= self.entity_to_slot.len() {
            return None;
        }
        let slot = self.entity_to_slot[eid];
        if slot == u32::MAX || slot >= self.gpu_count {
            return None;
        }
        if self.slot_to_entity.get(slot as usize) != Some(&entity) {
            return None;
        }
        Some(slot)
    }

    /// Collect dirty entity data into a compact staging buffer for GPU scatter upload.
    /// Call flush_pending_despawns() before this.
    pub fn collect_dirty_staging(&mut self, world: &World) -> DirtyStagingResult {
        let total = self.gpu_count as usize;
        if total == 0 {
            // The early return used to skip the `clear()` below, so dirty bits
            // set before the last entity was despawned survived into the next
            // frame and were inherited by whichever entities took those slots
            // (audit 2026-07, P2-9).
            self.dirty_tracker.clear();
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

            // Detect archetype: 2D (Transform2D) vs 3D (Position+Rotation+Scale)
            let is_2d = world.get::<&Transform2D>(entity).is_ok();

            // First update SoA from world (in case systems modified components)
            if is_2d {
                self.write_slot_2d(slot, world, entity);
            } else {
                self.write_slot(slot, world, entity);
            }

            // Choose the wire format by what it can actually REPRESENT, not by
            // parentage.
            //
            // Format 0 carries pos(3) + a single z-rotation angle + scale.xy —
            // exactly the degrees of freedom a `Transform2D` has. It used to be
            // selected for every unparented entity, including 3D ones, so a root
            // 3D entity silently lost its X/Y rotation and its `scale.z`: the
            // correct mat4 `transform_system` had already computed was thrown
            // away and the GPU rebuilt an unrotated, unscaled quad
            // (audit 2026-07, P1-15).
            //
            // Format 1 is the full pre-computed mat4. Both branches emit exactly
            // 16 words, so correctness here costs no extra bandwidth.
            let is_root = is_2d
                && world
                    .get::<&Parent>(entity)
                    .map(|p| p.0 == u32::MAX)
                    .unwrap_or(true);

            if is_root {
                if is_2d {
                    // Compressed 2D format (format=0): read directly from Transform2D
                    let t2d = world
                        .get::<&Transform2D>(entity)
                        .map(|t| *t)
                        .unwrap_or_default();
                    let z = world.get::<&Depth>(entity).map_or(0.0, |d| d.z());
                    staging.push(t2d.x.to_bits());
                    staging.push(t2d.y.to_bits());
                    staging.push(z.to_bits()); // -depth (scatter.wgsl: pz)
                    staging.push(t2d.rot.to_bits());
                    staging.push(t2d.sx.to_bits());
                    staging.push(t2d.sy.to_bits());
                    // Padding: 10 zeros to reach offset 16
                    staging.extend(std::iter::repeat_n(0u32, 10));
                } else {
                    unreachable!("format 0 is only selected for Transform2D entities");
                }
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
        // After the dirty rows are rewritten: word 1 is current for every row.
        self.recount_transparent();
    }

    /// Recount the live rows whose render-meta word 1 has bit 8
    /// (`RENDER_META_TRANSPARENT_BIT`) set (phase 5b §4.1, D9).
    ///
    /// A recount, not a running counter: `clear_slot` runs after
    /// `gpu_count += 1` on a row that can still hold a stale bit 8 from an
    /// earlier swap-remove, and the `Transparent` component is one frame ahead
    /// of the row, so a counter would carry two invariants. Bounded by
    /// `gpu_count`: the rows past it keep the data of despawned entities (the
    /// `gpu_render_meta()` accessor returns them too). Transparent Light2D rows
    /// count as well, so this is an upper bound of what the transparent sort
    /// gathers — which is all it has to be: it only sizes the gather.
    pub fn recount_transparent(&mut self) {
        let n = self.gpu_count as usize;
        self.transparent_count = self.gpu_render_meta[..n * 2]
            .chunks_exact(2)
            .filter(|row| row[1] & RENDER_META_TRANSPARENT_BIT != 0)
            .count() as u32;
    }

    /// Live rows with the Transparent bit, as of the last `recount_transparent`.
    pub fn transparent_count(&self) -> u32 {
        self.transparent_count
    }

    /// Whether the slot -> entity mapping changed since the last call, and
    /// reset the flag. `Engine::update` calls it once per frame.
    pub fn take_ids_changed(&mut self) -> bool {
        std::mem::take(&mut self.ids_changed)
    }

    /// Pointer to the staging cache buffer for WASM export.
    ///
    /// VALID FOR ONE FRAME: `collect_and_cache_dirty` rebuilds the `Vec` every
    /// frame, so the address changes. Read it after each `engine_update()` and
    /// never cache it. Returns null when there is nothing to upload — it used to
    /// return a dangling non-null pointer that passed a JS `if (ptr)` guard
    /// (audit 2026-07, P2-5).
    pub fn staging_ptr(&self) -> *const u32 {
        if self.staging_cache.is_empty() {
            std::ptr::null()
        } else {
            self.staging_cache.as_ptr()
        }
    }

    /// Number of u32 values in the staging cache buffer.
    pub fn staging_u32_len(&self) -> u32 {
        self.staging_cache.len() as u32
    }

    /// Pointer to the dirty indices cache buffer for WASM export.
    ///
    /// Same one-frame lifetime as `staging_ptr`; null when empty.
    pub fn staging_indices_ptr(&self) -> *const u32 {
        if self.staging_indices_cache.is_empty() {
            std::ptr::null()
        } else {
            self.staging_indices_cache.as_ptr()
        }
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
    ///
    /// INVALIDATES EVERY `engine_gpu_*_ptr()` PREVIOUSLY HANDED TO JS: every
    /// `Vec` here may reallocate. Re-read the pointers after calling it.
    ///
    /// Before the 2026-07 audit this claimed to shrink "all internal buffers"
    /// while skipping the slot maps and staging caches, and it left the
    /// post-despawn dead tail counted as live length — reclaiming far less than
    /// advertised (P2-5).
    pub fn shrink_to_fit(&mut self) {
        // Drop the dead tail first: after swap-remove despawns the SoA Vecs are
        // longer than `gpu_count * stride`.
        let n = self.gpu_count as usize;
        self.gpu_transforms.truncate(n * 16);
        self.gpu_bounds.truncate(n * 4);
        self.gpu_render_meta.truncate(n * 2);
        self.gpu_tex_indices.truncate(n);
        self.gpu_prim_params.truncate(n * 8);
        self.gpu_entity_ids.truncate(n);
        self.gpu_depths.truncate(n);
        self.slot_to_entity.truncate(n);
        self.slot_to_entity.shrink_to_fit();
        self.staging_cache.shrink_to_fit();
        self.staging_indices_cache.shrink_to_fit();
        if let Some(last) = self.entity_to_slot.iter().rposition(|&s| s != u32::MAX) {
            self.entity_to_slot.truncate(last + 1);
        } else {
            self.entity_to_slot.clear();
        }
        self.entity_to_slot.shrink_to_fit();

        self.matrices.shrink_to_fit();
        self.gpu_transforms.shrink_to_fit();
        self.gpu_bounds.shrink_to_fit();
        self.gpu_render_meta.shrink_to_fit();
        self.gpu_tex_indices.shrink_to_fit();
        self.gpu_prim_params.shrink_to_fit();
        self.gpu_entity_ids.shrink_to_fit();
        self.gpu_depths.shrink_to_fit();
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
            #[cfg(feature = "physics-2d")]
            {
                let mut physics = crate::physics::HyperionPhysicsWorld::new();
                process_commands(&[cmd], &mut world, &mut entity_map, &mut rs, &mut physics);
            }
            #[cfg(not(feature = "physics-2d"))]
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
        rs.queue_despawn(e1);
        rs.flush_pending_despawns();

        assert_eq!(rs.gpu_entity_count(), 2);
        assert_eq!(rs.get_slot(e0), Some(0));
        assert_eq!(rs.get_slot(e2), Some(1)); // e2 moved to slot 1
        assert_eq!(rs.get_slot(e1), None);    // e1 gone
        // e2's data now at slot 1
        assert_eq!(rs.gpu_bounds[4], 77.0);
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
        rs.queue_despawn(entities[1]);
        rs.queue_despawn(entities[3]);
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
        // A child: its Position is local (1, 2), its world matrix puts it at (5, 10).
        let mut world_matrix = [0.0f32; 16];
        world_matrix[0] = 1.0;
        world_matrix[5] = 1.0;
        world_matrix[10] = 1.0;
        world_matrix[15] = 1.0;
        world_matrix[12] = 5.0;
        world_matrix[13] = 10.0;
        let e = world.spawn((
            Position(Vec3::new(1.0, 2.0, 0.0)),
            Rotation::default(),
            Scale(Vec3::ONE),
            ModelMatrix(world_matrix),
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

        // The culling sphere is centred on the WORLD translation, not on the
        // local Position, and has radius 2.
        assert_eq!(rs.gpu_bounds[slot as usize * 4], 5.0);
        assert_eq!(rs.gpu_bounds[slot as usize * 4 + 1], 10.0);
        assert_eq!(rs.gpu_bounds[slot as usize * 4 + 3], 2.0);
        assert_eq!(&rs.gpu_transforms[slot as usize * 16..slot as usize * 16 + 16], &world_matrix);
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
        rs.queue_despawn(e1);
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
        // Audit 2026-07 (P1-15): format 0 is chosen by REPRESENTABILITY, so it
        // now applies only to `Transform2D` roots — the archetype whose degrees
        // of freedom it can actually carry. A root 3D entity gets format 1.
        let mut rs = RenderState::new();
        let mut world = World::new();
        let e = world.spawn((
            Transform2D {
                x: 10.0,
                y: 20.0,
                rot: std::f32::consts::FRAC_PI_4,
                sx: 2.0,
                sy: 3.0,
            },
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

        rs.dirty_tracker.clear();
        rs.dirty_tracker.mark_transform_dirty(0);
        rs.dirty_tracker.mark_bounds_dirty(0);

        let result = rs.collect_dirty_staging(&world);
        assert_eq!(result.dirty_count, 1);
        assert_eq!(result.staging.len(), 32);

        // Format flag at position 31 should be 0 (compressed 2D)
        assert_eq!(result.staging[31], 0);
        assert_eq!(f32::from_bits(result.staging[0]), 10.0);
        assert_eq!(f32::from_bits(result.staging[1]), 20.0);
        assert_eq!(f32::from_bits(result.staging[2]), 0.0);
        let angle = f32::from_bits(result.staging[3]);
        assert!((angle - std::f32::consts::FRAC_PI_4).abs() < 1e-5, "angle was {angle}");
        assert_eq!(f32::from_bits(result.staging[4]), 2.0);
        assert_eq!(f32::from_bits(result.staging[5]), 3.0);
    }

    /// A root 3D entity must travel as a full mat4: the compressed format has no
    /// room for X/Y rotation or scale.z (audit 2026-07, P1-15).
    #[test]
    fn collect_dirty_staging_3d_root_uses_full_matrix() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let e = world.spawn((
            Position(Vec3::new(1.0, 2.0, 3.0)),
            Rotation(Quat::from_rotation_x(std::f32::consts::FRAC_PI_2)),
            Scale(Vec3::new(1.0, 1.0, 5.0)),
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
        crate::systems::transform_system(&mut world);
        rs.assign_slot(e);
        rs.dirty_tracker.clear();
        rs.dirty_tracker.mark_transform_dirty(0);

        let result = rs.collect_dirty_staging(&world);
        assert_eq!(result.staging[31], 1, "3D roots must use the mat4 format");
        // The staged matrix must be the real one, scale.z and X rotation included.
        let staged: Vec<f32> = result.staging[..16].iter().map(|b| f32::from_bits(*b)).collect();
        let truth = world.get::<&ModelMatrix>(e).unwrap().0;
        for i in 0..16 {
            assert!((staged[i] - truth[i]).abs() < 1e-5,
                "column word {i}: staged {} vs real {}", staged[i], truth[i]);
        }
        assert!(staged[9].abs() > 4.0, "scale.z must survive, got {}", staged[9]);
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

    #[test]
    fn write_slot_works_for_2d_entity() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let ent = world.spawn((
            Transform2D { x: 50.0, y: 75.0, rot: 0.0, sx: 1.0, sy: 1.0 },
            ModelMatrix([0.0; 16]),
            BoundingRadius(10.0),
            Active,
            ExternalId(1),
        ));
        let slot = rs.assign_slot(ent);
        rs.write_slot_2d(slot, &world, ent);
        // Verify transforms written correctly (identity rotation, unit scale)
        let t = slot as usize * 16;
        assert_eq!(rs.gpu_transforms[t], 1.0);      // sx*cos(0) = 1
        assert_eq!(rs.gpu_transforms[t + 5], 1.0);  // sy*cos(0) = 1
        assert_eq!(rs.gpu_transforms[t + 12], 50.0); // x
        assert_eq!(rs.gpu_transforms[t + 13], 75.0); // y
        // Verify bounds
        let b = slot as usize * 4;
        assert_eq!(rs.gpu_bounds[b], 50.0);
        assert_eq!(rs.gpu_bounds[b + 1], 75.0);
        assert_eq!(rs.gpu_bounds[b + 2], 0.0);
        assert_eq!(rs.gpu_bounds[b + 3], 10.0);
        assert!(rs.gpu_entity_count() >= 1);
    }

    #[test]
    fn write_slot_encodes_transparent_in_render_meta() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let ent = world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            RenderPrimitive(3),
            Active,
            ExternalId(42),
            Transparent(1),
        ));
        let slot = rs.assign_slot(ent);
        rs.write_slot(slot, &world, ent);
        let meta = rs.gpu_render_meta[slot as usize * 2 + 1];
        assert_eq!(meta & 0xFF, 3);      // primType
        assert_eq!(meta & 0x100, 0x100);  // transparent bit
    }

    #[test]
    fn write_slot_no_transparent_flag_when_absent() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let ent = world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            RenderPrimitive(3),
            Active,
            ExternalId(42),
        ));
        let slot = rs.assign_slot(ent);
        rs.write_slot(slot, &world, ent);
        let meta = rs.gpu_render_meta[slot as usize * 2 + 1];
        assert_eq!(meta & 0xFF, 3);
        assert_eq!(meta & 0x100, 0);
    }

    // --- Phase 17: renderMeta lighting bits (9-31) ---
    //
    // These assert against literal bit positions on purpose. The constants in
    // `components.rs` and the WGSL that decodes this word are two independent
    // declarations of the same layout; a test written in terms of the constants
    // would follow a mistake in them instead of catching it.

    /// Spawn a 3D drawable carrying `flags`, write it, return renderMeta word 1.
    fn meta_word_for(flags: Option<LightFlags>, prim: u8) -> u32 {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let ent = world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            RenderPrimitive(prim),
            Active,
            ExternalId(7),
        ));
        if let Some(f) = flags {
            world.insert_one(ent, f).unwrap();
        }
        let slot = rs.assign_slot(ent);
        rs.write_slot(slot, &world, ent);
        rs.gpu_render_meta[slot as usize * 2 + 1]
    }

    #[test]
    fn light_flags_absent_leaves_bits_9_31_clear() {
        let meta = meta_word_for(None, 6);
        assert_eq!(meta & 0xFF, 6, "primType survives");
        assert_eq!(meta & 0xFFFF_FE00, 0, "no lighting bits set by default");
    }

    #[test]
    fn light_flags_round_trip_through_render_meta() {
        let flags = LightFlags::new(LightType::Spot, LightBlendMode::Mix, 0xBEEF);
        let meta = meta_word_for(Some(flags), 6);

        assert_eq!(meta & 0xFF, 6, "primType");
        assert_eq!((meta >> 11) & 0b111, LightType::Spot as u32);
        assert_eq!((meta >> 14) & 0b11, LightBlendMode::Mix as u32);
        assert_eq!(meta >> 16, 0xBEEF, "full 16 bits of lightMask");
    }

    #[test]
    fn light_mask_uses_all_sixteen_bits() {
        let flags = LightFlags::new(LightType::Point, LightBlendMode::Add, 0xFFFF);
        let meta = meta_word_for(Some(flags), 6);
        assert_eq!(meta >> 16, 0xFFFF);
        assert_eq!(LightFlags(meta).light_mask(), 0xFFFF);
    }

    #[test]
    fn shadow_and_receive_bits_are_independent_of_light_fields() {
        let mut flags = LightFlags::new(LightType::Directional, LightBlendMode::Sub, 0x00FF);
        flags.set_casts_shadow(true);
        let meta = meta_word_for(Some(flags), 0);

        assert_eq!(meta & (1 << 9), 1 << 9, "castsShadow");
        assert_eq!(meta & (1 << 10), 0, "receivesLight untouched");
        assert_eq!((meta >> 11) & 0b111, LightType::Directional as u32);
        assert_eq!((meta >> 14) & 0b11, LightBlendMode::Sub as u32);
        assert_eq!(meta >> 16, 0x00FF);
    }

    #[test]
    fn set_light_preserves_shadow_and_receive_bits() {
        let mut flags = LightFlags::default();
        flags.set_casts_shadow(true);
        flags.set_receives_light(true);
        flags.set_light(LightType::Global as u8, LightBlendMode::Mix as u8, 0x1234);

        assert!(flags.casts_shadow());
        assert!(flags.receives_light());
        assert_eq!(flags.light_type_raw(), LightType::Global as u8);
        assert_eq!(flags.blend_mode_raw(), LightBlendMode::Mix as u8);
        assert_eq!(flags.light_mask(), 0x1234);
    }

    #[test]
    fn transparent_bit_survives_alongside_light_flags() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let mut flags = LightFlags::new(LightType::Point, LightBlendMode::Add, 0x0003);
        flags.set_receives_light(true);
        let ent = world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            RenderPrimitive(4),
            Active,
            ExternalId(9),
            Transparent(1),
            flags,
        ));
        let slot = rs.assign_slot(ent);
        rs.write_slot(slot, &world, ent);
        let meta = rs.gpu_render_meta[slot as usize * 2 + 1];

        assert_eq!(meta & 0xFF, 4, "primType");
        assert_eq!(meta & (1 << 8), 1 << 8, "transparent");
        assert_eq!(meta & (1 << 10), 1 << 10, "receivesLight");
        assert_eq!(meta >> 16, 0x0003, "lightMask");
    }

    #[test]
    fn light_flags_cannot_corrupt_prim_type_or_transparent() {
        // A hand-built LightFlags with every bit set must still leave 0-8 alone.
        let meta = meta_word_for(Some(LightFlags(u32::MAX)), 5);
        assert_eq!(meta & 0xFF, 5, "primType not clobbered");
        assert_eq!(meta & (1 << 8), 0, "transparent not forged");
        assert_eq!(meta & 0xFFFF_FE00, 0xFFFF_FE00);
    }

    #[test]
    fn write_slot_2d_encodes_light_flags() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let flags = LightFlags::new(LightType::Sprite, LightBlendMode::Sub, 0x0F0F);
        let ent = world.spawn((
            Transform2D { x: 1.0, y: 2.0, rot: 0.0, sx: 1.0, sy: 1.0 },
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            RenderPrimitive(6),
            Active,
            ExternalId(11),
            flags,
        ));
        let slot = rs.assign_slot(ent);
        rs.write_slot_2d(slot, &world, ent);
        let meta = rs.gpu_render_meta[slot as usize * 2 + 1];

        assert_eq!(meta & 0xFF, 6);
        assert_eq!((meta >> 11) & 0b111, LightType::Sprite as u32);
        assert_eq!((meta >> 14) & 0b11, LightBlendMode::Sub as u32);
        assert_eq!(meta >> 16, 0x0F0F);
    }

    #[test]
    fn collect_gpu_agrees_with_write_slot_on_light_bits() {
        // The legacy path and the retained path are two separate encoders of the
        // same word; they diverged once already (audit 2026-07, P3-1).
        let mut world = World::new();
        let flags = LightFlags::new(LightType::Spot, LightBlendMode::Mix, 0xA5A5);
        let ent = world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            TextureLayerIndex(0),
            MeshHandle(0),
            RenderPrimitive(6),
            PrimitiveParams([0.0; 8]),
            ExternalId(3),
            Active,
            flags,
        ));

        let mut legacy = RenderState::new();
        legacy.collect_gpu(&world);
        let legacy_meta = legacy.gpu_render_meta[1];

        let mut retained = RenderState::new();
        let slot = retained.assign_slot(ent);
        retained.write_slot(slot, &world, ent);
        let retained_meta = retained.gpu_render_meta[slot as usize * 2 + 1];

        assert_eq!(legacy_meta, retained_meta);
        assert_eq!(retained_meta >> 16, 0xA5A5);
    }

    #[test]
    fn clear_slot_drops_light_flags_from_recycled_slot() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let lit = world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            RenderPrimitive(6),
            Active,
            ExternalId(1),
            LightFlags::new(LightType::Point, LightBlendMode::Add, 0xFFFF),
        ));
        let slot = rs.assign_slot(lit);
        rs.write_slot(slot, &world, lit);
        assert_ne!(rs.gpu_render_meta[slot as usize * 2 + 1] >> 16, 0);

        // A plain quad reusing the slot must not inherit the light's layers.
        let plain = world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            RenderPrimitive(0),
            Active,
            ExternalId(2),
        ));
        rs.write_slot(slot, &world, plain);
        assert_eq!(rs.gpu_render_meta[slot as usize * 2 + 1], 0);
    }

    // --- Depth SoA column tests ---

    #[test]
    fn write_slot_populates_depth_from_position_z() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let ent = world.spawn((
            Position(Vec3::new(10.0, 20.0, 42.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            Active,
            ExternalId(1),
        ));
        let slot = rs.assign_slot(ent);
        rs.write_slot(slot, &world, ent);
        assert_eq!(rs.gpu_depths[slot as usize], 42.0);
    }

    #[test]
    fn write_slot_prefers_depth_component_over_position_z() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let ent = world.spawn((
            Position(Vec3::new(10.0, 20.0, 42.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            Depth(99.0),
            Active,
            ExternalId(1),
        ));
        let slot = rs.assign_slot(ent);
        rs.write_slot(slot, &world, ent);
        assert_eq!(rs.gpu_depths[slot as usize], 99.0);
    }

    #[test]
    fn write_slot_2d_populates_depth_from_depth_component() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let ent = world.spawn((
            Transform2D { x: 10.0, y: 20.0, rot: 0.0, sx: 1.0, sy: 1.0 },
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            Depth(7.5),
            Active,
            ExternalId(1),
        ));
        let slot = rs.assign_slot(ent);
        rs.write_slot_2d(slot, &world, ent);
        assert_eq!(rs.gpu_depths[slot as usize], 7.5);
    }

    #[test]
    fn write_slot_2d_defaults_depth_to_zero() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let ent = world.spawn((
            Transform2D { x: 10.0, y: 20.0, rot: 0.0, sx: 1.0, sy: 1.0 },
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            Active,
            ExternalId(1),
        ));
        let slot = rs.assign_slot(ent);
        rs.write_slot_2d(slot, &world, ent);
        assert_eq!(rs.gpu_depths[slot as usize], 0.0);
    }

    /// A frame that ends with zero entities must not leave dirty bits behind for
    /// the next frame's slots to inherit (audit 2026-07, P2-9).
    #[test]
    fn zero_entity_frame_clears_the_tracker() {
        let mut rs = RenderState::new();
        let world = World::new();
        rs.dirty_tracker.ensure_capacity(8);
        rs.dirty_tracker.mark_transform_dirty(0);
        rs.dirty_tracker.mark_transform_dirty(5);
        let _ = rs.collect_dirty_staging(&world);
        assert!(!rs.dirty_tracker.is_transform_dirty(0));
        assert!(!rs.dirty_tracker.is_transform_dirty(5));
    }

    // --- Phase 5b: ids-changed flag and transparent recount (design §4.1) ---

    /// A 3D quad with an external id, transparent or not, ready for `write_slot`.
    fn quad_5b(world: &mut World, ext: u32, transparent: bool) -> hecs::Entity {
        let e = world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            RenderPrimitive(0),
            Active,
            ExternalId(ext),
        ));
        if transparent {
            world.insert_one(e, Transparent(1)).unwrap();
        }
        e
    }

    /// Assign a slot and write the row, as the spawn path does.
    fn place_5b(rs: &mut RenderState, world: &World, e: hecs::Entity) -> u32 {
        let slot = rs.assign_slot(e);
        rs.write_slot(slot, world, e);
        slot
    }

    /// Brute force over the live rows only.
    fn brute_transparent_5b(rs: &RenderState) -> u32 {
        let n = rs.gpu_entity_count() as usize;
        (0..n)
            .filter(|&i| rs.gpu_render_meta[i * 2 + 1] & RENDER_META_TRANSPARENT_BIT != 0)
            .count() as u32
    }

    #[test]
    fn ids_changed_is_raised_by_assign_slot_but_not_by_an_idempotent_one() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        assert!(!rs.take_ids_changed(), "a new RenderState has nothing to report");
        let e = quad_5b(&mut world, 1, false);
        rs.assign_slot(e);
        assert!(rs.take_ids_changed());
        assert!(!rs.take_ids_changed(), "take resets the flag");
        rs.assign_slot(e); // idempotent: same slot back, mapping unchanged
        assert!(!rs.take_ids_changed());
    }

    #[test]
    fn ids_changed_is_raised_by_a_flush_that_removes_a_row_only() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let a = quad_5b(&mut world, 1, false);
        let b = quad_5b(&mut world, 2, false);
        place_5b(&mut rs, &world, a);
        place_5b(&mut rs, &world, b);
        let _ = rs.take_ids_changed();

        rs.flush_pending_despawns(); // nothing queued
        assert!(!rs.take_ids_changed(), "an empty flush changes nothing");

        // A queued slot the count has already shrunk past is skipped.
        rs.pending_despawns.push((a, 7));
        rs.flush_pending_despawns();
        assert!(!rs.take_ids_changed(), "a skipped slot removes no row");

        rs.queue_despawn(a);
        rs.flush_pending_despawns();
        assert!(rs.take_ids_changed());
        assert_eq!(rs.gpu_entity_ids[0], 2, "the last row moved into slot 0");
    }

    #[test]
    fn ids_changed_ignores_row_rewrites_staging_and_shrink() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let a = quad_5b(&mut world, 1, false);
        let b = quad_5b(&mut world, 2, true);
        let sa = place_5b(&mut rs, &world, a);
        place_5b(&mut rs, &world, b);
        rs.queue_despawn(b);
        rs.flush_pending_despawns();
        let _ = rs.take_ids_changed();

        rs.write_slot(sa, &world, a); // the owner rewrites its own row
        assert!(!rs.take_ids_changed(), "write_slot of the owner");
        rs.dirty_tracker.mark_meta_dirty(sa as usize);
        let _ = rs.collect_dirty_staging(&world);
        assert!(!rs.take_ids_changed(), "collect_dirty_staging without a mapping change");
        rs.shrink_to_fit();
        assert!(!rs.take_ids_changed(), "shrink_to_fit drops only the dead tail");
    }

    #[test]
    fn ids_changed_is_raised_by_collect_gpu() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        quad_5b(&mut world, 1, false);
        rs.collect_gpu(&world);
        assert!(rs.take_ids_changed());
    }

    #[test]
    fn recount_sees_a_transparent_last_row_moved_into_an_opaque_dead_slot() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let a = quad_5b(&mut world, 1, false);
        let dead = quad_5b(&mut world, 2, false);
        let last = quad_5b(&mut world, 3, true);
        for e in [a, dead, last] {
            place_5b(&mut rs, &world, e);
        }
        rs.recount_transparent();
        assert_eq!(rs.transparent_count(), 1);

        rs.queue_despawn(dead);
        world.despawn(dead).unwrap();
        rs.collect_and_cache_dirty(&world);
        assert_eq!(rs.get_slot(last), Some(1), "the transparent last row moved into slot 1");
        assert_eq!(rs.transparent_count(), 1);
        assert_eq!(rs.transparent_count(), brute_transparent_5b(&rs));
    }

    #[test]
    fn recount_drops_a_transparent_dead_slot_filled_by_an_opaque_last_row() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let a = quad_5b(&mut world, 1, false);
        let dead = quad_5b(&mut world, 2, true);
        let last = quad_5b(&mut world, 3, false);
        for e in [a, dead, last] {
            place_5b(&mut rs, &world, e);
        }
        rs.queue_despawn(dead);
        world.despawn(dead).unwrap();
        rs.collect_and_cache_dirty(&world);
        assert_eq!(rs.get_slot(last), Some(1));
        assert_eq!(rs.transparent_count(), 0);
        assert_eq!(rs.transparent_count(), brute_transparent_5b(&rs));
    }

    #[test]
    fn recount_ignores_the_stale_tail_past_gpu_count() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let a = quad_5b(&mut world, 1, false);
        let b = quad_5b(&mut world, 2, true);
        place_5b(&mut rs, &world, a);
        place_5b(&mut rs, &world, b);
        rs.queue_despawn(b);
        world.despawn(b).unwrap();
        rs.collect_and_cache_dirty(&world);

        assert_eq!(rs.gpu_entity_count(), 1);
        // The dead row is still in the Vec, bit 8 included: the case under test.
        assert_ne!(rs.gpu_render_meta()[3] & RENDER_META_TRANSPARENT_BIT, 0);
        assert_eq!(rs.transparent_count(), 0);

        // An opaque entity re-entering that row zeroes it first (clear_slot).
        let c = quad_5b(&mut world, 3, false);
        rs.assign_slot(c);
        rs.collect_and_cache_dirty(&world);
        assert_eq!(rs.transparent_count(), 0);
        assert_eq!(rs.gpu_render_meta()[3] & RENDER_META_TRANSPARENT_BIT, 0);
    }

    #[test]
    fn collect_gpu_counts_like_the_retained_path() {
        let mut world = World::new();
        let mut ents = Vec::new();
        for i in 0..6u32 {
            // collect_gpu queries these too.
            let e = quad_5b(&mut world, i, i.is_multiple_of(3));
            world
                .insert(e, (TextureLayerIndex(0), MeshHandle(0), PrimitiveParams([0.0; 8])))
                .unwrap();
            ents.push(e);
        }
        let mut legacy = RenderState::new();
        legacy.collect_gpu(&world);

        let mut retained = RenderState::new();
        for &e in &ents {
            place_5b(&mut retained, &world, e);
        }
        retained.recount_transparent();

        assert_eq!(legacy.transparent_count(), 2);
        assert_eq!(retained.transparent_count(), legacy.transparent_count());
    }
}
