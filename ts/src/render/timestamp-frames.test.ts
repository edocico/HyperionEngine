import { describe, it, expect } from 'vitest';
import {
  StampHistory, TimingWindow, evaluateFrame, WINDOW, DISCARD_ORDER, type ResolvedFrame,
} from './timestamp-frames';
import type { TimedPair } from './timestamp-intercept';

/** A resolved frame: one [name, work, begin, end] per pair, stamps in nanoseconds. */
function frameOf(
  pairs: Array<[string, boolean, bigint, bigint]>,
  opts: { truncated?: boolean; executed?: boolean } = {},
): ResolvedFrame {
  const stamps = new BigUint64Array(pairs.length * 2);
  pairs.forEach(([, , b, e], k) => { stamps[2 * k] = b; stamps[2 * k + 1] = e; });
  return {
    stamps,
    pairs: pairs.map(([name, work]): TimedPair => ({ name, work })),
    truncated: opts.truncated ?? false,
    executed: opts.executed ?? true,
  };
}
const ms = (n: number) => BigInt(Math.round(n * 1e6));

describe('evaluateFrame', () => {
  it('sums the durations per name and measures the span from the first begin to the last end', () => {
    const v = evaluateFrame(frameOf([
      ['cull', true, 1_000_000n, 1_000_000n + ms(0.25)],
      ['lg/sdf', true, 2_000_000n, 2_000_000n + ms(1)],
      ['lg/sdf', true, 4_000_000n, 4_000_000n + ms(2)],
    ]), new StampHistory(6));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.totalsMs.get('cull')).toBeCloseTo(0.25, 9);
    expect(v.totalsMs.get('lg/sdf')).toBeCloseTo(3, 9);
    expect(v.spanMs).toBeCloseTo(5, 9);
  });

  it('with overlapping passes the span is below the sum (the shape measured on the M2 in M7)', () => {
    const v = evaluateFrame(frameOf([
      ['compute', true, 1n, ms(3) + 1n],
      ['render', true, ms(0.05) + 1n, ms(3.29) + 1n],
    ]), new StampHistory(4));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const sum = [...v.totalsMs.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(6.24, 6);
    expect(v.spanMs).toBeCloseTo(3.29, 6);
  });

  it('a pair whose end equals its begin is valid and counts 0 ms (a quantized stamp)', () => {
    const t = 65_536n * 100n;
    const v = evaluateFrame(frameOf([['short', true, t, t], ['long', true, t, t + 65_536n]]), new StampHistory(4));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.totalsMs.get('short')).toBe(0);
  });

  it('a pair without work is ignored whatever its stamps say, and its name counts 0 ms', () => {
    const v = evaluateFrame(frameOf([
      ['never-written', false, 0n, 0n],
      ['clear-only', false, 9n, 3n],
      ['forward', true, 10n, 20n],
    ]), new StampHistory(6));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.totalsMs.get('never-written')).toBe(0);
    expect(v.totalsMs.get('clear-only')).toBe(0);
    expect(v.spanMs).toBeCloseTo(10 / 1e6, 12);
  });

  it('discards with the reason and the first pass that caused it', () => {
    const h = new StampHistory(8);
    expect(evaluateFrame(frameOf([['a', true, 0n, 5n]]), h)).toEqual({ ok: false, reason: 'zero', pass: 'a' });
    expect(evaluateFrame(frameOf([['a', true, 9n, 5n]]), h)).toEqual({ ok: false, reason: 'reversed', pass: 'a' });
    expect(evaluateFrame(frameOf([['a', false, 1n, 2n]]), h)).toEqual({ ok: false, reason: 'empty' });
    expect(evaluateFrame(frameOf([], {}), h)).toEqual({ ok: false, reason: 'empty' });
    expect(evaluateFrame(frameOf([['a', true, 1n, 2n]], { truncated: true }), h)).toEqual({ ok: false, reason: 'truncated' });
    expect(evaluateFrame(frameOf([['a', true, 1n, 2n]], { executed: false }), h)).toEqual({ ok: false, reason: 'unexecuted' });
  });

  it('a pair with work whose stamps were not refreshed is stale', () => {
    const history = new StampHistory(2);
    const first = frameOf([['overlay/x', true, 100n, 200n]]);
    expect(evaluateFrame(first, history).ok).toBe(true);
    history.record(first.stamps);
    expect(evaluateFrame(frameOf([['overlay/x', true, 100n, 200n]]), history))
      .toEqual({ ok: false, reason: 'stale', pass: 'overlay/x' });
    expect(evaluateFrame(frameOf([['overlay/x', true, 300n, 450n]]), history).ok).toBe(true);
  });

  it('each stale check stands alone: a fresh begin with an old end is stale, an old begin with a fresh end too', () => {
    // The first case is Metal's fresh begin and stale end after the timer's absolute
    // values jumped between submits (M7): the old end is then not below the new begin.
    const history = new StampHistory(2);
    history.record(new BigUint64Array([100n, 200n]));
    expect(evaluateFrame(frameOf([['p', true, 150n, 200n]]), history)).toEqual({ ok: false, reason: 'stale', pass: 'p' });
    expect(evaluateFrame(frameOf([['p', true, 100n, 250n]]), history)).toEqual({ ok: false, reason: 'stale', pass: 'p' });
  });

  it('a zero end alone is zero, not reversed', () => {
    expect(evaluateFrame(frameOf([['p', true, 5n, 0n]]), new StampHistory(2))).toEqual({ ok: false, reason: 'zero', pass: 'p' });
  });

  it('the first reason in DISCARD_ORDER wins when several apply', () => {
    expect(DISCARD_ORDER).toEqual(['unexecuted', 'truncated', 'zero', 'reversed', 'stale', 'empty']);
    const history = new StampHistory(6);
    history.record(new BigUint64Array([5n, 6n, 0n, 0n, 0n, 0n]));
    const all = frameOf([['stale', true, 5n, 6n], ['rev', true, 9n, 7n], ['zero', true, 0n, 3n]]);
    expect(evaluateFrame(all, history)).toEqual({ ok: false, reason: 'zero', pass: 'zero' });
    expect(evaluateFrame({ ...all, truncated: true }, history)).toEqual({ ok: false, reason: 'truncated' });
    expect(evaluateFrame({ ...all, truncated: true, executed: false }, history)).toEqual({ ok: false, reason: 'unexecuted' });
  });

  it('two pairs failing for the same reason: the verdict names the FIRST pair', () => {
    const history = new StampHistory(4);
    history.record(new BigUint64Array([100n, 200n, 300n, 400n]));
    expect(evaluateFrame(frameOf([['first', true, 0n, 5n], ['second', true, 0n, 6n]]), new StampHistory(4)))
      .toEqual({ ok: false, reason: 'zero', pass: 'first' });
    expect(evaluateFrame(frameOf([['first', true, 9n, 5n], ['second', true, 8n, 6n]]), new StampHistory(4)))
      .toEqual({ ok: false, reason: 'reversed', pass: 'first' });
    expect(evaluateFrame(frameOf([['first', true, 100n, 200n], ['second', true, 300n, 400n]]), history))
      .toEqual({ ok: false, reason: 'stale', pass: 'first' });
  });

  it('the span runs from the earliest begin to the latest end, whatever the order of the pairs', () => {
    // Out of order: the second pair begins and ends before the first.
    const outOfOrder = evaluateFrame(frameOf([
      ['a', true, ms(5), ms(9)],
      ['b', true, ms(1), ms(3)],
    ]), new StampHistory(4));
    expect(outOfOrder.ok).toBe(true);
    if (outOfOrder.ok) expect(outOfOrder.spanMs).toBeCloseTo(8, 9);
    // Nested: the last pair neither begins first nor ends last.
    const nested = evaluateFrame(frameOf([
      ['a', true, ms(1), ms(10)],
      ['b', true, ms(2), ms(5)],
    ]), new StampHistory(4));
    expect(nested.ok).toBe(true);
    if (nested.ok) expect(nested.spanMs).toBeCloseTo(9, 9);
  });

  it('a pair without work whose stamps repeat the RECORDED history does not discard the frame (Metal leaves them stale)', () => {
    const history = new StampHistory(4);
    const first = frameOf([['forward', true, 100n, 200n], ['idle', false, 300n, 400n]]);
    expect(evaluateFrame(first, history).ok).toBe(true);
    history.record(first.stamps);
    // 'forward' is refreshed; 'idle' opened a pass without work and kept its indices' stamps.
    const v = evaluateFrame(frameOf([['forward', true, 500n, 650n], ['idle', false, 300n, 400n]]), history);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.totalsMs.get('idle')).toBe(0);
    expect(v.totalsMs.get('forward')).toBeCloseTo(150 / 1e6, 12);
  });

  it('a frame with fewer stamps than two per pair is a wiring bug: RangeError, not a verdict from missing stamps', () => {
    const two = frameOf([['a', true, 1n, 2n], ['b', true, 3n, 4n]]);
    // Plausible non-zero values for the stamps that exist: only the count is wrong.
    const short = { ...two, stamps: new BigUint64Array([1n, 2n, 3n]) };
    expect(() => evaluateFrame(short, new StampHistory(4))).toThrow(RangeError);
    // Whatever the work: the stamps of a pair without work are never read, and this frame was accepted.
    const idle = {
      ...frameOf([['a', true, 1n, 2n], ['b', false, 0n, 0n]]),
      stamps: new BigUint64Array([1n, 2n]),
    };
    expect(() => evaluateFrame(idle, new StampHistory(4))).toThrow(RangeError);
    expect(() => evaluateFrame(two, new StampHistory(4))).not.toThrow();
  });
});

