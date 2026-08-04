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

    /// True when `child_id` is already listed. Callers use this to keep the
    /// list duplicate-free: `remove` only drops the first match, so a duplicate
    /// entry could never be cleared again (audit 2026-07, P2-1d).
    pub fn contains(&self, child_id: u32) -> bool {
        self.as_slice().contains(&child_id)
    }

    /// Remove **every** occurrence of `child_id`. Returns true if at least one
    /// was removed.
    pub fn remove(&mut self, child_id: u32) -> bool {
        let mut removed = false;
        let mut i = 0;
        while i < self.count as usize {
            if self.slots[i] == child_id {
                self.count -= 1;
                self.slots[i] = self.slots[self.count as usize];
                removed = true;
                // do not advance: the swapped-in element still needs checking
            } else {
                i += 1;
            }
        }
        removed
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

/// Heap fallback for entities with more than 32 children.
/// Only attached when Children::add() overflows.
/// NOT #[repr(C)]/Pod — contains Vec (heap-allocated). Never uploaded to GPU.
#[derive(Debug, Clone)]
pub struct OverflowChildren {
    pub items: Vec<u32>,
}

/// Local-space model matrix (relative to parent).
#[derive(Debug, Clone, Copy)]
pub struct LocalMatrix(pub [f32; 16]);

impl Default for LocalMatrix {
    fn default() -> Self {
        Self(glam::Mat4::IDENTITY.to_cols_array())
    }
}

/// Compact 2D transform: position + rotation angle + scale. 20 bytes.
/// Used by the hot-path transform_system_2d for 99% of entities.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct Transform2D {
    pub x: f32,
    pub y: f32,
    pub rot: f32, // angle in radians
    pub sx: f32,
    pub sy: f32,
}

impl Default for Transform2D {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            rot: 0.0,
            sx: 1.0,
            sy: 1.0,
        }
    }
}

/// Opt-in depth for 2.5D z-ordering. 4 bytes.
/// Entities with Depth participate in back-to-front transparent sorting.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct Depth(pub f32);

/// Marker component for transparent entities. 1 byte.
/// Transparent entities are sorted back-to-front via GPU radix sort.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct Transparent(pub u8);

// ─────────────────────────────────────────────────────────────────────────────
// renderMeta[slot * 2 + 1] bit layout
// ─────────────────────────────────────────────────────────────────────────────
//
// One u32 carries everything the render passes need to classify an entity.
// Bits 0-8 predate Phase 17; bits 9-31 are the lighting fields.
//
//   bits  0-7   primType      0=Quad 1=Line 2=SDFGlyph 3=BezierPath
//                             4=Gradient 5=BoxShadow 6=Light2D
//   bit   8     transparent   entity goes in the transparent draw buckets
//   bit   9     castsShadow   entity is rasterised into the occluder seed
//   bit  10     receivesLight entity samples `light-buffer` in the ForwardPass
//   bits 11-13  lightType     see `LightType`
//   bits 14-15  lightBlendMode 0=Add 1=Sub 2=Mix
//   bits 16-31  lightMask     16 light layers
//
// Bits 9-31 live in the `LightFlags` component already pre-shifted, so encoding
// is a single OR at each of the three renderMeta write sites rather than five
// component reads.

