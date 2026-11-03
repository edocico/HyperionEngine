import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  normalizeTransparentCount, normalizeIdsGeneration, nextFrameStamp,
  uploadEntityIds, missingSortInputs, overCapacityWarning,
  persistentWarning, untexturedSpriteMessage, UNTEXTURED_SPRITE_MS, HELD_STEP_CAP_MS, UNNAMED_SPRITE_LIGHT, textureLayerCounts,
} from './frame-inputs';
import { MAX_GPU_ENTITIES } from '../types';

describe('normalizeTransparentCount', () => {
  it('keeps a finite count, floored and never negative', () => {
    expect(normalizeTransparentCount(5, 10)).toBe(5);
    expect(normalizeTransparentCount(0, 10)).toBe(0);
    expect(normalizeTransparentCount(2.7, 10)).toBe(2);
    expect(normalizeTransparentCount(-3, 10)).toBe(0);
  });

  it('falls back to entityCount when the count is missing or not finite — never to 0', () => {
    expect(normalizeTransparentCount(undefined, 12)).toBe(12);
    expect(normalizeTransparentCount(NaN, 12)).toBe(12);
    expect(normalizeTransparentCount(Infinity, 12)).toBe(12);
    // An untyped worker message can carry anything.
    expect(normalizeTransparentCount(null as unknown as number, 12)).toBe(12);
    expect(normalizeTransparentCount('4' as unknown as number, 12)).toBe(12);
  });
});

describe('normalizeIdsGeneration', () => {
  it('keeps a finite generation, 0 included', () => {
    expect(normalizeIdsGeneration(0)).toBe(0);
    expect(normalizeIdsGeneration(7)).toBe(7);
    expect(normalizeIdsGeneration(0xFFFFFFFF)).toBe(0xFFFFFFFF);
  });

  it('turns a missing or non-finite generation into NaN, which equals no marker', () => {
    for (const g of [undefined, NaN, Infinity, null as unknown as number]) {
      const n = normalizeIdsGeneration(g);
      expect(Number.isNaN(n)).toBe(true);
      expect(n === n).toBe(false);
    }
  });
});

describe('nextFrameStamp', () => {
  it('starts at 1 and counts up', () => {
    expect(nextFrameStamp(0)).toBe(1);
    expect(nextFrameStamp(1)).toBe(2);
    expect(nextFrameStamp(0xFFFFFFFD)).toBe(0xFFFFFFFE);
  });

  it('wraps from 0xFFFFFFFE back to 1: never 0 and never the 0xFFFFFFFF sentinel', () => {
    expect(nextFrameStamp(0xFFFFFFFE)).toBe(1);
    let s = 0xFFFFFFF0;
    for (let i = 0; i < 40; i++) {
      s = nextFrameStamp(s);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(0xFFFFFFFE);
    }
  });
});

