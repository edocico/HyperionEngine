export interface TapeEntry {
  readonly tick: number;
  readonly timestamp: number;
  readonly type: number;
  readonly entityId: number;
  readonly payload: Uint8Array;
}

export interface CommandTape {
  readonly version: 1;
  readonly tickRate: number;
  readonly entries: TapeEntry[];
}

export class CommandTapeRecorder {
  private buffer: (TapeEntry | undefined)[];
  private readonly maxEntries: number;
  private writeIdx = 0;
  private count = 0;

  constructor(config: { maxEntries?: number } = {}) {
    this.maxEntries = config.maxEntries ?? 1_000_000;
    this.buffer = new Array(this.maxEntries);
  }

  get entryCount(): number {
    return this.count;
  }

  record(entry: TapeEntry): void {
    this.buffer[this.writeIdx] = entry;
    this.writeIdx = (this.writeIdx + 1) % this.maxEntries;
    if (this.count < this.maxEntries) this.count++;
  }

  clear(): void {
    this.writeIdx = 0;
    this.count = 0;
  }

  stop(): CommandTape {
    const start = this.count < this.maxEntries ? 0 : this.writeIdx;
    const entries: TapeEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      entries.push(this.buffer[(start + i) % this.maxEntries]!);
    }
    return { version: 1, tickRate: 1 / 60, entries };
  }
}
