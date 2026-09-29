import { describe, it, expect } from 'vitest';
import { checkTransparentDepth, checkTransparentSort } from './twin-2d';
import { createTestReporter } from './types';
import type { Hyperion } from '../hyperion';

// The two 2D Twins checks that load /textures/sort-test-128.png (review
// wf_61c6a580-afa #18). Only a missing main-thread renderer (Mode A) is an
// environment limit; a texture that cannot be fetched or decoded is a broken
// build. Both checks return right after a failed load, so the engine needs no
// more than this.
const NOT_FOUND = 'Failed to fetch /textures/sort-test-128.png: 404';
const NO_RENDERER = 'Cannot load textures: no renderer available';

function engine(mode: 'A' | 'B' | 'C', loadError: string): Hyperion {
  return {
    mode,
    debug: {},
    loadTexture: () => Promise.reject(new Error(loadError)),
  } as unknown as Hyperion;
}

const statusOf = (reporter: ReturnType<typeof createTestReporter>) =>
  Object.fromEntries(reporter.results().map((r) => [r.name, r.status]));

describe('2D Twins: a failed test-texture load', () => {
  it.each(['B', 'C'] as const)('Mode %s, the file is missing: the depth check fails with the error', async (mode) => {
    const reporter = createTestReporter();
    await checkTransparentDepth(engine(mode, NOT_FOUND), reporter);
    expect(reporter.results()).toEqual([
      { name: 'Depth orders transparent sprites', status: 'fail', detail: expect.stringContaining(NOT_FOUND) },
    ]);
  });

  it('Mode B, the file is missing: the oracle check fails, the churn check keeps its Mode-B skip', async () => {
    const reporter = createTestReporter();
    await checkTransparentSort(engine('B', NOT_FOUND), reporter);
    expect(statusOf(reporter)).toEqual({
      'Transparent sort matches the oracle': 'fail',
      'Transparent sort under churn': 'skip',
    });
    const churn = reporter.results().find((r) => r.name === 'Transparent sort under churn')!;
    expect(churn.detail).toMatch(/Mode B: only Mode C uploads through the scatter pass/);
  });

  it('Mode C, the file is missing: both sort checks fail with the error', async () => {
    const reporter = createTestReporter();
    await checkTransparentSort(engine('C', NOT_FOUND), reporter);
    expect(statusOf(reporter)).toEqual({
      'Transparent sort matches the oracle': 'fail',
      'Transparent sort under churn': 'fail',
    });
    for (const r of reporter.results()) expect(r.detail).toContain(NOT_FOUND);
  });

  it('Mode A, no main-thread renderer: all three checks skip', async () => {
    const reporter = createTestReporter();
    await checkTransparentDepth(engine('A', NO_RENDERER), reporter);
    await checkTransparentSort(engine('A', NO_RENDERER), reporter);
    expect(statusOf(reporter)).toEqual({
      'Depth orders transparent sprites': 'skip',
      'Transparent sort matches the oracle': 'skip',
      'Transparent sort under churn': 'skip',
    });
  });
});
