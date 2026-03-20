# Phase 15e: Character Controller — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Rapier2D `KinematicCharacterController` integration via 3 new CommandTypes (44-46), enabling obstacle-aware movement with ground detection and slope handling.

**Architecture:** Commands flow through the existing ring buffer protocol (hybrid pattern: command via ring buffer, result via sync WASM query). Processing happens in a new Pass 5 of `physics_sync_pre`. TS reads grounded/sliding state via 2 new WASM exports after `engine_update()`.

**Tech Stack:** Rust (rapier2d 0.32 `KinematicCharacterController`), TypeScript, ring buffer binary protocol

**Spec:** `docs/plans/2026-03-20-phase15e-character-controller-design.md`

---

## File Map

### Rust — create/modify

| File | Action | Responsibility |
|------|--------|---------------|
| `crates/hyperion-core/src/ring_buffer.rs` | Modify | 3 new `CommandType` variants + `from_u8` + `payload_size` |
| `crates/hyperion-core/src/physics.rs` | Modify | `CharacterState`, `CharacterEntry`, `character_map`, `pending_moves`, Pass 5 |
| `crates/hyperion-core/src/physics_commands.rs` | Modify | Route commands 44/45/46 |
| `crates/hyperion-core/src/engine.rs` | Modify | Pass `FIXED_DT` to `physics_sync_pre()` |
| `crates/hyperion-core/src/lib.rs` | Modify | 2 new WASM exports |

### TypeScript — create/modify

| File | Action | Responsibility |
|------|--------|---------------|
| `ts/src/ring-buffer.ts` | Modify | 3 `CommandType` enum values + `PAYLOAD_SIZES` |
| `ts/src/backpressure.ts` | Modify | 3 producer methods, `isNonCoalescable`, `MAX_COMMAND_TYPE` |
| `ts/src/physics-api.ts` | Modify | `CharacterControllerConfig`, 2 query methods, WASM exports |
| `ts/src/entity-handle.ts` | Modify | 3 fluent methods |
| `ts/src/index.ts` | Modify | Barrel export |

---

### Task 1: Rust protocol — CommandType variants 44-46

This is the **prerequisite** for all other tasks. Without `from_u8` returning `Some` for 44-46, `drain()` breaks on unknown discriminants.

**Files:**

- Modify: `crates/hyperion-core/src/ring_buffer.rs:34-87` (enum), `:91-142` (from_u8), `:146-182` (payload_size)

- [ ] **Step 1: Add 3 CommandType variants to the enum**

After `SetJointAnchorA = 43` (line 86), before the closing `}`:

```rust
    // ── Physics: character controller ──
    CreateCharacterController = 44, // 1B: reserved flags
    SetCharacterConfig = 45,        // 16B: packed config
    MoveCharacter = 46,             // 8B: dx(f32) + dy(f32)
```

- [ ] **Step 2: Extend `from_u8` match**

After `43 => Some(Self::SetJointAnchorA),` (line 140), before `_ => None`:

```rust
            // Physics: character controller
            44 => Some(Self::CreateCharacterController),
            45 => Some(Self::SetCharacterConfig),
            46 => Some(Self::MoveCharacter),
```

- [ ] **Step 3: Extend `payload_size` match**

After the spring joints & anchor overrides arm (line 180), before the closing `}`:

```rust
            // Physics: character controller
            Self::CreateCharacterController => 1,  // reserved flags
            Self::SetCharacterConfig => 16,        // packed config (see spec §3.2)
            Self::MoveCharacter => 8,              // dx(f32) + dy(f32)
```

- [ ] **Step 4: Write tests for new CommandTypes**

In the `#[cfg(test)] mod tests` block, after the existing `physics_payload_sizes_within_limit` test:

```rust
    #[test]
    fn character_controller_command_types_round_trip() {
        for val in 44..=46u8 {
            let ct = CommandType::from_u8(val);
            assert!(ct.is_some(), "CommandType::from_u8({val}) should be Some");
        }
        assert!(CommandType::from_u8(47).is_none(), "47 should be None");
    }

    #[test]
    fn character_controller_payload_sizes() {
        assert_eq!(CommandType::CreateCharacterController.payload_size(), 1);
        assert_eq!(CommandType::SetCharacterConfig.payload_size(), 16);
        assert_eq!(CommandType::MoveCharacter.payload_size(), 8);
    }
```

- [ ] **Step 5: Run Rust tests to verify**

Run: `cargo test -p hyperion-core ring_buffer`

Expected: all ring buffer tests pass, including the 2 new ones.

- [ ] **Step 6: Run clippy**

Run: `cargo clippy -p hyperion-core`

Expected: no warnings.

- [ ] **Step 7: Commit**

```bash
git add crates/hyperion-core/src/ring_buffer.rs
git commit -m "feat(#15e): CommandType variants 44-46 for character controller"
```

---

### Task 2: TS protocol — CommandType + PAYLOAD_SIZES sync

Sync the TypeScript side with the Rust protocol changes.

**Files:**

