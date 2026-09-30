# Profiler GPU con `timestampWrites` sui pass veri — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Obiettivo:** sostituire i marker vuoti di `GpuProfiler`, che su Metal non vengono mai campionati, con una coppia di `timestampWrites` su ogni pass vero del grafo. In più: nomi degli stage con `stage()`, validità per coppia, sigillo del frame e span del frame (`getGpuFrameTiming()`).

**Architettura:**
- Due moduli nuovi e puri, testabili senza GPU:
  - `render/timestamp-intercept.ts`: intercettazione dell'encoder, descrittori, lavoro, nomi;
  - `render/timestamp-frames.ts`: validità, storia per indice, finestra e span.
- `render/gpu-profiler.ts` li orchestra, con query set, buffer, sigillo e readback.
- `RenderGraph.render` chiama il profiler solo nei frame misurati. I due pass con stage passano da `mark(encoder)` a `stage(nome)`.

**Tecnologie:** TypeScript 5.9 strict, WebGPU (`@webgpu/types`), vitest 4.1, Vite 6.4. Rust e WGSL non cambiano.

**Spec:** `docs/plans/2026-09-29-gpu-profiler-timestamp-writes-design.md` (HEAD `37470ff`). Si leggono insieme: la spec dice il perché, il piano il come.

## Vincoli globali

- Branch `test/mac-m2-gpu`.
  - Messaggi di commit in italiano dopo un prefisso convenzionale inglese, chiusi da `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Il push del branch è libero; il merge su master solo con il sì dell'utente.
- Lingue: codice, commenti, `CLAUDE.md` e `.claude/agents` in inglese; `docs/plans` e la handoff in italiano.
- `scripts/preflight.sh` è la definizione di "validato".
  - Ogni `npm`/`npx` gira con `--prefix ts`, e vitest con `--root ts`: `npx --prefix ts vitest run --root ts src/<file>.test.ts`.
- Nomi invariati:
  - `light-groups/seed`, `light-groups/sdf`, `light-groups/accum`;
  - `transparent-sort/gather`, `/upsweep`, `/scan`, `/scatter`;
  - i nomi dei nodi del grafo.
- Dimensioni:
  - `new GpuProfiler(device, maxPairs = 512)`, con un query set di `2 * maxPairs` query;
  - 3 readback di `2 * maxPairs * 8 + 8` byte, e un buffer `seal` di 4 byte (spec §4.6);
  - `WINDOW = 120`;
  - un avviso dopo 120 frame scartati di fila.
- Motivi di scarto, in quest'ordine di precedenza: `unexecuted`, `truncated`, `zero`, `reversed`, `stale`, `empty`.
- API pubblica nuova: `getGpuFrameTiming(): GpuFrameTiming | null`, dove `GpuFrameTiming = { averageMs: number; lastMs: number; sampleCount: number }`.
- Frame non misurato: nessuna chiamata al profiler, encoder nativo, `stage` indefinito.
- Un descrittore non si scrive mai: si passa `Object.create(desc ?? {}, { timestampWrites })`.

## Punti da guardare in review

Sono casi che la spec implica ma che nessun test dei task toccherebbe da solo; ciascuno ha il suo test nel task indicato.

1. **Ricostruzione del grafo con frame misurati in volo** (bloom, contorni, hot-reload): `reset()` li scarta e rende la storia sconosciuta. Il frame dopo misura normalmente, anche se i suoi stamp coincidono con quelli di prima. Test nel Task 3.
2. **Perdita del device durante la lettura** (`mapAsync` rifiutato): nessuna eccezione, il buffer torna libero, e gli indici di quel frame diventano sconosciuti. Test nel Task 3.
3. **Il numero del sigillo arriva a 0xFFFFFFFF**: riparte da 1, mai da 0, che è il valore che legge un frame rifiutato. Test nel Task 3 (`nextSeal`).
4. **Lo stesso oggetto descrittore usato per due pass nello stesso frame**: due coppie, e l'oggetto non viene mai scritto. Test nel Task 1.
5. **Un pass aperto con il metodo del prototipo**, come farebbe un encoder proprio: non misurato, senza errori, e senza spostare le coppie degli altri pass. Test nel Task 1.

---

### Task 1: intercettazione, descrittori, lavoro e nomi (`timestamp-intercept.ts`)

**File:**
- Crea: `ts/src/render/timestamp-intercept.ts`
- Test: `ts/src/render/timestamp-intercept.test.ts`

**Interfacce:**
- Usa: niente di nuovo, solo i tipi WebGPU.
- Produce, per i Task 2-3:
  - `interface TimedPair { readonly name: string; work: boolean }`;
  - `class FrameRecorder`:
    - `constructor(querySet: GPUQuerySet, maxPairs: number)`;
    - `readonly pairs: TimedPair[]`, `truncated: boolean`;
    - `enterNode(name: string, profiled: boolean): void`, `enterStage(stage: string): void`;
    - `derive<D extends object>(desc: D | undefined): { desc: D | undefined; pair: TimedPair | null }`;
  - `function instrumentEncoder(encoder: GPUCommandEncoder, recorder: FrameRecorder): void`;
  - `function drawDoesWork(count: number, instanceCount?: number): boolean`;
  - `function dispatchDoesWork(x: number, y?: number, z?: number): boolean`.

- [ ] **Passo 1: scrivi il test che fallisce**

`ts/src/render/timestamp-intercept.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FrameRecorder, instrumentEncoder, drawDoesWork, dispatchDoesWork } from './timestamp-intercept';

const querySet = { label: 'qs' } as unknown as GPUQuerySet;
type Desc = Record<string, unknown> | undefined;

/**
 * A command encoder whose methods live on its prototype, like the real
 * GPUCommandEncoder, so the tests can tell an own-property override from a
 * patched prototype. Its "native" methods record the descriptor they get and
 * return a pass encoder that logs every call.
 */
class FakeEncoder {
  readonly received: Desc[] = [];
  readonly calls: string[] = [];

  beginRenderPass(desc: GPURenderPassDescriptor): GPURenderPassEncoder {
    this.received.push(desc as unknown as Desc);
    return this.passEncoder() as unknown as GPURenderPassEncoder;
  }

  beginComputePass(desc?: GPUComputePassDescriptor): GPUComputePassEncoder {
    this.received.push(desc as unknown as Desc);
    return this.passEncoder() as unknown as GPUComputePassEncoder;
  }

  private passEncoder() {
    const log = (name: string) => (...args: unknown[]) => {
      this.calls.push(`${name}(${args.map((a) => (Array.isArray(a) ? `[${a.length}]` : String(a))).join(',')})`);
    };
    return {
      draw: log('draw'),
      drawIndexed: log('drawIndexed'),
      drawIndirect: log('drawIndirect'),
      drawIndexedIndirect: log('drawIndexedIndirect'),
      executeBundles: log('executeBundles'),
      dispatchWorkgroups: log('dispatchWorkgroups'),
      dispatchWorkgroupsIndirect: log('dispatchWorkgroupsIndirect'),
      end: log('end'),
    };
  }
}

function setUp(maxPairs = 8) {
  const fake = new FakeEncoder();
  const encoder = fake as unknown as GPUCommandEncoder;
  const recorder = new FrameRecorder(querySet, maxPairs);
  instrumentEncoder(encoder, recorder);
  return { fake, encoder, recorder };
}

const colour = () => ({ colorAttachments: [] }) as unknown as GPURenderPassDescriptor;
const own = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

describe('instrumentEncoder', () => {
  it('overrides begin*Pass as own properties of this encoder, never of its prototype or of another encoder', () => {
    const { fake } = setUp();
    expect(own(fake, 'beginRenderPass')).toBe(true);
    expect(own(fake, 'beginComputePass')).toBe(true);
    const other = new FakeEncoder();
    expect(own(other, 'beginRenderPass')).toBe(false);
    expect(other.beginComputePass).toBe(FakeEncoder.prototype.beginComputePass);
  });

  it('gives each timed pass the next pair, through a descriptor derived from the original', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('cull', true);
    encoder.beginComputePass({ label: 'cull' });
    recorder.enterNode('forward', true);
    const original = { label: 'forward', colorAttachments: [] } as unknown as GPURenderPassDescriptor;
    encoder.beginRenderPass(original);
    expect(fake.received.map((d) => d?.timestampWrites)).toEqual([
      { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
      { querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 },
    ]);
    expect(recorder.pairs.map((p) => p.name)).toEqual(['cull', 'forward']);
    // The original is never written; its members are read through the prototype.
    expect(own(original, 'timestampWrites')).toBe(false);
    expect(fake.received[1]?.label).toBe('forward');
    expect(fake.received[1]?.colorAttachments).toBe(original.colorAttachments);
  });

  it('a compute pass opened with no descriptor receives one that carries only the pair', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('scatter', true);
    encoder.beginComputePass();
    expect(fake.received[0]?.timestampWrites).toEqual({ querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
  });

  it('a descriptor with timestampWrites of its own passes through untouched and is not timed', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('plugin', true);
    const mine = { timestampWrites: { querySet: {} as GPUQuerySet, beginningOfPassWriteIndex: 5 } };
    encoder.beginComputePass(mine as GPUComputePassDescriptor);
    expect(fake.received[0]).toBe(mine);
    expect(recorder.pairs).toEqual([]);
  });

  it('one descriptor object reused for two passes gets two pairs and is never written', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('bloom', true);
    const shared = colour();
    encoder.beginRenderPass(shared);
    encoder.beginRenderPass(shared);
    expect(fake.received.map((d) => (d?.timestampWrites as { beginningOfPassWriteIndex: number }).beginningOfPassWriteIndex)).toEqual([0, 2]);
    expect(own(shared, 'timestampWrites')).toBe(false);
  });

  it('a pass opened through the prototype method is not timed and leaves the other pairs in place', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('a', true);
    encoder.beginComputePass({});
    FakeEncoder.prototype.beginComputePass.call(fake, { label: 'bypass' });
    encoder.beginComputePass({});
    expect(recorder.pairs).toHaveLength(2);
    expect(fake.received[1]).toEqual({ label: 'bypass' });
    expect(fake.received[2]?.timestampWrites).toMatchObject({ beginningOfPassWriteIndex: 2 });
  });

  it('forwards every call to the native pass encoder with the same arguments', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('forward', true);
    const pass = encoder.beginRenderPass(colour());
    pass.draw(3, 2, 1, 0);
    pass.executeBundles(new Set([{} as GPURenderBundle]));
    pass.end();
    expect(fake.calls).toEqual(['draw(3,2,1,0)', 'executeBundles([1])', 'end()']);
  });
});

describe('FrameRecorder names', () => {
  it('names passes after their node, node/stage after stage(), and the node again at the next node', () => {
    const { encoder, recorder } = setUp();
    recorder.enterNode('light-groups', true);
    encoder.beginRenderPass(colour());
    recorder.enterStage('seed');
    encoder.beginRenderPass(colour());
    recorder.enterStage('sdf');
    encoder.beginRenderPass(colour());
    encoder.beginRenderPass(colour());
    recorder.enterNode('forward', true);
    encoder.beginRenderPass(colour());
    expect(recorder.pairs.map((p) => p.name)).toEqual([
      'light-groups', 'light-groups/seed', 'light-groups/sdf', 'light-groups/sdf', 'forward',
    ]);
  });

  it('profile false: no pass of that node is timed, stage() does not re-enable it, the next node is timed', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('overlay', false);
    recorder.enterStage('x');
    const d = colour();
    encoder.beginRenderPass(d);
    recorder.enterNode('forward', true);
    encoder.beginRenderPass(colour());
    expect(recorder.pairs.map((p) => p.name)).toEqual(['forward']);
    expect(fake.received[0]).toBe(d);
  });

  it('passes opened before any node, and stage() before any node, are not timed', () => {
    const { encoder, recorder } = setUp();
    recorder.enterStage('x');
    encoder.beginRenderPass(colour());
    expect(recorder.pairs).toEqual([]);
  });

  it('beyond maxPairs a pass is not timed and the frame is marked truncated', () => {
    const { encoder, fake, recorder } = setUp(2);
    recorder.enterNode('p', true);
    for (let i = 0; i < 3; i++) encoder.beginComputePass({});
    expect(recorder.pairs).toHaveLength(2);
    expect(recorder.truncated).toBe(true);
    expect(fake.received[2]).toEqual({});
  });
});

describe('work', () => {
  it.each<[number[], boolean]>([
    [[3], true], [[0], false], [[3, 0], false], [[0.5], false], [[2.9, 1], true], [[3, 0.5], false],
  ])('drawDoesWork(%j) is %s: WebIDL reads the integer part', (args, expected) => {
    expect(drawDoesWork(...(args as [number, number?]))).toBe(expected);
  });

  it.each<[number[], boolean]>([
    [[1], true], [[0], false], [[4, 0, 1], false], [[4, 1, 0], false], [[0.9], false], [[2, 2, 2], true],
  ])('dispatchDoesWork(%j) is %s', (args, expected) => {
    expect(dispatchDoesWork(...(args as [number, number?, number?]))).toBe(expected);
  });

  const renderCases: Array<[string, boolean, (p: GPURenderPassEncoder) => void]> = [
    ['draw(3)', true, (p) => p.draw(3)],
    ['draw(0)', false, (p) => p.draw(0)],
    ['draw(3, 0)', false, (p) => p.draw(3, 0)],
    ['drawIndexed(6)', true, (p) => p.drawIndexed(6)],
    ['drawIndexed(6, 0)', false, (p) => p.drawIndexed(6, 0)],
    ['drawIndirect', true, (p) => p.drawIndirect({} as GPUBuffer, 0)],
    ['drawIndexedIndirect', true, (p) => p.drawIndexedIndirect({} as GPUBuffer, 0)],
    ['executeBundles([])', false, (p) => p.executeBundles([])],
    ['executeBundles([bundle])', true, (p) => p.executeBundles([{} as GPURenderBundle])],
    ['a clear alone', false, () => {}],
  ];
  it.each(renderCases)('a render pass with %s: work %s', (_label, expected, run) => {
    const { encoder, recorder } = setUp();
    recorder.enterNode('n', true);
    const pass = encoder.beginRenderPass(colour());
    run(pass);
    pass.end();
    expect(recorder.pairs[0].work).toBe(expected);
  });

  const computeCases: Array<[string, boolean, (p: GPUComputePassEncoder) => void]> = [
    ['dispatchWorkgroups(1)', true, (p) => p.dispatchWorkgroups(1)],
    ['dispatchWorkgroups(0)', false, (p) => p.dispatchWorkgroups(0)],
    ['dispatchWorkgroups(4, 0)', false, (p) => p.dispatchWorkgroups(4, 0)],
    ['dispatchWorkgroupsIndirect', true, (p) => p.dispatchWorkgroupsIndirect({} as GPUBuffer, 0)],
    ['no dispatch', false, () => {}],
  ];
  it.each(computeCases)('a compute pass with %s: work %s', (_label, expected, run) => {
    const { encoder, recorder } = setUp();
    recorder.enterNode('n', true);
    const pass = encoder.beginComputePass({});
    run(pass);
    pass.end();
    expect(recorder.pairs[0].work).toBe(expected);
  });

  it('executeBundles hands the native method an array, so a one-shot iterable is read once', () => {
    const { encoder, fake, recorder } = setUp();
    recorder.enterNode('n', true);
    function* bundles(): Generator<GPURenderBundle> { yield {} as GPURenderBundle; }
    encoder.beginRenderPass(colour()).executeBundles(bundles());
    expect(recorder.pairs[0].work).toBe(true);
    expect(fake.calls).toEqual(['executeBundles([1])']);
  });

  it('the work of one pass never marks the pair of another', () => {
    const { encoder, recorder } = setUp();
    recorder.enterNode('n', true);
    encoder.beginComputePass({});
    const second = encoder.beginComputePass({});
    second.dispatchWorkgroups(1);
    expect(recorder.pairs.map((p) => p.work)).toEqual([false, true]);
  });
});
```

- [ ] **Passo 2: verifica che fallisca**

Esegui: `npx --prefix ts vitest run --root ts src/render/timestamp-intercept.test.ts`
Atteso: FAIL, `Error: Cannot find module './timestamp-intercept' imported from …` (vitest 4.1).

- [ ] **Passo 3: scrivi l'implementazione**

`ts/src/render/timestamp-intercept.ts`:

```ts
/**
 * Timestamp interception for one measured frame (design
 * docs/plans/2026-09-29-gpu-profiler-timestamp-writes-design.md, §4).
 *
 * `instrumentEncoder` overrides `beginRenderPass`/`beginComputePass` as OWN
 * properties of one command encoder, never its prototype: every pass opened on
 * it gets a pair of timestamp queries, and the pass encoder it returns has its
 * work commands wrapped, so the frame knows which passes did work. On Metal a
 * pass without work is not sampled and keeps its indices' previous stamps
 * (Mac M2 tests, probes 2 and 4): a pair counts only if its pass did work.
 */

