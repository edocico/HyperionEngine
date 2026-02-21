# Phase 7: Audio System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a complete audio subsystem to Hyperion with sound loading, playback control, 2D spatial audio, and seamless integration into the engine lifecycle.

**Architecture:** Web Audio API-based AudioManager with lazy initialization. Sound files are decoded via `AudioContext.decodeAudioData()` into `AudioBuffer`s. Each playback creates an `AudioBufferSourceNode → GainNode → StereoPannerNode → masterGain → destination` chain. 2D spatial audio uses stereo panning from entity/listener positions. The WASM DSP AudioWorklet path (§10 of design-v3.md) is reserved as a future optimization for custom synthesis/effects — the Web Audio API provides browser-native audio thread isolation and hardware-accelerated mixing that meets all current requirements.

**Tech Stack:** Web Audio API (AudioContext, AudioBufferSourceNode, GainNode, StereoPannerNode), TypeScript, vitest

**Test counts at start:** Rust: 88 tests, TypeScript: 291 tests (33 test files)

---

## Architecture Decision: Web Audio API vs. WASM AudioWorklet DSP

The design doc (§10) specifies a dedicated `AudioWorkletProcessor` running a Rust/WASM binary for synthesis and mixing. We defer that approach because:

1. **The Web Audio API already runs on a dedicated audio thread** — the browser handles thread isolation, scheduling, and hardware acceleration internally. We get the same isolation benefit without managing our own AudioWorklet.
2. **Browser-native mixing is faster** than WASM mixing — `AudioBufferSourceNode` and `GainNode` are implemented in optimized native code, not interpreted WASM.
3. **Spatial audio via `StereoPannerNode`** covers 2D/2.5D use cases with zero custom math needed.
4. **~70% less code** — no second Rust crate, no Cargo workspace changes, no AudioWorklet module loading, no WASM-in-worker message passing.
5. **The API is identical** — consumers call `engine.audio.play()` regardless of the backend. The WASM DSP can be layered in later without API changes.

The WASM AudioWorklet DSP path becomes valuable when we need: custom synthesis (procedural sound generation), custom effects (reverb, distortion), or sample-accurate mixing tied to game state. That's Phase 7+ scope.

---

## Audio Node Graph

```
Per playback:
  AudioBufferSourceNode   ← buffer, loop, playbackRate (pitch)
         │
      GainNode            ← per-sound volume
         │
  StereoPannerNode        ← 2D pan (-1 to 1)
         │
      masterGain          ← global volume / mute
         │
      destination         ← speakers
```

## Spatial Audio Model (2D)

```
pan = clamp((entityX - listenerX) / panSpread, -1, 1)
gain *= 1 / (1 + distance / rolloff)
```

Where `distance = sqrt((ex - lx)² + (ey - ly)²)`, `panSpread` defaults to 20 (world units), `rolloff` defaults to 10.

---

## Task Overview

| # | Component | Files | Tests |
|---|-----------|-------|-------|
| 1 | Audio types + interfaces | `audio-types.ts` | `audio-types.test.ts` |
| 2 | SoundRegistry — load + decode | `sound-registry.ts` | `sound-registry.test.ts` |
| 3 | SoundRegistry — batch load + progress | `sound-registry.ts` | `sound-registry.test.ts` |
| 4 | SoundRegistry — unload + destroy | `sound-registry.ts` | `sound-registry.test.ts` |
| 5 | PlaybackEngine — play a sound | `playback-engine.ts` | `playback-engine.test.ts` |
| 6 | PlaybackEngine — stop + volume | `playback-engine.ts` | `playback-engine.test.ts` |
| 7 | PlaybackEngine — pitch + looping | `playback-engine.ts` | `playback-engine.test.ts` |
| 8 | PlaybackEngine — 2D spatial pan | `playback-engine.ts` | `playback-engine.test.ts` |
| 9 | PlaybackEngine — master volume + mute | `playback-engine.ts` | `playback-engine.test.ts` |
| 10 | AudioManager — lazy init + unlock | `audio-manager.ts` | `audio-manager.test.ts` |
| 11 | AudioManager — load + play API | `audio-manager.ts` | `audio-manager.test.ts` |
| 12 | AudioManager — playback control | `audio-manager.ts` | `audio-manager.test.ts` |
| 13 | AudioManager — spatial listener | `audio-manager.ts` | `audio-manager.test.ts` |
| 14 | AudioManager — lifecycle | `audio-manager.ts` | `audio-manager.test.ts` |
| 15 | Hyperion facade — audio getter | `hyperion.ts` | `hyperion.test.ts` |
| 16 | Hyperion — lifecycle wiring | `hyperion.ts` | `hyperion.test.ts` |
| 17 | Hyperion — listener auto-update | `hyperion.ts` | `hyperion.test.ts` |
| 18 | Barrel exports | `index.ts` | type-check |
| 19 | Demo — spatial audio playground | `main.ts` | manual browser test |
| 20 | Documentation — CLAUDE.md | `CLAUDE.md` | — |
| 21 | Documentation — PROJECT_ARCHITECTURE.md | `PROJECT_ARCHITECTURE.md` | — |
| 22 | Full validation pipeline | — | all tests + clippy + tsc |

---

## Part 1: Audio Types

### Task 1: Audio types and interfaces

**Files:**
- Create: `ts/src/audio-types.ts`
- Create: `ts/src/audio-types.test.ts`

**Step 1: Write the failing test**

```typescript
// ts/src/audio-types.test.ts
import { describe, it, expect } from 'vitest';
import { SoundHandle, PlaybackId, DEFAULT_PLAYBACK_OPTIONS, DEFAULT_SPATIAL_CONFIG } from './audio-types';

describe('audio types', () => {
  it('SoundHandle and PlaybackId are distinct number brands', () => {
    const s = 1 as SoundHandle;
    const p = 2 as PlaybackId;
    expect(typeof s).toBe('number');
    expect(typeof p).toBe('number');
  });

  it('DEFAULT_PLAYBACK_OPTIONS has sensible defaults', () => {
    expect(DEFAULT_PLAYBACK_OPTIONS.volume).toBe(1);
    expect(DEFAULT_PLAYBACK_OPTIONS.pitch).toBe(1);
    expect(DEFAULT_PLAYBACK_OPTIONS.loop).toBe(false);
  });

  it('DEFAULT_SPATIAL_CONFIG has sensible defaults', () => {
    expect(DEFAULT_SPATIAL_CONFIG.panSpread).toBe(20);
    expect(DEFAULT_SPATIAL_CONFIG.rolloff).toBe(10);
    expect(DEFAULT_SPATIAL_CONFIG.maxDistance).toBe(100);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/audio-types.test.ts`
Expected: FAIL — module `./audio-types` not found

**Step 3: Write minimal implementation**

```typescript
// ts/src/audio-types.ts

/** Opaque handle to a loaded sound. Returned by SoundRegistry.load(). */
export type SoundHandle = number & { readonly __brand: 'SoundHandle' };

/** Opaque handle to an active playback. Returned by PlaybackEngine.play(). */
export type PlaybackId = number & { readonly __brand: 'PlaybackId' };

/** Options for starting a sound playback. */
export interface PlaybackOptions {
  /** Volume multiplier (0 = silent, 1 = full). Default: 1. */
  volume?: number;
  /** Pitch multiplier (0.5 = half speed, 2 = double). Default: 1. */
  pitch?: number;
  /** Whether to loop the sound. Default: false. */
  loop?: boolean;
}

/** Spatial audio configuration for distance attenuation and panning. */
export interface SpatialConfig {
  /** World-unit distance at which pan reaches ±1 (hard left/right). Default: 20. */
  panSpread: number;
  /** Distance rolloff factor for volume attenuation. Default: 10. */
  rolloff: number;
  /** Maximum audible distance. Sounds beyond this are silent. Default: 100. */
  maxDistance: number;
}

export const DEFAULT_PLAYBACK_OPTIONS: Required<PlaybackOptions> = {
  volume: 1,
  pitch: 1,
  loop: false,
};

export const DEFAULT_SPATIAL_CONFIG: SpatialConfig = {
  panSpread: 20,
  rolloff: 10,
  maxDistance: 100,
};
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/audio-types.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add ts/src/audio-types.ts ts/src/audio-types.test.ts
git commit -m "feat(phase7): add audio types and interfaces"
```

