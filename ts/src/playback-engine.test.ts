import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from './playback-engine';
import type { PlaybackId } from './audio-types';

function mockNode(overrides: Record<string, unknown> = {}) {
  return { connect: vi.fn().mockReturnThis(), disconnect: vi.fn(), ...overrides };
}

function mockSourceNode() {
  return mockNode({
    buffer: null as AudioBuffer | null,
    loop: false,
    playbackRate: { value: 1 },
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  });
}

function mockGainNode() {
  return mockNode({ gain: { value: 1 } });
}

function mockPannerNode() {
  return mockNode({ pan: { value: 0 } });
}

function mockAudioContext() {
  return {
    state: 'running' as AudioContextState,
    destination: {} as AudioDestinationNode,
    createBufferSource: vi.fn(() => mockSourceNode()),
    createGain: vi.fn(() => mockGainNode()),
    createStereoPanner: vi.fn(() => mockPannerNode()),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function mockBuffer(): AudioBuffer {
  return { duration: 1 } as AudioBuffer;
}

describe('PlaybackEngine', () => {
  it('play returns a PlaybackId', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    expect(typeof id).toBe('number');
  });

  it('play creates source -> gain -> panner -> master chain', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    eng.play(mockBuffer());
    expect(ctx.createBufferSource).toHaveBeenCalled();
    expect(ctx.createGain).toHaveBeenCalled();
    expect(ctx.createStereoPanner).toHaveBeenCalled();
  });

  it('play sets buffer on source node', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    const buf = mockBuffer();
    eng.play(buf);
    expect(source.buffer).toBe(buf);
  });

  it('play calls source.start()', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    eng.play(mockBuffer());
    expect(source.start).toHaveBeenCalled();
  });

  it('assigns incrementing PlaybackIds', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    const id1 = eng.play(mockBuffer());
    const id2 = eng.play(mockBuffer());
    expect(id2).toBe(id1 + 1);
  });

  it('activeCount reflects playing sounds', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    expect(eng.activeCount).toBe(0);
    eng.play(mockBuffer());
    expect(eng.activeCount).toBe(1);
    eng.play(mockBuffer());
    expect(eng.activeCount).toBe(2);
  });
});

describe('PlaybackEngine stop + volume', () => {
  it('stop removes active playback', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    expect(eng.activeCount).toBe(1);
    eng.stop(id);
    expect(eng.activeCount).toBe(0);
  });

  it('stop calls source.stop()', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.stop(id);
    expect(source.stop).toHaveBeenCalled();
  });

  it('stop is no-op for unknown id', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    expect(() => eng.stop(999 as PlaybackId)).not.toThrow();
  });

  it('setVolume changes gain value', () => {
    const ctx = mockAudioContext();
    const gainNode = mockGainNode();
    ctx.createGain = vi.fn(() => gainNode) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setVolume(id, 0.5);
    expect(gainNode.gain.value).toBe(0.5);
  });

  it('setVolume clamps to 0-1 range', () => {
    const ctx = mockAudioContext();
    const gainNode = mockGainNode();
    ctx.createGain = vi.fn(() => gainNode) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setVolume(id, -0.5);
    expect(gainNode.gain.value).toBe(0);
    eng.setVolume(id, 2.0);
    expect(gainNode.gain.value).toBe(1);
  });

  it('stopAll stops all active playbacks', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    eng.play(mockBuffer());
    eng.play(mockBuffer());
    eng.play(mockBuffer());
    expect(eng.activeCount).toBe(3);
    eng.stopAll();
    expect(eng.activeCount).toBe(0);
  });
});

describe('PlaybackEngine pitch + looping', () => {
  it('setPitch changes playbackRate', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setPitch(id, 1.5);
    expect(source.playbackRate.value).toBe(1.5);
  });

  it('setPitch clamps to positive values', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setPitch(id, -1);
    expect(source.playbackRate.value).toBe(0.01);
    eng.setPitch(id, 0);
    expect(source.playbackRate.value).toBe(0.01);
  });

  it('play with loop option sets source.loop', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    eng.play(mockBuffer(), { loop: true });
    expect(source.loop).toBe(true);
  });

  it('play with pitch option sets playbackRate', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    eng.play(mockBuffer(), { pitch: 0.5 });
    expect(source.playbackRate.value).toBe(0.5);
  });
});

describe('PlaybackEngine spatial audio', () => {
  it('setSoundPosition pans left when entity is left of listener', () => {
    const ctx = mockAudioContext();
    const panner = mockPannerNode();
    ctx.createStereoPanner = vi.fn(() => panner) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setListenerPosition(0, 0);
    eng.setSoundPosition(id, -10, 0);
    expect(panner.pan.value).toBeCloseTo(-0.5, 5);
  });

  it('setSoundPosition pans right when entity is right of listener', () => {
    const ctx = mockAudioContext();
    const panner = mockPannerNode();
    ctx.createStereoPanner = vi.fn(() => panner) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setListenerPosition(0, 0);
    eng.setSoundPosition(id, 20, 0);
    expect(panner.pan.value).toBeCloseTo(1.0, 5);
  });

  it('setSoundPosition attenuates volume by distance', () => {
    const ctx = mockAudioContext();
    const gainNode = mockGainNode();
    ctx.createGain = vi.fn(() => gainNode) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer(), { volume: 1 });
    eng.setListenerPosition(0, 0);
    eng.setSoundPosition(id, 10, 0);
    expect(gainNode.gain.value).toBeCloseTo(0.5, 5);
  });

  it('setSoundPosition silences sounds beyond maxDistance', () => {
    const ctx = mockAudioContext();
    const gainNode = mockGainNode();
    ctx.createGain = vi.fn(() => gainNode) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setListenerPosition(0, 0);
    eng.setSoundPosition(id, 200, 0);
    expect(gainNode.gain.value).toBe(0);
  });

  it('setListenerPosition updates all positioned sounds', () => {
    const ctx = mockAudioContext();
    const panner = mockPannerNode();
    ctx.createStereoPanner = vi.fn(() => panner) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setSoundPosition(id, 10, 0);
    eng.setListenerPosition(10, 0); // same position = pan 0
    expect(panner.pan.value).toBeCloseTo(0, 5);
  });
});