/** The timestamp writes of pair k: index 2k at the beginning, 2k + 1 at the end. */
interface PairWrites {
  querySet: GPUQuerySet;
  beginningOfPassWriteIndex: number;
  endOfPassWriteIndex: number;
}

/** One measured pass: its profiler name, and whether it recorded any work. */
export interface TimedPair {
  readonly name: string;
  work: boolean;
}

/** WebIDL reads a GPUSize32 argument ([EnforceRange] unsigned long) as its integer part. */
const integer = (value: number): number => Math.trunc(value);

/** Whether `draw`/`drawIndexed` with these counts makes the GPU sample the pass. */
export function drawDoesWork(count: number, instanceCount = 1): boolean {
  return integer(count) > 0 && integer(instanceCount) > 0;
}

/** Whether `dispatchWorkgroups` with these sizes makes the GPU sample the pass. */
export function dispatchDoesWork(x: number, y = 1, z = 1): boolean {
  return integer(x) > 0 && integer(y) > 0 && integer(z) > 0;
}

/**
 * The bookkeeping of ONE measured frame: which pass owns which query pair, and
 * under which name. The GPU objects stay in GpuProfiler.
 */
export class FrameRecorder {
  readonly pairs: TimedPair[] = [];
  /** A pass found every pair taken: the frame cannot be complete. */
  truncated = false;
  private node: string | null = null;
  private current: string | null = null;

  constructor(private readonly querySet: GPUQuerySet, private readonly maxPairs: number) {}

  /** Passes opened from now on belong to `name`; none is timed when `profiled` is false. */
  enterNode(name: string, profiled: boolean): void {
    this.node = profiled ? name : null;
    this.current = this.node;
  }

  /** Passes opened from now on are named `node/stage`. Ignored outside a profiled node. */
  enterStage(stage: string): void {
    if (this.node !== null) this.current = `${this.node}/${stage}`;
  }

  /**
   * The descriptor for the native `begin*Pass`, and the pair it carries: null
   * (and the original descriptor) when the pass is not timed.
   */
  derive<D extends object>(desc: D | undefined): { desc: D | undefined; pair: TimedPair | null } {
    if (this.current === null) return { desc, pair: null };
    if (desc !== undefined && (desc as { timestampWrites?: unknown }).timestampWrites !== undefined) {
      return { desc, pair: null };
    }
    if (this.pairs.length >= this.maxPairs) {
      this.truncated = true;
      return { desc, pair: null };
    }
    const k = this.pairs.length;
    const pair: TimedPair = { name: this.current, work: false };
    this.pairs.push(pair);
    const timestampWrites: PairWrites = {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 2 * k,
      endOfPassWriteIndex: 2 * k + 1,
    };
    // The original is never written: its members are read through the prototype
    // (WebIDL reads dictionary members with [[Get]]; Chrome accepts it, probe 2).
    const derived = Object.create(desc ?? {}, {
      timestampWrites: { value: timestampWrites, enumerable: true },
    }) as D;
    return { desc: derived, pair };
  }
}

/**
 * Replace method `key` of `obj` with an own property that calls `before` with
 * the arguments, then the original with them (or with what `before` returns).
 * A method the object lacks is left alone.
 */
function wrap(obj: object, key: string, before: (args: unknown[]) => unknown[] | void): void {
  const target = obj as unknown as Record<string, unknown>;
  const original = target[key];
  if (typeof original !== 'function') return;
  target[key] = (...args: unknown[]) => {
    const forwarded = before(args) ?? args;
    return (original as (...a: unknown[]) => unknown).apply(obj, forwarded);
  };
}

function trackRenderWork(pass: GPURenderPassEncoder, pair: TimedPair): void {
  const draw = (args: unknown[]) => {
    if (drawDoesWork(args[0] as number, args[1] as number | undefined)) pair.work = true;
  };
  wrap(pass, 'draw', draw);
  wrap(pass, 'drawIndexed', draw);
  // Indirect commands are sampled even at a count of 0 (probe 2).
  wrap(pass, 'drawIndirect', () => { pair.work = true; });
  wrap(pass, 'drawIndexedIndirect', () => { pair.work = true; });
  // A bundle's content cannot be seen: an empty one leaves a stale end stamp,
  // which the frame checks catch (design §4.4).
  wrap(pass, 'executeBundles', (args) => {
    const bundles = Array.from(args[0] as Iterable<GPURenderBundle>);
    if (bundles.length > 0) pair.work = true;
    return [bundles];
  });
}

function trackComputeWork(pass: GPUComputePassEncoder, pair: TimedPair): void {
  wrap(pass, 'dispatchWorkgroups', (args) => {
    if (dispatchDoesWork(args[0] as number, args[1] as number | undefined, args[2] as number | undefined)) {
      pair.work = true;
    }
  });
  wrap(pass, 'dispatchWorkgroupsIndirect', () => { pair.work = true; });
}

/**
 * Time every pass opened on `encoder` from now on, through `recorder`. Own
 * properties of this encoder only: other encoders (particles, the debug
 * probe) and the prototype stay native, and the encoder dies with finish().
 */
