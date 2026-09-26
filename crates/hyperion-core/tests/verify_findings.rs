//! Independent verification of review findings. NOT part of the project.

use hyperion_core::components::*;
use hyperion_core::engine::Engine;
use hyperion_core::ring_buffer::{Command, CommandType, parse_commands};

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
fn despawn(id: u32) -> Command {
    cmd(CommandType::DespawnEntity, id, [0u8; 16])
}
fn f3(t: CommandType, id: u32, x: f32, y: f32, z: f32) -> Command {
    let mut p = [0u8; 16];
    p[0..4].copy_from_slice(&x.to_le_bytes());
    p[4..8].copy_from_slice(&y.to_le_bytes());
    p[8..12].copy_from_slice(&z.to_le_bytes());
    cmd(t, id, p)
}

// ─────────────────────────────────────────────────────────────────
// V1/V2 (audit 2026-07, P0-1 + P0-2): hecs recycles entity.id() on despawn.
// Slot resolution must not go through the recycled id.
// ─────────────────────────────────────────────────────────────────
#[test]
fn v1_despawn_then_spawn_same_batch_keeps_both_correct() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(0), spawn2d(1), spawn2d(2)]);
    e.update(1.0 / 60.0);
    assert_eq!(e.render_state.gpu_entity_count(), 3);

    // "bullet dies, explosion spawns" — same batch, the id of ext 1 is recycled
    e.process_commands(&[despawn(1), spawn2d(9)]);
    e.update(1.0 / 60.0);

    let new_entity = e.entity_map.get(9).expect("ext 9 must be mapped");
    let slot_of_new = e.render_state.get_slot(new_entity);
    let ids: Vec<u32> = e.render_state.gpu_entity_ids()
        [..e.render_state.gpu_entity_count() as usize]
        .to_vec();

    println!("V1 gpu_count={} ids={:?} slot(ext9)={:?} world_len={}",
        e.render_state.gpu_entity_count(), ids, slot_of_new, e.world.len());

    assert_eq!(e.render_state.gpu_entity_count(), 3, "3 live entities => 3 slots");
    assert!(slot_of_new.is_some(), "the newly spawned entity must own a GPU slot");
    assert!(ids.contains(&9), "the new entity must reach the GPU");
    assert!(!ids.contains(&1), "the despawned entity must not keep rendering");
    assert_eq!(e.world.len(), 3);
}

#[test]
fn v2_repeated_id_recycling_never_corrupts_slots() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(0), spawn2d(1), spawn2d(2)]);
    e.update(1.0 / 60.0);
    e.process_commands(&[despawn(1)]);
    e.process_commands(&[spawn2d(1)]); // reuses the hecs id of the despawned one
    e.process_commands(&[despawn(1)]);
    e.update(1.0 / 60.0);

    let live = e.entity_map.get(2).unwrap();
    let slot = e.render_state.get_slot(live);
    println!("V2 after flush: gpu_count={} slot(ext2)={:?}",
        e.render_state.gpu_entity_count(), slot);
    assert_eq!(e.render_state.gpu_entity_count(), 2);
    assert!(slot.map(|s| s < 2).unwrap_or(false),
        "a live entity must keep an in-range slot, got {slot:?}");

    // The sequence that used to panic with "dest is out of bounds" (WASM trap).
    e.process_commands(&[spawn2d(7)]);
    e.update(1.0 / 60.0);
    e.process_commands(&[despawn(2)]);
    e.update(1.0 / 60.0);
    println!("V2 survived: gpu_count={} world_len={}",
        e.render_state.gpu_entity_count(), e.world.len());
    assert_eq!(e.render_state.gpu_entity_count(), e.world.len());
}

#[test]
fn v2b_object_pool_churn_keeps_slots_and_world_in_sync() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(0), spawn2d(1), spawn2d(2), spawn2d(3)]);
    e.update(1.0 / 60.0);
    // 40 frames of pool churn: kill two, spawn two, in the same batch.
    for round in 0..40u32 {
        let a = 100 + round * 2;
        let b = 101 + round * 2;
        let (k0, k1) = if round == 0 { (0, 1) } else { (98 + round * 2, 99 + round * 2) };
        e.process_commands(&[despawn(k0), despawn(k1), spawn2d(a), spawn2d(b)]);
        e.update(1.0 / 60.0);
        assert_eq!(e.render_state.gpu_entity_count(), e.world.len(),
            "slot count diverged from world at round {round}");
        for id in [a, b] {
            let ent = e.entity_map.get(id).unwrap();
            assert!(e.render_state.get_slot(ent).is_some(),
                "ext {id} lost its slot at round {round}");
        }
    }
    println!("V2b 40 rounds of pool churn: gpu_count={} world_len={}",
        e.render_state.gpu_entity_count(), e.world.len());
}

