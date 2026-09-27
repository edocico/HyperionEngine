import { describe, it, expect, vi, beforeAll } from 'vitest';
import { DebugProbe, worldToUv } from './debug-probe';
import { ResourcePool } from './resource-pool';

// WebGPU bitflag globals for Node/vitest, as in gpu-profiler.test.ts.
beforeAll(() => {
  if (typeof globalThis.GPUBufferUsage === 'undefined') {
    (globalThis as any).GPUBufferUsage = {
      MAP_READ: 0x0001, MAP_WRITE: 0x0002,
      COPY_SRC: 0x0004, COPY_DST: 0x0008,
      INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040,
      STORAGE: 0x0080, INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
    };
  }
  if (typeof globalThis.GPUMapMode === 'undefined') {
    (globalThis as any).GPUMapMode = { READ: 0x0001, WRITE: 0x0002 };
  }
});

/** An orthographic view-projection: world x in [-10, 10], y in [-5, 5] fills clip space. */
function ortho(): Float32Array {
  const vp = new Float32Array(16);
  vp[0] = 1 / 10;  // x scale
  vp[5] = 1 / 5;   // y scale
  vp[10] = 1;
  vp[15] = 1;
  return vp;
}

/**
 * A device whose compute "runs" on the CPU: the pixel probe's output buffer is
 * filled with (uvx, uvy, layer, 1) per point, then the texture size, so a
 * test can see exactly what the shader was asked to read.
 */
function mockDevice(size: [number, number] = [800, 600], opts: { scopeError?: string; dropSubmits?: boolean } = {}) {
  const calls = { submits: 0, destroyed: 0, pipelines: [] as string[] };
  const buffers: { size: number; usage: number; data: ArrayBuffer }[] = [];
  const device = {
    createShaderModule: vi.fn(() => ({})),
    createComputePipeline: vi.fn((d: GPUComputePipelineDescriptor) => {
      calls.pipelines.push(d.compute.entryPoint!);
      return { getBindGroupLayout: () => ({ entry: d.compute.entryPoint }) };
    }),
    createBuffer: vi.fn((d: GPUBufferDescriptor) => {
      const b = {
        size: d.size, usage: d.usage, data: new ArrayBuffer(d.size),
        mapAsync: vi.fn(async () => {}),
        getMappedRange: () => b.data,
        unmap: vi.fn(),
        destroy: vi.fn(() => { calls.destroyed++; }),
      };
      buffers.push(b);
      return b;
    }),
    createBindGroup: vi.fn((d: GPUBindGroupDescriptor) => d),
    pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(async () => (opts.scopeError ? { message: opts.scopeError } : null)),
    queue: {
      writeBuffer: vi.fn((buf: { data: ArrayBuffer }, offset: number, src: ArrayBufferView) => {
        new Uint8Array(buf.data, offset).set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
      }),
      submit: vi.fn(() => { calls.submits++; }),
    },
    createCommandEncoder: vi.fn(() => {
      let bindGroup: GPUBindGroupDescriptor | null = null;
      return {
        beginComputePass: () => ({
          setPipeline() {},
          setBindGroup: (_: number, bg: GPUBindGroupDescriptor) => { bindGroup = bg; },
          dispatchWorkgroups() {},
          end() {},
        }),
        copyBufferToBuffer: (src: { data: ArrayBuffer }, so: number, dst: { data: ArrayBuffer }, d0: number, n: number) => {
          if (opts.dropSubmits) return; // a submit that failed validation runs nothing
          // Pixel probe: fake the shader into `src` (the storage output) first.
          const entries = [...(bindGroup?.entries ?? [])] as { binding: number; resource: { buffer?: { data: ArrayBuffer } } }[];
          const points = entries.find((e) => e.binding === 0)?.resource.buffer;
          const out = entries.find((e) => e.binding === 1)?.resource.buffer;
          if (points && out === src) {
            const uv = new Float32Array(points.data);
            const o = new Float32Array(out.data);
            const count = o.length / 4 - 1;
            for (let i = 0; i < count; i++) o.set([uv[2 * i], uv[2 * i + 1], 0, 1], 4 * i);
            o.set([size[0], size[1], 0, 0], 4 * count);
          }
          new Uint8Array(dst.data, d0, n).set(new Uint8Array(src.data, so, n));
        },
        finish: () => ({}),
      };
    }),
  } as unknown as GPUDevice;
  return { device, calls, buffers };
}

