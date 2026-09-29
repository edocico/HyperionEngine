import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateConfig, MAX_GPU_ENTITIES, type HyperionConfig } from './types';

describe('validateConfig', () => {
  it('returns defaults for minimal config', () => {
    const canvas = {} as HTMLCanvasElement;
    const cfg = validateConfig({ canvas });
    expect(cfg.canvas).toBe(canvas);
    expect(cfg.maxEntities).toBe(100_000);
    expect(cfg.commandBufferSize).toBe(64 * 1024);
    expect(cfg.backpressure).toBe('retry-queue');
    expect(cfg.fixedTimestep).toBeCloseTo(1 / 60);
    expect(cfg.preferredMode).toBe('auto');
  });

  it('preserves user overrides', () => {
    const canvas = {} as HTMLCanvasElement;
    const cfg = validateConfig({
      canvas,
      maxEntities: 50_000,
      backpressure: 'drop',
      preferredMode: 'C',
    });
    expect(cfg.maxEntities).toBe(50_000);
    expect(cfg.backpressure).toBe('drop');
    expect(cfg.preferredMode).toBe('C');
  });

  it('throws on missing canvas', () => {
    expect(() => validateConfig({} as HyperionConfig)).toThrow('canvas is required');
  });

  it('throws on invalid maxEntities', () => {
    const canvas = {} as HTMLCanvasElement;
    expect(() => validateConfig({ canvas, maxEntities: -1 })).toThrow('maxEntities');
    expect(() => validateConfig({ canvas, maxEntities: 0 })).toThrow('maxEntities');
  });

  it('defaults maxEntities to MAX_GPU_ENTITIES and accepts exactly that many', () => {
    const canvas = {} as HTMLCanvasElement;
    expect(validateConfig({ canvas }).maxEntities).toBe(MAX_GPU_ENTITIES);
    expect(validateConfig({ canvas, maxEntities: MAX_GPU_ENTITIES }).maxEntities).toBe(MAX_GPU_ENTITIES);
  });

  it('rejects maxEntities above MAX_GPU_ENTITIES, naming the limit', () => {
    const canvas = {} as HTMLCanvasElement;
    expect(() => validateConfig({ canvas, maxEntities: MAX_GPU_ENTITIES + 1 }))
      .toThrow(`maxEntities (${MAX_GPU_ENTITIES + 1}) exceeds MAX_GPU_ENTITIES (${MAX_GPU_ENTITIES})`);
  });
});

describe('MAX_GPU_ENTITIES', () => {
  it('is the only copy of the GPU capacity (phase 5b §6.4)', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const literals = (src: string) => (src.match(/\b100_000\b/g) ?? []).length;
    expect(literals(read('./types.ts')), 'types.ts: the declaration only').toBe(1);
    expect(literals(read('./renderer.ts')), 'renderer.ts').toBe(0);
    expect(literals(read('./render/passes/cull-pass.ts')), 'cull-pass.ts').toBe(0);
  });
});
