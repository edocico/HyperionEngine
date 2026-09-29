// ts/src/demo/twin-2d.ts — Demo section: the Transform2D archetype (spawn({ mode: '2d' }))
//
// Every 2D entity has a 3D twin with the same transform, a whole number of
// pixels to the right. Both must draw the same pixels: the 2D archetype is a
// compact ECS component (20 bytes against 40), not another look. The 2D parent
// and its child move, so in Mode C most frames upload through the scatter
// pass: the parent as a root 2D row (format 0, rebuilt on the GPU from 6
// words), the child as a full matrix (format 1). A third check, off to the
// right, orders overlapping 2D sprites by depth (z = -depth).
// A fourth, far off at (-80, -60) and destroyed afterwards, orders overlapping
// `.transparent()` sprites of different primitive types (phase 5b's GPU sort).
// Right of the third (x = 80) a scene of every primitive type, transparent,
// untextured and with a PNG, reads the transparent sort back
// (engine.debug.readTransparentSort) and checks it against the CPU oracle; in
// Mode C again under spawn/despawn churn, on scatter frames that re-upload the
// id column.
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';
import type { TextureHandle } from '../types';
import type { TransparentSortReadback } from '../render/transparent-sort-probe';
import { worldToUv } from '../render/debug-probe';
import { nextFrameStamp } from '../render/frame-inputs';
import { pixelCheck, fmt, frames, fitView, PROBE_TIMEOUT_MS, type Rgba } from './probe-checks';
import { verifySortReadback, sameIdOrder, readSortFrame } from './transparent-sort-checks';
import { straight, composite, measuredLayer, backToFront, expectedOverlap, maxChannelDiff, type Layer, type Rgb } from './blend-expect';

const entities: EntityHandle[] = [];

/** Centre of the 2D block; the 3D block sits about 12 units to the right. */
const BLOCK_X = -6;
const GAP = 12;
const CELL = 3.2;

/** One cell of a block: how to build it, on a handle of either archetype. */
interface Cell {
  build(h: EntityHandle): void;
  /** A child built under the cell's entity, if any. */
  child?(h: EntityHandle): void;
  /** Where the child's centre lands, relative to the cell centre: scanned too. */
  childAt?: [number, number];
}

/** The parent of cell 4: turned 0.5 rad, scale 1.2; its child sits at local (0.9, 0). */
const PARENT_ROT = 0.5;
const PARENT_SCALE = 1.2;
const CHILD_LOCAL_X = 0.9;

const CELLS: Cell[] = [
  { build: (h) => h.rotation(0.3).scale(2, 1) },
  { build: (h) => h.rotation(Math.PI / 4).scale(1.5, 1.5) },
  { build: (h) => h.rotation(1.2).scale(0.6, 2.2) },
  { build: (h) => h.rotation(0.4).scale(2, 2).gradient(0, 0, [0, 0, 0, 1, 1, 1]) },
  // The movers: a 2D parent (a root, format 0 in a scatter upload) and its 2D
  // child (format 1: its Transform2D is local, so it travels as a full
  // matrix), dirty every frame. The only movers: 4 of the 20 entities, under
  // the 30% scatter threshold.
  {
    build: (h) => h.rotation(PARENT_ROT).scale(PARENT_SCALE, PARENT_SCALE).velocity(0.1, 0),
    child: (c) => c.position(CHILD_LOCAL_X, 0).scale(0.4, 0.4),
    childAt: [PARENT_SCALE * CHILD_LOCAL_X * Math.cos(PARENT_ROT), PARENT_SCALE * CHILD_LOCAL_X * Math.sin(PARENT_ROT)],
  },
  { build: (h) => h.rotation(0.2).line(-1, -1, 1, 1, 0.15) },
  { build: (h) => h.scale(0.8, 0.8) },
  { build: (h) => h.rotation(0.6).scale(0.8, 0.8) },
  { build: (h) => h.rotation(0.3).scale(2, 2).transparent().boxShadow(0.8, 0.8, 0.1, 0.05, 0.9, 0.5, 0.2, 0.9) },
];

