/**
 * GPU particle system: manages emitters, compute simulation, and instanced rendering.
 *
 * Particles are NOT ECS entities. They live entirely on the GPU as storage buffers,
 * simulated by compute shaders and rendered as instanced point-sprite quads.
 * Rendering happens AFTER the main RenderGraph, drawn on top of the swapchain
 * with `loadOp: 'load'`.
 */

import type { ParticleEmitterConfig, ParticleHandle } from './particle-types';
import { PARTICLE_STRIDE_BYTES } from './particle-types';

/** Size of the EmitterConfig uniform buffer in bytes (must be 16-byte aligned). */
const CONFIG_BUFFER_SIZE = 112;

// WebGPU usage flag constants (numeric values avoid runtime reference to
// browser-only globals like GPUBufferUsage, enabling headless unit tests).
const STORAGE = 0x0080;
const COPY_DST = 0x0008;
const UNIFORM = 0x0040;
const INDEX = 0x0010;

/** Size of the counter storage buffer: 2 atomic u32 (alive + spawn counter). */
const COUNTER_BUFFER_SIZE = 8;

/** Per-emitter GPU state. */
interface EmitterState {
  config: ParticleEmitterConfig;
  entityId: number | undefined;
  particleBuffer: GPUBuffer;
  counterBuffer: GPUBuffer;
  configBuffer: GPUBuffer;
  cameraBuffer: GPUBuffer;
  simulateBindGroup: GPUBindGroup | null;
  renderBindGroup: GPUBindGroup | null;
}

export class ParticleSystem {
  private readonly device: GPUDevice;
  private readonly emitters = new Map<number, EmitterState>();
  private nextHandle = 1;

  private simulatePipeline: GPUComputePipeline | null = null;
  private spawnPipeline: GPUComputePipeline | null = null;
  private renderPipeline: GPURenderPipeline | null = null;
  private indexBuffer: GPUBuffer | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /** Number of active emitters. */
  get emitterCount(): number {
    return this.emitters.size;
  }

