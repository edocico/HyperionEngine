import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import { extractFrustumPlanes } from '../../camera';

const WORKGROUP_SIZE = 256;
const NUM_PRIM_TYPES = 6;

/**
 * GPU frustum-culling compute pass.
 *
 * Reads SoA entity buffers (transforms + bounds + renderMeta) and writes
 * per-primitive-type compacted visible-indices lists plus 6 sets of
 * indirect draw arguments (one per primitive type).
 */
export class CullPass implements RenderPass {
  readonly name = 'cull';
  readonly reads = ['entity-transforms', 'entity-bounds', 'render-meta'];
  readonly writes = ['visible-indices', 'indirect-args'];
  readonly optional = false;

  private pipeline: GPUComputePipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private cullUniformBuffer: GPUBuffer | null = null;
  private indirectBuffer: GPUBuffer | null = null;

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

    // 6 frustum planes (6 * vec4f = 96 bytes) + totalEntities (u32) + maxEntitiesPerType (u32) + 2 padding u32 = 112 bytes
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

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });

    this.pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      compute: { module: shaderModule, entryPoint: 'cull_main' },
    });

    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cullUniformBuffer } },
        { binding: 1, resource: { buffer: transformBuffer } },
        { binding: 2, resource: { buffer: boundsBuffer } },
        { binding: 3, resource: { buffer: visibleIndicesBuffer } },
        { binding: 4, resource: { buffer: this.indirectBuffer } },
        { binding: 5, resource: { buffer: renderMetaBuffer } },
      ],
    });
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.cullUniformBuffer || !this.indirectBuffer) return;

    // Upload frustum planes (6 * vec4f = 24 floats = 96 bytes) + totalEntities + maxEntitiesPerType + padding
    const CULL_UNIFORM_SIZE = 112;
    const cullData = new ArrayBuffer(CULL_UNIFORM_SIZE);
    const cullFloats = new Float32Array(cullData, 0, 24);
    const frustumPlanes = extractFrustumPlanes(frame.cameraViewProjection);
    cullFloats.set(frustumPlanes);
    const cullUints = new Uint32Array(cullData, 96, 4);
    cullUints[0] = frame.entityCount;    // totalEntities
    cullUints[1] = 100_000;             // maxEntitiesPerType (MAX_ENTITIES)
    // cullUints[2..3] = 0 (padding, already zeroed)
    device.queue.writeBuffer(this.cullUniformBuffer, 0, cullData);

    // Reset indirect draw arguments: 6 primitive types × 5 u32 each
    const resetData = new Uint32Array(NUM_PRIM_TYPES * 5);
    for (let i = 0; i < NUM_PRIM_TYPES; i++) {
      resetData[i * 5 + 0] = 6;  // indexCount (quad = 6 indices)
      resetData[i * 5 + 1] = 0;  // instanceCount (reset)
      resetData[i * 5 + 2] = 0;  // firstIndex
      resetData[i * 5 + 3] = 0;  // baseVertex
      resetData[i * 5 + 4] = 0;  // firstInstance
    }
    device.queue.writeBuffer(this.indirectBuffer, 0, resetData);
  }

  execute(encoder: GPUCommandEncoder, frame: FrameState, _resources: ResourcePool): void {
    if (!this.pipeline || !this.bindGroup) return;
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(frame.entityCount / WORKGROUP_SIZE));
    pass.end();
  }

  resize(_width: number, _height: number): void {
    // No-op for compute pass
  }

  destroy(): void {
    this.cullUniformBuffer?.destroy();
    this.cullUniformBuffer = null;
    this.pipeline = null;
    this.bindGroup = null;
    this.indirectBuffer = null; // owned by ResourcePool, don't destroy
  }
}
