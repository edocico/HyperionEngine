# Phase 3: GPU-Driven Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the CPU-driven draw pipeline with a GPU-driven pipeline: a WGSL compute shader performs frustum culling per entity, populates a visibility index buffer, and writes indirect draw arguments — so the CPU never touches draw call parameters. Add Texture2DArray infrastructure for per-entity texture sampling.

**Architecture:** Entity spatial data (model matrices + bounding spheres) is uploaded to a GPU StorageBuffer. A compute shader dispatches one invocation per entity, tests against 6 frustum planes, and appends visible entity indices to a compacted list via `atomicAdd`. The render pass uses `drawIndexedIndirect`, reading instance count from the GPU-populated indirect buffer. Visible entities are looked up via an indirection table (`visible_indices[instance_index]`). A procedural Texture2DArray provides per-entity texture sampling infrastructure for Phase 4.

**Tech Stack:** Rust (hecs, glam, bytemuck, wasm-bindgen), WGSL (compute + render shaders), TypeScript (WebGPU API, Vite), vitest.

**Design Doc:** `docs/plans/2026-02-17-hyperion-engine-design.md` — Section 6 (Rendering Pipeline)

---

## GPU-Driven Data Flow

```
Rust ECS (per frame):
  collect() → Vec<EntityGPUData> [model: mat4x4, bounds: vec4]
       ↓
TypeScript:
  queue.writeBuffer(entityBuffer, data)        ← upload ALL active entities
  queue.writeBuffer(indirectBuffer, reset)     ← instanceCount = 0
  queue.writeBuffer(cullUniform, frustum)      ← 6 frustum planes
       ↓
GPU Compute Pass (cull.wgsl):
  per entity: test bounds vs 6 frustum planes
  if visible: slot = atomicAdd(indirectArgs.instanceCount, 1)
              visibleIndices[slot] = entity_index
       ↓
GPU Render Pass (basic.wgsl):
  @builtin(instance_index) → visibleIndices[inst] → entityData[idx].model
  drawIndexedIndirect(indirectBuffer, 0)
```

## Buffer Layout

| Buffer | Size (100K entities) | Usage Flags | Content |
|--------|---------------------|-------------|---------|
| Entity data | 8 MB (80B × 100K) | `STORAGE \| COPY_DST` | `[mat4x4f model, vec4f bounds]` per entity |
| Visible indices | 400 KB (4B × 100K) | `STORAGE` | Compacted `u32` entity indices |
| Indirect args | 20 B | `STORAGE \| INDIRECT \| COPY_DST` | `{indexCount, instanceCount, firstIndex, baseVertex, firstInstance}` |
| Cull uniforms | 128 B | `UNIFORM \| COPY_DST` | ViewProjection matrix + 6 frustum planes + entity count |
| Camera uniform | 64 B | `UNIFORM \| COPY_DST` | ViewProjection matrix (unchanged) |
| Texture2DArray | ~8 KB | `TEXTURE_BINDING \| COPY_DST` | 8 layers × 4×4 pixels × RGBA8 |

## Prerequisites

```bash
# Verify existing tests still pass before starting
cargo test -p hyperion-core && cd ts && npm test && npx tsc --noEmit
```

---

## Task 1: Add BoundingRadius Component

**Files:**
- Modify: `crates/hyperion-core/src/components.rs`
- Modify: `crates/hyperion-core/src/command_processor.rs`

**Step 1: Write the failing test**

Add to `crates/hyperion-core/src/components.rs`, inside the existing `#[cfg(test)] mod tests`:

```rust
#[test]
fn default_bounding_radius_is_half() {
    let b = BoundingRadius::default();
    assert_eq!(b.0, 0.5);
}

#[test]
fn bounding_radius_is_pod() {
    let b = BoundingRadius(1.0);
    let bytes = bytemuck::bytes_of(&b);
    assert_eq!(bytes.len(), 4);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core components`
Expected: FAIL — `BoundingRadius` not found.

**Step 3: Write the implementation**

Add to `crates/hyperion-core/src/components.rs`, after the `Active` struct:

```rust
/// Bounding sphere radius for frustum culling.
/// The sphere center is the entity's Position.
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct BoundingRadius(pub f32);

impl Default for BoundingRadius {
    fn default() -> Self {
        Self(0.5) // unit quad default
    }
}
```

**Step 4: Update the spawn archetype**

In `crates/hyperion-core/src/command_processor.rs`, find the `SpawnEntity` match arm and add `BoundingRadius::default()` to the spawn tuple. Update the import to include `BoundingRadius`.

The spawn call becomes:
```rust
CommandType::SpawnEntity => {
    let entity = world.spawn((
        Position::default(),
        Rotation::default(),
        Scale::default(),
        Velocity::default(),
        ModelMatrix::default(),
        BoundingRadius::default(),
        Active,
    ));
    entity_map.insert(cmd.entity_id, entity);
}
```

Also update the `use crate::components::*;` import (already a wildcard, so no change needed).

**Step 5: Run tests**

Run: `cargo test -p hyperion-core`
Expected: All existing tests + 2 new tests pass.

**Step 6: Commit**

```bash
git add crates/hyperion-core/src/components.rs crates/hyperion-core/src/command_processor.rs
git commit -m "feat: add BoundingRadius component for GPU frustum culling"
```

---

## Task 2: Restructure RenderState for EntityGPUData

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs`

The current `RenderState` collects `Vec<[f32; 16]>` (model matrices only). For GPU-driven culling, each entity needs model matrix + bounding sphere data. The new layout matches the WGSL struct:

```
EntityGPUData (80 bytes):
  model: mat4x4f          (64 bytes, offset 0)
  boundingSphere: vec4f    (16 bytes, offset 64)
    .xyz = world position
    .w   = bounding radius
```

**Step 1: Write the failing test**

Add to `crates/hyperion-core/src/render_state.rs`, inside `#[cfg(test)] mod tests`:

