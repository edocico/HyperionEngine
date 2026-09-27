import type { SpawnOptions, TextureHandle } from '../types';

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
  /** z optional (0), as on `EntityHandle.position()`. */
  position?: [number, number] | [number, number, number];
  velocity?: [number, number] | [number, number, number];
  /** A number is uniform — (s, s, 1) on a 2D template; sz optional (1). */
  scale?: number | [number, number] | [number, number, number];
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
  /** `'2d'`: the root and every child are Transform2D entities (default `'3d'`). */
  mode?: SpawnOptions['mode'];
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
 * - Template must have a root node; `mode`, if set, is '2d' or '3d'.
 * - position/velocity must be [x, y] or [x, y, z].
 * - scale must be a number (uniform), [sx, sy] or [sx, sy, sz].
 */
export function validateTemplate(template: PrefabTemplate): void {
  if (!template || !template.root) throw new Error('PrefabTemplate must have a root node');
  if (template.mode !== undefined && template.mode !== '2d' && template.mode !== '3d') {
    throw new Error(`PrefabTemplate mode must be '2d' or '3d', got '${String(template.mode)}'`);
  }
  validateNode(template.root, 'root');
  if (template.children) {
    for (const [name, node] of Object.entries(template.children)) {
      validateNode(node, `children.${name}`);
    }
  }
}

/** A 2- or 3-element array: z is optional. */
const isVec23 = (v: unknown): boolean => Array.isArray(v) && (v.length === 2 || v.length === 3);

function validateNode(node: PrefabNode, path: string): void {
  if (node.position !== undefined && !isVec23(node.position)) {
    throw new Error(`${path}.position must be [x, y] or [x, y, z]`);
  }
  if (node.velocity !== undefined && !isVec23(node.velocity)) {
    throw new Error(`${path}.velocity must be [vx, vy] or [vx, vy, vz]`);
  }
  if (node.scale !== undefined && typeof node.scale !== 'number' && !isVec23(node.scale)) {
    throw new Error(`${path}.scale must be a number, [sx, sy] or [sx, sy, sz]`);
  }
}
