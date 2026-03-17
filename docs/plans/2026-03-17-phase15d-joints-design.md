# Phase 15d: Joints — Design Document

**Date:** 2026-03-17
**Prerequisite:** Phase 15c (Events & Scene Queries) complete
**Scope:** Joint constraints (Revolute, Prismatic, Fixed, Rope, Spring) with handle-based lifecycle
**Deferred:** Character Controller → Phase 15e (CommandTypes 44-45)

---

## 1. Command Protocol

### 1.1 CommandType Allocation (33-43)

All 11 joint commands are **non-coalescable**. The entity-based coalescing key (`entityId * 256 + cmdType`) cannot distinguish between multiple joints on the same entity, so coalescing would silently drop commands. See §1.3.

| ID | Command | Payload | Bytes |
|----|---------|---------|-------|
| 33 | `CreateRevoluteJoint` | joint_id(u32) + entity_b(u32) + anchor_ax(f32) + anchor_ay(f32) | 16 |
| 34 | `CreatePrismaticJoint` | joint_id(u32) + entity_b(u32) + axis_x(f32) + axis_y(f32) | 16 |
| 35 | `CreateFixedJoint` | joint_id(u32) + entity_b(u32) | 8 |
| 36 | `CreateRopeJoint` | joint_id(u32) + entity_b(u32) + max_dist(f32) | 12 |
| 37 | `RemoveJoint` | joint_id(u32) | 4 |
| 38 | `SetJointMotor` | joint_id(u32) + target_vel(f32) + max_force(f32) | 12 |
| 39 | `SetJointLimits` | joint_id(u32) + min(f32) + max(f32) | 12 |
| 40 | `CreateSpringJoint` | joint_id(u32) + entity_b(u32) + rest_length(f32) | 12 |
| 41 | `SetSpringParams` | joint_id(u32) + stiffness(f32) + damping(f32) | 12 |
| 42 | `SetJointAnchorB` | joint_id(u32) + bx(f32) + by(f32) | 12 |
| 43 | `SetJointAnchorA` | joint_id(u32) + ax(f32) + ay(f32) | 12 |

### 1.2 Breaking Protocol Changes (Prerequisite)

This phase introduces **handle-based joint lifecycle** (`joint_id` in every payload). The 15a scaffolding defined commands 33-39 without `joint_id` — all payload sizes change. This is a **breaking protocol change** to the wire format.

**Payload size changes (33-39, scaffolded in 15a → redefined in 15d):**

| ID | Command | 15a Payload (old) | 15d Payload (new) | Delta |
|----|---------|-------------------|-------------------|-------|
| 33 | `CreateRevoluteJoint` | 12B: entity_b + anchor_a(×2) | 16B: +joint_id | +4B |
| 34 | `CreatePrismaticJoint` | 12B: entity_b + axis(×2) | 16B: +joint_id | +4B |
| 35 | `CreateFixedJoint` | 4B: entity_b | 8B: +joint_id | +4B |
| 36 | `CreateRopeJoint` | 8B: entity_b + max_dist | 12B: +joint_id | +4B |
| 37 | `RemoveJoint` | 0B (entity-based) | 4B: joint_id (handle-based) | +4B |
| 38 | `SetJointMotor` | 8B: target_vel + max_force | 12B: +joint_id | +4B |
| 39 | `SetJointLimits` | 8B: min + max | 12B: +joint_id | +4B |

**Slot rislottamento (40-41):**

`MoveCharacter=40` and `SetCharacterConfig=41` from 15a are **removed** and re-scaffolded at 44-45 in Phase 15e. Their producer methods (`moveCharacter()`, `setCharacterConfig()`) are deleted.

**`isNonCoalescable` update:**

The current codebase already marks 33-37 as non-coalescable and `MoveCharacter=40` as non-coalescable. This phase:
- Extends the range from 33-37 to **33-43** (adding 38-43)
- Removes the `MoveCharacter=40` check (slot reassigned to `CreateSpringJoint`)

**Synchronized change across 4 files:**

