import { describe, it, expect, vi } from 'vitest';
import { composeRenderGraph, type GraphMode } from './graph-assembly';
import type { RenderPass } from './render-pass';
import { FXAATonemapPass } from './passes/fxaa-tonemap-pass';
import { BloomPass } from './passes/bloom-pass';
import { SelectionSeedPass } from './passes/selection-seed-pass';
import { JFAPass } from './passes/jfa-pass';
import { OutlineCompositePass } from './passes/outline-composite-pass';
import { DebugLinePass, LineBatchPass } from './passes/debug-line-pass';
import { ForwardPass } from './passes/forward-pass';
import { LightGroupsPass } from './passes/light-groups-pass';

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

function scene(mode?: GraphMode): RenderPass[] {
  return [
    mockPass('cull', ['entity-transforms'], ['visible-indices', 'indirect-args']),
    // The real ForwardPass: its reads are what orders it after the light chain.
    new ForwardPass({ lit: mode?.lighting ?? false }),
  ];
}

function lightingChain(): RenderPass[] {
  return [new LightGroupsPass({})];
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
    lighting: vi.fn(lightingChain),
  };
}

const FINAL_COMPOSITES = ['fxaa-tonemap', 'outline-composite', 'bloom'];

const MODES: Array<{ mode: GraphMode; composite: string }> = [
  { mode: { outlines: false, bloom: false, lighting: false }, composite: 'fxaa-tonemap' },
  { mode: { outlines: true, bloom: false, lighting: false }, composite: 'outline-composite' },
  { mode: { outlines: false, bloom: true, lighting: false }, composite: 'bloom' },
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
    composeRenderGraph({ outlines: true, bloom: false, lighting: false }, f, []);
    composeRenderGraph({ outlines: false, bloom: true, lighting: false }, f, []);
    expect(f.fxaaTonemap).not.toHaveBeenCalled();
  });

  it('overlays execute in registration order', () => {
    const overlays = [new DebugLinePass(), new LineBatchPass('bounds-visualizer', 64)];
    const { graph } = composeRenderGraph({ outlines: false, bloom: false, lighting: false }, factories(), overlays);
    expect(graph.compile().slice(-2)).toEqual(['physics-debug', 'bounds-visualizer']);
  });

  it('owned lists the renderer passes it built, not the overlays', () => {
    const { owned } = composeRenderGraph({ outlines: false, bloom: true, lighting: false }, factories(), [new DebugLinePass()]);
    expect(owned.map((p) => p.name)).toEqual(['cull', 'forward', 'bloom']);
  });

  it('does no GPU work: no pass is set up', () => {
    const passes = scene();
    for (const p of passes) vi.spyOn(p, 'setup');
    const f = factories();
    f.scene = vi.fn(() => passes);
    composeRenderGraph({ outlines: false, bloom: false, lighting: false }, f, []);
    for (const p of passes) expect(p.setup).not.toHaveBeenCalled();
  });

  it('throws when the graph does not compile, e.g. an overlay named like a mode pass', () => {
    expect(() => composeRenderGraph({ outlines: false, bloom: true, lighting: false }, factories(), [new LineBatchPass('bloom', 8)]))
      .toThrow(/already registered/);
  });
});

// Lighting (backend 'lit', Phase 17) is orthogonal to the final composite: any
// of the three can run over a lit scene. It adds ONE node, light-groups (seed,
// SDF and accumulation for every light group, design 2026-09-26), and a
// ForwardPass that reads light-buffer — which is what orders the node before
// it, and what keeps it alive: the node is optional.
describe('composeRenderGraph — lighting', () => {
  for (const { mode, composite } of MODES) {
    it(`${composite} + lighting: the light chain runs, in order, before forward`, () => {
      const { graph } = composeRenderGraph({ ...mode, lighting: true }, factories(), []);
      const order = graph.compile();
      expect(order.filter((n) => FINAL_COMPOSITES.includes(n))).toEqual([composite]);
      const at = (name: string) => order.indexOf(name);
      expect(at('light-groups')).toBeGreaterThan(-1);
      expect(at('forward')).toBeGreaterThan(at('light-groups'));
      // One node, whatever the canvas size or the number of groups.
      expect(order.filter((n) => n.startsWith('sdf-') || n === 'occluder-seed' || n === 'light-accum')).toEqual([]);
    });
  }

  it('without lighting, no light pass is constructed, and forward does not read light-buffer', () => {
    const f = factories();
    const { owned } = composeRenderGraph({ outlines: false, bloom: false, lighting: false }, f, []);
    expect(f.lighting).not.toHaveBeenCalled();
    const forward = owned.find((p) => p.name === 'forward')!;
    expect(forward.reads).not.toContain('light-buffer');
  });

  it('with lighting, the scene factory is told, so forward reads light-buffer', () => {
    const f = factories();
    const mode = { outlines: false, bloom: false, lighting: true };
    const { owned } = composeRenderGraph(mode, f, []);
    expect(f.scene).toHaveBeenCalledWith(mode);
    expect(owned.find((p) => p.name === 'forward')!.reads).toContain('light-buffer');
  });

  it('owned lists the light node too', () => {
    const { owned } = composeRenderGraph({ outlines: false, bloom: false, lighting: true }, factories(), []);
    expect(owned.map((p) => p.name)).toContain('light-groups');
  });

  it('the outline chain and the light node coexist', () => {
    const { graph } = composeRenderGraph({ outlines: true, bloom: false, lighting: true }, factories(), []);
    const order = graph.compile();
    expect(order).toContain('jfa-0');
    expect(order).toContain('light-groups');
  });
});
