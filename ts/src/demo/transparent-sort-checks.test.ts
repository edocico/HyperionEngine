import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { verifySortReadback, regionClass, sameIdOrder, readSortFrame } from './transparent-sort-checks';
import type { TransparentSortReadback } from '../render/transparent-sort-probe';
import { orthographic, extractFrustumPlanes, isSphereInFrustum } from '../camera';
import { CAP, PASSES, RADIX, DIAG_WORDS } from '../render/passes/transparent-sort-constants';

/** Looking down -Z at [-10, 10] x [-10, 10]; z from -1000 to 1 is in view. */
const VP = orthographic(-10, 10, -10, 10, -1, 1000);
const TIER1 = 1 << 16;
const OVERFLOW = 0x80000000;

interface Row { id: number; x: number; y: number; z: number; r: number; type: number; transparent: boolean; tex: number }

/**
 * Slot = index. Every type 0-5 on screen, untextured and textured (tier 1 or
 * overflow): all 12 gather regions. Ties at equal z (one at -0, which sorts
 * with +0), ids with bits in every byte, and three rows the sort must leave
 * out: an opaque quad, a transparent Light2D, a transparent quad off screen.
 */
const SCENE: Row[] = [
  ...[0, 1, 2, 3, 4, 5].flatMap((type): Row[] => [
    { id: 10 + type, x: -8 + type * 3, y: 2, z: -0.5 * type, r: 1, type, transparent: true, tex: 0 },
    { id: 0xfffff - type, x: -8 + type * 3, y: -2, z: -1, r: 1, type, transparent: true, tex: type % 2 === 0 ? TIER1 : OVERFLOW },
  ]),
  { id: 0x12345, x: 0, y: 6, z: 0, r: 0.5, type: 0, transparent: true, tex: 0 },
  { id: 0x00345, x: 1, y: 6, z: -0, r: 0.5, type: 0, transparent: true, tex: 0 },
  { id: 0x02345, x: 2, y: 6, z: 0, r: 0.5, type: 4, transparent: true, tex: 0 },
  { id: 500, x: 0, y: 0, z: 0, r: 1, type: 0, transparent: false, tex: 0 },
  { id: 501, x: 0, y: 0, z: 0, r: 3, type: 6, transparent: true, tex: 0 },
  { id: 502, x: 50, y: 0, z: 0, r: 1, type: 0, transparent: true, tex: 0 },
];
const slotOf = (id: number): number => SCENE.findIndex((row) => row.id === id);

/** §5.1 written out again, independently of the module under test: -0 → +0, negatives flipped whole, positives with the top bit set. */
function zKey(z: number): number {
  let bits = new Uint32Array(new Float32Array([z]).buffer)[0];
  if (bits === 0x80000000) bits = 0;
  return (bits & 0x80000000) !== 0 ? ~bits >>> 0 : (bits | 0x80000000) >>> 0;
}

/**
 * The answer a correct GPU gives for `rows`: the gather's set (transparent,
 * type 0-5, sphere in the frustum) region by region, its keys, the order,
 * digitBase — computed here without the module under test. `drop` leaves
 * slots out of the set, `force` puts slots in whatever they are.
 */
function makeReadback(rows: Row[], build: { drop?: number[]; force?: number[]; stamp?: number } = {}): TransparentSortReadback {
  const count = rows.length;
  const bounds = new Float32Array(count * 4);
  const entityIds = new Uint32Array(count);
  const renderMeta = new Uint32Array(count * 2);
  const texIndices = new Uint32Array(count);
  rows.forEach((row, s) => {
    bounds.set([row.x, row.y, row.z, row.r], s * 4);
    entityIds[s] = row.id;
    renderMeta[s * 2 + 1] = row.type | (row.transparent ? 0x100 : 0);
    texIndices[s] = row.tex;
  });
  const planes = extractFrustumPlanes(VP);
  const region = (s: number): number => rows[s].type * 2 + (rows[s].tex !== 0 ? 1 : 0);
  const culled = (s: number): boolean =>
    rows[s].transparent && rows[s].type <= 5 && isSphereInFrustum(planes, rows[s].x, rows[s].y, rows[s].z, rows[s].r);
  const slots = rows
    .map((_, s) => s)
    .filter((s) => (build.force ?? []).includes(s) || (culled(s) && !(build.drop ?? []).includes(s)))
    .sort((a, b) => region(a) - region(b) || a - b);
  const lo = (s: number): number => rows[s].id;
  const hi = (s: number): number => zKey(rows[s].z);
  const order = [...slots].sort((a, b) => hi(a) - hi(b) || lo(a) - lo(b));
  const digitBase = new Uint32Array(PASSES * RADIX);
  for (let p = 0; p < PASSES; p++) {
    const hist = new Array<number>(RADIX).fill(0);
    for (const s of slots) hist[((p < 3 ? lo(s) : hi(s)) >>> (8 * (p < 3 ? p : p - 3))) & 0xff]++;
    let sum = 0;
    for (let d = 0; d < RADIX; d++) {
      digitBase[p * RADIX + d] = sum;
      sum += hist[d];
    }
  }
  const transparentCount = rows.filter((row) => row.transparent).length;
  return {
    frame: {
      tickCount: 1, stamp: build.stamp ?? 7, entityCount: count, transparentCount,
      idsGeneration: 1, idsUploaded: true, usedScatter: false,
      viewProjection: VP, bounds, entityIds, renderMeta, texIndices,
    },
    n: slots.length,
    raw: slots.length,
    limit: Math.min(transparentCount, CAP),
    overflow: false,
    diag: new Uint32Array(DIAG_WORDS),
    gathered: { lo: Uint32Array.from(slots, lo), hi: Uint32Array.from(slots, hi), vals: Uint32Array.from(slots) },
    digitBase,
    order: Uint32Array.from(order),
  };
}

