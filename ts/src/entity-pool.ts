import { EntityHandle } from './entity-handle';
import type { BackpressuredProducer } from './backpressure';
import type { ImmediateState } from './immediate-state';

/**
 * Object pool for EntityHandle instances.
 *
 * Recycling handles avoids GC pressure when entities are frequently
 * created and destroyed. The pool has a configurable max size (default 1024)
 * to prevent unbounded growth if entities are destroyed faster than created.
 *
 * Usage:
 * - `acquire(id, producer)` returns a recycled handle (re-initialized via
 *   `EntityHandle.init()`) or creates a new one if the pool is empty.
 * - `release(handle)` returns a handle to the pool (up to `maxSize`).
 *   Handles beyond the cap are simply discarded for GC.
 */
export class EntityHandlePool {
  private readonly pool: EntityHandle[] = [];
  readonly maxSize: number;

  constructor(maxSize: number = 1024) {
    this.maxSize = maxSize;
  }

  /** Number of handles currently in the pool (available for reuse). */
  get size(): number { return this.pool.length; }

  /**
   * Acquire a handle for the given entity ID.
   *
   * If the pool has a recycled handle, it is re-initialized with the new
   * ID and producer. Otherwise a fresh EntityHandle is allocated.
   */
  acquire(entityId: number, producer: BackpressuredProducer, immediateState?: ImmediateState): EntityHandle {
    const handle = this.pool.pop();
    if (handle) {
      handle.init(entityId, producer, immediateState);
      return handle;
    }
    return new EntityHandle(entityId, producer, immediateState);
  }

  /**
   * Return a handle to the pool for future reuse.
   *
   * If the pool is already at capacity, the handle is silently discarded
   * (it will be garbage-collected normally).
   */
  release(handle: EntityHandle): void {
    if (this.pool.length < this.maxSize) {
      this.pool.push(handle);
    }
  }
}
