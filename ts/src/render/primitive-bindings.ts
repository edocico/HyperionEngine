import type { ResourcePool } from './resource-pool';

/**
 * Bind group layouts shared by every pipeline that runs a primitive shader:
 * the ForwardPass pipelines and the occluder pipelines (OccluderSeedStage). Both run the
 * same WGSL modules, so both must hand the device the same layouts.
 */

/** Group 0: camera, transforms, visible indices, then the per-entity columns the fragment stage may read too. */
export function primitiveGroup0LayoutEntries(): GPUBindGroupLayoutEntry[] {
  const vs = GPUShaderStage.VERTEX;
  const vsFs = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  return [
    // CameraUniform is 80 bytes in every primitive shader (viewProjection +
    // occluderLayers + pads). Declared, so a smaller buffer fails when the bind
    // group is created instead of at draw time, where no test can see it.
    { binding: 0, visibility: vs, buffer: { type: 'uniform', minBindingSize: 80 } }, // camera
    { binding: 1, visibility: vs, buffer: { type: 'read-only-storage' } },     // transforms
    { binding: 2, visibility: vs, buffer: { type: 'read-only-storage' } },     // visibleIndices
    { binding: 3, visibility: vsFs, buffer: { type: 'read-only-storage' } },   // texLayerIndices (gradient reads in fs)
    { binding: 4, visibility: vsFs, buffer: { type: 'read-only-storage' } },   // renderMeta
    { binding: 5, visibility: vsFs, buffer: { type: 'read-only-storage' } },   // primParams
  ];
}

/** The pool buffers group 0 binds after the camera uniform, in binding order. */
export const PRIMITIVE_GROUP0_BUFFERS = ['entity-transforms', 'visible-indices', 'tex-indices', 'render-meta', 'prim-params'] as const;

/** Group-1 resources of every primitive shader, in binding order: tier0-3, the sampler, ovf0-3. */
const GROUP1 = ['tier0', 'tier1', 'tier2', 'tier3', 'texSampler', 'ovf0', 'ovf1', 'ovf2', 'ovf3'] as const;

/**
 * The group-1 layout every primitive shader declares: four texture tiers, the
 * sampler, four overflow tiers. All primitive pipelines share it, whether or
 * not the shader samples a texture.
 */
export function textureTierLayoutEntries(): GPUBindGroupLayoutEntry[] {
  return GROUP1.map((name, binding): GPUBindGroupLayoutEntry => name === 'texSampler'
    ? { binding, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
    : { binding, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } });
}

/**
 * A group-1 bind group that follows the pool.
 *
 * A texture tier that grows gets a new texture and view, and the old texture is
 * destroyed (see `TextureManager.onViewsChanged`). A bind group still holding
 * the old view makes every draw use a destroyed texture, and the whole frame is
 * dropped. `current()` rebuilds whenever a view or the sampler in the pool
 * differs from what the group was built from. That is nine map lookups, cheap
 * enough to run every frame, so correctness does not rest on the notification.
 */
export class TextureTierBinding {
  private group: GPUBindGroup | null = null;
  private builtFrom: Array<GPUTextureView | GPUSampler> = [];

  constructor(private readonly layout: GPUBindGroupLayout) {}

  /** The bind group for the pool's current views, or null while any is missing. */
  current(device: GPUDevice, resources: ResourcePool): GPUBindGroup | null {
    const views = GROUP1.map((name) =>
      name === 'texSampler' ? resources.getSampler(name) : resources.getTextureView(name));
    if (views.some((v) => !v)) return this.group;
    const resolved = views as Array<GPUTextureView | GPUSampler>;
    if (this.group && resolved.every((v, i) => v === this.builtFrom[i])) return this.group;

    this.group = device.createBindGroup({
      layout: this.layout,
      entries: resolved.map((resource, binding) => ({ binding, resource })),
    });
    this.builtFrom = resolved;
    return this.group;
  }
}
