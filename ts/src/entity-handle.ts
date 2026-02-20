import type { BackpressuredProducer } from './backpressure';
import type { TextureHandle } from './types';

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
  private _data: Map<string, unknown> | null = null;

  constructor(id: number, producer: BackpressuredProducer) {
    this.init(id, producer);
  }

  /** The numeric entity ID this handle wraps. */
  get id(): number { return this._id; }

  /** Whether the entity is still alive (not destroyed). */
  get alive(): boolean { return this._alive; }

  /**
   * Re-initialize this handle for pool reuse.
   * Resets the handle with a new ID and producer, clearing any plugin data.
   */
  init(id: number, producer: BackpressuredProducer): void {
    this._id = id;
    this._alive = true;
    this._producer = producer;
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
    this._producer!.despawnEntity(this._id);
    this._alive = false;
    this._producer = null;
  }

  /** Disposable protocol — same as `destroy()`. */
  [Symbol.dispose](): void {
    this.destroy();
  }
}
