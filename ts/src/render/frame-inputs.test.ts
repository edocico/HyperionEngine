import { describe, it, expect } from 'vitest';
import { normalizeTransparentCount, normalizeIdsGeneration, nextFrameStamp } from './frame-inputs';

describe('normalizeTransparentCount', () => {
  it('keeps a finite count, floored and never negative', () => {
    expect(normalizeTransparentCount(5, 10)).toBe(5);
    expect(normalizeTransparentCount(0, 10)).toBe(0);
    expect(normalizeTransparentCount(2.7, 10)).toBe(2);
    expect(normalizeTransparentCount(-3, 10)).toBe(0);
  });

  it('falls back to entityCount when the count is missing or not finite — never to 0', () => {
    expect(normalizeTransparentCount(undefined, 12)).toBe(12);
    expect(normalizeTransparentCount(NaN, 12)).toBe(12);
    expect(normalizeTransparentCount(Infinity, 12)).toBe(12);
    // An untyped worker message can carry anything.
    expect(normalizeTransparentCount(null as unknown as number, 12)).toBe(12);
    expect(normalizeTransparentCount('4' as unknown as number, 12)).toBe(12);
  });
});

describe('normalizeIdsGeneration', () => {
  it('keeps a finite generation, 0 included', () => {
    expect(normalizeIdsGeneration(0)).toBe(0);
    expect(normalizeIdsGeneration(7)).toBe(7);
    expect(normalizeIdsGeneration(0xFFFFFFFF)).toBe(0xFFFFFFFF);
  });

  it('turns a missing or non-finite generation into NaN, which equals no marker', () => {
    for (const g of [undefined, NaN, Infinity, null as unknown as number]) {
      const n = normalizeIdsGeneration(g);
      expect(Number.isNaN(n)).toBe(true);
      expect(n === n).toBe(false);
    }
  });
});

describe('nextFrameStamp', () => {
  it('starts at 1 and counts up', () => {
    expect(nextFrameStamp(0)).toBe(1);
    expect(nextFrameStamp(1)).toBe(2);
    expect(nextFrameStamp(0xFFFFFFFD)).toBe(0xFFFFFFFE);
  });

  it('wraps from 0xFFFFFFFE back to 1: never 0 and never the 0xFFFFFFFF sentinel', () => {
    expect(nextFrameStamp(0xFFFFFFFE)).toBe(1);
    let s = 0xFFFFFFF0;
    for (let i = 0; i < 40; i++) {
      s = nextFrameStamp(s);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(0xFFFFFFFE);
    }
  });
});
