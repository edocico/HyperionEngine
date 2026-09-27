/**
 * Manages the set of selected entity IDs.
 *
 * Maintains a CPU-side `Set<number>` of selected external entity ids, and
 * uploads the selection mask the `SelectionSeedPass` reads: one u32 per GPU
 * SLOT (0 = unselected, 1 = selected), since selection-seed.wgsl indexes it
 * with `visibleIndices`, which are slots.
 */
export class SelectionManager {
  private selected = new Set<number>();
  private dirty = false;
  private readonly maxEntities: number;
  /** Scratch mask by slot, reused across frames. */
  private slotMask = new Uint32Array(0);

  constructor(maxEntities: number) {
    this.maxEntities = maxEntities;
  }

  /** Mark an entity as selected. */
  select(entityId: number): void {
    this.selected.add(entityId);
    this.dirty = true;
  }

  /** Remove an entity from the selection set. */
  deselect(entityId: number): void {
    // Only a real change re-uploads the mask: the facade deselects every id it
    // frees, and with outlines on each upload is a full-size mask.
    if (this.selected.delete(entityId)) this.dirty = true;
  }

  /** Toggle an entity's selection state. Returns the new state. */
  toggle(entityId: number): boolean {
    if (this.selected.has(entityId)) {
      this.selected.delete(entityId);
      this.dirty = true;
      return false;
    } else {
      this.selected.add(entityId);
      this.dirty = true;
      return true;
    }
  }

  /** Clear all selections. */
  clear(): void {
    if (this.selected.size === 0) return;
    this.selected.clear();
    this.dirty = true;
  }

  /** Whether a specific entity is currently selected. */
  isSelected(entityId: number): boolean {
    return this.selected.has(entityId);
  }

  /** The number of currently selected entities. */
  get count(): number {
    return this.selected.size;
  }

  /** Whether any selection has changed since the last upload. */
  get isDirty(): boolean {
    return this.dirty;
  }

  /** Iterator over all currently selected entity IDs. */
  get selectedIds(): IterableIterator<number> {
    return this.selected.values();
  }

  /**
   * Upload the selection mask: `mask[slot] = 1` where the frame's
   * `entityIds[slot]` is selected. It used to be indexed by entity id, which
   * outlined whatever entity happened to sit in that slot.
   *
   * While something is selected it is rebuilt every frame — O(entityCount),
   * only with outlines on — because slots move (a despawn swap-removes, a
   * reused id lands elsewhere) without the selection changing. With nothing
   * selected it is cleared once, then nothing is uploaded.
   */
  uploadMask(device: GPUDevice, buffer: GPUBuffer, entityIds?: Uint32Array, entityCount = 0): void {
    if (this.selected.size === 0) {
      if (!this.dirty) return;
      device.queue.writeBuffer(buffer, 0, new Uint32Array(this.maxEntities), 0, this.maxEntities);
      this.dirty = false;
      return;
    }
    const count = Math.min(entityCount, this.maxEntities, entityIds?.length ?? 0);
    if (this.slotMask.length < count) this.slotMask = new Uint32Array(count);
    const mask = this.slotMask;
    for (let slot = 0; slot < count; slot++) mask[slot] = this.selected.has(entityIds![slot]) ? 1 : 0;
    if (count > 0) device.queue.writeBuffer(buffer, 0, mask, 0, count);
    this.dirty = false;
  }

  /** Release all internal state. */
  destroy(): void {
    this.selected.clear();
    this.dirty = false;
  }
}
