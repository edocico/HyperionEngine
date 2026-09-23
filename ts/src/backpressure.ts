import { RingBufferProducer, CommandType } from './ring-buffer';
import type { JointHandle, CharacterControllerConfig } from './physics-api';

export type BackpressureMode = 'retry-queue' | 'drop';

export interface QueuedCommand {
  cmd: CommandType;
  entityId: number;
  payload?: Float32Array | Uint8Array;
}

export interface FlushStats {
  /** Commands actually written to the ring buffer this flush. */
  writtenCount: number;
  /** Commands folded into a pending one with the same entity + command type (replaced, or merged for partial updates). */
  coalescedCount: number;
  /** Pending overwrites purged because the entity was despawned. */
  purgedByDespawn: number;
}

/**
 * Maximum command type value (exclusive). Used for despawn purge iteration.
 * Must be updated if new CommandType variants are added.
 */
const MAX_COMMAND_TYPE = 57; // CommandType values: 0..56 — keep in sync with ring_buffer.rs MAX_COMMAND_TYPE

/**
 * Commands that address *engine* state through the `entity_id = 0` sentinel
 * rather than an entity.
 *
 * Their coalescing key is `0 * 256 + cmd`, and `0` is also a perfectly valid
 * external entity id — so despawning entity 0 used to purge a pending listener
 * position along with it, silently. These are exempt from the purge.
 */
const ENGINE_LEVEL_COMMANDS: ReadonlySet<number> = new Set<number>([
  CommandType.SetListenerPosition,   // 13
  CommandType.SetPhysicsDebugRender, // 47
  CommandType.SetAmbientLight,       // 55
  CommandType.SetLightingBackend,    // 56
]);

/**
 * Returns true for commands that must NOT be coalesced (last-write-wins).
 * - Lifecycle: SpawnEntity, DespawnEntity
 * - Physics create/destroy: CreateRigidBody, DestroyRigidBody, CreateCollider, DestroyCollider
 * - Physics additive: ApplyForce, ApplyImpulse, ApplyTorque
 * - Physics joints: ALL joint commands (33-43) are non-coalescable
 *
 * The four Phase 17 lighting commands (53-56) are all coalescable: none
 * accumulates, none is a lifecycle edge, none carries a secondary id in its
 * payload. That matters in practice — an ambient-light slider dragged while
 * the ring buffer is under backpressure must collapse to one command per
 * frame, not flood the non-coalescable queue.
 *
 * But 53 and 54 are *partial* updates (see `isPartialUpdate`), so for them
 * "coalesce" means merge field by field, not replace: `castsShadow(true)
 * .receivesLight(true)` in one frame used to reach Rust as receivesLight only.
 */
function isNonCoalescable(cmd: CommandType): boolean {
  if (cmd === CommandType.SpawnEntity || cmd === CommandType.DespawnEntity) return true;
  if (cmd >= CommandType.CreateRigidBody && cmd <= CommandType.DestroyCollider) return true; // 17-20
  if (cmd >= CommandType.ApplyForce && cmd <= CommandType.ApplyTorque) return true; // 25-27
  // Joint commands 33-43 are ALL non-coalescable.
  // Entity-based coalescing key doesn't work for joints:
  // same entity with two joints + same cmdType = same key = silent overwrite.
  if (cmd >= CommandType.CreateRevoluteJoint && cmd <= CommandType.SetJointAnchorA) return true; // 33-43
  if (cmd === CommandType.CreateCharacterController) return true; // 44
  // Audit 2026-07: lifecycle commands must not be coalesced.
  // TeleportBody (49) is a discrete event — two teleports in one frame are two
  // distinct repositionings and the intermediate one may matter (e.g. respawn
  // then nudge). DestroyCharacterController (51) is a lifecycle edge.
  // SetColliderEvents (48), SetBoundingRadius (50) and SetCharacterUp (52) are
  // pure state and coalesce with last-write-wins.
  if (cmd === CommandType.TeleportBody) return true; // 49
  if (cmd === CommandType.DestroyCharacterController) return true; // 51
  return false;
}

/**
 * Commands whose payload is a *partial* update: some fields carry a "preserve
 * the stored value" marker instead of a value. Coalescing them by plain
 * replacement would drop the fields the newer command left alone.
 */
