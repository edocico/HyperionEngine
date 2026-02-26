# Phase 10 DX — Developer Experience Design

**Status:** Approved
**Date:** 2026-02-26
**Prerequisite:** Phase 0–9 + Phase 4b + Phase 10 (Asset Pipeline) complete
**Scope:** 8 features across 3 sub-phases
**Deferred:** Physics integration → Phase 11

---

## 1. Vision & Principles

Phase 10 DX transforms Hyperion from a capable engine into one that's productive to build with. The phase serves all three markets equally: game developers need prefabs and time-travel; canvas-app builders need the ECS inspector; library consumers need the asset pipeline and HMR.

### Zero-Cost Principle

Every feature has zero runtime overhead when not used:

- **Rust:** WASM debug exports gated behind `#[cfg(feature = "dev-tools")]` — stripped from production builds
- **TypeScript:** Debug modules tree-shaken via `import.meta.env.DEV` conditional imports
- **Hook arrays:** Empty by default — no iteration cost when no plugins are registered

### Package Distribution

| Internal module path | Published package | Notes |
|---|---|---|
| `ts/src/prefab/` | Core engine (`hyperion`) | Barrel export |
| `ts/src/hmr/hot-system.ts` | Core engine (`hyperion/dev`) | Dev subpath, tree-shakes in prod |
| `ts/src/debug/debug-camera.ts` | `@hyperion-plugin/debug-camera` | Standalone plugin |
| `ts/src/debug/ecs-inspector.ts` | `@hyperion-plugin/devtools` | Standalone plugin |
| `ts/src/debug/bounds-visualizer.ts` | `@hyperion-plugin/devtools` | Same package as inspector |
| `ts/src/replay/` | `@hyperion-plugin/replay` | Standalone plugin |
| `ts/src/asset-pipeline/` | `vite-plugin-hyperion-assets` | Build tool, not runtime |

Plugin packages declare `hyperion` as peer dependency.

---

## 2. WASM Surface Changes

All 7 exports behind `#[cfg(feature = "dev-tools")]`. Production WASM binary unchanged.

| Export | Feature | Signature |
|---|---|---|
| `engine_reset` | L1 Replay | `() → void` — clears World, EntityMap, resets tick_count to 0 |
| `engine_debug_entity_count` | ECS Inspector | `() → u32` |
| `engine_debug_list_entities` | ECS Inspector | `(out_ptr: *mut u32, out_len: u32, flags: u32) → u32` — flags bit 0: 0=all mapped, 1=active-only |
| `engine_debug_get_components` | ECS Inspector | `(entity_id: u32, out_ptr: *mut u8, out_len: u32) → u32` — TLV serialization |
| `engine_debug_generate_lines` | Bounds Viz | `(vert_ptr: *mut f32, color_ptr: *mut f32, max_verts: u32) → u32` — vertices + per-vertex color |
| `engine_snapshot_create` | L2 Rewind | `() → Vec<u8>` (wasm-bindgen returns Uint8Array) |
| `engine_snapshot_restore` | L2 Rewind | `(data: &[u8]) → bool` (wasm-bindgen) |

### TLV Component Enum

Used by `engine_debug_get_components`. Format per component: `[type: u8][len: u16 LE][data: N bytes]`.

```
Position=1, Velocity=2, Rotation=3, Scale=4, ModelMatrix=5,
BoundingRadius=6, TextureLayerIndex=7, MeshHandle=8,
RenderPrimitive=9, Parent=10, Active=11, ExternalId=12,
PrimitiveParams=13, LocalMatrix=14, Children=15
```

`Children` serializes the inline 32-slot fixed array only (128 bytes + count byte). `OverflowChildren` is `Vec<u32>` (not Pod) — omitted from TLV. Inspector shows `[+N overflow]` indicator for >32 children.

### Snapshot Format

```
[magic: u32 "HSNP"][version: u32][tick: u64][entity_count: u32]
[entity_map_len: u32][entity_map: (external_id: u32, hecs_id: u64) × N]
[for each entity:
  [component_mask: u16]     // bitfield: which components present
  [component_data: ...]     // bytemuck bytes per component, enum order
]
```

