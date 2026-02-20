import type { BackpressuredProducer } from './backpressure';

/**
 * Low-level numeric ID interface for entity manipulation.
 * Operates directly on raw entity IDs without EntityHandle overhead.
 * Useful for bulk operations, ECS interop, or performance-critical paths
 * where handle allocation and leak detection are unnecessary.
 */
export class RawAPI {
  private readonly producer: BackpressuredProducer;
  private readonly allocId: () => number;

  constructor(producer: BackpressuredProducer, allocId: () => number) {
    this.producer = producer;
    this.allocId = allocId;
  }

  spawn(): number {
    const id = this.allocId();
    this.producer.spawnEntity(id);
    return id;
  }

  despawn(id: number): void {
    this.producer.despawnEntity(id);
  }

  setPosition(id: number, x: number, y: number, z: number): void {
    this.producer.setPosition(id, x, y, z);
  }

  setVelocity(id: number, vx: number, vy: number, vz: number): void {
    this.producer.setVelocity(id, vx, vy, vz);
  }

  setRotation(id: number, x: number, y: number, z: number, w: number): void {
    this.producer.setRotation(id, x, y, z, w);
  }

  setScale(id: number, sx: number, sy: number, sz: number): void {
    this.producer.setScale(id, sx, sy, sz);
  }

  setTexture(id: number, handle: number): void {
    this.producer.setTextureLayer(id, handle);
  }

  setMesh(id: number, handle: number): void {
    this.producer.setMeshHandle(id, handle);
  }

  setParent(id: number, parentId: number): void {
    this.producer.setParent(id, parentId);
  }
}
