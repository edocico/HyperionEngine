import { describe, it, expect } from 'vitest';
import { ForwardPass } from './forward-pass';

describe('ForwardPass', () => {
  it('should implement RenderPass interface', () => {
    const pass = new ForwardPass();
    expect(pass.name).toBe('forward');
    expect(pass.reads).toContain('visible-indices');
    expect(pass.reads).toContain('entity-transforms');
    expect(pass.reads).toContain('tex-indices');
    expect(pass.reads).toContain('indirect-args');
    expect(pass.writes).toContain('swapchain');
    expect(pass.optional).toBe(false);
  });

  it('should declare render-meta and prim-params as read dependencies', () => {
    const pass = new ForwardPass();
    expect(pass.reads).toContain('render-meta');
    expect(pass.reads).toContain('prim-params');
  });
});
