import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';

/**
 * Selection seed pass: renders selected entities to an off-screen RGBA16Float
 * texture encoding their screen-space UV positions as seed coordinates for the
 * Jump Flood Algorithm (JFA).
 *
 * Only entities whose selection-mask entry is non-zero produce visible output.
 * All other instances emit degenerate triangles in the vertex shader.
 *
 * Reads: visible-indices, entity-transforms, indirect-args, selection-mask
 * Writes: selection-seed (RGBA16Float texture)
 */
export class SelectionSeedPass implements RenderPass {
  readonly name = 'selection-seed';
  readonly reads = ['visible-indices', 'entity-transforms', 'indirect-args', 'selection-mask'];
  readonly writes = ['selection-seed'];
  readonly optional = true;

  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private depthTexture: GPUTexture | null = null;
  private seedTexture: GPUTexture | null = null;
  private indirectBuffer: GPUBuffer | null = null;
  private device: GPUDevice | null = null;
  private texWidth = 0;
  private texHeight = 0;

  /**
   * WGSL shader source. Set before calling `setup()`.
   */
  static SHADER_SOURCE = '';

  setup(device: GPUDevice, resources: ResourcePool): void {
    this.device = device;

    if (!SelectionSeedPass.SHADER_SOURCE) {
      throw new Error('SelectionSeedPass.SHADER_SOURCE must be set before setup()');
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
    if (!transformBuffer) throw new Error("SelectionSeedPass.setup: missing 'entity-transforms'");
    const visibleIndicesBuffer = resources.getBuffer('visible-indices');
    if (!visibleIndicesBuffer) throw new Error("SelectionSeedPass.setup: missing 'visible-indices'");
    const selectionMaskBuffer = resources.getBuffer('selection-mask');
    if (!selectionMaskBuffer) throw new Error("SelectionSeedPass.setup: missing 'selection-mask'");
    this.indirectBuffer = resources.getBuffer('indirect-args') ?? null;

    // --- Bind group layout ---
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    const shaderModule = device.createShaderModule({ code: SelectionSeedPass.SHADER_SOURCE });

    const vertexBufferLayout: GPUVertexBufferLayout = {
      arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }],
    };

    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }],
      },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
    });

    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: transformBuffer } },
        { binding: 2, resource: { buffer: visibleIndicesBuffer } },
        { binding: 3, resource: { buffer: selectionMaskBuffer } },
      ],
    });
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.cameraBuffer) return;
    device.queue.writeBuffer(this.cameraBuffer, 0, frame.cameraViewProjection as Float32Array<ArrayBuffer>);
  }

  execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool): void {
    if (!this.pipeline || !this.vertexBuffer || !this.indexBuffer || !this.bindGroup || !this.indirectBuffer) return;

    // Ensure seed + depth textures match canvas size
    this.ensureTextures(frame.canvasWidth, frame.canvasHeight, resources);
    if (!this.seedTexture || !this.depthTexture) return;

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.seedTexture.createView(),
        loadOp: 'clear' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
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
    renderPass.setBindGroup(0, this.bindGroup);
    // Use prim-type 0 indirect args (all visible quads).
    // A more refined approach would use a selection-specific indirect args buffer,
    // but all entities are drawn and selection filtering happens in the vertex shader.
    renderPass.drawIndexedIndirect(this.indirectBuffer, 0);

    renderPass.end();
  }

  resize(width: number, height: number): void {
    if (this.texWidth !== width || this.texHeight !== height) {
      this.texWidth = 0;
      this.texHeight = 0;
    }
  }

  private ensureTextures(width: number, height: number, resources: ResourcePool): void {
    if (this.seedTexture && this.texWidth === width && this.texHeight === height) return;
    this.seedTexture?.destroy();
    this.depthTexture?.destroy();
    if (!this.device) return;

    this.seedTexture = this.device.createTexture({
      size: { width, height },
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    resources.setTextureView('selection-seed', this.seedTexture.createView());

    this.depthTexture = this.device.createTexture({
      size: { width, height },
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.texWidth = width;
    this.texHeight = height;
  }

  destroy(): void {
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.cameraBuffer?.destroy();
    this.depthTexture?.destroy();
    this.seedTexture?.destroy();
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.cameraBuffer = null;
    this.depthTexture = null;
    this.seedTexture = null;
    this.pipeline = null;
    this.bindGroup = null;
    this.indirectBuffer = null;
    this.device = null;
  }
}
