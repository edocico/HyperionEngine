// ts/src/tick-sequencer.ts

/**
 * Which ticks the engine has processed, for the entity id quarantine
 * (EntityIdAllocator). Each bridge numbers the ticks it sends; Mode A/B
 * workers echo the number in `tick-done`, Mode C acknowledges synchronously.
 *
 * A tick consumes every command written before it was sent, so a command
 * written now (a flush happens at the start of `tick()`, before `send()`) is
 * consumed by the tick numbered `nextSeq` or a later one.
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
