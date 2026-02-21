import { RingBufferProducer, CommandType } from './ring-buffer';

export type BackpressureMode = 'retry-queue' | 'drop';

export interface QueuedCommand {
  cmd: CommandType;
  entityId: number;
  payload?: Float32Array;
}

export class PrioritizedCommandQueue {
  private critical: QueuedCommand[] = [];
  private overwrites = new Map<number, QueuedCommand>(); // key = entityId * 256 + cmd

  get criticalCount(): number { return this.critical.length; }
  get overwriteCount(): number { return this.overwrites.size; }

  enqueue(cmd: CommandType, entityId: number, payload?: Float32Array): void {
    if (cmd === CommandType.SpawnEntity || cmd === CommandType.DespawnEntity) {
      this.critical.push({ cmd, entityId, payload });
    } else {
      const key = entityId * 256 + cmd;
      this.overwrites.set(key, { cmd, entityId, payload });
    }
  }

  drainTo(rb: RingBufferProducer): void {
    // Critical first
    let i = 0;
    for (; i < this.critical.length; i++) {
      const c = this.critical[i];
      if (!rb.writeCommand(c.cmd, c.entityId, c.payload)) break;
    }
    this.critical.splice(0, i);

    // Do not attempt overwrites if any criticals remain unwritten.
    if (this.critical.length > 0) return;

    // Overwrites
    const toDelete: number[] = [];
    for (const [key, c] of this.overwrites) {
      if (!rb.writeCommand(c.cmd, c.entityId, c.payload)) break;
      toDelete.push(key);
    }
    for (const key of toDelete) {
      this.overwrites.delete(key);
    }
  }

  clear(): void {
    this.critical.length = 0;
    this.overwrites.clear();
  }
}

/**
 * Wraps a RingBufferProducer with automatic overflow queuing.
 *
 * When writeCommand() fails (ring buffer full), the command is enqueued
 * into a PrioritizedCommandQueue. Call flush() at the start of each tick
 * to drain queued commands back into the ring buffer.
 */
export class BackpressuredProducer {
  private readonly inner: RingBufferProducer;
  private readonly queue = new PrioritizedCommandQueue();

  constructor(inner: RingBufferProducer) {
    this.inner = inner;
  }

  get pendingCount(): number {
    return this.queue.criticalCount + this.queue.overwriteCount;
  }

  get freeSpace(): number {
    return this.inner.freeSpace;
  }

  flush(): void {
    this.queue.drainTo(this.inner);
  }

  writeCommand(cmd: CommandType, entityId: number, payload?: Float32Array): boolean {
    const ok = this.inner.writeCommand(cmd, entityId, payload);
    if (!ok) {
      this.queue.enqueue(cmd, entityId, payload);
    }
    return ok;
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
}
