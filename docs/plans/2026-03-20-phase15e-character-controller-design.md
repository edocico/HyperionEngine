# Phase 15e: Character Controller — Design Document

> **Date**: 2026-03-20
> **Status**: Design approved
> **Depends on**: Phase 15d (Joints) — complete
> **Baseline tests**: 157 Rust (228 with physics-2d), 808 TypeScript

---

## 1. Motivation

Rapier2D provides `KinematicCharacterController` — a helper that computes
obstacle-aware movement for kinematic bodies. It handles slope climbing, wall
sliding, stair stepping, and ground snapping without imposing game-specific
logic. This aligns with Hyperion's principle: *"the engine is a primitive, not a
framework."*

The character controller is the last piece of Phase 15 physics: after rigid
bodies (15b), collision events + scene queries (15c), and joints (15d), it
completes the physics integration for the three target markets:

- **Game engine**: platformer movement (ground detection, slopes, autostep)
- **Canvas/app**: collision-aware dragging (move without penetrating obstacles)
- **Desktop embedding**: both use cases

The API exposes `move_shape()` + result (corrected translation, grounded,
sliding), leaving game/app logic to the user. Configuration is opt-in with
sensible defaults — the cost of unused features is zero.

---

## 2. Design Decisions

### 2.1 Result Delivery: Hybrid (Command + Sync Query)

The character controller is unique among physics commands: it is both a
**command** (desired translation) and a **query** (what happened?). Three
approaches were evaluated:

| Approach | Pros | Cons |
|----------|------|------|
| A. Sync WASM call | Zero latency | Bypasses ring buffer, timing footgun |
| B. Async via events | Consistent with architecture | 1-frame delay kills platformer jump |
| **C. Hybrid** | **Batched commands + sync query** | **Two mechanisms (acceptable)** |

**Chosen: C.** `MoveCharacter` enters the ring buffer (batched with all other
commands). During `physics_sync_pre` Pass 5, Rust executes `move_shape()` and
stores the result in `CharacterState`. After `engine_update()` returns, TS reads
the result via sync WASM exports (`engine_character_grounded`,
`engine_character_sliding`). Zero delay, zero ring buffer bypass.

User flow:
```typescript
player.moveCharacter(vx * dt, vy * dt); // → ring buffer
engine.update();                         // tick processes everything
if (engine.physics.isGrounded(player.id)) {  // → sync WASM read
  player.applyImpulse(0, jumpForce);
}
```

### 2.2 CommandType Count: 3 (Not 4)

No `DestroyCharacterController`. Cleanup via `despawn_physics_cleanup` (same
pattern as joints — `character_map.remove(&ext_id)`). An inactive CC (no
`MoveCharacter` sent) has negligible memory cost.

### 2.3 Shape from Collider

`move_shape()` reads the shape from the entity's first collider at runtime. No
shape parameter in the protocol. Entity without collider → `MoveCharacter` is a
no-op (same pattern as "dynamic body without collider freezes").

### 2.4 MoveCharacter is Coalescable

Unlike `ApplyForce` (which accumulates — two forces in one frame sum),
`MoveCharacter` replaces: if called twice in one frame, only the last desired
translation matters. Semantically it is "set desired translation", not
"accumulate". The coalescing key `entityId * 256 + 46` works because there is
exactly one CC per entity — no multi-instance risk like joints.

---

## 3. Protocol Layer

### 3.1 New CommandTypes

| # | Name | Payload | Coalescable | Description |
|---|------|---------|-------------|-------------|
| 44 | `CreateCharacterController` | 1B (reserved flags) | No | Creates `CharacterEntry` with `KCC::default()` |
| 45 | `SetCharacterConfig` | 16B (packed) | Yes | Bitflags + angles + spatial dims |
| 46 | `MoveCharacter` | 8B (dx: f32, dy: f32) | Yes | Desired translation for this frame |

**`MAX_COMMAND_TYPE`** → 47

