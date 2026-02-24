import { describe, it, expect, beforeAll } from "vitest";
import { selectTier, TIER_SIZES, packTextureIndex, unpackTextureIndex, TextureManager } from "./texture-manager";

// Polyfill GPUTextureUsage for Node/vitest environment (browser global)
beforeAll(() => {
  if (typeof globalThis.GPUTextureUsage === "undefined") {
    (globalThis as any).GPUTextureUsage = {
      COPY_SRC: 0x01,
      COPY_DST: 0x02,
      TEXTURE_BINDING: 0x04,
      STORAGE_BINDING: 0x08,
      RENDER_ATTACHMENT: 0x10,
    };
  }
});

/** Reusable mock GPUDevice for TextureManager tests. */
function createMockDevice(): GPUDevice {
  return {
    createSampler: () => ({}),
    createTexture: (desc: any) => ({
      desc,
      createView: () => ({}),
      destroy: () => {},
    }),
    queue: {
      writeTexture: () => {},
      copyExternalImageToTexture: () => {},
      submit: () => {},
    },
    createCommandEncoder: () => ({
      copyTextureToTexture: () => {},
      finish: () => ({}),
    }),
  } as unknown as GPUDevice;
}

describe("Texture tier selection", () => {
  it("selects tier 0 for images <= 64px", () => {
    expect(selectTier(32, 32)).toBe(0);
    expect(selectTier(64, 64)).toBe(0);
    expect(selectTier(48, 60)).toBe(0);
  });

  it("selects tier 1 for images 65-128px", () => {
    expect(selectTier(65, 65)).toBe(1);
    expect(selectTier(128, 128)).toBe(1);
    expect(selectTier(100, 80)).toBe(1);
  });

  it("selects tier 2 for images 129-256px", () => {
    expect(selectTier(200, 200)).toBe(2);
    expect(selectTier(256, 256)).toBe(2);
  });

  it("selects tier 3 for images 257-512px", () => {
    expect(selectTier(300, 300)).toBe(3);
    expect(selectTier(512, 512)).toBe(3);
  });

  it("clamps oversized images to tier 3", () => {
    expect(selectTier(1024, 1024)).toBe(3);
  });

  it("uses max dimension for non-square images", () => {
    expect(selectTier(200, 64)).toBe(2); // max(200, 64) = 200 → tier 2
  });
});

describe("Texture index packing", () => {
  it("packs tier and layer into u32", () => {
    const packed = packTextureIndex(2, 10);
    expect(packed).toBe((2 << 16) | 10);
  });

  it("unpacks tier and layer from u32", () => {
    const packed = (3 << 16) | 42;
    const { tier, layer } = unpackTextureIndex(packed);
    expect(tier).toBe(3);
    expect(layer).toBe(42);
  });

  it("round-trips correctly", () => {
    for (let tier = 0; tier < 4; tier++) {
      for (const layer of [0, 1, 100, 255]) {
        const packed = packTextureIndex(tier, layer);
        const unpacked = unpackTextureIndex(packed);
        expect(unpacked.tier).toBe(tier);
        expect(unpacked.layer).toBe(layer);
      }
    }
  });
});

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

describe("TIER_SIZES", () => {
  it("has 4 tiers with correct dimensions", () => {
    expect(TIER_SIZES).toEqual([64, 128, 256, 512]);
  });
});

