# Phase 13: Optimization Tier 3 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete all remaining optimizations from the masterplan (7 items: Tier 3 + leftover Tier 1/2) to reach frame time <=3ms (canvas 10k) / <=5ms (game 100k).

**Architecture:** Seven sequential/parallel items: command coalescing (TS-only), Transform2D ECS refactor (Rust+TS), GPU radix sort for transparency, temporal culling via DirtyTracker skip-bounds, sized binding arrays stub, HTTP Range KTX2 streaming, and debug build elimination. See `docs/plans/2026-03-05-phase13-optimization-tier3-design.md` for full design rationale.

**Tech Stack:** Rust (hecs ECS, bytemuck, glam), TypeScript (Vite, vitest), WGSL (WebGPU compute/render shaders)

---

## Task 1: Command Coalescing — Refactor BackpressuredProducer

**Files:**
- Modify: `ts/src/backpressure.ts:11-166`
- Test: `ts/src/backpressure.test.ts`

### Step 1: Write failing tests for despawn purge and coalescing stats

Add to `ts/src/backpressure.test.ts`:

```typescript
describe('command coalescing (default path)', () => {
  it('last-write-wins: only final SetPosition per entity reaches ring buffer', () => {
    const sab = new SharedArrayBuffer(1024);
    const producer = new BackpressuredProducer(sab);
    // Write 3 positions for same entity in one frame
    producer.setPosition(1, 10, 20, 0);
    producer.setPosition(1, 30, 40, 0);
    producer.setPosition(1, 50, 60, 0);
    const stats = producer.flush();
    expect(stats.writtenCount).toBe(1);
    expect(stats.coalescedCount).toBe(2);
  });

  it('despawn purges pending overwrites for that entity', () => {
    const sab = new SharedArrayBuffer(1024);
    const producer = new BackpressuredProducer(sab);
    producer.spawn(5);
    producer.setPosition(5, 10, 20, 0);
    producer.setVelocity(5, 1, 0, 0);
    producer.despawn(5);
    const stats = producer.flush();
    // Spawn + Despawn written, SetPosition + SetVelocity purged
    expect(stats.writtenCount).toBe(2);
    expect(stats.purgedByDespawn).toBe(2);
  });

  it('spawn and despawn bypass coalescing (ordered in critical queue)', () => {
    const sab = new SharedArrayBuffer(1024);
    const producer = new BackpressuredProducer(sab);
    producer.spawn(1);
    producer.spawn(2);
    producer.spawn(3);
    const stats = producer.flush();
    expect(stats.writtenCount).toBe(3);
    expect(stats.coalescedCount).toBe(0);
  });

  it('different entities are not coalesced', () => {
    const sab = new SharedArrayBuffer(1024);
    const producer = new BackpressuredProducer(sab);
    producer.setPosition(1, 10, 20, 0);
    producer.setPosition(2, 30, 40, 0);
    const stats = producer.flush();
    expect(stats.writtenCount).toBe(2);
    expect(stats.coalescedCount).toBe(0);
  });

  it('different command types on same entity are not coalesced', () => {
    const sab = new SharedArrayBuffer(1024);
    const producer = new BackpressuredProducer(sab);
    producer.setPosition(1, 10, 20, 0);
    producer.setVelocity(1, 1, 0, 0);
    const stats = producer.flush();
    expect(stats.writtenCount).toBe(2);
    expect(stats.coalescedCount).toBe(0);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd ts && npx vitest run src/backpressure.test.ts`
Expected: FAIL — `stats.coalescedCount` is undefined or wrong values

### Step 3: Implement coalescing in BackpressuredProducer

Modify `ts/src/backpressure.ts`:

**PrioritizedCommandQueue (lines 11-54):** Add `purgeEntity()` method and make `enqueue()` always route non-lifecycle commands to `overwrites`:

```typescript
const MAX_COMMAND_TYPE = 16; // room for new command types

export interface FlushStats {
  writtenCount: number;
  coalescedCount: number;
  purgedByDespawn: number;
}

export class PrioritizedCommandQueue {
  readonly critical: Command[] = [];
  readonly overwrites = new Map<number, Command>();
  private _coalescedCount = 0;
  private _purgedByDespawn = 0;

  enqueue(cmd: Command): void {
    if (cmd.type === CommandType.SpawnEntity) {
      this.critical.push(cmd);
    } else if (cmd.type === CommandType.DespawnEntity) {
      this.critical.push(cmd);
      this.purgeEntity(cmd.entityId);
    } else {
      const key = cmd.entityId * 256 + cmd.type;
      if (this.overwrites.has(key)) {
        this._coalescedCount++;
      }
      this.overwrites.set(key, cmd);
    }
  }

  private purgeEntity(entityId: number): void {
    for (let cmdType = 0; cmdType < MAX_COMMAND_TYPE; cmdType++) {
      if (this.overwrites.delete(entityId * 256 + cmdType)) {
        this._purgedByDespawn++;
      }
    }
  }

  drainTo(producer: RingBufferProducer, tap: unknown): FlushStats {
    let writtenCount = 0;
    // Critical commands first (lifecycle, ordered)
    for (const cmd of this.critical) {
      producer.writeRaw(cmd);
      writtenCount++;
      if (__DEV__ && tap) {
        (tap as { record(cmd: Command): void }).record(cmd);
      }
    }
    // Overwrites (last-write-wins, insertion order)
    for (const cmd of this.overwrites.values()) {
      producer.writeRaw(cmd);
      writtenCount++;
      if (__DEV__ && tap) {
        (tap as { record(cmd: Command): void }).record(cmd);
      }
    }
    const stats: FlushStats = {
      writtenCount,
      coalescedCount: this._coalescedCount,
      purgedByDespawn: this._purgedByDespawn,
    };
    this.critical.length = 0;
    this.overwrites.clear();
    this._coalescedCount = 0;
    this._purgedByDespawn = 0;
    return stats;
  }
}
```

**BackpressuredProducer:** Update `flush()` to return `FlushStats`, and route all commands through `queue.enqueue()` instead of writing directly to the ring buffer:

```typescript
flush(): FlushStats {
  return this.queue.drainTo(this.inner, this._debugTapeRecorder);
}
```

Update `writeCommand()` and all public methods (`setPosition`, `setVelocity`, etc.) to call `this.queue.enqueue(cmd)` instead of `this.inner.writeRaw(cmd)`.

### Step 4: Run tests to verify they pass

Run: `cd ts && npx vitest run src/backpressure.test.ts`
Expected: ALL PASS (existing 22 tests + 5 new tests)

