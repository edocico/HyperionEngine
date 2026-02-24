/**
 * KTX2 magic bytes (12 bytes).
 * Spec: https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html
 */
export const KTX2_MAGIC = new Uint8Array([
  0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A,
]);

/** Parsed KTX2 container (header + level index). */
export interface KTX2Container {
  vkFormat: number;
  pixelWidth: number;
  pixelHeight: number;
  supercompressionScheme: number;
  levels: Array<{ offset: number; length: number }>;
  data: ArrayBuffer;
}

/** Well-known Vulkan format values used by KTX2. */
export const VK_FORMAT = {
  UNDEFINED: 0,
  BC7_UNORM_BLOCK: 145,
  BC7_SRGB_BLOCK: 146,
  ASTC_4x4_UNORM_BLOCK: 157,
  ASTC_4x4_SRGB_BLOCK: 158,
} as const;

const HEADER_SIZE = 80;
const LEVEL_INDEX_ENTRY_SIZE = 24;

/**
 * Parse a KTX2 file from an ArrayBuffer.
 * Extracts header fields and level index; does NOT decompress or transcode.
 */
export function parseKTX2(buffer: ArrayBuffer): KTX2Container {
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error('Invalid KTX2: buffer too small for header');
  }

  const magic = new Uint8Array(buffer, 0, 12);
  for (let i = 0; i < 12; i++) {
    if (magic[i] !== KTX2_MAGIC[i]) {
      throw new Error('Invalid KTX2: magic bytes do not match');
    }
  }

  const view = new DataView(buffer);
  const vkFormat = view.getUint32(12, true);
  const pixelWidth = view.getUint32(20, true);
  const pixelHeight = view.getUint32(24, true);
  const levelCount = view.getUint32(40, true);
  const supercompressionScheme = view.getUint32(44, true);

  const levels: Array<{ offset: number; length: number }> = [];
  for (let i = 0; i < levelCount; i++) {
    const base = HEADER_SIZE + i * LEVEL_INDEX_ENTRY_SIZE;
    const byteOffset = Number(view.getBigUint64(base, true));
    const byteLength = Number(view.getBigUint64(base + 8, true));
    levels.push({ offset: byteOffset, length: byteLength });
  }

  return { vkFormat, pixelWidth, pixelHeight, supercompressionScheme, levels, data: buffer };
}

/** Check if the first 12 bytes of an ArrayBuffer are the KTX2 magic. */
export function isKTX2(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false;
  const bytes = new Uint8Array(buffer, 0, 12);
  for (let i = 0; i < 12; i++) {
    if (bytes[i] !== KTX2_MAGIC[i]) return false;
  }
  return true;
}
