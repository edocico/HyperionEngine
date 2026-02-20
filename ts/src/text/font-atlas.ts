/** Glyph metrics from MSDF atlas JSON metadata (msdf-atlas-gen format). */
export interface GlyphMetrics {
  unicode: number;
  advance: number;
  planeBounds?: { left: number; bottom: number; right: number; top: number };
  atlasBounds?: { left: number; bottom: number; right: number; top: number };
}

/** Font atlas metadata parsed from msdf-atlas-gen JSON output. */
export interface FontAtlas {
  atlas: {
    type: 'msdf' | 'mtsdf';
    distanceRange: number;
    size: number;
    width: number;
    height: number;
  };
  metrics: {
    lineHeight: number;
    ascender: number;
    descender: number;
  };
  glyphs: GlyphMetrics[];
  /** Indexed by unicode code point for O(1) lookup. */
  glyphMap: Map<number, GlyphMetrics>;
}

/** Parse msdf-atlas-gen JSON metadata into a FontAtlas. */
export function parseFontAtlas(json: unknown): FontAtlas {
  const data = json as any;
  const glyphs: GlyphMetrics[] = data.glyphs ?? [];
  const glyphMap = new Map<number, GlyphMetrics>();
  for (const g of glyphs) {
    glyphMap.set(g.unicode, g);
  }
  return {
    atlas: data.atlas,
    metrics: data.metrics,
    glyphs,
    glyphMap,
  };
}

/** Load a font atlas from URL (JSON metadata + PNG texture). */
export async function loadFontAtlas(
  jsonUrl: string,
  textureUrl: string,
): Promise<{ atlas: FontAtlas; bitmap: ImageBitmap }> {
  const [jsonResp, bitmapResp] = await Promise.all([
    fetch(jsonUrl).then(r => r.json()),
    fetch(textureUrl).then(r => r.blob()).then(b => createImageBitmap(b)),
  ]);
  return { atlas: parseFontAtlas(jsonResp), bitmap: bitmapResp };
}
