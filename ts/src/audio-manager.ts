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

  async load(url: string): Promise<SoundHandle> {
    this.init();
    return this.registry!.load(url);
  }

  async loadAll(
    urls: string[],
    opts?: { onProgress?: (loaded: number, total: number) => void },
  ): Promise<SoundHandle[]> {
    this.init();
    return this.registry!.loadAll(urls, opts);
  }

  play(handle: SoundHandle, opts?: PlaybackOptions): PlaybackId | null {
    this.init();
    const buffer = this.registry!.getBuffer(handle);
    if (!buffer) return null;
    return this.engine!.play(buffer, opts);
  }

  stop(id: PlaybackId): void {
    this.engine?.stop(id);
  }

  setVolume(id: PlaybackId, volume: number): void {
    this.engine?.setVolume(id, volume);
  }

  setPitch(id: PlaybackId, pitch: number): void {
    this.engine?.setPitch(id, pitch);
  }

  stopAll(): void {
    this.engine?.stopAll();
  }

  setSoundPosition(id: PlaybackId, x: number, y: number): void {
    this.engine?.setSoundPosition(id, x, y);
  }

  setListenerPosition(x: number, y: number): void {
    this.engine?.setListenerPosition(x, y);
  }
}
