import { describe, it, expect, vi } from 'vitest';
import { RenderGraphHost, createGpuValidation, type GpuValidation } from './graph-host';
import type { GraphMode, GraphPassFactories } from './graph-assembly';
import type { RenderPass } from './render-pass';
import { FXAATonemapPass } from './passes/fxaa-tonemap-pass';
import { BloomPass } from './passes/bloom-pass';
import { SelectionSeedPass } from './passes/selection-seed-pass';
import { JFAPass } from './passes/jfa-pass';
import { OutlineCompositePass } from './passes/outline-composite-pass';
import { DebugLinePass, LineBatchPass } from './passes/debug-line-pass';

// GPU validation is asynchronous in WebGPU (error scopes resolve later), so
// the fake hands each run's verdict to the test, which settles it by hand.
function deferredValidation() {
  const runs: Array<(messages: string[]) => void> = [];
  const validation: GpuValidation = {
    run(fn) {
      fn();
      return new Promise((resolve) => runs.push(resolve));
    },
  };
  return { validation, runs };
}

function mockPass(name: string, reads: string[], writes: string[]): RenderPass {
  return {
    name, reads, writes, optional: false,
    setup: () => {}, prepare: () => {}, execute: () => {}, resize: () => {}, destroy: vi.fn(),
  };
}

const FXAA: GraphMode = { outlines: false, bloom: false, lighting: false };
const BLOOM: GraphMode = { outlines: false, bloom: true, lighting: false };
const OUTLINES: GraphMode = { outlines: true, bloom: false, lighting: false };

