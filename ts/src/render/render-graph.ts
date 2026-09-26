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
   * graph — the renderer's RenderGraphHost constructs a new RenderGraph on
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
   * Remove a pass WITHOUT destroying it, and return it. For passes the graph
   * does not own — a plugin's overlay must survive the renderer rebuilding
   * its graph, and only the plugin may destroy it.
   */
  detachPass(name: string): RenderPass | undefined {
    const pass = this.passes.get(name);
    if (pass) {
      this.passes.delete(name);
      this._needsRecompile = true;
    }
    return pass;
  }

  /**
   * Build topologically sorted execution order and cull dead optional passes.
   *
   * Returns the ordered list of pass names that will execute each frame.
   * Throws if the dependency graph contains a cycle.
   */
  compile(): string[] {
    // --- 1. Writers per resource, in registration order ---
    // A resource normally has one writer. A later pass may write it too only
    // if it also READS it: a read-modify-write that layers on the previous
    // version (an overlay drawn with loadOp 'load' onto the swapchain). Such
    // writers form a chain in registration order. A second *blind* write is
    // still an error — which pass wins would depend on execution order.
    const writers = new Map<string, string[]>();
    const adj = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    for (const [name, pass] of this.passes) {
      adj.set(name, []);
      inDegree.set(name, 0);
      for (const w of pass.writes) {
        const chain = writers.get(w);
        if (!chain) {
          writers.set(w, [name]);
        } else if (pass.reads.includes(w)) {
          chain.push(name);
        } else if (this.passes.get(chain[0])!.reads.includes(w)) {
          // The chain opened with a layering pass and a blind writer follows.
          // Adding the read to the blind writer would make it the next link —
          // run after the layering pass and paint over it. The fix is order.
          throw new Error(
            `Resource '${w}' has multiple writers: blind writer '${name}' is registered after ` +
            `'${chain[0]}', which layers on top of it — register '${chain[0]}' after '${name}'`,
          );
        } else {
          throw new Error(
            `Resource '${w}' has multiple writers: '${chain[chain.length - 1]}' and '${name}'` +
            ` — list '${w}' in reads too if '${name}' layers on top of it`,
          );
        }
      }
    }

    // The pass that produced the version of `resource` that `reader` sees:
    // a link of the chain reads the link before it; anyone else reads the
    // final version, whatever the registration order. So an intermediate
    // version is visible only to the next link: a pass that needs the
    // pre-layering image (say, to feed the layer) must read a separately
    // named resource, or the dependency becomes a cycle.
    const producerOf = (reader: string, resource: string): string | undefined => {
      const chain = writers.get(resource);
      if (!chain) return undefined;
      const i = chain.indexOf(reader);
      if (i === -1) return chain[chain.length - 1];
      return i > 0 ? chain[i - 1] : undefined;
    };

    for (const [name, pass] of this.passes) {
      for (const r of pass.reads) {
        const writer = producerOf(name, r);
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
      const stuck = [...this.passes.keys()].filter((n) => !sorted.includes(n));
      throw new Error(
        `RenderGraph has a cycle — cannot compile. Passes left unscheduled: ` +
        stuck.map((n) => `'${n}'`).join(', '),
      );
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
        const writer = producerOf(name, r);
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
    // A staged pass reports its stages (`pass/stage`) instead of itself, and
    // marks them on its own: the graph marks only before unstaged passes.
    let names: string[] = this.executionOrder;
    const stagesOf = new Map<string, readonly string[]>();
    if (this.profiler) {
      names = [];
      for (const name of this.executionOrder) {
        const stages = this.passes.get(name)!.profileStages?.(frame);
        if (stages) {
          stagesOf.set(name, stages);
          for (const stage of stages) names.push(`${name}/${stage}`);
        } else {
          names.push(name);
        }
      }
    }
    const measuring = this.profiler?.beginFrame(names) ?? false;
    const mark = measuring ? (e: GPUCommandEncoder) => this.profiler!.mark(e) : undefined;

    try {
      for (const name of this.executionOrder) {
        const staged = stagesOf.has(name);
        if (measuring && !staged) this.profiler!.mark(encoder);
        this.passes.get(name)!.execute(encoder, frame, resources, staged ? mark : undefined);
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
