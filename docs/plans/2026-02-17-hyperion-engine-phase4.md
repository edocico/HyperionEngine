# Phase 4: Asset Pipeline & Textures — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the procedural Texture2DArray (8 solid-color layers) with a real asset loading pipeline that fetches images via `createImageBitmap`, packs them into per-tier Texture2DArrays, and assigns textures to entities via a new `SetTextureLayer` ring buffer command.

**Architecture:** The TypeScript `TextureManager` manages 4 size tiers of `Texture2DArray` (64/128/256/512px). Images are loaded via `fetch() → Blob → createImageBitmap(resizeWidth/Height) → copyExternalImageToTexture()` — pixels never traverse WASM memory. A new `TextureLayerIndex(u32)` ECS component stores packed `(tier << 16 | layer)` per entity, collected alongside the existing GPU data and uploaded in a separate storage buffer. The render shader decodes tier and layer to sample the correct Texture2DArray.

**Tech Stack:** Rust (hecs, glam, bytemuck, wasm-bindgen), WGSL (compute + render shaders), TypeScript (WebGPU API, createImageBitmap, Vite), vitest.

**Design Doc Reference:** `docs/plans/2026-02-17-hyperion-engine-design.md` — Section 7 (Asset Pipeline)

---

## Data Flow

```
TypeScript (TextureManager):
  fetch(url) → Blob → createImageBitmap(resize to tier) → copyExternalImageToTexture(tierArray, layer)
  Returns: packedIndex = (tier << 16) | layer
       ↓
  RingBufferProducer.setTextureLayer(entityId, packedIndex)
       ↓
  SharedArrayBuffer → Rust: process_commands() → entity.TextureLayerIndex = packedIndex
       ↓
  collect_gpu() → texLayerIndices: Vec<u32> (parallel to entityData)
       ↓
TypeScript (Renderer):
  writeBuffer(texIndexBuffer, texLayerIndices)
       ↓
GPU Render Pass (basic.wgsl):
  texIdx = texLayerIndices[entityIdx]
  tier = texIdx >> 16u
  layer = texIdx & 0xFFFFu
  switch(tier): textureSample(tierN_array, sampler, uv, layer)
```

## Texture2DArray Tier System

| Tier | Dimensions | Texture2DArray | Max Layers | Typical Use |
|------|------------|---------------|------------|-------------|
| 0 | 64×64 | `tierTextures[0]` | 256 | Icons, particles |
| 1 | 128×128 | `tierTextures[1]` | 256 | Standard sprites |
| 2 | 256×256 | `tierTextures[2]` | 256 | Large sprites |
| 3 | 512×512 | `tierTextures[3]` | 256 | Backgrounds |

Each tier starts with layer 0 = solid white (1×1 upscaled) as a default fallback. Entities with `TextureLayerIndex(0)` sample tier 0, layer 0 (white), which blends with the procedural color.

## Prerequisites

```bash
# Verify all existing tests pass before starting
cargo test -p hyperion-core && cargo clippy -p hyperion-core && cd ts && npm test && npx tsc --noEmit
```

---

## Task 1: Add TextureLayerIndex Component

**Files:**
- Modify: `crates/hyperion-core/src/components.rs`
- Modify: `crates/hyperion-core/src/command_processor.rs`

**Step 1: Write the failing tests**

Add to `crates/hyperion-core/src/components.rs`, inside the existing `#[cfg(test)] mod tests`:

```rust
#[test]
fn default_texture_layer_index_is_zero() {
    let t = TextureLayerIndex::default();
    assert_eq!(t.0, 0);
}

#[test]
fn texture_layer_index_is_pod() {
    let t = TextureLayerIndex(0x0002_0005); // tier 2, layer 5
    let bytes = bytemuck::bytes_of(&t);
    assert_eq!(bytes.len(), 4);
    let roundtrip = u32::from_le_bytes(bytes.try_into().unwrap());
    assert_eq!(roundtrip, 0x0002_0005);
}

#[test]
fn texture_layer_index_pack_unpack() {
    let tier: u32 = 3;
    let layer: u32 = 42;
    let packed = (tier << 16) | layer;
    let t = TextureLayerIndex(packed);
    assert_eq!(t.0 >> 16, 3);      // tier
    assert_eq!(t.0 & 0xFFFF, 42);  // layer
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core components`
Expected: FAIL — `TextureLayerIndex` not found.

**Step 3: Write the implementation**

Add to `crates/hyperion-core/src/components.rs`, after `BoundingRadius`:

```rust
/// Packed texture layer index for per-entity texture lookup.
/// Encoding: `(tier << 16) | layer` where tier selects which Texture2DArray
/// and layer selects which slice within it.
/// Default 0 = tier 0, layer 0 (white fallback).
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct TextureLayerIndex(pub u32);

impl Default for TextureLayerIndex {
    fn default() -> Self {
        Self(0) // tier 0, layer 0 = white fallback
    }
}
```

**Step 4: Update the spawn archetype**

In `crates/hyperion-core/src/command_processor.rs`, update the `SpawnEntity` match arm to include `TextureLayerIndex::default()`:

```rust
CommandType::SpawnEntity => {
    let entity = world.spawn((
        Position::default(),
        Rotation::default(),
        Scale::default(),
        Velocity::default(),
        ModelMatrix::default(),
        BoundingRadius::default(),
        TextureLayerIndex::default(),
        Active,
    ));
    entity_map.insert(cmd.entity_id, entity);
}
```

**Step 5: Run tests**

Run: `cargo test -p hyperion-core`
Expected: All existing tests + 3 new tests pass.

**Step 6: Commit**

```bash
git add crates/hyperion-core/src/components.rs crates/hyperion-core/src/command_processor.rs
git commit -m "feat: add TextureLayerIndex component for per-entity texture assignment"
```

---

## Task 2: Add SetTextureLayer Command (Rust)

**Files:**
- Modify: `crates/hyperion-core/src/ring_buffer.rs`
- Modify: `crates/hyperion-core/src/command_processor.rs`

**Step 1: Write the failing tests**

Add to `crates/hyperion-core/src/ring_buffer.rs`, inside `#[cfg(test)] mod tests`:

```rust
#[test]
fn parse_commands_reads_set_texture_layer() {
    let mut data = Vec::new();
    data.push(CommandType::SetTextureLayer as u8);
    data.extend_from_slice(&5u32.to_le_bytes());       // entity_id = 5
    data.extend_from_slice(&0x0002_000Au32.to_le_bytes()); // tier 2, layer 10
    let cmds = parse_commands(&data);
    assert_eq!(cmds.len(), 1);
    assert_eq!(cmds[0].cmd_type, CommandType::SetTextureLayer);
    assert_eq!(cmds[0].entity_id, 5);
    let packed = u32::from_le_bytes(cmds[0].payload[0..4].try_into().unwrap());
    assert_eq!(packed, 0x0002_000A);
}
```

Add to `crates/hyperion-core/src/command_processor.rs`, inside `#[cfg(test)] mod tests`:

