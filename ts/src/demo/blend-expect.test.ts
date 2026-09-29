import { describe, it, expect } from 'vitest';
import { straight, over, composite, measuredLayer, backToFront, expectedOverlap, maxChannelDiff, type Rgb } from './blend-expect';

const CLEAR: Rgb = [0.067, 0.067, 0.067];

describe('straight-alpha "over" (the transparent pipeline blend)', () => {
  it('mixes the colour by its alpha: dst * (1 - a) + c * a', () => {
    const got = over([0.2, 0.4, 0.6], straight([1, 0, 0], 0.5));
    [0.6, 0.2, 0.3].forEach((v, c) => expect(got[c]).toBeCloseTo(v, 12));
  });

  it('alpha 1 leaves the colour on top, whatever was below', () => {
    expect(over([0.3, 0.9, 0.1], straight([0.25, 0.75, 0.5], 1))).toEqual([0.25, 0.75, 0.5]);
  });

  it('alpha 0 leaves the colour below', () => {
    expect(over([0.3, 0.9, 0.1], straight([1, 1, 1], 0))).toEqual([0.3, 0.9, 0.1]);
  });
});

describe('composite: layers back to front', () => {
  it('the order of two layers matters, and the last one is on top', () => {
    const green = straight([0, 1, 0], 1);
    const red = straight([1, 0, 0], 0.5);
    expect(composite(CLEAR, [red, green])).toEqual([0, 1, 0]);
    const redOnTop = composite(CLEAR, [green, red]);
    [0.5, 0.5, 0].forEach((v, c) => expect(redOnTop[c]).toBeCloseTo(v, 12));
  });

  it('no layers: the background', () => {
    expect(composite(CLEAR, [])).toEqual(CLEAR);
  });
});

describe('measuredLayer: a texel whose colour and alpha are unknown', () => {
  it('recovers keep = 1 - a and add = c * a from reads over two backgrounds', () => {
    const texel = straight([0.3, 0.8, 0.1], 0.7);
    const white: Rgb = [1, 1, 1];
    const layer = measuredLayer(over(CLEAR, texel), CLEAR, over(white, texel), white);
    layer.keep.forEach((k) => expect(k).toBeCloseTo(0.3, 10));
    [0.21, 0.56, 0.07].forEach((v, c) => expect(layer.add[c]).toBeCloseTo(v, 10));
    // Over a third background it predicts what the blend gives.
    const teal: Rgb = [0.25, 0.75, 0.5];
    const want = over(teal, texel);
    over(teal, layer).forEach((v, c) => expect(v).toBeCloseTo(want[c], 10));
  });

  it('an opaque texel: keep 0, add = its colour', () => {
    const texel = straight([0.9, 0.2, 0.4], 1);
    const white: Rgb = [1, 1, 1];
    const layer = measuredLayer(over(CLEAR, texel), CLEAR, over(white, texel), white);
    layer.keep.forEach((k) => expect(k).toBeCloseTo(0, 10));
    [0.9, 0.2, 0.4].forEach((v, c) => expect(layer.add[c]).toBeCloseTo(v, 10));
  });

  it('refuses two backgrounds equal in a channel: they fix nothing there', () => {
    expect(() => measuredLayer([0.5, 0.5, 0.5], [0.2, 0.3, 0.4], [0.5, 0.5, 0.5], [0.9, 0.3, 0.9]))
      .toThrow(/channel 1/);
  });
});

describe('backToFront: the order TransparentSortPass draws in', () => {
  it('the larger depth first (z = -depth, the camera looks down -Z)', () => {
    const order = backToFront([{ depth: 1, id: 1 }, { depth: 3, id: 2 }, { depth: 2, id: 3 }]);
    expect(order.map((s) => s.depth)).toEqual([3, 2, 1]);
  });

  it('at equal depth, the higher external id is drawn last: in front', () => {
    const order = backToFront([{ depth: 2, id: 9 }, { depth: 2, id: 3 }, { depth: 1, id: 5 }]);
    expect(order.map((s) => s.id)).toEqual([3, 9, 5]);
  });

  it('does not reorder its input', () => {
    const input = [{ depth: 1, id: 1 }, { depth: 3, id: 2 }];
    backToFront(input);
    expect(input.map((s) => s.id)).toEqual([1, 2]);
  });
});

describe('expectedOverlap', () => {
  it('the nearer sprite is on top, whatever the spawn order', () => {
    const want = expectedOverlap(CLEAR, [
      { depth: 1, id: 10, layer: straight([0, 1, 0], 1) },
      { depth: 2, id: 11, layer: straight([1, 0, 0], 0.5) },
    ]);
    expect(want).toEqual([0, 1, 0]);
  });

  it('a tie goes to the higher id', () => {
    const magenta = { depth: 2, id: 4, layer: straight([1, 0, 1], 1) };
    const cyan = { depth: 2, id: 7, layer: straight([0, 1, 1], 1) };
    expect(expectedOverlap(CLEAR, [cyan, magenta])).toEqual([0, 1, 1]);
    expect(expectedOverlap(CLEAR, [magenta, cyan])).toEqual([0, 1, 1]);
  });
});

describe('maxChannelDiff', () => {
  it('is the largest absolute per-channel difference, alpha ignored', () => {
    expect(maxChannelDiff([0.1, 0.5, 0.9, 1], [0.2, 0.2, 0.9, 0])).toBeCloseTo(0.3, 12);
  });
});
