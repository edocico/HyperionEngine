//! Regression tests for the physics defects found in the 2026-07 audit.
//!
//! Each test pins behaviour that was previously broken in a way no existing
//! test could catch. The comment on each names the defect it guards.
#![cfg(feature = "physics-2d")]

use hyperion_core::components::*;
use hyperion_core::engine::Engine;
use hyperion_core::physics::{PhysicsBodyHandle, PhysicsColliderHandle};
use hyperion_core::rapier2d;
use hyperion_core::ring_buffer::{Command, CommandType};

fn cmd(t: CommandType, id: u32, payload: [u8; 16]) -> Command {
    Command { cmd_type: t, entity_id: id, payload }
}
fn spawn2d(id: u32) -> Command {
    let mut p = [0u8; 16];
    p[0] = 1;
    cmd(CommandType::SpawnEntity, id, p)
}
fn body(id: u32, kind: u8) -> Command {
    let mut p = [0u8; 16];
    p[0] = kind;
    cmd(CommandType::CreateRigidBody, id, p)
}
fn collider(id: u32, shape: u8, a: f32, b: f32) -> Command {
    let mut p = [0u8; 16];
    p[0] = shape;
    p[1..5].copy_from_slice(&a.to_le_bytes());
    p[5..9].copy_from_slice(&b.to_le_bytes());
    cmd(CommandType::CreateCollider, id, p)
}
fn f2(t: CommandType, id: u32, a: f32, b: f32) -> Command {
    let mut p = [0u8; 16];
    p[0..4].copy_from_slice(&a.to_le_bytes());
    p[4..8].copy_from_slice(&b.to_le_bytes());
    cmd(t, id, p)
}
fn f1(t: CommandType, id: u32, a: f32) -> Command {
    let mut p = [0u8; 16];
    p[0..4].copy_from_slice(&a.to_le_bytes());
    cmd(t, id, p)
}
fn setpos(id: u32, x: f32, y: f32) -> Command {
    f2(CommandType::SetPosition, id, x, y)
}
fn events(id: u32, mask: u8) -> Command {
    let mut p = [0u8; 16];
    p[0] = mask;
    cmd(CommandType::SetColliderEvents, id, p)
}
fn col_of(e: &Engine, id: u32) -> &rapier2d::prelude::Collider {
    let ent = e.entity_map.get(id).unwrap();
    let h = e.world.get::<&PhysicsColliderHandle>(ent).unwrap().0;
    &e.physics.collider_set[h]
}
fn pos_of(e: &Engine, id: u32) -> (f32, f32) {
    let ent = e.entity_map.get(id).unwrap();
    let t = e.world.get::<&Transform2D>(ent).unwrap();
    (t.x, t.y)
}

// P1-1 — the five collider-override commands had no handler anywhere.
#[test]
fn p1_collider_overrides_apply_to_a_live_collider() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(0), body(0, 0), collider(0, 0, 10.0, 0.0)]);
    e.update(1.0 / 60.0);

    let mut sensor = [0u8; 16];
    sensor[0] = 1;
    let mut groups = [0u8; 16];
    groups[0..4].copy_from_slice(&0x0004_0002u32.to_le_bytes()); // membership 2, filter 4
    e.process_commands(&[
        cmd(CommandType::SetColliderSensor, 0, sensor),
        f1(CommandType::SetColliderFriction, 0, 0.95),
        f1(CommandType::SetColliderRestitution, 0, 0.9),
        f1(CommandType::SetColliderDensity, 0, 7.0),
        cmd(CommandType::SetCollisionGroups, 0, groups),
    ]);
    e.update(1.0 / 60.0);

    let c = col_of(&e, 0);
    println!("P1 sensor={} friction={} restitution={} density={}",
        c.is_sensor(), c.friction(), c.restitution(), c.density());
    assert!(c.is_sensor());
    assert_eq!(c.friction(), 0.95);
    assert_eq!(c.restitution(), 0.9);
    assert_eq!(c.density(), 7.0);
    assert_eq!(c.collision_groups().memberships.bits(), 0x0002);
    assert_eq!(c.collision_groups().filter.bits(), 0x0004);
}

