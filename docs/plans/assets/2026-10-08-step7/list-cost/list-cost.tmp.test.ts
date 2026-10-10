// THROWAWAY (Task 8f3, G1), never committed: times deriveLightGroups of this
// branch (./light-groups) against master's pre-step-7 module (1d19575, copied
// verbatim to ./light-groups-master.tmp) on the same synthetic frames.
import { it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { deriveLightGroups as head } from './light-groups';
import { deriveLightGroups as master } from './light-groups-master.tmp';
import { orthographic } from '../camera';

const OUT = process.env.G1_OUT ?? '';
const N = Number(process.env.G1_N ?? 1000);        // timed calls per variant and size
const WARMUP = Number(process.env.G1_WARMUP ?? 300); // untimed calls per variant and size, interleaved too
const SIZES = [300, 1000, 10_000];
const RECEIVERS = 1000;

/** mulberry32, as light-groups.test.ts: a run replays. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniformly random permutation of 0..n-1 (Fisher-Yates). */
function permutation(n: number, rand: () => number): Uint32Array {
  const p = new Uint32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  return p;
}

/** The default camera at 16:9 (CameraAPI: 20 units tall at zoom 1, near -1, far 1000), at the origin. */
const VIEW = orthographic(-160 / 9, 160 / 9, -10, 10, -1, 1000);

/**
 * `lights` point lights (Light2D, add, mask 0xffff, range 2-8, no shadow) and
 * RECEIVERS lit quads (receivesLight, layer 0), all in view, scattered over the
 * slots; every light at a distinct z (-depth), unrelated to its slot and id;
 * the ids a permutation of the slots.
 */
function frame(lights: number, seed: number) {
  const n = lights + RECEIVERS;
  const rand = mulberry32(seed);
  const renderMeta = new Uint32Array(n * 2);
  const primParams = new Float32Array(n * 8);
  const bounds = new Float32Array(n * 4);
  const kind = permutation(n, rand);          // slot s holds a light iff kind[s] < lights
  const depthRank = permutation(lights, rand); // distinct z per light
  const entityIds = permutation(n, rand);
  let k = 0;
  for (let s = 0; s < n; s++) {
    bounds[s * 4] = (rand() * 2 - 1) * 16;
    bounds[s * 4 + 1] = (rand() * 2 - 1) * 9;
    if (kind[s] < lights) {
      renderMeta[s * 2 + 1] = (6 | (0xffff << 16)) >>> 0;
      const range = 2 + 6 * rand();
      primParams.set([rand(), rand(), rand(), range, 0, 0, 1, 0], s * 8);
      bounds[s * 4 + 2] = -(depthRank[k++] + 1) * (900 / lights);
      bounds[s * 4 + 3] = range;
    } else {
      renderMeta[s * 2 + 1] = 1 << 10;
      bounds[s * 4 + 3] = 0.71;
    }
  }
  return { entityCount: n, renderMeta, primParams, bounds, cameraViewProjection: VIEW, entityIds };
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a: number[], q: number): number => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))];

it('G1: deriveLightGroups, HEAD against master (1d19575)', () => {
  const results: object[] = [];
  let sink = 0;
  for (const lights of SIZES) {
    const f = frame(lights, 0x5eed + lights);
    // Sanity: the same frame for both; HEAD lists every light, the groups agree.
    const h0 = head(f);
    const m0 = master(f);
    expect(h0.lightOrder.length).toBe(lights);
    expect(new Set(h0.lightIds).size).toBe(lights);
    expect(h0.groups).toEqual(m0.groups);
    expect(h0.sdfSets).toEqual(m0.sdfSets);
    expect(h0.lightMasks).toEqual(m0.lightMasks);
    expect(h0.groups).toEqual([{ layers: 1, sdfSet: -1 }]);
    const th: number[] = [];
    const tm: number[] = [];
    for (let i = 0; i < WARMUP + N; i++) {
      // Interleaved, and the order flips every iteration.
      const headFirst = (i & 1) === 0;
      for (let pass = 0; pass < 2; pass++) {
        const useHead = (pass === 0) === headFirst;
        const t0 = performance.now();
        const g = useHead ? head(f) : master(f);
        const dt = performance.now() - t0;
        sink += g.groups.length;
        if (i >= WARMUP) (useHead ? th : tm).push(dt);
      }
    }
    const paired = th.map((t, i) => t - tm[i]);
    results.push({
      lights, receivers: RECEIVERS, calls: N, warmup: WARMUP,
      headMedianMs: median(th), masterMedianMs: median(tm), deltaMs: median(th) - median(tm),
      pairedDeltaMedianMs: median(paired),
      headP10Ms: pct(th, 0.1), headP90Ms: pct(th, 0.9), masterP10Ms: pct(tm, 0.1), masterP90Ms: pct(tm, 0.9),
    });
  }
  const report = { node: process.version, arch: process.arch, sink, results };
  console.log(JSON.stringify(report, null, 2));
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
}, 600_000);
