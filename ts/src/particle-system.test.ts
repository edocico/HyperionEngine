import { describe, it, expect, vi } from 'vitest';
import { ParticleSystem } from './particle-system';
import { DEFAULT_PARTICLE_CONFIG } from './particle-types';
import particleRenderSource from './shaders/particle-render.wgsl?raw';

function mockDevice(): GPUDevice {
  return {
    createBuffer: vi.fn(() => ({
      destroy: vi.fn(),
      size: 0,
      mapAsync: vi.fn(),
      getMappedRange: vi.fn(),
      unmap: vi.fn(),
    })),
    createShaderModule: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({
      getBindGroupLayout: vi.fn(() => ({})),
    })),
    createRenderPipeline: vi.fn(() => ({
      getBindGroupLayout: vi.fn(() => ({})),
    })),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    queue: { writeBuffer: vi.fn() },
  } as unknown as GPUDevice;
}

describe('ParticleSystem', () => {
  it('constructs with a device', () => {
    const device = mockDevice();
    const ps = new ParticleSystem(device);
    expect(ps).toBeInstanceOf(ParticleSystem);
    expect(ps.emitterCount).toBe(0);
  });

  it('createEmitter returns a handle and increments count', () => {
    const device = mockDevice();
    const ps = new ParticleSystem(device);
    ps.setupPipelines('simulate code', 'render code', 'bgra8unorm' as GPUTextureFormat);
    const handle = ps.createEmitter(DEFAULT_PARTICLE_CONFIG);
    expect(typeof handle).toBe('number');
    expect(ps.emitterCount).toBe(1);
  });

  it('destroyEmitter removes the emitter', () => {
    const device = mockDevice();
    const ps = new ParticleSystem(device);
    ps.setupPipelines('simulate code', 'render code', 'bgra8unorm' as GPUTextureFormat);
    const handle = ps.createEmitter(DEFAULT_PARTICLE_CONFIG);
    expect(ps.emitterCount).toBe(1);
    ps.destroyEmitter(handle);
    expect(ps.emitterCount).toBe(0);
  });

  it('emitterCount reflects active emitters', () => {
    const device = mockDevice();
    const ps = new ParticleSystem(device);
    ps.setupPipelines('simulate code', 'render code', 'bgra8unorm' as GPUTextureFormat);
    const h1 = ps.createEmitter(DEFAULT_PARTICLE_CONFIG);
    const h2 = ps.createEmitter({ ...DEFAULT_PARTICLE_CONFIG, maxParticles: 500 });
    expect(ps.emitterCount).toBe(2);
    ps.destroyEmitter(h1);
    expect(ps.emitterCount).toBe(1);
    ps.destroyEmitter(h2);
    expect(ps.emitterCount).toBe(0);
  });

  it('destroy cleans up all emitters', () => {
    const device = mockDevice();
    const ps = new ParticleSystem(device);
    ps.setupPipelines('simulate code', 'render code', 'bgra8unorm' as GPUTextureFormat);
    ps.createEmitter(DEFAULT_PARTICLE_CONFIG);
    ps.createEmitter(DEFAULT_PARTICLE_CONFIG);
    expect(ps.emitterCount).toBe(2);
    ps.destroy();
    expect(ps.emitterCount).toBe(0);
  });

  describe('shader hot-reload', () => {
    const FORMAT = 'bgra8unorm' as GPUTextureFormat;

    it('installing new pipelines rebinds every existing emitter', () => {
      // Bind groups made from a 'auto'-layout pipeline fit only that pipeline:
      // an emitter left on the old ones fails validation every frame.
      const device = mockDevice();
      const ps = new ParticleSystem(device);
      ps.setupPipelines('sim v1', 'render v1', FORMAT);
      ps.createEmitter(DEFAULT_PARTICLE_CONFIG);
      ps.createEmitter(DEFAULT_PARTICLE_CONFIG);
      const bindGroups = vi.mocked(device.createBindGroup).mock.calls.length;

      ps.installPipelines(ps.buildRender('render v2', FORMAT));

      expect(vi.mocked(device.createBindGroup).mock.calls.length).toBe(bindGroups + 6); // 3 per emitter: simulate, spawn, render
    });

    it('building pipelines does not install them', () => {
      const device = mockDevice();
      const ps = new ParticleSystem(device);
      ps.setupPipelines('sim v1', 'render v1', FORMAT);
      ps.createEmitter(DEFAULT_PARTICLE_CONFIG);
      const bindGroups = vi.mocked(device.createBindGroup).mock.calls.length;

      ps.buildSimulate('sim v2');
      ps.buildRender('render v2', FORMAT);

      expect(vi.mocked(device.createBindGroup).mock.calls.length).toBe(bindGroups);
    });

    it('the quad index buffer is created once, not on every reload', () => {
      const device = mockDevice();
      const ps = new ParticleSystem(device);
      ps.setupPipelines('sim v1', 'render v1', FORMAT);
      ps.setupPipelines('sim v2', 'render v2', FORMAT);
      const indexBuffers = vi.mocked(device.createBuffer).mock.calls
        .filter(([desc]) => (desc as GPUBufferDescriptor).size === 8);
      expect(indexBuffers).toHaveLength(1);
    });
  });
});

