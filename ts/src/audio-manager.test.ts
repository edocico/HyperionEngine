import { describe, it, expect, vi } from 'vitest';
import { AudioManager } from './audio-manager';
import type { PlaybackId } from './audio-types';

vi.stubGlobal('fetch', vi.fn(async () => ({
  arrayBuffer: vi.fn(async () => new ArrayBuffer(1024)),
})));

function mockAudioContext() {
  return {
    state: 'running' as AudioContextState,
    destination: {} as AudioDestinationNode,
    createBufferSource: vi.fn(() => ({
      buffer: null,
      loop: false,
      playbackRate: { value: 1 },
      connect: vi.fn().mockReturnThis(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    })),
    createGain: vi.fn(() => ({
      gain: { value: 1 },
      connect: vi.fn().mockReturnThis(),
      disconnect: vi.fn(),
    })),
    createStereoPanner: vi.fn(() => ({
      pan: { value: 0 },
      connect: vi.fn().mockReturnThis(),
      disconnect: vi.fn(),
    })),
    decodeAudioData: vi.fn(async () => ({
      duration: 1,
      numberOfChannels: 2,
      sampleRate: 44100,
      length: 44100,
    })),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

describe('AudioManager', () => {
  it('constructs without creating AudioContext', () => {
    const factory = vi.fn(() => mockAudioContext() as any);
    const am = new AudioManager({ contextFactory: factory });
    expect(factory).not.toHaveBeenCalled();
  });

  it('isInitialized is false before first use', () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    expect(am.isInitialized).toBe(false);
  });

  it('init() creates the AudioContext', () => {
    const factory = vi.fn(() => mockAudioContext() as any);
    const am = new AudioManager({ contextFactory: factory });
    am.init();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(am.isInitialized).toBe(true);
  });

  it('init() is idempotent', () => {
    const factory = vi.fn(() => mockAudioContext() as any);
    const am = new AudioManager({ contextFactory: factory });
    am.init();
    am.init();
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('AudioManager load + play', () => {
  function createManager() {
    return new AudioManager({ contextFactory: () => mockAudioContext() as any });
  }

  it('load auto-initializes if needed', async () => {
    const am = createManager();
    expect(am.isInitialized).toBe(false);
    await am.load('test.mp3');
    expect(am.isInitialized).toBe(true);
  });

  it('load returns a SoundHandle', async () => {
    const am = createManager();
    const handle = await am.load('test.mp3');
    expect(typeof handle).toBe('number');
  });

  it('play returns null for unknown handle', () => {
    const am = createManager();
    am.init();
    const id = am.play(999 as any);
    expect(id).toBeNull();
  });

  it('play returns PlaybackId after successful load', async () => {
    const am = createManager();
    const handle = await am.load('test.mp3');
    const id = am.play(handle);
    expect(typeof id).toBe('number');
  });

  it('loadAll loads multiple sounds', async () => {
    const am = createManager();
    const handles = await am.loadAll(['a.mp3', 'b.mp3']);
    expect(handles).toHaveLength(2);
  });
});
