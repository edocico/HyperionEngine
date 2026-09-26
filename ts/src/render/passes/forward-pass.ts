import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import { BUCKETS_PER_TYPE, OPAQUE_DRAW_BUCKETS } from './cull-pass';
import { SCENE_HDR_FORMAT } from '../formats';
import { TextureTierBinding, primitiveGroup0LayoutEntries, textureTierLayoutEntries } from '../primitive-bindings';

/**
 * Forward rendering pass with multi-pipeline per-type dispatch, 2-bucket material sort,
 * and separate opaque/transparent sub-passes.
 *
 * Reads entity transforms, visible indices (from CullPass), texture layer
 * indices, render metadata, and primitive parameters, then issues per-type
 * indirect indexed draws to the scene-hdr intermediate texture.
 *
 * Each registered primitive type (via SHADER_SOURCES) gets TWO pipelines:
 * one opaque (depth-write enabled, no blend) and one transparent (depth-write
 * disabled, alpha blend enabled).
 *
 * CullPass produces 28 DrawIndirectArgs (14 opaque + 14 transparent, each set
 * being 7 prim types x 2 material buckets) at sequential 20-byte offsets.
 *
 * Sub-pass 1: Opaque entities (buckets 0-13) with depth write.
 * Sub-pass 2: Transparent entities (buckets 14-27) with alpha blend, no depth write.
 *
 * Type 6 (Light2D) has buckets here but no pipeline: `SHADER_SOURCES` registers
 * nothing for it, so the per-type loop below never finds it. Its buckets are
 * read directly by the light accumulation pass.
 *
 * Group 2 is the light buffer (Phase 17): texture, sampler, lighting uniform.
 * Every pipeline shares the three-group layout, but only the shaders that apply
 * lighting (basic.wgsl, gradient.wgsl) declare group 2; a layout may hold groups
 * a shader never uses. It is bound for every pipeline all the same, or the draw
 * fails validation. Constructed `lit`, the pass reads `light-buffer` (written by
 * LightAccumPass) and the uniform says enabled; otherwise group 2 binds a 1×1
 * white placeholder, and a stale `light-buffer` left in the pool by a retired
 * lit graph (its texture destroyed) is never touched.
 */
