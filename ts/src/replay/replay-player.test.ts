import { describe, it, expect, vi } from 'vitest';
import { ReplayPlayer } from './replay-player';
import type { CommandTape, TapeEntry } from './command-tape';

function entry(tick: number, type: number, entityId: number, payloadBytes?: number[]): TapeEntry {
  return {
    tick,
    timestamp: tick * 16.667,
    type,
    entityId,
    payload: new Uint8Array(payloadBytes ?? []),
  };
}

function makeTape(entries: TapeEntry[]): CommandTape {
  return { version: 1, tickRate: 1 / 60, entries };
}

describe('ReplayPlayer', () => {
  it('calls reset before replaying', () => {
    const reset = vi.fn();
    const update = vi.fn();
    const pushCommands = vi.fn();
    const tape = makeTape([entry(0, 1, 0)]);
    const player = new ReplayPlayer(tape, { reset, update, pushCommands });
    player.replayAll();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0],
    );
  });

  it('groups entries by tick and calls update per tick', () => {
    const reset = vi.fn();
    const update = vi.fn();
    const pushCommands = vi.fn();
    const tape = makeTape([
      entry(0, 1, 0),
      entry(0, 3, 0, [0, 0, 128, 63, 0, 0, 0, 0, 0, 0, 0, 0]),
      entry(1, 3, 0, [0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0]),
    ]);
    const player = new ReplayPlayer(tape, { reset, update, pushCommands });
    player.replayAll();
    expect(update).toHaveBeenCalledTimes(2);
    expect(pushCommands).toHaveBeenCalledTimes(2);
  });

  it('passes FIXED_DT to update', () => {
    const update = vi.fn();
    const tape = makeTape([entry(0, 1, 0)]);
    const player = new ReplayPlayer(tape, { reset: vi.fn(), update, pushCommands: vi.fn() });
    player.replayAll();
    expect(update).toHaveBeenCalledWith(1 / 60);
  });

  it('serializes commands as binary [type:u8][entityId:u32 LE][payload]', () => {
    const pushCommands = vi.fn();
    const tape = makeTape([entry(0, 1, 42)]);
    const player = new ReplayPlayer(tape, { reset: vi.fn(), update: vi.fn(), pushCommands });
    player.replayAll();
    const data: Uint8Array = pushCommands.mock.calls[0][0];
    expect(data[0]).toBe(1); // CommandType.SpawnEntity
    const dv = new DataView(data.buffer, data.byteOffset);
    expect(dv.getUint32(1, true)).toBe(42);
  });

  it('handles empty tape without error', () => {
    const reset = vi.fn();
    const update = vi.fn();
    const tape = makeTape([]);
    const player = new ReplayPlayer(tape, { reset, update, pushCommands: vi.fn() });
    player.replayAll();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('handles tape spanning multiple ticks with gaps', () => {
    const update = vi.fn();
    const tape = makeTape([
      entry(0, 1, 0),
      entry(5, 3, 0, new Array(12).fill(0)),
    ]);
    const player = new ReplayPlayer(tape, { reset: vi.fn(), update, pushCommands: vi.fn() });
    player.replayAll();
    expect(update).toHaveBeenCalledTimes(6);
  });
});
