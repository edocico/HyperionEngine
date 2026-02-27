import type { EntityHandle } from '../entity-handle';

/**
 * A live instance of a spawned prefab.
 *
 * Holds the root EntityHandle and a map of named child handles.
 * Provides convenience methods for moving the entire prefab
 * and destroying all its entities at once.
 *
 * Created by `PrefabRegistry.spawn()` -- not constructed directly.
 */
export class PrefabInstance {
  readonly name: string;
  readonly root: EntityHandle;
  private readonly children: Map<string, EntityHandle>;
  private readonly rootZ: number;

  constructor(name: string, root: EntityHandle, children: Map<string, EntityHandle>, rootZ: number = 0) {
    this.name = name;
    this.root = root;
    this.children = children;
    this.rootZ = rootZ;
  }

  /** Look up a named child handle. Returns undefined if key is not found. */
  child(key: string): EntityHandle | undefined {
    return this.children.get(key);
  }

  /** List all child keys in insertion order. */
  get childNames(): string[] {
    return [...this.children.keys()];
  }

  /**
   * Move the entire prefab by setting the root position.
   * Children follow automatically via the scene graph.
   * Z is preserved from the template's root position at spawn time.
   */
  moveTo(x: number, y: number): void {
    this.root.position(x, y, this.rootZ);
  }

  /**
   * Destroy all entities in this prefab instance.
   * Children are destroyed before the root to maintain scene graph integrity.
   */
  destroyAll(): void {
    for (const child of this.children.values()) child.destroy();
    this.root.destroy();
  }
}
