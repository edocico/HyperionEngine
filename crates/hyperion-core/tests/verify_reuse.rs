//! Regression tests for the reuse of an external entity id (step 1b, design
//! `docs/plans/2026-09-27-id-reuse-design.md` §3-§4, R1-R6).
//!
//! The TypeScript allocator hands an id back only after a quarantine, so none of
//! these sequences should reach WASM from a correct host. They are defence in
//! depth: before 2026-09-27 each one let state keyed by the id — a pending
//! move, a pending joint, a Rapier body, a character controller, a body option —
//! pass from the old entity to the new one, or orphan an entity outright.

use hyperion_core::components::*;
use hyperion_core::engine::Engine;
use hyperion_core::ring_buffer::{Command, CommandType};

fn cmd(t: CommandType, id: u32, payload: [u8; 16]) -> Command {
    Command { cmd_type: t, entity_id: id, payload }
}
fn spawn2d(id: u32) -> Command {
    let mut p = [0u8; 16];
    p[0] = 1;
    cmd(CommandType::SpawnEntity, id, p)
}
fn spawn3d(id: u32) -> Command {
    cmd(CommandType::SpawnEntity, id, [0u8; 16])
}

// R4 — two spawns of one id inside one contiguous run of SpawnEntity (the
// `spawn_batch` path). The run retired the ids first and spawned every command
// after, so the first spawn became a second entity the map no longer reached:
// active, rendering, and beyond the reach of any DespawnEntity.
#[test]
fn r4_duplicate_id_inside_one_spawn_run_leaves_one_entity() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(7), spawn3d(7)]);
    e.update(1.0 / 60.0);

    let mapped: Vec<u32> = e.entity_map.iter_mapped().map(|(id, _)| id).collect();
    println!("R4 world.len={} gpu_count={} mapped={:?}",
        e.world.len(), e.render_state.gpu_entity_count(), mapped);
    assert_eq!(e.world.len(), 1, "one id, one entity");
    assert_eq!(e.render_state.gpu_entity_count(), 1, "no orphan may keep rendering");
    assert_eq!(mapped, vec![7]);

    // The LAST spawn wins, as it does when the two arrive one at a time.
    let ent = e.entity_map.get(7).unwrap();
    assert_eq!(e.world.get::<&ExternalId>(ent).unwrap().0, 7);
    assert!(e.world.get::<&Position>(ent).is_ok(), "the second spawn was 3D");
    assert!(e.world.get::<&Transform2D>(ent).is_err());
}

#[cfg(feature = "physics-2d")]
mod physics {
    use super::*;
    use hyperion_core::physics::{PhysicsBodyHandle, PhysicsColliderHandle};
    use hyperion_core::rapier2d;

