# Phase 2: Render Core — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add WebGPU rendering to Hyperion — initialize the GPU pipeline, render instanced colored quads at entity positions, support all three execution modes (A/B/C), and display a debug overlay.

**Architecture:** TypeScript manages the WebGPU pipeline (adapter, device, pipeline, buffers) while Rust/WASM provides render-ready data (contiguous model matrix buffer). Commands flow TS→WASM via `engine_push_commands(&[u8])` — the worker extracts unread bytes from the SAB ring buffer and passes them as a flat byte array, sidestepping the SAB-to-WASM-memory gap. Render state flows WASM→TS via WASM memory view (Mode C) or `postMessage` with transferable ArrayBuffer (Mode A/B). WGSL shaders are loaded via Vite `?raw` imports.

**Tech Stack:** WebGPU (browser API from TypeScript — not Rust wgpu, to avoid ~1MB binary bloat), WGSL shaders, `wasm-bindgen` `&[u8]` for command transfer, existing Rust stack unchanged (no new crate dependencies).

**Design Doc:** `docs/plans/2026-02-17-hyperion-engine-design.md` (Sections 2, 6, 10)

---

## Prerequisites

No new tooling needed. Existing wasm-pack, Vite, vitest, cargo all apply.

**Key design decisions made upfront:**

1. **TypeScript WebGPU, not Rust wgpu**: The browser's WebGPU API is used directly from TypeScript. wgpu on wasm32 wraps the same JS API with ~1MB binary overhead. The Rust side produces data; TypeScript renders it.

2. **`engine_push_commands(&[u8])` replaces SAB-to-WASM bridge**: The existing ring buffer SAB→WASM gap (documented in CLAUDE.md gotchas) is resolved by having the Worker extract unread bytes from the SAB and pass them to a new WASM function via wasm-bindgen's automatic `&[u8]` marshaling. This avoids the pointer-aliasing problem entirely.

3. **Render state via postMessage (Mode A/B)**: The ECS Worker copies model matrices into a transferable ArrayBuffer and posts it to the render thread. Zero-copy transfer, no double-buffer SAB complexity. For Mode C, we read WASM memory directly.

4. **Orthographic camera**: Per design doc — "2D projection via orthographic cameras manipulating Z for hardware depth testing". Phase 2 uses a fixed orthographic camera. Phase 5+ adds user-controllable cameras.

---

## Task 1: Add `parse_commands()` to ring_buffer.rs

**Files:**
- Modify: `crates/hyperion-core/src/ring_buffer.rs`

This extracts the command-parsing logic from `RingBufferConsumer::drain()` into a standalone function that operates on a flat `&[u8]` slice. This is the foundation for the new `engine_push_commands` WASM export — the Worker will extract bytes from the SAB and pass them here.

**Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `ring_buffer.rs`:

```rust
#[test]
fn parse_commands_reads_spawn() {
    let mut data = Vec::new();
    data.push(CommandType::SpawnEntity as u8);
    data.extend_from_slice(&42u32.to_le_bytes());

    let cmds = parse_commands(&data);
    assert_eq!(cmds.len(), 1);
    assert_eq!(cmds[0].cmd_type, CommandType::SpawnEntity);
    assert_eq!(cmds[0].entity_id, 42);
}

#[test]
fn parse_commands_reads_position_payload() {
    let mut data = Vec::new();
    data.push(CommandType::SetPosition as u8);
    data.extend_from_slice(&7u32.to_le_bytes());
    data.extend_from_slice(&1.0f32.to_le_bytes());
    data.extend_from_slice(&2.0f32.to_le_bytes());
    data.extend_from_slice(&3.0f32.to_le_bytes());

    let cmds = parse_commands(&data);
    assert_eq!(cmds.len(), 1);
    assert_eq!(cmds[0].entity_id, 7);
    let x = f32::from_le_bytes(cmds[0].payload[0..4].try_into().unwrap());
    let y = f32::from_le_bytes(cmds[0].payload[4..8].try_into().unwrap());
    let z = f32::from_le_bytes(cmds[0].payload[8..12].try_into().unwrap());
    assert_eq!((x, y, z), (1.0, 2.0, 3.0));
}

#[test]
fn parse_commands_reads_multiple() {
    let mut data = Vec::new();
    // Spawn entity 1
    data.push(CommandType::SpawnEntity as u8);
    data.extend_from_slice(&1u32.to_le_bytes());
    // Despawn entity 2
    data.push(CommandType::DespawnEntity as u8);
    data.extend_from_slice(&2u32.to_le_bytes());

    let cmds = parse_commands(&data);
    assert_eq!(cmds.len(), 2);
    assert_eq!(cmds[0].entity_id, 1);
    assert_eq!(cmds[1].cmd_type, CommandType::DespawnEntity);
    assert_eq!(cmds[1].entity_id, 2);
}

#[test]
fn parse_commands_handles_incomplete() {
    // Only 3 bytes — not enough for a full command (need 5 minimum)
    let data = vec![CommandType::SpawnEntity as u8, 0, 0];
    let cmds = parse_commands(&data);
    assert!(cmds.is_empty());
}

#[test]
fn parse_commands_handles_empty() {
    let cmds = parse_commands(&[]);
    assert!(cmds.is_empty());
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p hyperion-core ring_buffer::tests::parse_commands`
Expected: FAIL — `parse_commands` not found.

**Step 3: Implement `parse_commands`**

Add this function to `ring_buffer.rs` (above the `RingBufferConsumer` struct):

```rust
/// Parse commands from a flat byte slice.
///
/// This is the non-circular counterpart to `RingBufferConsumer::drain()`.
/// Used when the Worker extracts bytes from the SharedArrayBuffer and passes
/// them to WASM as a contiguous `&[u8]`.
pub fn parse_commands(data: &[u8]) -> Vec<Command> {
    let mut commands = Vec::new();
    let mut pos = 0;

    while pos < data.len() {
        let cmd_byte = data[pos];
        let Some(cmd_type) = CommandType::from_u8(cmd_byte) else {
            break;
        };

        let msg_size = cmd_type.message_size();
        if pos + msg_size > data.len() {
            break;
        }

        let mut id_bytes = [0u8; 4];
        id_bytes.copy_from_slice(&data[pos + 1..pos + 5]);
        let entity_id = u32::from_le_bytes(id_bytes);

        let mut payload = [0u8; 16];
        let psize = cmd_type.payload_size();
        if psize > 0 {
            payload[..psize].copy_from_slice(&data[pos + 5..pos + 5 + psize]);
        }

        commands.push(Command {
            cmd_type,
            entity_id,
            payload,
        });

        pos += msg_size;
    }

    commands
}
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p hyperion-core ring_buffer::tests::parse_commands`
Expected: 5 new tests PASS.

**Step 5: Run all existing tests (regression check)**

Run: `cargo test -p hyperion-core`
Expected: All 22 existing + 5 new = 27 tests PASS.

**Step 6: Commit**

```bash
git add crates/hyperion-core/src/ring_buffer.rs
git commit -m "feat: add parse_commands() for flat byte slice command parsing"
```

---

## Task 2: Refactor Engine — Separate Command Processing + Add RenderState

**Files:**
- Create: `crates/hyperion-core/src/render_state.rs`
- Modify: `crates/hyperion-core/src/engine.rs`
- Modify: `crates/hyperion-core/src/lib.rs`

Currently `Engine::update(dt, commands)` both processes commands and runs physics. We split these into separate methods so the WASM layer can call `engine_push_commands` and `engine_update` independently. We also add `RenderState` — a contiguous buffer of model matrices for GPU upload.

