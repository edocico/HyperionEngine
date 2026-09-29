import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRIMITIVE_LIBRARIES } from './primitive-shaders';
import { composedPrimitiveModules } from './primitive-pieces.fixture';
import transparentGatherSource from '../shaders/transparent-gather.wgsl?raw';
import transparentSortSource from '../shaders/transparent-sort.wgsl?raw';

// Dumps every WGSL module the engine composes, so a validator outside the
// browser can read it: `scripts/validate-wgsl-naga.mjs` runs naga (Firefox's
// WGSL front-end) on the directory. Nothing is written unless DUMP_WGSL_DIR
// names that directory (absolute path):
//
//   D="$(mktemp -d)" && DUMP_WGSL_DIR="$D" npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts \
//     && node scripts/validate-wgsl-naga.mjs "$D"
//
// The pieces come from the shared test fixture (primitive-pieces.fixture.ts),
// composed with the real composer: the modules the GPU compiles.

const DUMP_DIR = process.env.DUMP_WGSL_DIR;

/** Every composed module, by the file name it is dumped under. */
function composedModules(): Array<[file: string, code: string]> {
  const modules = composedPrimitiveModules();
  return [
    ...PRIMITIVE_LIBRARIES.map((lib): [string, string] => [`type-${lib.type}-${lib.name}.wgsl`, modules[`composed ${lib.name}`]]),
    ['uber.wgsl', modules['composed uber']],
  ];
}

describe('composed WGSL modules for external validators', () => {
  it('one module per primitive library plus the uber, each named once', () => {
    const files = composedModules().map(([file]) => file);
    expect(files).toEqual([
      'type-0-quad.wgsl', 'type-1-line.wgsl', 'type-2-msdf-text.wgsl',
      'type-3-bezier.wgsl', 'type-4-gradient.wgsl', 'type-5-box-shadow.wgsl', 'uber.wgsl',
    ]);
    for (const [, code] of composedModules()) expect(code.trim()).not.toBe('');
  });

  it.skipIf(!DUMP_DIR)('writes them to DUMP_WGSL_DIR', () => {
    const dir = DUMP_DIR!;
    mkdirSync(dir, { recursive: true });
    for (const [file, code] of composedModules()) writeFileSync(join(dir, file), code);
    expect(composedModules()).toHaveLength(7);
  });
});

// Passo 3: the two sort kernels, as the renderer loads them (no preprocessing), for `naga`.
describe.skipIf(!process.env.DUMP_WGSL_DIR)('dump the transparent-sort kernels (naga)', () => {
  it('writes transparent-gather.wgsl and transparent-sort.wgsl', () => {
    const dir = process.env.DUMP_WGSL_DIR!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'transparent-gather.wgsl'), transparentGatherSource);
    writeFileSync(join(dir, 'transparent-sort.wgsl'), transparentSortSource);
    expect(transparentGatherSource).toMatch(/fn gather_main\s*\(/);
    expect(transparentSortSource).toMatch(/fn scatter_main\s*\(/);
  });
});
