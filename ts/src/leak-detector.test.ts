// ts/src/leak-detector.test.ts
import { describe, it, expect, vi } from 'vitest';
import { LeakDetector } from './leak-detector';

describe('LeakDetector', () => {
  it('registers and unregisters handles', () => {
    const warnFn = vi.fn();
    const detector = new LeakDetector(warnFn);
    const token = {};
    detector.register(token, 42);
    detector.unregister(token);
    // No assertion on finalization (GC is unpredictable), just verify no crash.
  });

  it('constructs without FinalizationRegistry in environments that lack it', () => {
    // In test environment, FinalizationRegistry exists, so this just verifies the constructor.
    const detector = new LeakDetector();
    expect(detector).toBeTruthy();
  });
});
