import { describe, it, expect } from 'vitest';
import { CommandTapeRecorder } from './command-tape';
import type { TapeEntry } from './command-tape';

function entry(tick: number, type: number, entityId: number): TapeEntry {
  return { tick, timestamp: tick * 16.667, type, entityId, payload: new Uint8Array(0) };
}

describe('CommandTapeRecorder', () => {
  it('records entries and returns tape on stop', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 100 });
    rec.record(entry(5, 3, 42));
    const tape = rec.stop();
    expect(tape.version).toBe(1);
    expect(tape.tickRate).toBeCloseTo(1 / 60);
    expect(tape.entries).toHaveLength(1);
    expect(tape.entries[0].tick).toBe(5);
    expect(tape.entries[0].entityId).toBe(42);
  });

  it('preserves payload bytes', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 10 });
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    rec.record({ tick: 0, timestamp: 0, type: 3, entityId: 1, payload });
    const tape = rec.stop();
    expect(tape.entries[0].payload).toEqual(payload);
  });

  it('circular buffer evicts oldest when full', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      rec.record(entry(i, 1, i));
    }
    const tape = rec.stop();
    expect(tape.entries).toHaveLength(3);
    expect(tape.entries[0].tick).toBe(2);
    expect(tape.entries[2].tick).toBe(4);
  });

  it('defaults to 1_000_000 maxEntries', () => {
    const rec = new CommandTapeRecorder();
    expect(rec).toBeDefined();
  });

  it('entryCount tracks live entries', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 5 });
    expect(rec.entryCount).toBe(0);
    rec.record(entry(0, 1, 0));
    rec.record(entry(1, 1, 1));
    expect(rec.entryCount).toBe(2);
  });

  it('clear resets the buffer', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 10 });
    rec.record(entry(0, 1, 0));
    rec.record(entry(1, 1, 1));
    rec.clear();
    expect(rec.entryCount).toBe(0);
    const tape = rec.stop();
    expect(tape.entries).toHaveLength(0);
  });

  it('stop returns entries in tick order', () => {
    const rec = new CommandTapeRecorder({ maxEntries: 100 });
    rec.record(entry(0, 1, 0));
    rec.record(entry(0, 3, 0));
    rec.record(entry(1, 3, 0));
    rec.record(entry(1, 6, 0));
    rec.record(entry(2, 3, 0));
    const tape = rec.stop();
    for (let i = 1; i < tape.entries.length; i++) {
      expect(tape.entries[i].tick).toBeGreaterThanOrEqual(tape.entries[i - 1].tick);
    }
  });
});