function isPartialUpdate(cmd: CommandType): boolean {
  return cmd === CommandType.SetLightFlags || cmd === CommandType.SetLightingFlags;
}

/**
 * Compose two queued partial updates of the same (entity, command) into ONE
 * payload whose effect on the Rust handler equals applying `prev` then `next`.
 *
 * Wire formats (see the producers below and command_processor.rs):
 * - SetLightFlags (53), 4 bytes: [0] lightType, [1] blendMode — bit 7 set means
 *   "preserve"; [2..3] lightMask u16 LE, always a value (no preserve form).
 * - SetLightingFlags (54), 1 byte: bit0 castsShadow, bit1 receivesLight values;
 *   bit2 / bit3 mean "preserve castsShadow / receivesLight".
 *
 * Must return a fresh array: `prev` and `next` may be the caller's buffers.
 */
function mergePartialPayload(cmd: CommandType, prev: Uint8Array, next: Uint8Array): Uint8Array {
  const out = Uint8Array.from(next);
  // A field `next` preserves defers to `prev`'s field WHOLE, preserve marker
  // included: if `prev` also said "leave it alone", so must the merge — copying
  // only the value would turn that into an explicit write of whatever it held.
  if (cmd === CommandType.SetLightFlags) {
    if (next[0] & 0x80) out[0] = prev[0];
    if (next[1] & 0x80) out[1] = prev[1];
  } else {
    // SetLightingFlags: each flag is a (value, preserve) bit pair.
    const CASTS = 0b0101;
    const RECEIVES = 0b1010;
    if (next[0] & 0b0100) out[0] = (out[0] & ~CASTS) | (prev[0] & CASTS);
    if (next[0] & 0b1000) out[0] = (out[0] & ~RECEIVES) | (prev[0] & RECEIVES);
  }
  return out;
}

function asBytes(p: Float32Array | Uint8Array): Uint8Array {
  return new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
}

export class PrioritizedCommandQueue {
  private critical: QueuedCommand[] = [];
  private overwrites = new Map<number, QueuedCommand>(); // key = entityId * 256 + cmd
  private _coalescedCount = 0;
  private _purgedByDespawn = 0;

  get criticalCount(): number { return this.critical.length; }
  get overwriteCount(): number { return this.overwrites.size; }

  enqueue(cmd: CommandType, entityId: number, payload?: Float32Array | Uint8Array): void {
    if (isNonCoalescable(cmd)) {
      if (cmd === CommandType.DespawnEntity) {
        this.purgeEntity(entityId);
      }
      this.critical.push({ cmd, entityId, payload });
    } else {
      const key = entityId * 256 + cmd;
      const prev = this.overwrites.get(key);
      if (prev) {
        this._coalescedCount++;
        if (isPartialUpdate(cmd) && prev.payload && payload) {
          payload = mergePartialPayload(cmd, asBytes(prev.payload), asBytes(payload));
        }
      }
      this.overwrites.set(key, { cmd, entityId, payload });
    }
  }

  /**
   * Purge ALL pending overwrites for a given entity.
   * O(MAX_COMMAND_TYPE) per despawn — not O(map.size).
   */
  private purgeEntity(entityId: number): void {
    for (let cmdType = 0; cmdType < MAX_COMMAND_TYPE; cmdType++) {
      // Engine-level commands share the `entity_id = 0` sentinel with real
      // entity 0; despawning it must not take them down as collateral.
      if (entityId === 0 && ENGINE_LEVEL_COMMANDS.has(cmdType)) continue;
      if (this.overwrites.delete(entityId * 256 + cmdType)) {
        this._purgedByDespawn++;
      }
    }
  }

