import { describe, it, expect } from 'vitest';
import type { RenderPass } from './render-pass';
import { ResourcePool } from './resource-pool';

describe('RenderPass interface', () => {
  it('should define required properties', () => {
    const pass: RenderPass = {
      name: 'test-pass',
      reads: ['input-texture'],
      writes: ['output-texture'],
      optional: false,
      setup: () => {},
      prepare: () => {},
      execute: () => {},
      resize: () => {},
      destroy: () => {},
    };
    expect(pass.name).toBe('test-pass');
    expect(pass.reads).toEqual(['input-texture']);
    expect(pass.writes).toEqual(['output-texture']);
    expect(pass.optional).toBe(false);
  });
});

describe('ResourcePool', () => {
  it('should register and retrieve named buffers', () => {
    const pool = new ResourcePool();
    const mockBuffer = {} as GPUBuffer;
    pool.setBuffer('transforms', mockBuffer);
    expect(pool.getBuffer('transforms')).toBe(mockBuffer);
  });

  it('should return undefined for unknown resources', () => {
    const pool = new ResourcePool();
    expect(pool.getBuffer('nonexistent')).toBeUndefined();
  });

  it('should register and retrieve named textures', () => {
    const pool = new ResourcePool();
    const mockTexture = {} as GPUTexture;
    pool.setTexture('depth', mockTexture);
    expect(pool.getTexture('depth')).toBe(mockTexture);
  });

  it('should register and retrieve named samplers', () => {
    const pool = new ResourcePool();
    const mockSampler = {} as GPUSampler;
    pool.setSampler('texSampler', mockSampler);
    expect(pool.getSampler('texSampler')).toBe(mockSampler);
  });

  it('should return undefined for unknown samplers', () => {
    const pool = new ResourcePool();
    expect(pool.getSampler('nonexistent')).toBeUndefined();
  });
});
