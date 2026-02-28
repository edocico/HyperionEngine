/**
 * SpatialGrid — zero-alloc uniform 2D spatial hash grid.
 *
 * Flat Int32Array backing store (zero GC pressure).
 * Three-pass rebuild: count, prefix-sum, scatter.
 * Bounds-based multi-cell insertion (center +/- radius).
 * 3x3 neighborhood query with sort+compact dedup.
 *
 * Designed for the engine's SoA bounds format: Float32Array stride 4 (x, y, z, radius).
 */

export interface QueryResult {
  readonly indices: Int32Array;
  readonly count: number;
}

function nextPowerOf2(v: number): number {
  v = Math.max(v, 1);
  v--;
  v |= v >> 1;
  v |= v >> 2;
  v |= v >> 4;
  v |= v >> 8;
  v |= v >> 16;
  return v + 1;
}

export class SpatialGrid {
  private readonly maxCells: number;
  private readonly cellMask: number;

  /** Per-cell entry count (used during rebuild). */
  private readonly cellCounts: Int32Array;
  /** Exclusive prefix sum of cellCounts — start offset for each cell's entries. */
  private readonly cellOffsets: Int32Array;
  /** Scattered entity indices, indexed by cellOffsets. May be reallocated on overflow. */
  private cellEntities: Int32Array;
  /** Reusable output buffer for query results. */
  private readonly queryBuffer: Int32Array;

  /** Current cell size (world units). Updated on rebuild. */
  private cellSize = 1;
  /** Inverse cell size for fast division. */
  private invCellSize = 1;
  /** Total entries scattered in current build. */
  private totalEntries = 0;
  /** Current entity count in grid. */
  private entityCount = 0;

  constructor(maxEntities: number) {
    this.maxCells = nextPowerOf2(maxEntities * 2);
    this.cellMask = this.maxCells - 1;

    this.cellCounts = new Int32Array(this.maxCells);
    this.cellOffsets = new Int32Array(this.maxCells);
    // Conservative: each entity can span up to ~4 cells on average (2x2 overlap).
    this.cellEntities = new Int32Array(maxEntities * 4);
    this.queryBuffer = new Int32Array(maxEntities);
  }

  /**
   * Hash cell coordinates to a bucket index.
   * Uses well-distributed multiplicative hash with power-of-2 modulo.
   */
  private hash(ix: number, iy: number): number {
    return (Math.imul(ix, 92837111) ^ Math.imul(iy, 689287499)) & this.cellMask;
  }

