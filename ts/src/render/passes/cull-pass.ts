import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import { extractFrustumPlanes } from '../../camera';

const WORKGROUP_SIZE = 256;

/**
 * 7 = Quad, Line, SDFGlyph, BezierPath, Gradient, BoxShadow, Light2D.
 *
 * ⚠️ `cull.wgsl` declares its own `NUM_PRIM_TYPES` — the two are independent
 * declarations of the same number and nothing but agreement makes them work.
 * WGSL cannot be compiled headless, so no test can catch a mismatch at the
 * shader end; `cull-pass.test.ts` asserts the shader text instead. Land both
 * in the same commit. This is check #4 of the `wgsl-validator` agent.
 */
export const NUM_PRIM_TYPES = 7;
const MAX_SUBGROUPS_PER_WG = 8;

/** Number of material-sort buckets per primitive type (tier0 vs other). */
export const BUCKETS_PER_TYPE = 2;

/** Number of blend modes: 0 = opaque, 1 = transparent. */
export const BLEND_MODES = 2;

/** Number of opaque draw buckets (7 prim types x 2 material buckets). */
export const OPAQUE_DRAW_BUCKETS = NUM_PRIM_TYPES * BUCKETS_PER_TYPE;

/**
 * Total number of indirect draw arg entries including both opaque and transparent.
 * Layout: [0..13] opaque (7 types x 2 buckets), [14..27] transparent (7 types x 2 buckets).
 *
 * Light2D (type 6) is filed like any other type: bucket 1 for a texture of tier
 * > 0, the transparent half for `.transparent()`. A plain light fills only slot
 * 12, but LightAccumStage draws all four (`LIGHT2D_ARG_SLOTS`). The waste of the
 * usually-empty three is uniform, which is the point — a variable bucket count per type would break the flat
 * `blendOffset + primType * BUCKETS_PER_TYPE + bucket` indexing in `cull.wgsl`
 * and put a branch in the hot loop.
 */
export const TOTAL_DRAW_BUCKETS = NUM_PRIM_TYPES * BUCKETS_PER_TYPE * BLEND_MODES;

/** Offset (in number of draw entries) where transparent buckets begin. */
export const TRANSPARENT_BUCKET_OFFSET = OPAQUE_DRAW_BUCKETS;

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
 * Region of `cull.wgsl` that only compiles on a device with the `subgroups`
 * feature. Deleted wholesale when it does not.
 */
const SUBGROUP_REGION = /^[ \t]*\/\/ BEGIN-SUBGROUPS-ONLY[\s\S]*?\/\/ END-SUBGROUPS-ONLY[ \t]*\r?\n/m;

/**
 * Specialise `cull.wgsl` for what the device can actually do.
 *
 * 3 levels:
 * - No subgroups: **strip** the `BEGIN/END-SUBGROUPS-ONLY` region
 * - Subgroups: prepend `enable subgroups;`
 * - Subgroups + subgroup_id (Chrome 144+): also prepend `requires subgroup_id;`
 *
 * ⚠️ The stripping is not an optimisation, it is what makes the shader compile
 * at all without the feature. `override USE_SUBGROUPS` decides which branch
 * *runs*, but WGSL validates every builtin call in the module no matter what
 * the override is set to, so a `subgroupAdd` left in the text is a hard compile
 * error on a device that lacks the extension — and since `createRenderer`
 * catches the failure and yields a null renderer, the symptom is a completely
 * blank canvas rather than an error. That covers all of Firefox and Safari.
 *
 * Textual stripping is the only tool available: WGSL has no preprocessor, and
 * `override` is limited to scalar values.
 */
export function prepareShaderSource(
  baseSource: string,
  useSubgroups: boolean,
  useSubgroupId: boolean = false,
): string {
  if (!useSubgroups) return baseSource.replace(SUBGROUP_REGION, '');
  let prefix = 'enable subgroups;\n';
  if (useSubgroupId) prefix += 'requires subgroup_id;\n';
  return prefix + baseSource;
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
 * Reads SoA entity buffers (bounds + renderMeta + texIndices) and writes
 * per-primitive-type compacted visible-indices lists plus 28 sets of
 * indirect draw arguments: 14 opaque (7 types x 2 material buckets) followed by
 * 14 transparent (7 types x 2 material buckets).
 * Transparency is determined by bit 8 of renderMeta.
 * This reduces fragment divergence and enables correct alpha-blended rendering.
 */
export class CullPass implements RenderPass {
  readonly name = 'cull';
  readonly reads = ['entity-bounds', 'render-meta', 'tex-indices'];
  readonly writes = ['visible-indices', 'indirect-args'];
  readonly optional = false;

  private pipeline: GPUComputePipeline | null = null;
  private bindGroup0: GPUBindGroup | null = null;
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

  static SUBGROUP_CONFIG: { useSubgroups: boolean; subgroupSize: number; useSubgroupId: boolean } =
    { useSubgroups: false, subgroupSize: 32, useSubgroupId: false };

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
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });

    this.pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout0] }),
      compute: {
        module: shaderModule,
        entryPoint: 'cull_main',
        constants: {
          USE_SUBGROUPS: CullPass.SUBGROUP_CONFIG.useSubgroups ? 1 : 0,
          SUBGROUP_SIZE: CullPass.SUBGROUP_CONFIG.subgroupSize,
          USE_SUBGROUP_ID: CullPass.SUBGROUP_CONFIG.useSubgroupId ? 1 : 0,
        },
      },
    });

    this.bindGroup0 = device.createBindGroup({
      layout: bindGroupLayout0,
      entries: [
        { binding: 0, resource: { buffer: this.cullUniformBuffer } },
        { binding: 1, resource: { buffer: boundsBuffer } },
        { binding: 2, resource: { buffer: visibleIndicesBuffer } },
        { binding: 3, resource: { buffer: this.indirectBuffer } },
        { binding: 4, resource: { buffer: renderMetaBuffer } },
        { binding: 5, resource: { buffer: texIndexBuffer } },
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
    // cullUints[2..3] = 0 (padding)
    device.queue.writeBuffer(this.cullUniformBuffer, 0, cullData);


    // Reset indirect draw arguments: 28 buckets (14 opaque + 14 transparent) × 5 u32 each.
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
  }

  execute(encoder: GPUCommandEncoder, frame: FrameState, _resources: ResourcePool): void {
    // An empty world: prepare() already reset every bucket to zero instances,
    // and a 0-workgroup dispatch is a WebGPU warning on every frame.
    if (!this.pipeline || !this.bindGroup0 || frame.entityCount === 0) return;
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup0);
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
    this.bindGroup0 = null;
    this.indirectBuffer = null; // owned by ResourcePool, don't destroy
  }
}