export function instrumentEncoder(encoder: GPUCommandEncoder, recorder: FrameRecorder): void {
  const nativeRender = encoder.beginRenderPass;
  const nativeCompute = encoder.beginComputePass;
  encoder.beginRenderPass = (descriptor: GPURenderPassDescriptor): GPURenderPassEncoder => {
    const { desc, pair } = recorder.derive(descriptor);
    const pass = nativeRender.call(encoder, desc as GPURenderPassDescriptor);
    if (pair) trackRenderWork(pass, pair);
    return pass;
  };
  encoder.beginComputePass = (descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder => {
    const { desc, pair } = recorder.derive(descriptor);
    const pass = nativeCompute.call(encoder, desc);
    if (pair) trackComputeWork(pass, pair);
    return pass;
  };
}
```

- [ ] **Passo 4: verifica che passi**

Esegui: `npx --prefix ts vitest run --root ts src/render/timestamp-intercept.test.ts`, poi `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`.
Atteso: tutti i test PASS; `tsc` senza errori.

- [ ] **Passo 5: commit**

```bash
git add ts/src/render/timestamp-intercept.ts ts/src/render/timestamp-intercept.test.ts
git commit -F - <<'EOF'
feat(profiler): intercettazione dei pass per i timestampWrites (timestamp-intercept.ts)

Primo modulo del profiler nuovo (design 2026-09-29, §4): instrumentEncoder sovrascrive beginRenderPass/beginComputePass come proprietà proprie di un encoder, FrameRecorder assegna una coppia di query per pass con il nome del nodo (nodo/stage dopo stage()), il descrittore si deriva con Object.create senza mai scriverlo, e i comandi del pass encoder registrano se il pass ha fatto lavoro (conteggi letti come WebIDL). Nessun consumatore ancora.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: validità, storia, finestra e span (`timestamp-frames.ts`)

**File:**
- Crea: `ts/src/render/timestamp-frames.ts`
- Test: `ts/src/render/timestamp-frames.test.ts`

**Interfacce:**
- Usa: `TimedPair` (Task 1).
- Produce, per il Task 3:
  - `const WINDOW = 120`;
  - `interface PassTiming`, identica a quella di oggi;
  - `interface GpuFrameTiming { averageMs: number; lastMs: number; sampleCount: number }`;
  - `type DiscardReason = 'unexecuted' | 'truncated' | 'zero' | 'reversed' | 'stale' | 'empty'`;
  - `const DISCARD_ORDER: readonly DiscardReason[]`;
  - `interface ResolvedFrame { stamps: BigUint64Array; pairs: readonly TimedPair[]; truncated: boolean; executed: boolean }`;
  - `type FrameVerdict = { ok: true; totalsMs: ReadonlyMap<string, number>; spanMs: number } | { ok: false; reason: DiscardReason; pass?: string }`;
  - `class StampHistory`: `constructor(size: number)`, `isStale(index: number, value: bigint): boolean`, `record(stamps: BigUint64Array): void`, `forget(count: number): void`, `forgetAll(): void`;
  - `function evaluateFrame(frame: ResolvedFrame, history: StampHistory): FrameVerdict`;
  - `class TimingWindow`: `push(totalsMs: ReadonlyMap<string, number>, spanMs: number): void`, `timings(): PassTiming[]`, `frameTiming(): GpuFrameTiming | null`, `clear(): void`.

- [ ] **Passo 1: scrivi il test che fallisce**

`ts/src/render/timestamp-frames.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  StampHistory, TimingWindow, evaluateFrame, WINDOW, DISCARD_ORDER, type ResolvedFrame,
} from './timestamp-frames';
import type { TimedPair } from './timestamp-intercept';

/** A resolved frame: one [name, work, begin, end] per pair, stamps in nanoseconds. */
function frameOf(
  pairs: Array<[string, boolean, bigint, bigint]>,
  opts: { truncated?: boolean; executed?: boolean } = {},
): ResolvedFrame {
  const stamps = new BigUint64Array(pairs.length * 2);
  pairs.forEach(([, , b, e], k) => { stamps[2 * k] = b; stamps[2 * k + 1] = e; });
  return {
    stamps,
    pairs: pairs.map(([name, work]): TimedPair => ({ name, work })),
    truncated: opts.truncated ?? false,
    executed: opts.executed ?? true,
  };
}
const ms = (n: number) => BigInt(Math.round(n * 1e6));

describe('evaluateFrame', () => {
  it('sums the durations per name and measures the span from the first begin to the last end', () => {
    const v = evaluateFrame(frameOf([
      ['cull', true, 1_000_000n, 1_000_000n + ms(0.25)],
      ['lg/sdf', true, 2_000_000n, 2_000_000n + ms(1)],
      ['lg/sdf', true, 4_000_000n, 4_000_000n + ms(2)],
    ]), new StampHistory(6));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.totalsMs.get('cull')).toBeCloseTo(0.25, 9);
    expect(v.totalsMs.get('lg/sdf')).toBeCloseTo(3, 9);
    expect(v.spanMs).toBeCloseTo(5, 9);
  });

  it('with overlapping passes the span is below the sum (the shape measured on the M2 in M7)', () => {
    const v = evaluateFrame(frameOf([
      ['compute', true, 1n, ms(3) + 1n],
      ['render', true, ms(0.05) + 1n, ms(3.29) + 1n],
    ]), new StampHistory(4));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const sum = [...v.totalsMs.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(6.24, 6);
    expect(v.spanMs).toBeCloseTo(3.29, 6);
  });

  it('a pair whose end equals its begin is valid and counts 0 ms (a quantized stamp)', () => {
    const t = 65_536n * 100n;
    const v = evaluateFrame(frameOf([['short', true, t, t], ['long', true, t, t + 65_536n]]), new StampHistory(4));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.totalsMs.get('short')).toBe(0);
  });

  it('a pair without work is ignored whatever its stamps say, and its name counts 0 ms', () => {
    const v = evaluateFrame(frameOf([
      ['never-written', false, 0n, 0n],
      ['clear-only', false, 9n, 3n],
      ['forward', true, 10n, 20n],
    ]), new StampHistory(6));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.totalsMs.get('never-written')).toBe(0);
    expect(v.totalsMs.get('clear-only')).toBe(0);
    expect(v.spanMs).toBeCloseTo(10 / 1e6, 12);
  });

  it('discards with the reason and the first pass that caused it', () => {
    const h = new StampHistory(8);
    expect(evaluateFrame(frameOf([['a', true, 0n, 5n]]), h)).toEqual({ ok: false, reason: 'zero', pass: 'a' });
    expect(evaluateFrame(frameOf([['a', true, 9n, 5n]]), h)).toEqual({ ok: false, reason: 'reversed', pass: 'a' });
    expect(evaluateFrame(frameOf([['a', false, 1n, 2n]]), h)).toEqual({ ok: false, reason: 'empty' });
    expect(evaluateFrame(frameOf([], {}), h)).toEqual({ ok: false, reason: 'empty' });
    expect(evaluateFrame(frameOf([['a', true, 1n, 2n]], { truncated: true }), h)).toEqual({ ok: false, reason: 'truncated' });
    expect(evaluateFrame(frameOf([['a', true, 1n, 2n]], { executed: false }), h)).toEqual({ ok: false, reason: 'unexecuted' });
  });

  it('a pair with work whose stamps were not refreshed is stale', () => {
    const history = new StampHistory(2);
    const first = frameOf([['overlay/x', true, 100n, 200n]]);
    expect(evaluateFrame(first, history).ok).toBe(true);
    history.record(first.stamps);
    expect(evaluateFrame(frameOf([['overlay/x', true, 100n, 200n]]), history))
      .toEqual({ ok: false, reason: 'stale', pass: 'overlay/x' });
    expect(evaluateFrame(frameOf([['overlay/x', true, 300n, 450n]]), history).ok).toBe(true);
  });

  it('each stale check stands alone: a fresh begin with an old end is stale, an old begin with a fresh end too', () => {
    // The first case is Metal's fresh begin and stale end after the timer's absolute
    // values jumped between submits (M7): the old end is then not below the new begin.
    const history = new StampHistory(2);
    history.record(new BigUint64Array([100n, 200n]));
    expect(evaluateFrame(frameOf([['p', true, 150n, 200n]]), history)).toEqual({ ok: false, reason: 'stale', pass: 'p' });
    expect(evaluateFrame(frameOf([['p', true, 100n, 250n]]), history)).toEqual({ ok: false, reason: 'stale', pass: 'p' });
  });

  it('a zero end alone is zero, not reversed', () => {
    expect(evaluateFrame(frameOf([['p', true, 5n, 0n]]), new StampHistory(2))).toEqual({ ok: false, reason: 'zero', pass: 'p' });
  });

  it('the first reason in DISCARD_ORDER wins when several apply', () => {
    expect(DISCARD_ORDER).toEqual(['unexecuted', 'truncated', 'zero', 'reversed', 'stale', 'empty']);
    const history = new StampHistory(6);
    history.record(new BigUint64Array([5n, 6n, 0n, 0n, 0n, 0n]));
    const all = frameOf([['stale', true, 5n, 6n], ['rev', true, 9n, 7n], ['zero', true, 0n, 3n]]);
    expect(evaluateFrame(all, history)).toEqual({ ok: false, reason: 'zero', pass: 'zero' });
    expect(evaluateFrame({ ...all, truncated: true }, history)).toEqual({ ok: false, reason: 'truncated' });
    expect(evaluateFrame({ ...all, truncated: true, executed: false }, history)).toEqual({ ok: false, reason: 'unexecuted' });
  });
});

describe('StampHistory', () => {
  it('knows nothing until a frame is recorded, then flags a repeated value as stale', () => {
    const h = new StampHistory(4);
    expect(h.isStale(0, 0n)).toBe(false);
    h.record(new BigUint64Array([7n, 8n]));
    expect(h.isStale(0, 7n)).toBe(true);
    expect(h.isStale(1, 9n)).toBe(false);
    expect(h.isStale(2, 0n)).toBe(false);
  });

  it('forget(n) and forgetAll() make indices unknown again', () => {
    const h = new StampHistory(4);
    h.record(new BigUint64Array([7n, 8n, 9n, 10n]));
    h.forget(2);
    expect(h.isStale(0, 7n)).toBe(false);
    expect(h.isStale(2, 9n)).toBe(true);
    h.forgetAll();
    expect(h.isStale(2, 9n)).toBe(false);
  });
});

describe('TimingWindow', () => {
  const push = (w: TimingWindow, entries: Record<string, number>, span = 1) =>
    w.push(new Map(Object.entries(entries)), span);
  const byName = (w: TimingWindow) => new Map(w.timings().map((t) => [t.name, t]));

  it('a name missing from a frame took 0 ms in it: its mean decays and lastMs is 0', () => {
    const w = new TimingWindow();
    push(w, { 'lg/seed': 2, 'lg/accum': 1 });
    push(w, { 'lg/accum': 1 });
    const seed = byName(w).get('lg/seed')!;
    expect(seed.lastMs).toBe(0);
    expect(seed.sampleCount).toBe(2);
    expect(seed.averageMs).toBeCloseTo(1, 9);
  });

  it('forgets a name once it has been missing for a whole window', () => {
    const w = new TimingWindow();
    push(w, { 'lg/seed': 2, 'lg/accum': 1 });
    for (let i = 0; i < WINDOW; i++) push(w, { 'lg/accum': 1 });
    expect(byName(w).has('lg/seed')).toBe(false);
  });

  it('forgets a name only after a whole window without it, even if it measured 0 ms', () => {
    const w = new TimingWindow();
    push(w, { a: 1, z: 0 });
    push(w, { a: 1 });
    expect(byName(w).has('z')).toBe(true);
    for (let i = 0; i < WINDOW - 2; i++) push(w, { a: 1 });
    expect(byName(w).has('z')).toBe(true);
    push(w, { a: 1 });
    expect(byName(w).has('z')).toBe(false);
  });

  it('a name appearing mid-window is averaged per frame too: every name has the same sample count', () => {
    const w = new TimingWindow();
    for (let i = 0; i < 3; i++) push(w, { a: 1 });
    push(w, { a: 1, b: 4 });
    const b = byName(w).get('b')!;
    expect(b.sampleCount).toBe(4);
    expect(b.averageMs).toBeCloseTo(1, 9);
    expect(b.lastMs).toBeCloseTo(4, 9);
  });

  it('never forgets a name that is still measured, even at 0 ms', () => {
    const w = new TimingWindow();
    for (let i = 0; i < WINDOW + 5; i++) push(w, { 'lg/seed': 0 });
    expect(byName(w).has('lg/seed')).toBe(true);
  });

  it('averages across frames, which is what defeats the quantization (65.5 us on Metal without the flag)', () => {
    const w = new TimingWindow();
    push(w, { jfa: 0 });
    push(w, { jfa: 0.065536 });
    expect(byName(w).get('jfa')!.averageMs).toBeCloseTo(0.032768, 9);
  });

  it('caps history at WINDOW samples', () => {
    const w = new TimingWindow();
    for (let i = 0; i < WINDOW + 25; i++) push(w, { forward: 1 });
    expect(byName(w).get('forward')!.sampleCount).toBe(WINDOW);
  });

  it('frameTiming: null before the first frame, then the mean, last and count of the spans', () => {
    const w = new TimingWindow();
    expect(w.frameTiming()).toBeNull();
    push(w, { a: 1 }, 2);
    push(w, { a: 1 }, 4);
    expect(w.frameTiming()).toEqual({ averageMs: 3, lastMs: 4, sampleCount: 2 });
    for (let i = 0; i < WINDOW + 3; i++) push(w, { a: 1 }, 1);
    expect(w.frameTiming()!.sampleCount).toBe(WINDOW);
  });

  it('clear() drops everything', () => {
    const w = new TimingWindow();
    push(w, { a: 1 });
    w.clear();
    expect(w.timings()).toEqual([]);
    expect(w.frameTiming()).toBeNull();
  });
});
```

- [ ] **Passo 2: verifica che fallisca**

Esegui: `npx --prefix ts vitest run --root ts src/render/timestamp-frames.test.ts`
Atteso: FAIL, `Error: Cannot find module './timestamp-frames' imported from …` (vitest 4.1).

- [ ] **Passo 3: scrivi l'implementazione**

`ts/src/render/timestamp-frames.ts`:

```ts
/**
 * What a resolved frame of timestamps is worth (design
 * docs/plans/2026-09-29-gpu-profiler-timestamp-writes-design.md, §6): the
 * validity rules, the per-index history of the last values read, and the
 * rolling window the profiler reports from. Pure: no GPU object.
 */
import type { TimedPair } from './timestamp-intercept';

/** Frames of history kept per pass for the rolling mean. */
export const WINDOW = 120;

export interface PassTiming {
  /** The pass's node name, or `node/stage` for a named stage. */
  name: string;
  /**
   * Rolling mean over the last valid frames (up to {@link WINDOW}), in ms.
   * **This is the number to trust**: over the window, the timestamp
   * quantization of Chrome without the developer flag averages out.
   */
  averageMs: number;
  /** Most recent valid frame, in ms. Noisy on its own. */
  lastMs: number;
  /** How many frames the average is over. Below ~30, treat it as warming up. */
  sampleCount: number;
}

/** The frame span: from the first measured beginning to the last measured end. */
export interface GpuFrameTiming {
  /** Rolling mean over the same frames as {@link PassTiming.averageMs}, in ms. */
  averageMs: number;
  /** Most recent span, in ms. */
  lastMs: number;
  /** How many frames the mean is over. */
  sampleCount: number;
}

export type DiscardReason = 'unexecuted' | 'truncated' | 'zero' | 'reversed' | 'stale' | 'empty';

/** A frame with several reasons counts under the first of these (design §6.4). */
export const DISCARD_ORDER: readonly DiscardReason[] = ['unexecuted', 'truncated', 'zero', 'reversed', 'stale', 'empty'];

export interface ResolvedFrame {
  /** Pair k's stamps at 2k (beginning) and 2k + 1 (end), in nanoseconds. */
  readonly stamps: BigUint64Array;
  readonly pairs: readonly TimedPair[];
  readonly truncated: boolean;
  /** The frame's seal came back: its command buffer ran (design §4.6). */
  readonly executed: boolean;
}

export type FrameVerdict =
  | { readonly ok: true; readonly totalsMs: ReadonlyMap<string, number>; readonly spanMs: number }
  | { readonly ok: false; readonly reason: DiscardReason; readonly pass?: string };

/**
 * The last value read for every query index. A stamp equal to it was not
 * refreshed by its pass: on Metal an unsampled pass keeps its indices' previous
 * stamps (probe 2). Only a safety net: the work rule is the real defence
 * (design §6.2).
 */
export class StampHistory {
  private readonly last: BigUint64Array;
  private readonly known: Uint8Array;

  constructor(size: number) {
    this.last = new BigUint64Array(size);
    this.known = new Uint8Array(size);
  }

  /** True when `value` is exactly the last value read at `index`. */
  isStale(index: number, value: bigint): boolean {
    return this.known[index] === 1 && this.last[index] === value;
  }

  /** The values of an executed frame, in submission order. */
  record(stamps: BigUint64Array): void {
    for (let i = 0; i < stamps.length; i++) {
      this.last[i] = stamps[i];
      this.known[i] = 1;
    }
  }

  /** Indices 0..count-1 are unknown: a readback was lost. */
  forget(count: number): void {
    this.known.fill(0, 0, count);
  }

  forgetAll(): void {
    this.known.fill(0);
  }
}

const rank = (reason: DiscardReason) => DISCARD_ORDER.indexOf(reason);

/** Keep or discard one frame (design §6.2-§6.5). Does not touch the history. */
export function evaluateFrame(frame: ResolvedFrame, history: StampHistory): FrameVerdict {
  if (!frame.executed) return { ok: false, reason: 'unexecuted' };
  if (frame.truncated) return { ok: false, reason: 'truncated' };
  let found: { reason: DiscardReason; pass: string } | null = null;
  const totalsMs = new Map<string, number>();
  let first = 0n;
  let last = 0n;
  let measured = false;
  for (let k = 0; k < frame.pairs.length; k++) {
    const pair = frame.pairs[k];
    if (!totalsMs.has(pair.name)) totalsMs.set(pair.name, 0);
    if (!pair.work) continue;
    const begin = frame.stamps[2 * k];
    const end = frame.stamps[2 * k + 1];
    let reason: DiscardReason | null = null;
    if (begin === 0n || end === 0n) reason = 'zero';
    else if (end < begin) reason = 'reversed';
    else if (history.isStale(2 * k, begin) || history.isStale(2 * k + 1, end)) reason = 'stale';
    if (reason !== null) {
      if (found === null || rank(reason) < rank(found.reason)) found = { reason, pass: pair.name };
      continue;
    }
    totalsMs.set(pair.name, totalsMs.get(pair.name)! + Number(end - begin) / 1e6);
    if (!measured || begin < first) first = begin;
    if (!measured || end > last) last = end;
    measured = true;
  }
  if (found !== null) return { ok: false, reason: found.reason, pass: found.pass };
  if (!measured) return { ok: false, reason: 'empty' };
  return { ok: true, totalsMs, spanMs: Number(last - first) / 1e6 };
}

/**
 * The rolling window of valid frames. Every mean is a mean per frame over the
 * same frames: a name missing from a frame took 0 ms in it, a name seen for
 * the first time took 0 ms in the window's earlier frames, and a name missing
 * for a whole window is forgotten (LightGroupsPass drops seed/sdf when its SDF
 * sets go to zero, with no graph change).
 */
export class TimingWindow {
  private readonly samples = new Map<string, number[]>();
  private readonly latest = new Map<string, number>();
  private readonly missing = new Map<string, number>();
  private readonly spans: number[] = [];
  private lastSpan = 0;
  private frames = 0;

  push(totalsMs: ReadonlyMap<string, number>, spanMs: number): void {
    this.frames++;
    for (const [name, samples] of this.samples) {
      if (totalsMs.has(name)) continue;
      this.latest.set(name, 0);
      samples.push(0);
      if (samples.length > WINDOW) samples.shift();
      const missing = (this.missing.get(name) ?? 0) + 1;
      if (missing >= WINDOW) {
        this.samples.delete(name);
        this.latest.delete(name);
        this.missing.delete(name);
      } else {
        this.missing.set(name, missing);
      }
    }
    for (const [name, ms] of totalsMs) {
      this.latest.set(name, ms);
      this.missing.delete(name);
      let samples = this.samples.get(name);
      if (!samples) {
        samples = new Array<number>(Math.min(this.frames - 1, WINDOW - 1)).fill(0);
        this.samples.set(name, samples);
      }
      samples.push(ms);
      if (samples.length > WINDOW) samples.shift();
    }
    this.lastSpan = spanMs;
    this.spans.push(spanMs);
    if (this.spans.length > WINDOW) this.spans.shift();
  }

  timings(): PassTiming[] {
    const out: PassTiming[] = [];
    for (const [name, samples] of this.samples) {
      if (samples.length === 0) continue;
      let sum = 0;
      for (const s of samples) sum += s;
      out.push({ name, averageMs: sum / samples.length, lastMs: this.latest.get(name) ?? 0, sampleCount: samples.length });
    }
    return out;
  }

  frameTiming(): GpuFrameTiming | null {
    if (this.spans.length === 0) return null;
    let sum = 0;
    for (const s of this.spans) sum += s;
    return { averageMs: sum / this.spans.length, lastMs: this.lastSpan, sampleCount: this.spans.length };
  }

  clear(): void {
    this.samples.clear();
    this.latest.clear();
    this.missing.clear();
    this.spans.length = 0;
    this.lastSpan = 0;
    this.frames = 0;
  }
}
```

- [ ] **Passo 4: verifica che passi**

Esegui: `npx --prefix ts vitest run --root ts src/render/timestamp-frames.test.ts`, poi `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`.
Atteso: tutti i test PASS; `tsc` senza errori.

- [ ] **Passo 5: commit**

```bash
git add ts/src/render/timestamp-frames.ts ts/src/render/timestamp-frames.test.ts
git commit -F - <<'EOF'
feat(profiler): validità, storia per indice e finestra dei timestamp (timestamp-frames.ts)

Secondo modulo del profiler nuovo (design 2026-09-29, §6): evaluateFrame tiene un frame solo se è stato eseguito, non è troncato e ogni coppia con lavoro ha stamp non nulli, ordinati e rinnovati rispetto alla StampHistory; altrimenti lo scarta con il primo motivo di DISCARD_ORDER e il pass colpevole. TimingWindow porta la finestra di oggi (somme per nome, nomi assenti a 0, stesso sampleCount, oblio dopo una finestra) e aggiunge la serie dello span. Nessun consumatore ancora.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: il profiler nuovo, il grafo e i due pass con stage

È un task unico perché il cambio di API (`beginFrame()` senza nomi, niente `mark`, il contratto `stage`) tocca insieme `gpu-profiler.ts`, `render-graph.ts`, `render-pass.ts` e i due pass con stage. In mezzo il codice non compila, quindi il commit arriva solo alla fine.

**File:**
- Riscrivi: `ts/src/render/gpu-profiler.ts`, `ts/src/render/gpu-profiler.test.ts`
- Modifica:
  - `ts/src/render/render-pass.ts:49-61`;
  - `ts/src/render/render-graph.ts:202-245`, `ts/src/render/render-graph.test.ts:158-302`;
  - `ts/src/render/passes/light-groups-pass.ts:44-45, 92-98, 108-130`, `ts/src/render/passes/light-groups-pass.test.ts:59-78, 193-201`;
  - `ts/src/render/passes/transparent-sort-pass.ts:25-26, 92-94, 267-270, 291-332`, `ts/src/render/passes/transparent-sort-pass.test.ts` (i casi elencati al passo 7).

I numeri di riga sono quelli di HEAD `90d6fd2`: servono a trovare il punto. Ciò che vale è il testo citato; se i due non coincidono, segui il testo.

**Interfacce:**
- Usa: `FrameRecorder`, `instrumentEncoder`, `TimedPair` (Task 1); `StampHistory`, `TimingWindow`, `evaluateFrame`, `WINDOW`, `DISCARD_ORDER` e i tipi (Task 2).
- Produce:
  - `GpuProfiler`:
    - `constructor(device: GPUDevice, maxPairs = 512)`;
    - `beginFrame(): boolean`, `instrument(encoder)`, `enterNode(name, profiled)`, `enterStage(stage)`;
    - `endFrame(encoder)`, `abortFrame()`, `poll(): Promise<void>`;
    - `timings(): PassTiming[]`, `getTimingsByName()`, `frameTiming(): GpuFrameTiming | null`;
    - getter `measuring`, `skippedFrames`, `discardedFrames`, `discardReasons`, `truncatedFrames`;
    - `reset()`, `destroy()`.
  - `export function nextSeal(previous: number): number`.
  - Da `gpu-profiler.ts` si riesportano `WINDOW`, `DISCARD_ORDER`, `PassTiming`, `GpuFrameTiming` e `DiscardReason`.
  - `RenderPass.execute(encoder, frame, resources, stage?: (name: string) => void)`, `RenderPass.profile?: boolean`.

- [ ] **Passo 1: riscrivi i test del profiler**

Sostituisci tutto `ts/src/render/gpu-profiler.test.ts` con:

```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, type MockInstance } from 'vitest';
import { GpuProfiler, nextSeal } from './gpu-profiler';

beforeAll(() => {
  if (typeof globalThis.GPUBufferUsage === 'undefined') {
    (globalThis as any).GPUBufferUsage = {
      MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008,
      INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080,
      INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
    };
  }
  if (typeof globalThis.GPUMapMode === 'undefined') {
    (globalThis as any).GPUMapMode = { READ: 0x0001, WRITE: 0x0002 };
  }
});

