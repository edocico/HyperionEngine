# Phase 15 — Rapier2D Physics Integration: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Rapier2D rigid body physics to Hyperion Engine behind a Cargo feature flag, with zero-cost when unused.

**Architecture:** Single `hyperion-core` crate with `physics-2d` feature flag produces two WASM artifacts. 26 new ring buffer CommandTypes (14-39) use a defaults-plus-overrides pattern. `PendingRigidBody`/`PendingCollider` components accumulate config before `physics_sync_pre()` creates Rapier bodies. Dual-path `physics_sync_post()` writes back to Transform2D (2D) or Position+Rotation (3D).

**Tech Stack:** Rust (rapier2d 0.32, glam, hecs, bytemuck, bincode 2), TypeScript (vitest), WASM (wasm-pack, wasm-opt)

**Design doc:** `docs/plans/2026-03-07-phase15-physics-rapier2d-design.md`

**Validation commands:**
```bash
# Rust tests
cargo test -p hyperion-core
cargo test -p hyperion-core --features physics-2d
cargo clippy -p hyperion-core --features physics-2d

# TypeScript tests
cd ts && npm test

# WASM build (without physics)
cd ts && npm run build:wasm

# WASM build (with physics) — added in Task 5
cd ts && npm run build:wasm:physics
```

---

## Milestone 15-spike: Rapier 0.32 Feasibility Spike (1 day)

### Task 1: Create rapier-spike crate scaffold

**Files:**
- Create: `crates/rapier-spike/Cargo.toml`
- Create: `crates/rapier-spike/src/lib.rs`
- Modify: `Cargo.toml:3` (add `"crates/rapier-spike"` to workspace members)

**Step 1: Add rapier-spike to workspace**

In `Cargo.toml` (workspace root), line 3:
```toml
members = ["crates/hyperion-core", "crates/loro-spike", "crates/rapier-spike"]
```

**Step 2: Create Cargo.toml for rapier-spike**

```toml
[package]
name = "rapier-spike"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
rapier2d = { version = "0.32", features = ["simd-stable"] }
```

**Step 3: Create src/lib.rs with validation functions**

```rust
//! Rapier 0.32 feasibility spike for Hyperion Engine.
//!
//! NOT a production dependency. Exists solely for API validation
//! and binary size measurement, like `crates/loro-spike`.

use wasm_bindgen::prelude::*;
use rapier2d::prelude::*;

/// Validate all Rapier 0.32 API assumptions.
/// Returns `true` if everything compiles and runs without panic.
#[wasm_bindgen]
pub fn spike_validate_all() -> bool {
    // 1. IntegrationParameters.length_unit exists and is settable
    let mut params = IntegrationParameters::default();
    params.length_unit = 100.0; // pixel space

    // 2. step() has 12-parameter signature
    let gravity = vector![0.0, -981.0]; // pixel-space gravity
    let mut pipeline = PhysicsPipeline::new();
    let mut islands = IslandManager::new();
    let mut broad_phase = DefaultBroadPhase::new();
    let mut narrow_phase = NarrowPhase::new();
    let mut bodies = RigidBodySet::new();
    let mut colliders = ColliderSet::new();
    let mut impulse_joints = ImpulseJointSet::new();
    let mut multibody_joints = MultibodyJointSet::new();
    let mut ccd = CCDSolver::new();

    // 3. RigidBodyBuilder uses glam Vec2 for translation
    let rb = RigidBodyBuilder::dynamic()
        .translation(vector![100.0, 200.0])
        .gravity_scale(1.0)
        .linear_damping(0.5)
        .angular_damping(0.1)
        .ccd_enabled(false)
        .build();
    let rb_handle = bodies.insert(rb);

    // 4. ColliderBuilder compiles with ball/cuboid/capsule
    let ball = ColliderBuilder::ball(16.0)
        .restitution(0.7)
        .friction(0.5)
        .density(1.0)
        .sensor(false)
        .build();
    colliders.insert_with_parent(ball, rb_handle, &mut bodies);

    let cuboid = ColliderBuilder::cuboid(20.0, 10.0).build();
    let _cuboid_handle = colliders.insert_with_parent(cuboid, rb_handle, &mut bodies);

    // 5. step() executes without panic (12 params)
    pipeline.step(
        &gravity,
        &params,
        &mut islands,
        &mut broad_phase,
        &mut narrow_phase,
        &mut bodies,
        &mut colliders,
        &mut impulse_joints,
        &mut multibody_joints,
        &mut ccd,
        &(),
        &(),
    );

    // 6. Body translation and rotation types
    let body = &bodies[rb_handle];
    let _pos_x: f32 = body.translation().x; // glam Vec2.x
    let _pos_y: f32 = body.translation().y;
    let _angle: f32 = body.rotation().angle(); // Rot2 -> f32

    // 7. ChannelEventCollector with mpsc
    let (collision_send, collision_recv) = std::sync::mpsc::channel();
    let (force_send, force_recv) = std::sync::mpsc::channel();
    let event_handler = ChannelEventCollector::new(collision_send, force_send);

    // Step again with event collection
    pipeline.step(
        &gravity,
        &params,
        &mut islands,
        &mut broad_phase,
        &mut narrow_phase,
        &mut bodies,
        &mut colliders,
        &mut impulse_joints,
        &mut multibody_joints,
        &mut ccd,
        &(),
        &event_handler,
    );

    // Drain events (may be empty, that's fine)
    while let Ok(_evt) = collision_recv.try_recv() {}
    while let Ok(_evt) = force_recv.try_recv() {}

    // 8. Rigid body removal cascades to colliders and joints
    bodies.remove(
        rb_handle,
        &mut islands,
        &mut colliders,
        &mut impulse_joints,
        &mut multibody_joints,
        true, // wake up touching
    );

    // 9. Joints compile
    let rb_a = bodies.insert(RigidBodyBuilder::dynamic().translation(vector![0.0, 0.0]).build());
    let rb_b = bodies.insert(RigidBodyBuilder::dynamic().translation(vector![50.0, 0.0]).build());
    let joint = RevoluteJointBuilder::new()
        .local_anchor1(point![0.0, 0.0])
        .local_anchor2(point![0.0, 0.0])
        .build();
    let _joint_handle = impulse_joints.insert(rb_a, rb_b, joint, true);

    // 10. KinematicCharacterController compiles
    let _controller = KinematicCharacterController::default();

    true // If we reach here, everything compiled and ran
}

/// Validate the wasm-bindgen feature variant (call from separate build).
#[wasm_bindgen]
pub fn spike_wasm_bindgen_check() -> bool {
    // Just verify IntegrationParameters::default() works
    // (wasm-bindgen feature affects timing internals)
    let params = IntegrationParameters::default();
    params.length_unit > 0.0
}
```

