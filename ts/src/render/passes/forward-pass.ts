import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';

/**
 * Forward rendering pass.
 *
 * Reads entity transforms, visible indices (from CullPass), and texture layer
 * indices, then performs an indirect indexed draw to the swapchain.
 *
 * Camera uniform upload, lazy depth texture lifecycle, and swapchain
 * acquisition via ResourcePool are fully wired.
 */
export class ForwardPass implements RenderPass {
  readonly name = 'forward';
  readonly reads = ['visible-indices', 'entity-transforms', 'tex-indices', 'indirect-args'];
  readonly writes = ['swapchain'];
  readonly optional = false;

  private pipeline: GPURenderPipeline | null = null;
  private bindGroup0: GPUBindGroup | null = null;
  private bindGroup1: GPUBindGroup | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private depthTexture: GPUTexture | null = null;
  private indirectBuffer: GPUBuffer | null = null;
  private device: GPUDevice | null = null;
  private depthWidth = 0;
  private depthHeight = 0;

  /**
   * WGSL shader source for the forward render pipeline.
   * Set this before calling `setup()` when using the `?raw` import:
   *
   *   import shaderSrc from '../../shaders/basic.wgsl?raw';
   *   ForwardPass.SHADER_SOURCE = shaderSrc;
   *
   * A minimal default is provided so the class can be instantiated
   * without importing the shader (e.g. in unit tests).
   */
  static SHADER_SOURCE = '';

  setup(device: GPUDevice, resources: ResourcePool): void {
    this.device = device;

    if (!ForwardPass.SHADER_SOURCE) {
      throw new Error('ForwardPass.SHADER_SOURCE must be set before calling setup()');
    }

    // --- Vertex + Index buffers (unit quad) ---
    const vertices = new Float32Array([
      -0.5, -0.5, 0.0,
       0.5, -0.5, 0.0,
       0.5,  0.5, 0.0,
      -0.5,  0.5, 0.0,
    ]);
    this.vertexBuffer = device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuffer, 0, vertices);

    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    this.indexBuffer = device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuffer, 0, indices);

    // --- Camera uniform ---
    this.cameraBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // --- Fetch shared resources from pool ---
    const transformBuffer = resources.getBuffer('entity-transforms');
    if (!transformBuffer) throw new Error("ForwardPass.setup: missing 'entity-transforms' in ResourcePool");
    const visibleIndicesBuffer = resources.getBuffer('visible-indices');
    if (!visibleIndicesBuffer) throw new Error("ForwardPass.setup: missing 'visible-indices' in ResourcePool");
    const texIndexBuffer = resources.getBuffer('tex-indices');
    if (!texIndexBuffer) throw new Error("ForwardPass.setup: missing 'tex-indices' in ResourcePool");
    this.indirectBuffer = resources.getBuffer('indirect-args') ?? null;

    const shaderModule = device.createShaderModule({ code: ForwardPass.SHADER_SOURCE });

    // --- Group 0: vertex-stage data ---
    const bindGroupLayout0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    // --- Group 1: fragment-stage textures ---
    const bindGroupLayout1 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    const format = navigator.gpu.getPreferredCanvasFormat();
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout0, bindGroupLayout1],
      }),
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less',
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
    });

    this.bindGroup0 = device.createBindGroup({
      layout: bindGroupLayout0,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: transformBuffer } },
        { binding: 2, resource: { buffer: visibleIndicesBuffer } },
        { binding: 3, resource: { buffer: texIndexBuffer } },
      ],
    });

    // Group 1 bind group requires texture views + sampler from ResourcePool
    const tier0View = resources.getTextureView('tier0');
    const tier1View = resources.getTextureView('tier1');
    const tier2View = resources.getTextureView('tier2');
    const tier3View = resources.getTextureView('tier3');
    const sampler = resources.getSampler('texSampler');

    if (tier0View && tier1View && tier2View && tier3View && sampler) {
      this.bindGroup1 = device.createBindGroup({
        layout: bindGroupLayout1,
        entries: [
          { binding: 0, resource: tier0View },
          { binding: 1, resource: tier1View },
          { binding: 2, resource: tier2View },
          { binding: 3, resource: tier3View },
          { binding: 4, resource: sampler },
        ],
      });
    }
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.cameraBuffer) return;
    device.queue.writeBuffer(this.cameraBuffer, 0, frame.cameraViewProjection as Float32Array<ArrayBuffer>);
  }

  execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool): void {
    if (!this.pipeline || !this.vertexBuffer || !this.indexBuffer || !this.bindGroup0 || !this.bindGroup1 || !this.indirectBuffer) return;

    // Get swapchain view (set each frame by the coordinator)
    const swapchainView = resources.getTextureView('swapchain');
    if (!swapchainView) return;

    // Ensure depth texture exists and matches canvas size
    this.ensureDepthTexture(frame.canvasWidth, frame.canvasHeight);
    if (!this.depthTexture) return;

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: swapchainView,
        loadOp: 'clear' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
        clearValue: { r: 0.067, g: 0.067, b: 0.067, a: 1 },
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthLoadOp: 'clear' as GPULoadOp,
        depthStoreOp: 'store' as GPUStoreOp,
        depthClearValue: 1.0,
      },
    });
    renderPass.setPipeline(this.pipeline);
    renderPass.setVertexBuffer(0, this.vertexBuffer);
    renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
    renderPass.setBindGroup(0, this.bindGroup0);
    renderPass.setBindGroup(1, this.bindGroup1);
    renderPass.drawIndexedIndirect(this.indirectBuffer, 0);
    renderPass.end();
  }

  resize(width: number, height: number): void {
    // Depth texture will be lazily recreated in ensureDepthTexture()
    // when dimensions change, so just invalidate tracking.
    if (this.depthWidth !== width || this.depthHeight !== height) {
      this.depthWidth = 0;
      this.depthHeight = 0;
    }
  }

  private ensureDepthTexture(width: number, height: number): void {
    if (this.depthTexture && this.depthWidth === width && this.depthHeight === height) return;
    this.depthTexture?.destroy();
    if (!this.device) return;
    this.depthTexture = this.device.createTexture({
      size: { width, height },
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthWidth = width;
    this.depthHeight = height;
  }

  destroy(): void {
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.cameraBuffer?.destroy();
    this.depthTexture?.destroy();
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.cameraBuffer = null;
    this.depthTexture = null;
    this.pipeline = null;
    this.bindGroup0 = null;
    this.bindGroup1 = null;
    this.indirectBuffer = null;
    this.device = null;
  }
}