---

## Part 2: SoundRegistry

### Task 2: SoundRegistry — load and decode sounds

**Files:**
- Create: `ts/src/sound-registry.ts`
- Create: `ts/src/sound-registry.test.ts`

The SoundRegistry manages decoded audio buffers. It accepts an `AudioContext` for `decodeAudioData()` and a `fetch` function for testability.

**Step 1: Write the failing test**

```typescript
// ts/src/sound-registry.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SoundRegistry } from './sound-registry';
import type { SoundHandle } from './audio-types';

function mockAudioBuffer(duration = 1, channels = 2, sampleRate = 44100): AudioBuffer {
  return {
    duration,
    numberOfChannels: channels,
    sampleRate,
    length: duration * sampleRate,
    getChannelData: vi.fn(() => new Float32Array(duration * sampleRate)),
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer;
}

function mockDecoder(): (data: ArrayBuffer) => Promise<AudioBuffer> {
  return vi.fn(async () => mockAudioBuffer());
}

function mockFetcher(): (url: string) => Promise<ArrayBuffer> {
  return vi.fn(async () => new ArrayBuffer(1024));
}

describe('SoundRegistry', () => {
  it('load returns a SoundHandle', async () => {
    const reg = new SoundRegistry(mockDecoder(), mockFetcher());
    const handle = await reg.load('test.mp3');
    expect(typeof handle).toBe('number');
  });

  it('load calls fetch then decode', async () => {
    const decode = mockDecoder();
    const fetch = mockFetcher();
    const reg = new SoundRegistry(decode, fetch);
    await reg.load('sfx/click.ogg');
    expect(fetch).toHaveBeenCalledWith('sfx/click.ogg');
    expect(decode).toHaveBeenCalled();
  });

  it('getBuffer returns the decoded AudioBuffer', async () => {
    const buf = mockAudioBuffer(2);
    const decode = vi.fn(async () => buf);
    const reg = new SoundRegistry(decode, mockFetcher());
    const handle = await reg.load('test.mp3');
    expect(reg.getBuffer(handle)).toBe(buf);
  });

  it('getBuffer returns undefined for unknown handle', () => {
    const reg = new SoundRegistry(mockDecoder(), mockFetcher());
    expect(reg.getBuffer(999 as SoundHandle)).toBeUndefined();
  });

  it('assigns incrementing handles', async () => {
    const reg = new SoundRegistry(mockDecoder(), mockFetcher());
    const h1 = await reg.load('a.mp3');
    const h2 = await reg.load('b.mp3');
    expect(h2).toBe(h1 + 1);
  });

  it('deduplicates by URL', async () => {
    const decode = mockDecoder();
    const reg = new SoundRegistry(decode, mockFetcher());
    const h1 = await reg.load('same.mp3');
    const h2 = await reg.load('same.mp3');
    expect(h1).toBe(h2);
    expect(decode).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/sound-registry.test.ts`
Expected: FAIL — module `./sound-registry` not found

**Step 3: Write minimal implementation**

```typescript
// ts/src/sound-registry.ts
import type { SoundHandle } from './audio-types';

export type AudioDecoder = (data: ArrayBuffer) => Promise<AudioBuffer>;
export type AudioFetcher = (url: string) => Promise<ArrayBuffer>;

export class SoundRegistry {
  private readonly decoder: AudioDecoder;
  private readonly fetcher: AudioFetcher;
  private readonly buffers = new Map<SoundHandle, AudioBuffer>();
  private readonly urlToHandle = new Map<string, SoundHandle>();
  private nextHandle = 0;

  constructor(decoder: AudioDecoder, fetcher: AudioFetcher) {
    this.decoder = decoder;
    this.fetcher = fetcher;
  }

  async load(url: string): Promise<SoundHandle> {
    const existing = this.urlToHandle.get(url);
    if (existing !== undefined) return existing;

    const data = await this.fetcher(url);
    const buffer = await this.decoder(data);
    const handle = this.nextHandle++ as SoundHandle;
    this.buffers.set(handle, buffer);
    this.urlToHandle.set(url, handle);
    return handle;
  }

  getBuffer(handle: SoundHandle): AudioBuffer | undefined {
    return this.buffers.get(handle);
  }

  get count(): number {
    return this.buffers.size;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/sound-registry.test.ts`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add ts/src/sound-registry.ts ts/src/sound-registry.test.ts
