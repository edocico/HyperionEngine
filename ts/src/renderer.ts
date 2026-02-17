import { Camera } from "./camera";
import type { RenderStateSnapshot } from "./worker-bridge";
import shaderCode from "./shaders/basic.wgsl?raw";

const MAX_ENTITIES = 10_000;

/** Unit quad: 4 vertices, 6 indices (two triangles). */
const QUAD_VERTICES = new Float32Array([
  -0.5, -0.5, 0.0,
   0.5, -0.5, 0.0,
   0.5,  0.5, 0.0,
  -0.5,  0.5, 0.0,
]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

export interface Renderer {
  /** Upload new model matrices and render a frame. */
  render(state: RenderStateSnapshot | null): void;
  /** Resize the render target. */
  resize(width: number, height: number): void;
  /** Release GPU resources. */
  destroy(): void;
  /** The camera (public for position/zoom adjustment). */
  camera: Camera;
}

/**
 * Initialize the WebGPU renderer.
 * Returns null if WebGPU is unavailable.
 */
export async function createRenderer(
  canvas: HTMLCanvasElement
): Promise<Renderer | null> {
  if (!navigator.gpu) {
    console.warn("WebGPU not available. Rendering disabled.");
    return null;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    console.warn("No GPU adapter found. Rendering disabled.");
    return null;
  }

  const device = await adapter.requestDevice();

  const context = canvas.getContext("webgpu");
  if (!context) {
    console.warn("Could not get WebGPU context. Rendering disabled.");
    return null;
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const shaderModule = device.createShaderModule({ code: shaderCode });

  const vertexBuffer = device.createBuffer({
    size: QUAD_VERTICES.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, QUAD_VERTICES);

  const indexBuffer = device.createBuffer({
    size: QUAD_INDICES.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, QUAD_INDICES);

  const cameraBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const matricesBuffer = device.createBuffer({
    size: MAX_ENTITIES * 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 1, resource: { buffer: matricesBuffer } },
    ],
  });

  const pipeline = device.createRenderPipeline({
    layout: pipelineLayout,
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
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });

  let depthTexture = createDepthTexture(device, canvas.width, canvas.height);

  const camera = new Camera();
  camera.setOrthographic(20, 15, 0.1, 1000);

  let currentEntityCount = 0;

  return {
    camera,

    render(state: RenderStateSnapshot | null) {
      device.queue.writeBuffer(
        cameraBuffer, 0,
        camera.viewProjection as Float32Array<ArrayBuffer>
      );

      if (state && state.count > 0) {
        const byteLen = state.count * 64;
        device.queue.writeBuffer(
          matricesBuffer, 0,
          state.matrices.buffer,
          state.matrices.byteOffset,
          byteLen
        );
        currentEntityCount = state.count;
      }

      const commandEncoder = device.createCommandEncoder();
      const colorView = context.getCurrentTexture().createView();
      const depthView = depthTexture.createView();

      const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: colorView,
          clearValue: { r: 0.067, g: 0.067, b: 0.067, a: 1.0 },
          loadOp: "clear",
          storeOp: "store",
        }],
        depthStencilAttachment: {
          view: depthView,
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
    },

    resize(width: number, height: number) {
      canvas.width = width;
      canvas.height = height;
      depthTexture.destroy();
      depthTexture = createDepthTexture(device, width, height);
      const aspect = width / height;
      camera.setOrthographic(20 * aspect, 20, 0.1, 1000);
    },

    destroy() {
      vertexBuffer.destroy();
      indexBuffer.destroy();
      cameraBuffer.destroy();
      matricesBuffer.destroy();
      depthTexture.destroy();
      device.destroy();
    },
  };
}

function createDepthTexture(
  device: GPUDevice,
  width: number,
  height: number
): GPUTexture {
  return device.createTexture({
    size: [width, height],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
}
