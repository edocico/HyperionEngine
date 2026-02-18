export interface FrameState {
  entityCount: number;
  transforms: Float32Array;    // 16 f32/entity
  bounds: Float32Array;        // 4 f32/entity
  renderMeta: Uint32Array;     // 2 u32/entity
  texIndices: Uint32Array;     // 1 u32/entity
  cameraViewProjection: Float32Array; // mat4x4
  canvasWidth: number;
  canvasHeight: number;
  deltaTime: number;
}

export interface RenderPass {
  readonly name: string;
  readonly reads: string[];
  readonly writes: string[];
  readonly optional: boolean;
  setup(device: GPUDevice, resources: import('./resource-pool').ResourcePool): void;
  prepare(device: GPUDevice, frame: FrameState): void;
  execute(encoder: GPUCommandEncoder, frame: FrameState,
          resources: import('./resource-pool').ResourcePool): void;
  resize(width: number, height: number): void;
  destroy(): void;
}
