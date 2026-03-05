import { RingBufferProducer, CommandType } from './ring-buffer';

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
const MAX_COMMAND_TYPE = 17; // CommandType values: 0..16

export class PrioritizedCommandQueue {
  private critical: QueuedCommand[] = [];
  private overwrites = new Map<number, QueuedCommand>(); // key = entityId * 256 + cmd
  private _coalescedCount = 0;
  private _purgedByDespawn = 0;

  get criticalCount(): number { return this.critical.length; }
  get overwriteCount(): number { return this.overwrites.size; }

  enqueue(cmd: CommandType, entityId: number, payload?: Float32Array | Uint8Array): void {
    if (cmd === CommandType.SpawnEntity || cmd === CommandType.DespawnEntity) {
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

  spawnEntity(entityId: number): boolean {
    return this.writeCommand(CommandType.SpawnEntity, entityId);
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
}
