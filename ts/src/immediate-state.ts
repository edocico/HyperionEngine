/**
 * Maintains shadow position overrides for immediate-mode rendering.
 *
 * When a user drags an entity, the new position is sent through the ring buffer
 * (which incurs a 1-frame delay through WASM) AND stored here as a shadow override.
 * Before GPU upload, `patchTransforms()` writes these shadow positions directly into
 * the SoA transforms buffer, providing zero-latency visual feedback.
 */
export class ImmediateState {
  private readonly overrides = new Map<number, [number, number, number]>();

  /** Number of active position overrides. */
  get count(): number { return this.overrides.size; }

  /** Whether the given entity has a shadow position override. */
  has(entityId: number): boolean { return this.overrides.has(entityId); }

  /** Get the shadow position for an entity, or undefined if none. */
  get(entityId: number): [number, number, number] | undefined {
    return this.overrides.get(entityId);
  }

  /** Set a shadow position override for an entity. */
  set(entityId: number, x: number, y: number, z: number): void {
    this.overrides.set(entityId, [x, y, z]);
  }

  /** Remove the shadow position override for a single entity. */
  clear(entityId: number): void { this.overrides.delete(entityId); }

  /** Remove all shadow position overrides. */
  clearAll(): void { this.overrides.clear(); }

  /**
   * Patch the SoA transforms buffer with immediate-mode overrides.
   *
   * For each overridden entity, finds its SoA index via entityIds lookup
   * and writes the shadow position into transform matrix column 3
   * (offsets 12, 13, 14 for x, y, z in column-major mat4x4).
   */
  patchTransforms(
    transforms: Float32Array,
    entityIds: Uint32Array,
    entityCount: number,
  ): void {
    if (this.overrides.size === 0) return;
    for (let i = 0; i < entityCount; i++) {
      const pos = this.overrides.get(entityIds[i]);
      if (pos) {
        const base = i * 16;
        transforms[base + 12] = pos[0];
        transforms[base + 13] = pos[1];
        transforms[base + 14] = pos[2];
      }
    }
  }
}
