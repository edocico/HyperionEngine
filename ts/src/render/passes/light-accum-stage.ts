import type { FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import type { LightGroup } from '../light-groups';
import { SCENE_HDR_FORMAT } from '../formats';
import { BUCKETS_PER_TYPE } from './cull-pass';
import { DEFAULT_LIGHTING_QUALITY } from '../../lighting-api';

/** RenderPrimitive 6. */
const LIGHT2D_PRIM_TYPE = 6;

/** The indirect-args slots CullPass fills with visible lights: both material buckets of type 6. */
export const LIGHT2D_ARG_SLOTS = Array.from({ length: BUCKETS_PER_TYPE }, (_, b) => LIGHT2D_PRIM_TYPE * BUCKETS_PER_TYPE + b);

/**
 * Soft-shadow hardness k: the light's apparent angle is at most 1/k. With h
 * and t in texels of the half-resolution SDF, 8 gives a visible, not blurry,
 * penumbra.
 */
export const SHADOW_HARDNESS = 8;

/**
 * A light's source radius as a fraction of its range. The shader caps the
 * light's apparent angle at min(1/k, sourceRadius / distance): without the
 * cap the light's radius grows with the pixel's distance (D/k), and a light
 * beside a wall darkens the pixels on the far side of it too. 0.02 keeps a
 * light that is range/50 or more away from a wall unoccluded on the open side.
 */
export const LIGHT_SOURCE_FRACTION = 0.02;

/** Uniform slices are 256 bytes apart: the WebGPU minimum uniform-buffer offset alignment. */
export const SLICE = 256;

/** LightUniform: viewProjection (64) + shadowSteps, hardness, sourceFraction, groupLayers (16). */
const LIGHT_UNIFORM_SIZE = 80;

/**
 * Accumulates the visible Light2Ds of ONE light group into one layer of the
 * light buffer (Phase 17; light layers, design 2026-09-26). A stage of
 * LightGroupsPass, not a graph node.
 *
 * The target is `halfResolution`, the same texels as the signed SDF, in
 * `SCENE_HDR_FORMAT` with an additive blend, cleared to the ambient light. The
 * lights are one instanced indirect draw per Light2D bucket (CullPass wrote
 * the counts); the vertex stage drops every light whose mask misses the
 * group's layers. A point or spot light is a quad of its range; a global or
 * directional light covers the screen. See light-accum.wgsl for the falloff,
 * the spot cone and the shadow march.
 *
 * Every group has its own 256-byte uniform slice, all written once in
 * `prepare()`: a writeBuffer between the render passes of one frame would land
 * only with its last write, and every group would read it.
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
  private indirectBuffer: GPUBuffer | null = null;
  private columns: GPUBuffer[] = [];
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

    this.columns = ['entity-transforms', 'visible-indices', 'prim-params', 'render-meta'].map((name) => {
      const buffer = resources.getBuffer(name);
      if (!buffer) throw new Error(`LightAccumStage.setup: missing '${name}' in ResourcePool`);
      return buffer;
    });
    this.indirectBuffer = resources.getBuffer('indirect-args') ?? null;

    const vsFs = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: vsFs, buffer: { type: 'uniform', minBindingSize: LIGHT_UNIFORM_SIZE } },
        { binding: 1, visibility: vsFs, buffer: { type: 'read-only-storage' } },  // transforms
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }, // visibleIndices
        { binding: 3, visibility: vsFs, buffer: { type: 'read-only-storage' } },  // primParams
        { binding: 4, visibility: vsFs, buffer: { type: 'read-only-storage' } },  // renderMeta
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }, // signed SDF
      ],
    });

    const module = device.createShaderModule({ code: LightAccumStage.SHADER_SOURCE });
    const add: GPUBlendComponent = { operation: 'add', srcFactor: 'one', dstFactor: 'one' };
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: SCENE_HDR_FORMAT, blend: { color: add, alpha: add } }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  /** One slice per group, written in one call. Grow-only. */
  prepare(device: GPUDevice, frame: FrameState, groups: readonly LightGroup[]): void {
    if (!this.pipeline) return;
    const count = Math.max(1, groups.length);
    if (!this.uniformBuffer || count > this.slices) {
      this.uniformBuffer?.destroy();
      this.uniformBuffer = device.createBuffer({ size: count * SLICE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.slices = count;
      this.bindGroups.clear();
    }
    const data = new ArrayBuffer(count * SLICE);
    for (let g = 0; g < count; g++) {
      const base = g * SLICE;
      new Float32Array(data, base, 16).set(frame.cameraViewProjection);
      new Uint32Array(data, base + 64, 1)[0] = frame.shadowSteps ?? DEFAULT_LIGHTING_QUALITY.shadowSteps;
      new Float32Array(data, base + 68, 1)[0] = SHADOW_HARDNESS;
      new Float32Array(data, base + 72, 1)[0] = LIGHT_SOURCE_FRACTION;
      new Uint32Array(data, base + 76, 1)[0] = groups[g]?.layers ?? 0;
    }
    device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  /** Clear `target` to the ambient light, then add every light of group `g`, shadowed by `sdf`. */
  encode(encoder: GPUCommandEncoder, g: number, target: GPUTextureView, sdf: GPUTextureView, frame: FrameState): void {
    if (!this.pipeline || !this.vertexBuffer || !this.indexBuffer || !this.indirectBuffer) return;
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
    for (const slot of LIGHT2D_ARG_SLOTS) pass.drawIndexedIndirect(this.indirectBuffer, slot * 20);
    pass.end();
  }

  private bindGroupFor(g: number, sdf: GPUTextureView): GPUBindGroup | null {
    if (!this.device || !this.bindGroupLayout || !this.uniformBuffer || g >= this.slices) return null;
    const cached = this.bindGroups.get(g);
    if (cached && cached.sdf === sdf) return cached.group;
    const group = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, offset: g * SLICE, size: LIGHT_UNIFORM_SIZE } },
        ...this.columns.map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
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
    this.uniformBuffer = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.slices = 0;
    this.bindGroups.clear();
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.columns = [];
    this.indirectBuffer = null;
    this.device = null;
  }
}
