# Phase 10 DX — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add developer experience features: SystemViews, ECS Inspector, Debug Camera, Prefabs, Asset Pipeline, Bounds Visualizer, Time-Travel Debugging, and HMR State Preservation.

**Architecture:** 3 sub-phases (10a/10b/10c), each independently shippable. 7 new WASM exports behind `#[cfg(feature = "dev-tools")]`. 4 new npm packages. All debug features have zero production overhead via feature flags and tree-shaking.

**Tech Stack:** Rust (hecs, bytemuck, wasm-bindgen), TypeScript (vitest, Vite plugin API), WGSL shaders, WebGPU

**Design doc:** `docs/plans/2026-02-26-phase10-dx-design.md`

---

## Sub-phase 10a — Foundations & Introspection

---

### Task 1: Add `dev-tools` Cargo Feature Flag

**Files:**
- Modify: `crates/hyperion-core/Cargo.toml`

**Step 1: Add feature flag to Cargo.toml**

In `crates/hyperion-core/Cargo.toml`, add a `[features]` section (if not present) with:

```toml
[features]
default = []
dev-tools = []
```

**Step 2: Verify it compiles with and without the feature**

Run: `cargo build -p hyperion-core`
Expected: success (no feature = production build)

Run: `cargo build -p hyperion-core --features dev-tools`
Expected: success (dev build)

**Step 3: Commit**

```bash
git add crates/hyperion-core/Cargo.toml
git commit -m "feat(dx): add dev-tools Cargo feature flag for Phase 10 DX"
```

---

### Task 2: Create SystemViews Interface

**Files:**
- Create: `ts/src/system-views.ts`
- Test: `ts/src/system-views.test.ts`

**Step 1: Create the SystemViews interface**

Create `ts/src/system-views.ts`:

```typescript
/**
 * Read-only typed views into the GPU SoA buffers produced by collect_gpu().
 * Views reflect the most recent GPURenderState delivered from WASM,
 * which updates once per tick cycle. Both preTick and postTick see the
 * same snapshot — views do NOT reflect the current tick's changes.
 *
 * entityIds is always populated regardless of picking state.
 */
export interface SystemViews {
  readonly entityCount: number;
  readonly transforms: Float32Array;   // 16 f32/entity (model matrix, col-major)
  readonly bounds: Float32Array;       // 4 f32/entity (xyz + radius)
  readonly texIndices: Uint32Array;    // 1 u32/entity
  readonly renderMeta: Uint32Array;    // 2 u32/entity (meshHandle + renderPrimitive)
  readonly primParams: Float32Array;   // 8 f32/entity
  readonly entityIds: Uint32Array;     // 1 u32/entity (external IDs, always populated)
}
```

**Step 2: Write the test**

Create `ts/src/system-views.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { SystemViews } from './system-views';

describe('SystemViews', () => {
  it('interface has all required fields', () => {
    const views: SystemViews = {
      entityCount: 3,
      transforms: new Float32Array(48),
      bounds: new Float32Array(12),
      texIndices: new Uint32Array(3),
      renderMeta: new Uint32Array(6),
      primParams: new Float32Array(24),
      entityIds: new Uint32Array(3),
    };
    expect(views.entityCount).toBe(3);
    expect(views.transforms.length).toBe(48);
    expect(views.bounds.length).toBe(12);
    expect(views.entityIds.length).toBe(3);
  });
});
```

**Step 3: Run test**

Run: `cd ts && npx vitest run src/system-views.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add ts/src/system-views.ts ts/src/system-views.test.ts
git commit -m "feat(dx): add SystemViews interface for SoA read access"
```

---

### Task 3: Update GameLoop to Pass SystemViews Through Hooks

**Files:**
- Modify: `ts/src/game-loop.ts` (lines 3-5 types, lines 125-130 dispatch)
- Test: `ts/src/game-loop.test.ts`

**Step 1: Update HookFn type in game-loop.ts**

Change line 4 from:
```typescript
export type HookFn = (dt: number) => void;
```
to:
```typescript
import type { SystemViews } from './system-views';
export type HookFn = (dt: number, views?: SystemViews) => void;
```

**Step 2: Add `setSystemViews` method and update dispatch**

Add to `GameLoop` class:

```typescript
private _systemViews: SystemViews | null = null;

setSystemViews(views: SystemViews | null): void {
  this._systemViews = views;
}
```

Update hook dispatch (lines 125-130) to pass views:

```typescript
if (!this._paused) {
  const v = this._systemViews ?? undefined;
  for (const fn of this.hooks.preTick)  fn(dt, v);
  this.tickFn(dt);
  for (const fn of this.hooks.postTick) fn(dt, v);
  for (const fn of this.hooks.frameEnd) fn(dt, v);
}
```

**Step 3: Write test for SystemViews passing**

Add to `ts/src/game-loop.test.ts`:

```typescript
import type { SystemViews } from './system-views';

describe('GameLoop SystemViews', () => {
  it('passes SystemViews as second argument to hooks', () => {
    let received: SystemViews | undefined;
    const hook = (_dt: number, views?: SystemViews) => { received = views; };
    const loop = new GameLoop(() => {});
    loop.addHook('preTick', hook);

    const views: SystemViews = {
      entityCount: 1,
      transforms: new Float32Array(16),
      bounds: new Float32Array(4),
      texIndices: new Uint32Array(1),
      renderMeta: new Uint32Array(2),
      primParams: new Float32Array(8),
      entityIds: new Uint32Array(1),
    };
    loop.setSystemViews(views);
    // Trigger frame via existing test pattern
  });
});
```

**Step 4: Run tests**

Run: `cd ts && npx vitest run src/game-loop.test.ts`
Expected: All existing tests PASS (backward compatible — `views` is optional)

**Step 5: Commit**

