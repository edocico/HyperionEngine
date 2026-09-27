//! The Transform2D archetype, reachable from the public API since
//! `engine.spawn({ mode: '2d' })` (2026-09-27): a 2D entity must reach the GPU
//! exactly where its 3D twin does, and a Light2D must work on it.

use hyperion_core::engine::Engine;
use hyperion_core::ring_buffer::{Command, CommandType};

fn cmd(t: CommandType, id: u32, payload: [u8; 16]) -> Command {
    Command { cmd_type: t, entity_id: id, payload }
}
fn spawn(id: u32, is_2d: bool) -> Command {
    let mut p = [0u8; 16];
    p[0] = is_2d as u8;
    cmd(CommandType::SpawnEntity, id, p)
}
fn floats(t: CommandType, id: u32, v: &[f32]) -> Command {
    let mut p = [0u8; 16];
    for (i, x) in v.iter().enumerate() {
        p[i * 4..i * 4 + 4].copy_from_slice(&x.to_le_bytes());
    }
    cmd(t, id, p)
}
fn primitive(id: u32, prim: u8) -> Command {
    let mut p = [0u8; 16];
    p[0] = prim;
    cmd(CommandType::SetRenderPrimitive, id, p)
}

/// The GPU row of `id`: transform (16 f32) and bounds (4 f32).
fn gpu_row(e: &Engine, id: u32) -> ([f32; 16], [f32; 4]) {
    let slot = e.render_state.get_slot(e.entity_map.get(id).unwrap()).unwrap() as usize;
    let t = e.render_state.gpu_transforms();
    let b = e.render_state.gpu_bounds();
    (
        t[slot * 16..slot * 16 + 16].try_into().unwrap(),
        b[slot * 4..slot * 4 + 4].try_into().unwrap(),
    )
}

/// The staged row of `id` this frame (32 u32), if it was staged.
fn staged(e: &Engine, id: u32) -> Option<Vec<u32>> {
    let slot = e.render_state.get_slot(e.entity_map.get(id).unwrap()).unwrap();
    let n = e.render_state.staging_indices_len() as usize;
    if n == 0 {
        return None;
    }
    let idx = unsafe { std::slice::from_raw_parts(e.render_state.staging_indices_ptr(), n) };
    let st = unsafe { std::slice::from_raw_parts(e.render_state.staging_ptr(), n * 32) };
    idx.iter().position(|&s| s == slot).map(|i| st[i * 32..i * 32 + 32].to_vec())
}

fn assert_close(a: &[f32], b: &[f32], what: &str) {
    for (i, (x, y)) in a.iter().zip(b).enumerate() {
        assert!((x - y).abs() < 1e-5, "{what}: word {i} differs, 2D {x} vs 3D {y}");
    }
}

#[test]
fn d1_a_2d_entity_and_its_3d_twin_share_their_gpu_row() {
    let mut e = Engine::new();
    e.process_commands(&[spawn(0, true), spawn(1, false)]);
    let mut cmds = Vec::new();
    for id in [0, 1] {
        cmds.push(floats(CommandType::SetPosition, id, &[3.5, -2.0, 0.0]));
        cmds.push(floats(CommandType::SetRotation2D, id, &[0.7]));
        cmds.push(floats(CommandType::SetScale, id, &[2.0, 0.5, 1.0]));
    }
    e.process_commands(&cmds);
    e.update(1.0 / 60.0);

    let (t2, b2) = gpu_row(&e, 0);
    let (t3, b3) = gpu_row(&e, 1);
    assert_close(&t2, &t3, "transform");
    assert_close(&b2, &b3, "bounds");
}

#[test]
fn d2_moving_twins_stay_on_the_same_row() {
    let mut e = Engine::new();
    e.process_commands(&[spawn(0, true), spawn(1, false)]);
    let mut cmds = Vec::new();
    for id in [0, 1] {
        cmds.push(floats(CommandType::SetPosition, id, &[-1.0, 1.0, 0.0]));
        cmds.push(floats(CommandType::SetVelocity, id, &[60.0, -30.0, 0.0]));
    }
    e.process_commands(&cmds);
    for _ in 0..5 {
        e.update(1.0 / 60.0);
    }
    let (t2, b2) = gpu_row(&e, 0);
    let (t3, b3) = gpu_row(&e, 1);
    assert!((t2[12] - 4.0).abs() < 1e-4, "the 2D entity moved 5 ticks: x = {}", t2[12]);
    assert_close(&t2, &t3, "transform");
    assert_close(&b2, &b3, "bounds");
}