  /**
   * Drain queued commands into the ring buffer.
   * Critical (lifecycle) commands are written first, then overwrites.
   * Map iteration order matches insertion order, so drain order for different
   * command types on the same entity matches the original call order.
   *
   * @param rb - Ring buffer producer to write into.
   * @param tap - Optional recording tap, called for each written command.
   * @returns FlushStats with coalescing metrics.
   */
  drainTo(
    rb: RingBufferProducer,
    tap?: ((type: number, entityId: number, payload: Uint8Array) => void) | null,
  ): FlushStats {
    const stats: FlushStats = {
      writtenCount: 0,
      coalescedCount: this._coalescedCount,
      purgedByDespawn: this._purgedByDespawn,
    };
    this._coalescedCount = 0;
    this._purgedByDespawn = 0;

    // Critical first
    let i = 0;
    for (; i < this.critical.length; i++) {
      const c = this.critical[i];
      if (!rb.writeCommand(c.cmd, c.entityId, c.payload)) break;
      stats.writtenCount++;
      if (tap) {
        const bytes = c.payload
          ? new Uint8Array(c.payload.buffer, c.payload.byteOffset, c.payload.byteLength)
          : new Uint8Array(0);
        tap(c.cmd, c.entityId, bytes);
      }
    }
    this.critical.splice(0, i);

    // Do not attempt overwrites if any criticals remain unwritten.
    if (this.critical.length > 0) return stats;

    // Overwrites
    const toDelete: number[] = [];
    for (const [key, c] of this.overwrites) {
      if (!rb.writeCommand(c.cmd, c.entityId, c.payload)) break;
      stats.writtenCount++;
      toDelete.push(key);
      if (tap) {
        const bytes = c.payload
          ? new Uint8Array(c.payload.buffer, c.payload.byteOffset, c.payload.byteLength)
          : new Uint8Array(0);
        tap(c.cmd, c.entityId, bytes);
      }
    }
    for (const key of toDelete) {
      this.overwrites.delete(key);
    }

    return stats;
  }

  clear(): void {
    this.critical.length = 0;
    this.overwrites.clear();
    this._coalescedCount = 0;
    this._purgedByDespawn = 0;
  }
}

/**
 * Wraps a RingBufferProducer with command coalescing.
 *
 * ALL commands are queued into a PrioritizedCommandQueue on writeCommand().
 * Lifecycle commands (Spawn/Despawn) go to an ordered critical queue.
 * Non-lifecycle commands use last-write-wins deduplication per (entityId, commandType),
 * except partial updates (53/54), whose payloads are merged field by field.
 * Call flush() once per frame to drain coalesced commands into the ring buffer.
 */
export class BackpressuredProducer {
  private readonly inner: RingBufferProducer;
  private readonly queue = new PrioritizedCommandQueue();
  private recordingTap: ((type: number, entityId: number, payload: Uint8Array) => void) | null = null;

  constructor(inner: RingBufferProducer) {
    this.inner = inner;
  }

  setRecordingTap(tap: ((type: number, entityId: number, payload: Uint8Array) => void) | null): void {
    this.recordingTap = tap;
  }

  get pendingCount(): number {
    return this.queue.criticalCount + this.queue.overwriteCount;
  }

  get freeSpace(): number {
    return this.inner.freeSpace;
  }

  flush(): FlushStats {
    return this.queue.drainTo(this.inner, this.recordingTap);
  }

  writeCommand(cmd: CommandType, entityId: number, payload?: Float32Array | Uint8Array): boolean {
    this.queue.enqueue(cmd, entityId, payload);
    return true;
  }

  spawnEntity(entityId: number, is2D = false): boolean {
    return this.writeCommand(CommandType.SpawnEntity, entityId, new Uint8Array([is2D ? 1 : 0]));
  }

  despawnEntity(entityId: number): boolean {
    return this.writeCommand(CommandType.DespawnEntity, entityId);
  }

  setPosition(entityId: number, x: number, y: number, z: number): boolean {
    return this.writeCommand(CommandType.SetPosition, entityId, new Float32Array([x, y, z]));
  }

  setTextureLayer(entityId: number, packedIndex: number): boolean {
    const p = new Float32Array(1);
    new Uint32Array(p.buffer)[0] = packedIndex;
    return this.writeCommand(CommandType.SetTextureLayer, entityId, p);
  }

  setMeshHandle(entityId: number, handle: number): boolean {
    const p = new Float32Array(1);
    new Uint32Array(p.buffer)[0] = handle;
    return this.writeCommand(CommandType.SetMeshHandle, entityId, p);
  }

  setRenderPrimitive(entityId: number, primitive: number): boolean {
    const p = new Float32Array(1);
    new Uint32Array(p.buffer)[0] = primitive;
    return this.writeCommand(CommandType.SetRenderPrimitive, entityId, p);
  }

