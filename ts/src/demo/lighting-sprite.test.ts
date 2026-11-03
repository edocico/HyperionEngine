import { afterEach, describe, expect, it, vi } from 'vitest';
import { crc32 as zlibCrc32, inflateSync } from 'node:zlib';
import {
  blockAt, blockCentres, blockLight, blockMix, checkSprite, cookiePixels, cookieTexel, cookieUv, cookieVerdict, crc32, decodeBlock, encodePng,
  fillerUrl, growthVerdict, mixVerdict, pokeGeometry, popVerdict, spriteShadowVerdict, COOKIE_SIZE, COOKIE_THETAS, COOKIE_URL, ENERGY,
  LOAD_TIMEOUT_MS, MIRRORS, POKE_DEPTH, POP_RANGE, POP_THETAS, SHADOW_POINTS, SPRITE_SCENE, TOL, type CookieRead, type GrowthReads,
  type PopRead,
} from './lighting-sprite';
import { createTestReporter } from './types';
import { Camera } from '../camera';
import { CameraAPI } from '../camera-api';
import { MAX_LAYERS_PER_TIER, packTextureIndex, unpackTextureIndex } from '../texture-manager';
import { viewBounds, type Rgba } from './probe-checks';
import type { Rgb } from './blend-expect';
import type { Hyperion } from '../hyperion';
import type { EntityHandle } from '../entity-handle';

// The Lighting tab's floor (ambient + its global light) under the sub-scene.
const F: Rgb = [0.185, 0.17, 0.295];
const rgba = (c: readonly number[]): Rgba => [c[0], c[1], c[2], 1];
const sum = (a: readonly number[], b: readonly number[]): Rgb => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

describe('the procedural cookie', () => {
  it('64 x 64, 4 x 4 blocks of 16 px: every block code unique, the border opaque, blue 255 everywhere', () => {
    const px = cookiePixels();
    expect(px).toHaveLength(COOKIE_SIZE * COOKIE_SIZE * 4);
    expect([...px.subarray(0, 4)]).toEqual(cookieTexel(0, 0));
    expect([...px.subarray(((63 * 64) + 63) * 4, ((63 * 64) + 63) * 4 + 4)]).toEqual(cookieTexel(3, 3));
    // Pixel (x 40, y 20): column 2, row 1, the alpha-64 block.
    expect([...px.subarray((20 * 64 + 40) * 4, (20 * 64 + 40) * 4 + 4)]).toEqual([170, 85, 255, 64]);
    const codes = new Set<string>();
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        codes.add(blockLight(i, j, ENERGY).map((v) => v.toFixed(4)).join());
        if (i === 0 || i === 3 || j === 0 || j === 3) expect(cookieTexel(i, j)[3], `(${i},${j})`).toBe(255);
        expect(cookieTexel(i, j)[2]).toBe(255);
      }
    }
    expect(codes.size).toBe(16);
  });

  it('is a valid PNG with stored deflate blocks: CRC-32 as zlib computes it, the IDAT inflating to the filtered rows', () => {
    const png = encodePng(COOKIE_SIZE, COOKIE_SIZE, cookiePixels());
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const chunks: Array<{ type: string; data: Uint8Array; crc: number }> = [];
    for (let at = 8; at < png.length;) {
      const length = view.getUint32(at);
      const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
      chunks.push({ type, data: png.subarray(at + 8, at + 8 + length), crc: view.getUint32(at + 8 + length) });
      at += 12 + length;
    }
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    for (const c of chunks) expect(c.crc).toBe(zlibCrc32(Buffer.from([...c.type].map((ch) => ch.charCodeAt(0)).concat([...c.data]))));
    expect(crc32(new Uint8Array([1, 2, 3, 250]))).toBe(zlibCrc32(Buffer.from([1, 2, 3, 250])));
    const rows = inflateSync(chunks[1].data);
    expect(rows).toHaveLength(COOKIE_SIZE * (1 + COOKIE_SIZE * 4));
    expect([...rows.subarray(0, 5)]).toEqual([0, ...cookieTexel(0, 0)]);
  });

  it('travels as a data: URL, the same string on every load, and every filler URL is its own', () => {
    expect(COOKIE_URL.startsWith('data:image/png;base64,')).toBe(true);
    expect(Buffer.from(COOKIE_URL.slice(22), 'base64')).toEqual(Buffer.from(encodePng(COOKIE_SIZE, COOKIE_SIZE, cookiePixels())));
    expect(new Set([2, 3, 255, 256, 511].map(fillerUrl)).size).toBe(5);
  });
});

describe('sprite-light geometry', () => {
  it("the cookie's uv is the textured quad's, turned over at the lookup: the image's first row along the light's local +y edge (upright at rotation 0)", () => {
    expect(cookieUv([-4, 4], 4)).toEqual([0, 0]);
    expect(cookieUv([4, -4], 4)).toEqual([1, 1]);
    // Unturned: block (0, 0), the image's top-left, at the top left of the square on the y-up screen.
    const centres = blockCentres([0, 0], 0, 4);
    expect(centres[0]).toEqual({ i: 0, j: 0, at: [-3, 3] });
    expect(centres[15]).toEqual({ i: 3, j: 3, at: [3, -3] });
    // A quarter turn: local +x is world +y.
    const turned = blockCentres([0, 0], Math.PI / 2, 4)[3];
    expect(turned.at[0]).toBeCloseTo(-3);
    expect(turned.at[1]).toBeCloseTo(3);
  });

  it('blockAt is the inverse of blockCentres: the block a turned sprite light shows at a world point', () => {
    for (const theta of [0, Math.PI / 2, Math.PI / 6, -2]) {
      for (const { i, j, at } of blockCentres([3, -1], theta, 4)) expect(blockAt([3, -1], theta, 4, at), `(${i},${j}) at ${theta}`).toEqual([i, j]);
    }
  });

  it('decodes a read back to its block and alpha', () => {
    for (const [i, j] of [[0, 0], [2, 1], [2, 2], [3, 3]]) {
      const got = decodeBlock(sum(F, blockLight(i, j, ENERGY)), F, ENERGY);
      expect(got).toMatchObject({ i, j });
      expect(got!.a).toBeCloseTo(cookieTexel(i, j)[3] / 255);
    }
    expect(decodeBlock(F, F, ENERGY)).toBeNull();
  });

  it('the pop geometry: the square centred d outside the edge, a sliver POKE_DEPTH deep, the control past its tip', () => {
    const ds = POP_THETAS.map((t) => pokeGeometry(t, POP_RANGE, POKE_DEPTH).d);
    expect(ds.map((d) => d.toFixed(3))).toEqual(['5.000', '6.348', '7.196', '7.485', '7.196', '6.348']);
    for (const theta of POP_THETAS) {
      const g = pokeGeometry(theta, POP_RANGE, POKE_DEPTH);
      const local = (p: readonly number[]): number[] => {
        const [dx, dy] = [p[0] + g.d, p[1]];
        return [dx * Math.cos(theta) + dy * Math.sin(theta), -dx * Math.sin(theta) + dy * Math.cos(theta)];
      };
      expect(Math.max(...local(g.poke).map(Math.abs)), `the poke inside at ${theta}`).toBeLessThan(POP_RANGE);
      expect(Math.max(...local(g.control).map(Math.abs)), `the control outside at ${theta}`).toBeGreaterThan(POP_RANGE);
      // Kept by range·√2 at every angle; by the radius before step 8, range, only up to 11° and from 79°.
      expect(g.d).toBeLessThanOrEqual(POP_RANGE * Math.SQRT2);
      expect(g.d <= POP_RANGE, `old radius at ${theta}`).toBe(theta === 0);
    }
    expect(pokeGeometry(Math.PI / 4, POP_RANGE, POKE_DEPTH).halfWidth).toBeCloseTo(0.5);
  });
});