```bash
git add ts/src/game-loop.ts ts/src/game-loop.test.ts
git commit -m "feat(dx): extend HookFn to accept optional SystemViews"
```

---

### Task 4: Wire SystemViews from GPURenderState in Hyperion.tick()

**Files:**
- Modify: `ts/src/hyperion.ts` (lines 519-538, `tick()` method)
- Test: `ts/src/hyperion.test.ts`

**Step 1: Build SystemViews from GPURenderState in tick()**

In `hyperion.ts`, in the `tick()` method, after `this.bridge.tick(dt)`, update the GameLoop's system views:

```typescript
private tick(dt: number): void {
  this.bridge.commandBuffer.setListenerPosition(this.cameraApi.x, this.cameraApi.y, 0);
  this.bridge.tick(dt);
  const state = this.bridge.latestRenderState;

  // Update SystemViews for plugin hooks
  if (state) {
    this.loop.setSystemViews({
      entityCount: state.entityCount,
      transforms: state.transforms,
      bounds: state.bounds,
      texIndices: state.texIndices,
      renderMeta: state.renderMeta,
      primParams: state.primParams,
      entityIds: state.entityIds,
    });
  }

  // ... rest of tick unchanged
}
```

Note: preTick hooks see the **previous frame's** views (correct semantic per design doc).

**Step 2: Write test**

Add to `ts/src/hyperion.test.ts`:

```typescript
describe('Hyperion SystemViews', () => {
  it('sets SystemViews on GameLoop from GPURenderState', () => {
    const bridge = mockBridge();
    bridge.latestRenderState = {
      entityCount: 2,
      transforms: new Float32Array(32),
      bounds: new Float32Array(8),
      renderMeta: new Uint32Array(4),
      texIndices: new Uint32Array(2),
      primParams: new Float32Array(16),
      entityIds: new Uint32Array([10, 20]),
      listenerX: 0, listenerY: 0, listenerZ: 0,
      tickCount: 1,
    };
    const engine = Hyperion.fromParts(mockConfig(), bridge, null);
    // Verify GameLoop.setSystemViews is called during tick
  });
});
```

**Step 3: Run tests**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(dx): wire SystemViews from GPURenderState into GameLoop hooks"
```

---

### Task 5: Export SystemViews from Barrel

**Files:**
- Modify: `ts/src/index.ts`

**Step 1: Add export**

```typescript
export type { SystemViews } from './system-views';
```

**Step 2: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add ts/src/index.ts
git commit -m "feat(dx): export SystemViews from barrel"
```

---

### Task 6: Debug Camera Plugin

**Files:**
- Create: `ts/src/debug/debug-camera.ts`
- Test: `ts/src/debug/debug-camera.test.ts`

**Step 1: Write the failing test**

Create `ts/src/debug/debug-camera.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { debugCameraPlugin } from './debug-camera';

function mockPluginContext() {
  return {
    engine: {
      input: {
        isKeyDown: vi.fn(() => false),
        onKey: vi.fn(() => () => {}),
        onScroll: vi.fn(() => () => {}),
      },
      cam: { position: vi.fn(), x: 0, y: 0, zoomLevel: 1, zoom: vi.fn() },
    },
    systems: {
      addPreTick: vi.fn(), removePreTick: vi.fn(),
      addPostTick: vi.fn(), removePostTick: vi.fn(),
      addFrameEnd: vi.fn(), removeFrameEnd: vi.fn(),
    },
    events: { on: vi.fn(), off: vi.fn(), once: vi.fn(), emit: vi.fn() },
    rendering: null, gpu: null,
    storage: { createMap: vi.fn(), getMap: vi.fn(), destroyAll: vi.fn() },
  } as any;
}

describe('debugCameraPlugin', () => {
  it('has correct name and version', () => {
    const plugin = debugCameraPlugin();
    expect(plugin.name).toBe('debug-camera');
    expect(plugin.version).toBeDefined();
  });

  it('registers a preTick hook on install', () => {
    const ctx = mockPluginContext();
    debugCameraPlugin().install(ctx);
    expect(ctx.systems.addPreTick).toHaveBeenCalled();
  });

  it('returns cleanup function that removes hooks', () => {
    const ctx = mockPluginContext();
    const cleanup = debugCameraPlugin().install(ctx);
    expect(typeof cleanup).toBe('function');
    cleanup!();
    expect(ctx.systems.removePreTick).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/debug/debug-camera.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement debug-camera.ts**

Create `ts/src/debug/debug-camera.ts`:

```typescript
import type { HyperionPlugin, PluginCleanup } from '../plugin';
import type { PluginContext } from '../plugin-context';
import type { HookFn } from '../game-loop';

export interface DebugCameraOptions {
  moveSpeed?: number;
  zoomSpeed?: number;
  enableKey?: string;
}

