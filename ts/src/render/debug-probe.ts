// ts/src/render/debug-probe.ts
//
// Dev-only GPU readback behind `engine.debug.probe()` / `readEntityTransforms()`:
// what the harness checks and /gpu-check measure, in linear values, without a
// screenshot. The renderer creates it only in dev builds and calls `serve()`
// at the very end of `render()` — after the graph AND the particles, still in
// the frame's task, so the swapchain has not been presented yet.

import type { ResourcePool } from './resource-pool';

/** What the pixel probe can read. The swapchain is the final, tonemapped image. */
export type ProbeTarget = 'scene-hdr' | 'swapchain' | 'light-buffer';

export interface PixelProbeRequest {
  target: ProbeTarget;
  /** Points in world units, placed with the camera of the frame that is read… */
  world?: readonly (readonly [number, number])[];
  /** …or in UV: (0,0) is the top-left of the target, (1,1) its bottom-right. */
  uv?: readonly (readonly [number, number])[];
  /** Light-buffer layer, i.e. light group (`engine.lighting.groups`). Default 0. */
  layer?: number;
}

export interface PixelProbeResult {
  /** RGBA per point: linear HDR for scene-hdr and light-buffer, 0-1 display values for the swapchain. */
  values: [number, number, number, number][];
  /** Where each point was read, in UV. */
  uv: [number, number][];
  /** The target's size in texels (the light buffer is smaller than the canvas). */
  targetSize: [number, number];
  canvasSize: [number, number];
  /** The camera of the frame that was read. */
  viewProjection: Float32Array;
}

export interface TransformsProbeResult {
  /** The `entity-transforms` rows as the GPU holds them: 16 floats per slot. */
  gpuRows: Float32Array;
  /** The rows the CPU had for the same frame (`GPURenderState.transforms`). */
  cpuRows: Float32Array;
  /** External entity id per slot, for the same frame. */
  entityIds: Uint32Array;
  entityCount: number;
  /** Whether that frame uploaded through the scatter pass (only dirty rows). */
  usedScatter: boolean;
}

/** What `serve()` needs to answer a transforms request; null when the frame drew nothing. */
export interface TransformsSource {
  buffer: GPUBuffer;
  transforms: Float32Array;
  entityIds: Uint32Array | undefined;
  entityCount: number;
  usedScatter: boolean;
}

/** The frame being read: the FrameState fields the probe uses. */
export interface ProbeFrame {
  cameraViewProjection: Float32Array;
  canvasWidth: number;
  canvasHeight: number;
}

/** World (x, y, z = 0) through a column-major view-projection to UV, top-left origin. */
export function worldToUv(x: number, y: number, vp: Float32Array): [number, number] {
  const cx = vp[0] * x + vp[4] * y + vp[12];
  const cy = vp[1] * x + vp[5] * y + vp[13];
  const cw = vp[3] * x + vp[7] * y + vp[15];
  return [(cx / cw) * 0.5 + 0.5, 0.5 - (cy / cw) * 0.5];
}

interface Pending<T, R> {
  request: R;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

const WORKGROUP = 64;

export class DebugProbe {
  private pixelRequests: Pending<PixelProbeResult, PixelProbeRequest>[] = [];
  private transformRequests: Pending<TransformsProbeResult, null>[] = [];
  private pipelines: { '2d': GPUComputePipeline; '2d-array': GPUComputePipeline } | null = null;
  private destroyed = false;

  constructor(private readonly device: GPUDevice, private readonly shaderCode: string) {}

  /** Reads `target` at the next rendered frame. */
  pixels(request: PixelProbeRequest): Promise<PixelProbeResult> {
    return this.enqueue(this.pixelRequests, request);
  }

  /** Reads the `entity-transforms` rows back at the next rendered frame. */
  transforms(): Promise<TransformsProbeResult> {
    return this.enqueue(this.transformRequests, null);
  }

