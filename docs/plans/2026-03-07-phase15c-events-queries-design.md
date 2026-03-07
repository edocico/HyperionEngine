# Phase 15c — Events + Scene Queries: Design Document

> **Date**: 2026-03-07
> **Status**: Approved
> **Scope**: Collision event WASM exports, PhysicsAPI with callbacks, sensor sugar, raycast, AABB overlap, circle overlap (Mode C only)
> **Prerequisites**: Phase 15b complete (PhysicsWorld, step, sync pre/post, event accumulation, despawn cleanup)
> **Design doc parent**: `docs/plans/2026-03-07-phase15-physics-rapier2d-design.md`

---

## 1. Scope & Deliverables

| Deliverable | Layer | Description |
|---|---|---|
| WASM event exports | Rust | `engine_collision_events_ptr/count`, `engine_contact_force_events_ptr/count` |
| `is_sensor` in events | Rust | Add field to `HyperionCollisionEvent` via `CollisionEvent::sensor()` |
| `drainCollisionEvents()` | TS | Parse flat WASM buffer → typed event array (Mode B/A seam) |
| `drainContactForceEvents()` | TS | Same for contact force events |
| `PhysicsAPI` | TS | `onCollisionStart/End` (unified, receives `isSensor`), `onContactForce` |
| Sensor sugar | TS | `onSensorEnter/Exit(entityId, cb)` — pure TS filter over unified callbacks |
| Raycast | Rust+TS | `engine_physics_raycast()` via `cast_ray_and_get_normal` → `{ entityId, toi, normalX, normalY }` |
| AABB overlap | Rust+TS | `engine_physics_overlap_aabb()` → `number[]` entity IDs (deduplicated) |
| Circle overlap | Rust+TS | `engine_physics_overlap_circle()` via `intersect_shape(Ball)` → `number[]` (deduplicated) |

**Not in scope:** Mode B/A dispatch, debug rendering, joints, character controller, snapshot/restore, `engine_physics_contact_info`.

**Dropped: `engine_physics_contact_info`** — TS-side `Set<string>` maintained from `onCollisionStart/End` callbacks covers the "are A and B touching?" use case without additional WASM exports.

---

## 2. Errata from Phase 15 Design Doc

| Original Design Doc | Corrected (This Doc) |
|---|---|
| `QueryPipeline` persistent with `.update()` | Ephemeral: `broad_phase.as_query_pipeline()` returns `QueryPipeline<'a>` — no persistent version in Rapier 0.32 |
| `broad_phase.as_query_pipeline()` unverified | Verified: takes `(dispatcher, &bodies, &colliders, QueryFilter)`, returns lifetime-bound view |
| `Ray::new(Point, Vector)` | `Ray::new(Vector, Vector)` — both params are `Vector` (= `Vec2` in parry2d dim2) |
| `Pose` type uncertain | `Pose` is type alias for `Pose2` in parry2d dim2, re-exported via `rapier2d::prelude` |
| `RayIntersection.toi` | `RayIntersection.time_of_impact` — field name confirmed in parry2d source |
| `Aabb::new(Point, Point)` | `Aabb::new(Vector, Vector)` — both params are `Vector` in parry2d dim2 |
| `intersections_with_shape` method name | `intersect_shape(pose: Pose, shape: &dyn Shape) -> impl Iterator<Item = (ColliderHandle, &Collider)>` |
| `CollisionEvent.sensor()` unverified | Verified: `pub fn sensor(self) -> bool` checks `CollisionEventFlags::SENSOR` |

---

## 3. Event Buffer Layout

### 3.1 HyperionCollisionEvent (modified)

Current struct (15b) uses `started: bool` — not `#[repr(C)]`, not Pod-compatible.

New struct for flat buffer WASM export:

```rust
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HyperionCollisionEvent {
    pub entity_a: u32,       // 4B
    pub entity_b: u32,       // 4B
    pub event_type: u8,      // 1B (0=started, 1=stopped)
    pub is_sensor: u8,       // 1B
    pub _pad: [u8; 2],       // 2B alignment
}  // 12 bytes total, 4-byte aligned
```

### 3.2 HyperionContactForceEvent (modified)

Current struct (15b) has 3 fields. Adding direction from Rapier's `ContactForceEvent.max_force_direction`:

