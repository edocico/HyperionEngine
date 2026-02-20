import { describe, it, expect } from 'vitest';
import { validateConfig, type HyperionConfig } from './types';

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
});
