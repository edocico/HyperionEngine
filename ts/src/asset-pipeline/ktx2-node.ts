/**
 * Node.js KTX2 header parser for build-time metadata extraction.
 * Uses Buffer.readUInt32LE directly — does NOT use the browser runtime KTX2Container.
 *
 * KTX2 header layout (first 80 bytes):
 *   [0-11]  magic (12 bytes)
 *   [12-15] vkFormat
 *   [16-19] typeSize
 *   [20-23] pixelWidth
 *   [24-27] pixelHeight
 *   ...
 */

const KTX2_MAGIC = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];

export interface KTX2HeaderInfo {
  width: number;
  height: number;
  compressed: boolean;
}

/**
 * Parse the KTX2 header from a Buffer.
 * Returns width/height/compressed or null if not a valid KTX2 file.
 */
export function parseKTX2Header(buf: Buffer): KTX2HeaderInfo | null {
  if (buf.length < 80) return null;

  // Check magic
  for (let i = 0; i < 12; i++) {
    if (buf[i] !== KTX2_MAGIC[i]) return null;
  }

  const width = buf.readUInt32LE(20);
  const height = buf.readUInt32LE(24);

  return { width, height, compressed: true };
}
