# Phase 10: Asset Pipeline (KTX2/Basis Universal) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add GPU-compressed texture support via KTX2/Basis Universal, reducing GPU memory 4-5x while maintaining backward compatibility with PNG/JPEG.

**Architecture:** Compressed textures with per-tier overflow. Primary tiers use device's best format (BC7 > ASTC > RGBA8). PNG/JPEG goes to lazy overflow tiers on compression-capable devices. Custom KTX2 parser for fast path, vendored Basis Universal WASM transcoder for runtime transcoding.

**Tech Stack:** Custom KTX2 parser, vendored Basis Universal WASM (~200KB), WebGPU `texture-compression-bc`/`texture-compression-astc` features.

**Design doc:** `docs/plans/2026-02-24-phase10-asset-pipeline-design.md`

---

### Task 1: Update Packed Texture Index Encoding

**Files:**
- Modify: `ts/src/texture-manager.ts:25-40`
- Modify: `ts/src/texture-manager.test.ts:70-93`

**Step 1: Write the failing tests for new encoding**

Add to `ts/src/texture-manager.test.ts` after line 93 (end of existing "Texture index packing" block):

```typescript
describe("Texture index packing (v2 — overflow flag)", () => {
  it("packs without overflow (bit 31 = 0)", () => {
    const packed = packTextureIndex(2, 10);
    expect(packed).toBe((2 << 16) | 10);
    expect(packed & 0x80000000).toBe(0);
  });

  it("packs with overflow (bit 31 = 1)", () => {
    const packed = packTextureIndex(1, 5, true);
    expect(packed).toBe(0x80000000 | (1 << 16) | 5);
  });

  it("unpacks overflow flag correctly", () => {
    const packed = packTextureIndex(3, 42, true);
    const result = unpackTextureIndex(packed);
    expect(result.tier).toBe(3);
    expect(result.layer).toBe(42);
    expect(result.overflow).toBe(true);
  });

  it("unpacks non-overflow correctly", () => {
    const packed = packTextureIndex(0, 100);
    const result = unpackTextureIndex(packed);
    expect(result.tier).toBe(0);
    expect(result.layer).toBe(100);
    expect(result.overflow).toBe(false);
  });

  it("backward compatible with old encoding", () => {
    // Old encoding: (tier & 0xFFFF) << 16 | (layer & 0xFFFF)
    const oldPacked = (2 << 16) | 10;
    const result = unpackTextureIndex(oldPacked);
    expect(result.tier).toBe(2);
    expect(result.layer).toBe(10);
    expect(result.overflow).toBe(false);
  });

  it("round-trips all tiers with overflow flag", () => {
    for (let tier = 0; tier < 4; tier++) {
      for (const layer of [0, 1, 100, 255]) {
        for (const overflow of [false, true]) {
          const packed = packTextureIndex(tier, layer, overflow);
          const result = unpackTextureIndex(packed);
          expect(result.tier).toBe(tier);
          expect(result.layer).toBe(layer);
          expect(result.overflow).toBe(overflow);
        }
      }
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/texture-manager.test.ts`
Expected: FAIL — `packTextureIndex` doesn't accept 3rd argument, `unpackTextureIndex` doesn't return `overflow`.

**Step 3: Update the pack/unpack functions**

In `ts/src/texture-manager.ts`, replace the existing `packTextureIndex` and `unpackTextureIndex` functions (lines 25-40):

```typescript
/**
 * Pack a tier index, layer index, and overflow flag into a single u32.
 * Layout: [overflow: bit 31][tier: bits 18-16][layer: bits 15-0]
 */
export function packTextureIndex(tier: number, layer: number, overflow = false): number {
  return (overflow ? 0x80000000 : 0) | ((tier & 0x7) << 16) | (layer & 0xFFFF);
}

/**
 * Unpack tier index, layer index, and overflow flag from a packed u32.
 */
export function unpackTextureIndex(packed: number): {
  tier: number;
  layer: number;
  overflow: boolean;
} {
  return {
    overflow: (packed & 0x80000000) !== 0,
    tier: (packed >>> 16) & 0x7,
    layer: packed & 0xFFFF,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/texture-manager.test.ts`
Expected: ALL PASS (both old and new pack/unpack tests)

**Step 5: Commit**

```bash
git add ts/src/texture-manager.ts ts/src/texture-manager.test.ts
git commit -m "feat(phase10): update packed texture index with overflow flag (bit 31)"
```

---

### Task 2: KTX2 Parser

**Files:**
- Create: `ts/src/ktx2-parser.ts`
- Create: `ts/src/ktx2-parser.test.ts`