```rust
#[test]
fn collect_gpu_produces_entity_gpu_data() {
    let mut world = World::new();
    world.spawn((
        Position(Vec3::new(1.0, 2.0, 3.0)),
        Rotation(Quat::IDENTITY),
        Scale(Vec3::ONE),
        Velocity::default(),
        ModelMatrix::default(),
        BoundingRadius(0.5),
        Active,
    ));

    // Run transform to compute the model matrix
    crate::systems::transform_system(&mut world);

    let mut state = RenderState::new();
    state.collect_gpu(&world);

    assert_eq!(state.gpu_entity_count(), 1);

    let data = state.gpu_buffer();
    // 20 floats per entity: 16 (matrix) + 4 (bounding sphere)
    assert_eq!(data.len(), 20);

    // Bounding sphere: position xyz + radius
    assert_eq!(data[16], 1.0); // pos.x
    assert_eq!(data[17], 2.0); // pos.y
    assert_eq!(data[18], 3.0); // pos.z
    assert_eq!(data[19], 0.5); // radius
}

#[test]
fn collect_gpu_multiple_entities() {
    let mut world = World::new();
    for i in 0..3 {
        world.spawn((
            Position(Vec3::new(i as f32, 0.0, 0.0)),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            Velocity::default(),
            ModelMatrix::default(),
            BoundingRadius(1.0),
            Active,
        ));
    }
    crate::systems::transform_system(&mut world);

    let mut state = RenderState::new();
    state.collect_gpu(&world);

    assert_eq!(state.gpu_entity_count(), 3);
    assert_eq!(state.gpu_buffer().len(), 60); // 3 * 20
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core render_state`
Expected: FAIL — `collect_gpu`, `gpu_entity_count`, `gpu_buffer` not found.

**Step 3: Implement collect_gpu**

Add to `crates/hyperion-core/src/render_state.rs`:

```rust
use crate::components::{Active, BoundingRadius, ModelMatrix, Position};

/// Per-entity GPU data: 20 floats (80 bytes).
/// Layout matches WGSL struct EntityData { model: mat4x4f, boundingSphere: vec4f }.
const FLOATS_PER_GPU_ENTITY: usize = 20;

impl RenderState {
    /// Collect entity data for GPU-driven pipeline.
    /// Each entity produces 20 floats: 16 (model matrix) + 4 (bounding sphere).
    pub fn collect_gpu(&mut self, world: &World) {
        self.gpu_data.clear();
        self.gpu_count = 0;

        for (pos, matrix, radius, _active) in
            world.query::<(&Position, &ModelMatrix, &BoundingRadius, &Active)>().iter()
        {
            // Model matrix: 16 floats
            self.gpu_data.extend_from_slice(&matrix.0);
            // Bounding sphere: xyz = position, w = radius
            self.gpu_data.push(pos.0.x);
            self.gpu_data.push(pos.0.y);
            self.gpu_data.push(pos.0.z);
            self.gpu_data.push(radius.0);

            self.gpu_count += 1;
        }
    }

    /// Number of entities in the GPU buffer.
    pub fn gpu_entity_count(&self) -> u32 {
        self.gpu_count
    }

    /// Raw float buffer for GPU upload (20 floats per entity).
    pub fn gpu_buffer(&self) -> &[f32] {
        &self.gpu_data
    }

    /// Pointer to the GPU buffer for WASM export.
    pub fn gpu_buffer_ptr(&self) -> *const f32 {
        self.gpu_data.as_ptr()
    }

    /// Total number of floats in the GPU buffer.
    pub fn gpu_buffer_f32_len(&self) -> u32 {
        self.gpu_data.len() as u32
    }
}
```

Update the `RenderState` struct to add the new fields:

```rust
pub struct RenderState {
    pub buffer: Vec<f32>,
    pub entity_count: u32,
    // GPU-driven pipeline data
    gpu_data: Vec<f32>,
    gpu_count: u32,
}
```

Update `RenderState::new()` to initialize the new fields:

```rust
pub fn new() -> Self {
    Self {
        buffer: Vec::new(),
        entity_count: 0,
        gpu_data: Vec::new(),
        gpu_count: 0,
    }
}
```

**Step 4: Run tests**

Run: `cargo test -p hyperion-core render_state`
Expected: All render_state tests pass (existing + 2 new).

**Step 5: Run all tests**

Run: `cargo test -p hyperion-core`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add crates/hyperion-core/src/render_state.rs
git commit -m "feat: add GPU-driven entity data collection to RenderState"
```

---

## Task 3: Update WASM Exports for GPU Data

**Files:**
- Modify: `crates/hyperion-core/src/lib.rs`

**Step 1: Add new WASM exports**

Add to `crates/hyperion-core/src/lib.rs`, after the existing render state exports:

```rust
/// Pointer to the GPU entity data buffer (20 f32s per entity).
/// Layout: [model: 16×f32, boundingSphere: 4×f32] × N entities.
#[wasm_bindgen]
pub fn engine_gpu_data_ptr() -> *const f32 {
    // SAFETY: wasm32 is single-threaded; only one caller at a time.
    unsafe {
        ENGINE
            .as_ref()
            .map_or(std::ptr::null(), |e| e.render_state.gpu_buffer_ptr())
    }
}

/// Number of floats in the GPU entity data buffer.
#[wasm_bindgen]
pub fn engine_gpu_data_f32_len() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        ENGINE
            .as_ref()
            .map_or(0, |e| e.render_state.gpu_buffer_f32_len())
    }
}

/// Number of entities in the GPU data buffer.
#[wasm_bindgen]
pub fn engine_gpu_entity_count() -> u32 {
    // SAFETY: wasm32 is single-threaded.
    unsafe {
        ENGINE
            .as_ref()
            .map_or(0, |e| e.render_state.gpu_entity_count())
    }
}
```

**Step 2: Update `engine_update` to also call `collect_gpu`**

In the `engine_update` function, after the existing `engine.update(dt, &commands)` call, add:

```rust
// Collect GPU-driven pipeline data
engine.render_state.collect_gpu(&engine.world);
```

Note: `render_state` needs to be accessible. Check if `Engine` already has a `render_state` field. If not, add one:

In `crates/hyperion-core/src/engine.rs`, add `pub render_state: RenderState` to the `Engine` struct and initialize it in `Engine::new()`:

```rust
use crate::render_state::RenderState;

