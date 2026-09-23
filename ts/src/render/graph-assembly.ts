import { RenderGraph } from './render-graph';
import type { RenderPass } from './render-pass';

/** Which optional post-process chain the renderer has switched on. */
export interface GraphMode {
  outlines: boolean;
  bloom: boolean;
}

/**
 * Constructs — only constructs — the passes of one graph. No GPU work here:
 * pass constructors need no device, and `setup()` runs later, once the graph
 * is known to compile (see RenderGraphHost). That split is what lets a graph
 * be composed just to validate it, and lets composition be tested headless.
 */
export interface GraphPassFactories {
  /** Scene passes, always present, in registration order: scatter, cull, radix-sort, forward. */
  scene(): RenderPass[];
  /** selection-seed → jfa-0..N → outline-composite. */
  outline(): RenderPass[];
  bloom(): RenderPass;
  fxaaTonemap(): RenderPass;
}

export interface ComposedGraph {
  graph: RenderGraph;
  /** The renderer's own passes in `graph` — not the external ones. */
  owned: RenderPass[];
}

/**
 * Compose the renderer's RenderGraph for `mode` and compile it. Pure: no pass
 * is set up, so a graph that does not compile throws and leaves nothing to
 * clean up.
 *
 * Exactly ONE pass composites onto the swapchain: outline-composite, bloom or
 * fxaa-tonemap, in that order of precedence. Each is a blind full-screen write,
 * so a second one is a "multiple writers" error in `compile()` — adding
 * fxaa-tonemap unconditionally and trusting dead-pass culling to drop it never
 * worked, because the writer check runs before culling does. Factories are
 * called only for the passes this mode uses.
 *
 * @param external Passes owned by someone else (plugin overlays). Registered
 *   last, so as read-modify-writes of the swapchain they layer on the final
 *   image, in registration order.
 */
export function composeRenderGraph(
  mode: GraphMode,
  factories: GraphPassFactories,
  external: Iterable<RenderPass>,
): ComposedGraph {
  const owned: RenderPass[] = [...factories.scene()];
  if (mode.outlines) {
    owned.push(...factories.outline());
  } else if (mode.bloom) {
    owned.push(factories.bloom());
  } else {
    owned.push(factories.fxaaTonemap());
  }

  const graph = new RenderGraph();
  for (const pass of owned) graph.addPass(pass);
  for (const pass of external) graph.addPass(pass);
  graph.compile();
  return { graph, owned };
}
