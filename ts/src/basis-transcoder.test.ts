import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BasisTranscoder,
  type TranscodeTarget,
} from './basis-transcoder';

describe('BasisTranscoder', () => {
  beforeEach(() => {
    // Reset singleton between tests
    BasisTranscoder['instance'] = null;
    BasisTranscoder['initPromise'] = null;
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

describe('BasisTranscoder singleton', () => {
  beforeEach(() => {
    BasisTranscoder['instance'] = null;
    BasisTranscoder['initPromise'] = null;
  });

  it('getInstance returns the same instance on repeated calls', async () => {
    // Mock the dynamic import via loadAndInit
    const mockModule = {
      initializeBasis: vi.fn(),
      KTX2File: vi.fn(),
    };
    BasisTranscoder['loadAndInit'] = vi.fn().mockResolvedValue(
      Object.assign(Object.create(BasisTranscoder.prototype), {
        module: mockModule,
      }),
    );
    // First call goes through loadAndInit
    const first = await BasisTranscoder.getInstance();
    // Set instance so the second call hits the fast path
    BasisTranscoder['instance'] = first;
    const second = await BasisTranscoder.getInstance();
    expect(first).toBe(second);
  });
});

describe('BasisTranscoder.transcode()', () => {
  function createMockKTX2File(
    overrides: Partial<Record<string, unknown>> = {},
  ) {
    return {
      isValid: vi.fn().mockReturnValue(true),
      getWidth: vi.fn().mockReturnValue(64),
      getHeight: vi.fn().mockReturnValue(64),
      getHasAlpha: vi.fn().mockReturnValue(false),
      getLevels: vi.fn().mockReturnValue(1),
      isUASTC: vi.fn().mockReturnValue(true),
      isETC1S: vi.fn().mockReturnValue(false),
      startTranscoding: vi.fn().mockReturnValue(true),
      getImageTranscodedSizeInBytes: vi.fn().mockReturnValue(64),
      transcodeImage: vi.fn().mockReturnValue(true),
      close: vi.fn(),
      delete: vi.fn(),
      ...overrides,
    };
  }

  function createTranscoderWithMock(
    mockFile: ReturnType<typeof createMockKTX2File>,
  ): BasisTranscoder {
    const mockModule = {
      initializeBasis: vi.fn(),
      KTX2File: vi.fn().mockImplementation(function () {
        return mockFile;
      }),
    };
    // Construct via reflection since constructor is private
    const transcoder = Object.create(
      BasisTranscoder.prototype,
    ) as BasisTranscoder;
    (transcoder as unknown as { module: typeof mockModule }).module =
      mockModule;
    return transcoder;
  }

  it('calls close() and delete() on success', () => {
    const mockFile = createMockKTX2File();
    const transcoder = createTranscoderWithMock(mockFile);
    transcoder.transcode(new Uint8Array(100), 'bc7');
    expect(mockFile.close).toHaveBeenCalledOnce();
    expect(mockFile.delete).toHaveBeenCalledOnce();
  });

  it('calls close() and delete() when transcodeImage fails', () => {
    const mockFile = createMockKTX2File({
      transcodeImage: vi.fn().mockReturnValue(false),
    });
    const transcoder = createTranscoderWithMock(mockFile);
    expect(() => transcoder.transcode(new Uint8Array(100), 'bc7')).toThrow(
      'transcodeImage',
    );
    expect(mockFile.close).toHaveBeenCalledOnce();
    expect(mockFile.delete).toHaveBeenCalledOnce();
  });

  it('throws descriptive error when isValid returns false', () => {
    const mockFile = createMockKTX2File({
      isValid: vi.fn().mockReturnValue(false),
    });
    const transcoder = createTranscoderWithMock(mockFile);
    expect(() =>
      transcoder.transcode(new Uint8Array(100), 'rgba8'),
    ).toThrow('invalid KTX2');
    expect(mockFile.close).toHaveBeenCalledOnce();
    expect(mockFile.delete).toHaveBeenCalledOnce();
  });

  it('returns correct TranscodeResult', () => {
    const mockFile = createMockKTX2File({
      getWidth: vi.fn().mockReturnValue(128),
      getHeight: vi.fn().mockReturnValue(128),
      getImageTranscodedSizeInBytes: vi.fn().mockReturnValue(256),
    });
    const transcoder = createTranscoderWithMock(mockFile);
    const result = transcoder.transcode(new Uint8Array(100), 'astc');
    expect(result.width).toBe(128);
    expect(result.height).toBe(128);
    expect(result.format).toBe('astc-4x4-unorm');
    expect(result.data).toBeInstanceOf(Uint8Array);
    expect(result.data.length).toBe(256);
  });
});