```rust
#[test]
fn set_texture_layer_updates_component() {
    let mut world = World::new();
    let mut map = EntityMap::new();

    process_commands(&[make_spawn_cmd(0)], &mut world, &mut map);

    let packed: u32 = (2 << 16) | 10; // tier 2, layer 10
    let mut payload = [0u8; 16];
    payload[0..4].copy_from_slice(&packed.to_le_bytes());
    let cmd = Command {
        cmd_type: CommandType::SetTextureLayer,
        entity_id: 0,
        payload,
    };
    process_commands(&[cmd], &mut world, &mut map);

    let entity = map.get(0).unwrap();
    let tex = world.get::<&TextureLayerIndex>(entity).unwrap();
    assert_eq!(tex.0, packed);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p hyperion-core ring_buffer`
Run: `cargo test -p hyperion-core command_proc`
Expected: FAIL — `SetTextureLayer` not found.

**Step 3: Add SetTextureLayer to CommandType enum**

In `crates/hyperion-core/src/ring_buffer.rs`, update the `CommandType` enum:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CommandType {
    Noop = 0,
    SpawnEntity = 1,
    DespawnEntity = 2,
    SetPosition = 3,
    SetRotation = 4,
    SetScale = 5,
    SetVelocity = 6,
    SetTextureLayer = 7,
}
```

Update `from_u8`:

```rust
pub fn from_u8(v: u8) -> Option<Self> {
    match v {
        0 => Some(Self::Noop),
        1 => Some(Self::SpawnEntity),
        2 => Some(Self::DespawnEntity),
        3 => Some(Self::SetPosition),
        4 => Some(Self::SetRotation),
        5 => Some(Self::SetScale),
        6 => Some(Self::SetVelocity),
        7 => Some(Self::SetTextureLayer),
        _ => None,
    }
}
```

Update `payload_size`:

```rust
pub fn payload_size(self) -> usize {
    match self {
        Self::Noop | Self::SpawnEntity | Self::DespawnEntity => 0,
        Self::SetPosition | Self::SetScale | Self::SetVelocity => 12,
        Self::SetRotation => 16,
        Self::SetTextureLayer => 4, // 1 × u32
    }
}
```

**Step 4: Add SetTextureLayer handler in command_processor.rs**

In the `process_commands` match block, add before the `Noop` arm:

```rust
CommandType::SetTextureLayer => {
    if let Some(entity) = entity_map.get(cmd.entity_id) {
        let packed = u32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
        if let Ok(mut tex) = world.get::<&mut TextureLayerIndex>(entity) {
            tex.0 = packed;
        }
    }
}
```

Add `TextureLayerIndex` to the use imports if not already covered by `use crate::components::*;`.

**Step 5: Run tests**

Run: `cargo test -p hyperion-core`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add crates/hyperion-core/src/ring_buffer.rs crates/hyperion-core/src/command_processor.rs
git commit -m "feat: add SetTextureLayer command (type=7, payload=u32)"
```

---

## Task 3: Add SetTextureLayer Command (TypeScript)

**Files:**
- Modify: `ts/src/ring-buffer.ts`
- Modify: `ts/src/ring-buffer.test.ts`
- Modify: `ts/src/integration.test.ts`

**Step 1: Write the failing tests**

Add to `ts/src/ring-buffer.test.ts`:

```typescript
it("writes SetTextureLayer command with u32 payload", () => {
  const sab = new SharedArrayBuffer(16 + 128);
  const rb = new RingBufferProducer(sab);

  const packed = (2 << 16) | 10; // tier 2, layer 10
  const ok = rb.setTextureLayer(5, packed);
  expect(ok).toBe(true);

  // Message: 1 (cmd) + 4 (entity_id) + 4 (u32 payload) = 9 bytes
  const header = new Int32Array(sab, 0, 4);
  const writeHead = Atomics.load(header, 0);
  expect(writeHead).toBe(9);

  // Verify command type
  const data = new Uint8Array(sab, 16, 128);
  expect(data[0]).toBe(7); // CommandType.SetTextureLayer

  // Verify entity ID = 5
  const entityId = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
  expect(entityId).toBe(5);

  // Verify packed payload
  const payload = data[5] | (data[6] << 8) | (data[7] << 16) | (data[8] << 24);
  expect(payload).toBe(packed);
});
```

Add to `ts/src/integration.test.ts` (existing cross-boundary protocol test):

```typescript
it("SetTextureLayer command has correct binary format", () => {
  const sab = new SharedArrayBuffer(16 + 128);
  const rb = new RingBufferProducer(sab);

  rb.spawnEntity(0);           // 5 bytes (offset 0)
  rb.setTextureLayer(0, 42);   // 9 bytes (offset 5)

  const data = new Uint8Array(sab, 16, 128);
  expect(data[5]).toBe(7); // CommandType.SetTextureLayer at offset 5
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/ring-buffer.test.ts`
Expected: FAIL — `setTextureLayer` not found on RingBufferProducer.

**Step 3: Update ring-buffer.ts**

In `ts/src/ring-buffer.ts`, add the new command type and payload:

Update the `CommandType` const enum:

```typescript
export const enum CommandType {
  Noop = 0,
  SpawnEntity = 1,
  DespawnEntity = 2,
  SetPosition = 3,
  SetRotation = 4,
  SetScale = 5,
  SetVelocity = 6,
  SetTextureLayer = 7,
}
```

Update `PAYLOAD_SIZES`:

```typescript
const PAYLOAD_SIZES: Record<CommandType, number> = {
  [CommandType.Noop]: 0,
  [CommandType.SpawnEntity]: 0,
  [CommandType.DespawnEntity]: 0,
  [CommandType.SetPosition]: 12,
  [CommandType.SetRotation]: 16,
  [CommandType.SetScale]: 12,
  [CommandType.SetVelocity]: 12,
  [CommandType.SetTextureLayer]: 4,
};
```

Add the convenience method on `RingBufferProducer`:

```typescript
setTextureLayer(entityId: number, packedIndex: number): boolean {
  const payload = new Float32Array(1);
  // Write the u32 as raw bytes into a Float32Array (reinterpret, not convert)
  new Uint32Array(payload.buffer)[0] = packedIndex;
  return this.writeCommand(CommandType.SetTextureLayer, entityId, payload);
}
```

**Step 4: Run tests**

Run: `cd ts && npm test`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add ts/src/ring-buffer.ts ts/src/ring-buffer.test.ts ts/src/integration.test.ts
git commit -m "feat: add SetTextureLayer command to TypeScript ring buffer"
```

---

## Task 4: Collect Texture Layer Indices in RenderState

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs`

**Step 1: Write the failing tests**

Add to `crates/hyperion-core/src/render_state.rs`, inside `#[cfg(test)] mod tests`:

```rust
#[test]
fn collect_gpu_gathers_texture_layer_indices() {
    let mut world = World::new();
    world.spawn((
        Position(Vec3::new(1.0, 0.0, 0.0)),
        Rotation(Quat::IDENTITY),
        Scale(Vec3::ONE),
        Velocity::default(),
        ModelMatrix::default(),
        BoundingRadius(0.5),
        TextureLayerIndex((2 << 16) | 10), // tier 2, layer 10
        Active,
    ));
    world.spawn((
        Position(Vec3::new(2.0, 0.0, 0.0)),
        Rotation(Quat::IDENTITY),
        Scale(Vec3::ONE),
        Velocity::default(),
        ModelMatrix::default(),
        BoundingRadius(0.5),
        TextureLayerIndex(0), // default
        Active,
    ));
    crate::systems::transform_system(&mut world);

    let mut state = RenderState::new();
    state.collect_gpu(&world);

    assert_eq!(state.gpu_entity_count(), 2);
    let indices = state.gpu_tex_indices();
    assert_eq!(indices.len(), 2);
    // Order depends on hecs archetype iteration, but both values should be present
    assert!(indices.contains(&((2 << 16) | 10)));
    assert!(indices.contains(&0));
}

#[test]
fn gpu_tex_indices_empty_when_no_entities() {
    let world = World::new();
    let mut state = RenderState::new();
    state.collect_gpu(&world);
    assert!(state.gpu_tex_indices().is_empty());
    assert!(state.gpu_tex_indices_ptr().is_null());
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p hyperion-core render_state`
Expected: FAIL — `gpu_tex_indices`, `gpu_tex_indices_ptr` not found.