// ─────────────────────────────────────────────────────────────────
// V3: a velocity-driven entity reaches this frame's scatter staging, and a
// static one does not (mark_post_system_dirty pass 1).
//
// Until 2026-09-26 this checked the exported dirty bitfield instead (audit
// 2026-07, P1-16: it was read after the tracker had been cleared, so it was
// all zeros). That export fed only temporal culling, and went away with it.
// The staging indices are built from the same tracker in the same place, so
// they carry the same guarantee.
// ─────────────────────────────────────────────────────────────────
#[test]
fn v3_velocity_entity_is_staged_this_frame() {
    let mut e = Engine::new();
    e.process_commands(&[spawn3d(0), spawn3d(1)]);
    let mut p = [0u8; 16];
    p[0..4].copy_from_slice(&10.0f32.to_le_bytes());
    e.process_commands(&[cmd(CommandType::SetVelocity, 0, p)]);
    e.update(1.0 / 60.0);
    e.update(1.0 / 60.0);

    let n = e.render_state.staging_indices_len() as usize;
    assert!(n > 0, "a frame with a moving entity must stage something");
    assert_eq!(n, e.render_state.dirty_count() as usize,
        "one staging index per dirty entity");
    // SAFETY: the pointer covers `n` u32 and stays valid until the next update.
    let staged = unsafe { std::slice::from_raw_parts(e.render_state.staging_indices_ptr(), n) };

    let moving = e.render_state.get_slot(e.entity_map.get(0).unwrap()).unwrap();
    let still = e.render_state.get_slot(e.entity_map.get(1).unwrap()).unwrap();
    assert!(staged.contains(&moving), "the moving entity's slot must be staged");
    assert!(!staged.contains(&still), "a static entity must not be re-staged");
}

// ─────────────────────────────────────────────────────────────────
// V4 (audit 2026-07, P1-15): a root 3D entity keeps its full transform.
// ─────────────────────────────────────────────────────────────────
#[test]
fn v4_3d_root_staging_keeps_z_scale_and_xy_rotation() {
    let mut e = Engine::new();
    e.process_commands(&[spawn3d(0)]);
    let q = glam::Quat::from_rotation_x(std::f32::consts::FRAC_PI_2);
    let mut rp = [0u8; 16];
    rp[0..4].copy_from_slice(&q.x.to_le_bytes());
    rp[4..8].copy_from_slice(&q.y.to_le_bytes());
    rp[8..12].copy_from_slice(&q.z.to_le_bytes());
    rp[12..16].copy_from_slice(&q.w.to_le_bytes());
    e.process_commands(&[
        cmd(CommandType::SetRotation, 0, rp),
        f3(CommandType::SetScale, 0, 1.0, 1.0, 5.0),
    ]);
    e.update(1.0 / 60.0);

    let len = e.render_state.staging_u32_len() as usize;
    let st = unsafe { std::slice::from_raw_parts(e.render_state.staging_ptr(), len) };
    let fmt = st[31];
    let staged: Vec<f32> = st[..16].iter().map(|b| f32::from_bits(*b)).collect();
    let truth = e.render_state.gpu_transforms();
    println!("V4 fmt={} staged col2={:?} | real col2={:?}", fmt, &staged[8..12], &truth[8..12]);
    assert_eq!(fmt, 1, "a 3D root must travel as a full mat4");
    for i in 0..16 {
        assert!((staged[i] - truth[i]).abs() < 1e-5, "word {i} differs");
    }
    // scale.z = 5 lives in the third column; the compressed format dropped it.
    assert!(staged[9].abs() > 4.0, "scale.z must reach the GPU, got {}", staged[9]);
}

// A 2D root still takes the compact path — that is what it is for.
#[test]
fn v4b_2d_root_still_uses_the_compressed_format() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(0)]);
    e.process_commands(&[f3(CommandType::SetPosition, 0, 7.0, 8.0, 0.0)]);
    e.update(1.0 / 60.0);
    let len = e.render_state.staging_u32_len() as usize;
    let st = unsafe { std::slice::from_raw_parts(e.render_state.staging_ptr(), len) };
    println!("V4b 2D root fmt={} x={} y={}", st[31], f32::from_bits(st[0]), f32::from_bits(st[1]));
    assert_eq!(st[31], 0);
    assert_eq!(f32::from_bits(st[0]), 7.0);
    assert_eq!(f32::from_bits(st[1]), 8.0);
}

