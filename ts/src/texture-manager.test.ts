import { describe, it, expect } from "vitest";
import { selectTier, TIER_SIZES, packTextureIndex, unpackTextureIndex } from "./texture-manager";

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

describe("TIER_SIZES", () => {
  it("has 4 tiers with correct dimensions", () => {
    expect(TIER_SIZES).toEqual([64, 128, 256, 512]);
  });
});
