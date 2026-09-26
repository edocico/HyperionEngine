import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import { JFA_FORMAT } from '../formats';

/**
 * One iteration of a Jump Flood chain, as a `RenderPass` node.
 *
 * The Jump Flood Algorithm needs about log2(maxDim) iterations, each halving
 * the step size. Each iteration is a separate node, so the RenderGraph's
 * topological sort orders them. The graph allows one writer per resource, so
 * every iteration writes a uniquely named resource. The renderer maps those
 * names onto two physical ping-pong textures (`outputPhysical`).
 *
 * Two chains share this base:
 * - `JFAPass`, the outline chain: `selection-seed` → `jfa-iter-N`, full
 *   resolution, `jfa.wgsl`;
 * - `SdfJfaPass`, the signed-SDF chain: `occluder-seed` → `sdf-iter-N`, half
 *   resolution, `sdf-jfa.wgsl`.
 * Each subclass owns its shader in a static slot of its own, so shader
 * hot-reload keeps one slot per WGSL file, and the chains cannot pick up each
 * other's shader. They are siblings rather than parent and child: the renderer
 * finds the outline chain with `instanceof JFAPass`.
 */
export abstract class JfaIterationPass implements RenderPass {
  readonly reads: string[];
  readonly writes: string[];
  readonly optional = true;

  private pipeline: GPURenderPipeline | null = null;
  private paramBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  private device: GPUDevice | null = null;

  /**
   * @param name graph node name, unique across the graph
   * @param inputResource texture resource read by this iteration
   * @param outputResource texture resource written by this iteration
   * @param stepSize jump distance, in texels of the chain's target
   * @param outputPhysical which ping-pong texture (0 or 1) backs the output
   */
  constructor(
    readonly name: string,
    readonly inputResource: string,
    readonly outputResource: string,
    readonly stepSize: number,
    readonly outputPhysical: number,
  ) {
    this.reads = [inputResource];
    this.writes = [outputResource];
  }

  /** The WGSL module, read at `setup()`. */
  protected abstract shaderSource(): string;

  /** Size in texels of the textures this chain runs on. */
  protected abstract targetSize(frame: FrameState): [number, number];

  /** Pipeline-overridable constants of the fragment stage. */
  protected fragmentConstants(): Record<string, number> {
    return {};
  }

  setup(device: GPUDevice, _resources: ResourcePool): void {
    this.device = device;

    const code = this.shaderSource();
    if (!code) {
      throw new Error(`${this.constructor.name}.SHADER_SOURCE must be set before setup()`);
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

    const shaderModule = device.createShaderModule({ code });

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
        targets: [{ format: JFA_FORMAT }],
        constants: this.fragmentConstants(),
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.paramBuffer) return;
    const [width, height] = this.targetSize(frame);
    const data = new ArrayBuffer(16);
    const f32 = new Float32Array(data);
    f32[0] = this.stepSize;
    f32[1] = 1.0 / width;
    f32[2] = 1.0 / height;
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

/**
 * One iteration of the OUTLINE chain.
 *
 * Iteration 0 reads `selection-seed`, iteration N reads `jfa-iter-(N-1)`, and
 * the last iteration's output is the JFA result that OutlineCompositePass reads.
 * Runs at canvas resolution.
 */
export class JFAPass extends JfaIterationPass {
  /** WGSL shader source (`jfa.wgsl`). Set before calling `setup()`. */
  static SHADER_SOURCE = '';

  /** Which iteration index (0-based) this pass represents. */
  readonly iterationIndex: number;

  /** Total iterations for this JFA pipeline. */
  readonly totalIterations: number;

  constructor(iterationIndex: number, totalIterations: number, maxDimension: number) {
    super(
      `jfa-${iterationIndex}`,
      iterationIndex === 0 ? 'selection-seed' : `jfa-iter-${iterationIndex - 1}`,
      `jfa-iter-${iterationIndex}`,
      // Step size: starts at maxDim/2, halves each iteration
      Math.max(1, Math.floor(maxDimension / Math.pow(2, iterationIndex + 1))),
      // Physical ping-pong: even iterations write to texture 0, odd to texture 1
      iterationIndex % 2,
    );
    this.iterationIndex = iterationIndex;
    this.totalIterations = totalIterations;
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

  protected shaderSource(): string {
    return JFAPass.SHADER_SOURCE;
  }

  protected targetSize(frame: FrameState): [number, number] {
    return [frame.canvasWidth, frame.canvasHeight];
  }
}