**Step 1: Write the failing tests**

Create `ts/src/ktx2-parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseKTX2, KTX2_MAGIC, type KTX2Container } from './ktx2-parser';

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
    vkFormat = 0,         // VK_FORMAT_UNDEFINED
    pixelWidth = 8,
    pixelHeight = 8,
    supercompressionScheme = 0,
    levelCount = 1,
    levelData = new Uint8Array(64),
  } = opts;

  // KTX2 header is 80 bytes, followed by level index (24 bytes per level), then level data
  const levelIndexSize = levelCount * 24; // each entry: byteOffset(u64) + byteLength(u64) + uncompressedByteLength(u64)
  const headerSize = 80;
  const dataOffset = headerSize + levelIndexSize;
  const totalSize = dataOffset + levelData.byteLength;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // 12-byte magic
  bytes.set(KTX2_MAGIC, 0);

  // Header fields (all little-endian)
  view.setUint32(12, vkFormat, true);           // vkFormat
  view.setUint32(16, 1, true);                  // typeSize
  view.setUint32(20, pixelWidth, true);         // pixelWidth
  view.setUint32(24, pixelHeight, true);        // pixelHeight
  view.setUint32(28, 0, true);                  // pixelDepth
  view.setUint32(32, 0, true);                  // layerCount
  view.setUint32(36, 1, true);                  // faceCount
  view.setUint32(40, levelCount, true);         // levelCount
  view.setUint32(44, supercompressionScheme, true); // supercompressionScheme

  // DFD and KVD offsets/lengths (set to 0 — we don't parse these)
  // bytes 48..79: dfdByteOffset, dfdByteLength, kvdByteOffset, kvdByteLength, sgdByteOffset, sgdByteLength
  // all zeros is fine for our parser

  // Level index (starts at byte 80)
  // Level 0: byteOffset (u64 LE), byteLength (u64 LE), uncompressedByteLength (u64 LE)
  view.setBigUint64(headerSize, BigInt(dataOffset), true);
  view.setBigUint64(headerSize + 8, BigInt(levelData.byteLength), true);
  view.setBigUint64(headerSize + 16, BigInt(levelData.byteLength), true);

  // Level data
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
      vkFormat: 145,  // VK_FORMAT_BC7_UNORM_BLOCK
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
    // Verify we can read the data at the offset
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
    // 2 levels with different data
    const vkFormat = 145;
    const headerSize = 80;
    const levelIndexSize = 2 * 24; // 2 levels
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
    view.setUint32(20, 16, true); // pixelWidth
    view.setUint32(24, 16, true); // pixelHeight
    view.setUint32(40, 2, true);  // levelCount

    // Level index
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
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/ktx2-parser.test.ts`
Expected: FAIL — module `./ktx2-parser` not found.

**Step 3: Implement the KTX2 parser**

Create `ts/src/ktx2-parser.ts`:

```typescript
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
const LEVEL_INDEX_ENTRY_SIZE = 24; // 3 × u64

/**
 * Parse a KTX2 file from an ArrayBuffer.
 * Extracts header fields and level index; does NOT decompress or transcode.
 */
export function parseKTX2(buffer: ArrayBuffer): KTX2Container {
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error('Invalid KTX2: buffer too small for header');
  }

  // Validate magic
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

  // Parse level index (starts at byte 80)
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
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/ktx2-parser.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/ktx2-parser.ts ts/src/ktx2-parser.test.ts
git commit -m "feat(phase10): add KTX2 container parser with magic validation and level index"
```

---

### Task 3: Basis Universal Transcoder Wrapper

**Files:**
- Create: `ts/src/basis-transcoder.ts`
- Create: `ts/src/basis-transcoder.test.ts`
- Create: `ts/vendor/` directory (placeholder — real WASM vendored separately)

**Step 1: Write the failing tests**

Create `ts/src/basis-transcoder.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BasisTranscoder, type TranscodeTarget, type TranscodeResult } from './basis-transcoder';

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
    expect(BasisTranscoder.mapTargetToGPUFormat('bc7')).toBe('bc7-rgba-unorm');
    expect(BasisTranscoder.mapTargetToGPUFormat('astc')).toBe('astc-4x4-unorm');
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
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/basis-transcoder.test.ts`
Expected: FAIL — module `./basis-transcoder` not found.

**Step 3: Implement the transcoder wrapper**

Create `ts/src/basis-transcoder.ts`:

