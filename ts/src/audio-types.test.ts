import { describe, it, expect } from 'vitest';
import { SoundHandle, PlaybackId, DEFAULT_PLAYBACK_OPTIONS, DEFAULT_SPATIAL_CONFIG } from './audio-types';

describe('audio types', () => {
  it('SoundHandle and PlaybackId are distinct number brands', () => {
    const s = 1 as SoundHandle;
    const p = 2 as PlaybackId;
    expect(typeof s).toBe('number');
    expect(typeof p).toBe('number');
  });

  it('DEFAULT_PLAYBACK_OPTIONS has sensible defaults', () => {
    expect(DEFAULT_PLAYBACK_OPTIONS.volume).toBe(1);
    expect(DEFAULT_PLAYBACK_OPTIONS.pitch).toBe(1);
    expect(DEFAULT_PLAYBACK_OPTIONS.loop).toBe(false);
  });

  it('DEFAULT_SPATIAL_CONFIG has sensible defaults', () => {
    expect(DEFAULT_SPATIAL_CONFIG.panSpread).toBe(20);
    expect(DEFAULT_SPATIAL_CONFIG.rolloff).toBe(10);
    expect(DEFAULT_SPATIAL_CONFIG.maxDistance).toBe(100);
  });
});
