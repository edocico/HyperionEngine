//! Rapier 0.32 feasibility spike for Hyperion Engine.
//!
//! NOT a production dependency. Exists solely for API validation
//! and binary size measurement, like `crates/loro-spike`.
//!
//! ## API findings vs. task spec assumptions
//!
//! - Rapier 0.32 uses glam `Vec2` natively. `vector![]` macro produces nalgebra
//!   types which need `.into()` to convert to glam `Vec2`.
//! - `pipeline.step()` takes gravity as `Vector` (glam `Vec2`) by value, not `&Vector`.
//! - `point![]` macro produces nalgebra `OPoint`, needs `.into()` for joint anchors.
//! - `KinematicCharacterController` is in `rapier2d::control`, not re-exported in prelude.

use wasm_bindgen::prelude::*;
use rapier2d::prelude::*;
use rapier2d::control::KinematicCharacterController;

/// Validate all Rapier 0.32 API assumptions.
/// Returns `true` if everything compiles and runs without panic.
#[wasm_bindgen]
pub fn spike_validate_all() -> bool {
    // 1. IntegrationParameters.length_unit exists and is settable
    let params = IntegrationParameters {
        length_unit: 100.0, // pixel space
        ..Default::default()
    };

    // 2. step() has 12-parameter signature (gravity by value, not reference)
    let gravity: Vector = vector![0.0, -981.0].into(); // pixel-space gravity
    let mut pipeline = PhysicsPipeline::new();
    let mut islands = IslandManager::new();
    let mut broad_phase = DefaultBroadPhase::new();
    let mut narrow_phase = NarrowPhase::new();
    let mut bodies = RigidBodySet::new();
    let mut colliders = ColliderSet::new();
    let mut impulse_joints = ImpulseJointSet::new();
    let mut multibody_joints = MultibodyJointSet::new();
    let mut ccd = CCDSolver::new();

    // 3. RigidBodyBuilder — vector![] needs .into() to convert nalgebra→glam Vec2
    let rb = RigidBodyBuilder::dynamic()
        .translation(vector![100.0, 200.0].into())
        .gravity_scale(1.0)
        .linear_damping(0.5)
        .angular_damping(0.1)
        .ccd_enabled(false)
        .build();
    let rb_handle = bodies.insert(rb);

    // 4. ColliderBuilder compiles with ball/cuboid
    let ball = ColliderBuilder::ball(16.0)
        .restitution(0.7)
        .friction(0.5)
        .density(1.0)
        .sensor(false)
        .build();
    colliders.insert_with_parent(ball, rb_handle, &mut bodies);

    let cuboid = ColliderBuilder::cuboid(20.0, 10.0).build();
    let _cuboid_handle = colliders.insert_with_parent(cuboid, rb_handle, &mut bodies);

    // 5. step() executes without panic (12 params, gravity by value)
    pipeline.step(
        gravity,
        &params,
        &mut islands,
        &mut broad_phase,
        &mut narrow_phase,
        &mut bodies,
        &mut colliders,
        &mut impulse_joints,
        &mut multibody_joints,
        &mut ccd,
        &(),
        &(),
    );

    // 6. Body translation and rotation types
    let body = &bodies[rb_handle];
    let _pos_x: f32 = body.translation().x; // glam Vec2.x
    let _pos_y: f32 = body.translation().y;
    let _angle: f32 = body.rotation().angle(); // Rot2 -> f32

    // 7. ChannelEventCollector with mpsc
    let (collision_send, collision_recv) = std::sync::mpsc::channel();
    let (force_send, force_recv) = std::sync::mpsc::channel();
    let event_handler = ChannelEventCollector::new(collision_send, force_send);

    // Step again with event collection
    pipeline.step(
        gravity,
        &params,
        &mut islands,
        &mut broad_phase,
        &mut narrow_phase,
        &mut bodies,
        &mut colliders,
        &mut impulse_joints,
        &mut multibody_joints,
        &mut ccd,
        &(),
        &event_handler,
    );

    // Drain events (may be empty, that's fine)
    while let Ok(_evt) = collision_recv.try_recv() {}
    while let Ok(_evt) = force_recv.try_recv() {}

    // 8. Rigid body removal cascades to colliders and joints
    bodies.remove(
        rb_handle,
        &mut islands,
        &mut colliders,
        &mut impulse_joints,
        &mut multibody_joints,
        true, // wake up touching
    );

    // 9. Joints compile — point![] needs .into() for glam Vec2 anchors
    let rb_a = bodies.insert(
        RigidBodyBuilder::dynamic()
            .translation(vector![0.0, 0.0].into())
            .build(),
    );
    let rb_b = bodies.insert(
        RigidBodyBuilder::dynamic()
            .translation(vector![50.0, 0.0].into())
            .build(),
    );
    let joint = RevoluteJointBuilder::new()
        .local_anchor1(point![0.0, 0.0].into())
        .local_anchor2(point![0.0, 0.0].into())
        .build();
    let _joint_handle = impulse_joints.insert(rb_a, rb_b, joint, true);

    // 10. KinematicCharacterController compiles (from rapier2d::control)
    let _controller = KinematicCharacterController::default();

    true // If we reach here, everything compiled and ran
}