export function debugCameraPlugin(options?: DebugCameraOptions): HyperionPlugin {
  const moveSpeed = options?.moveSpeed ?? 300;
  const zoomSpeed = options?.zoomSpeed ?? 0.1;
  const enableKey = options?.enableKey ?? 'F1';

  return {
    name: 'debug-camera',
    version: '1.0.0',

    install(ctx: PluginContext): PluginCleanup {
      const engine = ctx.engine as {
        input: {
          isKeyDown(code: string): boolean;
          onKey(code: string, fn: (code: string) => void): () => void;
          onScroll(fn: (dx: number, dy: number) => void): () => void;
        };
        cam: {
          position(x: number, y: number, z: number): void;
          x: number; y: number; zoomLevel: number;
          zoom(level: number): void;
        };
      };

      let enabled = true;
      let camX = engine.cam.x;
      let camY = engine.cam.y;

      const unsubKey = engine.input.onKey(enableKey, () => { enabled = !enabled; });
      const unsubScroll = engine.input.onScroll((_dx, dy) => {
        if (!enabled) return;
        engine.cam.zoom(engine.cam.zoomLevel * (1 - dy * zoomSpeed));
      });

      const hook: HookFn = (dt) => {
        if (!enabled) return;
        let dx = 0, dy = 0;
        if (engine.input.isKeyDown('KeyW') || engine.input.isKeyDown('ArrowUp'))    dy += moveSpeed * dt;
        if (engine.input.isKeyDown('KeyS') || engine.input.isKeyDown('ArrowDown'))  dy -= moveSpeed * dt;
        if (engine.input.isKeyDown('KeyA') || engine.input.isKeyDown('ArrowLeft'))  dx -= moveSpeed * dt;
        if (engine.input.isKeyDown('KeyD') || engine.input.isKeyDown('ArrowRight')) dx += moveSpeed * dt;
        if (dx !== 0 || dy !== 0) {
          camX += dx;
          camY += dy;
          engine.cam.position(camX, camY, 0);
        }
      };

      ctx.systems.addPreTick(hook);

      return () => {
        ctx.systems.removePreTick(hook);
        unsubKey();
        unsubScroll();
      };
    },
  };
}
```

**Step 4: Run tests**

Run: `cd ts && npx vitest run src/debug/debug-camera.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add ts/src/debug/debug-camera.ts ts/src/debug/debug-camera.test.ts
git commit -m "feat(dx): add debug camera plugin with WASD + zoom"
```

---

### Task 7: ECS Inspector — WASM Debug Exports (Rust)

**Files:**
- Modify: `crates/hyperion-core/src/engine.rs` (add debug methods)
- Modify: `crates/hyperion-core/src/lib.rs` (add WASM exports)

**Step 1: Write failing Rust tests**

Add to `engine.rs` in `#[cfg(test)] mod tests`:

```rust
#[test]
fn debug_entity_count_returns_active_count() {
    let mut engine = Engine::new();
    assert_eq!(engine.debug_entity_count(), 0);
    let cmds = vec![spawn_cmd(0), spawn_cmd(1), spawn_cmd(2)];
    engine.process_commands(&cmds);
    assert_eq!(engine.debug_entity_count(), 3);
}

#[test]
fn debug_list_entities_returns_all_mapped_ids() {
    let mut engine = Engine::new();
    engine.process_commands(&[spawn_cmd(0), spawn_cmd(1), spawn_cmd(2)]);
    let mut out = vec![0u32; 10];
    let count = engine.debug_list_entities(&mut out, false);
    assert_eq!(count, 3);
    let mut ids: Vec<u32> = out[..count as usize].to_vec();
    ids.sort();
    assert_eq!(ids, vec![0, 1, 2]);
}

#[test]
fn debug_get_components_returns_tlv_data() {
    let mut engine = Engine::new();
    engine.process_commands(&[spawn_cmd(0), make_position_cmd(0, 5.0, 10.0, 15.0)]);
    engine.update(1.0 / 60.0);
    let mut out = vec![0u8; 1024];
    let bytes_written = engine.debug_get_components(0, &mut out);
    assert!(bytes_written > 0);
    // First TLV entry is decodable
    let comp_type = out[0];
    let data_len = u16::from_le_bytes([out[1], out[2]]) as usize;
    assert!(comp_type >= 1 && comp_type <= 15);
    assert!(data_len > 0);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p hyperion-core --features dev-tools debug_entity_count`
Expected: FAIL (method not found)

**Step 3: Implement debug methods on Engine**

Add to `engine.rs`, gated behind `#[cfg(feature = "dev-tools")]`:

- `debug_entity_count(&self) -> u32` — calls `count_active(&self.world)`
- `debug_list_entities(&self, out: &mut [u32], active_only: bool) -> u32` — iterates `entity_map.iter_mapped()`, optionally filters by Active component
- `debug_get_components(&self, external_id: u32, out: &mut [u8]) -> u32` — TLV serialization using `bytemuck::bytes_of()` for Pod components, manual serialization for Parent/Children

Component type IDs: Position=1, Velocity=2, Rotation=3, Scale=4, ModelMatrix=5, BoundingRadius=6, TextureLayerIndex=7, MeshHandle=8, RenderPrimitive=9, Parent=10, Active=11, ExternalId=12, PrimitiveParams=13, LocalMatrix=14, Children=15.

**Step 4: Add WASM exports in lib.rs** (all gated with `#[cfg(feature = "dev-tools")]`)

- `engine_debug_entity_count() -> u32`
- `engine_debug_list_entities(out_ptr: *mut u32, out_len: u32, flags: u32) -> u32`
- `engine_debug_get_components(entity_id: u32, out_ptr: *mut u8, out_len: u32) -> u32`

**Step 5: Run tests**

Run: `cargo test -p hyperion-core --features dev-tools`
Expected: All PASS

Run: `cargo clippy -p hyperion-core --features dev-tools`
Expected: No warnings

**Step 6: Commit**

```bash
git add crates/hyperion-core/src/engine.rs crates/hyperion-core/src/lib.rs
git commit -m "feat(dx): add ECS inspector WASM debug exports"
```

---

### Task 8: ECS Inspector — TLV Parser (TypeScript)

**Files:**
- Create: `ts/src/debug/tlv-parser.ts`
- Test: `ts/src/debug/tlv-parser.test.ts`

**Step 1: Write the failing test**