- `crates/hyperion-core/src/ring_buffer.rs` — CommandType enum + `from_u8()` + `payload_size()` (update 33-39 sizes, reslot 40-41, add 42-43)
- `ts/src/ring-buffer.ts` — CommandType const enum + PAYLOAD_SIZES (same changes)
- `ts/src/backpressure.ts` — remove `moveCharacter()`/`setCharacterConfig()`, add 11 joint methods, update `isNonCoalescable()` from 33-37 to 33-43
- CLAUDE.md — CommandType documentation, `MAX_COMMAND_TYPE` (stale "17" reference → 44)

### 1.3 Coalescing Rationale

All joint commands (33-43) are non-coalescable because the coalescing key is `entityId * 256 + cmdType`. For joint commands, `entityId` in the ring buffer header is `entity_a`. If an entity has two joints and the same `cmdType` fires for both in the same frame:

```
setJointMotor(jointA, 5.0, 100.0)  // entity_a=42, cmdType=38, key=42*256+38
setJointMotor(jointB, 3.0, 50.0)   // entity_a=42, cmdType=38, key=42*256+38 ← SAME KEY
```

The first command is silently overwritten. Making all joint commands non-coalescable eliminates this class of bugs. The cost is negligible — Set commands on the same joint in the same frame are rare, and Rapier handles last-write-wins naturally.

If profiling ever shows issues, a future joint-aware coalescing key (`jointId * 256 + cmdType`) could be introduced. Not needed for 15d.

### 1.4 Ring Buffer Header

For Create commands: `entity_id` in the header = `entity_a` (the "owner" entity).
For Set/Remove commands: `entity_id` = `entity_a` (used for routing only; `joint_id` in the payload is the true key). For `RemoveJoint` specifically, `entity_id` is populated from `JointHandle._entityA` for routing consistency. The `joint_id` in the payload is the authoritative key — the header `entity_id` is not used for the remove operation itself.

### 1.5 Defaults

When not overridden by Set commands:

- `anchor_a`: (0,0) for all joint types except `CreateRevoluteJoint` (which carries it in the Create payload)
- `anchor_b`: (0,0) for all joint types
- `stiffness`: Rapier default (spring joints) — spike-verify if zero; if so, set sensible defaults (e.g., 1.0)
- `damping`: Rapier default (spring joints) — spike-verify if zero; if so, set sensible defaults (e.g., 0.1)
- `motor`: none (Rapier default)
- `limits`: none (Rapier default, unconstrained)

### 1.6 MAX_COMMAND_TYPE

Updated from 42 to **44**. Character Controller (15e) starts at 44.

---

## 2. Rust Data Structures

### 2.1 JointEntry

```rust
// physics.rs
pub struct JointEntry {
    pub handle: ImpulseJointHandle,
    pub entity_a: u32,  // external ID
    pub entity_b: u32,  // external ID
}
```

Stores both external IDs for:
- **Deterministic cleanup**: `retain()` by entity ID, not arena handle validity check. Avoids theoretical generational arena wrap-around issues.
- **Debug rendering**: Future 15f can draw joint debug lines without querying Rapier for endpoints.
- **Cost**: 8 bytes extra per entry. 200 joints = 1.6KB. Negligible.

### 2.2 PendingJoint Staging

```rust
pub enum PendingJointType {
    Revolute { anchor_ax: f32, anchor_ay: f32 },
    Prismatic { axis_x: f32, axis_y: f32 },
    Fixed,
    Rope { max_dist: f32 },
    Spring { rest_length: f32 },
}

pub struct PendingJoint {
    pub joint_id: u32,
    pub entity_a_ext: u32,
    pub entity_b_ext: u32,
    pub joint_type: PendingJointType,
}
```

Staged in `PhysicsWorld::pending_joints: Vec<PendingJoint>` (not as an ECS component). Rationale:
- An entity can have N joints (unlike PendingRigidBody which is 1:1)
- A `Vec<PendingJoint>` component would be non-Pod, breaking the `#[repr(C)]` convention
- Centralized staging is consistent with PhysicsWorld owning all physics state

