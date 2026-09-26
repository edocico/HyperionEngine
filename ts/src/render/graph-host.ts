import type { RenderGraph } from './render-graph';
import type { RenderPass } from './render-pass';
import { composeRenderGraph, type GraphMode, type GraphPassFactories } from './graph-assembly';

/**
 * Asks the GPU whether a piece of work was valid.
 *
 * WebGPU does not throw on a WGSL compile error or an invalid pipeline:
 * `createShaderModule` / `createRenderPipeline` hand back invalid objects and
 * the error surfaces asynchronously. Error scopes are how to hear about it.
 */
export interface GpuValidation {
  /**
   * Run `fn` inside GPU error scopes. Throws what `fn` throws; otherwise
   * resolves to the messages of the GPU errors it raised — empty when valid.
   */
  run(fn: () => void): Promise<string[]>;
}

const ERROR_SCOPES: GPUErrorFilter[] = ['internal', 'out-of-memory', 'validation'];

export function createGpuValidation(
  device: Pick<GPUDevice, 'pushErrorScope' | 'popErrorScope'>,
): GpuValidation {
  return {
    run(fn) {
      for (const filter of ERROR_SCOPES) device.pushErrorScope(filter);
      let failure: { error: unknown } | null = null;
      try {
        fn();
      } catch (error) {
        failure = { error };
      }
      // Pop every scope even when fn threw: an unbalanced stack would swallow
      // the errors of whatever runs next on this device.
      const popped = ERROR_SCOPES.map(() => device.popErrorScope());
      if (failure) {
        void Promise.allSettled(popped);
        throw failure.error;
      }
      // A pop that rejects (OperationError: some code in fn popped one of our
      // scopes, leaving the stack short) counts as an error: the work cannot
      // be vouched for, and a rejection here would otherwise leave a request
      // pending forever. (On a lost device pops resolve null, not reject.)
      return Promise.allSettled(popped).then((results) => results.flatMap((r) => {
        if (r.status === 'rejected') return [`popErrorScope failed: ${String(r.reason)}`];
        return r.value ? [r.value.message] : [];
      }));
    },
  };
}

export interface RenderGraphHostOptions {
  factories: GraphPassFactories;
  /** GPU set-up of one pass. */
  setup(pass: RenderPass): void;
  /** GPU resources a mode's passes need before they are set up (JFA / bloom textures). */
  prepare(mode: GraphMode): void;
  validation: GpuValidation;
  /** A graph went live. `owned` are the renderer's passes in it. */
  onSwap(graph: RenderGraph, owned: readonly RenderPass[], mode: GraphMode): void;
  /** Problems with no caller left to throw to: the initial build, an overlay's asynchronous GPU errors. */
  onError(message: string): void;
}

export type RequestOutcome = 'swapped' | 'rejected' | 'superseded';

export interface RequestResult {
  outcome: RequestOutcome;
  /** GPU error messages — the reason for a rejection. */
  errors: string[];
}

interface Built {
  graph: RenderGraph;
  owned: RenderPass[];
  mode: GraphMode;
}

const COMPOSITES: ReadonlyArray<readonly [label: string, mode: Omit<GraphMode, 'lighting'>]> = [
  ['fxaa-tonemap', { outlines: false, bloom: false }],
  ['outlines', { outlines: true, bloom: false }],
  ['bloom', { outlines: false, bloom: true }],
];

/** Every graph the renderer can build: each composite, with and without lighting. */
const MODES: ReadonlyArray<readonly [label: string, mode: GraphMode]> = COMPOSITES.flatMap(([label, mode]) => [
  [label, { ...mode, lighting: false }] as const,
  [`${label} + lighting`, { ...mode, lighting: true }] as const,
]);

/**
 * Owns the renderer's RenderGraph across mode switches and shader hot-reloads.
 *
 * A requested graph is composed, set up and then left PENDING while the live
 * one keeps drawing. It replaces the live graph only once the GPU has reported
 * no error for its set-up; otherwise it is thrown away and the live graph
 * stays. So a broken shader — which WebGPU reports asynchronously, never by
 * throwing — no longer replaces a working graph.
 *
 * External passes (plugin overlays) are owned by the caller: set up once when
 * added, carried into every graph, never destroyed here.
 */
export class RenderGraphHost {
  private live: Built;
  private pending: (Built & { generation: number }) | null = null;
  private generation = 0;
  private destroyed = false;
  /** Validated, and attached to the live (and any pending) graph. */
  private readonly externals = new Map<string, RenderPass>();
  /** Added, set-up validation in flight: in no graph yet. The token tells a stale verdict apart. */
  private readonly staging = new Map<string, { pass: RenderPass; token: number }>();
  private tokens = 0;

  constructor(private readonly opts: RenderGraphHostOptions, initialMode: GraphMode) {
    const { built, errors } = this.build(initialMode);
    this.live = built;
    // There is no earlier graph to fall back to: report and carry on.
    void errors.then((messages) => {
      if (messages.length > 0) {
        opts.onError(`[Hyperion] The initial render graph raised GPU errors:\n${messages.join('\n')}`);
      }
    });
    opts.onSwap(built.graph, built.owned, built.mode);
  }

  /** The graph drawing now. */
  get graph(): RenderGraph {
    return this.live.graph;
  }

  /** The mode of the graph drawing now — not of a pending request. */
  get mode(): GraphMode {
    return this.live.mode;
  }

