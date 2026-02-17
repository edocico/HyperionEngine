/// <reference types="vite/client" />

// Allow importing .wgsl files as raw text via Vite's ?raw suffix.
declare module "*.wgsl?raw" {
  const content: string;
  export default content;
}
