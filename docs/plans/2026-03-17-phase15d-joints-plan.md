# Phase 15d: Joints — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add handle-based joint constraints (Revolute, Prismatic, Fixed, Rope, Spring) to the Rapier2D physics integration.

**Architecture:** 11 CommandTypes (33-43) with joint_id in every payload. Staging buffer pattern: Create commands push PendingJoint into PhysicsWorld, consumed in physics_sync_pre after bodies+colliders. HashMap<u32, JointEntry> maps joint_id → Rapier handle + entity pair. All joint commands non-coalescable.

**Tech Stack:** Rust (rapier2d 0.32, hecs), TypeScript (vitest), WASM ring buffer protocol

**Spec:** `docs/plans/2026-03-17-phase15d-joints-design.md`

---

## File Map

### Rust (4 files modified)

| File | Responsibility |
|------|---------------|
| `crates/hyperion-core/src/ring_buffer.rs` | CommandType enum, payload sizes, from_u8 mapping |
| `crates/hyperion-core/src/physics.rs` | JointEntry, PendingJoint types, PhysicsWorld joint_map + pending_joints, joint consumption in physics_sync_pre, cleanup |
| `crates/hyperion-core/src/physics_commands.rs` | Set/Remove joint commands (37-39, 41-43) on live joints |
| `crates/hyperion-core/src/command_processor.rs` | Create joint commands (33-36, 40) → staging |

### TypeScript (6 files modified)

| File | Responsibility |
|------|---------------|
| `ts/src/ring-buffer.ts` | CommandType const enum, PAYLOAD_SIZES |
| `ts/src/backpressure.ts` | Joint producer methods, _nextJointId, isNonCoalescable |
| `ts/src/physics-api.ts` | JointHandle type, PhysicsAPI convenience methods |
| `ts/src/entity-handle.ts` | Fluent joint creation API |
| `ts/src/hyperion.ts` | Wire PhysicsAPI._producer in create()/fromParts() |
| `ts/src/index.ts` | Barrel export JointHandle |

---

## Task 0: Spike — Verify Rapier 2D Joint API

**Files:**
- Modify: `crates/rapier-spike/src/lib.rs`

This task verifies all hard-blocker API assumptions before any implementation.

- [ ] **Step 1: Write spike test for joint creation + motor/limits/anchors**

In `crates/rapier-spike/src/lib.rs`, add a test that exercises the full joint API surface:

```rust
#[cfg(test)]
mod joint_api_tests {
    use rapier2d::prelude::*;

    #[test]
    fn revolute_joint_full_api() {
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let mut joints = ImpulseJointSet::new();

        let b1 = bodies.insert(RigidBodyBuilder::dynamic().translation(vector![0.0, 0.0]).build());
        let b2 = bodies.insert(RigidBodyBuilder::dynamic().translation(vector![10.0, 0.0]).build());
        // Bodies need colliders for mass
        colliders.insert_with_parent(ColliderBuilder::ball(1.0).build(), b1, &mut bodies);
        colliders.insert_with_parent(ColliderBuilder::ball(1.0).build(), b2, &mut bodies);

        // Create revolute joint — verify insert() signature
        let joint = RevoluteJointBuilder::new()
            .local_anchor1(point![1.0, 2.0].into())
            .local_anchor2(point![3.0, 4.0].into())
            .build();
        let jh = joints.insert(b1, b2, joint, true); // spike: 3 or 4 args?

        // Verify we can get the joint back
        let j = joints.get_mut(jh).unwrap();

        // Verify motor API — does JointAxis::AngZ exist in 2D?
        j.data.set_motor_velocity(JointAxis::AngZ, 5.0, 0.5);

        // Verify limits API
        j.data.set_limits(JointAxis::AngZ, [0.0, std::f32::consts::PI]);

        // Verify anchor setters
        j.data.set_local_anchor1(point![10.0, 20.0]);
        j.data.set_local_anchor2(point![30.0, 40.0]);
    }

    #[test]
    fn prismatic_joint_api() {
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let mut joints = ImpulseJointSet::new();

        let b1 = bodies.insert(RigidBodyBuilder::dynamic().build());
        let b2 = bodies.insert(RigidBodyBuilder::dynamic().build());
        colliders.insert_with_parent(ColliderBuilder::ball(1.0).build(), b1, &mut bodies);
        colliders.insert_with_parent(ColliderBuilder::ball(1.0).build(), b2, &mut bodies);

        let joint = PrismaticJointBuilder::new(UnitVector::new_normalize(vector![1.0, 0.0]))
            .local_anchor1(point![0.0, 0.0].into())
            .build();
        let _jh = joints.insert(b1, b2, joint, true);
    }

    #[test]
    fn fixed_joint_api() {
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let mut joints = ImpulseJointSet::new();

        let b1 = bodies.insert(RigidBodyBuilder::dynamic().build());
        let b2 = bodies.insert(RigidBodyBuilder::dynamic().build());
        colliders.insert_with_parent(ColliderBuilder::ball(1.0).build(), b1, &mut bodies);
        colliders.insert_with_parent(ColliderBuilder::ball(1.0).build(), b2, &mut bodies);

        let joint = FixedJointBuilder::new().build();
        let _jh = joints.insert(b1, b2, joint, true);
    }

    #[test]
    fn rope_joint_api() {
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let mut joints = ImpulseJointSet::new();

        let b1 = bodies.insert(RigidBodyBuilder::dynamic().build());
        let b2 = bodies.insert(RigidBodyBuilder::dynamic().build());
        colliders.insert_with_parent(ColliderBuilder::ball(1.0).build(), b1, &mut bodies);
        colliders.insert_with_parent(ColliderBuilder::ball(1.0).build(), b2, &mut bodies);

        let joint = RopeJointBuilder::new(50.0).build();
        let _jh = joints.insert(b1, b2, joint, true);
    }

    #[test]
    fn spring_joint_api() {
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let mut joints = ImpulseJointSet::new();

        let b1 = bodies.insert(RigidBodyBuilder::dynamic().build());
        let b2 = bodies.insert(RigidBodyBuilder::dynamic().build());
        colliders.insert_with_parent(ColliderBuilder::ball(1.0).build(), b1, &mut bodies);
        colliders.insert_with_parent(ColliderBuilder::ball(1.0).build(), b2, &mut bodies);

        // SpringJointBuilder — does it exist?
        let joint = SpringJointBuilder::new(50.0, 100.0, 5.0).build(); // rest_len, stiffness, damping
        let _jh = joints.insert(b1, b2, joint, true);
    }

    #[test]
    fn remove_joint_then_remove_body_no_panic() {
        let mut bodies = RigidBodySet::new();
        let mut colliders = ColliderSet::new();
        let mut joints = ImpulseJointSet::new();
        let mut multibody_joints = MultibodyJointSet::new();
        let mut islands = IslandManager::new();

        let b1 = bodies.insert(RigidBodyBuilder::dynamic().build());
        let b2 = bodies.insert(RigidBodyBuilder::dynamic().build());
        colliders.insert_with_parent(ColliderBuilder::ball(1.0).build(), b1, &mut bodies);
        colliders.insert_with_parent(ColliderBuilder::ball(1.0).build(), b2, &mut bodies);

        let joint = RevoluteJointBuilder::new().build();
        let jh = joints.insert(b1, b2, joint, true);

        // Remove joint first
        joints.remove(jh, true);
        // Then remove body — should not panic
        bodies.remove(b1, &mut islands, &mut colliders, &mut joints, &mut multibody_joints, true);
    }
}
```

