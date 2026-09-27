// ts/src/demo/probe-checks.ts — pixel checks for the harness, on engine.debug.probe.
//
// Values are what the GPU drew: linear HDR for scene-hdr / light-buffer, the
// displayed 0-1 value for the swapchain. Static colours are checked as
// absolute values with a tolerance, light and shadow as ratios between points
// of ONE read (animated lights move between reads).

import type { Hyperion } from '../hyperion';
import type { ProbeTarget } from '../render/debug-probe';
import type { TestReporter } from './types';

export type Rgba = [number, number, number, number];
export type Probe = (target: ProbeTarget, world: [number, number][], layer?: number) => Promise<Rgba[]>;

/**
 * A probe is served by the next rendered frame. When none comes (the loop is
 * stuck, or nothing renders) the check fails after this long, instead of
 * hanging the section's setup — and with it every later tab switch.
 */
export const PROBE_TIMEOUT_MS = 3000;

/** Probe rejections that mean "no probe here", not "wrong pixels". */
const UNAVAILABLE = /main-thread renderer|DebugProbe destroyed/;

class ProbeUnavailable extends Error {}

/**
 * Runs one pixel check: `check` reads pixels with the given probe and returns
 * the verdict. Where the probe does not exist (Mode A, no renderer, a
 * production build) the check is skipped with the reason, never failed.
 */
export async function pixelCheck(
  reporter: TestReporter,
  name: string,
  engine: Hyperion,
  check: (probe: Probe) => Promise<{ ok: boolean; detail: string }>,
): Promise<void> {
  const debug = engine.debug;
  if (!debug) {
    reporter.skip(name, 'pixel probe unavailable: production build');
    return;
  }
  const probe: Probe = async (target, world, layer) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no frame served the probe within ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
    });
    try {
      return (await Promise.race([debug.probe({ target, world, layer }), timeout])).values;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw UNAVAILABLE.test(msg) ? new ProbeUnavailable(msg) : err;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const { ok, detail } = await check(probe);
    reporter.check(name, ok, detail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof ProbeUnavailable) reporter.skip(name, `pixel probe unavailable: ${msg}`);
    else reporter.check(name, false, `probe error: ${msg}`);
  }
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

/** Waits `n` animation frames: what was just spawned reaches the GPU (Mode B lags one or two). */
export function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
}
