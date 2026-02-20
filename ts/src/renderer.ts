import shaderCode from './shaders/basic.wgsl?raw';
import lineShaderCode from './shaders/line.wgsl?raw';
import msdfShaderCode from './shaders/msdf-text.wgsl?raw';
import gradientShaderCode from './shaders/gradient.wgsl?raw';
import boxShadowShaderCode from './shaders/box-shadow.wgsl?raw';
import cullShaderCode from './shaders/cull.wgsl?raw';
import fxaaShaderCode from './shaders/fxaa-tonemap.wgsl?raw';
import { TextureManager } from './texture-manager';
import { RenderGraph } from './render/render-graph';
import { ResourcePool } from './render/resource-pool';
import { CullPass } from './render/passes/cull-pass';
import { ForwardPass } from './render/passes/forward-pass';
import { FXAATonemapPass } from './render/passes/fxaa-tonemap-pass';
import type { FrameState } from './render/render-pass';
import type { GPURenderState } from './worker-bridge';

const MAX_ENTITIES = 100_000;
const NUM_PRIM_TYPES = 6;
const INDIRECT_BUFFER_SIZE = NUM_PRIM_TYPES * 5 * 4;  // 6 × 5 u32 × 4 bytes = 120 bytes

export interface Renderer {
  render(
    state: GPURenderState,
    camera: { viewProjection: Float32Array },
  ): void;
  readonly textureManager: TextureManager;
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

  // --- 2. Create TextureManager ---
  const textureManager = new TextureManager(device);

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
    size: NUM_PRIM_TYPES * MAX_ENTITIES * 4,  // 6 regions × 100k × u32
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

  // --- 6. Set shader sources and setup passes ---
  CullPass.SHADER_SOURCE = cullShaderCode;
  ForwardPass.SHADER_SOURCES = {
    0: shaderCode,              // Quad
    1: lineShaderCode,          // Line
    2: msdfShaderCode,          // SDFGlyph (MSDF text)
    4: gradientShaderCode,      // Gradient
    5: boxShadowShaderCode,     // BoxShadow
  };
  FXAATonemapPass.SHADER_SOURCE = fxaaShaderCode;

  const cullPass = new CullPass();
  const forwardPass = new ForwardPass();
  const fxaaPass = new FXAATonemapPass();
  cullPass.setup(device, resources);
  forwardPass.setup(device, resources);
  fxaaPass.setup(device, resources);

  // --- 7. Build the RenderGraph ---
  const graph = new RenderGraph();
  graph.addPass(cullPass);
  graph.addPass(forwardPass);
  graph.addPass(fxaaPass);
  graph.compile();

  // --- 8. Return the Renderer object ---
  return {
    textureManager,

    render(state: GPURenderState, camera: { viewProjection: Float32Array }) {
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
        deltaTime: 0,
      };

      graph.render(device, frameState, resources);
    },

    destroy() {
      sceneHdrTexture.destroy();
      graph.destroy();
      resources.destroy();
      textureManager.destroy();
      device.destroy();
    },
  };
}