  /** Answers every pending request against this frame. Called last in `render()`. */
  serve(resources: ResourcePool, frame: ProbeFrame, transforms: TransformsSource | null): void {
    const pixels = this.pixelRequests;
    this.pixelRequests = [];
    for (const p of pixels) {
      try {
        this.servePixels(p, resources, frame);
      } catch (err) {
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (transforms) {
      const rows = this.transformRequests;
      this.transformRequests = [];
      for (const p of rows) this.serveTransforms(p, transforms);
    }
  }

  destroy(): void {
    this.destroyed = true;
    const err = new Error('DebugProbe destroyed before the request was served');
    for (const p of this.pixelRequests) p.reject(err);
    for (const p of this.transformRequests) p.reject(err);
    this.pixelRequests = [];
    this.transformRequests = [];
  }

  private enqueue<T, R>(list: Pending<T, R>[], request: R): Promise<T> {
    if (this.destroyed) return Promise.reject(new Error('DebugProbe destroyed'));
    return new Promise<T>((resolve, reject) => list.push({ request, resolve, reject }));
  }

  private servePixels(p: Pending<PixelProbeResult, PixelProbeRequest>, resources: ResourcePool, frame: ProbeFrame): void {
    const { target, layer = 0 } = p.request;
    const view = resources.getTextureView(target);
    if (!view) throw new Error(`Probe target '${target}' is not in the live render graph`);
    const uv = p.request.uv
      ? p.request.uv.map(([u, v]) => [u, v] as [number, number])
      : (p.request.world ?? []).map(([x, y]) => worldToUv(x, y, frame.cameraViewProjection));
    if (uv.length === 0) throw new Error('Probe request has no points');
    const outside = uv.findIndex(([u, v]) => !(u >= 0 && u <= 1 && v >= 0 && v <= 1));
    if (outside >= 0) throw new Error(`Probe point ${outside} is outside the target (uv ${uv[outside].join(', ')})`);

    const isArray = target === 'light-buffer';
    const pipeline = this.pipeline(isArray ? '2d-array' : '2d');
    const count = uv.length;
    const device = this.device;
    const points = device.createBuffer({ size: count * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(points, 0, new Float32Array(uv.flat()));
    const outBytes = (count + 1) * 16;
    const results = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const created = [points, results, readback];
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: points } },
      { binding: 1, resource: { buffer: results } },
    ];
    if (isArray) {
      const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(params, 0, new Uint32Array([layer, 0, 0, 0]));
      created.push(params);
      entries.push({ binding: 3, resource: view }, { binding: 4, resource: { buffer: params } });
    } else {
      entries.push({ binding: 2, resource: view });
    }
    const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });

    const encoder = device.createCommandEncoder({ label: 'debug-probe' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP));
    pass.end();
    encoder.copyBufferToBuffer(results, 0, readback, 0, outBytes);
    device.queue.submit([encoder.finish()]);

    const viewProjection = new Float32Array(frame.cameraViewProjection);
    const canvasSize: [number, number] = [frame.canvasWidth, frame.canvasHeight];
    const free = () => { for (const b of created) b.destroy(); };
    readback.mapAsync(GPUMapMode.READ).then(() => {
      const f = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      free();
      const values = Array.from({ length: count }, (_, i) =>
        [f[4 * i], f[4 * i + 1], f[4 * i + 2], f[4 * i + 3]] as [number, number, number, number]);
      p.resolve({ values, uv, targetSize: [f[4 * count], f[4 * count + 1]], canvasSize, viewProjection });
    }, (err: unknown) => {
      free();
      p.reject(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private serveTransforms(p: Pending<TransformsProbeResult, null>, src: TransformsSource): void {
    const bytes = src.entityCount * 64;
    const cpuRows = src.transforms.slice(0, src.entityCount * 16);
    const entityIds = src.entityIds ? src.entityIds.slice(0, src.entityCount) : new Uint32Array(0);
    const { usedScatter, entityCount } = src;
    if (bytes === 0) {
      p.resolve({ gpuRows: new Float32Array(0), cpuRows, entityIds, entityCount, usedScatter });
      return;
    }
    const readback = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder({ label: 'debug-probe-transforms' });
    encoder.copyBufferToBuffer(src.buffer, 0, readback, 0, bytes);
    this.device.queue.submit([encoder.finish()]);
    readback.mapAsync(GPUMapMode.READ).then(() => {
      const gpuRows = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      readback.destroy();
      p.resolve({ gpuRows, cpuRows, entityIds, entityCount, usedScatter });
    }, (err: unknown) => {
      readback.destroy();
      p.reject(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private pipeline(kind: '2d' | '2d-array'): GPUComputePipeline {
    if (!this.pipelines) {
      const module = this.device.createShaderModule({ code: this.shaderCode, label: 'pixel-probe' });
      const make = (entryPoint: string) => this.device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint },
        label: `pixel-probe-${entryPoint}`,
      });
      this.pipelines = { '2d': make('probe_2d'), '2d-array': make('probe_array') };
    }
    return this.pipelines[kind];
  }
}
