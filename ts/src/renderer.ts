import shaderCode from './shaders/basic.wgsl?raw';
import lineShaderCode from './shaders/line.wgsl?raw';
import msdfShaderCode from './shaders/msdf-text.wgsl?raw';
import gradientShaderCode from './shaders/gradient.wgsl?raw';
import boxShadowShaderCode from './shaders/box-shadow.wgsl?raw';
import bezierShaderCode from './shaders/bezier.wgsl?raw';
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
import radixSortShaderCode from './shaders/radix-sort.wgsl?raw';
import { TextureManager } from './texture-manager';
import { RenderGraph } from './render/render-graph';
import { ResourcePool } from './render/resource-pool';
import { CullPass, TOTAL_DRAW_BUCKETS, prepareShaderSource } from './render/passes/cull-pass';
import { ForwardPass } from './render/passes/forward-pass';
import { FXAATonemapPass } from './render/passes/fxaa-tonemap-pass';
import { SelectionSeedPass } from './render/passes/selection-seed-pass';
import { JFAPass } from './render/passes/jfa-pass';
import { OutlineCompositePass } from './render/passes/outline-composite-pass';
import { LineBatchPass } from './render/passes/debug-line-pass';
import { BloomPass } from './render/passes/bloom-pass';
import type { BloomConfig } from './render/passes/bloom-pass';
import { ScatterPass } from './render/passes/scatter-pass';
import { RadixSortPass } from './render/passes/radix-sort-pass';
import { SelectionManager } from './selection';
import {
  detectCompressedFormat, detectSubgroupSupport, describeAdapter,
  selectDeviceFeatures, retryDeviceFeatures, indirectFirstInstanceWarning,
} from './capabilities';
import { ParticleSystem, type ParticlePipelines } from './particle-system';
import type { FrameState, RenderPass } from './render/render-pass';
import type { GraphMode, GraphPassFactories } from './render/graph-assembly';
import { RenderGraphHost, createGpuValidation } from './render/graph-host';
import { GraphRequests, type ShaderSlot } from './render/graph-requests';
import type { GPURenderState } from './worker-bridge';
import { SCENE_HDR_FORMAT, JFA_FORMAT } from './render/formats';
import { GpuProfiler, type PassTiming } from './render/gpu-profiler';

