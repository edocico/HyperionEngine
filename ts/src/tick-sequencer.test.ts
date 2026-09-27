import { describe, it, expect } from 'vitest';
import { TickSequencer } from './tick-sequencer';

describe('TickSequencer', () => {
  it('numbers ticks from 1: a command written now is consumed by tick nextSeq at the latest', () => {
    const t = new TickSequencer();
    expect(t.nextSeq).toBe(1);
    expect(t.send()).toBe(1);
    expect(t.nextSeq).toBe(2);
    expect(t.send()).toBe(2);
  });

  it('starts with nothing processed', () => {
    expect(new TickSequencer().processed).toEqual({ seq: 0, tickCount: 0 });
  });

  it('records the echo of a processed tick with the engine fixed-tick count', () => {
    const t = new TickSequencer();
    t.send();
    t.ack(1, 42);
    expect(t.processed).toEqual({ seq: 1, tickCount: 42 });
  });

  it('ignores an echo without a seq (a worker that predates the protocol) or an older one', () => {
    const t = new TickSequencer();
    t.send();
    t.send();
    t.ack(2, 10);
    t.ack(undefined, 99);
    t.ack(1, 50);
    expect(t.processed).toEqual({ seq: 2, tickCount: 10 });
  });
});
