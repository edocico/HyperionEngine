import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';

/**
 * Single JFA iteration pass.
 *
 * The Jump Flood Algorithm requires log2(maxDim) iterations, each halving the
 * step size.  We model each iteration as a separate `RenderPass` node in the
 * `RenderGraph` DAG so that the topological sort naturally orders them.
 *
 * To satisfy the RenderGraph's "one writer per resource" constraint, each
 * iteration writes to a uniquely named resource (`jfa-iter-0`, `jfa-iter-1`,
 * etc.).  The renderer coordinator maps these names to actual ping-pong
 * texture views (two physical RGBA16Float textures).
 *
 * Iteration 0 reads `selection-seed`.
 * Iteration N reads `jfa-iter-(N-1)`.
 * The final iteration's output is the JFA result.
 */
export class JFAPass implements RenderPass {
  readonly name: string;
  readonly reads: string[];
  readonly writes: string[];
  readonly optional = true;

  private pipeline: GPURenderPipeline | null = null;
  private paramBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  private device: GPUDevice | null = null;

  /** Which iteration index (0-based) this pass represents. */
  readonly iterationIndex: number;

  /** Total iterations for this JFA pipeline. */
  readonly totalIterations: number;

  /** Step size in pixels for this iteration. */
  readonly stepSize: number;

  /** Name of the output texture resource written by this pass. */
  readonly outputResource: string;

  /** Name of the input texture resource read by this pass. */
  readonly inputResource: string;

  /**
   * Which physical ping-pong texture (0 or 1) backs the output.
   * The renderer coordinator uses this to set the correct view.
   */
  readonly outputPhysical: number;

  /**
   * WGSL shader source. Set before calling `setup()`.
   */
  static SHADER_SOURCE = '';

  constructor(iterationIndex: number, totalIterations: number, maxDimension: number) {
    this.iterationIndex = iterationIndex;
    this.totalIterations = totalIterations;

    // Step size: starts at maxDim/2, halves each iteration
    this.stepSize = Math.max(1, Math.floor(maxDimension / Math.pow(2, iterationIndex + 1)));

    // Each iteration writes to a unique resource name for the DAG
    this.outputResource = `jfa-iter-${iterationIndex}`;
    this.name = `jfa-${iterationIndex}`;

    // First iteration reads from the seed pass output
    if (iterationIndex === 0) {
      this.inputResource = 'selection-seed';
    } else {
      this.inputResource = `jfa-iter-${iterationIndex - 1}`;
    }

    // Physical ping-pong: even iterations write to texture 0, odd to texture 1
    // (but iteration 0 also writes to texture 0)
    this.outputPhysical = iterationIndex % 2;

    this.reads = [this.inputResource];
    this.writes = [this.outputResource];
  }

  /**
   * Compute the number of JFA iterations needed for a given resolution.
   */
  static iterationsForDimension(maxDim: number): number {
    return Math.max(1, Math.ceil(Math.log2(maxDim)));
  }

  /**
   * Determine the final output resource name for a set of JFA passes.
   */
  static finalOutputResource(totalIterations: number): string {
    if (totalIterations === 0) return 'selection-seed';
    return `jfa-iter-${totalIterations - 1}`;
  }

  setup(device: GPUDevice, _resources: ResourcePool): void {
    this.device = device;

    if (!JFAPass.SHADER_SOURCE) {
      throw new Error('JFAPass.SHADER_SOURCE must be set before setup()');
    }

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // JFAParams: stepSize (f32) + texelSize (vec2f) + pad (f32) = 16 bytes
    this.paramBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shaderModule = device.createShaderModule({ code: JFAPass.SHADER_SOURCE });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.paramBuffer) return;
    const data = new ArrayBuffer(16);
    const f32 = new Float32Array(data);
    f32[0] = this.stepSize;
    f32[1] = 1.0 / frame.canvasWidth;
    f32[2] = 1.0 / frame.canvasHeight;
    f32[3] = 0; // padding
    device.queue.writeBuffer(this.paramBuffer, 0, data);
  }

  execute(encoder: GPUCommandEncoder, _frame: FrameState, resources: ResourcePool): void {
    if (!this.pipeline || !this.paramBuffer || !this.sampler || !this.device) return;

    const inputView = resources.getTextureView(this.inputResource);
    const outputView = resources.getTextureView(this.outputResource);
    if (!inputView || !outputView) return;

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: inputView },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.paramBuffer } },
      ],
    });

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        loadOp: 'clear' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.draw(3); // Full-screen triangle
    renderPass.end();
  }

  resize(_width: number, _height: number): void {
    // JFA textures are managed by the renderer coordinator
  }

  destroy(): void {
    this.paramBuffer?.destroy();
    this.pipeline = null;
    this.paramBuffer = null;
    this.sampler = null;
    this.device = null;
  }
}