- Modify: `ts/src/ring-buffer.ts:54-66` (enum), `:69-120` (PAYLOAD_SIZES)

- [ ] **Step 1: Add 3 CommandType enum values**

After `SetJointAnchorA = 43,` (line 65), before closing `}`:

```typescript
  // Physics: character controller
  CreateCharacterController = 44,
  SetCharacterConfig = 45,
  MoveCharacter = 46,
```

- [ ] **Step 2: Add PAYLOAD_SIZES entries**

After the joints section in `PAYLOAD_SIZES` (around line 117), before closing `}`:

```typescript
  // Physics: character controller
  [CommandType.CreateCharacterController]: 1,
  [CommandType.SetCharacterConfig]: 16,
  [CommandType.MoveCharacter]: 8,
```

- [ ] **Step 3: Run TS tests to verify nothing broke**

Run: `cd ts && npx vitest run src/ring-buffer.test.ts`

Expected: existing ring buffer tests pass.

- [ ] **Step 4: Commit**

```bash
git add ts/src/ring-buffer.ts
git commit -m "feat(#15e): TS CommandType + PAYLOAD_SIZES for character controller (44-46)"
```

---

### Task 3: Rust types — CharacterEntry, CharacterState, PhysicsWorld fields

Add the Rust types and storage for character controllers.

**Files:**

- Modify: `crates/hyperion-core/src/physics.rs` — add types after `PhysicsControlled` marker (~line 112), extend `PhysicsWorld` struct and `new()`

- [ ] **Step 1: Add `CharacterState` and `CharacterEntry` types**

In `physics.rs`, inside the `#[cfg(feature = "physics-2d")] pub mod types` block, after the `PhysicsControlled` marker struct:

```rust
    /// State result from the last `move_shape()` call.
    pub struct CharacterState {
        pub grounded: bool,
        pub is_sliding_down_slope: bool,
    }

    impl Default for CharacterState {
        fn default() -> Self {
            Self { grounded: false, is_sliding_down_slope: false }
        }
    }

    /// A character controller entry: Rapier KCC + last-frame state.
    pub struct CharacterEntry {
        pub controller: rapier2d::control::KinematicCharacterController,
        pub state: CharacterState,
    }
```

- [ ] **Step 2: Add `character_map` and `pending_moves` to `PhysicsWorld`**

In the `PhysicsWorld` struct, after `pending_joints` field:

```rust
        /// Character controller entries keyed by external entity ID.
        pub character_map: HashMap<u32, CharacterEntry>,
        /// Pending MoveCharacter commands: (ext_id, dx, dy).
        /// Populated by process_commands, consumed in physics_sync_pre Pass 5.
        pub pending_moves: Vec<(u32, f32, f32)>,
```

Add `use std::collections::HashMap;` at the top of the types module if not already imported. (Note: `HashMap` is already used for `joint_map`, so the import should exist.)

- [ ] **Step 3: Initialize new fields in `PhysicsWorld::new()`**

In the `PhysicsWorld::new()` function, add after the `pending_joints: Vec::new()` line:

```rust
                character_map: HashMap::new(),
                pending_moves: Vec::new(),
```

- [ ] **Step 4: Add `character_map.remove()` to despawn cleanup**

In `crates/hyperion-core/src/command_processor.rs`, find the `despawn_physics_cleanup` section (around line 882, where `joint_map.retain()` is called). Add alongside it:

```rust
        self.character_map.remove(&ext_id);
```

- [ ] **Step 5: Run Rust tests**

Run: `cargo test -p hyperion-core --features physics-2d`

Expected: all tests pass (types compile, fields initialized).

- [ ] **Step 6: Run clippy**

Run: `cargo clippy -p hyperion-core --features physics-2d`

Expected: no warnings.

- [ ] **Step 7: Commit**

```bash
git add crates/hyperion-core/src/physics.rs
git commit -m "feat(#15e): CharacterEntry + CharacterState types, PhysicsWorld fields"
```

---

### Task 4: Rust command routing — process commands 44/45/46

Route the 3 new commands in `process_physics_commands`.

**Files:**

- Modify: `crates/hyperion-core/src/physics_commands.rs:13-90` (match arms)

- [ ] **Step 1: Add command routing for 44/45/46**

In `process_physics_commands`, in the match on `cmd.cmd_type`, add after the existing `SetJointAnchorA` arm:

