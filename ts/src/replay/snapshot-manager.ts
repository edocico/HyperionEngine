export interface SnapshotEntry {
  readonly tick: number;
  readonly data: Uint8Array;
}

export interface SnapshotManagerConfig {
  intervalTicks: number;
  maxSnapshots: number;
  snapshotCreate: () => Uint8Array;
}

export class SnapshotManager {
  private readonly config: SnapshotManagerConfig;
  private snapshots: (SnapshotEntry | undefined)[];
  private writeIdx = 0;
  private _count = 0;

  constructor(config: SnapshotManagerConfig) {
    this.config = config;
    this.snapshots = new Array(config.maxSnapshots);
  }

  get count(): number {
    return this._count;
  }

  onTick(tick: number): void {
    if (tick > 0 && tick % this.config.intervalTicks === 0) {
      const data = this.config.snapshotCreate();
      this.snapshots[this.writeIdx] = { tick, data };
      this.writeIdx = (this.writeIdx + 1) % this.config.maxSnapshots;
      if (this._count < this.config.maxSnapshots) this._count++;
    }
  }

  findNearest(targetTick: number): SnapshotEntry | null {
    let best: SnapshotEntry | null = null;
    const start = this._count < this.config.maxSnapshots ? 0 : this.writeIdx;
    for (let i = 0; i < this._count; i++) {
      const entry = this.snapshots[(start + i) % this.config.maxSnapshots]!;
      if (entry.tick <= targetTick) {
        if (!best || entry.tick > best.tick) {
          best = entry;
        }
      }
    }
    return best;
  }

  clear(): void {
    this.writeIdx = 0;
    this._count = 0;
  }
}
