import preludeShaderCode from './shaders/primitives/prelude.wgsl?raw';
import quadShaderCode from './shaders/primitives/quad.wgsl?raw';
import lineShaderCode from './shaders/primitives/line.wgsl?raw';
import msdfShaderCode from './shaders/primitives/msdf-text.wgsl?raw';
import bezierShaderCode from './shaders/primitives/bezier.wgsl?raw';
import gradientShaderCode from './shaders/primitives/gradient.wgsl?raw';
import boxShadowShaderCode from './shaders/primitives/box-shadow.wgsl?raw';
import cullShaderCode from './shaders/cull.wgsl?raw';
import fxaaShaderCode from './shaders/fxaa-tonemap.wgsl?raw';
import selectionSeedShaderCode from './shaders/selection-seed.wgsl?raw';
import jfaShaderCode from './shaders/jfa.wgsl?raw';
import debugLineShaderCode from './shaders/debug-line.wgsl?raw';
import outlineCompositeShaderCode from './shaders/outline-composite.wgsl?raw';
import bloomShaderCode from './shaders/bloom.wgsl?raw';
import particleSimulateCode from './shaders/particle-simulate.wgsl?raw';
import particleRenderCode from './shaders/particle-render.wgsl?raw';
import scatterShaderCode from './shaders/scatter.wgsl?raw';
import transparentGatherShaderCode from './shaders/transparent-gather.wgsl?raw';
import transparentSortShaderCode from './shaders/transparent-sort.wgsl?raw';
import sdfJfaShaderCode from './shaders/sdf-jfa.wgsl?raw';
import lightAccumShaderCode from './shaders/light-accum.wgsl?raw';
import { TextureManager } from './texture-manager';
import { RenderGraph } from './render/render-graph';
import { ResourcePool } from './render/resource-pool';
import { CullPass, TOTAL_DRAW_BUCKETS, prepareShaderSource } from './render/passes/cull-pass';
import { ForwardPass } from './render/passes/forward-pass';
import { PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule, type PrimitivePieces } from './render/primitive-shaders';
import { PieceReloadCollector, assertPiecesNotEmpty } from './render/piece-reload-collector';
import { FXAATonemapPass } from './render/passes/fxaa-tonemap-pass';
import { SelectionSeedPass } from './render/passes/selection-seed-pass';
import { JFAPass } from './render/passes/jfa-pass';
import { OutlineCompositePass } from './render/passes/outline-composite-pass';
import { LineBatchPass } from './render/passes/debug-line-pass';
import { BloomPass } from './render/passes/bloom-pass';
import type { BloomConfig } from './render/passes/bloom-pass';
import { ScatterPass } from './render/passes/scatter-pass';
import { TransparentSortPass } from './render/passes/transparent-sort-pass';
import { CAP as SORT_CAPACITY, HEADER_BYTES as SORT_HEADER_BYTES } from './render/passes/transparent-sort-constants';
import { LightGroupsPass } from './render/passes/light-groups-pass';
import { SdfChainStage } from './render/passes/sdf-chain-stage';
import { LightAccumStage } from './render/passes/light-accum-stage';
import { deriveLightGroups } from './render/light-groups';
import { followLightingBackend, unsupportedLightingQuality } from './render/lighting-backend';
import { DEFAULT_LIGHTING_QUALITY, type LightingQuality } from './lighting-api';
import { SelectionManager } from './selection';
import {
  detectCompressedFormat, detectSubgroupSupport, describeAdapter,
  selectDeviceFeatures, retryDeviceFeatures, indirectFirstInstanceWarning, subgroupCullSupported,
} from './capabilities';
import { ParticleSystem, type ParticlePipelines } from './particle-system';
import type { FrameState, RenderPass } from './render/render-pass';
import type { GraphMode, GraphPassFactories } from './render/graph-assembly';
import { RenderGraphHost, createGpuValidation } from './render/graph-host';
import { GraphRequests, type ShaderSlot } from './render/graph-requests';
import type { GPURenderState } from './worker-bridge';
import { SCENE_HDR_FORMAT, JFA_FORMAT } from './render/formats';
import { GpuProfiler, type GpuFrameTiming, type PassTiming } from './render/gpu-profiler';
import { DebugProbe } from './render/debug-probe';
import { TransparentSortProbe } from './render/transparent-sort-probe';
import {
  normalizeTransparentCount, nextFrameStamp, uploadEntityIds, missingSortInputs, overCapacityWarning,
} from './render/frame-inputs';
import { MAX_GPU_ENTITIES } from './types';
import pixelProbeShaderCode from './shaders/pixel-probe.wgsl?raw';

// 28 draw entries (14 opaque + 14 transparent) x 5 u32 x 4 bytes = 560 bytes
const INDIRECT_BUFFER_SIZE = TOTAL_DRAW_BUCKETS * 5 * 4;

/**
 * The primitive shader pieces (design 2026-09-27 §3): the prelude and one
 * library per primitive type, keyed like PRIMITIVE_LIBRARIES. The GPU never
 * compiles a piece alone, only what `publishPrimitiveShaders` composes. The
 * hot-reload slots write into this object.
 */
const primitivePieces: PrimitivePieces = {
  prelude: preludeShaderCode,
  libraries: {
    0: quadShaderCode,          // Quad
    1: lineShaderCode,          // Line
    2: msdfShaderCode,          // SDFGlyph (MSDF text)
    3: bezierShaderCode,        // BezierPath
    4: gradientShaderCode,      // Gradient
    5: boxShadowShaderCode,     // BoxShadow
  },
};

/**
 * Compose the six per-type modules and the uber module from `primitivePieces`.
 * `ForwardPass.SHADER_SOURCES` is updated IN PLACE: LightGroupsPass (the
 * occluder pipelines) and the hot-reload probes hold that object. Pure
 * concatenation: it cannot throw.
 */
function publishPrimitiveShaders(): void {
  Object.assign(ForwardPass.SHADER_SOURCES, composeTypeModules(primitivePieces));
  ForwardPass.UBER_SOURCE = composeUberModule(primitivePieces);
}

export interface OutlineOptions {
  color: [number, number, number, number];
  width: number;
}