**Step 3: Update RenderState**

In `crates/hyperion-core/src/render_state.rs`, add `TextureLayerIndex` to the use import:

```rust
use crate::components::{Active, BoundingRadius, ModelMatrix, Position, TextureLayerIndex};
```

Add the new field to `RenderState`:

```rust
pub struct RenderState {
    pub matrices: Vec<[f32; 16]>,
    gpu_data: Vec<f32>,
    gpu_count: u32,
    gpu_tex_indices: Vec<u32>,
}
```

Update `RenderState::new()`:

```rust
pub fn new() -> Self {
    Self {
        matrices: Vec::new(),
        gpu_data: Vec::new(),
        gpu_count: 0,
        gpu_tex_indices: Vec::new(),
    }
}
```

Update `collect_gpu()` to also collect texture indices — change the query to include `TextureLayerIndex`:

```rust
pub fn collect_gpu(&mut self, world: &World) {
    self.gpu_data.clear();
    self.gpu_tex_indices.clear();
    self.gpu_data.reserve(self.gpu_count as usize * FLOATS_PER_GPU_ENTITY);
    self.gpu_tex_indices.reserve(self.gpu_count as usize);
    self.gpu_count = 0;

    for (pos, matrix, radius, tex_layer, _active) in
        world.query::<(&Position, &ModelMatrix, &BoundingRadius, &TextureLayerIndex, &Active)>().iter()
    {
        self.gpu_data.extend_from_slice(&matrix.0);
        self.gpu_data.push(pos.0.x);
        self.gpu_data.push(pos.0.y);
        self.gpu_data.push(pos.0.z);
        self.gpu_data.push(radius.0);

        self.gpu_tex_indices.push(tex_layer.0);

        self.gpu_count += 1;
    }

    debug_assert_eq!(self.gpu_count as usize * FLOATS_PER_GPU_ENTITY, self.gpu_data.len());
    debug_assert_eq!(self.gpu_count as usize, self.gpu_tex_indices.len());
}
```

Add accessor methods:

```rust
/// Texture layer indices buffer (one u32 per entity, parallel to gpu_data).
pub fn gpu_tex_indices(&self) -> &[u32] {
    &self.gpu_tex_indices
}

/// Pointer to the texture layer indices buffer for WASM export.
pub fn gpu_tex_indices_ptr(&self) -> *const u32 {
    if self.gpu_tex_indices.is_empty() {
        std::ptr::null()
    } else {
        self.gpu_tex_indices.as_ptr()
    }
}

/// Number of u32 values in the texture indices buffer.
pub fn gpu_tex_indices_len(&self) -> u32 {
    self.gpu_tex_indices.len() as u32
}
```

**Step 4: Run tests**

Run: `cargo test -p hyperion-core render_state`
Expected: All tests pass.

Note: The test `collect_gpu_skips_entities_without_bounding_radius` will also skip entities without `TextureLayerIndex` since the query now requires it. This is correct — entities spawned via the command processor always have `TextureLayerIndex`.

**Step 5: Run all tests**

Run: `cargo test -p hyperion-core`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add crates/hyperion-core/src/render_state.rs
git commit -m "feat: collect texture layer indices in RenderState alongside GPU entity data"
```

---

## Task 5: Add WASM Exports for Texture Indices

**Files:**
- Modify: `crates/hyperion-core/src/lib.rs`

**Step 1: Add WASM exports**

Add to `crates/hyperion-core/src/lib.rs`, after the existing `engine_gpu_entity_count` export:

```rust
/// Pointer to the texture layer indices buffer (one u32 per entity).
/// Indices are parallel to the GPU entity data buffer — index i here
/// corresponds to entity i in engine_gpu_data_ptr().
#[wasm_bindgen]
pub fn engine_gpu_tex_indices_ptr() -> *const u32 {
    // SAFETY: wasm32 is single-threaded; only one caller at a time.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(std::ptr::null(), |e| e.render_state.gpu_tex_indices_ptr())
    }
}

/// Number of u32 values in the texture indices buffer.
#[wasm_bindgen]
pub fn engine_gpu_tex_indices_len() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.gpu_tex_indices_len())
    }
}
```

**Step 2: Build to verify**

Run: `cargo test -p hyperion-core && cargo clippy -p hyperion-core`
Expected: All tests pass, no clippy warnings.

**Step 3: Build WASM**

Run: `cd ts && npm run build:wasm`
Expected: Build succeeds. Check the generated types:

Run: `grep "tex_indices" ts/wasm/hyperion_core.d.ts`
Expected: Both `engine_gpu_tex_indices_ptr` and `engine_gpu_tex_indices_len` appear.

**Step 4: Commit**

```bash
git add crates/hyperion-core/src/lib.rs
git commit -m "feat: add WASM exports for texture layer indices"
```

---

## Task 6: TextureManager Core (TypeScript)

**Files:**
- Create: `ts/src/texture-manager.ts`
- Create: `ts/src/texture-manager.test.ts`

This task builds the `TextureManager` class with tier allocation logic and the concurrency-limited image loading pipeline. Tests cover allocation logic (no GPU needed).

**Step 1: Write the failing tests**

Create `ts/src/texture-manager.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { selectTier, TIER_SIZES, packTextureIndex, unpackTextureIndex } from "./texture-manager";

describe("Texture tier selection", () => {
  it("selects tier 0 for images <= 64px", () => {
    expect(selectTier(32, 32)).toBe(0);
    expect(selectTier(64, 64)).toBe(0);
    expect(selectTier(48, 60)).toBe(0);
  });

  it("selects tier 1 for images 65-128px", () => {
    expect(selectTier(65, 65)).toBe(1);
    expect(selectTier(128, 128)).toBe(1);
    expect(selectTier(100, 80)).toBe(1);
  });

  it("selects tier 2 for images 129-256px", () => {
    expect(selectTier(200, 200)).toBe(2);
    expect(selectTier(256, 256)).toBe(2);
  });

  it("selects tier 3 for images 257-512px", () => {
    expect(selectTier(300, 300)).toBe(3);
    expect(selectTier(512, 512)).toBe(3);
  });

  it("clamps oversized images to tier 3", () => {
    expect(selectTier(1024, 1024)).toBe(3);
  });

  it("uses max dimension for non-square images", () => {
    expect(selectTier(200, 64)).toBe(2); // max(200, 64) = 200 → tier 2
  });
});

