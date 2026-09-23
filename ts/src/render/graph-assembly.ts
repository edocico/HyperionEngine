import { RenderGraph } from './render-graph';
import type { RenderPass } from './render-pass';

/** Which optional post-process chain the renderer has switched on. */
export interface GraphMode {
  outlines: boolean;
  bloom: boolean;
}

/**
 * Creates (and sets up) the passes of one graph. The renderer supplies these
 * because only it holds the device and the ResourcePool; keeping them behind
 * factories is what lets graph assembly be tested without a GPU.
 */
export interface GraphPassFactories {
  /** Scene passes, always present, in registration order: scatter, cull, radix-sort, forward. */
  scene(): RenderPass[];
  /** selection-seed → jfa-0..N → outline-composite. */
  outline(): RenderPass[];
  bloom(): RenderPass;
  fxaaTonemap(): RenderPass;
}

/**
 * Build the renderer's RenderGraph and compile it.
 *
 * Exactly ONE pass composites onto the swapchain: outline-composite, bloom or
 * fxaa-tonemap, in that order of precedence. Each is a blind full-screen write,
 * so a second one is a "multiple writers" error in `compile()` — adding
 * fxaa-tonemap unconditionally and trusting dead-pass culling to drop it never
 * worked, because the writer check runs before culling does. Factories are
 * called only for the passes this mode uses, so an unused composite never
 * allocates a pipeline.
 *
 * All or nothing, for JS exceptions: the new graph is built and compiled
 * BEFORE `previous` is touched. If that throws, the passes that reached the
 * new graph are destroyed, `previous` is returned to exactly as it was, and
 * the error propagates — the renderer keeps drawing with its old graph instead
 * of sitting on a destroyed, empty one. Not covered:
 * - WGSL compile errors. WebGPU does not throw on them: createShaderModule /
 *   createRenderPipeline return invalid objects and report asynchronously, so
 *   a broken shader still produces a graph that "succeeds".
 * - Passes a factory set up before it threw itself (they never reached the
 *   graph, so nothing here can destroy them).
 * - ResourcePool views the renderer's JFA/bloom texture helpers re-registered.
 *   Harmless: the graph kept either does not use them or looks them up by
 *   name every frame.
 *
 * @param external Passes owned by someone else (plugin overlays). Registered
 *   last, so as read-modify-writes of the swapchain they layer on the final
 *   image, in registration order.
 * @param previous The graph being replaced. On success it is destroyed, but
 *   `external` passes are detached from it first: their owner destroys them,
 *   and they carry over into the new graph.
 */
export function assembleRenderGraph(
  mode: GraphMode,
  factories: GraphPassFactories,
  external: Iterable<RenderPass>,
  previous?: RenderGraph,
): RenderGraph {
  const externals = [...external];
  const graph = new RenderGraph();
  const attached: RenderPass[] = [];

  try {
    for (const pass of factories.scene()) graph.addPass(pass);

    if (mode.outlines) {
      for (const pass of factories.outline()) graph.addPass(pass);
    } else if (mode.bloom) {
      graph.addPass(factories.bloom());
    } else {
      graph.addPass(factories.fxaaTonemap());
    }

    for (const pass of externals) {
      graph.addPass(pass);
      attached.push(pass);
    }

    graph.compile();
  } catch (err) {
    // Detach only the external instances actually attached: on a name clash
    // the pass registered under that name is the renderer's, and it must be
    // destroyed with the rest of this aborted graph.
    for (const pass of attached) graph.detachPass(pass.name);
    graph.destroy();
    throw err;
  }

  if (previous) {
    for (const pass of externals) previous.detachPass(pass.name);
    previous.destroy();
  }
  return graph;
}

/**
 * Passes owned by someone other than the renderer — plugin overlays.
 *
 * The renderer sets each one up once (only it holds the ResourcePool), carries
 * it over every graph rebuild, and never destroys it: the owner does, after
 * removing it.
 */
export class ExternalPasses {
  private readonly passes = new Map<string, RenderPass>();

  /** @param setup Runs once per added pass, after the pass is known to fit the graph. */
  constructor(private readonly setup: (pass: RenderPass) => void) {}

  /** In registration order — the order overlays draw in. */
  values(): IterableIterator<RenderPass> {
    return this.passes.values();
  }

  /**
   * Validate against `graph` NOW rather than on the next frame. A pass that
   * makes the graph uncompilable is rejected here, inside the caller's error
   * boundary (a plugin's install()), instead of throwing from render() inside
   * the requestAnimationFrame callback — which GameLoop does not catch, so the
   * loop would stop for good.
   */
  add(graph: RenderGraph, pass: RenderPass): void {
    graph.addPass(pass); // a duplicate name throws here, with nothing recorded
    try {
      graph.compile();
      this.setup(pass);
    } catch (err) {
      graph.detachPass(pass.name);
      throw err;
    }
    this.passes.set(pass.name, pass);
  }

  /** Detach the pass without destroying it. Names this registry does not own are ignored. */
  remove(graph: RenderGraph, name: string): void {
    if (!this.passes.delete(name)) return;
    graph.detachPass(name);
  }

  /** Detach every owned pass from `graph`, e.g. before the renderer destroys it. */
  detachAll(graph: RenderGraph): void {
    for (const name of this.passes.keys()) graph.detachPass(name);
  }
}
