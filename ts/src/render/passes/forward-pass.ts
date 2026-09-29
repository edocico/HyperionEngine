import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import { BUCKETS_PER_TYPE } from './cull-pass';
import { H_DRAW } from './transparent-sort-constants';
import { SCENE_HDR_FORMAT } from '../formats';
import { TextureTierBinding, primitiveGroup0LayoutEntries, textureTierLayoutEntries } from '../primitive-bindings';

/**
 * Size of `LightingUniform` (prelude.wgsl): enabled, the layer→group table
 * (2 × u32), pad. It is the buffer's size AND the group-2 layout's
 * `minBindingSize`, so a prelude edit that grows the struct fails at bind-group
 * creation, inside the probe's error scope, not at draw time.
 */
const LIGHTING_UNIFORM_BYTES = 16;

/**
 * Forward rendering pass to the scene-hdr intermediate texture. Opaque entities
 * are drawn PER TYPE: one pipeline per primitive type (its own composed
 * per-type module), over 2 material buckets. Every transparent entity, of
 * whatever type, is drawn by ONE uber draw over the GPU-sorted order
 * (`transparent-order`, `transparent-args`) — never per type.
 *
 * Reads entity transforms, visible indices (from CullPass), texture layer
 * indices, render metadata, and primitive parameters.
 *
 * Each registered primitive type (via SHADER_SOURCES, the COMPOSED per-type
 * modules) gets ONE opaque pipeline (depth write, no blend), drawn from the
 * material buckets 0-13 of `indirect-args`.
 *
 * Every transparent primitive is drawn by ONE uber pipeline, from UBER_SOURCE
 * (no depth write, straight alpha blend), back to front (design 5b §6.2).
 * TransparentSortPass gathers the visible transparents of types 0-5 (buckets
 * 14-25), sorts them by (world z, external id), and writes the slots into
 * `transparent-order` and the draw arguments {6, n, 0, 0, 0} at byte 0 of
 * `transparent-args`. The uber draw binds `bindGroup0Sorted`, a second group 0
 * whose binding 2 (`visibleIndices` in the shaders) is `transparent-order`, so
 * instance i is the i-th sprite back to front: drawIndexedIndirect(transparent-args, 0).
 * firstInstance is 0: this draw needs no `indirect-first-instance`. It is
 * skipped when `FrameState.transparentCount` is 0. Here `transparent-args` is an
 * INDIRECT buffer only, never bound: in a render pass the usage scope is the
 * whole pass.
 *
 * CullPass produces 28 DrawIndirectArgs (14 opaque + 14 transparent, each set
 * being 7 prim types x 2 material buckets) at sequential 20-byte offsets.
 *
 * Sub-pass 1: Opaque entities (buckets 0-13) with depth write.
 * Sub-pass 2: every transparent entity, in the ONE uber draw above.
 *
 * Type 6 (Light2D) has buckets here but no pipeline: `SHADER_SOURCES` registers
 * nothing for it, so the per-type loop below never finds it. Its buckets are
 * read directly by the light accumulation pass.
 *
 * Group 2 is the light buffer (Phase 17): texture, sampler, lighting uniform.
 * Every pipeline shares the three-group layout, and every composed module
 * declares group 2 (the prelude does), but only the lit types' fs_main reaches
 * it: `applyLighting`, called by `quad_fs` and `gradient_fs`. It is bound for
 * every pipeline all the same, or the draw fails validation. Constructed `lit`,
 * the pass reads `light-buffer` (written by
 * LightGroupsPass, one layer per light group) and the uniform says enabled,
 * with the layer→group table; otherwise group 2 binds a 1×1
 * white placeholder, and a stale `light-buffer` left in the pool by a retired
 * lit graph (its texture destroyed) is never touched.
 */
export class ForwardPass implements RenderPass {
  readonly name = 'forward';
  // transparent-order / transparent-args (TransparentSortPass, Phase 5b) are
  // read in lit and unlit graphs alike: that read orders the sort before this
  // pass and keeps it alive. It is optional, and RadixSortPass was culled
  // because nothing read its output.
  readonly reads = [
    'visible-indices', 'entity-transforms', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params',
    'transparent-order', 'transparent-args',
  ];
  readonly writes = ['scene-hdr'];
  readonly optional = false;
  /** Whether this graph has a light buffer to read (lighting backend `lit`). */
  readonly lit: boolean;

