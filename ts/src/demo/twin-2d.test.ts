import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { checkTransparentDepth, checkTransparentSort, ORDER_PROBE_OFFSET } from './twin-2d';
import { maxChannelDiff, over, straight, type Rgb } from './blend-expect';
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

// Round step 8 (sub-decision 2 (e)): tier images are upright, so the probe of
// 'Depth orders transparent sprites' moved to local y -0.15, where the
// upright image shows the texel it read before: the PNG's bottom-right
// (yellow) quadrant, over the teal of cell 1.
describe("2D Twins: the depth check's probe reads a telling texel of the upright image", () => {
  /** sort-test-128.png's RGBA at texel (x, y), y from the image's top row (filter 0 on every row: scripts/gen-sort-test-png.mjs). */
  function texel(x: number, y: number): number[] {
    const png = readFileSync(new URL('../../public/textures/sort-test-128.png', import.meta.url));
    const idat: Buffer[] = [];
    for (let at = 8; at < png.length;) {
      const length = png.readUInt32BE(at);
      if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
      at += 12 + length;
    }
    const rows = inflateSync(Buffer.concat(idat));
    const stride = 1 + 128 * 4;
    expect(rows[y * stride], `row ${y}: filter byte`).toBe(0);
    return [...rows.subarray(y * stride + 1 + x * 4, y * stride + 1 + x * 4 + 4)];
  }

  it('cell 1 (the textured quad, scale 2, over teal): the probe shows the yellow quadrant, more than 0.1 off the teal', () => {
    const [dx, dy] = ORDER_PROBE_OFFSET;
    // The quad's uv (position + 0.5, half-side 1), turned over at the lookup: texture v = 1 - uv.y.
    const [u, v] = [0.5 + dx / 2, 1 - (0.5 + dy / 2)];
    const [r, g, b, a] = texel(Math.floor(u * 128), Math.floor(v * 128));
    expect([r, g, b, a], 'the bottom-right quadrant').toEqual([240, 200, 50, 160]);
    const teal: Rgb = [0.25, 0.75, 0.5];  // TINT.teal
    const shown = over(teal, straight([r / 255, g / 255, b / 255], a / 255));
    expect(maxChannelDiff(shown, teal)).toBeGreaterThan(0.1);
  });
});
