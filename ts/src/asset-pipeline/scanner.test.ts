import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanTextures } from './scanner';
import type { KTX2HeaderInfo } from './ktx2-node';

// Mock fs and path for deterministic tests
vi.mock('node:fs', () => ({
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => Buffer.alloc(80)),
  statSync: vi.fn(() => ({ isFile: () => true })),
}));

vi.mock('node:path', () => ({
  join: vi.fn((...parts: string[]) => parts.join('/')),
  basename: vi.fn((p: string, ext?: string) => {
    const base = p.split('/').pop()!;
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
  }),
  extname: vi.fn((p: string) => {
    const m = p.match(/\.[^.]+$/);
    return m ? m[0] : '';
  }),
  relative: vi.fn((_from: string, to: string) => to),
}));

vi.mock('./ktx2-node', () => ({
  parseKTX2Header: vi.fn((): KTX2HeaderInfo | null => null),
}));

// We need image-size for png/jpg dimensions — mock it
vi.mock('image-size', () => ({
  imageSize: vi.fn(() => ({ width: 128, height: 128 })),
}));

describe('scanTextures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('discovers .png files', async () => {
    const { readdirSync } = await import('node:fs');
    (readdirSync as any).mockReturnValue(['hero.png', 'readme.txt']);

    const entries = scanTextures('/textures');
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Hero');
  });

  it('discovers .ktx2 files', async () => {
    const { readdirSync } = await import('node:fs');
    (readdirSync as any).mockReturnValue(['orc-body.ktx2']);
    const { parseKTX2Header } = await import('./ktx2-node');
    (parseKTX2Header as any).mockReturnValue({ width: 64, height: 64, compressed: true });

    const entries = scanTextures('/textures');
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('OrcBody');
    expect(entries[0].compressed).toBe(true);
  });

  it('converts kebab-case to PascalCase', async () => {
    const { readdirSync } = await import('node:fs');
    (readdirSync as any).mockReturnValue(['orc-body.png', 'my-cool-sword.jpg']);

    const entries = scanTextures('/textures');
    expect(entries.map(e => e.name)).toEqual(['OrcBody', 'MyCoolSword']);
  });

  it('converts snake_case to PascalCase', async () => {
    const { readdirSync } = await import('node:fs');
    (readdirSync as any).mockReturnValue(['orc_body.png']);

    const entries = scanTextures('/textures');
    expect(entries[0].name).toBe('OrcBody');
  });

  it('ignores non-texture files', async () => {
    const { readdirSync } = await import('node:fs');
    (readdirSync as any).mockReturnValue(['readme.md', 'data.json', '.DS_Store']);

    const entries = scanTextures('/textures');
    expect(entries).toHaveLength(0);
  });
});