/// Validate the wasm-bindgen feature variant (call from separate build).
#[wasm_bindgen]
pub fn spike_wasm_bindgen_check() -> bool {
    // Just verify IntegrationParameters::default() works
    // (wasm-bindgen feature affects timing internals)
    let params = IntegrationParameters::default();
    params.length_unit > 0.0
}

// =============================================================================
// Phase 15d Joint API Spike Tests
// =============================================================================
//
// ## Hard Blocker Findings (rapier2d 0.32)
//
// 1. `JointAxis::AngZ` does NOT exist in 2D. The 2D enum has:
//    - `JointAxis::LinX` (0) — translational X
//    - `JointAxis::LinY` (1) — translational Y
//    - `JointAxis::AngX` (2) — rotational (the only rotation axis in 2D)
//    USE `JointAxis::AngX` instead of `AngZ` for 2D rotation constraints.
//
// 2. `set_motor_velocity(axis, target_vel, factor)` — 3rd param is "factor" not "damping".
//    Signature: `fn set_motor_velocity(&mut self, axis: JointAxis, target_vel: f32, factor: f32) -> &mut Self`
//
// 3. `set_limits(axis, [min, max])` — confirmed as documented.
//    Signature: `fn set_limits(&mut self, axis: JointAxis, limits: [f32; 2]) -> &mut Self`
//
// 4. `set_local_anchor1/2` exist on `GenericJoint`. Take `Vector` (glam Vec2).
//    Signature: `fn set_local_anchor1(&mut self, anchor1: Vector) -> &mut Self`
//
// 5. `impulse_joint_set.insert(body1, body2, data, wake_up)` — 4 args confirmed.
//    `data: impl Into<GenericJoint>` so builders work directly.
//
// 6. `impulse_joint_set.remove(handle, wake_up)` — 2 args. Returns `Option<ImpulseJoint>`.
//    Body cascade removal: `bodies.remove()` cascades to joints (no double-free panic).
//
// 7. `SpringJointBuilder::new(rest_length, stiffness, damping)` — takes 3 params, NOT 1.
//    No defaults for stiffness/damping — they are constructor-required.
//    Spring uses implicit integration which adds numerical damping even at zero damping.
//
// 8. Spring joint has NO default stiffness/damping — they are constructor params.
//    Zero stiffness = no spring force. Zero damping = undamped (but numerical damping exists).
//
// Additional findings:
// - `PrismaticJointBuilder::new(axis)` takes `Vector` (glam Vec2), NOT `UnitVector`.
// - `FixedJointBuilder::new()` takes no args.
// - `RopeJointBuilder::new(max_dist)` takes f32.
// - `SpringJointBuilder` has `.spring_model(MotorModel)` for force-based vs acceleration-based.
// - `ImpulseJointSet::remove_joints_attached_to_rigid_body(handle)` exists for bulk removal.
// - Joint anchors on builders use `Vector` (glam Vec2), NOT `Point` / nalgebra types.
//   However, `point![x, y].into()` works because it converts nalgebra Point -> glam Vec2.
// - `ImpulseJointSet::get_mut(handle, wake_up)` takes 2 args (handle + bool), NOT 1.
//   The `wake_up` param wakes attached bodies when the joint is modified.
//
#[cfg(test)]
mod joint_api_tests {
    use rapier2d::prelude::*;

