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
import outlineCompositeShaderCode from './shaders/outline-composite.wgsl?raw';
import bloomShaderCode from './shaders/bloom.wgsl?raw';
import particleSimulateCode from './shaders/particle-simulate.wgsl?raw';
import particleRenderCode from './shaders/particle-render.wgsl?raw';
import { TextureManager } from './texture-manager';
import { RenderGraph } from './render/render-graph';
import { ResourcePool } from './render/resource-pool';
import { CullPass } from './render/passes/cull-pass';
import { ForwardPass } from './render/passes/forward-pass';
import { FXAATonemapPass } from './render/passes/fxaa-tonemap-pass';
import { SelectionSeedPass } from './render/passes/selection-seed-pass';
import { JFAPass } from './render/passes/jfa-pass';
import { OutlineCompositePass } from './render/passes/outline-composite-pass';
import { BloomPass } from './render/passes/bloom-pass';
import type { BloomConfig } from './render/passes/bloom-pass';
import { SelectionManager } from './selection';
import { ParticleSystem } from './particle-system';
import type { FrameState } from './render/render-pass';
import type { GPURenderState } from './worker-bridge';

const MAX_ENTITIES = 100_000;
const NUM_PRIM_TYPES = 6;
const INDIRECT_BUFFER_SIZE = NUM_PRIM_TYPES * 5 * 4;  // 6 x 5 u32 x 4 bytes = 120 bytes

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
  enableOutlines(options: OutlineOptions): void;
  disableOutlines(): void;
  readonly outlinesEnabled: boolean;
  enableBloom(config?: BloomConfig): void;
  disableBloom(): void;
  readonly bloomEnabled: boolean;
  recompileShader(passName: string, shaderCode: string): void;
  destroy(): void;
}

