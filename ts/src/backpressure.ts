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
  /** Commands dropped by last-write-wins deduplication (same entity + command type). */
  coalescedCount: number;
  /** Pending overwrites purged because the entity was despawned. */
  purgedByDespawn: number;
}

/**
 * Maximum command type value (exclusive). Used for despawn purge iteration.
 * Must be updated if new CommandType variants are added.
 */
const MAX_COMMAND_TYPE = 47; // CommandType values: 0..46

/**
 * Returns true for commands that must NOT be coalesced (last-write-wins).
 * - Lifecycle: SpawnEntity, DespawnEntity
 * - Physics create/destroy: CreateRigidBody, DestroyRigidBody, CreateCollider, DestroyCollider
 * - Physics additive: ApplyForce, ApplyImpulse, ApplyTorque
 * - Physics joints: ALL joint commands (33-43) are non-coalescable
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
  return false;
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
      if (this.overwrites.has(key)) {
        this._coalescedCount++;
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
 * Non-lifecycle commands use last-write-wins deduplication per (entityId, commandType).
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
}
