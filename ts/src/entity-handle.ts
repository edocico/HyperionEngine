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
   * is registered for it, so the per-type pipeline loop never finds it.
   * `LightAccumStage` (inside LightGroupsPass) draws every light in view from
   * the frame's light list, which `deriveLightGroups` builds on the CPU (round
   * step 7), not from the cull's buckets.
   */
  Light2D = 6,
}

/**
 * Light shape.
 * - `point`: lights a disc of radius `range` around its position.
 * - `spot`: a point light cut to a cone (`innerAngle`/`outerAngle`) around
 *   its axis.
 * - `directional`: a sun, infinitely far away. It lights every pixel of the
 *   layers in its mask, shining along its axis; its position is ignored. With
 *   `shadowIntensity` > 0 each caster throws a shadow along the axis, `range`
 *   world units long and fading out toward its end, with a fixed engine-wide
 *   penumbra. A caster casts only while it is on screen, so a shadow can
 *   appear at the edge the light comes from as the view pans. A shadowed sun
 *   marches every texel of the light buffer once per light group its layers
 *   reach.
 * - `global`: a uniform light over the layers in its mask, combined with
 *   `engine.lighting.setAmbient()` by its blend mode: added on top of it by
 *   default (a masked one is a per-layer ambient), while with blend `'mix'`
 *   it sets its layers to its `color` × `energy` (as half float, over a
 *   finite buffer: see {@link LightBlendMode} for a texel that is not),
 *   replacing the ambient and every `add` or `sub` light there. No position,
 *   no direction and no shadows in the lit backend: `shadowIntensity` is
 *   ignored (the renderer warns once in dev builds). Use `directional` for a
 *   sun.
 * - `sprite`: not drawn yet.
 *
 * The axis of a spot or directional light is its local +x in world space, and
 * the light shines TOWARD it: `rotation(angle)` aims it. 0 shines right,
 * `rotation(-Math.PI / 2)` shines down the screen (the world is y-up), and
 * `rotation(Math.atan2(dy, dx))` shines along (dx, dy). A parent's rotation
 * composes into it and a negative x-scale mirrors it in its own frame (it
 * then shines along its −x); the size of the scale is ignored, because a
 * light's extent is its range.
 */
export type LightType = 'point' | 'spot' | 'directional' | 'global' | 'sprite';

/**
 * How a light combines into the light buffer of its layers, which every frame
 * starts at the ambient light (`engine.lighting.setAmbient()`). With `c` the
 * light's `color` × `energy` and `w` its intensity at a pixel (the attenuation
 * (1 − d/range)^falloff × spot cone × shadow, from 0 to 1; the shadow alone
 * for a directional light, 1 for a global light):
 * - `add` (the default): buffer + c·w.
 * - `sub`: buffer − c·w. Nothing clamps the buffer at 0: where `sub` lights
 *   take more than there is, it goes negative (a lit sprite shows 0 in those
 *   channels), and a `mix` light drawn later starts from that negative value.
 * - `mix`: buffer·(1 − w) + c·w, toward the light's colour by its intensity.
 *   Where `w` is 1 the buffer becomes exactly `c` (as half float) over a
 *   finite buffer: the light replaces the ambient and every `add` or `sub`
 *   light under it. A texel that already holds a NaN, or an infinity (an
 *   `add` light or a sum of lights past half-float range, 65504, on hardware
 *   that rounds to infinity), gives c + dst·0 = NaN: a mix does not clear it.
 *   `energy` scales the colour it moves toward, not how far it moves.
 *
 * The order (round step 7): every `add` and `sub` light first, then every
 * `mix` light; within each class back to front by world z (a root 2D light's
 * z is −{@link EntityHandle.depth}, so the larger depth first, and a child's
 * is its world z, its depth composed with its parents'; a root 3D light's is
 * its `position()` z, a child's its world z), then by external id, the higher
 * id last, so on top (the newest light only while ids are fresh, as for
 * transparent sprites). `add` and `sub` lights commute up to rounding in the
 * half-float buffer (a few steps where several overlap): the order decides
 * which `mix` light ends on top. It comes from the ECS state alone, never from
 * the GPU's culling, so a still scene lights the same from frame to frame.
 */
export type LightBlendMode = 'add' | 'sub' | 'mix';

/**
 * Wire values for `renderMeta` bits 11-13. 5, 6 and 7 are deliberately left
 * unclaimed for `Point3D`, `Spot3D` and `Area`: reserving them costs nothing
 * now and avoids renumbering a shipped protocol later.
 */
