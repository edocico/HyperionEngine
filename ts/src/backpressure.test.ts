import { describe, it, expect } from 'vitest';
import { PrioritizedCommandQueue } from './backpressure';
import { CommandType } from './ring-buffer';

describe('PrioritizedCommandQueue', () => {
  it('should enqueue critical commands and never drop them', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SpawnEntity, 1);
    q.enqueue(CommandType.SpawnEntity, 2);
    q.enqueue(CommandType.DespawnEntity, 1);
    expect(q.criticalCount).toBe(3);
  });

  it('should keep only latest value per entity for overwrites', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SetPosition, 1, new Float32Array([1, 2, 3]));
    q.enqueue(CommandType.SetPosition, 1, new Float32Array([4, 5, 6]));
    expect(q.overwriteCount).toBe(1); // only latest kept
  });

  it('should drain critical commands before overwrites', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SetPosition, 1, new Float32Array([1, 2, 3]));
    q.enqueue(CommandType.SpawnEntity, 2);
    const drained: Array<{ cmd: number; entityId: number }> = [];
    q.drainTo({
      writeCommand(cmd: number, entityId: number) {
        drained.push({ cmd, entityId });
        return true;
      },
    } as any);
    expect(drained[0].cmd).toBe(CommandType.SpawnEntity); // critical first
    expect(drained[1].cmd).toBe(CommandType.SetPosition);
  });

  it('should stop draining when writeCommand returns false', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SpawnEntity, 1);
    q.enqueue(CommandType.SpawnEntity, 2);
    let count = 0;
    q.drainTo({
      writeCommand() { count++; return count < 2; }, // reject second
    } as any);
    expect(q.criticalCount).toBe(1); // one remains
  });

  it('should clear after successful drain', () => {
    const q = new PrioritizedCommandQueue();
    q.enqueue(CommandType.SpawnEntity, 1);
    q.drainTo({
      writeCommand() { return true; },
    } as any);
    expect(q.criticalCount).toBe(0);
    expect(q.overwriteCount).toBe(0);
  });
});