export interface Renderer {
  render(
    state: GPURenderState,
    camera: { viewProjection: Float32Array },
    dt?: number,
  ): void;
  readonly textureManager: TextureManager;
  readonly selectionManager: SelectionManager;
  readonly particleSystem: ParticleSystem;
  readonly graph: RenderGraph;
  readonly device: GPUDevice;
  /**
   * Add a pass the caller owns (a plugin overlay). The renderer runs its
   * `setup()` once, carries it over every graph rebuild (outline/bloom
   * toggle, shader hot-reload) and never destroys it.
   *
   * Validated immediately against the graph of EVERY mode (fxaa-tonemap,
   * outlines, bloom): a duplicate name or a second blind writer of a resource
   * in any of them throws here and adds nothing. The pass then joins the
   * graph only once the GPU has validated its `setup()` — a frame or two
   * later; if the GPU reports errors it is never added, and they are logged.
   * Every add runs `setup()`, so re-adding a removed pass without destroying
   * it first allocates twice.
   * To draw on top of the graph's output, declare 'swapchain' in both
   * `reads` and `writes`. GPU particles are composited after the whole
   * graph, so they still draw over overlays.
   */
  addPass(pass: RenderPass): void;
  /**
   * Detach a pass added with {@link addPass}, WITHOUT destroying it — its
   * owner does that. Names of the renderer's own passes are ignored.
   */
  removePass(name: string): void;
  /**
   * Mode switches (and shader hot-reloads) take effect once the GPU has
   * validated the new graph — a frame or two later. Until then the previous
   * graph keeps drawing; `outlinesEnabled` / `bloomEnabled` report the
   * requested mode at once and fall back if the GPU rejects it (the error is
   * logged). A graph that does not compile throws synchronously instead.
   */
  enableOutlines(options: OutlineOptions): void;
  disableOutlines(): void;
  readonly outlinesEnabled: boolean;
  enableBloom(config?: BloomConfig): void;
  disableBloom(): void;
  readonly bloomEnabled: boolean;
  /**
   * Whether the lit graph is requested. It follows the engine's lighting
   * backend (`LightingAPI.setBackend`, read back from `GPURenderState`) and,
   * like bloom, goes live once the GPU has validated it.
   */
  readonly lightingEnabled: boolean;
  /**
   * Lighting quality (`LightingAPI.setQuality`). `shadowSteps` applies from
   * the next frame. `bufferScale` and `sdfOversize` are fixed at their
   * defaults for now; a different value is reported once.
   */
  setLightingQuality(quality: LightingQuality): void;
  /**
   * Hot-reload one shader from new WGSL (dev tool); the GPU validates it
   * before any graph uses it. For the primitives the name is a PIECE —
   * 'prelude', 'quad' (alias 'basic'), 'line', 'msdf-text', 'bezier',
   * 'gradient', 'box-shadow' — and the code is that piece, not a complete
   * module: the six per-type modules and the uber module are recomposed from
   * the pieces. One piece per call, no debounce: an edit spanning two pieces
   * (a prelude rename and its uses) goes live only through the grouped HMR
   * reload, where the pieces are validated together.
   */
  recompileShader(passName: string, shaderCode: string): void;

  /**
   * Whether this device exposes `timestamp-query`. False on drivers that lack
   * it — every profiling call below is then a safe no-op.
   */
  readonly gpuProfilingSupported: boolean;
  /**
   * Start measuring per-pass GPU time. Returns false when unsupported.
   * Read the numbers with {@link getGpuTimings}; quote `averageMs`, not
   * `lastMs`: Chrome quantizes timestamps without --enable-webgpu-developer-features (see render/gpu-profiler.ts).
   */
  enableGpuProfiling(): boolean;
  disableGpuProfiling(): void;
  /**
   * Per-pass (and per-stage) GPU timings over the last 120 resolved frames.
   * Empty when profiling is off or still warming up.
   */
  getGpuTimings(): PassTiming[];
  /**
   * The GPU frame span (first pass beginning to last pass end) over the same
   * frames as getGpuTimings(). Passes can overlap on the GPU, so the entries of
   * getGpuTimings() can add up to more. Null when profiling is off or before
   * the first valid frame.
   */
  getGpuFrameTiming(): GpuFrameTiming | null;
  /**
   * Dev builds only (null otherwise): reads pixels of scene-hdr, the swapchain
   * or a light-buffer layer, and the entity-transforms rows, at the next
   * rendered frame. Behind `engine.debug.probe()` / `readEntityTransforms()`.
   */
  readonly debugProbe: DebugProbe | null;
  /**
   * Dev builds only (null otherwise, like `debugProbe`): the requests of
   * `engine.debug.readTransparentSort()`. It outlives graph swaps; the live
   * TransparentSortPass takes one request per frame.
   */
  readonly sortProbe: TransparentSortProbe | null;

  destroy(): void;
}