    /// Helper: creates a minimal physics world with two dynamic bodies + colliders.
    /// Returns (bodies, colliders, islands, impulse_joints, multibody_joints, handle_a, handle_b).
    fn setup_two_bodies() -> (
        RigidBodySet,
        ColliderSet,
        IslandManager,
        ImpulseJointSet,
        MultibodyJointSet,
        RigidBodyHandle,
        RigidBodyHandle,
    ) {
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let islands = IslandManager::new();
        let impulse_joints = ImpulseJointSet::new();
        let multibody_joints = MultibodyJointSet::new();

        let rb_a = bodies.insert(
            RigidBodyBuilder::dynamic()
                .translation(vector![0.0, 0.0].into())
                .build(),
        );
        let rb_b = bodies.insert(
            RigidBodyBuilder::dynamic()
                .translation(vector![100.0, 0.0].into())
                .build(),
        );

        // Dynamic bodies need colliders for mass
        colliders.insert_with_parent(ColliderBuilder::ball(10.0).build(), rb_a, &mut bodies);
        colliders.insert_with_parent(ColliderBuilder::ball(10.0).build(), rb_b, &mut bodies);

        (bodies, colliders, islands, impulse_joints, multibody_joints, rb_a, rb_b)
    }

    /// Helper: step the physics world once.
    fn step_world(
        bodies: &mut RigidBodySet,
        colliders: &mut ColliderSet,
        islands: &mut IslandManager,
        impulse_joints: &mut ImpulseJointSet,
        multibody_joints: &mut MultibodyJointSet,
    ) {
        let gravity: Vector = vector![0.0, -9.81].into();
        let params = IntegrationParameters::default();
        let mut pipeline = PhysicsPipeline::new();
        let mut broad_phase = DefaultBroadPhase::new();
        let mut narrow_phase = NarrowPhase::new();
        let mut ccd = CCDSolver::new();

        pipeline.step(
            gravity,
            &params,
            islands,
            &mut broad_phase,
            &mut narrow_phase,
            bodies,
            colliders,
            impulse_joints,
            multibody_joints,
            &mut ccd,
            &(),
            &(),
        );
    }

    // =========================================================================
    // Test 1: Revolute joint — full API surface
    // =========================================================================
    // Hard blockers verified:
    //   #1: JointAxis::AngX (NOT AngZ) for 2D rotation
    //   #2: set_motor_velocity(axis, target_vel, factor)
    //   #3: set_limits(axis, [min, max])
    //   #4: set_local_anchor1/2 on GenericJoint
    //   #5: insert(body1, body2, data, wake_up) = 4 args
    #[test]
    fn revolute_joint_full_api() {
        let (mut bodies, mut colliders, mut islands, mut impulse_joints, mut multibody_joints, rb_a, rb_b) =
            setup_two_bodies();

        // Build revolute joint with anchors
        let joint = RevoluteJointBuilder::new()
            .local_anchor1(point![10.0, 0.0].into())
            .local_anchor2(point![-10.0, 0.0].into())
            .build();

        // Insert: 4 args (body1, body2, data, wake_up)
        let joint_handle = impulse_joints.insert(rb_a, rb_b, joint, true);

        // Access the joint data and modify it
        // FINDING: get_mut takes 2 args: (handle, wake_up: bool)
        let joint_ref = impulse_joints.get_mut(joint_handle, true).unwrap();

        // FINDING: In 2D, rotation axis is JointAxis::AngX, NOT AngZ
        // JointAxis enum in 2D: LinX=0, LinY=1, AngX=2
        joint_ref.data.set_motor_velocity(JointAxis::AngX, 2.0, 0.5);
        joint_ref.data.set_limits(JointAxis::AngX, [-1.0, 1.0]);

        // set_local_anchor1/2 exist on GenericJoint
        joint_ref.data.set_local_anchor1(vector![5.0, 0.0].into());
        joint_ref.data.set_local_anchor2(vector![-5.0, 0.0].into());

        // Verify anchors were set
        let a1 = joint_ref.data.local_anchor1();
        let a2 = joint_ref.data.local_anchor2();
        assert!((a1.x - 5.0).abs() < 1e-5);
        assert!((a2.x - (-5.0)).abs() < 1e-5);

        // Step to verify no panic with motor + limits active
        step_world(&mut bodies, &mut colliders, &mut islands, &mut impulse_joints, &mut multibody_joints);

        // Verify motor is set
        let joint_ref = impulse_joints.get(joint_handle).unwrap();
        let motor = joint_ref.data.motor(JointAxis::AngX);
        assert!(motor.is_some());
        let motor = motor.unwrap();
        assert!((motor.target_vel - 2.0).abs() < 1e-5);

        // Verify limits are set
        let limits = joint_ref.data.limits(JointAxis::AngX);
        assert!(limits.is_some());
        let limits = limits.unwrap();
        assert!((limits.min - (-1.0)).abs() < 1e-5);
        assert!((limits.max - 1.0).abs() < 1e-5);
    }