```typescript
/**
 * Lazy-loaded wrapper around the vendored Basis Universal WASM transcoder.
 *
 * Singleton: WASM module loaded once on first use.
 * Uses the KTX2File high-level API from the Basis module for transcoding.
 */

export type TranscodeTarget = 'bc7' | 'astc' | 'rgba8';

export interface TranscodeResult {
  width: number;
  height: number;
  data: Uint8Array;
  format: GPUTextureFormat;
}

/** Basis Universal format enum values (from basis_transcoder.js). */
const BASIS_FORMAT = {
  cTFBC7: 6,
  cTFASTC_4x4: 10,
  cTFRGBA32: 13,
} as const;

/** Minimal type for the Basis Universal WASM module API. */
interface BasisModule {
  initializeBasis(): void;
  KTX2File: new (data: Uint8Array) => BasisKTX2File;
}

interface BasisKTX2File {
  isValid(): boolean;
  getWidth(): number;
  getHeight(): number;
  getHasAlpha(): boolean;
  getLevels(): number;
  isUASTC(): boolean;
  isETC1S(): boolean;
  startTranscoding(): boolean;
  getImageTranscodedSizeInBytes(levelIndex: number, layerIndex: number, faceIndex: number, format: number): number;
  transcodeImage(dst: Uint8Array, levelIndex: number, layerIndex: number, faceIndex: number, format: number, getAlphaForOpaqueFormats: number, channel0: number, channel1: number): boolean;
  close(): void;
  delete(): void;
}

export class BasisTranscoder {
  private static instance: BasisTranscoder | null = null;
  private static modulePromise: Promise<BasisModule> | null = null;
  private module: BasisModule;

  private constructor(module: BasisModule) {
    this.module = module;
  }

  /**
   * Get or create the singleton transcoder instance.
   * Lazily loads the Basis Universal WASM module on first call.
   */
  static async getInstance(): Promise<BasisTranscoder> {
    if (BasisTranscoder.instance) return BasisTranscoder.instance;

    if (!BasisTranscoder.modulePromise) {
      BasisTranscoder.modulePromise = BasisTranscoder.loadModule();
    }

    const module = await BasisTranscoder.modulePromise;
    module.initializeBasis();
    BasisTranscoder.instance = new BasisTranscoder(module);
    return BasisTranscoder.instance;
  }

  private static async loadModule(): Promise<BasisModule> {
    // Dynamic import of the vendored Basis Universal WASM module.
    // The module is expected at '../vendor/basis_transcoder.js' (relative to this file).
    // It self-initializes and returns the Module object.
    const { default: createModule } = await import('../vendor/basis_transcoder.js');
    return createModule() as Promise<BasisModule>;
  }

  /**
   * Transcode a KTX2 file's level 0 image to the target GPU format.
   * The input must be the complete KTX2 file as a Uint8Array.
   */
  transcode(fileData: Uint8Array, target: TranscodeTarget): TranscodeResult {
    const basisFormat = BasisTranscoder.mapTargetToBasisFormat(target);
    const gpuFormat = BasisTranscoder.mapTargetToGPUFormat(target);

    const ktx2File = new this.module.KTX2File(fileData);
    try {
      if (!ktx2File.isValid()) {
        throw new Error('BasisTranscoder: invalid KTX2 file');
      }

      const width = ktx2File.getWidth();
      const height = ktx2File.getHeight();

      if (!ktx2File.startTranscoding()) {
        throw new Error('BasisTranscoder: startTranscoding() failed');
      }

      const dstSize = ktx2File.getImageTranscodedSizeInBytes(0, 0, 0, basisFormat);
      const dst = new Uint8Array(dstSize);

      if (!ktx2File.transcodeImage(dst, 0, 0, 0, basisFormat, 0, -1, -1)) {
        throw new Error('BasisTranscoder: transcodeImage() failed');
      }

      return { width, height, data: dst, format: gpuFormat };
    } finally {
      ktx2File.close();
      ktx2File.delete();
    }
  }

  /** Map TranscodeTarget to WebGPU texture format string. */
  static mapTargetToGPUFormat(target: TranscodeTarget): GPUTextureFormat {
    switch (target) {
      case 'bc7': return 'bc7-rgba-unorm';
      case 'astc': return 'astc-4x4-unorm';
      case 'rgba8': return 'rgba8unorm';
    }
  }

  /** Map TranscodeTarget to Basis Universal format enum value. */
  static mapTargetToBasisFormat(target: TranscodeTarget): number {
    switch (target) {
      case 'bc7': return BASIS_FORMAT.cTFBC7;
      case 'astc': return BASIS_FORMAT.cTFASTC_4x4;
      case 'rgba8': return BASIS_FORMAT.cTFRGBA32;
    }
  }

  /** Calculate bytesPerRow for writeTexture with block-compressed data. */
  static blockBytesPerRow(width: number, target: TranscodeTarget): number {
    if (target === 'rgba8') return width * 4;
    // BC7 and ASTC 4x4: 4x4 blocks, 16 bytes each
    return Math.ceil(width / 4) * 16;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/basis-transcoder.test.ts`
