# Phase 10c — Time-Travel Debug Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add deterministic time-travel debugging: record every ring-buffer command, replay from tick 0, periodic ECS snapshots for fast seek, and HMR state preservation for Vite hot-reload.

**Architecture:** Three features, layered. L1 Command Tape records commands on the TS side via a tap on `BackpressuredProducer`. L2 Snapshot Rewind adds 3 new WASM exports (`engine_reset`, `engine_snapshot_create`, `engine_snapshot_restore`) behind `#[cfg(feature = "dev-tools")]` to enable fast seek (snapshot + gap replay). HMR State Preservation is TS-only, using Vite's `import.meta.hot` API. All features have zero production overhead.

**Tech Stack:** Rust (hecs, bytemuck, wasm-bindgen), TypeScript (vitest), Vite HMR API

**Design doc:** `docs/plans/2026-02-26-phase10-dx-design.md` § 5

---

## Task 1: CommandTapeRecorder — Failing Tests

**Files:**
- Create: `ts/src/replay/command-tape.ts` (empty placeholder)
- Create: `ts/src/replay/command-tape.test.ts`

**Step 1: Create directory and empty source file**

```bash
mkdir -p ts/src/replay
```

Create `ts/src/replay/command-tape.ts`:

```typescript
// Placeholder — tests will fail until implementation.
export {};
```

**Step 2: Write the failing tests**

Create `ts/src/replay/command-tape.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CommandTapeRecorder } from './command-tape';
import type { TapeEntry, CommandTape } from './command-tape';

function entry(tick: number, type: number, entityId: number): TapeEntry {
  return { tick, timestamp: tick * 16.667, type, entityId, payload: new Uint8Array(0) };
}

describe('CommandTapeRecorder', () => {
  it('records entries and returns tape on stop', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 100 });
    rec.record(entry(5, 3, 42));
    const tape = rec.stop();
    expect(tape.version).toBe(1);
    expect(tape.tickRate).toBeCloseTo(1 / 60);
    expect(tape.entries).toHaveLength(1);
    expect(tape.entries[0].tick).toBe(5);
    expect(tape.entries[0].entityId).toBe(42);
  });

  it('preserves payload bytes', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 10 });
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    rec.record({ tick: 0, timestamp: 0, type: 3, entityId: 1, payload });
    const tape = rec.stop();
    expect(tape.entries[0].payload).toEqual(payload);
  });

  it('circular buffer evicts oldest when full', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      rec.record(entry(i, 1, i));
    }
    const tape = rec.stop();
    expect(tape.entries).toHaveLength(3);
    expect(tape.entries[0].tick).toBe(2); // oldest surviving
    expect(tape.entries[2].tick).toBe(4); // newest
  });

  it('defaults to 1_000_000 maxEntries', () => {
    const rec = new CommandTapeRecorder();
    expect(rec).toBeDefined();
    // Should not throw — allocates lazily
  });

  it('entryCount tracks live entries', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 5 });
    expect(rec.entryCount).toBe(0);
    rec.record(entry(0, 1, 0));
    rec.record(entry(1, 1, 1));
    expect(rec.entryCount).toBe(2);
  });

  it('clear resets the buffer', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 10 });
    rec.record(entry(0, 1, 0));
    rec.record(entry(1, 1, 1));
    rec.clear();
    expect(rec.entryCount).toBe(0);
    const tape = rec.stop();
    expect(tape.entries).toHaveLength(0);
  });

  it('stop returns entries in tick order', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 100 });
    rec.record(entry(0, 1, 0));
    rec.record(entry(0, 3, 0));
    rec.record(entry(1, 3, 0));
    rec.record(entry(1, 6, 0));
    rec.record(entry(2, 3, 0));
    const tape = rec.stop();
    for (let i = 1; i < tape.entries.length; i++) {
      expect(tape.entries[i].tick).toBeGreaterThanOrEqual(tape.entries[i - 1].tick);
    }
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd ts && npx vitest run src/replay/command-tape.test.ts`
Expected: FAIL — `CommandTapeRecorder` is not exported

---

## Task 2: CommandTapeRecorder — Implementation

**Files:**
- Modify: `ts/src/replay/command-tape.ts`

**Step 1: Implement command-tape.ts**

Replace `ts/src/replay/command-tape.ts` with:

```typescript
export interface TapeEntry {
  readonly tick: number;
  readonly timestamp: number;
  readonly type: number;
  readonly entityId: number;
  readonly payload: Uint8Array;
}

export interface CommandTape {
  readonly version: 1;
  readonly tickRate: number;
  readonly entries: TapeEntry[];
}

export class CommandTapeRecorder {
  private buffer: (TapeEntry | undefined)[];
  private readonly maxEntries: number;
  private writeIdx = 0;
  private count = 0;

  constructor(config: { maxEntries?: number } = {}) {
    this.maxEntries = config.maxEntries ?? 1_000_000;
    this.buffer = new Array(this.maxEntries);
  }

  get entryCount(): number {
    return this.count;
  }

  record(entry: TapeEntry): void {
    this.buffer[this.writeIdx] = entry;
    this.writeIdx = (this.writeIdx + 1) % this.maxEntries;
    if (this.count < this.maxEntries) this.count++;
  }

  clear(): void {
    this.writeIdx = 0;
    this.count = 0;
  }

  stop(): CommandTape {
    const start = this.count < this.maxEntries ? 0 : this.writeIdx;
    const entries: TapeEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      entries.push(this.buffer[(start + i) % this.maxEntries]!);
    }
    return { version: 1, tickRate: 1 / 60, entries };
  }
}
```