### Step 5: Run full TS test suite

Run: `cd ts && npm test`
Expected: ALL 632+ tests pass

### Step 6: Commit

```bash
git add ts/src/backpressure.ts ts/src/backpressure.test.ts
git commit -m "feat(#5): command coalescing via last-write-wins in BackpressuredProducer"
```

---

## Task 2: Transform2D — New Rust Components

**Files:**
- Modify: `crates/hyperion-core/src/components.rs:1-174`
- Test: inline `#[cfg(test)] mod tests` in `components.rs`

### Step 1: Write failing tests for Transform2D and Depth

Add to the `#[cfg(test)] mod tests` section in `components.rs`:

```rust
#[test]
fn transform2d_is_pod() {
    let t = Transform2D { x: 1.0, y: 2.0, rot: 0.5, sx: 1.0, sy: 1.0 };
    let bytes: &[u8] = bytemuck::bytes_of(&t);
    assert_eq!(bytes.len(), 20); // 5 * f32
    let back: Transform2D = bytemuck::pod_read_unaligned(bytes);
    assert_eq!(back.x, 1.0);
    assert_eq!(back.rot, 0.5);
}

#[test]
fn depth_is_pod() {
    let d = Depth(42.0);
    let bytes: &[u8] = bytemuck::bytes_of(&d);
    assert_eq!(bytes.len(), 4);
    let back: Depth = bytemuck::pod_read_unaligned(bytes);
    assert_eq!(back.0, 42.0);
}

#[test]
fn transparent_is_pod() {
    let t = Transparent(1);
    let bytes: &[u8] = bytemuck::bytes_of(&t);
    assert_eq!(bytes.len(), 1);
}
```

### Step 2: Run tests to verify they fail

Run: `cargo test -p hyperion-core components`
Expected: FAIL — `Transform2D`, `Depth`, `Transparent` not defined

### Step 3: Add the new component structs

Add to `crates/hyperion-core/src/components.rs` after existing components:

```rust
/// Compact 2D transform: position + rotation angle + scale. 20 bytes.
/// Used by the hot-path transform_system_2d for 99% of entities.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct Transform2D {
    pub x: f32,
    pub y: f32,
    pub rot: f32,  // angle in radians
    pub sx: f32,
    pub sy: f32,
}

/// Opt-in depth for 2.5D z-ordering. 4 bytes.
/// Entities with Depth participate in back-to-front transparent sorting.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct Depth(pub f32);

/// Marker component for transparent entities. 1 byte.
/// Transparent entities are sorted back-to-front via GPU radix sort.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
pub struct Transparent(pub u8);
```

### Step 4: Run tests to verify they pass

Run: `cargo test -p hyperion-core components`
Expected: ALL PASS

### Step 5: Run clippy

Run: `cargo clippy -p hyperion-core`
Expected: No warnings

### Step 6: Commit

```bash
git add crates/hyperion-core/src/components.rs
git commit -m "feat(#13): add Transform2D, Depth, and Transparent components"
```

---

## Task 3: Transform2D — Ring Buffer Protocol Extension

**Files:**
- Modify: `crates/hyperion-core/src/ring_buffer.rs:34-91`
- Modify: `ts/src/ring-buffer.ts:15-48`
- Test: inline tests in `ring_buffer.rs` + `ts/src/ring-buffer.test.ts` (if exists) or `ts/src/integration.test.ts`

### Step 1: Write failing Rust test for new command types

Add to `ring_buffer.rs` tests:

```rust
#[test]
fn set_rotation_2d_round_trip() {
    let cmd = Command {
        command_type: CommandType::SetRotation2D,
        entity_id: 42,
        payload: {
            let mut p = [0u8; 16];
            p[0..4].copy_from_slice(&std::f32::consts::FRAC_PI_4.to_le_bytes());
            p
        },
    };
    assert_eq!(cmd.command_type as u8, 14);
    let angle = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    assert!((angle - std::f32::consts::FRAC_PI_4).abs() < 1e-7);
}

#[test]
fn set_transparent_round_trip() {
    let cmd = Command {
        command_type: CommandType::SetTransparent,
        entity_id: 99,
        payload: {
            let mut p = [0u8; 16];
            p[0] = 1; // transparent = true
            p
        },
    };
    assert_eq!(cmd.command_type as u8, 15);
    assert_eq!(cmd.payload[0], 1);
}

#[test]
fn set_depth_round_trip() {
    let cmd = Command {
        command_type: CommandType::SetDepth,
        entity_id: 7,
        payload: {
            let mut p = [0u8; 16];
            p[0..4].copy_from_slice(&5.0f32.to_le_bytes());
            p
        },
    };
    assert_eq!(cmd.command_type as u8, 16);
    let depth = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
    assert!((depth - 5.0).abs() < 1e-7);
}
```

### Step 2: Run tests to verify they fail

Run: `cargo test -p hyperion-core ring_buffer`
Expected: FAIL — `SetRotation2D`, `SetTransparent`, `SetDepth` not defined

### Step 3: Extend CommandType enum in Rust

In `crates/hyperion-core/src/ring_buffer.rs`, add to the `CommandType` enum (after `SetListenerPosition = 13`):

```rust
    SetRotation2D = 14,
    SetTransparent = 15,
    SetDepth = 16,
```

Update `from_u8()` to handle 14, 15, 16.

Update `payload_size()`:
- `SetRotation2D => 4` (one f32)
- `SetTransparent => 1` (one u8)
- `SetDepth => 4` (one f32)

### Step 4: Run Rust tests

Run: `cargo test -p hyperion-core ring_buffer`
Expected: ALL PASS

### Step 5: Mirror in TypeScript

In `ts/src/ring-buffer.ts`, add to `CommandType` enum (after `SetListenerPosition = 13`):

```typescript
  SetRotation2D = 14,
  SetTransparent = 15,
  SetDepth = 16,
```

Update `PAYLOAD_SIZES` map with entries for 14 (4), 15 (1), 16 (4).

Add `setRotation2D(entityId: number, angle: number)`, `setTransparent(entityId: number, value: number)`, and `setDepth(entityId: number, z: number)` methods to `RingBufferProducer`.

### Step 6: Run TS tests

Run: `cd ts && npm test`
Expected: ALL PASS (existing tests should still pass)

### Step 7: Commit

```bash
git add crates/hyperion-core/src/ring_buffer.rs ts/src/ring-buffer.ts
git commit -m "feat(#13): add SetRotation2D, SetTransparent, SetDepth to ring buffer protocol"
```