interface FakeBuffer {
  label?: string;
  size: number;
  usage: number;
  bytes: Uint8Array;
  destroyed: boolean;
  mapped: boolean;
  failMap: boolean;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

/**
 * A fake device whose queue really moves bytes: queue.writeBuffer lands at
 * once, a submitted command buffer first "runs its passes" (the stamps the
 * test says they write land in the query set), then its resolve and copies in
 * order; a rejected one runs nothing, which is the case the seal is for.
 */
function makeGpu() {
  const buffers: FakeBuffer[] = [];
  let values = new BigUint64Array(0);
  const device = {
    createQuerySet: vi.fn(({ count }: GPUQuerySetDescriptor) => {
      values = new BigUint64Array(count);
      return { count, destroy: vi.fn() };
    }),
    createBuffer: vi.fn(({ size, usage, label }: GPUBufferDescriptor) => {
      const b: FakeBuffer = {
        label, size, usage, bytes: new Uint8Array(size), destroyed: false, mapped: false, failMap: false,
        async mapAsync() {
          if (b.failMap) throw new Error('OperationError: device lost');
          if (b.mapped) throw new Error('OperationError: buffer already mapped');
          b.mapped = true;
        },
        getMappedRange: (offset = 0, size2?: number) =>
          b.bytes.slice(offset, size2 === undefined ? undefined : offset + size2).buffer,
        unmap() { b.mapped = false; },
        destroy() { b.destroyed = true; },
      };
      buffers.push(b);
      return b;
    }),
    queue: {
      writeBuffer: vi.fn((buffer: FakeBuffer, offset: number, data: ArrayBufferView) => {
        buffer.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
      }),
    },
  };

  function encoder() {
    const ops: Array<() => void> = [];
    const pass = () => ({
      draw() {}, drawIndexed() {}, drawIndirect() {}, drawIndexedIndirect() {}, executeBundles() {},
      dispatchWorkgroups() {}, dispatchWorkgroupsIndirect() {}, end() {},
    });
    const enc = {
      beginComputePass: (_desc?: GPUComputePassDescriptor) => pass(),
      beginRenderPass: (_desc: GPURenderPassDescriptor) => pass(),
      resolveQuerySet: (_qs: unknown, first: number, count: number, dst: FakeBuffer, offset: number) => {
        ops.push(() => dst.bytes.set(new Uint8Array(values.buffer, first * 8, count * 8), offset));
      },
      copyBufferToBuffer: (src: FakeBuffer, srcOffset: number, dst: FakeBuffer, dstOffset: number, size: number) => {
        ops.push(() => dst.bytes.set(src.bytes.slice(srcOffset, srcOffset + size), dstOffset));
      },
      finish: () => ({ ops }),
    };
    return enc as unknown as GPUCommandEncoder;
  }

  /** Submit: the passes write `stamps` into the query set, then the frame's resolve and copies run. */
  function submit(enc: GPUCommandEncoder, opts: { stamps?: bigint[]; reject?: boolean } = {}) {
    const { ops } = (enc.finish() as unknown) as { ops: Array<() => void> };
    if (opts.reject) return;
    if (opts.stamps) values.set(opts.stamps);
    for (const op of ops) op();
  }

  return { device: device as unknown as GPUDevice, buffers, encoder, submit, createBuffer: device.createBuffer, writeBuffer: device.queue.writeBuffer };
}

type Gpu = ReturnType<typeof makeGpu>;

/** Stamps for passes of `durationsMs`, one after the other, in frame `frame` (distinct frames never repeat a stamp). */
function stampsOf(frame: number, ...durationsMs: number[]): bigint[] {
  let t = 1_000_000_000n * BigInt(frame + 1);
  const out: bigint[] = [];
  for (const d of durationsMs) {
    out.push(t, t + BigInt(Math.round(d * 1e6)));
    t += 10_000_000n;
  }
  return out;
}

/** One measured frame: a compute pass with work per node, then submitted (or rejected) and, by default, polled. */
async function measure(
  p: GpuProfiler, gpu: Gpu, nodes: string[], stamps: bigint[] | undefined,
  opts: { reject?: boolean; poll?: boolean; profiled?: boolean } = {},
): Promise<boolean> {
  if (!p.beginFrame()) return false;
  const enc = gpu.encoder();
  p.instrument(enc);
  for (const node of nodes) {
    p.enterNode(node, opts.profiled ?? true);
    const pass = enc.beginComputePass({ label: node });
    pass.dispatchWorkgroups(1);
    pass.end();
  }
  p.endFrame(enc);
  gpu.submit(enc, { stamps, reject: opts.reject });
  if (opts.poll !== false) await p.poll();
  return true;
}

describe('GpuProfiler', () => {
  let gpu: Gpu;
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    gpu = makeGpu();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  describe('isSupported', () => {
    it('reports whether the feature is present', () => {
      expect(GpuProfiler.isSupported(new Set(['timestamp-query']))).toBe(true);
      expect(GpuProfiler.isSupported(new Set(['subgroups']))).toBe(false);
    });
  });

  describe('resources', () => {
    it('512 pairs by default: 1024 queries, three readbacks of 8 KB plus 8 bytes, a 4-byte seal', () => {
      new GpuProfiler(gpu.device);
      const readbacks = gpu.buffers.filter((b) => b.label?.startsWith('gpu-profiler-readback'));
      expect(readbacks).toHaveLength(3);
      for (const b of readbacks) {
        expect(b.size).toBe(1024 * 8 + 8);
        expect(b.usage).toBe(GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
      }
      const seal = gpu.buffers.find((b) => b.label === 'gpu-profiler-seal')!;
      expect(seal.size).toBe(4);
      expect(seal.usage).toBe(GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
      const resolve = gpu.buffers.find((b) => b.label === 'gpu-profiler-resolve')!;
      expect(resolve.size).toBe(1024 * 8);
    });
  });

  describe('frame lifecycle', () => {
    it('refuses a second beginFrame while one is open, and abortFrame reopens it without using a slot', () => {
      const p = new GpuProfiler(gpu.device);
      expect(p.beginFrame()).toBe(true);
      expect(p.beginFrame()).toBe(false);
      p.abortFrame();
      for (let i = 0; i < 5; i++) {
        expect(p.beginFrame()).toBe(true);
        p.abortFrame();
      }
      expect(p.skippedFrames).toBe(0);
    });

    it('skips frames when every readback buffer is in flight', async () => {
      const p = new GpuProfiler(gpu.device);
      for (let i = 0; i < 3; i++) await measure(p, gpu, ['a'], stampsOf(i, 1), { poll: false });
      expect(p.beginFrame()).toBe(false);
      expect(p.skippedFrames).toBe(1);
    });

    it('reports the passes of a measured frame and its span', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['cull', 'forward'], stampsOf(0, 0.25, 1.5));
      const t = p.getTimingsByName();
      expect(t.get('cull')?.lastMs).toBeCloseTo(0.25, 6);
      expect(t.get('forward')?.lastMs).toBeCloseTo(1.5, 6);
      // Two passes 10 ms apart: the span runs from the first begin to the last end.
      expect(p.frameTiming()?.lastMs).toBeCloseTo(11.5, 6);
    });

    it('a frame whose nodes all opted out is discarded as empty', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['overlay'], [], { profiled: false });
      expect(p.timings()).toEqual([]);
      expect(p.discardReasons.empty).toBe(1);
    });
  });

  describe('the seal', () => {
    it('a rejected frame is discarded as unexecuted, and never replays the older frame its readback still holds', async () => {
      const p = new GpuProfiler(gpu.device);
      for (let i = 0; i < 3; i++) await measure(p, gpu, ['forward'], stampsOf(i, 1));
      expect(p.getTimingsByName().get('forward')?.sampleCount).toBe(3);
      for (let i = 0; i < 6; i++) await measure(p, gpu, ['forward'], undefined, { reject: true });
      expect(p.getTimingsByName().get('forward')?.sampleCount).toBe(3);
      expect(p.discardReasons.unexecuted).toBe(6);
    });

    it('writes 0 at the readback tail through the queue, and copies the seal in the command buffer', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['a'], stampsOf(0, 1), { poll: false });
      const tailWrite = (gpu.writeBuffer as ReturnType<typeof vi.fn>).mock.calls.find(([buffer]) =>
        (buffer as FakeBuffer).label?.startsWith('gpu-profiler-readback'));
      expect(tailWrite?.[1]).toBe(2 * 8);
      expect(Array.from(tailWrite?.[2] as Uint32Array)).toEqual([0]);
    });

    it('two readbacks holding different frames, read with every submit rejected: nothing accepted, nothing in the history', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['a'], stampsOf(0, 1), { poll: false });   // readback X: frame 0
      await measure(p, gpu, ['a'], stampsOf(1, 1), { poll: false });   // readback Y: frame 1
      await p.poll();
      // Two rejected frames reuse Y then X, which still hold frames 1 and 0.
      await measure(p, gpu, ['a'], undefined, { reject: true, poll: false });
      await measure(p, gpu, ['a'], undefined, { reject: true, poll: false });
      await p.poll();
      expect(p.discardReasons.unexecuted).toBe(2);
      // The query set still holds frame 1, the last that ran: a pass that did not refresh it is stale.
      await measure(p, gpu, ['a'], undefined);
      expect(p.discardReasons.stale).toBe(1);
      expect(p.getTimingsByName().get('a')?.sampleCount).toBe(2);
    });

    it('nextSeal counts 1..0xFFFFFFFF and never returns 0', () => {
      expect(nextSeal(0)).toBe(1);
      expect(nextSeal(41)).toBe(42);
      expect(nextSeal(0xfffffffe)).toBe(0xffffffff);
      expect(nextSeal(0xffffffff)).toBe(1);
    });
  });

  describe('the per-index history', () => {
    it('an executed frame whose pass did not refresh its stamps is stale', async () => {
      const p = new GpuProfiler(gpu.device);
      const s = stampsOf(0, 1);
      await measure(p, gpu, ['overlay'], s);
      await measure(p, gpu, ['overlay'], undefined);          // ran, but the query set still holds s
      expect(p.discardReasons.stale).toBe(1);
      await measure(p, gpu, ['overlay'], undefined, { reject: true });
      await measure(p, gpu, ['overlay'], stampsOf(1, 1));
      expect(p.getTimingsByName().get('overlay')?.sampleCount).toBe(2);
    });

    it('reset with frames in flight: their samples are dropped, their buffers recycled, and the history forgotten', async () => {
      const p = new GpuProfiler(gpu.device);
      const s = stampsOf(0, 1);
      await measure(p, gpu, ['old-pass'], s);
      for (let i = 0; i < 3; i++) await measure(p, gpu, ['old-pass'], stampsOf(1 + i, 1), { poll: false });
      expect(p.beginFrame()).toBe(false);
      p.reset();
      expect(p.timings()).toEqual([]);
      // The history is unknown, so a new frame repeating stamps read before is not stale.
      await measure(p, gpu, ['new-pass'], s);
      expect(p.getTimingsByName().has('old-pass')).toBe(false);
      expect(p.getTimingsByName().get('new-pass')?.sampleCount).toBe(1);
    });

    it('a discarded frame still updates the history', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['a', 'b'], stampsOf(0, 1, 1));
      const s = stampsOf(1, 1, 1);
      const reversed = [s[0], s[1], s[3], s[2]];                 // 'b' ends before it begins
      await measure(p, gpu, ['a', 'b'], reversed);
      expect(p.discardReasons.reversed).toBe(1);
      const next = stampsOf(2, 1, 1);
      await measure(p, gpu, ['a', 'b'], [reversed[0], reversed[1], next[2], next[3]]);   // 'a' keeps frame 1's stamps
      expect(p.discardReasons.stale).toBe(1);
    });

    it('a frame of an old generation still updates the history', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['a'], stampsOf(0, 1), { poll: false });
      const reading = p.poll();       // takes the frame now
      p.reset();                      // which from here on belongs to an old generation
      await reading;
      expect(p.timings()).toEqual([]);
      await measure(p, gpu, ['a'], undefined);   // the query set still holds that frame's stamps
      expect(p.discardReasons.stale).toBe(1);
    });

    it('a lost readback (device loss) throws nothing, frees its buffer and forgets its indices', async () => {
      const p = new GpuProfiler(gpu.device);
      const s = stampsOf(0, 1);
      await measure(p, gpu, ['a'], s);
      for (const b of gpu.buffers) b.failMap = true;
      await expect(measure(p, gpu, ['a'], stampsOf(1, 1))).resolves.toBe(true);
      for (const b of gpu.buffers) b.failMap = false;
      // Were the history kept, a frame repeating s would be stale.
      await measure(p, gpu, ['a'], s);
      expect(p.getTimingsByName().get('a')?.sampleCount).toBe(2);
      expect(p.skippedFrames).toBe(0);
    });
  });

  describe('diagnostics', () => {
    it('warns once, after 120 discarded frames in a row, naming the reason', async () => {
      const p = new GpuProfiler(gpu.device);
      for (let i = 0; i < 119; i++) await measure(p, gpu, ['a'], undefined, { reject: true });
      expect(warn).not.toHaveBeenCalled();
      await measure(p, gpu, ['a'], undefined, { reject: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/did not run/);
      for (let i = 0; i < 10; i++) await measure(p, gpu, ['a'], undefined, { reject: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(p.discardedFrames).toBe(130);
    });

    it('the warning names the pass behind the most frequent reason', async () => {
      const p = new GpuProfiler(gpu.device);
      const first = stampsOf(0, 1, 1);
      await measure(p, gpu, ['forward', 'overlay'], first);
      for (let i = 1; i <= 120; i++) {
        const s = stampsOf(i, 1, 1);
        await measure(p, gpu, ['forward', 'overlay'], [s[0], s[1], first[2], first[3]]);   // overlay keeps frame 0's stamps
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/pass 'overlay' did work but its timestamps were not refreshed/);
    });

    it('a valid frame breaks the streak', async () => {
      const p = new GpuProfiler(gpu.device);
      for (let i = 0; i < 100; i++) await measure(p, gpu, ['a'], undefined, { reject: true });
      await measure(p, gpu, ['a'], stampsOf(0, 1));
      for (let i = 0; i < 100; i++) await measure(p, gpu, ['a'], undefined, { reject: true });
      expect(warn).not.toHaveBeenCalled();
    });

    it('a truncated frame is discarded and warns once with the maxPairs value', async () => {
      const p = new GpuProfiler(gpu.device, 2);
      await measure(p, gpu, ['a', 'b', 'c'], stampsOf(0, 1, 1));
      await measure(p, gpu, ['a', 'b', 'c'], stampsOf(1, 1, 1));
      expect(p.truncatedFrames).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/more than 2 passes/);
    });

    it('discard counts survive reset: they describe the browser', async () => {
      const p = new GpuProfiler(gpu.device);
      await measure(p, gpu, ['a'], undefined, { reject: true });
      p.reset();
      expect(p.discardedFrames).toBe(1);
    });
  });

  describe('destroy', () => {
    it('releases every buffer and stops measuring, and is idempotent', () => {
      const p = new GpuProfiler(gpu.device);
      p.destroy();
      expect(gpu.buffers.every((b) => b.destroyed)).toBe(true);
      expect(p.beginFrame()).toBe(false);
      expect(() => p.destroy()).not.toThrow();
    });
  });
});
```

- [ ] **Passo 2: verifica che fallisca**

Esegui: `npx --prefix ts vitest run --root ts src/render/gpu-profiler.test.ts`
Atteso: FAIL. `nextSeal` non esiste, `beginFrame()` senza nomi non apre il frame come si aspettano i test, e `instrument`, `frameTiming` e `discardReasons` non esistono.

- [ ] **Passo 3: riscrivi il profiler**

Sostituisci tutto `ts/src/render/gpu-profiler.ts` con:

```ts
/**
 * Per-pass GPU timing for the RenderGraph, built on the `timestamp-query`
 * WebGPU feature (design docs/plans/2026-09-29-gpu-profiler-timestamp-writes-design.md).
 *
 * ## How it works
 *
 * In a measured frame the graph hands the profiler its command encoder
 * (`instrument`), and every render or compute pass opened on it gets a pair
 * of timestamp queries through its own `timestampWrites`: the beginning and
 * the end of the pass itself (timestamp-intercept.ts). The profiler resolves
 * the pairs at the end of the frame, reads them back a few frames later, and
 * keeps the frame only if its command buffer ran (the seal) and every pass
 * that did work has non-zero, ordered, refreshed stamps (timestamp-frames.ts).
 * An unmeasured frame is untouched: no query, no wrapper.
 *
 * Until 2026-09-29 the profiler put empty compute passes between the graph's
 * passes as markers. On Metal a pass without work is never sampled, so every
 * marker read 0 and nothing was ever reported (Mac M2 tests, M7).
 *
 * ## Three things that decide how much to trust a number
 *
 * 1. **The entries do not add up to the frame.** Independent passes overlap
 *    on some GPUs (the Apple M2 does), so a pass's duration includes time it
 *    shared with others. The frame is {@link GpuProfiler.frameTiming}: from
 *    the first beginning to the last end.
 * 2. **Quantization.** Chrome without `--enable-webgpu-developer-features`
 *    rounds timestamps: to 65 536 ns on macOS/Metal (Chrome 154, 2026-09-29),
 *    to about 1 us on Linux/Vulkan. Quote `averageMs`: over {@link WINDOW}
 *    frames the rounding averages out.
 * 3. **Only passes with work are measured.** A pass that recorded no draw or
 *    dispatch (a clear alone) is not sampled on Metal: its name counts 0 ms.
 *
 * ## Cost when disabled
 *
 * Zero: `createRenderer` builds no GpuProfiler until `enableGpuProfiling()`,
 * and the graph calls nothing on an unmeasured frame.
 */
import { FrameRecorder, instrumentEncoder, type TimedPair } from './timestamp-intercept';
import {
  StampHistory, TimingWindow, evaluateFrame, WINDOW,
  type DiscardReason, type GpuFrameTiming, type PassTiming,
} from './timestamp-frames';

export { WINDOW, DISCARD_ORDER } from './timestamp-frames';
export type { DiscardReason, GpuFrameTiming, PassTiming } from './timestamp-frames';

/** Readback buffers in flight before the profiler starts skipping frames. */
const READBACK_SLOTS = 3;
/** Bytes per timestamp (u64 nanoseconds). */
const TIMESTAMP_SIZE = 8;
/** The seal: a u32 sequence number, copied to a readback's tail. */
const SEAL_BYTES = 4;
/** Room after the stamps in a readback: the seal, kept 8-byte aligned. */
const READBACK_TAIL = 8;
/** Discarded frames in a row before the one warning: two seconds at 60 fps. */
const WARN_AFTER = WINDOW;

