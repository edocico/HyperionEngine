# Phase 16: Physics Debug + Determinism + Snapshot v2 — Implementation Plan

> **Date**: 2026-07-25
> **Design**: `2026-07-25-phase16-physics-debug-determinism-snapshot-design.md`
> **Baseline**: commit 2a2b1fd — 159/236/169/246 Rust, 821 TS

Ten tasks in three tracks. Track order C → B → A is deliberate: snapshot v2
(C) unblocks the restore-replay determinism tests (B); debug rendering (A) is
independent and lands last with the demo work.

---

## Track C — Snapshot v2

- [ ] **Task 1: HSNP v2 core format (engine.rs)**
  - `snapshot_create`: version 2, mask u16→u32, entity-map entry gains
    `flags: u8` (bit0 = is_2d from `EntityMap`), new bits 15 `Transform2D`,
    16 `Depth`, 17 `Transparent`, 18 `OverflowChildren`.
  - `snapshot_restore`: branch on version (v1 path preserved verbatim);
    v2 path spawns 2D archetype when bit 15 set; rebuild `is_2d` in EntityMap.
  - Tests: 2D roundtrip, OverflowChildren roundtrip, v1 back-compat,
    is_2d command routing after restore, mask encoding. (~8 tests)
  - Gate: `cargo test -p hyperion-core --features dev-tools`

- [ ] **Task 2: JointEntry.kind (physics.rs)**
  - Add `kind: u8` to `JointEntry`; set from `PendingJointType` discriminant
    in `physics_sync_pre` Pass 4. Pure additive, no behavior change.
  - Tests: kind recorded per joint type. (~2 tests)
  - Gate: `cargo test -p hyperion-core --features physics-2d`

- [ ] **Task 3: physics section — create (engine.rs + physics.rs)**
  - `physics_present` byte; readback serializers: bodies (via
    `rigid_body_set`, ordered by ext_id), colliders (`as_typed_shape()` for
    ball/cuboid/capsule params), joints (`joint_map` + `GenericJoint` anchors
    /params, ordered by joint_id), character controllers (`character_map`).
  - Gate: compiles under all 4 feature combos; section length self-describing.

- [ ] **Task 4: physics section — restore (engine.rs + physics.rs)**
  - `PhysicsWorld::new()` teardown → rebuild bodies/colliders/joints/CCs →
    re-insert `PhysicsBodyHandle`/`PhysicsColliderHandle`/`PhysicsControlled`
    → rebuild `collider_to_entity`. Skip-by-length on non-physics builds.
  - Tests: full roundtrip counts + state, orphan cleanup, joint_map keys,
    handle re-insertion, cross-feature skip. (~8 tests)
  - Gate: `cargo test -p hyperion-core --features "physics-2d dev-tools"`

## Track B — Determinism Harness

- [ ] **Task 5: state hash (engine.rs + lib.rs)**
  - FNV-1a 64 over canonical state (design §3.5): ext-id ordering, f32
    bit patterns. `Engine::state_hash()` + `engine_state_hash()` export,
    dev-tools gated.
  - Tests: run-to-run equality, sensitivity, ordering stability, mixed
    2D/3D. (~4 tests)

- [ ] **Task 6: restore-replay determinism tests (engine.rs tests)**
  - Scripted physics scene → snapshot at T → two independent restores →
    +N ticks each → hashes equal. Depends on Tasks 4+5.
  - Tests: with bodies, with joints, with CC. (~3 tests)
  - Gate: full validation of Tracks C+B before starting Track A.

## Track A — Physics Debug Rendering

- [ ] **Task 7: Rust protocol + debug pipeline**
  - `Cargo.toml`: `physics-debug` feature. `ring_buffer.rs`: CommandType 47,
    payload 1. `physics_commands.rs`: route 47. `physics.rs`:
    `HyperionDebugBackend` + static `DEBUG_LINES`. `engine.rs`: per-frame
    debug render when enabled. `lib.rs`: `engine_physics_debug_ptr/f32_len`.
  - Tests: roundtrip, lines for ball/cuboid/capsule/joint scene, disable→0,
    stride. (~6 tests)
  - Gate: `cargo clippy --features "physics-2d dev-tools physics-debug"`

- [ ] **Task 8: TS protocol + bridges**
  - `ring-buffer.ts`: CommandType 47 + PAYLOAD_SIZES. `backpressure.ts`:
    `setPhysicsDebugRender()`, coalescable, MAX_COMMAND_TYPE=48.
    `worker-bridge.ts`: `GPURenderState.physicsDebugLines?: Float32Array`,
    copy in Mode C/B, add to Mode A main-thread copy set.
  - `package.json`: `build:wasm:physics:dev` script.
  - Tests: producer, coalescing, bridge transfer. (~9 tests)
  - Gate: run **protocol-sync-checker** agent.

- [ ] **Task 9: DebugLinePass + plugin + shader**
  - `shaders/debug-line.wgsl`; `render/passes/debug-line-pass.ts`;
    `debug/physics-debug.ts` (`physicsDebugPlugin`, F3); refactor
    `BoundsVisualizerPass` onto the shared line-draw helper; barrel export.
  - Tests: pass lifecycle, empty no-op, plugin wiring, headless no-op,
    bounds regression. (~16 tests)
  - Gate: run **wgsl-validator** agent; visual check `npm run dev`.

## Finalization

- [ ] **Task 10: demo harness + docs + validation**
  - `demo/debug-tools.ts`: "physics debug render" + "determinism hash" checks.
  - Full validation pipeline (design §9), including production size gates.
  - Run **physics-integration-checker** agent.
  - CLAUDE.md: module tables (physics.rs, engine.rs, lib.rs exports,
    backpressure, worker-bridge, debug/, shaders table +1), Gotchas
    (MAX_COMMAND_TYPE=48; snapshot v2 mask u32; restore-replay ≠ original-run;
    debug lines per-frame; hash ext-id ordering), Implementation Status
    row Phase 16, test counts, build scripts section.
  - Commit sequence mirrors 15e style: one commit per task, `feat(#16):` /
    `docs:` prefixes.

---

## Execution Order

```
Task 1 (HSNP v2 core) ──────────────┐
Task 2 (JointEntry.kind) ─┐         │
Task 3 (physics create) ←─┴─(1,2)   │
Task 4 (physics restore) ←──(3)     │
Task 5 (state hash) ←───────────────┘ (independent of 2-4, needs 1 for 2D)
Task 6 (restore-replay tests) ←─(4,5)
Task 7 (Rust debug) — independent, after 6 for clean bisects
Task 8 (TS protocol) ←─(7)
Task 9 (pass + plugin) ←─(8)
Task 10 (demo + docs) ←─(all)
```

Critical path: 1 → 3 → 4 → 6 → 10.
Estimated new tests: ~31 Rust, ~25 TS → targets ≈ 190/267/~200/~277 Rust
(combo estimates; record actuals in CLAUDE.md at Task 10), ~846 TS.