describe("Lazy tier allocation", () => {
  it("should not allocate tiers upfront", () => {
    // Mock device that tracks createTexture calls
    const textures: any[] = [];
    const mockDevice = {
      createSampler: () => ({}),
      createTexture: (desc: any) => {
        const t = { desc, createView: () => ({}), destroy: () => {} };
        textures.push(t);
        return t;
      },
      queue: {
        writeTexture: () => {},
        copyExternalImageToTexture: () => {},
        submit: () => {},
      },
    } as unknown as GPUDevice;

    const tm = new TextureManager(mockDevice);
    expect(tm.getAllocatedLayers(0)).toBe(0);
    expect(tm.getAllocatedLayers(1)).toBe(0);
    expect(tm.getAllocatedLayers(2)).toBe(0);
    expect(tm.getAllocatedLayers(3)).toBe(0);
    expect(textures.length).toBe(0); // No textures created
  });

  it("should allocate 16 layers on first ensureTierCapacity", () => {
    const textures: any[] = [];
    const mockDevice = {
      createSampler: () => ({}),
      createTexture: (desc: any) => {
        const t = { desc, createView: () => ({}), destroy: () => {} };
        textures.push(t);
        return t;
      },
      queue: {
        writeTexture: () => {},
        submit: () => {},
      },
    } as unknown as GPUDevice;

    const tm = new TextureManager(mockDevice);
    tm.ensureTierCapacity(0, 1);
    expect(tm.getAllocatedLayers(0)).toBe(16);
    expect(textures.length).toBe(1);
    expect(textures[0].desc.size.depthOrArrayLayers).toBe(16);
  });

  it("should grow exponentially: 16 → 32 → 64 → 128 → 256", () => {
    const mockDevice = {
      createSampler: () => ({}),
      createTexture: (desc: any) => ({
        desc, createView: () => ({}), destroy: () => {},
      }),
      queue: {
        writeTexture: () => {},
        submit: () => {},
      },
      createCommandEncoder: () => ({
        copyTextureToTexture: () => {},
        finish: () => ({}),
      }),
    } as unknown as GPUDevice;

    const tm = new TextureManager(mockDevice);
    tm.ensureTierCapacity(0, 1);
    expect(tm.getAllocatedLayers(0)).toBe(16);
    tm.ensureTierCapacity(0, 17);
    expect(tm.getAllocatedLayers(0)).toBe(32);
    tm.ensureTierCapacity(0, 33);
    expect(tm.getAllocatedLayers(0)).toBe(64);
    tm.ensureTierCapacity(0, 65);
    expect(tm.getAllocatedLayers(0)).toBe(128);
    tm.ensureTierCapacity(0, 129);
    expect(tm.getAllocatedLayers(0)).toBe(256);
  });
});

describe("retainBitmaps option", () => {
  it("retainBitmaps option keeps ImageBitmaps for re-upload", () => {
    const device = createMockDevice();
    const tm = new TextureManager(device, { retainBitmaps: true });
    expect(tm.retainBitmaps).toBe(true);
  });

  it("retainBitmaps defaults to false", () => {
    const device = createMockDevice();
    const tm = new TextureManager(device);
    expect(tm.retainBitmaps).toBe(false);
  });

  it("retainBitmaps false when explicitly set", () => {
    const device = createMockDevice();
    const tm = new TextureManager(device, { retainBitmaps: false });
    expect(tm.retainBitmaps).toBe(false);
  });
});

