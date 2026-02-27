import { describe, it, expect, vi } from 'vitest';
import { SnapshotManager } from './snapshot-manager';

describe('SnapshotManager', () => {
  const mockCreate = vi.fn(() => new Uint8Array([0x48, 0x53, 0x4E, 0x50, 1, 0, 0, 0]));

  it('captures a snapshot at the configured interval', () => {
    const mgr = new SnapshotManager({
      intervalTicks: 10,
      maxSnapshots: 5,
      snapshotCreate: mockCreate,
    });
    for (let t = 0; t < 10; t++) mgr.onTick(t);
    expect(mgr.count).toBe(0);
    mgr.onTick(10);
    expect(mgr.count).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('circular buffer evicts oldest snapshot', () => {
    const mgr = new SnapshotManager({
      intervalTicks: 1,
      maxSnapshots: 3,
      snapshotCreate: mockCreate,
    });
    for (let t = 1; t <= 5; t++) mgr.onTick(t);
    expect(mgr.count).toBe(3);
  });

  it('findNearest returns closest snapshot <= target tick', () => {
    const mgr = new SnapshotManager({
      intervalTicks: 10,
      maxSnapshots: 10,
      snapshotCreate: () => new Uint8Array(24),
    });
    mgr.onTick(10);
    mgr.onTick(20);
    mgr.onTick(30);
    const result = mgr.findNearest(25);
    expect(result).not.toBeNull();
    expect(result!.tick).toBe(20);
  });

  it('findNearest returns null when no snapshots <= target', () => {
    const mgr = new SnapshotManager({
      intervalTicks: 100,
      maxSnapshots: 5,
      snapshotCreate: mockCreate,
    });
    expect(mgr.findNearest(50)).toBeNull();
  });

  it('clear removes all snapshots', () => {
    const mgr = new SnapshotManager({
      intervalTicks: 1,
      maxSnapshots: 10,
      snapshotCreate: mockCreate,
    });
    mgr.onTick(1);
    mgr.onTick(2);
    expect(mgr.count).toBe(2);
    mgr.clear();
    expect(mgr.count).toBe(0);
  });
});
