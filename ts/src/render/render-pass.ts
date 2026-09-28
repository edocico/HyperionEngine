export interface FrameState {
  entityCount: number;
  transforms: Float32Array;    // 16 f32/entity
  bounds: Float32Array;        // 4 f32/entity
  renderMeta: Uint32Array;     // 2 u32/entity
  texIndices: Uint32Array;     // 1 u32/entity
  primParams: Float32Array;    // 8 f32/entity
  cameraViewProjection: Float32Array; // mat4x4
  canvasWidth: number;
  canvasHeight: number;
  deltaTime: number;
  /** Physics debug lines (Phase 16): 8 f32 per line [ax,ay,bx,by,r,g,b,a]. */
  physicsDebugLines?: Float32Array;
  /**
   * Ambient light (Phase 17): r, g, b, intensity. The light buffer is cleared
   * to rgb × intensity. From `GPURenderState`, i.e. from WASM.
   */
  ambient?: readonly [number, number, number, number];
  /** Sphere-march steps per shadowed light pixel (`LightingQuality.shadowSteps`). */
  shadowSteps?: number;
  /**
   * Light layers (design 2026-09-26): the light groups and SDF sets of this
   * frame, from `deriveLightGroups`. Set by the renderer only while the live
   * graph is lit.
   */
  lightGroups?: import('./light-groups').LightGroups;
  /**
   * Transparent sort (phase 5b): live rows with the Transparent bit, already
   * normalised (`normalizeTransparentCount`: a missing count becomes
   * `entityCount`). It bounds the sort's gather; 0 skips the sort.
   */
  transparentCount: number;
}

export interface RenderPass {
  readonly name: string;
  readonly reads: string[];
  readonly writes: string[];
  readonly optional: boolean;
  setup(device: GPUDevice, resources: import('./resource-pool').ResourcePool): void;
  prepare(device: GPUDevice, frame: FrameState): void;
  /**
   * @param mark Only for a pass with {@link profileStages}, and only while the
   *   frame is measured: call it once before each stage the pass named.
   */
  execute(encoder: GPUCommandEncoder, frame: FrameState,
          resources: import('./resource-pool').ResourcePool,
          mark?: (encoder: GPUCommandEncoder) => void): void;
  /**
   * The stages this pass will run this frame, in order, for the GPU profiler.
   * A pass that has them marks each stage itself (see `mark`), and they are
   * reported as `name/stage`, summed when a name repeats in a frame.
   */
  profileStages?(frame: FrameState): readonly string[];
  resize(width: number, height: number): void;
  destroy(): void;
}