  get isPending(): boolean {
    return this.pending !== null;
  }

  /**
   * Build a graph for `mode` and make it live once the GPU accepts it.
   *
   * Throws synchronously — leaving the live graph and any pending request as
   * they were — when the graph does not compile or a pass's `setup()` throws.
   * Otherwise resolves once the GPU has answered: 'swapped', 'rejected' (with
   * the GPU's messages), or 'superseded' by a later request.
   */
  request(mode: GraphMode): Promise<RequestResult> {
    const { built, errors } = this.build(mode);
    if (this.pending) this.retire(this.pending);
    const generation = ++this.generation;
    this.pending = { ...built, generation };

    return errors.then((messages): RequestResult => {
      if (this.pending?.generation !== generation) return { outcome: 'superseded', errors: messages };
      const staged = this.pending;
      this.pending = null;
      if (messages.length > 0) {
        this.retire(staged);
        return { outcome: 'rejected', errors: messages };
      }
      this.retire(this.live);
      this.live = { graph: staged.graph, owned: staged.owned, mode: staged.mode };
      this.opts.onSwap(this.live.graph, this.live.owned, this.live.mode);
      return { outcome: 'swapped', errors: [] };
    });
  }

  /**
   * Add a caller-owned pass. Validated against EVERY mode's graph, not only
   * the live one: a pass that fits today's graph but clashes with another
   * mode ('bloom', 'jfa-N', a blind write of 'selection-seed', 'light-groups')
   * would make switching to that mode fail. Throws, adding nothing, if it does not fit
   * or its `setup()` throws.
   *
   * The pass joins the graphs only once the GPU has validated its set-up — an
   * invalid pipeline in the shared command buffer would drop whole frames. If
   * the GPU reports errors it never joins, and they go to `onError`.
   */
  addExternal(pass: RenderPass): void {
    if (this.externals.has(pass.name) || this.staging.has(pass.name)) {
      throw new Error(`RenderPass '${pass.name}' already registered`);
    }
    const candidates = [
      ...this.externals.values(), ...[...this.staging.values()].map((s) => s.pass), pass,
    ];
    for (const [label, mode] of MODES) {
      try {
        composeRenderGraph(mode, this.opts.factories, candidates);
      } catch (err) {
        throw new Error(
          `Pass '${pass.name}' does not fit the ${label} mode: ${(err as Error).message}`,
        );
      }
    }

    const errors = this.opts.validation.run(() => this.opts.setup(pass));
    const token = ++this.tokens;
    this.staging.set(pass.name, { pass, token });

    void errors.then((messages) => {
      if (this.staging.get(pass.name)?.token !== token) return; // removed, or added again since
      this.staging.delete(pass.name);
      if (messages.length > 0) {
        this.opts.onError(
          `[Hyperion] Pass '${pass.name}' raised GPU errors during setup and was not added:\n${messages.join('\n')}`,
        );
        return;
      }
      this.attach(pass);
    });
  }

  /** Detach a caller-owned pass WITHOUT destroying it. Names it does not own are ignored. */
  removeExternal(name: string): void {
    if (this.staging.delete(name)) return;
    if (!this.externals.delete(name)) return;
    this.live.graph.detachPass(name);
    this.pending?.graph.detachPass(name);
  }

  /** Retire the live and any pending graph. External passes are detached, not destroyed. */
  destroy(): void {
    this.destroyed = true;
    this.staging.clear();
    if (this.pending) {
      this.retire(this.pending);
      this.pending = null;
    }
    this.retire(this.live);
  }

  /**
   * Compose, prepare and set up a graph for `mode`. On a compile or set-up
   * throw nothing stays allocated: composition does no GPU work, and a graph
   * whose set-up threw is retired — including passes set up before the throw.
   */
  private build(mode: GraphMode): { built: Built; errors: Promise<string[]> } {
    const { graph, owned } = composeRenderGraph(mode, this.opts.factories, this.externals.values());
    const built: Built = { graph, owned, mode };
    try {
      const errors = this.opts.validation.run(() => {
        this.opts.prepare(mode);
        for (const pass of owned) this.opts.setup(pass);
      });
      return { built, errors };
    } catch (err) {
      this.retire(built);
      throw err;
    }
  }

  /**
   * Put a validated external into the live and any pending graph, all or
   * nothing. Each graph is compiled here, not on the next frame: validation
   * composed fresh graphs, and one built at another canvas size can differ
   * (the JFA chain length), so a clash would otherwise throw from render().
   */
  private attach(pass: RenderPass): void {
    if (this.destroyed) return;
    const graphs = this.pending ? [this.pending.graph, this.live.graph] : [this.live.graph];
    const done: RenderGraph[] = [];
    try {
      for (const graph of graphs) {
        graph.addPass(pass);
        done.push(graph);
        graph.compile();
      }
    } catch (err) {
      for (const graph of done) graph.detachPass(pass.name);
      this.opts.onError(`[Hyperion] Pass '${pass.name}' could not be added: ${(err as Error).message}`);
      return;
    }
    this.externals.set(pass.name, pass);
  }

  /** Destroy a graph and the renderer's passes in it — never the external ones. */
  private retire(built: Built): void {
    for (const name of this.externals.keys()) built.graph.detachPass(name);
    built.graph.destroy();
  }
}