```rust
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HyperionContactForceEvent {
    pub entity_a: u32,                  // 4B
    pub entity_b: u32,                  // 4B
    pub total_force_magnitude: f32,     // 4B
    pub max_force_direction_x: f32,     // 4B
    pub max_force_direction_y: f32,     // 4B
}  // 20 bytes total, naturally aligned
```

### 3.3 translate_collision change

```rust
fn translate_collision(&mut self, event: CollisionEvent) {
    let h1 = event.collider1();
    let h2 = event.collider2();
    if let (Some(entity_a), Some(entity_b)) =
        (self.collider_handle_to_entity(h1), self.collider_handle_to_entity(h2))
    {
        self.frame_collision_events.push(HyperionCollisionEvent {
            entity_a,
            entity_b,
            event_type: if event.started() { 0 } else { 1 },
            is_sensor: if event.sensor() { 1 } else { 0 },
            _pad: [0; 2],
        });
    }
}
```

### 3.4 translate_contact_force change

```rust
fn translate_contact_force(&mut self, event: ContactForceEvent) {
    if let (Some(entity_a), Some(entity_b)) = (
        self.collider_handle_to_entity(event.collider1),
        self.collider_handle_to_entity(event.collider2),
    ) {
        self.frame_contact_force_events.push(HyperionContactForceEvent {
            entity_a,
            entity_b,
            total_force_magnitude: event.total_force_magnitude,
            max_force_direction_x: event.max_force_direction.x,
            max_force_direction_y: event.max_force_direction.y,
        });
    }
}
```

### 3.5 WASM Event Exports (4 new)

```rust
#[wasm_bindgen] pub fn engine_collision_events_ptr() -> *const u8
#[wasm_bindgen] pub fn engine_collision_events_count() -> u32
#[wasm_bindgen] pub fn engine_contact_force_events_ptr() -> *const u8
#[wasm_bindgen] pub fn engine_contact_force_events_count() -> u32
```

Pattern: expose Vec's raw pointer + len via `addr_of_mut!()`. Zero copy. TS reads via DataView at known offsets. Buffer valid from `engine_update()` return until next `engine_update()` call. **TS must not cache the pointer across frames** — Vec may reallocate between frames if event count exceeds prior capacity.

No `engine_collision_event_size()` export — the struct size (12 bytes) is a compile-time constant known to both Rust and TS.

---

## 4. Scene Queries

### 4.1 QueryPipeline — Ephemeral