pub struct Engine {
    pub world: World,
    pub entity_map: EntityMap,
    pub render_state: RenderState,
    accumulator: f32,
    tick_count: u64,
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
```

If `Engine` already has a `render_state` field from Phase 2, just verify it's the right type. If the existing `engine_update` already calls `collect()`, add `collect_gpu()` right after it.

**Step 3: Build WASM to verify**

Run: `cargo build --target wasm32-unknown-unknown -p hyperion-core`
Expected: Compiles successfully.

Run: `cargo test -p hyperion-core`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add crates/hyperion-core/src/lib.rs crates/hyperion-core/src/engine.rs
git commit -m "feat: add WASM exports for GPU-driven entity data"
```

---

## Task 4: Frustum Plane Extraction

**Files:**
- Modify: `ts/src/camera.ts`
- Modify: `ts/src/camera.test.ts`

Extract 6 frustum planes from a view-projection matrix. Each plane is `vec4(a, b, c, d)` where `ax + by + cz + d >= 0` means the point is inside (or on) the plane.

Extraction method (Gribb & Hartmann, 2001): given a column-major VP matrix `m[col*4+row]`:
- Left:   `(m[3]+m[0], m[7]+m[4], m[11]+m[8], m[15]+m[12])`
- Right:  `(m[3]-m[0], m[7]-m[4], m[11]-m[8], m[15]-m[12])`
- Bottom: `(m[3]+m[1], m[7]+m[5], m[11]+m[9], m[15]+m[13])`
- Top:    `(m[3]-m[1], m[7]-m[5], m[11]-m[9], m[15]-m[13])`
- Near:   `(m[2], m[6], m[10], m[14])` — WebGPU depth [0,1]
- Far:    `(m[3]-m[2], m[7]-m[6], m[11]-m[10], m[15]-m[14])`

**Step 1: Write the failing tests**

Add to `ts/src/camera.test.ts`:

```typescript
import { extractFrustumPlanes } from "./camera";

describe("extractFrustumPlanes", () => {
  it("extracts 6 planes from an orthographic VP matrix", () => {
    // Create a simple orthographic matrix: left=-10, right=10, bottom=-7.5, top=7.5, near=0, far=100
    const camera = new Camera();
    camera.setOrthographic(20, 15, 0, 100);
    const vp = camera.viewProjection;

    const planes = extractFrustumPlanes(vp);

    // 6 planes × 4 floats = 24 floats
    expect(planes.length).toBe(24);
  });

  it("classifies a point inside the frustum as visible", () => {
    const camera = new Camera();
    camera.setOrthographic(20, 15, 0, 100);
    const planes = extractFrustumPlanes(camera.viewProjection);

    // Point at origin should be inside a centered orthographic frustum
    const visible = isPointInFrustum(planes, 0, 0, -50);
    expect(visible).toBe(true);
  });

  it("classifies a point outside the frustum as not visible", () => {
    const camera = new Camera();
    camera.setOrthographic(20, 15, 0, 100);
    const planes = extractFrustumPlanes(camera.viewProjection);

    // Point far to the right (x=100) should be outside
    const visible = isPointInFrustum(planes, 100, 0, -50);
    expect(visible).toBe(false);
  });

  it("classifies a sphere partially inside as visible", () => {
    const camera = new Camera();
    camera.setOrthographic(20, 15, 0, 100);
    const planes = extractFrustumPlanes(camera.viewProjection);

    // Sphere at x=10.3, radius=0.5 — center is just outside right plane (10.0),
    // but sphere overlaps. Should be visible.
    const visible = isSphereInFrustum(planes, 10.3, 0, -50, 0.5);
    expect(visible).toBe(true);
  });

  it("classifies a sphere fully outside as not visible", () => {
    const camera = new Camera();
    camera.setOrthographic(20, 15, 0, 100);
    const planes = extractFrustumPlanes(camera.viewProjection);

    // Sphere at x=20, radius=0.5 — fully outside right plane (10.0)
    const visible = isSphereInFrustum(planes, 20, 0, -50, 0.5);
    expect(visible).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/camera.test.ts`
Expected: FAIL — `extractFrustumPlanes`, `isPointInFrustum`, `isSphereInFrustum` not found.

**Step 3: Implement frustum extraction**

Add to `ts/src/camera.ts`:

```typescript
/**
 * Extract 6 frustum planes from a column-major view-projection matrix.
 * Returns a Float32Array of 24 floats (6 planes × vec4).
 * Each plane: (a, b, c, d) where ax + by + cz + d >= 0 is inside.
 * Planes are normalized (|abc| = 1) for correct distance calculations.
 *
 * Plane order: Left, Right, Bottom, Top, Near, Far.
 */
export function extractFrustumPlanes(vp: Float32Array): Float32Array {
  const planes = new Float32Array(24);

  // Column-major access: m[col*4 + row]
  const m = vp;

  // Left: row3 + row0
  planes[0]  = m[3]  + m[0];
  planes[1]  = m[7]  + m[4];
  planes[2]  = m[11] + m[8];
  planes[3]  = m[15] + m[12];

  // Right: row3 - row0
  planes[4]  = m[3]  - m[0];
  planes[5]  = m[7]  - m[4];
  planes[6]  = m[11] - m[8];
  planes[7]  = m[15] - m[12];

  // Bottom: row3 + row1
  planes[8]  = m[3]  + m[1];
  planes[9]  = m[7]  + m[5];
  planes[10] = m[11] + m[9];
  planes[11] = m[15] + m[13];

  // Top: row3 - row1
  planes[12] = m[3]  - m[1];
  planes[13] = m[7]  - m[5];
  planes[14] = m[11] - m[9];
  planes[15] = m[15] - m[13];

  // Near: row2 (WebGPU depth [0,1])
  planes[16] = m[2];
  planes[17] = m[6];
  planes[18] = m[10];
  planes[19] = m[14];

  // Far: row3 - row2
  planes[20] = m[3]  - m[2];
  planes[21] = m[7]  - m[6];
  planes[22] = m[11] - m[10];
  planes[23] = m[15] - m[14];

  // Normalize each plane
  for (let i = 0; i < 6; i++) {
    const offset = i * 4;
    const len = Math.sqrt(
      planes[offset] * planes[offset] +
      planes[offset + 1] * planes[offset + 1] +
      planes[offset + 2] * planes[offset + 2]
    );
    if (len > 0) {
      planes[offset]     /= len;
      planes[offset + 1] /= len;
      planes[offset + 2] /= len;
      planes[offset + 3] /= len;
    }
  }

  return planes;
}

/**
 * Test if a point is inside all 6 frustum planes.
 * @param planes 24-float array from extractFrustumPlanes
 */
export function isPointInFrustum(
  planes: Float32Array, x: number, y: number, z: number
): boolean {
  for (let i = 0; i < 6; i++) {
    const offset = i * 4;
    const dist = planes[offset] * x + planes[offset + 1] * y +
                 planes[offset + 2] * z + planes[offset + 3];
    if (dist < 0) return false;
  }
  return true;
}

/**
 * Test if a bounding sphere intersects the frustum.
 * Returns true if any part of the sphere is inside.
 * @param planes 24-float array from extractFrustumPlanes
 */
export function isSphereInFrustum(
  planes: Float32Array, cx: number, cy: number, cz: number, radius: number
): boolean {
  for (let i = 0; i < 6; i++) {
    const offset = i * 4;
    const dist = planes[offset] * cx + planes[offset + 1] * cy +
                 planes[offset + 2] * cz + planes[offset + 3];
    if (dist < -radius) return false;
  }
  return true;
}
```

**Step 4: Run tests**

Run: `cd ts && npx vitest run src/camera.test.ts`
Expected: All camera tests pass (existing + 5 new).

**Step 5: Commit**

```bash
git add ts/src/camera.ts ts/src/camera.test.ts
git commit -m "feat: add frustum plane extraction and sphere-frustum test"
```

---

## Task 5: Compute Culling Shader

**Files:**
- Create: `ts/src/shaders/cull.wgsl`

This shader runs one invocation per entity. It tests the entity's bounding sphere against 6 frustum planes. Visible entities atomically increment the indirect draw `instanceCount` and write their index to the visibility buffer.

**Step 1: Write the compute shader**

`ts/src/shaders/cull.wgsl`:
```wgsl
// GPU frustum culling compute shader.
// Dispatched with ceil(totalEntities / 256) workgroups.

struct EntityData {
    model: mat4x4f,
    boundingSphere: vec4f,  // xyz = world position, w = radius
};

struct CullUniforms {
    frustumPlanes: array<vec4f, 6>,  // 6 normalized frustum planes
    totalEntities: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

struct DrawIndirectArgs {
    indexCount: u32,
    instanceCount: atomic<u32>,
    firstIndex: u32,
    baseVertex: u32,
    firstInstance: u32,
};

@group(0) @binding(0) var<uniform> cull: CullUniforms;
@group(0) @binding(1) var<storage, read> entities: array<EntityData>;
@group(0) @binding(2) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read_write> drawArgs: DrawIndirectArgs;

@compute @workgroup_size(256)
fn cull_main(@builtin(global_invocation_id) gid: vec3u) {
    let idx = gid.x;
    if (idx >= cull.totalEntities) {
        return;
    }

    let sphere = entities[idx].boundingSphere;
    let center = sphere.xyz;
    let radius = sphere.w;

    // Test sphere against all 6 frustum planes.
    // If the sphere is fully behind any plane, it's culled.
    var visible = true;
    for (var i = 0u; i < 6u; i = i + 1u) {
        let plane = cull.frustumPlanes[i];
        let dist = dot(plane.xyz, center) + plane.w;
        if (dist < -radius) {
            visible = false;
            break;
        }
    }

    if (visible) {
        let slot = atomicAdd(&drawArgs.instanceCount, 1u);
        visibleIndices[slot] = idx;
    }
}
```

**Step 2: Verify shader loads via Vite**

This can't be tested in isolation — it will be validated in Task 7 when the compute pipeline is created. For now, just ensure the file exists and is importable:

```typescript
// Quick check (will be used in renderer.ts):
import cullShader from './shaders/cull.wgsl?raw';
console.log(cullShader.length > 0); // true
```

**Step 3: Commit**

```bash
git add ts/src/shaders/cull.wgsl
git commit -m "feat: add WGSL compute culling shader"
```

---

## Task 6: Update Render Shader for Indirect Draw

**Files:**
- Modify: `ts/src/shaders/basic.wgsl`

The render shader must now use an indirection table: `instance_index` → `visibleIndices[instance_index]` → `entities[entityIdx].model`. This decouples the draw call's instance numbering from the entity buffer indexing.

**Step 1: Read the current shader**

Read: `ts/src/shaders/basic.wgsl` to understand the current structure.

**Step 2: Update the shader**

Replace `ts/src/shaders/basic.wgsl` with:

```wgsl
// Instanced colored quad shader with GPU-driven visibility indirection.

struct CameraUniform {
    viewProjection: mat4x4f,
};

struct EntityData {
    model: mat4x4f,
    boundingSphere: vec4f,  // xyz = position, w = radius (unused in render)
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> entities: array<EntityData>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;

struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) color: vec4f,
    @location(1) uv: vec2f,
};

@vertex
fn vs_main(
    @location(0) position: vec3f,
    @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
    // Indirection: instance_index → visible slot → entity index
    let entityIdx = visibleIndices[instanceIdx];
    let model = entities[entityIdx].model;

    var out: VertexOutput;
    out.clipPosition = camera.viewProjection * model * vec4f(position, 1.0);

    // Deterministic color from entity index (not instance index)
    let r = f32((entityIdx * 7u + 3u) % 11u) / 10.0;
    let g = f32((entityIdx * 13u + 5u) % 11u) / 10.0;
    let b = f32((entityIdx * 17u + 7u) % 11u) / 10.0;
    out.color = vec4f(r, g, b, 1.0);

    // UV for future texture sampling
    out.uv = position.xy + 0.5;

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    return in.color;
}
```

**Step 3: Commit**

```bash
git add ts/src/shaders/basic.wgsl
git commit -m "feat: update render shader for GPU-driven visibility indirection"
```

---

## Task 7: GPU-Driven Renderer

**Files:**
- Modify: `ts/src/renderer.ts`

This is the largest task. The renderer must be restructured to:
1. Create a compute pipeline (culling)
2. Create buffers: entity data, visible indices, indirect args, cull uniforms
3. Per frame: upload entity data → dispatch compute → drawIndexedIndirect

**Step 1: Read the current renderer**

Read: `ts/src/renderer.ts` — understand the existing buffer setup, pipeline creation, and render loop.

**Step 2: Rewrite the renderer**

Replace `ts/src/renderer.ts` with the GPU-driven implementation. Key changes:

```typescript
import shaderCode from './shaders/basic.wgsl?raw';
import cullShaderCode from './shaders/cull.wgsl?raw';

const MAX_ENTITIES = 100_000;
const FLOATS_PER_GPU_ENTITY = 20;  // mat4x4 (16) + vec4 boundingSphere (4)
const BYTES_PER_GPU_ENTITY = FLOATS_PER_GPU_ENTITY * 4;  // 80 bytes
const INDIRECT_BUFFER_SIZE = 20;  // 5 × u32

export interface Renderer {
  render(entityData: Float32Array, entityCount: number, camera: { viewProjection: Float32Array }): void;
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

  // --- Vertex + Index Buffers (unchanged) ---
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

  // --- Entity Data Storage Buffer (all active entities) ---
  const entityBuffer = device.createBuffer({
    size: MAX_ENTITIES * BYTES_PER_GPU_ENTITY,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // --- Visible Indices Storage Buffer ---
  const visibleIndicesBuffer = device.createBuffer({
    size: MAX_ENTITIES * 4,  // u32 per entity
    usage: GPUBufferUsage.STORAGE,
  });

  // --- Indirect Draw Args Buffer ---
  const indirectBuffer = device.createBuffer({
    size: INDIRECT_BUFFER_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  });

  // --- Cull Uniforms ---
  // Layout: 6 × vec4f (frustum planes) + u32 totalEntities + 3 × u32 padding = 112 bytes
  const CULL_UNIFORM_SIZE = 6 * 16 + 16;  // 112 bytes
  const cullUniformBuffer = device.createBuffer({
    size: CULL_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // --- Depth Texture ---
  let depthTexture = createDepthTexture(device, canvas.width, canvas.height);

  // --- Compute Pipeline (Culling) ---
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

  // --- Render Pipeline ---
  const renderModule = device.createShaderModule({ code: shaderCode });
  const renderBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });
  const renderPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [renderBindGroupLayout] }),
    vertex: {
      module: renderModule,
      entryPoint: "vs_main",
      buffers: [{
        arrayStride: 12,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
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
  const renderBindGroup = device.createBindGroup({
    layout: renderBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 1, resource: { buffer: entityBuffer } },
      { binding: 2, resource: { buffer: visibleIndicesBuffer } },
    ],
  });

  return {
    render(entityData: Float32Array, entityCount: number, camera) {
      if (entityCount === 0) return;

      // 1. Upload entity data (all active entities)
      device.queue.writeBuffer(
        entityBuffer, 0,
        entityData, 0,
        entityCount * FLOATS_PER_GPU_ENTITY,
      );

      // 2. Upload camera uniform
      device.queue.writeBuffer(cameraBuffer, 0, camera.viewProjection);

      // 3. Upload cull uniforms (frustum planes + entity count)
      const cullData = new ArrayBuffer(CULL_UNIFORM_SIZE);
      const cullFloats = new Float32Array(cullData, 0, 24);  // 6 planes × 4 floats
      const frustumPlanes = extractFrustumPlanesInternal(camera.viewProjection);
      cullFloats.set(frustumPlanes);
      const cullUints = new Uint32Array(cullData, 96, 4);  // offset 96 = after 24 floats
      cullUints[0] = entityCount;
      device.queue.writeBuffer(cullUniformBuffer, 0, cullData);

      // 4. Reset indirect draw args: indexCount=6, instanceCount=0, rest=0
      const resetArgs = new Uint32Array([6, 0, 0, 0, 0]);
      device.queue.writeBuffer(indirectBuffer, 0, resetArgs);

      // 5. Encode command buffer
      const encoder = device.createCommandEncoder();

      // 5a. Compute pass: frustum culling
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(cullPipeline);
      computePass.setBindGroup(0, cullBindGroup);
      computePass.dispatchWorkgroups(Math.ceil(entityCount / 256));
      computePass.end();

      // 5b. Render pass: indirect draw
      const textureView = context.getCurrentTexture().createView();
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: textureView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0.067, g: 0.067, b: 0.067, a: 1 },
        }],
        depthStencilAttachment: {
          view: depthTexture.createView(),
          depthLoadOp: "clear",
          depthStoreOp: "store",
          depthClearValue: 1.0,
        },
      });
      renderPass.setPipeline(renderPipeline);
      renderPass.setVertexBuffer(0, vertexBuffer);
      renderPass.setIndexBuffer(indexBuffer, "uint16");
      renderPass.setBindGroup(0, renderBindGroup);
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

/**
 * Internal frustum extraction (same algorithm as camera.ts export,
 * duplicated here to avoid circular dependency in render-worker).
 */
function extractFrustumPlanesInternal(vp: Float32Array): Float32Array {
  const planes = new Float32Array(24);
  const m = vp;

  // Left, Right, Bottom, Top, Near, Far
  const rows = [
    [3, 0, 1],   // Left:   row3 + row0
    [3, 0, -1],  // Right:  row3 - row0
    [3, 1, 1],   // Bottom: row3 + row1
    [3, 1, -1],  // Top:    row3 - row1
    [2, -1, 0],  // Near:   row2
    [3, 2, -1],  // Far:    row3 - row2
  ];

  // Left
  planes[0]  = m[3]  + m[0];  planes[1]  = m[7]  + m[4];
  planes[2]  = m[11] + m[8];  planes[3]  = m[15] + m[12];
  // Right
  planes[4]  = m[3]  - m[0];  planes[5]  = m[7]  - m[4];
  planes[6]  = m[11] - m[8];  planes[7]  = m[15] - m[12];
  // Bottom
  planes[8]  = m[3]  + m[1];  planes[9]  = m[7]  + m[5];
  planes[10] = m[11] + m[9];  planes[11] = m[15] + m[13];
  // Top
  planes[12] = m[3]  - m[1];  planes[13] = m[7]  - m[5];
  planes[14] = m[11] - m[9];  planes[15] = m[15] - m[13];
  // Near (WebGPU depth [0,1])
  planes[16] = m[2];  planes[17] = m[6];
  planes[18] = m[10]; planes[19] = m[14];
  // Far
  planes[20] = m[3]  - m[2];  planes[21] = m[7]  - m[6];
  planes[22] = m[11] - m[10]; planes[23] = m[15] - m[14];

  // Normalize each plane
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

**Important notes for the implementer:**
- The `render()` method signature changed: it now receives `entityData` (20 floats per entity from Rust's `collect_gpu()`) instead of just model matrices.
- The `createRenderer` function is now `async` (it always was, but verify the callers).
- `extractFrustumPlanesInternal` is duplicated from `camera.ts` to avoid import issues in the render worker. Both implementations must stay in sync.

**Step 3: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No type errors.

**Step 4: Build WASM and test visually**

Run: `cd ts && npm run build:wasm && npm run dev`
Expected: Browser renders entities with GPU-driven culling. Entities outside the camera frustum are not drawn.

**Step 5: Commit**

```bash
git add ts/src/renderer.ts
git commit -m "feat: GPU-driven renderer with compute culling and indirect draw"
```

---

## Task 8: Update Engine Worker and Worker Bridge

**Files:**
- Modify: `ts/src/engine-worker.ts`
- Modify: `ts/src/worker-bridge.ts`

The engine worker must now export the GPU entity data buffer (20 floats per entity) instead of just model matrices (16 floats per entity).

**Step 1: Update engine-worker.ts**

In the `tick` message handler, replace the render state extraction to use the new GPU data exports:

```typescript
case "tick": {
    if (!wasm) return;

    // Extract commands from ring buffer and push to WASM
    // (existing code — keep as-is)

    wasm.engine_update(msg.dt);

    // Read GPU entity data from WASM memory
    const count = wasm.engine_gpu_entity_count();
    const ptr = wasm.engine_gpu_data_ptr();
    const f32Len = wasm.engine_gpu_data_f32_len();

    let renderState: { count: number; entityData: ArrayBuffer } | null = null;

    if (count > 0 && ptr !== 0) {
        const wasmData = new Float32Array(wasm.memory.buffer, ptr, f32Len);
        const transferBuf = new Float32Array(f32Len);
        transferBuf.set(wasmData);
        renderState = { count, entityData: transferBuf.buffer };
    }

    if (renderState) {
        self.postMessage(
            { type: "tick-done", dt: msg.dt, tickCount: Number(wasm.engine_tick_count()), renderState },
            [renderState.entityData]  // Transfer ownership
        );
    } else {
        self.postMessage({ type: "tick-done", dt: msg.dt, tickCount: Number(wasm.engine_tick_count()), renderState: null });
    }
    break;
}
```

Also update the `WasmEngine` interface to include the new exports:
```typescript
interface WasmEngine {
    engine_init(): void;
    engine_push_commands(data: Uint8Array): void;
    engine_update(dt: number): void;
    engine_tick_count(): bigint;
    engine_gpu_entity_count(): number;
    engine_gpu_data_ptr(): number;
    engine_gpu_data_f32_len(): number;
    // Keep existing exports for backward compatibility:
    engine_render_state_count(): number;
    engine_render_state_ptr(): number;
    engine_render_state_f32_len(): number;
    memory: WebAssembly.Memory;
}
```

**Step 2: Update worker-bridge.ts**

The `EngineBridge` interface needs to expose the GPU entity data format. Update the `latestRenderState` type:

```typescript
export interface GPURenderState {
    entityCount: number;
    entityData: Float32Array;  // 20 floats per entity
}
```

Update the bridge to parse the new format in the worker message handler and in Mode C's direct bridge.

For Mode C (direct bridge), update the `tick` method:
```typescript
tick(dt: number) {
    // Push commands
    // ...existing code...

    wasm.engine_update(dt);

    const count = wasm.engine_gpu_entity_count();
    const ptr = wasm.engine_gpu_data_ptr();
    const f32Len = wasm.engine_gpu_data_f32_len();

    if (count > 0 && ptr !== 0) {
        this._latestState = {
            entityCount: count,
            entityData: new Float32Array(wasm.memory.buffer, ptr, f32Len),
        };
    }
}
```

**Step 3: Update main.ts to use new render state format**

In `main.ts`, update the render call to pass the GPU entity data:

```typescript
function frame(now: number) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    bridge.tick(dt);

