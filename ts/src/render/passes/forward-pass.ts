import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';

/**
 * Forward rendering pass.
 *
 * Reads entity data, visible indices (from CullPass), and texture layer
 * indices, then performs an indirect indexed draw to the swapchain.
 *
 * This is a skeleton extraction from the monolithic `renderer.ts`.
 * Full integration (camera upload, depth texture lifecycle, swapchain
 * acquisition) is deferred to Phase 5.
 */
export class ForwardPass implements RenderPass {
  readonly name = 'forward';
  readonly reads = ['visible-indices', 'entity-data', 'tex-indices', 'indirect-args'];
  readonly writes = ['swapchain'];
  readonly optional = false;

  private pipeline: GPURenderPipeline | null = null;
  private bindGroup0: GPUBindGroup | null = null;
  private bindGroup1: GPUBindGroup | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private depthTexture: GPUTexture | null = null;

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
    const entityBuffer = resources.getBuffer('entity-data');
    if (!entityBuffer) throw new Error("ForwardPass.setup: missing 'entity-data' in ResourcePool");
    const visibleIndicesBuffer = resources.getBuffer('visible-indices');
    if (!visibleIndicesBuffer) throw new Error("ForwardPass.setup: missing 'visible-indices' in ResourcePool");
    const texIndexBuffer = resources.getBuffer('tex-indices');
    if (!texIndexBuffer) throw new Error("ForwardPass.setup: missing 'tex-indices' in ResourcePool");

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
        { binding: 1, resource: { buffer: entityBuffer } },
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

  prepare(_device: GPUDevice, _frame: FrameState): void {
    // Upload camera uniform to this.cameraBuffer.
    // Full implementation deferred to renderer integration (Phase 5).
  }

  execute(_encoder: GPUCommandEncoder, _frame: FrameState, resources: ResourcePool): void {
    if (!this.pipeline || !this.vertexBuffer || !this.indexBuffer || !this.bindGroup0) return;
    // bindGroup1 may be null if texture tiers are not yet populated
    if (!this.bindGroup1) return;

    const indirectBuffer = resources.getBuffer('indirect-args');
    if (!indirectBuffer) return;

    // Depth texture and swapchain acquisition require canvas context,
    // which is wired up during full renderer integration (Phase 5).
    // This skeleton validates the pass structure and resource wiring.
  }

  resize(_width: number, _height: number): void {
    // Depth texture recreation handled during full renderer integration.
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
  }
}