**Step 1: Create render_state.rs with tests**

`crates/hyperion-core/src/render_state.rs`:

```rust
//! Collects render-ready data from the ECS into contiguous GPU-uploadable buffers.

use hecs::World;

use crate::components::{Active, ModelMatrix};

/// Contiguous buffer of model matrices for all active entities.
/// Updated once per frame after all physics ticks and transform recomputation.
pub struct RenderState {
    /// Flat buffer: each entry is 16 f32s (one 4x4 column-major matrix).
    pub matrices: Vec<[f32; 16]>,
}

impl RenderState {
    pub fn new() -> Self {
        Self {
            matrices: Vec::new(),
        }
    }

    /// Collect model matrices from all active entities.
    /// Clears previous data and repopulates from the current world state.
    pub fn collect(&mut self, world: &World) {
        self.matrices.clear();
        for (_, (matrix, _)) in world.query::<(&ModelMatrix, &Active)>().iter() {
            self.matrices.push(matrix.0);
        }
    }

    /// Number of active entities with render data.
    pub fn count(&self) -> u32 {
        self.matrices.len() as u32
    }

    /// Raw pointer to the matrix data, for WASM memory export.
    /// Returns null if empty.
    pub fn as_ptr(&self) -> *const f32 {
        if self.matrices.is_empty() {
            std::ptr::null()
        } else {
            self.matrices.as_ptr() as *const f32
        }
    }

    /// Total number of f32 values (count * 16).
    pub fn f32_len(&self) -> u32 {
        (self.matrices.len() * 16) as u32
    }
}

impl Default for RenderState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::*;
    use glam::Vec3;

    #[test]
    fn collect_gathers_active_matrices() {
        let mut world = World::new();
        world.spawn((
            Position(Vec3::new(1.0, 0.0, 0.0)),
            Rotation::default(),
            Scale::default(),
            ModelMatrix::default(),
            Active,
        ));
        world.spawn((
            Position(Vec3::new(2.0, 0.0, 0.0)),
            Rotation::default(),
            Scale::default(),
            ModelMatrix::default(),
            Active,
        ));
        // Entity without Active — should NOT be collected
        world.spawn((
            Position(Vec3::new(3.0, 0.0, 0.0)),
            ModelMatrix::default(),
        ));

        let mut rs = RenderState::new();
        rs.collect(&world);
        assert_eq!(rs.count(), 2);
        assert_eq!(rs.f32_len(), 32);
    }

    #[test]
    fn collect_clears_previous_data() {
        let mut world = World::new();
        world.spawn((ModelMatrix::default(), Active));

        let mut rs = RenderState::new();
        rs.collect(&world);
        assert_eq!(rs.count(), 1);

        // Despawn all entities
        let entities: Vec<_> = world.iter().map(|e| e.entity()).collect();
        for e in entities {
            world.despawn(e).unwrap();
        }

        rs.collect(&world);
        assert_eq!(rs.count(), 0);
    }

    #[test]
    fn as_ptr_returns_null_when_empty() {
        let rs = RenderState::new();
        assert!(rs.as_ptr().is_null());
    }

    #[test]
    fn as_ptr_returns_valid_pointer() {
        let mut world = World::new();
        world.spawn((ModelMatrix::default(), Active));

        let mut rs = RenderState::new();
        rs.collect(&world);
        assert!(!rs.as_ptr().is_null());

        // Read back via pointer
        let slice = unsafe { std::slice::from_raw_parts(rs.as_ptr(), 16) };
        // Default ModelMatrix is identity — element [0] should be 1.0
        assert_eq!(slice[0], 1.0);
    }
}
```

**Step 2: Register render_state module**

Add to `crates/hyperion-core/src/lib.rs`:

```rust
pub mod render_state;
```

**Step 3: Run render_state tests**

Run: `cargo test -p hyperion-core render_state`
Expected: 4 tests PASS.

**Step 4: Refactor Engine**

Modify `crates/hyperion-core/src/engine.rs`:

```rust
//! The main engine struct that ties together ECS, command processing,
//! and systems into a deterministic fixed-timestep tick loop.

use hecs::World;

use crate::command_processor::{process_commands, EntityMap};
use crate::render_state::RenderState;
use crate::ring_buffer::Command;
use crate::systems::{transform_system, velocity_system};

/// Fixed timestep: 60 ticks per second.
pub const FIXED_DT: f32 = 1.0 / 60.0;

/// The core engine state.
pub struct Engine {
    pub world: World,
    pub entity_map: EntityMap,
    pub render_state: RenderState,
    accumulator: f32,
    tick_count: u64,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub fn new() -> Self {
        Self {
            world: World::new(),
            entity_map: EntityMap::new(),
            render_state: RenderState::new(),
            accumulator: 0.0,
            tick_count: 0,
        }
    }

    /// Apply a batch of commands to the ECS world.
    /// Called before `update()` each frame.
    pub fn process_commands(&mut self, commands: &[Command]) {
        process_commands(commands, &mut self.world, &mut self.entity_map);
    }

    /// Advance the engine by `dt` seconds (variable, from requestAnimationFrame).
    /// Runs fixed-timestep physics ticks, then recomputes transforms and
    /// collects render state.
    pub fn update(&mut self, dt: f32) {
        // 1. Accumulate time and run fixed-timestep ticks.
        self.accumulator += dt;

        // Cap accumulator to prevent spiral of death.
        if self.accumulator > FIXED_DT * 10.0 {
            self.accumulator = FIXED_DT * 10.0;
        }

        while self.accumulator >= FIXED_DT {
            self.fixed_tick();
            self.accumulator -= FIXED_DT;
            self.tick_count += 1;
        }

        // 2. Recompute model matrices after all ticks.
        transform_system(&mut self.world);

        // 3. Collect render state for GPU upload.
        self.render_state.collect(&self.world);
    }

    /// A single fixed-timestep tick.
    fn fixed_tick(&mut self) {
        velocity_system(&mut self.world, FIXED_DT);
    }

    /// How many fixed ticks have elapsed since engine start.
    pub fn tick_count(&self) -> u64 {
        self.tick_count
    }

    /// The interpolation alpha for rendering between ticks.
    /// Ranges from 0.0 to 1.0.
    pub fn interpolation_alpha(&self) -> f32 {
        self.accumulator / FIXED_DT
    }
}
```

**Step 5: Update existing engine tests**

