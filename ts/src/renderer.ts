import shaderCode from './shaders/basic.wgsl?raw';
import cullShaderCode from './shaders/cull.wgsl?raw';
import { TextureManager } from './texture-manager';

const MAX_ENTITIES = 100_000;
const FLOATS_PER_GPU_ENTITY = 20;
const BYTES_PER_GPU_ENTITY = FLOATS_PER_GPU_ENTITY * 4;
const INDIRECT_BUFFER_SIZE = 20;

export interface Renderer {
  render(
    entityData: Float32Array,
    entityCount: number,
    camera: { viewProjection: Float32Array },
    texIndices?: Uint32Array,
  ): void;
  readonly textureManager: TextureManager;
  destroy(): void;
}

export async function createRenderer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
): Promise<Renderer> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();

  const context = canvas instanceof HTMLCanvasElement
    ? canvas.getContext("webgpu")!
    : (canvas as OffscreenCanvas).getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  // --- TextureManager ---
  const textureManager = new TextureManager(device);

  // --- Vertex + Index Buffers ---
  const vertices = new Float32Array([
    -0.5, -0.5, 0.0,
     0.5, -0.5, 0.0,
     0.5,  0.5, 0.0,
    -0.5,  0.5, 0.0,
  ]);
  const vertexBuffer = device.createBuffer({
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertices);

  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const indexBuffer = device.createBuffer({
    size: indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, indices);

  // --- Camera Uniform ---
  const cameraBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // --- Entity Data Storage Buffer ---
  const entityBuffer = device.createBuffer({
    size: MAX_ENTITIES * BYTES_PER_GPU_ENTITY,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // --- Visible Indices Storage Buffer ---
  const visibleIndicesBuffer = device.createBuffer({
    size: MAX_ENTITIES * 4,
    usage: GPUBufferUsage.STORAGE,
  });

  // --- Indirect Draw Args Buffer ---
  const indirectBuffer = device.createBuffer({
    size: INDIRECT_BUFFER_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  });

  // --- Cull Uniforms ---
  // 6 frustum planes (96 bytes) + u32 entityCount + padding (16 bytes) = 112 bytes
  const CULL_UNIFORM_SIZE = 6 * 16 + 16;
  const cullUniformBuffer = device.createBuffer({
    size: CULL_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // --- Texture Layer Indices Storage Buffer ---
  const texIndexBuffer = device.createBuffer({
    size: MAX_ENTITIES * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // --- Depth Texture ---
  let depthTexture = createDepthTexture(device, canvas.width, canvas.height);

  // --- Compute Pipeline (Culling, unchanged) ---
  const cullModule = device.createShaderModule({ code: cullShaderCode });
  const cullBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ],
  });
  const cullPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [cullBindGroupLayout] }),
    compute: { module: cullModule, entryPoint: "cull_main" },
  });
  const cullBindGroup = device.createBindGroup({
    layout: cullBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cullUniformBuffer } },
      { binding: 1, resource: { buffer: entityBuffer } },
      { binding: 2, resource: { buffer: visibleIndicesBuffer } },
      { binding: 3, resource: { buffer: indirectBuffer } },
    ],
  });

  // --- Render Pipeline (two bind groups) ---
  const renderModule = device.createShaderModule({ code: shaderCode });

  // Group 0: vertex-stage data
  const renderBindGroupLayout0 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });

  // Group 1: fragment-stage textures
  const renderBindGroupLayout1 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });

  const renderPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [renderBindGroupLayout0, renderBindGroupLayout1],
    }),
    vertex: {
      module: renderModule,
      entryPoint: "vs_main",
      buffers: [{
        arrayStride: 12,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }],
      }],
    },
    fragment: {
      module: renderModule,
      entryPoint: "fs_main",
      targets: [{ format }],
    },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
    primitive: { topology: "triangle-list", cullMode: "back" },
  });

  const renderBindGroup0 = device.createBindGroup({
    layout: renderBindGroupLayout0,
    entries: [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 1, resource: { buffer: entityBuffer } },
      { binding: 2, resource: { buffer: visibleIndicesBuffer } },
      { binding: 3, resource: { buffer: texIndexBuffer } },
    ],
  });

  const renderBindGroup1 = device.createBindGroup({
    layout: renderBindGroupLayout1,
    entries: [
      { binding: 0, resource: textureManager.getTierView(0) },
      { binding: 1, resource: textureManager.getTierView(1) },
      { binding: 2, resource: textureManager.getTierView(2) },
      { binding: 3, resource: textureManager.getTierView(3) },
      { binding: 4, resource: textureManager.getSampler() },
    ],
  });

  // Reusable zero-filled fallback for texture indices when none are provided
  const defaultTexIndices = new Uint32Array(MAX_ENTITIES);

  return {
    textureManager,

    render(entityData, entityCount, camera, texIndices) {
      if (entityCount === 0) return;

      // 1. Upload entity data
      device.queue.writeBuffer(
        entityBuffer, 0,
        entityData as Float32Array<ArrayBuffer>, 0,
        entityCount * FLOATS_PER_GPU_ENTITY,
      );

      // 2. Upload texture layer indices
      const texIdx = texIndices ?? defaultTexIndices;
      device.queue.writeBuffer(
        texIndexBuffer, 0,
        texIdx as Uint32Array<ArrayBuffer>, 0,
        entityCount,
      );

      // 3. Upload camera uniform
      device.queue.writeBuffer(cameraBuffer, 0, camera.viewProjection as Float32Array<ArrayBuffer>);

      // 4. Upload cull uniforms
      const cullData = new ArrayBuffer(CULL_UNIFORM_SIZE);
      const cullFloats = new Float32Array(cullData, 0, 24);
      const frustumPlanes = extractFrustumPlanesInternal(camera.viewProjection);
      cullFloats.set(frustumPlanes);
      const cullUints = new Uint32Array(cullData, 96, 4);
      cullUints[0] = entityCount;
      device.queue.writeBuffer(cullUniformBuffer, 0, cullData);

      // 5. Reset indirect draw args
      const resetArgs = new Uint32Array([6, 0, 0, 0, 0]);
      device.queue.writeBuffer(indirectBuffer, 0, resetArgs);

      // 6. Encode command buffer
      const encoder = device.createCommandEncoder();

      // 6a. Compute pass: frustum culling
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(cullPipeline);
      computePass.setBindGroup(0, cullBindGroup);
      computePass.dispatchWorkgroups(Math.ceil(entityCount / 256));
      computePass.end();

      // 6b. Render pass: indirect draw
      const textureView = context.getCurrentTexture().createView();
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: textureView,
          loadOp: "clear" as GPULoadOp,
          storeOp: "store" as GPUStoreOp,
          clearValue: { r: 0.067, g: 0.067, b: 0.067, a: 1 },
        }],
        depthStencilAttachment: {
          view: depthTexture.createView(),
          depthLoadOp: "clear" as GPULoadOp,
          depthStoreOp: "store" as GPUStoreOp,
          depthClearValue: 1.0,
        },
      });
      renderPass.setPipeline(renderPipeline);
      renderPass.setVertexBuffer(0, vertexBuffer);
      renderPass.setIndexBuffer(indexBuffer, "uint16");
      renderPass.setBindGroup(0, renderBindGroup0);
      renderPass.setBindGroup(1, renderBindGroup1);
      renderPass.drawIndexedIndirect(indirectBuffer, 0);
      renderPass.end();

      device.queue.submit([encoder.finish()]);
    },

    destroy() {
      vertexBuffer.destroy();
      indexBuffer.destroy();
      cameraBuffer.destroy();
      entityBuffer.destroy();
      visibleIndicesBuffer.destroy();
      indirectBuffer.destroy();
      cullUniformBuffer.destroy();
      texIndexBuffer.destroy();
      textureManager.destroy();
      depthTexture.destroy();
      device.destroy();
    },
  };
}

