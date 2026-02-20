import { describe, it, expect } from 'vitest';
import { layoutText } from './text-layout';
import type { FontAtlas } from './font-atlas';

const mockAtlas: FontAtlas = {
  atlas: { type: 'msdf', distanceRange: 4, size: 32, width: 512, height: 512 },
  metrics: { lineHeight: 1.2, ascender: 0.8, descender: -0.2 },
  glyphs: [
    { unicode: 72, advance: 0.6, planeBounds: { left: 0, bottom: 0, right: 0.5, top: 0.8 }, atlasBounds: { left: 0, bottom: 0, right: 16, top: 26 } },
    { unicode: 105, advance: 0.3, planeBounds: { left: 0.05, bottom: 0, right: 0.25, top: 0.8 }, atlasBounds: { left: 20, bottom: 0, right: 26, top: 26 } },
  ],
  glyphMap: new Map(),
};
mockAtlas.glyphMap.set(72, mockAtlas.glyphs[0]);  // 'H'
mockAtlas.glyphMap.set(105, mockAtlas.glyphs[1]); // 'i'

describe('layoutText', () => {
  it('should position glyphs sequentially', () => {
    const glyphs = layoutText('Hi', mockAtlas, 32, 100, 200);
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0].unicode).toBe(72);
    expect(glyphs[0].x).toBe(100);
    expect(glyphs[1].x).toBeGreaterThan(glyphs[0].x);
  });

  it('should skip missing glyphs', () => {
    const glyphs = layoutText('H?i', mockAtlas, 32, 0, 0);
    expect(glyphs).toHaveLength(2);
  });

  it('should scale with fontSize', () => {
    const small = layoutText('H', mockAtlas, 16, 0, 0);
    const large = layoutText('H', mockAtlas, 64, 0, 0);
    expect(large[0].width).toBeGreaterThan(small[0].width);
  });
});
