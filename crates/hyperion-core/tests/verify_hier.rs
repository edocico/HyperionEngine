//! Regression tests for scene-graph lifecycle (audit 2026-07, P2-1).
//!
//! Before the audit `DespawnEntity` never touched the hierarchy: a despawned
//! parent left its children pointing at a dead external id (which TS then
//! recycled, silently re-parenting the orphan under a stranger), a despawned
//! child stayed in its parent's `Children` forever, and a despawn/respawn round
//! trip could list the same child twice — after which nothing could remove it.

use hyperion_core::components::*;
use hyperion_core::engine::Engine;
use hyperion_core::ring_buffer::{Command, CommandType};

fn c(t: CommandType, id: u32, p: [u8; 16]) -> Command {
    Command { cmd_type: t, entity_id: id, payload: p }
}
fn spawn(id: u32) -> Command { c(CommandType::SpawnEntity, id, [0u8; 16]) }
fn parent(child: u32, par: u32) -> Command {
    let mut p = [0u8; 16];
    p[0..4].copy_from_slice(&par.to_le_bytes());
    c(CommandType::SetParent, child, p)
}
fn despawn(id: u32) -> Command { c(CommandType::DespawnEntity, id, [0u8; 16]) }

#[test]
fn h1_despawning_a_parent_orphans_its_children_cleanly() {
    let mut e = Engine::new();
    e.process_commands(&[spawn(0), spawn(1), parent(1, 0)]);
    e.update(1.0 / 60.0);
    e.process_commands(&[despawn(0)]);
    e.update(1.0 / 60.0);

    let child = e.entity_map.get(1).unwrap();
    let p = e.world.get::<&Parent>(child).unwrap().0;
    println!("H1 after despawning the parent, child.Parent = {p} (u32::MAX = root)");
    assert_eq!(p, u32::MAX, "the child must become a root, not keep a dangling link");

    // ABA: external id 0 is reused by an unrelated entity — the old orphan must
    // NOT silently re-attach to it.
    e.process_commands(&[spawn(0)]);
    e.update(1.0 / 60.0);
    let new_parent = e.entity_map.get(0).unwrap();
    let kids = e.world.get::<&Children>(new_parent).map(|k| k.count).unwrap_or(0);
    assert_eq!(kids, 0);
    assert_eq!(e.world.get::<&Parent>(child).unwrap().0, u32::MAX,
        "id reuse must not resurrect the old link");
}

#[test]
fn h2_despawning_a_child_removes_it_from_the_parent() {
    let mut e = Engine::new();
    e.process_commands(&[spawn(0), spawn(1), parent(1, 0)]);
    e.update(1.0 / 60.0);
    assert_eq!(e.world.get::<&Children>(e.entity_map.get(0).unwrap()).unwrap().count, 1);

    e.process_commands(&[despawn(1)]);
    e.update(1.0 / 60.0);
    let par = e.entity_map.get(0).unwrap();
    let k = e.world.get::<&Children>(par).unwrap();
    println!("H2 parent lists {} children after the child was despawned", k.count);
    assert_eq!(k.count, 0, "dead child ids must not accumulate towards the 32-slot cap");
}

#[test]
fn h3_children_list_never_holds_duplicates() {
    let mut e = Engine::new();
    e.process_commands(&[spawn(0), spawn(1), parent(1, 0)]);
    e.update(1.0 / 60.0);
    e.process_commands(&[despawn(1)]);
    e.process_commands(&[spawn(1)]);     // external id reused
    e.process_commands(&[parent(1, 0)]);
    e.update(1.0 / 60.0);
    let par = e.entity_map.get(0).unwrap();
    let k = e.world.get::<&Children>(par).unwrap();
    println!("H3 Children = {:?}", &k.slots[..k.count as usize]);
    assert_eq!(k.count, 1, "the same child must appear exactly once");
    drop(k);

    // and an unparent must fully clear it
    e.process_commands(&[parent(1, u32::MAX)]);
    e.update(1.0 / 60.0);
    assert_eq!(e.world.get::<&Children>(par).unwrap().count, 0,
        "unparenting must leave no phantom child behind");
}

#[test]
fn h4_parenting_to_an_unknown_id_is_rejected() {
    let mut e = Engine::new();
    e.process_commands(&[spawn(1), parent(1, 77)]);
    e.update(1.0 / 60.0);
    let ch = e.entity_map.get(1).unwrap();
    let p = e.world.get::<&Parent>(ch).unwrap().0;
    println!("H4 SetParent towards a never-spawned id 77 -> {p}");
    assert_eq!(p, u32::MAX, "no half-link may be created");

    // Spawning id 77 later must not retro-attach the child.
    e.process_commands(&[spawn(77)]);
    e.update(1.0 / 60.0);
    assert_eq!(e.world.get::<&Parent>(ch).unwrap().0, u32::MAX);
    assert_eq!(e.world.get::<&Children>(e.entity_map.get(77).unwrap()).unwrap().count, 0);
}