const cellCentre = (i: number): [number, number] => [BLOCK_X + ((i % 3) - 1) * CELL, (Math.floor(i / 3) - 1) * CELL];

/** Centre of the depth scene, off to the right of the twins. */
const DEPTH_X = 40;

/**
 * Green and blue gradients (green / blue at their left end, fading to black):
 * the colour at a point says which sprite is in front. Depth is a distance
 * into the screen (z = -depth), so the SMALLER depth wins.
 */
async function checkDepth(engine: Hyperion, reporter: TestReporter): Promise<void> {
  const green = (h: EntityHandle) => h.gradient(0, 0, [0, 0, 1, 0, 1, 0]);
  const blue = (h: EntityHandle) => h.gradient(0, 0, [0, 0, 0, 1, 1, 0]);
  let a!: EntityHandle;
  let parent!: EntityHandle;
  engine.batch(() => {
    // A pair: green at depth 1 over blue at depth 2, the same 2x2 square.
    a = engine.spawn({ mode: '2d' }).position(DEPTH_X - 3, 0).scale(2, 2).depth(1);
    green(a);
    const b = engine.spawn({ mode: '2d' }).position(DEPTH_X - 3, 0).scale(2, 2).depth(2);
    blue(b);
    // A family: a white parent (depth 5), its green child at RELATIVE depth -1
    // (world 4) and a blue sibling root at 4.5 between them.
    parent = engine.spawn({ mode: '2d' }).position(DEPTH_X + 3, 0).scale(3, 3).depth(5);
    const child = engine.spawn({ mode: '2d' }).parent(parent.id).scale(0.3, 0.3).depth(-1);
    green(child);
    const sibling = engine.spawn({ mode: '2d' }).position(DEPTH_X + 3, 0).scale(1.8, 1.8).depth(4.5);
    blue(sibling);
    entities.push(a, b, parent, child, sibling);
  });
  fitView(engine, DEPTH_X, 0, 6);
  await frames(4);

  const colour = ([r, g, b]: Rgba) =>
    r > 0.9 && g > 0.9 && b > 0.9 ? 'white' : g > 0.5 && b < 0.2 ? 'green' : b > 0.5 && g < 0.2 ? 'blue' : `(${fmt([r, g, b])})`;
  // Near each gradient's left end (t ~ 0.1), where its colour is ~0.9.
  const pairPoint: [number, number] = [DEPTH_X - 3 - 0.8, 0];
  const childPoint: [number, number] = [DEPTH_X + 3 - 0.36, 0];   // inside the child (0.9 wide)
  const siblingPoint: [number, number] = [DEPTH_X + 3 - 0.72, 0]; // in the sibling, outside the child
  const parentPoint: [number, number] = [DEPTH_X + 3 - 1.2, 0];   // in the parent only

  await pixelCheck(reporter, 'Depth orders 2D sprites', engine, async (probe) => {
    const read = async () => (await probe('scene-hdr', [pairPoint, childPoint, siblingPoint, parentPoint])).map(colour);
    // Stable: the same winners on 10 consecutive frames.
    const first = await read();
    let stable = true;
    for (let f = 0; f < 9; f++) if ((await read()).join() !== first.join()) stable = false;
    // Swapped at runtime: blue in front of the pair; the parent moves to 3.5,
    // so its child follows to 2.5 and the sibling (4.5) goes behind the parent.
    a.depth(3);
    parent.depth(3.5);
    await frames(4);
    const after = await read();
    const want = ['green', 'green', 'blue', 'white'];
    const wantAfter = ['blue', 'green', 'white', 'white'];
    return {
      ok: stable && first.join() === want.join() && after.join() === wantAfter.join(),
      detail: `pair/child/sibling/parent: ${first.join(', ')}${stable ? ' (10 frames)' : ' (UNSTABLE)'}; after swapping depths: ${after.join(', ')}`,
    };
  });
}

