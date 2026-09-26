import { describe, it, expect, beforeEach } from 'vitest';
import { LightingAPI, DEFAULT_LIGHTING_QUALITY } from './lighting-api';
import { BackpressuredProducer } from './backpressure';
import { RingBufferProducer, extractUnread, CommandType } from './ring-buffer';
import type { EngineBridge, GPURenderState } from './worker-bridge';

const HEADER = 32;

function emptyRenderState(overrides: Partial<GPURenderState> = {}): GPURenderState {
  return {
    entityCount: 0,
    transforms: new Float32Array(0),
    bounds: new Float32Array(0),
    renderMeta: new Uint32Array(0),
    texIndices: new Uint32Array(0),
    primParams: new Float32Array(0),
    entityIds: new Uint32Array(0),
    listenerX: 0, listenerY: 0, listenerZ: 0,
    tickCount: 0,
    dirtyCount: 0, dirtyRatio: 0,
    stagingData: null, dirtyIndices: null,
    ambientR: 0, ambientG: 0, ambientB: 0, ambientIntensity: 1, lightingBackend: 0,
    ...overrides,
  };
}

function setup() {
  // Not `createRingBuffer()`: it reads `crossOriginIsolated`, which the node
  // test environment does not define. Same shortcut as backpressure.test.ts.
  const sab = new SharedArrayBuffer(HEADER + 4096);
  const producer = new BackpressuredProducer(new RingBufferProducer(sab));
  let renderState: GPURenderState | null = null;
  const bridge = {
    get latestRenderState() { return renderState; },
  } as unknown as EngineBridge;
  const api = new LightingAPI();
  api._init(producer, bridge);
  return {
    api, producer, sab,
    setRenderState(rs: GPURenderState | null) { renderState = rs; },
    flush(): Uint8Array {
      producer.flush();
      return extractUnread(sab).bytes;
    },
  };
}

describe('LightingAPI — backend', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('emits SetLightingBackend against the entity-0 sentinel', () => {
    t.api.setBackend('lit');
    const bytes = t.flush();
    expect(bytes[0]).toBe(CommandType.SetLightingBackend);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(1, true)).toBe(0);
    expect(bytes[5]).toBe(1);
  });

  it('maps every backend name to its wire id', () => {
    for (const [name, id] of [['off', 0], ['lit', 1], ['gi', 2]] as const) {
      const s = setup();
      s.api.setBackend(name);
      expect(s.flush()[5], name).toBe(id);
    }
  });

  it('rejects an unknown backend instead of silently doing nothing', () => {
    // @ts-expect-error deliberately outside the union
    expect(() => t.api.setBackend('raytraced')).toThrow(/Unknown lighting backend/);
  });

  it('reads the backend back from the engine, not from a local copy', () => {
    // Nothing has ticked yet: the command is still in flight.
    t.api.setBackend('gi');
    expect(t.api.backend).toBe('off');
    // After the engine has processed it and reported back:
    t.setRenderState(emptyRenderState({ lightingBackend: 2 }));
    expect(t.api.backend).toBe('gi');
  });

  it('reports off when an unknown backend id comes back', () => {
    t.setRenderState(emptyRenderState({ lightingBackend: 99 }));
    expect(t.api.backend).toBe('off');
  });
});

