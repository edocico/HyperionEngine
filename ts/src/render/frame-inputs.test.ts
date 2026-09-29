import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  normalizeTransparentCount, normalizeIdsGeneration, nextFrameStamp,
  uploadEntityIds, missingSortInputs, overCapacityWarning,
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
