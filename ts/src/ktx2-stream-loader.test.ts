import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KTX2StreamLoader } from './ktx2-stream-loader';

// KTX2 magic bytes
const KTX2_MAGIC = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function createMockKTX2Header(
  opts: {
    vkFormat?: number;
    width?: number;
    height?: number;
    levels?: number;
    supercompression?: number;
    sgdOffset?: number;
    sgdLength?: number;
  } = {},
): ArrayBuffer {
  const vkFormat = opts.vkFormat ?? 141; // VK_FORMAT_BC7_SRGB_BLOCK
  const width = opts.width ?? 256;
  const height = opts.height ?? 256;
  const levelCount = opts.levels ?? 1;
  const supercompression = opts.supercompression ?? 0;
  const sgdOffset = opts.sgdOffset ?? 0;
  const sgdLength = opts.sgdLength ?? 0;

  // Header: 80 bytes + level index (24 bytes per level)
  const headerSize = 80 + levelCount * 24;
  const buf = new ArrayBuffer(Math.max(headerSize, 256));
  const u8 = new Uint8Array(buf);
  const view = new DataView(buf);

  // Magic
  u8.set(KTX2_MAGIC, 0);
  // vkFormat (offset 12)
  view.setUint32(12, vkFormat, true);
  // typeSize (offset 16)
  view.setUint32(16, 1, true);
  // pixelWidth (offset 20)
  view.setUint32(20, width, true);
  // pixelHeight (offset 24)
  view.setUint32(24, height, true);
  // pixelDepth (offset 28)
  view.setUint32(28, 0, true);
  // layerCount (offset 32)
  view.setUint32(32, 0, true);
  // faceCount (offset 36)
  view.setUint32(36, 1, true);
  // levelCount (offset 40)
  view.setUint32(40, levelCount, true);
  // supercompressionScheme (offset 44)
  view.setUint32(44, supercompression, true);

  // Index section (starts at 48):
  // dfdByteOffset (4), dfdByteLength (4), kvdByteOffset (4), kvdByteLength (4)
  // sgdByteOffset (8), sgdByteLength (8) — these are u64 (but we only write low 32)
  view.setUint32(48, 0, true); // dfdByteOffset
  view.setUint32(52, 0, true); // dfdByteLength
  view.setUint32(56, 0, true); // kvdByteOffset
  view.setUint32(60, 0, true); // kvdByteLength
  // sgdByteOffset as u64 (offset 64)
  view.setUint32(64, sgdOffset, true);
  view.setUint32(68, 0, true); // high 32 bits
  // sgdByteLength as u64 (offset 72)
  view.setUint32(72, sgdLength, true);
  view.setUint32(76, 0, true); // high 32 bits

  // Level index (starts at 80): each level = byteOffset(8) + byteLength(8) + uncompressedByteLength(8)
  for (let i = 0; i < levelCount; i++) {
    const base = 80 + i * 24;
    view.setUint32(base, 1000 + i * 500, true); // byteOffset (low 32)
    view.setUint32(base + 4, 0, true); // byteOffset (high 32)
    view.setUint32(base + 8, 500, true); // byteLength (low 32)
    view.setUint32(base + 12, 0, true); // byteLength (high 32)
    view.setUint32(base + 16, 600, true); // uncompressedByteLength (low 32)
    view.setUint32(base + 20, 0, true); // uncompressedByteLength (high 32)
  }

  return buf;
}

