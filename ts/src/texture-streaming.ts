/**
 * StreamingScheduler — manages progressive KTX2 texture loading with bandwidth budgets.
 *
 * Enqueues textures by URL, fetches header/SGD/mips in priority order
 * (lower priority number = loaded first), and respects a per-frame byte budget.
 *
 * State machine per entry:
 *   pending -> header-fetched -> sgd-loaded -> partial-mips -> complete
 *                                                           \-> error
 */

import { KTX2StreamLoader, type KTX2StreamHeader } from './ktx2-stream-loader';

export type TextureStreamState =
  | 'pending'
  | 'header-fetched'
  | 'sgd-loaded'
  | 'partial-mips'
  | 'complete'
  | 'error';

export interface StreamingConfig {
  /** Max bytes to fetch per tick. Default: 256KB. */
  budgetBytesPerFrame: number;
  /** Max parallel fetch operations. Default: 4. */
  maxConcurrentFetches: number;
}

export const DEFAULT_STREAMING_CONFIG: StreamingConfig = {
  budgetBytesPerFrame: 256 * 1024,
  maxConcurrentFetches: 4,
};

interface StreamEntry {
  url: string;
  priority: number; // Lower = higher priority (viewport distance)
  state: TextureStreamState;
  header: KTX2StreamHeader | null;
  sgdData: ArrayBuffer | null;
  nextMipLevel: number; // Next mip to fetch (starts from highest = smallest)
  totalBytesLoaded: number;
  rangeSupported: boolean | null; // null = not checked yet
  onMipLoaded?: (level: number, data: ArrayBuffer, header: KTX2StreamHeader) => void;
}

export class StreamingScheduler {
  private entries = new Map<string, StreamEntry>();
  private loader: KTX2StreamLoader;
  private config: StreamingConfig;
  private _bytesLoadedThisFrame = 0;
  private _activeFetches = 0;

  constructor(config?: Partial<StreamingConfig>, loader?: KTX2StreamLoader) {
    this.config = { ...DEFAULT_STREAMING_CONFIG, ...config };
    this.loader = loader ?? new KTX2StreamLoader();
  }

  /** Bytes fetched during the last tick(). */
  get bytesLoadedThisFrame(): number {
    return this._bytesLoadedThisFrame;
  }

  /** Number of in-flight fetch operations. */
  get activeFetches(): number {
    return this._activeFetches;
  }

  /**
   * Enqueue a texture for streaming. Lower priority = loaded first.
   * Re-enqueuing an existing URL updates its priority only.
   */
  enqueue(
    url: string,
    priority: number,
    onMipLoaded?: (level: number, data: ArrayBuffer, header: KTX2StreamHeader) => void,
  ): void {
    const existing = this.entries.get(url);
    if (existing) {
      existing.priority = priority;
      return;
    }
    this.entries.set(url, {
      url,
      priority,
      state: 'pending',
      header: null,
      sgdData: null,
      nextMipLevel: -1,
      totalBytesLoaded: 0,
      rangeSupported: null,
      onMipLoaded,
    });
  }

  /** Get the current state of a texture. */
  getState(url: string): TextureStreamState | undefined {
    return this.entries.get(url)?.state;
  }

  /** Remove a texture from the scheduler. */
  remove(url: string): void {
    this.entries.delete(url);
  }

  /**
   * Process one tick of streaming. Respects bandwidth budget.
   * Should be called once per frame.
   */
  async tick(): Promise<void> {
    this._bytesLoadedThisFrame = 0;

    // Sort entries by priority (lowest number first = highest priority)
    const pending = [...this.entries.values()]
      .filter((e) => e.state !== 'complete' && e.state !== 'error')
      .sort((a, b) => a.priority - b.priority);

    for (const entry of pending) {
      if (this._bytesLoadedThisFrame >= this.config.budgetBytesPerFrame) break;
      if (this._activeFetches >= this.config.maxConcurrentFetches) break;

      await this.processEntry(entry);
    }
  }

  private async processEntry(entry: StreamEntry): Promise<void> {
    try {
      switch (entry.state) {
        case 'pending': {
          // Phase 1: Fetch header + check range support
          this._activeFetches++;
          try {
            entry.header = await this.loader.fetchHeader(entry.url);
            entry.rangeSupported = await this.loader.isRangeSupported(entry.url);
          } finally {
            this._activeFetches--;
          }
          this._bytesLoadedThisFrame += 256; // header fetch ~256 bytes
          entry.totalBytesLoaded += 256;

          if (!entry.rangeSupported) {
            // Fallback: server doesn't support Range, mark complete (full fetch elsewhere)
            entry.state = 'complete';
            return;
          }

          entry.state = 'header-fetched';
          // Start from smallest mip (highest level number)
          entry.nextMipLevel = entry.header.levelCount - 1;
          break;
        }

        case 'header-fetched': {
          // Phase 2: Fetch SGD if needed
          if (
            entry.header!.supercompressionScheme > 0 &&
            entry.header!.sgdByteLength > 0
          ) {
            this._activeFetches++;
            try {
              entry.sgdData = await this.loader.fetchSGD(entry.url, entry.header!);
            } finally {
              this._activeFetches--;
            }
            const sgdBytes = entry.header!.sgdByteLength;
            this._bytesLoadedThisFrame += sgdBytes;
            entry.totalBytesLoaded += sgdBytes;
          } else {
            entry.sgdData = null;
          }
          entry.state = 'sgd-loaded';
          break;
        }

        case 'sgd-loaded':
        case 'partial-mips': {
          // Phase 3: Fetch mip levels from smallest to largest
          if (entry.nextMipLevel < 0) {
            entry.state = 'complete';
            return;
          }

          const level = entry.nextMipLevel;
          const levelInfo = entry.header!.levels[level];

          // Check budget before fetching
          if (
            this._bytesLoadedThisFrame + levelInfo.byteLength >
            this.config.budgetBytesPerFrame
          ) {
            break; // Over budget, defer to next tick
          }

          this._activeFetches++;
          let data: ArrayBuffer;
          try {
            data = await this.loader.fetchMipLevel(entry.url, entry.header!, level);
          } finally {
            this._activeFetches--;
          }
          this._bytesLoadedThisFrame += levelInfo.byteLength;
          entry.totalBytesLoaded += levelInfo.byteLength;

          // Callback for TextureManager to upload this mip
          entry.onMipLoaded?.(level, data, entry.header!);

          entry.nextMipLevel--;
          entry.state = entry.nextMipLevel < 0 ? 'complete' : 'partial-mips';
          break;
        }
      }
    } catch {
      entry.state = 'error';
    }
  }

  /** Number of entries in the scheduler. */
  get size(): number {
    return this.entries.size;
  }

  /** Destroy and clean up. */
  destroy(): void {
    this.entries.clear();
  }
}