Create `ts/src/debug/tlv-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseTLV, COMPONENT_NAMES } from './tlv-parser';

describe('TLV Parser', () => {
  it('parses a single Position component', () => {
    const buf = new Uint8Array(15);
    buf[0] = 1; // Position
    buf[1] = 12; buf[2] = 0; // len=12 LE
    const dv = new DataView(buf.buffer);
    dv.setFloat32(3, 5.0, true);
    dv.setFloat32(7, 10.0, true);
    dv.setFloat32(11, 15.0, true);
    const components = parseTLV(buf);
    expect(components).toHaveLength(1);
    expect(components[0].type).toBe(1);
    expect(components[0].name).toBe('Position');
    expect(components[0].values).toEqual({ x: 5, y: 10, z: 15 });
  });

  it('parses Active marker (zero-length data)', () => {
    const buf = new Uint8Array(3);
    buf[0] = 11; buf[1] = 0; buf[2] = 0;
    const components = parseTLV(buf);
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('Active');
  });

  it('parses multiple components sequentially', () => {
    const buf = new Uint8Array(18);
    buf[0] = 1; buf[1] = 12; buf[2] = 0;
    const dv = new DataView(buf.buffer);
    dv.setFloat32(3, 1.0, true);
    dv.setFloat32(7, 2.0, true);
    dv.setFloat32(11, 3.0, true);
    buf[15] = 11; buf[16] = 0; buf[17] = 0;
    const components = parseTLV(buf);
    expect(components).toHaveLength(2);
  });

  it('COMPONENT_NAMES covers all types 1-15', () => {
    for (let i = 1; i <= 15; i++) {
      expect(COMPONENT_NAMES[i]).toBeDefined();
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/debug/tlv-parser.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement tlv-parser.ts**

Create `ts/src/debug/tlv-parser.ts` with:
- `COMPONENT_NAMES` record mapping type IDs 1-15 to string names
- `ParsedComponent` interface: `{ type, name, values }`
- `parseTLV(data: Uint8Array): ParsedComponent[]` — walks the buffer, decodes each TLV entry based on type

Decode logic per type: Position/Velocity/Scale as {x,y,z}, Rotation as {x,y,z,w}, BoundingRadius as {radius}, MeshHandle/TextureLayerIndex as {value}, Active as {}, Children as {count, childIds}, etc.

**Step 4: Run tests**

Run: `cd ts && npx vitest run src/debug/tlv-parser.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add ts/src/debug/tlv-parser.ts ts/src/debug/tlv-parser.test.ts
git commit -m "feat(dx): add TLV parser for ECS inspector component data"
```

---

### Task 9: ECS Inspector — Visual Panel Plugin

**Files:**
- Create: `ts/src/debug/ecs-inspector.ts`
- Test: `ts/src/debug/ecs-inspector.test.ts`

**Step 1: Write the test**

Test the plugin contract (name, install, cleanup). DOM rendering is tested manually via `npm run dev`.

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ecsInspectorPlugin } from './ecs-inspector';

describe('ECS Inspector Plugin', () => {
  it('has correct name and version', () => {
    expect(ecsInspectorPlugin().name).toBe('ecs-inspector');
  });

  it('install returns cleanup function', () => {
    const ctx = mockCtx();
    const cleanup = ecsInspectorPlugin().install(ctx);
    expect(typeof cleanup).toBe('function');
  });

  it('registers postTick hook on install', () => {
    const ctx = mockCtx();
    ecsInspectorPlugin().install(ctx);
    expect(ctx.systems.addPostTick).toHaveBeenCalled();
  });
});

function mockCtx() {
  return {
    engine: {
      input: { onKey: vi.fn(() => () => {}) },
      selection: { select: vi.fn(), deselect: vi.fn(), selectedIds: vi.fn(() => new Set()) },
    },
    systems: {
      addPreTick: vi.fn(), removePreTick: vi.fn(),
      addPostTick: vi.fn(), removePostTick: vi.fn(),
      addFrameEnd: vi.fn(), removeFrameEnd: vi.fn(),
    },
    events: { on: vi.fn(), off: vi.fn(), once: vi.fn(), emit: vi.fn() },
    rendering: null, gpu: null,
    storage: { createMap: vi.fn(), getMap: vi.fn(), destroyAll: vi.fn() },
  } as any;
}
```

**Step 2: Implement ecs-inspector.ts**

The plugin creates an HTML overlay panel on first toggle (F12). Uses dual data channels:
- Fast path: reads `SystemViews.entityIds` every frame for entity list
- Slow path: polls WASM `debug_get_components()` every 200ms for selected entity detail

DOM construction uses `document.createElement` + `textContent` for text (no innerHTML with untrusted content). Panel styling via inline `style.cssText`.

**Step 3: Run tests, commit**

```bash
git add ts/src/debug/ecs-inspector.ts ts/src/debug/ecs-inspector.test.ts
git commit -m "feat(dx): add ECS inspector plugin with HTML overlay panel"
```

---

### Task 10: Run Full Validation for Sub-phase 10a

**Step 1:** `cargo test -p hyperion-core --features dev-tools` — All pass
**Step 2:** `cargo clippy -p hyperion-core --features dev-tools` — No warnings
**Step 3:** `cd ts && npm test` — All pass
**Step 4:** `cd ts && npx tsc --noEmit` — No errors

**Step 5: Commit milestone**

```bash
git commit --allow-empty -m "milestone: Phase 10a (Foundations & Introspection) complete"
```

---

## Sub-phase 10b — Authoring & Assets

---

### Task 11: PRIM_PARAMS_SCHEMA Shared Constant