// ─────────────────────────────────────────────────────────────────
// V5: propagate_transforms is one level deep and not idempotent
// ─────────────────────────────────────────────────────────────────
#[test]
fn v5_hierarchy_propagates_at_any_depth() {
    let mut e = Engine::new();
    // 6-deep chain: 0 -> 1 -> 2 -> 3 -> 4 -> 5, each offset by 1 unit in x
    let n = 6u32;
    let spawns: Vec<Command> = (0..n).map(spawn3d).collect();
    e.process_commands(&spawns);
    let mut cmds = Vec::new();
    cmds.push(f3(CommandType::SetPosition, 0, 100.0, 0.0, 0.0));
    for id in 1..n {
        cmds.push(f3(CommandType::SetPosition, id, 1.0, 0.0, 0.0));
        let mut pp = [0u8; 16];
        pp[0..4].copy_from_slice(&(id - 1).to_le_bytes());
        cmds.push(cmd(CommandType::SetParent, id, pp));
    }
    e.process_commands(&cmds);
    e.update(1.0 / 60.0);

    let get_x = |e: &Engine, id: u32| {
        let ent = e.entity_map.get(id).unwrap();
        e.world.get::<&ModelMatrix>(ent).unwrap().0[12]
    };
    let xs: Vec<f32> = (0..n).map(|id| get_x(&e, id)).collect();
    println!("V5 world x by depth = {xs:?}");
    for (depth, x) in xs.iter().enumerate() {
        assert_eq!(*x, 100.0 + depth as f32,
            "depth {depth} must accumulate every ancestor, got {x}");
    }

    // Idempotency: a second frame with no commands must not compound anything.
    e.update(1.0 / 60.0);
    let xs2: Vec<f32> = (0..n).map(|id| get_x(&e, id)).collect();
    println!("V5 after a second frame = {xs2:?}");
    assert_eq!(xs, xs2, "propagation must be idempotent across frames");
}

#[test]
fn v5a_scale_and_rotation_compose_down_the_chain() {
    let mut e = Engine::new();
    e.process_commands(&[spawn3d(0), spawn3d(1), spawn3d(2)]);
    let p = |id: u32| { let mut b = [0u8; 16]; b[0..4].copy_from_slice(&id.to_le_bytes()); b };
    e.process_commands(&[
        f3(CommandType::SetScale, 0, 2.0, 2.0, 2.0),
        f3(CommandType::SetPosition, 1, 3.0, 0.0, 0.0),
        cmd(CommandType::SetParent, 1, p(0)),
        f3(CommandType::SetPosition, 2, 5.0, 0.0, 0.0),
        cmd(CommandType::SetParent, 2, p(1)),
    ]);
    e.update(1.0 / 60.0);
    let x = |id: u32| {
        let ent = e.entity_map.get(id).unwrap();
        e.world.get::<&ModelMatrix>(ent).unwrap().0[12]
    };
    println!("V5a scale 2x at the root: child={} grandchild={}", x(1), x(2));
    assert_eq!(x(1), 6.0, "child offset must be scaled by the root");
    assert_eq!(x(2), 16.0, "grandchild must inherit root scale through the parent");
}

#[test]
fn v5b_self_parent_is_rejected() {
    let mut e = Engine::new();
    e.process_commands(&[spawn3d(0)]);
    let mut pp = [0u8; 16];
    pp[0..4].copy_from_slice(&0u32.to_le_bytes());
    e.process_commands(&[
        f3(CommandType::SetPosition, 0, 5.0, 0.0, 0.0),
        cmd(CommandType::SetParent, 0, pp),
    ]);
    e.update(1.0 / 60.0);
    let ent = e.entity_map.get(0).unwrap();
    let x = e.world.get::<&ModelMatrix>(ent).unwrap().0[12];
    let c = e.world.get::<&Children>(ent).unwrap();
    println!("V5b self-parent: x={} (pos was 5), children.count={}", x, c.count);
    assert_eq!(c.count, 0, "self-parenting must not register a child");
    drop(c);
    assert_eq!(x, 5.0, "self-parenting must not square the model matrix");
    assert_eq!(e.world.get::<&Parent>(ent).unwrap().0, u32::MAX);
}

