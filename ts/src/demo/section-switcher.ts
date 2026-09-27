// ts/src/demo/section-switcher.ts

/**
 * Runs section switches one at a time, and only the latest one requested.
 *
 * A section's `setup()` is async (it awaits frames, timers, asset loads). If a
 * tab switch tears the section down while that setup is still in flight, the
 * setup carries on afterwards and installs hooks on handles the teardown has
 * already destroyed. The first such hook to fire throws, and the engine stops.
 * Serializing the switches makes every teardown follow the end of its setup;
 * skipping superseded requests keeps a burst of clicks from replaying every
 * intermediate tab.
 */
export class SectionSwitcher {
  private chain: Promise<void> = Promise.resolve();
  private latest = 0;

  constructor(
    private readonly run: (key: string) => Promise<void>,
    private readonly onError: (key: string, err: unknown) => void = (key, err) =>
      console.warn(`[switch:${key}]`, err),
  ) {}

  /** Queues a switch to `key`; resolves once it has run or been superseded. */
  request(key: string): Promise<void> {
    const seq = ++this.latest;
    this.chain = this.chain.then(async () => {
      if (seq !== this.latest) return;
      try {
        await this.run(key);
      } catch (err) {
        this.onError(key, err);
      }
    });
    return this.chain;
  }
}
