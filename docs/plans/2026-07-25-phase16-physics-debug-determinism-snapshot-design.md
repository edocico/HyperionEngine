# Phase 16: Physics Debug Rendering, Determinism Harness, Snapshot v2 — Design Document

> **Date**: 2026-07-25
> **Status**: Design approved
> **Depends on**: Phase 15 (spike + 15a–15e) — complete
> **Baseline tests**: 159 Rust (236 with physics-2d, 169 with dev-tools, 246 with both), 821 TypeScript
> **Baseline commit**: 2a2b1fd

---

## 1. Motivation

Phase 15 completed the Rapier2D integration (protocol, core simulation, events,
scene queries, joints, character controller). Three items from the masterplan
§16.8 physics roadmap remain, and one latent defect was found during the
2026-07-25 health check:

- **Physics debug rendering** — there is no way to *see* colliders, joints, or
  contacts. Debugging physics behavior today means reading numbers. Every
  serious physics integration ships a wireframe debug view.
- **Determinism** — the engine claims deterministic simulation (fixed timestep,
  masterplan §2) but nothing verifies it. Without a measurable harness, the
  claim is untestable and future regressions are invisible.
- **Snapshot ↔ physics integration** — `snapshot_create/restore` (Phase 10c)
  predates both Phase 13 and Phase 15. Two concrete defects:
  1. **Physics is not snapshotted.** `snapshot_restore` replaces `world` and
     `entity_map` but never touches `self.physics`. Rapier bodies survive the
     restore as orphans (still simulating, no ECS entity), and restored
     entities lose `PhysicsBodyHandle`/`PhysicsColliderHandle` components
     (no mask bit exists for them). Restore with physics enabled is broken.
  2. **2D entities are not snapshotted.** HSNP v1 masks bits 0–14 only:
     `Transform2D`, `Depth`, `Transparent`, and `OverflowChildren` are never
     serialized. A `Transform2D` entity round-trips as a 3D entity at the
     origin, and the `EntityMap.is_2d` flag is lost, so post-restore commands
     route to the wrong component type.

Phase 16 closes the physics chapter: after this phase, physics state is
visible (debug render), verifiable (determinism harness), and time-travel-safe
(snapshot v2).

---

## 2. Scope

Three tracks, independent enough to implement in sequence with separate
validation:

- **Track A — Physics debug rendering**: Rapier `DebugRenderPipeline` behind a
  new cargo feature, line data exported to TS, drawn by a real debug line
  render pass, toggled by an F3 plugin.
- **Track B — Determinism harness**: a canonical 64-bit state hash exported
  from WASM, Rust tests proving run-to-run and restore-replay determinism, a
  demo check enabling manual cross-browser comparison.
- **Track C — Snapshot v2**: HSNP version 2 with u32 component mask, the four
  missing component types, `is_2d` in the entity map, and a physics section
  rebuilt-from-state on restore.

### Non-Goals

- **Serde full-state physics serialization** (`serde-serialize` + bincode).
  Rebuild-from-spec was chosen (2026-07-25): zero new dependencies, no binary
  size impact. Byte-exact solver-cache fidelity is documented as a future
  extension if lockstep multiplayer ever requires it (see §6 Invariant I-5).
- **`enhanced-determinism` build variant.** It is mutually exclusive with
  `simd-stable` (verified against Rapier docs, 2026-07-25). Since Hyperion
  ships a single wasm32 binary and the WASM spec mandates IEEE 754 semantics
  (including SIMD128, modulo NaN payloads), cross-browser determinism should
  already hold. Track B *measures* this instead of paying the SIMD cost.
  If the harness ever fails cross-browser, this decision reopens.
- **ECS inspector (TLV) coverage of physics/2D components** — separate DX
  concern, noted for a future 10d-DX-style phase.
- **Contact point / force visualization** — Rapier's debug pipeline renders
  shapes and joints; contact rendering is a possible later extension.

---

## 3. Design Decisions

### 3.1 Track A: Rapier DebugRenderPipeline, not hand-rolled shape tracing

Rapier ships `DebugRenderPipeline` (cargo feature `debug-render`) which walks
`RigidBodySet`/`ColliderSet`/joint sets and emits colored line segments via a
`DebugRenderBackend` trait (`draw_line(object, a, b, color)`). Using it means:

- zero shape-math maintained by us (capsule tessellation, joint anchors, etc.)
- automatic coverage of future shape types
- colors encode body state (sleeping/active/kinematic) for free

Alternative rejected: reading collider shapes ourselves and tessellating in
TS — duplicates Rapier logic and drifts when shapes are added.

### 3.2 Track A: new cargo feature `physics-debug`, dev-builds only

