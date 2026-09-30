import { afterEach, describe, expect, it, vi } from 'vitest';
import section from './rendering-fx';
import { createTestReporter } from './types';
import type { Hyperion } from '../hyperion';

/**
 * Mode A: the canvas belongs to the render worker, so the main thread has no
 * renderer. `engine.debug.probe` rejects, and the renderer-only calls throw
 * the way `Hyperion` does.
 */
function modeAEngine(): Hyperion {
  let nextId = 0;
  const spawn = () => {
    const handle = { id: nextId++, position: () => handle, scale: () => handle, destroy: () => {} };
    return handle;
  };
  return {
    batch: (fn: () => void) => fn(),
    spawn,
    cam: { position() {}, zoom() {}, viewProjection: Float32Array.from({ length: 16 }, (_, i) => (i === 5 ? 0.1 : 0)) },
    debug: { probe: () => Promise.reject(new Error('The debug probe needs the main-thread renderer of a dev build')) },
    enableBloom: () => {
      throw new Error('Cannot enable bloom: no renderer available');
    },
    enableOutlines: () => {
      throw new Error('Cannot enable outlines: no renderer available');
    },
    disableBloom() {},
    disableOutlines() {},
    selection: { select() {}, clear() {} },
    resize() {},
  } as unknown as Hyperion;
}

afterEach(() => vi.unstubAllGlobals());

describe('Rendering FX section in Mode A', () => {
  it('skips its four checks and fails none: there is no main-thread renderer to check', async () => {
    vi.stubGlobal('document', { getElementById: () => ({ width: 1280, height: 720 }) });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
    const engine = modeAEngine();
    const reporter = createTestReporter();
    try {
      await section.setup(engine, reporter);
    } finally {
      section.teardown(engine);
    }
    expect(reporter.results().map(({ name, status }) => [name, status])).toEqual([
      ['Bloom', 'skip'],
      ['Outline', 'skip'],
      ['Tonemap switch', 'skip'],
      ['Resize', 'skip'],
    ]);
  });
});
