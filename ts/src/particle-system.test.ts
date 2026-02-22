import { describe, it, expect, vi } from 'vitest';
import { ParticleSystem } from './particle-system';
import { DEFAULT_PARTICLE_CONFIG, type ParticleHandle } from './particle-types';

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
});