```rust
            // ── Character controller ──
            CommandType::CreateCharacterController => {
                physics.character_map.entry(ext_id).or_insert(CharacterEntry {
                    controller: rapier2d::control::KinematicCharacterController::default(),
                    state: CharacterState::default(),
                });
            }
            CommandType::SetCharacterConfig => {
                if let Some(entry) = physics.character_map.get_mut(&ext_id) {
                    let flags = cmd.payload[0];
                    let climb = f32::from_le_bytes(cmd.payload[1..5].try_into().unwrap());
                    let slide_angle = f32::from_le_bytes(cmd.payload[5..9].try_into().unwrap());
                    let step_h = u16::from_le_bytes(cmd.payload[9..11].try_into().unwrap());
                    let step_w = u16::from_le_bytes(cmd.payload[11..13].try_into().unwrap());
                    let snap_d = u16::from_le_bytes(cmd.payload[13..15].try_into().unwrap());

                    entry.controller.slide = flags & 0x01 != 0;
                    entry.controller.max_slope_climb_angle = climb;
                    entry.controller.min_slope_slide_angle = slide_angle;

                    entry.controller.autostep = if flags & 0x02 != 0 {
                        use rapier2d::control::CharacterAutostep;
                        use rapier2d::control::CharacterLength;
                        Some(CharacterAutostep {
                            max_height: if flags & 0x10 != 0 {
                                CharacterLength::Relative(f32::from(step_h) / 100.0)
                            } else {
                                CharacterLength::Absolute(f32::from(step_h) / 100.0)
                            },
                            min_width: if flags & 0x20 != 0 {
                                CharacterLength::Relative(f32::from(step_w) / 100.0)
                            } else {
                                CharacterLength::Absolute(f32::from(step_w) / 100.0)
                            },
                            include_dynamic_bodies: flags & 0x04 != 0,
                        })
                    } else { None };

                    entry.controller.snap_to_ground = if flags & 0x08 != 0 {
                        use rapier2d::control::CharacterLength;
                        Some(if flags & 0x40 != 0 {
                            CharacterLength::Relative(f32::from(snap_d) / 100.0)
                        } else {
                            CharacterLength::Absolute(f32::from(snap_d) / 100.0)
                        })
                    } else { None };
                }
            }
            CommandType::MoveCharacter => {
                let dx = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                let dy = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                physics.pending_moves.push((ext_id, dx, dy));
            }
```

Add necessary imports at the top of the file: `use crate::physics::types::{CharacterEntry, CharacterState};`

- [ ] **Step 2: Write tests for command routing**

Add test functions in the `#[cfg(test)]` module at the bottom of `physics_commands.rs`:

```rust
    #[test]
    fn create_character_controller_inserts_entry() {
        let (mut world, entity_map, mut physics) = setup_kinematic_entity();
        let cmd = Command {
            cmd_type: CommandType::CreateCharacterController,
            entity_id: 0,
            payload: [0; 16], // reserved flags byte
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);
        assert!(physics.character_map.contains_key(&0));
    }

    #[test]
    fn set_character_config_updates_kcc_fields() {
        let (mut world, entity_map, mut physics) = setup_kinematic_entity();
        // Create CC first
        let create = Command {
            cmd_type: CommandType::CreateCharacterController,
            entity_id: 0,
            payload: [0; 16],
        };
        process_physics_commands(&[create], &mut world, &entity_map, &mut physics);

        // Build SetCharacterConfig payload
        let mut payload = [0u8; 16];
        // flags: slide=1, autostep=1, autostep_dyn=1, snap=1, height_rel=0, width_rel=0, snap_rel=1
        payload[0] = 0x01 | 0x02 | 0x04 | 0x08 | 0x40; // 0x4F
        // max_slope_climb_angle = π/3
        payload[1..5].copy_from_slice(&(std::f32::consts::FRAC_PI_3).to_le_bytes());
        // min_slope_slide_angle = π/6
        payload[5..9].copy_from_slice(&(std::f32::consts::FRAC_PI_6).to_le_bytes());
        // autostep_max_height = 8.0 px (absolute) → u16 = 800
        payload[9..11].copy_from_slice(&800u16.to_le_bytes());
        // autostep_min_width = 4.0 px (absolute) → u16 = 400
        payload[11..13].copy_from_slice(&400u16.to_le_bytes());
        // snap_distance = 0.5 (relative) → u16 = 50
        payload[13..15].copy_from_slice(&50u16.to_le_bytes());

        let config_cmd = Command {
            cmd_type: CommandType::SetCharacterConfig,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[config_cmd], &mut world, &entity_map, &mut physics);

        let entry = physics.character_map.get(&0).unwrap();
        assert!(entry.controller.slide);
        assert!((entry.controller.max_slope_climb_angle - std::f32::consts::FRAC_PI_3).abs() < 1e-5);
        assert!((entry.controller.min_slope_slide_angle - std::f32::consts::FRAC_PI_6).abs() < 1e-5);
        assert!(entry.controller.autostep.is_some());
        assert!(entry.controller.snap_to_ground.is_some());
    }

    #[test]
    fn move_character_pushes_pending_move() {
        let (mut world, entity_map, mut physics) = setup_kinematic_entity();
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&10.0f32.to_le_bytes());
        payload[4..8].copy_from_slice(&(-5.0f32).to_le_bytes());
        let cmd = Command {
            cmd_type: CommandType::MoveCharacter,
            entity_id: 0,
            payload,
        };
        process_physics_commands(&[cmd], &mut world, &entity_map, &mut physics);
        assert_eq!(physics.pending_moves.len(), 1);
        assert_eq!(physics.pending_moves[0], (0, 10.0, -5.0));
    }
```

