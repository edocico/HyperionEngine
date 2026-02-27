import type { TextureHandle } from '../types';

/**
 * A single node in a prefab template.
 *
 * Each field maps to an EntityHandle setter:
 * - position/velocity/scale/rotation -> transform commands
 * - texture/mesh/primitive -> render commands
 * - primParams -> named parameter resolution via PRIM_PARAMS_SCHEMA
 * - data -> plugin data map
 */
export interface PrefabNode {
  position?: [number, number, number];
  velocity?: [number, number, number];
  scale?: number | [number, number, number];
  rotation?: number;  // z-axis rotation in radians
  texture?: TextureHandle;
  primitive?: number;
  primParams?: Record<string, number>;
  mesh?: number;
  data?: Record<string, unknown>;
}

/**
 * A prefab template describing a root entity and optional named children.
 *
 * Children are automatically parented to the root when spawned.
 * The children record uses string keys for named access via
 * `PrefabInstance.child(key)`.
 */
export interface PrefabTemplate {
  root: PrefabNode;
  children?: Record<string, PrefabNode>;
}

/**
 * Overrides applied to the root entity position at spawn time.
 * Partial: only specified axes are overridden; others keep the template default.
 */
export interface SpawnOverrides {
  x?: number;
  y?: number;
  z?: number;
}

/**
 * Validate a PrefabTemplate, throwing on structural errors.
 *
 * Checks:
 * - Template must have a root node.
 * - position/velocity must be [x, y, z] (3-element arrays).
 * - scale must be a number (uniform) or [sx, sy, sz] (3-element array).
 */
export function validateTemplate(template: PrefabTemplate): void {
  if (!template || !template.root) throw new Error('PrefabTemplate must have a root node');
  validateNode(template.root, 'root');
  if (template.children) {
    for (const [name, node] of Object.entries(template.children)) {
      validateNode(node, `children.${name}`);
    }
  }
}

function validateNode(node: PrefabNode, path: string): void {
  if (node.position !== undefined && (!Array.isArray(node.position) || node.position.length !== 3)) {
    throw new Error(`${path}.position must be [x, y, z]`);
  }
  if (node.velocity !== undefined && (!Array.isArray(node.velocity) || node.velocity.length !== 3)) {
    throw new Error(`${path}.velocity must be [vx, vy, vz]`);
  }
  if (node.scale !== undefined) {
    if (typeof node.scale !== 'number' && (!Array.isArray(node.scale) || node.scale.length !== 3)) {
      throw new Error(`${path}.scale must be a number or [sx, sy, sz]`);
    }
  }
}
