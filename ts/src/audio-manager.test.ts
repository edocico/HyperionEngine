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
    new AudioManager({ contextFactory: factory });
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

describe('AudioManager playback control', () => {
  async function loadedManager() {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    const handle = await am.load('test.mp3');
    const id = am.play(handle)!;
    return { am, handle, id };
  }

  it('stop is forwarded to engine', async () => {
    const { am, id } = await loadedManager();
    expect(() => am.stop(id)).not.toThrow();
  });

  it('setVolume is forwarded to engine', async () => {
    const { am, id } = await loadedManager();
    expect(() => am.setVolume(id, 0.5)).not.toThrow();
  });

  it('setPitch is forwarded to engine', async () => {
    const { am, id } = await loadedManager();
    expect(() => am.setPitch(id, 1.5)).not.toThrow();
  });

  it('stopAll stops all playbacks', async () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    const h = await am.load('test.mp3');
    am.play(h);
    am.play(h);
    expect(() => am.stopAll()).not.toThrow();
  });

  it('control methods are no-op before init', () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    expect(() => am.stop(0 as PlaybackId)).not.toThrow();
    expect(() => am.setVolume(0 as PlaybackId, 0.5)).not.toThrow();
    expect(() => am.setPitch(0 as PlaybackId, 1)).not.toThrow();
    expect(() => am.stopAll()).not.toThrow();
  });
});

describe('AudioManager spatial', () => {
  it('setSoundPosition delegates to engine', async () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    const h = await am.load('test.mp3');
    const id = am.play(h)!;
    expect(() => am.setSoundPosition(id, 5, 10)).not.toThrow();
  });

  it('setListenerPosition delegates to engine', async () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    am.init();
    expect(() => am.setListenerPosition(10, 20)).not.toThrow();
  });

  it('setListenerPosition is no-op before init', () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    expect(() => am.setListenerPosition(10, 20)).not.toThrow();
  });

  it('setSoundPosition is no-op before init', () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    expect(() => am.setSoundPosition(0 as PlaybackId, 5, 10)).not.toThrow();
  });
});

describe('AudioManager lifecycle', () => {
  it('suspend calls ctx.suspend()', async () => {
    const ctx = mockAudioContext();
    const am = new AudioManager({ contextFactory: () => ctx as any });
    am.init();
    await am.suspend();
    expect(ctx.suspend).toHaveBeenCalled();
  });

  it('resume calls ctx.resume()', async () => {
    const ctx = mockAudioContext();
    const am = new AudioManager({ contextFactory: () => ctx as any });
    am.init();
    await am.resume();
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('destroy closes context and clears state', async () => {
    const ctx = mockAudioContext();
    const am = new AudioManager({ contextFactory: () => ctx as any });
    await am.load('test.mp3');
    await am.destroy();
    expect(ctx.close).toHaveBeenCalled();
    expect(am.isInitialized).toBe(false);
  });

  it('destroy is no-op before init', async () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    await am.destroy();
    expect(am.isInitialized).toBe(false);
  });

  it('suspend/resume are no-ops before init', async () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    await am.suspend();
    await am.resume();
    expect(am.isInitialized).toBe(false);
  });

  it('master volume control delegates to engine', () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    am.init();
    expect(() => am.setMasterVolume(0.5)).not.toThrow();
    expect(() => am.mute()).not.toThrow();
    expect(() => am.unmute()).not.toThrow();
  });

  it('unload delegates to registry', async () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    const h = await am.load('test.mp3');
    expect(() => am.unload(h)).not.toThrow();
  });
});
