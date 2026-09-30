import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, type MockInstance } from 'vitest';
import { GpuProfiler, nextSeal } from './gpu-profiler';
import { installGpuGlobals, makeGpu, stampsOf, type FakeBuffer, type Gpu } from './gpu-profiler.fixture';

beforeAll(installGpuGlobals);

/**
 * One measured frame: a compute pass with work per node, then submitted (or rejected) and, by default, polled.
 * A node listed in `idle` opens and ends its pass without dispatching: a pass without work.
 */
async function measure(
  p: GpuProfiler, gpu: Gpu, nodes: string[], stamps: bigint[] | undefined,
  opts: { reject?: boolean; poll?: boolean; profiled?: boolean; idle?: string[] } = {},
): Promise<boolean> {
  if (!p.beginFrame()) return false;
  const enc = gpu.encoder();
  p.instrument(enc);
  for (const node of nodes) {
    p.enterNode(node, opts.profiled ?? true);
    const pass = enc.beginComputePass({ label: node });
    if (!opts.idle?.includes(node)) pass.dispatchWorkgroups(1);
    pass.end();
  }
  p.endFrame(enc);
  gpu.submit(enc, { stamps, reject: opts.reject });
  if (opts.poll !== false) await p.poll();
  return true;
}

describe('GpuProfiler', () => {
  let gpu: Gpu;
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    gpu = makeGpu();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  describe('isSupported', () => {
    it('reports whether the feature is present', () => {
      expect(GpuProfiler.isSupported(new Set(['timestamp-query']))).toBe(true);
      expect(GpuProfiler.isSupported(new Set(['subgroups']))).toBe(false);
    });
  });

  describe('resources', () => {
    it('512 pairs by default: 1024 queries, three readbacks of 8 KB plus 8 bytes, a 4-byte seal', () => {
      new GpuProfiler(gpu.device);
      expect(gpu.createQuerySet).toHaveBeenCalledWith(expect.objectContaining({ type: 'timestamp', count: 1024 }));
      const readbacks = gpu.buffers.filter((b) => b.label?.startsWith('gpu-profiler-readback'));
      expect(readbacks).toHaveLength(3);
      for (const b of readbacks) {
        expect(b.size).toBe(1024 * 8 + 8);
        expect(b.usage).toBe(GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      }
      const seal = gpu.buffers.find((b) => b.label === 'gpu-profiler-seal')!;
      expect(seal.size).toBe(4);
      expect(seal.usage).toBe(GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
      const resolve = gpu.buffers.find((b) => b.label === 'gpu-profiler-resolve')!;
      expect(resolve.size).toBe(1024 * 8);
      expect(resolve.usage).toBe(GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
    });

    it.each([0, -1, 2049, 512.5, NaN, Infinity])(
      'maxPairs %s is refused with a RangeError, before any GPU object exists',
      (maxPairs) => {
        expect(() => new GpuProfiler(gpu.device, maxPairs)).toThrow(RangeError);
        expect(gpu.createQuerySet).not.toHaveBeenCalled();
        expect(gpu.buffers).toEqual([]);
      },
    );

    it('maxPairs 2048 fills the 4096 queries WebGPU allows a query set, and 1 is the smallest', () => {
      new GpuProfiler(gpu.device, 2048);
      expect(gpu.createQuerySet).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'timestamp', count: 4096 }));
      new GpuProfiler(gpu.device, 1);
      expect(gpu.createQuerySet).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'timestamp', count: 2 }));
    });
  });

  describe('frame lifecycle', () => {
    it('refuses a second beginFrame while one is open, and abortFrame reopens it without using a slot', () => {
      const p = new GpuProfiler(gpu.device);
      expect(p.beginFrame()).toBe(true);
      expect(p.beginFrame()).toBe(false);
      p.abortFrame();
      for (let i = 0; i < 5; i++) {
        expect(p.beginFrame()).toBe(true);
        p.abortFrame();
      }
      expect(p.skippedFrames).toBe(0);
    });

    it('skips frames when every readback buffer is in flight', async () => {
      const p = new GpuProfiler(gpu.device);
      for (let i = 0; i < 3; i++) await measure(p, gpu, ['a'], stampsOf(i, 1), { poll: false });
      expect(p.beginFrame()).toBe(false);
      expect(p.skippedFrames).toBe(1);
    });

    it("a frame queued while a readback's mapAsync is pending never reuses it", async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['a'], stampsOf(0, 1), { poll: false });
      // Takes frame 0 and leaves its mapAsync pending: the fake marks the buffer mapped at call time,
      // and a write, resolve or copy into it would throw.
      const inflight = p.poll();
      await measure(p, gpu, ['a'], stampsOf(1, 1), { poll: false });
      await measure(p, gpu, ['a'], stampsOf(2, 1), { poll: false });
      await inflight;
      await p.poll();
      expect(p.getTimingsByName().get('a')?.sampleCount).toBe(3);
    });

    it('reports the passes of a measured frame and its span', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['cull', 'forward'], stampsOf(0, 0.25, 1.5));
      const t = p.getTimingsByName();
      expect(t.get('cull')?.lastMs).toBeCloseTo(0.25, 6);
      expect(t.get('forward')?.lastMs).toBeCloseTo(1.5, 6);
      // Two passes 10 ms apart: the span runs from the first begin to the last end.
      expect(p.frameTiming()?.lastMs).toBeCloseTo(11.5, 6);
    });

    it('a frame whose nodes all opted out is discarded as empty', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['overlay'], [], { profiled: false });
      expect(p.timings()).toEqual([]);
      expect(p.discardReasons.empty).toBe(1);
    });
  });

  describe('the seal', () => {
    it('a rejected frame is discarded as unexecuted, and never replays the older frame its readback still holds', async () => {
      const p = new GpuProfiler(gpu.device);
      for (let i = 0; i < 3; i++) await measure(p, gpu, ['forward'], stampsOf(i, 1));
      expect(p.getTimingsByName().get('forward')?.sampleCount).toBe(3);
      for (let i = 0; i < 6; i++) await measure(p, gpu, ['forward'], undefined, { reject: true });
      expect(p.getTimingsByName().get('forward')?.sampleCount).toBe(3);
      expect(p.discardReasons.unexecuted).toBe(6);
    });

    it('writes 0 at the readback tail through the queue, and copies the seal in the command buffer', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['a'], stampsOf(0, 1), { poll: false });
      const tailWrite = (gpu.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.find(([buffer]) =>
        (buffer as FakeBuffer).label?.startsWith('gpu-profiler-readback'));
      expect(tailWrite?.[1]).toBe(2 * 8);
      expect(Array.from(tailWrite?.[2] as Uint32Array)).toEqual([0]);
      // The frame is accepted, and its readback holds the first seal at the tail: the queue wrote 0
      // there, so only the copy encoded in the command buffer can have put 1 in its place.
      await p.poll();
      expect(p.getTimingsByName().get('a')?.sampleCount).toBe(1);
      expect(new Uint32Array((tailWrite![0] as FakeBuffer).bytes.buffer, 16, 1)[0]).toBe(1);
    });

    it('two readbacks holding different frames, read with every submit rejected: nothing accepted, nothing in the history', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['a'], stampsOf(0, 1), { poll: false });   // readback X: frame 0
      await measure(p, gpu, ['a'], stampsOf(1, 1), { poll: false });   // readback Y: frame 1
      await p.poll();
      // Two rejected frames reuse Y then X, which still hold frames 1 and 0.
      await measure(p, gpu, ['a'], undefined, { reject: true, poll: false });
      await measure(p, gpu, ['a'], undefined, { reject: true, poll: false });
      await p.poll();
      expect(p.discardReasons.unexecuted).toBe(2);
      // The query set still holds frame 1, the last that ran: a pass that did not refresh it is stale.
      await measure(p, gpu, ['a'], undefined);
      expect(p.discardReasons.stale).toBe(1);
      expect(p.getTimingsByName().get('a')?.sampleCount).toBe(2);
    });

    it('nextSeal counts 1..0xFFFFFFFF and never returns 0', () => {
      expect(nextSeal(0)).toBe(1);
      expect(nextSeal(41)).toBe(42);
      expect(nextSeal(0xfffffffe)).toBe(0xffffffff);
      expect(nextSeal(0xffffffff)).toBe(1);
    });
  });

  describe('the per-index history', () => {
    it('an executed frame whose pass did not refresh its stamps is stale', async () => {
      const p = new GpuProfiler(gpu.device);
      const s = stampsOf(0, 1);
      await measure(p, gpu, ['overlay'], s);
      await measure(p, gpu, ['overlay'], undefined);          // ran, but the query set still holds s
      expect(p.discardReasons.stale).toBe(1);
      await measure(p, gpu, ['overlay'], undefined, { reject: true });
      await measure(p, gpu, ['overlay'], stampsOf(1, 1));
      expect(p.getTimingsByName().get('overlay')?.sampleCount).toBe(2);
    });

    it('a pass without work whose stamps equal the recorded history does not discard the frame (the Metal case)', async () => {
      const p = new GpuProfiler(gpu.device);
      const s0 = stampsOf(0, 1, 2);
      const s1 = stampsOf(1, 1, 2);
      await measure(p, gpu, ['forward', 'idle'], s0, { idle: ['idle'] });
      // 'idle' opened a pass and dispatched nothing: the query set keeps its indices' previous stamps.
      await measure(p, gpu, ['forward', 'idle'], [s1[0], s1[1], s0[2], s0[3]], { idle: ['idle'] });
      expect(Object.values(p.discardReasons).every((n) => n === 0), JSON.stringify(p.discardReasons)).toBe(true);
      const t = p.getTimingsByName();
      expect(t.get('forward')?.sampleCount).toBe(2);
      expect(t.get('idle')?.lastMs).toBe(0);
      expect(t.get('idle')?.averageMs).toBe(0);
    });

    it('reset with frames in flight: their samples are dropped, their buffers recycled, and the history forgotten', async () => {
      const p = new GpuProfiler(gpu.device);
      const s = stampsOf(0, 1);
      await measure(p, gpu, ['old-pass'], s);
      for (let i = 0; i < 3; i++) await measure(p, gpu, ['old-pass'], stampsOf(1 + i, 1), { poll: false });
      expect(p.beginFrame()).toBe(false);
      p.reset();
      expect(p.timings()).toEqual([]);
      // The history is unknown, so a new frame repeating stamps read before is not stale.
      await measure(p, gpu, ['new-pass'], s);
      expect(p.getTimingsByName().has('old-pass')).toBe(false);
      expect(p.getTimingsByName().get('new-pass')?.sampleCount).toBe(1);
    });

    it('a discarded frame still updates the history', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['a', 'b'], stampsOf(0, 1, 1));
      const s = stampsOf(1, 1, 1);
      const reversed = [s[0], s[1], s[3], s[2]];                 // 'b' ends before it begins
      await measure(p, gpu, ['a', 'b'], reversed);
      expect(p.discardReasons.reversed).toBe(1);
      const next = stampsOf(2, 1, 1);
      await measure(p, gpu, ['a', 'b'], [reversed[0], reversed[1], next[2], next[3]]);   // 'a' keeps frame 1's stamps
      expect(p.discardReasons.stale).toBe(1);
    });

    it('a frame of an old generation still updates the history', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['a'], stampsOf(0, 1), { poll: false });
      const reading = p.poll();       // takes the frame now
      p.reset();                      // which from here on belongs to an old generation
      await reading;
      expect(p.timings()).toEqual([]);
      await measure(p, gpu, ['a'], undefined);   // the query set still holds that frame's stamps
      expect(p.discardReasons.stale).toBe(1);
    });

    it('a lost readback (device loss) throws nothing, logs nothing, frees its buffer and forgets its indices', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const p = new GpuProfiler(gpu.device);
        const s = stampsOf(0, 1);
        await measure(p, gpu, ['a'], s);
        for (const b of gpu.buffers) b.failMap = true;
        // Three lost frames in a row: the pool is LIFO with three slots, so a buffer
        // that failed to come back shows only when all three have been lost.
        for (let i = 1; i <= 3; i++) await expect(measure(p, gpu, ['a'], stampsOf(i, 1))).resolves.toBe(true);
        for (const b of gpu.buffers) b.failMap = false;
        // Were the history kept, a frame repeating s would be stale.
        await expect(measure(p, gpu, ['a'], s)).resolves.toBe(true);
        expect(p.getTimingsByName().get('a')?.sampleCount).toBe(2);
        expect(p.skippedFrames).toBe(0);
        // A lost device is expected, not a bug: only a failure AFTER the map is reported (see diagnostics).
        expect(error).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    });
  });

  describe('diagnostics', () => {
    it('warns once, after 120 discarded frames in a row, naming the reason', async () => {
      const p = new GpuProfiler(gpu.device);
      for (let i = 0; i < 119; i++) await measure(p, gpu, ['a'], undefined, { reject: true });
      expect(warn).not.toHaveBeenCalled();
      await measure(p, gpu, ['a'], undefined, { reject: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/did not run/);
      for (let i = 0; i < 10; i++) await measure(p, gpu, ['a'], undefined, { reject: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(p.discardedFrames).toBe(130);
    });

    it('the warning names the pass behind the most frequent reason', async () => {
      const p = new GpuProfiler(gpu.device);
      const first = stampsOf(0, 1, 1);
      await measure(p, gpu, ['forward', 'overlay'], first);
      for (let i = 1; i <= 120; i++) {
        const s = stampsOf(i, 1, 1);
        await measure(p, gpu, ['forward', 'overlay'], [s[0], s[1], first[2], first[3]]);   // overlay keeps frame 0's stamps
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/pass 'overlay' did work but its timestamps were not refreshed/);
    });

    it('the zero-timestamp warning names the pass that did work but read back zero, after 120 discarded frames in a row', async () => {
      const p = new GpuProfiler(gpu.device);
      // A pass with work whose stamps the GPU never wrote: on a fresh query set they read 0.
      for (let i = 0; i < 120; i++) await measure(p, gpu, ['bundle-only'], undefined);
      expect(p.discardReasons.zero).toBe(120);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(
        "pass 'bundle-only' did work but read back a zero timestamp (this browser does not serve timestamps, " +
        "or the pass's only work was not sampled, like an empty render bundle)",
      );
    });

    it('a valid frame breaks the streak', async () => {
      const p = new GpuProfiler(gpu.device);
      for (let i = 0; i < 100; i++) await measure(p, gpu, ['a'], undefined, { reject: true });
      await measure(p, gpu, ['a'], stampsOf(0, 1));
      for (let i = 0; i < 100; i++) await measure(p, gpu, ['a'], undefined, { reject: true });
      expect(warn).not.toHaveBeenCalled();
    });

    it('a truncated frame is discarded and warns once: how many passes, which node ran out of pairs, profile: false', async () => {
      const p = new GpuProfiler(gpu.device, 2);
      // 'c' opens the first pass without a pair; 'd' is refused too, but 'c' is the one named.
      await measure(p, gpu, ['a', 'b', 'c', 'd'], stampsOf(0, 1, 1));
      await measure(p, gpu, ['a', 'b', 'c', 'd'], stampsOf(1, 1, 1));
      expect(p.truncatedFrames).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toBe(
        '[Hyperion] GPU profiling: a frame opened more than 2 passes, so its timings were dropped; ' +
        "the first untimed pass belonged to 'c'. Give the nodes that open many passes `profile: false`.",
      );
      // The class is not exported and the renderer builds it with the default: nobody could follow that advice.
      expect(message).not.toMatch(/maxPairs/);
    });

    it('the streak warning for truncated frames names the first untimed pass too', async () => {
      const p = new GpuProfiler(gpu.device, 2);
      for (let i = 0; i < 120; i++) await measure(p, gpu, ['a', 'b', 'c'], stampsOf(i, 1, 1));
      // The one-time truncation warning came with the first frame; the streak warning with the 120th.
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1][0])).toBe(
        '[Hyperion] GPU profiling is enabled but the last 120 frames were discarded: ' +
        "frames opened more passes than the profiler has query pairs for (the first untimed: pass 'c'). " +
        'No timings will be reported until that changes.',
      );
    });

    it('discard counts survive reset: they describe the browser', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['a'], undefined, { reject: true });
      p.reset();
      expect(p.discardedFrames).toBe(1);
    });

    it('a failure while reading a mapped frame is reported once, and the buffer comes back: the profiler keeps working', async () => {
      // Not a lost device (that is a failing map, above): a bug in the reading itself, which would
      // otherwise stop all reporting with no discard counted and no warning.
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const p = new GpuProfiler(gpu.device);
        await measure(p, gpu, ['forward'], stampsOf(0, 1));
        expect(p.getTimingsByName().get('forward')?.sampleCount).toBe(1);
        for (const b of gpu.buffers) b.failRange = true;
        // Three failed reads in a row: the pool is LIFO with three slots, so a buffer
        // that failed to come back shows only when all three have failed.
        for (let i = 1; i <= 3; i++) await measure(p, gpu, ['forward'], stampsOf(i, 1));
        expect(error).toHaveBeenCalledTimes(1);
        expect(String(error.mock.calls[0][0])).toContain('GPU profiler');
        for (const b of gpu.buffers) b.failRange = false;
        await expect(measure(p, gpu, ['forward'], stampsOf(4, 1))).resolves.toBe(true);
        await measure(p, gpu, ['forward'], stampsOf(5, 1));
        expect(p.getTimingsByName().get('forward')?.sampleCount).toBe(3);
        for (const b of gpu.buffers) b.failRange = true;
        await measure(p, gpu, ['forward'], stampsOf(6, 1));
        expect(error).toHaveBeenCalledTimes(1);
      } finally {
        error.mockRestore();
      }
    });
  });

  describe('destroy', () => {
    it('releases every buffer and stops measuring, and is idempotent', () => {
      const p = new GpuProfiler(gpu.device);
      p.destroy();
      expect(gpu.buffers.every((b) => b.destroyed)).toBe(true);
      const querySet = gpu.createQuerySet.mock.results[0].value;
      expect(querySet.destroy).toHaveBeenCalledTimes(1);
      expect(p.beginFrame()).toBe(false);
      expect(() => p.destroy()).not.toThrow();
      expect(querySet.destroy).toHaveBeenCalledTimes(1);
    });

    it('a destroy() between a resolved map and the read is a quiet end: no error is logged for the lost frame', async () => {
      // getMappedRange throws on a destroyed buffer, in WebGPU and in the fake. The one-time "reading a
      // resolved frame failed" error is for a bug in the reading, not for tearing the renderer down.
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const p = new GpuProfiler(gpu.device);
        await measure(p, gpu, ['a'], stampsOf(0, 1), { poll: false });
        // The map resolves, and the profiler is destroyed before poll() continues from its await.
        for (const b of gpu.buffers) b.onMap = () => p.destroy();
        await p.poll();
        expect(error).not.toHaveBeenCalled();
        expect(p.timings()).toEqual([]);
        expect(p.beginFrame()).toBe(false);
      } finally {
        error.mockRestore();
      }
    });
  });
});