function createDepthTexture(device: GPUDevice, width: number, height: number): GPUTexture {
  return device.createTexture({
    size: { width, height },
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
}

function extractFrustumPlanesInternal(vp: Float32Array): Float32Array {
  const planes = new Float32Array(24);
  const m = vp;

  planes[0]  = m[3]  + m[0];  planes[1]  = m[7]  + m[4];
  planes[2]  = m[11] + m[8];  planes[3]  = m[15] + m[12];
  planes[4]  = m[3]  - m[0];  planes[5]  = m[7]  - m[4];
  planes[6]  = m[11] - m[8];  planes[7]  = m[15] - m[12];
  planes[8]  = m[3]  + m[1];  planes[9]  = m[7]  + m[5];
  planes[10] = m[11] + m[9];  planes[11] = m[15] + m[13];
  planes[12] = m[3]  - m[1];  planes[13] = m[7]  - m[5];
  planes[14] = m[11] - m[9];  planes[15] = m[15] - m[13];
  planes[16] = m[2];  planes[17] = m[6];
  planes[18] = m[10]; planes[19] = m[14];
  planes[20] = m[3]  - m[2];  planes[21] = m[7]  - m[6];
  planes[22] = m[11] - m[10]; planes[23] = m[15] - m[14];

  for (let i = 0; i < 6; i++) {
    const o = i * 4;
    const len = Math.sqrt(planes[o] ** 2 + planes[o + 1] ** 2 + planes[o + 2] ** 2);
    if (len > 0) {
      planes[o] /= len; planes[o + 1] /= len;
      planes[o + 2] /= len; planes[o + 3] /= len;
    }
  }

  return planes;
}