- [ ] **Step 2: Run spike tests**

Run: `cargo test -p rapier-spike`

If any test fails to compile, adapt the API call to match rapier2d 0.32 reality. Document divergences. Key items to check:
- `joints.insert()` — 3 args or 4? (does `wake_up: bool` exist?)
- `JointAxis::AngZ` — does it exist in 2D?
- `SpringJointBuilder::new()` — does it exist? what's the signature?
- `set_motor_velocity()` — params? does `damping_factor` map to our `max_force`?
- `joints.remove(handle, true)` — does `wake_up` param exist?

- [ ] **Step 3: Record results**

Update the design doc §4.2 spike checklist with results. If any hard blocker has a different API, update the design doc §2 pseudocode. Commit the spike.

```bash
git add crates/rapier-spike/src/lib.rs docs/plans/2026-03-17-phase15d-joints-design.md
git commit -m "spike: verify Rapier 2D joint API for Phase 15d"
```

---

## Task 1: Protocol — Update Rust CommandType (ring_buffer.rs)

**Files:**
- Modify: `crates/hyperion-core/src/ring_buffer.rs`

- [ ] **Step 1: Update joint CommandType comments and add new variants**

In the `CommandType` enum, update existing joint commands (33-39) to reflect new payload sizes with `joint_id`, reslot 40-41, and add 42-43:

```rust
    // ── Physics: joints (handle-based, joint_id in every payload) ──
    CreateRevoluteJoint = 33,   // 16B: joint_id(u32) + entity_b(u32) + anchor_ax(f32) + anchor_ay(f32)
    CreatePrismaticJoint = 34,  // 16B: joint_id(u32) + entity_b(u32) + axis_x(f32) + axis_y(f32)
    CreateFixedJoint = 35,      // 8B: joint_id(u32) + entity_b(u32)
    CreateRopeJoint = 36,       // 12B: joint_id(u32) + entity_b(u32) + max_dist(f32)
    RemoveJoint = 37,           // 4B: joint_id(u32)
    SetJointMotor = 38,         // 12B: joint_id(u32) + target_vel(f32) + max_force(f32)
    SetJointLimits = 39,        // 12B: joint_id(u32) + min(f32) + max(f32)
    CreateSpringJoint = 40,     // 12B: joint_id(u32) + entity_b(u32) + rest_length(f32)
    SetSpringParams = 41,       // 12B: joint_id(u32) + stiffness(f32) + damping(f32)
    SetJointAnchorB = 42,       // 12B: joint_id(u32) + bx(f32) + by(f32)
    SetJointAnchorA = 43,       // 12B: joint_id(u32) + ax(f32) + ay(f32)
```

Remove `MoveCharacter = 40` and `SetCharacterConfig = 41`.

- [ ] **Step 2: Update `from_u8()` match arms**

Replace the character controller arms with spring/anchor arms:

```rust
            // Physics: joints (handle-based)
            33 => Some(Self::CreateRevoluteJoint),
            34 => Some(Self::CreatePrismaticJoint),
            35 => Some(Self::CreateFixedJoint),
            36 => Some(Self::CreateRopeJoint),
            37 => Some(Self::RemoveJoint),
            38 => Some(Self::SetJointMotor),
            39 => Some(Self::SetJointLimits),
            40 => Some(Self::CreateSpringJoint),
            41 => Some(Self::SetSpringParams),
            42 => Some(Self::SetJointAnchorB),
            43 => Some(Self::SetJointAnchorA),
```

- [ ] **Step 3: Update `payload_size()` match arms**

Replace existing joint and character controller payload sizes:

```rust
            // Physics: joints (handle-based, joint_id u32 in every payload)
            Self::CreateRevoluteJoint | Self::CreatePrismaticJoint => 16, // joint_id + entity_b + 2×f32
            Self::CreateFixedJoint => 8,       // joint_id + entity_b
            Self::CreateRopeJoint | Self::SetJointMotor | Self::SetJointLimits
            | Self::CreateSpringJoint | Self::SetSpringParams
            | Self::SetJointAnchorB | Self::SetJointAnchorA => 12, // joint_id + 2×f32
            Self::RemoveJoint => 4,            // joint_id only
```

Remove the `Self::DestroyRigidBody | Self::DestroyCollider | Self::RemoveJoint => 0` arm — `RemoveJoint` now has 4B payload. Keep `DestroyRigidBody | DestroyCollider => 0`.

- [ ] **Step 4: Update no-op arm in `process_single_command` (command_processor.rs)**

In `command_processor.rs` at line ~698, the base handler has a catch-all arm for physics commands that are handled by the physics interceptor:

```rust
// BEFORE (remove MoveCharacter/SetCharacterConfig, add new joint commands):
| CommandType::MoveCharacter
| CommandType::SetCharacterConfig => {}

// AFTER:
| CommandType::CreateSpringJoint
| CommandType::SetSpringParams
| CommandType::SetJointAnchorB
| CommandType::SetJointAnchorA => {}
```

NOTE: The existing joint no-op arms for 33-39 should already be in place from 15a scaffolding. Verify they are, and add 40-43.