const MAX_ENTITIES = 100_000;
// 28 draw entries (14 opaque + 14 transparent) x 5 u32 x 4 bytes = 560 bytes
const INDIRECT_BUFFER_SIZE = TOTAL_DRAW_BUCKETS * 5 * 4;

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
  recompileShader(passName: string, shaderCode: string): void;

  /**
   * Whether this device exposes `timestamp-query`. False on drivers that lack
   * it — every profiling call below is then a safe no-op.
   */
  readonly gpuProfilingSupported: boolean;
  /**
   * Start measuring per-pass GPU time. Returns false when unsupported.
   * Read the numbers with {@link getGpuTimings}; quote `averageMs`, not
   * `lastMs`, because Chrome quantizes timestamps to 100us by default.
   */
  enableGpuProfiling(): boolean;
  disableGpuProfiling(): void;
  /** Per-pass GPU timings. Empty when profiling is off or still warming up. */
  getGpuTimings(): PassTiming[];

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

  device.lost.then((info) => {
    console.error(`[Hyperion] GPU device lost: ${info.message}`);
    onDeviceLost?.(info.message);
  });

  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  // --- 2. Create TextureManager + SelectionManager ---
  const textureManager = new TextureManager(device, { compressedFormat });
  const selectionManager = new SelectionManager(MAX_ENTITIES);

  // --- 3. Create shared GPU buffers in ResourcePool ---
  const resources = new ResourcePool();

  resources.setBuffer('entity-transforms', device.createBuffer({
    size: MAX_ENTITIES * 16 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }));

  resources.setBuffer('entity-bounds', device.createBuffer({
    size: MAX_ENTITIES * 4 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }));

  resources.setBuffer('visible-indices', device.createBuffer({
    size: TOTAL_DRAW_BUCKETS * MAX_ENTITIES * 4,  // 28 regions x 100k x u32 = 11.2 MB
    usage: GPUBufferUsage.STORAGE,
  }));

  resources.setBuffer('indirect-args', device.createBuffer({
    size: INDIRECT_BUFFER_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  }));

  resources.setBuffer('tex-indices', device.createBuffer({
    size: MAX_ENTITIES * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }));

  resources.setBuffer('render-meta', device.createBuffer({
    size: MAX_ENTITIES * 2 * 4,  // 2 u32/entity
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }));

  resources.setBuffer('prim-params', device.createBuffer({
    size: MAX_ENTITIES * 8 * 4,  // 8 f32/entity
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }));

  // Selection mask buffer: 1 u32 per entity (0=unselected, 1=selected)
  const selectionMaskBuffer = device.createBuffer({
    size: MAX_ENTITIES * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  resources.setBuffer('selection-mask', selectionMaskBuffer);

  // --- 4. Populate texture views + sampler in ResourcePool ---
  resources.setTextureView('tier0', textureManager.getTierView(0));
  resources.setTextureView('tier1', textureManager.getTierView(1));
  resources.setTextureView('tier2', textureManager.getTierView(2));
  resources.setTextureView('tier3', textureManager.getTierView(3));
  resources.setTextureView('ovf0', textureManager.getOverflowTierView(0));
  resources.setTextureView('ovf1', textureManager.getOverflowTierView(1));
  resources.setTextureView('ovf2', textureManager.getOverflowTierView(2));
  resources.setTextureView('ovf3', textureManager.getOverflowTierView(3));
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
  ForwardPass.SHADER_SOURCES = {
    0: shaderCode,              // Quad
    1: lineShaderCode,          // Line
    2: msdfShaderCode,          // SDFGlyph (MSDF text)
    3: bezierShaderCode,        // BezierPath
    4: gradientShaderCode,      // Gradient
    5: boxShadowShaderCode,     // BoxShadow
  };
  FXAATonemapPass.SHADER_SOURCE = fxaaShaderCode;
  SelectionSeedPass.SHADER_SOURCE = selectionSeedShaderCode;
  JFAPass.SHADER_SOURCE = jfaShaderCode;
  OutlineCompositePass.SHADER_SOURCE = outlineCompositeShaderCode;
  LineBatchPass.SHADER_SOURCE = debugLineShaderCode;

  CullPass.SUBGROUP_CONFIG = {
    useSubgroups,
    subgroupSize: 32,  // TODO: query actual subgroup size from adapter if API available
    useSubgroupId: useSubgroups && subgroupSupport.hasSubgroupId,
  };

  // --- 6b. ScatterPass for partial GPU upload (created with the graph, step 8c) ---
  ScatterPass.SHADER_SOURCE = scatterShaderCode;
  let scatterPass: ScatterPass | null = null;
  const resolvedScatterThreshold = scatterThreshold ?? 0.3;

  // --- 6c. RadixSortPass for transparent entity ordering (created with the graph) ---
  RadixSortPass.SHADER_SOURCE = radixSortShaderCode;

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

  // --- 8c. RenderGraph ---
  // RenderGraphHost owns the graph: a new one goes live only once the GPU has
  // validated it, and plugin overlays are validated against every mode
  // (graph-host.ts). GraphRequests owns what the caller asked for and shader
  // hot-reload (graph-requests.ts).
  const BASE_MODE: GraphMode = { outlines: false, bloom: false };
  const gpuValidation = createGpuValidation(device);
  let bloomPass: BloomPass | null = null;
  // Read by onSwap, which first runs inside the RenderGraphHost constructor —
  // before this is assigned.
  let graphRequests: GraphRequests<OutlineOptions, BloomConfig> | undefined;

  /** Constructs the passes of one graph. No GPU work: see GraphPassFactories. */
  const graphFactories: GraphPassFactories = {
    scene: () => [new ScatterPass(), new CullPass(), new RadixSortPass(), new ForwardPass()],
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

  /** Set up, then destroy, a throwaway pass: compiles its shaders and pipelines on this device. */
  const probe = (make: () => RenderPass) => (): void => {
    const pass = make();
    try {
      pass.setup(device, resources);
    } finally {
      pass.destroy();
    }
  };
  const inEveryMode = (): boolean => true;
  const inBaseMode = (m: GraphMode): boolean => !m.outlines && !m.bloom;
  const inOutlineMode = (m: GraphMode): boolean => m.outlines;
  const inBloomMode = (m: GraphMode): boolean => m.bloom && !m.outlines;
  const forwardSlot = (i: number): ShaderSlot => ({
    read: () => ForwardPass.SHADER_SOURCES[i],
    write: (src) => { ForwardPass.SHADER_SOURCES[i] = src; },
    probe: probe(() => new ForwardPass()),
    usedBy: inEveryMode,
  });
  const shaderSlots: Record<string, ShaderSlot> = {
    cull: {
      read: () => CullPass.SHADER_SOURCE,
      write: (src) => { CullPass.SHADER_SOURCE = src; },
      prepare: (src) => prepareShaderSource(src, useSubgroups, useSubgroups && subgroupSupport.hasSubgroupId),
      probe: probe(() => new CullPass()),
      usedBy: inEveryMode,
    },
    basic: forwardSlot(0),
    quad: forwardSlot(0),
    line: forwardSlot(1),
    'msdf-text': forwardSlot(2),
    bezier: forwardSlot(3),
    gradient: forwardSlot(4),
    'box-shadow': forwardSlot(5),
    scatter: {
      read: () => ScatterPass.SHADER_SOURCE,
      write: (src) => { ScatterPass.SHADER_SOURCE = src; },
      probe: probe(() => new ScatterPass()),
      usedBy: inEveryMode,
    },
    'radix-sort': {
      read: () => RadixSortPass.SHADER_SOURCE,
      write: (src) => { RadixSortPass.SHADER_SOURCE = src; },
      probe: probe(() => new RadixSortPass()),
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
      void requests.reloadShader(passName, shaderCode);
    },

    render(state: GPURenderState, camera: { viewProjection: Float32Array }, dt?: number) {
      if (state.entityCount === 0) return;

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
      } else {
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

      // Upload selection mask if dirty
      if (requests.requested.mode.outlines || host.mode.outlines) {
        selectionManager.uploadMask(device, selectionMaskBuffer);
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

        // Recreate the live graph's JFA / bloom textures on resize. A pending
        // graph catches up when it goes live (onSwap).
        prepareMode(host.mode, jfaPasses.length);

        // Pass cost is roughly proportional to pixel count, so samples taken at
        // the old resolution must not be averaged with the new ones.
        if (gpuProfilingEnabled) gpuProfiler?.reset();
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
      };

      host.graph.render(device, frameState, resources);

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
      return gpuProfiler?.timings() ?? [];
    },

    destroy() {
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
    import.meta.hot.accept('./shaders/basic.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('basic', mod.default);
    });
    import.meta.hot.accept('./shaders/line.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('line', mod.default);
    });
    import.meta.hot.accept('./shaders/msdf-text.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('msdf-text', mod.default);
    });
    import.meta.hot.accept('./shaders/gradient.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('gradient', mod.default);
    });
    import.meta.hot.accept('./shaders/box-shadow.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('box-shadow', mod.default);
    });
    import.meta.hot.accept('./shaders/bezier.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('bezier', mod.default);
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
    import.meta.hot.accept('./shaders/radix-sort.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('radix-sort', mod.default);
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
