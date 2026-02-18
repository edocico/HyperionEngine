import type { RingBufferProducer } from './ring-buffer';
import { CommandType } from './ring-buffer';

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