/** The next frame's seal: 1..0xFFFFFFFF, never 0, which is what a rejected frame reads. */
export function nextSeal(previous: number): number {
  return previous >= 0xffffffff ? 1 : previous + 1;
}

function describeDiscard(reason: DiscardReason, pass: string | undefined): string {
  const who = pass !== undefined ? `pass '${pass}'` : 'a pass';
  switch (reason) {
    case 'unexecuted': return "the frames' command buffers did not run (a GPU validation error in the frame)";
    case 'truncated': return 'every frame opened more passes than the profiler has query pairs for';
    case 'zero': return `${who} did work but read back a zero timestamp (this browser does not serve timestamps)`;
    case 'reversed': return `${who} read back an end timestamp before its beginning`;
    case 'stale': return `${who} did work but its timestamps were not refreshed`;
    case 'empty': return 'no measured pass recorded any work';
  }
}

interface PendingReadback {
  buffer: GPUBuffer;
  pairs: readonly TimedPair[];
  truncated: boolean;
  seal: number;
  /** Value of {@link GpuProfiler.generation} when the frame was opened. */
  generation: number;
}

export class GpuProfiler {
  /**
   * Whether a device (or adapter) exposes `timestamp-query`. Takes anything
   * with `has()`, so it works with `GPUSupportedFeatures` and a plain `Set`.
   */
  static isSupported(features: { has(name: string): boolean }): boolean {
    return features.has('timestamp-query');
  }

  private readonly maxPairs: number;
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly sealBuffer: GPUBuffer;
  private readonly allReadbacks: GPUBuffer[] = [];
  private readonly freeReadbacks: GPUBuffer[] = [];
  private readonly pending: PendingReadback[] = [];
  private readonly window = new TimingWindow();
  private readonly history: StampHistory;
  private readonly discards: Record<DiscardReason, number> = {
    unexecuted: 0, truncated: 0, zero: 0, reversed: 0, stale: 0, empty: 0,
  };

  private recorder: FrameRecorder | null = null;
  private destroyed = false;
  private polling = false;
  /**
   * Bumped by {@link reset}: the frames still in flight were measured under a
   * graph that no longer exists, and are dropped when read.
   */
  private generation = 0;
  private seal = 0;
  private skipped = 0;
  /** The current run of discarded frames: its length, and per reason how many and the last pass blamed. */
  private streak = 0;
  private readonly streakReasons = new Map<DiscardReason, { count: number; pass?: string }>();
  private warned = false;
  private warnedTruncation = false;

  /**
   * @param maxPairs timestamp pairs per frame, one per measured pass. 512:
   *   the worst frame the design estimates opens about 250 (§4.5). The query
   *   set is 8 KB and exists only while profiling.
   */
  constructor(private readonly device: GPUDevice, maxPairs = 512) {
    this.maxPairs = maxPairs;
    const queries = 2 * maxPairs;
    const stampBytes = queries * TIMESTAMP_SIZE;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: queries, label: 'gpu-profiler' });
    this.resolveBuffer = device.createBuffer({
      size: stampBytes,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      label: 'gpu-profiler-resolve',
    });
    this.sealBuffer = device.createBuffer({
      size: SEAL_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      label: 'gpu-profiler-seal',
    });
    this.history = new StampHistory(queries);
    for (let i = 0; i < READBACK_SLOTS; i++) {
      const buffer = device.createBuffer({
        size: stampBytes + READBACK_TAIL,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        label: `gpu-profiler-readback-${i}`,
      });
      this.allReadbacks.push(buffer);
      this.freeReadbacks.push(buffer);
    }
  }

  /** True while the current frame is being measured. */
  get measuring(): boolean {
    return this.recorder !== null;
  }

  /** Frames skipped because all readback buffers were busy. */
  get skippedFrames(): number {
    return this.skipped;
  }

  /** Frames read back and discarded, for any reason (see {@link discardReasons}). */
  get discardedFrames(): number {
    let total = 0;
    for (const n of Object.values(this.discards)) total += n;
    return total;
  }

  /** Discarded frames by reason, since the profiler was created: survives {@link reset}. */
  get discardReasons(): Readonly<Record<DiscardReason, number>> {
    return { ...this.discards };
  }

  /** Frames discarded because they opened more passes than `maxPairs`. */
  get truncatedFrames(): number {
    return this.discards.truncated;
  }

  /**
   * Open a measured frame. Returns false, and the caller must then call none
   * of the other frame methods, when there is no free readback buffer.
   */
  beginFrame(): boolean {
    if (this.destroyed || this.recorder) return false;
    if (this.freeReadbacks.length === 0) {
      this.skipped++;
      return false;
    }
    this.recorder = new FrameRecorder(this.querySet, this.maxPairs);
    return true;
  }

  /** Time every pass opened on `encoder` from now on (the frame's encoder, once per frame). */
  instrument(encoder: GPUCommandEncoder): void {
    if (this.recorder) instrumentEncoder(encoder, this.recorder);
  }

  /** The passes opened from now on belong to node `name`; not timed when `profiled` is false. */
  enterNode(name: string, profiled: boolean): void {
    this.recorder?.enterNode(name, profiled);
  }

  /** The passes opened from now on are named `node/stage`. */
  enterStage(stage: string): void {
    this.recorder?.enterStage(stage);
  }

  /**
   * Abandon the frame opened by {@link beginFrame}: a pass threw, and the
   * encoder is discarded without a submit, so the GPU wrote nothing.
   */
  abortFrame(): void {
    this.recorder = null;
  }

  /**
   * Queue the resolve, the copy and the seal. Call on the frame's encoder,
   * after the last pass and before `encoder.finish()`.
   */
  endFrame(encoder: GPUCommandEncoder): void {
    const recorder = this.recorder;
    if (!recorder) return;
    this.recorder = null;
    const buffer = this.freeReadbacks.pop();
    if (!buffer) return;
    const pairs = recorder.pairs.length;
    const stampBytes = 2 * pairs * TIMESTAMP_SIZE;
    this.seal = nextSeal(this.seal);
    // Queue writes run even when the frame's command buffer is rejected; the
    // copies below run only with it. A rejected frame reads 0 where its seal
    // should be, and an older frame's stamps before it (design §4.6).
    this.device.queue.writeBuffer(buffer, stampBytes, new Uint32Array([0]));
    this.device.queue.writeBuffer(this.sealBuffer, 0, new Uint32Array([this.seal]));
    if (pairs > 0) {
      encoder.resolveQuerySet(this.querySet, 0, 2 * pairs, this.resolveBuffer, 0);
      encoder.copyBufferToBuffer(this.resolveBuffer, 0, buffer, 0, stampBytes);
    }
    encoder.copyBufferToBuffer(this.sealBuffer, 0, buffer, stampBytes, SEAL_BYTES);
    this.pending.push({
      buffer, pairs: recorder.pairs, truncated: recorder.truncated, seal: this.seal, generation: this.generation,
    });
  }

  /**
   * Map and read the frames queued so far. Fire-and-forget after
   * `queue.submit()`; a call while another is still reading does nothing.
   */
  async poll(): Promise<void> {
    if (this.polling || this.destroyed) return;
    this.polling = true;
    // Drain synchronously, so that a concurrent endFrame() cannot change the batch mid-await.
    const batch = this.pending.splice(0, this.pending.length);
    try {
      for (const entry of batch) {
        if (this.destroyed) return;
        try {
          await entry.buffer.mapAsync(GPUMapMode.READ);
          // Unmapped whatever consume() does: a buffer back in the pool
          // still mapped would fail every later copy into it.
          try {
            this.consume(entry);
          } finally {
            entry.buffer.unmap();
          }
        } catch {
          // Device lost, or the buffer destroyed mid-flight: the frame is
          // gone, and with it what its queries held (design §6.3).
          this.history.forget(2 * entry.pairs.length);
        } finally {
          if (!this.destroyed) this.freeReadbacks.push(entry.buffer);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private consume(entry: PendingReadback): void {
    const stampBytes = 2 * entry.pairs.length * TIMESTAMP_SIZE;
    const data = entry.buffer.getMappedRange(0, stampBytes + SEAL_BYTES).slice(0);
    const stamps = new BigUint64Array(data, 0, 2 * entry.pairs.length);
    const executed = new Uint32Array(data, stampBytes, 1)[0] === entry.seal;
    const verdict = evaluateFrame(
      { stamps, pairs: entry.pairs, truncated: entry.truncated, executed },
      this.history,
    );
    // Every executed frame wrote its queries, discarded or not: the history
    // follows the query set in submission order (design §6.3).
    if (executed) this.history.record(stamps);
    // Measured under a graph that has since been reset: no sample, no count.
    if (entry.generation !== this.generation) return;
    if (!verdict.ok) {
      this.noteDiscard(verdict.reason, verdict.pass);
      return;
    }
    this.streak = 0;
    this.streakReasons.clear();
    this.window.push(verdict.totalsMs, verdict.spanMs);
  }

  private noteDiscard(reason: DiscardReason, pass: string | undefined): void {
    this.discards[reason]++;
    if (reason === 'truncated' && !this.warnedTruncation) {
      this.warnedTruncation = true;
      console.warn(
        `[Hyperion] GPU profiling: a frame opened more than ${this.maxPairs} passes, so its timings ` +
        `were dropped. Build the GpuProfiler with a larger maxPairs.`,
      );
    }
    this.streak++;
    const entry = this.streakReasons.get(reason) ?? { count: 0 };
    entry.count++;
    if (pass !== undefined) entry.pass = pass;
    this.streakReasons.set(reason, entry);
    if (this.warned || this.streak < WARN_AFTER) return;
    this.warned = true;
    let top = reason;
    let topCount = 0;
    for (const [r, e] of this.streakReasons) {
      if (e.count > topCount) {
        top = r;
        topCount = e.count;
      }
    }
    console.warn(
      `[Hyperion] GPU profiling is enabled but the last ${this.streak} frames were discarded: ` +
      `${describeDiscard(top, this.streakReasons.get(top)?.pass)}. No timings will be reported until that changes.`,
    );
  }

  /**
   * Current timings, one entry per pass or stage measured in the last
   * {@link WINDOW} valid frames. A frame without it counts as 0 ms, so
   * `averageMs` is a mean per frame, and every entry has the same `sampleCount`.
   */
  timings(): PassTiming[] {
    return this.window.timings();
  }

  /** Same data as {@link timings}, keyed by name. */
  getTimingsByName(): Map<string, PassTiming> {
    const map = new Map<string, PassTiming>();
    for (const t of this.timings()) map.set(t.name, t);
    return map;
  }

  /** The frame span over the same frames as {@link timings}; null before the first valid frame. */
  frameTiming(): GpuFrameTiming | null {
    return this.window.frameTiming();
  }

  /**
   * Drop the accumulated history and invalidate every frame still in flight.
   * Call after changing the graph or the resolution. Discard counts survive:
   * they describe what this browser does, not what one graph measured.
   */
  reset(): void {
    this.window.clear();
    this.skipped = 0;
    this.generation++;
    // The frames in flight are never read, so the history cannot follow the
    // queries they wrote.
    this.history.forgetAll();
    // Recycle their buffers: dropping only the entries would shrink the pool
    // until every frame is skipped. A buffer that still has a copy encoded
    // against it is safe to reuse: the GPU runs that copy before the next one.
    for (const entry of this.pending) this.freeReadbacks.push(entry.buffer);
    this.pending.length = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.recorder = null;
    this.pending.length = 0;
    this.freeReadbacks.length = 0;
    for (const buffer of this.allReadbacks) buffer.destroy();
    this.allReadbacks.length = 0;
    this.resolveBuffer.destroy();
    this.sealBuffer.destroy();
    this.querySet.destroy();
    this.window.clear();
  }
}
```

- [ ] **Passo 4: verifica i test del profiler**

Esegui: `npx --prefix ts vitest run --root ts src/render/gpu-profiler.test.ts src/render/timestamp-intercept.test.ts src/render/timestamp-frames.test.ts`
Atteso: PASS. `tsc` fallisce ancora su `render-graph.ts`, che chiama `beginFrame(names)` e `mark`: lo sistemano i passi 5-6.

- [ ] **Passo 5: riscrivi i test del grafo**

In `ts/src/render/render-graph.test.ts` sostituisci tutto il blocco `describe('GPU profiler hook', ...)` (righe 158-302) con:

```ts
  describe('GPU profiler hook', () => {
    function mockDevice() {
      const encoder = { finish: () => ({}) };
      return {
        encoder,
        device: { createCommandEncoder: () => encoder, queue: { submit: vi.fn() } } as unknown as GPUDevice,
      };
    }

    const frame = {} as never;
    const resources = {} as never;

    function fakeProfiler(measuring: boolean) {
      return {
        beginFrame: vi.fn(() => measuring),
        instrument: vi.fn(),
        enterNode: vi.fn(),
        enterStage: vi.fn(),
        endFrame: vi.fn(),
        abortFrame: vi.fn(),
        poll: vi.fn(async () => {}),
      };
    }

    it('renders and submits with no profiler attached', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('cull', [], ['visible-indices']));
      graph.addPass(mockPass('forward', ['visible-indices'], ['swapchain']));
      const { device } = mockDevice();
      expect(() => graph.render(device, frame, resources)).not.toThrow();
      expect(device.queue.submit).toHaveBeenCalledTimes(1);
    });

    it('instruments the frame encoder once, enters every live node, and closes the frame', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('cull', [], ['visible-indices']));
      graph.addPass(mockPass('forward', ['visible-indices'], ['swapchain']));
      const profiler = fakeProfiler(true);
      graph.setProfiler(profiler as never);
      const { device, encoder } = mockDevice();

      graph.render(device, frame, resources);

      expect(profiler.beginFrame).toHaveBeenCalledWith();
      expect(profiler.instrument).toHaveBeenCalledTimes(1);
      expect(profiler.instrument).toHaveBeenCalledWith(encoder);
      expect(profiler.enterNode.mock.calls).toEqual([['cull', true], ['forward', true]]);
      expect(profiler.endFrame).toHaveBeenCalledWith(encoder);
      expect(profiler.poll).toHaveBeenCalledTimes(1);
    });

    it('a node with profile: false is entered as unmeasured', () => {
      const graph = new RenderGraph();
      const overlay = { ...mockPass('overlay', ['swapchain'], ['swapchain']), profile: false };
      graph.addPass(mockPass('forward', [], ['swapchain']));
      graph.addPass(overlay);
      const profiler = fakeProfiler(true);
      graph.setProfiler(profiler as never);
      graph.render(mockDevice().device, frame, resources);
      expect(profiler.enterNode.mock.calls).toEqual([['forward', true], ['overlay', false]]);
    });

    it('hands every pass a stage function that names the profiler stages', () => {
      const graph = new RenderGraph();
      const staged = mockPass('staged', [], ['swapchain']);
      const execute = vi.fn((_e: GPUCommandEncoder, _f: unknown, _r: unknown, stage?: (name: string) => void) => {
        stage?.('a');
        stage?.('b');
      });
      Object.assign(staged, { execute });
      graph.addPass(staged);
      const profiler = fakeProfiler(true);
      graph.setProfiler(profiler as never);
      graph.render(mockDevice().device, frame, resources);
      expect(profiler.enterStage.mock.calls).toEqual([['a'], ['b']]);
    });

    it('no stage function, and no profiler call, when the frame is not measured', () => {
      const graph = new RenderGraph();
      const pass = mockPass('forward', [], ['swapchain']);
      const execute = vi.fn();
      Object.assign(pass, { execute });
      graph.addPass(pass);
      const profiler = fakeProfiler(false);
      graph.setProfiler(profiler as never);
      graph.render(mockDevice().device, frame, resources);
      expect(execute.mock.calls[0][3]).toBeUndefined();
      expect(profiler.instrument).not.toHaveBeenCalled();
      expect(profiler.enterNode).not.toHaveBeenCalled();
      expect(profiler.endFrame).not.toHaveBeenCalled();
      expect(profiler.poll).not.toHaveBeenCalled();
    });

    it('detaching the profiler restores the unmeasured path', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('forward', [], ['swapchain']));
      const profiler = fakeProfiler(true);
      graph.setProfiler(profiler as never);
      graph.setProfiler(null);
      graph.render(mockDevice().device, frame, resources);
      expect(profiler.beginFrame).not.toHaveBeenCalled();
    });

    it('closes the open frame when a pass throws, then rethrows', () => {
      const graph = new RenderGraph();
      const boom = mockPass('boom', [], ['swapchain']);
      boom.execute = () => { throw new Error('pass exploded'); };
      graph.addPass(boom);
      const profiler = fakeProfiler(true);
      graph.setProfiler(profiler as never);
      // Without abortFrame() the profiler's frame stays open and every later
      // beginFrame() returns false: it would go silently dead.
      expect(() => graph.render(mockDevice().device, frame, resources)).toThrow('pass exploded');
      expect(profiler.abortFrame).toHaveBeenCalledTimes(1);
      expect(profiler.endFrame).not.toHaveBeenCalled();
      expect(profiler.poll).not.toHaveBeenCalled();
    });

    it('does not abort the frame when every pass succeeds', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('forward', [], ['swapchain']));
      const profiler = fakeProfiler(true);
      graph.setProfiler(profiler as never);
      graph.render(mockDevice().device, frame, resources);
      expect(profiler.abortFrame).not.toHaveBeenCalled();
      expect(profiler.endFrame).toHaveBeenCalledTimes(1);
    });

    it('enters only live nodes, not dead-culled ones', () => {
      const graph = new RenderGraph();
      graph.addPass(mockPass('forward', [], ['swapchain']));
      graph.addPass(mockPass('orphan', [], ['nobody-reads-this'], true));
      const profiler = fakeProfiler(true);
      graph.setProfiler(profiler as never);
      graph.render(mockDevice().device, frame, resources);
      expect(profiler.enterNode.mock.calls).toEqual([['forward', true]]);
    });
  });