const LIGHT_TYPE_IDS: Record<LightType, number> = {
  point: 0, spot: 1, directional: 2, global: 3, sprite: 4,
};

/**
 * Wire values for `renderMeta` bits 14-15. 3 is unclaimed: Rust keeps it as
 * sent, and the light list and `light-accum.wgsl` sort and draw it like `add`.
 */
const LIGHT_BLEND_IDS: Record<LightBlendMode, number> = { add: 0, sub: 1, mix: 2 };

/**
 * The largest finite f32. A directional light's range beyond ±F32_MAX can
 * reach the wire as ±inf (`±Infinity` does, and so does `±Number.MAX_VALUE`),
 * and Rust rejects a non-finite `SetPrimParams0` whole, the light's colour
 * with it. At F32_MAX the shadows are endless already (light-accum.wgsl
 * `directionalRay` bounds range × texels); at −F32_MAX there are none (it
 * clamps the range at 0).
 */
const F32_MAX = 3.4028234663852886e38;

/** Options for {@link EntityHandle.light}. */
export interface LightOptions {
  /** Default `'point'`. */
  type?: LightType;
  /** `'#rrggbb'`, `'#rgb'`, or `[r, g, b]` in 0-1. Default white. */
  color?: string | readonly [number, number, number];
  /** Multiplier applied to `color` on the way to the GPU. Default 1. */
  energy?: number;
  /**
   * World units. Default 100. Within ±3.4e38 (a finite f32), except on a
   * directional light (which is clamped), and never NaN: `light()` does not
   * check, a value past the f32 range reaches the wire as ±inf (the
   * `Float32Array` write: 1e39 is finite in JS, not in f32), and Rust rejects
   * a non-finite `SetPrimParams0` whole, so the light loses its colour too and
   * lights nothing.
   * - `point`, `spot`: the light's radius, which is also its culling radius:
   *   a light whose z is more than `range` outside the camera's near-far span
   *   lights nothing (see {@link EntityHandle.light}).
   * - `directional`: the length of its shadows, which fade out toward the end
   *   (0 or less casts none, `-Infinity` included; `Infinity` casts endless
   *   ones). Sent clamped to the finite f32 range, so any number but NaN
   *   reaches the GPU. It does not limit what the light lights: a sun covers
   *   the whole view and is never culled.
   * - `global`: unused (never culled either).
   */
  range?: number;
  /**
   * Spot inner cone half-angle in degrees, around the light's axis (its local
   * +x, see {@link LightType}). Default 30. Ignored by other types.
   */
  innerAngle?: number;
  /**
   * Spot outer cone half-angle in degrees, around the light's axis (its local
   * +x, see {@link LightType}). Default 45. Ignored by other types.
   */
  outerAngle?: number;
  /**
   * Attenuation exponent of a point or spot light: (1 − d/range)^falloff.
   * Default 1 (linear). Ignored by other types.
   */
  falloff?: number;
  /**
   * Shadow strength: 0 = none (default), 1 = fully opaque. Point, spot and
   * directional lights; ignored on a global light in the lit backend (a dev
   * warning, once). See {@link EntityHandle.shadows}.
   */
  shadowIntensity?: number;
  /**
   * How the light combines into its layers' light buffer, and when it is
   * drawn: see {@link LightBlendMode}. Default `'add'`.
   */
  blend?: LightBlendMode;
  /** The layers this light lights (see `lightLayers()`). Default `0xffff` (all). 0 lights nothing. */
  layers?: number;
}

/**
 * Accept `'#rgb'`, `'#rrggbb'` or an `[r, g, b]` triple, and return linear
 * 0-1 components.
 *
 * No sRGB→linear conversion: `scene-hdr` is `rgba16float` and the tonemap runs
 * at the end of the chain, so a light's colour is already the linear radiance
 * the accumulation buffer wants. Converting here would darken every light by
 * roughly a factor of two for no reason.
 */
function normalizeColor(c: string | readonly [number, number, number]): [number, number, number] {
  if (typeof c !== 'string') return [c[0], c[1], c[2]];
  let hex = c.startsWith('#') ? c.slice(1) : c;
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (hex.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`Invalid light color '${c}': expected '#rgb', '#rrggbb' or [r, g, b]`);
  }
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

