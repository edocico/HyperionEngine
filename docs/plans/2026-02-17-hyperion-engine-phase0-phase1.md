# Hyperion Engine — Phase 0 & Phase 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the foundational scaffold (Rust/WASM workspace, TypeScript harness, adaptive multi-thread execution model, Ring Buffer) and the ECS core (hecs, transforms, deterministic tick loop, command protocol).

**Architecture:** A Cargo workspace produces a WASM module consumed by a TypeScript harness. The harness detects browser capabilities at startup and selects one of three execution modes (Full Isolation / Partial Isolation / Single Thread). Communication between JS and WASM uses a lock-free Ring Buffer on SharedArrayBuffer (Modes A/B) or direct calls (Mode C). The ECS runs inside a Web Worker (Modes A/B) or on the Main Thread (Mode C).

**Tech Stack:** Rust 1.93, `hecs` 0.11, `glam` 0.29, `wgpu` 28.0, `wasm-bindgen`, TypeScript 5.x, Vite (dev server with COOP/COEP headers), Web Workers, SharedArrayBuffer.

**Design Doc:** `docs/plans/2026-02-17-hyperion-engine-design.md`

---

## Prerequisites

Before starting, install required tooling:

```bash
# WASM target (already installed)
rustup target add wasm32-unknown-unknown

# wasm-pack for building Rust -> WASM + JS glue
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# wasm-opt for production binary optimization
cargo install wasm-opt

# Verify
wasm-pack --version
```

---

## PHASE 0: Scaffold & Execution Harness

### Task 1: Initialize Cargo Workspace

**Files:**
- Create: `Cargo.toml` (workspace root)
- Create: `crates/hyperion-core/Cargo.toml`
- Create: `crates/hyperion-core/src/lib.rs`

**Step 1: Create workspace root Cargo.toml**

```toml
[workspace]
resolver = "2"
members = ["crates/hyperion-core"]

[workspace.package]
version = "0.1.0"
edition = "2024"
license = "MIT"

[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1

[profile.dev]
opt-level = 1
debug = true
```

**Step 2: Create the core crate**

```bash
mkdir -p crates/hyperion-core/src
```

`crates/hyperion-core/Cargo.toml`:
```toml
[package]
name = "hyperion-core"
version.workspace = true
edition.workspace = true

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"
glam = { version = "0.29", features = ["bytemuck"] }
hecs = "0.11"
bytemuck = { version = "1", features = ["derive"] }

[dev-dependencies]
wasm-bindgen-test = "0.3"
```

`crates/hyperion-core/src/lib.rs`:
```rust
use wasm_bindgen::prelude::*;

/// Smoke-test export: returns a + b.
/// This validates the full WASM build pipeline.
#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
```

**Step 3: Verify it compiles for WASM**

Run: `cargo build --target wasm32-unknown-unknown -p hyperion-core`
Expected: Compiles successfully.

**Step 4: Verify native tests work**

Run: `cargo test -p hyperion-core`
Expected: 0 tests, no compilation errors.

**Step 5: Commit**

```bash
git add Cargo.toml crates/
git commit -m "feat: initialize Cargo workspace with hyperion-core crate"
```

---

### Task 2: Initialize TypeScript Project with Vite

**Files:**
- Create: `ts/package.json`
- Create: `ts/tsconfig.json`
- Create: `ts/vite.config.ts`
- Create: `ts/index.html`
- Create: `ts/src/main.ts`

**Step 1: Create package.json**

`ts/package.json`:
```json
{
  "name": "hyperion-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "build:wasm": "wasm-pack build ../crates/hyperion-core --target web --out-dir ../../ts/wasm"
  },
  "devDependencies": {
    "typescript": "^5.7",
    "vite": "^6.1"
  }
}
```

**Step 2: Create tsconfig.json**