**Files:**
- Create: `ts/src/prim-params-schema.ts`
- Test: `ts/src/prim-params-schema.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { PRIM_PARAMS_SCHEMA } from './prim-params-schema';
import { RenderPrimitiveType } from './entity-handle';

describe('PRIM_PARAMS_SCHEMA', () => {
  it('maps BoxShadow parameter names to float indices', () => {
    const s = PRIM_PARAMS_SCHEMA[RenderPrimitiveType.BoxShadow];
    expect(s.rectW).toBe(0);
    expect(s.rectH).toBe(1);
    expect(s.cornerRadius).toBe(2);
    expect(s.blur).toBe(3);
  });

  it('maps Line parameters', () => {
    const s = PRIM_PARAMS_SCHEMA[RenderPrimitiveType.Line];
    expect(s.x0).toBe(0);
    expect(s.y0).toBe(1);
  });

  it('has entries for all parameterized primitive types', () => {
    expect(PRIM_PARAMS_SCHEMA[RenderPrimitiveType.Line]).toBeDefined();
    expect(PRIM_PARAMS_SCHEMA[RenderPrimitiveType.Gradient]).toBeDefined();
    expect(PRIM_PARAMS_SCHEMA[RenderPrimitiveType.BoxShadow]).toBeDefined();
    expect(PRIM_PARAMS_SCHEMA[RenderPrimitiveType.BezierPath]).toBeDefined();
  });
});
```

**Step 2: Implement**

Create `ts/src/prim-params-schema.ts`. Extract parameter ordering from `entity-handle.ts` lines 153-190 (the `.line()`, `.gradient()`, `.boxShadow()`, `.bezier()` methods define the float array layout).

```typescript
export const PRIM_PARAMS_SCHEMA: Record<number, Record<string, number>> = {
  // Line: x0, y0, x1, y1, width (from entity-handle.ts line 153)
  1: { x0: 0, y0: 1, x1: 2, y1: 3, width: 4 },
  // Gradient: type, angle, p0-p5 (from entity-handle.ts line 162)
  4: { type: 0, angle: 1, r0: 2, g0: 3, b0: 4, a0: 5, r1: 6, g1: 7 },
  // BoxShadow: rectW, rectH, cornerRadius, blur, r, g, b, a (from entity-handle.ts line 171)
  5: { rectW: 0, rectH: 1, cornerRadius: 2, blur: 3, r: 4, g: 5, b: 6, a: 7 },
  // BezierPath: p0x, p0y, p1x, p1y, p2x, p2y, width (from entity-handle.ts line 181)
  3: { p0x: 0, p0y: 1, p1x: 2, p1y: 3, p2x: 4, p2y: 5, width: 6 },
};
```

**Step 3: Run tests, commit**

```bash
git add ts/src/prim-params-schema.ts ts/src/prim-params-schema.test.ts
git commit -m "feat(dx): add PRIM_PARAMS_SCHEMA shared constant"
```

---

### Task 12: PrefabRegistry & PrefabInstance

**Files:**
- Create: `ts/src/prefab/prefab-types.ts`
- Create: `ts/src/prefab/prefab-registry.ts`
- Test: `ts/src/prefab/prefab-registry.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { PrefabRegistry } from './prefab-registry';

function mockEngine() {
  let nextId = 0;
  return {
    spawn: vi.fn(() => {
      const id = nextId++;
      return {
        id, position: vi.fn().mockReturnThis(), velocity: vi.fn().mockReturnThis(),
        scale: vi.fn().mockReturnThis(), rotation: vi.fn().mockReturnThis(),
        texture: vi.fn().mockReturnThis(), primitive: vi.fn().mockReturnThis(),
        mesh: vi.fn().mockReturnThis(), parent: vi.fn().mockReturnThis(),
        data: vi.fn().mockReturnThis(), destroy: vi.fn(),
      };
    }),
  };
}

describe('PrefabRegistry', () => {
  it('registers and spawns a prefab with children', () => {
    const eng = mockEngine();
    const reg = new PrefabRegistry(eng as any);
    reg.register('Test', {
      root: { position: [1, 2, 3] },
      children: { child1: { position: [4, 5, 6] } },
    });
    const inst = reg.spawn('Test', { x: 10, y: 20 });
    expect(inst.root).toBeDefined();
    expect(inst.child('child1')).toBeDefined();
    expect(eng.spawn).toHaveBeenCalledTimes(2);
  });

  it('destroyAll despawns all handles', () => {
    const eng = mockEngine();
    const reg = new PrefabRegistry(eng as any);
    reg.register('Test', { root: {}, children: { c: {} } });
    const inst = reg.spawn('Test');
    inst.destroyAll();
    // Both root and child destroy called
  });

  it('throws on unregistered template', () => {
    const reg = new PrefabRegistry({} as any);
    expect(() => reg.spawn('Nope')).toThrow('not registered');
  });

  it('throws on duplicate registration', () => {
    const reg = new PrefabRegistry({} as any);
    reg.register('X', { root: {} });
    expect(() => reg.register('X', { root: {} })).toThrow('already registered');
  });

  it('moveTo delegates to root.position', () => {
    const eng = mockEngine();
    const reg = new PrefabRegistry(eng as any);
    reg.register('T', { root: {} });
    const inst = reg.spawn('T');
    inst.moveTo(50, 60);
    expect(inst.root.position).toHaveBeenCalledWith(50, 60, 0);
  });
});
```

**Step 2: Implement prefab-types.ts and prefab-registry.ts**

See design doc Section 4.1 for interfaces. `PrefabRegistry` takes an engine reference with a `spawn()` method. `spawn()` creates EntityHandles for root + children, applies properties, parents children via `.parent()`.

Known v1 limitation: flat children only (one level).

**Step 3: Run tests, commit**

```bash
git add ts/src/prefab/prefab-types.ts ts/src/prefab/prefab-registry.ts ts/src/prefab/prefab-registry.test.ts
git commit -m "feat(dx): add PrefabRegistry with template registration and spawn"
```

---

### Task 13: Wire PrefabRegistry into Hyperion Facade

**Files:**
- Modify: `ts/src/hyperion.ts`
- Test: `ts/src/hyperion.test.ts`

**Step 1: Add `prefabs` getter to Hyperion**