/** K's 16 reads at `theta`: the floor plus blockLight, or another block (`map`), or nothing. */
function cookieRead(theta: number, map: (i: number, j: number) => [number, number] | null = (i, j) => [i, j]): CookieRead {
  const values = blockCentres([0, 0], theta, 1).map(({ i, j }) => {
    const m = map(i, j);
    return rgba(m ? sum(F, blockLight(m[0], m[1], ENERGY)) : F);
  });
  return { theta, values, floor: rgba(F) };
}

describe('cookieVerdict', () => {
  it('passes the blocks as drawn, within TOL', () => {
    const v = cookieVerdict(COOKIE_THETAS.map((t) => cookieRead(t)), ENERGY);
    expect(v).toEqual({ ok: true, detail: 'blocks 0° 16/16, 90° 16/16, 30° 16/16' });
    const shifted = cookieRead(0);
    shifted.values[5] = rgba(sum(shifted.values[5], [TOL * 0.9, 0, 0]));
    expect(cookieVerdict([shifted], ENERGY).ok).toBe(true);
  });

  it('names a flipped, transposed or unturned mapping, nothing lit, and the alpha', () => {
    const cases: Array<[(i: number, j: number) => [number, number] | null, RegExp]> = [
      [(i, j) => [i, 3 - j], /v is flipped \(the uv convention\)/],
      [(i, j) => [3 - i, j], /u is flipped/],
      [(i, j) => [j, i], /u and v are swapped/],
      [(i, j) => [j, 3 - i], /a quarter turn off/],
      [() => null, /nothing lit at any block/],
    ];
    for (const [map, cause] of cases) {
      const v = cookieVerdict([cookieRead(Math.PI / 2, map)], ENERGY);
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(cause);
    }
    // The alpha ignored: the translucent blocks read as opaque ones.
    const alpha = cookieRead(0);
    alpha.values[1 * 4 + 2] = rgba(sum(F, [ENERGY * 2 / 3, ENERGY / 3, ENERGY]));
    alpha.values[2 * 4 + 2] = rgba(sum(F, [ENERGY * 2 / 3, ENERGY * 2 / 3, ENERGY]));
    expect(cookieVerdict([alpha], ENERGY).detail).toMatch(/the cookie's alpha is not the weight/);
  });

  it('judges a mirrored read against its mirror image, and names a mirror not applied', () => {
    for (const m of MIRRORS) {
      expect(cookieVerdict([{ ...cookieRead(0, m.expect), label: m.label, expect: m.expect }], ENERGY)).toEqual({ ok: true, detail: `blocks ${m.label} 16/16` });
    }
    const [y, x] = MIRRORS;
    expect(cookieVerdict([{ ...cookieRead(0), label: y.label, expect: y.expect }], ENERGY).detail)
      .toContain("at y-mirrored 0°: every block read unmirrored: the side axis does not follow the transform's determinant");
    expect(cookieVerdict([{ ...cookieRead(0, (i, j) => [3 - i, 3 - j]), label: x.label, expect: x.expect }], ENERGY).detail)
      .toContain('at x-mirrored 0°: every block read half a turn off, not mirrored');
    // The other mirror instead of the expected one: named by its symmetry, relative to the expected blocks.
    expect(cookieVerdict([{ ...cookieRead(0, x.expect), label: y.label, expect: y.expect }], ENERGY).detail).toContain('half a turn off');
  });

  /** K's mirrored read `m` at θ = 0, showing `map` at each centre. */
  const mirrored = (m: (typeof MIRRORS)[number], map: (i: number, j: number) => [number, number]): CookieRead => ({ ...cookieRead(0, map), label: m.label, expect: m.expect });

  it('judges the mirrored reads against the plain 0° read: a u or v flip of the lookup is named once, at 0°, never as a missing mirror (review wf_a2ed3389-7aa, AR7)', () => {
    const [y, x] = MIRRORS;
    // v flipped, the mirrors right: the y-mirror reads unmirrored, the x-mirror half a turn off.
    const v = cookieVerdict([cookieRead(0, (i, j) => [i, 3 - j]), mirrored(y, (i, j) => [i, j]), mirrored(x, (i, j) => [3 - i, 3 - j])], ENERGY);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('at 0°: every block read as its mirror top to bottom: v is flipped');
    expect(v.detail).not.toContain('spriteAxes');
    expect(v.detail).toContain("at y-mirrored 0°: the 0° read's mapping, mirrored as expected");
    expect(v.detail).toContain("at x-mirrored 0°: the 0° read's mapping, mirrored as expected");
    // u flipped: the same two reads, the mirrors swapped.
    const u = cookieVerdict([cookieRead(0, (i, j) => [3 - i, j]), mirrored(y, (i, j) => [3 - i, 3 - j]), mirrored(x, (i, j) => [i, j])], ENERGY);
    expect(u.detail).toContain('at 0°: every block read as its mirror left to right: u is flipped');
    expect(u.detail).not.toContain('spriteAxes');
  });

  it('still names a mirror not applied: against a 0° read that passes (noMirror), and against one that shows a u flip', () => {
    const [y, x] = MIRRORS;
    // No mirror: the y-mirror reads unmirrored; the x-mirror, both axes turned over, half a turn off.
    const plain = cookieVerdict([cookieRead(0), mirrored(y, (i, j) => [i, j]), mirrored(x, (i, j) => [3 - i, 3 - j])], ENERGY).detail;
    expect(plain).toContain("at y-mirrored 0°: every block read unmirrored: the side axis does not follow the transform's determinant (spriteAxes)");
    expect(plain).toContain("at x-mirrored 0°: every block read half a turn off, not mirrored: the side axis does not follow the transform's determinant (spriteAxes)");
    // A u flip and no mirror: each mirrored read shows the 0° read's flip, unmirrored or half a turn off.
    const both = cookieVerdict([cookieRead(0, (i, j) => [3 - i, j]), mirrored(y, (i, j) => [3 - i, j]), mirrored(x, (i, j) => [i, 3 - j])], ENERGY).detail;
    expect(both).toContain('at 0°: every block read as its mirror left to right: u is flipped');
    expect(both).toContain("at y-mirrored 0°: every block read unmirrored relative to the 0° read: the side axis does not follow the transform's determinant (spriteAxes)");
    expect(both).toContain("at x-mirrored 0°: every block read half a turn off, not mirrored, relative to the 0° read: the side axis does not follow the transform's determinant (spriteAxes)");
  });

  it('a quarter turn at 0° is a fixed quarter turn of the uv; at another angle the square does not turn with the light, unless 0° shows the same one', () => {
    const quarter = (i: number, j: number): [number, number] => [j, 3 - i];
    const zero = cookieVerdict([cookieRead(0, quarter)], ENERGY).detail;
    expect(zero).toContain('at 0°: every block read a quarter turn off: a fixed quarter turn of the uv');
    expect(zero).not.toContain('does not turn with the light');
    expect(cookieVerdict([cookieRead(0), cookieRead(Math.PI / 2, quarter)], ENERGY).detail)
      .toContain('at 90°: every block read a quarter turn off: the square or its uv does not turn with the light');
    const fixed = cookieVerdict([cookieRead(0, quarter), cookieRead(Math.PI / 2, quarter)], ENERGY).detail;
    expect(fixed).toContain('at 90°: every block read a quarter turn off: a fixed quarter turn of the uv, as at 0°');
    expect(fixed).not.toContain('does not turn with the light');
  });

  it('a non-finite read is off, never within TOL', () => {
    const one = cookieRead(0);
    one.values[5] = [NaN, NaN, NaN, 1];
    expect(cookieVerdict([one], ENERGY)).toMatchObject({ ok: false, detail: expect.stringMatching(/^blocks 0° 15\/16; at 0°: 1 blocks off/) });
    const all = cookieRead(0);
    all.values = all.values.map((): Rgba => [NaN, NaN, NaN, 1]);
    expect(cookieVerdict([all], ENERGY).ok).toBe(false);
    expect(cookieVerdict([{ ...cookieRead(0), floor: [NaN, NaN, NaN, 1] }], ENERGY).ok).toBe(false);
  });

  it('a block off within its code names up to four such blocks, each read and the value it wants', () => {
    // The light at 1.1 times its value: every block keeps its code.
    const scaled = cookieRead(0);
    scaled.values = scaled.values.map((v) => rgba(sum(F, [1.1 * (v[0] - F[0]), 1.1 * (v[1] - F[1]), 1.1 * (v[2] - F[2])])));
    expect(cookieVerdict([scaled], ENERGY).detail).toBe('blocks 0° 0/16; at 0°: 16 blocks off within their codes: '
      + '(0,0) read (0.185, 0.170, 2.495) want (0.185, 0.170, 2.295), (1,0) read (0.918, 0.170, 2.495) want (0.852, 0.170, 2.295), '
      + '(2,0) read (1.652, 0.170, 2.495) want (1.518, 0.170, 2.295), (3,0) read (2.385, 0.170, 2.495) want (2.185, 0.170, 2.295)');
    const one = cookieRead(0);
    one.values[5] = rgba(sum(one.values[5], [0.04, 0, 0]));
    expect(cookieVerdict([one], ENERGY).detail).toBe('blocks 0° 15/16; at 0°: 1 blocks off within their codes: (1,1) read (0.892, 0.837, 2.295) want (0.852, 0.837, 2.295)');
  });
});

describe('mixVerdict', () => {
  /** K's 16 mix reads, `at` each block. */
  const read = (at: (i: number, j: number) => readonly number[]): CookieRead =>
    ({ theta: 0, values: blockCentres([0, 0], 0, 1).map(({ i, j }) => rgba(at(i, j))), floor: rgba(F) });

  it('passes floor·(1 − a) + energy × rgb·a at every block', () => {
    expect(mixVerdict(read((i, j) => blockMix(F, i, j, ENERGY)), ENERGY)).toEqual({ ok: true, detail: 'mix 0° 16/16' });
    // An opaque block replaces the floor; the alpha-64 block keeps 3/4 of it.
    expect(blockMix(F, 0, 0, ENERGY)).toEqual([0, 0, 2]);
    expect(blockMix(F, 2, 1, ENERGY)[2]).toBeCloseTo(F[2] * (1 - 64 / 255) + 2 * (64 / 255));
  });

  it('names a mix added like add, a weight that ignores the alpha, and a non-finite read', () => {
    expect(mixVerdict(read((i, j) => sum(F, blockLight(i, j, ENERGY))), ENERGY).detail).toBe('mix 0° 0/16; mix added like add (floor + target × alpha)');
    const target = (i: number, j: number) => cookieTexel(i, j).slice(0, 3).map((v) => (ENERGY * v) / 255);
    expect(mixVerdict(read(target), ENERGY).detail).toContain("the mix weight ignores the cookie's alpha (the target at every block)");
    const nan = read((i, j) => blockMix(F, i, j, ENERGY));
    nan.values[0] = [NaN, NaN, NaN, 1];
    expect(mixVerdict(nan, ENERGY)).toEqual({ ok: false, detail: 'mix 0° 15/16; 1 blocks off: (0,0) read (NaN, NaN, NaN) want (0.000, 0.000, 2.000)' });
  });

  it('any other miss names up to four blocks, each read and the value it wants', () => {
    // The mix at 1.1 times its value.
    const scaled = read((i, j) => blockMix(F, i, j, ENERGY).map((v) => 1.1 * v));
    expect(mixVerdict(scaled, ENERGY).detail).toContain('mix 0° 0/16; 16 blocks off: (0,0) read (0.000, 0.000, 2.200) want (0.000, 0.000, 2.000), ');
  });
});

describe('growthVerdict', () => {
  const ok: GrowthReads = {
    before: { used: 2, allocated: 16 }, after: { used: 17, allocated: 32 },
    fillerLayers: Array.from({ length: 15 }, (_, k) => 2 + k),
    first: cookieRead(Math.PI / 6), turned: cookieRead(0), turnedAtFirst: cookieRead(Math.PI / 6), errors: 0, errorMessages: [],
  };

  it('passes a doubled tier, the next layers, the cookie in the first frame and after a turn, and no GPU error', () => {
    expect(growthVerdict(ok, ENERGY)).toEqual({
      ok: true, detail: '16 -> 32 layers (15 fillers, layers 2-16), cookie 30° and 0°, 0 GPU errors',
    });
  });

  it('names a frozen light buffer, GPU errors, a tier that did not grow and fillers out of place', () => {
    // A stale group 1: every frame after the growth dropped, the buffer still at 30°.
    const frozen = growthVerdict({ ...ok, turned: cookieRead(0, () => null), errors: 12, errorMessages: ['Destroyed texture used in a submit'] }, ENERGY);
    expect(frozen.ok).toBe(false);
    expect(frozen.detail).toContain('after the turn the light buffer still shows 30°: the frames since the growth did not run');
    expect(frozen.detail).toContain('12 GPU errors (Destroyed texture used in a submit)');
    const flat = growthVerdict({ ...ok, after: { used: 17, allocated: 16 } }, ENERGY);
    expect(flat.detail).toContain('the tier did not double: 16 -> 16 layers');
    const skipped = growthVerdict({ ...ok, fillerLayers: [2, 3, 5] }, ENERGY);
    expect(skipped.detail).toContain('the fillers took layers 2,3,5, not 2-4');
    expect(growthVerdict({ ...ok, errors: null }, ENERGY).detail).toContain('no GPU error witness');
    expect(growthVerdict({ ...ok, errors: 11, errorMessages: [] }, ENERGY).detail).toContain('11 GPU errors (messages not kept: cap reached)');
    // A non-finite read in the first frame after the growth fails it.
    const nan = cookieRead(Math.PI / 6);
    nan.values[0] = [NaN, NaN, NaN, 1];
    expect(growthVerdict({ ...ok, first: nan }, ENERGY).detail).toContain('first frame after the growth: blocks 30° 15/16');
  });
});

describe('popVerdict', () => {
  const lit = (theta: number, over: Partial<PopRead> = {}): PopRead => ({
    theta, poke: rgba(sum(F, [ENERGY, ENERGY, ENERGY])), control: rgba(F), floor: rgba(F), listed: true, ...over,
  });

  it('passes a lit sliver and a dark control at every angle', () => {
    const v = popVerdict(POP_THETAS.map((t) => lit(t)), ENERGY);
    expect(v.ok).toBe(true);
    expect(v.detail).toMatch(/^blue over the floor, sliver\/control: 0° 2\.000\/0\.000, 15° 2\.000\/0\.000/);
  });

  it('names a light missing from the list, a square that does not turn, and one too large', () => {
    const culled = popVerdict([lit(Math.PI / 4, { poke: rgba(F), listed: false })], ENERGY);
    expect(culled.detail).toContain('45°: K is not in the light list (its culling radius is under range·√2)');
    const unturned = popVerdict([lit(Math.PI / 4, { poke: rgba(F) })], ENERGY);
    expect(unturned.detail).toContain('45°: listed but the sliver is dark');
    const large = popVerdict([lit(0, { control: rgba(sum(F, [0, 0, ENERGY])) })], ENERGY);
    expect(large.detail).toContain("0°: lit past the square's tip");
  });
});

describe('spriteShadowVerdict', () => {
  const open = rgba(sum(F, [ENERGY, ENERGY, ENERGY]));
  it("passes S dark behind the wall, S' and U lit", () => {
    expect(spriteShadowVerdict({ S: rgba(F), S2: open, U: open, floor: rgba(F), groups: 1, sdfSets: 1 }, ENERGY)).toEqual({
      ok: true, detail: "L's light at S 0.000, S' 1.000, U 1.000; 1 group(s), 1 SDF set(s)",
    });
  });

  it('names the TS gate (no SDF set), the WGSL gate, and a march away from the light', () => {
    expect(spriteShadowVerdict({ S: open, S2: open, U: open, floor: rgba(F), groups: 1, sdfSets: 0 }, ENERGY).detail)
      .toContain('light-groups.ts does not count a shadowed sprite light');
    expect(spriteShadowVerdict({ S: open, S2: open, U: open, floor: rgba(F), groups: 1, sdfSets: 1 }, ENERGY).detail)
      .toContain('light-accum.wgsl does not march for a sprite light');
    // A reversed march: S's ray heads away from the wall (lit), U's meets it (dark).
    expect(spriteShadowVerdict({ S: open, S2: open, U: rgba(F), floor: rgba(F), groups: 1, sdfSets: 1 }, ENERGY).detail)
      .toContain('the march runs away from the light');
  });

  it('a reversed march (S lit, U dark, one set) is named alone: no WGSL gate, which would leave U lit (review wf_a2ed3389-7aa, SP2)', () => {
    const v = spriteShadowVerdict({ S: open, S2: open, U: rgba(F), floor: rgba(F), groups: 1, sdfSets: 1 }, ENERGY);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('the march runs away from the light');
    expect(v.detail).not.toContain('does not march');
    // Without an SDF set nothing marches: the TS gate stays named.
    expect(spriteShadowVerdict({ S: open, S2: open, U: rgba(F), floor: rgba(F), groups: 1, sdfSets: 0 }, ENERGY).detail)
      .toContain('light-groups.ts does not count a shadowed sprite light');
  });

  it("U on another block than L's is a cookie mapping, named by the block it reads, never a march (review wf_a2ed3389-7aa, AR8 + SP3)", () => {
    // A half-turned cookie puts U, lit, on the translucent block (2,1): its blue share is 64/255.
    const half = spriteShadowVerdict({ S: rgba(F), S2: rgba(sum(F, blockLight(2, 3, ENERGY))), U: rgba(sum(F, blockLight(2, 1, ENERGY))), floor: rgba(F), groups: 1, sdfSets: 1 }, ENERGY);
    expect(half.ok).toBe(false);
    expect(half.detail).toContain("U reads block (2,1), not (1,2): L's cookie mapping is off (see 'Sprite cookie at known texels')");
    expect(half.detail).not.toContain('the march runs away from the light');
    // On its own block, dimmed or dark: the march, as before.
    const dimmed = rgba(sum(F, blockLight(1, 2, ENERGY / 2)));
    expect(spriteShadowVerdict({ S: rgba(F), S2: open, U: dimmed, floor: rgba(F), groups: 1, sdfSets: 1 }, ENERGY).detail)
      .toContain('U, between the light and the wall, is shadowed (0.500): the march runs away from the light');
    // Lit on another opaque block: the shadow is right; the mapping is the cookie check's.
    expect(spriteShadowVerdict({ S: rgba(F), S2: open, U: rgba(sum(F, blockLight(1, 1, ENERGY))), floor: rgba(F), groups: 1, sdfSets: 1 }, ENERGY).ok).toBe(true);
  });

  it('names a non-finite read, never a pass', () => {
    const nan: Rgba = [NaN, NaN, NaN, 1];
    const v = spriteShadowVerdict({ S: nan, S2: open, U: nan, floor: rgba(F), groups: 1, sdfSets: 1 }, ENERGY);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('a non-finite read at S, U');
    expect(spriteShadowVerdict({ S: rgba(F), S2: open, U: open, floor: nan, groups: 1, sdfSets: 1 }, ENERGY).detail).toContain('a non-finite read at floor');
  });
});

// ── checkSprite, end to end on a model of the engine ─────────────────────────

/** The defects the model can carry, each one the cause one check names. */
type Defect = 'none' | 'oldRadius' | 'flipV' | 'halfTurn' | 'staleGroup' | 'staleFirst' | 'tsGate' | 'reversedMarch' | 'noMirror' | 'mixAsAdd' | 'mixAlphaIgnored';

interface FakeHandle {
  id: number;
  x: number;
  y: number;
  theta: number;
  /** The scale's signs matter to a sprite light (spriteAxes), its size does not. */
  sx: number;
  sy: number;
  light: { range: number; shadow: number; blend: 'add' | 'sub' | 'mix' } | null;
  tex: number;
  casts: boolean;
  destroyed: boolean;
}

/**
 * A model of the engine: the probe reads F plus every listed sprite light
 * (radius range·√2, or range with 'oldRadius') lighting its turned square with
 * blockLight (v flipped with 'flipV', half a turn off with 'halfTurn'), mirrored by a negative scale as
 * spriteAxes does (not with 'noMirror'), or as a straight "over" for a mix
 * light (added like add with 'mixAsAdd', at weight 1 with 'mixAlphaIgnored'),
 * shadowed where the segment to its centre (away from it with
 * 'reversedMarch') crosses the caster, unless 'tsGate'. PNGs go to the
 * overflow tier (16 layers, doubling). 'staleGroup': every frame after a
 * growth is dropped, each probe raising an uncaptured GPU error;
 * 'staleFirst': the same from the tier's first allocation. `full`: the tier
 * at its 256-layer cap (MAX_LAYERS_PER_TIER; a number: at that many layers)
 * with 129 layers used (half plus one), the state a fifth entry in one page
 * finds, the cookie cached. `stall`: that load never resolves.
 * `loadErrors`: uncaptured GPU errors raised while the cookie loads, the
 * pixels right.
 */
function modelEngine(defect: Defect = 'none', opts: { modeA?: boolean; production?: boolean; full?: boolean | number; stall?: 'cookie' | 'filler'; loadErrors?: number } = {}) {
  const handles: FakeHandle[] = [];
  const cache = new Map<string, number>();
  const tier = { used: 0, allocated: 0 };
  if (opts.full) {
    const layers = opts.full === true ? MAX_LAYERS_PER_TIER : opts.full;
    cache.set(COOKIE_URL, packTextureIndex(0, 1, true));
    Object.assign(tier, { used: layers / 2 + 1, allocated: layers });
  }
  const device = new EventTarget();
  const plugins = new Map<string, (() => void) | void>();
  const requests: Array<{ target: string; layer?: number }> = [];
  let frozen: FakeHandle[] | null = null;
  let nextId = 300;
  const spawn = () => {
    const h: FakeHandle = { id: nextId++, x: 0, y: 0, theta: 0, sx: 1, sy: 1, light: null, tex: 0, casts: false, destroyed: false };
    handles.push(h);
    let size: [number, number] = [1, 1];
    const api = {
      get id() { return h.id; },
      position: (x: number, y: number) => { h.x = x; h.y = y; return api; },
      scale: (sx: number, sy: number) => { size = [sx, sy]; h.sx = sx; h.sy = sy; return api; },
      rotation: (t: number) => { h.theta = t; return api; },
      receivesLight: () => api,
      castsShadow: () => { h.casts = true; (h as FakeHandle & { size?: [number, number] }).size = size; return api; },
      light: (o: { range: number; shadowIntensity?: number; blend?: 'add' | 'sub' | 'mix' }) => {
        h.light = { range: o.range, shadow: o.shadowIntensity ?? 0, blend: o.blend ?? 'add' };
        return api;
      },
      texture: (t: number) => { h.tex = t; return api; },
      destroy: () => { h.destroyed = true; },
    };
    return api;
  };
  const cam = new CameraAPI(new Camera());
  cam.setOrthographic((20 * 1920) / 1080, 20);
  const lights = (from: FakeHandle[]) => from.filter((h) => h.light !== null && !h.destroyed && h.tex !== 0);
  const listed = (from: FakeHandle[]): FakeHandle[] => {
    const [x0, x1, y0, y1] = viewBounds(cam.viewProjection);
    return lights(from).filter((h) => {
      const r = h.light!.range * (defect === 'oldRadius' ? 1 : Math.SQRT2);
      const dx = Math.max(x0 - h.x, 0, h.x - x1);
      const dy = Math.max(y0 - h.y, 0, h.y - y1);
      return Math.hypot(dx, dy) <= r;
    });
  };
  const caster = (): (FakeHandle & { size?: [number, number] }) | undefined => handles.find((h) => h.casts && !h.destroyed);
  const crosses = (a: readonly number[], b: readonly number[]): boolean => {
    const w = caster();
    if (!w) return false;
    const [sx, sy] = w.size ?? [1, 1];
    for (let s = 0; s <= 1; s += 1e-3) {
      const x = a[0] + (b[0] - a[0]) * s;
      const y = a[1] + (b[1] - a[1]) * s;
      if (Math.abs(x - w.x) <= sx / 2 && Math.abs(y - w.y) <= sy / 2) return true;
    }
    return false;
  };
  const shadowed = (): boolean => defect !== 'tsGate' && lights(handles).some((h) => h.light!.shadow > 0);
  const lightAt = (p: readonly [number, number], from: FakeHandle[]): Rgba => {
    let c: Rgb = [...F];
    for (const h of listed(from)) {
      const r = h.light!.range;
      const dx = p[0] - h.x;
      const dy = p[1] - h.y;
      // spriteAxes: the facing follows the x-scale's sign (lightFacing), the side axis the determinant's.
      const facing = Math.sign(h.sx) || 1;
      const side = defect === 'noMirror' ? facing : (Math.sign(h.sy) || 1);
      const [c0, s0] = [Math.cos(h.theta), Math.sin(h.theta)];
      const local: [number, number] = [facing * (dx * c0 + dy * s0), side * (-dx * s0 + dy * c0)];
      if (Math.max(Math.abs(local[0]), Math.abs(local[1])) > r) continue;
      let [u, v] = cookieUv(local, r);
      if (defect === 'flipV') v = 1 - v;
      if (defect === 'halfTurn') {
        u = 1 - u;
        v = 1 - v;
      }
      const i = Math.min(3, Math.max(0, Math.floor(u * 4)));
      const j = Math.min(3, Math.max(0, Math.floor(v * 4)));
      let shadow = 1;
      if (h.light!.shadow > 0 && shadowed()) {
        const away: [number, number] = [p[0] + (p[0] - h.x), p[1] + (p[1] - h.y)];
        shadow = crosses(p, defect === 'reversedMarch' ? away : [h.x, h.y]) ? 0 : 1;
      }
      if (h.light!.blend === 'mix' && defect !== 'mixAsAdd') {
        const [cr, cg, cb, ca] = cookieTexel(i, j).map((x) => x / 255);
        const w = (defect === 'mixAlphaIgnored' ? 1 : ca) * shadow;
        c = [c[0] * (1 - w) + ENERGY * cr * w, c[1] * (1 - w) + ENERGY * cg * w, c[2] * (1 - w) + ENERGY * cb * w];
      } else {
        c = sum(c, blockLight(i, j, ENERGY * shadow));
      }
    }
    return rgba(c);
  };
  const snapshot = (): FakeHandle[] => handles.map((h) => ({ ...h, light: h.light ? { ...h.light } : null }));
  const engine = {
    batch: (fn: () => void) => fn(),
    spawn, cam,
    async loadTexture(url: string, tierIndex?: number) {
      if (opts.modeA) throw new Error('Cannot load textures: no renderer available');
      if (opts.stall === (url === COOKIE_URL ? 'cookie' : 'filler')) return new Promise<number>(() => {});
      const cached = cache.get(url);
      if (cached !== undefined) return cached;
      for (let e = 0; e < (url === COOKIE_URL ? opts.loadErrors ?? 0 : 0); e++) {
        device.dispatchEvent(Object.assign(new Event('uncapturederror'), { error: { message: 'load error' } }));
      }
      if (tier.allocated === 0) {
        tier.allocated = 16;
        tier.used = 1;
        if (defect === 'staleFirst') frozen = snapshot();
      } else if (tier.used + 1 > tier.allocated) {
        tier.allocated *= 2;
        if (defect === 'staleGroup') frozen = snapshot();
      }
      const packed = packTextureIndex(tierIndex ?? 0, tier.used++, true);
      cache.set(url, packed);
      return packed;
    },
    lighting: {
      get groups() {
        return {
          groups: [{ layers: 1, sdfSet: shadowed() ? 0 : -1 }], sdfSets: shadowed() ? [{ occluderLayers: 1 }] : [],
          layerToGroup: [0, 0], lightIds: Uint32Array.from(listed(handles).map((h) => h.id)),
        };
      },
    },
    debug: opts.production ? null : {
      async probe(request: { target: string; world: [number, number][]; layer?: number }) {
        requests.push({ target: request.target, layer: request.layer });
        if (frozen) device.dispatchEvent(Object.assign(new Event('uncapturederror'), { error: { message: 'Destroyed texture used in a submit' } }));
        return { values: request.world.map((p) => lightAt(p, frozen ?? handles)) };
      },
      textureTiers: () => ({
        compressedFormat: 'bc7-rgba-unorm',
        tiers: [64, 128, 256, 512].map((size, t) => ({ size, layers: 0, allocated: 0, overflowLayers: t === 0 ? tier.used : 0, overflowAllocated: t === 0 ? tier.allocated : 0 })),
      }),
    },
    use(plugin: { name: string; install(ctx: unknown): (() => void) | void }) {
      if (plugins.has(plugin.name)) throw new Error(`Plugin "${plugin.name}" is already installed`);
      plugins.set(plugin.name, plugin.install({ gpu: opts.modeA ? null : { device } }));
    },
    unuse(name: string) {
      const cleanup = plugins.get(name);
      if (cleanup) cleanup();
      plugins.delete(name);
    },
  } as unknown as Hyperion;
  return { engine, handles, tier, plugins, requests };
}

describe('checkSprite', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubs = () => {
    vi.stubGlobal('document', { getElementById: () => ({ width: 1920, height: 1080 }) });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  };
  const run = async (defect: Defect, opts: Parameters<typeof modelEngine>[1] = {}, check: Parameters<typeof checkSprite>[5] = {}) => {
    stubs();
    const model = modelEngine(defect, opts);
    const reporter = createTestReporter();
    const entities: EntityHandle[] = [];
    const restoreView = vi.fn();
    await checkSprite(model.engine, reporter, entities, F, restoreView, check);
    return { ...model, reporter, entities, restoreView, results: reporter.results().map(({ name, status, detail }) => ({ name, status, detail: detail ?? '' })) };
  };

  it('in Mode A: four skips (no texture loads), nothing spawned, no witness left, the view untouched', async () => {
    const r = await run('none', { modeA: true });
    expect(r.results.map(({ status }) => status)).toEqual(['skip', 'skip', 'skip', 'skip']);
    expect(r.results[0].detail).toMatch(/no main-thread renderer: Cannot load textures/);
    expect(r.handles).toHaveLength(0);
    expect(r.plugins.size).toBe(0);
    expect(r.restoreView).not.toHaveBeenCalled();
  });

  it('in a production build: four skips before any texture loads', async () => {
    const r = await run('none', { production: true });
    expect(r.results.map(({ status }) => status)).toEqual(['skip', 'skip', 'skip', 'skip']);
    expect(r.tier.allocated).toBe(0);
  });

  it('on the step-8 rules: four passes, the tier grown 16 -> 32 by 15 fillers, the scene put back', async () => {
    const r = await run('none');
    expect(r.results.map(({ name, status, detail }) => [name, status, status === 'pass' ? '' : detail])).toEqual([
      ['Sprite cookie at known texels', 'pass', ''],
      ['Cookie tier grows while the light draws', 'pass', ''],
      ['Sprite light: no pop at the frustum edge', 'pass', ''],
      ['Sprite light shadow behind a wall', 'pass', ''],
    ]);
    expect(r.results[1].detail).toMatch(/^16 -> 32 layers \(15 fillers, layers 2-16\), cookie 30° and 0°, 0 GPU errors/);
    expect(r.results[0].detail).toMatch(/^blocks 0° 16\/16, 90° 16\/16, 30° 16\/16, y-mirrored 0° 16\/16, x-mirrored 0° 16\/16; mix 0° 16\/16; 0 GPU errors since the cookie loaded; cookie overflow tier 0 layer 1;/);
    expect(r.results[3].detail).toContain('1 group(s), 1 SDF set(s)');
    // The floor read the expected values were built from, after the index (the GPU legs anchor the prefix up to it).
    expect(r.results[0].detail).toContain('; cookie overflow tier 0 layer 1; floor 0.185, 0.170, 0.295; ');
    // layerToGroup [0, 0]: the floor's layer 0 is group 0, the sub-scene's one group: every read asks for it.
    expect(new Set(r.requests.map((q) => `${q.target}#${q.layer}`))).toEqual(new Set(['light-buffer#0']));
    // The floor, K, L and the wall; every one destroyed, and in the tab's list.
    expect(r.handles).toHaveLength(4);
    expect(r.handles.every((h) => h.destroyed)).toBe(true);
    expect(r.entities).toHaveLength(4);
    expect(r.plugins.size).toBe(0);
    expect(r.restoreView).toHaveBeenCalledTimes(1);
    // K's cookie is the first texture, layer 1 of overflow tier 0, on K and L both.
    expect(unpackTextureIndex(r.handles[1].tex)).toEqual({ overflow: true, tier: 0, layer: 1 });
    expect(r.handles[2].tex).toBe(r.handles[1].tex);
  });

  it('on a second entry the cached cookie keeps layer 1, and fillers of their own grow the tier again, 32 -> 64', async () => {
    stubs();
    const model = modelEngine('none');
    const enter = async () => {
      const reporter = createTestReporter();
      await checkSprite(model.engine, reporter, [], F, () => {});
      return reporter.results();
    };
    await enter();
    const second = await enter();
    expect(second.map(({ status }) => status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(second[1].detail).toMatch(/^32 -> 64 layers \(16 fillers, layers 17-32\), cookie 30° and 0°, 0 GPU errors/);
    expect(second[0].detail).toContain('cookie overflow tier 0 layer 1');
  });

  it('each defect fails the check that names it', async () => {
    const failing = async (defect: Defect) => (await run(defect)).results.filter((x) => x.status === 'fail').map((x) => [x.name, x.detail]);
    const [cookie] = await failing('flipV');
    expect(cookie[0]).toBe('Sprite cookie at known texels');
    expect(cookie[1]).toMatch(/v is flipped \(the uv convention\)/);
    // The mirrors are right: the flip is not blamed on spriteAxes (review wf_a2ed3389-7aa, AR7).
    expect(cookie[1]).not.toContain('spriteAxes');
    expect(await failing('oldRadius')).toEqual([['Sprite light: no pop at the frustum edge', expect.stringContaining('its culling radius is under range·√2')]]);
    // A stale group 1 drops every frame after the growth: the growth check names it, and the later checks read a frozen buffer too.
    expect((await failing('staleGroup'))[0]).toEqual(['Cookie tier grows while the light draws', expect.stringContaining('the frames since the growth did not run')]);
    expect(await failing('tsGate')).toEqual([['Sprite light shadow behind a wall', expect.stringContaining('light-groups.ts does not count a shadowed sprite light')]]);
    expect(await failing('reversedMarch')).toEqual([['Sprite light shadow behind a wall', expect.stringContaining('the march runs away from the light')]]);
    // Named alone: not also the WGSL gate (review wf_a2ed3389-7aa, SP2).
    expect((await failing('reversedMarch'))[0][1]).not.toContain('does not march');
    // A half-turned cookie: the cookie check names it, and the shadow check reads U on another block, blaming the
    // mapping, not the march (review wf_a2ed3389-7aa, AR8 + SP3).
    const half = await failing('halfTurn');
    expect(half.find(([n]) => n === 'Sprite cookie at known texels')?.[1]).toContain('at 0°: every block read half a turn off');
    const halfShadow = half.find(([n]) => n === 'Sprite light shadow behind a wall')?.[1] ?? '';
    expect(halfShadow).not.toContain('the march runs away from the light');
    expect(halfShadow).toContain("U reads block (2,1), not (1,2): L's cookie mapping is off");
    // The mirror and the mix, read by the cookie check only.
    expect(await failing('noMirror')).toEqual([['Sprite cookie at known texels', expect.stringContaining('at y-mirrored 0°: every block read unmirrored')]]);
    expect(await failing('mixAsAdd')).toEqual([['Sprite cookie at known texels', expect.stringContaining('mix added like add')]]);
    expect(await failing('mixAlphaIgnored')).toEqual([['Sprite cookie at known texels', expect.stringContaining("the mix weight ignores the cookie's alpha")]]);
  });

  it("a stale group from the tier's first allocation fails the cookie check, naming the GPU errors; so do errors alone", async () => {
    const r = await run('staleFirst');
    expect(r.results[0].status).toBe('fail');
    expect(r.results[0].detail).toMatch(/; [1-9]\d* GPU errors since the cookie loaded \(Destroyed texture used in a submit/);
    // Errors with the right pixels: the count alone fails the check, and the growth counts from its own start.
    const errors = await run('none', { loadErrors: 2 });
    expect(errors.results.map(({ status }) => status)).toEqual(['fail', 'pass', 'pass', 'pass']);
    expect(errors.results[0].detail).toContain('; mix 0° 16/16; 2 GPU errors since the cookie loaded (load error | load error);');
    // The growth names its own errors, never the load's.
    const both = await run('staleGroup', { loadErrors: 1 });
    expect(both.results[1].detail).toContain('GPU errors (Destroyed texture used in a submit');
    expect(both.results[1].detail).not.toContain('load error');
  });

  it('a texture load that never resolves fails its checks after LOAD_TIMEOUT_MS, naming it, instead of hanging the tab', async () => {
    expect(LOAD_TIMEOUT_MS).toBe(10000);
    const cookie = await run('none', { stall: 'cookie' }, { loadTimeoutMs: 20 });
    expect(cookie.results.map(({ status }) => status)).toEqual(['fail', 'fail', 'fail', 'fail']);
    expect(cookie.results[0].detail).toBe('cannot load the procedural cookie (a 64 x 64 PNG data: URL): timed out after 20 ms');
    expect(cookie.handles).toHaveLength(0);
    expect(cookie.plugins.size).toBe(0);
    const filler = await run('none', { stall: 'filler' }, { loadTimeoutMs: 20 });
    expect(filler.results.map(({ status }) => status)).toEqual(['pass', 'fail', 'pass', 'pass']);
    expect(filler.results[1].detail).toBe('cannot load filler 2 (a 1 x 1 PNG data: URL): timed out after 20 ms; 0 of 15 fillers loaded');
    expect(filler.handles.every((h) => h.destroyed)).toBe(true);
    expect(filler.plugins.size).toBe(0);
  });

  it('skips the growth when the tier is at its cap (a fifth entry in one page), the other three run', async () => {
    const r = await run('none', { full: true });
    expect(r.results.map(({ status }) => status)).toEqual(['pass', 'skip', 'pass', 'pass']);
    expect(r.results[1].detail).toBe(`the cookie's tier is at its cap (${MAX_LAYERS_PER_TIER} layers allocated, ${MAX_LAYERS_PER_TIER / 2 + 1} used) and cannot double: reload the page to run this check again`);
  });

  it("skips at the texture manager's cap, not at a copy of it (MAX_LAYERS_PER_TIER mocked to 128)", async () => {
    vi.resetModules();
    vi.doMock('../texture-manager', async (importOriginal) => ({ ...(await importOriginal<typeof import('../texture-manager')>()), MAX_LAYERS_PER_TIER: 128 }));
    try {
      const { checkSprite: checkAt128 } = await import('./lighting-sprite');
      stubs();
      const model = modelEngine('none', { full: 128 });
      const reporter = createTestReporter();
      await checkAt128(model.engine, reporter, [], F, () => {});
      const results = reporter.results();
      expect(results.map(({ status }) => status)).toEqual(['pass', 'skip', 'pass', 'pass']);
      expect(results[1].detail).toBe("the cookie's tier is at its cap (128 layers allocated, 65 used) and cannot double: reload the page to run this check again");
    } finally {
      vi.doUnmock('../texture-manager');
      vi.resetModules();
    }
  });

  it("under the real cap a tier at 128 layers (65 used: a fourth entry) grows to 256: a copy of the cap below the manager's would skip it", async () => {
    const r = await run('none', { full: 128 });
    expect(r.results.map(({ status }) => status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(r.results[1].detail).toMatch(/^128 -> 256 layers \(64 fillers, layers 65-128\)/);
  });

  it("fails the cookie check when the floor is not the tab's: another light reaches the sub-scene (the verdicts, judged on the measured floor, pass)", async () => {
    stubs();
    const model = modelEngine('none');
    const reporter = createTestReporter();
    await checkSprite(model.engine, reporter, [], [0, 0, 0], () => {});
    const results = reporter.results();
    expect(results.map(({ status }) => status)).toEqual(['fail', 'pass', 'pass', 'pass']);
    expect(results[0].detail).toContain("mix 0° 16/16; the floor reads 0.185, 0.170, 0.295, not the tab's 0.000, 0.000, 0.000: another light reaches the sub-scene; 0 GPU errors");
  });

  it('the shadow points sit on opaque blocks of L, and the sub-scene is far from the tab', () => {
    // L at (8, 0), turned a quarter turn, range 4.
    for (const p of Object.values(SHADOW_POINTS)) {
      const [dx, dy] = [p[0] - 8, p[1]];
      const [u, v] = cookieUv([dy, -dx], 4);
      expect(cookieTexel(Math.floor(u * 4), Math.floor(v * 4))[3]).toBe(255);
      // blockAt, which gives spriteShadowVerdict U's block, agrees.
      expect(blockAt([8, 0], Math.PI / 2, 4, p)).toEqual([Math.floor(u * 4), Math.floor(v * 4)]);
    }
    expect(blockAt([8, 0], Math.PI / 2, 4, SHADOW_POINTS.U), "U's block, an inner one").toEqual([1, 2]);
    expect(SPRITE_SCENE[0] - 17.6 - 6 * Math.SQRT2).toBeGreaterThan(30);
  });
});
