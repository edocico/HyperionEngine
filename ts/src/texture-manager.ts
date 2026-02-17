/** Texture2DArray size tiers (pixels). */
export const TIER_SIZES = [64, 128, 256, 512] as const;
export const NUM_TIERS = TIER_SIZES.length;
export const MAX_LAYERS_PER_TIER = 256;

/**
 * Select the appropriate tier for an image based on its largest dimension.
 * Images are scaled to the tier size, so we pick the smallest tier that fits.
 */
export function selectTier(width: number, height: number): number {
  const maxDim = Math.max(width, height);
  for (let i = 0; i < TIER_SIZES.length; i++) {
    if (maxDim <= TIER_SIZES[i]) return i;
  }
  return TIER_SIZES.length - 1;
}

/**
 * Pack a tier index and layer index into a single u32.
 * Layout: [tier: upper 16 bits][layer: lower 16 bits]
 */
export function packTextureIndex(tier: number, layer: number): number {
  return ((tier & 0xffff) << 16) | (layer & 0xffff);
}

/**
 * Unpack a tier index and layer index from a packed u32.
 */
export function unpackTextureIndex(packed: number): {
  tier: number;
  layer: number;
} {
  return {
    tier: (packed >>> 16) & 0xffff,
    layer: packed & 0xffff,
  };
}

const MAX_CONCURRENT_FETCHES = 6;

interface FetchJob {
  url: string;
  tier: number;
  resolve: (packed: number) => void;
  reject: (err: Error) => void;
}

/**
 * Manages 4 tiers of Texture2DArray (64, 128, 256, 512 px).
 *
 * Images are loaded via fetch -> Blob -> createImageBitmap (with resize) ->
 * copyExternalImageToTexture. Pixels never traverse WASM memory.
 *
 * Layer 0 of each tier is a solid-white default texture.
 * Concurrency is limited to 6 parallel fetches.
 */
export class TextureManager {
  private readonly device: GPUDevice;
  private readonly tierTextures: GPUTexture[];
  private readonly tierViews: GPUTextureView[];
  private readonly tierNextLayer: number[];
  private readonly _sampler: GPUSampler;
  private activeFetches = 0;
  private readonly fetchQueue: FetchJob[] = [];
  private readonly cache = new Map<string, number>();
  private loaded = 0;
  private total = 0;
  onProgress: ((loaded: number, total: number) => void) | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
    this.tierTextures = [];
    this.tierViews = [];
    this.tierNextLayer = [];
    this._sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
    });

    for (let tier = 0; tier < NUM_TIERS; tier++) {
      const size = TIER_SIZES[tier];
      const texture = device.createTexture({
        size: {
          width: size,
          height: size,
          depthOrArrayLayers: MAX_LAYERS_PER_TIER,
        },
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });

      // Fill layer 0 with solid white as a default texture
      const white = new Uint8Array(size * size * 4);
      white.fill(255);
      device.queue.writeTexture(
        { texture, origin: { x: 0, y: 0, z: 0 } },
        white,
        { bytesPerRow: size * 4, rowsPerImage: size },
        { width: size, height: size, depthOrArrayLayers: 1 },
      );

      this.tierTextures.push(texture);
      this.tierViews.push(texture.createView({ dimension: "2d-array" }));
      this.tierNextLayer.push(1); // layer 0 is the default white
    }
  }

  /** Returns the Texture2DArray view for a given tier (for bind group creation). */
  getTierView(tier: number): GPUTextureView {
    return this.tierViews[tier];
  }

  /** Returns the shared linear sampler. */
  getSampler(): GPUSampler {
    return this._sampler;
  }

  /** Returns the number of layers used in a tier (including the default layer 0). */
  getLayerCount(tier: number): number {
    return this.tierNextLayer[tier];
  }

  /**
   * Load a texture from a URL into the appropriate tier.
   * Returns a packed u32 index (tier << 16 | layer).
   *
   * If the URL has already been loaded, returns the cached index immediately.
   * An optional tierOverride forces the image into a specific tier.
   */
  async loadTexture(url: string, tierOverride?: number): Promise<number> {
    const cached = this.cache.get(url);
    if (cached !== undefined) return cached;
    this.total++;
    return new Promise<number>((resolve, reject) => {
      const tier = tierOverride !== undefined ? tierOverride : -1;
      this.fetchQueue.push({ url, tier, resolve, reject });
      this.drainFetchQueue();
    });
  }

  private drainFetchQueue(): void {
    while (
      this.activeFetches < MAX_CONCURRENT_FETCHES &&
      this.fetchQueue.length > 0
    ) {
      const job = this.fetchQueue.shift()!;
      this.activeFetches++;
      this.executeFetch(job.url, job.tier, job.resolve, job.reject);
    }
  }

  private async executeFetch(
    url: string,
    tier: number,
    resolve: (packed: number) => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`Failed to fetch ${url}: ${response.status}`);
      const blob = await response.blob();

      let actualTier: number;
      let bitmap: ImageBitmap;

      if (tier === -1) {
        // Auto-detect tier from original image dimensions
        const origBitmap = await createImageBitmap(blob);
        actualTier = selectTier(origBitmap.width, origBitmap.height);
        origBitmap.close();
        const targetSize = TIER_SIZES[actualTier];
        bitmap = await createImageBitmap(blob, {
          resizeWidth: targetSize,
          resizeHeight: targetSize,
          resizeQuality: "high",
        });
      } else {
        actualTier = tier;
        const targetSize = TIER_SIZES[actualTier];
        bitmap = await createImageBitmap(blob, {
          resizeWidth: targetSize,
          resizeHeight: targetSize,
          resizeQuality: "high",
        });
      }

      const layer = this.tierNextLayer[actualTier];
      if (layer >= MAX_LAYERS_PER_TIER) {
        bitmap.close();
        throw new Error(
          `Tier ${actualTier} (${TIER_SIZES[actualTier]}px) is full — max ${MAX_LAYERS_PER_TIER} layers`,
        );
      }
      this.tierNextLayer[actualTier]++;

      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        {
          texture: this.tierTextures[actualTier],
          origin: { x: 0, y: 0, z: layer },
        },
        { width: bitmap.width, height: bitmap.height },
      );
      bitmap.close();

      const packed = packTextureIndex(actualTier, layer);
      this.cache.set(url, packed);
      this.loaded++;
      this.onProgress?.(this.loaded, this.total);
      resolve(packed);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.activeFetches--;
      this.drainFetchQueue();
    }
  }

  /** Destroy all GPU textures. */
  destroy(): void {
    for (const tex of this.tierTextures) {
      tex.destroy();
    }
  }
}
