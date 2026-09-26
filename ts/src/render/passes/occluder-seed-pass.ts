import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import { JFA_FORMAT } from '../formats';
import {
  PRIMITIVE_GROUP0_BUFFERS, TextureTierBinding, primitiveGroup0LayoutEntries, textureTierLayoutEntries,
} from '../primitive-bindings';
import { BUCKETS_PER_TYPE } from './cull-pass';

/**
 * Size of the lighting targets (occluder seed, signed-SDF chain): half the
 * canvas, rounded down, at least 1×1. One function, because the SDF chain
 * steps in texels of the seed texture and the two must agree to the texel.
 */
export function halfResolution(canvasWidth: number, canvasHeight: number): [number, number] {
  return [Math.max(1, Math.floor(canvasWidth / 2)), Math.max(1, Math.floor(canvasHeight / 2))];
}

/** The fragment entry point a primitive shader exposes to cast shadows. */
const OCCLUDER_ENTRY = 'fs_occluder';

/**
 * Rasterises every shadow-casting entity into `occluder-seed`, the texture the
 * signed-SDF chain floods (Phase 17, Track B).
 *
 * The pass does not use a shader of its own. It runs each primitive's OWN WGSL
 * module a second time, through the `fs_occluder` entry point, which reuses the
 * primitive's coverage. A sprite casts the shadow of the texels it draws, and a
 * bezier the shadow of its curve, rather than of its bounding quad (design
 * §6.2). The pipeline sets `OCCLUDER_PASS = true`, and the module's vertex
 * stage then emits a degenerate triangle for every entity without the
 * castsShadow bit. A primitive whose shader has no `fs_occluder` yet casts
 * nothing.
 *
 * Only the opaque buckets are drawn. The target is half the canvas resolution
 * in `JFA_FORMAT` and has no oversize (design §6.2: 120% costs +96% pixels).
 * Each pixel holds (u, v, valid, inside) = (screen u, screen v, 1, 1) under an
 * occluder, and (0, 0, 0, 0) elsewhere.
 *
 * Reads the same columns as ForwardPass. Optional: dead-pass culling removes it
 * whenever nothing reads `occluder-seed`, i.e. while lighting is off.
 */
export class OccluderSeedPass implements RenderPass {
  readonly name = 'occluder-seed';
  readonly reads = ['visible-indices', 'entity-transforms', 'indirect-args', 'render-meta', 'tex-indices', 'prim-params'];
  readonly writes = ['occluder-seed'];
  readonly optional = true;

  /** Primitive type → occluder pipeline, for the types whose shader has `fs_occluder`. */
  private pipelines = new Map<number, GPURenderPipeline>();
  private bindGroup0: GPUBindGroup | null = null;
  private tierBinding: TextureTierBinding | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private cameraBuffer: GPUBuffer | null = null;
  private indirectBuffer: GPUBuffer | null = null;
  private target: GPUTexture | null = null;
  private targetWidth = 0;
  private targetHeight = 0;
  private device: GPUDevice | null = null;

  /**
   * @param shaderSources primitive type → WGSL module, the same map ForwardPass
   *   uses (`ForwardPass.SHADER_SOURCES`).
   */
  constructor(private readonly shaderSources: Record<number, string>) {}

  setup(device: GPUDevice, resources: ResourcePool): void {
    this.device = device;

    const vertices = new Float32Array([-0.5, -0.5, 0.0, 0.5, -0.5, 0.0, 0.5, 0.5, 0.0, -0.5, 0.5, 0.0]);
    this.vertexBuffer = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertexBuffer, 0, vertices);
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
    this.indexBuffer = device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.indexBuffer, 0, indices);
    this.cameraBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const buffers = PRIMITIVE_GROUP0_BUFFERS.map((name) => {
      const buffer = resources.getBuffer(name);
      if (!buffer) throw new Error(`OccluderSeedPass.setup: missing '${name}' in ResourcePool`);
      return buffer;
    });
    this.indirectBuffer = resources.getBuffer('indirect-args') ?? null;

    const layout0 = device.createBindGroupLayout({ entries: primitiveGroup0LayoutEntries() });
    const layout1 = device.createBindGroupLayout({ entries: textureTierLayoutEntries() });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout0, layout1] });

    for (const [type, code] of Object.entries(this.shaderSources)) {
      if (!code.includes(`fn ${OCCLUDER_ENTRY}`)) continue;
      const module = device.createShaderModule({ code });
      this.pipelines.set(Number(type), device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
          module,
          entryPoint: 'vs_main',
          constants: { OCCLUDER_PASS: 1 },
          buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
        },
        fragment: { module, entryPoint: OCCLUDER_ENTRY, targets: [{ format: JFA_FORMAT }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
      }));
    }

    this.bindGroup0 = device.createBindGroup({
      layout: layout0,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        ...buffers.map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
      ],
    });
    this.tierBinding = new TextureTierBinding(layout1);
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.cameraBuffer) return;
    device.queue.writeBuffer(this.cameraBuffer, 0, frame.cameraViewProjection as Float32Array<ArrayBuffer>);
  }

  execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool): void {
    if (!this.device || !this.vertexBuffer || !this.indexBuffer || !this.bindGroup0 || !this.indirectBuffer) return;
    const bindGroup1 = this.tierBinding?.current(this.device, resources);
    if (!bindGroup1) return;
    this.ensureTarget(frame.canvasWidth, frame.canvasHeight, resources);
    const view = resources.getTextureView('occluder-seed');
    if (!view) return;

    // Cleared even when no primitive can occlude: a reader must see "no
    // occluders", not whatever the texture held before.
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    for (const [type, pipeline] of this.pipelines) {
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, this.vertexBuffer);
      pass.setIndexBuffer(this.indexBuffer, 'uint16');
      pass.setBindGroup(0, this.bindGroup0);
      pass.setBindGroup(1, bindGroup1);
      for (let bucket = 0; bucket < BUCKETS_PER_TYPE; bucket++) {
        pass.drawIndexedIndirect(this.indirectBuffer, (type * BUCKETS_PER_TYPE + bucket) * 20);
      }
    }
    pass.end();
  }

  /** `halfResolution` of the canvas. Registered in the pool as `occluder-seed`. */
  private ensureTarget(canvasWidth: number, canvasHeight: number, resources: ResourcePool): void {
    const [width, height] = halfResolution(canvasWidth, canvasHeight);
    if (this.target && width === this.targetWidth && height === this.targetHeight) return;
    this.target?.destroy();
    if (!this.device) return;
    this.target = this.device.createTexture({
      size: { width, height },
      format: JFA_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    resources.setTextureView('occluder-seed', this.target.createView());
    this.targetWidth = width;
    this.targetHeight = height;
  }

  resize(_width: number, _height: number): void {
    // The target follows the canvas size seen in execute().
  }

  destroy(): void {
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.cameraBuffer?.destroy();
    this.target?.destroy();
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.cameraBuffer = null;
    this.target = null;
    this.targetWidth = 0;
    this.targetHeight = 0;
    this.pipelines.clear();
    this.bindGroup0 = null;
    this.tierBinding = null;
    this.indirectBuffer = null;
    this.device = null;
  }
}
