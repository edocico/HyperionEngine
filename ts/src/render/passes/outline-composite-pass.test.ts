import { describe, it, expect } from 'vitest';
import { OutlineCompositePass } from './outline-composite-pass';

describe('OutlineCompositePass', () => {
  it('should be optional (dead-pass culled when no outlines)', () => {
    const pass = new OutlineCompositePass('jfa-iter-9');
    expect(pass.optional).toBe(true);
  });

  it('should write to swapchain', () => {
    const pass = new OutlineCompositePass('jfa-iter-9');
    expect(pass.writes).toContain('swapchain');
  });

  it('should read scene-hdr and the JFA result', () => {
    const pass = new OutlineCompositePass('jfa-iter-9');
    expect(pass.reads).toContain('scene-hdr');
    expect(pass.reads).toContain('jfa-iter-9');
  });

  it('should accept configurable JFA result resource name', () => {
    const pass = new OutlineCompositePass('jfa-iter-5');
    expect(pass.jfaResultResource).toBe('jfa-iter-5');
    expect(pass.reads).toContain('jfa-iter-5');
  });

  it('should have configurable outline parameters', () => {
    const pass = new OutlineCompositePass('jfa-iter-9');
    pass.outlineColor = [1, 0, 0, 1];
    pass.outlineWidth = 5.0;
    expect(pass.outlineColor).toEqual([1, 0, 0, 1]);
    expect(pass.outlineWidth).toBe(5.0);
  });

  it('should have default outline parameters', () => {
    const pass = new OutlineCompositePass('jfa-iter-9');
    expect(pass.outlineColor).toEqual([1.0, 0.8, 0.0, 1.0]);
    expect(pass.outlineWidth).toBe(3.0);
  });
});