  setVelocity(entityId: number, vx: number, vy: number, vz: number): boolean {
    return this.writeCommand(CommandType.SetVelocity, entityId, new Float32Array([vx, vy, vz]));
  }

  setRotation(entityId: number, x: number, y: number, z: number, w: number): boolean {
    return this.writeCommand(CommandType.SetRotation, entityId, new Float32Array([x, y, z, w]));
  }

  setScale(entityId: number, sx: number, sy: number, sz: number): boolean {
    return this.writeCommand(CommandType.SetScale, entityId, new Float32Array([sx, sy, sz]));
  }

  setParent(entityId: number, parentId: number): boolean {
    const p = new Float32Array(1);
    new Uint32Array(p.buffer)[0] = parentId;
    return this.writeCommand(CommandType.SetParent, entityId, p);
  }

  setPrimParams0(entityId: number, p0: number, p1: number, p2: number, p3: number): boolean {
    return this.writeCommand(CommandType.SetPrimParams0, entityId, new Float32Array([p0, p1, p2, p3]));
  }

  setPrimParams1(entityId: number, p4: number, p5: number, p6: number, p7: number): boolean {
    return this.writeCommand(CommandType.SetPrimParams1, entityId, new Float32Array([p4, p5, p6, p7]));
  }

  setListenerPosition(x: number, y: number, z: number): boolean {
    return this.writeCommand(
      CommandType.SetListenerPosition,
      0, // sentinel entity ID
      new Float32Array([x, y, z]),
    );
  }

  setRotation2D(entityId: number, angle: number): boolean {
    return this.writeCommand(CommandType.SetRotation2D, entityId, new Float32Array([angle]));
  }

  setTransparent(entityId: number, value: number): boolean {
    return this.writeCommand(CommandType.SetTransparent, entityId, new Uint8Array([value & 0xFF]));
  }

  setDepth(entityId: number, z: number): boolean {
    return this.writeCommand(CommandType.SetDepth, entityId, new Float32Array([z]));
  }

  // ── Physics: body ──

  createRigidBody(entityId: number, bodyType: number): boolean {
    return this.writeCommand(CommandType.CreateRigidBody, entityId, new Uint8Array([bodyType & 0xFF]));
  }

  destroyRigidBody(entityId: number): boolean {
    return this.writeCommand(CommandType.DestroyRigidBody, entityId);
  }

  createCollider(entityId: number, shapeType: number, ...params: number[]): boolean {
    const buf = new ArrayBuffer(16);
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    u8[0] = shapeType & 0xFF;
    for (let i = 0; i < Math.min(params.length, 3); i++) {
      dv.setFloat32(1 + i * 4, params[i], true);
    }
    return this.writeCommand(CommandType.CreateCollider, entityId, u8);
  }

  destroyCollider(entityId: number): boolean {
    return this.writeCommand(CommandType.DestroyCollider, entityId);
  }

  setLinearDamping(entityId: number, damping: number): boolean {
    return this.writeCommand(CommandType.SetLinearDamping, entityId, new Float32Array([damping]));
  }

  setAngularDamping(entityId: number, damping: number): boolean {
    return this.writeCommand(CommandType.SetAngularDamping, entityId, new Float32Array([damping]));
  }

  setGravityScale(entityId: number, scale: number): boolean {
    return this.writeCommand(CommandType.SetGravityScale, entityId, new Float32Array([scale]));
  }

  setCCDEnabled(entityId: number, enabled: boolean): boolean {
    return this.writeCommand(CommandType.SetCCDEnabled, entityId, new Uint8Array([enabled ? 1 : 0]));
  }

  applyForce(entityId: number, fx: number, fy: number): boolean {
    return this.writeCommand(CommandType.ApplyForce, entityId, new Float32Array([fx, fy]));
  }

  applyImpulse(entityId: number, ix: number, iy: number): boolean {
    return this.writeCommand(CommandType.ApplyImpulse, entityId, new Float32Array([ix, iy]));
  }

  applyTorque(entityId: number, torque: number): boolean {
    return this.writeCommand(CommandType.ApplyTorque, entityId, new Float32Array([torque]));
  }

  // ── Physics: collider overrides ──