    // =========================================================================
    // Test 2: Prismatic joint
    // =========================================================================
    // FINDING: PrismaticJointBuilder::new(axis) takes Vector, NOT UnitVector
    #[test]
    fn prismatic_joint_api() {
        let (mut bodies, mut colliders, mut islands, mut impulse_joints, mut multibody_joints, rb_a, rb_b) =
            setup_two_bodies();

        // FINDING: takes Vector (glam Vec2), not UnitVector
        let joint = PrismaticJointBuilder::new(vector![1.0, 0.0].into())
            .local_anchor1(point![0.0, 0.0].into())
            .local_anchor2(point![0.0, 0.0].into())
            .limits([-50.0, 50.0])
            .build();

        let joint_handle = impulse_joints.insert(rb_a, rb_b, joint, true);

        // Verify limits on LinX axis (the prismatic axis)
        let joint_ref = impulse_joints.get(joint_handle).unwrap();
        let limits = joint_ref.data.limits(JointAxis::LinX);
        assert!(limits.is_some());

        // Motor on the linear axis
        let joint_ref = impulse_joints.get_mut(joint_handle, true).unwrap();
        joint_ref.data.set_motor_velocity(JointAxis::LinX, 5.0, 1.0);

        step_world(&mut bodies, &mut colliders, &mut islands, &mut impulse_joints, &mut multibody_joints);
    }

    // =========================================================================
    // Test 3: Fixed joint
    // =========================================================================
    #[test]
    fn fixed_joint_api() {
        let (mut bodies, mut colliders, mut islands, mut impulse_joints, mut multibody_joints, rb_a, rb_b) =
            setup_two_bodies();

        // FixedJointBuilder::new() takes no args
        let joint = FixedJointBuilder::new()
            .local_anchor1(point![10.0, 0.0].into())
            .local_anchor2(point![-10.0, 0.0].into())
            .build();

        let _joint_handle = impulse_joints.insert(rb_a, rb_b, joint, true);

        // Step to verify constraint works
        step_world(&mut bodies, &mut colliders, &mut islands, &mut impulse_joints, &mut multibody_joints);

        // Bodies should remain relatively close due to fixed constraint
        let pos_a = bodies[rb_a].translation();
        let pos_b = bodies[rb_b].translation();
        let dist = ((pos_b.x - pos_a.x).powi(2) + (pos_b.y - pos_a.y).powi(2)).sqrt();
        // Fixed joint with anchor1=(10,0) and anchor2=(-10,0) means ~20 unit separation
        assert!(dist < 200.0, "Fixed joint should keep bodies relatively close, got {dist}");
    }

    // =========================================================================
    // Test 4: Rope joint
    // =========================================================================
    #[test]
    fn rope_joint_api() {
        let (mut bodies, mut colliders, mut islands, mut impulse_joints, mut multibody_joints, rb_a, rb_b) =
            setup_two_bodies();

        // RopeJointBuilder::new(max_dist) — takes a single f32
        let joint = RopeJointBuilder::new(150.0)
            .local_anchor1(point![0.0, 0.0].into())
            .local_anchor2(point![0.0, 0.0].into())
            .build();

        let _joint_handle = impulse_joints.insert(rb_a, rb_b, joint, true);

        step_world(&mut bodies, &mut colliders, &mut islands, &mut impulse_joints, &mut multibody_joints);
    }