### 2.3 PhysicsWorld Changes

```rust
pub struct PhysicsWorld {
    // ... existing fields (body_set, collider_set, impulse_joint_set, etc.) ...
    pub joint_map: HashMap<u32, JointEntry>,    // joint_id → entry
    pub pending_joints: Vec<PendingJoint>,       // consumed in physics_sync_pre
}
```

### 2.4 Command Routing

Two routing layers (same pattern as 15b):

1. **`process_single_command_physics`** (command_processor.rs, `#[cfg(feature = "physics-2d")]`):
   Intercepts Create commands (33-36, 40) → `physics_world.pending_joints.push(...)`.

2. **`process_physics_commands`** (physics_commands.rs):
   Handles live-joint commands (37-39, 41-43) that require an existing `JointEntry` in `joint_map`.
   - `RemoveJoint`: `joint_map.remove(joint_id)` → `impulse_joint_set.remove(entry.handle, true)`
   - `SetJointMotor/Limits/SpringParams/AnchorA/AnchorB`: `joint_map.get(joint_id)` → `impulse_joint_set.get_mut(entry.handle)` → Rapier API call

### 2.5 physics_sync_pre — Joint Consumption

Added as **step 4**, after body consumption (step 1), collider consumption (step 2), and kinematic sync (step 3). Never interleaved — all bodies and colliders must exist in Rapier before any joint references them.

```
for pending in physics_world.pending_joints.drain(..) {
    1. EntityMap lookup: entity_a_ext → hecs Entity → PhysicsBodyHandle → RigidBodyHandle
    2. EntityMap lookup: entity_b_ext → hecs Entity → PhysicsBodyHandle → RigidBodyHandle
    3. If either lookup fails: warn + skip (entity despawned in same frame)
    4. Build joint via RevoluteJointBuilder / PrismaticJointBuilder / etc.
    5. impulse_joint_set.insert(handle_a, handle_b, joint)  // spike-verify: 3 or 4 args (wake_up bool may not exist for joints)
    6. joint_map.insert(joint_id, JointEntry { handle, entity_a, entity_b })
}
```

**Ordering guarantee**: Same-frame spawn + joint creation works because step 1 processes ALL PendingRigidBody before step 4 processes pending_joints. hecs query iteration order within step 1 is non-deterministic, but that doesn't matter — all bodies exist by the time step 4 runs.

### 2.6 Cleanup

**Explicit removal (RemoveJoint command):**
```rust
if let Some(entry) = self.joint_map.remove(&joint_id) {
    self.impulse_joint_set.remove(entry.handle, true);
}
```

**Cascade cleanup (entity despawn):**
After `rigid_body_set.remove()` (which internally cascade-deletes joints from Rapier):
```rust
self.joint_map.retain(|_, entry| {
    entry.entity_a != despawned_ext_id && entry.entity_b != despawned_ext_id
});
```

**Double removal safety**: `RemoveJoint` then `DespawnEntity` on the same joint:
1. RemoveJoint → `joint_map.remove(joint_id)` + `impulse_joint_set.remove(handle, true)` (removes Rapier joint AND internal body references)
2. DespawnEntity → `rigid_body_set.remove()` cascade iterates body's joints — the joint is already gone from the body's internal list, so cascade is a no-op for that joint
3. `joint_map.retain()` — the entry was already removed in step 1, so retain finds nothing to remove

This must be spike-verified (test 12 in §5).

---

## 3. TypeScript API

### 3.1 JointHandle

```typescript
// physics-api.ts
export interface JointHandle {
    readonly __brand: 'JointHandle';
    readonly _jointId: number;   // monotonic, goes into payload
    readonly _entityA: number;   // external ID, goes into ring buffer header
}
```

Opaque to the user. The producer uses `_entityA` for the ring buffer header and `_jointId` for the payload.

**GC pressure**: JointHandle is an object allocation, but joint Create/Remove are not hot path (setup-time, not per-frame). If profiling shows GC pressure, escape hatch: pack `entityA` (20 bits) + `jointId` (12 bits) into a single number. Not needed for 15d.