Replace the `#[cfg(test)] mod tests` block in `engine.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ring_buffer::{Command, CommandType};

    fn spawn_cmd(id: u32) -> Command {
        Command {
            cmd_type: CommandType::SpawnEntity,
            entity_id: id,
            payload: [0; 16],
        }
    }

    fn velocity_cmd(id: u32, vx: f32, vy: f32, vz: f32) -> Command {
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&vx.to_le_bytes());
        payload[4..8].copy_from_slice(&vy.to_le_bytes());
        payload[8..12].copy_from_slice(&vz.to_le_bytes());
        Command {
            cmd_type: CommandType::SetVelocity,
            entity_id: id,
            payload,
        }
    }

    #[test]
    fn engine_processes_commands_and_ticks() {
        let mut engine = Engine::new();

        // Spawn entity and set velocity.
        engine.process_commands(&[spawn_cmd(0), velocity_cmd(0, 60.0, 0.0, 0.0)]);

        // Run for exactly 1 fixed tick (1/60th second).
        engine.update(FIXED_DT);

        let entity = engine.entity_map.get(0).unwrap();
        let pos = engine.world.get::<&crate::components::Position>(entity).unwrap();
        assert!((pos.0.x - 1.0).abs() < 0.001);
    }

    #[test]
    fn fixed_timestep_accumulates() {
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0), velocity_cmd(0, 60.0, 0.0, 0.0)]);

        // Run for half a tick — should not advance physics.
        engine.update(FIXED_DT * 0.5);
        assert_eq!(engine.tick_count(), 0);

        // Run for another half — now one full tick should fire.
        engine.update(FIXED_DT * 0.5);
        assert_eq!(engine.tick_count(), 1);
    }

    #[test]
    fn spiral_of_death_capped() {
        let mut engine = Engine::new();
        // Pass a huge dt — should be capped to 10 ticks max.
        engine.update(100.0);
        assert!(engine.tick_count() <= 10);
    }

    #[test]
    fn model_matrix_updated_after_tick() {
        let mut engine = Engine::new();
        let mut pos_cmd = Command {
            cmd_type: CommandType::SetPosition,
            entity_id: 0,
            payload: [0; 16],
        };
        pos_cmd.payload[0..4].copy_from_slice(&5.0f32.to_le_bytes());
        pos_cmd.payload[4..8].copy_from_slice(&10.0f32.to_le_bytes());
        pos_cmd.payload[8..12].copy_from_slice(&15.0f32.to_le_bytes());

        engine.process_commands(&[spawn_cmd(0), pos_cmd]);
        engine.update(FIXED_DT);

        let entity = engine.entity_map.get(0).unwrap();
        let matrix = engine.world.get::<&crate::components::ModelMatrix>(entity).unwrap();
        assert!((matrix.0[12] - 5.0).abs() < 0.001);
        assert!((matrix.0[13] - 10.0).abs() < 0.001);
        assert!((matrix.0[14] - 15.0).abs() < 0.001);
    }

    #[test]
    fn render_state_collected_after_update() {
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0), spawn_cmd(1)]);
        engine.update(FIXED_DT);

        assert_eq!(engine.render_state.count(), 2);
        assert!(!engine.render_state.as_ptr().is_null());
    }
}
```

**Step 6: Run all tests**

Run: `cargo test -p hyperion-core`
Expected: All tests PASS (existing + new render_state + updated engine).

**Step 7: Commit**

```bash
git add crates/hyperion-core/src/render_state.rs crates/hyperion-core/src/engine.rs crates/hyperion-core/src/lib.rs
git commit -m "feat: add RenderState collection, refactor Engine to separate command processing"
```

---

## Task 3: New WASM Exports — engine_push_commands + Render State Access

**Files:**
- Modify: `crates/hyperion-core/src/lib.rs`

Add the new WASM API: `engine_push_commands` accepts raw command bytes (wasm-bindgen handles `&[u8]` marshaling automatically), and render state exports expose the matrix buffer pointer + count.

**Step 1: Write the updated lib.rs**

Replace `crates/hyperion-core/src/lib.rs`:

```rust
use std::ptr::addr_of_mut;

use wasm_bindgen::prelude::*;

pub mod command_processor;
pub mod components;
pub mod engine;
pub mod render_state;
pub mod ring_buffer;
pub mod systems;

use engine::Engine;
use ring_buffer::RingBufferConsumer;

static mut ENGINE: Option<Engine> = None;
#[allow(dead_code)]
static mut RING_BUFFER: Option<RingBufferConsumer> = None;

/// Initialize the engine. Called once from the Worker.
#[wasm_bindgen]
pub fn engine_init() {
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        addr_of_mut!(ENGINE).write(Some(Engine::new()));
    }
}

/// Attach a ring buffer for command consumption.
/// Kept for backward compatibility; prefer `engine_push_commands` instead.
///
/// # Safety
/// The SharedArrayBuffer must outlive the engine.
#[wasm_bindgen]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn engine_attach_ring_buffer(ptr: *mut u8, capacity: usize) {
    // SAFETY: wasm32 is single-threaded; pointer valid by caller contract.
    unsafe {
        addr_of_mut!(RING_BUFFER).write(Some(RingBufferConsumer::new(ptr, capacity)));
    }
}

/// Push raw command bytes into the engine.
///
/// The Worker extracts unread bytes from the SharedArrayBuffer ring buffer
/// and passes them here. wasm-bindgen handles the `&[u8]` → WASM memory
/// copy automatically.
///
/// Call this BEFORE `engine_update()` each frame.
#[wasm_bindgen]
pub fn engine_push_commands(data: &[u8]) {
    let commands = ring_buffer::parse_commands(data);
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        if let Some(ref mut engine) = *addr_of_mut!(ENGINE) {
            engine.process_commands(&commands);
        }
    }
}

/// Run one frame update. `dt` is seconds since last frame.
/// Runs physics ticks, recomputes transforms, and collects render state.
///
/// Call `engine_push_commands()` first if there are commands to process.
#[wasm_bindgen]
pub fn engine_update(dt: f32) {
    // SAFETY: wasm32 is single-threaded; no concurrent access.
    unsafe {
        if let Some(ref mut engine) = *addr_of_mut!(ENGINE) {
            engine.update(dt);
        }
    }
}

/// Returns the number of fixed ticks elapsed.
#[wasm_bindgen]
pub fn engine_tick_count() -> u64 {
    // SAFETY: wasm32 is single-threaded.
    unsafe { (*addr_of_mut!(ENGINE)).as_ref().map_or(0, |e| e.tick_count()) }
}

/// Returns the number of active entities with render data.
#[wasm_bindgen]
pub fn engine_render_state_count() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.count())
    }
}

/// Returns a pointer to the model matrix buffer in WASM linear memory.
/// The buffer contains `engine_render_state_count() * 16` f32 values
/// (each matrix is 16 floats, column-major).
///
/// The pointer is valid until the next call to `engine_update()`.
#[wasm_bindgen]
pub fn engine_render_state_ptr() -> *const f32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(std::ptr::null(), |e| e.render_state.as_ptr())
    }
}

/// Returns total f32 count in render state (count * 16).
#[wasm_bindgen]
pub fn engine_render_state_f32_len() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.f32_len())
    }
}

/// Smoke test.
#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
```

**Step 2: Run all Rust tests**

Run: `cargo test -p hyperion-core`
Expected: All tests PASS.

**Step 3: Run clippy**

Run: `cargo clippy -p hyperion-core`
Expected: No warnings.

**Step 4: Build WASM**

Run: `cd ts && npm run build:wasm`
Expected: Builds successfully. Check `ts/wasm/hyperion_core.d.ts` contains the new exports.

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/lib.rs
git commit -m "feat: add engine_push_commands and render state WASM exports"
```

---

## Task 4: Wire Command Flow in engine-worker.ts

**Files:**
- Modify: `ts/src/engine-worker.ts`
- Modify: `ts/src/ring-buffer.ts` (add `extractUnread` helper)
- Create: `ts/src/ring-buffer-utils.test.ts`

The Worker now extracts unread bytes from the SAB ring buffer and passes them to `engine_push_commands()`. After `engine_update()`, it reads the render state from WASM memory and posts it as a transferable ArrayBuffer.

**Step 1: Write the failing test for extractUnread**

Create `ts/src/ring-buffer-utils.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractUnread } from "./ring-buffer";

const HEADER_SIZE = 16;

function makeSab(capacity: number): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_SIZE + capacity);
}

function writeBytes(
  sab: SharedArrayBuffer,
  dataOffset: number,
  bytes: number[]
): void {
  const data = new Uint8Array(sab, HEADER_SIZE);
  for (let i = 0; i < bytes.length; i++) {
    data[(dataOffset + i) % data.length] = bytes[i];
  }
}

