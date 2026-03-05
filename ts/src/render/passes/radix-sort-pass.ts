import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';

/**
 * GPU Radix Sort pass for transparent entity ordering.
 *
 * Performs a 4-pass 8-bit radix sort on composite sort keys that encode
 * (primType << 24 | depthDescending >> 8), producing back-to-front order
 * grouped by primitive type.
 *
 * Designed for small transparent subsets (500-5000 entities).
 * Ping-pongs between two key/value buffer pairs across passes.
 *
 * The pass is optional — it only runs when transparent entities exist.
 */
export class RadixSortPass implements RenderPass {
  readonly name = 'radix-sort';
  readonly reads = ['transparent-keys', 'transparent-vals-in'];
  readonly writes = ['transparent-vals-sorted'];
  readonly optional = true;

  /**
   * WGSL shader source for the radix sort compute shader.
   * Set this before calling `setup()` when using the `?raw` import:
   *
   *   import radixSortSrc from '../../shaders/radix-sort.wgsl?raw';
   *   RadixSortPass.SHADER_SOURCE = radixSortSrc;
   *
   * A minimal default is provided so the class can be instantiated
   * without importing the shader (e.g. in unit tests).
   */
  static SHADER_SOURCE = '';

  private histogramPipeline: GPUComputePipeline | null = null;
  private prefixSumPipeline: GPUComputePipeline | null = null;
  private scatterPipeline: GPUComputePipeline | null = null;

  private paramsBuffer: GPUBuffer | null = null;
  private histogramBuffer: GPUBuffer | null = null;

  // Ping-pong key/value buffers: [0] = A pair, [1] = B pair
  private keysBuffers: [GPUBuffer | null, GPUBuffer | null] = [null, null];
  private valsBuffers: [GPUBuffer | null, GPUBuffer | null] = [null, null];

  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private allocatedCount = 0;
  private lastCount = 0;

  /** Number of radix passes (8-bit digits in a 32-bit key). */
  static readonly RADIX_PASSES = 4;

  /** Number of histogram buckets (2^8 = 256). */
  static readonly HISTOGRAM_BUCKETS = 256;

  /** Workgroup size matching the shader override default. */
  static readonly WORKGROUP_SIZE = 256;

  /**
   * Compute the number of workgroups needed for n elements.
   */
  static workgroupCount(n: number): number {
    if (n <= 0) return 0;
    return Math.ceil(n / RadixSortPass.WORKGROUP_SIZE);
  }

