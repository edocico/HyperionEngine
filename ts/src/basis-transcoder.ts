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
  getImageTranscodedSizeInBytes(
    levelIndex: number,
    layerIndex: number,
    faceIndex: number,
    format: number,
  ): number;
  transcodeImage(
    dst: Uint8Array,
    levelIndex: number,
    layerIndex: number,
    faceIndex: number,
    format: number,
    getAlphaForOpaqueFormats: number,
    channel0: number,
    channel1: number,
  ): boolean;
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
    const { default: createModule } = await import(
      '../vendor/basis_transcoder.js'
    );
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

      const dstSize = ktx2File.getImageTranscodedSizeInBytes(
        0,
        0,
        0,
        basisFormat,
      );
      const dst = new Uint8Array(dstSize);

      if (
        !ktx2File.transcodeImage(dst, 0, 0, 0, basisFormat, 0, -1, -1)
      ) {
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
      case 'bc7':
        return 'bc7-rgba-unorm';
      case 'astc':
        return 'astc-4x4-unorm';
      case 'rgba8':
        return 'rgba8unorm';
    }
  }

  /** Map TranscodeTarget to Basis Universal format enum value. */
  static mapTargetToBasisFormat(target: TranscodeTarget): number {
    switch (target) {
      case 'bc7':
        return BASIS_FORMAT.cTFBC7;
      case 'astc':
        return BASIS_FORMAT.cTFASTC_4x4;
      case 'rgba8':
        return BASIS_FORMAT.cTFRGBA32;
    }
  }

  /** Calculate bytesPerRow for writeTexture with block-compressed data. */
  static blockBytesPerRow(width: number, target: TranscodeTarget): number {
    if (target === 'rgba8') return width * 4;
    // BC7 and ASTC 4x4: 4x4 blocks, 16 bytes each
    return Math.ceil(width / 4) * 16;
  }
}
