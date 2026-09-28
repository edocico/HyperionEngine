import { PRIMITIVE_LIBRARIES, type PrimitivePieces } from './primitive-shaders';

/** How the collector waits: setTimeout in the app, a hand-fired fake in tests. */
export interface PieceReloadTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const DEFAULT_TIMERS: PieceReloadTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Groups the primitive-piece hot-reloads that Vite delivers one file at a time.
 *
 * A name renamed in the prelude together with its uses in a library arrives
 * as separate `accept` callbacks. Reloaded one by one, each piece is probed
 * against the OTHER piece's old text and both are rejected (and reloading the
 * page loses the device on the development machine). The collector waits for
 * a quiet window — a trailing debounce: every offer restarts the timer — and
 * hands every piece of the window to `apply` at once
 * (`GraphRequests.reloadShaders`).
 *
 * Per name it keeps the last NON-empty text. Editors truncate before writing,
 * so an empty save must never replace a good candidate waiting in the window;
 * a window holding only empty saves sends nothing.
 */
export class PieceReloadCollector {
  private readonly pending = new Map<string, string>();
  private handle: unknown = null;
  private armed = false;

  constructor(
    private readonly apply: (entries: Array<{ name: string; code: string }>) => Promise<unknown>,
    private readonly delayMs = 50,
    private readonly timers: PieceReloadTimers = DEFAULT_TIMERS,
  ) {}

  /** A piece's new text, as an HMR `accept` delivers it. */
  offer(name: string, code: string): void {
    if (code.trim() !== '') this.pending.set(name, code);
    this.disarm();
    this.armed = true;
    this.handle = this.timers.set(() => {
      this.armed = false;
      this.handle = null;
      this.flushNow();
    }, this.delayMs);
  }

  /** Send the window now: every pending piece, in the order first offered. */
  flushNow(): void {
    this.disarm();
    if (this.pending.size === 0) return;
    const entries = [...this.pending].map(([name, code]) => ({ name, code }));
    this.pending.clear();
    let settled: Promise<unknown>;
    try {
      settled = Promise.resolve(this.apply(entries));
    } catch (err) {
      settled = Promise.reject(err);
    }
    // An HMR callback has nobody to report to: log, never leave a rejection unhandled.
    settled.catch((err: unknown) => console.error('[Hyperion] Piece hot-reload failed:', err));
  }

  private disarm(): void {
    if (!this.armed) return;
    this.timers.clear(this.handle);
    this.armed = false;
    this.handle = null;
  }
}

/**
 * Throw when a primitive piece is empty or only whitespace. The renderer's
 * piece slots call it first thing in their probe, inside the GPU validation
 * window. A composed module is never empty (prelude, markers, wrappers), so
 * only the RAW pieces show an editor's truncated save. The throw is
 * synchronous: GraphRequests rejects the reload without superseding the edit
 * in flight.
 */
export function assertPiecesNotEmpty(pieces: PrimitivePieces): void {
  if (!pieces.prelude || pieces.prelude.trim() === '') throw new Error('Shader piece "prelude" is empty');
  for (const lib of PRIMITIVE_LIBRARIES) {
    const src = pieces.libraries[lib.type];
    if (!src || src.trim() === '') throw new Error(`Shader piece "${lib.name}" is empty`);
  }
}