describe('StampHistory', () => {
  it('knows nothing until a frame is recorded, then flags a repeated value as stale', () => {
    const h = new StampHistory(4);
    expect(h.isStale(0, 0n)).toBe(false);
    h.record(new BigUint64Array([7n, 8n]));
    expect(h.isStale(0, 7n)).toBe(true);
    expect(h.isStale(1, 9n)).toBe(false);
    expect(h.isStale(2, 0n)).toBe(false);
  });

  it('record() of more stamps than its size is a wiring bug: RangeError, and nothing is recorded', () => {
    const h = new StampHistory(2);
    expect(() => h.record(new BigUint64Array([7n, 8n, 9n]))).toThrow(RangeError);
    expect(h.isStale(0, 7n)).toBe(false);
    expect(() => h.record(new BigUint64Array([7n, 8n]))).not.toThrow();
    expect(h.isStale(1, 8n)).toBe(true);
  });

  it('forget(n) and forgetAll() make indices unknown again', () => {
    const h = new StampHistory(4);
    h.record(new BigUint64Array([7n, 8n, 9n, 10n]));
    h.forget(2);
    expect(h.isStale(0, 7n)).toBe(false);
    expect(h.isStale(2, 9n)).toBe(true);
    h.forgetAll();
    expect(h.isStale(2, 9n)).toBe(false);
  });
});