function setWriteHead(sab: SharedArrayBuffer, val: number): void {
  Atomics.store(new Int32Array(sab, 0, 1), 0, val);
}

function setReadHead(sab: SharedArrayBuffer, val: number): void {
  Atomics.store(new Int32Array(sab, 0, 4), 1, val);
}

function getReadHead(sab: SharedArrayBuffer): number {
  return Atomics.load(new Int32Array(sab, 0, 4), 1);
}

describe("extractUnread", () => {
  it("returns empty when heads are equal", () => {
    const sab = makeSab(64);
    const { bytes, capacity } = extractUnread(sab);
    expect(bytes.length).toBe(0);
    expect(capacity).toBe(64);
  });

  it("extracts bytes between read and write head", () => {
    const sab = makeSab(64);
    writeBytes(sab, 0, [1, 2, 3, 4, 5]);
    setWriteHead(sab, 5);

    const { bytes } = extractUnread(sab);
    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(getReadHead(sab)).toBe(5);
  });

  it("handles wrap-around", () => {
    const sab = makeSab(8);
    // Simulate: readHead=6, writeHead=3, data wraps around
    setReadHead(sab, 6);
    setWriteHead(sab, 3);
    writeBytes(sab, 6, [10, 11]); // bytes 6,7
    writeBytes(sab, 0, [12, 13, 14]); // bytes 0,1,2

    const { bytes } = extractUnread(sab);
    expect(bytes).toEqual(new Uint8Array([10, 11, 12, 13, 14]));
    expect(getReadHead(sab)).toBe(3);
  });

  it("advances read head to write head", () => {
    const sab = makeSab(64);
    writeBytes(sab, 0, [1, 2, 3]);
    setWriteHead(sab, 3);

    extractUnread(sab);
    expect(getReadHead(sab)).toBe(3);

    // Second call returns empty
    const { bytes } = extractUnread(sab);
    expect(bytes.length).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/ring-buffer-utils.test.ts`
Expected: FAIL — `extractUnread` not exported.

**Step 3: Implement extractUnread**

Add to the bottom of `ts/src/ring-buffer.ts`:

```typescript
/**
 * Extract unread bytes from a ring buffer SharedArrayBuffer.
 *
 * Returns a contiguous Uint8Array of command bytes (handling wrap-around)
 * and advances the read head to the current write head.
 *
 * Used by the Worker to bridge SAB → engine_push_commands().
 */
export function extractUnread(sab: SharedArrayBuffer): {
  bytes: Uint8Array;
  capacity: number;
} {
  const header = new Int32Array(sab, 0, 4);
  const capacity = sab.byteLength - HEADER_SIZE;
  const writeHead = Atomics.load(header, WRITE_HEAD_OFFSET);
  const readHead = Atomics.load(header, READ_HEAD_OFFSET);

  if (writeHead === readHead) {
    return { bytes: new Uint8Array(0), capacity };
  }

  const data = new Uint8Array(sab, HEADER_SIZE, capacity);
  let bytes: Uint8Array;

  if (writeHead > readHead) {
    bytes = data.slice(readHead, writeHead);
  } else {
    // Wrap-around: readHead..end + 0..writeHead
    const part1 = data.slice(readHead);
    const part2 = data.slice(0, writeHead);
    bytes = new Uint8Array(part1.length + part2.length);
    bytes.set(part1);
    bytes.set(part2, part1.length);
  }

  // Advance read head
  Atomics.store(header, READ_HEAD_OFFSET, writeHead);

  return { bytes, capacity };
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/ring-buffer-utils.test.ts`
Expected: 4 tests PASS.

**Step 5: Update engine-worker.ts**

Replace `ts/src/engine-worker.ts`:

```typescript
/// <reference lib="webworker" />

/**
 * Engine Logic Worker.
 * Loads the WASM module, extracts commands from the shared ring buffer,
 * and runs the engine tick loop. After each tick, exports render state
 * (model matrices) as a transferable ArrayBuffer.
 */

import { extractUnread } from "./ring-buffer";

interface WasmEngine {
  default(): Promise<void>;
  engine_init(): void;
  engine_push_commands(data: Uint8Array): void;
  engine_update(dt: number): void;
  engine_tick_count(): bigint;
  engine_render_state_count(): number;
  engine_render_state_ptr(): number;
  engine_render_state_f32_len(): number;
  memory: WebAssembly.Memory;
}

let wasm: WasmEngine | null = null;
let commandBuffer: SharedArrayBuffer | null = null;

interface InitMessage {
  type: "init";
  commandBuffer: SharedArrayBuffer;
}

interface TickMessage {
  type: "tick";
  dt: number;
}

type WorkerMessage = InitMessage | TickMessage;

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case "init": {
      try {
        const wasmModule = await import("../wasm/hyperion_core.js");
        await wasmModule.default();
        wasm = wasmModule as unknown as WasmEngine;
        commandBuffer = msg.commandBuffer;

        wasm.engine_init();

        self.postMessage({ type: "ready" });
      } catch (e) {
        self.postMessage({ type: "error", error: String(e) });
      }
      break;
    }

    case "tick": {
      if (!wasm || !commandBuffer) return;

      // 1. Extract unread commands from the SAB ring buffer.
      const { bytes } = extractUnread(commandBuffer);
      if (bytes.length > 0) {
        wasm.engine_push_commands(bytes);
      }

      // 2. Run physics + transform + collect render state.
      wasm.engine_update(msg.dt);

      // 3. Export render state as transferable ArrayBuffer.
      const count = wasm.engine_render_state_count();
      const tickCount = Number(wasm.engine_tick_count());

      if (count > 0) {
        const ptr = wasm.engine_render_state_ptr();
        const f32Len = wasm.engine_render_state_f32_len();
        const wasmMatrices = new Float32Array(wasm.memory.buffer, ptr, f32Len);

        // Copy to a transferable buffer (WASM memory can't be transferred).
        const transferBuf = new Float32Array(f32Len);
        transferBuf.set(wasmMatrices);

        self.postMessage(
          {
            type: "tick-done",
            dt: msg.dt,
            tickCount,
            renderState: { count, matrices: transferBuf.buffer },
          },
          [transferBuf.buffer]
        );
      } else {
        self.postMessage({
          type: "tick-done",
          dt: msg.dt,
          tickCount,
          renderState: null,
        });
      }
      break;
    }
  }
};
```

**Step 6: Run all TypeScript tests (regression)**

Run: `cd ts && npm test`
Expected: All existing + new tests PASS.

**Step 7: Run TypeScript type check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors.

**Step 8: Commit**

```bash
git add ts/src/ring-buffer.ts ts/src/ring-buffer-utils.test.ts ts/src/engine-worker.ts
git commit -m "feat: wire ring buffer SAB to WASM via extractUnread + engine_push_commands"
```

---

## Task 5: Complete Mode C Direct Bridge

**Files:**
- Modify: `ts/src/worker-bridge.ts`

Mode C (single-thread) was a stub. Now it loads WASM, processes commands from the ring buffer synchronously, and exposes render state.

**Step 1: Update worker-bridge.ts**

Replace `ts/src/worker-bridge.ts`:

```typescript
import { ExecutionMode } from "./capabilities";
import {
  createRingBuffer,
  RingBufferProducer,
  extractUnread,
} from "./ring-buffer";

const RING_BUFFER_CAPACITY = 64 * 1024; // 64KB command buffer

/** Render state transferred from the engine each frame. */
export interface RenderStateSnapshot {
  count: number;
  matrices: Float32Array;
}

export interface EngineBridge {
  mode: ExecutionMode;
  commandBuffer: RingBufferProducer;
  /** Send a tick signal. In Mode C, this runs synchronously. */
  tick(dt: number): void;
  /** Wait for the engine to be ready. */
  ready(): Promise<void>;
  /** Shut down the engine. */
  destroy(): void;
  /** Get the latest render state (model matrices). */
  latestRenderState: RenderStateSnapshot | null;
}

/**
 * Create the engine bridge for Mode B (Partial Isolation: Worker ECS + Main Thread Render).
 */
export function createWorkerBridge(
  mode: ExecutionMode.PartialIsolation
): EngineBridge {
  const sab = createRingBuffer(RING_BUFFER_CAPACITY) as SharedArrayBuffer;
  const producer = new RingBufferProducer(sab);

  const worker = new Worker(
    new URL("./engine-worker.ts", import.meta.url),
    { type: "module" }
  );

  let readyResolve: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  let latestRenderState: RenderStateSnapshot | null = null;

  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "ready") {
      readyResolve();
    } else if (msg.type === "error") {
      console.error("Engine Worker error:", msg.error);
    } else if (msg.type === "tick-done" && msg.renderState) {
      latestRenderState = {
        count: msg.renderState.count,
        matrices: new Float32Array(msg.renderState.matrices),
      };
    }
  };

  worker.postMessage({ type: "init", commandBuffer: sab });

  return {
    mode,
    commandBuffer: producer,
    tick(dt: number) {
      worker.postMessage({ type: "tick", dt });
    },
    async ready() {
      await readyPromise;
    },
    destroy() {
      worker.terminate();
    },
    get latestRenderState() {
      return latestRenderState;
    },
  };
}

/**
 * Create the engine bridge for Mode A (Full Isolation: ECS Worker + Render Worker).
 * The canvas is transferred to the Render Worker via OffscreenCanvas.
 */
export function createFullIsolationBridge(
  canvas: HTMLCanvasElement
): EngineBridge {
  const sab = createRingBuffer(RING_BUFFER_CAPACITY) as SharedArrayBuffer;
  const producer = new RingBufferProducer(sab);

  const offscreen = canvas.transferControlToOffscreen();

  const ecsWorker = new Worker(
    new URL("./engine-worker.ts", import.meta.url),
    { type: "module" }
  );
  const renderWorker = new Worker(
    new URL("./render-worker.ts", import.meta.url),
    { type: "module" }
  );

  // MessageChannel: ECS Worker tick-done → Render Worker.
  const channel = new MessageChannel();

  let readyResolve: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  let ecsReady = false;
  let renderReady = false;
  function checkBothReady() {
    if (ecsReady && renderReady) readyResolve();
  }

  ecsWorker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "ready") {
      ecsReady = true;
      checkBothReady();
    } else if (msg.type === "error") {
      console.error("ECS Worker error:", msg.error);
    } else if (msg.type === "tick-done" && msg.renderState) {
      // Forward render state to Render Worker.
      channel.port1.postMessage(
        { renderState: msg.renderState },
        [msg.renderState.matrices]
      );
    }
  };

  renderWorker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "ready") {
      renderReady = true;
      checkBothReady();
    } else if (msg.type === "error") {
      console.error("Render Worker error:", msg.error);
    }
  };

  const dpr = window.devicePixelRatio || 1;
  renderWorker.postMessage(
    {
      type: "init",
      canvas: offscreen,
      width: Math.floor(canvas.clientWidth * dpr),
      height: Math.floor(canvas.clientHeight * dpr),
      ecsPort: channel.port2,
    },
    [offscreen, channel.port2]
  );

  ecsWorker.postMessage({ type: "init", commandBuffer: sab });

  return {
    mode: ExecutionMode.FullIsolation,
    commandBuffer: producer,
    tick(dt: number) {
      ecsWorker.postMessage({ type: "tick", dt });
    },
    async ready() {
      await readyPromise;
    },
    destroy() {
      ecsWorker.terminate();
      renderWorker.terminate();
    },
    get latestRenderState() {
      // In Mode A, rendering is in the Render Worker. Main thread has no state.
      return null;
    },
  };
}

