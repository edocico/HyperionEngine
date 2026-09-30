// ts/src/demo/probe-checks.ts — pixel checks for the harness, on engine.debug.probe.
//
// Values are what the GPU drew: linear HDR for scene-hdr / light-buffer, the
// displayed 0-1 value for the swapchain. Static colours are checked as
// absolute values with a tolerance, light and shadow as ratios between points
// of ONE read (animated lights move between reads).

import type { Hyperion } from '../hyperion';
import type { ProbeTarget, TransformsProbeResult } from '../render/debug-probe';
import type { TestReporter } from './types';
import type { TransparentSortReadback } from '../render/transparent-sort-probe';

export type Rgba = [number, number, number, number];
export type Probe = (target: ProbeTarget, world: [number, number][], layer?: number) => Promise<Rgba[]>;
/** `engine.debug.readEntityTransforms()`, under the same timeout and skip rule as `Probe`. */
export type ReadTransforms = () => Promise<TransformsProbeResult>;
/** `engine.debug.readTransparentSort()`, under the same timeout and skip rule as `Probe`. */
export type ReadSort = () => Promise<TransparentSortReadback>;

/**
 * A probe is served by the next rendered frame. When none comes (the loop is
 * stuck, or nothing renders) the check fails after this long, instead of
 * hanging the section's setup — and with it every later tab switch.
 */
export const PROBE_TIMEOUT_MS = 3000;

/** Probe rejections that mean "no probe here", not "wrong pixels". */
const UNAVAILABLE = /main-thread renderer|DebugProbe destroyed|TransparentSortProbe destroyed/;

/**
 * What `Hyperion.enableBloom`, `enableOutlines` and `loadTexture` throw without
 * a main-thread renderer (Mode A): an environment limit wherever it surfaces.
 */
const NO_RENDERER = /no renderer available/;

class ProbeUnavailable extends Error {}

/**
 * Runs one pixel check: `check` reads pixels with the given probe (or GPU rows
 * with `readTransforms`, the transparent sort with `readSort`) and returns the
 * verdict. Where the probe does not exist (Mode A, no renderer, a production
 * build) the check is skipped with the reason, never failed. So is a check that
 * reaches for the renderer itself before its first probe (the Bloom check turns
 * the bloom graph on) and gets "no renderer available" from the engine.
 */
export async function pixelCheck(
  reporter: TestReporter,
  name: string,
  engine: Hyperion,
  check: (probe: Probe, readTransforms: ReadTransforms, readSort: ReadSort) => Promise<{ ok: boolean; detail: string }>,
): Promise<void> {
  const debug = engine.debug;
  if (!debug) {
    reporter.skip(name, 'pixel probe unavailable: production build');
    return;
  }
  const guarded = async <T>(request: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no frame served the probe within ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([request, timeout]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw UNAVAILABLE.test(msg) ? new ProbeUnavailable(msg) : err;
    } finally {
      clearTimeout(timer);
    }
  };
  const probe: Probe = async (target, world, layer) => (await guarded(debug.probe({ target, world, layer }))).values;
  const readTransforms: ReadTransforms = () => guarded(debug.readEntityTransforms());
  const readSort: ReadSort = () => guarded(debug.readTransparentSort());
  try {
    const { ok, detail } = await check(probe, readTransforms, readSort);
    reporter.check(name, ok, detail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof ProbeUnavailable) reporter.skip(name, `pixel probe unavailable: ${msg}`);
    else if (NO_RENDERER.test(msg)) reporter.skip(name, `no renderer: ${msg}`);
    else reporter.check(name, false, `probe error: ${msg}`);
  }
}

/**
 * Reports check `name` after its test texture `url` failed to load. Only a
 * missing main-thread renderer (Mode A) is an environment limit, a skip; any
 * other error (a missing or undecodable file, a full tier) is a broken build:
 * a failure with the error text.
 */
export function reportTextureLoadFailure(reporter: TestReporter, name: string, url: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (NO_RENDERER.test(msg)) reporter.skip(name, `no main-thread renderer: ${msg}`);
  else reporter.check(name, false, `cannot load ${url}: ${msg}`);
}

export function near(value: number, want: number, tolerance: number): boolean {
  return Math.abs(value - want) <= tolerance;
}

/** Rec. 709 luminance, as the tonemappers weigh a colour. */
export function luminance([r, g, b]: Rgba): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Three decimals, for check details. */
export function fmt(values: number[]): string {
  return values.map((v) => v.toFixed(3)).join(', ');
}

/**
 * Centres the camera on (cx, cy) and zooms out — never in — until `halfWidth`
 * world units fit on each side: the scene, and so every probe point, stays in
 * view at any canvas aspect (a narrow window used to push probes off the target).
 */
export function fitView(engine: Hyperion, cx: number, cy: number, halfWidth: number): void {
  engine.cam.position(cx, cy, 0);
  engine.cam.zoom(1);
  const visibleHalfWidth = 1 / engine.cam.viewProjection[0];
  engine.cam.zoom(Math.min(1, visibleHalfWidth / halfWidth));
}

/** Waits `n` animation frames: what was just spawned reaches the GPU (Mode B lags one or two). */
export function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
}