- [ ] **Step 5: Update existing ring buffer test range**

In `ring_buffer.rs` at lines ~894 and ~902, update the physics command round-trip test range from `17..=41u8` to `17..=43u8`.

- [ ] **Step 6: Verify compilation**

Run: `cargo build -p hyperion-core --features physics-2d`
Expected: compiles with no errors (tests may fail due to existing test expectations — that's OK at this stage).

- [ ] **Step 7: Commit**

```bash
git add crates/hyperion-core/src/ring_buffer.rs crates/hyperion-core/src/command_processor.rs
git commit -m "feat(#15d): update CommandType protocol for handle-based joints (33-43)"
```

---

## Task 2: Protocol — Update TypeScript CommandType (ring-buffer.ts + backpressure.ts)

**Files:**
- Modify: `ts/src/ring-buffer.ts`
- Modify: `ts/src/backpressure.ts`

- [ ] **Step 1: Update ring-buffer.ts CommandType enum**

Replace the joint + character controller block:

```typescript
  // Physics: joints (handle-based, joint_id in every payload)
  CreateRevoluteJoint = 33,
  CreatePrismaticJoint = 34,
  CreateFixedJoint = 35,
  CreateRopeJoint = 36,
  RemoveJoint = 37,
  SetJointMotor = 38,
  SetJointLimits = 39,
  CreateSpringJoint = 40,
  SetSpringParams = 41,
  SetJointAnchorB = 42,
  SetJointAnchorA = 43,
```

Remove `MoveCharacter = 40` and `SetCharacterConfig = 41`.

- [ ] **Step 2: Update PAYLOAD_SIZES**

Replace the joint + character controller block:

```typescript
  // Physics: joints (handle-based)
  [CommandType.CreateRevoluteJoint]: 16,
  [CommandType.CreatePrismaticJoint]: 16,
  [CommandType.CreateFixedJoint]: 8,
  [CommandType.CreateRopeJoint]: 12,
  [CommandType.RemoveJoint]: 4,
  [CommandType.SetJointMotor]: 12,
  [CommandType.SetJointLimits]: 12,
  [CommandType.CreateSpringJoint]: 12,
  [CommandType.SetSpringParams]: 12,
  [CommandType.SetJointAnchorB]: 12,
  [CommandType.SetJointAnchorA]: 12,
```

Remove `MoveCharacter` and `SetCharacterConfig` entries.

- [ ] **Step 3: Update backpressure.ts — MAX_COMMAND_TYPE + isNonCoalescable**

```typescript
const MAX_COMMAND_TYPE = 44; // CommandType values: 0..43

/**
 * Returns true for commands that must NOT be coalesced (last-write-wins).
 * - Lifecycle: SpawnEntity, DespawnEntity
 * - Physics create/destroy: CreateRigidBody..DestroyCollider (17-20)
 * - Physics additive: ApplyForce, ApplyImpulse, ApplyTorque (25-27)
 * - Physics joints: ALL joint commands (33-43) — entity-based coalescing key
 *   doesn't work for joints (same entity + same cmdType = same key for
 *   different joints, causing silent overwrite). See design doc §1.3.
 */
function isNonCoalescable(cmd: CommandType): boolean {
  if (cmd === CommandType.SpawnEntity || cmd === CommandType.DespawnEntity) return true;
  if (cmd >= CommandType.CreateRigidBody && cmd <= CommandType.DestroyCollider) return true; // 17-20
  if (cmd >= CommandType.ApplyForce && cmd <= CommandType.ApplyTorque) return true; // 25-27
  if (cmd >= CommandType.CreateRevoluteJoint && cmd <= CommandType.SetJointAnchorA) return true; // 33-43
  return false;
}
```

- [ ] **Step 4: Remove moveCharacter/setCharacterConfig producer methods from BackpressuredProducer**

Search for `moveCharacter` and `setCharacterConfig` methods in `backpressure.ts` and delete them. They will be re-scaffolded at 44-45 in Phase 15e.

- [ ] **Step 5: Run existing tests to catch breakage**

Run: `cd ts && npx vitest run src/backpressure.test.ts`
Expected: existing tests pass (some may need updating if they reference MoveCharacter/SetCharacterConfig).

- [ ] **Step 6: Commit**

```bash
git add ts/src/ring-buffer.ts ts/src/backpressure.ts
git commit -m "feat(#15d): update TS protocol for handle-based joints (33-43)"
```

---

## Task 3: Rust — JointEntry + PendingJoint types (physics.rs)

**Files:**
- Modify: `crates/hyperion-core/src/physics.rs`

- [ ] **Step 1: Write tests for JointEntry and PendingJoint types**

Add to the `#[cfg(test)] mod tests` block in `physics.rs`:

```rust
    #[test]
    fn joint_entry_fields() {
        use rapier2d::prelude::*;
        let handle = ImpulseJointHandle::from_raw_parts(0, 0);
        let entry = JointEntry { handle, entity_a: 42, entity_b: 99 };
        assert_eq!(entry.entity_a, 42);
        assert_eq!(entry.entity_b, 99);
    }

    #[test]
    fn pending_joint_staging_buffer() {
        let mut physics = PhysicsWorld::new();
        assert!(physics.pending_joints.is_empty());

        physics.pending_joints.push(PendingJoint {
            joint_id: 1,
            entity_a_ext: 10,
            entity_b_ext: 20,
            joint_type: PendingJointType::Revolute { anchor_ax: 5.0, anchor_ay: 10.0 },
        });
        assert_eq!(physics.pending_joints.len(), 1);

        physics.pending_joints.push(PendingJoint {
            joint_id: 2,
            entity_a_ext: 10,
            entity_b_ext: 30,
            joint_type: PendingJointType::Fixed,
        });
        assert_eq!(physics.pending_joints.len(), 2);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p hyperion-core --features physics-2d joint_entry_fields`
Expected: FAIL — `JointEntry`, `PendingJoint`, `PendingJointType` not defined.

- [ ] **Step 3: Add types to physics.rs**

In the `pub mod types` block, add:

```rust
    /// Joint lifecycle entry in PhysicsWorld.joint_map.
    pub struct JointEntry {
        pub handle: rapier2d::prelude::ImpulseJointHandle,
        pub entity_a: u32,  // external ID
        pub entity_b: u32,  // external ID
    }

    /// Pending joint type with creation parameters.
    pub enum PendingJointType {
        Revolute { anchor_ax: f32, anchor_ay: f32 },
        Prismatic { axis_x: f32, axis_y: f32 },
        Fixed,
        Rope { max_dist: f32 },
        Spring { rest_length: f32 },
    }

    /// Pending joint creation. Staged in PhysicsWorld.pending_joints,
    /// consumed in physics_sync_pre() after bodies+colliders.
    pub struct PendingJoint {
        pub joint_id: u32,
        pub entity_a_ext: u32,
        pub entity_b_ext: u32,
        pub joint_type: PendingJointType,
    }
```

Add `joint_map` and `pending_joints` to `PhysicsWorld`:

```rust
    pub joint_map: std::collections::HashMap<u32, JointEntry>,
    pub pending_joints: Vec<PendingJoint>,
```

Initialize them in `PhysicsWorld::new()`:

```rust
    joint_map: std::collections::HashMap::new(),
    pending_joints: Vec::new(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p hyperion-core --features physics-2d joint_entry`
Run: `cargo test -p hyperion-core --features physics-2d pending_joint_staging`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/hyperion-core/src/physics.rs
git commit -m "feat(#15d): JointEntry + PendingJoint types in PhysicsWorld"
```

---

## Task 4: Rust — Create Joint command routing (command_processor.rs)

**Files:**
- Modify: `crates/hyperion-core/src/command_processor.rs`

- [ ] **Step 1: Write test for Create joint command staging**

Add to the `#[cfg(test)]` block (or add one if needed). The test should verify that Create joint commands are intercepted and pushed to `physics.pending_joints`:

```rust
    #[cfg(feature = "physics-2d")]
    #[test]
    fn create_revolute_joint_stages_pending() {
        use crate::physics::*;
        use crate::ring_buffer::{Command, CommandType};
        use crate::render_state::RenderState;

        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut render_state = RenderState::new();
        let mut physics = PhysicsWorld::new();

        // Spawn entity_a (ext_id=0)
        let mut payload_spawn = [0u8; 16];
        payload_spawn[0] = 1; // 2D
        let cmd_spawn = Command { cmd_type: CommandType::SpawnEntity, entity_id: 0, payload: payload_spawn };
        process_commands(&[cmd_spawn], &mut world, &mut entity_map, &mut render_state, &mut physics);

        // CreateRevoluteJoint: joint_id=1, entity_b=5, anchor_ax=10.0, anchor_ay=20.0
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&1u32.to_le_bytes());     // joint_id
        payload[4..8].copy_from_slice(&5u32.to_le_bytes());     // entity_b
        payload[8..12].copy_from_slice(&10.0f32.to_le_bytes()); // anchor_ax
        payload[12..16].copy_from_slice(&20.0f32.to_le_bytes()); // anchor_ay
        let cmd = Command { cmd_type: CommandType::CreateRevoluteJoint, entity_id: 0, payload };
        process_commands(&[cmd], &mut world, &mut entity_map, &mut render_state, &mut physics);

        assert_eq!(physics.pending_joints.len(), 1);
        assert_eq!(physics.pending_joints[0].joint_id, 1);
        assert_eq!(physics.pending_joints[0].entity_a_ext, 0);
        assert_eq!(physics.pending_joints[0].entity_b_ext, 5);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core --features physics-2d create_revolute_joint_stages`
Expected: FAIL — no match arm for CreateRevoluteJoint in process_single_command_physics.

- [ ] **Step 3: Add Create joint routing to process_single_command_physics**

In `command_processor.rs`, in the `process_single_command_physics` function (the `#[cfg(feature = "physics-2d")]` interceptor), add match arms for Create joint commands (33-36, 40):

```rust
CommandType::CreateRevoluteJoint => {
    let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    let entity_b = u32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
    let ax = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
    let ay = f32::from_le_bytes(cmd.payload[12..16].try_into().unwrap());
    physics.pending_joints.push(PendingJoint {
        joint_id,
        entity_a_ext: cmd.entity_id,
        entity_b_ext: entity_b,
        joint_type: PendingJointType::Revolute { anchor_ax: ax, anchor_ay: ay },
    });
}
CommandType::CreatePrismaticJoint => {
    let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    let entity_b = u32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
    let axis_x = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
    let axis_y = f32::from_le_bytes(cmd.payload[12..16].try_into().unwrap());
    physics.pending_joints.push(PendingJoint {
        joint_id,
        entity_a_ext: cmd.entity_id,
        entity_b_ext: entity_b,
        joint_type: PendingJointType::Prismatic { axis_x, axis_y },
    });
}
CommandType::CreateFixedJoint => {
    let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    let entity_b = u32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
    physics.pending_joints.push(PendingJoint {
        joint_id,
        entity_a_ext: cmd.entity_id,
        entity_b_ext: entity_b,
        joint_type: PendingJointType::Fixed,
    });
}
CommandType::CreateRopeJoint => {
    let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    let entity_b = u32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
    let max_dist = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
    physics.pending_joints.push(PendingJoint {
        joint_id,
        entity_a_ext: cmd.entity_id,
        entity_b_ext: entity_b,
        joint_type: PendingJointType::Rope { max_dist },
    });
}
CommandType::CreateSpringJoint => {
    let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    let entity_b = u32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
    let rest_length = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
    physics.pending_joints.push(PendingJoint {
        joint_id,
        entity_a_ext: cmd.entity_id,
        entity_b_ext: entity_b,
        joint_type: PendingJointType::Spring { rest_length },
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p hyperion-core --features physics-2d create_revolute_joint_stages`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/hyperion-core/src/command_processor.rs
git commit -m "feat(#15d): route Create joint commands to staging buffer"
```

---

## Task 5: Rust — Joint consumption in physics_sync_pre (physics.rs)

**Files:**
- Modify: `crates/hyperion-core/src/physics.rs`

- [ ] **Step 1: Write test for revolute joint creation via physics_sync_pre**

```rust
    #[test]
    fn revolute_joint_creates_rapier_joint() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();
        physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);

        // Create two entities with bodies
        let e1 = world.spawn((Transform2D::default(), PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]), ExternalId(0)));
        entity_map.insert(0, e1);
        let e2 = world.spawn((Transform2D::default(), PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]), ExternalId(1)));
        entity_map.insert(1, e2);

        // Stage a revolute joint
        physics.pending_joints.push(PendingJoint {
            joint_id: 1, entity_a_ext: 0, entity_b_ext: 1,
            joint_type: PendingJointType::Revolute { anchor_ax: 5.0, anchor_ay: 10.0 },
        });

        // Run physics_sync_pre — should consume bodies, colliders, AND joints
        physics_sync_pre(&mut world, &mut physics, &entity_map);

        assert!(physics.pending_joints.is_empty(), "pending_joints should be drained");
        assert_eq!(physics.joint_map.len(), 1);
        assert!(physics.joint_map.contains_key(&1));
        let entry = &physics.joint_map[&1];
        assert_eq!(entry.entity_a, 0);
        assert_eq!(entry.entity_b, 1);
        assert!(physics.impulse_joint_set.get(entry.handle).is_some());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core --features physics-2d revolute_joint_creates_rapier`
Expected: FAIL — physics_sync_pre doesn't process pending_joints.

- [ ] **Step 3: Add joint consumption to physics_sync_pre**

In `physics_sync_pre()`, AFTER the existing body+collider consumption loops, add step 4:

```rust
    // Step 4: Consume pending joints (AFTER all bodies exist in Rapier)
    for pending in physics.pending_joints.drain(..) {
        // Look up entity_a Rapier body handle
        let entity_a = match entity_map.get(pending.entity_a_ext) {
            Some(e) => e,
            None => continue, // entity despawned in same frame
        };
        let handle_a = match world.get::<&PhysicsBodyHandle>(entity_a) {
            Ok(h) => h.0,
            Err(_) => continue,
        };

        // Look up entity_b Rapier body handle
        let entity_b = match entity_map.get(pending.entity_b_ext) {
            Some(e) => e,
            None => continue,
        };
        let handle_b = match world.get::<&PhysicsBodyHandle>(entity_b) {
            Ok(h) => h.0,
            Err(_) => continue,
        };

        // Build joint based on type
        let joint = match pending.joint_type {
            PendingJointType::Revolute { anchor_ax, anchor_ay } => {
                RevoluteJointBuilder::new()
                    .local_anchor1(point![anchor_ax, anchor_ay].into())
                    .build()
            }
            PendingJointType::Prismatic { axis_x, axis_y } => {
                PrismaticJointBuilder::new(UnitVector::new_normalize(vector![axis_x, axis_y]))
                    .build()
            }
            PendingJointType::Fixed => {
                FixedJointBuilder::new().build()
            }
            PendingJointType::Rope { max_dist } => {
                RopeJointBuilder::new(max_dist).build()
            }
            PendingJointType::Spring { rest_length } => {
                // NOTE: adapt based on spike results (Task 0)
                SpringJointBuilder::new(rest_length, 1.0, 0.0).build()
            }
        };

        // Insert into Rapier — adapt arg count based on spike
        let jh = physics.impulse_joint_set.insert(handle_a, handle_b, joint, true);
        physics.joint_map.insert(pending.joint_id, JointEntry {
            handle: jh,
            entity_a: pending.entity_a_ext,
            entity_b: pending.entity_b_ext,
        });
    }