    fn despawn(id: u32) -> Command {
        cmd(CommandType::DespawnEntity, id, [0u8; 16])
    }
    fn body(id: u32, kind: u8) -> Command {
        let mut p = [0u8; 16];
        p[0] = kind;
        cmd(CommandType::CreateRigidBody, id, p)
    }
    fn ball(id: u32) -> Command {
        let mut p = [0u8; 16];
        p[0] = 0; // ball
        p[1..5].copy_from_slice(&5.0f32.to_le_bytes());
        cmd(CommandType::CreateCollider, id, p)
    }
    fn controller(id: u32) -> Command {
        cmd(CommandType::CreateCharacterController, id, [0u8; 16])
    }
    /// `CreateFixedJoint`: entity A is the command's entity id, the joint id and
    /// entity B travel in the payload.
    fn fixed_joint(joint_id: u32, a: u32, b: u32) -> Command {
        let mut p = [0u8; 16];
        p[0..4].copy_from_slice(&joint_id.to_le_bytes());
        p[4..8].copy_from_slice(&b.to_le_bytes());
        cmd(CommandType::CreateFixedJoint, a, p)
    }
    fn f1(t: CommandType, id: u32, a: f32) -> Command {
        let mut p = [0u8; 16];
        p[0..4].copy_from_slice(&a.to_le_bytes());
        cmd(t, id, p)
    }
    fn move_character(id: u32, dx: f32, dy: f32) -> Command {
        let mut p = [0u8; 16];
        p[0..4].copy_from_slice(&dx.to_le_bytes());
        p[4..8].copy_from_slice(&dy.to_le_bytes());
        cmd(CommandType::MoveCharacter, id, p)
    }
    fn pos_of(e: &Engine, id: u32) -> (f32, f32) {
        let ent = e.entity_map.get(id).unwrap();
        let t = e.world.get::<&Transform2D>(ent).unwrap();
        (t.x, t.y)
    }
    fn gravity_scale_of(e: &Engine, id: u32) -> f32 {
        let ent = e.entity_map.get(id).unwrap();
        let h = e.world.get::<&PhysicsBodyHandle>(ent).unwrap().0;
        e.physics.rigid_body_set[h].gravity_scale()
    }
    fn sensor(id: u32) -> Command {
        let mut p = [0u8; 16];
        p[0] = 1;
        cmd(CommandType::SetColliderSensor, id, p)
    }
    fn is_sensor(e: &Engine, id: u32) -> bool {
        let ent = e.entity_map.get(id).unwrap();
        let h = e.world.get::<&PhysicsColliderHandle>(ent).unwrap().0;
        e.physics.collider_set[h].is_sensor()
    }
    fn joints_touching(e: &Engine, id: u32) -> usize {
        e.physics.joint_map.values().filter(|j| j.entity_a == id || j.entity_b == id).count()
    }
    /// A frame that runs no fixed tick: the accumulator stays below `FIXED_DT`.
    fn zero_tick_frame(e: &mut Engine) {
        let before = e.tick_count();
        e.update(0.001);
        assert_eq!(e.tick_count(), before, "precondition: this frame must run 0 ticks");
    }

    // R1 — MoveCharacter is routed in the second pass, AFTER the first pass has
    // run the despawn and its purge of `pending_moves`. So `[MoveCharacter 7,
    // Despawn 7]` queued a move for a dead id; it survived every frame that ran
    // no tick, and moved whatever entity took id 7 next.
    #[test]
    fn r1_move_for_a_despawned_id_is_not_queued() {
        let mut e = Engine::new();
        e.physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);
        e.process_commands(&[spawn2d(7), body(7, 2), ball(7), controller(7)]);
        e.update(1.0 / 60.0);

        e.process_commands(&[move_character(7, 100.0, 0.0), despawn(7)]);
        zero_tick_frame(&mut e);
        println!("R1 pending_moves after [MoveCharacter 7, Despawn 7] = {:?}",
            e.physics.pending_moves);
        assert!(!e.physics.pending_moves.iter().any(|m| m.0 == 7),
            "a move addressed to a dead id must not be queued");

        // The new 7 must not inherit the old displacement.
        e.process_commands(&[spawn2d(7), body(7, 2), ball(7), controller(7)]);
        e.update(1.0 / 60.0);
        e.update(1.0 / 60.0);
        println!("R1 new ext 7 at {:?} (expected (0, 0))", pos_of(&e, 7));
        assert_eq!(pos_of(&e, 7), (0.0, 0.0));

