/**
 * Engine-wide 2D lighting state (Phase 17).
 *
 * Individual lights are ECS entities — `engine.spawn().light({...})` — so they
 * get transforms, hierarchy, culling, snapshot and replay for free. What is
 * left over is genuinely global: which backend runs, the ambient term, and the
 * quality knobs. That is this class.
 *
 * Ambient and backend travel through the ring buffer as engine-level commands
 * (`entity_id = 0` sentinel, the same shape as the audio listener), so the
 * authoritative value lives in WASM and is read back rather than mirrored here.
 * That matters for replay: during a `ReplayPlayer` run the commands come off
 * the tape, and a TypeScript-side copy would be stale.
 */

import type { BackpressuredProducer } from './backpressure';
import type { EngineBridge } from './worker-bridge';
import { deriveLightGroups, type LightGroups } from './render/light-groups';

/** Which lighting implementation runs, or none at all. */
export type LightingBackend = 'off' | 'lit' | 'gi';

const BACKEND_IDS: Record<LightingBackend, number> = { off: 0, lit: 1, gi: 2 };
const BACKEND_NAMES: readonly LightingBackend[] = ['off', 'lit', 'gi'];

/**
 * Renderer-side quality settings.
 *
 * Unlike ambient and backend these never reach WASM: they size textures and
 * pick loop counts, which is entirely a rendering concern. They take effect on
 * the next graph rebuild.
 */
export interface LightingQuality {
  /**
   * Resolution of the light buffer and the SDF, as a fraction of the canvas.
   * Default 0.5 — Unity ships the same default and documents it as "good
   * performance with almost no noticeable artifact in most situations".
   */
  bufferScale: number;
  /**
   * Padding around the SDF so occluders just off-screen still cast into view.
   *
   * ⚠️ 1.2 does NOT cost 20% more pixels. The margin applies on both sides of
   * both axes, so the rect is 1.4x per axis — **1.96x the pixels**. Godot ships
   * 1.2 by default; Hyperion defaults to 1.0 and asks you to measure the edge
   * artifact before paying for it.
   */
  sdfOversize: number;
  /**
   * Sphere-march step budget per shadow ray. Default 48: the literature's
   * 16-32 leaks light behind walls, from rays that graze a sprite's face and
   * spend their budget 1-2 texels at a time. Most rays end long before the
   * budget, so it costs little: 24 -> 48 was +2% of light-accum on the AMD
   * iGPU (2026-09-26).
   */
  shadowSteps: number;
  /** Cascade count. Backend `gi` only. Default 6. */
  cascades: number;
  /**
   * Forbid temporal reprojection, stochastic merge and multi-frame
   * amortisation. All three break frame-to-frame determinism, and all three
   * are exactly what one would reach for under performance pressure — hence a
   * flag rather than a convention. Default true.
   */
  deterministic: boolean;
}

export const DEFAULT_LIGHTING_QUALITY: LightingQuality = {
  bufferScale: 0.5,
  sdfOversize: 1.0,
  shadowSteps: 48,
  cascades: 6,
  deterministic: true,
};

export class LightingAPI {
  private producer: BackpressuredProducer | null = null;
  private bridge: EngineBridge | null = null;
  private viewProjection: (() => Float32Array) | null = null;
  private _quality: LightingQuality = { ...DEFAULT_LIGHTING_QUALITY };
  private _qualityDirty = false;

  /**
   * @internal Wired by `Hyperion` at construction.
   * @param viewProjection the main-thread camera, for {@link groups}.
   */
  _init(producer: BackpressuredProducer, bridge: EngineBridge, viewProjection?: () => Float32Array): void {
    this.producer = producer;
    this.bridge = bridge;
    this.viewProjection = viewProjection ?? null;
  }

  /**
   * The light groups of the latest frame (light layers, design 2026-09-26):
   * which receiver layers share a light buffer, which of those share an SDF,
   * and the distinct mask values that split them. The renderer forms them
   * the same way every frame while the backend is `'lit'`.
   *
   * Every distinct SDF set costs a full SDF flood — about 1.8 ms at 1080p on
   * an integrated GPU — and there is no cap, so this is where to look when a
   * `lightLayers()` call made lighting slower. `null` before the first frame.
   * In Mode A it uses the main thread's camera, which the render worker's does
   * not follow yet: an approximation there.
   */
  get groups(): LightGroups | null {
    const rs = this.bridge?.latestRenderState;
    if (!rs || !this.viewProjection) return null;
    return deriveLightGroups({ ...rs, cameraViewProjection: this.viewProjection() });
  }