SpatialGrid is **not serialized** — rebuilt from entity positions on `snapshot_restore()`. Avoids versioning internal grid structure. Simple format, no backward compatibility across WASM builds (dev-mode artifacts, not save files).

---

## 3. Sub-phase 10a — Foundations & Introspection

**Goal:** Give developers eyes into the engine.
**Deliverables:** SystemViews, WASM debug exports, Debug Camera, ECS Inspector

### 3.1 TS Systems with SoA Access

Extend `PluginSystemsAPI` hook signature to pass a `SystemViews` object — read-only TypedArray views into the GPU SoA buffers already produced by `collect_gpu()`.

```typescript
interface SystemViews {
  readonly entityCount: number;
  readonly transforms: Float32Array;   // 16 f32/entity (model matrix)
  readonly bounds: Float32Array;       // 4 f32/entity (xyz + radius)
  readonly texIndices: Uint32Array;    // 1 u32/entity
  readonly renderMeta: Uint32Array;    // 1 u32/entity (packed primitive + mesh)
  readonly primParams: Float32Array;   // 8 f32/entity
  readonly entityIds: Uint32Array;     // 1 u32/entity (external IDs)
}
```

**API change (backward compatible):**
```typescript
engine.systems.addPreTick('my-ai', (dt, views) => { ... });
```

**Timing semantics:** Views reflect the most recent `GPURenderState` delivered from WASM, which updates once per tick cycle. Both `addPreTick` and `addPostTick` see the same snapshot — `collect_gpu()` runs inside the WASM tick, and the bridge delivers the result before the next TS-side frame. Views do **not** reflect the current tick's changes.

**entityIds guarantee:** Always populated when `SystemViews` is provided, regardless of whether picking is enabled. Update cadence may differ from other buffers if future dirty-tracking optimizations skip it — the contract guarantees sync within the same `GPURenderState` delivery.

**Zero new WASM exports, zero new copies.** The views are already held in `GPURenderState` — they're passed through to hooks.

### 3.2 ECS Inspector WASM Exports

Three new exports (see Section 2 for signatures).

`engine_debug_list_entities` supports a `flags` parameter: bit 0 controls active-only vs. all mapped entities. The inspector needs both — "why is this entity inactive?" is a core debugging use case.

### 3.3 Debug Camera Plugin

Extracts `main.ts`'s existing WASD + scroll-zoom logic into a reusable `HyperionPlugin`.

```typescript
engine.use(debugCameraPlugin({
  moveSpeed: 300,     // pixels per second
  zoomSpeed: 0.1,     // zoom factor per scroll tick
  enableKey: 'F1',    // toggle key
}));
```

Uses `PluginSystemsAPI.addPreTick` to read `InputManager` state and update `CameraAPI`. No WASM changes.

### 3.4 ECS Inspector Visual Panel

HTML overlay panel (`<div>` injected into engine container) with:

- **Entity list** — scrollable, filterable by component type, searchable by external ID. Active/inactive badges.
- **Component view** — click entity, see live-updating component values.
- **Click-to-select** — canvas click highlights in panel (via SelectionManager), panel click highlights in canvas (via JFA outlines).

**Dual data channels:**

| Channel | Data source | Update rate | Use |
|---|---|---|---|
| Entity list (fast) | `SystemViews.entityIds` | Every frame (free) | List all entities |
| Selected detail (slow) | `engine_debug_get_components()` WASM call | 200ms poll | Component values for selected entity |

Cost budget: entity list is zero-cost (piggybacks on SystemViews). Selected entity poll: ~1 WASM call / 200ms, ~300 bytes TLV. Full entity list refresh (on filter change): `engine_debug_list_entities` at 100k entities = 400KB — acceptable for on-demand, not per-frame.

Plugin: `@hyperion-plugin/devtools`. Toggle via `F12` key or `engine.debug.toggleInspector()`. Dark theme, positioned top-right (configurable).

### Delivery Order (10a)

