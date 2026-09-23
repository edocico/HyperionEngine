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
import { detectCompressedFormat, detectSubgroupSupport } from './capabilities';
import { ParticleSystem } from './particle-system';
import type { FrameState, RenderPass } from './render/render-pass';
import {
  assembleRenderGraph, ExternalPasses, type GraphMode, type GraphPassFactories,
} from './render/graph-assembly';
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
   * Validated immediately: a pass that makes the graph uncompilable (a
   * duplicate name, a second blind writer of a resource) throws here and is
   * not added. Only against the CURRENT mode, though: a name or blind write
   * that clashes with another mode's passes ('bloom', 'jfa-N', ...) makes
   * switching to that mode throw — the renderer then keeps its current graph.
   * Every add runs `setup()`, so re-adding a removed pass without destroying
   * it first allocates twice. To draw on top of the graph's output, declare 'swapchain' in
   * both `reads` and `writes`. GPU particles are composited after the whole
   * graph, so they still draw over overlays.
   */
  addPass(pass: RenderPass): void;
  /**
   * Detach a pass added with {@link addPass}, WITHOUT destroying it — its
   * owner does that. Names of the renderer's own passes are ignored.
   */
  removePass(name: string): void;
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

  // Detect compression support from adapter
  const compressedFormat = detectCompressedFormat(adapter.features);

  // Detect subgroup support from adapter
  const subgroupSupport = detectSubgroupSupport(adapter.features);

  // Request device with compression + subgroups features if available
  const requiredFeatures: GPUFeatureName[] = [];
  if (compressedFormat === 'bc7-rgba-unorm') requiredFeatures.push('texture-compression-bc');
  else if (compressedFormat === 'astc-4x4-unorm') requiredFeatures.push('texture-compression-astc');
  if (subgroupSupport.supported) requiredFeatures.push('subgroups' as GPUFeatureName);

  // GPU timing. Optional everywhere: absent on some mobile drivers, and the
  // device request must still succeed without it. Chrome quantizes the
  // timestamps it returns to 100us unless started with
  // --enable-webgpu-developer-features — see render/gpu-profiler.ts.
  if (adapter.features.has('timestamp-query')) requiredFeatures.push('timestamp-query');

  let device: GPUDevice;
  let useSubgroups = subgroupSupport.supported;
  try {
    device = await adapter.requestDevice({
      requiredFeatures: requiredFeatures.length > 0 ? requiredFeatures : undefined,
    });
  } catch {
    // Feature request failed — retry with only the texture-compression
    // features, which are the ones the asset pipeline actually depends on.
    useSubgroups = false;
    const fallbackFeatures = requiredFeatures.filter(
      f => f !== ('subgroups' as GPUFeatureName) && f !== 'timestamp-query',
    );
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
  // Once built it is re-attached on every applyGraph(), so its rolling
  // averages survive outline/bloom toggles and shader hot-reloads.
  let gpuProfiler: GpuProfiler | null = null;
  let gpuProfilingEnabled = false;

  // --- 7b. Create GPU particle system (standalone, outside RenderGraph) ---
  let currentParticleSimSrc = particleSimulateCode;
  let currentParticleRenderSrc = particleRenderCode;
  const particleSystem = new ParticleSystem(device);
  particleSystem.setupPipelines(currentParticleSimSrc, currentParticleRenderSrc, format);

  // --- 8a. Bloom state ---
  let bloomActive = false;
  let bloomHalfTexture: GPUTexture | null = null;
  let bloomQuarterTexture: GPUTexture | null = null;
  let bloomEighthTexture: GPUTexture | null = null;
  let bloomTexWidth = 0;
  let bloomTexHeight = 0;
  let currentBloomConfig: BloomConfig | undefined;

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
  let outlinesActive = false;
  let outlineCompositePass: OutlineCompositePass | null = null;
  let jfaPasses: JFAPass[] = [];
  let jfaTextureA: GPUTexture | null = null;
  let jfaTextureB: GPUTexture | null = null;
  let jfaTexWidth = 0;
  let jfaTexHeight = 0;

  /**
   * Create or recreate the JFA ping-pong textures to match the canvas size.
   */
  function ensureJFATextures(width: number, height: number): void {
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

  // --- 8c. RenderGraph assembly ---
  // Caller-owned passes (plugin overlays): set up here once — only the
  // renderer holds the ResourcePool — carried over every rebuild, and never
  // destroyed by the renderer. See ExternalPasses in graph-assembly.ts.
  const externalPasses = new ExternalPasses((pass) => pass.setup(device, resources));

  /** What one assembly built. Committed to the renderer only once it compiles. */
  interface BuiltPasses {
    scatter: ScatterPass | null;
    jfa: JFAPass[];
    outlineComposite: OutlineCompositePass | null;
  }

  /** The passes one graph is made of, set up against this device. */
  function passFactories(
    built: BuiltPasses,
    outlineOptions?: OutlineOptions,
    bloomConfig?: BloomConfig,
  ): GraphPassFactories {
    return {
      scene() {
        built.scatter = new ScatterPass();
        built.scatter.setup(device, resources);
        const cull = new CullPass();
        cull.setup(device, resources);
        const radixSort = new RadixSortPass();
        radixSort.setup(device, resources);
        const forward = new ForwardPass();
        forward.setup(device, resources);
        return [built.scatter, cull, radixSort, forward];
      },

      outline() {
        const maxDim = Math.max(canvas.width, canvas.height);
        const numIterations = JFAPass.iterationsForDimension(maxDim);
        ensureJFATextures(canvas.width, canvas.height);
        updateJFATextureViews(numIterations);

        const selectionSeed = new SelectionSeedPass();
        selectionSeed.setup(device, resources);
        for (let i = 0; i < numIterations; i++) {
          const jfaPass = new JFAPass(i, numIterations, maxDim);
          jfaPass.setup(device, resources);
          built.jfa.push(jfaPass);
        }
        built.outlineComposite = new OutlineCompositePass(JFAPass.finalOutputResource(numIterations));
        if (outlineOptions) {
          built.outlineComposite.outlineColor = outlineOptions.color;
          built.outlineComposite.outlineWidth = outlineOptions.width;
        }
        built.outlineComposite.setup(device, resources);
        return [selectionSeed, ...built.jfa, built.outlineComposite];
      },

      bloom() {
        ensureBloomTextures(canvas.width, canvas.height);
        const bloomPass = new BloomPass(bloomConfig);
        bloomPass.setup(device, resources);
        return bloomPass;
      },

      fxaaTonemap() {
        const fxaaPass = new FXAATonemapPass();
        fxaaPass.setup(device, resources);
        return fxaaPass;
      },
    };
  }

  /** Replaced by the first applyGraph() below; destroyed by it as `previous`. */
  let graph = new RenderGraph();

  /**
   * Build the graph for `mode` and, only once it compiles, make it current.
   * The graph, the pass references render() uses and the mode flags change
   * together or not at all: on failure the previous graph stays current and
   * the error propagates to the enable/disable call that asked for it.
   *
   * Bloom and outlines are mutually exclusive: each is the graph's single
   * final composite onto the swapchain, replacing FXAATonemapPass.
   */
  function applyGraph(mode: GraphMode, outlineOptions?: OutlineOptions, bloomConfig?: BloomConfig): void {
    const built: BuiltPasses = {
      scatter: null, jfa: [], outlineComposite: null,
    };
    graph = assembleRenderGraph(
      mode, passFactories(built, outlineOptions, bloomConfig), externalPasses.values(), graph,
    );

    scatterPass = built.scatter;
    jfaPasses = built.jfa;
    outlineCompositePass = built.outlineComposite;
    outlinesActive = mode.outlines;
    bloomActive = mode.bloom && !mode.outlines;
    currentBloomConfig = bloomActive ? bloomConfig : undefined;

    // The graph object is new; re-attach the profiler and drop the history,
    // which measured a different set of passes.
    if (gpuProfilingEnabled && gpuProfiler) {
      graph.setProfiler(gpuProfiler);
      gpuProfiler.reset();
    }
  }

  function currentOutlineOptions(): OutlineOptions | undefined {
    return outlineCompositePass
      ? { color: outlineCompositePass.outlineColor, width: outlineCompositePass.outlineWidth }
      : undefined;
  }

  applyGraph({ outlines: false, bloom: false });

  // --- 9. Build the Renderer object ---
  const rendererObj: Renderer = {
    textureManager,
    selectionManager,
    particleSystem,

    get graph() { return graph; },
    get device() { return device; },

    addPass(pass: RenderPass): void {
      externalPasses.add(graph, pass);
    },

    removePass(name: string): void {
      externalPasses.remove(graph, name);
    },

    get outlinesEnabled(): boolean {
      return outlinesActive;
    },

    enableOutlines(options: OutlineOptions): void {
      if (outlinesActive && outlineCompositePass) {
        // Just update parameters without rebuilding
        outlineCompositePass.outlineColor = options.color;
        outlineCompositePass.outlineWidth = options.width;
        return;
      }
      const hadBloom = bloomActive;
      applyGraph({ outlines: true, bloom: false }, options);
      if (hadBloom) {
        console.warn('[Hyperion] Bloom and outlines are mutually exclusive. Disabled bloom.');
      }
    },

    disableOutlines(): void {
      if (!outlinesActive) return;
      applyGraph({ outlines: false, bloom: false });
    },

    get bloomEnabled(): boolean {
      return bloomActive;
    },

    enableBloom(config?: BloomConfig): void {
      // Also the path for a new config while bloom is already on.
      const hadOutlines = outlinesActive;
      applyGraph({ outlines: false, bloom: true }, undefined, config);
      if (hadOutlines) {
        console.warn('[Hyperion] Bloom and outlines are mutually exclusive. Disabled outlines.');
      }
    },

    disableBloom(): void {
      if (!bloomActive) return;
      applyGraph({ outlines: false, bloom: false });
    },

    recompileShader(passName: string, shaderCode: string): void {
      switch (passName) {
        case 'cull':
          CullPass.SHADER_SOURCE = prepareShaderSource(
            shaderCode,
            useSubgroups,
            useSubgroups && subgroupSupport.hasSubgroupId,
          );
          break;
        case 'basic': case 'quad':
          ForwardPass.SHADER_SOURCES[0] = shaderCode;
          break;
        case 'line':
          ForwardPass.SHADER_SOURCES[1] = shaderCode;
          break;
        case 'msdf-text':
          ForwardPass.SHADER_SOURCES[2] = shaderCode;
          break;
        case 'bezier':
          ForwardPass.SHADER_SOURCES[3] = shaderCode;
          break;
        case 'gradient':
          ForwardPass.SHADER_SOURCES[4] = shaderCode;
          break;
        case 'box-shadow':
          ForwardPass.SHADER_SOURCES[5] = shaderCode;
          break;
        case 'fxaa-tonemap':
          FXAATonemapPass.SHADER_SOURCE = shaderCode;
          break;
        case 'debug-line':
          LineBatchPass.SHADER_SOURCE = shaderCode;
          // No renderer-owned pass uses it, so there is nothing to rebuild.
          // Overlays are caller-owned and set up once when added: an
          // installed one keeps its pipeline until its plugin is reinstalled.
          console.log(`[Hyperion] Shader "${passName}" updated — applies to overlays added from now on`);
          return;
        case 'selection-seed':
          SelectionSeedPass.SHADER_SOURCE = shaderCode;
          break;
        case 'jfa':
          JFAPass.SHADER_SOURCE = shaderCode;
          break;
        case 'outline-composite':
          OutlineCompositePass.SHADER_SOURCE = shaderCode;
          break;
        case 'bloom':
          BloomPass.SHADER_SOURCE = shaderCode;
          break;
        case 'scatter':
          ScatterPass.SHADER_SOURCE = shaderCode;
          break;
        case 'radix-sort':
          RadixSortPass.SHADER_SOURCE = shaderCode;
          break;
        case 'particle-simulate':
          currentParticleSimSrc = shaderCode;
          particleSystem.setupPipelines(currentParticleSimSrc, currentParticleRenderSrc, format);
          console.log(`[Hyperion] Shader "${passName}" hot-reloaded`);
          return;
        case 'particle-render':
          currentParticleRenderSrc = shaderCode;
          particleSystem.setupPipelines(currentParticleSimSrc, currentParticleRenderSrc, format);
          console.log(`[Hyperion] Shader "${passName}" hot-reloaded`);
          return;
        default:
          console.warn(`[Hyperion] Unknown shader pass: ${passName}`);
          return;
      }
      applyGraph({ outlines: outlinesActive, bloom: bloomActive }, currentOutlineOptions(), currentBloomConfig);
      console.log(`[Hyperion] Shader "${passName}" hot-reloaded`);
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
      if (outlinesActive) {
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

        // Recreate JFA textures on resize
        if (outlinesActive) {
          ensureJFATextures(canvas.width, canvas.height);
          updateJFATextureViews(jfaPasses.length);
        }

        // Recreate bloom textures on resize
        if (bloomActive) {
          ensureBloomTextures(canvas.width, canvas.height);
        }

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
        dirtyBits: state.dirtyBits ?? undefined,
        physicsDebugLines: state.physicsDebugLines ?? undefined,
      };

      graph.render(device, frameState, resources);

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
      graph.setProfiler(gpuProfiler);
      gpuProfiler.reset();
      return true;
    },

    disableGpuProfiling() {
      gpuProfilingEnabled = false;
      graph.setProfiler(null);
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
      externalPasses.detachAll(graph); // caller-owned: their owners destroy them
      graph.destroy();
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