    // =========================================================================
    // Test 5: Spring joint
    // =========================================================================
    // Hard blockers verified:
    //   #7: SpringJointBuilder::new(rest_length, stiffness, damping) — 3 params required
    //   #8: No defaults for stiffness/damping — they are constructor args
    #[test]
    fn spring_joint_api() {
        let (mut bodies, mut colliders, mut islands, mut impulse_joints, mut multibody_joints, rb_a, rb_b) =
            setup_two_bodies();

        // FINDING: SpringJointBuilder::new takes 3 args: (rest_length, stiffness, damping)
        // NOT just (rest_length). Stiffness and damping have no defaults.
        let joint = SpringJointBuilder::new(50.0, 100.0, 5.0)
            .local_anchor1(point![0.0, 0.0].into())
            .local_anchor2(point![0.0, 0.0].into())
            .build();

        let _joint_handle = impulse_joints.insert(rb_a, rb_b, joint, true);

        // Step multiple times to see spring in action
        for _ in 0..10 {
            step_world(&mut bodies, &mut colliders, &mut islands, &mut impulse_joints, &mut multibody_joints);
        }

        // Spring should be pulling bodies toward rest_length=50, starting from dist=100
        let pos_a = bodies[rb_a].translation();
        let pos_b = bodies[rb_b].translation();
        let dist = ((pos_b.x - pos_a.x).powi(2) + (pos_b.y - pos_a.y).powi(2)).sqrt();
        // With stiffness=100 and damping=5, after 10 steps bodies should be closer than initial 100
        assert!(dist < 100.0, "Spring should pull bodies closer, got dist={dist}");

        // Verify spring_model setter exists
        let joint2 = SpringJointBuilder::new(50.0, 200.0, 10.0)
            .spring_model(MotorModel::AccelerationBased)
            .build();
        let _h2 = impulse_joints.insert(rb_a, rb_b, joint2, true);

        // Zero stiffness = no spring force (just damping)
        let _joint_zero = SpringJointBuilder::new(50.0, 0.0, 0.0).build();
    }

    // =========================================================================
    // Test 6: Remove joint then remove body — no panic (double removal safety)
    // =========================================================================
    // Hard blocker #6: joint removal + body cascade = no panic
    #[test]
    fn remove_joint_then_remove_body_no_panic() {
        let (mut bodies, mut colliders, mut islands, mut impulse_joints, mut multibody_joints, rb_a, rb_b) =
            setup_two_bodies();

        // Create a revolute joint
        let joint = RevoluteJointBuilder::new()
            .local_anchor1(point![0.0, 0.0].into())
            .local_anchor2(point![0.0, 0.0].into())
            .build();
        let joint_handle = impulse_joints.insert(rb_a, rb_b, joint, true);

        // Step to make joint active
        step_world(&mut bodies, &mut colliders, &mut islands, &mut impulse_joints, &mut multibody_joints);

        // Remove joint explicitly (2 args: handle, wake_up)
        let removed = impulse_joints.remove(joint_handle, true);
        assert!(removed.is_some(), "Joint should have been removed");

        // Now remove body — cascade should NOT panic even though joint is already gone
        bodies.remove(
            rb_a,
            &mut islands,
            &mut colliders,
            &mut impulse_joints,
            &mut multibody_joints,
            true,
        );

        // Remove second body too — should not panic
        bodies.remove(
            rb_b,
            &mut islands,
            &mut colliders,
            &mut impulse_joints,
            &mut multibody_joints,
            true,
        );

        // Also test: remove body WITH joint still attached (cascade removal)
        let rb_c = bodies.insert(
            RigidBodyBuilder::dynamic()
                .translation(vector![0.0, 0.0].into())
                .build(),
        );
        let rb_d = bodies.insert(
            RigidBodyBuilder::dynamic()
                .translation(vector![50.0, 0.0].into())
                .build(),
        );
        colliders.insert_with_parent(ColliderBuilder::ball(5.0).build(), rb_c, &mut bodies);
        colliders.insert_with_parent(ColliderBuilder::ball(5.0).build(), rb_d, &mut bodies);

        let joint2 = RevoluteJointBuilder::new().build();
        let _jh2 = impulse_joints.insert(rb_c, rb_d, joint2, true);

        // Remove body C — should cascade-remove the joint without panic
        bodies.remove(
            rb_c,
            &mut islands,
            &mut colliders,
            &mut impulse_joints,
            &mut multibody_joints,
            true,
        );

        // Body D still alive, joint gone — remove D should also be fine
        bodies.remove(
            rb_d,
            &mut islands,
            &mut colliders,
            &mut impulse_joints,
            &mut multibody_joints,
            true,
        );
    }
}