function pool(names: string[]): ResourcePool {
  const p = new ResourcePool();
  for (const n of names) p.setTextureView(n, {} as GPUTextureView);
  return p;
}

const frame = { cameraViewProjection: ortho(), canvasWidth: 800, canvasHeight: 600 };
/** A frame drawn by the lit graph, with two light groups. */
const litFrame = { ...frame, lightGroups: { groups: [{}, {}] } };

describe('worldToUv', () => {
  it('maps world through the camera to UV, top-left origin', () => {
    const vp = ortho(); // f32: 1/10 and 1/5 are not exact
    const close = (got: [number, number], want: [number, number]) => {
      expect(got[0]).toBeCloseTo(want[0], 6);
      expect(got[1]).toBeCloseTo(want[1], 6);
    };
    close(worldToUv(0, 0, vp), [0.5, 0.5]);
    close(worldToUv(-10, 5, vp), [0, 0]);
    close(worldToUv(10, -5, vp), [1, 1]);
    close(worldToUv(5, 0, vp), [0.75, 0.5]);
  });
});

describe('DebugProbe.pixels', () => {
  it('is served at the next frame, reading the requested UV points', async () => {
    const { device, calls } = mockDevice();
    const probe = new DebugProbe(device, 'wgsl');
    const pending = probe.pixels({ target: 'scene-hdr', uv: [[0.25, 0.5], [1, 0]] });
    expect(calls.submits).toBe(0);
    probe.serve(pool(['scene-hdr']), frame, null);
    const result = await pending;
    expect(calls.submits).toBe(1);
    expect(result.values).toEqual([[0.25, 0.5, 0, 1], [1, 0, 0, 1]]);
    expect(result.targetSize).toEqual([800, 600]);
    expect(result.canvasSize).toEqual([800, 600]);
  });

  it('converts world points with the camera of the probed frame', async () => {
    const { device } = mockDevice();
    const probe = new DebugProbe(device, 'wgsl');
    const pending = probe.pixels({ target: 'swapchain', world: [[5, 0]] });
    probe.serve(pool(['swapchain']), frame, null, true);
    const result = await pending;
    expect(result.uv[0][0]).toBeCloseTo(0.75, 6);
    expect(result.uv[0][1]).toBeCloseTo(0.5, 6);
    expect(Array.from(result.viewProjection)).toEqual(Array.from(ortho()));
  });

  it('reads the light buffer through the 2d-array entry point at the requested layer', async () => {
    const { device, calls, buffers } = mockDevice();
    const probe = new DebugProbe(device, 'wgsl');
    const pending = probe.pixels({ target: 'light-buffer', layer: 1, uv: [[0.5, 0.5]] });
    probe.serve(pool(['light-buffer']), litFrame, null);
    await pending;
    expect(calls.pipelines).toContain('probe_array');
    const params = buffers.find((b) => b.usage & GPUBufferUsage.UNIFORM)!;
    expect(new Uint32Array(params.data)[0]).toBe(1);
  });

  it('rejects a target the live graph does not have, or a point outside the target', async () => {
    const { device } = mockDevice();
    const probe = new DebugProbe(device, 'wgsl');
    const missing = probe.pixels({ target: 'light-buffer', uv: [[0.5, 0.5]] });
    const outside = probe.pixels({ target: 'scene-hdr', uv: [[1.5, 0.5]] });
    probe.serve(pool(['scene-hdr']), frame, null);
    await expect(missing).rejects.toThrow(/light-buffer/);
    await expect(outside).rejects.toThrow(/outside/);
  });

  it('rejects light-buffer on a frame the lit graph did not draw (a retired lit graph leaves its view in the pool)', async () => {
    const { device } = mockDevice();
    const probe = new DebugProbe(device, 'wgsl');
    const pending = probe.pixels({ target: 'light-buffer', uv: [[0.5, 0.5]] });
    probe.serve(pool(['light-buffer']), frame, null);
    await expect(pending).rejects.toThrow(/not in the live render graph/);
  });

  it('rejects a light-buffer layer that is not one of the frame groups', async () => {
    const { device } = mockDevice();
    const probe = new DebugProbe(device, 'wgsl');
    const bad = [2, -1, 0.5].map((layer) => probe.pixels({ target: 'light-buffer', layer, uv: [[0.5, 0.5]] }));
    probe.serve(pool(['light-buffer']), litFrame, null);
    for (const p of bad) await expect(p).rejects.toThrow(/layer/);
  });

  it('rejects, instead of answering zeros, when the GPU reported a validation error', async () => {
    const { device } = mockDevice([800, 600], { scopeError: 'Destroyed texture used in a submit' });
    const probe = new DebugProbe(device, 'wgsl');
    const pending = probe.pixels({ target: 'scene-hdr', uv: [[0.5, 0.5]] });
    probe.serve(pool(['scene-hdr']), frame, null);
    await expect(pending).rejects.toThrow(/Destroyed texture/);
  });

  it('rejects when the dispatch never ran (no texture size came back)', async () => {
    const { device } = mockDevice([800, 600], { dropSubmits: true });
    const probe = new DebugProbe(device, 'wgsl');
    const pending = probe.pixels({ target: 'scene-hdr', uv: [[0.5, 0.5]] });
    probe.serve(pool(['scene-hdr']), frame, null);
    await expect(pending).rejects.toThrow(/did not run/);
  });

  it('asks for a sampled swapchain and serves a swapchain request only once it has one', async () => {
    const { device } = mockDevice();
    const probe = new DebugProbe(device, 'wgsl');
    expect(probe.wantsSwapchain).toBe(false);
    const pending = probe.pixels({ target: 'swapchain', uv: [[0.5, 0.5]] });
    expect(probe.wantsSwapchain).toBe(true);
    let done = false;
    void pending.then(() => { done = true; });
    probe.serve(pool(['swapchain']), frame, null, false);
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    probe.serve(pool(['swapchain']), frame, null, true);
    await pending;
    expect(probe.wantsSwapchain).toBe(false);
  });

  it('frees every buffer it created once a result is back', async () => {
    const { device, calls, buffers } = mockDevice();
    const probe = new DebugProbe(device, 'wgsl');
    const pending = probe.pixels({ target: 'scene-hdr', uv: [[0.5, 0.5]] });
    probe.serve(pool(['scene-hdr']), frame, null);
    await pending;
    expect(calls.destroyed).toBe(buffers.length);
  });

  it('destroy() rejects what is still pending', async () => {
    const { device } = mockDevice();
    const probe = new DebugProbe(device, 'wgsl');
    const pending = probe.pixels({ target: 'scene-hdr', uv: [[0.5, 0.5]] });
    probe.destroy();
    await expect(pending).rejects.toThrow(/destroyed/);
  });
});

