import type { RenderPass, FrameState } from './render-pass';
import type { ResourcePool } from './resource-pool';
import type { GpuProfiler } from './gpu-profiler';

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

  /**
   * Optional GPU timing. Null by default and on devices without the
   * `timestamp-query` feature — when null, `render()` encodes no extra work.
   */
  private profiler: GpuProfiler | null = null;
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

  /**
   * Attach (or detach, with null) a GPU profiler. The profiler outlives the
   * graph — `rebuildGraph()` in the renderer constructs a new RenderGraph on
   * every outline/bloom toggle and shader hot-reload, so keeping the profiler
   * outside preserves its history across those rebuilds.
   */
  setProfiler(profiler: GpuProfiler | null): void {
    this.profiler = profiler;
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
        const existing = resourceWriters.get(w);
        if (existing) {
          throw new Error(
            `Resource '${w}' has multiple writers: '${existing}' and '${name}'`,
          );
        }
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
    let qi = 0;
    while (qi < queue.length) {
      const current = queue[qi++];
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
    const worklist = [...alive];
    while (worklist.length > 0) {
      const name = worklist.pop()!;
      const pass = this.passes.get(name)!;
      for (const r of pass.reads) {
        const writer = resourceWriters.get(r);
        if (writer && !alive.has(writer)) {
          alive.add(writer);
          worklist.push(writer);
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

    // `beginFrame` returns false when profiling is off, when every readback
    // buffer is still in flight, or when the graph outgrew the profiler's
    // query set. In all three cases we fall through to the unmeasured path
    // and encode no marker passes at all.
    const measuring = this.profiler?.beginFrame(this.executionOrder) ?? false;

    try {
      for (const name of this.executionOrder) {
        if (measuring) this.profiler!.mark(encoder);
        this.passes.get(name)!.execute(encoder, frame, resources);
      }
    } catch (err) {
      // The encoder is abandoned unfinished, so the frame the profiler opened
      // will never resolve. Closing it here keeps a single throwing pass from
      // wedging `beginFrame()` shut for every frame that follows.
      if (measuring) this.profiler!.abortFrame();
      throw err;
    }

    if (measuring) this.profiler!.endFrame(encoder);

    device.queue.submit([encoder.finish()]);

    // Fire and forget: reads the frames that finished on the GPU a few frames
    // ago. Never awaited, so it cannot stall the render loop.
    if (measuring) void this.profiler!.poll();
  }

  destroy(): void {
    for (const pass of this.passes.values()) pass.destroy();
    this.passes.clear();
  }
}