describe('uploadEntityIds', () => {
  function recordingQueue() {
    const writes: Array<{ offset: number; data: Uint32Array; dataOffset: number; size: number }> = [];
    const queue = {
      writeBuffer: (_b: GPUBuffer, offset: number, data: Uint32Array, dataOffset: number, size: number) => {
        writes.push({ offset, data, dataOffset, size });
      },
    } as unknown as Pick<GPUQueue, 'writeBuffer'>;
    return { queue, writes };
  }
  const buffer = {} as GPUBuffer;
  const ids = new Uint32Array([4, 9, 2]);

  it('writes the whole live column when the generation moved, then not again', () => {
    const { queue, writes } = recordingQueue();
    let marker = NaN; // the renderer's initial marker
    const state = { entityIds: ids, entityCount: 3, entityIdsGeneration: 5 };
    let r = uploadEntityIds(queue, buffer, state, marker);
    expect(r).toEqual({ generation: 5, uploaded: true });
    expect(writes).toEqual([{ offset: 0, data: ids, dataOffset: 0, size: 3 }]);
    marker = r.generation;
    r = uploadEntityIds(queue, buffer, state, marker);
    expect(r.uploaded).toBe(false);
    r = uploadEntityIds(queue, buffer, { ...state, entityIdsGeneration: 6 }, marker);
    expect(r).toEqual({ generation: 6, uploaded: true });
    expect(writes).toHaveLength(2);
  });

  it('uploads every frame when the generation is missing (NaN never matches)', () => {
    const { queue, writes } = recordingQueue();
    let marker = NaN;
    for (let frame = 0; frame < 3; frame++) {
      const r = uploadEntityIds(queue, buffer, { entityIds: ids, entityCount: 3, entityIdsGeneration: undefined as unknown as number }, marker);
      expect(r.uploaded).toBe(true);
      marker = r.generation;
    }
    expect(writes).toHaveLength(3);
  });

  it('writes nothing for an empty world, but moves the marker', () => {
    const { queue, writes } = recordingQueue();
    const r = uploadEntityIds(queue, buffer, { entityIds: new Uint32Array(0), entityCount: 0, entityIdsGeneration: 8 }, 7);
    expect(r).toEqual({ generation: 8, uploaded: false });
    expect(writes).toHaveLength(0);
  });

  // A column shorter than entityCount (an untyped transport site that trims or
  // drops it) must not reach writeBuffer with entityCount elements: that throws
  // OperationError synchronously inside render(), which stops the RAF loop.
  it('clamps a short column to its length, keeps the marker, and uploads the next full column', () => {
    const { queue, writes } = recordingQueue();
    const marker = NaN;
    const short = new Uint32Array([4, 9]);
    const r = uploadEntityIds(queue, buffer, { entityIds: short, entityCount: 3, entityIdsGeneration: 5 }, marker);
    expect(writes).toEqual([{ offset: 0, data: short, dataOffset: 0, size: 2 }]);
    expect(r.uploaded).toBe(true);
    // Not recorded as uploaded: the GPU holds a partial column.
    expect(Number.isNaN(r.generation)).toBe(true);
    expect(r.warning).toMatch(/entityIds holds 2 .*entityCount is 3/);
    // Same generation, full column: uploaded, and now recorded.
    const full = uploadEntityIds(queue, buffer, { entityIds: ids, entityCount: 3, entityIdsGeneration: 5 }, r.generation);
    expect(full).toEqual({ generation: 5, uploaded: true });
    expect(writes.at(-1)).toEqual({ offset: 0, data: ids, dataOffset: 0, size: 3 });
  });

  it('writes nothing for a missing column, and keeps the marker', () => {
    const { queue, writes } = recordingQueue();
    const r = uploadEntityIds(queue, buffer, { entityIds: undefined as unknown as Uint32Array, entityCount: 3, entityIdsGeneration: 5 }, 4);
    expect(writes).toHaveLength(0);
    expect(r.generation).toBe(4);
    expect(r.uploaded).toBe(false);
    expect(r.warning).toMatch(/entityIds holds 0 .*entityCount is 3/);
  });
});

describe('renderer.ts uploads the entity ids on every frame kind', () => {
  it('calls uploadEntityIds once, after the scatter/full-upload if/else and outside both branches', () => {
    const src = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
    const branch = src.indexOf('if (useScatter) {');
    const call = src.indexOf('uploadEntityIds(', branch);
    const mask = src.indexOf('selectionManager.uploadMask(', branch);
    expect(branch).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(branch);
    expect(mask).toBeGreaterThan(call);
    // Every brace the if/else opened is closed before the call: it runs on
    // scatter frames (Mode C spawns) as well as on full uploads.
    const between = src.slice(branch, call);
    const depth = (between.match(/\{/g) ?? []).length - (between.match(/\}/g) ?? []).length;
    expect(depth).toBe(0);
    expect(src.split('uploadEntityIds(').length - 1).toBe(1);
  });
});

describe('missingSortInputs', () => {
  it('names the fields that are absent or not finite', () => {
    expect(missingSortInputs({ transparentCount: 0, entityIdsGeneration: 0 })).toEqual([]);
    expect(missingSortInputs({ transparentCount: NaN, entityIdsGeneration: 3 })).toEqual(['transparentCount']);
    expect(missingSortInputs({ transparentCount: 1, entityIdsGeneration: undefined as unknown as number }))
      .toEqual(['entityIdsGeneration']);
  });
});

describe('overCapacityWarning', () => {
  it('is null up to MAX_GPU_ENTITIES and names the limit past it', () => {
    expect(overCapacityWarning(0)).toBeNull();
    expect(overCapacityWarning(MAX_GPU_ENTITIES)).toBeNull();
    expect(overCapacityWarning(MAX_GPU_ENTITIES + 1)).toContain(`MAX_GPU_ENTITIES (${MAX_GPU_ENTITIES})`);
  });
});

