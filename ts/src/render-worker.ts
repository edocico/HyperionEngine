/// <reference lib="webworker" />

/**
 * Render Worker (Mode A only).
 * Receives an OffscreenCanvas and renders entities using WebGPU.
 * Render state arrives from the ECS Worker via a MessageChannel port.
 */

import { Camera } from "./camera";
import shaderCode from "./shaders/basic.wgsl?raw";

const MAX_ENTITIES = 10_000;

const QUAD_VERTICES = new Float32Array([
  -0.5, -0.5, 0.0,
   0.5, -0.5, 0.0,
   0.5,  0.5, 0.0,
  -0.5,  0.5, 0.0,
]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

let device: GPUDevice;
let context: GPUCanvasContext;
let pipeline: GPURenderPipeline;
let bindGroup: GPUBindGroup;
let vertexBuffer: GPUBuffer;
let indexBuffer: GPUBuffer;
let cameraBuffer: GPUBuffer;
let matricesBuffer: GPUBuffer;
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
      depthTexture = device.createTexture({
        size: [canvasWidth, canvasHeight],
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
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

  const shaderModule = device.createShaderModule({ code: shaderCode });

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

  cameraBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  matricesBuffer = device.createBuffer({
    size: MAX_ENTITIES * 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });

  bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 1, resource: { buffer: matricesBuffer } },
    ],
  });

  pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: shaderModule,
      entryPoint: "vs_main",
      buffers: [{
        arrayStride: 12,
        attributes: [{ format: "float32x3" as GPUVertexFormat, offset: 0, shaderLocation: 0 }],
      }],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list", cullMode: "back" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
  });

  depthTexture = device.createTexture({
    size: [canvasWidth, canvasHeight],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const aspect = canvasWidth / canvasHeight;
  camera.setOrthographic(20 * aspect, 20, 0.1, 1000);
}

function renderLoop(): void {
  function renderFrame() {
    // Upload camera view-projection matrix.
    // Cast needed because @webgpu/types rejects SharedArrayBuffer-backed views.
    device.queue.writeBuffer(
      cameraBuffer, 0,
      camera.viewProjection as Float32Array<ArrayBuffer>
    );

    if (latestRenderState && latestRenderState.entityCount > 0) {
      const entityData = new Float32Array(latestRenderState.entityData);
      const byteLen = latestRenderState.entityCount * 80;  // 20 floats × 4 bytes
      device.queue.writeBuffer(matricesBuffer, 0, entityData.buffer, 0, byteLen);
      currentEntityCount = latestRenderState.entityCount;
    }

    const commandEncoder = device.createCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.067, g: 0.067, b: 0.067, a: 1.0 },
        loadOp: "clear",
        storeOp: "store",
      }],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });

    if (currentEntityCount > 0) {
      renderPass.setPipeline(pipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.setVertexBuffer(0, vertexBuffer);
      renderPass.setIndexBuffer(indexBuffer, "uint16");
      renderPass.drawIndexed(6, currentEntityCount);
    }

    renderPass.end();
    device.queue.submit([commandEncoder.finish()]);

    requestAnimationFrame(renderFrame);
  }

  requestAnimationFrame(renderFrame);
}