/**
 * Create the engine bridge for Mode C (single-thread, no Worker).
 */
export async function createDirectBridge(): Promise<EngineBridge> {
  const buffer = createRingBuffer(RING_BUFFER_CAPACITY);
  const producer = new RingBufferProducer(buffer as SharedArrayBuffer);

  const wasm = await import("../wasm/hyperion_core.js");
  await wasm.default();

  const engine = wasm as unknown as {
    engine_init(): void;
    engine_push_commands(data: Uint8Array): void;
    engine_update(dt: number): void;
    engine_render_state_count(): number;
    engine_render_state_ptr(): number;
    engine_render_state_f32_len(): number;
    memory: WebAssembly.Memory;
  };

  engine.engine_init();

  let latestRenderState: RenderStateSnapshot | null = null;

  return {
    mode: ExecutionMode.SingleThread,
    commandBuffer: producer,
    tick(dt: number) {
      // 1. Extract commands from ring buffer.
      const { bytes } = extractUnread(buffer as SharedArrayBuffer);
      if (bytes.length > 0) {
        engine.engine_push_commands(bytes);
      }

      // 2. Run physics + transforms + collect render state.
      engine.engine_update(dt);

      // 3. Read render state directly from WASM memory.
      const count = engine.engine_render_state_count();
      if (count > 0) {
        const ptr = engine.engine_render_state_ptr();
        const f32Len = engine.engine_render_state_f32_len();
        // Copy — WASM memory view may be invalidated by future calls.
        const wasmView = new Float32Array(engine.memory.buffer, ptr, f32Len);
        const copy = new Float32Array(f32Len);
        copy.set(wasmView);
        latestRenderState = { count, matrices: copy };
      } else {
        latestRenderState = { count: 0, matrices: new Float32Array(0) };
      }
    },
    async ready() {
      // Already ready.
    },
    destroy() {
      // Nothing to terminate.
    },
    get latestRenderState() {
      return latestRenderState;
    },
  };
}
```

**Step 2: Run TypeScript type check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors.

**Step 3: Run all tests (regression)**

Run: `cd ts && npm test`
Expected: All tests PASS.

**Step 4: Build WASM and verify in browser**

Run: `cd ts && npm run build:wasm && npm run dev`
Expected: Console logs show engine running. Commands now flow TS→Rust in all modes.

**Step 5: Commit**

```bash
git add ts/src/worker-bridge.ts
git commit -m "feat: complete Mode C tick, Mode A bridge, render state in all modes"
```

---

## Task 6: TypeScript Config — WebGPU Types + Vite Env

**Files:**
- Modify: `ts/package.json`
- Modify: `ts/tsconfig.json`
- Create: `ts/src/vite-env.d.ts`

**Step 1: Install @webgpu/types**

```bash
cd ts && npm install -D @webgpu/types
```

**Step 2: Update tsconfig.json**

Add `"types"` to compilerOptions in `ts/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["@webgpu/types"]
  },
  "include": ["src"]
}
```

**Step 3: Create Vite env declarations**

`ts/src/vite-env.d.ts`:

```typescript
/// <reference types="vite/client" />