```typescript
import { PrefabRegistry } from './prefab/prefab-registry';

// In the class body:
private _prefabs: PrefabRegistry | null = null;

get prefabs(): PrefabRegistry {
  if (!this._prefabs) this._prefabs = new PrefabRegistry(this);
  return this._prefabs;
}
```

**Step 2: Write test**

```typescript
it('exposes prefabs registry', () => {
  const engine = Hyperion.fromParts(mockConfig(), mockBridge(), null);
  expect(engine.prefabs).toBeInstanceOf(PrefabRegistry);
  expect(engine.prefabs).toBe(engine.prefabs); // same instance
});
```

**Step 3: Run tests, commit**

```bash
git commit -m "feat(dx): expose prefabs on Hyperion facade"
```

---

### Task 14: Asset Pipeline — Codegen Function

**Files:**
- Create: `ts/src/asset-pipeline/asset-scanner.ts`
- Test: `ts/src/asset-pipeline/asset-scanner.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect } from 'vitest';
import { generateAssetConstants } from './asset-scanner';

describe('generateAssetConstants', () => {
  it('generates typed constants from file metadata', () => {
    const files = [
      { relativePath: '/textures/orc-body.png', width: 128, height: 128, compressed: false },
      { relativePath: '/textures/sword.ktx2', width: 64, height: 64, compressed: true },
    ];
    const output = generateAssetConstants(files);
    expect(output).toContain('OrcBody');
    expect(output).toContain("path: '/textures/orc-body.png'");
    expect(output).toContain('width: 128');
    expect(output).toContain('as const');
    expect(output).toContain('AUTO-GENERATED');
  });

  it('converts file names to PascalCase keys', () => {
    const files = [{ relativePath: '/textures/my-cool-sprite.png', width: 32, height: 32, compressed: false }];
    const output = generateAssetConstants(files);
    expect(output).toContain('MyCoolSprite');
  });
});
```

**Step 2: Implement asset-scanner.ts**

Pure codegen function — takes array of file metadata, returns TypeScript source string. No filesystem access (that's the Vite plugin's job).

**Step 3: Run tests, commit**

```bash
git commit -m "feat(dx): add asset pipeline codegen function"
```

---

### Task 15: Asset Pipeline — Vite Plugin

**Files:**
- Create: `ts/src/asset-pipeline/vite-plugin.ts`

The Vite plugin scans a directory at `buildStart`, reads image dimensions (PNG header, JPEG header, KTX2 header via `Buffer.readUInt32LE`), and calls `generateAssetConstants()` to write the output file. In `configureServer`, watches the directory for add/remove events.

This is a Node.js build-time tool. Integration testing requires a Vite project — manual test via `npm run dev`.

```bash
git commit -m "feat(dx): add Vite plugin for typed texture asset pipeline"
```

---

### Task 16: Bounds Visualizer — WASM Export

**Files:**
- Modify: `crates/hyperion-core/src/engine.rs`
- Modify: `crates/hyperion-core/src/lib.rs`

**Step 1: Write failing Rust test**

```rust
#[test]
fn debug_generate_lines_produces_circle_vertices() {
    let mut engine = Engine::new();
    engine.process_commands(&[spawn_cmd(0), make_position_cmd(0, 10.0, 20.0, 0.0)]);
    engine.update(1.0 / 60.0);
    let mut verts = vec![0.0f32; 1000];
    let mut colors = vec![0.0f32; 1000];
    let count = engine.debug_generate_lines(&mut verts, &mut colors, 500);
    // 16-segment circle = 16 line segments = 32 vertices (start+end per segment)
    assert_eq!(count, 32);
}
```

**Step 2: Implement `debug_generate_lines` on Engine** (dev-tools gated)

For each active entity with `Position` and `BoundingRadius`, generate a 16-segment circle approximation. Each segment is 2 vertices (6 floats total: x1,y1,z1,x2,y2,z2). Per-vertex color: green (0,1,0,1) for active entities.

**Step 3: Add WASM export, run tests, commit**

```bash
git commit -m "feat(dx): add bounds visualizer WASM export (debug_generate_lines)"
```

---

### Task 17: Bounds Visualizer — Render Pass Plugin

**Files:**
- Create: `ts/src/debug/bounds-pass.ts`
- Create: `ts/src/debug/bounds-visualizer.ts`
- Test: `ts/src/debug/bounds-visualizer.test.ts`

The bounds pass implements `RenderPass` interface. Reads WASM-generated vertices, uploads to transient GPU buffer, draws line segments using existing line shader. Added via `PluginRenderingAPI.addPass()`.

The plugin toggles via F2. Part of `@hyperion-plugin/devtools`.

**Step 1: Write plugin contract test, implement, commit**

```bash
git commit -m "feat(dx): add bounds visualizer plugin with dedicated render pass"
```

---

### Task 18: Run Full Validation for Sub-phase 10b

**Step 1:** `cargo test -p hyperion-core --features dev-tools` — All pass
**Step 2:** `cargo clippy -p hyperion-core --features dev-tools` — No warnings
**Step 3:** `cd ts && npm test` — All pass
**Step 4:** `cd ts && npx tsc --noEmit` — No errors

```bash
git commit --allow-empty -m "milestone: Phase 10b (Authoring & Assets) complete"
```

---

## Sub-phase 10c — Dev Iteration

---

### Task 19: Command Tape — Recording Infrastructure