/** primParams slots 4-6 as `light()` last wrote them. See `shadows()`. */
const DEFAULT_LIGHT_CONE: readonly [number, number, number] = [-1, -1, 1];

/**
 * Opaque handle to an entity, providing a fluent builder API.
 *
 * All setter methods delegate to BackpressuredProducer and return `this`
 * for chaining: `engine.spawn().position(1,2,3).velocity(4,5,6).texture(tex)`.
 *
 * After `destroy()`, all methods throw. `destroy()` is idempotent.
 * Implements `Disposable` for use with `using` declarations.
 *
 * A destroyed handle stays dead: it is never recycled, so a stale reference
 * can never alias a newer entity. `destroy()` hands the handle to its release
 * callback, which is how the engine frees the entity's slot.
 */
export class EntityHandle implements Disposable {
  private readonly _id: number;
  private _alive = true;
  private _producer: BackpressuredProducer | null;
  private _immediateState: ImmediateState | null;
  private _onRelease: ((handle: EntityHandle) => void) | null;
  private _data: Map<string, unknown> | null = null;
  /**
   * primParams slots 4-6 (innerCos, outerCos, falloff) as `light()` last wrote
   * them, so `shadows()` can change slot 7 without restating them.
   */
  private _lightCone: [number, number, number] = [...DEFAULT_LIGHT_CONE];
  private readonly _is2D: boolean;
  private _warnedIgnored = false;

  /**
   * @param onRelease - Called once, by the first `destroy()`. The engine
   *   passes the callback that frees the entity's slot.
   * @param is2D - The entity is a Transform2D one (`spawn({ mode: '2d' })`).
   */
  constructor(
    id: number,
    producer: BackpressuredProducer,
    immediateState?: ImmediateState,
    onRelease?: (handle: EntityHandle) => void,
    is2D = false,
  ) {
    this._id = id;
    this._producer = producer;
    this._immediateState = immediateState ?? null;
    this._onRelease = onRelease ?? null;
    this._is2D = is2D;
  }

  /** The numeric entity ID this handle wraps. */
  get id(): number { return this._id; }

  /** Whether the entity is a Transform2D one: no z, rotation about Z only. */
  get is2D(): boolean { return this._is2D; }

  /** Whether the entity is still alive (not destroyed). */
  get alive(): boolean { return this._alive; }

  /** Throws if the handle has been destroyed. */
  private check(): void {
    if (!this._alive) throw new Error('EntityHandle has been destroyed');
  }

  /**
   * Throws if another entity this call refers to has been destroyed: its id
   * may already belong to a newer entity once reused.
   */
  private checkTarget(target: EntityHandle): void {
    if (!target.alive) throw new Error(`Target EntityHandle ${target.id} has been destroyed`);
  }

  /**
   * An argument the entity's archetype has no room for is ignored by the
   * engine: says so once per handle, in dev builds. Kept a warning, not an
   * error: generic code that passes z = 0 or a Z-only quaternion never
   * reaches it.
   */
  private ignored(what: string): void {
    if (this._warnedIgnored || typeof __DEV__ === 'undefined' || !__DEV__) return;
    this._warnedIgnored = true;
    const why = this._is2D
      ? 'a Transform2D entity has no z (its depth() is one), no sz or vz, and rotates about Z only'
      : 'a 3D entity takes its z from position()';
    console.warn(`[Hyperion] ${this._is2D ? '2D' : '3D'} entity ${this._id}: ${what} is ignored (${why}). Further ones on this entity are silent.`);
  }

  /** On a 2D entity, a 3D-only argument is ignored. */
  private ignoredOn2D(what: string): void {
    if (this._is2D) this.ignored(what);
  }