Rapier 0.32's `QueryPipeline<'a>` is a lifetime-bound view, not a stored struct. Created on-demand per query:

```rust
// Inline in each query method (not centralized) to allow per-method QueryFilter
let qp = self.broad_phase.as_query_pipeline(
    self.narrow_phase.query_dispatcher(),
    &self.rigid_body_set,
    &self.collider_set,
    QueryFilter::default(), // per-method, can change independently for future filtering
);
```

No stored `QueryPipeline` field on `PhysicsWorld`. The BVH is already updated by `step()`, so the view is always current. Creating it on-demand for each query means each method can use different `QueryFilter` in the future (e.g., `EXCLUDE_SENSORS` for line-of-sight raycast).

### 4.2 Static Buffers

All static buffers use `addr_of_mut!()` per Rust 2024 edition:

```rust
static mut RAYCAST_RESULT: [f32; 3] = [0.0; 3]; // [time_of_impact, normal_x, normal_y]
static mut OVERLAP_RESULTS: Vec<u32> = Vec::new();
```

`OVERLAP_RESULTS` is shared between AABB and circle overlap — calling one invalidates the previous result. TS reads immediately after each query.

### 4.3 Raycast

Uses `cast_ray_and_get_normal` for normal vector:

```rust
impl PhysicsWorld {
    pub fn raycast(&self, ox: f32, oy: f32, dx: f32, dy: f32, max_toi: f32) -> i32 {
        let qp = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.rigid_body_set,
            &self.collider_set,
            QueryFilter::default(),
        );
        let ray = Ray::new(Vector::new(ox, oy), Vector::new(dx, dy));
        match qp.cast_ray_and_get_normal(&ray, max_toi, true) {
            Some((col_handle, hit)) => {
                // SAFETY: wasm32 is single-threaded
                unsafe {
                    *addr_of_mut!(RAYCAST_RESULT) = [
                        hit.time_of_impact,
                        hit.normal.x,
                        hit.normal.y,
                    ];
                }
                self.collider_handle_to_entity(col_handle)
                    .map(|id| id as i32)
                    .unwrap_or(-1)
            }
            None => -1,
        }
    }
}
```

Returns external entity ID (i32, ≥ 0) on hit, -1 on miss. toi + normal written to `RAYCAST_RESULT`.

### 4.4 AABB Overlap

Uses `intersect_aabb_conservative` — BVH-level AABB test. Conservative (may include false positives from loose BVH bounds). Results deduplicated (entity with multiple colliders appears once):

```rust
impl PhysicsWorld {
    pub fn overlap_aabb(&self, min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> u32 {
        let qp = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.rigid_body_set,
            &self.collider_set,
            QueryFilter::default(),
        );
        let aabb = Aabb::new(Vector::new(min_x, min_y), Vector::new(max_x, max_y));
        // SAFETY: wasm32 is single-threaded
        let results = unsafe { &mut *addr_of_mut!(OVERLAP_RESULTS) };
        results.clear();
        for (col_handle, _) in qp.intersect_aabb_conservative(aabb) {
            if let Some(ext_id) = self.collider_handle_to_entity(col_handle) {
                results.push(ext_id);
            }
        }
        results.sort_unstable();
        results.dedup();
        results.len() as u32
    }
}
```

### 4.5 Circle Overlap

Uses `intersect_shape` with `Ball::new(radius)` — exact narrow-phase intersection:

```rust
impl PhysicsWorld {
    pub fn overlap_circle(&self, cx: f32, cy: f32, radius: f32) -> u32 {
        let qp = self.broad_phase.as_query_pipeline(
            self.narrow_phase.query_dispatcher(),
            &self.rigid_body_set,
            &self.collider_set,
            QueryFilter::default(),
        );
        let shape = Ball::new(radius);
        let pose = Pose::translation(cx, cy);
        // SAFETY: wasm32 is single-threaded
        let results = unsafe { &mut *addr_of_mut!(OVERLAP_RESULTS) };
        results.clear();
        for (col_handle, _) in qp.intersect_shape(pose, &shape) {
            if let Some(ext_id) = self.collider_handle_to_entity(col_handle) {
                results.push(ext_id);
            }
        }
        results.sort_unstable();
        results.dedup();
        results.len() as u32
    }
}
```

### 4.6 WASM Query Exports (5 new)

| Export | Signature | Returns |
|---|---|---|
| `engine_physics_raycast` | `(ox, oy, dx, dy, max_toi) → i32` | Entity ID or -1 |
| `engine_physics_raycast_result_ptr` | `() → *const f32` | Ptr to `[toi, nx, ny]` |
| `engine_physics_overlap_aabb` | `(min_x, min_y, max_x, max_y) → u32` | Count |
| `engine_physics_overlap_circle` | `(cx, cy, radius) → u32` | Count |
| `engine_physics_overlap_results_ptr` | `() → *const u32` | Ptr to entity ID array |

**Total WASM exports for 15c: 9** (4 events + 5 queries).

---

## 5. TypeScript — PhysicsAPI

### 5.1 New File: `ts/src/physics-api.ts`

### 5.2 Types

```typescript
export interface CollisionEvent {
  entityA: number;
  entityB: number;
  started: boolean;
  isSensor: boolean;
}

export interface ContactForceEvent {
  entityA: number;
  entityB: number;
  totalForceMagnitude: number;
  directionX: number;
  directionY: number;
}

export interface RaycastHit {
  entityId: number;
  toi: number;
  normalX: number;
  normalY: number;
}

type CollisionCallback = (entityA: number, entityB: number, isSensor: boolean) => void;
type ContactForceCallback = (entityA: number, entityB: number, force: number, dirX: number, dirY: number) => void;
type SensorCallback = (otherEntityId: number) => void;
```

### 5.3 Drain Functions (Mode B/A Seam)

Standalone exported functions. Parse flat WASM buffer into typed JS objects. In Mode C, called by `_dispatch` to copy data out before firing callbacks. In future Mode B/A, Worker calls these and transfers results via `postMessage`.

```typescript
const COLLISION_EVENT_SIZE = 12;
const CONTACT_FORCE_EVENT_SIZE = 20;

