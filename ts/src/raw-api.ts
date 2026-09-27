import type { BackpressuredProducer } from './backpressure';
import { spawnIs2D, type SpawnOptions } from './types';

/**
 * How RawAPI allocates and frees ids. `Hyperion` passes its id allocator, which
 * reuses freed ids under quarantine: a despawned id may later address another
 * entity, so a raw id must not be kept after `despawn()`.
 */
export interface RawIdHooks {
  allocate(): number;
  /**
   * Frees `id` for reuse. Returns false, and the despawn is not sent, when
   * there is nothing to free (a double despawn, an id never allocated). May
   * throw, e.g. for an id an EntityHandle owns.
   */
  release(id: number): boolean;
  /** Whether commands may still address `id`. */
  isLive(id: number): boolean;
}

/**
 * Low-level numeric ID interface for entity manipulation.
 * Operates directly on raw entity IDs without EntityHandle overhead.
 * Useful for bulk operations, ECS interop, or performance-critical paths
 * where handle allocation and leak detection are unnecessary.
 *
 * Commands addressed to an id that is not live (despawned, in quarantine,
 * never allocated) are dropped, with a one-time warning in dev builds.
 */
export class RawAPI {
  private readonly producer: BackpressuredProducer;
  private readonly ids: RawIdHooks;
  private warnedDropped = false;

  /**
   * @param ids - The id hooks, or a bare allocator (no liveness checks, no
   *   release: the behaviour before ids were reused).
   */
  constructor(producer: BackpressuredProducer, ids: RawIdHooks | (() => number)) {
    this.producer = producer;
    this.ids = typeof ids === 'function'
      ? { allocate: ids, release: () => true, isLive: () => true }
      : ids;
  }

  /** A 3D entity, or a Transform2D one with `{ mode: '2d' }` (see `SpawnOptions`). */
  spawn(options?: SpawnOptions): number {
    const is2D = spawnIs2D(options);
    const id = this.ids.allocate();
    this.producer.spawnEntity(id, is2D);
    return id;
  }

  despawn(id: number): void {
    if (this.ids.release(id)) this.producer.despawnEntity(id);
  }

  setPosition(id: number, x: number, y: number, z = 0): void {
    if (this.live(id)) this.producer.setPosition(id, x, y, z);
  }

  setVelocity(id: number, vx: number, vy: number, vz = 0): void {
    if (this.live(id)) this.producer.setVelocity(id, vx, vy, vz);
  }

  setRotation(id: number, x: number, y: number, z: number, w: number): void {
    if (this.live(id)) this.producer.setRotation(id, x, y, z, w);
  }

  setScale(id: number, sx: number, sy: number, sz = 1): void {
    if (this.live(id)) this.producer.setScale(id, sx, sy, sz);
  }

  setTexture(id: number, handle: number): void {
    if (this.live(id)) this.producer.setTextureLayer(id, handle);
  }

  setMesh(id: number, handle: number): void {
    if (this.live(id)) this.producer.setMeshHandle(id, handle);
  }

  setParent(id: number, parentId: number): void {
    if (this.live(id)) this.producer.setParent(id, parentId);
  }

  private live(id: number): boolean {
    if (this.ids.isLive(id)) return true;
    if (!this.warnedDropped && typeof __DEV__ !== 'undefined' && __DEV__) {
      this.warnedDropped = true;
      console.warn(`[Hyperion] RawAPI: dropped a command for entity ${id}, which is not live (despawned or never spawned). Further drops are silent.`);
    }
    return false;
  }
}
