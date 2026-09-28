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
   *
   * Slots may share ONE probe function (the primitive pieces: every piece is
   * compiled by the same passes). `reloadShaders` then runs it once per probe
   * set, not once per slot — share it only when it compiles everything each
   * of those slots needs.
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

/** A slot, and the prepared source a reload wants to put in it. */
interface ReloadCandidate {
  name: string;
  slot: ShaderSlot;
  source: string;
}

/** One write-probe-restore: a synchronous throw, or the GPU's verdict to come. */
type ProbeRun = { threw: true; error: unknown } | { threw: false; messages: Promise<string[]> };

/** `Shader "a"` or `Shaders "a", "b"`, for the log. */
function shaderLabel(entries: ReadonlyArray<{ name: string }>): string {
  const names = entries.map((e) => `"${e.name}"`).join(', ');
  return entries.length === 1 ? `Shader ${names}` : `Shaders ${names}`;
}

function sameMode(a: GraphMode, b: GraphMode): boolean {
  return a.outlines === b.outlines && a.bloom === b.bloom && a.lighting === b.lighting;
}

const BASE: GraphMode = { outlines: false, bloom: false, lighting: false };
type Feature = 'outlines' | 'bloom' | 'lighting';
const DISABLING: Record<Feature, string> = {
  outlines: 'Disabling outlines',
  bloom: 'Disabling bloom',
  lighting: 'Disabling lighting',
};

/**
 * The renderer's side of graph requests: which mode the caller asked for, and
 * shader hot-reload.
 *
 * A reloaded shader is validated before anything else sees it: its source is
 * written to the static slot only for the synchronous duration of the probe,
 * and kept only once the GPU reports no error. So the static slots only ever
 * hold sources that compiled, and a graph is rebuilt only when the requested
 * mode uses the shader; one it does not use is validated and kept for later.
 *
 * Shaders that depend on each other (the primitive pieces: a prelude rename
 * and its uses in a library) are reloaded as a group by `reloadShaders`:
 * validated together, and alone as a fallback. It never requests a graph
 * from a set a probe rejected, or from one no probe tried together over the
 * sources current when it commits: if another reload committed while it
 * waited for the GPU, it probes its set again. (`reloadShader`, one shader,
 * commits on the verdict of its own probe.) With independent files, a broken
 * one in a batch (Save All, a checkout) cannot take a valid one down with it.
 * Two declared limits, both fixed by saving the pieces again: a coupled edit
 * saved together with an unrelated broken piece is rejected whole, and so is
 * a coupled window one of whose pieces is saved again before its verdict.
 *
 * If the GPU nevertheless rejects a graph, every slot goes back to the source
 * the live graph was built from, and `requested` to the live mode.
 *
 * Lighting is orthogonal to the composite (outlines / bloom / fxaa-tonemap):
 * switching one keeps the other.
 */