```

Add necessary imports at the top of the file (within the `#[cfg(feature = "physics-2d")]` block):
```rust
use rapier2d::prelude::{RevoluteJointBuilder, PrismaticJointBuilder, FixedJointBuilder,
    RopeJointBuilder, SpringJointBuilder, UnitVector};
```

- [ ] **Step 4: Write test for joint consumption order**

Verify that pending_joints are drained AFTER bodies+colliders (spec test #3):

```rust
    #[test]
    fn joint_consumption_order() {
        let mut world = hecs::World::new();
        let mut entity_map = EntityMap::new();
        let mut physics = PhysicsWorld::new();
        physics.gravity = rapier2d::math::Vector::new(0.0, 0.0);

        // Create entity_a and entity_b with PendingRigidBody+PendingCollider
        let e1 = world.spawn((Transform2D::default(), PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]), ExternalId(0)));
        entity_map.insert(0, e1);
        let e2 = world.spawn((Transform2D::default(), PendingRigidBody::new(0),
            PendingCollider::new(0, [5.0, 0.0, 0.0, 0.0]), ExternalId(1)));
        entity_map.insert(1, e2);

        // Stage a joint BEFORE bodies are consumed — should still work
        // because physics_sync_pre processes bodies (step 1) before joints (step 4)
        physics.pending_joints.push(PendingJoint {
            joint_id: 1, entity_a_ext: 0, entity_b_ext: 1,
            joint_type: PendingJointType::Fixed,
        });

        physics_sync_pre(&mut world, &mut physics, &entity_map);

        // Bodies should be consumed AND joint should be created
        assert!(world.get::<&PendingRigidBody>(e1).is_err(), "PendingRigidBody should be consumed");
        assert_eq!(physics.joint_map.len(), 1, "Joint should be created after bodies");
    }
```

- [ ] **Step 5: Write and run additional joint type tests**

Add tests for prismatic, fixed, rope, spring joint creation (tests 5-8 from design doc §5.1). Follow the same pattern as the revolute test.

Run: `cargo test -p hyperion-core --features physics-2d joint`
Expected: All joint creation tests PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/hyperion-core/src/physics.rs
git commit -m "feat(#15d): joint consumption in physics_sync_pre (5 joint types)"
```

---

## Task 6: Rust — RemoveJoint + Cleanup (physics.rs + physics_commands.rs)

**Files:**
- Modify: `crates/hyperion-core/src/physics.rs`
- Modify: `crates/hyperion-core/src/physics_commands.rs`

- [ ] **Step 1: Write test for explicit RemoveJoint**

```rust
    #[test]
    fn remove_joint_explicit() {
        // Setup: two bodies + revolute joint (same pattern as Task 5 test)
        // ...setup code creating two entities with bodies + a revolute joint...
        physics_sync_pre(&mut world, &mut physics, &entity_map);
        assert_eq!(physics.joint_map.len(), 1);

        // Process RemoveJoint command (joint_id=1)
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&1u32.to_le_bytes());
        let cmd = Command { cmd_type: CommandType::RemoveJoint, entity_id: 0, payload };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        assert_eq!(physics.joint_map.len(), 0);
    }