```

- [ ] **Passo 5b: verifica che falliscano**

Esegui: `npx --prefix ts vitest run --root ts src/render/render-graph.test.ts`
Atteso: FAIL. Il `render()` di oggi chiama `beginFrame(names)` e `mark`, quindi `instrument` ed `enterNode` non vengono mai chiamati (per esempio `expected "spy" to be called 1 times, but got 0 times`).

- [ ] **Passo 6: aggiorna contratto e grafo**

In `ts/src/render/render-pass.ts`, sostituisci il tratto dal commento `/**` che apre `@param mark` (riga 49, subito sotto `prepare(...)`, che resta) fino a `profileStages?(frame: FrameState): readonly string[];` (riga 61), cioè il vecchio JSDoc di `mark`, `execute`, il JSDoc di `profileStages` e `profileStages`, con:

```ts
  /**
   * @param stage Only while the GPU profiler measures this frame: the passes
   *   this pass opens after `stage('x')` are timed as `name/x`. A pass must
   *   work the same without it.
   */
  execute(encoder: GPUCommandEncoder, frame: FrameState,
          resources: import('./resource-pool').ResourcePool,
          stage?: (name: string) => void): void;
  /** False keeps every pass this node opens out of the GPU profiler. */
  readonly profile?: boolean;
```

In `ts/src/render/render-graph.ts`, in `render()`, sostituisci il tratto da `// \`beginFrame\` returns false when profiling is off,` fino a `if (measuring) void this.profiler!.poll();` (righe 202-245) con:

```ts
    // `beginFrame` returns false when profiling is off or every readback
    // buffer is still in flight: then nothing below touches the encoder.
    const profiler = this.profiler;
    const measuring = profiler?.beginFrame() ?? false;
    if (measuring) profiler!.instrument(encoder);
    const stage = measuring ? (name: string) => profiler!.enterStage(name) : undefined;

    try {
      for (const name of this.executionOrder) {
        const pass = this.passes.get(name)!;
        if (measuring) profiler!.enterNode(name, pass.profile !== false);
        pass.execute(encoder, frame, resources, stage);
      }
    } catch (err) {
      // The encoder is abandoned unfinished, so the frame the profiler opened
      // will never resolve. Closing it here keeps a single throwing pass from
      // wedging `beginFrame()` shut for every frame that follows.
      if (measuring) profiler!.abortFrame();
      throw err;
    }

    if (measuring) profiler!.endFrame(encoder);

    device.queue.submit([encoder.finish()]);

    // Fire and forget: reads the frames that finished on the GPU a few frames
    // ago. Never awaited, so it cannot stall the render loop.
    if (measuring) void profiler!.poll();
```

Esegui: `npx --prefix ts vitest run --root ts src/render/render-graph.test.ts`
Atteso: PASS.

- [ ] **Passo 7: i due pass con stage — prima i test**

In `ts/src/render/passes/light-groups-pass.test.ts`:
- nella funzione `frame` (righe 59-78) sostituisci il parametro `withMark = false` con `withStage = false`, e nel suo commento "or mark" con "or stage name";
- il tipo degli eventi diventa `Array<{ kind: 'pass'; target: View; sdf?: View } | { kind: 'stage'; name: string }>`;
- la chiamata diventa `pass.execute(encoder, f, pool, withStage ? (name: string) => { events.push({ kind: 'stage', name }); } : undefined);`;
- la funzione `passes` filtra `e.kind === 'pass'` come oggi.

Poi sostituisci il test `'names its stages for the profiler and marks each one just before it runs'` (righe 193-201) con:

```ts
  it('names each stage for the profiler just before it runs: seed, sdf, accum per set, then accum for set-less groups', () => {
    const { frame } = setUp();
    const lg = groups([[1, 0], [2, 1], [4, -1]], [1, 2]);
    const events = frame(lg, 128, 64, true);
    const names = events.flatMap((e) => (e.kind === 'stage' ? [e.name] : []));
    expect(names).toEqual(['seed', 'sdf', 'accum', 'seed', 'sdf', 'accum', 'accum']);
    expect(events[0].kind).toBe('stage');
  });
```

In `ts/src/render/passes/transparent-sort-pass.test.ts`:
- nel tipo `Cmd` (riga 38) sostituisci `| { kind: 'mark' }` con `| { kind: 'stage'; name: string }`;
- in `record()` (righe 134-135) sostituisci `const mark = ...` e il `return` con:

  ```ts
    const stage = (name: string) => { cmds.push({ kind: 'stage', name }); };
    return { encoder, cmds, stage };
  ```

  e aggiorna il commento della funzione: "An encoder that records passes, dispatches, copies and profiler stage names in order."
- il test `'a pass never set up writes nothing, encodes nothing and names no stage'` (righe 195-204) diventa:

  ```ts
  it('a pass never set up writes nothing and encodes nothing, measured or not', () => {
    const { device, writes } = makeDevice();
    const pass = new TransparentSortPass();
    const { encoder, cmds, stage } = record();
    pass.prepare(device, frameOf(10));
    pass.execute(encoder, frameOf(10), new ResourcePool(), stage);
    expect(writes).toEqual([]);
    expect(cmds).toEqual([]);
  });
  ```
- in `'never writes a buffer: ...'` (righe 411-422), `withMark`/`mark` diventano `withStage`/`stage`;
- il test `it.each([0, Number.NaN])('count %s: encodes nothing and profileStages is empty', ...)` (righe 424-433) diventa:

  ```ts
  it.each([0, Number.NaN])('count %s: encodes nothing, measured or not', (count) => {
    const { pass, device, pool } = setUp();
    const f = frameOf(count);
    pass.prepare(device, f);
    const { encoder, cmds, stage } = record();
    pass.execute(encoder, f, pool);
    pass.execute(encoder, f, pool, stage);
    expect(cmds).toEqual([]);
  });
  ```
- il test `'with the profiler: 22 compute passes, ...'` (righe 435-448, dal suo `it(` al suo `});`) diventa:

  ```ts
  it('with the profiler: 22 compute passes, each right after its stage name — gather, then upsweep/scan/scatter seven times', () => {
    const { pass, device, pool } = setUp();
    const f = frameOf(5000);
    pass.prepare(device, f);
    const { encoder, cmds, stage } = record();
    pass.execute(encoder, f, pool, stage);
    const names = cmds.flatMap((c) => (c.kind === 'stage' ? [c.name] : []));
    expect(names).toEqual(STAGES);
    expect(names).toHaveLength(22);
    expect(cmds.filter((c) => c.kind === 'pass')).toHaveLength(22);
    cmds.forEach((c, i) => { if (c.kind === 'stage') expect(cmds[i + 1].kind).toBe('pass'); });
    expect(dispatches(cmds).map((d) => d.entry)).toEqual(STAGES.map((s) => ENTRY[s]));
  });
  ```
- in `'with a readback request and the profiler: ...'` (righe 475-488), `mark` diventa `stage`, e i due controlli sui marker diventano `expect(cmds.filter((c) => c.kind === 'stage')).toHaveLength(22);` e `expect(cmds[firstEnd + 3].kind).toBe('stage');`;
- in `'in a production build (__DEV__ false) ...'` (righe 505-526), `withMark`/`mark` diventano `withStage`/`stage`;
- in `'destroys its own buffers, ...'` (righe 536-546) togli la riga `expect(pass.profileStages(frameOf(10))).toEqual([]);`.

Esegui: `npx --prefix ts vitest run --root ts src/render/passes/light-groups-pass.test.ts src/render/passes/transparent-sort-pass.test.ts`
Atteso: FAIL. I pass chiamano ancora `mark(encoder)`, quindi la funzione `stage` riceve l'encoder come nome: falliscono i due test che controllano i nomi degli stage (quello del sort e quello di light-groups); gli altri casi modificati passano già.

- [ ] **Passo 8: i due pass con stage — il codice**

In `ts/src/render/passes/light-groups-pass.ts`:
- nel commento della classe (righe 44-45) sostituisci "For the GPU profiler the node names them per frame (`profileStages`) and marks each one, so their times stay visible as `light-groups/seed|sdf|accum`." con "While the GPU profiler measures, it names each stage just before it runs (`stage`), so their times stay visible as `light-groups/seed|sdf|accum`.";
- togli il metodo `profileStages(frame)` (righe 92-98);
- sostituisci tutto il metodo `execute` (righe 108-130, dalla firma alla sua `}` di chiusura) con:

```ts
  execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool, stage?: (name: string) => void): void {
    const lg = frame.lightGroups ?? EVERYTHING;
    this.ensureTargets(frame, resources, lg.groups.length);
    if (!this.seedView || !this.aView || !this.bView || !this.noOccluderView) return;

    for (let s = 0; s < lg.sdfSets.length; s++) {
      stage?.('seed');
      this.seed.encode(encoder, s, this.seedView, resources);
      stage?.('sdf');
      const sdf = this.chain.encode(encoder, this.seedView, this.aView, this.bView);
      stage?.('accum');
      // Before the next set's seed overwrites the shared textures.
      lg.groups.forEach((group, g) => {
        if (group.sdfSet === s) this.accum.encode(encoder, g, this.layerViews[g], sdf, frame);
      });
    }
    if (lg.groups.some((group) => group.sdfSet < 0)) {
      stage?.('accum');
      lg.groups.forEach((group, g) => {
        if (group.sdfSet < 0) this.accum.encode(encoder, g, this.layerViews[g], this.noOccluderView!, frame);
      });
    }
  }
```

In `ts/src/render/passes/transparent-sort-pass.ts`:
- togli `PROFILE_STAGES` e il suo commento (righe 25-26); `SORT_STAGES` resta;
- nel commento della classe (righe 92-94) sostituisci "One pass per stage, 22 in all, while the GPU profiler measures, each after its own `mark`; `profileStages` lists the same 22, or `[]` when the sort is skipped." con "One pass per stage, 22 in all, while the GPU profiler measures (it passes `stage`), each named by its own `stage()` call.";
- togli il metodo `profileStages(frame)` (righe 267-270);
- in `execute` sostituisci il parametro `mark?: (encoder: GPUCommandEncoder) => void` con `stage?: (name: string) => void`, e il tratto da `if (mark) {` fino a `} else {` compreso (righe 303-317) con:

```ts
    if (stage) {
      stage('gather');
      const gather = encoder.beginComputePass({ label: 'transparent-sort/gather' });
      this.encodeGather(gather, bound);
      gather.end();
      if (target) this.copyGathered(encoder, target);
      for (let p = 0; p < PASSES; p++) {
        for (const s of SORT_STAGES) {
          stage(s);
          const pass = encoder.beginComputePass({ label: `transparent-sort/${s}` });
          this.encodeStage(pass, s, p);
          pass.end();
        }
      }
    } else {
```

- nel ramo `else` che segue, rinomina la variabile del ciclo: `for (const stage of SORT_STAGES) this.encodeStage(pass, stage, p);` diventa `for (const s of SORT_STAGES) this.encodeStage(pass, s, p);`, altrimenti nasconderebbe il parametro `stage`.

Esegui: `grep -rn "profileStages\|PROFILE_STAGES\|mark?:\|\.mark(" ts/src --include="*.ts"`
Atteso: nessuna riga, ne `.ts` ne `.test.ts`.

- [ ] **Passo 9: tutto verde**

Esegui:
```bash
npx --prefix ts vitest run --root ts src/render/passes/light-groups-pass.test.ts src/render/passes/transparent-sort-pass.test.ts src/render/render-graph.test.ts src/render/gpu-profiler.test.ts
npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"
npm --prefix ts test
```
Atteso: tutti PASS; `tsc` senza errori; la suite intera verde (il totale cresce dei test nuovi).

- [ ] **Passo 10: commit**

```bash
git add ts/src/render/gpu-profiler.ts ts/src/render/gpu-profiler.test.ts ts/src/render/render-pass.ts ts/src/render/render-graph.ts ts/src/render/render-graph.test.ts ts/src/render/passes/light-groups-pass.ts ts/src/render/passes/light-groups-pass.test.ts ts/src/render/passes/transparent-sort-pass.ts ts/src/render/passes/transparent-sort-pass.test.ts
git commit -F - <<'EOF'
feat(profiler): timestampWrites sui pass veri al posto dei marker vuoti

Il cambio di API del profiler nuovo (design 2026-09-29, §3-§6). GpuProfiler non inserisce più compute pass vuoti come marker, che su Metal non vengono mai campionati (M7): nei frame misurati il grafo gli passa l'encoder (instrument), entra in ogni nodo (enterNode, con l'opt-out profile: false) e dà a ogni pass la funzione stage(). Il profiler risolve le coppie, aggiunge il sigillo del frame (un command buffer rifiutato si scarta come unexecuted invece di ripresentare un frame vecchio), valuta i frame con timestamp-frames.ts e tiene lo span. LightGroupsPass e TransparentSortPass nominano gli stage con stage(); profileStages e mark spariscono. I nomi letti dal bench e da M9 non cambiano.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: `getGpuFrameTiming()` nel renderer e nella facade

**File:**
- Modifica: `ts/src/renderer.ts:57, 172-190, 1139-1143`, `ts/src/hyperion.ts:13, 674-704`, `ts/src/index.ts:38`
- Test: `ts/src/hyperion.test.ts:76-90, 963-990`, `ts/src/prefab/integration.test.ts:66-76`

**Interfacce:**
- Usa: `GpuProfiler.frameTiming()` e `GpuFrameTiming` (Task 3).
- Produce:
  - `Renderer.getGpuFrameTiming(): GpuFrameTiming | null`;
  - `Hyperion.getGpuFrameTiming(): GpuFrameTiming | null`;
  - `export type { PassTiming, GpuFrameTiming } from './render/gpu-profiler'` in `index.ts`.

- [ ] **Passo 1: scrivi il test che fallisce**

In `ts/src/hyperion.test.ts`, nel `mockRenderer()` (dopo `getGpuTimings: vi.fn(() => []),`, riga 83) aggiungi `getGpuFrameTiming: vi.fn(() => null),`. Stessa riga in `ts/src/prefab/integration.test.ts`, dopo la riga 71.

Poi, nel `describe('GPU profiling', ...)` di `hyperion.test.ts`, aggiungi:

```ts
    it('reports the GPU frame span from the renderer', () => {
      const renderer = mockRenderer();
      renderer.getGpuFrameTiming = vi.fn(() => ({ averageMs: 3.2, lastMs: 3.1, sampleCount: 120 }));
      const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), renderer);
      expect(engine.getGpuFrameTiming()).toEqual({ averageMs: 3.2, lastMs: 3.1, sampleCount: 120 });
      engine.destroy();
    });

    it('has no frame span without a renderer (headless, or Mode A main thread)', () => {
      const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
      expect(engine.getGpuFrameTiming()).toBeNull();
      engine.destroy();
    });
