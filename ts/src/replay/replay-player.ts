import type { CommandTape, TapeEntry } from './command-tape';

export interface ReplayCallbacks {
  reset: () => void;
  pushCommands: (data: Uint8Array) => void;
  update: (dt: number) => void;
}

export class ReplayPlayer {
  private readonly tape: CommandTape;
  private readonly callbacks: ReplayCallbacks;

  constructor(tape: CommandTape, callbacks: ReplayCallbacks) {
    this.tape = tape;
    this.callbacks = callbacks;
  }

  replayAll(): void {
    this.callbacks.reset();

    const { entries } = this.tape;
    if (entries.length === 0) return;

    const dt = this.tape.tickRate;
    const maxTick = entries[entries.length - 1].tick;

    let entryIdx = 0;

    for (let tick = 0; tick <= maxTick; tick++) {
      const tickEntries: TapeEntry[] = [];
      while (entryIdx < entries.length && entries[entryIdx].tick === tick) {
        tickEntries.push(entries[entryIdx]);
        entryIdx++;
      }

      if (tickEntries.length > 0) {
        const data = this.serializeBatch(tickEntries);
        this.callbacks.pushCommands(data);
      }

      this.callbacks.update(dt);
    }
  }

  private serializeBatch(entries: TapeEntry[]): Uint8Array {
    let totalSize = 0;
    for (const e of entries) {
      totalSize += 1 + 4 + e.payload.length;
    }

    const buf = new Uint8Array(totalSize);
    const dv = new DataView(buf.buffer);
    let offset = 0;

    for (const e of entries) {
      buf[offset] = e.type;
      offset += 1;
      dv.setUint32(offset, e.entityId, true);
      offset += 4;
      buf.set(e.payload, offset);
      offset += e.payload.length;
    }

    return buf;
  }
}