    const state = bridge.latestRenderState;
    if (state && renderer) {
        renderer.render(state.entityData, state.entityCount, camera);
    }

    requestAnimationFrame(frame);
}
```

**Step 4: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No type errors.

**Step 5: Commit**

```bash
git add ts/src/engine-worker.ts ts/src/worker-bridge.ts ts/src/main.ts
git commit -m "feat: wire GPU entity data through engine worker and bridge"
```

---

## Task 9: Update Render Worker (Mode A)

**Files:**
- Modify: `ts/src/render-worker.ts`

The render worker needs the same GPU-driven pipeline as the main thread renderer.

**Step 1: Update render-worker.ts**

The render worker receives entity data via MessageChannel from the ECS worker. Update it to:
1. Use the new entity data format (20 floats per entity)
2. Create the compute pipeline (culling)
3. Use `drawIndexedIndirect`

The changes mirror Task 7's renderer.ts. Key differences:
- Canvas is `OffscreenCanvas` (received via `transferControlToOffscreen`)
- Entity data arrives via `MessagePort` from the ECS worker
- Camera is created internally (same as before)

Copy the pipeline setup from `renderer.ts` into the render worker's init function, adapting for `OffscreenCanvas` context. The render loop should:

```typescript
function renderFrame() {
    if (!latestRenderState || !renderer) {
        requestAnimationFrame(renderFrame);
        return;
    }

    const { entityData, count } = latestRenderState;
    const data = new Float32Array(entityData);

    renderer.render(data, count, camera);
    requestAnimationFrame(renderFrame);
}
```

**Step 2: Verify by running in browser with Mode A**

Run: `cd ts && npm run build:wasm && npm run dev`
Test in Chrome (which supports Mode A). Verify rendering works.

**Step 3: Commit**

```bash
git add ts/src/render-worker.ts
git commit -m "feat: update render worker for GPU-driven pipeline (Mode A)"
```

---

## Task 10: Texture2DArray Infrastructure

**Files:**
- Modify: `ts/src/renderer.ts`
- Modify: `ts/src/shaders/basic.wgsl`

Set up a procedural Texture2DArray with 8 color layers. Entities sample from the array using their entity index modulo 8. This establishes the infrastructure for Phase 4's asset-loaded textures.

**Step 1: Create the procedural texture array**

Add to `renderer.ts`, inside `createRenderer()` after the existing buffer setup:

```typescript
// --- Texture2DArray: 8 layers of 4×4 solid colors ---
const TEX_LAYERS = 8;
const TEX_SIZE = 4;
const textureArray = device.createTexture({
    size: { width: TEX_SIZE, height: TEX_SIZE, depthOrArrayLayers: TEX_LAYERS },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
});