// P1-7 / P1-1 — overrides issued in the SAME batch as the create commands used
// to be dropped, because the Rapier objects don't exist until update().
#[test]
fn p1b_collider_and_body_overrides_survive_the_creation_batch() {
    let mut e = Engine::new();
    let mut sensor = [0u8; 16];
    sensor[0] = 1;
    e.process_commands(&[
        spawn2d(0),
        body(0, 0),
        collider(0, 0, 10.0, 0.0),
        f1(CommandType::SetGravityScale, 0, 0.0),
        f1(CommandType::SetLinearDamping, 0, 3.0),
        f1(CommandType::SetColliderFriction, 0, 0.25),
        cmd(CommandType::SetColliderSensor, 0, sensor),
    ]);
    e.update(1.0);

    let ent = e.entity_map.get(0).unwrap();
    let h = e.world.get::<&PhysicsBodyHandle>(ent).unwrap().0;
    let rb = &e.physics.rigid_body_set[h];
    let (_, y) = pos_of(&e, 0);
    println!("P1b gravity_scale={} linear_damping={} friction={} sensor={} y_after_1s={}",
        rb.gravity_scale(), rb.linear_damping(), col_of(&e, 0).friction(),
        col_of(&e, 0).is_sensor(), y);
    assert_eq!(rb.gravity_scale(), 0.0, "gravityScale in the creation batch must apply");
    assert_eq!(rb.linear_damping(), 3.0);
    assert_eq!(col_of(&e, 0).friction(), 0.25);
    assert!(col_of(&e, 0).is_sensor());
    assert!(y.abs() < 0.001, "with gravityScale 0 the body must not fall, y={y}");
}

// P1-2 — `active_events` was unreachable: no command wrote it, so no collision
// event could ever be emitted.
#[test]
fn p2_collision_events_fire_once_enabled() {
    let mut e = Engine::new();
    e.process_commands(&[
        spawn2d(0), setpos(0, 0.0, 0.0), body(0, 0), collider(0, 0, 20.0, 0.0), events(0, 0x01),
        spawn2d(1), setpos(1, 5.0, 0.0), body(1, 0), collider(1, 0, 20.0, 0.0), events(1, 0x01),
    ]);
    let mut seen = 0;
    for _ in 0..6 {
        e.update(1.0 / 60.0);
        seen += e.physics.frame_collision_events.len();
    }
    println!("P2 active_events={:?} collision events seen={}",
        col_of(&e, 0).active_events(), seen);
    assert!(col_of(&e, 0).active_events().contains(
        rapier2d::prelude::ActiveEvents::COLLISION_EVENTS));
    assert!(seen > 0, "two overlapping bodies with events enabled must report a collision");
    let ev = &e.physics.frame_collision_events;
    if let Some(first) = ev.first() {
        assert!(first.entity_a <= 1 && first.entity_b <= 1, "events carry external ids");
    }
}

#[test]
fn p2b_events_stay_off_by_default() {
    let mut e = Engine::new();
    e.process_commands(&[
        spawn2d(0), setpos(0, 0.0, 0.0), body(0, 0), collider(0, 0, 20.0, 0.0),
        spawn2d(1), setpos(1, 5.0, 0.0), body(1, 0), collider(1, 0, 20.0, 0.0),
    ]);
    for _ in 0..6 { e.update(1.0 / 60.0); }
    assert!(col_of(&e, 0).active_events().is_empty(),
        "events are opt-in: not every collider should pay for event reporting");
}

