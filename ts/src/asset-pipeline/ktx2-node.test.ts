import { describe, it, expect } from 'vitest';
import { parseKTX2Header } from './ktx2-node';

// KTX2 magic: 0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A
const KTX2_MAGIC = new Uint8Array([0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A]);

function makeKTX2Header(width: number, height: number, vkFormat: number = 0): Buffer {
  // KTX2 header is 80 bytes minimum
  const buf = Buffer.alloc(80);
  // Magic (12 bytes)
  KTX2_MAGIC.forEach((b, i) => buf[i] = b);
  // vkFormat (4 bytes at offset 12)
  buf.writeUInt32LE(vkFormat, 12);
  // typeSize (4 bytes at offset 16)
  buf.writeUInt32LE(1, 16);
  // pixelWidth (4 bytes at offset 20)
  buf.writeUInt32LE(width, 20);
  // pixelHeight (4 bytes at offset 24)
  buf.writeUInt32LE(height, 24);
  // pixelDepth (4 bytes at offset 28)
  buf.writeUInt32LE(0, 28);
  // layerCount (4 bytes at offset 32)
  buf.writeUInt32LE(0, 32);
  // faceCount (4 bytes at offset 36)
  buf.writeUInt32LE(1, 36);
  // levelCount (4 bytes at offset 40)
  buf.writeUInt32LE(1, 40);
  // supercompressionScheme (4 bytes at offset 44)
  buf.writeUInt32LE(0, 44);
  return buf;
}

describe('parseKTX2Header', () => {
  it('extracts width and height from valid KTX2', () => {
    const buf = makeKTX2Header(128, 256);
    const result = parseKTX2Header(buf);
    expect(result).toEqual({ width: 128, height: 256, compressed: true });
  });

  it('returns null for non-KTX2 buffer', () => {
    const buf = Buffer.from('not a ktx2 file');
    expect(parseKTX2Header(buf)).toBeNull();
  });

  it('returns null for buffer too small', () => {
    const buf = Buffer.alloc(10);
    expect(parseKTX2Header(buf)).toBeNull();
  });

  it('handles square textures', () => {
    const buf = makeKTX2Header(64, 64);
    const result = parseKTX2Header(buf);
    expect(result).toEqual({ width: 64, height: 64, compressed: true });
  });
});
