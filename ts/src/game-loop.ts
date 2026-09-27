// ts/src/game-loop.ts

import type { SystemViews } from './system-views.js';

export type HookPhase = 'preTick' | 'postTick' | 'frameEnd';
export type HookFn = (dt: number, views?: SystemViews) => void;
export type TickFn = (dt: number) => void;

const DEFAULT_DT = 1 / 60;

/**
 * A hook that throws on this many calls in a row is removed: about a second at
 * 60 Hz. A hook left on a destroyed EntityHandle fails on every frame forever;
 * one waiting for something to load recovers, and one success resets its count.
 */
export const MAX_CONSECUTIVE_HOOK_FAILURES = 60;

/** One registration of a hook; registering the same function twice makes two. */
interface HookEntry {
  readonly fn: HookFn;
  /** Throws in a row; a successful call resets it. */
  failures: number;
}

export class GameLoop {
  private readonly tickFn: TickFn;
  /**
   * `null` is a registration removed while its phase was running: the list is
   * compacted when the phase ends, so no index shifts under the iteration.
   */
  private readonly hooks: Record<HookPhase, (HookEntry | null)[]> = {
    preTick: [],
    postTick: [],
    frameEnd: [],
  };
  /** The phase whose hooks are running, if any. */
  private runningPhase: HookPhase | null = null;
  /** Phases holding removed registrations to compact. */
  private readonly needsCompaction: Record<HookPhase, boolean> = {
    preTick: false,
    postTick: false,
    frameEnd: false,
  };

  private _running = false;
  private _paused = false;
  private rafId = 0;
  private lastTime = -1;
  private _fps = 0;
  private frameCount = 0;
  private fpsAccum = 0;
  private _frameDt = 0;
  private _frameTimeAvg = 0;
  private _frameTimeMax = 0;
  private dtSum = 0;
  private dtMax = 0;
  private _systemViews: SystemViews | null = null;

  constructor(tickFn: TickFn) {
    this.tickFn = tickFn;
  }

  get running(): boolean {
    return this._running;
  }

  get paused(): boolean {
    return this._paused;
  }

  get fps(): number {
    return this._fps;
  }

  get frameDt(): number {
    return this._frameDt;
  }

  get frameTimeAvg(): number {
    return this._frameTimeAvg;
  }

  get frameTimeMax(): number {
    return this._frameTimeMax;
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._paused = false;
    this.lastTime = -1;
    this.frameCount = 0;
    this.fpsAccum = 0;
    this._fps = 0;
    this._frameDt = 0;
    this._frameTimeAvg = 0;
    this._frameTimeMax = 0;
    this.dtSum = 0;
    this.dtMax = 0;
    this.rafId = requestAnimationFrame((t) => this.frame(t));
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    cancelAnimationFrame(this.rafId);
  }

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
  }

  setSystemViews(views: SystemViews | null): void {
    this._systemViews = views;
  }

  /** A hook added while its phase is running first runs on the next frame. */
  addHook(phase: HookPhase, fn: HookFn): void {
    this.hooks[phase].push({ fn, failures: 0 });
  }

  /** Removes the first registration of `fn`; safe from inside any hook. */
  removeHook(phase: HookPhase, fn: HookFn): void {
    const arr = this.hooks[phase];
    const idx = arr.findIndex((entry) => entry?.fn === fn);
    if (idx === -1) return;
    if (this.runningPhase === phase) {
      arr[idx] = null;
      this.needsCompaction[phase] = true;
    } else {
      arr.splice(idx, 1);
    }
  }

  private frame(now: number): void {
    if (!this._running) return;

    let dt: number;
    if (this.lastTime < 0) {
      dt = DEFAULT_DT;
    } else {
      dt = (now - this.lastTime) / 1000;
    }
    this.lastTime = now;

    this._frameDt = dt;
    this.dtSum += dt;
    if (dt > this.dtMax) this.dtMax = dt;

    this.frameCount++;
    this.fpsAccum += dt;
    if (this.fpsAccum >= 1.0) {
      this._fps = Math.round(this.frameCount / this.fpsAccum);
      this._frameTimeAvg = this.frameCount > 0 ? this.dtSum / this.frameCount : 0;
      this._frameTimeMax = this.dtMax;
      this.dtSum = 0;
      this.dtMax = 0;
      this.frameCount = 0;
      this.fpsAccum = 0;
    }

    if (!this._paused) {
      const vPre = this._systemViews ?? undefined;
      this.runHooks('preTick', dt, vPre);
      this.tickFn(dt);
      // Re-read: tickFn may update _systemViews with current frame data
      const vPost = this._systemViews ?? undefined;
      this.runHooks('postTick', dt, vPost);
      this.runHooks('frameEnd', dt, vPost);
    }

    this.rafId = requestAnimationFrame((t) => this.frame(t));
  }

  /**
   * Runs one phase's hooks, each in isolation. A hook that throws must not
   * skip the tick, the hooks after it, or the next requestAnimationFrame:
   * before this, one hook left on a destroyed EntityHandle stopped the engine
   * for good, with `running` still true. A throwing hook is reported when it
   * starts failing and removed after MAX_CONSECUTIVE_HOOK_FAILURES in a row.
   */
  private runHooks(phase: HookPhase, dt: number, views: SystemViews | undefined): void {
    const arr = this.hooks[phase];
    const count = arr.length; // hooks added from here on wait for the next frame
    this.runningPhase = phase;
    try {
      for (let i = 0; i < count; i++) {
        const entry = arr[i];
        if (entry === null) continue;
        try {
          entry.fn(dt, views);
          entry.failures = 0;
        } catch (err) {
          entry.failures++;
          const name = entry.fn.name ? `"${entry.fn.name}"` : '(anonymous)';
          if (entry.failures === 1) {
            console.error(`[Hyperion] ${phase} hook ${name} threw:`, err);
          }
          // `arr[i] !== entry`: it removed itself during the call.
          if (entry.failures >= MAX_CONSECUTIVE_HOOK_FAILURES && arr[i] === entry) {
            arr[i] = null;
            this.needsCompaction[phase] = true;
            console.error(
              `[Hyperion] ${phase} hook ${name} removed after ${entry.failures} consecutive failures. Last error:`,
              err,
            );
          }
        }
      }
    } finally {
      this.runningPhase = null;
      if (this.needsCompaction[phase]) {
        this.needsCompaction[phase] = false;
        let kept = 0;
        for (const entry of arr) if (entry !== null) arr[kept++] = entry;
        arr.length = kept;
      }
    }
  }
}
