---
name: new-command
description: Add a new ring-buffer CommandType end-to-end (Rust enum + handler + TS producer + fluent API + tests). Use when adding a command to the Rust/TypeScript wire protocol.
disable-model-invocation: true
---

Add a new `CommandType` to the Hyperion command protocol. The user should provide: what the command does, its payload fields, and which entity/engine state it mutates.

## Why this needs a checklist

The protocol is declared **twice** — `crates/hyperion-core/src/ring_buffer.rs` (compiled into WASM) and `ts/src/ring-buffer.ts` (compiled into the producer) — and nothing in either toolchain checks that they agree. Some steps below are compiler-enforced; the rest fail **silently at runtime**. The 2026-07 audit found five commands that had been defined with no handler at all.

Failure mode when the tables disagree: the consumer hits an unknown opcode, `RingBufferConsumer::drain` resyncs `read_head` to `write_head`, and **every remaining command in that batch is discarded**. Symptom is entities that stop responding, which looks like a renderer bug. Diagnose with `engine_dropped_command_bytes()`.

Locations below are given as symbol anchors first; line numbers are hints that drift.

---

## Step 0 — claim the discriminant

The next free value is whatever `MAX_COMMAND_TYPE` currently is. **Append only — never renumber or reuse.** The wire format is positional, so a stale WASM build against a renumbered table mis-frames the stream silently.

> Precedent for what not to do: phase 15d reslotted `MoveCharacter(40)`/`SetCharacterConfig(41)` into `CreateSpringJoint(40)`/`SetSpringParams(41)`. The design docs and CLAUDE.md still disagree about the physics ranges as a result.

---

## Rust

### 1. Add the enum variant
`ring_buffer.rs` → `pub enum CommandType`. Append after the current last variant, with a trailing comment giving payload layout and byte count in the existing style (`// 8B: ux(f32) + uy(f32)`).

### 2. Add the `from_u8` arm
`ring_buffer.rs` → `impl CommandType::from_u8`. Add the arm **before** `_ => None`.

⚠️ This match has a catch-all, so **the compiler will not catch omission**. This is the silent-drop path described above.

### 3. Add the `payload_size` arm
`ring_buffer.rs` → `pub fn payload_size`. **No catch-all** — omitting it is a compile error (E0004). This is the Rust-side enforcement point.

Value must be `0..=16`. `message_size()` is derived (`1 + 4 + payload_size`) and needs no edit.

### 4. Bump `MAX_COMMAND_TYPE` — only after steps 1–3
`ring_buffer.rs` → `pub const MAX_COMMAND_TYPE`.

**Order is load-bearing.** `max_command_type_matches_last_discriminant` asserts both `from_u8(MAX-1).is_some()` and `from_u8(MAX).is_none()`. Bumping first fails the first assertion; adding the variant without bumping fails the second. Both edits must land in the same commit.

### 5. Handle it in `process_single_command`
`command_processor.rs` → `fn process_single_command`. Its match is **exhaustive with no `_` arm**, so a new variant is a compile error until handled. Three legitimate shapes:

| Shape | When | Model |
|---|---|---|
| Real ECS handler | mutates a component | `CommandType::SetBoundingRadius` |
| No-op in the physics catch group | work happens in `physics_commands.rs` | the grouped no-op arm |
| No-op `=> {}` | handled at engine level | `CommandType::SetPhysicsDebugRender` |

A real handler must: resolve via `entity_map.get(cmd.entity_id)` → validate every float with `is_finite()` → mutate → **mark dirty**.

Dirty marking is mandatory for anything touching render data, and is easy to forget because nothing fails without it — the entity just never updates on screen:
```rust
if let Some(slot) = render_state.get_slot(entity) {
    render_state.dirty_tracker.mark_transform_dirty(slot); // and/or bounds/meta
}
```

### 6. (Conditional) engine-level intercept
If the command is **engine** state rather than entity state, it uses `entity_id = 0` as a sentinel and must be intercepted in `Engine::process_commands` *before* ECS dispatch. Models: `SetListenerPosition`, `SetPhysicsDebugRender`. It still needs a no-op arm from step 5.

### 7. (Conditional) live-Rapier routing
If it needs `&mut PhysicsWorld` on a live body/collider/joint, add it to `process_physics_commands` in `physics_commands.rs` (second pass, after `process_commands`). Three insertion points — pick by key:

1. **Pre-lookup match** — for commands keyed by `joint_id`, or that only touch `PhysicsWorld` state. Each arm ends with `continue`. Models: `RemoveJoint`, `TeleportBody`. ⚠️ has a `_ => {}`, so omission is silent.
2. **`apply_collider_override`** — for collider properties. Note the dual live/pending shape: apply to the live collider if it exists, else stage onto `PendingCollider` so options issued in the same batch as `CreateCollider` are not lost.
3. **Live-body match** — for rigid-body params, with `stage_pending_body_param` as the pending fallback.