// Allow importing .wgsl files as raw text via Vite's ?raw suffix.
declare module "*.wgsl?raw" {
  const content: string;
  export default content;
}
```

**Step 4: Verify type check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors. `navigator.gpu` and all WebGPU types now recognized.

**Step 5: Commit**

```bash
git add ts/package.json ts/package-lock.json ts/tsconfig.json ts/src/vite-env.d.ts
git commit -m "chore: add WebGPU types and Vite env declarations"
```

---

## Task 7: Camera Module — Orthographic Projection

**Files:**
- Create: `ts/src/camera.ts`
- Create: `ts/src/camera.test.ts`

Pure math module: builds orthographic view-projection matrices for the renderer. Testable without WebGPU.

**Step 1: Write the failing tests**

`ts/src/camera.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { orthographic, Camera } from "./camera";

// Helper: multiply a 4x4 column-major matrix by a point (x, y, z, 1)
function transformPoint(
  m: Float32Array | number[],
  x: number,
  y: number,
  z: number
): [number, number, number] {
  const w = 1;
  const ox = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
  const oy = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
  const oz = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  const ow = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
  return [ox / ow, oy / ow, oz / ow];
}

describe("orthographic", () => {
  it("maps center to origin in NDC", () => {
    const m = orthographic(-10, 10, -10, 10, 0, 100);
    const [x, y, z] = transformPoint(m, 0, 0, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
  });

  it("maps corners correctly", () => {
    const m = orthographic(-10, 10, -10, 10, 0, 100);
    const [rx] = transformPoint(m, 10, 0, 0);
    expect(rx).toBeCloseTo(1);
    const [, ty] = transformPoint(m, 0, 10, 0);
    expect(ty).toBeCloseTo(1);
  });

  it("maps depth to 0..1 range (WebGPU convention)", () => {
    const m = orthographic(-10, 10, -10, 10, 0, 100);
    const [, , zNear] = transformPoint(m, 0, 0, 0);
    expect(zNear).toBeCloseTo(0);
    // Far plane (z=-100) → NDC z = 1 (looking down -Z)
    const [, , zFar] = transformPoint(m, 0, 0, -100);
    expect(zFar).toBeCloseTo(1);
  });
});

describe("Camera", () => {
  it("creates a view-projection matrix", () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 1000);
    const vp = cam.viewProjection;
    expect(vp.length).toBe(16);
    expect(vp.some((v) => v !== 0)).toBe(true);
  });

  it("position offsets the view", () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 1000);
    cam.setPosition(5, 0, 0);
    const vp = cam.viewProjection;
    // A point at world (5, 0, 0) should map to screen center
    const [x] = transformPoint(vp, 5, 0, 0);
    expect(x).toBeCloseTo(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/camera.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement camera module**

`ts/src/camera.ts`:

```typescript
/**
 * Orthographic projection matrix (column-major, WebGPU depth 0..1).
 *
 * Maps world coordinates to clip space:
 * - X: left..right → -1..1
 * - Y: bottom..top → -1..1
 * - Z: -near..-far → 0..1  (looking down -Z)
 */
export function orthographic(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number
): Float32Array {
  const lr = 1 / (right - left);
  const bt = 1 / (top - bottom);
  const nf = 1 / (far - near);

  // Column-major 4x4
  return new Float32Array([
    2 * lr,       0,            0,            0, // col 0
    0,            2 * bt,       0,            0, // col 1
    0,            0,            -nf,          0, // col 2
    -(right + left) * lr,
    -(top + bottom) * bt,
    -near * nf,
    1,                                           // col 3
  ]);
}

/** Multiply two 4x4 column-major matrices: result = a * b. */
function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row] * b[col * 4] +
        a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

/** Simple orthographic camera. */
export class Camera {
  private projection = new Float32Array(16);
  private view = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
  private _viewProjection = new Float32Array(16);
  private dirty = true;

  /** Set orthographic projection. width and height are world units visible. */
  setOrthographic(
    width: number,
    height: number,
    near: number,
    far: number
  ): void {
    const hw = width / 2;
    const hh = height / 2;
    this.projection = orthographic(-hw, hw, -hh, hh, near, far);
    this.dirty = true;
  }

  /** Set camera world position (view translates inversely). */
  setPosition(x: number, y: number, z: number): void {
    this.view = new Float32Array([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1,
    ]);
    this.dirty = true;
  }

  /** Get the combined view-projection matrix (column-major Float32Array). */
  get viewProjection(): Float32Array {
    if (this.dirty) {
      this._viewProjection = mat4Multiply(this.projection, this.view);
      this.dirty = false;
    }
    return this._viewProjection;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/camera.test.ts`
Expected: 5 tests PASS.

**Step 5: Run all tests (regression)**

Run: `cd ts && npm test`
Expected: All tests PASS.

**Step 6: Commit**

```bash
git add ts/src/camera.ts ts/src/camera.test.ts
git commit -m "feat: add orthographic camera with view-projection matrix"
```

---

## Task 8: WebGPU Renderer — Initialization + Pipeline + Shaders

**Files:**
- Create: `ts/src/shaders/basic.wgsl`
- Create: `ts/src/renderer.ts`

This is the core rendering module. It initializes WebGPU, creates the render pipeline with instanced quad drawing, and manages GPU buffers.

**Step 1: Write the WGSL shader**

`ts/src/shaders/basic.wgsl`:

```wgsl
// Phase 2: Instanced colored quads.
// Each entity is a unit quad transformed by its model matrix.
// Color is derived from instance index for visual distinction.

struct CameraUniform {
  viewProjection: mat4x4f,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) color: vec3f,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> models: array<mat4x4f>;

@vertex
fn vs_main(
  @location(0) position: vec3f,
  @builtin(instance_index) idx: u32,
) -> VertexOutput {
  var out: VertexOutput;
  let model = models[idx];
  out.clipPosition = camera.viewProjection * model * vec4f(position, 1.0);

  // Deterministic color from instance index
  let r = f32((idx * 7u + 3u) % 11u) / 10.0;
  let g = f32((idx * 13u + 5u) % 11u) / 10.0;
  let b = f32((idx * 17u + 7u) % 11u) / 10.0;
  out.color = vec3f(r, g, b);

  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  return vec4f(in.color, 1.0);
}
```

**Step 2: Write the renderer module**

`ts/src/renderer.ts`:

```typescript
import { Camera } from "./camera";
import type { RenderStateSnapshot } from "./worker-bridge";
import shaderCode from "./shaders/basic.wgsl?raw";

const MAX_ENTITIES = 10_000;

/** Unit quad: 4 vertices, 6 indices (two triangles). */
const QUAD_VERTICES = new Float32Array([
  -0.5, -0.5, 0.0,
   0.5, -0.5, 0.0,
   0.5,  0.5, 0.0,
  -0.5,  0.5, 0.0,
]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

export interface Renderer {
  /** Upload new model matrices and render a frame. */
  render(state: RenderStateSnapshot | null): void;
  /** Resize the render target. */
  resize(width: number, height: number): void;
  /** Release GPU resources. */
  destroy(): void;
  /** The camera (public for position/zoom adjustment). */
  camera: Camera;
}

/**
 * Initialize the WebGPU renderer.
 * Returns null if WebGPU is unavailable.
 */
export async function createRenderer(
  canvas: HTMLCanvasElement
): Promise<Renderer | null> {
  if (!navigator.gpu) {
    console.warn("WebGPU not available. Rendering disabled.");
    return null;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    console.warn("No GPU adapter found. Rendering disabled.");
    return null;
  }

  const device = await adapter.requestDevice();

  const context = canvas.getContext("webgpu");
  if (!context) {
    console.warn("Could not get WebGPU context. Rendering disabled.");
    return null;
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const shaderModule = device.createShaderModule({ code: shaderCode });

  const vertexBuffer = device.createBuffer({
    size: QUAD_VERTICES.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, QUAD_VERTICES);

  const indexBuffer = device.createBuffer({
    size: QUAD_INDICES.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, QUAD_INDICES);

  const cameraBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const matricesBuffer = device.createBuffer({
    size: MAX_ENTITIES * 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 1, resource: { buffer: matricesBuffer } },
    ],
  });

  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: {
      module: shaderModule,
      entryPoint: "vs_main",
      buffers: [{
        arrayStride: 12,
        attributes: [{ format: "float32x3" as GPUVertexFormat, offset: 0, shaderLocation: 0 }],
      }],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });

  let depthTexture = createDepthTexture(device, canvas.width, canvas.height);

  const camera = new Camera();
  camera.setOrthographic(20, 15, 0.1, 1000);

  let currentEntityCount = 0;

  return {
    camera,

    render(state: RenderStateSnapshot | null) {
      device.queue.writeBuffer(cameraBuffer, 0, camera.viewProjection);

      if (state && state.count > 0) {
        const byteLen = state.count * 64;
        device.queue.writeBuffer(
          matricesBuffer, 0,
          state.matrices.buffer,
          state.matrices.byteOffset,
          byteLen
        );
        currentEntityCount = state.count;
      }

      const commandEncoder = device.createCommandEncoder();
      const colorView = context.getCurrentTexture().createView();
      const depthView = depthTexture.createView();

      const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: colorView,
          clearValue: { r: 0.067, g: 0.067, b: 0.067, a: 1.0 },
          loadOp: "clear",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });

      if (currentEntityCount > 0) {
        renderPass.setPipeline(pipeline);
        renderPass.setBindGroup(0, bindGroup);
        renderPass.setVertexBuffer(0, vertexBuffer);
        renderPass.setIndexBuffer(indexBuffer, "uint16");
        renderPass.drawIndexed(6, currentEntityCount);
      }

      renderPass.end();
      device.queue.submit([commandEncoder.finish()]);
    },

    resize(width: number, height: number) {
      canvas.width = width;
      canvas.height = height;
      depthTexture.destroy();
      depthTexture = createDepthTexture(device, width, height);
      const aspect = width / height;
      camera.setOrthographic(20 * aspect, 20, 0.1, 1000);
    },

    destroy() {
      vertexBuffer.destroy();
      indexBuffer.destroy();
      cameraBuffer.destroy();
      matricesBuffer.destroy();
      depthTexture.destroy();
      device.destroy();
    },
  };
}

function createDepthTexture(
  device: GPUDevice,
  width: number,
  height: number
): GPUTexture {
  return device.createTexture({
    size: [width, height],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
}
```

**Step 3: Verify type check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors.

**Step 4: Commit**

```bash
git add ts/src/shaders/basic.wgsl ts/src/renderer.ts
git commit -m "feat: add WebGPU renderer with instanced quad pipeline"
```

---

## Task 9: Wire Renderer to Main Loop — All Modes

**Files:**
- Create: `ts/src/render-worker.ts`
- Modify: `ts/src/main.ts`
- Modify: `ts/index.html`

Integrate the renderer into the main loop for all three modes. Spawn test entities to verify rendering. Mode A uses OffscreenCanvas in a render worker.

**Step 1: Create the render worker (Mode A)**

`ts/src/render-worker.ts`:

```typescript
/// <reference lib="webworker" />

/**
 * Render Worker (Mode A only).
 * Receives an OffscreenCanvas and renders entities using WebGPU.
 * Render state arrives from the ECS Worker via a MessageChannel port.
 */

import { Camera } from "./camera";
import shaderCode from "./shaders/basic.wgsl?raw";

const MAX_ENTITIES = 10_000;

const QUAD_VERTICES = new Float32Array([
  -0.5, -0.5, 0.0,
   0.5, -0.5, 0.0,
   0.5,  0.5, 0.0,
  -0.5,  0.5, 0.0,
]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

let device: GPUDevice;
let context: GPUCanvasContext;
let pipeline: GPURenderPipeline;
let bindGroup: GPUBindGroup;
let vertexBuffer: GPUBuffer;
let indexBuffer: GPUBuffer;
let cameraBuffer: GPUBuffer;
let matricesBuffer: GPUBuffer;
let depthTexture: GPUTexture;
let canvasWidth: number;
let canvasHeight: number;
const camera = new Camera();
let currentEntityCount = 0;

interface RenderState {
  count: number;
  matrices: ArrayBuffer;
}

let latestRenderState: RenderState | null = null;

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  if (msg.type === "init") {
    try {
      canvasWidth = msg.width;
      canvasHeight = msg.height;
      await initWebGPU(msg.canvas);

      msg.ecsPort.onmessage = (e: MessageEvent) => {
        if (e.data.renderState) {
          latestRenderState = e.data.renderState;
        }
      };

      renderLoop();
      self.postMessage({ type: "ready" });
    } catch (e) {
      self.postMessage({ type: "error", error: String(e) });
    }
  } else if (msg.type === "resize") {
    canvasWidth = msg.width;
    canvasHeight = msg.height;
    if (device && depthTexture) {
      depthTexture.destroy();
      depthTexture = device.createTexture({
        size: [canvasWidth, canvasHeight],
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const aspect = canvasWidth / canvasHeight;
      camera.setOrthographic(20 * aspect, 20, 0.1, 1000);
    }
  }
};

async function initWebGPU(canvas: OffscreenCanvas): Promise<void> {
  if (!navigator.gpu) throw new Error("WebGPU not available in Render Worker");

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No GPU adapter in Render Worker");

  device = await adapter.requestDevice();
  context = canvas.getContext("webgpu") as GPUCanvasContext;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const shaderModule = device.createShaderModule({ code: shaderCode });

  vertexBuffer = device.createBuffer({
    size: QUAD_VERTICES.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, QUAD_VERTICES);

  indexBuffer = device.createBuffer({
    size: QUAD_INDICES.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, QUAD_INDICES);

  cameraBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  matricesBuffer = device.createBuffer({
    size: MAX_ENTITIES * 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });

  bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 1, resource: { buffer: matricesBuffer } },
    ],
  });

  pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: shaderModule,
      entryPoint: "vs_main",
      buffers: [{
        arrayStride: 12,
        attributes: [{ format: "float32x3" as GPUVertexFormat, offset: 0, shaderLocation: 0 }],
      }],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  });

  depthTexture = device.createTexture({
    size: [canvasWidth, canvasHeight],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const aspect = canvasWidth / canvasHeight;
  camera.setOrthographic(20 * aspect, 20, 0.1, 1000);
}

function renderLoop(): void {
  function renderFrame() {
    device.queue.writeBuffer(cameraBuffer, 0, camera.viewProjection);

    if (latestRenderState && latestRenderState.count > 0) {
      const matrices = new Float32Array(latestRenderState.matrices);
      const byteLen = latestRenderState.count * 64;
      device.queue.writeBuffer(matricesBuffer, 0, matrices.buffer, 0, byteLen);
      currentEntityCount = latestRenderState.count;
    }

    const commandEncoder = device.createCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.067, g: 0.067, b: 0.067, a: 1.0 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    if (currentEntityCount > 0) {
      renderPass.setPipeline(pipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, vertexBuffer);
      renderPass.setIndexBuffer(indexBuffer, "uint16");
      renderPass.drawIndexed(6, currentEntityCount);
    }

    renderPass.end();
    device.queue.submit([commandEncoder.finish()]);

    requestAnimationFrame(renderFrame);
  }

  requestAnimationFrame(renderFrame);
}
```

**Step 2: Update index.html for full-viewport canvas**

Replace `ts/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Hyperion Engine</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { background: #111; color: #eee; font-family: monospace; overflow: hidden; }
      canvas { display: block; width: 100vw; height: 100vh; }
      #overlay {
        position: fixed;
        top: 10px;
        left: 10px;
        font-size: 13px;
        line-height: 1.6;
        background: rgba(0, 0, 0, 0.6);
        padding: 8px 12px;
        border-radius: 4px;
        pointer-events: none;
        z-index: 10;
        white-space: pre-line;
      }
    </style>
  </head>
  <body>
    <div id="overlay">Hyperion Engine — initializing...</div>
    <canvas id="canvas"></canvas>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

**Step 3: Update main.ts**

Replace `ts/src/main.ts`:

```typescript
import {
  detectCapabilities,
  selectExecutionMode,
  logCapabilities,
  ExecutionMode,
} from "./capabilities";
import {
  createWorkerBridge,
  createDirectBridge,
  createFullIsolationBridge,
  type EngineBridge,
} from "./worker-bridge";
import { createRenderer, type Renderer } from "./renderer";

async function main() {
  const overlay = document.getElementById("overlay")!;
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;

  overlay.textContent = "Hyperion Engine — detecting capabilities...";

  const caps = detectCapabilities();
  const mode = selectExecutionMode(caps);
  logCapabilities(caps, mode);

  overlay.textContent = "Hyperion Engine — Mode " + mode + ", loading WASM...";

  // Create the engine bridge (mode-appropriate).
  let bridge: EngineBridge;
  let rendererOnMainThread = true;

  if (mode === ExecutionMode.FullIsolation) {
    bridge = createFullIsolationBridge(canvas);
    rendererOnMainThread = false;
  } else if (mode === ExecutionMode.PartialIsolation) {
    bridge = createWorkerBridge(mode);
  } else {
    bridge = await createDirectBridge();
  }

  await bridge.ready();

  // Initialize the renderer (Mode B/C on Main Thread; Mode A in Render Worker).
  let renderer: Renderer | null = null;
  if (rendererOnMainThread && caps.webgpu) {
    renderer = await createRenderer(canvas);
  }

  if (!renderer && rendererOnMainThread) {
    overlay.textContent =
      "Hyperion Engine — Mode " + mode + ", no WebGPU (rendering disabled)";
  }

  // Set canvas size.
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor(canvas.clientWidth * dpr);
    const height = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      renderer?.resize(width, height);
    }
  }
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  // Spawn test entities in a grid.
  for (let i = 0; i < 50; i++) {
    bridge.commandBuffer.spawnEntity(i);
    const col = i % 10;
    const row = Math.floor(i / 10);
    bridge.commandBuffer.setPosition(i, (col - 4.5) * 2, (row - 2.5) * 2, 0);
  }

  // Main loop.
  let lastTime = performance.now();
  let frameCount = 0;
  let fpsTime = 0;
  let fps = 0;

  const modeLabels: Record<string, string> = {
    A: "A (Full Isolation)",
    B: "B (Partial Isolation)",
    C: "C (Single Thread)",
  };

  function frame(now: number) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    frameCount++;
    fpsTime += dt;
    if (fpsTime >= 1.0) {
      fps = Math.round(frameCount / fpsTime);
      frameCount = 0;
      fpsTime = 0;
    }

    bridge.tick(dt);

    if (renderer) {
      renderer.render(bridge.latestRenderState);
    }

    const entityCount = bridge.latestRenderState?.count ?? 0;
    const renderTarget = rendererOnMainThread ? "Main Thread" : "Render Worker";
    overlay.textContent =
      "Hyperion Engine\n" +
      "Mode: " + modeLabels[mode] + "\n" +
      "Render: " + renderTarget + "\n" +
      "FPS: " + fps + "\n" +
      "Entities: " + entityCount;

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main();
```

**Step 4: Build WASM and test in browser**

```bash
cd ts && npm run build:wasm && npm run dev
```

Expected: 50 colored quads in a grid. Debug overlay shows mode, render thread, FPS, entity count.

**Step 5: Run all tests (regression)**

Run: `cd ts && npm test && cargo test -p hyperion-core`
Expected: All tests PASS.

**Step 6: Commit**

```bash
git add ts/src/render-worker.ts ts/index.html ts/src/main.ts
git commit -m "feat: wire renderer to all modes with test entities and debug overlay"
```

---

## Task 10: Update Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `PROJECT_ARCHITECTURE.md`

**Step 1: Update CLAUDE.md**

Key updates:
- Add `render_state.rs` to the Rust modules table
- Add `renderer.ts`, `camera.ts`, `render-worker.ts`, `shaders/basic.wgsl` to TS modules table
- Update data flow diagram to include render path
- Update "Gotchas" with any WebGPU-specific issues found
- Change "Phase 2 is next" to "Phases 0-2 are complete. Phase 3 (GPU-Driven Pipeline) is next."
- Add new conventions: WGSL shaders in `ts/src/shaders/`, loaded via Vite `?raw`

**Step 2: Update PROJECT_ARCHITECTURE.md**

Add sections covering:
- Rendering pipeline (WebGPU from TypeScript, not wgpu — rationale)
- Shader architecture (WGSL loaded via Vite `?raw`)
- Render state transfer (WASM memory for Mode C, postMessage for Mode B, MessageChannel for Mode A)
- Camera system (orthographic projection)
- The `engine_push_commands` pattern (how SAB→WASM bridge was resolved)
- Update test counts and module counts

**Step 3: Commit**

```bash
git add CLAUDE.md PROJECT_ARCHITECTURE.md
git commit -m "docs: update architecture docs for Phase 2 render core"
```

---

## Summary

After completing all 10 tasks, the project will have:

**New Rust (crates/hyperion-core):**
- `render_state.rs` — Collects model matrices into contiguous GPU-uploadable buffer
- `ring_buffer.rs` — Added `parse_commands()` for flat byte slice parsing
- `engine.rs` — Separated `process_commands()` from `update()`, added RenderState
- `lib.rs` — New exports: `engine_push_commands`, `engine_render_state_*`

**New TypeScript (ts/src):**
- `renderer.ts` — WebGPU renderer (pipeline, buffers, instanced drawing)
- `camera.ts` — Orthographic camera with view-projection matrix
- `shaders/basic.wgsl` — Instanced colored quad shader
- `render-worker.ts` — Mode A render worker (OffscreenCanvas + WebGPU)
- `vite-env.d.ts` — Type declarations for WGSL imports

**Modified TypeScript:**
- `engine-worker.ts` — Wired SAB→WASM command flow + render state export
- `worker-bridge.ts` — Mode C tick, Mode A/B bridges, render state transfer
- `main.ts` — Renderer integration, test entities, debug overlay
- `index.html` — Full-viewport canvas with overlay

**Key architectural achievements:**
- Commands flow: TS → SAB ring buffer → Worker → `engine_push_commands(&[u8])` → Rust ECS (all modes)
- Render state flows: Rust ECS → WASM memory/postMessage/MessageChannel → WebGPU pipeline (all modes)
- WebGPU from TypeScript (not Rust wgpu) — zero binary size impact
- Instanced quad rendering with storage buffers for model matrices
- Debug overlay: FPS, entity count, execution mode, render thread
- Phase 0-1 gap resolved: ring buffer SAB now flows commands to WASM in all modes
