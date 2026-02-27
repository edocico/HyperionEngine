import { readdirSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { parseKTX2Header } from './ktx2-node';

const TEXTURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ktx2']);

export interface TextureEntry {
  /** PascalCase constant name (e.g., "OrcBody") */
  name: string;
  /** URL path relative to public dir (e.g., "/textures/orc-body.png") */
  path: string;
  /** Pixel width */
  width: number;
  /** Pixel height */
  height: number;
  /** Whether this is a KTX2 compressed texture */
  compressed: boolean;
}

/**
 * Convert a filename (without extension) to PascalCase.
 * Handles kebab-case and snake_case.
 */
export function toPascalCase(name: string): string {
  return name
    .split(/[-_]/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
}

/**
 * Try to get image dimensions using the optional `image-size` package.
 * Returns { width, height } or null if the package is not available.
 */
function getImageDimensions(filePath: string): { width: number; height: number } | null {
  try {
    // image-size is an optional peer dependency — use dynamic import via createRequire
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { imageSize } = require('image-size') as { imageSize: (path: string) => { width?: number; height?: number } };
    const dims = imageSize(filePath);
    return { width: dims.width ?? 0, height: dims.height ?? 0 };
  } catch {
    // image-size not available — dimensions stay 0
    return null;
  }
}

/**
 * Scan a directory for texture files and extract metadata.
 * @param textureDir — Absolute path to the texture directory
 * @param publicDir — URL path prefix (default: directory name)
 */
export function scanTextures(textureDir: string, publicDir?: string): TextureEntry[] {
  const files = readdirSync(textureDir);
  const entries: TextureEntry[] = [];

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (!TEXTURE_EXTENSIONS.has(ext)) continue;

    const filePath = join(textureDir, file);
    const nameWithoutExt = basename(file, ext);
    const constantName = toPascalCase(nameWithoutExt);

    let width = 0;
    let height = 0;
    let compressed = false;

    if (ext === '.ktx2') {
      const buf = readFileSync(filePath);
      const header = parseKTX2Header(buf);
      if (header) {
        width = header.width;
        height = header.height;
        compressed = true;
      }
    } else {
      const dims = getImageDimensions(filePath);
      if (dims) {
        width = dims.width;
        height = dims.height;
      }
    }

    const urlPath = publicDir
      ? `${publicDir}/${file}`
      : `/${file}`;

    entries.push({ name: constantName, path: urlPath, width, height, compressed });
  }

  return entries;
}
