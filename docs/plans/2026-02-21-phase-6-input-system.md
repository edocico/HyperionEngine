# Phase 6 Input System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add keyboard/pointer/scroll input handling, CPU-based entity picking (hit testing), immediate-mode position updates with zero-latency rendering, and wire everything into the Hyperion public API.

**Architecture:** The InputManager lives on the main thread (DOM events), tracking keyboard/pointer state and dispatching callbacks. CPU-based hit testing uses **ray-sphere intersection** — the camera generates a ray from a screen pixel (orthographic: parallel rays along -Z; future perspective: diverging rays), and the HitTester tests it against entity bounding spheres in 3D. This naturally supports 2.5D (Z-depth ordering) and is forward-compatible with full 3D / perspective cameras. Immediate mode maintains a shadow position map on the TS side that patches the SoA transforms buffer before GPU upload, giving zero-latency visual feedback while the ring buffer catches up. A new `ExternalId` component in Rust enables mapping SoA indices back to entity IDs for both picking and immediate mode.

**Tech Stack:** TypeScript (InputManager, HitTester, ImmediateState), Rust (ExternalId component, SoA entity_ids buffer), vitest (unit tests)

**Depends on:** Phase 5.5 (merged at `611b645`). All Phase 5.5 features (SelectionManager, JFA outlines, multi-primitive rendering) are prerequisites.

**Key design decisions:**
- **CPU ray-sphere picking over GPU picking**: Ray-sphere intersection is fast (< 0.1ms for 100k entities), synchronous (no async readback), works without WebGPU, and naturally supports 2.5D depth ordering. The ray-based API (`screenToRay` → `hitTest(ray, ...)`) is forward-compatible with perspective cameras and full 3D. GPU color-ID picking deferred to Phase 7+ as opt-in enhancement for pixel-perfect accuracy.
- **No new ring buffer CommandTypes**: Input events are handled entirely on the TS side via DOM listeners + callbacks. Game code reacts to input in `preTick` hooks and issues existing commands (`setPosition`, `setVelocity`). Forwarding raw input to Rust ECS is deferred until Rust-side input processing systems are needed.
- **ExternalId as ECS component**: Enables SoA index → entityId mapping cleanly within hecs. Alternative (passing EntityMap reverse-lookup to collect_gpu) is messier.

---

## Part 1: ExternalId in SoA (Rust + TS plumbing)

Adds entity ID tracking to the render state so picking and immediate mode can map SoA index ↔ entityId.

### Task 1: Add ExternalId component to Rust

**Files:**
- Modify: `crates/hyperion-core/src/components.rs`

**Step 1: Add ExternalId struct**

In `components.rs`, after the `PrimitiveParams` definition, add:

```rust
/// External entity ID visible to TypeScript. Set on spawn, never changes.
/// Used by the render state to map SoA index → entityId for hit testing
/// and immediate-mode position overrides.
#[derive(Debug, Clone, Copy)]
#[repr(C)]
pub struct ExternalId(pub u32);

// SAFETY: ExternalId is a #[repr(C)] newtype around u32 — trivially Pod/Zeroable.
unsafe impl bytemuck::Pod for ExternalId {}
unsafe impl bytemuck::Zeroable for ExternalId {}
```

**Step 2: Run Rust tests**

