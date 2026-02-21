import type { SoundHandle, PlaybackId, PlaybackOptions, SpatialConfig } from './audio-types';
import { DEFAULT_SPATIAL_CONFIG } from './audio-types';
import { SoundRegistry } from './sound-registry';
import { PlaybackEngine } from './playback-engine';

export interface AudioManagerOptions {
  /** Factory for creating AudioContext. Overridable for testing. */
  contextFactory?: () => AudioContext;
  /** Spatial audio configuration. */
  spatial?: Partial<SpatialConfig>;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private registry: SoundRegistry | null = null;
  private engine: PlaybackEngine | null = null;
  private readonly contextFactory: () => AudioContext;
  private readonly spatialConfig: SpatialConfig;

  constructor(opts?: AudioManagerOptions) {
    this.contextFactory = opts?.contextFactory ?? (() => new AudioContext());
    this.spatialConfig = { ...DEFAULT_SPATIAL_CONFIG, ...opts?.spatial };
  }

  get isInitialized(): boolean {
    return this.ctx !== null;
  }

  init(): void {
    if (this.ctx) return;
    this.ctx = this.contextFactory();
    this.registry = new SoundRegistry(
      (data) => this.ctx!.decodeAudioData(data),
      async (url) => {
        const resp = await fetch(url);
        return resp.arrayBuffer();
      },
    );
    this.engine = new PlaybackEngine(this.ctx);
  }
}