  private opaquePipelines = new Map<number, GPURenderPipeline>();
  /** ONE pipeline for every transparent primitive (UBER_SOURCE), transparent descriptor: the uber draw. */
  private uberPipeline: GPURenderPipeline | null = null;
  private bindGroup0: GPUBindGroup | null = null;
  /** `bindGroup0` with binding 2 = `transparent-order`: the uber draw's instance i is the i-th slot back to front. */
  private bindGroup0Sorted: GPUBindGroup | null = null;
  private bindGroup1: GPUBindGroup | null = null;
  private tierBinding: TextureTierBinding | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  /** CameraUniform staging, reused every frame. */
  private readonly cameraData = new ArrayBuffer(80);
  private depthTexture: GPUTexture | null = null;
  private indirectBuffer: GPUBuffer | null = null;
  /** The sort's header (renderer-owned): DrawIndexedIndirect {6, n, 0, 0, 0} at word H_DRAW. */
  private transparentArgsBuffer: GPUBuffer | null = null;
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
   * Per-primitive-type WGSL modules. Keys are numeric primitive type IDs
   * (0 = quad … 5 = box shadow; 6, Light2D, has none).
   * `publishPrimitiveShaders()` in renderer.ts fills it with the composed
   * modules (render/primitive-shaders.ts: prelude + library + wrappers) and
   * recomposes it IN PLACE on a shader hot-reload, so LightGroupsPass, which
   * holds this object, sees the new text. Set before calling `setup()`.
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

  /**
   * The uber module (`composeUberModule`): the prelude, every library and
   * wrappers that switch on the primitive type. Required: `setup()` builds one
   * pipeline from it, with the transparent descriptor.
   */
  static UBER_SOURCE = '';

  setup(device: GPUDevice, resources: ResourcePool): void {
    this.device = device;

    // Resolve shader sources: prefer SHADER_SOURCES, fall back to legacy SHADER_SOURCE
    const sources = Object.keys(ForwardPass.SHADER_SOURCES).length > 0
      ? ForwardPass.SHADER_SOURCES
      : (ForwardPass.SHADER_SOURCE ? { 0: ForwardPass.SHADER_SOURCE } : {});

    if (Object.keys(sources).length === 0) {
      throw new Error('ForwardPass: no shader sources set. Set SHADER_SOURCES or SHADER_SOURCE before calling setup()');
    }
    if (!ForwardPass.UBER_SOURCE) {
      throw new Error('ForwardPass: no uber source set. Set UBER_SOURCE (renderer.ts: publishPrimitiveShaders) before calling setup()');
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

    // --- Camera uniform: viewProjection + occluderLayers (unused here) + viewport size + pad ---
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
    // The sort's outputs belong to the renderer (createRenderer), never to a
    // pass: an HMR probe runs setup() then destroy() against the LIVE pool.
    const transparentOrderBuffer = resources.getBuffer('transparent-order');
    if (!transparentOrderBuffer) throw new Error("ForwardPass.setup: missing 'transparent-order' in ResourcePool");
    const transparentArgsBuffer = resources.getBuffer('transparent-args');
    if (!transparentArgsBuffer) throw new Error("ForwardPass.setup: missing 'transparent-args' in ResourcePool");
    this.transparentArgsBuffer = transparentArgsBuffer;

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
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: LIGHTING_UNIFORM_BYTES } },
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
    this.lightingBuffer = device.createBuffer({ size: LIGHTING_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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

    // Transparent: depth write disabled, straight-alpha blend. Only the uber
    // pipeline uses it (design 5b §6.2): there are no per-type transparent
    // pipelines any more.
    const blendedTarget: GPUColorTargetState = {
      format,
      blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
    };
    const transparentPipeline = (module: GPUShaderModule): GPURenderPipeline => device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module, entryPoint: 'fs_main', targets: [blendedTarget] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
    });

