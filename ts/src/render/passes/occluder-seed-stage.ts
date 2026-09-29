import type { FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import { JFA_FORMAT } from '../formats';
import {
  PRIMITIVE_GROUP0_BUFFERS, TextureTierBinding, primitiveGroup0LayoutEntries, textureTierLayoutEntries,
} from '../primitive-bindings';
import { BUCKETS_PER_TYPE, TRANSPARENT_BUCKET_OFFSET } from './cull-pass';
import { SLICE } from './light-accum-stage';

/**
 * Size of the lighting targets (occluder seed, signed SDF, light buffer): half
 * the canvas, rounded down, at least 1×1. One function, because the SDF chain
 * steps in texels of the seed and the light buffer reads the SDF texel for
 * texel.
 */
export function halfResolution(canvasWidth: number, canvasHeight: number): [number, number] {
  return [Math.max(1, Math.floor(canvasWidth / 2)), Math.max(1, Math.floor(canvasHeight / 2))];
}

/** The fragment entry point a primitive shader exposes to cast shadows. */
const OCCLUDER_ENTRY = 'fs_occluder';

/** CameraUniform (the prelude of every composed primitive module): viewProjection + occluderLayers + viewport size + pad. */
const CAMERA_UNIFORM_SIZE = 80;

/**
 * Rasterises the occluders of ONE SDF set into a seed texture (light layers,
 * design 2026-09-26). A stage of LightGroupsPass, not a graph node.
 *
 * It does not use a shader of its own. It runs each primitive's OWN composed
 * module (render/primitive-shaders.ts: prelude + library + wrappers) through
 * `fs_occluder`, which reuses the library's coverage: a sprite casts the
 * shadow of the texels it draws, a bezier of its curve. The pipelines set
 * `OCCLUDER_PASS = true`; the generated `vs_main` then drops every entity that
 * casts no shadow or whose mask misses the set's layers (`castsInto`, in the
 * prelude). A module with no `fs_occluder` (the uber) casts nothing and is never given here.
 *
 * The set's layers ride in the camera uniform: one 256-byte slice per set, all
 * written once in `prepare()`. Opaque and transparent buckets alike. The target is cleared to
 * (0, 0, 0, 0) — "no occluder" — and gets (u, v, 1, 1) under an occluder.
 */
export class OccluderSeedStage {
  /** Primitive type → occluder pipeline, for the types whose shader has `fs_occluder`. */
  private readonly pipelines = new Map<number, GPURenderPipeline>();
  private layout0: GPUBindGroupLayout | null = null;
  private tierBinding: TextureTierBinding | null = null;
  private columns: GPUBuffer[] = [];
  private cameraBuffer: GPUBuffer | null = null;
  private slices = 0;
  private readonly bindGroups = new Map<number, GPUBindGroup>();
  private vertexBuffer: GPUBuffer | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private indirectBuffer: GPUBuffer | null = null;
  private device: GPUDevice | null = null;

  /**
   * @param shaderSources primitive type → composed WGSL module, the same map
   *   ForwardPass uses (`ForwardPass.SHADER_SOURCES`, recomposed in place on a
   *   hot-reload), read at `setup()`.
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

    this.columns = PRIMITIVE_GROUP0_BUFFERS.map((name) => {
      const buffer = resources.getBuffer(name);
      if (!buffer) throw new Error(`OccluderSeedStage.setup: missing '${name}' in ResourcePool`);
      return buffer;
    });
    this.indirectBuffer = resources.getBuffer('indirect-args') ?? null;

    this.layout0 = device.createBindGroupLayout({ entries: primitiveGroup0LayoutEntries() });
    const layout1 = device.createBindGroupLayout({ entries: textureTierLayoutEntries() });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout0, layout1] });

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
    this.tierBinding = new TextureTierBinding(layout1);
  }

  /** One camera slice per set, written in one call. Grow-only. */
  prepare(device: GPUDevice, frame: FrameState, sets: ReadonlyArray<{ occluderLayers: number }>): void {
    if (!this.layout0) return;
    const count = Math.max(1, sets.length);
    if (!this.cameraBuffer || count > this.slices) {
      this.cameraBuffer?.destroy();
      this.cameraBuffer = device.createBuffer({ size: count * SLICE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.slices = count;
      this.bindGroups.clear();
    }
    const data = new ArrayBuffer(count * SLICE);
    for (let s = 0; s < count; s++) {
      new Float32Array(data, s * SLICE, 16).set(frame.cameraViewProjection);
      new Uint32Array(data, s * SLICE + 64, 1)[0] = sets[s]?.occluderLayers ?? 0;
      // The FULL canvas size, not this stage's half-resolution target: a
      // pixel-wide line (line_vs) keeps the NDC footprint it is drawn with.
      new Float32Array(data, s * SLICE + 68, 2).set([frame.canvasWidth, frame.canvasHeight]);
    }
    device.queue.writeBuffer(this.cameraBuffer, 0, data);
  }

  /** Clear `target` to "no occluder", then rasterise the occluders of set `s` into it. */
  encode(encoder: GPUCommandEncoder, s: number, target: GPUTextureView, resources: ResourcePool): void {
    if (!this.device || !this.vertexBuffer || !this.indexBuffer || !this.indirectBuffer) return;
    const group0 = this.bindGroupFor(s);
    const group1 = this.tierBinding?.current(this.device, resources);
    if (!group0 || !group1) return;

    // Cleared even when no primitive can occlude: a reader must see "no
    // occluders", not whatever the texture held for the previous set.
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
    });
    for (const [type, pipeline] of this.pipelines) {
      pass.setPipeline(pipeline);
      pass.setVertexBuffer(0, this.vertexBuffer);
      pass.setIndexBuffer(this.indexBuffer, 'uint16');
      pass.setBindGroup(0, group0);
      pass.setBindGroup(1, group1);
      // Both blend modes: `.transparent()` is a blending flag, and a caster
      // still casts the coverage fs_occluder keeps (alpha >= 0.5).
      for (const blend of [0, TRANSPARENT_BUCKET_OFFSET]) {
        for (let bucket = 0; bucket < BUCKETS_PER_TYPE; bucket++) {
          pass.drawIndexedIndirect(this.indirectBuffer, (blend + type * BUCKETS_PER_TYPE + bucket) * 20);
        }
      }
    }
    pass.end();
  }

  private bindGroupFor(s: number): GPUBindGroup | null {
    if (!this.device || !this.layout0 || !this.cameraBuffer || s >= this.slices) return null;
    const cached = this.bindGroups.get(s);
    if (cached) return cached;
    const group = this.device.createBindGroup({
      layout: this.layout0,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer, offset: s * SLICE, size: CAMERA_UNIFORM_SIZE } },
        ...this.columns.map((buffer, i) => ({ binding: i + 1, resource: { buffer } })),
      ],
    });
    this.bindGroups.set(s, group);
    return group;
  }

  destroy(): void {
    this.vertexBuffer?.destroy();
    this.indexBuffer?.destroy();
    this.cameraBuffer?.destroy();
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.cameraBuffer = null;
    this.slices = 0;
    this.bindGroups.clear();
    this.pipelines.clear();
    this.layout0 = null;
    this.tierBinding = null;
    this.columns = [];
    this.indirectBuffer = null;
    this.device = null;
  }
}
