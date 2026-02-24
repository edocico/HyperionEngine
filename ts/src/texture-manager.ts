/** Texture2DArray size tiers (pixels). */
export const TIER_SIZES = [64, 128, 256, 512] as const;
export const NUM_TIERS = TIER_SIZES.length;
export const MAX_LAYERS_PER_TIER = 256;

/** Exponential growth steps for lazy tier allocation. */
const GROWTH_STEPS = [16, 32, 64, 128, 256] as const;

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

const MAX_CONCURRENT_FETCHES = 6;

interface FetchJob {
  url: string;
  tier: number;
  resolve: (packed: number) => void;
  reject: (err: Error) => void;
}

/** Per-tier state for lazy allocation. */
interface TierState {
  size: number;
  texture: GPUTexture | null;
  view: GPUTextureView | null;
  allocatedLayers: number;
  nextFreeLayer: number;
}

/**
 * Manages 4 tiers of Texture2DArray (64, 128, 256, 512 px).
 *
 * Tiers are allocated lazily: no GPU textures are created until needed.
 * When a tier is first used, it starts with 16 layers and grows
 * exponentially (16 -> 32 -> 64 -> 128 -> 256) via GPU copy-on-resize.
 *
 * Images are loaded via fetch -> Blob -> createImageBitmap (with resize) ->
 * copyExternalImageToTexture. Pixels never traverse WASM memory.
 *
 * Layer 0 of each tier is a solid-white default texture (written on first allocation).
 * Concurrency is limited to 6 parallel fetches.
 */
export class TextureManager {
  private readonly device: GPUDevice;
  private readonly tiers: TierState[];
  private readonly _sampler: GPUSampler;
  private activeFetches = 0;
  private readonly fetchQueue: FetchJob[] = [];
  private readonly cache = new Map<string, number>();
  private readonly bitmapCache = new Map<string, ImageBitmap>();
  private loaded = 0;
  private total = 0;
  onProgress: ((loaded: number, total: number) => void) | null = null;

  /** When true, ImageBitmaps are kept in memory after upload for device-lost re-upload. */
  readonly retainBitmaps: boolean;

