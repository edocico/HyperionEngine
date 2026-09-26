import type { FrameState } from '../render-pass';
import { JFAPass, JfaIterationPass } from './jfa-pass';
import { halfResolution } from './occluder-seed-pass';

/**
 * One iteration of the SIGNED-SDF chain (Phase 17, Task 8): floods
 * `occluder-seed` into `sdf-iter-N`.
 *
 * Every pixel ends up knowing its nearest pixel of the opposite kind: an
 * outside pixel knows the nearest occluder pixel, an inside pixel the nearest
 * free one. Each pixel keeps its own kind in alpha, which gives the sign. The
 * trick is Godot's (`canvas_sdf.glsl`): a neighbour of the other kind acts as
 * its own seed, so the inside and outside fronts flood in ONE chain. Layout:
 * (nearest-opposite u, v, valid, inside), in JFA_FORMAT, at `halfResolution`.
 *
 * The chain is 1+JFA (Rong & Tan): a step-1 pass BEFORE the standard halving
 * steps. JFA only ever over-estimates distance, and an over-estimate is exactly
 * what lets a sphere-march step tunnel through a thin occluder. 1+JFA gets
 * about JFA+2 accuracy for the cost of JFA+1. The first pass also converts the
 * raw seed (occluder pixels (u, v, 1, 1), free pixels zero) into the signed
 * state (`LOAD_PASS`).
 */
export class SdfJfaPass extends JfaIterationPass {
  /** WGSL shader source (`sdf-jfa.wgsl`). Set before calling `setup()`. */
  static SHADER_SOURCE = '';

  private constructor(index: number, stepSize: number) {
    super(
      `sdf-${index}`,
      index === 0 ? 'occluder-seed' : `sdf-iter-${index - 1}`,
      `sdf-iter-${index}`,
      stepSize,
      index % 2,
    );
  }

  /**
   * The whole chain for a half-resolution target whose larger side is
   * `maxDim` texels: a step-1 load pass, then the standard steps maxDim/2 … 1.
   */
  static chain(maxDim: number): SdfJfaPass[] {
    const standard = JFAPass.iterationsForDimension(maxDim);
    const steps = [1, ...Array.from({ length: standard }, (_, i) =>
      Math.max(1, Math.floor(maxDim / Math.pow(2, i + 1))))];
    return steps.map((step, i) => new SdfJfaPass(i, step));
  }

  /** The resource the last pass of a chain of `chainLength` writes: the signed SDF. */
  static finalOutputResource(chainLength: number): string {
    return `sdf-iter-${chainLength - 1}`;
  }

  protected shaderSource(): string {
    return SdfJfaPass.SHADER_SOURCE;
  }

  protected targetSize(frame: FrameState): [number, number] {
    return halfResolution(frame.canvasWidth, frame.canvasHeight);
  }

  protected fragmentConstants(): Record<string, number> {
    return { LOAD_PASS: this.inputResource === 'occluder-seed' ? 1 : 0 };
  }
}