// P1-3 — motors and limits always targeted AngX, a locked axis on prismatic,
// rope and spring joints.
#[test]
fn p3_joint_motor_targets_the_free_axis() {
    use rapier2d::prelude::JointAxis;
    let mut e = Engine::new();
    e.process_commands(&[
        spawn2d(0), setpos(0, 0.0, 0.0), body(0, 1), collider(0, 0, 5.0, 0.0),
        spawn2d(1), setpos(1, 30.0, 0.0), body(1, 0), collider(1, 0, 5.0, 0.0),
    ]);
    let mut jp = [0u8; 16];
    jp[0..4].copy_from_slice(&3u32.to_le_bytes());
    jp[4..8].copy_from_slice(&1u32.to_le_bytes());
    jp[8..12].copy_from_slice(&1.0f32.to_le_bytes());
    jp[12..16].copy_from_slice(&0.0f32.to_le_bytes());
    e.process_commands(&[cmd(CommandType::CreatePrismaticJoint, 0, jp)]);
    e.update(1.0 / 60.0);

    let mut mp = [0u8; 16];
    mp[0..4].copy_from_slice(&3u32.to_le_bytes());
    mp[4..8].copy_from_slice(&2.5f32.to_le_bytes());
    mp[8..12].copy_from_slice(&777.0f32.to_le_bytes());
    e.process_commands(&[cmd(CommandType::SetJointMotor, 0, mp)]);
    e.update(1.0 / 60.0);

    let entry = e.physics.joint_map.get(&3).unwrap();
    let j = e.physics.impulse_joint_set.get(entry.handle).unwrap();
    let linx = j.data.motor(JointAxis::LinX).copied().expect("LinX motor must exist");
    println!("P3 LinX target_vel={} max_force={} | AngX={:?}",
        linx.target_vel, linx.max_force, j.data.motor(JointAxis::AngX));
    assert_eq!(linx.target_vel, 2.5, "the prismatic joint's free axis must be driven");
    assert_eq!(linx.max_force, 777.0, "max_force must land in max_force, not damping");
    assert!(j.data.motor(JointAxis::AngX).is_none(),
        "the locked angular axis must not be touched");
}

#[test]
fn p3b_revolute_motor_still_uses_the_angular_axis() {
    use rapier2d::prelude::JointAxis;
    let mut e = Engine::new();
    e.process_commands(&[
        spawn2d(0), setpos(0, 0.0, 0.0), body(0, 1), collider(0, 0, 5.0, 0.0),
        spawn2d(1), setpos(1, 30.0, 0.0), body(1, 0), collider(1, 0, 5.0, 0.0),
    ]);
    let mut jp = [0u8; 16];
    jp[0..4].copy_from_slice(&4u32.to_le_bytes());
    jp[4..8].copy_from_slice(&1u32.to_le_bytes());
    e.process_commands(&[cmd(CommandType::CreateRevoluteJoint, 0, jp)]);
    e.update(1.0 / 60.0);
    let mut mp = [0u8; 16];
    mp[0..4].copy_from_slice(&4u32.to_le_bytes());
    mp[4..8].copy_from_slice(&1.5f32.to_le_bytes());
    mp[8..12].copy_from_slice(&99.0f32.to_le_bytes());
    e.process_commands(&[cmd(CommandType::SetJointMotor, 0, mp)]);
    e.update(1.0 / 60.0);
    let entry = e.physics.joint_map.get(&4).unwrap();
    let j = e.physics.impulse_joint_set.get(entry.handle).unwrap();
    let angx = j.data.motor(JointAxis::AngX).copied().unwrap();
    println!("P3b revolute AngX target_vel={} max_force={}", angx.target_vel, angx.max_force);
    assert_eq!(angx.target_vel, 1.5);
    assert_eq!(angx.max_force, 99.0);
}