**Step 4: Verify it compiles natively**

Run: `cargo check -p rapier-spike`
Expected: Compiles successfully (or reveals API differences to fix)

**Step 5: Commit**

```bash
git add crates/rapier-spike/ Cargo.toml
git commit -m "feat(#15-spike): rapier-spike crate scaffold for API validation"
```

---

### Task 2: WASM build and binary size measurement

**Files:**
- Read: `crates/rapier-spike/src/lib.rs`

**Step 1: Build WASM binary**

Run:
```bash
wasm-pack build crates/rapier-spike --target web --out-dir ../../ts/rapier-spike-wasm
```
Expected: Produces `ts/rapier-spike-wasm/rapier_spike_bg.wasm`

If compilation fails, fix API differences in `lib.rs` based on error messages. Each fix documents a divergence from our design assumptions.

**Step 2: Measure raw and gzipped binary size**

Run:
```bash
ls -la ts/rapier-spike-wasm/rapier_spike_bg.wasm
node -e "const fs=require('fs');const z=require('zlib').gzipSync(fs.readFileSync('ts/rapier-spike-wasm/rapier_spike_bg.wasm')).length;console.log('Gzipped:',z,'('+Math.round(z/1024)+'KB)')"
```

Record: raw size and gzipped size.

**Step 3: Compare against hyperion-core baseline**

Current `hyperion-core`: 164KB raw / 59KB gzipped.

The rapier-spike includes Rapier but NOT hyperion-core code. To estimate the combined delta:
```
delta_gzipped = rapier_spike_gzipped - wasm_bindgen_overhead (~5KB)
```

The wasm-bindgen overhead is the base cost of any cdylib crate. Subtract it to get pure Rapier contribution.

**Step 4: Build with wasm-bindgen feature (if different)**

Edit `crates/rapier-spike/Cargo.toml`:
```toml
rapier2d = { version = "0.32", features = ["simd-stable", "wasm-bindgen"] }
```

Rebuild and compare sizes.

**Step 5: Record wasm-opt impact**

Run:
```bash
wasm-opt -O3 --strip-debug --enable-simd ts/rapier-spike-wasm/rapier_spike_bg.wasm -o ts/rapier-spike-wasm/rapier_spike_bg.opt.wasm
ls -la ts/rapier-spike-wasm/rapier_spike_bg.opt.wasm
node -e "const fs=require('fs');const z=require('zlib').gzipSync(fs.readFileSync('ts/rapier-spike-wasm/rapier_spike_bg.opt.wasm')).length;console.log('Gzipped after wasm-opt:',z,'('+Math.round(z/1024)+'KB)')"
```

**Step 6: Write spike report**

Create `docs/plans/2026-03-07-phase15-rapier-spike-results.md` with:

```markdown
# Phase 15 — Rapier 0.32 Spike Results

| # | Question | Result |
|---|---|---|
| 1 | Binary size without wasm-bindgen | ___KB raw / ___KB gzipped |
| 2 | Binary size with wasm-bindgen | ___KB raw / ___KB gzipped |
| 3 | After wasm-opt -O3 | ___KB raw / ___KB gzipped |
| 4 | Estimated delta vs hyperion-core | +___KB gzipped |
| 5 | step() signature | 12 params / OTHER |
| 6 | Gravity type | glam Vec2 / glamx / OTHER |
| 7 | Body rotation type | Rot2 with .angle() / OTHER |
| 8 | Body translation type | glam Vec2 / OTHER |
| 9 | length_unit field | Present / Absent / Renamed |
| 10 | ChannelEventCollector | Works with mpsc / OTHER |
| 11 | wasm-bindgen feature | Required / Not required / Problematic |
| 12 | KinematicCharacterController | Compiles / OTHER |
| 13 | RevoluteJointBuilder | Compiles / OTHER |
| 14 | body.remove() cascade | Works / OTHER |

## Gate Decision

- Delta < 400KB gzipped: **GO**
- Delta 400-500KB: Analyze with twiggy
- Delta > 500KB: Re-evaluate
```