1. SystemViews integration (core API change, gates everything)
2. WASM debug exports (3 functions)
3. Debug Camera Plugin (quick win)
4. ECS Inspector Panel (depends on 1 + 2)

---

## 4. Sub-phase 10b — Authoring & Assets

**Goal:** Give developers hands — author content efficiently.
**Deliverables:** Prefabs, Asset Pipeline, Bounds Visualizer

### 4.1 Prefabs & Declarative Scene Composition

TS-only abstraction. No WASM changes. Calls existing fluent `EntityHandle` API under the hood.

```typescript
interface PrefabTemplate {
  root: PrefabNode;
  children?: Record<string, PrefabNode>;  // flat, one level (v1 limitation)
}

interface PrefabNode {
  position?: [number, number, number];
  velocity?: [number, number, number];
  scale?: number | [number, number, number];
  rotation?: number;
  texture?: TextureHandle;
  primitive?: RenderPrimitiveType;
  primParams?: Record<string, number>;  // named keys via PRIM_PARAMS_SCHEMA
  mesh?: number;
  data?: Record<string, unknown>;
}
```

**Known v1 limitation:** `children` is flat (one level). Nested prefabs (child template containing its own `children`) deferred.

**PRIM_PARAMS_SCHEMA:** Shared `Record<RenderPrimitiveType, Record<string, number>>` — single source of truth for parameter name → float index mapping. Used by both PrefabRegistry and EntityHandle convenience methods (`.boxShadow()`, `.gradient()`, etc.).

**PrefabRegistry** on `Hyperion` facade:

```typescript
engine.prefabs.register('Orc', { ... });
const orc = engine.prefabs.spawn('Orc', { x: 100, y: 200 });

orc.root;                    // EntityHandle (root)
orc.child('shadow');         // EntityHandle (named child)
orc.moveTo(x, y);           // Sugar for orc.root.position(x, y, z)
orc.destroyAll();            // Despawn root + children
```

`moveTo(x, y)` is `this.root.position(x, y, z)` — scene graph's `propagate_transforms` handles children automatically. Documented explicitly.

**Internals:** `spawn()` calls `engine.spawn()` per node, applies properties via fluent API, attaches children via `.parent()` (`SetParent` ring buffer command). Uses existing `EntityHandlePool`.

### 4.2 Asset Pipeline (Vite Plugin)

Build-time codegen: scan texture directory → generate typed TypeScript constants.

**`vite-plugin-hyperion-assets`:**

```typescript
// vite.config.ts
import { hyperionAssets } from 'vite-plugin-hyperion-assets';

export default {
  plugins: [
    hyperionAssets({
      textureDir: 'public/textures',
      outputFile: 'src/generated/assets.ts',
      watchMode: true,
    }),
  ],
};
```

**Generated output:**

```typescript
// AUTO-GENERATED, DO NOT EDIT
export const Textures = {
  OrcBody: { path: '/textures/orc-body.png', width: 128, height: 128 },
  Sword: { path: '/textures/sword.ktx2', width: 64, height: 64, compressed: true },
} as const;

export type TextureName = keyof typeof Textures;
```

Constants are **paths, not handles** — loading is async and can fail. Recommended pattern:

```typescript
import { Textures } from './generated/assets';

// Bulk load
const handles = await engine.loadTextures(
  Object.values(Textures).map(t => t.path)
);
// handles is Map<string, TextureHandle>

// Use in prefab
engine.prefabs.register('Orc', {
  root: { texture: handles.get(Textures.OrcBody.path)! },
});
```

**KTX2 in Node.js:** The Vite plugin runs at build time in Node.js. KTX2 header parsing uses direct `Buffer.readUInt32LE` over the 64-byte fixed header — does NOT use the browser runtime `KTX2Container` parser.

**Not in scope:** Atlas packing, sprite sheet generation, runtime asset management. This is a codegen tool for typed paths + metadata.

### 4.3 Debug Bounds Visualizer

**Approach:** Dedicated render pass via `PluginRenderingAPI.addPass()`. NOT entity-based — zero impact on entity budget.