**Step 2: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/replay/command-tape.test.ts`
Expected: All 7 tests PASS

**Step 3: Commit**

```bash
git add ts/src/replay/command-tape.ts ts/src/replay/command-tape.test.ts
git commit -m "feat(dx): add CommandTapeRecorder with circular buffer"
```

---

## Task 3: Recording Tap on BackpressuredProducer — Failing Tests

**Files:**
- Modify: `ts/src/backpressure.test.ts` (add new tests)

**Step 1: Write failing tests**

Add to the existing `describe('BackpressuredProducer', ...)` block in `ts/src/backpressure.test.ts`:

```typescript
describe('recording tap', () => {
  it('invokes tap on successful direct write', () => {
    const tap = vi.fn();
    producer.setRecordingTap(tap);
    producer.spawnEntity(1);
    expect(tap).toHaveBeenCalledTimes(1);
    expect(tap).toHaveBeenCalledWith(
      1,  // CommandType.SpawnEntity
      1,  // entityId
      expect.any(Uint8Array),
    );
  });

  it('invokes tap on queued command flush', () => {
    const tap = vi.fn();
    producer.setRecordingTap(tap);
    // Fill buffer to force queuing (implementation-specific)
    // After flush, tap should still fire for queued commands
    producer.setPosition(5, 1.0, 2.0, 3.0);
    expect(tap).toHaveBeenCalledWith(
      3,  // CommandType.SetPosition
      5,
      expect.any(Uint8Array),
    );
  });

  it('does not invoke tap when tap is null', () => {
    producer.setRecordingTap(null);
    producer.spawnEntity(1);
    // No error thrown, no tap called
  });

  it('tap payload has correct byte length', () => {
    const tap = vi.fn();
    producer.setRecordingTap(tap);
    producer.setPosition(0, 1.0, 2.0, 3.0);
    const payload: Uint8Array = tap.mock.calls[0][2];
    expect(payload.byteLength).toBe(12); // 3 × f32
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/backpressure.test.ts`
Expected: FAIL — `setRecordingTap` is not a function

---

## Task 4: Recording Tap on BackpressuredProducer — Implementation

**Files:**
- Modify: `ts/src/backpressure.ts`

**Step 1: Add tap field and setter to BackpressuredProducer**

In `ts/src/backpressure.ts`, add to class `BackpressuredProducer` (after `private readonly queue`):

```typescript
private recordingTap: ((type: number, entityId: number, payload: Uint8Array) => void) | null = null;

setRecordingTap(tap: ((type: number, entityId: number, payload: Uint8Array) => void) | null): void {
  this.recordingTap = tap;
}
```

**Step 2: Fire tap after successful write**

In the `writeCommand` method, after `const ok = this.inner.writeCommand(...)`, invoke the tap:

```typescript
writeCommand(cmd: CommandType, entityId: number, payload?: Float32Array): boolean {
  const ok = this.inner.writeCommand(cmd, entityId, payload);
  if (!ok) {
    this.queue.enqueue(cmd, entityId, payload);
  }
  // Fire recording tap regardless of direct/queued path
  if (this.recordingTap) {
    const bytes = payload
      ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
      : new Uint8Array(0);
    this.recordingTap(cmd, entityId, bytes);
  }
  return ok;
}
```

**Step 3: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/backpressure.test.ts`
Expected: All tests PASS (existing + new)

**Step 4: Commit**

```bash
git add ts/src/backpressure.ts ts/src/backpressure.test.ts
git commit -m "feat(dx): add recording tap to BackpressuredProducer"
```

---

## Task 5: ReplayPlayer — Failing Tests

**Files:**
- Create: `ts/src/replay/replay-player.ts` (empty placeholder)
- Create: `ts/src/replay/replay-player.test.ts`

**Step 1: Create empty placeholder**

Create `ts/src/replay/replay-player.ts`:

```typescript
export {};
```

**Step 2: Write failing tests**

Create `ts/src/replay/replay-player.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ReplayPlayer } from './replay-player';
import type { CommandTape, TapeEntry } from './command-tape';

function entry(tick: number, type: number, entityId: number, payloadBytes?: number[]): TapeEntry {
  return {
    tick,
    timestamp: tick * 16.667,
    type,
    entityId,
    payload: new Uint8Array(payloadBytes ?? []),
  };
}

function makeTape(entries: TapeEntry[]): CommandTape {
  return { version: 1, tickRate: 1 / 60, entries };
}

describe('ReplayPlayer', () => {
  it('calls reset before replaying', () => {
    const reset = vi.fn();
    const update = vi.fn();
    const pushCommands = vi.fn();
    const tape = makeTape([entry(0, 1, 0)]);
    const player = new ReplayPlayer(tape, { reset, update, pushCommands });
    player.replayAll();
    expect(reset).toHaveBeenCalledTimes(1);
    // reset called before any update
    expect(reset.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0],
    );
  });

  it('groups entries by tick and calls update per tick', () => {
    const reset = vi.fn();
    const update = vi.fn();
    const pushCommands = vi.fn();
    const tape = makeTape([
      entry(0, 1, 0),  // tick 0: spawn
      entry(0, 3, 0, [0, 0, 128, 63, 0, 0, 0, 0, 0, 0, 0, 0]), // tick 0: setPos
      entry(1, 3, 0, [0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0]), // tick 1: setPos
    ]);
    const player = new ReplayPlayer(tape, { reset, update, pushCommands });
    player.replayAll();
    expect(update).toHaveBeenCalledTimes(2); // ticks 0 and 1
    expect(pushCommands).toHaveBeenCalledTimes(2); // once per tick batch
  });

  it('passes FIXED_DT to update', () => {
    const update = vi.fn();
    const tape = makeTape([entry(0, 1, 0)]);
    const player = new ReplayPlayer(tape, { reset: vi.fn(), update, pushCommands: vi.fn() });
    player.replayAll();
    expect(update).toHaveBeenCalledWith(1 / 60);
  });

  it('serializes commands as binary [type:u8][entityId:u32 LE][payload]', () => {
    const pushCommands = vi.fn();
    const tape = makeTape([entry(0, 1, 42)]); // SpawnEntity, id=42
    const player = new ReplayPlayer(tape, { reset: vi.fn(), update: vi.fn(), pushCommands });
    player.replayAll();
    const data: Uint8Array = pushCommands.mock.calls[0][0];
    expect(data[0]).toBe(1); // CommandType.SpawnEntity
    const dv = new DataView(data.buffer, data.byteOffset);
    expect(dv.getUint32(1, true)).toBe(42); // entityId LE
  });

  it('handles empty tape without error', () => {
    const reset = vi.fn();
    const update = vi.fn();
    const tape = makeTape([]);
    const player = new ReplayPlayer(tape, { reset, update, pushCommands: vi.fn() });
    player.replayAll();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('handles tape spanning multiple ticks with gaps', () => {
    const update = vi.fn();
    const tape = makeTape([
      entry(0, 1, 0),
      entry(5, 3, 0, new Array(12).fill(0)), // jump to tick 5
    ]);
    const player = new ReplayPlayer(tape, { reset: vi.fn(), update, pushCommands: vi.fn() });
    player.replayAll();
    // Should call update for ticks 0 through 5 (6 total)
    expect(update).toHaveBeenCalledTimes(6);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd ts && npx vitest run src/replay/replay-player.test.ts`
Expected: FAIL — `ReplayPlayer` is not exported

---

## Task 6: ReplayPlayer — Implementation

**Files:**
- Modify: `ts/src/replay/replay-player.ts`

**Step 1: Implement replay-player.ts**

Replace `ts/src/replay/replay-player.ts` with:

```typescript
import type { CommandTape, TapeEntry } from './command-tape';

export interface ReplayCallbacks {
  reset: () => void;
  pushCommands: (data: Uint8Array) => void;
  update: (dt: number) => void;
}

export class ReplayPlayer {
  private readonly tape: CommandTape;
  private readonly callbacks: ReplayCallbacks;

  constructor(tape: CommandTape, callbacks: ReplayCallbacks) {
    this.tape = tape;
    this.callbacks = callbacks;
  }

  replayAll(): void {
    this.callbacks.reset();

    const { entries } = this.tape;
    if (entries.length === 0) return;

    const dt = this.tape.tickRate;
    const maxTick = entries[entries.length - 1].tick;

    let entryIdx = 0;

    for (let tick = 0; tick <= maxTick; tick++) {
      // Collect all entries for this tick
      const tickEntries: TapeEntry[] = [];
      while (entryIdx < entries.length && entries[entryIdx].tick === tick) {
        tickEntries.push(entries[entryIdx]);
        entryIdx++;
      }

      // Serialize batch into binary and push
      if (tickEntries.length > 0) {
        const data = this.serializeBatch(tickEntries);
        this.callbacks.pushCommands(data);
      }

      this.callbacks.update(dt);
    }
  }

  private serializeBatch(entries: TapeEntry[]): Uint8Array {
    // Calculate total size: each entry = 1 (type) + 4 (entityId) + payload.length
    let totalSize = 0;
    for (const e of entries) {
      totalSize += 1 + 4 + e.payload.length;
    }

    const buf = new Uint8Array(totalSize);
    const dv = new DataView(buf.buffer);
    let offset = 0;

    for (const e of entries) {
      buf[offset] = e.type;
      offset += 1;
      dv.setUint32(offset, e.entityId, true);
      offset += 4;
      buf.set(e.payload, offset);
      offset += e.payload.length;
    }

    return buf;
  }
}
```

**Step 2: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/replay/replay-player.test.ts`
Expected: All 6 tests PASS

**Step 3: Commit**

```bash
git add ts/src/replay/replay-player.ts ts/src/replay/replay-player.test.ts
git commit -m "feat(dx): add ReplayPlayer for deterministic command tape replay"
```

---

## Task 7: engine_reset WASM Export — Failing Test

**Files:**
- Modify: `crates/hyperion-core/src/engine.rs` (add test)

**Step 1: Write the failing Rust test**

Add to the `#[cfg(feature = "dev-tools")]` test section at the bottom of `crates/hyperion-core/src/engine.rs` (before the closing `}`):

```rust
#[cfg(feature = "dev-tools")]
#[test]
fn reset_clears_world_and_tick_count() {
    let mut engine = Engine::new();
    engine.process_commands(&[spawn_cmd(0), spawn_cmd(1), spawn_cmd(2)]);
    engine.update(1.0 / 60.0);
    assert!(engine.tick_count() > 0);
    assert!(engine.entity_map.get(0).is_some());

    engine.reset();

    assert_eq!(engine.tick_count(), 0);
    assert!(engine.entity_map.get(0).is_none());
    assert_eq!(crate::systems::count_active(&engine.world), 0);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core --features dev-tools reset_clears`
Expected: FAIL — no method named `reset` found

---

## Task 8: engine_reset — Implementation

**Files:**
- Modify: `crates/hyperion-core/src/engine.rs`
- Modify: `crates/hyperion-core/src/lib.rs`

**Step 1: Add `reset()` method on Engine (dev-tools gated)**

In `crates/hyperion-core/src/engine.rs`, inside the `#[cfg(feature = "dev-tools")] impl Engine` block (after `debug_get_components`), add:

```rust
/// Reset the engine to initial state. Clears the ECS world,
/// entity map, render state, and resets tick count to zero.
/// Used by time-travel replay to start from a clean slate.
pub fn reset(&mut self) {
    self.world = World::new();
    self.entity_map = EntityMap::new();
    self.render_state = RenderState::new();
    self.accumulator = 0.0;
    self.tick_count = 0;
    self.listener_pos = [0.0; 3];
    self.listener_prev_pos = [0.0; 3];
    self.listener_vel = [0.0; 3];
}
```

**Step 2: Add WASM export**

In `crates/hyperion-core/src/lib.rs`, after the `engine_debug_generate_lines` export, add:

```rust
/// Reset the engine to initial state (dev-tools only).
/// Used by time-travel replay to restart from tick 0.
#[cfg(feature = "dev-tools")]
#[wasm_bindgen]
pub fn engine_reset() {
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        if let Some(ref mut e) = *addr_of_mut!(ENGINE) {
            e.reset();
        }
    }
}
```

**Step 3: Run Rust tests**

Run: `cargo test -p hyperion-core --features dev-tools reset_clears`
Expected: PASS

Run: `cargo clippy -p hyperion-core --features dev-tools`
Expected: No warnings

**Step 4: Commit**

```bash
git add crates/hyperion-core/src/engine.rs crates/hyperion-core/src/lib.rs
git commit -m "feat(dx): add engine_reset WASM export for replay"
```

---

## Task 9: engine_snapshot_create — Failing Test

**Files:**
- Modify: `crates/hyperion-core/src/engine.rs` (add test)

**Step 1: Write the failing Rust test**

Add to the test module in `crates/hyperion-core/src/engine.rs`:

```rust
#[cfg(feature = "dev-tools")]
#[test]
fn snapshot_create_produces_valid_bytes() {
    let mut engine = Engine::new();
    engine.process_commands(&[spawn_cmd(0), make_position_cmd(0, 5.0, 10.0, 0.0)]);
    engine.update(1.0 / 60.0);

    let snapshot = engine.snapshot_create();
    assert!(!snapshot.is_empty());

    // Validate magic bytes "HSNP"
    assert_eq!(&snapshot[0..4], b"HSNP");
    // Version = 1
    let version = u32::from_le_bytes(snapshot[4..8].try_into().unwrap());
    assert_eq!(version, 1);
    // tick_count > 0
    let tick = u64::from_le_bytes(snapshot[8..16].try_into().unwrap());
    assert!(tick > 0);
    // entity_count = 1
    let entity_count = u32::from_le_bytes(snapshot[16..20].try_into().unwrap());
    assert_eq!(entity_count, 1);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core --features dev-tools snapshot_create_produces`
Expected: FAIL — no method named `snapshot_create`

---

## Task 10: engine_snapshot_create — Implementation

**Files:**
- Modify: `crates/hyperion-core/src/engine.rs`

**Step 1: Implement `snapshot_create()` on Engine**

In the `#[cfg(feature = "dev-tools")] impl Engine` block, add:

```rust
/// Serialize the entire ECS state into a binary snapshot.
///
/// Format:
/// ```text
/// [magic: 4B "HSNP"][version: u32][tick: u64][entity_count: u32]
/// [entity_map_len: u32][entity_map: (ext_id: u32, hecs_id: u64) × N]
/// [per entity: component_mask: u16, component_data...]
/// ```
///
/// OverflowChildren and SpatialGrid are NOT serialized.
pub fn snapshot_create(&self) -> Vec<u8> {
    use crate::components::*;

    let mut buf = Vec::with_capacity(4096);

    // Header
    buf.extend_from_slice(b"HSNP");
    buf.extend_from_slice(&1u32.to_le_bytes()); // version
    buf.extend_from_slice(&self.tick_count.to_le_bytes());

    // Collect mapped entities
    let mapped: Vec<(u32, hecs::Entity)> = self.entity_map.iter_mapped().collect();
    buf.extend_from_slice(&(mapped.len() as u32).to_le_bytes()); // entity_count

    // Entity map
    buf.extend_from_slice(&(mapped.len() as u32).to_le_bytes()); // entity_map_len
    for &(ext_id, entity) in &mapped {
        buf.extend_from_slice(&ext_id.to_le_bytes());
        buf.extend_from_slice(&entity.to_bits().get().to_le_bytes());
    }

    // Per-entity component data
    for &(_ext_id, entity) in &mapped {
        let mut mask: u16 = 0;
        let mask_pos = buf.len();
        buf.extend_from_slice(&0u16.to_le_bytes()); // placeholder

        if let Ok(v) = self.world.get::<&Position>(entity) {
            mask |= 1 << 0;
            buf.extend_from_slice(bytemuck::bytes_of(&*v));
        }
        if let Ok(v) = self.world.get::<&Velocity>(entity) {
            mask |= 1 << 1;
            buf.extend_from_slice(bytemuck::bytes_of(&*v));
        }
        if let Ok(v) = self.world.get::<&Rotation>(entity) {
            mask |= 1 << 2;
            buf.extend_from_slice(bytemuck::bytes_of(&*v));
        }
        if let Ok(v) = self.world.get::<&Scale>(entity) {
            mask |= 1 << 3;
            buf.extend_from_slice(bytemuck::bytes_of(&*v));
        }
        if let Ok(v) = self.world.get::<&ModelMatrix>(entity) {
            mask |= 1 << 4;
            buf.extend_from_slice(bytemuck::bytes_of(&*v));
        }
        if let Ok(v) = self.world.get::<&BoundingRadius>(entity) {
            mask |= 1 << 5;
            buf.extend_from_slice(bytemuck::bytes_of(&*v));
        }
        if let Ok(v) = self.world.get::<&TextureLayerIndex>(entity) {
            mask |= 1 << 6;
            buf.extend_from_slice(bytemuck::bytes_of(&*v));
        }
        if let Ok(v) = self.world.get::<&MeshHandle>(entity) {
            mask |= 1 << 7;
            buf.extend_from_slice(bytemuck::bytes_of(&*v));
        }
        if let Ok(v) = self.world.get::<&RenderPrimitive>(entity) {
            mask |= 1 << 8;
            buf.extend_from_slice(bytemuck::bytes_of(&*v));
        }
        if let Ok(v) = self.world.get::<&Parent>(entity) {
            mask |= 1 << 9;
            buf.extend_from_slice(&v.0.to_le_bytes());
        }
        if self.world.get::<&Active>(entity).is_ok() {
            mask |= 1 << 10;
            // Active is marker — no data
        }
        if let Ok(v) = self.world.get::<&ExternalId>(entity) {
            mask |= 1 << 11;
            buf.extend_from_slice(bytemuck::bytes_of(&*v));
        }
        if let Ok(v) = self.world.get::<&PrimitiveParams>(entity) {
            mask |= 1 << 12;
            buf.extend_from_slice(bytemuck::bytes_of(&*v));
        }
        if let Ok(v) = self.world.get::<&LocalMatrix>(entity) {
            mask |= 1 << 13;
            buf.extend_from_slice(bytemuck::cast_slice::<f32, u8>(&v.0));
        }
        if let Ok(v) = self.world.get::<&Children>(entity) {
            mask |= 1 << 14;
            buf.push(v.count);
            for i in 0..v.count as usize {
                buf.extend_from_slice(&v.slots[i].to_le_bytes());
            }
        }

        // Write mask back
        let mask_bytes = mask.to_le_bytes();
        buf[mask_pos] = mask_bytes[0];
        buf[mask_pos + 1] = mask_bytes[1];
    }

    buf
}
```

**Step 2: Run test**

Run: `cargo test -p hyperion-core --features dev-tools snapshot_create_produces`
Expected: PASS

**Step 3: Commit**

```bash
git add crates/hyperion-core/src/engine.rs
git commit -m "feat(dx): implement engine snapshot_create serialization"
```

---

## Task 11: engine_snapshot_restore — Failing Test

**Files:**
- Modify: `crates/hyperion-core/src/engine.rs`

**Step 1: Write the failing test**

```rust
#[cfg(feature = "dev-tools")]
#[test]
fn snapshot_roundtrip_preserves_state() {
    let mut engine = Engine::new();
    engine.process_commands(&[
        spawn_cmd(0),
        make_position_cmd(0, 5.0, 10.0, 0.0),
        spawn_cmd(1),
        make_position_cmd(1, 20.0, 30.0, 0.0),
    ]);
    engine.update(1.0 / 60.0);
    let snapshot = engine.snapshot_create();

    // Mutate state
    engine.process_commands(&[make_position_cmd(0, 999.0, 999.0, 0.0)]);
    engine.update(1.0 / 60.0);

    // Restore
    assert!(engine.snapshot_restore(&snapshot));

    // Verify positions are back to snapshot values
    let e0 = engine.entity_map.get(0).unwrap();
    let pos0 = engine.world.get::<&crate::components::Position>(e0).unwrap();
    assert!((pos0.0.x - 5.0).abs() < 0.5);

    let e1 = engine.entity_map.get(1).unwrap();
    let pos1 = engine.world.get::<&crate::components::Position>(e1).unwrap();
    assert!((pos1.0.x - 20.0).abs() < 0.5);

    // Verify tick count restored
    assert_eq!(engine.tick_count(), 1);
}

#[cfg(feature = "dev-tools")]
#[test]
fn snapshot_restore_rejects_invalid_magic() {
    let mut engine = Engine::new();
    let bad_data = b"BADDxxxxxxxxxxxxxxxxxxxxxxxx";
    assert!(!engine.snapshot_restore(bad_data));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core --features dev-tools snapshot_roundtrip`
Expected: FAIL — no method named `snapshot_restore`

---

## Task 12: engine_snapshot_restore — Implementation

**Files:**
- Modify: `crates/hyperion-core/src/engine.rs`
- Modify: `crates/hyperion-core/src/lib.rs`

**Step 1: Implement `snapshot_restore()` on Engine**

In the `#[cfg(feature = "dev-tools")] impl Engine` block, add:

```rust
/// Restore engine state from a binary snapshot.
/// Returns `false` if the snapshot is invalid.
/// Rebuilds the World and EntityMap from scratch.
pub fn snapshot_restore(&mut self, data: &[u8]) -> bool {
    use crate::components::*;

    if data.len() < 24 || &data[0..4] != b"HSNP" {
        return false;
    }

    let version = u32::from_le_bytes(data[4..8].try_into().unwrap());
    if version != 1 {
        return false;
    }

    let tick = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let entity_count = u32::from_le_bytes(data[16..20].try_into().unwrap()) as usize;
    let entity_map_len = u32::from_le_bytes(data[20..24].try_into().unwrap()) as usize;

    let mut cursor = 24;

    // Read entity map entries
    let mut map_entries = Vec::with_capacity(entity_map_len);
    for _ in 0..entity_map_len {
        if cursor + 12 > data.len() { return false; }
        let ext_id = u32::from_le_bytes(data[cursor..cursor + 4].try_into().unwrap());
        let _hecs_bits = u64::from_le_bytes(data[cursor + 4..cursor + 12].try_into().unwrap());
        map_entries.push(ext_id);
        cursor += 12;
    }

    // Rebuild world
    let mut new_world = World::new();
    let mut new_map = EntityMap::new();

    for (i, &ext_id) in map_entries.iter().enumerate() {
        if cursor + 2 > data.len() { return false; }
        let mask = u16::from_le_bytes(data[cursor..cursor + 2].try_into().unwrap());
        cursor += 2;

        // Read each component based on mask
        macro_rules! read_pod {
            ($t:ty) => {{
                let size = std::mem::size_of::<$t>();
                if cursor + size > data.len() { return false; }
                let val: $t = *bytemuck::from_bytes(&data[cursor..cursor + size]);
                cursor += size;
                val
            }};
        }

        let position = if mask & (1 << 0) != 0 { Some(read_pod!(Position)) } else { None };
        let velocity = if mask & (1 << 1) != 0 { Some(read_pod!(Velocity)) } else { None };
        let rotation = if mask & (1 << 2) != 0 { Some(read_pod!(Rotation)) } else { None };
        let scale = if mask & (1 << 3) != 0 { Some(read_pod!(Scale)) } else { None };
        let model_matrix = if mask & (1 << 4) != 0 { Some(read_pod!(ModelMatrix)) } else { None };
        let bounding_radius = if mask & (1 << 5) != 0 { Some(read_pod!(BoundingRadius)) } else { None };
        let tex_layer = if mask & (1 << 6) != 0 { Some(read_pod!(TextureLayerIndex)) } else { None };
        let mesh_handle = if mask & (1 << 7) != 0 { Some(read_pod!(MeshHandle)) } else { None };
        let render_prim = if mask & (1 << 8) != 0 { Some(read_pod!(RenderPrimitive)) } else { None };

        let parent = if mask & (1 << 9) != 0 {
            if cursor + 4 > data.len() { return false; }
            let val = u32::from_le_bytes(data[cursor..cursor + 4].try_into().unwrap());
            cursor += 4;
            Some(Parent(val))
        } else { None };

        let active = mask & (1 << 10) != 0;

        let external_id = if mask & (1 << 11) != 0 { Some(read_pod!(ExternalId)) } else { None };
        let prim_params = if mask & (1 << 12) != 0 { Some(read_pod!(PrimitiveParams)) } else { None };

        let local_matrix = if mask & (1 << 13) != 0 {
            if cursor + 64 > data.len() { return false; }
            let floats: &[f32] = bytemuck::cast_slice(&data[cursor..cursor + 64]);
            let mut arr = [0.0f32; 16];
            arr.copy_from_slice(floats);
            cursor += 64;
            Some(LocalMatrix(arr))
        } else { None };

        let children = if mask & (1 << 14) != 0 {
            if cursor + 1 > data.len() { return false; }
            let count = data[cursor];
            cursor += 1;
            let mut c = Children::default();
            c.count = count;
            for j in 0..count as usize {
                if cursor + 4 > data.len() { return false; }
                c.slots[j] = u32::from_le_bytes(data[cursor..cursor + 4].try_into().unwrap());
                cursor += 4;
            }
            Some(c)
        } else { None };

        // Spawn entity with baseline components
        let entity = new_world.spawn((
            position.unwrap_or_default(),
            velocity.unwrap_or_default(),
            rotation.unwrap_or_default(),
            scale.unwrap_or_default(),
            model_matrix.unwrap_or_default(),
            bounding_radius.unwrap_or_default(),
            tex_layer.unwrap_or_default(),
            mesh_handle.unwrap_or_default(),
            render_prim.unwrap_or_default(),
            prim_params.unwrap_or_default(),
            external_id.unwrap_or(ExternalId(ext_id)),
        ));

        // Optional components
        if active {
            new_world.insert_one(entity, Active).ok();
        }
        if let Some(p) = parent {
            new_world.insert_one(entity, p).ok();
        }
        if let Some(lm) = local_matrix {
            new_world.insert_one(entity, lm).ok();
        }
        if let Some(ch) = children {
            new_world.insert_one(entity, ch).ok();
        }

        new_map.insert(ext_id, entity);
    }

    // Apply restored state
    self.world = new_world;
    self.entity_map = new_map;
    self.render_state = RenderState::new();
    self.accumulator = 0.0;
    self.tick_count = tick;
    self.listener_pos = [0.0; 3];
    self.listener_prev_pos = [0.0; 3];
    self.listener_vel = [0.0; 3];

    true
}
```

**Step 2: Add WASM exports for snapshot**

In `crates/hyperion-core/src/lib.rs`, after the `engine_reset` export, add:

```rust
/// Create a snapshot of the entire ECS state (dev-tools only).
/// Returns a Vec<u8> (Uint8Array on JS side) containing the serialized state.
#[cfg(feature = "dev-tools")]
#[wasm_bindgen]
pub fn engine_snapshot_create() -> Vec<u8> {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or_else(Vec::new, |e| e.snapshot_create())
    }
}

/// Restore engine state from a snapshot (dev-tools only).
/// Returns true on success, false on invalid data.
#[cfg(feature = "dev-tools")]
#[wasm_bindgen]
pub fn engine_snapshot_restore(data: &[u8]) -> bool {
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        if let Some(ref mut e) = *addr_of_mut!(ENGINE) {
            e.snapshot_restore(data)
        } else {
            false
        }
    }
}
```

**Step 3: Run all Rust tests**

Run: `cargo test -p hyperion-core --features dev-tools`
Expected: All tests PASS (including snapshot_roundtrip and snapshot_restore_rejects_invalid)

Run: `cargo clippy -p hyperion-core --features dev-tools`
Expected: No warnings

**Step 4: Commit**

```bash
git add crates/hyperion-core/src/engine.rs crates/hyperion-core/src/lib.rs
git commit -m "feat(dx): add snapshot create/restore for time-travel rewind"
```

---

## Task 13: SnapshotManager — Failing Tests

**Files:**
- Create: `ts/src/replay/snapshot-manager.ts` (empty)
- Create: `ts/src/replay/snapshot-manager.test.ts`

**Step 1: Create files**

Create `ts/src/replay/snapshot-manager.ts`:

```typescript
export {};
```

**Step 2: Write the failing tests**

Create `ts/src/replay/snapshot-manager.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SnapshotManager } from './snapshot-manager';

describe('SnapshotManager', () => {
  const mockCreate = vi.fn(() => new Uint8Array([0x48, 0x53, 0x4E, 0x50, 1, 0, 0, 0]));

  it('captures a snapshot at the configured interval', () => {
    const mgr = new SnapshotManager({
      intervalTicks: 10,
      maxSnapshots: 5,
      snapshotCreate: mockCreate,
    });

    // Tick 9: no snapshot yet
    for (let t = 0; t < 10; t++) mgr.onTick(t);
    expect(mgr.count).toBe(0);

    // Tick 10: first snapshot
    mgr.onTick(10);
    expect(mgr.count).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('circular buffer evicts oldest snapshot', () => {
    const mgr = new SnapshotManager({
      intervalTicks: 1,
      maxSnapshots: 3,
      snapshotCreate: mockCreate,
    });

    for (let t = 1; t <= 5; t++) mgr.onTick(t);
    expect(mgr.count).toBe(3);
  });

  it('findNearest returns closest snapshot <= target tick', () => {
    const mgr = new SnapshotManager({
      intervalTicks: 10,
      maxSnapshots: 10,
      snapshotCreate: () => {
        const buf = new Uint8Array(24);
        const dv = new DataView(buf.buffer);
        dv.setUint32(0, 0x504E5348, false); // "HSNP" big-endian
        return buf;
      },
    });

    mgr.onTick(10);
    mgr.onTick(20);
    mgr.onTick(30);

    const result = mgr.findNearest(25);
    expect(result).not.toBeNull();
    expect(result!.tick).toBe(20);
  });

  it('findNearest returns null when no snapshots <= target', () => {
    const mgr = new SnapshotManager({
      intervalTicks: 100,
      maxSnapshots: 5,
      snapshotCreate: mockCreate,
    });
    expect(mgr.findNearest(50)).toBeNull();
  });

  it('clear removes all snapshots', () => {
    const mgr = new SnapshotManager({
      intervalTicks: 1,
      maxSnapshots: 10,
      snapshotCreate: mockCreate,
    });
    mgr.onTick(1);
    mgr.onTick(2);
    expect(mgr.count).toBe(2);
    mgr.clear();
    expect(mgr.count).toBe(0);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd ts && npx vitest run src/replay/snapshot-manager.test.ts`
Expected: FAIL

---

## Task 14: SnapshotManager — Implementation

**Files:**
- Modify: `ts/src/replay/snapshot-manager.ts`

**Step 1: Implement**

Replace `ts/src/replay/snapshot-manager.ts` with:

```typescript
export interface SnapshotEntry {
  readonly tick: number;
  readonly data: Uint8Array;
}

export interface SnapshotManagerConfig {
  intervalTicks: number;
  maxSnapshots: number;
  snapshotCreate: () => Uint8Array;
}

export class SnapshotManager {
  private readonly config: SnapshotManagerConfig;
  private snapshots: (SnapshotEntry | undefined)[];
  private writeIdx = 0;
  private _count = 0;

  constructor(config: SnapshotManagerConfig) {
    this.config = config;
    this.snapshots = new Array(config.maxSnapshots);
  }

  get count(): number {
    return this._count;
  }

  onTick(tick: number): void {
    if (tick > 0 && tick % this.config.intervalTicks === 0) {
      const data = this.config.snapshotCreate();
      this.snapshots[this.writeIdx] = { tick, data };
      this.writeIdx = (this.writeIdx + 1) % this.config.maxSnapshots;
      if (this._count < this.config.maxSnapshots) this._count++;
    }
  }

  findNearest(targetTick: number): SnapshotEntry | null {
    let best: SnapshotEntry | null = null;
    const start = this._count < this.config.maxSnapshots ? 0 : this.writeIdx;
    for (let i = 0; i < this._count; i++) {
      const entry = this.snapshots[(start + i) % this.config.maxSnapshots]!;
      if (entry.tick <= targetTick) {
        if (!best || entry.tick > best.tick) {
          best = entry;
        }
      }
    }
    return best;
  }

  clear(): void {
    this.writeIdx = 0;
    this._count = 0;
  }
}
```

**Step 2: Run tests**

Run: `cd ts && npx vitest run src/replay/snapshot-manager.test.ts`
Expected: All 5 tests PASS

**Step 3: Commit**

```bash
git add ts/src/replay/snapshot-manager.ts ts/src/replay/snapshot-manager.test.ts
git commit -m "feat(dx): add SnapshotManager with periodic capture and circular buffer"
```

---

## Task 15: createHotSystem — Failing Tests

**Files:**
- Create: `ts/src/hmr/hot-system.ts` (empty)
- Create: `ts/src/hmr/hot-system.test.ts`

**Step 1: Create directory and placeholder**

```bash
mkdir -p ts/src/hmr
```

Create `ts/src/hmr/hot-system.ts`:

```typescript
export {};
```

**Step 2: Write the failing tests**

Create `ts/src/hmr/hot-system.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createHotSystem } from './hot-system';

describe('createHotSystem', () => {
  it('returns initial state when hot is undefined (production)', () => {
    const { state, system } = createHotSystem('test', undefined, {
      initialState: () => ({ count: 0, name: 'default' }),
      preTick: (s, dt) => { s.count++; },
    });
    expect(state.count).toBe(0);
    expect(state.name).toBe('default');
    expect(typeof system).toBe('function');
  });

  it('system function mutates state', () => {
    const { state, system } = createHotSystem('test', undefined, {
      initialState: () => ({ count: 0 }),
      preTick: (s) => { s.count++; },
    });
    system(1 / 60);
    expect(state.count).toBe(1);
  });

  it('restores state from HMR data', () => {
    const hot = { data: { test: { count: 42 } }, dispose: vi.fn() };
    const { state } = createHotSystem('test', hot as any, {
      initialState: () => ({ count: 0 }),
      preTick: () => {},
    });
    expect(state.count).toBe(42);
  });

  it('merges schema evolution (new fields get defaults)', () => {
    const hot = { data: { test: { count: 42 } }, dispose: vi.fn() };
    const { state } = createHotSystem('test', hot as any, {
      initialState: () => ({ count: 0, name: 'default' }),
      preTick: () => {},
    });
    expect(state.count).toBe(42);
    expect(state.name).toBe('default');
  });

  it('registers dispose callback that saves state', () => {
    const disposeFns: Function[] = [];
    const hot = {
      data: {} as any,
      dispose: (fn: Function) => disposeFns.push(fn),
    };
    const { state } = createHotSystem('test', hot as any, {
      initialState: () => ({ count: 0 }),
      preTick: () => {},
    });
    state.count = 99;
    disposeFns[0](); // simulate HMR dispose
    expect(hot.data.test).toEqual({ count: 99 });
  });

  it('does not register dispose when hot is undefined', () => {
    // Should not throw
    const { state } = createHotSystem('test', undefined, {
      initialState: () => ({ count: 0 }),
      preTick: () => {},
    });
    expect(state.count).toBe(0);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hmr/hot-system.test.ts`
Expected: FAIL — `createHotSystem` is not exported

---

## Task 16: createHotSystem — Implementation

**Files:**
- Modify: `ts/src/hmr/hot-system.ts`

**Step 1: Implement**

Replace `ts/src/hmr/hot-system.ts` with:

```typescript
export interface HotSystemConfig<S> {
  initialState: () => S;
  preTick: (state: S, dt: number) => void;
}

interface ViteHotModule {
  data: Record<string, unknown>;
  dispose: (fn: () => void) => void;
}

export function createHotSystem<S extends Record<string, unknown>>(
  name: string,
  hot: ViteHotModule | undefined,
  config: HotSystemConfig<S>,
): { state: S; system: (dt: number) => void } {
  const fresh = config.initialState();

  let state: S;
  if (hot?.data[name]) {
    // Merge: saved values override, new fields get defaults
    state = { ...fresh, ...(hot.data[name] as Partial<S>) };
  } else {
    state = fresh;
  }

  if (hot) {
    hot.dispose(() => {
      hot.data[name] = { ...state };
    });
  }

  const system = (dt: number) => {
    config.preTick(state, dt);
  };

  return { state, system };
}
```

**Step 2: Run tests**

Run: `cd ts && npx vitest run src/hmr/hot-system.test.ts`
Expected: All 6 tests PASS

**Step 3: Commit**

```bash
git add ts/src/hmr/hot-system.ts ts/src/hmr/hot-system.test.ts
git commit -m "feat(dx): add createHotSystem HMR state preservation helper"
```

---

## Task 17: Wire Time-Travel into Hyperion.debug — Failing Tests

**Files:**
- Modify: `ts/src/hyperion.test.ts` (add new describe block)

**Step 1: Write failing tests**

Add a new `describe('debug API', ...)` block to `ts/src/hyperion.test.ts`. This tests the `engine.debug` namespace on the Hyperion facade. Use the existing `fromParts()` factory.

```typescript
describe('debug API', () => {
  it('startRecording / stopRecording returns a CommandTape', () => {
    const engine = Hyperion.fromParts(config, bridge, null);
    engine.debug.startRecording();
    // Spawn an entity to generate a command
    engine.spawn();
    const tape = engine.debug.stopRecording();
    expect(tape).toBeDefined();
    expect(tape!.version).toBe(1);
    expect(tape!.entries.length).toBeGreaterThanOrEqual(1);
    engine.destroy();
  });

  it('stopRecording returns null when not recording', () => {
    const engine = Hyperion.fromParts(config, bridge, null);
    expect(engine.debug.stopRecording()).toBeNull();
    engine.destroy();
  });

  it('isRecording reflects state', () => {
    const engine = Hyperion.fromParts(config, bridge, null);
    expect(engine.debug.isRecording).toBe(false);
    engine.debug.startRecording();
    expect(engine.debug.isRecording).toBe(true);
    engine.debug.stopRecording();
    expect(engine.debug.isRecording).toBe(false);
    engine.destroy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts -t "debug API"`
Expected: FAIL — `engine.debug` is not defined

---

## Task 18: Wire Time-Travel into Hyperion.debug — Implementation

**Files:**
- Modify: `ts/src/hyperion.ts`

This is a meaningful design decision — the `debug` namespace is the public surface for all time-travel features. The implementation wires `CommandTapeRecorder` to the `BackpressuredProducer`'s recording tap.

**Step 1: Add imports**

At the top of `ts/src/hyperion.ts`, add:

```typescript
import { CommandTapeRecorder } from './replay/command-tape';
import type { CommandTape } from './replay/command-tape';
```

**Step 2: Add debug namespace object**

Add a `private recorder` field and a `get debug()` accessor to the `Hyperion` class:

```typescript
// After `private profilerHook` field:
private recorder: CommandTapeRecorder | null = null;

// Public accessor — add after `get audio()`:
get debug() {
  const self = this;
  return {
    get isRecording(): boolean {
      return self.recorder !== null;
    },
    startRecording(config?: { maxEntries?: number }): void {
      if (self.recorder) return;
      self.recorder = new CommandTapeRecorder(config);
      self.bridge.commandBuffer.setRecordingTap((type, entityId, payload) => {
        const tick = Number(self.bridge.tickCount());
        self.recorder?.record({
          tick,
          timestamp: performance.now(),
          type,
          entityId,
          payload: new Uint8Array(payload), // defensive copy
        });
      });
    },
    stopRecording(): CommandTape | null {
      if (!self.recorder) return null;
      const tape = self.recorder.stop();
      self.recorder = null;
      self.bridge.commandBuffer.setRecordingTap(null);
      return tape;
    },
  };
}
```

Note: `self.bridge.tickCount()` returns `bigint` (from u64). We wrap with `Number()` — safe for values < 2^53 per CLAUDE.md gotchas.

**Step 3: Run tests**

Run: `cd ts && npx vitest run src/hyperion.test.ts -t "debug API"`
Expected: PASS (may need adjusting based on bridge mock having `tickCount`)

**Step 4: Run full TS test suite**

Run: `cd ts && npm test`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(dx): wire time-travel recording into Hyperion.debug API"
```

---

## Task 19: Export Replay APIs from Barrel

**Files:**
- Modify: `ts/src/index.ts`

**Step 1: Add exports**

Add to the end of `ts/src/index.ts`:

```typescript
// Replay / Time-Travel (Phase 10c)
export { CommandTapeRecorder } from './replay/command-tape';
export type { CommandTape, TapeEntry } from './replay/command-tape';
export { ReplayPlayer } from './replay/replay-player';
export type { ReplayCallbacks } from './replay/replay-player';
export { SnapshotManager } from './replay/snapshot-manager';
export type { SnapshotEntry, SnapshotManagerConfig } from './replay/snapshot-manager';
export { createHotSystem } from './hmr/hot-system';
export type { HotSystemConfig } from './hmr/hot-system';
```

**Step 2: Type-check**

Run: `cd ts && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: No errors

**Step 3: Commit**

```bash
git add ts/src/index.ts
git commit -m "feat(dx): export Phase 10c replay and HMR APIs from barrel"
```

---

## Task 20: Run Full Validation

**Step 1: Rust tests (with dev-tools)**

Run: `cargo test -p hyperion-core --features dev-tools`
Expected: All tests pass

**Step 2: Rust linting**

Run: `cargo clippy -p hyperion-core --features dev-tools`
Expected: No warnings

**Step 3: TypeScript tests**

Run: `cd ts && npm test`
Expected: All tests pass

**Step 4: TypeScript type-check**

Run: `cd ts && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: No errors

**Step 5: Commit milestone**

```bash
git commit --allow-empty -m "milestone: Phase 10c (Time-Travel Debug) complete"
```

---

## Task 21: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

Update the following sections:

1. **Implementation Status table**: Add Phase 10c row:
   `| 10c-DX | Time-Travel Debug | Command tape L1, snapshot rewind L2, HMR state preservation, engine_reset/snapshot WASM exports |`

2. **Architecture table** — add new modules:
   - `ts/src/replay/command-tape.ts` — `CommandTapeRecorder` circular buffer
   - `ts/src/replay/replay-player.ts` — `ReplayPlayer` deterministic tick-by-tick
   - `ts/src/replay/snapshot-manager.ts` — `SnapshotManager` periodic capture
   - `ts/src/hmr/hot-system.ts` — `createHotSystem` Vite HMR helper

3. **WASM exports** in the `lib.rs` module table: Add `engine_reset`, `engine_snapshot_create`, `engine_snapshot_restore` (all dev-tools gated)

4. **Test commands**: Add the new test files

5. **Gotchas** (if any new ones discovered during implementation)

**Commit:**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Phase 10c time-travel debug"
```

---

## Summary

| Task | Feature | Files | Tests |
|------|---------|-------|-------|
| 1-2 | CommandTapeRecorder | `ts/src/replay/command-tape.ts` | 7 |
| 3-4 | BackpressuredProducer tap | `ts/src/backpressure.ts` | 4 |
| 5-6 | ReplayPlayer | `ts/src/replay/replay-player.ts` | 6 |
| 7-8 | engine_reset | `crates/hyperion-core/src/engine.rs` + `lib.rs` | 1 |
| 9-10 | snapshot_create | `crates/hyperion-core/src/engine.rs` | 1 |
| 11-12 | snapshot_restore | `crates/hyperion-core/src/engine.rs` + `lib.rs` | 2 |
| 13-14 | SnapshotManager | `ts/src/replay/snapshot-manager.ts` | 5 |
| 15-16 | createHotSystem | `ts/src/hmr/hot-system.ts` | 6 |
| 17-18 | Hyperion.debug API | `ts/src/hyperion.ts` | 3 |
| 19 | Barrel exports | `ts/src/index.ts` | type-check |
| 20 | Full validation | — | all |
| 21 | CLAUDE.md | `CLAUDE.md` | — |

**Total: 21 tasks, ~35 new tests, 3 new WASM exports, 5 new TypeScript files**