**`isNonCoalescable`** — add: `cmd === CommandType.CreateCharacterController`.
Update stale comment on line 41 ("Character Controller (15e) starts at 44 —
do not extend this range") to reflect the implemented commands.

**Rust `ring_buffer.rs`** — `from_u8()` and `payload_size()` must be extended
with variants 44/45/46 **before** any command routing. Without this, `drain()`
returns `None` for unknown discriminants and stops processing — breaking all
subsequent commands in the frame. This is a **prerequisite** for all other
changes.

### 3.2 SetCharacterConfig Packing (16 bytes)

```
Byte  0:     flags (u8)
               bit 0: slide
               bit 1: autostep_enabled
               bit 2: autostep_include_dynamic
               bit 3: snap_enabled
               bit 4: autostep_height_relative (0=absolute, 1=relative)
               bit 5: autostep_width_relative  (set same as bit 4)
               bit 6: snap_relative
               bit 7: reserved
Bytes 1-4:   max_slope_climb_angle (f32, radians)
Bytes 5-8:   min_slope_slide_angle (f32, radians)
Bytes 9-10:  autostep_max_height (u16, ×100 fixed-point)
Bytes 11-12: autostep_min_width (u16, ×100 fixed-point)
Bytes 13-14: snap_distance (u16, ×100 fixed-point)
Byte  15:    reserved
```

**u16 ×100 fixed-point**: precision 0.01px, max 655.35px — sufficient for step
heights and snap distances.

**Bits 4-5**: both set to the same value from a single `relative` boolean in
the TS interface. This covers the 99% case (both absolute or both relative).
Rapier's per-field `CharacterLength` granularity is preserved in the protocol
(separate bits) for future extension without breaking changes.

**Rust decoding** of `CharacterLength`:
```rust
let snap = if flags & 0x08 != 0 {
    let dist = f32::from(snap_u16) / 100.0;
    if flags & 0x40 != 0 {
        Some(CharacterLength::Relative(dist))
    } else {
        Some(CharacterLength::Absolute(dist))
    }
} else { None };
```

### 3.3 Omitted Fields

- `up`: hardcoded `Vector::Y` for 2D
- `offset`: default `Relative(0.01)`, almost never modified
- `normal_nudge_factor`: default `1e-4`, almost never modified

If needed in future, a `SetCharacterConfigExt` CommandType covers them without
breaking changes.

---

## 4. Rust Layer

### 4.1 New Types in `physics.rs`

```rust
pub struct CharacterState {
    pub grounded: bool,
    pub is_sliding_down_slope: bool,
}

impl Default for CharacterState {
    fn default() -> Self {
        Self { grounded: false, is_sliding_down_slope: false }
    }
}

pub struct CharacterEntry {
    pub controller: KinematicCharacterController,
    pub state: CharacterState,
}
```

### 4.2 New Field in PhysicsWorld

```rust
pub character_map: HashMap<u32, CharacterEntry>,
```

Initialized as `HashMap::new()` in `PhysicsWorld::new()`.

### 4.3 Pending Moves Buffer

```rust
pub pending_moves: Vec<(u32, f32, f32)>,  // (ext_id, dx, dy)
```

Populated by `process_commands()` / `process_physics_commands()` when
`CommandType::MoveCharacter` is encountered. Consumed in `physics_sync_pre`
Pass 5.

### 4.4 Command Processing

**`CreateCharacterController` (44)** — in `process_commands` or
`process_physics_commands`:
```rust
CommandType::CreateCharacterController => {
    physics.character_map.entry(ext_id).or_insert(CharacterEntry {
        controller: KinematicCharacterController::default(),
        state: CharacterState::default(),
    });
}
```

**`SetCharacterConfig` (45)** — decode 16-byte payload, update controller fields:
```rust
CommandType::SetCharacterConfig => {
    if let Some(entry) = physics.character_map.get_mut(&ext_id) {
        let flags = payload[0];
        let climb = f32::from_le_bytes(payload[1..5]);
        let slide_angle = f32::from_le_bytes(payload[5..9]);
        let step_h = u16::from_le_bytes(payload[9..11]);
        let step_w = u16::from_le_bytes(payload[11..13]);
        let snap_d = u16::from_le_bytes(payload[13..15]);

        entry.controller.slide = flags & 0x01 != 0;
        entry.controller.max_slope_climb_angle = climb;
        entry.controller.min_slope_slide_angle = slide_angle;

        entry.controller.autostep = if flags & 0x02 != 0 {
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
            Some(if flags & 0x40 != 0 {
                CharacterLength::Relative(f32::from(snap_d) / 100.0)
            } else {
                CharacterLength::Absolute(f32::from(snap_d) / 100.0)
            })
        } else { None };
    }
}
```

**`MoveCharacter` (46)** — stage for Pass 5:
```rust
CommandType::MoveCharacter => {
    let dx = f32::from_le_bytes(payload[0..4]);
    let dy = f32::from_le_bytes(payload[4..8]);
    physics.pending_moves.push((ext_id, dx, dy));
}
```

### 4.5 physics_sync_pre — Pass 5

After Pass 4 (joints), before `step()`.

**`FIXED_DT` resolution**: Pass `dt: f32` as parameter to `physics_sync_pre`
from `engine.rs` (where `FIXED_DT` is defined). This avoids a circular
dependency from `physics.rs` → `engine.rs`. The existing `physics_sync_pre`
signature changes from `(&mut self, entity_map, world)` to
`(&mut self, dt: f32, entity_map, world)`.

```rust
// Pass 5: Character controller moves
for (ext_id, dx, dy) in self.pending_moves.drain(..) {
    let Some(entry) = self.character_map.get_mut(&ext_id) else { continue };
    let Some(entity) = entity_map.get(ext_id) else { continue };
    let Ok(body_handle) = world.get::<&PhysicsBodyHandle>(*entity) else { continue };

    let body = &self.rigid_body_set[body_handle.0];
    if !body.is_kinematic() { continue; } // CC only valid on kinematic bodies
    let colliders_slice = body.colliders();
    if colliders_slice.is_empty() { continue; } // no collider → no-op

    let collider = &self.collider_set[colliders_slice[0]];
    let shape = collider.shape();
    let pos = body.position(); // &Pose — already contains translation + rotation

    let qp = self.broad_phase.as_query_pipeline(
        self.narrow_phase.query_dispatcher(),
        &self.rigid_body_set,
        &self.collider_set,
        QueryFilter::default().exclude_rigid_body(body_handle.0),
    );

    let desired = Vector::new(dx, dy);
    let corrected = entry.controller.move_shape(
        FIXED_DT,  // always fixed timestep, not frame dt
        &qp, shape, pos, desired, |_| {},
    );

    // Apply corrected movement to kinematic body
    let body_mut = &mut self.rigid_body_set[body_handle.0];
    let new_pos = *body_mut.translation() + corrected.translation;
    body_mut.set_next_kinematic_translation(new_pos);

    // Update state for TS queries
    entry.state.grounded = corrected.grounded;
    entry.state.is_sliding_down_slope = corrected.is_sliding_down_slope;
}
```

**Invariant**: CC moves once per frame, not once per tick. `pending_moves` is
populated by `process_commands()` (1×/frame) and drained in the first tick's
`physics_sync_pre`. Subsequent ticks find `pending_moves` empty. The kinematic
body reaches its corrected position at the first `step()` — subsequent ticks
see it already there. This is correct for user-input-driven movement. Document
this in the API.

### 4.6 WASM Exports

```rust
#[wasm_bindgen]
pub fn engine_character_grounded(entity_id: u32) -> u8 {
    let engine = unsafe { &*addr_of_mut!(ENGINE) }.as_ref();
    match engine.and_then(|e| e.physics.as_ref()) {
        Some(p) => match p.character_map.get(&entity_id) {
            Some(entry) => if entry.state.grounded { 1 } else { 0 },
            None => 255, // no CC for this entity
        },
        None => 255,
    }
}

#[wasm_bindgen]
pub fn engine_character_sliding(entity_id: u32) -> u8 {
    // Same pattern, reads entry.state.is_sliding_down_slope
}
```

Return values: `1` = true, `0` = false, `255` = entity has no character
controller. TS maps 255 → `false` (safe no-op).

### 4.7 Despawn Cleanup

In `despawn_physics_cleanup`, add:
```rust
self.character_map.remove(&ext_id);
```

Same pattern as `joint_map.retain()`.

---

## 5. TypeScript Layer

### 5.1 Ring Buffer Protocol

In `ring-buffer.ts`, add to `CommandType` const enum:
```typescript
CreateCharacterController = 44,
SetCharacterConfig = 45,
MoveCharacter = 46,
```

In `PAYLOAD_SIZES`: `44 → 1, 45 → 16, 46 → 8`.

### 5.2 BackpressuredProducer Methods

3 new methods:

```typescript
createCharacterController(entityId: number): void {
  const buf = new Uint8Array(1);
  buf[0] = 0; // reserved flags
  this._writeCommand(CommandType.CreateCharacterController, entityId, buf);
}

setCharacterConfig(entityId: number, config: CharacterControllerConfig): void {
  // Merge with defaults
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
    flags |= (rel << 4) | (rel << 5); // height + width same mode
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
  buf[15] = 0; // reserved

  this._writeCommand(CommandType.SetCharacterConfig, entityId, buf);
}

moveCharacter(entityId: number, dx: number, dy: number): void {
  const buf = new Float32Array([dx, dy]);
  this._writeCommand(CommandType.MoveCharacter, entityId,
    new Uint8Array(buf.buffer));
}
```

### 5.3 isNonCoalescable Update

```typescript
if (cmd === CommandType.CreateCharacterController) return true; // 44
```

### 5.4 CharacterControllerConfig Type

```typescript
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

### 5.5 EntityHandle Methods

```typescript
/** Mark this entity as character-controlled. Returns `this`. */
characterController(): this

/** Configure the character controller. Returns `this`. */
characterConfig(config: CharacterControllerConfig): this

/** Move the character by desired translation. Returns `this`. */
moveCharacter(dx: number, dy: number): this
```

All return `this` for chaining (not `JointHandle` — CC is an aspect of the
entity, not a separate object).

### 5.6 PhysicsAPI Query Methods

```typescript
/** Returns true if the character is touching the ground. */
isGrounded(entityId: number): boolean

/** Returns true if the character is sliding down a slope. */
isSlidingDownSlope(entityId: number): boolean
```

Both return `false` if WASM not loaded or entity has no CC.

### 5.7 PhysicsWasmExports Extension

```typescript
engine_character_grounded(entity_id: number): number;
engine_character_sliding(entity_id: number): number;
```

### 5.8 Barrel Export

Add `CharacterControllerConfig` to `index.ts`.

---

## 6. Invariants

1. **CC moves once per frame, not once per tick.** `pending_moves` populated
   by `process_commands()` (1×/frame), drained in first tick's
   `physics_sync_pre`. Subsequent ticks find it empty. The kinematic body
   reaches corrected position at the first `step()`.

2. **`move_shape()` uses `FIXED_DT`.** The user controls movement magnitude
   via `desired_translation` (typically `velocity * frame_dt`). The controller's
   internal dt must be the fixed physics timestep for deterministic behavior
   independent of framerate.

3. **Shape from first collider.** `body.colliders()[0]` is the "main" collider.
   No collider → `MoveCharacter` is a no-op.

4. **Kinematic bodies only.** `move_shape()` + `set_next_kinematic_translation()`
   are only meaningful on kinematic bodies. Pass 5 guards with
   `body.is_kinematic()` — non-kinematic bodies skip silently.

5. **No explicit destroy.** Cleanup via despawn cascade
   (`character_map.remove(&ext_id)`). Inactive CC (no `MoveCharacter` sent)
   has negligible cost.

6. **`corrected_translation` not exposed via WASM.** TS can approximate
   movement delta, but note that `position_pre` must be captured before
   `engine.update()` and the position in SystemViews may have 1-frame lag.
   If precise corrected translation is needed in future, add a dedicated
   WASM export without breaking changes.

7. **`CharacterControllerConfig` defined in `physics-api.ts`.** Imported by
   `backpressure.ts` (same pattern as `JointHandle`).

---

## 7. Test Targets

**Rust** (~6 new tests with `physics-2d`):
- Create CC + verify `character_map` insertion
- SetCharacterConfig + verify all KCC fields decoded correctly
- MoveCharacter + verify corrected movement applied
- MoveCharacter grounded detection (entity on floor)
- MoveCharacter slope sliding detection
- Despawn cleanup removes CC from `character_map`

**TypeScript** (~5 new tests):
- Command serialization for all 3 CommandTypes
- SetCharacterConfig packing/unpacking (flags, angles, u16 spatial)
- EntityHandle fluent API chaining
- PhysicsAPI.isGrounded / isSlidingDownSlope safe no-op
- isNonCoalescable classification for 44-46

**Target post-15e**: ~234 Rust (with physics-2d), ~813 TypeScript

---

## 8. Files Modified

### Rust (5 files)

- `crates/hyperion-core/src/ring_buffer.rs` — 3 new CommandType variants + `from_u8()` + `payload_size()` (**prerequisite for all other changes**)
- `crates/hyperion-core/src/physics.rs` — CharacterEntry, CharacterState, character_map, pending_moves, Pass 5
- `crates/hyperion-core/src/physics_commands.rs` — route 44/45/46 commands
- `crates/hyperion-core/src/engine.rs` — pass `FIXED_DT` to `physics_sync_pre()` (signature change)
- `crates/hyperion-core/src/lib.rs` — 2 new WASM exports

### TypeScript (5 files)
- `ts/src/ring-buffer.ts` — 3 new CommandType enum values + PAYLOAD_SIZES
- `ts/src/backpressure.ts` — 3 producer methods, isNonCoalescable update, MAX_COMMAND_TYPE → 47
- `ts/src/entity-handle.ts` — 3 fluent methods
- `ts/src/physics-api.ts` — 2 query methods, PhysicsWasmExports extension, CharacterControllerConfig type
- `ts/src/index.ts` — barrel export

### Docs (1 file)
- `CLAUDE.md` — Phase 15e completion, new gotchas, updated module descriptions

---

## 9. Spike Verification (Pre-Implementation)

Both spike blockers identified during brainstorming are **resolved**:

1. **`as_query_pipeline` signature**: Confirmed 4 args in rapier2d 0.32.
   Already used in 15c (raycast, overlap_aabb, overlap_circle). CC adds
   `QueryFilter::exclude_rigid_body(handle)` for self-exclusion.

2. **`EffectiveCharacterMovement` fields**: Confirmed 3 fields in rapier2d 0.32:
   `translation: Vector`, `grounded: bool`, `is_sliding_down_slope: bool`.

3. **`KinematicCharacterController` location**: `rapier2d::control` module,
   not re-exported in prelude. Confirmed in spike (`crates/rapier-spike/src/lib.rs:16`).

**Spike items resolved during spec review:**

4. **`body.position()` returns `&Pose`** — confirmed via rapier2d 0.32 docs.
   No need for `Pose::from_parts()`. Pass 5 uses `body.position()` directly.

5. **`move_shape()` signature confirmed** — 6 args + self:
   `(dt, &QueryPipeline, &dyn Shape, &Pose, Vector, FnMut)`. The reviewer
   hallucinated a different signature with `RigidBodySet`/`ColliderSet` args
   (older Rapier API). Verified against actual rapier2d 0.32 source.

**Remaining spike items** (verify empirically in implementation Task 1):

6. **`body.colliders()` return type** — verify it returns `&[ColliderHandle]`
   (slice, not `Vec` or iterator).

7. **`set_next_kinematic_translation`** — verify it exists for kinematic bodies
   and takes `Vector` (not `Pose`/`Isometry`). Confirmed present in RigidBody
   method list via generated docs.

8. **`body.is_kinematic()` guard** — confirmed present in RigidBody method list.
