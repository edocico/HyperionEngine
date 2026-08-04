import type { BackpressuredProducer } from './backpressure';
import type { ImmediateState } from './immediate-state';
import type { TextureHandle } from './types';
import type { JointHandle, CharacterControllerConfig } from './physics-api';

/** Optional collider properties, applicable at creation time or later. */
export interface ColliderOptions {
  /** Trigger volume: reports overlaps but does not resolve them. */
  sensor?: boolean;
  density?: number;
  friction?: number;
  restitution?: number;
  /** Collision layers: 16-bit membership + 16-bit filter. */
  groups?: { membership: number; filter: number };
  /** Rapier event reporting. Sensors default to `{ collision: true }`. */
  events?: { collision?: boolean; contactForce?: boolean };
}

/** Render primitive type enum (must match Rust RenderPrimitive values). */
export const enum RenderPrimitiveType {
  Quad = 0,
  Line = 1,
  SDFGlyph = 2,
  BezierPath = 3,
  Gradient = 4,
  BoxShadow = 5,
  /**
   * A 2D light. The one primitive type the ForwardPass never draws — no shader
   * is registered for it, so the per-type pipeline loop never finds it and
   * `LightAccumPass` reads its draw bucket directly.
   */
  Light2D = 6,
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

  /** Set entity rotation. 1 arg = 2D angle (radians). 4 args = quaternion (x,y,z,w). */
  rotation(angleOrQx: number, qy?: number, qz?: number, qw?: number): this {
    this.check();
    if (qy === undefined) {
      this._producer!.setRotation2D(this._id, angleOrQx);
    } else {
      this._producer!.setRotation(this._id, angleOrQx, qy!, qz!, qw!);
    }
    return this;
  }

  /** Set entity scale. Returns `this` for chaining. */
  scale(sx: number, sy: number, sz: number): this {
    this.check();
    this._producer!.setScale(this._id, sx, sy, sz);
    return this;
  }

  /** Set entity depth for 2.5D layering. Returns `this` for chaining. */
  depth(z: number): this {
    this.check();
    this._producer!.setDepth(this._id, z);
    return this;
  }

  /** Mark entity as transparent (enables back-to-front sorting). Returns `this` for chaining. */
  transparent(): this {
    this.check();
    this._producer!.setTransparent(this._id, 1);
    return this;
  }

  /** Mark entity as opaque (default, front-to-back sorting). Returns `this` for chaining. */
  opaque(): this {
    this.check();
    this._producer!.setTransparent(this._id, 0);
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

  /** Configure this entity as a quadratic Bezier curve. Returns `this` for chaining. */
  bezier(p0x: number, p0y: number, p1x: number, p1y: number,
         p2x: number, p2y: number, width: number): this {
    this.check();
    this._producer!.setRenderPrimitive(this._id, RenderPrimitiveType.BezierPath);
    this._producer!.setPrimParams0(this._id, p0x, p0y, p1x, p1y);
    this._producer!.setPrimParams1(this._id, p2x, p2y, width, 0);
    return this;
  }

  // ── Physics ──────────────────────────────────────

  /** Create a rigid body for this entity. Returns `this` for chaining. */
  rigidBody(type: 'dynamic' | 'static' | 'kinematic'): this {
    this.check();
    const bodyTypeMap: Record<string, number> = { dynamic: 0, static: 1, kinematic: 2 };
    this._producer!.createRigidBody(this._id, bodyTypeMap[type]);
    return this;
  }

  /**
   * Create a collider for this entity. Returns `this` for chaining.
   *
   * Note the shape conventions differ: `box` takes FULL width/height, `capsule`
   * takes a HALF height plus a radius.
   *
   * The optional `opts` fields below (sensor, density, friction, restitution,
   * groups, events) are applied even when issued in the same batch as the
   * collider creation — they are staged onto the pending collider and consumed
   * when the Rapier collider is built.
   */
  collider(shape: 'circle', opts: { radius: number } & ColliderOptions): this;
  collider(shape: 'box', opts: { width: number; height: number } & ColliderOptions): this;
  collider(shape: 'capsule', opts: { halfHeight: number; radius: number } & ColliderOptions): this;
  collider(shape: string, opts: Record<string, any> & ColliderOptions): this {
    this.check();
    const shapeMap: Record<string, number> = { circle: 0, box: 1, capsule: 2 };
    const st = shapeMap[shape] ?? 0;
    let p0 = 0, p1 = 0, p2 = 0;
    switch (shape) {
      case 'circle': p0 = opts.radius; break;
      case 'box': p0 = opts.width; p1 = opts.height; break;
      case 'capsule': p0 = opts.halfHeight; p1 = opts.radius; break;
    }
    this._producer!.createCollider(this._id, st, p0, p1, p2);

    const o: ColliderOptions = opts;
    if (o.sensor !== undefined) this._producer!.setColliderSensor(this._id, o.sensor);
    if (o.density !== undefined) this._producer!.setColliderDensity(this._id, o.density);
    if (o.friction !== undefined) this._producer!.setColliderFriction(this._id, o.friction);
    if (o.restitution !== undefined) {
      this._producer!.setColliderRestitution(this._id, o.restitution);
    }
    if (o.groups !== undefined) {
      this._producer!.setCollisionGroups(this._id, o.groups.membership, o.groups.filter);
    }
    // A sensor with no events reports nothing, which is never what anyone wants,
    // so sensors opt into collision events unless told otherwise.
    const wantsEvents = o.events ?? (o.sensor === true ? { collision: true } : undefined);
    if (wantsEvents !== undefined) {
      this._producer!.setColliderEvents(
        this._id,
        wantsEvents.collision ?? false,
        wantsEvents.contactForce ?? false,
      );
    }
    return this;
  }

  /**
   * Enable Rapier event reporting for this entity's collider.
   *
   * Colliders are created with events OFF for performance, so without this no
   * `onCollisionStart` / `onSensorEnter` / `onContactForce` callback can fire
   * for this entity.
   */
  colliderEvents(collision: boolean, contactForce = false): this {
    this.check();
    this._producer!.setColliderEvents(this._id, collision, contactForce);
    return this;
  }

  /**
   * Reposition this entity's physics body.
   *
   * `position()` alone is not enough for a body Rapier owns (dynamic or fixed):
   * the simulation writes its transform back every tick. Use this for respawns
   * and hard cuts; pass `zeroVelocity: false` to keep momentum.
   */
  teleport(x: number, y: number, rot = 0, zeroVelocity = true): this {
    this.check();
    this._producer!.teleportBody(this._id, x, y, rot, zeroVelocity);
    return this;
  }

  /**
   * Pin an explicit culling / hit-test radius.
   *
   * By default the radius is derived from the entity's world matrix each frame,
   * which is right for anything whose extents follow its scale. Pin it for
   * primitives whose visual size comes from `PrimitiveParams` instead (lines,
   * box shadows, bezier curves). Pass a negative value to go back to automatic.
   */
  boundingRadius(radius: number): this {
    this.check();
    this._producer!.setBoundingRadius(this._id, radius);
    return this;
  }

  /** Remove this entity's character controller, keeping the entity itself. */
  destroyCharacterController(): this {
    this.check();
    this._producer!.destroyCharacterController(this._id);
    return this;
  }

  /**
   * Override the character controller's "up" axis.
   *
   * Defaults to the opposite of gravity, which is what a platformer wants. Set
   * it explicitly for e.g. a top-down game with zero gravity.
   */
  characterUp(ux: number, uy: number): this {
    this.check();
    this._producer!.setCharacterUp(this._id, ux, uy);
    return this;
  }

  /** Set gravity scale for this entity's rigid body. Returns `this` for chaining. */
  gravityScale(scale: number): this {
    this.check();
    this._producer!.setGravityScale(this._id, scale);
    return this;
  }

  /** Set linear damping for this entity's rigid body. Returns `this` for chaining. */
  linearDamping(damping: number): this {
    this.check();
    this._producer!.setLinearDamping(this._id, damping);
    return this;
  }

  /** Apply a force (accumulated until next physics step). Returns `this` for chaining. */
  applyForce(fx: number, fy: number): this {
    this.check();
    this._producer!.applyForce(this._id, fx, fy);
    return this;
  }

  /** Apply an instantaneous impulse. Returns `this` for chaining. */
  applyImpulse(ix: number, iy: number): this {
    this.check();
    this._producer!.applyImpulse(this._id, ix, iy);
    return this;
  }

  // ── Joint API ───────────────────────────────────────

  /** Create a revolute (pin) joint. this=entityA, target=entityB. Returns JointHandle for motor/limits. */
  revoluteJoint(target: EntityHandle, opts?: { anchorAx?: number; anchorAy?: number }): JointHandle {
    this.check();
    return this._producer!.createRevoluteJoint(
      this._id, target.id, opts?.anchorAx ?? 0, opts?.anchorAy ?? 0,
    );
  }

  /** Create a prismatic (slider) joint. this=entityA, target=entityB. Returns JointHandle. */
  prismaticJoint(target: EntityHandle, opts?: { axisX?: number; axisY?: number }): JointHandle {
    this.check();
    return this._producer!.createPrismaticJoint(
      this._id, target.id, opts?.axisX ?? 1, opts?.axisY ?? 0,
    );
  }

  /** Create a fixed (weld) joint. this=entityA, target=entityB. Returns JointHandle. */
  fixedJoint(target: EntityHandle): JointHandle {
    this.check();
    return this._producer!.createFixedJoint(this._id, target.id);
  }

  /** Create a rope joint (max distance constraint). Returns JointHandle. */
  ropeJoint(target: EntityHandle, maxDist: number): JointHandle {
    this.check();
    return this._producer!.createRopeJoint(this._id, target.id, maxDist);
  }

  /** Create a spring joint (rest length constraint). Returns JointHandle. */
  springJoint(target: EntityHandle, restLength: number): JointHandle {
    this.check();
    return this._producer!.createSpringJoint(this._id, target.id, restLength);
  }

  // ── Character Controller API ─────────────────────────────────

  /** Mark this entity as character-controlled. Returns `this`. */
  characterController(): this {
    this.check();
    this._producer!.createCharacterController(this._id);
    return this;
  }

  /** Configure the character controller. Returns `this`. */
  characterConfig(config: CharacterControllerConfig): this {
    this.check();
    this._producer!.setCharacterConfig(this._id, config);
    return this;
  }

  /** Move the character by desired translation. Returns `this`. */
  moveCharacter(dx: number, dy: number): this {
    this.check();
    this._producer!.moveCharacter(this._id, dx, dy);
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