describe("TextureManager with compressed format", () => {
  it("should accept compressedFormat option", () => {
    const device = createMockDevice();
    const tm = new TextureManager(device, { compressedFormat: "bc7-rgba-unorm" as GPUTextureFormat });
    expect(tm.compressedFormat).toBe("bc7-rgba-unorm");
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
    const tm = new TextureManager(device, { compressedFormat: "bc7-rgba-unorm" as GPUTextureFormat });
    tm.ensureTierCapacity(0, 1);
    expect(textures[0].desc.format).toBe("bc7-rgba-unorm");
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
    expect(textures[0].desc.format).toBe("rgba8unorm");
  });

  it("should not call writeTexture for compressed primary tier on first allocation", () => {
    let writeTextureCalls = 0;
    const device = {
      ...createMockDevice(),
      createTexture: (desc: any) => ({
        desc,
        createView: () => ({}),
        destroy: () => {},
      }),
      queue: {
        ...createMockDevice().queue,
        writeTexture: () => { writeTextureCalls++; },
        submit: () => {},
      },
    } as unknown as GPUDevice;
    const tm = new TextureManager(device, { compressedFormat: "bc7-rgba-unorm" as GPUTextureFormat });
    tm.ensureTierCapacity(0, 1);
    expect(writeTextureCalls).toBe(0);
  });

  it("should expose overflow view getters", () => {
    const device = createMockDevice();
    const tm = new TextureManager(device, { compressedFormat: "bc7-rgba-unorm" as GPUTextureFormat });
    const view = tm.getOverflowTierView(0);
    expect(view).toBeTruthy();
  });

  it("should not allocate overflow when no compressed format", () => {
    const device = createMockDevice();
    const tm = new TextureManager(device);
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
    const tm = new TextureManager(device, { compressedFormat: "bc7-rgba-unorm" as GPUTextureFormat });
    tm.ensureOverflowCapacity(0, 1);
    const overflowTex = textures.find((t) => t.desc.format === "rgba8unorm");
    expect(overflowTex).toBeTruthy();
  });

  it("ensureOverflowCapacity grows exponentially like primary tiers", () => {
    const mockDevice = {
      createSampler: () => ({}),
      createTexture: (desc: any) => ({
        desc, createView: () => ({}), destroy: () => {},
      }),
      queue: {
        writeTexture: () => {},
        submit: () => {},
      },
      createCommandEncoder: () => ({
        copyTextureToTexture: () => {},
        finish: () => ({}),
      }),
    } as unknown as GPUDevice;

    const tm = new TextureManager(mockDevice, { compressedFormat: 'bc7-rgba-unorm' });
    tm.ensureOverflowCapacity(0, 1);
    expect(tm.getOverflowAllocatedLayers(0)).toBe(16);
    tm.ensureOverflowCapacity(0, 17);
    expect(tm.getOverflowAllocatedLayers(0)).toBe(32);
    tm.ensureOverflowCapacity(0, 33);
    expect(tm.getOverflowAllocatedLayers(0)).toBe(64);
    tm.ensureOverflowCapacity(0, 65);
    expect(tm.getOverflowAllocatedLayers(0)).toBe(128);
    tm.ensureOverflowCapacity(0, 129);
    expect(tm.getOverflowAllocatedLayers(0)).toBe(256);
  });

  it("getTierView uses compressed format for placeholder", () => {
    const textures: any[] = [];
    const device = {
      ...createMockDevice(),
      createTexture: (desc: any) => {
        const t = { desc, createView: () => ({}), destroy: () => {} };
        textures.push(t);
        return t;
      },
    } as unknown as GPUDevice;
    const tm = new TextureManager(device, { compressedFormat: "astc-4x4-unorm" as GPUTextureFormat });
    tm.getTierView(0);
    expect(textures[0].desc.format).toBe("astc-4x4-unorm");
  });

  it("getOverflowTierView always uses rgba8unorm", () => {
    const textures: any[] = [];
    const device = {
      ...createMockDevice(),
      createTexture: (desc: any) => {
        const t = { desc, createView: () => ({}), destroy: () => {} };
        textures.push(t);
        return t;
      },
    } as unknown as GPUDevice;
    const tm = new TextureManager(device, { compressedFormat: "bc7-rgba-unorm" as GPUTextureFormat });
    tm.getOverflowTierView(0);
    expect(textures[0].desc.format).toBe("rgba8unorm");
  });

  it("destroy cleans up overflow textures", () => {
    let destroyCalls = 0;
    const device = {
      ...createMockDevice(),
      createTexture: (desc: any) => ({
        desc,
        createView: () => ({}),
        destroy: () => { destroyCalls++; },
      }),
    } as unknown as GPUDevice;
    const tm = new TextureManager(device, { compressedFormat: "bc7-rgba-unorm" as GPUTextureFormat });
    tm.getOverflowTierView(0);
    tm.getOverflowTierView(1);
    destroyCalls = 0;
    tm.destroy();
    // Should have destroyed 2 overflow textures (tiers 0 and 1)
    expect(destroyCalls).toBe(2);
  });
});