export class ForwardPass implements RenderPass {
  readonly name = 'forward';
  readonly reads = ['visible-indices', 'entity-transforms', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params'];
  readonly writes = ['scene-hdr'];
  readonly optional = false;
  /** Whether this graph has a light buffer to read (lighting backend `lit`). */
  readonly lit: boolean;

  private opaquePipelines = new Map<number, GPURenderPipeline>();
  private transparentPipelines = new Map<number, GPURenderPipeline>();
  private bindGroup0: GPUBindGroup | null = null;
  private bindGroup1: GPUBindGroup | null = null;
  private tierBinding: TextureTierBinding | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private depthTexture: GPUTexture | null = null;
  private indirectBuffer: GPUBuffer | null = null;
  private device: GPUDevice | null = null;
  private depthWidth = 0;
  private depthHeight = 0;
  private bindGroupLayout2: GPUBindGroupLayout | null = null;
  private bindGroup2: GPUBindGroup | null = null;
  /** The light-buffer view `bindGroup2` was made with: rebuilt when it changes. */
  private boundLightView: GPUTextureView | null = null;
  private lightSampler: GPUSampler | null = null;
  private lightingBuffer: GPUBuffer | null = null;
  private placeholderTexture: GPUTexture | null = null;
  private placeholderView: GPUTextureView | null = null;

  constructor(options: { lit?: boolean } = {}) {
    this.lit = options.lit ?? false;
    if (this.lit) this.reads = [...this.reads, 'light-buffer'];
  }

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

    // --- Camera uniform: viewProjection + occluderLayers (unused here) + pads ---
    this.cameraBuffer = device.createBuffer({
      size: 80,
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
    const bindGroupLayout0 = device.createBindGroupLayout({ entries: primitiveGroup0LayoutEntries() });

    // --- Group 1: fragment-stage textures ---
    const bindGroupLayout1 = device.createBindGroupLayout({ entries: textureTierLayoutEntries() });
    this.tierBinding = new TextureTierBinding(bindGroupLayout1);

    // --- Group 2: the light buffer ---
    this.bindGroupLayout2 = device.createBindGroupLayout({
      entries: [
        // One layer per light group (LightGroupsPass).
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    // Half-resolution buffer, full-resolution draw: bilinear upsampling.
    this.lightSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    // LightingUniform: enabled, the layer→group table (2 × u32), pad = 16
    // bytes. `enabled` is fixed for the lifetime of the pass (a graph is lit or
    // not); the table is rewritten every frame in prepare().
    this.lightingBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.lightingBuffer, 0, new Uint32Array([this.lit ? 1 : 0, 0, 0, 0]));
    this.placeholderTexture = device.createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      textureBindingViewDimension: '2d-array',
    });
    device.queue.writeTexture(
      { texture: this.placeholderTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    this.placeholderView = this.placeholderTexture.createView({ dimension: '2d-array' });

    // ForwardPass writes `scene-hdr`, never the swapchain. Before this was
    // pinned to SCENE_HDR_FORMAT it queried getPreferredCanvasFormat(), which
    // silently clamped the whole scene to [0,1] and left bloom + tonemapping
    // with nothing to work on. See render/formats.ts.
    const format = SCENE_HDR_FORMAT;
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout0, bindGroupLayout1, this.bindGroupLayout2],
    });
    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }],
    };

    // --- Create opaque and transparent pipelines per primitive type ---
    for (const [typeStr, source] of Object.entries(sources)) {
      const type = Number(typeStr);
      const module = device.createShaderModule({ code: source });

      // Opaque pipeline: depth write enabled, no blend
      const opaquePipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
      });
      this.opaquePipelines.set(type, opaquePipeline);

      // Transparent pipeline: depth write disabled, alpha blend
      const transparentPipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
        fragment: {
          module,
          entryPoint: 'fs_main',
          targets: [{
            format,
            blend: {
              color: {
                srcFactor: 'src-alpha' as GPUBlendFactor,
                dstFactor: 'one-minus-src-alpha' as GPUBlendFactor,
                operation: 'add' as GPUBlendOperation,
              },
              alpha: {
                srcFactor: 'one' as GPUBlendFactor,
                dstFactor: 'one-minus-src-alpha' as GPUBlendFactor,
                operation: 'add' as GPUBlendOperation,
              },
            },
          }],
        },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
      });
      this.transparentPipelines.set(type, transparentPipeline);
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

    this.bindGroup1 = this.tierBinding.current(device, resources);
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.cameraBuffer) return;
    // Only the matrix: occluderLayers and the pads stay 0 from creation.
    device.queue.writeBuffer(this.cameraBuffer, 0, frame.cameraViewProjection as Float32Array<ArrayBuffer>);
    if (this.lightingBuffer) {
      const [lo, hi] = frame.lightGroups?.layerToGroup ?? [0, 0];
      device.queue.writeBuffer(this.lightingBuffer, 0, new Uint32Array([this.lit ? 1 : 0, lo, hi, 0]));
    }
  }

  execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool): void {
    if (this.device && this.tierBinding) this.bindGroup1 = this.tierBinding.current(this.device, resources);
    const bindGroup2 = this.lightBindGroup(resources);
    if (this.opaquePipelines.size === 0 || !this.vertexBuffer || !this.indexBuffer || !this.bindGroup0 || !this.bindGroup1 || !bindGroup2 || !this.indirectBuffer) return;

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

    // --- Sub-pass 1: Opaque entities (buckets 0-13) ---
    // Depth write enabled, no alpha blend.
    for (const [primType, pipeline] of this.opaquePipelines) {
      renderPass.setPipeline(pipeline);
      renderPass.setVertexBuffer(0, this.vertexBuffer);
      renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
      renderPass.setBindGroup(0, this.bindGroup0);
      renderPass.setBindGroup(1, this.bindGroup1);
      renderPass.setBindGroup(2, bindGroup2);
      for (let bucket = 0; bucket < BUCKETS_PER_TYPE; bucket++) {
        const argSlot = primType * BUCKETS_PER_TYPE + bucket;
        renderPass.drawIndexedIndirect(this.indirectBuffer, argSlot * 20);
      }
    }

    // --- Sub-pass 2: Transparent entities (buckets 14-27) ---
    // Depth write disabled, alpha blend enabled. Drawn after opaque.
    for (const [primType, pipeline] of this.transparentPipelines) {
      renderPass.setPipeline(pipeline);
      renderPass.setVertexBuffer(0, this.vertexBuffer);
      renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
      renderPass.setBindGroup(0, this.bindGroup0);
      renderPass.setBindGroup(1, this.bindGroup1);
      renderPass.setBindGroup(2, bindGroup2);
      for (let bucket = 0; bucket < BUCKETS_PER_TYPE; bucket++) {
        const argSlot = OPAQUE_DRAW_BUCKETS + primType * BUCKETS_PER_TYPE + bucket;
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

  /**
   * Group 2 for this frame. Lit, it binds the pool's `light-buffer`, which
   * LightAccumPass recreates on resize, so the group follows the view. Before
   * that pass has produced one, the white placeholder stands in: lit sprites
   * then draw as if unlit for that frame, rather than not at all.
   */
  private lightBindGroup(resources: ResourcePool): GPUBindGroup | null {
    if (!this.device || !this.bindGroupLayout2 || !this.lightSampler || !this.lightingBuffer || !this.placeholderView) return null;
    const view = (this.lit ? resources.getTextureView('light-buffer') : undefined) ?? this.placeholderView;
    if (this.bindGroup2 && view === this.boundLightView) return this.bindGroup2;
    this.bindGroup2 = this.device.createBindGroup({
      layout: this.bindGroupLayout2,
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: this.lightSampler },
        { binding: 2, resource: { buffer: this.lightingBuffer } },
      ],
    });
    this.boundLightView = view;
    return this.bindGroup2;
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
    this.lightingBuffer?.destroy();
    this.placeholderTexture?.destroy();
    this.lightingBuffer = null;
    this.placeholderTexture = null;
    this.placeholderView = null;
    this.lightSampler = null;
    this.bindGroupLayout2 = null;
    this.bindGroup2 = null;
    this.boundLightView = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.cameraBuffer = null;
    this.depthTexture = null;
    this.opaquePipelines.clear();
    this.transparentPipelines.clear();
    this.bindGroup0 = null;
    this.bindGroup1 = null;
    this.tierBinding = null;
    this.indirectBuffer = null;
    this.device = null;
  }
}