**Files:**
- Create: `ts/src/replay/command-tape.ts`
- Test: `ts/src/replay/command-tape.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { CommandTapeRecorder } from './command-tape';

describe('CommandTapeRecorder', () => {
  it('records entries and returns tape on stop', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 100 });
    rec.record({ tick: 5, timestamp: 1000.5, type: 3, entityId: 42, payload: new Uint8Array(12) });
    const tape = rec.stop();
    expect(tape.entries).toHaveLength(1);
    expect(tape.entries[0].tick).toBe(5);
    expect(tape.entries[0].entityId).toBe(42);
    expect(tape.entries[0].timestamp).toBe(1000.5);
  });

  it('circular buffer evicts oldest when full', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      rec.record({ tick: i, timestamp: i, type: 1, entityId: i, payload: new Uint8Array(0) });
    }
    const tape = rec.stop();
    expect(tape.entries).toHaveLength(3);
    expect(tape.entries[0].tick).toBe(2);
    expect(tape.entries[2].tick).toBe(4);
  });

  it('defaults to 1M maxEntries', () => {
    const rec = new CommandTapeRecorder();
    // Just verify it constructs without error
    expect(rec).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/replay/command-tape.test.ts`
Expected: FAIL

**Step 3: Implement command-tape.ts**

```typescript
export interface TapeEntry {
  readonly tick: number;
  readonly timestamp: number;    // performance.now()
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
  private maxEntries: number;
  private writeIdx = 0;
  private count = 0;

  constructor(config: { maxEntries?: number } = {}) {
    this.maxEntries = config.maxEntries ?? 1_000_000;
    this.buffer = new Array(this.maxEntries);
  }

  record(entry: TapeEntry): void {
    this.buffer[this.writeIdx] = entry;
    this.writeIdx = (this.writeIdx + 1) % this.maxEntries;
    if (this.count < this.maxEntries) this.count++;
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

**Step 4: Run tests, commit**

```bash
git add ts/src/replay/command-tape.ts ts/src/replay/command-tape.test.ts
git commit -m "feat(dx): add CommandTapeRecorder with circular buffer"
```

---

### Task 20: Recording Tap on BackpressuredProducer

**Files:**
- Modify: `ts/src/backpressure.ts`
- Test: `ts/src/backpressure.test.ts`

**Step 1: Add `setRecordingTap` method**

In `BackpressuredProducer`, add:

```typescript
private recordingTap: ((type: number, entityId: number, payload: Uint8Array) => void) | null = null;

setRecordingTap(tap: ((type: number, entityId: number, payload: Uint8Array) => void) | null): void {
  this.recordingTap = tap;
}
```

In the internal write path, after a successful command write, invoke the tap if set.

**Step 2: Write test**

```typescript
it('invokes recording tap on successful write', () => {
  const tap = vi.fn();
  producer.setRecordingTap(tap);
  producer.spawnEntity(1);
  expect(tap).toHaveBeenCalledWith(1, 1, expect.any(Uint8Array)); // type=SpawnEntity
});
```

**Step 3: Run tests, commit**

```bash
git commit -m "feat(dx): add recording tap to BackpressuredProducer"
```

---

### Task 21: Replay Player

**Files:**
- Create: `ts/src/replay/replay-player.ts`
- Test: `ts/src/replay/replay-player.test.ts`

**Step 1: Write test**

```typescript
describe('ReplayPlayer', () => {
  it('replays commands tick by tick', () => {
    const reset = vi.fn();
    const update = vi.fn();
    const write = vi.fn(() => true);
    const tape = {
      version: 1 as const, tickRate: 1/60,
      entries: [
        { tick: 0, timestamp: 0, type: 1, entityId: 0, payload: new Uint8Array(0) },
        { tick: 0, timestamp: 0, type: 3, entityId: 0, payload: new Uint8Array(12) },
        { tick: 1, timestamp: 16.67, type: 3, entityId: 0, payload: new Uint8Array(12) },
      ],
    };
    const player = new ReplayPlayer(tape, { reset, update, writeCommand: write });
    player.replayAll();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(2); // ticks 0 and 1
    expect(write).toHaveBeenCalledTimes(3);
  });
});
```

**Step 2: Implement — groups entries by tick, calls reset, then per tick writes commands and calls update(FIXED_DT)**

**Step 3: Run tests, commit**

```bash
git commit -m "feat(dx): add ReplayPlayer for deterministic command tape replay"
```

---

### Task 22: engine_reset WASM Export

**Files:**
- Modify: `crates/hyperion-core/src/engine.rs`
- Modify: `crates/hyperion-core/src/lib.rs`

**Step 1: Write failing Rust test**

```rust
#[test]
fn reset_clears_world_and_tick_count() {
    let mut engine = Engine::new();
    engine.process_commands(&[spawn_cmd(0), spawn_cmd(1)]);
    engine.update(1.0 / 60.0);
    assert!(engine.tick_count() > 0);
    engine.reset();
    assert_eq!(engine.tick_count(), 0);
    assert_eq!(count_active(&engine.world), 0);
}
```

**Step 2: Implement `reset()` on Engine** (dev-tools gated)

Reconstructs `Engine` to initial state: new World, new EntityMap, new RenderState, zero accumulator/tick_count/listener.

**Step 3: Add WASM export, run tests, commit**

```bash
git commit -m "feat(dx): add engine_reset WASM export for replay"
```

---

### Task 23: Snapshot Create/Restore

**Files:**
- Modify: `crates/hyperion-core/src/engine.rs`
- Modify: `crates/hyperion-core/src/lib.rs`

**Step 1: Write failing Rust test**

```rust
#[test]
fn snapshot_roundtrip_preserves_state() {
    let mut engine = Engine::new();
    engine.process_commands(&[spawn_cmd(0), make_position_cmd(0, 5.0, 10.0, 0.0)]);
    engine.update(1.0 / 60.0);
    let snapshot = engine.snapshot_create();
    assert!(!snapshot.is_empty());

    engine.process_commands(&[make_position_cmd(0, 999.0, 999.0, 0.0)]);
    engine.update(1.0 / 60.0);
    assert!(engine.snapshot_restore(&snapshot));

    let entity = engine.entity_map.get(0).unwrap();
    let pos = engine.world.get::<&Position>(entity).unwrap();
    assert!((pos.0.x - 5.0).abs() < 0.1);
}
```

**Step 2: Implement snapshot_create/snapshot_restore** (dev-tools gated)

Format: `[magic "HSNP"][version][tick][entity_count][entity_map][per-entity component_mask + data]`. Uses bytemuck for Pod components, manual for Parent/Children. SpatialGrid NOT serialized (rebuilt on restore).

**Step 3: Add wasm-bindgen exports** (`Vec<u8>` return for create, `&[u8]` input for restore)

**Step 4: Run tests, commit**

```bash
git commit -m "feat(dx): add snapshot create/restore for time-travel rewind"
```

---

### Task 24: SnapshotManager

**Files:**
- Create: `ts/src/replay/snapshot-manager.ts`
- Test: `ts/src/replay/snapshot-manager.test.ts`

Periodic capture in circular buffer. Auto-scales maxSnapshots when entityCount > 50k.

**Step 1: Write test, implement, commit**

```bash
git commit -m "feat(dx): add SnapshotManager with periodic capture"
```

---

### Task 25: Wire Time-Travel into Hyperion.debug API

**Files:**
- Modify: `ts/src/hyperion.ts`
- Test: `ts/src/hyperion.test.ts`

Add `engine.debug` with: `startRecording()`, `stopRecording()`, `replayFromTick()`, `seekToTick()`, `stepBack()`.

**Step 1: Write test, implement, commit**

```bash
git commit -m "feat(dx): wire time-travel into Hyperion.debug API"
```

---

### Task 26: HMR State Helper — createHotSystem

**Files:**
- Create: `ts/src/hmr/hot-system.ts`
- Test: `ts/src/hmr/hot-system.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createHotSystem } from './hot-system';

