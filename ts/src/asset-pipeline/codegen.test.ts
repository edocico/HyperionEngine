import { describe, it, expect } from 'vitest';
import { generateAssetCode } from './codegen';
import type { TextureEntry } from './scanner';

describe('generateAssetCode', () => {
  it('generates empty module when no textures', () => {
    const code = generateAssetCode([]);
    expect(code).toContain('AUTO-GENERATED');
    expect(code).toContain('export const Textures = {');
    expect(code).toContain('} as const;');
    expect(code).toContain('export type TextureName = keyof typeof Textures;');
  });

  it('generates typed entries for each texture', () => {
    const entries: TextureEntry[] = [
      { name: 'OrcBody', path: '/textures/orc-body.png', width: 128, height: 128, compressed: false },
      { name: 'Sword', path: '/textures/sword.ktx2', width: 64, height: 64, compressed: true },
    ];
    const code = generateAssetCode(entries);
    expect(code).toContain("OrcBody: { path: '/textures/orc-body.png', width: 128, height: 128, compressed: false }");
    expect(code).toContain("Sword: { path: '/textures/sword.ktx2', width: 64, height: 64, compressed: true }");
  });

  it('produces valid TypeScript (no syntax errors in shape)', () => {
    const entries: TextureEntry[] = [
      { name: 'Hero', path: '/textures/hero.png', width: 256, height: 256, compressed: false },
    ];
    const code = generateAssetCode(entries);
    // Should be parseable — check basic structure
    expect(code).toMatch(/^\/\/ AUTO-GENERATED/);
    expect(code).toContain('export const Textures');
    expect(code).toContain('export type TextureName');
  });
});
