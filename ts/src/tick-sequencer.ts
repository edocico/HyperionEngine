// ts/src/tick-sequencer.ts

/**
 * Which ticks the engine has processed, for the entity id quarantine
 * (EntityIdAllocator). Each bridge numbers the ticks it sends; Mode A/B
 * workers echo the number in `tick-done`, Mode C acknowledges synchronously.
 *
 * The contract every bridge keeps: once the engine has processed tick `s`, it
 * has consumed every command written before tick `s` was sent. A flush happens
 * at the start of `tick()`, before `send()`, so a command written now is
 * consumed by the tick numbered `nextSeq` at the latest — earlier, when a
 * lagging worker handles an older tick after the write (it reads up to the
 * write head). `processed.seq >= nextSeq-at-write` therefore proves it consumed.
 */
export class TickSequencer {
  private sent = 0;
  private processedSeq = 0;
  private processedTickCount = 0;

  /** The number the next tick will carry. */
  get nextSeq(): number {
    return this.sent + 1;
  }

  /** Numbers a tick about to be sent. */
  send(): number {
    return ++this.sent;
  }

  /** The engine finished tick `seq`; its fixed-tick count is now `tickCount`. */
  ack(seq: number | undefined, tickCount: number | undefined): void {
    if (seq === undefined || seq <= this.processedSeq) return;
    this.processedSeq = seq;
    this.processedTickCount = tickCount ?? this.processedTickCount;
  }

  /** The latest processed tick and the fixed-tick count after it. */
  get processed(): { seq: number; tickCount: number } {
    return { seq: this.processedSeq, tickCount: this.processedTickCount };
  }
}