  constructor(device: GPUDevice, opts?: { retainBitmaps?: boolean }) {
    this.device = device;
    this.retainBitmaps = opts?.retainBitmaps ?? false;
    this._sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "nearest",
    });

    // Initialize tier state without creating any GPU textures
    this.tiers = [];
    for (let tier = 0; tier < NUM_TIERS; tier++) {
      this.tiers.push({
        size: TIER_SIZES[tier],
        texture: null,
        view: null,
        allocatedLayers: 0,
        nextFreeLayer: 0,
      });
    }
  }

  /**
   * Returns the Texture2DArray view for a given tier (for bind group creation).
   * If the tier has not been allocated yet, lazily creates a minimal 1-layer
   * placeholder texture so that bind groups are always valid.
   */
  getTierView(tier: number): GPUTextureView {
    const state = this.tiers[tier];
    if (state.view === null) {
      // Create a minimal 1-layer placeholder (not counted in allocatedLayers)
      const size = state.size;
      state.texture = this.device.createTexture({
        size: {
          width: size,
          height: size,
          depthOrArrayLayers: 1,
        },
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      // Fill the placeholder layer with solid white
      const white = new Uint8Array(size * size * 4);
      white.fill(255);
      this.device.queue.writeTexture(
        { texture: state.texture, origin: { x: 0, y: 0, z: 0 } },
        white,
        { bytesPerRow: size * 4, rowsPerImage: size },
        { width: size, height: size, depthOrArrayLayers: 1 },
      );
      state.view = state.texture.createView({ dimension: "2d-array" });
      // allocatedLayers stays 0 — this is just a placeholder
      // nextFreeLayer stays 0 — layer 0 default will be set up on first real allocation
    }
    return state.view;
  }

  /** Returns the shared linear sampler. */
  getSampler(): GPUSampler {
    return this._sampler;
  }

  /** Returns the number of layers used in a tier (including the default layer 0). */
  getLayerCount(tier: number): number {
    return this.tiers[tier].nextFreeLayer;
  }

  /** Returns the current allocated layer capacity for a tier (0 if not yet allocated). */
  getAllocatedLayers(tierIdx: number): number {
    return this.tiers[tierIdx].allocatedLayers;
  }

  /**
   * Ensures a tier has at least `neededLayers` allocated.
   * Growth follows exponential steps: 0 -> 16 -> 32 -> 64 -> 128 -> 256.
   * If the tier must grow, a new texture is created, existing layers are
   * copied via GPU command encoder, and the old texture is destroyed.
   * On first allocation (0 -> 16), layer 0 is filled with solid white.
   */
  ensureTierCapacity(tierIdx: number, neededLayers: number): void {
    const state = this.tiers[tierIdx];
    if (neededLayers <= state.allocatedLayers) return;

    // Determine new allocation size via exponential growth steps
    let newAllocation = state.allocatedLayers;
    for (const step of GROWTH_STEPS) {
      if (step > newAllocation && step >= neededLayers) {
        newAllocation = step;
        break;
      }
      if (step > newAllocation) {
        newAllocation = step;
      }
    }
    // Clamp to MAX_LAYERS_PER_TIER
    if (newAllocation > MAX_LAYERS_PER_TIER) {
      newAllocation = MAX_LAYERS_PER_TIER;
    }

    const size = state.size;
    const isFirstAllocation = state.allocatedLayers === 0;
    const oldTexture = state.texture;
    const oldAllocatedLayers = state.allocatedLayers;

    // Create the new, larger texture
    const newTexture = this.device.createTexture({
      size: {
        width: size,
        height: size,
        depthOrArrayLayers: newAllocation,
      },
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    if (isFirstAllocation) {
      // Fill layer 0 with solid white as the default texture
      const white = new Uint8Array(size * size * 4);
      white.fill(255);
      this.device.queue.writeTexture(
        { texture: newTexture, origin: { x: 0, y: 0, z: 0 } },
        white,
        { bytesPerRow: size * 4, rowsPerImage: size },
        { width: size, height: size, depthOrArrayLayers: 1 },
      );
      // Reserve layer 0 for default white
      if (state.nextFreeLayer === 0) {
        state.nextFreeLayer = 1;
      }
    } else if (oldTexture !== null && oldAllocatedLayers > 0) {
      // Copy existing layers from old texture to new texture
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToTexture(
        { texture: oldTexture, origin: { x: 0, y: 0, z: 0 } },
        { texture: newTexture, origin: { x: 0, y: 0, z: 0 } },
        {
          width: size,
          height: size,
          depthOrArrayLayers: oldAllocatedLayers,
        },
      );
      this.device.queue.submit([encoder.finish()]);
    }

    // Destroy old texture (including placeholder)
    if (oldTexture !== null) {
      oldTexture.destroy();
    }

    // Update state
    state.texture = newTexture;
    state.view = newTexture.createView({ dimension: "2d-array" });
    state.allocatedLayers = newAllocation;
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
      if (tierOverride !== undefined && (tierOverride < 0 || tierOverride >= NUM_TIERS)) {
        reject(new Error(`Invalid tier override: ${tierOverride}, must be 0-${NUM_TIERS - 1}`));
        return;
      }
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

      const state = this.tiers[actualTier];

      // Ensure the tier has enough capacity for the next layer
      this.ensureTierCapacity(actualTier, state.nextFreeLayer + 1);

      const layer = state.nextFreeLayer;
      if (layer >= MAX_LAYERS_PER_TIER) {
        bitmap.close();
        throw new Error(
          `Tier ${actualTier} (${TIER_SIZES[actualTier]}px) is full — max ${MAX_LAYERS_PER_TIER} layers`,
        );
      }
      state.nextFreeLayer++;

      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        {
          texture: state.texture!,
          origin: { x: 0, y: 0, z: layer },
        },
        { width: bitmap.width, height: bitmap.height },
      );
      if (this.retainBitmaps) {
        this.bitmapCache.set(url, bitmap);
      } else {
        bitmap.close();
      }

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

  /** Destroy all GPU textures and release retained bitmaps. */
  destroy(): void {
    for (const state of this.tiers) {
      if (state.texture !== null) {
        state.texture.destroy();
        state.texture = null;
        state.view = null;
      }
    }
    for (const bm of this.bitmapCache.values()) bm.close();
    this.bitmapCache.clear();
  }
}