The `setup_kinematic_entity` helper creates a 2D entity with a kinematic rigid body + collider. Model it after the existing test helpers in the file (e.g., `setup_two_bodies_with_joints`), but create a kinematic body (`body_type: 2`).

- [ ] **Step 3: Run tests**

Run: `cargo test -p hyperion-core --features physics-2d command_proc`

Expected: all command processor tests pass including the 3 new ones.

- [ ] **Step 4: Commit**

```bash
git add crates/hyperion-core/src/physics_commands.rs
git commit -m "feat(#15e): route CreateCharacterController + SetCharacterConfig + MoveCharacter commands"
```

---

### Task 5: Rust Pass 5 — move_shape() in physics_sync_pre

Implement the character controller movement pass.

**Files:**

- Modify: `crates/hyperion-core/src/physics.rs:421-530` (`physics_sync_pre` function)
- Modify: `crates/hyperion-core/src/engine.rs:215` (call site — pass `FIXED_DT`)

- [ ] **Step 1: Add `dt` parameter to `physics_sync_pre`**

Change the signature at `physics.rs:421`:

```rust
pub fn physics_sync_pre(
    world: &mut hecs::World,
    physics: &mut PhysicsWorld,
    entity_map: &crate::command_processor::EntityMap,
    dt: f32,
```

- [ ] **Step 2: Update call site in `engine.rs`**

At `engine.rs:215`, change:

```rust
crate::physics::physics_sync_pre(&mut self.world, &mut self.physics, &self.entity_map);
```

to:

```rust
crate::physics::physics_sync_pre(&mut self.world, &mut self.physics, &self.entity_map, FIXED_DT);
```

- [ ] **Step 2b: Update ALL `physics_sync_pre` call sites in tests**

The signature change breaks existing test calls in `physics_commands.rs` and `physics.rs`.
Search for all `physics_sync_pre(` calls in test code and add the `dt` parameter:

```bash
grep -rn "physics_sync_pre(" crates/hyperion-core/src/
```

For each call site in test code, change:
```rust
physics_sync_pre(&mut world, &mut physics, &entity_map);
```
to:
```rust
physics_sync_pre(&mut world, &mut physics, &entity_map, 1.0 / 60.0);
```

This is critical — without it, ALL existing `physics-2d` tests fail to compile.

- [ ] **Step 3: Add Pass 5 at end of `physics_sync_pre`**

After the existing Pass 4 (joints), before the function's closing `}`, add:

```rust
    // Pass 5: Character controller moves.
    // Invariant: CC moves once per frame. pending_moves is populated by
    // process_commands (1×/frame) and drained here on the first tick.
    for (ext_id, dx, dy) in physics.pending_moves.drain(..) {
        let Some(entry) = physics.character_map.get_mut(&ext_id) else { continue };
        let Some(&entity) = entity_map.get(ext_id) else { continue };
        let Ok(body_handle) = world.get::<&PhysicsBodyHandle>(entity) else { continue };

        let body = &physics.rigid_body_set[body_handle.0];
        if !body.is_kinematic() { continue; }
        let colliders_slice = body.colliders();
        if colliders_slice.is_empty() { continue; }

        // Copy shape + pos out of borrowed state BEFORE creating QueryPipeline.
        // as_query_pipeline() borrows rigid_body_set + collider_set — overlapping
        // borrows with shape/pos would fail the borrow checker.
        let collider = &physics.collider_set[colliders_slice[0]];
        let shape = collider.shape().clone();
        let pos = *body.position(); // Pose is Copy

        let qp = physics.broad_phase.as_query_pipeline(
            physics.narrow_phase.query_dispatcher(),
            &physics.rigid_body_set,
            &physics.collider_set,
            QueryFilter::default().exclude_rigid_body(body_handle.0),
        );

        let desired = Vector::new(dx, dy);
        let corrected = entry.controller.move_shape(
            dt,
            &qp, &*shape, &pos, desired, |_| {},
        );

        let body_mut = &mut physics.rigid_body_set[body_handle.0];
        let new_pos = *body_mut.translation() + corrected.translation;
        body_mut.set_next_kinematic_translation(new_pos);

        entry.state.grounded = corrected.grounded;
        entry.state.is_sliding_down_slope = corrected.is_sliding_down_slope;
    }
```

Add `use rapier2d::prelude::QueryFilter;` at the top if not already imported. Also add `use rapier2d::control::KinematicCharacterController;` if needed.

**Note:** The `body.colliders()`, `body.position()`, `body.is_kinematic()`, and `body.set_next_kinematic_translation()` calls are spike items 6-8 from the spec. If any of these fail to compile, check the rapier2d 0.32 docs (`target/doc/rapier2d/`) for the correct method names.

- [ ] **Step 4: Write Pass 5 integration test**

In `engine.rs` tests (at the bottom, inside `#[cfg(feature = "physics-2d")]`), add:

```rust
    #[test]
    fn character_controller_grounded_on_floor() {
        let mut engine = Engine::new();
        engine.configure_physics(0.0, -980.0, 100.0);

        // Create a static floor at y=0
        engine.process_commands(&[spawn_2d_cmd(100)]);
        engine.process_commands(&[create_rigid_body_cmd(100, 1)]); // 1=fixed
        let mut floor_col = [0u8; 16];
        floor_col[0] = 1; // box
        floor_col[1..5].copy_from_slice(&500.0f32.to_le_bytes()); // half_width
        floor_col[5..9].copy_from_slice(&10.0f32.to_le_bytes());  // half_height
        engine.process_commands(&[Command {
            cmd_type: CommandType::CreateCollider,
            entity_id: 100,
            payload: floor_col,
        }]);

        // Create kinematic character at y=20 (above floor)
        engine.process_commands(&[spawn_2d_cmd(0)]);
        engine.process_commands(&[create_rigid_body_cmd(0, 2)]); // 2=kinematic
        engine.process_commands(&[create_circle_collider_cmd(0, 10.0)]);

        // Position character above floor
        let mut pos_payload = [0u8; 16];
        pos_payload[0..4].copy_from_slice(&0.0f32.to_le_bytes());
        pos_payload[4..8].copy_from_slice(&20.0f32.to_le_bytes());
        engine.process_commands(&[Command {
            cmd_type: CommandType::SetPosition,
            entity_id: 0,
            payload: pos_payload,
        }]);

        // Create character controller
        engine.process_commands(&[Command {
            cmd_type: CommandType::CreateCharacterController,
            entity_id: 0,
            payload: [0; 16],
        }]);

        engine.update(FIXED_DT);

        // Move character downward (toward floor)
        let mut move_payload = [0u8; 16];
        move_payload[0..4].copy_from_slice(&0.0f32.to_le_bytes()); // dx
        move_payload[4..8].copy_from_slice(&(-50.0f32).to_le_bytes()); // dy (down)
        engine.process_commands(&[Command {
            cmd_type: CommandType::MoveCharacter,
            entity_id: 0,
            payload: move_payload,
        }]);

        engine.update(FIXED_DT);

        // Character should be grounded
        assert!(engine.physics.character_map.get(&0).unwrap().state.grounded);

        // Verify corrected movement was actually applied (body moved)
        let entity = engine.entity_map.get(0).unwrap();
        let t = engine.world.get::<&crate::components::Transform2D>(entity).unwrap();
        // Character started at y=20, moved toward floor — should have stopped near floor surface
        assert!(t.y < 20.0, "character should have moved down from y=20, got y={}", t.y);
    }

    #[test]
    fn character_controller_move_without_floor() {
        let mut engine = Engine::new();
        engine.configure_physics(0.0, 0.0, 100.0); // no gravity

        // Kinematic character with no obstacles
        engine.process_commands(&[spawn_2d_cmd(0)]);
        engine.process_commands(&[create_rigid_body_cmd(0, 2)]);
        engine.process_commands(&[create_circle_collider_cmd(0, 10.0)]);
        engine.process_commands(&[Command {
            cmd_type: CommandType::CreateCharacterController,
            entity_id: 0,
            payload: [0; 16],
        }]);
        engine.update(FIXED_DT);

        // Move right by 50 px — no obstacles, should move full distance
        let mut move_payload = [0u8; 16];
        move_payload[0..4].copy_from_slice(&50.0f32.to_le_bytes());
        move_payload[4..8].copy_from_slice(&0.0f32.to_le_bytes());
        engine.process_commands(&[Command {
            cmd_type: CommandType::MoveCharacter,
            entity_id: 0,
            payload: move_payload,
        }]);
        engine.update(FIXED_DT);

        // Should NOT be grounded (no floor)
        assert!(!engine.physics.character_map.get(&0).unwrap().state.grounded);
    }

    #[test]
    fn character_controller_despawn_cleanup() {
        let mut engine = Engine::new();
        engine.configure_physics(0.0, -980.0, 100.0);

        engine.process_commands(&[spawn_2d_cmd(0)]);
        engine.process_commands(&[create_rigid_body_cmd(0, 2)]);
        engine.process_commands(&[create_circle_collider_cmd(0, 10.0)]);
        engine.process_commands(&[Command {
            cmd_type: CommandType::CreateCharacterController,
            entity_id: 0,
            payload: [0; 16],
        }]);
        engine.update(FIXED_DT);
        assert!(engine.physics.character_map.contains_key(&0));

        // Despawn
        engine.process_commands(&[Command {
            cmd_type: CommandType::DespawnEntity,
            entity_id: 0,
            payload: [0; 16],
        }]);
        engine.update(FIXED_DT);
        assert!(!engine.physics.character_map.contains_key(&0));
    }
```

**Note:** `create_rigid_body_cmd` and `create_circle_collider_cmd` are test helpers already defined in `engine.rs` tests. The body_type parameter for `create_rigid_body_cmd` needs to match the existing helper signature — check and adapt if the helper only creates dynamic bodies.