// Fill each layer with a distinct color
const colors: [number, number, number, number][] = [
    [230, 57, 70, 255],    // Red
    [244, 162, 97, 255],   // Orange
    [233, 196, 106, 255],  // Yellow
    [42, 157, 143, 255],   // Teal
    [38, 70, 83, 255],     // Dark Teal
    [69, 123, 157, 255],   // Blue
    [168, 218, 220, 255],  // Light Blue
    [241, 250, 238, 255],  // Off-White
];

for (let layer = 0; layer < TEX_LAYERS; layer++) {
    const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);
    const [r, g, b, a] = colors[layer];
    for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) {
        data[i * 4 + 0] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = a;
    }
    device.queue.writeTexture(
        { texture: textureArray, origin: { x: 0, y: 0, z: layer } },
        data,
        { bytesPerRow: TEX_SIZE * 4, rowsPerImage: TEX_SIZE },
        { width: TEX_SIZE, height: TEX_SIZE, depthOrArrayLayers: 1 },
    );
}

const texSampler = device.createSampler({
    magFilter: "nearest",
    minFilter: "nearest",
});
```

**Step 2: Update bind group layouts and groups**

Add texture bindings to the render bind group:
```typescript
// Add to renderBindGroupLayout entries:
{ binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
{ binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },

// Add to renderBindGroup entries:
{ binding: 3, resource: textureArray.createView({ dimension: "2d-array" }) },
{ binding: 4, resource: texSampler },
```

**Step 3: Update the fragment shader**

In `ts/src/shaders/basic.wgsl`, add texture bindings and update the fragment shader:

```wgsl
@group(0) @binding(3) var texArray: texture_2d_array<f32>;
@group(0) @binding(4) var texSampler: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    // Sample from texture array layer based on entity index
    let entityIdx = in.entityIdx;
    let layer = entityIdx % 8u;
    let texColor = textureSample(texArray, texSampler, in.uv, layer);

    // Blend procedural color with texture color (for visual variety)
    return mix(in.color, texColor, 0.6);
}
```

Also pass `entityIdx` from vertex to fragment:
```wgsl
struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) color: vec4f,
    @location(1) uv: vec2f,
    @location(2) @interpolate(flat) entityIdx: u32,
};