#[test]
fn h5_overflow_children_are_removed_on_despawn() {
    let mut e = Engine::new();
    let mut cmds = vec![spawn(0)];
    for id in 1..=40u32 {
        cmds.push(spawn(id));
    }
    e.process_commands(&cmds);
    let links: Vec<Command> = (1..=40u32).map(|id| parent(id, 0)).collect();
    e.process_commands(&links);
    e.update(1.0 / 60.0);

    let par = e.entity_map.get(0).unwrap();
    let inline = e.world.get::<&Children>(par).unwrap().count;
    let overflow = e.world.get::<&OverflowChildren>(par).map(|o| o.items.len()).unwrap_or(0);
    println!("H5 40 children -> inline {inline} + overflow {overflow}");
    assert_eq!(inline as usize + overflow, 40);

    // Despawn every child: both storages must end up empty.
    let kills: Vec<Command> = (1..=40u32).map(despawn).collect();
    e.process_commands(&kills);
    e.update(1.0 / 60.0);
    assert_eq!(e.world.get::<&Children>(par).unwrap().count, 0);
    assert!(e.world.get::<&OverflowChildren>(par).is_err(),
        "an emptied overflow list must be removed entirely");
}

// ─────────────────────────────────────────────────────────────────
// H6/H7 (found 2026-09-26): the GPU rows of a child are in WORLD space.
//
// The SoA writers took world-space data from LOCAL components, which match
// the world only for a root. `write_slot_2d` built the transform row of every
// 2D entity from its own Transform2D, so a 2D child was drawn at its local
// offset from the origin, even with nothing moving. Both writers also took the
// culling sphere's centre from the local position, so a child of any
// archetype was culled against a sphere somewhere else, and could vanish while
// on screen. The world transform of every entity is its ModelMatrix, which
// `propagate_transforms` composes for children.
// ─────────────────────────────────────────────────────────────────
fn spawn2d(id: u32) -> Command {
    let mut p = [0u8; 16];
    p[0] = 1;
    c(CommandType::SpawnEntity, id, p)
}
fn setpos(id: u32, x: f32, y: f32) -> Command {
    let mut p = [0u8; 16];
    p[0..4].copy_from_slice(&x.to_le_bytes());
    p[4..8].copy_from_slice(&y.to_le_bytes());
    c(CommandType::SetPosition, id, p)
}
fn gpu_row(e: &Engine, id: u32) -> (Vec<f32>, [f32; 4], [f32; 16]) {
    let ent = e.entity_map.get(id).unwrap();
    let s = e.render_state.get_slot(ent).unwrap() as usize;
    let t = e.render_state.gpu_transforms()[s * 16..s * 16 + 16].to_vec();
    let b = e.render_state.gpu_bounds()[s * 4..s * 4 + 4].try_into().unwrap();
    (t, b, e.world.get::<&ModelMatrix>(ent).unwrap().0)
}

#[test]
fn h6_a_2d_child_is_drawn_at_its_world_position() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(0), setpos(0, 100.0, 50.0), spawn2d(1), setpos(1, 10.0, 0.0), parent(1, 0)]);
    e.update(1.0 / 60.0);

    let (gpu, _, world) = gpu_row(&e, 1);
    println!("H6 2D child: world t=({}, {}), GPU t=({}, {})", world[12], world[13], gpu[12], gpu[13]);
    assert_eq!((world[12], world[13]), (110.0, 50.0), "the ECS composes the parent in");
    for i in 0..16 {
        assert!((gpu[i] - world[i]).abs() < 1e-4, "GPU word {i} = {}, world = {}", gpu[i], world[i]);
    }
}

#[test]
fn h7_every_culling_sphere_is_centred_on_the_world_position() {
    let mut e = Engine::new();
    e.process_commands(&[
        spawn2d(0), setpos(0, 100.0, 50.0),               // 2D root
        spawn2d(1), setpos(1, 10.0, 0.0), parent(1, 0),   // 2D child
        spawn(2), setpos(2, -40.0, 0.0),                  // 3D root
        spawn(3), setpos(3, 0.0, 7.0), parent(3, 2),      // 3D child
        spawn(4), setpos(4, 1.0, 1.0), parent(4, 3),      // 3D grandchild
    ]);
    e.update(1.0 / 60.0);

    for id in 0..5 {
        let (_, bounds, world) = gpu_row(&e, id);
        println!("H7 id {id}: sphere centre ({}, {}, {}), world t ({}, {}, {})",
            bounds[0], bounds[1], bounds[2], world[12], world[13], world[14]);
        for k in 0..3 {
            assert!((bounds[k] - world[12 + k]).abs() < 1e-4,
                "id {id}: sphere centre[{k}] = {}, world translation = {}", bounds[k], world[12 + k]);
        }
    }
}