  /**
   * Compile the compute and render pipelines from shader source.
   * Called once by the renderer after creation.
   */
  setupPipelines(
    simulateSource: string,
    renderSource: string,
    format: GPUTextureFormat,
  ): void {
    const simModule = this.device.createShaderModule({ code: simulateSource });
    const renderModule = this.device.createShaderModule({ code: renderSource });

    // Compute pipeline for particle simulation (advance physics)
    this.simulatePipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: simModule, entryPoint: 'simulate' },
    });

    // Compute pipeline for spawning new particles
    this.spawnPipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: simModule, entryPoint: 'spawn' },
    });

    // Render pipeline for instanced point sprites with alpha blending
    this.renderPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: renderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: renderModule,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            color: {
              srcFactor: 'src-alpha',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
          },
          writeMask: 0xF, // GPUColorWrite.ALL
        }],
      },
      primitive: {
        topology: 'triangle-strip',
        stripIndexFormat: 'uint16',
      },
    });

    // Shared index buffer for quad triangle strip: [0, 1, 2, 3]
    this.indexBuffer = this.device.createBuffer({
      size: 8, // 4 x uint16
      usage: INDEX | COPY_DST,
    });
    this.device.queue.writeBuffer(
      this.indexBuffer, 0,
      new Uint16Array([0, 1, 2, 3]),
    );
  }

  /**
   * Create a new particle emitter. Returns a handle for later management.
   * Optionally ties the emitter position to an entity (by external ID).
   */
  createEmitter(config: ParticleEmitterConfig, entityId?: number): ParticleHandle {
    const handle = this.nextHandle++ as ParticleHandle;

    // Particle storage buffer (zeroed = all dead particles)
    const particleBuffer = this.device.createBuffer({
      size: config.maxParticles * PARTICLE_STRIDE_BYTES,
      usage: STORAGE | COPY_DST,
    });

    // Counter buffer: [aliveCount, spawnCounter]
    const counterBuffer = this.device.createBuffer({
      size: COUNTER_BUFFER_SIZE,
      usage: STORAGE | COPY_DST,
    });

    // Config uniform buffer
    const configBuffer = this.device.createBuffer({
      size: CONFIG_BUFFER_SIZE,
      usage: UNIFORM | COPY_DST,
    });

    // Camera uniform buffer (mat4x4f = 64 bytes)
    const cameraBuffer = this.device.createBuffer({
      size: 64,
      usage: UNIFORM | COPY_DST,
    });

    const state: EmitterState = {
      config,
      entityId,
      particleBuffer,
      counterBuffer,
      configBuffer,
      cameraBuffer,
      simulateBindGroup: null,
      renderBindGroup: null,
    };

    // Create bind groups
    this.rebuildBindGroups(state);

    this.emitters.set(handle, state);
    return handle;
  }

  /** Destroy a specific emitter and its GPU resources. */
  destroyEmitter(handle: ParticleHandle): void {
    const state = this.emitters.get(handle);
    if (!state) return;
    state.particleBuffer.destroy();
    state.counterBuffer.destroy();
    state.configBuffer.destroy();
    state.cameraBuffer.destroy();
    this.emitters.delete(handle);
  }

  /**
   * Per-frame update: simulate, spawn, and render all emitters.
   *
   * @param encoder - GPUCommandEncoder for compute passes
   * @param swapchainView - The swapchain texture view to render onto (loadOp: 'load')
   * @param cameraVP - Camera view-projection matrix (Float32Array of 16 f32)
   * @param dt - Delta time in seconds
   * @param entityPositions - Optional map of entityId -> [x, y] for position tracking
   */
  update(
    encoder: GPUCommandEncoder,
    swapchainView: GPUTextureView,
    cameraVP: Float32Array,
    dt: number,
    entityPositions?: Map<number, [number, number]>,
  ): void {
    if (!this.simulatePipeline || !this.spawnPipeline || !this.renderPipeline || !this.indexBuffer) return;
    if (this.emitters.size === 0) return;

    for (const state of this.emitters.values()) {
      // Resolve emitter position from tracked entity if available
      let emitterX = 0;
      let emitterY = 0;
      if (state.entityId !== undefined && entityPositions) {
        const pos = entityPositions.get(state.entityId);
        if (pos) {
          emitterX = pos[0];
          emitterY = pos[1];
        }
      }

      // Calculate spawn count for this frame
      const spawnCount = Math.floor(state.config.emissionRate * dt);

      // Upload config uniform
      this.uploadConfig(state, emitterX, emitterY, dt, spawnCount);

      // Upload camera VP for this emitter
      this.device.queue.writeBuffer(state.cameraBuffer, 0, cameraVP as Float32Array<ArrayBuffer>);

      // Reset alive counter (counter[0]) to 0 each frame
      this.device.queue.writeBuffer(state.counterBuffer, 0, new Uint32Array([0]));

      // --- Compute: simulate ---
      const simPass = encoder.beginComputePass();
      simPass.setPipeline(this.simulatePipeline);
      simPass.setBindGroup(0, state.simulateBindGroup!);
      simPass.dispatchWorkgroups(Math.ceil(state.config.maxParticles / 64));
      simPass.end();

      // --- Compute: spawn ---
      if (spawnCount > 0) {
        const spawnPass = encoder.beginComputePass();
        spawnPass.setPipeline(this.spawnPipeline);
        spawnPass.setBindGroup(0, state.simulateBindGroup!);
        spawnPass.dispatchWorkgroups(Math.ceil(spawnCount / 64));
        spawnPass.end();
      }

      // --- Render: instanced point sprites ---
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: swapchainView,
          loadOp: 'load',
          storeOp: 'store',
        }],
      });
      renderPass.setPipeline(this.renderPipeline);
      renderPass.setBindGroup(0, state.renderBindGroup!);
      renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
      renderPass.drawIndexed(4, state.config.maxParticles);
      renderPass.end();
    }
  }

  /** Destroy all emitters and shared resources. */
  destroy(): void {
    for (const [handle] of this.emitters) {
      this.destroyEmitter(handle as ParticleHandle);
    }
    this.indexBuffer?.destroy();
    this.indexBuffer = null;
    this.simulatePipeline = null;
    this.spawnPipeline = null;
    this.renderPipeline = null;
  }

  /** Pack the EmitterConfig into the 112-byte uniform buffer matching the WGSL layout. */
  private uploadConfig(
    state: EmitterState,
    emitterX: number,
    emitterY: number,
    dt: number,
    spawnCount: number,
  ): void {
    const cfg = state.config;
    // Layout: 26 f32-sized values + 2 padding = 28 values = 112 bytes
    const data = new ArrayBuffer(CONFIG_BUFFER_SIZE);
    const f32 = new Float32Array(data);
    const u32 = new Uint32Array(data);

    // vec2f emitterPos (offset 0)
    f32[0] = emitterX;
    f32[1] = emitterY;
    // f32 dt (offset 8)
    f32[2] = dt;
    // f32 emissionRate (offset 12)
    f32[3] = cfg.emissionRate;
    // f32 lifetimeMin (offset 16)
    f32[4] = cfg.lifetime[0];
    // f32 lifetimeMax (offset 20)
    f32[5] = cfg.lifetime[1];
    // f32 velocityMinX (offset 24)
    f32[6] = cfg.velocityMin[0];
    // f32 velocityMinY (offset 28)
    f32[7] = cfg.velocityMin[1];
    // f32 velocityMaxX (offset 32)
    f32[8] = cfg.velocityMax[0];
    // f32 velocityMaxY (offset 36)
    f32[9] = cfg.velocityMax[1];
    // colorStart RGBA (offset 40-52)
    f32[10] = cfg.colorStart[0];
    f32[11] = cfg.colorStart[1];
    f32[12] = cfg.colorStart[2];
    f32[13] = cfg.colorStart[3];
    // colorEnd RGBA (offset 56-68)
    f32[14] = cfg.colorEnd[0];
    f32[15] = cfg.colorEnd[1];
    f32[16] = cfg.colorEnd[2];
    f32[17] = cfg.colorEnd[3];
    // f32 sizeStart (offset 72)
    f32[18] = cfg.sizeStart;
    // f32 sizeEnd (offset 76)
    f32[19] = cfg.sizeEnd;
    // f32 gravityX (offset 80)
    f32[20] = cfg.gravity[0];
    // f32 gravityY (offset 84)
    f32[21] = cfg.gravity[1];
    // u32 maxParticles (offset 88)
    u32[22] = cfg.maxParticles;
    // u32 spawnCount (offset 92)
    u32[23] = spawnCount;
    // u32 _pad0 (offset 96)
    u32[24] = 0;
    // u32 _pad1 (offset 100)
    u32[25] = 0;
    // Extra padding to 112 bytes
    u32[26] = 0;
    u32[27] = 0;

    this.device.queue.writeBuffer(state.configBuffer, 0, data);
  }

  /** Create or recreate bind groups for an emitter. */
  private rebuildBindGroups(state: EmitterState): void {
    if (!this.simulatePipeline || !this.renderPipeline) return;

    // Compute bind group (shared by simulate and spawn)
    state.simulateBindGroup = this.device.createBindGroup({
      layout: this.simulatePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: state.particleBuffer } },
        { binding: 1, resource: { buffer: state.configBuffer } },
        { binding: 2, resource: { buffer: state.counterBuffer } },
      ],
    });

    // Render bind group
    state.renderBindGroup = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: state.particleBuffer } },
        { binding: 1, resource: { buffer: state.cameraBuffer } },
        { binding: 2, resource: { buffer: state.counterBuffer } },
      ],
    });
  }
}
