import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import type { LightGroups } from '../light-groups';
import { JFA_FORMAT, SCENE_HDR_FORMAT } from '../formats';
import { OccluderSeedStage, halfResolution } from './occluder-seed-stage';
import { SdfChainStage } from './sdf-chain-stage';
import { LightAccumStage } from './light-accum-stage';

/**
 * The lit backend's frame when nothing supplied `FrameState.lightGroups`: one
 * group of every layer, shadowed by one set of every caster. That is exactly
 * the single-buffer lighting that existed before light layers.
 */
const EVERYTHING: LightGroups = {
  groups: [{ layers: 0xffff, sdfSet: 0 }],
  sdfSets: [{ occluderLayers: 0xffff }],
  layerToGroup: [0, 0],
  multiBitReceiver: false,
  lightMasks: [],
  occluderMasks: [],
};

/**
 * The lit backend in one graph node (Phase 17; light layers, design
 * 2026-09-26). Writes `light-buffer`: a half-resolution rgba16float 2d-array
 * with one layer per light group, which ForwardPass samples at the receiver's
 * group.
 *
 * Each frame runs SET-MAJOR, over the groups `deriveLightGroups` made:
 *
 *     for each SDF set s:  seed its occluders → flood the SDF → accumulate
 *                          every group of s into its own layer
 *     then:                the groups no shadowed light reaches, against a
 *                          1×1 "no occluder" SDF
 *
 * One seed texture and one ping-pong pair serve every set, so the SDF memory is
 * constant whatever the number of sets (there is no cap on them). The chain
 * length follows the target size every frame, and the group and set counts can
 * change every frame: neither needs a new graph. The light buffer grows with
 * the group count and never shrinks.
 *
 * The three stages are OccluderSeedStage, SdfChainStage and LightAccumStage.
 * For the GPU profiler the node names them per frame (`profileStages`) and
 * marks each one, so their times stay visible as `light-groups/seed|sdf|accum`.
 */
export class LightGroupsPass implements RenderPass {
  readonly name = 'light-groups';
  readonly reads = ['visible-indices', 'entity-transforms', 'indirect-args', 'render-meta', 'tex-indices', 'prim-params'];
  readonly writes = ['light-buffer'];
  readonly optional = true;

  private readonly seed: OccluderSeedStage;
  private readonly chain = new SdfChainStage();
  private readonly accum = new LightAccumStage();

  private seedTex: GPUTexture | null = null;
  private sdfA: GPUTexture | null = null;
  private sdfB: GPUTexture | null = null;
  private seedView: GPUTextureView | null = null;
  private aView: GPUTextureView | null = null;
  private bView: GPUTextureView | null = null;
  private lightBuffer: GPUTexture | null = null;
  private layerViews: GPUTextureView[] = [];
  private noOccluder: GPUTexture | null = null;
  private noOccluderView: GPUTextureView | null = null;
  private width = 0;
  private height = 0;
  private layers = 0;
  private device: GPUDevice | null = null;

  /** @param shaderSources the primitive shaders (`ForwardPass.SHADER_SOURCES`), for the occluder pipelines. */
  constructor(shaderSources: Record<number, string>) {
    this.seed = new OccluderSeedStage(shaderSources);
  }

  setup(device: GPUDevice, resources: ResourcePool): void {
    this.device = device;
    this.seed.setup(device, resources);
    this.chain.setup(device, resources);
    this.accum.setup(device, resources);
    // New textures are zero-initialised: (0, 0, 0, 0) is "no occluder anywhere".
    this.noOccluder = device.createTexture({
      size: { width: 1, height: 1 },
      format: JFA_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING,
      label: 'light-no-occluder',
    });
    this.noOccluderView = this.noOccluder.createView();
  }