  setup(device: GPUDevice, _resources: ResourcePool): void {
    if (!RadixSortPass.SHADER_SOURCE) {
      throw new Error('RadixSortPass.SHADER_SOURCE must be set before calling setup()');
    }

    const module = device.createShaderModule({ code: RadixSortPass.SHADER_SOURCE });

    // Single bind group layout shared by all 3 entry points
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // keys_in
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // vals_in
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },            // keys_out
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },            // vals_out
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },            // histogram
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },            // params
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.histogramPipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module, entryPoint: 'build_histogram' },
    });

    this.prefixSumPipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module, entryPoint: 'prefix_sum' },
    });

    this.scatterPipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module, entryPoint: 'scatter' },
    });

    // Params uniform buffer: RadixParams { count: u32, bit_offset: u32 } = 8 bytes.
    // Minimum uniform buffer size is 16 bytes (WebGPU spec minUniformBufferOffsetAlignment).
    this.paramsBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Histogram buffer: 256 u32 entries
    this.histogramBuffer = device.createBuffer({
      size: RadixSortPass.HISTOGRAM_BUCKETS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Ensure ping-pong buffers are large enough for `count` elements.
   * Grow-only: buffers are only recreated when larger capacity is needed.
   */
  private ensureBuffers(device: GPUDevice, count: number): void {
    if (count <= this.allocatedCount) return;

    // Destroy old buffers
    for (let i = 0; i < 2; i++) {
      this.keysBuffers[i]?.destroy();
      this.valsBuffers[i]?.destroy();
    }

    const byteSize = count * 4; // u32 per element
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;

    for (let i = 0; i < 2; i++) {
      this.keysBuffers[i] = device.createBuffer({ size: byteSize, usage });
      this.valsBuffers[i] = device.createBuffer({ size: byteSize, usage });
    }

    this.allocatedCount = count;
  }

  /**
   * Upload sort input data. Called by the renderer before RenderGraph dispatch.
   *
   * @param device - GPU device
   * @param keys   - Composite sort keys (one per transparent entity)
   * @param vals   - Entity indices (payload to sort alongside keys)
   * @param count  - Number of elements to sort
   */
  prepareSortData(device: GPUDevice, keys: Uint32Array, vals: Uint32Array, count: number): void {
    this.lastCount = count;
    if (count === 0) return;

    this.ensureBuffers(device, count);

    // Upload initial data to buffer pair A (index 0)
    device.queue.writeBuffer(this.keysBuffers[0]!, 0, keys as Uint32Array<ArrayBuffer>);
    device.queue.writeBuffer(this.valsBuffers[0]!, 0, vals as Uint32Array<ArrayBuffer>);
  }

  prepare(_device: GPUDevice, _frame: FrameState): void {
    // Sort data is uploaded via prepareSortData() which is called
    // by the renderer before the RenderGraph dispatches execute().
  }

  execute(_encoder: GPUCommandEncoder, _frame: FrameState, _resources: ResourcePool): void {
    // The RenderPass interface's execute() does not provide a GPUDevice,
    // which is needed to create per-pass bind groups and write uniforms.
    // The actual sort dispatch happens via dispatchSort(), called by the
    // renderer which has access to the device.
    //
    // This method is intentionally a no-op. The renderer calls
    // dispatchSort() directly instead of going through the RenderGraph
    // for this pass.
  }

  /**
   * Execute the full 4-pass radix sort.
   *
   * Called by the renderer which has access to the device.
   * This is separate from execute() because we need the device
   * to create bind groups and write uniform buffers per-pass.
   *
   * After completion, sorted values are in valsBuffers[RADIX_PASSES % 2]
   * (buffer pair A for even pass count = index 0).
   */
  dispatchSort(device: GPUDevice, encoder: GPUCommandEncoder): GPUBuffer | null {
    if (
      this.lastCount === 0 ||
      !this.histogramPipeline ||
      !this.prefixSumPipeline ||
      !this.scatterPipeline ||
      !this.paramsBuffer ||
      !this.histogramBuffer ||
      !this.bindGroupLayout
    ) {
      return null;
    }

    const count = this.lastCount;
    const wgCount = RadixSortPass.workgroupCount(count);

    for (let pass = 0; pass < RadixSortPass.RADIX_PASSES; pass++) {
      const bitOffset = pass * 8;
      const srcIdx = pass % 2;
      const dstIdx = 1 - srcIdx;

      // Update params uniform
      device.queue.writeBuffer(this.paramsBuffer, 0, new Uint32Array([count, bitOffset]));

      // Clear histogram
      encoder.clearBuffer(this.histogramBuffer, 0, RadixSortPass.HISTOGRAM_BUCKETS * 4);

      // Build bind group for this pass direction
      const bindGroup = device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.keysBuffers[srcIdx]! } },
          { binding: 1, resource: { buffer: this.valsBuffers[srcIdx]! } },
          { binding: 2, resource: { buffer: this.keysBuffers[dstIdx]! } },
          { binding: 3, resource: { buffer: this.valsBuffers[dstIdx]! } },
          { binding: 4, resource: { buffer: this.histogramBuffer } },
          { binding: 5, resource: { buffer: this.paramsBuffer } },
        ],
      });

      // Pass 1: Build histogram
      const histPass = encoder.beginComputePass();
      histPass.setPipeline(this.histogramPipeline);
      histPass.setBindGroup(0, bindGroup);
      histPass.dispatchWorkgroups(wgCount);
      histPass.end();

      // Pass 2: Prefix sum (single workgroup, single thread)
      const prefixPass = encoder.beginComputePass();
      prefixPass.setPipeline(this.prefixSumPipeline);
      prefixPass.setBindGroup(0, bindGroup);
      prefixPass.dispatchWorkgroups(1);
      prefixPass.end();

      // Pass 3: Scatter
      const scatterPass = encoder.beginComputePass();
      scatterPass.setPipeline(this.scatterPipeline);
      scatterPass.setBindGroup(0, bindGroup);
      scatterPass.dispatchWorkgroups(wgCount);
      scatterPass.end();
    }

    // After 4 passes (even number), result is back in buffer pair A (index 0)
    const resultIdx = RadixSortPass.RADIX_PASSES % 2;
    this.lastCount = 0;
    return this.valsBuffers[resultIdx];
  }

  /**
   * Get the result buffer containing sorted values after dispatchSort().
   * Returns the vals buffer where the final pass wrote its output.
   * For 4 passes (even), this is buffer pair A (index 0).
   */
  getResultBuffer(): GPUBuffer | null {
    const resultIdx = RadixSortPass.RADIX_PASSES % 2;
    return this.valsBuffers[resultIdx];
  }

  resize(_width: number, _height: number): void {
    // No-op for compute pass
  }

  destroy(): void {
    this.paramsBuffer?.destroy();
    this.histogramBuffer?.destroy();
    for (let i = 0; i < 2; i++) {
      this.keysBuffers[i]?.destroy();
      this.valsBuffers[i]?.destroy();
    }
    this.paramsBuffer = null;
    this.histogramBuffer = null;
    this.keysBuffers = [null, null];
    this.valsBuffers = [null, null];
    this.histogramPipeline = null;
    this.prefixSumPipeline = null;
    this.scatterPipeline = null;
    this.bindGroupLayout = null;
  }
}