`ts/tsconfig.json`:
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
    "rootDir": "src"
  },
  "include": ["src"]
}
```

**Step 3: Create Vite config with COOP/COEP headers**

`ts/vite.config.ts`:
```typescript
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    target: "esnext",
  },
});
```

**Step 4: Create index.html**

`ts/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Hyperion Engine</title>
    <style>
      body { margin: 0; background: #111; color: #eee; font-family: monospace; }
      canvas { display: block; }
      #info { position: fixed; top: 10px; left: 10px; font-size: 14px; }
    </style>
  </head>
  <body>
    <div id="info">Hyperion Engine — initializing...</div>
    <canvas id="canvas" width="800" height="600"></canvas>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

**Step 5: Create main.ts with smoke test**

`ts/src/main.ts`:
```typescript
async function main() {
  const info = document.getElementById("info")!;
  info.textContent = "Hyperion Engine — loading WASM...";

  try {
    const wasm = await import("../wasm/hyperion_core.js");
    await wasm.default();
    const result = wasm.add(2, 3);
    info.textContent = `Hyperion Engine — WASM OK (2 + 3 = ${result})`;
  } catch (e) {
    info.textContent = `Hyperion Engine — WASM FAILED: ${e}`;
    console.error(e);
  }
}

main();
```

**Step 6: Install dependencies and build WASM**

```bash
cd ts && npm install
npm run build:wasm
```

Expected: `ts/wasm/` directory created with `hyperion_core.js`, `hyperion_core_bg.wasm`, `hyperion_core.d.ts`.

**Step 7: Run dev server and verify in browser**

Run: `cd ts && npm run dev`
Expected: Browser shows "Hyperion Engine — WASM OK (2 + 3 = 5)".

**Step 8: Commit**

```bash
git add ts/
git commit -m "feat: add TypeScript project with Vite dev server and COOP/COEP headers"
```

---

### Task 3: Capability Detection Module

**Files:**
- Create: `ts/src/capabilities.ts`
- Create: `ts/src/capabilities.test.ts`

**Step 1: Write the capability detection module**

`ts/src/capabilities.ts`:
```typescript
export const enum ExecutionMode {
  /** Full isolation: 3 threads (Main + ECS Worker + Render Worker) */
  FullIsolation = "A",
  /** Partial isolation: 2 threads (Main+Render + ECS Worker) */
  PartialIsolation = "B",
  /** Single thread: everything on Main Thread */
  SingleThread = "C",
}

export interface Capabilities {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  offscreenCanvas: boolean;
  webgpu: boolean;
  webgpuInWorker: boolean;
}

export function detectCapabilities(): Capabilities {
  const crossOriginIsolated =
    typeof globalThis.crossOriginIsolated === "boolean"
      ? globalThis.crossOriginIsolated
      : false;

  const sharedArrayBuffer =
    crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";

  const offscreenCanvas = typeof OffscreenCanvas !== "undefined";

  const webgpu = "gpu" in navigator;

  // WebGPU in Workers: we can't definitively test this from Main Thread.
  // Use a known-good heuristic: Chrome/Edge support it, Firefox does not yet.
  const ua = navigator.userAgent;
  const isChromium = /Chrome\//.test(ua) && !/Edg\//.test(ua);
  const isEdge = /Edg\//.test(ua);
  const webgpuInWorker = webgpu && offscreenCanvas && (isChromium || isEdge);

  return {
    crossOriginIsolated,
    sharedArrayBuffer,
    offscreenCanvas,
    webgpu,
    webgpuInWorker,
  };
}

export function selectExecutionMode(caps: Capabilities): ExecutionMode {
  if (caps.sharedArrayBuffer && caps.webgpuInWorker && caps.offscreenCanvas) {
    return ExecutionMode.FullIsolation;
  }
  if (caps.sharedArrayBuffer && caps.webgpu) {
    return ExecutionMode.PartialIsolation;
  }
  return ExecutionMode.SingleThread;
}

export function logCapabilities(caps: Capabilities, mode: ExecutionMode): void {
  console.group("Hyperion Engine — Capabilities");
  console.log("Cross-Origin Isolated:", caps.crossOriginIsolated);
  console.log("SharedArrayBuffer:", caps.sharedArrayBuffer);
  console.log("OffscreenCanvas:", caps.offscreenCanvas);
  console.log("WebGPU:", caps.webgpu);
  console.log("WebGPU in Worker:", caps.webgpuInWorker);
  console.log("Execution Mode:", mode);

  if (!caps.crossOriginIsolated) {
    console.warn(
      "COOP/COEP headers not set. SharedArrayBuffer unavailable. " +
        "Running in single-thread mode. Set these headers for full performance:\n" +
        "  Cross-Origin-Opener-Policy: same-origin\n" +
        "  Cross-Origin-Embedder-Policy: require-corp"
    );
  }

  console.groupEnd();
}
```

**Step 2: Write unit tests**

`ts/src/capabilities.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import {
  selectExecutionMode,
  ExecutionMode,
  type Capabilities,
} from "./capabilities";

function makeCaps(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    offscreenCanvas: true,
    webgpu: true,
    webgpuInWorker: true,
    ...overrides,
  };
}

describe("selectExecutionMode", () => {
  it("selects Mode A when all capabilities present", () => {
    expect(selectExecutionMode(makeCaps())).toBe(ExecutionMode.FullIsolation);
  });

  it("selects Mode B when WebGPU in Worker is unavailable", () => {
    expect(
      selectExecutionMode(makeCaps({ webgpuInWorker: false }))
    ).toBe(ExecutionMode.PartialIsolation);
  });

  it("selects Mode C when SharedArrayBuffer is unavailable", () => {
    expect(
      selectExecutionMode(makeCaps({ sharedArrayBuffer: false }))
    ).toBe(ExecutionMode.SingleThread);
  });

  it("selects Mode C when no WebGPU", () => {
    expect(
      selectExecutionMode(makeCaps({ webgpu: false, sharedArrayBuffer: false }))
    ).toBe(ExecutionMode.SingleThread);
  });
});
```

**Step 3: Install vitest and run tests**

```bash
cd ts && npm install -D vitest
```

Add to `ts/package.json` scripts:
```json
"test": "vitest run",
"test:watch": "vitest"
```

Run: `cd ts && npm test`
Expected: 4 tests pass.

**Step 4: Commit**

```bash
git add ts/src/capabilities.ts ts/src/capabilities.test.ts ts/package.json
git commit -m "feat: add capability detection and execution mode selection"
```

---

### Task 4: Ring Buffer — Rust Side (Consumer)

**Files:**
- Create: `crates/hyperion-core/src/ring_buffer.rs`
- Modify: `crates/hyperion-core/src/lib.rs`

The Ring Buffer is a fixed-size circular buffer in SharedArrayBuffer. Layout:

```
Offset 0:  write_head (u32, atomic) — written by JS
Offset 4:  read_head  (u32, atomic) — written by Rust
Offset 8:  capacity   (u32, const)
Offset 12: [padding to 16-byte align]
Offset 16: data[0..capacity] — command bytes
```

Each command is: `[cmd_type: u8][entity_id: u32][payload: variable]`.

**Step 1: Write the Ring Buffer consumer**

`crates/hyperion-core/src/ring_buffer.rs`:
```rust
//! Lock-free SPSC ring buffer consumer.
//!
//! The producer (TypeScript) writes commands and advances `write_head`.
//! The consumer (Rust) reads commands and advances `read_head`.
//! Both heads are atomic u32 values stored at the start of a SharedArrayBuffer.

use std::sync::atomic::{AtomicU32, Ordering};

const HEADER_SIZE: usize = 16;
const WRITE_HEAD_OFFSET: usize = 0;
const READ_HEAD_OFFSET: usize = 4;

/// Command types that can be sent from TypeScript to Rust.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandType {
    Noop = 0,
    SpawnEntity = 1,
    DespawnEntity = 2,
    SetPosition = 3,
    SetRotation = 4,
    SetScale = 5,
    SetVelocity = 6,
}

impl CommandType {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Noop),
            1 => Some(Self::SpawnEntity),
            2 => Some(Self::DespawnEntity),
            3 => Some(Self::SetPosition),
            4 => Some(Self::SetRotation),
            5 => Some(Self::SetScale),
            6 => Some(Self::SetVelocity),
            _ => None,
        }
    }

    /// Size of the payload (in bytes) for this command type, excluding the
    /// 1-byte type header and 4-byte entity ID.
    pub fn payload_size(self) -> usize {
        match self {
            Self::Noop => 0,
            Self::SpawnEntity => 0,
            Self::DespawnEntity => 0,
            Self::SetPosition => 12,  // 3 x f32
            Self::SetRotation => 16,  // 4 x f32 (quaternion)
            Self::SetScale => 12,     // 3 x f32
            Self::SetVelocity => 12,  // 3 x f32
        }
    }

    /// Total size of a command message (type + entity_id + payload).
    pub fn message_size(self) -> usize {
        1 + 4 + self.payload_size()
    }
}

/// A parsed command read from the ring buffer.
#[derive(Debug)]
pub struct Command {
    pub cmd_type: CommandType,
    pub entity_id: u32,
    pub payload: [u8; 16], // max payload is 16 bytes (quaternion)
}

/// Reads commands from a shared memory ring buffer.
///
/// # Safety
/// The backing memory must be a SharedArrayBuffer that outlives this struct.
/// Only one consumer should exist per buffer.
pub struct RingBufferConsumer {
    base: *mut u8,
    capacity: usize,
}

// Safety: The ring buffer is designed for cross-thread use via atomics.
unsafe impl Send for RingBufferConsumer {}

impl RingBufferConsumer {
    /// Create a consumer from a raw pointer to SharedArrayBuffer memory.
    ///
    /// # Safety
    /// - `ptr` must point to at least `HEADER_SIZE + capacity` bytes of valid
    ///   shared memory.
    /// - The memory must remain valid for the lifetime of this consumer.
    pub unsafe fn new(ptr: *mut u8, capacity: usize) -> Self {
        Self {
            base: ptr,
            capacity,
        }
    }

    fn write_head(&self) -> &AtomicU32 {
        unsafe {
            &*(self.base.add(WRITE_HEAD_OFFSET) as *const AtomicU32)
        }
    }

    fn read_head(&self) -> &AtomicU32 {
        unsafe {
            &*(self.base.add(READ_HEAD_OFFSET) as *const AtomicU32)
        }
    }

    fn data_ptr(&self) -> *const u8 {
        unsafe { self.base.add(HEADER_SIZE) }
    }

    /// Number of bytes available to read.
    pub fn available(&self) -> usize {
        let w = self.write_head().load(Ordering::Acquire) as usize;
        let r = self.read_head().load(Ordering::Relaxed) as usize;
        if w >= r {
            w - r
        } else {
            self.capacity - r + w
        }
    }

    /// Read a single byte from the ring at the given offset (wrapping).
    fn read_byte(&self, offset: usize) -> u8 {
        let idx = offset % self.capacity;
        unsafe { *self.data_ptr().add(idx) }
    }

    /// Read N bytes from the ring starting at `offset`, writing into `dst`.
    fn read_bytes(&self, offset: usize, dst: &mut [u8]) {
        for (i, byte) in dst.iter_mut().enumerate() {
            *byte = self.read_byte(offset + i);
        }
    }

    /// Drain all available commands from the buffer.
    /// Returns a Vec of parsed commands.
    pub fn drain(&self) -> Vec<Command> {
        let mut commands = Vec::new();
        let mut r = self.read_head().load(Ordering::Relaxed) as usize;
        let w = self.write_head().load(Ordering::Acquire) as usize;

        while r != w {
            let cmd_byte = self.read_byte(r);
            let Some(cmd_type) = CommandType::from_u8(cmd_byte) else {
                // Corrupted command — skip to write head to recover.
                r = w;
                break;
            };

            let msg_size = cmd_type.message_size();
            let avail = if w >= r { w - r } else { self.capacity - r + w };
            if avail < msg_size {
                // Incomplete message — wait for next frame.
                break;
            }

            // Read entity_id (4 bytes, little-endian)
            let mut id_bytes = [0u8; 4];
            self.read_bytes(r + 1, &mut id_bytes);
            let entity_id = u32::from_le_bytes(id_bytes);

            // Read payload
            let mut payload = [0u8; 16];
            let psize = cmd_type.payload_size();
            if psize > 0 {
                self.read_bytes(r + 5, &mut payload[..psize]);
            }

            commands.push(Command {
                cmd_type,
                entity_id,
                payload,
            });

            r = (r + msg_size) % self.capacity;
        }

        // Commit the new read head.
        self.read_head().store(r as u32, Ordering::Release);

        commands
    }
}
```

**Step 2: Write tests for the Ring Buffer**

Add to `crates/hyperion-core/src/ring_buffer.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    const TEST_CAPACITY: usize = 256;
    const TOTAL_SIZE: usize = HEADER_SIZE + TEST_CAPACITY;

    fn setup_buffer() -> (Vec<u8>, RingBufferConsumer) {
        let mut mem = vec![0u8; TOTAL_SIZE];
        // Write capacity at offset 8
        let cap_bytes = (TEST_CAPACITY as u32).to_le_bytes();
        mem[8..12].copy_from_slice(&cap_bytes);

        let ptr = mem.as_mut_ptr();
        let consumer = unsafe { RingBufferConsumer::new(ptr, TEST_CAPACITY) };
        (mem, consumer)
    }

    fn write_command(mem: &mut [u8], offset: usize, cmd: u8, entity_id: u32, payload: &[u8]) -> usize {
        let data_base = HEADER_SIZE;
        let cap = TEST_CAPACITY;
        let mut pos = offset;

        mem[data_base + (pos % cap)] = cmd;
        pos += 1;

        let id_bytes = entity_id.to_le_bytes();
        for b in &id_bytes {
            mem[data_base + (pos % cap)] = *b;
            pos += 1;
        }

        for b in payload {
            mem[data_base + (pos % cap)] = *b;
            pos += 1;
        }

        pos
    }

    fn set_write_head(mem: &mut [u8], val: u32) {
        let bytes = val.to_le_bytes();
        mem[WRITE_HEAD_OFFSET..WRITE_HEAD_OFFSET + 4].copy_from_slice(&bytes);
    }

    #[test]
    fn empty_buffer_drains_nothing() {
        let (_mem, consumer) = setup_buffer();
        let cmds = consumer.drain();
        assert!(cmds.is_empty());
        assert_eq!(consumer.available(), 0);
    }

    #[test]
    fn reads_spawn_command() {
        let (mut mem, consumer) = setup_buffer();
        let end = write_command(&mut mem, 0, CommandType::SpawnEntity as u8, 42, &[]);
        set_write_head(&mut mem, end as u32);

        let cmds = consumer.drain();
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].cmd_type, CommandType::SpawnEntity);
        assert_eq!(cmds[0].entity_id, 42);
    }

    #[test]
    fn reads_position_command_with_payload() {
        let (mut mem, consumer) = setup_buffer();

        // f32 payload: x=1.0, y=2.0, z=3.0
        let mut payload = Vec::new();
        payload.extend_from_slice(&1.0f32.to_le_bytes());
        payload.extend_from_slice(&2.0f32.to_le_bytes());
        payload.extend_from_slice(&3.0f32.to_le_bytes());

        let end = write_command(&mut mem, 0, CommandType::SetPosition as u8, 7, &payload);
        set_write_head(&mut mem, end as u32);

        let cmds = consumer.drain();
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].cmd_type, CommandType::SetPosition);
        assert_eq!(cmds[0].entity_id, 7);

        let x = f32::from_le_bytes(cmds[0].payload[0..4].try_into().unwrap());
        let y = f32::from_le_bytes(cmds[0].payload[4..8].try_into().unwrap());
        let z = f32::from_le_bytes(cmds[0].payload[8..12].try_into().unwrap());
        assert_eq!((x, y, z), (1.0, 2.0, 3.0));
    }

    #[test]
    fn reads_multiple_commands() {
        let (mut mem, consumer) = setup_buffer();
        let mid = write_command(&mut mem, 0, CommandType::SpawnEntity as u8, 1, &[]);
        let end = write_command(&mut mem, mid, CommandType::DespawnEntity as u8, 2, &[]);
        set_write_head(&mut mem, end as u32);

        let cmds = consumer.drain();
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[0].entity_id, 1);
        assert_eq!(cmds[1].entity_id, 2);
        assert_eq!(cmds[1].cmd_type, CommandType::DespawnEntity);
    }

    #[test]
    fn drain_advances_read_head() {
        let (mut mem, consumer) = setup_buffer();
        let end = write_command(&mut mem, 0, CommandType::SpawnEntity as u8, 1, &[]);
        set_write_head(&mut mem, end as u32);

        consumer.drain();
        // Second drain should return nothing.
        let cmds = consumer.drain();
        assert!(cmds.is_empty());
    }
}
```

**Step 3: Register the module**

Modify `crates/hyperion-core/src/lib.rs`:
```rust
use wasm_bindgen::prelude::*;

pub mod ring_buffer;

#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
```

**Step 4: Run tests**

Run: `cargo test -p hyperion-core`
Expected: 5 tests pass.

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/
git commit -m "feat: add lock-free SPSC ring buffer consumer (Rust side)"
```

---

### Task 5: Ring Buffer — TypeScript Side (Producer)

**Files:**
- Create: `ts/src/ring-buffer.ts`
- Create: `ts/src/ring-buffer.test.ts`

**Step 1: Write the Ring Buffer producer**

`ts/src/ring-buffer.ts`:
```typescript
const HEADER_SIZE = 16;
const WRITE_HEAD_OFFSET = 0; // byte offset in i32 units = 0
const READ_HEAD_OFFSET = 1;  // byte offset 4 in i32 units = 1

export const enum CommandType {
  Noop = 0,
  SpawnEntity = 1,
  DespawnEntity = 2,
  SetPosition = 3,
  SetRotation = 4,
  SetScale = 5,
  SetVelocity = 6,
}

/** Payload sizes in bytes for each command type (excluding type + entity_id). */
const PAYLOAD_SIZES: Record<CommandType, number> = {
  [CommandType.Noop]: 0,
  [CommandType.SpawnEntity]: 0,
  [CommandType.DespawnEntity]: 0,
  [CommandType.SetPosition]: 12,
  [CommandType.SetRotation]: 16,
  [CommandType.SetScale]: 12,
  [CommandType.SetVelocity]: 12,
};

/**
 * Lock-free SPSC ring buffer producer.
 *
 * Writes commands into a SharedArrayBuffer that the Rust consumer drains
 * each frame. Uses Atomics for cross-thread synchronization.
 */
export class RingBufferProducer {
  private readonly header: Int32Array;
  private readonly data: DataView;
  private readonly capacity: number;

  constructor(buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, 4);
    this.capacity = buffer.byteLength - HEADER_SIZE;
    this.data = new DataView(buffer, HEADER_SIZE, this.capacity);
  }

  private get writeHead(): number {
    return Atomics.load(this.header, WRITE_HEAD_OFFSET);
  }

  private set writeHead(val: number) {
    Atomics.store(this.header, WRITE_HEAD_OFFSET, val);
  }

  private get readHead(): number {
    return Atomics.load(this.header, READ_HEAD_OFFSET);
  }

  /** Bytes available for writing. */
  get freeSpace(): number {
    const w = this.writeHead;
    const r = this.readHead;
    // Reserve 1 byte to distinguish full from empty.
    if (w >= r) {
      return this.capacity - w + r - 1;
    }
    return r - w - 1;
  }

  /**
   * Write a command into the ring buffer.
   * Returns true if the command was written, false if the buffer is full.
   */
  writeCommand(cmd: CommandType, entityId: number, payload?: Float32Array): boolean {
    const payloadSize = PAYLOAD_SIZES[cmd];
    const msgSize = 1 + 4 + payloadSize;

    if (this.freeSpace < msgSize) {
      console.warn("Ring buffer full, dropping command", CommandType[cmd]);
      return false;
    }

    let pos = this.writeHead;

    // Write command type (1 byte)
    this.data.setUint8(pos % this.capacity, cmd);
    pos++;

    // Write entity ID (4 bytes, little-endian)
    this.writeByte(pos, entityId & 0xff); pos++;
    this.writeByte(pos, (entityId >> 8) & 0xff); pos++;
    this.writeByte(pos, (entityId >> 16) & 0xff); pos++;
    this.writeByte(pos, (entityId >> 24) & 0xff); pos++;

    // Write payload (f32 values, little-endian via DataView)
    if (payload && payloadSize > 0) {
      for (let i = 0; i < payloadSize; i++) {
        const byteIndex = Math.floor(i / 4);
        const byteOffset = i % 4;
        // Extract individual bytes from f32
        const tempView = new DataView(payload.buffer, payload.byteOffset);
        this.writeByte(pos, tempView.getUint8(i));
        pos++;
      }
    }

    // Commit write head (atomic store makes writes visible to consumer).
    this.writeHead = pos % this.capacity;
    return true;
  }

  private writeByte(offset: number, value: number): void {
    this.data.setUint8(offset % this.capacity, value);
  }

  /** Convenience: write a position command. */
  setPosition(entityId: number, x: number, y: number, z: number): boolean {
    const payload = new Float32Array([x, y, z]);
    return this.writeCommand(CommandType.SetPosition, entityId, payload);
  }

  /** Convenience: write a spawn command. */
  spawnEntity(entityId: number): boolean {
    return this.writeCommand(CommandType.SpawnEntity, entityId);
  }

  /** Convenience: write a despawn command. */
  despawnEntity(entityId: number): boolean {
    return this.writeCommand(CommandType.DespawnEntity, entityId);
  }
}

