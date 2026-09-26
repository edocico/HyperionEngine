import { DEFAULT_LIGHTING_QUALITY, type LightingQuality } from '../lighting-api';

/** `engine_lighting_backend()` ids: see `BACKEND_IDS` in lighting-api.ts. */
const BACKEND_LIT = 1;
const BACKEND_GI = 2;

/**
 * Turns the lighting backend the engine reports every frame
 * (`GPURenderState.lightingBackend`) into graph requests: `apply(true)` for a
 * lit graph, `apply(false)` for an unlit one.
 *
 * It acts on CHANGES only. When the GPU rejects a lit graph the renderer falls
 * back to the unlit one, but the state goes on saying "lit". Re-requesting
 * whenever the two differ would retry, and be rejected again, every frame or
 * two. The backend starts off, which is the graph the renderer starts with.
 *
 * `gi` (Radiance Cascades) is not implemented: it runs unlit, with one warning.
 */
export function followLightingBackend(
  apply: (lit: boolean) => void,
  warn: (message: string) => void,
): (backend: number) => void {
  let last = 0;
  let warnedGi = false;
  return (backend) => {
    if (backend === last) return;
    last = backend;
    if (backend === BACKEND_GI && !warnedGi) {
      warnedGi = true;
      warn('[Hyperion] Lighting backend "gi" is not implemented yet: the scene renders unlit.');
    }
    apply(backend === BACKEND_LIT);
  };
}

/**
 * The quality settings the lit backend ignores when they differ from the
 * default: the light buffer and the SDF are fixed at `halfResolution`, without
 * padding. `shadowSteps` is honoured; `cascades` and `deterministic` belong to
 * `gi`.
 */
export function unsupportedLightingQuality(quality: LightingQuality): Array<keyof LightingQuality> {
  const fixed: Array<keyof LightingQuality> = ['bufferScale', 'sdfOversize'];
  return fixed.filter((key) => quality[key] !== DEFAULT_LIGHTING_QUALITY[key]);
}
