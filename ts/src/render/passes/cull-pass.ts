import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import { extractFrustumPlanes } from '../../camera';

const WORKGROUP_SIZE = 256;
const NUM_PRIM_TYPES = 6;
const MAX_SUBGROUPS_PER_WG = 8;

/** Number of material-sort buckets per primitive type (tier0 vs other). */
export const BUCKETS_PER_TYPE = 2;

/** Number of blend modes: 0 = opaque, 1 = transparent. */
export const BLEND_MODES = 2;

/** Number of opaque draw buckets (6 prim types x 2 material buckets). */
export const OPAQUE_DRAW_BUCKETS = NUM_PRIM_TYPES * BUCKETS_PER_TYPE;

/**
 * Total number of indirect draw arg entries including both opaque and transparent.
 * Layout: [0..11] opaque (6 types x 2 buckets), [12..23] transparent (6 types x 2 buckets).
 */
export const TOTAL_DRAW_BUCKETS = NUM_PRIM_TYPES * BUCKETS_PER_TYPE * BLEND_MODES;

/** Offset (in number of draw entries) where transparent buckets begin. */
export const TRANSPARENT_BUCKET_OFFSET = OPAQUE_DRAW_BUCKETS;

// ── Temporal culling helpers ───────────────────────────────────────

/** Camera state snapshot for temporal invalidation detection. */
export interface CameraState {
  x: number;
  y: number;
  frustumWidth: number;
}

/**
 * Determine whether the camera has "teleported" between two frames.
 *
 * Returns `true` when the camera displacement exceeds 50 % of the frustum
 * width in either axis.  This forces a full frustum re-cull for all entities
 * instead of relying on the skip-bounds optimisation.
 */
export function computeInvalidationFlag(prev: CameraState, curr: CameraState): boolean {
  const dx = Math.abs(curr.x - prev.x);
  const dy = Math.abs(curr.y - prev.y);
  const threshold = curr.frustumWidth * 0.5;
  return dx > threshold || dy > threshold;
}

/**
 * Compute the optimal workgroup size for the cull shader.
 *
 * When subgroups are available, the workgroup is sized to contain at most
 * `MAX_SUBGROUPS_PER_WG` subgroups, capped at 256.  This keeps
 * inter-subgroup coordination efficient while maximising occupancy.
 *
 * Without subgroups the default workgroup size (256) is returned.
 */
export function computeWorkgroupSize(useSubgroups: boolean, subgroupSize: number): number {
  if (!useSubgroups) return 256;
  return Math.min(256, subgroupSize * MAX_SUBGROUPS_PER_WG);
}

/**
 * Conditionally prepend the `enable subgroups;` WGSL directive.
 *
 * The directive MUST NOT appear in the shader source when the device does
 * not support subgroups — WGSL validation would reject it.  This helper
 * keeps the raw shader file free of the directive and adds it at pipeline
 * creation time when the capability is confirmed.
 */
export function prepareShaderSource(baseSource: string, useSubgroups: boolean): string {
  if (!useSubgroups) return baseSource;
  return 'enable subgroups;\n' + baseSource;
}

/** Extract the transparent flag (bit 8) from a renderMeta entry. */
export function extractTransparentFlag(meta: number): boolean {
    return (meta & 0x100) !== 0;
}

/** Extract the primitive type (bits 0-7) from a renderMeta entry. */
export function extractPrimType(meta: number): number {
    return meta & 0xFF;
}

/**
 * GPU frustum-culling compute pass with 2-bucket material sort and opaque/transparent split.
 *
 * Reads SoA entity buffers (transforms + bounds + renderMeta + texIndices) and writes
 * per-primitive-type compacted visible-indices lists plus 24 sets of
 * indirect draw arguments: 12 opaque (6 types x 2 material buckets) followed by
 * 12 transparent (6 types x 2 material buckets).
 * Transparency is determined by bit 8 of renderMeta.
 * This reduces fragment divergence and enables correct alpha-blended rendering.
 */
