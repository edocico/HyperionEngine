import type { GraphMode } from './graph-assembly';
import type { GpuValidation, RequestResult } from './graph-host';

/** A render-graph mode plus the options its composite pass is built with. */
export interface GraphRequest<O, B> {
  mode: GraphMode;
  outlineOptions?: O;
  bloomConfig?: B;
}

/** One hot-reloadable shader: its static source, and how to prove a new one compiles. */
export interface ShaderSlot {
  read(): string;
  write(source: string): void;
  /** Transform applied before probing and storing (cull prepends its subgroup directives). */
  prepare?(source: string): string;
  /**
   * Set up, then destroy, a throwaway pass that compiles this shader from the
   * slot's CURRENT source. Called inside a GPU validation window.
   */
  probe(): void;
  /** Whether a graph of `mode` contains a pass that compiles this shader. */
  usedBy(mode: GraphMode): boolean;
}

export interface GraphRequestsDeps<O, B> {
  host: { request(mode: GraphMode): Promise<RequestResult>; readonly mode: GraphMode };
  validation: GpuValidation;
  slots: Readonly<Record<string, ShaderSlot>>;
  /** Push new outline options into the live outline composite. Called only while one is live. */
  applyOutlineOptions(options: O): void;
  /** Push a new bloom config into the live bloom pass. Called only while one is live. */
  applyBloomConfig(config: B | undefined): void;
  log: Pick<Console, 'log' | 'warn' | 'error'>;
}

export type ReloadOutcome = RequestResult['outcome'] | 'validated' | 'unknown';

const BASE: GraphMode = { outlines: false, bloom: false };
type Feature = 'outlines' | 'bloom';

/**
 * The renderer's side of graph requests: which mode the caller asked for, and
 * shader hot-reload.
 *
 * A reloaded shader is validated ON ITS OWN before anything else sees it: its
 * source is written to the static slot only for the synchronous duration of
 * the probe, and kept only once the GPU reports no error. So the static slots
 * only ever hold sources that compiled, no graph is built from an unvalidated
 * one, and a broken file in a batch (Save All, a checkout) cannot take a valid
 * one down with it. A graph is rebuilt only when the requested mode uses the
 * shader; one it does not use is validated and kept for later.
 *
 * If the GPU nevertheless rejects a graph, every slot goes back to the source
 * the live graph was built from, and `requested` to the live mode.
 */
export class GraphRequests<O, B> {
  private wanted: GraphRequest<O, B> = { mode: BASE };
  private live: GraphRequest<O, B> = this.wanted;
  /** Per slot, the last source known good: in the live graph, or validated on its own. */
  private readonly goodSources = new Map<string, string>();
  /** Reload generation per slot: a result is acted on only if no newer reload started. */
  private readonly versions = new Map<string, number>();
  /** Features switched off while a request that replaces them was pending: honoured if it is rejected. */
  private readonly offIntents = new Set<Feature>();
  /** Sequence of requestGraph calls: a verdict booked after a newer call must not undo its state. */
  private requestSeq = 0;
  /** A shader the live graph uses was validated while a switch away was pending: rebuild if that switch fails. */
  private liveStale = false;

  constructor(private readonly deps: GraphRequestsDeps<O, B>) {
    for (const [name, slot] of Object.entries(deps.slots)) this.goodSources.set(name, slot.read());
  }

  /** What the caller asked for. The live graph catches up once the GPU accepts it. */
  get requested(): GraphRequest<O, B> {
    return this.wanted;
  }

  enableOutlines(options: O): void {
    this.offIntents.delete('outlines');
    if (this.wanted.mode.outlines) {
      this.setOptions({ outlineOptions: options });
      if (this.deps.host.mode.outlines) this.deps.applyOutlineOptions(options);
      return;
    }
    const hadBloom = this.wanted.mode.bloom;
    void this.requestGraph({ mode: { outlines: true, bloom: false }, outlineOptions: options }, 'Outlines')
      .then((r) => {
        if (r.outcome === 'swapped' && hadBloom) {
          this.deps.log.warn('[Hyperion] Bloom and outlines are mutually exclusive. Disabled bloom.');
        }
      });
  }

  disableOutlines(): void {
    this.disable('outlines', 'Disabling outlines');
  }

  enableBloom(config?: B): void {
    this.offIntents.delete('bloom');
    if (this.wanted.mode.bloom) {
      this.setOptions({ bloomConfig: config });
      if (this.deps.host.mode.bloom) this.deps.applyBloomConfig(config);
      return;
    }
    const hadOutlines = this.wanted.mode.outlines;
    void this.requestGraph({ mode: { outlines: false, bloom: true }, bloomConfig: config }, 'Bloom')
      .then((r) => {
        if (r.outcome === 'swapped' && hadOutlines) {
          this.deps.log.warn('[Hyperion] Bloom and outlines are mutually exclusive. Disabled outlines.');
        }
      });
  }

  disableBloom(): void {
    this.disable('bloom', 'Disabling bloom');
  }