export function drainCollisionEvents(
  memory: ArrayBuffer, ptr: number, count: number,
): CollisionEvent[] {
  if (count === 0) return [];
  const dv = new DataView(memory);
  const events: CollisionEvent[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const off = ptr + i * COLLISION_EVENT_SIZE;
    events[i] = {
      entityA: dv.getUint32(off, true),
      entityB: dv.getUint32(off + 4, true),
      started: dv.getUint8(off + 8) === 0,
      isSensor: dv.getUint8(off + 9) !== 0,
    };
  }
  return events;
}

export function drainContactForceEvents(
  memory: ArrayBuffer, ptr: number, count: number,
): ContactForceEvent[] {
  if (count === 0) return [];
  const dv = new DataView(memory);
  const events: ContactForceEvent[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const off = ptr + i * CONTACT_FORCE_EVENT_SIZE;
    events[i] = {
      entityA: dv.getUint32(off, true),
      entityB: dv.getUint32(off + 4, true),
      totalForceMagnitude: dv.getFloat32(off + 8, true),
      directionX: dv.getFloat32(off + 12, true),
      directionY: dv.getFloat32(off + 16, true),
    };
  }
  return events;
}
```

### 5.4 PhysicsAPI Class

Always present on `engine.physics`. Safe no-ops when WASM not available (same pattern as `AudioManager`). Callbacks never fire if physics is disabled.

```typescript
export class PhysicsAPI {
  private _wasm: PhysicsWasmExports | null = null;
  private _startCbs: CollisionCallback[] = [];
  private _endCbs: CollisionCallback[] = [];
  private _forceCbs: ContactForceCallback[] = [];
  private _sensorEnter = new Map<number, SensorCallback[]>();
  private _sensorExit = new Map<number, SensorCallback[]>();
```

**Callback registration** — returns unsubscribe function:

```typescript
  onCollisionStart(cb: CollisionCallback): () => void {
    this._startCbs.push(cb);
    return () => { this._startCbs = this._startCbs.filter(c => c !== cb); };
  }
  onCollisionEnd(cb: CollisionCallback): () => void { /* symmetric */ }
  onContactForce(cb: ContactForceCallback): () => void { /* symmetric */ }
```

**Sensor sugar** — filters internally by entity ID, bidirectional check:

```typescript
  onSensorEnter(sensorEntityId: number, cb: SensorCallback): () => void {
    const arr = this._sensorEnter.get(sensorEntityId) ?? [];
    arr.push(cb);
    this._sensorEnter.set(sensorEntityId, arr);
    return () => {
      const a = this._sensorEnter.get(sensorEntityId);
      if (a) {
        const filtered = a.filter(c => c !== cb);
        if (filtered.length === 0) this._sensorEnter.delete(sensorEntityId);
        else this._sensorEnter.set(sensorEntityId, filtered);
      }
    };
  }
  onSensorExit(sensorEntityId: number, cb: SensorCallback): () => void { /* symmetric */ }
```

### 5.5 Event Dispatch — Two-Phase for WASM Memory Safety

**Critical**: User callbacks may trigger synchronous WASM calls (e.g., `physics.queryCircle()`) which can cause `memory.grow`, detaching the `ArrayBuffer`. All event data must be copied out of WASM memory **before** any callbacks fire.

```typescript
  /** @internal Called after engine_update in tick loop */
  _dispatch(): void {
    if (!this._wasm) return;

    // Phase 1: Copy ALL data out of WASM memory (before any callbacks)
    const mem = this._wasm.memory.buffer;
    const colCount = this._wasm.engine_collision_events_count();
    const colEvents = colCount > 0
      ? drainCollisionEvents(mem, this._wasm.engine_collision_events_ptr(), colCount)
      : null;
    const forceCount = this._wasm.engine_contact_force_events_count();
    const forceEvents = forceCount > 0
      ? drainContactForceEvents(mem, this._wasm.engine_contact_force_events_ptr(), forceCount)
      : null;

    // Phase 2: Dispatch from copied data (WASM memory no longer referenced)
    if (colEvents) {
      // Snapshot callback arrays ONCE (O(1), not O(events))
      const startCbs = [...this._startCbs];
      const endCbs = [...this._endCbs];
      for (const e of colEvents) {
        const cbs = e.started ? startCbs : endCbs;
        for (const cb of cbs) cb(e.entityA, e.entityB, e.isSensor);

        if (e.isSensor) {
          const map = e.started ? this._sensorEnter : this._sensorExit;
          const cbsA = map.get(e.entityA);
          if (cbsA) for (const cb of cbsA) cb(e.entityB);
          const cbsB = map.get(e.entityB);
          if (cbsB) for (const cb of cbsB) cb(e.entityA);
        }
      }
    }

    if (forceEvents) {
      const forceCbs = [...this._forceCbs];
      for (const e of forceEvents) {
        for (const cb of forceCbs) cb(e.entityA, e.entityB, e.totalForceMagnitude, e.directionX, e.directionY);
      }
    }
  }
```

### 5.6 Scene Queries (synchronous WASM calls)

```typescript
  raycast(ox: number, oy: number, dx: number, dy: number, maxDist: number): RaycastHit | null {
    if (!this._wasm) return null;
    const entityId = this._wasm.engine_physics_raycast(ox, oy, dx, dy, maxDist);
    if (entityId < 0) return null;
    const ptr = this._wasm.engine_physics_raycast_result_ptr();
    const dv = new DataView(this._wasm.memory.buffer);
    return {
      entityId,
      toi: dv.getFloat32(ptr, true),
      normalX: dv.getFloat32(ptr + 4, true),
      normalY: dv.getFloat32(ptr + 8, true),
    };
  }