/// Bits 0-7 of `renderMeta[slot*2+1]`: the `RenderPrimitive` discriminant.
pub const RENDER_META_PRIM_TYPE_MASK: u32 = 0x0000_00FF;
/// Bit 8: the `Transparent` marker.
pub const RENDER_META_TRANSPARENT_BIT: u32 = 1 << 8;
/// Bit 9: the entity is rasterised into the occluder seed texture.
pub const RENDER_META_CASTS_SHADOW_BIT: u32 = 1 << 9;
/// Bit 10: the entity samples the light buffer instead of rendering unlit.
pub const RENDER_META_RECEIVES_LIGHT_BIT: u32 = 1 << 10;
/// Bits 11-13: `LightType`.
pub const RENDER_META_LIGHT_TYPE_SHIFT: u32 = 11;
/// Mask of bits 11-13, unshifted.
pub const RENDER_META_LIGHT_TYPE_MASK: u32 = 0b111;
/// Bits 14-15: light blend mode.
pub const RENDER_META_LIGHT_BLEND_SHIFT: u32 = 14;
/// Mask of bits 14-15, unshifted.
pub const RENDER_META_LIGHT_BLEND_MASK: u32 = 0b11;
/// Bits 16-31: the 16-bit light layer mask.
pub const RENDER_META_LIGHT_MASK_SHIFT: u32 = 16;
/// Mask of bits 16-31, unshifted.
pub const RENDER_META_LIGHT_MASK_MASK: u32 = 0xFFFF;

/// Every bit `LightFlags` owns — 9 through 31.
///
/// `LightFlags` is applied to `renderMeta` through this mask, so a caller that
/// constructs one by hand can never corrupt `primType` or the transparent bit.
pub const LIGHT_FLAGS_MASK: u32 = 0xFFFF_FE00;

/// `RenderPrimitive` discriminant for a 2D light. Lights are ECS entities like
/// any other drawable, but no shader is registered for this type in the
/// ForwardPass — `LightAccumPass` reads their draw bucket directly.
pub const PRIM_TYPE_LIGHT2D: u8 = 6;

/// Light shape, stored in `renderMeta` bits 11-13.
///
/// Values 5-7 are reserved and deliberately unused: a 3D extension needs
/// somewhere to put `Point3D`, `Spot3D` and `Area` without renumbering the
/// protocol, and reserving them costs nothing today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum LightType {
    Point = 0,
    Spot = 1,
    Directional = 2,
    Global = 3,
    Sprite = 4,
    // 5 = Point3D, 6 = Spot3D, 7 = Area — reserved, see above.
}

/// How a light's contribution combines in the accumulation buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum LightBlendMode {
    Add = 0,
    Sub = 1,
    Mix = 2,
}

/// Lighting bits 9-31 of `renderMeta`, stored **pre-shifted**.
///
/// One field with three meanings depending on the entity's role — a light's
/// `lightMask` says which layers it illuminates, a drawable's says which layer
/// it belongs to, an occluder's says which layers it shadows. Godot splits this
/// into two orthogonal pairs; the cost of doing the same here is a new SoA
/// column, and the single field covers the normal case (a wall is lit by, and
/// shadows for, the same layers). Documented limit, not an oversight.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Pod, Zeroable)]
pub struct LightFlags(pub u32);

impl LightFlags {
    /// Build the light-description fields. `casts_shadow` / `receives_light`
    /// are set separately because they apply to drawables too, not just lights.
    pub fn new(light_type: LightType, blend: LightBlendMode, light_mask: u16) -> Self {
        Self(
            ((light_type as u32) << RENDER_META_LIGHT_TYPE_SHIFT)
                | ((blend as u32) << RENDER_META_LIGHT_BLEND_SHIFT)
                | ((light_mask as u32) << RENDER_META_LIGHT_MASK_SHIFT),
        )
    }

    /// The bits actually written to `renderMeta`. Anything outside 9-31 is
    /// dropped here rather than silently corrupting `primType`.
    pub fn bits(self) -> u32 {
        self.0 & LIGHT_FLAGS_MASK
    }

    pub fn casts_shadow(self) -> bool {
        self.0 & RENDER_META_CASTS_SHADOW_BIT != 0
    }

    pub fn receives_light(self) -> bool {
        self.0 & RENDER_META_RECEIVES_LIGHT_BIT != 0
    }

    pub fn set_casts_shadow(&mut self, on: bool) {
        if on {
            self.0 |= RENDER_META_CASTS_SHADOW_BIT;
        } else {
            self.0 &= !RENDER_META_CASTS_SHADOW_BIT;
        }
    }