/** A host over real composite/overlay classes; every scene build is recorded. */
function makeHost(opts: { setup?: (p: RenderPass) => void } = {}) {
  const scenes: RenderPass[][] = [];
  const factories: GraphPassFactories = {
    scene() {
      const passes = [mockPass('forward', [], ['scene-hdr'])];
      scenes.push(passes);
      return passes;
    },
    outline() {
      const n = JFAPass.iterationsForDimension(256);
      return [
        new SelectionSeedPass(),
        ...Array.from({ length: n }, (_, i) => new JFAPass(i, n, 256)),
        new OutlineCompositePass(JFAPass.finalOutputResource(n)),
      ];
    },
    bloom: () => new BloomPass(),
    fxaaTonemap: () => new FXAATonemapPass(),
    lighting: () => [
      mockPass('occluder-seed', [], ['occluder-seed']),
      mockPass('light-accum', ['occluder-seed'], ['light-buffer']),
    ],
  };
  const { validation, runs } = deferredValidation();
  const setup = vi.fn(opts.setup ?? (() => {}));
  const prepare = vi.fn();
  const onSwap = vi.fn();
  const onError = vi.fn();
  const host = new RenderGraphHost({ factories, setup, prepare, validation, onSwap, onError }, FXAA);
  runs.shift()!([]); // the initial build validates cleanly
  return { host, scenes, runs, setup, prepare, onSwap, onError };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RenderGraphHost', () => {
  it('builds the initial graph synchronously and sets up every pass it owns', () => {
    const { host, setup, onSwap } = makeHost();
    expect(host.graph.compile()).toEqual(['forward', 'fxaa-tonemap']);
    expect(setup.mock.calls.map(([p]) => p.name)).toEqual(['forward', 'fxaa-tonemap']);
    expect(onSwap).toHaveBeenCalledTimes(1);
  });

  it('a requested mode goes live only once the GPU reports no error', async () => {
    const { host, scenes, runs } = makeHost();
    const result = host.request(BLOOM);

    expect(host.isPending).toBe(true);
    expect(host.graph.compile()).toContain('fxaa-tonemap'); // still drawing the old graph

    runs.shift()!([]);
    expect(await result).toEqual({ outcome: 'swapped', errors: [] });
    expect(host.graph.compile()).toEqual(['forward', 'bloom']);
    expect(host.mode).toEqual(BLOOM);
    expect(scenes[0][0].destroy).toHaveBeenCalledTimes(1); // old graph retired
    expect(host.isPending).toBe(false);
  });

  it('a GPU error — a broken shader — rejects the request and keeps the live graph', async () => {
    const { host, scenes, runs } = makeHost();
    const result = host.request(BLOOM);

    runs.shift()!(['Error while parsing WGSL: :12:5 error: unresolved identifier']);
    expect(await result).toEqual({
      outcome: 'rejected', errors: ['Error while parsing WGSL: :12:5 error: unresolved identifier'],
    });
    expect(host.graph.compile()).toEqual(['forward', 'fxaa-tonemap']);
    expect(host.mode).toEqual(FXAA);
    expect(scenes[0][0].destroy).not.toHaveBeenCalled(); // the live graph is intact
    expect(scenes[1][0].destroy).toHaveBeenCalledTimes(1); // the rejected one is gone
  });

  it('prepares the mode before setting up its passes', () => {
    const { host, setup, prepare } = makeHost();
    setup.mockClear();
    prepare.mockClear(); // drop the initial build's call
    host.request(OUTLINES);
    expect(prepare).toHaveBeenCalledWith(OUTLINES);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(setup.mock.invocationCallOrder[0]);
  });

  it('a newer request supersedes a pending one', async () => {
    const { host, scenes, runs } = makeHost();
    const first = host.request(BLOOM);
    const second = host.request(OUTLINES);

    expect(scenes[1][0].destroy).toHaveBeenCalledTimes(1); // the superseded build, at once
    runs.shift()!([]);
    expect(await first).toEqual({ outcome: 'superseded', errors: [] });
    expect(host.mode).toEqual(FXAA);

    runs.shift()!([]);
    expect((await second).outcome).toBe('swapped');
    expect(host.graph.compile()).toContain('outline-composite');
  });

  it('a setup that throws leaves nothing behind and the live graph untouched', () => {
    const { host, scenes } = makeHost({
      setup: (p) => { if (p.name === 'bloom') throw new Error('BloomPass.SHADER_SOURCE must be set'); },
    });
    expect(() => host.request(BLOOM)).toThrow('SHADER_SOURCE');
    expect(host.isPending).toBe(false);
    expect(host.graph.compile()).toEqual(['forward', 'fxaa-tonemap']);
    expect(scenes[1][0].destroy).toHaveBeenCalledTimes(1); // set up before the throw, not leaked
  });

  it('a request whose build throws leaves an earlier pending request intact', async () => {
    const { host, runs } = makeHost({
      setup: (p) => { if (p.name === 'outline-composite') throw new Error('no composite shader'); },
    });
    const bloom = host.request(BLOOM);
    expect(() => host.request(OUTLINES)).toThrow('no composite shader');
    expect(host.isPending).toBe(true);
    runs.shift()!([]);
    expect((await bloom).outcome).toBe('swapped');
  });

  describe('overlays', () => {
    it('rejects at add time a pass that clashes with ANOTHER mode, naming the mode', () => {
      const { host, setup } = makeHost();
      setup.mockClear();
      expect(() => host.addExternal(new LineBatchPass('bloom', 8))).toThrow(/bloom mode/);
      expect(() => host.addExternal(mockPass('stamp', [], ['selection-seed']))).toThrow(/outlines mode/);
      // Lighting is orthogonal to the composite: a clash with the light chain
      // must be caught whatever composite is live.
      expect(() => host.addExternal(new LineBatchPass('light-accum', 8))).toThrow(/lighting/);
      expect(() => host.addExternal(mockPass('stamp', [], ['light-buffer']))).toThrow(/lighting/);
      expect(setup).not.toHaveBeenCalled();
      expect(host.graph.compile()).toEqual(['forward', 'fxaa-tonemap']);
    });

    it('is set up once and carried across swaps, never destroyed by the host', async () => {
      const { host, runs, setup } = makeHost();
      const overlay = new DebugLinePass();
      const destroy = vi.spyOn(overlay, 'destroy');
      host.addExternal(overlay);
      runs.shift()!([]); // the overlay's own setup validates
      await tick(); // ...and it attaches

      const result = host.request(OUTLINES);
      runs.shift()!([]);
      await result;

      expect(setup.mock.calls.filter(([p]) => p === overlay)).toHaveLength(1);
      expect(host.graph.compile().at(-1)).toBe('physics-debug');
      expect(destroy).not.toHaveBeenCalled();
    });

    it('added while a request is pending, it is in the graph that goes live', async () => {
      const { host, runs } = makeHost();
      const result = host.request(BLOOM);
      host.addExternal(new DebugLinePass());

      runs[1]([]); // the overlay's setup validates first...
      await tick();
      expect(host.graph.compile()).toContain('physics-debug'); // ...and joins the live graph
      runs[0]([]); // then the request
      await result;
      expect(host.graph.compile()).toEqual(['forward', 'bloom', 'physics-debug']);
    });

    it('is not drawn until the GPU has validated its setup', async () => {
      const { host, runs } = makeHost();
      host.addExternal(new DebugLinePass());
      expect(host.graph.compile()).not.toContain('physics-debug');
      runs.shift()!([]);
      await tick();
      expect(host.graph.compile()).toContain('physics-debug');
    });

    it('a stale validation of an earlier add does not affect the pass added again', async () => {
      const { host, runs, onError } = makeHost();
      const overlay = new DebugLinePass();
      host.addExternal(overlay); // run 0
      host.removeExternal('physics-debug');
      host.addExternal(overlay); // run 1

      runs[0](['stale error from the first add']);
      await tick();
      expect(onError).not.toHaveBeenCalled();
      runs[1]([]);
      await tick();
      expect(host.graph.compile()).toContain('physics-debug');
    });

    it('an overlay whose setup raises a GPU error never joins the graph, and is reported', async () => {
      const { host, runs, onError } = makeHost();
      host.addExternal(new DebugLinePass());
      runs.shift()!(['createRenderPipeline: invalid vertex format']);
      await tick();
      expect(host.graph.compile()).not.toContain('physics-debug');
      expect(() => host.addExternal(new DebugLinePass())).not.toThrow(); // the name is free again
      expect(onError).toHaveBeenCalledWith(expect.stringMatching(/physics-debug.*invalid vertex format/s));
    });

    it('removeExternal detaches from the live and the pending graph, and destroys nothing', async () => {
      const { host, runs } = makeHost();
      const overlay = new DebugLinePass();
      const destroy = vi.spyOn(overlay, 'destroy');
      host.addExternal(overlay);
      runs.shift()!([]); // overlay setup
      await tick();
      const result = host.request(BLOOM); // composed with the overlay

      host.removeExternal('physics-debug');
      runs.shift()!([]); // request
      await result;

      expect(host.graph.compile()).toEqual(['forward', 'bloom']);
      expect(destroy).not.toHaveBeenCalled();
    });

    it('removeExternal ignores names it does not own', () => {
      const { host } = makeHost();
      host.removeExternal('forward');
      expect(host.graph.compile()).toContain('forward');
    });
  });

  it('destroy retires the live and the pending graph but not the overlays', () => {
    const { host, scenes } = makeHost();
    const overlay = new DebugLinePass();
    const destroy = vi.spyOn(overlay, 'destroy');
    host.addExternal(overlay); // composes every mode to validate: more (never set up) scenes
    host.request(BLOOM);
    const pendingScene = scenes.at(-1)!;

    host.destroy();

    expect(scenes[0][0].destroy).toHaveBeenCalledTimes(1);
    expect(pendingScene[0].destroy).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe('createGpuValidation', () => {
  function fakeDevice(errors: Record<string, string | null>) {
    const stack: string[] = [];
    return {
      stack,
      pushErrorScope: vi.fn((filter: GPUErrorFilter): undefined => { stack.push(filter); return undefined; }),
      popErrorScope: vi.fn(() => {
        const filter = stack.pop()!;
        const message = errors[filter];
        return Promise.resolve(message ? ({ message } as GPUError) : null);
      }),
    };
  }

  it('collects the messages of every error scope the work raised', async () => {
    const device = fakeDevice({ validation: 'bad binding', 'out-of-memory': null, internal: 'driver hiccup' });
    const messages = await createGpuValidation(device).run(() => {});
    expect(messages.sort()).toEqual(['bad binding', 'driver hiccup']);
    expect(device.stack).toEqual([]);
  });

  it('resolves empty when the work raised nothing', async () => {
    const device = fakeDevice({ validation: null, 'out-of-memory': null, internal: null });
    expect(await createGpuValidation(device).run(() => {})).toEqual([]);
  });

  it('a pop that rejects reads as an error, so the work is reported invalid instead of hanging', async () => {
    const device = fakeDevice({ validation: null, 'out-of-memory': null, internal: null });
    device.popErrorScope.mockImplementationOnce(() => Promise.reject(new Error('OperationError: stack empty')));
    const messages = await createGpuValidation(device).run(() => {});
    expect(messages).toEqual([expect.stringMatching(/popErrorScope.*stack empty/)]);
  });

  it('pops every scope even when the work throws, then rethrows', () => {
    const device = fakeDevice({ validation: null, 'out-of-memory': null, internal: null });
    expect(() => createGpuValidation(device).run(() => { throw new Error('boom'); })).toThrow('boom');
    expect(device.stack).toEqual([]);
    expect(device.popErrorScope).toHaveBeenCalledTimes(3);
  });
});
