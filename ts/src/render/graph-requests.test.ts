import { describe, it, expect, vi } from 'vitest';
import { GraphRequests, type ShaderSlot } from './graph-requests';
import type { GraphMode } from './graph-assembly';
import type { GpuValidation, RequestResult } from './graph-host';

const BASE: GraphMode = { outlines: false, bloom: false, lighting: false };
const BLOOM: GraphMode = { outlines: false, bloom: true, lighting: false };
const OUTLINES: GraphMode = { outlines: true, bloom: false, lighting: false };
const LIT: GraphMode = { ...BASE, lighting: true };

/** A host whose requests the test settles by hand; a swap updates its live mode. */
function fakeHost() {
  const requests: Array<{ mode: GraphMode; settle(outcome: RequestResult['outcome'], errors?: string[]): void }> = [];
  const host = {
    mode: BASE,
    request: vi.fn((mode: GraphMode) => new Promise<RequestResult>((resolve) => {
      requests.push({
        mode,
        settle(outcome, errors = []) {
          if (outcome === 'swapped') host.mode = mode;
          resolve({ outcome, errors });
        },
      });
    })),
  };
  return { host, requests };
}

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

/** A shader slot recording the source its probe compiled. */
function slot(source: string, usedBy: (m: GraphMode) => boolean = () => true) {
  const probed: string[] = [];
  const s: ShaderSlot & { probed: string[] } = {
    probed,
    read: () => source,
    write: (next) => { source = next; },
    probe: () => { probed.push(source); },
    usedBy,
  };
  return s;
}