/**
 * Compute the byte-size of a visibility / dirty-bits buffer for a given entity count.
 * Each entity needs 1 bit, packed into u32 words: ceil(maxEntities / 32) * 4 bytes.
 */
export function visibilityBufferSize(maxEntities: number): number {
  return Math.ceil(maxEntities / 32) * 4;
}

export class CullPass implements RenderPass {
  readonly name = 'cull';
  readonly reads = ['entity-transforms', 'entity-bounds', 'render-meta', 'tex-indices'];
  readonly writes = ['visible-indices', 'indirect-args'];
  readonly optional = false;

  private pipeline: GPUComputePipeline | null = null;
  private bindGroup0: GPUBindGroup | null = null;
  private bindGroup1: GPUBindGroup | null = null;
  private bindGroupLayout1: GPUBindGroupLayout | null = null;
  private cullUniformBuffer: GPUBuffer | null = null;
  private indirectBuffer: GPUBuffer | null = null;

  // ── Temporal culling state ─────────────────────────────────────
  private visibilityBufferA: GPUBuffer | null = null;
  private visibilityBufferB: GPUBuffer | null = null;
  private dirtyBitsBuffer: GPUBuffer | null = null;
  private frameIndex = 0;
  private invalidateAll = true;  // force full re-cull on first frame
  private allocatedMaxEntities = 0;

  /**
   * WGSL shader source for the SoA culling compute shader.
   * Set this before calling `setup()` when using the `?raw` import:
   *
   *   import cullSrc from '../../shaders/cull.wgsl?raw';
   *   CullPass.SHADER_SOURCE = cullSrc;
   *
   * A minimal default is provided so the class can be instantiated
   * without importing the shader (e.g. in unit tests).
   */
  static SHADER_SOURCE = '';