**WASM export:** `engine_debug_generate_lines(vert_ptr, color_ptr, max_verts) → u32` — generates circle wireframe vertices (16-segment approximation per bounding sphere). Per-vertex color: green=active, red=out-of-frustum, yellow=inactive.

**TS side (part of `@hyperion-plugin/devtools`):**

1. `addPostTick` hook calls `engine_debug_generate_lines()` → fills vertex + color buffers
2. Uploads to a transient GPU buffer (recreated per frame if size changes)
3. Custom render pass draws line segments using existing line shader pipeline
4. Toggle via `F2` key or `engine.debug.toggleBounds()`

**Performance:** Frustum culling applied WASM-side — only visible entities generate lines. Configurable `maxEntities` cap (default 1000). Selected entity always included regardless of cap.

No entity lifecycle management, no pool pressure, no cleanup on toggle-off (just skip the render pass).

---

## 5. Sub-phase 10c — Dev Iteration

**Goal:** Give developers time control.
**Deliverables:** Command Tape L1, Snapshot Rewind L2, HMR State

### 5.1 Command Tape Replay (L1)

Record every ring buffer command. Replay from tick 0 for deterministic bug reproduction.

**TapeEntry (decomposed format):**

```typescript
interface TapeEntry {
  readonly tick: number;               // engine tick
  readonly timestamp: number;          // performance.now() — profiler correlation
  readonly type: CommandType;
  readonly entityId: number;
  readonly payload: Uint8Array;        // raw bytes, max 16
}

interface CommandTape {
  readonly version: 1;
  readonly tickRate: number;           // fixed timestep (1/60)
  readonly entries: TapeEntry[];
}
```

Decomposed format (not raw blob) for clean JSON export. Replay reconstructs binary on write: `[type: u8][entityId: u32 LE][payload]`.

**Recording:** Tap on `BackpressuredProducer` mirrors every command + current tick count + `performance.now()`. Per-entry cost: ~33 bytes.

**Capacity:** Count-based, not time-based. Default `maxEntries: 1_000_000` (~33MB). Circular buffer — oldest entries evicted. At steady-state 100-500 cmds/frame, covers 30-160 seconds. At spawn bursts (5k cmds/frame), covers ~3 seconds of burst. Command density varies wildly between games — count-based is the honest metric.

**Replay:**

1. `engine.debug.replayFromTick(0, tape)` calls `engine_reset()` (WASM)
2. `ReplayPlayer` replays tick-by-tick:
   - For tick N: write all entries where `entry.tick === N` into ring buffer (reconstructing binary)
   - Call `engine_update(FIXED_DT)` — one update per tick, in lockstep
   - Fire `replay:tick` event on EventBus (inspector/scrubber can subscribe)
3. Speed: 1x (real-time), 0.5x (slow-mo), instant (fast-forward to target tick)

**Determinism:** Fixed timestep + same commands in same order = identical ECS state. No external randomness in WASM (particle PRNG is GPU-side, outside ECS replay).

**Serialization:** `JSON.stringify(tape)` for sharing. Binary format (compact) deferred to v2.

### 5.2 Snapshot Rewind (L2)

Periodic ECS snapshots as keyframes. Seek to any tick by restoring nearest snapshot + replaying the gap.

**WASM exports:** `engine_snapshot_create() → Vec<u8>` (Rust-allocates, wasm-bindgen returns Uint8Array). `engine_snapshot_restore(data: &[u8]) → bool`. SnapshotManager copies the returned Uint8Array into its own buffer for storage.

**SpatialGrid:** Not serialized. Rebuilt from entity positions on `snapshot_restore()`. Avoids versioning internal grid structure.

**SnapshotManager:**

```typescript
interface SnapshotConfig {
  intervalTicks: number;    // default 300 (5 seconds at 60fps)
  maxSnapshots: number;     // default 60 (5 minutes), auto-scales: >50k entities → 20
  autoStart: boolean;       // default true when dev-tools enabled
}
```

