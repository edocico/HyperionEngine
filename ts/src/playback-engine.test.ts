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
