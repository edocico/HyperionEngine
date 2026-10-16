// ts/src/demo/lighting-sprite.ts — the Lighting tab's sprite-light checks
// (round step 8) on a sub-scene at SPRITE_SCENE: a floor, a wall W and two 2D
// sprite lights with a procedural cookie, K (scaled 3 x 0.5: only the sign of
// a scale counts, which two mirrored reads check; a third switches K to mix)
// and L (shadowed, a quarter turn). `floor` is ambient + the tab's global
// light. Mode A loads no texture: four skips, nothing spawned. Every load is
// bounded (LOAD_TIMEOUT_MS). Four fresh ids: later tabs' ids are 4 higher.
//
// The cookie: 64 x 64, 4 x 4 blocks of 16 px, block (i, j) = (85 i, 85 j,
// 255, A) from the image's left and top, A = 255 but (2, 1) 64 and (2, 2)
// 128. A PNG data: URL in stored deflate, the same bytes on every run.
import type { Hyperion } from '../hyperion';
import type { EntityHandle, LightOptions } from '../entity-handle';
import type { TestReporter } from './types';
import { maxChannelDiff, over, straight, type Rgb } from './blend-expect';
import { lightTexelsPerUnit } from './lighting-mix';
import { halfResolution } from '../render/passes/occluder-seed-stage';
import { unpackTextureIndex } from '../texture-manager';
import {
  pixelCheck, fmt, fitView, frames, viewBounds, reportTextureLoadFailure, gpuErrorWitness, type Rgba,
} from './probe-checks';

/** A point in world units, from SPRITE_SCENE. */
type Xy = readonly [number, number];

/** Past the tab's lights (x ≈ 30) and the step-6/7 sub-scenes at (0, ±200). */
export const SPRITE_SCENE: [number, number] = [200, 0];
/** The tab's own framing (zoom 1 at 16:9). */
const SUB_HALF_WIDTH = 17.6;
/** Both sprite lights: white, `add`. */
export const ENERGY = 2;
/** K in the cookie check: centre and range (half-side). */
const K_AT: Xy = [-8, 0];
const K_RANGE = 4;
/** K's angles in the cookie check; the growth check starts at the last. */
export const COOKIE_THETAS = [0, Math.PI / 2, Math.PI / 6];
/** K's mirrored reads at θ = 0 (spriteAxes): `expect` is the block each unmirrored centre shows. */
export const MIRRORS: ReadonlyArray<{ label: string; scale: [number, number]; expect: (i: number, j: number) => [number, number] }> = [
  { label: 'y-mirrored 0°', scale: [3, -0.5], expect: (i, j) => [i, 3 - j] },
  { label: 'x-mirrored 0°', scale: [-3, 0.5], expect: (i, j) => [3 - i, j] },
];
/** L, the shadowed sprite light (its +x up the screen). */
const L_AT: Xy = [8, 0];
const L_RANGE = 4;
const L_THETA = Math.PI / 2;
/** W, the wall between L and S. */
const W_AT: Xy = [10, 0];
const W_SIZE: Xy = [0.5, 3];
/** S behind W; S' (S mirrored through L) and U (between L and W) in the open. */
export const SHADOW_POINTS = { S: [11.5, 0.5] as Xy, S2: [4.5, -0.5] as Xy, U: [9.25, -0.5] as Xy };
/** No light of the sub-scene reaches it: every check's floor read. */
const FLOOR_AT: Xy = [0, 8];
/** The pop check: K's range, the sliver's depth, the angles of a quarter turn. */
export const POP_RANGE = 6;
export const POKE_DEPTH = 1;
export const POP_THETAS = [0, 15, 30, 45, 60, 75].map((d) => (d * Math.PI) / 180);
/** Per-channel tolerance: far above fp16 rounding, far below the 0.5 between two block codes. */
export const TOL = 0.03;
/** MAX_LAYERS_PER_TIER (texture-manager.ts). */
const MAX_LAYERS = 256;
/** A load's bound: loadTexture has none, and a stalled load would hang the tab. */
export const LOAD_TIMEOUT_MS = 10000;

// ── The cookie ──────────────────────────────────────────────────────────────