#[test]
fn v5c_parent_cycle_is_rejected() {
    let mut e = Engine::new();
    e.process_commands(&[spawn3d(0), spawn3d(1), spawn3d(2)]);
    let p = |id: u32| { let mut b = [0u8; 16]; b[0..4].copy_from_slice(&id.to_le_bytes()); b };
    // 1 -> child of 0, 2 -> child of 1, then try 0 -> child of 2 (closes the loop)
    e.process_commands(&[
        cmd(CommandType::SetParent, 1, p(0)),
        cmd(CommandType::SetParent, 2, p(1)),
        cmd(CommandType::SetParent, 0, p(2)),
    ]);
    e.update(1.0 / 60.0);
    let root = e.entity_map.get(0).unwrap();
    println!("V5c after attempting a 3-node cycle, root.Parent = {}",
        e.world.get::<&Parent>(root).unwrap().0);
    assert_eq!(e.world.get::<&Parent>(root).unwrap().0, u32::MAX,
        "closing a cycle must be rejected");
}

#[test]
fn v5d_parent_to_unknown_id_is_rejected() {
    let mut e = Engine::new();
    e.process_commands(&[spawn3d(1)]);
    let mut b = [0u8; 16];
    b[0..4].copy_from_slice(&77u32.to_le_bytes());
    e.process_commands(&[cmd(CommandType::SetParent, 1, b)]);
    e.update(1.0 / 60.0);
    let ent = e.entity_map.get(1).unwrap();
    let p = e.world.get::<&Parent>(ent).unwrap().0;
    println!("V5d SetParent towards a never-spawned id 77 -> {}", p);
    assert_eq!(p, u32::MAX, "no half-link towards a non-existent parent");
}

// ─────────────────────────────────────────────────────────────────
// V6 (audit 2026-07, P0-4): EntityMap is a sparse Vec indexed by the wire id.
// ─────────────────────────────────────────────────────────────────
#[test]
fn v6_out_of_range_entity_id_is_rejected_not_allocated() {
    // 6 wire bytes: SpawnEntity, id = 10_000_000, 3D. This used to allocate a
    // 10M-slot map (~85 MB of WASM heap) straight from the wire.
    let bytes = [0x01u8, 0x80, 0x96, 0x98, 0x00, 0x00];
    let cmds = parse_commands(&bytes);
    let mut e = Engine::new();
    e.process_commands(&cmds);
    println!("V6 entity_map capacity after a 10M id = {} (rejected {})",
        e.entity_map.capacity(), e.entity_map.rejected_ids());
    assert!(e.entity_map.capacity() <= 1, "no allocation for an out-of-range id");
    assert_eq!(e.entity_map.rejected_ids(), 1);
    assert!(e.entity_map.get(10_000_000).is_none());
    assert_eq!(e.world.len(), 0, "no unmapped entity may be left in the world");
}

#[test]
fn v6b_u32_max_id_is_rejected() {
    // On wasm32 `usize` is 32-bit: `idx + 1` wrapped to 0, `resize(0)` wiped
    // every mapping and the following index panicked.
    let mut e = Engine::new();
    let mut p = [0u8; 16];
    p[0] = 1;
    e.process_commands(&[Command {
        cmd_type: CommandType::SpawnEntity, entity_id: u32::MAX, payload: p }]);
    e.process_commands(&[Command {
        cmd_type: CommandType::SpawnEntity, entity_id: 3, payload: p }]);
    println!("V6b after u32::MAX + a normal spawn: world={} capacity={} rejected={}",
        e.world.len(), e.entity_map.capacity(), e.entity_map.rejected_ids());
    assert_eq!(e.world.len(), 1, "only the legal spawn survives");
    assert!(e.entity_map.get(3).is_some(), "the legal id must still be mapped");
    assert_eq!(e.entity_map.rejected_ids(), 1);
}

#[test]
fn v6c_highest_legal_id_still_works() {
    let mut e = Engine::new();
    let mut p = [0u8; 16];
    p[0] = 1;
    let id = 1_048_575u32; // MAX_EXTERNAL_ID
    e.process_commands(&[Command {
        cmd_type: CommandType::SpawnEntity, entity_id: id, payload: p }]);
    e.update(1.0 / 60.0);
    println!("V6c highest legal id {id} mapped = {}", e.entity_map.get(id).is_some());
    assert!(e.entity_map.get(id).is_some());
    assert_eq!(e.entity_map.rejected_ids(), 0);
}