function setup(slots: Record<string, ShaderSlot> = {}) {
  const { host, requests } = fakeHost();
  const { validation, runs } = deferredValidation();
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const applyOutlineOptions = vi.fn();
  const applyBloomConfig = vi.fn();
  const graph = new GraphRequests<string, string>({
    host, validation, slots, applyOutlineOptions, applyBloomConfig, log,
  });
  return { graph, host, requests, runs, log, applyOutlineOptions, applyBloomConfig };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('GraphRequests — shader hot-reload', () => {
  it('a shader that fails validation never reaches a graph, and its old source stays', async () => {
    const fxaa = slot('good');
    const { graph, host, runs, log } = setup({ fxaa });

    const outcome = graph.reloadShader('fxaa', 'broken');
    expect(fxaa.probed).toEqual(['broken']);
    runs.shift()!(['WGSL: unresolved identifier']);

    expect(await outcome).toBe('rejected');
    expect(fxaa.read()).toBe('good');
    expect(host.request).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/"fxaa".*unresolved identifier/s));
  });

  it('the new source is visible only inside its probe until the GPU accepts it', async () => {
    const fxaa = slot('good', () => false);
    const { graph, runs } = setup({ fxaa });

    const outcome = graph.reloadShader('fxaa', 'next');
    expect(fxaa.read()).toBe('good'); // any build started now sees the old source
    runs.shift()!([]);
    await outcome;
    expect(fxaa.read()).toBe('next');
  });

  it('a shader the requested mode does not use is validated without a rebuild', async () => {
    const bloom = slot('good', (m) => m.bloom);
    const { graph, host, runs } = setup({ bloom });

    const outcome = graph.reloadShader('bloom', 'next');
    runs.shift()!([]);

    expect(await outcome).toBe('validated');
    expect(bloom.read()).toBe('next');
    expect(host.request).not.toHaveBeenCalled();
  });

  it('a used shader that validates rebuilds the graph and is reported once live', async () => {
    const basic = slot('good');
    const { graph, requests, runs, log } = setup({ basic });

    const outcome = graph.reloadShader('basic', 'next');
    runs.shift()!([]);
    await tick();
    requests[0].settle('swapped');

    expect(await outcome).toBe('swapped');
    expect(log.log).toHaveBeenCalledWith(expect.stringMatching(/"basic" hot-reloaded/));
  });

  it('Save All: the broken shader is dropped, the valid one goes live', async () => {
    const jfa = slot('jfa-good');
    const composite = slot('composite-good');
    const { graph, requests, runs } = setup({ jfa, composite });

    const a = graph.reloadShader('jfa', 'jfa-broken');
    const b = graph.reloadShader('composite', 'composite-next');
    runs.shift()!(['WGSL error in jfa']);
    runs.shift()!([]);
    await tick();
    requests.at(-1)!.settle('swapped');

    expect(await a).toBe('rejected');
    expect(await b).toBe('swapped');
    expect(jfa.read()).toBe('jfa-good');
    expect(composite.read()).toBe('composite-next');
  });

  it('a shader reloaded again ignores the older validation', async () => {
    const basic = slot('v0', () => false);
    const { graph, runs } = setup({ basic });

    const first = graph.reloadShader('basic', 'v1');
    const second = graph.reloadShader('basic', 'v2');
    runs.shift()!([]); // v1 is fine, but v2 has replaced it

    expect(await first).toBe('superseded');
    expect(basic.read()).toBe('v0');
    runs.shift()!([]);
    await second;
    expect(basic.read()).toBe('v2');
  });

  it('a probe that throws leaves the old source', async () => {
    const cull = slot('good');
    cull.probe = () => { throw new Error('CullPass.SHADER_SOURCE must be set'); };
    const { graph, log } = setup({ cull });

    expect(await graph.reloadShader('cull', '')).toBe('rejected');
    expect(cull.read()).toBe('good');
    expect(log.error).toHaveBeenCalled();
  });

  it('a graph the GPU rejects restores every shader to the live graph sources', async () => {
    const basic = slot('good');
    const { graph, requests, runs, log } = setup({ basic });

    const outcome = graph.reloadShader('basic', 'next'); // validates alone...
    runs.shift()!([]);
    await tick();
    requests[0].settle('rejected', ['out of memory']); // ...but the graph does not

    expect(await outcome).toBe('rejected');
    expect(basic.read()).toBe('good');
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/out of memory.*reverted.*basic/s));
  });

  it('an empty file saved right after a good edit does not cancel the good one', async () => {
    // Editors can truncate before writing: HMR then delivers '' right after the edit.
    const basic = slot('v0', () => false);
    const probe = basic.probe;
    basic.probe = () => {
      if (basic.read() === '') throw new Error('ForwardPass.SHADER_SOURCES[0] must be set');
      probe();
    };
    const { graph, runs } = setup({ basic });

    const good = graph.reloadShader('basic', 'v1');
    expect(await graph.reloadShader('basic', '')).toBe('rejected');
    runs.shift()!([]);

    expect(await good).toBe('validated');
    expect(basic.read()).toBe('v1');
  });

  it('a shader validated while unused survives a swap and a later unrelated rejection', async () => {
    const bloom = slot('bloom-old', (m) => m.bloom);
    const { graph, requests, runs } = setup({ bloom });
    graph.enableBloom();
    requests[0].settle('swapped'); // bloom live
    await tick();

    graph.disableBloom(); // BASE pending — its snapshot still has bloom-old
    const reload = graph.reloadShader('bloom', 'bloom-new');
    runs.shift()!([]);
    expect(await reload).toBe('validated');
    requests[1].settle('swapped'); // BASE live
    await tick();

    graph.enableBloom();
    requests[2].settle('rejected', ['bloom textures exceed maxTextureDimension2D']);
    await tick();
    expect(bloom.read()).toBe('bloom-new');
  });

  it('a shader the live graph uses, validated while a switch away is pending, goes live if the switch is rejected', async () => {
    const bloom = slot('bloom-old', (m) => m.bloom);
    const { graph, host, requests, runs } = setup({ bloom });
    graph.enableBloom();
    requests[0].settle('swapped');
    await tick();

    graph.disableBloom(); // pending BASE
    const reload = graph.reloadShader('bloom', 'bloom-new');
    runs.shift()!([]);
    expect(await reload).toBe('validated'); // BASE does not use it...
    requests[1].settle('rejected', ['out of memory']); // ...but bloom stays live
    await tick();

    expect(host.request).toHaveBeenLastCalledWith(BLOOM); // rebuilt with bloom-new
  });

  it('prepare transforms the source before it is probed and stored', async () => {
    const cull = slot('plain', () => false);
    cull.prepare = (src) => `enable subgroups;\n${src}`;
    const { graph, runs } = setup({ cull });

    const outcome = graph.reloadShader('cull', 'body');
    runs.shift()!([]);
    await outcome;
    expect(cull.probed).toEqual(['enable subgroups;\nbody']);
    expect(cull.read()).toBe('enable subgroups;\nbody');
  });
});

