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
