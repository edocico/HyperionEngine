import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';

const WORKGROUP_SIZE = 256;

/**
 * GPU frustum-culling compute pass.
 *
 * Reads SoA entity buffers (transforms + bounds) and writes a compacted
 * visible-indices list plus indirect draw arguments.
 */
export class CullPass implements RenderPass {
  readonly name = 'cull';
  readonly reads = ['entity-transforms', 'entity-bounds'];
  readonly writes = ['visible-indices', 'indirect-args'];
  readonly optional = false;

  private pipeline: GPUComputePipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private cullUniformBuffer: GPUBuffer | null = null;

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
    const shaderModule = device.createShaderModule({
      code: CullPass.SHADER_SOURCE,
    });

    // 6 frustum planes (6 * vec4f = 96 bytes) + totalEntities (u32) + 3 padding u32 = 112 bytes
    this.cullUniformBuffer = device.createBuffer({
      size: 112,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const transformBuffer = resources.getBuffer('entity-transforms')!;
    const boundsBuffer = resources.getBuffer('entity-bounds')!;
    const visibleIndicesBuffer = resources.getBuffer('visible-indices')!;
    const indirectBuffer = resources.getBuffer('indirect-args')!;

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
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
        { binding: 4, resource: { buffer: indirectBuffer } },
      ],
    });
  }

  prepare(_device: GPUDevice, _frame: FrameState): void {
    // Upload frustum planes + entity count to cullUniformBuffer.
    // Full implementation deferred to renderer integration task.
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
  }
}