**Step 7: Add rapier-spike-wasm to .gitignore**

Append to `.gitignore`:
```
ts/rapier-spike-wasm/
```

**Step 8: Commit spike results**

```bash
git add docs/plans/2026-03-07-phase15-rapier-spike-results.md .gitignore
git commit -m "feat(#15-spike): Rapier 0.32 feasibility spike results"
```

---

## Milestone 15a: Protocol & Scaffolding (1 week)

### Task 3: Add 26 physics CommandTypes to Rust ring_buffer.rs

**Files:**
- Modify: `crates/hyperion-core/src/ring_buffer.rs:34-96` (CommandType enum + from_u8 + payload_size)
- Test: `crates/hyperion-core/src/ring_buffer.rs` (inline tests)

**Step 1: Write failing test — new CommandType round-trips**

Add to the `#[cfg(test)] mod tests` in `ring_buffer.rs`:

```rust
#[test]
fn physics_command_types_round_trip() {
    // All 26 physics commands should survive from_u8(to_u8) round-trip
    let physics_commands: Vec<u8> = (14..=39).collect();
    for &val in &physics_commands {
        let ct = CommandType::from_u8(val);
        assert!(ct.is_some(), "CommandType::from_u8({val}) should be Some");
    }
}

#[test]
fn physics_payload_sizes_within_limit() {
    for val in 14..=39u8 {
        if let Some(ct) = CommandType::from_u8(val) {
            assert!(ct.payload_size() <= 16,
                "CommandType {val} payload {} exceeds 16-byte limit",
                ct.payload_size());
        }
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core physics_command_types`
Expected: FAIL — `from_u8(14)` returns `None`

**Step 3: Add CommandType variants 14-39**

Extend the enum in `ring_buffer.rs:34`:

```rust
pub enum CommandType {
    // ... existing 0-16 ...
    SetDepth = 16,

    // ── Physics: body commands ──
    CreateRigidBody = 17,       // 1B: body_type (0=dynamic, 1=fixed, 2=kinematic)
    DestroyRigidBody = 18,      // 0B
    CreateCollider = 19,        // 1-9B: shape_type + params
    DestroyCollider = 20,       // 0B
    SetLinearDamping = 21,      // 4B: f32
    SetAngularDamping = 22,     // 4B: f32
    SetGravityScale = 23,       // 4B: f32
    SetCCDEnabled = 24,         // 1B: u8 bool
    ApplyForce = 25,            // 8B: fx(f32) + fy(f32)
    ApplyImpulse = 26,          // 8B: ix(f32) + iy(f32)
    ApplyTorque = 27,           // 4B: f32

    // ── Physics: collider overrides ──
    SetColliderSensor = 28,     // 1B: u8 bool
    SetColliderDensity = 29,    // 4B: f32
    SetColliderRestitution = 30, // 4B: f32
    SetColliderFriction = 31,   // 4B: f32
    SetCollisionGroups = 32,    // 4B: membership(u16) + filter(u16)

    // ── Physics: joints ──
    CreateRevoluteJoint = 33,   // 12B: entity_b(u32) + anchor_a(f32,f32)
    CreatePrismaticJoint = 34,  // 12B: entity_b(u32) + axis(f32,f32)
    CreateFixedJoint = 35,      // 4B: entity_b(u32)
    CreateRopeJoint = 36,       // 8B: entity_b(u32) + max_dist(f32)
    RemoveJoint = 37,           // 0B
    SetJointMotor = 38,         // 8B: target_vel(f32) + max_force(f32)
    SetJointLimits = 39,        // 8B: min(f32) + max(f32)

    // ── Physics: character controller ──
    MoveCharacter = 40,         // 8B: dx(f32) + dy(f32)
    SetCharacterConfig = 41,    // 12B: autostep_h(f32) + max_slope(f32) + snap(f32)
}
```

**Note:** The actual enum values are shifted by +3 from the design doc (14->17, etc.) because the design doc originally counted from 14, but `SetRotation2D = 14`, `SetTransparent = 15`, `SetDepth = 16` already occupy 14-16. The 26 physics commands use **17-41**. Update `from_u8` match arms and `payload_size` match arms accordingly.

**IMPORTANT CORRECTION:** Re-checking `ring_buffer.rs:49-51`, `SetRotation2D = 14`, `SetTransparent = 15`, `SetDepth = 16` already exist. The physics commands start at **17**, not 14. The design doc said 14-39 but that conflicts with existing commands. The correct range is **17-42** (26 commands). Update `MAX_COMMAND_TYPE` to 43.

Update `from_u8()` with all new match arms (17 => Some(Self::CreateRigidBody), etc.).