  /**
   * Hot-reload one shader. Resolves when settled: 'rejected' (the old source
   * stays), 'validated' (kept; the requested mode does not use it), a graph
   * outcome when it triggered a rebuild, or 'superseded' by a newer reload of
   * the same shader.
   */
  reloadShader(name: string, code: string): Promise<ReloadOutcome> {
    const slot = this.deps.slots[name];
    if (!slot) {
      this.deps.log.warn(`[Hyperion] Unknown shader pass: ${name}`);
      return Promise.resolve('unknown');
    }
    const source = slot.prepare ? slot.prepare(code) : code;

    let verdict: Promise<string[]>;
    const current = slot.read();
    slot.write(source);
    try {
      verdict = this.deps.validation.run(() => slot.probe());
    } catch (err) {
      this.deps.log.error(`[Hyperion] Shader "${name}" did not compile — keeping the previous source:`, err);
      return Promise.resolve('rejected');
    } finally {
      // Synchronous: nothing else can have observed the unvalidated source.
      slot.write(current);
    }
    // Only a reload whose probe started supersedes earlier ones: an empty file
    // (editors truncate before writing) must not cancel the edit in flight.
    const version = (this.versions.get(name) ?? 0) + 1;
    this.versions.set(name, version);

    return verdict.then(async (messages): Promise<ReloadOutcome> => {
      if (this.versions.get(name) !== version) return 'superseded';
      if (messages.length > 0) {
        this.deps.log.error(
          `[Hyperion] Shader "${name}" rejected by the GPU — keeping the previous source:\n${messages.join('\n')}`,
        );
        return 'rejected';
      }
      slot.write(source);
      if (!slot.usedBy(this.wanted.mode)) {
        this.goodSources.set(name, source);
        if (slot.usedBy(this.deps.host.mode)) this.liveStale = true;
        this.deps.log.log(`[Hyperion] Shader "${name}" validated — takes effect when a mode that uses it is on`);
        return 'validated';
      }
      const result = await this.requestGraph(this.wanted, `Shader "${name}"`);
      if (result.outcome === 'swapped') this.deps.log.log(`[Hyperion] Shader "${name}" hot-reloaded`);
      return result.outcome;
    });
  }

  private setOptions(options: Partial<Pick<GraphRequest<O, B>, 'outlineOptions' | 'bloomConfig'>>): void {
    const liveIsWanted = this.live.mode.outlines === this.wanted.mode.outlines
      && this.live.mode.bloom === this.wanted.mode.bloom;
    this.wanted = { ...this.wanted, ...options };
    if (liveIsWanted) this.live = { ...this.live, ...options };
  }

  private disable(feature: Feature, what: string): void {
    if (this.wanted.mode[feature]) {
      void this.requestGraph({ mode: BASE }, what);
    } else if (this.deps.host.mode[feature]) {
      // A pending request already drops it — unless the GPU rejects that request.
      this.offIntents.add(feature);
    }
  }

  /**
   * Ask the host for a graph. `requested` changes now; on a synchronous
   * failure it is restored and the error rethrown.
   */
  private requestGraph(next: GraphRequest<O, B>, what: string): Promise<RequestResult> {
    const previous = this.wanted;
    const sources = this.snapshotSources();
    this.wanted = next;
    let pending: Promise<RequestResult>;
    try {
      pending = this.deps.host.request(next.mode);
    } catch (err) {
      this.wanted = previous;
      throw err;
    }
    const seq = ++this.requestSeq;

    return pending.then((result) => {
      // The host acted on this verdict a microtask ago. A requestGraph made
      // since then owns `wanted`, the sources and the intents: book only
      // what is certain — which graph is live now.
      const latest = seq === this.requestSeq;
      if (result.outcome === 'swapped') {
        this.live = latest ? this.wanted : next;
        for (const [name, src] of sources) {
          // Slots this mode does not compile keep what they had: a shader
          // validated on its own meanwhile must not be put back.
          if (this.deps.slots[name].usedBy(next.mode)) this.goodSources.set(name, src);
        }
        if (latest) {
          this.offIntents.clear();
          this.liveStale = false;
        }
      } else if (result.outcome === 'rejected') {
        const reverted = latest ? this.restoreGoodSources(next.mode) : [];
        this.deps.log.error(
          `[Hyperion] ${what} rejected by the GPU — keeping the previous render graph:\n${result.errors.join('\n')}` +
          (reverted.length > 0 ? `\nShader sources reverted to the live graph's: ${reverted.join(', ')}` : ''),
        );
        if (latest) {
          this.wanted = this.live;
          if (!this.honourOffIntents() && this.liveStale) {
            this.liveStale = false;
            void this.requestGraph(this.live, 'Rebuilding the live graph with reloaded shaders');
          }
        }
      }
      return result;
    });
  }

  /** Re-issue a disable that a rejected request would have carried out. True if it requested a graph. */
  private honourOffIntents(): boolean {
    const intents = [...this.offIntents];
    this.offIntents.clear();
    let requested = false;
    for (const feature of intents) {
      if (this.wanted.mode[feature]) {
        void this.requestGraph({ mode: BASE }, feature === 'bloom' ? 'Disabling bloom' : 'Disabling outlines');
        requested = true;
      }
    }
    return requested;
  }

  private snapshotSources(): Map<string, string> {
    const sources = new Map<string, string>();
    for (const [name, slot] of Object.entries(this.deps.slots)) sources.set(name, slot.read());
    return sources;
  }

  /**
   * After `rejected` was rejected, put back the sources of the slots it
   * compiles — the only ones that can have caused it. Every slot holds a
   * source validated on its own, so this is about combinations, not typos.
   */
  private restoreGoodSources(rejected: GraphMode): string[] {
    const reverted: string[] = [];
    for (const [name, slot] of Object.entries(this.deps.slots)) {
      if (!slot.usedBy(rejected)) continue;
      const good = this.goodSources.get(name);
      if (good !== undefined && slot.read() !== good) {
        slot.write(good);
        reverted.push(name);
      }
    }
    return reverted;
  }
}