describe('GraphRequests — modes', () => {
  it('requested reports the asked-for mode at once and falls back on rejection', async () => {
    const { graph, requests } = setup();
    graph.enableBloom('cfg');
    expect(graph.requested.mode).toEqual(BLOOM);

    requests[0].settle('rejected', ['bad bloom pipeline']);
    await tick();
    expect(graph.requested.mode).toEqual(BASE);
  });

  it('a request made between the host verdict and its bookkeeping keeps its own state', async () => {
    // The host acts on a verdict one microtask before GraphRequests hears of
    // it; a request issued in that gap must not be undone by the stale one.
    const { graph, requests } = setup();
    graph.enableOutlines('red');
    requests[0].settle('rejected', ['out of memory']);
    graph.enableBloom('soft'); // runs before the rejection is booked
    await tick();

    expect(graph.requested.mode).toEqual(BLOOM);
    requests[1].settle('swapped');
    await tick();
    expect(graph.requested.mode).toEqual(BLOOM);
  });

  it('a build that throws reverts requested and rethrows', () => {
    const { graph, host } = setup();
    host.request.mockImplementationOnce(() => { throw new Error('multiple writers'); });
    expect(() => graph.enableBloom()).toThrow('multiple writers');
    expect(graph.requested.mode).toEqual(BASE);
  });

  it('changing options of a mode already requested updates the live pass, no rebuild', async () => {
    const { graph, host, requests, applyOutlineOptions, applyBloomConfig } = setup();
    graph.enableOutlines('red');
    requests[0].settle('swapped');
    await tick();

    graph.enableOutlines('blue');
    expect(host.request).toHaveBeenCalledTimes(1);
    expect(applyOutlineOptions).toHaveBeenCalledWith('blue');
    expect(graph.requested.outlineOptions).toBe('blue');

    graph.enableBloom('strong');
    requests[1].settle('swapped');
    await tick();
    graph.enableBloom('soft');
    expect(host.request).toHaveBeenCalledTimes(2);
    expect(applyBloomConfig).toHaveBeenCalledWith('soft');
  });

  it('a disable made while another request is pending survives that request being rejected', async () => {
    const { graph, host, requests } = setup();
    graph.enableBloom();
    requests[0].settle('swapped'); // bloom is live
    await tick();

    graph.enableOutlines('red'); // pending: would replace bloom
    graph.disableBloom(); // no-op on `requested`, but the user wants bloom off
    requests[1].settle('rejected', ['broken outline shader']);
    await tick();

    expect(host.request).toHaveBeenLastCalledWith(BASE);
    expect(graph.requested.mode).toEqual(BASE);
  });

  it('the mutual-exclusion warning appears only once the switch has happened', async () => {
    const { graph, requests, log } = setup();
    graph.enableBloom();
    requests[0].settle('swapped');
    await tick();

    graph.enableOutlines('red');
    requests[1].settle('rejected', ['nope']);
    await tick();
    expect(log.warn).not.toHaveBeenCalled();

    graph.enableOutlines('red');
    requests[2].settle('swapped');
    await tick();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/Disabled bloom/));
    expect(graph.requested.mode).toEqual(OUTLINES);
  });
});

// Lighting (backend 'lit') is orthogonal to the composite. Switching it keeps
// the composite and its options; switching the composite keeps lighting.
describe('GraphRequests — lighting', () => {
  async function lit() {
    const env = setup();
    env.graph.setLighting(true);
    env.requests[0].settle('swapped');
    await tick();
    return env;
  }

  it('setLighting(true) requests a lit graph and reports it at once', () => {
    const { graph, host } = setup();
    graph.setLighting(true);
    expect(host.request).toHaveBeenLastCalledWith(LIT);
    expect(graph.requested.mode).toEqual(LIT);
  });

  it('asking for the state already requested is a no-op', async () => {
    const { graph, host } = await lit();
    graph.setLighting(true);
    expect(host.request).toHaveBeenCalledTimes(1);
    const fresh = setup();
    fresh.graph.setLighting(false);
    expect(fresh.host.request).not.toHaveBeenCalled();
  });

  it('switching the composite keeps lighting on', async () => {
    const { graph, host, requests } = await lit();
    graph.enableBloom('soft');
    expect(host.request).toHaveBeenLastCalledWith({ ...BLOOM, lighting: true });
    requests[1].settle('swapped');
    await tick();
    graph.enableOutlines('red');
    expect(host.request).toHaveBeenLastCalledWith({ ...OUTLINES, lighting: true });
    requests[2].settle('swapped');
    await tick();
    graph.disableOutlines();
    expect(host.request).toHaveBeenLastCalledWith(LIT);
  });

  it('switching lighting keeps the composite and its options', async () => {
    const { graph, host, requests } = setup();
    graph.enableOutlines('red');
    requests[0].settle('swapped');
    await tick();

    graph.setLighting(true);
    expect(host.request).toHaveBeenLastCalledWith({ ...OUTLINES, lighting: true });
    expect(graph.requested.outlineOptions).toBe('red');
    requests[1].settle('swapped');
    await tick();

    graph.setLighting(false);
    expect(host.request).toHaveBeenLastCalledWith(OUTLINES);
    expect(graph.requested.outlineOptions).toBe('red');
  });

  it('a lit graph the GPU rejects falls back to the live one, and says why', async () => {
    const { graph, requests, log } = setup();
    graph.setLighting(true);
    requests[0].settle('rejected', ['light-accum: invalid pipeline']);
    await tick();
    expect(graph.requested.mode).toEqual(BASE);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/Lighting.*invalid pipeline/s));
  });

  it('lighting switched off while another request is pending stays off if that request is rejected', async () => {
    const { graph, host, requests } = await lit();
    graph.setLighting(false); // pending: unlit
    graph.enableBloom(); // supersedes it, still unlit
    graph.setLighting(false); // no-op on `requested`
    expect(graph.requested.mode).toEqual(BLOOM);
    requests[2].settle('rejected', ['broken bloom shader']);
    await tick();
    expect(host.request).toHaveBeenLastCalledWith(BASE);
    expect(graph.requested.mode).toEqual(BASE);
  });
});