---

## Task 4: Transform2D — EntityMap BitVec + Command Processor

**Files:**
- Modify: `crates/hyperion-core/src/command_processor.rs:10-427`
- Test: inline tests in `command_processor.rs`

### Step 1: Write failing test for 2D entity spawn and command routing

Add to `command_processor.rs` tests:

```rust
#[test]
fn spawn_2d_entity_creates_transform2d() {
    let mut world = hecs::World::new();
    let mut map = EntityMap::new();
    let mut rs = RenderState::new();
    // SpawnEntity with 2D flag set
    let cmds = vec![
        Command {
            command_type: CommandType::SpawnEntity,
            entity_id: 1,
            payload: {
                let mut p = [0u8; 16];
                p[0] = 1; // 2D flag
                p
            },
        },
        Command {
            command_type: CommandType::SetRotation2D,
            entity_id: 1,
            payload: {
                let mut p = [0u8; 16];
                p[0..4].copy_from_slice(&1.5f32.to_le_bytes());
                p
            },
        },
    ];
    process_commands(&cmds, &mut world, &mut map, &mut rs);
    let ent = map.get(1).unwrap();
    // Should have Transform2D, not Position/Rotation/Scale
    assert!(world.get::<&Transform2D>(ent).is_ok());
    let t = world.get::<&Transform2D>(ent).unwrap();
    assert!((t.rot - 1.5).abs() < 1e-7);
    assert!(world.get::<&Position>(ent).is_err());
}

#[test]
fn set_position_on_2d_entity_updates_transform2d() {
    let mut world = hecs::World::new();
    let mut map = EntityMap::new();
    let mut rs = RenderState::new();
    let cmds = vec![
        Command {
            command_type: CommandType::SpawnEntity,
            entity_id: 1,
            payload: { let mut p = [0u8; 16]; p[0] = 1; p },
        },
        Command {
            command_type: CommandType::SetPosition,
            entity_id: 1,
            payload: {
                let mut p = [0u8; 16];
                p[0..4].copy_from_slice(&10.0f32.to_le_bytes());
                p[4..8].copy_from_slice(&20.0f32.to_le_bytes());
                p[8..12].copy_from_slice(&0.0f32.to_le_bytes());
                p
            },
        },
    ];
    process_commands(&cmds, &mut world, &mut map, &mut rs);
    let ent = map.get(1).unwrap();
    let t = world.get::<&Transform2D>(ent).unwrap();
    assert!((t.x - 10.0).abs() < 1e-7);
    assert!((t.y - 20.0).abs() < 1e-7);
}
```

### Step 2: Run tests to verify they fail

Run: `cargo test -p hyperion-core command_proc`
Expected: FAIL

### Step 3: Implement EntityMap BitVec and command routing

**EntityMap changes:**
- Add `is_2d: Vec<bool>` field (or a `BitVec` — simplest is `Vec<bool>` initially, optimize later).
- `register()` takes a `is_2d: bool` param. Stores the flag.
- `is_entity_2d(external_id: u32) -> bool` accessor.

**process_single_command changes:**

For `SpawnEntity`: read `payload[0]` as 2D flag. If 2D, spawn with `(Transform2D::default(), ModelMatrix::default(), BoundingRadius::default(), Active, ExternalId(id))` instead of `(Position::default(), Rotation::default(), Scale::default(), ...)`.

For `SetPosition`: check `map.is_entity_2d(eid)`. If 2D, get `&mut Transform2D` and set `x`, `y`. If 3D, set `Position` as today.

For `SetRotation2D`: get `&mut Transform2D` and set `rot` directly.

For `SetRotation` (quat) on 2D entity: atan2 fallback conversion.

For `SetScale`: if 2D, set `Transform2D.sx/sy`. If 3D, set `Scale` as today.

For `SetDepth`: insert or update `Depth(f32)` component.

For `SetTransparent`: insert or remove `Transparent(1)` component based on payload value.

### Step 4: Run tests to verify they pass

Run: `cargo test -p hyperion-core command_proc`
Expected: ALL PASS (existing 17 tests + new tests)

### Step 5: Run clippy

Run: `cargo clippy -p hyperion-core`
Expected: No warnings

### Step 6: Commit

```bash
git add crates/hyperion-core/src/command_processor.rs
git commit -m "feat(#13): command processor routes SetPosition/SetRotation to Transform2D for 2D entities"
```

---

## Task 5: Transform2D — Split Systems (velocity + transform)

**Files:**
- Modify: `crates/hyperion-core/src/systems.rs:1-61`
- Modify: `crates/hyperion-core/src/engine.rs:73-150`
- Test: inline tests in `systems.rs`

### Step 1: Write failing tests for 2D system paths

Add to `systems.rs` tests:

```rust
#[test]
fn velocity_system_2d_updates_transform2d() {
    let mut world = hecs::World::new();
    world.spawn((
        Transform2D { x: 0.0, y: 0.0, rot: 0.0, sx: 1.0, sy: 1.0 },
        Velocity(glam::Vec3::new(10.0, 20.0, 0.0)),
    ));
    velocity_system_2d(&mut world, 0.5);
    let mut q = world.query::<&Transform2D>();
    let (_, t) = q.iter().next().unwrap();
    assert!((t.x - 5.0).abs() < 1e-5);
    assert!((t.y - 10.0).abs() < 1e-5);
}

#[test]
fn transform_system_2d_builds_model_matrix() {
    let mut world = hecs::World::new();
    world.spawn((
        Transform2D { x: 100.0, y: 200.0, rot: 0.0, sx: 2.0, sy: 3.0 },
        ModelMatrix([0.0; 16]),
    ));
    transform_system_2d(&mut world);
    let mut q = world.query::<&ModelMatrix>();
    let (_, m) = q.iter().next().unwrap();
    // Column-major: m[0]=sx, m[5]=sy, m[12]=x, m[13]=y
    assert!((m.0[0] - 2.0).abs() < 1e-5);  // sx * cos(0)
    assert!((m.0[5] - 3.0).abs() < 1e-5);  // sy * cos(0)
    assert!((m.0[12] - 100.0).abs() < 1e-5);
    assert!((m.0[13] - 200.0).abs() < 1e-5);
}

#[test]
fn transform_system_2d_with_rotation() {
    let mut world = hecs::World::new();
    let angle = std::f32::consts::FRAC_PI_2; // 90 degrees
    world.spawn((
        Transform2D { x: 0.0, y: 0.0, rot: angle, sx: 1.0, sy: 1.0 },
        ModelMatrix([0.0; 16]),
    ));
    transform_system_2d(&mut world);
    let mut q = world.query::<&ModelMatrix>();
    let (_, m) = q.iter().next().unwrap();
    // cos(pi/2) ~ 0, sin(pi/2) ~ 1
    assert!(m.0[0].abs() < 1e-5);       // sx * cos = 0
    assert!((m.0[1] - 1.0).abs() < 1e-5); // sx * sin = 1
    assert!((m.0[4] + 1.0).abs() < 1e-5); // -sy * sin = -1
    assert!(m.0[5].abs() < 1e-5);       // sy * cos = 0
}
```

