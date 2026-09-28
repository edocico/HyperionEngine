import { describe, it, expect, vi } from 'vitest';
import { GraphRequests, type ReloadOutcome, type ShaderSlot } from './graph-requests';
import { PieceReloadCollector, type PieceReloadTimers } from './piece-reload-collector';
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

function setup(slots: Record<string, ShaderSlot> = {}, validationOverride?: GpuValidation) {
  const { host, requests } = fakeHost();
  const deferred = deferredValidation();
  const validation = validationOverride ?? deferred.validation;
  const runs = deferred.runs;
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
    // The guard is NOT in ForwardPass (it never throws for one empty module):
    // it is the renderer's piece-slot probe, assertPiecesNotEmpty on the RAW
    // pieces, which throws synchronously inside validation.run. This probe
    // stands for it.
    const quad = slot('v0', () => false);
    const probe = quad.probe;
    quad.probe = () => {
      if (quad.read().trim() === '') throw new Error('Shader piece "quad" is empty');
      probe();
    };
    const { graph, runs } = setup({ quad });

    const good = graph.reloadShader('quad', 'v1');
    expect(await graph.reloadShader('quad', '')).toBe('rejected');
    runs.shift()!([]);

    expect(await good).toBe('validated');
    expect(quad.read()).toBe('v1');
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

// Review 2026-09-26: lighting was switched off (the engine backend went
// 'off'), then a composite request carrying that went out and was rejected.
// `requested` fell back to the live, LIT graph, and nothing asked again, since
// followLightingBackend acts on changes only. The graph stayed lit.
describe('GraphRequests — a switch-off survives the rejection of a later request', () => {
  it('lighting off, then bloom rejected: lighting still goes off', async () => {
    const { graph, host, requests } = setup();
    graph.setLighting(true);
    requests[0].settle('swapped');
    await tick();

    graph.setLighting(false);   // requests[1]: unlit
    graph.enableBloom();        // requests[2]: bloom, unlit
    requests[1].settle('superseded');
    requests[2].settle('rejected', ['broken bloom shader']);
    await tick();

    expect(host.request).toHaveBeenLastCalledWith(BASE);
    expect(graph.requested.mode).toEqual(BASE);
  });

  it('a switch-off the GPU itself rejects is not retried as is: it would fail again', async () => {
    const { graph, host, requests } = setup();
    graph.setLighting(true);
    requests[0].settle('swapped');
    await tick();

    graph.setLighting(false);
    requests[1].settle('rejected', ['device lost']);
    await tick();
    expect(host.request).toHaveBeenCalledTimes(2);
  });
});

// The SDF chain sizes itself every frame inside LightGroupsPass: nothing needs
// to rebuild an unchanged graph, so GraphRequests offers no way to.
describe('GraphRequests — no rebuild of an unchanged graph', () => {
  it('has no rebuild()', () => {
    expect('rebuild' in GraphRequests.prototype).toBe(false);
  });
});

/**
 * A toy compiler for pieces compiled together, like the primitive prelude and
 * libraries: `def:x` declares x (twice is a redeclaration), `use:x` needs a
 * declaration in some piece, `bad` is a syntax error.
 */
function compileToy(pieces: Record<string, string>): string[] {
  const errors: string[] = [];
  const tokens = Object.entries(pieces).flatMap(([piece, src]) =>
    src.split(/\s+/).filter(Boolean).map((token) => ({ piece, token })));
  const declared = new Set<string>();
  for (const { piece, token } of tokens) {
    if (token === 'bad') errors.push(`${piece}: syntax error`);
    if (!token.startsWith('def:')) continue;
    const name = token.slice(4);
    if (declared.has(name)) errors.push(`${piece}: redeclaration of ${name}`);
    declared.add(name);
  }
  for (const { piece, token } of tokens) {
    if (token.startsWith('use:') && !declared.has(token.slice(4))) {
      errors.push(`${piece}: unresolved identifier ${token.slice(4)}`);
    }
  }
  return errors;
}

/**
 * Pieces sharing ONE probe, like the renderer's piece slots. The probe
 * compiles the current text of every piece together (recorded in `compiled`)
 * and throws synchronously on an empty piece, like assertPiecesNotEmpty. The
 * validation resolves with the errors of the probe it ran: at once, or, with
 * `deferVerdicts`, when the test calls the entry `verdicts` holds for it (like
 * popErrorScope, which answers later).
 */
function toyPieces(initial: Record<string, string>, deferVerdicts = false) {
  const sources: Record<string, string> = { ...initial };
  const compiled: Array<Record<string, string>> = [];
  const verdicts: Array<() => void> = [];
  let errors: string[] | null = null;
  const probe = (): void => {
    for (const [name, src] of Object.entries(sources)) {
      if (src.trim() === '') throw new Error(`Shader piece "${name}" is empty`);
    }
    if (!errors) throw new Error('probe outside a validation window');
    compiled.push({ ...sources });
    errors.push(...compileToy(sources));
  };
  const validation: GpuValidation = {
    run(fn) {
      const found: string[] = [];
      errors = found;
      try {
        fn();
      } finally {
        errors = null;
      }
      if (!deferVerdicts) return Promise.resolve(found);
      return new Promise((resolve) => verdicts.push(() => resolve(found)));
    },
  };
  const slots: Record<string, ShaderSlot> = {};
  for (const name of Object.keys(sources)) {
    slots[name] = {
      read: () => sources[name],
      write: (src) => { sources[name] = src; },
      probe,
      usedBy: () => true,
    };
  }
  return { sources, slots, validation, compiled, verdicts };
}

/** Timers fired by hand: the collector's debounce window closes when the test says so. */
function manualTimers() {
  let pending: { id: number; fn: () => void } | null = null;
  let ids = 0;
  const timers: PieceReloadTimers = {
    set: (fn) => {
      pending = { id: ++ids, fn };
      return pending.id;
    },
    clear: (handle) => {
      if (pending?.id === handle) pending = null;
    },
  };
  return {
    timers,
    fire(): void {
      const due = pending;
      pending = null;
      due?.fn();
    },
  };
}

const PIECES: Record<string, string> = {
  prelude: 'def:camera def:quadHelper def:lineHelper',
  quad: 'use:camera use:quadHelper def:quad_fs',
  line: 'use:camera use:lineHelper def:line_fs',
};

/**
 * GraphRequests over toy pieces, fed by a PieceReloadCollector as HMR feeds it.
 * `builtFrom` records the sources every graph request was made from.
 */
function grouped(initial: Record<string, string> = PIECES, deferVerdicts = false) {
  const toy = toyPieces(initial, deferVerdicts);
  const env = setup(toy.slots, toy.validation);
  const builtFrom: Array<Record<string, string>> = [];
  const request = env.host.request.getMockImplementation()!;
  env.host.request.mockImplementation((mode: GraphMode) => {
    builtFrom.push({ ...toy.sources });
    return request(mode);
  });
  const timers = manualTimers();
  const windows: Array<Promise<Map<string, ReloadOutcome>>> = [];
  const collector = new PieceReloadCollector((entries) => {
    const outcome = env.graph.reloadShaders(entries);
    windows.push(outcome);
    return outcome;
  }, 50, timers.timers);
  return { ...env, ...toy, collector, fire: timers.fire, windows, builtFrom };
}

type Grouped = ReturnType<typeof grouped>;

/** Answer the pending GPU verdict at `index` (the oldest by default), and let what awaits it run. */
async function settle(env: Grouped, index = 0): Promise<void> {
  env.verdicts.splice(index, 1)[0]();
  await tick();
}

/** Answer every pending verdict, oldest first, including the ones they lead to. */
async function settleAll(env: Grouped): Promise<void> {
  while (env.verdicts.length > 0) await settle(env);
}

/** Spec §3.3: every graph was requested from a set some probe compiled, and it compiles. */
function expectEveryGraphProbed(env: Grouped): void {
  for (const set of env.builtFrom) {
    expect(env.compiled).toContainEqual(set);
    expect(compileToy(set)).toEqual([]);
  }
}

const outcomesOf = async (p: Promise<Map<string, ReloadOutcome>>) => Object.fromEntries(await p);

// Spec §3.3 point 6: the grouped reload, driven through the collector.
describe('GraphRequests — grouped piece reload, through the collector', () => {
  it('a prelude rename and its use in a library, in one window, go live together', async () => {
    const env = grouped();
    env.collector.offer('prelude', 'def:camera def:quadHelper2 def:lineHelper');
    env.collector.offer('quad', 'use:camera use:quadHelper2 def:quad_fs');
    env.fire();
    await tick();
    expect(env.compiled).toHaveLength(3); // the union, then each alone (both fail alone)
    expect(env.host.request).toHaveBeenCalledTimes(1);
    env.requests[0].settle('swapped');

    expect(await outcomesOf(env.windows[0])).toEqual({ prelude: 'swapped', quad: 'swapped' });
    expect(env.sources.prelude).toContain('def:quadHelper2');
    expect(env.sources.quad).toContain('use:quadHelper2');
    expect(env.log.log).toHaveBeenCalledWith('[Hyperion] Shaders "prelude", "quad" hot-reloaded');
  });

  it('a broken line and an independent valid quad: quad goes live, line is rejected', async () => {
    const env = grouped();
    env.collector.offer('line', 'use:camera use:lineHelper def:line_fs bad');
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs def:quad_extra');
    env.fire();
    await tick();
    expect(env.host.request).toHaveBeenCalledTimes(1);
    env.requests[0].settle('swapped');

    expect(await outcomesOf(env.windows[0])).toEqual({ line: 'rejected', quad: 'swapped' });
    expect(env.sources.line).toBe(PIECES.line);
    expect(env.sources.quad).toContain('def:quad_extra');
    expect(env.log.error).toHaveBeenCalledWith(expect.stringMatching(/Shader "line" rejected.*line: syntax error/s));
  });

  it('two pieces that compile alone but not together: both rejected, no graph request, a pending mode switch still goes live', async () => {
    const env = grouped();
    env.graph.enableOutlines('red'); // requests[0], still pending
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs def:shared');
    env.collector.offer('line', 'use:camera use:lineHelper def:line_fs def:shared');
    env.fire();

    expect(await outcomesOf(env.windows[0])).toEqual({ quad: 'rejected', line: 'rejected' });
    expect(env.compiled).toHaveLength(3); // the union and the two solos: the rejected set is not tried again
    expect(env.host.request).toHaveBeenCalledTimes(1);
    expect(env.sources.quad).toBe(PIECES.quad);
    expect(env.sources.line).toBe(PIECES.line);
    expect(env.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/Shaders "quad", "line" compile alone but not together.*redeclaration of shared/s),
    );

    env.requests[0].settle('swapped');
    await tick();
    expect(env.graph.requested.mode).toEqual(OUTLINES);
    expect(env.host.mode).toEqual(OUTLINES);
  });

  it('a prelude rename + the line using it + an unrelated broken quad: all three rejected (the declared limit)', async () => {
    const env = grouped();
    env.collector.offer('prelude', 'def:camera def:quadHelper def:lineHelper2');
    env.collector.offer('line', 'use:camera use:lineHelper2 def:line_fs');
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs bad');
    env.fire();

    expect(await outcomesOf(env.windows[0])).toEqual({ prelude: 'rejected', line: 'rejected', quad: 'rejected' });
    expect(env.host.request).not.toHaveBeenCalled();
    expect(env.sources).toEqual(PIECES);
  });

  it('an entry replaced by a later window is superseded, and the newer source goes live', async () => {
    const env = grouped();
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs def:v1');
    env.fire();
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs def:v2');
    env.fire();
    await tick();
    expect(env.host.request).toHaveBeenCalledTimes(1);
    env.requests[0].settle('swapped');

    expect(await outcomesOf(env.windows[0])).toEqual({ quad: 'superseded' });
    expect(await outcomesOf(env.windows[1])).toEqual({ quad: 'swapped' });
    expect(env.sources.quad).toContain('def:v2');
  });

  it("v1 then '' for the same piece in one window: v1 goes live", async () => {
    const env = grouped();
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs def:v1');
    env.collector.offer('quad', '');
    env.fire();
    await tick();
    env.requests[0].settle('swapped');

    expect(await outcomesOf(env.windows[0])).toEqual({ quad: 'swapped' });
    expect(env.sources.quad).toContain('def:v1');
  });

  it("'' then v1 for the same piece in one window: v1 goes live", async () => {
    const env = grouped();
    env.collector.offer('quad', '');
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs def:v1');
    env.fire();
    await tick();
    env.requests[0].settle('swapped');

    expect(await outcomesOf(env.windows[0])).toEqual({ quad: 'swapped' });
    expect(env.sources.quad).toContain('def:v1');
  });
});

