/**
 * Shared parameter name registry for RenderPrimitiveType → f32[8] slot mapping.
 *
 * Each render primitive type interprets the 8 per-entity f32 primParams differently.
 * This module provides a canonical mapping from human-readable parameter names
 * (e.g., "rectW", "blur", "width") to their slot index in the f32[8] array.
 *
 * The mappings match the WGSL shader layouts (ts/src/shaders/*.wgsl) and the
 * Rust PrimitiveParams documentation (crates/hyperion-core/src/components.rs).
 *
 * NOTE: RenderPrimitiveType is re-declared here (not imported from entity-handle.ts)
 * to avoid circular dependency. entity-handle.ts is the authoritative source.
 * The values MUST stay synchronized: Quad=0, Line=1, SDFGlyph=2, BezierPath=3,
 * Gradient=4, BoxShadow=5.
 */

// Re-declare RenderPrimitiveType here (NOT imported from entity-handle.ts)
// to avoid circular dependency. entity-handle.ts is the authoritative source.
export const enum RenderPrimitiveType {
  Quad = 0,
  Line = 1,
  SDFGlyph = 2,
  BezierPath = 3,
  Gradient = 4,
  BoxShadow = 5,
}

/**
 * Maps each RenderPrimitiveType to a record of { paramName: slotIndex }.
 *
 * Quad has no schema (all 8 slots unused).
 *
 * Slot indices correspond to positions in the f32[8] primParams array:
 * - Slots 0-3 are sent via SetPrimParams0 ring buffer command
 * - Slots 4-7 are sent via SetPrimParams1 ring buffer command
 */
export const PRIM_PARAMS_SCHEMA: Partial<Record<RenderPrimitiveType, Record<string, number>>> = {
  [RenderPrimitiveType.Line]: {
    startX: 0, startY: 1, endX: 2, endY: 3,
    width: 4, dashLen: 5, gapLen: 6,
  },
  [RenderPrimitiveType.SDFGlyph]: {
    atlasU0: 0, atlasV0: 1, atlasU1: 2, atlasV1: 3,
    screenPxRange: 4, colorR: 5, colorG: 6, colorB: 7,
  },
  [RenderPrimitiveType.BezierPath]: {
    p0x: 0, p0y: 1, p1x: 2, p1y: 3,
    p2x: 4, p2y: 5, width: 6,
  },
  [RenderPrimitiveType.Gradient]: {
    type: 0, angle: 1, stop0pos: 2, stop0r: 3,
    stop0g: 4, stop0b: 5, stop1pos: 6, stop1r: 7,
  },
  [RenderPrimitiveType.BoxShadow]: {
    rectW: 0, rectH: 1, cornerRadius: 2, blur: 3,
    r: 4, g: 5, b: 6, a: 7,
  },
};

/**
 * Resolve named parameters into an 8-element float array.
 *
 * Given a primitive type and a record of { paramName: value }, places each
 * value at its schema-defined slot index. Unspecified slots default to 0.
 * Unknown keys (not in the schema) are silently ignored.
 * If the primitive type has no schema (e.g., Quad), returns all zeros.
 *
 * @param primitiveType - The render primitive type to resolve params for.
 * @param named - Named parameter values to place into the f32[8] array.
 * @returns An 8-element number array suitable for setPrimParams0/setPrimParams1.
 */
export function resolvePrimParams(
  primitiveType: RenderPrimitiveType,
  named: Record<string, number>,
): number[] {
  const result = [0, 0, 0, 0, 0, 0, 0, 0];
  const schema = PRIM_PARAMS_SCHEMA[primitiveType];
  if (!schema) return result;
  for (const [key, value] of Object.entries(named)) {
    const index = schema[key];
    if (index !== undefined) result[index] = value;
  }
  return result;
}
