/// <reference lib="webworker" />

/**
 * Render Worker (Mode A only).
 * Receives an OffscreenCanvas and renders entities using WebGPU
 * with a GPU-driven pipeline (compute culling + indirect draw).
 * Render state arrives from the ECS Worker via a MessageChannel port.
 */

import { Camera } from "./camera";
import shaderCode from "./shaders/basic.wgsl?raw";
import cullShaderCode from "./shaders/cull.wgsl?raw";

const MAX_ENTITIES = 100_000;
const FLOATS_PER_GPU_ENTITY = 20;  // mat4x4 (16) + vec4 boundingSphere (4)
const BYTES_PER_GPU_ENTITY = FLOATS_PER_GPU_ENTITY * 4;  // 80 bytes
const INDIRECT_BUFFER_SIZE = 20;  // 5 x u32
const CULL_UNIFORM_SIZE = 6 * 16 + 16;  // 6 frustum planes (96 bytes) + u32 totalEntities + padding = 112 bytes

const QUAD_VERTICES = new Float32Array([
  -0.5, -0.5, 0.0,
   0.5, -0.5, 0.0,
   0.5,  0.5, 0.0,
  -0.5,  0.5, 0.0,
]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

let device: GPUDevice;
let context: GPUCanvasContext;

// Render pipeline
let renderPipeline: GPURenderPipeline;
let renderBindGroup: GPUBindGroup;

// Compute pipeline (culling)
let cullPipeline: GPUComputePipeline;
let cullBindGroup: GPUBindGroup;

// GPU buffers
let vertexBuffer: GPUBuffer;
let indexBuffer: GPUBuffer;
let cameraBuffer: GPUBuffer;
let entityBuffer: GPUBuffer;
let visibleIndicesBuffer: GPUBuffer;
let indirectBuffer: GPUBuffer;
let cullUniformBuffer: GPUBuffer;
let depthTexture: GPUTexture;

let canvasWidth: number;
let canvasHeight: number;
const camera = new Camera();
let currentEntityCount = 0;

interface RenderState {
  entityCount: number;
  entityData: ArrayBuffer;
}

let latestRenderState: RenderState | null = null;

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  if (msg.type === "init") {
    try {
      canvasWidth = msg.width;
      canvasHeight = msg.height;
      await initWebGPU(msg.canvas);

      msg.ecsPort.onmessage = (e: MessageEvent) => {
        if (e.data.renderState) {
          latestRenderState = e.data.renderState;
        }
      };

      renderLoop();
      self.postMessage({ type: "ready" });
    } catch (e) {
      self.postMessage({ type: "error", error: String(e) });
    }
  } else if (msg.type === "resize") {
    canvasWidth = msg.width;
    canvasHeight = msg.height;
    if (device && depthTexture) {
      depthTexture.destroy();
      depthTexture = createDepthTexture(device, canvasWidth, canvasHeight);
      const aspect = canvasWidth / canvasHeight;
      camera.setOrthographic(20 * aspect, 20, 0.1, 1000);
    }
  }
};

async function initWebGPU(canvas: OffscreenCanvas): Promise<void> {
  if (!navigator.gpu) throw new Error("WebGPU not available in Render Worker");

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No GPU adapter in Render Worker");

  device = await adapter.requestDevice();
  context = canvas.getContext("webgpu") as GPUCanvasContext;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  // --- Vertex + Index Buffers ---
  vertexBuffer = device.createBuffer({
    size: QUAD_VERTICES.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, QUAD_VERTICES);

  indexBuffer = device.createBuffer({
    size: QUAD_INDICES.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, QUAD_INDICES);

  // --- Camera Uniform ---
  cameraBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // --- Entity Data Storage Buffer (all active entities) ---
  entityBuffer = device.createBuffer({
    size: MAX_ENTITIES * BYTES_PER_GPU_ENTITY,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // --- Visible Indices Storage Buffer ---
  visibleIndicesBuffer = device.createBuffer({
    size: MAX_ENTITIES * 4,  // u32 per entity
    usage: GPUBufferUsage.STORAGE,
  });

  // --- Indirect Draw Args Buffer ---
  indirectBuffer = device.createBuffer({
    size: INDIRECT_BUFFER_SIZE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  });

  // --- Cull Uniforms ---
  cullUniformBuffer = device.createBuffer({
    size: CULL_UNIFORM_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // --- Depth Texture ---
  depthTexture = createDepthTexture(device, canvasWidth, canvasHeight);

  // --- Compute Pipeline (Culling) ---
  const cullModule = device.createShaderModule({ code: cullShaderCode });
  const cullBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ],
  });
  cullPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [cullBindGroupLayout] }),
    compute: { module: cullModule, entryPoint: "cull_main" },
  });
  cullBindGroup = device.createBindGroup({
    layout: cullBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cullUniformBuffer } },
      { binding: 1, resource: { buffer: entityBuffer } },
      { binding: 2, resource: { buffer: visibleIndicesBuffer } },
      { binding: 3, resource: { buffer: indirectBuffer } },
    ],
  });

  // --- Render Pipeline ---
  const renderModule = device.createShaderModule({ code: shaderCode });
  const renderBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });
  renderPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [renderBindGroupLayout] }),
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
  renderBindGroup = device.createBindGroup({
    layout: renderBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 1, resource: { buffer: entityBuffer } },
      { binding: 2, resource: { buffer: visibleIndicesBuffer } },
    ],
  });

  const aspect = canvasWidth / canvasHeight;
  camera.setOrthographic(20 * aspect, 20, 0.1, 1000);
}

