import type { BackpressureMode } from './backpressure';

/** Opaque texture handle returned by engine.loadTexture(). */
export type TextureHandle = number;

/** Configuration for Hyperion.create(). */
export interface HyperionConfig {
  canvas: HTMLCanvasElement;
  maxEntities?: number;
  commandBufferSize?: number;
  backpressure?: BackpressureMode;
  fixedTimestep?: number;
  preferredMode?: 'auto' | 'A' | 'B' | 'C';
  onModeChange?: (from: string, to: string, reason: string) => void;
  onOverflow?: (dropped: number) => void;
  onDeviceLost?: (reason: string) => void;
  /** Dirty ratio threshold for scatter upload vs full upload. Default 0.3 */
  scatterThreshold?: number;
  /** Enable progressive texture streaming via HTTP Range requests. Default: false. */
  textureStreaming?: boolean;
  /** Max bytes fetched per frame for texture streaming. Default: 256KB. */
  streamingBudgetBytesPerFrame?: number;
}

/** Resolved config with all defaults applied. */
export interface ResolvedConfig {
  canvas: HTMLCanvasElement;
  maxEntities: number;
  commandBufferSize: number;
  backpressure: BackpressureMode;
  fixedTimestep: number;
  preferredMode: 'auto' | 'A' | 'B' | 'C';
  onModeChange?: (from: string, to: string, reason: string) => void;
  onOverflow?: (dropped: number) => void;
  onDeviceLost?: (reason: string) => void;
  scatterThreshold: number;
  textureStreaming: boolean;
  streamingBudgetBytesPerFrame: number;
}

/** Live engine statistics. */
export interface HyperionStats {
  fps: number;
  entityCount: number;
  mode: string;
  tickCount: number;
  overflowCount: number;
  frameDt: number;
  frameTimeAvg: number;
  frameTimeMax: number;
}

/** Memory statistics (subset of stats). */
export interface MemoryStats {
  wasmHeapBytes: number;
  gpuBufferBytes: number;
  entityMapUtilization: number;
  tierUtilization: number[];
}

/**
 * The largest external entity id the engine accepts: the WASM `EntityMap`
 * (`MAX_EXTERNAL_ID` in command_processor.rs, 2^20 - 1) rejects a spawn past
 * it without any error on the TS side. Freed ids are reused under quarantine
 * (EntityIdAllocator), so this bounds the entities that are live or whose
 * despawn is not yet processed, not the spawns of a session.
 */
export const MAX_EXTERNAL_ID = 1_048_575;

/** Options of `engine.spawn()`, `engine.raw.spawn()` and a prefab template. */
export interface SpawnOptions {
  /**
   * `'3d'` (the default): Position + Rotation + Scale. `'2d'`: the compact
   * Transform2D archetype (x, y, angle, sx, sy — 20 bytes of ECS component,
   * against 40), drawn at z = 0. The GPU upload does not shrink: every row is
   * still a 16-float matrix (a root 2D row travels as scatter "format 0" in
   * Mode C, rebuilt on the GPU from 6 of those words, but in the same 16).
   * What only 3D has — a z, `sz`, `vz`, a quaternion tilted off the Z axis —
   * is ignored on it; an `EntityHandle` says so once, in dev builds (the raw
   * API does not check).
   */
  mode?: '2d' | '3d';
}

/** Whether `options` asks for a 2D entity. Throws on an unknown mode. */
export function spawnIs2D(options?: SpawnOptions): boolean {
  const mode = options?.mode ?? '3d';
  if (mode !== '2d' && mode !== '3d') throw new Error(`Unknown spawn mode '${String(mode)}': use '2d' or '3d'`);
  return mode === '2d';
}

/** Compaction options for engine.compact(). */
export interface CompactOptions {
  entityMap?: boolean;
  textures?: boolean;
  renderState?: boolean;
  aggressive?: boolean;
}

export function validateConfig(config: HyperionConfig): ResolvedConfig {
  if (!config.canvas) {
    throw new Error('canvas is required');
  }
  const maxEntities = config.maxEntities ?? 100_000;
  if (maxEntities <= 0) {
    throw new Error('maxEntities must be > 0');
  }
  return {
    canvas: config.canvas,
    maxEntities,
    commandBufferSize: config.commandBufferSize ?? 64 * 1024,
    backpressure: config.backpressure ?? 'retry-queue',
    fixedTimestep: config.fixedTimestep ?? 1 / 60,
    preferredMode: config.preferredMode ?? 'auto',
    onModeChange: config.onModeChange,
    onOverflow: config.onOverflow,
    onDeviceLost: config.onDeviceLost,
    scatterThreshold: config.scatterThreshold ?? 0.3,
    textureStreaming: config.textureStreaming ?? false,
    streamingBudgetBytesPerFrame: config.streamingBudgetBytesPerFrame ?? 256 * 1024,
  };
}