export async function createRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  onDeviceLost?: (reason: string) => void,
  scatterThreshold?: number,
): Promise<Renderer> {
  // --- 1. Initialize WebGPU ---
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter");
  const adapterDescription = describeAdapter(adapter.info);
  if (adapterDescription.fallback) console.warn(adapterDescription.message);
  else console.info(adapterDescription.message);

  // Detect compression support from adapter
  const compressedFormat = detectCompressedFormat(adapter.features);

  // Detect subgroup support from adapter
  const subgroupSupport = detectSubgroupSupport(adapter.features);

  const requiredFeatures = selectDeviceFeatures(adapter.features, compressedFormat, subgroupSupport.supported);

  let device: GPUDevice;
  let useSubgroups = subgroupSupport.supported;
  try {
    device = await adapter.requestDevice({
      requiredFeatures: requiredFeatures.length > 0 ? requiredFeatures : undefined,
    });
  } catch {
    // Feature request failed — retry without the features the engine can do without.
    useSubgroups = false;
    const fallbackFeatures = retryDeviceFeatures(requiredFeatures);
    device = await adapter.requestDevice({
      requiredFeatures: fallbackFeatures.length > 0 ? fallbackFeatures : undefined,
    });
  }

  // Derived from the *device*, never the adapter. The fallback path above drops
  // `timestamp-query` from the request, so an adapter that advertises the
  // feature can still hand back a device without it. Trusting the adapter here
  // would build a profiler on a device that cannot serve one, and
  // `createQuerySet({ type: 'timestamp' })` fails inside createRenderer — the
  // whole renderer goes down, not just profiling.
  const timestampSupported = GpuProfiler.isSupported(device.features);

  const firstInstanceWarning = indirectFirstInstanceWarning(device.features);
  if (firstInstanceWarning) console.warn(firstInstanceWarning);

  // `useSubgroups` drives only the cull shader, whose subgroup path is correct
  // only at exactly 32 lanes. The device keeps the feature either way.
  if (useSubgroups && !subgroupCullSupported(adapter.info)) {
    useSubgroups = false;
    console.info('[Hyperion] Cull: atomic path (the subgroup path needs subgroups of exactly 32 lanes)');
  }

  device.lost.then((info) => {
    console.error(`[Hyperion] GPU device lost: ${info.message}`);
    onDeviceLost?.(info.message);
  });

  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const dev = typeof __DEV__ !== 'undefined' && __DEV__;
  // Dev builds: set once a probe asks for the swapchain, which is then
  // reconfigured with TEXTURE_BINDING. Never before, so GPU times measured in
  // a dev session run on the production canvas configuration.
  let swapchainSampled = false;

  // --- 2. Create TextureManager + SelectionManager ---
  const textureManager = new TextureManager(device, { compressedFormat });
  const selectionManager = new SelectionManager(MAX_GPU_ENTITIES);

  // --- 3. Create shared GPU buffers in ResourcePool ---
  const resources = new ResourcePool();

  resources.setBuffer('entity-transforms', device.createBuffer({
    size: MAX_GPU_ENTITIES * 16 * 4,
    // COPY_SRC in dev builds: engine.debug.readEntityTransforms reads it back.
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | (dev ? GPUBufferUsage.COPY_SRC : 0),
  }));
  const debugProbe = dev ? new DebugProbe(device, pixelProbeShaderCode) : null;
  // Built with the pixel probe, dev only. It must exist before the graph
  // factories below: the scene factory hands it to every TransparentSortPass.
  const sortProbe = debugProbe ? new TransparentSortProbe(device) : null;

  resources.setBuffer('entity-bounds', device.createBuffer({
    size: MAX_GPU_ENTITIES * 4 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }));

  resources.setBuffer('visible-indices', device.createBuffer({
    size: TOTAL_DRAW_BUCKETS * MAX_GPU_ENTITIES * 4,  // 28 regions x 100k x u32 = 11.2 MB
    usage: GPUBufferUsage.STORAGE,
  }));

  resources.setBuffer('indirect-args', device.createBuffer({
    size: INDIRECT_BUFFER_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  }));

  resources.setBuffer('tex-indices', device.createBuffer({
    size: MAX_GPU_ENTITIES * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }));

  resources.setBuffer('render-meta', device.createBuffer({
    size: MAX_GPU_ENTITIES * 2 * 4,  // 2 u32/entity
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }));

  resources.setBuffer('prim-params', device.createBuffer({
    size: MAX_GPU_ENTITIES * 8 * 4,  // 8 f32/entity
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }));

  // Selection mask buffer: 1 u32 per entity (0=unselected, 1=selected)
  const selectionMaskBuffer = device.createBuffer({
    size: MAX_GPU_ENTITIES * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  resources.setBuffer('selection-mask', selectionMaskBuffer);

  // Slot -> external id (phase 5b §4.3): the transparent sort breaks z ties
  // by id. Renderer-owned like every pool buffer: graph swaps and hot-reload
  // probes re-run their passes' setup(), so a pass-owned buffer would come
  // back empty while `uploadedIdsGeneration` still said "uploaded".
  const entityIdsBuffer = device.createBuffer({
    size: MAX_GPU_ENTITIES * 4,
    // COPY_SRC in dev builds (design §4.3), like entity-transforms.
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | (dev ? GPUBufferUsage.COPY_SRC : 0),
    label: 'entity-ids',
  });
  resources.setBuffer('entity-ids', entityIdsBuffer);

  // Transparent sort (Phase 5b). Renderer-owned on purpose: a hot-reload probe
  // runs TransparentSortPass.setup() and then destroy() on this LIVE pool, so a
  // pass that registered them would destroy the live graph's buffers. COPY_SRC
  // in dev builds: engine.debug.readTransparentSort() copies them out.
  resources.setBuffer('transparent-order', device.createBuffer({
    label: 'transparent-order',
    size: SORT_CAPACITY * 4,  // the sorted slots; the uber draw reads them (step 4)
    usage: GPUBufferUsage.STORAGE | (dev ? GPUBufferUsage.COPY_SRC : 0),
  }));
  resources.setBuffer('transparent-args', device.createBuffer({
    label: 'transparent-args',
    size: SORT_HEADER_BYTES,  // draw args, dispatch args at 20 B, raw/limit/overflow/stamp
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
      | (dev ? GPUBufferUsage.COPY_SRC : 0),
  }));

  // --- 4. Populate texture views + sampler in ResourcePool ---
  // A tier that grows replaces its view and destroys the old texture, so the
  // pool is refreshed on every growth; ForwardPass rebinds when it sees it.
  const registerTextureViews = (): void => {
    for (let tier = 0; tier < 4; tier++) {
      resources.setTextureView(`tier${tier}`, textureManager.getTierView(tier));
      resources.setTextureView(`ovf${tier}`, textureManager.getOverflowTierView(tier));
    }
  };
  registerTextureViews();
  textureManager.onViewsChanged = registerTextureViews;
  resources.setSampler('texSampler', textureManager.getSampler());

  // --- 5. Create intermediate scene-hdr texture for post-processing ---
  let sceneHdrTexture = device.createTexture({
    size: { width: canvas.width, height: canvas.height },
    format: SCENE_HDR_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    label: 'scene-hdr',
  });
  resources.setTextureView('scene-hdr', sceneHdrTexture.createView());
  let sceneHdrWidth = canvas.width;
  let sceneHdrHeight = canvas.height;

  // --- 6. Set shader sources and setup base passes ---
  CullPass.SHADER_SOURCE = prepareShaderSource(
    cullShaderCode,
    useSubgroups,
    useSubgroups && subgroupSupport.hasSubgroupId,
  );
  // The six per-type modules and the uber, composed from the pieces, before
  // RenderGraphHost builds the first graph: ForwardPass.setup needs both.
  publishPrimitiveShaders();
  FXAATonemapPass.SHADER_SOURCE = fxaaShaderCode;
  SelectionSeedPass.SHADER_SOURCE = selectionSeedShaderCode;
  JFAPass.SHADER_SOURCE = jfaShaderCode;
  OutlineCompositePass.SHADER_SOURCE = outlineCompositeShaderCode;
  LineBatchPass.SHADER_SOURCE = debugLineShaderCode;
  SdfChainStage.SHADER_SOURCE = sdfJfaShaderCode;
  LightAccumStage.SHADER_SOURCE = lightAccumShaderCode;

  CullPass.SUBGROUP_CONFIG = {
    useSubgroups,
    subgroupSize: 32,  // the only width the subgroup path supports: see subgroupCullSupported
    useSubgroupId: useSubgroups && subgroupSupport.hasSubgroupId,
  };

  // --- 6b. ScatterPass for partial GPU upload (created with the graph, step 8c) ---
  ScatterPass.SHADER_SOURCE = scatterShaderCode;
  let scatterPass: ScatterPass | null = null;
  const resolvedScatterThreshold = scatterThreshold ?? 0.3;

  // --- 6c. TransparentSortPass: gather + GPU radix sort of the transparents (created with the graph) ---
  TransparentSortPass.GATHER_SOURCE = transparentGatherShaderCode;
  TransparentSortPass.SORT_SOURCE = transparentSortShaderCode;

  // --- 7. GPU profiler state ---
  // Constructed on the first enableGpuProfiling(), never here, so that the
  // "costs nothing when off" claim in gpu-profiler.ts holds literally: until
  // someone asks for timings there is no query set and no readback buffer.
  // Once built it is re-attached on every graph swap (onSwap), so its rolling
  // averages survive outline/bloom toggles and shader hot-reloads.
  let gpuProfiler: GpuProfiler | null = null;
  let gpuProfilingEnabled = false;

  // --- 7b. Create GPU particle system (standalone, outside RenderGraph) ---
  let currentParticleSimSrc = particleSimulateCode;
  let currentParticleRenderSrc = particleRenderCode;
  const particleSystem = new ParticleSystem(device);
  particleSystem.setupPipelines(currentParticleSimSrc, currentParticleRenderSrc, format);

  // --- 8a. Bloom state ---
  let bloomHalfTexture: GPUTexture | null = null;
  let bloomQuarterTexture: GPUTexture | null = null;
  let bloomEighthTexture: GPUTexture | null = null;
  let bloomTexWidth = 0;
  let bloomTexHeight = 0;

  BloomPass.SHADER_SOURCE = bloomShaderCode;

  /**
   * Create or recreate bloom intermediate textures to match canvas size.
   */
  function ensureBloomTextures(width: number, height: number): void {
    if (bloomHalfTexture && bloomTexWidth === width && bloomTexHeight === height) return;
    bloomHalfTexture?.destroy();
    bloomQuarterTexture?.destroy();
    bloomEighthTexture?.destroy();

    const halfW = Math.max(1, Math.floor(width / 2));
    const halfH = Math.max(1, Math.floor(height / 2));
    const quarterW = Math.max(1, Math.floor(width / 4));
    const quarterH = Math.max(1, Math.floor(height / 4));
    const eighthW = Math.max(1, Math.floor(width / 8));
    const eighthH = Math.max(1, Math.floor(height / 8));

    // Must stay SCENE_HDR_FORMAT: BloomPass builds its extract/downsample/
    // upsample pipelines against that constant and renders into these.
    bloomHalfTexture = device.createTexture({
      size: { width: halfW, height: halfH },
      format: SCENE_HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    bloomQuarterTexture = device.createTexture({
      size: { width: quarterW, height: quarterH },
      format: SCENE_HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    bloomEighthTexture = device.createTexture({
      size: { width: eighthW, height: eighthH },
      format: SCENE_HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    resources.setTextureView('bloom-half', bloomHalfTexture.createView());
    resources.setTextureView('bloom-quarter', bloomQuarterTexture.createView());
    resources.setTextureView('bloom-eighth', bloomEighthTexture.createView());

    bloomTexWidth = width;
    bloomTexHeight = height;
  }

  // --- 8b. JFA outline state ---
  let outlineCompositePass: OutlineCompositePass | null = null;
  let jfaPasses: JFAPass[] = [];
  let jfaTextureA: GPUTexture | null = null;
  let jfaTextureB: GPUTexture | null = null;
  let jfaTexWidth = 0;
  let jfaTexHeight = 0;

  /**
   * Create or recreate the JFA ping-pong textures to match the canvas size.
   */
  function ensureJFATextures(requestedWidth: number, requestedHeight: number): void {
    // A 0x0 canvas (hidden, not laid out yet) must not fail createTexture:
    // inside a graph build that error would be blamed on the outline shaders.
    const width = Math.max(1, requestedWidth);
    const height = Math.max(1, requestedHeight);
    if (jfaTextureA && jfaTexWidth === width && jfaTexHeight === height) return;
    jfaTextureA?.destroy();
    jfaTextureB?.destroy();

    jfaTextureA = device.createTexture({
      size: { width, height },
      format: JFA_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    jfaTextureB = device.createTexture({
      size: { width, height },
      format: JFA_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    jfaTexWidth = width;
    jfaTexHeight = height;
  }

  /**
   * Map JFA iteration resource names to the physical ping-pong texture views.
   * Each jfa-iter-N maps to texture A or B depending on N % 2.
   */
  function updateJFATextureViews(numIterations: number): void {
    if (!jfaTextureA || !jfaTextureB) return;
    const viewA = jfaTextureA.createView();
    const viewB = jfaTextureB.createView();
    for (let i = 0; i < numIterations; i++) {
      // Even iterations write to A, odd to B
      resources.setTextureView(`jfa-iter-${i}`, i % 2 === 0 ? viewA : viewB);
    }
  }

  // --- 8b'. Lighting state ---
  // LightGroupsPass owns its textures (seed, SDF ping-pong, the light-buffer
  // array) and sizes them every frame: nothing to allocate here.
  let lightingQuality: LightingQuality = { ...DEFAULT_LIGHTING_QUALITY };
  const reportedQuality = new Set<keyof LightingQuality>();
  let warnedMultiBitReceiver = false;

  // --- 8b''. Transparent sort inputs (phase 5b §4.2-4.3) ---
  // Closure locals, not pass state: they must survive graph swaps and the
  // hot-reload probes. NaN never equals a generation, so the first frame
  // uploads the entity ids; a renderer ever put back under a re-initialised
  // engine (whose generation restarts at 0) must reset this marker to NaN.
  let uploadedIdsGeneration = NaN;
  let frameStamp = 0; // the first render() stamps 1
  let warnedMissingSortInputs = false;
  let warnedOverCapacity = false;
  let warnedShortEntityIds = false;

  // --- 8c. RenderGraph ---
  // RenderGraphHost owns the graph: a new one goes live only once the GPU has
  // validated it, and plugin overlays are validated against every mode
  // (graph-host.ts). GraphRequests owns what the caller asked for and shader
  // hot-reload (graph-requests.ts).
  const BASE_MODE: GraphMode = { outlines: false, bloom: false, lighting: false };
  const gpuValidation = createGpuValidation(device);
  let bloomPass: BloomPass | null = null;
  // Read by onSwap, which first runs inside the RenderGraphHost constructor —
  // before this is assigned.
  let graphRequests: GraphRequests<OutlineOptions, BloomConfig> | undefined;

  /** Constructs the passes of one graph. No GPU work: see GraphPassFactories. */
  const graphFactories: GraphPassFactories = {
    // The sort sits between the cull (its input regions) and the forward pass
    // (which reads its order, and so keeps it alive).
    scene: (mode) => [new ScatterPass(), new CullPass(), new TransparentSortPass(sortProbe), new ForwardPass({ lit: mode.lighting })],
    outline() {
      const maxDim = Math.max(canvas.width, canvas.height);
      const n = JFAPass.iterationsForDimension(maxDim);
      const composite = new OutlineCompositePass(JFAPass.finalOutputResource(n));
      const options = graphRequests?.requested.outlineOptions;
      if (options) {
        composite.outlineColor = options.color;
        composite.outlineWidth = options.width;
      }
      return [
        new SelectionSeedPass(),
        ...Array.from({ length: n }, (_, i) => new JFAPass(i, n, maxDim)),
        composite,
      ];
    },
    bloom: () => new BloomPass(graphRequests?.requested.bloomConfig),
    fxaaTonemap: () => new FXAATonemapPass(),
    // Seed, SDF and accumulation of every light group, in one node. The
    // primitives' own modules cast shadows, through fs_occluder.
    lighting: () => [new LightGroupsPass(ForwardPass.SHADER_SOURCES)],
  };

  /** GPU textures a mode's passes read by name, sized to the canvas. */
  function prepareMode(mode: GraphMode, jfaIterations?: number): void {
    if (mode.outlines) {
      ensureJFATextures(canvas.width, canvas.height);
      updateJFATextureViews(
        jfaIterations ?? JFAPass.iterationsForDimension(Math.max(canvas.width, canvas.height)),
      );
    } else if (mode.bloom) {
      ensureBloomTextures(canvas.width, canvas.height);
    }
  }

  const host = new RenderGraphHost({
    factories: graphFactories,
    setup: (pass) => pass.setup(device, resources),
    prepare: (mode) => prepareMode(mode),
    validation: gpuValidation,
    onSwap(graph, owned, mode) {
      scatterPass = owned.find((p): p is ScatterPass => p instanceof ScatterPass) ?? null;
      jfaPasses = owned.filter((p): p is JFAPass => p instanceof JFAPass);
      outlineCompositePass =
        owned.find((p): p is OutlineCompositePass => p instanceof OutlineCompositePass) ?? null;
      bloomPass = owned.find((p): p is BloomPass => p instanceof BloomPass) ?? null;
      // Options set while this graph was pending went to the old live pass.
      const wanted = graphRequests?.requested;
      if (wanted?.outlineOptions && outlineCompositePass) {
        outlineCompositePass.outlineColor = wanted.outlineOptions.color;
        outlineCompositePass.outlineWidth = wanted.outlineOptions.width;
      }
      if (wanted && bloomPass) bloomPass.configure(wanted.bloomConfig);
      // The canvas may have been resized while this graph was pending, and
      // the resize branch in render() only handles the live graph's mode.
      prepareMode(mode, jfaPasses.length);
      // The graph object is new; re-attach the profiler and drop the history,
      // which measured a different set of passes.
      if (gpuProfilingEnabled && gpuProfiler) {
        graph.setProfiler(gpuProfiler);
        gpuProfiler.reset();
      }
    },
    onError: (message) => console.error(message),
  }, BASE_MODE);

  /** Set up, then destroy, throwaway passes: compiles their shaders and pipelines on this device. */
  const probe = (make: () => RenderPass | RenderPass[]) => (): void => {
    const passes = [make()].flat();
    try {
      for (const pass of passes) pass.setup(device, resources);
    } finally {
      for (const pass of passes) pass.destroy();
    }
  };
  const inEveryMode = (): boolean => true;
  const inBaseMode = (m: GraphMode): boolean => !m.outlines && !m.bloom;
  const inOutlineMode = (m: GraphMode): boolean => m.outlines;
  const inBloomMode = (m: GraphMode): boolean => m.bloom && !m.outlines;
  const inLightingMode = (m: GraphMode): boolean => m.lighting;
  // The seven primitive pieces: the prelude and one library per type. A write
  // recomposes the six per-type modules and the uber module in place
  // (publishPrimitiveShaders: concatenation only, it cannot throw), so the
  // factories and probes holding ForwardPass.SHADER_SOURCES see the new text.
  // Every piece shares ONE probe, which compiles every module a piece is in:
  // ForwardPass (six opaque pipelines + the uber: fs_main, three groups) and
  // the occluder pipelines of LightGroupsPass (fs_occluder, two groups), so
  // an edit that breaks only one entry point is caught too. Shared, a grouped
  // reload (GraphRequests.reloadShaders) compiles it once per probe set.
  const compilePrimitives = probe(() => [new ForwardPass(), new LightGroupsPass(ForwardPass.SHADER_SOURCES)]);
  const primitiveProbe = (): void => {
    // A composed module is never empty (prelude, markers, wrappers): only the
    // RAW pieces show an editor's truncated save. The throw is synchronous,
    // inside the validation window, so the reload is rejected without
    // superseding the edit in flight.
    assertPiecesNotEmpty(primitivePieces);
    compilePrimitives();
  };
  const pieceSlot = (read: () => string, store: (src: string) => void): ShaderSlot => ({
    read,
    write: (src) => {
      store(src);
      publishPrimitiveShaders();
    },
    probe: primitiveProbe,
    usedBy: inEveryMode,
  });
  const primitiveSlots: Record<string, ShaderSlot> = {
    prelude: pieceSlot(() => primitivePieces.prelude, (src) => { primitivePieces.prelude = src; }),
  };
  for (const lib of PRIMITIVE_LIBRARIES) {
    primitiveSlots[lib.name] = pieceSlot(
      () => primitivePieces.libraries[lib.type],
      (src) => { primitivePieces.libraries[lib.type] = src; },
    );
  }
  const shaderSlots: Record<string, ShaderSlot> = {
    cull: {
      read: () => CullPass.SHADER_SOURCE,
      write: (src) => { CullPass.SHADER_SOURCE = src; },
      prepare: (src) => prepareShaderSource(src, useSubgroups, useSubgroups && subgroupSupport.hasSubgroupId),
      probe: probe(() => new CullPass()),
      usedBy: inEveryMode,
    },
    ...primitiveSlots,
    scatter: {
      read: () => ScatterPass.SHADER_SOURCE,
      write: (src) => { ScatterPass.SHADER_SOURCE = src; },
      probe: probe(() => new ScatterPass()),
      usedBy: inEveryMode,
    },
    // A throwaway TransparentSortPass compiles both modules (4 pipelines) and
    // binds the pool buffers, which already exist: it writes nothing there.
    'transparent-gather': {
      read: () => TransparentSortPass.GATHER_SOURCE,
      write: (src) => { TransparentSortPass.GATHER_SOURCE = src; },
      probe: probe(() => new TransparentSortPass()),
      usedBy: inEveryMode,
    },
    'transparent-sort': {
      read: () => TransparentSortPass.SORT_SOURCE,
      write: (src) => { TransparentSortPass.SORT_SOURCE = src; },
      probe: probe(() => new TransparentSortPass()),
      usedBy: inEveryMode,
    },
    'fxaa-tonemap': {
      read: () => FXAATonemapPass.SHADER_SOURCE,
      write: (src) => { FXAATonemapPass.SHADER_SOURCE = src; },
      probe: probe(() => new FXAATonemapPass()),
      usedBy: inBaseMode,
    },
    'selection-seed': {
      read: () => SelectionSeedPass.SHADER_SOURCE,
      write: (src) => { SelectionSeedPass.SHADER_SOURCE = src; },
      probe: probe(() => new SelectionSeedPass()),
      usedBy: inOutlineMode,
    },
    jfa: {
      read: () => JFAPass.SHADER_SOURCE,
      write: (src) => { JFAPass.SHADER_SOURCE = src; },
      probe: probe(() => new JFAPass(0, 1, 1)),
      usedBy: inOutlineMode,
    },
    'outline-composite': {
      read: () => OutlineCompositePass.SHADER_SOURCE,
      write: (src) => { OutlineCompositePass.SHADER_SOURCE = src; },
      probe: probe(() => new OutlineCompositePass(JFAPass.finalOutputResource(1))),
      usedBy: inOutlineMode,
    },
    bloom: {
      read: () => BloomPass.SHADER_SOURCE,
      write: (src) => { BloomPass.SHADER_SOURCE = src; },
      probe: probe(() => new BloomPass()),
      usedBy: inBloomMode,
    },
    // LightGroupsPass's setup compiles every stage: both SDF pipelines
    // (LOAD_PASS on and off), the accumulation and the occluder pipelines.
    'sdf-jfa': {
      read: () => SdfChainStage.SHADER_SOURCE,
      write: (src) => { SdfChainStage.SHADER_SOURCE = src; },
      probe: probe(() => new LightGroupsPass(ForwardPass.SHADER_SOURCES)),
      usedBy: inLightingMode,
    },
    'light-accum': {
      read: () => LightAccumStage.SHADER_SOURCE,
      write: (src) => { LightAccumStage.SHADER_SOURCE = src; },
      probe: probe(() => new LightGroupsPass(ForwardPass.SHADER_SOURCES)),
      usedBy: inLightingMode,
    },
  };

  const requests = new GraphRequests<OutlineOptions, BloomConfig>({
    host,
    validation: gpuValidation,
    slots: shaderSlots,
    applyOutlineOptions(options) {
      if (!outlineCompositePass) return;
      outlineCompositePass.outlineColor = options.color;
      outlineCompositePass.outlineWidth = options.width;
    },
    applyBloomConfig: (config) => bloomPass?.configure(config),
    log: console,
  });
  graphRequests = requests;

  // The lighting backend lives in WASM and arrives with every frame's state.
  // A throw here would escape render() and stop the RAF loop for good.
  const followBackend = followLightingBackend((lit) => {
    try {
      requests.setLighting(lit);
    } catch (err) {
      console.error(`[Hyperion] Lighting could not be ${lit ? 'enabled' : 'disabled'}:`, err);
    }
  }, (message) => console.warn(message));

  /**
   * Particles live outside the RenderGraph. Same rule as GraphRequests: each
   * stage's new pipelines are built into locals, validated by the GPU, and
   * installed (rebinding every emitter) only on a clean verdict — the ones in
   * use are never replaced by something that has not compiled.
   */
  const particleReloads = { simulate: 0, render: 0 };
  function reloadParticleShader(stage: 'simulate' | 'render', code: string): void {
    let built: Partial<ParticlePipelines> = {};
    let verdict: Promise<string[]>;
    try {
      verdict = gpuValidation.run(() => {
        built = stage === 'simulate'
          ? particleSystem.buildSimulate(code)
          : particleSystem.buildRender(code, format);
      });
    } catch (err) {
      console.error(`[Hyperion] Shader "particle-${stage}" did not compile — keeping the previous source:`, err);
      return;
    }
    const version = ++particleReloads[stage];
    void verdict.then((messages) => {
      if (version !== particleReloads[stage]) return; // a newer reload of this stage owns it
      if (messages.length > 0) {
        console.error(
          `[Hyperion] Shader "particle-${stage}" rejected by the GPU — keeping the previous source:\n${messages.join('\n')}`,
        );
        return;
      }
      particleSystem.installPipelines(built);
      if (stage === 'simulate') currentParticleSimSrc = code;
      else currentParticleRenderSrc = code;
      console.log(`[Hyperion] Shader "particle-${stage}" hot-reloaded`);
    });
  }

  // Dev only: cancels the primitive pieces' pending HMR window. Set in the
  // import.meta.hot block below; destroy() calls it first.
  let cancelPieceReloads = (): void => {};

  // --- 9. Build the Renderer object ---
  const rendererObj: Renderer = {
    textureManager,
    selectionManager,
    particleSystem,

    get graph() { return host.graph; },
    get device() { return device; },

    addPass(pass: RenderPass): void {
      host.addExternal(pass);
    },

    removePass(name: string): void {
      host.removeExternal(name);
    },

    get outlinesEnabled(): boolean {
      return requests.requested.mode.outlines;
    },

    enableOutlines(options: OutlineOptions): void {
      requests.enableOutlines(options);
    },

    disableOutlines(): void {
      requests.disableOutlines();
    },

    get bloomEnabled(): boolean {
      return requests.requested.mode.bloom;
    },

    get lightingEnabled(): boolean {
      return requests.requested.mode.lighting;
    },

    setLightingQuality(quality: LightingQuality): void {
      lightingQuality = { ...quality };
      const fresh = unsupportedLightingQuality(quality).filter((key) => !reportedQuality.has(key));
      if (fresh.length > 0) {
        for (const key of fresh) reportedQuality.add(key);
        console.warn(
          `[Hyperion] Lighting quality ${fresh.join(', ')} not supported yet: ` +
          'the light buffer and the SDF stay at half resolution, without padding.',
        );
      }
    },

    enableBloom(config?: BloomConfig): void {
      requests.enableBloom(config);
    },

    disableBloom(): void {
      requests.disableBloom();
    },

    recompileShader(passName: string, shaderCode: string): void {
      switch (passName) {
        case 'debug-line':
          LineBatchPass.SHADER_SOURCE = shaderCode;
          // No renderer-owned pass uses it, so there is nothing to rebuild.
          // Overlays are caller-owned and set up once when added: an
          // installed one keeps its pipeline until its plugin is reinstalled.
          console.log(`[Hyperion] Shader "${passName}" updated — applies to overlays added from now on`);
          return;
        case 'particle-simulate':
          reloadParticleShader('simulate', shaderCode);
          return;
        case 'particle-render':
          reloadParticleShader('render', shaderCode);
          return;
      }
      // 'basic' is the quad library's old file name (basic.wgsl): an alias, so
      // both names share one slot, one good source and one reload version.
      void requests.reloadShader(passName === 'basic' ? 'quad' : passName, shaderCode);
    },

    render(state: GPURenderState, camera: { viewProjection: Float32Array }, dt?: number) {
      frameStamp = nextFrameStamp(frameStamp);
      followBackend(state.lightingBackend);
      if (dev && !warnedMissingSortInputs) {
        const missing = missingSortInputs(state);
        if (missing.length > 0) {
          warnedMissingSortInputs = true;
          console.warn(`[Hyperion] The render state lacks ${missing.join(' and ')} (a WASM build older than phase 5b, or a transport site that drops it): the transparent sort is sized from entityCount and the entity ids are uploaded every frame.`);
        }
      }
      if (!warnedOverCapacity) {
        const overCapacity = overCapacityWarning(state.entityCount);
        if (overCapacity) {
          warnedOverCapacity = true;
          console.warn(overCapacity);
        }
      }
      // No early return on an empty world: its frame is the clear (CullPass
      // skips its dispatch, the indirect draws count zero). Returning here left
      // the last image on screen after the last entity was destroyed.

      // Scatter/full upload branching:
      // When dirty ratio is below threshold and scatter pass is available,
      // upload only dirty entities via GPU compute scatter. Otherwise, fall
      // back to full writeBuffer uploads for all SoA buffers.
      const useScatter = state.dirtyCount > 0
        && state.dirtyRatio <= resolvedScatterThreshold
        && scatterPass
        && state.stagingData
        && state.dirtyIndices;

      if (useScatter) {
        // Scatter path: upload only dirty data via GPU compute
        scatterPass!.prepareDirtyData(
          device,
          resources,
          state.stagingData!,
          state.dirtyIndices!,
          state.dirtyCount,
        );
        // ScatterPass.execute() will be called by RenderGraph
      } else if (state.entityCount > 0) {
        // Full upload path: write entire SoA buffers to GPU
        const transformBuf = resources.getBuffer('entity-transforms')!;
        device.queue.writeBuffer(
          transformBuf, 0,
          state.transforms as Float32Array<ArrayBuffer>, 0,
          state.entityCount * 16,
        );

        const boundsBuf = resources.getBuffer('entity-bounds')!;
        device.queue.writeBuffer(
          boundsBuf, 0,
          state.bounds as Float32Array<ArrayBuffer>, 0,
          state.entityCount * 4,
        );

        const texBuf = resources.getBuffer('tex-indices')!;
        device.queue.writeBuffer(
          texBuf, 0,
          state.texIndices as Uint32Array<ArrayBuffer>, 0,
          state.entityCount,
        );

        // Upload render meta
        const renderMetaBuf = resources.getBuffer('render-meta')!;
        device.queue.writeBuffer(
          renderMetaBuf, 0,
          state.renderMeta as Uint32Array<ArrayBuffer>, 0,
          state.entityCount * 2,
        );

        // Upload prim params
        if (state.primParams && state.primParams.length > 0) {
          const primParamsBuf = resources.getBuffer('prim-params')!;
          device.queue.writeBuffer(
            primParamsBuf, 0,
            state.primParams as Float32Array<ArrayBuffer>, 0,
            state.entityCount * 8,
          );
        }
      }

      // Entity ids: on EVERY frame kind, outside the if/else above — the
      // scatter staging carries no id, and a swap-remove moves rows between
      // slots. Only when the slot -> id mapping changed (its generation).
      const idsUpload = uploadEntityIds(device.queue, entityIdsBuffer, state, uploadedIdsGeneration);
      uploadedIdsGeneration = idsUpload.generation;
      if (dev && idsUpload.warning && !warnedShortEntityIds) {
        warnedShortEntityIds = true;
        console.warn(idsUpload.warning);
      }

      // Upload selection mask if dirty
      if (requests.requested.mode.outlines || host.mode.outlines) {
        selectionManager.uploadMask(device, selectionMaskBuffer, state.entityIds, state.entityCount);
      }

      // Recreate scene-hdr texture if canvas dimensions changed
      if (canvas.width !== sceneHdrWidth || canvas.height !== sceneHdrHeight) {
        sceneHdrTexture.destroy();
        sceneHdrTexture = device.createTexture({
          size: { width: canvas.width, height: canvas.height },
          format: SCENE_HDR_FORMAT,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          label: 'scene-hdr',
        });
        resources.setTextureView('scene-hdr', sceneHdrTexture.createView());
        sceneHdrWidth = canvas.width;
        sceneHdrHeight = canvas.height;

        // Recreate the live graph's JFA / bloom textures on resize (the light
        // node follows the canvas on its own). A pending graph catches up when
        // it goes live (onSwap).
        prepareMode(host.mode, jfaPasses.length);

        // Pass cost is roughly proportional to pixel count, so samples taken at
        // the old resolution must not be averaged with the new ones.
        if (gpuProfilingEnabled) gpuProfiler?.reset();
      }

      if (debugProbe?.wantsSwapchain && !swapchainSampled) {
        context.configure({
          device, format, alphaMode: "opaque",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        swapchainSampled = true;
      }

      // Set swapchain view for this frame
      resources.setTextureView('swapchain', context.getCurrentTexture().createView());

      // Build FrameState
      const frameState: FrameState = {
        entityCount: state.entityCount,
        transforms: state.transforms,
        bounds: state.bounds,
        renderMeta: state.renderMeta,
        texIndices: state.texIndices,
        primParams: state.primParams ?? new Float32Array(0),
        cameraViewProjection: camera.viewProjection,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        deltaTime: dt ?? 0,
        physicsDebugLines: state.physicsDebugLines ?? undefined,
        ambient: [state.ambientR, state.ambientG, state.ambientB, state.ambientIntensity],
        shadowSteps: lightingQuality.shadowSteps,
        transparentCount: normalizeTransparentCount(state.transparentCount, state.entityCount),
        frameStamp,
      };
      // Light layers: which layers share a light buffer and an SDF, this frame.
      if (host.mode.lighting) {
        frameState.lightGroups = deriveLightGroups(frameState);
        if (frameState.lightGroups.multiBitReceiver && !warnedMultiBitReceiver) {
          warnedMultiBitReceiver = true;
          console.warn('[Hyperion] A light receiver has more than one layer bit: it belongs to its lowest one (see lightLayers()).');
        }
      }

      // Dev readback (engine.debug.readTransparentSort, design §6.5). On a
      // frame that may serve a request the graph runs inside GPU error scopes:
      // a frame that failed validation rejects the request instead of
      // answering zeros. A throw rejects the taken request and every queued
      // one, then goes on up as before.
      const sortReadback = sortProbe?.hasPending === true;
      let frameErrors: Promise<string[]> | null = null;
      try {
        if (sortReadback) frameErrors = gpuValidation.run(() => host.graph.render(device, frameState, resources));
        else host.graph.render(device, frameState, resources);
      } catch (err) {
        sortProbe?.failFrame(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
      // First thing after the graph's submit, before anything else can throw:
      // maps the buffers of the request the sort took (the snapshot is copied
      // now, before latestRenderState moves on), or rejects the head of the
      // queue when this frame's sort did not run.
      sortProbe?.finish(sortReadback ? {
        tickCount: state.tickCount,
        stamp: frameState.frameStamp,
        entityCount: state.entityCount,
        transparentCount: frameState.transparentCount,
        idsGeneration: idsUpload.generation,
        idsUploaded: idsUpload.uploaded,
        usedScatter: Boolean(useScatter),
        viewProjection: camera.viewProjection,
        bounds: state.bounds,
        entityIds: state.entityIds,
        renderMeta: state.renderMeta,
        texIndices: state.texIndices,
      } : null, frameErrors);

      // --- Particle system: simulate + render AFTER the scene graph ---
      if (particleSystem.emitterCount > 0) {
        // Build entity position map from SoA transforms for emitter tracking
        let entityPositions: Map<number, [number, number]> | undefined;
        if (state.entityIds) {
          entityPositions = new Map();
          for (let i = 0; i < state.entityCount; i++) {
            // Translation is column 3 of the 4x4 matrix: indices 12 (x) and 13 (y)
            const base = i * 16;
            entityPositions.set(state.entityIds[i], [
              state.transforms[base + 12],
              state.transforms[base + 13],
            ]);
          }
        }

        const swapchainView = resources.getTextureView('swapchain')!;
        const particleEncoder = device.createCommandEncoder();
        particleSystem.update(
          particleEncoder,
          swapchainView,
          camera.viewProjection,
          dt ?? 0,
          entityPositions,
        );
        device.queue.submit([particleEncoder.finish()]);
      }

      // Last: the probe must see the final swapchain, before it is presented.
      debugProbe?.serve(resources, frameState, {
        buffer: resources.getBuffer('entity-transforms')!,
        transforms: state.transforms,
        entityIds: state.entityIds,
        entityCount: state.entityCount,
        usedScatter: Boolean(useScatter),
      }, swapchainSampled);
    },

    get gpuProfilingSupported() { return timestampSupported; },

    enableGpuProfiling() {
      if (!timestampSupported) return false;
      gpuProfiler ??= new GpuProfiler(device);
      gpuProfilingEnabled = true;
      host.graph.setProfiler(gpuProfiler);
      gpuProfiler.reset();
      return true;
    },

    disableGpuProfiling() {
      gpuProfilingEnabled = false;
      host.graph.setProfiler(null);
    },

    getGpuTimings() {
      // The profiler keeps its history after a disable; what it holds then is
      // frozen, and quoting it as current would mislead.
      return gpuProfilingEnabled ? gpuProfiler?.timings() ?? [] : [];
    },

    getGpuFrameTiming() {
      return gpuProfilingEnabled ? gpuProfiler?.frameTiming() ?? null : null;
    },

    debugProbe,
    sortProbe,

    destroy() {
      cancelPieceReloads();
      debugProbe?.destroy();
      sortProbe?.destroy();
      gpuProfiler?.destroy();
      particleSystem.destroy();
      sceneHdrTexture.destroy();
      jfaTextureA?.destroy();
      jfaTextureB?.destroy();
      bloomHalfTexture?.destroy();
      bloomQuarterTexture?.destroy();
      bloomEighthTexture?.destroy();
      selectionManager.destroy();
      host.destroy(); // overlays are detached, not destroyed: their owners do that
      resources.destroy();
      textureManager.destroy();
      device.destroy();
    },
  };

  // --- Shader Hot-Reload (dev only) ---
  if (import.meta.hot) {
    // Primitive pieces wait for a quiet 50 ms window and reload as a group:
    // a prelude rename and its uses in a library arrive as separate updates,
    // and each alone would be probed against the other's old text.
    const pieceReloads = new PieceReloadCollector((entries) => requests.reloadShaders(entries));
    // The accepts outlive the renderer: after destroy() no window may reach its device.
    cancelPieceReloads = () => pieceReloads.dispose();
    import.meta.hot.accept('./shaders/primitives/prelude.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('prelude', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/quad.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('quad', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/line.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('line', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/msdf-text.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('msdf-text', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/bezier.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('bezier', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/gradient.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('gradient', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/box-shadow.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('box-shadow', mod.default);
    });
    import.meta.hot.accept('./shaders/cull.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('cull', mod.default);
    });
    import.meta.hot.accept('./shaders/fxaa-tonemap.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('fxaa-tonemap', mod.default);
    });
    import.meta.hot.accept('./shaders/selection-seed.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('selection-seed', mod.default);
    });
    import.meta.hot.accept('./shaders/jfa.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('jfa', mod.default);
    });
    import.meta.hot.accept('./shaders/outline-composite.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('outline-composite', mod.default);
    });
    import.meta.hot.accept('./shaders/bloom.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('bloom', mod.default);
    });
    import.meta.hot.accept('./shaders/scatter.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('scatter', mod.default);
    });
    import.meta.hot.accept('./shaders/transparent-gather.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('transparent-gather', mod.default);
    });
    import.meta.hot.accept('./shaders/transparent-sort.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('transparent-sort', mod.default);
    });
    import.meta.hot.accept('./shaders/sdf-jfa.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('sdf-jfa', mod.default);
    });
    import.meta.hot.accept('./shaders/light-accum.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('light-accum', mod.default);
    });
    import.meta.hot.accept('./shaders/particle-simulate.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('particle-simulate', mod.default);
    });
    import.meta.hot.accept('./shaders/particle-render.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('particle-render', mod.default);
    });
  }

  return rendererObj;
}