/**
 * Create a SharedArrayBuffer for the ring buffer.
 * Falls back to a regular ArrayBuffer for Mode C (single-thread).
 */
export function createRingBuffer(capacity: number): SharedArrayBuffer | ArrayBuffer {
  const totalSize = HEADER_SIZE + capacity;
  if (typeof SharedArrayBuffer !== "undefined" && crossOriginIsolated) {
    return new SharedArrayBuffer(totalSize);
  }
  return new ArrayBuffer(totalSize);
}
```

**Step 2: Write unit tests**

`ts/src/ring-buffer.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { RingBufferProducer, CommandType } from "./ring-buffer";

const HEADER_SIZE = 16;
const CAPACITY = 256;

function makeBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_SIZE + CAPACITY);
}

function readByte(sab: SharedArrayBuffer, dataOffset: number): number {
  return new Uint8Array(sab, HEADER_SIZE)[dataOffset];
}

function readU32LE(sab: SharedArrayBuffer, dataOffset: number): number {
  const view = new DataView(sab, HEADER_SIZE);
  return view.getUint32(dataOffset, true);
}

function readF32LE(sab: SharedArrayBuffer, dataOffset: number): number {
  const view = new DataView(sab, HEADER_SIZE);
  return view.getFloat32(dataOffset, true);
}