  /**
   * Rebuild the grid from SoA bounds data.
   * @param bounds Float32Array with stride 4: [x, y, z, radius] per entity
   * @param entityCount Number of entities in the bounds array
   */
  rebuild(bounds: Float32Array, entityCount: number): void {
    this.entityCount = entityCount;

    if (entityCount === 0) {
      this.totalEntries = 0;
      return;
    }

    // --- Compute AABB of all entities to determine world area ---
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let validCount = 0;

    for (let i = 0; i < entityCount; i++) {
      const r = bounds[i * 4 + 3];
      if (r <= 0) continue;
      validCount++;
      const cx = bounds[i * 4];
      const cy = bounds[i * 4 + 1];
      const lo_x = cx - r;
      const lo_y = cy - r;
      const hi_x = cx + r;
      const hi_y = cy + r;
      if (lo_x < minX) minX = lo_x;
      if (lo_y < minY) minY = lo_y;
      if (hi_x > maxX) maxX = hi_x;
      if (hi_y > maxY) maxY = hi_y;
    }

    if (validCount === 0) {
      this.totalEntries = 0;
      return;
    }

    const worldW = maxX - minX;
    const worldH = maxY - minY;
    const worldArea = Math.max(worldW * worldH, 1);

    // Cell size: sqrt(worldArea / entityCount) * 2
    this.cellSize = Math.max(Math.sqrt(worldArea / validCount) * 2, 1);
    this.invCellSize = 1 / this.cellSize;

    // --- Pass 1: Count entries per cell ---
    this.cellCounts.fill(0);

    for (let i = 0; i < entityCount; i++) {
      const r = bounds[i * 4 + 3];
      if (r <= 0) continue;

      const cx = bounds[i * 4];
      const cy = bounds[i * 4 + 1];
      const cellMinX = Math.floor((cx - r) * this.invCellSize);
      const cellMinY = Math.floor((cy - r) * this.invCellSize);
      const cellMaxX = Math.floor((cx + r) * this.invCellSize);
      const cellMaxY = Math.floor((cy + r) * this.invCellSize);

      for (let gx = cellMinX; gx <= cellMaxX; gx++) {
        for (let gy = cellMinY; gy <= cellMaxY; gy++) {
          const h = this.hash(gx, gy);
          this.cellCounts[h]++;
        }
      }
    }

    // --- Pass 2: Exclusive prefix sum on cellCounts -> cellOffsets ---
    let sum = 0;
    for (let i = 0; i < this.maxCells; i++) {
      this.cellOffsets[i] = sum;
      sum += this.cellCounts[i];
    }
    this.totalEntries = sum;

    // Realloc if prefix sum exceeds buffer capacity (pathological: entities >> cell size)
    if (sum > this.cellEntities.length) {
      this.cellEntities = new Int32Array(sum);
    }

    // --- Pass 3: Scatter entity indices into cellEntities ---
    // Reset counts to use as running insert cursors
    this.cellCounts.fill(0);

    for (let i = 0; i < entityCount; i++) {
      const r = bounds[i * 4 + 3];
      if (r <= 0) continue;

      const cx = bounds[i * 4];
      const cy = bounds[i * 4 + 1];
      const cellMinX = Math.floor((cx - r) * this.invCellSize);
      const cellMinY = Math.floor((cy - r) * this.invCellSize);
      const cellMaxX = Math.floor((cx + r) * this.invCellSize);
      const cellMaxY = Math.floor((cy + r) * this.invCellSize);

      for (let gx = cellMinX; gx <= cellMaxX; gx++) {
        for (let gy = cellMinY; gy <= cellMaxY; gy++) {
          const h = this.hash(gx, gy);
          const offset = this.cellOffsets[h] + this.cellCounts[h];
          this.cellEntities[offset] = i;
          this.cellCounts[h]++;
        }
      }
    }
  }

  /**
   * Query the grid for candidate entity indices near a world-space point.
   * Scans a 3x3 neighborhood of cells around the query position.
   * Returns deduplicated results via sort+compact.
   *
   * **Aliasing warning:** The returned `indices` buffer is reused across calls.
   * Contents are invalidated on the next call to `query()`. Copy the subarray
   * (`indices.subarray(0, count).slice()`) if you need to retain results.
   *
   * @param wx World-space X coordinate
   * @param wy World-space Y coordinate
   * @returns QueryResult with indices subarray and count
   */
  query(wx: number, wy: number): QueryResult {
    if (this.entityCount === 0 || this.totalEntries === 0) {
      return { indices: this.queryBuffer, count: 0 };
    }

    const cellX = Math.floor(wx * this.invCellSize);
    const cellY = Math.floor(wy * this.invCellSize);

    let writePos = 0;

    // Scan 3x3 neighborhood
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const h = this.hash(cellX + dx, cellY + dy);
        const start = this.cellOffsets[h];
        const count = this.cellCounts[h];
        for (let k = 0; k < count; k++) {
          const offset = start + k;
          if (offset < this.cellEntities.length && writePos < this.queryBuffer.length) {
            this.queryBuffer[writePos++] = this.cellEntities[offset];
          }
        }
      }
    }

    if (writePos === 0) {
      return { indices: this.queryBuffer, count: 0 };
    }

    // Dedup via sort + compact
    const sub = this.queryBuffer.subarray(0, writePos);
    sub.sort();

    let unique = 1;
    for (let i = 1; i < writePos; i++) {
      if (sub[i] !== sub[i - 1]) {
        sub[unique++] = sub[i];
      }
    }

    return { indices: this.queryBuffer, count: unique };
  }
}