    pub fn set_receives_light(&mut self, on: bool) {
        if on {
            self.0 |= RENDER_META_RECEIVES_LIGHT_BIT;
        } else {
            self.0 &= !RENDER_META_RECEIVES_LIGHT_BIT;
        }
    }

    /// Raw `lightType` value. Returns the stored 3 bits even for the reserved
    /// 5-7, so a future protocol addition round-trips through a snapshot taken
    /// by an older build.
    pub fn light_type_raw(self) -> u8 {
        ((self.0 >> RENDER_META_LIGHT_TYPE_SHIFT) & RENDER_META_LIGHT_TYPE_MASK) as u8
    }

    pub fn blend_mode_raw(self) -> u8 {
        ((self.0 >> RENDER_META_LIGHT_BLEND_SHIFT) & RENDER_META_LIGHT_BLEND_MASK) as u8
    }

    pub fn light_mask(self) -> u16 {
        ((self.0 >> RENDER_META_LIGHT_MASK_SHIFT) & RENDER_META_LIGHT_MASK_MASK) as u16
    }

    /// Replace `lightType` / `blendMode` / `lightMask`, preserving bits 9-10.
    pub fn set_light(&mut self, light_type_raw: u8, blend_raw: u8, light_mask: u16) {
        let keep = self.0 & (RENDER_META_CASTS_SHADOW_BIT | RENDER_META_RECEIVES_LIGHT_BIT);
        self.0 = keep
            | ((u32::from(light_type_raw) & RENDER_META_LIGHT_TYPE_MASK)
                << RENDER_META_LIGHT_TYPE_SHIFT)
            | ((u32::from(blend_raw) & RENDER_META_LIGHT_BLEND_MASK)
                << RENDER_META_LIGHT_BLEND_SHIFT)
            | (u32::from(light_mask) << RENDER_META_LIGHT_MASK_SHIFT);
    }
}

/// Marker: entity is active and should be simulated/rendered.
#[derive(Debug, Clone, Copy)]
pub struct Active;

/// Marker: `BoundingRadius` was pinned explicitly via `SetBoundingRadius` and
/// must NOT be recomputed by `update_bounding_radii`.
///
/// Without this marker the radius is derived every frame from the entity's
/// world matrix, so scaled entities are culled and hit-tested against a sphere
/// that actually encloses them (audit 2026-07, P1-17).
#[derive(Debug, Clone, Copy)]
pub struct BoundsOverride;

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

    #[test]
    fn overflow_children_basic() {
        let mut oc = OverflowChildren { items: vec![] };
        oc.items.push(100);
        oc.items.push(200);
        assert_eq!(oc.items.len(), 2);
        oc.items.retain(|&id| id != 100);
        assert_eq!(oc.items.len(), 1);
        assert_eq!(oc.items[0], 200);
    }

    #[test]
    fn transform2d_is_pod() {
        let t = Transform2D { x: 1.0, y: 2.0, rot: 0.5, sx: 1.0, sy: 1.0 };
        let bytes: &[u8] = bytemuck::bytes_of(&t);
        assert_eq!(bytes.len(), 20);
        let back: Transform2D = bytemuck::pod_read_unaligned(bytes);
        assert_eq!(back.x, 1.0);
        assert_eq!(back.rot, 0.5);
    }

    #[test]
    fn transform2d_default_has_unit_scale() {
        let t = Transform2D::default();
        assert_eq!(t.sx, 1.0);
        assert_eq!(t.sy, 1.0);
        assert_eq!(t.x, 0.0);
        assert_eq!(t.rot, 0.0);
    }

    #[test]
    fn depth_is_pod() {
        let d = Depth(42.0);
        let bytes: &[u8] = bytemuck::bytes_of(&d);
        assert_eq!(bytes.len(), 4);
        let back: Depth = bytemuck::pod_read_unaligned(bytes);
        assert_eq!(back.0, 42.0);
    }

    #[test]
    fn transparent_is_pod() {
        let t = Transparent(1);
        let bytes: &[u8] = bytemuck::bytes_of(&t);
        assert_eq!(bytes.len(), 1);
    }
}