function getWriteHead(sab: SharedArrayBuffer): number {
  return Atomics.load(new Int32Array(sab, 0, 1), 0);
}

describe("RingBufferProducer", () => {
  it("starts with full free space", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);
    expect(rb.freeSpace).toBe(CAPACITY - 1);
  });

  it("writes a spawn command", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);
    const ok = rb.spawnEntity(42);
    expect(ok).toBe(true);

    // Verify: cmd_type=1, entity_id=42 (LE)
    expect(readByte(sab, 0)).toBe(CommandType.SpawnEntity);
    expect(readU32LE(sab, 1)).toBe(42);

    // Write head advanced by 5 (1 cmd + 4 id + 0 payload)
    expect(getWriteHead(sab)).toBe(5);
  });

  it("writes a position command with f32 payload", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);
    const ok = rb.setPosition(7, 1.0, 2.0, 3.0);
    expect(ok).toBe(true);

    expect(readByte(sab, 0)).toBe(CommandType.SetPosition);
    expect(readU32LE(sab, 1)).toBe(7);
    expect(readF32LE(sab, 5)).toBeCloseTo(1.0);
    expect(readF32LE(sab, 9)).toBeCloseTo(2.0);
    expect(readF32LE(sab, 13)).toBeCloseTo(3.0);

    // Write head: 1 + 4 + 12 = 17
    expect(getWriteHead(sab)).toBe(17);
  });

  it("returns false when buffer is full", () => {
    const smallSab = new SharedArrayBuffer(HEADER_SIZE + 8); // only 8 bytes data
    const rb = new RingBufferProducer(smallSab);
    // setPosition needs 17 bytes, buffer has 7 free
    const ok = rb.setPosition(1, 0, 0, 0);
    expect(ok).toBe(false);
  });

  it("writes multiple commands sequentially", () => {
    const sab = makeBuffer();
    const rb = new RingBufferProducer(sab);
    rb.spawnEntity(1);
    rb.spawnEntity(2);
    rb.despawnEntity(3);

    // Three commands: 5 + 5 + 5 = 15
    expect(getWriteHead(sab)).toBe(15);
  });
});
```

**Step 3: Run tests**

Run: `cd ts && npm test`
Expected: All capability tests + ring buffer tests pass.

**Step 4: Commit**

```bash
git add ts/src/ring-buffer.ts ts/src/ring-buffer.test.ts
git commit -m "feat: add lock-free SPSC ring buffer producer (TypeScript side)"
```

---

### Task 6: Web Worker Harness

**Files:**
- Create: `ts/src/engine-worker.ts`
- Create: `ts/src/worker-bridge.ts`
- Modify: `ts/src/main.ts`

**Step 1: Create the engine Worker script**

`ts/src/engine-worker.ts`:
```typescript
/// <reference lib="webworker" />