  setup(device: GPUDevice, resources: ResourcePool): void {
    if (!CullPass.SHADER_SOURCE) {
      throw new Error('CullPass.SHADER_SOURCE must be set before calling setup()');
    }

    const shaderModule = device.createShaderModule({
      code: CullPass.SHADER_SOURCE,
    });

    // 6 frustum planes (6 * vec4f = 96 bytes) + totalEntities (u32) + maxEntitiesPerType (u32) + flags (u32) + padding (u32) = 112 bytes
    this.cullUniformBuffer = device.createBuffer({
      size: 112,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const transformBuffer = resources.getBuffer('entity-transforms');
    if (!transformBuffer) throw new Error("CullPass.setup: missing 'entity-transforms' in ResourcePool");
    const boundsBuffer = resources.getBuffer('entity-bounds');
    if (!boundsBuffer) throw new Error("CullPass.setup: missing 'entity-bounds' in ResourcePool");
    const visibleIndicesBuffer = resources.getBuffer('visible-indices');
    if (!visibleIndicesBuffer) throw new Error("CullPass.setup: missing 'visible-indices' in ResourcePool");
    this.indirectBuffer = resources.getBuffer('indirect-args') ?? null;
    if (!this.indirectBuffer) throw new Error("CullPass.setup: missing 'indirect-args' in ResourcePool");
    const renderMetaBuffer = resources.getBuffer('render-meta');
    if (!renderMetaBuffer) throw new Error("CullPass.setup: missing 'render-meta' in ResourcePool");
    const texIndexBuffer = resources.getBuffer('tex-indices');
    if (!texIndexBuffer) throw new Error("CullPass.setup: missing 'tex-indices' in ResourcePool");

    const bindGroupLayout0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });

    // Bind group 1: temporal culling buffers (visibility prev, dirty bits, visibility out)
    this.bindGroupLayout1 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    this.pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout0, this.bindGroupLayout1] }),
      compute: { module: shaderModule, entryPoint: 'cull_main' },
    });

    this.bindGroup0 = device.createBindGroup({
      layout: bindGroupLayout0,
      entries: [
        { binding: 0, resource: { buffer: this.cullUniformBuffer } },
        { binding: 1, resource: { buffer: transformBuffer } },
        { binding: 2, resource: { buffer: boundsBuffer } },
        { binding: 3, resource: { buffer: visibleIndicesBuffer } },
        { binding: 4, resource: { buffer: this.indirectBuffer } },
        { binding: 5, resource: { buffer: renderMetaBuffer } },
        { binding: 6, resource: { buffer: texIndexBuffer } },
      ],
    });

    // Create temporal culling buffers with initial size (will grow as needed)
    this._ensureTemporalBuffers(device, 100_000);
  }

  /**
   * Ensure temporal culling buffers are large enough for `maxEntities`.
   * Creates or recreates visibility ping-pong and dirty-bits GPU buffers.
   */
  private _ensureTemporalBuffers(device: GPUDevice, maxEntities: number): void {
    if (maxEntities <= this.allocatedMaxEntities && this.visibilityBufferA) return;

    // Destroy old buffers
    this.visibilityBufferA?.destroy();
    this.visibilityBufferB?.destroy();
    this.dirtyBitsBuffer?.destroy();

    const size = visibilityBufferSize(maxEntities);
    // Minimum 4 bytes to satisfy WebGPU buffer size requirements
    const bufSize = Math.max(size, 4);

    this.visibilityBufferA = device.createBuffer({
      size: bufSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.visibilityBufferB = device.createBuffer({
      size: bufSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.dirtyBitsBuffer = device.createBuffer({
      size: bufSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.allocatedMaxEntities = maxEntities;
    this.invalidateAll = true;  // new buffers → force full re-cull
    this.frameIndex = 0;

    // Rebuild bind group 1 with new buffers
    this._rebuildBindGroup1(device);
  }

  /** Rebuild bind group 1 after buffer reallocation or ping-pong swap. */
  private _rebuildBindGroup1(device: GPUDevice): void {
    if (!this.bindGroupLayout1 || !this.visibilityBufferA || !this.visibilityBufferB || !this.dirtyBitsBuffer) return;

    // Even frame: read A, write B.  Odd frame: read B, write A.
    const prevBuf = (this.frameIndex & 1) === 0 ? this.visibilityBufferA : this.visibilityBufferB;
    const outBuf  = (this.frameIndex & 1) === 0 ? this.visibilityBufferB : this.visibilityBufferA;

    this.bindGroup1 = device.createBindGroup({
      layout: this.bindGroupLayout1,
      entries: [
        { binding: 0, resource: { buffer: prevBuf } },
        { binding: 1, resource: { buffer: this.dirtyBitsBuffer } },
        { binding: 2, resource: { buffer: outBuf } },
      ],
    });
  }

  /** Force a full re-cull on the next frame (e.g. after camera teleport). */
  forceInvalidateAll(): void {
    this.invalidateAll = true;
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.cullUniformBuffer || !this.indirectBuffer) return;

    // Grow temporal buffers if entity count exceeds allocation
    if (frame.entityCount > this.allocatedMaxEntities) {
      this._ensureTemporalBuffers(device, frame.entityCount);
    }

    // Upload frustum planes (6 * vec4f = 24 floats = 96 bytes) + totalEntities + maxEntitiesPerType + flags + padding
    const CULL_UNIFORM_SIZE = 112;
    const cullData = new ArrayBuffer(CULL_UNIFORM_SIZE);
    const cullFloats = new Float32Array(cullData, 0, 24);
    const frustumPlanes = extractFrustumPlanes(frame.cameraViewProjection);
    cullFloats.set(frustumPlanes);
    const cullUints = new Uint32Array(cullData, 96, 4);
    cullUints[0] = frame.entityCount;    // totalEntities
    cullUints[1] = 100_000;             // maxEntitiesPerType (MAX_ENTITIES)
    // flags — bit 0: invalidate_all (force full frustum test for all entities)
    cullUints[2] = this.invalidateAll ? 1 : 0;
    // cullUints[3] = 0 (padding)
    device.queue.writeBuffer(this.cullUniformBuffer, 0, cullData);

    // Upload dirty bits from frame data (or all-ones if invalidating)
    if (this.dirtyBitsBuffer) {
      if (frame.dirtyBits && frame.dirtyBits.length > 0 && !this.invalidateAll) {
        const uploadLen = Math.min(frame.dirtyBits.length, Math.ceil(frame.entityCount / 32));
        device.queue.writeBuffer(
          this.dirtyBitsBuffer, 0,
          frame.dirtyBits as Uint32Array<ArrayBuffer>, 0,
          uploadLen,
        );
      } else {
        // No dirty bits provided or invalidating → zero (shader uses invalidate_all flag)
        const zeroes = new Uint32Array(Math.ceil(frame.entityCount / 32));
        device.queue.writeBuffer(this.dirtyBitsBuffer, 0, zeroes);
      }
    }

    // Clear visibility-out buffer before dispatch
    const outBuf = (this.frameIndex & 1) === 0 ? this.visibilityBufferB : this.visibilityBufferA;
    if (outBuf) {
      const clearSize = visibilityBufferSize(frame.entityCount);
      if (clearSize > 0) {
        // clearBuffer rounds down to 4-byte alignment, which is always satisfied
        encoder_clearBuffer_workaround(device, outBuf, clearSize);
      }
    }

    // Rebuild bind group 1 for current ping-pong orientation
    this._rebuildBindGroup1(device);

    // Reset indirect draw arguments: 24 buckets (12 opaque + 12 transparent) × 5 u32 each.
    // firstInstance encodes the visible-indices region offset so the vertex shader
    // can read visibleIndices[instance_index] directly (instance_index = firstInstance + slot).
    const MAX_ENTITIES_PER_TYPE = 100_000;
    const resetData = new Uint32Array(TOTAL_DRAW_BUCKETS * 5);
    for (let i = 0; i < TOTAL_DRAW_BUCKETS; i++) {
      resetData[i * 5 + 0] = 6;  // indexCount (quad = 6 indices)
      resetData[i * 5 + 1] = 0;  // instanceCount (reset by cull shader)
      resetData[i * 5 + 2] = 0;  // firstIndex
      resetData[i * 5 + 3] = 0;  // baseVertex
      resetData[i * 5 + 4] = i * MAX_ENTITIES_PER_TYPE;  // firstInstance = region offset
    }
    device.queue.writeBuffer(this.indirectBuffer, 0, resetData);

    // Clear invalidateAll after use (only force once)
    this.invalidateAll = false;
  }

  execute(encoder: GPUCommandEncoder, frame: FrameState, _resources: ResourcePool): void {
    if (!this.pipeline || !this.bindGroup0 || !this.bindGroup1) return;
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup0);
    pass.setBindGroup(1, this.bindGroup1);
    pass.dispatchWorkgroups(Math.ceil(frame.entityCount / WORKGROUP_SIZE));
    pass.end();

    // Ping-pong: advance frame index so next frame swaps prev/out buffers
    this.frameIndex++;
  }

  resize(_width: number, _height: number): void {
    // No-op for compute pass
  }

  destroy(): void {
    this.cullUniformBuffer?.destroy();
    this.cullUniformBuffer = null;
    this.visibilityBufferA?.destroy();
    this.visibilityBufferA = null;
    this.visibilityBufferB?.destroy();
    this.visibilityBufferB = null;
    this.dirtyBitsBuffer?.destroy();
    this.dirtyBitsBuffer = null;
    this.pipeline = null;
    this.bindGroup0 = null;
    this.bindGroup1 = null;
    this.bindGroupLayout1 = null;
    this.indirectBuffer = null; // owned by ResourcePool, don't destroy
    this.allocatedMaxEntities = 0;
  }
}

/**
 * Workaround: `encoder.clearBuffer` is only available on GPUCommandEncoder,
 * but `prepare()` receives a GPUDevice. Use writeBuffer with zeroes instead.
 */
function encoder_clearBuffer_workaround(device: GPUDevice, buffer: GPUBuffer, byteLength: number): void {
  const zeroes = new Uint32Array(byteLength / 4);
  device.queue.writeBuffer(buffer, 0, zeroes);
}
