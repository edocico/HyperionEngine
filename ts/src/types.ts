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
  };
}