/**
 * Engine Logic Worker.
 * Runs the WASM ECS module, consuming commands from the ring buffer
 * and producing render state.
 */

let wasmModule: typeof import("../wasm/hyperion_core.js") | null = null;

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
        const wasm = await import("../wasm/hyperion_core.js");
        await wasm.default();
        wasmModule = wasm;
        self.postMessage({ type: "ready" });
      } catch (e) {
        self.postMessage({ type: "error", error: String(e) });
      }
      break;
    }

    case "tick": {
      if (!wasmModule) return;
      // Phase 1 will add: consume ring buffer, run ECS tick, emit render state.
      // For now, acknowledge the tick.
      self.postMessage({ type: "tick-done", dt: msg.dt });
      break;
    }
  }
};
```

**Step 2: Create the worker bridge**

`ts/src/worker-bridge.ts`:
```typescript
import { ExecutionMode } from "./capabilities";
import { createRingBuffer, RingBufferProducer } from "./ring-buffer";

const RING_BUFFER_CAPACITY = 64 * 1024; // 64KB command buffer

export interface EngineBridge {
  mode: ExecutionMode;
  commandBuffer: RingBufferProducer;
  /** Send a tick signal. In Mode C, this runs synchronously. */
  tick(dt: number): void;
  /** Wait for the engine to be ready. */
  ready(): Promise<void>;
  /** Shut down the engine. */
  destroy(): void;
}

/**
 * Create the engine bridge for Modes A/B (Worker-based).
 */
export function createWorkerBridge(mode: ExecutionMode.FullIsolation | ExecutionMode.PartialIsolation): EngineBridge {
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

  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "ready") {
      readyResolve();
    } else if (msg.type === "error") {
      console.error("Engine Worker error:", msg.error);
    }
  };

  // Initialize the worker with the shared command buffer.
  worker.postMessage({ type: "init", commandBuffer: sab } satisfies { type: "init"; commandBuffer: SharedArrayBuffer });

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
  };
}

/**
 * Create the engine bridge for Mode C (single-thread, no Worker).
 */
export async function createDirectBridge(): Promise<EngineBridge> {
  const buffer = createRingBuffer(RING_BUFFER_CAPACITY);
  // In Mode C, RingBufferProducer works on a regular ArrayBuffer too,
  // but we use it for API consistency. Commands are consumed synchronously.
  const producer = new RingBufferProducer(buffer as SharedArrayBuffer);

  const wasm = await import("../wasm/hyperion_core.js");
  await wasm.default();

  return {
    mode: ExecutionMode.SingleThread,
    commandBuffer: producer,
    tick(_dt: number) {
      // Phase 1: synchronously consume ring buffer and run ECS tick.
    },
    async ready() {
      // Already ready — WASM loaded synchronously above.
    },
    destroy() {
      // Nothing to terminate in single-thread mode.
    },
  };
}
```

**Step 3: Update main.ts to use the bridge**

`ts/src/main.ts`:
```typescript
import {
  detectCapabilities,
  selectExecutionMode,
  logCapabilities,
  ExecutionMode,
} from "./capabilities";
import { createWorkerBridge, createDirectBridge, type EngineBridge } from "./worker-bridge";

async function main() {
  const info = document.getElementById("info")!;
  info.textContent = "Hyperion Engine — detecting capabilities...";

  const caps = detectCapabilities();
  const mode = selectExecutionMode(caps);
  logCapabilities(caps, mode);

  info.textContent = `Hyperion Engine — Mode ${mode}, loading WASM...`;

  let bridge: EngineBridge;

  if (mode === ExecutionMode.FullIsolation || mode === ExecutionMode.PartialIsolation) {
    bridge = createWorkerBridge(mode);
  } else {
    bridge = await createDirectBridge();
  }

  await bridge.ready();
  info.textContent = `Hyperion Engine — Mode ${mode}, ready`;

  // Main loop
  let lastTime = performance.now();

  function frame(now: number) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    bridge.tick(dt);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main();
```

**Step 4: Rebuild WASM and test in browser**

```bash
cd ts && npm run build:wasm && npm run dev
```

Expected: Browser console shows capability detection log. Page shows "Hyperion Engine — Mode A/B/C, ready" depending on browser.

**Step 5: Commit**

```bash
git add ts/src/engine-worker.ts ts/src/worker-bridge.ts ts/src/main.ts
git commit -m "feat: add Web Worker harness and adaptive execution bridge"
```

---

## PHASE 1: ECS Core

### Task 7: Core ECS Components

**Files:**
- Create: `crates/hyperion-core/src/components.rs`
- Modify: `crates/hyperion-core/src/lib.rs`

**Step 1: Define core components**

`crates/hyperion-core/src/components.rs`:
```rust
//! Core ECS components.
//!
//! All spatial components use `glam` types for SIMD acceleration.
//! Components are plain data structs — no methods, no trait objects.

use bytemuck::{Pod, Zeroable};
use glam::{Quat, Vec3};

/// World-space position.
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct Position(pub Vec3);

/// World-space rotation as a quaternion.
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct Rotation(pub Quat);

/// Non-uniform scale.
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct Scale(pub Vec3);

/// Linear velocity (units per second).
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct Velocity(pub Vec3);

/// Computed 4x4 model matrix, updated by the transform system.
/// This is what gets uploaded to the GPU.
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct ModelMatrix(pub [f32; 16]);

/// Marker: entity is active and should be simulated/rendered.
#[derive(Debug, Clone, Copy)]
pub struct Active;

impl Default for Position {
    fn default() -> Self {
        Self(Vec3::ZERO)
    }
}

impl Default for Rotation {
    fn default() -> Self {
        Self(Quat::IDENTITY)
    }
}

impl Default for Scale {
    fn default() -> Self {
        Self(Vec3::ONE)
    }
}

impl Default for Velocity {
    fn default() -> Self {
        Self(Vec3::ZERO)
    }
}

impl Default for ModelMatrix {
    fn default() -> Self {
        Self(glam::Mat4::IDENTITY.to_cols_array())
    }
}
```

**Step 2: Write tests**

Add to `crates/hyperion-core/src/components.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_position_is_origin() {
        let p = Position::default();
        assert_eq!(p.0, Vec3::ZERO);
    }

    #[test]
    fn default_rotation_is_identity() {
        let r = Rotation::default();
        assert_eq!(r.0, Quat::IDENTITY);
    }

    #[test]
    fn default_scale_is_one() {
        let s = Scale::default();
        assert_eq!(s.0, Vec3::ONE);
    }

    #[test]
    fn model_matrix_is_pod() {
        // Verify the component can be safely cast to bytes (required for GPU upload).
        let m = ModelMatrix::default();
        let bytes = bytemuck::bytes_of(&m);
        assert_eq!(bytes.len(), 64); // 16 floats * 4 bytes
    }
}
```

**Step 3: Register module**

Add to `crates/hyperion-core/src/lib.rs`:
```rust
pub mod components;
```

**Step 4: Run tests**

Run: `cargo test -p hyperion-core`
Expected: All ring buffer + component tests pass.

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/components.rs crates/hyperion-core/src/lib.rs
git commit -m "feat: add core ECS components (Position, Rotation, Scale, Velocity, ModelMatrix)"
```

---

### Task 8: Transform System

**Files:**
- Create: `crates/hyperion-core/src/systems.rs`
- Modify: `crates/hyperion-core/src/lib.rs`

**Step 1: Write the transform system**