// Every particle pipeline uses `layout: 'auto'`. An auto layout is compatible
// only with bind groups built from THAT pipeline's getBindGroupLayout(), even
// when another pipeline's layout looks identical. It also contains only the
// bindings the shader actually uses. Breaking either rule is a validation error
// at encode time, which drops the whole frame. That happened on every frame
// with a live emitter, and went unseen because particles never ran on the main
// thread in Mode A.
describe('particle bind groups match their pipelines', () => {
  function recordFrame() {
    const layoutOf = new Map<object, object>();
    const pipeline = () => {
      const layout = {};
      const p = { getBindGroupLayout: () => layout };
      layoutOf.set(p, layout);
      return p;
    };
    const device = {
      createBuffer: () => ({ destroy() {} }),
      createShaderModule: () => ({}),
      createComputePipeline: pipeline,
      createRenderPipeline: pipeline,
      createBindGroup: (d: GPUBindGroupDescriptor) => ({ layout: d.layout, bindings: [...d.entries].map((e) => e.binding) }),
      queue: { writeBuffer() {} },
    } as unknown as GPUDevice;

    const uses: Array<{ kind: string; pipeline: object; bindGroup: { layout: object; bindings: number[] } }> = [];
    const passEncoder = (kind: string) => {
      let current: object | null = null;
      return {
        setPipeline: (p: object) => { current = p; },
        setBindGroup: (_i: number, bg: { layout: object; bindings: number[] }) => { uses.push({ kind, pipeline: current!, bindGroup: bg }); },
        dispatchWorkgroups() {}, setIndexBuffer() {}, drawIndexed() {}, end() {},
      };
    };
    const encoder = {
      beginComputePass: () => passEncoder('compute'),
      beginRenderPass: () => passEncoder('render'),
    } as unknown as GPUCommandEncoder;

    const ps = new ParticleSystem(device);
    ps.setupPipelines('simulate code', 'render code', 'bgra8unorm' as GPUTextureFormat);
    ps.createEmitter({ ...DEFAULT_PARTICLE_CONFIG, emissionRate: 600 });
    ps.update(encoder, {} as GPUTextureView, new Float32Array(16), 1 / 60);
    return { uses, layoutOf };
  }

  it('builds each bind group from the layout of the pipeline it is used with', () => {
    const { uses, layoutOf } = recordFrame();
    expect(uses.length).toBe(3);   // simulate, spawn, render
    for (const u of uses) {
      expect(u.bindGroup.layout, u.kind).toBe(layoutOf.get(u.pipeline));
    }
  });

  it('binds, for rendering, exactly the bindings the render shader uses', () => {
    const code = particleRenderSource.replace(/\/\/[^\n]*/g, '');
    const used = [...code.matchAll(/@binding\((\d+)\)\s*var(?:<[^>]*>)?\s+(\w+)/g)]
      .filter(([, , name]) => (code.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length > 1)
      .map(([, binding]) => Number(binding));
    const render = recordFrame().uses.find((u) => u.kind === 'render')!;
    expect(render.bindGroup.bindings.sort()).toEqual(used.sort());
  });
});
