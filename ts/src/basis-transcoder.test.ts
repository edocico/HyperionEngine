import { describe, it, expect, beforeEach } from 'vitest';
import {
  BasisTranscoder,
  type TranscodeTarget,
} from './basis-transcoder';

describe('BasisTranscoder', () => {
  beforeEach(() => {
    // Reset singleton between tests
    BasisTranscoder['instance'] = null;
    BasisTranscoder['modulePromise'] = null;
  });

  it('exports TranscodeTarget type values', () => {
    const targets: TranscodeTarget[] = ['bc7', 'astc', 'rgba8'];
    expect(targets).toHaveLength(3);
  });

  it('mapTargetToGPUFormat maps correctly', () => {
    expect(BasisTranscoder.mapTargetToGPUFormat('bc7')).toBe(
      'bc7-rgba-unorm',
    );
    expect(BasisTranscoder.mapTargetToGPUFormat('astc')).toBe(
      'astc-4x4-unorm',
    );
    expect(BasisTranscoder.mapTargetToGPUFormat('rgba8')).toBe('rgba8unorm');
  });

  it('mapTargetToBasisFormat maps to correct enum values', () => {
    // cTFBC7 = 6, cTFASTC_4x4 = 10, cTFRGBA32 = 13
    expect(BasisTranscoder.mapTargetToBasisFormat('bc7')).toBe(6);
    expect(BasisTranscoder.mapTargetToBasisFormat('astc')).toBe(10);
    expect(BasisTranscoder.mapTargetToBasisFormat('rgba8')).toBe(13);
  });

  it('blockBytesPerRow calculates correctly for BC7', () => {
    // 256px wide / 4 blocks * 16 bytes = 1024
    expect(BasisTranscoder.blockBytesPerRow(256, 'bc7')).toBe(1024);
    expect(BasisTranscoder.blockBytesPerRow(64, 'bc7')).toBe(256);
  });

  it('blockBytesPerRow calculates correctly for ASTC', () => {
    // Same block size as BC7: 4x4, 16 bytes
    expect(BasisTranscoder.blockBytesPerRow(256, 'astc')).toBe(1024);
  });

  it('blockBytesPerRow returns pixel-based for rgba8', () => {
    // 256 * 4 = 1024
    expect(BasisTranscoder.blockBytesPerRow(256, 'rgba8')).toBe(1024);
  });
});