/** TIER_SIZES[0]: the resize keeps every texel. */
export const COOKIE_SIZE = 64;
export const BLOCKS = 4;

/** Block (i, j)'s RGBA8: column i from the left, row j from the top. */
export function cookieTexel(i: number, j: number): [number, number, number, number] {
  const a = i === 2 && j === 1 ? 64 : i === 2 && j === 2 ? 128 : 255;
  return [85 * i, 85 * j, 255, a];
}

/** RGBA8, row by row from the top. */
export function cookiePixels(): Uint8Array {
  const block = COOKIE_SIZE / BLOCKS;
  const px = new Uint8Array(COOKIE_SIZE * COOKIE_SIZE * 4);
  for (let y = 0; y < COOKIE_SIZE; y++) {
    for (let x = 0; x < COOKIE_SIZE; x++) px.set(cookieTexel(Math.floor(x / block), Math.floor(y / block)), (y * COOKIE_SIZE + x) * 4);
  }
  return px;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32, the PNG chunks' checksum. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** RGBA8 as a PNG: filter 0, STORED deflate blocks, so the bytes depend on the pixels alone. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = 1 + width * 4;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  const z: number[] = [0x78, 0x01];
  for (let off = 0; ; off += 65535) {
    const len = Math.min(65535, raw.length - off);
    const last = off + len >= raw.length;
    z.push(last ? 1 : 0, len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff);
    for (let k = 0; k < len; k++) z.push(raw[off + k]);
    if (last) break;
  }
  const be32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  z.push(...be32(adler32(raw)));
  const chunk = (type: string, data: readonly number[]): number[] => {
    const body = new Uint8Array([...type].map((c) => c.charCodeAt(0)).concat(data));
    return [...be32(data.length), ...body, ...be32(crc32(body))];
  };
  const header = [...be32(width), ...be32(height), 8, 6, 0, 0, 0];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', header), ...chunk('IDAT', z), ...chunk('IEND', [])]);
}

/** A PNG as a data: URL (base64 in chunks: no argument-count limit). */
export function pngDataUrl(png: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < png.length; i += 0x2000) binary += String.fromCharCode(...png.subarray(i, i + 0x2000));
  return `data:image/png;base64,${btoa(binary)}`;
}

/** The same string on every call: a cache hit after the first load. */
export const COOKIE_URL = pngDataUrl(encodePng(COOKIE_SIZE, COOKIE_SIZE, cookiePixels()));
/** Named by a load failure instead of the 22 KB URL. */
const COOKIE_LABEL = 'the procedural cookie (a 64 x 64 PNG data: URL)';

/** A 1 x 1 PNG encoding `n`: one URL per layer it takes. */
export function fillerUrl(n: number): string {
  return pngDataUrl(encodePng(1, 1, new Uint8Array([n & 0xff, (n >>> 8) & 0xff, 90, 255])));
}

// ── Geometry ────────────────────────────────────────────────────────────────

/**
 * The cookie's texture uv of `local`, in the light's frame: the textured
 * quad's uv (quad_vs: position + 0.5), v turned over at the lookup as
 * sampleTierOrWhite turns every tier image (round step 8): the image upright,
 * its first row along local +y.
 */
export function cookieUv(local: Xy, range: number): [number, number] {
  return [local[0] / (2 * range) + 0.5, 0.5 - local[1] / (2 * range)];
}

/** The world point of cookie coordinates `uv` (texture uv, as cookieUv gives them) on a sprite light. */
export function cookiePoint(centre: Xy, theta: number, range: number, uv: Xy): [number, number] {
  const lx = (uv[0] - 0.5) * 2 * range;
  const ly = (0.5 - uv[1]) * 2 * range;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [centre[0] + lx * c - ly * s, centre[1] + lx * s + ly * c];
}

/** The world centres of the 16 blocks, row by row (j, then i). */
export function blockCentres(centre: Xy, theta: number, range: number): Array<{ i: number; j: number; at: [number, number] }> {
  const out: Array<{ i: number; j: number; at: [number, number] }> = [];
  for (let j = 0; j < BLOCKS; j++) {
    for (let i = 0; i < BLOCKS; i++) out.push({ i, j, at: cookiePoint(centre, theta, range, [(i + 0.5) / BLOCKS, (j + 0.5) / BLOCKS]) });
  }
  return out;
}

