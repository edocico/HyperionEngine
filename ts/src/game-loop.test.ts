// ts/src/game-loop.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameLoop } from './game-loop.js';
import type { SystemViews } from './system-views.js';

describe('GameLoop', () => {
  let rafCallbacks: ((time: number) => void)[];
  let originalRAF: typeof globalThis.requestAnimationFrame;
  let originalCAF: typeof globalThis.cancelAnimationFrame;

  beforeEach(() => {
    rafCallbacks = [];
    originalRAF = globalThis.requestAnimationFrame;
    originalCAF = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = vi.fn((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    }) as unknown as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
  });

  it('starts and runs tick callback', () => {
    const tickFn = vi.fn();
    const loop = new GameLoop(tickFn);
    loop.start();
    expect(loop.running).toBe(true);
    // Simulate one frame
    rafCallbacks[0](16.67);
    expect(tickFn).toHaveBeenCalled();
  });

  it('stop cancels the loop', () => {
    const loop = new GameLoop(vi.fn());
    loop.start();
    loop.stop();
    expect(loop.running).toBe(false);
  });

  it('pause/resume', () => {
    const tickFn = vi.fn();
    const loop = new GameLoop(tickFn);
    loop.start();
    loop.pause();
    expect(loop.paused).toBe(true);
    // Simulate frame while paused — tick should not be called
    rafCallbacks[0](16.67);
    expect(tickFn).not.toHaveBeenCalled();
    // But RAF should still be requested (to keep checking)
    loop.resume();
    expect(loop.paused).toBe(false);
  });

  it('calls preTick/postTick/frameEnd hooks in order', () => {
    const order: string[] = [];
    const tickFn = vi.fn(() => order.push('tick'));
    const loop = new GameLoop(tickFn);
    loop.addHook('preTick', () => order.push('pre'));
    loop.addHook('postTick', () => order.push('post'));
    loop.addHook('frameEnd', () => order.push('end'));
    loop.start();
    rafCallbacks[0](16.67);
    expect(order).toEqual(['pre', 'tick', 'post', 'end']);
  });

  it('removeHook removes a hook', () => {
    const called: string[] = [];
    const hook = () => called.push('pre');
    const loop = new GameLoop(vi.fn());
    loop.addHook('preTick', hook);
    loop.removeHook('preTick', hook);
    loop.start();
    rafCallbacks[0](16.67);
    expect(called).toEqual([]);
  });

  it('tracks fps', () => {
    const loop = new GameLoop(vi.fn());
    loop.start();
    // Simulate 60 frames at ~16.67ms
    let t = 0;
    for (let i = 0; i < 61; i++) {
      t += 16.67;
      if (rafCallbacks.length > 0) {
        const cb = rafCallbacks.shift()!;
        cb(t);
      }
    }
    expect(loop.fps).toBeGreaterThan(0);
  });

  describe('frame time tracking', () => {
    it('frameDt starts at 0', () => {
      const loop = new GameLoop(vi.fn());
      expect(loop.frameDt).toBe(0);
    });

    it('frameTimeAvg and frameTimeMax start at 0', () => {
      const loop = new GameLoop(vi.fn());
      expect(loop.frameTimeAvg).toBe(0);
      expect(loop.frameTimeMax).toBe(0);
    });
  });

  describe('SystemViews passing', () => {
    const makeViews = (): SystemViews => ({
      entityCount: 1,
      transforms: new Float32Array(16),
      bounds: new Float32Array(4),
      texIndices: new Uint32Array(1),
      renderMeta: new Uint32Array(2),
      primParams: new Float32Array(8),
      entityIds: new Uint32Array(1),
    });

    it('passes SystemViews as second argument to all hook phases', () => {
      const views = makeViews();
      const receivedPre: (SystemViews | undefined)[] = [];
      const receivedPost: (SystemViews | undefined)[] = [];
      const receivedEnd: (SystemViews | undefined)[] = [];

      const loop = new GameLoop(vi.fn());
      loop.addHook('preTick', (_dt, v) => receivedPre.push(v));
      loop.addHook('postTick', (_dt, v) => receivedPost.push(v));
      loop.addHook('frameEnd', (_dt, v) => receivedEnd.push(v));
      loop.setSystemViews(views);
      loop.start();
      rafCallbacks[0](16.67);

      expect(receivedPre[0]).toBe(views);
      expect(receivedPost[0]).toBe(views);
      expect(receivedEnd[0]).toBe(views);
    });

    it('passes undefined when no SystemViews are set', () => {
      let received: SystemViews | undefined = {} as SystemViews;
      const loop = new GameLoop(vi.fn());
      loop.addHook('preTick', (_dt, v) => { received = v; });
      loop.start();
      rafCallbacks[0](16.67);

      expect(received).toBeUndefined();
    });

    it('reflects updated SystemViews on subsequent frames', () => {
      const views1 = makeViews();
      const views2 = makeViews();
      views2.transforms[0] = 42;

      const received: (SystemViews | undefined)[] = [];
      const loop = new GameLoop(vi.fn());
      loop.addHook('postTick', (_dt, v) => received.push(v));
      loop.setSystemViews(views1);
      loop.start();

      // First frame
      rafCallbacks.shift()!(16.67);
      // Update views
      loop.setSystemViews(views2);
      // Second frame
      rafCallbacks.shift()!(33.34);

      expect(received[0]).toBe(views1);
      expect(received[1]).toBe(views2);
    });

    it('passes undefined after clearing SystemViews with null', () => {
      const views = makeViews();
      const received: (SystemViews | undefined)[] = [];
      const loop = new GameLoop(vi.fn());
      loop.addHook('preTick', (_dt, v) => received.push(v));
      loop.setSystemViews(views);
      loop.start();

      rafCallbacks.shift()!(16.67);
      loop.setSystemViews(null);
      rafCallbacks.shift()!(33.34);

      expect(received[0]).toBe(views);
      expect(received[1]).toBeUndefined();
    });
  });
});
