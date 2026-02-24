# Phase 10: Asset Pipeline (KTX2/Basis Universal) — Design

## Goal

Add GPU-compressed texture support via KTX2/Basis Universal, reducing GPU memory 4-5x (BC7/ASTC) while maintaining backward compatibility with PNG/JPEG.

## Architecture

Compressed textures with per-tier overflow for mixed-mode development. Primary tiers use the device's best compressed format (BC7 > ASTC > RGBA8). PNG/JPEG textures upload to lazy-allocated rgba8unorm overflow tiers only when mixing formats on a compression-capable device. Two load paths: pre-compressed KTX2 fast path (zero transcoder cost) and BasisLZ/UASTC runtime transcoding.

## Tech Stack

- Custom KTX2 header parser (DataView, ~60 lines)
- Vendored Basis Universal WASM transcoder (~200KB gzipped, lazy-loaded)
- WebGPU `texture-compression-bc` / `texture-compression-astc` features

---

## 1. Format Detection & Capability Probing

At `Hyperion.create()` time, after requesting the WebGPU adapter:

```
adapter.features.has('texture-compression-bc')   → GPUTextureFormat = 'bc7-rgba-unorm'
adapter.features.has('texture-compression-astc')  → GPUTextureFormat = 'astc-4x4-unorm'
neither                                           → GPUTextureFormat = 'rgba8unorm' (fallback)
```

Priority: BC7 > ASTC > RGBA8. The chosen format is stored in `TextureManager` and drives all tier creation.

The device must be requested with the compression feature enabled:

```typescript
const device = await adapter.requestDevice({
  requiredFeatures: detectedFeature ? [detectedFeature] : [],
});
```

This check happens in `capabilities.ts`. Must probe `adapter.features.has()` before requesting.

## 2. Packed Texture Index Encoding

Current: `(tier & 0xFFFF) << 16 | (layer & 0xFFFF)` — uses 32 bits but only needs ~10.

New encoding:

```
bit 31:     overflow flag (0 = primary/compressed, 1 = rgba8 overflow)
bits 18-16: tier index (0-3, 3 bits)
bits 15-0:  layer index (0-65535)
```

Backward compatible: existing packed values (bit 31 = 0) decode identically.

Shader unpacking:

```wgsl
let raw = texIndices[entityIdx];
let isOverflow = (raw >> 31u) & 1u;
let texTier    = (raw >> 16u) & 0x7u;
let texLayer   = raw & 0xFFFFu;
```

Rust side: no changes. `TextureLayerIndex(u32)` is opaque — encoding is purely TS + WGSL.

## 3. KTX2 Parser

File: `ts/src/ktx2-parser.ts` (~60 lines)

Lightweight header reader for the KTX2 binary container. Reads via DataView (little-endian per spec).

```typescript
export interface KTX2Container {
  vkFormat: number;
  pixelWidth: number;
  pixelHeight: number;
  supercompressionScheme: number;  // 0=none, 1=BasisLZ
  levels: Array<{ offset: number; length: number }>;
  data: ArrayBuffer;               // raw file buffer
}

export function parseKTX2(buffer: ArrayBuffer): KTX2Container;
```

Validates the 12-byte magic: `0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A`.

Two code paths downstream:
- `supercompressionScheme = 0` AND vkFormat matches device → **fast path**: extract raw level 0 data, upload directly. No transcoder WASM loaded.
- `supercompressionScheme = 1` (BasisLZ) or UASTC → **slow path**: lazy-load transcoder, use KTX2File API.

## 4. Basis Universal Transcoder

File: `ts/src/basis-transcoder.ts` (~80-100 lines)

Wraps the vendored Basis Universal WASM module. Singleton, lazy-loaded on first KTX2 file that needs transcoding.

```typescript
export type TranscodeTarget = 'bc7' | 'astc' | 'rgba8';

export interface TranscodeResult {
  width: number;
  height: number;
  data: Uint8Array;
  format: GPUTextureFormat;
}

export class BasisTranscoder {
  private static instance: BasisTranscoder | null = null;
  static async getInstance(): Promise<BasisTranscoder>;
  transcode(fileData: Uint8Array, target: TranscodeTarget): TranscodeResult;
}
```

Internally uses the `KTX2File` high-level API from the vendored module:

