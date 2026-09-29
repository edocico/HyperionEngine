// ts/src/demo/blend-expect.ts — what the transparent pipeline's blend leaves on
// scene-hdr, in closed form, for the harness's pixel checks.
//
// The uber pipeline blends colour with (src-alpha, one-minus-src-alpha, add):
// straight alpha, "over". A layer is kept as the affine map it applies to what
// is below it, per channel: dst' = dst * keep + add. A straight-alpha colour c
// at alpha a is keep = 1 - a, add = c * a. A layer whose colour and alpha are
// not known (a texel of a PNG) is measured: two reads over two known
// backgrounds fix keep and add.

export type Rgb = [number, number, number];

/** What one layer does to the colour below it: dst' = dst * keep + add, per channel. */
export interface Layer {
  readonly keep: Rgb;
  readonly add: Rgb;
}

/** A straight-alpha colour at alpha `alpha` (a gradient is alpha 1, a box shadow its colour's alpha). */
export function straight(rgb: Rgb, alpha: number): Layer {
  return {
    keep: [1 - alpha, 1 - alpha, 1 - alpha],
    add: [rgb[0] * alpha, rgb[1] * alpha, rgb[2] * alpha],
  };
}

/** `layer` drawn over `dst`. */
export function over(dst: Rgb, layer: Layer): Rgb {
  return [0, 1, 2].map((c) => dst[c] * layer.keep[c] + layer.add[c]) as Rgb;
}

/** The layers, BACK TO FRONT, over `bg`. */
export function composite(bg: Rgb, layers: readonly Layer[]): Rgb {
  return layers.reduce<Rgb>((dst, layer) => over(dst, layer), bg);
}

/**
 * The layer that turned `bgA` into `onA` and `bgB` into `onB`. Per channel
 * dst' = dst * keep + add is linear in dst, so two backgrounds that differ in
 * every channel fix both keep and add.
 */
export function measuredLayer(onA: Rgb, bgA: Rgb, onB: Rgb, bgB: Rgb): Layer {
  const keep = [0, 1, 2].map((c) => {
    const span = bgB[c] - bgA[c];
    if (Math.abs(span) < 1e-3) throw new Error(`measuredLayer: backgrounds equal in channel ${c}`);
    return (onB[c] - onA[c]) / span;
  }) as Rgb;
  const add = [0, 1, 2].map((c) => onA[c] - bgA[c] * keep[c]) as Rgb;
  return { keep, add };
}

/** A sprite as the transparent sort sees it: its depth (world z = -depth), its external id, its layer. */
export interface SortedSprite {
  readonly depth: number;
  readonly id: number;
  readonly layer: Layer;
}

/**
 * Back to front, the order TransparentSortPass draws in: ascending world z.
 * The camera looks down -Z and a 2D row's z is -depth, so the LARGER depth
 * comes first. At equal z the higher external id is drawn last: in front.
 */
export function backToFront<T extends { depth: number; id: number }>(sprites: readonly T[]): T[] {
  return [...sprites].sort((a, b) => (b.depth - a.depth) || (a.id - b.id));
}

/** What the probe should read where all of `sprites` overlap, over `bg`. */
export function expectedOverlap(bg: Rgb, sprites: readonly SortedSprite[]): Rgb {
  return composite(bg, backToFront(sprites).map((s) => s.layer));
}

/** Largest absolute difference over the first three channels. */
export function maxChannelDiff(a: readonly number[], b: readonly number[]): number {
  return Math.max(...[0, 1, 2].map((c) => Math.abs(a[c] - b[c])));
}