// P1-4 — SetSpringParams hard-zeroed the stiffness and wrote the caller's
// stiffness into the damping slot, turning every spring into a pure damper.
#[test]
fn p4_set_spring_params_configures_the_spring() {
    use rapier2d::prelude::JointAxis;
    let mut e = Engine::new();
    e.process_commands(&[
        spawn2d(0), setpos(0, 0.0, 0.0), body(0, 1), collider(0, 0, 5.0, 0.0),
        spawn2d(1), setpos(1, 40.0, 0.0), body(1, 0), collider(1, 0, 5.0, 0.0),
    ]);
    let mut jp = [0u8; 16];
    jp[0..4].copy_from_slice(&9u32.to_le_bytes());
    jp[4..8].copy_from_slice(&1u32.to_le_bytes());
    jp[8..12].copy_from_slice(&40.0f32.to_le_bytes());
    e.process_commands(&[cmd(CommandType::CreateSpringJoint, 0, jp)]);
    e.update(1.0 / 60.0);

    let mut sp = [0u8; 16];
    sp[0..4].copy_from_slice(&9u32.to_le_bytes());
    sp[4..8].copy_from_slice(&500.0f32.to_le_bytes());
    sp[8..12].copy_from_slice(&12.0f32.to_le_bytes());
    e.process_commands(&[cmd(CommandType::SetSpringParams, 0, sp)]);
    e.update(1.0 / 60.0);

    let en = e.physics.joint_map.get(&9).unwrap();
    let j = e.physics.impulse_joint_set.get(en.handle).unwrap();
    let m = j.data.motor(JointAxis::LinX).copied().unwrap();
    println!("P4 stiffness={} damping={} rest_length={} | LinY={:?}",
        m.stiffness, m.damping, m.target_pos, j.data.motor(JointAxis::LinY));
    assert_eq!(m.stiffness, 500.0, "stiffness must be the stiffness");
    assert_eq!(m.damping, 12.0, "damping must be the damping");
    assert_eq!(m.target_pos, 40.0, "the rest length must be preserved");
    assert!(j.data.motor(JointAxis::LinY).is_none(),
        "no spurious motor on the coupled axis");
}

// P1-5 — a second CreateRigidBody inserted a second Rapier body and orphaned
// the first, which then survived even the entity's despawn.
#[test]
fn p5_recreating_a_body_replaces_it() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(0), body(0, 0), collider(0, 0, 10.0, 0.0)]);
    e.update(1.0 / 60.0);
    let n1 = e.physics.body_count();
    e.process_commands(&[body(0, 1), collider(0, 0, 10.0, 0.0)]); // switch to fixed
    e.update(1.0 / 60.0);
    let n2 = e.physics.body_count();
    e.process_commands(&[cmd(CommandType::DespawnEntity, 0, [0u8; 16])]);
    e.update(1.0 / 60.0);
    println!("P5 body_count {} -> {} -> {}, colliders left = {}",
        n1, n2, e.physics.body_count(), e.physics.collider_set.len());
    assert_eq!((n1, n2), (1, 1), "the body must be replaced, not duplicated");
    assert_eq!(e.physics.body_count(), 0);
    assert_eq!(e.physics.collider_set.len(), 0, "no ghost collider may survive");
}

#[test]
fn p5b_recreating_a_collider_replaces_it() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(0), body(0, 0), collider(0, 0, 10.0, 0.0)]);
    e.update(1.0 / 60.0);
    e.process_commands(&[collider(0, 0, 40.0, 0.0)]);
    e.update(1.0 / 60.0);
    println!("P5b collider_set.len={} radius={}",
        e.physics.collider_set.len(),
        col_of(&e, 0).shape().as_ball().unwrap().radius);
    assert_eq!(e.physics.collider_set.len(), 1);
    assert_eq!(col_of(&e, 0).shape().as_ball().unwrap().radius, 40.0);
}

// P1-12 — the character controller registration is keyed by external id and
// leaked when the entity died before its body existed.
#[test]
fn p6_character_controller_does_not_leak_on_same_batch_despawn() {
    let mut e = Engine::new();
    e.process_commands(&[
        spawn2d(7), body(7, 2), collider(7, 0, 5.0, 0.0),
        cmd(CommandType::CreateCharacterController, 7, [0u8; 16]),
        cmd(CommandType::DespawnEntity, 7, [0u8; 16]),
    ]);
    e.update(1.0 / 60.0);
    println!("P6 character_map still has ext 7 = {}", e.physics.character_map.contains_key(&7));
    assert!(!e.physics.character_map.contains_key(&7),
        "a recycled external id must not inherit a dead controller");
}

