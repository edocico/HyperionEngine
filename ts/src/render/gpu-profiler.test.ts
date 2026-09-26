import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { GpuProfiler, WINDOW } from './gpu-profiler';

// Polyfill the WebGPU bitflag globals for Node/vitest (browser globals).
// Same pattern as texture-manager.test.ts.
beforeAll(() => {
  if (typeof globalThis.GPUBufferUsage === 'undefined') {
    (globalThis as any).GPUBufferUsage = {
      MAP_READ: 0x0001, MAP_WRITE: 0x0002,
      COPY_SRC: 0x0004, COPY_DST: 0x0008,
      INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040,
      STORAGE: 0x0080, INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
    };
  }
  if (typeof globalThis.GPUMapMode === 'undefined') {
    (globalThis as any).GPUMapMode = { READ: 0x0001, WRITE: 0x0002 };
  }
});

/**
 * Minimal fake device. WebGPU is not testable headless, so these tests cover
 * the bookkeeping the profiler does around the API — marker counting, readback
 * recycling, the rolling window, the invalid-frame guard — not the GPU itself.
 */
function makeDevice() {
  const computePasses: Array<{ label?: string; index?: number }> = [];
  const buffers: Array<{ destroyed: boolean }> = [];

  const mapped: { data: BigInt64Array<ArrayBufferLike> } = { data: new BigInt64Array(0) };

  const device = {
    computePasses,
    buffers,
    mapped,
    createQuerySet: vi.fn(() => ({ destroy: vi.fn() })),
    createBuffer: vi.fn(() => {
      const b = {
        destroyed: false,
        destroy() { this.destroyed = true; },
        mapAsync: vi.fn(async () => {}),
        getMappedRange: vi.fn(() => mapped.data.buffer),
        unmap: vi.fn(),
      };
      buffers.push(b as unknown as { destroyed: boolean });
      return b;
    }),
  };
  return device as unknown as GPUDevice & typeof device;
}

function makeEncoder(device: ReturnType<typeof makeDevice>) {
  return {
    beginComputePass: vi.fn((desc: { label?: string; timestampWrites?: { beginningOfPassWriteIndex: number } }) => {
      device.computePasses.push({
        label: desc.label,
        index: desc.timestampWrites?.beginningOfPassWriteIndex,
      });
      return { end: vi.fn() };
    }),
    resolveQuerySet: vi.fn(),
    copyBufferToBuffer: vi.fn(),
  } as unknown as GPUCommandEncoder;
}

/** Build a timestamp table where pass i costs `costsMs[i]`. */
function stamps(costsMs: number[]): BigInt64Array<ArrayBufferLike> {
  const out = new BigInt64Array(costsMs.length + 1);
  let t = 1_000_000n; // start non-zero: 0 is the "never written" sentinel
  out[0] = t;
  for (let i = 0; i < costsMs.length; i++) {
    t += BigInt(Math.round(costsMs[i] * 1e6));
    out[i + 1] = t;
  }
  return out;
}