Update `payload_size()`:
```rust
Self::CreateRigidBody => 1,
Self::DestroyRigidBody | Self::DestroyCollider | Self::RemoveJoint => 0,
Self::CreateCollider => 16, // max: shape_type(1) + 4×f32(16) — use 16 as max
Self::SetLinearDamping | Self::SetAngularDamping | Self::SetGravityScale
| Self::ApplyTorque | Self::SetColliderDensity | Self::SetColliderRestitution
| Self::SetColliderFriction | Self::SetCollisionGroups => 4,
Self::SetCCDEnabled | Self::SetColliderSensor => 1,
Self::ApplyForce | Self::ApplyImpulse | Self::SetJointMotor
| Self::SetJointLimits | Self::MoveCharacter | Self::CreateRopeJoint => 8,
Self::CreateRevoluteJoint | Self::CreatePrismaticJoint | Self::SetCharacterConfig => 12,
Self::CreateFixedJoint => 4,
```

**Step 4: Run tests**

Run: `cargo test -p hyperion-core`
Expected: All tests pass including new physics command tests

**Step 5: Run clippy**

Run: `cargo clippy -p hyperion-core`
Expected: No warnings

**Step 6: Commit**

```bash
git add crates/hyperion-core/src/ring_buffer.rs
git commit -m "feat(#15a): add 26 physics CommandTypes to ring buffer protocol (17-42)"
```

---

### Task 4: Mirror physics CommandTypes in TypeScript ring-buffer.ts

**Files:**
- Modify: `ts/src/ring-buffer.ts:15-54` (CommandType enum + PAYLOAD_SIZES)
- Test: `ts/src/ring-buffer.test.ts`

**Step 1: Write failing test**

Add to `ring-buffer.test.ts`:
```typescript
describe('physics CommandTypes', () => {
  it('should have matching payload sizes for all physics commands', () => {
    // Physics commands 17-42 must all exist and have payload <= 16
    const physicsCommands = [
      CommandType.CreateRigidBody, CommandType.DestroyRigidBody,
      CommandType.CreateCollider, CommandType.DestroyCollider,
      CommandType.SetLinearDamping, CommandType.SetAngularDamping,
      CommandType.SetGravityScale, CommandType.SetCCDEnabled,
      CommandType.ApplyForce, CommandType.ApplyImpulse, CommandType.ApplyTorque,
      CommandType.SetColliderSensor, CommandType.SetColliderDensity,
      CommandType.SetColliderRestitution, CommandType.SetColliderFriction,
      CommandType.SetCollisionGroups,
      CommandType.CreateRevoluteJoint, CommandType.CreatePrismaticJoint,
      CommandType.CreateFixedJoint, CommandType.CreateRopeJoint,
      CommandType.RemoveJoint, CommandType.SetJointMotor, CommandType.SetJointLimits,
      CommandType.MoveCharacter, CommandType.SetCharacterConfig,
    ];
    for (const cmd of physicsCommands) {
      expect(cmd).toBeGreaterThanOrEqual(17);
      expect(cmd).toBeLessThanOrEqual(42);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/ring-buffer.test.ts`
Expected: FAIL — `CommandType.CreateRigidBody` is undefined

**Step 3: Add physics CommandType variants and payload sizes**

In `ring-buffer.ts`, extend the `CommandType` const enum and `PAYLOAD_SIZES`:

```typescript
export const enum CommandType {
  // ... existing 0-16 ...
  SetDepth = 16,

  // Physics: body
  CreateRigidBody = 17,
  DestroyRigidBody = 18,
  CreateCollider = 19,
  DestroyCollider = 20,
  SetLinearDamping = 21,
  SetAngularDamping = 22,
  SetGravityScale = 23,
  SetCCDEnabled = 24,
  ApplyForce = 25,
  ApplyImpulse = 26,
  ApplyTorque = 27,

  // Physics: collider overrides
  SetColliderSensor = 28,
  SetColliderDensity = 29,
  SetColliderRestitution = 30,
  SetColliderFriction = 31,
  SetCollisionGroups = 32,

  // Physics: joints
  CreateRevoluteJoint = 33,
  CreatePrismaticJoint = 34,
  CreateFixedJoint = 35,
  CreateRopeJoint = 36,
  RemoveJoint = 37,
  SetJointMotor = 38,
  SetJointLimits = 39,

  // Physics: character controller
  MoveCharacter = 40,
  SetCharacterConfig = 41,
}
```

Add to `PAYLOAD_SIZES`:
```typescript
[CommandType.CreateRigidBody]: 1,
[CommandType.DestroyRigidBody]: 0,
[CommandType.CreateCollider]: 16,
[CommandType.DestroyCollider]: 0,
[CommandType.SetLinearDamping]: 4,
[CommandType.SetAngularDamping]: 4,
[CommandType.SetGravityScale]: 4,
[CommandType.SetCCDEnabled]: 1,
[CommandType.ApplyForce]: 8,
[CommandType.ApplyImpulse]: 8,
[CommandType.ApplyTorque]: 4,
[CommandType.SetColliderSensor]: 1,
[CommandType.SetColliderDensity]: 4,
[CommandType.SetColliderRestitution]: 4,
[CommandType.SetColliderFriction]: 4,
[CommandType.SetCollisionGroups]: 4,
[CommandType.CreateRevoluteJoint]: 12,
[CommandType.CreatePrismaticJoint]: 12,
[CommandType.CreateFixedJoint]: 4,
[CommandType.CreateRopeJoint]: 8,
[CommandType.RemoveJoint]: 0,
[CommandType.SetJointMotor]: 8,
[CommandType.SetJointLimits]: 8,
[CommandType.MoveCharacter]: 8,
[CommandType.SetCharacterConfig]: 12,
```

