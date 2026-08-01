//! Verification of ring buffer + dirty tracker edge cases. NOT part of the project.

use hyperion_core::components::*;
use hyperion_core::engine::Engine;
use hyperion_core::render_state::RenderState;
use hyperion_core::ring_buffer::{Command, CommandType, RingBufferConsumer};

const HDR: usize = 32;

fn mkbuf(capacity: usize, write_head: u32, data: &[u8]) -> (Vec<u8>, usize) {
    let mut buf = vec![0u8; HDR + capacity];
    buf[0..4].copy_from_slice(&write_head.to_le_bytes());
    buf[8..12].copy_from_slice(&(capacity as u32).to_le_bytes());
    buf[HDR..HDR + data.len()].copy_from_slice(data);
    (buf, capacity)
}

// R1 — an unknown opcode must resynchronise, not park the consumer forever
// (audit 2026-07, P2-2).
#[test]
fn r1_drain_resyncs_after_an_unknown_opcode() {
    let data = [200u8, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // unknown opcode then a Noop
    let (mut buf, cap) = mkbuf(64, 10, &data);
    let mut c = unsafe { RingBufferConsumer::new(buf.as_mut_ptr(), cap) };
    let a = c.drain().len();
    println!("R1 first drain: {a} commands, dropped {} bytes, available now {}",
        c.dropped_bytes(), c.available());
    assert_eq!(c.available(), 0, "the consumer must resynchronise to write_head");
    assert_eq!(c.dropped_bytes(), 10, "and report exactly what it discarded");

    // The stream keeps working afterwards.
    let good = [0u8, 0, 0, 0, 0]; // Noop
    buf[32 + 10..32 + 15].copy_from_slice(&good);
    buf[0..4].copy_from_slice(&15u32.to_le_bytes()); // advance write_head
    assert_eq!(c.drain().len(), 1, "later commands must still be delivered");
}

// R2 — a zero capacity must be rejected, not divide by zero (WASM trap).
#[test]
fn r2_zero_capacity_is_rejected() {
    let (mut buf, _) = mkbuf(0, 5, &[]);
    let mut c = unsafe { RingBufferConsumer::new(buf.as_mut_ptr(), 0) };
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.drain()));
    println!("R2 drain with capacity 0 panicked = {}", r.is_err());
    assert!(r.is_ok(), "capacity 0 must not trap the worker");
    assert!(r.unwrap().is_empty());
}

// A write_head past the end of the ring used to make drain() spin forever,
// filling an unbounded Vec (audit 2026-07, P2-2).
#[test]
fn r2b_out_of_range_write_head_is_rejected() {
    let (mut buf, cap) = mkbuf(64, 74, &[0u8; 64]);
    let mut c = unsafe { RingBufferConsumer::new(buf.as_mut_ptr(), cap) };
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cmds = c.drain();
    done.store(true, std::sync::atomic::Ordering::SeqCst);
    println!("R2b drain with write_head 74 > capacity 64 -> {} commands", cmds.len());
    assert!(cmds.is_empty(), "an inconsistent header must yield nothing, not hang");
}

// R3 — available() cannot distinguish full from empty
#[test]
fn r3_full_reads_as_empty() {
    let (mut buf, cap) = mkbuf(16, 16, &[0u8; 16]);
    // write_head == capacity, read_head == 0 -> 16 bytes pending
    let c = unsafe { RingBufferConsumer::new(buf.as_mut_ptr(), cap) };
    println!("R3 available with wh=16 cap=16 -> {}", c.available());
    // and the wrapped form wh=0 (producer wrote exactly `capacity` bytes) reads as empty
    let (mut buf2, cap2) = mkbuf(16, 0, &[0u8; 16]);
    let c2 = unsafe { RingBufferConsumer::new(buf2.as_mut_ptr(), cap2) };
    println!("R3 available with wh=0 (buffer exactly full) -> {}", c2.available());
    assert_eq!(c2.available(), 0,
        "R3 CONFIRMED: a exactly-full buffer is indistinguishable from empty; usable size is cap-1");
}

// R4 — a frame ending with zero entities must clear the tracker
// (audit 2026-07, P2-9).
#[test]
fn r4_empty_frame_clears_dirty_bits() {
    let mut rs = RenderState::new();
    rs.dirty_tracker.ensure_capacity(8);
    rs.dirty_tracker.mark_transform_dirty(0);
    rs.dirty_tracker.mark_transform_dirty(5);
    let w = hecs::World::new();
    let _ = rs.collect_dirty_staging(&w); // gpu_count == 0 -> early return
    println!("R4 after an empty-frame collect: slot0 dirty={} slot5 dirty={}",
        rs.dirty_tracker.is_transform_dirty(0), rs.dirty_tracker.is_transform_dirty(5));
    assert!(!rs.dirty_tracker.is_transform_dirty(0),
        "stale bits must not be inherited by the next frame's slots");
    assert!(!rs.dirty_tracker.is_transform_dirty(5));
}

