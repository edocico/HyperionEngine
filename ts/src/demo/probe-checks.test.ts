import { describe, it, expect, vi } from 'vitest';
import { pixelCheck, near, luminance, PROBE_TIMEOUT_MS, reportTextureLoadFailure } from './probe-checks';
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

describe('pixelCheck without a main-thread renderer', () => {
  // Mode A: the check function reaches for the renderer itself, before any
  // probe (the Bloom check turns the bloom graph on first), and the engine
  // says there is none. Same environment limit as an unavailable probe.
  it.each([
    'Cannot enable bloom: no renderer available',
    'Cannot enable outlines: no renderer available',
  ])('skips, with the reason, when the check calls an engine API that needs the renderer: %s', async (message) => {
    const reporter = createTestReporter();
    const probe = vi.fn();
    await pixelCheck(reporter, 'fx', engineWith(probe), async () => {
      throw new Error(message);
    });
    expect(reporter.results()).toEqual([{ name: 'fx', status: 'skip', detail: `no renderer: ${message}` }]);
    expect(probe).not.toHaveBeenCalled();
  });

  it('still fails on any other throw of the check function', async () => {
    const reporter = createTestReporter();
    await pixelCheck(reporter, 'fx', engineWith(vi.fn()), async () => {
      throw new Error('Cannot read properties of undefined');
    });
    expect(reporter.results()).toEqual([
      { name: 'fx', status: 'fail', detail: 'probe error: Cannot read properties of undefined' },
    ]);
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

describe('pixelCheck readSort', () => {
  const sortEngine = (readTransparentSort: () => Promise<unknown>): Hyperion =>
    ({ debug: { readTransparentSort } }) as unknown as Hyperion;

  it('skips where the sort readback does not exist, like the pixel probe', async () => {
    const reporter = createTestReporter();
    const engine = sortEngine(() => Promise.reject(new Error('The debug probe needs the main-thread renderer of a dev build')));
    await pixelCheck(reporter, 'sort', engine, async (_probe, _rows, readSort) => {
      await readSort();
      return { ok: true, detail: '' };
    });
    expect(reporter.results()[0].status).toBe('skip');
  });

  it('skips when the renderer went away with the request (the sort probe was destroyed)', async () => {
    const reporter = createTestReporter();
    const engine = sortEngine(() => Promise.reject(new Error('TransparentSortProbe destroyed before the request was served')));
    await pixelCheck(reporter, 'sort', engine, async (_probe, _rows, readSort) => {
      await readSort();
      return { ok: true, detail: '' };
    });
    expect(reporter.results()[0]).toMatchObject({ status: 'skip', detail: expect.stringMatching(/TransparentSortProbe destroyed/) });
  });

  it('fails, with the reason, on any other rejection', async () => {
    const reporter = createTestReporter();
    const engine = sortEngine(() => Promise.reject(new Error('no transparent entities this frame: the sort did not run, there is nothing to read')));
    await pixelCheck(reporter, 'sort', engine, async (_probe, _rows, readSort) => {
      await readSort();
      return { ok: true, detail: '' };
    });
    expect(reporter.results()[0]).toMatchObject({ status: 'fail', detail: expect.stringMatching(/no transparent entities this frame/) });
  });

  it('fails after the timeout when no frame serves the readback', async () => {
    vi.useFakeTimers();
    const reporter = createTestReporter();
    const engine = sortEngine(() => new Promise(() => {}));
    const done = pixelCheck(reporter, 'sort', engine, async (_probe, _rows, readSort) => {
      await readSort();
      return { ok: true, detail: '' };
    });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    await done;
    vi.useRealTimers();
    expect(reporter.results()[0]).toMatchObject({ status: 'fail', detail: expect.stringMatching(/no frame served/) });
  });
});

describe('reportTextureLoadFailure', () => {
  it('skips only when there is no main-thread renderer (Mode A)', () => {
    const reporter = createTestReporter();
    reportTextureLoadFailure(reporter, 'tex', '/t.png', new Error('Cannot load textures: no renderer available'));
    expect(reporter.results()).toEqual([
      { name: 'tex', status: 'skip', detail: 'no main-thread renderer: Cannot load textures: no renderer available' },
    ]);
  });

  it.each([
    'Failed to fetch /t.png: 404',
    'The source image could not be decoded.',
    'Tier 0 (64px) is full: 256 layers',
  ])('fails, with the url and the error, on anything else: %s', (message) => {
    const reporter = createTestReporter();
    reportTextureLoadFailure(reporter, 'tex', '/t.png', new Error(message));
    expect(reporter.results()).toEqual([{ name: 'tex', status: 'fail', detail: `cannot load /t.png: ${message}` }]);
  });

  it('takes a thrown non-Error too', () => {
    const reporter = createTestReporter();
    reportTextureLoadFailure(reporter, 'tex', '/t.png', 'boom');
    expect(reporter.results()[0]).toMatchObject({ status: 'fail', detail: 'cannot load /t.png: boom' });
  });
});