**Step 4: Run tests**

Run: `cd ts && npx vitest run src/ring-buffer.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add ts/src/ring-buffer.ts ts/src/ring-buffer.test.ts
git commit -m "feat(#15a): mirror 26 physics CommandTypes in TypeScript ring-buffer"
```

---

### Task 5: Update BackpressuredProducer with isNonCoalescable

**Files:**
- Modify: `ts/src/backpressure.ts:24` (MAX_COMMAND_TYPE)
- Modify: `ts/src/backpressure.ts:35-47` (enqueue logic)
- Test: `ts/src/backpressure.test.ts`

**Step 1: Write failing test — ApplyForce is non-coalescable**

Add to `backpressure.test.ts`:
```typescript
describe('physics command coalescing', () => {
  it('should NOT coalesce ApplyForce (both forces must execute)', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.ApplyForce, 1, new Float32Array([0, 100]));
    queue.enqueue(CommandType.ApplyForce, 1, new Float32Array([0, 100]));
    expect(queue.criticalCount).toBe(2); // Both in critical queue
  });

  it('should coalesce SetGravityScale (last-write-wins)', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.SetGravityScale, 1, new Float32Array([1.0]));
    queue.enqueue(CommandType.SetGravityScale, 1, new Float32Array([2.0]));
    expect(queue.overwriteCount).toBe(1); // Coalesced to one
  });

  it('should treat CreateRigidBody as critical', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.CreateRigidBody, 1, new Uint8Array([0]));
    expect(queue.criticalCount).toBe(1);
  });

  it('should purge physics overrides on DespawnEntity', () => {
    const queue = new PrioritizedCommandQueue();
    queue.enqueue(CommandType.SetGravityScale, 5, new Float32Array([2.0]));
    queue.enqueue(CommandType.SetLinearDamping, 5, new Float32Array([0.5]));
    expect(queue.overwriteCount).toBe(2);
    queue.enqueue(CommandType.DespawnEntity, 5);
    expect(queue.overwriteCount).toBe(0); // Purged
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/backpressure.test.ts`
Expected: FAIL — ApplyForce ends up in overwrites (only 1 entry), not critical (2 entries)

**Step 3: Update MAX_COMMAND_TYPE and enqueue logic**

In `backpressure.ts`:

Line 24: Change `MAX_COMMAND_TYPE` from 17 to 43.

Replace the `enqueue` method body (line 35-47):
```typescript
enqueue(cmd: CommandType, entityId: number, payload?: Float32Array | Uint8Array): void {
  if (isNonCoalescable(cmd)) {
    if (cmd === CommandType.DespawnEntity) {
      this.purgeEntity(entityId);
    }
    this.critical.push({ cmd, entityId, payload });
  } else {
    const key = entityId * 256 + cmd;
    if (this.overwrites.has(key)) {
      this._coalescedCount++;
    }
    this.overwrites.set(key, { cmd, entityId, payload });
  }
}
```

Add helper function before the class:
```typescript
/**
 * Returns true for commands that must NOT be coalesced (last-write-wins).
 * - Lifecycle: SpawnEntity, DespawnEntity
 * - Physics create/destroy: CreateRigidBody, DestroyRigidBody, Create/DestroyCollider
 * - Physics additive: ApplyForce, ApplyImpulse, ApplyTorque
 * - Physics joints: Create*, RemoveJoint
 * - Physics movement: MoveCharacter
 */
function isNonCoalescable(cmd: CommandType): boolean {
  if (cmd === CommandType.SpawnEntity || cmd === CommandType.DespawnEntity) return true;
  if (cmd >= CommandType.CreateRigidBody && cmd <= CommandType.DestroyCollider) return true;
  if (cmd >= CommandType.ApplyForce && cmd <= CommandType.ApplyTorque) return true;
  if (cmd >= CommandType.CreateRevoluteJoint && cmd <= CommandType.RemoveJoint) return true;
  if (cmd === CommandType.MoveCharacter) return true;
  return false;
}
```

**Step 4: Run tests**

Run: `cd ts && npx vitest run src/backpressure.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add ts/src/backpressure.ts ts/src/backpressure.test.ts
git commit -m "feat(#15a): isNonCoalescable for physics commands in BackpressuredProducer"
```

---

### Task 6: Add physics feature flag and rapier2d dependency to hyperion-core

**Files:**
- Modify: `crates/hyperion-core/Cargo.toml`
- Create: `crates/hyperion-core/src/physics.rs`
- Modify: `crates/hyperion-core/src/lib.rs:1-10` (add module)

**Step 1: Add rapier2d dependency and feature flags**

