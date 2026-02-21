import { describe, it, expect, vi } from 'vitest';
import { SoundRegistry } from './sound-registry';
import type { SoundHandle } from './audio-types';

function mockAudioBuffer(duration = 1, channels = 2, sampleRate = 44100): AudioBuffer {
  return {
    duration,
    numberOfChannels: channels,
    sampleRate,
    length: duration * sampleRate,
    getChannelData: vi.fn(() => new Float32Array(duration * sampleRate)),
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

function mockDecoder(): (data: ArrayBuffer) => Promise<AudioBuffer> {
  return vi.fn(async () => mockAudioBuffer());
}

function mockFetcher(): (url: string) => Promise<ArrayBuffer> {
  return vi.fn(async () => new ArrayBuffer(1024));
}

describe('SoundRegistry', () => {
  it('load returns a SoundHandle', async () => {
    const reg = new SoundRegistry(mockDecoder(), mockFetcher());
    const handle = await reg.load('test.mp3');
    expect(typeof handle).toBe('number');
  });

  it('load calls fetch then decode', async () => {
    const decode = mockDecoder();
    const fetch = mockFetcher();
    const reg = new SoundRegistry(decode, fetch);
    await reg.load('sfx/click.ogg');
    expect(fetch).toHaveBeenCalledWith('sfx/click.ogg');
    expect(decode).toHaveBeenCalled();
  });

  it('getBuffer returns the decoded AudioBuffer', async () => {
    const buf = mockAudioBuffer(2);
    const decode = vi.fn(async () => buf);
    const reg = new SoundRegistry(decode, mockFetcher());
    const handle = await reg.load('test.mp3');
    expect(reg.getBuffer(handle)).toBe(buf);
  });

  it('getBuffer returns undefined for unknown handle', () => {
    const reg = new SoundRegistry(mockDecoder(), mockFetcher());
    expect(reg.getBuffer(999 as SoundHandle)).toBeUndefined();
  });

  it('assigns incrementing handles', async () => {
    const reg = new SoundRegistry(mockDecoder(), mockFetcher());
    const h1 = await reg.load('a.mp3');
    const h2 = await reg.load('b.mp3');
    expect(h2).toBe(h1 + 1);
  });

  it('deduplicates by URL', async () => {
    const decode = mockDecoder();
    const reg = new SoundRegistry(decode, mockFetcher());
    const h1 = await reg.load('same.mp3');
    const h2 = await reg.load('same.mp3');
    expect(h1).toBe(h2);
    expect(decode).toHaveBeenCalledTimes(1);
  });
});