```javascript
const { KTX2File, initializeBasis } = Module;
initializeBasis();
const ktx2File = new KTX2File(data);
ktx2File.startTranscoding();
const dstSize = ktx2File.getImageTranscodedSizeInBytes(0, 0, 0, format);
const dst = new Uint8Array(dstSize);
ktx2File.transcodeImage(dst, 0, 0, 0, format, 0, -1, -1);
ktx2File.close();
ktx2File.delete();  // REQUIRED: prevents WASM heap leak
```

Target format mapping:
- `'bc7'` → `BASIS_FORMAT.cTFBC7`
- `'astc'` → `BASIS_FORMAT.cTFASTC_4x4`
- `'rgba8'` → `BASIS_FORMAT.cTFRGBA32` (fallback)

Works for both UASTC and ETC1S input files. UASTC → ASTC/BC7 is near-lossless. ETC1S → BC7/ASTC is slightly lower quality but smaller file size.

## 5. TextureManager Refactor

### Constructor

```typescript
constructor(device: GPUDevice, opts?: {
  retainBitmaps?: boolean;
  compressedFormat?: GPUTextureFormat;  // 'bc7-rgba-unorm' | 'astc-4x4-unorm' | null
})
```

### Tier State

```typescript
interface TierState {
  size: number;
  format: GPUTextureFormat;
  // Primary tier
  texture: GPUTexture | null;
  view: GPUTextureView | null;
  allocatedLayers: number;
  nextFreeLayer: number;
  // Overflow tier (rgba8unorm, lazy)
  overflowTexture: GPUTexture | null;
  overflowView: GPUTextureView | null;
  overflowAllocatedLayers: number;
  overflowNextFreeLayer: number;
}
```

### Load Flow

```
loadTexture(url) →
  is KTX2? (first 12 bytes = magic)
    YES → parseKTX2 →
      scheme=0 && vkFormat matches device? → direct upload to primary tier
      else → BasisTranscoder.transcode(target) → upload to primary tier
    NO → (PNG/JPEG)
      device has compressed format?
        YES → upload to overflow tier (rgba8unorm, lazy-allocated)
        NO  → upload to primary tier (which IS rgba8unorm)
```

### Compressed Upload

Unlike PNG path (`copyExternalImageToTexture`), compressed data uses `writeTexture`:

```typescript
device.queue.writeTexture(
  { texture, origin: { x: 0, y: 0, z: layer } },
  transcodedData,
  { bytesPerRow: Math.ceil(width / 4) * 16, rowsPerImage: Math.ceil(height / 4) * 4 },
  { width, height, depthOrArrayLayers: 1 },
);
```

BC7 and ASTC 4x4 both use 4x4 blocks, 16 bytes each. Tier sizes (64-512) are all multiples of 4.

### Scenario Matrix

| Scenario | Primary tiers | Overflow tiers | Extra bindings |
|----------|--------------|----------------|----------------|
| All PNG (dev, no compression) | rgba8unorm | never allocated | 0 |
| All KTX2 (production) | bc7/astc | never allocated | 0 |
| Mixed (dev prototyping) | bc7/astc | rgba8unorm (lazy) | 0-4 |

### Pack/Unpack

```typescript
export function packTextureIndex(tier: number, layer: number, overflow = false): number {
  return (overflow ? 0x80000000 : 0) | ((tier & 0x7) << 16) | (layer & 0xFFFF);
}

export function unpackTextureIndex(packed: number): { tier: number; layer: number; overflow: boolean } {
  return {
    overflow: (packed & 0x80000000) !== 0,
    tier: (packed >>> 16) & 0x7,
    layer: packed & 0xFFFF,
  };
}
```

## 6. Shader Changes

All 6 primitive shaders get identical updates. Bind group 1 grows from 5 to 9 slots:

```wgsl
// Primary tiers (compressed or rgba8 depending on device)
@group(1) @binding(0) var tier0Tex: texture_2d_array<f32>;
@group(1) @binding(1) var tier1Tex: texture_2d_array<f32>;
@group(1) @binding(2) var tier2Tex: texture_2d_array<f32>;
@group(1) @binding(3) var tier3Tex: texture_2d_array<f32>;
@group(1) @binding(4) var texSampler: sampler;
// Overflow tiers (always rgba8unorm)
@group(1) @binding(5) var ovf0Tex: texture_2d_array<f32>;
@group(1) @binding(6) var ovf1Tex: texture_2d_array<f32>;
@group(1) @binding(7) var ovf2Tex: texture_2d_array<f32>;
@group(1) @binding(8) var ovf3Tex: texture_2d_array<f32>;
```

