/// <reference types="vite/client" />

// Allow importing .wgsl files as raw text via Vite's ?raw suffix.
declare module "*.wgsl?raw" {
  const content: string;
  export default content;
}

// Vendored Basis Universal WASM transcoder (added in Phase 10).
// Relative module declarations resolve from the importing file's directory.
// This declaration must be co-located with the importer or use a wildcard.
declare module "*/vendor/basis_transcoder.js" {
  const createModule: () => Promise<unknown>;
  export default createModule;
}