Expected: ALL PASS (static method tests pass; singleton tests just reset the null state)

**Step 5: Commit**

```bash
git add ts/src/basis-transcoder.ts ts/src/basis-transcoder.test.ts
git commit -m "feat(phase10): add Basis Universal transcoder wrapper with format mapping"
```

---

### Task 4: Capability Detection for Compressed Textures

**Files:**
- Modify: `ts/src/capabilities.ts:10-16` (Capabilities interface)
- Modify: `ts/src/capabilities.test.ts`

**Step 1: Write the failing tests**

Add to `ts/src/capabilities.test.ts`:

```typescript
import {
  selectExecutionMode,
  ExecutionMode,
  detectCompressedFormat,
  type Capabilities,
} from "./capabilities";

// ... existing tests ...

describe("detectCompressedFormat", () => {
  it("returns bc7-rgba-unorm when texture-compression-bc is available", () => {
    const features = new Set(['texture-compression-bc']);
    expect(detectCompressedFormat(features)).toBe('bc7-rgba-unorm');
  });

  it("returns astc-4x4-unorm when only texture-compression-astc is available", () => {
    const features = new Set(['texture-compression-astc']);
    expect(detectCompressedFormat(features)).toBe('astc-4x4-unorm');
  });

  it("prefers BC7 over ASTC when both are available", () => {
    const features = new Set(['texture-compression-bc', 'texture-compression-astc']);
    expect(detectCompressedFormat(features)).toBe('bc7-rgba-unorm');
  });

  it("returns null when neither is available", () => {
    const features = new Set<string>();
    expect(detectCompressedFormat(features)).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/capabilities.test.ts`
Expected: FAIL — `detectCompressedFormat` not exported.

**Step 3: Add detectCompressedFormat function**

Add to `ts/src/capabilities.ts` after the `logCapabilities` function (after line 76):

```typescript
/**
 * Detect the best GPU-compressed texture format from adapter features.
 * Priority: BC7 (desktop) > ASTC 4x4 (mobile) > null (no compression).
 */
export function detectCompressedFormat(
  adapterFeatures: ReadonlySet<string>,
): GPUTextureFormat | null {
  if (adapterFeatures.has('texture-compression-bc')) return 'bc7-rgba-unorm';
  if (adapterFeatures.has('texture-compression-astc')) return 'astc-4x4-unorm';
  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/capabilities.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/capabilities.ts ts/src/capabilities.test.ts
git commit -m "feat(phase10): add compressed texture format detection in capabilities"
```

---

### Task 5: TextureManager — Compressed Format Support + Overflow Tiers

**Files:**
- Modify: `ts/src/texture-manager.ts` (constructor, TierState, tier creation)
- Modify: `ts/src/texture-manager.test.ts`

This is the biggest task. We'll modify the TextureManager to accept a `compressedFormat` option and add overflow tier state.

**Step 1: Write the failing tests**

Add to `ts/src/texture-manager.test.ts`:

