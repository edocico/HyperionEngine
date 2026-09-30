type WarnFn = (entityId: number) => void;

/** The two methods of a `FinalizationRegistry` that the detector uses. */
export interface HandleRegistry {
  register(target: object, entityId: number, unregisterToken: object): void;
  unregister(unregisterToken: object): unknown;
}

/**
 * Builds the registry around the callback that reports a collected handle, or
 * returns null where there is no `FinalizationRegistry`. It is the test seam: a
 * real registry calls back whenever V8 collects, and no test in this suite can
 * wait for or trigger a collection, because the suite runs without
 * `--expose-gc` (a test under that flag could), so a test hands in a registry
 * it drives by hand.
 */
export type RegistryFactory = (onCollected: (entityId: number) => void) => HandleRegistry | null;

const defaultWarn: WarnFn = (entityId) => {
  console.warn(
    `[Hyperion] EntityHandle for entity ${entityId} was garbage-collected without being destroyed. ` +
    `Call entity.destroy() explicitly to avoid resource leaks.`
  );
};

const defaultRegistry: RegistryFactory = (onCollected) =>
  typeof FinalizationRegistry !== 'undefined' ? new FinalizationRegistry<number>(onCollected) : null;

export class LeakDetector {
  private registry: HandleRegistry | null;
  private disposed = false;

  constructor(warnFn: WarnFn = defaultWarn, createRegistry: RegistryFactory = defaultRegistry) {
    this.registry = createRegistry((entityId) => {
      if (!this.disposed) warnFn(entityId);
    });
  }

  register(handle: object, entityId: number): void {
    this.registry?.register(handle, entityId, handle);
  }

  unregister(handle: object): void {
    this.registry?.unregister(handle);
  }

  /**
   * Switches the detector off for good: a handle collected from now on warns
   * nothing, and `register`/`unregister` do nothing. Idempotent.
   *
   * `Hyperion.destroy()` calls it. An engine that is gone has no leak left to
   * report, and the registry calls back whenever V8 happens to collect, which
   * can be while the host is closing: under vitest a `console.warn` then lands
   * mid-teardown and the run exits 1 with every test green.
   */
  dispose(): void {
    this.disposed = true;
    this.registry = null;
  }
}