#[test]
fn p6b_destroy_rigid_body_keeps_the_character_controller() {
    let mut e = Engine::new();
    e.process_commands(&[
        spawn2d(0), body(0, 2), collider(0, 0, 5.0, 0.0),
        cmd(CommandType::CreateCharacterController, 0, [0u8; 16]),
    ]);
    e.update(1.0 / 60.0);
    assert!(e.physics.character_map.contains_key(&0));
    // The canonical "swap body type" sequence must not deregister the controller.
    e.process_commands(&[cmd(CommandType::DestroyRigidBody, 0, [0u8; 16]), body(0, 2)]);
    e.update(1.0 / 60.0);
    println!("P6b controller survives DestroyRigidBody = {}",
        e.physics.character_map.contains_key(&0));
    assert!(e.physics.character_map.contains_key(&0));

    // …but an explicit teardown does remove it.
    e.process_commands(&[cmd(CommandType::DestroyCharacterController, 0, [0u8; 16])]);
    e.update(1.0 / 60.0);
    assert!(!e.physics.character_map.contains_key(&0));
}

// P1-6 — MoveCharacter was silently scaled by the tick:frame ratio and fully
// cancelled on any frame that ran more than one fixed tick.
#[test]
fn p7_move_character_preserves_displacement_at_high_refresh() {
    let mut e = Engine::new();
    e.physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);
    e.process_commands(&[
        spawn2d(0), body(0, 2), collider(0, 0, 5.0, 0.0),
        cmd(CommandType::CreateCharacterController, 0, [0u8; 16]),
    ]);
    e.update(1.0 / 60.0);
    for _ in 0..144 {
        e.process_commands(&[f2(CommandType::MoveCharacter, 0, 1.0, 0.0)]);
        e.update(1.0 / 144.0);
    }
    let (x, _) = pos_of(&e, 0);
    println!("P7 x after 144 x MoveCharacter(+1) at 144Hz = {x} (expected ~144)");
    assert!(x > 140.0, "displacement must not be scaled by the tick/frame ratio, got {x}");
}

#[test]
fn p7b_move_character_survives_a_multi_tick_frame() {
    let mut e = Engine::new();
    e.physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);
    e.process_commands(&[
        spawn2d(0), body(0, 2), collider(0, 0, 5.0, 0.0),
        cmd(CommandType::CreateCharacterController, 0, [0u8; 16]),
    ]);
    e.update(1.0 / 60.0);
    e.process_commands(&[f2(CommandType::MoveCharacter, 0, 50.0, 0.0)]);
    e.update(2.0 / 60.0); // one 30 fps frame -> 2 fixed ticks
    let (x, _) = pos_of(&e, 0);
    println!("P7b x after a 30fps frame with MoveCharacter(+50) = {x}");
    assert!((x - 50.0).abs() < 0.1, "a 30 fps frame must not cancel the move, got {x}");
}

#[test]
fn p7c_two_moves_in_one_frame_compose() {
    let mut e = Engine::new();
    e.physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);
    e.process_commands(&[
        spawn2d(0), body(0, 2), collider(0, 0, 5.0, 0.0),
        cmd(CommandType::CreateCharacterController, 0, [0u8; 16]),
    ]);
    e.update(1.0 / 60.0);
    e.process_commands(&[
        f2(CommandType::MoveCharacter, 0, 10.0, 0.0),
        f2(CommandType::MoveCharacter, 0, 20.0, 0.0),
    ]);
    e.update(1.0 / 60.0);
    let (x, _) = pos_of(&e, 0);
    println!("P7c x after MoveCharacter(+10) then (+20) in one frame = {x}");
    assert!((x - 30.0).abs() < 0.1, "moves in one frame must compose, got {x}");
}

// P1-13 — degenerate collider dimensions were handed straight to Rapier.
#[test]
fn p10_degenerate_collider_dimensions_are_rejected() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(0), body(0, 0), collider(0, 0, -5.0, 0.0)]);
    e.process_commands(&[spawn2d(1), body(1, 0), collider(1, 0, f32::NAN, 0.0)]);
    e.process_commands(&[spawn2d(2), body(2, 0), collider(2, 0, 0.0, 0.0)]);
    e.process_commands(&[spawn2d(3), body(3, 0), collider(3, 0, 10.0, 0.0)]);
    e.update(1.0 / 60.0);
    e.update(1.0 / 60.0);
    println!("P10 colliders created = {} (only the valid one)", e.physics.collider_set.len());
    assert_eq!(e.physics.collider_set.len(), 1, "only the valid collider may exist");
    for id in 0..3u32 {
        let ent = e.entity_map.get(id).unwrap();
        let t = e.world.get::<&Transform2D>(ent).unwrap();
        assert!(t.x.is_finite() && t.y.is_finite(), "no NaN may reach the ECS transform");
        // The rejected pending component must not be re-scanned forever.
        assert!(e.world.get::<&hyperion_core::physics::PendingCollider>(ent).is_err(),
            "a rejected PendingCollider must not stay attached");
    }
}