  /** Set entity position (z defaults to 0; a 2D entity ignores it). Returns `this` for chaining. */
  position(x: number, y: number, z = 0): this {
    this.check();
    if (z !== 0) this.ignoredOn2D('position z');
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
  positionImmediate(x: number, y: number, z = 0): this {
    this.check();
    if (z !== 0) this.ignoredOn2D('positionImmediate z');
    this._producer!.setPosition(this._id, x, y, z);
    // A 2D entity's z is -depth with its parent's composed in: the shadow
    // leaves it to the engine's row (a later depth() then shows at once).
    this._immediateState?.set(this._id, x, y, this._is2D ? null : z);
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

  /** Set entity velocity (vz defaults to 0; a 2D entity ignores it). Returns `this` for chaining. */
  velocity(vx: number, vy: number, vz = 0): this {
    this.check();
    if (vz !== 0) this.ignoredOn2D('velocity vz');
    this._producer!.setVelocity(this._id, vx, vy, vz);
    return this;
  }

  /**
   * Set entity rotation. Returns `this` for chaining.
   * - 1 arg: an angle in radians about Z (the screen normal). It REPLACES the
   *   whole rotation, on any entity.
   * - 4 args: a quaternion (x, y, z, w). A 2D entity keeps only its angle
   *   about Z (a tilt off that axis is ignored).
   *
   * On a physics body both forms reposition the body (momentum kept), like
   * `position()`, also in the frame that creates it. Rapier is 2D: it keeps
   * only the angle about Z, so a tilt from the quaternion form is dropped at
   * the next physics step.
   *
   * On a spot or directional light it aims the light (see {@link LightType}).
   */
  rotation(angleOrQx: number, qy?: number, qz?: number, qw?: number): this {
    this.check();
    if (qy === undefined) {
      this._producer!.setRotation2D(this._id, angleOrQx);
    } else {
      if (Math.abs(angleOrQx) > 1e-6 || Math.abs(qy) > 1e-6) this.ignoredOn2D('a tilted quaternion');
      this._producer!.setRotation(this._id, angleOrQx, qy, qz!, qw!);
    }
    return this;
  }

  /** Set entity scale (sz defaults to 1; a 2D entity ignores it). Returns `this` for chaining. */
  scale(sx: number, sy: number, sz = 1): this {
    this.check();
    if (sz !== 1) this.ignoredOn2D('scale sz');
    this._producer!.setScale(this._id, sx, sy, sz);
    return this;
  }

  /**
   * The z of a 2D entity (`spawn({ mode: '2d' })`), which has none of its own:
   * a distance into the screen, drawn at z = -depth, so a larger depth is
   * behind. With the default camera (near -1, far 1000) it is visible from -1
   * to 1000. A child's depth is relative to its parent's, like its position
   * (a physics body's pose is world: its depth too). It orders opaque sprites
   * through the depth test, and transparent ones by a GPU sort, back to front
   * by world z. At the SAME depth, two overlapping OPAQUE sprites are drawn in
   * no defined order; two transparent ones by id, the higher id in front (the
   * newest entity only while ids are fresh); an opaque one hides a transparent
   * one. Give sprites different depths to order them. On a 2D light it orders
   * the light list (round step 7): within a blend class the larger depth is
   * drawn first and the smaller one on top, the higher id at equal depths (see
   * {@link LightBlendMode}); a point or spot light whose world depth (its own,
   * composed with its parents' for a child) is outside −1 − range to
   * 1000 + range (the default camera) is culled and lights nothing. On a 3D
   * entity, which takes its z from `position()`, it is ignored (a warning in
   * dev builds). Returns `this`.
   */
  depth(d: number): this {
    this.check();
    if (!this._is2D) this.ignored('depth()');
    this._producer!.setDepth(this._id, d);
    return this;
  }

  /**
   * Mark entity as transparent: alpha-blended, drawn after the opaque ones,
   * with no depth write, back to front by world z (at equal z the higher id
   * is in front). On a light it changes nothing on screen: every light is
   * drawn from one list, in the order of {@link LightBlendMode} (round step
   * 7). Returns `this`.
   */
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

  /**
   * Configure this entity as a line from (x0, y0) to (x1, y1), in the entity's
   * local units. `width` is in local units too — scaled by the entity and the
   * zoom like any primitive — unless `{ unit: 'px' }`: then it is texels of
   * the canvas backing store (`canvas.width`), the same at every zoom. With the
   * canvas sized at clientWidth × devicePixelRatio (as the harness does) those
   * are device pixels, and at devicePixelRatio 2 a 3 px line is 1.5 CSS pixels
   * wide: scale by `canvas.width / canvas.clientWidth` for a width in CSS
   * pixels. The culling radius follows the endpoints.
   * Returns `this` for chaining.
   */
  line(x0: number, y0: number, x1: number, y1: number, width: number,
       options?: { unit?: 'world' | 'px' }): this {
    this.check();
    this._producer!.setRenderPrimitive(this._id, RenderPrimitiveType.Line);
    this._producer!.setPrimParams0(this._id, x0, y0, x1, y1);
    this._producer!.setPrimParams1(this._id, width, 0, 0, options?.unit === 'px' ? 1 : 0);
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

  // ── Lighting (Phase 17) ──────────────────────────

  /**
   * Turn this entity into a 2D light.
   *
   * A light is an ordinary ECS entity, so it inherits position, hierarchy
   * (a torch parented to a character), spawn/despawn, frustum culling (for a
   * light, the cull's test, run on the CPU by the light list, round step 7),
   * snapshot and replay for free — which is why a point or spot light's
   * `range` also drives its culling radius rather than needing a separate
   * call (global and directional lights light the whole view and are never
   * culled). Aim a spot or a sun with `rotation()` (see {@link LightType}).
   *
   * Lights are drawn in one fixed order, described at {@link LightBlendMode}:
   * `add` and `sub` first, then `mix`, each back to front by world z, then by
   * id. A light's z orders and culls it, and never moves what it lights: a
   * root 2D light's z is −{@link EntityHandle.depth}, a child's its world z
   * (its depth composed with its parents'); a root 3D light's is the z of
   * `position()`, a child's its world z. Like any entity, a point or spot
   * light is culled, and lights nothing, when that world z is more than
   * `range` outside the camera's near-far span: with the default camera a 2D
   * light's world depth must stay within [−1 − range, 1000 + range], a 3D
   * light's world z within [−1000 − range, 1 + range]. Global and directional
   * lights are never culled.
   *
   * `color` and `energy` stay separate here on purpose. The GPU buffer gets
   * them premultiplied (that is what frees a `primParams` slot for
   * `shadowIntensity`), but the API keeps them apart because a 3D light will
   * need them apart, and because multiplying is lossy: once premultiplied you
   * cannot recover "which colour at what intensity" to show in an editor.
   */
  light(options: LightOptions): this {
    this.check();
    const [r, g, b] = normalizeColor(options.color ?? '#ffffff');
    const energy = options.energy ?? 1;
    const type = options.type ?? 'point';
    // A sun's `range` is its shadows' length, sent clamped to the finite f32
    // range (see F32_MAX): Infinity means endless ones, -Infinity none. NaN
    // passes through, as any range of the other types does.
    const range = type === 'directional'
      ? Math.max(-F32_MAX, Math.min(options.range ?? 100, F32_MAX))
      : options.range ?? 100;

    this._producer!.setRenderPrimitive(this._id, RenderPrimitiveType.Light2D);
    this._producer!.setLightFlags(
      this._id,
      LIGHT_TYPE_IDS[type],
      LIGHT_BLEND_IDS[options.blend ?? 'add'],
      options.layers ?? 0xffff,
    );
    // Premultiply at the wire boundary, not in the API surface.
    this._producer!.setPrimParams0(this._id, r * energy, g * energy, b * energy, range);
    // Cone angles are stored as cosines: the shader compares against a dot
    // product, so converting here keeps a trig call out of the fragment loop.
    // A point light gets inner=outer=-1, i.e. "every direction is inside".
    const isSpot = type === 'spot';
    const innerCos = isSpot ? Math.cos(((options.innerAngle ?? 30) * Math.PI) / 180) : -1;
    const outerCos = isSpot ? Math.cos(((options.outerAngle ?? 45) * Math.PI) / 180) : -1;
    const falloff = options.falloff ?? 1;
    this._lightCone = [innerCos, outerCos, falloff];
    this._producer!.setPrimParams1(
      this._id,
      innerCos,
      outerCos,
      falloff,
      options.shadowIntensity ?? 0,
    );
    return this;
  }

  /**
   * Shadow strength for this light: 0 casts none, 1 is fully opaque.
   *
   * Point, spot and directional lights (a sun's shadows are `range` world
   * units long, see {@link LightType}). A shadowed directional light marches
   * every texel of the light buffer once per light group its layers reach. A
   * global light never casts shadows in the lit backend: the value is stored
   * and ignored, and the renderer warns once in dev builds. Use a directional
   * light for a sun.
   *
   * Kept separate from `light()` because it is the one light parameter with a
   * real per-frame cost — `shadowIntensity > 0` is what switches on the sphere
   * march in the accumulation shader, so it is the knob you reach for.
   *
   * ⚠️ Unlike `lightLayers()`, this one is not stateless. `shadowIntensity` is
   * `primParams[7]` and `SetPrimParams1` writes four floats at once with no
   * spare bits to carry a preserve mask (`PrimitiveParams` are validated as
   * finite f32, so a bitfield smuggled into one would risk a NaN and be
   * rejected). So the cone and falloff are replayed from what `light()` last
   * put on this handle. Call it on the handle that configured the light — on a
   * fresh handle for an existing entity it replays defaults instead.
   */
  shadows(intensity: number): this {
    this.check();
    const [innerCos, outerCos, falloff] = this._lightCone;
    this._producer!.setPrimParams1(this._id, innerCos, outerCos, falloff, intensity);
    return this;
  }

  /**
   * Whether this entity is rasterised into the occluder seed, i.e. whether it
   * casts a shadow. Independent of `receivesLight()`. A light entity never
   * casts: a light's own shadows are {@link EntityHandle.shadows}.
   */
  castsShadow(enabled = true): this {
    this.check();
    this._producer!.setLightingFlags(this._id, enabled, null);
    return this;
  }

  /**
   * Whether this entity samples the light buffer. Off by default: an unlit
   * sprite skips the lookup entirely, which is the cheap path. Only quads and
   * gradients read the light buffer; on any other primitive the flag has no
   * effect.
   */
  receivesLight(enabled = true): this {
    this.check();
    this._producer!.setLightingFlags(this._id, null, enabled);
    return this;
  }

  /**
   * The light layers (16 bits) of this entity. One field, three roles:
   * - **light**: the layers it lights. Mask 0 lights nothing; `light()`
   *   defaults to 0xFFFF. Global and directional lights obey it too, so a
   *   masked global light is a per-layer ambient.
   * - **receiver** (`receivesLight()`): the ONE layer it belongs to, the lowest
   *   bit of the mask; mask 0 is layer 0. Extra bits are ignored (a warning,
   *   once). To light a receiver from several layers, put the bits on the
   *   lights instead: same image, no ambiguity about shadows.
   * - **occluder** (`castsShadow()`): the layers whose receivers it shadows.
   *   Mask 0 is every layer. It is absent from other layers' shadows.
   *
   * Layers that the same lights and casters reach share a light buffer, the
   * way Unity batches sorting layers (design 2026-09-26). Each distinct set of
   * casters costs a full SDF flood, about 1.8 ms at 1080p on an integrated
   * GPU, with no cap: `engine.lighting.groups` shows what splits them.
   *
   * The occluder's layers are keyed by RECEIVER layer, not by light (Godot's
   * `occluder_light_mask`); they agree when each light has one layer. A single
   * field cannot say "lit by layer A but shadowing for layer B", nor Godot's
   * "lit by L but not shadowed by L": use two lights for that.
   */
  lightLayers(mask: number): this {
    this.check();
    // null/null = preserve the stored shape and blend mode, change only the
    // mask. Stateless, so this works on any handle for the entity.
    this._producer!.setLightFlags(this._id, null, null, mask);
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
    this.checkTarget(target);
    return this._producer!.createRevoluteJoint(
      this._id, target.id, opts?.anchorAx ?? 0, opts?.anchorAy ?? 0,
    );
  }

  /** Create a prismatic (slider) joint. this=entityA, target=entityB. Returns JointHandle. */
  prismaticJoint(target: EntityHandle, opts?: { axisX?: number; axisY?: number }): JointHandle {
    this.check();
    this.checkTarget(target);
    return this._producer!.createPrismaticJoint(
      this._id, target.id, opts?.axisX ?? 1, opts?.axisY ?? 0,
    );
  }

  /** Create a fixed (weld) joint. this=entityA, target=entityB. Returns JointHandle. */
  fixedJoint(target: EntityHandle): JointHandle {
    this.check();
    this.checkTarget(target);
    return this._producer!.createFixedJoint(this._id, target.id);
  }

  /** Create a rope joint (max distance constraint). Returns JointHandle. */
  ropeJoint(target: EntityHandle, maxDist: number): JointHandle {
    this.check();
    this.checkTarget(target);
    return this._producer!.createRopeJoint(this._id, target.id, maxDist);
  }

  /** Create a spring joint (rest length constraint). Returns JointHandle. */
  springJoint(target: EntityHandle, restLength: number): JointHandle {
    this.check();
    this.checkTarget(target);
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
   * Data is stored per-key for the lifetime of the handle.
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
    const release = this._onRelease;
    this._onRelease = null;
    release?.(this);
  }

  /** Disposable protocol — same as `destroy()`. */
  [Symbol.dispose](): void {
    this.destroy();
  }
}