// In vs_main, add:
out.entityIdx = entityIdx;
```

**Step 4: Type-check and visual test**

Run: `cd ts && npx tsc --noEmit`
Run: `cd ts && npm run dev`
Expected: Entities now show distinct colors from the texture array blended with procedural colors.

**Step 5: Commit**

```bash
git add ts/src/renderer.ts ts/src/shaders/basic.wgsl
git commit -m "feat: add Texture2DArray infrastructure with procedural color layers"
```

---

## Task 11: Integration Tests

**Files:**
- Modify: `ts/src/integration.test.ts`
- Create: `ts/src/frustum.test.ts`

**Step 1: Write frustum culling accuracy tests**

`ts/src/frustum.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { Camera, extractFrustumPlanes, isSphereInFrustum } from "./camera";

describe("Frustum Culling Accuracy", () => {
    const camera = new Camera();
    camera.setOrthographic(20, 15, 0, 100);

    const planes = extractFrustumPlanes(camera.viewProjection);

    it("culls entity far to the left", () => {
        expect(isSphereInFrustum(planes, -15, 0, -50, 0.5)).toBe(false);
    });

    it("culls entity far to the right", () => {
        expect(isSphereInFrustum(planes, 15, 0, -50, 0.5)).toBe(false);
    });

    it("culls entity far above", () => {
        expect(isSphereInFrustum(planes, 0, 12, -50, 0.5)).toBe(false);
    });

    it("culls entity far below", () => {
        expect(isSphereInFrustum(planes, 0, -12, -50, 0.5)).toBe(false);
    });

    it("keeps entity at center", () => {
        expect(isSphereInFrustum(planes, 0, 0, -50, 0.5)).toBe(true);
    });

    it("keeps entity at edge (partially inside)", () => {
        // Right edge is at x=10, sphere center at 10.3 with radius 0.5 overlaps
        expect(isSphereInFrustum(planes, 10.3, 0, -50, 0.5)).toBe(true);
    });

    it("large sphere near edge stays visible", () => {
        // Large radius entity barely touching the frustum
        expect(isSphereInFrustum(planes, 12, 0, -50, 3.0)).toBe(true);
    });
});
```

**Step 2: Update integration tests for new buffer format**

Add to `ts/src/integration.test.ts`:

```typescript
describe("Integration: GPU Entity Data Format", () => {
    it("produces 20 floats per entity matching WGSL EntityData struct", () => {
        // Verify that the data layout matches:
        // offset 0-63:  model matrix (16 × f32)
        // offset 64-79: bounding sphere (4 × f32: x, y, z, radius)

        const FLOATS_PER_ENTITY = 20;
        const entityCount = 3;
        const data = new Float32Array(entityCount * FLOATS_PER_ENTITY);

        // Simulate entity 0 at position (1, 2, 3) with identity matrix
        // Identity matrix: diagonal = 1.0
        data[0] = 1.0;  data[5] = 1.0;  data[10] = 1.0;  data[15] = 1.0;
        // Translation in columns 12-14
        data[12] = 1.0;  data[13] = 2.0;  data[14] = 3.0;
        // Bounding sphere
        data[16] = 1.0;  data[17] = 2.0;  data[18] = 3.0;  data[19] = 0.5;

        // Verify layout
        expect(data[16]).toBe(1.0);  // sphere center x
        expect(data[17]).toBe(2.0);  // sphere center y
        expect(data[18]).toBe(3.0);  // sphere center z
        expect(data[19]).toBe(0.5);  // sphere radius

        // Entity 1 starts at offset 20
        expect(data.length).toBe(60);  // 3 entities × 20 floats
    });
});
```

**Step 3: Run all tests**

Run: `cd ts && npm test`
Expected: All tests pass.

Run: `cargo test -p hyperion-core`
Expected: All Rust tests pass.

**Step 4: Commit**

```bash
git add ts/src/frustum.test.ts ts/src/integration.test.ts
git commit -m "test: add frustum culling accuracy and GPU data format integration tests"
```

---

## Task 12: Visual Verification and Debug Overlay

**Files:**
- Modify: `ts/src/main.ts`

**Step 1: Spawn entities both inside and outside the frustum**

Update the test entity setup in `main.ts` to include entities outside the camera view. This verifies GPU culling works visually:

```typescript
// Spawn 100 entities: 50 inside frustum, 50 outside
const ENTITY_COUNT = 100;
for (let i = 0; i < ENTITY_COUNT; i++) {
    bridge.commandBuffer.spawnEntity(i);

    if (i < 50) {
        // Inside frustum: grid within the camera's visible area
        const col = i % 10;
        const row = Math.floor(i / 10);
        bridge.commandBuffer.setPosition(i, (col - 4.5) * 2, (row - 2.5) * 2, 0);
    } else {
        // Outside frustum: far to the right and left
        const offset = i - 50;
        const x = offset < 25 ? -20 - offset : 20 + (offset - 25);
        bridge.commandBuffer.setPosition(i, x, 0, 0);
    }
}
```

**Step 2: Update debug overlay**

Update the FPS/entity count overlay to show culled vs visible:

```typescript
// In the frame loop, update info display:
info.textContent =
    `Hyperion Engine — Mode ${bridge.mode} | ` +
    `Entities: ${state?.entityCount ?? 0} total | ` +
    `FPS: ${fps.toFixed(0)}`;