describe('verifySortReadback', () => {
  it('passes a correct answer, as an exact set with all 12 regions', () => {
    const r = makeReadback(SCENE);
    expect(r.n).toBe(15);
    expect(verifySortReadback(r, { exactSet: true, requireAllRegions: true })).toEqual([]);
  });

  it('reports a malformed answer instead of reading past its arrays', () => {
    const r = makeReadback(SCENE);
    r.gathered.vals = r.gathered.vals.slice(1);
    expect(verifySortReadback(r)).toEqual([expect.stringMatching(/^readback shape: n 15, lo 15, hi 15, vals 14/)]);
  });

  it('(a) a slot gathered twice, and an order that is not a permutation', () => {
    const r = makeReadback(SCENE);
    r.gathered.vals[1] = r.gathered.vals[0];
    r.gathered.lo[1] = r.gathered.lo[0];
    r.gathered.hi[1] = r.gathered.hi[0];
    const failures = verifySortReadback(r);
    expect(failures).toContainEqual(expect.stringMatching(/^\(a\) gathered set: slot \d+ gathered twice/));
    expect(failures).toContainEqual('(a) order is not a permutation of the gathered slots');
  });

  it('(a) slots that are no transparent primitive of type 0-5: an opaque quad, a transparent Light2D', () => {
    const failures = verifySortReadback(makeReadback(SCENE, { force: [slotOf(500), slotOf(501)] }));
    expect(failures).toEqual([expect.stringMatching(
      /^\(a\) gathered set: slot 15 is not a transparent primitive of type 0-5 \(meta1 0x0\); slot 16 is not a transparent primitive of type 0-5 \(meta1 0x106\)$/,
    )]);
  });

  it('(b) a gathered slot outside the enlarged frustum', () => {
    const failures = verifySortReadback(makeReadback(SCENE, { force: [slotOf(502)] }));
    expect(failures).toEqual(['(b) gathered but outside the enlarged frustum: slot 17 (id 502)']);
  });

  it('(c) an on-screen transparent row the gather left out', () => {
    const failures = verifySortReadback(makeReadback(SCENE, { drop: [3] }));
    expect(failures).toEqual([`(c) on screen (reduced frustum) but not gathered: slot 3 (id ${0xfffff - 1})`]);
  });

  it('(c) as an exact set, a row inside the margin must be gathered too', () => {
    // r = 1 at x = 11.005: out of the true test (distance -1.005 < -1), in the
    // enlarged one (-1.011), out of the reduced one (-0.989).
    const rows: Row[] = [...SCENE, { id: 600, x: 11.005, y: 0, z: 0, r: 1, type: 0, transparent: true, tex: 0 }];
    const r = makeReadback(rows);
    expect(verifySortReadback(r)).toEqual([]);
    expect(verifySortReadback(r, { exactSet: true })).toEqual([
      `(c) in view (enlarged frustum, exact set) but not gathered: slot ${SCENE.length} (id 600)`,
    ]);
  });

  it('(d) overflow, n != raw, raw past the count, a wrong limit, a diag bit', () => {
    const r = makeReadback(SCENE);
    r.overflow = true;
    r.raw = r.n + 5;
    r.limit = 3;
    r.diag[0] = 2;
    const failures = verifySortReadback(r);
    expect(failures).toContainEqual('(d) overflow: raw 20 > limit 3');
    expect(failures).toContainEqual('(d) n 15 != raw 20');
    expect(failures).toContainEqual('(d) raw 20 > transparentCount 17');
    expect(failures).toContainEqual('(d) limit 3 != min(transparentCount, CAP) 17');
    expect(failures).toContainEqual('(d) diag: diag[0] = 0x2');
  });

  it('(e) a stale id and a wrong z key, element by element', () => {
    const r = makeReadback(SCENE);
    r.gathered.lo[0] ^= 1;
    r.gathered.hi[2] ^= 1;
    expect(verifySortReadback(r)).toEqual([expect.stringMatching(
      /^\(e\) keys: lo\[0\] = \d+, slot \d+ has id \d+; hi\[2\] = 0x[0-9a-f]+, slot \d+ has zKey 0x[0-9a-f]+$/,
    )]);
  });

  it('(f) an order that is not the oracle', () => {
    const r = makeReadback(SCENE);
    [r.order[0], r.order[1]] = [r.order[1], r.order[0]];
    expect(verifySortReadback(r)).toEqual([expect.stringMatching(/^\(f\) order differs from the oracle at 0: /)]);
  });

  it('(f) a digitBase row that is not the exclusive scan of its digit', () => {
    const r = makeReadback(SCENE);
    r.digitBase[3 * RADIX + 200] += 1;
    expect(verifySortReadback(r)).toEqual([expect.stringMatching(/^\(f\) digitBase of pass 3, digit 200: /)]);
  });

  it('(i) an empty region class', () => {
    const rows = SCENE.filter((row) => !(row.type === 3 && row.tex !== 0));
    expect(verifySortReadback(makeReadback(rows), { exactSet: true, requireAllRegions: true }))
      .toEqual(['(i) empty region classes: type 3 textured']);
  });

  it('the tie at equal z goes to the higher id, and -0 ties with +0', () => {
    const r = makeReadback(SCENE);
    const ids = Array.from(r.order, (s) => r.frame.entityIds[s]);
    expect(ids.indexOf(0x00345)).toBeLessThan(ids.indexOf(0x02345));
    expect(ids.indexOf(0x02345)).toBeLessThan(ids.indexOf(0x12345));
  });
});

