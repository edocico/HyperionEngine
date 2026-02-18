import { describe, it, expect, vi } from 'vitest';
import { WorkerSupervisor } from './supervisor';

function createMockSAB(): SharedArrayBuffer {
  return new SharedArrayBuffer(1024);
}

describe('WorkerSupervisor', () => {
  it('should detect heartbeat timeout after 3 missed checks', () => {
    const sab = createMockSAB();
    const onTimeout = vi.fn();
    const supervisor = new WorkerSupervisor(sab, { onTimeout, checkIntervalMs: 10 });

    // Heartbeat never incremented → should fire after 3 checks
    supervisor.check(); // miss 1
    supervisor.check(); // miss 2
    supervisor.check(); // miss 3 → timeout
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('should reset miss count when heartbeat advances', () => {
    const sab = createMockSAB();
    const header = new Int32Array(sab);
    const onTimeout = vi.fn();
    const supervisor = new WorkerSupervisor(sab, { onTimeout, checkIntervalMs: 10 });

    supervisor.check(); // miss 1
    Atomics.add(header, 4, 1); // Worker increments heartbeat at i32 index 4 (byte 16)
    supervisor.check(); // heartbeat advanced → reset
    supervisor.check(); // miss 1 again
    supervisor.check(); // miss 2
    expect(onTimeout).not.toHaveBeenCalled(); // only 2 misses, need 3
  });

  it('should read overflow counter', () => {
    const sab = createMockSAB();
    const header = new Int32Array(sab);
    Atomics.store(header, 7, 42); // overflow counter at i32 index 7 (byte 28)
    const supervisor = new WorkerSupervisor(sab, {});
    expect(supervisor.overflowCount).toBe(42);
  });
});
