//! Verification of snapshot_restore hardening findings. NOT part of the project.
#![cfg(feature = "dev-tools")]

use hyperion_core::engine::Engine;

fn hdr(entity_count: u32, map_len: u32) -> Vec<u8> {
    let mut d = Vec::new();
    d.extend_from_slice(b"HSNP");
    d.extend_from_slice(&2u32.to_le_bytes()); // version
    d.extend_from_slice(&0u64.to_le_bytes()); // tick
    d.extend_from_slice(&entity_count.to_le_bytes());
    d.extend_from_slice(&map_len.to_le_bytes());
    d
}

// S1 — Children.count is an unvalidated u8 written into a [u32; 32]
#[test]
fn s1_children_count_overflow_is_rejected() {
    let mut d = hdr(1, 0);
    d.extend_from_slice(&7u64.to_le_bytes()); // hecs id
    d.extend_from_slice(&(1u32 << 14).to_le_bytes()); // mask = Children only
    d.push(200); // count = 200, but slots is [u32; 32]
    d.extend_from_slice(&[0u8; 200 * 4]);

    let mut e = Engine::new();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| e.snapshot_restore(&d)));
    println!("S1 restore panicked = {:?}, returned = {:?}", r.is_err(), r.as_ref().ok());
    assert!(r.is_ok(), "a corrupt Children.count must not trap the module");
    assert!(!r.unwrap(), "it must be reported as invalid data");
}

// S2 — LocalMatrix must survive every byte alignment
#[test]
fn s2_local_matrix_survives_every_alignment() {
    let mut results = Vec::new();
    for pad in 0..4usize {
        // pad the entity-map section so the component payload lands at every
        // possible alignment residue
        let mut d = hdr(1, pad as u32);
        for i in 0..pad {
            d.extend_from_slice(&(i as u32).to_le_bytes());
            d.extend_from_slice(&0u64.to_le_bytes());
            d.push(0);
        }
        d.extend_from_slice(&7u64.to_le_bytes());
        d.extend_from_slice(&(1u32 << 13).to_le_bytes()); // LocalMatrix
        d.extend_from_slice(&[0u8; 64]);
        let mut e = Engine::new();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| e.snapshot_restore(&d)));
        results.push(r.is_err());
    }
    println!("S2 panic per entity-map padding 0..3 = {:?}", results);
    assert!(results.iter().all(|&p| !p),
        "restore must never trap on a misaligned LocalMatrix payload");
}

// S3 — a valid round-trip must preserve accumulator + listener + legacy matrices
#[test]
fn s3_snapshot_round_trip_preserves_frame_state() {
    use hyperion_core::ring_buffer::{Command, CommandType};
    let mut e = Engine::new();
    let mut p = [0u8; 16];
    p[0] = 1;
    e.process_commands(&[Command { cmd_type: CommandType::SpawnEntity, entity_id: 0, payload: p }]);
    let mut lp = [0u8; 16];
    lp[0..4].copy_from_slice(&10.0f32.to_le_bytes());
    e.process_commands(&[Command {
        cmd_type: CommandType::SetListenerPosition, entity_id: 0, payload: lp }]);
    e.update((1.0 / 60.0) * 1.5);
    let (alpha, lx, legacy) = (e.interpolation_alpha(), e.listener_x(), e.render_state.count());
    let snap = e.snapshot_create();

    let mut e2 = Engine::new();
    assert!(e2.snapshot_restore(&snap));
    println!("S3 alpha {} -> {} | listener_x {} -> {} | legacy matrices {} -> {} | gpu {} ",
        alpha, e2.interpolation_alpha(), lx, e2.listener_x(),
        legacy, e2.render_state.count(), e2.render_state.gpu_entity_count());
    assert_eq!(alpha, e2.interpolation_alpha(),
        "the accumulator must survive the round trip (no tick-phase drift)");
    assert_eq!(e2.listener_x(), lx, "listener state must survive the round trip");
    assert_eq!(e2.render_state.count(), legacy,
        "the legacy flat matrix buffer must be rebuilt on restore");
}

// S4 — state_hash must see hierarchy and activation changes
// (audit 2026-07, P2-7).
#[test]
fn s4_state_hash_sees_hierarchy_and_active() {
    use hyperion_core::ring_buffer::{Command, CommandType};
    let mk = |reparent: bool| {
        let mut e = Engine::new();
        let mut p = [0u8; 16];
        p[0] = 1;
        e.process_commands(&[
            Command { cmd_type: CommandType::SpawnEntity, entity_id: 0, payload: p },
            Command { cmd_type: CommandType::SpawnEntity, entity_id: 1, payload: p },
        ]);
        if reparent {
            let mut pp = [0u8; 16];
            pp[0..4].copy_from_slice(&0u32.to_le_bytes());
            e.process_commands(&[Command {
                cmd_type: CommandType::SetParent, entity_id: 1, payload: pp }]);
        }
        e.update(1.0 / 60.0);
        e.state_hash()
    };
    let (a, b) = (mk(false), mk(true));
    println!("S4 hash flat={a:016x} reparented={b:016x}");
    assert_ne!(a, b, "a real re-parent must change the determinism hash");

    // …and the hash is still reproducible for identical inputs.
    assert_eq!(mk(true), b, "same input must yield the same hash");
    assert_eq!(mk(false), a);
}

/// The hash must not depend on the ORDER children happen to sit in — the inline
/// array uses swap-remove, so removal history would otherwise leak in.
#[test]
fn s4b_state_hash_is_child_order_independent() {
    use hyperion_core::components::Children;
    use hyperion_core::ring_buffer::{Command, CommandType};
    let build = |order: [u32; 3]| {
        let mut e = Engine::new();
        let mut p = [0u8; 16];
        p[0] = 1;
        let spawns: Vec<Command> = (0..4u32)
            .map(|id| Command { cmd_type: CommandType::SpawnEntity, entity_id: id, payload: p })
            .collect();
        e.process_commands(&spawns);
        let links: Vec<Command> = order
            .iter()
            .map(|&id| {
                let mut pp = [0u8; 16];
                pp[0..4].copy_from_slice(&0u32.to_le_bytes());
                Command { cmd_type: CommandType::SetParent, entity_id: id, payload: pp }
            })
            .collect();
        e.process_commands(&links);
        e.update(1.0 / 60.0);
        let par = e.entity_map.get(0).unwrap();
        let stored = e.world.get::<&Children>(par).unwrap().as_slice().to_vec();
        (e.state_hash(), stored)
    };
    let (h1, s1) = build([1, 2, 3]);
    let (h2, s2) = build([3, 2, 1]);
    println!("S4b stored orders {s1:?} vs {s2:?} -> hashes {h1:016x} / {h2:016x}");
    assert_ne!(s1, s2, "the stored order really does differ");
    assert_eq!(h1, h2, "but the hash must not depend on it");
}