describe('regionClass', () => {
  it('is type × 2 + (tier > 0 or overflow), with the cull clamp to Light2D', () => {
    expect(regionClass(0x100 | 3, 0)).toBe(6);
    expect(regionClass(0x100 | 3, TIER1 | 5)).toBe(7);
    expect(regionClass(5, OVERFLOW)).toBe(11);
    expect(regionClass(0x100, 42)).toBe(0); // layer 42 of tier 0: the tier-0 region
    expect(regionClass(9, 0)).toBe(12); // drawn as Light2D (6), outside the gather
    expect(regionClass(0xabcd0000 | 0x100 | 4, 0)).toBe(8); // light layers and flags above the type byte do not count
  });
});

describe('sameIdOrder', () => {
  it('compares the sequence of external ids, not of slots', () => {
    const a = makeReadback(SCENE);
    expect(sameIdOrder(a, makeReadback([...SCENE].reverse(), { stamp: 8 }))).toBe(true);
    const swapped = makeReadback(SCENE);
    [swapped.order[0], swapped.order[1]] = [swapped.order[1], swapped.order[0]];
    expect(sameIdOrder(a, swapped)).toBe(false);
    expect(sameIdOrder(a, makeReadback(SCENE, { drop: [0] }))).toBe(false);
  });
});

describe('readSortFrame', () => {
  it('retries past frames without transparents and frames that do not hold the scene yet', async () => {
    const early = makeReadback(SCENE.slice(0, 3));
    const good = makeReadback(SCENE);
    const read = vi.fn<() => Promise<TransparentSortReadback>>()
      .mockRejectedValueOnce(new Error('no transparent entities this frame: the sort did not run'))
      .mockResolvedValueOnce(early)
      .mockResolvedValueOnce(good);
    await expect(readSortFrame(read, (r) => r.frame.entityCount === SCENE.length, 3000)).resolves.toBe(good);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('throws any other rejection at once', async () => {
    const read = vi.fn(async (): Promise<TransparentSortReadback> => {
      throw new Error('The transparent-sort gather never ran this frame');
    });
    await expect(readSortFrame(read, () => true, 3000)).rejects.toThrow(/gather never ran/);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('gives up after the timeout, saying what it saw last', async () => {
    let t = 0;
    const read = vi.fn(async (): Promise<TransparentSortReadback> => {
      throw new Error('no transparent entities this frame');
    });
    await expect(readSortFrame(read, () => true, 100, () => (t += 30)))
      .rejects.toThrow(/no served frame held the scene within 100 ms \(last: no transparent entities this frame\)/);
  });
});

describe('sort-test-128.png (scripts/gen-sort-test-png.mjs)', () => {
  it('is a 128 × 128 RGBA PNG with four semi-transparent coloured quadrants', () => {
    const png = readFileSync(new URL('../../public/textures/sort-test-128.png', import.meta.url));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(128); // width
    expect(png.readUInt32BE(20)).toBe(128); // height
    expect(png[24]).toBe(8); // bits per channel
    expect(png[25]).toBe(6); // RGBA
    // The generator writes one IDAT right after IHDR (8 + 25 bytes in).
    const idatLength = png.readUInt32BE(33);
    expect(png.toString('ascii', 37, 41)).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    const stride = 1 + 128 * 4;
    const px = (x: number, y: number): number[] => [...raw.subarray(y * stride + 1 + x * 4, y * stride + 5 + x * 4)];
    expect(px(10, 10)).toEqual([230, 60, 60, 160]);
    expect(px(100, 10)).toEqual([60, 200, 90, 160]);
    expect(px(10, 100)).toEqual([60, 110, 230, 160]);
    expect(px(100, 100)).toEqual([240, 200, 50, 160]);
  });
});