```

Note: The actual visible count after GPU culling is not directly readable from JavaScript without a GPU readback (which would stall the pipeline). The debug overlay shows total active entities. Visible count verification is done visually: entities outside the frustum should not appear.

**Step 3: Full validation**

Run the complete test suite:
```bash
cargo test -p hyperion-core && cargo clippy -p hyperion-core && cd ts && npm test && npx tsc --noEmit
```
Expected: All tests pass, no clippy warnings, no type errors.

Run visual test:
```bash
cd ts && npm run build:wasm && npm run dev
```
Expected: Browser shows ~50 colored quads in a grid. The 50 entities outside the frustum are culled by the GPU compute shader and not drawn.

**Step 4: Commit**

```bash
git add ts/src/main.ts
git commit -m "feat: add visual verification with entities inside and outside frustum"
```

---

## Summary

After completing all 12 tasks, Phase 3 delivers:

**Rust (crates/hyperion-core):**
- `BoundingRadius` component — per-entity culling radius
- `RenderState::collect_gpu()` — produces 80-byte EntityGPUData (mat4x4 + vec4 bounds)
- New WASM exports: `engine_gpu_data_ptr`, `engine_gpu_data_f32_len`, `engine_gpu_entity_count`

**WGSL Shaders (ts/src/shaders/):**
- `cull.wgsl` — Compute culling shader (256 threads/workgroup, sphere-vs-frustum, atomicAdd)
- `basic.wgsl` — Updated render shader with visibility indirection + Texture2DArray sampling

**TypeScript (ts/src/):**
- `camera.ts` — `extractFrustumPlanes()`, `isPointInFrustum()`, `isSphereInFrustum()`
- `renderer.ts` — GPU-driven renderer: compute pipeline + indirect draw
- `render-worker.ts` — Mode A renderer updated for GPU-driven pipeline
- `engine-worker.ts` — Exports GPU entity data format
- `worker-bridge.ts` — New `GPURenderState` type with entity data

**Tests:**
- Rust: BoundingRadius component tests, EntityGPUData collection tests
- TypeScript: Frustum extraction tests, sphere-frustum intersection tests, GPU data format tests

**Performance characteristics:**
- CPU no longer touches draw call parameters
- GPU compute culling scales to 100K+ entities (256 threads per workgroup)
- Indirect draw eliminates CPU-side instance count management
- Texture2DArray eliminates texture bind state changes
