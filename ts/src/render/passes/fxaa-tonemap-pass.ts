import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';

/**
 * Combined FXAA + tonemapping post-process pass.
 * Reads the scene from an intermediate texture, writes to swapchain.
 * Optional: dead-pass culled when not enabled.
 */
export class FXAATonemapPass implements RenderPass {
  readonly name = 'fxaa-tonemap';
  readonly reads = ['scene-hdr'];
  readonly writes = ['swapchain'];
  readonly optional = true;

  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private paramBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  private device: GPUDevice | null = null;
  private tonemapMode: number = 0; // 0=none, 1=PBR-neutral, 2=ACES

  static SHADER_SOURCE = '';

  setTonemapMode(mode: number): void {
    this.tonemapMode = mode;
  }

  setup(device: GPUDevice, _resources: ResourcePool): void {
    this.device = device;

    if (!FXAATonemapPass.SHADER_SOURCE) {
      throw new Error('FXAATonemapPass.SHADER_SOURCE must be set before setup()');
    }

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    this.paramBuffer = device.createBuffer({
      size: 16, // vec2f texelSize + u32 tonemapMode + u32 pad
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shaderModule = device.createShaderModule({ code: FXAATonemapPass.SHADER_SOURCE });
    const format = navigator.gpu.getPreferredCanvasFormat();

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
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.paramBuffer) return;
    const data = new ArrayBuffer(16);
    const f32 = new Float32Array(data);
    const u32 = new Uint32Array(data);
    f32[0] = 1.0 / frame.canvasWidth;
    f32[1] = 1.0 / frame.canvasHeight;
    u32[2] = this.tonemapMode;
    u32[3] = 0;
    device.queue.writeBuffer(this.paramBuffer, 0, data);
  }

  execute(encoder: GPUCommandEncoder, _frame: FrameState, resources: ResourcePool): void {
    if (!this.pipeline || !this.paramBuffer || !this.sampler || !this.device) return;

    const sceneHdr = resources.getTextureView('scene-hdr');
    const swapchainView = resources.getTextureView('swapchain');
    if (!sceneHdr || !swapchainView) return;

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sceneHdr },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.paramBuffer } },
      ],
    });

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: swapchainView,
        loadOp: 'clear' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.draw(3); // Full-screen triangle
    renderPass.end();
  }

  resize(_w: number, _h: number): void { /* No owned textures */ }

  destroy(): void {
    this.paramBuffer?.destroy();
    this.pipeline = null;
    this.bindGroup = null;
    this.paramBuffer = null;
    this.sampler = null;
    this.device = null;
  }
}
