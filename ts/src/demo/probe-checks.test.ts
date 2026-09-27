import { describe, it, expect, vi } from 'vitest';
import { pixelCheck, near, luminance, PROBE_TIMEOUT_MS } from './probe-checks';
import { createTestReporter } from './types';
import type { Hyperion } from '../hyperion';

function engineWith(probe: (req: unknown) => Promise<unknown>): Hyperion {
  return { debug: { probe } } as unknown as Hyperion;
}

describe('pixelCheck', () => {
  it('reports the verdict of the check function', async () => {
    const reporter = createTestReporter();
    const engine = engineWith(async () => ({ values: [[1, 1, 1, 1]] }));
    await pixelCheck(reporter, 'white', engine, async (probe) => {
      const [v] = await probe('scene-hdr', [[0, 0]]);
      return { ok: near(v[0], 1, 0.02), detail: `r=${v[0]}` };
    });
    expect(reporter.results()).toEqual([{ name: 'white', status: 'pass', detail: 'r=1' }]);
  });

  it('skips, with the reason, where the probe does not exist (Mode A, no renderer, production)', async () => {
    const reporter = createTestReporter();
    const engine = engineWith(() => Promise.reject(new Error('The debug probe needs the main-thread renderer of a dev build')));
    await pixelCheck(reporter, 'white', engine, async (probe) => {
      await probe('scene-hdr', [[0, 0]]);
      return { ok: true, detail: '' };
    });
    expect(reporter.results()[0].status).toBe('skip');
    expect(reporter.results()[0].detail).toMatch(/main-thread renderer/);
  });

  it('skips when engine.debug is null (production build)', async () => {
    const reporter = createTestReporter();
    await pixelCheck(reporter, 'white', { debug: null } as unknown as Hyperion, vi.fn());
    expect(reporter.results()[0].status).toBe('skip');
  });

  it('fails, with the error, when the probe rejects for another reason', async () => {
    const reporter = createTestReporter();
    const engine = engineWith(() => Promise.reject(new Error('Probe point 0 is outside the target')));
    await pixelCheck(reporter, 'white', engine, async (probe) => {
      await probe('scene-hdr', [[99, 0]]);
      return { ok: true, detail: '' };
    });
    expect(reporter.results()[0]).toMatchObject({ status: 'fail', detail: expect.stringMatching(/outside the target/) });
  });
});

describe('pixelCheck timeout', () => {
  it('fails, instead of hanging the section setup, when no frame serves the probe', async () => {
    vi.useFakeTimers();
    const reporter = createTestReporter();
    const engine = engineWith(() => new Promise(() => {}));
    const done = pixelCheck(reporter, 'white', engine, async (probe) => {
      await probe('scene-hdr', [[0, 0]]);
      return { ok: true, detail: '' };
    });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    await done;
    vi.useRealTimers();
    expect(reporter.results()[0]).toMatchObject({ status: 'fail', detail: expect.stringMatching(/no frame served/) });
  });
});

describe('near / luminance', () => {
  it('near is an absolute tolerance', () => {
    expect(near(0.067, 0.067, 0.005)).toBe(true);
    expect(near(0.08, 0.067, 0.005)).toBe(false);
  });

  it('luminance weighs rgb like the tonemappers (Rec. 709)', () => {
    expect(luminance([1, 1, 1, 1])).toBeCloseTo(1, 5);
    expect(luminance([0, 1, 0, 1])).toBeCloseTo(0.7152, 4);
  });
});

describe('pixelCheck readTransforms', () => {
  it('skips where the transform readback does not exist, like the pixel probe', async () => {
    const reporter = createTestReporter();
    const engine = {
      debug: { readEntityTransforms: () => Promise.reject(new Error('The debug probe needs the main-thread renderer of a dev build')) },
    } as unknown as Hyperion;
    await pixelCheck(reporter, 'rows', engine, async (_probe, readTransforms) => {
      await readTransforms();
      return { ok: true, detail: '' };
    });
    expect(reporter.results()[0].status).toBe('skip');
  });

  it('fails after the timeout when no frame serves the readback', async () => {
    vi.useFakeTimers();
    const reporter = createTestReporter();
    const engine = { debug: { readEntityTransforms: () => new Promise(() => {}) } } as unknown as Hyperion;
    const done = pixelCheck(reporter, 'rows', engine, async (_probe, readTransforms) => {
      await readTransforms();
      return { ok: true, detail: '' };
    });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    await done;
    vi.useRealTimers();
    expect(reporter.results()[0]).toMatchObject({ status: 'fail', detail: expect.stringMatching(/no frame served/) });
  });
});