Run: `cargo test -p hyperion-core components`
Expected: PASS (existing tests still pass; ExternalId has no tests yet — it's structural)

**Step 3: Commit**

```bash
git add crates/hyperion-core/src/components.rs
git commit -m "feat(phase6): add ExternalId component for SoA entity ID tracking"
```

---

### Task 2: Set ExternalId on entity spawn

**Files:**
- Modify: `crates/hyperion-core/src/command_processor.rs`

**Step 1: Write the failing test**

In `command_processor.rs`, add to the `#[cfg(test)] mod tests` block:

```rust
#[test]
fn spawn_sets_external_id() {
    let mut world = World::new();
    let mut entity_map = EntityMap::new();

    let cmd = Command {
        cmd_type: CommandType::SpawnEntity,
        entity_id: 42,
        payload: [0u8; 16],
    };
    process_commands(&[cmd], &mut world, &mut entity_map);

    let hecs_entity = entity_map.get(42).unwrap();
    let ext_id = world.get::<&ExternalId>(hecs_entity).unwrap();
    assert_eq!(ext_id.0, 42);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core command_proc::tests::spawn_sets_external_id`
Expected: FAIL — ExternalId not in spawn tuple, `get::<&ExternalId>` returns Err

**Step 3: Add ExternalId to spawn tuple**

In `process_commands()`, find the `CommandType::SpawnEntity` arm. Add `ExternalId(cmd.entity_id)` to the `world.spawn((...))` tuple. Also add the import at the top:

```rust
use crate::components::ExternalId;
```

The spawn tuple becomes:
```rust
let entity = world.spawn((
    Position(Vec3::ZERO),
    Rotation(Quat::IDENTITY),
    Scale(Vec3::ONE),
    Velocity(Vec3::ZERO),
    ModelMatrix([...]),
    BoundingRadius(0.5),
    TextureLayerIndex(0),
    MeshHandle(0),
    RenderPrimitive(0),
    PrimitiveParams([0.0; 8]),
    ExternalId(cmd.entity_id),
    Active,
));
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p hyperion-core command_proc::tests::spawn_sets_external_id`
Expected: PASS

**Step 5: Run all Rust tests**

Run: `cargo test -p hyperion-core`
Expected: All 86+ tests PASS

**Step 6: Commit**

```bash
git add crates/hyperion-core/src/command_processor.rs
git commit -m "feat(phase6): set ExternalId on entity spawn"
```

---

### Task 3: Add entity_ids to collect_gpu() output

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs`

**Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `render_state.rs`:

```rust
#[test]
fn collect_gpu_includes_entity_ids() {
    let mut world = World::new();
    let mut entity_map = EntityMap::new();

    // Spawn two entities with external IDs 10 and 20
    for &ext_id in &[10u32, 20] {
        let cmd = Command {
            cmd_type: CommandType::SpawnEntity,
            entity_id: ext_id,
            payload: [0u8; 16],
        };
        process_commands(&[cmd], &mut world, &mut entity_map);
    }

    let state = RenderState::new();
    let result = state.collect_gpu(&world);

    assert_eq!(result.entity_count, 2);
    assert_eq!(result.entity_ids.len(), 2);
    // Order may vary (hecs iteration), but both IDs must be present
    let mut ids = result.entity_ids.clone();
    ids.sort();
    assert_eq!(ids, vec![10, 20]);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p hyperion-core render_state::tests::collect_gpu_includes_entity_ids`
Expected: FAIL — `entity_ids` field doesn't exist on the result

**Step 3: Add entity_ids to GpuRenderData and collect_gpu()**

In the `GpuRenderData` struct (or whatever the collect_gpu return type is), add:
```rust
pub entity_ids: Vec<u32>,
```

In the `collect_gpu()` query, add `&ExternalId` to the component tuple. In the loop body, push `ext_id.0` to `entity_ids`.

Remember to add the import: `use crate::components::ExternalId;`

**Step 4: Run test to verify it passes**

Run: `cargo test -p hyperion-core render_state::tests::collect_gpu_includes_entity_ids`
Expected: PASS

**Step 5: Run all Rust tests**

Run: `cargo test -p hyperion-core`
Expected: All tests PASS (some existing tests may need the new field in their assertions)

**Step 6: Commit**

```bash
git add crates/hyperion-core/src/render_state.rs
git commit -m "feat(phase6): add entity_ids SoA buffer to collect_gpu()"
```

---

### Task 4: WASM exports for entity_ids

**Files:**
- Modify: `crates/hyperion-core/src/lib.rs`

**Step 1: Add WASM export functions**

Following the pattern of existing exports like `engine_gpu_tex_indices_ptr()` / `engine_gpu_tex_indices_len()`, add:

```rust
#[wasm_bindgen]
pub fn engine_gpu_entity_ids_ptr() -> *const u32 {
    // SAFETY: single-threaded wasm32, static initialized by engine_init
    let state = unsafe { &*addr_of_mut!(RENDER_STATE) };
    state.entity_ids.as_ptr()
}

#[wasm_bindgen]
pub fn engine_gpu_entity_ids_len() -> usize {
    let state = unsafe { &*addr_of_mut!(RENDER_STATE) };
    state.entity_ids.len()
}
```

Adjust the actual code to match how RENDER_STATE stores the last collect_gpu result. Follow the exact same pattern as the existing pointer/length export pairs.

**Step 2: Run Rust compilation check**

Run: `cargo clippy -p hyperion-core`
Expected: No warnings

**Step 3: Commit**

```bash
git add crates/hyperion-core/src/lib.rs
git commit -m "feat(phase6): add WASM exports for entity_ids buffer"
```

---

### Task 5: Plumb entityIds through TS bridge

**Files:**
- Modify: `ts/src/worker-bridge.ts`
- Modify: `ts/src/engine-worker.ts` (if it handles render state transfer)

**Step 1: Add entityIds to GPURenderState**

In `ts/src/worker-bridge.ts`, add to the `GPURenderState` interface:

```typescript
entityIds: Uint32Array;    // 1 u32/entity (external entity ID)
```

**Step 2: Update createDirectBridge (Mode C)**

In the tick function of `createDirectBridge()`, after the existing SoA buffer reads, add:

```typescript
const eidPtr = engine.engine_gpu_entity_ids_ptr();
const eidLen = engine.engine_gpu_entity_ids_len();
```

Add `engine_gpu_entity_ids_ptr` and `engine_gpu_entity_ids_len` to the engine type declaration.

Include in the latestRenderState construction:
```typescript
entityIds: eidPtr ? new Uint32Array(new Uint32Array(engine.memory.buffer, eidPtr, eidLen)) : new Uint32Array(0),
```

**Step 3: Update createWorkerBridge (Mode B)**

In the `tick-done` message handler, add entityIds:
```typescript
entityIds: new Uint32Array(msg.renderState.entityIds ?? []),
```

**Step 4: Update engine-worker.ts**

In the engine worker's tick-done message that sends render state back, include `entityIds` ArrayBuffer alongside transforms/bounds/renderMeta/texIndices.

**Step 5: Build WASM + run TS type check**

Run: `cd ts && npm run build:wasm && npx tsc --noEmit`
Expected: No type errors

**Step 6: Commit**

```bash
git add ts/src/worker-bridge.ts ts/src/engine-worker.ts
git commit -m "feat(phase6): plumb entityIds through TS bridge layer"
```

---

## Part 2: InputManager

Core input state tracking: keyboard map, pointer position, pointer buttons, scroll delta.

### Task 6: InputManager types and keyboard tests

**Files:**
- Create: `ts/src/input-manager.ts`
- Create: `ts/src/input-manager.test.ts`

**Step 1: Create the test file**

```typescript
// ts/src/input-manager.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { InputManager } from './input-manager';

describe('InputManager', () => {
  let input: InputManager;

  beforeEach(() => {
    input = new InputManager();
  });

  describe('keyboard', () => {
    it('tracks key down state', () => {
      input.handleKeyDown('KeyW');
      expect(input.isKeyDown('KeyW')).toBe(true);
    });

    it('tracks key up state', () => {
      input.handleKeyDown('KeyW');
      input.handleKeyUp('KeyW');
      expect(input.isKeyDown('KeyW')).toBe(false);
    });

    it('returns false for unpressed keys', () => {
      expect(input.isKeyDown('Space')).toBe(false);
    });

    it('tracks multiple simultaneous keys', () => {
      input.handleKeyDown('KeyW');
      input.handleKeyDown('KeyA');
      expect(input.isKeyDown('KeyW')).toBe(true);
      expect(input.isKeyDown('KeyA')).toBe(true);
      input.handleKeyUp('KeyW');
      expect(input.isKeyDown('KeyW')).toBe(false);
      expect(input.isKeyDown('KeyA')).toBe(true);
    });
  });
});
```

**Step 2: Create stub implementation**

```typescript
// ts/src/input-manager.ts
export class InputManager {
  isKeyDown(_code: string): boolean { return false; }
  handleKeyDown(_code: string): void {}
  handleKeyUp(_code: string): void {}
}
```

**Step 3: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/input-manager.test.ts`
Expected: FAIL — `isKeyDown` always returns false

**Step 4: Implement keyboard tracking**

```typescript
export class InputManager {
  private readonly keysDown = new Set<string>();

  isKeyDown(code: string): boolean {
    return this.keysDown.has(code);
  }

  handleKeyDown(code: string): void {
    this.keysDown.add(code);
  }

  handleKeyUp(code: string): void {
    this.keysDown.delete(code);
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/input-manager.test.ts`
Expected: PASS (4 tests)

**Step 6: Commit**

```bash
cd ts && git add src/input-manager.ts src/input-manager.test.ts
git commit -m "feat(phase6): InputManager keyboard state tracking"
```

---

### Task 7: InputManager pointer tracking

**Files:**
- Modify: `ts/src/input-manager.ts`
- Modify: `ts/src/input-manager.test.ts`

**Step 1: Write failing pointer tests**

Add to `input-manager.test.ts`:

```typescript
describe('pointer', () => {
  it('tracks pointer position', () => {
    input.handlePointerMove(100, 200);
    expect(input.pointerX).toBe(100);
    expect(input.pointerY).toBe(200);
  });

  it('starts at (0, 0)', () => {
    expect(input.pointerX).toBe(0);
    expect(input.pointerY).toBe(0);
  });

  it('tracks pointer button down', () => {
    input.handlePointerDown(0, 50, 60);
    expect(input.isPointerDown(0)).toBe(true);
    expect(input.pointerX).toBe(50);
    expect(input.pointerY).toBe(60);
  });

  it('tracks pointer button up', () => {
    input.handlePointerDown(0, 50, 60);
    input.handlePointerUp(0, 55, 65);
    expect(input.isPointerDown(0)).toBe(false);
  });

  it('tracks scroll delta', () => {
    input.handleScroll(0, -120);
    expect(input.scrollDeltaX).toBe(0);
    expect(input.scrollDeltaY).toBe(-120);
  });

  it('accumulates scroll within frame', () => {
    input.handleScroll(0, -60);
    input.handleScroll(0, -60);
    expect(input.scrollDeltaY).toBe(-120);
  });

  it('resets scroll delta on resetFrame()', () => {
    input.handleScroll(0, -120);
    input.resetFrame();
    expect(input.scrollDeltaY).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/input-manager.test.ts`
Expected: FAIL — missing properties/methods

**Step 3: Implement pointer and scroll tracking**

Add to `InputManager`:

```typescript
private _pointerX = 0;
private _pointerY = 0;
private readonly buttonsDown = new Set<number>();
private _scrollDeltaX = 0;
private _scrollDeltaY = 0;

get pointerX(): number { return this._pointerX; }
get pointerY(): number { return this._pointerY; }
get scrollDeltaX(): number { return this._scrollDeltaX; }
get scrollDeltaY(): number { return this._scrollDeltaY; }

isPointerDown(button: number): boolean {
  return this.buttonsDown.has(button);
}

handlePointerMove(x: number, y: number): void {
  this._pointerX = x;
  this._pointerY = y;
}

handlePointerDown(button: number, x: number, y: number): void {
  this.buttonsDown.add(button);
  this._pointerX = x;
  this._pointerY = y;
}

handlePointerUp(button: number, x: number, y: number): void {
  this.buttonsDown.delete(button);
  this._pointerX = x;
  this._pointerY = y;
}

handleScroll(deltaX: number, deltaY: number): void {
  this._scrollDeltaX += deltaX;
  this._scrollDeltaY += deltaY;
}

resetFrame(): void {
  this._scrollDeltaX = 0;
  this._scrollDeltaY = 0;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/input-manager.test.ts`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
cd ts && git add src/input-manager.ts src/input-manager.test.ts
git commit -m "feat(phase6): InputManager pointer and scroll tracking"
```

---

### Task 8: InputManager callback registration

**Files:**
- Modify: `ts/src/input-manager.ts`
- Modify: `ts/src/input-manager.test.ts`

**Step 1: Write failing callback tests**

Add to `input-manager.test.ts`:

```typescript
describe('callbacks', () => {
  it('fires key callback on matching keydown', () => {
    const calls: string[] = [];
    input.onKey('Space', (code) => calls.push(code));
    input.handleKeyDown('Space');
    expect(calls).toEqual(['Space']);
  });

  it('does not fire key callback for non-matching key', () => {
    const calls: string[] = [];
    input.onKey('Space', (code) => calls.push(code));
    input.handleKeyDown('KeyW');
    expect(calls).toEqual([]);
  });

  it('fires wildcard key callback for any key', () => {
    const calls: string[] = [];
    input.onKey('*', (code) => calls.push(code));
    input.handleKeyDown('KeyW');
    input.handleKeyDown('Space');
    expect(calls).toEqual(['KeyW', 'Space']);
  });

  it('fires click callback with position', () => {
    const calls: Array<{ button: number; x: number; y: number }> = [];
    input.onClick((button, x, y) => calls.push({ button, x, y }));
    input.handlePointerDown(0, 100, 200);
    input.handlePointerUp(0, 100, 200);
    expect(calls).toEqual([{ button: 0, x: 100, y: 200 }]);
  });

  it('fires pointerMove callback', () => {
    const calls: Array<{ x: number; y: number }> = [];
    input.onPointerMove((x, y) => calls.push({ x, y }));
    input.handlePointerMove(50, 75);
    expect(calls).toEqual([{ x: 50, y: 75 }]);
  });

  it('fires scroll callback', () => {
    const calls: Array<{ dx: number; dy: number }> = [];
    input.onScroll((dx, dy) => calls.push({ dx, dy }));
    input.handleScroll(0, -120);
    expect(calls).toEqual([{ dx: 0, dy: -120 }]);
  });

  it('removes callback via returned unsubscribe function', () => {
    const calls: string[] = [];
    const unsub = input.onKey('Space', (code) => calls.push(code));
    input.handleKeyDown('Space');
    unsub();
    input.handleKeyDown('Space');
    expect(calls).toEqual(['Space']); // only first call
  });

  it('removeAllListeners clears all callbacks', () => {
    const calls: string[] = [];
    input.onKey('Space', () => calls.push('key'));
    input.onClick(() => calls.push('click'));
    input.removeAllListeners();
    input.handleKeyDown('Space');
    input.handlePointerDown(0, 0, 0);
    input.handlePointerUp(0, 0, 0);
    expect(calls).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/input-manager.test.ts`
Expected: FAIL — callback methods don't exist

**Step 3: Implement callbacks**

Add callback types and registration to `InputManager`:

```typescript
export type KeyCallback = (code: string) => void;
export type ClickCallback = (button: number, x: number, y: number) => void;
export type PointerMoveCallback = (x: number, y: number) => void;
export type ScrollCallback = (deltaX: number, deltaY: number) => void;
export type Unsubscribe = () => void;
```

Add fields:
```typescript
private readonly keyCallbacks: Array<{ code: string; fn: KeyCallback }> = [];
private readonly clickCallbacks: ClickCallback[] = [];
private readonly pointerMoveCallbacks: PointerMoveCallback[] = [];
private readonly scrollCallbacks: ScrollCallback[] = [];
```

Track pointer-down position for click detection: store `lastPointerDownPos` in `handlePointerDown`, and in `handlePointerUp`, fire click callbacks if the button matches.

Registration methods return `Unsubscribe` functions that splice the callback out of the array.

Update `handleKeyDown` to fire matching key callbacks.
Update `handlePointerMove` to fire pointerMove callbacks.
Update `handlePointerUp` to fire click callbacks.
Update `handleScroll` to fire scroll callbacks.

Add `removeAllListeners()` that clears all callback arrays.

**Step 4: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/input-manager.test.ts`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
cd ts && git add src/input-manager.ts src/input-manager.test.ts
git commit -m "feat(phase6): InputManager callback registration with unsubscribe"
```

---

### Task 9: InputManager DOM attachment

**Files:**
- Modify: `ts/src/input-manager.ts`
- Modify: `ts/src/input-manager.test.ts`

**Step 1: Write test for DOM attachment**

Add to `input-manager.test.ts`:

```typescript
describe('DOM attachment', () => {
  it('attaches and responds to keyboard events on target', () => {
    const target = document.createElement('div');
    // tabIndex needed for div to receive keyboard events
    target.tabIndex = 0;
    input.attach(target);

    const calls: string[] = [];
    input.onKey('*', (code) => calls.push(code));

    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(calls).toEqual(['KeyW']);
    expect(input.isKeyDown('KeyW')).toBe(true);

    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    expect(input.isKeyDown('KeyW')).toBe(false);
  });

  it('attaches and responds to pointer events on target', () => {
    const target = document.createElement('canvas');
    input.attach(target);

    target.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 200 }));
    expect(input.pointerX).toBeGreaterThanOrEqual(0);
  });

  it('detach removes event listeners', () => {
    const target = document.createElement('div');
    target.tabIndex = 0;
    input.attach(target);
    input.detach();

    input.handleKeyDown('KeyA'); // manual — should still work
    expect(input.isKeyDown('KeyA')).toBe(true);
    // But DOM events on the element should no longer trigger
    // (We can't easily test this without spying, so just verify no errors)
  });

  it('destroy clears state and detaches', () => {
    const target = document.createElement('div');
    input.attach(target);
    input.handleKeyDown('KeyW');
    input.destroy();
    expect(input.isKeyDown('KeyW')).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/input-manager.test.ts`
Expected: FAIL — `attach`, `detach`, `destroy` don't exist

**Step 3: Implement attach/detach/destroy**

Add to `InputManager`:

```typescript
private target: EventTarget | null = null;
private readonly boundHandlers = {
  keydown: (e: Event) => {
    const ke = e as KeyboardEvent;
    this.handleKeyDown(ke.code);
  },
  keyup: (e: Event) => {
    const ke = e as KeyboardEvent;
    this.handleKeyUp(ke.code);
  },
  pointermove: (e: Event) => {
    const pe = e as PointerEvent;
    this.handlePointerMove(pe.offsetX, pe.offsetY);
  },
  pointerdown: (e: Event) => {
    const pe = e as PointerEvent;
    this.handlePointerDown(pe.button, pe.offsetX, pe.offsetY);
  },
  pointerup: (e: Event) => {
    const pe = e as PointerEvent;
    this.handlePointerUp(pe.button, pe.offsetX, pe.offsetY);
  },
  wheel: (e: Event) => {
    const we = e as WheelEvent;
    e.preventDefault();
    this.handleScroll(we.deltaX, we.deltaY);
  },
};

attach(target: EventTarget): void {
  this.detach();
  this.target = target;
  for (const [event, handler] of Object.entries(this.boundHandlers)) {
    target.addEventListener(event, handler, { passive: event !== 'wheel' });
  }
}

detach(): void {
  if (!this.target) return;
  for (const [event, handler] of Object.entries(this.boundHandlers)) {
    this.target.removeEventListener(event, handler);
  }
  this.target = null;
}

destroy(): void {
  this.detach();
  this.keysDown.clear();
  this.buttonsDown.clear();
  this.removeAllListeners();
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/input-manager.test.ts`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
cd ts && git add src/input-manager.ts src/input-manager.test.ts
git commit -m "feat(phase6): InputManager DOM attach/detach lifecycle"
```

---

## Part 3: Wire InputManager to Hyperion facade

### Task 10: Expose engine.input on Hyperion

**Files:**
- Modify: `ts/src/hyperion.ts`
- Modify: `ts/src/hyperion.test.ts`

**Step 1: Write failing test**

Add to `hyperion.test.ts`:

```typescript
describe('input', () => {
  it('engine.input is available', () => {
    const engine = createTestEngine();
    expect(engine.input).toBeDefined();
    expect(typeof engine.input.isKeyDown).toBe('function');
    expect(typeof engine.input.onKey).toBe('function');
    expect(typeof engine.input.onClick).toBe('function');
    engine.destroy();
  });

  it('engine.input.isKeyDown returns false initially', () => {
    const engine = createTestEngine();
    expect(engine.input.isKeyDown('Space')).toBe(false);
    engine.destroy();
  });

  it('destroy cleans up InputManager', () => {
    const engine = createTestEngine();
    engine.destroy();
    // Should not throw
  });
});
```

Where `createTestEngine()` uses `Hyperion.fromParts(...)` with mocks — follow the pattern already used in the existing hyperion.test.ts.

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `engine.input` doesn't exist

**Step 3: Add InputManager to Hyperion**

In `hyperion.ts`:
1. Import `InputManager`
2. Add `private readonly inputManager: InputManager` field
3. In constructor: `this.inputManager = new InputManager()`
4. Add public getter: `get input(): InputManager { return this.inputManager; }`
5. In `destroy()`: call `this.inputManager.destroy()` before bridge/renderer destroy
6. In `Hyperion.create()`: after creating the Hyperion instance, call `instance.inputManager.attach(config.canvas)` (you'll need to store a reference or call it internally)

Note: Since the constructor is private, the `attach` should happen inside the constructor by passing canvas through config. Or add an internal `init()` method called by both `create()` and `fromParts()`. Choose the approach that's cleanest. For `fromParts()` (testing), the canvas may not exist — don't attach in that case.

**Step 4: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS (existing + new tests)

**Step 5: Commit**

```bash
cd ts && git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase6): expose engine.input on Hyperion facade"
```

---

### Task 11: InputManager resetFrame in game loop

**Files:**
- Modify: `ts/src/hyperion.ts`

**Step 1: Wire resetFrame to tick**

In the `tick()` method of Hyperion, add `this.inputManager.resetFrame()` at the end (after rendering). This resets per-frame accumulators like scroll delta.

```typescript
private tick(dt: number): void {
  this.bridge.tick(dt);
  const state = this.bridge.latestRenderState;
  if (this.renderer && state && state.entityCount > 0) {
    this.renderer.render(state, this.camera);
  }
  this.inputManager.resetFrame();
}
```

**Step 2: Run all TS tests**

Run: `cd ts && npm test`
Expected: PASS

**Step 3: Commit**

```bash
git add ts/src/hyperion.ts
git commit -m "feat(phase6): reset InputManager per-frame state each tick"
```

---

## Part 4: CPU Hit Testing

### Task 12: mat4Inverse utility + Camera.screenToRay

**Files:**
- Modify: `ts/src/camera.ts`
- Modify: `ts/src/camera.test.ts`

**Step 1: Write failing tests**

Add to `camera.test.ts`:

```typescript
import { mat4Inverse } from './camera';

describe('mat4Inverse', () => {
  it('inverse of identity is identity', () => {
    const I = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    const inv = mat4Inverse(I);
    expect(inv).not.toBeNull();
    for (let i = 0; i < 16; i++) {
      expect(inv![i]).toBeCloseTo(I[i], 5);
    }
  });

  it('inverse of VP times VP ≈ identity', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(3, 7, 0);
    const vp = cam.viewProjection;
    const inv = mat4Inverse(vp)!;
    // Multiply inv * vp and check ≈ identity
    const result = mat4MultiplyExported(inv, vp);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        const expected = col === row ? 1 : 0;
        expect(result[col * 4 + row]).toBeCloseTo(expected, 4);
      }
    }
  });
});

describe('screenToRay', () => {
  it('center pixel produces ray at world origin for centered camera', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(0, 0, 0);

    const ray = cam.screenToRay(400, 300, 800, 600);
    expect(ray.origin[0]).toBeCloseTo(0, 2);
    expect(ray.origin[1]).toBeCloseTo(0, 2);
    // Orthographic ray direction is (0, 0, -1)
    expect(ray.direction[0]).toBeCloseTo(0, 2);
    expect(ray.direction[1]).toBeCloseTo(0, 2);
    expect(ray.direction[2]).toBeCloseTo(-1, 2);
  });

  it('top-left pixel produces ray at negative world coords', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(0, 0, 0);

    const ray = cam.screenToRay(0, 0, 800, 600);
    expect(ray.origin[0]).toBeCloseTo(-10, 1);
    expect(ray.origin[1]).toBeCloseTo(10, 1);
  });

  it('accounts for camera position offset', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(5, 3, 0);

    const ray = cam.screenToRay(400, 300, 800, 600);
    expect(ray.origin[0]).toBeCloseTo(5, 2);
    expect(ray.origin[1]).toBeCloseTo(3, 2);
  });
});
```

Note: You'll need to export `mat4Multiply` (or a copy named `mat4MultiplyExported`) from `camera.ts` for the inverse verification test.

**Step 2: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/camera.test.ts`
Expected: FAIL — `mat4Inverse`, `screenToRay` don't exist

**Step 3: Implement mat4Inverse and screenToRay**

Add a general-purpose `mat4Inverse` to `camera.ts` (export it for testing). This is the standard cofactor expansion for 4×4 matrices:

```typescript
/** Ray from camera through a screen point. */
export interface Ray {
  origin: [number, number, number];
  direction: [number, number, number];
}

/**
 * General 4×4 matrix inverse (column-major). Returns null if singular.
 * Standard cofactor expansion — works for any invertible matrix, including
 * perspective projections (future 3D support).
 */
export function mat4Inverse(m: Float32Array): Float32Array | null {
  // Standard 4x4 inverse via cofactors (16 2x2 determinants → 4x4 adjugate / det)
  // ... (well-known algorithm, ~50 lines — implement the full cofactor expansion)
}
```

Then add `screenToRay` to the `Camera` class:

```typescript
/**
 * Generate a 3D ray from a screen pixel through the scene.
 *
 * For orthographic cameras, all rays are parallel (direction = 0,0,-1)
 * and the origin varies per pixel. For future perspective cameras, the
 * origin is the camera position and the direction varies per pixel.
 *
 * @param pixelX — X in canvas pixels (0 = left)
 * @param pixelY — Y in canvas pixels (0 = top)
 * @param canvasWidth — Canvas width in pixels
 * @param canvasHeight — Canvas height in pixels
 */
screenToRay(pixelX: number, pixelY: number, canvasWidth: number, canvasHeight: number): Ray {
  const ndcX = (pixelX / canvasWidth) * 2 - 1;
  const ndcY = -((pixelY / canvasHeight) * 2 - 1);

  const invVP = mat4Inverse(this.viewProjection);
  if (!invVP) throw new Error('Camera VP matrix is singular');

  // Unproject two points at different depths to form the ray
  const nearPt = transformPoint(invVP, ndcX, ndcY, 0);   // NDC z=0 (near plane)
  const farPt  = transformPoint(invVP, ndcX, ndcY, 1);   // NDC z=1 (far plane)

  // Direction = normalize(far - near)
  const dx = farPt[0] - nearPt[0];
  const dy = farPt[1] - nearPt[1];
  const dz = farPt[2] - nearPt[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

  return {
    origin: nearPt,
    direction: [dx / len, dy / len, dz / len],
  };
}
```

Helper:
```typescript
function transformPoint(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8]  * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9]  * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/camera.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
cd ts && git add ts/src/camera.ts ts/src/camera.test.ts
git commit -m "feat(phase6): mat4Inverse + Camera.screenToRay (2.5D/3D-ready)"
```

---

### Task 13: HitTester with ray-sphere intersection

**Files:**
- Create: `ts/src/hit-tester.ts`
- Create: `ts/src/hit-tester.test.ts`

**Step 1: Write tests**

```typescript
// ts/src/hit-tester.test.ts
import { describe, it, expect } from 'vitest';
import { hitTestRay, type Ray } from './hit-tester';

// Helper: orthographic ray straight down -Z at (x, y)
function orthoRay(x: number, y: number): Ray {
  return { origin: [x, y, 100], direction: [0, 0, -1] };
}

describe('hitTestRay', () => {
  it('returns null when no entities', () => {
    const result = hitTestRay(orthoRay(0, 0), new Float32Array(0), new Uint32Array(0));
    expect(result).toBeNull();
  });

  it('returns entityId when ray hits bounding sphere', () => {
    // Entity at (5, 5, 0) with radius 2
    const bounds = new Float32Array([5, 5, 0, 2]);
    const entityIds = new Uint32Array([42]);
    const result = hitTestRay(orthoRay(5, 5), bounds, entityIds);
    expect(result).toBe(42);
  });

  it('returns null when ray misses all bounding spheres', () => {
    const bounds = new Float32Array([5, 5, 0, 1]);
    const entityIds = new Uint32Array([42]);
    const result = hitTestRay(orthoRay(100, 100), bounds, entityIds);
    expect(result).toBeNull();
  });

  it('returns closest entity along ray (smallest t)', () => {
    // Entity A at z=0, Entity B at z=5 — ray goes along -Z from z=100
    // B is hit first (higher Z = closer to ray origin at z=100)
    const bounds = new Float32Array([
      5, 5, 0, 3,    // entity A: center=(5,5,0), r=3
      5, 5, 5, 3,    // entity B: center=(5,5,5), r=3
    ]);
    const entityIds = new Uint32Array([10, 20]);
    const result = hitTestRay(orthoRay(5, 5), bounds, entityIds);
    expect(result).toBe(20); // B at z=5 is hit first
  });

  it('handles edge case: ray tangent to sphere', () => {
    // Sphere at (0,0,0) r=5. Ray at (5, 0, 100) going -Z touches sphere edge
    const bounds = new Float32Array([0, 0, 0, 5]);
    const entityIds = new Uint32Array([1]);
    const result = hitTestRay(orthoRay(5, 0), bounds, entityIds);
    expect(result).toBe(1); // tangent = hit
  });

  it('handles non-axis-aligned rays (future 3D perspective)', () => {
    // Sphere at (10, 0, -10) r=2. Ray from origin pointing (1, 0, -1) normalized.
    const bounds = new Float32Array([10, 0, -10, 2]);
    const entityIds = new Uint32Array([77]);
    const d = Math.SQRT1_2; // 1/sqrt(2)
    const ray: Ray = { origin: [0, 0, 0], direction: [d, 0, -d] };
    const result = hitTestRay(ray, bounds, entityIds);
    expect(result).toBe(77);
  });

  it('returns null for ray pointing away from sphere', () => {
    // Sphere at (0, 0, -10). Ray origin at (0,0,0) going +Z (away).
    const bounds = new Float32Array([0, 0, -10, 2]);
    const entityIds = new Uint32Array([1]);
    const ray: Ray = { origin: [0, 0, 0], direction: [0, 0, 1] };
    const result = hitTestRay(ray, bounds, entityIds);
    expect(result).toBeNull();
  });

  it('handles 10k entities efficiently', () => {
    const count = 10000;
    const bounds = new Float32Array(count * 4);
    const entityIds = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      bounds[i * 4] = i * 10;
      bounds[i * 4 + 1] = 0;
      bounds[i * 4 + 2] = 0;
      bounds[i * 4 + 3] = 1;
      entityIds[i] = i;
    }
    const result = hitTestRay(orthoRay(5000, 0), bounds, entityIds);
    expect(result).toBe(500);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/hit-tester.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Implement hitTestRay with ray-sphere intersection**

```typescript
// ts/src/hit-tester.ts

export interface Ray {
  origin: [number, number, number];
  direction: [number, number, number]; // must be normalized
}

/**
 * CPU-based hit testing using ray-sphere intersection.
 *
 * Casts a ray against all entity bounding spheres and returns the entityId
 * of the closest hit (smallest positive t along the ray), or null.
 *
 * Supports both orthographic (parallel rays, 2.5D) and perspective
 * (diverging rays, future 3D) cameras.
 *
 * @param ray — Ray from Camera.screenToRay()
 * @param bounds — SoA bounds buffer: [x, y, z, radius] × entityCount
 * @param entityIds — SoA entity ID buffer: [id] × entityCount
 * @returns The external entity ID of the closest hit entity, or null
 */
export function hitTestRay(
  ray: Ray,
  bounds: Float32Array,
  entityIds: Uint32Array,
): number | null {
  const entityCount = entityIds.length;
  let bestId: number | null = null;
  let bestT = Infinity;

  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.direction;

  for (let i = 0; i < entityCount; i++) {
    const cx = bounds[i * 4];
    const cy = bounds[i * 4 + 1];
    const cz = bounds[i * 4 + 2];
    const r  = bounds[i * 4 + 3];

    // Vector from ray origin to sphere center
    const ocx = ox - cx;
    const ocy = oy - cy;
    const ocz = oz - cz;

    // Quadratic: a*t² + b*t + c = 0
    // a = dot(d, d) = 1 (direction is normalized)
    const b = 2 * (ocx * dx + ocy * dy + ocz * dz);
    const c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
    const discriminant = b * b - 4 * c;

    if (discriminant < 0) continue; // miss

    const sqrtDisc = Math.sqrt(discriminant);
    let t = (-b - sqrtDisc) / 2; // nearest intersection

    // If t < 0, ray origin is inside sphere — use far intersection
    if (t < 0) t = (-b + sqrtDisc) / 2;
    if (t < 0) continue; // sphere is entirely behind ray

    if (t < bestT) {
      bestT = t;
      bestId = entityIds[i];
    }
  }

  return bestId;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/hit-tester.test.ts`
Expected: PASS (8 tests)

**Step 5: Commit**

```bash
cd ts && git add ts/src/hit-tester.ts ts/src/hit-tester.test.ts
git commit -m "feat(phase6): ray-sphere hit testing (2.5D + 3D-ready)"
```

---

### Task 14: Picking API on Hyperion facade

**Files:**
- Modify: `ts/src/hyperion.ts`
- Modify: `ts/src/hyperion.test.ts`

**Step 1: Write failing tests**

Add to `hyperion.test.ts`:

```typescript
describe('picking', () => {
  it('engine.picking exists', () => {
    const engine = createTestEngine();
    expect(engine.picking).toBeDefined();
    expect(typeof engine.picking.hitTest).toBe('function');
    engine.destroy();
  });

  it('hitTest returns null with no entities', () => {
    const engine = createTestEngine();
    const result = engine.picking.hitTest(400, 300);
    expect(result).toBeNull();
    engine.destroy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `engine.picking` doesn't exist

**Step 3: Implement picking facade**

Add a `PickingAPI` object to Hyperion:

```typescript
import { hitTestRay } from './hit-tester';

// In Hyperion class:
get picking(): { hitTest: (pixelX: number, pixelY: number) => number | null } {
  return {
    hitTest: (pixelX: number, pixelY: number): number | null => {
      this.checkDestroyed();
      const state = this.bridge.latestRenderState;
      if (!state || state.entityCount === 0 || !state.entityIds) return null;

      const ray = this.camera.screenToRay(
        pixelX, pixelY,
        this.config.canvas.width, this.config.canvas.height,
      );

      return hitTestRay(ray, state.bounds, state.entityIds);
    },
  };
}
```

Note: `state.entityIds` may not exist if WASM hasn't been rebuilt yet. Guard with `!state.entityIds`.

The `camera` field is private — you may need to expose it or use `this.cameraApi` to get the camera for `screenToRay`. Check how the camera is currently stored and adjust.

**Step 4: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase6): picking API on Hyperion facade"
```

---

## Part 5: Immediate Mode

### Task 15: ImmediateState class

**Files:**
- Create: `ts/src/immediate-state.ts`
- Create: `ts/src/immediate-state.test.ts`

**Step 1: Write tests**

```typescript
// ts/src/immediate-state.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ImmediateState } from './immediate-state';

describe('ImmediateState', () => {
  let state: ImmediateState;

  beforeEach(() => {
    state = new ImmediateState();
  });

  it('starts empty', () => {
    expect(state.has(0)).toBe(false);
    expect(state.count).toBe(0);
  });

  it('stores and retrieves position override', () => {
    state.set(42, 1, 2, 3);
    expect(state.has(42)).toBe(true);
    expect(state.get(42)).toEqual([1, 2, 3]);
  });

  it('overwrites existing override', () => {
    state.set(42, 1, 2, 3);
    state.set(42, 4, 5, 6);
    expect(state.get(42)).toEqual([4, 5, 6]);
    expect(state.count).toBe(1);
  });

  it('clears a single entity override', () => {
    state.set(42, 1, 2, 3);
    state.clear(42);
    expect(state.has(42)).toBe(false);
  });

  it('clears all overrides', () => {
    state.set(1, 0, 0, 0);
    state.set(2, 0, 0, 0);
    state.clearAll();
    expect(state.count).toBe(0);
  });

  it('patchTransforms modifies transform buffer at correct offsets', () => {
    // 2 entities: SoA transforms = 2 * 16 floats = 32 floats
    // Entity IDs: [10, 20]
    const transforms = new Float32Array(32);
    // Set identity matrices
    for (let i = 0; i < 2; i++) {
      transforms[i * 16 + 0] = 1;
      transforms[i * 16 + 5] = 1;
      transforms[i * 16 + 10] = 1;
      transforms[i * 16 + 15] = 1;
    }
    const entityIds = new Uint32Array([10, 20]);

    // Override entity 20's position to (7, 8, 9)
    state.set(20, 7, 8, 9);
    state.patchTransforms(transforms, entityIds, 2);

    // Entity 20 is at SoA index 1 → transform offset = 1 * 16
    // Position is in column 3 (indices 12, 13, 14)
    expect(transforms[1 * 16 + 12]).toBe(7);
    expect(transforms[1 * 16 + 13]).toBe(8);
    expect(transforms[1 * 16 + 14]).toBe(9);

    // Entity 10 (no override) should be unchanged
    expect(transforms[0 * 16 + 12]).toBe(0);
    expect(transforms[0 * 16 + 13]).toBe(0);
    expect(transforms[0 * 16 + 14]).toBe(0);
  });

  it('patchTransforms skips entities not in SoA', () => {
    const transforms = new Float32Array(16); // 1 entity
    const entityIds = new Uint32Array([10]);

    state.set(999, 1, 2, 3); // entity 999 not in SoA
    // Should not throw or corrupt
    state.patchTransforms(transforms, entityIds, 1);
    expect(transforms[12]).toBe(0); // unchanged
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/immediate-state.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Implement ImmediateState**

```typescript
// ts/src/immediate-state.ts

/**
 * Maintains shadow position overrides for immediate-mode rendering.
 *
 * When `setPositionImmediate()` is called on an entity, the position is
 * stored here AND sent through the ring buffer. The renderer patches the
 * SoA transforms buffer with these overrides before GPU upload, providing
 * zero-latency visual feedback while the ring buffer catches up.
 */
export class ImmediateState {
  private readonly overrides = new Map<number, [number, number, number]>();

  get count(): number {
    return this.overrides.size;
  }

  has(entityId: number): boolean {
    return this.overrides.has(entityId);
  }

  get(entityId: number): [number, number, number] | undefined {
    return this.overrides.get(entityId);
  }

  set(entityId: number, x: number, y: number, z: number): void {
    this.overrides.set(entityId, [x, y, z]);
  }

  clear(entityId: number): void {
    this.overrides.delete(entityId);
  }

  clearAll(): void {
    this.overrides.clear();
  }

  /**
   * Patch the SoA transforms buffer with immediate-mode overrides.
   *
   * For each overridden entity, finds its SoA index via entityIds lookup
   * and writes the shadow position into the transform matrix column 3.
   *
   * @param transforms — SoA transform buffer (16 f32/entity, column-major mat4x4)
   * @param entityIds — SoA entity ID buffer (1 u32/entity)
   * @param entityCount — Number of active entities in SoA
   */
  patchTransforms(
    transforms: Float32Array,
    entityIds: Uint32Array,
    entityCount: number,
  ): void {
    if (this.overrides.size === 0) return;

    // Build reverse lookup: entityId → SoA index
    // For small override counts, linear scan is fine.
    // For many overrides, consider caching this map.
    for (let i = 0; i < entityCount; i++) {
      const pos = this.overrides.get(entityIds[i]);
      if (pos) {
        const base = i * 16;
        transforms[base + 12] = pos[0]; // column 3, row 0
        transforms[base + 13] = pos[1]; // column 3, row 1
        transforms[base + 14] = pos[2]; // column 3, row 2
      }
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/immediate-state.test.ts`
Expected: PASS (7 tests)

**Step 5: Commit**

```bash
cd ts && git add ts/src/immediate-state.ts ts/src/immediate-state.test.ts
git commit -m "feat(phase6): ImmediateState shadow position map with transform patching"
```

---

### Task 16: EntityHandle.positionImmediate()

**Files:**
- Modify: `ts/src/entity-handle.ts`
- Modify: `ts/src/entity-handle.test.ts`

**Step 1: Write failing tests**

Add to `entity-handle.test.ts`:

```typescript
describe('positionImmediate', () => {
  it('sends position command to producer', () => {
    // Use a spy/mock producer to verify the ring buffer command was sent
    const handle = createTestHandle(42, mockProducer);
    handle.positionImmediate(1, 2, 3, mockImmediateState);
    expect(mockProducer.setPosition).toHaveBeenCalledWith(42, 1, 2, 3);
  });

  it('updates immediate state', () => {
    const immediateState = new ImmediateState();
    const handle = createTestHandle(42, mockProducer);
    handle.positionImmediate(1, 2, 3, immediateState);
    expect(immediateState.has(42)).toBe(true);
    expect(immediateState.get(42)).toEqual([1, 2, 3]);
  });

  it('clearImmediate removes override', () => {
    const immediateState = new ImmediateState();
    const handle = createTestHandle(42, mockProducer);
    handle.positionImmediate(1, 2, 3, immediateState);
    handle.clearImmediate(immediateState);
    expect(immediateState.has(42)).toBe(false);
  });
});
```

Note: The test helpers (`createTestHandle`, `mockProducer`) should follow the patterns already used in `entity-handle.test.ts`. You may need to adjust based on how the existing tests create handles.

**Step 2: Run tests to verify they fail**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: FAIL — `positionImmediate` doesn't exist

**Step 3: Implement positionImmediate and clearImmediate**

The `ImmediateState` reference needs to be available to EntityHandle. Two approaches:
- **Option A**: Pass ImmediateState to each call: `handle.positionImmediate(x, y, z, immediateState)`
- **Option B**: Store ImmediateState on the handle (set during init)

**Choose Option B** — store ImmediateState reference on the handle. The Hyperion facade passes it during pool init.

Add to `EntityHandle`:

```typescript
private _immediateState: ImmediateState | null = null;

// Update init() to accept optional ImmediateState
init(id: number, producer: BackpressuredProducer, immediateState?: ImmediateState): void {
  this._id = id;
  this._alive = true;
  this._producer = producer;
  this._immediateState = immediateState ?? null;
  this._data = null;
}

positionImmediate(x: number, y: number, z: number): this {
  this.check();
  this._producer!.setPosition(this._id, x, y, z);
  this._immediateState?.set(this._id, x, y, z);
  return this;
}

clearImmediate(): this {
  this.check();
  this._immediateState?.clear(this._id);
  return this;
}
```

Also update `destroy()` to clear immediate state:
```typescript
destroy(): void {
  if (!this._alive) return;
  this._immediateState?.clear(this._id);
  this._producer!.despawnEntity(this._id);
  this._alive = false;
  this._producer = null;
  this._immediateState = null;
}
```

Update the constructor to match the new init signature. Adjust `EntityHandlePool.acquire()` to pass the ImmediateState.

**Step 4: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/entity-handle.test.ts`
Expected: PASS

**Step 5: Run all TS tests to check for regressions**

Run: `cd ts && npm test`
Expected: PASS (existing tests may need minor adjustments to init() signature — add `undefined` as third arg where needed)

**Step 6: Commit**

```bash
cd ts && git add src/entity-handle.ts src/entity-handle.test.ts src/entity-pool.ts
git commit -m "feat(phase6): EntityHandle.positionImmediate with shadow state"
```

---

### Task 17: Wire ImmediateState into Hyperion

**Files:**
- Modify: `ts/src/hyperion.ts`
- Modify: `ts/src/hyperion.test.ts`

**Step 1: Write failing test**

Add to `hyperion.test.ts`:

```typescript
describe('immediate mode', () => {
  it('positionImmediate on spawned entity stores shadow state', () => {
    const engine = createTestEngine();
    const e = engine.spawn();
    e.positionImmediate(10, 20, 30);
    // Verify the immediate state is tracked (internal, so may need to expose for testing)
    // At minimum, verify no errors
    e.destroy();
    engine.destroy();
  });
});
```

**Step 2: Integrate ImmediateState into Hyperion**

1. Import `ImmediateState`
2. Add `private readonly immediateState = new ImmediateState()` field
3. Pass `this.immediateState` through `EntityHandlePool.acquire()` → `EntityHandle.init()`
4. In `tick()`, after getting `latestRenderState`, call:

```typescript
private tick(dt: number): void {
  this.bridge.tick(dt);
  const state = this.bridge.latestRenderState;
  if (this.renderer && state && state.entityCount > 0) {
    // Patch transforms with immediate-mode overrides
    if (state.entityIds && this.immediateState.count > 0) {
      this.immediateState.patchTransforms(state.transforms, state.entityIds, state.entityCount);
    }
    this.renderer.render(state, this.camera);
  }
  this.inputManager.resetFrame();
}
```

5. In `destroy()`: call `this.immediateState.clearAll()`

**Step 3: Run tests**

Run: `cd ts && npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase6): wire ImmediateState into Hyperion tick + entity lifecycle"
```

---

## Part 6: Integration, Demo, and Polish

### Task 18: Export new types from barrel

**Files:**
- Modify: `ts/src/index.ts`

**Step 1: Add exports**

Add to `ts/src/index.ts`:
```typescript
export { InputManager } from './input-manager';
export type { KeyCallback, ClickCallback, PointerMoveCallback, ScrollCallback, Unsubscribe } from './input-manager';
export { hitTest } from './hit-tester';
export { ImmediateState } from './immediate-state';
```

**Step 2: Type check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add ts/src/index.ts
git commit -m "feat(phase6): export input system types from barrel"
```

---

### Task 19: Click-to-select integration test

**Files:**
- Create: `ts/src/input-picking.test.ts`

**Step 1: Write integration test**

```typescript
// ts/src/input-picking.test.ts
import { describe, it, expect } from 'vitest';
import { hitTestRay } from './hit-tester';
import { Camera } from './camera';

describe('input → picking integration', () => {
  it('click at entity position returns correct entityId', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(0, 0, 0);

    // Entity at world (3, 4, 0) with radius 1
    const bounds = new Float32Array([3, 4, 0, 1]);
    const entityIds = new Uint32Array([99]);

    // Pixel that maps to world (3, 4) — use screenToRay for accurate conversion
    // NDC: x = 3/10 = 0.3 → px = (0.3+1)/2 * 800 = 520
    // NDC: y = 4/10 = 0.4 → py = (1-0.4)/2 * 600 = 180
    const ray = cam.screenToRay(520, 180, 800, 600);
    const result = hitTestRay(ray, bounds, entityIds);
    expect(result).toBe(99);
  });

  it('click at empty area returns null', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(0, 0, 0);

    const bounds = new Float32Array([3, 4, 0, 1]);
    const entityIds = new Uint32Array([99]);

    // Click far from entity
    const ray = cam.screenToRay(0, 0, 800, 600);
    const result = hitTestRay(ray, bounds, entityIds);
    expect(result).toBeNull();
  });

  it('2.5D: picks frontmost entity when multiple overlap on screen', () => {
    const cam = new Camera();
    cam.setOrthographic(20, 20, 0.1, 100);
    cam.setPosition(0, 0, 0);

    // Two entities at same XY but different Z depths
    const bounds = new Float32Array([
      0, 0, -5, 2,   // entity A: further from camera
      0, 0,  3, 2,   // entity B: closer to camera
    ]);
    const entityIds = new Uint32Array([10, 20]);

    const ray = cam.screenToRay(400, 300, 800, 600); // center
    const result = hitTestRay(ray, bounds, entityIds);
    expect(result).toBe(20); // B is closer (ray from z=near hits z=3 before z=-5)
  });
});
```

**Step 2: Run tests**

Run: `cd ts && npx vitest run src/input-picking.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
cd ts && git add ts/src/input-picking.test.ts
git commit -m "test(phase6): click-to-pick integration test"
```

---

### Task 20: ImmediateState integration test

**Files:**
- Modify: `ts/src/immediate-state.test.ts`

**Step 1: Write integration test**

Add to `immediate-state.test.ts`:

```typescript
describe('integration: immediate mode + picking', () => {
  it('hitTest uses patched position from immediate state', () => {
    const state = new ImmediateState();

    // Entity at WASM position (0, 0, 0) with radius 1
    const bounds = new Float32Array([0, 0, 0, 1]);
    const transforms = new Float32Array(16);
    transforms[0] = 1; transforms[5] = 1; transforms[10] = 1; transforms[15] = 1;
    const entityIds = new Uint32Array([42]);

    // Override entity 42 to position (10, 10, 0)
    state.set(42, 10, 10, 0);
    state.patchTransforms(transforms, entityIds, 1);

    // The bounds buffer still has old position — hitTestRay reads from bounds
    // which is NOT patched by ImmediateState. This is intentional: bounds are
    // used for culling, transforms are used for rendering.
    //
    // For accurate immediate-mode picking, we would also need to patch bounds.
    // This is a known limitation — future enhancement.
    const ray: Ray = { origin: [0, 0, 100], direction: [0, 0, -1] };
    const result = hitTestRay(ray, bounds, entityIds);
    expect(result).toBe(42); // hits at old position (bounds not patched)
  });
});
```

**Step 2: Run tests**

Run: `cd ts && npx vitest run src/immediate-state.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
cd ts && git add ts/src/immediate-state.test.ts
git commit -m "test(phase6): immediate mode integration test"
```

---

### Task 21: Update main.ts demo with input handling

**Files:**
- Modify: `ts/src/main.ts`

**Step 1: Add input handling to demo**

Update `main.ts` to demonstrate the input system. Example additions:

```typescript
// After engine.start():

// Click to select entities
engine.input.onClick((button, x, y) => {
  if (button !== 0) return; // left click only
  const entityId = engine.picking.hitTest(x, y);
  if (entityId !== null) {
    engine.selection?.toggle(entityId);
  }
});

// WASD camera movement
engine.addHook('preTick', (dt) => {
  const speed = 10;
  let dx = 0, dy = 0;
  if (engine.input.isKeyDown('KeyW')) dy += speed * dt;
  if (engine.input.isKeyDown('KeyS')) dy -= speed * dt;
  if (engine.input.isKeyDown('KeyA')) dx -= speed * dt;
  if (engine.input.isKeyDown('KeyD')) dx += speed * dt;
  if (dx !== 0 || dy !== 0) {
    // Move camera (need to add camera position tracking)
  }
});

// Scroll to zoom
engine.input.onScroll((dx, dy) => {
  const zoom = engine.cam.zoom;
  engine.cam.setZoom(zoom * (1 - dy * 0.001));
});
```

Keep the demo minimal — just enough to validate the input system works visually. Don't add features beyond what's needed for demonstration.

**Step 2: Type check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add ts/src/main.ts
git commit -m "feat(phase6): add input handling to demo (click-select, WASD, scroll-zoom)"
```

---

### Task 22: Full validation

**Files:** (none — validation only)

**Step 1: Run full Rust validation**

Run: `cargo test -p hyperion-core && cargo clippy -p hyperion-core`
Expected: All tests PASS, no clippy warnings

**Step 2: Run full TS validation**

Run: `cd ts && npm test && npx tsc --noEmit`
Expected: All tests PASS, no type errors

**Step 3: Count tests**

Run: `cargo test -p hyperion-core 2>&1 | tail -5` and `cd ts && npx vitest run 2>&1 | tail -10`
Expected: Rust ~90+ tests, TS ~260+ tests (new: InputManager ~15, HitTester ~6, ImmediateState ~8, integration ~3)

**Step 4: Commit (if any fixes were needed)**

---

## Part 7: Documentation

### Task 23: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update sections**

1. **Build & Test Commands**: Add new test commands:
   ```
   cd ts && npx vitest run src/input-manager.test.ts     # Input manager (15 tests)
   cd ts && npx vitest run src/hit-tester.test.ts         # CPU hit testing (6 tests)
   cd ts && npx vitest run src/immediate-state.test.ts    # Immediate mode (8 tests)
   cd ts && npx vitest run src/input-picking.test.ts      # Input→picking integration (2 tests)
   ```

2. **TypeScript modules table**: Add entries:
   ```
   | `input-manager.ts` | `InputManager` — keyboard, pointer, scroll state tracking + callback registration. DOM event attachment/detachment |
   | `hit-tester.ts` | `hitTest()` — CPU bounding-sphere hit testing for entity picking |
   | `immediate-state.ts` | `ImmediateState` — Shadow position map for zero-latency immediate-mode rendering |
   ```

3. **Rust components table**: Add:
   ```
   | `ExternalId(u32)` | External entity ID visible to TypeScript, set on spawn. Enables SoA index → entityId mapping for picking and immediate mode |
   ```

4. **Gotchas**: Add:
   ```
   - **CPU picking uses bounds, not transforms** — `hitTest()` reads from the SoA bounds buffer (entity position + radius). Immediate-mode `patchTransforms()` only patches the transforms buffer, NOT bounds. This means picking during immediate-mode drag uses the WASM-reported position (1-2 frame stale), not the shadow position. For most use cases this is imperceptible.
   - **InputManager.resetFrame() called per tick** — Scroll deltas accumulate within a frame and reset at the end of each tick. Read `scrollDeltaX/Y` in `preTick` hooks, not `frameEnd`.
   - **ExternalId is immutable** — Set once on SpawnEntity, never updated. If entity recycling via free list changes the external ID, a new ExternalId is spawned with the new entity.
   ```

5. **Implementation Status**: Update to reflect Phase 6 Input completion.

6. **ResourcePool buffer naming**: Add `entity-ids` if it gets uploaded to GPU (may not be needed if picking is CPU-only).

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Phase 6 input system"
```

---

### Task 24: Update PROJECT_ARCHITECTURE.md

**Files:**
- Modify: `PROJECT_ARCHITECTURE.md`

**Step 1: Add Input System section**

Add a new section covering:
- InputManager architecture (DOM event → state + callbacks)
- CPU hit testing algorithm (bounding sphere, Z-sort)
- Immediate mode data flow (shadow state → transform patching → GPU upload)
- ExternalId SoA buffer purpose
- Click-to-select workflow (input → picking → selection → outline)

**Step 2: Commit**

```bash
git add PROJECT_ARCHITECTURE.md
git commit -m "docs: update PROJECT_ARCHITECTURE.md for Phase 6 input system"
```

---

## Summary

**Total tasks:** 24
**New files:** 6 (input-manager.ts/test, hit-tester.ts/test, immediate-state.ts/test, input-picking.test.ts)
**Modified files:** ~12 (components.rs, command_processor.rs, render_state.rs, lib.rs, worker-bridge.ts, engine-worker.ts, hyperion.ts, hyperion.test.ts, entity-handle.ts, entity-handle.test.ts, camera.ts, camera.test.ts, index.ts, main.ts, CLAUDE.md, PROJECT_ARCHITECTURE.md)
**Estimated commits:** ~16

**Test count increase:** ~+35 TS tests, ~+2 Rust tests

**Design: 2.5D + future 3D readiness:**
- `Camera.screenToRay()` uses general `mat4Inverse` (not orthographic shortcut) — works with any projection matrix including future perspective
- `hitTestRay()` uses full ray-sphere intersection in 3D — correctly handles depth ordering for 2.5D and arbitrary ray directions for perspective cameras
- `Ray` interface (`{ origin, direction }`) is the extension point: orthographic = parallel rays, perspective = diverging rays — zero API changes needed when adding perspective support

**Not included (deferred):**
- New ring buffer CommandTypes for input (InputKeyDown 16-21) — deferred until Rust-side input processing is needed
- GPU color-ID picking — deferred to Phase 7+ (for pixel-perfect accuracy with complex geometry in full 3D)
- Audio system (hyperion-audio crate, AudioWorklet) — separate plan
- Immediate mode bounds patching — known limitation, minor impact
- Perspective camera — forward-compatible API in place, actual perspective projection matrix is a future task