/** What a white `add` sprite light adds on block (i, j): energy × rgb × a. */
export function blockLight(i: number, j: number, energy: number): Rgb {
  const [r, g, b, a] = cookieTexel(i, j).map((v) => v / 255);
  return [energy * r * a, energy * g * a, energy * b * a];
}

/** The block a read shows: alpha from blue, then i and j from red and green; null if unlit. */
export function decodeBlock(read: readonly number[], floor: readonly number[], energy: number): { i: number; j: number; a: number } | null {
  const a = (read[2] - floor[2]) / energy;
  if (a < 0.05) return null;
  return { i: Math.round((3 * (read[0] - floor[0])) / (energy * a)), j: Math.round((3 * (read[1] - floor[1])) / (energy * a)), a };
}

/** The turned square's y-interval on the line x = `x`, or null. */
export function crossSection(centre: Xy, range: number, theta: number, x: number): [number, number] | null {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const dx = x - centre[0];
  let lo = -Infinity;
  let hi = Infinity;
  // |a + b·dy| <= range, local x: (a, b) = (dx·c, s); local y: (−dx·s, c).
  for (const [a, b] of [[dx * c, s], [-dx * s, c]]) {
    if (Math.abs(b) < 1e-12) {
      if (Math.abs(a) > range) return null;
      continue;
    }
    const e1 = (-range - a) / b;
    const e2 = (range - a) / b;
    lo = Math.max(lo, Math.min(e1, e2));
    hi = Math.min(hi, Math.max(e1, e2));
  }
  return lo <= hi ? [centre[1] + lo, centre[1] + hi] : null;
}

/** Edge at x = 0, view on the right: the square, `d` outside, reaches `depth` in; poke in the sliver, control past its tip. */
export function pokeGeometry(theta: number, range: number, depth: number): { d: number; poke: [number, number]; control: [number, number]; halfWidth: number } {
  const d = range * (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta))) - depth;
  const section = crossSection([-d, 0], range, theta, depth / 2);
  if (!section) throw new Error(`pokeGeometry: the square misses x = ${depth / 2} at ${theta} rad`);
  const ymid = (section[0] + section[1]) / 2;
  return { d, poke: [depth / 2, ymid], control: [depth + 0.5, ymid], halfWidth: (section[1] - section[0]) / 2 };
}

// ── Verdicts ────────────────────────────────────────────────────────────────

/** The values read, then each cause found, joined by `; `. */
interface Verdict {
  ok: boolean;
  detail: string;
}

const deg = (theta: number): string => `${Math.round((theta * 180) / Math.PI)}°`;
const plus = (a: readonly number[], b: readonly number[]): Rgb => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** The square's symmetries and what each says about the mapping. */
const SYMMETRIES: Array<{ map: (i: number, j: number) => [number, number]; cause: string }> = [
  { map: (i, j) => [3 - i, j], cause: 'every block read as its mirror left to right: u is flipped' },
  { map: (i, j) => [i, 3 - j], cause: 'every block read as its mirror top to bottom: v is flipped (the uv convention): light-accum.wgsl misses the flip of sampleTierOrWhite before the cookie sample, or its out.uv is not the quad uv' },
  { map: (i, j) => [3 - i, 3 - j], cause: 'every block read half a turn off' },
  { map: (i, j) => [j, i], cause: 'every block read transposed: u and v are swapped' },
  { map: (i, j) => [3 - j, 3 - i], cause: 'every block read transposed across the other diagonal' },
  { map: (i, j) => [j, 3 - i], cause: 'every block read a quarter turn off: the square or its uv does not turn with the light' },
  { map: (i, j) => [3 - j, i], cause: 'every block read a quarter turn off: the square or its uv does not turn with the light' },
];

/** blockCentres' order. */
const BLOCK_ORDER = Array.from({ length: BLOCKS * BLOCKS }, (_, n) => ({ i: n % BLOCKS, j: Math.floor(n / BLOCKS) }));