  /**
   * Select the lighting backend.
   *
   * `'off'` is not a stub: with no live pass reading `light-buffer` the whole
   * chain is removed by the RenderGraph's dead-pass culling, so lighting that
   * is switched off costs nothing rather than costing a skipped branch.
   */
  setBackend(backend: LightingBackend): void {
    const id = BACKEND_IDS[backend];
    if (id === undefined) {
      throw new Error(`Unknown lighting backend '${backend}': expected 'off', 'lit' or 'gi'`);
    }
    this.producer?.setLightingBackend(id);
  }

  /**
   * Active backend, read back from the engine.
   *
   * Reads `'off'` until the first tick after `setBackend()` — the command has
   * to travel through the ring buffer first. That lag is the price of the
   * engine being the single source of truth, and it is what makes replay work.
   */
  get backend(): LightingBackend {
    const id = this.bridge?.latestRenderState?.lightingBackend ?? 0;
    return BACKEND_NAMES[id] ?? 'off';
  }

  /**
   * Global ambient light — the light every surface receives regardless of any
   * light entity.
   *
   * It becomes the clear colour of the accumulation buffer, so unlike every
   * other light in the scene it is genuinely free: the clear happens anyway.
   *
   * @param color `'#rrggbb'`, `'#rgb'`, or `[r, g, b]` in 0-1.
   * @param intensity Multiplier applied on the GPU side. Default 1.
   */
  setAmbient(color: string | readonly [number, number, number], intensity = 1): void {
    const [r, g, b] = parseColor(color);
    if (!Number.isFinite(intensity)) {
      throw new Error(`Ambient intensity must be finite, got ${intensity}`);
    }
    this.producer?.setAmbientLight(r, g, b, intensity);
  }

  /** Ambient `[r, g, b, intensity]` as the engine currently holds it. */
  get ambient(): [number, number, number, number] {
    const rs = this.bridge?.latestRenderState;
    return [rs?.ambientR ?? 0, rs?.ambientG ?? 0, rs?.ambientB ?? 0, rs?.ambientIntensity ?? 1];
  }

  /** Merge quality settings over the current ones. Takes effect on the next graph rebuild. */
  setQuality(quality: Partial<LightingQuality>): void {
    for (const [key, value] of Object.entries(quality)) {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error(`Lighting quality '${key}' must be finite, got ${value}`);
      }
    }
    if (quality.bufferScale !== undefined && quality.bufferScale <= 0) {
      throw new Error(`bufferScale must be > 0, got ${quality.bufferScale}`);
    }
    if (quality.sdfOversize !== undefined && quality.sdfOversize < 1) {
      throw new Error(`sdfOversize must be >= 1 (1 = no padding), got ${quality.sdfOversize}`);
    }
    if (quality.shadowSteps !== undefined && quality.shadowSteps < 1) {
      throw new Error(`shadowSteps must be >= 1, got ${quality.shadowSteps}`);
    }
    this._quality = { ...this._quality, ...quality };
    this._qualityDirty = true;
  }

  /** Current quality settings. Returns a copy; mutate through `setQuality`. */
  get quality(): LightingQuality {
    return { ...this._quality };
  }

  /** @internal True once `setQuality` ran, until the renderer consumes it. */
  get _needsRebuild(): boolean {
    return this._qualityDirty;
  }

  /** @internal Called by the renderer after it has applied the settings. */
  _clearRebuildFlag(): void {
    this._qualityDirty = false;
  }
}

/**
 * `'#rgb'` / `'#rrggbb'` / `[r, g, b]` → linear 0-1 components.
 *
 * Deliberately no sRGB→linear conversion: `scene-hdr` is `rgba16float` and the
 * tonemap runs at the end of the chain, so these values are already the linear
 * radiance the accumulation buffer wants.
 */
function parseColor(c: string | readonly [number, number, number]): [number, number, number] {
  if (typeof c !== 'string') return [c[0], c[1], c[2]];
  let hex = c.startsWith('#') ? c.slice(1) : c;
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (hex.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`Invalid ambient color '${c}': expected '#rgb', '#rrggbb' or [r, g, b]`);
  }
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ];
}