export async function createRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  onDeviceLost?: (reason: string) => void,
): Promise<Renderer> {
  // --- 1. Initialize WebGPU ---
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();

  device.lost.then((info) => {
    console.error(`[Hyperion] GPU device lost: ${info.message}`);
    onDeviceLost?.(info.message);
  });

  const context = canvas instanceof HTMLCanvasElement
    ? canvas.getContext("webgpu")!
    : (canvas as OffscreenCanvas).getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  // --- 2. Create TextureManager + SelectionManager ---
  const textureManager = new TextureManager(device);
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
    size: NUM_PRIM_TYPES * MAX_ENTITIES * 4,  // 6 regions x 100k x u32
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
  resources.setSampler('texSampler', textureManager.getSampler());

  // --- 5. Create intermediate scene-hdr texture for post-processing ---
  let sceneHdrTexture = device.createTexture({
    size: { width: canvas.width, height: canvas.height },
    format: format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  resources.setTextureView('scene-hdr', sceneHdrTexture.createView());
  let sceneHdrWidth = canvas.width;
  let sceneHdrHeight = canvas.height;

  // --- 6. Set shader sources and setup base passes ---
  CullPass.SHADER_SOURCE = cullShaderCode;
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

  const cullPass = new CullPass();
  const forwardPass = new ForwardPass();
  const fxaaPass = new FXAATonemapPass();
  cullPass.setup(device, resources);
  forwardPass.setup(device, resources);
  fxaaPass.setup(device, resources);

  // --- 7. Build the RenderGraph (base pipeline, no outlines) ---
  let graph = new RenderGraph();
  graph.addPass(cullPass);
  graph.addPass(forwardPass);
  graph.addPass(fxaaPass);
  graph.compile();

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

    bloomHalfTexture = device.createTexture({
      size: { width: halfW, height: halfH },
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    bloomQuarterTexture = device.createTexture({
      size: { width: quarterW, height: quarterH },
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    bloomEighthTexture = device.createTexture({
      size: { width: eighthW, height: eighthH },
      format: 'rgba16float',
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
  let selectionSeedPass: SelectionSeedPass | null = null;
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
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    jfaTextureB = device.createTexture({
      size: { width, height },
      format: 'rgba16float',
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

  /**
   * Rebuild the render graph to include or exclude the outline/bloom pipelines.
   * Bloom and outlines are mutually exclusive (both write to swapchain,
   * dead-culling FXAATonemapPass).
   */
  function rebuildGraph(withOutlines: boolean, options?: OutlineOptions): void {
    graph.destroy();
    jfaPasses = [];
    selectionSeedPass = null;
    outlineCompositePass = null;

    // Recreate base passes
    const newCullPass = new CullPass();
    const newForwardPass = new ForwardPass();
    newCullPass.setup(device, resources);
    newForwardPass.setup(device, resources);

    graph = new RenderGraph();
    graph.addPass(newCullPass);
    graph.addPass(newForwardPass);

    if (withOutlines) {
      // Determine JFA iteration count based on canvas size
      const maxDim = Math.max(canvas.width, canvas.height);
      const numIterations = JFAPass.iterationsForDimension(maxDim);

      // Ensure JFA textures exist
      ensureJFATextures(canvas.width, canvas.height);
      updateJFATextureViews(numIterations);

      // SelectionSeedPass
      selectionSeedPass = new SelectionSeedPass();
      selectionSeedPass.setup(device, resources);
      graph.addPass(selectionSeedPass);

      // JFA iterations
      for (let i = 0; i < numIterations; i++) {
        const jfaPass = new JFAPass(i, numIterations, maxDim);
        jfaPass.setup(device, resources);
        jfaPasses.push(jfaPass);
        graph.addPass(jfaPass);
      }

      // OutlineCompositePass writes to swapchain, dead-culling FXAATonemapPass
      const jfaResultResource = JFAPass.finalOutputResource(numIterations);
      outlineCompositePass = new OutlineCompositePass(jfaResultResource);
      if (options) {
        outlineCompositePass.outlineColor = options.color;
        outlineCompositePass.outlineWidth = options.width;
      }
      outlineCompositePass.setup(device, resources);
      graph.addPass(outlineCompositePass);
    } else if (bloomActive) {
      // Bloom writes to swapchain, dead-culling FXAATonemapPass
      ensureBloomTextures(canvas.width, canvas.height);
      const bloomPass = new BloomPass(currentBloomConfig);
      bloomPass.setup(device, resources);
      graph.addPass(bloomPass);
    }

    // FXAATonemapPass is always added; when outlines or bloom are active it gets
    // dead-pass culled because OutlineCompositePass/BloomPass writes to swapchain.
    const newFxaaPass = new FXAATonemapPass();
    newFxaaPass.setup(device, resources);
    graph.addPass(newFxaaPass);

    graph.compile();
  }

  // --- 9. Build the Renderer object ---
  const rendererObj: Renderer = {
    textureManager,
    selectionManager,
    particleSystem,

    get graph() { return graph; },
    get device() { return device; },

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
      if (bloomActive) {
        console.warn('[Hyperion] Bloom and outlines are mutually exclusive. Disabling bloom.');
        bloomActive = false;
        currentBloomConfig = undefined;
      }
      outlinesActive = true;
      rebuildGraph(true, options);
    },

    disableOutlines(): void {
      if (!outlinesActive) return;
      outlinesActive = false;
      rebuildGraph(false);
    },

    get bloomEnabled(): boolean {
      return bloomActive;
    },

    enableBloom(config?: BloomConfig): void {
      currentBloomConfig = config;
      if (bloomActive) {
        // Already active — just rebuild with new config
        rebuildGraph(false);
        return;
      }
      if (outlinesActive) {
        console.warn('[Hyperion] Bloom and outlines are mutually exclusive. Disabling outlines.');
        outlinesActive = false;
      }
      bloomActive = true;
      rebuildGraph(false);
    },

    disableBloom(): void {
      if (!bloomActive) return;
      bloomActive = false;
      currentBloomConfig = undefined;
      rebuildGraph(outlinesActive, outlinesActive && outlineCompositePass ? {
        color: outlineCompositePass.outlineColor,
        width: outlineCompositePass.outlineWidth,
      } : undefined);
    },

    recompileShader(passName: string, shaderCode: string): void {
      switch (passName) {
        case 'cull':
          CullPass.SHADER_SOURCE = shaderCode;
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
      rebuildGraph(outlinesActive, outlinesActive && outlineCompositePass ? {
        color: outlineCompositePass.outlineColor,
        width: outlineCompositePass.outlineWidth,
      } : undefined);
      console.log(`[Hyperion] Shader "${passName}" hot-reloaded`);
    },

    render(state: GPURenderState, camera: { viewProjection: Float32Array }, dt?: number) {
      if (state.entityCount === 0) return;

      // Upload SoA buffers
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

      // Upload selection mask if dirty
      if (outlinesActive) {
        selectionManager.uploadMask(device, selectionMaskBuffer);
      }

      // Recreate scene-hdr texture if canvas dimensions changed
      if (canvas.width !== sceneHdrWidth || canvas.height !== sceneHdrHeight) {
        sceneHdrTexture.destroy();
        sceneHdrTexture = device.createTexture({
          size: { width: canvas.width, height: canvas.height },
          format: format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
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

    destroy() {
      particleSystem.destroy();
      sceneHdrTexture.destroy();
      jfaTextureA?.destroy();
      jfaTextureB?.destroy();
      bloomHalfTexture?.destroy();
      bloomQuarterTexture?.destroy();
      bloomEighthTexture?.destroy();
      selectionManager.destroy();
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
    import.meta.hot.accept('./shaders/particle-simulate.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('particle-simulate', mod.default);
    });
    import.meta.hot.accept('./shaders/particle-render.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('particle-render', mod.default);
    });
  }

  return rendererObj;
}
