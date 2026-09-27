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

export class GameLoop {
  private readonly tickFn: TickFn;
  private readonly hooks: Record<HookPhase, HookFn[]> = {
    preTick: [],
    postTick: [],
    frameEnd: [],
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
  /** Consecutive failures of each hook that threw on its last call. */
  private readonly hookFailures: Record<HookPhase, Map<HookFn, number>> = {
    preTick: new Map(),
    postTick: new Map(),
    frameEnd: new Map(),
  };

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

  addHook(phase: HookPhase, fn: HookFn): void {
    this.hooks[phase].push(fn);
  }

  removeHook(phase: HookPhase, fn: HookFn): void {
    const arr = this.hooks[phase];
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
    this.hookFailures[phase].delete(fn);
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
   * for good, with `running` still true.
   */
  private runHooks(phase: HookPhase, dt: number, views: SystemViews | undefined): void {
    const arr = this.hooks[phase];
    const failures = this.hookFailures[phase];
    for (let i = 0; i < arr.length; i++) {
      const fn = arr[i];
      let threw = false;
      let error: unknown;
      try {
        fn(dt, views);
      } catch (err) {
        threw = true;
        error = err;
      }
      // The call may have removed hooks (itself included), shifting the ones
      // after it: move `i` back onto `fn`, or before the slot it left.
      if (arr[i] !== fn) {
        const at = arr.indexOf(fn);
        i = at === -1 ? i - 1 : at;
      }
      if (!threw) {
        if (failures.size > 0) failures.delete(fn);
        continue;
      }
      const keep = this.keepFailedHook(phase, fn, error);
      if (arr[i] !== fn) {
        failures.delete(fn); // it unregistered itself: nothing left to count
      } else if (!keep) {
        arr.splice(i, 1);
        i--;
      }
    }
  }

  /**
   * Decides the fate of a hook that just threw: report it, then return `true`
   * to keep calling it on later frames, or `false` to remove it.
   */
  private keepFailedHook(phase: HookPhase, fn: HookFn, err: unknown): boolean {
    const failures = this.hookFailures[phase];
    const count = (failures.get(fn) ?? 0) + 1;
    const name = fn.name ? `"${fn.name}"` : '(anonymous)';
    if (count === 1) {
      console.error(`[Hyperion] ${phase} hook ${name} threw:`, err);
    }
    if (count < MAX_CONSECUTIVE_HOOK_FAILURES) {
      failures.set(fn, count);
      return true;
    }
    failures.delete(fn);
    console.error(
      `[Hyperion] ${phase} hook ${name} removed after ${count} consecutive failures. Last error:`,
      err,
    );
    return false;
  }
}
