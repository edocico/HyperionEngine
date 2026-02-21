/** Opaque handle to a loaded sound. Returned by SoundRegistry.load(). */
export type SoundHandle = number & { readonly __brand: 'SoundHandle' };

/** Opaque handle to an active playback. Returned by PlaybackEngine.play(). */
export type PlaybackId = number & { readonly __brand: 'PlaybackId' };

/** Options for starting a sound playback. */
export interface PlaybackOptions {
  /** Volume multiplier (0 = silent, 1 = full). Default: 1. */
  volume?: number;
  /** Pitch multiplier (0.5 = half speed, 2 = double). Default: 1. */
  pitch?: number;
  /** Whether to loop the sound. Default: false. */
  loop?: boolean;
}

/** Spatial audio configuration for distance attenuation and panning. */
export interface SpatialConfig {
  /** World-unit distance at which pan reaches +/-1 (hard left/right). Default: 20. */
  panSpread: number;
  /** Distance rolloff factor for volume attenuation. Default: 10. */
  rolloff: number;
  /** Maximum audible distance. Sounds beyond this are silent. Default: 100. */
  maxDistance: number;
}

export const DEFAULT_PLAYBACK_OPTIONS: Required<PlaybackOptions> = {
  volume: 1,
  pitch: 1,
  loop: false,
};

export const DEFAULT_SPATIAL_CONFIG: SpatialConfig = {
  panSpread: 20,
  rolloff: 10,
  maxDistance: 100,
};
