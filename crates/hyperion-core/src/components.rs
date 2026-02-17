//! Core ECS components.
//!
//! All spatial components use `glam` types for SIMD acceleration.
//! Components are plain data structs — no methods, no trait objects.

use bytemuck::{Pod, Zeroable};
use glam::{Quat, Vec3};

/// World-space position.
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct Position(pub Vec3);

/// World-space rotation as a quaternion.
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct Rotation(pub Quat);

/// Non-uniform scale.
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct Scale(pub Vec3);

/// Linear velocity (units per second).
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct Velocity(pub Vec3);

/// Computed 4x4 model matrix, updated by the transform system.
/// This is what gets uploaded to the GPU.
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct ModelMatrix(pub [f32; 16]);

/// Marker: entity is active and should be simulated/rendered.
#[derive(Debug, Clone, Copy)]
pub struct Active;

/// Bounding sphere radius for frustum culling.
/// The sphere center is the entity's Position.
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct BoundingRadius(pub f32);

impl Default for Position {
    fn default() -> Self {
        Self(Vec3::ZERO)
    }
}

impl Default for Rotation {
    fn default() -> Self {
        Self(Quat::IDENTITY)
    }
}

impl Default for Scale {
    fn default() -> Self {
        Self(Vec3::ONE)
    }
}

impl Default for Velocity {
    fn default() -> Self {
        Self(Vec3::ZERO)
    }
}

impl Default for ModelMatrix {
    fn default() -> Self {
        Self(glam::Mat4::IDENTITY.to_cols_array())
    }
}

impl Default for BoundingRadius {
    fn default() -> Self {
        Self(0.5) // unit quad default
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_position_is_origin() {
        let p = Position::default();
        assert_eq!(p.0, Vec3::ZERO);
    }

    #[test]
    fn default_rotation_is_identity() {
        let r = Rotation::default();
        assert_eq!(r.0, Quat::IDENTITY);
    }

    #[test]
    fn default_scale_is_one() {
        let s = Scale::default();
        assert_eq!(s.0, Vec3::ONE);
    }

    #[test]
    fn model_matrix_is_pod() {
        let m = ModelMatrix::default();
        let bytes = bytemuck::bytes_of(&m);
        assert_eq!(bytes.len(), 64); // 16 floats * 4 bytes
    }

    #[test]
    fn default_bounding_radius_is_half() {
        let b = BoundingRadius::default();
        assert_eq!(b.0, 0.5);
    }

    #[test]
    fn bounding_radius_is_pod() {
        let b = BoundingRadius(1.0);
        let bytes = bytemuck::bytes_of(&b);
        assert_eq!(bytes.len(), 4);
    }
}
