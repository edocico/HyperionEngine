import type { FontAtlas } from './font-atlas';
import { loadFontAtlas } from './font-atlas';
import type { TextureManager } from '../texture-manager';

/**
 * Manages loaded font atlases and their texture layers.
 */
export class TextManager {
  private atlases = new Map<string, { atlas: FontAtlas; textureLayer: number }>();
  /** Retained for future loadFromBitmap() integration. */
  readonly textureManager: TextureManager;

  constructor(textureManager: TextureManager) {
    this.textureManager = textureManager;
  }

  async loadFont(name: string, jsonUrl: string, textureUrl: string): Promise<FontAtlas> {
    const { atlas, bitmap } = await loadFontAtlas(jsonUrl, textureUrl);
    const textureLayer = 0; // Placeholder — integrate with TextureManager.loadFromBitmap()
    bitmap.close();
    this.atlases.set(name, { atlas, textureLayer });
    return atlas;
  }

  getAtlas(name: string): { atlas: FontAtlas; textureLayer: number } | undefined {
    return this.atlases.get(name);
  }
}
