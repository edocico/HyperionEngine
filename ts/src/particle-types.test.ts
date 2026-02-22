import { describe, it, expect } from 'vitest';
import { DEFAULT_PARTICLE_CONFIG, type ParticleEmitterConfig, type ParticleHandle } from './particle-types';

describe('Particle Types', () => {
  it('DEFAULT_PARTICLE_CONFIG has sensible defaults', () => {
    const cfg = DEFAULT_PARTICLE_CONFIG;
    expect(cfg.maxParticles).toBe(1000);
    expect(cfg.emissionRate).toBe(100);
    expect(cfg.lifetime).toEqual([0.5, 2.0]);
    expect(cfg.gravity).toEqual([0, 0]);
  });

  it('ParticleEmitterConfig is structurally typed', () => {
    const cfg: ParticleEmitterConfig = {
      maxParticles: 500,
      emissionRate: 50,
      lifetime: [1, 3],
      velocityMin: [-10, -10],
      velocityMax: [10, 10],
      colorStart: [1, 0.5, 0, 1],
      colorEnd: [1, 0, 0, 0],
      sizeStart: 4,
      sizeEnd: 0,
      gravity: [0, -50],
    };
    expect(cfg.maxParticles).toBe(500);
  });

  it('ParticleHandle is a branded number', () => {
    const handle = 42 as ParticleHandle;
    expect(handle).toBe(42);
    expect(typeof handle).toBe('number');
  });
});