```

- [ ] **Step 2: Write test for despawn entity_a cascade cleanup**

IMPORTANT: `despawn_physics_cleanup` lives in `command_processor.rs` (NOT physics.rs) with signature:
`fn despawn_physics_cleanup(world: &hecs::World, entity: hecs::Entity, physics: &mut PhysicsWorld)`
— takes `hecs::Entity` (not external ID), `&World` (not `&mut World`), NO entity_map param.

```rust
    #[test]
    fn despawn_cascade_removes_joint_entries() {
        // Setup: two bodies + joint
        // ...
        physics_sync_pre(&mut world, &mut physics, &entity_map);
        assert_eq!(physics.joint_map.len(), 1);

        // Look up hecs entity for ext_id=0
        let entity_a = entity_map.get(0).unwrap();
        // Despawn entity_a — Rapier cascades, our cleanup should retain-filter
        despawn_physics_cleanup(&world, entity_a, &mut physics);
        assert_eq!(physics.joint_map.len(), 0);
    }
```

- [ ] **Step 3: Write test for despawn entity_b cascade cleanup**

```rust
    #[test]
    fn despawn_entity_b_removes_joint_entries() {
        // Setup: two bodies + joint (entity_a=0, entity_b=1)
        // ...
        physics_sync_pre(&mut world, &mut physics, &entity_map);
        assert_eq!(physics.joint_map.len(), 1);

        let entity_b = entity_map.get(1).unwrap();
        despawn_physics_cleanup(&world, entity_b, &mut physics);
        assert_eq!(physics.joint_map.len(), 0);
    }