`crates/hyperion-core/src/systems.rs`:
```rust
//! ECS systems that operate on component queries.

use glam::{Mat4, Vec3};
use hecs::World;

use crate::components::{Active, ModelMatrix, Position, Rotation, Scale, Velocity};

/// Apply velocity to position. Runs once per fixed-timestep tick.
pub fn velocity_system(world: &mut World, dt: f32) {
    for (_, (pos, vel)) in world.query_mut::<(&mut Position, &Velocity)>() {
        pos.0 += vel.0 * dt;
    }
}

/// Recompute model matrices from Position, Rotation, Scale.
/// Runs after all spatial mutations for the current tick.
pub fn transform_system(world: &mut World) {
    for (_, (pos, rot, scale, matrix)) in
        world.query_mut::<(&Position, &Rotation, &Scale, &mut ModelMatrix)>()
    {
        let m = Mat4::from_scale_rotation_translation(scale.0, rot.0, pos.0);
        matrix.0 = m.to_cols_array();
    }
}

/// Count active entities. Useful for debug overlay.
pub fn count_active(world: &World) -> usize {
    world.query::<&Active>().iter().count()
}
```

**Step 2: Write tests**

Add to `crates/hyperion-core/src/systems.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::*;
    use glam::Quat;

    fn spawn_entity(world: &mut World, pos: Vec3, vel: Vec3) -> hecs::Entity {
        world.spawn((
            Position(pos),
            Rotation::default(),
            Scale::default(),
            Velocity(vel),
            ModelMatrix::default(),
            Active,
        ))
    }

    #[test]
    fn velocity_moves_position() {
        let mut world = World::new();
        let e = spawn_entity(&mut world, Vec3::ZERO, Vec3::new(10.0, 0.0, 0.0));

        velocity_system(&mut world, 0.5); // 0.5 seconds

        let pos = world.get::<&Position>(e).unwrap();
        assert_eq!(pos.0, Vec3::new(5.0, 0.0, 0.0));
    }

    #[test]
    fn transform_computes_matrix() {
        let mut world = World::new();
        let e = world.spawn((
            Position(Vec3::new(1.0, 2.0, 3.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix::default(),
        ));

        transform_system(&mut world);

        let matrix = world.get::<&ModelMatrix>(e).unwrap();
        // Translation should appear in columns 12, 13, 14 of a column-major 4x4.
        assert_eq!(matrix.0[12], 1.0);
        assert_eq!(matrix.0[13], 2.0);
        assert_eq!(matrix.0[14], 3.0);
    }

    #[test]
    fn transform_applies_scale() {
        let mut world = World::new();
        let e = world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::new(2.0, 3.0, 4.0)),
            ModelMatrix::default(),
        ));

        transform_system(&mut world);

        let m = world.get::<&ModelMatrix>(e).unwrap();
        assert_eq!(m.0[0], 2.0);  // scale X
        assert_eq!(m.0[5], 3.0);  // scale Y
        assert_eq!(m.0[10], 4.0); // scale Z
    }

    #[test]
    fn count_active_entities() {
        let mut world = World::new();
        spawn_entity(&mut world, Vec3::ZERO, Vec3::ZERO);
        spawn_entity(&mut world, Vec3::ONE, Vec3::ZERO);
        // Spawn one without Active
        world.spawn((Position::default(),));

        assert_eq!(count_active(&world), 2);
    }
}
```

**Step 3: Register module**

Add to `crates/hyperion-core/src/lib.rs`:
```rust
pub mod systems;
```

**Step 4: Run tests**

Run: `cargo test -p hyperion-core`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/systems.rs crates/hyperion-core/src/lib.rs
git commit -m "feat: add velocity and transform systems"
```

---

### Task 9: Command Processor (Bridges Ring Buffer to ECS)

**Files:**
- Create: `crates/hyperion-core/src/command_processor.rs`
- Modify: `crates/hyperion-core/src/lib.rs`

**Step 1: Write the command processor**

`crates/hyperion-core/src/command_processor.rs`:
```rust
//! Translates ring buffer commands into ECS mutations.

use hecs::World;

use crate::components::*;
use crate::ring_buffer::{Command, CommandType};

/// Maps external entity IDs (from TypeScript) to internal hecs entities.
pub struct EntityMap {
    /// Sparse map: external ID -> hecs Entity.
    /// Uses a Vec for O(1) lookup. External IDs are sequential u32s.
    map: Vec<Option<hecs::Entity>>,
    /// Free list for entity recycling.
    free_list: Vec<u32>,
    /// Next external ID to assign.
    next_id: u32,
}

impl EntityMap {
    pub fn new() -> Self {
        Self {
            map: Vec::new(),
            free_list: Vec::new(),
            next_id: 0,
        }
    }

    /// Allocate a new external ID (or recycle one).
    pub fn allocate(&mut self) -> u32 {
        if let Some(id) = self.free_list.pop() {
            id
        } else {
            let id = self.next_id;
            self.next_id += 1;
            id
        }
    }

    /// Register a mapping from external ID to hecs entity.
    pub fn insert(&mut self, external_id: u32, entity: hecs::Entity) {
        let idx = external_id as usize;
        if idx >= self.map.len() {
            self.map.resize(idx + 1, None);
        }
        self.map[idx] = Some(entity);
    }

    /// Look up the hecs entity for an external ID.
    pub fn get(&self, external_id: u32) -> Option<hecs::Entity> {
        self.map.get(external_id as usize).copied().flatten()
    }

    /// Remove a mapping and add the ID to the free list.
    pub fn remove(&mut self, external_id: u32) {
        let idx = external_id as usize;
        if idx < self.map.len() {
            self.map[idx] = None;
            self.free_list.push(external_id);
        }
    }
}

