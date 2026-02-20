import { describe, it, expect } from 'vitest';
import { FXAATonemapPass } from './fxaa-tonemap-pass';

describe('FXAATonemapPass', () => {
  it('should be optional (dead-pass culled when unused)', () => {
    const pass = new FXAATonemapPass();
    expect(pass.optional).toBe(true);
  });

  it('should read scene-hdr and write swapchain', () => {
    const pass = new FXAATonemapPass();
    expect(pass.reads).toContain('scene-hdr');
    expect(pass.writes).toContain('swapchain');
  });

  it('should accept tonemap mode', () => {
    const pass = new FXAATonemapPass();
    pass.setTonemapMode(1);
    // No error thrown
  });
});
