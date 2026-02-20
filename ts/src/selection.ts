/**
 * Manages the set of selected entity IDs.
 *
 * Maintains a CPU-side `Set<number>` of selected entity indices and a dirty
 * flag.  When dirty, `uploadMask()` writes a Uint32Array selection mask
 * (1 u32 per entity: 0 = unselected, 1 = selected) to a GPU buffer for
 * consumption by the `SelectionSeedPass`.
 */
export class SelectionManager {
  private selected = new Set<number>();
  private dirty = false;
  private readonly maxEntities: number;

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
    this.selected.delete(entityId);
    this.dirty = true;
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
   * Upload the selection mask to a GPU buffer if dirty.
   *
   * The mask is a Uint32Array where `mask[entityId] = 1` for selected
   * entities and `0` otherwise.  Only uploads when the selection state
   * has changed since the last upload.
   */
  uploadMask(device: GPUDevice, buffer: GPUBuffer): void {
    if (!this.dirty) return;
    const mask = new Uint32Array(this.maxEntities);
    for (const id of this.selected) {
      if (id < this.maxEntities) {
        mask[id] = 1;
      }
    }
    device.queue.writeBuffer(buffer, 0, mask, 0, this.maxEntities);
    this.dirty = false;
  }

  /** Release all internal state. */
  destroy(): void {
    this.selected.clear();
    this.dirty = false;
  }
}