```typescript
describe("TextureManager with compressed format", () => {
  it("should accept compressedFormat option", () => {
    const device = createMockDevice();
    const tm = new TextureManager(device, { compressedFormat: 'bc7-rgba-unorm' });
    expect(tm.compressedFormat).toBe('bc7-rgba-unorm');
  });

  it("should default compressedFormat to null", () => {
    const device = createMockDevice();
    const tm = new TextureManager(device);
    expect(tm.compressedFormat).toBeNull();
  });

  it("should create primary tier with compressed format", () => {
    const textures: any[] = [];
    const device = {
      ...createMockDevice(),
      createTexture: (desc: any) => {
        const t = { desc, createView: () => ({}), destroy: () => {} };
        textures.push(t);
        return t;
      },
    } as unknown as GPUDevice;
    const tm = new TextureManager(device, { compressedFormat: 'bc7-rgba-unorm' });
    tm.ensureTierCapacity(0, 1);
    expect(textures[0].desc.format).toBe('bc7-rgba-unorm');
  });

  it("should create primary tier with rgba8unorm when no compressed format", () => {
    const textures: any[] = [];
    const device = {
      ...createMockDevice(),
      createTexture: (desc: any) => {
        const t = { desc, createView: () => ({}), destroy: () => {} };
        textures.push(t);
        return t;
      },
    } as unknown as GPUDevice;
    const tm = new TextureManager(device);
    tm.ensureTierCapacity(0, 1);
    expect(textures[0].desc.format).toBe('rgba8unorm');
  });

  it("should expose overflow view getters", () => {
    const device = createMockDevice();
    const tm = new TextureManager(device, { compressedFormat: 'bc7-rgba-unorm' });
    // Overflow tiers are lazy — getter creates a 1-layer placeholder
    const view = tm.getOverflowTierView(0);
    expect(view).toBeTruthy();
  });

  it("should not allocate overflow when no compressed format", () => {
    const textures: any[] = [];
    const device = {
      ...createMockDevice(),
      createTexture: (desc: any) => {
        const t = { desc, createView: () => ({}), destroy: () => {} };
        textures.push(t);
        return t;
      },
    } as unknown as GPUDevice;
    const tm = new TextureManager(device); // no compression
    // getOverflowTierView still returns a placeholder view for bind group validity
    const view = tm.getOverflowTierView(0);
    expect(view).toBeTruthy();
  });

  it("ensureOverflowCapacity creates rgba8unorm texture", () => {
    const textures: any[] = [];
    const device = {
      ...createMockDevice(),
      createTexture: (desc: any) => {
        const t = { desc, createView: () => ({}), destroy: () => {} };
        textures.push(t);
        return t;
      },
    } as unknown as GPUDevice;
    const tm = new TextureManager(device, { compressedFormat: 'bc7-rgba-unorm' });
    tm.ensureOverflowCapacity(0, 1);
    // Find the overflow texture (rgba8unorm, not bc7)
    const overflowTex = textures.find(t => t.desc.format === 'rgba8unorm');
    expect(overflowTex).toBeTruthy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/texture-manager.test.ts`
Expected: FAIL — `compressedFormat` property, `getOverflowTierView`, `ensureOverflowCapacity` don't exist.

**Step 3: Implement the changes**

Modify `ts/src/texture-manager.ts`:

1. Add `compressedFormat` field and constructor option
2. Add overflow fields to `TierState`
3. Add `getOverflowTierView()` and `ensureOverflowCapacity()`
4. Update `ensureTierCapacity()` to use the tier's format
5. Update `destroy()` to clean up overflow textures

Key changes (the implementor should reference the design doc for the full `TierState` interface):

- Constructor: `this.compressedFormat = opts?.compressedFormat ?? null;`
- Each tier's `format`: `this.compressedFormat ?? 'rgba8unorm'`
- `ensureTierCapacity`: pass `state.format` to `createTexture`
- `getOverflowTierView(tier)`: same pattern as `getTierView` but for overflow state
- `ensureOverflowCapacity(tier, needed)`: same growth logic but always `rgba8unorm`

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/texture-manager.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/texture-manager.ts ts/src/texture-manager.test.ts
git commit -m "feat(phase10): add compressed format + overflow tier support to TextureManager"
```

---

### Task 6: TextureManager — KTX2 Load Path

**Files:**
- Modify: `ts/src/texture-manager.ts` (loadTexture, executeFetch)
- Modify: `ts/src/texture-manager.test.ts`

This task adds the KTX2 detection and routing logic to `loadTexture`.

**Step 1: Write the failing tests**

Add to `ts/src/texture-manager.test.ts`:

```typescript
import { KTX2_MAGIC } from './ktx2-parser';

