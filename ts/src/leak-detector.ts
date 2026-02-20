type WarnFn = (entityId: number) => void;

const defaultWarn: WarnFn = (entityId) => {
  console.warn(
    `[Hyperion] EntityHandle for entity ${entityId} was garbage-collected without being destroyed. ` +
    `Call entity.destroy() explicitly to avoid resource leaks.`
  );
};

export class LeakDetector {
  private registry: FinalizationRegistry<number> | null;

  constructor(warnFn: WarnFn = defaultWarn) {
    if (typeof FinalizationRegistry !== 'undefined') {
      this.registry = new FinalizationRegistry<number>((entityId) => {
        warnFn(entityId);
      });
    } else {
      this.registry = null;
    }
  }

  register(handle: object, entityId: number): void {
    this.registry?.register(handle, entityId, handle);
  }

  unregister(handle: object): void {
    this.registry?.unregister(handle);
  }
}
