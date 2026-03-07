// ── Types ──────────────────────────────────────────────────────

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

// ── WASM interface ─────────────────────────────────────────────

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

// ── Drain functions (Mode B/A seam) ────────────────────────────

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

// ── PhysicsAPI ─────────────────────────────────────────────────

export class PhysicsAPI {
  private _wasm: PhysicsWasmExports | null = null;
  private _startCbs: CollisionCallback[] = [];
  private _endCbs: CollisionCallback[] = [];
  private _forceCbs: ContactForceCallback[] = [];
  private _sensorEnter = new Map<number, SensorCallback[]>();
  private _sensorExit = new Map<number, SensorCallback[]>();

  /** @internal Called by Hyperion when physics WASM build is loaded. */
  _init(wasm: PhysicsWasmExports): void {
    this._wasm = wasm;
  }

  onCollisionStart(cb: CollisionCallback): () => void {
    this._startCbs.push(cb);
    return () => { this._startCbs = this._startCbs.filter(c => c !== cb); };
  }

  onCollisionEnd(cb: CollisionCallback): () => void {
    this._endCbs.push(cb);
    return () => { this._endCbs = this._endCbs.filter(c => c !== cb); };
  }

  onContactForce(cb: ContactForceCallback): () => void {
    this._forceCbs.push(cb);
    return () => { this._forceCbs = this._forceCbs.filter(c => c !== cb); };
  }

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

  onSensorExit(sensorEntityId: number, cb: SensorCallback): () => void {
    const arr = this._sensorExit.get(sensorEntityId) ?? [];
    arr.push(cb);
    this._sensorExit.set(sensorEntityId, arr);
    return () => {
      const a = this._sensorExit.get(sensorEntityId);
      if (a) {
        const filtered = a.filter(c => c !== cb);
        if (filtered.length === 0) this._sensorExit.delete(sensorEntityId);
        else this._sensorExit.set(sensorEntityId, filtered);
      }
    };
  }

  /** @internal Called after engine_update in tick loop. Two-phase dispatch. */
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

  destroy(): void {
    this._wasm = null;
    this._startCbs.length = 0;
    this._endCbs.length = 0;
    this._forceCbs.length = 0;
    this._sensorEnter.clear();
    this._sensorExit.clear();
  }
}
