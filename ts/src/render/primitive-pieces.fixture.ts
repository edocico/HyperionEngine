import { PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule, type PrimitivePieces } from './primitive-shaders';

/**
 * Test fixture: the primitive shader pieces as committed in shaders/primitives/,
 * keyed the way renderer.ts keys them — the prelude, and each library under the
 * type PRIMITIVE_LIBRARIES gives its file name. Tests compose them with the
 * real composer, headless: these are the modules the GPU compiles.
 */
const files = import.meta.glob('../shaders/primitives/*.wgsl', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const path = (name: string): string => `../shaders/primitives/${name}.wgsl`;

/** A fresh copy on every call: a test may mutate it. */
export function loadPrimitivePieces(): PrimitivePieces {
  // The prelude and one library per type, nothing else: a stray piece would be
  // compiled by nobody and checked by nothing, a missing one fail silently.
  const expected = ['prelude', ...PRIMITIVE_LIBRARIES.map((l) => l.name)].map(path).sort();
  const found = Object.keys(files).sort();
  if (found.join('\n') !== expected.join('\n')) {
    throw new Error(`shaders/primitives/ holds [${found.join(', ')}]; expected [${expected.join(', ')}]`);
  }
  const libraries: Record<number, string> = {};
  for (const lib of PRIMITIVE_LIBRARIES) libraries[lib.type] = files[path(lib.name)];
  return { prelude: files[path('prelude')], libraries };
}

/**
 * The seven modules the GPU compiles, labelled for test names: `composed
 * <library name>` for each per-type module, and `composed uber`.
 */
export function composedPrimitiveModules(pieces: PrimitivePieces = loadPrimitivePieces()): Record<string, string> {
  const typeModules = composeTypeModules(pieces);
  const out: Record<string, string> = {};
  for (const lib of PRIMITIVE_LIBRARIES) out[`composed ${lib.name}`] = typeModules[lib.type];
  out['composed uber'] = composeUberModule(pieces);
  return out;
}
