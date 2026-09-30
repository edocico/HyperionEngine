// ts/src/leak-detector.test.ts
import { describe, it, expect, vi } from 'vitest';
import { LeakDetector } from './leak-detector';
import type { HandleRegistry, RegistryFactory } from './leak-detector';

/**
 * A FinalizationRegistry the test drives by hand. A real one calls back
 * whenever V8 collects, and this suite runs without `--expose-gc`, so no test
 * can wait for or trigger a collection. A collection at a bad moment is also
 * what made the suite exit 1 at random: the callback's console.warn landed
 * while vitest was closing the worker.
 */
function manualRegistry() {
  let onCollected: (entityId: number) => void = () => {};
  let unregisterCalls = 0;
  const held = new Map<object, number>();
  const registry: HandleRegistry = {
    register: (_target, entityId, token) => { held.set(token, entityId); },
    unregister: (token) => { unregisterCalls++; return held.delete(token); },
  };
  const factory: RegistryFactory = (cb) => { onCollected = cb; return registry; };
  return {
    factory,
    registered: () => held.size,
    unregisterCalls: () => unregisterCalls,
    /** What V8 does once it has collected: one callback per handle still registered. */
    collectAll: () => {
      for (const [token, entityId] of [...held]) {
        held.delete(token);
        onCollected(entityId);
      }
    },
  };
}

describe('LeakDetector', () => {
  it('registers and unregisters handles', () => {
    const warnFn = vi.fn();
    const detector = new LeakDetector(warnFn);
    const token = {};
    detector.register(token, 42);
    detector.unregister(token);
    // No assertion on finalization (GC is unpredictable), just verify no crash.
  });

  it('constructs with every default, on the real FinalizationRegistry of this environment', () => {
    // The default factory meets the real global, which this environment has, so
    // it builds a real registry. The branch without one is the next test.
    expect(typeof FinalizationRegistry).toBe('function');
    const detector = new LeakDetector();
    expect(detector).toBeTruthy();
  });

  it('has no registry where FinalizationRegistry is missing: register, unregister and dispose do not throw', () => {
    // The stub makes the DEFAULT factory take its null branch. The 'dispose()
    // works where there is no FinalizationRegistry' test reaches the same state
    // through a hand-made factory, not through the default one.
    vi.stubGlobal('FinalizationRegistry', undefined);
    try {
      const detector = new LeakDetector();
      const handle = {};
      expect(() => detector.register(handle, 1)).not.toThrow();
      expect(() => detector.unregister(handle)).not.toThrow();
      expect(() => detector.dispose()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('warns, with the entity id, for a handle that is collected while registered', () => {
    const warn = vi.fn();
    const gc = manualRegistry();
    const detector = new LeakDetector(warn, gc.factory);
    detector.register({}, 42);
    gc.collectAll();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(42);
  });

  it('stays silent for a handle that was unregistered before it was collected', () => {
    const warn = vi.fn();
    const gc = manualRegistry();
    const detector = new LeakDetector(warn, gc.factory);
    const handle = {};
    detector.register(handle, 7);
    detector.unregister(handle);
    gc.collectAll();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn after dispose(), for a handle that was registered before it', () => {
    const warn = vi.fn();
    const gc = manualRegistry();
    const detector = new LeakDetector(warn, gc.factory);
    detector.register({}, 42);
    detector.dispose();
    gc.collectAll();
    expect(warn).not.toHaveBeenCalled();
  });

  it('dispose() is idempotent, and register/unregister after it do nothing', () => {
    const warn = vi.fn();
    const gc = manualRegistry();
    const detector = new LeakDetector(warn, gc.factory);
    detector.dispose();
    expect(() => detector.dispose()).not.toThrow();
    const late = {};
    detector.register(late, 9);
    expect(gc.registered()).toBe(0); // not handed to the registry
    detector.unregister(late);
    expect(gc.unregisterCalls()).toBe(0);
  });

  it('dispose() works where there is no FinalizationRegistry', () => {
    const detector = new LeakDetector(vi.fn(), () => null);
    detector.register({}, 1);
    expect(() => detector.dispose()).not.toThrow();
  });
});