        // An id that was never spawned queues nothing either.
        e.process_commands(&[move_character(9, 1.0, 1.0)]);
        zero_tick_frame(&mut e);
        assert!(!e.physics.pending_moves.iter().any(|m| m.0 == 9),
            "a move for an unmapped id must be dropped");
    }

    // R2 — a joint named a dead id and waited in `pending_joints` until the
    // next tick, which resolved both ends by external id. If the id was reused
    // before that tick, the joint bound the NEW entity. Now a joint whose end is
    // not mapped when the command arrives is rejected, as SetParent is.
    #[test]
    fn r2_joint_to_a_despawned_id_is_rejected() {
        let mut e = Engine::new();
        e.physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);
        e.process_commands(&[spawn2d(1), body(1, 0), ball(1), spawn2d(7), body(7, 0), ball(7)]);
        e.update(1.0 / 60.0);

        // Entity B dead, then entity A dead.
        e.process_commands(&[despawn(7), fixed_joint(9, 1, 7), fixed_joint(10, 7, 1)]);
        zero_tick_frame(&mut e);
        println!("R2 pending_joints after joints to a dead id = {}", e.physics.pending_joints.len());
        assert!(e.physics.pending_joints.is_empty(), "no joint may wait for a dead id");

        e.process_commands(&[spawn2d(7), body(7, 0), ball(7)]);
        e.update(1.0 / 60.0);
        println!("R2 joints touching the reused ext 7 = {}", joints_touching(&e, 7));
        assert_eq!(joints_touching(&e, 7), 0, "the reused id must not inherit a joint");
        assert!(e.physics.joint_map.is_empty());
        assert_eq!(e.physics.impulse_joint_set.len(), 0);

        // Both ends live: the joint is still created, also when both are
        // spawned in the same batch as the joint.
        e.process_commands(&[fixed_joint(11, 1, 7)]);
        e.process_commands(&[spawn2d(3), body(3, 0), ball(3), fixed_joint(12, 3, 1)]);
        e.update(1.0 / 60.0);
        assert!(e.physics.joint_map.contains_key(&11));
        assert!(e.physics.joint_map.contains_key(&12));
    }

    /// A live 5 with a kinematic body, a collider, a controller and a joint to
    /// a live 6.
    fn live_five_with_everything() -> Engine {
        let mut e = Engine::new();
        e.physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);
        e.process_commands(&[
            spawn2d(5), body(5, 2), ball(5), controller(5),
            spawn2d(6), body(6, 0), ball(6), fixed_joint(1, 5, 6),
        ]);
        e.update(1.0 / 60.0);
        assert_eq!(e.physics.body_count(), 2);
        assert!(e.physics.character_map.contains_key(&5));
        assert!(e.physics.joint_map.contains_key(&1));
        e
    }

    fn assert_old_five_fully_retired(e: &Engine, tag: &str) {
        println!("{tag} world.len={} bodies={} colliders={} joints={} controller(5)={}",
            e.world.len(), e.physics.body_count(), e.physics.collider_set.len(),
            e.physics.impulse_joint_set.len(), e.physics.character_map.contains_key(&5));
        assert_eq!(e.world.len(), 2, "the new 5 and 6");
        assert_eq!(e.physics.body_count(), 1, "only 6's body: the old 5's must not be orphaned");
        assert_eq!(e.physics.collider_set.len(), 1);
        assert!(!e.physics.character_map.contains_key(&5),
            "the new 5 must not inherit the old controller");
        assert!(e.physics.joint_map.is_empty(), "the old 5's joint must go with its body");
        assert_eq!(e.physics.impulse_joint_set.len(), 0);
        let ent = e.entity_map.get(5).unwrap();
        assert!(e.world.get::<&PhysicsBodyHandle>(ent).is_err(), "the new 5 has no body of its own");
    }

    // R3 — a SpawnEntity for an id that is still live retires the old entity,
    // but ran no physics cleanup: its Rapier body kept simulating and colliding
    // with nothing in the ECS pointing at it, and the controller passed to the
    // new entity. Single-spawn path.
    #[test]
    fn r3_spawn_on_a_live_id_retires_its_physics() {
        let mut e = live_five_with_everything();
        e.process_commands(&[spawn2d(5)]);
        e.update(1.0 / 60.0);
        assert_old_five_fully_retired(&e, "R3");
    }

    // R3b — the same through a run of spawns (`spawn_batch` path).
    #[test]
    fn r3b_spawn_run_on_a_live_id_retires_its_physics() {
        let mut e = live_five_with_everything();
        e.process_commands(&[spawn2d(5), spawn2d(8)]);
        e.update(1.0 / 60.0);
        println!("R3b (run of spawns, 8 is new)");
        assert!(e.entity_map.get(8).is_some());
        e.process_commands(&[despawn(8)]);
        e.update(1.0 / 60.0);
        assert_old_five_fully_retired(&e, "R3b");
    }

    // R4b — the duplicate inside one run, on an id that is live with a body.
    #[test]
    fn r4b_duplicate_id_in_a_spawn_run_on_a_live_body_orphans_nothing() {
        let mut e = live_five_with_everything();
        e.process_commands(&[spawn2d(5), spawn2d(5)]);
        e.update(1.0 / 60.0);
        assert_old_five_fully_retired(&e, "R4b");
    }

    // R5 — the second (physics) pass resolved every command against the map as
    // it stood at the END of the batch. In `[SetGravityScale 7, Despawn 7,
    // Spawn 7, ...]` the gravity scale meant for the old 7 was staged onto the
    // new 7's pending body.
    #[test]
    fn r5_same_batch_body_option_for_the_old_id_does_not_reach_the_new_one() {
        let mut e = Engine::new();
        e.process_commands(&[spawn2d(7), body(7, 0), ball(7)]);
        e.update(1.0 / 60.0);

        e.process_commands(&[
            f1(CommandType::SetGravityScale, 7, 0.0), // for the OLD 7
            despawn(7),
            spawn2d(7), body(7, 0), ball(7),
        ]);
        e.update(1.0 / 60.0);
        println!("R5 new ext 7 gravity_scale = {} (1.0 = nothing leaked)", gravity_scale_of(&e, 7));
        assert_eq!(gravity_scale_of(&e, 7), 1.0);
    }

    // R5b — the same for a collider override and a character controller.
    #[test]
    fn r5b_same_batch_collider_override_and_controller_do_not_leak() {
        let mut e = Engine::new();
        e.process_commands(&[spawn2d(7), body(7, 2), ball(7)]);
        e.update(1.0 / 60.0);

        e.process_commands(&[
            sensor(7),     // for the OLD 7
            controller(7), // for the OLD 7
            despawn(7),
            spawn2d(7), body(7, 2), ball(7),
        ]);
        e.update(1.0 / 60.0);
        println!("R5b new ext 7 sensor={} controller={}",
            is_sensor(&e, 7), e.physics.character_map.contains_key(&7));
        assert!(!is_sensor(&e, 7));
        assert!(!e.physics.character_map.contains_key(&7));
    }

    // R5c — commands AFTER the re-spawn address the new entity and still apply,
    // also after a spawn that retired a live id.
    #[test]
    fn r5c_commands_after_the_respawn_still_apply() {
        let mut e = Engine::new();
        e.process_commands(&[spawn2d(7), body(7, 2), ball(7)]);
        e.update(1.0 / 60.0);

        e.process_commands(&[
            despawn(7),
            spawn2d(7), body(7, 2), ball(7),
            f1(CommandType::SetGravityScale, 7, 0.0),
            sensor(7),
            controller(7),
        ]);
        e.update(1.0 / 60.0);
        assert_eq!(gravity_scale_of(&e, 7), 0.0);
        assert!(is_sensor(&e, 7));
        assert!(e.physics.character_map.contains_key(&7));

        // A spawn on the live 7, then options: they belong to the newest 7.
        e.process_commands(&[
            f1(CommandType::SetGravityScale, 7, 3.0), // for the retired 7
            spawn2d(7), body(7, 2), ball(7),
            f1(CommandType::SetGravityScale, 7, 2.0),
        ]);
        e.update(1.0 / 60.0);
        assert_eq!(gravity_scale_of(&e, 7), 2.0);
    }

    // R6 — a body option for 7, then its despawn, then 7 re-spawned in a LATER
    // push. The case the TS quarantine produces: guards that it stays clean.
    #[test]
    fn r6_body_option_before_a_despawn_in_an_earlier_push_does_not_leak() {
        let mut e = Engine::new();
        e.process_commands(&[spawn2d(7), body(7, 0), ball(7)]);
        e.update(1.0 / 60.0);

        e.process_commands(&[f1(CommandType::SetGravityScale, 7, 0.0), despawn(7)]);
        e.update(1.0 / 60.0);
        e.process_commands(&[spawn2d(7), body(7, 0), ball(7)]);
        e.update(1.0 / 60.0);
        println!("R6 new ext 7 gravity_scale = {}", gravity_scale_of(&e, 7));
        assert_eq!(gravity_scale_of(&e, 7), 1.0);
    }
}