- [ ] **Step 5: Run physics tests**

Run: `cargo test -p hyperion-core --features physics-2d engine`

Expected: all engine tests pass including the 3 new ones.

- [ ] **Step 6: Run clippy**

Run: `cargo clippy -p hyperion-core --features physics-2d`

Expected: no warnings.

- [ ] **Step 7: Commit**

```bash
git add crates/hyperion-core/src/physics.rs crates/hyperion-core/src/engine.rs
git commit -m "feat(#15e): Pass 5 move_shape() in physics_sync_pre + grounded/despawn tests"
```

---

### Task 6: Rust WASM exports — grounded + sliding queries

**Files:**

- Modify: `crates/hyperion-core/src/lib.rs` — add 2 new `#[wasm_bindgen]` exports

- [ ] **Step 1: Add WASM exports**

In `lib.rs`, in the `#[cfg(feature = "physics-2d")]` block alongside the existing physics exports:

```rust
#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_character_grounded(entity_id: u32) -> u8 {
    // SAFETY: wasm32 is single-threaded
    let engine = unsafe { &*addr_of_mut!(ENGINE) }.as_ref();
    match engine.map(|e| &e.physics) {
        Some(p) => match p.character_map.get(&entity_id) {
            Some(entry) => u8::from(entry.state.grounded),
            None => 255,
        },
        None => 255,
    }
}

#[cfg(feature = "physics-2d")]
#[wasm_bindgen]
pub fn engine_character_sliding(entity_id: u32) -> u8 {
    // SAFETY: wasm32 is single-threaded
    let engine = unsafe { &*addr_of_mut!(ENGINE) }.as_ref();
    match engine.map(|e| &e.physics) {
        Some(p) => match p.character_map.get(&entity_id) {
            Some(entry) => u8::from(entry.state.is_sliding_down_slope),
            None => 255,
        },
        None => 255,
    }
}
```

- [ ] **Step 2: Run full Rust validation**

Run: `cargo test -p hyperion-core --features physics-2d && cargo clippy -p hyperion-core --features physics-2d`

Expected: all 234+ tests pass, no clippy warnings.

- [ ] **Step 3: Commit**

```bash
git add crates/hyperion-core/src/lib.rs
git commit -m "feat(#15e): WASM exports engine_character_grounded + engine_character_sliding"
```

---

### Task 7: TS backpressure — producer methods + coalescence

**Files:**

- Modify: `ts/src/backpressure.ts:25` (MAX_COMMAND_TYPE), `:34-43` (isNonCoalescable), bottom of class (new methods)
- Modify: `ts/src/physics-api.ts` — add `CharacterControllerConfig` type

- [ ] **Step 1: Add `CharacterControllerConfig` type to `physics-api.ts`**

After the `JointHandle` interface at the top:

```typescript
/** Configuration for a character controller. All fields optional with defaults. */
export interface CharacterControllerConfig {
  /** Enable wall sliding. Default: true. */
  slide?: boolean;
  /** Max climbable slope angle in radians. Default: π/4 (45°). */
  maxSlopeClimbAngle?: number;
  /** Min slope angle before auto-sliding. Default: π/4 (45°). */
  minSlopeSlideAngle?: number;
  /** Autostep config, or false to disable. Default: disabled. */
  autostep?: {
    maxHeight: number;
    minWidth: number;
    includeDynamic?: boolean;
    relative?: boolean;
  } | false;
  /** Snap-to-ground distance, or false to disable. Default: 0.2 relative. */
  snapToGround?: number | false;
  /** Whether snapToGround distance is relative to shape. Default: true. */
  snapRelative?: boolean;
}
```

- [ ] **Step 2: Update `MAX_COMMAND_TYPE` in `backpressure.ts`**

Change line 25 from `const MAX_COMMAND_TYPE = 44;` to `const MAX_COMMAND_TYPE = 47;`

- [ ] **Step 3: Update `isNonCoalescable`**

After the joint range check (line 42), add:

```typescript
  if (cmd === CommandType.CreateCharacterController) return true; // 44
```

Update the comment on line 41 from "Character Controller (15e) starts at 44 — do not extend this range" to "Joint commands 33-43 are ALL non-coalescable".

- [ ] **Step 4: Add 3 producer methods**

At the bottom of the `BackpressuredProducer` class, add:

```typescript
  createCharacterController(entityId: number): void {
    const buf = new Uint8Array(1);
    buf[0] = 0;
    this._enqueueOrWrite(CommandType.CreateCharacterController, entityId, buf);
  }

  setCharacterConfig(entityId: number, config: CharacterControllerConfig): void {
    const slide = config.slide ?? true;
    const climbAngle = config.maxSlopeClimbAngle ?? Math.PI / 4;
    const slideAngle = config.minSlopeSlideAngle ?? Math.PI / 4;
    const autostep = config.autostep === undefined ? false : config.autostep;
    const snap = config.snapToGround === undefined ? 0.2 : config.snapToGround;
    const snapRel = config.snapRelative ?? true;

    let flags = 0;
    if (slide) flags |= 0x01;
    if (autostep !== false) {
      flags |= 0x02;
      if (autostep.includeDynamic ?? true) flags |= 0x04;
      const rel = autostep.relative ? 1 : 0;
      flags |= (rel << 4) | (rel << 5);
    }
    if (snap !== false) flags |= 0x08;
    if (snapRel) flags |= 0x40;

    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    buf[0] = flags;
    dv.setFloat32(1, climbAngle, true);
    dv.setFloat32(5, slideAngle, true);
    dv.setUint16(9, autostep !== false ? Math.round(autostep.maxHeight * 100) : 0, true);
    dv.setUint16(11, autostep !== false ? Math.round(autostep.minWidth * 100) : 0, true);
    dv.setUint16(13, snap !== false ? Math.round(snap * 100) : 0, true);
    buf[15] = 0;

    this._enqueueOrWrite(CommandType.SetCharacterConfig, entityId, buf);
  }

  moveCharacter(entityId: number, dx: number, dy: number): void {
    const buf = new Float32Array([dx, dy]);
    this._enqueueOrWrite(CommandType.MoveCharacter, entityId, new Uint8Array(buf.buffer));
  }
```

Add the import: `import type { CharacterControllerConfig } from './physics-api';`

**Note:** Check whether the existing producer methods use `this._enqueueOrWrite` or `this._writeCommand` — use the same internal method name.

- [ ] **Step 5: Write tests for producer methods and coalescence**

In `ts/src/backpressure.test.ts`, add tests:

```typescript
describe('character controller commands', () => {
  it('createCharacterController is non-coalescable', () => {
    // Verify isNonCoalescable returns true for 44
    expect(isNonCoalescable(CommandType.CreateCharacterController)).toBe(true);
  });

  it('SetCharacterConfig is coalescable', () => {
    expect(isNonCoalescable(CommandType.SetCharacterConfig)).toBe(false);
  });

  it('MoveCharacter is coalescable', () => {
    expect(isNonCoalescable(CommandType.MoveCharacter)).toBe(false);
  });

  it('setCharacterConfig packs 16-byte payload correctly', () => {
    // Test with specific config values and verify the packed bytes
    // (check flags byte, f32 angles, u16 spatial values)
  });
});
```

Note: `isNonCoalescable` may be a module-private function. If so, test indirectly via `PrioritizedCommandQueue` behavior (enqueue 2 of the same coalescable command → only 1 survives).

- [ ] **Step 6: Run tests**

Run: `cd ts && npx vitest run src/backpressure.test.ts`

Expected: all backpressure tests pass including new ones.

- [ ] **Step 7: Commit**

```bash
git add ts/src/backpressure.ts ts/src/physics-api.ts ts/src/backpressure.test.ts
git commit -m "feat(#15e): CC producer methods + coalescence + CharacterControllerConfig type"
```

---

### Task 8: TS EntityHandle + PhysicsAPI + barrel export

**Files:**

- Modify: `ts/src/entity-handle.ts` — 3 fluent methods
- Modify: `ts/src/physics-api.ts` — 2 query methods + WASM exports
- Modify: `ts/src/index.ts` — barrel export

- [ ] **Step 1: Add 3 fluent methods to `EntityHandle`**

In `entity-handle.ts`, after the existing `springJoint` method, add:

```typescript
  /** Mark this entity as character-controlled. Returns `this`. */
  characterController(): this {
    this._guard();
    this._producer!.createCharacterController(this._id);
    return this;
  }

  /** Configure the character controller. Returns `this`. */
  characterConfig(config: CharacterControllerConfig): this {
    this._guard();
    this._producer!.setCharacterConfig(this._id, config);
    return this;
  }

  /** Move the character by desired translation. Returns `this`. */
  moveCharacter(dx: number, dy: number): this {
    this._guard();
    this._producer!.moveCharacter(this._id, dx, dy);
    return this;
  }
```

Add the import: `import type { CharacterControllerConfig } from './physics-api';`

(Note: `JointHandle` is already imported from `physics-api`, so extend that import.)

- [ ] **Step 2: Add WASM exports and query methods to `PhysicsAPI`**

In `physics-api.ts`, extend the `PhysicsWasmExports` interface:

```typescript
  engine_character_grounded(entity_id: number): number;
  engine_character_sliding(entity_id: number): number;
```

Add query methods to the `PhysicsAPI` class, after the existing `setJointAnchorB` method:

```typescript
  /** Returns true if the character is touching the ground. */
  isGrounded(entityId: number): boolean {
    if (!this._wasm) return false;
    return this._wasm.engine_character_grounded(entityId) === 1;
  }

  /** Returns true if the character is sliding down a slope. */
  isSlidingDownSlope(entityId: number): boolean {
    if (!this._wasm) return false;
    return this._wasm.engine_character_sliding(entityId) === 1;
  }
```

- [ ] **Step 3: Update barrel export**

In `ts/src/index.ts`, update the physics API line:

