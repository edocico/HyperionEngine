import { describe, it, expect, vi } from 'vitest';
import { composeRenderGraph, type GraphMode } from './graph-assembly';
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
// device until setup(), which composition never calls.

function mockPass(name: string, reads: string[], writes: string[]): RenderPass {
  return {
    name, reads, writes, optional: false,
    setup: vi.fn(), prepare: () => {}, execute: () => {}, resize: () => {}, destroy: () => {},
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

describe('composeRenderGraph', () => {
  for (const { mode, composite } of MODES) {
    it(`${composite}: exactly one final composite, and the graph compiles`, () => {
      const { graph } = composeRenderGraph(mode, factories(), []);
      const order = graph.compile();
      expect(order.filter((n) => FINAL_COMPOSITES.includes(n))).toEqual([composite]);
    });

    it(`${composite}: a plugin overlay executes after the final composite`, () => {
      const order = composeRenderGraph(mode, factories(), [new DebugLinePass()]).graph.compile();
      expect(order.indexOf(composite)).toBeGreaterThan(-1);
      expect(order[order.length - 1]).toBe('physics-debug');
    });
  }

  it('does not construct an fxaa-tonemap pass it will not run', () => {
    const f = factories();
    composeRenderGraph({ outlines: true, bloom: false }, f, []);
    composeRenderGraph({ outlines: false, bloom: true }, f, []);
    expect(f.fxaaTonemap).not.toHaveBeenCalled();
  });

  it('overlays execute in registration order', () => {
    const overlays = [new DebugLinePass(), new LineBatchPass('bounds-visualizer', 64)];
    const { graph } = composeRenderGraph({ outlines: false, bloom: false }, factories(), overlays);
    expect(graph.compile().slice(-2)).toEqual(['physics-debug', 'bounds-visualizer']);
  });

  it('owned lists the renderer passes it built, not the overlays', () => {
    const { owned } = composeRenderGraph({ outlines: false, bloom: true }, factories(), [new DebugLinePass()]);
    expect(owned.map((p) => p.name)).toEqual(['cull', 'forward', 'bloom']);
  });

  it('does no GPU work: no pass is set up', () => {
    const passes = scene();
    const f = factories();
    f.scene = vi.fn(() => passes);
    composeRenderGraph({ outlines: false, bloom: false }, f, []);
    for (const p of passes) expect(p.setup).not.toHaveBeenCalled();
  });

  it('throws when the graph does not compile, e.g. an overlay named like a mode pass', () => {
    expect(() => composeRenderGraph({ outlines: false, bloom: true }, factories(), [new LineBatchPass('bloom', 8)]))
      .toThrow(/already registered/);
  });
});