Sampling logic:

```wgsl
if (isOverflow == 0u) {
  switch texTier { /* primary tier0-3 */ }
} else {
  switch texTier { /* overflow ovf0-3 */ }
}
```

`texture_2d_array<f32>` works for all formats (rgba8unorm, bc7-rgba-unorm, astc-4x4-unorm) — GPU handles decompression transparently on sample.

Affected shaders: `basic.wgsl`, `line.wgsl`, `gradient.wgsl`, `box-shadow.wgsl`, `bezier.wgsl`, `msdf-text.wgsl`.

## 7. Public API

Minimal surface change:

```typescript
// Existing — no change for users
const handle = await engine.loadTexture('hero.ktx2');   // KTX2 auto-detected
const handle2 = await engine.loadTexture('debug.png');  // PNG (overflow if compressed device)

// New getter
engine.compressionFormat;  // 'bc7-rgba-unorm' | 'astc-4x4-unorm' | null
```

Detection is transparent via first-12-bytes magic check.

## 8. Compatibility Mode Constraint

WebGPU compatibility mode disallows `copyTextureToTexture` for compressed formats. Our `ensureTierCapacity()` uses this for tier growth.

Mitigation: if compatibility mode is detected, fall back to `rgba8unorm`-only tiers (no compression). Document this constraint.

## 9. Testing Strategy

| Layer | What | How |
|-------|------|-----|
| KTX2 parser | Magic validation, header fields, corrupt data | Unit tests with hand-crafted ArrayBuffers |
| Pack/unpack | Bit 31 overflow flag, backward compat | Pure function unit tests |
| TextureManager routing | KTX2→primary, PNG→overflow, no-compress→rgba8 | Mock device + mock transcoder |
| BasisTranscoder | Singleton, lazy init, cleanup (.close + .delete) | Integration test with small fixture |
| Shader sampling | Overflow branch, tier switch | Visual test only (WebGPU headless limitation) |
| ForwardPass bind group | 9 bindings, placeholder views | Unit test: creation doesn't throw |
| End-to-end | KTX2 + PNG in same scene | Visual test via demo |

Test fixture: one 8x8 KTX2 file at `ts/test-fixtures/test-8x8.ktx2`.

## 10. Files Summary

| Action | File |
|--------|------|
| Create | `ts/src/ktx2-parser.ts` |
| Create | `ts/src/ktx2-parser.test.ts` |
| Create | `ts/src/basis-transcoder.ts` |
| Create | `ts/src/basis-transcoder.test.ts` |
| Create | `ts/vendor/basis_transcoder.wasm` + `.js` |
| Create | `ts/test-fixtures/test-8x8.ktx2` |
| Modify | `ts/src/texture-manager.ts` |
| Modify | `ts/src/texture-manager.test.ts` |
| Modify | `ts/src/capabilities.ts` |
| Modify | `ts/src/capabilities.test.ts` |
| Modify | `ts/src/renderer.ts` |
| Modify | `ts/src/render/passes/forward-pass.ts` |
| Modify | 6 WGSL shaders |
| Modify | `ts/src/hyperion.ts` |
| Modify | `ts/src/index.ts` |
| Modify | `ts/src/main.ts` (demo) |

## 11. Memory Savings

| Tier (px) | Layers | RGBA8 (current) | BC7 (4:1) | ASTC 4x4 (5.33:1) |
|-----------|--------|-----------------|-----------|-------------------|
| 64 | 256 | 4 MB | 1 MB | 0.75 MB |
| 128 | 256 | 16 MB | 4 MB | 3 MB |
| 256 | 256 | 67 MB | 16.7 MB | 12.5 MB |
| 512 | 256 | 268 MB | 67 MB | 50 MB |
| **Total** | | **355 MB** | **88.7 MB** | **66.25 MB** |

Worst-case (all tiers full): 4x savings with BC7, 5.3x with ASTC.