### Step 2: Run tests to verify they fail

Run: `cargo test -p hyperion-core systems`
Expected: FAIL — `velocity_system_2d`, `transform_system_2d` not defined

### Step 3: Implement 2D system functions

Add to `crates/hyperion-core/src/systems.rs`:

```rust
pub fn velocity_system_2d(world: &mut hecs::World, dt: f32) {
    for (_, (transform, vel)) in world.query_mut::<(&mut Transform2D, &Velocity)>() {
        transform.x += vel.0.x * dt;
        transform.y += vel.0.y * dt;
    }
}

pub fn transform_system_2d(world: &mut hecs::World) {
    for (_, (transform, matrix)) in world.query_mut::<(&Transform2D, &mut ModelMatrix)>() {
        let (sin, cos) = transform.rot.sin_cos();
        let m = &mut matrix.0;
        // Column-major 4x4: scale * rotation * translation
        m[0] = transform.sx * cos;
        m[1] = transform.sx * sin;
        m[2] = 0.0;
        m[3] = 0.0;
        m[4] = -transform.sy * sin;
        m[5] = transform.sy * cos;
        m[6] = 0.0;
        m[7] = 0.0;
        m[8] = 0.0;
        m[9] = 0.0;
        m[10] = 1.0;
        m[11] = 0.0;
        m[12] = transform.x;
        m[13] = transform.y;
        m[14] = 0.0;
        m[15] = 1.0;
    }
}
```

### Step 4: Wire into Engine.update()

In `crates/hyperion-core/src/engine.rs`, in the `fixed_tick()` or `update()` method, call both `velocity_system_2d` and `transform_system_2d` alongside the existing 3D systems:

```rust
// Inside the fixed-timestep loop:
velocity_system(&mut self.world, FIXED_DT);
velocity_system_2d(&mut self.world, FIXED_DT);
transform_system(&mut self.world);
transform_system_2d(&mut self.world);
propagate_transforms(&mut self.world);
```

Note: `propagate_transforms` reads only `ModelMatrix` — it is archetype-agnostic and unchanged.

### Step 5: Run tests to verify they pass

Run: `cargo test -p hyperion-core systems && cargo test -p hyperion-core engine`
Expected: ALL PASS

### Step 6: Run clippy

Run: `cargo clippy -p hyperion-core`
Expected: No warnings

### Step 7: Commit

```bash
git add crates/hyperion-core/src/systems.rs crates/hyperion-core/src/engine.rs
git commit -m "feat(#13): add velocity_system_2d + transform_system_2d, wire into engine update"
```

---

## Task 6: Transform2D — RenderState + DirtyTracker Integration

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs:170-500`
- Test: inline tests in `render_state.rs`

### Step 1: Write failing test for 2D entity in render state

Add to `render_state.rs` tests:

```rust
#[test]
fn write_slot_works_for_2d_entity() {
    let mut rs = RenderState::new();
    let mut world = hecs::World::new();
    let ent = world.spawn((
        Transform2D { x: 50.0, y: 75.0, rot: 0.0, sx: 1.0, sy: 1.0 },
        ModelMatrix([0.0; 16]),
        BoundingRadius(10.0),
        Active,
        ExternalId(1),
    ));
    // Assign slot and write
    let slot = rs.assign_slot(ent);
    rs.write_slot_2d(slot, &world, ent);
    // Verify transform was written to SoA
    assert!(rs.gpu_count() >= 1);
}
```

### Step 2: Run tests to verify they fail

Run: `cargo test -p hyperion-core render_state`
Expected: FAIL — `write_slot_2d` not defined

### Step 3: Implement write_slot_2d

Add a `write_slot_2d()` method to `RenderState` that reads `Transform2D` instead of `Position`/`Rotation`/`Scale`, builds the model matrix, and writes to the same SoA buffers (transforms, bounds, renderMeta, etc.).

The key insight: `write_slot()` and `write_slot_2d()` produce the same output format (ModelMatrix in SoA transforms buffer). The GPU doesn't know or care about the source archetype.

Also update `mark_post_system_dirty()` in `engine.rs` to query `Transform2D` entities in addition to `Position` entities when checking for velocity-driven dirty marks.

### Step 4: Run tests

Run: `cargo test -p hyperion-core render_state`
Expected: ALL PASS

### Step 5: Commit

```bash
git add crates/hyperion-core/src/render_state.rs crates/hyperion-core/src/engine.rs
git commit -m "feat(#13): RenderState write_slot_2d for Transform2D entities"
```

---

## Task 7: Transform2D — TypeScript API (EntityHandle + BackpressuredProducer)

**Files:**
- Modify: `ts/src/entity-handle.ts:27-200`
- Modify: `ts/src/backpressure.ts` (add new command methods)
- Test: `ts/src/entity-handle.test.ts`

### Step 1: Write failing tests

Add to `ts/src/entity-handle.test.ts`:

```typescript
describe('rotation overload', () => {
  it('rotation(angle) sends SetRotation2D', () => {
    // ... setup with spy on producer
    handle.rotation(Math.PI / 4);
    expect(lastCommand.type).toBe(CommandType.SetRotation2D);
  });

  it('rotation(qx, qy, qz, qw) sends SetRotation', () => {
    handle.rotation(0, 0, 0.383, 0.924);
    expect(lastCommand.type).toBe(CommandType.SetRotation);
  });
});

describe('depth', () => {
  it('depth(z) sends SetDepth', () => {
    handle.depth(5.0);
    expect(lastCommand.type).toBe(CommandType.SetDepth);
  });
});

