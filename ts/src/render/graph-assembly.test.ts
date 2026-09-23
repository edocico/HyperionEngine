import { describe, it, expect, vi } from 'vitest';
import { assembleRenderGraph, ExternalPasses, type GraphMode } from './graph-assembly';
import type { RenderPass } from './render-pass';
import { FXAATonemapPass } from './passes/fxaa-tonemap-pass';
import { BloomPass } from './passes/bloom-pass';
import { SelectionSeedPass } from './passes/selection-seed-pass';
import { JFAPass } from './passes/jfa-pass';
import { OutlineCompositePass } from './passes/outline-composite-pass';
import { DebugLinePass, LineBatchPass } from './passes/debug-line-pass';

// Scene passes are stand-ins carrying the real resource names. Every final
// composite and every overlay is the real class, so what gets compiled is the
// set of reads/writes the renderer actually ships. None of them needs a
// device until setup(), which graph assembly never calls.

function mockPass(name: string, reads: string[], writes: string[], destroy = () => {}): RenderPass {
  return {
    name, reads, writes, optional: false,
    setup: () => {}, prepare: () => {}, execute: () => {}, resize: () => {}, destroy,
  };
}

function scene(): RenderPass[] {
  return [
    mockPass('cull', ['entity-transforms'], ['visible-indices', 'indirect-args']),
    mockPass('forward', ['visible-indices', 'indirect-args'], ['scene-hdr']),
  ];
}

function outlineChain(): RenderPass[] {
  const maxDim = 1024;
  const n = JFAPass.iterationsForDimension(maxDim);
  return [
    new SelectionSeedPass(),
    ...Array.from({ length: n }, (_, i) => new JFAPass(i, n, maxDim)),
    new OutlineCompositePass(JFAPass.finalOutputResource(n)),
  ];
}

function factories() {
  return {
    scene: vi.fn(scene),
    outline: vi.fn(outlineChain),
    bloom: vi.fn(() => new BloomPass()),
    fxaaTonemap: vi.fn(() => new FXAATonemapPass()),
  };
}

const FINAL_COMPOSITES = ['fxaa-tonemap', 'outline-composite', 'bloom'];

const MODES: Array<{ mode: GraphMode; composite: string }> = [
  { mode: { outlines: false, bloom: false }, composite: 'fxaa-tonemap' },
  { mode: { outlines: true, bloom: false }, composite: 'outline-composite' },
  { mode: { outlines: false, bloom: true }, composite: 'bloom' },
];