/** K at `theta`: the 16 block centres (blockCentres' order) and the floor, one frame. */
export interface CookieRead {
  theta: number;
  values: Rgba[];
  floor: Rgba;
  /** The name in the detail; the angle by default. */
  label?: string;
  /** The block each centre shows (MIRRORS); (i, j) by default. */
  expect?: (i: number, j: number) => [number, number];
}

const same = (i: number, j: number): [number, number] => [i, j];

/** floor + blockLight of the expected block at every centre; a failure names the symmetry, a missing mirror, the alpha or the misreads. NaN-safe. */
export function cookieVerdict(reads: readonly CookieRead[], energy: number): Verdict {
  const parts: string[] = [];
  const causes: string[] = [];
  let ok = true;
  for (const r of reads) {
    const want = r.expect ?? same;
    const wrong = BLOCK_ORDER.filter(({ i, j }, n) => !(maxChannelDiff(r.values[n], plus(r.floor, blockLight(...want(i, j), energy))) <= TOL));
    const name = r.label ?? deg(r.theta);
    parts.push(`${name} ${BLOCK_ORDER.length - wrong.length}/${BLOCK_ORDER.length}`);
    if (wrong.length === 0) continue;
    ok = false;
    const decoded = BLOCK_ORDER.map(({ i, j }, n) => ({ i, j, got: decodeBlock(r.values[n], r.floor, energy) }));
    const shows = (d: (typeof decoded)[number], [ei, ej]: [number, number]): boolean => d.got !== null && d.got.i === ei && d.got.j === ej;
    const at = `at ${name}`;
    if (decoded.every((d) => d.got === null)) {
      causes.push(`${at}: nothing lit at any block (the light is culled, untextured, or not drawn)`);
      continue;
    }
    if (r.expect) {
      const plain = decoded.every((d) => shows(d, [d.i, d.j]));
      if (plain || decoded.every((d) => shows(d, [3 - d.i, 3 - d.j]))) {
        causes.push(`${at}: every block read ${plain ? 'unmirrored' : 'half a turn off, not mirrored'}: the side axis does not follow the transform's determinant (spriteAxes)`);
        continue;
      }
    }
    const symmetry = SYMMETRIES.find(({ map }) => decoded.every((d) => shows(d, map(...want(d.i, d.j)))));
    if (symmetry) {
      causes.push(`${at}: ${symmetry.cause}`);
      continue;
    }
    const sameBlocks = decoded.every((d) => shows(d, want(d.i, d.j)));
    const translucentOnly = wrong.every(({ i, j }) => {
      const [wi, wj] = want(i, j);
      return wi === 2 && (wj === 1 || wj === 2);
    });
    if (sameBlocks && translucentOnly) {
      causes.push(`${at}: only the translucent blocks (2,1) and (2,2) are off: the cookie's alpha is not the weight`);
      continue;
    }
    const misread = decoded.filter((d) => !shows(d, want(d.i, d.j))).slice(0, 4)
      .map((d) => `(${d.i},${d.j}) read ${d.got ? `(${d.got.i},${d.got.j}) a ${d.got.a.toFixed(2)}` : 'unlit'}`);
    causes.push(`${at}: ${wrong.length} blocks off${misread.length > 0 ? `: ${misread.join(', ')}` : ' within their codes: a value off by more than TOL (or not finite)'}`);
  }
  return { ok, detail: [`blocks ${parts.join(', ')}`, ...causes].join('; ') };
}

/** A white mix sprite light over `floor` on block (i, j): floor·(1 − a) + energy × rgb·a. */
export function blockMix(floor: readonly number[], i: number, j: number, energy: number): Rgb {
  const [r, g, b, a] = cookieTexel(i, j).map((v) => v / 255);
  return over([floor[0], floor[1], floor[2]], straight([energy * r, energy * g, energy * b], a));
}

