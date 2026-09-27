// ts/src/game-loop.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GameLoop, MAX_CONSECUTIVE_HOOK_FAILURES } from './game-loop.js';
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

  it('a hook that removes itself during its call does not skip the hook after it', () => {
    const loop = new GameLoop(vi.fn());
    const next = vi.fn();
    const once = () => loop.removeHook('postTick', once);
    loop.addHook('postTick', once);
    loop.addHook('postTick', next);
    loop.start();

    rafCallbacks[0](16.67);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('a hook that removes an earlier hook during its call does not skip the hook after it', () => {
    const loop = new GameLoop(vi.fn());
    const first = vi.fn();
    const second = vi.fn(() => loop.removeHook('frameEnd', first));
    const third = vi.fn();
    loop.addHook('frameEnd', first);
    loop.addHook('frameEnd', second);
    loop.addHook('frameEnd', third);
    loop.start();

    rafCallbacks[0](16.67);
    expect([first, second, third].map((h) => h.mock.calls.length)).toEqual([1, 1, 1]);
  });

  describe('a hook that throws', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('does not stop the frame: the tick, the other hooks and the next frame still run', () => {
      const tickFn = vi.fn();
      const loop = new GameLoop(tickFn);
      const nextPre = vi.fn();
      const post = vi.fn();
      const end = vi.fn();
      loop.addHook('preTick', () => { throw new Error('stale handle'); });
      loop.addHook('preTick', nextPre);
      loop.addHook('postTick', post);
      loop.addHook('frameEnd', end);
      loop.start();

      rafCallbacks[0](16.67);

      expect(nextPre).toHaveBeenCalledTimes(1);
      expect(tickFn).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledTimes(1);
      expect(rafCallbacks).toHaveLength(2);
    });

    it('keeps the loop running on every later frame', () => {
      const tickFn = vi.fn();
      const loop = new GameLoop(tickFn);
      loop.addHook('frameEnd', () => { throw new Error('stale handle'); });
      loop.start();

      for (let i = 0; i < 3; i++) rafCallbacks[i](16.67 * (i + 1));

      expect(tickFn).toHaveBeenCalledTimes(3);
      expect(rafCallbacks).toHaveLength(4);
    });

    it('is reported on the console', () => {
      const loop = new GameLoop(vi.fn());
      loop.addHook('postTick', () => { throw new Error('stale handle'); });
      loop.start();

      rafCallbacks[0](16.67);

      expect(errorSpy.mock.calls.length + warnSpy.mock.calls.length).toBeGreaterThan(0);
    });

    /** Runs `n` frames of a started loop. */
    function runFrames(n: number): void {
      for (let i = 0; i < n; i++) rafCallbacks[rafCallbacks.length - 1](16.67 * rafCallbacks.length);
    }

    it(`is removed after ${MAX_CONSECUTIVE_HOOK_FAILURES} consecutive failures`, () => {
      const loop = new GameLoop(vi.fn());
      const broken = vi.fn(() => { throw new Error('stale handle'); });
      loop.addHook('preTick', broken);
      loop.start();

      runFrames(MAX_CONSECUTIVE_HOOK_FAILURES);
      expect(broken).toHaveBeenCalledTimes(MAX_CONSECUTIVE_HOOK_FAILURES);
      runFrames(5);
      expect(broken).toHaveBeenCalledTimes(MAX_CONSECUTIVE_HOOK_FAILURES);
    });

    it('a successful call resets the count', () => {
      const loop = new GameLoop(vi.fn());
      let frame = 0;
      const flaky = vi.fn(() => {
        frame++;
        if (frame !== MAX_CONSECUTIVE_HOOK_FAILURES) throw new Error('not ready');
      });
      loop.addHook('postTick', flaky);
      loop.start();

      runFrames(2 * MAX_CONSECUTIVE_HOOK_FAILURES - 1);
      expect(flaky).toHaveBeenCalledTimes(2 * MAX_CONSECUTIVE_HOOK_FAILURES - 1);
    });

    it('reports when a hook starts failing and when it is removed, not every frame', () => {
      const loop = new GameLoop(vi.fn());
      loop.addHook('frameEnd', () => { throw new Error('stale handle'); });
      loop.start();

      runFrames(MAX_CONSECUTIVE_HOOK_FAILURES);
      expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it('removing the failing hook itself does not skip the hook after it', () => {
      const loop = new GameLoop(vi.fn());
      const broken = () => { throw new Error('stale handle'); };
      const next = vi.fn();
      loop.addHook('preTick', broken);
      loop.addHook('preTick', next);
      loop.start();

      runFrames(MAX_CONSECUTIVE_HOOK_FAILURES + 1);
      expect(next).toHaveBeenCalledTimes(MAX_CONSECUTIVE_HOOK_FAILURES + 1);
    });

    it('a hook that removes itself and then throws is reported and skips no other hook', () => {
      const loop = new GameLoop(vi.fn());
      const next = vi.fn();
      const selfRemoving = () => {
        loop.removeHook('preTick', selfRemoving);
        throw new Error('stale handle');
      };
      loop.addHook('preTick', selfRemoving);
      loop.addHook('preTick', next);
      loop.start();

      runFrames(1);
      expect(next).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('a hook removed and added again starts counting from zero', () => {
      const loop = new GameLoop(vi.fn());
      const broken = vi.fn(() => { throw new Error('stale handle'); });
      loop.addHook('preTick', broken);
      loop.start();

      runFrames(MAX_CONSECUTIVE_HOOK_FAILURES - 1);
      loop.removeHook('preTick', broken);
      loop.addHook('preTick', broken);
      runFrames(MAX_CONSECUTIVE_HOOK_FAILURES - 1);
      expect(broken).toHaveBeenCalledTimes(2 * MAX_CONSECUTIVE_HOOK_FAILURES - 2);
      runFrames(1);
      runFrames(1);
      expect(broken).toHaveBeenCalledTimes(2 * MAX_CONSECUTIVE_HOOK_FAILURES - 1);
    });
  });
});