/** Centre of the transparent-order scene: far from the twins (|x| <= 18, |y| <= 10 at zoom 1) and the depth scene (x ~ 34..46). */
const ORDER_X = -80;
const ORDER_Y = -60;
/** The 128×128 PNG committed for the sort checks: tier 1, or an overflow tier on a BC7/ASTC device. */
const ORDER_TEXTURE_URL = '/textures/sort-test-128.png';
/** Per-channel tolerance on scene-hdr (rgba16float) against the closed form. */
const ORDER_TOLERANCE = 0.02;
/** Flat colours of the order scene. */
const TINT: Record<'green' | 'red' | 'teal' | 'blue' | 'yellow' | 'magenta' | 'cyan', Rgb> = {
  green: [0, 1, 0],
  red: [1, 0, 0],
  teal: [0.25, 0.75, 0.5],
  blue: [0.1, 0.3, 0.9],
  yellow: [1, 1, 0],
  magenta: [1, 0, 1],
  cyan: [0, 1, 1],
};

/**
 * Overlapping `.transparent()` sprites of DIFFERENT primitive types, drawn in
 * depth order (design 5b §7.3.4). Before phase 5b transparent draws went by
 * primitive type (quads first, box shadows last), then cull order: each pair
 * is chosen so that order gives another colour, and the check refuses a pair
 * whose two orders look alike. Six cells a whole number of pixels apart:
 *  0: a green gradient (type 4) in front of a red box shadow at alpha 0.5 (type 5);
 *  1: the textured quad (type 0) in front of a teal gradient (type 4);
 *  2: the same textured quad alone, over the clear;
 *  3: the same textured quad over an OPAQUE white quad (2 and 3 measure the
 *     texel's colour and alpha, which the PNG decides);
 *  4: a tie at depth 2: a blue box shadow (lower id) and a yellow gradient (higher id: in front);
 *  5: a tie at depth 2 of two gradients: magenta (lower id) and cyan (higher id: in front).
 * Then depths change at runtime: cell 0's gradient and cell 1's quad go
 * behind their partner, and cell 5's cyan behind the magenta (a depth beats
 * an id). Expected values: blend-expect.ts. The scene is destroyed afterwards.
 */