describe('GraphRequests — reloadShaders', () => {
  const PRELUDE_EXTRA = 'def:camera def:quadHelper def:lineHelper def:extra';
  const QUAD_EXTRA = 'use:camera use:quadHelper def:quad_fs use:extra';

  it('probes the union, then each entry alone, all inside the call; every source is back after', () => {
    const env = grouped();
    void env.graph.reloadShaders([{ name: 'prelude', code: PRELUDE_EXTRA }, { name: 'quad', code: QUAD_EXTRA }]);
    expect(env.compiled).toEqual([
      { prelude: PRELUDE_EXTRA, quad: QUAD_EXTRA, line: PIECES.line }, // the union
      { prelude: PRELUDE_EXTRA, quad: PIECES.quad, line: PIECES.line }, // prelude alone
      { prelude: PIECES.prelude, quad: QUAD_EXTRA, line: PIECES.line }, // quad alone
    ]);
    expect(env.sources).toEqual(PIECES);
  });

  it('a single entry is probed once', () => {
    const env = grouped();
    void env.graph.reloadShaders([{ name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:v1' }]);
    expect(env.compiled).toHaveLength(1);
  });

  it('an entry whose probe throws is rejected at once and supersedes nothing', async () => {
    const env = grouped();
    const good = env.graph.reloadShader('quad', 'use:camera use:quadHelper def:quad_fs def:v1');
    expect(await outcomesOf(env.graph.reloadShaders([{ name: 'quad', code: '' }]))).toEqual({ quad: 'rejected' });
    expect(env.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/Shader "quad" did not compile/), expect.objectContaining({ message: 'Shader piece "quad" is empty' }),
    );
    await tick();
    env.requests[0].settle('swapped');

    expect(await good).toBe('swapped');
    expect(env.sources.quad).toContain('def:v1');
  });

  it('a direct reloadShader of a piece supersedes the entry of a pending window', async () => {
    const env = grouped();
    const batch = env.graph.reloadShaders([{ name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:v1' }]);
    const direct = env.graph.reloadShader('quad', 'use:camera use:quadHelper def:quad_fs def:v2');
    await tick();
    expect(env.host.request).toHaveBeenCalledTimes(1);
    env.requests[0].settle('swapped');

    expect(await outcomesOf(batch)).toEqual({ quad: 'superseded' });
    expect(await direct).toBe('swapped');
    expect(env.sources.quad).toContain('def:v2');
  });

  it('and the other way round: a window supersedes a pending direct reloadShader', async () => {
    const env = grouped();
    const direct = env.graph.reloadShader('quad', 'use:camera use:quadHelper def:quad_fs def:v1');
    const batch = env.graph.reloadShaders([{ name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:v2' }]);
    await tick();
    expect(env.host.request).toHaveBeenCalledTimes(1);
    env.requests[0].settle('swapped');

    expect(await direct).toBe('superseded');
    expect(await outcomesOf(batch)).toEqual({ quad: 'swapped' });
    expect(env.sources.quad).toContain('def:v2');
  });

  it('an empty entry next to a valid one: the valid one still goes live', async () => {
    const env = grouped();
    const outcome = env.graph.reloadShaders([
      { name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:v1' },
      { name: 'line', code: '' },
    ]);
    await tick();
    expect(env.host.request).toHaveBeenCalledTimes(1);
    env.requests[0].settle('swapped');

    expect(await outcomesOf(outcome)).toEqual({ quad: 'swapped', line: 'rejected' });
    expect(env.sources.quad).toContain('def:v1');
    expect(env.sources.line).toBe(PIECES.line);
  });

  it('an unknown name is reported, the others still reload', async () => {
    const env = grouped();
    const outcome = env.graph.reloadShaders([
      { name: 'nope', code: 'x' },
      { name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:v1' },
    ]);
    await tick();
    env.requests[0].settle('swapped');

    expect(await outcomesOf(outcome)).toEqual({ nope: 'unknown', quad: 'swapped' });
    expect(env.log.warn).toHaveBeenCalledWith('[Hyperion] Unknown shader pass: nope');
  });

  it('some pass alone: the passing ones are probed together once more before any graph request', async () => {
    const env = grouped({ ...PIECES, gradient: 'use:camera def:gradient_fs' });
    const outcome = env.graph.reloadShaders([
      { name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:q2' },
      { name: 'line', code: 'use:camera use:lineHelper def:line_fs bad' },
      { name: 'gradient', code: 'use:camera def:gradient_fs def:g2' },
    ]);
    await tick();
    // The union, three solos, then quad + gradient together over the current sources.
    expect(env.compiled).toHaveLength(5);
    expect(env.compiled[4]).toEqual({
      prelude: PIECES.prelude,
      quad: 'use:camera use:quadHelper def:quad_fs def:q2',
      line: PIECES.line,
      gradient: 'use:camera def:gradient_fs def:g2',
    });
    env.requests[0].settle('swapped');

    expect(await outcomesOf(outcome)).toEqual({ quad: 'swapped', line: 'rejected', gradient: 'swapped' });
  });

  it('a passing subset that fails together is rejected, with no graph request', async () => {
    const env = grouped({ ...PIECES, gradient: 'use:camera def:gradient_fs' });
    const outcome = env.graph.reloadShaders([
      { name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:shared' },
      { name: 'line', code: 'use:camera use:lineHelper def:line_fs bad' },
      { name: 'gradient', code: 'use:camera def:gradient_fs def:shared' },
    ]);

    expect(await outcomesOf(outcome)).toEqual({ quad: 'rejected', line: 'rejected', gradient: 'rejected' });
    expect(env.host.request).not.toHaveBeenCalled();
    expect(env.sources.quad).toBe(PIECES.quad);
    expect(env.sources.gradient).toBe('use:camera def:gradient_fs');
  });
});

// Spec §3.3 point 3 across calls: a verdict is about the sources current when
// its probe ran. Another reload committing meanwhile makes the set untried.
describe('GraphRequests — reloadShaders over sources committed meanwhile', () => {
  const RENAMED = { prelude: 'def:camera def:X2', quad: 'use:camera use:X2 def:quad_fs' };
  const BEFORE_RENAME = { prelude: 'def:camera def:X', quad: 'use:camera use:X def:quad_fs', line: 'use:camera def:line_fs' };
  const renameWindow = (env: Grouped) => env.graph.reloadShaders([
    { name: 'prelude', code: RENAMED.prelude },
    { name: 'quad', code: RENAMED.quad },
  ]);

  it('a window probed before another window committed is probed again: no graph from an untried set, the rename stays', async () => {
    const env = grouped(BEFORE_RENAME, true);
    // A: the coupled rename X -> X2. The union passes, each piece alone fails.
    const a = renameWindow(env);
    // B, before A's verdict: line starts using X. Probed over the OLD prelude, it passes.
    const b = env.graph.reloadShaders([{ name: 'line', code: 'use:camera use:X def:line_fs' }]);
    await settleAll(env);

    expect(env.host.request).toHaveBeenCalledTimes(1);
    env.requests[0].settle('swapped');
    expect(await outcomesOf(a)).toEqual({ prelude: 'swapped', quad: 'swapped' });
    expect(await outcomesOf(b)).toEqual({ line: 'rejected' });
    expect(env.sources).toEqual({ ...BEFORE_RENAME, ...RENAMED });
    expect(env.log.error).toHaveBeenCalledWith(expect.stringMatching(
      /Shader "line" rejected over the sources another reload committed meanwhile.*line: unresolved identifier X/s,
    ));
    expectEveryGraphProbed(env);
  });

  it('a coupled window whose quad is saved again before the verdict: both windows rejected (the declared limit)', async () => {
    const env = grouped(BEFORE_RENAME, true);
    const a = renameWindow(env);
    // quad saved again, still using X2: it supersedes A's quad and is probed over the OLD prelude.
    const b = env.graph.reloadShaders([{ name: 'quad', code: 'use:camera use:X2 def:quad_fs def:q3' }]);
    await settleAll(env);

    expect(await outcomesOf(a)).toEqual({ prelude: 'rejected', quad: 'superseded' });
    expect(await outcomesOf(b)).toEqual({ quad: 'rejected' });
    expect(env.host.request).not.toHaveBeenCalled();
    expect(env.sources).toEqual(BEFORE_RENAME);
  });

  it('an independent window probed before the commit is probed again over it, and goes live', async () => {
    const env = grouped(BEFORE_RENAME, true);
    const a = renameWindow(env);
    const b = env.graph.reloadShaders([{ name: 'line', code: 'use:camera def:line_fs def:extra' }]);
    await settleAll(env);

    // A: the union and two solos. B: its probe, then once more over A's commit.
    expect(env.compiled).toHaveLength(5);
    expect(env.compiled[4]).toEqual({ ...RENAMED, line: 'use:camera def:line_fs def:extra' });
    expect(env.host.request).toHaveBeenCalledTimes(2);
    env.requests[0].settle('swapped');
    env.requests[1].settle('swapped');
    expect(await outcomesOf(a)).toEqual({ prelude: 'swapped', quad: 'swapped' });
    expect(await outcomesOf(b)).toEqual({ line: 'swapped' });
    expectEveryGraphProbed(env);
  });

  it('a revert (a rejected graph) while a window waits makes it probe again', async () => {
    const env = grouped(PIECES, true);
    const first = env.graph.reloadShaders([{ name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:q2' }]);
    await settleAll(env); // quad committed, graph requested
    // Probed over the committed quad, which it uses.
    const second = env.graph.reloadShaders([{ name: 'line', code: 'use:camera use:lineHelper def:line_fs use:q2' }]);
    env.requests[0].settle('rejected', ['out of memory']); // quad goes back to its old source
    await tick();
    expect(env.sources.quad).toBe(PIECES.quad);
    await settleAll(env);

    expect(env.host.request).toHaveBeenCalledTimes(1);
    expect(await outcomesOf(first)).toEqual({ quad: 'rejected' });
    expect(await outcomesOf(second)).toEqual({ line: 'rejected' });
    expect(env.sources.line).toBe(PIECES.line);
  });

  it('a member superseded while the survivors are probed together: the lone survivor, proven alone, goes live', async () => {
    const env = grouped({ ...PIECES, gradient: 'use:camera def:gradient_fs' }, true);
    const Q2 = 'use:camera use:quadHelper def:quad_fs def:q2';
    const G2 = 'use:camera def:gradient_fs def:g2';
    const G3 = 'use:camera def:gradient_fs def:g3';
    const w = env.graph.reloadShaders([
      { name: 'quad', code: Q2 },
      { name: 'line', code: 'use:camera use:lineHelper def:line_fs bad' },
      { name: 'gradient', code: G2 },
    ]);
    for (let i = 0; i < 4; i++) await settle(env); // the union and three solos
    // quad and gradient pass alone: probed together now.
    expect(env.compiled[4]).toEqual({ ...PIECES, quad: Q2, gradient: G2 });
    // Before that verdict, a later window reloads gradient.
    const later = env.graph.reloadShaders([{ name: 'gradient', code: G3 }]);
    await settle(env); // the together probe: gradient superseded, quad alone left

    expect(env.compiled).toHaveLength(6); // quad was proven alone over these sources: not probed again
    expect(env.host.request).toHaveBeenCalledTimes(1);
    expect(env.builtFrom[0]).toEqual({ ...PIECES, quad: Q2, gradient: 'use:camera def:gradient_fs' });

    await settleAll(env); // the later window, probed again over quad's commit
    expect(env.compiled).toHaveLength(7);
    env.requests[0].settle('swapped');
    env.requests[1].settle('swapped');
    expect(await outcomesOf(w)).toEqual({ quad: 'swapped', line: 'rejected', gradient: 'superseded' });
    expect(await outcomesOf(later)).toEqual({ gradient: 'swapped' });
    expect(env.sources).toEqual({ ...PIECES, quad: Q2, gradient: G3 });
    expectEveryGraphProbed(env);
  });

  it('the union passed but a member was superseded: the others are probed together before any graph', async () => {
    const env = grouped(PIECES, true);
    const P2 = 'def:camera def:quadHelper def:lineHelper def:p2';
    const Q2 = 'use:camera use:quadHelper def:quad_fs def:q2';
    const w = env.graph.reloadShaders([
      { name: 'prelude', code: P2 },
      { name: 'quad', code: Q2 },
      { name: 'line', code: 'use:camera use:lineHelper def:line_fs def:l2' },
    ]);
    const L3 = 'use:camera use:lineHelper def:line_fs def:l3';
    const later = env.graph.reloadShaders([{ name: 'line', code: L3 }]); // supersedes w's line
    for (let i = 0; i < 4; i++) await settle(env); // w: the union (passes) and three solos

    // The union held w's line, which is gone: prelude + quad were never tried together.
    expect(env.compiled).toHaveLength(6);
    expect(env.compiled[5]).toEqual({ ...PIECES, prelude: P2, quad: Q2 });
    expect(env.host.request).not.toHaveBeenCalled();

    await settle(env, 1); // that probe's verdict, before the later window's
    expect(env.compiled).toHaveLength(6);
    expect(env.host.request).toHaveBeenCalledTimes(1);
    expect(env.builtFrom[0]).toEqual({ ...PIECES, prelude: P2, quad: Q2 });

    await settleAll(env);
    env.requests[0].settle('swapped');
    env.requests[1].settle('swapped');
    expect(await outcomesOf(w)).toEqual({ prelude: 'swapped', quad: 'swapped', line: 'superseded' });
    expect(await outcomesOf(later)).toEqual({ line: 'swapped' });
    expect(env.sources).toEqual({ prelude: P2, quad: Q2, line: L3 });
    expectEveryGraphProbed(env);
  });
});