### 3.2 BackpressuredProducer

```typescript
// backpressure.ts
private _nextJointId = 1;  // monotonic, 0 reserved as sentinel

// Create methods — return JointHandle
createRevoluteJoint(entityA: number, entityB: number,
                    anchorAx: number, anchorAy: number): JointHandle
createPrismaticJoint(entityA: number, entityB: number,
                     axisX: number, axisY: number): JointHandle
createFixedJoint(entityA: number, entityB: number): JointHandle
createRopeJoint(entityA: number, entityB: number, maxDist: number): JointHandle
createSpringJoint(entityA: number, entityB: number, restLength: number): JointHandle

// Set/Remove — take JointHandle
removeJoint(joint: JointHandle): void
setJointMotor(joint: JointHandle, targetVel: number, maxForce: number): void
setJointLimits(joint: JointHandle, min: number, max: number): void
setSpringParams(joint: JointHandle, stiffness: number, damping: number): void
setJointAnchorA(joint: JointHandle, ax: number, ay: number): void
setJointAnchorB(joint: JointHandle, bx: number, by: number): void
```

### 3.3 EntityHandle Fluent API

```typescript
// entity-handle.ts

/** Create a revolute (pin) joint. `this` = entityA, `target` = entityB.
 *  anchorA = offset on this entity, anchorB = offset on target (default 0,0).
 *  Returns JointHandle (not chainable — you need the handle for motor/limits). */
revoluteJoint(target: EntityHandle, opts?: { anchorAx?: number, anchorAy?: number }): JointHandle

prismaticJoint(target: EntityHandle, opts?: { axisX?: number, axisY?: number }): JointHandle
fixedJoint(target: EntityHandle): JointHandle
ropeJoint(target: EntityHandle, maxDist: number): JointHandle
springJoint(target: EntityHandle, restLength: number): JointHandle
```

**Returns `JointHandle`, not `this`** — unlike `.rigidBody()/.collider()` which are one-shot setup. The user needs the handle for `setJointMotor()` etc.

**Convention**: `this` = entity_a (anchor_a refers to this entity), `target` = entity_b (anchor_b refers to target). Documented via JSDoc.

### 3.4 PhysicsAPI

```typescript
// physics-api.ts — convenience methods delegating to BackpressuredProducer
removeJoint(joint: JointHandle): void
setJointMotor(joint: JointHandle, targetVel: number, maxForce: number): void
setJointLimits(joint: JointHandle, min: number, max: number): void
setSpringParams(joint: JointHandle, stiffness: number, damping: number): void
setJointAnchorA(joint: JointHandle, ax: number, ay: number): void
setJointAnchorB(joint: JointHandle, bx: number, by: number): void
```

### 3.5 isNonCoalescable Update

```typescript
function isNonCoalescable(cmdType: number): boolean {
    // ... existing checks (17-20, 25-27) ...

    // Joint commands (33-43) — ALL non-coalescable.
    // Entity-based coalescing key doesn't work for joints:
    // same entity with two joints + same cmdType = same key = silent overwrite.
    // Character Controller (15e) starts at 44 — do not extend this range.
    if (cmdType >= 33 && cmdType <= 43) return true;

    return false;
}
```

### 3.6 Barrel Exports (index.ts)

```typescript
export { JointHandle } from './physics-api';
```

### 3.7 Usage Example

```typescript
const chassis = engine.spawn()
    .position(200, 100, 0)
    .rigidBody('dynamic')
    .collider('box', { hx: 30, hy: 10 });

const wheel = engine.spawn()
    .position(180, 120, 0)
    .rigidBody('dynamic')
    .collider('circle', { radius: 8 });

// wheel (this/entityA) ←→ chassis (target/entityB)
const axle = wheel.revoluteJoint(chassis, { anchorAx: 0, anchorAy: 0 });
// anchorA = offset on wheel, anchorB = offset on chassis (default 0,0)

engine.physics.setJointMotor(axle, 5.0, 100.0);
engine.physics.setJointLimits(axle, -Math.PI / 4, Math.PI / 4);

// Custom anchor on chassis (not at center):
engine.physics.setJointAnchorB(axle, -20, 10);

// Spring connection:
const spring = wheel.springJoint(chassis, 50.0);
engine.physics.setSpringParams(spring, 100.0, 5.0);

// Later:
engine.physics.removeJoint(axle);
engine.physics.removeJoint(spring);
```