// P1-9 — there was no way to reposition a body Rapier owns.
#[test]
fn p11_setposition_repositions_a_dynamic_body() {
    let mut e = Engine::new();
    e.physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);
    e.process_commands(&[spawn2d(0), body(0, 0), collider(0, 0, 10.0, 0.0)]);
    e.update(1.0 / 60.0);
    e.process_commands(&[setpos(0, 500.0, 500.0)]);
    e.update(1.0 / 60.0);
    e.update(1.0 / 60.0);
    let after = pos_of(&e, 0);
    println!("P11 dynamic body after SetPosition(500,500) + 2 frames = {after:?}");
    assert!((after.0 - 500.0).abs() < 0.5 && (after.1 - 500.0).abs() < 0.5,
        "SetPosition must move the Rapier body, got {after:?}");
}

#[test]
fn p11b_teleport_body_clears_velocity() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(0), body(0, 0), collider(0, 0, 10.0, 0.0)]);
    for _ in 0..10 { e.update(1.0 / 60.0); }
    let ent = e.entity_map.get(0).unwrap();
    let h = e.world.get::<&PhysicsBodyHandle>(ent).unwrap().0;
    let falling = e.physics.rigid_body_set[h].linvel().y;
    assert!(falling > 1.0, "the body should be falling before the teleport");

    let mut p = [0u8; 16];
    p[0..4].copy_from_slice(&10.0f32.to_le_bytes());
    p[4..8].copy_from_slice(&20.0f32.to_le_bytes());
    p[8..12].copy_from_slice(&0.0f32.to_le_bytes());
    p[12] = 0x01; // zero velocity
    e.process_commands(&[cmd(CommandType::TeleportBody, 0, p)]);
    e.update(1.0 / 60.0);
    let h = e.world.get::<&PhysicsBodyHandle>(e.entity_map.get(0).unwrap()).unwrap().0;
    let v = e.physics.rigid_body_set[h].linvel().y;
    let (x, y) = pos_of(&e, 0);
    println!("P11b after TeleportBody: pos=({x},{y}) linvel.y={v} (was {falling})");
    assert!((x - 10.0).abs() < 0.5);
    assert!(v.abs() < falling, "velocity must have been cleared, got {v}");
}

// P1-10 — reusing a joint id dropped the only handle to the previous joint.
#[test]
fn p12_joint_id_reuse_is_rejected() {
    let mut e = Engine::new();
    for i in 0..4u32 {
        e.process_commands(&[spawn2d(i), setpos(i, i as f32 * 30.0, 0.0), body(i, 0),
            collider(i, 0, 5.0, 0.0)]);
    }
    e.update(1.0 / 60.0);
    let mk = |a: u32, b: u32| {
        let mut p = [0u8; 16];
        p[0..4].copy_from_slice(&5u32.to_le_bytes());
        p[4..8].copy_from_slice(&b.to_le_bytes());
        cmd(CommandType::CreateFixedJoint, a, p)
    };
    e.process_commands(&[mk(0, 1)]);
    e.update(1.0 / 60.0);
    e.process_commands(&[mk(2, 3)]);
    e.update(1.0 / 60.0);
    println!("P12 joint_map.len={} impulse_joint_set.len={}",
        e.physics.joint_map.len(), e.physics.impulse_joint_set.len());
    assert_eq!(e.physics.joint_map.len(), 1);
    assert_eq!(e.physics.impulse_joint_set.len(), 1,
        "a duplicate joint id must be rejected, not leaked");

    // Removing the id frees it for reuse.
    let mut rp = [0u8; 16];
    rp[0..4].copy_from_slice(&5u32.to_le_bytes());
    e.process_commands(&[cmd(CommandType::RemoveJoint, 0, rp)]);
    e.process_commands(&[mk(2, 3)]);
    e.update(1.0 / 60.0);
    assert_eq!(e.physics.impulse_joint_set.len(), 1);
}