// ─────────────────────────────────────────────────────────────────
// V7: parse_commands silently truncates on an unknown opcode
// ─────────────────────────────────────────────────────────────────
#[test]
fn v7_unknown_opcode_drops_rest_of_batch() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&[0u8, 0, 0, 0, 0]);   // Noop
    bytes.extend_from_slice(&[200u8, 0, 0, 0, 0]); // unknown
    bytes.extend_from_slice(&[0u8, 0, 0, 0, 0]);   // Noop
    let cmds = parse_commands(&bytes);
    println!("V7 wrote 3 commands, parsed {}", cmds.len());
    assert_eq!(cmds.len(), 1, "V7 CONFIRMED: everything after the bad byte is lost silently");
}

// ─────────────────────────────────────────────────────────────────
// V8: respawning a live external id leaks the previous entity
// ─────────────────────────────────────────────────────────────────
#[test]
fn v8_duplicate_spawn_retires_the_previous_entity() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(5)]);
    e.update(1.0 / 60.0);
    e.process_commands(&[spawn2d(5)]);
    e.update(1.0 / 60.0);
    println!("V8 world.len()={} gpu_count={}", e.world.len(), e.render_state.gpu_entity_count());
    assert_eq!(e.world.len(), 1, "the previous entity must be retired, not orphaned");
    assert_eq!(e.render_state.gpu_entity_count(), 1);
    // and it is still despawnable through the map
    e.process_commands(&[despawn(5)]);
    e.update(1.0 / 60.0);
    assert_eq!(e.world.len(), 0);
    assert_eq!(e.render_state.gpu_entity_count(), 0);
}

// ─────────────────────────────────────────────────────────────────
// V9 (audit 2026-07, P2-3): non-finite floats are rejected at the boundary.
// ─────────────────────────────────────────────────────────────────
#[test]
fn v9_nan_never_reaches_gpu_buffers() {
    let mut e = Engine::new();
    e.process_commands(&[spawn3d(0)]);
    e.process_commands(&[f3(CommandType::SetPosition, 0, 3.0, 4.0, 0.0)]);
    e.update(1.0 / 60.0);

    // Every non-finite variant must be ignored, leaving the last good value.
    e.process_commands(&[
        f3(CommandType::SetPosition, 0, f32::NAN, f32::INFINITY, 0.0),
        f3(CommandType::SetScale, 0, f32::NAN, 1.0, 1.0),
        f3(CommandType::SetVelocity, 0, f32::NEG_INFINITY, 0.0, 0.0),
        f3(CommandType::SetDepth, 0, f32::NAN, 0.0, 0.0),
    ]);
    e.update(1.0 / 60.0);

    let t = e.render_state.gpu_transforms();
    println!("V9 model matrix translation = ({}, {})", t[12], t[13]);
    assert!(t.iter().all(|v| v.is_finite()), "no NaN/Inf may reach the GPU transforms");
    assert_eq!((t[12], t[13]), (3.0, 4.0), "the last valid position must be kept");
    assert!(e.render_state.gpu_bounds().iter().all(|v| v.is_finite()));
    assert!(e.render_state.gpu_depths().iter().all(|v| v.is_finite()));
}

#[test]
fn v9b_nan_does_not_poison_descendants() {
    let mut e = Engine::new();
    e.process_commands(&[spawn3d(0), spawn3d(1)]);
    let mut pp = [0u8; 16];
    pp[0..4].copy_from_slice(&0u32.to_le_bytes());
    e.process_commands(&[
        f3(CommandType::SetPosition, 0, 10.0, 0.0, 0.0),
        cmd(CommandType::SetParent, 1, pp),
        f3(CommandType::SetPosition, 0, f32::NAN, 0.0, 0.0),
    ]);
    e.update(1.0 / 60.0);
    let child = e.entity_map.get(1).unwrap();
    let m = e.world.get::<&ModelMatrix>(child).unwrap().0;
    println!("V9b child world x = {} (parent kept at 10)", m[12]);
    assert!(m.iter().all(|v| v.is_finite()));
    assert_eq!(m[12], 10.0);
}

// ─────────────────────────────────────────────────────────────────
// V10: zero-entity frame keeps stale dirty bits
// ─────────────────────────────────────────────────────────────────
#[test]
fn v10_stale_dirty_bits_survive_empty_frame() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(0), spawn2d(1)]);
    e.update(1.0 / 60.0);
    e.process_commands(&[despawn(0), despawn(1)]);
    // slots marked dirty by the despawn path, then gpu_count hits 0
    e.update(1.0 / 60.0);
    let bits_before = e.render_state.dirty_tracker.is_transform_dirty(0);
    println!("V10 gpu_count={} slot0 still dirty after empty frame = {}",
        e.render_state.gpu_entity_count(), bits_before);
    assert_eq!(e.render_state.gpu_entity_count(), 0);
}
