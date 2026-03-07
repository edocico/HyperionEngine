//! Rapier2D physics integration.
//!
//! All types and functions in this module are behind `#[cfg(feature = "physics-2d")]`.

#[cfg(feature = "physics-2d")]
pub mod types {
    /// Pending rigid body creation. Accumulates override commands before
    /// physics_sync_pre() creates the actual Rapier body.
    pub struct PendingRigidBody {
        pub body_type: u8, // 0=dynamic, 1=fixed, 2=kinematic
        pub gravity_scale: f32,
        pub linear_damping: f32,
        pub angular_damping: f32,
        pub ccd_enabled: bool,
    }

    impl Default for PendingRigidBody {
        fn default() -> Self {
            Self {
                body_type: 0,
                gravity_scale: 1.0,
                linear_damping: 0.0,
                angular_damping: 0.0,
                ccd_enabled: false,
            }
        }
    }

    impl PendingRigidBody {
        pub fn new(body_type: u8) -> Self {
            Self {
                body_type,
                ..Default::default()
            }
        }
    }

    /// Pending collider creation. Consumed in physics_sync_pre().
    pub struct PendingCollider {
        pub shape_type: u8,
        pub shape_params: [f32; 4],
        pub density: f32,
        pub restitution: f32,
        pub friction: f32,
        pub is_sensor: bool,
        pub groups: u32,
    }

    impl Default for PendingCollider {
        fn default() -> Self {
            Self {
                shape_type: 0,
                shape_params: [0.0; 4],
                density: 1.0,
                restitution: 0.0,
                friction: 0.5,
                is_sensor: false,
                groups: 0xFFFF_FFFF,
            }
        }
    }

    impl PendingCollider {
        pub fn new(shape_type: u8, params: [f32; 4]) -> Self {
            Self {
                shape_type,
                shape_params: params,
                ..Default::default()
            }
        }
    }

    /// Handle to a live Rapier RigidBody.
    pub struct PhysicsBodyHandle(pub rapier2d::prelude::RigidBodyHandle);

    /// Handle to a live Rapier Collider.
    pub struct PhysicsColliderHandle(pub rapier2d::prelude::ColliderHandle);

    /// Marker: entity position/rotation driven by Rapier. velocity_system skips these.
    pub struct PhysicsControlled;
}

#[cfg(feature = "physics-2d")]
pub use types::*;

#[cfg(feature = "physics-2d")]
#[cfg(test)]
mod tests {
    use super::types::*;

    #[test]
    fn pending_rigid_body_defaults() {
        let pending = PendingRigidBody::default();
        assert_eq!(pending.body_type, 0);
        assert_eq!(pending.gravity_scale, 1.0);
        assert_eq!(pending.linear_damping, 0.0);
        assert_eq!(pending.angular_damping, 0.0);
        assert!(!pending.ccd_enabled);
    }

    #[test]
    fn pending_collider_defaults() {
        let pending = PendingCollider::default();
        assert_eq!(pending.shape_type, 0);
        assert_eq!(pending.density, 1.0);
        assert_eq!(pending.restitution, 0.0);
        assert!((pending.friction - 0.5).abs() < f32::EPSILON);
        assert!(!pending.is_sensor);
        assert_eq!(pending.groups, 0xFFFF_FFFF);
    }

    #[test]
    fn pending_rigid_body_new_sets_body_type() {
        let pending = PendingRigidBody::new(1); // fixed
        assert_eq!(pending.body_type, 1);
        assert_eq!(pending.gravity_scale, 1.0); // other fields default
    }
}