async function checkTransparentDepth(engine: Hyperion, reporter: TestReporter): Promise<void> {
  const name = 'Depth orders transparent sprites';
  if (!engine.debug) {
    reporter.skip(name, 'pixel probe unavailable: production build');
    return;
  }
  let texture: TextureHandle;
  try {
    texture = await engine.loadTexture(ORDER_TEXTURE_URL);
  } catch (err) {
    // No main-thread renderer (Mode A): the probe does not exist there either.
    reporter.skip(name, `test texture unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  fitView(engine, ORDER_X, ORDER_Y, 9);
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const width = canvas?.width ?? 1;
  const height = canvas?.height ?? 1;
  const vp = engine.cam.viewProjection;
  // Cells a whole number of pixels apart: the textured quads of cells 1, 2 and
  // 3 then sample the same texel at their probe points.
  const worldPerPx = 2 / (vp[0] * width);
  const step = Math.round(2.6 / worldPerPx) * worldPerPx;
  const cellX = (k: number) => ORDER_X + (k - 2.5) * step;
  // A world point moved to the centre of its texel (the probe floors uv * size).
  const snap = (x: number, y: number): [number, number] => {
    const [u, v] = worldToUv(x, y, vp);
    const cu = (Math.floor(u * width) + 0.5) / width;
    const cv = (Math.floor(v * height) + 0.5) / height;
    return [((cu - 0.5) * 2 - vp[12]) / vp[0], ((0.5 - cv) * 2 - vp[13]) / vp[5]];
  };
  const [p0x, p0y] = snap(cellX(0) + 0.2, ORDER_Y + 0.15);
  const points: [number, number][] = [
    snap(ORDER_X, ORDER_Y + 2.5),         // 0: the clear, no sprite
    snap(cellX(3) + 1.1, ORDER_Y + 0.15), // 1: cell 3's white quad, outside its textured quad
    ...[0, 1, 2, 3, 4, 5].map((k): [number, number] => [p0x + k * step, p0y]), // 2-7: cells 0-5
  ];

  const own: EntityHandle[] = [];
  const depthOf = new Map<EntityHandle, number>();
  const sprite = (k: number, depth: number, size = 2): EntityHandle => {
    const h = engine.spawn({ mode: '2d' }).position(cellX(k), ORDER_Y).scale(size, size).depth(depth);
    depthOf.set(h, depth);
    own.push(h);
    entities.push(h);
    return h;
  };
  const setDepth = (h: EntityHandle, depth: number) => {
    h.depth(depth);
    depthOf.set(h, depth);
  };
  // stop0Pos 2 lies past every t in [0, 1]: the whole gradient is stop0, a flat colour at alpha 1.
  const flat = (h: EntityHandle, [r, g, b]: Rgb) => h.transparent().gradient(0, 0, [2, r, g, b, 3, 0]);
  // No blur, no corner radius, the rect the whole quad: a flat colour at alpha a.
  const shadow = (h: EntityHandle, [r, g, b]: Rgb, a: number) => h.transparent().boxShadow(1, 1, 0, 0, r, g, b, a);

  let green!: EntityHandle;
  let red!: EntityHandle;
  let quad!: EntityHandle;
  let teal!: EntityHandle;
  let blue!: EntityHandle;
  let yellow!: EntityHandle;
  let magenta!: EntityHandle;
  let cyan!: EntityHandle;
  engine.batch(() => {
    green = flat(sprite(0, 1), TINT.green);
    red = shadow(sprite(0, 2), TINT.red, 0.5);
    quad = sprite(1, 1).transparent().texture(texture);
    teal = flat(sprite(1, 2), TINT.teal);
    sprite(2, 1).transparent().texture(texture);
    sprite(3, 1).transparent().texture(texture);
    sprite(3, 5, 2.4);                           // opaque and untextured: white, behind
    blue = shadow(sprite(4, 2), TINT.blue, 0.6); // spawned first: the lower id
    yellow = flat(sprite(4, 2), TINT.yellow);
    magenta = flat(sprite(5, 2), TINT.magenta);
    cyan = flat(sprite(5, 2), TINT.cyan);
  });
  await frames(4);

  try {
    await pixelCheck(reporter, name, engine, async (probe) => {
      const read = async (): Promise<Rgb[]> =>
        (await probe('scene-hdr', points)).map(([r, g, b]): Rgb => [r, g, b]);
      const judge = (v: Rgb[]) => {
        const [bg, white, c0, c1, alone, onWhite, c4, c5] = v;
        const texel = measuredLayer(alone, bg, onWhite, white);
        const pairs: Array<{ cell: number; got: Rgb; sprites: Array<[EntityHandle, Layer]> }> = [
          { cell: 0, got: c0, sprites: [[green, straight(TINT.green, 1)], [red, straight(TINT.red, 0.5)]] },
          { cell: 1, got: c1, sprites: [[quad, texel], [teal, straight(TINT.teal, 1)]] },
          { cell: 4, got: c4, sprites: [[blue, straight(TINT.blue, 0.6)], [yellow, straight(TINT.yellow, 1)]] },
          { cell: 5, got: c5, sprites: [[magenta, straight(TINT.magenta, 1)], [cyan, straight(TINT.cyan, 1)]] },
        ];
        return pairs.map(({ cell, got, sprites }) => {
          const sorted = sprites.map(([h, layer]) => ({ depth: depthOf.get(h)!, id: h.id, layer }));
          const want = expectedOverlap(bg, sorted);
          // The same two layers the other way round: if they look alike, the pair proves nothing.
          const other = composite(bg, backToFront(sorted).reverse().map((s) => s.layer));
          return {
            cell, got, want,
            ok: maxChannelDiff(got, want) <= ORDER_TOLERANCE,
            telling: maxChannelDiff(want, other) > 0.1,
          };
        });
      };
      const show = (ps: ReturnType<typeof judge>) =>
        ps.map((p) => `cell ${p.cell} (${fmt(p.got)}) want (${fmt(p.want)})`).join('; ');

      // Stable: right on 10 consecutive frames.
      const first = judge(await read());
      let rightFrames = first.every((p) => p.ok) ? 1 : 0;
      for (let f = 1; f < 10; f++) if (judge(await read()).every((p) => p.ok)) rightFrames++;
      // Swapped at runtime.
      setDepth(green, 3);
      setDepth(quad, 3);
      setDepth(cyan, 3);
      await frames(4);
      const after = judge(await read());
      const telling = [...first, ...after].every((p) => p.telling);
      return {
        ok: rightFrames === 10 && after.every((p) => p.ok) && telling,
        detail: `${show(first)}; right on ${rightFrames}/10 frames; after swapping depths: ${show(after)}`
          + (telling ? '' : '; a pair looks the same in both orders (is the texel at the probe point transparent, or teal?)'),
      };
    });
  } finally {
    for (const h of own) if (h.alive) h.destroy();
  }
}

/** Centre of the transparent-sort scene: far from the twins (x within ±18) and from the depth scene (x 22-58). */
const SORT_X = 80;
/** Half-width fitView frames around it: the widest sprite ends 7.1 units from the centre. */
const SORT_HALF_WIDTH = 9;
/** 128 × 128 RGBA (scripts/gen-sort-test-png.mjs): tier 1, or an overflow tier on a BC7/ASTC device. */
const SORT_TEXTURE = '/textures/sort-test-128.png';
/** Frames the churn scene spawns and despawns through (design §7.3.3 (h)). */
const CHURN_FRAMES = 60;

/**
 * Each primitive type 0-5, built on a 2D handle. Transparent and untextured
 * it fills the gather's region 14 + 2t; with the PNG, region 15 + 2t. The
 * textured MSDF glyph samples the PNG as an MSDF and the textured gradient
 * takes stop 1's G/B from the index: fine for the gather, never for a pixel check.
 */
const SORT_TYPES: ReadonlyArray<(h: EntityHandle) => EntityHandle> = [
  (h) => h,                                                    // 0 quad
  (h) => h.line(-0.5, 0, 0.5, 0, 0.2),                          // 1 line
  (h) => h.primitive(2),                                        // 2 MSDF glyph
  (h) => h.bezier(0, 0.5, 0.5, 1, 1, 0.5, 0.08),                // 3 quadratic bezier
  (h) => h.gradient(0, 0, [0, 1, 0, 0, 1, 0]),                  // 4 gradient
  (h) => h.boxShadow(0.8, 0.8, 0.1, 0.05, 0.9, 0.5, 0.2, 0.7),   // 5 box shadow
];

/**
 * The transparent sort read back (engine.debug.readTransparentSort) and
 * checked against the CPU oracle: every type, untextured and textured, plus
 * many sprites at one depth; then, in Mode C, the same under churn. No
 * positionImmediate anywhere: a scatter frame never uploads patched bounds.
 * The scene is gone when this returns; the caller restores the camera.
 */
async function checkTransparentSort(engine: Hyperion, reporter: TestReporter): Promise<void> {
  const ORACLE = 'Transparent sort matches the oracle';
  const CHURN = 'Transparent sort under churn';
  let png: TextureHandle;
  try {
    png = await engine.loadTexture(SORT_TEXTURE);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const name of [ORACLE, CHURN]) {
      // Mode A has no renderer on this thread: nothing to read back there.
      if (/no renderer/.test(msg)) reporter.skip(name, `no main-thread renderer: ${msg}`);
      else reporter.check(name, false, `cannot load ${SORT_TEXTURE}: ${msg}`);
    }
    return;
  }

  const scene: EntityHandle[] = [];
  const textured = new Set<number>();
  engine.batch(() => {
    SORT_TYPES.forEach((build, t) => {
      const x = SORT_X + (t - 2.5) * 2.4;
      // Untextured, at depths 0 / 0.5 / 1 twice over: equal z across types.
      scene.push(build(engine.spawn({ mode: '2d' }).position(x, 2).scale(1.5, 1.5).depth((t % 3) * 0.5)).transparent());
      // With the PNG, all at one depth: the id orders them.
      const h = build(engine.spawn({ mode: '2d' }).position(x, -2).scale(1.5, 1.5).depth(0.25)).texture(png).transparent();
      textured.add(h.id);
      scene.push(h);
    });
    // Many sprites at the same z, the common 2D case.
    for (let k = 0; k < 24; k++) {
      scene.push(engine.spawn({ mode: '2d' })
        .position(SORT_X - 4.2 + (k % 8) * 1.2, 5 + Math.floor(k / 8) * 1.1)
        .scale(0.5, 0.5)
        .transparent());
    }
  });
  entities.push(...scene);
  const sceneIds = new Set(scene.map((h) => h.id));
  fitView(engine, SORT_X, 0, SORT_HALF_WIDTH);
  await frames(4);

  /** The frame holds the whole scene: every row present, transparent, the textured ones with their index. */
  const holdsScene = (r: TransparentSortReadback): boolean => {
    let found = 0;
    for (let s = 0; s < r.frame.entityCount; s++) {
      const id = r.frame.entityIds[s];
      if (!sceneIds.has(id)) continue;
      if ((r.frame.renderMeta[s * 2 + 1] & 0x100) === 0) return false;
      if (textured.has(id) && r.frame.texIndices[s] === 0) return false;
      found++;
    }
    return found === sceneIds.size;
  };

  await pixelCheck(reporter, ORACLE, engine, async (_probe, _rows, readSort) => {
    const r = await readSortFrame(readSort, holdsScene, PROBE_TIMEOUT_MS);
    const failures = verifySortReadback(r, { exactSet: true, requireAllRegions: true });
    // (g) Two requests issued together: consecutive frames, the same ids in the same order.
    const [a, b] = await Promise.all([readSort(), readSort()]);
    const consecutive = b.frame.stamp === nextFrameStamp(a.frame.stamp);
    const same = sameIdOrder(a, b);
    return {
      ok: failures.length === 0 && consecutive && same,
      detail: `frame ${r.frame.stamp}: ${r.n} sorted of ${r.frame.transparentCount} transparent rows`
        + (failures.length === 0 ? ', (a)-(f) and (i) hold' : `; ${failures.join(' | ')}`)
        + `; two requests together: stamps ${a.frame.stamp} → ${b.frame.stamp}${consecutive ? '' : ' (NOT consecutive)'}`
        + `, id order ${same ? 'identical' : 'DIFFERENT'}`,
    };
  });

  if (engine.mode !== 'C') {
    reporter.skip(CHURN, `Mode ${engine.mode}: only Mode C uploads through the scatter pass, which this checks (?mode=C)`);
  } else {
    await pixelCheck(reporter, CHURN, engine, async (_probe, _rows, readSort) => {
      // One quad in and the oldest out on every frame: the slot → id mapping
      // changes each frame while few rows are dirty, so Mode C uploads through
      // the scatter pass AND re-uploads the id column. All at depth 0.
      const churn: EntityHandle[] = [];
      let spawned = 0;
      const spawnOne = (): void => {
        const h = engine.spawn({ mode: '2d' })
          .position(SORT_X - 4.2 + (spawned % 8) * 1.2, -5 - (Math.floor(spawned / 8) % 3) * 1.1)
          .scale(0.5, 0.5)
          .transparent();
        spawned++;
        churn.push(h);
        entities.push(h);
      };
      for (let k = 0; k < 24; k++) spawnOne();
      let churned = 0;
      const step = (): void => {
        churn.shift()?.destroy();
        spawnOne();
        churned++;
      };
      engine.addHook('preTick', step);
      const failures: string[] = [];
      let read = 0;
      let scatterAndIds = 0;
      try {
        while (churned < CHURN_FRAMES) {
          const r = await readSort();
          read++;
          if (r.frame.usedScatter && r.frame.idsUploaded) scatterAndIds++;
          for (const msg of verifySortReadback(r)) failures.push(`frame ${r.frame.stamp}: ${msg}`);
        }
      } finally {
        engine.removeHook('preTick', step);
        for (const h of churn) if (h.alive) h.destroy();
      }
      const listed = failures.slice(0, 3).join(' | ') + (failures.length > 3 ? ` (+${failures.length - 3} more)` : '');
      return {
        ok: scatterAndIds > 0 && failures.length === 0,
        detail: `${churned} frames of churn, ${read} read back, ${scatterAndIds} with a scatter upload AND a new id column`
          + (failures.length === 0 ? '; every one passes (a)-(f)' : `; ${listed}`),
      };
    });
  }

  for (const h of scene) if (h.alive) h.destroy();
}

const section: DemoSection = {
  name: 'twin-2d',
  label: '2D archetype (Transform2D vs 3D twins)',

  async setup(engine: Hyperion, reporter: TestReporter) {
    fitView(engine, BLOCK_X + GAP / 2, 0, GAP / 2 + CELL * 1.5 + 1.5);
    const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
    const width = canvas?.width ?? 1;
    const height = canvas?.height ?? 1;
    const vp = engine.cam.viewProjection;
    // The twin offset, rounded to whole pixels: sampled at matching texel
    // centres, the two blocks must then agree texel for texel.
    const worldPerPx = 2 / (vp[0] * width);
    const offsetPx = Math.round(GAP / worldPerPx);
    const offset = offsetPx * worldPerPx;

    const ids2D: number[] = [];
    engine.batch(() => {
      CELLS.forEach((cell, i) => {
        const [x, y] = cellCentre(i);
        for (const mode of ['2d', '3d'] as const) {
          const h = engine.spawn({ mode }).position(mode === '2d' ? x : x + offset, y);
          cell.build(h);
          entities.push(h);
          if (mode === '2d') ids2D.push(h.id);
          if (cell.child) {
            const c = engine.spawn({ mode }).parent(h.id);
            cell.child(c);
            entities.push(c);
            if (mode === '2d') ids2D.push(c.id);
          }
        }
      });
    });
    await frames(4);

    // ── 1. Same pixels ─────────────────────────────────────────────────
    await pixelCheck(reporter, 'Twins draw the same pixels', engine, async (probe) => {
      // World points snapped to texel centres (the probe floors uv * size).
      const snap = (x: number, y: number): [number, number] => {
        const [u, v] = worldToUv(x, y, vp);
        const cu = (Math.floor(u * width) + 0.5) / width;
        const cv = (Math.floor(v * height) + 0.5) / height;
        return [((cu - 0.5) * 2 - vp[12]) / vp[0], ((0.5 - cv) * 2 - vp[13]) / vp[5]];
      };
      // Per cell: a 9x9 lattice 0.3 apart, plus scans of CONSECUTIVE texels —
      // one row and one column through the centre, and through the child where
      // there is one. Scans cross the edges, where a sub-pixel difference
      // between the twins would show: quads have hard edges, so a fraction of
      // a pixel moves an edge by a whole texel.
      const half = 1.6;
      const steps = Math.ceil((2 * half) / worldPerPx);
      const scanRow = (x: number, y: number): [number, number][] => {
        const [sx, sy] = snap(x - half, y);
        return Array.from({ length: steps + 1 }, (_, k): [number, number] => [sx + k * worldPerPx, sy]);
      };
      const scanColumn = (x: number, y: number): [number, number][] => {
        const [sx, sy] = snap(x, y - half);
        return Array.from({ length: steps + 1 }, (_, k): [number, number] => [sx, sy + k * worldPerPx]);
      };
      interface Group { cell: number; points: [number, number][]; scan: boolean; child: boolean }
      const groups: Group[] = [];
      CELLS.forEach((c, cell) => {
        const [cx, cy] = cellCentre(cell);
        const lattice: [number, number][] = [];
        for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) lattice.push(snap(cx + a * 0.3, cy + b * 0.3));
        groups.push({ cell, points: lattice, scan: false, child: false });
        groups.push({ cell, points: scanRow(cx, cy), scan: true, child: false });
        groups.push({ cell, points: scanColumn(cx, cy), scan: true, child: false });
        if (c.childAt) {
          const [dx, dy] = c.childAt;
          groups.push({ cell, points: scanRow(cx + dx, cy + dy), scan: true, child: true });
          groups.push({ cell, points: scanColumn(cx + dx, cy + dy), scan: true, child: true });
        }
      });
      const left = groups.flatMap((g) => g.points);
      const right = left.map(([x, y]): [number, number] => [x + offset, y]);
      const [l, r] = await Promise.all([probe('scene-hdr', left), probe('scene-hdr', right)]);
      const peak = (p: Rgba) => Math.max(p[0], p[1], p[2]);
      let mismatches = 0;
      let worst = 0;
      let edges = 0;
      const childEdges: number[] = [];
      const drawnPerCell = new Array<number>(CELLS.length).fill(0);
      let base = 0;
      for (const g of groups) {
        let groupEdges = 0;
        for (let n = 0; n < g.points.length; n++) {
          const k = base + n;
          const d = Math.max(...[0, 1, 2].map((c) => Math.abs(l[k][c] - r[k][c])));
          worst = Math.max(worst, d);
          if (d > 0.02) mismatches++;
          if (peak(l[k]) > 0.1) drawnPerCell[g.cell]++;
          if (g.scan && n > 0 && Math.abs(peak(l[k]) - peak(l[k - 1])) > 0.3) groupEdges++;
        }
        edges += groupEdges;
        if (g.child) childEdges.push(groupEdges);
        base += g.points.length;
      }
      const emptyCells = drawnPerCell.flatMap((n, cell) => (n === 0 ? [cell] : []));
      // The child is small (0.48 wide): each scan through it must cross both of its edges.
      const childCrossed = childEdges.length > 0 && childEdges.every((e) => e >= 2);
      return {
        ok: mismatches === 0 && emptyCells.length === 0 && edges >= CELLS.length && childCrossed,
        detail: `${l.length - mismatches}/${l.length} texels match (worst ${fmt([worst])}), the scans crossing ${edges} edges `
          + `(through the 2D child: ${childEdges.join(', ')}); twin offset ${offsetPx} px`
          + (emptyCells.length ? `; nothing drawn in cells ${emptyCells.join(', ')}` : ''),
      };
    });

    // ── 2. The rows the GPU holds ──────────────────────────────────────
    await pixelCheck(reporter, 'GPU rows of 2D entities', engine, async (_probe, readTransforms) => {
      const wanted = new Set(ids2D);
      let frameCount = 0;
      let scatterFrames = 0;
      let worst = 0;
      for (let f = 0; f < 12; f++) {
        const t = await readTransforms();
        frameCount++;
        if (t.usedScatter) scatterFrames++;
        for (let s = 0; s < t.entityCount; s++) {
          if (!wanted.has(t.entityIds[s])) continue;
          for (let w = 0; w < 16; w++) {
            const a = t.gpuRows[s * 16 + w];
            const b = t.cpuRows[s * 16 + w];
            worst = Math.max(worst, Math.abs(a - b) / Math.max(1, Math.abs(b)));
          }
        }
      }
      // Only Mode C uploads through the scatter pass; there the compressed
      // rows are the point of the check.
      const needScatter = engine.mode === 'C';
      return {
        ok: worst < 1e-5 && (!needScatter || scatterFrames > 0),
        detail: `${frameCount} frames, ${scatterFrames} via scatter (Mode ${engine.mode}); worst GPU/CPU difference ${worst.toExponential(1)}`,
      };
    });

    // ── 3. Depth: overlapping 2D sprites in depth order ────────────────
    await checkDepth(engine, reporter);
    // ── 4. Depth: overlapping TRANSPARENT sprites, sorted on the GPU (phase 5b) ──
    await checkTransparentDepth(engine, reporter);
    // ── 5. The transparent sort, read back (its scene is gone after) ──
    await checkTransparentSort(engine, reporter);
    fitView(engine, BLOCK_X + GAP / 2, 0, GAP / 2 + CELL * 1.5 + 1.5);
  },

  teardown(engine: Hyperion) {
    for (const e of entities) if (e.alive) e.destroy();
    entities.length = 0;
    engine.cam.position(0, 0, 0);
    engine.cam.zoom(1);
  },
};

export default section;
