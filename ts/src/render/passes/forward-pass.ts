import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import { BUCKETS_PER_TYPE } from './cull-pass';

/**
 * Forward rendering pass with multi-pipeline per-type dispatch and 2-bucket material sort.
 *
 * Reads entity transforms, visible indices (from CullPass), texture layer
 * indices, render metadata, and primitive parameters, then issues per-type
 * indirect indexed draws to the scene-hdr intermediate texture.
 *
 * Each registered primitive type (via SHADER_SOURCES) gets its own
 * GPURenderPipeline. All pipelines share the same bind group layouts.
 * CullPass produces 12 DrawIndirectArgs (6 prim types x 2 buckets) at
 * sequential 20-byte offsets. For each primitive type, the tier0 bucket
 * is drawn first, then the other-tiers bucket, reducing fragment divergence.
 */
export class ForwardPass implements RenderPass {
  readonly name = 'forward';
  readonly reads = ['visible-indices', 'entity-transforms', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params'];
  readonly writes = ['scene-hdr'];
  readonly optional = false;

  private pipelines = new Map<number, GPURenderPipeline>();
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
   * Per-primitive-type WGSL shader sources.
   * Keys are numeric primitive type IDs (e.g. 0 = quad).
   * Set this before calling `setup()`:
   *
   *   import shaderSrc from '../../shaders/basic.wgsl?raw';
   *   ForwardPass.SHADER_SOURCES = { 0: shaderSrc };
   *
   * For backward compatibility, SHADER_SOURCE is also supported
   * (registers as type 0).
   */
  static SHADER_SOURCES: Record<number, string> = {};

  /**
   * Legacy single-shader source (registers as type 0).
   * Prefer SHADER_SOURCES for multi-type pipelines.
   */
  static SHADER_SOURCE = '';

  setup(device: GPUDevice, resources: ResourcePool): void {
    this.device = device;

    // Resolve shader sources: prefer SHADER_SOURCES, fall back to legacy SHADER_SOURCE
    const sources = Object.keys(ForwardPass.SHADER_SOURCES).length > 0
      ? ForwardPass.SHADER_SOURCES
      : (ForwardPass.SHADER_SOURCE ? { 0: ForwardPass.SHADER_SOURCE } : {});

    if (Object.keys(sources).length === 0) {
      throw new Error('ForwardPass: no shader sources set. Set SHADER_SOURCES or SHADER_SOURCE before calling setup()');
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
    const renderMetaBuffer = resources.getBuffer('render-meta');
    if (!renderMetaBuffer) throw new Error("ForwardPass.setup: missing 'render-meta' in ResourcePool");
    const primParamsBuffer = resources.getBuffer('prim-params');
    if (!primParamsBuffer) throw new Error("ForwardPass.setup: missing 'prim-params' in ResourcePool");

    // --- Group 0: vertex-stage data + storage buffers ---
    const bindGroupLayout0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }, // texLayerIndices (gradient reads in fs)
        { binding: 4, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }, // renderMeta
        { binding: 5, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }, // primParams
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
        // Overflow tiers (rgba8unorm)
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      ],
    });

    const format = navigator.gpu.getPreferredCanvasFormat();
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout0, bindGroupLayout1],
    });
    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }],
    };

    // --- Create one pipeline per primitive type ---
    for (const [typeStr, source] of Object.entries(sources)) {
      const type = Number(typeStr);
      const module = device.createShaderModule({ code: source });
      const pipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
      });
      this.pipelines.set(type, pipeline);
    }

    this.bindGroup0 = device.createBindGroup({
      layout: bindGroupLayout0,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: transformBuffer } },
        { binding: 2, resource: { buffer: visibleIndicesBuffer } },
        { binding: 3, resource: { buffer: texIndexBuffer } },
        { binding: 4, resource: { buffer: renderMetaBuffer } },
        { binding: 5, resource: { buffer: primParamsBuffer } },
      ],
    });

    // Group 1 bind group requires texture views + sampler from ResourcePool
    const tier0View = resources.getTextureView('tier0');
    const tier1View = resources.getTextureView('tier1');
    const tier2View = resources.getTextureView('tier2');
    const tier3View = resources.getTextureView('tier3');
    const sampler = resources.getSampler('texSampler');
    const ovf0View = resources.getTextureView('ovf0');
    const ovf1View = resources.getTextureView('ovf1');
    const ovf2View = resources.getTextureView('ovf2');
    const ovf3View = resources.getTextureView('ovf3');

    if (tier0View && tier1View && tier2View && tier3View && sampler &&
        ovf0View && ovf1View && ovf2View && ovf3View) {
      this.bindGroup1 = device.createBindGroup({
        layout: bindGroupLayout1,
        entries: [
          { binding: 0, resource: tier0View },
          { binding: 1, resource: tier1View },
          { binding: 2, resource: tier2View },
          { binding: 3, resource: tier3View },
          { binding: 4, resource: sampler },
          { binding: 5, resource: ovf0View },
          { binding: 6, resource: ovf1View },
          { binding: 7, resource: ovf2View },
          { binding: 8, resource: ovf3View },
        ],
      });
    }
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.cameraBuffer) return;
    device.queue.writeBuffer(this.cameraBuffer, 0, frame.cameraViewProjection as Float32Array<ArrayBuffer>);
  }

  execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool): void {
    if (this.pipelines.size === 0 || !this.vertexBuffer || !this.indexBuffer || !this.bindGroup0 || !this.bindGroup1 || !this.indirectBuffer) return;

    // Get render target view (scene-hdr intermediate for post-processing)
    const targetView = resources.getTextureView('scene-hdr');
    if (!targetView) return;

    // Ensure depth texture exists and matches canvas size
    this.ensureDepthTexture(frame.canvasWidth, frame.canvasHeight);
    if (!this.depthTexture) return;

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: targetView,
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

    // Issue per-type draw calls using each pipeline's indirect args.
    // Each primitive type has 2 buckets (tier0 compressed, then other tiers).
    // Bucket layout: argSlot = primType * BUCKETS_PER_TYPE + bucket.
    for (const [primType, pipeline] of this.pipelines) {
      renderPass.setPipeline(pipeline);
      renderPass.setVertexBuffer(0, this.vertexBuffer);
      renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
      renderPass.setBindGroup(0, this.bindGroup0);
      renderPass.setBindGroup(1, this.bindGroup1);
      for (let bucket = 0; bucket < BUCKETS_PER_TYPE; bucket++) {
        const argSlot = primType * BUCKETS_PER_TYPE + bucket;
        renderPass.drawIndexedIndirect(this.indirectBuffer, argSlot * 20);
      }
    }

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
    this.pipelines.clear();
    this.bindGroup0 = null;
    this.bindGroup1 = null;
    this.indirectBuffer = null;
    this.device = null;
  }
}
