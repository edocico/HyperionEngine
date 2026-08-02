//! Physics determinism + narrowphase regression tests.
//!
//! Added 2026-08-02 while auditing the rapier 0.32 -> 0.34 upgrade
//! (branch `chore/deps-2026-08`). The upgrade commit claimed determinism was
//! "misurato, non stimato", but the scenarios it used — free fall and a box
//! stack — only exercise the *core solver*, which rapier did not change. The
//! three parry deltas that DID land are all in the narrowphase:
//!
//!   1. shape cast / CCD: small-TOI threshold 1e-5 -> 1e-4, plus a
//!      contact-query fallback for the normal.
//!   2. EPA 2D: degenerate-face tolerance is now scaled by vertex magnitude
//!      instead of being absolute.
//!   3. raycast with a zero direction inside an AABB: no longer panics.
//!
//! A free-fall test cannot fail on any of those, so it was not evidence. These
//! tests target each delta with a scenario that provably reaches the code path.
//!
//! Deliberately asserting *behavioural invariants* rather than golden state
//! hashes: `state_hash` mixes f32 bit patterns, and bit-exactness across
//! architectures (aarch64 dev machine vs x86_64 CI) is not something rapier
//! guarantees. `d1` covers exact reproducibility within one target, which is
//! the property the engine actually promises.
#![cfg(all(feature = "physics-2d", feature = "dev-tools"))]

use hyperion_core::components::Transform2D;
use hyperion_core::engine::Engine;
use hyperion_core::ring_buffer::{Command, CommandType};

const DT: f32 = 1.0 / 60.0;

fn cmd(t: CommandType, id: u32, payload: [u8; 16]) -> Command {
    Command { cmd_type: t, entity_id: id, payload }
}
fn spawn2d(id: u32) -> Command {
    let mut p = [0u8; 16];
    p[0] = 1;
    cmd(CommandType::SpawnEntity, id, p)
}
/// kind: 0 = dynamic, 1 = fixed, 2 = kinematic
fn body(id: u32, kind: u8) -> Command {
    let mut p = [0u8; 16];
    p[0] = kind;
    cmd(CommandType::CreateRigidBody, id, p)
}
/// shape: 0 = ball(radius), 1 = cuboid(width, height)
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
fn setpos(id: u32, x: f32, y: f32) -> Command {
    f2(CommandType::SetPosition, id, x, y)
}
fn ccd(id: u32, on: bool) -> Command {
    let mut p = [0u8; 16];
    p[0] = u8::from(on);
    cmd(CommandType::SetCCDEnabled, id, p)
}
fn pos_of(e: &Engine, id: u32) -> (f32, f32) {
    let ent = e.entity_map.get(id).unwrap();
    let t = e.world.get::<&Transform2D>(ent).unwrap();
    (t.x, t.y)
}

/// A stack of boxes resting on a fixed platform, built at an arbitrary X
/// origin. Used by d1 and d3.
///
/// Geometry: `collider(_, 1, w, h)` builds `cuboid(w/2, h/2)`, so the boxes are
/// 50x50 and the platform is 600x20 with its top face at y = 590.
///
/// The 48px spacing is deliberate: it leaves the boxes 2px interpenetrating at
/// t=0, so EPA (not GJK) runs from the very first frame and keeps running on the
/// resting contacts. An earlier revision used 12px, which is a 38px overlap on a
/// 50px box — that does not test EPA harder, it just detonates the stack and
/// makes the outcome chaotic rather than invariant.
fn build_stack(e: &mut Engine, origin_x: f32) {
    let mut c = vec![
        spawn2d(1),
        setpos(1, origin_x, 600.0),
        body(1, 1),
        collider(1, 1, 600.0, 20.0),
    ];
    for i in 0..8u32 {
        let id = 10 + i;
        c.extend([
            spawn2d(id),
            setpos(id, origin_x, 565.0 - i as f32 * 48.0),
            body(id, 0),
            collider(id, 1, 50.0, 50.0),
        ]);
    }
    e.process_commands(&c);
}

/// D1 — the property the engine actually promises: same commands + same tick
/// count => same state, exactly. Runs two independent engines in one process,
/// so it is architecture-independent and safe on any CI.
#[test]
fn d1_identical_runs_produce_identical_state() {
    let mut a = Engine::new();
    let mut b = Engine::new();
    build_stack(&mut a, 0.0);
    build_stack(&mut b, 0.0);
    for _ in 0..400 {
        a.update(DT);
        b.update(DT);
    }
    let (ha, hb) = (a.state_hash(), b.state_hash());
    println!("D1 hash_a={ha:#x} hash_b={hb:#x}");
    assert_eq!(ha, hb, "two identical runs diverged — the simulation is not deterministic");

    // A hash collision would mask a divergence, so check the positions too.
    for i in 0..8u32 {
        assert_eq!(pos_of(&a, 10 + i), pos_of(&b, 10 + i), "body {i} diverged");
    }
}