```typescript
export type { CollisionEvent, ContactForceEvent, RaycastHit, JointHandle, CharacterControllerConfig } from './physics-api';
```

- [ ] **Step 4: Write EntityHandle + PhysicsAPI tests**

In `ts/src/entity-handle.test.ts`, add:

```typescript
describe('character controller fluent API', () => {
  it('characterController() returns this', () => {
    const handle = createTestHandle(); // use existing test factory
    expect(handle.characterController()).toBe(handle);
  });

  it('characterConfig() returns this', () => {
    const handle = createTestHandle();
    expect(handle.characterConfig({ maxSlopeClimbAngle: Math.PI / 3 })).toBe(handle);
  });

  it('moveCharacter() returns this', () => {
    const handle = createTestHandle();
    expect(handle.moveCharacter(10, -5)).toBe(handle);
  });
});
```

In `ts/src/physics-api.test.ts`, add:

```typescript
describe('character controller queries', () => {
  it('isGrounded returns false when WASM not loaded', () => {
    const api = new PhysicsAPI();
    expect(api.isGrounded(42)).toBe(false);
  });

  it('isSlidingDownSlope returns false when WASM not loaded', () => {
    const api = new PhysicsAPI();
    expect(api.isSlidingDownSlope(42)).toBe(false);
  });
});
```

- [ ] **Step 5: Run TS tests**

Run: `cd ts && npx vitest run src/entity-handle.test.ts src/physics-api.test.ts`

Expected: all tests pass.

- [ ] **Step 6: Type-check**

Run: `cd ts && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`

Expected: no new type errors.

- [ ] **Step 7: Commit**

```bash
git add ts/src/entity-handle.ts ts/src/physics-api.ts ts/src/index.ts ts/src/entity-handle.test.ts ts/src/physics-api.test.ts
git commit -m "feat(#15e): EntityHandle fluent CC API + PhysicsAPI query methods + barrel export"
```

---

### Task 9: Full validation + CLAUDE.md update

**Files:**

- Modify: `CLAUDE.md` — update module descriptions, gotchas, implementation status

- [ ] **Step 1: Run full Rust validation**

Run: `cargo test -p hyperion-core && cargo test -p hyperion-core --features physics-2d && cargo clippy -p hyperion-core && cargo clippy -p hyperion-core --features physics-2d`

Expected: all tests pass (~157 base, ~234+ with physics-2d), no clippy warnings.

- [ ] **Step 2: Run full TS validation**

Run: `cd ts && npm test && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`

Expected: ~813+ tests pass, no type errors.

- [ ] **Step 3: Update CLAUDE.md**

Key sections to update:

1. **`ring_buffer.rs` module description** — update `CommandType` enum count: "(47 variants: 17 core + 30 physics incl. ...`CreateCharacterController`, `SetCharacterConfig`, `MoveCharacter`)"
2. **`physics.rs` module description** — add `CharacterEntry`, `CharacterState`, `character_map`, `pending_moves`, Pass 5
3. **`physics_commands.rs` module description** — add character controller commands (44-46)
4. **`entity-handle.ts` module description** — add `.characterController()/.characterConfig()/.moveCharacter()`
5. **`physics-api.ts` module description** — add `CharacterControllerConfig`, `isGrounded()`, `isSlidingDownSlope()`
6. **`lib.rs` module description** — add `engine_character_grounded`, `engine_character_sliding`
7. **`index.ts` module description** — add `CharacterControllerConfig`
8. **Gotchas section** — add character controller gotchas:
   - CC moves once per frame, not per tick
   - `move_shape()` uses `FIXED_DT`, not frame dt
   - Shape from first collider, no-collider = no-op
   - CC only valid on kinematic bodies, non-kinematic silently ignored
   - `MoveCharacter` is coalescable (last-write-wins), unlike `ApplyForce`
   - No `DestroyCharacterController` — cleanup via despawn
   - `MAX_COMMAND_TYPE` is now 47
9. **Implementation Status table** — add Phase 15e row
10. **Test counts** — update to post-15e numbers

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with Phase 15e completion (character controller)"
```

---

## Execution Order Summary

```
Task 1: Rust protocol (ring_buffer.rs) ← PREREQUISITE
Task 2: TS protocol (ring-buffer.ts) ← can parallel with Task 3
Task 3: Rust types (physics.rs) ← can parallel with Task 2
Task 4: Rust command routing (physics_commands.rs) ← depends on Task 1+3
Task 5: Rust Pass 5 (physics.rs + engine.rs) ← depends on Task 3+4
Task 6: Rust WASM exports (lib.rs) ← depends on Task 3
Task 7: TS backpressure (backpressure.ts + physics-api.ts) ← depends on Task 2
Task 8: TS EntityHandle + PhysicsAPI (entity-handle.ts + physics-api.ts + index.ts) ← depends on Task 7
Task 9: Validation + docs (CLAUDE.md) ← depends on all
```

Critical path: 1 → 3 → 4 → 5 → 9