- `postTick` hook: if `tick_count % intervalTicks === 0`, call `engine_snapshot_create()`, store in circular buffer
- Memory budget: 10k entities × ~200 bytes = ~2MB/snapshot × 60 = ~120MB. At 100k: ~20MB × 20 = ~400MB (auto-scaled cap).

**Rewind flow:**

```
engine.debug.seekToTick(49_500):
  1. Find nearest snapshot ≤ 49,500 (e.g., tick 49,800 — wait, nearest ≤)
  2. engine_snapshot_restore(snapshot at tick 49,200)
  3. For each tick T from 49,201 to 49,500:
     a. Write all tape entries where entry.tick === T into ring buffer
     b. Call engine_update(FIXED_DT)
  4. Pause engine — user inspects state
```

Depends on L1's CommandTape for replaying the gap between snapshot and target tick.

**Step-back API:**

```typescript
engine.debug.stepBack(10);       // rewind 10 ticks from current position
engine.debug.seekToTick(49_500); // absolute seek
```

### 5.3 HMR State Preservation

Helper that hooks into `import.meta.hot` to persist game-logic state across Vite HMR module replacement.

```typescript
import { createHotSystem } from 'hyperion/dev';

export const { state, system } = createHotSystem('enemy-ai', import.meta.hot, {
  initialState: () => ({ wave: 1, score: 0, spawnTimer: 0 }),
  preTick: (state, dt, views) => {
    state.spawnTimer += dt;
    if (state.spawnTimer >= 2.0) {
      state.spawnTimer = 0;
      state.wave++;
    }
  },
});

engine.systems.addPreTick('enemy-ai', system);
```

**Lifecycle during HMR:**

1. `hot.dispose()` fires on old module:
   - Calls `engine.systems.removePreTick(name)` to deregister old hook
   - Saves `state` to `hot.data[name]`
2. New module loads, calls `createHotSystem()`:
   - Detects `hot.data[name]` exists → restores state
   - Returns new `{ state, system }` — re-registered by calling code

Deregistration in `hot.dispose` is explicit because `createHotSystem` is a lightweight helper, not a full `HyperionPlugin` with install/cleanup lifecycle.

**State constraints:**

- Must be JSON-serializable (no class instances, no functions, no circular refs)
- Validated via `structuredClone` check on first save — console warning on failure
- Schema evolution: `{ ...initialState(), ...savedState }` — new fields get defaults, removed fields dropped

**Production:** `import.meta.hot` is `undefined` outside Vite dev mode. `createHotSystem` returns a plain system with no HMR wiring. Zero overhead — tree-shaken completely.

---

## 6. Sub-phase Summary

| Sub-phase | Features | WASM changes | New packages |
|---|---|---|---|
| **10a** Foundations & Introspection | SystemViews, Debug Camera, ECS Inspector (WASM + panel) | 4 exports (reset, entity_count, list_entities, get_components) | `@hyperion-plugin/debug-camera`, `@hyperion-plugin/devtools` |
| **10b** Authoring & Assets | Prefabs, Asset Pipeline, Bounds Visualizer | 1 export (generate_lines) | `vite-plugin-hyperion-assets` |
| **10c** Dev Iteration | Command Tape L1, Snapshot Rewind L2, HMR State | 2 exports (snapshot_create, snapshot_restore) | `@hyperion-plugin/replay` |

**Total WASM exports:** 7 (all dev-tools gated)
**Total new packages:** 4

---

## 7. Dependency Graph

```
SystemViews ────→ ECS Inspector Panel
                     ↕ (click-to-select)
                  Bounds Visualizer (same devtools package)

WASM debug exports ─→ ECS Inspector Panel
                   ─→ Bounds Visualizer

Command Tape (L1) ─→ Snapshot Rewind (L2)  [L2 replays gap via L1's tape]

Prefabs ────→ (none, standalone)
Asset Pipeline ────→ (none, standalone, build-time)
Debug Camera ────→ (none, standalone)
HMR State ────→ (none, standalone, depends on PluginSystemsAPI.removePreTick existing)
```

No circular dependencies. All three sub-phases are independently shippable.