// --- CPU reference implementations for testing ---

/**
 * Convert an IEEE-754 float to a sort-friendly unsigned integer.
 *
 * Positive floats map to the upper half of u32 (preserving order).
 * Negative floats are flipped so that more-negative values map to
 * smaller unsigned integers. This makes the entire float range
 * sortable with a simple unsigned integer comparison.
 */
export function floatToSortKey(f: number): number {
  const buf = new Float32Array([f]);
  const bits = new Uint32Array(buf.buffer)[0];
  const mask = (bits & 0x80000000) !== 0 ? 0xFFFFFFFF : 0x80000000;
  return (bits ^ mask) >>> 0;
}

/**
 * Build a composite sort key for transparent entity ordering.
 *
 * Layout: (primType << 24) | (depthDescending >> 8)
 *
 * - Upper 8 bits: primitive type (groups same-type entities together)
 * - Lower 24 bits: inverted depth (back-to-front within each type)
 *
 * When sorted ascending by this key, entities are grouped by primitive
 * type and within each group ordered back-to-front for correct alpha
 * blending.
 */
export function makeTransparentSortKey(primType: number, depth: number): number {
  const depthBits = floatToSortKey(depth);
  const depthDescending = (~depthBits) >>> 0;
  return ((primType << 24) | (depthDescending >>> 8)) >>> 0;
}

/**
 * CPU reference: sort key/value pairs using the same radix sort logic.
 * Useful for validation and fallback when GPU compute is unavailable.
 */
export function cpuRadixSort(keys: Uint32Array, vals: Uint32Array): { keys: Uint32Array; vals: Uint32Array } {
  const n = keys.length;
  if (n === 0) return { keys: new Uint32Array(0), vals: new Uint32Array(0) };

  let srcKeys = new Uint32Array(keys);
  let srcVals = new Uint32Array(vals);
  let dstKeys = new Uint32Array(n);
  let dstVals = new Uint32Array(n);

  for (let pass = 0; pass < 4; pass++) {
    const bitOffset = pass * 8;

    // Build histogram
    const histogram = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const digit = (srcKeys[i] >>> bitOffset) & 0xFF;
      histogram[digit]++;
    }

    // Exclusive prefix sum
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      const count = histogram[i];
      histogram[i] = sum;
      sum += count;
    }

    // Scatter
    for (let i = 0; i < n; i++) {
      const digit = (srcKeys[i] >>> bitOffset) & 0xFF;
      const dest = histogram[digit]++;
      dstKeys[dest] = srcKeys[i];
      dstVals[dest] = srcVals[i];
    }

    // Swap
    [srcKeys, dstKeys] = [dstKeys, srcKeys];
    [srcVals, dstVals] = [dstVals, srcVals];
  }

  return { keys: srcKeys, vals: srcVals };
}
