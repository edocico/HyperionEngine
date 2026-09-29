import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDirectBridge, createWorkerBridge, createFullIsolationBridge } from './worker-bridge';
import { ExecutionMode } from './capabilities';

// Phase 5b §4.2: `transparentCount` and `entityIdsGeneration` must reach
// `latestRenderState` in every mode. The worker messages are untyped, so these
// tests are what sees a transport site that drops them.

/** A Worker that records what it is sent and lets a test deliver its replies. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly url: URL, _options?: unknown) {
    FakeWorker.all.push(this);
  }
  postMessage(_msg: unknown, _transfer?: unknown): void {}
  terminate(): void {}
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
}

/** A MessageChannel whose port1 records what the bridge forwards (Mode A). */
class FakeChannel {
  static last: FakeChannel | null = null;
  port1 = { postMessage: vi.fn() };
  port2 = {};
  constructor() {
    FakeChannel.last = this;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.all = [];
  FakeChannel.last = null;
});

/** A non-empty `renderState` as the engine worker posts it. */
function wireState(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    entityCount: 1,
    transforms: new Float32Array(16).buffer,
    bounds: new Float32Array(4).buffer,
    renderMeta: new Uint32Array(2).buffer,
    texIndices: new Uint32Array(1).buffer,
    primParams: new Float32Array(8).buffer,
    entityIds: new Uint32Array([9]).buffer,
    listenerX: 0, listenerY: 0, listenerZ: 0,
    ambientR: 0, ambientG: 0, ambientB: 0, ambientIntensity: 1, lightingBackend: 0,
    ...extra,
  };
}

/** A WASM module stand-in for Mode C: every column empty, `count` entities. */
function fakeWasmModule(count: number, sort?: { transparent: number; generation: number }): Record<string, unknown> {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const zero = () => 0;
  const m: Record<string, unknown> = {
    default: async () => undefined,
    engine_init: () => {},
    engine_push_commands: () => {},
    engine_update: () => {},
    engine_tick_count: () => 1n,
    engine_gpu_entity_count: () => count,
    engine_memory: () => memory,
    engine_listener_x: zero, engine_listener_y: zero, engine_listener_z: zero,
    engine_dirty_count: zero, engine_dirty_ratio: zero,
    engine_staging_ptr: zero, engine_staging_u32_len: zero,
    engine_staging_indices_ptr: zero, engine_staging_indices_len: zero,
  };
  for (const col of ['transforms', 'bounds', 'prim_params']) {
    m[`engine_gpu_${col}_ptr`] = zero;
    m[`engine_gpu_${col}_f32_len`] = zero;
  }
  for (const col of ['render_meta', 'tex_indices', 'entity_ids']) {
    m[`engine_gpu_${col}_ptr`] = zero;
    m[`engine_gpu_${col}_len`] = zero;
  }
  if (sort) {
    m.engine_gpu_transparent_count = () => sort.transparent;
    m.engine_gpu_entity_ids_generation = () => sort.generation;
  }
  return m;
}

describe('Mode C bridge carries the transparent sort inputs', () => {
  it('reads both exports into the non-empty and the empty-world state', async () => {
    vi.stubGlobal('crossOriginIsolated', true);
    for (const count of [3, 0]) {
      const bridge = await createDirectBridge(async () => fakeWasmModule(count, { transparent: 2, generation: 17 }));
      bridge.tick(1 / 60);
      expect(bridge.latestRenderState?.entityCount).toBe(count);
      expect(bridge.latestRenderState?.transparentCount, `count ${count}`).toBe(2);
      expect(bridge.latestRenderState?.entityIdsGeneration, `count ${count}`).toBe(17);
    }
  });

  it('turns missing exports into NaN, never 0', async () => {
    vi.stubGlobal('crossOriginIsolated', true);
    for (const count of [3, 0]) {
      const bridge = await createDirectBridge(async () => fakeWasmModule(count));
      bridge.tick(1 / 60);
      expect(bridge.latestRenderState?.transparentCount, `count ${count}`).toBeNaN();
      expect(bridge.latestRenderState?.entityIdsGeneration, `count ${count}`).toBeNaN();
    }
  });
});

describe('Mode B bridge carries the transparent sort inputs', () => {
  it('copies them from the tick-done renderState', () => {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('Worker', FakeWorker);
    const bridge = createWorkerBridge(ExecutionMode.PartialIsolation);
    FakeWorker.all[0].deliver({
      type: 'tick-done', seq: 1, tickCount: 1,
      renderState: wireState({ transparentCount: 7, entityIdsGeneration: 3 }),
    });
    expect(bridge.latestRenderState?.transparentCount).toBe(7);
    expect(bridge.latestRenderState?.entityIdsGeneration).toBe(3);
    bridge.destroy();
  });

  it('turns fields an older engine worker never sent into NaN', () => {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('Worker', FakeWorker);
    const bridge = createWorkerBridge(ExecutionMode.PartialIsolation);
    FakeWorker.all[0].deliver({ type: 'tick-done', seq: 1, tickCount: 1, renderState: wireState({}) });
    expect(bridge.latestRenderState?.transparentCount).toBeNaN();
    expect(bridge.latestRenderState?.entityIdsGeneration).toBeNaN();
    bridge.destroy();
  });
});

describe('Mode A bridge carries the transparent sort inputs to both threads', () => {
  function setUpModeA() {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('MessageChannel', FakeChannel);
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const canvas = {
      clientWidth: 800,
      clientHeight: 600,
      transferControlToOffscreen: () => ({}),
    } as unknown as HTMLCanvasElement;
    const bridge = createFullIsolationBridge(canvas);
    const ecs = FakeWorker.all.find((w) => w.url.href.includes('engine-worker'))!;
    return { bridge, ecs };
  }

  it('copies them for the main thread and forwards them to the render worker', () => {
    const { bridge, ecs } = setUpModeA();
    ecs.deliver({
      type: 'tick-done', seq: 1, tickCount: 1,
      renderState: wireState({ transparentCount: 5, entityIdsGeneration: 11 }),
    });
    expect(bridge.latestRenderState?.transparentCount).toBe(5);
    expect(bridge.latestRenderState?.entityIdsGeneration).toBe(11);
    // The render worker rebuilds its state from this object (toGPURenderState).
    const [message] = FakeChannel.last!.port1.postMessage.mock.calls[0] as [{ renderState: Record<string, unknown> }];
    expect(message.renderState.transparentCount).toBe(5);
    expect(message.renderState.entityIdsGeneration).toBe(11);
    bridge.destroy();
  });

  it('turns missing fields into NaN on the main thread', () => {
    const { bridge, ecs } = setUpModeA();
    ecs.deliver({ type: 'tick-done', seq: 1, tickCount: 1, renderState: wireState({}) });
    expect(bridge.latestRenderState?.transparentCount).toBeNaN();
    expect(bridge.latestRenderState?.entityIdsGeneration).toBeNaN();
    bridge.destroy();
  });
});