describe('DebugProbe.transforms', () => {
  it('reads the GPU transform rows back next to the CPU rows of the same frame', async () => {
    const { device } = mockDevice();
    const probe = new DebugProbe(device, 'wgsl');
    const gpu = device.createBuffer({ size: 2 * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }) as unknown as { data: ArrayBuffer };
    new Float32Array(gpu.data).set(Array.from({ length: 32 }, (_, i) => i));
    const pending = probe.transforms();
    probe.serve(pool([]), frame, {
      buffer: gpu as unknown as GPUBuffer,
      transforms: new Float32Array(Array.from({ length: 32 }, (_, i) => i + 0.5)),
      entityIds: new Uint32Array([7, 9]),
      entityCount: 2,
      usedScatter: true,
    });
    const result = await pending;
    expect(Array.from(result.gpuRows.slice(16, 18))).toEqual([16, 17]);
    expect(Array.from(result.cpuRows.slice(16, 18))).toEqual([16.5, 17.5]);
    expect(Array.from(result.entityIds)).toEqual([7, 9]);
    expect(result.usedScatter).toBe(true);
  });

  it('rejects, instead of answering zeros, when the GPU reported an error', async () => {
    const { device } = mockDevice([800, 600], { scopeError: 'copy past the end of the buffer' });
    const probe = new DebugProbe(device, 'wgsl');
    const gpu = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const pending = probe.transforms();
    probe.serve(pool([]), frame, {
      buffer: gpu, transforms: new Float32Array(16), entityIds: new Uint32Array([1]), entityCount: 1, usedScatter: false,
    });
    await expect(pending).rejects.toThrow(/past the end/);
  });
});
