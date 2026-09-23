import { describe, it, expect } from 'vitest';
import { harnessMode } from './preferred-mode';

describe('harnessMode', () => {
  it('defaults to Mode B, where the main thread renders and every check can run', () => {
    expect(harnessMode('')).toBe('B');
  });

  it('honours ?mode= for A, B, C and auto, case-insensitively', () => {
    expect(harnessMode('?mode=a')).toBe('A');
    expect(harnessMode('?mode=C')).toBe('C');
    expect(harnessMode('?mode=auto')).toBe('auto');
    expect(harnessMode('?tab=input&mode=b')).toBe('B');
  });

  it('falls back to Mode B on an unknown value', () => {
    expect(harnessMode('?mode=z')).toBe('B');
  });
});
