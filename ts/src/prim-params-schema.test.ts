import { describe, it, expect } from 'vitest';
import { PRIM_PARAMS_SCHEMA, resolvePrimParams, RenderPrimitiveType } from './prim-params-schema';

describe('PRIM_PARAMS_SCHEMA', () => {
  it('maps Line params to float indices', () => {
    expect(PRIM_PARAMS_SCHEMA[RenderPrimitiveType.Line]).toEqual({
      startX: 0, startY: 1, endX: 2, endY: 3,
      width: 4, dashLen: 5, gapLen: 6,
    });
  });

  it('maps BoxShadow params to float indices', () => {
    expect(PRIM_PARAMS_SCHEMA[RenderPrimitiveType.BoxShadow]).toEqual({
      rectW: 0, rectH: 1, cornerRadius: 2, blur: 3,
      r: 4, g: 5, b: 6, a: 7,
    });
  });

  it('maps Gradient params to float indices', () => {
    expect(PRIM_PARAMS_SCHEMA[RenderPrimitiveType.Gradient]).toEqual({
      type: 0, angle: 1, stop0pos: 2, stop0r: 3,
      stop0g: 4, stop0b: 5, stop1pos: 6, stop1r: 7,
    });
  });

  it('maps BezierPath params to float indices', () => {
    expect(PRIM_PARAMS_SCHEMA[RenderPrimitiveType.BezierPath]).toEqual({
      p0x: 0, p0y: 1, p1x: 2, p1y: 3,
      p2x: 4, p2y: 5, width: 6,
    });
  });

  it('maps SDFGlyph params to float indices', () => {
    expect(PRIM_PARAMS_SCHEMA[RenderPrimitiveType.SDFGlyph]).toEqual({
      atlasU0: 0, atlasV0: 1, atlasU1: 2, atlasV1: 3,
      screenPxRange: 4, colorR: 5, colorG: 6, colorB: 7,
    });
  });
});

describe('resolvePrimParams', () => {
  it('returns [8] float array from named keys for BoxShadow', () => {
    const result = resolvePrimParams(RenderPrimitiveType.BoxShadow, {
      rectW: 48, rectH: 16, blur: 8, r: 0, g: 0, b: 0, a: 0.5,
    });
    expect(result).toEqual([48, 16, 0, 8, 0, 0, 0, 0.5]);
  });

  it('fills unspecified slots with 0', () => {
    const result = resolvePrimParams(RenderPrimitiveType.Line, { startX: 10, endX: 50, width: 2 });
    expect(result).toEqual([10, 0, 50, 0, 2, 0, 0, 0]);
  });

  it('returns 8 zeros for Quad (no schema)', () => {
    const result = resolvePrimParams(RenderPrimitiveType.Quad, { anything: 42 });
    expect(result).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('ignores unknown keys', () => {
    const result = resolvePrimParams(RenderPrimitiveType.Line, { startX: 1, bogus: 99 });
    expect(result).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });
});
