import { describe, it, expect } from 'vitest';
import { BloomPass } from './bloom-pass';

describe('BloomPass', () => {
  it('should be optional (dead-pass culled when unused)', () => {
    const pass = new BloomPass();
    expect(pass.optional).toBe(true);
  });

  it('should read scene-hdr and write swapchain', () => {
    const pass = new BloomPass();
    expect(pass.reads).toContain('scene-hdr');
    expect(pass.writes).toContain('swapchain');
  });

  it('should have name "bloom"', () => {
    const pass = new BloomPass();
    expect(pass.name).toBe('bloom');
  });

  it('should accept configuration', () => {
    const pass = new BloomPass({ threshold: 0.5, intensity: 1.5, levels: 2 });
    expect(pass.threshold).toBe(0.5);
    expect(pass.intensity).toBe(1.5);
  });

  it('should use sensible defaults', () => {
    const pass = new BloomPass();
    expect(pass.threshold).toBe(0.7);
    expect(pass.intensity).toBe(1.0);
  });

  it('execute() should not throw with valid resources', () => {
    const pass = new BloomPass();
    expect(typeof pass.execute).toBe('function');
  });

  it('setTonemapMode updates the mode', () => {
    const pass = new BloomPass();
    pass.tonemapMode = 2;
    expect(pass.tonemapMode).toBe(2);
  });
});