function createDepthTexture(dev: GPUDevice, width: number, height: number): GPUTexture {
  return dev.createTexture({
    size: { width, height },
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
}

function renderLoop(): void {
  function renderFrame() {
    if (latestRenderState && latestRenderState.entityCount > 0) {
      const entityData = new Float32Array(latestRenderState.entityData);
      currentEntityCount = latestRenderState.entityCount;

      // 1. Upload entity data (all active entities)
      device.queue.writeBuffer(
        entityBuffer, 0,
        entityData as Float32Array<ArrayBuffer>, 0,
        currentEntityCount * FLOATS_PER_GPU_ENTITY,
      );

      // 2. Upload camera uniform
      device.queue.writeBuffer(
        cameraBuffer, 0,
        camera.viewProjection as Float32Array<ArrayBuffer>,
      );

      // 3. Upload cull uniforms (frustum planes + entity count)
      const cullData = new ArrayBuffer(CULL_UNIFORM_SIZE);
      const cullFloats = new Float32Array(cullData, 0, 24);  // 6 planes x 4 floats
      const frustumPlanes = extractFrustumPlanesInternal(camera.viewProjection);
      cullFloats.set(frustumPlanes);
      const cullUints = new Uint32Array(cullData, 96, 4);  // offset 96 = after 24 floats
      cullUints[0] = currentEntityCount;
      device.queue.writeBuffer(cullUniformBuffer, 0, cullData);

      // 4. Reset indirect draw args: indexCount=6, instanceCount=0, rest=0
      const resetArgs = new Uint32Array([6, 0, 0, 0, 0]);
      device.queue.writeBuffer(indirectBuffer, 0, resetArgs);

      // 5. Encode command buffer
      const encoder = device.createCommandEncoder();

      // 5a. Compute pass: frustum culling
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(cullPipeline);
      computePass.setBindGroup(0, cullBindGroup);
      computePass.dispatchWorkgroups(Math.ceil(currentEntityCount / 256));
      computePass.end();

      // 5b. Render pass: indirect draw
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
      renderPass.setBindGroup(0, renderBindGroup);
      renderPass.drawIndexedIndirect(indirectBuffer, 0);
      renderPass.end();

      device.queue.submit([encoder.finish()]);
    } else {
      // No entities: just clear the screen
      device.queue.writeBuffer(
        cameraBuffer, 0,
        camera.viewProjection as Float32Array<ArrayBuffer>,
      );

      const encoder = device.createCommandEncoder();
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
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
      renderPass.end();
      device.queue.submit([encoder.finish()]);
    }

    requestAnimationFrame(renderFrame);
  }

  requestAnimationFrame(renderFrame);
}

/**
 * Internal frustum extraction (same algorithm as camera.ts export,
 * duplicated here to avoid circular dependency in render-worker).
 */
function extractFrustumPlanesInternal(vp: Float32Array): Float32Array {
  const planes = new Float32Array(24);
  const m = vp;

  // Left
  planes[0]  = m[3]  + m[0];  planes[1]  = m[7]  + m[4];
  planes[2]  = m[11] + m[8];  planes[3]  = m[15] + m[12];
  // Right
  planes[4]  = m[3]  - m[0];  planes[5]  = m[7]  - m[4];
  planes[6]  = m[11] - m[8];  planes[7]  = m[15] - m[12];
  // Bottom
  planes[8]  = m[3]  + m[1];  planes[9]  = m[7]  + m[5];
  planes[10] = m[11] + m[9];  planes[11] = m[15] + m[13];
  // Top
  planes[12] = m[3]  - m[1];  planes[13] = m[7]  - m[5];
  planes[14] = m[11] - m[9];  planes[15] = m[15] - m[13];
  // Near (WebGPU depth [0,1])
  planes[16] = m[2];  planes[17] = m[6];
  planes[18] = m[10]; planes[19] = m[14];
  // Far
  planes[20] = m[3]  - m[2];  planes[21] = m[7]  - m[6];
  planes[22] = m[11] - m[10]; planes[23] = m[15] - m[14];

  // Normalize each plane
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
