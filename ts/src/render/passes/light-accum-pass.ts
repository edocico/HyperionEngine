import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import { SCENE_HDR_FORMAT } from '../formats';
import { BUCKETS_PER_TYPE } from './cull-pass';
import { halfResolution } from './occluder-seed-pass';

/** RenderPrimitive 6. */
const LIGHT2D_PRIM_TYPE = 6;

/** The indirect-args slots CullPass fills with visible lights: both material buckets of type 6. */
export const LIGHT2D_ARG_SLOTS = Array.from({ length: BUCKETS_PER_TYPE }, (_, b) => LIGHT2D_PRIM_TYPE * BUCKETS_PER_TYPE + b);

/** Default sphere-march steps, `DEFAULT_LIGHTING_QUALITY.shadowSteps`. */
const DEFAULT_SHADOW_STEPS = 24;

/**
 * Soft-shadow hardness k in Quilez's `res = min(res, k * h / t)`: how fast a
 * penumbra closes. With h and t in texels of the half-resolution SDF, 8 gives
 * a visible, not blurry, penumbra.
 */
const SHADOW_HARDNESS = 8;

/**
 * A light's source radius as a fraction of its range. The shader caps the
 * light's apparent angle at min(1/k, sourceRadius / distance): without the
 * cap the light's radius grows with the pixel's distance (D/k), and a light
 * beside a wall darkens the pixels on the far side of it too. 0.02 keeps a
 * light that is range/50 or more away from a wall unoccluded on the open side.
 */
export const LIGHT_SOURCE_FRACTION = 0.02;

/**
 * Accumulates every visible Light2D into `light-buffer` (Phase 17, Task 9).
 *
 * The target is `halfResolution`, the same texels as the signed SDF, so a
 * light pixel and its SDF texel coincide. It is `SCENE_HDR_FORMAT` with an
 * additive blend, and is cleared to the ambient light, which costs nothing
 * (Unity does the same).
 *
 * The lights are drawn in one instanced indirect draw per Light2D bucket. The
 * `instanceCount` comes from CullPass, which culls each light by its range.
 * A point or spot light is a quad covering its range; a global or directional
 * light covers the screen. The fragment applies (1 - d/range)^falloff, the
 * spot cone, and, when `shadowIntensity > 0`, a sphere march on the SDF toward
 * the light (light-accum.wgsl).
 *
 * Reads `sdfResource`, the last texture of the SdfJfaPass chain. Optional:
 * culled while nothing reads `light-buffer`.
 */
export class LightAccumPass implements RenderPass {
  /** WGSL shader source (`light-accum.wgsl`). Set before calling `setup()`. */
  static SHADER_SOURCE = '';

  readonly name = 'light-accum';
  readonly reads: string[];
  readonly writes = ['light-buffer'];
  readonly optional = true;

  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private boundSdf: GPUTextureView | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private indirectBuffer: GPUBuffer | null = null;
  private columns: GPUBuffer[] = [];
  private target: GPUTexture | null = null;
  private targetWidth = 0;
  private targetHeight = 0;
  private device: GPUDevice | null = null;

  /** @param sdfResource the signed-SDF texture to march, `SdfJfaPass.finalOutputResource(...)`. */
  constructor(private readonly sdfResource: string) {
    this.reads = ['visible-indices', 'entity-transforms', 'indirect-args', 'prim-params', 'render-meta', sdfResource];
  }

  setup(device: GPUDevice, resources: ResourcePool): void {
    if (!LightAccumPass.SHADER_SOURCE) {
      throw new Error('LightAccumPass.SHADER_SOURCE must be set before setup()');
    }
    this.device = device;

    const vertices = new Float32Array([-0.5, -0.5, 0.0, 0.5, -0.5, 0.0, 0.5, 0.5, 0.0, -0.5, 0.5, 0.0]);
    this.vertexBuffer = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertexBuffer, 0, vertices);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    this.indexBuffer = device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.indexBuffer, 0, indices);
    // LightUniform: viewProjection (64) + shadowSteps, hardness, sourceFraction, pad (16) = 80 bytes.
    this.uniformBuffer = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.columns = ['entity-transforms', 'visible-indices', 'prim-params', 'render-meta'].map((name) => {
      const buffer = resources.getBuffer(name);
      if (!buffer) throw new Error(`LightAccumPass.setup: missing '${name}' in ResourcePool`);
      return buffer;
    });
    this.indirectBuffer = resources.getBuffer('indirect-args') ?? null;

    const vsFs = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: vsFs, buffer: { type: 'uniform' } },
        { binding: 1, visibility: vsFs, buffer: { type: 'read-only-storage' } },  // transforms
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }, // visibleIndices
        { binding: 3, visibility: vsFs, buffer: { type: 'read-only-storage' } },  // primParams
        { binding: 4, visibility: vsFs, buffer: { type: 'read-only-storage' } },  // renderMeta
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }, // signed SDF
      ],
    });

    const module = device.createShaderModule({ code: LightAccumPass.SHADER_SOURCE });
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

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.uniformBuffer) return;
    const data = new ArrayBuffer(80);
    new Float32Array(data, 0, 16).set(frame.cameraViewProjection);
    new Uint32Array(data, 64, 1)[0] = frame.shadowSteps ?? DEFAULT_SHADOW_STEPS;
    new Float32Array(data, 68, 1)[0] = SHADOW_HARDNESS;
    new Float32Array(data, 72, 1)[0] = LIGHT_SOURCE_FRACTION;
    device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool): void {
    if (!this.device || !this.pipeline || !this.vertexBuffer || !this.indexBuffer || !this.indirectBuffer) return;
    const sdf = resources.getTextureView(this.sdfResource);
    if (!sdf || !this.bindGroupLayout || !this.uniformBuffer) return;
    if (!this.bindGroup || sdf !== this.boundSdf) {
      // The SDF view changes when the chain's textures are recreated on resize.
      this.bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          ...this.columns.map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
          { binding: 5, resource: sdf },
        ],
      });
      this.boundSdf = sdf;
    }
    this.ensureTarget(frame.canvasWidth, frame.canvasHeight, resources);
    const view = resources.getTextureView('light-buffer');
    if (!view) return;

    const [r, g, b, intensity] = frame.ambient ?? [0, 0, 0, 1];
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: r * intensity, g: g * intensity, b: b * intensity, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint16');
    pass.setBindGroup(0, this.bindGroup);
    for (const slot of LIGHT2D_ARG_SLOTS) pass.drawIndexedIndirect(this.indirectBuffer, slot * 20);
    pass.end();
  }

  private ensureTarget(canvasWidth: number, canvasHeight: number, resources: ResourcePool): void {
    const [width, height] = halfResolution(canvasWidth, canvasHeight);
    if (this.target && width === this.targetWidth && height === this.targetHeight) return;
    this.target?.destroy();
    if (!this.device) return;
    this.target = this.device.createTexture({
      size: { width, height },
      format: SCENE_HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    resources.setTextureView('light-buffer', this.target.createView());
    this.targetWidth = width;
    this.targetHeight = height;
  }

  resize(_width: number, _height: number): void {
    // The target follows the canvas size seen in execute().
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.target?.destroy();
    this.uniformBuffer = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.target = null;
    this.targetWidth = 0;
    this.targetHeight = 0;
    this.pipeline = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.boundSdf = null;
    this.columns = [];
    this.indirectBuffer = null;
    this.device = null;
  }
}
