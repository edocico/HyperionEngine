import type { HyperionConfig } from '../types';

export type PreferredMode = NonNullable<HyperionConfig['preferredMode']>;

/**
 * Execution mode for the verification harness, from `?mode=` (A, B, C or
 * auto). Defaults to Mode B rather than auto: Chrome would pick Mode A, whose
 * main thread has no renderer, so GPU profiling, outlines, bloom, particles
 * and the debug overlays could not be checked there at all.
 */
export function harnessMode(search: string): PreferredMode {
  const value = new URLSearchParams(search).get('mode')?.toUpperCase();
  if (value === 'A' || value === 'B' || value === 'C') return value;
  if (value === 'AUTO') return 'auto';
  return 'B';
}
