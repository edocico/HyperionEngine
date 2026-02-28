/**
 * CPU-side ray-sphere hit testing for entity picking.
 *
 * Casts a ray against all entity bounding spheres and returns the
 * entityId of the closest hit (smallest positive t), or null on miss.
 *
 * Works with the SoA bounds buffer format: [x, y, z, radius] per entity,
 * parallel-indexed with entityIds.
 *
 * When a SpatialGrid is provided, candidates are narrowed via a 3x3
 * neighbourhood query (typically ~10-30 entities), avoiding O(n) brute-force.
 * The brute-force path remains as fallback when no grid is supplied.
 */

import type { SpatialGrid } from './spatial-grid';

export interface Ray {
  origin: [number, number, number];
  direction: [number, number, number]; // must be normalized
}

/**
 * Ray-sphere intersection for a single entity index.
 * Returns the smallest positive t, or -1 on miss.
 */
function raySphereT(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  bounds: Float32Array, i: number,
): number {
  const base = i * 4;
  const cx = bounds[base];
  const cy = bounds[base + 1];
  const cz = bounds[base + 2];
  const r = bounds[base + 3];

  const ocx = ox - cx;
  const ocy = oy - cy;
  const ocz = oz - cz;

  const b = 2 * (ocx * dx + ocy * dy + ocz * dz);
  const c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;

  const discriminant = b * b - 4 * c;
  if (discriminant < 0) return -1;

  const sqrtDisc = Math.sqrt(discriminant);

  let t = (-b - sqrtDisc) / 2;
  if (t < 0) {
    t = (-b + sqrtDisc) / 2;
  }
  return t >= 0 ? t : -1;
}

/**
 * Cast a ray against entity bounding spheres and return the closest hit.
 *
 * When a {@link SpatialGrid} is provided, only candidates from the grid's
 * 3x3 neighbourhood around the ray origin are tested — O(1) amortised
 * instead of O(n). The brute-force loop is used as fallback when `grid`
 * is omitted.
 *
 * @param ray - The ray to cast (direction must be normalized).
 * @param bounds - SoA bounding data: [cx, cy, cz, r] per entity (length = entityCount * 4).
 * @param entityIds - Parallel array of entity IDs (length = entityCount).
 * @param grid - Optional SpatialGrid for accelerated candidate lookup.
 * @returns The entityId of the closest intersected sphere, or null if no hit.
 */
export function hitTestRay(
  ray: Ray,
  bounds: Float32Array,
  entityIds: Uint32Array,
  grid?: SpatialGrid,
): number | null {
  const entityCount = entityIds.length;
  if (entityCount === 0) return null;

  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.direction;

  // --- Grid-accelerated path ---
  if (grid) {
    const { indices, count } = grid.query(ox, oy);

    let bestT = Infinity;
    let bestId: number | null = null;

    for (let k = 0; k < count; k++) {
      const i = indices[k];
      if (i < 0 || i >= entityCount) continue;

      const t = raySphereT(ox, oy, oz, dx, dy, dz, bounds, i);
      if (t >= 0 && t < bestT) {
        bestT = t;
        bestId = entityIds[i];
      }
    }

    return bestId;
  }

  // --- Brute-force fallback ---
  let bestT = Infinity;
  let bestId: number | null = null;

  for (let i = 0; i < entityCount; i++) {
    const t = raySphereT(ox, oy, oz, dx, dy, dz, bounds, i);
    if (t >= 0 && t < bestT) {
      bestT = t;
      bestId = entityIds[i];
    }
  }

  return bestId;
}