describe('KTX2StreamLoader', () => {
  let loader: KTX2StreamLoader;

  beforeEach(() => {
    loader = new KTX2StreamLoader();
    vi.restoreAllMocks();
  });

  it('parseHeader extracts vkFormat and dimensions', () => {
    const buf = createMockKTX2Header({ vkFormat: 141, width: 512, height: 512, levels: 3 });
    const header = loader.parseHeader(buf);
    expect(header.vkFormat).toBe(141);
    expect(header.pixelWidth).toBe(512);
    expect(header.pixelHeight).toBe(512);
    expect(header.levelCount).toBe(3);
    expect(header.levels).toHaveLength(3);
  });

  it('parseHeader reads level index', () => {
    const buf = createMockKTX2Header({ levels: 2 });
    const header = loader.parseHeader(buf);
    expect(header.levels[0].byteOffset).toBe(1000);
    expect(header.levels[0].byteLength).toBe(500);
    expect(header.levels[0].uncompressedByteLength).toBe(600);
    expect(header.levels[1].byteOffset).toBe(1500);
  });

  it('parseHeader reads supercompression and SGD', () => {
    const buf = createMockKTX2Header({ supercompression: 1, sgdOffset: 200, sgdLength: 64 });
    const header = loader.parseHeader(buf);
    expect(header.supercompressionScheme).toBe(1);
    expect(header.sgdByteOffset).toBe(200);
    expect(header.sgdByteLength).toBe(64);
  });

  it('parseHeader throws on buffer too small for header', () => {
    const buf = new ArrayBuffer(40);
    expect(() => loader.parseHeader(buf)).toThrow(/too small for header/);
  });

  it('parseHeader throws on invalid magic bytes', () => {
    const buf = new ArrayBuffer(256);
    expect(() => loader.parseHeader(buf)).toThrow(/invalid magic/);
  });

  it('isRangeSupported returns true with Accept-Ranges', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        headers: new Headers({ 'Accept-Ranges': 'bytes' }),
      }),
    );
    expect(await loader.isRangeSupported('test.ktx2')).toBe(true);
  });

  it('isRangeSupported returns false without header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        headers: new Headers(),
      }),
    );
    expect(await loader.isRangeSupported('test.ktx2')).toBe(false);
  });

  it('isRangeSupported returns false on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect(await loader.isRangeSupported('test.ktx2')).toBe(false);
  });

  it('fetchHeader uses Range request', async () => {
    const mockBuf = createMockKTX2Header({ levels: 1 });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        arrayBuffer: () => Promise.resolve(mockBuf),
      }),
    );
    const header = await loader.fetchHeader('test.ktx2');
    expect(header.levelCount).toBe(1);
    expect(fetch).toHaveBeenCalledWith('test.ktx2', { headers: { Range: 'bytes=0-255' } });
  });

  it('fetchSGD returns empty buffer when sgdByteLength is 0', async () => {
    const header = loader.parseHeader(createMockKTX2Header({ sgdLength: 0 }));
    const sgd = await loader.fetchSGD('test.ktx2', header);
    expect(sgd.byteLength).toBe(0);
  });

  it('fetchSGD requests correct byte range', async () => {
    const mockData = new ArrayBuffer(64);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        arrayBuffer: () => Promise.resolve(mockData),
      }),
    );
    const header = loader.parseHeader(createMockKTX2Header({ sgdOffset: 200, sgdLength: 64 }));
    await loader.fetchSGD('test.ktx2', header);
    expect(fetch).toHaveBeenCalledWith('test.ktx2', {
      headers: { Range: 'bytes=200-263' },
    });
  });

  it('fetchMipLevel requests correct byte range', async () => {
    const mockData = new ArrayBuffer(500);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        arrayBuffer: () => Promise.resolve(mockData),
      }),
    );
    const header = loader.parseHeader(createMockKTX2Header({ levels: 2 }));
    await loader.fetchMipLevel('test.ktx2', header, 0);
    expect(fetch).toHaveBeenCalledWith('test.ktx2', {
      headers: { Range: 'bytes=1000-1499' },
    });
  });

  it('fetchMipLevel throws on out-of-range level', async () => {
    const header = loader.parseHeader(createMockKTX2Header({ levels: 2 }));
    await expect(loader.fetchMipLevel('test.ktx2', header, 5)).rejects.toThrow(/out of range/);
    await expect(loader.fetchMipLevel('test.ktx2', header, -1)).rejects.toThrow(/out of range/);
  });
});
