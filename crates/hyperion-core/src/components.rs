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

/// Bounding sphere radius for frustum culling.
/// The sphere center is the entity's Position.
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct BoundingRadius(pub f32);

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

/// Per-entity parameters interpreted by the active RenderPrimitive shader.
/// 8 f32 (32 bytes) — meaning depends on primitive type:
///   Line: [startX, startY, endX, endY, width, dashLen, gapLen, _pad]
///   SDFGlyph: [atlasU0, atlasV0, atlasU1, atlasV1, screenPxRange, _pad, _pad, _pad]
///   Gradient: [type, angle, stop0pos, stop0r, stop0g, stop0b, stop1pos, stop1r]
///   BoxShadow: [rectW, rectH, cornerRadius, blur, colorR, colorG, colorB, colorA]
#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(C)]
pub struct PrimitiveParams(pub [f32; 8]);

// SAFETY: PrimitiveParams is #[repr(C)] with only f32 fields — trivially Pod.
unsafe impl bytemuck::Pod for PrimitiveParams {}
unsafe impl bytemuck::Zeroable for PrimitiveParams {}

impl Default for PrimitiveParams {
    fn default() -> Self {
        Self([0.0; 8])
    }
}

/// External entity ID visible to TypeScript. Set on spawn, never changes.
/// Used by the render state to map SoA index → entityId for hit testing
/// and immediate-mode position overrides.
#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct ExternalId(pub u32);

// SAFETY: ExternalId is a #[repr(C)] newtype around u32 — trivially Pod/Zeroable.
unsafe impl bytemuck::Pod for ExternalId {}
unsafe impl bytemuck::Zeroable for ExternalId {}

/// Parent entity (external ID). u32::MAX = no parent.
#[derive(Debug, Clone, Copy)]
pub struct Parent(pub u32);

impl Default for Parent {
    fn default() -> Self {
        Self(u32::MAX) // sentinel: no parent
    }
}

/// Children list. Fixed-capacity inline array (max 32 children).
#[derive(Debug, Clone)]
pub struct Children {
    pub slots: [u32; Self::MAX_CHILDREN],
    pub count: u8,
}

impl Children {
    pub const MAX_CHILDREN: usize = 32;

    pub fn add(&mut self, child_id: u32) -> bool {
        if (self.count as usize) >= Self::MAX_CHILDREN {
            return false;
        }
        self.slots[self.count as usize] = child_id;
        self.count += 1;
        true
    }

    pub fn remove(&mut self, child_id: u32) -> bool {
        for i in 0..self.count as usize {
            if self.slots[i] == child_id {
                self.count -= 1;
                self.slots[i] = self.slots[self.count as usize];
                return true;
            }
        }
        false
    }

    pub fn get(&self, index: usize) -> Option<u32> {
        if index < self.count as usize {
            Some(self.slots[index])
        } else {
            None
        }
    }

    pub fn as_slice(&self) -> &[u32] {
        &self.slots[..self.count as usize]
    }
}

impl Default for Children {
    fn default() -> Self {
        Self {
            slots: [0; Self::MAX_CHILDREN],
            count: 0,
        }
    }
}

/// Local-space model matrix (relative to parent).
#[derive(Debug, Clone, Copy)]
pub struct LocalMatrix(pub [f32; 16]);

impl Default for LocalMatrix {
    fn default() -> Self {
        Self(glam::Mat4::IDENTITY.to_cols_array())
    }
}

/// Marker: entity is active and should be simulated/rendered.
#[derive(Debug, Clone, Copy)]
pub struct Active;

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

    #[test]
    fn parent_default_is_none_sentinel() {
        let p = Parent::default();
        assert_eq!(p.0, u32::MAX);
    }

    #[test]
    fn children_default_is_empty() {
        let c = Children::default();
        assert_eq!(c.count, 0);
    }

    #[test]
    fn children_add_and_get() {
        let mut c = Children::default();
        c.add(5);
        c.add(10);
        assert_eq!(c.count, 2);
        assert_eq!(c.get(0), Some(5));
        assert_eq!(c.get(1), Some(10));
        assert_eq!(c.get(2), None);
    }

    #[test]
    fn children_remove() {
        let mut c = Children::default();
        c.add(1);
        c.add(2);
        c.add(3);
        c.remove(2);
        assert_eq!(c.count, 2);
        assert_eq!(c.get(0), Some(1));
        assert_eq!(c.get(1), Some(3));
    }

    #[test]
    fn children_max_capacity() {
        let mut c = Children::default();
        for i in 0..Children::MAX_CHILDREN as u32 {
            assert!(c.add(i));
        }
        assert!(!c.add(999));
    }

    #[test]
    fn local_matrix_default_is_identity() {
        let m = LocalMatrix::default();
        assert_eq!(m.0[0], 1.0);
        assert_eq!(m.0[5], 1.0);
        assert_eq!(m.0[10], 1.0);
        assert_eq!(m.0[15], 1.0);
    }

    #[test]
    fn primitive_params_is_pod_and_default_zero() {
        let pp = PrimitiveParams::default();
        assert_eq!(pp.0, [0.0f32; 8]);
        let bytes: &[u8] = bytemuck::bytes_of(&pp);
        assert_eq!(bytes.len(), 32);
        assert!(bytes.iter().all(|&b| b == 0));
    }

    #[test]
    fn children_remove_returns_true_when_found() {
        let mut c = Children::default();
        c.add(1);
        c.add(2);
        assert!(c.remove(2));
        assert_eq!(c.count, 1);
    }

    #[test]
    fn children_remove_returns_false_when_not_found() {
        let mut c = Children::default();
        c.add(1);
        assert!(!c.remove(999));
        assert_eq!(c.count, 1);
    }
}
