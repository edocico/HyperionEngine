import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { scanTextures } from './scanner';
import { generateAssetCode } from './codegen';

export interface HyperionAssetsOptions {
  /** Path to the texture directory (relative to project root). */
  textureDir: string;
  /** Output file for generated TypeScript (relative to project root). */
  outputFile: string;
  /** Enable file watching in dev server mode. Default: false. */
  watchMode?: boolean;
}

function generate(textureDir: string, outputFile: string): void {
  const absTextureDir = resolve(textureDir);
  const absOutput = resolve(outputFile);

  // Extract URL prefix from textureDir (e.g., "public/textures" -> "/textures")
  const publicPrefix = '/' + textureDir.replace(/^public\//, '');
  const entries = scanTextures(absTextureDir, publicPrefix);
  const code = generateAssetCode(entries);

  const outDir = dirname(absOutput);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  writeFileSync(absOutput, code, 'utf-8');
}

/**
 * Vite plugin that scans a texture directory and generates typed TypeScript constants.
 * Run at build time -- zero runtime cost.
 */
export function hyperionAssets(options: HyperionAssetsOptions) {
  return {
    name: 'hyperion-assets',

    buildStart() {
      generate(options.textureDir, options.outputFile);
    },

    configureServer(server: { watcher: { add(path: string): void; on(event: string, cb: (path: string) => void): void } }) {
      if (!options.watchMode) return;

      const absTextureDir = resolve(options.textureDir);
      server.watcher.add(absTextureDir);
      server.watcher.on('change', (path: string) => {
        if (path.startsWith(absTextureDir)) {
          generate(options.textureDir, options.outputFile);
        }
      });
      server.watcher.on('add', (path: string) => {
        if (path.startsWith(absTextureDir)) {
          generate(options.textureDir, options.outputFile);
        }
      });
      server.watcher.on('unlink', (path: string) => {
        if (path.startsWith(absTextureDir)) {
          generate(options.textureDir, options.outputFile);
        }
      });
    },
  };
}
