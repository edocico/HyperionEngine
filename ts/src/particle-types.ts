/**
 * GPU particle system types and constants.
 *
 * Particles are NOT ECS entities. They live entirely on the GPU,
 * managed by compute shaders for simulation and instanced rendering.
 */

/** Branded type for particle emitter handles. */
export type ParticleHandle = number & { readonly __brand: 'ParticleHandle' };

/** Configuration for a particle emitter. */
export interface ParticleEmitterConfig {
  maxParticles: number;
  emissionRate: number;
  lifetime: [number, number];
  velocityMin: [number, number];
  velocityMax: [number, number];
  colorStart: [number, number, number, number];
  colorEnd: [number, number, number, number];
  sizeStart: number;
  sizeEnd: number;
  gravity: [number, number];
}

/** Sensible defaults for a particle emitter. */
export const DEFAULT_PARTICLE_CONFIG: ParticleEmitterConfig = {
  maxParticles: 1000,
  emissionRate: 100,
  lifetime: [0.5, 2.0],
  velocityMin: [-20, -20],
  velocityMax: [20, 20],
  colorStart: [1, 1, 1, 1],
  colorEnd: [1, 1, 1, 0],
  sizeStart: 4,
  sizeEnd: 0,
  gravity: [0, 0],
};

/** Number of f32 values per particle in the GPU buffer. */
export const PARTICLE_STRIDE_FLOATS = 12;

/** Byte size of a single particle in the GPU buffer. */
export const PARTICLE_STRIDE_BYTES = PARTICLE_STRIDE_FLOATS * 4;