export class GraphRequests<O, B> {
  private wanted: GraphRequest<O, B> = { mode: BASE };
  private live: GraphRequest<O, B> = this.wanted;
  /** Per slot, the last source known good: in the live graph, or validated on its own. */
  private readonly goodSources = new Map<string, string>();
  /** Reload generation per slot: a result is acted on only if no newer reload started. */
  private readonly versions = new Map<string, number>();
  /**
   * Features switched off while the live graph still has them. If a request is
   * rejected before a graph without them goes live, they are requested off
   * again (unless that exact graph is the one just rejected).
   */
  private readonly offIntents = new Set<Feature>();
  /** Sequence of requestGraph calls: a verdict booked after a newer call must not undo its state. */
  private requestSeq = 0;
  /** A shader the live graph uses was validated while a switch away was pending: rebuild if that switch fails. */
  private liveStale = false;
  /**
   * Committing writes so far: a reload keeping its source, a revert after a
   * rejected graph (not the write-probe-restore of a probe). A verdict is
   * about the sources current when its probe ran: `reloadShaders` probes its
   * set again when this moved in between.
   */
  private commits = 0;

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
    const mode = { ...this.wanted.mode, outlines: true, bloom: false };
    void this.requestGraph({ mode, outlineOptions: options }, 'Outlines')
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
    const mode = { ...this.wanted.mode, outlines: false, bloom: true };
    void this.requestGraph({ mode, bloomConfig: config }, 'Bloom')
      .then((r) => {
        if (r.outcome === 'swapped' && hadOutlines) {
          this.deps.log.warn('[Hyperion] Bloom and outlines are mutually exclusive. Disabled outlines.');
        }
      });
  }

  disableBloom(): void {
    this.disable('bloom', 'Disabling bloom');
  }

  /** Switch the light chain (backend 'lit') on or off, keeping the composite and its options. */
  setLighting(enabled: boolean): void {
    if (!enabled) {
      this.disable('lighting', DISABLING.lighting);
      return;
    }
    this.offIntents.delete('lighting');
    if (this.wanted.mode.lighting) return;
    void this.requestGraph({ ...this.wanted, mode: { ...this.wanted.mode, lighting: true } }, 'Lighting');
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
      this.commits++;
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

  /**
   * Hot-reload several shaders at once: the primitive pieces of one HMR
   * window (`PieceReloadCollector`). In ONE synchronous window it probes the
   * UNION (every candidate written over the current sources), then each entry
   * ALONE (only it written). Each probe is its own write-probe-restore, so
   * nothing unvalidated survives the window, and a probe that throws
   * synchronously is that probe's rejection. Then:
   * - the union passes: every entry is kept, one graph request;
   * - the union fails and every entry passes alone: they conflict with each
   *   other (say, a duplicate top-level name). All are rejected, nothing is
   *   written, no graph is requested, and a pending mode request is left alone;
   * - the union fails and only some pass alone: those are written, probed and
   *   restored once more TOGETHER, over the sources current then, and a graph
   *   is requested only if that passes.
   *
   * A verdict is about the sources current when its probe ran. If another
   * reload committed, or a rejected graph reverted the sources, while this
   * call waited for the GPU, the kept set — a lone entry too — is written,
   * probed and restored again over the current sources, until a verdict
   * arrives with nothing committed in between, or the set is rejected.
   *
   * Versions are the ones `reloadShader` uses, per name: each entry whose
   * probe reached the GPU bumps its version (an entry that threw — an empty
   * piece — supersedes nothing), and an entry whose version moved before the
   * verdict (a later window, a direct `reloadShader`) is dropped as
   * 'superseded'. Declared limit: a coupled window (a prelude rename + its
   * uses) that loses an entry this way loses its partner too — the rest is
   * rejected unless it compiles alone, and the newer window, probed over the
   * rest's OLD text, usually fails as well. Both pieces must then be saved
   * again, together.
   *
   * Resolves to one outcome per name.
   */
  async reloadShaders(entries: ReadonlyArray<{ name: string; code: string }>): Promise<Map<string, ReloadOutcome>> {
    const outcomes = new Map<string, ReloadOutcome>();
    const byName = new Map<string, ReloadCandidate>();
    for (const { name, code } of entries) {
      const slot = this.deps.slots[name];
      if (!slot) {
        this.deps.log.warn(`[Hyperion] Unknown shader pass: ${name}`);
        outcomes.set(name, 'unknown');
        continue;
      }
      // One candidate per name: the last entry wins.
      byName.set(name, { name, slot, source: slot.prepare ? slot.prepare(code) : code });
    }
    const candidates = [...byName.values()];
    if (candidates.length === 0) return outcomes;

    // --- One synchronous window: the union, then each entry alone. ---
    // Every verdict below is about the sources as they are now.
    const startCommits = this.commits;
    const union = this.probeTogether(candidates);
    const solos = candidates.length === 1 ? [union] : candidates.map((c) => this.probeTogether([c]));
    const probed: Array<ReloadCandidate & { version: number; solo: Promise<string[]> }> = [];
    candidates.forEach((candidate, i) => {
      const solo = solos[i];
      if (solo.threw) {
        this.deps.log.error(
          `[Hyperion] Shader "${candidate.name}" did not compile — keeping the previous source:`, solo.error,
        );
        outcomes.set(candidate.name, 'rejected');
        return;
      }
      // Only an entry whose probe started supersedes earlier reloads.
      const version = (this.versions.get(candidate.name) ?? 0) + 1;
      this.versions.set(candidate.name, version);
      probed.push({ ...candidate, version, solo: solo.messages });
    });
    if (probed.length === 0) return outcomes;

    const unionErrors = union.threw ? [String(union.error)] : await union.messages;
    const soloErrors = await Promise.all(probed.map((c) => c.solo));
    const isCurrent = (c: { name: string; version: number }): boolean => this.versions.get(c.name) === c.version;

    const alive: Array<(typeof probed)[number] & { errors: string[] }> = [];
    probed.forEach((c, i) => {
      if (isCurrent(c)) alive.push({ ...c, errors: soloErrors[i] });
      else outcomes.set(c.name, 'superseded');
    });

    let keep: typeof alive;
    /** The commit count at which `keep` compiled as one set; null: never tried together. */
    let provenAt: number | null;
    // Proven by the union only if every candidate is still in: an entry that
    // threw or was superseded leaves a subset no probe tried together.
    if (unionErrors.length === 0 && alive.length === candidates.length) {
      keep = alive;
      provenAt = startCommits;
    } else {
      keep = [];
      for (const c of alive) {
        if (c.errors.length === 0) {
          keep.push(c);
          continue;
        }
        outcomes.set(c.name, 'rejected');
        this.deps.log.error(
          `[Hyperion] Shader "${c.name}" rejected by the GPU — keeping the previous source:\n${c.errors.join('\n')}`,
        );
      }
      if (unionErrors.length > 0 && keep.length === candidates.length) {
        // Each compiles alone, not together: writing them would build a graph
        // from the very set the union probe rejected.
        for (const c of keep) outcomes.set(c.name, 'rejected');
        this.deps.log.error(
          `[Hyperion] ${shaderLabel(keep)} compile alone but not together — keeping the previous sources:\n${unionErrors.join('\n')}`,
        );
        return outcomes;
      }
      // A single survivor was proven by its own probe; more must be tried together.
      provenAt = keep.length <= 1 ? startCommits : null;
    }

    // Write-probe-restore `keep` as one set over the CURRENT sources until a
    // verdict is about sources still current: another reload may have
    // committed while this one waited for the GPU, and its sources plus
    // `keep` are a set no probe tried. A lone survivor is no exception.
    while (keep.length > 0 && provenAt !== this.commits) {
      const at = this.commits;
      const again = this.probeTogether(keep);
      const errors = again.threw ? [String(again.error)] : await again.messages;
      const current = keep.filter(isCurrent);
      if (current.length < keep.length) {
        // A member was reloaded again meanwhile: this verdict was about another set.
        for (const c of keep) if (!isCurrent(c)) outcomes.set(c.name, 'superseded');
        keep = current;
        // A lone survivor that compiled alone did so over this call's first
        // sources; any other set left has not been tried as it is.
        provenAt = keep.length === 1 && keep[0].errors.length === 0 ? startCommits : null;
        continue;
      }
      if (errors.length > 0) {
        for (const c of keep) outcomes.set(c.name, 'rejected');
        const why = at === startCommits
          ? 'compile alone but not together'
          : 'rejected over the sources another reload committed meanwhile';
        this.deps.log.error(
          `[Hyperion] ${shaderLabel(keep)} ${why} — keeping the previous sources:\n${errors.join('\n')}`,
        );
        return outcomes;
      }
      provenAt = at;
    }
    if (keep.length === 0) return outcomes;

    // Synchronous since the loop's last check: the counter is still provenAt.
    this.commits++;
    for (const c of keep) c.slot.write(c.source);
    const unused = keep.filter((c) => !c.slot.usedBy(this.wanted.mode));
    const used = keep.filter((c) => c.slot.usedBy(this.wanted.mode));
    for (const c of unused) {
      this.goodSources.set(c.name, c.source);
      if (c.slot.usedBy(this.deps.host.mode)) this.liveStale = true;
      outcomes.set(c.name, 'validated');
    }
    if (unused.length > 0) {
      this.deps.log.log(`[Hyperion] ${shaderLabel(unused)} validated — takes effect when a mode that uses it is on`);
    }
    if (used.length === 0) return outcomes;
    const result = await this.requestGraph(this.wanted, shaderLabel(used));
    if (result.outcome === 'swapped') this.deps.log.log(`[Hyperion] ${shaderLabel(used)} hot-reloaded`);
    for (const c of used) outcomes.set(c.name, result.outcome);
    return outcomes;
  }

  /**
   * Write every candidate over the current sources, probe once, and put the
   * current sources back — all synchronous, so no graph build can see the
   * probed text. Slots sharing one probe function compile it once.
   */
  private probeTogether(set: readonly ReloadCandidate[]): ProbeRun {
    const current = set.map((c) => c.slot.read());
    try {
      for (const c of set) c.slot.write(c.source);
      const byProbe = new Map<() => void, ShaderSlot>();
      for (const c of set) byProbe.set(c.slot.probe, c.slot);
      const messages = this.deps.validation.run(() => {
        for (const slot of byProbe.values()) slot.probe();
      });
      return { threw: false, messages };
    } catch (error) {
      return { threw: true, error };
    } finally {
      for (let i = set.length - 1; i >= 0; i--) set[i].slot.write(current[i]);
    }
  }

  private setOptions(options: Partial<Pick<GraphRequest<O, B>, 'outlineOptions' | 'bloomConfig'>>): void {
    const liveIsWanted = this.live.mode.outlines === this.wanted.mode.outlines
      && this.live.mode.bloom === this.wanted.mode.bloom;
    this.wanted = { ...this.wanted, ...options };
    if (liveIsWanted) this.live = { ...this.live, ...options };
  }

  private disable(feature: Feature, what: string): void {
    // Remembered until a graph without it goes live: the request below, or a
    // later one carrying it, may be rejected, and `requested` then falls back
    // to the live graph, which still has the feature on.
    if (this.deps.host.mode[feature]) this.offIntents.add(feature);
    if (this.wanted.mode[feature]) void this.requestGraph(this.without(feature), what);
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
          if (!this.honourOffIntents(next.mode) && this.liveStale) {
            this.liveStale = false;
            void this.requestGraph(this.live, 'Rebuilding the live graph with reloaded shaders');
          }
        }
      }
      return result;
    });
  }

  /** Re-issue a disable that a rejected request would have carried out. True if it requested a graph. */
  private honourOffIntents(rejected: GraphMode): boolean {
    const intents = [...this.offIntents].filter((feature) => this.wanted.mode[feature]);
    this.offIntents.clear();
    if (intents.length === 0) return false;
    let target = this.wanted;
    for (const feature of intents) target = this.without(feature, target);
    // The same graph was just rejected: asking again would fail again.
    if (sameMode(target.mode, rejected)) return false;
    void this.requestGraph(target, intents.map((feature) => DISABLING[feature]).join(', '));
    return true;
  }

  /**
   * The wanted request with `feature` off. Dropping a composite drops its
   * options too; dropping lighting keeps the composite's.
   */
  private without(feature: Feature, from: GraphRequest<O, B> = this.wanted): GraphRequest<O, B> {
    const mode = { ...from.mode, [feature]: false };
    return feature === 'lighting' ? { ...from, mode } : { mode };
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
        this.commits++;
        slot.write(good);
        reverted.push(name);
      }
    }
    return reverted;
  }
}
