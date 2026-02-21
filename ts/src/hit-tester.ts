/**
 * CPU-side ray-sphere hit testing for entity picking.
 *
 * Casts a ray against all entity bounding spheres and returns the
 * entityId of the closest hit (smallest positive t), or null on miss.
 *
 * Works with the SoA bounds buffer format: [x, y, z, radius] per entity,
 * parallel-indexed with entityIds.
 */

export interface Ray {
  origin: [number, number, number];
  direction: [number, number, number]; // must be normalized
}

/**
 * Cast a ray against entity bounding spheres and return the closest hit.
 *
 * @param ray - The ray to cast (direction must be normalized).
 * @param bounds - SoA bounding data: [cx, cy, cz, r] per entity (length = entityCount * 4).
 * @param entityIds - Parallel array of entity IDs (length = entityCount).
 * @returns The entityId of the closest intersected sphere, or null if no hit.
 */
export function hitTestRay(
  ray: Ray,
  bounds: Float32Array,
  entityIds: Uint32Array,
): number | null {
  const entityCount = entityIds.length;
  if (entityCount === 0) return null;

  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.direction;

  let bestT = Infinity;
  let bestId: number | null = null;

  for (let i = 0; i < entityCount; i++) {
    const base = i * 4;
    const cx = bounds[base];
    const cy = bounds[base + 1];
    const cz = bounds[base + 2];
    const r = bounds[base + 3];

    // oc = ray.origin - center
    const ocx = ox - cx;
    const ocy = oy - cy;
    const ocz = oz - cz;

    // Quadratic coefficients: a*t^2 + b*t + c = 0
    // a = dot(d, d) = 1 for normalized direction, but we compute it for robustness
    // b = 2 * dot(oc, d)
    // c = dot(oc, oc) - r^2
    const b = 2 * (ocx * dx + ocy * dy + ocz * dz);
    const c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;

    const discriminant = b * b - 4 * c;
    if (discriminant < 0) continue;

    const sqrtDisc = Math.sqrt(discriminant);

    // Near intersection: t = (-b - sqrt(disc)) / 2
    let t = (-b - sqrtDisc) / 2;
    if (t < 0) {
      // Try far intersection: t = (-b + sqrt(disc)) / 2
      t = (-b + sqrtDisc) / 2;
    }

    if (t >= 0 && t < bestT) {
      bestT = t;
      bestId = entityIds[i];
    }
  }

  return bestId;
}