/** K in mix, unturned: blockMix at every centre; names a mix added like add or a weight blind to alpha. NaN-safe. */
export function mixVerdict(r: CookieRead, energy: number): Verdict {
  const near = (n: number, want: readonly number[]): boolean => maxChannelDiff(r.values[n], want) <= TOL;
  const off = BLOCK_ORDER.filter(({ i, j }, n) => !near(n, blockMix(r.floor, i, j, energy)));
  const detail = `mix ${r.label ?? deg(r.theta)} ${BLOCK_ORDER.length - off.length}/${BLOCK_ORDER.length}`;
  if (off.length === 0) return { ok: true, detail };
  const target = (i: number, j: number): Rgb => {
    const [cr, cg, cb] = cookieTexel(i, j).map((v) => (energy * v) / 255);
    return [cr, cg, cb];
  };
  const cause = BLOCK_ORDER.every(({ i, j }, n) => near(n, plus(r.floor, blockLight(i, j, energy))))
    ? 'mix added like add (floor + target × alpha)'
    : BLOCK_ORDER.every(({ i, j }, n) => near(n, target(i, j)))
      ? "the mix weight ignores the cookie's alpha (the target at every block)"
      : `${off.length} blocks off: ${off.slice(0, 4).map(({ i, j }) => `(${i},${j})`).join(', ')}`;
  return { ok: false, detail: `${detail}; ${cause}` };
}

/** The cookie's array (primary or overflow), from engine.debug.textureTiers. */
export interface TierCount {
  used: number;
  allocated: number;
}

/** What 'Cookie tier grows while the light draws' read. */
export interface GrowthReads {
  before: TierCount;
  after: TierCount;
  fillerLayers: number[];
  /** The first frame after the growth. */
  first: CookieRead;
  /** After a turn. */
  turned: CookieRead;
  /** That frame at `first`'s centres: a frozen buffer still shows `first`. */
  turnedAtFirst: CookieRead;
  /** Uncaptured GPU errors from the first filler on; null without a witness. */
  errors: number | null;
  errorMessages: readonly string[];
}

/** The tier doubled, the fillers took the next layers, the cookie drew right after the growth and after a turn, no GPU error. */
export function growthVerdict(r: GrowthReads, energy: number): Verdict {
  const causes: string[] = [];
  if (r.after.allocated !== 2 * r.before.allocated) causes.push(`the tier did not double: ${r.before.allocated} -> ${r.after.allocated} layers`);
  const want = Array.from({ length: r.fillerLayers.length }, (_, k) => r.before.used + k);
  if (r.fillerLayers.join() !== want.join()) causes.push(`the fillers took layers ${r.fillerLayers.join(',')}, not ${want[0]}-${want.at(-1)}`);
  const first = cookieVerdict([r.first], energy);
  if (!first.ok) causes.push(`first frame after the growth: ${first.detail}`);
  const turned = cookieVerdict([r.turned], energy);
  if (!turned.ok) {
    const frozen = cookieVerdict([r.turnedAtFirst], energy).ok;
    causes.push(frozen
      ? `after the turn the light buffer still shows ${deg(r.first.theta)}: the frames since the growth did not run (a stale texture group?)`
      : `after the turn: ${turned.detail}`);
  }
  if (r.errors === null) causes.push('no GPU error witness: no main-thread device');
  else if (r.errors > 0) causes.push(`${r.errors} GPU errors (${r.errorMessages.length > 0 ? r.errorMessages.slice(0, 2).join(' | ') : 'messages not kept: cap reached'})`);
  const counts = `${r.before.allocated} -> ${r.after.allocated} layers (${r.fillerLayers.length} fillers, layers ${r.fillerLayers[0]}-${r.fillerLayers.at(-1)}), `
    + `cookie ${deg(r.first.theta)} and ${deg(r.turned.theta)}, ${r.errors ?? '?'} GPU errors`;
  return { ok: causes.length === 0, detail: [counts, ...causes].join('; ') };
}

/** One angle: the reads, and whether the light list held K. */
export interface PopRead {
  theta: number;
  poke: Rgba;
  control: Rgba;
  floor: Rgba;
  listed: boolean;
}