describe('createHotSystem', () => {
  it('returns initial state when no HMR data', () => {
    const { state } = createHotSystem('test', undefined, {
      initialState: () => ({ count: 0 }),
      preTick: (s) => { s.count++; },
    });
    expect(state.count).toBe(0);
  });

  it('restores state from HMR data', () => {
    const hot = { data: { test: { count: 42 } }, dispose: vi.fn() };
    const { state } = createHotSystem('test', hot as any, {
      initialState: () => ({ count: 0 }),
      preTick: () => {},
    });
    expect(state.count).toBe(42);
  });

  it('merges schema changes with spread', () => {
    const hot = { data: { test: { count: 42 } }, dispose: vi.fn() };
    const { state } = createHotSystem('test', hot as any, {
      initialState: () => ({ count: 0, name: 'default' }),
      preTick: () => {},
    });
    expect(state.count).toBe(42);
    expect(state.name).toBe('default');
  });

  it('dispose saves state and deregisters', () => {
    const disposeFns: Function[] = [];
    const hot = { data: {} as any, dispose: (fn: Function) => disposeFns.push(fn) };
    const { state } = createHotSystem('test', hot as any, {
      initialState: () => ({ count: 0 }),
      preTick: () => {},
    });
    state.count = 99;
    disposeFns[0]();
    expect(hot.data.test).toEqual({ count: 99 });
  });
});
```

**Step 2: Implement hot-system.ts**

`createHotSystem(name, hot, config)`:
- If `hot.data[name]` exists, merge with `initialState()` via spread
- Register `hot.dispose` that saves state to `hot.data[name]`
- Validate serializability via `structuredClone` on first dispose
- Return `{ state, system }` where system is a HookFn

When `hot` is `undefined` (production), returns plain system with no HMR wiring.

**Step 3: Run tests, commit**

```bash
git add ts/src/hmr/hot-system.ts ts/src/hmr/hot-system.test.ts
git commit -m "feat(dx): add createHotSystem HMR state preservation helper"
```

---

### Task 27: Export All New Public APIs from Barrel

**Files:**
- Modify: `ts/src/index.ts`

```typescript
export type { SystemViews } from './system-views';
export { PrefabRegistry } from './prefab/prefab-registry';
export type { PrefabTemplate, PrefabNode, PrefabInstance } from './prefab/prefab-types';
export { PRIM_PARAMS_SCHEMA } from './prim-params-schema';
export { debugCameraPlugin } from './debug/debug-camera';
export type { DebugCameraOptions } from './debug/debug-camera';
export { ecsInspectorPlugin } from './debug/ecs-inspector';
export { createHotSystem } from './hmr/hot-system';
export { CommandTapeRecorder } from './replay/command-tape';
export type { CommandTape, TapeEntry } from './replay/command-tape';
export { ReplayPlayer } from './replay/replay-player';
export { SnapshotManager } from './replay/snapshot-manager';
```

**Step 1: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 2: Commit**

```bash
git add ts/src/index.ts
git commit -m "feat(dx): export all Phase 10 DX public APIs from barrel"
```

---

### Task 28: Run Full Validation for Sub-phase 10c

**Step 1:** `cargo test -p hyperion-core --features dev-tools` — All pass
**Step 2:** `cargo clippy -p hyperion-core --features dev-tools` — No warnings
**Step 3:** `cd ts && npm test` — All pass
**Step 4:** `cd ts && npx tsc --noEmit` — No errors

```bash
git commit --allow-empty -m "milestone: Phase 10c (Dev Iteration) complete"
```

---

### Task 29: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

Add Phase 10 DX to Implementation Status table. Update test counts. Add new module descriptions. Document new WASM exports (dev-tools gated). Add new test commands. Document any gotchas discovered during implementation.

```bash
git commit -m "docs(phase10-dx): update CLAUDE.md for Phase 10 DX"
```

---

### Task 30: Final Phase 10 DX Milestone

```bash
git commit --allow-empty -m "milestone: Phase 10 DX complete — all 3 sub-phases shipped"
```
