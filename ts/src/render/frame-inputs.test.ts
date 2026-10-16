import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  normalizeTransparentCount, normalizeIdsGeneration, nextFrameStamp,
  uploadEntityIds, missingSortInputs, overCapacityWarning,
  persistentWarning, untexturedSpriteMessage, UNTEXTURED_SPRITE_MS, HELD_STEP_CAP_MS,
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

// Round step 8: the dev warning for a sprite light without a texture fires
// once the flag has held for UNTEXTURED_SPRITE_MS of lit frame time, each
// call adding at most HELD_STEP_CAP_MS; a call with a texture load in flight
// pauses the count (it neither adds nor resets), a call without the flag
// resets it. Whole milliseconds: exact in f64.
describe('persistentWarning', () => {
  type Call = [raised: boolean, paused: boolean, now: number];
  const run = (w: { update(raised: boolean, paused: boolean, now: number): boolean }, calls: Call[]): number[] =>
    calls.flatMap(([raised, paused, now], i) => (w.update(raised, paused, now) ? [i] : []));
  /** `n` calls `stepMs` apart from `start`. */
  const ticks = (stepMs: number, n: number, start = 0, raised = true, paused = false): Call[] =>
    Array.from({ length: n }, (_, i): Call => [raised, paused, start + i * stepMs]);

  it('warns when the flag has held UNTEXTURED_SPRITE_MS (1000 ms), not before', () => {
    expect(UNTEXTURED_SPRITE_MS).toBe(1000);
    expect(HELD_STEP_CAP_MS).toBe(100);
    expect(run(persistentWarning(UNTEXTURED_SPRITE_MS), ticks(8, 125)), '992 ms').toEqual([]);
    expect(run(persistentWarning(UNTEXTURED_SPRITE_MS), ticks(8, 126)), '1000 ms').toEqual([125]);
    expect(run(persistentWarning(UNTEXTURED_SPRITE_MS), ticks(16, 64)), '1008 ms').toEqual([63]);
  });

  it('warns once, never again, whatever follows', () => {
    expect(run(persistentWarning(100), [...ticks(10, 11), [false, false, 110], ...ticks(10, 30, 120)])).toEqual([10]);
  });

  it('a call without the flag resets the count: a texture that lands in time raises nothing', () => {
    expect(run(persistentWarning(100), [...ticks(10, 10), [false, false, 100], ...ticks(10, 10, 110)])).toEqual([]);
  });

  it('a call with a texture load in flight neither adds nor resets, and the paused gap is not bridged', () => {
    expect(run(persistentWarning(100), [...ticks(10, 6), ...ticks(10, 50, 60, true, true), ...ticks(10, 7, 560)])).toEqual([61]);
    expect(run(persistentWarning(100), ticks(10, 500, 0, true, true)), 'a load always in flight').toEqual([]);
  });

  it('one call adds at most HELD_STEP_CAP_MS, and slow frames still warn', () => {
    expect(run(persistentWarning(1000), [[true, false, 0], [true, false, 5000], [true, false, 5008]]), 'a 5-s stall').toEqual([]);
    expect(run(persistentWarning(1000), ticks(250, 11)), '250-ms frames').toEqual([10]);
  });
});

describe('untexturedSpriteMessage', () => {
  it('names up to three sprite lights by id, then how many more; says why the light is dark and what to do', () => {
    expect(untexturedSpriteMessage([42])).toMatch(/^\[Hyperion\] Sprite light 42 has no texture/);
    expect(untexturedSpriteMessage([42, 57])).toMatch(/^\[Hyperion\] Sprite lights 42, 57 have no texture/);
    expect(untexturedSpriteMessage([42, 57, 61, 70, 71])).toMatch(/^\[Hyperion\] Sprite lights 42, 57, 61 and 2 more have no texture/);
    expect(untexturedSpriteMessage([])).toMatch(/^\[Hyperion\] A sprite light has no texture/);
    for (const ids of [[], [42], [42, 57, 61, 70, 71]]) {
      const message = untexturedSpriteMessage(ids);
      expect(message).toContain('no texture load in flight');
      expect(message).toContain('const cookie = await engine.loadTexture(url)');
      expect(message).toMatch(/rejected/);
      expect(message).toMatch(/Mode A/);
    }
  });
});