```toml
[features]
physics-debug = ["physics-2d", "rapier2d/debug-render"]
```

- Production physics build (`build:wasm:physics:release`) does NOT include it:
  zero cost, zero size impact on shipped binaries.
- New npm script `build:wasm:physics:dev` compiles
  `--features "physics-2d dev-tools physics-debug"` for the demo harness.
- Rationale: consistent with the existing `dev-tools` gating philosophy
  ("don't pay for what you don't use"). `physics-debug` is separate from
  `dev-tools` because it pulls a Rapier sub-dependency; `dev-tools` remains
  dependency-free.

### 3.3 Track A: toggle via ring buffer command, data back via SoA-style export

The engine may live in a Worker (Mode A/B), so the toggle must be a command
and the line data must travel with the per-frame render state:

- **CommandType 47 `SetPhysicsDebugRender`**, payload 1 byte (0/1).
  Coalescable (last-write-wins). `MAX_COMMAND_TYPE` → 48.
- When enabled, `Engine::update()` runs the debug pipeline once per *frame*
  (after the tick loop, not per tick) into a `static mut` f32 buffer
  (same pattern as `RAYCAST_RESULT`/`OVERLAP_RESULTS`; safe on wasm32
  single-thread, `addr_of_mut!()` access).
- **Line record: 8 f32** = `[ax, ay, bx, by, r, g, b, a]`.
- New WASM exports: `engine_physics_debug_ptr() -> *const f32`,
  `engine_physics_debug_f32_len() -> u32` (= line_count × 8).
- Bridges copy the buffer into `GPURenderState.physicsDebugLines?: Float32Array`
  only when non-empty. Mode A: included in the main-thread copy set
  (see CLAUDE.md gotcha "Mode A: main thread copies ALL SoA arrays").

### 3.4 Track A: a real DebugLinePass (completing the Phase 10b stub)

