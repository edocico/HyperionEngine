import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';

/**
 * Outline composite post-process pass.
 *
 * Reads the scene (scene-hdr) and the final JFA texture, computes an SDF
 * outline around selected entities, and writes the composited result directly
 * to the swapchain.  When active, the existing FXAATonemapPass is dead-pass
 * culled by the RenderGraph since this pass writes to swapchain and includes
 * its own simplified FXAA.
 *
 * The JFA result texture name is configurable (depends on which ping-pong
 * buffer the last JFA iteration wrote to).
 */
export class OutlineCompositePass implements RenderPass {
  readonly name = 'outline-composite';
  readonly reads: string[];
  readonly writes = ['swapchain'];
  readonly optional = true;

  private pipeline: GPURenderPipeline | null = null;
  private paramBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  private device: GPUDevice | null = null;

  /** Outline color as [R, G, B, A], range 0-1. */
  outlineColor: [number, number, number, number] = [1.0, 0.8, 0.0, 1.0];

  /** Outline width in pixels. */
  outlineWidth = 3.0;

  /** Name of the JFA result texture to read. */
  readonly jfaResultResource: string;

  /**
   * WGSL shader source. Set before calling `setup()`.
   */
  static SHADER_SOURCE = '';

  constructor(jfaResultResource: string) {
    this.jfaResultResource = jfaResultResource;
    this.reads = ['scene-hdr', jfaResultResource];
  }

  setup(device: GPUDevice, _resources: ResourcePool): void {
    this.device = device;

    if (!OutlineCompositePass.SHADER_SOURCE) {
      throw new Error('OutlineCompositePass.SHADER_SOURCE must be set before setup()');
    }

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });

    // OutlineParams: outlineColor (vec4f, 16B) + outlineWidth (f32, 4B) + texelSize (vec2f, 8B) + pad (f32, 4B) = 32 bytes
    this.paramBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shaderModule = device.createShaderModule({ code: OutlineCompositePass.SHADER_SOURCE });
    const format = navigator.gpu.getPreferredCanvasFormat();

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // sceneTex
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // jfaTex
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },                       // inputSampler
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },       // params
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
    const data = new ArrayBuffer(32);
    const f32 = new Float32Array(data);
    // outlineColor (vec4f at offset 0)
    f32[0] = this.outlineColor[0];
    f32[1] = this.outlineColor[1];
    f32[2] = this.outlineColor[2];
    f32[3] = this.outlineColor[3];
    // outlineWidth (f32 at offset 16)
    f32[4] = this.outlineWidth;
    // texelSize (vec2f at offset 20)
    f32[5] = 1.0 / frame.canvasWidth;
    f32[6] = 1.0 / frame.canvasHeight;
    // pad (f32 at offset 28)
    f32[7] = 0;
    device.queue.writeBuffer(this.paramBuffer, 0, data);
  }

  execute(encoder: GPUCommandEncoder, _frame: FrameState, resources: ResourcePool): void {
    if (!this.pipeline || !this.paramBuffer || !this.sampler || !this.device) return;

    const sceneHdr = resources.getTextureView('scene-hdr');
    const jfaResult = resources.getTextureView(this.jfaResultResource);
    const swapchainView = resources.getTextureView('swapchain');
    if (!sceneHdr || !jfaResult || !swapchainView) return;

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sceneHdr },
        { binding: 1, resource: jfaResult },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.paramBuffer } },
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
    renderPass.setBindGroup(0, bindGroup);
    renderPass.draw(3); // Full-screen triangle
    renderPass.end();
  }

  resize(_w: number, _h: number): void {
    // No owned textures
  }

  destroy(): void {
    this.paramBuffer?.destroy();
    this.pipeline = null;
    this.paramBuffer = null;
    this.sampler = null;
    this.device = null;
  }
}
