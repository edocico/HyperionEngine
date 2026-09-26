import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import { SCENE_HDR_FORMAT } from '../formats';

/** extract, 2 downsamples, 2 upsamples, composite. */
const SUB_PASSES = 6;
/** BloomParams is 32 bytes; each sub-pass gets its own slice, aligned for binding offsets. */
const PARAMS_SIZE = 32;
const PARAMS_STRIDE = 256; // minUniformBufferOffsetAlignment

export interface BloomConfig {
  threshold?: number;
  intensity?: number;
  /** Number of blur levels (currently fixed at 3; reserved for future use). */
  levels?: number;
  tonemapMode?: number;
}

/**
 * Dual Kawase Bloom post-process pass.
 *
 * Pipeline: extract bright pixels -> downsample chain -> upsample chain -> composite.
 * Reads scene-hdr and writes to swapchain. When active it is the graph's final
 * composite, replacing FXAATonemapPass (see render/graph-assembly.ts).
 *
 * Bloom intermediate textures (half, quarter, eighth resolution) are managed by the
 * renderer coordinator, not by this pass. The pass reads/writes them from the ResourcePool.
 */
export class BloomPass implements RenderPass {
  static SHADER_SOURCE = '';

  readonly name = 'bloom';
  readonly reads = ['scene-hdr'];
  readonly writes = ['swapchain'];
  readonly optional = true;

  threshold: number;
  intensity: number;
  levels: number;
  tonemapMode: number;

  private extractPipeline: GPURenderPipeline | null = null;
  private downsamplePipeline: GPURenderPipeline | null = null;
  private upsamplePipeline: GPURenderPipeline | null = null;
  private compositePipeline: GPURenderPipeline | null = null;
  private paramBuffer: GPUBuffer | null = null;
  private placeholder: GPUTexture | null = null;
  private placeholderView: GPUTextureView | null = null;
  private sampler: GPUSampler | null = null;
  private device: GPUDevice | null = null;

  constructor(config?: BloomConfig) {
    this.threshold = 0.7;
    this.intensity = 1.0;
    this.levels = 3;
    this.tonemapMode = 1;
    this.configure(config);
  }

  /**
   * Apply a config in place — omitted fields take their defaults, exactly as
   * in the constructor. The parameters are uploaded every frame, so a live
   * pass picks this up without a graph rebuild.
   */
  configure(config?: BloomConfig): void {
    this.threshold = config?.threshold ?? 0.7;
    this.intensity = config?.intensity ?? 1.0;
    this.levels = config?.levels ?? 3;
    this.tonemapMode = config?.tonemapMode ?? 1;
  }

