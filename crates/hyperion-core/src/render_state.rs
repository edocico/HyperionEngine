//! Collects render-ready data from the ECS into contiguous GPU-uploadable buffers.
//!
//! GPU data is laid out as Structure-of-Arrays (SoA): four independent buffers
//! (transforms, bounds, renderMeta, texIndices) instead of one interleaved buffer.
//! This enables partial upload, better GPU cache performance, and extensibility.

use hecs::World;

use crate::components::{
    Active, BoundingRadius, MeshHandle, ModelMatrix, Position, RenderPrimitive, TextureLayerIndex,
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

    /// Fraction of entities with dirty transforms: `dirty_count / total`.
    /// Returns 0.0 if `total` is 0.
    pub fn transform_dirty_ratio(&self, total: usize) -> f32 {
        if total == 0 {
            return 0.0;
        }
        self.transform_dirty.count() as f32 / total as f32
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
    gpu_count: u32,

    /// Per-buffer dirty tracking for partial upload optimization.
    pub dirty_tracker: DirtyTracker,
}

impl RenderState {
    pub fn new() -> Self {
        Self {
            matrices: Vec::new(),
            gpu_transforms: Vec::new(),
            gpu_bounds: Vec::new(),
            gpu_render_meta: Vec::new(),
            gpu_tex_indices: Vec::new(),
            gpu_count: 0,
            dirty_tracker: DirtyTracker::new(0),
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

        // Pre-allocate based on previous frame's entity count to avoid reallocation.
        let hint = self.gpu_count as usize;
        self.gpu_transforms.reserve(hint * 16);
        self.gpu_bounds.reserve(hint * 4);
        self.gpu_render_meta.reserve(hint * 2);
        self.gpu_tex_indices.reserve(hint);
        self.gpu_count = 0;

        for (pos, matrix, radius, tex, mesh, prim, _active) in world
            .query::<(
                &Position,
                &ModelMatrix,
                &BoundingRadius,
                &TextureLayerIndex,
                &MeshHandle,
                &RenderPrimitive,
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

            self.gpu_count += 1;
        }

        debug_assert_eq!(self.gpu_count as usize * 16, self.gpu_transforms.len());
        debug_assert_eq!(self.gpu_count as usize * 4, self.gpu_bounds.len());
        debug_assert_eq!(self.gpu_count as usize * 2, self.gpu_render_meta.len());
        debug_assert_eq!(self.gpu_count as usize, self.gpu_tex_indices.len());
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
}
