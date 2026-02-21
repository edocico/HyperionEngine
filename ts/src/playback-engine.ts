import type { PlaybackId, PlaybackOptions } from './audio-types';
import { DEFAULT_PLAYBACK_OPTIONS } from './audio-types';

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

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
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

  setVolume(id: PlaybackId, volume: number): void {
    const p = this.playbacks.get(id);
    if (!p) return;
    const clamped = Math.max(0, Math.min(1, volume));
    p.baseVolume = clamped;
    p.gain.gain.value = clamped;
  }

  stopAll(): void {
    for (const id of [...this.playbacks.keys()]) {
      this.stop(id);
    }
  }

  get activeCount(): number {
    return this.playbacks.size;
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