// Round step 8: the dev warning for listed sprite lights without a texture
// times each light on its own, by key (its external id): a counted call adds
// the time since the previous counted call, at most HELD_STEP_CAP_MS, to every
// key it shares with that call; a key new in it starts at 0 and a key it lacks
// is dropped; a call with a texture load in flight pauses the count (it
// neither adds nor drops, and the next counted call does not bridge it). The
// warning fires once, naming the keys that reached UNTEXTURED_SPRITE_MS.
// Whole milliseconds: exact in f64.
describe('persistentWarning', () => {
  type Call = [keys: number[], paused: boolean, now: number];
  /** Each call that warned: its index and the keys it named. */
  const run = (w: ReturnType<typeof persistentWarning>, calls: Call[]): Array<[number, number[]]> =>
    calls.flatMap(([keys, paused, now], i): Array<[number, number[]]> => {
      const due = w.update(keys, paused, now);
      return due.length > 0 ? [[i, due]] : [];
    });
  /** `n` calls `stepMs` apart from `start`, each with `keys`. */
  const ticks = (stepMs: number, n: number, start = 0, keys: number[] = [1], paused = false): Call[] =>
    Array.from({ length: n }, (_, i): Call => [keys, paused, start + i * stepMs]);
  /** One call per frame at `hz` from 0 to `to` ms, each time a whole ms as rAF gives it (exact sums): the keys at `t`, paused where `paused(t)`. */
  const frames = (hz: number, to: number, keys: (t: number) => number[], paused: (t: number) => boolean = () => false): Call[] =>
    Array.from({ length: Math.floor((to * hz) / 1000) + 1 }, (_, k): Call => {
      const t = Math.round((k * 1000) / hz);
      return [keys(t), paused(t), t];
    });
  /** Each warning of a fresh UNTEXTURED_SPRITE_MS tracker over `calls`: its time and the keys it named. */
  const warnedAt = (calls: Call[]): Array<[number, number[]]> =>
    run(persistentWarning(UNTEXTURED_SPRITE_MS), calls).map(([i, keys]) => [calls[i][2], keys]);

  it('warns when a key has held UNTEXTURED_SPRITE_MS (1000 ms), not before', () => {
    expect(UNTEXTURED_SPRITE_MS).toBe(1000);
    expect(HELD_STEP_CAP_MS).toBe(100);
    expect(run(persistentWarning(UNTEXTURED_SPRITE_MS), ticks(8, 125)), '992 ms').toEqual([]);
    expect(run(persistentWarning(UNTEXTURED_SPRITE_MS), ticks(8, 126)), '1000 ms').toEqual([[125, [1]]]);
    expect(run(persistentWarning(UNTEXTURED_SPRITE_MS), ticks(16, 64)), '1008 ms').toEqual([[63, [1]]]);
  });

  it('warns once, never again, whatever follows', () => {
    expect(run(persistentWarning(100), [...ticks(10, 11), [[], false, 110], ...ticks(10, 30, 120), ...ticks(10, 30, 420, [2])])).toEqual([[10, [1]]]);
  });

  it('a counted call without a key drops it: a texture that lands in time raises nothing, even while another light is held', () => {
    expect(run(persistentWarning(100), [...ticks(10, 10), [[], false, 100], ...ticks(10, 10, 110)])).toEqual([]);
    // Key 1 is dropped at 100 and key 2 at 110: neither held 100 ms.
    expect(run(persistentWarning(100), [...ticks(10, 10), [[2], false, 100], ...ticks(10, 10, 110)])).toEqual([]);
  });

  it('a key new in a call starts at 0 (no time from before it was there), and only the keys that reached the time are named', () => {
    expect(run(persistentWarning(100), [[[1], false, 0], [[1], false, 50], [[1, 2], false, 90], [[1, 2], false, 100], [[1, 2], false, 300]])).toEqual([[3, [1]]]);
  });

  it('a call with a texture load in flight neither adds nor drops, and the paused gap is not bridged', () => {
    expect(run(persistentWarning(100), [...ticks(10, 6), ...ticks(10, 50, 60, [1], true), ...ticks(10, 7, 560)])).toEqual([[61, [1]]]);
    expect(run(persistentWarning(100), ticks(10, 500, 0, [1], true)), 'a load always in flight').toEqual([]);
    // A paused call drops no key, whatever keys it carries: key 1 keeps its 50 ms and reaches 100 at t = 120.
    expect(run(persistentWarning(100), [...ticks(10, 6), [[], true, 60], ...ticks(10, 10, 70)])).toEqual([[12, [1]]]);
  });

  it('one call adds at most HELD_STEP_CAP_MS, and slow frames still warn', () => {
    expect(run(persistentWarning(1000), [[[1], false, 0], [[1], false, 5000], [[1], false, 5008]]), 'a 5-s stall').toEqual([]);
    expect(run(persistentWarning(1000), ticks(250, 11)), '250-ms frames').toEqual([[10, [1]]]);
  });

  // The review's scenarios (wf_a2ed3389-7aa, AR6), at the frame steps of 60 and 120 Hz.
  for (const hz of [60, 120]) {
    it(`untextured stretches on different lights never add up (${hz} Hz): light 10 below 700 ms, light 11 from 500 to 1200 ms`, () => {
      expect(warnedAt(frames(hz, 1500, (t) => [...(t < 700 ? [10] : []), ...(t >= 500 && t < 1200 ? [11] : [])]))).toEqual([]);
    });

    it(`six lights untextured 300 ms each, the next one appearing in the frame the previous gets its texture, raise nothing (${hz} Hz)`, () => {
      expect(warnedAt(frames(hz, 2000, (t) => (t < 1800 ? [20 + Math.floor(t / 300)] : [])))).toEqual([]);
    });

    it(`one light untextured for 1100 ms warns once, at 1000 ms, naming it; a later light held 1500 ms raises nothing more (${hz} Hz)`, () => {
      expect(warnedAt(frames(hz, 3500, (t) => (t < 1100 ? [10] : t >= 1500 && t < 3000 ? [12] : [])))).toEqual([[1000, [10]]]);
    });

    it(`two seconds of a load in flight in the middle neither add nor reset: the warning comes after a second of counted time in all (${hz} Hz)`, () => {
      // 600 ms counted, paused while 600 < t < 2600, counted again: 1000 ms at t = 3000.
      expect(warnedAt(frames(hz, 4000, () => [10], (t) => t > 600 && t < 2600))).toEqual([[3000, [10]]]);
    });

    it(`two lights untextured past a second warn once, naming both (${hz} Hz)`, () => {
      expect(warnedAt(frames(hz, 1500, () => [10, 11]))).toEqual([[1000, [10, 11]]]);
    });
  }
});