#[test]
fn d3_a_light_on_transform2d_culls_against_its_range_in_format_0() {
    let mut e = Engine::new();
    e.process_commands(&[spawn(0, true)]);
    e.process_commands(&[
        floats(CommandType::SetPosition, 0, &[5.0, 6.0, 0.0]),
        // A 40x quad: its matrix-derived radius would be ~28; the range wins.
        floats(CommandType::SetScale, 0, &[40.0, 40.0, 1.0]),
        primitive(0, 6),
        floats(CommandType::SetPrimParams0, 0, &[1.0, 0.8, 0.6, 12.0]),
    ]);
    e.update(1.0 / 60.0);

    let (_, bounds) = gpu_row(&e, 0);
    assert_eq!(&bounds[..3], &[5.0, 6.0, 0.0]);
    assert_eq!(bounds[3], 12.0, "a Light2D's radius is its range, on Transform2D too");

    let row = staged(&e, 0).expect("the light is staged in the frame that set it up");
    assert_eq!(row[31], 0, "a 2D root travels compressed (format 0)");
    assert_eq!(f32::from_bits(row[19]), 12.0, "the staged radius is the range");
    assert_eq!(row[21] & 0xFF, 6, "renderMeta carries the Light2D type");
}

// ─────────────────────────────────────────────────────────────────
// Depth → z (2026-09-27): `Depth` is the z a 2D entity lacks. It is a
// distance into the screen: the GPU row carries z = -depth, so a larger depth
// draws behind (the depth test is `less`, the camera looks down -Z).
// ─────────────────────────────────────────────────────────────────

fn depth(id: u32, d: f32) -> Command {
    floats(CommandType::SetDepth, id, &[d])
}
fn parent(child: u32, parent: u32) -> Command {
    let mut p = [0u8; 16];
    p[0..4].copy_from_slice(&parent.to_le_bytes());
    cmd(CommandType::SetParent, child, p)
}

#[test]
fn d4_depth_is_the_z_of_a_2d_root_in_its_row_its_bounds_and_format_0() {
    let mut e = Engine::new();
    e.process_commands(&[spawn(0, true)]);
    e.update(1.0 / 60.0);
    e.process_commands(&[depth(0, 3.0)]);
    e.update(1.0 / 60.0);

    let (t, b) = gpu_row(&e, 0);
    assert_eq!(t[14], -3.0, "the row's z is -depth");
    assert_eq!(b[2], -3.0, "the culling sphere sits at that z too");
    let row = staged(&e, 0).expect("SetDepth re-stages the row");
    assert_eq!(row[31], 0, "still a format-0 root");
    assert_eq!(f32::from_bits(row[2]), -3.0, "format 0 carries the z in word 2");
}

#[test]
fn d5_a_2d_childs_depth_is_relative_and_follows_its_parent() {
    let mut e = Engine::new();
    e.process_commands(&[spawn(0, true), spawn(1, true)]);
    e.process_commands(&[parent(1, 0), depth(0, 5.0), depth(1, -1.0)]);
    e.update(1.0 / 60.0);
    assert_eq!(gpu_row(&e, 1).0[14], -4.0, "child world depth = 5 + (-1)");

    // Only the parent changes: the child must be re-staged with its new z.
    e.process_commands(&[depth(0, 2.0)]);
    e.update(1.0 / 60.0);
    assert_eq!(gpu_row(&e, 1).0[14], -1.0, "child world depth = 2 + (-1)");
    let row = staged(&e, 1).expect("the child is re-staged when its parent's depth changes");
    assert_eq!(row[31], 1, "a 2D child travels as a full matrix");
    assert_eq!(f32::from_bits(row[14]), -1.0);
}

#[test]
fn d6_depth_on_a_3d_entity_is_ignored() {
    let mut e = Engine::new();
    e.process_commands(&[spawn(0, false)]);
    e.process_commands(&[floats(CommandType::SetPosition, 0, &[1.0, 2.0, -0.5]), depth(0, 7.0)]);
    e.update(1.0 / 60.0);
    let (t, b) = gpu_row(&e, 0);
    assert_eq!(t[14], -0.5, "a 3D entity takes its z from its position only");
    assert_eq!(b[2], -0.5);
    let ent = e.entity_map.get(0).unwrap();
    assert!(e.world.get::<&hyperion_core::components::Depth>(ent).is_err(), "no Depth component on a 3D entity");
}

#[test]
fn d7_a_2d_twin_at_depth_d_shares_its_row_with_a_3d_twin_at_z_minus_d() {
    let mut e = Engine::new();
    e.process_commands(&[spawn(0, true), spawn(1, false)]);
    e.process_commands(&[
        floats(CommandType::SetPosition, 0, &[4.0, 1.0, 0.0]),
        depth(0, 2.5),
        floats(CommandType::SetRotation2D, 0, &[0.3]),
        floats(CommandType::SetPosition, 1, &[4.0, 1.0, -2.5]),
        floats(CommandType::SetRotation2D, 1, &[0.3]),
    ]);
    e.update(1.0 / 60.0);
    let (t2, b2) = gpu_row(&e, 0);
    let (t3, b3) = gpu_row(&e, 1);
    assert_close(&t2, &t3, "transform");
    assert_close(&b2, &b3, "bounds");
}