/** The sliver lit (half K's blue at least), the control at the floor. */
export function popVerdict(reads: readonly PopRead[], energy: number): Verdict {
  const causes: string[] = [];
  const rows = reads.map((r) => {
    const lit = r.poke[2] - r.floor[2] >= energy / 2;
    const controlDark = maxChannelDiff(r.control, r.floor) <= TOL;
    if (!lit) {
      causes.push(r.listed
        ? `${deg(r.theta)}: listed but the sliver is dark (the square does not turn with the light, or is smaller than range)`
        : `${deg(r.theta)}: K is not in the light list (its culling radius is under range·√2)`);
    }
    if (!controlDark) causes.push(`${deg(r.theta)}: lit past the square's tip (the square is larger than range)`);
    return `${deg(r.theta)} ${(r.poke[2] - r.floor[2]).toFixed(3)}/${(r.control[2] - r.floor[2]).toFixed(3)}${r.listed ? '' : ' unlisted'}`;
  });
  return { ok: causes.length === 0, detail: [`blue over the floor, sliver/control: ${rows.join(', ')}`, ...causes].join('; ') };
}

/** The shadow check's reads and the frame's groups. */
export interface ShadowReads {
  S: Rgba;
  S2: Rgba;
  U: Rgba;
  floor: Rgba;
  groups: number;
  sdfSets: number;
}

/** L's blue: S at most 0.1, S' at least 0.9, U at least 0.8 (opaque blocks). NaN-safe. */
export function spriteShadowVerdict(r: ShadowReads, energy: number): Verdict {
  const share = (v: Rgba): number => (v[2] - r.floor[2]) / energy;
  const [s, s2, u] = [share(r.S), share(r.S2), share(r.U)];
  const causes: string[] = [];
  const bad = (['S', 'S2', 'U', 'floor'] as const).filter((k) => !r[k].slice(0, 3).every(Number.isFinite));
  if (bad.length > 0) causes.push(`a non-finite read at ${bad.map((k) => (k === 'S2' ? "S'" : k)).join(', ')}`);
  if (!(s <= 0.1) && bad.length === 0) {
    causes.push(r.sdfSets === 0
      ? 'S is lit behind the wall, and the frame has no SDF set: light-groups.ts does not count a shadowed sprite light'
      : 'S is lit behind the wall with an SDF set: light-accum.wgsl does not march for a sprite light, or marches along its facing');
  }
  if (!(s2 >= 0.9) && bad.length === 0) causes.push(`S' is shadowed in the open (${s2.toFixed(3)})`);
  if (!(u >= 0.8) && bad.length === 0) causes.push(`U, between the light and the wall, is shadowed (${u.toFixed(3)}): the march runs away from the light`);
  const detail = `L's light at S ${s.toFixed(3)}, S' ${s2.toFixed(3)}, U ${u.toFixed(3)}; ${r.groups} group(s), ${r.sdfSets} SDF set(s)`;
  return { ok: causes.length === 0, detail: [detail, ...causes].join('; ') };
}

// ── The checks ──────────────────────────────────────────────────────────────

const NAMES = ['Sprite cookie at known texels', 'Cookie tier grows while the light draws', 'Sprite light: no pop at the frustum edge', 'Sprite light shadow behind a wall'];

/**
 * The four checks; `restoreView` brings the camera back. Every handle also
 * goes into `entities` and is destroyed here whatever happens. No
 * engine.debug, or no texture (Mode A): four skips, nothing spawned.
 */