### 8. (Conditional) synchronous read-back
If the command needs a result read back synchronously (the "hybrid result pattern"), add a `#[wasm_bindgen]` export in `crates/hyperion-core/src/lib.rs` **and** the matching accessor on `EngineBridge` in `ts/src/worker-bridge.ts`. Model: `CreateCharacterController` → `engine_character_grounded` / `engine_character_sliding`.

### 9. Rust tests
In `ring_buffer.rs` `mod tests`:
- extend `audit_2026_07_command_types_round_trip` with a `from_u8` assertion
- extend `audit_2026_07_payload_sizes` with an explicit `payload_size()` assertion
- `max_command_type_matches_last_discriminant` needs no edit but must pass

Handler behaviour: `command_processor.rs mod tests` via the **`run_commands` helper** — it hides the cfg-conditional 4-vs-5-param `process_commands` signature, so never call `process_commands` directly from a test. Physics: `physics_commands.rs mod tests`, fixtures `setup_two_bodies_with_joint` / `setup_kinematic_entity`.

---

## TypeScript

### 10. Add the enum member
`ts/src/ring-buffer.ts` → `export const enum CommandType`. Append with a JSDoc line.

> `const enum` has no reverse mapping — `CommandType[value]` is a TS2476 error. Log numeric values.

### 11. Add the `PAYLOAD_SIZES` entry
`ts/src/ring-buffer.ts` → `export const PAYLOAD_SIZES: Record<CommandType, number>`. Because the type is `Record<CommandType, number>`, a missing key is a **compile error (TS2741)** — the TS-side enforcement point mirroring the exhaustive Rust match.

⚠️ The value must equal the Rust `payload_size()` arm **exactly**. A mismatch produces no error on either side: the producer writes N bytes, the consumer reads M, and every subsequent command in the batch is mis-framed from that offset on.

### 12. Bump `MAX_COMMAND_TYPE`
`ts/src/backpressure.ts`, and update its trailing `// CommandType values: 0..N` comment.

This constant is **not just documentation**: `PrioritizedCommandQueue.purgeEntity` loops `0 .. MAX_COMMAND_TYPE` clearing the coalescing map. Forget the bump and a pending *coalescable* command of the new type survives a `DespawnEntity` and is flushed against a dead entity. Non-coalescable commands are unaffected, which makes this easy to miss.

### 13. Classify in `isNonCoalescable`
`ts/src/backpressure.ts` → `function isNonCoalescable`.

Answer **yes to any** of these four and it is non-coalescable:

1. **Additive/accumulating?** Two calls in one frame must produce two effects. `ApplyForce`/`ApplyImpulse`/`ApplyTorque` accumulate. Contrast `MoveCharacter`, which *replaces* the desired translation and is deliberately coalescable.
2. **Lifecycle edge?** Create/Destroy pairs must both survive and stay ordered.
3. **Discrete event where the intermediate value matters?** `TeleportBody`: "respawn then nudge" is two distinct repositionings. Contrast `SetPosition`, where only the final value is observable.
4. **Keyed by something other than `entity_id`?** The coalescing key is only `entityId * 256 + cmd`. Joint commands carry `joint_id` in the payload, so two different joints on the same entity with the same command type collapse to one key and one is silently lost. This is why the *entire* joint range is non-coalescable regardless of whether a given command is a creator or a setter.

No to all four → leave it out entirely (falls through to `return false`).

Prefer an explicit `if (cmd === CommandType.X) return true;` over widening one of the three existing range checks — those are contiguous by historical accident, and widening one to reach a distant discriminant sweeps in unrelated commands. Update the JSDoc block above the function, which enumerates the families.

### 14. Add the producer method
`ts/src/backpressure.ts` → `class BackpressuredProducer`. All three bridge factories use it, so this is the method that matters. Payload encoding:

| Payload shape | Encoding | Model |
|---|---|---|
| Whole number of f32 | `new Float32Array([...])` | `setBoundingRadius` |
| Mixed / odd byte count | `new Uint8Array(n)` + `DataView` | `teleportBody` (13B = 3 f32 + 1 flag) |

⚠️ `writeCommand`'s Float32Array branch iterates `payload.length` f32 slots and **cannot express a trailing byte**. Always little-endian (`dv.setFloat32(off, v, true)`). A `Uint8Array` payload must be at least `payloadSize` bytes or it reads past the end.

Mirror onto `RingBufferProducer` only if you need the non-backpressured direct path — it deliberately carries only a core subset.