describe("TextureManager KTX2 routing", () => {
  it("detects KTX2 by magic bytes in response", async () => {
    // Build a minimal KTX2 buffer (only needs valid magic + header)
    const headerSize = 80;
    const buf = new ArrayBuffer(headerSize + 24 + 64);
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    bytes.set(KTX2_MAGIC, 0);
    view.setUint32(12, 0, true); // vkFormat = UNDEFINED (will need transcoding)
    view.setUint32(20, 8, true); // pixelWidth
    view.setUint32(24, 8, true); // pixelHeight
    view.setUint32(40, 1, true); // levelCount
    view.setUint32(44, 1, true); // supercompressionScheme = BasisLZ
    view.setBigUint64(headerSize, BigInt(headerSize + 24), true);
    view.setBigUint64(headerSize + 8, BigInt(64), true);
    view.setBigUint64(headerSize + 16, BigInt(64), true);

    // Mock fetch to return the KTX2 buffer
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(buf),
      blob: () => Promise.resolve(new Blob()),
    });
    globalThis.fetch = mockFetch as any;

    // Without a transcoder loaded, loading a BasisLZ KTX2 should fail
    // (because we can't actually transcode in unit tests)
    // This test verifies the detection path is entered
    const device = createMockDevice();
    const tm = new TextureManager(device, { compressedFormat: 'bc7-rgba-unorm' });

    // The load should attempt KTX2 path (not PNG path)
    // We can verify by checking that createImageBitmap is NOT called
    const createImageBitmapSpy = vi.fn();
    globalThis.createImageBitmap = createImageBitmapSpy as any;

    await expect(tm.loadTexture('test.ktx2')).rejects.toThrow();
    expect(createImageBitmapSpy).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/texture-manager.test.ts`
Expected: FAIL — current loadTexture always goes through the PNG/Blob path.

**Step 3: Update loadTexture and executeFetch**

In `ts/src/texture-manager.ts`, modify `executeFetch` to:
1. Fetch as `ArrayBuffer` first (instead of Blob)
2. Check first 12 bytes against `KTX2_MAGIC` via `isKTX2()`
3. If KTX2: branch into KTX2 processing (parseKTX2 → fast path or transcoder)
4. If not KTX2: continue existing PNG/JPEG path (create Blob from ArrayBuffer)

The implementor should import `isKTX2`, `parseKTX2`, `VK_FORMAT` from `./ktx2-parser` and `BasisTranscoder` from `./basis-transcoder`.

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/texture-manager.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/texture-manager.ts ts/src/texture-manager.test.ts
git commit -m "feat(phase10): add KTX2 detection and routing to TextureManager.loadTexture"
```

---

### Task 7: Shader Updates — Overflow Bindings

**Files:**
- Modify: `ts/src/shaders/basic.wgsl:15-21` (add overflow bindings)
- Modify: `ts/src/shaders/line.wgsl:17-21`
- Modify: `ts/src/shaders/gradient.wgsl:21-25`
- Modify: `ts/src/shaders/box-shadow.wgsl:18-22`
- Modify: `ts/src/shaders/bezier.wgsl:18-22`
- Modify: `ts/src/shaders/msdf-text.wgsl:19-23`

No unit tests for shaders — WGSL validation happens at pipeline creation time, tested visually.

**Step 1: Update basic.wgsl**

Replace the group 1 bindings (lines 15-20) and update the vertex/fragment shader:

In the binding declarations, after `@group(1) @binding(4) var texSampler: sampler;`, add:

```wgsl
// Overflow tiers (rgba8unorm, for mixed-mode dev)
@group(1) @binding(5) var ovf0Tex: texture_2d_array<f32>;
@group(1) @binding(6) var ovf1Tex: texture_2d_array<f32>;
@group(1) @binding(7) var ovf2Tex: texture_2d_array<f32>;
@group(1) @binding(8) var ovf3Tex: texture_2d_array<f32>;
```

In the vertex shader, update the packed decoding (lines 39-41):

```wgsl
let packed = texLayerIndices[entityIdx];
let isOverflow = (packed >> 31u) & 1u;
let tier = (packed >> 16u) & 0x7u;
let layer = packed & 0xFFFFu;
```

Add `isOverflow` to VertexOutput (new flat interpolated field) and pass it through.

In the fragment shader, replace the tier switch with the overflow-aware version:

```wgsl
var texColor: vec4f;
if (in.isOverflow == 0u) {
    switch in.texTier {
        case 1u { texColor = textureSample(tier1Tex, texSampler, in.uv, in.texLayer); }
        case 2u { texColor = textureSample(tier2Tex, texSampler, in.uv, in.texLayer); }
        case 3u { texColor = textureSample(tier3Tex, texSampler, in.uv, in.texLayer); }
        default { texColor = textureSample(tier0Tex, texSampler, in.uv, in.texLayer); }
    }
} else {
    switch in.texTier {
        case 1u { texColor = textureSample(ovf1Tex, texSampler, in.uv, in.texLayer); }
        case 2u { texColor = textureSample(ovf2Tex, texSampler, in.uv, in.texLayer); }
        case 3u { texColor = textureSample(ovf3Tex, texSampler, in.uv, in.texLayer); }
        default { texColor = textureSample(ovf0Tex, texSampler, in.uv, in.texLayer); }
    }
}
```

**Step 2: Apply the same pattern to all 5 other shaders**

Each shader has identical group 1 bindings. Apply the same additions: 4 overflow bindings, isOverflow decode, overflow-aware sampling. The vertex/fragment logic differs per shader but the texture sampling section is structurally the same.

**Step 3: Commit**

```bash
git add ts/src/shaders/
git commit -m "feat(phase10): add overflow texture bindings and sampling to all 6 primitive shaders"
```

---

### Task 8: ForwardPass Bind Group Layout Update

**Files:**
- Modify: `ts/src/render/passes/forward-pass.ts:116-125` (bind group layout 1)
- Modify: `ts/src/render/passes/forward-pass.ts:162-180` (bind group 1 creation)

**Step 1: Update bind group layout 1**

In `ts/src/render/passes/forward-pass.ts`, expand the `bindGroupLayout1` entries (lines 117-125) from 5 to 9 entries:

```typescript
const bindGroupLayout1 = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
    { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
    { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
    { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
  ],
});
```

**Step 2: Update bind group 1 creation**

Expand the bind group entries (lines 169-180) to include overflow views:

```typescript
const ovf0View = resources.getTextureView('ovf0');
const ovf1View = resources.getTextureView('ovf1');
const ovf2View = resources.getTextureView('ovf2');
const ovf3View = resources.getTextureView('ovf3');

if (tier0View && tier1View && tier2View && tier3View && sampler &&
    ovf0View && ovf1View && ovf2View && ovf3View) {
  this.bindGroup1 = device.createBindGroup({
    layout: bindGroupLayout1,
    entries: [
      { binding: 0, resource: tier0View },
      { binding: 1, resource: tier1View },
      { binding: 2, resource: tier2View },
      { binding: 3, resource: tier3View },
      { binding: 4, resource: sampler },
      { binding: 5, resource: ovf0View },
      { binding: 6, resource: ovf1View },
      { binding: 7, resource: ovf2View },
      { binding: 8, resource: ovf3View },
    ],
  });
}
```

**Step 3: Commit**

```bash
git add ts/src/render/passes/forward-pass.ts
git commit -m "feat(phase10): expand ForwardPass bind group 1 to 9 slots (4 primary + sampler + 4 overflow)"
```

---

### Task 9: Renderer Integration

**Files:**
- Modify: `ts/src/renderer.ts:61-82` (createRenderer: device creation + TextureManager + ResourcePool)

**Step 1: Update device request with compression feature**

In `ts/src/renderer.ts`, modify `createRenderer` (around line 66-68):

```typescript
import { detectCompressedFormat } from './capabilities';

// Detect compression support from adapter
const compressedFormat = detectCompressedFormat(adapter.features);

// Request device with compression feature if available
const requiredFeatures: GPUFeatureName[] = [];
if (compressedFormat === 'bc7-rgba-unorm') requiredFeatures.push('texture-compression-bc');
else if (compressedFormat === 'astc-4x4-unorm') requiredFeatures.push('texture-compression-astc');

const device = await adapter.requestDevice({
  requiredFeatures: requiredFeatures.length > 0 ? requiredFeatures : undefined,
});
```

**Step 2: Pass compressedFormat to TextureManager**

Update line 82:

```typescript
const textureManager = new TextureManager(device, { compressedFormat });
```

**Step 3: Register overflow views in ResourcePool**

After the existing tier view registration (lines 131-135), add:

```typescript
resources.setTextureView('ovf0', textureManager.getOverflowTierView(0));
resources.setTextureView('ovf1', textureManager.getOverflowTierView(1));
resources.setTextureView('ovf2', textureManager.getOverflowTierView(2));
resources.setTextureView('ovf3', textureManager.getOverflowTierView(3));
```

**Step 4: Run full test suite**

Run: `cd ts && npm test`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/renderer.ts
git commit -m "feat(phase10): integrate compressed format detection and overflow views into renderer"
```

---

### Task 10: Public API — compressionFormat Getter

**Files:**
- Modify: `ts/src/hyperion.ts` (add getter)
- Modify: `ts/src/hyperion.test.ts` (add test)

**Step 1: Write the failing test**

Add to `ts/src/hyperion.test.ts`:

```typescript
it("compressionFormat returns null when no renderer", () => {
  const engine = createTestEngine();
  expect(engine.compressionFormat).toBeNull();
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `compressionFormat` property doesn't exist.

**Step 3: Add the getter**

In `ts/src/hyperion.ts`, add after the existing getters:

```typescript
/** GPU-compressed texture format in use, or null if unsupported. */
get compressionFormat(): GPUTextureFormat | null {
  return this.renderer?.textureManager.compressedFormat ?? null;
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase10): expose compressionFormat getter on Hyperion facade"
```

---

### Task 11: Barrel Exports

**Files:**
- Modify: `ts/src/index.ts`

**Step 1: Add new exports**

Add to `ts/src/index.ts`:

```typescript
// KTX2 / Compressed Textures
export { parseKTX2, isKTX2, VK_FORMAT } from './ktx2-parser';
export type { KTX2Container } from './ktx2-parser';
export { BasisTranscoder } from './basis-transcoder';
export type { TranscodeTarget, TranscodeResult } from './basis-transcoder';
export { detectCompressedFormat } from './capabilities';
```

**Step 2: Type-check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add ts/src/index.ts
git commit -m "feat(phase10): export KTX2 parser, BasisTranscoder, and detectCompressedFormat"
```

---

### Task 12: Vendor Basis Universal Transcoder WASM

**Files:**
- Create: `ts/vendor/basis_transcoder.js`
- Create: `ts/vendor/basis_transcoder.wasm`
- Modify: `ts/vite-env.d.ts` (add module declaration for vendor JS)

**Step 1: Download the official Basis Universal transcoder files**

From the [BinomialLLC/basis_universal](https://github.com/nicol909/BinomialLLC-basis_universal) repository, download the latest `webgl/transcoder/build/` artifacts:
- `basis_transcoder.js` (~50KB)
- `basis_transcoder.wasm` (~200KB)

Place them in `ts/vendor/`.

**Step 2: Add TypeScript module declaration**

Add to `ts/vite-env.d.ts`:

```typescript
declare module '../vendor/basis_transcoder.js' {
  const createModule: () => Promise<any>;
  export default createModule;
}
```

**Step 3: Verify build**

Run: `cd ts && npx tsc --noEmit`
Expected: No type errors

**Step 4: Commit**

```bash
git add ts/vendor/ ts/vite-env.d.ts
git commit -m "feat(phase10): vendor Basis Universal WASM transcoder (~200KB)"
```

---

### Task 13: Demo Update

**Files:**
- Modify: `ts/src/main.ts`

**Step 1: Add KTX2 texture loading to demo**

In the demo's initialization section, add a console log showing the detected compression format and optionally load a test KTX2 texture if available:

```typescript
console.log('Compression format:', engine.compressionFormat ?? 'none');
```

**Step 2: Visual test**

Run: `cd ts && npm run dev`
Open `http://localhost:5173` in Chrome. Verify:
1. Console shows detected compression format (likely `bc7-rgba-unorm` on desktop Chrome)
2. Existing PNG textures still render correctly
3. No WebGPU validation errors in console

**Step 3: Commit**

```bash
git add ts/src/main.ts
git commit -m "feat(phase10): show compression format in demo, verify backward compatibility"
```

---

### Task 14: Full Validation

**Step 1: Run Rust tests**

Run: `cargo test -p hyperion-core`
Expected: 99 tests PASS (no Rust changes in this phase)

**Step 2: Run TypeScript tests**

Run: `cd ts && npm test`
Expected: ALL PASS (existing 429 + new tests)

**Step 3: Type check**

Run: `cd ts && npx tsc --noEmit`
Expected: No errors

**Step 4: Lint check**

Run: `cargo clippy -p hyperion-core`
Expected: No warnings

**Step 5: Visual test**

Run: `cd ts && npm run dev`
Verify in Chrome: demo renders correctly, console shows compression format, no GPU errors.

---

### Task 15: Documentation Update

**Files:**
- Modify: `CLAUDE.md`
- Modify: `PROJECT_ARCHITECTURE.md`

**Step 1: Update CLAUDE.md**

Add Phase 10 to the implementation status table. Add new test files to the test commands section. Add new gotchas:

- **KTX2 files must have block-aligned dimensions** — BC7/ASTC 4x4 require width/height divisible by 4. Tier sizes (64-512) satisfy this.
- **Basis Universal WASM loaded lazily** — Only fetched on first KTX2 texture with BasisLZ/UASTC supercompression. Pre-compressed KTX2 (scheme=0) bypasses the transcoder entirely.
- **Overflow tiers are dev-mode only** — In production (all KTX2), overflow arrays never allocate. PNG/JPEG on compression-capable devices go to overflow.
- **`KTX2File.close()` AND `.delete()` both required** — Missing `.delete()` leaks WASM heap memory.
- **Compressed texture tier growth needs standard WebGPU** — `copyTextureToTexture` for compressed formats is disallowed in compatibility mode.

Add new modules to the TypeScript architecture table.

**Step 2: Update PROJECT_ARCHITECTURE.md**

Add the KTX2/compressed texture system to the architecture doc.

**Step 3: Commit**

```bash
git add CLAUDE.md PROJECT_ARCHITECTURE.md
git commit -m "docs(phase10): update CLAUDE.md and PROJECT_ARCHITECTURE.md for Phase 10"
```
