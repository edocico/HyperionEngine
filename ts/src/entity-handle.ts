import type { BackpressuredProducer } from './backpressure';
import type { ImmediateState } from './immediate-state';
import type { TextureHandle } from './types';

/** Render primitive type enum (must match Rust RenderPrimitive values). */
export const enum RenderPrimitiveType {
  Quad = 0,
  Line = 1,
  SDFGlyph = 2,
  BezierPath = 3,
  Gradient = 4,
  BoxShadow = 5,
}

/**
 * Opaque handle to an entity, providing a fluent builder API.
 *
 * All setter methods delegate to BackpressuredProducer and return `this`
 * for chaining: `engine.spawn().position(1,2,3).velocity(4,5,6).texture(tex)`.
 *
 * After `destroy()`, all methods throw. `destroy()` is idempotent.
 * Implements `Disposable` for use with `using` declarations.
 *
 * The `init()` method allows pool reuse (EntityHandlePool, Task 4)
 * without allocating new objects — important for avoiding GC pressure.
 */
export class EntityHandle implements Disposable {
  private _id: number = -1;
  private _alive: boolean = false;
  private _producer: BackpressuredProducer | null = null;
  private _immediateState: ImmediateState | null = null;
  private _data: Map<string, unknown> | null = null;

  constructor(id: number, producer: BackpressuredProducer, immediateState?: ImmediateState) {
    this.init(id, producer, immediateState);
  }

  /** The numeric entity ID this handle wraps. */
  get id(): number { return this._id; }

  /** Whether the entity is still alive (not destroyed). */
  get alive(): boolean { return this._alive; }

  /**
   * Re-initialize this handle for pool reuse.
   * Resets the handle with a new ID and producer, clearing any plugin data.
   */
  init(id: number, producer: BackpressuredProducer, immediateState?: ImmediateState): void {
    this._id = id;
    this._alive = true;
    this._producer = producer;
    this._immediateState = immediateState ?? null;
    this._data = null;
  }

  /** Throws if the handle has been destroyed. */
  private check(): void {
    if (!this._alive) throw new Error('EntityHandle has been destroyed');
  }

  /** Set entity position. Returns `this` for chaining. */
  position(x: number, y: number, z: number): this {
    this.check();
    this._producer!.setPosition(this._id, x, y, z);
    return this;
  }

  /**
   * Set entity position with immediate visual feedback.
   *
   * Sends the position through the ring buffer (normal path) AND writes
   * a shadow override to ImmediateState, which patches the SoA transforms
   * buffer before GPU upload. This provides zero-latency visual response
   * even though the ring buffer has a 1-2 frame delay.
   *
   * Returns `this` for chaining.
   */
  positionImmediate(x: number, y: number, z: number): this {
    this.check();
    this._producer!.setPosition(this._id, x, y, z);
    this._immediateState?.set(this._id, x, y, z);
    return this;
  }

  /**
   * Remove the immediate-mode shadow position override for this entity.
   * The entity will revert to the WASM-computed position on the next frame.
   * Returns `this` for chaining.
   */
  clearImmediate(): this {
    this.check();
    this._immediateState?.clear(this._id);
    return this;
  }

  /** Set entity velocity. Returns `this` for chaining. */
  velocity(vx: number, vy: number, vz: number): this {
    this.check();
    this._producer!.setVelocity(this._id, vx, vy, vz);
    return this;
  }

  /** Set entity rotation (quaternion). Returns `this` for chaining. */
  rotation(x: number, y: number, z: number, w: number): this {
    this.check();
    this._producer!.setRotation(this._id, x, y, z, w);
    return this;
  }

  /** Set entity scale. Returns `this` for chaining. */
  scale(sx: number, sy: number, sz: number): this {
    this.check();
    this._producer!.setScale(this._id, sx, sy, sz);
    return this;
  }

  /** Set entity texture layer. Returns `this` for chaining. */
  texture(handle: TextureHandle): this {
    this.check();
    this._producer!.setTextureLayer(this._id, handle);
    return this;
  }

  /** Set entity mesh handle. Returns `this` for chaining. */
  mesh(handle: number): this {
    this.check();
    this._producer!.setMeshHandle(this._id, handle);
    return this;
  }

  /** Set entity render primitive. Returns `this` for chaining. */
  primitive(value: number): this {
    this.check();
    this._producer!.setRenderPrimitive(this._id, value);
    return this;
  }

  /** Set parent entity for scene graph hierarchy. Returns `this` for chaining. */
  parent(parentId: number): this {
    this.check();
    this._producer!.setParent(this._id, parentId);
    return this;
  }

  /** Remove this entity from its parent (sends SetParent with MAX sentinel). Returns `this` for chaining. */
  unparent(): this {
    this.check();
    this._producer!.setParent(this._id, 0xFFFFFFFF);
    return this;
  }

  /** Configure this entity as a line. Returns `this` for chaining. */
  line(x0: number, y0: number, x1: number, y1: number, width: number): this {
    this.check();
    this._producer!.setRenderPrimitive(this._id, RenderPrimitiveType.Line);
    this._producer!.setPrimParams0(this._id, x0, y0, x1, y1);
    this._producer!.setPrimParams1(this._id, width, 0, 0, 0);
    return this;
  }

  /** Configure this entity as a gradient. Returns `this` for chaining. */
  gradient(type: number, angle: number, params: number[]): this {
    this.check();
    this._producer!.setRenderPrimitive(this._id, RenderPrimitiveType.Gradient);
    this._producer!.setPrimParams0(this._id, type, angle, params[0] ?? 0, params[1] ?? 0);
    this._producer!.setPrimParams1(this._id, params[2] ?? 0, params[3] ?? 0, params[4] ?? 0, params[5] ?? 0);
    return this;
  }

  /** Configure this entity as a box shadow. Returns `this` for chaining. */
  boxShadow(rectW: number, rectH: number, cornerRadius: number, blur: number,
            r: number, g: number, b: number, a: number): this {
    this.check();
    this._producer!.setRenderPrimitive(this._id, RenderPrimitiveType.BoxShadow);
    this._producer!.setPrimParams0(this._id, rectW, rectH, cornerRadius, blur);
    this._producer!.setPrimParams1(this._id, r, g, b, a);
    return this;
  }

  /**
   * Get or set plugin data on this entity handle.
   * Data is stored per-key and cleared on `init()` (pool reuse).
   *
   * @param key - Plugin-specific key (e.g., 'physics', 'ai').
   * @param value - If provided, sets the data and returns `this` for chaining.
   *                If omitted, returns the stored value or `undefined`.
   */
  data(key: string): unknown;
  data(key: string, value: unknown): this;
  data(key: string, value?: unknown): unknown | this {
    this.check();
    if (arguments.length === 1) {
      return this._data?.get(key);
    }
    if (!this._data) this._data = new Map();
    this._data.set(key, value);
    return this;
  }

  /**
   * Destroy the entity: sends DespawnEntity and marks the handle dead.
   * Idempotent — calling twice does not throw or send a second despawn.
   */
  destroy(): void {
    if (!this._alive) return;
    this._immediateState?.clear(this._id);
    this._producer!.despawnEntity(this._id);
    this._alive = false;
    this._producer = null;
    this._immediateState = null;
  }

  /** Disposable protocol — same as `destroy()`. */
  [Symbol.dispose](): void {
    this.destroy();
  }
}