  setup(device: GPUDevice, _resources: ResourcePool): void {
    this.device = device;

    if (!BloomPass.SHADER_SOURCE) {
      throw new Error('BloomPass.SHADER_SOURCE must be set before setup()');
    }

    const module = device.createShaderModule({ code: BloomPass.SHADER_SOURCE });
    const format = navigator.gpu.getPreferredCanvasFormat();

    // Bind group layout shared by all sub-passes:
    // binding 0: uniform params
    // binding 1: input texture
    // binding 2: bloom texture (used by composite, dummy for others)
    // binding 3: sampler
    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const vertex = { module, entryPoint: 'vs_main' };

    // Extract and downsample/upsample write to the HDR intermediates, which
    // must match the format of `scene-hdr` they are derived from.
    const hdrFormat: GPUTextureFormat = SCENE_HDR_FORMAT;

    this.extractPipeline = device.createRenderPipeline({
      layout,
      vertex,
      fragment: { module, entryPoint: 'fs_extract', targets: [{ format: hdrFormat }] },
      primitive: { topology: 'triangle-list' },
    });

    this.downsamplePipeline = device.createRenderPipeline({
      layout,
      vertex,
      fragment: { module, entryPoint: 'fs_downsample', targets: [{ format: hdrFormat }] },
      primitive: { topology: 'triangle-list' },
    });

    this.upsamplePipeline = device.createRenderPipeline({
      layout,
      vertex,
      fragment: { module, entryPoint: 'fs_upsample', targets: [{ format: hdrFormat }] },
      primitive: { topology: 'triangle-list' },
    });

    // Composite writes to swapchain (preferred canvas format)
    this.compositePipeline = device.createRenderPipeline({
      layout,
      vertex,
      fragment: { module, entryPoint: 'fs_composite', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

    // One slice per sub-pass. `queue.writeBuffer` is a queue operation, so
    // every write in a frame lands before the command buffer runs. A single
    // shared slice left all six sub-passes reading the composite's params:
    // full-resolution texel sizes, so the blur was 2-8x narrower than designed.
    this.paramBuffer = device.createBuffer({
      size: SUB_PASSES * PARAMS_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Binding 2 is in the shared layout, so the sub-passes that do not read it
    // still need something bound there. The placeholder is never a render
    // target. It used to be bloom-eighth, which the third sub-pass renders
    // into: sampling and rendering the same texture in one pass invalidates
    // the whole command buffer, so every frame with bloom on was dropped.
    this.placeholder = device.createTexture({
      size: [1, 1],
      format: SCENE_HDR_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.placeholderView = this.placeholder.createView();

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  prepare(_device: GPUDevice, _frame: FrameState): void {
    // Params are written once per frame in execute(), one slice per sub-pass.
  }

  execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool): void {
    if (!this.device || !this.extractPipeline || !this.paramBuffer || !this.sampler || !this.placeholderView) return;

    const sceneView = resources.getTextureView('scene-hdr');
    const swapchainView = resources.getTextureView('swapchain');
    const bloomHalfView = resources.getTextureView('bloom-half');
    const bloomQuarterView = resources.getTextureView('bloom-quarter');
    const bloomEighthView = resources.getTextureView('bloom-eighth');

    if (!sceneView || !swapchainView || !bloomHalfView || !bloomQuarterView || !bloomEighthView) return;

    const device = this.device;
    const paramBuffer = this.paramBuffer;
    const placeholder = this.placeholderView;
    const params = new ArrayBuffer(SUB_PASSES * PARAMS_STRIDE);
    let subPass = 0;

    const w = frame.canvasWidth;
    const h = frame.canvasHeight;

    const runPass = (
      pipeline: GPURenderPipeline,
      inputView: GPUTextureView,
      bloomView: GPUTextureView,
      outputView: GPUTextureView,
      texelW: number,
      texelH: number,
    ): void => {
      const offset = subPass++ * PARAMS_STRIDE;
      const f32 = new Float32Array(params, offset, 4);
      const u32 = new Uint32Array(params, offset + 16, 4);
      f32[0] = texelW;
      f32[1] = texelH;
      f32[2] = this.threshold;
      f32[3] = this.intensity;
      u32[0] = this.tonemapMode;

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramBuffer, offset, size: PARAMS_SIZE } },
          { binding: 1, resource: inputView },
          { binding: 2, resource: bloomView },
          { binding: 3, resource: this.sampler! },
        ],
      });

      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: outputView,
          loadOp: 'clear' as GPULoadOp,
          storeOp: 'store' as GPUStoreOp,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    };

    // 1. Extract: scene-hdr -> bloom-half
    runPass(this.extractPipeline!, sceneView, placeholder, bloomHalfView,
            1.0 / (w / 2), 1.0 / (h / 2));

    // 2. Downsample: bloom-half -> bloom-quarter
    runPass(this.downsamplePipeline!, bloomHalfView, placeholder, bloomQuarterView,
            1.0 / (w / 4), 1.0 / (h / 4));

    // 3. Downsample: bloom-quarter -> bloom-eighth
    runPass(this.downsamplePipeline!, bloomQuarterView, placeholder, bloomEighthView,
            1.0 / (w / 8), 1.0 / (h / 8));

    // 4. Upsample: bloom-eighth -> bloom-quarter
    runPass(this.upsamplePipeline!, bloomEighthView, placeholder, bloomQuarterView,
            1.0 / (w / 4), 1.0 / (h / 4));

    // 5. Upsample: bloom-quarter -> bloom-half
    runPass(this.upsamplePipeline!, bloomQuarterView, placeholder, bloomHalfView,
            1.0 / (w / 2), 1.0 / (h / 2));

    // 6. Composite: scene-hdr + bloom-half -> swapchain
    runPass(this.compositePipeline!, sceneView, bloomHalfView, swapchainView,
            1.0 / w, 1.0 / h);

    device.queue.writeBuffer(paramBuffer, 0, params);
  }

  resize(_w: number, _h: number): void {
    // Bloom textures are managed by the renderer coordinator
  }

  destroy(): void {
    this.paramBuffer?.destroy();
    this.placeholder?.destroy();
    this.placeholder = null;
    this.placeholderView = null;
    this.extractPipeline = null;
    this.downsamplePipeline = null;
    this.upsamplePipeline = null;
    this.compositePipeline = null;
    this.paramBuffer = null;
    this.sampler = null;
    this.device = null;
  }
}