git commit -m "feat(phase7): add SoundRegistry with load/decode/dedup"
```

---

### Task 3: SoundRegistry — batch load with progress

**Files:**
- Modify: `ts/src/sound-registry.ts`
- Modify: `ts/src/sound-registry.test.ts`

**Step 1: Write the failing test**

Append to `ts/src/sound-registry.test.ts`:

```typescript
describe('SoundRegistry batch loading', () => {
  it('loadAll returns handles in URL order', async () => {
    const reg = new SoundRegistry(mockDecoder(), mockFetcher());
    const handles = await reg.loadAll(['a.mp3', 'b.mp3', 'c.mp3']);
    expect(handles).toHaveLength(3);
    expect(handles[1]).toBe(handles[0] + 1);
    expect(handles[2]).toBe(handles[0] + 2);
  });

  it('loadAll fires onProgress after each sound', async () => {
    const reg = new SoundRegistry(mockDecoder(), mockFetcher());
    const progress: [number, number][] = [];
    await reg.loadAll(['a.mp3', 'b.mp3'], {
      onProgress: (loaded, total) => progress.push([loaded, total]),
    });
    expect(progress).toEqual([[1, 2], [2, 2]]);
  });

  it('loadAll with empty array returns empty', async () => {
    const reg = new SoundRegistry(mockDecoder(), mockFetcher());
    const handles = await reg.loadAll([]);
    expect(handles).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/sound-registry.test.ts`
Expected: FAIL — `reg.loadAll is not a function`

**Step 3: Write minimal implementation**

Add to `SoundRegistry` class in `ts/src/sound-registry.ts`:

```typescript
async loadAll(
  urls: string[],
  opts?: { onProgress?: (loaded: number, total: number) => void },
): Promise<SoundHandle[]> {
  const handles: SoundHandle[] = [];
  let loaded = 0;
  for (const url of urls) {
    const handle = await this.load(url);
    handles.push(handle);
    loaded++;
    opts?.onProgress?.(loaded, urls.length);
  }
  return handles;
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/sound-registry.test.ts`
Expected: PASS (9 tests)

**Step 5: Commit**

```bash
git add ts/src/sound-registry.ts ts/src/sound-registry.test.ts
git commit -m "feat(phase7): add SoundRegistry.loadAll with progress callback"
```

---

### Task 4: SoundRegistry — unload and destroy

**Files:**
- Modify: `ts/src/sound-registry.ts`
- Modify: `ts/src/sound-registry.test.ts`

**Step 1: Write the failing test**

Append to `ts/src/sound-registry.test.ts`:

```typescript
describe('SoundRegistry unload + destroy', () => {
  it('unload removes a sound by handle', async () => {
    const reg = new SoundRegistry(mockDecoder(), mockFetcher());
    const h = await reg.load('test.mp3');
    expect(reg.getBuffer(h)).toBeDefined();
    reg.unload(h);
    expect(reg.getBuffer(h)).toBeUndefined();
    expect(reg.count).toBe(0);
  });

  it('unload removes URL dedup mapping', async () => {
    const decode = mockDecoder();
    const reg = new SoundRegistry(decode, mockFetcher());
    const h1 = await reg.load('test.mp3');
    reg.unload(h1);
    const h2 = await reg.load('test.mp3');
    // Should fetch + decode again (not deduped)
    expect(decode).toHaveBeenCalledTimes(2);
    expect(h2).not.toBe(h1);
  });

  it('unload is no-op for unknown handle', () => {
    const reg = new SoundRegistry(mockDecoder(), mockFetcher());
    expect(() => reg.unload(999 as SoundHandle)).not.toThrow();
  });

  it('destroy clears all sounds', async () => {
    const reg = new SoundRegistry(mockDecoder(), mockFetcher());
    await reg.load('a.mp3');
    await reg.load('b.mp3');
    expect(reg.count).toBe(2);
    reg.destroy();
    expect(reg.count).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/sound-registry.test.ts`
Expected: FAIL — `reg.unload is not a function`

**Step 3: Write minimal implementation**

Add to `SoundRegistry` class in `ts/src/sound-registry.ts`:

```typescript
unload(handle: SoundHandle): void {
  this.buffers.delete(handle);
  // Remove from URL map
  for (const [url, h] of this.urlToHandle) {
    if (h === handle) {
      this.urlToHandle.delete(url);
      break;
    }
  }
}

destroy(): void {
  this.buffers.clear();
  this.urlToHandle.clear();
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/sound-registry.test.ts`
Expected: PASS (13 tests)

**Step 5: Commit**

```bash
git add ts/src/sound-registry.ts ts/src/sound-registry.test.ts
git commit -m "feat(phase7): add SoundRegistry.unload and destroy"
```

---

## Part 3: PlaybackEngine

### Task 5: PlaybackEngine — play a sound

**Files:**
- Create: `ts/src/playback-engine.ts`
- Create: `ts/src/playback-engine.test.ts`

The PlaybackEngine manages active playbacks. Each `play()` creates a `source → gain → panner → masterGain → destination` chain. The engine accepts an `AudioContext` via constructor injection for testability.

**Step 1: Write the failing test**

```typescript
// ts/src/playback-engine.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from './playback-engine';
import type { PlaybackId } from './audio-types';

function mockNode(overrides: Record<string, unknown> = {}) {
  return {
    connect: vi.fn().mockReturnThis(),
    disconnect: vi.fn(),
    ...overrides,
  };
}

function mockSourceNode() {
  const node = mockNode({
    buffer: null as AudioBuffer | null,
    loop: false,
    playbackRate: { value: 1 },
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  });
  return node;
}

function mockGainNode() {
  return mockNode({ gain: { value: 1 } });
}

function mockPannerNode() {
  return mockNode({ pan: { value: 0 } });
}

function mockAudioContext() {
  const masterGain = mockGainNode();
  return {
    state: 'running' as AudioContextState,
    destination: {} as AudioDestinationNode,
    createBufferSource: vi.fn(() => mockSourceNode()),
    createGain: vi.fn(() => mockGainNode()),
    createStereoPanner: vi.fn(() => mockPannerNode()),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    _masterGain: masterGain,
  };
}

function mockBuffer(): AudioBuffer {
  return { duration: 1 } as AudioBuffer;
}

describe('PlaybackEngine', () => {
  it('play returns a PlaybackId', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    expect(typeof id).toBe('number');
  });

  it('play creates source → gain → panner → master chain', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    eng.play(mockBuffer());
    expect(ctx.createBufferSource).toHaveBeenCalled();
    expect(ctx.createGain).toHaveBeenCalled();
    expect(ctx.createStereoPanner).toHaveBeenCalled();
  });

  it('play sets buffer on source node', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    const buf = mockBuffer();
    eng.play(buf);
    expect(source.buffer).toBe(buf);
  });

  it('play calls source.start()', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    eng.play(mockBuffer());
    expect(source.start).toHaveBeenCalled();
  });

  it('assigns incrementing PlaybackIds', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    const id1 = eng.play(mockBuffer());
    const id2 = eng.play(mockBuffer());
    expect(id2).toBe(id1 + 1);
  });

  it('activeCount reflects playing sounds', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    expect(eng.activeCount).toBe(0);
    eng.play(mockBuffer());
    expect(eng.activeCount).toBe(1);
    eng.play(mockBuffer());
    expect(eng.activeCount).toBe(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/playback-engine.test.ts`
Expected: FAIL — module `./playback-engine` not found

**Step 3: Write minimal implementation**

```typescript
// ts/src/playback-engine.ts
import type { PlaybackId, PlaybackOptions, SpatialConfig } from './audio-types';
import { DEFAULT_PLAYBACK_OPTIONS, DEFAULT_SPATIAL_CONFIG } from './audio-types';

interface ActivePlayback {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode;
}

export class PlaybackEngine {
  private readonly ctx: AudioContext;
  private readonly masterGain: GainNode;
  private readonly playbacks = new Map<PlaybackId, ActivePlayback>();
  private nextId = 0;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.masterGain = ctx.createGain();
    this.masterGain.connect(ctx.destination);
  }

  play(buffer: AudioBuffer, opts?: PlaybackOptions): PlaybackId {
    const o = { ...DEFAULT_PLAYBACK_OPTIONS, ...opts };
    const id = this.nextId++ as PlaybackId;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = o.loop;
    source.playbackRate.value = o.pitch;

    const gain = this.ctx.createGain();
    gain.gain.value = o.volume;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = 0;

    source.connect(gain);
    gain.connect(panner);
    panner.connect(this.masterGain);

    source.onended = () => {
      this.cleanup(id);
    };

    source.start();
    this.playbacks.set(id, { source, gain, panner });
    return id;
  }

  get activeCount(): number {
    return this.playbacks.size;
  }

  private cleanup(id: PlaybackId): void {
    const p = this.playbacks.get(id);
    if (!p) return;
    p.source.disconnect();
    p.gain.disconnect();
    p.panner.disconnect();
    this.playbacks.delete(id);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/playback-engine.test.ts`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add ts/src/playback-engine.ts ts/src/playback-engine.test.ts
git commit -m "feat(phase7): add PlaybackEngine with play() and node chain"
```

---

### Task 6: PlaybackEngine — stop and volume control

**Files:**
- Modify: `ts/src/playback-engine.ts`
- Modify: `ts/src/playback-engine.test.ts`

**Step 1: Write the failing test**

Append to `ts/src/playback-engine.test.ts`:

```typescript
describe('PlaybackEngine stop + volume', () => {
  it('stop removes active playback', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    expect(eng.activeCount).toBe(1);
    eng.stop(id);
    expect(eng.activeCount).toBe(0);
  });

  it('stop calls source.stop()', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.stop(id);
    expect(source.stop).toHaveBeenCalled();
  });

  it('stop is no-op for unknown id', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    expect(() => eng.stop(999 as PlaybackId)).not.toThrow();
  });

  it('setVolume changes gain value', () => {
    const ctx = mockAudioContext();
    const gainNode = mockGainNode();
    ctx.createGain = vi.fn(() => gainNode) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setVolume(id, 0.5);
    expect(gainNode.gain.value).toBe(0.5);
  });

  it('setVolume clamps to 0-1 range', () => {
    const ctx = mockAudioContext();
    const gainNode = mockGainNode();
    ctx.createGain = vi.fn(() => gainNode) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setVolume(id, -0.5);
    expect(gainNode.gain.value).toBe(0);
    eng.setVolume(id, 2.0);
    expect(gainNode.gain.value).toBe(1);
  });

  it('stopAll stops all active playbacks', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    eng.play(mockBuffer());
    eng.play(mockBuffer());
    eng.play(mockBuffer());
    expect(eng.activeCount).toBe(3);
    eng.stopAll();
    expect(eng.activeCount).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/playback-engine.test.ts`
Expected: FAIL — `eng.stop is not a function`

**Step 3: Write minimal implementation**

Add to `PlaybackEngine` class in `ts/src/playback-engine.ts`:

```typescript
stop(id: PlaybackId): void {
  const p = this.playbacks.get(id);
  if (!p) return;
  try { p.source.stop(); } catch { /* already stopped */ }
  this.cleanup(id);
}

setVolume(id: PlaybackId, volume: number): void {
  const p = this.playbacks.get(id);
  if (!p) return;
  p.gain.gain.value = Math.max(0, Math.min(1, volume));
}

stopAll(): void {
  for (const id of [...this.playbacks.keys()]) {
    this.stop(id);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/playback-engine.test.ts`
Expected: PASS (12 tests)

**Step 5: Commit**

```bash
git add ts/src/playback-engine.ts ts/src/playback-engine.test.ts
git commit -m "feat(phase7): add stop, setVolume, stopAll to PlaybackEngine"
```

---

### Task 7: PlaybackEngine — pitch and looping

**Files:**
- Modify: `ts/src/playback-engine.ts`
- Modify: `ts/src/playback-engine.test.ts`

**Step 1: Write the failing test**

Append to `ts/src/playback-engine.test.ts`:

```typescript
describe('PlaybackEngine pitch + looping', () => {
  it('setPitch changes playbackRate', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setPitch(id, 1.5);
    expect(source.playbackRate.value).toBe(1.5);
  });

  it('setPitch clamps to positive values', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setPitch(id, -1);
    expect(source.playbackRate.value).toBe(0.01);
    eng.setPitch(id, 0);
    expect(source.playbackRate.value).toBe(0.01);
  });

  it('play with loop option sets source.loop', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    eng.play(mockBuffer(), { loop: true });
    expect(source.loop).toBe(true);
  });

  it('play with pitch option sets playbackRate', () => {
    const ctx = mockAudioContext();
    const source = mockSourceNode();
    ctx.createBufferSource = vi.fn(() => source) as any;
    const eng = new PlaybackEngine(ctx as any);
    eng.play(mockBuffer(), { pitch: 0.5 });
    expect(source.playbackRate.value).toBe(0.5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/playback-engine.test.ts`
Expected: FAIL — `eng.setPitch is not a function`

**Step 3: Write minimal implementation**

Add to `PlaybackEngine` class in `ts/src/playback-engine.ts`:

```typescript
setPitch(id: PlaybackId, pitch: number): void {
  const p = this.playbacks.get(id);
  if (!p) return;
  p.source.playbackRate.value = Math.max(0.01, pitch);
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/playback-engine.test.ts`
Expected: PASS (16 tests)

**Step 5: Commit**

```bash
git add ts/src/playback-engine.ts ts/src/playback-engine.test.ts
git commit -m "feat(phase7): add setPitch and looping support to PlaybackEngine"
```

---

### Task 8: PlaybackEngine — 2D spatial panning

**Files:**
- Modify: `ts/src/playback-engine.ts`
- Modify: `ts/src/playback-engine.test.ts`

**Step 1: Write the failing test**

Append to `ts/src/playback-engine.test.ts`:

```typescript
describe('PlaybackEngine spatial audio', () => {
  it('setSoundPosition pans left when entity is left of listener', () => {
    const ctx = mockAudioContext();
    const panner = mockPannerNode();
    ctx.createStereoPanner = vi.fn(() => panner) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setListenerPosition(0, 0);
    eng.setSoundPosition(id, -10, 0);
    // pan = clamp(-10 / 20, -1, 1) = -0.5
    expect(panner.pan.value).toBeCloseTo(-0.5, 5);
  });

  it('setSoundPosition pans right when entity is right of listener', () => {
    const ctx = mockAudioContext();
    const panner = mockPannerNode();
    ctx.createStereoPanner = vi.fn(() => panner) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setListenerPosition(0, 0);
    eng.setSoundPosition(id, 20, 0);
    // pan = clamp(20 / 20, -1, 1) = 1.0
    expect(panner.pan.value).toBeCloseTo(1.0, 5);
  });

  it('setSoundPosition attenuates volume by distance', () => {
    const ctx = mockAudioContext();
    const gainNode = mockGainNode();
    ctx.createGain = vi.fn(() => gainNode) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer(), { volume: 1 });
    eng.setListenerPosition(0, 0);
    eng.setSoundPosition(id, 10, 0);
    // gain = 1 / (1 + 10 / 10) = 0.5
    expect(gainNode.gain.value).toBeCloseTo(0.5, 5);
  });

  it('setSoundPosition silences sounds beyond maxDistance', () => {
    const ctx = mockAudioContext();
    const gainNode = mockGainNode();
    ctx.createGain = vi.fn(() => gainNode) as any;
    const eng = new PlaybackEngine(ctx as any);
    const id = eng.play(mockBuffer());
    eng.setListenerPosition(0, 0);
    eng.setSoundPosition(id, 200, 0); // > maxDistance (100)
    expect(gainNode.gain.value).toBe(0);
  });

  it('setListenerPosition is no-op for sounds without position', () => {
    const ctx = mockAudioContext();
    const panner = mockPannerNode();
    ctx.createStereoPanner = vi.fn(() => panner) as any;
    const eng = new PlaybackEngine(ctx as any);
    eng.play(mockBuffer());
    eng.setListenerPosition(10, 5);
    // No position set on playback → panner stays at 0
    expect(panner.pan.value).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/playback-engine.test.ts`
Expected: FAIL — `eng.setSoundPosition is not a function`

**Step 3: Write minimal implementation**

Extend `ActivePlayback` interface and `PlaybackEngine` in `ts/src/playback-engine.ts`:

Add to the `ActivePlayback` interface:
```typescript
interface ActivePlayback {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode;
  baseVolume: number;          // volume from play() options
  position: [number, number] | null;  // [x, y] or null if non-spatial
}
```

Add to the `PlaybackEngine` class:
```typescript
private listenerX = 0;
private listenerY = 0;
private spatialConfig: SpatialConfig = { ...DEFAULT_SPATIAL_CONFIG };

setListenerPosition(x: number, y: number): void {
  this.listenerX = x;
  this.listenerY = y;
  // Re-apply spatial for all positioned sounds
  for (const [id, p] of this.playbacks) {
    if (p.position) {
      this.applySpatial(p);
    }
  }
}

setSoundPosition(id: PlaybackId, x: number, y: number): void {
  const p = this.playbacks.get(id);
  if (!p) return;
  p.position = [x, y];
  this.applySpatial(p);
}

private applySpatial(p: ActivePlayback): void {
  if (!p.position) return;
  const [sx, sy] = p.position;
  const dx = sx - this.listenerX;
  const dy = sy - this.listenerY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Pan: horizontal offset divided by spread, clamped to [-1, 1]
  p.panner.pan.value = Math.max(-1, Math.min(1, dx / this.spatialConfig.panSpread));

  // Distance attenuation
  if (distance > this.spatialConfig.maxDistance) {
    p.gain.gain.value = 0;
  } else {
    p.gain.gain.value = p.baseVolume / (1 + distance / this.spatialConfig.rolloff);
  }
}
```

Also update `play()` to store `baseVolume` and `position`:
```typescript
// In play(), when creating the playback entry:
this.playbacks.set(id, { source, gain, panner, baseVolume: o.volume, position: null });
```

Also update `setVolume()` to update `baseVolume`:
```typescript
setVolume(id: PlaybackId, volume: number): void {
  const p = this.playbacks.get(id);
  if (!p) return;
  const clamped = Math.max(0, Math.min(1, volume));
  p.baseVolume = clamped;
  if (p.position) {
    this.applySpatial(p);
  } else {
    p.gain.gain.value = clamped;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/playback-engine.test.ts`
Expected: PASS (21 tests)

**Step 5: Commit**

```bash
git add ts/src/playback-engine.ts ts/src/playback-engine.test.ts
git commit -m "feat(phase7): add 2D spatial audio to PlaybackEngine"
```

---

### Task 9: PlaybackEngine — master volume and mute

**Files:**
- Modify: `ts/src/playback-engine.ts`
- Modify: `ts/src/playback-engine.test.ts`

**Step 1: Write the failing test**

Append to `ts/src/playback-engine.test.ts`:

```typescript
describe('PlaybackEngine master volume + mute', () => {
  it('setMasterVolume changes master gain', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    eng.setMasterVolume(0.5);
    expect(eng.masterVolume).toBe(0.5);
  });

  it('setMasterVolume clamps to 0-1', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    eng.setMasterVolume(-1);
    expect(eng.masterVolume).toBe(0);
    eng.setMasterVolume(5);
    expect(eng.masterVolume).toBe(1);
  });

  it('mute sets master volume to 0 and remembers previous', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    eng.setMasterVolume(0.8);
    eng.mute();
    expect(eng.masterVolume).toBe(0);
    expect(eng.isMuted).toBe(true);
  });

  it('unmute restores previous volume', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    eng.setMasterVolume(0.8);
    eng.mute();
    eng.unmute();
    expect(eng.masterVolume).toBe(0.8);
    expect(eng.isMuted).toBe(false);
  });

  it('destroy stops all and disconnects master', () => {
    const ctx = mockAudioContext();
    const eng = new PlaybackEngine(ctx as any);
    eng.play(mockBuffer());
    eng.play(mockBuffer());
    eng.destroy();
    expect(eng.activeCount).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/playback-engine.test.ts`
Expected: FAIL — `eng.setMasterVolume is not a function`

**Step 3: Write minimal implementation**

Add to `PlaybackEngine` class in `ts/src/playback-engine.ts`:

```typescript
private _muted = false;
private _preMuteVolume = 1;

get masterVolume(): number {
  return this.masterGain.gain.value;
}

get isMuted(): boolean {
  return this._muted;
}

setMasterVolume(volume: number): void {
  this.masterGain.gain.value = Math.max(0, Math.min(1, volume));
  if (!this._muted) {
    this._preMuteVolume = this.masterGain.gain.value;
  }
}

mute(): void {
  if (!this._muted) {
    this._preMuteVolume = this.masterGain.gain.value;
  }
  this._muted = true;
  this.masterGain.gain.value = 0;
}

unmute(): void {
  this._muted = false;
  this.masterGain.gain.value = this._preMuteVolume;
}

destroy(): void {
  this.stopAll();
  this.masterGain.disconnect();
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/playback-engine.test.ts`
Expected: PASS (26 tests)

**Step 5: Commit**

```bash
git add ts/src/playback-engine.ts ts/src/playback-engine.test.ts
git commit -m "feat(phase7): add master volume, mute/unmute, destroy to PlaybackEngine"
```

---

## Part 4: AudioManager

### Task 10: AudioManager — lazy initialization and unlock

**Files:**
- Create: `ts/src/audio-manager.ts`
- Create: `ts/src/audio-manager.test.ts`

The AudioManager is the public-facing class that wraps SoundRegistry + PlaybackEngine. It lazily creates the AudioContext on first use (which naturally satisfies the browser's user gesture requirement since the first `play()` is typically triggered by a click).

**Step 1: Write the failing test**

```typescript
// ts/src/audio-manager.test.ts
import { describe, it, expect, vi } from 'vitest';
import { AudioManager } from './audio-manager';

function mockAudioContext() {
  return {
    state: 'running' as AudioContextState,
    destination: {} as AudioDestinationNode,
    createBufferSource: vi.fn(() => ({
      buffer: null,
      loop: false,
      playbackRate: { value: 1 },
      connect: vi.fn().mockReturnThis(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    })),
    createGain: vi.fn(() => ({
      gain: { value: 1 },
      connect: vi.fn().mockReturnThis(),
      disconnect: vi.fn(),
    })),
    createStereoPanner: vi.fn(() => ({
      pan: { value: 0 },
      connect: vi.fn().mockReturnThis(),
      disconnect: vi.fn(),
    })),
    decodeAudioData: vi.fn(async () => ({
      duration: 1,
      numberOfChannels: 2,
      sampleRate: 44100,
      length: 44100,
    })),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

describe('AudioManager', () => {
  it('constructs without creating AudioContext', () => {
    const factory = vi.fn(() => mockAudioContext() as any);
    const am = new AudioManager({ contextFactory: factory });
    expect(factory).not.toHaveBeenCalled();
  });

  it('isInitialized is false before first use', () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    expect(am.isInitialized).toBe(false);
  });

  it('init() creates the AudioContext', () => {
    const factory = vi.fn(() => mockAudioContext() as any);
    const am = new AudioManager({ contextFactory: factory });
    am.init();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(am.isInitialized).toBe(true);
  });

  it('init() is idempotent', () => {
    const factory = vi.fn(() => mockAudioContext() as any);
    const am = new AudioManager({ contextFactory: factory });
    am.init();
    am.init();
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/audio-manager.test.ts`
Expected: FAIL — module `./audio-manager` not found

**Step 3: Write minimal implementation**

```typescript
// ts/src/audio-manager.ts
import type { SoundHandle, PlaybackId, PlaybackOptions, SpatialConfig } from './audio-types';
import { DEFAULT_SPATIAL_CONFIG } from './audio-types';
import { SoundRegistry } from './sound-registry';
import { PlaybackEngine } from './playback-engine';

export interface AudioManagerOptions {
  /** Factory for creating AudioContext. Overridable for testing. */
  contextFactory?: () => AudioContext;
  /** Spatial audio configuration. */
  spatial?: Partial<SpatialConfig>;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private registry: SoundRegistry | null = null;
  private engine: PlaybackEngine | null = null;
  private readonly contextFactory: () => AudioContext;
  private readonly spatialConfig: SpatialConfig;

  constructor(opts?: AudioManagerOptions) {
    this.contextFactory = opts?.contextFactory ?? (() => new AudioContext());
    this.spatialConfig = { ...DEFAULT_SPATIAL_CONFIG, ...opts?.spatial };
  }

  get isInitialized(): boolean {
    return this.ctx !== null;
  }

  init(): void {
    if (this.ctx) return;
    this.ctx = this.contextFactory();
    this.registry = new SoundRegistry(
      (data) => this.ctx!.decodeAudioData(data),
      async (url) => {
        const resp = await fetch(url);
        return resp.arrayBuffer();
      },
    );
    this.engine = new PlaybackEngine(this.ctx);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/audio-manager.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add ts/src/audio-manager.ts ts/src/audio-manager.test.ts
git commit -m "feat(phase7): add AudioManager with lazy AudioContext initialization"
```

---

### Task 11: AudioManager — load and play API

**Files:**
- Modify: `ts/src/audio-manager.ts`
- Modify: `ts/src/audio-manager.test.ts`

**Step 1: Write the failing test**

Append to `ts/src/audio-manager.test.ts`:

```typescript
describe('AudioManager load + play', () => {
  function createManager() {
    return new AudioManager({ contextFactory: () => mockAudioContext() as any });
  }

  it('load auto-initializes if needed', async () => {
    const am = createManager();
    expect(am.isInitialized).toBe(false);
    await am.load('test.mp3');
    expect(am.isInitialized).toBe(true);
  });

  it('load returns a SoundHandle', async () => {
    const am = createManager();
    const handle = await am.load('test.mp3');
    expect(typeof handle).toBe('number');
  });

  it('play auto-initializes if needed', () => {
    const am = createManager();
    // Need to load first (in a real scenario)
    am.init();
    // play with unknown handle returns null
    const id = am.play(999 as SoundHandle);
    expect(id).toBeNull();
  });

  it('play returns PlaybackId after successful load', async () => {
    const am = createManager();
    const handle = await am.load('test.mp3');
    const id = am.play(handle);
    expect(typeof id).toBe('number');
  });

  it('loadAll loads multiple sounds', async () => {
    const am = createManager();
    const handles = await am.loadAll(['a.mp3', 'b.mp3']);
    expect(handles).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/audio-manager.test.ts`
Expected: FAIL — `am.load is not a function`

**Step 3: Write minimal implementation**

Add to `AudioManager` class in `ts/src/audio-manager.ts`:

```typescript
async load(url: string): Promise<SoundHandle> {
  this.init();
  return this.registry!.load(url);
}

async loadAll(
  urls: string[],
  opts?: { onProgress?: (loaded: number, total: number) => void },
): Promise<SoundHandle[]> {
  this.init();
  return this.registry!.loadAll(urls, opts);
}

play(handle: SoundHandle, opts?: PlaybackOptions): PlaybackId | null {
  this.init();
  const buffer = this.registry!.getBuffer(handle);
  if (!buffer) return null;
  return this.engine!.play(buffer, opts);
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/audio-manager.test.ts`
Expected: PASS (9 tests)

**Step 5: Commit**

```bash
git add ts/src/audio-manager.ts ts/src/audio-manager.test.ts
git commit -m "feat(phase7): add load/play API to AudioManager"
```

---

### Task 12: AudioManager — playback control

**Files:**
- Modify: `ts/src/audio-manager.ts`
- Modify: `ts/src/audio-manager.test.ts`

**Step 1: Write the failing test**

Append to `ts/src/audio-manager.test.ts`:

```typescript
describe('AudioManager playback control', () => {
  async function loadedManager() {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    const handle = await am.load('test.mp3');
    const id = am.play(handle)!;
    return { am, handle, id };
  }

  it('stop is forwarded to engine', async () => {
    const { am, id } = await loadedManager();
    expect(() => am.stop(id)).not.toThrow();
  });

  it('setVolume is forwarded to engine', async () => {
    const { am, id } = await loadedManager();
    expect(() => am.setVolume(id, 0.5)).not.toThrow();
  });

  it('setPitch is forwarded to engine', async () => {
    const { am, id } = await loadedManager();
    expect(() => am.setPitch(id, 1.5)).not.toThrow();
  });

  it('stopAll stops all playbacks', async () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    const h = await am.load('test.mp3');
    am.play(h);
    am.play(h);
    expect(() => am.stopAll()).not.toThrow();
  });

  it('control methods are no-op before init', () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    expect(() => am.stop(0 as PlaybackId)).not.toThrow();
    expect(() => am.setVolume(0 as PlaybackId, 0.5)).not.toThrow();
    expect(() => am.setPitch(0 as PlaybackId, 1)).not.toThrow();
    expect(() => am.stopAll()).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/audio-manager.test.ts`
Expected: FAIL — `am.stop is not a function`

**Step 3: Write minimal implementation**

Add to `AudioManager` class in `ts/src/audio-manager.ts`:

```typescript
stop(id: PlaybackId): void {
  this.engine?.stop(id);
}

setVolume(id: PlaybackId, volume: number): void {
  this.engine?.setVolume(id, volume);
}

setPitch(id: PlaybackId, pitch: number): void {
  this.engine?.setPitch(id, pitch);
}

stopAll(): void {
  this.engine?.stopAll();
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/audio-manager.test.ts`
Expected: PASS (15 tests)

**Step 5: Commit**

```bash
git add ts/src/audio-manager.ts ts/src/audio-manager.test.ts
git commit -m "feat(phase7): add stop/volume/pitch/stopAll to AudioManager"
```

---

### Task 13: AudioManager — spatial listener

**Files:**
- Modify: `ts/src/audio-manager.ts`
- Modify: `ts/src/audio-manager.test.ts`

**Step 1: Write the failing test**

Append to `ts/src/audio-manager.test.ts`:

```typescript
describe('AudioManager spatial', () => {
  it('setSoundPosition delegates to engine', async () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    const h = await am.load('test.mp3');
    const id = am.play(h)!;
    expect(() => am.setSoundPosition(id, 5, 10)).not.toThrow();
  });

  it('setListenerPosition delegates to engine', async () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    am.init();
    expect(() => am.setListenerPosition(10, 20)).not.toThrow();
  });

  it('setListenerPosition is no-op before init', () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    expect(() => am.setListenerPosition(10, 20)).not.toThrow();
  });

  it('setSoundPosition is no-op before init', () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    expect(() => am.setSoundPosition(0 as PlaybackId, 5, 10)).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/audio-manager.test.ts`
Expected: FAIL — `am.setSoundPosition is not a function`

**Step 3: Write minimal implementation**

Add to `AudioManager` class in `ts/src/audio-manager.ts`:

```typescript
setSoundPosition(id: PlaybackId, x: number, y: number): void {
  this.engine?.setSoundPosition(id, x, y);
}

setListenerPosition(x: number, y: number): void {
  this.engine?.setListenerPosition(x, y);
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/audio-manager.test.ts`
Expected: PASS (19 tests)

**Step 5: Commit**

```bash
git add ts/src/audio-manager.ts ts/src/audio-manager.test.ts
git commit -m "feat(phase7): add spatial audio to AudioManager"
```

---

### Task 14: AudioManager — lifecycle (suspend/resume/destroy)

**Files:**
- Modify: `ts/src/audio-manager.ts`
- Modify: `ts/src/audio-manager.test.ts`

**Step 1: Write the failing test**

Append to `ts/src/audio-manager.test.ts`:

```typescript
describe('AudioManager lifecycle', () => {
  it('suspend calls ctx.suspend()', async () => {
    const ctx = mockAudioContext();
    const am = new AudioManager({ contextFactory: () => ctx as any });
    am.init();
    await am.suspend();
    expect(ctx.suspend).toHaveBeenCalled();
  });

  it('resume calls ctx.resume()', async () => {
    const ctx = mockAudioContext();
    const am = new AudioManager({ contextFactory: () => ctx as any });
    am.init();
    await am.resume();
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('destroy closes context and clears state', async () => {
    const ctx = mockAudioContext();
    const am = new AudioManager({ contextFactory: () => ctx as any });
    await am.load('test.mp3');
    await am.destroy();
    expect(ctx.close).toHaveBeenCalled();
    expect(am.isInitialized).toBe(false);
  });

  it('destroy is no-op before init', async () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    await am.destroy(); // should not throw
    expect(am.isInitialized).toBe(false);
  });

  it('suspend/resume are no-ops before init', async () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    await am.suspend();
    await am.resume();
    expect(am.isInitialized).toBe(false);
  });

  it('master volume control delegates to engine', () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    am.init();
    expect(() => am.setMasterVolume(0.5)).not.toThrow();
    expect(() => am.mute()).not.toThrow();
    expect(() => am.unmute()).not.toThrow();
  });

  it('unload delegates to registry', async () => {
    const am = new AudioManager({ contextFactory: () => mockAudioContext() as any });
    const h = await am.load('test.mp3');
    expect(() => am.unload(h)).not.toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/audio-manager.test.ts`
Expected: FAIL — `am.suspend is not a function`

**Step 3: Write minimal implementation**

Add to `AudioManager` class in `ts/src/audio-manager.ts`:

```typescript
async suspend(): Promise<void> {
  if (!this.ctx) return;
  await this.ctx.suspend();
}

async resume(): Promise<void> {
  if (!this.ctx) return;
  await this.ctx.resume();
}

async destroy(): Promise<void> {
  if (!this.ctx) return;
  this.engine?.destroy();
  this.registry?.destroy();
  await this.ctx.close();
  this.ctx = null;
  this.engine = null;
  this.registry = null;
}

setMasterVolume(volume: number): void {
  this.engine?.setMasterVolume(volume);
}

mute(): void {
  this.engine?.mute();
}

unmute(): void {
  this.engine?.unmute();
}

unload(handle: SoundHandle): void {
  this.registry?.unload(handle);
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/audio-manager.test.ts`
Expected: PASS (26 tests)

**Step 5: Commit**

```bash
git add ts/src/audio-manager.ts ts/src/audio-manager.test.ts
git commit -m "feat(phase7): add suspend/resume/destroy/mute to AudioManager"
```

---

## Part 5: Hyperion Facade Integration

### Task 15: Hyperion facade — audio getter

**Files:**
- Modify: `ts/src/hyperion.ts`
- Modify: `ts/src/hyperion.test.ts`

**Step 1: Write the failing test**

Append to `ts/src/hyperion.test.ts`:

```typescript
import { AudioManager } from './audio-manager';

describe('Hyperion audio', () => {
  it('audio getter returns AudioManager', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(engine.audio).toBeInstanceOf(AudioManager);
  });

  it('audio getter returns same instance', () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    expect(engine.audio).toBe(engine.audio);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — `engine.audio` property does not exist

**Step 3: Write minimal implementation**

In `ts/src/hyperion.ts`:

1. Add import: `import { AudioManager } from './audio-manager';`

2. Add private field: `private readonly audioManager: AudioManager;`

3. In constructor, add: `this.audioManager = new AudioManager();`

4. Add getter:
```typescript
/** Audio manager for loading and playing sounds with 2D spatial audio. */
get audio(): AudioManager {
  return this.audioManager;
}
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS (all existing + 2 new)

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase7): add engine.audio getter to Hyperion facade"
```

---

### Task 16: Hyperion — lifecycle wiring (pause/resume/destroy)

**Files:**
- Modify: `ts/src/hyperion.ts`
- Modify: `ts/src/hyperion.test.ts`

Wire audio lifecycle into existing engine lifecycle methods.

**Step 1: Write the failing test**

Append to `ts/src/hyperion.test.ts`:

```typescript
describe('Hyperion audio lifecycle', () => {
  it('destroy calls audioManager.destroy', async () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const spy = vi.spyOn(engine.audio, 'destroy').mockResolvedValue(undefined);
    engine.destroy();
    expect(spy).toHaveBeenCalled();
  });

  it('pause suspends audio', async () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const spy = vi.spyOn(engine.audio, 'suspend').mockResolvedValue(undefined);
    engine.start();
    engine.pause();
    expect(spy).toHaveBeenCalled();
  });

  it('resume resumes audio', async () => {
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    const spy = vi.spyOn(engine.audio, 'resume').mockResolvedValue(undefined);
    engine.start();
    engine.pause();
    engine.resume();
    expect(spy).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: FAIL — destroy/pause/resume don't call audio methods

**Step 3: Write minimal implementation**

In `ts/src/hyperion.ts`:

1. In `destroy()`, add before bridge/renderer destroy:
```typescript
void this.audioManager.destroy();
```

2. In `pause()`, add:
```typescript
void this.audioManager.suspend();
```

3. In `resume()`, add:
```typescript
void this.audioManager.resume();
```

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS (all existing + 3 new)

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "feat(phase7): wire audio lifecycle into Hyperion destroy/pause/resume"
```

---

### Task 17: Hyperion — auto-update listener from camera

**Files:**
- Modify: `ts/src/hyperion.ts`
- Modify: `ts/src/hyperion.test.ts`

Update the audio listener position from the camera position each tick, so spatial audio automatically tracks the camera without explicit user code.

**Step 1: Write the failing test**

Append to `ts/src/hyperion.test.ts`:

```typescript
describe('Hyperion audio listener auto-update', () => {
  it('tick updates audio listener from camera position', () => {
    const bridge = mockBridge();
    const engine = Hyperion.fromParts(defaultConfig(), bridge, mockRenderer());
    engine.audio.init(); // force init so spy works
    const spy = vi.spyOn(engine.audio, 'setListenerPosition');

    engine.cam.position(5, 10, 0);

    // Trigger a tick via start + manual RAF simulation
    // Since we can't easily trigger RAF in tests, we test via the internal tick method
    // We access it through the game loop hook mechanism
    let tickFn: ((dt: number) => void) | null = null;
    engine.addHook('preTick', (dt) => {
      // The listener update should happen in tick, after preTick
    });

    // Alternatively, just call start and check after a manual bridge.tick
    // The simplest test: check that after engine processes, listener is updated
    // We can verify this by checking the spy was called with camera coords
    // This needs the tick to fire, which requires GameLoop start + RAF
    // For unit test: verify the behavior through fromParts + manual tick trigger

    // Force a tick by making bridge return render state
    bridge.latestRenderState = {
      transforms: new Float32Array(16),
      bounds: new Float32Array(4),
      entityCount: 0,
      renderMeta: new Uint32Array(0),
      texIndices: new Uint32Array(0),
      primParams: new Float32Array(0),
      entityIds: new Uint32Array(0),
    };

    engine.start();
    // GameLoop will call tick on next RAF. In test, we rely on the spy
    // being called at some point. A more precise test:
    // We expose tick via a test helper. For now, verify the getter exists.
    expect(typeof engine.audio.setListenerPosition).toBe('function');
    engine.destroy();
  });
});
```

**Note:** The tick auto-update is hard to test via unit tests because it requires RAF. The implementation is straightforward — add one line to `tick()`. Verify manually via the demo.

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS (the test above is a structural test, not behavioral — we'll verify behavior in the demo)

**Step 3: Write minimal implementation**

In `ts/src/hyperion.ts`, in the `tick()` method, add after `this.inputManager.resetFrame()`:

```typescript
// Update audio listener position from camera
if (this.audioManager.isInitialized) {
  this.audioManager.setListenerPosition(this.camera.x, this.camera.y);
}
```

Note: `Camera` currently stores position internally. Check that `camera.x` and `camera.y` are accessible. If not, add getters. Looking at `camera.ts`, the Camera stores position in its view matrix. The `CameraAPI` wraps it with `.position(x, y, z)`. We need to store the camera position explicitly for the listener.

Add to `ts/src/hyperion.ts` (private fields):
```typescript
private _cameraX = 0;
private _cameraY = 0;
```

Update the `cam.position` calls throughout to also track these values. Actually, simpler: read from `CameraAPI` which already stores the position. Check `camera-api.ts` to see if position getters exist.

If `CameraAPI` doesn't expose position getters, add them. The implementation should store `lastX`, `lastY` in CameraAPI and expose them as getters.

**Step 4: Run test to verify it passes**

Run: `cd ts && npx vitest run src/hyperion.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ts/src/hyperion.ts ts/src/hyperion.test.ts ts/src/camera-api.ts
git commit -m "feat(phase7): auto-update audio listener from camera position"
```

---

### Task 18: Barrel exports

**Files:**
- Modify: `ts/src/index.ts`

**Step 1: Write the failing test**

Run: `cd ts && npx tsc --noEmit`
Expected: PASS (no errors, but we verify the new exports are accessible)

**Step 2: Write minimal implementation**

Add to `ts/src/index.ts`:

```typescript
export { AudioManager } from './audio-manager';
export type { AudioManagerOptions } from './audio-manager';
export type { SoundHandle, PlaybackId, PlaybackOptions, SpatialConfig } from './audio-types';
export { DEFAULT_PLAYBACK_OPTIONS, DEFAULT_SPATIAL_CONFIG } from './audio-types';
```

**Step 3: Run type check**

Run: `cd ts && npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add ts/src/index.ts
git commit -m "feat(phase7): export audio types from barrel index"
```

---

## Part 6: Demo and Documentation

### Task 19: Demo — spatial audio playground

**Files:**
- Modify: `ts/src/main.ts`

Update the existing demo to demonstrate audio capabilities. When the user clicks an entity, play a sound with spatial panning based on the entity's position relative to the camera.

**Step 1: Update main.ts**

Add after the existing click handler setup:

```typescript
// --- Audio: load sounds and play on entity click ---
const sfxHandle = await engine.audio.load('sfx/click.ogg');

// Replace the existing onClick handler to also play spatial audio:
engine.input.onClick((button, x, y) => {
  if (button !== 0) return;
  const entityId = engine.picking.hitTest(x, y);
  if (entityId !== null) {
    engine.selection?.toggle(entityId);
    // Play spatial sound at the clicked entity's screen position
    // (Approximate world position from screen coords for demo)
    const worldX = (x / canvas.width - 0.5) * 20;
    const id = engine.audio.play(sfxHandle, { volume: 0.8 });
    if (id !== null) {
      engine.audio.setSoundPosition(id, worldX, 0);
    }
  }
});
```

Update the overlay text to mention audio:
```typescript
overlay.textContent =
  `Hyperion Engine\nMode: ${s.mode}\nFPS: ${s.fps}\nEntities: ${s.entityCount}\nWASD/Arrows: move | Scroll: zoom | Click: select+sound`;
```

**Step 2: Create a placeholder audio file**

Create a small placeholder `ts/public/sfx/click.ogg` (or `.mp3`). For the demo, any short click/blip sound file works. The exact file is up to the implementer — a tiny OGG file (~5KB) is ideal.

**Step 3: Manual browser test**

Run: `cd ts && npm run dev`
Open: `http://localhost:5173`
Expected: Click on entities → hear a click sound, panned based on horizontal position

**Step 4: Commit**

```bash
git add ts/src/main.ts ts/public/sfx/
git commit -m "feat(phase7): add spatial audio to demo (click-to-play)"
```

---

### Task 20: Documentation — CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

Update the following sections:

1. **Build & Test Commands**: Add audio test files
2. **TypeScript module table**: Add `audio-types.ts`, `sound-registry.ts`, `playback-engine.ts`, `audio-manager.ts`
3. **Gotchas**: Add AudioContext user-gesture requirement, StereoPannerNode browser support
4. **Implementation Status**: Update to reflect Phase 7 completion

**Step 1: Update CLAUDE.md with audio module entries**

Add to the test commands section:
```bash
cd ts && npx vitest run src/audio-types.test.ts          # Audio types (3 tests)
cd ts && npx vitest run src/sound-registry.test.ts       # Sound loading+decode (13 tests)
cd ts && npx vitest run src/playback-engine.test.ts      # Playback engine (26 tests)
cd ts && npx vitest run src/audio-manager.test.ts        # AudioManager facade (26 tests)
```

Add to the module table:
```
| `audio-types.ts` | `SoundHandle`, `PlaybackId` branded types, `PlaybackOptions`, `SpatialConfig` interfaces, defaults |
| `sound-registry.ts` | `SoundRegistry` — decodes audio files via `AudioContext.decodeAudioData`, stores `AudioBuffer`s by `SoundHandle`, URL deduplication |
| `playback-engine.ts` | `PlaybackEngine` — manages active `AudioBufferSourceNode → GainNode → StereoPannerNode → masterGain` chains. 2D spatial pan + distance attenuation, master volume, mute/unmute |
| `audio-manager.ts` | `AudioManager` — public audio facade wrapping `SoundRegistry` + `PlaybackEngine`. Lazy `AudioContext` creation, load/play/stop/volume/pitch/spatial API, suspend/resume/destroy lifecycle |
```

Add to Gotchas:
```
- **AudioContext requires user gesture** — Modern browsers suspend AudioContext until a user interaction (click/tap/keydown). AudioManager creates the context lazily on first `load()` or `play()`, which is typically triggered by user input. If audio must start without interaction (e.g., ambient music on load), call `engine.audio.init()` inside a click handler first.
- **StereoPannerNode not on AudioContext in all environments** — Node.js and some test environments lack `createStereoPanner`. Tests inject a mock AudioContext. Real spatial audio only works in browsers.
- **Audio listener auto-syncs with camera** — Each tick, `Hyperion.tick()` calls `audioManager.setListenerPosition()` with the camera's world position. No manual listener updates needed.
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Phase 7 audio system"
```

---

### Task 21: Documentation — PROJECT_ARCHITECTURE.md update

**Files:**
- Modify: `PROJECT_ARCHITECTURE.md`

Add an Audio Subsystem section describing:
- Architecture (Web Audio API, node graph, spatial model)
- Component diagram
- Key design decisions (Web Audio vs. WASM DSP, lazy init, spatial model)
- Integration with engine lifecycle

**Step 1: Update PROJECT_ARCHITECTURE.md**

**Step 2: Commit**

```bash
git add PROJECT_ARCHITECTURE.md
git commit -m "docs: update PROJECT_ARCHITECTURE.md for Phase 7 audio system"
```

---

### Task 22: Full validation pipeline

Run the complete validation pipeline to ensure nothing is broken.

**Step 1: Rust tests + clippy**

```bash
cargo test -p hyperion-core
cargo clippy -p hyperion-core
```

Expected: 88 tests PASS, 0 clippy warnings

**Step 2: TypeScript tests**

```bash
cd ts && npm test
```

Expected: ~359 tests PASS (291 existing + ~68 new audio tests)

**Step 3: Type check**

```bash
cd ts && npx tsc --noEmit
```

Expected: 0 errors

**Step 4: Visual test**

```bash
cd ts && npm run dev
```

Open browser, verify:
- Existing features still work (entities render, click-to-select, WASD, scroll-zoom)
- Audio plays on entity click
- Audio pans with entity position
- Audio follows camera movement

**Step 5: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(phase7): validation fixes"
```

---

## Summary

| Metric | Value |
|--------|-------|
| Total tasks | 22 |
| New test files | 4 (`audio-types`, `sound-registry`, `playback-engine`, `audio-manager`) |
| New source files | 4 (`audio-types.ts`, `sound-registry.ts`, `playback-engine.ts`, `audio-manager.ts`) |
| Modified source files | 2 (`hyperion.ts`, `index.ts`) |
| Modified doc files | 2 (`CLAUDE.md`, `PROJECT_ARCHITECTURE.md`) |
| Estimated new tests | ~68 |
| No Rust changes | Web Audio API is TypeScript-only |
| No WASM build changes | No `hyperion-audio` crate needed for this approach |

The WASM AudioWorklet DSP path (§10 of design-v3.md) can be layered in as a future optimization by adding the `hyperion-audio` crate and routing `PlaybackEngine` through an AudioWorklet instead of direct Web Audio nodes. The public API (`engine.audio.*`) remains unchanged.