describe('TimingWindow', () => {
  const push = (w: TimingWindow, entries: Record<string, number>, span = 1) =>
    w.push(new Map(Object.entries(entries)), span);
  const byName = (w: TimingWindow) => new Map(w.timings().map((t) => [t.name, t]));

  it('a name missing from a frame took 0 ms in it: its mean decays and lastMs is 0', () => {
    const w = new TimingWindow();
    push(w, { 'lg/seed': 2, 'lg/accum': 1 });
    push(w, { 'lg/accum': 1 });
    const seed = byName(w).get('lg/seed')!;
    expect(seed.lastMs).toBe(0);
    expect(seed.sampleCount).toBe(2);
    expect(seed.averageMs).toBeCloseTo(1, 9);
  });

  it('forgets a name once it has been missing for a whole window', () => {
    const w = new TimingWindow();
    push(w, { 'lg/seed': 2, 'lg/accum': 1 });
    for (let i = 0; i < WINDOW; i++) push(w, { 'lg/accum': 1 });
    expect(byName(w).has('lg/seed')).toBe(false);
  });

  it('forgets a name only after a whole window without it, even if it measured 0 ms', () => {
    const w = new TimingWindow();
    push(w, { a: 1, z: 0 });
    push(w, { a: 1 });
    expect(byName(w).has('z')).toBe(true);
    for (let i = 0; i < WINDOW - 2; i++) push(w, { a: 1 });
    expect(byName(w).has('z')).toBe(true);
    push(w, { a: 1 });
    expect(byName(w).has('z')).toBe(false);
  });

  it('a name appearing mid-window is averaged per frame too: every name has the same sample count', () => {
    const w = new TimingWindow();
    for (let i = 0; i < 3; i++) push(w, { a: 1 });
    push(w, { a: 1, b: 4 });
    const b = byName(w).get('b')!;
    expect(b.sampleCount).toBe(4);
    expect(b.averageMs).toBeCloseTo(1, 9);
    expect(b.lastMs).toBeCloseTo(4, 9);
  });

  it('never forgets a name that is still measured, even at 0 ms', () => {
    const w = new TimingWindow();
    for (let i = 0; i < WINDOW + 5; i++) push(w, { 'lg/seed': 0 });
    expect(byName(w).has('lg/seed')).toBe(true);
  });

  it('averages across frames, which is what defeats the quantization (65.5 us on Metal without the flag)', () => {
    const w = new TimingWindow();
    push(w, { jfa: 0 });
    push(w, { jfa: 0.065536 });
    expect(byName(w).get('jfa')!.averageMs).toBeCloseTo(0.032768, 9);
  });

  it('caps history at WINDOW samples', () => {
    const w = new TimingWindow();
    for (let i = 0; i < WINDOW + 25; i++) push(w, { forward: 1 });
    expect(byName(w).get('forward')!.sampleCount).toBe(WINDOW);
  });

  it('frameTiming: null before the first frame, then the mean, last and count of the spans', () => {
    const w = new TimingWindow();
    expect(w.frameTiming()).toBeNull();
    push(w, { a: 1 }, 2);
    push(w, { a: 1 }, 4);
    expect(w.frameTiming()).toEqual({ averageMs: 3, lastMs: 4, sampleCount: 2 });
    for (let i = 0; i < WINDOW + 3; i++) push(w, { a: 1 }, 1);
    expect(w.frameTiming()!.sampleCount).toBe(WINDOW);
  });

  it('clear() drops everything', () => {
    const w = new TimingWindow();
    push(w, { a: 1 });
    w.clear();
    expect(w.timings()).toEqual([]);
    expect(w.frameTiming()).toBeNull();
  });
});