`BoundsVisualizerPass.execute()` is a documented stub ("Line rendering would
happen here"). Phase 16 builds the missing piece once, generically:

- New `render/passes/debug-line-pass.ts`: line-list pipeline, camera uniform
  bind group, CPU-written vertex+color buffers, `loadOp: 'load'`, drawn after
  the scene (same layering as particles). Reads nothing from ResourcePool
  except `swapchain` + camera; safe alongside outlines/bloom.
- `debug/physics-debug.ts`: `physicsDebugPlugin` — F3 toggle (F1 = debug cam,
  F2 = bounds, F12 = inspector are taken), sends `SetPhysicsDebugRender`,
  feeds `GPURenderState.physicsDebugLines` into the pass each frame via a
  postTick hook. Graceful no-op when `ctx.rendering` is null (Mode A main
  thread / headless) or when the WASM build lacks the exports.
- Follow-up (in-scope, small): `BoundsVisualizerPass` is refactored to draw
  through the same pipeline helper, closing the stub.

New WGSL: `debug-line.wgsl` (trivial vertex color pass-through; declared in
renderer SHADER_SOURCES for HMR like the other 18).

### 3.5 Track B: FNV-1a 64 canonical state hash, dev-tools export

`engine_state_hash() -> u64` (BigInt on the TS side — existing gotcha applies),
gated `dev-tools`. Canonical serialization hashed with FNV-1a 64 (no new
dependency, ~15 lines):

- `tick_count`
- ECS: entities ordered by **external ID** (never hecs iteration order —
  archetype order is not part of the contract): for each, the bit patterns
  (`f32::to_bits`) of Position/Rotation/Scale/Velocity or Transform2D + Depth.
- Physics (if compiled + non-empty): bodies ordered by external ID:
  translation/rotation/linvel/angvel bit patterns + sleeping flag; joint_map
  entries ordered by joint_id (kind + entity pair).

Float bit patterns, not values: `-0.0 != 0.0` and NaN payloads must count as
differences — hashing formatted values would mask them.

Tests prove three properties:

1. **Run-to-run**: two engines fed an identical command script, stepped N
   ticks → identical hash. (Native x86 test — proves the code path is
   order-stable; the wasm32 IEEE guarantee covers the browser side.)
2. **Restore-replay**: snapshot at tick T, two *independent* restores each
   stepped +N ticks with the same commands → identical hash.
3. **Sensitivity**: one extra command in one run → different hash (guards
   against a degenerate hash).

Demo harness (`demo/debug-tools.ts`): a "determinism" check runs a scripted
physics scene for 120 ticks and displays the hash; the JSON report includes
it, so cross-browser comparison is a manual diff of two report files.

### 3.6 Track B: what restore-replay does NOT promise

With rebuild-from-spec, a restore discards Rapier's internal solver caches
(warm-start impulses, contact manifolds, island state). Therefore:

- restore(T) + N ticks **==** restore(T) + N ticks (deterministic)
- restore(T) + N ticks **!=** original uninterrupted run at T+N (in general)

This is accepted and documented (Invariant I-5). ReplayPlayer time-travel
remains correct because replay always goes through a restore on both sides of
any comparison. Byte-exact continuation would require serde full-state — the
documented future extension.

### 3.7 Track C: HSNP v2 format

Version bumps to 2. Reader keeps a v1 branch (existing snapshots in
SnapshotManager circular buffers must not break mid-session); writer always
emits v2.

```text
[magic "HSNP"][version: u32 = 2][tick: u64][entity_count: u32]
[entity_map_len: u32][entity_map: (ext_id: u32, hecs_id: u64, flags: u8) × N]   // flags bit0 = is_2d
[per entity: hecs_id: u64, component_mask: u32, component_data...]              // mask u16 → u32
[physics_present: u8]                                                            // 0 = section absent
[physics section — only if physics_present == 1]
```

New mask bits (v2): bit 15 `Transform2D` (20 B), bit 16 `Depth` (4 B),
bit 17 `Transparent` (1 B), bit 18 `OverflowChildren` (u8 count + count×4 B).
Bits 0–14 unchanged from v1. Restore spawns the 2D archetype when
`Transform2D` is present (mirroring `SpawnEntity` payload routing) so restored
2D entities keep the compact archetype instead of gaining phantom 3D
components. All reads via `pod_read_unaligned` (existing gotcha).

### 3.8 Track C: physics section = readback from live Rapier state

At `snapshot_create`, records are read back from the live sets — a single
source of truth, no shadow bookkeeping of creation specs, and runtime state
(velocities, sleeping) comes for free. Ordered by external ID (determinism).

```text
[body_count: u32]
per body:    [ext_id: u32][body_type: u8][flags: u8]            // flags: sleeping, ccd
             [tx, ty, rot: f32×3][lvx, lvy, angv: f32×3]
             [gravity_scale, lin_damping, ang_damping: f32×3]
[collider_count: u32]
per collider:[ext_id: u32][shape_type: u8][is_sensor: u8]
             [p0, p1, p2: f32×3]                                 // shape params, readback via as_typed_shape()
             [density, friction, restitution: f32×3]
             [collision_membership: u32][collision_filter: u32]
[joint_count: u32]
per joint:   [joint_id: u32][kind: u8][entity_a: u32][entity_b: u32]
             [anchor_ax, anchor_ay, anchor_bx, anchor_by: f32×4]
             [params: f32×6]                                     // kind-specific: axis/limits/motor/stiffness/damping
[cc_count: u32]
per cc:      [ext_id: u32][config: KCC fields, f32×8 + flags u8][state: u8]
```

Enablers (small code changes in 15x code):

- `JointEntry` gains `kind: u8` (set in `physics_sync_pre` Pass 4). Reading
  the joint type back out of a `GenericJoint`'s locked-axes mask is fragile;
  one byte at creation is not.
- Shape readback covers exactly the three supported shapes
  (ball/cuboid/capsule_y, `build_collider_shape`); an unknown shape fails the
  snapshot in debug builds (unreachable today).

Restore order: `PhysicsWorld::new()` (drop all old state) → bodies → colliders
(with parent bodies, rebuilding `collider_to_entity`) → joints (fresh Rapier
handles, same `joint_id` keys in `joint_map`) → character controllers →
re-insert `PhysicsBodyHandle`/`PhysicsColliderHandle`/`PhysicsControlled` on
the restored entities. Pending queues (`pending_joints`, `pending_moves`) are
snapshotted implicitly as "already flushed": snapshot_create runs outside the
tick loop, after `physics_sync_pre` consumed them (Invariant I-3).

Feature asymmetry: a snapshot written with physics restored on a build
without `physics-2d` skips the section by length (the section is
self-describing); `physics_present=1` data is preserved-and-ignored, a
warning counter is exposed via `engine_dirty_count`-style export? No —
simply documented: cross-feature restore drops physics (Invariant I-4).

### 3.9 Snapshot exports unchanged

`engine_snapshot_create/restore` signatures do not change; SnapshotManager
and ReplayPlayer treat the buffer as opaque bytes. TS changes for Track C are
zero (tests aside). This keeps 10c's public API stable.

---

## 4. Protocol Layer

| # | CommandType | Payload | Coalescable |
|---|---|---|---|
| 47 | `SetPhysicsDebugRender` | 1 B: enabled (0/1) | yes (last-write-wins) |

- `MAX_COMMAND_TYPE`: 47 → **48** (backpressure.ts).
- `PAYLOAD_SIZES[47] = 1` (ring-buffer.ts), Rust `payload_size(47) = 1`
  (ring_buffer.rs) — CommandType enums stay synchronized (convention).
- Routed in `process_physics_commands` second pass only when
  `physics-debug` is compiled; silently dropped otherwise (same pattern as
  other physics commands on non-physics builds).

## 5. Rust Layer Summary

| File | Change |
|---|---|
| `Cargo.toml` | `physics-debug = ["physics-2d", "rapier2d/debug-render"]` |
| `physics.rs` | `JointEntry.kind: u8`; `HyperionDebugBackend` (collects 8-f32 line records); `debug_render()` on PhysicsWorld; static `DEBUG_LINES: Vec<f32>` |
| `physics_commands.rs` | route CommandType 47 |
| `engine.rs` | `debug_render_enabled: bool`; per-frame debug pipeline run; `state_hash()` (dev-tools); `snapshot_create/restore` v2 (mask u32, 4 new bits, is_2d flags, physics section, v1 read branch) |
| `ring_buffer.rs` | CommandType 47 + payload size |
| `lib.rs` | exports: `engine_physics_debug_ptr/f32_len` (physics-debug), `engine_state_hash` (dev-tools) |

## 6. Invariants

- **I-1** Debug line buffer is regenerated once per frame (not per tick) and
  only when enabled; disabled ⇒ len 0 and zero Rapier debug work.
- **I-2** State hash orders every collection by external ID / joint_id. hecs
  iteration order must never leak into the hash.
- **I-3** `snapshot_create` runs between frames (WASM export call), i.e.
  after pending physics queues were consumed. Snapshotting mid-frame is not
  a supported state.
- **I-4** Snapshot v2 sections are self-describing in length: any reader can
  skip the physics section without understanding it. Cross-feature restore
  (physics snapshot → non-physics build) succeeds and drops physics.
- **I-5** Restore-replay determinism is guaranteed between restores of the
  same snapshot; identity with the uninterrupted original run is NOT
  guaranteed (warm-start caches are not serialized). Future serde-full-state
  extension would upgrade this.
- **I-6** Production builds (`physics-2d` without `physics-debug`/`dev-tools`)
  contain zero debug-render code and zero hash code (verify via size gate).

## 7. Test Targets

**Rust** (~+30):

- ring_buffer: CommandType 47 roundtrip + payload size (2)
- physics debug (feature physics-debug): enable→lines non-empty for
  ball/cuboid/capsule/joint scene; disable→len 0; line record stride (4)
- state hash (dev-tools): run-to-run equality; sensitivity; ordering
  stability under spawn-order permutation; 2D+3D mixed scene (4)
- snapshot v2: 2D entity roundtrip (Transform2D/Depth/Transparent);
  OverflowChildren roundtrip; is_2d flag preserved + command routing after
  restore; v1 snapshot still restores; mask bit 15–18 encoding (8)
- snapshot v2 physics (physics-2d + dev-tools): body/collider/joint/CC
  roundtrip counts + state; orphan-cleanup (restore clears old bodies);
  restore-replay hash equality; joint_map key stability; handle component
  re-insertion (8)
- despawn/reset interplay: reset clears debug buffer + hash changes (2)

**TypeScript** (~+25):

- backpressure: producer method, coalescing, MAX_COMMAND_TYPE (5)
- debug-line-pass: pipeline creation, vertex upload, empty-buffer no-op,
  resize (6)
- physics-debug plugin: F3 toggle wiring, command emission, headless no-op,
  missing-export no-op (6)
- bridge: physicsDebugLines transfer in Mode B/C bridges (4)
- bounds-visualizer refactor regression (4)

**Demo harness**: debug-tools tab gains "physics debug render" (visual) and
"determinism hash" (reported in JSON) checks.

## 8. Binary Size

- Production `build:wasm` and `build:wasm:physics:release`: **no change**
  (new code is feature-gated out; verified by `check:wasm-size`).
- Dev `build:wasm:physics:dev`: +`debug-render` Rapier module, estimated
  +15–30 KB gz. No gate applies to dev builds, but record the number in the
  validation report.

## 9. Validation

```bash
cargo test -p hyperion-core
cargo test -p hyperion-core --features physics-2d
cargo test -p hyperion-core --features dev-tools
cargo test -p hyperion-core --features "physics-2d dev-tools"
cargo test -p hyperion-core --features "physics-2d dev-tools physics-debug"
cargo clippy -p hyperion-core --features "physics-2d dev-tools physics-debug"
cd ts && npm test && npx tsc --noEmit
cd ts && npm run check:wasm-size          # production size unchanged
# protocol-sync-checker agent (bridge files touched)
# wgsl-validator agent (debug-line.wgsl added)
# physics-integration-checker agent (physics.rs touched)
```
