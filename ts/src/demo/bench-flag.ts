// ts/src/demo/bench-flag.ts

/**
 * `?bench` on the harness URL: open no section, so the world stays empty.
 * The Phase 5b benchmark and baseline capture
 * (docs/plans/assets/2026-09-27-transparent-sort-*) drive the engine through
 * `window.__hyperion` (dev builds) on such a page: the benchmark needs a world
 * holding only its own quads, and the capture must wrap a section's setup
 * BEFORE it runs — Primitives included, which the harness opens at load.
 */
export function isBenchMode(search: string): boolean {
  return new URLSearchParams(search).has('bench');
}