describe("Texture index packing", () => {
  it("packs tier and layer into u32", () => {
    const packed = packTextureIndex(2, 10);
    expect(packed).toBe((2 << 16) | 10);
  });

  it("unpacks tier and layer from u32", () => {
    const packed = (3 << 16) | 42;
    const { tier, layer } = unpackTextureIndex(packed);
    expect(tier).toBe(3);
    expect(layer).toBe(42);
  });

  it("round-trips correctly", () => {
    for (let tier = 0; tier < 4; tier++) {
      for (const layer of [0, 1, 100, 255]) {
        const packed = packTextureIndex(tier, layer);
        const unpacked = unpackTextureIndex(packed);
        expect(unpacked.tier).toBe(tier);
        expect(unpacked.layer).toBe(layer);
      }
    }
  });
});

describe("TIER_SIZES", () => {
  it("has 4 tiers with correct dimensions", () => {
    expect(TIER_SIZES).toEqual([64, 128, 256, 512]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/texture-manager.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement the core module**

Create `ts/src/texture-manager.ts`:

```typescript
/** Texture2DArray size tiers (pixels). */
export const TIER_SIZES = [64, 128, 256, 512] as const;
export const NUM_TIERS = TIER_SIZES.length;
export const MAX_LAYERS_PER_TIER = 256; // WebGPU minimum guarantee for maxTextureArrayLayers

/**
 * Select the appropriate size tier for an image based on its max dimension.
 * Images are resized to the tier's dimensions at load time.
 */
export function selectTier(width: number, height: number): number {
  const maxDim = Math.max(width, height);
  for (let i = 0; i < TIER_SIZES.length; i++) {
    if (maxDim <= TIER_SIZES[i]) return i;
  }
  return TIER_SIZES.length - 1; // clamp to largest tier
}

/** Pack tier and layer into a u32: (tier << 16) | layer. */
export function packTextureIndex(tier: number, layer: number): number {
  return ((tier & 0xFFFF) << 16) | (layer & 0xFFFF);
}

/** Unpack tier and layer from a packed u32. */
export function unpackTextureIndex(packed: number): { tier: number; layer: number } {
  return {
    tier: (packed >>> 16) & 0xFFFF,
    layer: packed & 0xFFFF,
  };
}

/** Maximum concurrent fetch() calls to avoid network saturation. */
const MAX_CONCURRENT_FETCHES = 6;

/**
 * Manages Texture2DArrays across size tiers.
 *
 * Usage:
 *   const mgr = new TextureManager(device);
 *   const packed = await mgr.loadTexture("sprites/player.png");
 *   bridge.commandBuffer.setTextureLayer(entityId, packed);
 */
export class TextureManager {
  private readonly device: GPUDevice;
  private readonly tierTextures: GPUTexture[];
  private readonly tierViews: GPUTextureView[];
  private readonly tierNextLayer: number[]; // next free layer per tier
  private readonly sampler: GPUSampler;

  /** Tracks in-flight fetches for concurrency limiting. */
  private activeFetches = 0;
  private readonly fetchQueue: Array<{
    url: string;
    tier: number;
    resolve: (packed: number) => void;
    reject: (err: Error) => void;
  }> = [];

  /** Cache: url → packed index (avoid re-loading). */
  private readonly cache = new Map<string, number>();

  /** Progress tracking. */
  private loaded = 0;
  private total = 0;
  onProgress: ((loaded: number, total: number) => void) | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
    this.tierTextures = [];
    this.tierViews = [];
    this.tierNextLayer = [];
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    });

    // Create a Texture2DArray per tier, each starting with 1 default white layer.
    for (let tier = 0; tier < NUM_TIERS; tier++) {
      const size = TIER_SIZES[tier];
      const texture = device.createTexture({
        size: { width: size, height: size, depthOrArrayLayers: MAX_LAYERS_PER_TIER },
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });

      // Fill layer 0 with solid white (default fallback).
      const white = new Uint8Array(size * size * 4);
      white.fill(255);
      device.queue.writeTexture(
        { texture, origin: { x: 0, y: 0, z: 0 } },
        white,
        { bytesPerRow: size * 4, rowsPerImage: size },
        { width: size, height: size, depthOrArrayLayers: 1 },
      );

      this.tierTextures.push(texture);
      this.tierViews.push(texture.createView({ dimension: "2d-array" }));
      this.tierNextLayer.push(1); // layer 0 is the default
    }
  }

  /** Get the GPUTextureView for a tier (for bind group creation). */
  getTierView(tier: number): GPUTextureView {
    return this.tierViews[tier];
  }

  /** Get the sampler (shared across all tiers). */
  getSampler(): GPUSampler {
    return this.sampler;
  }

  /**
   * Load a texture from a URL. Returns a packed texture index (tier << 16 | layer).
   *
   * The image is:
   * 1. Fetched with concurrency limiting (max 6 parallel fetches)
   * 2. Decoded via createImageBitmap (browser's async decoder)
   * 3. Resized to the nearest tier dimensions
   * 4. Uploaded directly to VRAM via copyExternalImageToTexture
   *
   * @param url - Image URL to load
   * @param tierOverride - Force a specific tier (0-3). If omitted, auto-detected from image dimensions.
   * @returns Packed texture index for use with SetTextureLayer command
   */
  async loadTexture(url: string, tierOverride?: number): Promise<number> {
    // Check cache first.
    const cached = this.cache.get(url);
    if (cached !== undefined) return cached;

    this.total++;

    return new Promise<number>((resolve, reject) => {
      // If we know the tier, queue directly. Otherwise, we need to fetch first
      // to get dimensions, then decide tier.
      if (tierOverride !== undefined) {
        this.enqueueFetch(url, tierOverride, resolve, reject);
      } else {
        // Fetch, get dimensions, select tier, then upload.
        this.enqueueAutoFetch(url, resolve, reject);
      }
    });
  }

  private enqueueAutoFetch(
    url: string,
    resolve: (packed: number) => void,
    reject: (err: Error) => void,
  ): void {
    // For auto-tier, we use tier -1 as a sentinel — the actual fetch handler
    // will determine the tier from the image dimensions.
    this.fetchQueue.push({ url, tier: -1, resolve, reject });
    this.drainFetchQueue();
  }

  private enqueueFetch(
    url: string,
    tier: number,
    resolve: (packed: number) => void,
    reject: (err: Error) => void,
  ): void {
    this.fetchQueue.push({ url, tier, resolve, reject });
    this.drainFetchQueue();
  }

  private drainFetchQueue(): void {
    while (this.activeFetches < MAX_CONCURRENT_FETCHES && this.fetchQueue.length > 0) {
      const job = this.fetchQueue.shift()!;
      this.activeFetches++;
      this.executeFetch(job.url, job.tier, job.resolve, job.reject);
    }
  }

  private async executeFetch(
    url: string,
    tier: number,
    resolve: (packed: number) => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);

      const blob = await response.blob();

      // If tier is -1 (auto), decode at original size first to get dimensions.
      let actualTier: number;
      let bitmap: ImageBitmap;

      if (tier === -1) {
        // Decode at original size to measure dimensions.
        const origBitmap = await createImageBitmap(blob);
        actualTier = selectTier(origBitmap.width, origBitmap.height);
        origBitmap.close();

        // Re-decode at target tier size.
        const targetSize = TIER_SIZES[actualTier];
        bitmap = await createImageBitmap(blob, {
          resizeWidth: targetSize,
          resizeHeight: targetSize,
          resizeQuality: "high",
        });
      } else {
        actualTier = tier;
        const targetSize = TIER_SIZES[actualTier];
        bitmap = await createImageBitmap(blob, {
          resizeWidth: targetSize,
          resizeHeight: targetSize,
          resizeQuality: "high",
        });
      }

      // Allocate a layer in the tier.
      const layer = this.tierNextLayer[actualTier];
      if (layer >= MAX_LAYERS_PER_TIER) {
        bitmap.close();
        throw new Error(`Tier ${actualTier} (${TIER_SIZES[actualTier]}px) is full — max ${MAX_LAYERS_PER_TIER} layers`);
      }
      this.tierNextLayer[actualTier]++;

      // Upload directly to VRAM.
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: this.tierTextures[actualTier], origin: { x: 0, y: 0, z: layer } },
        { width: bitmap.width, height: bitmap.height },
      );

      bitmap.close();

      const packed = packTextureIndex(actualTier, layer);
      this.cache.set(url, packed);
      this.loaded++;
      this.onProgress?.(this.loaded, this.total);

      resolve(packed);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.activeFetches--;
      this.drainFetchQueue();
    }
  }

  /** Number of layers used in a tier (including the default layer 0). */
  getLayerCount(tier: number): number {
    return this.tierNextLayer[tier];
  }

  destroy(): void {
    for (const tex of this.tierTextures) {
      tex.destroy();
    }
  }
}
```

**Step 4: Run tests**

Run: `cd ts && npx vitest run src/texture-manager.test.ts`
Expected: All tests pass (these tests don't require GPU — they only test pure functions).

**Step 5: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No type errors.

**Step 6: Commit**

```bash
git add ts/src/texture-manager.ts ts/src/texture-manager.test.ts
git commit -m "feat: add TextureManager with tier system, concurrency limiter, and createImageBitmap loading"
```

---

## Task 7: Update Render Shader for Multi-Tier Textures

**Files:**
- Modify: `ts/src/shaders/basic.wgsl`

The shader needs to:
1. Read per-entity texture layer index from a new storage buffer
2. Decode tier (bits 16-31) and layer (bits 0-15)
3. Sample the correct Texture2DArray based on tier

**Step 1: Read the current shader**

Read: `ts/src/shaders/basic.wgsl`

**Step 2: Rewrite the shader**

Replace `ts/src/shaders/basic.wgsl` with:

```wgsl
// Instanced quad shader with GPU-driven visibility indirection
// and multi-tier Texture2DArray sampling.

struct CameraUniform {
    viewProjection: mat4x4f,
};

struct EntityData {
    model: mat4x4f,
    boundingSphere: vec4f,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> entities: array<EntityData>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> texLayerIndices: array<u32>;

// Tier 0-3 texture arrays (64, 128, 256, 512 px)
@group(1) @binding(0) var tier0Tex: texture_2d_array<f32>;
@group(1) @binding(1) var tier1Tex: texture_2d_array<f32>;
@group(1) @binding(2) var tier2Tex: texture_2d_array<f32>;
@group(1) @binding(3) var tier3Tex: texture_2d_array<f32>;
@group(1) @binding(4) var texSampler: sampler;

struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) entityIdx: u32,
    @location(2) @interpolate(flat) texTier: u32,
    @location(3) @interpolate(flat) texLayer: u32,
};

@vertex
fn vs_main(
    @location(0) position: vec3f,
    @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
    let entityIdx = visibleIndices[instanceIdx];
    let model = entities[entityIdx].model;

    // Decode texture tier and layer from packed u32
    let packed = texLayerIndices[entityIdx];
    let tier = packed >> 16u;
    let layer = packed & 0xFFFFu;

    var out: VertexOutput;
    out.clipPosition = camera.viewProjection * model * vec4f(position, 1.0);
    out.uv = position.xy + 0.5;
    out.entityIdx = entityIdx;
    out.texTier = tier;
    out.texLayer = layer;

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    var texColor: vec4f;

    // Sample from the correct tier's Texture2DArray
    switch in.texTier {
        case 1u: {
            texColor = textureSample(tier1Tex, texSampler, in.uv, in.texLayer);
        }
        case 2u: {
            texColor = textureSample(tier2Tex, texSampler, in.uv, in.texLayer);
        }
        case 3u: {
            texColor = textureSample(tier3Tex, texSampler, in.uv, in.texLayer);
        }
        default: {
            texColor = textureSample(tier0Tex, texSampler, in.uv, in.texLayer);
        }
    }

    return texColor;
}
```

**Step 3: Commit**

```bash
git add ts/src/shaders/basic.wgsl
git commit -m "feat: update render shader for multi-tier Texture2DArray with per-entity texture lookup"
```

---

## Task 8: Update Renderer for TextureManager Integration

**Files:**
- Modify: `ts/src/renderer.ts`

This is the largest task. The renderer must:
1. Accept a `TextureManager` (or create one internally)
2. Create a texture layer index storage buffer
3. Use two bind groups: group 0 (vertex data) + group 1 (textures)
4. Upload texture indices per frame

**Step 1: Read the current renderer**

Read: `ts/src/renderer.ts`

**Step 2: Rewrite the renderer**

Replace `ts/src/renderer.ts` with:

```typescript
import shaderCode from './shaders/basic.wgsl?raw';
import cullShaderCode from './shaders/cull.wgsl?raw';
import { TextureManager } from './texture-manager';

const MAX_ENTITIES = 100_000;
const FLOATS_PER_GPU_ENTITY = 20;
const BYTES_PER_GPU_ENTITY = FLOATS_PER_GPU_ENTITY * 4;
const INDIRECT_BUFFER_SIZE = 20;

export interface Renderer {
  render(
    entityData: Float32Array,
    entityCount: number,
    camera: { viewProjection: Float32Array },
    texIndices?: Uint32Array,
  ): void;
  readonly textureManager: TextureManager;
  destroy(): void;
}

export async function createRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): Promise<Renderer> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();

  const context = canvas instanceof HTMLCanvasElement
    ? canvas.getContext("webgpu")!
    : (canvas as OffscreenCanvas).getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  // --- TextureManager ---
  const textureManager = new TextureManager(device);

  // --- Vertex + Index Buffers ---
  const vertices = new Float32Array([
    -0.5, -0.5, 0.0,
     0.5, -0.5, 0.0,
     0.5,  0.5, 0.0,
    -0.5,  0.5, 0.0,
  ]);
  const vertexBuffer = device.createBuffer({
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertices);

  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const indexBuffer = device.createBuffer({
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, indices);

  // --- Camera Uniform ---
  const cameraBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // --- Entity Data Storage Buffer ---
  const entityBuffer = device.createBuffer({
    size: MAX_ENTITIES * BYTES_PER_GPU_ENTITY,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // --- Visible Indices Storage Buffer ---
  const visibleIndicesBuffer = device.createBuffer({
    size: MAX_ENTITIES * 4,
    usage: GPUBufferUsage.STORAGE,
  });

  // --- Indirect Draw Args Buffer ---
  const indirectBuffer = device.createBuffer({
    size: INDIRECT_BUFFER_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  });

  // --- Cull Uniforms ---
  const CULL_UNIFORM_SIZE = 6 * 16 + 16;
  const cullUniformBuffer = device.createBuffer({
    size: CULL_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // --- Texture Layer Indices Storage Buffer ---
  const texIndexBuffer = device.createBuffer({
    size: MAX_ENTITIES * 4, // u32 per entity
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // --- Depth Texture ---
  let depthTexture = createDepthTexture(device, canvas.width, canvas.height);

  // --- Compute Pipeline (Culling, unchanged) ---
  const cullModule = device.createShaderModule({ code: cullShaderCode });
  const cullBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ],
  });
  const cullPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [cullBindGroupLayout] }),
    compute: { module: cullModule, entryPoint: "cull_main" },
  });
  const cullBindGroup = device.createBindGroup({
    layout: cullBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cullUniformBuffer } },
      { binding: 1, resource: { buffer: entityBuffer } },
      { binding: 2, resource: { buffer: visibleIndicesBuffer } },
      { binding: 3, resource: { buffer: indirectBuffer } },
    ],
  });

  // --- Render Pipeline (two bind groups) ---
  const renderModule = device.createShaderModule({ code: shaderCode });

  // Group 0: vertex-stage data
  const renderBindGroupLayout0 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });

  // Group 1: fragment-stage textures
  const renderBindGroupLayout1 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });

  const renderPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [renderBindGroupLayout0, renderBindGroupLayout1],
    }),
    vertex: {
      module: renderModule,
      entryPoint: "vs_main",
      buffers: [{
        arrayStride: 12,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }],
      }],
    },
    fragment: {
      module: renderModule,
      entryPoint: "fs_main",
      targets: [{ format }],
    },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
    primitive: { topology: "triangle-list", cullMode: "back" },
  });

  const renderBindGroup0 = device.createBindGroup({
    layout: renderBindGroupLayout0,
    entries: [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 1, resource: { buffer: entityBuffer } },
      { binding: 2, resource: { buffer: visibleIndicesBuffer } },
      { binding: 3, resource: { buffer: texIndexBuffer } },
    ],
  });

  const renderBindGroup1 = device.createBindGroup({
    layout: renderBindGroupLayout1,
    entries: [
      { binding: 0, resource: textureManager.getTierView(0) },
      { binding: 1, resource: textureManager.getTierView(1) },
      { binding: 2, resource: textureManager.getTierView(2) },
      { binding: 3, resource: textureManager.getTierView(3) },
      { binding: 4, resource: textureManager.getSampler() },
    ],
  });

  // Reusable zero-filled fallback for texture indices when none are provided
  const defaultTexIndices = new Uint32Array(MAX_ENTITIES);

  return {
    textureManager,

    render(entityData, entityCount, camera, texIndices) {
      if (entityCount === 0) return;

      // 1. Upload entity data
      device.queue.writeBuffer(
        entityBuffer, 0,
        entityData as Float32Array<ArrayBuffer>, 0,
        entityCount * FLOATS_PER_GPU_ENTITY,
      );

      // 2. Upload texture layer indices
      const indices = texIndices ?? defaultTexIndices;
      device.queue.writeBuffer(
        texIndexBuffer, 0,
        indices as Uint32Array<ArrayBuffer>, 0,
        entityCount,
      );

      // 3. Upload camera uniform
      device.queue.writeBuffer(cameraBuffer, 0, camera.viewProjection as Float32Array<ArrayBuffer>);

      // 4. Upload cull uniforms
      const cullData = new ArrayBuffer(CULL_UNIFORM_SIZE);
      const cullFloats = new Float32Array(cullData, 0, 24);
      const frustumPlanes = extractFrustumPlanesInternal(camera.viewProjection);
      cullFloats.set(frustumPlanes);
      const cullUints = new Uint32Array(cullData, 96, 4);
      cullUints[0] = entityCount;
      device.queue.writeBuffer(cullUniformBuffer, 0, cullData);

      // 5. Reset indirect draw args
      const resetArgs = new Uint32Array([6, 0, 0, 0, 0]);
      device.queue.writeBuffer(indirectBuffer, 0, resetArgs);

      // 6. Encode command buffer
      const encoder = device.createCommandEncoder();

      // 6a. Compute pass: frustum culling
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(cullPipeline);
      computePass.setBindGroup(0, cullBindGroup);
      computePass.dispatchWorkgroups(Math.ceil(entityCount / 256));
      computePass.end();

      // 6b. Render pass: indirect draw
      const textureView = context.getCurrentTexture().createView();
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: textureView,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
          clearValue: { r: 0.067, g: 0.067, b: 0.067, a: 1 },
        }],
        depthStencilAttachment: {
          view: depthTexture.createView(),
          depthLoadOp: "clear" as GPULoadOp,
          depthStoreOp: "store" as GPUStoreOp,
          depthClearValue: 1.0,
        },
      });
      renderPass.setPipeline(renderPipeline);
      renderPass.setVertexBuffer(0, vertexBuffer);
      renderPass.setIndexBuffer(indexBuffer, "uint16");
      renderPass.setBindGroup(0, renderBindGroup0);
      renderPass.setBindGroup(1, renderBindGroup1);
      renderPass.drawIndexedIndirect(indirectBuffer, 0);
      renderPass.end();

      device.queue.submit([encoder.finish()]);
    },

    destroy() {
      vertexBuffer.destroy();
      indexBuffer.destroy();
      cameraBuffer.destroy();
      entityBuffer.destroy();
      visibleIndicesBuffer.destroy();
      indirectBuffer.destroy();
      cullUniformBuffer.destroy();
      texIndexBuffer.destroy();
      textureManager.destroy();
      depthTexture.destroy();
      device.destroy();
    },
  };
}

function createDepthTexture(device: GPUDevice, width: number, height: number): GPUTexture {
  return device.createTexture({
    size: { width, height },
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
}

function extractFrustumPlanesInternal(vp: Float32Array): Float32Array {
  const planes = new Float32Array(24);
  const m = vp;

  planes[0]  = m[3]  + m[0];  planes[1]  = m[7]  + m[4];
  planes[2]  = m[11] + m[8];  planes[3]  = m[15] + m[12];
  planes[4]  = m[3]  - m[0];  planes[5]  = m[7]  - m[4];
  planes[6]  = m[11] - m[8];  planes[7]  = m[15] - m[12];
  planes[8]  = m[3]  + m[1];  planes[9]  = m[7]  + m[5];
  planes[10] = m[11] + m[9];  planes[11] = m[15] + m[13];
  planes[12] = m[3]  - m[1];  planes[13] = m[7]  - m[5];
  planes[14] = m[11] - m[9];  planes[15] = m[15] - m[13];
  planes[16] = m[2];  planes[17] = m[6];
  planes[18] = m[10]; planes[19] = m[14];
  planes[20] = m[3]  - m[2];  planes[21] = m[7]  - m[6];
  planes[22] = m[11] - m[10]; planes[23] = m[15] - m[14];

  for (let i = 0; i < 6; i++) {
    const o = i * 4;
    const len = Math.sqrt(planes[o] ** 2 + planes[o + 1] ** 2 + planes[o + 2] ** 2);
    if (len > 0) {
      planes[o] /= len; planes[o + 1] /= len;
      planes[o + 2] /= len; planes[o + 3] /= len;
    }
  }

  return planes;
}
```

**Step 3: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No type errors.

**Step 4: Commit**

```bash
git add ts/src/renderer.ts
git commit -m "feat: integrate TextureManager into renderer with multi-tier bind groups and tex index buffer"
```

---

## Task 9: Update Worker Bridge and Engine Worker

**Files:**
- Modify: `ts/src/worker-bridge.ts`
- Modify: `ts/src/engine-worker.ts`

The GPU render state must now include texture layer indices alongside entity data.

**Step 1: Update GPURenderState interface**

In `ts/src/worker-bridge.ts`, update `GPURenderState`:

```typescript
export interface GPURenderState {
  entityCount: number;
  entityData: Float32Array;     // 20 floats per entity (mat4x4 + vec4 boundingSphere)
  texIndices: Uint32Array;      // 1 u32 per entity (packed tier|layer)
}
```

**Step 2: Update Mode C direct bridge**

In `createDirectBridge()`, update the tick method to also read texture indices:

```typescript
tick(dt: number) {
  const { bytes } = extractUnread(buffer as SharedArrayBuffer);
  if (bytes.length > 0) {
    engine.engine_push_commands(bytes);
  }

  engine.engine_update(dt);

  const count = engine.engine_gpu_entity_count();
  const ptr = engine.engine_gpu_data_ptr();
  const f32Len = engine.engine_gpu_data_f32_len();
  const texPtr = engine.engine_gpu_tex_indices_ptr();
  const texLen = engine.engine_gpu_tex_indices_len();

  if (count > 0 && ptr !== 0) {
    const wasmView = new Float32Array(engine.memory.buffer, ptr, f32Len);
    const texView = texPtr !== 0
      ? new Uint32Array(engine.memory.buffer, texPtr, texLen)
      : new Uint32Array(count);
    latestRenderState = {
      entityCount: count,
      entityData: new Float32Array(wasmView),
      texIndices: new Uint32Array(texView),
    };
  } else {
    latestRenderState = { entityCount: 0, entityData: new Float32Array(0), texIndices: new Uint32Array(0) };
  }
},
```

Also update the WASM engine interface to include the new exports:

```typescript
const engine = wasm as unknown as {
  engine_init(): void;
  engine_push_commands(data: Uint8Array): void;
  engine_update(dt: number): void;
  engine_render_state_count(): number;
  engine_render_state_ptr(): number;
  engine_render_state_f32_len(): number;
  engine_gpu_entity_count(): number;
  engine_gpu_data_ptr(): number;
  engine_gpu_data_f32_len(): number;
  engine_gpu_tex_indices_ptr(): number;
  engine_gpu_tex_indices_len(): number;
  memory: WebAssembly.Memory;
};
```

**Step 3: Update Mode B worker bridge**

In `createWorkerBridge()`, update the `tick-done` message handler:

```typescript
} else if (msg.type === "tick-done" && msg.renderState) {
  latestRenderState = {
    entityCount: msg.renderState.entityCount,
    entityData: new Float32Array(msg.renderState.entityData),
    texIndices: new Uint32Array(msg.renderState.texIndices),
  };
}
```

**Step 4: Update Mode A full isolation bridge**

In `createFullIsolationBridge()`, update the `tick-done` forwarding to include texIndices:

```typescript
} else if (msg.type === "tick-done" && msg.renderState) {
  channel.port1.postMessage(
    { renderState: msg.renderState },
    [msg.renderState.entityData, msg.renderState.texIndices]
  );
}
```

**Step 5: Update engine-worker.ts**

In `ts/src/engine-worker.ts`, update the `tick` message handler to also read texture indices from WASM:

After `engine_update`, the worker should read both buffers:

```typescript
case "tick": {
    if (!wasm) return;

    // ... existing command extraction ...

    wasm.engine_update(msg.dt);

    const count = wasm.engine_gpu_entity_count();
    const ptr = wasm.engine_gpu_data_ptr();
    const f32Len = wasm.engine_gpu_data_f32_len();
    const texPtr = wasm.engine_gpu_tex_indices_ptr();
    const texLen = wasm.engine_gpu_tex_indices_len();

    let renderState: { entityCount: number; entityData: ArrayBuffer; texIndices: ArrayBuffer } | null = null;

    if (count > 0 && ptr !== 0) {
        const wasmData = new Float32Array(wasm.memory.buffer, ptr, f32Len);
        const entityBuf = new Float32Array(f32Len);
        entityBuf.set(wasmData);

        let texBuf: Uint32Array;
        if (texPtr !== 0 && texLen > 0) {
            const wasmTex = new Uint32Array(wasm.memory.buffer, texPtr, texLen);
            texBuf = new Uint32Array(texLen);
            texBuf.set(wasmTex);
        } else {
            texBuf = new Uint32Array(count);
        }

        renderState = {
            entityCount: count,
            entityData: entityBuf.buffer,
            texIndices: texBuf.buffer,
        };
    }

    if (renderState) {
        self.postMessage(
            { type: "tick-done", dt: msg.dt, tickCount: Number(wasm.engine_tick_count()), renderState },
            [renderState.entityData, renderState.texIndices]
        );
    } else {
        self.postMessage({ type: "tick-done", dt: msg.dt, tickCount: Number(wasm.engine_tick_count()), renderState: null });
    }
    break;
}
```

Add the new WASM exports to the worker's WasmEngine interface:

```typescript
engine_gpu_tex_indices_ptr(): number;
engine_gpu_tex_indices_len(): number;
```

**Step 6: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No type errors.

**Step 7: Commit**

```bash
git add ts/src/worker-bridge.ts ts/src/engine-worker.ts
git commit -m "feat: wire texture layer indices through worker bridge and engine worker"
```

---

## Task 10: Update Main.ts and Render Worker

**Files:**
- Modify: `ts/src/main.ts`
- Modify: `ts/src/render-worker.ts`

**Step 1: Update main.ts render call**

In the `frame()` function of `ts/src/main.ts`, update the render call to pass texture indices:

```typescript
if (renderer && bridge.latestRenderState && bridge.latestRenderState.entityCount > 0) {
  renderer.render(
    bridge.latestRenderState.entityData,
    bridge.latestRenderState.entityCount,
    camera,
    bridge.latestRenderState.texIndices,
  );
}
```

**Step 2: Update render-worker.ts**

In `ts/src/render-worker.ts`, update the render worker to:
1. Create its own `TextureManager` and renderer with the new pipeline
2. Receive `texIndices` in the render state message
3. Pass `texIndices` to `renderer.render()`

The render worker mirrors the main thread renderer. Update the message handler for incoming render state:

```typescript
ecsPort.onmessage = (event) => {
  const { renderState } = event.data;
  if (renderState) {
    latestRenderState = {
      entityCount: renderState.entityCount,
      entityData: new Float32Array(renderState.entityData),
      texIndices: new Uint32Array(renderState.texIndices),
    };
  }
};
```

And the render loop:

```typescript
function renderFrame() {
  if (!latestRenderState || !renderer) {
    requestAnimationFrame(renderFrame);
    return;
  }

  renderer.render(
    latestRenderState.entityData,
    latestRenderState.entityCount,
    camera,
    latestRenderState.texIndices,
  );
  requestAnimationFrame(renderFrame);
}
```

Also update the `extractFrustumPlanesInternal` copy to stay in sync with `renderer.ts` (both files have the same duplication, as noted in CLAUDE.md gotchas).

**Step 3: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No type errors.

**Step 4: Commit**

```bash
git add ts/src/main.ts ts/src/render-worker.ts
git commit -m "feat: pass texture indices through render pipeline in all execution modes"
```

---

## Task 11: Integration Tests

**Files:**
- Modify: `ts/src/integration.test.ts`

**Step 1: Add GPU data format test for texture indices**

Add to `ts/src/integration.test.ts`:

```typescript
describe("Integration: Texture Layer Index Pipeline", () => {
  it("SetTextureLayer command binary matches Rust format", () => {
    const sab = new SharedArrayBuffer(16 + 128);
    const rb = new RingBufferProducer(sab);

    rb.spawnEntity(0);                           // 5 bytes
    rb.setTextureLayer(0, (2 << 16) | 42);      // 9 bytes

    const header = new Int32Array(sab, 0, 4);
    const writeHead = Atomics.load(header, 0);
    expect(writeHead).toBe(14); // 5 + 9

    const data = new Uint8Array(sab, 16, 128);

    // SpawnEntity at offset 0
    expect(data[0]).toBe(1);

    // SetTextureLayer at offset 5
    expect(data[5]).toBe(7); // CommandType.SetTextureLayer

    // Entity ID = 0 at offset 6-9
    const entityId = data[6] | (data[7] << 8) | (data[8] << 16) | (data[9] << 24);
    expect(entityId).toBe(0);

    // Packed value at offset 10-13
    const packed = data[10] | (data[11] << 8) | (data[12] << 16) | (data[13] << 24);
    expect(packed).toBe((2 << 16) | 42);
  });

  it("GPURenderState includes texIndices field", () => {
    // Verify the type structure exists
    const state: import("./worker-bridge").GPURenderState = {
      entityCount: 1,
      entityData: new Float32Array(20),
      texIndices: new Uint32Array([0]),
    };
    expect(state.texIndices.length).toBe(1);
    expect(state.entityCount).toBe(1);
  });
});
```

**Step 2: Run all tests**

Run: `cd ts && npm test`
Expected: All tests pass.

Run: `cargo test -p hyperion-core`
Expected: All Rust tests pass.

**Step 3: Commit**

```bash
git add ts/src/integration.test.ts
git commit -m "test: add texture layer index integration tests"
```

---

## Task 12: Full Validation and Visual Test

**Files:**
- Modify: `ts/src/main.ts` (add test image loading)

**Step 1: Add test texture loading to main.ts**

After the renderer is created and before the entity spawning loop, add a texture loading demo. Create a few test textures using the TextureManager:

```typescript
// Load test textures (if renderer is available)
if (renderer) {
  // For visual testing, programmatically create a few colored test images
  // by using the TextureManager directly. In production, these would be fetch() URLs.
  // For now, the default white fallback (tier 0, layer 0) renders all entities white.
  // To test with real images, place .png files in public/ and uncomment:
  //
  // const texIdx = await renderer.textureManager.loadTexture("/sprites/test.png");
  // bridge.commandBuffer.setTextureLayer(0, texIdx);
}
```

**Step 2: Full validation**

Run the complete test suite:

```bash
cargo test -p hyperion-core && cargo clippy -p hyperion-core && cd ts && npm test && npx tsc --noEmit
```

Expected: All tests pass, no clippy warnings, no type errors.

**Step 3: Build WASM and visual test**

```bash
cd ts && npm run build:wasm && npm run dev
```

Expected: Browser renders entities as white quads (default fallback texture). The procedural color mixing from Phase 3 is replaced with pure texture sampling — entities with `TextureLayerIndex(0)` sample the white fallback from tier 0, layer 0.

**Step 4: Commit**

```bash
git add ts/src/main.ts
git commit -m "feat: Phase 4 complete — asset pipeline with createImageBitmap, multi-tier Texture2DArray, per-entity texture assignment"
```

---

## Task 13: Update CLAUDE.md and Documentation

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update implementation status**

In `CLAUDE.md`, update the "Implementation Status" section:

```markdown
Phases 0-4 are complete. The architecture design doc is at `docs/plans/2026-02-17-hyperion-engine-design.md`. Phase 5 (TypeScript API & Lifecycle) is next.
```

**Step 2: Add Phase 4 gotchas**

Add to the Gotchas section:

```markdown
- **`createImageBitmap` not available in Workers on all browsers** — Firefox supports it, Chrome supports it. Safari has partial support. The `TextureManager` should only be instantiated where `createImageBitmap` is available. In Mode A's Render Worker, verify support before loading textures.
- **Texture2DArray maxTextureArrayLayers varies by device** — WebGPU spec guarantees minimum 256. The `TextureManager` allocates 256 layers per tier. On devices with fewer layers, loading will fail. Future: query `device.limits.maxTextureArrayLayers`.
- **Multi-tier textures require switch in WGSL** — WGSL cannot dynamically index texture bindings. The fragment shader uses a `switch` on the tier value. Adding new tiers requires updating the shader.
- **Texture indices buffer parallel to entity buffer** — The `texLayerIndices` storage buffer must be indexed by the same entity index as the `entities` buffer. Both are populated in the same `collect_gpu()` loop in Rust, ensuring alignment.
```

**Step 3: Add Phase 4 architecture notes**

Add to the Architecture table:

```markdown
| `texture-manager.ts` | `TextureManager` — multi-tier Texture2DArray management, `createImageBitmap` loading pipeline, concurrency limiter |
```

**Step 4: Update test counts**

Update the test commands section to include texture-manager tests.

**Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Phase 4 completion"
```

---

## Summary

After completing all 13 tasks, Phase 4 delivers:

**Rust (crates/hyperion-core):**
- `TextureLayerIndex(u32)` component — packed `(tier << 16 | layer)` per entity
- `SetTextureLayer` command (type=7, payload=4 bytes)
- `RenderState::collect_gpu()` now collects texture indices alongside entity data
- New WASM exports: `engine_gpu_tex_indices_ptr`, `engine_gpu_tex_indices_len`

**TypeScript (ts/src/):**
- `texture-manager.ts` — `TextureManager` class with:
  - 4 size tiers (64/128/256/512px), each a separate Texture2DArray
  - `loadTexture(url)` — fetch + createImageBitmap + copyExternalImageToTexture
  - Concurrency limiter (max 6 parallel fetches)
  - Layer allocation with fallback (layer 0 = white)
  - Progress tracking via `onProgress` callback
- `ring-buffer.ts` — `SetTextureLayer` command + `setTextureLayer()` convenience method
- `renderer.ts` — Two bind groups (vertex data + texture arrays), texture index buffer upload
- `worker-bridge.ts` — `GPURenderState.texIndices` field
- `engine-worker.ts` — Reads texture indices from WASM memory

**WGSL Shaders (ts/src/shaders/):**
- `basic.wgsl` — Per-entity texture lookup from `texLayerIndices` storage buffer, multi-tier switch for sampling correct Texture2DArray
- `cull.wgsl` — Unchanged (culling is texture-agnostic)

**Tests:**
- Rust: TextureLayerIndex component tests (3), SetTextureLayer command tests (2), texture index collection tests (2)
- TypeScript: Tier selection tests (6), index packing tests (3), SetTextureLayer binary format tests (2), integration tests (2)

**Performance characteristics:**
- Image decoding is off-main-thread via browser's `createImageBitmap`
- Pixels never traverse WASM linear memory
- Texture indices are a separate 4-byte-per-entity buffer (negligible upload cost)
- GPU texture switches are eliminated — all textures in a tier share one Texture2DArray descriptor