```

- [ ] **Passo 2: verifica che fallisca**

Esegui: `npx --prefix ts vitest run --root ts src/hyperion.test.ts`
Atteso: FAIL, `engine.getGpuFrameTiming is not a function`.

- [ ] **Passo 3: implementazione**

`ts/src/renderer.ts`:
- riga 57: `import { GpuProfiler, type GpuFrameTiming, type PassTiming } from './render/gpu-profiler';`;
- nell'interfaccia `Renderer`, dopo `getGpuTimings(): PassTiming[];` (riga 189):

  ```ts
  /**
   * The GPU frame span (first pass beginning to last pass end) over the same
   * frames as getGpuTimings(). Passes can overlap on the GPU, so the entries of
   * getGpuTimings() can add up to more. Null when profiling is off or before
   * the first valid frame.
   */
  getGpuFrameTiming(): GpuFrameTiming | null;
  ```
- nell'oggetto restituito, dopo `getGpuTimings() { ... },` (riga 1143):

  ```ts
    getGpuFrameTiming() {
      return gpuProfilingEnabled ? gpuProfiler?.frameTiming() ?? null : null;
    },
  ```
- nel JSDoc di `enableGpuProfiling` (righe 179-182) sostituisci "Chrome may quantize timestamps (see render/gpu-profiler.ts)." con "Chrome quantizes timestamps without --enable-webgpu-developer-features (see render/gpu-profiler.ts).".

`ts/src/hyperion.ts`:
- riga 13: `import type { GpuFrameTiming, PassTiming } from './render/gpu-profiler';`;
- nel JSDoc di `enableGpuProfiling` (righe 674-682) sostituisci "Chrome quantizes GPU timestamps to 100us by default, so only the rolling mean carries usable resolution." con "Chrome quantizes GPU timestamps unless started with --enable-webgpu-developer-features (65.5 us on macOS/Metal, about 1 us on Linux/Vulkan), so only the rolling mean carries usable resolution.";
- nel JSDoc di `getGpuTimings` (righe 691-699) aggiungi in fondo: "Passes can overlap on the GPU, so the entries can add up to more than the frame: the frame is {@link getGpuFrameTiming}.";
- dopo `getGpuTimings()`:

  ```ts
  /**
   * The GPU frame span, from the first measured pass beginning to the last
   * end, over the same frames as {@link getGpuTimings}. Passes can overlap on
   * the GPU, so the span can be less than the sum of the getGpuTimings()
   * entries. Null when profiling is off, unsupported, without a local
   * renderer, or before the first valid frame.
   */
  getGpuFrameTiming(): GpuFrameTiming | null {
    return this.renderer?.getGpuFrameTiming() ?? null;
  }
  ```

`ts/src/index.ts` riga 38: `export type { PassTiming, GpuFrameTiming } from './render/gpu-profiler';`

- [ ] **Passo 4: verifica che passi**

Esegui: `npx --prefix ts vitest run --root ts src/hyperion.test.ts src/prefab/integration.test.ts`, poi `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`.
Atteso: PASS; `tsc` senza errori.

- [ ] **Passo 5: commit**

```bash
git add ts/src/renderer.ts ts/src/hyperion.ts ts/src/index.ts ts/src/hyperion.test.ts ts/src/prefab/integration.test.ts
git commit -F - <<'EOF'
feat(profiler): getGpuFrameTiming(), lo span del frame nella facade

