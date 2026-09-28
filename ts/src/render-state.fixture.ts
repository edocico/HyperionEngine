import type { GPURenderState } from './worker-bridge';

/**
 * A complete `GPURenderState` for tests: an empty world with every field at a
 * neutral value, `overrides` on top. The one place a test builds a whole
 * render state, so a new field is added here once instead of in every test.
 * (Not a transport default: a real bridge sends NaN for a missing
 * `transparentCount` / `entityIdsGeneration`, see render/frame-inputs.ts.)
 */
export function makeRenderState(overrides: Partial<GPURenderState> = {}): GPURenderState {
  return {
    entityCount: 0,
    transforms: new Float32Array(0),
    bounds: new Float32Array(0),
    renderMeta: new Uint32Array(0),
    texIndices: new Uint32Array(0),
    primParams: new Float32Array(0),
    entityIds: new Uint32Array(0),
    listenerX: 0,
    listenerY: 0,
    listenerZ: 0,
    tickCount: 0,
    dirtyCount: 0,
    dirtyRatio: 0,
    stagingData: null,
    dirtyIndices: null,
    ambientR: 0,
    ambientG: 0,
    ambientB: 0,
    ambientIntensity: 1,
    lightingBackend: 0,
    transparentCount: 0,
    entityIdsGeneration: 0,
    ...overrides,
  };
}