  queryAABB(minX: number, minY: number, maxX: number, maxY: number): number[] {
    if (!this._wasm) return [];
    const count = this._wasm.engine_physics_overlap_aabb(minX, minY, maxX, maxY);
    if (count === 0) return [];
    const ptr = this._wasm.engine_physics_overlap_results_ptr();
    return Array.from(new Uint32Array(this._wasm.memory.buffer, ptr, count));
  }

  queryCircle(cx: number, cy: number, radius: number): number[] {
    if (!this._wasm) return [];
    const count = this._wasm.engine_physics_overlap_circle(cx, cy, radius);
    if (count === 0) return [];
    const ptr = this._wasm.engine_physics_overlap_results_ptr();
    return Array.from(new Uint32Array(this._wasm.memory.buffer, ptr, count));
  }
```

### 5.7 Destroy

```typescript
  destroy(): void {
    this._wasm = null;
    this._startCbs.length = 0;
    this._endCbs.length = 0;
    this._forceCbs.length = 0;
    this._sensorEnter.clear();
    this._sensorExit.clear();
  }
```

---

## 6. Integration Points

### 6.1 Tick Loop Wiring (Mode C)

```
Hyperion.tick(dt)
  → preTick hooks (previous-frame systemViews)
  → bridge.tick(dt)              // engine_update(dt): clears events → N fixed ticks → accumulates events
  → this.physics._dispatch()     // reads event buffers (two-phase), fires callbacks
  → re-read _systemViews         // current-frame views (safe: creates new TypedArray from current memory)
  → postTick hooks (current-frame systemViews — callbacks already fired)
  → render
  → frameEnd hooks
```

`_dispatch()` is called **after** `bridge.tick()` and **before** the `_systemViews` re-read. This ensures:
- Event buffers are stable (filled by `engine_update`, not touched until next `engine_update`)
- Collision callbacks fire before `postTick` hooks, so plugins can react to collisions
- The `_systemViews` re-read creates fresh TypedArray views from `memory.buffer`, safe even if a callback triggered `memory.grow`

### 6.2 PhysicsAPI Initialization

```typescript
// PhysicsWasmExports interface (the 9 exports):
interface PhysicsWasmExports {
  memory: WebAssembly.Memory;
  engine_collision_events_ptr(): number;
  engine_collision_events_count(): number;
  engine_contact_force_events_ptr(): number;
  engine_contact_force_events_count(): number;
  engine_physics_raycast(ox: number, oy: number, dx: number, dy: number, max_toi: number): number;
  engine_physics_raycast_result_ptr(): number;
  engine_physics_overlap_aabb(min_x: number, min_y: number, max_x: number, max_y: number): number;
  engine_physics_overlap_circle(cx: number, cy: number, radius: number): number;
  engine_physics_overlap_results_ptr(): number;
}
```

`_init(wasmExports)` called only when physics WASM build is loaded. Standard WASM build → `_wasm` stays null → all methods are safe no-ops.

### 6.3 Hyperion Facade

```typescript
class Hyperion {
  readonly physics: PhysicsAPI = new PhysicsAPI();
  // In tick: this.physics._dispatch();
  // In destroy: this.physics.destroy();
}
```

---

## 7. File Changes Summary

| File | Change |
|---|---|
| `crates/hyperion-core/src/physics.rs` | `HyperionCollisionEvent` → `#[repr(C)]` with `event_type: u8`, `is_sensor: u8`, `_pad`. `HyperionContactForceEvent` → add `max_force_direction_x/y`. `translate_collision` → add `event.sensor()`. `translate_contact_force` → add direction. Add `raycast()`, `overlap_aabb()`, `overlap_circle()` on `PhysicsWorld`. Static buffers. |
| `crates/hyperion-core/src/lib.rs` | 9 new `#[wasm_bindgen]` exports (4 events + 5 queries) |
| `ts/src/physics-api.ts` | **New.** `PhysicsAPI` class, `drainCollisionEvents/drainContactForceEvents`, types |
| `ts/src/hyperion.ts` | Add `readonly physics: PhysicsAPI`. Call `_dispatch()` in tick. Call `destroy()` in destroy. |
| `ts/src/index.ts` | Barrel export `PhysicsAPI`, event types, `RaycastHit` |

---

## 8. Testing Strategy

### 8.1 Rust Tests (in `physics.rs`, `#[cfg(feature = "physics-2d")]`)

| Test | Validates |
|---|---|
| `collision_event_repr_c_size` | `size_of::<HyperionCollisionEvent>() == 12` |
| `contact_force_event_repr_c_size` | `size_of::<HyperionContactForceEvent>() == 20` |
| `collision_event_has_is_sensor` | New struct field accessible |
| `sensor_event_flagged_correctly` | Sensor collider → `is_sensor = 1` in translated event |
| `raycast_hits_collider` | Ball at known position → correct entity ID + toi + normal |
| `raycast_misses_empty_world` | Returns -1 |
| `overlap_aabb_finds_entities` | Two bodies in region → returns both IDs |
| `overlap_aabb_deduplicates` | Entity with 2 colliders → appears once |
| `overlap_circle_finds_entities` | Body within radius → found |
| `overlap_circle_excludes_outside` | Body outside radius → not found |

### 8.2 TS Tests (new `ts/src/physics-api.test.ts`)

| Test | Validates |
|---|---|
| `drainCollisionEvents parses 12-byte events` | Buffer layout parsing correctness |
| `drainCollisionEvents returns empty for count 0` | Edge case |
| `drainContactForceEvents parses 20-byte events` | Buffer layout parsing correctness |
| `onCollisionStart fires callback` | Callback registration + dispatch |
| `onCollisionEnd fires callback` | Symmetric to start |
| `onContactForce fires callback with direction` | Force callback with 5 args |
| `unsubscribe removes callback` | Return value from `on*` methods |
| `onSensorEnter filters by entity ID` | Sugar method bidirectional check |
| `onSensorExit filters by entity ID` | Symmetric |
| `raycast returns null when no WASM` | Safe no-op |
| `queryAABB returns empty when no WASM` | Safe no-op |
| `destroy clears all callbacks` | Lifecycle cleanup |
| `dispatch survives WASM call in callback` | Two-phase drain prevents DataView invalidation |

**Estimated: ~10 Rust + ~13 TS tests** (meets original design doc target of 12+ Rust, 10+ TS for 15c).

---

## 9. Design Corrections Incorporated

Summary of corrections discovered and applied during the brainstorming process:

1. **QueryPipeline ephemeral** — Rapier 0.32 has no persistent `QueryPipeline::new()` / `.update()`. The 15b code comment was already correct.
2. **`Ray::new(Vector, Vector)`** — both params are `Vector` in parry2d dim2, not `Point` for origin.
3. **`Pose` = `Pose2`** — type alias, re-exported via `rapier2d::prelude`.
4. **`time_of_impact`** — not `toi` — is the field name on `RayIntersection`.
5. **Entity dedup** — `sort_unstable()` + `dedup()` after collecting overlap results.
6. **QueryFilter inline per-method** — not centralized helper, allows per-query filtering in future.
7. **Two-phase dispatch** — drain all data before firing any callbacks (WASM memory safety).
8. **Spread copy once outside loop** — O(1) snapshot, not O(events) per-event copies.
9. **`addr_of_mut!()`** — for all static buffer access per Rust 2024 edition.