/// D2 — parry delta #1 (CCD small-TOI threshold). A ball driven far faster than
/// its own diameter per tick, at a floor thinner than one step of travel.
///
/// The control half is the point: without CCD the ball MUST tunnel. If it ever
/// stops tunnelling, the scenario has decayed into a no-op and stops being
/// evidence about the CCD path — which is exactly how the original free-fall
/// "CCD test" managed to pass without moving a body.
#[test]
fn d2_ccd_prevents_tunneling_and_the_control_still_tunnels() {
    fn run(ccd_on: bool) -> f32 {
        let mut e = Engine::new();
        let mut impulse = [0u8; 16];
        impulse[0..4].copy_from_slice(&0.0f32.to_le_bytes());
        impulse[4..8].copy_from_slice(&60000.0f32.to_le_bytes());
        e.process_commands(&[
            // 3px-thin floor
            spawn2d(1),
            setpos(1, 0.0, 3000.0),
            body(1, 1),
            collider(1, 1, 4000.0, 3.0),
            spawn2d(2),
            setpos(2, 0.0, 0.0),
            body(2, 0),
            collider(2, 0, 6.0, 0.0),
            ccd(2, ccd_on),
            cmd(CommandType::ApplyImpulse, 2, impulse),
        ]);
        for _ in 0..300 {
            e.update(DT);
        }
        pos_of(&e, 2).1
    }

    let with_ccd = run(true);
    let without_ccd = run(false);
    println!("D2 y_with_ccd={with_ccd} y_without_ccd={without_ccd} (floor at y=3000)");

    assert!(
        without_ccd > 5000.0,
        "control failed: without CCD the ball should tunnel through the 3px floor, \
         but it stopped at y={without_ccd}. The scenario is no longer fast enough to \
         reach the CCD path, so the positive case below proves nothing — fix the setup."
    );
    assert!(
        with_ccd < 3000.0,
        "with CCD enabled the ball must be stopped by the floor, got y={with_ccd}"
    );
}

/// D3 — parry delta #2 (EPA degenerate-face tolerance is now relative to vertex
/// magnitude, not absolute). Deep contacts far from the origin are precisely the
/// case where a relative tolerance differs from an absolute one.
///
/// Asserts the physical invariant (bodies resolve and stay on the platform)
/// rather than exact coordinates: at x=10000 an f32 mantissa carries ~0.001
/// resolution, so cross-run coordinate equality is not a reasonable ask.
#[test]
fn d3_deep_contacts_resolve_at_large_coordinates() {
    for origin_x in [0.0f32, 10_000.0] {
        let mut e = Engine::new();
        build_stack(&mut e, origin_x);
        for _ in 0..400 {
            e.update(DT);
        }
        for i in 0..8u32 {
            let (x, y) = pos_of(&e, 10 + i);
            assert!(
                x.is_finite() && y.is_finite(),
                "body {i} at origin {origin_x} went non-finite: ({x}, {y}) — \
                 a NaN here reaches the GPU model matrix"
            );
            // Platform top face is at y = 590, box half-height is 25, so the
            // lowest possible resting centre is y = 565 and the stack grows
            // upward (decreasing y). Below the platform => sank through it.
            assert!(
                y < 620.0,
                "body {i} at origin {origin_x} sank through the platform: y={y}"
            );
            // Bodies must stay on the platform, not get flung sideways: a
            // blown-up contact resolution shows up here first.
            assert!(
                (x - origin_x).abs() < 300.0,
                "body {i} was ejected sideways from origin {origin_x}: x={x}"
            );
        }
        let ys: Vec<f32> = (0..8u32).map(|i| pos_of(&e, 10 + i).1).collect();
        println!("D3 origin_x={origin_x} settled, y={ys:?}");
    }
}

/// D4 — parry delta #3 (zero-direction raycast inside an AABB). At parry 0.26
/// this panicked, which on wasm32 is an unrecoverable trap that kills the
/// engine. The engine guards the input itself, so the guard is what we pin:
/// a degenerate ray must be rejected, not forwarded to rapier.
#[test]
fn d4_zero_direction_raycast_is_rejected_not_trapped() {
    let mut e = Engine::new();
    e.process_commands(&[spawn2d(1), setpos(1, 0.0, 0.0), body(1, 1), collider(1, 1, 100.0, 100.0)]);
    e.update(DT);

    // Origin is INSIDE the collider — the case that used to panic.
    // `raycast` returns the external entity id, or -1 for "no hit".
    let hit = e.physics.raycast(0.0, 0.0, 0.0, 0.0, 1000.0);
    println!("D4 zero-direction raycast -> {hit}");
    assert_eq!(hit, -1, "a zero-length ray direction must be rejected, got {hit}");

    // A well-formed ray from the same origin must still work, proving the
    // guard rejects the degenerate case rather than disabling raycasting.
    let ok = e.physics.raycast(0.0, 0.0, 1.0, 0.0, 1000.0);
    assert_eq!(ok, 1, "a valid ray from inside the collider should still hit entity 1, got {ok}");
}
