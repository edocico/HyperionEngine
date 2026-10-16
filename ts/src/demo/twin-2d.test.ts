import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { checkImageOrientation, checkTransparentDepth, checkTransparentSort, imageOrientationVerdict, IMAGE_QUADRANTS, ORDER_PROBE_OFFSET } from './twin-2d';
import { maxChannelDiff, over, straight, type Rgb } from './blend-expect';
import { createTestReporter } from './types';
import type { Hyperion } from '../hyperion';

// The 2D Twins checks that load /textures/sort-test-128.png (review
// wf_61c6a580-afa #18). Only a missing main-thread renderer (Mode A) is an
// environment limit; a texture that cannot be fetched or decoded is a broken
// build. Each returns right after a failed load, so the engine needs no
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

  it.each(['B', 'C'] as const)('Mode %s, the file is missing: the orientation check fails with the error (round step 8)', async (mode) => {
    const reporter = createTestReporter();
    await checkImageOrientation(engine(mode, NOT_FOUND), reporter);
    expect(reporter.results()).toEqual([
      { name: 'Textured quad and line show their image upright', status: 'fail', detail: expect.stringContaining(NOT_FOUND) },
    ]);
  });

  it('Mode A, no main-thread renderer: all four checks skip', async () => {
    const reporter = createTestReporter();
    await checkTransparentDepth(engine('A', NO_RENDERER), reporter);
    await checkTransparentSort(engine('A', NO_RENDERER), reporter);
    await checkImageOrientation(engine('A', NO_RENDERER), reporter);
    expect(statusOf(reporter)).toEqual({
      'Depth orders transparent sprites': 'skip',
      'Transparent sort matches the oracle': 'skip',
      'Transparent sort under churn': 'skip',
      'Textured quad and line show their image upright': 'skip',
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

// Round step 8 (sub-decision 2 (e)): a textured quad and a textured line
// show the PNG upright; its four distinct quadrants tell every symmetry of
// the square apart.
describe('imageOrientationVerdict', () => {
  const CLEAR: Rgb = [0.067, 0.067, 0.067];
  /** A shape whose corners (upper left, upper right, lower left, lower right) show these quadrants; -1 shows the clear. */
  const reads = (shows: readonly number[]): Rgb[] => shows.map((q) => (q < 0 ? CLEAR : IMAGE_QUADRANTS[q].rgb));
  const UPRIGHT = [0, 1, 2, 3];
  const V_FLIPPED = [2, 3, 0, 1];

  it('passes both shapes upright', () => {
    expect(imageOrientationVerdict({ quad: reads(UPRIGHT), line: reads(UPRIGHT), clear: CLEAR }))
      .toEqual({ ok: true, detail: 'quad TL TR BL BR, line TL TR BL BR (at the upper left, upper right, lower left, lower right)' });
  });

  it('names each other symmetry of either shape, and v flipped on both: the lookup does not turn v over', () => {
    const others: Array<[number[], string]> = [
      [[1, 0, 3, 2], 'u flipped'], [[3, 2, 1, 0], 'half a turn off'], [[0, 2, 1, 3], 'transposed (u and v swapped)'],
      [[3, 1, 2, 0], 'transposed across the other diagonal'], [[1, 3, 0, 2], 'a quarter turn off'], [[2, 0, 3, 1], 'three quarters of a turn off'],
    ];
    for (const [shows, name] of others) {
      for (const shape of ['quad', 'line'] as const) {
        const v = imageOrientationVerdict({ quad: reads(shape === 'quad' ? shows : UPRIGHT), line: reads(shape === 'line' ? shows : UPRIGHT), clear: CLEAR });
        expect(v.ok, `${shape}: ${name}`).toBe(false);
        expect(v.detail).toContain(`the ${shape} is ${name}`);
      }
    }
    const both = imageOrientationVerdict({ quad: reads(V_FLIPPED), line: reads(V_FLIPPED), clear: CLEAR });
    expect(both.ok).toBe(false);
    expect(both.detail).toContain('the quad is v flipped (sampleTierOrWhite does not turn v over)');
    expect(both.detail).toContain('the line is v flipped (sampleTierOrWhite does not turn v over)');
  });

  it('names a flip that sits in one library: the line alone flipped, the quad alone flipped, each with both of its causes', () => {
    expect(imageOrientationVerdict({ quad: reads(UPRIGHT), line: reads(V_FLIPPED), clear: CLEAR }).detail)
      .toContain('the line only is v flipped: one library turns v over on its own (the flip moved from sampleTierOrWhite into quad_vs, or a second flip in line_vs)');
    expect(imageOrientationVerdict({ quad: reads(V_FLIPPED), line: reads(UPRIGHT), clear: CLEAR }).detail)
      .toContain('the quad only is v flipped: one library turns v over on its own (a second flip in quad_vs, or the flip moved from sampleTierOrWhite into line_vs)');
  });

  it('names a shape that draws nothing, and reads no quadrant explains, NaN included: never a pass', () => {
    const none = imageOrientationVerdict({ quad: reads(UPRIGHT), line: reads([-1, -1, -1, -1]), clear: CLEAR });
    expect(none.ok).toBe(false);
    expect(none.detail).toContain('the line draws nothing (the clear at its four corners)');
    const nan = imageOrientationVerdict({ quad: [[NaN, NaN, NaN], ...reads(UPRIGHT).slice(1)], line: reads(UPRIGHT), clear: CLEAR });
    expect(nan.ok).toBe(false);
    expect(nan.detail).toContain('the quad: no quadrant within 0.03 at the upper left (NaN, NaN, NaN)');
  });
});
