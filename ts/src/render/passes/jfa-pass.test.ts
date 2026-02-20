import { describe, it, expect } from 'vitest';
import { JFAPass } from './jfa-pass';

describe('JFAPass', () => {
  it('should be optional', () => {
    const pass = new JFAPass(0, 10, 1920);
    expect(pass.optional).toBe(true);
  });

  it('should compute correct step size', () => {
    // For 1920 max dim:
    // iter 0: 1920 / 2^1 = 960
    // iter 1: 1920 / 2^2 = 480
    // iter 9: 1920 / 2^10 ≈ 1
    const pass0 = new JFAPass(0, 10, 1920);
    expect(pass0.stepSize).toBe(960);

    const pass1 = new JFAPass(1, 10, 1920);
    expect(pass1.stepSize).toBe(480);

    const pass9 = new JFAPass(9, 10, 1920);
    expect(pass9.stepSize).toBe(1);
  });

  it('first iteration should read selection-seed', () => {
    const pass = new JFAPass(0, 10, 1920);
    expect(pass.inputResource).toBe('selection-seed');
    expect(pass.reads).toContain('selection-seed');
  });

  it('subsequent iterations should read previous iteration output', () => {
    const pass1 = new JFAPass(1, 10, 1920);
    expect(pass1.inputResource).toBe('jfa-iter-0');
    expect(pass1.reads).toContain('jfa-iter-0');

    const pass5 = new JFAPass(5, 10, 1920);
    expect(pass5.inputResource).toBe('jfa-iter-4');
    expect(pass5.reads).toContain('jfa-iter-4');
  });

  it('each iteration should write to a unique resource', () => {
    const names = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const pass = new JFAPass(i, 10, 1920);
      names.add(pass.outputResource);
    }
    // All 10 output resource names should be unique
    expect(names.size).toBe(10);
  });

  it('should compute correct iteration count for various resolutions', () => {
    expect(JFAPass.iterationsForDimension(1)).toBe(1);
    expect(JFAPass.iterationsForDimension(2)).toBe(1);
    expect(JFAPass.iterationsForDimension(4)).toBe(2);
    expect(JFAPass.iterationsForDimension(1024)).toBe(10);
    expect(JFAPass.iterationsForDimension(1920)).toBe(11);
  });

  it('should determine final output resource', () => {
    expect(JFAPass.finalOutputResource(0)).toBe('selection-seed');
    expect(JFAPass.finalOutputResource(1)).toBe('jfa-iter-0');
    expect(JFAPass.finalOutputResource(5)).toBe('jfa-iter-4');
    expect(JFAPass.finalOutputResource(10)).toBe('jfa-iter-9');
  });

  it('should use ping-pong physical textures', () => {
    const pass0 = new JFAPass(0, 10, 1920);
    const pass1 = new JFAPass(1, 10, 1920);
    const pass2 = new JFAPass(2, 10, 1920);

    // Physical textures should alternate
    expect(pass0.outputPhysical).toBe(0);
    expect(pass1.outputPhysical).toBe(1);
    expect(pass2.outputPhysical).toBe(0);
  });

  it('should have unique names per iteration', () => {
    const pass0 = new JFAPass(0, 10, 1920);
    const pass1 = new JFAPass(1, 10, 1920);
    expect(pass0.name).toBe('jfa-0');
    expect(pass1.name).toBe('jfa-1');
  });
});
