import type { Hyperion } from '../hyperion';
import type { EntityHandle } from '../entity-handle';
import type { PrefabTemplate, PrefabNode, SpawnOverrides } from './types';
import { validateTemplate } from './types';
import { PrefabInstance } from './instance';
import { resolvePrimParams } from '../prim-params-schema';

/**
 * Registry for prefab templates.
 *
 * Templates are registered by name and spawned on demand. Each `spawn()`
 * call creates a root entity plus optional children, applies all template
 * properties via the EntityHandle fluent API, parents children to the root,
 * and returns a `PrefabInstance` for named access and bulk lifecycle.
 *
 * The registry validates templates at registration time and supports
 * spawn-time position overrides.
 */
export class PrefabRegistry {
  private readonly engine: Hyperion;
  private readonly templates = new Map<string, PrefabTemplate>();

  constructor(engine: Hyperion) {
    this.engine = engine;
  }

  /** Register a named prefab template. Throws on duplicate names. */
  register(name: string, template: PrefabTemplate): void {
    if (this.templates.has(name)) throw new Error(`Prefab '${name}' is already registered`);
    validateTemplate(template);
    this.templates.set(name, template);
  }

  /** Remove a registered prefab template by name. No-op if not found. */
  unregister(name: string): void {
    this.templates.delete(name);
  }

  /** Check if a prefab template is registered under the given name. */
  has(name: string): boolean {
    return this.templates.has(name);
  }

  /** List all registered prefab names in registration order. */
  list(): string[] {
    return [...this.templates.keys()];
  }

  /**
   * Spawn an instance of a registered prefab.
   *
   * Creates the root entity, applies template properties, then creates
   * and parents any children. Spawn overrides replace the root position
   * (partial: unspecified axes keep the template default).
   *
   * @param name - Registered prefab name.
   * @param overrides - Optional position overrides for the root entity.
   * @returns A PrefabInstance with named access to root and children.
   * @throws If the prefab name is not registered.
   */
  spawn(name: string, overrides?: SpawnOverrides): PrefabInstance {
    const template = this.templates.get(name);
    if (!template) throw new Error(`Prefab '${name}' is not registered`);

    const root = this.engine.spawn();
    const rootZ = this.applyNode(root, template.root);

    if (overrides) {
      const pos = template.root.position ?? [0, 0, 0];
      root.position(overrides.x ?? pos[0], overrides.y ?? pos[1], overrides.z ?? pos[2]);
    }

    const children = new Map<string, EntityHandle>();
    if (template.children) {
      for (const [key, childNode] of Object.entries(template.children)) {
        const child = this.engine.spawn();
        this.applyNode(child, childNode);
        child.parent(root.id);
        children.set(key, child);
      }
    }

    return new PrefabInstance(name, root, children, rootZ);
  }

  /**
   * Apply a PrefabNode's properties to an EntityHandle.
   * Returns the z-component of the node's position (or 0 if unset),
   * used by PrefabInstance to preserve z on moveTo().
   */
  private applyNode(handle: EntityHandle, node: PrefabNode): number {
    let z = 0;
    if (node.position) {
      handle.position(node.position[0], node.position[1], node.position[2]);
      z = node.position[2];
    }
    if (node.velocity) {
      handle.velocity(node.velocity[0], node.velocity[1], node.velocity[2]);
    }
    if (node.scale !== undefined) {
      if (typeof node.scale === 'number') {
        handle.scale(node.scale, node.scale, node.scale);
      } else {
        handle.scale(node.scale[0], node.scale[1], node.scale[2]);
      }
    }
    if (node.rotation !== undefined) {
      const half = node.rotation / 2;
      handle.rotation(0, 0, Math.sin(half), Math.cos(half));
    }
    if (node.texture !== undefined) handle.texture(node.texture);
    if (node.mesh !== undefined) handle.mesh(node.mesh);
    if (node.primitive !== undefined) {
      handle.primitive(node.primitive);
      if (node.primParams) {
        const floats = resolvePrimParams(node.primitive, node.primParams);
        // Access the producer directly for setPrimParams0/setPrimParams1.
        // These are split into two ring buffer commands due to 16-byte payload limit.
        const p = (handle as any)._producer;
        if (p) {
          p.setPrimParams0(handle.id, floats[0], floats[1], floats[2], floats[3]);
          p.setPrimParams1(handle.id, floats[4], floats[5], floats[6], floats[7]);
        }
      }
    }
    if (node.data) {
      for (const [key, value] of Object.entries(node.data)) {
        handle.data(key, value);
      }
    }
    return z;
  }
}