// P1-11 — the KCC's `up` was hardcoded to +Y, the same direction as the
// engine's documented default gravity, so `grounded` was never true.
#[test]
fn p13_character_up_follows_gravity() {
    let mut e = Engine::new();
    assert_eq!(e.physics.gravity.y, 980.0, "default gravity is +Y = down in pixel space");
    e.process_commands(&[
        spawn2d(1), setpos(1, 0.0, 50.0), body(1, 1), collider(1, 1, 1000.0, 20.0),
        spawn2d(0), setpos(0, 0.0, 0.0), body(0, 2), collider(0, 0, 10.0, 0.0),
        cmd(CommandType::CreateCharacterController, 0, [0u8; 16]),
    ]);
    e.update(1.0 / 60.0);
    for _ in 0..10 {
        e.process_commands(&[f2(CommandType::MoveCharacter, 0, 0.0, 20.0)]);
        e.update(1.0 / 60.0);
    }
    let st = &e.physics.character_map.get(&0).unwrap().state;
    let (_, y) = pos_of(&e, 0);
    println!("P13 char y={y} grounded={}", st.grounded);
    assert!(st.grounded, "standing on the floor must report grounded");
}

#[test]
fn p13b_explicit_character_up_overrides_gravity() {
    let mut e = Engine::new();
    e.process_commands(&[
        spawn2d(0), body(0, 2), collider(0, 0, 5.0, 0.0),
        cmd(CommandType::CreateCharacterController, 0, [0u8; 16]),
        f2(CommandType::SetCharacterUp, 0, 1.0, 0.0),
    ]);
    e.update(1.0 / 60.0);
    let up = e.physics.character_map.get(&0).unwrap().controller.up;
    println!("P13c explicit up = ({}, {})", up.x, up.y);
    assert_eq!((up.x, up.y), (1.0, 0.0));
}

// The capsule takes (halfHeight, radius) — matching the TS overload
// `collider('capsule', { halfHeight, radius })`. The box takes full extents.
// Not a defect, but the asymmetry is easy to get wrong, so pin it.
#[test]
fn p9_shape_param_conventions() {
    use rapier2d::prelude::ShapeType;
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(0), body(0, 0), collider(0, 1, 40.0, 60.0)]);
    e.process_commands(&[spawn2d(1), body(1, 0), collider(1, 2, 40.0, 5.0)]);
    e.update(1.0 / 60.0);
    let cub = col_of(&e, 0).shape().as_cuboid().unwrap().half_extents;
    let cap = col_of(&e, 1).shape().as_capsule().unwrap();
    println!("P9 box(40,60) -> half_extents {cub:?}; capsule(halfHeight 40, r 5) -> \
        half_height {} radius {}", (cap.segment.b.y - cap.segment.a.y).abs() / 2.0, cap.radius);
    assert_eq!(col_of(&e, 1).shape().shape_type(), ShapeType::Capsule);
    assert_eq!(cub, [20.0, 30.0].into(), "box params are FULL width/height");
    assert_eq!((cap.segment.b.y - cap.segment.a.y).abs() / 2.0, 40.0,
        "capsule param 0 is the HALF height");
    assert_eq!(cap.radius, 5.0);
}

// P1-14b — sensors are trigger volumes and must not physically block the
// character controller.
#[test]
fn p14_sensors_do_not_block_the_character() {
    let mut e = Engine::new();
    e.physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);
    let mut sensor = [0u8; 16];
    sensor[0] = 1;
    e.process_commands(&[
        spawn2d(1), setpos(1, 50.0, 0.0), body(1, 1), collider(1, 1, 10.0, 200.0),
        cmd(CommandType::SetColliderSensor, 1, sensor),
        spawn2d(0), setpos(0, 0.0, 0.0), body(0, 2), collider(0, 0, 5.0, 0.0),
        cmd(CommandType::CreateCharacterController, 0, [0u8; 16]),
    ]);
    e.update(1.0 / 60.0);
    e.process_commands(&[f2(CommandType::MoveCharacter, 0, 100.0, 0.0)]);
    e.update(1.0 / 60.0);
    let (x, _) = pos_of(&e, 0);
    println!("P14 character x after walking through a sensor wall = {x}");
    assert!(x > 90.0, "a trigger volume must not stop the character, got {x}");
}

