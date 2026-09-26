import type { ResourcePool } from '../resource-pool';
import { JFA_FORMAT } from '../formats';
import { JFAPass } from './jfa-pass';
import { SLICE } from './light-accum-stage';

/** JFAParams: stepSize, texelSizeX, texelSizeY, pad. */
const PARAMS_SIZE = 16;

/**
 * Floods an occluder seed into the signed SDF (Phase 17; a stage of
 * LightGroupsPass, run once per SDF set over the SAME ping-pong pair).
 *
 * Every texel ends up knowing its nearest texel of the OPPOSITE kind: an
 * outside texel the nearest occluder texel, an inside texel the nearest free
 * one. Each keeps its own kind in alpha, which gives the sign. That is Godot's
 * single-chain trick (`canvas_sdf.glsl`): a neighbour of the other kind is its
 * own seed, so both fronts flood in one chain. Layout: (nearest-opposite u, v,
 * valid, inside), in JFA_FORMAT.
 *
 * The chain is 1+JFA (Rong & Tan): a step-1 pass before the halving steps. JFA
 * only over-estimates distance, and an over-estimate is what lets a
 * sphere-march step tunnel through a thin occluder; 1+JFA gets about JFA+2
 * accuracy for the cost of JFA+1. The first pass also converts the raw seed
 * into the signed state (`LOAD_PASS`).
 *
 * The steps are powers of two, 2^(m-1) … 1: their reach, 2^m - 1, covers every
 * target up to 2^m. The length comes from the target size every frame
 * (`prepare`), so a resize needs no new graph.
 */
export class SdfChainStage {
  /** WGSL shader source (`sdf-jfa.wgsl`). Set before calling `setup()`. */
  static SHADER_SOURCE = '';

  /** Passes in the chain for a target whose larger side is `maxDim` texels. */
  static chainLength(maxDim: number): number {
    return 1 + JFAPass.iterationsForDimension(maxDim);
  }

  /** The step sizes: 1 (the load pass), then 2^(m-1) … 1. */
  static steps(maxDim: number): number[] {
    const m = JFAPass.iterationsForDimension(maxDim);
    return [1, ...Array.from({ length: m }, (_, i) => 2 ** (m - 1 - i))];
  }

  private loadPipeline: GPURenderPipeline | null = null;
  private stepPipeline: GPURenderPipeline | null = null;
  private layout: GPUBindGroupLayout | null = null;
  private paramBuffer: GPUBuffer | null = null;
  private slices = 0;
  private stepCount = 0;
  /** Per step: the bind group, and the input view it was made with. */
  private readonly bindGroups = new Map<number, { group: GPUBindGroup; input: GPUTextureView }>();
  private device: GPUDevice | null = null;

  setup(device: GPUDevice, _resources: ResourcePool): void {
    if (!SdfChainStage.SHADER_SOURCE) {
      throw new Error('SdfChainStage.SHADER_SOURCE must be set before setup()');
    }
    this.device = device;
    // sdf-jfa.wgsl reads with textureLoad only: no sampler (binding 1 is unused).
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: PARAMS_SIZE } },
      ],
    });
    const module = device.createShaderModule({ code: SdfChainStage.SHADER_SOURCE });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const pipeline = (load: number) => device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: JFA_FORMAT }], constants: { LOAD_PASS: load } },
      primitive: { topology: 'triangle-list' },
    });
    this.loadPipeline = pipeline(1);
    this.stepPipeline = pipeline(0);
  }

  /** One param slice per step for a `width` × `height` target, written in one call. Grow-only. */
  prepare(device: GPUDevice, width: number, height: number): void {
    if (!this.layout) return;
    const steps = SdfChainStage.steps(Math.max(width, height));
    if (!this.paramBuffer || steps.length > this.slices) {
      this.paramBuffer?.destroy();
      this.paramBuffer = device.createBuffer({ size: steps.length * SLICE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.slices = steps.length;
      this.bindGroups.clear();
    }
    const data = new ArrayBuffer(steps.length * SLICE);
    steps.forEach((step, i) => {
      new Float32Array(data, i * SLICE, 4).set([step, 1 / width, 1 / height, 0]);
    });
    device.queue.writeBuffer(this.paramBuffer, 0, data);
    this.stepCount = steps.length;
  }

  /**
   * Flood `seed` through the ping-pong pair: step i writes `a` when i is even,
   * `b` when odd, and reads the previous step (the seed, for step 0).
   * @returns the view holding the final SDF.
   */
  encode(encoder: GPUCommandEncoder, seed: GPUTextureView, a: GPUTextureView, b: GPUTextureView): GPUTextureView {
    let input = seed;
    let output = a;
    if (!this.loadPipeline || !this.stepPipeline) return a;
    for (let i = 0; i < this.stepCount; i++) {
      output = i % 2 === 0 ? a : b;
      const group = this.bindGroupFor(i, input);
      if (!group) return output;
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: output, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
      pass.setPipeline(i === 0 ? this.loadPipeline : this.stepPipeline);
      pass.setBindGroup(0, group);
      pass.draw(3); // full-screen triangle
      pass.end();
      input = output;
    }
    return output;
  }

  private bindGroupFor(step: number, input: GPUTextureView): GPUBindGroup | null {
    if (!this.device || !this.layout || !this.paramBuffer) return null;
    const cached = this.bindGroups.get(step);
    if (cached && cached.input === input) return cached.group;
    const group = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: input },
        { binding: 2, resource: { buffer: this.paramBuffer, offset: step * SLICE, size: PARAMS_SIZE } },
      ],
    });
    this.bindGroups.set(step, { group, input });
    return group;
  }

  destroy(): void {
    this.paramBuffer?.destroy();
    this.paramBuffer = null;
    this.slices = 0;
    this.stepCount = 0;
    this.bindGroups.clear();
    this.loadPipeline = null;
    this.stepPipeline = null;
    this.layout = null;
    this.device = null;
  }
}
