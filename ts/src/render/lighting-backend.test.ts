import { describe, it, expect, vi } from 'vitest';
import { followLightingBackend, unsupportedLightingQuality } from './lighting-backend';
import { DEFAULT_LIGHTING_QUALITY } from '../lighting-api';

// The lighting backend lives in WASM (CommandType 56) and reaches the renderer
// every frame, in GPURenderState.lightingBackend: 0 off, 1 lit, 2 gi. The
// renderer turns it into graph requests. It must act on CHANGES only: a lit
// graph the GPU rejects falls back to unlit, while the state keeps saying
// "lit". Following the value would re-request, and be rejected again, every
// frame or two, flooding the console.
describe('followLightingBackend', () => {
  function setUp() {
    const apply = vi.fn();
    const warn = vi.fn();
    return { apply, warn, follow: followLightingBackend(apply, warn) };
  }

  it('does nothing while the backend stays off, the state it starts in', () => {
    const { apply, follow } = setUp();
    follow(0);
    follow(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('asks for the lit graph once when the backend becomes lit, and not again every frame', () => {
    const { apply, follow } = setUp();
    follow(1);
    follow(1);
    follow(1);
    expect(apply.mock.calls).toEqual([[true]]);
  });

  it('asks for the unlit graph when the backend goes back to off', () => {
    const { apply, follow } = setUp();
    follow(1);
    follow(0);
    expect(apply.mock.calls).toEqual([[true], [false]]);
  });

  it('treats gi as off, and says once that it is not implemented', () => {
    const { apply, warn, follow } = setUp();
    follow(1);
    follow(2);
    follow(2);
    expect(apply.mock.calls).toEqual([[true], [false]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/gi.*not implemented/));
  });
});

describe('unsupportedLightingQuality', () => {
  it('accepts the defaults', () => {
    expect(unsupportedLightingQuality(DEFAULT_LIGHTING_QUALITY)).toEqual([]);
  });

  it('names the settings the lit backend does not honour yet', () => {
    // The light buffer and the SDF are fixed at half resolution without padding
    // (halfResolution in occluder-seed-pass.ts); shadowSteps is honoured.
    expect(unsupportedLightingQuality({ ...DEFAULT_LIGHTING_QUALITY, bufferScale: 0.25, shadowSteps: 8 }))
      .toEqual(['bufferScale']);
    expect(unsupportedLightingQuality({ ...DEFAULT_LIGHTING_QUALITY, sdfOversize: 1.2 }))
      .toEqual(['sdfOversize']);
  });
});
