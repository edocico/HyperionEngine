import { describe, it, expect } from 'vitest';
import { isBenchMode } from './bench-flag';

describe('isBenchMode', () => {
  it('is off without the flag', () => {
    expect(isBenchMode('')).toBe(false);
    expect(isBenchMode('?mode=B')).toBe(false);
  });

  it('is on with ?bench, alone or next to other parameters, with or without a value', () => {
    expect(isBenchMode('?bench')).toBe(true);
    expect(isBenchMode('?mode=C&bench')).toBe(true);
    expect(isBenchMode('?bench=1&mode=B')).toBe(true);
  });

  it('matches the parameter name only', () => {
    expect(isBenchMode('?benchmark')).toBe(false);
    expect(isBenchMode('?mode=bench')).toBe(false);
  });
});
