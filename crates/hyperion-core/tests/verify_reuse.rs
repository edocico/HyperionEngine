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
    use hyperion_core::physics::PhysicsBodyHandle;
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
}
