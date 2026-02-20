import type { FontAtlas, GlyphMetrics } from './font-atlas';

/** Positioned glyph for rendering. */
export interface LayoutGlyph {
  unicode: number;
  metrics: GlyphMetrics;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Layout a string into positioned glyphs using atlas metrics. */
export function layoutText(
  text: string,
  atlas: FontAtlas,
  fontSize: number,
  startX: number,
  startY: number,
): LayoutGlyph[] {
  const scale = fontSize / atlas.atlas.size;
  const result: LayoutGlyph[] = [];
  let cursorX = startX;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const glyph = atlas.glyphMap.get(code);
    if (!glyph) continue;

    if (glyph.planeBounds && glyph.atlasBounds) {
      const pb = glyph.planeBounds;
      const width = (pb.right - pb.left) * fontSize;
      const height = (pb.top - pb.bottom) * fontSize;
      const xOff = pb.left * fontSize;
      const yOff = pb.bottom * fontSize;

      result.push({
        unicode: code,
        metrics: glyph,
        x: cursorX + xOff,
        y: startY + yOff,
        width,
        height,
      });
    }

    cursorX += glyph.advance * scale * atlas.atlas.size;
  }

  return result;
}