describe('untexturedSpriteMessage', () => {
  it('names up to three sprite lights by id, then how many more; says why the light is dark and what to do', () => {
    expect(untexturedSpriteMessage([42])).toMatch(/^\[Hyperion\] Sprite light 42 has no texture/);
    expect(untexturedSpriteMessage([42, 57])).toMatch(/^\[Hyperion\] Sprite lights 42, 57 have no texture/);
    expect(untexturedSpriteMessage([42, 57, 61, 70, 71])).toMatch(/^\[Hyperion\] Sprite lights 42, 57, 61 and 2 more have no texture/);
    expect(untexturedSpriteMessage([])).toMatch(/^\[Hyperion\] A sprite light has no texture/);
    // The anonymous key (no id column) names nobody.
    expect(untexturedSpriteMessage([UNNAMED_SPRITE_LIGHT])).toBe(untexturedSpriteMessage([]));
    for (const ids of [[], [42], [42, 57, 61, 70, 71]]) {
      const message = untexturedSpriteMessage(ids);
      expect(message).toContain('no texture load in flight');
      expect(message).toContain('const cookie = await engine.loadTexture(url)');
      expect(message).toMatch(/rejected/);
      expect(message).toMatch(/Mode A/);
    }
  });

  it('says what counts as no texture since the used layers count (sub-decision 4 (c)): an index this renderer did not load', () => {
    for (const ids of [[], [42]]) {
      const message = untexturedSpriteMessage(ids);
      expect(message).toContain('no texture this renderer loaded (index 0, the reserved layer 0, or a handle from another session, a tape, a snapshot or Mode A)');
      expect(message).toContain('a handle is valid only in the session that loaded it');
    }
  });
});

// Round step 8 (sub-decision 4 (c)): the used layers of the eight texture
// arrays, in the order deriveLightGroups reads them.
describe('textureLayerCounts', () => {
  it('lists the used layers of primary tiers 0-3, then overflow 0-3, into `out` when given one', () => {
    const tm = { getLayerCount: (t: number) => 10 + t, getOverflowLayerCount: (t: number) => 20 + t };
    expect([...textureLayerCounts(tm)]).toEqual([10, 11, 12, 13, 20, 21, 22, 23]);
    const out = new Uint16Array(8);
    expect(textureLayerCounts(tm, out)).toBe(out);
    expect([...out]).toEqual([10, 11, 12, 13, 20, 21, 22, 23]);
  });
});