### 15. Expose on the public API
Pick the layers that apply:
- `ts/src/entity-handle.ts` → fluent method: call `this.check()`, delegate to `this._producer!.<method>(this._id, ...)`, `return this`. Models: `teleport`, `boundingRadius`, `colliderEvents`. **Exception:** joint creators return a `JointHandle`, not `this`.
- `ts/src/raw-api.ts` → low-level numeric path
- `ts/src/hyperion.ts` → facade/engine-level commands
- `ts/src/physics-api.ts` → if it belongs to `PhysicsAPI`
- `ts/src/index.ts` → re-export any new public type

### 16. TypeScript tests
`ts/src/ring-buffer.test.ts` → `describe('audit 2026-07 command types')`.

⚠️ **Two tests in that block have hard-coded loop bounds** written as `t <= CommandType.SetCharacterUp`. Re-point both at the new last member, or the new command is silently excluded from the 16-byte-limit and declared-payload-size sweeps.

`ts/src/backpressure.test.ts`:
- `describe('physics debug render command (Phase 16)')` — best single template for a small new command: coalescing, payload bytes, zero case, and `PAYLOAD_SIZES` in one block
- `describe('physics command coalescing')` — add the classification test
- `describe('character controller commands')` — shows both polarities side by side

Plus `entity-handle.test.ts` (returns `this`, right CommandType, throws after `destroy()`).

---

## Payload rules

**Hard limit: 16 bytes.** Structural, not a convention — `pub struct Command { pub payload: [u8; 16] }`, and both `parse_commands_checked` and `drain` do `payload[..psize].copy_from_slice(...)`, which **panics** if `payload_size() > 16`.

Wire format: `[cmd_type: u8][entity_id: u32 LE][payload: 0..=16 bytes]`, little-endian throughout.

**Odd byte counts are legal** — `TeleportBody` is 13 bytes.

**When you need more than 16 bytes, split into two commands.** Canonical example: `PrimitiveParams` is 8 f32 = 32 bytes, split as `SetPrimParams0` (params 0–3) and `SetPrimParams1` (params 4–7). Rust handles them as two independent arms writing disjoint halves of the same component. They use distinct command types, so the coalescing key keeps them separate.

**Known open case:** `CreateCollider` declares 16 but only 13 are usable (1B shapeType + 3×f32, hard-clamped by `Math.min(params.length, 3)`). A Segment shape needs 4 params = 17 bytes and does not fit. Documented resolution is the same 2-command pattern (`CreateCollider` + a new `SetColliderVertices`), still unimplemented.

---

## Validation

The commit is **gated** by `.claude/hooks/guard-protocol-drift.sh` (PreToolUse on Bash). It blocks any `git commit` unless:
- the variant identifier is **identical** in both files, written as `Name = N,`
- Rust `MAX_COMMAND_TYPE` == TS `MAX_COMMAND_TYPE`
- `MAX_COMMAND_TYPE` == highest discriminant + 1

One-shot bypass: `touch .claude/.skip-drift-guard` (consumed on use). The guard no-ops if either enum body fails to parse, so it is a backstop, **not** a substitute for the tests.

```bash
# Rebuild WASM FIRST — the #1 failure mode is a stale binary
cd ts && npm run build:wasm            # and build:wasm:physics / :dev as needed

# Full gate
cargo test -p hyperion-core --all-features && cargo clippy -p hyperion-core
cd ts && npm test && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"
```

All five feature combinations must pass — the cfg-conditional `process_commands` signature means a handler can compile under one and break another:
```bash
cargo test -p hyperion-core
cargo test -p hyperion-core --features dev-tools
cargo test -p hyperion-core --features physics-2d
cargo test -p hyperion-core --features "physics-debug dev-tools"
cargo test -p hyperion-core --all-features
```

Run the **`protocol-sync-checker`** agent before committing (a PostToolUse hook reminds you when `ring_buffer.rs` / `ring-buffer.ts` / `backpressure.ts` / `lib.rs` / `worker-bridge.ts` / `engine-worker.ts` is touched).

## Update CLAUDE.md

Stale docs here are actively harmful — CLAUDE.md is loaded as authoritative context every session. Update:
- the `ring_buffer.rs` crate-table row (variant count)
- the `ts/src/ring-buffer.ts` row (`CommandType` const enum variant count)
- **all four** `MAX_COMMAND_TYPE` gotcha bullets — they are scattered and have historically fallen out of sync with each other
- the `isNonCoalescable()` gotcha, if you changed the classification
- the `backpressure.ts` row's producer-method count

Or run the **`claude-md-auditor`** agent, which checks these mechanically.
