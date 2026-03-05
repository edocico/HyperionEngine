/**
 * KTX2StreamLoader — progressive KTX2 texture loading via HTTP Range requests.
 *
 * 3-phase fetch:
 *   1. Header (first 256 bytes) — parse format, dimensions, level index
 *   2. SGD (Supercompression Global Data) — needed before any mip decode for BasisLZ/UASTC
 *   3. Individual mip levels — on demand, coarsest first for progressive display
 */

import { KTX2_MAGIC } from './ktx2-parser';

/** Per-level byte range info from the KTX2 level index. */
export interface KTX2LevelInfo {
  byteOffset: number;
  byteLength: number;
  uncompressedByteLength: number;
}

/** Parsed KTX2 header sufficient for streaming (no raw data). */
export interface KTX2StreamHeader {
  vkFormat: number;
  pixelWidth: number;
  pixelHeight: number;
  levelCount: number;
  supercompressionScheme: number;
  sgdByteOffset: number;
  sgdByteLength: number;
  levels: KTX2LevelInfo[];
}

const HEADER_SIZE = 80;
const LEVEL_INDEX_ENTRY_SIZE = 24;

export class KTX2StreamLoader {
  /**
   * Check if the server supports HTTP Range requests.
   * Sends a HEAD request and checks for Accept-Ranges: bytes.
   */
  async isRangeSupported(url: string): Promise<boolean> {
    try {
      const resp = await fetch(url, { method: 'HEAD' });
      return resp.headers.get('Accept-Ranges') === 'bytes';
    } catch {
      return false;
    }
  }

  /**
   * Fetch and parse the KTX2 header (first 256 bytes of the file).
   * Uses Range: bytes=0-255 to get just the header.
   * The KTX2 header is 80 bytes, plus the level index (24 bytes per level).
   * 256 bytes covers header + up to ~7 mip levels (80 + 7*24 = 248).
   */
  async fetchHeader(url: string): Promise<KTX2StreamHeader> {
    const resp = await fetch(url, {
      headers: { Range: 'bytes=0-255' },
    });
    const buffer = await resp.arrayBuffer();
    return this.parseHeader(buffer);
  }

  /**
   * Parse KTX2 header from raw bytes.
   *
   * KTX2 layout:
   * - [0..12)   magic (12 bytes)
   * - [12..16)  vkFormat
   * - [16..20)  typeSize
   * - [20..24)  pixelWidth
   * - [24..28)  pixelHeight
   * - [28..32)  pixelDepth
   * - [32..36)  layerCount
   * - [36..40)  faceCount
   * - [40..44)  levelCount
   * - [44..48)  supercompressionScheme
   * - [48..52)  dfdByteOffset
   * - [52..56)  dfdByteLength
   * - [56..60)  kvdByteOffset
   * - [60..64)  kvdByteLength
   * - [64..72)  sgdByteOffset  (u64, read low 32 bits)
   * - [72..80)  sgdByteLength  (u64, read low 32 bits)
   * - [80..)    Level index: levelCount * 24 bytes
   *             Each: byteOffset(u64) + byteLength(u64) + uncompressedByteLength(u64)
   */
  parseHeader(buffer: ArrayBuffer): KTX2StreamHeader {
    if (buffer.byteLength < HEADER_SIZE) {
      throw new Error('KTX2StreamLoader: buffer too small for header');
    }

    const u8 = new Uint8Array(buffer, 0, 12);
    for (let i = 0; i < 12; i++) {
      if (u8[i] !== KTX2_MAGIC[i]) {
        throw new Error('KTX2StreamLoader: invalid magic bytes');
      }
    }

    const view = new DataView(buffer);
    const vkFormat = view.getUint32(12, true);
    const pixelWidth = view.getUint32(20, true);
    const pixelHeight = view.getUint32(24, true);
    const levelCount = view.getUint32(40, true);
    const supercompressionScheme = view.getUint32(44, true);

    // SGD offset/length are u64; read low 32 bits only (files < 4 GB)
    const sgdByteOffset = view.getUint32(64, true);
    const sgdByteLength = view.getUint32(72, true);

    const requiredSize = HEADER_SIZE + levelCount * LEVEL_INDEX_ENTRY_SIZE;
    if (buffer.byteLength < requiredSize) {
      throw new Error(
        `KTX2StreamLoader: buffer too small for level index (need ${requiredSize}, got ${buffer.byteLength})`,
      );
    }

    const levels: KTX2LevelInfo[] = [];
    for (let i = 0; i < levelCount; i++) {
      const base = HEADER_SIZE + i * LEVEL_INDEX_ENTRY_SIZE;
      // Read u64 as low 32 bits (safe for files < 4 GB)
      const byteOffset = view.getUint32(base, true);
      const byteLength = view.getUint32(base + 8, true);
      const uncompressedByteLength = view.getUint32(base + 16, true);
      levels.push({ byteOffset, byteLength, uncompressedByteLength });
    }

    return {
      vkFormat,
      pixelWidth,
      pixelHeight,
      levelCount,
      supercompressionScheme,
      sgdByteOffset,
      sgdByteLength,
      levels,
    };
  }

  /**
   * Fetch the Supercompression Global Data section.
   * Required for BasisLZ/UASTC supercompressed files before any mip decode.
   * Returns empty ArrayBuffer if no SGD present.
   */
  async fetchSGD(url: string, header: KTX2StreamHeader): Promise<ArrayBuffer> {
    if (header.sgdByteLength === 0) return new ArrayBuffer(0);
    const start = header.sgdByteOffset;
    const end = start + header.sgdByteLength - 1;
    const resp = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    return resp.arrayBuffer();
  }

  /**
   * Fetch a specific mip level by index.
   * Level 0 is the highest resolution; level (levelCount-1) is the smallest.
   */
  async fetchMipLevel(
    url: string,
    header: KTX2StreamHeader,
    level: number,
  ): Promise<ArrayBuffer> {
    if (level < 0 || level >= header.levels.length) {
      throw new RangeError(
        `KTX2StreamLoader: level ${level} out of range [0, ${header.levels.length})`,
      );
    }
    const info = header.levels[level];
    const start = info.byteOffset;
    const end = start + info.byteLength - 1;
    const resp = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    return resp.arrayBuffer();
  }
}
