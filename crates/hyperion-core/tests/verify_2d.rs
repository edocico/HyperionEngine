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