describe('assembleRenderGraph', () => {
  for (const { mode, composite } of MODES) {
    it(`${composite}: exactly one final composite, and the graph compiles`, () => {
      const order = assembleRenderGraph(mode, factories(), []).compile();
      expect(order.filter((n) => FINAL_COMPOSITES.includes(n))).toEqual([composite]);
    });

    it(`${composite}: a plugin overlay executes after the final composite`, () => {
      const order = assembleRenderGraph(mode, factories(), [new DebugLinePass()]).compile();
      expect(order.indexOf(composite)).toBeGreaterThan(-1);
      expect(order[order.length - 1]).toBe('physics-debug');
    });
  }

  it('does not build an fxaa-tonemap pipeline it will not run', () => {
    const f = factories();
    assembleRenderGraph({ outlines: true, bloom: false }, f, []);
    assembleRenderGraph({ outlines: false, bloom: true }, f, []);
    expect(f.fxaaTonemap).not.toHaveBeenCalled();
  });

  it('overlays execute in registration order', () => {
    const overlays = [new DebugLinePass(), new LineBatchPass('bounds-visualizer', 64)];
    const order = assembleRenderGraph({ outlines: false, bloom: false }, factories(), overlays).compile();
    expect(order.slice(-2)).toEqual(['physics-debug', 'bounds-visualizer']);
  });

  it('a rebuild that fails keeps the previous graph whole and destroys only what it built', () => {
    // A caller-owned pass named like a renderer pass the current mode lacks:
    // harmless until the mode that needs that name is switched on.
    const sceneDestroys: Array<ReturnType<typeof vi.fn>> = [];
    const f = factories();
    f.scene = vi.fn(() => {
      const destroy = vi.fn();
      sceneDestroys.push(destroy);
      return [mockPass('forward', [], ['scene-hdr'], destroy)];
    });
    const squatter = new LineBatchPass('bloom', 8);
    const squatterDestroy = vi.spyOn(squatter, 'destroy');

    const previous = assembleRenderGraph({ outlines: false, bloom: false }, f, [squatter]);
    expect(() => assembleRenderGraph({ outlines: false, bloom: true }, f, [squatter], previous))
      .toThrow(/already registered/);

    expect(previous.compile()).toEqual(['forward', 'fxaa-tonemap', 'bloom']);
    expect(sceneDestroys[0]).not.toHaveBeenCalled(); // previous graph untouched
    expect(sceneDestroys[1]).toHaveBeenCalledTimes(1); // the aborted graph's own pass
    expect(squatterDestroy).not.toHaveBeenCalled();
  });

  it('a rebuild destroys the previous graph but hands the overlays over intact', () => {
    const sceneDestroy = vi.fn();
    const overlay = new DebugLinePass();
    const overlayDestroy = vi.spyOn(overlay, 'destroy');
    const f = factories();
    f.scene = vi.fn(() => [mockPass('forward', [], ['scene-hdr'], sceneDestroy)]);

    const first = assembleRenderGraph({ outlines: false, bloom: false }, f, [overlay]);
    const second = assembleRenderGraph({ outlines: false, bloom: true }, f, [overlay], first);

    expect(sceneDestroy).toHaveBeenCalledTimes(1); // the first graph's forward pass
    expect(overlayDestroy).not.toHaveBeenCalled();
    expect(second.compile()).toContain('physics-debug');
  });
});

describe('ExternalPasses', () => {
  function baseGraph() {
    return assembleRenderGraph({ outlines: false, bloom: false }, factories(), []);
  }

  it('sets a pass up exactly once — not again when the graph is rebuilt', () => {
    const setup = vi.fn();
    const externals = new ExternalPasses(setup);
    const overlay = new DebugLinePass();
    const graph = baseGraph();

    externals.add(graph, overlay);
    const rebuilt = assembleRenderGraph({ outlines: true, bloom: false }, factories(), externals.values(), graph);

    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledWith(overlay);
    expect(rebuilt.compile()).toContain('physics-debug');
  });

  it('rejects a pass that breaks the graph at add time, not on the next frame', () => {
    // The declaration LineBatchPass shipped with: a second BLIND swapchain writer.
    const setup = vi.fn();
    const externals = new ExternalPasses(setup);
    const graph = baseGraph();
    const blind: RenderPass = mockPass('my-overlay', ['scene-hdr'], ['swapchain']);

    expect(() => externals.add(graph, blind)).toThrow(/multiple writers/);

    expect([...externals.values()]).toEqual([]);
    expect(setup).not.toHaveBeenCalled();
    expect(graph.compile()).not.toContain('my-overlay');
  });

  it('a pass whose setup throws is not left registered', () => {
    const externals = new ExternalPasses(() => { throw new Error('no pipeline'); });
    const graph = baseGraph();

    expect(() => externals.add(graph, new DebugLinePass())).toThrow('no pipeline');

    expect([...externals.values()]).toEqual([]);
    expect(graph.compile()).not.toContain('physics-debug');
  });

  it('remove detaches the pass and leaves destroying it to its owner', () => {
    const externals = new ExternalPasses(() => {});
    const overlay = new DebugLinePass();
    const destroy = vi.spyOn(overlay, 'destroy');
    const graph = baseGraph();
    externals.add(graph, overlay);

    externals.remove(graph, 'physics-debug');

    expect(destroy).not.toHaveBeenCalled();
    expect(graph.compile()).not.toContain('physics-debug');
    expect([...externals.values()]).toEqual([]);
  });

  it('remove ignores names it does not own', () => {
    const externals = new ExternalPasses(() => {});
    const graph = baseGraph();
    externals.remove(graph, 'forward');
    expect(graph.compile()).toContain('forward');
  });
});
