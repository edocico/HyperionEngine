import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfilerOverlay } from './profiler';

// Mock minimal DOM element with style property
function mockElement(): any {
  return {
    style: {} as Record<string, string>,
    textContent: '',
    appendChild: vi.fn(),
    removeChild: vi.fn(),
  };
}

// Mock minimal canvas with parentElement
function mockCanvas(): HTMLCanvasElement {
  return {
    parentElement: {
      appendChild: vi.fn(),
      removeChild: vi.fn(),
    },
    style: {},
  } as any;
}

// Stub document.createElement since we're in node (no DOM)
beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: vi.fn(() => mockElement()),
  });
  return () => vi.unstubAllGlobals();
});

describe('ProfilerOverlay', () => {
  it('creates without throwing', () => {
    expect(() => new ProfilerOverlay()).not.toThrow();
  });

  it('show attaches DOM element to parent', () => {
    const profiler = new ProfilerOverlay();
    const canvas = mockCanvas();
    profiler.show(canvas);
    expect(canvas.parentElement!.appendChild).toHaveBeenCalled();
  });

  it('hide removes DOM element', () => {
    const profiler = new ProfilerOverlay();
    const canvas = mockCanvas();
    profiler.show(canvas);
    profiler.hide();
    expect(canvas.parentElement!.removeChild).toHaveBeenCalled();
  });

  it('update formats stats into display', () => {
    const profiler = new ProfilerOverlay();
    // update without show — should not throw
    profiler.update({
      fps: 60, entityCount: 1000, mode: 'C', tickCount: 500,
      overflowCount: 0, frameDt: 0.016, frameTimeAvg: 0.016, frameTimeMax: 0.02,
    });
  });
});
