import type { RenderPass, FrameState } from './render-pass';
import type { ResourcePool } from './resource-pool';

/**
 * Directed acyclic graph of render passes.
 *
 * Passes declare resource reads/writes; `compile()` topologically sorts them
 * via Kahn's algorithm and culls dead optional passes whose outputs are never
 * consumed.  Call `render()` each frame to prepare + encode every live pass
 * into a single command buffer.
 */
export class RenderGraph {
  private passes = new Map<string, RenderPass>();
  private executionOrder: string[] = [];
  private _needsRecompile = true;

  get needsRecompile(): boolean {
    return this._needsRecompile;
  }

  addPass(pass: RenderPass): void {
    if (this.passes.has(pass.name)) {
      throw new Error(`RenderPass '${pass.name}' already registered`);
    }
    this.passes.set(pass.name, pass);
    this._needsRecompile = true;
  }

  removePass(name: string): void {
    const pass = this.passes.get(name);
    if (pass) {
      pass.destroy();
      this.passes.delete(name);
      this._needsRecompile = true;
    }
  }

  /**
   * Build topologically sorted execution order and cull dead optional passes.
   *
   * Returns the ordered list of pass names that will execute each frame.
   * Throws if the dependency graph contains a cycle.
   */
  compile(): string[] {
    // --- 1. Build adjacency list from resource dependencies ---
    const resourceWriters = new Map<string, string>();
    const adj = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    for (const [name, pass] of this.passes) {
      adj.set(name, []);
      inDegree.set(name, 0);
      for (const w of pass.writes) {
        resourceWriters.set(w, name);
      }
    }

    for (const [name, pass] of this.passes) {
      for (const r of pass.reads) {
        const writer = resourceWriters.get(r);
        if (writer && writer !== name) {
          adj.get(writer)!.push(name);
          inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
        }
      }
    }

    // --- 2. Kahn's algorithm ---
    const queue: string[] = [];
    for (const [name, deg] of inDegree) {
      if (deg === 0) queue.push(name);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    if (sorted.length !== this.passes.size) {
      throw new Error('RenderGraph has a cycle — cannot compile');
    }

    // --- 3. Dead-pass culling ---
    // Seed "alive" set with non-optional passes and swapchain writers
    const alive = new Set<string>();
    for (const [name, pass] of this.passes) {
      if (pass.writes.includes('swapchain') || !pass.optional) {
        alive.add(name);
      }
    }

    // Walk backwards: if an alive pass reads a resource, mark its writer alive
    let changed = true;
    while (changed) {
      changed = false;
      for (const name of alive) {
        const pass = this.passes.get(name)!;
        for (const r of pass.reads) {
          const writer = resourceWriters.get(r);
          if (writer && !alive.has(writer)) {
            alive.add(writer);
            changed = true;
          }
        }
      }
    }

    this.executionOrder = sorted.filter(name => alive.has(name));
    this._needsRecompile = false;
    return [...this.executionOrder];
  }

  /**
   * Prepare and execute every live pass, submitting a single command buffer.
   */
  render(device: GPUDevice, frame: FrameState, resources: ResourcePool): void {
    if (this._needsRecompile) this.compile();

    for (const name of this.executionOrder) {
      this.passes.get(name)!.prepare(device, frame);
    }

    const encoder = device.createCommandEncoder();
    for (const name of this.executionOrder) {
      this.passes.get(name)!.execute(encoder, frame, resources);
    }
    device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    for (const pass of this.passes.values()) pass.destroy();
    this.passes.clear();
  }
}
