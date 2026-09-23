/**
 * Debug line rendering passes (Phase 16 Track A).
 *
 * `LineBatchPass` is the shared GPU half: a line-list pipeline with
 * per-vertex color and a camera view-projection uniform, drawing on top of
 * the scene (`loadOp: 'load'`). Subclasses fill the CPU staging buffers:
 *
 * - `DebugLinePass` — physics debug wireframes. Auto-feeds from
 *   `FrameState.physicsDebugLines` (8 f32 per line: [ax,ay,bx,by,r,g,b,a]),
 *   which the bridges populate from the WASM `engine_physics_debug_*`
 *   exports on physics-debug builds.
 * - `BoundsVisualizerPass` (in debug/bounds-visualizer.ts) — bounding-sphere
 *   wireframes generated TS-side. Completes the Phase 10b stub.
 */
import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';

/**
 * Base class: owns the pipeline, buffers, and draw logic for a batch of
 * colored world-space line segments. Subclasses write `vertStaging`
 * (3 f32/vertex), `colorStaging` (4 f32/vertex) and set `vertexCount`.
 */
export class LineBatchPass implements RenderPass {
  /** WGSL source (debug-line.wgsl), set by the renderer before setup(). */
  static SHADER_SOURCE = '';

  readonly name: string;
  // Read-modify-write of the swapchain: `execute()` loads what the final
  // composite left there (loadOp 'load') and draws on top. Declaring the read
  // makes this pass the next link of the swapchain's writer chain, ordered
  // after the composite. Without it the pass is a second BLIND swapchain
  // writer, which `compile()` rejects — the declaration this class shipped
  // with until 2026-09-23.
  readonly reads: string[] = ['swapchain'];
  readonly writes: string[] = ['swapchain'];
  readonly optional = true;

  protected pipeline: GPURenderPipeline | null = null;
  protected vertexBuffer: GPUBuffer | null = null;
  protected colorBuffer: GPUBuffer | null = null;
  protected cameraBuffer: GPUBuffer | null = null;
  protected bindGroup: GPUBindGroup | null = null;

  protected vertexCount = 0;
  protected readonly maxVerts: number;
  protected vertStaging: Float32Array;
  protected colorStaging: Float32Array;

  protected enabled = true;

  constructor(name: string, maxVerts: number) {
    this.name = name;
    this.maxVerts = maxVerts;
    this.vertStaging = new Float32Array(maxVerts * 3);
    this.colorStaging = new Float32Array(maxVerts * 4);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.vertexCount = 0;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Current number of staged vertices (2 per line segment). */
  get stagedVertexCount(): number {
    return this.vertexCount;
  }

  setup(device: GPUDevice, _resources: ResourcePool): void {
    if (!LineBatchPass.SHADER_SOURCE) {
      throw new Error('LineBatchPass.SHADER_SOURCE must be set before setup()');
    }

    this.vertexBuffer = device.createBuffer({
      size: this.maxVerts * 3 * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.colorBuffer = device.createBuffer({
      size: this.maxVerts * 4 * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.cameraBuffer = device.createBuffer({
      size: 64, // mat4x4<f32>
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform' },
      }],
    });
    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });

    const module = device.createShaderModule({ code: LineBatchPass.SHADER_SOURCE });
    const format = navigator.gpu.getPreferredCanvasFormat();
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 3 * 4,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
          {
            arrayStride: 4 * 4,
            attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x4' }],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'line-list' },
    });
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.enabled || this.vertexCount === 0) return;
    if (this.cameraBuffer) {
      device.queue.writeBuffer(
        this.cameraBuffer, 0,
        frame.cameraViewProjection as Float32Array<ArrayBuffer>, 0, 16,
      );
    }
    if (this.vertexBuffer) {
      device.queue.writeBuffer(
        this.vertexBuffer, 0,
        this.vertStaging as Float32Array<ArrayBuffer>, 0, this.vertexCount * 3,
      );
    }
    if (this.colorBuffer) {
      device.queue.writeBuffer(
        this.colorBuffer, 0,
        this.colorStaging as Float32Array<ArrayBuffer>, 0, this.vertexCount * 4,
      );
    }
  }

  execute(encoder: GPUCommandEncoder, _frame: FrameState, resources: ResourcePool): void {
    if (!this.enabled || this.vertexCount === 0 || !this.pipeline) return;
    const view = resources.getTextureView('swapchain');
    if (!view) return;

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        loadOp: 'load',   // draw on top of the scene
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setVertexBuffer(1, this.colorBuffer);
    pass.draw(this.vertexCount);
    pass.end();
  }

  resize(_width: number, _height: number): void {
    // No size-dependent resources.
  }

  destroy(): void {
    this.vertexBuffer?.destroy();
    this.colorBuffer?.destroy();
    this.cameraBuffer?.destroy();
    this.vertexBuffer = null;
    this.colorBuffer = null;
    this.cameraBuffer = null;
    this.pipeline = null;
    this.bindGroup = null;
  }
}

/**
 * Physics debug line pass. Consumes `FrameState.physicsDebugLines`
 * (8 f32 per line, RGBA already converted WASM-side) each frame.
 */
export class DebugLinePass extends LineBatchPass {
  constructor(maxLines = 8192) {
    super('physics-debug', maxLines * 2);
  }

  /** Expand 8-f32 line records into vertex + color staging buffers. */
  setLines(records: Float32Array | null | undefined): void {
    if (!records || records.length < 8) {
      this.vertexCount = 0;
      return;
    }
    const lineCount = Math.min(records.length >> 3, this.maxVerts >> 1);
    for (let i = 0; i < lineCount; i++) {
      const r = i * 8;
      const v = i * 6;   // 2 vertices * 3 f32
      const c = i * 8;   // 2 vertices * 4 f32

      this.vertStaging[v] = records[r];         // ax
      this.vertStaging[v + 1] = records[r + 1]; // ay
      this.vertStaging[v + 2] = 0;
      this.vertStaging[v + 3] = records[r + 2]; // bx
      this.vertStaging[v + 4] = records[r + 3]; // by
      this.vertStaging[v + 5] = 0;

      for (let e = 0; e < 2; e++) {
        this.colorStaging[c + e * 4] = records[r + 4];
        this.colorStaging[c + e * 4 + 1] = records[r + 5];
        this.colorStaging[c + e * 4 + 2] = records[r + 6];
        this.colorStaging[c + e * 4 + 3] = records[r + 7];
      }
    }
    this.vertexCount = lineCount * 2;
  }

  override prepare(device: GPUDevice, frame: FrameState): void {
    if (this.enabled) {
      this.setLines(frame.physicsDebugLines);
    }
    super.prepare(device, frame);
  }
}
