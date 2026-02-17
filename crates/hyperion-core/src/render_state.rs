//! Collects render-ready data from the ECS into contiguous GPU-uploadable buffers.

use hecs::World;

use crate::components::{Active, BoundingRadius, ModelMatrix, Position};

/// Per-entity GPU data stride: 20 floats (80 bytes).
/// Layout: mat4x4f (64 bytes) + vec4f boundingSphere (16 bytes).
const FLOATS_PER_GPU_ENTITY: usize = 20;

/// Contiguous buffer of model matrices for all active entities.
/// Updated once per frame after all physics ticks and transform recomputation.
pub struct RenderState {
    /// Flat buffer: each entry is 16 f32s (one 4x4 column-major matrix).
    pub matrices: Vec<[f32; 16]>,

    // GPU-driven pipeline data
    gpu_data: Vec<f32>,
    gpu_count: u32,
}

impl RenderState {
    pub fn new() -> Self {
        Self {
            matrices: Vec::new(),
            gpu_data: Vec::new(),
            gpu_count: 0,
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

    /// Collect entity data for GPU-driven pipeline.
    /// Each entity produces 20 floats: 16 (model matrix) + 4 (bounding sphere).
    pub fn collect_gpu(&mut self, world: &World) {
        self.gpu_data.clear();
        // Vec::clear retains capacity, so subsequent frames avoid reallocation.
        // Reserve on first frame or if entity count grew.
        self.gpu_data.reserve(self.gpu_count as usize * FLOATS_PER_GPU_ENTITY);
        self.gpu_count = 0;

        for (pos, matrix, radius, _active) in
            world.query::<(&Position, &ModelMatrix, &BoundingRadius, &Active)>().iter()
        {
            // Model matrix: 16 floats
            self.gpu_data.extend_from_slice(&matrix.0);
            // Bounding sphere: xyz = position, w = radius
            self.gpu_data.push(pos.0.x);
            self.gpu_data.push(pos.0.y);
            self.gpu_data.push(pos.0.z);
            self.gpu_data.push(radius.0);

            self.gpu_count += 1;
        }

        debug_assert_eq!(self.gpu_count as usize * FLOATS_PER_GPU_ENTITY, self.gpu_data.len());
    }

    /// Number of entities in the GPU buffer.
    pub fn gpu_entity_count(&self) -> u32 {
        self.gpu_count
    }

    /// Raw float buffer for GPU upload (20 floats per entity).
    pub fn gpu_buffer(&self) -> &[f32] {
        &self.gpu_data
    }

    /// Pointer to the GPU buffer for WASM export. Returns null if empty.
    pub fn gpu_buffer_ptr(&self) -> *const f32 {
        if self.gpu_data.is_empty() {
            std::ptr::null()
        } else {
            self.gpu_data.as_ptr()
        }
    }

    /// Total number of f32 values in the GPU buffer.
    pub fn gpu_buffer_f32_len(&self) -> u32 {
        self.gpu_data.len() as u32
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
            Active,
        ));

        // Run transform to compute the model matrix
        crate::systems::transform_system(&mut world);

        let mut state = RenderState::new();
        state.collect_gpu(&world);

        assert_eq!(state.gpu_entity_count(), 1);

        let data = state.gpu_buffer();
        // 20 floats per entity: 16 (matrix) + 4 (bounding sphere)
        assert_eq!(data.len(), 20);

        // Model matrix translation (column-major: indices 12, 13, 14)
        assert_eq!(data[12], 1.0); // pos.x
        assert_eq!(data[13], 2.0); // pos.y
        assert_eq!(data[14], 3.0); // pos.z

        // Bounding sphere: position xyz + radius
        assert_eq!(data[16], 1.0); // pos.x
        assert_eq!(data[17], 2.0); // pos.y
        assert_eq!(data[18], 3.0); // pos.z
        assert_eq!(data[19], 0.5); // radius
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
                Active,
            ));
        }
        crate::systems::transform_system(&mut world);

        let mut state = RenderState::new();
        state.collect_gpu(&world);

        assert_eq!(state.gpu_entity_count(), 3);
        assert_eq!(state.gpu_buffer().len(), 60); // 3 * 20
    }

    #[test]
    fn collect_gpu_skips_entities_without_bounding_radius() {
        let mut world = World::new();
        world.spawn((Position(Vec3::ZERO), Rotation::default(), Scale::default(), Velocity::default(), ModelMatrix::default(), BoundingRadius(1.0), Active));
        // Entity missing BoundingRadius — visible to collect() but not collect_gpu()
        world.spawn((Position(Vec3::ZERO), Rotation::default(), Scale::default(), Velocity::default(), ModelMatrix::default(), Active));

        let mut state = RenderState::new();
        state.collect(&world);
        assert_eq!(state.count(), 2);

        state.collect_gpu(&world);
        assert_eq!(state.gpu_entity_count(), 1);
    }
}