export async function checkSprite(
  engine: Hyperion,
  reporter: TestReporter,
  entities: EntityHandle[],
  floor: Rgb,
  restoreView: () => void,
  { loadTimeoutMs = LOAD_TIMEOUT_MS }: { loadTimeoutMs?: number } = {},
): Promise<void> {
  const debug = engine.debug;
  if (!debug) {
    for (const name of NAMES) reporter.skip(name, 'pixel probe unavailable: production build');
    return;
  }
  const load = async (url: string, tierIndex?: number): Promise<number> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${loadTimeoutMs} ms`)), loadTimeoutMs);
    });
    try {
      return await Promise.race([engine.loadTexture(url, tierIndex), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  // Before the first load: a first allocation replaces a placeholder too.
  const witness = gpuErrorWitness(engine);
  let cookie: number;
  try {
    cookie = await load(COOKIE_URL);
  } catch (err) {
    witness?.stop();
    for (const name of NAMES) reportTextureLoadFailure(reporter, name, COOKIE_LABEL, err);
    return;
  }
  const [cx, cy] = SPRITE_SCENE;
  const at = ([x, y]: Xy): [number, number] => [cx + x, cy + y];
  const scene: EntityHandle[] = [];
  const keep = (h: EntityHandle): EntityHandle => {
    scene.push(h);
    entities.push(h);
    return h;
  };
  const sprite = (range: number, shadowIntensity = 0): LightOptions => ({ type: 'sprite', color: [1, 1, 1], energy: ENERGY, range, shadowIntensity });
  // The floor's light group (layer 0), read right before each probe.
  const floorGroup = (): number => (engine.lighting.groups?.layerToGroup[0] ?? 0) & 0xf;
  const { tier: cookieTier, layer: cookieLayer, overflow } = unpackTextureIndex(cookie);
  const count = (): TierCount | null => {
    const t = debug.textureTiers()?.tiers[cookieTier];
    if (!t) return null;
    return overflow ? { used: t.overflowLayers, allocated: t.overflowAllocated } : { used: t.layers, allocated: t.allocated };
  };
  try {
    fitView(engine, cx, cy, SUB_HALF_WIDTH);
    let k!: EntityHandle;
    engine.batch(() => {
      keep(engine.spawn().position(cx, cy, -0.5).scale(200, 100, 1).receivesLight(true));
      k = keep(engine.spawn({ mode: '2d' }).position(...at(K_AT)).scale(3, 0.5).rotation(COOKIE_THETAS[0]).light(sprite(K_RANGE)).texture(cookie));
      keep(engine.spawn({ mode: '2d' }).position(...at(L_AT)).rotation(L_THETA).light(sprite(L_RANGE, 1)).texture(cookie));
      keep(engine.spawn().position(...at(W_AT), 0).scale(W_SIZE[0], W_SIZE[1], 1).castsShadow(true));
    });
    await frames(4);
    const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
    const density = (): string => `${lightTexelsPerUnit(engine.cam.viewProjection, halfResolution(canvas?.width ?? 0, canvas?.height ?? 0)).toFixed(3)} light texels per unit`;
    const index = `cookie ${overflow ? 'overflow' : 'primary'} tier ${cookieTier} layer ${cookieLayer}`;
    const readCookie = async (probe: (world: [number, number][]) => Promise<Rgba[]>, ...thetas: number[]): Promise<CookieRead[]> => {
      const values = await probe([...thetas.flatMap((theta) => blockCentres(at(K_AT), theta, K_RANGE).map((b) => b.at)), at(FLOOR_AT)]);
      const floorRead = values[values.length - 1];
      return thetas.map((theta, t) => ({ theta, values: values.slice(16 * t, 16 * t + 16), floor: floorRead }));
    };

    // ── 1. The cookie at known texels: three angles, two mirrors, a mix ─
    await pixelCheck(reporter, NAMES[0], engine, async (probe) => {
      const read = (world: [number, number][]): Promise<Rgba[]> => probe('light-buffer', world, floorGroup());
      const reads: CookieRead[] = [];
      for (const theta of COOKIE_THETAS) {
        k.rotation(theta);
        await frames(4);
        reads.push(...await readCookie(read, theta));
      }
      k.rotation(0);
      for (const m of MIRRORS) {
        k.scale(...m.scale);
        await frames(4);
        const [r] = await readCookie(read, 0);
        reads.push({ ...r, label: m.label, expect: m.expect });
      }
      k.scale(3, 0.5);
      k.light({ ...sprite(K_RANGE), blend: 'mix' });
      await frames(4);
      const [mixRead] = await readCookie(read, 0);
      k.light(sprite(K_RANGE)).rotation(COOKIE_THETAS[COOKIE_THETAS.length - 1]);
      const verdict = cookieVerdict(reads, ENERGY);
      const mix = mixVerdict(mixRead, ENERGY);
      // Nothing else of the tab may reach the floor.
      const floorOff = !(maxChannelDiff(reads[0].floor, floor) <= TOL);
      const floorCause = floorOff ? `; the floor reads ${fmt(reads[0].floor.slice(0, 3))}, not the tab's ${fmt(floor)}: another light reaches the sub-scene` : '';
      const errors = witness ? `${witness.count} GPU errors since the cookie loaded${witness.count > 0 ? ` (${witness.messages.slice(0, 2).join(' | ')})` : ''}` : 'no GPU error witness: no main-thread device';
      const ok = verdict.ok && mix.ok && !floorOff && witness !== null && witness.count === 0;
      return { ok, detail: `${verdict.detail}; ${mix.detail}${floorCause}; ${errors}; ${index}; ${density()}` };
    });

    // ── 2. The cookie's tier grows while K draws, with no GPU error ─────
    const before = count();
    if (before && before.allocated >= MAX_LAYERS) {
      reporter.skip(NAMES[1], `the cookie's tier is full (${before.allocated} layers): reload the page to run this check again`);
    } else {
      await pixelCheck(reporter, NAMES[1], engine, async (probe) => {
        if (!before) return { ok: false, detail: 'engine.debug.textureTiers() returned nothing after the cookie loaded' };
        // K as read here, whatever check 1 left.
        const lastTheta = COOKIE_THETAS[COOKIE_THETAS.length - 1];
        k.scale(3, 0.5).light(sprite(K_RANGE)).rotation(lastTheta);
        await frames(4);
        const errorsBefore = witness?.count ?? 0;
        const firstMessage = witness?.messages.length ?? 0;
        const fillerLayers: number[] = [];
        const need = before.allocated - before.used + 1;
        for (let n = 0; n < need; n++) {
          try {
            fillerLayers.push(unpackTextureIndex(await load(fillerUrl(before.used + n), cookieTier)).layer);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, detail: `cannot load filler ${before.used + n} (a 1 x 1 PNG data: URL): ${msg}; ${n} of ${need} fillers loaded` };
          }
        }
        // The frame right after the growth.
        const [first] = await readCookie((world) => probe('light-buffer', world, floorGroup()), lastTheta);
        k.rotation(0);
        await frames(4);
        const [turned, turnedAtFirst] = await readCookie((world) => probe('light-buffer', world, floorGroup()), 0, lastTheta);
        await frames(2);  // an uncaptured error arrives after its frame
        const verdict = growthVerdict({
          before, after: count() ?? before, fillerLayers, first, turned, turnedAtFirst,
          errors: witness ? witness.count - errorsBefore : null,
          errorMessages: witness ? witness.messages.slice(firstMessage) : [],
        }, ENERGY);
        return { ok: verdict.ok, detail: `${verdict.detail}; ${index}; primary tiers ${debug.textureTiers()?.compressedFormat ?? 'rgba8unorm'}` };
      });
    }

    // ── 3. No pop at the frustum edge, at every angle of a quarter turn ──
    await pixelCheck(reporter, NAMES[2], engine, async (probe) => {
      k.light(sprite(POP_RANGE));
      const [xLeft] = viewBounds(engine.cam.viewProjection);
      const reads: PopRead[] = [];
      for (const theta of POP_THETAS) {
        const g = pokeGeometry(theta, POP_RANGE, POKE_DEPTH);
        k.position(xLeft - g.d, cy).rotation(theta);
        await frames(4);
        const [poke, control, floorRead] = await probe('light-buffer', [[xLeft + g.poke[0], cy + g.poke[1]], [xLeft + g.control[0], cy + g.control[1]], at(FLOOR_AT)], floorGroup());
        reads.push({ theta, poke, control, floor: floorRead, listed: engine.lighting.groups?.lightIds.includes(k.id) ?? false });
      }
      const verdict = popVerdict(reads, ENERGY);
      return { ok: verdict.ok, detail: `${verdict.detail}; range ${POP_RANGE}, sliver ${POKE_DEPTH} deep; ${density()}` };
    });

    // ── 4. L's shadow behind W ─────────────────────────────────────────
    await pixelCheck(reporter, NAMES[3], engine, async (probe) => {
      const [S, S2, U, floorRead] = await probe('light-buffer', [at(SHADOW_POINTS.S), at(SHADOW_POINTS.S2), at(SHADOW_POINTS.U), at(FLOOR_AT)], floorGroup());
      const g = engine.lighting.groups;
      return spriteShadowVerdict({ S, S2, U, floor: floorRead, groups: g?.groups.length ?? 0, sdfSets: g?.sdfSets.length ?? 0 }, ENERGY);
    });
  } finally {
    for (const h of scene) h.destroy();
    await frames(4);
    witness?.stop();
    restoreView();
  }
}
