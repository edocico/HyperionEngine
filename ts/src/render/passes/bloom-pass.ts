import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';

export interface BloomConfig {
  threshold?: number;
  intensity?: number;
  levels?: number;
  tonemapMode?: number;
}

/**
 * Dual Kawase Bloom post-process pass.
 *
 * Pipeline: extract bright pixels -> downsample chain -> upsample chain -> composite.
 * Reads scene-hdr and writes to swapchain, dead-culling FXAATonemapPass when active.
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
  private sampler: GPUSampler | null = null;
  private device: GPUDevice | null = null;

  constructor(config?: BloomConfig) {
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

    // Extract and downsample/upsample write to rgba16float intermediates
    const hdrFormat: GPUTextureFormat = 'rgba16float';

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

    this.paramBuffer = device.createBuffer({
      size: 32, // BloomParams struct: 2 f32 + 2 f32 + 1 u32 + 3 u32 pad = 32 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  prepare(_device: GPUDevice, _frame: FrameState): void {
    // Param buffer is written per-subpass in execute(), not once in prepare()
  }

  execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool): void {
    if (!this.device || !this.extractPipeline || !this.paramBuffer || !this.sampler) return;

    const sceneView = resources.getTextureView('scene-hdr');
    const swapchainView = resources.getTextureView('swapchain');
    const bloomHalfView = resources.getTextureView('bloom-half');
    const bloomQuarterView = resources.getTextureView('bloom-quarter');
    const bloomEighthView = resources.getTextureView('bloom-eighth');

    if (!sceneView || !swapchainView || !bloomHalfView || !bloomQuarterView || !bloomEighthView) return;

    const device = this.device;
    const dummyView = bloomEighthView; // placeholder for unused bloomTex binding

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
      const paramData = new ArrayBuffer(32);
      const f32 = new Float32Array(paramData);
      const u32 = new Uint32Array(paramData);
      f32[0] = texelW;
      f32[1] = texelH;
      f32[2] = this.threshold;
      f32[3] = this.intensity;
      u32[4] = this.tonemapMode;
      u32[5] = 0;
      u32[6] = 0;
      u32[7] = 0;
      device.queue.writeBuffer(this.paramBuffer!, 0, paramData);

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.paramBuffer! } },
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
    runPass(this.extractPipeline!, sceneView, dummyView, bloomHalfView,
            1.0 / (w / 2), 1.0 / (h / 2));

    // 2. Downsample: bloom-half -> bloom-quarter
    runPass(this.downsamplePipeline!, bloomHalfView, dummyView, bloomQuarterView,
            1.0 / (w / 4), 1.0 / (h / 4));

    // 3. Downsample: bloom-quarter -> bloom-eighth
    runPass(this.downsamplePipeline!, bloomQuarterView, dummyView, bloomEighthView,
            1.0 / (w / 8), 1.0 / (h / 8));

    // 4. Upsample: bloom-eighth -> bloom-quarter
    runPass(this.upsamplePipeline!, bloomEighthView, dummyView, bloomQuarterView,
            1.0 / (w / 4), 1.0 / (h / 4));

    // 5. Upsample: bloom-quarter -> bloom-half
    runPass(this.upsamplePipeline!, bloomQuarterView, dummyView, bloomHalfView,
            1.0 / (w / 2), 1.0 / (h / 2));

    // 6. Composite: scene-hdr + bloom-half -> swapchain
    runPass(this.compositePipeline!, sceneView, bloomHalfView, swapchainView,
            1.0 / w, 1.0 / h);
  }

  resize(_w: number, _h: number): void {
    // Bloom textures are managed by the renderer coordinator
  }

  destroy(): void {
    this.paramBuffer?.destroy();
    this.extractPipeline = null;
    this.downsamplePipeline = null;
    this.upsamplePipeline = null;
    this.compositePipeline = null;
    this.paramBuffer = null;
    this.sampler = null;
    this.device = null;
  }
}