In `crates/hyperion-core/Cargo.toml`:
```toml
[features]
default = []
dev-tools = []
physics-2d = ["dep:rapier2d"]

[dependencies]
wasm-bindgen = "0.2"
glam = { version = "0.29", features = ["bytemuck"] }
hecs = "0.11"
bytemuck = { version = "1", features = ["derive"] }
rapier2d = { version = "0.32", features = ["simd-stable", "wasm-bindgen"], optional = true }
```

**Step 2: Create physics.rs module stub**

```rust
//! Rapier2D physics integration.
//!
//! All types and functions in this module are behind `#[cfg(feature = "physics-2d")]`.

#[cfg(feature = "physics-2d")]
pub mod types {
    /// Pending rigid body creation. Accumulates override commands before
    /// physics_sync_pre() creates the actual Rapier body.
    pub struct PendingRigidBody {
        pub body_type: u8,          // 0=dynamic, 1=fixed, 2=kinematic
        pub gravity_scale: f32,
        pub linear_damping: f32,
        pub angular_damping: f32,
        pub ccd_enabled: bool,
    }

    impl Default for PendingRigidBody {
        fn default() -> Self {
            Self {
                body_type: 0,
                gravity_scale: 1.0,
                linear_damping: 0.0,
                angular_damping: 0.0,
                ccd_enabled: false,
            }
        }
    }

    impl PendingRigidBody {
        pub fn new(body_type: u8) -> Self {
            Self { body_type, ..Default::default() }
        }
    }

    /// Pending collider creation. Consumed in physics_sync_pre().
    pub struct PendingCollider {
        pub shape_type: u8,
        pub shape_params: [f32; 4],
        pub density: f32,
        pub restitution: f32,
        pub friction: f32,
        pub is_sensor: bool,
        pub groups: u32,
    }

    impl Default for PendingCollider {
        fn default() -> Self {
            Self {
                shape_type: 0,
                shape_params: [0.0; 4],
                density: 1.0,
                restitution: 0.0,
                friction: 0.5,
                is_sensor: false,
                groups: 0xFFFF_FFFF,
            }
        }
    }

    impl PendingCollider {
        pub fn new(shape_type: u8, params: [f32; 4]) -> Self {
            Self { shape_type, shape_params: params, ..Default::default() }
        }
    }

    /// Handle to a live Rapier RigidBody.
    pub struct PhysicsBodyHandle(pub rapier2d::prelude::RigidBodyHandle);

    /// Handle to a live Rapier Collider.
    pub struct PhysicsColliderHandle(pub rapier2d::prelude::ColliderHandle);

    /// Marker: entity position/rotation driven by Rapier. velocity_system skips these.
    pub struct PhysicsControlled;
}

#[cfg(feature = "physics-2d")]
pub use types::*;

#[cfg(feature = "physics-2d")]
#[cfg(test)]
mod tests {
    use super::types::*;

    #[test]
    fn pending_rigid_body_defaults() {
        let pending = PendingRigidBody::default();
        assert_eq!(pending.body_type, 0);
        assert_eq!(pending.gravity_scale, 1.0);
        assert_eq!(pending.linear_damping, 0.0);
        assert_eq!(pending.angular_damping, 0.0);
        assert!(!pending.ccd_enabled);
    }

    #[test]
    fn pending_collider_defaults() {
        let pending = PendingCollider::default();
        assert_eq!(pending.shape_type, 0);
        assert_eq!(pending.density, 1.0);
        assert_eq!(pending.restitution, 0.0);
        assert!((pending.friction - 0.5).abs() < f32::EPSILON);
        assert!(!pending.is_sensor);
        assert_eq!(pending.groups, 0xFFFF_FFFF);
    }