describe('LightingAPI — ambient', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('emits 4 f32 for a hex colour', () => {
    t.api.setAmbient('#4080c0', 2);
    const bytes = t.flush();
    expect(bytes[0]).toBe(CommandType.SetAmbientLight);
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    expect(dv.getFloat32(5, true)).toBeCloseTo(0x40 / 255, 5);
    expect(dv.getFloat32(9, true)).toBeCloseTo(0x80 / 255, 5);
    expect(dv.getFloat32(13, true)).toBeCloseTo(0xc0 / 255, 5);
    expect(dv.getFloat32(17, true)).toBeCloseTo(2);
  });

  it('accepts 3-digit hex, 6-digit hex and a numeric triple alike', () => {
    for (const c of ['#f00', '#ff0000', [1, 0, 0] as const]) {
      const s = setup();
      s.api.setAmbient(c);
      const bytes = s.flush();
      const dv = new DataView(bytes.buffer, bytes.byteOffset);
      expect(dv.getFloat32(5, true), String(c)).toBeCloseTo(1);
      expect(dv.getFloat32(9, true), String(c)).toBeCloseTo(0);
      expect(dv.getFloat32(13, true), String(c)).toBeCloseTo(0);
    }
  });

  it('defaults intensity to 1', () => {
    t.api.setAmbient('#ffffff');
    const bytes = t.flush();
    expect(new DataView(bytes.buffer, bytes.byteOffset).getFloat32(17, true)).toBeCloseTo(1);
  });

  it('rejects a malformed colour rather than emitting garbage', () => {
    expect(() => t.api.setAmbient('#12')).toThrow(/Invalid ambient color/);
    expect(() => t.api.setAmbient('nope')).toThrow(/Invalid ambient color/);
  });

  it('rejects a non-finite intensity — it would become the clear colour', () => {
    expect(() => t.api.setAmbient('#fff', NaN)).toThrow(/must be finite/);
    expect(() => t.api.setAmbient('#fff', Infinity)).toThrow(/must be finite/);
  });

  it('reads ambient back from the engine', () => {
    t.setRenderState(emptyRenderState({
      ambientR: 0.1, ambientG: 0.2, ambientB: 0.3, ambientIntensity: 1.5,
    }));
    expect(t.api.ambient).toEqual([0.1, 0.2, 0.3, 1.5]);
  });

  it('reports black at intensity 1 before the first tick', () => {
    expect(t.api.ambient).toEqual([0, 0, 0, 1]);
  });
});

describe('LightingAPI — quality', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('starts at the documented defaults', () => {
    expect(t.api.quality).toEqual(DEFAULT_LIGHTING_QUALITY);
    expect(t.api.quality.sdfOversize).toBe(1.0);   // NOT Godot's 1.2 — see the doc comment
    expect(t.api.quality.deterministic).toBe(true);
    // 48, not the 16-32 of the literature: at 24 a ray grazing a sprite's face
    // spends its budget 1-2 texels at a time and leaks light behind a wall.
    // Measured 2026-09-26 on the AMD iGPU: 48 removes every leaking pixel of
    // the repro for +2% light-accum time (most rays end early anyway).
    expect(t.api.quality.shadowSteps).toBe(48);
  });

  it('merges partial updates instead of replacing the whole object', () => {
    t.api.setQuality({ shadowSteps: 32 });
    expect(t.api.quality.shadowSteps).toBe(32);
    expect(t.api.quality.bufferScale).toBe(DEFAULT_LIGHTING_QUALITY.bufferScale);
  });

  it('returns a copy, so a caller cannot mutate settings behind the API', () => {
    const q = t.api.quality;
    q.shadowSteps = 999;
    expect(t.api.quality.shadowSteps).toBe(DEFAULT_LIGHTING_QUALITY.shadowSteps);
  });

  it('emits no ring-buffer command — quality is renderer-side only', () => {
    t.api.setQuality({ bufferScale: 1, cascades: 4 });
    expect(t.flush().length).toBe(0);
  });

  it('rejects values that would produce a zero-sized or inverted texture', () => {
    expect(() => t.api.setQuality({ bufferScale: 0 })).toThrow(/bufferScale/);
    expect(() => t.api.setQuality({ bufferScale: -1 })).toThrow(/bufferScale/);
    expect(() => t.api.setQuality({ sdfOversize: 0.5 })).toThrow(/sdfOversize/);
    expect(() => t.api.setQuality({ shadowSteps: 0 })).toThrow(/shadowSteps/);
    expect(() => t.api.setQuality({ bufferScale: NaN })).toThrow(/must be finite/);
  });

  it('flags a rebuild until the renderer consumes it', () => {
    expect(t.api._needsRebuild).toBe(false);
    t.api.setQuality({ shadowSteps: 16 });
    expect(t.api._needsRebuild).toBe(true);
    t.api._clearRebuildFlag();
    expect(t.api._needsRebuild).toBe(false);
  });
});

describe('LightingAPI — before wiring', () => {
  it('is a safe no-op with no producer, like AudioManager before init', () => {
    const api = new LightingAPI();
    expect(() => api.setBackend('lit')).not.toThrow();
    expect(() => api.setAmbient('#fff')).not.toThrow();
    expect(api.backend).toBe('off');
    expect(api.ambient).toEqual([0, 0, 0, 1]);
  });
});