  setColliderSensor(entityId: number, sensor: boolean): boolean {
    return this.writeCommand(CommandType.SetColliderSensor, entityId, new Uint8Array([sensor ? 1 : 0]));
  }

  setColliderDensity(entityId: number, density: number): boolean {
    return this.writeCommand(CommandType.SetColliderDensity, entityId, new Float32Array([density]));
  }

  setColliderRestitution(entityId: number, restitution: number): boolean {
    return this.writeCommand(CommandType.SetColliderRestitution, entityId, new Float32Array([restitution]));
  }

  setColliderFriction(entityId: number, friction: number): boolean {
    return this.writeCommand(CommandType.SetColliderFriction, entityId, new Float32Array([friction]));
  }

  setCollisionGroups(entityId: number, membership: number, filter: number): boolean {
    const buf = new Uint8Array(4);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, membership & 0xFFFF, true);
    dv.setUint16(2, filter & 0xFFFF, true);
    return this.writeCommand(CommandType.SetCollisionGroups, entityId, buf);
  }

  // ── Physics: joints ──

  private _nextJointId = 1;

  createRevoluteJoint(entityA: number, entityB: number, anchorAx: number, anchorAy: number): JointHandle {
    const jointId = this._nextJointId++;
    const buf = new ArrayBuffer(16);
    const dv = new DataView(buf);
    dv.setUint32(0, jointId, true);
    dv.setUint32(4, entityB, true);
    dv.setFloat32(8, anchorAx, true);
    dv.setFloat32(12, anchorAy, true);
    this.writeCommand(CommandType.CreateRevoluteJoint, entityA, new Uint8Array(buf));
    return { __brand: 'JointHandle' as const, _jointId: jointId, _entityA: entityA };
  }

  createPrismaticJoint(entityA: number, entityB: number, axisX: number, axisY: number): JointHandle {
    const jointId = this._nextJointId++;
    const buf = new ArrayBuffer(16);
    const dv = new DataView(buf);
    dv.setUint32(0, jointId, true);
    dv.setUint32(4, entityB, true);
    dv.setFloat32(8, axisX, true);
    dv.setFloat32(12, axisY, true);
    this.writeCommand(CommandType.CreatePrismaticJoint, entityA, new Uint8Array(buf));
    return { __brand: 'JointHandle' as const, _jointId: jointId, _entityA: entityA };
  }

  createFixedJoint(entityA: number, entityB: number): JointHandle {
    const jointId = this._nextJointId++;
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint32(0, jointId, true);
    dv.setUint32(4, entityB, true);
    this.writeCommand(CommandType.CreateFixedJoint, entityA, new Uint8Array(buf));
    return { __brand: 'JointHandle' as const, _jointId: jointId, _entityA: entityA };
  }

  createRopeJoint(entityA: number, entityB: number, maxDist: number): JointHandle {
    const jointId = this._nextJointId++;
    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, jointId, true);
    dv.setUint32(4, entityB, true);
    dv.setFloat32(8, maxDist, true);
    this.writeCommand(CommandType.CreateRopeJoint, entityA, new Uint8Array(buf));
    return { __brand: 'JointHandle' as const, _jointId: jointId, _entityA: entityA };
  }

  createSpringJoint(entityA: number, entityB: number, restLength: number): JointHandle {
    const jointId = this._nextJointId++;
    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, jointId, true);
    dv.setUint32(4, entityB, true);
    dv.setFloat32(8, restLength, true);
    this.writeCommand(CommandType.CreateSpringJoint, entityA, new Uint8Array(buf));
    return { __brand: 'JointHandle' as const, _jointId: jointId, _entityA: entityA };
  }

  removeJoint(joint: JointHandle): void {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, joint._jointId, true);
    this.writeCommand(CommandType.RemoveJoint, joint._entityA, new Uint8Array(buf));
  }

  setJointMotor(joint: JointHandle, targetVel: number, maxForce: number): void {
    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, joint._jointId, true);
    dv.setFloat32(4, targetVel, true);
    dv.setFloat32(8, maxForce, true);
    this.writeCommand(CommandType.SetJointMotor, joint._entityA, new Uint8Array(buf));
  }

  setJointLimits(joint: JointHandle, min: number, max: number): void {
    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, joint._jointId, true);
    dv.setFloat32(4, min, true);
    dv.setFloat32(8, max, true);
    this.writeCommand(CommandType.SetJointLimits, joint._entityA, new Uint8Array(buf));
  }

  setSpringParams(joint: JointHandle, stiffness: number, damping: number): void {
    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, joint._jointId, true);
    dv.setFloat32(4, stiffness, true);
    dv.setFloat32(8, damping, true);
    this.writeCommand(CommandType.SetSpringParams, joint._entityA, new Uint8Array(buf));
  }

  setJointAnchorA(joint: JointHandle, ax: number, ay: number): void {
    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, joint._jointId, true);
    dv.setFloat32(4, ax, true);
    dv.setFloat32(8, ay, true);
    this.writeCommand(CommandType.SetJointAnchorA, joint._entityA, new Uint8Array(buf));
  }

  setJointAnchorB(joint: JointHandle, bx: number, by: number): void {
    const buf = new ArrayBuffer(12);
    const dv = new DataView(buf);
    dv.setUint32(0, joint._jointId, true);
    dv.setFloat32(4, bx, true);
    dv.setFloat32(8, by, true);
    this.writeCommand(CommandType.SetJointAnchorB, joint._entityA, new Uint8Array(buf));
  }

  // ── Physics: character controller ──

  createCharacterController(entityId: number): void {
    const buf = new Uint8Array(1);
    buf[0] = 0;
    this.writeCommand(CommandType.CreateCharacterController, entityId, buf);
  }

  setCharacterConfig(entityId: number, config: CharacterControllerConfig): void {
    const slide = config.slide ?? true;
    const climbAngle = config.maxSlopeClimbAngle ?? Math.PI / 4;
    const slideAngle = config.minSlopeSlideAngle ?? Math.PI / 4;
    const autostep = config.autostep === undefined ? false : config.autostep;
    const snap = config.snapToGround === undefined ? 0.2 : config.snapToGround;
    const snapRel = config.snapRelative ?? true;

    let flags = 0;
    if (slide) flags |= 0x01;
    if (autostep !== false) {
      flags |= 0x02;
      if (autostep.includeDynamic ?? true) flags |= 0x04;
      const rel = autostep.relative ? 1 : 0;
      flags |= (rel << 4) | (rel << 5);
    }
    if (snap !== false) flags |= 0x08;
    if (snapRel) flags |= 0x40;

    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    buf[0] = flags;
    dv.setFloat32(1, climbAngle, true);
    dv.setFloat32(5, slideAngle, true);
    dv.setUint16(9, autostep !== false ? Math.round(autostep.maxHeight * 100) : 0, true);
    dv.setUint16(11, autostep !== false ? Math.round(autostep.minWidth * 100) : 0, true);
    dv.setUint16(13, snap !== false ? Math.round(snap * 100) : 0, true);
    buf[15] = 0;

    this.writeCommand(CommandType.SetCharacterConfig, entityId, buf);
  }

  moveCharacter(entityId: number, dx: number, dy: number): void {
    const buf = new Float32Array([dx, dy]);
    this.writeCommand(CommandType.MoveCharacter, entityId, new Uint8Array(buf.buffer));
  }

  /**
   * Toggle physics debug rendering (Phase 16). Coalescable last-write-wins;
   * only effective on physics-debug WASM builds (no-op otherwise).
   */
  setPhysicsDebugRender(enabled: boolean): void {
    this.writeCommand(CommandType.SetPhysicsDebugRender, 0, new Uint8Array([enabled ? 1 : 0]));
  }

  // ── Audit 2026-07 additions ──────────────────────────────────

  /**
   * Enable Rapier event reporting on this entity's collider.
   * Colliders are created with events OFF, so without this call no
   * `onCollisionStart` / `onContactForce` callback can ever fire.
   * Works before the collider exists (staged onto the pending collider).
   */
  setColliderEvents(entityId: number, collision: boolean, contactForce = false): boolean {
    const mask = (collision ? 0x01 : 0) | (contactForce ? 0x02 : 0);
    return this.writeCommand(CommandType.SetColliderEvents, entityId, new Uint8Array([mask]));
  }

  /**
   * Reposition a physics body. This is the only way to move a dynamic or
   * fixed body — `setPosition` alone is overwritten by the next physics step
   * for bodies Rapier owns.
   */
  teleportBody(entityId: number, x: number, y: number, rot = 0, zeroVelocity = true): boolean {
    const buf = new Uint8Array(13);
    const dv = new DataView(buf.buffer);
    dv.setFloat32(0, x, true);
    dv.setFloat32(4, y, true);
    dv.setFloat32(8, rot, true);
    buf[12] = zeroVelocity ? 0x01 : 0x00;
    return this.writeCommand(CommandType.TeleportBody, entityId, buf);
  }

  /**
   * Pin an explicit culling / hit-test radius, disabling the automatic
   * derivation from the world matrix. Pass a negative value to restore it.
   */
  setBoundingRadius(entityId: number, radius: number): boolean {
    return this.writeCommand(CommandType.SetBoundingRadius, entityId, new Float32Array([radius]));
  }

  /** Remove this entity's character controller without destroying the entity. */
  destroyCharacterController(entityId: number): boolean {
    return this.writeCommand(CommandType.DestroyCharacterController, entityId);
  }

  /**
   * Explicit "up" axis for the character controller. When unset the engine
   * derives it from gravity (`up = -normalize(gravity)`), falling back to
   * +Y when gravity is zero.
   */
  setCharacterUp(entityId: number, ux: number, uy: number): boolean {
    return this.writeCommand(CommandType.SetCharacterUp, entityId, new Float32Array([ux, uy]));
  }

  // ── Phase 17: 2D lighting ────────────────────────────────────

  /**
   * Describe a light: shape, blend mode and the 16 layers it illuminates.
   * Colour, range and cone angles travel through `setPrimParams0/1` instead —
   * they are ordinary f32 and fit the existing slots.
   *
   * Encoded by hand rather than as a Float32Array: `writeCommand`'s
   * Float32Array branch walks whole f32 slots and cannot express the
   * `u8 + u8 + u16` layout.
   */
  setLightFlags(
    entityId: number,
    lightType: number | null,
    blendMode: number | null,
    lightMask: number,
  ): boolean {
    const buf = new Uint8Array(4);
    const dv = new DataView(buf.buffer);
    // `lightType` uses 3 bits and `blendMode` 2, so bit 7 of each byte is free
    // to mean "preserve what is stored". That is how `lightLayers()` changes
    // only the mask without restating the light's shape.
    buf[0] = lightType === null ? 0x80 : lightType & 0b111;
    buf[1] = blendMode === null ? 0x80 : blendMode & 0b11;
    dv.setUint16(2, lightMask & 0xffff, true);
    return this.writeCommand(CommandType.SetLightFlags, entityId, buf);
  }

  /**
   * Per-entity lighting participation. Both default to off: an entity opts in
   * to casting shadows and to being lit, so unlit sprites skip the light
   * buffer lookup entirely.
   *
   * Pass `null` for either flag to leave it as it is. That is what makes
   * `EntityHandle.castsShadow()` and `.receivesLight()` independent — without
   * it, one command carrying both bits would have each call silently clear the
   * other. Encoded as preserve bits 2-3, so 0 still means "write both".
   */
  setLightingFlags(
    entityId: number,
    castsShadow: boolean | null,
    receivesLight: boolean | null,
  ): boolean {
    const bits =
      (castsShadow ? 0b0001 : 0) |
      (receivesLight ? 0b0010 : 0) |
      (castsShadow === null ? 0b0100 : 0) |
      (receivesLight === null ? 0b1000 : 0);
    return this.writeCommand(CommandType.SetLightingFlags, entityId, new Uint8Array([bits]));
  }

  /**
   * Global ambient light. Engine-level (`entity_id = 0` sentinel), like
   * `setPhysicsDebugRender`. It becomes the clear colour of the light
   * accumulation buffer, which is why global light costs nothing to render.
   */
  setAmbientLight(r: number, g: number, b: number, intensity = 1.0): boolean {
    return this.writeCommand(
      CommandType.SetAmbientLight,
      0,
      new Float32Array([r, g, b, intensity]),
    );
  }

  /** Select the lighting backend: 0=off, 1=lit, 2=gi. Engine-level. */
  setLightingBackend(backend: number): boolean {
    return this.writeCommand(
      CommandType.SetLightingBackend,
      0,
      new Uint8Array([backend & 0xff]),
    );
  }
}