// P1-14c — the `Stopped` event arrives one step AFTER the body is removed, so
// clearing the collider→entity reverse map on removal silently dropped it.
#[test]
fn p15_stopped_event_survives_a_despawn() {
    let mut e = Engine::new();
    e.physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);
    e.process_commands(&[
        spawn2d(0), setpos(0, 0.0, 0.0), body(0, 0), collider(0, 0, 20.0, 0.0), events(0, 0x01),
        spawn2d(1), setpos(1, 5.0, 0.0), body(1, 0), collider(1, 0, 20.0, 0.0), events(1, 0x01),
    ]);
    let mut started = 0;
    for _ in 0..4 {
        e.update(1.0 / 60.0);
        started += e.physics.frame_collision_events.iter()
            .filter(|ev| ev.event_type == 0).count();
    }
    assert!(started > 0, "the two bodies must overlap first");

    e.process_commands(&[cmd(CommandType::DespawnEntity, 1, [0u8; 16])]);
    let mut stopped = Vec::new();
    for _ in 0..3 {
        e.update(1.0 / 60.0);
        stopped.extend(e.physics.frame_collision_events.iter()
            .filter(|ev| ev.event_type == 1)
            .map(|ev| (ev.entity_a, ev.entity_b)));
    }
    println!("P15 stopped events after despawning one side = {stopped:?}");
    assert!(!stopped.is_empty(),
        "the surviving entity must still be told the overlap ended");
    assert!(stopped.iter().any(|&(a, b)| a == 0 || b == 0));
}

// ─────────────────────────────────────────────────────────────────
// P16 (found 2026-09-26): a child of a physics body must follow it on the GPU.
//
// `mark_post_system_dirty` propagated "parent is dirty" to descendants in its
// pass 2, but marked the physics bodies themselves only in pass 3, afterwards.
// A body moved by Rapier (and not by a Velocity) therefore never had its
// children staged. `propagate_transforms` kept their ModelMatrix right in the
// ECS, while their GPU row kept whatever it held the last time something else
// dirtied it. The child here is 3D on purpose: a 2D child also hits a
// separate defect in the SoA writers, which would mask this one.
// ─────────────────────────────────────────────────────────────────
#[test]
fn p16_child_of_a_physics_body_follows_it_on_the_gpu() {
    let mut e = Engine::new();
    let mut parent = [0u8; 16];
    parent[0..4].copy_from_slice(&0u32.to_le_bytes());
    e.process_commands(&[
        spawn2d(0), body(0, 0), collider(0, 0, 10.0, 0.0),
        cmd(CommandType::SpawnEntity, 1, [0u8; 16]), // 3D
        cmd(CommandType::SetParent, 1, parent),
    ]);
    for _ in 0..10 {
        e.update(1.0 / 60.0);
    }

    let (_, body_y) = pos_of(&e, 0);
    assert!(body_y.abs() > 1.0, "gravity must have moved the body (y = {body_y})");

    let child = e.entity_map.get(1).unwrap();
    let ecs = e.world.get::<&ModelMatrix>(child).unwrap().0;
    let slot = e.render_state.get_slot(child).unwrap() as usize;
    let gpu = &e.render_state.gpu_transforms()[slot * 16..slot * 16 + 16];
    println!("P16 body y={body_y} child ECS ty={} GPU ty={}", ecs[13], gpu[13]);
    assert!((ecs[13] - body_y).abs() < 1e-3, "the ECS world matrix follows the body");
    for i in 0..16 {
        assert!((gpu[i] - ecs[i]).abs() < 1e-4,
            "GPU word {i} = {} but the ECS world matrix says {}", gpu[i], ecs[i]);
    }
}
