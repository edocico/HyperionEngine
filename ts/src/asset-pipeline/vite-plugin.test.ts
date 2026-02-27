import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hyperionAssets } from './vite-plugin';

vi.mock('./scanner', () => ({
  scanTextures: vi.fn(() => [
    { name: 'Hero', path: '/textures/hero.png', width: 128, height: 128, compressed: false },
  ]),
}));

vi.mock('./codegen', () => ({
  generateAssetCode: vi.fn(() => '// generated'),
}));

vi.mock('node:fs', () => ({
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => Buffer.alloc(0)),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));

describe('hyperionAssets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a Vite plugin object with correct name', () => {
    const plugin = hyperionAssets({ textureDir: 'public/textures', outputFile: 'src/gen/assets.ts' });
    expect(plugin.name).toBe('hyperion-assets');
  });

  it('has buildStart hook', () => {
    const plugin = hyperionAssets({ textureDir: 'public/textures', outputFile: 'src/gen/assets.ts' });
    expect(typeof plugin.buildStart).toBe('function');
  });

  it('writes generated file on buildStart', async () => {
    const { writeFileSync, mkdirSync, existsSync } = await import('node:fs');
    (existsSync as any).mockReturnValue(false);

    const plugin = hyperionAssets({ textureDir: 'public/textures', outputFile: 'src/gen/assets.ts' });
    (plugin.buildStart as Function).call({});

    expect(mkdirSync).toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalled();
  });

  it('has configureServer hook for watch mode', () => {
    const plugin = hyperionAssets({
      textureDir: 'public/textures',
      outputFile: 'src/gen/assets.ts',
      watchMode: true,
    });
    expect(typeof plugin.configureServer).toBe('function');
  });
});