describe('transparent', () => {
  it('transparent() sends SetTransparent with value 1', () => {
    handle.transparent();
    expect(lastCommand.type).toBe(CommandType.SetTransparent);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: FAIL — `depth`, `transparent` methods not defined

### Step 3: Implement API changes

In `ts/src/entity-handle.ts`:

```typescript
rotation(angleOrQx: number, qy?: number, qz?: number, qw?: number): this {
    if (qy === undefined) {
        this._producer.setRotation2D(this._id, angleOrQx);
    } else {
        this._producer.setRotation(this._id, angleOrQx, qy!, qz!, qw!);
    }
    return this;
}

depth(z: number): this {
    this._producer.setDepth(this._id, z);
    return this;
}

transparent(): this {
    this._producer.setTransparent(this._id, 1);
    return this;
}

opaque(): this {
    this._producer.setTransparent(this._id, 0);
    return this;
}
```

Add corresponding methods to `BackpressuredProducer` that call `this.queue.enqueue(...)`.

### Step 4: Run tests

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: ALL PASS

### Step 5: Run full TS suite

Run: `cd ts && npm test`
Expected: ALL PASS

### Step 6: Commit

```bash
git add ts/src/entity-handle.ts ts/src/entity-handle.test.ts ts/src/backpressure.ts
git commit -m "feat(#13): EntityHandle.rotation(angle), .depth(z), .transparent() API"
```

---

## Task 8: Transform2D — Rebuild WASM and Integration Test

**Files:**
- Test: `ts/src/integration.test.ts`
- Build: `cd ts && npm run build:wasm`

### Step 1: Rebuild WASM

Run: `cd ts && npm run build:wasm`
Expected: Build succeeds, `ts/wasm/hyperion_core.d.ts` generated

### Step 2: Run full validation

Run: `cargo test -p hyperion-core && cargo clippy -p hyperion-core && cd ts && npm test && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: ALL PASS — 110+ Rust tests, 640+ TS tests, zero clippy warnings

### Step 3: Commit

```bash
git commit -m "feat(#13): Transform2D complete — WASM rebuild + full validation"
```

---

## Task 9: GPU Radix Sort — Transparent Component in renderMeta

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs` (write_slot renderMeta bit 8)
- Modify: `ts/src/render/passes/cull-pass.ts` (read renderMeta bit 8)
- Test: `ts/src/render/passes/cull-pass.test.ts`

### Step 1: Write failing test for renderMeta transparent bit

Add to `cull-pass.test.ts`:

```typescript
describe('transparent flag extraction', () => {
  it('extractTransparentFlag reads bit 8 from renderMeta', () => {
    const meta = (5 << 0) | (1 << 8); // primType=5, transparent=true
    expect(extractTransparentFlag(meta)).toBe(true);
    expect(extractPrimType(meta)).toBe(5);
  });

  it('non-transparent entity has bit 8 = 0', () => {
    const meta = 3; // primType=3, transparent=false
    expect(extractTransparentFlag(meta)).toBe(false);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd ts && npx vitest run src/render/passes/cull-pass.test.ts`
Expected: FAIL — helpers not defined

### Step 3: Implement renderMeta encoding + helpers

In Rust `render_state.rs` `write_slot()`: when entity has `Transparent` component, set bit 8 of renderMeta:

```rust
let transparent_bit = if world.get::<&Transparent>(entity).is_ok() { 0x100u32 } else { 0 };
render_meta[slot] = prim_type | transparent_bit;
```

In `cull-pass.ts`, export helpers:

```typescript
export function extractTransparentFlag(meta: number): boolean {
    return (meta & 0x100) !== 0;
}

export function extractPrimType(meta: number): number {
    return meta & 0xFF;
}
```

### Step 4: Run tests

Run: `cd ts && npx vitest run src/render/passes/cull-pass.test.ts`
Expected: ALL PASS

### Step 5: Commit

```bash
git add crates/hyperion-core/src/render_state.rs ts/src/render/passes/cull-pass.ts ts/src/render/passes/cull-pass.test.ts
git commit -m "feat(#14): encode Transparent flag in renderMeta bit 8"
```

---

## Task 10: GPU Radix Sort — Shader + Sort Pass

**Files:**
- Create: `ts/src/shaders/radix-sort.wgsl`
- Create: `ts/src/render/passes/radix-sort-pass.ts`
- Create: `ts/src/render/passes/radix-sort-pass.test.ts`

### Step 1: Write radix-sort.wgsl

Create `ts/src/shaders/radix-sort.wgsl` with:
- `float_to_sort_key()`: sign-aware f32-to-u32 conversion
- `make_transparent_sort_key()`: composite key `(primType << 24) | (depth_descending >> 8)`
- Three entry points: `histogram`, `prefix_sum`, `scatter`
- 8-bit radix (256 buckets), 4 passes for 32-bit keys

### Step 2: Write RadixSortPass class

Create `ts/src/render/passes/radix-sort-pass.ts`:
- Implements `RenderPass` interface
- `setup()`: creates pipelines for histogram, prefix_sum, scatter
- `execute()`: 4 passes, each: histogram → prefix_sum → scatter
- Input: transparent visible-indices buffer + depth values
- Output: sorted transparent visible-indices buffer

### Step 3: Write tests

Create `ts/src/render/passes/radix-sort-pass.test.ts`:
- Test `float_to_sort_key` correctness (positive, negative, zero, NaN)
- Test `make_transparent_sort_key` type grouping + depth ordering
- Test RadixSortPass integration with mock GPU data

### Step 4: Run tests

Run: `cd ts && npx vitest run src/render/passes/radix-sort-pass.test.ts`
Expected: ALL PASS

### Step 5: Commit

```bash
git add ts/src/shaders/radix-sort.wgsl ts/src/render/passes/radix-sort-pass.ts ts/src/render/passes/radix-sort-pass.test.ts
git commit -m "feat(#14): GPU radix sort pass for transparent entity ordering"
```

---

## Task 11: GPU Radix Sort — CullPass Split + ForwardPass Blend Modes

**Files:**
- Modify: `ts/src/render/passes/cull-pass.ts`
- Modify: `ts/src/shaders/cull.wgsl`
- Modify: `ts/src/render/passes/forward-pass.ts`
- Modify: `ts/src/renderer.ts`
- Test: `ts/src/render/passes/cull-pass.test.ts`, `ts/src/render/passes/forward-pass.test.ts`

### Step 1: Update cull.wgsl to split opaque/transparent

Add renderMeta bit 8 read. Route entities to opaque or transparent region of visible-indices. Update indirect args from 12 to 24 entries (6 types x 2 blend modes x 2 buckets — though per the design discussion, it's 6 types x 2 blend modes = 12 total, doubled from 6).

Indirect args buffer size: 240 bytes (12 entries × 20 bytes each).

### Step 2: Update ForwardPass for two sub-passes

Opaque sub-pass: depth write ON, no blend.
Transparent sub-pass: depth write OFF, alpha blend ON (`src-alpha`, `one-minus-src-alpha`).

### Step 3: Wire RadixSortPass into renderer.ts RenderGraph

Insert between CullPass and ForwardPass. Only dispatches when transparent entity count > 0.

### Step 4: Run tests

Run: `cd ts && npx vitest run src/render/passes/cull-pass.test.ts && npx vitest run src/render/passes/forward-pass.test.ts`
Expected: ALL PASS

### Step 5: Run full TS suite

Run: `cd ts && npm test`
Expected: ALL PASS

### Step 6: Commit

```bash
git add ts/src/render/passes/cull-pass.ts ts/src/shaders/cull.wgsl ts/src/render/passes/forward-pass.ts ts/src/renderer.ts
git commit -m "feat(#14): CullPass opaque/transparent split + ForwardPass blend modes + RadixSortPass integration"
```

---

## Task 12: GPU Radix Sort — Depth SoA Column + WASM Rebuild

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs` (add depth SoA column)
- Modify: `crates/hyperion-core/src/lib.rs` (add WASM export for depth data)
- Build: `cd ts && npm run build:wasm`

### Step 1: Add depth SoA column

In `render_state.rs`, add `gpu_depths: Vec<f32>` to `RenderState`. Populated by `write_slot()` / `write_slot_2d()`:
- 2D entity: `Depth.0` if present, else `0.0`
- 3D entity: `Position.z`

Add WASM exports: `engine_gpu_depths_ptr()`, `engine_gpu_depths_len()`.

### Step 2: Run Rust tests

Run: `cargo test -p hyperion-core`
Expected: ALL PASS

### Step 3: Rebuild WASM

Run: `cd ts && npm run build:wasm`
Expected: Build succeeds

### Step 4: Full validation

Run: `cargo test -p hyperion-core && cargo clippy -p hyperion-core && cd ts && npm test`
Expected: ALL PASS

### Step 5: Commit

```bash
git add crates/hyperion-core/src/render_state.rs crates/hyperion-core/src/lib.rs
git commit -m "feat(#14): depth SoA column + WASM exports for GPU radix sort"
```

---

## Task 13: Temporal Culling — DirtyTracker GPU Upload

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs` (expose dirty bitfield)
- Modify: `crates/hyperion-core/src/lib.rs` (WASM export for dirty bits)
- Test: `crates/hyperion-core/src/render_state.rs` inline tests

### Step 1: Write failing test

```rust
#[test]
fn dirty_bits_exposed_as_u32_array() {
    let mut rs = RenderState::new();
    // ... setup entities, mark some dirty ...
    let dirty_ptr = rs.dirty_transform_bits_ptr();
    let dirty_len = rs.dirty_transform_bits_u32_len();
    assert!(dirty_len > 0);
    // Verify specific bits are set
}
```

### Step 2: Implement dirty bits export

Add to `RenderState`:
```rust
pub fn dirty_transform_bits_ptr(&self) -> *const u32 {
    self.dirty.transforms.words.as_ptr()
}

pub fn dirty_transform_bits_u32_len(&self) -> usize {
    self.dirty.transforms.words.len()
}
```

Add WASM exports in `lib.rs`:
- `engine_dirty_bits_ptr() -> *const u32`
- `engine_dirty_bits_u32_len() -> usize`

### Step 3: Run tests + rebuild WASM

Run: `cargo test -p hyperion-core render_state && cd ts && npm run build:wasm`
Expected: ALL PASS

### Step 4: Commit

```bash
git add crates/hyperion-core/src/render_state.rs crates/hyperion-core/src/lib.rs
git commit -m "feat(#11): expose DirtyTracker transform bits as WASM export"
```

---

## Task 14: Temporal Culling — CullPass Skip-Bounds

**Files:**
- Modify: `ts/src/shaders/cull.wgsl`
- Modify: `ts/src/render/passes/cull-pass.ts`
- Test: `ts/src/render/passes/cull-pass.test.ts`

### Step 1: Write failing tests

Add to `cull-pass.test.ts`:

```typescript
describe('temporal culling', () => {
  it('computeInvalidationFlag returns true when camera teleports', () => {
    const prev = { x: 0, y: 0, frustumWidth: 1000 };
    const curr = { x: 600, y: 0, frustumWidth: 1000 };
    expect(computeInvalidationFlag(prev, curr)).toBe(true);
  });

  it('computeInvalidationFlag returns false for smooth pan', () => {
    const prev = { x: 0, y: 0, frustumWidth: 1000 };
    const curr = { x: 5, y: 3, frustumWidth: 1000 };
    expect(computeInvalidationFlag(prev, curr)).toBe(false);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd ts && npx vitest run src/render/passes/cull-pass.test.ts`
Expected: FAIL

### Step 3: Implement

**cull.wgsl:** Add `visibility_prev`, `dirty_bits` storage buffer bindings (separate bind group from ForwardPass). Add skip-bounds logic per design section 6.

**cull-pass.ts:**
- Add `visibility-a`, `visibility-b` buffers to ResourcePool
- Upload dirty bits each frame via `writeBuffer`
- Ping-pong visibility buffers
- `computeInvalidationFlag()` helper
- `clearBuffer()` for visibility-curr at frame start

### Step 4: Run tests

Run: `cd ts && npx vitest run src/render/passes/cull-pass.test.ts`
Expected: ALL PASS

### Step 5: Run full TS suite

Run: `cd ts && npm test`
Expected: ALL PASS

### Step 6: Commit

```bash
git add ts/src/shaders/cull.wgsl ts/src/render/passes/cull-pass.ts ts/src/render/passes/cull-pass.test.ts
git commit -m "feat(#11): temporal culling coherence via DirtyTracker skip-bounds"
```

---

## Task 15: Sized Binding Arrays — Detection Stub

**Files:**
- Modify: `ts/src/capabilities.ts`
- Test: `ts/src/capabilities.test.ts`

### Step 1: Write test

Add to `capabilities.test.ts`:

```typescript
describe('detectSizedBindingArrays', () => {
  it('returns false (proposal not yet shipped)', () => {
    const mockDevice = { features: new Set() } as unknown as GPUDevice;
    expect(detectSizedBindingArrays(mockDevice)).toBe(false);
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd ts && npx vitest run src/capabilities.test.ts`
Expected: FAIL — function not defined

### Step 3: Implement stub

Add to `ts/src/capabilities.ts`:

```typescript
/**
 * Detect WebGPU sized binding arrays support.
 * W3C proposal, not yet shipped in any browser (March 2026).
 * When available, detection will likely be via adapter.features or
 * try/catch on createBindGroupLayout with bindingArraySize.
 * See: gpuweb/proposals/sized-binding-arrays.md
 * Full design: hyperion-2026-tech-integration-design.md section 4
 */
export function detectSizedBindingArrays(_device: GPUDevice): boolean {
    return false;
}
```

Export from `ts/src/index.ts`.

### Step 4: Run tests

Run: `cd ts && npx vitest run src/capabilities.test.ts`
Expected: ALL PASS

### Step 5: Commit

```bash
git add ts/src/capabilities.ts ts/src/capabilities.test.ts ts/src/index.ts
git commit -m "feat(#12): detectSizedBindingArrays stub (proposal-stage, returns false)"
```

---

## Task 16: Texture Streaming — Mipmap Prerequisite in TextureManager

**Files:**
- Modify: `ts/src/texture-manager.ts`
- Test: `ts/src/texture-manager.test.ts`

### Step 1: Write failing test

Add to `texture-manager.test.ts`:

```typescript
describe('mipmap support', () => {
  it('creates Texture2DArray with mipLevelCount > 1', () => {
    // Verify tier creation includes mip levels
    // For 256x256 tier: log2(256) + 1 = 9 mip levels
    const manager = createTestTextureManager();
    // ... trigger tier allocation, check createTexture call
    expect(mockCreateTexture).toHaveBeenCalledWith(
      expect.objectContaining({ mipLevelCount: 9 })
    );
  });
});
```

### Step 2: Implement mipmap support

Update `TextureManager` tier creation:
- `mipLevelCount: Math.floor(Math.log2(tierSize)) + 1`
- Tier resize copies all mip levels per layer
- Sampler update: `mipmapFilter: 'linear'`

### Step 3: Run tests

Run: `cd ts && npx vitest run src/texture-manager.test.ts`
Expected: ALL PASS

### Step 4: Commit

```bash
git add ts/src/texture-manager.ts ts/src/texture-manager.test.ts
git commit -m "feat(#10): TextureManager mipmap support prerequisite for streaming"
```

---

## Task 17: Texture Streaming — KTX2StreamLoader

**Files:**
- Create: `ts/src/ktx2-stream-loader.ts`
- Create: `ts/src/ktx2-stream-loader.test.ts`

### Step 1: Write tests

```typescript
describe('KTX2StreamLoader', () => {
  it('fetchHeader parses header from first 256 bytes', async () => {
    // Mock fetch returning Range response with KTX2 header bytes
    const loader = new KTX2StreamLoader();
    const header = await loader.fetchHeader('test.ktx2');
    expect(header.vkFormat).toBeDefined();
    expect(header.levelCount).toBeGreaterThan(0);
  });

  it('isRangeSupported detects Accept-Ranges header', async () => {
    // Mock HEAD response with Accept-Ranges: bytes
    const loader = new KTX2StreamLoader();
    expect(await loader.isRangeSupported('test.ktx2')).toBe(true);
  });

  it('falls back when server returns 200 instead of 206', async () => {
    // Mock fetch returning 200 (full file)
    const loader = new KTX2StreamLoader();
    expect(await loader.isRangeSupported('no-range.ktx2')).toBe(false);
  });

  it('fetches SGD for supercompressed files', async () => {
    // Mock KTX2 with supercompressionScheme > 0
    const loader = new KTX2StreamLoader();
    const header = await loader.fetchHeader('compressed.ktx2');
    expect(header.supercompressionScheme).toBeGreaterThan(0);
    const sgd = await loader.fetchSGD('compressed.ktx2', header);
    expect(sgd.byteLength).toBeGreaterThan(0);
  });
});
```

### Step 2: Implement KTX2StreamLoader

Three-phase fetch:
- `fetchHeader(url)`: Range 0-255, parse KTX2 header + level index
- `fetchSGD(url, header)`: Range sgdOffset to sgdOffset+sgdByteLength
- `fetchMipLevel(url, header, level)`: Range for specific mip

### Step 3: Run tests

Run: `cd ts && npx vitest run src/ktx2-stream-loader.test.ts`
Expected: ALL PASS

### Step 4: Commit

```bash
git add ts/src/ktx2-stream-loader.ts ts/src/ktx2-stream-loader.test.ts
git commit -m "feat(#10): KTX2StreamLoader with Range requests and 3-phase fetch"
```

---

## Task 18: Texture Streaming — StreamingScheduler

**Files:**
- Create: `ts/src/texture-streaming.ts`
- Create: `ts/src/texture-streaming.test.ts`
- Modify: `ts/src/texture-manager.ts` (integrate scheduler)
- Modify: `ts/src/types.ts` (add config options)

### Step 1: Write tests

```typescript
describe('StreamingScheduler', () => {
  it('respects bandwidth budget per frame', async () => {
    const scheduler = new StreamingScheduler({ budgetBytesPerFrame: 1000 });
    // Enqueue 10 textures each ~500 bytes smallest mip
    // tick should process at most 2 per frame
    await scheduler.tick();
    expect(scheduler.loadedThisFrame).toBeLessThanOrEqual(1000);
  });

  it('processes textures in priority order', async () => {
    const scheduler = new StreamingScheduler({ budgetBytesPerFrame: 100000 });
    // Enqueue with different priorities
    scheduler.enqueue('far.ktx2', 100);
    scheduler.enqueue('near.ktx2', 1);
    await scheduler.tick();
    // near.ktx2 should be loaded first
    expect(scheduler.lastLoaded).toBe('near.ktx2');
  });

  it('falls back to full fetch when Range not supported', async () => {
    // Mock server without Range support
    const scheduler = new StreamingScheduler({ budgetBytesPerFrame: 100000 });
    scheduler.enqueue('no-range.ktx2', 1);
    await scheduler.tick();
    expect(scheduler.getState('no-range.ktx2')).toBe('complete');
  });
});
```

### Step 2: Implement StreamingScheduler

Per-texture state machine: `pending` → `header-fetched` → `sgd-loaded` → `partial-mips` → `complete`.

### Step 3: Integrate with TextureManager

Add `textureStreaming` and `streamingBudgetBytesPerFrame` to `HyperionConfig` in `types.ts`. TextureManager creates StreamingScheduler if enabled.

### Step 4: Run tests

Run: `cd ts && npx vitest run src/texture-streaming.test.ts && npx vitest run src/texture-manager.test.ts`
Expected: ALL PASS

### Step 5: Run full TS suite

Run: `cd ts && npm test`
Expected: ALL PASS

### Step 6: Commit

```bash
git add ts/src/texture-streaming.ts ts/src/texture-streaming.test.ts ts/src/texture-manager.ts ts/src/types.ts
git commit -m "feat(#10): StreamingScheduler for progressive KTX2 texture loading"
```

---

## Task 19: Debug Integration — Rust dev-tools Audit

**Files:**
- Modify: `crates/hyperion-core/src/*.rs` (audit all `debug_assertions` → `dev-tools`)
- Test: `cargo test -p hyperion-core` and `cargo test -p hyperion-core --features dev-tools`

### Step 1: Audit and migrate

Search for all `#[cfg(debug_assertions)]` in `crates/hyperion-core/src/`:

```bash
grep -rn "debug_assertions" crates/hyperion-core/src/
```

Replace all with `#[cfg(feature = "dev-tools")]`.

### Step 2: Verify dev-tools OFF build

Run: `cargo test -p hyperion-core`
Expected: ALL PASS (110 tests, no dev-tools code)

### Step 3: Verify dev-tools ON build

Run: `cargo test -p hyperion-core --features dev-tools`
Expected: ALL PASS (120 tests, includes dev-tools gated tests)

### Step 4: Verify release WASM excludes dev-tools

Run: `cd ts && npm run build:wasm:release && npm run check:wasm-size`
Expected: Binary < 200KB gzipped, no debug symbols

### Step 5: Commit

```bash
git add crates/hyperion-core/src/
git commit -m "fix(#15): migrate all debug_assertions to dev-tools feature flag"
```

---

## Task 20: Debug Integration — TS __DEV__ Compile-Time Constant

**Files:**
- Modify: `ts/vite.config.ts`
- Modify: `ts/src/vite-env.d.ts`
- Modify: `ts/src/backpressure.ts` (tape recorder tap → `unknown` type)
- Modify: `ts/src/hyperion.ts` (debug getter guard)
- Modify: `ts/src/replay/command-tape.ts`, `ts/src/replay/replay-player.ts`, `ts/src/replay/snapshot-manager.ts`
- Modify: `ts/src/debug/ecs-inspector.ts`, `ts/src/debug/debug-camera.ts`, `ts/src/debug/bounds-visualizer.ts`

### Step 1: Add __DEV__ constant

In `ts/vite.config.ts`, add to the config:
```typescript
define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
},
```

In `ts/src/vite-env.d.ts`, add:
```typescript
declare const __DEV__: boolean;
```

### Step 2: Guard debug modules

Add `if (!__DEV__) return;` at the top of key methods in replay/debug modules.

### Step 3: Fix tape recorder type in backpressure.ts

Change tape recorder field from `CommandTapeRecorder` import to `unknown`:
```typescript
private _debugTapeRecorder: unknown = null;
```

Remove the import of `CommandTapeRecorder` from `backpressure.ts`.

### Step 4: Guard Hyperion.debug getter

```typescript
get debug(): DebugAPI | null {
    if (!__DEV__) return null;
    // ... existing lazy init
}
```

### Step 5: Run tests (dev mode)

Run: `cd ts && npm test`
Expected: ALL PASS (tests run with `__DEV__ = true`)

### Step 6: Verify production build eliminates debug code

Run: `cd ts && npm run build && grep -c "CommandTapeRecorder\|ReplayPlayer\|SnapshotManager\|__DEV__" dist/assets/*.js`
Expected: 0 matches for each pattern

### Step 7: Commit

```bash
git add ts/vite.config.ts ts/src/vite-env.d.ts ts/src/backpressure.ts ts/src/hyperion.ts ts/src/replay/ ts/src/debug/
git commit -m "feat(#15): __DEV__ compile-time constant + tree-shakeable debug modules"
```

---

## Task 21: Final Validation + Documentation Update

**Files:**
- Modify: `CLAUDE.md`
- Modify: `hyperion-masterplan.md`

### Step 1: Full validation pipeline

Run: `cargo test -p hyperion-core && cargo clippy -p hyperion-core && cd ts && npm test && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: ALL PASS

### Step 2: WASM size check

Run: `cd ts && npm run build:wasm:release && npm run check:wasm-size`
Expected: < 200KB gzipped

### Step 3: Update CLAUDE.md

- Update Implementation Status table: add Phase 13 row
- Update test counts
- Add new components to components table (Transform2D, Depth, Transparent)
- Add new CommandType variants (SetRotation2D=14, SetTransparent=15, SetDepth=16)
- Add new WASM exports (engine_gpu_depths_ptr/len, engine_dirty_bits_ptr/u32_len)
- Add new modules to architecture tables (radix-sort-pass, ktx2-stream-loader, texture-streaming)
- Add new gotchas:
  - `__DEV__` convention for debug code elimination
  - Transform2D vs Position archetype routing
  - Transparent flag in renderMeta bit 8
  - Temporal culling invalidation threshold
- Add new test commands
- Update shader table (radix-sort.wgsl)

### Step 4: Update masterplan

Mark Phase 13 / optimization items as complete.

### Step 5: Commit

```bash
git add CLAUDE.md hyperion-masterplan.md
git commit -m "docs: update CLAUDE.md and masterplan for Phase 13 completion"
```

---

## Summary

| Task | Item | What |
|------|------|------|
| 1 | #5 | Command coalescing in BackpressuredProducer |
| 2-3 | #13 | Transform2D + Depth components + ring buffer protocol |
| 4 | #13 | EntityMap BitVec + command processor routing |
| 5 | #13 | Split velocity/transform systems (2D/3D) |
| 6 | #13 | RenderState write_slot_2d |
| 7 | #13 | EntityHandle API (.rotation overload, .depth, .transparent) |
| 8 | #13 | WASM rebuild + integration validation |
| 9-10 | #14 | Transparent in renderMeta + RadixSortPass |
| 11 | #14 | CullPass split + ForwardPass blend modes |
| 12 | #14 | Depth SoA column + WASM exports |
| 13-14 | #11 | Temporal culling (dirty bits export + skip-bounds shader) |
| 15 | #12 | detectSizedBindingArrays stub |
| 16-18 | #10 | Texture streaming (mipmaps + KTX2StreamLoader + scheduler) |
| 19-20 | #15 | Debug integration (dev-tools audit + __DEV__ + tree-shaking) |
| 21 | — | Final validation + documentation |