---

## 4. Errata & Spike Verification

### 4.1 Cumulative Errata (from 15b/15c)

| Topic | Design Doc Says | Reality (Rapier 0.32) | Status |
|-------|----------------|----------------------|--------|
| `step()` signature | `&gravity` | gravity by VALUE, 12 params | Fixed in 15b |
| QueryPipeline | Stored field | Ephemeral via `broad_phase.as_query_pipeline()` | Fixed in 15b |
| InteractionGroups | 2 args | 3 args (+InteractionTestMode) | Fixed in 15b |
| Torque method | `apply_torque` | `apply_torque_impulse` / `add_torque` | Fixed in 15b |
| `body.translation()` | — | Returns `&Vec2` (glam 0.30) | Known |
| Glam version | Same | rapier2d=0.30, hyperion-core=0.29 | Workaround: `rapier2d::math::Vector` |
| CommandTypes range | 14-39 | 17-41 (15a), now 33-43 (15d joints) | Updated |
| Joint anchors | `point![x,y]` | `point![x,y].into()` (nalgebra→glam) | For 15d |

### 4.2 Spike Pre-Implementation Checklist

All hard blockers must be verified before writing any implementation code.

| # | Verify | Blocker | Method |
|---|--------|---------|--------|
| 1 | `JointAxis::AngZ` exists in rapier2d 0.32 | **Hard** | Compile test in rapier-spike |
| 2 | `joint.data.set_motor_velocity(JointAxis::AngZ, vel, damping)` signature | **Hard** | Compile test |
| 3 | `joint.data.set_limits(JointAxis::AngZ, [min, max])` signature | **Hard** | Compile test |
| 4 | `joint.data.set_local_anchor1(point)` / `set_local_anchor2(point)` exist | **Hard** | Compile test |
| 5 | `impulse_joint_set.insert(body_a, body_b, joint, wake_up)` — 3 or 4 args | **Hard** | Compile test |
| 6 | `impulse_joint_set.remove(handle, wake_up)` + body cascade = no panic | Medium | Runtime test |
| 7 | `SpringJointBuilder::new(rest_length)` exists in rapier2d 0.32 | Medium | Compile test |
| 8 | `SpringJointBuilder` default stiffness/damping values — if zero, set sensible defaults | Medium | Runtime test |

If any hard blocker fails, the affected Set command's Rapier API call must be adapted before implementation.

---

## 5. Test Plan

### 5.1 Rust Tests (~13 tests, `#[cfg(feature = "physics-2d")]`)

| # | Test | Location | Verifies |
|---|------|----------|----------|
| 1 | `joint_entry_creation` | physics.rs | JointEntry struct fields correct |
| 2 | `pending_joint_staging` | command_processor.rs | Create commands → PendingJoint in staging buffer |
| 3 | `joint_consumption_order` | engine.rs | pending_joints drained AFTER bodies+colliders |
| 4 | `revolute_joint_creates_rapier_joint` | physics.rs | physics_sync_pre consumes pending → joint_map + impulse_joint_set |
| 5 | `prismatic_joint_creation` | physics.rs | PrismaticJointBuilder with axis |
| 6 | `fixed_joint_creation` | physics.rs | FixedJointBuilder basics |
| 7 | `rope_joint_creation` | physics.rs | RopeJointBuilder with max_dist |
| 8 | `spring_joint_creation` | physics.rs | SpringJointBuilder with rest_length |
| 9 | `remove_joint_explicit` | physics.rs | RemoveJoint → joint_map.remove + impulse_joint_set.remove |
| 10 | `despawn_cascade_cleanup` | engine.rs | despawn entity_a → joint_map.retain removes entries |
| 11 | `despawn_entity_b_cleanup` | engine.rs | despawn entity_b → same cleanup |
| 12 | `remove_then_despawn_no_panic` | engine.rs | RemoveJoint + DespawnEntity = no double-free |
| 13 | `multi_joint_single_entity` | physics.rs | entity_a with revolute+fixed, remove one → other intact |

