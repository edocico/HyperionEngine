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

/// Packed texture layer index for per-entity texture lookup.
/// Encoding: `(tier << 16) | layer` where tier selects which Texture2DArray
/// and layer selects which slice within it.
/// Default 0 = tier 0, layer 0 (white fallback).
#[derive(Debug, Clone, Copy, Default, Pod, Zeroable)]
#[repr(C)]
pub struct TextureLayerIndex(pub u32);

/// Mesh geometry handle. 0 = unit quad (default).
/// Range 0–31 core, 32–63 extended, 64–127 plugin.
#[derive(Debug, Clone, Copy, Default, PartialEq, Pod, Zeroable)]
#[repr(C)]
pub struct MeshHandle(pub u32);

/// Render primitive type. Determines which GPU pipeline processes this entity.
/// 0 = Quad (default). Range 0–31 core, 32–63 extended, 64–127 plugin.
#[derive(Debug, Clone, Copy, Default, PartialEq, Pod, Zeroable)]
#[repr(C)]
pub struct RenderPrimitive(pub u8);

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

    #[test]
    fn default_texture_layer_index_is_zero() {
        let t = TextureLayerIndex::default();
        assert_eq!(t.0, 0);
    }

    #[test]
    fn texture_layer_index_is_pod() {
        let t = TextureLayerIndex(0x0002_0005); // tier 2, layer 5
        let bytes = bytemuck::bytes_of(&t);
        assert_eq!(bytes.len(), 4);
        let roundtrip = u32::from_le_bytes(bytes.try_into().unwrap());
        assert_eq!(roundtrip, 0x0002_0005);
    }

    #[test]
    fn texture_layer_index_pack_unpack() {
        let tier: u32 = 3;
        let layer: u32 = 42;
        let packed = (tier << 16) | layer;
        let t = TextureLayerIndex(packed);
        assert_eq!(t.0 >> 16, 3);      // tier
        assert_eq!(t.0 & 0xFFFF, 42);  // layer
    }

    #[test]
    fn mesh_handle_default_is_unit_quad() {
        let mh = MeshHandle::default();
        assert_eq!(mh.0, 0, "MeshHandle 0 = unit quad");
    }

    #[test]
    fn mesh_handle_is_pod() {
        let mh = MeshHandle(42);
        let bytes = bytemuck::bytes_of(&mh);
        assert_eq!(bytes.len(), 4);
        assert_eq!(u32::from_le_bytes(bytes.try_into().unwrap()), 42);
    }

    #[test]
    fn render_primitive_default_is_quad() {
        let rp = RenderPrimitive::default();
        assert_eq!(rp.0, 0, "RenderPrimitive 0 = Quad");
    }

    #[test]
    fn render_primitive_is_pod() {
        let rp = RenderPrimitive(2);
        let bytes = bytemuck::bytes_of(&rp);
        assert_eq!(bytes.len(), 1);
        assert_eq!(bytes[0], 2);
    }
}