```

- [ ] **Step 4: Write test for remove-then-despawn (no double-free)**

```rust
    #[test]
    fn remove_then_despawn_no_panic() {
        // Setup: two bodies + joint
        // ...
        physics_sync_pre(&mut world, &mut physics, &entity_map);

        // Remove joint first via command
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&1u32.to_le_bytes());
        let cmd = Command { cmd_type: CommandType::RemoveJoint, entity_id: 0, payload };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        // Then despawn entity_a — should not panic
        let entity_a = entity_map.get(0).unwrap();
        despawn_physics_cleanup(&world, entity_a, &mut physics);
    }
```

- [ ] **Step 5: Write test for multi-joint single entity**

```rust
    #[test]
    fn multi_joint_single_entity() {
        // entity_a with revolute to entity_b AND fixed to entity_c
        // ...setup 3 entities with bodies...

        physics.pending_joints.push(PendingJoint {
            joint_id: 1, entity_a_ext: 0, entity_b_ext: 1,
            joint_type: PendingJointType::Revolute { anchor_ax: 0.0, anchor_ay: 0.0 },
        });
        physics.pending_joints.push(PendingJoint {
            joint_id: 2, entity_a_ext: 0, entity_b_ext: 2,
            joint_type: PendingJointType::Fixed,
        });
        physics_sync_pre(&mut world, &mut physics, &entity_map);
        assert_eq!(physics.joint_map.len(), 2);

        // Remove only joint_id=1 — joint_id=2 should remain
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&1u32.to_le_bytes());
        let cmd = Command { cmd_type: CommandType::RemoveJoint, entity_id: 0, payload };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);

        assert_eq!(physics.joint_map.len(), 1);
        assert!(physics.joint_map.contains_key(&2));
        assert!(!physics.joint_map.contains_key(&1));
    }
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cargo test -p hyperion-core --features physics-2d remove_joint`
Expected: FAIL — no RemoveJoint arm in process_physics_commands.

- [ ] **Step 7: Restructure process_physics_commands for joint commands**

The current `process_physics_commands` in `physics_commands.rs` does entity lookup → body handle lookup → match for EVERY command. Joint commands (37-39, 41-43) need `joint_map` lookup instead, not body handle lookup. Restructure with an early-return path:

```rust
pub fn process_physics_commands(
    commands: &[Command],
    world: &mut hecs::World,
    entity_map: &EntityMap,
    physics: &mut PhysicsWorld,
) {
    for cmd in commands {
        // ── Joint commands: use joint_map, NOT body handle ──
        match cmd.cmd_type {
            CommandType::RemoveJoint => {
                let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                if let Some(entry) = physics.joint_map.remove(&joint_id) {
                    physics.impulse_joint_set.remove(entry.handle, true);
                }
                continue; // skip body-based lookup below
            }
            // SetJointMotor, SetJointLimits, SetSpringParams, SetJointAnchorA, SetJointAnchorB
            // → added in Task 7
            _ => {} // fall through to body-based handling
        }

        // ── Body-based commands: existing entity → body handle lookup ──
        let entity = match entity_map.get(cmd.entity_id) {
            Some(e) => e,
            None => continue,
        };
        // ... rest of existing code unchanged ...
    }
}
```

- [ ] **Step 8: Add joint_map cleanup to despawn_physics_cleanup**

In `command_processor.rs`, in `despawn_physics_cleanup()` at line ~818 (after `rigid_body_set.remove()`), add joint_map cleanup. Need the external ID — get it from the entity's ExternalId component:

```rust
        // Clean up joint_map entries for this entity
        if let Ok(ext_id) = world.get::<&ExternalId>(entity) {
            let eid = ext_id.0;
            drop(ext_id);
            physics.joint_map.retain(|_, entry| {
                entry.entity_a != eid && entry.entity_b != eid
            });
        }
