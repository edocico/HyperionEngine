import type { FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import type { LightGroup } from '../light-groups';
import { SCENE_HDR_FORMAT } from '../formats';
import { DEFAULT_LIGHTING_QUALITY } from '../../lighting-api';

/**
 * The one blend state of the light pipeline (round step 7): premultiplied
 * "over" on colour, rgb + dst·(1 − a). light-accum.wgsl returns alpha 0 for an
 * add or sub light, which keeps dst whole, dst + c: what {one, one} gave, bit
 * for bit. A mix light returns (color·w, w): dst·(1 − w) + color·w. The alpha
 * component keeps dst's alpha, the clear's 1, whatever a light returns; nobody
 * reads it (the prelude's applyLighting samples rgb).
 */
export const LIGHT_BLEND: GPUBlendState = {
  color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
};

/** The light list buffer's first capacity, in lights (256 bytes); it grows to the next power of two. */
export const MIN_LIGHT_ORDER_CAPACITY = 64;

/**
 * Soft-shadow hardness k of point and spot lights: their apparent angle is at
 * most 1/k. A directional light uses LIGHT_SOURCE_FRACTION instead (round
 * step 6). With h and t in texels of the half-resolution SDF, 8 gives a
 * visible, not blurry, penumbra.
 */
export const SHADOW_HARDNESS = 8;

/**
 * A light's source radius as a fraction of its range. The shader caps the
 * light's apparent angle at min(1/k, sourceRadius / distance): without the
 * cap the light's radius grows with the pixel's distance (D/k), and a light
 * beside a wall darkens the pixels on the far side of it too. 0.02 keeps a
 * light that is range/50 or more away from a wall unoccluded on the open side.
 * It is also a directional light's penumbra angle, in radians, fixed
 * engine-wide (round step 6): the penumbra's width per unit of distance, i.e.
 * about the source's angular diameter (0.02 rad, about 1.15°) (confirmed by
 * the GPU A/B of round step 6:
 * docs/plans/assets/2026-09-30-step6/penumbra-ab-m2.json). A sun gets the
 * penumbra a point light has at the edge of its range.
 */
export const LIGHT_SOURCE_FRACTION = 0.02;

/** Uniform slices are 256 bytes apart: the WebGPU minimum uniform-buffer offset alignment. */
export const SLICE = 256;

/** LightUniform: viewProjection (64) + shadowSteps, hardness, sourceFraction, groupLayers (16). */
const LIGHT_UNIFORM_SIZE = 80;

/**
 * The largest step budget the uniform carries: a sun marches
 * `4u * u.shadowSteps` (light-accum.wgsl sunShadow), which wraps in u32 from
 * 2^30 and would give the sun 0 steps. A budget this large is unbounded
 * anyway: every ray stops at the end of its travel.
 */
const MAX_SHADOW_STEPS = 0x3fffffff;

/**
 * Accumulates the lights of ONE light group into one layer of the light buffer
 * (Phase 17; light layers, design 2026-09-26). A stage of LightGroupsPass, not
 * a graph node. The target is `halfResolution`, the SDF's texels, in
 * `SCENE_HDR_FORMAT`, cleared to the ambient light.
 *
 * Since round step 7 it draws the frame's light list (`deriveLightGroups`)
 * through ONE pipeline with a premultiplied "over" blend (LIGHT_BLEND), in ONE
 * direct instanced draw per group: instance i is the list's i-th light, so
 * neither the cull's order nor `indirect-first-instance` reaches the lights.
 * The vertex stage drops a light whose mask misses the group's layers; see
 * light-accum.wgsl for the shapes, the shadows and the blend modes. The
 * uniform slices and the list are written once, in `prepare()`: a writeBuffer
 * between the passes of one frame would land only with its last write. The
 * list's buffer is this stage's own: an HMR probe runs setup() then destroy().
 */
export class LightAccumStage {
  /** WGSL shader source (`light-accum.wgsl`). Set before calling `setup()`. */
  static SHADER_SOURCE = '';

  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private slices = 0;
  /** Per group: the bind group, and the SDF view it was made with. */
  private readonly bindGroups = new Map<number, { group: GPUBindGroup; sdf: GPUTextureView }>();
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  /** The light list, `light-order`: grow-only, written once per frame in prepare(). */
  private orderBuffer: GPUBuffer | null = null;
  private orderCapacity = 0;
  /** This frame's list length, set by every prepare(): a frame never draws an earlier one's list. */
  private lightCount = 0;
  /** The pool's columns, by binding: transforms (1), primParams (3), renderMeta (4). */
  private columns: Array<[number, GPUBuffer]> = [];
  private device: GPUDevice | null = null;

  setup(device: GPUDevice, resources: ResourcePool): void {
    if (!LightAccumStage.SHADER_SOURCE) {
      throw new Error('LightAccumStage.SHADER_SOURCE must be set before setup()');
    }
    this.device = device;

    const vertices = new Float32Array([-0.5, -0.5, 0.0, 0.5, -0.5, 0.0, 0.5, 0.5, 0.0, -0.5, 0.5, 0.0]);
    this.vertexBuffer = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertexBuffer, 0, vertices);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    this.indexBuffer = device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.indexBuffer, 0, indices);

    const columns: Array<[number, string]> = [[1, 'entity-transforms'], [3, 'prim-params'], [4, 'render-meta']];
    this.columns = columns.map(([binding, name]) => {
      const buffer = resources.getBuffer(name);
      if (!buffer) throw new Error(`LightAccumStage.setup: missing '${name}' in ResourcePool`);
      return [binding, buffer];
    });
    // Created now, so that every bind group is valid from the first frame,
    // an empty list included.
    this.orderCapacity = MIN_LIGHT_ORDER_CAPACITY;
    this.orderBuffer = device.createBuffer({
      size: this.orderCapacity * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'light-order',
    });

    const vsFs = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: vsFs, buffer: { type: 'uniform', minBindingSize: LIGHT_UNIFORM_SIZE } },
        { binding: 1, visibility: vsFs, buffer: { type: 'read-only-storage' } },  // transforms
        // The light list, read by vs_main only. 4 bytes: one u32, the least an array<u32> binds.
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage', minBindingSize: 4 } },
        { binding: 3, visibility: vsFs, buffer: { type: 'read-only-storage' } },  // primParams
        { binding: 4, visibility: vsFs, buffer: { type: 'read-only-storage' } },  // renderMeta
        { binding: 5, visibility: vsFs, texture: { sampleType: 'unfilterable-float' } }, // signed SDF (vs_main reads its size: directionalRay)
      ],
    });

    const module = device.createShaderModule({ code: LightAccumStage.SHADER_SOURCE });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: SCENE_HDR_FORMAT, blend: LIGHT_BLEND }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  /**
   * One uniform slice per group and the frame's light list, each written in
   * one call. Both buffers grow, never shrink, and a growth drops the cached
   * bind groups. `lightOrder`: `LightGroups.lightOrder`, slots in draw order.
   */
  prepare(device: GPUDevice, frame: FrameState, groups: readonly LightGroup[], lightOrder: Uint32Array<ArrayBuffer>): void {
    if (!this.pipeline) return;
    const count = Math.max(1, groups.length);
    if (!this.uniformBuffer || count > this.slices) {
      this.uniformBuffer?.destroy();
      this.uniformBuffer = device.createBuffer({ size: count * SLICE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.slices = count;
      this.bindGroups.clear();
    }
    // LightingQuality.shadowSteps is finite and >= 1 (setQuality): written as
    // a whole number, capped so that the sun's 4x cannot wrap.
    const steps = Math.min(Math.trunc(frame.shadowSteps ?? DEFAULT_LIGHTING_QUALITY.shadowSteps), MAX_SHADOW_STEPS);
    const data = new ArrayBuffer(count * SLICE);
    for (let g = 0; g < count; g++) {
      const base = g * SLICE;
      new Float32Array(data, base, 16).set(frame.cameraViewProjection);
      new Uint32Array(data, base + 64, 1)[0] = steps;
      new Float32Array(data, base + 68, 1)[0] = SHADOW_HARDNESS;
      new Float32Array(data, base + 72, 1)[0] = LIGHT_SOURCE_FRACTION;
      new Uint32Array(data, base + 76, 1)[0] = groups[g]?.layers ?? 0;
    }
    device.queue.writeBuffer(this.uniformBuffer, 0, data);

    this.lightCount = lightOrder.length;
    if (!this.orderBuffer || lightOrder.length > this.orderCapacity) {
      let capacity = Math.max(this.orderCapacity, MIN_LIGHT_ORDER_CAPACITY);
      while (capacity < lightOrder.length) capacity *= 2;
      this.orderBuffer?.destroy();
      this.orderBuffer = device.createBuffer({
        size: capacity * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: 'light-order',
      });
      this.orderCapacity = capacity;
      this.bindGroups.clear();
    }
    if (lightOrder.length > 0) device.queue.writeBuffer(this.orderBuffer, 0, lightOrder);
  }

  /** Clear `target` to the ambient light, then draw the frame's light list into group `g`, shadowed by `sdf`. */
  encode(encoder: GPUCommandEncoder, g: number, target: GPUTextureView, sdf: GPUTextureView, frame: FrameState): void {
    if (!this.pipeline || !this.vertexBuffer || !this.indexBuffer) return;
    const bindGroup = this.bindGroupFor(g, sdf);
    if (!bindGroup) return;
    const [r, gr, b, intensity] = frame.ambient ?? [0, 0, 0, 1];
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: r * intensity, g: gr * intensity, b: b * intensity, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint16');
    pass.setBindGroup(0, bindGroup);
    // Instance i is the list's i-th light, firstInstance 0 (no
    // indirect-first-instance). WebGPU blends in primitive order: the list's
    // order is the blend order.
    if (this.lightCount > 0) pass.drawIndexed(6, this.lightCount, 0, 0, 0);
    pass.end();
  }

  private bindGroupFor(g: number, sdf: GPUTextureView): GPUBindGroup | null {
    if (!this.device || !this.bindGroupLayout || !this.uniformBuffer || !this.orderBuffer || g >= this.slices) return null;
    const cached = this.bindGroups.get(g);
    if (cached && cached.sdf === sdf) return cached.group;
    const group = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, offset: g * SLICE, size: LIGHT_UNIFORM_SIZE } },
        ...this.columns.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
        { binding: 2, resource: { buffer: this.orderBuffer } },
        { binding: 5, resource: sdf },
      ],
    });
    this.bindGroups.set(g, { group, sdf });
    return group;
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.orderBuffer?.destroy();
    this.uniformBuffer = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.orderBuffer = null;
    this.orderCapacity = 0;
    this.lightCount = 0;
    this.slices = 0;
    this.bindGroups.clear();
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.columns = [];
    this.device = null;
  }
}
