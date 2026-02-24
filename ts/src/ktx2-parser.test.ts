import { describe, it, expect } from 'vitest';
import { parseKTX2, KTX2_MAGIC } from './ktx2-parser';

/** Build a minimal valid KTX2 buffer with given header fields. */
function buildKTX2Buffer(opts: {
  vkFormat?: number;
  pixelWidth?: number;
  pixelHeight?: number;
  supercompressionScheme?: number;
  levelCount?: number;
  /** Raw level 0 data bytes */
  levelData?: Uint8Array;
} = {}): ArrayBuffer {
  const {
    vkFormat = 0,
    pixelWidth = 8,
    pixelHeight = 8,
    supercompressionScheme = 0,
    levelCount = 1,
    levelData = new Uint8Array(64),
  } = opts;

  const levelIndexSize = levelCount * 24;
  const headerSize = 80;
  const dataOffset = headerSize + levelIndexSize;
  const totalSize = dataOffset + levelData.byteLength;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  bytes.set(KTX2_MAGIC, 0);
  view.setUint32(12, vkFormat, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, pixelWidth, true);
  view.setUint32(24, pixelHeight, true);
  view.setUint32(28, 0, true);
  view.setUint32(32, 0, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, levelCount, true);
  view.setUint32(44, supercompressionScheme, true);

  view.setBigUint64(headerSize, BigInt(dataOffset), true);
  view.setBigUint64(headerSize + 8, BigInt(levelData.byteLength), true);
  view.setBigUint64(headerSize + 16, BigInt(levelData.byteLength), true);

  bytes.set(levelData, dataOffset);
  return buf;
}

describe('KTX2_MAGIC', () => {
  it('is 12 bytes', () => {
    expect(KTX2_MAGIC.length).toBe(12);
  });
});

describe('parseKTX2', () => {
  it('parses a valid KTX2 header', () => {
    const buf = buildKTX2Buffer({
      vkFormat: 145,
      pixelWidth: 256,
      pixelHeight: 256,
      supercompressionScheme: 0,
    });
    const result = parseKTX2(buf);
    expect(result.vkFormat).toBe(145);
    expect(result.pixelWidth).toBe(256);
    expect(result.pixelHeight).toBe(256);
    expect(result.supercompressionScheme).toBe(0);
    expect(result.levels).toHaveLength(1);
  });

  it('extracts level data offset and length', () => {
    const levelData = new Uint8Array(128);
    levelData.fill(0xAB);
    const buf = buildKTX2Buffer({ levelData });
    const result = parseKTX2(buf);
    expect(result.levels[0].length).toBe(128);
    const slice = new Uint8Array(result.data, result.levels[0].offset, result.levels[0].length);
    expect(slice[0]).toBe(0xAB);
  });

  it('parses BasisLZ supercompression scheme', () => {
    const buf = buildKTX2Buffer({ supercompressionScheme: 1 });
    const result = parseKTX2(buf);
    expect(result.supercompressionScheme).toBe(1);
  });

  it('throws on invalid magic bytes', () => {
    const buf = new ArrayBuffer(128);
    expect(() => parseKTX2(buf)).toThrow(/invalid KTX2/i);
  });

  it('throws on truncated buffer (< 80 bytes)', () => {
    const buf = new ArrayBuffer(40);
    const bytes = new Uint8Array(buf);
    bytes.set(KTX2_MAGIC, 0);
    expect(() => parseKTX2(buf)).toThrow();
  });

  it('handles multiple mip levels', () => {
    const vkFormat = 145;
    const headerSize = 80;
    const levelIndexSize = 2 * 24;
    const level0Data = new Uint8Array(256);
    const level1Data = new Uint8Array(64);
    const dataOffset0 = headerSize + levelIndexSize;
    const dataOffset1 = dataOffset0 + level0Data.byteLength;
    const totalSize = dataOffset1 + level1Data.byteLength;

    const buf = new ArrayBuffer(totalSize);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);

    bytes.set(KTX2_MAGIC, 0);
    view.setUint32(12, vkFormat, true);
    view.setUint32(20, 16, true);
    view.setUint32(24, 16, true);
    view.setUint32(40, 2, true);

    view.setBigUint64(headerSize, BigInt(dataOffset0), true);
    view.setBigUint64(headerSize + 8, BigInt(level0Data.byteLength), true);
    view.setBigUint64(headerSize + 16, BigInt(level0Data.byteLength), true);
    view.setBigUint64(headerSize + 24, BigInt(dataOffset1), true);
    view.setBigUint64(headerSize + 32, BigInt(level1Data.byteLength), true);
    view.setBigUint64(headerSize + 40, BigInt(level1Data.byteLength), true);

    bytes.set(level0Data, dataOffset0);
    bytes.set(level1Data, dataOffset1);

    const result = parseKTX2(buf);
    expect(result.levels).toHaveLength(2);
    expect(result.levels[0].length).toBe(256);
    expect(result.levels[1].length).toBe(64);
  });
});
