// ts/src/game-loop.ts

export type HookPhase = 'preTick' | 'postTick' | 'frameEnd';
export type HookFn = (dt: number) => void;
export type TickFn = (dt: number) => void;

const DEFAULT_DT = 1 / 60;

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

  addHook(phase: HookPhase, fn: HookFn): void {
    this.hooks[phase].push(fn);
  }

  removeHook(phase: HookPhase, fn: HookFn): void {
    const arr = this.hooks[phase];
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
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
      for (const fn of this.hooks.preTick) fn(dt);
      this.tickFn(dt);
      for (const fn of this.hooks.postTick) fn(dt);
      for (const fn of this.hooks.frameEnd) fn(dt);
    }

    this.rafId = requestAnimationFrame((t) => this.frame(t));
  }
}