### 5.2 TypeScript Tests (~11 tests)

| # | Test | Location | Verifies |
|---|------|----------|----------|
| 1 | `joint_handle_branded_type` | physics-api.test.ts | JointHandle has __brand, _jointId, _entityA |
| 2 | `joint_id_monotonic` | backpressure.test.ts | _nextJointId increments, IDs unique |
| 3 | `createRevoluteJoint_serialization` | backpressure.test.ts | Header=entityA, payload=jointId+entityB+anchorAx+anchorAy (16B) |
| 4 | `createPrismaticJoint_serialization` | backpressure.test.ts | Correct 16B payload |
| 5 | `createFixedJoint_serialization` | backpressure.test.ts | 8B payload |
| 6 | `createRopeJoint_serialization` | backpressure.test.ts | 12B payload |
| 7 | `createSpringJoint_serialization` | backpressure.test.ts | 12B payload |
| 8 | `removeJoint_serialization` | backpressure.test.ts | 4B payload (joint_id only) |
| 9 | `setJointMotor_serialization` | backpressure.test.ts | 12B payload |
| 10 | `all_joint_commands_non_coalescable` | backpressure.test.ts | isNonCoalescable(33..43) === true |
| 11 | `entity_handle_revolute_returns_joint_handle` | entity-handle.test.ts | .revoluteJoint() returns JointHandle with _entityA = this.id |

### 5.3 Verification Harness

One additional check in the demo "Physics" tab:

**"Joint constraints — Revolute joint holds two bodies together"**: Create two boxes with a revolute joint, apply gravity, verify they remain connected (distance between centers ≈ constant ± tolerance after N ticks).

### 5.4 Expected Test Counts Post-15d

- Rust: ~221 (with `physics-2d` feature)
- TypeScript: ~813

---

## 6. Files Modified

### Rust (4 files)

| File | Changes |
|------|---------|
| `ring_buffer.rs` | **Breaking**: update payload sizes for 33-39 (add joint_id); reslot 40-41 from CharController to Spring; add 42-43; update `from_u8()`, `payload_size()` |
| `command_processor.rs` | Add Create joint commands (33-36, 40) to `process_single_command_physics` interceptor |
| `physics.rs` | `JointEntry`, `PendingJoint`, `PendingJointType`; `PhysicsWorld` gains `joint_map` + `pending_joints`; joint consumption in `physics_sync_pre`; cleanup in `despawn_physics_cleanup` |
| `physics_commands.rs` | Add Set/Remove commands (37-39, 41-43) to `process_physics_commands` |

### TypeScript (5 files)

| File | Changes |
|------|---------|
| `ring-buffer.ts` | **Breaking**: update payload sizes for 33-39 (add joint_id); reslot 40-41; add 42-43; update PAYLOAD_SIZES |
| `backpressure.ts` | Remove `moveCharacter()`/`setCharacterConfig()`; add `_nextJointId`, 11 joint producer methods; update `isNonCoalescable()` range from 33-37 to 33-43, remove MoveCharacter=40 check |
| `entity-handle.ts` | Add `revoluteJoint()`, `prismaticJoint()`, `fixedJoint()`, `ropeJoint()`, `springJoint()` |
| `physics-api.ts` | Add `JointHandle` type; add 6 convenience methods; barrel export |
| `index.ts` | Export `JointHandle` |

### Documentation (2 files)

| File | Changes |
|------|---------|
| `CLAUDE.md` | Update CommandType table (33-43 joints), MAX_COMMAND_TYPE=44, test counts, Phase 15d in status table |
| This design doc | Reference for implementation |
