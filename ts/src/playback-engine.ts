import type { PlaybackId, PlaybackOptions, SpatialConfig } from './audio-types';
import { DEFAULT_PLAYBACK_OPTIONS, DEFAULT_SPATIAL_CONFIG } from './audio-types';

interface ActivePlayback {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode;
  baseVolume: number;
  position: [number, number] | null;
}

export class PlaybackEngine {
  private readonly ctx: AudioContext;
  private readonly masterGain: GainNode;
  private readonly playbacks = new Map<PlaybackId, ActivePlayback>();
  private nextId = 0;
  private _muted = false;
  private _preMuteVolume = 1;
  private listenerX = 0;
  private listenerY = 0;
  private spatialConfig: SpatialConfig = { ...DEFAULT_SPATIAL_CONFIG };

  constructor(ctx: AudioContext, spatial?: SpatialConfig) {
    this.ctx = ctx;
    if (spatial) this.spatialConfig = spatial;
    this.masterGain = ctx.createGain();
    this.masterGain.connect(ctx.destination);
  }

  play(buffer: AudioBuffer, opts?: PlaybackOptions): PlaybackId {
    const o = { ...DEFAULT_PLAYBACK_OPTIONS, ...opts };
    const id = this.nextId++ as PlaybackId;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = o.loop;
    source.playbackRate.value = o.pitch;

    const gain = this.ctx.createGain();
    gain.gain.value = o.volume;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = 0;

    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.masterGain);

    source.onended = () => { this.cleanup(id); };
    source.start();

    this.playbacks.set(id, { source, gain, panner, baseVolume: o.volume, position: null });
    return id;
  }

  stop(id: PlaybackId): void {
    const p = this.playbacks.get(id);
    if (!p) return;
    try { p.source.stop(); } catch { /* already stopped */ }
    this.cleanup(id);
  }

  setPitch(id: PlaybackId, pitch: number): void {
    const p = this.playbacks.get(id);
    if (!p) return;
    p.source.playbackRate.value = Math.max(0.01, pitch);
  }

  setVolume(id: PlaybackId, volume: number): void {
    const p = this.playbacks.get(id);
    if (!p) return;
    const clamped = Math.max(0, Math.min(1, volume));
    p.baseVolume = clamped;
    if (p.position) {
      this.applySpatial(p);
    } else {
      p.gain.gain.value = clamped;
    }
  }

  setListenerPosition(x: number, y: number): void {
    this.listenerX = x;
    this.listenerY = y;
    for (const [, p] of this.playbacks) {
      if (p.position) this.applySpatial(p);
    }
  }

  setSoundPosition(id: PlaybackId, x: number, y: number): void {
    const p = this.playbacks.get(id);
    if (!p) return;
    p.position = [x, y];
    this.applySpatial(p);
  }

  get masterVolume(): number {
    return this.masterGain.gain.value;
  }

  get isMuted(): boolean {
    return this._muted;
  }

  setMasterVolume(volume: number): void {
    this.masterGain.gain.value = Math.max(0, Math.min(1, volume));
    if (!this._muted) {
      this._preMuteVolume = this.masterGain.gain.value;
    }
  }

  mute(): void {
    if (!this._muted) {
      this._preMuteVolume = this.masterGain.gain.value;
    }
    this._muted = true;
    this.masterGain.gain.value = 0;
  }

  unmute(): void {
    this._muted = false;
    this.masterGain.gain.value = this._preMuteVolume;
  }

  stopAll(): void {
    for (const id of [...this.playbacks.keys()]) {
      this.stop(id);
    }
  }

  destroy(): void {
    this.stopAll();
    this.masterGain.disconnect();
  }

  get activeCount(): number {
    return this.playbacks.size;
  }

  private applySpatial(p: ActivePlayback): void {
    if (!p.position) return;
    const [sx, sy] = p.position;
    const dx = sx - this.listenerX;
    const dy = sy - this.listenerY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    p.panner.pan.value = Math.max(-1, Math.min(1, dx / this.spatialConfig.panSpread));

    if (distance > this.spatialConfig.maxDistance) {
      p.gain.gain.value = 0;
    } else {
      p.gain.gain.value = p.baseVolume / (1 + distance / this.spatialConfig.rolloff);
    }
  }

  private cleanup(id: PlaybackId): void {
    const p = this.playbacks.get(id);
    if (!p) return;
    p.source.disconnect();
    p.gain.disconnect();
    p.panner.disconnect();
    this.playbacks.delete(id);
  }
}