describe('GpuProfiler', () => {
  let device: ReturnType<typeof makeDevice>;

  beforeEach(() => { device = makeDevice(); });

  describe('isSupported', () => {
    it('reports true when the feature is present', () => {
      expect(GpuProfiler.isSupported(new Set(['timestamp-query']))).toBe(true);
    });

    it('reports false when it is not', () => {
      expect(GpuProfiler.isSupported(new Set(['subgroups']))).toBe(false);
    });
  });

  describe('frame lifecycle', () => {
    it('encodes one marker per pass plus a closing marker', () => {
      const p = new GpuProfiler(device);
      const enc = makeEncoder(device);

      expect(p.beginFrame(['cull', 'forward', 'fxaa'])).toBe(true);
      p.mark(enc); p.mark(enc); p.mark(enc);
      p.endFrame(enc);

      expect(device.computePasses).toHaveLength(4);
      expect(device.computePasses.map(c => c.index)).toEqual([0, 1, 2, 3]);
    });

    it('encodes nothing when beginFrame was not called', () => {
      const p = new GpuProfiler(device);
      const enc = makeEncoder(device);
      p.mark(enc);
      p.endFrame(enc);
      expect(device.computePasses).toHaveLength(0);
    });

    it('holds 256 markers by default: ~20 graph passes plus 16 SDF sets x 3 stages fit', () => {
      const p = new GpuProfiler(device);
      expect(p.beginFrame(Array(255).fill('p'))).toBe(true);
    });

    it('refuses a graph larger than the query set', () => {
      const p = new GpuProfiler(device, 2);
      expect(p.beginFrame(['a', 'b', 'c'])).toBe(false);
    });

    it('refuses a second beginFrame while one is open', () => {
      const p = new GpuProfiler(device);
      expect(p.beginFrame(['a'])).toBe(true);
      expect(p.beginFrame(['a'])).toBe(false);
    });

    it('skips frames when every readback buffer is in flight', () => {
      const p = new GpuProfiler(device);
      // Three slots: consume all of them without ever polling.
      for (let i = 0; i < 3; i++) {
        expect(p.beginFrame(['a'])).toBe(true);
        const enc = makeEncoder(device);
        p.mark(enc);
        p.endFrame(enc);
      }
      expect(p.beginFrame(['a'])).toBe(false);
      expect(p.skippedFrames).toBe(1);
    });
  });

  describe('timing math', () => {
    async function runFrame(p: GpuProfiler, names: string[], costsMs: number[]) {
      device.mapped.data = stamps(costsMs);
      p.beginFrame(names);
      const enc = makeEncoder(device);
      for (const _ of names) p.mark(enc);
      p.endFrame(enc);
      await p.poll();
    }

    it('turns timestamp deltas into per-pass milliseconds', async () => {
      const p = new GpuProfiler(device);
      await runFrame(p, ['cull', 'forward'], [0.25, 1.5]);

      const t = p.getTimingsByName();
      expect(t.get('cull')?.lastMs).toBeCloseTo(0.25, 5);
      expect(t.get('forward')?.lastMs).toBeCloseTo(1.5, 5);
    });

    it('sums the intervals that share a name within one frame (the stages of a staged pass)', async () => {
      const p = new GpuProfiler(device);
      await runFrame(p, ['x/a', 'x/b', 'x/a'], [1, 2, 3]);
      const t = p.getTimingsByName();
      expect(t.get('x/a')?.lastMs).toBeCloseTo(4, 5);
      expect(t.get('x/a')?.sampleCount).toBe(1);
      expect(t.get('x/b')?.lastMs).toBeCloseTo(2, 5);
    });

    // A staged pass changes its stage list from frame to frame with no graph
    // change (no reset): LightGroupsPass drops seed/sdf when the SDF sets go to
    // zero. Review 2026-09-26: the vanished stages kept their frozen average and
    // still counted in totalAverageMs.
    it('a stage missing from a frame took 0 ms in it: its mean decays and lastMs is 0', async () => {
      const p = new GpuProfiler(device);
      await runFrame(p, ['lg/seed', 'lg/accum'], [2, 1]);
      await runFrame(p, ['lg/accum'], [1]);
      const seed = p.getTimingsByName().get('lg/seed')!;
      expect(seed.lastMs).toBe(0);
      expect(seed.sampleCount).toBe(2);
      expect(seed.averageMs).toBeCloseTo(1, 5);
      expect(p.totalAverageMs()).toBeCloseTo(2, 5);
    });

    it('forgets a stage once it has been missing for a whole window', async () => {
      const p = new GpuProfiler(device);
      await runFrame(p, ['lg/seed', 'lg/accum'], [2, 1]);
      for (let i = 0; i < WINDOW; i++) await runFrame(p, ['lg/accum'], [1]);
      expect(p.getTimingsByName().has('lg/seed')).toBe(false);
      expect(p.totalAverageMs()).toBeCloseTo(1, 5);
    });

    it('never forgets a stage that is still measured, even at 0 ms', async () => {
      const p = new GpuProfiler(device);
      for (let i = 0; i < WINDOW + 5; i++) await runFrame(p, ['lg/seed'], [0]);
      expect(p.getTimingsByName().has('lg/seed')).toBe(true);
    });

    it('averages across frames, which is what defeats the 100us quantization', async () => {
      const p = new GpuProfiler(device);
      // Chrome would report a 60us pass as 0 or 100us on alternate frames.
      await runFrame(p, ['jfa'], [0.0]);
      await runFrame(p, ['jfa'], [0.1]);

      const jfa = p.getTimingsByName().get('jfa')!;
      expect(jfa.sampleCount).toBe(2);
      expect(jfa.averageMs).toBeCloseTo(0.05, 5);
    });

    it('caps history at WINDOW samples', async () => {
      const p = new GpuProfiler(device);
      for (let i = 0; i < WINDOW + 25; i++) {
        await runFrame(p, ['forward'], [1.0]);
      }
      expect(p.getTimingsByName().get('forward')!.sampleCount).toBe(WINDOW);
    });

    it('discards a frame containing an unwritten (zero) timestamp', async () => {
      const p = new GpuProfiler(device);
      device.mapped.data = new BigInt64Array([0n, 0n]);
      p.beginFrame(['cull']);
      const enc = makeEncoder(device);
      p.mark(enc);
      p.endFrame(enc);
      await p.poll();
      expect(p.timings()).toEqual([]);
      // Counted, so a browser that serves only zeroes is diagnosable rather
      // than looking like a profiler that never finishes warming up.
      expect(p.discardedFrames).toBe(1);
    });

    it('counts zeroed frames separately from skipped ones', async () => {
      const p = new GpuProfiler(device);
      device.mapped.data = new BigInt64Array([0n, 0n]);
      for (let i = 0; i < 3; i++) {
        p.beginFrame(['cull']);
        const enc = makeEncoder(device);
        p.mark(enc);
        p.endFrame(enc);
        await p.poll();
      }
      expect(p.discardedFrames).toBe(3);
      expect(p.skippedFrames).toBe(0);
      expect(p.timings()).toEqual([]);
    });

    it('keeps the zero-frame count across reset, since it describes the browser', async () => {
      const p = new GpuProfiler(device);
      device.mapped.data = new BigInt64Array([0n, 0n]);
      p.beginFrame(['cull']);
      const enc = makeEncoder(device);
      p.mark(enc);
      p.endFrame(enc);
      await p.poll();

      p.reset();
      expect(p.discardedFrames).toBe(1);
    });

    it('clamps a non-monotonic delta to zero instead of reporting a negative', async () => {
      const p = new GpuProfiler(device);
      device.mapped.data = new BigInt64Array([5_000_000n, 1_000_000n]);
      p.beginFrame(['weird']);
      const enc = makeEncoder(device);
      p.mark(enc);
      p.endFrame(enc);
      await p.poll();
      expect(p.getTimingsByName().get('weird')!.lastMs).toBe(0);
    });

    it('sums pass averages into an approximate frame cost', async () => {
      const p = new GpuProfiler(device);
      await runFrame(p, ['cull', 'forward'], [0.5, 2.0]);
      expect(p.totalAverageMs()).toBeCloseTo(2.5, 5);
    });

    it('reset() drops accumulated history', async () => {
      const p = new GpuProfiler(device);
      await runFrame(p, ['cull'], [1.0]);
      expect(p.timings()).toHaveLength(1);
      p.reset();
      expect(p.timings()).toEqual([]);
    });

    it('recycles readback buffers so long runs never starve', async () => {
      const p = new GpuProfiler(device);
      for (let i = 0; i < 20; i++) {
        await runFrame(p, ['forward'], [1.0]);
      }
      expect(p.skippedFrames).toBe(0);
    });
  });

  describe('aborting a frame', () => {
    it('reopens a frame left dangling by a throwing pass', () => {
      const p = new GpuProfiler(device);
      expect(p.beginFrame(['a'])).toBe(true);
      expect(p.beginFrame(['a'])).toBe(false);  // still open, correctly refused
      p.abortFrame();
      expect(p.beginFrame(['a'])).toBe(true);
    });

    it('consumes no readback slot, so repeated failures cannot starve the pool', () => {
      const p = new GpuProfiler(device);
      // Five aborted frames against three slots: without the fix this would
      // have exhausted the pool after the third.
      for (let i = 0; i < 5; i++) {
        expect(p.beginFrame(['a'])).toBe(true);
        p.mark(makeEncoder(device));
        p.abortFrame();
      }
      expect(p.skippedFrames).toBe(0);
    });
  });

  describe('reset with frames still in flight', () => {
    /** Open and close a frame without polling: it stays queued for readback. */
    function encodeUnpolledFrame(p: GpuProfiler, names: string[], costsMs: number[]) {
      device.mapped.data = stamps(costsMs);
      p.beginFrame(names);
      const enc = makeEncoder(device);
      for (const _ of names) p.mark(enc);
      p.endFrame(enc);
    }

    it('discards samples measured before the reset', async () => {
      const p = new GpuProfiler(device);
      encodeUnpolledFrame(p, ['jfa-iter-0'], [1.0]);

      // Simulates rebuildGraph(): the pass set changed under us.
      p.reset();
      await p.poll();

      // The stale frame must not resurrect a pass the new graph does not have.
      expect(p.timings()).toEqual([]);
    });

    it('keeps measuring frames opened after the reset', async () => {
      const p = new GpuProfiler(device);
      encodeUnpolledFrame(p, ['old-pass'], [1.0]);
      p.reset();

      encodeUnpolledFrame(p, ['new-pass'], [2.0]);
      await p.poll();

      const t = p.getTimingsByName();
      expect(t.has('old-pass')).toBe(false);
      expect(t.get('new-pass')?.lastMs).toBeCloseTo(2.0, 5);
    });

    it('returns the invalidated frames to the pool instead of starving it', () => {
      const p = new GpuProfiler(device);
      for (let i = 0; i < 3; i++) encodeUnpolledFrame(p, ['a'], [1.0]);
      expect(p.beginFrame(['a'])).toBe(false);  // all three slots checked out

      p.reset();

      // Dropping the entries without recycling their buffers would leave the
      // profiler permanently unable to open a frame.
      expect(p.beginFrame(['a'])).toBe(true);
    });
  });

  describe('destroy', () => {
    it('releases every buffer and stops measuring', () => {
      const p = new GpuProfiler(device);
      p.destroy();
      expect(device.buffers.every(b => b.destroyed)).toBe(true);
      expect(p.beginFrame(['a'])).toBe(false);
    });

    it('is idempotent', () => {
      const p = new GpuProfiler(device);
      p.destroy();
      expect(() => p.destroy()).not.toThrow();
    });
  });
});