Renderer.getGpuFrameTiming() e Hyperion.getGpuFrameTiming() restituiscono lo span del frame (dal primo inizio all'ultima fine) sugli stessi frame di getGpuTimings(), null a profiling spento o senza renderer; GpuFrameTiming è esportato da index.ts. Il JSDoc spiega la quantizzazione vera (65,5 µs su Metal, circa 1 µs su Vulkan senza flag) e che le voci possono sommare più del frame. I mock del Renderer nei test guadagnano il metodo.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: il bench usa lo span

**File:**
- Modifica: `docs/plans/assets/2026-09-27-transparent-sort-bench.js:2-3, 15-18, 37, 120-134, 143`

**Interfacce:**
- Usa: `engine.getGpuFrameTiming()` (Task 4).
- Produce: nel JSON dei risultati del bench, `total` diventa lo span del frame, compare il campo nuovo `passSum`, e il formato diventa `hyperion-5b-bench/2`: i JSON AMD (`/1`) e quelli nuovi restano distinguibili.

- [ ] **Passo 1: aggiorna il commento in testa**

Le righe 2-3 (da `// Phase 5b benchmark scenario (spec §7.3.6): the body of ONE chrome-devtools` a `` // `evaluate_script` call, used UNCHANGED at steps 0, 1, 3 and 4. ``) diventano:

```js
  // Phase 5b benchmark scenario (spec §7.3.6): the body of ONE chrome-devtools
  // `evaluate_script` call. Format /1 ran unchanged at steps 0, 1, 3 and 4 on the
  // AMD iGPU (marker profiler); /2 needs the timestampWrites profiler (2026-09-29).
```

Poi sostituisci le righe 15-18, da `// \`total\` is the sum of every pass:` a `// fxaa-tonemap 6.9 ms), so compare forward AND total between steps.` La riga 14 (`// sum of transparent-sort/{gather,upsweep,scan,scatter}: null until step 3.`) resta. Il testo nuovo è:

```js
  // `total` is the GPU frame span (engine.getGpuFrameTiming(): first pass
  // beginning to last pass end). With the marker profiler of steps 0-4 the sum
  // of every pass telescoped to that same span, so `total` stays comparable
  // across machines. `passSum` is the sum of every pass: since 2026-09-29 each
  // entry is its own pass's duration (timestampWrites), and on a GPU that
  // overlaps passes (the Apple M2) passSum exceeds total. With the markers, part
  // of a render pass's fragment work could land in the NEXT bracket (a trial at
  // 100 000 on the AMD iGPU read forward 0.28 ms, fxaa-tonemap 6.9 ms); with
  // pairs it stays in `forward`. Compare `total` between steps and machines.
```

- [ ] **Passo 2: aggiorna il risultato**

Subito dopo la riga 120 (`const passes = Object.fromEntries(engine.getGpuTimings().map((t) => [t.name, t.averageMs]));`) aggiungi una riga: lo span si legge insieme alle voci, sugli stessi frame, prima dell'`await gpuCount()` che aspetta un frame in più.

```js
      const frameTiming = engine.getGpuFrameTiming();
```

Nel `results.push({ ... })` (righe 123-134), sostituisci la riga `total: Object.values(passes).reduce((sum, ms) => sum + ms, 0),` con:

```js
        total: frameTiming?.averageMs ?? null,
        passSum: Object.values(passes).reduce((sum, ms) => sum + ms, 0),
```

Alla riga 143, `format: 'hyperion-5b-bench/1',` diventa `format: 'hyperion-5b-bench/2',`.

Dopo il controllo `if (!engine.gpuProfilingSupported) ...` (riga 37) aggiungi:

```js
  if (typeof engine.getGpuFrameTiming !== 'function') {
    throw new Error('engine.getGpuFrameTiming() is missing: this build has the marker profiler, apply the timestampWrites profiler first');
  }
```

- [ ] **Passo 3: controllo sintattico**

Esegui: `node --check docs/plans/assets/2026-09-27-transparent-sort-bench.js`
Atteso: nessun errore. Il file è un'unica espressione `async () => { … }`, quindi è uno script valido.

- [ ] **Passo 4: commit**

```bash
git add docs/plans/assets/2026-09-27-transparent-sort-bench.js
git commit -F - <<'EOF'
test(bench): il total del bench è lo span del frame, passSum la somma delle voci

Con il profiler dei marker la somma delle voci si incastrava da un capo all'altro del frame, quindi era già lo span; con le coppie di timestampWrites non più (sull'M2 i pass si sovrappongono). total legge ora getGpuFrameTiming() sugli stessi frame delle voci, e resta confrontabile con le misure AMD della 5b; passSum è la somma delle voci, nuova. Il formato passa a hyperion-5b-bench/2, e il bench si ferma con un errore chiaro su una build con il profiler vecchio.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: documentazione

**File:**
- Modifica:
  - `CLAUDE.md`: righe 65, 72, 73, 186, 245, 247, 253 (più due righe nuove sotto), 260, 273, 440, 453;
  - `.claude/agents/webgpu-pass-reviewer.md:53-55`;
  - `docs/handoff/2026-09-29-mac-m2-handoff.md`: righe 486, 760, 766-768, M8 passo 3, M9 passo 4, 862.

**Interfacce:** nessuna. Si descrivono i nomi dei Task 1-5.

- [ ] **Passo 1: `CLAUDE.md`**

- **Conteggi dei test (righe 65, 72, 73):** esegui `npm --prefix ts test` e `npx --prefix ts vitest run --root ts src/hyperion.test.ts`, e scrivi i totali che stampano al posto di "1883 tests + 7 skipped, 109 files" (riga 65), di "109 test files" (riga 72) e di "(95 tests)" di `hyperion.test.ts` (riga 73).
- **Riga 186 (`hyperion.ts`):** `gpuProfilingSupported`/`enableGpuProfiling`/`disableGpuProfiling`/`getGpuTimings` diventa `gpuProfilingSupported`/`enableGpuProfiling`/`disableGpuProfiling`/`getGpuTimings`/`getGpuFrameTiming`.
- **Riga 245 (`render/render-pass.ts`):** "A pass may expose `profileStages(frame)` and then receives `mark(encoder)` as the 4th `execute` argument (GPU profiler stages)." diventa "While the GPU profiler measures a frame, `execute` receives `stage(name)` as its 4th argument: the passes a node opens after `stage('x')` are timed as `node/x`; `profile: false` keeps a node out of the profiler."
- **Riga 247 (`render/render-graph.ts`):** "optional `setProfiler()` GPU timing hook" diventa "optional `setProfiler()` GPU timing hook (in a measured frame: `instrument(encoder)`, `enterNode(name, pass.profile !== false)` per live node, a `stage` function to every pass)".
- **Riga 253 (`render/gpu-profiler.ts`):** sostituisci tutta la cella del ruolo con:

  > `GpuProfiler` — per-pass GPU timing via `timestamp-query`, with `timestampWrites` on the real passes (design `2026-09-29-gpu-profiler-timestamp-writes-design.md`). In a measured frame `instrument(encoder)` overrides `beginRenderPass`/`beginComputePass` as OWN properties of that encoder (`render/timestamp-intercept.ts`): each pass gets a query pair named after its node (`node/stage` after `stage()`), the original descriptor is never written (`Object.create`), and the pass encoder's draw/dispatch calls record whether it did work. `render/timestamp-frames.ts` keeps a frame only if its seal came back (`unexecuted` otherwise: a rejected command buffer) and it is not truncated, and only if every pair with work has non-zero, ordered, refreshed stamps (`zero`/`reversed`/`stale`, then `empty`). Names repeated in a frame are SUMMED; a name missing from a frame counts 0 ms; every entry has the same `sampleCount`; a name missing for a whole window is forgotten. `frameTiming()` is the span from the first beginning to the last end (`getGpuFrameTiming`). 512 pairs by default (`maxPairs`), 3 rotating readbacks plus an 8-byte seal, `WINDOW`=120, one warning after 120 discarded frames in a row naming the reason and the pass; `reset()` bumps the generation and forgets the per-index history. Types `PassTiming`, `GpuFrameTiming`, `DiscardReason`.
- **Due righe nuove, subito sotto quella di `render/gpu-profiler.ts`:**

  ```markdown
  | `render/timestamp-intercept.ts` | `instrumentEncoder(encoder, recorder)` — overrides `beginRenderPass`/`beginComputePass` as OWN properties of one encoder and wraps the work commands of the pass encoders they return; `FrameRecorder` (query pairs, node and `node/stage` names, `profile: false`, truncation, descriptors derived with `Object.create` and never written); `drawDoesWork`/`dispatchDoesWork` (counts read as WebIDL reads them, indirect commands always work) |
  | `render/timestamp-frames.ts` | `evaluateFrame(frame, history)` — the validity rules and the discard reasons in `DISCARD_ORDER`; `StampHistory` (the last value read per query index, unknown after a lost readback or `reset()`); `TimingWindow` (the 120-frame window per name, the frame span series); types `PassTiming`, `GpuFrameTiming`, `DiscardReason` |
  ```
- **Riga 260 (`render/passes/light-groups-pass.ts`):** "Stages `seed`/`sdf`/`accum` for the profiler" diventa "Names its stages `seed`/`sdf`/`accum` with the profiler's `stage()`".
- **Riga 273 (`render/passes/transparent-sort-pass.ts`):** "Nothing at count 0 (`profileStages` → `[]`)." diventa "Nothing at count 0."; "22 with the profiler: stages `gather`/`upsweep`/`scan`/`scatter`" diventa "22 when the profiler passes `stage`: stages `gather`/`upsweep`/`scan`/`scatter`".
- **Riga 440 (gotcha degli stage):** sostituisci tutto il punto con:

  > - **A graph pass can name its own stages — the `stage` argument** — the profiler times every pass a node opens under the node's name. A node that wants a breakdown calls `stage('seed')` before a stage's passes: `LightGroupsPass` does it with `seed`/`sdf`/`accum`, and `TransparentSortPass` with `gather` then `upsweep`/`scan`/`scatter` ×7, splitting into 22 passes only when `stage` is given. Stages are reported as `node/stage`, and SUMMED when the name repeats. `stage` exists only in measured frames, so a pass must work the same without it. A pass that opens passes on its own encoder, or calls `GPUCommandEncoder.prototype.beginRenderPass` directly, is not timed. The profiler holds 512 pairs per frame.
- **Riga 453 (gotcha di `timestamp-query`):** sostituisci tutto il punto con:

  > - **`timestamp-query` in Chrome: quantized without the flag, never zero for a pass with work** — stock Chrome returns ~1.024 µs steps on Linux/Vulkan (Chrome 154, RTX 4060, 2026-09-26) and multiples of 65 536 ns on macOS/Metal (Chrome 154, M2 Pro, 2026-09-29); `--enable-webgpu-developer-features` gives full resolution on both. The "Metal resolves to zeroes" reading of 2026-08-04 came from the old profiler's own markers. On Metal a pass with no draw or dispatch is not sampled, and keeps its indices' previous stamps (0 on a fresh query set); the markers were empty compute passes. The profiler now times the real passes and drops the pairs of passes without work (Mac M2 tests M7, probes 2-4).

- [ ] **Passo 2: l'agente `webgpu-pass-reviewer`**

In `.claude/agents/webgpu-pass-reviewer.md`, la regola 11 (righe 53-55) diventa:

```markdown
11. **Render graph declarations.** One blind writer per resource; a pass drawing over the graph's
    output (`loadOp: 'load'`) reads AND writes `swapchain`. GPU profiler contract: `execute`'s 4th
    argument `stage` exists only while the profiler measures, so a pass must work the same without
    it; `profile: false` keeps a node out of the profiler; a pass that opens passes on an encoder of
    its own, or through `GPUCommandEncoder.prototype`, is not timed.
```

- [ ] **Passo 3: la handoff**

In `docs/handoff/2026-09-29-mac-m2-handoff.md`:
- **Riga 486:** la frase che dice che con il Chrome stock su Metal tutti i timestamp valgono 0 e che dopo 120 frame compare "frames of zeroed timestamps" diventa: "Timestamp: senza flag Chrome quantizza a 65 536 ns su Metal; gli zeri di M7 venivano dai marker vuoti del profiler vecchio (spec `docs/plans/2026-09-29-gpu-profiler-timestamp-writes-design.md`)."
- **Riga 760 (M7, "Perché qui"):** in fondo aggiungi "(Storico: dal 2026-09-29 il profiler mette i `timestampWrites` sui pass veri.)"
- **M8, passo 3:** dopo `git worktree add ../hyperion-5b-step3 6ff494f` inserisci "poi `git cherry-pick` dei commit di codice del profiler (piano `docs/plans/2026-09-29-gpu-profiler-timestamp-writes-plan.md`, "Dopo il piano", punto 2): senza, il bench si ferma con `engine.getGpuFrameTiming() is missing`."
- **M9, passo 4:** "il totale" diventa "lo span (`getGpuFrameTiming().averageMs`)".
- **M7, "Atteso"** (righe 766-767): le due voci diventano:

  ```markdown
    - Con il flag: voci (`cull`, `forward`, `light-groups/seed|sdf|accum`, `fxaa-tonemap`) con `averageMs > 0`, `sampleCount` che sale fino a 120, e `getGpuFrameTiming()` non nullo.
    - Con il server stock: le stesse voci, con valori multipli di 65 536 ns (0 o 0,0655 ms sui pass brevi) e medie stabili, e nessun avviso del profiler. Fino al profiler nuovo qui compariva l'avviso: gli zeri venivano dai marker vuoti (M7 del 2026-09-29, spec `docs/plans/2026-09-29-gpu-profiler-timestamp-writes-design.md`).
  ```
- **M7, "Se fallisce"** (riga 768): la voce diventa "Voci vuote dopo 4 s: **fermati**, non lanciare il bench, e riferisci l'avviso del profiler, che dice il motivo e il pass."
- **M12, "Atteso"** (riga 862): "Nessun timing: il profiling si fa solo in Chrome." diventa:

  ```markdown
    - Il profiler in Safari: `enableGpuProfiling()` su `?mode=B`, poi `getGpuTimings()` e `getGpuFrameTiming()` dopo circa 4 s. Voci non vuote e nessun errore di validazione in console: verifica il meccanismo della spec del profiler (override come proprietà proprie, membri ereditati del descrittore). Se Safari rifiuta i membri ereditati, il ripiego è nella spec, §8.2.
  ```

- [ ] **Passo 4: controlli**

Esegui:
```bash
git diff --numstat CLAUDE.md .claude/agents/webgpu-pass-reviewer.md docs/handoff/2026-09-29-mac-m2-handoff.md
git grep -nE "profileStages|totalAverageMs|mark\(encoder\)|mark\?\.\(" -- CLAUDE.md .claude
```
Atteso: pochi cambi per file e nessuna cancellazione inattesa (vedi il gotcha "After a scripted edit to a long doc, check `git diff --numstat`"); il `git grep` non trova niente.

- [ ] **Passo 5: commit**

```bash
git add CLAUDE.md .claude/agents/webgpu-pass-reviewer.md docs/handoff/2026-09-29-mac-m2-handoff.md
git commit -F - <<'EOF'
docs(profiler): CLAUDE.md, webgpu-pass-reviewer e handoff per il profiler nuovo

CLAUDE.md: le righe di hyperion.ts, render-pass.ts, render-graph.ts, gpu-profiler.ts, light-groups-pass.ts e transparent-sort-pass.ts descrivono il profiler con timestampWrites; il gotcha degli stage parla di stage(); il gotcha di timestamp-query dice la causa vera degli zeri su Metal (i marker vuoti) e la quantizzazione a 65,5 µs. webgpu-pass-reviewer: la regola 11 controlla il contratto nuovo invece di profileStages/mark. Handoff: gli esiti attesi di M7 con il server stock e la verifica del profiler in Safari (M12).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: validazione e review

**File:** nessuno di nuovo. Le correzioni che la review chiede si fanno test-first nel file interessato.

- [ ] **Passo 1: preflight**

Esegui: `scripts/preflight.sh`
Atteso: "Tutti i controlli sono verdi." Se qualcosa fallisce, correggilo prima di andare avanti.

- [ ] **Passo 2: review avversaria del range**

Lancia il workflow `adversarial-review` con:
- `range`: dal commit prima del Task 1 fino a HEAD;
- `spec`: la spec;
- `plan`: questo piano;
- `lenses`: `webgpu`, `docs`, più una lente `profiler` che controlli:
  - che l'intercettazione non tocchi mai i frame non misurati né altri encoder;
  - la regola del lavoro contro la tabella della spec §4.4;
  - il sigillo (scritture in coda prima del submit, copia nello stesso command buffer, allineamenti a 4 byte);
  - la storia aggiornata solo dai frame eseguiti;
  - l'ordine dei motivi;
  - le chiavi invariate del bench e di M9.

Classifica i risultati. Correggi ogni Critical e Important con un test che fallisce prima, in commit separati (`fix(profiler): …`). Sono commit di codice: vanno anche sui worktree di M8 ("Dopo il piano", punto 2).

- [ ] **Passo 3: webgpu-pass-reviewer**

Lancia l'agente `webgpu-pass-reviewer` sui pass toccati (`transparent-sort-pass.ts`, `light-groups-pass.ts`) e su `gpu-profiler.ts`: usi dei buffer, dimensioni e allineamenti delle copie, `QUERY_RESOLVE`. Gestisci i suoi risultati come al passo 2.

- [ ] **Passo 4: push**

```bash
git push
```

---

### Task 8: verifica sulla GPU (M7 rifatto sull'M2)

**File:**
- Modifica: `docs/plans/assets/2026-09-29-mac-m2/README.md` (sezione M7 e tabella degli esiti)
- Crea, in `docs/plans/assets/2026-09-29-mac-m2/`:
  - `m7-profiler-gpu-B.json`, `m7-profiler-stock-B.json`, `m7-profiler-gpu-C.json`;
  - `m7-profiler-gpu-overlays-B.json`;
  - `m7-profiler-gpu-bench.json`, `m7-profiler-stock-bench.json`.

**Interfacce:**
- Nel harness usa `window.__hyperion` (`enableGpuProfiling`, `getGpuTimings`, `getGpuFrameTiming`, `use`/`unuse`).
- Per i contatori di scarto legge `engine.renderer.graph.profiler`: in una build di sviluppo i campi `private` di TypeScript sono proprietà normali a runtime, quindi non serve nessuna API nuova.

**L'`initScript` da passare a ogni `navigate_page`.** Ferma i reload del client di Vite quando la WebSocket HMR si chiude. Il README delle prove Mac (sezione M6) lo descrive, ma il testo non è nel repo, quindi eccolo:

```js
(() => { const Native = window.WebSocket; window.__viteWsCloses = []; function Patched(url, protocols) { const ws = protocols === undefined ? new Native(url) : new Native(url, protocols); const proto = Array.isArray(protocols) ? protocols.join(',') : String(protocols ?? ''); if (proto.includes('vite-hmr')) { ws.addEventListener('close', (e) => { const rec = { t: new Date().toISOString(), perf: Math.round(performance.now()), code: e.code, reason: e.reason, wasClean: e.wasClean }; window.__viteWsCloses.push(rec); console.warn('[mac-m2 test] vite-hmr websocket closed, reload suppressed: ' + JSON.stringify(rec)); e.stopImmediatePropagation(); }); } return ws; } Patched.prototype = Native.prototype; Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }); window.WebSocket = Patched; })()
```

**Lo snippet di misura, usato ai passi 2-4.** Si passa a `evaluate_script` con il `filePath` di ciascun passo:

```js
async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const engine = window.__hyperion;
  // Dev harness only: TypeScript-private fields are plain properties at runtime.
  const profiler = () => engine.renderer?.graph?.profiler ?? null;
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(' ')); warn(...a); };
  try {
    if (!engine.enableGpuProfiling()) return { error: 'enableGpuProfiling() returned false' };
    const t0 = performance.now();
    let rafs = 0;
    let counting = true;
    const count = () => { rafs++; if (counting) requestAnimationFrame(count); };
    requestAnimationFrame(count);
    await sleep(1000); // warm-up
    const warm = { ...profiler().discardReasons };
    while ((engine.getGpuFrameTiming()?.sampleCount ?? 0) < 120 && performance.now() - t0 < 15000) await sleep(100);
    counting = false;
    const elapsedMs = performance.now() - t0;
    const timings = engine.getGpuTimings();
    const frame = engine.getGpuFrameTiming();
    await sleep(2000);
    const again = engine.getGpuTimings();
    const after = { ...profiler().discardReasons };
    const skippedFrames = profiler().skippedFrames;
    engine.disableGpuProfiling();
    return {
      fps: (rafs * 1000) / elapsedMs, elapsedMs, frame, timings, again, skippedFrames, discardReasons: after,
      discardsAfterWarmUp: Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - warm[k]])),
      warnings: warnings.filter((w) => w.includes('GPU profiling')),
    };
  } finally {
    console.warn = warn;
  }
}
```

**Criteri di accettazione comuni ai passi 2-4:**
- `frame.sampleCount === 120` con `elapsedMs < 15000`; annota `elapsedMs` e `skippedFrames`;
- `fps >= 50`;
- `discardsAfterWarmUp` vale 0 per tutti e sei i motivi. È questo il "nessun frame scartato", non il `sampleCount`, perché nella finestra entrano solo i frame validi;
- le voci contengono `cull`, `forward`, `light-groups/seed`, `light-groups/sdf`, `light-groups/accum` e `fxaa-tonemap`, tutte con `averageMs > 0` e `sampleCount === 120`;
- `cull`, `forward` e `fxaa-tonemap` aprono un solo pass ciascuna, quindi in ogni frame durano al più lo span: `averageMs <= frame.averageMs`;
- per `forward`, fra `timings` e `again`, vale `|Δ averageMs| / averageMs <= 0.25` (medie stabili);
- `warnings` vuoto.

- [ ] **Passo 1: dev server riavviato**

Ferma il dev server se gira, poi lancia `npm --prefix ts run dev -- --strictPort --port 5173` in background. Il riavvio evita la trasformazione vecchia di Vite (gotcha "Restart the dev server").

- [ ] **Passo 2: server "gpu", Mode B, tab Lighting**

Con `chrome-devtools-gpu`, `navigate_page` su `http://localhost:5173/?mode=B`, con `ignoreCache: true` e l'`initScript`. Clicca la tab Lighting e aspetta che i suoi check finiscano. Poi lo snippet, con `filePath` = `docs/plans/assets/2026-09-29-mac-m2/m7-profiler-gpu-B.json`.
Criteri: quelli comuni.

- [ ] **Passo 3: server "stock", stesso scenario**

Stesso passo con `chrome-devtools`, nel file `m7-profiler-stock-B.json`.
Criteri: quelli comuni, più uno: il `lastMs` di `forward` è un multiplo di 0,065536 ms (`Math.abs(lastMs / 0.065536 - Math.round(lastMs / 0.065536)) < 1e-6`).

- [ ] **Passo 4: server "gpu", Mode C**

Ripeti il passo 2 con `?mode=C`, nel file `m7-profiler-gpu-C.json`. Sono i frame con lo scatter.
Criteri: quelli comuni; la voce `scatter`, quando c'è, segue le stesse regole.

- [ ] **Passo 5: pass esterni e opt-out**

Server gpu: di nuovo `navigate_page` su `http://localhost:5173/?mode=B`, con lo stesso `initScript`, poi la tab Lighting. Poi un `evaluate_script` con `filePath` = `docs/plans/assets/2026-09-29-mac-m2/m7-profiler-gpu-overlays-B.json`:

```js
async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const engine = window.__hyperion;
  const { boundsVisualizerPlugin } = await import('/src/debug/bounds-visualizer.ts');
  const overlay = (name, profile) => ({
    name, reads: ['swapchain'], writes: ['swapchain'], optional: false, ...(profile === false ? { profile } : {}),
    setup() {}, prepare() {}, resize() {}, destroy() {},
    execute(encoder, _frame, resources) {
      const view = resources.getTextureView('swapchain');
      if (!view) return;
      encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }] }).end();
    },
  });
  // The cleanup removes the pass: without it, unuse() would leave it in the graph.
  const plugin = (name, profile) => ({
    name, version: '0',
    install(ctx) {
      ctx.rendering?.addPass(overlay(name, profile));
      return () => ctx.rendering?.removePass(name);
    },
  });
  const bounds = boundsVisualizerPlugin();  // starts enabled and draws the bounds: a plugin pass with work
  engine.use(bounds);
  engine.use(plugin('probe-timed'));         // no draw: a pair without work, 0 ms
  engine.use(plugin('probe-optout', false));
  try {
    engine.enableGpuProfiling();
    const discardedBefore = engine.renderer.graph.profiler.discardedFrames;
    await sleep(3000);
    const t = new Map(engine.getGpuTimings().map((e) => [e.name, e]));
    const discarded = engine.renderer.graph.profiler.discardedFrames - discardedBefore;
    engine.disableGpuProfiling();
    return {
      bounds: t.get('bounds-visualizer') ?? null, timed: t.get('probe-timed') ?? null,
      optedOut: !t.has('probe-optout'), discarded, names: [...t.keys()],
    };
  } finally {
    for (const name of [bounds.name, 'probe-timed', 'probe-optout']) engine.unuse(name);
  }
}
```

**Criteri:**
- `bounds.averageMs > 0`: un pass di plugin con lavoro viene misurato da solo;
- `timed.averageMs === 0`: un pass senza lavoro vale 0 ms e non invalida i frame;
- `optedOut === true`;
- `discarded === 0`.

- [ ] **Passo 6: la scena del bench (il sort misurato su GPU)**

La tab Lighting non ha entità trasparenti, quindi il sort non gira. Questo passo è l'unico in cui i suoi 22 pass misurati girano su una GPU vera prima di M8.

Server gpu:
1. `navigate_page` su `http://localhost:5173/?mode=B&bench`, con lo stesso `initScript`, senza aprire tab.
2. Un `evaluate_script` con `() => { window.__benchOpts = { label: 'task8 smoke', sizes: [10000], zModes: ['same', 'distinct'] }; }`.
3. Un secondo `evaluate_script` che passa come `function` il contenuto di `docs/plans/assets/2026-09-27-transparent-sort-bench.js`, con `filePath` = `docs/plans/assets/2026-09-29-mac-m2/m7-profiler-gpu-bench.json`.

Ripeti sul server stock, nel file `m7-profiler-stock-bench.json`.

**Criteri:** in ogni risultato:
- `samples === 120`, `sort !== null`, `total > 0` e `passSum > 0`;
- sul server gpu, ogni `stages[s] > 0`;
- in console, nessun avviso `GPU profiling`.

- [ ] **Passo 7: README e commit**

Nella sezione M7 del README aggiungi un punto "**Profiler nuovo (Task 8 del piano)**". Riporta, dai sei file, gli esiti misurati:
- voci e span;
- scarti dopo il riscaldamento;
- quantizzazione dello stock;
- overlay e opt-out;
- stage del sort.

Nella tabella degli esiti:
- la riga M7 passa a **passa** e cita i file nuovi;
- la riga "M8, M9" passa a "pronti: aspettano l'alimentatore".

Esegui `git diff --numstat docs/plans/assets/2026-09-29-mac-m2/README.md`. Non devono esserci cancellazioni inattese (gotcha "After a scripted edit to a long doc").

Il messaggio di commit riporta solo ciò che i file dimostrano:

```bash
git add docs/plans/assets/2026-09-29-mac-m2/README.md docs/plans/assets/2026-09-29-mac-m2/m7-profiler-*.json
git commit -F - <<'EOF'
test(mac): M7 rifatto con il profiler nuovo

<Gli esiti, dai file m7-profiler-*.json: le voci con sampleCount 120 e averageMs > 0 in Mode B e C, lo span, gli scarti dopo il riscaldamento per motivo, la quantizzazione a 65 536 ns sullo stock, l'overlay dei bounds misurato e l'opt-out, gli stage del sort sulla scena del bench.>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git push
```

Il paragrafo fra `< >` si scrive con i numeri veri dei file. Se un criterio fallisce, non si committa un "passa": si riferisce il fallimento con il file che lo mostra.

---

## Dopo il piano: M8 e M9

Non sono task di codice, ma la ripresa dei test sul Mac: si seguono la handoff (M8, M9) e la spec (§11).

1. **Condizioni:** alimentatore collegato, con i watt annotati, e `caffeinate -dimsu` per tutta la durata.
2. **La patch sui commit di riferimento** `6ff494f` e `608a113`. Chiamiamo `<base>` il commit prima del Task 1 (`90d6fd2`, o quello del piano rivisto).
   - Elenca i commit di codice: `git log --reverse --format='%h %s' <base>..HEAD -- ts/src docs/plans/assets/2026-09-27-transparent-sort-bench.js`. Sono i Task 1-5 e ogni `fix(profiler)` del Task 7; non quelli di sola documentazione (Task 6 e 8).
   - Controlla che i file toccati siano uguali ai riferimenti: `git diff --stat <riferimento> <base> -- $(git diff --name-only <base> HEAD -- ts/src)`. Oggi differiscono solo `renderer.ts` (5 righe) e `transparent-sort-pass.test.ts` (16).
   - `git worktree add ../hyperion-5b-step3 6ff494f` (e `../hyperion-5b-step4 608a113`), poi `git cherry-pick` di quei commit, in ordine. Se `transparent-sort-pass.test.ts` va in conflitto, si risolve a mano.
3. **Il bench**, alla versione di HEAD (formato `/2`), su `?mode=B&bench` di ogni worktree:
   - si confronta **`total`**, cioè lo span, fra i passi e con il `total` AMD (formato `/1`);
   - `passSum` e le voci singole servono solo sull'M2.
4. **M9:** il ciclo della handoff legge `light-groups/seed|sdf|accum`, con le stesse chiavi. Come misurare il costo della lighting sull'M2 lo sceglie l'utente (handoff, M9, ⚠️): il Task 8 ha mostrato che le voci sono intervalli che si sovrappongono anche fra pass dipendenti.
5. **Linux (Vulkan)**, al ritorno sulla macchina Fedora: i passi 2-6 del Task 8, con le avvertenze di CLAUDE.md sugli adapter.
6. **Alla fine dei test sul Mac:** la sezione 9 della handoff, "Esito sul Mac" (spec §7.4).