// R5 — staging pointer is reallocated every frame
#[test]
fn r5_staging_pointer_moves_every_frame() {
    let mut e = Engine::new();
    let mut p = [0u8; 16];
    p[0] = 1;
    e.process_commands(&[Command { cmd_type: CommandType::SpawnEntity, entity_id: 0, payload: p }]);
    e.update(1.0 / 60.0);
    let p1 = e.render_state.staging_ptr();
    let mut v = [0u8; 16];
    v[0..4].copy_from_slice(&5.0f32.to_le_bytes());
    e.process_commands(&[Command { cmd_type: CommandType::SetPosition, entity_id: 0, payload: v }]);
    e.update(1.0 / 60.0);
    let p2 = e.render_state.staging_ptr();
    println!("R5 staging_ptr frame1={:p} frame2={:p} same={}", p1, p2, p1 == p2);
}

// R6 — the cull/pick radius is derived from the world matrix
// (audit 2026-07, P1-17).
#[test]
fn r6_bounding_radius_follows_scale() {
    let mut e = Engine::new();
    e.process_commands(&[Command {
        cmd_type: CommandType::SpawnEntity, entity_id: 0, payload: [0u8; 16] }]);
    let mut s = [0u8; 16];
    s[0..4].copy_from_slice(&2000.0f32.to_le_bytes());
    s[4..8].copy_from_slice(&1000.0f32.to_le_bytes());
    s[8..12].copy_from_slice(&1.0f32.to_le_bytes());
    e.process_commands(&[Command {
        cmd_type: CommandType::SetScale, entity_id: 0, payload: s }]);
    e.update(1.0 / 60.0);
    let ent = e.entity_map.get(0).unwrap();
    let r = e.world.get::<&BoundingRadius>(ent).unwrap().0;
    // Half-extents (1000, 500, 0.5): circumradius = sqrt(1000^2 + 500^2 + 0.5^2)
    let expected = (1000.0f32 * 1000.0 + 500.0 * 500.0 + 0.25).sqrt();
    println!("R6 entity scaled to 2000x1000 -> BoundingRadius {r} (expected {expected})");
    assert!((r - expected).abs() < 0.01, "radius {r} should be {expected}");
    let slot = e.render_state.get_slot(ent).unwrap() as usize;
    assert!((e.render_state.gpu_bounds()[slot * 4 + 3] - expected).abs() < 0.01,
        "the derived radius must reach the GPU bounds buffer");
}

/// An explicit `SetBoundingRadius` pins the value; a negative one restores the
/// automatic derivation.
#[test]
fn r6b_explicit_bounding_radius_wins() {
    let mut e = Engine::new();
    e.process_commands(&[Command {
        cmd_type: CommandType::SpawnEntity, entity_id: 0, payload: [0u8; 16] }]);
    let mut s = [0u8; 16];
    s[0..4].copy_from_slice(&100.0f32.to_le_bytes());
    s[4..8].copy_from_slice(&100.0f32.to_le_bytes());
    s[8..12].copy_from_slice(&1.0f32.to_le_bytes());
    let mut r = [0u8; 16];
    r[0..4].copy_from_slice(&7.5f32.to_le_bytes());
    e.process_commands(&[
        Command { cmd_type: CommandType::SetScale, entity_id: 0, payload: s },
        Command { cmd_type: CommandType::SetBoundingRadius, entity_id: 0, payload: r },
    ]);
    e.update(1.0 / 60.0);
    let ent = e.entity_map.get(0).unwrap();
    assert_eq!(e.world.get::<&BoundingRadius>(ent).unwrap().0, 7.5);

    let mut back = [0u8; 16];
    back[0..4].copy_from_slice(&(-1.0f32).to_le_bytes());
    e.process_commands(&[Command {
        cmd_type: CommandType::SetBoundingRadius, entity_id: 0, payload: back }]);
    e.update(1.0 / 60.0);
    let auto = e.world.get::<&BoundingRadius>(ent).unwrap().0;
    println!("R6b pinned 7.5 -> released back to automatic {auto}");
    assert!(auto > 50.0, "a negative value must restore automatic derivation, got {auto}");
}