  profileStages(frame: FrameState): readonly string[] {
    const lg = frame.lightGroups ?? EVERYTHING;
    const stages: string[] = [];
    for (let s = 0; s < lg.sdfSets.length; s++) stages.push('seed', 'sdf', 'accum');
    if (lg.groups.some((g) => g.sdfSet < 0)) stages.push('accum');
    return stages;
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    const lg = frame.lightGroups ?? EVERYTHING;
    const [width, height] = halfResolution(frame.canvasWidth, frame.canvasHeight);
    this.seed.prepare(device, frame, lg.sdfSets);
    this.chain.prepare(device, width, height);
    this.accum.prepare(device, frame, lg.groups);
  }

  execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool, mark?: (encoder: GPUCommandEncoder) => void): void {
    const lg = frame.lightGroups ?? EVERYTHING;
    this.ensureTargets(frame, resources, lg.groups.length);
    if (!this.seedView || !this.aView || !this.bView || !this.noOccluderView) return;

    for (let s = 0; s < lg.sdfSets.length; s++) {
      mark?.(encoder);
      this.seed.encode(encoder, s, this.seedView, resources);
      mark?.(encoder);
      const sdf = this.chain.encode(encoder, this.seedView, this.aView, this.bView);
      mark?.(encoder);
      // Before the next set's seed overwrites the shared textures.
      lg.groups.forEach((group, g) => {
        if (group.sdfSet === s) this.accum.encode(encoder, g, this.layerViews[g], sdf, frame);
      });
    }
    if (lg.groups.some((group) => group.sdfSet < 0)) {
      mark?.(encoder);
      lg.groups.forEach((group, g) => {
        if (group.sdfSet < 0) this.accum.encode(encoder, g, this.layerViews[g], this.noOccluderView!, frame);
      });
    }
  }

  /** Seed and ping-pong at `halfResolution`, the light buffer with at least `groups` layers (grow-only). */
  private ensureTargets(frame: FrameState, resources: ResourcePool, groups: number): void {
    if (!this.device) return;
    const [width, height] = halfResolution(frame.canvasWidth, frame.canvasHeight);
    const resized = width !== this.width || height !== this.height;
    if (resized || !this.seedTex) {
      for (const t of [this.seedTex, this.sdfA, this.sdfB]) t?.destroy();
      const make = (label: string) => this.device!.createTexture({
        size: { width, height },
        format: JFA_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        label,
      });
      this.seedTex = make('light-seed');
      this.sdfA = make('light-sdf-a');
      this.sdfB = make('light-sdf-b');
      this.seedView = this.seedTex.createView();
      this.aView = this.sdfA.createView();
      this.bView = this.sdfB.createView();
    }
    const layers = Math.max(1, groups);
    if (resized || !this.lightBuffer || layers > this.layers) {
      this.lightBuffer?.destroy();
      const count = Math.max(layers, resized ? 0 : this.layers);
      this.lightBuffer = this.device.createTexture({
        size: { width, height, depthOrArrayLayers: count },
        format: SCENE_HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        textureBindingViewDimension: '2d-array',
        label: 'light-buffer',
      });
      this.layerViews = Array.from({ length: count }, (_, g) =>
        this.lightBuffer!.createView({ dimension: '2d', baseArrayLayer: g, arrayLayerCount: 1 }));
      resources.setTextureView('light-buffer', this.lightBuffer.createView({ dimension: '2d-array' }));
      this.layers = count;
    }
    this.width = width;
    this.height = height;
  }

  resize(_width: number, _height: number): void {
    // The targets follow the canvas size seen in execute().
  }

  destroy(): void {
    this.seed.destroy();
    this.chain.destroy();
    this.accum.destroy();
    for (const t of [this.seedTex, this.sdfA, this.sdfB, this.lightBuffer, this.noOccluder]) t?.destroy();
    this.seedTex = this.sdfA = this.sdfB = this.lightBuffer = this.noOccluder = null;
    this.seedView = this.aView = this.bView = this.noOccluderView = null;
    this.layerViews = [];
    this.width = this.height = this.layers = 0;
    this.device = null;
  }
}