```

Insert this AFTER the `rigid_body_set.remove()` call (which cascade-deletes joints in Rapier) but still inside the `if let Ok(handle)` block.

- [ ] **Step 9: Run all tests**

Run: `cargo test -p hyperion-core --features physics-2d`
Expected: ALL tests pass, including new joint tests.

- [ ] **Step 10: Commit**

```bash
git add crates/hyperion-core/src/physics.rs crates/hyperion-core/src/physics_commands.rs
git commit -m "feat(#15d): RemoveJoint + despawn cascade cleanup + multi-joint test"
```

---

## Task 7: Rust — Set commands (physics_commands.rs)

**Files:**
- Modify: `crates/hyperion-core/src/physics_commands.rs`

- [ ] **Step 1: Add SetJointMotor, SetJointLimits, SetSpringParams, SetJointAnchorA, SetJointAnchorB**

In `process_physics_commands`, add match arms for 38-39, 41-43. These need joint_map lookup (not body lookup):

```rust
CommandType::SetJointMotor => {
    let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    let target_vel = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
    let max_force = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
    if let Some(entry) = physics.joint_map.get(&joint_id) {
        if let Some(joint) = physics.impulse_joint_set.get_mut(entry.handle) {
            // Adapt based on spike results (JointAxis::AngZ, set_motor_velocity params)
            joint.data.set_motor_velocity(JointAxis::AngZ, target_vel, max_force);
        }
    }
}
CommandType::SetJointLimits => {
    let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    let min = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
    let max = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
    if let Some(entry) = physics.joint_map.get(&joint_id) {
        if let Some(joint) = physics.impulse_joint_set.get_mut(entry.handle) {
            joint.data.set_limits(JointAxis::AngZ, [min, max]);
        }
    }
}
CommandType::SetSpringParams => {
    let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    let stiffness = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
    let damping = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
    if let Some(entry) = physics.joint_map.get(&joint_id) {
        if let Some(joint) = physics.impulse_joint_set.get_mut(entry.handle) {
            // Adapt based on spike — spring params may use motor API
            joint.data.set_motor_velocity(JointAxis::X, 0.0, stiffness); // placeholder
        }
    }
}
CommandType::SetJointAnchorA => {
    let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    let ax = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
    let ay = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
    if let Some(entry) = physics.joint_map.get(&joint_id) {
        if let Some(joint) = physics.impulse_joint_set.get_mut(entry.handle) {
            joint.data.set_local_anchor1(point![ax, ay]);
        }
    }
}
CommandType::SetJointAnchorB => {
    let joint_id = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    let bx = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
    let by = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
    if let Some(entry) = physics.joint_map.get(&joint_id) {
        if let Some(joint) = physics.impulse_joint_set.get_mut(entry.handle) {
            joint.data.set_local_anchor2(point![bx, by]);
        }
    }
}
```

NOTE: `SetSpringParams` implementation depends on spike results. The placeholder above will need adaptation.

- [ ] **Step 2: Run tests**

Run: `cargo test -p hyperion-core --features physics-2d`
Run: `cargo clippy -p hyperion-core --features physics-2d`
Expected: PASS, no warnings.

- [ ] **Step 3: Commit**

```bash
git add crates/hyperion-core/src/physics_commands.rs
git commit -m "feat(#15d): Set joint commands (motor, limits, spring, anchors)"
```

---

## Task 8: TypeScript — JointHandle + Producer Methods (backpressure.ts + physics-api.ts)

**Files:**
- Modify: `ts/src/physics-api.ts`
- Modify: `ts/src/backpressure.ts`
- Test: `ts/src/physics-api.test.ts`
- Test: `ts/src/backpressure.test.ts`

- [ ] **Step 1: Write tests for JointHandle and serialization**

In `ts/src/backpressure.test.ts`, add:

```typescript
describe('joint commands', () => {
  test('joint_handle_branded_type', () => {
    // Create producer, call createRevoluteJoint, verify JointHandle shape
    const handle = producer.createRevoluteJoint(1, 2, 10.0, 20.0);
    expect(handle.__brand).toBe('JointHandle');
    expect(handle._jointId).toBeGreaterThan(0);
    expect(handle._entityA).toBe(1);
  });

  test('joint_id_monotonic', () => {
    const h1 = producer.createRevoluteJoint(1, 2, 0, 0);
    const h2 = producer.createFixedJoint(1, 3);
    expect(h2._jointId).toBe(h1._jointId + 1);
  });

  test('createRevoluteJoint_serialization', () => {
    // Verify ring buffer contains: header(entityA=1) + payload(jointId, entityB=2, ax=10, ay=20)
    // ... read from SharedArrayBuffer and verify bytes
  });

  test('all_joint_commands_non_coalescable', () => {
    // NOTE: isNonCoalescable is module-private. Test indirectly:
    // queue two joint commands with same entityId + cmdType, verify both survive flush
    // (if coalesced, only one would remain). Or export it for testing.
    // Check existing test patterns in backpressure.test.ts for the approach used.
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/backpressure.test.ts`
Expected: FAIL — createRevoluteJoint doesn't exist yet.

- [ ] **Step 3: Add JointHandle type to physics-api.ts**

```typescript
/** Opaque handle to a physics joint. */
export interface JointHandle {
  readonly __brand: 'JointHandle';
  readonly _jointId: number;
  readonly _entityA: number;
}
```

- [ ] **Step 4: REPLACE existing joint producer methods in BackpressuredProducer**

The 15a scaffolding already has 7 joint methods at lines ~342-385 with OLD signatures (no `joint_id`, returning `boolean` not `JointHandle`). These must be **deleted entirely** and replaced with the new handle-based versions. Also delete `moveCharacter()` and `setCharacterConfig()` at lines ~389-397.

Add `_nextJointId` field and 11 NEW joint methods:

```typescript
private _nextJointId = 1;

createRevoluteJoint(entityA: number, entityB: number, anchorAx: number, anchorAy: number): JointHandle {
  const jointId = this._nextJointId++;
  const payload = new Float32Array(4);
  const u32View = new Uint32Array(payload.buffer);
  u32View[0] = jointId;
  u32View[1] = entityB;
  payload[2] = anchorAx;
  payload[3] = anchorAy;
  this.writeCommand(CommandType.CreateRevoluteJoint, entityA, new Uint8Array(payload.buffer));
  return { __brand: 'JointHandle' as const, _jointId: jointId, _entityA: entityA };
}

// ... similar for createPrismaticJoint, createFixedJoint, createRopeJoint, createSpringJoint

removeJoint(joint: JointHandle): void {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, joint._jointId, true);
  this.writeCommand(CommandType.RemoveJoint, joint._entityA, payload);
}

setJointMotor(joint: JointHandle, targetVel: number, maxForce: number): void {
  const payload = new Float32Array(3);
  const u32View = new Uint32Array(payload.buffer);
  u32View[0] = joint._jointId;
  payload[1] = targetVel;
  payload[2] = maxForce;
  this.writeCommand(CommandType.SetJointMotor, joint._entityA, new Uint8Array(payload.buffer));
}

// ... similar for setJointLimits, setSpringParams, setJointAnchorA, setJointAnchorB
```

- [ ] **Step 5: Add convenience methods to PhysicsAPI**

In `physics-api.ts`, add methods that delegate to the producer (requires passing producer reference):

```typescript
removeJoint(joint: JointHandle): void { this._producer?.removeJoint(joint); }
setJointMotor(joint: JointHandle, targetVel: number, maxForce: number): void {
  this._producer?.setJointMotor(joint, targetVel, maxForce);
}
// ... etc for all 6 methods
```

Note: PhysicsAPI needs a `_producer` field. Add `_initProducer(producer: BackpressuredProducer)` method. Wire it in `hyperion.ts`: call `this._physics._initProducer(this._bridge.producer)` in both `create()` and `fromParts()` (after bridge creation, alongside the existing `_physics._init(wasm)` call).

- [ ] **Step 6: Run tests**

Run: `cd ts && npx vitest run src/backpressure.test.ts`
Run: `cd ts && npx vitest run src/physics-api.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add ts/src/backpressure.ts ts/src/physics-api.ts ts/src/backpressure.test.ts ts/src/physics-api.test.ts
git commit -m "feat(#15d): JointHandle + 11 producer methods + PhysicsAPI convenience"
```

---

## Task 9: TypeScript — EntityHandle Fluent API + Barrel Exports

**Files:**
- Modify: `ts/src/entity-handle.ts`
- Modify: `ts/src/index.ts`
- Test: `ts/src/entity-handle.test.ts`

- [ ] **Step 1: Write test for EntityHandle.revoluteJoint**

```typescript
test('entity_handle_revolute_returns_joint_handle', () => {
  const entityA = engine.spawn().rigidBody('dynamic').collider('circle', { radius: 5 });
  const entityB = engine.spawn().rigidBody('dynamic').collider('circle', { radius: 5 });
  const joint = entityA.revoluteJoint(entityB, { anchorAx: 10, anchorAy: 20 });
  expect(joint.__brand).toBe('JointHandle');
  expect(joint._entityA).toBe(entityA.id);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: FAIL — revoluteJoint not defined.

- [ ] **Step 3: Add fluent joint methods to EntityHandle**

```typescript
import type { JointHandle } from './physics-api';

// In EntityHandle class:

/** Create a revolute (pin) joint. `this` = entityA, `target` = entityB.
 *  anchorA = offset on this entity, anchorB = offset on target (default 0,0).
 *  Returns JointHandle (not chainable — you need the handle for motor/limits). */
revoluteJoint(target: EntityHandle, opts?: { anchorAx?: number; anchorAy?: number }): JointHandle {
  this.check();
  return this._producer!.createRevoluteJoint(
    this._id, target.id, opts?.anchorAx ?? 0, opts?.anchorAy ?? 0
  );
}

prismaticJoint(target: EntityHandle, opts?: { axisX?: number; axisY?: number }): JointHandle {
  this.check();
  return this._producer!.createPrismaticJoint(
    this._id, target.id, opts?.axisX ?? 1, opts?.axisY ?? 0
  );
}

fixedJoint(target: EntityHandle): JointHandle {
  this.check();
  return this._producer!.createFixedJoint(this._id, target.id);
}

ropeJoint(target: EntityHandle, maxDist: number): JointHandle {
  this.check();
  return this._producer!.createRopeJoint(this._id, target.id, maxDist);
}

springJoint(target: EntityHandle, restLength: number): JointHandle {
  this.check();
  return this._producer!.createSpringJoint(this._id, target.id, restLength);
}
```

- [ ] **Step 4: Add JointHandle to barrel exports**

In `ts/src/index.ts`, add:

```typescript
export type { JointHandle } from './physics-api';
```

- [ ] **Step 5: Run tests**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Run: `cd ts && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add ts/src/entity-handle.ts ts/src/index.ts ts/src/entity-handle.test.ts
git commit -m "feat(#15d): EntityHandle fluent joint API + barrel export"
```

---

## Task 10: Documentation — CLAUDE.md Update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Update the following sections:
- **ring_buffer.rs module description**: Update CommandType count from "42 variants" to "44 variants" and add joint command descriptions
- **physics_commands.rs module description**: Add joint command routing
- **physics.rs module description**: Add JointEntry, PendingJoint types, joint_map, pending_joints
- **backpressure.ts description**: Update `MAX_COMMAND_TYPE` reference from 17 to 44
- **entity-handle.ts description**: Add joint methods
- **physics-api.ts description**: Add JointHandle and joint methods
- **index.ts description**: Add JointHandle export
- **Implementation Status table**: Add Phase 15d row
- **Gotchas section**: Add joint-specific gotchas:
  - All joint commands (33-43) are non-coalescable
  - `JointHandle` is opaque — stores _jointId and _entityA
  - `pending_joints` drained in step 4 of physics_sync_pre (after bodies+colliders)
  - `joint_map.retain()` in despawn_physics_cleanup for cascade
  - RemoveJoint + DespawnEntity same joint = safe (no double-free)
  - `SpringJointBuilder` signature from spike results

- [ ] **Step 2: Update test counts**

Update test count references:
- Rust: `208 tests` → `221 tests` (with physics-2d)
- TypeScript: `802 tests` → `813 tests`

- [ ] **Step 3: Run full validation**

Run: `cargo test -p hyperion-core --features physics-2d && cargo clippy -p hyperion-core --features physics-2d && cd ts && npm test && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: ALL pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with Phase 15d completion (joints)"
```

---

## Summary

| Task | Description | Est. Tests Added |
|------|-------------|-----------------|
| 0 | Spike: Rapier 2D joint API verification | 6-7 spike tests |
| 1 | Rust protocol: CommandType 33-43 | — |
| 2 | TS protocol: CommandType + isNonCoalescable | — |
| 3 | Rust types: JointEntry + PendingJoint | 2 |
| 4 | Rust routing: Create commands → staging | 1 |
| 5 | Rust consumption: physics_sync_pre joints | 4-5 |
| 6 | Rust cleanup: RemoveJoint + cascade + multi-joint | 4 |
| 7 | Rust Set commands: motor/limits/spring/anchors | 0 (covered by integration) |
| 8 | TS: JointHandle + producer + PhysicsAPI | 4-5 |
| 9 | TS: EntityHandle fluent API + exports | 1 |
| 10 | Docs: CLAUDE.md update | — |

**Total: ~13 Rust tests + ~11 TS tests = ~24 new tests**
**Expected counts post-15d: ~221 Rust (physics-2d), ~813 TypeScript**