/// Process a batch of commands against the ECS world.
pub fn process_commands(commands: &[Command], world: &mut World, entity_map: &mut EntityMap) {
    for cmd in commands {
        match cmd.cmd_type {
            CommandType::SpawnEntity => {
                let entity = world.spawn((
                    Position::default(),
                    Rotation::default(),
                    Scale::default(),
                    Velocity::default(),
                    ModelMatrix::default(),
                    Active,
                ));
                entity_map.insert(cmd.entity_id, entity);
            }

            CommandType::DespawnEntity => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let _ = world.despawn(entity);
                    entity_map.remove(cmd.entity_id);
                }
            }

            CommandType::SetPosition => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let x = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                    let y = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                    let z = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                    if let Ok(mut pos) = world.get::<&mut Position>(entity) {
                        pos.0 = glam::Vec3::new(x, y, z);
                    }
                }
            }

            CommandType::SetRotation => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let x = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                    let y = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                    let z = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                    let w = f32::from_le_bytes(cmd.payload[12..16].try_into().unwrap());
                    if let Ok(mut rot) = world.get::<&mut Rotation>(entity) {
                        rot.0 = glam::Quat::from_xyzw(x, y, z, w);
                    }
                }
            }

            CommandType::SetScale => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let x = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                    let y = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                    let z = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                    if let Ok(mut scale) = world.get::<&mut Scale>(entity) {
                        scale.0 = glam::Vec3::new(x, y, z);
                    }
                }
            }

            CommandType::SetVelocity => {
                if let Some(entity) = entity_map.get(cmd.entity_id) {
                    let x = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
                    let y = f32::from_le_bytes(cmd.payload[4..8].try_into().unwrap());
                    let z = f32::from_le_bytes(cmd.payload[8..12].try_into().unwrap());
                    if let Ok(mut vel) = world.get::<&mut Velocity>(entity) {
                        vel.0 = glam::Vec3::new(x, y, z);
                    }
                }
            }

            CommandType::Noop => {}
        }
    }
}
```

**Step 2: Write tests**

Add to `crates/hyperion-core/src/command_processor.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ring_buffer::CommandType;

    fn make_spawn_cmd(id: u32) -> Command {
        Command {
            cmd_type: CommandType::SpawnEntity,
            entity_id: id,
            payload: [0; 16],
        }
    }

    fn make_position_cmd(id: u32, x: f32, y: f32, z: f32) -> Command {
        let mut payload = [0u8; 16];
        payload[0..4].copy_from_slice(&x.to_le_bytes());
        payload[4..8].copy_from_slice(&y.to_le_bytes());
        payload[8..12].copy_from_slice(&z.to_le_bytes());
        Command {
            cmd_type: CommandType::SetPosition,
            entity_id: id,
            payload,
        }
    }

    fn make_despawn_cmd(id: u32) -> Command {
        Command {
            cmd_type: CommandType::DespawnEntity,
            entity_id: id,
            payload: [0; 16],
        }
    }

    #[test]
    fn spawn_creates_entity() {
        let mut world = World::new();
        let mut map = EntityMap::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map);

        assert!(map.get(0).is_some());
        let entity = map.get(0).unwrap();
        assert!(world.get::<&Position>(entity).is_ok());
        assert!(world.get::<&Active>(entity).is_ok());
    }

    #[test]
    fn set_position_updates_component() {
        let mut world = World::new();
        let mut map = EntityMap::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map);
        process_commands(
            &[make_position_cmd(0, 5.0, 10.0, 15.0)],
            &mut world,
            &mut map,
        );

        let entity = map.get(0).unwrap();
        let pos = world.get::<&Position>(entity).unwrap();
        assert_eq!(pos.0, glam::Vec3::new(5.0, 10.0, 15.0));
    }

    #[test]
    fn despawn_removes_entity() {
        let mut world = World::new();
        let mut map = EntityMap::new();

        process_commands(&[make_spawn_cmd(0)], &mut world, &mut map);
        let entity = map.get(0).unwrap();

        process_commands(&[make_despawn_cmd(0)], &mut world, &mut map);

        assert!(map.get(0).is_none());
        assert!(world.get::<&Position>(entity).is_err());
    }

    #[test]
    fn entity_id_recycling() {
        let mut map = EntityMap::new();
        let id1 = map.allocate();
        let id2 = map.allocate();
        assert_eq!(id1, 0);
        assert_eq!(id2, 1);

        map.remove(id1);
        let id3 = map.allocate();
        assert_eq!(id3, 0); // recycled
    }

    #[test]
    fn commands_on_nonexistent_entity_are_ignored() {
        let mut world = World::new();
        let mut map = EntityMap::new();

        // Setting position on entity 99 which doesn't exist should not panic.
        process_commands(
            &[make_position_cmd(99, 1.0, 2.0, 3.0)],
            &mut world,
            &mut map,
        );
        // No assertion needed — just verifying no panic.
    }
}
```

**Step 3: Register module**

Add to `crates/hyperion-core/src/lib.rs`:
```rust
pub mod command_processor;
```

**Step 4: Run tests**

Run: `cargo test -p hyperion-core`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add crates/hyperion-core/src/command_processor.rs crates/hyperion-core/src/lib.rs
git commit -m "feat: add command processor bridging ring buffer to ECS"
```

---

### Task 10: Deterministic Tick Loop (Engine Core)

**Files:**
- Create: `crates/hyperion-core/src/engine.rs`
- Modify: `crates/hyperion-core/src/lib.rs`

**Step 1: Write the engine core**

`crates/hyperion-core/src/engine.rs`:
```rust
//! The main engine struct that ties together ECS, command processing,
//! and systems into a deterministic fixed-timestep tick loop.

use hecs::World;

use crate::command_processor::{process_commands, EntityMap};
use crate::ring_buffer::{Command, RingBufferConsumer};
use crate::systems::{transform_system, velocity_system};

/// Fixed timestep: 60 ticks per second.
pub const FIXED_DT: f32 = 1.0 / 60.0;

/// The core engine state.
pub struct Engine {
    pub world: World,
    pub entity_map: EntityMap,
    accumulator: f32,
    tick_count: u64,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            world: World::new(),
            entity_map: EntityMap::new(),
            accumulator: 0.0,
            tick_count: 0,
        }
    }

    /// Advance the engine by `dt` seconds (variable, from requestAnimationFrame).
    /// Internally uses fixed-timestep accumulation.
    ///
    /// `commands` are processed once before any physics ticks for this frame.
    pub fn update(&mut self, dt: f32, commands: &[Command]) {
        // 1. Process all commands from the ring buffer.
        process_commands(commands, &mut self.world, &mut self.entity_map);

        // 2. Accumulate time and run fixed-timestep ticks.
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

        // 3. Recompute model matrices after all ticks.
        transform_system(&mut self.world);
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

**Step 2: Write tests**

Add to `crates/hyperion-core/src/engine.rs`:
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
        engine.update(0.0, &[spawn_cmd(0), velocity_cmd(0, 60.0, 0.0, 0.0)]);

        // Run for exactly 1 fixed tick (1/60th second).
        engine.update(FIXED_DT, &[]);

        let entity = engine.entity_map.get(0).unwrap();
        let pos = engine.world.get::<&crate::components::Position>(entity).unwrap();
        assert!((pos.0.x - 1.0).abs() < 0.001); // 60 units/s * 1/60s = 1 unit
    }

    #[test]
    fn fixed_timestep_accumulates() {
        let mut engine = Engine::new();
        engine.update(0.0, &[spawn_cmd(0), velocity_cmd(0, 60.0, 0.0, 0.0)]);

        // Run for half a tick — should not advance physics.
        engine.update(FIXED_DT * 0.5, &[]);
        assert_eq!(engine.tick_count(), 0);

        // Run for another half — now one full tick should fire.
        engine.update(FIXED_DT * 0.5, &[]);
        assert_eq!(engine.tick_count(), 1);
    }

    #[test]
    fn spiral_of_death_capped() {
        let mut engine = Engine::new();
        // Pass a huge dt — should be capped to 10 ticks max.
        engine.update(100.0, &[]);
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

        engine.update(0.0, &[spawn_cmd(0), pos_cmd]);
        engine.update(FIXED_DT, &[]);

        let entity = engine.entity_map.get(0).unwrap();
        let matrix = engine.world.get::<&crate::components::ModelMatrix>(entity).unwrap();
        // Translation in column-major: indices 12, 13, 14
        assert!((matrix.0[12] - 5.0).abs() < 0.001);
        assert!((matrix.0[13] - 10.0).abs() < 0.001);
        assert!((matrix.0[14] - 15.0).abs() < 0.001);
    }
}
```

**Step 3: Register module and expose WASM API**

