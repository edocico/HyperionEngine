import { isKTX2, parseKTX2, VK_FORMAT } from './ktx2-parser';
import { BasisTranscoder } from './basis-transcoder';

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
  format: GPUTextureFormat;
  texture: GPUTexture | null;
  view: GPUTextureView | null;
  allocatedLayers: number;
  nextFreeLayer: number;
  // Overflow (rgba8unorm for PNG/JPEG on compressed-primary devices)
  overflowTexture: GPUTexture | null;
  overflowView: GPUTextureView | null;
  overflowAllocatedLayers: number;
  overflowNextFreeLayer: number;
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

  /** The compressed texture format for primary tiers, or null for rgba8unorm. */
  readonly compressedFormat: GPUTextureFormat | null;

  constructor(device: GPUDevice, opts?: { retainBitmaps?: boolean; compressedFormat?: GPUTextureFormat | null }) {
    this.device = device;
    this.retainBitmaps = opts?.retainBitmaps ?? false;
    this.compressedFormat = opts?.compressedFormat ?? null;
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
        format: this.compressedFormat ?? "rgba8unorm",
        texture: null,
        view: null,
        allocatedLayers: 0,
        nextFreeLayer: 0,
        overflowTexture: null,
        overflowView: null,
        overflowAllocatedLayers: 0,
        overflowNextFreeLayer: 0,
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
      const isCompressed = state.format !== "rgba8unorm";
      state.texture = this.device.createTexture({
        size: {
          width: size,
          height: size,
          depthOrArrayLayers: 1,
        },
        format: state.format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC |
          (isCompressed ? 0 : GPUTextureUsage.RENDER_ATTACHMENT),
      });
      // Only fill with white for rgba8unorm (compressed formats can't use writeTexture with raw pixels)
      if (state.format === "rgba8unorm") {
        const white = new Uint8Array(size * size * 4);
        white.fill(255);
        this.device.queue.writeTexture(
          { texture: state.texture, origin: { x: 0, y: 0, z: 0 } },
          white,
          { bytesPerRow: size * 4, rowsPerImage: size },
          { width: size, height: size, depthOrArrayLayers: 1 },
        );
      }
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

  /** Returns the number of layers used in a tier's overflow array (including the default layer 0). */
  getOverflowLayerCount(tier: number): number {
    return this.tiers[tier].overflowNextFreeLayer;
  }

  /** Returns the current allocated layer capacity for a tier's overflow array (0 if not yet allocated). */
  getOverflowAllocatedLayers(tierIdx: number): number {
    return this.tiers[tierIdx].overflowAllocatedLayers;
  }

  /**
   * Returns the overflow Texture2DArray view for a given tier (for bind group creation).
   * Overflow tiers are always rgba8unorm, used for PNG/JPEG on compressed-primary devices.
   * If the overflow tier has not been allocated yet, lazily creates a minimal 1-layer
   * placeholder texture so that bind groups are always valid.
   */
  getOverflowTierView(tier: number): GPUTextureView {
    const state = this.tiers[tier];
    if (state.overflowView === null) {
      const size = state.size;
      state.overflowTexture = this.device.createTexture({
        size: { width: size, height: size, depthOrArrayLayers: 1 },
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const white = new Uint8Array(size * size * 4);
      white.fill(255);
      this.device.queue.writeTexture(
        { texture: state.overflowTexture, origin: { x: 0, y: 0, z: 0 } },
        white,
        { bytesPerRow: size * 4, rowsPerImage: size },
        { width: size, height: size, depthOrArrayLayers: 1 },
      );
      state.overflowView = state.overflowTexture.createView({
        dimension: "2d-array",
      });
    }
    return state.overflowView;
  }

  /**
   * Ensures the overflow tier has at least `neededLayers` allocated.
   * Growth follows the same exponential steps as primary tiers.
   * Overflow tiers are always rgba8unorm (for PNG/JPEG on compressed-primary devices).
   * On first allocation, layer 0 is filled with solid white.
   */
  ensureOverflowCapacity(tierIdx: number, neededLayers: number): void {
    const state = this.tiers[tierIdx];
    if (neededLayers <= state.overflowAllocatedLayers) return;

    // Determine new allocation size via exponential growth steps
    let newAllocation = state.overflowAllocatedLayers;
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
    const isFirstAllocation = state.overflowAllocatedLayers === 0;
    const oldTexture = state.overflowTexture;
    const oldAllocatedLayers = state.overflowAllocatedLayers;

    // Create the new, larger overflow texture (always rgba8unorm)
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
      if (state.overflowNextFreeLayer === 0) {
        state.overflowNextFreeLayer = 1;
      }
    } else if (oldTexture !== null && oldAllocatedLayers > 0) {
      // Copy existing layers from old overflow texture to new
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

    // Destroy old overflow texture (including placeholder)
    if (oldTexture !== null) {
      oldTexture.destroy();
    }

    // Update overflow state
    state.overflowTexture = newTexture;
    state.overflowView = newTexture.createView({ dimension: "2d-array" });
    state.overflowAllocatedLayers = newAllocation;
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

    // Create the new, larger texture (compressed formats can't have RENDER_ATTACHMENT)
    const isCompressed = state.format !== "rgba8unorm";
    const newTexture = this.device.createTexture({
      size: {
        width: size,
        height: size,
        depthOrArrayLayers: newAllocation,
      },
      format: state.format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        (isCompressed ? 0 : GPUTextureUsage.RENDER_ATTACHMENT),
    });

    if (isFirstAllocation) {
      // Only fill layer 0 with solid white for rgba8unorm
      // (compressed formats receive pre-transcoded data and can't use writeTexture with raw pixels)
      if (state.format === "rgba8unorm") {
        const white = new Uint8Array(size * size * 4);
        white.fill(255);
        this.device.queue.writeTexture(
          { texture: newTexture, origin: { x: 0, y: 0, z: 0 } },
          white,
          { bytesPerRow: size * 4, rowsPerImage: size },
          { width: size, height: size, depthOrArrayLayers: 1 },
        );
      }
      // Reserve layer 0 for default
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

      const arrayBuffer = await response.arrayBuffer();

      if (isKTX2(arrayBuffer)) {
        // KTX2 path
        await this.handleKTX2(arrayBuffer, tier, url, resolve);
      } else {
        // PNG/JPEG path (existing logic, adapted to use ArrayBuffer -> Blob)
        await this.handleImageBitmap(arrayBuffer, tier, url, resolve);
      }
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.activeFetches--;
      this.drainFetchQueue();
    }
  }

  private async handleImageBitmap(
    arrayBuffer: ArrayBuffer,
    tierOverride: number,
    url: string,
    resolve: (packed: number) => void,
  ): Promise<void> {
    const blob = new Blob([arrayBuffer]);

    let actualTier: number;
    let bitmap: ImageBitmap;

    if (tierOverride === -1) {
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
      actualTier = tierOverride;
      const targetSize = TIER_SIZES[actualTier];
      bitmap = await createImageBitmap(blob, {
        resizeWidth: targetSize,
        resizeHeight: targetSize,
        resizeQuality: "high",
      });
    }

    const state = this.tiers[actualTier];

    // If primary tiers use a compressed format, PNG/JPEG goes to overflow
    if (this.compressedFormat !== null) {
      // Upload to overflow tier (rgba8unorm)
      this.ensureOverflowCapacity(actualTier, state.overflowNextFreeLayer + 1);
      const layer = state.overflowNextFreeLayer;
      if (layer >= MAX_LAYERS_PER_TIER) {
        bitmap.close();
        throw new Error(`Overflow tier ${actualTier} (${TIER_SIZES[actualTier]}px) is full`);
      }
      state.overflowNextFreeLayer++;
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: state.overflowTexture!, origin: { x: 0, y: 0, z: layer } },
        { width: bitmap.width, height: bitmap.height },
      );
      if (this.retainBitmaps) {
        this.bitmapCache.set(url, bitmap);
      } else {
        bitmap.close();
      }
      const packed = packTextureIndex(actualTier, layer, true); // overflow=true
      this.cache.set(url, packed);
      this.loaded++;
      this.onProgress?.(this.loaded, this.total);
      resolve(packed);
    } else {
      // No compressed format — upload to primary tier (rgba8unorm) as before
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
    }
  }

  private async handleKTX2(
    arrayBuffer: ArrayBuffer,
    tierOverride: number,
    url: string,
    resolve: (packed: number) => void,
  ): Promise<void> {
    const container = parseKTX2(arrayBuffer);
    const actualTier = tierOverride === -1
      ? selectTier(container.pixelWidth, container.pixelHeight)
      : tierOverride;
    const state = this.tiers[actualTier];

    // Determine if we need transcoding or can do direct upload
    const needsTranscoding = container.supercompressionScheme !== 0 ||
      container.vkFormat === VK_FORMAT.UNDEFINED;

    if (needsTranscoding) {
      // Lazy-load transcoder and transcode
      const target = this.compressedFormat === 'bc7-rgba-unorm' ? 'bc7' as const
        : this.compressedFormat === 'astc-4x4-unorm' ? 'astc' as const
        : 'rgba8' as const;
      const transcoder = await BasisTranscoder.getInstance();
      const result = transcoder.transcode(new Uint8Array(arrayBuffer), target);

      // Upload transcoded data
      this.ensureTierCapacity(actualTier, state.nextFreeLayer + 1);
      const layer = state.nextFreeLayer;
      if (layer >= MAX_LAYERS_PER_TIER) {
        throw new Error(`Tier ${actualTier} (${TIER_SIZES[actualTier]}px) is full`);
      }
      state.nextFreeLayer++;

      const bytesPerRow = BasisTranscoder.blockBytesPerRow(result.width, target);
      this.device.queue.writeTexture(
        { texture: state.texture!, origin: { x: 0, y: 0, z: layer } },
        result.data as Uint8Array<ArrayBuffer>,
        { bytesPerRow, rowsPerImage: result.height },
        { width: result.width, height: result.height, depthOrArrayLayers: 1 },
      );

      const packed = packTextureIndex(actualTier, layer);
      this.cache.set(url, packed);
      this.loaded++;
      this.onProgress?.(this.loaded, this.total);
      resolve(packed);
    } else {
      // Direct upload — fast path for pre-compressed KTX2
      // Validate that the KTX2's native format matches the device's tier format
      const isBC7 = container.vkFormat === VK_FORMAT.BC7_UNORM_BLOCK || container.vkFormat === VK_FORMAT.BC7_SRGB_BLOCK;
      const isASTC = container.vkFormat === VK_FORMAT.ASTC_4x4_UNORM_BLOCK || container.vkFormat === VK_FORMAT.ASTC_4x4_SRGB_BLOCK;
      const formatMatchesTier =
        (state.format === 'bc7-rgba-unorm' && isBC7) ||
        (state.format === 'astc-4x4-unorm' && isASTC) ||
        (state.format === 'rgba8unorm');

      if (!formatMatchesTier) {
        throw new Error(
          `KTX2 vkFormat ${container.vkFormat} does not match tier format ${state.format}`
        );
      }

      this.ensureTierCapacity(actualTier, state.nextFreeLayer + 1);
      const layer = state.nextFreeLayer;
      if (layer >= MAX_LAYERS_PER_TIER) {
        throw new Error(`Tier ${actualTier} (${TIER_SIZES[actualTier]}px) is full`);
      }
      state.nextFreeLayer++;

      const level = container.levels[0];
      const levelData = new Uint8Array(arrayBuffer, level.offset, level.length);

      // Determine target for bytesPerRow calculation
      const target = this.compressedFormat === 'bc7-rgba-unorm' ? 'bc7' as const
        : this.compressedFormat === 'astc-4x4-unorm' ? 'astc' as const
        : 'rgba8' as const;
      const bytesPerRow = BasisTranscoder.blockBytesPerRow(container.pixelWidth, target);

      this.device.queue.writeTexture(
        { texture: state.texture!, origin: { x: 0, y: 0, z: layer } },
        levelData as Uint8Array<ArrayBuffer>,
        { bytesPerRow, rowsPerImage: container.pixelHeight },
        { width: container.pixelWidth, height: container.pixelHeight, depthOrArrayLayers: 1 },
      );

      const packed = packTextureIndex(actualTier, layer);
      this.cache.set(url, packed);
      this.loaded++;
      this.onProgress?.(this.loaded, this.total);
      resolve(packed);
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
      if (state.overflowTexture !== null) {
        state.overflowTexture.destroy();
        state.overflowTexture = null;
        state.overflowView = null;
      }
    }
    for (const bm of this.bitmapCache.values()) bm.close();
    this.bitmapCache.clear();
  }
}
