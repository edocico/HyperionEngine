import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';

/**
 * ScatterPass: GPU compute pass that scatters dirty entity data
 * from a compact staging buffer into the destination SoA GPU buffers.
 *
 * Runs before CullPass when dirty ratio <= scatter threshold.
 * The RenderGraph DAG ensures this by declaring writes to the same
 * buffers that CullPass reads.
 *
 * Staging buffer layout per dirty entity (STAGING_STRIDE = 32 u32):
 *   [0..15]  transforms (16 u32 = mat4x4)
 *   [16..19] bounds     (4 u32)
 *   [20..21] renderMeta (2 u32)
 *   [22]     texIndices  (1 u32)
 *   [23..30] primParams (8 u32)
 *   [31]     format flag (0 = compressed 2D, 1 = pre-computed mat4x4)
 */
export class ScatterPass implements RenderPass {
  readonly name = 'scatter';
  readonly reads = ['entity-transforms', 'entity-bounds', 'render-meta', 'tex-indices', 'prim-params'];
  readonly writes = ['entity-transforms', 'entity-bounds', 'render-meta', 'tex-indices', 'prim-params'];
  readonly optional = true;

  /**
   * WGSL shader source for the scatter compute shader.
   * Set this before calling `setup()` when using the `?raw` import:
   *
   *   import scatterSrc from '../../shaders/scatter.wgsl?raw';
   *   ScatterPass.SHADER_SOURCE = scatterSrc;
   *
   * A minimal default is provided so the class can be instantiated
   * without importing the shader (e.g. in unit tests).
   */
  static SHADER_SOURCE = '';

  private pipeline: GPUComputePipeline | null = null;
  private sourceBindGroupLayout: GPUBindGroupLayout | null = null;
  private destBindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private stagingBuffer: GPUBuffer | null = null;
  private indicesBuffer: GPUBuffer | null = null;
  private sourceBindGroup: GPUBindGroup | null = null;
  private destBindGroup: GPUBindGroup | null = null;

  /** Per-frame dirty count, set by prepareDirtyData(). */
  private dirtyCount = 0;

  /**
   * Compute the number of workgroups needed for n dirty entities.
   * Workgroup size is 64 (matching scatter.wgsl @workgroup_size(64)).
   */
  static workgroupCount(n: number): number {
    if (n <= 0) return 0;
    return Math.ceil(n / 64);
  }

  setup(device: GPUDevice, _resources: ResourcePool): void {
    if (!ScatterPass.SHADER_SOURCE) {
      throw new Error('ScatterPass.SHADER_SOURCE must be set before calling setup()');
    }

    // Bind group layout 0: source data (uniforms + staging + dirty indices)
    this.sourceBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });

    // Bind group layout 1: destination SoA buffers
    this.destBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.sourceBindGroupLayout, this.destBindGroupLayout],
    });

    const module = device.createShaderModule({ code: ScatterPass.SHADER_SOURCE });

    this.pipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module, entryPoint: 'scatter' },
    });

    // Uniform buffer: dirty_count (u32). Minimum uniform buffer alignment is 16 bytes.
    this.uniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Upload dirty entity data for scatter.
   *
   * Called by the renderer during its upload phase, before the RenderGraph
   * dispatches execute(). Separate from prepare() because it requires data
   * not available in FrameState (staging buffer, dirty indices).
   *
   * @param device      - GPU device for buffer creation / writes
   * @param pool        - Resource pool to read destination buffers
   * @param stagingData - Packed staging data (STAGING_STRIDE u32 per entity)
   * @param dirtyIndices - Destination slot indices for each dirty entity
   * @param dirtyCount  - Number of dirty entities this frame
   */
  prepareDirtyData(
    device: GPUDevice,
    pool: ResourcePool,
    stagingData: Uint32Array,
    dirtyIndices: Uint32Array,
    dirtyCount: number,
  ): void {
    this.dirtyCount = dirtyCount;
    if (dirtyCount === 0) return;

    // Recreate staging buffer if needed (grow-only)
    const stagingBytes = stagingData.byteLength;
    if (!this.stagingBuffer || this.stagingBuffer.size < stagingBytes) {
      this.stagingBuffer?.destroy();
      this.stagingBuffer = device.createBuffer({
        size: stagingBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(this.stagingBuffer, 0, stagingData as Uint32Array<ArrayBuffer>);

    // Recreate indices buffer if needed (grow-only)
    const indicesBytes = dirtyIndices.byteLength;
    if (!this.indicesBuffer || this.indicesBuffer.size < indicesBytes) {
      this.indicesBuffer?.destroy();
      this.indicesBuffer = device.createBuffer({
        size: indicesBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(this.indicesBuffer, 0, dirtyIndices as Uint32Array<ArrayBuffer>);

    // Update uniform
    device.queue.writeBuffer(this.uniformBuffer!, 0, new Uint32Array([dirtyCount]));

    // Rebuild source bind group
    this.sourceBindGroup = device.createBindGroup({
      layout: this.sourceBindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: { buffer: this.stagingBuffer } },
        { binding: 2, resource: { buffer: this.indicesBuffer } },
      ],
    });

    // Rebuild destination bind group from pool
    const transformsBuf = pool.getBuffer('entity-transforms');
    const boundsBuf = pool.getBuffer('entity-bounds');
    const renderMetaBuf = pool.getBuffer('render-meta');
    const texIndicesBuf = pool.getBuffer('tex-indices');
    const primParamsBuf = pool.getBuffer('prim-params');

    if (transformsBuf && boundsBuf && renderMetaBuf && texIndicesBuf && primParamsBuf) {
      this.destBindGroup = device.createBindGroup({
        layout: this.destBindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: transformsBuf } },
          { binding: 1, resource: { buffer: boundsBuf } },
          { binding: 2, resource: { buffer: renderMetaBuf } },
          { binding: 3, resource: { buffer: texIndicesBuf } },
          { binding: 4, resource: { buffer: primParamsBuf } },
        ],
      });
    }
  }

  prepare(_device: GPUDevice, _frame: FrameState): void {
    // Dirty data is uploaded via prepareDirtyData() which is called
    // by the renderer before the RenderGraph dispatches execute().
    // Nothing to do here — dirtyCount is already set.
  }

  execute(encoder: GPUCommandEncoder, _frame: FrameState, _resources: ResourcePool): void {
    if (this.dirtyCount === 0 || !this.pipeline || !this.sourceBindGroup || !this.destBindGroup) {
      return;
    }

    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.sourceBindGroup);
    pass.setBindGroup(1, this.destBindGroup);
    pass.dispatchWorkgroups(ScatterPass.workgroupCount(this.dirtyCount));
    pass.end();

    // Reset for next frame — if prepareDirtyData() is not called,
    // execute() becomes a no-op
    this.dirtyCount = 0;
  }

  resize(_width: number, _height: number): void {
    // No-op for compute pass
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.stagingBuffer?.destroy();
    this.indicesBuffer?.destroy();
    this.uniformBuffer = null;
    this.stagingBuffer = null;
    this.indicesBuffer = null;
    this.pipeline = null;
    this.sourceBindGroupLayout = null;
    this.destBindGroupLayout = null;
    this.sourceBindGroup = null;
    this.destBindGroup = null;
  }
}