    #[test]
    fn pending_rigid_body_new_sets_body_type() {
        let pending = PendingRigidBody::new(1); // fixed
        assert_eq!(pending.body_type, 1);
        assert_eq!(pending.gravity_scale, 1.0); // other fields default
    }
}
```

**Step 3: Register module in lib.rs**

Add after line 10 of `crates/hyperion-core/src/lib.rs`:
```rust
#[cfg(feature = "physics-2d")]
pub mod physics;
```

**Step 4: Verify both builds compile**

Run:
```bash
cargo check -p hyperion-core
cargo check -p hyperion-core --features physics-2d
```
Expected: Both compile

**Step 5: Run tests with feature**

Run: `cargo test -p hyperion-core --features physics-2d`
Expected: All existing tests pass + 3 new physics tests pass

**Step 6: Run clippy**

Run: `cargo clippy -p hyperion-core --features physics-2d`
Expected: No warnings

**Step 7: Commit**

```bash
git add crates/hyperion-core/Cargo.toml crates/hyperion-core/src/physics.rs crates/hyperion-core/src/lib.rs
git commit -m "feat(#15a): physics-2d feature flag + PendingRigidBody/Collider types"
```

---

### Task 7: Add physics WASM build script to package.json

**Files:**
- Modify: `ts/package.json:6-12` (add build:wasm:physics script)

**Step 1: Add build:wasm:physics script**

Add to `ts/package.json` scripts section:
```json
"build:wasm:physics": "wasm-pack build ../crates/hyperion-core --target web --out-dir ../../ts/wasm-physics -- --features physics-2d",
"build:wasm:physics:release": "npm run build:wasm:physics && wasm-opt -O3 --strip-debug --enable-simd wasm-physics/hyperion_core_bg.wasm -o wasm-physics/hyperion_core_bg.wasm"
```

**Step 2: Add wasm-physics to .gitignore**

Append to `.gitignore`:
```
ts/wasm-physics/
```

**Step 3: Verify dual build works**

Run:
```bash
cd ts && npm run build:wasm
cd ts && npm run build:wasm:physics
```
Expected: Two WASM artifacts produced. Compare sizes.

**Step 4: Commit**

```bash
git add ts/package.json .gitignore
git commit -m "feat(#15a): dual WASM build pipeline (with/without physics)"
```

---

### Task 8: Add physics producer methods to BackpressuredProducer

**Files:**
- Modify: `ts/src/backpressure.ts:138-243` (add methods after setDepth)
- Test: `ts/src/backpressure.test.ts`

**Step 1: Write failing test**

Add to `backpressure.test.ts`:
```typescript
describe('physics producer methods', () => {
  it('should serialize createRigidBody', () => {
    // Verify the method exists and enqueues correctly
    const sab = new SharedArrayBuffer(1024 + 32);
    const rb = new RingBufferProducer(sab);
    const bp = new BackpressuredProducer(rb);
    expect(bp.createRigidBody(1, 0)).toBe(true); // dynamic
    expect(bp.pendingCount).toBe(1);
  });

  it('should serialize createCollider with circle shape', () => {
    const sab = new SharedArrayBuffer(1024 + 32);
    const rb = new RingBufferProducer(sab);
    const bp = new BackpressuredProducer(rb);
    expect(bp.createCollider(1, 0, 16.0)).toBe(true); // circle, radius 16
    expect(bp.pendingCount).toBe(1);
  });

  it('should serialize applyForce', () => {
    const sab = new SharedArrayBuffer(1024 + 32);
    const rb = new RingBufferProducer(sab);
    const bp = new BackpressuredProducer(rb);
    bp.applyForce(1, 100, 200);
    bp.applyForce(1, 50, 0);
    expect(bp.pendingCount).toBe(2); // NOT coalesced
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/backpressure.test.ts`
Expected: FAIL — `bp.createRigidBody is not a function`

**Step 3: Add physics producer methods**

Add to `BackpressuredProducer` class after `setDepth()`:

```typescript
// ── Physics: body ──

createRigidBody(entityId: number, bodyType: number): boolean {
  return this.writeCommand(CommandType.CreateRigidBody, entityId, new Uint8Array([bodyType & 0xFF]));
}

destroyRigidBody(entityId: number): boolean {
  return this.writeCommand(CommandType.DestroyRigidBody, entityId);
}

createCollider(entityId: number, shapeType: number, ...params: number[]): boolean {
  const buf = new Float32Array(4);
  const u8 = new Uint8Array(buf.buffer);
  u8[0] = shapeType & 0xFF;
  // Pack shape params starting at byte 1 (aligned to byte, not f32)
  // Use DataView for precise byte-level control
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < Math.min(params.length, 3); i++) {
    dv.setFloat32(1 + i * 4, params[i], true);
  }
  return this.writeCommand(CommandType.CreateCollider, entityId, u8.slice(0, 1 + params.length * 4));
}

destroyCollider(entityId: number): boolean {
  return this.writeCommand(CommandType.DestroyCollider, entityId);
}

setLinearDamping(entityId: number, damping: number): boolean {
  return this.writeCommand(CommandType.SetLinearDamping, entityId, new Float32Array([damping]));
}

setAngularDamping(entityId: number, damping: number): boolean {
  return this.writeCommand(CommandType.SetAngularDamping, entityId, new Float32Array([damping]));
}

setGravityScale(entityId: number, scale: number): boolean {
  return this.writeCommand(CommandType.SetGravityScale, entityId, new Float32Array([scale]));
}

setCCDEnabled(entityId: number, enabled: boolean): boolean {
  return this.writeCommand(CommandType.SetCCDEnabled, entityId, new Uint8Array([enabled ? 1 : 0]));
}

applyForce(entityId: number, fx: number, fy: number): boolean {
  return this.writeCommand(CommandType.ApplyForce, entityId, new Float32Array([fx, fy]));
}

applyImpulse(entityId: number, ix: number, iy: number): boolean {
  return this.writeCommand(CommandType.ApplyImpulse, entityId, new Float32Array([ix, iy]));
}

applyTorque(entityId: number, torque: number): boolean {
  return this.writeCommand(CommandType.ApplyTorque, entityId, new Float32Array([torque]));
}

// ── Physics: collider overrides ──

setColliderSensor(entityId: number, sensor: boolean): boolean {
  return this.writeCommand(CommandType.SetColliderSensor, entityId, new Uint8Array([sensor ? 1 : 0]));
}

setColliderDensity(entityId: number, density: number): boolean {
  return this.writeCommand(CommandType.SetColliderDensity, entityId, new Float32Array([density]));
}

setColliderRestitution(entityId: number, restitution: number): boolean {
  return this.writeCommand(CommandType.SetColliderRestitution, entityId, new Float32Array([restitution]));
}

setColliderFriction(entityId: number, friction: number): boolean {
  return this.writeCommand(CommandType.SetColliderFriction, entityId, new Float32Array([friction]));
}

setCollisionGroups(entityId: number, membership: number, filter: number): boolean {
  const buf = new Uint8Array(4);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, membership & 0xFFFF, true);
  dv.setUint16(2, filter & 0xFFFF, true);
  return this.writeCommand(CommandType.SetCollisionGroups, entityId, buf);
}

// ── Physics: joints ──

createRevoluteJoint(entityId: number, targetEntityId: number, anchorAx: number, anchorAy: number): boolean {
  const buf = new ArrayBuffer(12);
  const dv = new DataView(buf);
  dv.setUint32(0, targetEntityId, true);
  dv.setFloat32(4, anchorAx, true);
  dv.setFloat32(8, anchorAy, true);
  return this.writeCommand(CommandType.CreateRevoluteJoint, entityId, new Uint8Array(buf));
}

createPrismaticJoint(entityId: number, targetEntityId: number, axisX: number, axisY: number): boolean {
  const buf = new ArrayBuffer(12);
  const dv = new DataView(buf);
  dv.setUint32(0, targetEntityId, true);
  dv.setFloat32(4, axisX, true);
  dv.setFloat32(8, axisY, true);
  return this.writeCommand(CommandType.CreatePrismaticJoint, entityId, new Uint8Array(buf));
}

createFixedJoint(entityId: number, targetEntityId: number): boolean {
  const p = new Float32Array(1);
  new Uint32Array(p.buffer)[0] = targetEntityId;
  return this.writeCommand(CommandType.CreateFixedJoint, entityId, p);
}

createRopeJoint(entityId: number, targetEntityId: number, maxDist: number): boolean {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, targetEntityId, true);
  dv.setFloat32(4, maxDist, true);
  return this.writeCommand(CommandType.CreateRopeJoint, entityId, new Uint8Array(buf));
}

removeJoint(entityId: number): boolean {
  return this.writeCommand(CommandType.RemoveJoint, entityId);
}

setJointMotor(entityId: number, targetVel: number, maxForce: number): boolean {
  return this.writeCommand(CommandType.SetJointMotor, entityId, new Float32Array([targetVel, maxForce]));
}

setJointLimits(entityId: number, min: number, max: number): boolean {
  return this.writeCommand(CommandType.SetJointLimits, entityId, new Float32Array([min, max]));
}

// ── Physics: character controller ──

moveCharacter(entityId: number, dx: number, dy: number): boolean {
  return this.writeCommand(CommandType.MoveCharacter, entityId, new Float32Array([dx, dy]));
}

setCharacterConfig(entityId: number, autostepHeight: number, maxSlope: number, snapToGround: number): boolean {
  return this.writeCommand(CommandType.SetCharacterConfig, entityId, new Float32Array([autostepHeight, maxSlope, snapToGround]));
}
```

**Step 4: Run tests**

Run: `cd ts && npx vitest run src/backpressure.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add ts/src/backpressure.ts ts/src/backpressure.test.ts
git commit -m "feat(#15a): physics producer methods on BackpressuredProducer"
```

---

## Milestones 15b-15h: Detailed Plans

> **Note:** Tasks 9+ (milestones 15b through 15h) should be planned in detail AFTER the spike validates and the design doc is updated with real numbers. The spike may reveal API differences that change the implementation details.
>
> The high-level scope for each milestone is documented in `docs/plans/2026-03-07-phase15-physics-rapier2d-design.md` section 14.
>
> When ready to plan the next milestone, use the brainstorming skill to create a milestone-specific plan based on spike results.

### Milestone 15b Preview (Core Simulation)

Key tasks (to be expanded post-spike):
- Task 9: PhysicsWorld struct in physics.rs
- Task 10: physics_sync_pre (Pending -> Rapier bodies)
- Task 11: physics_sync_post dual-path (Transform2D + Position/Rotation)
- Task 12: Physics command routing in command_processor.rs
- Task 13: DirtyTracker extension in mark_post_system_dirty
- Task 14: velocity_system skip for PhysicsControlled
- Task 15: Despawn cleanup hook (remove Rapier body before world.despawn)
- Task 16: Tick loop integration in engine.rs
- Task 17: EntityHandle fluent API (.rigidBody(), .collider(), etc.)
- Task 18: WASM exports for physics state

### Milestone 15c Preview (Events & Scene Queries)

- Task 19: HyperionCollisionEvent/ContactForceEvent structs
- Task 20: ChannelEventCollector wiring + mpsc drain
- Task 21: collider_to_entity reverse map
- Task 22: WASM exports (ptr/count)
- Task 23: Worker event reading (Mode B/C)
- Task 24: PhysicsAPI callbacks in TS
- Task 25: Raycast via ephemeral QueryPipeline
- Task 26: Overlap AABB query
- Task 27: On-demand contact info

### Milestone 15d-15h Previews

See design doc section 14 for scope of each milestone.