    // --- Opaque: one pipeline per primitive type (depth write, no blend) ---
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
    }

    // --- Transparent: ONE uber pipeline for every primitive type (design 5b §6.2) ---
    // It draws every visible transparent of types 0-5, back to front, in the
    // one draw of execute().
    this.uberPipeline = transparentPipeline(device.createShaderModule({ code: ForwardPass.UBER_SOURCE }));

    // Two group 0s, identical but for binding 2: the cull's visible indices
    // for the opaque draws, the sorted order for the uber draw. The shaders
    // read `visibleIndices[instance_index]` either way. Both buffers are
    // created once by the renderer at a fixed size, so neither group is rebuilt.
    const cameraBuffer = this.cameraBuffer;
    const group0Entries = (visible: GPUBuffer): GPUBindGroupEntry[] => [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 1, resource: { buffer: transformBuffer } },
      { binding: 2, resource: { buffer: visible } },
      { binding: 3, resource: { buffer: texIndexBuffer } },
      { binding: 4, resource: { buffer: renderMetaBuffer } },
      { binding: 5, resource: { buffer: primParamsBuffer } },
    ];
    this.bindGroup0 = device.createBindGroup({ layout: bindGroupLayout0, entries: group0Entries(visibleIndicesBuffer) });
    this.bindGroup0Sorted = device.createBindGroup({ layout: bindGroupLayout0, entries: group0Entries(transparentOrderBuffer) });

    this.bindGroup1 = this.tierBinding.current(device, resources);
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.cameraBuffer) return;
    // The matrix and the canvas size (line_vs turns pixel widths into NDC
    // with it); occluderLayers stays 0.
    new Float32Array(this.cameraData, 0, 16).set(frame.cameraViewProjection);
    new Float32Array(this.cameraData, 68, 2).set([frame.canvasWidth, frame.canvasHeight]);
    device.queue.writeBuffer(this.cameraBuffer, 0, this.cameraData);
    if (this.lightingBuffer) {
      const [lo, hi] = frame.lightGroups?.layerToGroup ?? [0, 0];
      device.queue.writeBuffer(this.lightingBuffer, 0, new Uint32Array([this.lit ? 1 : 0, lo, hi, 0]));
    }
  }

  execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool): void {
    if (this.device && this.tierBinding) this.bindGroup1 = this.tierBinding.current(this.device, resources);
    const bindGroup2 = this.lightBindGroup(resources);
    if (this.opaquePipelines.size === 0 || !this.uberPipeline || !this.vertexBuffer || !this.indexBuffer
      || !this.bindGroup0 || !this.bindGroup0Sorted || !this.bindGroup1 || !bindGroup2
      || !this.indirectBuffer || !this.transparentArgsBuffer) return;

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

    // --- Sub-pass 2: every transparent primitive, back to front, in ONE draw ---
    // TransparentSortPass wrote the visible transparents of types 0-5 into
    // `transparent-order`, sorted by (world z, external id), and the draw
    // arguments at word H_DRAW of `transparent-args`. With nothing transparent
    // the sort encodes nothing: skip the draw too (prepare() has also reset n).
    if (frame.transparentCount !== 0) {
      renderPass.setPipeline(this.uberPipeline);
      renderPass.setVertexBuffer(0, this.vertexBuffer);
      renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
      renderPass.setBindGroup(0, this.bindGroup0Sorted);
      renderPass.setBindGroup(1, this.bindGroup1);
      renderPass.setBindGroup(2, bindGroup2);
      renderPass.drawIndexedIndirect(this.transparentArgsBuffer, H_DRAW * 4);
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
   * LightGroupsPass recreates on resize or when the group count grows, so the
   * group follows the view. Before
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
    this.uberPipeline = null;
    this.bindGroup0 = null;
    this.bindGroup0Sorted = null;
    this.bindGroup1 = null;
    this.tierBinding = null;
    // Pool buffers: owned by the renderer, never destroyed here.
    this.indirectBuffer = null;
    this.transparentArgsBuffer = null;
    this.device = null;
  }
}