Update `crates/hyperion-core/src/lib.rs` to its final Phase 1 state:
```rust
use wasm_bindgen::prelude::*;

pub mod command_processor;
pub mod components;
pub mod engine;
pub mod ring_buffer;
pub mod systems;

use engine::Engine;
use ring_buffer::RingBufferConsumer;

static mut ENGINE: Option<Engine> = None;
static mut RING_BUFFER: Option<RingBufferConsumer> = None;

/// Initialize the engine. Called once from the Worker.
#[wasm_bindgen]
pub fn engine_init() {
    unsafe {
        ENGINE = Some(Engine::new());
    }
}

/// Attach a ring buffer for command consumption.
/// `ptr` is a pointer into SharedArrayBuffer memory.
/// `capacity` is the data region size (total - 16 byte header).
///
/// # Safety
/// The SharedArrayBuffer must outlive the engine.
#[wasm_bindgen]
pub fn engine_attach_ring_buffer(ptr: *mut u8, capacity: usize) {
    unsafe {
        RING_BUFFER = Some(RingBufferConsumer::new(ptr, capacity));
    }
}

/// Run one frame update. `dt` is seconds since last frame.
/// Drains the ring buffer and runs the ECS tick loop.
#[wasm_bindgen]
pub fn engine_update(dt: f32) {
    unsafe {
        let commands = if let Some(ref rb) = RING_BUFFER {
            rb.drain()
        } else {
            Vec::new()
        };

        if let Some(ref mut engine) = ENGINE {
            engine.update(dt, &commands);
        }
    }
}

/// Returns the number of fixed ticks elapsed.
#[wasm_bindgen]
pub fn engine_tick_count() -> u64 {
    unsafe { ENGINE.as_ref().map_or(0, |e| e.tick_count()) }
}

/// Smoke test.
#[wasm_bindgen]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
```

**Step 4: Run all tests**

Run: `cargo test -p hyperion-core`
Expected: All tests pass (ring buffer, components, systems, command processor, engine).

**Step 5: Build WASM and verify**

Run: `cd ts && npm run build:wasm`
Expected: WASM builds successfully with the new exports.

**Step 6: Commit**

```bash
git add crates/hyperion-core/src/
git commit -m "feat: add deterministic tick loop engine with WASM API"
```

---

### Task 11: Wire Engine Worker to WASM Engine

**Files:**
- Modify: `ts/src/engine-worker.ts`

**Step 1: Update the worker to use the full engine API**

`ts/src/engine-worker.ts`:
```typescript
/// <reference lib="webworker" />

/**
 * Engine Logic Worker.
 * Loads the WASM module, attaches the shared ring buffer,
 * and runs the engine tick loop on each frame signal.
 */

interface WasmEngine {
  engine_init(): void;
  engine_attach_ring_buffer(ptr: number, capacity: number): void;
  engine_update(dt: number): void;
  engine_tick_count(): bigint;
  memory: WebAssembly.Memory;
}

let wasm: WasmEngine | null = null;

interface InitMessage {
  type: "init";
  commandBuffer: SharedArrayBuffer;
}

interface TickMessage {
  type: "tick";
  dt: number;
}

type WorkerMessage = InitMessage | TickMessage;

const HEADER_SIZE = 16;

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case "init": {
      try {
        const wasmModule = await import("../wasm/hyperion_core.js");
        await wasmModule.default();
        wasm = wasmModule as unknown as WasmEngine;

        wasm.engine_init();

        // Note: Ring buffer attachment requires passing the SAB pointer
        // into WASM memory. For Phase 0-1, the ring buffer consumer
        // reads directly from the SAB. Full integration with
        // engine_attach_ring_buffer requires wasm-bindgen SharedArrayBuffer
        // support, which will be completed in Phase 2.

        self.postMessage({ type: "ready" });
      } catch (e) {
        self.postMessage({ type: "error", error: String(e) });
      }
      break;
    }

    case "tick": {
      if (!wasm) return;

      wasm.engine_update(msg.dt);

      self.postMessage({
        type: "tick-done",
        dt: msg.dt,
        tickCount: Number(wasm.engine_tick_count()),
      });
      break;
    }
  }
};
```

**Step 2: Rebuild and verify**

```bash
cd ts && npm run build:wasm && npm run dev
```

Expected: Browser shows engine running, console logs ticks.

**Step 3: Commit**

```bash
git add ts/src/engine-worker.ts
git commit -m "feat: wire engine worker to WASM engine tick loop"
```

---

### Task 12: End-to-End Integration Test

**Files:**
- Create: `ts/src/integration.test.ts`

**Step 1: Write an integration test that validates the full pipeline**

`ts/src/integration.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { RingBufferProducer, CommandType } from "./ring-buffer";
import { selectExecutionMode, ExecutionMode, type Capabilities } from "./capabilities";

describe("Integration: Ring Buffer Protocol", () => {
  it("produces commands that match the Rust-expected binary format", () => {
    const sab = new SharedArrayBuffer(16 + 256);
    const rb = new RingBufferProducer(sab);

    rb.spawnEntity(0);
    rb.setPosition(0, 1.5, 2.5, 3.5);
    rb.despawnEntity(0);

    // Verify the write head advanced correctly.
    const header = new Int32Array(sab, 0, 4);
    const writeHead = Atomics.load(header, 0);

    // spawn: 5 bytes + setPosition: 17 bytes + despawn: 5 bytes = 27
    expect(writeHead).toBe(27);

    // Verify the data region has correct command bytes.
    const data = new Uint8Array(sab, 16);
    expect(data[0]).toBe(CommandType.SpawnEntity);
    expect(data[5]).toBe(CommandType.SetPosition);
    expect(data[22]).toBe(CommandType.DespawnEntity);
  });
});

describe("Integration: Mode Selection", () => {
  it("degrades gracefully across all combinations", () => {
    const full: Capabilities = {
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
      offscreenCanvas: true,
      webgpu: true,
      webgpuInWorker: true,
    };
    expect(selectExecutionMode(full)).toBe(ExecutionMode.FullIsolation);

    const noWorkerGpu: Capabilities = { ...full, webgpuInWorker: false };
    expect(selectExecutionMode(noWorkerGpu)).toBe(ExecutionMode.PartialIsolation);

    const noSab: Capabilities = { ...full, sharedArrayBuffer: false };
    expect(selectExecutionMode(noSab)).toBe(ExecutionMode.SingleThread);

    const nothing: Capabilities = {
      crossOriginIsolated: false,
      sharedArrayBuffer: false,
      offscreenCanvas: false,
      webgpu: false,
      webgpuInWorker: false,
    };
    expect(selectExecutionMode(nothing)).toBe(ExecutionMode.SingleThread);
  });
});
```

**Step 2: Run all tests**

Run: `cd ts && npm test`
Expected: All tests pass (capabilities, ring-buffer, integration).

**Step 3: Run Rust tests too**

Run: `cargo test -p hyperion-core`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add ts/src/integration.test.ts
git commit -m "test: add end-to-end integration tests for ring buffer and mode selection"
```

---

## Summary

After completing all 12 tasks, the project will have:

**Rust (crates/hyperion-core):**
- `ring_buffer.rs` — Lock-free SPSC consumer with tests
- `components.rs` — Position, Rotation, Scale, Velocity, ModelMatrix, Active
- `systems.rs` — velocity_system, transform_system
- `command_processor.rs` — Translates ring buffer commands into ECS mutations
- `engine.rs` — Deterministic fixed-timestep tick loop
- `lib.rs` — WASM API exports

**TypeScript (ts/src):**
- `capabilities.ts` — Browser feature detection + mode selection
- `ring-buffer.ts` — Lock-free SPSC producer
- `worker-bridge.ts` — Adaptive Worker/direct bridge
- `engine-worker.ts` — Worker script loading WASM
- `main.ts` — Entry point wiring everything together

**Infrastructure:**
- Cargo workspace with release/dev profiles
- Vite dev server with COOP/COEP headers
- wasm-pack build pipeline
- vitest for TypeScript tests
- cargo test for Rust tests
