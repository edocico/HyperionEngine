# Fase 5b — GPU sort + uber pipeline: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** le primitive `.transparent()` di tipo 0-5 si disegnano dal fondo al davanti per z di mondo (`entity-bounds.z`); a parità di z sta davanti l'id esterno più alto (D2). L'ordine è deterministico da un frame all'altro senza overflow, arriva da un radix sort stabile su GPU (< 1 ms a 100 000 trasparenti visibili sull'iGPU AMD) e passa in un solo draw uber. Pipeline opache, occluder, `LightAccumStage`, selezione e i 28 bucket del cull non cambiano.

**Architecture:** il grafo di scena diventa `ScatterPass → CullPass (invariato) → TransparentSortPass → ForwardPass` in tutti e sei i grafi. Quattro pezzi, in quest'ordine, ognuno verificabile da solo: (1) composizione degli shader — un preludio con i nomi condivisi e sei librerie con prefisso, da cui un compositore TS puro ricava i 6 moduli per tipo e il modulo uber; (2) colonna `entity-ids` sulla GPU, caricata solo quando cambia la generazione della mappatura slot→id, e `transparentCount` ricalcolato in Rust e trasportato nei tre Mode; (3) `TransparentSortPass`: gather delle 12 regioni trasparenti in chiavi `(zKey, id)` + radix sort LSD stabile a 7 passate da 8 bit, con dispatch indiretti dimensionati dal conteggio GPU, più una readback di dev (`engine.debug.readTransparentSort()`); (4) il sub-pass trasparente di `ForwardPass` diventa una pipeline uber e un solo `drawIndexedIndirect`. Il passo 0 fissa una baseline senza perdita e un benchmark committato; ogni passo chiude con un cancello GPU.

**Tech Stack:** Rust 1.97 (hecs, wasm-bindgen, wasm-pack), TypeScript + Vite + vitest (Node 24), WGSL/WebGPU (Chrome 154, Dawn su Vulkan, iGPU AMD RDNA 3), MCP `chrome-devtools-gpu`, `node:test`, `naga-cli`.

**Spec:** `docs/plans/2026-09-27-transparent-sort-uber-design.md` (approvata; commit `bcac087`, `7915d85`, `aa9ee92`). Branch `feat/transparent-sort-uber`, base `72c0f7e`.

## Global Constraints

- **Capacità:** `MAX_GPU_ENTITIES = 100_000`, esportata da `ts/src/types.ts` accanto a `MAX_EXTERNAL_ID`; nel sort `CAP = MAX_GPU_ENTITIES` (import, mai un literal nuovo). Sostituisce le quattro copie (`renderer.ts:56`, `cull-pass.ts:215`, `cull-pass.ts:223`, il default di `types.ts:105`); il valore non cambia e `cull.wgsl` resta com'è.
- **Id esterni:** `MAX_EXTERNAL_ID = 1_048_575` (2^20 − 1): l'id sta nei 20 bit bassi della parola `lo`.
- **D10:** `validateConfig` rifiuta `maxEntities > MAX_GPU_ENTITIES` con un errore che nomina il limite; il default è `config.maxEntities ?? MAX_GPU_ENTITIES`. Il renderer avvisa una volta sola se `entityCount > MAX_GPU_ENTITIES` (spawn raw).
- **Storage buffer per stage ≤ 8:** layout del gather = 7 storage + 1 uniform; layout condiviso da upsweep/scan/scatter = 6 storage + 1 uniform; ogni binding dichiarato viene letto; `requiredLimits` non si alza.
- **Memoria di workgroup ≤ 16 384 B per entry point:** `gather_main` 96 B, `upsweep_main` 1024 B, `scan_main` 1024 B, `scatter_main` 9216 B.
- **Uniform:** `sort-pass-params` = 7 slice da 256 B (slice p = `{passIndex = p, 0, 0, 0}`), scritte UNA volta nel `setup()`; `GatherParams {limit, stamp, _pad0, _pad1}`, reset dell'header e azzeramento dei 64 B di `diag` una volta per `prepare()`. **Nessun `writeBuffer` in `execute()`**; nessun `mapAsync` in `execute()` né in `prepare()`.
- **Pool:** nessun pass registra buffer nel pool durante il `setup()`. `entity-ids`, `transparent-order` e `transparent-args` li crea `createRenderer`; buffer e marcatore della generazione non vivono mai in un pass.
- **Direttiva:** `diagnostic(off, derivative_uniformity);` solo nel modulo uber, alla prima riga; moduli per tipo e pezzi non hanno direttive.
- **msdf:** `msdf_shade` usa `sampleTier` crudo, mai `sampleTierOrWhite`.
- **Gruppo 2:** raggiungibile staticamente solo da `fs_main`, tramite `applyLighting`, chiamata solo da `quad_fs` e `gradient_fs`; mai da `fs_occluder` né da `vs_main`; mai applicata dopo lo switch dell'uber.
- **line:** `fwidth(in.uv.y)` prima di ogni ramo (`switch`/`discard`/`if`) di `line_shade`; `transparent` calcolato dal bit 8, non cablato; `edgeScale` interpolato con la prospettiva, non flat; `line_fs` fa `discard` fuori dal tratto quando `transparent == 0`; `line_occluder` scarta con `a <= 0 || !insideStroke`; `line_vs` legge `OCCLUDER_PASS`.
- **Interfaccia fra stage:** `VertexOutput` a 9 locazioni (0-5 come oggi, 6 `edgeScale`, 7 flat `transparent`, 8 flat `primType`); `CameraUniform` da 80 B nel preludio.
- **Pipeline uber (trasparente):** blend colore `src-alpha / one-minus-src-alpha / add`, blend alfa `one / one-minus-src-alpha / add`; `depth24plus`, `depthWriteEnabled: false`, `depthCompare: 'less'`; cull `back`; stesso vertex buffer (unit quad `float32x3`) e stesso index buffer; layout a tre gruppi; un solo `drawIndexedIndirect(transparent-args, 0)`, saltato con `frame.transparentCount === 0`; `transparent-args` nel render pass è solo INDIRECT.
- **Header `transparent-args` (64 B):** parole 0-4 `DrawIndexedIndirect {6, n, 0, 0, 0}`; 5-7 `DispatchIndirect {ceil(n/1024), 1, 1}` all'offset 20 B; 8 `raw`; 9 `limit`; 10 `overflow = raw > limit`; 11 `stamp` (`prepare()` scrive la sentinella `0xFFFFFFFF`, il gather la sovrascrive); 12-15 riservate. `diag[0]`: bit 0 = somma dello scan ≠ n, bit 1 = destinazione dello scatter ≥ n.
- **Stamp:** `stamp = stamp % 0xFFFFFFFE + 1`, una volta per `render()`, contatore nella closure di `createRenderer`; dominio [1, 0xFFFFFFFE]: mai 0 (staging nuovo), mai `0xFFFFFFFF` (sentinella).
- **Normalizzazione:** conteggio assente o non finito → `entityCount`; generazione assente o non finita → `NaN` (upload a ogni frame); un default costante 0 sulla generazione è vietato; warning una tantum in dev.
- **Upload degli id:** `writeBuffer(entity-ids, 0, state.entityIds, 0, entityCount)` tra la fine dell'if/else degli upload (`renderer.ts` ~831) e la selection mask (~833), quindi anche nei frame con lo scatter del Mode C; marcatore `uploadedIdsGeneration = NaN` locale della closure.
- **Chiave:** `lo = id esterno` in `keys[i]`, `hi = zKey` in `keys[CAP + i]`; `zb` = bit di `entity-bounds[slot].z` letto come `vec4<u32>`; `if (zb == 0x80000000u) { zb = 0u; }`; `zKey = select(zb | 0x80000000u, ~zb, (zb & 0x80000000u) != 0u)`; `(zKey, id)` crescente = dal fondo al davanti; `digit(p) = p < 3 ? (lo >> 8p) & 0xFF : (hi >> 8(p−3)) & 0xFF`.
- **Passate:** `PASSES = 7` (dispari), LSD da 8 bit; la passata p va A→B se pari, B→A se dispari, quindi il risultato finisce in B = `transparent-order`; l'ultima passata non scrive le chiavi, in OGNI build.
- **D2:** a parità di z sta davanti l'id esterno più alto; coincide con l'entità più recente solo nei primi 1 048 576 spawn cumulativi, poi gli id rilasciati tornano dal più vecchio. Per ordinare gli sprite si usa `.depth()`.
- **Cancelli dei passi (spec §8):** 0 = baseline senza perdita e stati (Mode B e C) + `forward` misurato, in `docs/plans/assets/`; 1 = test headless verdi, validazione Chrome + naga dei 7 moduli composti (bloccante), stati uguali alla baseline e C identico al bit, `forward` misurato, HMR dei pezzi; 2 = test Rust e TS verdi, `protocol-sync-checker` pulito, stati e C al bit; 3 = modello CPU e test del pass verdi, validazione di gather e sort (bloccante), controlli (a)-(h) di §7.3.3, sort < 1 ms a 100 000, `forward` misurato, stati e C invariati; 4 = check pixel nuovi verdi, C \ T al bit e C ∩ T entro 1/255 per canale, `forward` contro il passo 3; 5 = documentazione, `scripts/preflight.sh --full`, review avversariale, merge.
- **Comandi:** Rust `cargo test -p hyperion-core --lib <filtro>`, tutto `cargo test -p hyperion-core --all-features`, clippy `cargo clippy -p hyperion-core --all-features --all-targets -- -D warnings`; TS un file `npx --prefix ts vitest run --root ts src/<path>.test.ts`, tutto `npm --prefix ts test`, tipi `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`; WASM `npm --prefix ts run build:wasm`; validazione `scripts/preflight.sh` (`--full` alla fine). Mai `grep -P`; `--include="*.ts"` sempre tra virgolette.
- **Commit:** `<tipo>(5b): <descrizione in italiano>`, riga vuota, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Almeno un commit per task.
- **GPU:** skill `/gpu-check`, MCP `chrome-devtools-gpu`, adapter AMD forzato con l'initScript `GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)`; una nuova `navigate_page` con l'initScript dopo ogni modifica TS; dev server riavviato dopo un checkout/merge che riscrive uno shader; `resize_page` 1920×1080; `?mode=B` / `?mode=C`. `window.__hyperion` è il facade nelle build di dev.

## Review Focus

1. **Mondo senza trasparenti** (0 trasparenti, mondo vuoto, oppure trasparenti tutti fuori schermo con B > 0 e n = 0) → con B = 0 il sort non codifica nulla e `profileStages` restituisce `[]`, uguale alle chiamate a `mark`; con n = 0 upsweep e scatter indiretti a `{0, 1, 1}` restano silenziosi, i 7 scan controllano `incl == 0 == n`, il draw uber ha 0 istanze o è saltato; nessun warning di Dawn, nessun frame del profiler perso — test nel **Task 15** (device finto), draw saltato nel Task 19.
2. **Id riusati + swap-remove in un frame di scatter del Mode C** (despawn e `SpawnEntity` sullo stesso id nello stesso frame) → la generazione sale una volta, `entity-ids` si ricarica anche nel frame con lo scatter, le chiavi `lo` del gather coincidono con `frame.entityIds` — test nel **Task 11** (upload anche nei frame con lo scatter), sulla GPU nel controllo (h) del Task 17.
3. **Sprite trasparenti con texture** (tier > 0 o overflow: ogni PNG con alfa) → finiscono nelle regioni dispari `15 + 2t`, che il gather legge dal loro `firstInstance`; nessuna delle 12 regioni resta fuori — test nel **Task 13** (modello CPU con le 12 regioni piene e basi reali), sulla GPU col PNG 128×128 nel controllo (i) del Task 17.
4. **`transparentCount` sbagliato o perso** (un sito di trasporto, il Mode A non verificabile qui, gli spawn raw) → normalizzato a `entityCount`; se i visibili superano comunque B: `n = B`, `overflow = 1`, draw `{6, B, 0, 0, 0}`, nessuna scrittura oltre i buffer, `order` è una permutazione ordinata del prefisso raccolto — test nel **Task 10** (normalizzazione per ogni sito) e nel Task 13 (invarianti di overflow).
5. **Light2D `.transparent()` o tipo ≥ 7 in `renderMeta`** → mai raccolti dal gather (i bucket 26/27 restano a `LightAccumStage`); l'uber porta il tipo a `min(t, 6)` e il 6 a `culledVertex` — test nel **Task 13** (bucket 0..13 e 26/27 riempiti apposta, mai letti) e nel Task 5 (clamp e `default` dell'uber).

## Struttura dei file

| File | Azione | Responsabilità | Task |
|---|---|---|---|
| `ts/src/demo/bench-flag.ts` | crea | `isBenchMode(search)`: `?bench` apre l'harness senza sezione | 1 |
| `ts/src/demo/bench-flag.test.ts` | crea | test del flag | 1 |
| `ts/src/main.ts` | modifica | con `?bench` non chiede la sezione di default | 1 |
| `docs/plans/assets/2026-09-27-transparent-sort-bench.js` | crea | scenario di benchmark (corpo di `evaluate_script`) | 2 |
| `docs/plans/assets/2026-09-27-transparent-sort-bench-step{0,1,3,4}.json` | crea | misure ai passi 0, 1, 3, 4 | 2, 8, 18, 21 |
| `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js` | crea | cattura di un tab o degli stati (corpo di `evaluate_script`) | 3 |
| `docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs` | crea | C, T, verdetto al bit / in tolleranza, stati | 3 |
| `docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.test.mjs` | crea | test `node:test` di `compare.mjs` | 3 |
| `docs/plans/assets/2026-09-27-transparent-sort-baseline/{B,C}-<tab>.json`, `statuses-{B,C}.json`, `stability-{B,C}.txt` | crea | baseline del passo 0 e prova che C è stabile | 3 |
| `ts/src/shaders/wgsl-analysis.ts` (+ `.test.ts`) | crea | analisi del testo WGSL per i test | 4 |
| `ts/src/shaders/primitives/prelude.wgsl` | crea | nomi condivisi, binding dei gruppi 0-2, `VertexOutput`, helper | 5 |
| `ts/src/shaders/primitives/{quad,line,msdf-text,bezier,gradient,box-shadow}.wgsl` | crea | una libreria per primitiva, nomi con prefisso | 5 |
| `ts/src/render/primitive-shaders.ts` (+ `.test.ts`) | crea | `PRIMITIVE_LIBRARIES` e compositore | 5 |
| `ts/src/render/primitive-pieces.fixture.ts` | crea | carica i pezzi e produce i sette moduli composti per i test (`loadPrimitivePieces`, `composedPrimitiveModules`) | 6 |
| `ts/src/shaders/{basic,line,msdf-text,bezier,gradient,box-shadow}.wgsl` | elimina | sostituiti dai pezzi | 6 |
| `ts/src/render/passes/forward-pass.ts` (+ test) | modifica | moduli composti e `UBER_SOURCE` (6); legge le uscite del sort (15); draw uber (19) | 6, 15, 19 |
| `ts/src/render/passes/occluder-seed-stage.test.ts` | modifica | controlli WGSL riscritti sui moduli composti | 6 |
| `ts/src/entity-handle.ts`, `ts/src/prim-params-schema.ts`, `ts/src/render/primitive-bindings.ts`, `ts/src/render/passes/occluder-seed-stage.ts`, `ts/src/demo/primitives.ts` | modifica (solo commenti) | riferimenti ai sei shader eliminati (6: `occluder-seed-stage.ts`, `primitive-bindings.ts`, `demo/primitives.ts`); spec §9 (22: tutti e cinque) | 6, 22 |
| `ts/src/render/light-groups.ts` (+ test) | modifica | `LIT_PRIMITIVE_TYPES` ricavato dalla tabella | 6 |
| `ts/src/shaders/uniform-layout.test.ts`, `ts/src/shaders/storage-budget.test.ts` | modifica | anche sui 7 moduli composti; soglie sul numero di file | 6 |
| `ts/src/render/graph-requests.ts` (+ test) | modifica | `reloadShaders`, guardia sul pezzo vuoto | 7 |
| `ts/src/render/piece-reload-collector.ts` (+ test) | crea | raccolta con debounce di 50 ms degli `accept` dei pezzi | 7 |
| `ts/src/render/dump-composed-wgsl.test.ts` | crea (8), modifica (18) | con `DUMP_WGSL_DIR` scrive i moduli composti (al Task 18 anche gather e sort) | 8, 18 |
| `scripts/validate-wgsl-naga.mjs` | crea | `naga` su ogni file scritto | 8 |
| `docs/plans/assets/2026-09-27-transparent-sort-validate-wgsl.js` | crea | validazione Chrome dei moduli composti (corpo di `evaluate_script`) | 8 |
| `docs/plans/assets/2026-09-27-transparent-sort-step1/` | crea | risultati del cancello del passo 1 | 8 |
| `docs/plans/assets/2026-09-27-transparent-sort-validate-sort-wgsl.js` | crea | validazione Chrome di gather e sort (corpo di `evaluate_script`) | 18 |
| `docs/plans/assets/2026-09-27-transparent-sort-step3/` (`naga.txt`, `chrome-sort-wgsl.json`) | crea | risultati del cancello del passo 3 (uscite dei due validatori, naga e Chrome, su gather e sort) | 18 |
| `ts/src/renderer.ts` | modifica | pezzi `?raw`, `publishPrimitiveShaders`, slot HMR (6, 7); import di `frame-inputs` e `transparentCount` nel literal di `FrameState` (10); `entity-ids`, upload per generazione, `frameStamp` (11); `transparent-order`/`transparent-args`, factory, slot del sort, via `RadixSortPass` (15); `sortProbe` (16) | 6, 7, 10, 11, 15, 16 |
| `ts/src/hyperion.ts` | modifica | JSDoc di `recompileShader` (6, 7, 22); `debug.readTransparentSort()` (16) | 6, 7, 16, 22 |
| `crates/hyperion-core/src/render_state.rs` | modifica | `ids_changed`, `recount_transparent`, `transparent_count` | 9 |
| `crates/hyperion-core/src/engine.rs` | modifica | `ids_generation` | 9 |
| `crates/hyperion-core/src/lib.rs` | modifica | `engine_gpu_transparent_count`, `engine_gpu_entity_ids_generation` | 9 |
| `ts/src/worker-bridge.ts`, `ts/src/engine-worker.ts`, `ts/src/render-worker.ts` | modifica | trasporto dei due campi nei tre Mode | 10 |
| `ts/src/worker-render-state.ts` (+ test) | crea | `WasmEngine`, `captureRenderState`, `toGPURenderState` | 10 |
| `ts/src/worker-bridge.test.ts` | crea | trasporto nei tre Mode | 10 |
| `ts/src/render/render-pass.ts` | modifica | `FrameState.transparentCount` (10), `FrameState.frameStamp` (11) | 10, 11 |
| `ts/src/render/frame-inputs.ts` (+ test) | crea (10), modifica (11) | normalizzazioni e `nextFrameStamp` | 10, 11 |
| `ts/src/render-state.fixture.ts` | crea | `makeRenderState(overrides)` | 10 |
| `ts/src/integration.test.ts`, `ts/src/hyperion.test.ts`, `ts/src/lighting-api.test.ts` | modifica | fixture condivisa e `FrameState` nuovo | 10 |
| `ts/src/render/passes/debug-line-pass.test.ts` | modifica | `FrameState` nuovo: `transparentCount` (10), `frameStamp: 1` (11) | 10, 11 |
| `ts/src/types.ts` (+ `types.test.ts`) | modifica | `MAX_GPU_ENTITIES`, `validateConfig` | 11 |
| `ts/src/render/passes/cull-pass.ts` (+ `cull-pass.test.ts`) | modifica | `MAX_GPU_ENTITIES` al posto dei literal | 11 |
| `ts/src/render/passes/transparent-sort-constants.ts` | crea | costanti condivise da pass, modello e test | 13 |
| `ts/src/render/passes/transparent-sort-reference.ts` (+ test) | crea | modello CPU a fasi, verificatori di race, oracolo | 13 |
| `ts/src/shaders/transparent-gather.wgsl`, `ts/src/shaders/transparent-sort.wgsl` | crea | kernel | 14 |
| `ts/src/render/passes/transparent-sort-wgsl.test.ts` | crea | accordo testo WGSL ↔ costanti del Task 13 | 14 |
| `ts/src/render/passes/transparent-sort-pass.ts` (+ test) | crea | `TransparentSortPass` | 15 |
| `ts/src/render/graph-assembly.ts` (+ test) | modifica | factory `scene` e il suo commento | 15 |
| `ts/src/render/passes/radix-sort-pass.ts`, `radix-sort-pass.test.ts`, `ts/src/shaders/radix-sort.wgsl` | elimina | pass morto | 15 |
| `ts/src/render/transparent-sort-probe.ts` (+ test) | crea | readback di dev del sort | 16 |
| `ts/src/hyperion.test.ts`, `ts/src/prefab/integration.test.ts` | modifica | `sortProbe: null` in `mockRenderer()`; `describe('debug API')` (solo `hyperion.test.ts`) | 16 |
| `ts/src/demo/transparent-sort-checks.ts` (+ test) | crea | `verifySortReadback`, `regionClass`, `sameIdOrder` | 17 |
| `ts/src/demo/probe-checks.ts` (+ test) | modifica | terzo parametro `readSort` di `pixelCheck` | 17 |
| `scripts/gen-sort-test-png.mjs`, `ts/public/textures/sort-test-128.png` | crea | PNG 128×128 di test | 17 |
| `ts/src/demo/twin-2d.ts` | modifica | check del sort (17), 'Depth orders transparent sprites' (20) | 17, 20 |
| `ts/src/demo/blend-expect.ts` (+ test) | crea | valori attesi del blend | 20 |
| `docs/plans/assets/2026-09-27-transparent-sort-step4-compare-{B,C}.txt` | crea | confronto del passo 4 | 21 |
| `docs/plans/2026-09-27-transparent-sort-uber-design.md` | modifica | `## 11. Misure (passi 0-4)` | 21 |
| `CLAUDE.md`, `PROJECT_ARCHITECTURE.md`, `hyperion-masterplan.md` | modifica | spec §9 | 22 |
| `.claude/skills/new-primitive/SKILL.md`, `.claude/skills/gpu-check/SKILL.md`, `.claude/agents/{wgsl-validator,webgpu-pass-reviewer,claude-md-auditor}.md`, `.claude/hooks/post-edit-notices.sh`, `.claude/hooks/README.md` | modifica | spec §9 | 22 |
| `docs/plans/2026-09-27-open-items-round-plan.md` | modifica | §4, nota del passo 5b | 23 |

## Task

I task hanno un'unica numerazione e si raggruppano per passo: passo 0 = Task 1-3, passo 1 = Task 4-8, passo 2 = Task 9-12, passo 3 = Task 13-18, passo 4 = Task 19-21, passo 5 = Task 22-23. I passi 1-4 chiudono con un cancello GPU (Task 8, 12, 18, 21).

Regola del passo 0: il codice resta quello del commit base (`72c0f7e`), con la sola aggiunta del flag `?bench` del Task 1. Benchmark e baseline si prendono sul commit del Task 1, che per il resto è identico alla base; i Task 2 e 3 aggiungono solo file in `docs/plans/assets/`.

### Task 1: flag `?bench` (`ts/src/demo/bench-flag.ts` + `main.ts`)

**Files:**
- Create: `ts/src/demo/bench-flag.ts`
- Create: `ts/src/demo/bench-flag.test.ts`
- Modify: `ts/src/main.ts:1-2` (import) e `ts/src/main.ts:267-270` (coda di `main()`)

**Interfaces:**
- Consumes: `location.search: string`; `SectionSwitcher.request(key: string): Promise<void>` (`ts/src/demo/section-switcher.ts`, invariato).
- Produces: `export function isBenchMode(search: string): boolean` = `new URLSearchParams(search).has('bench')`. Con `?bench` l'harness costruisce la barra dei tab ma non apre nessuna sezione, quindi il mondo resta vuoto finché uno script non spawna; `window.__hyperion` resta impostato nelle build di dev (`main.ts:78`, invariato). Lo usano i Task 2 e 3 (e i cancelli 8, 12, 18, 21).

- [ ] **Step 1: Scrivi il test che fallisce**

`ts/src/demo/bench-flag.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isBenchMode } from './bench-flag';

describe('isBenchMode', () => {
  it('is off without the flag', () => {
    expect(isBenchMode('')).toBe(false);
    expect(isBenchMode('?mode=B')).toBe(false);
  });

  it('is on with ?bench, alone or next to other parameters, with or without a value', () => {
    expect(isBenchMode('?bench')).toBe(true);
    expect(isBenchMode('?mode=C&bench')).toBe(true);
    expect(isBenchMode('?bench=1&mode=B')).toBe(true);
  });

  it('matches the parameter name only', () => {
    expect(isBenchMode('?benchmark')).toBe(false);
    expect(isBenchMode('?mode=bench')).toBe(false);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisce**

Run: `npx --prefix ts vitest run --root ts src/demo/bench-flag.test.ts`
Expected: FAIL con `Failed to resolve import "./bench-flag" from "src/demo/bench-flag.test.ts"`: il modulo non esiste ancora.

- [ ] **Step 3: Implementazione minima**

`ts/src/demo/bench-flag.ts`:

```ts
// ts/src/demo/bench-flag.ts

/**
 * `?bench` on the harness URL: open no section, so the world stays empty.
 * The Phase 5b benchmark and baseline capture
 * (docs/plans/assets/2026-09-27-transparent-sort-*) drive the engine through
 * `window.__hyperion` (dev builds) on such a page: the benchmark needs a world
 * holding only its own quads, and the capture must wrap a section's setup
 * BEFORE it runs — Primitives included, which the harness opens at load.
 */
export function isBenchMode(search: string): boolean {
  return new URLSearchParams(search).has('bench');
}
```

- [ ] **Step 4: Esegui il test e verifica che passa**

Run: `npx --prefix ts vitest run --root ts src/demo/bench-flag.test.ts`
Expected: PASS, `3 passed`.

- [ ] **Step 5: Collega il flag in `main.ts`**

In `ts/src/main.ts`, prima (righe 1-2):

```ts
import { Hyperion } from './hyperion';
import { harnessMode } from './demo/preferred-mode';
```

dopo:

```ts
import { Hyperion } from './hyperion';
import { harnessMode } from './demo/preferred-mode';
import { isBenchMode } from './demo/bench-flag';
```

Prima (righe 267-270):

```ts
  // --- Start engine and auto-select first tab ---
  engine.start();
  switcher.request('primitives');
}
```

dopo:

```ts
  // --- Start engine and auto-select first tab ---
  engine.start();
  // `?bench` opens no section: the world stays empty for the scripts that
  // drive the engine through window.__hyperion (the Phase 5b benchmark and
  // baseline capture, docs/plans/assets/2026-09-27-transparent-sort-*).
  if (isBenchMode(location.search)) {
    console.info('[Hyperion] ?bench: no section opened; window.__hyperion is the engine');
  } else {
    switcher.request('primitives');
  }
}
```

- [ ] **Step 6: Tipi e test delle sezioni**

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Expected: nessuna riga (le sole righe TS2307 di `wasm/hyperion_core` sono filtrate).

Run: `npx --prefix ts vitest run --root ts src/demo`
Expected: PASS, tutti i file di `src/demo` verdi (compreso `bench-flag.test.ts`).

- [ ] **Step 7: Verifica sulla GPU che il flag non apre sezioni (e che senza flag non cambia niente)**

1. Bash: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/` → `200`. Altrimenti avvia il dev server in background (Bash `run_in_background`): `npm --prefix ts run dev -- --strictPort --port 5173`, e ripeti il `curl`.
2. `list_pages` → prendi il `pageId` della pagina dell'harness (se non c'è, `new_page` con `url: "about:blank"`); usalo in tutte le chiamate seguenti.
3. `navigate_page` con `pageId`, `type: "url"`, `url: "http://localhost:5173/?mode=B&bench"`, `ignoreCache: true`, `initScript: "GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)"`.
4. `list_console_messages` con `pageId`, `types: ["info", "warn", "error"]` → c'è `[Hyperion] WebGPU adapter: amd / …` (non nvidia, non SwiftShader) e `[Hyperion] ?bench: no section opened; window.__hyperion is the engine`; l'unico errore ammesso è il 404 di `favicon.ico`.
5. `evaluate_script` con `pageId`, `waitForStableDom: false`, `function`:
   ```js
   async () => {
     await new Promise((r) => setTimeout(r, 2000));
     return {
       activeTabs: document.querySelectorAll('.tab.active').length,
       engine: Boolean(window.__hyperion),
       entityCount: window.__hyperion?.stats.entityCount ?? null,
       checkItems: document.querySelectorAll('#check-list .check-item').length,
     };
   }
   ```
   Expected: esattamente `{"activeTabs":0,"engine":true,"entityCount":0,"checkItems":0}`.
6. `navigate_page` come al punto 3 ma con `url: "http://localhost:5173/?mode=B"`, poi la stessa `evaluate_script` con l'attesa portata a `4000` ms. Expected: `activeTabs` 1, `engine` true, `entityCount` 44 (la scena di Primitives: 25 quad, 3 gradienti, 3 box shadow, 10 linee, 3 bezier), `checkItems` 6.

- [ ] **Step 8: Commit**

```bash
git add ts/src/demo/bench-flag.ts ts/src/demo/bench-flag.test.ts ts/src/main.ts
git commit -m "$(cat <<'EOF'
feat(5b): flag ?bench nell'harness: nessuna sezione, mondo vuoto

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Task 2: scenario di benchmark committato + misura al passo 0

**Files:**
- Create: `docs/plans/assets/2026-09-27-transparent-sort-bench.js`
- Create (uscita della misura): `docs/plans/assets/2026-09-27-transparent-sort-bench-step0.json`

**Interfaces:**
- Consumes (da `window.__hyperion`, il facade `Hyperion` di `ts/src/hyperion.ts`): `spawn({ mode: '2d' })` → `EntityHandle` (`.position(x, y)`, `.scale(sx, sy)`, `.transparent()`, `.depth(d)`, `.destroy()`); `batch(fn)`; `resize(w, h)`; `cam.position(x, y, z)`, `cam.zoom(z)`, `cam.viewProjection`; `lighting.setBackend('off')`; `gpuProfilingSupported`; `enableGpuProfiling(): boolean` (azzera la finestra: `gpuProfiler.reset()`); `getGpuTimings(): PassTiming[]` con `{ name, averageMs, lastMs, sampleCount }`; `disableGpuProfiling()`; `addHook('frameEnd', (dt, views?: SystemViews) => void)` / `removeHook`; `stats.overflowCount`, `stats.fps`; `mode`. Dal Task 1: `?bench`.
- Produces: il file dello scenario, un'unica espressione di funzione `async () => {…}` (niente `;` finale, commenti solo dentro il corpo, perché `evaluate_script` la avvolge come dichiarazione di funzione), e il JSON `hyperion-5b-bench/1`:
  `{ format, label, mode, search, canvas: [w, h], dpr, adapter: { vendor, architecture, description }, quadPx: 16, window: 120, results: [{ N, zMode: 'same' | 'distinct', gpuEntityCount, samples, stages: { gather, upsweep, scan, scatter }, sort, forward, total, passes: { [nome]: ms }, fps }] }`.
  `stages.*` e `sort` valgono `null` finché `TransparentSortPass` non esiste (passi 0 e 1). Opzioni facoltative, impostate da una `evaluate_script` precedente: `window.__benchOpts = { label, sizes, zModes }`; i risultati si accumulano in `window.__benchResults`. Lo stesso file, invariato, produce `-step1.json` (Task 8), `-step3.json` (Task 18) e `-step4.json` (Task 21).

- [ ] **Step 1: Scrivi lo scenario**

`docs/plans/assets/2026-09-27-transparent-sort-bench.js`:

```js
async () => {
  // Phase 5b benchmark scenario (spec §7.3.6): the body of ONE chrome-devtools
  // `evaluate_script` call, used UNCHANGED at steps 0, 1, 3 and 4.
  //
  // Page: the dev harness with ?bench (no section: an otherwise empty world),
  // http://localhost:5173/?mode=B&bench, on the AMD low-power adapter.
  // Scene: N = 1 000, 10 000 and 100 000 (= CAP, 98 full tiles) 2D quads,
  // .transparent(), 16x16 px, all inside the view of a 1920x1080 target;
  // depth all 0 ('same') or all distinct in [0, 999], in shuffled order
  // ('distinct'). Positions come from a seeded PRNG: every step draws the
  // same scene. Lighting off.
  // Measure: GPU profiler on, the 120-frame rolling mean (averageMs) of every
  // pass, in frames without any readback (nothing here probes). "sort" = the
  // sum of transparent-sort/{gather,upsweep,scan,scatter}: null until step 3.
  // `total` is the sum of every pass: the profiler brackets graph passes with
  // empty compute passes, and part of a render pass's fragment work can land
  // in the NEXT bracket (a trial at 100 000 on the iGPU read forward 0.28 ms,
  // fxaa-tonemap 6.9 ms), so compare forward AND total between steps.
  // Each batch is destroyed, and gone from the GPU rows, before the next one.
  //
  // Optional, set by an earlier evaluate_script:
  //   window.__benchOpts = { label: 'step0 <sha>', sizes: [100000], zModes: ['same'] }
  // Results accumulate in window.__benchResults; every call returns all of
  // them, so a long run can be split into several calls on the same page.
  const WIDTH = 1920;
  const HEIGHT = 1080;
  const QUAD_PX = 16;
  const WINDOW = 120;
  const TIMEOUT_MS = 180000;
  const STAGES = ['gather', 'upsweep', 'scan', 'scatter'];

  const engine = window.__hyperion;
  if (!engine) throw new Error('window.__hyperion is missing: open the dev harness');
  if (!new URLSearchParams(location.search).has('bench')) {
    throw new Error('run the benchmark on a ?bench page: a harness tab adds entities, and a swapchain probe reconfigures the canvas');
  }
  if (!engine.gpuProfilingSupported) throw new Error('no timestamp-query on this device: no GPU timings');
  const opts = window.__benchOpts ?? {};
  const sizes = opts.sizes ?? [1000, 10000, 100000];
  const zModes = opts.zModes ?? ['same', 'distinct'];
  const results = (window.__benchResults = window.__benchResults ?? []);

  const frames = (n) => new Promise((resolve) => {
    const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
  // Entities on the GPU rows of the current frame (SystemViews of frameEnd).
  const gpuCount = () => new Promise((resolve) => {
    const hook = (_dt, views) => {
      engine.removeHook('frameEnd', hook);
      resolve(views ? views.entityCount : 0);
    };
    engine.addHook('frameEnd', hook);
  });
  const until = async (what, predicate) => {
    const start = performance.now();
    while (!(await predicate())) {
      if (performance.now() - start > TIMEOUT_MS) throw new Error(`timed out after ${TIMEOUT_MS} ms waiting for ${what}`);
      await frames(1);
    }
  };
  const settledAt = (n) => until(`${n} entities on the GPU`, async () => engine.stats.overflowCount === 0 && (await gpuCount()) === n);
  // mulberry32: the same scene at every step.
  const prng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  let adapter = null;
  try {
    const a = await navigator.gpu?.requestAdapter();
    adapter = a ? { vendor: a.info?.vendor ?? '', architecture: a.info?.architecture ?? '', description: a.info?.description ?? '' } : null;
  } catch {
    adapter = null;
  }

  engine.lighting.setBackend('off');
  engine.resize(WIDTH, HEIGHT);
  engine.cam.position(0, 0, 0);
  engine.cam.zoom(1);
  await settledAt(0);
  await frames(4);
  const vp = engine.cam.viewProjection;
  const halfW = 1 / vp[0];
  const halfH = 1 / vp[5];
  const size = (QUAD_PX * 2 * halfW) / WIDTH;
  const spanX = halfW - size / 2;
  const spanY = halfH - size / 2;

  for (const n of sizes) {
    for (const zMode of zModes) {
      const rand = prng(n * 2 + (zMode === 'distinct' ? 1 : 0));
      const depths = new Float64Array(n);
      if (zMode === 'distinct') {
        const order = Array.from({ length: n }, (_, i) => i);
        for (let i = n - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        for (let i = 0; i < n; i++) depths[i] = n === 1 ? 0 : (order[i] * 999) / (n - 1);
      }
      const handles = [];
      engine.batch(() => {
        for (let i = 0; i < n; i++) {
          const h = engine.spawn({ mode: '2d' })
            .position((rand() * 2 - 1) * spanX, (rand() * 2 - 1) * spanY)
            .scale(size, size)
            .transparent();
          if (zMode === 'distinct') h.depth(depths[i]);
          handles.push(h);
        }
      });
      await settledAt(n);
      await frames(8);
      if (!engine.enableGpuProfiling()) throw new Error('enableGpuProfiling() returned false');
      const forwardSamples = () => engine.getGpuTimings().find((t) => t.name === 'forward')?.sampleCount ?? 0;
      await until(`the ${WINDOW}-frame window`, async () => forwardSamples() >= WINDOW);
      const passes = Object.fromEntries(engine.getGpuTimings().map((t) => [t.name, t.averageMs]));
      const stages = Object.fromEntries(STAGES.map((s) => [s, passes[`transparent-sort/${s}`] ?? null]));
      const sort = STAGES.every((s) => stages[s] !== null) ? STAGES.reduce((sum, s) => sum + stages[s], 0) : null;
      results.push({
        N: n,
        zMode,
        gpuEntityCount: await gpuCount(),
        samples: forwardSamples(),
        stages,
        sort,
        forward: passes.forward,
        total: Object.values(passes).reduce((sum, ms) => sum + ms, 0),
        passes,
        fps: engine.stats.fps,
      });
      engine.disableGpuProfiling();
      for (const h of handles) h.destroy();
      await settledAt(0);
      await frames(4);
    }
  }

  return {
    format: 'hyperion-5b-bench/1',
    label: opts.label ?? null,
    mode: engine.mode,
    search: location.search,
    canvas: [document.getElementById('canvas').width, document.getElementById('canvas').height],
    dpr: window.devicePixelRatio,
    adapter,
    quadPx: QUAD_PX,
    window: WINDOW,
    results,
  };
}
```

- [ ] **Step 2: Controlla sintassi e forma**

Run:
```bash
node --check docs/plans/assets/2026-09-27-transparent-sort-bench.js && node -e 'const s = require("fs").readFileSync(process.argv[1], "utf8").trim(); if (!s.startsWith("async () => {") || !s.endsWith("}")) { console.error("not a bare function expression"); process.exit(1); } console.log("shape ok");' docs/plans/assets/2026-09-27-transparent-sort-bench.js
```
Expected: `shape ok`. Un commento prima di `async` o un `;` finale romperebbero la dichiarazione che `evaluate_script` valuta.

- [ ] **Step 3: Prepara la GPU (WASM, dev server, pagina a 1920×1080, adapter AMD)**

1. Bash: `find crates/hyperion-core/src crates/hyperion-core/Cargo.toml -newer ts/wasm/hyperion_core_bg.wasm \( -name '*.rs' -o -name Cargo.toml \) | head -3`. Se stampa qualcosa: `npm --prefix ts run build:wasm` (al passo 0 compila il Rust del commit base).
2. Bash: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/` → `200`; altrimenti `npm --prefix ts run dev -- --strictPort --port 5173` in background. Se il server girava già da prima di un checkout che ha toccato shader, fermalo e riavvialo.
3. `list_pages` → `pageId` della pagina dell'harness (o `new_page` con `about:blank`).
4. `resize_page` con `pageId`, `width: 1920`, `height: 1080`.
5. `navigate_page` con `pageId`, `type: "url"`, `url: "http://localhost:5173/?mode=B&bench"`, `ignoreCache: true`, `initScript: "GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)"`. Pagina nuova: nessun probe della swapchain in questa sessione (il primo riconfigura la canvas con `TEXTURE_BINDING` e cambia i tempi).
6. `list_console_messages` con `pageId`, `types: ["info", "warn"]` → `[Hyperion] WebGPU adapter: amd / rdna-3 …` e la riga `?bench`. Con nvidia o SwiftShader fermati e ripeti il punto 5.

- [ ] **Step 4: Esegui lo scenario e salva la misura del passo 0**

1. Bash: `git rev-parse --short HEAD` → `<SHA>`.
2. `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__benchOpts = { label: 'step0 <SHA>' }; return true; }"` (con lo SHA vero al posto di `<SHA>`).
3. `evaluate_script` con `pageId`, `waitForStableDom: false`, `filePath: "/home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-bench-step0.json"` e `function` = il contenuto di `docs/plans/assets/2026-09-27-transparent-sort-bench.js` alla lettera. Dura uno o due minuti (una prova a 100 000 'distinct' da sola ne ha presi 25 s).
4. Se la chiamata va in timeout: non continuare su quella pagina. Rifai il punto 5 dello Step 3, poi tre coppie di chiamate, per N = 1000, 10000, 100000 in quest'ordine: `window.__benchOpts = { label: 'step0 <SHA>', sizes: [N] }` e poi lo scenario con lo stesso `filePath`. Ogni chiamata restituisce tutti i risultati accumulati, quindi l'ultimo file li contiene tutti e sei.

- [ ] **Step 5: Verifica il JSON**

Run:
```bash
node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const want = [[1000, "same"], [1000, "distinct"], [10000, "same"], [10000, "distinct"], [100000, "same"], [100000, "distinct"]];
const bad = [];
if (j.format !== "hyperion-5b-bench/1") bad.push("format " + j.format);
if (j.mode !== "B") bad.push("mode " + j.mode);
if (j.adapter?.vendor !== "amd") bad.push("adapter " + JSON.stringify(j.adapter));
if (j.canvas.join("x") !== "1920x1080") bad.push("canvas " + j.canvas);
if (j.results.length !== want.length) bad.push(j.results.length + " results");
want.forEach(([n, z], i) => {
  const r = j.results[i] ?? {};
  if (r.N !== n || r.zMode !== z || r.gpuEntityCount !== n || !(r.samples >= 120) || !(r.forward > 0) || !(r.total >= r.forward) || r.sort !== null) {
    bad.push("result " + i + " " + JSON.stringify({ N: r.N, zMode: r.zMode, gpu: r.gpuEntityCount, samples: r.samples, forward: r.forward, total: r.total, sort: r.sort }));
  }
});
for (const r of j.results) console.log(String(r.N).padStart(6), String(r.zMode).padEnd(8), "forward", Number(r.forward).toFixed(3), "total", Number(r.total).toFixed(3), "fps", r.fps);
if (bad.length) { console.error("BAD: " + bad.join("; ")); process.exit(1); }
console.log("bench OK");
' docs/plans/assets/2026-09-27-transparent-sort-bench-step0.json
```
Expected: sei righe (`forward` e `total` in ms per N e `zMode`) e `bench OK`. `sort` è `null` in ogni risultato: al passo 0 non c'è nessun sort.

Nota per i passi 1, 3 e 4: il profiler separa i pass del grafo con compute pass vuoti, e parte del lavoro dei frammenti di un render pass può finire nella finestra del pass SUCCESSIVO (una prova a 100 000 sull'iGPU ha letto `forward` 0,28 ms e `fxaa-tonemap` 6,9 ms). Per questo ogni risultato porta anche `total`, la somma di tutti i pass: i confronti di `forward` fra i passi (1 − 0, 4 − 3) vanno riportati insieme a quelli di `total`.

- [ ] **Step 6: Console pulita**

`list_console_messages` con `pageId`, `types: ["error", "warn"]` → nessun messaggio che nomini WebGPU, validation, pipeline o device; nessun warning del LeakDetector; l'unico errore ammesso è il 404 di `favicon.ico`.

- [ ] **Step 7: Commit**

```bash
git add docs/plans/assets/2026-09-27-transparent-sort-bench.js docs/plans/assets/2026-09-27-transparent-sort-bench-step0.json
git commit -m "$(cat <<'EOF'
perf(5b): scenario di benchmark committato e misura del passo 0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Task 3: script di cattura della baseline senza perdita + catture (B, C, due volte)

**Files:**
- Create: `docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.test.mjs`
- Create: `docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs`
- Create: `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js`
- Create (uscite, nella stessa cartella): `B-<tab>.json` e `C-<tab>.json` per i 10 tab, `statuses-B.json`, `statuses-C.json`, `stability-B.txt`, `stability-C.txt`

Chiavi dei tab (quelle di `main.ts`, in quest'ordine): `primitives`, `scene-graph`, `input`, `audio`, `particles`, `rendering-fx`, `lighting`, `debug-tools`, `lifecycle`, `twin-2d`.

**Interfaces:**
- Consumes: `engine.debug.probe({ target: 'scene-hdr', uv })` → `PixelProbeResult { values: [r, g, b, a][], uv, targetSize: [w, h], canvasSize, viewProjection: Float32Array }` (servito dal prossimo frame; rifiuta l'INTERA richiesta se un punto è fuori dal target); `engine.debug.readEntityTransforms()` → `TransformsProbeResult { gpuRows, cpuRows, entityIds, entityCount, usedScatter }`; `worldToUv(x, y, vp): [number, number]` da `/src/render/debug-probe.ts` (la stessa del probe); `default.setup(engine, reporter)` del `DemoSection` in `/src/demo/<key>.ts` (lo stesso modulo che `main.ts` importa in modo lazy: Vite risolve `import('./demo/primitives')` in `import("/src/demo/primitives.ts")`); `TestReporter.results(): TestResult[]` con `{ name, status: 'pass' | 'fail' | 'skip' | 'pending', detail? }`; hook `frameEnd` → `SystemViews { entityCount, transforms, bounds, texIndices, renderMeta, primParams, entityIds }`; gli elementi `.tab` di `main.ts` nell'ordine di `TABS`; `?bench` (Task 1).
- Produces:
  - il JSON di cattura `hyperion-5b-capture/1`: `{ format, tab, mode, search, captureMode: 'wrapped' | 'fixed-wait', canvasSize, cssSize, dpr, targetSize, viewProjection: number[16], cameraStable, bitExact, gridSize: [64, 36], checkPoints: [{ check, x, y, u, v }], dropped: [{ check, x, y, u, v }], reads: 10, bitsB64, unstable: number[], moving: number[], movers: [{ id, from, to, radius }], transparent: number[], transparents: [{ id, x, y, radius, type }], snapshotGapMs, statuses }`. I punti sono indicizzati così: prima la griglia (indice `j * 64 + i`, uv `((i + 0.5)/64, (j + 0.5)/36)`), poi `checkPoints`. `bitsB64` = base64 dei byte dei `Float32Array` RGBA della prima lettura (i bit del texel f16, -0 compreso: il JSON perderebbe il segno dello zero). S = tutti i punti meno `unstable`; M = `moving`; T = `transparent`.
  - il JSON degli stati `hyperion-5b-statuses/1`: `{ format, mode, tabs: { [key]: { summary, checks: [{ name, status, detail }], unexpectedPending: string[] } } }`.
  - `compare.mjs`: esporta `TABS`, `MIN_C_FRACTION = 0.5`, `TRANSPARENT_TOLERANCE = 1 / 255`, `parseJsonOutput(text)`, `gridCount(cap)`, `pointCount(cap)`, `uvOf(cap, i)`, `decodeBits(b64, points)`, `framingDiff(base, run): string | null`, `comparePixels(base, run, step)`, `compareStatuses(base, run, allowNewSkip = [])`, `main(argv): number`; CLI `node compare.mjs --base <dir> --run <dir> --mode B|C --step 0|1|2|3|4 [--allow-new-skip '<check>' …]`, uscita 0 PASS, 1 FAIL, 2 input sbagliato. Al passo 4 applica la tolleranza su C ∩ T, ai passi 0-3 vuole C intero al bit.

- [ ] **Step 1: Scrivi il test di `compare.mjs` che fallisce**

`docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.test.mjs`:

```js
// docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.test.mjs
// Run: node --test docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABS, comparePixels, compareStatuses, parseJsonOutput } from './compare.mjs';

const VP = [0.05, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, -0.001, 0, 0, 0, 0, 1];
const GREY = [0.067, 0.067, 0.067, 1];

/** A capture of a 2x2 grid (4 points, no check points) with the given RGBA per point. */
function capture(values, extra = {}) {
  const f = new Float32Array(values.flat());
  return {
    format: 'hyperion-5b-capture/1', tab: 'primitives', mode: 'B',
    canvasSize: [100, 50], targetSize: [100, 50], dpr: 1.25, viewProjection: VP,
    gridSize: [2, 2], checkPoints: [], dropped: [], bitExact: true,
    bitsB64: Buffer.from(f.buffer).toString('base64'),
    unstable: [], moving: [], movers: [], transparent: [],
    ...extra,
  };
}
const four = () => [GREY, GREY, GREY, GREY];
const withPoint = (i, rgba) => four().map((p, k) => (k === i ? rgba : p));

test('identical captures pass with every point in C', () => {
  const r = comparePixels(capture(four()), capture(four()), 1);
  assert.equal(r.ok, true);
  assert.equal(r.c, 4);
});

test('a point that changed inside the base window is not compared', () => {
  const r = comparePixels(capture(four(), { unstable: [1] }), capture(withPoint(1, [1, 1, 1, 1])), 1);
  assert.equal(r.ok, true);
  assert.equal(r.c, 3);
});

test('a point in either motion footprint is not compared', () => {
  const r = comparePixels(capture(four()), capture(withPoint(2, [1, 0, 0, 1]), { moving: [2] }), 1);
  assert.equal(r.ok, true);
  assert.equal(r.c, 3);
});

test('a differing point of C fails and is reported', () => {
  const r = comparePixels(capture(four()), capture(withPoint(3, [0.5, 0.067, 0.067, 1])), 1);
  assert.equal(r.ok, false);
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0].index, 3);
  assert.deepEqual(r.mismatches[0].uv, [0.75, 0.75]);
});

test('+0 and -0 are different bits', () => {
  const r = comparePixels(capture(withPoint(0, [0, 0, 0, 1])), capture(withPoint(0, [-0, 0, 0, 1])), 2);
  assert.equal(r.ok, false);
});

test('step 4: a point of C ∩ T within 1/255 passes, beyond it fails', () => {
  const base = capture(withPoint(0, [0.5, 0.5, 0.5, 1]), { transparent: [0] });
  const near = capture(withPoint(0, [0.5 + 1 / 512, 0.5, 0.5, 1]));
  const far = capture(withPoint(0, [0.5 + 2 / 255, 0.5, 0.5, 1]));
  assert.equal(comparePixels(base, near, 4).ok, true);
  assert.equal(comparePixels(base, near, 3).ok, false);
  assert.equal(comparePixels(base, far, 4).ok, false);
});

test('step 4 keeps C \\ T bit-exact', () => {
  const base = capture(withPoint(0, [0.5, 0.5, 0.5, 1]));
  const run = capture(withPoint(0, [0.5 + 1 / 512, 0.5, 0.5, 1]));
  assert.equal(comparePixels(base, run, 4).ok, false);
});

test('a tab without bit-exact points (Lighting) is excluded, not failed', () => {
  const base = capture(four(), { tab: 'lighting', bitExact: false });
  const run = capture(withPoint(0, [1, 1, 1, 1]), { tab: 'lighting', bitExact: false });
  const r = comparePixels(base, run, 1);
  assert.equal(r.ok, true);
  assert.equal(r.c, 0);
  assert.match(r.excluded, /Lighting/);
});

test('any other tab with a moving camera fails instead of being excluded', () => {
  const run = capture(withPoint(0, [0.9, 0.9, 0.9, 1]), { tab: 'twin-2d', bitExact: false });
  const r = comparePixels(capture(four(), { tab: 'twin-2d' }), run, 4);
  assert.equal(r.ok, false);
  assert.equal(r.excluded, null);
  assert.match(r.problems[0], /run is not bit-exact/);
});

test('a different framing fails the tab', () => {
  const run = capture(four(), { viewProjection: VP.map((x, i) => (i === 0 ? 0.04 : x)) });
  const r = comparePixels(capture(four()), run, 1);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /framing differs: viewProjection/);
});

test('C must keep at least half of the grid', () => {
  const r = comparePixels(capture(four(), { moving: [0, 1, 2] }), capture(four()), 1);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /C keeps 1\/4 grid points/);
});

/** Statuses of every tab: one passing check each, Input with its 4 interaction checks pending. */
function statuses(overrides = {}) {
  const tabs = {};
  for (const tab of TABS) tabs[tab] = { summary: '1/1 passed', checks: [{ name: 'A', status: 'pass' }], unexpectedPending: [] };
  tabs.input = {
    summary: '1/5 passed',
    checks: [
      { name: 'Keyboard callback', status: 'pending' }, { name: 'Click callback', status: 'pending' },
      { name: 'Pointer move callback', status: 'pending' }, { name: 'Scroll callback', status: 'pending' },
      { name: 'Hit testing', status: 'pass' },
    ],
    unexpectedPending: [],
  };
  tabs['rendering-fx'] = { summary: '1/2 passed · 1 skipped', checks: [{ name: 'A', status: 'pass' }, { name: 'Tonemap switch', status: 'skip' }], unexpectedPending: [] };
  return { format: 'hyperion-5b-statuses/1', mode: 'B', tabs: { ...tabs, ...overrides } };
}
const tabWith = (checks) => ({ summary: '', checks, unexpectedPending: [] });

test('equal statuses pass, pending and skipped checks included', () => {
  assert.deepEqual(compareStatuses(statuses(), statuses()), { ok: true, problems: [] });
});

test('a check that passed and now fails is a regression', () => {
  const r = compareStatuses(statuses(), statuses({ primitives: tabWith([{ name: 'A', status: 'fail' }]) }));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /'A' was pass, now fail/);
});

test('a skipped check must stay skipped', () => {
  const run = statuses({ 'rendering-fx': tabWith([{ name: 'A', status: 'pass' }, { name: 'Tonemap switch', status: 'pass' }]) });
  assert.equal(compareStatuses(statuses(), run).ok, false);
});

test('a new check must pass, and a missing one fails', () => {
  const added = (status) => statuses({ 'twin-2d': tabWith([{ name: 'A', status: 'pass' }, { name: 'Depth orders transparent sprites', status }]) });
  assert.equal(compareStatuses(statuses(), added('pass')).ok, true);
  assert.equal(compareStatuses(statuses(), added('fail')).ok, false);
  assert.equal(compareStatuses(statuses(), statuses({ 'twin-2d': tabWith([]) })).ok, false);
});

test('a new skipped check passes only when it is allowed by name', () => {
  const run = statuses({ 'twin-2d': tabWith([{ name: 'A', status: 'pass' }, { name: 'Mode C only', status: 'skip' }]) });
  assert.equal(compareStatuses(statuses(), run).ok, false);
  assert.equal(compareStatuses(statuses(), run, ['Mode C only']).ok, true);
});

test('a capture with an unexpected pending check is invalid', () => {
  const run = statuses({ 'scene-graph': { summary: '', checks: [{ name: 'A', status: 'pass' }], unexpectedPending: ['Velocity'] } });
  const r = compareStatuses(statuses(), run);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /capture it again/);
});

test('parseJsonOutput reads plain, wrapped and double-encoded JSON', () => {
  assert.deepEqual(parseJsonOutput('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonOutput('Script ran on page and returned:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonOutput(JSON.stringify(JSON.stringify({ a: 1 }))), { a: 1 });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisce**

Run: `node --test docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.test.mjs`
Expected: FAIL con `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/2026-09-27-transparent-sort-baseline/compare.mjs'`.

- [ ] **Step 3: Implementa `compare.mjs`**

`docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs`:

```js
#!/usr/bin/env node
// docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs
//
// Compares a capture run (capture.js, one page load per mode) against the
// step-0 baseline of Phase 5b (spec §7.3.1, §7.3.5):
//   C = S_base ∩ S_run \ (M_base ∪ M_run)     T = T_base ∪ T_run
//   --step 0..3: every point of C bit-identical (the f32 bits of the f16 texel)
//   --step 4:    C \ T bit-identical, C ∩ T within 1/255 per channel
// plus the check statuses of every tab (statuses-<mode>.json).
//
// Usage: node compare.mjs --base <dir> --run <dir> --mode B|C --step 0|1|2|3|4
//                         [--allow-new-skip '<check name>' ...]
// A check the baseline does not have must pass; --allow-new-skip names a new
// check that may be 'skip' instead (a Mode C-only check, run in Mode B).
// Exit code: 0 PASS, 1 FAIL, 2 bad arguments or unreadable files.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const TABS = ['primitives', 'scene-graph', 'input', 'audio', 'particles', 'rendering-fx', 'lighting', 'debug-tools', 'lifecycle', 'twin-2d'];
/** C must keep at least this fraction of the UV grid, or the gate says nothing. */
export const MIN_C_FRACTION = 0.5;
export const TRANSPARENT_TOLERANCE = 1 / 255;

/** evaluate_script's filePath output is plain JSON; tolerate a text wrapper or a JSON string around it. */
export function parseJsonOutput(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('no JSON object in the file');
    value = JSON.parse(text.slice(start, end + 1));
  }
  if (typeof value === 'string') value = JSON.parse(value);
  return value;
}

export function gridCount(cap) {
  return cap.gridSize[0] * cap.gridSize[1];
}

export function pointCount(cap) {
  return gridCount(cap) + cap.checkPoints.length;
}

export function uvOf(cap, i) {
  const [gw] = cap.gridSize;
  if (i < gridCount(cap)) return [((i % gw) + 0.5) / gw, (Math.floor(i / gw) + 0.5) / cap.gridSize[1]];
  const p = cap.checkPoints[i - gridCount(cap)];
  return [p.u, p.v];
}

/** The first read of a capture: RGBA per point, as f32 values and as their bits. */
export function decodeBits(b64, points) {
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  if (bytes.length !== points * 16) throw new Error(`bitsB64 holds ${bytes.length} bytes, want ${points * 16}`);
  return { u32: new Uint32Array(bytes.buffer), f32: new Float32Array(bytes.buffer) };
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/** Null when base and run sample the same texels with the same camera, else what differs. */
export function framingDiff(base, run) {
  if (base.mode !== run.mode) return `mode ${base.mode} vs ${run.mode}`;
  if (!sameList(base.canvasSize, run.canvasSize)) return `canvas ${base.canvasSize} vs ${run.canvasSize}`;
  if (!sameList(base.targetSize, run.targetSize)) return `scene-hdr ${base.targetSize} vs ${run.targetSize}`;
  if (base.dpr !== run.dpr) return `devicePixelRatio ${base.dpr} vs ${run.dpr}`;
  if (!sameList(base.gridSize, run.gridSize)) return `grid ${base.gridSize} vs ${run.gridSize}`;
  if (!sameList(base.viewProjection, run.viewProjection)) return 'viewProjection';
  if (base.checkPoints.length !== run.checkPoints.length) return `${base.checkPoints.length} vs ${run.checkPoints.length} check points`;
  for (let k = 0; k < base.checkPoints.length; k++) {
    const a = base.checkPoints[k];
    const b = run.checkPoints[k];
    if (a.u !== b.u || a.v !== b.v) return `check point ${k} (${a.check}) at uv ${a.u},${a.v} vs ${b.u},${b.v}`;
  }
  return null;
}

/** Pixel verdict of one tab. */
export function comparePixels(base, run, step) {
  const result = { excluded: null, c: 0, cMinusT: 0, cAndT: 0, gridInC: 0, grid: gridCount(base), mismatches: [], problems: [], ok: false };
  const framing = framingDiff(base, run);
  if (framing) {
    result.problems.push(`framing differs: ${framing}`);
    return result;
  }
  if (base.tab === 'lighting') {
    result.excluded = 'Lighting: statuses only';
    result.ok = true;
    return result;
  }
  if (!base.bitExact || !run.bitExact) {
    result.problems.push(`the ${base.bitExact ? 'run' : 'baseline'} is not bit-exact: the camera or the scene-hdr size changed during the window (cameraStable false): capture it again`);
    return result;
  }
  const n = pointCount(base);
  const out = new Set([...base.unstable, ...run.unstable, ...base.moving, ...run.moving]);
  const t = new Set([...base.transparent, ...run.transparent]);
  const bb = decodeBits(base.bitsB64, n);
  const rb = decodeBits(run.bitsB64, n);
  for (let i = 0; i < n; i++) {
    if (out.has(i)) continue;
    result.c++;
    if (i < result.grid) result.gridInC++;
    const inT = t.has(i);
    if (inT) result.cAndT++;
    else result.cMinusT++;
    let bad = false;
    for (let k = 0; k < 4; k++) {
      const w = 4 * i + k;
      bad ||= step === 4 && inT
        ? !(Math.abs(bb.f32[w] - rb.f32[w]) <= TRANSPARENT_TOLERANCE)
        : bb.u32[w] !== rb.u32[w];
    }
    if (bad) {
      result.mismatches.push({
        index: i, uv: uvOf(base, i), inT,
        base: Array.from(bb.f32.subarray(4 * i, 4 * i + 4)),
        run: Array.from(rb.f32.subarray(4 * i, 4 * i + 4)),
      });
    }
  }
  if (result.gridInC < MIN_C_FRACTION * result.grid) {
    result.problems.push(`C keeps ${result.gridInC}/${result.grid} grid points (< ${MIN_C_FRACTION * 100}%): too unstable to gate on`);
  }
  if (result.mismatches.length > 0) result.problems.push(`${result.mismatches.length} points of C differ`);
  result.ok = result.problems.length === 0;
  return result;
}

/** Status verdict (spec §7.3.5) over every tab: base and run are statuses-<mode>.json. */
export function compareStatuses(base, run, allowNewSkip = []) {
  const problems = [];
  if (base.mode !== run.mode) problems.push(`mode ${base.mode} vs ${run.mode}`);
  for (const tab of TABS) {
    const b = base.tabs?.[tab];
    const r = run.tabs?.[tab];
    if (!b || !r) {
      problems.push(`${tab}: missing from the ${b ? 'run' : 'baseline'} statuses`);
      continue;
    }
    for (const [who, x] of [['baseline', b], ['run', r]]) {
      if (x.unexpectedPending.length > 0) problems.push(`${tab}: the ${who} was captured with pending checks (${x.unexpectedPending.join(', ')}): capture it again`);
    }
    const now = new Map(r.checks.map((c) => [c.name, c.status]));
    const known = new Set(b.checks.map((c) => c.name));
    for (const c of b.checks) {
      const status = now.get(c.name);
      if (c.status === 'fail') problems.push(`${tab}: '${c.name}' fails in the baseline`);
      else if (status === undefined) problems.push(`${tab}: '${c.name}' is missing`);
      else if (status !== c.status) problems.push(`${tab}: '${c.name}' was ${c.status}, now ${status}`);
    }
    for (const c of r.checks) {
      if (known.has(c.name) || c.status === 'pass') continue;
      if (c.status === 'skip' && allowNewSkip.includes(c.name)) continue;
      problems.push(`${tab}: new check '${c.name}' is ${c.status}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function load(dir, file) {
  return parseJsonOutput(readFileSync(join(dir, file), 'utf8'));
}

export function main(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        base: { type: 'string' },
        run: { type: 'string' },
        mode: { type: 'string' },
        step: { type: 'string' },
        'allow-new-skip': { type: 'string', multiple: true },
      },
    }).values;
  } catch (err) {
    console.error(String(err));
    return 2;
  }
  const step = Number(args.step);
  if (!args.base || !args.run || !['B', 'C'].includes(args.mode) || ![0, 1, 2, 3, 4].includes(step)) {
    console.error("usage: node compare.mjs --base <dir> --run <dir> --mode B|C --step 0|1|2|3|4 [--allow-new-skip '<check>' ...]");
    return 2;
  }
  let ok = true;
  try {
    for (const tab of TABS) {
      const base = load(args.base, `${args.mode}-${tab}.json`);
      const run = load(args.run, `${args.mode}-${tab}.json`);
      const r = comparePixels(base, run, step);
      ok &&= r.ok;
      const sizes = r.excluded
        ? `excluded (${r.excluded})`
        : `C=${r.c} (grid ${r.gridInC}/${r.grid}) C\\T=${r.cMinusT} C∩T=${r.cAndT} movers ${base.movers.length}/${run.movers.length}`;
      console.log(`${args.mode} ${tab.padEnd(13)} ${r.ok ? 'OK  ' : 'FAIL'} ${sizes}`);
      for (const p of r.problems) console.log(`    ${p}`);
      for (const m of r.mismatches.slice(0, 8)) {
        console.log(`    point ${m.index} uv ${m.uv.map((x) => x.toFixed(4))}${m.inT ? ' (T)' : ''}: ${m.base} -> ${m.run}`);
      }
    }
    const s = compareStatuses(
      load(args.base, `statuses-${args.mode}.json`),
      load(args.run, `statuses-${args.mode}.json`),
      args['allow-new-skip'] ?? [],
    );
    ok &&= s.ok;
    console.log(`${args.mode} statuses      ${s.ok ? 'OK' : 'FAIL'}`);
    for (const p of s.problems) console.log(`    ${p}`);
  } catch (err) {
    console.error(String(err));
    return 2;
  }
  console.log(ok ? 'PASS' : 'FAIL');
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
```

- [ ] **Step 4: Esegui il test e verifica che passa**

Run: `node --test docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.test.mjs`
Expected: PASS, `ℹ tests 18`, `ℹ pass 18`, `ℹ fail 0`.

- [ ] **Step 5: Scrivi lo script di cattura**

`docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js`:

```js
async () => {
  // Phase 5b lossless baseline capture (spec §7.3.1): the body of ONE
  // chrome-devtools `evaluate_script` call, reused UNCHANGED at steps 0-4.
  //
  // Page: the dev harness opened with ?bench (no section at load), e.g.
  // http://localhost:5173/?mode=B&bench, 1920x1080, AMD low-power adapter.
  // Before each call an earlier evaluate_script sets
  //   window.__captureOpts = { tab: '<key>' }   one tab, in TAB_KEYS order, once per page load
  //   window.__captureOpts = { statuses: true } after the 10 tabs: the statuses of all of them
  //
  // Per tab: (1) click the tab; (2) wait for the END of its setup() (the
  // section module's setup is wrapped; main.ts's lazy import resolves to the
  // same module instance); (3) frames(4); (4) the window: 10 successive
  // probe reads of scene-hdr at a 64x36 UV grid plus the world points of the
  // tab's checks (projected with this frame's viewProjection, the ones off
  // the target dropped and recorded); (5) the check statuses at that point.
  // Around the window, two CPU snapshots >= 1 s apart give the motion
  // footprint M (entities whose row changed: their sphere, radius
  // max(0.5*(|col0|+|col1|), bounds radius), swept between the two positions,
  // dilated 2 px) and T (spheres of the .transparent() entities of types 0-5,
  // dilated 2 px). compare.mjs computes C = S_base ∩ S_run \ (M_base ∪ M_run).
  const TAB_KEYS = ['primitives', 'scene-graph', 'input', 'audio', 'particles', 'rendering-fx', 'lighting', 'debug-tools', 'lifecycle', 'twin-2d'];
  const GRID_W = 64;
  const GRID_H = 36;
  const READS = 10;
  const SNAPSHOT_GAP_MS = 1000;
  const DILATE_PX = 2;
  const SETUP_TIMEOUT_MS = 30000;
  const FIXED_WAIT_MS = 7000;
  const INTERACTION_CHECKS = ['Keyboard callback', 'Click callback', 'Pointer move callback', 'Scroll callback'];
  // Lighting animates everything its lights reach: covered by its checks and statuses only.
  const NO_BIT_EXACT = ['lighting'];

  const engine = window.__hyperion;
  if (!engine || !engine.debug) throw new Error('window.__hyperion with a debug API is required: open the dev harness');
  if (!new URLSearchParams(location.search).has('bench')) {
    throw new Error('capture from a ?bench page: without it Primitives is set up at load, and re-entering a tab re-runs its setup');
  }
  const opts = window.__captureOpts ?? {};
  window.__captureStatuses = window.__captureStatuses ?? {};
  if (opts.statuses) {
    return { format: 'hyperion-5b-statuses/1', mode: engine.mode, tabs: window.__captureStatuses };
  }

  const tab = opts.tab;
  const index = TAB_KEYS.indexOf(tab);
  if (index < 0) throw new Error(`unknown tab '${tab}' (window.__captureOpts.tab)`);
  const visited = (window.__captureVisited = window.__captureVisited ?? []);
  if (index !== visited.length) {
    throw new Error(`tab '${tab}' out of order: the next one is '${TAB_KEYS[visited.length] ?? '(none: all captured)'}'; navigate again to restart`);
  }
  visited.push(tab);

  const frames = (n) => new Promise((resolve) => {
    const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { worldToUv } = await import('/src/render/debug-probe.ts');
  const canvas = document.getElementById('canvas');
  const tabs = document.querySelectorAll('.tab');
  if (tabs.length !== TAB_KEYS.length) throw new Error(`${tabs.length} tabs in the page, want ${TAB_KEYS.length}`);

  const domStatuses = () => [...document.querySelectorAll('#check-list .check-item')].map((item) => ({
    name: item.querySelector('.check-name')?.textContent ?? '',
    status: ['pass', 'fail', 'skip', 'pending'].find((s) => item.querySelector('.check-icon')?.classList.contains(s)) ?? 'unknown',
    detail: null,
  }));

  // (1) + (2): click, then wait for the end of setup().
  let reporter = null;
  let captureMode = 'wrapped';
  let section = null;
  try {
    section = (await import(`/src/demo/${tab}.ts`)).default;
  } catch {
    section = null;
  }
  if (section && typeof section.setup === 'function') {
    const original = section.setup;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    section.setup = async function (eng, rep) {
      reporter = rep;
      try {
        return await original.call(this, eng, rep);
      } finally {
        section.setup = original;
        finish();
      }
    };
    tabs[index].click();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`setup of '${tab}' did not finish within ${SETUP_TIMEOUT_MS} ms`)), SETUP_TIMEOUT_MS);
    });
    try {
      await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } else {
    // Fallback (spec §7.3.1): a fixed wait past the slowest setup, then two
    // identical status reads 1 s apart.
    captureMode = 'fixed-wait';
    tabs[index].click();
    await sleep(FIXED_WAIT_MS);
    let previous = JSON.stringify(domStatuses());
    for (let k = 0; ; k++) {
      await sleep(1000);
      const current = JSON.stringify(domStatuses());
      if (current === previous) break;
      if (k >= 20) throw new Error(`the statuses of '${tab}' never settled`);
      previous = current;
    }
  }

  // (3)
  await frames(4);

  // CPU snapshot of the frame's rows (a one-shot frameEnd hook: SystemViews
  // of the current frame), copied before the next frame reuses the arrays.
  const viewsSnapshot = () => new Promise((resolve) => {
    const hook = (_dt, views) => {
      engine.removeHook('frameEnd', hook);
      const n = views ? views.entityCount : 0;
      resolve({
        count: n,
        bounds: views ? views.bounds.slice(0, 4 * n) : new Float32Array(0),
        renderMeta: views ? views.renderMeta.slice(0, 2 * n) : new Uint32Array(0),
        ids: views ? views.entityIds.slice(0, n) : new Uint32Array(0),
      });
    };
    engine.addHook('frameEnd', hook);
  });

  const views1 = await viewsSnapshot();
  const rows1 = await engine.debug.readEntityTransforms();
  const t1 = performance.now();

  // Points: the 64x36 grid, then the world points of the tab's checks.
  const W = canvas.width;
  const H = canvas.height;
  const vp = new Float32Array(engine.cam.viewProjection);
  const worldPerPxX = 2 / (vp[0] * W);
  const worldPerPxY = 2 / vp[5] / H;
  const checkPointsOf = () => {
    const pts = [];
    const add = (check, list) => { for (const [x, y] of list) pts.push({ check, x, y }); };
    if (tab === 'primitives') {
      const quads = [];
      for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) quads.push([(col - 2) * 2.5, (row - 2) * 2.5]);
      add('Quad grid (5x5)', [...quads, [1.25, 1.25], [-1.25, -1.25], [3.75, 1.25], [-3.75, 3.75]]);
      const gx = -12.5;
      add('Gradients (linear/radial/conic)', [[gx - 0.9, 4], [gx + 0.9, 4], [gx, 0], [gx + 1.35, 0], [gx - 0.9, -4 + 0.15], [gx - 0.9, -4 - 0.15], [gx + 0.9, -4]]);
      const sx = -8;
      const inset = (0.29 / 0.6) * 3;
      add('Box shadows (sharp/soft/rounded)', [[sx, 4], [sx + 1.65, 4 + 1.65], [sx, 0], [sx + 1.41, 0], [sx + inset, -4], [sx + inset, -4 + inset]]);
      const column = [];
      for (let k = -4; k <= 4; k++) column.push([9, 1 + k * worldPerPxY]);
      add('Lines (6V world + 4H 3px)', [[8, 2], [8.3, 2], ...column]);
      add('Bezier curves (arch/S/wave)', [[21, 4], [21, 5.8], [21, 2.2], [21, 0], [21, -4], [21, -3], [21, -5]]);
    } else if (tab === 'scene-graph') {
      add('Parent/child hierarchy', [[0, 6], [-4, 6], [4, 6], [-2, 6], [2, 6]]);
      add('Rotation', [[-2.8, -2], [-3.1, -1.1], [-4, -2]]);
      add('Scale', [[4, -2], [4.4, -2], [10.9, -2], [14.4, -2], [13, -1.3]]);
      add('Nested transforms', [[0, -6], [3, -6], [4.25, -6], [4.6, -6]]);
    } else if (tab === 'rendering-fx') {
      add('Bloom', [[-4 + 6 * worldPerPxY, -4.5], [-4.5, -4.5]]);
      add('Outline', [[-4 + worldPerPxY, -4.5], [-1 + worldPerPxY, -4.5]]);
      add('Resize', [[0, 0]]);
    } else if (tab === 'lighting') {
      add('Lit vs unlit', [[-12, 3], [-12, -3]]);
      add('Layer shadow on screen', [[15, 2], [15, 6]]);
    } else if (tab === 'lifecycle') {
      add('Spawn + destroy', [[-12, -6]]);
      const cells = [];
      for (let row = 0; row < 4; row++) for (let col = 0; col < 10; col++) cells.push([(col - 4.5) * 1.5, (row - 2) * 1.5 + 8]);
      add('Batch operation', cells);
      add('Immediate mode', [[5, 5], [0, 0]]);
      add('Prefab lifecycle', [[10, -4], [7.75, -4], [12.25, -4], [5, -2]]);
    } else if (tab === 'twin-2d') {
      const offset = Math.round(12 / worldPerPxX) * worldPerPxX;
      const lattice = [];
      for (let i = 0; i < 9; i++) {
        const cx = -6 + ((i % 3) - 1) * 3.2;
        const cy = (Math.floor(i / 3) - 1) * 3.2;
        for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) lattice.push([cx + a * 0.3, cy + b * 0.3]);
      }
      add('Twins draw the same pixels', [...lattice, ...lattice.map(([x, y]) => [x + offset, y])]);
      add('Depth orders 2D sprites', [[36.2, 0], [42.64, 0], [42.28, 0], [41.8, 0]]);
    }
    return pts;
  };
  const grid = [];
  for (let j = 0; j < GRID_H; j++) for (let i = 0; i < GRID_W; i++) grid.push([(i + 0.5) / GRID_W, (j + 0.5) / GRID_H]);
  const checkPoints = [];
  const dropped = [];
  for (const p of checkPointsOf()) {
    const [u, v] = worldToUv(p.x, p.y, vp);
    // One point off the target makes the probe reject the whole request.
    (u >= 0 && u < 1 && v >= 0 && v < 1 ? checkPoints : dropped).push({ ...p, u, v });
  }
  const uv = [...grid, ...checkPoints.map((p) => [p.u, p.v])];
  const P = uv.length;

  // (4) the window: READS successive reads, S = the points bit-identical in all of them.
  const reads = [];
  for (let k = 0; k < READS; k++) reads.push(await engine.debug.probe({ target: 'scene-hdr', uv }));
  // (5) the statuses, at that same point.
  const checks = reporter
    ? reporter.results().map((r) => ({ name: r.name, status: r.status, detail: r.detail ?? null }))
    : domStatuses();
  const count = (s) => checks.filter((c) => c.status === s).length;
  let summary = `${count('pass')}/${checks.length} passed`;
  if (count('skip') > 0) summary += ` · ${count('skip')} skipped`;
  if (count('fail') > 0) summary += ` · ${count('fail')} failed`;
  const unexpectedPending = checks
    .filter((c) => c.status === 'pending' && !(tab === 'input' && INTERACTION_CHECKS.includes(c.name)))
    .map((c) => c.name);
  const statuses = { summary, checks, unexpectedPending };
  window.__captureStatuses[tab] = statuses;

  const first = new Float32Array(P * 4);
  reads[0].values.forEach((value, i) => first.set(value, 4 * i));
  const firstBits = new Uint32Array(first.buffer);
  const other = new Float32Array(4);
  const otherBits = new Uint32Array(other.buffer);
  const unstable = [];
  for (let i = 0; i < P; i++) {
    for (let k = 1; k < READS; k++) {
      other.set(reads[k].values[i]);
      if (otherBits[0] !== firstBits[4 * i] || otherBits[1] !== firstBits[4 * i + 1]
        || otherBits[2] !== firstBits[4 * i + 2] || otherBits[3] !== firstBits[4 * i + 3]) {
        unstable.push(i);
        break;
      }
    }
  }
  const cameraStable = reads.every((r) => r.targetSize[0] === W && r.targetSize[1] === H
    && r.viewProjection.every((x, i) => Object.is(x, vp[i])));

  // Second CPU snapshot, >= SNAPSHOT_GAP_MS after the first.
  const gap = SNAPSHOT_GAP_MS - (performance.now() - t1);
  if (gap > 0) await sleep(gap);
  const views2 = await viewsSnapshot();
  const rows2 = await engine.debug.readEntityTransforms();
  const snapshotGapMs = Math.round(performance.now() - t1);

  // Footprints in target pixels. Orthographic camera: pixels per world unit
  // from the Jacobian of world -> pixel (the larger axis when axis-aligned).
  const toPx = (x, y) => { const [u, v] = worldToUv(x, y, vp); return [u * W, v * H]; };
  const jx = [vp[0] * W / 2, vp[4] * W / 2];
  const jy = [vp[1] * H / 2, vp[5] * H / 2];
  const pxPerWorld = vp[1] === 0 && vp[4] === 0
    ? Math.max(Math.abs(jx[0]), Math.abs(jy[1]))
    : Math.hypot(jx[0], jx[1], jy[0], jy[1]);
  const segmentDistance = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const covered = (shapes) => {
    const out = [];
    for (let i = 0; i < P; i++) {
      const px = uv[i][0] * W;
      const py = uv[i][1] * H;
      if (shapes.some((s) => segmentDistance(px, py, s.a[0], s.a[1], s.b[0], s.b[1]) <= s.r)) out.push(i);
    }
    return out;
  };

  // M: every entity whose CPU row differs between the two snapshots (or that
  // exists in only one of them).
  const rowsById = (t) => {
    const m = new Map();
    for (let s = 0; s < t.entityCount; s++) m.set(t.entityIds[s], t.cpuRows.subarray(16 * s, 16 * s + 16));
    return m;
  };
  const radiusById = (snap) => {
    const m = new Map();
    for (let s = 0; s < snap.count; s++) m.set(snap.ids[s], snap.bounds[4 * s + 3]);
    return m;
  };
  const sameRow = (a, b) => {
    const ua = new Uint32Array(a.buffer, a.byteOffset, 16);
    const ub = new Uint32Array(b.buffer, b.byteOffset, 16);
    for (let w = 0; w < 16; w++) if (ua[w] !== ub[w]) return false;
    return true;
  };
  const quadRadius = (row) => 0.5 * (Math.hypot(row[0], row[1], row[2]) + Math.hypot(row[4], row[5], row[6]));
  const r1 = rowsById(rows1);
  const r2 = rowsById(rows2);
  const b1 = radiusById(views1);
  const b2 = radiusById(views2);
  const movers = [];
  for (const id of new Set([...r1.keys(), ...r2.keys()])) {
    const a = r1.get(id);
    const b = r2.get(id);
    if (a && b && sameRow(a, b)) continue;
    const radius = Math.max(a ? quadRadius(a) : 0, b ? quadRadius(b) : 0, b1.get(id) ?? 0, b2.get(id) ?? 0);
    const from = a ? [a[12], a[13]] : [b[12], b[13]];
    const to = b ? [b[12], b[13]] : from;
    movers.push({ id, from, to, radius });
  }
  const moving = covered(movers.map((m) => ({ a: toPx(...m.from), b: toPx(...m.to), r: m.radius * pxPerWorld + DILATE_PX })));

  // T: the bounds spheres of the .transparent() entities of types 0-5 (a
  // Light2D, type 6 after the cull's clamp, is not drawn by ForwardPass).
  const transparents = [];
  const seen = new Set();
  for (const snap of [views1, views2]) {
    for (let s = 0; s < snap.count; s++) {
      const meta = snap.renderMeta[2 * s + 1];
      const type = Math.min(meta & 0xff, 6);
      if ((meta & 0x100) === 0 || type === 6) continue;
      const entry = { id: snap.ids[s], x: snap.bounds[4 * s], y: snap.bounds[4 * s + 1], radius: snap.bounds[4 * s + 3], type };
      const key = `${entry.id}:${entry.x}:${entry.y}:${entry.radius}`;
      if (seen.has(key)) continue;
      seen.add(key);
      transparents.push(entry);
    }
  }
  const transparent = covered(transparents.map((t) => {
    const c = toPx(t.x, t.y);
    return { a: c, b: c, r: t.radius * pxPerWorld + DILATE_PX };
  }));

  const toBase64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  return {
    format: 'hyperion-5b-capture/1',
    tab,
    mode: engine.mode,
    search: location.search,
    captureMode,
    canvasSize: [W, H],
    cssSize: [canvas.clientWidth, canvas.clientHeight],
    dpr: window.devicePixelRatio,
    targetSize: reads[0].targetSize,
    viewProjection: Array.from(vp),
    cameraStable,
    bitExact: cameraStable && !NO_BIT_EXACT.includes(tab),
    gridSize: [GRID_W, GRID_H],
    checkPoints,
    dropped,
    reads: READS,
    bitsB64: toBase64(new Uint8Array(first.buffer)),
    unstable,
    moving,
    movers,
    transparent,
    transparents,
    snapshotGapMs,
    statuses,
  };
}
```

- [ ] **Step 6: Controlla sintassi e forma**

Run:
```bash
node --check docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js && node -e 'const s = require("fs").readFileSync(process.argv[1], "utf8").trim(); if (!s.startsWith("async () => {") || !s.endsWith("}")) { console.error("not a bare function expression"); process.exit(1); } console.log("shape ok");' docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js
```
Expected: `shape ok`.

- [ ] **Step 7: Commit degli script**

```bash
git add docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.test.mjs
git commit -m "$(cat <<'EOF'
test(5b): cattura e confronto della baseline senza perdita

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Prepara la GPU**

1. WASM aggiornato: `find crates/hyperion-core/src crates/hyperion-core/Cargo.toml -newer ts/wasm/hyperion_core_bg.wasm \( -name '*.rs' -o -name Cargo.toml \) | head -3`; se stampa qualcosa, `npm --prefix ts run build:wasm`.
2. Dev server: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/` → `200` (altrimenti `npm --prefix ts run dev -- --strictPort --port 5173` in background; riavvialo se girava da prima di un checkout che ha toccato shader).
3. `list_pages` → `pageId` (o `new_page` con `url: "about:blank"`); `resize_page` con `pageId`, `width: 1920`, `height: 1080`. Da qui fino alla fine del task: `pageId` su ogni chiamata MCP e `waitForStableDom: false` su ogni `evaluate_script` (il pannello dei check si ridisegna ogni 500 ms e l'HUD a ogni frame: il DOM non si assesta mai).
4. Cartelle: `BASE=/home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-baseline` (la baseline committata) e `RUN2=<scratchpad della sessione>/5b-baseline-run2` (percorso assoluto; la scratchpad è quella indicata nel system prompt della sessione). Bash: `mkdir -p <RUN2>`.

- [ ] **Step 9: Procedura di una cattura (un modo, una cartella, un caricamento di pagina)**

Questa procedura si usa identica qui e ai cancelli dei passi 1-4. Parametri: `MODE` (`B` o `C`) e `DIR` (percorso assoluto). `pageId` (della pagina preparata: qui quello dello Step 8, ai cancelli quello della loro preparazione) su ogni chiamata MCP, `waitForStableDom: false` su ogni `evaluate_script`.
1. `navigate_page` con `pageId`, `type: "url"`, `url: "http://localhost:5173/?mode=<MODE>&bench"`, `ignoreCache: true`, `initScript: "GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)"`.
2. `list_console_messages` con `pageId`, `types: ["info", "warn"]` → adapter `amd` e la riga `?bench`.
3. Per ogni chiave K, nell'ordine `primitives`, `scene-graph`, `input`, `audio`, `particles`, `rendering-fx`, `lighting`, `debug-tools`, `lifecycle`, `twin-2d`:
   - `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__captureOpts = { tab: 'K' }; return true; }"` (con la chiave vera al posto di `K`);
   - `evaluate_script` con `pageId`, `waitForStableDom: false`, `filePath: "<DIR>/<MODE>-K.json"` e `function` = il contenuto di `capture.js` alla lettera. Ogni chiamata dura da 2 a 12 s.
4. `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__captureOpts = { statuses: true }; return true; }"`; poi `evaluate_script` con `pageId`, `waitForStableDom: false`, `filePath: "<DIR>/statuses-<MODE>.json"` e `function` = il contenuto di `capture.js` alla lettera.
5. Se una chiamata restituisce un errore, la cattura è da buttare: si riparte dal punto 1 (navigazione nuova) e si riscrivono tutti i file di quel modo in `DIR`. Rientrare in un tab ne rilancia il `setup()`, e lo script lo impedisce: accetta i tab solo in ordine, una volta per pagina.

- [ ] **Step 10: Cattura Mode B, prima corsa → `BASE`, e verificala**

Esegui lo Step 9 con `MODE = B`, `DIR = BASE`. Poi:

```bash
node -e '
const fs = require("fs"), path = require("path");
const [dir, mode] = process.argv.slice(1);
const tabs = ["primitives", "scene-graph", "input", "audio", "particles", "rendering-fx", "lighting", "debug-tools", "lifecycle", "twin-2d"];
const movers = { "scene-graph": 1, lighting: 2, "twin-2d": 4 };
const skips = { primitives: ["MSDF text"], "rendering-fx": ["Tonemap switch"], "debug-tools": ["Determinism hash"] };
const interaction = ["Keyboard callback", "Click callback", "Pointer move callback", "Scroll callback"];
const bad = [];
for (const tab of tabs) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, `${mode}-${tab}.json`), "utf8"));
  const points = j.gridSize[0] * j.gridSize[1] + j.checkPoints.length;
  console.log(tab.padEnd(13), j.captureMode, "bitExact", j.bitExact, "points", points, "unstable", j.unstable.length, "M", j.moving.length, "T", j.transparent.length, "movers", j.movers.length, "dropped", j.dropped.length, "|", j.statuses.summary);
  if (j.format !== "hyperion-5b-capture/1" || j.mode !== mode) bad.push(`${tab}: format/mode`);
  if (j.captureMode !== "wrapped") bad.push(`${tab}: ${j.captureMode}`);
  if (!j.cameraStable) bad.push(`${tab}: the camera moved during the window`);
  if (j.bitExact !== (tab !== "lighting")) bad.push(`${tab}: bitExact ${j.bitExact}`);
  if (j.movers.length !== (movers[tab] ?? 0)) bad.push(`${tab}: ${j.movers.length} movers, want ${movers[tab] ?? 0}: ${JSON.stringify(j.movers)}`);
  if (j.dropped.length !== (tab === "twin-2d" ? 4 : 0)) bad.push(`${tab}: ${j.dropped.length} dropped points`);
  if (j.snapshotGapMs < 1000) bad.push(`${tab}: snapshots ${j.snapshotGapMs} ms apart`);
  const checks = j.statuses.checks;
  if (checks.some((c) => c.status === "fail")) bad.push(`${tab}: a check fails`);
  if (j.statuses.unexpectedPending.length) bad.push(`${tab}: pending ${j.statuses.unexpectedPending}`);
  const skipped = checks.filter((c) => c.status === "skip").map((c) => c.name);
  if (skipped.join() !== (skips[tab] ?? []).join()) bad.push(`${tab}: skipped [${skipped}]`);
  const pending = checks.filter((c) => c.status === "pending").map((c) => c.name);
  if (pending.join() !== (tab === "input" ? interaction : []).join()) bad.push(`${tab}: pending [${pending}]`);
}
const s = JSON.parse(fs.readFileSync(path.join(dir, `statuses-${mode}.json`), "utf8"));
if (s.format !== "hyperion-5b-statuses/1" || s.mode !== mode || Object.keys(s.tabs).length !== 10) bad.push(`statuses-${mode}.json`);
if (s.tabs.input?.summary !== "2/6 passed") bad.push(`Input: ${s.tabs.input?.summary}`);
if (bad.length) { console.error("BAD:\n  " + bad.join("\n  ")); process.exit(1); }
console.log("captures OK");
' /home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-baseline B
```

Expected: dieci righe e `captures OK`. Ciò che il controllo fissa, e perché:
- ogni tab catturato con il `setup()` avvolto (`wrapped`), camera ferma durante la finestra, snapshot distanti almeno 1 s;
- `bitExact` falso solo in Lighting, che anima tutto ciò che le sue luci raggiungono;
- entità mobili: Scene Graph 1 (il quad con la velocità), Lighting 2 (la luce puntiforme e lo spot), 2D Twins 4 (il genitore 2D, suo figlio e i loro gemelli 3D), 0 altrove. Le particelle non sono entità e disegnano sulla swapchain, non su `scene-hdr`. Un conteggio diverso va spiegato dal campo `movers` (id e posizioni) prima di andare avanti: un moto non previsto si capisce, non si tollera;
- punti scartati solo in 2D Twins: i 4 di 'Depth orders 2D sprites' (x ≈ 36-43), fuori schermo con la camera finale del tab. Li coprono i check nuovi del Task 20;
- stati come da `/gpu-check` sulla base: nessun `fail`; in skip solo 'MSDF text' (Primitives), 'Tonemap switch' (Rendering FX) e 'Determinism hash' (Debug Tools, il WASM di `build:wasm` non ha `dev-tools`); Input `2/6 passed` con i 4 check d'interazione in pending.

Se il controllo fallisce, non committare: la baseline deve essere verde e spiegata.

- [ ] **Step 11: Cattura Mode B, seconda corsa → `RUN2`, e prova che C è stabile**

Esegui lo Step 9 con `MODE = B`, `DIR = RUN2` (navigazione nuova), poi il controllo dello Step 10 con `<RUN2> B` al posto della cartella della baseline (Expected: `captures OK`). Poi:

```bash
BASE=/home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-baseline
node "$BASE/compare.mjs" --base "$BASE" --run "<RUN2>" --mode B --step 0 > "$BASE/stability-B.txt"; echo "exit $?"; cat "$BASE/stability-B.txt"
```
(con il percorso vero al posto di `<RUN2>`).

Expected: `exit 0`; per ogni tab una riga `OK`, Lighting `excluded (Lighting: statuses only)`, gli altri `C=… (grid N/2304)` con N ≥ 1152; poi `B statuses      OK` e `PASS`. È la verifica preliminare di spec §7.3.1: due caricamenti di pagina dello stesso commit coincidono al bit su C = S_base ∩ S_run \ (M_base ∪ M_run), quindi C elimina la varianza fra le corse prima di fare da cancello. Se fallisce, NON allentare `compare.mjs`: le righe `point … uv …` dicono dove e quanto; va trovata la causa (un'animazione che M non copre, un ordine di disegno non deterministico) e corretto `capture.js`, poi rifatte entrambe le corse di tutti e due i modi.

- [ ] **Step 12: Mode C, due corse e stabilità**

Ripeti gli Step 10 e 11 con `MODE = C` (`url: "http://localhost:5173/?mode=C&bench"`): prima corsa in `BASE`, controllo con argomento `C`, seconda corsa in `RUN2`, controllo, poi:

```bash
BASE=/home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-baseline
node "$BASE/compare.mjs" --base "$BASE" --run "<RUN2>" --mode C --step 0 > "$BASE/stability-C.txt"; echo "exit $?"; cat "$BASE/stability-C.txt"
```
Expected: `exit 0` e `PASS`, con le stesse righe dello Step 11. In Mode C, 'GPU rows of 2D entities' di 2D Twins passa solo con frame di scatter: se è `fail`, il controllo dello Step 10 lo segnala già.

- [ ] **Step 13: Console pulita**

`list_console_messages` con `pageId`, `types: ["error", "warn"]` sull'ultima pagina → nessun messaggio che nomini WebGPU, validation, pipeline o device; nessun `[Hyperion] <phase> hook … threw`; nessun warning del LeakDetector; l'unico errore ammesso è il 404 di `favicon.ico`.

- [ ] **Step 14: Commit della baseline**

Run: `git status --short docs/plans/assets/2026-09-27-transparent-sort-baseline/` → 20 file `B-*.json`/`C-*.json`, `statuses-B.json`, `statuses-C.json`, `stability-B.txt`, `stability-C.txt` non tracciati (nessun file di `RUN2`: resta nella scratchpad). `du -sh docs/plans/assets/2026-09-27-transparent-sort-baseline` → circa 1-2 MB.

```bash
git add docs/plans/assets/2026-09-27-transparent-sort-baseline/
git commit -m "$(cat <<'EOF'
test(5b): baseline del passo 0 in Mode B e C, con la prova di stabilità di C

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Task 4: analisi del testo WGSL per i test (`ts/src/shaders/wgsl-analysis.ts`)

Né vitest né il compositore compilano WGSL. I test della composizione (Task 5, poi Task 6) devono quindi leggere il **testo** dei moduli composti: quali nomi dichiara un modulo, quali binding raggiunge un entry point, quali locali potrebbero nascondere un nome di modulo. Questo task scrive lo strumento: uno scanner, non un parser. Conosce i commenti (in WGSL i commenti a blocco si annidano), la profondità delle graffe, le firme delle `fn` e gli attributi, ed è tutto ciò che serve ai controlli. Ogni funzione è totale: su un testo che non capisce restituisce un risultato vuoto (o `null`), mai un'eccezione. Solo i test lo importano.

I globi `./*.wgsl` di `uniform-layout.test.ts` e `storage-budget.test.ts` non vedono file `.ts`, quindi aggiungere qui un modulo TS non cambia quei test.

**Files:**
- Create: `ts/src/shaders/wgsl-analysis.ts`
- Test: `ts/src/shaders/wgsl-analysis.test.ts` (nuovo)

**Interfaces:**
- Consumes: niente.
- Produces (tutte esportate da `ts/src/shaders/wgsl-analysis.ts`):
  ```ts
  export type TopLevelKind = 'fn' | 'struct' | 'var' | 'const' | 'override' | 'alias';
  export interface TopLevelDecl { kind: TopLevelKind; name: string }
  export interface BindingDecl { group: number; binding: number; name: string }
  export interface LocalName { fn: string; name: string; kind: 'let' | 'var' | 'const' | 'param' }
  export function stripComments(src: string): string;            // stessa lunghezza, stesse righe
  export function topLevelDecls(src: string): TopLevelDecl[];     // in ordine di sorgente
  export function functionBody(src: string, name: string): string | null; // tra le graffe, commenti sbiancati
  export function functionParams(src: string, name: string): string[];
  export function callGraph(src: string): Map<string, Set<string>>; // fn → nomi di modulo citati (fn, globali, struct)
  export function reachableFrom(src: string, entry: string): Set<string>; // chiusura transitiva, entry esclusa
  export function bindingDecls(src: string): BindingDecl[];
  export function localNames(src: string): LocalName[];
  export function directives(src: string): string[];              // direttive in testa, spazi compattati
  ```

- [ ] **Step 1: Scrivere il test (fallisce: il modulo non esiste)**

Creare `ts/src/shaders/wgsl-analysis.test.ts` con questo contenuto. `MODULE` è un modulo primitivo ridotto nella forma di oggi (`basic.wgsl`): binding in tre gruppi, un `fs_main` illuminato, un `fs_occluder` che non deve raggiungere il gruppo 2. Il test non importa gli shader reali, perché il Task 6 li elimina.

```ts
import { describe, it, expect } from 'vitest';
import {
  stripComments, topLevelDecls, functionBody, functionParams, callGraph, reachableFrom,
  bindingDecls, localNames, directives,
} from './wgsl-analysis';

// A cut-down primitive module in today's shape (basic.wgsl): bindings in three
// groups, a lit fs_main, an fs_occluder that must not reach group 2.
const MODULE = `
// Instanced quad shader.
struct CameraUniform {
    viewProjection: mat4x4f,
    occluderLayers: u32, // 0 in ForwardPass
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(4) var<storage, read> renderMeta: array<u32>;
@group(1) @binding(0) var tier0Tex: texture_2d_array<f32>;
@group(1) @binding(4) var texSampler: sampler;
@binding(0) @group(2) var lightBuffer: texture_2d_array<f32>;
// @group(2) @binding(1) var commentedOut: sampler;

override OCCLUDER_PASS: bool = false;
const RECEIVES_LIGHT_BIT: u32 = 1u << 10u;
alias Color = vec4f;
const_assert RECEIVES_LIGHT_BIT == 1024u;

struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) entityIdx: u32,
};

@vertex
fn vs_main(
    @location(0) position: vec3f,
    @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
    var out: VertexOutput;
    let model = transforms[instanceIdx];
    out.clipPosition = camera.viewProjection * model * vec4f(position, 1.0);
    out.uv = position.xy + 0.5;
    return out;
}

fn shade(in: VertexOutput) -> vec4f {
    /* Nested /* block */ comment: fn hidden() {} */
    if (in.entityIdx == 0u) {
        return vec4f(1.0);
    }
    return textureSampleLevel(tier0Tex, texSampler, in.uv, 0, 0.0);
}

fn light(meta1: u32) -> vec3f {
    return textureSampleLevel(lightBuffer, texSampler, vec2f(0.5), 0, 0.0).rgb;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let color: Color = shade(in);
    let meta1 = renderMeta[in.entityIdx * 2u + 1u];
    if ((meta1 & RECEIVES_LIGHT_BIT) != 0u) {
        return vec4f(color.rgb * light(meta1), color.a);
    }
    return color;
}

@fragment
fn fs_occluder(in: VertexOutput) -> @location(0) vec4f {
    if (shade(in).a < 0.5) {
        discard;
    }
    return vec4f(in.uv, 1.0, 1.0);
}
`;

describe('stripComments', () => {
  it('blanks line and block comments, keeping the length and every newline', () => {
    const out = stripComments(MODULE);
    expect(out).toHaveLength(MODULE.length);
    expect(out.split('\n')).toHaveLength(MODULE.split('\n').length);
    expect(out).not.toMatch(/Instanced quad shader|0 in ForwardPass|commentedOut|hidden/);
    expect(out).toMatch(/fn shade\(in: VertexOutput\) -> vec4f \{/);
  });

  it('nests block comments, as WGSL does', () => {
    const out = stripComments('/* outer /* inner */ still a comment */ fn kept() {}');
    expect(out).not.toMatch(/still a comment/);
    expect(out.trim()).toBe('fn kept() {}');
  });

  it('ignores // inside a block comment and /* inside a line comment', () => {
    expect(stripComments('/* a // b\n c */ fn f() {}').trim()).toBe('fn f() {}');
    expect(stripComments('// no /* block here\nfn g() {}').trim()).toBe('fn g() {}');
  });

  it('runs an unterminated block comment to the end, without throwing', () => {
    expect(stripComments('fn f() {}\n/* never closed\nfn g() {}').trim()).toBe('fn f() {}');
  });
});

describe('topLevelDecls', () => {
  it('lists module-scope declarations in order, and nothing inside a body or a comment', () => {
    expect(topLevelDecls(MODULE)).toEqual([
      { kind: 'struct', name: 'CameraUniform' },
      { kind: 'var', name: 'camera' },
      { kind: 'var', name: 'transforms' },
      { kind: 'var', name: 'renderMeta' },
      { kind: 'var', name: 'tier0Tex' },
      { kind: 'var', name: 'texSampler' },
      { kind: 'var', name: 'lightBuffer' },
      { kind: 'override', name: 'OCCLUDER_PASS' },
      { kind: 'const', name: 'RECEIVES_LIGHT_BIT' },
      { kind: 'alias', name: 'Color' },
      { kind: 'struct', name: 'VertexOutput' },
      { kind: 'fn', name: 'vs_main' },
      { kind: 'fn', name: 'shade' },
      { kind: 'fn', name: 'light' },
      { kind: 'fn', name: 'fs_main' },
      { kind: 'fn', name: 'fs_occluder' },
    ]);
  });
});

describe('functionBody and functionParams', () => {
  it('returns the text between the braces, nested blocks included, comments blanked', () => {
    const body = functionBody(MODULE, 'fs_occluder')!;
    expect(body.trim().startsWith('if (shade(in).a < 0.5) {')).toBe(true);
    expect(body.trim().endsWith('return vec4f(in.uv, 1.0, 1.0);')).toBe(true);
    expect(functionBody(MODULE, 'shade')).not.toMatch(/Nested|hidden/);
  });

  it('finds the exact name, not a longer one that starts with it, nor one in a comment', () => {
    const src = '// fn shade(x) { wrong }\nfn shade_twice() -> f32 { return 2.0; }\nfn shade() -> f32 { return 1.0; }';
    expect(functionBody(src, 'shade')!.trim()).toBe('return 1.0;');
    expect(functionBody(src, 'shade_twice')!.trim()).toBe('return 2.0;');
  });

  it('answers null / [] for a function the module does not have', () => {
    expect(functionBody(MODULE, 'missing')).toBeNull();
    expect(functionParams(MODULE, 'missing')).toEqual([]);
    expect(functionBody(MODULE, 'not an identifier(')).toBeNull();
  });

  it('lists parameter names without their attributes, types or a trailing comma', () => {
    expect(functionParams(MODULE, 'vs_main')).toEqual(['position', 'instanceIdx']);
    expect(functionParams(MODULE, 'fs_main')).toEqual(['in']);
    expect(functionParams('fn f(a: array<f32, 4>, b: vec2<u32>) {}', 'f')).toEqual(['a', 'b']);
    expect(functionParams('fn g() {}', 'g')).toEqual([]);
  });
});

describe('callGraph and reachableFrom', () => {
  it('maps each function to the module-scope names it mentions, struct types included', () => {
    const graph = callGraph(MODULE);
    expect([...graph.get('vs_main')!].sort()).toEqual(['VertexOutput', 'camera', 'transforms']);
    expect([...graph.get('fs_main')!].sort()).toEqual(['Color', 'RECEIVES_LIGHT_BIT', 'VertexOutput', 'light', 'renderMeta', 'shade']);
    expect([...graph.get('fs_occluder')!].sort()).toEqual(['VertexOutput', 'shade']);
    expect(graph.has('camera')).toBe(false);
  });

  it('does not count member names, attribute arguments or number suffixes as references', () => {
    const src = `
const position = 1u;
const u = 2u;
struct S { lighting: u32 };
@group(0) @binding(0) var<uniform> lighting: S;
fn f(@builtin(position) p: vec4f, s: S) -> u32 { return s.lighting + 0xFFu + 1u; }`;
    expect([...callGraph(src).get('f')!]).toEqual(['S']);
  });

  it('follows calls transitively and collects the globals on the way', () => {
    const fromMain = reachableFrom(MODULE, 'fs_main');
    expect(fromMain.has('lightBuffer')).toBe(true);
    expect(fromMain.has('tier0Tex')).toBe(true);
    expect(fromMain.has('fs_main')).toBe(false);
    const fromOccluder = reachableFrom(MODULE, 'fs_occluder');
    expect(fromOccluder.has('shade')).toBe(true);
    expect(fromOccluder.has('texSampler')).toBe(true);
    expect(fromOccluder.has('lightBuffer')).toBe(false);
    expect(fromOccluder.has('renderMeta')).toBe(false);
    expect(reachableFrom(MODULE, 'missing').size).toBe(0);
  });
});

describe('bindingDecls', () => {
  it('reads group, binding and name in either attribute order, skipping comments and non-bindings', () => {
    expect(bindingDecls(MODULE)).toEqual([
      { group: 0, binding: 0, name: 'camera' },
      { group: 0, binding: 1, name: 'transforms' },
      { group: 0, binding: 4, name: 'renderMeta' },
      { group: 1, binding: 0, name: 'tier0Tex' },
      { group: 1, binding: 4, name: 'texSampler' },
      { group: 2, binding: 0, name: 'lightBuffer' },
    ]);
    expect(bindingDecls('var<private> counter: u32;\nfn f() { var x = 1u; }')).toEqual([]);
  });
});

describe('localNames', () => {
  it('lists parameters and every let, var, var<function>, const and for-loop var, per function', () => {
    const src = `
fn helper(a: u32, @builtin(position) p: vec4f) -> u32 {
    let b = a * 2u;
    var c: u32 = b;
    var<function> d = 0u;
    const e = 3u;
    for (var i = 0u; i < 4u; i++) { c += i; }
    return c + d + e;
}`;
    expect(localNames(src)).toEqual([
      { fn: 'helper', name: 'a', kind: 'param' },
      { fn: 'helper', name: 'p', kind: 'param' },
      { fn: 'helper', name: 'b', kind: 'let' },
      { fn: 'helper', name: 'c', kind: 'var' },
      { fn: 'helper', name: 'd', kind: 'var' },
      { fn: 'helper', name: 'e', kind: 'const' },
      { fn: 'helper', name: 'i', kind: 'var' },
    ]);
    expect(localNames(MODULE).filter((l) => l.fn === 'fs_main').map((l) => l.name)).toEqual(['in', 'color', 'meta1']);
  });
});

describe('directives', () => {
  it('reads the leading directives, past comments and blank lines, and stops at the first declaration', () => {
    const src = '// header\n\ndiagnostic(off,   derivative_uniformity);\n/* x */ enable f16;\nconst a = 1u;\nenable subgroups;';
    expect(directives(src)).toEqual(['diagnostic(off, derivative_uniformity);', 'enable f16;']);
    expect(directives(MODULE)).toEqual([]);
    expect(directives('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Eseguire il test e vederlo fallire**

Run: `npx --prefix ts vitest run --root ts src/shaders/wgsl-analysis.test.ts`
Expected: FAIL, `Failed Suites 1`, con `Error: Cannot find module './wgsl-analysis' imported from …/wgsl-analysis.test.ts`: il modulo non esiste ancora. L'hook `post-edit-ts.sh` riporta lo stesso fallimento come contesto (è il RED atteso).

- [ ] **Step 3: Implementare `wgsl-analysis.ts`**

Creare `ts/src/shaders/wgsl-analysis.ts`. Le scelte che contano:
- `stripComments` sostituisce ogni carattere di commento con uno spazio e lascia gli a capo: le posizioni e i numeri di riga non cambiano, e i test possono confrontare indici.
- `moduleScope` sbianca tutto ciò che sta fra graffe: quello che resta è il livello di modulo, così un `var`/`let` dentro una funzione non diventa mai una dichiarazione di primo livello.
- `callGraph` scandisce la firma (dopo il nome) e il corpo, e scarta i nomi dopo un `.` (membri), gli argomenti degli attributi e i suffissi numerici (`0xFFu`, `1e-3`). Solo le funzioni hanno una voce: in WGSL l'inizializzatore di una `const` o di un `override` non può citare una `var`, quindi i binding si raggiungono solo attraverso le funzioni.

```ts
/**
 * Text analysis of WGSL, for the headless tests (Phase 5b).
 *
 * Neither vitest nor the composer can compile WGSL, so the composed primitive
 * modules (render/primitive-shaders.ts) are checked on their text: which names
 * a module declares, which bindings an entry point can reach, which locals
 * could silently shadow a module-scope name. This is a scanner, not a parser.
 * It knows comments (block comments nest in WGSL), brace depth, `fn`
 * signatures and attributes, and that is all the checks need. Test-only:
 * nothing in the engine imports it.
 *
 * Every function is total: text it cannot make sense of yields an empty
 * result (or null), never an exception.
 */

export type TopLevelKind = 'fn' | 'struct' | 'var' | 'const' | 'override' | 'alias';

export interface TopLevelDecl {
  kind: TopLevelKind;
  name: string;
}

export interface BindingDecl {
  group: number;
  binding: number;
  name: string;
}

export interface LocalName {
  fn: string;
  name: string;
  kind: 'let' | 'var' | 'const' | 'param';
}

const IDENT = /^[A-Za-z_]\w*$/;

/** Every character of `text` but newlines turned into a space: offsets and line numbers survive. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * The source with every comment blanked: `//` to the end of the line, and
 * `/* ... *\/` with nesting (WGSL block comments nest). Newlines are kept and
 * every other comment character becomes a space, so the result has the same
 * length and the same line numbers as the input. An unterminated block comment
 * runs to the end of the text.
 */
export function stripComments(src: string): string {
  const parts: string[] = [];
  let plain = 0;
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      const newline = src.indexOf('\n', i);
      const end = newline < 0 ? src.length : newline;
      parts.push(src.slice(plain, i), blank(src.slice(i, end)));
      i = end;
      plain = end;
    } else if (src.startsWith('/*', i)) {
      const start = i;
      let depth = 0;
      while (i < src.length) {
        if (src.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (src.startsWith('*/', i)) {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else {
          i++;
        }
      }
      parts.push(src.slice(plain, start), blank(src.slice(start, i)));
      plain = i;
    } else {
      i++;
    }
  }
  parts.push(src.slice(plain));
  return parts.join('');
}

/**
 * Module scope only: every character inside braces blanked (the braces and
 * the newlines are kept). Function bodies and struct members disappear, so a
 * `var` or `let` that is left is a module-scope one. Expects comment-free text.
 */
function moduleScope(code: string): string {
  const out = code.split('');
  let depth = 0;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (depth > 0 && ch !== '\n') {
      out[i] = ' ';
    }
  }
  return out.join('');
}

/** The index of the bracket closing the one at `open`, or -1. */
function matching(code: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === opener) depth++;
    else if (code[i] === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split at the commas that are not inside `()` or `<>`. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(' || ch === '<') depth++;
    if (ch === ')' || ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Attributes (`@location(0)`, `@builtin(position)`, `@fragment`) blanked. */
function withoutAttributes(code: string): string {
  return code.replace(/@\w+\s*(?:\([^)]*\))?/g, (m) => blank(m));
}

interface FnSpan {
  paramsOpen: number;
  paramsClose: number;
  bodyOpen: number;
  bodyClose: number;
}

/** Where the module-scope `fn name` sits in comment-free `code`, or null. */
function findFn(code: string, name: string): FnSpan | null {
  if (!IDENT.test(name)) return null;
  const m = new RegExp(`\\bfn\\s+${name}\\s*\\(`).exec(moduleScope(code));
  if (!m) return null;
  const paramsOpen = m.index + m[0].length - 1;
  const paramsClose = matching(code, paramsOpen, '(', ')');
  if (paramsClose < 0) return null;
  // The return type cannot hold a brace: the next one opens the body.
  const bodyOpen = code.indexOf('{', paramsClose);
  if (bodyOpen < 0) return null;
  const bodyClose = matching(code, bodyOpen, '{', '}');
  if (bodyClose < 0) return null;
  return { paramsOpen, paramsClose, bodyOpen, bodyClose };
}

/**
 * The module-scope declarations, in source order: functions, structs,
 * module-scope `var`s (the bindings among them), `const`, `override` and
 * `alias`. `const_assert` is not a declaration and is skipped.
 */
export function topLevelDecls(src: string): TopLevelDecl[] {
  const scope = moduleScope(stripComments(src));
  const decl = /\b(fn|struct|var|const|override|alias)\b(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)/g;
  return [...scope.matchAll(decl)].map((m) => ({ kind: m[1] as TopLevelKind, name: m[2] }));
}

/**
 * The text between the braces of the module-scope `fn name`, comments blanked,
 * or null when the module has no such function.
 */
export function functionBody(src: string, name: string): string | null {
  const code = stripComments(src);
  const span = findFn(code, name);
  return span ? code.slice(span.bodyOpen + 1, span.bodyClose) : null;
}

/** The parameter names of the module-scope `fn name`, in order; [] when there is no such function. */
export function functionParams(src: string, name: string): string[] {
  const code = stripComments(src);
  const span = findFn(code, name);
  if (!span) return [];
  return splitTopLevel(code.slice(span.paramsOpen + 1, span.paramsClose))
    .map((param) => /^(?:@\w+\s*(?:\([^)]*\))?\s*)*([A-Za-z_]\w*)\s*:/.exec(param.trim())?.[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * Function → the module-scope names its signature and body mention: the
 * functions it calls, the bindings and other globals it reads, the structs it
 * names. Member names (after a `.`) and attribute arguments are not
 * references. A local that shadowed a module-scope name would count as a
 * reference to it: conservative, and `localNames` exists to rule it out.
 *
 * Only functions get an entry. A module-scope `const` or `override` can
 * reference other constants in its initializer but never a `var`, so bindings
 * are reached through functions only.
 */
export function callGraph(src: string): Map<string, Set<string>> {
  const code = stripComments(src);
  const decls = topLevelDecls(code);
  const names = new Set(decls.map((d) => d.name));
  const graph = new Map<string, Set<string>>();
  for (const d of decls) {
    if (d.kind !== 'fn') continue;
    const span = findFn(code, d.name);
    if (!span) continue;
    const text = withoutAttributes(code.slice(span.paramsOpen, span.bodyClose + 1));
    const refs = new Set<string>();
    for (const m of text.matchAll(/(?<![\w.])[A-Za-z_]\w*/g)) {
      if (names.has(m[0])) refs.add(m[0]);
    }
    graph.set(d.name, refs);
  }
  return graph;
}

/**
 * Every module-scope name reachable from `entry` through the call graph:
 * the functions it calls transitively and every global those functions (and
 * the entry) mention. The entry itself is not included.
 */
export function reachableFrom(src: string, entry: string): Set<string> {
  const graph = callGraph(src);
  const seen = new Set<string>();
  const stack = [...(graph.get(entry) ?? [])];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const next of graph.get(name) ?? []) stack.push(next);
  }
  return seen;
}

/**
 * The resource bindings: module-scope `var`s with both `@group(N)` and
 * `@binding(M)` (decimal literals, in either order), in source order.
 */
export function bindingDecls(src: string): BindingDecl[] {
  const scope = moduleScope(stripComments(src));
  const out: BindingDecl[] = [];
  const decl = /((?:@\w+\s*(?:\([^)]*\))?\s*)+)var\b(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)/g;
  for (const m of scope.matchAll(decl)) {
    const group = /@group\s*\(\s*(\d+)\s*\)/.exec(m[1]);
    const binding = /@binding\s*\(\s*(\d+)\s*\)/.exec(m[1]);
    if (group && binding) out.push({ group: Number(group[1]), binding: Number(binding[1]), name: m[2] });
  }
  return out;
}

/**
 * Every name a function declares for itself: its parameters, and each `let`,
 * `var` (also `var<function>` and a `for` loop's) and `const` in its body.
 */
export function localNames(src: string): LocalName[] {
  const code = stripComments(src);
  const out: LocalName[] = [];
  for (const d of topLevelDecls(code)) {
    if (d.kind !== 'fn') continue;
    for (const name of functionParams(code, d.name)) out.push({ fn: d.name, name, kind: 'param' });
    const body = functionBody(code, d.name) ?? '';
    for (const m of body.matchAll(/\b(let|var|const)\b(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)/g)) {
      out.push({ fn: d.name, name: m[2], kind: m[1] as 'let' | 'var' | 'const' });
    }
  }
  return out;
}

/**
 * The directives at the head of the module (`enable`, `requires`,
 * `diagnostic`), whitespace collapsed, e.g. `diagnostic(off, derivative_uniformity);`.
 * WGSL allows them only before the first declaration, so scanning stops at the
 * first statement that is not one.
 */
export function directives(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  const directive = /\s*((?:enable|requires|diagnostic)\b[^;]*;)/y;
  let m: RegExpExecArray | null;
  while ((m = directive.exec(code)) !== null) out.push(m[1].replace(/\s+/g, ' ').trim());
  return out;
}
```

- [ ] **Step 4: Eseguire il test e il type-check**

Run: `npx --prefix ts vitest run --root ts src/shaders/wgsl-analysis.test.ts`
Expected: PASS, `Tests 15 passed (15)`.

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Expected: nessuna riga (`noUnusedLocals`/`noUnusedParameters` compresi).

- [ ] **Step 5: Commit**

```bash
git add ts/src/shaders/wgsl-analysis.ts ts/src/shaders/wgsl-analysis.test.ts
git commit -m "test(5b): analisi del testo WGSL (commenti annidati, dichiarazioni, grafo delle chiamate) per i test del compositore" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: preludio, sei librerie, compositore (`ts/src/render/primitive-shaders.ts`)

Questo task scrive i sette pezzi in `ts/src/shaders/primitives/` e il compositore TS puro che ne ricava i sei moduli per tipo e il modulo uber (spec §3.1-3.2), con i test nuovi di §3.4. I sei shader di oggi (`ts/src/shaders/{basic,line,msdf-text,bezier,gradient,box-shadow}.wgsl`) **restano intatti**: li elimina il Task 6. Nessun codice di produzione importa ancora i pezzi o il compositore, quindi il task non cambia il comportamento del motore e si verifica da solo.

I pezzi sono ricavati dai sei file di oggi riga per riga. Cosa diventa cosa:

| Oggi | Nei pezzi |
|---|---|
| `CameraUniform` (cinque file con i pad, `line.wgsl` con `viewportWidth`/`viewportHeight`) | una sola, nella forma di `line.wgsl`, nel preludio (stessi 80 B) |
| binding dei gruppi 0, 1, 2; `OCCLUDER_PASS`, `CASTS_SHADOW_BIT`, `castsInto`; `RECEIVES_LIGHT_BIT`, `LightingUniform`, `lightGroupOf` | preludio, alla lettera |
| `VertexOutput` (due varianti) | preludio, superinsieme: 0-5 come oggi, 6 `edgeScale` (prospettico), 7 `transparent` (flat), 8 `primType` (flat) |
| early-out dell'occluder in ogni `vs_main` | `vs_main` generato dal compositore, che restituisce `culledVertex()` |
| decodifica della texture + `screenUV` + campi flat | `finishVertex`; il quad unitario è `unitQuadVertex` |
| switch dei tier (quattro copie) | `sampleTier` (crudo) e `sampleTierOrWhite` (bianco per l'indice 0) |
| blocco illuminato di `fs_main` (basic = gradient) | `applyLighting`, chiamata solo da `quad_fs` e `gradient_fs` |
| `fs_occluder` comune (`shade(in).a < 0.5` → `discard`) | `occluderSeed(in, <p>_shade(in).a)` |
| `shade` (sei corpi) | `quad_shade`, `line_shade`, `msdf_shade`, `bezier_shade`, `gradient_shade`, `boxshadow_shade` |
| `insideStroke`, `STROKE_TIE_EPS` | `line_insideStroke`, `LINE_STROKE_TIE_EPS` |
| `median3` | `msdf_median3` |
| `dot2`, `sdBezier` | `bezier_dot2`, `bezier_sd` |
| `erf_approx`, `shadowIntegral`, `boxShadow2D` | `boxshadow_erf`, `boxshadow_integral`, `boxshadow_box2d` |
| `fs_main` / `fs_occluder` di `line.wgsl` | `line_fs` / `line_occluder`, identici (non il modello comune) |

Comportamento conservato alla lettera (spec §3.1): `msdf_shade` chiama `sampleTier` crudo, mai `sampleTierOrWhite`; `line_shade` prende `fwidth(in.uv.y)` prima di qualunque ramo; `line_vs` calcola `transparent` dal bit 8 e legge `OCCLUDER_PASS`; `edgeScale` resta interpolato con la prospettiva; il gruppo 2 si raggiunge solo da `fs_main`, e solo nei tipi `lit`; nessun frammento legge `camera`, `transforms` o `visibleIndices`. Le costanti in maiuscolo di una libreria portano il prefisso in maiuscolo (`LINE_STROKE_TIE_EPS`): il test del prefisso accetta `prefix` o `prefix.toUpperCase()`.

**Files:**
- Create: `ts/src/shaders/primitives/prelude.wgsl`
- Create: `ts/src/shaders/primitives/quad.wgsl`
- Create: `ts/src/shaders/primitives/line.wgsl`
- Create: `ts/src/shaders/primitives/msdf-text.wgsl`
- Create: `ts/src/shaders/primitives/bezier.wgsl`
- Create: `ts/src/shaders/primitives/gradient.wgsl`
- Create: `ts/src/shaders/primitives/box-shadow.wgsl`
- Create: `ts/src/render/primitive-shaders.ts`
- Test: `ts/src/render/primitive-shaders.test.ts` (nuovo)
- Nessun file esistente cambia. I globi `./*.wgsl` di `uniform-layout.test.ts` e `storage-budget.test.ts` non sono ricorsivi e non vedono `primitives/`: il Task 6 li estende ai moduli composti.

**Interfaces:**
- Consumes:
  - dal Task 4 (`ts/src/shaders/wgsl-analysis.ts`): `stripComments`, `topLevelDecls`, `functionBody`, `callGraph`, `reachableFrom`, `bindingDecls`, `localNames`, `directives`;
  - `ts/src/render/primitive-bindings.ts`: `primitiveGroup0LayoutEntries(): GPUBindGroupLayoutEntry[]`, `textureTierLayoutEntries(): GPUBindGroupLayoutEntry[]` (i layout che ForwardPass e OccluderSeedStage passano al device);
  - `ts/src/entity-handle.ts`: `RenderPrimitiveType` (`Quad` 0 … `BoxShadow` 5, `Light2D` 6);
  - il testo di `ts/src/shaders/cull.wgsl` (`const NUM_PRIM_TYPES: u32 = 7u;` e il clamp `min(metaVal & 0xFFu, NUM_PRIM_TYPES - 1u)`).
- Produces (`ts/src/render/primitive-shaders.ts`):
  ```ts
  export type PrimitiveLibraryName = 'quad' | 'line' | 'msdf-text' | 'bezier' | 'gradient' | 'box-shadow';
  export interface PrimitiveLibrary { readonly type: number; readonly name: PrimitiveLibraryName; readonly prefix: string; readonly lit: boolean }
  export const PRIMITIVE_LIBRARIES: readonly PrimitiveLibrary[]; // tipi 0..5 in ordine; lit: quad, gradient
  export interface PrimitivePieces { prelude: string; libraries: Record<number, string> }
  export const UBER_DIRECTIVE = 'diagnostic(off, derivative_uniformity);';
  export function pieceMarker(name: string): string;            // `// --- piece: ${name} ---`
  export function composeTypeModule(pieces: PrimitivePieces, type: number): string; // '' per un tipo senza libreria
  export function composeTypeModules(pieces: PrimitivePieces): Record<number, string>;
  export function composeUberModule(pieces: PrimitivePieces): string;
  ```
- Produces (nomi WGSL, per i Task 6, 7, 19 e 22):
  - preludio: `CameraUniform`, `camera`, `transforms`, `visibleIndices`, `texLayerIndices`, `renderMeta`, `primParams`, `tier0Tex`…`tier3Tex`, `texSampler`, `ovf0Tex`…`ovf3Tex`, `OCCLUDER_PASS`, `CASTS_SHADOW_BIT`, `castsInto`, `RECEIVES_LIGHT_BIT`, `LightingUniform`, `lightBuffer`, `lightSampler`, `lighting`, `lightGroupOf`, `VertexOutput`, `culledVertex()`, `finishVertex(clip, uv, entityIdx)`, `unitQuadVertex(position, entityIdx, uv)`, `sampleTier(in)`, `sampleTierOrWhite(in)`, `occluderSeed(in, alpha)`, `applyLighting(in, color)`;
  - ogni libreria: `<p>_vs(position: vec3f, entityIdx: u32) -> VertexOutput`, `<p>_fs(in: VertexOutput) -> vec4f`, `<p>_occluder(in: VertexOutput) -> vec4f`, `<p>_shade(in: VertexOutput) -> vec4f`;
  - moduli per tipo: `vs_main`, `fs_main`, `fs_occluder`; uber: `vs_main`, `fs_main`, con marcatori `// --- piece: prelude ---`, `// --- piece: <nome> ---`, `// --- piece: generated ---`.

- [ ] **Step 1: Scrivere i test del compositore (falliscono: il modulo non esiste)**

Creare `ts/src/render/primitive-shaders.test.ts`. Implementa i test nuovi di §3.4: preludio alla lettera in ogni modulo; direttiva solo nell'uber e in prima riga; nomi unici e prefissati; nessun locale o parametro che nasconde un nome di modulo; contratto delle librerie; un solo `default` per switch; raggiungibilità del gruppo 2 ⇔ `lit`, per tipo e per caso dell'uber, mai da `fs_occluder` né da `vs_main`; binding contro i layout (occluder = gruppi 0-1, ForwardPass = gruppi 0-2) con la visibilità per stage di `primitive-bindings.ts`; `fwidth` di `line_shade` prima di ogni ramo; `msdf_shade` su `sampleTier`; `<p>_fs` e `<p>_occluder` che raggiungono `<p>_shade`. Due controlli usano pezzi rotti apposta per provare che non sono vacui.

Il layout del gruppo 2 di ForwardPass non è esportato (sta nel `setup()` di `forward-pass.ts`): il test lo riscrive come tre voci FRAGMENT, e il test esistente di `forward-pass.test.ts` ('group 2 is texture, filtering sampler, uniform') fissa lo stesso valore dal lato del pass.

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PRIMITIVE_LIBRARIES, UBER_DIRECTIVE, pieceMarker, composeTypeModule, composeTypeModules, composeUberModule,
  type PrimitivePieces,
} from './primitive-shaders';
import { primitiveGroup0LayoutEntries, textureTierLayoutEntries } from './primitive-bindings';
import { RenderPrimitiveType } from '../entity-handle';
import {
  stripComments, topLevelDecls, functionBody, callGraph, reachableFrom, bindingDecls, localNames, directives,
} from '../shaders/wgsl-analysis';

// Nothing here compiles WGSL (vitest cannot): these checks read the text the
// composer produces, and the call graph built from it. The GPU validation of
// the same modules is step 1's gate (design §7.3.2).

const g = globalThis as Record<string, unknown>;
g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

const files = import.meta.glob('../shaders/primitives/*.wgsl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const piece = (name: string): string => files[`../shaders/primitives/${name}.wgsl`] ?? '';
const libraries: Record<number, string> = {};
for (const l of PRIMITIVE_LIBRARIES) libraries[l.type] = piece(l.name);
const pieces: PrimitivePieces = { prelude: piece('prelude'), libraries };

const typeModules = composeTypeModules(pieces);
const uber = composeUberModule(pieces);
const allModules: Array<[string, string]> = [
  ...PRIMITIVE_LIBRARIES.map((l): [string, string] => [`type ${l.type} (${l.name})`, typeModules[l.type]]),
  ['uber', uber],
];

const preludeNames = new Set(topLevelDecls(pieces.prelude).map((d) => d.name));
const ENTRY_POINTS = new Set(['vs_main', 'fs_main', 'fs_occluder']);
/** Library names carry the prefix; SCREAMING_CASE constants carry it upper-cased (LINE_STROKE_TIE_EPS). */
const hasPrefix = (name: string, prefix: string): boolean => name.startsWith(prefix) || name.startsWith(prefix.toUpperCase());
/** The group-2 names: every @group(2) binding the prelude declares, and the helper that reads the table. */
const GROUP2_NAMES = [...bindingDecls(pieces.prelude).filter((b) => b.group === 2).map((b) => b.name), 'lightGroupOf'];
const BRANCH = /\b(?:if|switch|for|while|loop|discard)\b/;
const indexOrInfinity = (i: number): number => (i < 0 ? Infinity : i);

describe('primitive pieces', () => {
  it('finds the prelude and the six libraries, and nothing else', () => {
    const names = Object.keys(files).map((f) => f.replace('../shaders/primitives/', '').replace('.wgsl', '')).sort();
    expect(names).toEqual(['prelude', ...PRIMITIVE_LIBRARIES.map((l) => l.name)].sort());
    for (const name of names) expect(piece(name).trim().length, name).toBeGreaterThan(0);
  });

  it('PRIMITIVE_LIBRARIES: types 0-5 in RenderPrimitiveType order, quad and gradient lit', () => {
    expect(PRIMITIVE_LIBRARIES.map((l) => l.type)).toEqual([
      RenderPrimitiveType.Quad, RenderPrimitiveType.Line, RenderPrimitiveType.SDFGlyph,
      RenderPrimitiveType.BezierPath, RenderPrimitiveType.Gradient, RenderPrimitiveType.BoxShadow,
    ]);
    expect(PRIMITIVE_LIBRARIES.map((l) => l.prefix)).toEqual(['quad_', 'line_', 'msdf_', 'bezier_', 'gradient_', 'boxshadow_']);
    expect(PRIMITIVE_LIBRARIES.filter((l) => l.lit).map((l) => l.name)).toEqual(['quad', 'gradient']);
  });
});

describe('composer', () => {
  it('marks every piece, so a compiler error line can be traced to it', () => {
    expect(pieceMarker('line')).toBe('// --- piece: line ---');
    expect(uber).toContain(`${pieceMarker('prelude')}\n${pieces.prelude}`);
    for (const l of PRIMITIVE_LIBRARIES) {
      expect(uber).toContain(`${pieceMarker(l.name)}\n${pieces.libraries[l.type]}`);
      expect(typeModules[l.type]).toContain(`${pieceMarker(l.name)}\n${pieces.libraries[l.type]}`);
    }
  });

  it.each(allModules)('%s contains the prelude verbatim', (_label, module) => {
    expect(module.includes(pieces.prelude)).toBe(true);
  });

  it('composes one module per library type, each with its own library only', () => {
    expect(Object.keys(typeModules).map(Number)).toEqual(PRIMITIVE_LIBRARIES.map((l) => l.type));
    for (const l of PRIMITIVE_LIBRARIES) {
      expect(typeModules[l.type]).toBe(composeTypeModule(pieces, l.type));
      const foreign = topLevelDecls(typeModules[l.type])
        .map((d) => d.name)
        .filter((n) => !preludeNames.has(n) && !ENTRY_POINTS.has(n) && !hasPrefix(n, l.prefix));
      expect(foreign).toEqual([]);
    }
  });

  it('is total: empty or missing pieces and unknown types compose without throwing', () => {
    const empty: PrimitivePieces = { prelude: '', libraries: {} };
    expect(() => composeTypeModules(empty)).not.toThrow();
    expect(() => composeUberModule(empty)).not.toThrow();
    expect(composeUberModule(empty).split('\n')[0]).toBe(UBER_DIRECTIVE);
    expect(composeTypeModule(pieces, RenderPrimitiveType.Light2D)).toBe('');
    expect(composeTypeModule(pieces, -1)).toBe('');
  });
});

describe('the derivative_uniformity directive', () => {
  it('is the first line of the uber module, and its only directive', () => {
    expect(uber.split('\n')[0]).toBe(UBER_DIRECTIVE);
    expect(directives(uber)).toEqual([UBER_DIRECTIVE]);
  });

  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l.type] as const))('is absent from the %s module: its library compiles under the strict analysis', (_name, type) => {
    expect(directives(typeModules[type])).toEqual([]);
    expect(stripComments(typeModules[type])).not.toMatch(/\bdiagnostic\s*\(/);
  });
});

describe('generated entry points of the per-type modules', () => {
  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l] as const))('%s: occluder early-out, primType, fs_main and fs_occluder', (_name, l) => {
    const module = typeModules[l.type];
    const decls = topLevelDecls(module).map((d) => d.name);
    for (const entry of ENTRY_POINTS) expect(decls.filter((n) => n === entry), entry).toHaveLength(1);
    const vs = functionBody(module, 'vs_main')!;
    expect(vs).toContain('if (OCCLUDER_PASS && !castsInto(renderMeta[entityIdx * 2u + 1u], camera.occluderLayers)) { return culledVertex(); }');
    expect(vs).toContain(`var out = ${l.prefix}vs(position, entityIdx);`);
    expect(vs).toContain(`out.primType = ${l.type}u;`);
    // OccluderSeedStage selects its modules with code.includes('fn fs_occluder').
    expect(module).toMatch(/@fragment\s+fn fs_occluder\s*\(/);
    expect(module).toMatch(/@fragment\s+fn fs_main\s*\(/);
    expect(module).toMatch(/@vertex\s+fn vs_main\s*\(/);
    expect(functionBody(module, 'fs_main')!.trim()).toBe(`return ${l.prefix}fs(in);`);
    expect(functionBody(module, 'fs_occluder')!.trim()).toBe(`return ${l.prefix}occluder(in);`);
  });
});

describe('uber module', () => {
  it('has unique top-level names, every library name carrying its prefix', () => {
    const names = topLevelDecls(uber).map((d) => d.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    const unowned = names.filter((n) => !preludeNames.has(n) && n !== 'vs_main' && n !== 'fs_main'
      && !PRIMITIVE_LIBRARIES.some((l) => hasPrefix(n, l.prefix)));
    expect(unowned).toEqual([]);
    for (const l of PRIMITIVE_LIBRARIES) {
      for (const d of topLevelDecls(pieces.libraries[l.type])) expect(names).toContain(d.name);
    }
  });

  it('has no fs_occluder: it never seeds occluders', () => {
    expect(uber.includes('fn fs_occluder')).toBe(false);
  });

  it('clamps the type like cull.wgsl, and culls type 6 (Light2D) in the vertex stage', () => {
    const cull = readFileSync(new URL('../shaders/cull.wgsl', import.meta.url), 'utf8');
    const numPrimTypes = Number(/const NUM_PRIM_TYPES\s*:\s*u32\s*=\s*(\d+)u;/.exec(cull)?.[1]);
    expect(cull).toMatch(/min\(metaVal & 0xFFu, NUM_PRIM_TYPES - 1u\)/);
    const vs = functionBody(uber, 'vs_main')!;
    const clamp = /min\(renderMeta\[entityIdx \* 2u \+ 1u\] & 0xFFu, (\d+)u\)/.exec(vs);
    expect(Number(clamp?.[1])).toBe(numPrimTypes - 1);
    expect(Number(clamp?.[1])).toBe(RenderPrimitiveType.Light2D);
    for (const l of PRIMITIVE_LIBRARIES) {
      expect(vs).toContain(`case ${l.type}u: { out = ${l.prefix}vs(position, entityIdx); }`);
    }
    expect(vs).toContain('out.primType = primType;');
    expect(vs).not.toMatch(/OCCLUDER_PASS/);
  });

  it('has exactly one default in each switch: culledVertex in vs_main, a returned colour in fs_main', () => {
    const vs = functionBody(uber, 'vs_main')!;
    const fs = functionBody(uber, 'fs_main')!;
    expect(vs.match(/\bdefault\b/g)).toHaveLength(1);
    expect(fs.match(/\bdefault\b/g)).toHaveLength(1);
    expect(/default\s*:?\s*\{([^{}]*)\}/.exec(vs)?.[1].trim()).toBe('return culledVertex();');
    // Not a bare `discard;`: its behaviour is {Next}, and fs_main would not compile.
    expect(/default\s*:?\s*\{([^{}]*)\}/.exec(fs)?.[1].trim()).toMatch(/^return \w+_fs\(in\);$/);
    expect(fs).toMatch(/switch in\.primType \{/);
    for (const l of PRIMITIVE_LIBRARIES) {
      expect(fs).toMatch(new RegExp(`case ${l.type}u(?:, default)?: \\{ return ${l.prefix}fs\\(in\\); \\}`));
    }
  });

  it('fs_main calls the libraries\' fs and nothing else: no lighting after the switch', () => {
    const refs = [...callGraph(uber).get('fs_main')!].sort();
    expect(refs).toEqual(['VertexOutput', ...PRIMITIVE_LIBRARIES.map((l) => `${l.prefix}fs`)].sort());
  });
});

describe('library contract', () => {
  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l] as const))('%s: prefixed names, the four functions, no binding, entry point, directive or lighting', (_name, l) => {
    const lib = pieces.libraries[l.type];
    const p = l.prefix;
    const decls = topLevelDecls(lib);
    expect(decls.length).toBeGreaterThanOrEqual(4);
    expect(decls.map((d) => d.name).filter((n) => !hasPrefix(n, p))).toEqual([]);

    const code = stripComments(lib);
    expect(code).toMatch(new RegExp(`\\bfn ${p}vs\\(position: vec3f, entityIdx: u32\\) -> VertexOutput \\{`));
    expect(code).toMatch(new RegExp(`\\bfn ${p}fs\\(in: VertexOutput\\) -> vec4f \\{`));
    expect(code).toMatch(new RegExp(`\\bfn ${p}occluder\\(in: VertexOutput\\) -> vec4f \\{`));
    expect(code).toMatch(new RegExp(`\\bfn ${p}shade\\(in: VertexOutput\\) -> vec4f \\{`));

    expect(bindingDecls(lib)).toEqual([]);
    expect(code).not.toMatch(/@(?:group|binding)\s*\(/);
    expect(code).not.toMatch(/@(?:vertex|fragment|compute)\b/);
    expect(directives(lib)).toEqual([]);
    expect(code).not.toMatch(/^\s*(?:enable|requires|diagnostic)\b/m);
    expect(code).not.toMatch(new RegExp(`\\b(?:${GROUP2_NAMES.join('|')})\\b`));
  });

  it.each([['prelude', pieces.prelude], ...PRIMITIVE_LIBRARIES.map((l) => [l.name, pieces.libraries[l.type]])])(
    '%s never contains "fn fs_occluder", not even in a comment', (_name, src) => {
      // OccluderSeedStage takes any module containing that text for a caster.
      expect(src.includes('fn fs_occluder')).toBe(false);
    },
  );

  it('the prelude declares no entry point and no directive', () => {
    expect(stripComments(pieces.prelude)).not.toMatch(/@(?:vertex|fragment|compute)\b/);
    expect(directives(pieces.prelude)).toEqual([]);
  });

  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l] as const))('%s: only <prefix>fs may call applyLighting, and only if lit', (_name, l) => {
    const graph = callGraph(typeModules[l.type]);
    for (const d of topLevelDecls(pieces.libraries[l.type]).filter((x) => x.kind === 'fn')) {
      const calls = graph.get(d.name)!.has('applyLighting');
      expect(calls, d.name).toBe(d.name === `${l.prefix}fs` && l.lit);
    }
  });
});

describe('no local or parameter shadows a module-scope name', () => {
  it.each(allModules)('%s', (_label, module) => {
    const globals = new Set(topLevelDecls(module).map((d) => d.name));
    const clashes = localNames(module).filter((l) => globals.has(l.name)).map((l) => `${l.fn}: ${l.kind} ${l.name}`);
    expect(clashes).toEqual([]);
  });

  it('catches one (the check is not vacuous)', () => {
    const bad = { ...pieces, libraries: { ...pieces.libraries, 0: `${pieces.libraries[0]}\nfn quad_extra(lighting: f32) -> f32 { let camera = lighting; return camera; }\n` } };
    const module = composeTypeModule(bad, 0);
    const globals = new Set(topLevelDecls(module).map((d) => d.name));
    expect(localNames(module).filter((l) => globals.has(l.name)).map((l) => l.name)).toEqual(['lighting', 'camera']);
  });
});

describe('group 2 (the light buffer) is reached from fs_main only, and only by lit types', () => {
  it('takes the group-2 names from the prelude declarations', () => {
    expect(bindingDecls(pieces.prelude).filter((b) => b.group === 2)).toHaveLength(3);
    expect(GROUP2_NAMES).toContain('lightGroupOf');
  });

  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l] as const))('%s module', (_name, l) => {
    const module = typeModules[l.type];
    const fromFs = reachableFrom(module, 'fs_main');
    if (l.lit) for (const name of GROUP2_NAMES) expect(fromFs.has(name), name).toBe(true);
    else for (const name of GROUP2_NAMES) expect(fromFs.has(name), name).toBe(false);
    for (const entry of ['fs_occluder', 'vs_main']) {
      const reached = reachableFrom(module, entry);
      expect(GROUP2_NAMES.filter((n) => reached.has(n)), entry).toEqual([]);
    }
  });

  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l] as const))('uber case %s', (_name, l) => {
    const reached = reachableFrom(uber, `${l.prefix}fs`);
    expect(GROUP2_NAMES.some((n) => reached.has(n))).toBe(l.lit);
  });

  it('uber vs_main', () => {
    const reached = reachableFrom(uber, 'vs_main');
    expect(GROUP2_NAMES.filter((n) => reached.has(n))).toEqual([]);
  });
});

// Every binding an entry point reaches must be in the layout of the pipeline
// that runs it, with that stage visible. WebGPU reports a miss only when the
// pipeline is created, which no headless test sees.
type Layout = Map<number, Map<number, number>>;
function layoutOf(groups: Array<Array<{ binding: number; visibility: number }>>): Layout {
  return new Map(groups.map((entries, group) => [group, new Map(entries.map((e) => [e.binding, e.visibility]))]));
}
// ForwardPass's group 2 (forward-pass.ts setup): three FRAGMENT-only entries.
// forward-pass.test.ts ('group 2 is texture, filtering sampler, uniform') pins
// the pass side; this pins the shader side against the same visibility.
const forwardGroup2 = [0, 1, 2].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT }));
const FORWARD_LAYOUT = layoutOf([primitiveGroup0LayoutEntries(), textureTierLayoutEntries(), forwardGroup2]);
const OCCLUDER_LAYOUT = layoutOf([primitiveGroup0LayoutEntries(), textureTierLayoutEntries()]);

function bindingViolations(module: string, entry: string, stage: number, layout: Layout): string[] {
  const reached = reachableFrom(module, entry);
  return bindingDecls(module).filter((b) => reached.has(b.name)).flatMap((b) => {
    const visibility = layout.get(b.group)?.get(b.binding);
    if (visibility === undefined) return [`${entry} reaches ${b.name} (group ${b.group}, binding ${b.binding}): not in the layout`];
    if ((visibility & stage) === 0) return [`${entry} reaches ${b.name}: not visible to its stage`];
    return [];
  });
}

describe('bindings against the pipeline layouts', () => {
  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l.type] as const))('%s module: ForwardPass (groups 0-2) and occluder (groups 0-1)', (_name, type) => {
    const module = typeModules[type];
    expect(bindingViolations(module, 'vs_main', GPUShaderStage.VERTEX, FORWARD_LAYOUT)).toEqual([]);
    expect(bindingViolations(module, 'fs_main', GPUShaderStage.FRAGMENT, FORWARD_LAYOUT)).toEqual([]);
    expect(bindingViolations(module, 'vs_main', GPUShaderStage.VERTEX, OCCLUDER_LAYOUT)).toEqual([]);
    expect(bindingViolations(module, 'fs_occluder', GPUShaderStage.FRAGMENT, OCCLUDER_LAYOUT)).toEqual([]);
    // Not vacuous: the vertex stage reads the camera and the transforms.
    expect(reachableFrom(module, 'vs_main').has('camera')).toBe(true);
  });

  it('uber module: ForwardPass (groups 0-2)', () => {
    expect(bindingViolations(uber, 'vs_main', GPUShaderStage.VERTEX, FORWARD_LAYOUT)).toEqual([]);
    expect(bindingViolations(uber, 'fs_main', GPUShaderStage.FRAGMENT, FORWARD_LAYOUT)).toEqual([]);
  });

  it('catches group 2 reached from fs_occluder, and the camera read in a fragment', () => {
    const lit = `${pieces.libraries[0]}\nfn quad_extra(in: VertexOutput) -> vec4f { return applyLighting(in, vec4f(camera.viewportWidth)); }\n`;
    const bad = { ...pieces, libraries: { ...pieces.libraries, 0: lit.replace('occluderSeed(in, quad_shade(in).a)', 'occluderSeed(in, quad_extra(in).a)') } };
    const module = composeTypeModule(bad, 0);
    const violations = bindingViolations(module, 'fs_occluder', GPUShaderStage.FRAGMENT, OCCLUDER_LAYOUT);
    expect(violations.some((v) => v.includes('lightBuffer'))).toBe(true);
    expect(violations.some((v) => v.includes('camera') && v.includes('stage'))).toBe(true);
  });
});

describe('fragment-only operations stay out of the vertex stage', () => {
  it.each(allModules)('%s', (_label, module) => {
    const fns = ['vs_main', ...reachableFrom(module, 'vs_main')].filter((n) => functionBody(module, n) !== null);
    const offenders = fns.filter((n) => /\bdiscard\b|\b(?:dpdx|dpdy|fwidth)(?:Coarse|Fine)?\s*\(|\btextureSample\s*\(/.test(functionBody(module, n)!));
    expect(offenders).toEqual([]);
  });
});

describe('coverage: a primitive casts exactly what it draws', () => {
  it.each(PRIMITIVE_LIBRARIES.map((l) => [l.name, l] as const))('%s: fs and occluder both reach <prefix>shade, first thing', (_name, l) => {
    const module = typeModules[l.type];
    for (const fn of [`${l.prefix}fs`, `${l.prefix}occluder`]) {
      expect(reachableFrom(module, fn).has(`${l.prefix}shade`), fn).toBe(true);
      // shade holds the derivatives: called before any branch, it runs in
      // uniform control flow in the per-type module.
      const body = functionBody(module, fn)!;
      const call = body.indexOf(`${l.prefix}shade(`);
      expect(call, fn).toBeGreaterThanOrEqual(0);
      expect(call, fn).toBeLessThan(indexOrInfinity(body.search(BRANCH)));
    }
  });
});

describe('behaviour kept from the six shaders', () => {
  it('line_shade takes fwidth(in.uv.y) before any branch', () => {
    const body = functionBody(typeModules[RenderPrimitiveType.Line], 'line_shade')!;
    const derivative = body.search(/fwidth\(\s*in\.uv\.y\s*\)/);
    expect(derivative).toBeGreaterThanOrEqual(0);
    expect(derivative).toBeLessThan(indexOrInfinity(body.search(BRANCH)));
  });

  it('msdf_shade samples the tier RAW: sampleTier, never sampleTierOrWhite', () => {
    const module = typeModules[RenderPrimitiveType.SDFGlyph];
    const calls = callGraph(module).get('msdf_shade')!;
    expect(calls.has('sampleTier')).toBe(true);
    expect(calls.has('sampleTierOrWhite')).toBe(false);
    expect(reachableFrom(module, 'fs_main').has('sampleTierOrWhite')).toBe(false);
  });

  it('quad, line and bezier answer packed index 0 white; gradient and box shadow never sample', () => {
    const answersWhite = (l: (typeof PRIMITIVE_LIBRARIES)[number]) => reachableFrom(typeModules[l.type], `${l.prefix}shade`).has('sampleTierOrWhite');
    const samples = (l: (typeof PRIMITIVE_LIBRARIES)[number]) => reachableFrom(typeModules[l.type], `${l.prefix}shade`).has('sampleTier');
    expect(PRIMITIVE_LIBRARIES.filter(answersWhite).map((l) => l.name)).toEqual(['quad', 'line', 'bezier']);
    expect(PRIMITIVE_LIBRARIES.filter(samples).map((l) => l.name)).toEqual(['quad', 'line', 'msdf-text', 'bezier']);
  });

  it('line_vs computes transparent from renderMeta bit 8 and keeps edgeScale perspective-interpolated', () => {
    const vs = functionBody(typeModules[RenderPrimitiveType.Line], 'line_vs')!;
    expect(vs).toContain('out.transparent = select(0u, 1u, (renderMeta[entityIdx * 2u + 1u] & 0x100u) != 0u);');
    expect(vs).toMatch(/OCCLUDER_PASS/);
    const output = /struct VertexOutput \{([\s\S]*?)\}/.exec(stripComments(pieces.prelude))![1];
    expect(output).toMatch(/@location\(6\) edgeScale: f32,/);
    expect(output).toMatch(/@location\(7\) @interpolate\(flat\) transparent: u32,/);
    expect(output).toMatch(/@location\(8\) @interpolate\(flat\) primType: u32,/);
  });
});
```

- [ ] **Step 2: Eseguire il test e vederlo fallire**

Run: `npx --prefix ts vitest run --root ts src/render/primitive-shaders.test.ts`
Expected: FAIL, `Failed Suites 1`, con `Error: Cannot find module './primitive-shaders' imported from …/primitive-shaders.test.ts`.

- [ ] **Step 3: Scrivere il compositore**

Creare `ts/src/render/primitive-shaders.ts`. È solo concatenazione: non lancia mai, qualunque cosa contengano i pezzi (un pezzo mancante vale `''`, un tipo senza libreria dà `''`). Ogni pezzo va sotto il suo marcatore e finisce con un a capo. Nei wrapper per tipo gli attributi di stage stanno su una riga a sé e l'early-out dell'occluder è il testo di oggi. Nell'uber la direttiva è la prima riga; lo switch del vertex fa il clamp a 6 come `cull.wgsl` e manda il `default` (Light2D) a `culledVertex()`; lo switch del fragment fonde il `default` con l'ultimo caso (`case 5u, default`), così ogni percorso restituisce un colore di libreria. Un `default: { discard; }` non compilerebbe: il suo comportamento è {Next}, e la funzione deve restituire un valore.

```ts
/**
 * Composition of the primitive shaders (Phase 5b, design §3).
 *
 * The WGSL of the six primitive types lives in pieces under
 * `shaders/primitives/`: a prelude (bindings, shared structs, helpers) and one
 * library per type, whose names all carry its prefix. This module turns the
 * pieces into
 * - one module per type: prelude + that library + generated entry points
 *   `vs_main`, `fs_main`, `fs_occluder` (ForwardPass's per-type pipelines, and
 *   OccluderSeedStage through `fs_occluder`);
 * - the uber module: the `derivative_uniformity` directive, the prelude, all six
 *   libraries, and a `vs_main`/`fs_main` that switch on the primitive type (one
 *   pipeline draws every transparent type in sorted order).
 *
 * Pure text and TOTAL: concatenation only, it never throws, whatever the
 * pieces hold, so a hot-reloaded piece can always be recomposed; a broken
 * piece is caught by the GPU validation of the probe. The pieces themselves
 * (the `?raw` imports, whose hot-reload must be accepted in the module that
 * imports them) are held by renderer.ts.
 */

export type PrimitiveLibraryName = 'quad' | 'line' | 'msdf-text' | 'bezier' | 'gradient' | 'box-shadow';

export interface PrimitiveLibrary {
  /** RenderPrimitiveType of the entities it draws. */
  readonly type: number;
  /** The piece: `shaders/primitives/<name>.wgsl`, and its hot-reload slot. */
  readonly name: PrimitiveLibraryName;
  /** Starts every module-scope name of the library (upper-cased for constants). */
  readonly prefix: string;
  /** Whether its `<prefix>fs` applies the light buffer (the source of LIT_PRIMITIVE_TYPES). */
  readonly lit: boolean;
}

/** The primitive libraries, types 0-5 in order. Type 6 (Light2D) has none: ForwardPass never draws it. */
export const PRIMITIVE_LIBRARIES: readonly PrimitiveLibrary[] = [
  { type: 0, name: 'quad', prefix: 'quad_', lit: true },
  { type: 1, name: 'line', prefix: 'line_', lit: false },
  { type: 2, name: 'msdf-text', prefix: 'msdf_', lit: false },
  { type: 3, name: 'bezier', prefix: 'bezier_', lit: false },
  { type: 4, name: 'gradient', prefix: 'gradient_', lit: true },
  { type: 5, name: 'box-shadow', prefix: 'boxshadow_', lit: false },
];

/** The current text of every piece: the prelude, and each library by primitive type. */
export interface PrimitivePieces {
  prelude: string;
  libraries: Record<number, string>;
}

/**
 * First line of the uber module, and of no other. `fwidth`/`dpdx` inside
 * line_shade, msdf_shade and bezier_shade are called from the type switch,
 * which WGSL's uniformity analysis cannot prove uniform. The switch IS uniform
 * across a 2x2 quad (the type is per instance and a quad's fragments belong to
 * one triangle). A diagnostic's severity is decided where the builtin is
 * called, so an attribute on fs_main or on the switch does not reach inside the
 * libraries (verified on Chrome 154); only this directive does. The per-type
 * modules compile the same library code under the strict analysis.
 */
export const UBER_DIRECTIVE = 'diagnostic(off, derivative_uniformity);';

/**
 * RenderPrimitiveType.Light2D, the first type without a library. The uber
 * vs_main clamps the type to it, as cull.wgsl clamps to NUM_PRIM_TYPES - 1,
 * and draws nothing for it.
 */
const LIGHT2D_TYPE = 6;

/** The line put before each piece of a composed module, so a compiler error's line can be traced to its piece. */
export function pieceMarker(name: string): string {
  return `// --- piece: ${name} ---`;
}

/** `text` under its marker, ending in a newline. */
function section(name: string, text: string): string {
  return `${pieceMarker(name)}\n${text}${text.endsWith('\n') ? '' : '\n'}`;
}

/** The generated entry points of a per-type module. */
function typeEntryPoints(library: PrimitiveLibrary): string {
  const p = library.prefix;
  return `@vertex
fn vs_main(@location(0) position: vec3f, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
    let entityIdx = visibleIndices[instanceIdx];
    if (OCCLUDER_PASS && !castsInto(renderMeta[entityIdx * 2u + 1u], camera.occluderLayers)) { return culledVertex(); }
    var out = ${p}vs(position, entityIdx);
    out.primType = ${library.type}u;
    return out;
}
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f { return ${p}fs(in); }
@fragment
fn fs_occluder(in: VertexOutput) -> @location(0) vec4f { return ${p}occluder(in); }
`;
}

/** The generated entry points of the uber module. No fs_occluder: the uber never seeds occluders. */
function uberEntryPoints(): string {
  const vsCases = PRIMITIVE_LIBRARIES
    .map((l) => `        case ${l.type}u: { out = ${l.prefix}vs(position, entityIdx); }`)
    .join('\n');
  // WGSL requires exactly one default, and every path must return a colour:
  // the last case takes it. Unreachable anyway: the vertex stage culls type 6.
  const last = PRIMITIVE_LIBRARIES.length - 1;
  const fsCases = PRIMITIVE_LIBRARIES
    .map((l, i) => `        case ${l.type}u${i === last ? ', default' : ''}: { return ${l.prefix}fs(in); }`)
    .join('\n');
  return `@vertex
fn vs_main(@location(0) position: vec3f, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
    let entityIdx = visibleIndices[instanceIdx];
    let primType = min(renderMeta[entityIdx * 2u + 1u] & 0xFFu, ${LIGHT2D_TYPE}u);
    var out: VertexOutput;
    switch primType {
${vsCases}
        default: { return culledVertex(); }
    }
    out.primType = primType;
    return out;
}
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    switch in.primType {
${fsCases}
    }
}
`;
}

/**
 * The module of one primitive type: prelude + its library + generated
 * `vs_main` (with the occluder early-out), `fs_main`, `fs_occluder`. An
 * unknown type (no library) yields ''. A missing library text is taken as ''.
 */
export function composeTypeModule(pieces: PrimitivePieces, type: number): string {
  const library = PRIMITIVE_LIBRARIES.find((l) => l.type === type);
  if (!library) return '';
  return section('prelude', pieces.prelude)
    + section(library.name, pieces.libraries[type] ?? '')
    + section('generated', typeEntryPoints(library));
}

/** The module of every primitive type, keyed by type: what `ForwardPass.SHADER_SOURCES` holds. */
export function composeTypeModules(pieces: PrimitivePieces): Record<number, string> {
  const modules: Record<number, string> = {};
  for (const library of PRIMITIVE_LIBRARIES) modules[library.type] = composeTypeModule(pieces, library.type);
  return modules;
}

/** The uber module: the directive on the first line, the prelude, the six libraries, the switching entry points. */
export function composeUberModule(pieces: PrimitivePieces): string {
  return `${UBER_DIRECTIVE}\n`
    + section('prelude', pieces.prelude)
    + PRIMITIVE_LIBRARIES.map((l) => section(l.name, pieces.libraries[l.type] ?? '')).join('')
    + section('generated', uberEntryPoints());
}
```

- [ ] **Step 4: Eseguire i test: il compositore c'è, i pezzi no**

Run: `npx --prefix ts vitest run --root ts src/render/primitive-shaders.test.ts`
Expected: FAIL senza eccezioni all'import (il compositore è totale): `Failed Tests 31`, in testa `primitive pieces > finds the prelude and the six libraries, and nothing else` (il glob di `shaders/primitives/*.wgsl` è vuoto). L'hook `post-edit-ts.sh` segnala lo stesso fallimento dopo la scrittura di `primitive-shaders.ts`: resta rosso fino allo Step 9.

- [ ] **Step 5: Scrivere il preludio**

Creare `ts/src/shaders/primitives/prelude.wgsl`. `CameraUniform` è quella di `line.wgsl`; i binding, `OCCLUDER_PASS`, `castsInto` e il blocco luci sono quelli di `basic.wgsl` alla lettera; `VertexOutput` è il superinsieme; gli helper sostituiscono il codice ripetuto nei sei file. Nessun commento deve contenere il testo `fn fs_occluder`.

```wgsl
// Prelude of every primitive module (Phase 5b). render/primitive-shaders.ts
// composes it with the libraries in this directory into the six per-type
// modules (one library each, plus generated vs_main/fs_main/fs_occluder) and
// the uber module (all six libraries, one switch on the primitive type). The
// bindings live HERE only: a library declares none, no entry point, no
// directive, and prefixes every name of its own. The names here are unprefixed.

struct CameraUniform {
    viewProjection: mat4x4f,
    // The layers the occluder set being seeded shadows (OccluderSeedStage).
    // 0 in ForwardPass, which never reads it. Scalars only: see
    // src/shaders/uniform-layout.test.ts.
    occluderLayers: u32,
    // The FULL canvas size in pixels (both writers), for pixel-wide lines.
    viewportWidth: f32,
    viewportHeight: f32,
    _pad2: u32,
};

// camera, transforms and visibleIndices are visible to the VERTEX stage only
// (primitive-bindings.ts): no fragment code may read them.
@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> texLayerIndices: array<u32>;
@group(0) @binding(4) var<storage, read> renderMeta: array<u32>;
@group(0) @binding(5) var<storage, read> primParams: array<f32>;

// Tier 0-3 texture arrays (64, 128, 256, 512 px). Group 1 is FRAGMENT only.
@group(1) @binding(0) var tier0Tex: texture_2d_array<f32>;
@group(1) @binding(1) var tier1Tex: texture_2d_array<f32>;
@group(1) @binding(2) var tier2Tex: texture_2d_array<f32>;
@group(1) @binding(3) var tier3Tex: texture_2d_array<f32>;
@group(1) @binding(4) var texSampler: sampler;
// Overflow tiers (rgba8unorm, for mixed-mode dev)
@group(1) @binding(5) var ovf0Tex: texture_2d_array<f32>;
@group(1) @binding(6) var ovf1Tex: texture_2d_array<f32>;
@group(1) @binding(7) var ovf2Tex: texture_2d_array<f32>;
@group(1) @binding(8) var ovf3Tex: texture_2d_array<f32>;

// Set to true only by the occluder pipelines (OccluderSeedStage), which run the
// per-type modules with the fs_occluder entry point. The ForwardPass pipelines
// keep the default, and the checks on it fold away. Declared here, not in the
// generated entry points: line_vs reads it too, also in the uber module.
override OCCLUDER_PASS: bool = false;
// renderMeta[slot*2+1] bit 9 (castsShadow). It must match
// RENDER_META_CASTS_SHADOW_BIT in components.rs; occluder-seed-stage.test.ts
// compares the two.
const CASTS_SHADOW_BIT: u32 = 1u << 9u;
// Whether an entity is in the occluder set being seeded: it casts, and its
// mask (renderMeta bits 16-31, 0 = every layer) meets the set's layers.
fn castsInto(meta1: u32, layers: u32) -> bool {
    let mask = select(meta1 >> 16u, 0xFFFFu, (meta1 >> 16u) == 0u);
    return (meta1 & CASTS_SHADOW_BIT) != 0u && (mask & layers) != 0u;
}
// renderMeta[slot*2+1] bit 10 (receivesLight), RENDER_META_RECEIVES_LIGHT_BIT
// in components.rs; forward-pass.test.ts compares the two.
const RECEIVES_LIGHT_BIT: u32 = 1u << 10u;

// Group 2: the light buffer (Phase 17), accumulated by LightGroupsPass at half
// resolution and cleared to the ambient light. Only fs_main may reach it
// (through applyLighting): OccluderSeedStage runs the per-type modules through
// fs_occluder on a layout of two groups, where a binding used by that entry
// point would fail validation. Declaring it in every module is valid; reaching
// it is what counts. Scalars only: see src/shaders/uniform-layout.test.ts.
struct LightingUniform {
    enabled: u32,
    // Light layers: receiver layer → light-buffer layer (its light group),
    // 4 bits per layer. Layers 0-7 here, 8-15 in the next word.
    groupTableLo: u32,
    groupTableHi: u32,
    _pad0: u32,
};

// One layer per light group (LightGroupsPass).
@group(2) @binding(0) var lightBuffer: texture_2d_array<f32>;
@group(2) @binding(1) var lightSampler: sampler;
@group(2) @binding(2) var<uniform> lighting: LightingUniform;

// A receiver belongs to ONE layer, the lowest bit of its mask (renderMeta bits
// 16-31; 0 = layer 0), and samples the light-buffer layer of that layer's group.
fn lightGroupOf(mask: u32) -> u32 {
    let layer = select(firstTrailingBit(mask), 0u, mask == 0u);
    let word = select(lighting.groupTableLo, lighting.groupTableHi, layer >= 8u);
    return (word >> (4u * (layer % 8u))) & 0xFu;
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) entityIdx: u32,
    @location(2) @interpolate(flat) texTier: u32,
    @location(3) @interpolate(flat) texLayer: u32,
    @location(4) @interpolate(flat) isOverflow: u32,
    // This fragment's position on screen in [0,1], y down: the seed that
    // fs_occluder writes, and where applyLighting reads the light buffer.
    @location(5) screenUV: vec2f,
    // Lines only (line_vs; 0 elsewhere). Maps the quad's uv.y onto the stroke:
    // the quad is wider than the stroke by an AA margin, and edge = 1 falls at
    // the stroke's true edge. Perspective-interpolated, NOT flat: line's
    // half-open edge test compares its interpolated bits.
    @location(6) edgeScale: f32,
    // Lines only: renderMeta bit 8, the entity draws in the alpha-blended pipeline.
    @location(7) @interpolate(flat) transparent: u32,
    // The primitive type, set by the generated vs_main: the uber fs_main
    // switches on it.
    @location(8) @interpolate(flat) primType: u32,
};

// A vertex that rasterises nothing: every vertex of the triangle lands on the
// same point. Every other field is zero.
fn culledVertex() -> VertexOutput {
    var out: VertexOutput;
    out.clipPosition = vec4f(0.0, 0.0, 0.0, 1.0);
    return out;
}

// The common tail of a vertex function: the clip position and uv it computed,
// plus the packed texture decode, the screen position and the flat fields.
fn finishVertex(clip: vec4f, uv: vec2f, entityIdx: u32) -> VertexOutput {
    var out: VertexOutput;

    // Decode texture tier and layer from packed u32
    let packed = texLayerIndices[entityIdx];
    let isOverflow = (packed >> 31u) & 1u;
    let tier = (packed >> 16u) & 0x7u;
    let layer = packed & 0xFFFFu;

    out.clipPosition = clip;
    let ndc = out.clipPosition.xy / out.clipPosition.w;
    out.screenUV = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    out.uv = uv;
    out.entityIdx = entityIdx;
    out.texTier = tier;
    out.texLayer = layer;
    out.isOverflow = isOverflow;

    return out;
}

// A vertex of the entity's unit quad, through its model matrix.
fn unitQuadVertex(position: vec3f, entityIdx: u32, uv: vec2f) -> VertexOutput {
    let model = transforms[entityIdx];
    return finishVertex(camera.viewProjection * model * vec4f(position, 1.0), uv, entityIdx);
}

// The texel at in.uv from the entity's tier (with overflow support), RAW: a
// packed index 0 samples tier 0 layer 0 like any other. textureSampleLevel
// with explicit LOD 0 avoids the uniform-control-flow requirement of
// textureSample (texTier/isOverflow vary per-instance).
fn sampleTier(in: VertexOutput) -> vec4f {
    var texColor: vec4f;
    if (in.isOverflow == 0u) {
        switch in.texTier {
            case 1u: { texColor = textureSampleLevel(tier1Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 2u: { texColor = textureSampleLevel(tier2Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 3u: { texColor = textureSampleLevel(tier3Tex, texSampler, in.uv, in.texLayer, 0.0); }
            default: { texColor = textureSampleLevel(tier0Tex, texSampler, in.uv, in.texLayer, 0.0); }
        }
    } else {
        switch in.texTier {
            case 1u: { texColor = textureSampleLevel(ovf1Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 2u: { texColor = textureSampleLevel(ovf2Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 3u: { texColor = textureSampleLevel(ovf3Tex, texSampler, in.uv, in.texLayer, 0.0); }
            default: { texColor = textureSampleLevel(ovf0Tex, texSampler, in.uv, in.texLayer, 0.0); }
        }
    }
    return texColor;
}

// The entity's colour: white for packed index 0 (tier 0, layer 0, not
// overflow), which means "untextured": layer 0 is reserved and never holds a
// real texture. Answered here instead of sampling: on a compressed tier
// (BC7/ASTC) layer 0 is never filled (writeTexture cannot take raw pixels
// there), and an all-zero BC7 block decodes to transparent black. The varyings
// are flat, so the branch is uniform across the quad. msdf_shade must NOT use
// this: a glyph's coverage is its texel, and white would draw a solid box.
fn sampleTierOrWhite(in: VertexOutput) -> vec4f {
    if (in.isOverflow == 0u && in.texTier == 0u && in.texLayer == 0u) {
        return vec4f(1.0);
    }
    return sampleTier(in);
}

// The occluder seed of a fragment at least half covered: (u, v, valid,
// inside), the layout the SDF chain floods (design §9.4). Nothing below.
fn occluderSeed(in: VertexOutput, alpha: f32) -> vec4f {
    if (alpha < 0.5) {
        discard;
    }
    return vec4f(in.screenUV, 1.0, 1.0);
}

// The light buffer applied to a receiver's colour. Only the lit libraries'
// <prefix>_fs call it (quad_fs, gradient_fs: LIT_PRIMITIVE_TYPES), never a
// shade or occluder function, and never the uber after its switch: every other
// type would then be lit, which deriveLightGroups does not model.
fn applyLighting(in: VertexOutput, color: vec4f) -> vec4f {
    let meta1 = renderMeta[in.entityIdx * 2u + 1u];
    // entityIdx is flat, so the branch is uniform across the quad. Unlit
    // entities skip the lookup, and keep their full colour.
    if (lighting.enabled == 1u && (meta1 & RECEIVES_LIGHT_BIT) != 0u) {
        // A subtractive light can push the buffer below zero: clamp before tinting.
        let light = max(textureSampleLevel(lightBuffer, lightSampler, in.screenUV, lightGroupOf(meta1 >> 16u), 0.0).rgb, vec3f(0.0));
        return vec4f(color.rgb * light, color.a);
    }
    return color;
}
```

- [ ] **Step 6: Scrivere le tre librerie a quad unitario senza derivate: quad, gradient, box-shadow**

`ts/src/shaders/primitives/quad.wgsl` (da `basic.wgsl`: `shade` → `sampleTierOrWhite`, `fs_main` → `applyLighting`):

```wgsl
// Quad (type 0, prefix quad_): an instanced sprite, sampled from the texture
// tiers, white when untextured. Lit: quad_fs applies the light buffer.
// A library of the primitive modules: see prelude.wgsl.

fn quad_vs(position: vec3f, entityIdx: u32) -> VertexOutput {
    return unitQuadVertex(position, entityIdx, position.xy + 0.5);
}

// The quad's colour and coverage. Shared by both entry points: a sprite casts
// the shadow of exactly the texels it draws.
fn quad_shade(in: VertexOutput) -> vec4f {
    return sampleTierOrWhite(in);
}

fn quad_fs(in: VertexOutput) -> vec4f {
    return applyLighting(in, quad_shade(in));
}

// A seed wherever the quad is at least half covered.
fn quad_occluder(in: VertexOutput) -> vec4f {
    return occluderSeed(in, quad_shade(in).a);
}
```

`ts/src/shaders/primitives/gradient.wgsl` (da `gradient.wgsl`: `shade` alla lettera, compresa la lettura di `texLayerIndices` nel fragment, visibile a VERTEX|FRAGMENT):

```wgsl
// Gradient (type 4, prefix gradient_): linear, radial, and conic gradients via primParams.
// PrimParams layout for Gradient:
//   [0]=type (0=linear, 1=radial, 2=conic)
//   [1]=angle (degrees)
//   [2]=stop0_pos, [3]=stop0_r, [4]=stop0_g, [5]=stop0_b
//   [6]=stop1_pos, [7]=stop1_r
// stop1 G,B are packed into texLayerIndices (low bytes)
// A library of the primitive modules: see prelude.wgsl. Lit: gradient_fs
// applies the light buffer.

fn gradient_vs(position: vec3f, entityIdx: u32) -> VertexOutput {
    return unitQuadVertex(position, entityIdx, position.xy + 0.5);
}

// The gradient's colour and coverage. Shared by both entry points: a gradient
// casts the shadow of exactly the pixels it draws.
fn gradient_shade(in: VertexOutput) -> vec4f {
    let base = in.entityIdx * 8u;
    let gradType = u32(primParams[base + 0u]);
    let angle = primParams[base + 1u];
    let stop0Pos = primParams[base + 2u];
    let stop0 = vec3f(primParams[base + 3u], primParams[base + 4u], primParams[base + 5u]);
    let stop1Pos = primParams[base + 6u];
    let stop1R = primParams[base + 7u];
    let packed = texLayerIndices[in.entityIdx];
    let stop1G = f32((packed >> 8u) & 0xFFu) / 255.0;
    let stop1B = f32(packed & 0xFFu) / 255.0;
    let stop1 = vec3f(stop1R, stop1G, stop1B);

    var t: f32;
    if (gradType == 0u) {
        // Linear gradient
        let rad = angle * 3.14159265 / 180.0;
        let dir = vec2f(cos(rad), sin(rad));
        t = dot(in.uv - 0.5, dir) + 0.5;
    } else if (gradType == 1u) {
        // Radial gradient
        t = length(in.uv - 0.5) * 2.0;
    } else {
        // Conic gradient
        let rad = angle * 3.14159265 / 180.0;
        let centered = in.uv - 0.5;
        t = (atan2(centered.y, centered.x) + 3.14159265 - rad) / (2.0 * 3.14159265);
        t = fract(t);
    }

    let s = clamp((t - stop0Pos) / max(stop1Pos - stop0Pos, 0.001), 0.0, 1.0);
    let color = mix(stop0, stop1, s);
    return vec4f(color, 1.0);
}

fn gradient_fs(in: VertexOutput) -> vec4f {
    return applyLighting(in, gradient_shade(in));
}

// A seed wherever the gradient is at least half covered.
fn gradient_occluder(in: VertexOutput) -> vec4f {
    return occluderSeed(in, gradient_shade(in).a);
}
```

`ts/src/shaders/primitives/box-shadow.wgsl` (da `box-shadow.wgsl`: helper prefissati, corpi alla lettera):

```wgsl
// Box shadow (type 5, prefix boxshadow_): SDF shadow, Evan Wallace erf() technique.
// PrimParams layout for BoxShadow:
//   [0]=rectW, [1]=rectH, [2]=cornerRadius, [3]=blur
//   [4]=colorR, [5]=colorG, [6]=colorB, [7]=colorA
// A library of the primitive modules: see prelude.wgsl.

fn boxshadow_vs(position: vec3f, entityIdx: u32) -> VertexOutput {
    return unitQuadVertex(position, entityIdx, position.xy + 0.5);
}

// Abramowitz-Stegun erf() approximation
fn boxshadow_erf(x: f32) -> f32 {
    let a1 =  0.254829592;
    let a2 = -0.284496736;
    let a3 =  1.421413741;
    let a4 = -1.453152027;
    let a5 =  1.061405429;
    let p  =  0.3275911;
    let s = sign(x);
    let ax = abs(x);
    let t = 1.0 / (1.0 + p * ax);
    let y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * exp(-ax * ax);
    return s * y;
}

fn boxshadow_integral(x: f32, sigma: f32) -> f32 {
    let s = x / (sigma * 1.4142135);
    return boxshadow_erf(s);
}

fn boxshadow_box2d(uv: vec2f, rectSize: vec2f, cornerRadius: f32, blur: f32) -> f32 {
    let sigma = blur * 0.5;
    if (sigma < 0.001) {
        // Sharp shadow — SDF rounded box
        let q = abs(uv) - rectSize * 0.5 + cornerRadius;
        let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - cornerRadius;
        return select(0.0, 1.0, d < 0.0);
    }
    let half = rectSize * 0.5 - cornerRadius;
    let ax = boxshadow_integral(uv.x + half.x, sigma) - boxshadow_integral(uv.x - half.x, sigma);
    let ay = boxshadow_integral(uv.y + half.y, sigma) - boxshadow_integral(uv.y - half.y, sigma);
    return ax * ay * 0.25;
}

// The box shadow's colour and coverage. Shared by both entry points: a box
// shadow casts the shadow of exactly the pixels it draws.
fn boxshadow_shade(in: VertexOutput) -> vec4f {
    let base = in.entityIdx * 8u;
    let rectW = primParams[base + 0u];
    let rectH = primParams[base + 1u];
    let cornerRadius = primParams[base + 2u];
    let blur = primParams[base + 3u];
    let colorR = primParams[base + 4u];
    let colorG = primParams[base + 5u];
    let colorB = primParams[base + 6u];
    let colorA = primParams[base + 7u];

    let localPos = (in.uv - 0.5) * vec2f(rectW + blur * 4.0, rectH + blur * 4.0);
    let alpha = boxshadow_box2d(localPos, vec2f(rectW, rectH), cornerRadius, blur);
    return vec4f(colorR, colorG, colorB, colorA * alpha);
}

fn boxshadow_fs(in: VertexOutput) -> vec4f {
    return boxshadow_shade(in);
}

// A seed wherever the box shadow is at least half covered.
fn boxshadow_occluder(in: VertexOutput) -> vec4f {
    return occluderSeed(in, boxshadow_shade(in).a);
}
```

- [ ] **Step 7: Scrivere le due librerie con derivate: msdf-text e bezier**

`ts/src/shaders/primitives/msdf-text.wgsl`. Il campionamento resta **crudo** (`sampleTier`): oggi `msdf-text.wgsl` non ha il bianco per l'indice 0, e con `sampleTierOrWhite` un glifo con indice 0 diventerebbe un rettangolo pieno su BC7/ASTC. `dpdx`/`dpdy` vengono dopo la chiamata, a flusso riconvergente, come oggi dopo lo switch in linea:

```wgsl
// MSDF text (type 2, prefix msdf_): median(r,g,b) SDF with screen-pixel-range AA.
// PrimParams layout for SDFGlyph (type 2):
//   [0]=atlasU0, [1]=atlasV0, [2]=atlasU1, [3]=atlasV1  — atlas UV rect
//   [4]=screenPxRange  — SDF range in screen pixels
//   [5]=colorR, [6]=colorG, [7]=colorB  — text color
// A library of the primitive modules: see prelude.wgsl.

fn msdf_median3(r: f32, g: f32, b: f32) -> f32 {
    return max(min(r, g), min(max(r, g), b));
}

fn msdf_vs(position: vec3f, entityIdx: u32) -> VertexOutput {
    // Read atlas UV rect from primParams
    let base = entityIdx * 8u;
    let atlasU0 = primParams[base + 0u];
    let atlasV0 = primParams[base + 1u];
    let atlasU1 = primParams[base + 2u];
    let atlasV1 = primParams[base + 3u];

    // Map unit quad UVs to atlas UV rect
    let localUV = position.xy + 0.5;

    return unitQuadVertex(position, entityIdx, vec2f(
        mix(atlasU0, atlasU1, localUV.x),
        mix(atlasV0, atlasV1, localUV.y),
    ));
}

// The glyph's colour and coverage. Shared by both entry points: a glyph casts
// the shadow of exactly the outline it draws.
fn msdf_shade(in: VertexOutput) -> vec4f {
    let base = in.entityIdx * 8u;
    let screenPxRange = primParams[base + 4u];
    let colorR = primParams[base + 5u];
    let colorG = primParams[base + 6u];
    let colorB = primParams[base + 7u];

    // The MSDF texel, RAW (sampleTier, never sampleTierOrWhite): the texel is
    // the glyph's coverage, and a white answer for packed index 0 would draw a
    // solid box where today an unfilled layer is discarded.
    let msdf = sampleTier(in);

    let sd = msdf_median3(msdf.r, msdf.g, msdf.b);

    // Compute screen-space texel size for anti-aliasing
    let screenTexSize = vec2f(
        length(vec2f(dpdx(in.uv.x), dpdy(in.uv.x))),
        length(vec2f(dpdx(in.uv.y), dpdy(in.uv.y)))
    );
    let avgScreenTexSize = 0.5 * (screenTexSize.x + screenTexSize.y);
    let screenPxDistance = screenPxRange * (sd - 0.5);
    let opacity = clamp(screenPxDistance / avgScreenTexSize + 0.5, 0.0, 1.0);

    if (opacity < 0.01) {
        discard;
    }

    return vec4f(colorR, colorG, colorB, opacity);
}

fn msdf_fs(in: VertexOutput) -> vec4f {
    return msdf_shade(in);
}

// A seed wherever the glyph is at least half covered.
fn msdf_occluder(in: VertexOutput) -> vec4f {
    return occluderSeed(in, msdf_shade(in).a);
}
```

`ts/src/shaders/primitives/bezier.wgsl` (da `bezier.wgsl`: `dot2`/`sdBezier` prefissati, colore via `sampleTierOrWhite`, copertura invariata):

```wgsl
// Quadratic Bezier curve (type 3, prefix bezier_): analytical SDF (Inigo Quilez).
// PrimParams layout for BezierPath:
//   [0]=p0x, [1]=p0y, [2]=p1x, [3]=p1y, [4]=p2x, [5]=p2y, [6]=width, [7]=_pad
// All control points in UV space [0,1].
// A library of the primitive modules: see prelude.wgsl.

fn bezier_vs(position: vec3f, entityIdx: u32) -> VertexOutput {
    return unitQuadVertex(position, entityIdx, position.xy + 0.5);
}

// --- Quadratic Bezier SDF (Inigo Quilez) ---
// Returns the unsigned distance from point `pos` to the quadratic Bezier
// defined by control points a, b, c.
// Reference: https://iquilezles.org/articles/distfunctions2d/

fn bezier_dot2(v: vec2f) -> f32 {
    return dot(v, v);
}

fn bezier_sd(pos: vec2f, a: vec2f, b: vec2f, c: vec2f) -> f32 {
    let A = b - a;
    let B = a - 2.0 * b + c;
    let C = A * 2.0;
    let D = a - pos;

    // Cubic coefficients: k * t^3 + ... = 0
    let kk = 1.0 / dot(B, B);
    let kx = kk * dot(A, B);
    let ky = kk * (2.0 * dot(A, A) + dot(D, B)) / 3.0;
    let kz = kk * dot(D, A);

    var res: f32 = 0.0;

    let p = ky - kx * kx;
    let q = kx * (2.0 * kx * kx - 3.0 * ky) + kz;
    let p3 = p * p * p;
    let q2 = q * q;
    var h: f32 = q2 + 4.0 * p3;

    if (h >= 0.0) {
        // One real root
        h = sqrt(h);
        let x = (vec2f(h, -h) - q) / 2.0;
        let uv2 = sign(x) * pow(abs(x), vec2f(1.0 / 3.0));
        let t = clamp(uv2.x + uv2.y - kx, 0.0, 1.0);
        let qp = D + (C + B * t) * t;
        res = bezier_dot2(qp);
    } else {
        // Three real roots — use trigonometric solution
        let z = sqrt(-p);
        let v = acos(q / (p * z * 2.0)) / 3.0;
        let m = cos(v);
        let n = sin(v) * 1.732050808; // sqrt(3)
        let t0 = clamp(vec3f(m + m, -n - m, n - m) * z - kx, vec3f(0.0), vec3f(1.0));

        // Only 2 of 3 roots need evaluation (third is provably suboptimal
        // for this parametric formulation — matches Quilez reference).
        let qx = D + (C + B * t0.x) * t0.x;
        let qy = D + (C + B * t0.y) * t0.y;
        let dx = bezier_dot2(qx);
        let dy = bezier_dot2(qy);
        res = min(dx, dy);
    }

    return sqrt(res);
}

// The curve's colour and coverage. Shared by both entry points: a bezier casts
// the shadow of exactly the stroke it draws.
fn bezier_shade(in: VertexOutput) -> vec4f {
    // Read Bezier control points and width from primParams
    let base = in.entityIdx * 8u;
    let p0 = vec2f(primParams[base + 0u], primParams[base + 1u]);
    let p1 = vec2f(primParams[base + 2u], primParams[base + 3u]);
    let p2 = vec2f(primParams[base + 4u], primParams[base + 5u]);
    let width = primParams[base + 6u];

    // Compute unsigned distance from fragment to Bezier curve
    let d = bezier_sd(in.uv, p0, p1, p2);

    // Anti-aliased stroke: fwidth gives screen-space-adaptive 1px edge
    let halfWidth = width * 0.5;
    let edge = fwidth(d);
    let aa = 1.0 - smoothstep(halfWidth - edge, halfWidth + edge, d);

    if (aa < 0.01) {
        discard;
    }

    // Sample color from texture tier (with overflow support); packed index 0
    // is white (sampleTierOrWhite). Only the colour is replaced here — the
    // stroke's coverage below still applies.
    var color = sampleTierOrWhite(in);

    color.a *= aa;
    return color;
}

fn bezier_fs(in: VertexOutput) -> vec4f {
    return bezier_shade(in);
}

// A seed wherever the stroke is at least half covered.
fn bezier_occluder(in: VertexOutput) -> vec4f {
    return occluderSeed(in, bezier_shade(in).a);
}
```

- [ ] **Step 8: Scrivere la libreria line**

`ts/src/shaders/primitives/line.wgsl`. `line_vs` è il corpo di oggi (L84-137 e L145-156 di `line.wgsl`) fino al clip: la posizione finale passa a `finishVertex`, poi `edgeScale` e `transparent` si assegnano con le stesse espressioni di oggi. L'unica rinomina interna è la variabile esterna `clipPosition`, perché dentro il ramo in pixel resta la `let clip` di oggi. `line_shade` tiene `fwidth(in.uv.y)` nella seconda istruzione, prima di ogni ramo; `line_fs` e `line_occluder` sono il `fs_main` e il `fs_occluder` di oggi:

```wgsl
// Line (type 1, prefix line_): a quad expanded across the segment from line parameters.
// PrimParams layout for Line:
//   [0]=startX, [1]=startY, [2]=endX, [3]=endY, [4]=width, [5]=dashLen, [6]=gapLen,
//   [7]=width unit: 0 = local units (scaled by the entity and the zoom), 1 = screen pixels
// A library of the primitive modules: see prelude.wgsl. Its fs and occluder
// are its own, not the common pattern: the opaque stroke is exactly
// line_insideStroke.

fn line_vs(position: vec3f, entityIdx: u32) -> VertexOutput {
    let model = transforms[entityIdx];

    // Read line params
    let base = entityIdx * 8u;
    let startX = primParams[base + 0u];
    let startY = primParams[base + 1u];
    let endX   = primParams[base + 2u];
    let endY   = primParams[base + 3u];
    let width  = primParams[base + 4u];

    // Line direction and perpendicular
    let dir = vec2f(endX - startX, endY - startY);
    let len = length(dir);
    let d = select(vec2f(1.0, 0.0), dir / len, len > 0.001);
    let perp = vec2f(-d.y, d.x);

    // Unit quad position.xy maps [-0.5, 0.5] to line segment:
    //   x: along line (0 = start, 1 = end)
    //   y: across line (-0.5 = left, 0.5 = right)
    let along = position.x + 0.5;   // [0, 1]
    let across = position.y;         // [-0.5, 0.5]

    // Pixel width: offset across the segment as it lies ON SCREEN, by
    // width/2 pixels turned into NDC. A missing viewport falls back to local units.
    let viewport = vec2f(camera.viewportWidth, camera.viewportHeight);
    let hasViewport = viewport.x > 0.0 && viewport.y > 0.0;
    let pixelWidth = primParams[base + 7u] > 0.5 && hasViewport;

    // Pixels per local unit across the stroke (orthographic camera: w = 1).
    let acrossClip = camera.viewProjection * model * vec4f(perp, 0.0, 0.0);
    let pxPerUnit = length(acrossClip.xy * viewport * 0.5);
    let unitsPerPx = select(0.0, 1.0 / pxPerUnit, hasViewport && pxPerUnit > 1e-6);

    // strokeWidth: what is drawn. The occluder seed renders at half
    // resolution, so there a stroke is at least one of its texels (2 px) wide,
    // or it could fall between texel centres and cast nothing.
    // quadWidth: the stroke plus an AA margin of one pixel (half each side),
    // so the OUTER half of the edge ramp is rasterised too; without it a pixel
    // centred on the edge followed the rasteriser's tie rule.
    var strokeWidth = width;
    var quadWidth = width;
    if (pixelWidth) {
        strokeWidth = select(width, max(width, 2.0), OCCLUDER_PASS);
        quadWidth = strokeWidth + 1.0;
    } else {
        strokeWidth = select(width, max(width, 2.0 * unitsPerPx), OCCLUDER_PASS);
        quadWidth = strokeWidth + unitsPerPx;
    }

    let worldPos = vec2f(startX, startY)
        + d * along * len
        + perp * across * quadWidth;

    var clipPosition: vec4f;
    if (pixelWidth) {
        let c0 = camera.viewProjection * model * vec4f(startX, startY, 0.0, 1.0);
        let c1 = camera.viewProjection * model * vec4f(endX, endY, 0.0, 1.0);
        let s = (c1.xy / c1.w - c0.xy / c0.w) * viewport;  // on-screen direction, pixels
        let sl = length(s);
        let sd = select(vec2f(1.0, 0.0), s / sl, sl > 0.001);
        let clip = mix(c0, c1, along);
        let offsetNdc = vec2f(-sd.y, sd.x) * across * quadWidth * 2.0 / viewport;
        clipPosition = vec4f(clip.xy + offsetNdc * clip.w, clip.zw);
    } else {
        clipPosition = camera.viewProjection * model * vec4f(worldPos, 0.0, 1.0);
    }

    var out = finishVertex(clipPosition, vec2f(along, across + 0.5), entityIdx);
    out.edgeScale = select(1.0, quadWidth / strokeWidth, strokeWidth > 0.0);
    // Computed from renderMeta bit 8, never assumed: the uber draws only
    // transparent entities today, but this must not depend on who draws it.
    out.transparent = select(0u, 1u, (renderMeta[entityIdx * 2u + 1u] & 0x100u) != 0u);
    return out;
}

// Shift of the stroke's half-open interval (edge units): see line_insideStroke.
const LINE_STROKE_TIE_EPS: f32 = 1e-3;

// Whether this fragment is inside the stroke, as a rasteriser decides a tie:
// the interval is half-open, [-1, 1), so a pixel centre exactly on an edge
// belongs to one side only, and an opaque W-px stroke covers exactly W pixel
// rows at any sub-pixel alignment (an alpha >= 0.5 test counted a tie on both
// sides). Both ends are shifted by the same tiny amount, so interpolation
// rounding at an exact tie cannot drop both edge pixels.
fn line_insideStroke(in: VertexOutput) -> bool {
    let d = (in.uv.y - 0.5) * 2.0 * in.edgeScale;
    return d >= -1.0 - LINE_STROKE_TIE_EPS && d < 1.0 - LINE_STROKE_TIE_EPS;
}

// The line's colour and coverage. Shared by both entry points: a line casts
// the shadow of exactly what it draws, dash gaps and anti-aliased edges included.
fn line_shade(in: VertexOutput) -> vec4f {
    // Edge anti-aliasing: distance from the centre line, 0 there and 1 at the
    // edge, faded over one screen pixel whatever the width unit. The rate is
    // taken on the LINEAR uv.y (edge changes twice as fast): fwidth of the
    // abs() would collapse at the centre's kink inside a 2x2 quad and make a
    // thin line's opacity follow pixel parity. Derivatives need uniform
    // control flow: first, before any branch.
    let edge = abs(in.uv.y - 0.5) * 2.0 * in.edgeScale;
    let edgeAA = max(2.0 * in.edgeScale * fwidth(in.uv.y), 1e-4);

    // Read line params for potential dash pattern
    let base = in.entityIdx * 8u;
    let dashLen = primParams[base + 5u];
    let gapLen = primParams[base + 6u];

    // Read color from texture (with overflow support); packed index 0 is
    // white (sampleTierOrWhite). Only the colour is replaced here — the
    // stroke's coverage below still applies.
    var color = sampleTierOrWhite(in);

    // SDF dash pattern (if dashLen > 0)
    if (dashLen > 0.0) {
        let totalLen = dashLen + gapLen;
        let along = in.uv.x;
        let lineLen = length(vec2f(
            primParams[base + 2u] - primParams[base + 0u],
            primParams[base + 3u] - primParams[base + 1u]
        ));
        let pos = along * lineLen;
        let phase = pos % totalLen;
        if (phase > dashLen) {
            discard;
        }
    }

    // Centred on the edge: alpha is 0.5 exactly there, so the stroke keeps its
    // full width and every fragment of the quad has alpha >= 0.5 (the occluder
    // seed then covers the whole stroke).
    color.a *= 1.0 - smoothstep(1.0 - edgeAA * 0.5, 1.0 + edgeAA * 0.5, edge);

    return color;
}

fn line_fs(in: VertexOutput) -> vec4f {
    let color = line_shade(in);
    // The opaque pipeline has no blending, so an AA-margin fragment would be
    // drawn solid and the line one pixel wider: keep exactly the stroke. The
    // transparent pipeline blends the ramp instead.
    if (in.transparent == 0u && !line_insideStroke(in)) {
        discard;
    }
    return color;
}

// A seed exactly where the opaque stroke is drawn (line_insideStroke;
// line_shade discards dash gaps).
fn line_occluder(in: VertexOutput) -> vec4f {
    // A texel with no alpha (a textured line) casts nothing either.
    let color = line_shade(in);
    if (color.a <= 0.0 || !line_insideStroke(in)) {
        discard;
    }
    return vec4f(in.screenUV, 1.0, 1.0);
}
```

- [ ] **Step 9: Eseguire i test, la suite intera e il type-check**

Run: `npx --prefix ts vitest run --root ts src/render/primitive-shaders.test.ts src/shaders/wgsl-analysis.test.ts`
Expected: PASS, `Test Files 2 passed (2)`, `Tests 112 passed (112)` (97 del compositore + 15 del Task 4).

Run: `npm --prefix ts test`
Expected: tutto verde. Rispetto a prima del Task 5 i test sono 97 in più e nessun test esistente cambia: i sei shader di oggi sono ancora quelli che leggono `forward-pass.test.ts`, `occluder-seed-stage.test.ts` e `light-groups.test.ts`.

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Expected: nessuna riga.

- [ ] **Step 10: Validare i 7 moduli composti con naga (il front-end di Firefox)**

Non sostituisce il cancello GPU del Task 8, ma trova subito un errore di sintassi o di tipo nei pezzi senza aprire un browser. Da eseguire dalla radice del repo, in un unico comando (lo stato della shell non sopravvive fra due chiamate). Node 24 importa il `.ts` del compositore togliendo i tipi; se `naga` manca, `cargo install naga-cli` lo installa (circa 25 s).

```bash
command -v naga >/dev/null || cargo install naga-cli
export OUT=$(mktemp -d)
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule } from './ts/src/render/primitive-shaders.ts';
const read = (n) => readFileSync('ts/src/shaders/primitives/' + n + '.wgsl', 'utf8');
const pieces = { prelude: read('prelude'), libraries: Object.fromEntries(PRIMITIVE_LIBRARIES.map((l) => [l.type, read(l.name)])) };
for (const [t, code] of Object.entries(composeTypeModules(pieces))) writeFileSync(process.env.OUT + '/type-' + t + '.wgsl', code);
writeFileSync(process.env.OUT + '/uber.wgsl', composeUberModule(pieces));
"
for f in "$OUT"/*.wgsl; do printf '%s: ' "$(basename "$f")"; naga "$f" 2>&1 | tail -1; done
```

Expected: sette righe, `type-0.wgsl: Validation successful` … `type-5.wgsl: Validation successful`, `uber.wgsl: Validation successful`.

Attenzione: naga (v30) **non** applica l'analisi di uniformità alle derivate. Anche l'uber senza la direttiva passa naga. Per la direttiva e per le derivate dei moduli per tipo l'unico controllo è Chrome (`getCompilationInfo` e pipeline in un error scope), che è il cancello bloccante del Task 8.

- [ ] **Step 11: Verificare che il task non tocchi niente di esistente**

Run: `grep -rln "primitive-shaders'" ts/src --include="*.ts"`
Expected: solo `ts/src/render/primitive-shaders.test.ts`. Nessun codice di produzione importa il compositore.

Run: `grep -rln "shaders/primitives" ts/src --include="*.ts"`
Expected: `ts/src/render/primitive-shaders.test.ts` (il glob dei pezzi) e `ts/src/render/primitive-shaders.ts` (solo nei commenti di documentazione: non importa niente). Nessun codice di produzione importa i pezzi.

Run: `git status --short`
Expected: esattamente queste righe, nessun `M`:

```text
?? ts/src/render/primitive-shaders.test.ts
?? ts/src/render/primitive-shaders.ts
?? ts/src/shaders/primitives/
```

- [ ] **Step 12: Commit**

```bash
git add ts/src/shaders/primitives/prelude.wgsl ts/src/shaders/primitives/quad.wgsl ts/src/shaders/primitives/line.wgsl ts/src/shaders/primitives/msdf-text.wgsl ts/src/shaders/primitives/bezier.wgsl ts/src/shaders/primitives/gradient.wgsl ts/src/shaders/primitives/box-shadow.wgsl ts/src/render/primitive-shaders.ts ts/src/render/primitive-shaders.test.ts
git commit -m "feat(5b): preludio, sei librerie prefissate e compositore dei moduli primitivi (non ancora usati)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Verifica fatta durante la stesura del piano** (riferimento per il Task 8, non uno step da ripetere): con questi pezzi esatti, su Chrome e l'iGPU AMD (RDNA-3, adapter low-power) i 7 moduli composti compilano senza errori. Si creano tutte le pipeline: opaca e trasparente sul layout a tre gruppi, occluder con `OCCLUDER_PASS: 1` sul layout a due gruppi, uber opaca e trasparente. L'uber senza la direttiva fallisce con "'fwidth' must only be called from uniform control flow", quindi la direttiva serve. `fs_main` del quad su due gruppi fallisce ("uses bindings in group 2"), quello di line no. Un render fuori schermo di 18 entità (tutti i tipi, texture a indice 0, tier 1 e overflow, linee in unità locali e in pixel, tratteggio, luci su due gruppi) ha dato **0 texel diversi** fra gli shader di oggi e i moduli composti, in opaco, trasparente e occluder, e 0 texel diversi fra l'uber e i moduli per tipo.

### Task 6: moduli composti in ForwardPass/OccluderSeedStage/renderer, `LIT_PRIMITIVE_TYPES` ricavato, vecchi sei shader eliminati, test sul testo riscritti

**Obiettivo.** Da qui in avanti la GPU compila soltanto i moduli composti. `renderer.ts` importa i sette pezzi `?raw`, li tiene in una statica `primitivePieces` e li pubblica con `publishPrimitiveShaders()` prima di costruire il primo grafo. La funzione aggiorna `ForwardPass.SHADER_SOURCES` sul posto e scrive `ForwardPass.UBER_SOURCE`.

`ForwardPass.setup()` costruisce anche la pipeline uber, con il descrittore trasparente identico a quello di oggi. Non la disegna ancora: il sub-pass trasparente continua a usare le pipeline per tipo, e il disegno passa all'uber nel Task 19. `LIT_PRIMITIVE_TYPES` diventa un valore ricavato da `PRIMITIVE_LIBRARIES`. I sei file WGSL di oggi vengono eliminati.

I 133 `expect` che leggevano il loro testo vengono riscritti sui moduli composti, divisi nei tre gruppi della spec §3.4:
- **preludio**, controllato una volta sola, più la verifica che ogni modulo lo contenga alla lettera;
- **wrapper**, su ognuno dei sei moduli per tipo;
- **libreria**, tramite il grafo delle chiamate.

I controlli "chi dichiara `@group(2)`" diventano controlli di raggiungibilità e di binding contro layout.

**Prerequisiti:**
- Task 4: `ts/src/shaders/wgsl-analysis.ts`.
- Task 5: `ts/src/render/primitive-shaders.ts` e i sette pezzi in `ts/src/shaders/primitives/`, già committati e con i loro test verdi.

Le righe citate sotto sono quelle di HEAD `aa9ee92`. I Task 1-5 non toccano nessuno dei file modificati qui.

**Files:**
- Create: `ts/src/render/primitive-pieces.fixture.ts`. Fixture di test: carica i pezzi come li indicizza `renderer.ts` e produce i sette moduli composti con le loro etichette.
- Modify: `ts/src/render/passes/forward-pass.ts`:
  - doc della classe, L15-17 e L29-37;
  - campi, L47-48;
  - statiche, L76-93;
  - controllo delle sorgenti, L103-105;
  - pipeline, L201-243;
  - commento a L262;
  - guardia di `execute`, L276;
  - `destroy`, L397-398.
- Modify: `ts/src/renderer.ts`:
  - import, L1-6 e L24;
  - statiche nuove dopo L58;
  - JSDoc di `recompileShader`, L123;
  - blocco `SHADER_SOURCES`, L300-307;
  - `forwardSlot`, L546-555;
  - accept HMR, L981-998.
- Modify: `ts/src/hyperion.ts`, JSDoc di `recompileShader` a L745.
- Modify: `ts/src/render/light-groups.ts`, import a L1 e `LIT_PRIMITIVE_TYPES` a L72-78.
- Modify, solo commenti:
  - `ts/src/render/passes/occluder-seed-stage.ts`, L23, L30-35, L56-57, L115;
  - `ts/src/render/primitive-bindings.ts`, L14-15;
  - `ts/src/demo/primitives.ts`, L52.
- Delete: `ts/src/shaders/basic.wgsl`, `ts/src/shaders/line.wgsl`, `ts/src/shaders/msdf-text.wgsl`, `ts/src/shaders/bezier.wgsl`, `ts/src/shaders/gradient.wgsl`, `ts/src/shaders/box-shadow.wgsl`.
- Test:
  - `ts/src/render/passes/forward-pass.test.ts`: riscrittura completa;
  - `ts/src/render/passes/occluder-seed-stage.test.ts`: L1-7 e L151-206;
  - `ts/src/render/light-groups.test.ts`: L1-3 e L165-176;
  - `ts/src/shaders/uniform-layout.test.ts`: completo;
  - `ts/src/shaders/storage-budget.test.ts`: completo.

**Interfaces:**
- Consumes (Task 4, `ts/src/shaders/wgsl-analysis.ts`):
  - `stripComments(src: string): string`
  - `functionBody(src: string, name: string): string | null`
  - `callGraph(src: string): Map<string, Set<string>>`
  - `reachableFrom(src: string, entry: string): Set<string>`
  - `bindingDecls(src: string): Array<{ group: number; binding: number; name: string }>`
- Consumes (Task 5, `ts/src/render/primitive-shaders.ts`):
  - `PRIMITIVE_LIBRARIES: readonly PrimitiveLibrary[]`
  - `interface PrimitiveLibrary { type; name; prefix; lit }`
  - `type PrimitiveLibraryName`
  - `interface PrimitivePieces { prelude: string; libraries: Record<number, string> }`
  - `composeTypeModules(pieces): Record<number, string>`
  - `composeUberModule(pieces): string`

  Inoltre consuma i pezzi `ts/src/shaders/primitives/{prelude,quad,line,msdf-text,bezier,gradient,box-shadow}.wgsl`.
- Produces:
  - `ForwardPass.UBER_SOURCE: string`: statica, default `''`. `setup()` lancia se è vuota.
  - `ForwardPass`: campo privato `uberPipeline: GPURenderPipeline | null`, costruito in `setup()` e letto dalla guardia di `execute()`.
  - `light-groups.ts`: `export const LIT_PRIMITIVE_TYPES: readonly number[] = PRIMITIVE_LIBRARIES.filter((l) => l.lit).map((l) => l.type);`
  - `renderer.ts`, a livello di modulo: `const primitivePieces: PrimitivePieces` e `function publishPrimitiveShaders(): void`.
  - Fixture: `loadPrimitivePieces(): PrimitivePieces` e `composedPrimitiveModules(pieces?: PrimitivePieces): Record<string, string>`. Le etichette sono `composed <nome libreria>` e `composed uber`.

**Dove finisce ogni guardia di oggi:**

| Test di oggi (righe) | Guardia | Dove va |
|---|---|---|
| forward-pass L119-127, L134-146 | indice 0 bianco prima di campionare un tier | `sampleTierOrWhite` nel preludio. `quad_shade`, `line_shade` e `bezier_shade` chiamano `sampleTierOrWhite` e mai `sampleTier`; `msdf_shade` chiama `sampleTier` crudo. `sampleTier` è l'unica funzione che tocca i tier |
| forward-pass L267-280 | `CameraUniform` a 68/72, `primParams[7]`, `fwidth` prima di un ramo | preludio; `line_vs`; `line_shade`, con `sampleTier` contato come ramo. Su modulo per tipo e uber |
| forward-pass L282-292 | rampa AA su `uv.y` lineare, centrata | `line_shade`, per tipo e uber |
| forward-pass L294-311 | quad più largo del tratto, discard opaco, seed = tratto | `VertexOutput` del preludio (locazioni 6/7); `line_shade`, `line_vs` (più `transparent` dal bit 8), `line_fs`, `line_occluder` |
| forward-pass L313-319 | test del tratto semiaperto | la funzione `line_…(in) -> bool`, trovata per firma |
| forward-pass L368-383 | gruppo 2 solo nei tipi lit | raggiungibilità da `fs_main` ⇔ `lit`; mai da `fs_occluder`/`vs_main`. Per ogni modulo per tipo e per ogni caso dell'uber |
| forward-pass L385-394 | luce solo in `fs_main`, con i gate | `applyLighting` (preludio) è l'unica funzione che tocca `lightBuffer`/`lightSampler`, e la chiamano solo i `<p>_fs` lit |
| forward-pass L396-405, L407-414 | 2d-array, `lightGroupOf`, bit 10 contro Rust | preludio |
| occluder L151-167 | override, bit 9 contro Rust, `fs_occluder` | preludio; `@fragment fn fs_occluder` su ogni modulo per tipo |
| occluder L172-181 | sei shader | il compositore dà i tipi 0-5 e niente per il 6. `OccluderSeedStage` costruisce 6 pipeline dai moduli composti e 0 dall'uber |
| occluder L186-205 | early-out, `castsInto`, funzione di copertura condivisa | preludio; early-out + `out.primType` nel `vs_main` di ogni modulo; `fs_main`→`<p>_fs`, `fs_occluder`→`<p>_occluder`, ed entrambi raggiungono `<p>_shade` |
| light-groups L165-176 | `LIT_PRIMITIVE_TYPES` = shader che dichiarano `@group(2)` | uguale alla tabella (fissata a [0, 4]), raggiungibilità nei moduli composti e nell'uber, registrazione dei pezzi in `renderer.ts` |
| uniform-layout L98-104 | ≥ 10 struct, niente padding interno | primo livello ≥ 14 (nessun pezzo nel glob) + i 7 composti, ognuno con `CameraUniform` + `LightingUniform` |
| storage-budget L25-31 | ≥ 19 file, ≤ 8 storage | primo livello ≥ 16 (nessun pezzo nel glob) + i 7 composti |
| (nuovo) | binding contro layout, visibilità per stage | ogni binding raggiunto da un entry point sta nel layout della sua pipeline (occluder = gruppi 0-1, ForwardPass = 0-2) ed è visibile al suo stage |

Le soglie di primo livello (16 file, 14 uniform) valgono anche dopo il Task 14 (+2 file e +2 uniform) e dopo il Task 15 (−1 file e −1 uniform, cioè `radix-sort`). Nessun task successivo deve toccarle.

- [ ] **Step 1: Crea la fixture dei pezzi**

Crea `ts/src/render/primitive-pieces.fixture.ts`:

```ts
import { PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule, type PrimitivePieces } from './primitive-shaders';

/**
 * Test fixture: the primitive shader pieces as committed in shaders/primitives/,
 * keyed the way renderer.ts keys them — the prelude, and each library under the
 * type PRIMITIVE_LIBRARIES gives its file name. Tests compose them with the
 * real composer, headless: these are the modules the GPU compiles.
 */
const files = import.meta.glob('../shaders/primitives/*.wgsl', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const path = (name: string): string => `../shaders/primitives/${name}.wgsl`;

/** A fresh copy on every call: a test may mutate it. */
export function loadPrimitivePieces(): PrimitivePieces {
  // The prelude and one library per type, nothing else: a stray piece would be
  // compiled by nobody and checked by nothing, a missing one fail silently.
  const expected = ['prelude', ...PRIMITIVE_LIBRARIES.map((l) => l.name)].map(path).sort();
  const found = Object.keys(files).sort();
  if (found.join('\n') !== expected.join('\n')) {
    throw new Error(`shaders/primitives/ holds [${found.join(', ')}]; expected [${expected.join(', ')}]`);
  }
  const libraries: Record<number, string> = {};
  for (const lib of PRIMITIVE_LIBRARIES) libraries[lib.type] = files[path(lib.name)];
  return { prelude: files[path('prelude')], libraries };
}

/**
 * The seven modules the GPU compiles, labelled for test names: `composed
 * <library name>` for each per-type module, and `composed uber`.
 */
export function composedPrimitiveModules(pieces: PrimitivePieces = loadPrimitivePieces()): Record<string, string> {
  const typeModules = composeTypeModules(pieces);
  const out: Record<string, string> = {};
  for (const lib of PRIMITIVE_LIBRARIES) out[`composed ${lib.name}`] = typeModules[lib.type];
  out['composed uber'] = composeUberModule(pieces);
  return out;
}
```

- [ ] **Step 2: Riscrivi `forward-pass.test.ts` (test che falliscono per l'uber)**

Sostituisci l'intero file `ts/src/render/passes/forward-pass.test.ts` con:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ForwardPass } from './forward-pass';
import { primitiveGroup0LayoutEntries, textureTierLayoutEntries } from '../primitive-bindings';
import { ResourcePool } from '../resource-pool';
import type { FrameState } from '../render-pass';
import { SCENE_HDR_FORMAT } from '../formats';
import {
  PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule,
  type PrimitiveLibrary, type PrimitiveLibraryName,
} from '../primitive-shaders';
import { loadPrimitivePieces } from '../primitive-pieces.fixture';
import { bindingDecls, callGraph, functionBody, reachableFrom, stripComments } from '../../shaders/wgsl-analysis';

// The WebGPU enums the fake devices and the shared layouts read (node has no WebGPU).
const g = globalThis as Record<string, unknown>;
g.GPUBufferUsage ??= { COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 };
g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
g.GPUTextureUsage ??= { COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

/** Stand-in for the uber module: the fake devices compile nothing, they record. */
const UBER_STUB = 'uber stub';

describe('ForwardPass', () => {
  it('should implement RenderPass interface', () => {
    const pass = new ForwardPass();
    expect(pass.name).toBe('forward');
    expect(pass.reads).toContain('visible-indices');
    expect(pass.reads).toContain('entity-transforms');
    expect(pass.reads).toContain('tex-indices');
    expect(pass.reads).toContain('indirect-args');
    expect(pass.writes).toContain('scene-hdr');
    expect(pass.optional).toBe(false);
  });

  it('should declare render-meta and prim-params as read dependencies', () => {
    const pass = new ForwardPass();
    expect(pass.reads).toContain('render-meta');
    expect(pass.reads).toContain('prim-params');
  });

  it('should start with empty pipeline maps', () => {
    const pass = new ForwardPass();
    // Access via destroy to verify no pipelines exist
    pass.destroy();
    // If no error, pipelines were successfully cleared (even though empty)
    expect(true).toBe(true);
  });
});

// ForwardPass binds the texture-tier views in group 1. A tier that grows gets a
// new texture and view, and the old texture is destroyed. The bind group must
// follow, or every draw uses a destroyed texture and the frame is dropped.
describe('ForwardPass group 1 follows the texture tiers', () => {
  function setUp() {
    const texture = () => ({ createView: () => ({}), destroy() {} });
    const device = {
      createBuffer: () => ({ destroy() {} }),
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: (d: GPUBindGroupDescriptor) => ({ entries: [...d.entries] }),
      createSampler: () => ({}),
      createTexture: texture,
      queue: { writeBuffer() {}, writeTexture() {} },
    } as unknown as GPUDevice;

    const pool = new ResourcePool();
    for (const name of ['entity-transforms', 'visible-indices', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params']) {
      pool.setBuffer(name, {} as GPUBuffer);
    }
    for (const name of ['tier0', 'tier1', 'tier2', 'tier3', 'ovf0', 'ovf1', 'ovf2', 'ovf3', 'scene-hdr']) {
      pool.setTextureView(name, { name } as unknown as GPUTextureView);
    }
    pool.setSampler('texSampler', {} as GPUSampler);

    const savedSources = ForwardPass.SHADER_SOURCES;
    const savedUber = ForwardPass.UBER_SOURCE;
    ForwardPass.SHADER_SOURCES = { 0: 'stub' };
    ForwardPass.UBER_SOURCE = UBER_STUB;
    const pass = new ForwardPass();
    try {
      pass.setup(device, pool);
    } finally {
      ForwardPass.SHADER_SOURCES = savedSources;
      ForwardPass.UBER_SOURCE = savedUber;
    }

    const frame = { canvasWidth: 64, canvasHeight: 64 } as FrameState;
    const group1Views = () => {
      const bound: Array<{ entries: GPUBindGroupEntry[] }> = [];
      const encoder = {
        beginRenderPass: () => ({
          setPipeline() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexedIndirect() {}, end() {},
          setBindGroup: (i: number, bg: { entries: GPUBindGroupEntry[] }) => { if (i === 1) bound.push(bg); },
        }),
      } as unknown as GPUCommandEncoder;
      pass.execute(encoder, frame, pool);
      expect(bound.length).toBeGreaterThan(0);
      return bound.map((bg) => bg.entries.map((e) => e.resource));
    };
    return { pool, group1Views };
  }

  it('binds the views that are in the pool when it draws', () => {
    const { pool, group1Views } = setUp();
    group1Views();

    const grown = { name: 'tier0 after growth' } as unknown as GPUTextureView;
    pool.setTextureView('tier0', grown);
    for (const views of group1Views()) {
      expect(views).toContain(grown);
    }
  });

  it('keeps the same bind group while nothing changes', () => {
    const { group1Views } = setUp();
    const first = group1Views()[0];
    const second = group1Views()[0];
    expect(second).toEqual(first);
  });
});

/**
 * ForwardPass set up on a recording fake device: stub sources for types 0, 1
 * and 4, and `uberSource` as UBER_SOURCE. The statics are restored afterwards.
 */
function setUpForward(options?: { lit?: boolean }, uberSource = UBER_STUB) {
  const layouts: GPUBindGroupLayoutDescriptor[] = [];
  const pipelineLayouts: GPUPipelineLayoutDescriptor[] = [];
  const pipelines: GPURenderPipelineDescriptor[] = [];
  const writes: Array<{ buffer: unknown; data: ArrayBuffer }> = [];
  const textures: GPUTextureDescriptor[] = [];
  const buffers: Array<{ size: number; usage: number }> = [];
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => { const b = { size: d.size, usage: d.usage, destroy() {} }; buffers.push(b); return b; },
    createShaderModule: (d: GPUShaderModuleDescriptor) => ({ code: d.code }),
    createSampler: () => ({ sampler: true }),
    createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => { layouts.push(d); return { d }; },
    createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => { pipelineLayouts.push(d); return { d }; },
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => { pipelines.push(d); return { descriptor: d }; },
    createBindGroup: (d: GPUBindGroupDescriptor) => ({ layout: d.layout, entries: [...d.entries] }),
    createTexture: (d: GPUTextureDescriptor) => {
      textures.push(d);
      return { createView: (vd?: GPUTextureViewDescriptor) => ({ placeholderOf: d, vd }), destroy() {} };
    },
    queue: {
      writeBuffer: (buffer: unknown, _o: number, data: ArrayBuffer | ArrayBufferView) => {
        writes.push({ buffer, data: data instanceof ArrayBuffer ? data : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength) });
      },
      writeTexture() {},
    },
  } as unknown as GPUDevice;

  const pool = new ResourcePool();
  for (const name of ['entity-transforms', 'visible-indices', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params']) {
    pool.setBuffer(name, {} as GPUBuffer);
  }
  for (const name of ['tier0', 'tier1', 'tier2', 'tier3', 'ovf0', 'ovf1', 'ovf2', 'ovf3', 'scene-hdr']) {
    pool.setTextureView(name, { name } as unknown as GPUTextureView);
  }
  pool.setSampler('texSampler', {} as GPUSampler);

  const savedSources = ForwardPass.SHADER_SOURCES;
  const savedUber = ForwardPass.UBER_SOURCE;
  ForwardPass.SHADER_SOURCES = { 0: 'stub', 1: 'stub', 4: 'stub' };
  ForwardPass.UBER_SOURCE = uberSource;
  const pass = new ForwardPass(options);
  try {
    pass.setup(device, pool);
  } finally {
    ForwardPass.SHADER_SOURCES = savedSources;
    ForwardPass.UBER_SOURCE = savedUber;
  }

  type Call = { op: string; index?: number; group?: { entries: GPUBindGroupEntry[] }; pipeline?: GPURenderPipelineDescriptor };
  const frame = { canvasWidth: 64, canvasHeight: 64 } as FrameState;
  const draw = (): Call[] => {
    const calls: Call[] = [];
    const encoder = {
      beginRenderPass: () => ({
        setVertexBuffer() {}, setIndexBuffer() {}, drawIndexedIndirect() {}, end() {},
        setPipeline: (p: { descriptor: GPURenderPipelineDescriptor }) => { calls.push({ op: 'pipeline', pipeline: p.descriptor }); },
        setBindGroup: (index: number, group: { entries: GPUBindGroupEntry[] }) => { calls.push({ op: 'group', index, group }); },
      }),
    } as unknown as GPUCommandEncoder;
    pass.execute(encoder, frame, pool);
    return calls;
  };
  const group2Texture = (calls: Call[]) => {
    const bound = calls.filter((c) => c.op === 'group' && c.index === 2);
    expect(bound.length).toBeGreaterThan(0);
    return bound.map((c) => c.group!.entries.find((e) => e.binding === 0)!.resource);
  };
  const prepare = (over: Partial<FrameState> = {}) =>
    pass.prepare(device, { cameraViewProjection: new Float32Array(16), ...over } as FrameState);
  return { pass, pool, layouts, pipelineLayouts, pipelines, writes, textures, draw, group2Texture, buffers, prepare };
}

// Phase 17, Task 10: ForwardPass reads the light buffer through a third bind
// group. Every primitive pipeline shares one layout of three groups. A layout
// may hold groups a shader does not use, but the bind group must still be set
// for every pipeline, or the draw fails validation. With lighting off, group 2
// binds a 1×1 placeholder and the lighting uniform says "disabled".
describe('ForwardPass @group(2): the light buffer', () => {
  it('builds every pipeline on a three-group layout; group 2 is texture, filtering sampler, uniform', () => {
    const { pipelineLayouts, layouts } = setUpForward();
    expect(pipelineLayouts.length).toBeGreaterThan(0);
    for (const pl of pipelineLayouts) expect([...pl.bindGroupLayouts]).toHaveLength(3);
    // Group 0 has 6 entries, group 1 has 9: group 2 is the one with 3.
    const group2 = layouts.find((l) => [...l.entries].length === 3)!;
    const entries = [...group2.entries].sort((a, b) => a.binding - b.binding);
    expect(entries.map((e) => e.binding)).toEqual([0, 1, 2]);
    expect(entries[0].texture?.sampleType ?? 'float').toBe('float');
    expect(entries[1].sampler?.type ?? 'filtering').toBe('filtering');
    expect(entries[2].buffer?.type).toBe('uniform');
    for (const e of entries) expect(e.visibility).toBe(GPUShaderStage.FRAGMENT);
  });

  // Light layers (design 2026-09-26): one light-buffer layer per light group.
  it('group 2 binds the light buffer as a 2d-array, and the placeholder is a 1-layer 2d-array', () => {
    const { layouts, textures, draw, group2Texture } = setUpForward();
    const group2 = layouts.find((l) => [...l.entries].length === 3)!;
    expect([...group2.entries].find((e) => e.binding === 0)!.texture?.viewDimension).toBe('2d-array');
    const placeholder = textures.find((t) => t.format === 'rgba8unorm')!;
    expect(placeholder.textureBindingViewDimension).toBe('2d-array');
    const bound = group2Texture(draw())[0] as unknown as { vd?: GPUTextureViewDescriptor };
    expect(bound.vd?.dimension).toBe('2d-array');
  });

  it('writes the layer→group table every frame, from FrameState.lightGroups', () => {
    const { writes, prepare } = setUpForward({ lit: true });
    prepare({ lightGroups: { layerToGroup: [0x10, 0x2] } as FrameState['lightGroups'] });
    expect([...new Uint32Array(writes.filter((w) => w.data.byteLength === 16).at(-1)!.data)]).toEqual([1, 0x10, 0x2, 0]);
    prepare({});
    expect([...new Uint32Array(writes.filter((w) => w.data.byteLength === 16).at(-1)!.data)]).toEqual([1, 0, 0, 0]);
  });

  it('writes the canvas size into the camera uniform at bytes 68-72 (line widths in pixels)', () => {
    const { writes, prepare } = setUpForward();
    prepare({ canvasWidth: 800, canvasHeight: 600 });
    const camera = writes.filter((w) => w.data.byteLength === 80).at(-1)!;
    expect([...new Float32Array(camera.data, 68, 2)]).toEqual([800, 600]);
  });

  it('the camera uniform is 80 bytes, and the shared layout says so (minBindingSize)', () => {
    const { buffers } = setUpForward();
    expect(buffers.filter((b) => (b.usage & GPUBufferUsage.UNIFORM) !== 0).map((b) => b.size)).toContain(80);
    expect(primitiveGroup0LayoutEntries()[0].buffer?.minBindingSize).toBe(80);
  });

  it('sets group 2 for every pipeline it draws, including shaders that ignore it', () => {
    const { draw } = setUpForward();
    const calls = draw();
    const pipelines = calls.filter((c) => c.op === 'pipeline').length;
    expect(pipelines).toBe(6); // 3 types, opaque + transparent (the uber is built, not drawn)
    expect(calls.filter((c) => c.op === 'group' && c.index === 2)).toHaveLength(pipelines);
  });

  it('without lighting: does not read light-buffer, binds a placeholder, and the uniform says disabled', () => {
    const { pass, pool, writes, draw, group2Texture } = setUpForward();
    expect(pass.reads).not.toContain('light-buffer');
    // A view left in the pool by a lit graph that has since been retired: its
    // texture is destroyed, and binding it would drop the frame.
    const stale = { name: 'stale light buffer' } as unknown as GPUTextureView;
    pool.setTextureView('light-buffer', stale);
    for (const view of group2Texture(draw())) expect(view).not.toBe(stale);
    const uniform = writes.find((w) => w.data.byteLength === 16);
    expect(uniform, 'the 16-byte lighting uniform').toBeDefined();
    expect(new Uint32Array(uniform!.data)[0]).toBe(0);
  });

  it('with lighting: reads light-buffer, binds the pool view, and the uniform says enabled', () => {
    const { pass, pool, writes, draw, group2Texture } = setUpForward({ lit: true });
    expect(pass.reads).toContain('light-buffer');
    const lightBuffer = { name: 'light-buffer' } as unknown as GPUTextureView;
    pool.setTextureView('light-buffer', lightBuffer);
    for (const view of group2Texture(draw())) expect(view).toBe(lightBuffer);
    const uniform = writes.find((w) => w.data.byteLength === 16);
    expect(new Uint32Array(uniform!.data)[0]).toBe(1);
  });

  it('with lighting: follows the light-buffer view when LightGroupsPass recreates it (resize)', () => {
    const { pool, draw, group2Texture } = setUpForward({ lit: true });
    pool.setTextureView('light-buffer', { name: 'before' } as unknown as GPUTextureView);
    draw();
    const resized = { name: 'after resize' } as unknown as GPUTextureView;
    pool.setTextureView('light-buffer', resized);
    for (const view of group2Texture(draw())) expect(view).toBe(resized);
  });
});

// The uber module (design 2026-09-27 §3.2): every primitive type behind one
// pipeline, for the sorted transparent draw. setup() builds it with exactly the
// descriptor of today's transparent pipelines, so every graph and every
// hot-reload probe validates it; the transparent sub-pass does not use it yet.
describe('ForwardPass builds the uber pipeline, not drawn yet', () => {
  const codeOf = (p: GPURenderPipelineDescriptor): string => (p.vertex.module as unknown as { code: string }).code;

  it('builds it once, from UBER_SOURCE, with exactly the transparent descriptor', () => {
    const { pipelines } = setUpForward();
    // 3 stub types × (opaque + transparent), and the uber.
    expect(pipelines).toHaveLength(7);
    const ubers = pipelines.filter((p) => codeOf(p) === UBER_STUB);
    expect(ubers).toHaveLength(1);
    const uberPipeline = ubers[0];
    expect(uberPipeline.fragment?.module).toBe(uberPipeline.vertex.module);
    expect(uberPipeline.vertex.entryPoint).toBe('vs_main');
    expect(uberPipeline.fragment?.entryPoint).toBe('fs_main');
    expect([...(uberPipeline.vertex.buffers ?? [])]).toEqual([
      { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
    ]);
    expect([...(uberPipeline.fragment?.targets ?? [])]).toEqual([{
      format: SCENE_HDR_FORMAT,
      blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
    }]);
    expect(uberPipeline.depthStencil).toEqual({ format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' });
    expect(uberPipeline.primitive).toEqual({ topology: 'triangle-list', cullMode: 'back' });
    // Module aside, the same descriptor as every per-type transparent
    // pipeline, the three-group layout included.
    const withoutModule = (p: GPURenderPipelineDescriptor) => ({
      ...p, vertex: { ...p.vertex, module: null }, fragment: { ...p.fragment, module: null },
    });
    const transparent = pipelines.filter((p) => p !== uberPipeline && p.depthStencil?.depthWriteEnabled === false);
    expect(transparent).toHaveLength(3);
    for (const p of transparent) expect(withoutModule(p)).toEqual(withoutModule(uberPipeline));
  });

  it('does not draw it yet: the transparent sub-pass still draws each type with its own pipeline', () => {
    const { pipelines, draw } = setUpForward();
    const uberPipeline = pipelines.find((p) => codeOf(p) === UBER_STUB);
    expect(uberPipeline).toBeDefined();
    const drawn = draw().filter((c) => c.op === 'pipeline').map((c) => c.pipeline);
    expect(drawn).toHaveLength(6);
    expect(drawn).not.toContain(uberPipeline);
  });

  it('refuses to set up without an uber module: publishPrimitiveShaders() runs first', () => {
    expect(() => setUpForward({}, '')).toThrow(/UBER_SOURCE/);
  });
});

// ---------------------------------------------------------------------------
// The primitive shaders are composed (render/primitive-shaders.ts, design
// 2026-09-27 §3): the prelude (shared names, bindings, helpers), one library
// per type, generated wrappers. The GPU compiles the composed modules, so every
// check reads them — or the prelude, once, where the text lives there: the
// first check proves every module contains it verbatim. What a library does is
// found through the call graph, never by slicing between entry points, and
// `body` throws on a missing function, so no negative check passes on ''.
// WGSL does not run headless: these pin the source.
const pieces = loadPrimitivePieces();
const prelude = stripComments(pieces.prelude);
const typeModules = composeTypeModules(pieces);
const uber = stripComments(composeUberModule(pieces));

const libOf = (name: PrimitiveLibraryName): PrimitiveLibrary => {
  const lib = PRIMITIVE_LIBRARIES.find((l) => l.name === name);
  if (!lib) throw new Error(`no library '${name}'`);
  return lib;
};
const moduleOf = (name: PrimitiveLibraryName): string => stripComments(typeModules[libOf(name).type]);
const fnOf = (name: PrimitiveLibraryName, suffix: 'vs' | 'fs' | 'occluder' | 'shade'): string => `${libOf(name).prefix}${suffix}`;

/** A function's body; throws when the function is missing. */
function body(src: string, fn: string): string {
  const text = functionBody(src, fn);
  if (text === null) throw new Error(`fn ${fn} not found`);
  return text;
}

describe('the composed primitive modules', () => {
  it('one module per type 0-5 and the uber, each containing the prelude verbatim', () => {
    expect(PRIMITIVE_LIBRARIES.map((l) => l.type)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Object.keys(typeModules).map(Number)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const src of [...Object.values(typeModules), composeUberModule(pieces)]) {
      expect(src.includes(pieces.prelude.trim())).toBe(true);
    }
  });
});

// An untextured entity carries packed texture index 0: tier 0, layer 0, not
// overflow. Layer 0 is reserved and never holds a real texture. It is meant to
// be white, but on a compressed tier (BC7/ASTC) it is never filled, because
// writeTexture cannot take raw pixels there. An all-zero BC7 block decodes to
// transparent black, so every untextured quad drew black on desktop and white
// on an rgba8-only device. The prelude answers index 0 itself
// (sampleTierOrWhite); lines and beziers replace only the colour and keep their
// coverage. MSDF text is the exception: its "texture" is the glyph atlas.
const TIERS = ['tier0Tex', 'tier1Tex', 'tier2Tex', 'tier3Tex', 'ovf0Tex', 'ovf1Tex', 'ovf2Tex', 'ovf3Tex'];
const WHITE_AT_INDEX_0: PrimitiveLibraryName[] = ['quad', 'line', 'bezier'];

describe('packed index 0 is white in every tier-sampling primitive', () => {
  it('sampleTierOrWhite returns white for packed index 0 before it samples a tier', () => {
    const fn = body(prelude, 'sampleTierOrWhite');
    const untextured = fn.search(/in\.isOverflow == 0u && in\.texTier == 0u && in\.texLayer == 0u/);
    expect(untextured, 'the untextured check').toBeGreaterThan(-1);
    expect(fn).toMatch(/vec4f\(1\.0\)/);
    expect(fn.indexOf('sampleTier(in)')).toBeGreaterThan(untextured);
    expect(fn).not.toMatch(/textureSample/);
  });

  it('sampleTier is the one function that samples the tiers: all eight, with textureSampleLevel', () => {
    const fn = body(prelude, 'sampleTier');
    for (const tier of TIERS) {
      expect(fn).toMatch(new RegExp(`textureSampleLevel\\(\\s*${tier}\\s*,\\s*texSampler\\s*,\\s*in\\.uv\\s*,\\s*in\\.texLayer\\s*,\\s*0\\.0\\s*\\)`));
    }
    const samplers = [...callGraph(uber)].filter(([, refs]) => TIERS.some((t) => refs.has(t))).map(([name]) => name);
    expect(samplers).toEqual(['sampleTier']);
  });

  it.each(WHITE_AT_INDEX_0)('%s: its coverage function takes the colour from sampleTierOrWhite, never sampleTier', (name) => {
    for (const src of [moduleOf(name), uber]) {
      const refs = callGraph(src).get(fnOf(name, 'shade'));
      expect(refs, fnOf(name, 'shade')).toBeDefined();
      expect(refs!.has('sampleTierOrWhite')).toBe(true);
      expect(refs!.has('sampleTier')).toBe(false);
    }
  });

  // A glyph with index 0 stays what the raw sample gives (on BC7/ASTC
  // transparent black, discarded), not a solid white box.
  it('msdf-text samples the atlas raw, without the white answer', () => {
    for (const src of [moduleOf('msdf-text'), uber]) {
      const refs = callGraph(src).get(fnOf('msdf-text', 'shade'));
      expect(refs, fnOf('msdf-text', 'shade')).toBeDefined();
      expect(refs!.has('sampleTier')).toBe(true);
      expect(reachableFrom(src, fnOf('msdf-text', 'shade')).has('sampleTierOrWhite')).toBe(false);
    }
  });

  it.each(['gradient', 'box-shadow'] as PrimitiveLibraryName[])('%s never samples the tiers', (name) => {
    const reached = reachableFrom(moduleOf(name), 'fs_main');
    expect(reached.has('sampleTier')).toBe(false);
    expect(reached.has('sampleTierOrWhite')).toBe(false);
  });
});

describe('line: pixel widths, anti-aliasing, the half-open stroke', () => {
  const line = moduleOf('line');
  // The uber embeds the same library for the transparent draw: checked in both.
  const both = [line, uber];

  /** The stroke test: line's one `(in: VertexOutput) -> bool` function. */
  const insideStroke = (): string => {
    const m = /fn (line_\w+)\s*\(\s*in\s*:\s*VertexOutput\s*\)\s*->\s*bool/.exec(line);
    if (!m) throw new Error('line has no stroke test: fn line_…(in: VertexOutput) -> bool');
    return m[1];
  };

  it('the camera uniform carries the viewport size at 68/72; line_vs reads the width unit in primParams[7]', () => {
    const camera = /struct CameraUniform\s*\{([\s\S]*?)\}/.exec(prelude)![1]
      .split('\n').map((l) => l.trim()).filter(Boolean);
    // mat4 (64 B), then four 4-byte scalars: occluderLayers at 64, the viewport at 68 and 72.
    expect(camera.slice(0, 4)).toEqual([
      'viewProjection: mat4x4f,', 'occluderLayers: u32,', 'viewportWidth: f32,', 'viewportHeight: f32,',
    ]);
    for (const src of both) expect(body(src, fnOf('line', 'vs'))).toMatch(/primParams\[base \+ 7u\]/);
  });

  it('line_shade takes fwidth before any branch or tier sample', () => {
    // Derivatives need uniform control flow. In the uber the call sits in the
    // type switch, which its diagnostic(off, derivative_uniformity) covers.
    for (const src of both) {
      const shade = body(src, fnOf('line', 'shade'));
      const firstBranch = Math.min(...['switch', 'discard', 'if (', 'sampleTier'].map((k) => shade.indexOf(k)).filter((i) => i >= 0));
      expect(shade.indexOf('fwidth(')).toBeGreaterThanOrEqual(0);
      expect(shade.indexOf('fwidth(')).toBeLessThan(firstBranch);
    }
  });

  it('the AA ramp is measured on the LINEAR uv.y and centred on the edge', () => {
    for (const src of both) {
      const shade = body(src, fnOf('line', 'shade'));
      // fwidth of abs() has a kink at the centre: 2x2-quad derivatives collapse
      // there and a ~2 px line's opacity follows pixel parity.
      expect(shade).toMatch(/fwidth\(\s*in\.uv\.y\s*\)/);
      expect(shade).not.toMatch(/fwidth\(\s*edge\s*\)/);
      // Centred: alpha is 0.5 exactly at the edge, so every fragment inside the
      // quad keeps alpha >= 0.5 and the occluder seed covers the whole stroke.
      expect(shade).toMatch(/smoothstep\(1\.0 - edgeAA \* 0\.5, 1\.0 \+ edgeAA \* 0\.5, edge\)/);
    }
  });

  it('the quad is wider than the stroke, so the OUTER half of the edge ramp is rasterised', () => {
    // Without the margin a pixel centred on the edge depends on the
    // rasteriser's tie rule: a thin transparent line's coverage followed
    // sub-pixel position (1.5 to 2.0 for 2 px, measured on GPU).
    const output = /struct VertexOutput\s*\{([\s\S]*?)\}/.exec(prelude)![1];
    // Interpolated with perspective, not flat: the half-open test compares its last bits.
    expect(output).toMatch(/@location\(6\)\s+edgeScale\s*:\s*f32/);
    expect(output).toMatch(/@location\(7\)\s+@interpolate\(flat\)\s+transparent\s*:\s*u32/);
    const inside = insideStroke();
    for (const src of both) {
      expect(body(src, fnOf('line', 'shade'))).toMatch(/let edge = abs\(in\.uv\.y - 0\.5\) \* 2\.0 \* in\.edgeScale;/);
      const vs = body(src, fnOf('line', 'vs'));
      expect(vs).toMatch(/quadWidth = strokeWidth \+ 1\.0/);
      // From renderMeta bit 8, never hard-wired: the uber draws only
      // transparent lines because of the buckets it is fed, not by construction.
      expect(vs).toMatch(/out\.transparent = select\(0u, 1u, \(renderMeta\[entityIdx \* 2u \+ 1u\] & 0x100u\) != 0u\);/);
      // The opaque pipeline has no blending: there a margin fragment (alpha
      // < 0.5) must be dropped, or opaque lines draw one pixel wider.
      expect(body(src, fnOf('line', 'fs'))).toMatch(new RegExp(`if \\(in\\.transparent == 0u && !${inside}\\(in\\)\\) \\{\\s*discard;`));
      // The seed is exactly the opaque stroke: same half-open test.
      expect(body(src, fnOf('line', 'occluder'))).toContain(`!${inside}(in)`);
    }
  });

  it('the stroke test is half-open, so an opaque W-px stroke covers W pixel rows at any alignment', () => {
    for (const src of both) {
      const fn = body(src, insideStroke());
      // Signed distance, one closed and one open end, both shifted the same way.
      expect(fn).toMatch(/let d = \(in\.uv\.y - 0\.5\) \* 2\.0 \* in\.edgeScale;/);
      expect(fn).toMatch(/return d >= -1\.0 - (\w+) && d < 1\.0 - \1;/);
    }
  });
});

// Which modules apply lighting, and where. ForwardPass binds group 2 (the light
// buffer) for every pipeline, and the prelude declares it in every module: what
// must hold is REACHABILITY. OccluderSeedStage runs the same per-type modules
// through vs_main and fs_occluder on a TWO-group layout, and WebGPU rejects a
// pipeline whose entry point statically uses a binding its layout lacks: the
// lit graph is then rejected and lighting silently stays off. The group-2 names
// come from the prelude's own declarations, plus the helper that reads its table.
const GROUP2 = bindingDecls(prelude).filter((b) => b.group === 2).map((b) => b.name);
const LIGHT_NAMES = [...GROUP2, 'lightGroupOf'];
const reachesLight = (src: string, entry: string): string[] => {
  const reached = reachableFrom(src, entry);
  return LIGHT_NAMES.filter((name) => reached.has(name));
};

/** The uber's fs_main: primitive type → the function its case returns. */
function uberFragmentCases(): Map<number, string> {
  const cases = new Map<number, string>();
  const re = /case\s+(\d+)u\s*(?:,\s*default\s*)?:\s*\{\s*return\s+(\w+)\s*\(\s*in\s*\)\s*;\s*\}/g;
  for (const m of body(uber, 'fs_main').matchAll(re)) cases.set(Number(m[1]), m[2]);
  return cases;
}

describe('lit primitives: group 2 is reached from fs_main of the lit types only', () => {
  it('group 2 is the light buffer, its sampler and the lighting uniform', () => {
    expect([...GROUP2].sort()).toEqual(['lightBuffer', 'lightSampler', 'lighting']);
  });

  it.each(PRIMITIVE_LIBRARIES.map((l): [string, PrimitiveLibrary] => [l.name, l]))(
    '%s: fs_main reaches group 2 exactly when the type is lit; fs_occluder and vs_main never',
    (_name, l) => {
      const src = stripComments(typeModules[l.type]);
      expect(reachesLight(src, 'fs_main').length > 0).toBe(l.lit);
      expect(reachesLight(src, 'fs_occluder')).toEqual([]);
      expect(reachesLight(src, 'vs_main')).toEqual([]);
    },
  );

  it('the uber: every case of fs_main returns its library fs, which reaches group 2 exactly when lit; vs_main never', () => {
    const cases = uberFragmentCases();
    expect([...cases.keys()].sort((a, b) => a - b)).toEqual(PRIMITIVE_LIBRARIES.map((l) => l.type));
    for (const l of PRIMITIVE_LIBRARIES) {
      expect(cases.get(l.type)).toBe(`${l.prefix}fs`);
      expect(reachesLight(uber, `${l.prefix}fs`).length > 0, l.name).toBe(l.lit);
    }
    expect(reachesLight(uber, 'vs_main')).toEqual([]);
  });

  it('applyLighting samples the light buffer gated on lighting.enabled and receivesLight; only the lit fs call it', () => {
    const fn = body(prelude, 'applyLighting');
    expect(fn).toMatch(/textureSampleLevel\s*\(\s*lightBuffer\b/);
    expect(fn).toMatch(/RECEIVES_LIGHT_BIT/);
    expect(fn).toMatch(/lighting\.enabled/);
    const graph = [...callGraph(uber)];
    expect(graph.filter(([, refs]) => refs.has('lightBuffer') || refs.has('lightSampler')).map(([name]) => name))
      .toEqual(['applyLighting']);
    // Never after the uber's switch: the other types would turn lit, which
    // deriveLightGroups does not model.
    expect(graph.filter(([, refs]) => refs.has('applyLighting')).map(([name]) => name).sort())
      .toEqual(PRIMITIVE_LIBRARIES.filter((l) => l.lit).map((l) => `${l.prefix}fs`).sort());
  });

  it('the light buffer is a 2d-array, sampled at the layer of the receiver group: lowest mask bit, 4-bit table', () => {
    expect(prelude).toMatch(/@group\(2\) @binding\(0\) var lightBuffer: texture_2d_array<f32>;/);
    expect(prelude).toMatch(/groupTableLo: u32,\s*groupTableHi: u32,/);
    const fn = body(prelude, 'lightGroupOf');
    expect(fn).toMatch(/firstTrailingBit\(mask\)/);
    expect(fn).toMatch(/0xFu/);
    expect(body(prelude, 'applyLighting')).toMatch(/textureSampleLevel\(lightBuffer, lightSampler, in\.screenUV, lightGroupOf\(/);
  });

  it('RECEIVES_LIGHT_BIT matches RENDER_META_RECEIVES_LIGHT_BIT in components.rs', () => {
    const rust = readFileSync(new URL('../../../../crates/hyperion-core/src/components.rs', import.meta.url), 'utf8');
    const rustBit = Number(/RENDER_META_RECEIVES_LIGHT_BIT: u32 = 1 << (\d+);/.exec(rust)?.[1]);
    const wgslBit = Number(/const RECEIVES_LIGHT_BIT\s*:\s*u32\s*=\s*1u << (\d+)u;/.exec(prelude)?.[1]);
    expect(rustBit).toBe(10);
    expect(wgslBit).toBe(rustBit);
  });
});

// Binding against layout. ForwardPass runs a per-type module's vs_main and
// fs_main on groups 0-2, OccluderSeedStage its vs_main and fs_occluder on
// groups 0-1, and the uber runs on groups 0-2. A binding an entry point reaches
// must be in that layout and visible to that stage: camera, transforms and
// visibleIndices are vertex-only, groups 1 and 2 fragment-only. WebGPU reports
// a violation only at pipeline creation, on a GPU: headless this is the check.
type Layouts = Record<number, GPUBindGroupLayoutEntry[]>;

/** The layouts the primitive pipelines are built with: the shared ones, and ForwardPass's group 2. */
function primitiveLayouts(): Layouts {
  const group2 = setUpForward().layouts.find((l) => [...l.entries].length === 3);
  if (!group2) throw new Error('ForwardPass built no three-entry layout (group 2)');
  return { 0: primitiveGroup0LayoutEntries(), 1: textureTierLayoutEntries(), 2: [...group2.entries] };
}

const DECL = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]+)>)?\s+(\w+)\s*:\s*([^;]+);/g;
const declKind = (space: string | undefined, type: string): string => (space ?? type).replace(/\s+/g, '');
function layoutKind(e: GPUBindGroupLayoutEntry): string {
  if (e.buffer) return e.buffer.type === 'read-only-storage' ? 'storage,read' : (e.buffer.type ?? 'uniform');
  if (e.sampler) return 'sampler';
  if (e.texture) {
    const sample = (e.texture.sampleType ?? 'float') === 'float' ? 'f32' : String(e.texture.sampleType);
    return `texture_${(e.texture.viewDimension ?? '2d').replace('-', '_')}<${sample}>`;
  }
  return 'unknown';
}

/** The bindings `entry` reaches, each checked against `groups` and the stage visibility; returns their names. */
function checkReach(src: string, entry: string, stage: number, groups: number[], layouts: Layouts): string[] {
  const reached = reachableFrom(src, entry);
  const hit = bindingDecls(src).filter((b) => reached.has(b.name));
  for (const b of hit) {
    expect(groups, `${entry} reaches ${b.name} in group ${b.group}`).toContain(b.group);
    const e = layouts[b.group]?.find((x) => x.binding === b.binding);
    expect(e !== undefined && (e.visibility & stage) !== 0, `${b.name} is visible to ${entry}`).toBe(true);
  }
  return hit.map((b) => b.name);
}

describe('every binding an entry point reaches is in its pipeline layout, for its stage', () => {
  it('the layouts: camera, transforms and visibleIndices vertex-only; groups 1 and 2 fragment-only', () => {
    const layouts = primitiveLayouts();
    for (const binding of [0, 1, 2]) {
      expect(layouts[0].find((e) => e.binding === binding)?.visibility).toBe(GPUShaderStage.VERTEX);
    }
    for (const e of [...layouts[1], ...layouts[2]]) expect(e.visibility).toBe(GPUShaderStage.FRAGMENT);
  });

  it('every prelude binding has a layout entry of its kind, and every layout entry a binding', () => {
    const layouts = primitiveLayouts();
    const decls = [...prelude.matchAll(DECL)].map((m) => ({
      group: Number(m[1]), binding: Number(m[2]), name: m[4], kind: declKind(m[3], m[5]),
    }));
    // The regex sees exactly what wgsl-analysis sees.
    expect(decls.map((d) => d.name).sort()).toEqual(bindingDecls(prelude).map((b) => b.name).sort());
    for (const d of decls) {
      const entry = layouts[d.group]?.find((e) => e.binding === d.binding);
      expect(entry, `${d.name} @group(${d.group}) @binding(${d.binding})`).toBeDefined();
      expect(layoutKind(entry!), d.name).toBe(d.kind);
    }
    for (const [group, entries] of Object.entries(layouts)) {
      expect(decls.filter((d) => d.group === Number(group)), `group ${group}`).toHaveLength(entries.length);
    }
  });

  it.each(PRIMITIVE_LIBRARIES.map((l): [string, PrimitiveLibrary] => [l.name, l]))(
    '%s: vs_main, fs_main and fs_occluder stay inside their layouts',
    (_name, l) => {
      const layouts = primitiveLayouts();
      const src = stripComments(typeModules[l.type]);
      // vs_main runs in the ForwardPass pipelines AND the occluder ones: two groups.
      expect(checkReach(src, 'vs_main', GPUShaderStage.VERTEX, [0, 1], layouts)).toContain('visibleIndices');
      checkReach(src, 'fs_main', GPUShaderStage.FRAGMENT, [0, 1, 2], layouts);
      checkReach(src, 'fs_occluder', GPUShaderStage.FRAGMENT, [0, 1], layouts);
    },
  );

  it('the uber: vs_main and fs_main stay inside the ForwardPass layout', () => {
    const layouts = primitiveLayouts();
    const vs = checkReach(uber, 'vs_main', GPUShaderStage.VERTEX, [0, 1, 2], layouts);
    const fs = checkReach(uber, 'fs_main', GPUShaderStage.FRAGMENT, [0, 1, 2], layouts);
    expect(vs).toEqual(expect.arrayContaining(['camera', 'transforms', 'visibleIndices', 'renderMeta']));
    expect(fs).toEqual(expect.arrayContaining(['tier0Tex', 'lightBuffer', 'primParams']));
  });
});
```

Blocchi di oggi e loro sostituti in questo file:
- L1-7: gli import perdono `basic.wgsl?raw` e guadagnano compositore, fixture e analisi.
- L36-110: gruppo 1. Cambiano solo le righe di `UBER_SOURCE` e i globali, spostati in cima.
- L112-146 → describe "packed index 0 …".
- L148-226: `setUp` sale a livello di modulo e diventa `setUpForward`.
- L227-265 e L321-366: invariati, su `setUpForward`.
- L267-319 → describe "line: …".
- L368-415 → describe "lit primitives …" e "every binding …".
- Nuovo: describe "ForwardPass builds the uber pipeline, not drawn yet".

- [ ] **Step 3: Esegui il test: deve fallire solo sull'uber**

Run: `npx --prefix ts vitest run --root ts src/render/passes/forward-pass.test.ts`

Expected: FAIL con 3 test rossi, tutti nel describe `ForwardPass builds the uber pipeline, not drawn yet`:
- `builds it once …`: 6 pipeline invece di 7;
- `does not draw it yet …`: `uberPipeline` è undefined;
- `refuses to set up without an uber module …`: non lancia.

La ragione è che `ForwardPass` non ha ancora `UBER_SOURCE`. Tutti i controlli sui moduli composti devono già passare, perché leggono i pezzi del Task 5.

Se uno di quei controlli fallisce, il pezzo del Task 5 si discosta dalla spec (§3.1-3.2) o dal contratto: nomi, testo conservato alla lettera, forma dei wrapper. Si corregge il pezzo, non il test, e si rieseguono anche i test del Task 5.

- [ ] **Step 4: Implementa `UBER_SOURCE` e la pipeline uber in `forward-pass.ts`**

(a) Doc della classe, L15-17. Prima:
```ts
 * Each registered primitive type (via SHADER_SOURCES) gets TWO pipelines:
 * one opaque (depth-write enabled, no blend) and one transparent (depth-write
 * disabled, alpha blend enabled).
```
Dopo:
```ts
 * Each registered primitive type (via SHADER_SOURCES) gets TWO pipelines:
 * one opaque (depth-write enabled, no blend) and one transparent (depth-write
 * disabled, alpha blend enabled). UBER_SOURCE, every primitive type in one
 * module, gets one more pipeline with the transparent descriptor: built, and so
 * validated with every graph and every hot-reload probe, but not drawn yet.
```

(b) L29-37. Prima:
```ts
 * Group 2 is the light buffer (Phase 17): texture, sampler, lighting uniform.
 * Every pipeline shares the three-group layout, but only the shaders that apply
 * lighting (basic.wgsl, gradient.wgsl) declare group 2; a layout may hold groups
 * a shader never uses. It is bound for every pipeline all the same, or the draw
 * fails validation. Constructed `lit`, the pass reads `light-buffer` (written by
```
Dopo:
```ts
 * Group 2 is the light buffer (Phase 17): texture, sampler, lighting uniform.
 * Every pipeline shares the three-group layout, and every composed module
 * declares group 2 (the prelude does), but only the lit types' fs_main reaches
 * it: `applyLighting`, called by `quad_fs` and `gradient_fs`. It is bound for
 * every pipeline all the same, or the draw fails validation. Constructed `lit`,
 * the pass reads `light-buffer` (written by
```
Le righe L34-37, da `LightGroupsPass, one layer per light group)` in poi, restano invariate.

(c) Campi, dopo L48 (`private transparentPipelines = …`) aggiungi:
```ts
  /** Every primitive type in one pipeline (UBER_SOURCE), transparent descriptor. Built, not drawn yet. */
  private uberPipeline: GPURenderPipeline | null = null;
```

(d) Statiche L76-93. Prima: il blocco da `/** Per-primitive-type WGSL shader sources.` fino a `static SHADER_SOURCE = '';`. Dopo:
```ts
  /**
   * Per-primitive-type WGSL modules. Keys are numeric primitive type IDs
   * (0 = quad … 5 = box shadow; 6, Light2D, has none).
   * `publishPrimitiveShaders()` in renderer.ts fills it with the composed
   * modules (render/primitive-shaders.ts: prelude + library + wrappers) and
   * recomposes it IN PLACE on a shader hot-reload, so LightGroupsPass, which
   * holds this object, sees the new text. Set before calling `setup()`.
   *
   * For backward compatibility, SHADER_SOURCE is also supported
   * (registers as type 0).
   */
  static SHADER_SOURCES: Record<number, string> = {};

  /**
   * Legacy single-shader source (registers as type 0).
   * Prefer SHADER_SOURCES for multi-type pipelines.
   */
  static SHADER_SOURCE = '';

  /**
   * The uber module (`composeUberModule`): the prelude, every library and
   * wrappers that switch on the primitive type. Required: `setup()` builds one
   * pipeline from it, with the transparent descriptor.
   */
  static UBER_SOURCE = '';
```

(e) Dopo L103-105, cioè dopo il `throw` "no shader sources set", aggiungi:
```ts
    if (!ForwardPass.UBER_SOURCE) {
      throw new Error('ForwardPass: no uber source set. Set UBER_SOURCE (renderer.ts: publishPrimitiveShaders) before calling setup()');
    }
```

(f) L201-243. Sostituisci l'intero loop, da `// --- Create opaque and transparent pipelines per primitive type ---` fino alla `}` che chiude il `for`, con:
```ts
    // Transparent: depth write disabled, alpha blend. The per-type transparent
    // pipelines and the uber pipeline share this descriptor exactly.
    const blendedTarget: GPUColorTargetState = {
      format,
      blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
    };
    const transparentPipeline = (module: GPUShaderModule): GPURenderPipeline => device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
      fragment: { module, entryPoint: 'fs_main', targets: [blendedTarget] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
    });

    // --- Create opaque and transparent pipelines per primitive type ---
    for (const [typeStr, source] of Object.entries(sources)) {
      const type = Number(typeStr);
      const module = device.createShaderModule({ code: source });

      // Opaque pipeline: depth write enabled, no blend
      const opaquePipeline = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
      });
      this.opaquePipelines.set(type, opaquePipeline);
      this.transparentPipelines.set(type, transparentPipeline(module));
    }

    // The uber module: every primitive type behind one pipeline, for the sorted
    // transparent draw. Built here, so every graph and every hot-reload probe
    // validates it; not drawn yet: the transparent sub-pass still draws per type.
    this.uberPipeline = transparentPipeline(device.createShaderModule({ code: ForwardPass.UBER_SOURCE }));
```

(g) L262, prima: `    // The matrix and the canvas size (line.wgsl turns pixel widths into NDC`. Dopo: `    // The matrix and the canvas size (line_vs turns pixel widths into NDC`.

(h) Guardia di `execute`, L276. Prima:
```ts
    if (this.opaquePipelines.size === 0 || !this.vertexBuffer || !this.indexBuffer || !this.bindGroup0 || !this.bindGroup1 || !bindGroup2 || !this.indirectBuffer) return;
```
Dopo:
```ts
    if (this.opaquePipelines.size === 0 || !this.uberPipeline || !this.vertexBuffer || !this.indexBuffer || !this.bindGroup0 || !this.bindGroup1 || !bindGroup2 || !this.indirectBuffer) return;
```
La lettura serve anche a `noUnusedLocals`: un campo privato che viene solo scritto dà TS6133. Il Task 19 la conserva.

(i) `destroy()`, dopo `this.transparentPipelines.clear();` (L398) aggiungi `    this.uberPipeline = null;`.

- [ ] **Step 5: Esegui il test: deve passare**

Run: `npx --prefix ts vitest run --root ts src/render/passes/forward-pass.test.ts`
Expected: PASS, tutti i test del file.

- [ ] **Step 6: Riscrivi il test di `LIT_PRIMITIVE_TYPES` in `light-groups.test.ts`**

(a) Import, L1-3. Prima:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deriveLightGroups, receiverLayer, LIT_PRIMITIVE_TYPES, type LightGroupsInput } from './light-groups';
```
Dopo:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { deriveLightGroups, receiverLayer, LIT_PRIMITIVE_TYPES, type LightGroupsInput } from './light-groups';
import { PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule } from './primitive-shaders';
import { loadPrimitivePieces } from './primitive-pieces.fixture';
import { bindingDecls, reachableFrom, stripComments } from '../shaders/wgsl-analysis';
```

(b) L165-176. Prima: l'intero test `it('LIT_PRIMITIVE_TYPES are exactly the types whose registered shader declares @group(2)', () => { … });`. Dopo:
```ts
  it('LIT_PRIMITIVE_TYPES come from PRIMITIVE_LIBRARIES: quad and gradient', () => {
    expect([...LIT_PRIMITIVE_TYPES]).toEqual(PRIMITIVE_LIBRARIES.filter((l) => l.lit).map((l) => l.type));
    expect([...LIT_PRIMITIVE_TYPES]).toEqual([0, 4]);
  });

  it('LIT_PRIMITIVE_TYPES are exactly the types whose composed fs_main reaches the light buffer', () => {
    // Every composed module DECLARES group 2 (the prelude does): what makes a
    // type lit is that its fs_main reaches it. Names from the prelude's own
    // group-2 declarations, plus the helper that reads the group table.
    const pieces = loadPrimitivePieces();
    const prelude = stripComments(pieces.prelude);
    const light = [...bindingDecls(prelude).filter((b) => b.group === 2).map((b) => b.name), 'lightGroupOf'];
    expect(light).toHaveLength(4);
    const reaches = (src: string, entry: string): boolean => {
      const reached = reachableFrom(src, entry);
      return light.some((name) => reached.has(name));
    };
    const modules = composeTypeModules(pieces);
    expect(PRIMITIVE_LIBRARIES.filter((l) => reaches(stripComments(modules[l.type]), 'fs_main')).map((l) => l.type))
      .toEqual([...LIT_PRIMITIVE_TYPES]);
    // The uber draws every type through its <prefix>_fs: the same rule per case.
    const uber = stripComments(composeUberModule(pieces));
    expect(PRIMITIVE_LIBRARIES.filter((l) => reaches(uber, `${l.prefix}fs`)).map((l) => l.type))
      .toEqual([...LIT_PRIMITIVE_TYPES]);
  });

  it('renderer.ts registers each library piece under its own type, and composes in place', () => {
    const renderer = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
    const files = new Map<string, string>();
    for (const m of renderer.matchAll(/import (\w+) from '\.\/shaders\/primitives\/([\w-]+)\.wgsl\?raw'/g)) files.set(m[1], m[2]);
    const block = /const primitivePieces: PrimitivePieces = \{\s*prelude: (\w+),\s*libraries: \{([^}]*)\}/.exec(renderer);
    expect(block, 'the primitivePieces literal in renderer.ts').not.toBeNull();
    expect(files.get(block![1])).toBe('prelude');
    const registered = [...block![2].matchAll(/(\d+):\s*(\w+)/g)].map((m) => [Number(m[1]), files.get(m[2])] as const);
    expect(registered).toEqual(PRIMITIVE_LIBRARIES.map((l) => [l.type, l.name] as const));
    // In place, never reassigned: LightGroupsPass and the probes hold the object.
    expect(renderer).toMatch(/Object\.assign\(ForwardPass\.SHADER_SOURCES, composeTypeModules\(primitivePieces\)\)/);
    expect(renderer).toMatch(/ForwardPass\.UBER_SOURCE = composeUberModule\(primitivePieces\)/);
    expect(renderer).not.toMatch(/ForwardPass\.SHADER_SOURCES\s*=(?!=)/);
  });
```
Il test a L178-189 (classificazione come `cull.wgsl`) resta invariato.

- [ ] **Step 7: Esegui il test: deve fallire sulla registrazione**

Run: `npx --prefix ts vitest run --root ts src/render/light-groups.test.ts`

Expected: FAIL con un solo test rosso, `renderer.ts registers each library piece under its own type, and composes in place`, su `expected null not to be null`: `renderer.ts` ha ancora il letterale `ForwardPass.SHADER_SOURCES = {…}` e gli import dei sei file.

Gli altri due test passano già. `LIT_PRIMITIVE_TYPES` vale ancora il letterale `[0, 4]`, cioè il valore della tabella, e la raggiungibilità viene dai pezzi del Task 5.

- [ ] **Step 8: Ricava `LIT_PRIMITIVE_TYPES` dalla tabella (`light-groups.ts`)**

(a) Dopo L1 (`import { extractFrustumPlanes, isSphereInFrustum } from '../camera';`) aggiungi:
```ts
import { PRIMITIVE_LIBRARIES } from './primitive-shaders';
```

(b) L72-78. Prima:
```ts
/**
 * The primitive types whose shader samples the light buffer (declares
 * `@group(2)`): Quad and Gradient. A receiver of any other type is drawn unlit
 * whatever its flag, so its layer needs no group. `light-groups.test.ts`
 * checks this list against the shaders `renderer.ts` registers.
 */
export const LIT_PRIMITIVE_TYPES: readonly number[] = [0, 4];
```
Dopo:
```ts
/**
 * The primitive types whose shader samples the light buffer: the `lit` rows of
 * PRIMITIVE_LIBRARIES (Quad and Gradient), whose `<prefix>_fs` calls the
 * prelude's `applyLighting`. A receiver of any other type is drawn unlit
 * whatever its flag, so its layer needs no group. `light-groups.test.ts`
 * checks the table against what the composed modules' fs_main reaches.
 */
export const LIT_PRIMITIVE_TYPES: readonly number[] = PRIMITIVE_LIBRARIES.filter((l) => l.lit).map((l) => l.type);
```

- [ ] **Step 9: Collega i pezzi in `renderer.ts` e aggiorna i JSDoc di `recompileShader`**

(a) L1-6. Prima:
```ts
import shaderCode from './shaders/basic.wgsl?raw';
import lineShaderCode from './shaders/line.wgsl?raw';
import msdfShaderCode from './shaders/msdf-text.wgsl?raw';
import gradientShaderCode from './shaders/gradient.wgsl?raw';
import boxShadowShaderCode from './shaders/box-shadow.wgsl?raw';
import bezierShaderCode from './shaders/bezier.wgsl?raw';
```
Dopo:
```ts
import preludeShaderCode from './shaders/primitives/prelude.wgsl?raw';
import quadShaderCode from './shaders/primitives/quad.wgsl?raw';
import lineShaderCode from './shaders/primitives/line.wgsl?raw';
import msdfShaderCode from './shaders/primitives/msdf-text.wgsl?raw';
import bezierShaderCode from './shaders/primitives/bezier.wgsl?raw';
import gradientShaderCode from './shaders/primitives/gradient.wgsl?raw';
import boxShadowShaderCode from './shaders/primitives/box-shadow.wgsl?raw';
```

(b) L24. Prima: `import { ForwardPass } from './render/passes/forward-pass';`. Dopo:
```ts
import { ForwardPass } from './render/passes/forward-pass';
import { composeTypeModules, composeUberModule, type PrimitivePieces } from './render/primitive-shaders';
```

(c) Dopo L58 (`const INDIRECT_BUFFER_SIZE = TOTAL_DRAW_BUCKETS * 5 * 4;`) inserisci:
```ts

/**
 * The primitive shader pieces (design 2026-09-27 §3): the prelude and one
 * library per primitive type, keyed like PRIMITIVE_LIBRARIES. The GPU never
 * compiles a piece alone, only what `publishPrimitiveShaders` composes. The
 * hot-reload slots write into this object.
 */
const primitivePieces: PrimitivePieces = {
  prelude: preludeShaderCode,
  libraries: {
    0: quadShaderCode,          // Quad
    1: lineShaderCode,          // Line
    2: msdfShaderCode,          // SDFGlyph (MSDF text)
    3: bezierShaderCode,        // BezierPath
    4: gradientShaderCode,      // Gradient
    5: boxShadowShaderCode,     // BoxShadow
  },
};

/**
 * Compose the six per-type modules and the uber module from `primitivePieces`.
 * `ForwardPass.SHADER_SOURCES` is updated IN PLACE: LightGroupsPass (the
 * occluder pipelines) and the hot-reload probes hold that object. Pure
 * concatenation: it cannot throw.
 */
function publishPrimitiveShaders(): void {
  Object.assign(ForwardPass.SHADER_SOURCES, composeTypeModules(primitivePieces));
  ForwardPass.UBER_SOURCE = composeUberModule(primitivePieces);
}
```

(d) L123. Prima: `  recompileShader(passName: string, shaderCode: string): void;`. Dopo:
```ts
  /**
   * Dev tool: replace one shader, and rebuild what uses it once the GPU has
   * validated it. For a primitive ('basic'/'quad', 'line', 'msdf-text',
   * 'bezier', 'gradient', 'box-shadow') the source is that primitive's LIBRARY
   * piece (shaders/primitives/<name>.wgsl: prefixed functions, no bindings, no
   * entry points), not a whole module: the renderer composes it with the prelude.
   */
  recompileShader(passName: string, shaderCode: string): void;
```

(e) L300-307. Prima:
```ts
  ForwardPass.SHADER_SOURCES = {
    0: shaderCode,              // Quad
    1: lineShaderCode,          // Line
    2: msdfShaderCode,          // SDFGlyph (MSDF text)
    3: bezierShaderCode,        // BezierPath
    4: gradientShaderCode,      // Gradient
    5: boxShadowShaderCode,     // BoxShadow
  };
```
Dopo:
```ts
  // The six per-type modules and the uber, composed from the pieces, before
  // RenderGraphHost builds the first graph: ForwardPass.setup needs both.
  publishPrimitiveShaders();
```

(f) L546-555. Prima: il commento `// A primitive module has two users: …` e `const forwardSlot = (i: number): ShaderSlot => ({ … });`. Dopo:
```ts
  // A library piece has two users: ForwardPass (its per-type module through
  // fs_main, three groups, and the uber module) and the occluder pipelines of
  // LightGroupsPass (fs_occluder, two groups). The write recomposes every
  // module in place, and the probe compiles all of them, so an edit that
  // breaks only the occluder entry point or only the uber is caught here too.
  const forwardSlot = (type: number): ShaderSlot => ({
    read: () => primitivePieces.libraries[type],
    write: (src) => {
      primitivePieces.libraries[type] = src;
      publishPrimitiveShaders();
    },
    probe: probe(() => [new ForwardPass(), new LightGroupsPass(ForwardPass.SHADER_SOURCES)]),
    usedBy: inEveryMode,
  });
```
Le voci `basic`/`quad`/`line`/`'msdf-text'`/`bezier`/`gradient`/`'box-shadow'` di `shaderSlots` (L564-570) restano come sono: puntano a `forwardSlot(0..5)`.

(g) L981-998. Prima: i sei `import.meta.hot.accept('./shaders/{basic,line,msdf-text,gradient,box-shadow,bezier}.wgsl?raw', …)`. Dopo:
```ts
    // The primitives' library pieces. The prelude has no slot yet: an edit to
    // it reloads the page.
    import.meta.hot.accept('./shaders/primitives/quad.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('basic', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/line.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('line', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/msdf-text.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('msdf-text', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/gradient.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('gradient', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/box-shadow.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('box-shadow', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/bezier.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('bezier', mod.default);
    });
```
Gli accept dal `cull` in poi (L999-1034) restano invariati.

(h) `ts/src/hyperion.ts`, L745. Prima: `  /** Recompile a named shader pass with new WGSL source (dev tool). */`. Dopo:
```ts
  /**
   * Recompile a named shader with new WGSL source (dev tool). For a primitive
   * ('basic'/'quad', 'line', 'msdf-text', 'bezier', 'gradient', 'box-shadow')
   * the source is that primitive's library piece, not a whole module.
   */
```

- [ ] **Step 10: Esegui i test toccati, l'intera suite e il type-check**

Run: `npx --prefix ts vitest run --root ts src/render/light-groups.test.ts src/render/passes/forward-pass.test.ts`
Expected: PASS su entrambi i file.

Run: `npm --prefix ts test`
Expected: tutto verde. `occluder-seed-stage.test.ts`, `uniform-layout.test.ts` e `storage-budget.test.ts` leggono ancora i sei file vecchi, che esistono ancora, e passano come prima.

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Expected: nessun output.

- [ ] **Step 11: Commit**

```bash
git add ts/src/render/primitive-pieces.fixture.ts ts/src/render/passes/forward-pass.ts ts/src/render/passes/forward-pass.test.ts ts/src/render/light-groups.ts ts/src/render/light-groups.test.ts ts/src/renderer.ts ts/src/hyperion.ts
git commit -m "$(cat <<'EOF'
feat(5b): ForwardPass e renderer usano i moduli composti, LIT_PRIMITIVE_TYPES ricavato dalla tabella

La pipeline uber si costruisce, e quindi si valida con ogni grafo, ma non si disegna ancora.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 12: Riscrivi i controlli WGSL di `occluder-seed-stage.test.ts`**

(a) L1-7. Prima:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OccluderSeedStage, halfResolution } from './occluder-seed-stage';
import { ResourcePool } from '../resource-pool';
import { JFA_FORMAT } from '../formats';
import type { FrameState } from '../render-pass';
import basicShaderSource from '../../shaders/basic.wgsl?raw';
```
Dopo:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OccluderSeedStage, halfResolution } from './occluder-seed-stage';
import { ResourcePool } from '../resource-pool';
import { JFA_FORMAT } from '../formats';
import type { FrameState } from '../render-pass';
import { PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule, type PrimitiveLibrary } from '../primitive-shaders';
import { loadPrimitivePieces } from '../primitive-pieces.fixture';
import { callGraph, functionBody, reachableFrom, stripComments } from '../../shaders/wgsl-analysis';
```

(b) L151-206. Prima: dal `describe('basic.wgsl occluder entry', …)` fino alla fine del file. Dopo:
```ts
// ---------------------------------------------------------------------------
// The primitive modules are composed (render/primitive-shaders.ts). What every
// module shares lives once in the prelude and is checked there
// (forward-pass.test.ts checks that each module contains it verbatim); the
// generated wrappers are checked on each per-type module; the library's
// coverage function through the call graph.
const pieces = loadPrimitivePieces();
const prelude = stripComments(pieces.prelude);
const typeModules = composeTypeModules(pieces);
const perType = PRIMITIVE_LIBRARIES.map(
  (l): [string, PrimitiveLibrary, string] => [l.name, l, stripComments(typeModules[l.type])],
);

/** A function's body; throws when the function is missing. */
function body(src: string, fn: string): string {
  const text = functionBody(src, fn);
  if (text === null) throw new Error(`fn ${fn} not found`);
  return text;
}

describe('the prelude: the occluder switch, the castsShadow bit, the occluder layers', () => {
  it('declares OCCLUDER_PASS, default false: the ForwardPass pipelines fold the check away', () => {
    expect(prelude).toMatch(/override OCCLUDER_PASS\s*:\s*bool\s*=\s*false;/);
  });

  it('agrees with Rust on the castsShadow bit of renderMeta', () => {
    const rust = readFileSync(new URL('../../../../crates/hyperion-core/src/components.rs', import.meta.url), 'utf8');
    const rustBit = Number(/RENDER_META_CASTS_SHADOW_BIT: u32 = 1 << (\d+);/.exec(rust)?.[1]);
    const wgslBit = Number(/const CASTS_SHADOW_BIT\s*:\s*u32\s*=\s*1u << (\d+)u;/.exec(prelude)?.[1]);
    expect(rustBit).toBe(9);
    expect(wgslBit).toBe(rustBit);
  });

  // Light layers (design 2026-09-26): an occluder shadows only the layers in
  // its mask, so a set's seed holds only its casters. The set's layers ride in
  // the camera uniform, which every module shares with ForwardPass.
  it('carries the set layers in the camera uniform; castsInto reads the mask, 0 = every layer', () => {
    expect(prelude).toMatch(/struct CameraUniform\s*\{\s*viewProjection: mat4x4f,[^}]*occluderLayers: u32,/);
    expect(prelude).toMatch(/fn castsInto\(meta1: u32, layers: u32\) -> bool/);
    const casts = body(prelude, 'castsInto');
    expect(casts).toMatch(/select\(meta1 >> 16u, 0xFFFFu, \(meta1 >> 16u\) == 0u\)/);
    expect(casts).toContain('CASTS_SHADOW_BIT');
  });
});

// Every primitive ForwardPass draws must cast its own shape (design §6.2).
// Light2D (type 6) has no module and is not an occluder.
describe('every per-type module can cast its shape', () => {
  it('the composer yields one module per type 0-5, and none for Light2D', () => {
    expect(Object.keys(typeModules).map(Number)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(typeModules[6]).toBeUndefined();
  });

  it('OccluderSeedStage builds an occluder pipeline from every composed module, and none from the uber', () => {
    const { pipelines } = setUp(composeTypeModules(pieces));
    expect(pipelines).toHaveLength(6);
    for (const p of pipelines) {
      expect(p.vertex.constants).toEqual({ OCCLUDER_PASS: 1 });
      expect(p.fragment?.entryPoint).toBe('fs_occluder');
    }
    // The stage picks modules by the TEXT `fn fs_occluder`: a piece whose
    // comment named it would make the uber look like a caster, and its
    // pipeline fail (the lit graph rejected, lighting silently off).
    expect(setUp({ 0: composeUberModule(pieces) }).pipelines).toHaveLength(0);
  });

  it.each(perType)('%s: vs_main drops non-casters when OCCLUDER_PASS is set, then tags the type', (_name, l, src) => {
    const vs = body(src, 'vs_main');
    expect(vs).toMatch(/if \(OCCLUDER_PASS && !castsInto\(renderMeta\[entityIdx \* 2u \+ 1u\], camera\.occluderLayers\)\)\s*\{\s*return culledVertex\(\);\s*\}/);
    expect(vs).toMatch(new RegExp(`out\\.primType\\s*=\\s*${l.type}u?\\s*;`));
    expect(callGraph(src).get('vs_main')?.has(`${l.prefix}vs`)).toBe(true);
  });

  it.each(perType)('%s: fs_occluder is an entry point, and it and fs_main reach the same coverage function', (_name, l, src) => {
    expect(typeModules[l.type]).toMatch(/@fragment\s+fn fs_occluder\s*\(/);
    const graph = callGraph(src);
    expect(graph.get('fs_main')?.has(`${l.prefix}fs`)).toBe(true);
    expect(graph.get('fs_occluder')?.has(`${l.prefix}occluder`)).toBe(true);
    // One coverage function behind both, so the shadow is exactly what is drawn.
    const shade = `${l.prefix}shade`;
    expect(reachableFrom(src, 'fs_main').has(shade)).toBe(true);
    expect(reachableFrom(src, 'fs_occluder').has(shade)).toBe(true);
  });
});
```
Le righe da L8 a L149 (i test sugli stub, `setUp`, `halfResolution`) restano invariate. Il nuovo codice usa la stessa `setUp` di L17.

Run: `npx --prefix ts vitest run --root ts src/render/passes/occluder-seed-stage.test.ts`
Expected: PASS. È una riscrittura di guardie esistenti: nessun codice di produzione cambia, e le guardie passano dai file ai moduli composti.

- [ ] **Step 13: Riscrivi `uniform-layout.test.ts` e `storage-budget.test.ts`**

Sostituisci l'intero `ts/src/shaders/uniform-layout.test.ts` con:
```ts
import { describe, it, expect } from 'vitest';
import { composedPrimitiveModules } from '../render/primitive-pieces.fixture';

// Every TypeScript writer of a uniform buffer packs its fields back to back:
// f32[0], f32[1], ... WGSL does not. A vec2 is 8-aligned and a vec3/vec4/mat is
// 16-aligned, so a `texelSize: vec2f` after a single f32 lands 4 bytes later
// than the writer puts it. The struct also grows past the buffer, which fails
// validation at DRAW time. That is invisible headless, and it dropped every
// frame of the outline chain (jfa.wgsl, then outline-composite.wgsl) until
// 2026-09-26.
//
// The bug has one signature: implicit padding BETWEEN two members. This test
// computes every uniform struct's layout with the real WGSL rules and rejects
// it. Trailing padding (struct size rounded up) is fine: the writers allocate
// the rounded size, and pad fields at the end are harmless.
//
// Two sources. The top-level modules, by glob: './*.wgsl' does not descend
// into primitives/, whose pieces are not modules. And the seven modules the
// composer makes of those pieces (render/primitive-shaders.ts), six per type
// and the uber: what the GPU compiles.

const shaders = import.meta.glob('./*.wgsl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const composed = composedPrimitiveModules();

type Layout = { align: number; size: number };

const SCALARS: Record<string, Layout> = {
  f32: { align: 4, size: 4 }, u32: { align: 4, size: 4 }, i32: { align: 4, size: 4 },
};

function stripComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, '');
}

function structs(src: string): Map<string, Array<[string, string]>> {
  const out = new Map<string, Array<[string, string]>>();
  for (const m of stripComments(src).matchAll(/struct\s+(\w+)\s*\{([^}]*)\}/g)) {
    // Split at top-level commas only: `array<vec4f, 6>` has one inside.
    const fields: string[] = [];
    let depth = 0; let cur = '';
    for (const ch of m[2]) {
      if (ch === '<') depth++;
      if (ch === '>') depth--;
      if (ch === ',' && depth === 0) { fields.push(cur); cur = ''; } else cur += ch;
    }
    fields.push(cur);
    const members = fields
      .map((f) => /(?:@\w+(?:\([^)]*\))?\s*)*(\w+)\s*:\s*(.+)/s.exec(f.trim()))
      .filter((mm): mm is RegExpExecArray => mm !== null)
      .map((mm) => [mm[1], mm[2].trim()] as [string, string]);
    out.set(m[1], members);
  }
  return out;
}

function roundUp(n: number, k: number): number {
  return Math.ceil(n / k) * k;
}

function layoutOf(type: string, defs: Map<string, Array<[string, string]>>): Layout {
  const t = type.replace(/\s+/g, '');
  if (SCALARS[t]) return SCALARS[t];
  const vec = /^vec([234])(?:f|u|i|<(?:f32|u32|i32)>)$/.exec(t);
  if (vec) {
    const n = Number(vec[1]);
    return { align: n === 2 ? 8 : 16, size: n * 4 };
  }
  const mat = /^mat([234])x([234])(?:f|<f32>)$/.exec(t);
  if (mat) {
    const cols = Number(mat[1]); const rows = Number(mat[2]);
    const col = layoutOf(`vec${rows}f`, defs);
    return { align: col.align, size: cols * roundUp(col.size, col.align) };
  }
  const arr = /^array<(.+),(\w+)>$/.exec(t);
  if (arr) {
    const el = layoutOf(arr[1], defs);
    const n = Number(arr[2]);
    if (!Number.isFinite(n)) throw new Error(`array length '${arr[2]}' is not a literal`);
    return { align: el.align, size: n * roundUp(el.size, el.align) };
  }
  const members = defs.get(t);
  if (!members) throw new Error(`unknown type '${type}'`);
  return structLayout(members, defs).layout;
}

function structLayout(members: Array<[string, string]>, defs: Map<string, Array<[string, string]>>) {
  let offset = 0; let align = 1; const gaps: string[] = [];
  for (const [name, type] of members) {
    const l = layoutOf(type, defs);
    const at = roundUp(offset, l.align);
    if (at !== offset) gaps.push(`${name} at ${at}, not ${offset}`);
    offset = at + l.size; align = Math.max(align, l.align);
  }
  return { layout: { align, size: roundUp(offset, align) }, gaps };
}

function uniformStructsOf(modules: Record<string, string>) {
  return Object.entries(modules).flatMap(([file, src]) => {
    const defs = structs(src);
    return [...stripComments(src).matchAll(/var<uniform>\s+\w+\s*:\s*(\w+)\s*;/g)]
      .map((m) => ({ file, struct: m[1], members: defs.get(m[1]), defs }))
      .filter((u) => u.members);
  });
}

const topLevelUniforms = uniformStructsOf(shaders);
const composedUniforms = uniformStructsOf(composed);

describe('uniform structs have no implicit padding between members', () => {
  it('finds the uniform structs of the top-level modules, and no piece', () => {
    expect(Object.keys(shaders).filter((f) => f.includes('primitives/'))).toEqual([]);
    expect(topLevelUniforms.length).toBeGreaterThanOrEqual(14);
  });

  it('finds CameraUniform and LightingUniform in each of the seven composed modules', () => {
    expect(Object.keys(composed)).toHaveLength(7);
    for (const label of Object.keys(composed)) {
      expect(composedUniforms.filter((u) => u.file === label).map((u) => u.struct).sort(), label)
        .toEqual(['CameraUniform', 'LightingUniform']);
    }
  });

  it.each([...topLevelUniforms, ...composedUniforms].map((u) => [`${u.file} ${u.struct}`, u] as const))('%s', (_label, u) => {
    expect(structLayout(u.members!, u.defs).gaps).toEqual([]);
  });
});
```

Sostituisci l'intero `ts/src/shaders/storage-budget.test.ts` con:
```ts
import { describe, it, expect } from 'vitest';
import { composedPrimitiveModules } from '../render/primitive-pieces.fixture';

// `requestDevice` asks for no limits, so every stage gets the spec default of
// 8 storage buffers. Going over it does not throw: the pipeline comes back
// invalid and the error arrives asynchronously, which is how cull.wgsl sat at
// 9 from 4ea6cb5 to 2026-09-26 without anyone noticing. The limit is per shader
// stage, so counting per module is a conservative upper bound. A module that
// needs more than 8 and splits them across stages must refine this check, not
// delete it.
//
// The top-level modules by glob ('./*.wgsl' does not descend into primitives/,
// whose pieces are not modules), plus the seven composed primitive modules
// (render/primitive-shaders.ts) the GPU really compiles, the uber included.
const SPEC_MIN_STORAGE_BUFFERS_PER_STAGE = 8;

const shaders = import.meta.glob('./*.wgsl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const composed = composedPrimitiveModules();

function storageBufferCount(wgsl: string): number {
  return (wgsl.replace(/\/\/[^\n]*/g, '').match(/var<storage\b/g) ?? []).length;
}

describe('storage-buffer budget of every shader', () => {
  it('counts storage declarations, and not the ones in comments', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `@group(0) @binding(${i}) var<storage, read> b${i}: array<u32>;`).join('\n');
    expect(storageBufferCount(nine)).toBe(9);
    expect(storageBufferCount('// var<storage, read> gone: array<u32>;')).toBe(0);
  });

  it('finds the top-level shaders, and no piece', () => {
    expect(Object.keys(shaders).filter((f) => f.includes('primitives/'))).toEqual([]);
    expect(Object.keys(shaders).length).toBeGreaterThanOrEqual(16);
  });

  it('composes the seven primitive modules: six per type and the uber', () => {
    expect(Object.keys(composed)).toHaveLength(7);
  });

  it.each(Object.entries({ ...shaders, ...composed }))('%s declares at most 8 storage buffers', (_file, source) => {
    expect(storageBufferCount(source)).toBeLessThanOrEqual(SPEC_MIN_STORAGE_BUFFERS_PER_STAGE);
  });
});
```

Run: `npx --prefix ts vitest run --root ts src/shaders/uniform-layout.test.ts src/shaders/storage-budget.test.ts`

Expected: PASS. I sei file vecchi sono ancora al primo livello: 22 file e 22 struct nel glob, sopra le soglie 16 e 14. I 7 moduli composti aggiungono 14 casi uniform e 7 casi storage.

- [ ] **Step 14: Verifica che le guardie mordano (mutazioni temporanee)**

1. In fondo a `ts/src/shaders/primitives/prelude.wgsl` aggiungi la riga `// fn fs_occluder`.
   - Run: `npx --prefix ts vitest run --root ts src/render/passes/occluder-seed-stage.test.ts`
   - Expected: FAIL su `OccluderSeedStage builds an occluder pipeline from every composed module, and none from the uber` (1 pipeline invece di 0).
   - Ripristina: `git checkout -- ts/src/shaders/primitives/prelude.wgsl`.
2. In `ts/src/shaders/primitives/quad.wgsl`, nel corpo di `quad_occluder`, sostituisci la chiamata `quad_shade(in)` con `quad_fs(in)`.
   - Run: `npx --prefix ts vitest run --root ts src/render/passes/forward-pass.test.ts`
   - Expected: FAIL su `quad: fs_main reaches group 2 exactly when the type is lit; fs_occluder and vs_main never` e su `quad: vs_main, fs_main and fs_occluder stay inside their layouts`. `fs_occluder` raggiunge il gruppo 2, e il layout dell'occluder ha solo i gruppi 0-1: è il gotcha "group 2 in fs_main only" di CLAUDE.md.
   - Ripristina: `git checkout -- ts/src/shaders/primitives/quad.wgsl`.
3. Run: `git status --short`. Expected: nessuna modifica sotto `ts/src/shaders/primitives/`.

- [ ] **Step 15: Elimina i sei shader vecchi e aggiorna i commenti che li nominano**

```bash
git rm ts/src/shaders/basic.wgsl ts/src/shaders/line.wgsl ts/src/shaders/msdf-text.wgsl ts/src/shaders/bezier.wgsl ts/src/shaders/gradient.wgsl ts/src/shaders/box-shadow.wgsl
```

Commenti da aggiornare:

`ts/src/render/passes/occluder-seed-stage.ts`
- L23. Prima: `/** CameraUniform in every primitive shader: viewProjection + occluderLayers + viewport size + pad. */`. Dopo: `/** CameraUniform (the prelude of every composed primitive module): viewProjection + occluderLayers + viewport size + pad. */`
- L30-35. Prima:
  ```ts
   * It does not use a shader of its own. It runs each primitive's OWN module
   * through `fs_occluder`, which reuses the primitive's coverage: a sprite casts
   * the shadow of the texels it draws, a bezier of its curve. The pipelines set
   * `OCCLUDER_PASS = true`; the vertex stage then drops every entity that casts
   * no shadow or whose mask misses the set's layers (`castsInto`, in each
   * primitive shader). A primitive with no `fs_occluder` casts nothing.
  ```
  Dopo:
  ```ts
   * It does not use a shader of its own. It runs each primitive's OWN composed
   * module (render/primitive-shaders.ts: prelude + library + wrappers) through
   * `fs_occluder`, which reuses the library's coverage: a sprite casts the
   * shadow of the texels it draws, a bezier of its curve. The pipelines set
   * `OCCLUDER_PASS = true`; the generated `vs_main` then drops every entity that
   * casts no shadow or whose mask misses the set's layers (`castsInto`, in the
   * prelude). A module with no `fs_occluder` (the uber) casts nothing.
  ```
- L56-57. Prima:
  ```ts
     * @param shaderSources primitive type → WGSL module, the same map ForwardPass
     *   uses (`ForwardPass.SHADER_SOURCES`), read at `setup()`.
  ```
  Dopo:
  ```ts
     * @param shaderSources primitive type → composed WGSL module, the same map
     *   ForwardPass uses (`ForwardPass.SHADER_SOURCES`, recomposed in place on a
     *   hot-reload), read at `setup()`.
  ```
- L115. Prima: `      // pixel-wide line (line.wgsl) keeps the NDC footprint it is drawn with.`. Dopo: `      // pixel-wide line (line_vs) keeps the NDC footprint it is drawn with.`

`ts/src/render/primitive-bindings.ts`, L14-15. Prima:
```ts
    // CameraUniform is 80 bytes in every primitive shader (viewProjection +
    // occluderLayers + the viewport size line.wgsl reads + a pad). Declared, so a smaller buffer fails when the bind
```
Dopo:
```ts
    // CameraUniform is 80 bytes, declared once in the prelude (viewProjection +
    // occluderLayers + the viewport size line_vs reads + a pad). Declared, so a smaller buffer fails when the bind
```

`ts/src/demo/primitives.ts`, L52. Prima: `      // Rounded, and crisp: box-shadow.wgsl rounds the corners only in its`. Dopo: `      // Rounded, and crisp: shaders/primitives/box-shadow.wgsl rounds the corners only in its`.

Controllo che nessun `.ts` nomini più un file eliminato (`debug-line.wgsl`, che il pattern `line\.wgsl` catturerebbe in `renderer.ts` e `debug-line-pass.ts`, non è tra i sei eliminati e resta dov'è: lo escludo):

Run: `grep -rn -E "(basic|line|msdf-text|bezier|gradient|box-shadow)\.wgsl" ts/src --include="*.ts" | grep -v "primitives/" | grep -v 'debug-line\.wgsl'`
Expected: nessun output.

- [ ] **Step 16: Suite completa e type-check**

Run: `npm --prefix ts test`
Expected: tutto verde. Il glob di primo livello ora vede 16 file e 14 struct uniform, cioè le soglie esatte.

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Expected: nessun output.

- [ ] **Step 17: Commit**

```bash
git add ts/src/render/passes/occluder-seed-stage.test.ts ts/src/shaders/uniform-layout.test.ts ts/src/shaders/storage-budget.test.ts ts/src/render/passes/occluder-seed-stage.ts ts/src/render/primitive-bindings.ts ts/src/demo/primitives.ts
git status --short   # atteso: i 6 .wgsl come D, i 6 file sopra come M, nient'altro
git commit -m "$(cat <<'EOF'
refactor(5b): test sul testo WGSL riscritti sui moduli composti, eliminati i sei shader per file

Preludio controllato una volta, wrapper su ogni modulo per tipo, librerie tramite il grafo delle chiamate; i controlli sul gruppo 2 diventano raggiungibilità e binding contro layout.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

**Note:**
- Questo task non ha uno step GPU. La validazione dei 7 moduli composti (Chrome `getCompilationInfo` + pipeline in un error scope, naga) e gli stati e i pixel contro la baseline sono il cancello del Task 8.
- Fino al Task 7 il preludio non ha né slot né accept. Una modifica a `prelude.wgsl` con il dev server aperto ricarica la pagina. Su questa macchina la ricarica perde l'initScript low-power e va rifatta la `navigate_page` con l'initScript.
- `recompileShader('basic' | 'quad' | …)` riceve ora un pezzo di libreria. Un modulo completo passato di lì duplica le dichiarazioni del preludio e viene rifiutato dal probe.

### Task 7: hot-reload dei pezzi (`reloadShaders`, `PieceReloadCollector`)

I sette pezzi (preludio + sei librerie) diventano sette slot HMR. Un pezzo salvato non va più dritto a `reloadShader`: passa da un raccoglitore con debounce finale di 50 ms, e la finestra raccolta arriva a `GraphRequests.reloadShaders`, che nella STESSA finestra sincrona prova l'unione e poi ogni voce da sola, e decide con le regole della spec §3.3 (punti 2-4). `recompileShader(nome, src)` resta a slot singolo e senza debounce; `basic` diventa un alias di `quad`. La guardia sul pezzo vuoto sta nella closure del probe degli slot di pezzo e guarda le statiche GREZZE. Il test di `graph-requests.test.ts:175-191`, che simulava una guardia dentro `ForwardPass` che non esiste, viene corretto.

Le righe di `renderer.ts` citate qui sono quelle di `72c0f7e`: il Task 6 le sposta, quindi gli step indicano sempre anche un ancoraggio testuale.

**Files:**
- Create: `ts/src/render/piece-reload-collector.ts`
- Create: `ts/src/render/piece-reload-collector.test.ts`
- Modify: `ts/src/render/graph-requests.ts` — doc di `ShaderSlot.probe` (L17-21), tipi e helper dopo `ReloadOutcome` (L37), JSDoc della classe (L51-68), `reloadShaders` + `probeTogether` subito dopo `reloadShader` (che finisce a L199)
- Modify: `ts/src/render/graph-requests.test.ts` — import (L2), `setup` (L53-63), test del file vuoto (L175-191), due `describe` nuovi in coda
- Modify: `ts/src/renderer.ts` — import di `./render/primitive-shaders`; helper degli slot primitivi prima di `const shaderSlots` (su `72c0f7e`: L546-555); voci primitive dentro `shaderSlots` (L564-570); `recompileShader` (L746-763); JSDoc di `recompileShader` nell'interfaccia `Renderer` (quello scritto dal Task 6, Step 9(d); su `72c0f7e` la firma era a L123); `accept` dei pezzi nel blocco `if (import.meta.hot)` (L979-1035)
- Modify: `ts/src/hyperion.ts` — JSDoc di `recompileShader` (quello scritto dal Task 6, Step 9(h); L745 su `72c0f7e`)

**Interfaces:**
- Consumes:
  - da `ts/src/render/primitive-shaders.ts` (Task 5): `PRIMITIVE_LIBRARIES: readonly PrimitiveLibrary[]` (tipi 0-5, `name` ∈ `'quad' | 'line' | 'msdf-text' | 'bezier' | 'gradient' | 'box-shadow'`), `interface PrimitivePieces { prelude: string; libraries: Record<number, string> }`;
  - da `ts/src/renderer.ts` dopo il Task 6: i sette import `./shaders/primitives/<pezzo>.wgsl?raw`, `const primitivePieces: PrimitivePieces`, `function publishPrimitiveShaders(): void` (ricompone sul posto `ForwardPass.SHADER_SOURCES` e `ForwardPass.UBER_SOURCE`);
  - esistenti: `GraphRequests`, `ShaderSlot`, `ReloadOutcome` (`graph-requests.ts`), `GpuValidation`, `RequestResult` (`graph-host.ts`), l'helper `probe(make)` e i predicati `inEveryMode` di `createRenderer`.
- Produces:
  - `GraphRequests.reloadShaders(entries: ReadonlyArray<{ name: string; code: string }>): Promise<Map<string, ReloadOutcome>>`
  - `export interface PieceReloadTimers { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void }`
  - `export class PieceReloadCollector { constructor(apply: (entries: Array<{ name: string; code: string }>) => Promise<unknown>, delayMs = 50, timers: PieceReloadTimers = DEFAULT_TIMERS); offer(name: string, code: string): void; flushNow(): void }`
  - `export function assertPiecesNotEmpty(pieces: PrimitivePieces): void` — lancia `Error('Shader piece "<nome>" is empty')`
  - slot HMR `prelude`, `quad`, `line`, `msdf-text`, `bezier`, `gradient`, `box-shadow`; `recompileShader('basic', src)` ≡ `recompileShader('quad', src)`
  - righe di log: `[Hyperion] Shader "quad" hot-reloaded`, `[Hyperion] Shaders "prelude", "quad" hot-reloaded`, `[Hyperion] Shaders "quad", "line" compile alone but not together — keeping the previous sources:`

- [ ] **Step 1: Scrivi i test del raccoglitore e della guardia**

Crea `ts/src/render/piece-reload-collector.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PieceReloadCollector, assertPiecesNotEmpty, type PieceReloadTimers } from './piece-reload-collector';
import { PRIMITIVE_LIBRARIES, type PrimitivePieces } from './primitive-shaders';

type Entries = Array<{ name: string; code: string }>;

/** Timers the test fires by hand; `armed` shows what is waiting and for how long. */
function manualTimers() {
  const armed = new Map<number, { fn: () => void; ms: number }>();
  let ids = 0;
  const timers: PieceReloadTimers = {
    set: (fn, ms) => {
      armed.set(++ids, { fn, ms });
      return ids;
    },
    clear: (handle) => {
      armed.delete(handle as number);
    },
  };
  return {
    timers,
    armed,
    fire(): void {
      const due = [...armed.values()];
      armed.clear();
      for (const t of due) t.fn();
    },
  };
}

function collector(delayMs?: number) {
  const t = manualTimers();
  const apply = vi.fn((_entries: Entries) => Promise.resolve());
  const c = new PieceReloadCollector(apply, delayMs, t.timers);
  return { c, apply, ...t };
}

describe('PieceReloadCollector', () => {
  it('waits 50 ms after the LAST offer: every offer restarts the timer', () => {
    const { c, apply, armed, fire } = collector();
    c.offer('prelude', 'p1');
    expect([...armed.values()].map((t) => t.ms)).toEqual([50]);
    c.offer('quad', 'q1');
    expect(armed.size).toBe(1);
    expect(apply).not.toHaveBeenCalled();

    fire();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith([{ name: 'prelude', code: 'p1' }, { name: 'quad', code: 'q1' }]);
  });

  it('keeps the last text per name', () => {
    const { c, apply, fire } = collector();
    c.offer('quad', 'q1');
    c.offer('quad', 'q2');
    fire();
    expect(apply).toHaveBeenCalledWith([{ name: 'quad', code: 'q2' }]);
  });

  it('never lets an empty save replace a candidate waiting in the window', () => {
    const { c, apply, fire } = collector();
    c.offer('quad', 'q1');
    c.offer('quad', '');
    c.offer('quad', '  \n\t');
    fire();
    expect(apply).toHaveBeenCalledWith([{ name: 'quad', code: 'q1' }]);
  });

  it('an empty save before the content (the editor truncating) does not hold it back', () => {
    const { c, apply, fire } = collector();
    c.offer('quad', '');
    c.offer('quad', 'q1');
    fire();
    expect(apply).toHaveBeenCalledWith([{ name: 'quad', code: 'q1' }]);
  });

  it('a window of only empty saves sends nothing', () => {
    const { c, apply, armed, fire } = collector();
    c.offer('quad', '');
    c.offer('line', '');
    expect(armed.size).toBe(1);
    fire();
    expect(apply).not.toHaveBeenCalled();
  });

  it('a flush empties the window: the next offers form a new one', () => {
    const { c, apply, fire } = collector();
    c.offer('quad', 'q1');
    fire();
    c.offer('line', 'l1');
    fire();
    expect(apply.mock.calls).toEqual([
      [[{ name: 'quad', code: 'q1' }]],
      [[{ name: 'line', code: 'l1' }]],
    ]);
  });

  it('flushNow sends at once and cancels the timer', () => {
    const { c, apply, armed } = collector();
    c.offer('quad', 'q1');
    c.flushNow();
    expect(apply).toHaveBeenCalledWith([{ name: 'quad', code: 'q1' }]);
    expect(armed.size).toBe(0);
  });

  it('waits the delay it is given', () => {
    const { c, armed } = collector(120);
    c.offer('quad', 'q1');
    expect([...armed.values()].map((t) => t.ms)).toEqual([120]);
  });

  it('logs an apply that rejects instead of leaving the rejection unhandled', async () => {
    const t = manualTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('boom');
    const c = new PieceReloadCollector(() => Promise.reject(boom), 50, t.timers);
    c.offer('quad', 'q1');
    t.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(error).toHaveBeenCalledWith('[Hyperion] Piece hot-reload failed:', boom);
    error.mockRestore();
  });

  it('logs an apply that throws synchronously', async () => {
    const t = manualTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('boom');
    const c = new PieceReloadCollector(() => { throw boom; }, 50, t.timers);
    c.offer('quad', 'q1');
    expect(() => t.fire()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(error).toHaveBeenCalledWith('[Hyperion] Piece hot-reload failed:', boom);
    error.mockRestore();
  });

  it('uses setTimeout when no timers are given', () => {
    vi.useFakeTimers();
    try {
      const apply = vi.fn((_entries: Entries) => Promise.resolve());
      const c = new PieceReloadCollector(apply);
      c.offer('quad', 'q1');
      vi.advanceTimersByTime(49);
      expect(apply).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(apply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('assertPiecesNotEmpty — the guard on the RAW pieces', () => {
  const full = (): PrimitivePieces => ({
    prelude: '// prelude',
    libraries: Object.fromEntries(PRIMITIVE_LIBRARIES.map((lib) => [lib.type, `// ${lib.name}`])),
  });

  it('passes when every piece has text', () => {
    expect(() => assertPiecesNotEmpty(full())).not.toThrow();
  });

  it.each(['', '  \n\t'])('names an empty prelude (%j)', (text) => {
    expect(() => assertPiecesNotEmpty({ ...full(), prelude: text })).toThrow('Shader piece "prelude" is empty');
  });

  it.each(PRIMITIVE_LIBRARIES.map((lib) => [lib.name, lib.type] as const))('names an empty library: %s', (name, type) => {
    const pieces = full();
    pieces.libraries[type] = ' ';
    expect(() => assertPiecesNotEmpty(pieces)).toThrow(`Shader piece "${name}" is empty`);
  });
});
```

- [ ] **Step 2: Esegui il test, deve fallire**

Run: `npx --prefix ts vitest run --root ts src/render/piece-reload-collector.test.ts`
Expected: FAIL, `Failed to resolve import "./piece-reload-collector" from "src/render/piece-reload-collector.test.ts"`: il modulo non esiste ancora.

- [ ] **Step 3: Implementa il raccoglitore e la guardia**

Crea `ts/src/render/piece-reload-collector.ts`:

```ts
import { PRIMITIVE_LIBRARIES, type PrimitivePieces } from './primitive-shaders';

/** How the collector waits: setTimeout in the app, a hand-fired fake in tests. */
export interface PieceReloadTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const DEFAULT_TIMERS: PieceReloadTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Groups the primitive-piece hot-reloads that Vite delivers one file at a time.
 *
 * A name renamed in the prelude together with its uses in a library arrives
 * as separate `accept` callbacks. Reloaded one by one, each piece is probed
 * against the OTHER piece's old text and both are rejected (and reloading the
 * page loses the device on the development machine). The collector waits for
 * a quiet window — a trailing debounce: every offer restarts the timer — and
 * hands every piece of the window to `apply` at once
 * (`GraphRequests.reloadShaders`).
 *
 * Per name it keeps the last NON-empty text. Editors truncate before writing,
 * so an empty save must never replace a good candidate waiting in the window;
 * a window holding only empty saves sends nothing.
 */
export class PieceReloadCollector {
  private readonly pending = new Map<string, string>();
  private handle: unknown = null;
  private armed = false;

  constructor(
    private readonly apply: (entries: Array<{ name: string; code: string }>) => Promise<unknown>,
    private readonly delayMs = 50,
    private readonly timers: PieceReloadTimers = DEFAULT_TIMERS,
  ) {}

  /** A piece's new text, as an HMR `accept` delivers it. */
  offer(name: string, code: string): void {
    if (code.trim() !== '') this.pending.set(name, code);
    this.disarm();
    this.armed = true;
    this.handle = this.timers.set(() => {
      this.armed = false;
      this.handle = null;
      this.flushNow();
    }, this.delayMs);
  }

  /** Send the window now: every pending piece, in the order first offered. */
  flushNow(): void {
    this.disarm();
    if (this.pending.size === 0) return;
    const entries = [...this.pending].map(([name, code]) => ({ name, code }));
    this.pending.clear();
    let settled: Promise<unknown>;
    try {
      settled = Promise.resolve(this.apply(entries));
    } catch (err) {
      settled = Promise.reject(err);
    }
    // An HMR callback has nobody to report to: log, never leave a rejection unhandled.
    settled.catch((err: unknown) => console.error('[Hyperion] Piece hot-reload failed:', err));
  }

  private disarm(): void {
    if (!this.armed) return;
    this.timers.clear(this.handle);
    this.armed = false;
    this.handle = null;
  }
}

/**
 * Throw when a primitive piece is empty or only whitespace. The renderer's
 * piece slots call it first thing in their probe, inside the GPU validation
 * window. A composed module is never empty (prelude, markers, wrappers), so
 * only the RAW pieces show an editor's truncated save. The throw is
 * synchronous: GraphRequests rejects the reload without superseding the edit
 * in flight.
 */
export function assertPiecesNotEmpty(pieces: PrimitivePieces): void {
  if (!pieces.prelude || pieces.prelude.trim() === '') throw new Error('Shader piece "prelude" is empty');
  for (const lib of PRIMITIVE_LIBRARIES) {
    const src = pieces.libraries[lib.type];
    if (!src || src.trim() === '') throw new Error(`Shader piece "${lib.name}" is empty`);
  }
}
```

- [ ] **Step 4: Esegui il test, deve passare**

Run: `npx --prefix ts vitest run --root ts src/render/piece-reload-collector.test.ts`
Expected: PASS, `Tests 20 passed (20)`.

- [ ] **Step 5: Commit**

```bash
git add ts/src/render/piece-reload-collector.ts ts/src/render/piece-reload-collector.test.ts
git commit -m "feat(5b): PieceReloadCollector — debounce finale di 50 ms dei reload dei pezzi e guardia sui pezzi vuoti

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Scrivi i test di `reloadShaders` e correggi il test del file vuoto**

In `ts/src/render/graph-requests.test.ts`:

(a) Import, riga 2. Prima:

```ts
import { GraphRequests, type ShaderSlot } from './graph-requests';
```

Dopo:

```ts
import { GraphRequests, type ReloadOutcome, type ShaderSlot } from './graph-requests';
import { PieceReloadCollector, type PieceReloadTimers } from './piece-reload-collector';
```

(b) `setup`, righe 53-55. Prima:

```ts
function setup(slots: Record<string, ShaderSlot> = {}) {
  const { host, requests } = fakeHost();
  const { validation, runs } = deferredValidation();
```

Dopo (il resto della funzione non cambia):

```ts
function setup(slots: Record<string, ShaderSlot> = {}, validationOverride?: GpuValidation) {
  const { host, requests } = fakeHost();
  const deferred = deferredValidation();
  const validation = validationOverride ?? deferred.validation;
  const runs = deferred.runs;
```

(c) Il test di L175-191 (`'an empty file saved right after a good edit does not cancel the good one'`): il commento e il mock facevano pensare a una guardia dentro `ForwardPass`, che non lancia mai per un solo modulo vuoto. Sostituiscilo per intero con:

```ts
  it('an empty file saved right after a good edit does not cancel the good one', async () => {
    // Editors can truncate before writing: HMR then delivers '' right after the edit.
    // The guard is NOT in ForwardPass (it never throws for one empty module):
    // it is the renderer's piece-slot probe, assertPiecesNotEmpty on the RAW
    // pieces, which throws synchronously inside validation.run. This probe
    // stands for it.
    const quad = slot('v0', () => false);
    const probe = quad.probe;
    quad.probe = () => {
      if (quad.read().trim() === '') throw new Error('Shader piece "quad" is empty');
      probe();
    };
    const { graph, runs } = setup({ quad });

    const good = graph.reloadShader('quad', 'v1');
    expect(await graph.reloadShader('quad', '')).toBe('rejected');
    runs.shift()!([]);

    expect(await good).toBe('validated');
    expect(quad.read()).toBe('v1');
  });
```

(d) In coda al file, dopo l'ultimo `describe` (`'GraphRequests — no rebuild of an unchanged graph'`), aggiungi:

```ts
/**
 * A toy compiler for pieces compiled together, like the primitive prelude and
 * libraries: `def:x` declares x (twice is a redeclaration), `use:x` needs a
 * declaration in some piece, `bad` is a syntax error.
 */
function compileToy(pieces: Record<string, string>): string[] {
  const errors: string[] = [];
  const tokens = Object.entries(pieces).flatMap(([piece, src]) =>
    src.split(/\s+/).filter(Boolean).map((token) => ({ piece, token })));
  const declared = new Set<string>();
  for (const { piece, token } of tokens) {
    if (token === 'bad') errors.push(`${piece}: syntax error`);
    if (!token.startsWith('def:')) continue;
    const name = token.slice(4);
    if (declared.has(name)) errors.push(`${piece}: redeclaration of ${name}`);
    declared.add(name);
  }
  for (const { piece, token } of tokens) {
    if (token.startsWith('use:') && !declared.has(token.slice(4))) {
      errors.push(`${piece}: unresolved identifier ${token.slice(4)}`);
    }
  }
  return errors;
}

/**
 * Pieces sharing ONE probe, like the renderer's piece slots. The probe
 * compiles the current text of every piece together (recorded in `compiled`)
 * and throws synchronously on an empty piece, like assertPiecesNotEmpty. The
 * validation resolves with the errors of the probe it ran.
 */
function toyPieces(initial: Record<string, string>) {
  const sources: Record<string, string> = { ...initial };
  const compiled: Array<Record<string, string>> = [];
  let errors: string[] | null = null;
  const probe = (): void => {
    for (const [name, src] of Object.entries(sources)) {
      if (src.trim() === '') throw new Error(`Shader piece "${name}" is empty`);
    }
    if (!errors) throw new Error('probe outside a validation window');
    compiled.push({ ...sources });
    errors.push(...compileToy(sources));
  };
  const validation: GpuValidation = {
    run(fn) {
      const found: string[] = [];
      errors = found;
      try {
        fn();
      } finally {
        errors = null;
      }
      return Promise.resolve(found);
    },
  };
  const slots: Record<string, ShaderSlot> = {};
  for (const name of Object.keys(sources)) {
    slots[name] = {
      read: () => sources[name],
      write: (src) => { sources[name] = src; },
      probe,
      usedBy: () => true,
    };
  }
  return { sources, slots, validation, compiled };
}

/** Timers fired by hand: the collector's debounce window closes when the test says so. */
function manualTimers() {
  let pending: { id: number; fn: () => void } | null = null;
  let ids = 0;
  const timers: PieceReloadTimers = {
    set: (fn) => {
      pending = { id: ++ids, fn };
      return pending.id;
    },
    clear: (handle) => {
      if (pending?.id === handle) pending = null;
    },
  };
  return {
    timers,
    fire(): void {
      const due = pending;
      pending = null;
      due?.fn();
    },
  };
}

const PIECES: Record<string, string> = {
  prelude: 'def:camera def:quadHelper def:lineHelper',
  quad: 'use:camera use:quadHelper def:quad_fs',
  line: 'use:camera use:lineHelper def:line_fs',
};

/** GraphRequests over toy pieces, fed by a PieceReloadCollector as HMR feeds it. */
function grouped(initial: Record<string, string> = PIECES) {
  const toy = toyPieces(initial);
  const env = setup(toy.slots, toy.validation);
  const timers = manualTimers();
  const windows: Array<Promise<Map<string, ReloadOutcome>>> = [];
  const collector = new PieceReloadCollector((entries) => {
    const outcome = env.graph.reloadShaders(entries);
    windows.push(outcome);
    return outcome;
  }, 50, timers.timers);
  return { ...env, ...toy, collector, fire: timers.fire, windows };
}

const outcomesOf = async (p: Promise<Map<string, ReloadOutcome>>) => Object.fromEntries(await p);

// Spec §3.3 point 6: the grouped reload, driven through the collector.
describe('GraphRequests — grouped piece reload, through the collector', () => {
  it('a prelude rename and its use in a library, in one window, go live together', async () => {
    const env = grouped();
    env.collector.offer('prelude', 'def:camera def:quadHelper2 def:lineHelper');
    env.collector.offer('quad', 'use:camera use:quadHelper2 def:quad_fs');
    env.fire();
    await tick();
    expect(env.compiled).toHaveLength(3); // the union, then each alone (both fail alone)
    expect(env.host.request).toHaveBeenCalledTimes(1);
    env.requests[0].settle('swapped');

    expect(await outcomesOf(env.windows[0])).toEqual({ prelude: 'swapped', quad: 'swapped' });
    expect(env.sources.prelude).toContain('def:quadHelper2');
    expect(env.sources.quad).toContain('use:quadHelper2');
    expect(env.log.log).toHaveBeenCalledWith('[Hyperion] Shaders "prelude", "quad" hot-reloaded');
  });

  it('a broken line and an independent valid quad: quad goes live, line is rejected', async () => {
    const env = grouped();
    env.collector.offer('line', 'use:camera use:lineHelper def:line_fs bad');
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs def:quad_extra');
    env.fire();
    await tick();
    expect(env.host.request).toHaveBeenCalledTimes(1);
    env.requests[0].settle('swapped');

    expect(await outcomesOf(env.windows[0])).toEqual({ line: 'rejected', quad: 'swapped' });
    expect(env.sources.line).toBe(PIECES.line);
    expect(env.sources.quad).toContain('def:quad_extra');
    expect(env.log.error).toHaveBeenCalledWith(expect.stringMatching(/Shader "line" rejected.*line: syntax error/s));
  });

  it('two pieces that compile alone but not together: both rejected, no graph request, a pending mode switch still goes live', async () => {
    const env = grouped();
    env.graph.enableOutlines('red'); // requests[0], still pending
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs def:shared');
    env.collector.offer('line', 'use:camera use:lineHelper def:line_fs def:shared');
    env.fire();

    expect(await outcomesOf(env.windows[0])).toEqual({ quad: 'rejected', line: 'rejected' });
    expect(env.compiled).toHaveLength(3); // the union and the two solos: the rejected set is not tried again
    expect(env.host.request).toHaveBeenCalledTimes(1);
    expect(env.sources.quad).toBe(PIECES.quad);
    expect(env.sources.line).toBe(PIECES.line);
    expect(env.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/Shaders "quad", "line" compile alone but not together.*redeclaration of shared/s),
    );

    env.requests[0].settle('swapped');
    await tick();
    expect(env.graph.requested.mode).toEqual(OUTLINES);
    expect(env.host.mode).toEqual(OUTLINES);
  });

  it('a prelude rename + the line using it + an unrelated broken quad: all three rejected (the declared limit)', async () => {
    const env = grouped();
    env.collector.offer('prelude', 'def:camera def:quadHelper def:lineHelper2');
    env.collector.offer('line', 'use:camera use:lineHelper2 def:line_fs');
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs bad');
    env.fire();

    expect(await outcomesOf(env.windows[0])).toEqual({ prelude: 'rejected', line: 'rejected', quad: 'rejected' });
    expect(env.host.request).not.toHaveBeenCalled();
    expect(env.sources).toEqual(PIECES);
  });

  it('an entry replaced by a later window is superseded, and the newer source goes live', async () => {
    const env = grouped();
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs def:v1');
    env.fire();
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs def:v2');
    env.fire();
    await tick();
    expect(env.host.request).toHaveBeenCalledTimes(1);
    env.requests[0].settle('swapped');

    expect(await outcomesOf(env.windows[0])).toEqual({ quad: 'superseded' });
    expect(await outcomesOf(env.windows[1])).toEqual({ quad: 'swapped' });
    expect(env.sources.quad).toContain('def:v2');
  });

  it("v1 then '' for the same piece in one window: v1 goes live", async () => {
    const env = grouped();
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs def:v1');
    env.collector.offer('quad', '');
    env.fire();
    await tick();
    env.requests[0].settle('swapped');

    expect(await outcomesOf(env.windows[0])).toEqual({ quad: 'swapped' });
    expect(env.sources.quad).toContain('def:v1');
  });

  it("'' then v1 for the same piece in one window: v1 goes live", async () => {
    const env = grouped();
    env.collector.offer('quad', '');
    env.collector.offer('quad', 'use:camera use:quadHelper def:quad_fs def:v1');
    env.fire();
    await tick();
    env.requests[0].settle('swapped');

    expect(await outcomesOf(env.windows[0])).toEqual({ quad: 'swapped' });
    expect(env.sources.quad).toContain('def:v1');
  });
});

describe('GraphRequests — reloadShaders', () => {
  const PRELUDE_EXTRA = 'def:camera def:quadHelper def:lineHelper def:extra';
  const QUAD_EXTRA = 'use:camera use:quadHelper def:quad_fs use:extra';

  it('probes the union, then each entry alone, all inside the call; every source is back after', () => {
    const env = grouped();
    void env.graph.reloadShaders([{ name: 'prelude', code: PRELUDE_EXTRA }, { name: 'quad', code: QUAD_EXTRA }]);
    expect(env.compiled).toEqual([
      { prelude: PRELUDE_EXTRA, quad: QUAD_EXTRA, line: PIECES.line }, // the union
      { prelude: PRELUDE_EXTRA, quad: PIECES.quad, line: PIECES.line }, // prelude alone
      { prelude: PIECES.prelude, quad: QUAD_EXTRA, line: PIECES.line }, // quad alone
    ]);
    expect(env.sources).toEqual(PIECES);
  });

  it('a single entry is probed once', () => {
    const env = grouped();
    void env.graph.reloadShaders([{ name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:v1' }]);
    expect(env.compiled).toHaveLength(1);
  });

  it('an entry whose probe throws is rejected at once and supersedes nothing', async () => {
    const env = grouped();
    const good = env.graph.reloadShader('quad', 'use:camera use:quadHelper def:quad_fs def:v1');
    expect(await outcomesOf(env.graph.reloadShaders([{ name: 'quad', code: '' }]))).toEqual({ quad: 'rejected' });
    expect(env.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/Shader "quad" did not compile/), expect.objectContaining({ message: 'Shader piece "quad" is empty' }),
    );
    await tick();
    env.requests[0].settle('swapped');

    expect(await good).toBe('swapped');
    expect(env.sources.quad).toContain('def:v1');
  });

  it('a direct reloadShader of a piece supersedes the entry of a pending window', async () => {
    const env = grouped();
    const batch = env.graph.reloadShaders([{ name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:v1' }]);
    const direct = env.graph.reloadShader('quad', 'use:camera use:quadHelper def:quad_fs def:v2');
    await tick();
    expect(env.host.request).toHaveBeenCalledTimes(1);
    env.requests[0].settle('swapped');

    expect(await outcomesOf(batch)).toEqual({ quad: 'superseded' });
    expect(await direct).toBe('swapped');
    expect(env.sources.quad).toContain('def:v2');
  });

  it('and the other way round: a window supersedes a pending direct reloadShader', async () => {
    const env = grouped();
    const direct = env.graph.reloadShader('quad', 'use:camera use:quadHelper def:quad_fs def:v1');
    const batch = env.graph.reloadShaders([{ name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:v2' }]);
    await tick();
    expect(env.host.request).toHaveBeenCalledTimes(1);
    env.requests[0].settle('swapped');

    expect(await direct).toBe('superseded');
    expect(await outcomesOf(batch)).toEqual({ quad: 'swapped' });
    expect(env.sources.quad).toContain('def:v2');
  });

  it('an empty entry next to a valid one: the valid one still goes live', async () => {
    const env = grouped();
    const outcome = env.graph.reloadShaders([
      { name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:v1' },
      { name: 'line', code: '' },
    ]);
    await tick();
    expect(env.host.request).toHaveBeenCalledTimes(1);
    env.requests[0].settle('swapped');

    expect(await outcomesOf(outcome)).toEqual({ quad: 'swapped', line: 'rejected' });
    expect(env.sources.quad).toContain('def:v1');
    expect(env.sources.line).toBe(PIECES.line);
  });

  it('an unknown name is reported, the others still reload', async () => {
    const env = grouped();
    const outcome = env.graph.reloadShaders([
      { name: 'nope', code: 'x' },
      { name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:v1' },
    ]);
    await tick();
    env.requests[0].settle('swapped');

    expect(await outcomesOf(outcome)).toEqual({ nope: 'unknown', quad: 'swapped' });
    expect(env.log.warn).toHaveBeenCalledWith('[Hyperion] Unknown shader pass: nope');
  });

  it('some pass alone: the passing ones are probed together once more before any graph request', async () => {
    const env = grouped({ ...PIECES, gradient: 'use:camera def:gradient_fs' });
    const outcome = env.graph.reloadShaders([
      { name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:q2' },
      { name: 'line', code: 'use:camera use:lineHelper def:line_fs bad' },
      { name: 'gradient', code: 'use:camera def:gradient_fs def:g2' },
    ]);
    await tick();
    // The union, three solos, then quad + gradient together over the current sources.
    expect(env.compiled).toHaveLength(5);
    expect(env.compiled[4]).toEqual({
      prelude: PIECES.prelude,
      quad: 'use:camera use:quadHelper def:quad_fs def:q2',
      line: PIECES.line,
      gradient: 'use:camera def:gradient_fs def:g2',
    });
    env.requests[0].settle('swapped');

    expect(await outcomesOf(outcome)).toEqual({ quad: 'swapped', line: 'rejected', gradient: 'swapped' });
  });

  it('a passing subset that fails together is rejected, with no graph request', async () => {
    const env = grouped({ ...PIECES, gradient: 'use:camera def:gradient_fs' });
    const outcome = env.graph.reloadShaders([
      { name: 'quad', code: 'use:camera use:quadHelper def:quad_fs def:shared' },
      { name: 'line', code: 'use:camera use:lineHelper def:line_fs bad' },
      { name: 'gradient', code: 'use:camera def:gradient_fs def:shared' },
    ]);

    expect(await outcomesOf(outcome)).toEqual({ quad: 'rejected', line: 'rejected', gradient: 'rejected' });
    expect(env.host.request).not.toHaveBeenCalled();
    expect(env.sources.quad).toBe(PIECES.quad);
    expect(env.sources.gradient).toBe('use:camera def:gradient_fs');
  });
});
```

Cosa pinnano, in breve: i sette casi di §3.3 punto 6 passano dal raccoglitore; il verdetto "tutte passano da sole ma l'unione no" non rifà il probe dello stesso insieme (`compiled` lungo 3) e non tocca la richiesta di modo in attesa; il sottoinsieme che passa da solo viene riprovato INSIEME prima di qualunque grafo; le versioni sono condivise con `reloadShader` nei due sensi; un probe che lancia non incrementa la versione, e una voce vuota non trascina con sé una voce valida (l'unione che la contiene non è l'insieme da scrivere, quindi non vale come "conflitto").

- [ ] **Step 7: Esegui il test, deve fallire**

Run: `npx --prefix ts vitest run --root ts src/render/graph-requests.test.ts`
Expected: FAIL, `Tests 16 failed | 27 passed (43)`. I 16 nuovi falliscono con `TypeError: env.graph.reloadShaders is not a function` (nei casi dal raccoglitore compare anche il log `[Hyperion] Piece hot-reload failed: TypeError …`); i 27 esistenti, test del file vuoto compreso, passano.

- [ ] **Step 8: Implementa `reloadShaders` in `graph-requests.ts`**

(a) Doc di `ShaderSlot.probe`, righe 17-21. Prima:

```ts
  /**
   * Set up, then destroy, a throwaway pass that compiles this shader from the
   * slot's CURRENT source. Called inside a GPU validation window.
   */
  probe(): void;
```

Dopo:

```ts
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
```

(b) Subito dopo `export type ReloadOutcome = RequestResult['outcome'] | 'validated' | 'unknown';` (L37) aggiungi:

```ts

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
```

(c) JSDoc della classe, primo paragrafo dopo "shader hot-reload." (L55-61). Prima:

```ts
 * A reloaded shader is validated ON ITS OWN before anything else sees it: its
 * source is written to the static slot only for the synchronous duration of
 * the probe, and kept only once the GPU reports no error. So the static slots
 * only ever hold sources that compiled, no graph is built from an unvalidated
 * one, and a broken file in a batch (Save All, a checkout) cannot take a valid
 * one down with it. A graph is rebuilt only when the requested mode uses the
 * shader; one it does not use is validated and kept for later.
```

Dopo:

```ts
 * A reloaded shader is validated before anything else sees it: its source is
 * written to the static slot only for the synchronous duration of the probe,
 * and kept only once the GPU reports no error. So the static slots only ever
 * hold sources that compiled, and a graph is rebuilt only when the requested
 * mode uses the shader; one it does not use is validated and kept for later.
 *
 * Shaders that depend on each other (the primitive pieces: a prelude rename
 * and its uses in a library) are reloaded as a group by `reloadShaders`:
 * validated together, and alone as a fallback. No graph is ever built from a
 * set a probe rejected, or that no probe tried together. With independent
 * files, a broken one in a batch (Save All, a checkout) cannot take a valid
 * one down with it; a coupled edit saved together with an unrelated broken
 * piece is rejected whole and must be saved again.
```

(d) Subito dopo la fine di `reloadShader` (la riga `  }` che chiude il metodo, L199) e prima di `private setOptions(`, aggiungi:

```ts
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
   * Versions are the ones `reloadShader` uses, per name: each entry whose
   * probe reached the GPU bumps its version (an entry that threw — an empty
   * piece — supersedes nothing), and an entry whose version moved before the
   * verdict (a later window, a direct `reloadShader`) is dropped as
   * 'superseded'.
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
    let proven: boolean;
    // Proven by the union only if every candidate is still in: an entry that
    // threw or was superseded leaves a subset no probe tried together.
    if (unionErrors.length === 0 && alive.length === candidates.length) {
      keep = alive;
      proven = true;
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
      proven = keep.length <= 1;
    }

    while (!proven) {
      const again = this.probeTogether(keep);
      const errors = again.threw ? [String(again.error)] : await again.messages;
      const current = keep.filter(isCurrent);
      if (current.length < keep.length) {
        // A member was reloaded again meanwhile: this verdict was about another set.
        for (const c of keep) if (!isCurrent(c)) outcomes.set(c.name, 'superseded');
        keep = current;
        proven = keep.length <= 1;
        continue;
      }
      if (errors.length > 0) {
        for (const c of keep) outcomes.set(c.name, 'rejected');
        this.deps.log.error(
          `[Hyperion] ${shaderLabel(keep)} compile alone but not together — keeping the previous sources:\n${errors.join('\n')}`,
        );
        return outcomes;
      }
      proven = true;
    }
    if (keep.length === 0) return outcomes;

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
```

Note per chi implementa:
- `reloadShaders` è `async`, ma tutto ciò che sta prima del primo `await` (i probe, i ripristini, gli incrementi di versione) gira in modo sincrono dentro la chiamata: è ciò che pinna il test "all inside the call".
- Una sola voce: l'unione È il suo probe singolo (`solos = [union]`), quindi si compila una volta sola.
- "Provato dall'unione" e "in conflitto" si confrontano con TUTTI i candidati (`candidates.length`), non solo con quelli il cui probe è arrivato alla GPU: una voce che ha lanciato (vuota) o è stata sostituita lascia un sottoinsieme che l'unione non ha provato.
- Un sopravvissuto singolo non si riprova: il suo probe singolo è l'unione di quel sottoinsieme. Il ciclo `while (!proven)` gira solo con ≥ 2 sopravvissuti, e ricomincia se uno di loro viene sostituito mentre il probe è in volo.
- Il ripristino in `probeTogether` sta nel `finally`, quindi vale anche quando il probe lancia (la guardia sul pezzo vuoto), prima di qualunque incremento di versione.

- [ ] **Step 9: Esegui i test, devono passare**

Run: `npx --prefix ts vitest run --root ts src/render/graph-requests.test.ts`
Expected: PASS, `Tests 43 passed (43)`.

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Expected: nessuna riga (le sole righe TS2307 di `wasm/hyperion_core` sono filtrate).

- [ ] **Step 10: Commit**

```bash
git add ts/src/render/graph-requests.ts ts/src/render/graph-requests.test.ts
git commit -m "feat(5b): GraphRequests.reloadShaders — unione e probe singoli nella stessa finestra sincrona

Nessun grafo da un insieme che un probe ha respinto o che nessun probe ha
provato insieme. Corretto il test del file vuoto: la guardia è nel probe
degli slot di pezzo del renderer, non in ForwardPass.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Scrivi i test sul cablaggio di `renderer.ts`**

`hot.accept(dep)` funziona solo nel modulo che importa `dep`, quindi il cablaggio sta in `renderer.ts` e si controlla sul suo testo (come fa già `light-groups.test.ts`).

In `ts/src/render/piece-reload-collector.test.ts`, sotto `import { describe, it, expect, vi } from 'vitest';` aggiungi:

```ts
import { readFileSync } from 'node:fs';
```

e in coda al file aggiungi:

```ts
// Vite's hot.accept(dep) works only in the module that imports dep, so the
// wiring lives in renderer.ts and is checked on its text.
describe('renderer.ts — every primitive piece reaches the collector', () => {
  const renderer = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const PIECES = ['prelude', ...PRIMITIVE_LIBRARIES.map((lib) => lib.name)];

  it.each(PIECES)('%s: imported ?raw, accepted, and offered under its slot name', (piece) => {
    const path = `./shaders/primitives/${piece}.wgsl?raw`;
    expect(renderer).toContain(`from '${path}';`);
    expect(renderer).toMatch(new RegExp(
      String.raw`import\.meta\.hot\.accept\('${escape(path)}', \(mod\) => \{\s*if \(mod\) pieceReloads\.offer\('${piece}', mod\.default\);\s*\}\);`,
    ));
  });

  it('no piece accept bypasses the collector', () => {
    expect(renderer).not.toMatch(/accept\('\.\/shaders\/primitives\/[\w-]+\.wgsl\?raw',[^;]*recompileShader/);
  });

  it('the collector feeds GraphRequests.reloadShaders', () => {
    expect(renderer).toContain('new PieceReloadCollector((entries) => requests.reloadShaders(entries))');
  });

  it('the piece probe guards the RAW pieces, before compiling', () => {
    expect(renderer).toMatch(/assertPiecesNotEmpty\(primitivePieces\);\s*compilePrimitives\(\);/);
  });

  it("'basic' is an alias of the 'quad' slot, not a slot of its own", () => {
    expect(renderer).toContain("requests.reloadShader(passName === 'basic' ? 'quad' : passName, shaderCode)");
    expect(renderer).not.toMatch(/^\s+basic: /m);
  });
});
```

- [ ] **Step 12: Esegui il test, deve fallire**

Run: `npx --prefix ts vitest run --root ts src/render/piece-reload-collector.test.ts`
Expected: FAIL. Falliscono i sette `<pezzo>: imported ?raw, accepted, and offered under its slot name` (l'import c'è dal Task 6, l'`offer` no), `the collector feeds GraphRequests.reloadShaders`, `the piece probe guards the RAW pieces, before compiling` e `'basic' is an alias…`; `no piece accept bypasses the collector` fallisce se gli `accept` lasciati dal Task 6 chiamano `recompileShader`. I 20 test di prima passano: `Tests 11 failed | 20 passed (31)` (oppure 10 | 21 se il Task 6 non ha usato `recompileShader` negli `accept`).

- [ ] **Step 13: Cabla i pezzi in `renderer.ts` e aggiorna i JSDoc**

(a) Import. Nell'import di `./render/primitive-shaders` aggiunto dal Task 6 aggiungi `PRIMITIVE_LIBRARIES` (se c'è già, lascialo), e subito sotto importa il raccoglitore. Dopo il cambio le due righe sono:

```ts
import { PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule, type PrimitivePieces } from './render/primitive-shaders';
import { PieceReloadCollector, assertPiecesNotEmpty } from './render/piece-reload-collector';
```

(b) Helper degli slot primitivi. In `createRenderer`, tra la riga `const inLightingMode = (m: GraphMode): boolean => m.lighting;` e la riga `const shaderSlots: Record<string, ShaderSlot> = {`, c'è l'helper degli slot primitivi con il suo commento (su `72c0f7e` è `forwardSlot` sotto il commento `// A primitive module has two users:`, L546-555; il Task 6 può averlo trasformato in un helper per i pezzi). Sostituisci TUTTE le righe fra quelle due con:

```ts
  // The seven primitive pieces: the prelude and one library per type. A write
  // recomposes the six per-type modules and the uber module in place
  // (publishPrimitiveShaders: concatenation only, it cannot throw), so the
  // factories and probes holding ForwardPass.SHADER_SOURCES see the new text.
  // Every piece shares ONE probe, which compiles every module a piece is in:
  // ForwardPass (six opaque pipelines + the uber: fs_main, three groups) and
  // the occluder pipelines of LightGroupsPass (fs_occluder, two groups), so
  // an edit that breaks only one entry point is caught too. Shared, a grouped
  // reload (GraphRequests.reloadShaders) compiles it once per probe set.
  const compilePrimitives = probe(() => [new ForwardPass(), new LightGroupsPass(ForwardPass.SHADER_SOURCES)]);
  const primitiveProbe = (): void => {
    // A composed module is never empty (prelude, markers, wrappers): only the
    // RAW pieces show an editor's truncated save. The throw is synchronous,
    // inside the validation window, so the reload is rejected without
    // superseding the edit in flight.
    assertPiecesNotEmpty(primitivePieces);
    compilePrimitives();
  };
  const pieceSlot = (read: () => string, store: (src: string) => void): ShaderSlot => ({
    read,
    write: (src) => {
      store(src);
      publishPrimitiveShaders();
    },
    probe: primitiveProbe,
    usedBy: inEveryMode,
  });
  const primitiveSlots: Record<string, ShaderSlot> = {
    prelude: pieceSlot(() => primitivePieces.prelude, (src) => { primitivePieces.prelude = src; }),
  };
  for (const lib of PRIMITIVE_LIBRARIES) {
    primitiveSlots[lib.name] = pieceSlot(
      () => primitivePieces.libraries[lib.type],
      (src) => { primitivePieces.libraries[lib.type] = src; },
    );
  }
```

(c) Voci primitive di `shaderSlots`. Dentro l'oggetto, subito dopo la voce `cull: { … },`, ci sono le voci primitive (su `72c0f7e` sono `basic: forwardSlot(0),` … `'box-shadow': forwardSlot(5),`, L564-570; dopo il Task 6 sono le voci dei pezzi, comunque si chiamino). Sostituiscile tutte con una riga sola:

```ts
    ...primitiveSlots,
```

Non resta nessuna chiave `basic`: l'alias sta in `recompileShader`, così `basic` e `quad` condividono slot, sorgente buona e versione.

(d) `recompileShader` nell'oggetto `rendererObj`. Prima (ultima riga del metodo):

```ts
      void requests.reloadShader(passName, shaderCode);
```

Dopo:

```ts
      // 'basic' is the quad library's old file name (basic.wgsl): an alias, so
      // both names share one slot, one good source and one reload version.
      void requests.reloadShader(passName === 'basic' ? 'quad' : passName, shaderCode);
```

(e) JSDoc nell'interfaccia `Renderer`. Prima: il blocco JSDoc e la firma che il Task 6 ha scritto allo Step 9(d) (su `72c0f7e` la firma, senza JSDoc, era a L123):

```ts
  /**
   * Dev tool: replace one shader, and rebuild what uses it once the GPU has
   * validated it. For a primitive ('basic'/'quad', 'line', 'msdf-text',
   * 'bezier', 'gradient', 'box-shadow') the source is that primitive's LIBRARY
   * piece (shaders/primitives/<name>.wgsl: prefixed functions, no bindings, no
   * entry points), not a whole module: the renderer composes it with the prelude.
   */
  recompileShader(passName: string, shaderCode: string): void;
```

Dopo (il blocco del Task 6 viene SOSTITUITO per intero, non tenuto sopra quello nuovo: il suo elenco non nomina `'prelude'`, che dal Task 7 è uno slot):

```ts
  /**
   * Hot-reload one shader from new WGSL (dev tool); the GPU validates it
   * before any graph uses it. For the primitives the name is a PIECE —
   * 'prelude', 'quad' (alias 'basic'), 'line', 'msdf-text', 'bezier',
   * 'gradient', 'box-shadow' — and the code is that piece, not a complete
   * module: the six per-type modules and the uber module are recomposed from
   * the pieces. One piece per call, no debounce: an edit spanning two pieces
   * (a prelude rename and its uses) goes live only through the grouped HMR
   * reload, where the pieces are validated together.
   */
  recompileShader(passName: string, shaderCode: string): void;
```

(f) `accept` dei pezzi. Nel blocco `if (import.meta.hot) {`, sostituisci i sette `import.meta.hot.accept('./shaders/primitives/…wgsl?raw', …)` lasciati dal Task 6 (tutti e soli quelli con `./shaders/primitives/`) con questo blocco, messo all'inizio del blocco `if`:

```ts
    // Primitive pieces wait for a quiet 50 ms window and reload as a group:
    // a prelude rename and its uses in a library arrive as separate updates,
    // and each alone would be probed against the other's old text.
    const pieceReloads = new PieceReloadCollector((entries) => requests.reloadShaders(entries));
    import.meta.hot.accept('./shaders/primitives/prelude.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('prelude', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/quad.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('quad', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/line.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('line', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/msdf-text.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('msdf-text', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/bezier.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('bezier', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/gradient.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('gradient', mod.default);
    });
    import.meta.hot.accept('./shaders/primitives/box-shadow.wgsl?raw', (mod) => {
      if (mod) pieceReloads.offer('box-shadow', mod.default);
    });
```

Gli altri `accept` (cull, fxaa-tonemap, …, particle-render) non cambiano: restano a slot singolo, senza debounce.

(g) In `ts/src/hyperion.ts`, JSDoc di `recompileShader`. Prima: il blocco che il Task 6 ha scritto allo Step 9(h) (su `72c0f7e` era la riga singola di L745):

```ts
  /**
   * Recompile a named shader with new WGSL source (dev tool). For a primitive
   * ('basic'/'quad', 'line', 'msdf-text', 'bezier', 'gradient', 'box-shadow')
   * the source is that primitive's library piece, not a whole module.
   */
```

Dopo (sostituisce per intero il blocco del Task 6):

```ts
  /**
   * Recompile a named shader pass with new WGSL source (dev tool). For the
   * primitive shaders the name is a piece — 'prelude', 'quad' (alias
   * 'basic'), 'line', 'msdf-text', 'bezier', 'gradient', 'box-shadow' — and
   * the source is that piece, not a complete module.
   */
```

- [ ] **Step 14: Esegui i test, il type-check e la suite**

Run: `npx --prefix ts vitest run --root ts src/render/piece-reload-collector.test.ts src/render/graph-requests.test.ts`
Expected: PASS, `Tests 74 passed (74)` (31 + 43).

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Expected: nessuna riga.

Run: `npm --prefix ts test`
Expected: PASS; il totale sale di 47 rispetto alla fine del Task 6 (31 in `piece-reload-collector.test.ts`, 16 in `graph-requests.test.ts`); `hyperion.test.ts` "recompileShader delegates to renderer" (che passa `'basic'`) resta verde.

- [ ] **Step 15: Commit**

```bash
git add ts/src/renderer.ts ts/src/hyperion.ts ts/src/render/piece-reload-collector.test.ts
git commit -m "feat(5b): hot-reload dei pezzi nel renderer — sette slot, alias basic, raccoglitore

Gli accept dei pezzi passano da PieceReloadCollector (50 ms) a
GraphRequests.reloadShaders; il probe degli slot di pezzo controlla i pezzi
GREZZI prima di compilare. recompileShader resta a slot singolo.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: cancello GPU del passo 1

Il criterio d'uscita del passo 1 (spec §8, riga 1) si verifica qui, nell'ordine: test headless verdi; i 7 moduli composti validati da naga (il front-end di Firefox) e da Chrome (compilazione + ogni pipeline che il motore ne costruisce, uber compreso); stati dei 10 tab uguali alla baseline e tutti i punti di C identici al bit, in Mode B e in Mode C; `forward` misurato con lo scenario committato; l'HMR di un pezzo funziona, compreso il reload raggruppato. **Ogni punto è bloccante**: se uno fallisce non si passa al Task 9.

Il Task produce due strumenti riusabili al passo 3 (Task 18): un file di test che scrive i moduli composti su disco quando `DUMP_WGSL_DIR` è impostata, e uno script che li passa a naga. Il corpo di `evaluate_script` per Chrome è committato in `docs/plans/assets/` come quello del benchmark.

Convenzioni degli step GPU: il server MCP è `chrome-devtools-gpu`; il `filePath` di `evaluate_script` si dà come percorso assoluto (la radice del repo è `/home/edoardocicognani/Code/HyperionEngine`); l'initScript low-power è

```js
GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)
```

Quando uno step dice "passa il file X come `function`", leggi il file con Read e passa il suo contenuto INTEGRALE come parametro `function` di `mcp__chrome-devtools-gpu__evaluate_script`.

**Files:**
- Create: `ts/src/render/dump-composed-wgsl.test.ts`
- Create: `scripts/validate-wgsl-naga.mjs`
- Create: `docs/plans/assets/2026-09-27-transparent-sort-validate-wgsl.js`
- Create (risultati): `docs/plans/assets/2026-09-27-transparent-sort-step1/` con `naga.txt`, `naga-base.txt`, `chrome-wgsl.json`, `B-<tab>.json` e `C-<tab>.json` per i 10 tab, `statuses-B.json`, `statuses-C.json`, `compare-B.txt`, `compare-C.txt`, `forward-vs-step0.txt`, `hmr-smoke.txt`
- Create (risultati): `docs/plans/assets/2026-09-27-transparent-sort-bench-step1.json`

**Interfaces:**
- Consumes:
  - `PRIMITIVE_LIBRARIES`, `composeTypeModules(pieces): Record<number, string>`, `composeUberModule(pieces): string`, `type PrimitivePieces` (Task 5);
  - `primitiveGroup0LayoutEntries()`, `textureTierLayoutEntries()` (`render/primitive-bindings.ts`), `SCENE_HDR_FORMAT`, `JFA_FORMAT` (`render/formats.ts`), `ForwardPass.SHADER_SOURCES`, `ForwardPass.UBER_SOURCE` (Task 6);
  - `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js` (lanciato solo da una pagina `?bench`, con `window.__captureOpts = { tab }` o `{ statuses: true }`) e `compare.mjs` (CLI `node compare.mjs --base <dir> --run <dir> --mode B|C --step 0|1|2|3|4 [--allow-new-skip '<check>' …]`, uscita 0 PASS / 1 FAIL / 2 input sbagliato), la baseline in quella cartella e la procedura di cattura dello Step 9 del Task 3; `docs/plans/assets/2026-09-27-transparent-sort-bench.js` (opzioni in `window.__benchOpts = { label, sizes? }`; JSON `{ label, …, results: [{ N, zMode, forward, total, sort, … }] }`) e `…-bench-step0.json` (Task 2); il flag `?bench` (Task 1);
  - gli slot di pezzo e `PieceReloadCollector` (Task 7).
- Produces:
  - `DUMP_WGSL_DIR=<dir assoluta> npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts` → in `<dir>`: `type-0-quad.wgsl`, `type-1-line.wgsl`, `type-2-msdf-text.wgsl`, `type-3-bezier.wgsl`, `type-4-gradient.wgsl`, `type-5-box-shadow.wgsl`, `uber.wgsl`
  - `node scripts/validate-wgsl-naga.mjs <dir>` → exit 0 se tutti i `.wgsl` sono validi, 1 se uno non lo è, 2 per un problema d'uso (niente dir, niente file, naga assente)
  - `docs/plans/assets/2026-09-27-transparent-sort-validate-wgsl.js` → `{ ok, adapter, results: [{ name, compileErrors, messages, pipelines, matchesPublished }] }`

- [ ] **Step 1: Scrivi il test che scrive i moduli composti**

Crea `ts/src/render/dump-composed-wgsl.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule, type PrimitivePieces,
} from './primitive-shaders';

// Dumps every WGSL module the engine composes, so a validator outside the
// browser can read it: `scripts/validate-wgsl-naga.mjs` runs naga (Firefox's
// WGSL front-end) on the directory. Nothing is written unless DUMP_WGSL_DIR
// names that directory (absolute path):
//
//   D="$(mktemp -d)" && DUMP_WGSL_DIR="$D" npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts \
//     && node scripts/validate-wgsl-naga.mjs "$D"

const DUMP_DIR = process.env.DUMP_WGSL_DIR;

const pieceFiles = import.meta.glob('../shaders/primitives/*.wgsl', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

function piece(name: string): string {
  const src = pieceFiles[`../shaders/primitives/${name}.wgsl`];
  if (src === undefined) throw new Error(`missing piece: shaders/primitives/${name}.wgsl`);
  return src;
}

/** Every composed module, by the file name it is dumped under. */
function composedModules(): Array<[file: string, code: string]> {
  const pieces: PrimitivePieces = { prelude: piece('prelude'), libraries: {} };
  for (const lib of PRIMITIVE_LIBRARIES) pieces.libraries[lib.type] = piece(lib.name);
  const typeModules = composeTypeModules(pieces);
  return [
    ...PRIMITIVE_LIBRARIES.map((lib): [string, string] => [`type-${lib.type}-${lib.name}.wgsl`, typeModules[lib.type]]),
    ['uber.wgsl', composeUberModule(pieces)],
  ];
}

describe('composed WGSL modules for external validators', () => {
  it('one module per primitive library plus the uber, each named once', () => {
    const files = composedModules().map(([file]) => file);
    expect(files).toEqual([
      'type-0-quad.wgsl', 'type-1-line.wgsl', 'type-2-msdf-text.wgsl',
      'type-3-bezier.wgsl', 'type-4-gradient.wgsl', 'type-5-box-shadow.wgsl', 'uber.wgsl',
    ]);
    for (const [, code] of composedModules()) expect(code.trim()).not.toBe('');
  });

  it.skipIf(!DUMP_DIR)('writes them to DUMP_WGSL_DIR', () => {
    const dir = DUMP_DIR!;
    mkdirSync(dir, { recursive: true });
    for (const [file, code] of composedModules()) writeFileSync(join(dir, file), code);
    expect(composedModules()).toHaveLength(7);
  });
});
```

È uno strumento, non un comportamento nuovo: il test passa subito, e verifica che i pezzi su disco si compongano nei sette moduli.

- [ ] **Step 2: Esegui il test senza e con `DUMP_WGSL_DIR`**

Run: `npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts`
Expected: PASS, `Tests 1 passed | 1 skipped (2)`: senza la variabile non si scrive niente.

Run: `D="$(mktemp -d)" && DUMP_WGSL_DIR="$D" npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts && ls "$D"`
Expected: PASS, `Tests 2 passed (2)`, e `ls` elenca `type-0-quad.wgsl type-1-line.wgsl type-2-msdf-text.wgsl type-3-bezier.wgsl type-4-gradient.wgsl type-5-box-shadow.wgsl uber.wgsl`. `head -1 "$D/uber.wgsl"` stampa `diagnostic(off, derivative_uniformity);`.

- [ ] **Step 3: Installa naga**

Run: `cargo install naga-cli --locked && cargo install --list | grep -E '^naga-cli'`
Expected: una riga `naga-cli v<versione>:`, con versione ≥ 23 (la direttiva globale `diagnostic` è entrata con la PR #6148). Con una versione più vecchia la validazione dell'uber fallisce per la direttiva e il cancello non dice niente: in quel caso aggiorna (`cargo install naga-cli --locked --force`).

- [ ] **Step 4: Lo script naga non esiste ancora**

Run: `node scripts/validate-wgsl-naga.mjs /tmp; echo "exit $?"`
Expected: `Error: Cannot find module '…/scripts/validate-wgsl-naga.mjs'` ed `exit 1`.

- [ ] **Step 5: Scrivi lo script**

Crea `scripts/validate-wgsl-naga.mjs`:

```js
// Validate every .wgsl file of a directory with naga, the WGSL front-end
// Firefox uses (Phase 5b, spec §7.3.2).
//
//   node scripts/validate-wgsl-naga.mjs <dir>
//
// The composed primitive modules exist only as TypeScript output, so a vitest
// file writes them first:
//
//   D="$(mktemp -d)"
//   DUMP_WGSL_DIR="$D" npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts
//   node scripts/validate-wgsl-naga.mjs "$D"
//
// naga comes from `cargo install naga-cli --locked` (the `diagnostic`
// directive the uber module starts with needs naga 23 or later). With an
// input file and no output file, naga parses and validates it: exit status 0
// and "Validation successful" when it is valid, non-zero with the error
// otherwise.
//
// Exit status: 0 when every file validates, 1 when any does not, 2 on a
// usage problem (no directory, no .wgsl file, naga not installed).
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/validate-wgsl-naga.mjs <dir>');
  process.exit(2);
}
const root = resolve(dir);
const files = readdirSync(root).filter((f) => f.endsWith('.wgsl')).sort();
if (files.length === 0) {
  console.error(`no .wgsl file in ${root}`);
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  const run = spawnSync('naga', [join(root, file)], { encoding: 'utf8' });
  if (run.error) {
    console.error(`cannot run naga (${run.error.message}): cargo install naga-cli --locked`);
    process.exit(2);
  }
  const ok = run.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}`);
  if (!ok) {
    failed++;
    const output = `${run.stdout}${run.stderr}`.trim();
    console.log(output.split('\n').map((line) => `     ${line}`).join('\n'));
  }
}
console.log(`${files.length - failed}/${files.length} valid (naga)`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 6: Fai scattare lo script, poi verifica il caso valido**

Uno script che fallisce presto esce senza output, e questo non si distingue da "tutto valido" (CLAUDE.md, hook): va visto fallire.

Run:

```bash
T="$(mktemp -d)" \
  && printf 'fn f() -> u32 { return 1.0; }\n' > "$T/broken.wgsl" \
  && printf '@compute @workgroup_size(1)\nfn main() {}\n' > "$T/valid.wgsl"; \
node scripts/validate-wgsl-naga.mjs "$T"; echo "exit $?"; \
rm "$T/broken.wgsl"; node scripts/validate-wgsl-naga.mjs "$T"; echo "exit $?"; \
node scripts/validate-wgsl-naga.mjs; echo "exit $?"
```

Expected: prima corsa `FAIL broken.wgsl` con l'errore di naga indentato sotto (un valore float restituito da una funzione `-> u32`), `ok   valid.wgsl`, `1/2 valid (naga)`, `exit 1`; seconda `ok   valid.wgsl`, `1/1 valid (naga)`, `exit 0`; terza `usage: node scripts/validate-wgsl-naga.mjs <dir>`, `exit 2`.

- [ ] **Step 7: Commit degli strumenti**

```bash
git add ts/src/render/dump-composed-wgsl.test.ts scripts/validate-wgsl-naga.mjs
git commit -m "test(5b): dump dei moduli composti (DUMP_WGSL_DIR) e validazione naga

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: naga sui sette moduli composti (Firefox, bloccante)**

Run:

```bash
STEP1=docs/plans/assets/2026-09-27-transparent-sort-step1 && mkdir -p "$STEP1" \
  && D="$(mktemp -d)" \
  && DUMP_WGSL_DIR="$D" npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts \
  && { cargo install --list | grep -E '^naga-cli'; node scripts/validate-wgsl-naga.mjs "$D"; } > "$STEP1/naga.txt" 2>&1; \
echo "exit $?"; cat "$STEP1/naga.txt"
```

Expected: `exit 0`; `naga.txt` contiene la riga `naga-cli v…:`, `ok` per i 7 file, poi `7/7 valid (naga)`.

Per il confronto, valida anche i sei shader vecchi del commit base (quelli eliminati dal Task 6):

```bash
STEP1=docs/plans/assets/2026-09-27-transparent-sort-step1 && OLD="$(mktemp -d)" \
  && for f in basic line msdf-text bezier gradient box-shadow; do git show "72c0f7e:ts/src/shaders/$f.wgsl" > "$OLD/old-$f.wgsl"; done \
  && node scripts/validate-wgsl-naga.mjs "$OLD" > "$STEP1/naga-base.txt" 2>&1; \
echo "exit $?"; cat "$STEP1/naga-base.txt"
```

Expected: di norma `6/6 valid (naga)`. Serve solo a classificare un errore, non è un cancello.

Se `naga.txt` ha anche un solo `FAIL`, il passo 1 è bloccato. Per capire da dove viene, confronta con `naga-base.txt`:
- l'errore non c'è nel file vecchio corrispondente (`type-0-quad` ↔ `old-basic`, `type-1-line` ↔ `old-line`, …; per `uber.wgsl` ↔ tutti e sei) → è della composizione: correggi il pezzo (o il compositore del Task 5), rifai il Task 8 dallo Step 8;
- lo stesso errore c'è già nel file vecchio → non è della fase 5b, ma il cancello resta bloccante per la spec (§8 riga 1): fermati e porta all'utente l'errore di naga, il costrutto e il file vecchio che ce l'ha.

- [ ] **Step 9: Scrivi lo script di validazione per Chrome**

Crea `docs/plans/assets/2026-09-27-transparent-sort-validate-wgsl.js`:

```js
async () => {
  // Phase 5b, spec §7.3.2 — Chrome half of the WGSL gate. Paste this whole
  // file as the `function` of chrome-devtools evaluate_script, on the harness
  // page served by `npm run dev` (Mode B: its renderer, and so the
  // ForwardPass statics compared below, live on the main thread).
  //
  // It composes the seven primitive modules from the pieces on disk, compiles
  // each one (getCompilationInfo) and builds every pipeline the engine builds
  // from it inside error scopes: per type the opaque and transparent forward
  // pipelines (three groups) and the occluder pipeline (two groups,
  // OCCLUDER_PASS = 1, fs_occluder); for the uber the transparent one. It
  // also checks the text against the modules the renderer published.
  //
  // A FRESH adapter and device: the harness device is left alone (an adapter
  // is consumed by requestDevice, so one requestAdapter per device).
  const { PRIMITIVE_LIBRARIES, composeTypeModules, composeUberModule } = await import('/src/render/primitive-shaders.ts');
  const { primitiveGroup0LayoutEntries, textureTierLayoutEntries } = await import('/src/render/primitive-bindings.ts');
  const { SCENE_HDR_FORMAT, JFA_FORMAT } = await import('/src/render/formats.ts');
  const { ForwardPass } = await import('/src/render/passes/forward-pass.ts');
  const raw = async (name) => (await import(`/src/shaders/primitives/${name}.wgsl?raw`)).default;

  const pieces = { prelude: await raw('prelude'), libraries: {} };
  for (const lib of PRIMITIVE_LIBRARIES) pieces.libraries[lib.type] = await raw(lib.name);
  const typeModules = composeTypeModules(pieces);
  const uberModule = composeUberModule(pieces);

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
  const device = await adapter.requestDevice();
  const g0 = device.createBindGroupLayout({ entries: primitiveGroup0LayoutEntries() });
  const g1 = device.createBindGroupLayout({ entries: textureTierLayoutEntries() });
  // Group 2 as ForwardPass declares it: the light buffer (2d-array), its sampler, LightingUniform.
  const g2 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const forwardLayout = device.createPipelineLayout({ bindGroupLayouts: [g0, g1, g2] });
  const occluderLayout = device.createPipelineLayout({ bindGroupLayouts: [g0, g1] });
  const vertex = (module, constants) => ({
    module, entryPoint: 'vs_main', constants,
    buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
  });
  const primitive = { topology: 'triangle-list', cullMode: 'back' };
  const blend = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
  const descriptors = {
    opaque: (module) => ({
      layout: forwardLayout, vertex: vertex(module), primitive,
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: SCENE_HDR_FORMAT }] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    }),
    transparent: (module) => ({
      layout: forwardLayout, vertex: vertex(module), primitive,
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: SCENE_HDR_FORMAT, blend }] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
    }),
    occluder: (module) => ({
      layout: occluderLayout, vertex: vertex(module, { OCCLUDER_PASS: 1 }), primitive,
      fragment: { module, entryPoint: 'fs_occluder', targets: [{ format: JFA_FORMAT }] },
    }),
  };
  /** Run fn inside validation + internal error scopes; the messages, empty when clean. */
  const scoped = async (fn) => {
    device.pushErrorScope('internal');
    device.pushErrorScope('validation');
    let thrown = null;
    try { fn(); } catch (err) { thrown = err; }
    const validation = await device.popErrorScope();
    const internal = await device.popErrorScope();
    return [thrown && String(thrown), validation?.message, internal?.message].filter(Boolean);
  };
  const check = async (name, code, kinds, published) => {
    let module = null;
    const moduleErrors = await scoped(() => { module = device.createShaderModule({ code }); });
    const info = await module.getCompilationInfo();
    const pipelines = {};
    for (const kind of kinds) pipelines[kind] = await scoped(() => device.createRenderPipeline(descriptors[kind](module)));
    return {
      name,
      compileErrors: info.messages.filter((m) => m.type === 'error').length + moduleErrors.length,
      messages: [
        ...info.messages.map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`),
        ...moduleErrors,
      ],
      pipelines,
      matchesPublished: published === code,
    };
  };

  const results = [];
  for (const lib of PRIMITIVE_LIBRARIES) {
    results.push(await check(`type-${lib.type}-${lib.name}`, typeModules[lib.type],
      ['opaque', 'transparent', 'occluder'], ForwardPass.SHADER_SOURCES[lib.type]));
  }
  results.push(await check('uber', uberModule, ['transparent'], ForwardPass.UBER_SOURCE));
  const { vendor, architecture, description } = adapter.info;
  device.destroy();
  const ok = results.every((r) => r.compileErrors === 0
    && Object.values(r.pipelines).every((errors) => errors.length === 0)
    && r.matchesPublished);
  return { ok, adapter: { vendor, architecture, description }, results };
}
```

I descrittori sono quelli di `ForwardPass.setup` (opaco, trasparente, uber) e di `OccluderSeedStage.setup` (occluder, due gruppi, `OCCLUDER_PASS: 1`): se il Task 6 li ha cambiati, allinea lo script al codice prima di eseguirlo.

- [ ] **Step 10: Test headless e preparazione della GPU**

Run: `scripts/preflight.sh`
Expected: `Tutti i controlli sono verdi.`

Carica la skill `/gpu-check` (Skill tool, `gpu-check`) e seguine i punti 1-3, con queste precisazioni:
1. WASM: `find crates/hyperion-core/src crates/hyperion-core/Cargo.toml -newer ts/wasm/hyperion_core_bg.wasm \( -name '*.rs' -o -name Cargo.toml \) | head -3`; se stampa qualcosa, `npm --prefix ts run build:wasm`.
2. Dev server: il Task 6 ha eliminato sei shader e ne ha creati sette, quindi va **riavviato**. Se l'hai avviato tu in questa sessione, ferma il task in background; se risponde su 5173 un server di un'altra sessione, `pkill -f 'vite --strictPort --port 5173'`. Poi avvialo in background: `npm --prefix ts run dev -- --strictPort --port 5173`, e aspetta che `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/` stampi `200`.
3. `mcp__chrome-devtools-gpu__list_pages`: usa il `pageId` della pagina selezionata in tutte le chiamate che seguono (se non c'è una pagina, `new_page` con `url: "about:blank"`), e `waitForStableDom: false` su ogni `evaluate_script`: il pannello dei check si ridisegna ogni 500 ms e l'HUD a ogni frame, quindi il DOM non si assesta mai e ogni chiamata aspetterebbe il timeout.

- [ ] **Step 11: Carica l'harness in Mode B e controlla la console**

1. `mcp__chrome-devtools-gpu__resize_page` con `width: 1920`, `height: 1080`.
2. `mcp__chrome-devtools-gpu__navigate_page` con `type: "url"`, `url: "http://localhost:5173/?mode=B"`, `ignoreCache: true` e l'initScript low-power.
3. `mcp__chrome-devtools-gpu__list_console_messages` con `types: ["log", "info", "warn", "error"]`.

Expected: la riga dell'adapter dice AMD (non nvidia, non SwiftShader); `[Hyperion] Harness execution mode: B`; nessun errore di WebGPU, di validazione, di pipeline o di render graph. Dal passo 1 `ForwardPass.setup` costruisce l'uber anche nel grafo iniziale, e gli errori di quel grafo finiscono in console (`onError`): una direttiva o un modulo rifiutati si vedrebbero qui. L'unico errore ammesso è il 404 di `favicon.ico`.

- [ ] **Step 12: Validazione su Chrome dei sette moduli (bloccante)**

`mcp__chrome-devtools-gpu__evaluate_script` passando `docs/plans/assets/2026-09-27-transparent-sort-validate-wgsl.js` come `function`, con `filePath: "/home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-step1/chrome-wgsl.json"`.

Expected, in `chrome-wgsl.json`:
- `ok: true`, `adapter.vendor` = `"amd"`;
- 7 voci in `results` (`type-0-quad` … `type-5-box-shadow`, `uber`), ognuna con `compileErrors: 0`, `messages: []`, ogni array di `pipelines` vuoto (`opaque`, `transparent`, `occluder` per i sei moduli per tipo; `transparent` per l'uber) e `matchesPublished: true`.

Se `messages` contiene solo warning (`warning …`), il cancello passa ma i warning vanno riportati all'utente. Se `matchesPublished` è `false` per tutte e sette le voci, la pagina non ha il renderer sul main thread (non è Mode B) oppure un pezzo è stato modificato dopo il caricamento: ricarica con lo Step 11 e ripeti. Qualunque altro errore blocca il passo 1: le righe di `messages` hanno `riga:colonna` nel modulo composto, e i marcatori `// --- piece: <nome> ---` dicono in quale pezzo cade.

- [ ] **Step 13: Cattura in Mode B e confronto con la baseline (bloccante)**

La cattura deve essere IDENTICA a quella della baseline (spec §7.3.1): è la procedura dello Step 9 del Task 3 alla lettera, con `MODE = B` e `DIR = /home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-step1` (la cartella esiste dallo Step 8). Ogni chiamata MCP porta il `pageId` dello Step 10; ogni `evaluate_script` anche `waitForStableDom: false`.

1. `resize_page` con `pageId`, `width: 1920`, `height: 1080` (PRIMA della navigazione).
2. `navigate_page` con `pageId`, `type: "url"`, `url: "http://localhost:5173/?mode=B&bench"`, `ignoreCache: true` e l'initScript low-power. Navigazione sempre nuova: senza `?bench` `capture.js` lancia `capture from a ?bench page` alla prima chiamata, e l'harness aprirebbe Primitives da solo, fuori dal `setup()` avvolto dalla cattura.
3. `list_console_messages` con `pageId`, `types: ["info", "warn"]` → `[Hyperion] WebGPU adapter: amd / …` (non nvidia, non SwiftShader), `[Hyperion] Harness execution mode: B` e `[Hyperion] ?bench: no section opened; window.__hyperion is the engine`.
4. Per ogni chiave K, in quest'ordine: `primitives`, `scene-graph`, `input`, `audio`, `particles`, `rendering-fx`, `lighting`, `debug-tools`, `lifecycle`, `twin-2d`:
   - `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__captureOpts = { tab: 'K' }; return true; }"` (con la chiave vera al posto di `K`);
   - `evaluate_script` con `pageId`, `waitForStableDom: false`, `function` = il contenuto di `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js` alla lettera, `filePath: "/home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-step1/B-K.json"`.
5. Gli stati, nella stessa pagina:
   - `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__captureOpts = { statuses: true }; return true; }"`;
   - `evaluate_script` con `pageId`, `waitForStableDom: false`, `function` = `capture.js` alla lettera, `filePath: "/home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-step1/statuses-B.json"`.
6. Se una chiamata restituisce un errore, la cattura è da buttare: si riparte dal punto 2 (navigazione nuova) e si riscrivono tutti i file `B-*.json` e `statuses-B.json` di `…-step1/`.
7. Confronta (CLI del Task 3: niente argomenti posizionali; al passo 1 nessun check è nuovo, quindi niente `--allow-new-skip`):

```bash
BASE=docs/plans/assets/2026-09-27-transparent-sort-baseline && STEP1=docs/plans/assets/2026-09-27-transparent-sort-step1 \
  && node "$BASE/compare.mjs" --base "$BASE" --run "$STEP1" --mode B --step 1 > "$STEP1/compare-B.txt"; \
echo "exit $?"; cat "$STEP1/compare-B.txt"
```

Expected: `exit 0`; per ogni tab una riga `B <tab> OK  C=… (grid N/2304) …`, Lighting `excluded (Lighting: statuses only)`, poi `B statuses      OK` e `PASS`. Un `exit 2` è un problema d'uso (argomenti, un file mancante o illeggibile): la riga di errore dice quale. Nel merito il report dice (spec §7.3.5, passo 1):
- **stati**: nessun check fallito; ogni tab ha gli stessi check in skip e in pending della baseline; ogni check che passava passa ancora; Scene Graph 'Velocity' e Lighting 'Backend lit' arrivano a pass; Input resta 2/6 con i 4 check d'interazione in pending; Rendering FX ha 'Tonemap switch' in skip;
- **pixel**: tutti i punti di C = S_base ∩ S_run \ (M_base ∪ M_run) identici al bit (f16), in ogni tab; il tab Lighting non contribuisce punti.

Un punto di C diverso, o uno stato diverso, blocca il passo 1 (spec §10: "La composizione cambia gli ultimi bit dei vertici … una differenza si spiega prima di andare avanti"). Riporta tab, punti e valori, e spiega la causa prima di proseguire.

- [ ] **Step 14: Cattura in Mode C e confronto (bloccante)**

La stessa procedura dello Step 13 (Step 9 del Task 3 alla lettera), con `MODE = C` e la stessa `DIR`, su una pagina nuova; `pageId` su ogni chiamata MCP e `waitForStableDom: false` su ogni `evaluate_script`:

1. `resize_page` con `pageId`, `width: 1920`, `height: 1080`.
2. `navigate_page` con `pageId`, `type: "url"`, `url: "http://localhost:5173/?mode=C&bench"`, `ignoreCache: true` e l'initScript low-power.
3. `list_console_messages` con `pageId`, `types: ["info", "warn"]` → adapter `amd`, `[Hyperion] Harness execution mode: C` e la riga `[Hyperion] ?bench: no section opened; window.__hyperion is the engine`.
4. Per ogni chiave K nell'ordine `primitives`, `scene-graph`, `input`, `audio`, `particles`, `rendering-fx`, `lighting`, `debug-tools`, `lifecycle`, `twin-2d`:
   - `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__captureOpts = { tab: 'K' }; return true; }"`;
   - `evaluate_script` con `pageId`, `waitForStableDom: false`, `function` = `capture.js` alla lettera, `filePath: "/home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-step1/C-K.json"`.
5. Gli stati: `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__captureOpts = { statuses: true }; return true; }"`, poi `capture.js` alla lettera (stessi parametri) con `filePath: "/home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-step1/statuses-C.json"`.
6. Su un errore di una chiamata: da capo dal punto 2, riscrivendo tutti i file `C-*.json` e `statuses-C.json`.
7. Confronta:

```bash
BASE=docs/plans/assets/2026-09-27-transparent-sort-baseline && STEP1=docs/plans/assets/2026-09-27-transparent-sort-step1 \
  && node "$BASE/compare.mjs" --base "$BASE" --run "$STEP1" --mode C --step 1 > "$STEP1/compare-C.txt"; \
echo "exit $?"; cat "$STEP1/compare-C.txt"
```

Expected: `exit 0`, righe `C <tab> OK …`, `C statuses      OK` e `PASS`, con gli stessi criteri dello Step 13; in più, in 2D Twins, il check delle righe in scatter del Mode C passa come nella baseline (in Mode C lo scatter c'è davvero).

Poi `list_console_messages` con `types: ["error", "warn"]`: niente oltre al 404 di `favicon.ico`, nessun warning del LeakDetector, nessun `hook … threw`.

- [ ] **Step 15: Benchmark del passo 1**

Ogni chiamata MCP porta il `pageId` dello Step 10, ogni `evaluate_script` anche `waitForStableDom: false` (come nello Step 4 del Task 2).

1. `resize_page` con `pageId`, `width: 1920`, `height: 1080`; `navigate_page` con `pageId`, `type: "url"`, `url: "http://localhost:5173/?mode=B&bench"`, `ignoreCache: true` e l'initScript (URL e modo sono quelli del passo 0, Task 2); `list_console_messages` con `types: ["info", "warn"]` → adapter `amd` e la riga `?bench`.
2. Bash: `git rev-parse --short HEAD` → `<SHA>`. Poi `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__benchOpts = { label: 'step1 <SHA>' }; return true; }"` (con lo SHA vero al posto di `<SHA>`).
3. `evaluate_script` con `pageId`, `waitForStableDom: false`, `function` = il contenuto di `docs/plans/assets/2026-09-27-transparent-sort-bench.js` alla lettera, `filePath: "/home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-bench-step1.json"`. Se la chiamata va in timeout, non continuare su quella pagina: rifai il punto 1, poi tre coppie di chiamate per N = 1000, 10000, 100000 in quest'ordine, `window.__benchOpts = { label: 'step1 <SHA>', sizes: [N] }` e poi lo scenario con lo stesso `filePath` (ogni chiamata restituisce tutti i risultati accumulati, quindi l'ultimo file li contiene tutti e sei), come nello Step 4.4 del Task 2.

Expected: il file ha gli stessi sei casi di `…-bench-step0.json` (N = 1 000, 10 000, 100 000; `zMode` `same` e `distinct`), con `label: "step1 <SHA>"` e, per caso, la media del `forward` e del `total`. Non c'è una soglia al passo 1 (spec §7.3.6): la differenza passo 1 − passo 0 del `forward` è il costo della composizione (moduli composti, `VertexOutput` più largo). Va letta insieme a quella del `total`: il profiler separa i pass con compute pass vuoti e parte dei frammenti del forward può cadere nel pass successivo (nota dello Step 5 del Task 2).

4. Scrivi `docs/plans/assets/2026-09-27-transparent-sort-step1/forward-vs-step0.txt` dai due JSON, per caso `(N, zMode)`: gli argomenti sono i passi da mettere a confronto, e con un passo ≥ 3 lo script aggiunge le colonne `sort` e controlla il sort a 100 000. Run, dalla radice del repo:

```bash
node - 0 1 > docs/plans/assets/2026-09-27-transparent-sort-step1/forward-vs-step0.txt <<'EOF'
const fs = require('node:fs');
const steps = process.argv.slice(2).map(Number);
const load = (s) => {
  const j = JSON.parse(fs.readFileSync(`docs/plans/assets/2026-09-27-transparent-sort-bench-step${s}.json`, 'utf8'));
  return { label: j.label, byCase: new Map(j.results.map((r) => [`${r.N}/${r.zMode}`, r])) };
};
const runs = steps.map(load);
const at = (s) => runs[steps.indexOf(s)];
const f = (x) => (typeof x === 'number' ? x.toFixed(3) : '—');
const d = (a, b) => (typeof a === 'number' && typeof b === 'number' ? (a - b).toFixed(3) : '—');
const pairs = [[1, 0], [4, 3]].filter(([a, b]) => steps.includes(a) && steps.includes(b));
runs.forEach((r, i) => console.log(`step${steps[i]} label: ${r.label}`));
console.log(['N/zMode', ...steps.map((s) => `forward${s}`), ...pairs.map(([a, b]) => `Δfwd${a}-${b}`), ...steps.map((s) => `total${s}`), ...pairs.map(([a, b]) => `Δtot${a}-${b}`), ...steps.filter((s) => s >= 3).map((s) => `sort${s}`)].join('\t'));
const bad = [];
for (const k of runs[0].byCase.keys()) {
  const r = (s) => at(s).byCase.get(k);
  for (const s of steps) if (!r(s)) bad.push(`step${s} has no ${k}`);
  console.log([k, ...steps.map((s) => f(r(s)?.forward)), ...pairs.map(([a, b]) => d(r(a)?.forward, r(b)?.forward)),
    ...steps.map((s) => f(r(s)?.total)), ...pairs.map(([a, b]) => d(r(a)?.total, r(b)?.total)),
    ...steps.filter((s) => s >= 3).map((s) => f(r(s)?.sort))].join('\t'));
  // typeof first: `null < 1` is true in JS.
  for (const s of steps.filter((s) => s >= 3)) if (k.startsWith('100000/') && !(typeof r(s)?.sort === 'number' && r(s).sort < 1)) bad.push(`step${s} ${k} sort ${r(s)?.sort}`);
}
if (bad.length) { console.error('BAD: ' + bad.join('; ')); process.exit(1); }
EOF
echo "exit $?"; cat docs/plans/assets/2026-09-27-transparent-sort-step1/forward-vs-step0.txt
```

Expected: `exit 0`; le righe `step0 label: step0 …` e `step1 label: step1 <SHA>` (un `null` vuol dire che il punto 2 è saltato: rifai il benchmark), l'intestazione `N/zMode forward0 forward1 Δfwd1-0 total0 total1 Δtot1-0`, poi sei righe `1000/same` … `100000/distinct` senza `—`. Un `BAD: step1 has no …` (exit 1) vuol dire un caso mancante: rifai il benchmark. Lo Step 20 mette il file nel messaggio di commit.

- [ ] **Step 16: HMR — pagina pulita e stato di partenza**

1. `navigate_page` a `http://localhost:5173/?mode=B` con `ignoreCache: true` e l'initScript; `list_console_messages` → adapter AMD.
2. `evaluate_script` con `function: "async () => { document.querySelectorAll('.tab')[0].click(); await new Promise((r) => setTimeout(r, 4000)); window.__hmrMarker = Date.now(); return window.__hmrMarker; }"` (tab Primitives, così la scena non è vuota; il marcatore sparisce solo se la pagina si ricarica).
3. `evaluate_script` con questo script di controllo (usalo identico negli Step 17-19):

```js
async () => {
  const { ForwardPass } = await import('/src/render/passes/forward-pass.ts');
  const modules = [0, 1, 2, 3, 4, 5].map((t) => ForwardPass.SHADER_SOURCES[t]);
  const has = (text) => ({
    types: modules.flatMap((m, t) => (m.includes(text) ? [t] : [])),
    uber: ForwardPass.UBER_SOURCE.includes(text),
  });
  const probe = await window.__hyperion.debug.probe({ target: 'scene-hdr', uv: [[0.5, 0.5]] });
  return {
    samePage: typeof window.__hmrMarker === 'number',
    rendering: probe.values.length === 1,
    smoke1: has('// hmr-smoke-1'),
    smoke3: has('// hmr-smoke-3'),
    renamed: has('applyLightingHmr'),
    oldName: has('applyLighting('),
    broken: has('line_hmr_broken'),
  };
}
```

Expected: `samePage: true`, `rendering: true`; `smoke1`, `smoke3`, `renamed`, `broken` tutti `{ types: [], uber: false }`; `oldName: { types: [0, 1, 2, 3, 4, 5], uber: true }` (la dichiarazione `fn applyLighting(` sta nel preludio, quindi in ogni modulo).

Controlla anche che `applyLighting` compaia solo nei pezzi attesi: `grep -l 'applyLighting' ts/src/shaders/primitives/*.wgsl` → `prelude.wgsl`, `quad.wgsl`, `gradient.wgsl` (spec §3.1: la chiamano solo `quad_fs` e `gradient_fs`).

Ogni Step 17-19 modifica i pezzi SOLO con comandi che scrivono il file sul posto, in un unico comando per "salvataggio", aspetta 5 s (probe dell'unione + probe singoli + ricostruzione del grafo) e poi legge `list_console_messages` con `types: ["log", "warn", "error"]`, guardando solo le righe nuove.

- [ ] **Step 17: HMR — una libreria sola**

Run: `printf '\n// hmr-smoke-1\n' >> ts/src/shaders/primitives/quad.wgsl`

Expected dopo 5 s: una riga nuova `[Hyperion] Shader "quad" hot-reloaded`, nessun errore; lo script di controllo dà `samePage: true`, `rendering: true`, `smoke1: { types: [0], uber: true }`.

Run: `git checkout -- ts/src/shaders/primitives/quad.wgsl`

Expected dopo 5 s: di nuovo `[Hyperion] Shader "quad" hot-reloaded`; `smoke1: { types: [], uber: false }`.

- [ ] **Step 18: HMR — rinomina accoppiata nel preludio e nelle librerie, in un solo salvataggio**

Rinomina `applyLighting` in `applyLightingHmr` in tutti i pezzi che la nominano, con un solo comando (scritture sul posto, a pochi ms l'una dall'altra):

```bash
node -e "const fs=require('fs');for(const f of process.argv.slice(1)){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\bapplyLighting\b/g,'applyLightingHmr'));}" $(grep -l 'applyLighting' ts/src/shaders/primitives/*.wgsl)
```

Nessuno dei tre file passerebbe da solo: il preludio rinominato rompe le chiamate vecchie, e le librerie chiamano un nome che il preludio vecchio non ha.

Expected dopo 5 s: UNA sola riga nuova `[Hyperion] Shaders … hot-reloaded` che nomina `"prelude"`, `"quad"` e `"gradient"` (in qualunque ordine); nessuna riga `rejected`, `compile alone but not together` o `did not compile`. Lo script di controllo dà `samePage: true`, `rendering: true`, `renamed: { types: [0, 1, 2, 3, 4, 5], uber: true }`, `oldName: { types: [], uber: false }`.

Se invece compaiono verdetti separati (per esempio due `rejected` e nessun `hot-reloaded`), gli update di Vite sono arrivati a più di 50 ms l'uno dall'altro: annota i tempi delle righe `[vite] hot updated` e fermati, perché la durata della finestra è una decisione della spec (§3.3) da riportare all'utente.

Run: `git checkout -- ts/src/shaders/primitives/`

Expected dopo 5 s: di nuovo una sola riga `[Hyperion] Shaders … hot-reloaded` con i tre pezzi; `renamed: { types: [], uber: false }`, `oldName: { types: [0, 1, 2, 3, 4, 5], uber: true }`.

- [ ] **Step 19: HMR — un pezzo rotto e uno valido indipendente, in un solo salvataggio**

```bash
node -e "const fs=require('fs');fs.appendFileSync('ts/src/shaders/primitives/line.wgsl','\nfn line_hmr_broken( {\n');fs.appendFileSync('ts/src/shaders/primitives/quad.wgsl','\n// hmr-smoke-3\n');"
```

Expected dopo 5 s: `[Hyperion] Shader "line" rejected by the GPU — keeping the previous source:` seguito dall'errore di parsing WGSL, e `[Hyperion] Shader "quad" hot-reloaded`. Lo script di controllo dà `samePage: true`, `rendering: true`, `smoke3: { types: [0], uber: true }`, `broken: { types: [], uber: false }`.

Run: `git checkout -- ts/src/shaders/primitives/ && git diff --exit-code ts/src/shaders/primitives; echo "exit $?"`

Expected: `exit 0`; dopo 5 s una riga `hot-reloaded` che nomina `"quad"` (e `"line"`, se Vite rimanda anche il file tornato identico alla sorgente buona); `smoke3: { types: [], uber: false }`, `samePage: true`.

- [ ] **Step 20: Registra l'HMR, controlla la console e committa i risultati**

1. Scrivi `docs/plans/assets/2026-09-27-transparent-sort-step1/hmr-smoke.txt` con, per ciascuno degli Step 17-19, il comando eseguito, le righe di console nuove che ha prodotto e il risultato dello script di controllo.
2. `list_console_messages` con `types: ["error", "warn"]`: nessun `Device is lost`, nessun `VK_ERROR_…`, nessun errore di validazione fuori dai `rejected` voluti dello Step 19.
3. `git status --short`: devono comparire solo i file nuovi di `…-step1/` e `…-bench-step1.json` (più lo script dello Step 9); nessun file in `ts/`.

```bash
git add docs/plans/assets/2026-09-27-transparent-sort-validate-wgsl.js \
  docs/plans/assets/2026-09-27-transparent-sort-step1 \
  docs/plans/assets/2026-09-27-transparent-sort-bench-step1.json
git commit -F - <<EOF
docs(5b): cancello GPU del passo 1 — WGSL su Chrome e naga, stati e punti C, benchmark, HMR

Moduli composti validi su Chrome (AMD) e naga; stati e C identici alla
baseline in Mode B e C; HMR di un pezzo e reload raggruppato verificati.
forward, passo 1 contro passo 0:
$(cat docs/plans/assets/2026-09-27-transparent-sort-step1/forward-vs-step0.txt)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 9: Rust — ricalcolo `transparent_count`, `ids_generation`, esportazioni

Il sort dei trasparenti ha bisogno di due numeri dal motore (spec §4.1):
- **`transparent_count`**: quante righe vive hanno il bit 8 (`RENDER_META_TRANSPARENT_BIT`) nella parola 1 di `renderMeta`. Si **ricalcola** a ogni frame (D9), non si tiene un contatore: `clear_slot` gira dopo `gpu_count += 1` su una riga che può avere un bit 8 vecchio, e il componente `Transparent` è in anticipo di un frame sulla riga. Il conto si limita a `gpu_count`, perché le righe oltre contengono i dati delle entità despawnate.
- **`ids_generation`**: cambia in ogni frame in cui la mappatura slot → id esterno è cambiata. Vive in **`Engine`**, non in `RenderState`, perché `reset` e `snapshot_restore` ricreano `RenderState`: un contatore lì ripartirebbe da 0 e potrebbe coincidere con il valore già caricato in TS. `RenderState` alza solo un flag (`ids_changed`) in tre punti (`assign_slot` dopo l'early return idempotente, `flush_pending_despawns` quando toglie una riga, `collect_gpu`); `Engine::update` lo consuma e incrementa al massimo una volta per frame.

I numeri di riga sono quelli di `aa9ee92`; i Task 1-8 non toccano questi tre file. L'hook `post-edit-rust.sh` lancia clippy a ogni modifica di un `.rs`: negli step di RED mostra gli stessi errori di compilazione dei test, ed è atteso.

**Files:**
- Modify: `crates/hyperion-core/src/render_state.rs` — struct `RenderState` (ultimo campo a L206), `RenderState::new()` (L241), `collect_gpu` (L285-384), `assign_slot` (L551-552), `flush_pending_despawns` (L792), `collect_and_cache_dirty` (L1011-1018)
- Modify: `crates/hyperion-core/src/engine.rs` — struct `Engine` (L59), `Engine::new()` (L87), `update()` (L238), getter `lighting_backend()` (L421-423), `reset()` (L452), `snapshot_restore()` (L1001-1006)
- Modify: `crates/hyperion-core/src/lib.rs` — dopo `engine_gpu_entity_ids_len` (L295-304)
- Test: `crates/hyperion-core/src/render_state.rs` (`mod tests`, fine file L2344), `crates/hyperion-core/src/engine.rs` (`mod tests`, fine file L2999)

**Interfaces:**
- Consumes: `RENDER_META_TRANSPARENT_BIT` (`components.rs`, già importato in `render_state.rs`); `RenderState::{assign_slot, queue_despawn, flush_pending_despawns, collect_gpu, collect_and_cache_dirty, get_slot}` esistenti; gli helper di test `spawn_cmd`, `make_position_cmd` di `engine.rs`.
- Produces:
  - `pub fn recount_transparent(&mut self)` (RenderState)
  - `pub fn transparent_count(&self) -> u32` (RenderState)
  - `pub fn take_ids_changed(&mut self) -> bool` (RenderState)
  - `pub fn ids_generation(&self) -> u32` (Engine)
  - WASM: `#[wasm_bindgen] pub fn engine_gpu_transparent_count() -> u32` e `#[wasm_bindgen] pub fn engine_gpu_entity_ids_generation() -> u32`

- [ ] **Step 1: Scrivi i test di `RenderState` (flag degli id e ricalcolo)**

Incolla questo blocco in `crates/hyperion-core/src/render_state.rs` **prima dell'ultima `}` del file** (quella che chiude `mod tests`, subito dopo il test `zero_entity_frame_clears_the_tracker`). Gli helper hanno il suffisso `_5b` per non scontrarsi con quelli esistenti (`meta_word_for`).

```rust

    // --- Phase 5b: ids-changed flag and transparent recount (design §4.1) ---

    /// A 3D quad with an external id, transparent or not, ready for `write_slot`.
    fn quad_5b(world: &mut World, ext: u32, transparent: bool) -> hecs::Entity {
        let e = world.spawn((
            Position(Vec3::ZERO),
            Rotation(Quat::IDENTITY),
            Scale(Vec3::ONE),
            ModelMatrix([0.0; 16]),
            BoundingRadius(1.0),
            RenderPrimitive(0),
            Active,
            ExternalId(ext),
        ));
        if transparent {
            world.insert_one(e, Transparent(1)).unwrap();
        }
        e
    }

    /// Assign a slot and write the row, as the spawn path does.
    fn place_5b(rs: &mut RenderState, world: &World, e: hecs::Entity) -> u32 {
        let slot = rs.assign_slot(e);
        rs.write_slot(slot, world, e);
        slot
    }

    /// Brute force over the live rows only.
    fn brute_transparent_5b(rs: &RenderState) -> u32 {
        let n = rs.gpu_entity_count() as usize;
        (0..n)
            .filter(|&i| rs.gpu_render_meta[i * 2 + 1] & RENDER_META_TRANSPARENT_BIT != 0)
            .count() as u32
    }

    #[test]
    fn ids_changed_is_raised_by_assign_slot_but_not_by_an_idempotent_one() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        assert!(!rs.take_ids_changed(), "a new RenderState has nothing to report");
        let e = quad_5b(&mut world, 1, false);
        rs.assign_slot(e);
        assert!(rs.take_ids_changed());
        assert!(!rs.take_ids_changed(), "take resets the flag");
        rs.assign_slot(e); // idempotent: same slot back, mapping unchanged
        assert!(!rs.take_ids_changed());
    }

    #[test]
    fn ids_changed_is_raised_by_a_flush_that_removes_a_row_only() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let a = quad_5b(&mut world, 1, false);
        let b = quad_5b(&mut world, 2, false);
        place_5b(&mut rs, &world, a);
        place_5b(&mut rs, &world, b);
        let _ = rs.take_ids_changed();

        rs.flush_pending_despawns(); // nothing queued
        assert!(!rs.take_ids_changed(), "an empty flush changes nothing");

        // A queued slot the count has already shrunk past is skipped.
        rs.pending_despawns.push((a, 7));
        rs.flush_pending_despawns();
        assert!(!rs.take_ids_changed(), "a skipped slot removes no row");

        rs.queue_despawn(a);
        rs.flush_pending_despawns();
        assert!(rs.take_ids_changed());
        assert_eq!(rs.gpu_entity_ids[0], 2, "the last row moved into slot 0");
    }

    #[test]
    fn ids_changed_ignores_row_rewrites_staging_and_shrink() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let a = quad_5b(&mut world, 1, false);
        let b = quad_5b(&mut world, 2, true);
        let sa = place_5b(&mut rs, &world, a);
        place_5b(&mut rs, &world, b);
        rs.queue_despawn(b);
        rs.flush_pending_despawns();
        let _ = rs.take_ids_changed();

        rs.write_slot(sa, &world, a); // the owner rewrites its own row
        assert!(!rs.take_ids_changed(), "write_slot of the owner");
        rs.dirty_tracker.mark_meta_dirty(sa as usize);
        let _ = rs.collect_dirty_staging(&world);
        assert!(!rs.take_ids_changed(), "collect_dirty_staging without a mapping change");
        rs.shrink_to_fit();
        assert!(!rs.take_ids_changed(), "shrink_to_fit drops only the dead tail");
    }

    #[test]
    fn ids_changed_is_raised_by_collect_gpu() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        quad_5b(&mut world, 1, false);
        rs.collect_gpu(&world);
        assert!(rs.take_ids_changed());
    }

    #[test]
    fn recount_sees_a_transparent_last_row_moved_into_an_opaque_dead_slot() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let a = quad_5b(&mut world, 1, false);
        let dead = quad_5b(&mut world, 2, false);
        let last = quad_5b(&mut world, 3, true);
        for e in [a, dead, last] {
            place_5b(&mut rs, &world, e);
        }
        rs.recount_transparent();
        assert_eq!(rs.transparent_count(), 1);

        rs.queue_despawn(dead);
        world.despawn(dead).unwrap();
        rs.collect_and_cache_dirty(&world);
        assert_eq!(rs.get_slot(last), Some(1), "the transparent last row moved into slot 1");
        assert_eq!(rs.transparent_count(), 1);
        assert_eq!(rs.transparent_count(), brute_transparent_5b(&rs));
    }

    #[test]
    fn recount_drops_a_transparent_dead_slot_filled_by_an_opaque_last_row() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let a = quad_5b(&mut world, 1, false);
        let dead = quad_5b(&mut world, 2, true);
        let last = quad_5b(&mut world, 3, false);
        for e in [a, dead, last] {
            place_5b(&mut rs, &world, e);
        }
        rs.queue_despawn(dead);
        world.despawn(dead).unwrap();
        rs.collect_and_cache_dirty(&world);
        assert_eq!(rs.get_slot(last), Some(1));
        assert_eq!(rs.transparent_count(), 0);
        assert_eq!(rs.transparent_count(), brute_transparent_5b(&rs));
    }

    #[test]
    fn recount_ignores_the_stale_tail_past_gpu_count() {
        let mut rs = RenderState::new();
        let mut world = World::new();
        let a = quad_5b(&mut world, 1, false);
        let b = quad_5b(&mut world, 2, true);
        place_5b(&mut rs, &world, a);
        place_5b(&mut rs, &world, b);
        rs.queue_despawn(b);
        world.despawn(b).unwrap();
        rs.collect_and_cache_dirty(&world);

        assert_eq!(rs.gpu_entity_count(), 1);
        // The dead row is still in the Vec, bit 8 included: the case under test.
        assert_ne!(rs.gpu_render_meta()[3] & RENDER_META_TRANSPARENT_BIT, 0);
        assert_eq!(rs.transparent_count(), 0);

        // An opaque entity re-entering that row zeroes it first (clear_slot).
        let c = quad_5b(&mut world, 3, false);
        rs.assign_slot(c);
        rs.collect_and_cache_dirty(&world);
        assert_eq!(rs.transparent_count(), 0);
        assert_eq!(rs.gpu_render_meta()[3] & RENDER_META_TRANSPARENT_BIT, 0);
    }

    #[test]
    fn collect_gpu_counts_like_the_retained_path() {
        let mut world = World::new();
        let mut ents = Vec::new();
        for i in 0..6u32 {
            // collect_gpu queries these too.
            let e = quad_5b(&mut world, i, i.is_multiple_of(3));
            world
                .insert(e, (TextureLayerIndex(0), MeshHandle(0), PrimitiveParams([0.0; 8])))
                .unwrap();
            ents.push(e);
        }
        let mut legacy = RenderState::new();
        legacy.collect_gpu(&world);

        let mut retained = RenderState::new();
        for &e in &ents {
            place_5b(&mut retained, &world, e);
        }
        retained.recount_transparent();

        assert_eq!(legacy.transparent_count(), 2);
        assert_eq!(retained.transparent_count(), legacy.transparent_count());
    }
```

- [ ] **Step 2: Esegui i test, atteso FAIL**

Run: `cargo test -p hyperion-core --lib render_state`
Atteso: la compilazione fallisce con `error[E0599]: no method named `take_ids_changed` found for struct `RenderState``, e lo stesso per `recount_transparent` e `transparent_count`: i metodi non esistono ancora.

- [ ] **Step 3: Aggiungi i due campi a `RenderState` e al costruttore**

In `render_state.rs`, nella struct `RenderState` (L205-207) sostituisci:

```rust
    staging_dirty_count: u32,
    staging_dirty_ratio: f32,
}
```

con:

```rust
    staging_dirty_count: u32,
    staging_dirty_ratio: f32,

    /// Raised when the slot -> entity mapping (so the entity-ids column)
    /// changed: `assign_slot`, a flush that removed a row, `collect_gpu`.
    /// `Engine::update` consumes it with `take_ids_changed` and bumps its
    /// ids generation at most once per frame (phase 5b §4.1).
    ids_changed: bool,
    /// Live rows whose render-meta word 1 has the Transparent bit (bit 8).
    /// Recounted by `recount_transparent`, never maintained incrementally.
    transparent_count: u32,
}
```

In `RenderState::new()` (L240-243) sostituisci:

```rust
            staging_dirty_count: 0,
            staging_dirty_ratio: 0.0,
        }
    }
```

con:

```rust
            staging_dirty_count: 0,
            staging_dirty_ratio: 0.0,
            ids_changed: false,
            transparent_count: 0,
        }
    }
```

- [ ] **Step 4: Alza il flag nei tre punti che cambiano la mappatura**

(a) `collect_gpu`, inizio (L285-286). Sostituisci:

```rust
    pub fn collect_gpu(&mut self, world: &World) {
        self.dirty_tracker.clear();
```

con:

```rust
    pub fn collect_gpu(&mut self, world: &World) {
        self.dirty_tracker.clear();
        // Every slot is re-packed in archetype order: the id column changes.
        self.ids_changed = true;
```

(b) `collect_gpu`, fine (L383-384): il percorso legacy deve contare come quello a slot stabili. Sostituisci:

```rust
        debug_assert_eq!(self.gpu_count as usize, self.gpu_depths.len());
    }
```

con:

```rust
        debug_assert_eq!(self.gpu_count as usize, self.gpu_depths.len());
        self.recount_transparent();
    }
```

(c) `assign_slot`, dopo l'early return idempotente (L551-552). Sostituisci:

```rust
        let slot = self.gpu_count;
        self.gpu_count += 1;

        // Grow slot_to_entity
```

con:

```rust
        let slot = self.gpu_count;
        self.gpu_count += 1;
        // A new row: the id column gains an entry (phase 5b §4.1).
        self.ids_changed = true;

        // Grow slot_to_entity
```

(d) `flush_pending_despawns`, dopo la guardia `continue` (L792). Sostituisci:

```rust
            let last = self.gpu_count - 1;

            // Clear the dead entity's mapping FIRST.
```

con:

```rust
            let last = self.gpu_count - 1;
            // A row leaves: the id at `slot` becomes the moved entity's, or the
            // column just shrinks (phase 5b §4.1).
            self.ids_changed = true;

            // Clear the dead entity's mapping FIRST.
```

- [ ] **Step 5: Ricalcolo alla fine di `collect_and_cache_dirty` e i tre metodi pubblici**

In `collect_and_cache_dirty` (L1016-1018) sostituisci:

```rust
        self.staging_dirty_count = result.dirty_count;
        self.staging_dirty_ratio = result.dirty_ratio;
    }
```

con:

```rust
        self.staging_dirty_count = result.dirty_count;
        self.staging_dirty_ratio = result.dirty_ratio;
        // After the dirty rows are rewritten: word 1 is current for every row.
        self.recount_transparent();
    }

    /// Recount the live rows whose render-meta word 1 has bit 8
    /// (`RENDER_META_TRANSPARENT_BIT`) set (phase 5b §4.1, D9).
    ///
    /// A recount, not a running counter: `clear_slot` runs after
    /// `gpu_count += 1` on a row that can still hold a stale bit 8 from an
    /// earlier swap-remove, and the `Transparent` component is one frame ahead
    /// of the row, so a counter would carry two invariants. Bounded by
    /// `gpu_count`: the rows past it keep the data of despawned entities (the
    /// `gpu_render_meta()` accessor returns them too). Transparent Light2D rows
    /// count as well, so this is an upper bound of what the transparent sort
    /// gathers — which is all it has to be: it only sizes the gather.
    pub fn recount_transparent(&mut self) {
        let n = self.gpu_count as usize;
        self.transparent_count = self.gpu_render_meta[..n * 2]
            .chunks_exact(2)
            .filter(|row| row[1] & RENDER_META_TRANSPARENT_BIT != 0)
            .count() as u32;
    }

    /// Live rows with the Transparent bit, as of the last `recount_transparent`.
    pub fn transparent_count(&self) -> u32 {
        self.transparent_count
    }

    /// Whether the slot -> entity mapping changed since the last call, and
    /// reset the flag. `Engine::update` calls it once per frame.
    pub fn take_ids_changed(&mut self) -> bool {
        std::mem::take(&mut self.ids_changed)
    }
```

- [ ] **Step 6: Esegui i test, atteso PASS**

Run: `cargo test -p hyperion-core --lib render_state`
Atteso: `test result: ok. 63 passed` (55 di prima + 8 nuovi).

- [ ] **Step 7: Scrivi i test di `Engine` (generazione e conteggio attraverso i comandi)**

Incolla questo modulo annidato in `crates/hyperion-core/src/engine.rs` **prima dell'ultima `}` del file** (quella che chiude `mod tests`, dopo `restore_replay_hash_deterministic_character_controller`). `use super::*;` porta dentro `spawn_cmd`, `make_position_cmd`, `Engine`, `FIXED_DT`, `Command` e `CommandType`. Il generatore è uno xorshift32 scritto qui, perché il crate non ha `rand` fra le dev-dependency.

```rust

    // ── Phase 5b: ids generation and transparent count (design §4.1, §7.2) ──
    mod ids_and_transparency {
        use super::*;
        use crate::components::{Transparent, RENDER_META_TRANSPARENT_BIT};

        fn spawn_2d(id: u32) -> Command {
            let mut payload = [0u8; 16];
            payload[0] = 1; // Transform2D archetype
            Command { cmd_type: CommandType::SpawnEntity, entity_id: id, payload }
        }

        fn despawn(id: u32) -> Command {
            Command { cmd_type: CommandType::DespawnEntity, entity_id: id, payload: [0; 16] }
        }

        fn set_transparent(id: u32, on: bool) -> Command {
            let mut payload = [0u8; 16];
            payload[0] = u8::from(on);
            Command { cmd_type: CommandType::SetTransparent, entity_id: id, payload }
        }

        /// Brute force over the ROWS: bit 8 of word 1, live rows only.
        fn rows_transparent(e: &Engine) -> u32 {
            let n = e.render_state.gpu_entity_count() as usize;
            e.render_state.gpu_render_meta()[..n * 2]
                .chunks_exact(2)
                .filter(|row| row[1] & RENDER_META_TRANSPARENT_BIT != 0)
                .count() as u32
        }

        /// An oracle independent of the rows: the ECS. After `update` the two agree.
        fn ecs_transparent(e: &Engine) -> u32 {
            e.entity_map
                .iter_mapped()
                .filter(|&(_, ent)| e.world.get::<&Transparent>(ent).is_ok())
                .count() as u32
        }

        /// The entity-ids column TS uploads: slot -> external id, live rows only.
        fn id_column(e: &Engine) -> Vec<u32> {
            let n = e.render_state.gpu_entity_count() as usize;
            e.render_state.gpu_entity_ids()[..n].to_vec()
        }

        /// xorshift32: a seeded sequence without a dev-dependency.
        struct XorShift(u32);
        impl XorShift {
            fn next(&mut self) -> u32 {
                let mut x = self.0;
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                self.0 = x;
                x
            }
        }

        #[test]
        fn generation_bumps_once_per_frame_that_changes_the_mapping() {
            let mut e = Engine::new();
            assert_eq!(e.ids_generation(), 0);

            e.process_commands(&[spawn_cmd(0), spawn_cmd(1), spawn_cmd(2)]);
            e.update(FIXED_DT);
            assert_eq!(e.ids_generation(), 1, "three spawns, one frame: one bump");

            e.update(FIXED_DT);
            assert_eq!(e.ids_generation(), 1, "a frame without commands");

            e.process_commands(&[make_position_cmd(1, 3.0, 4.0, 0.0), set_transparent(2, true)]);
            e.update(FIXED_DT);
            assert_eq!(e.ids_generation(), 1, "rows rewritten in place keep their ids");

            e.process_commands(&[despawn(1)]);
            e.update(FIXED_DT);
            assert_eq!(e.ids_generation(), 2, "a despawn swap-removes a row");

            e.process_commands(&[spawn_cmd(3), despawn(0)]);
            e.update(FIXED_DT);
            assert_eq!(e.ids_generation(), 3, "a spawn and a despawn in one frame: one bump");
            let mut ids = id_column(&e);
            ids.sort_unstable();
            assert_eq!(ids, vec![2, 3]);
        }

        #[test]
        fn generation_ignores_shrink_to_fit() {
            let mut e = Engine::new();
            e.process_commands(&[spawn_cmd(0), spawn_cmd(1)]);
            e.update(FIXED_DT);
            e.process_commands(&[despawn(1)]);
            e.update(FIXED_DT);
            let g = e.ids_generation();
            e.render_state.shrink_to_fit();
            e.update(FIXED_DT);
            assert_eq!(e.ids_generation(), g);
        }

        #[test]
        fn spawn_on_a_live_id_gives_a_new_generation_and_the_right_ids() {
            let mut e = Engine::new();
            e.process_commands(&[spawn_cmd(0), spawn_cmd(1)]);
            e.update(FIXED_DT);
            let g = e.ids_generation();
            let old = e.entity_map.get(0).unwrap();

            // One SpawnEntity for a live id: the old entity is retired, the new
            // one takes a row (queue_despawn + assign_slot).
            e.process_commands(&[spawn_2d(0)]);
            e.update(FIXED_DT);
            let new = e.entity_map.get(0).unwrap();
            assert_ne!(new, old);
            assert_ne!(e.ids_generation(), g);
            let mut ids = id_column(&e);
            ids.sort_unstable();
            assert_eq!(ids, vec![0, 1]);
            let slot = e.render_state.get_slot(new).unwrap() as usize;
            assert_eq!(e.render_state.gpu_entity_ids()[slot], 0);
        }

        #[test]
        fn transparent_count_follows_set_transparent_and_a_despawn_in_the_same_frame() {
            let mut e = Engine::new();
            e.process_commands(&[spawn_cmd(0), spawn_cmd(1), spawn_2d(2)]);
            e.update(FIXED_DT);
            assert_eq!(e.render_state.transparent_count(), 0);

            e.process_commands(&[set_transparent(0, true), set_transparent(1, true), despawn(0)]);
            e.update(FIXED_DT);
            assert_eq!(e.render_state.transparent_count(), 1, "only entity 1 is left transparent");
            assert_eq!(rows_transparent(&e), 1);

            e.process_commands(&[set_transparent(2, true), set_transparent(1, false)]);
            e.update(FIXED_DT);
            assert_eq!(e.render_state.transparent_count(), 1);
            assert_eq!(ecs_transparent(&e), 1);
        }

        #[test]
        fn recount_and_generation_hold_over_seeded_random_churn() {
            let mut saw_stale_tail = false;
            for seed in [0x9E37_79B9u32, 0x0BAD_F00D, 12_345, 0xDEAD_BEEF] {
                let mut rng = XorShift(seed);
                let mut e = Engine::new();
                let mut prev_ids = id_column(&e);
                let mut prev_gen = e.ids_generation();
                for frame in 0..300 {
                    let ops = 1 + rng.next() % 8;
                    let mut cmds = Vec::new();
                    for _ in 0..ops {
                        let id = rng.next() % 48;
                        cmds.push(match rng.next() % 5 {
                            0 => spawn_cmd(id),
                            1 => spawn_2d(id),
                            2 => despawn(id),
                            _ => set_transparent(id, rng.next().is_multiple_of(2)),
                        });
                    }
                    e.process_commands(&cmds);
                    e.update(FIXED_DT);

                    let ctx = format!("seed {seed:#x}, frame {frame}");
                    let count = e.render_state.transparent_count();
                    assert_eq!(count, rows_transparent(&e), "{ctx}: recount vs live rows");
                    assert_eq!(count, ecs_transparent(&e), "{ctx}: recount vs ECS");

                    let n = e.render_state.gpu_entity_count() as usize;
                    saw_stale_tail |= e.render_state.gpu_render_meta()[n * 2..]
                        .chunks_exact(2)
                        .any(|row| row[1] & RENDER_META_TRANSPARENT_BIT != 0);

                    let ids = id_column(&e);
                    let generation = e.ids_generation();
                    assert!(generation.wrapping_sub(prev_gen) <= 1, "{ctx}: at most one bump per frame");
                    if ids != prev_ids {
                        assert_ne!(generation, prev_gen, "{ctx}: the id column changed, the generation did not");
                    }
                    prev_ids = ids;
                    prev_gen = generation;
                }
            }
            assert!(saw_stale_tail, "no run left a transparent bit past gpu_count: the stale-tail case went untested");
        }

        #[cfg(feature = "dev-tools")]
        #[test]
        fn reset_bumps_the_generation_and_zeroes_the_count() {
            let mut e = Engine::new();
            e.process_commands(&[spawn_cmd(0), set_transparent(0, true)]);
            e.update(FIXED_DT);
            assert_eq!(e.render_state.transparent_count(), 1);
            let g = e.ids_generation();

            e.reset();
            assert_eq!(e.ids_generation(), g.wrapping_add(1), "reset never restarts it at 0");
            assert_eq!(e.render_state.transparent_count(), 0);
            e.update(FIXED_DT);
            assert_eq!(e.ids_generation(), g.wrapping_add(1));
        }

        #[cfg(feature = "dev-tools")]
        #[test]
        fn snapshot_restore_bumps_the_generation_once_and_recounts() {
            let mut e = Engine::new();
            e.process_commands(&[spawn_cmd(0), spawn_cmd(1), set_transparent(0, true)]);
            e.update(FIXED_DT);
            let snapshot = e.snapshot_create();

            e.process_commands(&[set_transparent(1, true)]);
            e.update(FIXED_DT);
            assert_eq!(e.render_state.transparent_count(), 2);
            let g = e.ids_generation();

            assert!(e.snapshot_restore(&snapshot));
            assert_eq!(e.render_state.transparent_count(), 1, "recounted without an update");
            assert_eq!(e.ids_generation(), g.wrapping_add(1));
            e.update(FIXED_DT);
            assert_eq!(e.ids_generation(), g.wrapping_add(1), "the restore's slot flag was consumed");
        }
    }
```

Nota: il test casuale controlla la proprietà su cui conta TS ("se la colonna degli id è cambiata, la generazione è cambiata", e al massimo un incremento per frame), non l'inverso: un incremento senza cambio di contenuto (il riuso di un id che torna nella stessa riga) è conservativo e innocuo.

- [ ] **Step 8: Esegui i test, atteso FAIL**

Run: `cargo test -p hyperion-core --features dev-tools --lib engine::tests::ids_and_transparency`
Atteso: la compilazione fallisce con `error[E0599]: no method named `ids_generation` found for struct `Engine``.

- [ ] **Step 9: `ids_generation` in `Engine`**

(a) Struct `Engine` (L57-60). Sostituisci:

```rust
    /// Active lighting backend (CommandType 56): 0=off, 1=lit, 2=gi.
    /// Same snapshot gap as `ambient_light`.
    lighting_backend: u8,
}
```

con:

```rust
    /// Active lighting backend (CommandType 56): 0=off, 1=lit, 2=gi.
    /// Same snapshot gap as `ambient_light`.
    lighting_backend: u8,
    /// Generation of the slot -> external id mapping (phase 5b §4.1, D6):
    /// bumped (wrapping) at most once per frame in which the mapping changed,
    /// and on every `reset` / `snapshot_restore`. TS uploads the entity-ids
    /// column only when it moves. It lives here, not in `RenderState`, because
    /// `reset` and `snapshot_restore` replace the render state wholesale: a
    /// counter there would restart at 0 and could land on the value TS last
    /// uploaded, and the remapped column would never reach the GPU.
    ids_generation: u32,
}
```

(b) `Engine::new()` (L86-89). Sostituisci:

```rust
            ambient_light: [0.0, 0.0, 0.0, 1.0],
            lighting_backend: 0,
        }
    }
```

con:

```rust
            ambient_light: [0.0, 0.0, 0.0, 1.0],
            lighting_backend: 0,
            ids_generation: 0,
        }
    }
```

(c) `update()` (L238-240). Sostituisci:

```rust
        self.render_state.collect_and_cache_dirty(&self.world);

        // 5. Physics debug lines
```

con:

```rust
        self.render_state.collect_and_cache_dirty(&self.world);

        // 4b. One new ids generation per frame whose slot -> id mapping changed
        // (spawn, despawn, id reuse), however many rows moved (phase 5b §4.1).
        if self.render_state.take_ids_changed() {
            self.ids_generation = self.ids_generation.wrapping_add(1);
        }

        // 5. Physics debug lines
```

(d) Getter, dopo `lighting_backend()` (L420-424). Sostituisci:

```rust
    /// Active lighting backend (CommandType 56): 0=off, 1=lit, 2=gi.
    pub fn lighting_backend(&self) -> u8 {
        self.lighting_backend
    }
}
```

con:

```rust
    /// Active lighting backend (CommandType 56): 0=off, 1=lit, 2=gi.
    pub fn lighting_backend(&self) -> u8 {
        self.lighting_backend
    }

    /// Generation of the slot -> external id mapping (phase 5b): it differs
    /// from the previous frame's whenever the entity-ids column changed.
    pub fn ids_generation(&self) -> u32 {
        self.ids_generation
    }
}
```

(e) `reset()` (L450-453). Sostituisci:

```rust
        // Same values as `Engine::new()`.
        self.ambient_light = [0.0, 0.0, 0.0, 1.0];
        self.lighting_backend = 0;
    }
```

con:

```rust
        // Same values as `Engine::new()`.
        self.ambient_light = [0.0, 0.0, 0.0, 1.0];
        self.lighting_backend = 0;
        // NOT back to 0: the render state was replaced, and a generation that
        // restarted could equal the one TS last uploaded (phase 5b §4.1).
        self.ids_generation = self.ids_generation.wrapping_add(1);
    }
```

(f) `snapshot_restore()` (L1001-1006). Sostituisci:

```rust
        new_render_state.collect(&new_world);

        // Replace engine state
        self.world = new_world;
        self.entity_map = new_entity_map;
        self.render_state = new_render_state;
```

con:

```rust
        new_render_state.collect(&new_world);
        // Phase 5b: the transparent count of the rebuilt rows, and one ids
        // generation for the whole rebuild — the flag the assign_slot loop
        // raised is consumed here, so the next update does not bump again.
        new_render_state.recount_transparent();
        let _ = new_render_state.take_ids_changed();

        // Replace engine state
        self.world = new_world;
        self.entity_map = new_entity_map;
        self.render_state = new_render_state;
        self.ids_generation = self.ids_generation.wrapping_add(1);
```

Un restore rifiutato (`return false` prima di questo punto) non cambia la mappatura e quindi non incrementa.

- [ ] **Step 10: Esegui i test, atteso PASS**

Run: `cargo test -p hyperion-core --features dev-tools --lib engine::tests::ids_and_transparency`
Atteso: `test result: ok. 7 passed`.
Run: `cargo test -p hyperion-core --lib engine::tests::ids_and_transparency`
Atteso: `test result: ok. 5 passed` (i due test di reset/restore sono sotto `dev-tools`).

- [ ] **Step 11: Le due esportazioni WASM**

In `crates/hyperion-core/src/lib.rs`, subito dopo la funzione `engine_gpu_entity_ids_len` (che finisce a L304), aggiungi:

```rust

/// Live rows whose render meta carries the Transparent bit (bit 8),
/// recounted every frame (phase 5b). It sizes the transparent sort's gather:
/// an upper bound, since transparent Light2D rows count too.
#[wasm_bindgen]
pub fn engine_gpu_transparent_count() -> u32 {
    // SAFETY: wasm32 is single-threaded; nothing else holds a reference to ENGINE.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.render_state.transparent_count())
    }
}

/// Generation of the slot -> external id mapping (phase 5b): it changes in
/// every frame whose entity-ids column changed, so TS uploads the column only
/// when it moves. Compare it for equality, never for order: it wraps.
#[wasm_bindgen]
pub fn engine_gpu_entity_ids_generation() -> u32 {
    // SAFETY: wasm32 is single-threaded; nothing else holds a reference to ENGINE.
    unsafe {
        (*addr_of_mut!(ENGINE))
            .as_ref()
            .map_or(0, |e| e.ids_generation())
    }
}
```

Run: `cargo build -p hyperion-core --target wasm32-unknown-unknown`
Atteso: `Finished`, nessun errore (il target wasm compila le due esportazioni).

- [ ] **Step 12: Matrice delle feature e clippy**

Run, uno per uno:
- `cargo test -p hyperion-core --lib` → `ok. 216 passed` (203 + 13)
- `cargo test -p hyperion-core --features dev-tools --lib` → `ok. 247 passed` (232 + 15)
- `cargo test -p hyperion-core --features physics-2d --lib` → `ok. 294 passed` (281 + 13)
- `cargo test -p hyperion-core --all-features 2>&1 | grep -oE 'ok. [0-9]+ passed' | awk '{s+=$2} END {print s}'` → `438` (lib 340 + 98 di integrazione)
- `cargo clippy -p hyperion-core --all-features --all-targets -- -D warnings` → nessun warning. Attenzione a `manual_is_multiple_of`: nei test si scrive `x.is_multiple_of(n)`, mai `x % n == 0`.

- [ ] **Step 13: Commit**

```bash
git add crates/hyperion-core/src/render_state.rs crates/hyperion-core/src/engine.rs crates/hyperion-core/src/lib.rs
git commit -m "feat(5b): ricalcolo di transparent_count e generazione degli id in Rust" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: TS — trasporto dei due campi, fixture `makeRenderState`, `FrameState`, normalizzazione

`transparentCount` ed `entityIdsGeneration` diventano campi di `GPURenderState` e viaggiano **dentro `renderState`**, mai sul messaggio: nel Mode A il bridge inoltra al render worker solo `{ renderState }` (è il motivo per cui lì `tickCount` vale 0). I messaggi dei worker sono `any`, quindi `tsc` non vede un sito che dimentica un campo. La regola (spec §4.2): un campo mancante costa tempo, mai correttezza. Ogni sito scrive `?? NaN`, **mai `?? 0`**, e il renderer normalizza: conteggio mancante → `entityCount`, generazione mancante → `NaN` (e siccome `NaN !== NaN` l'upload avviene a ogni frame).

Per poter testare ogni sito senza il WASM vero (vitest 4 non riesce a mockare `../wasm/hyperion_core.js` quando il file manca: verificato, `vi.mock` di un modulo inesistente fallisce con "Cannot find module"), questo task:
- sposta la costruzione di `renderState` del worker del motore e la ricostruzione del render worker in un modulo senza effetti collaterali, `ts/src/worker-render-state.ts`;
- aggiunge a `createDirectBridge` un parametro opzionale `loadWasm` (default: l'import dinamico di oggi), così il test del Mode C passa un modulo finto.

`FrameState.transparentCount` entra qui; `FrameState.frameStamp` entra nel Task 11.

**Files:**
- Create: `ts/src/render/frame-inputs.ts`, `ts/src/render/frame-inputs.test.ts`
- Create: `ts/src/worker-render-state.ts`, `ts/src/worker-render-state.test.ts`
- Create: `ts/src/worker-bridge.test.ts`
- Create: `ts/src/render-state.fixture.ts`
- Modify: `ts/src/worker-bridge.ts` — `GPURenderState` (L15-44), Mode B (L133-155), Mode A (L267-289), `createDirectBridge` (firma L367, interfaccia WASM L378-432, `tick()` L447-546)
- Modify: `ts/src/engine-worker.ts` — interfaccia `WasmEngine` (L12-56, va via) e caso `"tick"` (L113-237)
- Modify: `ts/src/render-worker.ts` — tipo `RenderState` (L21-39, va via) e ricostruzione (L91-113)
- Modify: `ts/src/render/render-pass.ts` — `FrameState` (L1-27)
- Modify: `ts/src/renderer.ts` — import (dopo `import { DebugProbe } ...`, L53 su `aa9ee92`) e literal di `FrameState` in `render()` (L873-887 su `aa9ee92`; dopo i Task 6-7 le righe sono spostate: cerca gli ancoraggi testuali)
- Modify (test): `ts/src/integration.test.ts` (L58-87), `ts/src/hyperion.test.ts` (import L15, literal L315-322), `ts/src/lighting-api.test.ts` (L5-25), `ts/src/render/passes/debug-line-pass.test.ts` (L15-28)

**Interfaces:**
- Consumes: le esportazioni WASM del Task 9, `engine_gpu_transparent_count()` ed `engine_gpu_entity_ids_generation()` (dichiarate opzionali: una build WASM vecchia soddisfa ancora le interfacce).
- Produces:
  - `GPURenderState.transparentCount: number`, `GPURenderState.entityIdsGeneration: number` (`worker-bridge.ts`)
  - `FrameState.transparentCount: number` (`render/render-pass.ts`, già normalizzato)
  - `render/frame-inputs.ts`: `export function normalizeTransparentCount(count: number | undefined, entityCount: number): number`, `export function normalizeIdsGeneration(generation: number | undefined): number`, `export function nextFrameStamp(prev: number): number`
  - `render-state.fixture.ts`: `export function makeRenderState(overrides?: Partial<GPURenderState>): GPURenderState`
  - `worker-render-state.ts`: `export interface WasmEngine`, `export interface WorkerRenderState`, `export function captureRenderState(wasm: WasmEngine): { renderState: WorkerRenderState; transfer: ArrayBuffer[] }`, `export function toGPURenderState(rs: WorkerRenderState): GPURenderState`
  - `export async function createDirectBridge(loadWasm?: () => Promise<unknown>): Promise<EngineBridge>`

- [ ] **Step 1: Scrivi i test di `frame-inputs`**

Crea `ts/src/render/frame-inputs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeTransparentCount, normalizeIdsGeneration, nextFrameStamp } from './frame-inputs';

describe('normalizeTransparentCount', () => {
  it('keeps a finite count, floored and never negative', () => {
    expect(normalizeTransparentCount(5, 10)).toBe(5);
    expect(normalizeTransparentCount(0, 10)).toBe(0);
    expect(normalizeTransparentCount(2.7, 10)).toBe(2);
    expect(normalizeTransparentCount(-3, 10)).toBe(0);
  });

  it('falls back to entityCount when the count is missing or not finite — never to 0', () => {
    expect(normalizeTransparentCount(undefined, 12)).toBe(12);
    expect(normalizeTransparentCount(NaN, 12)).toBe(12);
    expect(normalizeTransparentCount(Infinity, 12)).toBe(12);
    // An untyped worker message can carry anything.
    expect(normalizeTransparentCount(null as unknown as number, 12)).toBe(12);
    expect(normalizeTransparentCount('4' as unknown as number, 12)).toBe(12);
  });
});

describe('normalizeIdsGeneration', () => {
  it('keeps a finite generation, 0 included', () => {
    expect(normalizeIdsGeneration(0)).toBe(0);
    expect(normalizeIdsGeneration(7)).toBe(7);
    expect(normalizeIdsGeneration(0xFFFFFFFF)).toBe(0xFFFFFFFF);
  });

  it('turns a missing or non-finite generation into NaN, which equals no marker', () => {
    for (const g of [undefined, NaN, Infinity, null as unknown as number]) {
      const n = normalizeIdsGeneration(g);
      expect(Number.isNaN(n)).toBe(true);
      expect(n === n).toBe(false);
    }
  });
});

describe('nextFrameStamp', () => {
  it('starts at 1 and counts up', () => {
    expect(nextFrameStamp(0)).toBe(1);
    expect(nextFrameStamp(1)).toBe(2);
    expect(nextFrameStamp(0xFFFFFFFD)).toBe(0xFFFFFFFE);
  });

  it('wraps from 0xFFFFFFFE back to 1: never 0 and never the 0xFFFFFFFF sentinel', () => {
    expect(nextFrameStamp(0xFFFFFFFE)).toBe(1);
    let s = 0xFFFFFFF0;
    for (let i = 0; i < 40; i++) {
      s = nextFrameStamp(s);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(0xFFFFFFFE);
    }
  });
});
```

- [ ] **Step 2: Esegui, atteso FAIL**

Run: `npx --prefix ts vitest run --root ts src/render/frame-inputs.test.ts`
Atteso: FAIL con `Failed to resolve import "./frame-inputs"`: il modulo non esiste.

- [ ] **Step 3: Crea `frame-inputs.ts`**

Crea `ts/src/render/frame-inputs.ts`:

```ts
/**
 * The per-frame inputs of the transparent sort (phase 5b §4.2), as the
 * renderer takes them from a `GPURenderState`.
 *
 * Worker messages are untyped (`msg.renderState` is `any`), so `tsc` cannot
 * see a transport site that drops a field. The rule: a missing field may cost
 * time, never correctness. A missing count sorts as if every entity were
 * transparent; a missing generation uploads the entity ids every frame. A
 * constant default (0) would do neither — 0 transparents draws nothing, and a
 * generation stuck at 0 freezes the id upload after the first frame.
 */

/** The gather's bound: a finite count as a non-negative integer, else `entityCount`. */
export function normalizeTransparentCount(count: number | undefined, entityCount: number): number {
  return typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : entityCount;
}

/**
 * A finite generation as is, else NaN. `NaN !== NaN`, so a missing generation
 * never equals the uploaded marker and the ids are uploaded on every frame.
 */
export function normalizeIdsGeneration(generation: number | undefined): number {
  return typeof generation === 'number' && Number.isFinite(generation) ? generation : NaN;
}

/**
 * The next frame stamp: in [1, 0xFFFFFFFE], never 0 (a fresh staging buffer
 * reads 0) and never 0xFFFFFFFF (the header sentinel `prepare()` writes).
 * 0 -> 1 -> 2 -> ... -> 0xFFFFFFFE -> 1.
 */
export function nextFrameStamp(prev: number): number {
  return (prev % 0xFFFFFFFE) + 1;
}
```

- [ ] **Step 4: Esegui, atteso PASS**

Run: `npx --prefix ts vitest run --root ts src/render/frame-inputs.test.ts`
Atteso: `6 passed`.

- [ ] **Step 5: Scrivi i test dei siti di trasporto**

Crea `ts/src/worker-render-state.test.ts` (i due literal del worker del motore e la ricostruzione del render worker):

```ts
import { describe, it, expect } from 'vitest';
import {
  captureRenderState, toGPURenderState, type WasmEngine, type WorkerRenderState,
} from './worker-render-state';

/**
 * A WASM stand-in: `count` entities whose entity-ids column (at byte 1024 of a
 * real WebAssembly.Memory) holds 10, 11, ...; the other columns are empty
 * (pointer 0). `sort` adds the two phase-5b exports.
 */
function fakeWasm(count: number, sort?: { transparent: number; generation: number }): WasmEngine {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const IDS_PTR = 1024;
  new Uint32Array(memory.buffer, IDS_PTR, count).set(Array.from({ length: count }, (_, i) => 10 + i));
  const zero = () => 0;
  const wasm = {
    default: async () => {},
    engine_init() {}, engine_push_commands() {}, engine_update() {},
    engine_tick_count: () => 1n,
    engine_render_state_count: zero, engine_render_state_ptr: zero, engine_render_state_f32_len: zero,
    engine_gpu_entity_count: () => count,
    engine_gpu_transforms_ptr: zero, engine_gpu_transforms_f32_len: zero,
    engine_gpu_bounds_ptr: zero, engine_gpu_bounds_f32_len: zero,
    engine_gpu_render_meta_ptr: zero, engine_gpu_render_meta_len: zero,
    engine_gpu_tex_indices_ptr: zero, engine_gpu_tex_indices_len: zero,
    engine_gpu_prim_params_ptr: zero, engine_gpu_prim_params_f32_len: zero,
    engine_gpu_entity_ids_ptr: () => (count > 0 ? IDS_PTR : 0),
    engine_gpu_entity_ids_len: () => count,
    engine_listener_x: zero, engine_listener_y: zero, engine_listener_z: zero,
    engine_memory: () => memory,
  } as WasmEngine;
  if (sort) {
    wasm.engine_gpu_transparent_count = () => sort.transparent;
    wasm.engine_gpu_entity_ids_generation = () => sort.generation;
  }
  return wasm;
}

describe('captureRenderState (engine worker, Modes A and B)', () => {
  it('carries the transparent count and the ids generation in a non-empty state', () => {
    const { renderState, transfer } = captureRenderState(fakeWasm(3, { transparent: 2, generation: 41 }));
    expect(renderState.entityCount).toBe(3);
    expect(renderState.transparentCount).toBe(2);
    expect(renderState.entityIdsGeneration).toBe(41);
    expect(Array.from(new Uint32Array(renderState.entityIds!))).toEqual([10, 11, 12]);
    expect(transfer).toContain(renderState.entityIds);
    expect(transfer).toHaveLength(6);
  });

  it('carries them in the empty-world state too, which transfers nothing', () => {
    const { renderState, transfer } = captureRenderState(fakeWasm(0, { transparent: 0, generation: 42 }));
    expect(renderState.entityCount).toBe(0);
    expect(renderState.transparentCount).toBe(0);
    expect(renderState.entityIdsGeneration).toBe(42);
    expect(renderState.entityIds).toBeUndefined();
    expect(transfer).toEqual([]);
  });

  it('sends NaN, never 0, when the WASM build lacks the exports', () => {
    for (const count of [3, 0]) {
      const { renderState } = captureRenderState(fakeWasm(count));
      expect(renderState.transparentCount, `count ${count}`).toBeNaN();
      expect(renderState.entityIdsGeneration, `count ${count}`).toBeNaN();
    }
  });
});

describe('toGPURenderState (Mode A render worker)', () => {
  const forwarded = (extra: Partial<WorkerRenderState>): WorkerRenderState => ({
    entityCount: 1,
    transforms: new Float32Array(16).buffer, bounds: new Float32Array(4).buffer,
    renderMeta: new Uint32Array(2).buffer, texIndices: new Uint32Array(1).buffer,
    primParams: new Float32Array(8).buffer, entityIds: new Uint32Array([9]).buffer,
    listenerX: 0, listenerY: 0, listenerZ: 0,
    ambientR: 0, ambientG: 0, ambientB: 0, ambientIntensity: 1, lightingBackend: 0,
    transparentCount: 1, entityIdsGeneration: 5,
    ...extra,
  });

  it('keeps the two phase-5b fields', () => {
    const s = toGPURenderState(forwarded({ transparentCount: 1, entityIdsGeneration: 5 }));
    expect(s.transparentCount).toBe(1);
    expect(s.entityIdsGeneration).toBe(5);
    expect(Array.from(s.entityIds)).toEqual([9]);
    expect(s.dirtyCount).toBe(0);
    expect(s.stagingData).toBeNull();
  });

  it('turns fields a stale engine worker never sent into NaN', () => {
    // What arrives through the port is untyped: an old worker omits the fields.
    const old = forwarded({}) as Partial<WorkerRenderState>;
    delete old.transparentCount;
    delete old.entityIdsGeneration;
    const s = toGPURenderState(old as WorkerRenderState);
    expect(s.transparentCount).toBeNaN();
    expect(s.entityIdsGeneration).toBeNaN();
  });
});
```

Crea `ts/src/worker-bridge.test.ts` (Mode C, Mode B, e le due estremità del Mode A sul main thread):

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDirectBridge, createWorkerBridge, createFullIsolationBridge } from './worker-bridge';
import { ExecutionMode } from './capabilities';

// Phase 5b §4.2: `transparentCount` and `entityIdsGeneration` must reach
// `latestRenderState` in every mode. The worker messages are untyped, so these
// tests are what sees a transport site that drops them.

/** A Worker that records what it is sent and lets a test deliver its replies. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly url: URL, _options?: unknown) {
    FakeWorker.all.push(this);
  }
  postMessage(_msg: unknown, _transfer?: unknown): void {}
  terminate(): void {}
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
}

/** A MessageChannel whose port1 records what the bridge forwards (Mode A). */
class FakeChannel {
  static last: FakeChannel | null = null;
  port1 = { postMessage: vi.fn() };
  port2 = {};
  constructor() {
    FakeChannel.last = this;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.all = [];
  FakeChannel.last = null;
});

/** A non-empty `renderState` as the engine worker posts it. */
function wireState(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    entityCount: 1,
    transforms: new Float32Array(16).buffer,
    bounds: new Float32Array(4).buffer,
    renderMeta: new Uint32Array(2).buffer,
    texIndices: new Uint32Array(1).buffer,
    primParams: new Float32Array(8).buffer,
    entityIds: new Uint32Array([9]).buffer,
    listenerX: 0, listenerY: 0, listenerZ: 0,
    ambientR: 0, ambientG: 0, ambientB: 0, ambientIntensity: 1, lightingBackend: 0,
    ...extra,
  };
}

/** A WASM module stand-in for Mode C: every column empty, `count` entities. */
function fakeWasmModule(count: number, sort?: { transparent: number; generation: number }): Record<string, unknown> {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const zero = () => 0;
  const m: Record<string, unknown> = {
    default: async () => undefined,
    engine_init: () => {},
    engine_push_commands: () => {},
    engine_update: () => {},
    engine_tick_count: () => 1n,
    engine_gpu_entity_count: () => count,
    engine_memory: () => memory,
    engine_listener_x: zero, engine_listener_y: zero, engine_listener_z: zero,
    engine_dirty_count: zero, engine_dirty_ratio: zero,
    engine_staging_ptr: zero, engine_staging_u32_len: zero,
    engine_staging_indices_ptr: zero, engine_staging_indices_len: zero,
  };
  for (const col of ['transforms', 'bounds', 'prim_params']) {
    m[`engine_gpu_${col}_ptr`] = zero;
    m[`engine_gpu_${col}_f32_len`] = zero;
  }
  for (const col of ['render_meta', 'tex_indices', 'entity_ids']) {
    m[`engine_gpu_${col}_ptr`] = zero;
    m[`engine_gpu_${col}_len`] = zero;
  }
  if (sort) {
    m.engine_gpu_transparent_count = () => sort.transparent;
    m.engine_gpu_entity_ids_generation = () => sort.generation;
  }
  return m;
}

describe('Mode C bridge carries the transparent sort inputs', () => {
  it('reads both exports into the non-empty and the empty-world state', async () => {
    vi.stubGlobal('crossOriginIsolated', true);
    for (const count of [3, 0]) {
      const bridge = await createDirectBridge(async () => fakeWasmModule(count, { transparent: 2, generation: 17 }));
      bridge.tick(1 / 60);
      expect(bridge.latestRenderState?.entityCount).toBe(count);
      expect(bridge.latestRenderState?.transparentCount, `count ${count}`).toBe(2);
      expect(bridge.latestRenderState?.entityIdsGeneration, `count ${count}`).toBe(17);
    }
  });

  it('turns missing exports into NaN, never 0', async () => {
    vi.stubGlobal('crossOriginIsolated', true);
    for (const count of [3, 0]) {
      const bridge = await createDirectBridge(async () => fakeWasmModule(count));
      bridge.tick(1 / 60);
      expect(bridge.latestRenderState?.transparentCount, `count ${count}`).toBeNaN();
      expect(bridge.latestRenderState?.entityIdsGeneration, `count ${count}`).toBeNaN();
    }
  });
});

describe('Mode B bridge carries the transparent sort inputs', () => {
  it('copies them from the tick-done renderState', () => {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('Worker', FakeWorker);
    const bridge = createWorkerBridge(ExecutionMode.PartialIsolation);
    FakeWorker.all[0].deliver({
      type: 'tick-done', seq: 1, tickCount: 1,
      renderState: wireState({ transparentCount: 7, entityIdsGeneration: 3 }),
    });
    expect(bridge.latestRenderState?.transparentCount).toBe(7);
    expect(bridge.latestRenderState?.entityIdsGeneration).toBe(3);
    bridge.destroy();
  });

  it('turns fields an older engine worker never sent into NaN', () => {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('Worker', FakeWorker);
    const bridge = createWorkerBridge(ExecutionMode.PartialIsolation);
    FakeWorker.all[0].deliver({ type: 'tick-done', seq: 1, tickCount: 1, renderState: wireState({}) });
    expect(bridge.latestRenderState?.transparentCount).toBeNaN();
    expect(bridge.latestRenderState?.entityIdsGeneration).toBeNaN();
    bridge.destroy();
  });
});

describe('Mode A bridge carries the transparent sort inputs to both threads', () => {
  function setUpModeA() {
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('MessageChannel', FakeChannel);
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const canvas = {
      clientWidth: 800,
      clientHeight: 600,
      transferControlToOffscreen: () => ({}),
    } as unknown as HTMLCanvasElement;
    const bridge = createFullIsolationBridge(canvas);
    const ecs = FakeWorker.all.find((w) => w.url.href.includes('engine-worker'))!;
    return { bridge, ecs };
  }

  it('copies them for the main thread and forwards them to the render worker', () => {
    const { bridge, ecs } = setUpModeA();
    ecs.deliver({
      type: 'tick-done', seq: 1, tickCount: 1,
      renderState: wireState({ transparentCount: 5, entityIdsGeneration: 11 }),
    });
    expect(bridge.latestRenderState?.transparentCount).toBe(5);
    expect(bridge.latestRenderState?.entityIdsGeneration).toBe(11);
    // The render worker rebuilds its state from this object (toGPURenderState).
    const [message] = FakeChannel.last!.port1.postMessage.mock.calls[0] as [{ renderState: Record<string, unknown> }];
    expect(message.renderState.transparentCount).toBe(5);
    expect(message.renderState.entityIdsGeneration).toBe(11);
    bridge.destroy();
  });

  it('turns missing fields into NaN on the main thread', () => {
    const { bridge, ecs } = setUpModeA();
    ecs.deliver({ type: 'tick-done', seq: 1, tickCount: 1, renderState: wireState({}) });
    expect(bridge.latestRenderState?.transparentCount).toBeNaN();
    expect(bridge.latestRenderState?.entityIdsGeneration).toBeNaN();
    bridge.destroy();
  });
});
```

- [ ] **Step 6: Esegui, atteso FAIL**

Run: `npx --prefix ts vitest run --root ts src/worker-render-state.test.ts src/worker-bridge.test.ts`
Atteso:
- `worker-render-state.test.ts`: FAIL con `Failed to resolve import "./worker-render-state"`.
- `worker-bridge.test.ts`: 6 test falliti. I due del Mode C con `TypeError: fetch failed` (oppure `Cannot find module` se `ts/wasm` non c'è): `createDirectBridge` ignora ancora il loader e prova a caricare il WASM vero. I quattro dei Mode B/A con `expected undefined to be 7` / `expected undefined to be NaN`: i campi non vengono copiati.

(L'hook `post-edit-ts.sh` segnala come contesto il fallimento dopo la modifica di un `*.test.ts`: è il RED atteso.)

- [ ] **Step 7: Crea `worker-render-state.ts`**

Crea `ts/src/worker-render-state.ts`. L'interfaccia `WasmEngine` è quella di `engine-worker.ts` (L12-56) spostata qui, con le due esportazioni nuove; il corpo di `captureRenderState` è il codice di `engine-worker.ts` L126-235 spostato qui, con i due campi in più.

```ts
/**
 * The `renderState` of a `tick-done` message, at both ends of the wire.
 *
 * The engine worker (Modes A and B) builds it with `captureRenderState`;
 * Mode A's render worker turns the forwarded copy back into a
 * `GPURenderState` with `toGPURenderState`. Both used to be inline literals in
 * the two worker modules, where no test could reach them — and a field one
 * of them forgets still compiles, because the receiving end is untyped
 * (phase 5b §4.2: `transparentCount` and `entityIdsGeneration`).
 */
import type { GPURenderState } from './worker-bridge';

/** The WASM exports the engine worker calls. */
export interface WasmEngine {
  default(): Promise<void>;
  engine_init(): void;
  engine_push_commands(data: Uint8Array): void;
  /** Command bytes discarded because of an unknown opcode (protocol skew). */
  engine_dropped_command_bytes?(): number;
  /** Commands rejected for an out-of-range external entity id. */
  engine_rejected_command_count?(): number;
  engine_update(dt: number): void;
  engine_tick_count(): bigint;
  engine_render_state_count(): number;
  engine_render_state_ptr(): number;
  engine_render_state_f32_len(): number;
  engine_gpu_entity_count(): number;
  // SoA exports
  engine_gpu_transforms_ptr(): number;
  engine_gpu_transforms_f32_len(): number;
  engine_gpu_bounds_ptr(): number;
  engine_gpu_bounds_f32_len(): number;
  engine_gpu_render_meta_ptr(): number;
  engine_gpu_render_meta_len(): number;
  engine_gpu_tex_indices_ptr(): number;
  engine_gpu_tex_indices_len(): number;
  engine_gpu_prim_params_ptr(): number;
  engine_gpu_prim_params_f32_len(): number;
  engine_gpu_entity_ids_ptr(): number;
  engine_gpu_entity_ids_len(): number;
  // Listener position exports
  engine_listener_x(): number;
  engine_listener_y(): number;
  engine_listener_z(): number;
  // Lighting engine-level exports (Phase 17). Optional: a WASM build predating
  // them still satisfies this interface.
  engine_ambient_r?(): number;
  engine_ambient_g?(): number;
  engine_ambient_b?(): number;
  engine_ambient_intensity?(): number;
  engine_lighting_backend?(): number;
  // Transparent sort inputs (phase 5b). Optional for the same reason: without
  // them the renderer sizes the sort from entityCount and uploads the entity
  // ids every frame (render/frame-inputs.ts).
  engine_gpu_transparent_count?(): number;
  engine_gpu_entity_ids_generation?(): number;
  // Physics debug exports (physics-debug builds only)
  engine_physics_debug_ptr?(): number;
  engine_physics_debug_f32_len?(): number;
  // Determinism harness export (dev-tools builds only)
  engine_state_hash?(): bigint;
  engine_memory(): WebAssembly.Memory;
}

/** `renderState` of a `tick-done` message. */
export interface WorkerRenderState {
  entityCount: number;
  // The SoA columns, as transferable buffers. Absent on an empty world:
  // nothing is transferred then.
  transforms?: ArrayBuffer;
  bounds?: ArrayBuffer;
  renderMeta?: ArrayBuffer;
  texIndices?: ArrayBuffer;
  primParams?: ArrayBuffer;
  entityIds?: ArrayBuffer;
  listenerX: number;
  listenerY: number;
  listenerZ: number;
  ambientR: number;
  ambientG: number;
  ambientB: number;
  ambientIntensity: number;
  lightingBackend: number;
  /**
   * Phase 5b. NaN when the WASM build lacks the export, never 0: the renderer
   * normalises NaN to "count = entityCount" and "upload every frame".
   */
  transparentCount: number;
  entityIdsGeneration: number;
  physicsDebugLines?: ArrayBuffer;
  /**
   * Never set by the engine worker: `tickCount` travels on the message, and
   * Mode A's bridge forwards only `{ renderState }`, so its render worker reads 0.
   */
  tickCount?: number;
}

/**
 * Copy this frame's render state out of WASM memory into transferable
 * buffers. `transfer` lists the buffers to hand to `postMessage` (empty for
 * an empty world). Call it after `engine_update`: the pointers are valid for
 * that frame only.
 */
export function captureRenderState(wasm: WasmEngine): {
  renderState: WorkerRenderState;
  transfer: ArrayBuffer[];
} {
  const count = wasm.engine_gpu_entity_count();
  const scalars = {
    listenerX: wasm.engine_listener_x(),
    listenerY: wasm.engine_listener_y(),
    listenerZ: wasm.engine_listener_z(),
    ambientR: wasm.engine_ambient_r?.() ?? 0,
    ambientG: wasm.engine_ambient_g?.() ?? 0,
    ambientB: wasm.engine_ambient_b?.() ?? 0,
    ambientIntensity: wasm.engine_ambient_intensity?.() ?? 1,
    lightingBackend: wasm.engine_lighting_backend?.() ?? 0,
    transparentCount: wasm.engine_gpu_transparent_count?.() ?? NaN,
    entityIdsGeneration: wasm.engine_gpu_entity_ids_generation?.() ?? NaN,
  };
  if (count === 0) {
    return { renderState: { entityCount: 0, ...scalars }, transfer: [] };
  }

  const tPtr = wasm.engine_gpu_transforms_ptr();
  const tLen = wasm.engine_gpu_transforms_f32_len();
  const bPtr = wasm.engine_gpu_bounds_ptr();
  const bLen = wasm.engine_gpu_bounds_f32_len();
  const mPtr = wasm.engine_gpu_render_meta_ptr();
  const mLen = wasm.engine_gpu_render_meta_len();
  const texPtr = wasm.engine_gpu_tex_indices_ptr();
  const texLen = wasm.engine_gpu_tex_indices_len();

  // Copy from WASM memory into transferable buffers
  const transforms = new Float32Array(tLen);
  if (tPtr) transforms.set(new Float32Array(wasm.engine_memory().buffer, tPtr, tLen));

  const bounds = new Float32Array(bLen);
  if (bPtr) bounds.set(new Float32Array(wasm.engine_memory().buffer, bPtr, bLen));

  const renderMeta = new Uint32Array(mLen);
  if (mPtr) renderMeta.set(new Uint32Array(wasm.engine_memory().buffer, mPtr, mLen));

  const texIndices = new Uint32Array(texLen);
  if (texPtr) texIndices.set(new Uint32Array(wasm.engine_memory().buffer, texPtr, texLen));

  const ppPtr = wasm.engine_gpu_prim_params_ptr();
  const ppLen = wasm.engine_gpu_prim_params_f32_len();
  const primParams = new Float32Array(ppLen);
  if (ppPtr) primParams.set(new Float32Array(wasm.engine_memory().buffer, ppPtr, ppLen));

  const eidPtr = wasm.engine_gpu_entity_ids_ptr();
  const eidLen = wasm.engine_gpu_entity_ids_len();
  const entityIds = new Uint32Array(eidLen);
  if (eidPtr) entityIds.set(new Uint32Array(wasm.engine_memory().buffer, eidPtr, eidLen));

  // Physics debug lines (physics-debug builds only, empty when disabled)
  let physicsDebugLines: Float32Array | null = null;
  const dbgLen = wasm.engine_physics_debug_f32_len?.() ?? 0;
  if (dbgLen > 0) {
    const dbgPtr = wasm.engine_physics_debug_ptr!();
    physicsDebugLines = new Float32Array(dbgLen);
    if (dbgPtr) physicsDebugLines.set(new Float32Array(wasm.engine_memory().buffer, dbgPtr, dbgLen));
  }

  const renderState: WorkerRenderState = {
    entityCount: count,
    transforms: transforms.buffer as ArrayBuffer,
    bounds: bounds.buffer as ArrayBuffer,
    renderMeta: renderMeta.buffer as ArrayBuffer,
    texIndices: texIndices.buffer as ArrayBuffer,
    primParams: primParams.buffer as ArrayBuffer,
    entityIds: entityIds.buffer as ArrayBuffer,
    ...scalars,
    ...(physicsDebugLines ? { physicsDebugLines: physicsDebugLines.buffer as ArrayBuffer } : {}),
  };
  const transfer = [
    renderState.transforms!, renderState.bounds!, renderState.renderMeta!,
    renderState.texIndices!, renderState.primParams!, renderState.entityIds!,
  ];
  if (renderState.physicsDebugLines) transfer.push(renderState.physicsDebugLines);
  return { renderState, transfer };
}

/**
 * Mode A's render worker: the forwarded state as a `GPURenderState`, with
 * fresh views over the transferred buffers. It keeps no staging data (every
 * frame is a full upload there) and no physics debug lines, as before.
 */
export function toGPURenderState(rs: WorkerRenderState): GPURenderState {
  return {
    entityCount: rs.entityCount,
    transforms: rs.transforms ? new Float32Array(rs.transforms) : new Float32Array(0),
    bounds: rs.bounds ? new Float32Array(rs.bounds) : new Float32Array(0),
    renderMeta: rs.renderMeta ? new Uint32Array(rs.renderMeta) : new Uint32Array(0),
    texIndices: rs.texIndices ? new Uint32Array(rs.texIndices) : new Uint32Array(0),
    primParams: rs.primParams ? new Float32Array(rs.primParams) : new Float32Array(0),
    entityIds: rs.entityIds ? new Uint32Array(rs.entityIds) : new Uint32Array(0),
    listenerX: rs.listenerX ?? 0,
    listenerY: rs.listenerY ?? 0,
    listenerZ: rs.listenerZ ?? 0,
    ambientR: rs.ambientR ?? 0,
    ambientG: rs.ambientG ?? 0,
    ambientB: rs.ambientB ?? 0,
    ambientIntensity: rs.ambientIntensity ?? 1,
    lightingBackend: rs.lightingBackend ?? 0,
    // The stored state came through an untyped port: `?? NaN`, never `?? 0`.
    transparentCount: rs.transparentCount ?? NaN,
    entityIdsGeneration: rs.entityIdsGeneration ?? NaN,
    tickCount: rs.tickCount ?? 0,
    dirtyCount: 0,
    dirtyRatio: 0,
    stagingData: null,
    dirtyIndices: null,
  };
}
```

- [ ] **Step 8: `engine-worker.ts` usa `captureRenderState`**

Sostituisci **l'intero contenuto** di `ts/src/engine-worker.ts` con questo (l'interfaccia `WasmEngine` e i due literal passano a `worker-render-state.ts`; il comportamento resta quello di prima: un messaggio `tick-done` per tick, il mondo vuoto senza array né transfer):

```ts
/// <reference lib="webworker" />

/**
 * Engine Logic Worker.
 * Loads the WASM module, extracts commands from the shared ring buffer,
 * and runs the engine tick loop. After each tick, exports SoA GPU data
 * (transforms, bounds, renderMeta, texIndices) as transferable ArrayBuffers.
 */

import { extractUnread, HEARTBEAT_W1_OFFSET } from "./ring-buffer";
import { captureRenderState, type WasmEngine } from "./worker-render-state";

let wasm: WasmEngine | null = null;
let commandBuffer: SharedArrayBuffer | null = null;

interface InitMessage {
  type: "init";
  commandBuffer: SharedArrayBuffer;
}

interface StateHashMessage {
  type: "state-hash";
  requestId: number;
}

interface TickMessage {
  type: "tick";
  dt: number;
  /** The bridge's number for this tick, echoed in `tick-done` (TickSequencer). */
  seq?: number;
}

type WorkerMessage = InitMessage | TickMessage | StateHashMessage;

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case "init": {
      try {
        const wasmModule = await import("../wasm/hyperion_core.js");
        await wasmModule.default();
        wasm = wasmModule as unknown as WasmEngine;
        commandBuffer = msg.commandBuffer;

        wasm.engine_init();

        self.postMessage({ type: "ready" });
      } catch (e) {
        self.postMessage({ type: "error", error: String(e) });
      }
      break;
    }

    case "state-hash": {
      // Determinism harness (Phase 16): dev-tools builds only.
      const hash = wasm?.engine_state_hash?.() ?? null;
      self.postMessage({
        type: "state-hash-result",
        requestId: msg.requestId,
        // BigInt does not survive structured clone limits in all targets —
        // ship as string, parse bridge-side.
        hash: hash === null ? null : hash.toString(),
      });
      break;
    }

    case "tick": {
      if (!wasm || !commandBuffer) return;

      const { bytes } = extractUnread(commandBuffer);
      if (bytes.length > 0) {
        wasm.engine_push_commands(bytes);
      }
      wasm.engine_update(msg.dt);

      // Increment heartbeat for supervisor monitoring
      const header = new Int32Array(commandBuffer, 0, 8);
      Atomics.add(header, HEARTBEAT_W1_OFFSET, 1);

      const tickCount = Number(wasm.engine_tick_count());
      // One message per tick, empty world included (its renderState carries
      // no arrays and transfers nothing): see worker-render-state.ts.
      const { renderState, transfer } = captureRenderState(wasm);
      self.postMessage(
        { type: "tick-done", dt: msg.dt, seq: msg.seq, tickCount, renderState },
        transfer
      );
      break;
    }
  }
};
```

- [ ] **Step 9: `render-worker.ts` usa `toGPURenderState`**

In `ts/src/render-worker.ts`:

(a) Sostituisci la riga `import type { LightingQuality } from "./lighting-api";` (L15) con:

```ts
import type { LightingQuality } from "./lighting-api";
import { toGPURenderState, type WorkerRenderState } from "./worker-render-state";
```

(b) Elimina l'intera `interface RenderState { ... }` (L21-39) e sostituisci `let latestRenderState: RenderState | null = null;` (L41) con:

```ts
let latestRenderState: WorkerRenderState | null = null;
```

(c) In `renderFrame()` sostituisci tutta la chiamata `renderer.render({ entityCount: ..., dirtyIndices: null, }, camera);` (L92-113) con:

```ts
      renderer.render(toGPURenderState(latestRenderState), camera);
```

- [ ] **Step 10: `GPURenderState` e i tre siti di `worker-bridge.ts`**

(a) Interfaccia (L43-44). Sostituisci:

```ts
  lightingBackend: number;     // 0=off, 1=lit, 2=gi
}
```

con:

```ts
  lightingBackend: number;     // 0=off, 1=lit, 2=gi
  // Transparent sort inputs (phase 5b §4.2). Carried INSIDE the render state,
  // never on the message: Mode A forwards only `{ renderState }` to its render
  // worker. NaN when a WASM build or a transport site lacks them — never 0;
  // the renderer normalises (render/frame-inputs.ts).
  /** Live rows with the Transparent bit (Rust recount): sizes the sort's gather. */
  transparentCount: number;
  /** Changes whenever the slot -> external id mapping changed: gates the entity-ids upload. */
  entityIdsGeneration: number;
}
```

(b) Mode B (L148-149) **e** Mode A (L282-283): le due righe identiche

```ts
        lightingBackend: rs.lightingBackend ?? 0,
        tickCount: msg.tickCount ?? 0,
```

diventano, in entrambi i literal:

```ts
        lightingBackend: rs.lightingBackend ?? 0,
        transparentCount: rs.transparentCount ?? NaN,
        entityIdsGeneration: rs.entityIdsGeneration ?? NaN,
        tickCount: msg.tickCount ?? 0,
```

Nel Mode A `rs` viene poi inoltrato intero al render worker (`channel.port1.postMessage({ renderState: rs }, ...)`), quindi i due campi arrivano anche a `toGPURenderState` senza altro codice.

(c) Mode C, firma e caricamento (L367-374). Sostituisci:

```ts
export async function createDirectBridge(): Promise<EngineBridge> {
  const buffer = createRingBuffer(RING_BUFFER_CAPACITY);
  const producer = new RingBufferProducer(buffer as SharedArrayBuffer);
  const commandBuffer = new BackpressuredProducer(producer);

  const wasm = await import("../wasm/hyperion_core.js");
  await wasm.default();
```

con:

```ts
export async function createDirectBridge(
  /** Loads the WASM module. A seam for tests, which cannot import the real one. */
  loadWasm: () => Promise<unknown> = () => import("../wasm/hyperion_core.js"),
): Promise<EngineBridge> {
  const buffer = createRingBuffer(RING_BUFFER_CAPACITY);
  const producer = new RingBufferProducer(buffer as SharedArrayBuffer);
  const commandBuffer = new BackpressuredProducer(producer);

  const wasm = (await loadWasm()) as { default(): Promise<unknown> };
  await wasm.default();
```

`hyperion.ts` (L178, L193) continua a chiamare `createDirectBridge()` senza argomenti.

(d) Mode C, interfaccia WASM (L417-418). Sostituisci:

```ts
    engine_lighting_backend?(): number;
    engine_tick_count(): bigint;
```

con:

```ts
    engine_lighting_backend?(): number;
    // Transparent sort inputs (phase 5b). Optional like the lighting ones.
    engine_gpu_transparent_count?(): number;
    engine_gpu_entity_ids_generation?(): number;
    engine_tick_count(): bigint;
```

(e) Mode C, lettura (L454-456). Sostituisci:

```ts
      const tickCount = Number(engine.engine_tick_count());
      ticksC.ack(seq, tickCount); // push and update are synchronous here
      const count = engine.engine_gpu_entity_count();
```

con:

```ts
      const tickCount = Number(engine.engine_tick_count());
      ticksC.ack(seq, tickCount); // push and update are synchronous here
      const count = engine.engine_gpu_entity_count();
      // Read in both literals below, empty world included. NaN, never 0, when
      // the build lacks the export (render/frame-inputs.ts).
      const transparentCount = engine.engine_gpu_transparent_count?.() ?? NaN;
      const entityIdsGeneration = engine.engine_gpu_entity_ids_generation?.() ?? NaN;
```

(f) Mode C, i due literal (pieno L510-511 **e** vuoto L539-540): le due righe identiche

```ts
          lightingBackend: engine.engine_lighting_backend?.() ?? 0,
          tickCount,
```

diventano, in entrambi:

```ts
          lightingBackend: engine.engine_lighting_backend?.() ?? 0,
          transparentCount,
          entityIdsGeneration,
          tickCount,
```

- [ ] **Step 11: `FrameState.transparentCount` e il renderer**

(a) `ts/src/render/render-pass.ts` (L26-27). Sostituisci:

```ts
  lightGroups?: import('./light-groups').LightGroups;
}
```

con:

```ts
  lightGroups?: import('./light-groups').LightGroups;
  /**
   * Transparent sort (phase 5b): live rows with the Transparent bit, already
   * normalised (`normalizeTransparentCount`: a missing count becomes
   * `entityCount`). It bounds the sort's gather; 0 skips the sort.
   */
  transparentCount: number;
}
```

(b) `ts/src/renderer.ts`: sotto la riga `import { DebugProbe } from './render/debug-probe';` aggiungi

```ts
import { normalizeTransparentCount } from './render/frame-inputs';
```

e nel literal di `FrameState` dentro `render()` sostituisci

```ts
        shadowSteps: lightingQuality.shadowSteps,
      };
```

con:

```ts
        shadowSteps: lightingQuality.shadowSteps,
        transparentCount: normalizeTransparentCount(state.transparentCount, state.entityCount),
      };
```

(c) `ts/src/render/passes/debug-line-pass.test.ts`, in `makeFrame` (L26-28). Sostituisci:

```ts
    deltaTime: 1 / 60,
    physicsDebugLines: lines,
  };
```

con:

```ts
    deltaTime: 1 / 60,
    physicsDebugLines: lines,
    transparentCount: 0,
  };
```

- [ ] **Step 12: La fixture `makeRenderState` e i tre literal migrati**

Crea `ts/src/render-state.fixture.ts`:

```ts
import type { GPURenderState } from './worker-bridge';

/**
 * A complete `GPURenderState` for tests: an empty world with every field at a
 * neutral value, `overrides` on top. The one place a test builds a whole
 * render state, so a new field is added here once instead of in every test.
 * (Not a transport default: a real bridge sends NaN for a missing
 * `transparentCount` / `entityIdsGeneration`, see render/frame-inputs.ts.)
 */
export function makeRenderState(overrides: Partial<GPURenderState> = {}): GPURenderState {
  return {
    entityCount: 0,
    transforms: new Float32Array(0),
    bounds: new Float32Array(0),
    renderMeta: new Uint32Array(0),
    texIndices: new Uint32Array(0),
    primParams: new Float32Array(0),
    entityIds: new Uint32Array(0),
    listenerX: 0,
    listenerY: 0,
    listenerZ: 0,
    tickCount: 0,
    dirtyCount: 0,
    dirtyRatio: 0,
    stagingData: null,
    dirtyIndices: null,
    ambientR: 0,
    ambientG: 0,
    ambientB: 0,
    ambientIntensity: 1,
    lightingBackend: 0,
    transparentCount: 0,
    entityIdsGeneration: 0,
    ...overrides,
  };
}
```

(a) `ts/src/integration.test.ts`: dopo `import { selectExecutionMode, ExecutionMode, type Capabilities } from "./capabilities";` aggiungi `import { makeRenderState } from "./render-state.fixture";`. Nel test `"GPURenderState has SoA fields"` sostituisci il literal (L59-80) e aggiungi due asserzioni:

```ts
    const state: import("./worker-bridge").GPURenderState = makeRenderState({
      entityCount: 1,
      transforms: new Float32Array(16),
      bounds: new Float32Array(4),
      renderMeta: new Uint32Array(2),
      texIndices: new Uint32Array([0]),
      primParams: new Float32Array(8),
      entityIds: new Uint32Array([42]),
      transparentCount: 0,
      entityIdsGeneration: 1,
    });
    expect(state.transforms.length).toBe(16);
    expect(state.bounds.length).toBe(4);
    expect(state.renderMeta.length).toBe(2);
    expect(state.texIndices.length).toBe(1);
    expect(state.primParams.length).toBe(8);
    expect(state.entityIds.length).toBe(1);
    expect(typeof state.transparentCount).toBe("number");
    expect(typeof state.entityIdsGeneration).toBe("number");
```

(b) `ts/src/hyperion.test.ts`: dopo `import { TickSequencer } from './tick-sequencer';` (L15) aggiungi `import { makeRenderState } from './render-state.fixture';`. Nel test `'stats.tickCount reads from render state'` sostituisci l'assegnazione (L315-322) con:

```ts
    bridge.latestRenderState = makeRenderState({ tickCount: 42 });
```

(c) `ts/src/lighting-api.test.ts`: sostituisci le righe L5-25 (l'import del tipo, `const HEADER = 32;` e l'intera funzione locale `emptyRenderState`) con:

```ts
import type { EngineBridge, GPURenderState } from './worker-bridge';
import { makeRenderState as emptyRenderState } from './render-state.fixture';

const HEADER = 32;
```

Le chiamate a `emptyRenderState(...)` più sotto restano come sono.

- [ ] **Step 13: Esegui, atteso PASS**

Run: `npx --prefix ts vitest run --root ts src/render/frame-inputs.test.ts src/worker-render-state.test.ts src/worker-bridge.test.ts`
Atteso: `17 passed` (6 + 5 + 6).
Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Atteso: nessuna riga. Se `tsc` segnala `Property 'transparentCount' is missing` in un altro literal completo di `GPURenderState` o `FrameState` (per esempio uno aggiunto dai Task 4-8), aggiungi lì `transparentCount: 0` (per un `GPURenderState` usa `makeRenderState`).
Run: `npm --prefix ts test`
Atteso: tutto verde, 17 test e 3 file in più rispetto a prima del task.

- [ ] **Step 14: Commit**

```bash
git add ts/src/render/frame-inputs.ts ts/src/render/frame-inputs.test.ts ts/src/worker-render-state.ts ts/src/worker-render-state.test.ts ts/src/worker-bridge.ts ts/src/worker-bridge.test.ts ts/src/engine-worker.ts ts/src/render-worker.ts ts/src/render/render-pass.ts ts/src/renderer.ts ts/src/render-state.fixture.ts ts/src/integration.test.ts ts/src/hyperion.test.ts ts/src/lighting-api.test.ts ts/src/render/passes/debug-line-pass.test.ts
git commit -m "feat(5b): trasporto di transparentCount ed entityIdsGeneration in tutti i Mode" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: renderer — `entity-ids`, upload per generazione, `frameStamp`, `MAX_GPU_ENTITIES`, `validateConfig`

Il renderer diventa il proprietario della colonna `entity-ids` (slot → id esterno, spec §4.3):
- è un **buffer del pool creato in `createRenderer`**, accanto a `selection-mask`, non in un pass: gli swap del grafo e i probe dell'hot-reload rifanno il `setup()` dei pass, e un buffer del pass tornerebbe vuoto mentre il marcatore dice "già caricato";
- il marcatore `uploadedIdsGeneration` è una **variabile locale della closure** di `createRenderer`, inizializzata a `NaN`;
- l'upload sta **fra la fine dell'if/else degli upload SoA e la selection mask**, così gira anche nei frame con lo scatter del Mode C (lo staging a 32 parole non ha spazio per l'id, e uno swap-remove sposta le righe).

Poi `frameStamp` (contatore della closure, avanza una volta per `render()`), `MAX_GPU_ENTITIES` come unica copia della capacità (spec §6.4: sostituisce `renderer.ts:56`, `cull-pass.ts:215`, `cull-pass.ts:223`, `types.ts:105`), il rifiuto in `validateConfig` (D10) e due warning una tantum: in dev quando un campo del Task 10 manca, sempre quando `entityCount > MAX_GPU_ENTITIES`.

La logica dell'upload e dei warning sta in tre funzioni di `frame-inputs.ts`, testabili senza device; un test sul testo di `renderer.ts` fissa la posizione della chiamata fuori dall'if/else.

**Files:**
- Modify: `ts/src/types.ts` — dopo `MAX_EXTERNAL_ID` (L68), `validateConfig` (L105-108)
- Modify: `ts/src/render/frame-inputs.ts` (creato nel Task 10) + `ts/src/render/frame-inputs.test.ts`
- Modify: `ts/src/render/render-pass.ts` — `FrameState` (campo `frameStamp`)
- Modify: `ts/src/render/passes/cull-pass.ts` — import (L3), `prepare()` (L215, L223-230)
- Modify: `ts/src/renderer.ts` — import, `const MAX_ENTITIES` (L56 su `aa9ee92`) e i suoi 8 usi, pool (dopo `resources.setBuffer('selection-mask', ...)`), locali della closure (dopo `let warnedMultiBitReceiver = false;`), `render()`
- Test: `ts/src/types.test.ts`, `ts/src/render/frame-inputs.test.ts`, `ts/src/render/passes/cull-pass.test.ts`, `ts/src/render/passes/debug-line-pass.test.ts`

**Interfaces:**
- Consumes: `normalizeTransparentCount`, `normalizeIdsGeneration`, `nextFrameStamp` (Task 10); `GPURenderState.transparentCount/entityIdsGeneration` (Task 10).
- Produces:
  - `types.ts`: `export const MAX_GPU_ENTITIES = 100_000;`; `validateConfig` lancia `new Error(\`maxEntities (${n}) exceeds MAX_GPU_ENTITIES (${MAX_GPU_ENTITIES}): the GPU buffers hold that many rows\`)`; default `config.maxEntities ?? MAX_GPU_ENTITIES`
  - `FrameState.frameStamp: number` (in [1, 0xFFFFFFFE])
  - `frame-inputs.ts`: `export function uploadEntityIds(queue: Pick<GPUQueue, 'writeBuffer'>, buffer: GPUBuffer, state: Pick<GPURenderState, 'entityIds' | 'entityCount' | 'entityIdsGeneration'>, uploadedGeneration: number): { generation: number; uploaded: boolean }`, `export function missingSortInputs(state: Pick<GPURenderState, 'transparentCount' | 'entityIdsGeneration'>): string[]`, `export function overCapacityWarning(entityCount: number): string | null`
  - buffer del pool `'entity-ids'`: `MAX_GPU_ENTITIES × 4` B, `STORAGE | COPY_DST` (+ `COPY_SRC` in dev), label `entity-ids`
  - locali della closure di `createRenderer`: `let uploadedIdsGeneration = NaN; let frameStamp = 0;` e, dentro `render()`, `const idsUpload` (`{ generation, uploaded }` del frame: il Task 16 ne legge `uploaded` per `SortProbeSource.idsUploaded`)

- [ ] **Step 1: Scrivi i test di capacità e `validateConfig`**

In `ts/src/types.test.ts` sostituisci le prime due righe:

```ts
import { describe, it, expect } from 'vitest';
import { validateConfig, type HyperionConfig } from './types';
```

con:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateConfig, MAX_GPU_ENTITIES, type HyperionConfig } from './types';
```

e sostituisci la fine del file (L35-38):

```ts
    expect(() => validateConfig({ canvas, maxEntities: 0 })).toThrow('maxEntities');
  });
});
```

con:

```ts
    expect(() => validateConfig({ canvas, maxEntities: 0 })).toThrow('maxEntities');
  });

  it('defaults maxEntities to MAX_GPU_ENTITIES and accepts exactly that many', () => {
    const canvas = {} as HTMLCanvasElement;
    expect(validateConfig({ canvas }).maxEntities).toBe(MAX_GPU_ENTITIES);
    expect(validateConfig({ canvas, maxEntities: MAX_GPU_ENTITIES }).maxEntities).toBe(MAX_GPU_ENTITIES);
  });

  it('rejects maxEntities above MAX_GPU_ENTITIES, naming the limit', () => {
    const canvas = {} as HTMLCanvasElement;
    expect(() => validateConfig({ canvas, maxEntities: MAX_GPU_ENTITIES + 1 }))
      .toThrow(`maxEntities (${MAX_GPU_ENTITIES + 1}) exceeds MAX_GPU_ENTITIES (${MAX_GPU_ENTITIES})`);
  });
});

describe('MAX_GPU_ENTITIES', () => {
  it('is the only copy of the GPU capacity (phase 5b §6.4)', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const literals = (src: string) => (src.match(/\b100_000\b/g) ?? []).length;
    expect(literals(read('./types.ts')), 'types.ts: the declaration only').toBe(1);
    expect(literals(read('./renderer.ts')), 'renderer.ts').toBe(0);
    expect(literals(read('./render/passes/cull-pass.ts')), 'cull-pass.ts').toBe(0);
  });
});
```

In `ts/src/render/passes/cull-pass.test.ts`, dopo `import type { FrameState } from '../render-pass';` (L5) aggiungi `import { MAX_GPU_ENTITIES } from '../../types';` e in fondo al file aggiungi:

```ts

describe('CullPass sizes its regions with MAX_GPU_ENTITIES', () => {
  it('writes it as maxEntitiesPerType and as the stride of every firstInstance', () => {
    const pass = new CullPass();
    const uniform = { label: 'cull-uniform' };
    const indirect = { label: 'indirect-args' };
    Object.assign(pass as unknown as Record<string, unknown>, { cullUniformBuffer: uniform, indirectBuffer: indirect });
    const writes = new Map<unknown, ArrayBuffer | Uint32Array>();
    const device = {
      queue: { writeBuffer: (target: unknown, _offset: number, data: ArrayBuffer | Uint32Array) => { writes.set(target, data); } },
    } as unknown as GPUDevice;
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    pass.prepare(device, { entityCount: 5, cameraViewProjection: identity } as unknown as FrameState);

    expect(new Uint32Array(writes.get(uniform) as ArrayBuffer, 96, 4)[1]).toBe(MAX_GPU_ENTITIES);
    const args = writes.get(indirect) as Uint32Array;
    for (let i = 0; i < TOTAL_DRAW_BUCKETS; i++) {
      expect(args[i * 5 + 4], `bucket ${i}`).toBe(i * MAX_GPU_ENTITIES);
    }
  });
});
```

- [ ] **Step 2: Scrivi i test dell'upload, della sua posizione e dei warning**

In `ts/src/render/frame-inputs.test.ts` sostituisci le prime due righe:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeTransparentCount, normalizeIdsGeneration, nextFrameStamp } from './frame-inputs';
```

con:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  normalizeTransparentCount, normalizeIdsGeneration, nextFrameStamp,
  uploadEntityIds, missingSortInputs, overCapacityWarning,
} from './frame-inputs';
import { MAX_GPU_ENTITIES } from '../types';
```

e in fondo al file aggiungi:

```ts

describe('uploadEntityIds', () => {
  function recordingQueue() {
    const writes: Array<{ offset: number; data: Uint32Array; dataOffset: number; size: number }> = [];
    const queue = {
      writeBuffer: (_b: GPUBuffer, offset: number, data: Uint32Array, dataOffset: number, size: number) => {
        writes.push({ offset, data, dataOffset, size });
      },
    } as unknown as Pick<GPUQueue, 'writeBuffer'>;
    return { queue, writes };
  }
  const buffer = {} as GPUBuffer;
  const ids = new Uint32Array([4, 9, 2]);

  it('writes the whole live column when the generation moved, then not again', () => {
    const { queue, writes } = recordingQueue();
    let marker = NaN; // the renderer's initial marker
    const state = { entityIds: ids, entityCount: 3, entityIdsGeneration: 5 };
    let r = uploadEntityIds(queue, buffer, state, marker);
    expect(r).toEqual({ generation: 5, uploaded: true });
    expect(writes).toEqual([{ offset: 0, data: ids, dataOffset: 0, size: 3 }]);
    marker = r.generation;
    r = uploadEntityIds(queue, buffer, state, marker);
    expect(r.uploaded).toBe(false);
    r = uploadEntityIds(queue, buffer, { ...state, entityIdsGeneration: 6 }, marker);
    expect(r).toEqual({ generation: 6, uploaded: true });
    expect(writes).toHaveLength(2);
  });

  it('uploads every frame when the generation is missing (NaN never matches)', () => {
    const { queue, writes } = recordingQueue();
    let marker = NaN;
    for (let frame = 0; frame < 3; frame++) {
      const r = uploadEntityIds(queue, buffer, { entityIds: ids, entityCount: 3, entityIdsGeneration: undefined as unknown as number }, marker);
      expect(r.uploaded).toBe(true);
      marker = r.generation;
    }
    expect(writes).toHaveLength(3);
  });

  it('writes nothing for an empty world, but moves the marker', () => {
    const { queue, writes } = recordingQueue();
    const r = uploadEntityIds(queue, buffer, { entityIds: new Uint32Array(0), entityCount: 0, entityIdsGeneration: 8 }, 7);
    expect(r).toEqual({ generation: 8, uploaded: false });
    expect(writes).toHaveLength(0);
  });
});

describe('renderer.ts uploads the entity ids on every frame kind', () => {
  it('calls uploadEntityIds once, after the scatter/full-upload if/else and outside both branches', () => {
    const src = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
    const branch = src.indexOf('if (useScatter) {');
    const call = src.indexOf('uploadEntityIds(', branch);
    const mask = src.indexOf('selectionManager.uploadMask(', branch);
    expect(branch).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(branch);
    expect(mask).toBeGreaterThan(call);
    // Every brace the if/else opened is closed before the call: it runs on
    // scatter frames (Mode C spawns) as well as on full uploads.
    const between = src.slice(branch, call);
    const depth = (between.match(/\{/g) ?? []).length - (between.match(/\}/g) ?? []).length;
    expect(depth).toBe(0);
    expect(src.split('uploadEntityIds(').length - 1).toBe(1);
  });
});

describe('missingSortInputs', () => {
  it('names the fields that are absent or not finite', () => {
    expect(missingSortInputs({ transparentCount: 0, entityIdsGeneration: 0 })).toEqual([]);
    expect(missingSortInputs({ transparentCount: NaN, entityIdsGeneration: 3 })).toEqual(['transparentCount']);
    expect(missingSortInputs({ transparentCount: 1, entityIdsGeneration: undefined as unknown as number }))
      .toEqual(['entityIdsGeneration']);
  });
});

describe('overCapacityWarning', () => {
  it('is null up to MAX_GPU_ENTITIES and names the limit past it', () => {
    expect(overCapacityWarning(0)).toBeNull();
    expect(overCapacityWarning(MAX_GPU_ENTITIES)).toBeNull();
    expect(overCapacityWarning(MAX_GPU_ENTITIES + 1)).toContain(`MAX_GPU_ENTITIES (${MAX_GPU_ENTITIES})`);
  });
});
```

- [ ] **Step 3: Esegui, atteso FAIL**

Run: `npx --prefix ts vitest run --root ts src/types.test.ts src/render/frame-inputs.test.ts src/render/passes/cull-pass.test.ts`
Atteso FAIL:
- `types.test.ts`: `MAX_GPU_ENTITIES` non esiste (import `undefined`): il default si aspetta `undefined`, il rifiuto non lancia, e il test della copia unica trova `100_000` in `renderer.ts` (1) e in `cull-pass.ts` (2);
- `frame-inputs.test.ts`: `uploadEntityIds is not a function` (e così `missingSortInputs`, `overCapacityWarning`); il test su `renderer.ts` fallisce perché `uploadEntityIds(` non c'è (`call` = -1);
- `cull-pass.test.ts`: `expected 100000 to be undefined`.

- [ ] **Step 4: `MAX_GPU_ENTITIES` e `validateConfig`**

In `ts/src/types.ts`, subito dopo `export const MAX_EXTERNAL_ID = 1_048_575;` (L68) aggiungi:

```ts

/**
 * Rows the GPU buffers hold: every SoA column, the cull's per-bucket regions
 * of `visible-indices`, `entity-ids` and the transparent sort are sized by it
 * (phase 5b §6.4). The one copy of the number — `renderer.ts`, `cull-pass.ts`
 * and the `maxEntities` default read it from here — and `validateConfig`
 * refuses a `maxEntities` above it. `cull.wgsl` takes it from the cull
 * uniform, not from a literal.
 */
export const MAX_GPU_ENTITIES = 100_000;
```

In `validateConfig` (L105-108) sostituisci:

```ts
  const maxEntities = config.maxEntities ?? 100_000;
  if (maxEntities <= 0) {
    throw new Error('maxEntities must be > 0');
  }
```

con:

```ts
  const maxEntities = config.maxEntities ?? MAX_GPU_ENTITIES;
  if (maxEntities <= 0) {
    throw new Error('maxEntities must be > 0');
  }
  if (maxEntities > MAX_GPU_ENTITIES) {
    throw new Error(`maxEntities (${maxEntities}) exceeds MAX_GPU_ENTITIES (${MAX_GPU_ENTITIES}): the GPU buffers hold that many rows`);
  }
```

- [ ] **Step 5: `CullPass` legge la costante**

In `ts/src/render/passes/cull-pass.ts`:
- dopo `import { extractFrustumPlanes } from '../../camera';` (L3) aggiungi `import { MAX_GPU_ENTITIES } from '../../types';`;
- sostituisci `    cullUints[1] = 100_000;             // maxEntitiesPerType (MAX_ENTITIES)` (L215) con `    cullUints[1] = MAX_GPU_ENTITIES;    // maxEntitiesPerType: the region size per bucket`;
- elimina la riga `    const MAX_ENTITIES_PER_TYPE = 100_000;` (L223);
- sostituisci `      resetData[i * 5 + 4] = i * MAX_ENTITIES_PER_TYPE;  // firstInstance = region offset` (L230) con `      resetData[i * 5 + 4] = i * MAX_GPU_ENTITIES;  // firstInstance = region offset`.

Il valore non cambia, quindi `cull.wgsl` resta com'è.

- [ ] **Step 6: Le tre funzioni nuove di `frame-inputs.ts`**

In `ts/src/render/frame-inputs.ts`, subito dopo il commento di testa (prima di `/** The gather's bound: ...`), aggiungi:

```ts
import type { GPURenderState } from '../worker-bridge';
import { MAX_GPU_ENTITIES } from '../types';
```

e in fondo al file aggiungi:

```ts

/**
 * Upload the slot -> external id column when its generation moved (phase 5b
 * §4.3, D6), the whole live part of it. Returns the generation the GPU now
 * holds and whether this frame wrote. The renderer calls it on EVERY frame
 * kind, scatter frames included: the 32-word scatter staging has no room for
 * the id, and a swap-remove moves rows between slots.
 */
export function uploadEntityIds(
  queue: Pick<GPUQueue, 'writeBuffer'>,
  buffer: GPUBuffer,
  state: Pick<GPURenderState, 'entityIds' | 'entityCount' | 'entityIdsGeneration'>,
  uploadedGeneration: number,
): { generation: number; uploaded: boolean } {
  const generation = normalizeIdsGeneration(state.entityIdsGeneration);
  // NaN never equals the marker: a missing generation uploads every frame.
  if (generation === uploadedGeneration || state.entityCount === 0) {
    return { generation, uploaded: false };
  }
  queue.writeBuffer(buffer, 0, state.entityIds as Uint32Array<ArrayBuffer>, 0, state.entityCount);
  return { generation, uploaded: true };
}

/**
 * The phase-5b fields a render state lacks (absent or not finite): a WASM
 * build older than the exports, or a transport site that drops them. The
 * renderer warns once, in dev.
 */
export function missingSortInputs(
  state: Pick<GPURenderState, 'transparentCount' | 'entityIdsGeneration'>,
): string[] {
  const missing: string[] = [];
  if (!Number.isFinite(state.transparentCount)) missing.push('transparentCount');
  if (!Number.isFinite(state.entityIdsGeneration)) missing.push('entityIdsGeneration');
  return missing;
}

/**
 * The one-time warning for a frame with more rows than the GPU buffers hold,
 * or null. The facade refuses spawns past `maxEntities` (≤ MAX_GPU_ENTITIES),
 * but raw spawns are not counted; past the capacity every SoA `writeBuffer`
 * fails validation, so the frame is lost anyway.
 */
export function overCapacityWarning(entityCount: number): string | null {
  if (entityCount <= MAX_GPU_ENTITIES) return null;
  return `[Hyperion] ${entityCount} entities exceed MAX_GPU_ENTITIES (${MAX_GPU_ENTITIES}): `
    + 'the GPU buffers hold that many rows, so the uploads of these frames fail validation. '
    + 'Raw spawns (engine.raw) are not counted against maxEntities.';
}
```

- [ ] **Step 7: `FrameState.frameStamp`**

In `ts/src/render/render-pass.ts` sostituisci:

```ts
  transparentCount: number;
}
```

con:

```ts
  transparentCount: number;
  /**
   * Phase 5b: this `render()`'s stamp, in [1, 0xFFFFFFFE] (`nextFrameStamp`,
   * a counter of the renderer's closure, so it survives graph swaps). The
   * sort's gather writes it into the `transparent-args` header, which proves
   * the gather ran in this frame.
   */
  frameStamp: number;
}
```

In `ts/src/render/passes/debug-line-pass.test.ts`, in `makeFrame`, sostituisci `    transparentCount: 0,\n  };` con:

```ts
    transparentCount: 0,
    frameStamp: 1,
  };
```

- [ ] **Step 8: Il renderer: costante, buffer `entity-ids`, locali, upload, `frameStamp`, warning**

In `ts/src/renderer.ts` (gli ancoraggi sono testuali: dopo i Task 6-7 le righe non coincidono con `aa9ee92`).

(a) Import. Sostituisci la riga aggiunta nel Task 10

```ts
import { normalizeTransparentCount } from './render/frame-inputs';
```

con:

```ts
import {
  normalizeTransparentCount, nextFrameStamp, uploadEntityIds, missingSortInputs, overCapacityWarning,
} from './render/frame-inputs';
import { MAX_GPU_ENTITIES } from './types';
```

(b) Elimina la riga `const MAX_ENTITIES = 100_000;` e rinomina i suoi usi:

```bash
sed -i -E 's/\bMAX_ENTITIES\b/MAX_GPU_ENTITIES/g' ts/src/renderer.ts
grep -nE '\bMAX_ENTITIES\b' ts/src/renderer.ts
```

Il `grep` non deve stampare nulla. Gli usi rinominati sono `new SelectionManager(...)` e le dimensioni di `entity-transforms`, `entity-bounds`, `visible-indices`, `tex-indices`, `render-meta`, `prim-params` e `selection-mask` (8 righe).

(c) Pool. Sostituisci:

```ts
  resources.setBuffer('selection-mask', selectionMaskBuffer);
```

con:

```ts
  resources.setBuffer('selection-mask', selectionMaskBuffer);

  // Slot -> external id (phase 5b §4.3): the transparent sort breaks z ties
  // by id. Renderer-owned like every pool buffer: graph swaps and hot-reload
  // probes re-run their passes' setup(), so a pass-owned buffer would come
  // back empty while `uploadedIdsGeneration` still said "uploaded".
  const entityIdsBuffer = device.createBuffer({
    size: MAX_GPU_ENTITIES * 4,
    // COPY_SRC in dev builds (design §4.3), like entity-transforms.
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | (dev ? GPUBufferUsage.COPY_SRC : 0),
    label: 'entity-ids',
  });
  resources.setBuffer('entity-ids', entityIdsBuffer);
```

(`dev` è già dichiarato più in alto in `createRenderer`, subito dopo `context.configure(...)`.)

(d) Locali della closure. Sostituisci:

```ts
  let warnedMultiBitReceiver = false;
```

con:

```ts
  let warnedMultiBitReceiver = false;

  // --- 8b''. Transparent sort inputs (phase 5b §4.2-4.3) ---
  // Closure locals, not pass state: they must survive graph swaps and the
  // hot-reload probes. NaN never equals a generation, so the first frame
  // uploads the entity ids; a renderer ever put back under a re-initialised
  // engine (whose generation restarts at 0) must reset this marker to NaN.
  let uploadedIdsGeneration = NaN;
  let frameStamp = 0; // the first render() stamps 1
  let warnedMissingSortInputs = false;
  let warnedOverCapacity = false;
```

(e) Inizio di `render()`. Sostituisci:

```ts
    render(state: GPURenderState, camera: { viewProjection: Float32Array }, dt?: number) {
      followBackend(state.lightingBackend);
```

con:

```ts
    render(state: GPURenderState, camera: { viewProjection: Float32Array }, dt?: number) {
      frameStamp = nextFrameStamp(frameStamp);
      followBackend(state.lightingBackend);
      if (dev && !warnedMissingSortInputs) {
        const missing = missingSortInputs(state);
        if (missing.length > 0) {
          warnedMissingSortInputs = true;
          console.warn(`[Hyperion] The render state lacks ${missing.join(' and ')} (a WASM build older than phase 5b, or a transport site that drops it): the transparent sort is sized from entityCount and the entity ids are uploaded every frame.`);
        }
      }
      if (!warnedOverCapacity) {
        const overCapacity = overCapacityWarning(state.entityCount);
        if (overCapacity) {
          warnedOverCapacity = true;
          console.warn(overCapacity);
        }
      }
```

(f) L'upload fra l'if/else e la selection mask. Sostituisci:

```ts
      // Upload selection mask if dirty
      if (requests.requested.mode.outlines || host.mode.outlines) {
```

con:

```ts
      // Entity ids: on EVERY frame kind, outside the if/else above — the
      // scatter staging carries no id, and a swap-remove moves rows between
      // slots. Only when the slot -> id mapping changed (its generation).
      const idsUpload = uploadEntityIds(device.queue, entityIdsBuffer, state, uploadedIdsGeneration);
      uploadedIdsGeneration = idsUpload.generation;

      // Upload selection mask if dirty
      if (requests.requested.mode.outlines || host.mode.outlines) {
```

(g) `FrameState`. Sostituisci:

```ts
        transparentCount: normalizeTransparentCount(state.transparentCount, state.entityCount),
      };
```

con:

```ts
        transparentCount: normalizeTransparentCount(state.transparentCount, state.entityCount),
        frameStamp,
      };
```

- [ ] **Step 9: Esegui, atteso PASS**

Run: `npx --prefix ts vitest run --root ts src/types.test.ts src/render/frame-inputs.test.ts src/render/passes/cull-pass.test.ts src/render/passes/debug-line-pass.test.ts`
Atteso: tutti verdi (+3 in `types.test.ts`, +6 in `frame-inputs.test.ts`, +1 in `cull-pass.test.ts`).
Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Atteso: nessuna riga. Un altro literal completo di `FrameState` che `tsc` segnala per `frameStamp` riceve `frameStamp: 1`.
Run: `npm --prefix ts test`
Atteso: tutto verde, 10 test in più rispetto al Task 10.

- [ ] **Step 10: Commit**

```bash
git add ts/src/types.ts ts/src/types.test.ts ts/src/render/frame-inputs.ts ts/src/render/frame-inputs.test.ts ts/src/render/render-pass.ts ts/src/render/passes/cull-pass.ts ts/src/render/passes/cull-pass.test.ts ts/src/render/passes/debug-line-pass.test.ts ts/src/renderer.ts
git commit -m "feat(5b): colonna entity-ids caricata per generazione, frameStamp e MAX_GPU_ENTITIES" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: cancello GPU del passo 2

Criterio di uscita del passo 2 (spec §8): test Rust e TS verdi, `protocol-sync-checker` pulito, **stati dei tab uguali alla baseline e tutti i punti di C identici al bit**, in Mode B e in Mode C. In più si verifica a runtime, con il WASM vero, che i due campi arrivino in `latestRenderState` e si muovano come devono. Il Mode A non si può verificare su questa macchina (l'initScript non raggiunge i worker); lo coprono i test di trasporto del Task 10. Se un controllo fallisce: fermati, diagnostica con la skill `superpowers:systematic-debugging`, e non passare al Passo 3.

`npm --prefix ts run build` (tsc + vite build) non è un criterio: fallisce già su `aa9ee92` (`worker.format "iife"` con code-splitting nei worker), a prescindere da questa fase.

**Files:**
- Nessun file del repo cambia. Le catture della corsa (`B-<tab>.json`, `C-<tab>.json`, `statuses-B.json`, `statuses-C.json`) vanno nella cartella scratchpad della sessione, in `<scratchpad>/5b-step2/`. L'esito si registra in un commit vuoto.

**Interfaces:**
- Consumes: le esportazioni WASM del Task 9 (build `npm --prefix ts run build:wasm`); il flag `?bench` del Task 1 (mondo vuoto, `window.__hyperion` impostato, motore in esecuzione); `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js` e `compare.mjs` e la baseline del Task 3, con la procedura di cattura del Task 3 Step 9 e la CLI `node compare.mjs --base <dir> --run <dir> --mode B|C --step 0|1|2|3|4 [--allow-new-skip '<check>' …]` (uscita 0 PASS, 1 FAIL, 2 input sbagliato); l'agent `protocol-sync-checker`.
- Produces: il commit del cancello, con il riassunto del confronto nel corpo.

- [ ] **Step 1: WASM ricostruito con le esportazioni nuove**

Run: `npm --prefix ts run build:wasm`
Run: `grep -c "engine_gpu_transparent_count\|engine_gpu_entity_ids_generation" ts/wasm/hyperion_core.d.ts`
Atteso: `4` (le due funzioni esportate più le due voci di `InitOutput`).

- [ ] **Step 2: Validazione headless completa**

Run: `scripts/preflight.sh`
Atteso: tutto verde (matrice delle feature Rust, clippy `-D warnings`, vitest, tsc, controllo del protocollo).

- [ ] **Step 3: Dev server pulito**

Ferma il dev server se gira (i Task 5-8 hanno riscritto shader: Vite può servire una trasformazione vecchia di `?raw`), poi avvialo in background con Bash `run_in_background`: `npm --prefix ts run dev -- --strictPort --port 5173`.
Run: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/`
Atteso: `200`.

- [ ] **Step 4: I campi arrivano e si muovono — Mode C**

Con il server MCP **chrome-devtools-gpu**. Prima di tutto `list_pages` → `pageId` (o `new_page` con `url: "about:blank"` se non c'è una pagina); `pageId` su ogni chiamata MCP che segue e `waitForStableDom: false` su ogni `evaluate_script`, qui e negli Step 5-6 (il pannello dei check si ridisegna ogni 500 ms e l'HUD a ogni frame: il DOM non si assesta mai):
1. `resize_page` con `pageId`, `width: 1920`, `height: 1080`.
2. `navigate_page` con `pageId`, `type: "url"`, `url: "http://localhost:5173/?mode=C&bench"`, `ignoreCache: true` e `initScript`:
   ```js
   GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)
   ```
3. `list_console_messages` con `pageId` (tipi `log`, `info`, `warn`): la riga dell'adapter deve dire AMD (non nvidia, non SwiftShader), e la riga `Harness execution mode: C`.
4. `evaluate_script` con `pageId`, `waitForStableDom: false` e questa funzione:

```js
async () => {
  const e = window.__hyperion;
  const frames = (n) => new Promise((resolve) => {
    let k = 0;
    const step = () => (++k >= n ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  const read = () => {
    const s = e.bridge.latestRenderState;
    let rows = 0;
    for (let i = 0; i < s.entityCount; i++) if (s.renderMeta[i * 2 + 1] & 0x100) rows++;
    return { entityCount: s.entityCount, transparentCount: s.transparentCount, transparentRows: rows, generation: s.entityIdsGeneration };
  };
  await frames(4);
  const before = read();
  const handles = [0, 1, 2].map((i) => e.spawn({ mode: '2d' }).position(i * 2, 0).transparent());
  handles.push(e.spawn({ mode: '2d' }).position(8, 0));
  await frames(6);
  const spawned = read();
  handles[0].destroy();
  await frames(6);
  const despawned = read();
  await frames(6);
  const idle = read();
  for (const h of handles.slice(1)) h.destroy();
  await frames(6);
  const after = read();
  return { mode: e.mode, before, spawned, despawned, idle, after };
}
```

Criteri, tutti obbligatori:
- in ognuna delle cinque letture `transparentCount === transparentRows` (il ricalcolo Rust coincide con il conteggio sulle stesse righe) e `generation` è un intero (mai `NaN`: `NaN` vorrebbe dire che l'esportazione non arriva);
- `spawned.entityCount - before.entityCount === 4`, `spawned.transparentCount - before.transparentCount === 3`, `spawned.generation !== before.generation`;
- `despawned.entityCount === spawned.entityCount - 1`, `despawned.transparentCount === spawned.transparentCount - 1`, `despawned.generation !== spawned.generation`;
- `idle.generation === despawned.generation` (nessun cambio di mappatura, nessun incremento);
- `after.entityCount === before.entityCount`, `after.generation !== idle.generation`.

5. `list_console_messages` con `pageId` (tipi `warn`, `error`): nessun `[Hyperion] The render state lacks ...` (vorrebbe dire un sito di trasporto rotto o un WASM vecchio), nessun errore che nomini WebGPU, validation, pipeline o device. L'unico 404 ammesso è `favicon.ico`.

- [ ] **Step 5: I campi arrivano e si muovono — Mode B**

Ripeti lo Step 4 (stesso `pageId`, `waitForStableDom: false` su ogni `evaluate_script`) con `url: "http://localhost:5173/?mode=B&bench"` (e `Harness execution mode: B`): stessa funzione, stessi criteri. Nel Mode B `latestRenderState` è indietro di un tick: le attese di 6 frame lo coprono.

- [ ] **Step 6: Baseline senza perdita — stati e C al bit, Mode B e Mode C**

La cattura è la procedura del Task 3 Step 9, alla lettera: `pageId` e `waitForStableDom: false` su OGNI `evaluate_script`, una pagina `?bench` nuova per modo (`capture.js` lancia `capture from a ?bench page` su una pagina senza `bench`), i tab nell'ordine di `TABS`, poi il file degli stati. Cartella: `<scratchpad>/5b-step2` (percorso assoluto; la scratchpad è quella indicata nel system prompt della sessione). Prima del primo modo, Bash: `mkdir -p <scratchpad>/5b-step2`.

Per ciascun modo `M` in `B`, `C`:
1. `list_pages` → `pageId`; `resize_page` con `pageId`, `width: 1920`, `height: 1080` (PRIMA della navigazione).
2. `navigate_page` con `pageId`, `type: "url"`, `url: "http://localhost:5173/?mode=M&bench"`, `ignoreCache: true` e lo stesso `initScript` dello Step 4.
3. `list_console_messages` con `pageId`, `types: ["info", "warn"]` → la riga dell'adapter `amd` (non nvidia, non SwiftShader) e `[Hyperion] ?bench: no section opened; window.__hyperion is the engine`.
4. Per ogni chiave `K`, **una volta sola e in quest'ordine** (`TABS` di `compare.mjs`, lo stesso di `SECTION_LOADERS` in `main.ts`): `primitives`, `scene-graph`, `input`, `audio`, `particles`, `rendering-fx`, `lighting`, `debug-tools`, `lifecycle`, `twin-2d`:
   - `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__captureOpts = { tab: 'K' }; return true; }"` (con la chiave vera al posto di `K`);
   - `evaluate_script` con `pageId`, `waitForStableDom: false`, `function` = il testo di `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js` alla lettera (leggilo con Read e passalo così com'è) e `filePath: "<scratchpad>/5b-step2/M-K.json"`. Ogni chiamata dura da 2 a 12 s.
5. Stati dei tab: `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__captureOpts = { statuses: true }; return true; }"`; poi `evaluate_script` con `pageId`, `waitForStableDom: false`, `function` = `capture.js` alla lettera e `filePath: "<scratchpad>/5b-step2/statuses-M.json"`. `compare.mjs` carica sempre `statuses-M.json` da `--run`: senza questo file esce con 2.
6. Se una chiamata restituisce un errore, la cattura di quel modo è da buttare: si riparte dal punto 2 (navigazione nuova) e si riscrivono tutti i file di `M` in `<scratchpad>/5b-step2`.
7. `list_console_messages` con `pageId` (tipi `warn`, `error`): gli stessi criteri dello Step 4.5.
8. Confronto, una volta con `M = B` e una con `M = C` (percorso assoluto vero al posto di `<scratchpad>`):

```bash
node docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs --base docs/plans/assets/2026-09-27-transparent-sort-baseline --run <scratchpad>/5b-step2 --mode M --step 2; echo "exit $?"
```

Atteso: `exit 0`; per ogni tab una riga `M <tab> OK` (Lighting `excluded (Lighting: statuses only)`, gli altri `C=… (grid N/2304)`), poi `M statuses      OK` e, in fondo, `PASS`. Cioè:
- **stati**: nessun check fallito; ogni tab ha gli stessi check in skip o pending della baseline (l'Input resta a 2/6 con i 4 check d'interazione in pending; in Rendering FX 'Tonemap switch' resta in skip); ogni check che passava passa ancora. Al passo 2 non c'è nessun check nuovo (il primo arriva al passo 3), quindi niente `--allow-new-skip`;
- **pixel**: tutti i punti di C = S_base ∩ S_run \ (M_base ∪ M_run) identici al bit (f16): ai passi 0-3 `compare.mjs` vuole C intero al bit. Al passo 2 nessun pass legge ancora `entity-ids`, quindi l'immagine non deve cambiare di un bit.

- [ ] **Step 7: `protocol-sync-checker`**

Lancia l'agent `protocol-sync-checker` (tool Agent, `subagent_type: "protocol-sync-checker"`) con questo prompt:

> Phase 5b step 2 added two WASM exports in crates/hyperion-core/src/lib.rs: engine_gpu_transparent_count() -> u32 and engine_gpu_entity_ids_generation() -> u32. The engine worker's WASM calls moved out of ts/src/engine-worker.ts into ts/src/worker-render-state.ts (interface WasmEngine, function captureRenderState), which engine-worker.ts imports; Mode C's calls are in ts/src/worker-bridge.ts (createDirectBridge). Check: both exports are declared (optional methods) in both WASM interfaces and read in BOTH render-state literals of each site (non-empty and empty world); GPURenderState, WorkerRenderState and the three bridge sites carry transparentCount and entityIdsGeneration; no CommandType, ring-buffer header or payload changed. Report every mismatch with file:line.

Atteso: nessuna discrepanza. Una discrepanza si corregge (con il suo test) prima del commit.

- [ ] **Step 8: Commit del cancello**

Metti nel corpo il riassunto di `compare.mjs` per B e C (una riga per tab) e l'esito degli Step 4-5:

```bash
git commit --allow-empty -m "test(5b): cancello GPU del passo 2 superato (B e C: stati e C identici alla baseline)" -m "<riassunto di compare.mjs per B e C, esito dei controlli di runtime degli Step 4-5, protocol-sync-checker pulito>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Il secondo `-m` si riempie con l'output reale degli Step 4-7, copiato così com'è.

### Task 13: costanti + modello CPU (driver a fasi, verificatori di race, kernel, oracolo)

Questo task scrive in TypeScript i quattro kernel del sort (§5.3) **prima** del WGSL. Il modello è la specifica eseguibile: il Task 14 scrive `transparent-gather.wgsl` e `transparent-sort.wgsl` rispecchiandolo riga per riga, e i Task 16-17 confrontano la readback della GPU con lo stesso layout di buffer, parola per parola. È tutto TS puro, senza GPU.

Com'è fatto il modello (§7.1):
- **Fase** = il codice tra due `workgroupBarrier()`. Nel modello ogni fase è un loop sui 256 lane, in un ordine scelto dal chiamante (`Schedule.laneOrder`). I workgroup di un dispatch girano uno dopo l'altro, in un ordine scelto dal chiamante (`Schedule.workgroupOrder`). I test li mescolano con un PRNG con seed: niente `Math.random`, così un fallimento si riproduce.
- **`SharedMemory`** lancia un errore quando due lane diversi toccano la stessa parola di workgroup nella stessa fase, e uno dei due accessi non commuta con l'altro. Commutano soltanto accessi della stessa classe: letture (normali o `atomicLoad`), `atomicAdd`, `atomicOr`, oppure `atomicStore` dello stesso valore. Lancia anche su un accesso normale a un array `atomic<u32>`, e viceversa: è la tipizzazione di WGSL.
- **`GlobalConflictChecker`** lancia un errore quando una parola di storage scritta da un'invocazione viene toccata da un'altra nello stesso dispatch. È **più severo** della spec (§7.1 parla di "scritto da un workgroup e letto da un altro"): include due lane dello stesso workgroup e le scritture doppie, perché `workgroupBarrier()` ordina solo la memoria di workgroup. Nessun kernel del §5.3 comunica attraverso lo storage dentro un dispatch, quindi la regola più stretta non scarta niente di legittimo, e prende una destinazione duplicata dello scatter.
- I buffer sono `Uint32Array` con il layout GPU parola per parola. `header` = `transparent-args`; `keysA`/`keysB` = `sort-keys-a`/`-b`, con `lo` in [0, CAP) e `hi` in [CAP, 2·CAP); `valsA` = `sort-vals-a`; `valsB` = `transparent-order`; `hist` = `sort-hist`. `runSortModel` li riempie con `STALE_WORD` (0xDEADBEEF), come un buffer GPU che contiene ancora il frame precedente: un kernel che leggesse una parola prima di averla scritta darebbe un risultato sbagliato.

Si procede in quattro cicli TDD: (1) costanti e chiavi, (2) verificatori di race, (3) driver e gather, (4) passate radix e oracolo.

**Due cose da sapere prima di cominciare:**
- Il test e il modello ricevono gli import COMPLETI già alla prima parte. I nomi che le parti successive definiscono restano `undefined` finché non esistono: vitest carica i moduli con la trasformazione SSR di Vite, che risolve i named import in modo pigro (verificato). Per questo i test dei cicli 2-4 falliscono con "`… is not a constructor`" o "`… is not a function`". `tsc` gira solo allo Step 18, perché prima segnalerebbe import non usati (TS6133).
- L'hook PostToolUse `post-edit-ts.sh` esegue il test colocato dopo ogni modifica. Un fallimento subito dopo aver modificato il file di test è il RED atteso.

**Files:**
- Create: `ts/src/render/passes/transparent-sort-constants.ts` (88 righe)
- Create: `ts/src/render/passes/transparent-sort-reference.ts` (740 righe, scritto in 4 parti)
- Test (Create): `ts/src/render/passes/transparent-sort-reference.test.ts` (878 righe, scritto in 4 parti)
- Nessun file esistente cambia.

**Interfaces:**
- Consumes: `MAX_GPU_ENTITIES` (= `100_000`) da `ts/src/types.ts`, esportato dal Task 11.
- Produces, da `transparent-sort-constants.ts` (i nomi del contratto più sei in più, marcati con *):
  ```ts
  WORKGROUP_SIZE = 256; TILE = 1024; ROUNDS = 4; RADIX = 256; PASSES = 7; LAST_PASS = 6;
  LO_PASSES = 3 /* * */; MASK_WORDS = 8 /* * */; SCAN_CHUNK = 8 /* * */;
  FIRST_TRANSPARENT_ARG = 14; GATHER_REGIONS = 12;
  ARG_WORDS = 5 /* * */; ARG_INSTANCE_COUNT = 1 /* * */; ARG_FIRST_INSTANCE = 4 /* * */;
  CAP = MAX_GPU_ENTITIES; NUM_TILES = Math.ceil(CAP / TILE) /* 98 */;
  HEADER_WORDS = 16; HEADER_BYTES = 64; H_DRAW = 0; H_DISPATCH = 5; H_RAW = 8; H_LIMIT = 9;
  H_OVERFLOW = 10; H_STAMP = 11; DISPATCH_OFFSET_BYTES = 20; STAMP_SENTINEL = 0xFFFFFFFF;
  DIAG_WORDS = 16; DIGIT_BASE_OFFSET = 16; TILES_OFFSET = DIGIT_BASE_OFFSET + PASSES * RADIX /* 1808 */;
  HIST_WORDS = TILES_OFFSET + NUM_TILES * RADIX /* 26 896 = 107 584 B */;
  DIAG_SCAN_MISMATCH = 1; DIAG_SCATTER_OOB = 2; PASS_PARAMS_STRIDE = 256;
  ```
- Produces, da `transparent-sort-reference.ts` (le firme del contratto; `STALE_WORD`, `createSortModelBuffers`, `cpuPrepare` e `GlobalBinding` sono in più):
  ```ts
  export function sortableZBits(bits: number): number;
  export function digitOf(lo: number, hi: number, pass: number): number;
  export function oracleOrder(vals: Uint32Array, lo: Uint32Array, hi: Uint32Array, n: number): Uint32Array;
  export interface SortModelInput { indirectArgs: Uint32Array; visibleIndices: Uint32Array; boundsBits: Uint32Array; entityIds: Uint32Array; limit: number; stamp: number }
  export interface SortModelBuffers { header: Uint32Array; keysA: Uint32Array; keysB: Uint32Array; valsA: Uint32Array; valsB: Uint32Array; hist: Uint32Array }
  export interface Schedule { workgroupOrder?(count: number, dispatch: string): number[]; laneOrder?(workgroup: number, phase: number): number[] }
  export const STALE_WORD = 0xDEADBEEF;
  export function createSortModelBuffers(fill?: number /* STALE_WORD */): SortModelBuffers;
  export function cpuPrepare(bufs: SortModelBuffers, limit: number): void; // = TransparentSortPass.prepare()
  export class SharedMemory {
    readonly words: Uint32Array;
    constructor(layout: ReadonlyArray<readonly [name: string, words: number, atomic: boolean]>);
    base(name: string): number; reset(): void; barrier(): void; setLane(lane: number): void;
    load(addr: number): number; store(addr: number, value: number): void;
    atomicLoad(addr: number): number; atomicStore(addr: number, value: number): void;
    atomicAdd(addr: number, value: number): number; atomicOr(addr: number, value: number): number;
  }
  export class GlobalConflictChecker {
    readonly epoch: number; readonly dispatch: string; readonly invocation: number;
    constructor(dispatch: string);
    setInvocation(workgroup: number, lane: number): void;
    bind(name: string, data: Uint32Array, access: 'read' | 'read_write'): GlobalBinding;
  }
  export class GlobalBinding { readonly name: string; readonly data: Uint32Array; read(addr: number): number; write(addr: number, value: number): void; atomicOr(addr: number, value: number): number }
  export function cpuGather(input: SortModelInput, bufs: SortModelBuffers, schedule?: Schedule): void;
  export function cpuUpsweep(pass: number, bufs: SortModelBuffers, schedule?: Schedule): void;
  export function cpuScan(pass: number, bufs: SortModelBuffers, schedule?: Schedule): void;
  export function cpuScatter(pass: number, bufs: SortModelBuffers, schedule?: Schedule): void;
  export function runSortModel(input: SortModelInput, schedule?: Schedule): SortModelBuffers; // valsB = order
  ```
- Produces, per il Task 14: la struttura a barriere che il WGSL deve rispecchiare. I nomi di dispatch passati a `workgroupOrder` sono `'gather'`, `'upsweep:p'`, `'scan:p'` e `'scatter:p'`, e `phase` riparte da 0 per ogni workgroup:

  | Kernel | Workgroup | Fasi | Barriere eseguite | Memoria di workgroup |
  |---|---|---|---|---|
  | `gather_main` | `ceil(limit/256)` | 2 | 1 | `regionEnd: array<u32,12>`, `regionBase: array<u32,12>` (96 B) |
  | `upsweep_main` | `header[5]` | 3 | 2 | `wgHist: array<atomic<u32>,256>` (1024 B) |
  | `scan_main` | 1 | 18 | 17 (1 + 2·8) | `totals: array<u32,256>` (1024 B) |
  | `scatter_main` | `header[5]` | 13 | 13 (B0 + B1/B2/B3 × 4; B3 chiude il kernel) | `masks: array<atomic<u32>,2048>`, `cursor: array<u32,256>` (9216 B) |

- [ ] **Step 1: Scrivi la prima parte del test: import, helper, test delle costanti e delle chiavi**

Crea `ts/src/render/passes/transparent-sort-reference.test.ts` con questo contenuto. Gli helper servono a tutti i cicli:
- `buildScene` costruisce l'uscita del cull come la vede il gather: 28 record `DrawIndexedIndirect`. I 12 trasparenti (14-25) hanno regioni di dimensioni casuali, anche vuote. I 16 record "veleno" (opachi 0-13, Light2D 26/27) contengono 5 slot ciascuno, con z = -1e30: se il gather li raccogliesse, finirebbero in testa all'ordine. Le regioni stanno in `visible-indices` in ordine mescolato, separate da parole `0xFFFFFFFF`, oppure (`layout: 'cull'`) nella disposizione vera `b × CAP`. Gli id sono unici per costruzione: il moltiplicatore dispari è una biiezione su 2^20.
- `floatOracle` è l'oracolo indipendente dal modello: `Array.sort` per (z float, id), con -0 === +0 e ±Inf confrontati come float.

```ts
import { describe, it, expect } from 'vitest';
import { MAX_GPU_ENTITIES } from '../../types';
import {
  ARG_WORDS,
  CAP,
  DIAG_SCAN_MISMATCH,
  DIAG_SCATTER_OOB,
  DIAG_WORDS,
  DIGIT_BASE_OFFSET,
  DISPATCH_OFFSET_BYTES,
  FIRST_TRANSPARENT_ARG,
  GATHER_REGIONS,
  H_DISPATCH,
  H_DRAW,
  H_STAMP,
  HEADER_BYTES,
  HEADER_WORDS,
  HIST_WORDS,
  LAST_PASS,
  NUM_TILES,
  PASSES,
  RADIX,
  STAMP_SENTINEL,
  TILE,
  TILES_OFFSET,
  WORKGROUP_SIZE,
} from './transparent-sort-constants';
import {
  GlobalConflictChecker,
  STALE_WORD,
  SharedMemory,
  cpuGather,
  cpuPrepare,
  cpuScan,
  cpuScatter,
  cpuUpsweep,
  createSortModelBuffers,
  digitOf,
  oracleOrder,
  runSortModel,
  sortableZBits,
  type Schedule,
  type SortModelBuffers,
  type SortModelInput,
} from './transparent-sort-reference';

// ── Seeded randomness: no Math.random, a failure must replay ─────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rand: () => number, n: number): number {
  return Math.floor(rand() * n);
}

function identity(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

function shuffleInPlace(a: { length: number; [i: number]: number }, rand: () => number): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rand, i + 1);
    const x = a[i];
    a[i] = a[j];
    a[j] = x;
  }
}

/** Workgroups shuffled per dispatch; lanes from a pool of 16 shuffled permutations (cheap at 100k). */
function shuffledSchedule(seed: number): Schedule {
  const rand = mulberry32(seed);
  const pool: number[][] = [];
  for (let k = 0; k < 16; k++) {
    const p = identity(WORKGROUP_SIZE);
    shuffleInPlace(p, rand);
    pool.push(p);
  }
  return {
    workgroupOrder: (count) => {
      const p = identity(count);
      shuffleInPlace(p, rand);
      return p;
    },
    laneOrder: (workgroup, phase) => pool[(Math.imul(workgroup, 7) + Math.imul(phase, 13)) & 15],
  };
}

const REVERSED_LANES = identity(WORKGROUP_SIZE).reverse();
const reversedSchedule: Schedule = {
  workgroupOrder: (count) => identity(count).reverse(),
  laneOrder: () => REVERSED_LANES,
};

// ── Scenes: the cull's output as the gather sees it ──────────────────────────

const F32 = new Float32Array(1);
const F32_BITS = new Uint32Array(F32.buffer);
function f32Bits(x: number): number {
  F32[0] = x;
  return F32_BITS[0];
}
function bitsF32(bits: number): number {
  F32_BITS[0] = bits;
  return F32[0];
}

type Distribution =
  | 'equal' | 'two' | 'distinct' | 'descending' | 'extreme-ids' | 'signed-zero' | 'denormal' | 'infinite';
const DISTRIBUTIONS: Distribution[] = [
  'equal', 'two', 'distinct', 'descending', 'extreme-ids', 'signed-zero', 'denormal', 'infinite',
];
// ±0, the smallest and largest denormals, the smallest normals.
const DENORMAL_BITS = [
  0x00000000, 0x80000000, 0x00000001, 0x00000002, 0x007FFFFF,
  0x80000001, 0x80000002, 0x807FFFFF, 0x00800000, 0x80800000,
];
// ±Inf, ±FLT_MAX, 0, ±1.
const INFINITE_BITS = [0x7F800000, 0xFF800000, 0x7F7FFFFF, 0xFF7FFFFF, 0x00000000, 0x3F800000, 0xBF800000];

/** z bits of the e-th gathered element (of `count`). */
function zGenerator(dist: Distribution, count: number, rand: () => number): (e: number) => number {
  switch (dist) {
    case 'equal':
    case 'extreme-ids':
      return () => f32Bits(1.5);
    case 'two':
      return () => f32Bits(rand() < 0.5 ? -2 : 3);
    case 'distinct': {
      const perm = identity(count);
      shuffleInPlace(perm, rand);
      return (e) => f32Bits((perm[e] - count / 2) * 0.25);
    }
    case 'descending':
      return (e) => f32Bits((count - e) * 0.5);
    case 'signed-zero':
      return () => (rand() < 0.5 ? 0x00000000 : 0x80000000);
    case 'denormal':
      return () => DENORMAL_BITS[randInt(rand, DENORMAL_BITS.length)];
    case 'infinite':
      return () => INFINITE_BITS[randInt(rand, INFINITE_BITS.length)];
  }
}

const TOTAL_ARGS = 28;
const TRANSPARENT_BUCKETS = identity(GATHER_REGIONS).map((k) => FIRST_TRANSPARENT_ARG + k);
/** Opaque buckets and the transparent Light2D ones: filled on purpose, never read. */
const POISON_BUCKETS = [...identity(FIRST_TRANSPARENT_ARG), 26, 27];
const POISON_PER_BUCKET = 5;
/** Between regions: a slot no row has, so reading one is an out-of-range read. */
const GAP_WORD = 0xFFFFFFFF;

interface Scene {
  input: SortModelInput;
  /** The slots in gather order: region 0's content, then region 1's, … */
  gathered: Uint32Array;
  /** Per transparent region k: its size and its firstInstance. */
  sizes: number[];
  bases: number[];
}

interface SceneOptions {
  seed?: number;
  /** Region sizes (must sum to n); random by default, some regions empty. */
  sizes?: number[];
  /** Default: n + 37, capped at CAP — the CPU count is an upper bound (offscreen transparents count). */
  limit?: number;
  /** 'compact' (default): regions in a shuffled order with gaps. 'cull': region b at b × CAP, like cull-pass.ts. */
  layout?: 'compact' | 'cull';
}

function randomSplit(n: number, parts: number, rand: () => number): number[] {
  const sizes = new Array<number>(parts).fill(0);
  if (n === 0) return sizes;
  // Cuts at random points: uneven regions, some of them empty.
  const cuts = [0, n];
  for (let k = 0; k < parts - 1; k++) cuts.push(randInt(rand, n + 1));
  cuts.sort((a, b) => a - b);
  for (let k = 0; k < parts; k++) sizes[k] = cuts[k + 1] - cuts[k];
  return sizes;
}

/** Moves external id `value` to `row`, keeping the ids unique. */
function placeId(ids: Uint32Array, row: number, value: number): void {
  const at = ids.indexOf(value);
  if (at >= 0) ids[at] = ids[row];
  ids[row] = value;
}

function buildScene(n: number, dist: Distribution, options: SceneOptions = {}): Scene {
  const rand = mulberry32(options.seed ?? n * 31 + DISTRIBUTIONS.indexOf(dist) + 1);
  const sizes = options.sizes ?? randomSplit(n, GATHER_REGIONS, rand);
  if (sizes.length !== GATHER_REGIONS || sizes.reduce((a, b) => a + b, 0) !== n) throw new Error('sizes must sum to n');
  const rows = n + POISON_BUCKETS.length * POISON_PER_BUCKET;
  const rowOrder = identity(rows);
  shuffleInPlace(rowOrder, rand);

  const content: number[][] = Array.from({ length: TOTAL_ARGS }, () => []);
  let next = 0;
  TRANSPARENT_BUCKETS.forEach((b, k) => {
    for (let j = 0; j < sizes[k]; j++) content[b].push(rowOrder[next++]);
  });
  for (const b of POISON_BUCKETS) {
    for (let j = 0; j < POISON_PER_BUCKET; j++) content[b].push(rowOrder[next++]);
  }

  const bases = new Array<number>(TOTAL_ARGS).fill(0);
  let visibleIndices: Uint32Array;
  if (options.layout === 'cull') {
    for (let b = 0; b < TOTAL_ARGS; b++) bases[b] = b * CAP;
    visibleIndices = new Uint32Array(TOTAL_ARGS * CAP).fill(GAP_WORD);
  } else {
    const placement = identity(TOTAL_ARGS);
    shuffleInPlace(placement, rand);
    let offset = 0;
    for (const b of placement) {
      offset += randInt(rand, 4);
      bases[b] = offset;
      offset += content[b].length;
    }
    visibleIndices = new Uint32Array(offset + 3).fill(GAP_WORD);
  }
  const indirectArgs = new Uint32Array(TOTAL_ARGS * ARG_WORDS);
  for (let b = 0; b < TOTAL_ARGS; b++) {
    indirectArgs.set([6, content[b].length, 0, 0, bases[b]], b * ARG_WORDS);
    visibleIndices.set(content[b], bases[b]);
  }

  const boundsBits = new Uint32Array(rows * 4);
  const entityIds = new Uint32Array(rows);
  const idOffset = randInt(rand, 1 << 20);
  for (let r = 0; r < rows; r++) {
    // An odd multiplier is a bijection on [0, 2^20): the ids are unique.
    entityIds[r] = (Math.imul(r, 0x9E3B5) + idOffset) & 0xFFFFF;
    boundsBits[r * 4] = f32Bits(r);
    boundsBits[r * 4 + 1] = f32Bits(-r);
    boundsBits[r * 4 + 2] = f32Bits(-1e30); // a gathered poison row would sort first
    boundsBits[r * 4 + 3] = f32Bits(0.5);
  }
  const gathered = Uint32Array.from(TRANSPARENT_BUCKETS.flatMap((b) => content[b]));
  const zOf = zGenerator(dist, gathered.length, rand);
  gathered.forEach((slot, e) => {
    boundsBits[slot * 4 + 2] = zOf(e);
  });
  if (dist === 'extreme-ids' && gathered.length > 0) {
    placeId(entityIds, gathered[0], 0);
    placeId(entityIds, gathered[gathered.length - 1], 0xFFFFF);
  }
  return {
    input: {
      indirectArgs,
      visibleIndices,
      boundsBits,
      entityIds,
      limit: options.limit ?? Math.min(CAP, n + 37),
      stamp: 1 + randInt(rand, 0xFFFFFFFE),
    },
    gathered,
    sizes,
    bases: TRANSPARENT_BUCKETS.map((b) => bases[b]),
  };
}

/** The same scene with each region's content shuffled (what the cull's atomics do from frame to frame). */
function shuffleRegions(scene: Scene, seed: number): SortModelInput {
  const rand = mulberry32(seed);
  const visibleIndices = scene.input.visibleIndices.slice();
  scene.sizes.forEach((size, k) => shuffleInPlace(visibleIndices.subarray(scene.bases[k], scene.bases[k] + size), rand));
  return { ...scene.input, visibleIndices };
}

/**
 * The oracle, independent of the model: `Array.sort` of the first `count`
 * gathered slots by (float z, id). -0 === +0 and ±Inf compare as floats.
 */
function floatOracle(scene: Scene, count = scene.gathered.length): Uint32Array {
  const { boundsBits, entityIds } = scene.input;
  const slots = scene.gathered.subarray(0, count);
  const z = Array.from(slots, (s) => bitsF32(boundsBits[s * 4 + 2]));
  const id = Array.from(slots, (s) => entityIds[s]);
  const idx = identity(count);
  idx.sort((a, b) => (z[a] - z[b]) || (id[a] - id[b]));
  return Uint32Array.from(idx, (e) => slots[e]);
}

/** null when equal, else where they first differ (cheaper and clearer than toEqual at 100k). */
function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): string | null {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return `index ${i}: ${a[i]} vs ${b[i]}`;
  }
  return null;
}

function expectSorted(scene: Scene, bufs: SortModelBuffers): void {
  const n = scene.gathered.length;
  const { limit, stamp } = scene.input;
  expect(Array.from(bufs.header.subarray(0, 12))).toEqual(
    [6, n, 0, 0, 0, Math.ceil(n / TILE), 1, 1, n, limit, 0, stamp],
  );
  expect(Array.from(bufs.hist.subarray(0, DIAG_WORDS))).toEqual(new Array(DIAG_WORDS).fill(0));
  expect(firstDifference(bufs.valsB.subarray(0, n), floatOracle(scene))).toBeNull();
  // Nothing past n: transparent-order keeps the last frame's words there.
  expect(bufs.valsB.subarray(n).every((w) => w === STALE_WORD)).toBe(true);
}

/** Stable counting sort of `vals` by digit `pass`: what one scatter must produce. */
function stableCountingSort(lo: Uint32Array, hi: Uint32Array, vals: Uint32Array, pass: number) {
  const n = vals.length;
  const start = new Uint32Array(RADIX);
  for (let i = 0; i < n; i++) start[digitOf(lo[i], hi[i], pass)]++;
  let running = 0;
  for (let d = 0; d < RADIX; d++) {
    const c = start[d];
    start[d] = running;
    running += c;
  }
  const out = { lo: new Uint32Array(n), hi: new Uint32Array(n), vals: new Uint32Array(n) };
  for (let i = 0; i < n; i++) {
    const at = start[digitOf(lo[i], hi[i], pass)]++;
    out.lo[at] = lo[i];
    out.hi[at] = hi[i];
    out.vals[at] = vals[i];
  }
  return out;
}

function passBuffers(bufs: SortModelBuffers, pass: number) {
  const even = pass % 2 === 0;
  return {
    keysIn: even ? bufs.keysA : bufs.keysB,
    valsIn: even ? bufs.valsA : bufs.valsB,
    keysOut: even ? bufs.keysB : bufs.keysA,
    valsOut: even ? bufs.valsB : bufs.valsA,
  };
}

/** Gathers `scene` into fresh buffers (prepare + gather). */
function gatherScene(scene: Scene, schedule?: Schedule): SortModelBuffers {
  const bufs = createSortModelBuffers();
  cpuPrepare(bufs, scene.input.limit);
  cpuGather(scene.input, bufs, schedule);
  return bufs;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('transparent-sort constants', () => {
  it('match the design (§5.2) and the GPU capacity', () => {
    expect(CAP).toBe(MAX_GPU_ENTITIES);
    expect(NUM_TILES).toBe(98);
    expect(PASSES % 2).toBe(1); // odd: the last pass writes B = transparent-order
    expect(LAST_PASS).toBe(PASSES - 1);
    expect(TILE).toBe(4 * WORKGROUP_SIZE);
    expect(HEADER_BYTES).toBe(HEADER_WORDS * 4);
    expect(DISPATCH_OFFSET_BYTES).toBe(H_DISPATCH * 4);
    expect(HIST_WORDS * 4).toBe(107_584);
    expect(TILES_OFFSET).toBe(DIGIT_BASE_OFFSET + PASSES * RADIX);
    expect(FIRST_TRANSPARENT_ARG + GATHER_REGIONS).toBe(26); // records 26/27 are Light2D
  });
});

describe('sortableZBits', () => {
  it('maps -0 and +0 to one key', () => {
    expect(sortableZBits(0x80000000)).toBe(sortableZBits(0x00000000));
    expect(sortableZBits(0)).toBe(0x80000000);
  });

  it('orders keys like floats, infinities and denormals included', () => {
    const ascending = [
      -Infinity, -3.4028234663852886e38, -1, -1.1754943508222875e-38, -1e-45, 0,
      1e-45, 1.1754943508222875e-38, 1, 3.4028234663852886e38, Infinity,
    ];
    const keys = ascending.map((x) => sortableZBits(f32Bits(x)));
    for (let i = 1; i < keys.length; i++) expect(keys[i]).toBeGreaterThan(keys[i - 1]);
  });

  it('agrees with float comparison on random pairs', () => {
    const rand = mulberry32(11);
    // A magnitude below the +Inf pattern and a random sign: finite, never NaN.
    const finite = () => bitsF32((randInt(rand, 0x7F800000) | (rand() < 0.5 ? 0x80000000 : 0)) >>> 0);
    for (let i = 0; i < 2000; i++) {
      const a = finite();
      const b = finite();
      const ka = sortableZBits(f32Bits(a));
      const kb = sortableZBits(f32Bits(b));
      expect(Math.sign(ka - kb)).toBe(Math.sign(a - b));
    }
  });
});

describe('digitOf', () => {
  it('reads lo in passes 0-2 and hi in passes 3-6', () => {
    const lo = 0x000ABCDE;
    const hi = 0x12345678;
    expect([0, 1, 2, 3, 4, 5, 6].map((p) => digitOf(lo, hi, p))).toEqual([0xDE, 0xBC, 0x0A, 0x78, 0x56, 0x34, 0x12]);
  });
});

describe('oracleOrder', () => {
  it('sorts by hi, then lo, keeping input order on equal keys', () => {
    const vals = Uint32Array.from([10, 11, 12, 13]);
    const lo = Uint32Array.from([5, 1, 5, 0]);
    const hi = Uint32Array.from([2, 2, 2, 1]);
    expect(Array.from(oracleOrder(vals, lo, hi, 4))).toEqual([13, 11, 10, 12]);
  });
});
```

- [ ] **Step 2: Esegui il test: deve fallire**

Run: `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-reference.test.ts`
Expected: FAIL, 0 test eseguiti, con `Error: Cannot find module './transparent-sort-constants'` (o il `Failed to resolve import` di Vite): il modulo non esiste ancora.

- [ ] **Step 3: Crea il file delle costanti**

Crea `ts/src/render/passes/transparent-sort-constants.ts`:

```ts
/**
 * Shared constants of the transparent sort (phase 5b, design §5): the shape of
 * the kernels and the word layout of their buffers. `TransparentSortPass`
 * sizes and binds with them, the CPU model (`transparent-sort-reference.ts`)
 * simulates with them, and the text-agreement tests pin the `const` literals
 * of `transparent-gather.wgsl` / `transparent-sort.wgsl` against them.
 */
import { MAX_GPU_ENTITIES } from '../../types';

// ── Kernel shape ─────────────────────────────────────────────────────────────

/** Threads per workgroup, in every kernel of the sort. */
export const WORKGROUP_SIZE = 256;
/** Elements per tile: one upsweep/scatter workgroup takes ROUNDS × WORKGROUP_SIZE. */
export const TILE = 1024;
/** Rounds per tile: a lane handles element `t·TILE + r·WORKGROUP_SIZE + lid` in round r. */
export const ROUNDS = 4;
/** Values of one digit (8-bit digits). */
export const RADIX = 256;
/**
 * LSD passes: 3 over `lo` (the 20-bit external id), 4 over `hi` (the z key).
 * Odd, so the last pass writes B, which is `transparent-order`.
 */
export const PASSES = 7;
/** The last pass writes the values only: nothing reads its keys. */
export const LAST_PASS = 6;
/** Passes 0..LO_PASSES-1 take their digit from `lo`, the others from `hi`. */
export const LO_PASSES = 3;
/** Scatter mask words per digit: one bit per lane. */
export const MASK_WORDS = WORKGROUP_SIZE / 32;
/** Tiles the scan's column loop loads per chunk. */
export const SCAN_CHUNK = 8;

// ── What the gather reads from the cull ──────────────────────────────────────

/** First transparent record of `indirect-args`: cull.wgsl puts the 14 opaque buckets first. */
export const FIRST_TRANSPARENT_ARG = 14;
/**
 * Transparent regions the gather reads: types 0-5 × 2 texture buckets, records
 * 14-25. Records 26/27 (a `.transparent()` Light2D) stay LightAccumStage's.
 */
export const GATHER_REGIONS = 12;
/** Words of one DrawIndexedIndirect record of `indirect-args`. */
export const ARG_WORDS = 5;
/** The record word holding the region's element count (instanceCount). */
export const ARG_INSTANCE_COUNT = 1;
/** The record word holding the region's first `visible-indices` word (firstInstance). */
export const ARG_FIRST_INSTANCE = 4;

// ── Buffers ──────────────────────────────────────────────────────────────────

/** Elements the sort holds: the GPU row capacity. Keys are SoA: lo at [0, CAP), hi at [CAP, 2·CAP). */
export const CAP = MAX_GPU_ENTITIES;
/** Tiles of a full sort (98 at CAP = 100 000). */
export const NUM_TILES = Math.ceil(CAP / TILE);

/** `transparent-args`, word by word (design §5.2). */
export const HEADER_WORDS = 16;
export const HEADER_BYTES = 64;
/** Words 0-4: DrawIndexedIndirect {6, n, 0, 0, 0} of the uber draw. */
export const H_DRAW = 0;
/** Words 5-7: DispatchIndirect {ceil(n / TILE), 1, 1} of the upsweep and the scatter. */
export const H_DISPATCH = 5;
/** Word 8: raw, the sum of the 12 region counts. */
export const H_RAW = 8;
/** Word 9: limit (= B). */
export const H_LIMIT = 9;
/** Word 10: 1 when raw > limit. */
export const H_OVERFLOW = 10;
/** Word 11: the frame's stamp, written by the gather only (prepare() writes STAMP_SENTINEL). */
export const H_STAMP = 11;
/** Byte offset of the DispatchIndirect args in `transparent-args`. */
export const DISPATCH_OFFSET_BYTES = 20;
/** What prepare() writes in word 11: a stamp is never this value. */
export const STAMP_SENTINEL = 0xFFFFFFFF;

/** `sort-hist`: diag (16 atomic words), then digitBase (one 256-word row per pass), then the tile table. */
export const DIAG_WORDS = 16;
export const DIGIT_BASE_OFFSET = 16;
export const TILES_OFFSET = DIGIT_BASE_OFFSET + PASSES * RADIX;
export const HIST_WORDS = TILES_OFFSET + NUM_TILES * RADIX;
/** diag[0] bit 0: a scan's total differs from n. */
export const DIAG_SCAN_MISMATCH = 1;
/** diag[0] bit 1: a scatter destination was >= n. */
export const DIAG_SCATTER_OOB = 2;

/** Bytes per `sort-pass-params` slice (the uniform offset alignment). */
export const PASS_PARAMS_STRIDE = 256;
```

- [ ] **Step 4: Crea la prima parte del modello: header, chiavi, input, buffer, prepare**

Crea `ts/src/render/passes/transparent-sort-reference.ts`. L'import delle costanti è già quello finale: le parti 2-4 usano i nomi che qui restano inutilizzati.

```ts
/**
 * CPU model of the transparent sort (phase 5b, design §5 and §7.1): the gather
 * and the three radix kernels, simulated phase by phase. They are the SAME
 * kernels as `transparent-gather.wgsl` (`gather_main`) and
 * `transparent-sort.wgsl` (`upsweep_main`, `scan_main`, `scatter_main`), line
 * for line: a change to one is a change to the other.
 *
 * - A phase is the code between two `workgroupBarrier()`: here, a loop over the
 *   256 lanes, in an order the caller picks (`Schedule.laneOrder`). The
 *   workgroups of a dispatch run one after the other, in an order the caller
 *   picks too (`Schedule.workgroupOrder`).
 * - `SharedMemory` throws when a lane touches a workgroup word another lane
 *   wrote in the same phase: the model only runs if no result depends on the
 *   lane order. Atomics commute with each other.
 * - `GlobalConflictChecker` throws when a storage word written by one
 *   invocation is touched by another in the same dispatch
 *   (`workgroupBarrier()` orders workgroup memory only).
 *
 * The buffers are Uint32Arrays with the GPU layout word for word, so a
 * readback compares with them directly: `header` = `transparent-args`, `keysA`
 * / `keysB` = `sort-keys-a` / `sort-keys-b` (lo at [0, CAP), hi at [CAP,
 * 2·CAP)), `valsA` = `sort-vals-a`, `valsB` = `transparent-order`, `hist` =
 * `sort-hist` (diag, digitBase, tiles).
 */
import {
  ARG_FIRST_INSTANCE,
  ARG_INSTANCE_COUNT,
  ARG_WORDS,
  CAP,
  DIAG_SCAN_MISMATCH,
  DIAG_SCATTER_OOB,
  DIAG_WORDS,
  DIGIT_BASE_OFFSET,
  FIRST_TRANSPARENT_ARG,
  GATHER_REGIONS,
  H_DISPATCH,
  H_DRAW,
  H_LIMIT,
  H_OVERFLOW,
  H_RAW,
  H_STAMP,
  HEADER_WORDS,
  HIST_WORDS,
  LAST_PASS,
  LO_PASSES,
  MASK_WORDS,
  PASSES,
  RADIX,
  ROUNDS,
  SCAN_CHUNK,
  STAMP_SENTINEL,
  TILE,
  TILES_OFFSET,
  WORKGROUP_SIZE,
} from './transparent-sort-constants';

// ── Keys ─────────────────────────────────────────────────────────────────────

/**
 * The z key (design §5.1), from the bits of `entity-bounds[slot].z` as the
 * gather computes it: -0 becomes +0 by an integer compare (no float operation
 * touches z), then the flip that makes unsigned order follow float order — a
 * negative z has every bit inverted, a positive one gets the sign bit set.
 */
export function sortableZBits(bits: number): number {
  let zb = bits >>> 0;
  if (zb === 0x80000000) zb = 0;
  return ((zb & 0x80000000) !== 0 ? ~zb : zb | 0x80000000) >>> 0;
}

/** The 8-bit digit of pass `pass`: passes 0-2 read `lo` (the id), 3-6 read `hi` (the z key). */
export function digitOf(lo: number, hi: number, pass: number): number {
  return pass < LO_PASSES
    ? (lo >>> (8 * pass)) & 0xFF
    : (hi >>> (8 * (pass - LO_PASSES))) & 0xFF;
}

/**
 * The oracle: `vals[0..n)` sorted by (hi, lo), ties in input order. With
 * unique ids there are no ties, so the result is the one permutation the GPU
 * sort must produce.
 */
export function oracleOrder(vals: Uint32Array, lo: Uint32Array, hi: Uint32Array, n: number): Uint32Array {
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => (hi[a] - hi[b]) || (lo[a] - lo[b]) || (a - b));
  const out = new Uint32Array(n);
  for (let j = 0; j < n; j++) out[j] = vals[idx[j]];
  return out;
}

// ── Inputs, buffers, schedule ────────────────────────────────────────────────

export interface SortModelInput {
  /** `indirect-args`: 28 DrawIndexedIndirect records (cull.wgsl). */
  indirectArgs: Uint32Array;
  /** `visible-indices`: each record's region of slots, from its firstInstance. */
  visibleIndices: Uint32Array;
  /** `entity-bounds` read as u32 bits: 4 words per slot, z at word 2. */
  boundsBits: Uint32Array;
  /** `entity-ids`: slot → external id. */
  entityIds: Uint32Array;
  /** `GatherParams.limit` = B = min(normalised transparentCount, CAP). */
  limit: number;
  /** `GatherParams.stamp` = `FrameState.frameStamp`, in [1, 0xFFFFFFFE]. */
  stamp: number;
}

export interface SortModelBuffers {
  header: Uint32Array;
  keysA: Uint32Array;
  keysB: Uint32Array;
  valsA: Uint32Array;
  valsB: Uint32Array;
  hist: Uint32Array;
}

/**
 * The order the model runs things in. Every order is legal on a GPU, so a
 * correct kernel gives the same buffers under every schedule.
 */
export interface Schedule {
  /** The workgroup ids of a dispatch ('gather', 'upsweep:p', 'scan:p', 'scatter:p'), in run order. */
  workgroupOrder?(count: number, dispatch: string): number[];
  /** The 256 lanes of phase `phase` (0-based, per workgroup) of workgroup `workgroup`, in run order. */
  laneOrder?(workgroup: number, phase: number): number[];
}

/** What the model puts in a buffer before a run: the previous frame's contents, which nothing may read. */
export const STALE_WORD = 0xDEADBEEF;

/** Buffers of the GPU sizes, filled with `fill`. */
export function createSortModelBuffers(fill: number = STALE_WORD): SortModelBuffers {
  const make = (words: number) => new Uint32Array(words).fill(fill);
  return {
    header: make(HEADER_WORDS),
    keysA: make(2 * CAP),
    keysB: make(2 * CAP),
    valsA: make(CAP),
    valsB: make(CAP),
    hist: make(HIST_WORDS),
  };
}

/** `TransparentSortPass.prepare()`: the header reset (stamp = sentinel) and diag zeroed. */
export function cpuPrepare(bufs: SortModelBuffers, limit: number): void {
  bufs.header.set([6, 0, 0, 0, 0, 0, 1, 1, 0, limit, 0, STAMP_SENTINEL, 0, 0, 0, 0]);
  bufs.hist.fill(0, 0, DIAG_WORDS);
}
```

- [ ] **Step 5: Esegui il test: deve passare**

Run: `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-reference.test.ts`
Expected: PASS, `Tests  6 passed (6)` (costanti, 3 × `sortableZBits`, `digitOf`, `oracleOrder`).

- [ ] **Step 6: Aggiungi i test dei verificatori di race**

Aggiungi in fondo al file di test. Il blocco "Hillis-Steele over 256 totals in place" è il test della spec: la forma a due barriere passa con i lane in ordine crescente, decrescente e mescolato, e la forma a una barriera iniettata (`totals[d] += totals[d - off]`) lancia un errore in tutti e tre gli ordini. Il verificatore non dipende dall'ordine per trovare la race.

```ts
describe('SharedMemory (workgroup race checker)', () => {
  function lanes(shm: SharedMemory, order: number[], body: (lane: number) => void): void {
    for (const lane of order) {
      shm.setLane(lane);
      body(lane);
    }
  }

  it('lets every lane atomicAdd, atomicOr or read one word in the same phase', () => {
    const shm = new SharedMemory([['h', 2, true], ['p', 1, false]]);
    shm.reset();
    lanes(shm, identity(256), () => shm.atomicAdd(0, 1));
    lanes(shm, identity(256), (l) => shm.atomicOr(1, 1 << (l & 31)));
    shm.barrier();
    lanes(shm, identity(256), () => shm.atomicLoad(0));
    lanes(shm, identity(256), () => shm.load(2));
    expect(shm.words[0]).toBe(256);
    expect(shm.words[1]).toBe(0xFFFFFFFF);
  });

  it('lets several lanes atomicStore the same value, not different ones', () => {
    const shm = new SharedMemory([['m', 1, true]]);
    shm.reset();
    lanes(shm, [3, 7, 9], () => shm.atomicStore(0, 0));
    shm.barrier();
    expect(() => lanes(shm, [3, 7], (l) => shm.atomicStore(0, l))).toThrow(/race on m\[0\]/);
  });

  it('rejects an atomicLoad next to another lane\'s atomicAdd (order-dependent)', () => {
    const shm = new SharedMemory([['h', 1, true]]);
    shm.reset();
    shm.setLane(0);
    shm.atomicAdd(0, 1);
    shm.setLane(1);
    expect(() => shm.atomicLoad(0)).toThrow(/race on h\[0\]: lanes 0 and 1/);
  });

  it('rejects a plain write touched by another lane, in either order', () => {
    const w = new SharedMemory([['t', 4, false]]);
    w.reset();
    w.setLane(0);
    w.store(1, 5);
    w.setLane(1);
    expect(() => w.load(1)).toThrow(/race on t\[1\]/);

    const r = new SharedMemory([['t', 4, false]]);
    r.reset();
    r.setLane(1);
    r.load(1);
    r.setLane(0);
    expect(() => r.store(1, 5)).toThrow(/race on t\[1\]/);
  });

  it('lets one lane read and write its own word, and a barrier separates phases', () => {
    const shm = new SharedMemory([['t', 2, false]]);
    shm.reset();
    shm.setLane(0);
    shm.store(0, 1);
    shm.store(0, shm.load(0) + 1);
    shm.barrier();
    shm.setLane(1);
    expect(shm.load(0)).toBe(2);
  });

  it('enforces atomic<u32> versus u32 and the array bounds', () => {
    const shm = new SharedMemory([['a', 1, true], ['p', 1, false]]);
    shm.reset();
    expect(() => shm.load(0)).toThrow(/a\[0\], which is atomic<u32>/);
    expect(() => shm.atomicLoad(1)).toThrow(/p\[0\], which is u32/);
    expect(() => shm.load(2)).toThrow(RangeError);
    expect(() => shm.load(-1)).toThrow(RangeError);
  });

  it('zeroes the words on reset (a new workgroup)', () => {
    const shm = new SharedMemory([['t', 2, false]]);
    shm.reset();
    shm.store(0, 9);
    shm.reset();
    expect(shm.words[0]).toBe(0);
  });

  describe('Hillis-Steele over 256 totals in place', () => {
    const REVERSED = identity(256).reverse();
    const SHUFFLED = identity(256);
    shuffleInPlace(SHUFFLED, mulberry32(5));

    it.each([['ascending', identity(256)], ['descending', REVERSED], ['shuffled', SHUFFLED]])(
      'the two-barrier step (read into v, then write) passes with %s lanes',
      (_name, order) => {
        const shm = new SharedMemory([['totals', 256, false]]);
        shm.reset();
        lanes(shm, order, (d) => shm.store(d, 1));
        shm.barrier();
        const v = new Uint32Array(256);
        for (let off = 1; off < 256; off <<= 1) {
          lanes(shm, order, (d) => {
            v[d] = 0;
            if (d >= off) v[d] = shm.load(d - off);
          });
          shm.barrier();
          lanes(shm, order, (d) => shm.store(d, shm.load(d) + v[d]));
          shm.barrier();
        }
        expect(Array.from(shm.words)).toEqual(identity(256).map((d) => d + 1));
      },
    );

    it.each([['ascending', identity(256)], ['descending', REVERSED], ['shuffled', SHUFFLED]])(
      'an injected one-barrier step (totals[d] += totals[d - off]) throws with %s lanes',
      (_name, order) => {
        const shm = new SharedMemory([['totals', 256, false]]);
        shm.reset();
        lanes(shm, order, (d) => shm.store(d, 1));
        shm.barrier();
        expect(() => {
          for (let off = 1; off < 256; off <<= 1) {
            lanes(shm, order, (d) => {
              if (d >= off) shm.store(d, shm.load(d) + shm.load(d - off));
            });
            shm.barrier();
          }
        }).toThrow(/workgroup race on totals\[/);
      },
    );
  });
});

describe('GlobalConflictChecker (storage conflicts within a dispatch)', () => {
  it('rejects a word written by one workgroup and read by another', () => {
    const g = new GlobalConflictChecker('test');
    const buf = g.bind('buf', new Uint32Array(8), 'read_write');
    g.setInvocation(0, 3);
    buf.write(5, 1);
    g.setInvocation(1, 3);
    expect(() => buf.read(5)).toThrow(/buf\[5\] touched by invocations \(wg 0, lane 3\) and \(wg 1, lane 3\)/);
  });

  it('rejects two writers of one word, even in one workgroup', () => {
    const g = new GlobalConflictChecker('test');
    const buf = g.bind('buf', new Uint32Array(8), 'read_write');
    g.setInvocation(2, 0);
    buf.write(1, 1);
    g.setInvocation(2, 1);
    expect(() => buf.write(1, 2)).toThrow(/touched by invocations/);
  });

  it('allows read-after-write by the same invocation, shared reads and atomicOr from all', () => {
    const g = new GlobalConflictChecker('test');
    const buf = g.bind('buf', new Uint32Array(8), 'read_write');
    g.setInvocation(0, 0);
    buf.write(0, 4);
    expect(buf.read(0)).toBe(4);
    for (let wg = 0; wg < 3; wg++) {
      g.setInvocation(wg, 9);
      buf.read(1);
      buf.atomicOr(2, 1 << wg);
    }
    expect(buf.data[2]).toBe(7);
  });

  it('forgets everything at the next dispatch', () => {
    const data = new Uint32Array(4);
    const first = new GlobalConflictChecker('first');
    first.setInvocation(0, 0);
    first.bind('buf', data, 'read_write').write(0, 1);
    const second = new GlobalConflictChecker('second');
    second.setInvocation(5, 5);
    expect(second.bind('buf', data, 'read_write').read(0)).toBe(1);
  });

  it('rejects a write through a read-only binding and any out-of-range access', () => {
    const g = new GlobalConflictChecker('test');
    const ro = g.bind('ro', new Uint32Array(4), 'read');
    expect(() => ro.write(0, 1)).toThrow(/bound read-only/);
    expect(() => ro.read(4)).toThrow(RangeError);
    expect(() => ro.read(0xFFFFFFFF)).toThrow(RangeError);
  });
});
```

- [ ] **Step 7: Esegui il test: i nuovi devono fallire**

Run: `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-reference.test.ts`
Expected: FAIL, `Tests  18 failed | 6 passed (24)`, con `TypeError: … SharedMemory is not a constructor` e `TypeError: … GlobalConflictChecker is not a constructor`.

- [ ] **Step 8: Aggiungi i verificatori di race al modello**

Aggiungi in fondo a `transparent-sort-reference.ts`, dopo una riga vuota. `AccessTracker` registra, per ogni parola, chi l'ha toccata nell'epoca corrente e con quale classe di accesso. Un'epoca è una fase per la memoria di workgroup e un dispatch per lo storage. Grazie alle epoche il reset è gratuito: a 100k elementi niente viene riazzerato tra una fase e l'altra. I tracker dello storage si riusano per nome e lunghezza, perché ogni epoca è unica per il suo dispatch.

```ts
// ── Race checkers ────────────────────────────────────────────────────────────

// Access classes. Two accesses to one word by different actors in the same
// epoch (a phase, or a dispatch) commute only when both are in the same class:
// reads (plain or atomicLoad), atomicAdd, atomicOr, or atomicStore of one
// value. A plain write commutes with nothing another actor does.
const C_READ = 1;
const C_ADD = 2;
const C_OR = 3;
const C_STORE = 4;
const C_WRITE = 5;
const C_MIXED = 6;

/** Per word: who touched it in the current epoch, and how. Epochs make a reset free. */
class AccessTracker {
  private readonly epoch: Uint32Array;
  private readonly first: Int32Array;
  private readonly second: Int32Array;
  private readonly cls: Uint8Array;
  private readonly stored: Uint32Array;

  constructor(size: number) {
    this.epoch = new Uint32Array(size);
    this.first = new Int32Array(size);
    this.second = new Int32Array(size);
    this.cls = new Uint8Array(size);
    this.stored = new Uint32Array(size);
  }

  /** -1 when the access commutes with every other access to `addr` in epoch `now`, else the actor it races with. */
  touch(addr: number, now: number, actor: number, c: number, value: number): number {
    if (this.epoch[addr] !== now) {
      this.epoch[addr] = now;
      this.first[addr] = actor;
      this.second[addr] = -1;
      this.cls[addr] = c;
      this.stored[addr] = value;
      return -1;
    }
    let cls = this.cls[addr];
    if (cls !== c || (c === C_STORE && this.stored[addr] !== value)) cls = C_MIXED;
    this.cls[addr] = cls;
    const first = this.first[addr];
    if (actor !== first && this.second[addr] === -1) this.second[addr] = actor;
    if (this.second[addr] !== -1 && (cls === C_MIXED || cls === C_WRITE)) {
      return actor !== first ? first : this.second[addr];
    }
    return -1;
  }
}

/**
 * The `var<workgroup>` arrays of one kernel, laid out back to back. Zeroed by
 * `reset()` (WGSL zero-initialises workgroup memory for every workgroup). An
 * access racing with another lane's in the same phase throws, and so does a
 * plain access to an `atomic<u32>` array or an atomic one to a plain array.
 */
export class SharedMemory {
  readonly words: Uint32Array;
  private readonly atomic: Uint8Array;
  private readonly tracker: AccessTracker;
  private readonly regions: Array<{ name: string; base: number; size: number }> = [];
  private now = 1;
  private lane = 0;

  constructor(layout: ReadonlyArray<readonly [name: string, words: number, atomic: boolean]>) {
    let size = 0;
    for (const [name, words] of layout) {
      this.regions.push({ name, base: size, size: words });
      size += words;
    }
    this.words = new Uint32Array(size);
    this.atomic = new Uint8Array(size);
    layout.forEach(([, words, atomic], k) => {
      if (atomic) this.atomic.fill(1, this.regions[k].base, this.regions[k].base + words);
    });
    this.tracker = new AccessTracker(size);
  }

  /** First word of the array called `name`. */
  base(name: string): number {
    const region = this.regions.find((r) => r.name === name);
    if (!region) throw new Error(`no workgroup array '${name}'`);
    return region.base;
  }

  /** A new workgroup: zeroed words, and nothing before races with anything after. */
  reset(): void {
    this.words.fill(0);
    this.now++;
  }

  /** `workgroupBarrier()`: nothing before it races with anything after it. */
  barrier(): void {
    this.now++;
  }

  /** The lane whose accesses follow. */
  setLane(lane: number): void {
    this.lane = lane;
  }

  load(addr: number): number {
    this.check(addr, 0, C_READ, 0, 'read');
    return this.words[addr];
  }

  store(addr: number, value: number): void {
    this.check(addr, 0, C_WRITE, 0, 'write');
    this.words[addr] = value;
  }

  atomicLoad(addr: number): number {
    this.check(addr, 1, C_READ, 0, 'atomicLoad');
    return this.words[addr];
  }

  atomicStore(addr: number, value: number): void {
    this.check(addr, 1, C_STORE, value >>> 0, 'atomicStore');
    this.words[addr] = value;
  }

  atomicAdd(addr: number, value: number): number {
    this.check(addr, 1, C_ADD, 0, 'atomicAdd');
    const old = this.words[addr];
    this.words[addr] = old + value;
    return old;
  }

  atomicOr(addr: number, value: number): number {
    this.check(addr, 1, C_OR, 0, 'atomicOr');
    const old = this.words[addr];
    this.words[addr] = old | value;
    return old;
  }

  private check(addr: number, atomic: number, c: number, value: number, what: string): void {
    if ((addr >>> 0) !== addr || addr >= this.words.length) {
      throw new RangeError(`workgroup memory: ${what} at ${addr}, outside the ${this.words.length} words`);
    }
    if (this.atomic[addr] !== atomic) {
      throw new Error(`workgroup memory: ${what} of ${this.describe(addr)}, which is ${this.atomic[addr] ? 'atomic<u32>' : 'u32'}`);
    }
    const other = this.tracker.touch(addr, this.now, this.lane, c, value);
    if (other !== -1) {
      throw new Error(`workgroup race on ${this.describe(addr)}: lanes ${other} and ${this.lane} in one phase (${what})`);
    }
  }

  private describe(addr: number): string {
    const region = this.regions.find((r) => addr >= r.base && addr < r.base + r.size);
    return region ? `${region.name}[${addr - region.base}]` : `word ${addr}`;
  }
}

let dispatchEpoch = 0;
// Trackers are shared by every binding with the same name and length: an epoch
// is unique to its dispatch, so an entry of an older dispatch is stale by
// construction, and a test run allocates each tracker once.
const globalTrackers = new Map<string, AccessTracker>();

function describeInvocation(invocation: number): string {
  return `(wg ${Math.floor(invocation / WORKGROUP_SIZE)}, lane ${invocation % WORKGROUP_SIZE})`;
}

/**
 * The storage buffers of one dispatch. A word written by one invocation and
 * touched by another in the same dispatch throws: nothing orders two
 * invocations' storage accesses inside a dispatch. Between dispatches every
 * write is visible (each dispatch is its own usage scope).
 */
export class GlobalConflictChecker {
  readonly epoch = ++dispatchEpoch;
  private current = 0;

  constructor(readonly dispatch: string) {}

  /** `workgroup · 256 + lane` of the invocation whose accesses follow. */
  get invocation(): number {
    return this.current;
  }

  setInvocation(workgroup: number, lane: number): void {
    this.current = workgroup * WORKGROUP_SIZE + lane;
  }

  /** A binding: `'read'` is `var<storage, read>` (a write throws), `'read_write'` is tracked. */
  bind(name: string, data: Uint32Array, access: 'read' | 'read_write'): GlobalBinding {
    let tracker: AccessTracker | null = null;
    if (access === 'read_write') {
      const key = `${name}:${data.length}`;
      tracker = globalTrackers.get(key) ?? null;
      if (!tracker) {
        tracker = new AccessTracker(data.length);
        globalTrackers.set(key, tracker);
      }
    }
    return new GlobalBinding(this, name, data, tracker);
  }
}

/** One storage binding of a dispatch; every access is range-checked, a read_write one is also tracked. */
export class GlobalBinding {
  constructor(
    private readonly checker: GlobalConflictChecker,
    readonly name: string,
    readonly data: Uint32Array,
    private readonly tracker: AccessTracker | null,
  ) {}

  read(addr: number): number {
    this.check(addr, C_READ, 'read');
    return this.data[addr];
  }

  write(addr: number, value: number): void {
    this.check(addr, C_WRITE, 'write');
    this.data[addr] = value;
  }

  atomicOr(addr: number, value: number): number {
    this.check(addr, C_OR, 'atomicOr');
    const old = this.data[addr];
    this.data[addr] = old | value;
    return old;
  }

  private check(addr: number, c: number, what: string): void {
    const { dispatch, invocation } = this.checker;
    if ((addr >>> 0) !== addr || addr >= this.data.length) {
      throw new RangeError(`${dispatch}: ${what} of ${this.name}[${addr}], outside its ${this.data.length} words`);
    }
    if (this.tracker === null) {
      if (c !== C_READ) throw new Error(`${dispatch}: ${what} of ${this.name}, which is bound read-only`);
      return;
    }
    const other = this.tracker.touch(addr, this.checker.epoch, invocation, c, 0);
    if (other !== -1) {
      throw new Error(
        `${dispatch}: ${this.name}[${addr}] touched by invocations ${describeInvocation(other)} and ` +
        `${describeInvocation(invocation)}, one of them writing (${what})`,
      );
    }
  }
}
```

- [ ] **Step 9: Esegui il test: deve passare**

Run: `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-reference.test.ts`
Expected: PASS, `Tests  24 passed (24)`.

- [ ] **Step 10: Aggiungi i test del driver e del gather**

Aggiungi in fondo al file di test. Il test "reads only the count and firstInstance…" avvolge `indirectArgs` e `visibleIndices` in un `Proxy` che registra ogni indice letto. Verifica così la regola di §5.3 e §7.1: i record 0-13 e 26/27, riempiti apposta, non vengono mai letti, e le letture di `visible-indices` cadono solo dentro le 12 regioni trasparenti. Il `Proxy` funziona perché il modello indicizza gli array e ne legge solo `length`, senza chiamarne i metodi. `Reflect.get(target, prop)` senza receiver serve per il getter `length` dei typed array.

```ts
/** Phases per workgroup (by workgroup id), from the lane orders the driver asks the schedule for. */
function countPhases(run: (schedule: Schedule) => void): number[] {
  const phases = new Map<number, number>();
  run({
    laneOrder: (workgroup, phase) => {
      phases.set(workgroup, Math.max(phases.get(workgroup) ?? 0, phase + 1));
      return identity(WORKGROUP_SIZE);
    },
  });
  return [...phases.keys()].sort((a, b) => a - b).map((wg) => phases.get(wg) ?? 0);
}

describe('the driver', () => {
  it('rejects a lane order that is not a permutation of the 256 lanes', () => {
    const scene = buildScene(10, 'two');
    const bad: Schedule = { laneOrder: () => identity(255) };
    expect(() => gatherScene(scene, bad)).toThrow(/laneOrder\(0, 0\): 255 entries/);
  });

  it('rejects a workgroup order that is not a permutation', () => {
    const scene = buildScene(600, 'two'); // limit 637: 3 gather workgroups
    const bad: Schedule = { workgroupOrder: (count) => new Array<number>(count).fill(0) };
    expect(() => gatherScene(scene, bad)).toThrow(/workgroupOrder\(3, 'gather'\): not a permutation/);
  });

  it('runs the gather in 2 phases per workgroup: one barrier', () => {
    const scene = buildScene(1500, 'two');
    expect(countPhases((s) => gatherScene(scene, s)))
      .toEqual(new Array<number>(Math.ceil(scene.input.limit / WORKGROUP_SIZE)).fill(2));
  });
});

describe('cpuGather', () => {
  it('lays the 12 regions end to end: slot, id and z key per element, nothing past n', () => {
    const scene = buildScene(2047, 'distinct');
    const bufs = gatherScene(scene, shuffledSchedule(1));
    const n = scene.gathered.length;
    const { boundsBits, entityIds } = scene.input;
    expect(firstDifference(bufs.valsA.subarray(0, n), scene.gathered)).toBeNull();
    expect(firstDifference(bufs.keysA.subarray(0, n), Array.from(scene.gathered, (s) => entityIds[s]))).toBeNull();
    expect(firstDifference(
      bufs.keysA.subarray(CAP, CAP + n),
      Array.from(scene.gathered, (s) => sortableZBits(boundsBits[s * 4 + 2])),
    )).toBeNull();
    expect(bufs.valsA.subarray(n).every((w) => w === STALE_WORD)).toBe(true);
    expect(bufs.keysA.subarray(n, CAP).every((w) => w === STALE_WORD)).toBe(true);
    expect(bufs.keysA.subarray(CAP + n).every((w) => w === STALE_WORD)).toBe(true);
    expect(Array.from(bufs.header.subarray(0, 12))).toEqual(
      [6, n, 0, 0, 0, Math.ceil(n / TILE), 1, 1, n, scene.input.limit, 0, scene.input.stamp],
    );
  });

  it('reads only the count and firstInstance of records 14-25, and only inside their regions', () => {
    const scene = buildScene(1025, 'two');
    const argReads = new Set<number>();
    const indexReads = new Set<number>();
    const record = (data: Uint32Array, log: Set<number>): Uint32Array => new Proxy(data, {
      get(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) log.add(Number(prop));
        return Reflect.get(target, prop);
      },
    });
    const input = {
      ...scene.input,
      indirectArgs: record(scene.input.indirectArgs, argReads),
      visibleIndices: record(scene.input.visibleIndices, indexReads),
    };
    const bufs = createSortModelBuffers();
    cpuPrepare(bufs, input.limit);
    cpuGather(input, bufs, shuffledSchedule(2));

    const allowedArgs = new Set(TRANSPARENT_BUCKETS.flatMap((b) => [b * ARG_WORDS + 1, b * ARG_WORDS + 4]));
    expect([...argReads].filter((w) => !allowedArgs.has(w))).toEqual([]);
    const inRegion = (w: number) => scene.sizes.some((size, k) => w >= scene.bases[k] && w < scene.bases[k] + size);
    expect([...indexReads].filter((w) => !inRegion(w))).toEqual([]);
    expect(indexReads.size).toBe(scene.gathered.length);
    // The poison records (opaque 0-13, Light2D 26/27) hold 5 slots each: none is gathered.
    expect(firstDifference(bufs.valsA.subarray(0, scene.gathered.length), scene.gathered)).toBeNull();
  });

  it('takes each region base from its firstInstance: the cull layout (region b at b × CAP)', () => {
    const scene = buildScene(3000, 'two', { layout: 'cull' });
    const bufs = gatherScene(scene, shuffledSchedule(3));
    expect(firstDifference(bufs.valsA.subarray(0, scene.gathered.length), scene.gathered)).toBeNull();
  });

  it('writes the frame stamp into word 11, at both ends of its range', () => {
    for (const stamp of [1, 0xFFFFFFFE, 0x12345]) {
      const scene = buildScene(300, 'two');
      const bufs = gatherScene({ ...scene, input: { ...scene.input, stamp } });
      expect(bufs.header[H_STAMP]).toBe(stamp);
    }
  });

  it('rejects a limit above CAP: the pass clamps B', () => {
    const scene = buildScene(10, 'two');
    const bufs = createSortModelBuffers();
    expect(() => cpuGather({ ...scene.input, limit: CAP + 1 }, bufs)).toThrow(RangeError);
  });
});
```

- [ ] **Step 11: Esegui il test: i nuovi devono fallire**

Run: `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-reference.test.ts`
Expected: FAIL, `Tests  8 failed | 24 passed (32)`, con `TypeError: (0 , …cpuGather) is not a function`.

- [ ] **Step 12: Aggiungi il driver e il gather al modello**

Aggiungi in fondo a `transparent-sort-reference.ts`, dopo una riga vuota. `cpuGather` segue il §5.3 passo per passo:
1. Nella fase 1, `lid == 0` legge le parole `(14+k)*5+1` e `(14+k)*5+4` e scrive `regionEnd` (prefisso inclusivo) e `regionBase`.
2. Una sola barriera.
3. Nella fase 2, `raw` e `n = min(raw, limit)`; l'header lo scrive solo `wid == 0 && lid == 0`, parole 0-11 con lo stamp; poi `if (i >= n) return`, la ricerca della regione e la chiave.

Il `start` usa un `if` e non una `select`, che valuterebbe `regionEnd[k - 1]` anche per k = 0. Nel WGSL (Task 14) la stessa riga deve restare un `if`.

```ts
// ── Driver ───────────────────────────────────────────────────────────────────

const IDENTITY_LANES: readonly number[] = Array.from({ length: WORKGROUP_SIZE }, (_, i) => i);
const checkedLaneOrders = new WeakSet<object>();

function assertPermutation(order: readonly number[], count: number, what: string): void {
  if (order.length !== count) throw new Error(`${what}: ${order.length} entries, expected ${count}`);
  const seen = new Uint8Array(count);
  for (const x of order) {
    if (!Number.isInteger(x) || x < 0 || x >= count || seen[x]) {
      throw new Error(`${what}: not a permutation of 0..${count - 1}`);
    }
    seen[x] = 1;
  }
}

/** One workgroup of a dispatch. */
class WorkgroupRun {
  private phaseIndex = 0;

  constructor(
    private readonly wid: number,
    private readonly schedule: Schedule | undefined,
    private readonly shared: SharedMemory,
    private readonly global: GlobalConflictChecker,
  ) {}

  /** The code up to the next `workgroupBarrier()`, for all 256 lanes, in the schedule's order. */
  phase(body: (lid: number) => void): void {
    const order = this.schedule?.laneOrder?.(this.wid, this.phaseIndex) ?? IDENTITY_LANES;
    if (order !== IDENTITY_LANES && !checkedLaneOrders.has(order)) {
      assertPermutation(order, WORKGROUP_SIZE, `laneOrder(${this.wid}, ${this.phaseIndex})`);
      checkedLaneOrders.add(order);
    }
    for (let j = 0; j < WORKGROUP_SIZE; j++) {
      const lid = order[j];
      this.shared.setLane(lid);
      this.global.setInvocation(this.wid, lid);
      body(lid);
    }
    this.phaseIndex++;
    this.shared.barrier();
  }
}

function runDispatch(
  name: string,
  count: number,
  schedule: Schedule | undefined,
  shared: SharedMemory,
  global: GlobalConflictChecker,
  kernel: (wid: number, wg: WorkgroupRun) => void,
): void {
  const order = schedule?.workgroupOrder?.(count, name) ?? Array.from({ length: count }, (_, i) => i);
  assertPermutation(order, count, `workgroupOrder(${count}, '${name}')`);
  for (const wid of order) {
    shared.reset();
    kernel(wid, new WorkgroupRun(wid, schedule, shared, global));
  }
}

// ── Gather ───────────────────────────────────────────────────────────────────

/**
 * `gather_main`: ceil(limit / 256) workgroups. Element i of the output is the
 * i-th slot of the 12 transparent regions laid end to end, keyed (id, zKey).
 */
export function cpuGather(input: SortModelInput, bufs: SortModelBuffers, schedule?: Schedule): void {
  const { limit, stamp } = input; // b0: GatherParams
  if ((limit >>> 0) !== limit || limit > CAP) throw new RangeError(`limit ${limit} outside [0, CAP]: the pass clamps B to CAP`);
  const g = new GlobalConflictChecker('gather');
  const indirectArgs = g.bind('indirect-args', input.indirectArgs, 'read'); // b1
  const visibleIndices = g.bind('visible-indices', input.visibleIndices, 'read'); // b2
  const bounds = g.bind('entity-bounds', input.boundsBits, 'read'); // b3
  const entityIds = g.bind('entity-ids', input.entityIds, 'read'); // b4
  const keysA = g.bind('sort-keys-a', bufs.keysA, 'read_write'); // b5
  const valsA = g.bind('sort-vals-a', bufs.valsA, 'read_write'); // b6
  const header = g.bind('transparent-args', bufs.header, 'read_write'); // b7
  const shared = new SharedMemory([['regionEnd', GATHER_REGIONS, false], ['regionBase', GATHER_REGIONS, false]]);
  const END = shared.base('regionEnd');
  const BASE = shared.base('regionBase');

  runDispatch('gather', Math.ceil(limit / WORKGROUP_SIZE), schedule, shared, g, (wid, wg) => {
    // Lane 0 turns the 12 transparent records into region ends (inclusive
    // prefix of the counts) and bases (their firstInstance).
    wg.phase((lid) => {
      if (lid !== 0) return;
      let end = 0;
      for (let k = 0; k < GATHER_REGIONS; k++) {
        const arg = (FIRST_TRANSPARENT_ARG + k) * ARG_WORDS;
        end = (end + indirectArgs.read(arg + ARG_INSTANCE_COUNT)) >>> 0;
        shared.store(END + k, end);
        shared.store(BASE + k, indirectArgs.read(arg + ARG_FIRST_INSTANCE));
      }
    });
    // workgroupBarrier() — the only one, at top level.
    wg.phase((lid) => {
      const raw = shared.load(END + GATHER_REGIONS - 1);
      const n = Math.min(raw, limit);
      if (wid === 0 && lid === 0) {
        header.write(H_DRAW, 6);
        header.write(H_DRAW + 1, n);
        header.write(H_DRAW + 2, 0);
        header.write(H_DRAW + 3, 0);
        header.write(H_DRAW + 4, 0);
        header.write(H_DISPATCH, Math.floor((n + TILE - 1) / TILE));
        header.write(H_DISPATCH + 1, 1);
        header.write(H_DISPATCH + 2, 1);
        header.write(H_RAW, raw);
        header.write(H_LIMIT, limit);
        header.write(H_OVERFLOW, raw > limit ? 1 : 0);
        header.write(H_STAMP, stamp);
      }
      const i = wid * WORKGROUP_SIZE + lid;
      if (i >= n) return;
      let k = 0;
      for (let q = 0; q < GATHER_REGIONS; q++) {
        if (shared.load(END + q) <= i) k++;
      }
      let start = 0;
      if (k > 0) start = shared.load(END + k - 1);
      const slot = visibleIndices.read((shared.load(BASE + k) + i - start) >>> 0);
      const zKey = sortableZBits(bounds.read(slot * 4 + 2));
      keysA.write(i, entityIds.read(slot));
      keysA.write(CAP + i, zKey);
      valsA.write(i, slot);
    });
  });
}
```

- [ ] **Step 13: Esegui il test: deve passare**

Run: `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-reference.test.ts`
Expected: PASS, `Tests  32 passed (32)`.

- [ ] **Step 14: Aggiungi i test delle passate radix, dell'oracolo e degli invarianti**

Aggiungi in fondo al file di test. I test coprono:
- la matrice dell'oracolo: 11 dimensioni (0, 1, 2, 255, 256, 257, 1023, 1024, 1025, 2047, 4097) × 8 distribuzioni del §7.1, ognuna con uno schedule mescolato;
- 100 000 elementi (= CAP, 98 tile pieni) con z tutte uguali (vince l'ordine degli id; il caso peggiore per le contese sugli atomic) e con z tutte distinte (contano tutte e 7 le passate). L'intera matrice a 100k costerebbe circa 6 s in più senza coprire niente di nuovo: le distribuzioni sono già coperte alle dimensioni minori;
- gli invarianti di §7.1:
  - ogni scatter è un counting sort stabile sulla sua cifra;
  - dopo l'upsweep, i tile contengono gli istogrammi; dopo lo scan, contengono il prefisso esclusivo per colonna;
  - `digitBase` è lo scan esclusivo dell'istogramma;
  - l'ultima passata non tocca le chiavi;
  - i buffer sono identici parola per parola sotto ogni schedule e mescolando le regioni;
  - il comportamento con overflow, compreso il fatto che lì l'invarianza al mescolamento NON vale;
  - l'input vuoto con B = 0 e con B > 0;
  - i due bit di `diag`.

```ts
describe('the radix kernels', () => {
  it('run the barrier structure of the WGSL: upsweep 3 phases, scan 18, scatter 13', () => {
    const scene = buildScene(1500, 'two');
    const bufs = gatherScene(scene);
    expect(countPhases((s) => cpuUpsweep(0, bufs, s))).toEqual([3, 3]);
    // 18 phases = 17 barriers: 1 after the column scan, then 2 per Hillis-Steele step × 8.
    expect(countPhases((s) => cpuScan(0, bufs, s))).toEqual([18]);
    // 13 phases: phase 0, then (a), (b), (c) × 4 rounds.
    expect(countPhases((s) => cpuScatter(0, bufs, s))).toEqual([13, 13]);
  });

  it('reject a pass outside 0..6', () => {
    expect(() => cpuUpsweep(PASSES, createSortModelBuffers())).toThrow(RangeError);
  });
});

describe('runSortModel against the oracle (Array.sort by z, then id)', () => {
  const SIZES = [0, 1, 2, 255, 256, 257, 1023, 1024, 1025, 2047, 4097];
  describe.each(SIZES)('n = %i', (n) => {
    it.each(DISTRIBUTIONS)('%s', (dist) => {
      const scene = buildScene(n, dist);
      expectSorted(scene, runSortModel(scene.input, shuffledSchedule(n * 97 + DISTRIBUTIONS.indexOf(dist))));
    });
  });

  it('with limit exactly n (a CPU count with nothing offscreen)', () => {
    const scene = buildScene(1024, 'equal', { limit: 1024 });
    expectSorted(scene, runSortModel(scene.input, reversedSchedule));
  });

  it('on the cull layout (region b at b × CAP)', () => {
    const scene = buildScene(3000, 'two', { layout: 'cull' });
    expectSorted(scene, runSortModel(scene.input, shuffledSchedule(3)));
  });
});

// Under a second per run here, but a loaded machine can triple it: an explicit
// timeout, like the ring-buffer bench.
describe('runSortModel at CAP: 100 000 elements, 98 full tiles', { timeout: 60_000 }, () => {
  it.each(['equal', 'distinct'] as const)('%s z, shuffled workgroups and lanes', (dist) => {
    const scene = buildScene(CAP, dist);
    expect(scene.input.limit).toBe(CAP);
    expectSorted(scene, runSortModel(scene.input, shuffledSchedule(dist === 'equal' ? 100 : 101)));
  });
});

describe('invariants', () => {
  it.each([[4097, 'two'], [3000, 'extreme-ids']] as const)(
    'n = %i, %s: each scatter is a stable counting sort on its digit, digitBase the exclusive scan of its histogram',
    (n, dist) => {
      const scene = buildScene(n, dist);
      const schedule = shuffledSchedule(n);
      const bufs = gatherScene(scene, schedule);
      const tiles = Math.ceil(n / TILE);
      for (let p = 0; p < PASSES; p++) {
        const { keysIn, valsIn, keysOut, valsOut } = passBuffers(bufs, p);
        const lo = keysIn.slice(0, n);
        const hi = keysIn.slice(CAP, CAP + n);
        const vals = valsIn.slice(0, n);
        const keysOutBefore = keysOut.slice();

        // Upsweep: tile t's histogram of digit p.
        const tileHist = new Uint32Array(tiles * RADIX);
        for (let i = 0; i < n; i++) tileHist[Math.floor(i / TILE) * RADIX + digitOf(lo[i], hi[i], p)]++;
        cpuUpsweep(p, bufs, schedule);
        expect(firstDifference(bufs.hist.subarray(TILES_OFFSET, TILES_OFFSET + tiles * RADIX), tileHist)).toBeNull();

        // Scan: every column becomes its exclusive prefix over the tiles; digitBase the exclusive scan of the totals.
        const columnPrefix = new Uint32Array(tiles * RADIX);
        const totals = new Uint32Array(RADIX);
        for (let t = 0; t < tiles; t++) {
          for (let d = 0; d < RADIX; d++) {
            columnPrefix[t * RADIX + d] = totals[d];
            totals[d] += tileHist[t * RADIX + d];
          }
        }
        const digitBase = new Uint32Array(RADIX);
        for (let d = 1; d < RADIX; d++) digitBase[d] = digitBase[d - 1] + totals[d - 1];
        cpuScan(p, bufs, schedule);
        expect(firstDifference(bufs.hist.subarray(TILES_OFFSET, TILES_OFFSET + tiles * RADIX), columnPrefix)).toBeNull();
        const row = DIGIT_BASE_OFFSET + p * RADIX;
        expect(firstDifference(bufs.hist.subarray(row, row + RADIX), digitBase)).toBeNull();

        // Scatter: the stable counting sort; the last pass leaves the keys alone.
        cpuScatter(p, bufs, schedule);
        const expected = stableCountingSort(lo, hi, vals, p);
        expect(firstDifference(valsOut.subarray(0, n), expected.vals)).toBeNull();
        if (p !== LAST_PASS) {
          expect(firstDifference(keysOut.subarray(0, n), expected.lo)).toBeNull();
          expect(firstDifference(keysOut.subarray(CAP, CAP + n), expected.hi)).toBeNull();
        } else {
          expect(firstDifference(keysOut, keysOutBefore)).toBeNull();
        }
      }
      expect(bufs.hist[0]).toBe(0);
      expect(firstDifference(bufs.valsB.subarray(0, n), floatOracle(scene))).toBeNull();
    },
  );

  it('gives the same buffers, word for word, under every schedule and region shuffle (raw <= limit)', () => {
    const scene = buildScene(5000, 'two', { seed: 77 });
    const reference = runSortModel(scene.input);
    const runs = [
      runSortModel(scene.input, reversedSchedule),
      runSortModel(scene.input, shuffledSchedule(8)),
      runSortModel(shuffleRegions(scene, 9), shuffledSchedule(10)),
    ];
    for (const run of runs) {
      expect(firstDifference(run.header, reference.header)).toBeNull();
      expect(firstDifference(run.valsB, reference.valsB)).toBeNull();
      // The gathered order differs after a region shuffle; the sort erases it from pass 0 on.
      expect(firstDifference(run.keysB, reference.keysB)).toBeNull();
      expect(firstDifference(run.hist.subarray(0, TILES_OFFSET), reference.hist.subarray(0, TILES_OFFSET))).toBeNull();
    }
    expectSorted(scene, reference);
  });

  it('overflow (raw > limit): n = B, flag raised, draw {6, B, 0, 0, 0}, the gathered prefix sorted', () => {
    // Region ends 500, 1500, 3000, …, 3007: a limit of 2000 cuts inside region 2.
    const sizes = [500, 1000, 1500, 0, 0, 0, 0, 0, 0, 0, 0, 7];
    const scene = buildScene(3007, 'distinct', { sizes, limit: 2000 });
    const bufs = runSortModel(scene.input, shuffledSchedule(4));
    expect(Array.from(bufs.header.subarray(0, 12))).toEqual([6, 2000, 0, 0, 0, 2, 1, 1, 3007, 2000, 1, scene.input.stamp]);
    expect(bufs.hist[0]).toBe(0);
    const order = bufs.valsB.slice(0, 2000);
    expect(firstDifference(order, floatOracle(scene, 2000))).toBeNull();

    // The region shuffle invariance does NOT hold here: reversing region 2 moves the cut.
    const input = scene.input;
    const reversed = input.visibleIndices.slice();
    reversed.subarray(scene.bases[2], scene.bases[2] + 1500).reverse();
    const other = runSortModel({ ...input, visibleIndices: reversed }).valsB.slice(0, 2000);
    const set = (a: Uint32Array) => Array.from(a).sort((x, y) => x - y);
    expect(set(other)).not.toEqual(set(order));
  });

  it('empty input, B = 0: nothing runs; draw {6, 0, 0, 0, 0}, the sentinel stays in word 11', () => {
    const scene = buildScene(0, 'two', { limit: 0 });
    const bufs = runSortModel(scene.input);
    expect(Array.from(bufs.header)).toEqual([6, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, STAMP_SENTINEL, 0, 0, 0, 0]);
    for (const b of [bufs.keysA, bufs.keysB, bufs.valsA, bufs.valsB]) expect(b.every((w) => w === STALE_WORD)).toBe(true);
    expect(bufs.hist.subarray(0, DIAG_WORDS).every((w) => w === 0)).toBe(true);
    expect(bufs.hist.subarray(DIAG_WORDS).every((w) => w === STALE_WORD)).toBe(true);
  });

  it('nothing visible, B > 0: the header says n = 0, no key or value is written, digitBase is zero', () => {
    const scene = buildScene(0, 'two', { limit: 300 });
    const bufs = runSortModel(scene.input, shuffledSchedule(6));
    expect(Array.from(bufs.header)).toEqual([6, 0, 0, 0, 0, 0, 1, 1, 0, 300, 0, scene.input.stamp, 0, 0, 0, 0]);
    for (const b of [bufs.keysA, bufs.keysB, bufs.valsA, bufs.valsB]) expect(b.every((w) => w === STALE_WORD)).toBe(true);
    expect(bufs.hist.subarray(DIGIT_BASE_OFFSET, TILES_OFFSET).every((w) => w === 0)).toBe(true);
    expect(bufs.hist[0]).toBe(0);
  });

  it('diag bit 0: a tile table whose total is not n', () => {
    const bufs = createSortModelBuffers();
    cpuPrepare(bufs, 1000);
    bufs.header[H_DRAW + 1] = 1000;
    bufs.header[H_DISPATCH] = 1;
    bufs.hist.fill(0, TILES_OFFSET, TILES_OFFSET + RADIX); // tile 0 counts nothing
    cpuScan(0, bufs);
    expect(bufs.hist[0] & DIAG_SCAN_MISMATCH).toBe(DIAG_SCAN_MISMATCH);
  });

  it('diag bit 1: a destination >= n is flagged and never written', () => {
    const bufs = createSortModelBuffers();
    cpuPrepare(bufs, 10);
    bufs.header[H_DRAW + 1] = 10;
    bufs.header[H_DISPATCH] = 1;
    for (let i = 0; i < 10; i++) {
      bufs.keysA[i] = 0; // every element has digit 0 in pass 0
      bufs.keysA[CAP + i] = 0x80000000;
      bufs.valsA[i] = 100 + i;
    }
    bufs.hist.fill(0, DIGIT_BASE_OFFSET, DIGIT_BASE_OFFSET + RADIX);
    bufs.hist[DIGIT_BASE_OFFSET] = 5; // digit 0 starts at 5: elements 0-4 land at 5-9, 5-9 at 10-14 (>= n)
    bufs.hist.fill(0, TILES_OFFSET, TILES_OFFSET + RADIX);
    cpuScatter(0, bufs);
    expect(bufs.hist[0] & DIAG_SCATTER_OOB).toBe(DIAG_SCATTER_OOB);
    expect(Array.from(bufs.valsB.subarray(5, 10))).toEqual([100, 101, 102, 103, 104]);
    expect(bufs.valsB.subarray(10).every((w) => w === STALE_WORD)).toBe(true);
  });
});
```

- [ ] **Step 15: Esegui il test: i nuovi devono fallire**

Run: `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-reference.test.ts`
Expected: FAIL, `Tests  102 failed | 32 passed (134)`, con `TypeError: (0 , …runSortModel) is not a function` (e lo stesso per `cpuUpsweep`, `cpuScan` e `cpuScatter`).

- [ ] **Step 16: Aggiungi le passate radix e `runSortModel` al modello**

Aggiungi in fondo a `transparent-sort-reference.ts`, dopo una riga vuota. Le tre funzioni seguono il §5.3 alla lettera:
- **upsweep:** la guardia sul tile, `atomicStore` a 0 | barriera | 4 round di `atomicAdd`, leggendo solo la parola della cifra | barriera | lo store nei tile.
- **scan:** lo scan per colonna a blocchi di 8 (`SCAN_CHUNK`) senza barriere; `totals[d] = sum` | barriera | Hillis-Steele in place con DUE fasi per passo (lettura in `v` | barriera | `totals[d] += v` | barriera); `digitBase = incl − sum`; il bit 0 di diag da `d == 255`.
- **scatter:** la fase 0 (precarica, `cursor`, azzeramento delle maschere) | B0 | per ogni round (a) `atomicOr` | B1 | (b) `rank`/`total`/`base`, senza scritture condivise | B2 | (c) la scrittura (le chiavi solo se `pass !== LAST_PASS`, altrimenti il bit 1 di diag), la pulizia della maschera e l'avanzamento del cursore da parte dell'unico lane con `rank == total − 1` | B3.

I `var` privati per lane del WGSL sono array indicizzati da `lid`.

```ts
// ── Radix passes ─────────────────────────────────────────────────────────────

function assertPass(pass: number): void {
  if (!Number.isInteger(pass) || pass < 0 || pass >= PASSES) throw new RangeError(`pass ${pass} outside 0..${PASSES - 1}`);
}

/** The shared layout of upsweep, scan and scatter: A → B on even passes, B → A on odd ones. */
function sortBindings(g: GlobalConflictChecker, pass: number, bufs: SortModelBuffers) {
  const even = pass % 2 === 0;
  return {
    keysIn: g.bind(even ? 'sort-keys-a' : 'sort-keys-b', even ? bufs.keysA : bufs.keysB, 'read'), // b1
    valsIn: g.bind(even ? 'sort-vals-a' : 'transparent-order', even ? bufs.valsA : bufs.valsB, 'read'), // b2
    keysOut: g.bind(even ? 'sort-keys-b' : 'sort-keys-a', even ? bufs.keysB : bufs.keysA, 'read_write'), // b3
    valsOut: g.bind(even ? 'transparent-order' : 'sort-vals-a', even ? bufs.valsB : bufs.valsA, 'read_write'), // b4
    header: g.bind('transparent-args', bufs.header, 'read'), // b5: read-only, so n is uniform
    hist: g.bind('sort-hist', bufs.hist, 'read_write'), // b6
  };
}

/** Only the word the digit comes from: `keysIn[i]` for passes 0-2, `keysIn[CAP + i]` for 3-6. */
function keyDigit(keysIn: GlobalBinding, i: number, pass: number): number {
  return pass < LO_PASSES
    ? (keysIn.read(i) >>> (8 * pass)) & 0xFF
    : (keysIn.read(CAP + i) >>> (8 * (pass - LO_PASSES))) & 0xFF;
}

/** WGSL `countOneBits` on a u32. */
function countOneBits(x: number): number {
  let v = x >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0F0F0F0F;
  return Math.imul(v, 0x01010101) >>> 24;
}

/** `upsweep_main`, pass `pass`: header[5] workgroups; tile t's digit histogram into `tiles[t·256 + d]`. */
export function cpuUpsweep(pass: number, bufs: SortModelBuffers, schedule?: Schedule): void {
  assertPass(pass);
  const g = new GlobalConflictChecker(`upsweep:${pass}`);
  const { keysIn, header, hist } = sortBindings(g, pass, bufs);
  const shared = new SharedMemory([['wgHist', RADIX, true]]);
  const HIST = shared.base('wgHist');

  runDispatch(`upsweep:${pass}`, bufs.header[H_DISPATCH], schedule, shared, g, (t, wg) => {
    const n = header.read(H_DRAW + 1);
    if (t * TILE >= n) return; // uniform: workgroup id and a read-only word
    wg.phase((lid) => {
      shared.atomicStore(HIST + lid, 0);
    });
    wg.phase((lid) => {
      for (let r = 0; r < ROUNDS; r++) {
        const i = t * TILE + r * WORKGROUP_SIZE + lid;
        if (i < n) shared.atomicAdd(HIST + keyDigit(keysIn, i, pass), 1);
      }
    });
    wg.phase((lid) => {
      hist.write(TILES_OFFSET + t * RADIX + lid, shared.atomicLoad(HIST + lid));
    });
  });
}

/**
 * `scan_main`, pass `pass`: one workgroup; lane d owns digit d. Column scan of
 * the tile table in place, then an in-place Hillis-Steele over the 256 totals
 * (two phases per step: read into v, then write), then `digitBase`.
 */
export function cpuScan(pass: number, bufs: SortModelBuffers, schedule?: Schedule): void {
  assertPass(pass);
  const g = new GlobalConflictChecker(`scan:${pass}`);
  const { header, hist } = sortBindings(g, pass, bufs);
  const shared = new SharedMemory([['totals', RADIX, false]]);
  const TOTALS = shared.base('totals');
  const sum = new Uint32Array(WORKGROUP_SIZE); // per-lane `var sum`
  const v = new Uint32Array(WORKGROUP_SIZE); // per-lane `var v`
  const chunk = new Uint32Array(SCAN_CHUNK); // one lane's `var c`: lanes run one at a time here

  runDispatch(`scan:${pass}`, 1, schedule, shared, g, (_wid, wg) => {
    const n = header.read(H_DRAW + 1);
    const tiles = Math.floor((n + TILE - 1) / TILE);
    wg.phase((d) => {
      let s = 0;
      for (let t0 = 0; t0 < tiles; t0 += SCAN_CHUNK) {
        for (let j = 0; j < SCAN_CHUNK; j++) {
          if (t0 + j < tiles) chunk[j] = hist.read(TILES_OFFSET + (t0 + j) * RADIX + d);
        }
        for (let j = 0; j < SCAN_CHUNK; j++) {
          if (t0 + j < tiles) {
            hist.write(TILES_OFFSET + (t0 + j) * RADIX + d, s);
            s = (s + chunk[j]) >>> 0;
          }
        }
      }
      sum[d] = s;
      shared.store(TOTALS + d, s);
    });
    for (let off = 1; off < RADIX; off <<= 1) {
      wg.phase((d) => {
        v[d] = 0;
        if (d >= off) v[d] = shared.load(TOTALS + d - off);
      });
      wg.phase((d) => {
        shared.store(TOTALS + d, (shared.load(TOTALS + d) + v[d]) >>> 0);
      });
    }
    wg.phase((d) => {
      const incl = shared.load(TOTALS + d);
      hist.write(DIGIT_BASE_OFFSET + pass * RADIX + d, (incl - sum[d]) >>> 0);
      if (d === RADIX - 1 && incl !== n) hist.atomicOr(0, DIAG_SCAN_MISMATCH);
    });
  });
}

/**
 * `scatter_main`, pass `pass`: header[5] workgroups. Phase 0 preloads and
 * sets the cursors; each of the 4 rounds marks (a), ranks (b), writes (c).
 * The last pass writes the values only.
 */
export function cpuScatter(pass: number, bufs: SortModelBuffers, schedule?: Schedule): void {
  assertPass(pass);
  const g = new GlobalConflictChecker(`scatter:${pass}`);
  const { keysIn, valsIn, keysOut, valsOut, header, hist } = sortBindings(g, pass, bufs);
  const shared = new SharedMemory([['masks', RADIX * MASK_WORDS, true], ['cursor', RADIX, false]]);
  const MASKS = shared.base('masks');
  const CURSOR = shared.base('cursor');
  // Per-lane `var`s: the preloaded (lo, hi, val) of each round, then the
  // round's digit, rank, total and base.
  const lo = new Uint32Array(WORKGROUP_SIZE * ROUNDS);
  const hi = new Uint32Array(WORKGROUP_SIZE * ROUNDS);
  const val = new Uint32Array(WORKGROUP_SIZE * ROUNDS);
  const digit = new Uint32Array(WORKGROUP_SIZE);
  const rank = new Uint32Array(WORKGROUP_SIZE);
  const total = new Uint32Array(WORKGROUP_SIZE);
  const base = new Uint32Array(WORKGROUP_SIZE);

  runDispatch(`scatter:${pass}`, bufs.header[H_DISPATCH], schedule, shared, g, (t, wg) => {
    const n = header.read(H_DRAW + 1);
    if (t * TILE >= n) return;
    // Phase 0, then B0.
    wg.phase((lid) => {
      for (let r = 0; r < ROUNDS; r++) {
        const i = t * TILE + r * WORKGROUP_SIZE + lid;
        if (i < n) {
          lo[lid * ROUNDS + r] = keysIn.read(i);
          hi[lid * ROUNDS + r] = keysIn.read(CAP + i);
          val[lid * ROUNDS + r] = valsIn.read(i);
        }
      }
      const cursor = hist.read(DIGIT_BASE_OFFSET + pass * RADIX + lid) + hist.read(TILES_OFFSET + t * RADIX + lid);
      shared.store(CURSOR + lid, cursor >>> 0);
      for (let w = 0; w < MASK_WORDS; w++) shared.atomicStore(MASKS + lid * MASK_WORDS + w, 0);
    });
    for (let r = 0; r < ROUNDS; r++) {
      const active = (lid: number) => t * TILE + r * WORKGROUP_SIZE + lid < n;
      // (a) mark, then B1.
      wg.phase((lid) => {
        if (!active(lid)) return;
        const d = digitOf(lo[lid * ROUNDS + r], hi[lid * ROUNDS + r], pass);
        digit[lid] = d;
        shared.atomicOr(MASKS + d * MASK_WORDS + (lid >>> 5), (1 << (lid & 31)) >>> 0);
      });
      // (b) rank, no writes to shared memory, then B2.
      wg.phase((lid) => {
        if (!active(lid)) return;
        const d = digit[lid];
        const word = lid >>> 5;
        let tot = 0;
        let rk = 0;
        for (let w = 0; w < MASK_WORDS; w++) {
          const c = countOneBits(shared.atomicLoad(MASKS + d * MASK_WORDS + w));
          tot += c;
          if (w < word) rk += c;
        }
        rk += countOneBits(shared.atomicLoad(MASKS + d * MASK_WORDS + word) & (((1 << (lid & 31)) >>> 0) - 1));
        rank[lid] = rk;
        total[lid] = tot;
        base[lid] = shared.load(CURSOR + d);
      });
      // (c) write, clear the mark, advance the cursor (one writer per digit), then B3.
      wg.phase((lid) => {
        if (!active(lid)) return;
        const d = digit[lid];
        const dst = base[lid] + rank[lid];
        if (dst < n) {
          valsOut.write(dst, val[lid * ROUNDS + r]);
          if (pass !== LAST_PASS) {
            keysOut.write(dst, lo[lid * ROUNDS + r]);
            keysOut.write(CAP + dst, hi[lid * ROUNDS + r]);
          }
        } else {
          hist.atomicOr(0, DIAG_SCATTER_OOB);
        }
        shared.atomicStore(MASKS + d * MASK_WORDS + (lid >>> 5), 0);
        if (rank[lid] === total[lid] - 1) shared.store(CURSOR + d, base[lid] + total[lid]);
      });
    }
  });
}

/**
 * One frame of `TransparentSortPass`: prepare, then — when B > 0 — the gather
 * and 7 × (upsweep, scan, scatter). `valsB` ends up holding the order. The
 * buffers start as STALE_WORD, like a GPU buffer holding the last frame.
 */
export function runSortModel(input: SortModelInput, schedule?: Schedule): SortModelBuffers {
  const bufs = createSortModelBuffers(STALE_WORD);
  cpuPrepare(bufs, input.limit);
  if (input.limit === 0) return bufs; // B = 0: the pass encodes nothing
  cpuGather(input, bufs, schedule);
  for (let p = 0; p < PASSES; p++) {
    cpuUpsweep(p, bufs, schedule);
    cpuScan(p, bufs, schedule);
    cpuScatter(p, bufs, schedule);
  }
  return bufs;
}
```

- [ ] **Step 17: Esegui il test: deve passare tutto**

Run: `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-reference.test.ts`
Expected: PASS, `Tests  134 passed (134)` in circa 3 s. I due test a 100 000 elementi durano circa 0,7 s ciascuno su questa macchina, e il loro `describe` ha un timeout esplicito di 60 s, come il benchmark del ring buffer.

- [ ] **Step 18: Type-check**

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Expected: nessuna riga che nomini `transparent-sort-constants.ts`, `transparent-sort-reference.ts` o il suo test. Gli import che prima erano "in anticipo" adesso sono tutti usati.

- [ ] **Step 19: Suite TS completa**

Run: `npm --prefix ts test`
Expected: tutto verde, con 1 file e 134 test in più rispetto a prima del task.

- [ ] **Step 20: Commit**

```bash
git add ts/src/render/passes/transparent-sort-constants.ts ts/src/render/passes/transparent-sort-reference.ts ts/src/render/passes/transparent-sort-reference.test.ts
git commit -m "$(cat <<'MSG'
feat(5b): costanti e modello CPU del sort dei trasparenti

Driver a fasi (ordine di workgroup e lane scelto dal chiamante), verificatori
di race sulla memoria di workgroup e sullo storage, gather/upsweep/scan/scatter
come nel §5.3 della spec, oracolo Array.sort: 134 test.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

- [ ] **Step 21: Verifica che i test mordano: tre mutazioni temporanee, mai committate**

Applica una mutazione alla volta a `ts/src/render/passes/transparent-sort-reference.ts`. Dopo ognuna esegui `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-reference.test.ts`, controlla il fallimento atteso, poi ripristina con `git checkout -- ts/src/render/passes/transparent-sort-reference.ts`. I numeri sono quelli misurati sul modello di questo task.

1. **Hillis-Steele a una barriera**, in `cpuScan`. Sostituisci
   ```ts
         wg.phase((d) => {
           v[d] = 0;
           if (d >= off) v[d] = shared.load(TOTALS + d - off);
         });
         wg.phase((d) => {
           shared.store(TOTALS + d, (shared.load(TOTALS + d) + v[d]) >>> 0);
         });
   ```
   con
   ```ts
         wg.phase((d) => {
           if (d >= off) shared.store(TOTALS + d, (shared.load(TOTALS + d) + shared.load(TOTALS + d - off)) >>> 0);
         });
   ```
   Expected: FAIL, `99 failed | 35 passed (134)`, con `workgroup race on totals[1]: lanes 1 and 2 in one phase (read)`. È la race del §5.3, vista dentro il kernel vero.
2. **Il gather legge la parola sbagliata del record**, in `cpuGather`: `indirectArgs.read(arg + ARG_INSTANCE_COUNT)` → `indirectArgs.read(arg)`. Il gather legge allora `indexCount = 6`.
   Expected: FAIL, `103 failed | 31 passed (134)`.
3. **Rank inclusivo nello scatter**, in `cpuScatter`: `& (((1 << (lid & 31)) >>> 0) - 1)` → `& ((((1 << (lid & 31)) >>> 0) * 2 - 1) >>> 0)`.
   Expected: FAIL, `90 failed | 44 passed (134)`.

Dopo l'ultimo ripristino: `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-reference.test.ts` → `134 passed (134)`, e `git status --short` non mostra niente.

### Task 14: kernel WGSL (`transparent-gather.wgsl`, `transparent-sort.wgsl`) + test di accordo del testo

Questo task scrive i due moduli WGSL del sort esattamente come li descrive la §5.3 della spec: binding, tipi, memoria di workgroup, le barriere dello scan e le 13 dello scatter, e la guardia `passIndex != 6` sulla scrittura delle chiavi. Scrive anche il test che confronta il TESTO del WGSL con le costanti TS e con la struttura a fasi del modello CPU del Task 13. In vitest nessun WGSL si compila: i due passi GPU in fondo (naga e Chrome) sono l'unica prova che i moduli compilano. Il `TransparentSortPass` che li esegue arriva nel Task 15, quindi in questo task nessun grafo li usa ancora.

**Files:**
- Create: `ts/src/shaders/transparent-gather.wgsl`
- Create: `ts/src/shaders/transparent-sort.wgsl`
- Test (Create): `ts/src/render/passes/transparent-sort-wgsl.test.ts`
- Test (esistenti, NON modificati, da rieseguire): `ts/src/shaders/uniform-layout.test.ts` e `ts/src/shaders/storage-budget.test.ts`. Tutti e due fanno il glob di `./*.wgsl` al primo livello, quindi prendono da soli i due file nuovi: `GatherParams`/`PassParams` senza padding interno, al più 8 storage per modulo.

**Interfaces:**
- Consumes:
  - dal Task 4 (`ts/src/shaders/wgsl-analysis.ts`): `stripComments(src: string): string`, `functionBody(src: string, name: string): string | null`, `reachableFrom(src: string, entry: string): Set<string>`, `bindingDecls(src: string): Array<{ group: number; binding: number; name: string }>`;
  - dal Task 13 (`ts/src/render/passes/transparent-sort-constants.ts`): `CAP, TILE, ROUNDS, RADIX, PASSES, LAST_PASS, WORKGROUP_SIZE, FIRST_TRANSPARENT_ARG, GATHER_REGIONS, HEADER_WORDS, HEADER_BYTES, H_DRAW, H_DISPATCH, H_RAW, H_LIMIT, H_OVERFLOW, H_STAMP, DIAG_WORDS, DIGIT_BASE_OFFSET, TILES_OFFSET, HIST_WORDS, DIAG_SCAN_MISMATCH, DIAG_SCATTER_OOB, LO_PASSES, MASK_WORDS, SCAN_CHUNK, ARG_WORDS, ARG_INSTANCE_COUNT, ARG_FIRST_INSTANCE`. Il WGSL dichiara queste costanti con lo STESSO nome dell'export TS, e il test le fissa tutte all'export (canonical #8): modello CPU e kernel hanno un'unica fonte per ogni valore;
  - dal Task 13 (`ts/src/render/passes/transparent-sort-reference.ts`): `cpuGather(input, bufs, schedule?)`, `cpuUpsweep(pass, bufs, schedule?)`, `cpuScan(pass, bufs, schedule?)`, `cpuScatter(pass, bufs, schedule?)`, `digitOf(lo, hi, pass)`, i tipi `Schedule`, `SortModelBuffers`, `SortModelInput`;
  - `MAX_GPU_ENTITIES` (Task 11) e `MAX_EXTERNAL_ID` da `ts/src/types.ts`; `BUCKETS_PER_TYPE`, `TOTAL_DRAW_BUCKETS`, `TRANSPARENT_BUCKET_OFFSET` da `ts/src/render/passes/cull-pass.ts`.
- Produces (li consuma il Task 15):
  - `transparent-gather.wgsl`, entry `gather_main`, `@workgroup_size(256)`, gruppo 0:

    | b | dichiarazione |
    |---|---|
    | 0 | `var<uniform> params: GatherParams` (`{limit, stamp, _pad0, _pad1}`, 16 B) |
    | 1 | `var<storage, read> indirectArgs: array<u32>` |
    | 2 | `var<storage, read> visibleIndices: array<u32>` |
    | 3 | `var<storage, read> bounds: array<vec4<u32>>` |
    | 4 | `var<storage, read> entityIds: array<u32>` |
    | 5 | `var<storage, read_write> keysOut: array<u32>` (sort-keys-a, SoA: lo, poi hi da `CAP`) |
    | 6 | `var<storage, read_write> valsOut: array<u32>` (sort-vals-a) |
    | 7 | `var<storage, read_write> header: array<u32, HEADER_WORDS>` (transparent-args) |
  - `transparent-sort.wgsl`, entry `upsweep_main`, `scan_main`, `scatter_main`, `@workgroup_size(256)`, gruppo 0 condiviso:

    | b | dichiarazione |
    |---|---|
    | 0 | `var<uniform> params: PassParams` (`{passIndex, _pad0, _pad1, _pad2}`, 16 B) |
    | 1 | `var<storage, read> keysIn: array<u32>` |
    | 2 | `var<storage, read> valsIn: array<u32>` |
    | 3 | `var<storage, read_write> keysOut: array<u32>` |
    | 4 | `var<storage, read_write> valsOut: array<u32>` |
    | 5 | `var<storage, read> header: array<u32, HEADER_WORDS>` (SOLA lettura: `n` è uniforme) |
    | 6 | `var<storage, read_write> hist: SortHist` (`{diag: array<atomic<u32>, DIAG_WORDS>, digitBase: array<u32, PASSES * RADIX>, tiles: array<u32>}`) |
  - memoria di workgroup per entry: gather 96 B, upsweep 1024 B, scan 1024 B, scatter 9216 B.

- [ ] **Step 1: scrivi il test di accordo del testo (fallisce)**

Crea `ts/src/render/passes/transparent-sort-wgsl.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import gatherSource from '../../shaders/transparent-gather.wgsl?raw';
import sortSource from '../../shaders/transparent-sort.wgsl?raw';
import { bindingDecls, functionBody, reachableFrom, stripComments } from '../../shaders/wgsl-analysis';
import {
  ARG_FIRST_INSTANCE, ARG_INSTANCE_COUNT, ARG_WORDS,
  CAP, DIAG_SCAN_MISMATCH, DIAG_SCATTER_OOB, DIAG_WORDS, DIGIT_BASE_OFFSET, FIRST_TRANSPARENT_ARG,
  GATHER_REGIONS, HEADER_BYTES, HEADER_WORDS, HIST_WORDS, H_DISPATCH, H_DRAW, H_LIMIT, H_OVERFLOW, H_RAW,
  H_STAMP, LAST_PASS, LO_PASSES, MASK_WORDS, PASSES, RADIX, ROUNDS, SCAN_CHUNK, TILE, TILES_OFFSET, WORKGROUP_SIZE,
} from './transparent-sort-constants';
import {
  cpuGather, cpuScan, cpuScatter, cpuUpsweep, digitOf,
  type Schedule, type SortModelBuffers, type SortModelInput,
} from './transparent-sort-reference';
import { BUCKETS_PER_TYPE, TOTAL_DRAW_BUCKETS, TRANSPARENT_BUCKET_OFFSET } from './cull-pass';
import { MAX_EXTERNAL_ID, MAX_GPU_ENTITIES } from '../../types';

// The sort kernels (Phase 5b, design 2026-09-27 §5.3) cannot run headless, and
// the CPU model in transparent-sort-reference.ts is a second codebase that
// mirrors them phase by phase. These tests read the WGSL as TEXT and hold it to
// the shared constants, to the binding tables of §5.3 and to the barrier
// structure the model assumes. Compiling it is Chrome's and naga's job (§7.3.2).

// ── Text helpers ───────────────────────────────────────────────────

/** `const NAME: u32 = EXPR;` of a module, unevaluated. */
function constDefs(src: string): Map<string, string> {
  const defs = new Map<string, string>();
  for (const m of stripComments(src).matchAll(/\bconst\s+(\w+)\s*:\s*u32\s*=\s*([^;]+);/g)) {
    defs.set(m[1], m[2].trim());
  }
  return defs;
}

/** A product of u32 literals and consts of the module: `256u`, `0xFFu`, `RADIX * MASK_WORDS`. */
function evaluate(expr: string, defs: Map<string, string>): number {
  return expr.split('*').reduce((product, factor) => {
    const f = factor.trim();
    const literal = /^(0x[0-9a-fA-F]+|\d+)u?$/.exec(f);
    if (literal) return product * Number(literal[1]);
    const def = defs.get(f);
    if (def === undefined) throw new Error(`'${f}' is neither a u32 literal nor a const of the module`);
    return product * evaluate(def, defs);
  }, 1);
}

function wgslConst(src: string, name: string): number {
  const defs = constDefs(src);
  const def = defs.get(name);
  if (def === undefined) throw new Error(`the module declares no 'const ${name}: u32'`);
  return evaluate(def, defs);
}

/** A function's body, comments stripped. */
function body(src: string, fn: string): string {
  const text = functionBody(src, fn);
  if (text === null) throw new Error(`the module has no fn ${fn}`);
  return stripComments(text);
}

function entryPoints(src: string): Array<{ name: string; size: string }> {
  return [...stripComments(src).matchAll(/@compute\s+@workgroup_size\((\w+)\)\s+fn\s+(\w+)\s*\(/g)]
    .map((m) => ({ size: m[1], name: m[2] }));
}

/** Every `@group @binding var<...> name: TYPE;` as [group, binding, space, name, type], spaces removed. */
function declaredBindings(src: string) {
  return [...stripComments(src).matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var<([^>]+)>\s+(\w+)\s*:\s*([^;]+);/g)]
    .map((m) => [Number(m[1]), Number(m[2]), m[3].replace(/\s+/g, ''), m[4], m[5].replace(/\s+/g, '')] as const);
}

/** A struct's members as [name, type], the type without spaces. */
function structMembers(src: string, name: string): Array<[string, string]> {
  const m = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(stripComments(src));
  if (!m) throw new Error(`the module has no struct ${name}`);
  // Split at top-level commas only: `array<u32, N>` has one inside.
  const fields: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of m[1]) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) { fields.push(cur); cur = ''; } else cur += ch;
  }
  fields.push(cur);
  return fields.map((f) => f.trim()).filter(Boolean).map((f) => {
    const [n, ...type] = f.split(':');
    return [n.trim(), type.join(':').replace(/\s+/g, '')] as [string, string];
  });
}

/** Every `var<workgroup>` with its size in bytes. */
function workgroupVars(src: string): Array<{ name: string; bytes: number }> {
  const code = stripComments(src);
  const defs = constDefs(src);
  const vars = [...code.matchAll(/var<workgroup>\s+(\w+)\s*:\s*array<\s*(?:atomic<u32>|u32)\s*,\s*([^;]+)>\s*;/g)]
    .map((m) => ({ name: m[1], bytes: 4 * evaluate(m[2], defs) }));
  expect(vars.length, 'a var<workgroup> this test cannot size').toBe((code.match(/var<workgroup>/g) ?? []).length);
  return vars;
}

/** Index of the `}` that closes the `{` at `open`. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces');
}

function textBarriers(text: string): number {
  return (text.match(/workgroupBarrier\s*\(\s*\)/g) ?? []).length;
}

/** Trip count of a counted `for` header: `var x = A; x < B; x++` or `x <<= 1u`. */
function tripCount(header: string, defs: Map<string, string>): number {
  const m = /^for\s*\(\s*var\s+(\w+)\s*=\s*([^;]+?)\s*;\s*(\w+)\s*<\s*([^;]+?)\s*;\s*(\w+)\s*(\+\+|<<=\s*1u)\s*\)$/
    .exec(header.trim());
  if (!m || m[1] !== m[3] || m[1] !== m[5]) throw new Error(`a barrier inside a loop this test cannot count: ${header.trim()}`);
  const start = evaluate(m[2], defs);
  const bound = evaluate(m[4], defs);
  const doubling = m[6] !== '++';
  if (doubling && start === 0) throw new Error(`'${header.trim()}' never ends`);
  let trips = 0;
  for (let v = start; v < bound; v = doubling ? v * 2 : v + 1) trips++;
  return trips;
}

/**
 * Barriers a body EXECUTES per workgroup: a barrier in a `for` counts once per
 * trip; one under an `if`/`else` or in a bare block throws. Every barrier of
 * these kernels sits at the top level or in a constant-trip loop: that is what
 * keeps them in uniform control flow.
 */
function executedBarriers(text: string, defs: Map<string, string>): number {
  const token = /\bfor\s*\(|\bif\s*\(|\belse\b|workgroupBarrier\s*\(\s*\)|\{/g;
  let count = 0;
  let at = 0;
  for (;;) {
    token.lastIndex = at;
    const m = token.exec(text);
    if (!m) return count;
    if (m[0].startsWith('workgroupBarrier')) {
      count++;
      at = m.index + m[0].length;
      continue;
    }
    const open = text.indexOf('{', m.index);
    const close = matchBrace(text, open);
    const inner = executedBarriers(text.slice(open + 1, close), defs);
    if (inner > 0) {
      if (!m[0].startsWith('for')) throw new Error(`a barrier under '${m[0]}': not provably uniform`);
      count += inner * tripCount(text.slice(m.index, open), defs);
    }
    at = close + 1;
  }
}

// ── Constants ──────────────────────────────────────────────────────

describe('the kernels declare the constants of transparent-sort-constants.ts', () => {
  const shared: Array<[string, number]> = [
    ['WORKGROUP_SIZE', WORKGROUP_SIZE], ['CAP', CAP], ['TILE', TILE], ['HEADER_WORDS', HEADER_WORDS],
    ['H_INSTANCES', H_DRAW + ARG_INSTANCE_COUNT], // DrawIndexedIndirect.instanceCount: n
  ];
  const gatherOnly: Array<[string, number]> = [
    ['FIRST_TRANSPARENT_ARG', FIRST_TRANSPARENT_ARG], ['GATHER_REGIONS', GATHER_REGIONS],
    ['H_DRAW', H_DRAW], ['H_DISPATCH', H_DISPATCH], ['H_RAW', H_RAW], ['H_LIMIT', H_LIMIT],
    ['H_OVERFLOW', H_OVERFLOW], ['H_STAMP', H_STAMP],
    // DrawIndexedIndirect: indexCount, instanceCount, firstIndex, baseVertex, firstInstance
    ['ARG_WORDS', ARG_WORDS], ['ARG_INSTANCE_COUNT', ARG_INSTANCE_COUNT], ['ARG_FIRST_INSTANCE', ARG_FIRST_INSTANCE],
    ['QUAD_INDEX_COUNT', 6], // the unit quad's index buffer
  ];
  const sortOnly: Array<[string, number]> = [
    ['ROUNDS', ROUNDS], ['RADIX', RADIX], ['PASSES', PASSES], ['LAST_PASS', LAST_PASS],
    ['DIAG_WORDS', DIAG_WORDS], ['DIAG_SCAN_MISMATCH', DIAG_SCAN_MISMATCH], ['DIAG_SCATTER_OOB', DIAG_SCATTER_OOB],
    ['MASK_WORDS', MASK_WORDS], ['LO_PASSES', LO_PASSES], ['SCAN_CHUNK', SCAN_CHUNK],
    ['DIGIT_BITS', Math.log2(RADIX)], ['DIGIT_MASK', RADIX - 1],
  ];

  it('MASK_WORDS is one bit per lane of the workgroup', () => {
    expect(MASK_WORDS).toBe(WORKGROUP_SIZE / 32);
  });

  it.each([...shared, ...gatherOnly])('gather: %s = %i', (name, value) => {
    expect(wgslConst(gatherSource, name)).toBe(value);
  });

  it.each([...shared, ...sortOnly])('sort: %s = %i', (name, value) => {
    expect(wgslConst(sortSource, name)).toBe(value);
  });

  it('CAP is MAX_GPU_ENTITIES in TS and in both modules', () => {
    expect(CAP).toBe(MAX_GPU_ENTITIES);
    expect(wgslConst(gatherSource, 'CAP')).toBe(MAX_GPU_ENTITIES);
    expect(wgslConst(sortSource, 'CAP')).toBe(MAX_GPU_ENTITIES);
  });

  it('LO_PASSES and DIGIT_BITS are where and how the CPU model takes its digits', () => {
    const loPasses = wgslConst(sortSource, 'LO_PASSES');
    const bits = wgslConst(sortSource, 'DIGIT_BITS');
    const fromId = Array.from({ length: PASSES }, (_, p) => digitOf(0xFFFFFFFF, 0, p) === 0xFF);
    expect(fromId.filter(Boolean)).toHaveLength(loPasses);
    for (let p = 0; p < PASSES; p++) {
      const shift = p < loPasses ? p * bits : (p - loPasses) * bits;
      const word = (1 << shift) >>> 0;
      expect(p < loPasses ? digitOf(word, 0, p) : digitOf(0, word, p), `pass ${p}`).toBe(1);
    }
  });

  it('the id passes cover every external id, the z passes the whole 32-bit z key', () => {
    const loPasses = wgslConst(sortSource, 'LO_PASSES');
    const bits = wgslConst(sortSource, 'DIGIT_BITS');
    expect(2 ** (loPasses * bits)).toBeGreaterThan(MAX_EXTERNAL_ID);
    expect((PASSES - loPasses) * bits).toBe(32);
  });

  it('PASSES is odd and the last pass is PASSES - 1, so the result lands in B = transparent-order', () => {
    expect(PASSES % 2).toBe(1);
    expect(LAST_PASS).toBe(PASSES - 1);
  });

  it('one lane per digit, ROUNDS rounds of one workgroup per tile', () => {
    expect(RADIX).toBe(WORKGROUP_SIZE);
    expect(TILE).toBe(ROUNDS * WORKGROUP_SIZE);
  });

  it('the gather reads the transparent buckets of types 0-5 and nothing else', () => {
    expect(FIRST_TRANSPARENT_ARG).toBe(TRANSPARENT_BUCKET_OFFSET);
    expect(GATHER_REGIONS).toBe(6 * BUCKETS_PER_TYPE);
    // 26/27 (Light2D) stay LightAccumStage's.
    expect(FIRST_TRANSPARENT_ARG + GATHER_REGIONS).toBe(TOTAL_DRAW_BUCKETS - BUCKETS_PER_TYPE);
  });

  it('the header array is HEADER_BYTES long', () => {
    expect(HEADER_WORDS * 4).toBe(HEADER_BYTES);
  });
});

// ── Entry points and bindings ──────────────────────────────────────

describe('entry points and bindings (§5.3 tables)', () => {
  it('gather has gather_main, sort has upsweep_main, scan_main, scatter_main, all at 256 lanes', () => {
    expect(entryPoints(gatherSource).map((e) => e.name)).toEqual(['gather_main']);
    expect(entryPoints(sortSource).map((e) => e.name)).toEqual(['upsweep_main', 'scan_main', 'scatter_main']);
    for (const src of [gatherSource, sortSource]) {
      expect(entryPoints(src)).toHaveLength((stripComments(src).match(/@compute/g) ?? []).length);
      for (const e of entryPoints(src)) expect(evaluate(e.size, constDefs(src))).toBe(WORKGROUP_SIZE);
    }
  });

  it('gather: b0 uniform, b1-b4 read-only inputs, b5-b7 its outputs', () => {
    expect(declaredBindings(gatherSource).map((b) => [...b])).toEqual([
      [0, 0, 'uniform', 'params', 'GatherParams'],
      [0, 1, 'storage,read', 'indirectArgs', 'array<u32>'],
      [0, 2, 'storage,read', 'visibleIndices', 'array<u32>'],
      [0, 3, 'storage,read', 'bounds', 'array<vec4<u32>>'],
      [0, 4, 'storage,read', 'entityIds', 'array<u32>'],
      [0, 5, 'storage,read_write', 'keysOut', 'array<u32>'],
      [0, 6, 'storage,read_write', 'valsOut', 'array<u32>'],
      [0, 7, 'storage,read_write', 'header', 'array<u32,HEADER_WORDS>'],
    ]);
  });

  it('sort: one layout for the three kernels, the header READ-ONLY so n is uniform', () => {
    expect(declaredBindings(sortSource).map((b) => [...b])).toEqual([
      [0, 0, 'uniform', 'params', 'PassParams'],
      [0, 1, 'storage,read', 'keysIn', 'array<u32>'],
      [0, 2, 'storage,read', 'valsIn', 'array<u32>'],
      [0, 3, 'storage,read_write', 'keysOut', 'array<u32>'],
      [0, 4, 'storage,read_write', 'valsOut', 'array<u32>'],
      [0, 5, 'storage,read', 'header', 'array<u32,HEADER_WORDS>'],
      [0, 6, 'storage,read_write', 'hist', 'SortHist'],
    ]);
  });

  it.each([['gather', 7, gatherSource], ['sort', 6, sortSource]] as const)(
    '%s: %i storage buffers, within the 8 a stage gets by default',
    (_name, storage, src) => {
      const count = declaredBindings(src).filter(([, , space]) => space.startsWith('storage')).length;
      expect(count).toBe(storage);
      expect(count).toBeLessThanOrEqual(8);
    },
  );

  it.each([['gather', gatherSource], ['sort', sortSource]] as const)(
    '%s: wgsl-analysis sees the same bindings, and an entry point reaches every one (a dead one still counts)',
    (_name, src) => {
      expect(bindingDecls(src).map((b) => [b.group, b.binding, b.name]))
        .toEqual(declaredBindings(src).map(([g, b, , name]) => [g, b, name]));
      const reached = new Set(entryPoints(src).flatMap((e) => [...reachableFrom(src, e.name)]));
      expect(bindingDecls(src).map((b) => b.name).filter((name) => !reached.has(name))).toEqual([]);
    },
  );

  it('each sort kernel reaches only the bindings its stage needs', () => {
    const bindingsOf = (entry: string) => {
      const reach = reachableFrom(sortSource, entry);
      return bindingDecls(sortSource).map((b) => b.name).filter((name) => reach.has(name)).sort();
    };
    expect(bindingsOf('upsweep_main')).toEqual(['header', 'hist', 'keysIn', 'params']);
    expect(bindingsOf('scan_main')).toEqual(['header', 'hist', 'params']);
    expect(bindingsOf('scatter_main')).toEqual(['header', 'hist', 'keysIn', 'keysOut', 'params', 'valsIn', 'valsOut']);
    expect([...reachableFrom(gatherSource, 'gather_main')]).toEqual(
      expect.arrayContaining(bindingDecls(gatherSource).map((b) => b.name)),
    );
  });
});

// ── Struct layouts ─────────────────────────────────────────────────

describe('struct layouts', () => {
  it('GatherParams and PassParams are 4 × u32 with explicit pads (uniform-layout rules)', () => {
    expect(structMembers(gatherSource, 'GatherParams'))
      .toEqual([['limit', 'u32'], ['stamp', 'u32'], ['_pad0', 'u32'], ['_pad1', 'u32']]);
    expect(structMembers(sortSource, 'PassParams'))
      .toEqual([['passIndex', 'u32'], ['_pad0', 'u32'], ['_pad1', 'u32'], ['_pad2', 'u32']]);
  });

  it('SortHist: diag, then digitBase at DIGIT_BASE_OFFSET, then the tiles at TILES_OFFSET', () => {
    const defs = constDefs(sortSource);
    const members = structMembers(sortSource, 'SortHist');
    expect(members.map(([n]) => n)).toEqual(['diag', 'digitBase', 'tiles']);
    const length = (type: string): number => {
      const m = /^array<(?:atomic<u32>|u32),(.+)>$/.exec(type);
      if (!m) throw new Error(`not a sized u32 array: ${type}`);
      return evaluate(m[1], defs);
    };
    expect(members[0][1]).toMatch(/^array<atomic<u32>,/);
    expect(length(members[0][1])).toBe(DIAG_WORDS);
    expect(DIAG_WORDS).toBe(DIGIT_BASE_OFFSET);
    expect(length(members[1][1])).toBe(PASSES * RADIX);
    expect(DIGIT_BASE_OFFSET + length(members[1][1])).toBe(TILES_OFFSET);
    expect(members[2][1]).toBe('array<u32>');
  });
});

// ── Workgroup memory ───────────────────────────────────────────────

describe('workgroup memory per entry point', () => {
  const bytesOf = (src: string, entry: string): number => {
    const reach = reachableFrom(src, entry);
    return workgroupVars(src).filter((v) => reach.has(v.name)).reduce((sum, v) => sum + v.bytes, 0);
  };

  it('gather 96 B, upsweep 1024 B, scan 1024 B, scatter 9216 B — all within 16 KiB', () => {
    expect(bytesOf(gatherSource, 'gather_main')).toBe(96);
    expect(bytesOf(sortSource, 'upsweep_main')).toBe(1024);
    expect(bytesOf(sortSource, 'scan_main')).toBe(1024);
    expect(bytesOf(sortSource, 'scatter_main')).toBe(9216);
    for (const [src, entry] of [[gatherSource, 'gather_main'], [sortSource, 'upsweep_main'],
      [sortSource, 'scan_main'], [sortSource, 'scatter_main']] as const) {
      expect(bytesOf(src, entry)).toBeLessThanOrEqual(16_384);
    }
  });
});

// ── Kernel bodies ──────────────────────────────────────────────────

describe('gather_main (§5.3 gather)', () => {
  const b = body(gatherSource, 'gather_main');

  it('lane 0 reads the 12 regions from the args; no region size is assumed', () => {
    expect(b).toContain('for (var region = 0u; region < GATHER_REGIONS; region++)');
    expect(b).toContain('let arg = (FIRST_TRANSPARENT_ARG + region) * ARG_WORDS;');
    expect(b).toContain('acc += indirectArgs[arg + ARG_INSTANCE_COUNT];');
    expect(b).toContain('regionBase[region] = indirectArgs[arg + ARG_FIRST_INSTANCE];');
    expect(stripComments(gatherSource)).not.toMatch(/100000|100_000/);
  });

  it('one barrier, at the top level, before the lanes past n return', () => {
    expect(textBarriers(b)).toBe(1);
    expect(executedBarriers(b, constDefs(gatherSource))).toBe(1);
    expect(b.indexOf('workgroupBarrier')).toBeLessThan(b.indexOf('return'));
    expect(b).toContain('let raw = regionEnd[GATHER_REGIONS - 1u];');
    expect(b).toContain('let n = min(raw, params.limit);');
    expect(b).toContain('if (i >= n) { return; }');
  });

  it('only lane 0 of workgroup 0 writes the header, words 0-11 including the stamp', () => {
    const at = b.search(/if\s*\(\s*wid\.x\s*==\s*0u\s*&&\s*lid\s*==\s*0u\s*\)\s*\{/);
    expect(at).toBeGreaterThan(-1);
    const open = b.indexOf('{', at);
    const close = matchBrace(b, open);
    const block = b.slice(open + 1, close);
    for (const w of [...b.matchAll(/header\[/g)].map((m) => m.index!)) {
      expect(w).toBeGreaterThan(open);
      expect(w).toBeLessThan(close);
    }
    for (const line of [
      'header[H_DRAW] = QUAD_INDEX_COUNT;',
      'header[H_INSTANCES] = n;',
      'header[H_DRAW + 2u] = 0u;',
      'header[H_DRAW + 3u] = 0u;',
      'header[H_DRAW + 4u] = 0u;',
      'header[H_DISPATCH] = (n + TILE - 1u) / TILE;',
      'header[H_DISPATCH + 1u] = 1u;',
      'header[H_DISPATCH + 2u] = 1u;',
      'header[H_RAW] = raw;',
      'header[H_LIMIT] = params.limit;',
      'header[H_OVERFLOW] = select(0u, 1u, raw > params.limit);',
      'header[H_STAMP] = params.stamp;',
    ]) expect(block).toContain(line);
  });

  it('finds the region of element i without select over an index, then writes lo, hi and the slot', () => {
    expect(b).toContain('if (regionEnd[q] <= i) { k += 1u; }');
    expect(b).toContain('if (k > 0u) { start = regionEnd[k - 1u]; }');
    expect(b).not.toMatch(/select\([^;]*regionEnd\[k - 1u\]/);
    expect(b).toContain('let slot = visibleIndices[regionBase[k] + i - start];');
    expect(b).toContain('keysOut[i] = entityIds[slot];');
    expect(b).toContain('keysOut[CAP + i] = sortableZBits(bounds[slot].z);');
    expect(b).toContain('valsOut[i] = slot;');
  });

  it('never lets a float operation touch the z: it stays bits', () => {
    expect(stripComments(gatherSource)).not.toMatch(/\bf32\b|vec[234]f\b|bitcast/);
    const z = body(gatherSource, 'sortableZBits');
    expect(z).toContain('if (zb == 0x80000000u) { zb = 0u; }');
    expect(z).toContain('return select(zb | 0x80000000u, ~zb, (zb & 0x80000000u) != 0u);');
  });
});

describe('upsweep_main, scan_main, scatter_main (§5.3 sort)', () => {
  const defs = constDefs(sortSource);

  it('digitOf takes the id for passes 0-2, the z key after', () => {
    expect(body(sortSource, 'digitOf')).toContain('select(hi, lo, p < LO_PASSES)');
  });

  it.each(['upsweep_main', 'scatter_main'])('%s: the tile guard depends only on workgroup_id and the read-only header', (entry) => {
    const b = body(sortSource, entry);
    expect(b).toContain('let n = header[H_INSTANCES];');
    expect(b).toContain('let t = wid.x;');
    const guard = b.indexOf('if (t * TILE >= n) { return; }');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(b.indexOf('workgroupBarrier'));
    expect(b.split('return')).toHaveLength(2); // the guard is the only return
  });

  it('upsweep: zero, barrier, count reading only the digit word, barrier, store the tile — 2 barriers', () => {
    const b = body(sortSource, 'upsweep_main');
    expect(textBarriers(b)).toBe(2);
    expect(executedBarriers(b, defs)).toBe(2);
    expect(b).toContain('let wordBase = select(CAP, 0u, p < LO_PASSES);');
    expect(b).toContain('atomicAdd(&wgHist[(keysIn[wordBase + i] >> shift) & DIGIT_MASK], 1u);');
    expect(b).toContain('hist.tiles[t * RADIX + lid] = atomicLoad(&wgHist[lid]);');
  });

  it('scan: 3 barriers in the text, 2 in the Hillis-Steele loop — read into v, barrier, add, barrier — 17 executed', () => {
    const b = body(sortSource, 'scan_main');
    expect(b).not.toContain('return');
    expect(textBarriers(b)).toBe(3);
    const header = /for\s*\(\s*var\s+off\s*=\s*1u\s*;\s*off\s*<\s*RADIX\s*;\s*off\s*<<=\s*1u\s*\)\s*\{/.exec(b);
    expect(header, 'the Hillis-Steele loop').not.toBeNull();
    const open = header!.index + header![0].length - 1;
    const loop = b.slice(open + 1, matchBrace(b, open));
    const parts = loop.split(/workgroupBarrier\s*\(\s*\)\s*;/);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/if\s*\(\s*d\s*>=\s*off\s*\)\s*\{\s*v\s*=\s*totals\[\s*d\s*-\s*off\s*\]\s*;\s*\}/);
    // select() evaluates totals[d - off] for d < off too: an out-of-range read.
    expect(parts[0]).not.toContain('select(');
    expect(parts[1]).toMatch(/totals\[\s*d\s*\]\s*\+=\s*v\s*;/);
    expect(parts[2].trim()).toBe('');
    const before = b.slice(0, header!.index);
    expect(textBarriers(before)).toBe(1);
    expect(before.lastIndexOf('totals[d] = sum;')).toBeLessThan(before.lastIndexOf('workgroupBarrier'));
    // Executed, from the loop bounds read above: 1 + 2 × log2(RADIX).
    expect(executedBarriers(b, defs)).toBe(1 + 2 * Math.log2(RADIX));
    expect(executedBarriers(b, defs)).toBe(17);
    expect(b).toContain('hist.digitBase[p * RADIX + d] = incl - sum;');
    expect(b).toMatch(/if \(d == RADIX - 1u && incl != n\) \{\s*atomicOr\(&hist\.diag\[0\], DIAG_SCAN_MISMATCH\);\s*\}/);
  });

  it('scatter: B0, then per round (a) mark, (b) count and read the cursor — no writes —, (c) write and move the cursor: 13', () => {
    const b = body(sortSource, 'scatter_main');
    expect(textBarriers(b)).toBe(4);
    expect(executedBarriers(b, defs)).toBe(1 + 3 * ROUNDS);
    expect(executedBarriers(b, defs)).toBe(13);
    const loops = [...b.matchAll(/for\s*\(\s*var\s+r\s*=\s*0u\s*;\s*r\s*<\s*ROUNDS\s*;\s*r\+\+\s*\)\s*\{/g)];
    const roundLoops = loops
      .map((m) => ({ at: m.index!, open: m.index! + m[0].length - 1 }))
      .map(({ at, open }) => ({ at, text: b.slice(open + 1, matchBrace(b, open)) }))
      .filter((l) => textBarriers(l.text) > 0);
    expect(roundLoops).toHaveLength(1);
    // Phase 0, before B0: preload, seed the cursors, clear the masks.
    const phase0 = b.slice(0, roundLoops[0].at);
    expect(textBarriers(phase0)).toBe(1);
    expect(phase0).toContain('cursor[lid] = hist.digitBase[p * RADIX + lid] + hist.tiles[t * RADIX + lid];');
    expect(phase0).toContain('atomicStore(&masks[lid * MASK_WORDS + w], 0u);');
    const [a, count, write, rest] = roundLoops[0].text.split(/workgroupBarrier\s*\(\s*\)\s*;/);
    expect(a).toContain('atomicOr(&masks[d * MASK_WORDS + word], bit);');
    expect(a).not.toMatch(/cursor\[|Out\[/);
    expect(count).toContain('rank += countOneBits(atomicLoad(&masks[d * MASK_WORDS + word]) & (bit - 1u));');
    expect(count).toContain('base = cursor[d];');
    expect(count).not.toMatch(/atomicStore|atomicOr|atomicAdd|Out\[|cursor\[[^\]]*\]\s*=[^=]/);
    expect(write).toContain('let dst = base + rank;');
    expect(write).toContain('atomicStore(&masks[d * MASK_WORDS + word], 0u);');
    expect(write).toContain('if (rank == total - 1u) { cursor[d] = base + total; }');
    expect(write).toContain('atomicOr(&hist.diag[0], DIAG_SCATTER_OOB);');
    expect(rest.trim()).toBe('');
  });

  it('scatter: the last pass writes the values only — every key write sits under p != LAST_PASS', () => {
    const b = body(sortSource, 'scatter_main');
    const at = b.search(/if\s*\(\s*p\s*!=\s*LAST_PASS\s*\)\s*\{/);
    expect(at).toBeGreaterThan(-1);
    const open = b.indexOf('{', at);
    const close = matchBrace(b, open);
    const keyWrites = [...b.matchAll(/keysOut\[/g)].map((m) => m.index!);
    expect(keyWrites).toHaveLength(2);
    for (const w of keyWrites) {
      expect(w).toBeGreaterThan(open);
      expect(w).toBeLessThan(close);
    }
    const guarded = b.slice(open + 1, close);
    expect(guarded).toContain('keysOut[dst] = lo[r];');
    expect(guarded).toContain('keysOut[CAP + dst] = hi[r];');
    const vals = b.indexOf('valsOut[dst] = val[r];');
    expect(vals).toBeGreaterThan(-1);
    expect(vals < open || vals > close).toBe(true);
  });

  it('the barrier counter multiplies loops and refuses a barrier under an if', () => {
    const toy = new Map([['N', '4u']]);
    expect(executedBarriers('workgroupBarrier(); for (var i = 0u; i < N; i++) { workgroupBarrier(); }', toy)).toBe(5);
    expect(executedBarriers('for (var s = 1u; s < 256u; s <<= 1u) { workgroupBarrier(); workgroupBarrier(); }', toy)).toBe(16);
    expect(() => executedBarriers('if (x) { workgroupBarrier(); }', toy)).toThrow();
  });
});

// ── The CPU model mirrors the barrier structure ────────────────────

describe('the CPU model has the phases the WGSL barriers make', () => {
  const N = 1100; // two tiles: one full, one partial

  function fixture(): { input: SortModelInput; bufs: SortModelBuffers } {
    const indirectArgs = new Uint32Array(TOTAL_DRAW_BUCKETS * ARG_WORDS);
    // Every element in the gather's first region (bucket 14), from visible-indices[0].
    indirectArgs[FIRST_TRANSPARENT_ARG * ARG_WORDS] = 6;
    indirectArgs[FIRST_TRANSPARENT_ARG * ARG_WORDS + ARG_INSTANCE_COUNT] = N;
    const bounds = new Float32Array(4 * N);
    for (let i = 0; i < N; i++) bounds[4 * i + 2] = (i * 7) % 13;
    const input: SortModelInput = {
      indirectArgs,
      visibleIndices: Uint32Array.from({ length: N }, (_, i) => i),
      boundsBits: new Uint32Array(bounds.buffer),
      entityIds: Uint32Array.from({ length: N }, (_, i) => (i * 37) % (MAX_EXTERNAL_ID + 1)),
      limit: N,
      stamp: 1,
    };
    const bufs: SortModelBuffers = {
      header: new Uint32Array(HEADER_WORDS),
      keysA: new Uint32Array(2 * CAP),
      keysB: new Uint32Array(2 * CAP),
      valsA: new Uint32Array(CAP),
      valsB: new Uint32Array(CAP),
      hist: new Uint32Array(HIST_WORDS),
    };
    return { input, bufs };
  }

  /** Distinct phases the model ran in its busiest workgroup, seen through the lane-order hook. */
  function phases(run: (schedule: Schedule) => void): number {
    const seen = new Map<number, Set<number>>();
    run({
      laneOrder(workgroup: number, phase: number): number[] {
        const set = seen.get(workgroup) ?? new Set<number>();
        set.add(phase);
        seen.set(workgroup, set);
        return Array.from({ length: WORKGROUP_SIZE }, (_, lane) => lane);
      },
    });
    return Math.max(0, ...[...seen.values()].map((s) => s.size));
  }

  const barriers = (src: string, entry: string) => executedBarriers(body(src, entry), constDefs(src));

  it('gather: 2 phases around its 1 barrier', () => {
    const { input, bufs } = fixture();
    const n = phases((s) => cpuGather(input, bufs, s));
    expect(n).toBe(2);
    expect(n - 1).toBe(barriers(gatherSource, 'gather_main'));
  });

  it('upsweep: 3 phases around its 2 barriers', () => {
    const { input, bufs } = fixture();
    cpuGather(input, bufs);
    const n = phases((s) => cpuUpsweep(0, bufs, s));
    expect(n).toBe(3);
    expect(n - 1).toBe(barriers(sortSource, 'upsweep_main'));
  });

  it('scan: 18 phases — the 17 barriers scan_main executes are its phase boundaries', () => {
    const { input, bufs } = fixture();
    cpuGather(input, bufs);
    cpuUpsweep(0, bufs);
    const n = phases((s) => cpuScan(0, bufs, s));
    expect(n - 1).toBe(barriers(sortSource, 'scan_main'));
    expect(n - 1).toBe(17);
  });

  it('scatter: phase 0 then (a), (b), (c) per round — 13 phases for 13 barriers, the last B3 closing round 3', () => {
    const { input, bufs } = fixture();
    cpuGather(input, bufs);
    cpuUpsweep(0, bufs);
    cpuScan(0, bufs);
    const n = phases((s) => cpuScatter(0, bufs, s));
    expect(n).toBe(1 + 3 * ROUNDS);
    expect(barriers(sortSource, 'scatter_main')).toBe(n);
  });
});
```

- [ ] **Step 2: esegui il test, deve fallire**

Run: `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-wgsl.test.ts`

Atteso: FAIL al caricamento del file, con `Failed to resolve import "../../shaders/transparent-gather.wgsl?raw"` (o "Does the file exist?"). I due moduli non esistono ancora.

- [ ] **Step 3: scrivi `transparent-gather.wgsl`**

Crea `ts/src/shaders/transparent-gather.wgsl`. Evita come identificatori le parole riservate di WGSL (`pass`, `active`, `target`, `filter`…): per questo la passata si chiama `p` e il flag di lane `live`.

```wgsl
// Transparent sort, stage 1: the gather (Phase 5b, design
// docs/plans/2026-09-27-transparent-sort-uber-design.md §5.3).
//
// Collects the transparent primitives of types 0-5 that CullPass kept (the
// transparent draw buckets 14..25: 12 regions of visible-indices) into one list
// of n = min(raw, limit) elements. Element i holds
//     keysOut[i]       = lo = the external id of its slot (entity-ids)
//     keysOut[CAP + i] = hi = sortable bits of the slot's world z (entity-bounds.z)
//     valsOut[i]       = the slot
// and lane 0 of workgroup 0 writes the header of transparent-args (§5.2): the
// uber draw's args {6, n, 0, 0, 0}, the sort's dispatch args {ceil(n / TILE),
// 1, 1} at word 5, raw, limit, overflow and the frame stamp. Words 12-15 keep
// what prepare() wrote.
//
// Dispatched with ceil(B / 256) workgroups, B = limit. Buckets 0..13 (opaque)
// and 26/27 (Light2D) are never read. The z is read as vec4<u32>: no floating-
// point operation touches it, so -0, denormals and infinities keep their bits.
//
// Every const below is pinned by render/passes/transparent-sort-wgsl.test.ts
// to the export of transparent-sort-constants.ts with the same name
// (H_INSTANCES to H_DRAW + ARG_INSTANCE_COUNT; QUAD_INDEX_COUNT to the unit
// quad's 6 indices).

const WORKGROUP_SIZE: u32 = 256u;
const CAP: u32 = 100000u;
const TILE: u32 = 1024u;
const FIRST_TRANSPARENT_ARG: u32 = 14u;
const GATHER_REGIONS: u32 = 12u;
const ARG_WORDS: u32 = 5u;          // DrawIndexedIndirect: indexCount, instanceCount, firstIndex, baseVertex, firstInstance
const ARG_INSTANCE_COUNT: u32 = 1u; // DrawIndexedIndirect.instanceCount
const ARG_FIRST_INSTANCE: u32 = 4u; // DrawIndexedIndirect.firstInstance
const QUAD_INDEX_COUNT: u32 = 6u;
const HEADER_WORDS: u32 = 16u;
const H_DRAW: u32 = 0u;
const H_INSTANCES: u32 = 1u;        // H_DRAW + ARG_INSTANCE_COUNT: the draw's instanceCount, i.e. n
const H_DISPATCH: u32 = 5u;
const H_RAW: u32 = 8u;
const H_LIMIT: u32 = 9u;
const H_OVERFLOW: u32 = 10u;
const H_STAMP: u32 = 11u;

struct GatherParams {
    limit: u32,     // B: the gather collects at most this many elements
    stamp: u32,     // FrameState.frameStamp: never 0, never 0xFFFFFFFF
    _pad0: u32,
    _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: GatherParams;
@group(0) @binding(1) var<storage, read> indirectArgs: array<u32>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> bounds: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> entityIds: array<u32>;
@group(0) @binding(5) var<storage, read_write> keysOut: array<u32>;
@group(0) @binding(6) var<storage, read_write> valsOut: array<u32>;
@group(0) @binding(7) var<storage, read_write> header: array<u32, HEADER_WORDS>;

// Inclusive prefix of the 12 region counts, and each region's first index in
// visible-indices (its firstInstance).
var<workgroup> regionEnd: array<u32, GATHER_REGIONS>;
var<workgroup> regionBase: array<u32, GATHER_REGIONS>;

// The z bits as an ascending u32: -0 becomes +0, a negative is flipped whole,
// a positive gets its sign bit set.
fn sortableZBits(bits: u32) -> u32 {
    var zb = bits;
    if (zb == 0x80000000u) { zb = 0u; }
    return select(zb | 0x80000000u, ~zb, (zb & 0x80000000u) != 0u);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn gather_main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
    if (lid == 0u) {
        var acc = 0u;
        for (var region = 0u; region < GATHER_REGIONS; region++) {
            let arg = (FIRST_TRANSPARENT_ARG + region) * ARG_WORDS;
            acc += indirectArgs[arg + ARG_INSTANCE_COUNT];
            regionEnd[region] = acc;
            regionBase[region] = indirectArgs[arg + ARG_FIRST_INSTANCE];
        }
    }
    workgroupBarrier();

    let raw = regionEnd[GATHER_REGIONS - 1u];
    let n = min(raw, params.limit);

    // The one writer of the header: no atomics needed.
    if (wid.x == 0u && lid == 0u) {
        header[H_DRAW] = QUAD_INDEX_COUNT;
        header[H_INSTANCES] = n;
        header[H_DRAW + 2u] = 0u;
        header[H_DRAW + 3u] = 0u;
        header[H_DRAW + 4u] = 0u;
        header[H_DISPATCH] = (n + TILE - 1u) / TILE;
        header[H_DISPATCH + 1u] = 1u;
        header[H_DISPATCH + 2u] = 1u;
        header[H_RAW] = raw;
        header[H_LIMIT] = params.limit;
        header[H_OVERFLOW] = select(0u, 1u, raw > params.limit);
        header[H_STAMP] = params.stamp;
    }

    let i = wid.x * WORKGROUP_SIZE + lid;
    if (i >= n) { return; }

    // Region k holds the output elements [regionEnd[k - 1], regionEnd[k]).
    var k = 0u;
    for (var q = 0u; q < GATHER_REGIONS; q++) {
        if (regionEnd[q] <= i) { k += 1u; }
    }
    var start = 0u;
    if (k > 0u) { start = regionEnd[k - 1u]; }
    let slot = visibleIndices[regionBase[k] + i - start];

    keysOut[i] = entityIds[slot];
    keysOut[CAP + i] = sortableZBits(bounds[slot].z);
    valsOut[i] = slot;
}
```

- [ ] **Step 4: scrivi `transparent-sort.wgsl`**

Crea `ts/src/shaders/transparent-sort.wgsl`:

```wgsl
// Transparent sort, stages 2-4 (Phase 5b, design
// docs/plans/2026-09-27-transparent-sort-uber-design.md §5.3): a stable LSD
// radix sort of the gathered pairs (lo = external id, hi = z key), 7 passes of
// 8 bits. Passes 0-2 read the id, 3-6 the z key, so the result ascends by
// (z key, id): back to front, and at equal z the higher id is drawn later, in
// front. The keys are unique (the ids are), so the output is ONE permutation.
//
// Per pass p, three dispatches share this module's one layout:
//   upsweep_main  indirect (transparent-args at 20 B): one TILE-element tile per
//                 workgroup, its RADIX-bin histogram into hist.tiles[t]
//   scan_main     1 workgroup, lane d owns digit d: the exclusive scan of
//                 column d down the tiles, then an exclusive scan across the
//                 digits into hist.digitBase[p]
//   scatter_main  indirect: each element to digitBase + its tile's column
//                 prefix + the earlier rounds of its tile (cursor) + the earlier
//                 lanes of its round with its digit (popcount of a lane bitmask)
// The destination is a sum of counts: no atomic ordering ever reaches an
// address, so the sort is stable and the same from frame to frame.
//
// Bind group p reads A and writes B for even p, the reverse for odd p. PASSES
// is odd, so the result lands in B = transparent-order. The last pass writes no
// keys, in every build: nothing reads them (a readback recomputes them).
//
// n is header[H_INSTANCES], read through a READ-ONLY binding: a uniform value,
// so the tile guards before the barriers are in uniform control flow.
//
// Every const below is pinned by render/passes/transparent-sort-wgsl.test.ts:
// to the export of transparent-sort-constants.ts with the same name (LO_PASSES,
// MASK_WORDS and SCAN_CHUNK included), H_INSTANCES to H_DRAW +
// ARG_INSTANCE_COUNT, DIGIT_BITS and DIGIT_MASK to RADIX and to the CPU model's
// digitOf.

const WORKGROUP_SIZE: u32 = 256u;
const CAP: u32 = 100000u;
const TILE: u32 = 1024u;
const ROUNDS: u32 = 4u;             // TILE / WORKGROUP_SIZE
const RADIX: u32 = 256u;            // = WORKGROUP_SIZE: lane d owns digit d
const PASSES: u32 = 7u;
const LAST_PASS: u32 = 6u;
const LO_PASSES: u32 = 3u;          // passes 0-2 sort by the id (lo), 3-6 by the z key (hi)
const DIGIT_BITS: u32 = 8u;
const DIGIT_MASK: u32 = 0xFFu;
const MASK_WORDS: u32 = 8u;         // WORKGROUP_SIZE / 32: one bit per lane
const SCAN_CHUNK: u32 = 8u;         // tiles the column scan loads at once
const HEADER_WORDS: u32 = 16u;
const H_INSTANCES: u32 = 1u;        // H_DRAW + ARG_INSTANCE_COUNT: the draw's instanceCount, n
const DIAG_WORDS: u32 = 16u;
const DIAG_SCAN_MISMATCH: u32 = 1u;
const DIAG_SCATTER_OOB: u32 = 2u;

struct PassParams {
    passIndex: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

struct SortHist {
    diag: array<atomic<u32>, DIAG_WORDS>,
    digitBase: array<u32, PASSES * RADIX>,  // row p: the exclusive digit scan of pass p
    tiles: array<u32>,                      // tile t, digit d at t * RADIX + d
}

@group(0) @binding(0) var<uniform> params: PassParams;
@group(0) @binding(1) var<storage, read> keysIn: array<u32>;
@group(0) @binding(2) var<storage, read> valsIn: array<u32>;
@group(0) @binding(3) var<storage, read_write> keysOut: array<u32>;
@group(0) @binding(4) var<storage, read_write> valsOut: array<u32>;
@group(0) @binding(5) var<storage, read> header: array<u32, HEADER_WORDS>;
@group(0) @binding(6) var<storage, read_write> hist: SortHist;

var<workgroup> wgHist: array<atomic<u32>, RADIX>;                // upsweep
var<workgroup> totals: array<u32, RADIX>;                        // scan
var<workgroup> masks: array<atomic<u32>, RADIX * MASK_WORDS>;    // scatter: digit d, lane word w
var<workgroup> cursor: array<u32, RADIX>;                        // scatter

// The shift of pass p's digit inside the key word it reads.
fn digitShift(p: u32) -> u32 {
    if (p < LO_PASSES) { return p * DIGIT_BITS; }
    return (p - LO_PASSES) * DIGIT_BITS;
}

// Pass p's digit of the key (lo, hi).
fn digitOf(lo: u32, hi: u32, p: u32) -> u32 {
    return (select(hi, lo, p < LO_PASSES) >> digitShift(p)) & DIGIT_MASK;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn upsweep_main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
    let n = header[H_INSTANCES];
    let t = wid.x;
    if (t * TILE >= n) { return; }
    let p = params.passIndex;
    // Only the word of the digit is read: lo at [0, CAP), hi at [CAP, 2 CAP).
    let wordBase = select(CAP, 0u, p < LO_PASSES);
    let shift = digitShift(p);

    atomicStore(&wgHist[lid], 0u);
    workgroupBarrier();
    for (var r = 0u; r < ROUNDS; r++) {
        let i = t * TILE + r * WORKGROUP_SIZE + lid;
        if (i < n) {
            atomicAdd(&wgHist[(keysIn[wordBase + i] >> shift) & DIGIT_MASK], 1u);
        }
    }
    workgroupBarrier();
    hist.tiles[t * RADIX + lid] = atomicLoad(&wgHist[lid]);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn scan_main(@builtin(local_invocation_index) lid: u32) {
    let n = header[H_INSTANCES];
    let p = params.passIndex;
    let d = lid;
    let numTiles = (n + TILE - 1u) / TILE;

    // 1. Down column d, no barriers: each tile's count of d becomes the count
    //    of d in the tiles before it. SCAN_CHUNK loads in flight at a time.
    var sum = 0u;
    let batches = numTiles / SCAN_CHUNK;
    for (var b = 0u; b < batches; b++) {
        let t0 = b * SCAN_CHUNK;
        var c: array<u32, SCAN_CHUNK>;
        for (var j = 0u; j < SCAN_CHUNK; j++) { c[j] = hist.tiles[(t0 + j) * RADIX + d]; }
        for (var j = 0u; j < SCAN_CHUNK; j++) {
            hist.tiles[(t0 + j) * RADIX + d] = sum;
            sum += c[j];
        }
    }
    for (var t = batches * SCAN_CHUNK; t < numTiles; t++) {
        let c = hist.tiles[t * RADIX + d];
        hist.tiles[t * RADIX + d] = sum;
        sum += c;
    }

    // 2. Across the digits: inclusive Hillis-Steele IN PLACE (the 1024 B
    //    budget leaves no second array), two barriers per step. The one-barrier
    //    form `totals[d] += totals[d - off]` is a race.
    totals[d] = sum;
    workgroupBarrier();
    for (var off = 1u; off < RADIX; off <<= 1u) {
        var v = 0u;
        if (d >= off) { v = totals[d - off]; }
        workgroupBarrier();
        totals[d] += v;
        workgroupBarrier();
    }

    let incl = totals[d];
    hist.digitBase[p * RADIX + d] = incl - sum;
    if (d == RADIX - 1u && incl != n) {
        atomicOr(&hist.diag[0], DIAG_SCAN_MISMATCH);
    }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn scatter_main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
    let n = header[H_INSTANCES];
    let t = wid.x;
    if (t * TILE >= n) { return; }
    let p = params.passIndex;

    // Phase 0: preload this lane's ROUNDS elements, seed the cursors, clear
    // the masks (lane l clears the words of digit l).
    var lo: array<u32, ROUNDS>;
    var hi: array<u32, ROUNDS>;
    var val: array<u32, ROUNDS>;
    for (var r = 0u; r < ROUNDS; r++) {
        let i = t * TILE + r * WORKGROUP_SIZE + lid;
        if (i < n) {
            lo[r] = keysIn[i];
            hi[r] = keysIn[CAP + i];
            val[r] = valsIn[i];
        }
    }
    cursor[lid] = hist.digitBase[p * RADIX + lid] + hist.tiles[t * RADIX + lid];
    for (var w = 0u; w < MASK_WORDS; w++) {
        atomicStore(&masks[lid * MASK_WORDS + w], 0u);
    }
    workgroupBarrier();                                      // B0

    let word = lid / 32u;
    let bit = 1u << (lid % 32u);
    // A constant trip count: lanes past n do nothing but cross every barrier.
    for (var r = 0u; r < ROUNDS; r++) {
        let i = t * TILE + r * WORKGROUP_SIZE + lid;
        let live = i < n;
        var d = 0u;
        // (a) mark this lane under its digit
        if (live) {
            d = digitOf(lo[r], hi[r], p);
            atomicOr(&masks[d * MASK_WORDS + word], bit);
        }
        workgroupBarrier();                                  // B1
        // (b) count the digit's lanes and those before this one; read the cursor. No writes.
        var total = 0u;
        var rank = 0u;
        var base = 0u;
        if (live) {
            for (var w = 0u; w < MASK_WORDS; w++) {
                let m = countOneBits(atomicLoad(&masks[d * MASK_WORDS + w]));
                total += m;
                if (w < word) { rank += m; }
            }
            rank += countOneBits(atomicLoad(&masks[d * MASK_WORDS + word]) & (bit - 1u));
            base = cursor[d];
        }
        workgroupBarrier();                                  // B2
        // (c) write, clear this lane's mask word, move the cursor (one writer per digit)
        if (live) {
            let dst = base + rank;
            if (dst < n) {
                valsOut[dst] = val[r];
                if (p != LAST_PASS) {
                    keysOut[dst] = lo[r];
                    keysOut[CAP + dst] = hi[r];
                }
            } else {
                atomicOr(&hist.diag[0], DIAG_SCATTER_OOB);
            }
            atomicStore(&masks[d * MASK_WORDS + word], 0u);
            if (rank == total - 1u) { cursor[d] = base + total; }
        }
        workgroupBarrier();                                  // B3
    }
}
```

- [ ] **Step 5: esegui i test, devono passare**

Run: `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-wgsl.test.ts`
Atteso: PASS, tutti i `describe`.

Run: `npx --prefix ts vitest run --root ts src/shaders/uniform-layout.test.ts src/shaders/storage-budget.test.ts`
Atteso: PASS. Tra i casi compaiono `./transparent-gather.wgsl GatherParams`, `./transparent-sort.wgsl PassParams` e i due file nel conteggio degli storage (7 e 6, entrambi ≤ 8).

Se fallisce solo il describe "the CPU model has the phases…", il problema è nel modello del Task 13, non qui. Per ogni workgroup il modello deve chiamare `schedule.laneOrder(workgroup, phase)` una volta per fase, e il numero di fasi deve essere: gather 2, upsweep 3, scan 18, scatter 13 (fase 0 più (a), (b), (c) per round, senza una fase vuota dopo l'ultima B3). Correggi il modello; il WGSL non si tocca.

- [ ] **Step 6: validazione con naga (il front-end di Firefox)**

`naga-cli` è stato installato al Task 8. Se `naga --version` fallisce, installalo con `cargo install naga-cli`.

Run (dalla radice del repo):
```bash
naga ts/src/shaders/transparent-gather.wgsl && naga ts/src/shaders/transparent-sort.wgsl && echo NAGA-OK
```
Atteso: nessun errore di parsing né di validazione (in particolare nessun errore di uniformità sulle barriere), e alla fine `NAGA-OK`.

- [ ] **Step 7: validazione su Chrome (iGPU AMD)**

È l'anticipo del controllo bloccante del Task 18 (§7.3.2). Un errore trovato qui costa meno che trovarlo con il grafo vivo.
1. Se `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/` non stampa `200`, avvia il dev server in background: `npm --prefix ts run dev -- --strictPort --port 5173`. Poi `mcp__chrome-devtools-gpu__list_pages` → `pageId` (o `new_page` con `about:blank`); `pageId` su ogni chiamata MCP che segue e `waitForStableDom: false` su ogni `evaluate_script`.
2. `mcp__chrome-devtools-gpu__navigate_page` con `pageId`, `type: "url"`, `url: "http://localhost:5173/?bench"`, `ignoreCache: true` e questo `initScript`:
   ```js
   GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)
   ```
3. `mcp__chrome-devtools-gpu__evaluate_script` con `pageId`, `waitForStableDom: false` e:
   ```js
   async () => {
     const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
     const device = await adapter.requestDevice();
     const out = { adapter: `${adapter.info.vendor} ${adapter.info.architecture}` };
     for (const [file, entries] of [
       ['transparent-gather', ['gather_main']],
       ['transparent-sort', ['upsweep_main', 'scan_main', 'scatter_main']],
     ]) {
       const code = (await import(`/src/shaders/${file}.wgsl?raw`)).default;
       const module = device.createShaderModule({ code });
       const info = await module.getCompilationInfo();
       out[file] = { messages: info.messages.map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`), pipelines: {} };
       for (const entryPoint of entries) {
         device.pushErrorScope('validation');
         device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
         const err = await device.popErrorScope();
         out[file].pipelines[entryPoint] = err ? err.message : 'ok';
       }
     }
     device.destroy();
     return out;
   }
   ```
   Criterio: `adapter` dice AMD; `messages` è vuoto per tutti e due i file (nessun `error`; un `warning` va letto e riportato); ogni voce di `pipelines` vale `'ok'`.

- [ ] **Step 8: commit**

```bash
git add ts/src/shaders/transparent-gather.wgsl ts/src/shaders/transparent-sort.wgsl ts/src/render/passes/transparent-sort-wgsl.test.ts
git commit -m "feat(5b): kernel WGSL di gather e sort, con i test di accordo del testo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: `TransparentSortPass` + integrazione nel grafo + rimozione di `RadixSortPass` + slot HMR

Il task ha due metà, con un commit ciascuna. Nella prima nasce il pass, provato su un device finto (§7.2). Nella seconda il pass entra nei sei grafi, al posto di `RadixSortPass` che viene eliminato. `ForwardPass` legge le sue due uscite, e il renderer crea i due buffer del pool e gli slot HMR dei due kernel. Da qui il sort gira in ogni frame con trasparenti, ma il draw non cambia (il Task 19 lo cambia). Il probe di readback (`TransparentSortProbe`) arriva nel Task 16: qui il factory costruisce `new TransparentSortPass()` senza probe.

Le righe citate per `renderer.ts` sono quelle di HEAD `72c0f7e`. I Task 5-11 le hanno spostate, quindi ogni modifica si trova CERCANDO il testo mostrato nel "prima".

**Files:**
- Create: `ts/src/render/passes/transparent-sort-pass.ts`
- Test (Create): `ts/src/render/passes/transparent-sort-pass.test.ts`
- Modify: `ts/src/render/passes/forward-pass.ts`, la riga `readonly reads = [...]` (L40 a HEAD)
- Test (Modify): `ts/src/render/passes/forward-pass.test.ts`, un `describe` in coda
- Modify: `ts/src/render/graph-assembly.ts` L23-27, il commento di `GraphPassFactories.scene`
- Test (Modify): `ts/src/render/graph-assembly.test.ts`, gli import dopo L11 e un `describe` in coda
- Modify: `ts/src/renderer.ts` in sei siti, tutti con l'ancora testuale:
  - import dello shader (L17);
  - import della classe (L33);
  - passo 3 (buffer del pool, prima di `// Selection mask buffer`);
  - passo 6c (L327-328);
  - factory `scene` (L466);
  - slot `'radix-sort'` (L577-582);
  - accept (L1020-1022).
- Delete: `ts/src/render/passes/radix-sort-pass.ts`, `ts/src/render/passes/radix-sort-pass.test.ts`, `ts/src/shaders/radix-sort.wgsl`

**Interfaces:**
- Consumes:
  - `FrameState.transparentCount: number`, già normalizzato, e `FrameState.frameStamp: number` (Task 10/11);
  - il buffer del pool `'entity-ids'` (Task 11);
  - le costanti del Task 13: `CAP, DIAG_WORDS, DISPATCH_OFFSET_BYTES, HEADER_BYTES, HEADER_WORDS, HIST_WORDS, H_DISPATCH, H_DRAW, H_LIMIT, H_STAMP, PASSES, PASS_PARAMS_STRIDE, STAMP_SENTINEL, TILES_OFFSET, WORKGROUP_SIZE`;
  - i moduli WGSL e le tabelle dei binding del Task 14;
  - `TOTAL_DRAW_BUCKETS` da `cull-pass.ts`.
- Produces:
  ```ts
  // ts/src/render/passes/transparent-sort-pass.ts
  export interface SortReadbackTarget { stamp: number; gatherKeys: GPUBuffer; gatherVals: GPUBuffer; header: GPUBuffer; hist: GPUBuffer; order: GPUBuffer }
  export interface SortReadbackTaker { take(stamp: number): SortReadbackTarget | null }
  export const SORT_READBACK_BYTES: { readonly gatherKeys: 800000; readonly gatherVals: 400000; readonly header: 64; readonly hist: 7232; readonly order: 400000 }; // derived from CAP/HEADER_BYTES/TILES_OFFSET
  export class TransparentSortPass implements RenderPass {
    static GATHER_SOURCE: string;   // ''
    static SORT_SOURCE: string;     // ''
    constructor(probe?: SortReadbackTaker | null);  // default null
    readonly name: 'transparent-sort';
    readonly reads: ['indirect-args', 'visible-indices', 'entity-bounds', 'entity-ids'];
    readonly writes: ['transparent-order', 'transparent-args'];
    readonly optional: true;
    setup(device: GPUDevice, resources: ResourcePool): void;
    prepare(device: GPUDevice, frame: FrameState): void;
    execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool, mark?: (encoder: GPUCommandEncoder) => void): void;
    profileStages(frame: FrameState): readonly string[];   // [] or the 22 stage names
    resize(width: number, height: number): void;
    destroy(): void;
  }
  ```
  - pool (renderer): `'transparent-order'` (`CAP × 4` B, `STORAGE` + `COPY_SRC` in dev) e `'transparent-args'` (64 B, `STORAGE | INDIRECT | COPY_DST` + `COPY_SRC` in dev);
  - `ForwardPass.reads` contiene `'transparent-order'` e `'transparent-args'` (lit e unlit);
  - slot HMR `'transparent-gather'` e `'transparent-sort'`, probe `new TransparentSortPass()`, `usedBy: inEveryMode`, ognuno con il suo blocco `accept`.

- [ ] **Step 1: scrivi i test del pass su device finto (falliscono)**

Crea `ts/src/render/passes/transparent-sort-pass.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  TransparentSortPass, SORT_READBACK_BYTES, type SortReadbackTaker, type SortReadbackTarget,
} from './transparent-sort-pass';
import { ResourcePool } from '../resource-pool';
import type { FrameState } from '../render-pass';
import { TOTAL_DRAW_BUCKETS } from './cull-pass';
import {
  CAP, DIAG_WORDS, DISPATCH_OFFSET_BYTES, HEADER_BYTES, HIST_WORDS, PASSES, PASS_PARAMS_STRIDE,
  STAMP_SENTINEL, TILES_OFFSET,
} from './transparent-sort-constants';
import gatherSource from '../../shaders/transparent-gather.wgsl?raw';
import sortSource from '../../shaders/transparent-sort.wgsl?raw';

// TransparentSortPass (Phase 5b, design 2026-09-27 §5) on a recording device.
// WebGPU cannot run headless; what these tests hold is the contract the GPU
// does not report back cleanly: uniforms written only where writeBuffer is safe
// (never in execute), one PassParams slice per pass, the A/B direction, the
// dispatch sizes, the profiler's stage list, minBindingSize everywhere, and a
// setup() that never writes the pool it reads.

const USAGE = {
  MAP_READ: 0x1, MAP_WRITE: 0x2, COPY_SRC: 0x4, COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20,
  UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100, QUERY_RESOLVE: 0x200,
};
const STAGE = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

type Buf = { label: string; size: number; usage: number; destroyed: boolean; destroy(): void };
type Layout = { desc: GPUBindGroupLayoutDescriptor };
type Group = { desc: GPUBindGroupDescriptor };
type Pipeline = { desc: GPUComputePipelineDescriptor };
type Write = { buffer: Buf; offset: number; words: number[] };
type Copy = { kind: 'copy'; src: Buf; srcOffset: number; dst: Buf; dstOffset: number; size: number };
type Cmd =
  | { kind: 'pass' }
  | { kind: 'end' }
  | { kind: 'mark' }
  | { kind: 'pipeline'; entry: string }
  | { kind: 'group'; index: number; group: Group }
  | { kind: 'dispatch'; x: number }
  | { kind: 'indirect'; buffer: Buf; offset: number }
  | Copy;

function fakeBuffer(label: string, size: number, usage = 0): Buf {
  const b: Buf = { label, size, usage, destroyed: false, destroy() { b.destroyed = true; } };
  return b;
}

/** A device that records what the pass creates and writes. */
function makeDevice() {
  Object.assign(globalThis, { GPUBufferUsage: USAGE, GPUShaderStage: STAGE });
  const buffers: Buf[] = [];
  const layouts: Layout[] = [];
  const groups: Group[] = [];
  const pipelines: Pipeline[] = [];
  const writes: Write[] = [];
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => {
      const b = fakeBuffer(d.label ?? '', d.size, d.usage);
      buffers.push(b);
      return b;
    },
    createShaderModule: (d: GPUShaderModuleDescriptor) => ({ code: d.code }),
    createBindGroupLayout: (desc: GPUBindGroupLayoutDescriptor) => { const l = { desc }; layouts.push(l); return l; },
    createPipelineLayout: (desc: GPUPipelineLayoutDescriptor) => ({ desc }),
    createComputePipeline: (desc: GPUComputePipelineDescriptor) => { const p = { desc }; pipelines.push(p); return p; },
    createBindGroup: (desc: GPUBindGroupDescriptor) => { const g = { desc }; groups.push(g); return g; },
    queue: {
      // Copied at call time, like the real queue: the pass reuses its arrays.
      writeBuffer: (buffer: Buf, offset: number, data: Uint32Array) => {
        writes.push({ buffer, offset, words: Array.from(data) });
      },
    },
  } as unknown as GPUDevice;
  const byLabel = (label: string): Buf => {
    const b = buffers.find((x) => x.label === label);
    if (!b) throw new Error(`the pass created no buffer '${label}'`);
    return b;
  };
  return { device, buffers, layouts, groups, pipelines, writes, byLabel };
}

/** The pool buffers the pass reads, sized as createRenderer allocates them. */
const POOL_SIZES: Record<string, number> = {
  'indirect-args': TOTAL_DRAW_BUCKETS * 5 * 4,
  'visible-indices': TOTAL_DRAW_BUCKETS * CAP * 4,
  'entity-bounds': CAP * 16,
  'entity-ids': CAP * 4,
  'transparent-args': HEADER_BYTES,
  'transparent-order': CAP * 4,
};

function makePool(omit?: string) {
  const pool = new ResourcePool();
  const named: Record<string, Buf> = {};
  for (const [name, size] of Object.entries(POOL_SIZES)) {
    if (name === omit) continue;
    named[name] = fakeBuffer(name, size);
    pool.setBuffer(name, named[name] as unknown as GPUBuffer);
  }
  return { pool, named };
}

function setUp(probe: SortReadbackTaker | null = null) {
  const gpu = makeDevice();
  const { pool, named } = makePool();
  const pass = new TransparentSortPass(probe);
  pass.setup(gpu.device, pool);
  return { ...gpu, pool, named, pass };
}

const frameOf = (transparentCount: number, frameStamp = 7) =>
  ({ transparentCount, frameStamp, entityCount: transparentCount }) as unknown as FrameState;

/** An encoder that records passes, dispatches, copies and profiler marks in order. */
function record() {
  const cmds: Cmd[] = [];
  const encoder = {
    beginComputePass: () => {
      cmds.push({ kind: 'pass' });
      return {
        setPipeline: (p: Pipeline) => { cmds.push({ kind: 'pipeline', entry: p.desc.compute.entryPoint! }); },
        setBindGroup: (index: number, group: Group) => { cmds.push({ kind: 'group', index, group }); },
        dispatchWorkgroups: (x: number) => { cmds.push({ kind: 'dispatch', x }); },
        dispatchWorkgroupsIndirect: (buffer: Buf, offset: number) => { cmds.push({ kind: 'indirect', buffer, offset }); },
        end: () => { cmds.push({ kind: 'end' }); },
      };
    },
    copyBufferToBuffer: (src: Buf, srcOffset: number, dst: Buf, dstOffset: number, size: number) => {
      cmds.push({ kind: 'copy', src, srcOffset, dst, dstOffset, size });
    },
  } as unknown as GPUCommandEncoder;
  const mark = (_encoder: GPUCommandEncoder) => { cmds.push({ kind: 'mark' }); };
  return { encoder, cmds, mark };
}

/** One entry per dispatch: its pipeline's entry point, its bind group, its size or indirect source. */
function dispatches(cmds: Cmd[]) {
  const out: Array<{ entry: string; group: Group; x?: number; indirect?: { buffer: Buf; offset: number } }> = [];
  let entry = '';
  let group: Group | null = null;
  for (const c of cmds) {
    if (c.kind === 'pipeline') entry = c.entry;
    else if (c.kind === 'group') group = c.group;
    else if (c.kind === 'dispatch') out.push({ entry, group: group!, x: c.x });
    else if (c.kind === 'indirect') out.push({ entry, group: group!, indirect: { buffer: c.buffer, offset: c.offset } });
  }
  return out;
}

function fakeTarget(stamp: number): SortReadbackTarget {
  const staging = (label: string, size: number) =>
    fakeBuffer(label, size, USAGE.MAP_READ | USAGE.COPY_DST) as unknown as GPUBuffer;
  return {
    stamp,
    gatherKeys: staging('rb-gather-keys', SORT_READBACK_BYTES.gatherKeys),
    gatherVals: staging('rb-gather-vals', SORT_READBACK_BYTES.gatherVals),
    header: staging('rb-header', SORT_READBACK_BYTES.header),
    hist: staging('rb-hist', SORT_READBACK_BYTES.hist),
    order: staging('rb-order', SORT_READBACK_BYTES.order),
  };
}

function bufferBinding(g: Group, binding: number): GPUBufferBinding {
  const e = [...g.desc.entries].find((x) => x.binding === binding);
  if (!e) throw new Error(`${g.desc.label}: no binding ${binding}`);
  return e.resource as GPUBufferBinding;
}
const bufferOf = (g: Group, binding: number) => bufferBinding(g, binding).buffer as unknown as Buf;

const STAGES = ['gather', ...Array.from({ length: PASSES }, () => ['upsweep', 'scan', 'scatter']).flat()];
const ENTRY: Record<string, string> = {
  gather: 'gather_main', upsweep: 'upsweep_main', scan: 'scan_main', scatter: 'scatter_main',
};

beforeAll(() => {
  TransparentSortPass.GATHER_SOURCE = gatherSource;
  TransparentSortPass.SORT_SOURCE = sortSource;
});
afterAll(() => {
  TransparentSortPass.GATHER_SOURCE = '';
  TransparentSortPass.SORT_SOURCE = '';
});

describe('TransparentSortPass as a graph node', () => {
  it('reads the cull outputs, the bounds and the id column; writes the two pool buffers; optional', () => {
    const pass = new TransparentSortPass();
    expect(pass.name).toBe('transparent-sort');
    expect(pass.reads).toEqual(['indirect-args', 'visible-indices', 'entity-bounds', 'entity-ids']);
    expect(pass.writes).toEqual(['transparent-order', 'transparent-args']);
    expect(pass.optional).toBe(true);
  });

  it('a pass never set up writes nothing, encodes nothing and names no stage', () => {
    const { device, writes } = makeDevice();
    const pass = new TransparentSortPass();
    const { encoder, cmds, mark } = record();
    pass.prepare(device, frameOf(10));
    pass.execute(encoder, frameOf(10), new ResourcePool(), mark);
    expect(writes).toEqual([]);
    expect(cmds).toEqual([]);
    expect(pass.profileStages(frameOf(10))).toEqual([]);
  });
});

describe('TransparentSortPass.setup', () => {
  it('throws without its shader sources', () => {
    const saved = TransparentSortPass.SORT_SOURCE;
    TransparentSortPass.SORT_SOURCE = '';
    try {
      expect(() => setUp()).toThrow(/SORT_SOURCE/);
    } finally {
      TransparentSortPass.SORT_SOURCE = saved;
    }
  });

  it.each(Object.keys(POOL_SIZES))('throws naming a missing pool buffer (%s), before allocating anything', (name) => {
    const gpu = makeDevice();
    const { pool } = makePool(name);
    expect(() => new TransparentSortPass().setup(gpu.device, pool)).toThrow(name);
    expect(gpu.buffers).toEqual([]);
  });

  it('reads the pool and never writes it: a hot-reload probe runs setup() on the LIVE pool', () => {
    const gpu = makeDevice();
    const { pool } = makePool();
    const spies = [
      vi.spyOn(pool, 'setBuffer'), vi.spyOn(pool, 'setTexture'),
      vi.spyOn(pool, 'setTextureView'), vi.spyOn(pool, 'setSampler'),
    ];
    new TransparentSortPass().setup(gpu.device, pool);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('allocates its private buffers at CAP, with COPY_SRC in dev for the readback', () => {
    const { buffers, byLabel } = setUp();
    expect(buffers).toHaveLength(6);
    expect(byLabel('sort-keys-a')).toMatchObject({ size: 2 * CAP * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
    expect(byLabel('sort-keys-b')).toMatchObject({ size: 2 * CAP * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
    expect(byLabel('sort-vals-a')).toMatchObject({ size: CAP * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC });
    expect(byLabel('sort-hist')).toMatchObject({
      size: HIST_WORDS * 4, usage: USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC,
    });
    expect(HIST_WORDS * 4).toBe(107_584);
    expect(byLabel('sort-gather-params')).toMatchObject({ size: 16, usage: USAGE.UNIFORM | USAGE.COPY_DST });
    expect(byLabel('sort-pass-params')).toMatchObject({
      size: PASSES * PASS_PARAMS_STRIDE, usage: USAGE.UNIFORM | USAGE.COPY_DST,
    });
  });

  it('writes the 7 PassParams slices once, slice p = {p, 0, 0, 0} at 256·p, and nothing else', () => {
    const { writes, byLabel } = setUp();
    const params = byLabel('sort-pass-params');
    expect(writes).toHaveLength(1);
    expect(writes[0].buffer).toBe(params);
    expect(writes[0].offset).toBe(0);
    const W = PASS_PARAMS_STRIDE / 4;
    expect(writes[0].words).toHaveLength(PASSES * W);
    for (let p = 0; p < PASSES; p++) expect(writes[0].words.slice(p * W, p * W + 4)).toEqual([p, 0, 0, 0]);
  });

  it('builds the four pipelines on their entry points: gather on its layout, the three stages on the other', () => {
    const { pipelines, layouts } = setUp();
    expect(pipelines.map((p) => p.desc.compute.entryPoint)).toEqual(['gather_main', 'upsweep_main', 'scan_main', 'scatter_main']);
    const code = (p: Pipeline) => (p.desc.compute.module as unknown as { code: string }).code;
    expect(code(pipelines[0])).toBe(gatherSource);
    for (const p of pipelines.slice(1)) expect(code(p)).toBe(sortSource);
    const groupLayouts = (p: Pipeline) =>
      (p.desc.layout as unknown as { desc: GPUPipelineLayoutDescriptor }).desc.bindGroupLayouts;
    const byName = (label: string) => layouts.find((l) => l.desc.label === label);
    expect(groupLayouts(pipelines[0])).toEqual([byName('transparent-gather')]);
    for (const p of pipelines.slice(1)) expect(groupLayouts(p)[0]).toBe(byName('transparent-sort'));
  });

  it('gives every layout entry a minBindingSize, and binds buffers at least that big', () => {
    const { layouts, groups } = setUp();
    expect(layouts).toHaveLength(2);
    for (const l of layouts) {
      for (const e of l.desc.entries) {
        expect(e.buffer?.minBindingSize, `${l.desc.label} b${e.binding}`).toBeGreaterThan(0);
        expect(e.visibility).toBe(STAGE.COMPUTE);
      }
    }
    for (const g of groups) {
      const layout = (g.desc.layout as unknown as Layout).desc;
      for (const e of g.desc.entries) {
        const le = [...layout.entries].find((x) => x.binding === e.binding)!;
        const r = e.resource as GPUBufferBinding;
        const size = r.size ?? (r.buffer as unknown as Buf).size - (r.offset ?? 0);
        expect(size, `${g.desc.label} b${e.binding}`).toBeGreaterThanOrEqual(le.buffer!.minBindingSize!);
      }
    }
    // The fixed-size bindings are exactly their WGSL size.
    const min = (label: string, binding: number) =>
      [...layouts.find((l) => l.desc.label === label)!.desc.entries].find((e) => e.binding === binding)!.buffer!.minBindingSize;
    expect(min('transparent-gather', 0)).toBe(16);
    expect(min('transparent-gather', 7)).toBe(HEADER_BYTES);
    expect(min('transparent-sort', 0)).toBe(16);
    expect(min('transparent-sort', 5)).toBe(HEADER_BYTES);
  });

  it.each([['transparent-gather', 7, gatherSource], ['transparent-sort', 6, sortSource]] as const)(
    '%s: the layout entries match the WGSL declarations, %i storage buffers',
    (label, storage, src) => {
      const { layouts } = setUp();
      const WGSL_TO_LAYOUT: Record<string, GPUBufferBindingType> = {
        'uniform': 'uniform', 'storage,read': 'read-only-storage', 'storage,read_write': 'storage',
      };
      const declared = [...src.replace(/\/\/[^\n]*/g, '').matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var<([^>]+)>/g)]
        .map((m) => ({ group: Number(m[1]), binding: Number(m[2]), type: WGSL_TO_LAYOUT[m[3].replace(/\s+/g, '')] }));
      expect(declared.every((d) => d.group === 0)).toBe(true);
      const entries = [...layouts.find((l) => l.desc.label === label)!.desc.entries];
      expect(entries.map((e) => [e.binding, e.buffer!.type])).toEqual(declared.map((d) => [d.binding, d.type]));
      expect(entries.filter((e) => e.buffer!.type !== 'uniform')).toHaveLength(storage);
    },
  );

  it('creates 8 bind groups: the gather\'s, then one per pass with its slice and its direction', () => {
    const { groups, named } = setUp();
    expect(groups).toHaveLength(1 + PASSES);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((b) => bufferOf(groups[0], b).label)).toEqual([
      'sort-gather-params', 'indirect-args', 'visible-indices', 'entity-bounds', 'entity-ids',
      'sort-keys-a', 'sort-vals-a', 'transparent-args',
    ]);
    for (let p = 0; p < PASSES; p++) {
      const g = groups[1 + p];
      expect(bufferOf(g, 0).label).toBe('sort-pass-params');
      expect(bufferBinding(g, 0)).toMatchObject({ offset: p * PASS_PARAMS_STRIDE, size: 16 });
      const io = p % 2 === 0
        ? ['sort-keys-a', 'sort-vals-a', 'sort-keys-b', 'transparent-order']   // A → B
        : ['sort-keys-b', 'transparent-order', 'sort-keys-a', 'sort-vals-a'];  // B → A
      expect([1, 2, 3, 4, 5, 6].map((b) => bufferOf(g, b).label)).toEqual([...io, 'transparent-args', 'sort-hist']);
    }
    // PASSES is odd: the last pass writes its values into transparent-order.
    expect(bufferOf(groups[PASSES], 4)).toBe(named['transparent-order']);
  });
});

describe('TransparentSortPass.prepare', () => {
  it('writes GatherParams, the header reset and the zeroed diag — once each, every frame', () => {
    const { pass, device, writes } = setUp();
    const before = writes.length;
    pass.prepare(device, frameOf(1234, 42));
    const w = writes.slice(before);
    expect(w.map((x) => x.buffer.label)).toEqual(['sort-gather-params', 'transparent-args', 'sort-hist']);
    expect(w[0]).toMatchObject({ offset: 0, words: [1234, 42, 0, 0] });
    expect(w[1]).toMatchObject({
      offset: 0, words: [6, 0, 0, 0, 0, 0, 1, 1, 0, 1234, 0, STAMP_SENTINEL, 0, 0, 0, 0],
    });
    expect(w[2]).toMatchObject({ offset: 0, words: new Array(DIAG_WORDS).fill(0) });

    pass.prepare(device, frameOf(5, 43));
    const w2 = writes.slice(before + 3);
    expect(w2).toHaveLength(3);
    expect(w2[0].words).toEqual([5, 43, 0, 0]);
    expect(w2[1].words[9]).toBe(5);
  });

  it('bounds the gather at CAP', () => {
    const { pass, device, writes } = setUp();
    const before = writes.length;
    pass.prepare(device, frameOf(250_000, 1));
    const w = writes.slice(before);
    expect(w[0].words[0]).toBe(CAP);
    expect(w[1].words[9]).toBe(CAP);
  });

  it('still resets the header at count 0: the draw args say 0 instances', () => {
    const { pass, device, writes } = setUp();
    const before = writes.length;
    pass.prepare(device, frameOf(0, 2));
    const w = writes.slice(before);
    expect(w).toHaveLength(3);
    expect(w[1].words.slice(0, 5)).toEqual([6, 0, 0, 0, 0]);
  });
});

describe('TransparentSortPass.execute', () => {
  it('at 100000: one compute pass — gather 391, then per pass upsweep and scatter indirect at 20, scan 1', () => {
    const { pass, device, pool, groups, named } = setUp();
    const f = frameOf(100_000);
    pass.prepare(device, f);
    const { encoder, cmds } = record();
    pass.execute(encoder, f, pool);
    expect(cmds.filter((c) => c.kind === 'pass')).toHaveLength(1);
    const d = dispatches(cmds);
    expect(d).toHaveLength(1 + 3 * PASSES);
    expect(d[0]).toMatchObject({ entry: 'gather_main', x: 391 });
    expect(d[0].group).toBe(groups[0]);
    expect(DISPATCH_OFFSET_BYTES).toBe(20);
    for (let p = 0; p < PASSES; p++) {
      const [up, scan, scatter] = d.slice(1 + 3 * p, 4 + 3 * p);
      expect(up.entry).toBe('upsweep_main');
      expect(up.indirect).toEqual({ buffer: named['transparent-args'], offset: 20 });
      expect(scan).toMatchObject({ entry: 'scan_main', x: 1 });
      expect(scatter.entry).toBe('scatter_main');
      expect(scatter.indirect).toEqual({ buffer: named['transparent-args'], offset: 20 });
      for (const s of [up, scan, scatter]) expect(s.group).toBe(groups[1 + p]);
    }
  });

  it.each([[1000, 4], [256, 1], [257, 2]])('sizes the gather from the bound: %i → %i workgroups', (count, workgroups) => {
    const { pass, device, pool } = setUp();
    pass.prepare(device, frameOf(count));
    const { encoder, cmds } = record();
    pass.execute(encoder, frameOf(count), pool);
    expect(dispatches(cmds)[0]).toMatchObject({ entry: 'gather_main', x: workgroups });
  });

  it('never writes a buffer: a writeBuffer lands before the NEXT submit', () => {
    const target = fakeTarget(3);
    const { pass, device, pool, writes } = setUp({ take: () => target });
    const f = frameOf(4000, 3);
    pass.prepare(device, f);
    const before = writes.length;
    for (const withMark of [false, true]) {
      const { encoder, mark } = record();
      pass.execute(encoder, f, pool, withMark ? mark : undefined);
    }
    expect(writes.length).toBe(before);
  });

  it.each([0, Number.NaN])('count %s: encodes nothing and profileStages is empty', (count) => {
    const { pass, device, pool } = setUp();
    const f = frameOf(count);
    pass.prepare(device, f);
    expect(pass.profileStages(f)).toEqual([]);
    const { encoder, cmds, mark } = record();
    pass.execute(encoder, f, pool);
    pass.execute(encoder, f, pool, mark);
    expect(cmds).toEqual([]);
  });

  it('with the profiler: 22 compute passes, one per stage, each right after its mark — as profileStages names them', () => {
    const { pass, device, pool } = setUp();
    const f = frameOf(5000);
    pass.prepare(device, f);
    const stages = pass.profileStages(f);
    expect(stages).toEqual(STAGES);
    expect(stages).toHaveLength(22);
    const { encoder, cmds, mark } = record();
    pass.execute(encoder, f, pool, mark);
    expect(cmds.filter((c) => c.kind === 'mark')).toHaveLength(stages.length);
    expect(cmds.filter((c) => c.kind === 'pass')).toHaveLength(stages.length);
    cmds.forEach((c, i) => { if (c.kind === 'mark') expect(cmds[i + 1].kind).toBe('pass'); });
    expect(dispatches(cmds).map((d) => d.entry)).toEqual(stages.map((s) => ENTRY[s]));
  });

  it('with a readback request: gather, its output copied, the sort in a second pass, then header, hist and order', () => {
    const target = fakeTarget(9);
    const probe = { take: vi.fn((_stamp: number): SortReadbackTarget | null => target) };
    const { pass, device, pool } = setUp(probe);
    const f = frameOf(3000, 9);
    pass.prepare(device, f);
    const { encoder, cmds } = record();
    pass.execute(encoder, f, pool);
    expect(probe.take).toHaveBeenCalledTimes(1);
    expect(probe.take).toHaveBeenCalledWith(9);
    expect(cmds.filter((c) => c.kind === 'pass' || c.kind === 'end' || c.kind === 'copy').map((c) => c.kind))
      .toEqual(['pass', 'end', 'copy', 'copy', 'pass', 'end', 'copy', 'copy', 'copy']);
    const copies = cmds.filter((c): c is Copy => c.kind === 'copy');
    expect(copies.map((c) => [c.src.label, c.srcOffset, c.dst.label, c.dstOffset, c.size])).toEqual([
      ['sort-keys-a', 0, 'rb-gather-keys', 0, 2 * CAP * 4],
      ['sort-vals-a', 0, 'rb-gather-vals', 0, CAP * 4],
      ['transparent-args', 0, 'rb-header', 0, HEADER_BYTES],
      ['sort-hist', 0, 'rb-hist', 0, TILES_OFFSET * 4],
      ['transparent-order', 0, 'rb-order', 0, CAP * 4],
    ]);
    const firstEnd = cmds.findIndex((c) => c.kind === 'end');
    expect(dispatches(cmds.slice(0, firstEnd)).map((d) => d.entry)).toEqual(['gather_main']);
    expect(dispatches(cmds.slice(firstEnd))).toHaveLength(3 * PASSES);
  });

  it('with a readback request and the profiler: 22 passes, the gather output copied right after the first', () => {
    const target = fakeTarget(5);
    const { pass, device, pool } = setUp({ take: () => target });
    const f = frameOf(2000, 5);
    pass.prepare(device, f);
    const { encoder, cmds, mark } = record();
    pass.execute(encoder, f, pool, mark);
    expect(cmds.filter((c) => c.kind === 'pass')).toHaveLength(22);
    expect(cmds.filter((c) => c.kind === 'mark')).toHaveLength(22);
    const firstEnd = cmds.findIndex((c) => c.kind === 'end');
    expect(cmds.slice(firstEnd + 1, firstEnd + 3).map((c) => c.kind)).toEqual(['copy', 'copy']);
    expect(cmds[firstEnd + 3].kind).toBe('mark');
    expect(cmds.slice(-3).map((c) => c.kind)).toEqual(['copy', 'copy', 'copy']);
  });

  it('asks the probe only in a frame the sort runs, once; no request means no copy and one pass', () => {
    const probe = { take: vi.fn((_stamp: number): SortReadbackTarget | null => null) };
    const { pass, device, pool } = setUp(probe);
    const { encoder, cmds } = record();
    pass.prepare(device, frameOf(0, 11));
    pass.execute(encoder, frameOf(0, 11), pool);
    expect(probe.take).not.toHaveBeenCalled();
    pass.prepare(device, frameOf(10, 12));
    pass.execute(encoder, frameOf(10, 12), pool);
    expect(probe.take).toHaveBeenCalledTimes(1);
    expect(probe.take).toHaveBeenCalledWith(12);
    expect(cmds.filter((c) => c.kind === 'copy')).toEqual([]);
    expect(cmds.filter((c) => c.kind === 'pass')).toHaveLength(1);
  });

  it('copies diag + digitBase of sort-hist, never the tiles', () => {
    expect(SORT_READBACK_BYTES).toEqual({
      gatherKeys: 2 * CAP * 4, gatherVals: CAP * 4, header: HEADER_BYTES, hist: TILES_OFFSET * 4, order: CAP * 4,
    });
    expect(TILES_OFFSET).toBe(DIAG_WORDS + PASSES * 256);
  });
});

describe('TransparentSortPass.destroy', () => {
  it('destroys its own buffers, never the pool\'s, and encodes nothing afterwards', () => {
    const { pass, pool, buffers, named } = setUp();
    pass.destroy();
    expect(buffers.every((b) => b.destroyed)).toBe(true);
    for (const b of Object.values(named)) expect(b.destroyed).toBe(false);
    const { encoder, cmds } = record();
    pass.execute(encoder, frameOf(10), pool);
    expect(cmds).toEqual([]);
    expect(pass.profileStages(frameOf(10))).toEqual([]);
  });
});
```

- [ ] **Step 2: esegui il test, deve fallire**

Run: `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-pass.test.ts`
Atteso: FAIL al caricamento, con `Failed to resolve import "./transparent-sort-pass"`.

- [ ] **Step 3: scrivi `TransparentSortPass`**

Crea `ts/src/render/passes/transparent-sort-pass.ts`:

```ts
import type { RenderPass, FrameState } from '../render-pass';
import type { ResourcePool } from '../resource-pool';
import { TOTAL_DRAW_BUCKETS } from './cull-pass';
import {
  CAP, DIAG_WORDS, DISPATCH_OFFSET_BYTES, HEADER_BYTES, HEADER_WORDS, HIST_WORDS, H_DISPATCH, H_DRAW, H_LIMIT,
  H_STAMP, PASSES, PASS_PARAMS_STRIDE, STAMP_SENTINEL, TILES_OFFSET, WORKGROUP_SIZE,
} from './transparent-sort-constants';

/** One u32 per slot: entity-ids, the value columns, transparent-order. */
const COLUMN_BYTES = CAP * 4;
/** The keys, SoA in one buffer: lo (the id) at [0, CAP), hi (the z key) at [CAP, 2·CAP). */
const KEYS_BYTES = 2 * COLUMN_BYTES;
const HIST_BYTES = HIST_WORDS * 4;
/** GatherParams, and each PassParams slice: 4 × u32. */
const PARAMS_BYTES = 16;
/** The pool buffers the gather reads, sized as createRenderer allocates them. */
const INDIRECT_ARGS_BYTES = TOTAL_DRAW_BUCKETS * 5 * 4;
const VISIBLE_INDICES_BYTES = TOTAL_DRAW_BUCKETS * CAP * 4;
const BOUNDS_BYTES = CAP * 4 * 4;
/** DrawIndexedIndirect.indexCount of the unit quad. */
const QUAD_INDEX_COUNT = 6;

type SortStage = 'upsweep' | 'scan' | 'scatter';
const SORT_STAGES: readonly SortStage[] = ['upsweep', 'scan', 'scatter'];
/** What profileStages names when the sort runs: 22, in encoding order. */
const PROFILE_STAGES: readonly string[] = ['gather', ...Array.from({ length: PASSES }, () => SORT_STAGES).flat()];

/**
 * The staging buffers of one `engine.debug.readTransparentSort()` request
 * (`TransparentSortProbe`, dev builds only): MAP_READ | COPY_DST, owned by the
 * request and never by the pass, so a pass destroyed while a map is pending
 * cannot break it.
 */
export interface SortReadbackTarget {
  /** The frame it was served in (`FrameState.frameStamp`); header word 11 must say the same. */
  stamp: number;
  /** sort-keys-a after the gather: lo at [0, CAP), hi at [CAP, 2·CAP). */
  gatherKeys: GPUBuffer;
  /** sort-vals-a after the gather: the gathered slots. */
  gatherVals: GPUBuffer;
  /** transparent-args after the sort. */
  header: GPUBuffer;
  /** sort-hist words [0, TILES_OFFSET): diag, then digitBase (7 × 256). */
  hist: GPUBuffer;
  /** transparent-order: the sorted slots. */
  order: GPUBuffer;
}

/** What the pass needs of `TransparentSortProbe`: the head request, taken only in a frame the sort runs. */
export interface SortReadbackTaker {
  take(stamp: number): SortReadbackTarget | null;
}

/** Bytes copied into each {@link SortReadbackTarget} buffer, i.e. the size to create each with. */
export const SORT_READBACK_BYTES = {
  gatherKeys: KEYS_BYTES,
  gatherVals: COLUMN_BYTES,
  header: HEADER_BYTES,
  hist: TILES_OFFSET * 4,
  order: COLUMN_BYTES,
} as const;

/** B: how many transparents the gather may collect this frame (0 = skip the sort). */
function sortBound(frame: FrameState): number {
  const bound = Math.min(frame.transparentCount, CAP);
  return bound > 0 ? Math.floor(bound) : 0;
}

/**
 * Back-to-front order of the transparent primitives (Phase 5b, design
 * 2026-09-27 §5). All on the GPU: a gather of CullPass's transparent buckets
 * 14..25, then a stable 7-pass LSD radix sort on (z key, external id).
 *
 *   gather           ceil(B / 256) workgroups, B = min(transparentCount, CAP)
 *   7 × upsweep      indirect: ceil(n / 1024) tiles (transparent-args at 20 B)
 *       scan         1 workgroup
 *       scatter      indirect, like upsweep
 *
 * Writes `transparent-order` (the sorted slots; ForwardPass's uber draw reads
 * them in place of visible-indices) and `transparent-args` (draw args
 * {6, n, 0, 0, 0}, dispatch args, raw/limit/overflow and the frame stamp).
 * Both are the RENDERER's pool buffers. A hot-reload probe runs setup() and then
 * destroy() on the live pool, so a pass must never register or destroy them.
 *
 * Uniforms are written only where writeBuffer is safe: the 7 PassParams slices
 * once in setup(), and GatherParams, the header reset and diag in prepare().
 * execute() never writes. A writeBuffer lands before the NEXT submit, so one
 * made between passes of a frame is what all of them read.
 *
 * Encoding: one compute pass, in which each dispatch is its own usage scope and
 * sees the writes of the one before. Two passes when a readback takes this
 * frame: the gather's output is copied before pass 1 overwrites it. One pass per
 * stage, 22 in all, while the GPU profiler measures, each after its own `mark`;
 * `profileStages` lists the same 22, or `[]` when the sort is skipped. With a
 * bound of 0 nothing is encoded (a direct `dispatchWorkgroups(0)` is a Dawn
 * warning), and the header written by prepare() already draws 0 instances.
 */
export class TransparentSortPass implements RenderPass {
  readonly name = 'transparent-sort';
  readonly reads = ['indirect-args', 'visible-indices', 'entity-bounds', 'entity-ids'];
  readonly writes = ['transparent-order', 'transparent-args'];
  readonly optional = true;

  /** `transparent-gather.wgsl` (`gather_main`). Set before setup(): renderer.ts, from the `?raw` import. */
  static GATHER_SOURCE = '';
  /** `transparent-sort.wgsl` (`upsweep_main`, `scan_main`, `scatter_main`). */
  static SORT_SOURCE = '';

  private gatherPipeline: GPUComputePipeline | null = null;
  private stagePipelines: Record<SortStage, GPUComputePipeline> | null = null;
  private gatherBindGroup: GPUBindGroup | null = null;
  /** Bind group p: PassParams slice p, A → B for even p, B → A for odd p. */
  private passBindGroups: GPUBindGroup[] = [];
  private keysA: GPUBuffer | null = null;
  private keysB: GPUBuffer | null = null;
  private valsA: GPUBuffer | null = null;
  private hist: GPUBuffer | null = null;
  private gatherParams: GPUBuffer | null = null;
  private passParams: GPUBuffer | null = null;
  /** Pool buffers owned by the renderer: never destroyed here. */
  private args: GPUBuffer | null = null;
  private order: GPUBuffer | null = null;
  private readonly gatherData = new Uint32Array(PARAMS_BYTES / 4);
  private readonly headerData = new Uint32Array(HEADER_WORDS);
  private readonly diagZeros = new Uint32Array(DIAG_WORDS);

  /**
   * @param probe the readback requests of `engine.debug.readTransparentSort()`
   *   (dev builds, the live graph's pass only). A pass built without one, like
   *   the hot-reload probe's, never takes a request.
   */
  constructor(private readonly probe: SortReadbackTaker | null = null) {}

  setup(device: GPUDevice, resources: ResourcePool): void {
    if (!TransparentSortPass.GATHER_SOURCE || !TransparentSortPass.SORT_SOURCE) {
      throw new Error('TransparentSortPass.GATHER_SOURCE and SORT_SOURCE must be set before calling setup()');
    }
    // Read from the pool, never written to it (see the class comment). Looked
    // up first, so a missing one throws before anything is allocated.
    const pooled = (name: string): GPUBuffer => {
      const buffer = resources.getBuffer(name);
      if (!buffer) throw new Error(`TransparentSortPass.setup: missing '${name}' in ResourcePool`);
      return buffer;
    };
    const indirectArgs = pooled('indirect-args');
    const visibleIndices = pooled('visible-indices');
    const bounds = pooled('entity-bounds');
    const entityIds = pooled('entity-ids');
    const args = pooled('transparent-args');
    const order = pooled('transparent-order');

    const dev = typeof __DEV__ !== 'undefined' && __DEV__;
    // COPY_SRC in dev builds: engine.debug.readTransparentSort() copies them out.
    const readback = dev ? GPUBufferUsage.COPY_SRC : 0;
    const keysA = device.createBuffer({ label: 'sort-keys-a', size: KEYS_BYTES, usage: GPUBufferUsage.STORAGE | readback });
    const keysB = device.createBuffer({ label: 'sort-keys-b', size: KEYS_BYTES, usage: GPUBufferUsage.STORAGE | readback });
    const valsA = device.createBuffer({ label: 'sort-vals-a', size: COLUMN_BYTES, usage: GPUBufferUsage.STORAGE | readback });
    const hist = device.createBuffer({
      label: 'sort-hist', size: HIST_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | readback,
    });
    const gatherParams = device.createBuffer({
      label: 'sort-gather-params', size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const passParams = device.createBuffer({
      label: 'sort-pass-params', size: PASSES * PASS_PARAMS_STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.keysA = keysA;
    this.keysB = keysB;
    this.valsA = valsA;
    this.hist = hist;
    this.gatherParams = gatherParams;
    this.passParams = passParams;
    this.args = args;
    this.order = order;

    // The 7 PassParams slices, {passIndex, 0, 0, 0} each at 256·p, written once:
    // they never change, and bind group p pins slice p.
    const slices = new Uint32Array((PASSES * PASS_PARAMS_STRIDE) / 4);
    for (let p = 0; p < PASSES; p++) slices[(p * PASS_PARAMS_STRIDE) / 4] = p;
    device.queue.writeBuffer(passParams, 0, slices);

    // minBindingSize on every entry: a buffer smaller than the kernel expects
    // then fails at bind group creation, not at dispatch time.
    const entry = (binding: number, type: GPUBufferBindingType, minBindingSize: number): GPUBindGroupLayoutEntry =>
      ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type, minBindingSize } });
    const gatherLayout = device.createBindGroupLayout({
      label: 'transparent-gather',
      entries: [
        entry(0, 'uniform', PARAMS_BYTES),                      // GatherParams
        entry(1, 'read-only-storage', INDIRECT_ARGS_BYTES),     // indirect-args
        entry(2, 'read-only-storage', VISIBLE_INDICES_BYTES),   // visible-indices
        entry(3, 'read-only-storage', BOUNDS_BYTES),            // entity-bounds, read as vec4<u32>
        entry(4, 'read-only-storage', COLUMN_BYTES),            // entity-ids
        entry(5, 'storage', KEYS_BYTES),                        // sort-keys-a
        entry(6, 'storage', COLUMN_BYTES),                      // sort-vals-a
        entry(7, 'storage', HEADER_BYTES),                      // transparent-args
      ],
    });
    const sortLayout = device.createBindGroupLayout({
      label: 'transparent-sort',
      entries: [
        entry(0, 'uniform', PARAMS_BYTES),                      // PassParams, slice p
        entry(1, 'read-only-storage', KEYS_BYTES),              // keys in
        entry(2, 'read-only-storage', COLUMN_BYTES),            // values in
        entry(3, 'storage', KEYS_BYTES),                        // keys out
        entry(4, 'storage', COLUMN_BYTES),                      // values out
        entry(5, 'read-only-storage', HEADER_BYTES),            // transparent-args: n, uniform
        entry(6, 'storage', HIST_BYTES),                        // sort-hist
      ],
    });

    const gatherModule = device.createShaderModule({ label: 'transparent-gather', code: TransparentSortPass.GATHER_SOURCE });
    const sortModule = device.createShaderModule({ label: 'transparent-sort', code: TransparentSortPass.SORT_SOURCE });
    this.gatherPipeline = device.createComputePipeline({
      label: 'transparent-sort/gather',
      layout: device.createPipelineLayout({ bindGroupLayouts: [gatherLayout] }),
      compute: { module: gatherModule, entryPoint: 'gather_main' },
    });
    const sortPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [sortLayout] });
    const stage = (entryPoint: string): GPUComputePipeline => device.createComputePipeline({
      label: `transparent-sort/${entryPoint}`,
      layout: sortPipelineLayout,
      compute: { module: sortModule, entryPoint },
    });
    this.stagePipelines = { upsweep: stage('upsweep_main'), scan: stage('scan_main'), scatter: stage('scatter_main') };

    this.gatherBindGroup = device.createBindGroup({
      label: 'transparent-gather',
      layout: gatherLayout,
      entries: [
        { binding: 0, resource: { buffer: gatherParams } },
        { binding: 1, resource: { buffer: indirectArgs } },
        { binding: 2, resource: { buffer: visibleIndices } },
        { binding: 3, resource: { buffer: bounds } },
        { binding: 4, resource: { buffer: entityIds } },
        { binding: 5, resource: { buffer: keysA } },
        { binding: 6, resource: { buffer: valsA } },
        { binding: 7, resource: { buffer: args } },
      ],
    });
    // A = (sort-keys-a, sort-vals-a), B = (sort-keys-b, transparent-order).
    this.passBindGroups = Array.from({ length: PASSES }, (_, p) => {
      const even = p % 2 === 0;
      return device.createBindGroup({
        label: `transparent-sort-${p}`,
        layout: sortLayout,
        entries: [
          { binding: 0, resource: { buffer: passParams, offset: p * PASS_PARAMS_STRIDE, size: PARAMS_BYTES } },
          { binding: 1, resource: { buffer: even ? keysA : keysB } },
          { binding: 2, resource: { buffer: even ? valsA : order } },
          { binding: 3, resource: { buffer: even ? keysB : keysA } },
          { binding: 4, resource: { buffer: even ? order : valsA } },
          { binding: 5, resource: { buffer: args } },
          { binding: 6, resource: { buffer: hist } },
        ],
      });
    });
  }

  profileStages(frame: FrameState): readonly string[] {
    // Must match execute()'s mark calls one for one, or GpuProfiler drops the frame.
    return sortBound(frame) > 0 && this.ready ? PROFILE_STAGES : [];
  }

  prepare(device: GPUDevice, frame: FrameState): void {
    if (!this.gatherParams || !this.args || !this.hist) return;
    const bound = sortBound(frame);
    this.gatherData[0] = bound;
    this.gatherData[1] = frame.frameStamp;
    device.queue.writeBuffer(this.gatherParams, 0, this.gatherData);
    // What the frame draws if the gather does not run: nothing. The gather
    // overwrites words 0-11; the stamp sentinel lets a readback tell it did not.
    const h = this.headerData;
    h.fill(0);
    h[H_DRAW] = QUAD_INDEX_COUNT;
    h[H_DISPATCH + 1] = 1;
    h[H_DISPATCH + 2] = 1;
    h[H_LIMIT] = bound;
    h[H_STAMP] = STAMP_SENTINEL;
    device.queue.writeBuffer(this.args, 0, h);
    device.queue.writeBuffer(this.hist, 0, this.diagZeros);
  }

  execute(
    encoder: GPUCommandEncoder,
    frame: FrameState,
    _resources: ResourcePool,
    mark?: (encoder: GPUCommandEncoder) => void,
  ): void {
    const bound = sortBound(frame);
    if (bound === 0 || !this.ready) return;
    // Only in a frame the sort runs: a request left in the queue waits for one.
    const target = this.probe?.take(frame.frameStamp) ?? null;

    if (mark) {
      mark(encoder);
      const gather = encoder.beginComputePass({ label: 'transparent-sort/gather' });
      this.encodeGather(gather, bound);
      gather.end();
      if (target) this.copyGathered(encoder, target);
      for (let p = 0; p < PASSES; p++) {
        for (const stage of SORT_STAGES) {
          mark(encoder);
          const pass = encoder.beginComputePass({ label: `transparent-sort/${stage}` });
          this.encodeStage(pass, stage, p);
          pass.end();
        }
      }
    } else {
      let pass = encoder.beginComputePass({ label: 'transparent-sort' });
      this.encodeGather(pass, bound);
      if (target) {
        // Pass 1 overwrites sort-keys-a / sort-vals-a: copy the gather's output first.
        pass.end();
        this.copyGathered(encoder, target);
        pass = encoder.beginComputePass({ label: 'transparent-sort' });
      }
      for (let p = 0; p < PASSES; p++) {
        for (const stage of SORT_STAGES) this.encodeStage(pass, stage, p);
      }
      pass.end();
    }
    if (target) this.copyResults(encoder, target);
  }

  resize(_width: number, _height: number): void {
    // Fixed-size buffers: nothing follows the canvas.
  }

  destroy(): void {
    this.keysA?.destroy();
    this.keysB?.destroy();
    this.valsA?.destroy();
    this.hist?.destroy();
    this.gatherParams?.destroy();
    this.passParams?.destroy();
    this.keysA = null;
    this.keysB = null;
    this.valsA = null;
    this.hist = null;
    this.gatherParams = null;
    this.passParams = null;
    this.args = null;   // the renderer's pool buffer: not ours to destroy
    this.order = null;  // likewise
    this.gatherPipeline = null;
    this.stagePipelines = null;
    this.gatherBindGroup = null;
    this.passBindGroups = [];
  }

  private get ready(): boolean {
    return this.gatherPipeline !== null && this.stagePipelines !== null && this.gatherBindGroup !== null
      && this.passBindGroups.length === PASSES && this.args !== null;
  }

  private encodeGather(pass: GPUComputePassEncoder, bound: number): void {
    pass.setPipeline(this.gatherPipeline!);
    pass.setBindGroup(0, this.gatherBindGroup!);
    pass.dispatchWorkgroups(Math.ceil(bound / WORKGROUP_SIZE));
  }

  private encodeStage(pass: GPUComputePassEncoder, stage: SortStage, p: number): void {
    pass.setPipeline(this.stagePipelines![stage]);
    pass.setBindGroup(0, this.passBindGroups[p]);
    if (stage === 'scan') pass.dispatchWorkgroups(1);
    else pass.dispatchWorkgroupsIndirect(this.args!, DISPATCH_OFFSET_BYTES);
  }

  private copyGathered(encoder: GPUCommandEncoder, target: SortReadbackTarget): void {
    encoder.copyBufferToBuffer(this.keysA!, 0, target.gatherKeys, 0, SORT_READBACK_BYTES.gatherKeys);
    encoder.copyBufferToBuffer(this.valsA!, 0, target.gatherVals, 0, SORT_READBACK_BYTES.gatherVals);
  }

  private copyResults(encoder: GPUCommandEncoder, target: SortReadbackTarget): void {
    encoder.copyBufferToBuffer(this.args!, 0, target.header, 0, SORT_READBACK_BYTES.header);
    encoder.copyBufferToBuffer(this.hist!, 0, target.hist, 0, SORT_READBACK_BYTES.hist);
    encoder.copyBufferToBuffer(this.order!, 0, target.order, 0, SORT_READBACK_BYTES.order);
  }
}
```

- [ ] **Step 4: esegui test e type-check, devono passare**

Run: `npx --prefix ts vitest run --root ts src/render/passes/transparent-sort-pass.test.ts`
Atteso: PASS, tutti i test.

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Atteso: nessuna riga.

- [ ] **Step 5: commit del pass**

```bash
git add ts/src/render/passes/transparent-sort-pass.ts ts/src/render/passes/transparent-sort-pass.test.ts
git commit -m "feat(5b): TransparentSortPass su device finto (setup, prepare, execute, readback, profiler)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: scrivi i test dell'integrazione (falliscono)**

(a) In coda a `ts/src/render/passes/forward-pass.test.ts`:

```ts
// Phase 5b: ForwardPass reads the transparent sort's outputs in every graph.
// That read is what orders TransparentSortPass before it and keeps it alive:
// the sort is optional, and RadixSortPass was culled because nothing read it.
describe('ForwardPass reads the transparent sort outputs', () => {
  it.each([false, true])('lit=%s: transparent-order and transparent-args are reads', (lit) => {
    const pass = new ForwardPass({ lit });
    expect(pass.reads).toEqual(expect.arrayContaining(['transparent-order', 'transparent-args']));
  });
});
```

(b) In `ts/src/render/graph-assembly.test.ts`, subito dopo `import { LightGroupsPass } from './passes/light-groups-pass';` (L11):

```ts
import { ScatterPass } from './passes/scatter-pass';
import { CullPass } from './passes/cull-pass';
import { TransparentSortPass } from './passes/transparent-sort-pass';
```

e in coda al file:

```ts
// Phase 5b: the sort runs in all six graphs (3 composites × lighting on/off),
// between the cull that fills its regions and the forward pass that draws its
// order. The scene here is made of the real passes, so what compiles is the
// set of reads/writes the renderer ships.
describe('composeRenderGraph — transparent sort', () => {
  const realScene = (mode: GraphMode): RenderPass[] => [
    new ScatterPass(), new CullPass(), new TransparentSortPass(), new ForwardPass({ lit: mode.lighting }),
  ];
  for (const { mode, composite } of MODES) {
    for (const lighting of [false, true]) {
      it(`${composite}${lighting ? ' + lighting' : ''}: transparent-sort runs after cull and before forward`, () => {
        const f = { ...factories(), scene: vi.fn(realScene) };
        const order = composeRenderGraph({ ...mode, lighting }, f, []).graph.compile();
        const at = (name: string) => order.indexOf(name);
        expect(at('cull')).toBeGreaterThan(-1);
        expect(at('transparent-sort')).toBeGreaterThan(at('cull'));
        expect(at('forward')).toBeGreaterThan(at('transparent-sort'));
      });
    }
  }
});
```

(c) In `ts/src/render/passes/transparent-sort-pass.test.ts`, aggiungi `import { readFileSync } from 'node:fs';` subito dopo la riga `import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';`, poi in coda al file:

```ts
// createRenderer needs a GPU, so its wiring is checked as text, as
// light-groups.test.ts already does for renderer.ts. A missing accept block
// turns every kernel edit into a full page reload, which on this machine loses
// the device.
describe('renderer wiring', () => {
  const renderer = readFileSync(new URL('../../renderer.ts', import.meta.url), 'utf8');

  it('imports both kernels and publishes them before GraphRequests seeds its good sources', () => {
    const gather = /import (\w+) from '\.\/shaders\/transparent-gather\.wgsl\?raw';/.exec(renderer);
    const sort = /import (\w+) from '\.\/shaders\/transparent-sort\.wgsl\?raw';/.exec(renderer);
    expect(gather).not.toBeNull();
    expect(sort).not.toBeNull();
    const requests = renderer.indexOf('new GraphRequests<');
    for (const publish of [
      `TransparentSortPass.GATHER_SOURCE = ${gather![1]};`,
      `TransparentSortPass.SORT_SOURCE = ${sort![1]};`,
    ]) {
      expect(renderer.indexOf(publish), publish).toBeGreaterThan(-1);
      expect(renderer.indexOf(publish), publish).toBeLessThan(requests);
    }
  });

  it('creates transparent-order and transparent-args in the pool before the first graph is set up', () => {
    const host = renderer.indexOf('new RenderGraphHost(');
    for (const name of ['transparent-order', 'transparent-args']) {
      const at = renderer.indexOf(`resources.setBuffer('${name}'`);
      expect(at, name).toBeGreaterThan(-1);
      expect(at, name).toBeLessThan(host);
    }
  });

  it('runs the sort between cull and forward in the scene factory', () => {
    expect(renderer).toMatch(/new CullPass\(\), new TransparentSortPass\([^)]*\), new ForwardPass\(/);
  });

  it('gives each kernel a hot-reload slot probed by a throwaway pass, and an accept block', () => {
    for (const name of ['transparent-gather', 'transparent-sort']) {
      expect(renderer).toMatch(new RegExp(
        `'${name}': \\{[\\s\\S]*?probe: probe\\(\\(\\) => new TransparentSortPass\\(\\)\\),[\\s\\S]*?usedBy: inEveryMode`,
      ));
      expect(renderer).toContain(`import.meta.hot.accept('./shaders/${name}.wgsl?raw'`);
      expect(renderer).toContain(`recompileShader('${name}', mod.default)`);
    }
  });

  it('keeps no trace of RadixSortPass', () => {
    expect(renderer).not.toMatch(/RadixSort|radix-sort|radixSort/);
  });
});
```

- [ ] **Step 7: esegui i test, devono fallire**

Run: `npx --prefix ts vitest run --root ts src/render/passes/forward-pass.test.ts src/render/graph-assembly.test.ts src/render/passes/transparent-sort-pass.test.ts`

Atteso: FAIL per tre motivi, tutti legati al codice ancora da scrivere:
- `ForwardPass reads the transparent sort outputs`: `reads` non contiene le due risorse;
- `composeRenderGraph — transparent sort`, i 6 casi: `at('transparent-sort')` vale −1. È `optional`, e nessuno legge le sue uscite, quindi il culling lo elimina;
- `renderer wiring`: nessun import, buffer, slot o accept dei kernel, e `renderer.ts` nomina ancora `RadixSortPass`.

- [ ] **Step 8: `ForwardPass` legge le uscite del sort**

In `ts/src/render/passes/forward-pass.ts`, prima:

```ts
  readonly reads = ['visible-indices', 'entity-transforms', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params'];
```

dopo:

```ts
  // transparent-order / transparent-args (TransparentSortPass, Phase 5b) are
  // read in lit and unlit graphs alike: that read orders the sort before this
  // pass and keeps it alive. It is optional, and RadixSortPass was culled
  // because nothing read its output.
  readonly reads = [
    'visible-indices', 'entity-transforms', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params',
    'transparent-order', 'transparent-args',
  ];
```

Il costruttore resta com'è: `if (this.lit) this.reads = [...this.reads, 'light-buffer'];` aggiunge la luce sopra queste letture.

- [ ] **Step 9: il commento di `GraphPassFactories.scene`**

In `ts/src/render/graph-assembly.ts` (L23-27), prima:

```ts
  /**
   * Scene passes, always present, in registration order: scatter, cull,
   * radix-sort, forward. Given the mode, because ForwardPass reads the light
   * buffer only in a lit graph.
   */
```

dopo:

```ts
  /**
   * Scene passes, always present, in registration order: scatter, cull,
   * transparent-sort, forward. Given the mode, because ForwardPass reads the
   * light buffer only in a lit graph.
   */
```

- [ ] **Step 10: `renderer.ts` — import, buffer del pool, statiche, factory, slot, accept**

(a) Import dello shader (L17 a HEAD). Prima:

```ts
import radixSortShaderCode from './shaders/radix-sort.wgsl?raw';
```

dopo:

```ts
import transparentGatherShaderCode from './shaders/transparent-gather.wgsl?raw';
import transparentSortShaderCode from './shaders/transparent-sort.wgsl?raw';
```

(b) Import della classe (L33 a HEAD). Prima:

```ts
import { RadixSortPass } from './render/passes/radix-sort-pass';
```

dopo:

```ts
import { TransparentSortPass } from './render/passes/transparent-sort-pass';
import { CAP as SORT_CAPACITY, HEADER_BYTES as SORT_HEADER_BYTES } from './render/passes/transparent-sort-constants';
```

(c) Passo 3, subito PRIMA della riga `  // Selection mask buffer: 1 u32 per entity (0=unselected, 1=selected)` (e dopo il buffer `'entity-ids'` del Task 11, se il Task 11 l'ha messo lì), inserisci:

```ts
  // Transparent sort (Phase 5b). Renderer-owned on purpose: a hot-reload probe
  // runs TransparentSortPass.setup() and then destroy() on this LIVE pool, so a
  // pass that registered them would destroy the live graph's buffers. COPY_SRC
  // in dev builds: engine.debug.readTransparentSort() copies them out.
  resources.setBuffer('transparent-order', device.createBuffer({
    label: 'transparent-order',
    size: SORT_CAPACITY * 4,  // the sorted slots; the uber draw reads them (step 4)
    usage: GPUBufferUsage.STORAGE | (dev ? GPUBufferUsage.COPY_SRC : 0),
  }));
  resources.setBuffer('transparent-args', device.createBuffer({
    label: 'transparent-args',
    size: SORT_HEADER_BYTES,  // draw args, dispatch args at 20 B, raw/limit/overflow/stamp
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
      | (dev ? GPUBufferUsage.COPY_SRC : 0),
  }));

```

`dev` è la costante `const dev = typeof __DEV__ !== 'undefined' && __DEV__;` già dichiarata prima del passo 2.

(d) Passo 6c (L327-328 a HEAD). Prima:

```ts
  // --- 6c. RadixSortPass for transparent entity ordering (created with the graph) ---
  RadixSortPass.SHADER_SOURCE = radixSortShaderCode;
```

dopo:

```ts
  // --- 6c. TransparentSortPass: gather + GPU radix sort of the transparents (created with the graph) ---
  TransparentSortPass.GATHER_SOURCE = transparentGatherShaderCode;
  TransparentSortPass.SORT_SOURCE = transparentSortShaderCode;
```

(e) Factory `scene` (L466 a HEAD). Prima:

```ts
    scene: (mode) => [new ScatterPass(), new CullPass(), new RadixSortPass(), new ForwardPass({ lit: mode.lighting })],
```

dopo:

```ts
    // The sort sits between the cull (its input regions) and the forward pass
    // (which reads its order, and so keeps it alive).
    scene: (mode) => [new ScatterPass(), new CullPass(), new TransparentSortPass(), new ForwardPass({ lit: mode.lighting })],
```

(f) Lo slot (L577-582 a HEAD). Prima:

```ts
    'radix-sort': {
      read: () => RadixSortPass.SHADER_SOURCE,
      write: (src) => { RadixSortPass.SHADER_SOURCE = src; },
      probe: probe(() => new RadixSortPass()),
      usedBy: inEveryMode,
    },
```

dopo:

```ts
    // A throwaway TransparentSortPass compiles both modules (4 pipelines) and
    // binds the pool buffers, which already exist: it writes nothing there.
    'transparent-gather': {
      read: () => TransparentSortPass.GATHER_SOURCE,
      write: (src) => { TransparentSortPass.GATHER_SOURCE = src; },
      probe: probe(() => new TransparentSortPass()),
      usedBy: inEveryMode,
    },
    'transparent-sort': {
      read: () => TransparentSortPass.SORT_SOURCE,
      write: (src) => { TransparentSortPass.SORT_SOURCE = src; },
      probe: probe(() => new TransparentSortPass()),
      usedBy: inEveryMode,
    },
```

(g) Il blocco accept (L1020-1022 a HEAD). Prima:

```ts
    import.meta.hot.accept('./shaders/radix-sort.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('radix-sort', mod.default);
    });
```

dopo:

```ts
    import.meta.hot.accept('./shaders/transparent-gather.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('transparent-gather', mod.default);
    });
    import.meta.hot.accept('./shaders/transparent-sort.wgsl?raw', (mod) => {
      if (mod) rendererObj.recompileShader('transparent-sort', mod.default);
    });
```

`recompileShader` manda ogni nome sconosciuto a `requests.reloadShader`, quindi i due nomi nuovi arrivano ai due slot senza altri cambi.

- [ ] **Step 11: elimina `RadixSortPass`**

```bash
git rm ts/src/render/passes/radix-sort-pass.ts ts/src/render/passes/radix-sort-pass.test.ts ts/src/shaders/radix-sort.wgsl
```

`floatToSortKey`, `makeTransparentSortKey` e `cpuRadixSort` spariscono con il file. Il modello CPU del Task 13 ha la sua conversione (`sortableZBits`).

- [ ] **Step 12: esegui tutto, deve passare**

Run: `npx --prefix ts vitest run --root ts src/render/passes/forward-pass.test.ts src/render/graph-assembly.test.ts src/render/passes/transparent-sort-pass.test.ts`
Atteso: PASS, compresi i 6 casi `composeRenderGraph — transparent sort` e i 5 di `renderer wiring`.

Run: `npx --prefix ts vitest run --root ts src/shaders/uniform-layout.test.ts src/shaders/storage-budget.test.ts`
Atteso: PASS. `radix-sort.wgsl` esce dal glob, e le soglie `toBeGreaterThanOrEqual` restano soddisfatte (17 file al primo livello).

Run: `npm --prefix ts test`
Atteso: tutta la suite verde. Il totale scende dei test di `radix-sort-pass.test.ts` e sale di quelli nuovi.

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Atteso: nessuna riga.

Run: `grep -rn "RadixSort\|radix-sort\|radixSort\|floatToSortKey\|cpuRadixSort" ts/src`
Atteso: esattamente quattro righe, tutte volute (docs e CLAUDE.md sono del Task 22):
- `ts/src/render/passes/forward-pass.ts`: il commento dello Step 8 (`... It is optional, and RadixSortPass was culled`);
- `ts/src/render/passes/forward-pass.test.ts`: il commento dello Step 6(a) (`// the sort is optional, and RadixSortPass was culled because nothing read it.`);
- `ts/src/render/passes/transparent-sort-pass.test.ts`: `it('keeps no trace of RadixSortPass', ...` e la regex `/RadixSort|radix-sort|radixSort/` dello Step 6(c).

Qualsiasi altra riga è un residuo da togliere. Queste quattro NON si toccano: il test è l'unica guardia headless del cablaggio di renderer.ts.

- [ ] **Step 13: smoke test sulla GPU (Mode B e Mode C)**

Il cancello completo del passo 3 è il Task 18. Questo controllo verifica solo che il sort sia vivo nel grafo e che la GPU non rifiuti niente. Da questo commit ogni frame con trasparenti esegue i 22 dispatch, e un errore di validazione qui renderebbe nera la canvas o farebbe rifiutare ogni ricostruzione del grafo.
1. Riavvia il dev server: uno shader è stato cancellato e gli import sono cambiati. Ferma il task in background e rilancia `npm --prefix ts run dev -- --strictPort --port 5173` (Bash `run_in_background`); `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/` deve stampare `200`. Poi `mcp__chrome-devtools-gpu__list_pages` → `pageId` (o `new_page` con `about:blank`); `pageId` su ogni chiamata MCP che segue (anche nella ripetizione del punto 7) e `waitForStableDom: false` su ogni `evaluate_script`.
2. `mcp__chrome-devtools-gpu__navigate_page`: `pageId`, `type: "url"`, `url: "http://localhost:5173/?mode=B"`, `ignoreCache: true`, con l'`initScript` low-power:
   ```js
   GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)
   ```
3. `mcp__chrome-devtools-gpu__resize_page` a 1920×1080. `mcp__chrome-devtools-gpu__list_console_messages` (tipi `log`, `info`, `warn`): la riga dell'adapter deve dire AMD.
4. `mcp__chrome-devtools-gpu__evaluate_script` con lo script del passo 4 della skill `/gpu-check` e `ONLY = ['Primitives', '2D Twins']`, cioè i due tab con box shadow `.transparent()` a schermo, dove il sort gira. Criterio: per ogni tab, lo stesso `N/M passed` e gli stessi skip/pending di `docs/plans/assets/2026-09-27-transparent-sort-baseline/statuses-B.json` (Task 3); nessun `failed`.
5. Resta sul tab 2D Twins ed esegui `evaluate_script`:
   ```js
   async () => {
     const engine = window.__hyperion;
     const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
     if (!engine.enableGpuProfiling()) return { error: 'timestamp-query unavailable on this device' };
     await frames(240);
     const sort = engine.getGpuTimings()
       .filter((t) => t.name.startsWith('transparent-sort/'))
       .map((t) => ({ name: t.name, ms: t.averageMs, samples: t.sampleCount }));
     engine.disableGpuProfiling();
     return sort;
   }
   ```
   Criterio: esattamente quattro voci, `transparent-sort/gather`, `/upsweep`, `/scan` e `/scatter`, ognuna con `samples > 0`. Se non ci sono, il pass è stato eliminato dal culling oppure è saltato con conteggio 0. Se c'è `error`, su questo device mancano i timestamp: annotalo; i punti 4 e 6 bastano.
6. `list_console_messages` con tipi `error` e `warn`: nessun messaggio su WebGPU, validazione, pipeline o device. È ammesso solo il 404 di `favicon.ico`.
7. Ripeti i punti 2-6 con `url: "http://localhost:5173/?mode=C"`, confrontando con `statuses-C.json`.

- [ ] **Step 14: commit dell'integrazione**

```bash
git add ts/src/render/passes/forward-pass.ts ts/src/render/passes/forward-pass.test.ts ts/src/render/graph-assembly.ts ts/src/render/graph-assembly.test.ts ts/src/renderer.ts ts/src/render/passes/transparent-sort-pass.test.ts
git commit -m "feat(5b): il sort nel grafo, RadixSortPass eliminato, slot HMR dei kernel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Le tre eliminazioni sono già nell'indice (`git rm` dello Step 11) ed entrano in questo commit.

### Task 16: `TransparentSortProbe` + `engine.debug.readTransparentSort()`

Questo task crea il probe di sola dev, lo collega al renderer e lo espone sul facade. Il Task 15 non ne lascia nessuno scheletro: dal suo pass vengono solo `SortReadbackTarget`, `SortReadbackTaker` e `SORT_READBACK_BYTES`, che il probe importa invece di ridichiararli. Le regole vengono da §6.5 della spec, nella forma corretta dalla seconda review:
- una richiesta per frame, in ordine FIFO: N richieste emesse insieme leggono N frame consecutivi;
- lo staging appartiene alla richiesta e non al pass;
- `mapAsync` gira solo in `finish()`, dopo il submit del grafo;
- lo snapshot della CPU si copia in modo sincrono;
- se la coda non era vuota e nessuna richiesta è stata presa, si rifiuta solo la TESTA;
- si rifiuta invece di rispondere con degli zeri: stamp 0 vuol dire che la copia non è partita, la sentinella che il gather non è partito;
- se `host.graph.render()` lancia, si rifiutano la richiesta presa e tutte quelle in coda.

**Files:**
- Create: `ts/src/render/transparent-sort-probe.ts`
- Create: `ts/src/render/transparent-sort-probe.test.ts`
- Modify: `ts/src/renderer.ts`. Le righe indicate sono quelle di oggi, prima dei Task 6-15, e si spostano: valgono gli ancoraggi testuali citati negli step.
  - l'import accanto a `DebugProbe` (L53);
  - l'interfaccia `Renderer`, dopo `debugProbe` (L143-147);
  - la creazione, dopo `const debugProbe` (L231);
  - il factory `scene` (L466);
  - in `render()`, la chiamata `host.graph.render(...)` (L897), che segue la riga `const idsUpload = uploadEntityIds(...)` del Task 11 (la riga del Task 11 non cambia);
  - `rendererObj` (L959) e `destroy()` (L961-962).
- Modify: `ts/src/hyperion.ts`: l'import (L14) e il getter `debug`, dopo `readEntityTransforms` (L315-320)
- Modify: `ts/src/hyperion.test.ts`: `mockRenderer()` (L85) e `describe('debug API')` (L884-913)
- Modify: `ts/src/prefab/integration.test.ts`: `mockRenderer()` (L74)

**Interfaces:**
- Consuma:
  - da `ts/src/render/passes/transparent-sort-constants.ts` (Task 13): il probe usa `CAP`, `RADIX`, `PASSES`, `H_DRAW`, `H_RAW`, `H_LIMIT`, `H_OVERFLOW`, `H_STAMP`, `STAMP_SENTINEL`, `DIAG_WORDS`, `DIGIT_BASE_OFFSET`; il test usa in più `TILE`, `HEADER_BYTES`, `TILES_OFFSET`, `H_DISPATCH`;
  - da `ts/src/render/passes/transparent-sort-pass.ts` (Task 15): `SortReadbackTarget`, `SortReadbackTaker`, `SORT_READBACK_BYTES`;
  - `TransparentSortPass` (Task 15):
    - `constructor(private readonly probe: SortReadbackTaker | null = null)`, che un `TransparentSortProbe` soddisfa strutturalmente; `static GATHER_SOURCE`, `static SORT_SOURCE`, `setup/prepare/execute/destroy`;
    - in `execute()`, quando il sort gira (`bound > 0`), chiama `this.probe?.take(frame.frameStamp)`;
    - con un target copia ogni sorgente dall'offset 0 per `SORT_READBACK_BYTES.<buffer>` byte, la dimensione con cui `take()` crea lo staging;
  - `nextFrameStamp(prev: number): number` da `ts/src/render/frame-inputs.ts` (Task 10);
  - `FrameState.transparentCount` (già normalizzato) e `FrameState.frameStamp` (Task 10-11);
  - in `renderer.ts` (Task 11): `const idsUpload = uploadEntityIds(device.queue, entityIdsBuffer, state, uploadedIdsGeneration);`, nello scope di primo livello di `render()`, dopo l'if/else degli upload e prima della selection mask, nello stesso corpo di `host.graph.render(...)`. `idsUpload.generation` è la generazione normalizzata; `idsUpload.uploaded` dice se questo frame ha scritto `entity-ids`;
  - `gpuValidation` (`createGpuValidation(device)`, già in `renderer.ts`).
- Produce:
  ```ts
  // ts/src/render/transparent-sort-probe.ts
  export interface SortProbeSource { tickCount: number; stamp: number; entityCount: number; transparentCount: number; idsGeneration: number; idsUploaded: boolean; usedScatter: boolean; viewProjection: Float32Array; bounds: Float32Array; entityIds: Uint32Array; renderMeta: Uint32Array; texIndices: Uint32Array }
  export interface TransparentSortReadback { frame: SortProbeSource; n: number; raw: number; limit: number; overflow: boolean; diag: Uint32Array; gathered: { lo: Uint32Array; hi: Uint32Array; vals: Uint32Array }; digitBase: Uint32Array; order: Uint32Array }
  export type { SortReadbackTarget };  // re-export: defined by Task 15 in ./passes/transparent-sort-pass
  export class TransparentSortProbe {
    constructor(device: GPUDevice);
    get hasPending(): boolean;                                  // new: the renderer wraps only these frames in error scopes
    request(): Promise<TransparentSortReadback>;
    take(stamp: number): SortReadbackTarget | null;
    finish(source: SortProbeSource | null, frameErrors: Promise<string[]> | null): void;
    failFrame(err: Error): void;
    destroy(): void;
  }
  // ts/src/renderer.ts
  interface Renderer { readonly sortProbe: TransparentSortProbe | null }
  // ts/src/hyperion.ts, engine.debug
  readTransparentSort(): Promise<TransparentSortReadback>;
  ```
- **Contratto dello staging**, che il pass del Task 15 deve rispettare. Ogni buffer del target riflette la sua sorgente dall'offset 0, e il pass ci copia `SORT_READBACK_BYTES.<buffer>` byte, esattamente la dimensione che `take()` alloca. La tabella è documentazione: la fonte unica delle dimensioni è `SORT_READBACK_BYTES`.

  | Buffer del target | Sorgente | Dimensione |
  |---|---|---|
  | `gatherKeys` | `sort-keys-a` intero | 2·CAP·4 = 800 000 B (lo alla parola 0, hi alla parola CAP) |
  | `gatherVals` | `sort-vals-a` intero | CAP·4 |
  | `header` | `transparent-args` | 64 B |
  | `hist` | le parole [0, TILES_OFFSET) di `sort-hist` | 7232 B (diag + `digitBase`) |
  | `order` | `transparent-order` intero | CAP·4 |

- [ ] **Step 1: Scrivi il test del probe (deve fallire)**

Crea `ts/src/render/transparent-sort-probe.test.ts`. Il device finto ha buffer veri, in memoria, che il test riempie come farebbe la GPU. Tutto il resto (moduli, layout, pipeline, bind group) è un `Proxy` inerte, così il blocco finale può eseguire il vero `TransparentSortPass` del Task 15 senza dipendere dai suoi dettagli interni.

```ts
import { describe, it, expect, vi, beforeAll, afterEach, type Mock } from 'vitest';
import { TransparentSortProbe, type SortProbeSource } from './transparent-sort-probe';
import { TransparentSortPass, SORT_READBACK_BYTES, type SortReadbackTarget } from './passes/transparent-sort-pass';
import { ResourcePool } from './resource-pool';
import { nextFrameStamp } from './frame-inputs';
import type { FrameState } from './render-pass';
import {
  CAP, HEADER_BYTES, TILE, TILES_OFFSET, DIGIT_BASE_OFFSET, DIAG_WORDS, PASSES, RADIX,
  H_DRAW, H_DISPATCH, H_RAW, H_LIMIT, H_OVERFLOW, H_STAMP, STAMP_SENTINEL,
} from './passes/transparent-sort-constants';

// WebGPU bitflag globals for Node/vitest, as in debug-probe.test.ts.
beforeAll(() => {
  if (typeof globalThis.GPUBufferUsage === 'undefined') {
    (globalThis as any).GPUBufferUsage = {
      MAP_READ: 0x0001, MAP_WRITE: 0x0002,
      COPY_SRC: 0x0004, COPY_DST: 0x0008,
      INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040,
      STORAGE: 0x0080, INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
    };
  }
  if (typeof globalThis.GPUMapMode === 'undefined') {
    (globalThis as any).GPUMapMode = { READ: 0x0001, WRITE: 0x0002 };
  }
  if (typeof globalThis.GPUShaderStage === 'undefined') {
    (globalThis as any).GPUShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
  }
});

interface FakeBuffer {
  size: number;
  usage: number;
  label?: string;
  data: ArrayBuffer;
  destroyed: boolean;
  mapAsync: Mock;
  getMappedRange: () => ArrayBuffer;
  unmap: Mock;
  destroy: () => void;
}

const STAGING = ['gatherKeys', 'gatherVals', 'header', 'hist', 'order'] as const;

/** Anything the pass asks the device for besides buffers (modules, layouts, pipelines, bind groups): inert. */
function opaque(): any {
  return new Proxy(function () {}, {
    get: (_t, key) => (key === 'then' ? undefined : opaque()),
    apply: () => opaque(),
  });
}

/** Buffers are real memory the test fills as the GPU would; everything else is inert. */
function mockDevice() {
  const buffers: FakeBuffer[] = [];
  const base = {
    createBuffer: (d: GPUBufferDescriptor): FakeBuffer => {
      const b: FakeBuffer = {
        size: d.size, usage: d.usage, label: d.label, data: new ArrayBuffer(d.size), destroyed: false,
        mapAsync: vi.fn(async () => {}),
        getMappedRange: () => b.data,
        unmap: vi.fn(),
        destroy: () => { b.destroyed = true; },
      };
      buffers.push(b);
      return b;
    },
    queue: { writeBuffer: vi.fn(), submit: vi.fn() },
  };
  const device = new Proxy(base, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : key === 'then' ? undefined : () => opaque()),
  }) as unknown as GPUDevice;
  return { device, buffers };
}

const fake = (b: GPUBuffer): FakeBuffer => b as unknown as FakeBuffer;
const words = (b: GPUBuffer): Uint32Array => new Uint32Array(fake(b).data);

interface GpuResult {
  stamp: number;
  n: number;
  raw?: number;
  limit?: number;
  overflow?: boolean;
  lo?: number[];
  hi?: number[];
  vals?: number[];
  order?: number[];
  /** [index into the PASSES × RADIX rows, value] */
  digitBase?: Array<[number, number]>;
  diag?: number[];
}

/** What the copies of a served frame leave in its staging buffers, with garbage past n the answer must not show. */
function writeGpu(t: SortReadbackTarget, g: GpuResult): void {
  const header = words(t.header);
  header.fill(0);
  header.set([6, g.n, 0, 0, 0], H_DRAW);
  header.set([Math.ceil(g.n / TILE), 1, 1], H_DISPATCH);
  header[H_RAW] = g.raw ?? g.n;
  header[H_LIMIT] = g.limit ?? g.n;
  header[H_OVERFLOW] = g.overflow ? 1 : 0;
  header[H_STAMP] = g.stamp;
  const keys = words(t.gatherKeys);
  keys.fill(0xdead);
  keys.set(g.lo ?? [], 0);
  keys.set(g.hi ?? [], CAP);
  const vals = words(t.gatherVals);
  vals.fill(0xbeef);
  vals.set(g.vals ?? [], 0);
  const hist = words(t.hist);
  hist.set(g.diag ?? [], 0);
  for (const [i, v] of g.digitBase ?? []) hist[DIGIT_BASE_OFFSET + i] = v;
  const order = words(t.order);
  order.fill(77);
  order.set(g.order ?? [], 0);
}

/** A three-row frame; row 3 is stale data past entityCount, which the snapshot must drop. */
function makeSource(stamp: number): SortProbeSource {
  return {
    tickCount: 42, stamp, entityCount: 3, transparentCount: 3, idsGeneration: 9, idsUploaded: true, usedScatter: true,
    viewProjection: Float32Array.from({ length: 16 }, (_, i) => i),
    bounds: new Float32Array([0, 0, 0, 1, 1, 1, -1, 1, 2, 2, -2, 1, 9, 9, 9, 9]),
    entityIds: new Uint32Array([10, 11, 12, 99]),
    renderMeta: new Uint32Array([0, 0x100, 0, 0x101, 0, 0x104, 0, 0]),
    texIndices: new Uint32Array([0, 0, 1 << 16, 0]),
  };
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('TransparentSortProbe', () => {
  it('take() hands the head request fresh MAP_READ | COPY_DST buffers, sized for what the pass copies', () => {
    const { device, buffers } = mockDevice();
    const probe = new TransparentSortProbe(device);
    expect(probe.take(1)).toBeNull(); // nothing queued: nothing allocated
    expect(buffers).toHaveLength(0);
    void probe.request();
    void probe.request();
    expect(probe.hasPending).toBe(true);
    const t = probe.take(1)!;
    expect(t.stamp).toBe(1);
    // The literal sizes check them independently of the pass; SORT_READBACK_BYTES is what the pass copies.
    const sizes = { gatherKeys: 2 * CAP * 4, gatherVals: CAP * 4, header: HEADER_BYTES, hist: TILES_OFFSET * 4, order: CAP * 4 };
    for (const key of STAGING) {
      expect(fake(t[key]).size, key).toBe(sizes[key]);
      expect(fake(t[key]).size, key).toBe(SORT_READBACK_BYTES[key]);
      expect(fake(t[key]).usage, key).toBe(GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    }
    expect(buffers).toHaveLength(5);
    // Nothing is mapped before the frame is submitted.
    for (const b of buffers) expect(b.mapAsync).not.toHaveBeenCalled();
    // One request per frame: the second waits for the next frame.
    expect(probe.take(1)).toBeNull();
    expect(probe.hasPending).toBe(true);
  });

  it('finish() maps after the frame and answers with a snapshot of the frame taken at once, every array cut to n', async () => {
    const { device, buffers } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const pending = probe.request();
    const t = probe.take(5)!;
    writeGpu(t, {
      stamp: 5, n: 2, raw: 2, limit: 3, lo: [11, 12], hi: [0x80000000, 0x7fffffff], vals: [1, 2], order: [2, 1],
      digitBase: [[3 * RADIX + 5, 1]],
    });
    const source = makeSource(5);
    probe.finish(source, Promise.resolve([]));
    for (const b of buffers) expect(b.mapAsync).toHaveBeenCalledWith(GPUMapMode.READ);
    // The renderer's arrays belong to the next frame from here on.
    source.bounds[0] = 123;
    source.entityIds[0] = 999;
    source.viewProjection[0] = -1;
    const r = await pending;
    expect([r.n, r.raw, r.limit, r.overflow]).toEqual([2, 2, 3, false]);
    expect(Array.from(r.gathered.lo)).toEqual([11, 12]);
    expect(Array.from(r.gathered.hi)).toEqual([0x80000000, 0x7fffffff]);
    expect(Array.from(r.gathered.vals)).toEqual([1, 2]);
    expect(Array.from(r.order)).toEqual([2, 1]);
    expect(r.digitBase).toHaveLength(PASSES * RADIX);
    expect(r.digitBase[3 * RADIX + 5]).toBe(1);
    expect(r.diag).toHaveLength(DIAG_WORDS);
    expect(r.frame).toMatchObject({
      tickCount: 42, stamp: 5, entityCount: 3, transparentCount: 3, idsGeneration: 9, idsUploaded: true, usedScatter: true,
    });
    expect(Array.from(r.frame.bounds)).toEqual([0, 0, 0, 1, 1, 1, -1, 1, 2, 2, -2, 1]);
    expect(Array.from(r.frame.entityIds)).toEqual([10, 11, 12]);
    expect(Array.from(r.frame.renderMeta)).toEqual([0, 0x100, 0, 0x101, 0, 0x104]);
    expect(Array.from(r.frame.texIndices)).toEqual([0, 0, 1 << 16]);
    expect(r.frame.viewProjection[0]).toBe(0);
    for (const b of buffers) {
      expect(b.unmap).toHaveBeenCalled();
      expect(b.destroyed).toBe(true);
    }
  });

  it('two requests issued together read two consecutive frames, each in its own buffers', async () => {
    const { device } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const first = probe.request();
    const second = probe.request();
    let secondSettled = false;
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });

    const t1 = probe.take(1)!;
    writeGpu(t1, { stamp: 1, n: 1, lo: [10], hi: [5], vals: [0], order: [0] });
    probe.finish(makeSource(1), Promise.resolve([]));
    const r1 = await first;
    await settled();
    expect(secondSettled).toBe(false); // still queued, not rejected
    expect(probe.hasPending).toBe(true);

    const t2 = probe.take(nextFrameStamp(1))!;
    for (const key of STAGING) expect(t2[key]).not.toBe(t1[key]);
    writeGpu(t2, { stamp: 2, n: 1, lo: [10], hi: [5], vals: [0], order: [0] });
    probe.finish(makeSource(2), Promise.resolve([]));
    const r2 = await second;
    expect(r2.frame.stamp).toBe(nextFrameStamp(r1.frame.stamp));
  });

  it('a frame whose sort did not run rejects only the head of the queue', async () => {
    const { device } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const a = probe.request();
    const b = probe.request();
    probe.finish(makeSource(1), null); // nothing taken: count 0
    await expect(a).rejects.toThrow(/no transparent entities this frame/);
    expect(probe.hasPending).toBe(true);
    const t = probe.take(2)!;
    writeGpu(t, { stamp: 2, n: 0 });
    probe.finish(makeSource(2), Promise.resolve([]));
    await expect(b).resolves.toMatchObject({ n: 0 });
    probe.finish(makeSource(3), null); // an empty queue: nothing to reject
  });

  it('a frame whose render threw rejects the taken request and every queued one, and frees the taken buffers', async () => {
    const { device, buffers } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const a = probe.request();
    const b = probe.request();
    const t = probe.take(1)!;
    probe.failFrame(new Error('encoder exploded'));
    await expect(a).rejects.toThrow(/encoder exploded/);
    await expect(b).rejects.toThrow(/encoder exploded/);
    expect(probe.hasPending).toBe(false);
    for (const key of STAGING) expect(fake(t[key]).destroyed).toBe(true);
    for (const buf of buffers) expect(buf.mapAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['the copies never ran (header word 11 is 0, fresh staging), even at the first stamp', 1, 0, /copy never ran/],
    ['the gather never ran (header word 11 is still the sentinel)', 5, STAMP_SENTINEL, /gather never ran/],
    ["the header is another frame's", 5, 4, /stamp 4, not this frame's 5/],
  ])('rejects, instead of answering zeros, when %s', async (_what, stamp, word, message) => {
    const { device, buffers } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const pending = probe.request();
    const t = probe.take(stamp)!;
    if (word !== 0) writeGpu(t, { stamp: word, n: 1, lo: [1], hi: [1], vals: [0], order: [0] });
    probe.finish(makeSource(stamp), Promise.resolve([]));
    await expect(pending).rejects.toThrow(message);
    for (const b of buffers) expect(b.destroyed).toBe(true);
  });

  it('rejects when the frame failed GPU validation, or when the snapshot is of another frame', async () => {
    const { device } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const invalid = probe.request();
    const t = probe.take(3)!;
    writeGpu(t, { stamp: 3, n: 1, lo: [1], hi: [1], vals: [0], order: [0] });
    probe.finish(makeSource(3), Promise.resolve(['Destroyed buffer used in a submit']));
    await expect(invalid).rejects.toThrow(/GPU validation: Destroyed buffer used in a submit/);

    const mismatched = probe.request();
    probe.take(4);
    probe.finish(makeSource(5), Promise.resolve([]));
    await expect(mismatched).rejects.toThrow(/snapshot has stamp 5, the sort was read at 4/);
  });

  it('destroy() rejects every request: queued, taken, and still mapping', async () => {
    const { device, buffers } = mockDevice();
    const probe = new TransparentSortProbe(device);
    const mapping = probe.request();
    const taken = probe.request();
    const queued = probe.request();
    const t1 = probe.take(1)!;
    for (const key of STAGING) fake(t1[key]).mapAsync.mockImplementation(() => new Promise(() => {}));
    probe.finish(makeSource(1), Promise.resolve([]));
    probe.take(2);
    probe.destroy();
    await expect(mapping).rejects.toThrow(/destroyed/);
    await expect(taken).rejects.toThrow(/destroyed/);
    await expect(queued).rejects.toThrow(/destroyed/);
    for (const b of buffers) expect(b.destroyed).toBe(true);
    await expect(probe.request()).rejects.toThrow(/destroyed/);
    expect(probe.take(3)).toBeNull();
  });

  it('the renderer stamp starts at 1 and wraps past 0xFFFFFFFE to 1 (never 0, never the sentinel)', () => {
    expect(nextFrameStamp(0)).toBe(1);
    expect(nextFrameStamp(1)).toBe(2);
    expect(nextFrameStamp(0xfffffffe)).toBe(1);
  });
});

describe('TransparentSortPass with the probe (fake device)', () => {
  const saved = { gather: TransparentSortPass.GATHER_SOURCE, sort: TransparentSortPass.SORT_SOURCE };
  afterEach(() => {
    TransparentSortPass.GATHER_SOURCE = saved.gather;
    TransparentSortPass.SORT_SOURCE = saved.sort;
  });

  type Call = { method: string; args: unknown[] };

  /** A device, the pool buffers the renderer creates (renderer.ts step 3), a recording encoder, a frame. */
  function rig(transparentCount: number) {
    TransparentSortPass.GATHER_SOURCE = 'gather';
    TransparentSortPass.SORT_SOURCE = 'sort';
    const { device, buffers } = mockDevice();
    const U = GPUBufferUsage;
    const pool = new ResourcePool();
    const add = (name: string, size: number, usage: number): void =>
      pool.setBuffer(name, device.createBuffer({ size, usage, label: name }));
    add('indirect-args', 28 * 5 * 4, U.STORAGE | U.INDIRECT | U.COPY_DST);
    add('visible-indices', 28 * CAP * 4, U.STORAGE);
    add('entity-bounds', CAP * 16, U.STORAGE | U.COPY_DST);
    add('entity-ids', CAP * 4, U.STORAGE | U.COPY_DST | U.COPY_SRC);
    add('transparent-order', CAP * 4, U.STORAGE | U.COPY_SRC);
    add('transparent-args', HEADER_BYTES, U.STORAGE | U.INDIRECT | U.COPY_DST | U.COPY_SRC);
    const calls: Call[] = [];
    const recorder = (): any => new Proxy({}, {
      get: (_t, key) => (key === 'then' ? undefined : (...args: unknown[]) => {
        calls.push({ method: String(key), args });
        return key === 'beginComputePass' ? recorder() : opaque();
      }),
    });
    const frame = { entityCount: transparentCount, transparentCount, frameStamp: 3 } as unknown as FrameState;
    return { device, buffers, pool, calls, encoder: recorder() as GPUCommandEncoder, frame };
  }
  const copies = (calls: Call[]): Call[] => calls.filter((c) => c.method === 'copyBufferToBuffer');
  /** copyBufferToBuffer(src, srcOffset, dst, dstOffset, size), or the (src, dst, size) overload. */
  const destination = (c: Call): FakeBuffer => (typeof c.args[1] === 'number' ? c.args[2] : c.args[1]) as FakeBuffer;
  const isStaging = (b: FakeBuffer): boolean => (b.usage & GPUBufferUsage.MAP_READ) !== 0;

  it('prepare() and execute() never map; the copies of a readback frame land only in the buffers the request owns', () => {
    const { device, buffers, pool, calls, encoder, frame } = rig(10);
    const probe = new TransparentSortProbe(device);
    const take = vi.spyOn(probe, 'take');
    void probe.request();
    const pass = new TransparentSortPass(probe);
    pass.setup(device, pool);
    pass.prepare(device, frame);
    pass.execute(encoder, frame, pool);
    expect(take).toHaveBeenCalledWith(3); // FrameState.frameStamp
    for (const b of buffers) expect(b.mapAsync).not.toHaveBeenCalled();
    const staging = buffers.filter(isStaging);
    expect(staging).toHaveLength(5); // made by take(), for this request
    const targets = new Set(copies(calls).map(destination));
    expect(targets.size).toBe(5);
    for (const b of targets) expect(staging).toContain(b);
    for (const c of copies(calls)) expect(isStaging(c.args[0] as FakeBuffer)).toBe(false);
    expect(probe.hasPending).toBe(false);
    // A pass destroyed by a graph swap leaves the request's buffers alone.
    pass.destroy();
    for (const b of staging) expect(b.destroyed).toBe(false);
  });

  it('a pass built without the probe (the hot-reload probe pass) never touches the requests', () => {
    const { device, buffers, pool, calls, encoder, frame } = rig(10);
    const probe = new TransparentSortProbe(device);
    void probe.request();
    const pass = new TransparentSortPass();
    pass.setup(device, pool);
    pass.prepare(device, frame);
    pass.execute(encoder, frame, pool);
    expect(probe.hasPending).toBe(true);
    expect(buffers.filter(isStaging)).toHaveLength(0);
    expect(copies(calls)).toHaveLength(0);
    pass.destroy();
  });

  it('with no transparent entity the pass takes nothing, and finish() rejects the head only', async () => {
    const { device, pool, encoder, frame } = rig(0);
    const probe = new TransparentSortProbe(device);
    const head = probe.request();
    void probe.request();
    const pass = new TransparentSortPass(probe);
    pass.setup(device, pool);
    pass.prepare(device, frame);
    pass.execute(encoder, frame, pool);
    probe.finish(makeSource(3), Promise.resolve([]));
    await expect(head).rejects.toThrow(/no transparent entities this frame/);
    expect(probe.hasPending).toBe(true);
    pass.destroy();
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx --prefix ts vitest run --root ts src/render/transparent-sort-probe.test.ts`

Atteso: FAIL al caricamento del file, con `Failed to resolve import "./transparent-sort-probe" from "src/render/transparent-sort-probe.test.ts"`: il modulo non esiste ancora (il Task 15 non ne crea uno scheletro), quindi nessun test gira.

- [ ] **Step 3: Scrivi l'implementazione completa del probe**

Crea `ts/src/render/transparent-sort-probe.ts` con:

```ts
// ts/src/render/transparent-sort-probe.ts
//
// Dev-only readback behind `engine.debug.readTransparentSort()` (design
// 2026-09-27 §6.5). The requests live here, in an object the renderer owns, so
// they outlive graph swaps. The live TransparentSortPass takes the head of the
// queue in execute() and encodes its copies into the fresh staging buffers
// take() hands it; right after the graph's submit the renderer calls finish(),
// and only then is anything mapped — a buffer pending a map at submit time
// would invalidate the whole frame. One request per frame, FIFO: N requests
// issued together read N consecutive frames.

import {
  CAP, H_DRAW, H_RAW, H_LIMIT, H_OVERFLOW, H_STAMP, STAMP_SENTINEL,
  DIAG_WORDS, DIGIT_BASE_OFFSET, PASSES, RADIX,
} from './passes/transparent-sort-constants';
// The target and the staging sizes are the pass's (Task 15): one definition,
// so the bytes the pass copies and the bytes take() allocates cannot drift apart.
import { SORT_READBACK_BYTES, type SortReadbackTarget } from './passes/transparent-sort-pass';

export type { SortReadbackTarget };

/** The CPU side of a frame, as the renderer had it right after the graph's submit. */
export interface SortProbeSource {
  tickCount: number;
  /** `FrameState.frameStamp`: what the gather writes into header word 11. */
  stamp: number;
  entityCount: number;
  /** Normalised (`normalizeTransparentCount`): the bound the gather was sized with. */
  transparentCount: number;
  /** Normalised (`normalizeIdsGeneration`): NaN when the state carried none. */
  idsGeneration: number;
  /** The `entity-ids` column was uploaded in this frame. */
  idsUploaded: boolean;
  /** This frame uploaded through the scatter pass (Mode C, few dirty rows). */
  usedScatter: boolean;
  viewProjection: Float32Array;
  bounds: Float32Array;
  entityIds: Uint32Array;
  renderMeta: Uint32Array;
  texIndices: Uint32Array;
}

export interface TransparentSortReadback {
  /** Copied in finish(), before any await: every array holds `entityCount` rows. */
  frame: SortProbeSource;
  /** Elements sorted and drawn: header word 1, min(raw, limit). */
  n: number;
  /** The 12 transparent region counts summed (header word 8). */
  raw: number;
  /** The gather's bound, min(transparentCount, CAP) (header word 9). */
  limit: number;
  /** raw > limit: the CPU count was wrong (header word 10). */
  overflow: boolean;
  /** `sort-hist` diag: word 0 bit 0 = scan sum != n, bit 1 = scatter out of range. */
  diag: Uint32Array;
  /** The gather's output: element i has key (lo = external id, hi = zKey) and value = slot. */
  gathered: { lo: Uint32Array; hi: Uint32Array; vals: Uint32Array };
  /** Every pass's `digitBase`: PASSES rows of RADIX words. */
  digitBase: Uint32Array;
  /** `transparent-order`: the slots, back to front. */
  order: Uint32Array;
}

/** The five staging buffers of a target; `SORT_READBACK_BYTES` sizes each. */
type StagingKey = Exclude<keyof SortReadbackTarget, 'stamp'>;

/** Also the order finish() maps and decodes them in. */
const STAGING_KEYS: readonly StagingKey[] = ['gatherKeys', 'gatherVals', 'header', 'hist', 'order'];

interface Pending {
  resolve: (value: TransparentSortReadback) => void;
  reject: (err: Error) => void;
}

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));
const stagingOf = (target: SortReadbackTarget): GPUBuffer[] => STAGING_KEYS.map((key) => target[key]);

export class TransparentSortProbe {
  private queue: Pending[] = [];
  /** The request the live pass took in the current frame; finish() clears it. */
  private taken: { pending: Pending; target: SortReadbackTarget } | null = null;
  /** Requests whose buffers are being mapped, with those buffers. */
  private readonly mapping = new Map<Pending, GPUBuffer[]>();
  private destroyed = false;

  constructor(private readonly device: GPUDevice) {}

  /** A request is waiting: the renderer then runs the frame inside GPU error scopes. */
  get hasPending(): boolean {
    return this.queue.length > 0;
  }

  /** Reads the sort of the next rendered frame (rejected if that frame's sort does not run). */
  request(): Promise<TransparentSortReadback> {
    if (this.destroyed) return Promise.reject(new Error('TransparentSortProbe destroyed'));
    return new Promise<TransparentSortReadback>((resolve, reject) => this.queue.push({ resolve, reject }));
  }

  /**
   * Called by the live pass in execute(), when it runs the sort: hands the head
   * request fresh staging buffers, owned by the request and not by the pass (a
   * pass destroyed by a graph swap cannot cut a map short). At most one per frame.
   */
  take(stamp: number): SortReadbackTarget | null {
    if (this.destroyed || this.taken || this.queue.length === 0) return null;
    const pending = this.queue.shift()!;
    const make = (key: StagingKey): GPUBuffer => this.device.createBuffer({
      size: SORT_READBACK_BYTES[key],
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      label: `transparent-sort-readback-${key}`,
    });
    const target: SortReadbackTarget = {
      stamp,
      gatherKeys: make('gatherKeys'),
      gatherVals: make('gatherVals'),
      header: make('header'),
      hist: make('hist'),
      order: make('order'),
    };
    this.taken = { pending, target };
    return target;
  }

  /**
   * Called by the renderer right after the graph's submit, every frame. A
   * taken request: snapshot `source` now, then map. Nothing taken while
   * requests wait (the sort did not run): the HEAD is rejected, the others
   * wait for the next frames.
   */
  finish(source: SortProbeSource | null, frameErrors: Promise<string[]> | null): void {
    const taken = this.taken;
    this.taken = null;
    if (!taken) {
      this.queue.shift()?.reject(new Error('no transparent entities this frame: the sort did not run, there is nothing to read'));
      return;
    }
    const { pending, target } = taken;
    const buffers = stagingOf(target);
    const free = (): void => { for (const b of buffers) b.destroy(); };
    if (!source || source.stamp !== target.stamp) {
      free();
      pending.reject(new Error(source
        ? `The frame snapshot has stamp ${source.stamp}, the sort was read at ${target.stamp}`
        : 'No frame snapshot came with the frame that took the readback'));
      return;
    }
    const frame = snapshot(source);
    this.mapping.set(pending, buffers);
    const settle = (fn: () => void): void => {
      this.mapping.delete(pending);
      free();
      fn();
    };
    Promise.all([
      frameErrors ?? Promise.resolve<string[]>([]),
      Promise.all(buffers.map((b) => b.mapAsync(GPUMapMode.READ))),
    ]).then(([errors]) => {
      const words = buffers.map((b) => new Uint32Array(b.getMappedRange().slice(0)));
      for (const b of buffers) b.unmap();
      if (errors.length > 0) {
        throw new Error(`The frame of the transparent-sort readback failed GPU validation: ${errors.join('; ')}`);
      }
      const readback = decode(frame, target.stamp, words);
      settle(() => pending.resolve(readback));
    }).catch((err: unknown) => settle(() => pending.reject(toError(err))));
  }

  /** host.graph.render() threw: the taken request and every queued one are rejected. */
  failFrame(err: Error): void {
    this.rejectAll(new Error(`The frame of the transparent-sort readback threw: ${err.message}`), false);
  }

  destroy(): void {
    this.destroyed = true;
    this.rejectAll(new Error('TransparentSortProbe destroyed before the request was served'), true);
  }

  private rejectAll(err: Error, mappingToo: boolean): void {
    if (this.taken) {
      for (const b of stagingOf(this.taken.target)) b.destroy();
      this.taken.pending.reject(err);
      this.taken = null;
    }
    const queued = this.queue;
    this.queue = [];
    for (const p of queued) p.reject(err);
    if (!mappingToo) return;
    for (const [p, buffers] of this.mapping) {
      for (const b of buffers) b.destroy();
      p.reject(err);
    }
    this.mapping.clear();
  }
}

function snapshot(s: SortProbeSource): SortProbeSource {
  const n = s.entityCount;
  return {
    tickCount: s.tickCount,
    stamp: s.stamp,
    entityCount: n,
    transparentCount: s.transparentCount,
    idsGeneration: s.idsGeneration,
    idsUploaded: s.idsUploaded,
    usedScatter: s.usedScatter,
    viewProjection: s.viewProjection.slice(0, 16),
    bounds: s.bounds.slice(0, n * 4),
    entityIds: s.entityIds.slice(0, n),
    renderMeta: s.renderMeta.slice(0, n * 2),
    texIndices: s.texIndices.slice(0, n),
  };
}

/** Rejects (throws) instead of answering zeros: header word 11 must be this frame's stamp. */
function decode(frame: SortProbeSource, stamp: number, [keys, vals, header, hist, order]: Uint32Array[]): TransparentSortReadback {
  const word = header[H_STAMP];
  if (word === 0) throw new Error('The transparent-sort readback copy never ran: header word 11 is 0, as in fresh staging');
  if (word === STAMP_SENTINEL) throw new Error('The transparent-sort gather never ran this frame: header word 11 is still the sentinel');
  if (word !== stamp) throw new Error(`The transparent-sort header carries stamp ${word}, not this frame's ${stamp}`);
  const n = header[H_DRAW + 1];
  if (n > CAP) throw new Error(`The transparent-sort header says n = ${n}, past the capacity ${CAP}`);
  return {
    frame,
    n,
    raw: header[H_RAW],
    limit: header[H_LIMIT],
    overflow: header[H_OVERFLOW] !== 0,
    diag: hist.slice(0, DIAG_WORDS),
    gathered: { lo: keys.slice(0, n), hi: keys.slice(CAP, CAP + n), vals: vals.slice(0, n) },
    digitBase: hist.slice(DIGIT_BASE_OFFSET, DIGIT_BASE_OFFSET + PASSES * RADIX),
    order: order.slice(0, n),
  };
}
```

Note:
- `free()` gira PRIMA di `resolve`/`reject`: chi fa `await` trova già i buffer distrutti.
- `failFrame` non tocca le richieste in fase di map: appartengono a frame precedenti, che sono andati a buon fine.

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npx --prefix ts vitest run --root ts src/render/transparent-sort-probe.test.ts src/render/passes/transparent-sort-pass.test.ts`

Atteso: PASS. Sono 14 test in `transparent-sort-probe.test.ts` (i 3 casi di `it.each` contano uno per uno), più tutti quelli del Task 15, invariati.

- [ ] **Step 5: Type-check e commit**

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Atteso: nessuna riga.

```bash
git add ts/src/render/transparent-sort-probe.ts ts/src/render/transparent-sort-probe.test.ts
git commit -m "$(cat <<'EOF'
feat(5b): TransparentSortProbe, readback del sort con coda FIFO e staging per richiesta

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Scrivi i test del facade e aggiorna i mock del renderer**

In `ts/src/hyperion.test.ts`, dentro `mockRenderer()`, sotto `debugProbe: null,` (L85), aggiungi:

```ts
    sortProbe: null,
```

Fai la stessa aggiunta in `ts/src/prefab/integration.test.ts`, sotto `debugProbe: null,` (L74).

In `ts/src/hyperion.test.ts`, dentro `describe('debug API', ...)`, subito dopo il test `'probe and readEntityTransforms delegate to the renderer debug probe'` (che finisce a L913), aggiungi:

```ts
  it('readTransparentSort rejects without a main-thread dev renderer (Mode A, headless, production renderer)', async () => {
    const headless = Hyperion.fromParts(defaultConfig(), mockBridge(), null);
    await expect(headless.debug!.readTransparentSort()).rejects.toThrow(/renderer/);
    // A renderer without the sort probe (a production build) answers the same.
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), mockRenderer());
    await expect(engine.debug!.readTransparentSort()).rejects.toThrow(/renderer/);
  });

  it('readTransparentSort rejects while the engine is paused: no frame would serve it', async () => {
    const renderer = mockRenderer();
    const request = vi.fn();
    (renderer as { sortProbe: unknown }).sortProbe = { request };
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), renderer);
    engine.pause();
    await expect(engine.debug!.readTransparentSort()).rejects.toThrow(/paused/);
    expect(request).not.toHaveBeenCalled();
  });

  it('readTransparentSort delegates to the renderer sort probe', async () => {
    const renderer = mockRenderer();
    const readback = { n: 3 };
    (renderer as { sortProbe: unknown }).sortProbe = { request: vi.fn(async () => readback) };
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), renderer);
    expect(await engine.debug!.readTransparentSort()).toBe(readback);
  });
```

- [ ] **Step 7: Esegui i test e verifica che falliscano**

Run: `npx --prefix ts vitest run --root ts src/hyperion.test.ts -t readTransparentSort`

Atteso: FAIL con 3 test falliti, `TypeError: engine.debug.readTransparentSort is not a function` (il metodo non esiste ancora).

- [ ] **Step 8: Collega il probe nel renderer (`ts/src/renderer.ts`)**

(a) **Import.** Subito dopo `import { DebugProbe } from './render/debug-probe';` aggiungi:

```ts
import { TransparentSortProbe } from './render/transparent-sort-probe';
```

(b) **Interfaccia `Renderer`.** Subito dopo `readonly debugProbe: DebugProbe | null;` aggiungi:

```ts
  /**
   * Dev builds only (null otherwise, like `debugProbe`): the requests of
   * `engine.debug.readTransparentSort()`. It outlives graph swaps; the live
   * TransparentSortPass takes one request per frame.
   */
  readonly sortProbe: TransparentSortProbe | null;
```

(c) **Creazione.** Subito dopo `const debugProbe = dev ? new DebugProbe(device, pixelProbeShaderCode) : null;` aggiungi:

```ts
  // Built with the pixel probe, dev only. It must exist before the graph
  // factories below: the scene factory hands it to every TransparentSortPass.
  const sortProbe = debugProbe ? new TransparentSortProbe(device) : null;
```

(d) **Factory `scene`.** La riga scritta dal Task 15:

```ts
    scene: (mode) => [new ScatterPass(), new CullPass(), new TransparentSortPass(), new ForwardPass({ lit: mode.lighting })],
```

diventa:

```ts
    scene: (mode) => [new ScatterPass(), new CullPass(), new TransparentSortPass(sortProbe), new ForwardPass({ lit: mode.lighting })],
```

Lo slot HMR `transparent-gather`/`transparent-sort` resta com'è, con `probe(() => new TransparentSortPass())`: un'istanza usa e getta senza probe non vede mai le richieste.

(e) **L'upload degli id del Task 11 non cambia.** In `render()`, fra l'if/else degli upload e la selection mask, il Task 11 ha già scritto:

```ts
      const idsUpload = uploadEntityIds(device.queue, entityIdsBuffer, state, uploadedIdsGeneration);
      uploadedIdsGeneration = idsUpload.generation;
```

`idsUpload` (`{ generation, uploaded }`) è già nello scope di `render()`, prima di `host.graph.render(...)`: il literal di `finish` dello step (f) lo legge così com'è. Non aggiungere un secondo upload, né un flag `idsUploaded`, né l'import di `normalizeIdsGeneration`: il test di testo del Task 11 in `frame-inputs.test.ts` vuole esattamente una chiamata `uploadEntityIds(`, fra `if (useScatter) {` e `selectionManager.uploadMask(`.

(f) **Il frame del grafo.** Sostituisci la riga

```ts
      host.graph.render(device, frameState, resources);
```

con:

```ts
      // Dev readback (engine.debug.readTransparentSort, design §6.5). On a
      // frame that may serve a request the graph runs inside GPU error scopes:
      // a frame that failed validation rejects the request instead of
      // answering zeros. A throw rejects the taken request and every queued
      // one, then goes on up as before.
      const sortReadback = sortProbe?.hasPending === true;
      let frameErrors: Promise<string[]> | null = null;
      try {
        if (sortReadback) frameErrors = gpuValidation.run(() => host.graph.render(device, frameState, resources));
        else host.graph.render(device, frameState, resources);
      } catch (err) {
        sortProbe?.failFrame(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
      // First thing after the graph's submit, before anything else can throw:
      // maps the buffers of the request the sort took (the snapshot is copied
      // now, before latestRenderState moves on), or rejects the head of the
      // queue when this frame's sort did not run.
      sortProbe?.finish(sortReadback ? {
        tickCount: state.tickCount,
        stamp: frameState.frameStamp,
        entityCount: state.entityCount,
        transparentCount: frameState.transparentCount,
        idsGeneration: idsUpload.generation,
        idsUploaded: idsUpload.uploaded,
        usedScatter: Boolean(useScatter),
        viewProjection: camera.viewProjection,
        bounds: state.bounds,
        entityIds: state.entityIds,
        renderMeta: state.renderMeta,
        texIndices: state.texIndices,
      } : null, frameErrors);
```

(g) **`rendererObj`.** Subito dopo `debugProbe,` aggiungi `sortProbe,`. In `destroy()`, subito dopo `debugProbe?.destroy();`, aggiungi `sortProbe?.destroy();`.

- [ ] **Step 9: Esponi il metodo nel facade (`ts/src/hyperion.ts`)**

Subito dopo `import type { PixelProbeRequest, PixelProbeResult, TransformsProbeResult } from './render/debug-probe';` (L14) aggiungi:

```ts
import type { TransparentSortReadback } from './render/transparent-sort-probe';
```

Nel getter `debug`, subito dopo il metodo `readEntityTransforms()` (chiuso da `},` a L320), aggiungi:

```ts
      /**
       * Reads the transparent sort of the NEXT rendered frame (design
       * 2026-09-27 §6.5): the gathered keys and slots, `digitBase`, the header
       * counts and the sorted order, next to a copy of that frame's CPU rows.
       * Rejects when that frame's sort did not run (no transparent entity), on
       * a GPU error in the frame, and, like `probe`, without the main-thread
       * renderer of a dev build or while paused. N calls read N consecutive
       * frames.
       */
      readTransparentSort(): Promise<TransparentSortReadback> {
        const probe = self.renderer?.sortProbe;
        if (!probe) return Promise.reject(new Error(NO_DEBUG_PROBE));
        if (self.loop.paused) return Promise.reject(new Error(PROBE_PAUSED));
        return probe.request();
      },
```

- [ ] **Step 10: Esegui i test, il type-check e la suite**

Run: `npx --prefix ts vitest run --root ts src/hyperion.test.ts src/prefab/integration.test.ts src/render/transparent-sort-probe.test.ts`
Atteso: PASS, compresi i 3 test nuovi del facade.

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Atteso: nessuna riga. Un errore su `idsUpload` nel literal di `finish` (`Cannot find name 'idsUpload'`) vuol dire che la sostituzione di `host.graph.render(...)` dello step 8(f) non sta nello stesso corpo di `render()`, dopo la riga `const idsUpload = uploadEntityIds(...)` del Task 11, oppure che quella riga è stata rinominata: allinea il literal a quel nome, e non riscrivere né spostare l'upload (il test di testo del Task 11 ne fissa la posizione e vuole una sola chiamata).

Run: `npm --prefix ts test`
Atteso: tutta la suite verde.

- [ ] **Step 11: Commit**

```bash
git add ts/src/renderer.ts ts/src/hyperion.ts ts/src/hyperion.test.ts ts/src/prefab/integration.test.ts
git commit -m "$(cat <<'EOF'
feat(5b): engine.debug.readTransparentSort() e cablaggio del probe nel renderer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Task 17: verificatore della readback + PNG di test + check nell'harness (2D Twins)

Questo task fa tre cose:
- **Verificatore.** Implementa i controlli (a)-(f) e (i) di §7.3.3 su una risposta di `readTransparentSort()`, e (g) come confronto fra due risposte. Si prova con readback SINTETICHE, costruite nel test da un modello scritto a parte (chiavi, ordine e `digitBase` non usano il modulo sotto test).
- **PNG.** Aggiunge il PNG 128×128 committato che porta gli sprite nelle regioni dispari del gather.
- **Harness.** Aggiunge al tab 2D Twins la scena del sort (x = 80, lontana dai gemelli e dalla scena della depth) con due check:
  - 'Transparent sort matches the oracle': in tutti i modi con un renderer;
  - 'Transparent sort under churn': solo nel Mode C, in skip altrove con il motivo.

**Files:**
- Create: `ts/src/demo/transparent-sort-checks.ts`
- Create: `ts/src/demo/transparent-sort-checks.test.ts`
- Create: `scripts/gen-sort-test-png.mjs`
- Create (generato dallo script, committato): `ts/public/textures/sort-test-128.png`
- Modify: `ts/src/demo/probe-checks.ts`:
  - L8-10: import;
  - L12-15: tipi;
  - L25: regex `UNAVAILABLE`;
  - L35-70: `pixelCheck`.
- Modify: `ts/src/demo/probe-checks.test.ts`: in fondo al file
- Modify: `ts/src/demo/twin-2d.ts`:
  - L1-9: commento di testa;
  - L10-14: import;
  - dopo `checkDepth` (L117): costanti e `checkTransparentSort`;
  - L257-259: chiamata in `setup`.

**Interfaces:**
- Consuma:
  - da `ts/src/render/passes/transparent-sort-reference.ts` (Task 13):
    - `sortableZBits(bits: number): number`;
    - `digitOf(lo: number, hi: number, pass: number): number`;
    - `oracleOrder(vals: Uint32Array, lo: Uint32Array, hi: Uint32Array, n: number): Uint32Array`. `lo[i]`/`hi[i]` sono le chiavi di `vals[i]`; restituisce i `vals` ordinati;
  - da `transparent-sort-constants.ts` (Task 13): `CAP`, `PASSES`, `RADIX`, `DIAG_WORDS`;
  - `TransparentSortReadback` e `engine.debug.readTransparentSort()` (Task 16);
  - `nextFrameStamp` (Task 10);
  - `orthographic`, `extractFrustumPlanes` e `isSphereInFrustum` (`ts/src/camera.ts`);
  - `pixelCheck`, `fitView`, `frames` e `PROBE_TIMEOUT_MS` (`probe-checks.ts`);
  - `engine.loadTexture(url): Promise<TextureHandle>`.
- Produce:
  ```ts
  // ts/src/demo/transparent-sort-checks.ts
  export function regionClass(meta1: number, texIndex: number): number;           // min(meta1 & 0xFF, 6) * 2 + (tier > 0 || overflow)
  export function verifySortReadback(r: TransparentSortReadback, opts?: { exactSet?: boolean; requireAllRegions?: boolean }): string[];
  export function sameIdOrder(a: TransparentSortReadback, b: TransparentSortReadback): boolean;
  export function readSortFrame(read: () => Promise<TransparentSortReadback>, accept: (r: TransparentSortReadback) => boolean,
                                timeoutMs: number, now?: () => number): Promise<TransparentSortReadback>;   // new
  // ts/src/demo/probe-checks.ts
  export type ReadSort = () => Promise<TransparentSortReadback>;                    // new
  export async function pixelCheck(reporter, name, engine,
    check: (probe: Probe, readTransforms: ReadTransforms, readSort: ReadSort) => Promise<{ ok: boolean; detail: string }>): Promise<void>;
  ```
  - I nomi dei check sono 'Transparent sort matches the oracle' e 'Transparent sort under churn'.
  - Semantica di `exactSet`: ogni riga trasparente di tipo 0-5 che supera il test a raggio ALLARGATO (`r·1.01 + 1e-3`) deve essere raccolta. Per le scene dedicate, dove niente sta vicino al bordo, (b) e (c) si fondono in un'uguaglianza. Senza `exactSet`, (c) usa il raggio RIDOTTO (`r·0.99 − 1e-3`).

- [ ] **Step 1: Scrivi i test del verificatore (devono fallire)**

Crea `ts/src/demo/transparent-sort-checks.test.ts`. `makeReadback` costruisce la risposta che darebbe una GPU corretta, calcolando da sé chiavi, ordine e `digitBase`: nessuna di queste viene dal modulo sotto test. Ogni corruzione produce il suo messaggio specifico.

```ts
import { describe, it, expect, vi } from 'vitest';
import { verifySortReadback, regionClass, sameIdOrder, readSortFrame } from './transparent-sort-checks';
import type { TransparentSortReadback } from '../render/transparent-sort-probe';
import { orthographic, extractFrustumPlanes, isSphereInFrustum } from '../camera';
import { CAP, PASSES, RADIX, DIAG_WORDS } from '../render/passes/transparent-sort-constants';

/** Looking down -Z at [-10, 10] x [-10, 10]; z from -1000 to 1 is in view. */
const VP = orthographic(-10, 10, -10, 10, -1, 1000);
const TIER1 = 1 << 16;
const OVERFLOW = 0x80000000;

interface Row { id: number; x: number; y: number; z: number; r: number; type: number; transparent: boolean; tex: number }

/**
 * Slot = index. Every type 0-5 on screen, untextured and textured (tier 1 or
 * overflow): all 12 gather regions. Ties at equal z (one at -0, which sorts
 * with +0), ids with bits in every byte, and three rows the sort must leave
 * out: an opaque quad, a transparent Light2D, a transparent quad off screen.
 */
const SCENE: Row[] = [
  ...[0, 1, 2, 3, 4, 5].flatMap((type): Row[] => [
    { id: 10 + type, x: -8 + type * 3, y: 2, z: -0.5 * type, r: 1, type, transparent: true, tex: 0 },
    { id: 0xfffff - type, x: -8 + type * 3, y: -2, z: -1, r: 1, type, transparent: true, tex: type % 2 === 0 ? TIER1 : OVERFLOW },
  ]),
  { id: 0x12345, x: 0, y: 6, z: 0, r: 0.5, type: 0, transparent: true, tex: 0 },
  { id: 0x00345, x: 1, y: 6, z: -0, r: 0.5, type: 0, transparent: true, tex: 0 },
  { id: 0x02345, x: 2, y: 6, z: 0, r: 0.5, type: 4, transparent: true, tex: 0 },
  { id: 500, x: 0, y: 0, z: 0, r: 1, type: 0, transparent: false, tex: 0 },
  { id: 501, x: 0, y: 0, z: 0, r: 3, type: 6, transparent: true, tex: 0 },
  { id: 502, x: 50, y: 0, z: 0, r: 1, type: 0, transparent: true, tex: 0 },
];
const slotOf = (id: number): number => SCENE.findIndex((row) => row.id === id);

/** §5.1 written out again, independently of the module under test: -0 → +0, negatives flipped whole, positives with the top bit set. */
function zKey(z: number): number {
  let bits = new Uint32Array(new Float32Array([z]).buffer)[0];
  if (bits === 0x80000000) bits = 0;
  return (bits & 0x80000000) !== 0 ? ~bits >>> 0 : (bits | 0x80000000) >>> 0;
}

/**
 * The answer a correct GPU gives for `rows`: the gather's set (transparent,
 * type 0-5, sphere in the frustum) region by region, its keys, the order,
 * digitBase — computed here without the module under test. `drop` leaves
 * slots out of the set, `force` puts slots in whatever they are.
 */
function makeReadback(rows: Row[], build: { drop?: number[]; force?: number[]; stamp?: number } = {}): TransparentSortReadback {
  const count = rows.length;
  const bounds = new Float32Array(count * 4);
  const entityIds = new Uint32Array(count);
  const renderMeta = new Uint32Array(count * 2);
  const texIndices = new Uint32Array(count);
  rows.forEach((row, s) => {
    bounds.set([row.x, row.y, row.z, row.r], s * 4);
    entityIds[s] = row.id;
    renderMeta[s * 2 + 1] = row.type | (row.transparent ? 0x100 : 0);
    texIndices[s] = row.tex;
  });
  const planes = extractFrustumPlanes(VP);
  const region = (s: number): number => rows[s].type * 2 + (rows[s].tex !== 0 ? 1 : 0);
  const culled = (s: number): boolean =>
    rows[s].transparent && rows[s].type <= 5 && isSphereInFrustum(planes, rows[s].x, rows[s].y, rows[s].z, rows[s].r);
  const slots = rows
    .map((_, s) => s)
    .filter((s) => (build.force ?? []).includes(s) || (culled(s) && !(build.drop ?? []).includes(s)))
    .sort((a, b) => region(a) - region(b) || a - b);
  const lo = (s: number): number => rows[s].id;
  const hi = (s: number): number => zKey(rows[s].z);
  const order = [...slots].sort((a, b) => hi(a) - hi(b) || lo(a) - lo(b));
  const digitBase = new Uint32Array(PASSES * RADIX);
  for (let p = 0; p < PASSES; p++) {
    const hist = new Array<number>(RADIX).fill(0);
    for (const s of slots) hist[((p < 3 ? lo(s) : hi(s)) >>> (8 * (p < 3 ? p : p - 3))) & 0xff]++;
    let sum = 0;
    for (let d = 0; d < RADIX; d++) {
      digitBase[p * RADIX + d] = sum;
      sum += hist[d];
    }
  }
  const transparentCount = rows.filter((row) => row.transparent).length;
  return {
    frame: {
      tickCount: 1, stamp: build.stamp ?? 7, entityCount: count, transparentCount,
      idsGeneration: 1, idsUploaded: true, usedScatter: false,
      viewProjection: VP, bounds, entityIds, renderMeta, texIndices,
    },
    n: slots.length,
    raw: slots.length,
    limit: Math.min(transparentCount, CAP),
    overflow: false,
    diag: new Uint32Array(DIAG_WORDS),
    gathered: { lo: Uint32Array.from(slots, lo), hi: Uint32Array.from(slots, hi), vals: Uint32Array.from(slots) },
    digitBase,
    order: Uint32Array.from(order),
  };
}

describe('verifySortReadback', () => {
  it('passes a correct answer, as an exact set with all 12 regions', () => {
    const r = makeReadback(SCENE);
    expect(r.n).toBe(15);
    expect(verifySortReadback(r, { exactSet: true, requireAllRegions: true })).toEqual([]);
  });

  it('reports a malformed answer instead of reading past its arrays', () => {
    const r = makeReadback(SCENE);
    r.gathered.vals = r.gathered.vals.slice(1);
    expect(verifySortReadback(r)).toEqual([expect.stringMatching(/^readback shape: n 15, lo 15, hi 15, vals 14/)]);
  });

  it('(a) a slot gathered twice, and an order that is not a permutation', () => {
    const r = makeReadback(SCENE);
    r.gathered.vals[1] = r.gathered.vals[0];
    r.gathered.lo[1] = r.gathered.lo[0];
    r.gathered.hi[1] = r.gathered.hi[0];
    const failures = verifySortReadback(r);
    expect(failures).toContainEqual(expect.stringMatching(/^\(a\) gathered set: slot \d+ gathered twice/));
    expect(failures).toContainEqual('(a) order is not a permutation of the gathered slots');
  });

  it('(a) slots that are no transparent primitive of type 0-5: an opaque quad, a transparent Light2D', () => {
    const failures = verifySortReadback(makeReadback(SCENE, { force: [slotOf(500), slotOf(501)] }));
    expect(failures).toEqual([expect.stringMatching(
      /^\(a\) gathered set: slot 15 is not a transparent primitive of type 0-5 \(meta1 0x0\); slot 16 is not a transparent primitive of type 0-5 \(meta1 0x106\)$/,
    )]);
  });

  it('(b) a gathered slot outside the enlarged frustum', () => {
    const failures = verifySortReadback(makeReadback(SCENE, { force: [slotOf(502)] }));
    expect(failures).toEqual(['(b) gathered but outside the enlarged frustum: slot 17 (id 502)']);
  });

  it('(c) an on-screen transparent row the gather left out', () => {
    const failures = verifySortReadback(makeReadback(SCENE, { drop: [3] }));
    expect(failures).toEqual([`(c) on screen (reduced frustum) but not gathered: slot 3 (id ${0xfffff - 1})`]);
  });

  it('(c) as an exact set, a row inside the margin must be gathered too', () => {
    // r = 1 at x = 11.005: out of the true test (distance -1.005 < -1), in the
    // enlarged one (-1.011), out of the reduced one (-0.989).
    const rows: Row[] = [...SCENE, { id: 600, x: 11.005, y: 0, z: 0, r: 1, type: 0, transparent: true, tex: 0 }];
    const r = makeReadback(rows);
    expect(verifySortReadback(r)).toEqual([]);
    expect(verifySortReadback(r, { exactSet: true })).toEqual([
      `(c) in view (enlarged frustum, exact set) but not gathered: slot ${SCENE.length} (id 600)`,
    ]);
  });

  it('(d) overflow, n != raw, raw past the count, a wrong limit, a diag bit', () => {
    const r = makeReadback(SCENE);
    r.overflow = true;
    r.raw = r.n + 5;
    r.limit = 3;
    r.diag[0] = 2;
    const failures = verifySortReadback(r);
    expect(failures).toContainEqual('(d) overflow: raw 20 > limit 3');
    expect(failures).toContainEqual('(d) n 15 != raw 20');
    expect(failures).toContainEqual('(d) raw 20 > transparentCount 17');
    expect(failures).toContainEqual('(d) limit 3 != min(transparentCount, CAP) 17');
    expect(failures).toContainEqual('(d) diag: diag[0] = 0x2');
  });

  it('(e) a stale id and a wrong z key, element by element', () => {
    const r = makeReadback(SCENE);
    r.gathered.lo[0] ^= 1;
    r.gathered.hi[2] ^= 1;
    expect(verifySortReadback(r)).toEqual([expect.stringMatching(
      /^\(e\) keys: lo\[0\] = \d+, slot \d+ has id \d+; hi\[2\] = 0x[0-9a-f]+, slot \d+ has zKey 0x[0-9a-f]+$/,
    )]);
  });

  it('(f) an order that is not the oracle', () => {
    const r = makeReadback(SCENE);
    [r.order[0], r.order[1]] = [r.order[1], r.order[0]];
    expect(verifySortReadback(r)).toEqual([expect.stringMatching(/^\(f\) order differs from the oracle at 0: /)]);
  });

  it('(f) a digitBase row that is not the exclusive scan of its digit', () => {
    const r = makeReadback(SCENE);
    r.digitBase[3 * RADIX + 200] += 1;
    expect(verifySortReadback(r)).toEqual([expect.stringMatching(/^\(f\) digitBase of pass 3, digit 200: /)]);
  });

  it('(i) an empty region class', () => {
    const rows = SCENE.filter((row) => !(row.type === 3 && row.tex !== 0));
    expect(verifySortReadback(makeReadback(rows), { exactSet: true, requireAllRegions: true }))
      .toEqual(['(i) empty region classes: type 3 textured']);
  });

  it('the tie at equal z goes to the higher id, and -0 ties with +0', () => {
    const r = makeReadback(SCENE);
    const ids = Array.from(r.order, (s) => r.frame.entityIds[s]);
    expect(ids.indexOf(0x00345)).toBeLessThan(ids.indexOf(0x02345));
    expect(ids.indexOf(0x02345)).toBeLessThan(ids.indexOf(0x12345));
  });
});

describe('regionClass', () => {
  it('is type × 2 + (tier > 0 or overflow), with the cull clamp to Light2D', () => {
    expect(regionClass(0x100 | 3, 0)).toBe(6);
    expect(regionClass(0x100 | 3, TIER1 | 5)).toBe(7);
    expect(regionClass(5, OVERFLOW)).toBe(11);
    expect(regionClass(0x100, 42)).toBe(0); // layer 42 of tier 0: the tier-0 region
    expect(regionClass(9, 0)).toBe(12); // drawn as Light2D (6), outside the gather
    expect(regionClass(0xabcd0000 | 0x100 | 4, 0)).toBe(8); // light layers and flags above the type byte do not count
  });
});

describe('sameIdOrder', () => {
  it('compares the sequence of external ids, not of slots', () => {
    const a = makeReadback(SCENE);
    expect(sameIdOrder(a, makeReadback([...SCENE].reverse(), { stamp: 8 }))).toBe(true);
    const swapped = makeReadback(SCENE);
    [swapped.order[0], swapped.order[1]] = [swapped.order[1], swapped.order[0]];
    expect(sameIdOrder(a, swapped)).toBe(false);
    expect(sameIdOrder(a, makeReadback(SCENE, { drop: [0] }))).toBe(false);
  });
});

describe('readSortFrame', () => {
  it('retries past frames without transparents and frames that do not hold the scene yet', async () => {
    const early = makeReadback(SCENE.slice(0, 3));
    const good = makeReadback(SCENE);
    const read = vi.fn<() => Promise<TransparentSortReadback>>()
      .mockRejectedValueOnce(new Error('no transparent entities this frame: the sort did not run'))
      .mockResolvedValueOnce(early)
      .mockResolvedValueOnce(good);
    await expect(readSortFrame(read, (r) => r.frame.entityCount === SCENE.length, 3000)).resolves.toBe(good);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('throws any other rejection at once', async () => {
    const read = vi.fn(async (): Promise<TransparentSortReadback> => {
      throw new Error('The transparent-sort gather never ran this frame');
    });
    await expect(readSortFrame(read, () => true, 3000)).rejects.toThrow(/gather never ran/);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('gives up after the timeout, saying what it saw last', async () => {
    let t = 0;
    const read = vi.fn(async (): Promise<TransparentSortReadback> => {
      throw new Error('no transparent entities this frame');
    });
    await expect(readSortFrame(read, () => true, 100, () => (t += 30)))
      .rejects.toThrow(/no served frame held the scene within 100 ms \(last: no transparent entities this frame\)/);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx --prefix ts vitest run --root ts src/demo/transparent-sort-checks.test.ts`

Atteso: FAIL, `Failed to resolve import "./transparent-sort-checks"`: il modulo non esiste ancora.

- [ ] **Step 3: Implementa il verificatore**

Crea `ts/src/demo/transparent-sort-checks.ts`:

```ts
// ts/src/demo/transparent-sort-checks.ts — the checks on an
// `engine.debug.readTransparentSort()` answer (design 2026-09-27 §7.3.3).
//
// Every check reads the `frame` snapshot of the SAME answer: the CPU rows of
// the frame the GPU sorted, copied before any await. `verifySortReadback`
// covers (a)-(f) and (i); (g) is `sameIdOrder` over two answers read in
// consecutive frames; (h) is the churn scene of the 2D Twins tab.

import { extractFrustumPlanes, isSphereInFrustum } from '../camera';
import { CAP, PASSES, RADIX } from '../render/passes/transparent-sort-constants';
import { sortableZBits, digitOf, oracleOrder } from '../render/passes/transparent-sort-reference';
import type { TransparentSortReadback } from '../render/transparent-sort-probe';

const TRANSPARENT_BIT = 0x100;
/** Box shadow. 6 (Light2D), and every type the cull clamps to it, stays with LightAccumStage. */
const LAST_SORTED_TYPE = 5;
const LIGHT2D = 6;
const REGION_CLASSES = 12;
/** deriveLightGroups' conservative sphere test (light-groups.ts): every entity the GPU draws passes it. */
const ENLARGED = { scale: 1.01, add: 1e-3 };
/** The other side of the margin: every entity that passes it is certainly drawn. */
const REDUCED = { scale: 0.99, add: -1e-3 };
/** Offenders spelled out per failure; the rest are counted. */
const LISTED = 3;

/** The gather region of a row, 0-11 for types 0-5: type × 2 + (tier > 0 or overflow), as cull.wgsl files it. */
export function regionClass(meta1: number, texIndex: number): number {
  const type = Math.min(meta1 & 0xff, LIGHT2D);
  const tier = (texIndex >>> 16) & 7;
  const overflow = texIndex >>> 31;
  return type * 2 + (tier > 0 || overflow !== 0 ? 1 : 0);
}

/**
 * The failures of one answer, empty when it passes. `exactSet`: every
 * transparent row of type 0-5 inside the ENLARGED frustum must be gathered —
 * for scenes with nothing near the edge of the view. `requireAllRegions`:
 * all 12 (type, textured) classes must be non-empty.
 */
export function verifySortReadback(
  r: TransparentSortReadback,
  opts: { exactSet?: boolean; requireAllRegions?: boolean } = {},
): string[] {
  const { frame, n } = r;
  const { lo, hi, vals } = r.gathered;
  if (lo.length !== n || hi.length !== n || vals.length !== n || r.order.length !== n || r.digitBase.length !== PASSES * RADIX) {
    return [`readback shape: n ${n}, lo ${lo.length}, hi ${hi.length}, vals ${vals.length}, order ${r.order.length}, `
      + `digitBase ${r.digitBase.length} (want ${PASSES * RADIX})`];
  }
  const count = frame.entityCount;
  const failures: string[] = [];
  const report = (label: string, offenders: string[]): void => {
    if (offenders.length === 0) return;
    const more = offenders.length > LISTED ? ` (+${offenders.length - LISTED} more)` : '';
    failures.push(`${label}: ${offenders.slice(0, LISTED).join('; ')}${more}`);
  };
  const meta1 = (s: number): number => frame.renderMeta[s * 2 + 1];
  const sorted = (s: number): boolean => (meta1(s) & TRANSPARENT_BIT) !== 0 && (meta1(s) & 0xff) <= LAST_SORTED_TYPE;
  const planes = extractFrustumPlanes(frame.viewProjection);
  const b = frame.bounds;
  const inView = (s: number, margin: { scale: number; add: number }): boolean =>
    isSphereInFrustum(planes, b[s * 4], b[s * 4 + 1], b[s * 4 + 2], b[s * 4 + 3] * margin.scale + margin.add);
  const who = (s: number): string => `slot ${s} (id ${frame.entityIds[s]})`;

  // (a) The gathered set: unique slots of transparent primitives 0-5, and `order` a permutation of it.
  const gathered = new Set<number>();
  const badSet: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = vals[i];
    if (gathered.has(s)) badSet.push(`slot ${s} gathered twice`);
    gathered.add(s);
    if (s >= count) badSet.push(`slot ${s} is past entityCount ${count}`);
    else if (!sorted(s)) badSet.push(`slot ${s} is not a transparent primitive of type 0-5 (meta1 0x${meta1(s).toString(16)})`);
  }
  report('(a) gathered set', badSet);
  const orderSlots = Array.from(r.order).sort((x, y) => x - y);
  const valSlots = Array.from(vals).sort((x, y) => x - y);
  if (orderSlots.some((s, i) => s !== valSlots[i])) failures.push('(a) order is not a permutation of the gathered slots');

  // (b) Superset: nothing gathered that the GPU cull could not have kept.
  const outside: string[] = [];
  for (const s of gathered) if (s < count && !inView(s, ENLARGED)) outside.push(who(s));
  report('(b) gathered but outside the enlarged frustum', outside);

  // (c) Subset: nothing on screen left out. The exact set closes the margin.
  const missing: string[] = [];
  for (let s = 0; s < count; s++) {
    if (!sorted(s) || gathered.has(s)) continue;
    if (inView(s, opts.exactSet ? ENLARGED : REDUCED)) missing.push(who(s));
  }
  report(opts.exactSet
    ? '(c) in view (enlarged frustum, exact set) but not gathered'
    : '(c) on screen (reduced frustum) but not gathered', missing);

  // (d) Counts and the kernels' diagnostics.
  if (r.overflow) failures.push(`(d) overflow: raw ${r.raw} > limit ${r.limit}`);
  if (n !== r.raw) failures.push(`(d) n ${n} != raw ${r.raw}`);
  if (r.raw > frame.transparentCount) failures.push(`(d) raw ${r.raw} > transparentCount ${frame.transparentCount}`);
  const bound = Math.min(frame.transparentCount, CAP);
  if (r.limit !== bound) failures.push(`(d) limit ${r.limit} != min(transparentCount, CAP) ${bound}`);
  report('(d) diag', Array.from(r.diag).flatMap((w, k) => (w !== 0 ? [`diag[${k}] = 0x${w.toString(16)}`] : [])));

  // (e) Keys, element by element, recomputed from the frame: the id column,
  // and the z bits read as integers (no float operation touches them).
  const zBits = new Uint32Array(b.buffer, b.byteOffset, b.length);
  const keyLo = new Uint32Array(n);
  const keyHi = new Uint32Array(n);
  const badKeys: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = vals[i];
    if (s >= count) continue;
    keyLo[i] = frame.entityIds[s];
    keyHi[i] = sortableZBits(zBits[s * 4 + 2]);
    if (lo[i] !== keyLo[i]) badKeys.push(`lo[${i}] = ${lo[i]}, slot ${s} has id ${keyLo[i]}`);
    if (hi[i] !== keyHi[i]) badKeys.push(`hi[${i}] = 0x${hi[i].toString(16)}, slot ${s} has zKey 0x${keyHi[i].toString(16)}`);
  }
  report('(e) keys', badKeys);

  // (f) The order against the oracle on the recomputed keys, and digitBase
  // against the exclusive scan of each pass's digit histogram (order-free).
  const want = oracleOrder(vals, keyLo, keyHi, n);
  for (let i = 0; i < n; i++) {
    if (r.order[i] !== want[i]) {
      failures.push(`(f) order differs from the oracle at ${i}: slot ${r.order[i]}, the oracle has slot ${want[i]}`);
      break;
    }
  }
  for (let p = 0; p < PASSES; p++) {
    const hist = new Uint32Array(RADIX);
    for (let i = 0; i < n; i++) hist[digitOf(keyLo[i], keyHi[i], p)]++;
    let base = 0;
    for (let d = 0; d < RADIX; d++) {
      const got = r.digitBase[p * RADIX + d];
      if (got !== base) {
        failures.push(`(f) digitBase of pass ${p}, digit ${d}: ${got}, the exclusive scan gives ${base}`);
        break;
      }
      base += hist[d];
    }
  }

  // (i) Every gather region walked: the 12 (type, textured) classes all non-empty.
  if (opts.requireAllRegions) {
    const perClass = new Uint32Array(REGION_CLASSES);
    for (const s of gathered) {
      if (s >= count) continue;
      const c = regionClass(meta1(s), frame.texIndices[s]);
      if (c < REGION_CLASSES) perClass[c]++;
    }
    report('(i) empty region classes', Array.from(perClass).flatMap((k, c) =>
      (k === 0 ? [`type ${c >> 1} ${c & 1 ? 'textured' : 'untextured'}`] : [])));
  }
  return failures;
}

/** (g): the same external ids in the same order — slots may differ between the two frames. */
export function sameIdOrder(a: TransparentSortReadback, b: TransparentSortReadback): boolean {
  if (a.n !== b.n) return false;
  for (let i = 0; i < a.n; i++) {
    if (a.frame.entityIds[a.order[i]] !== b.frame.entityIds[b.order[i]]) return false;
  }
  return true;
}

/**
 * Reads answers until one satisfies `accept` (the frame holds the scene):
 * Mode B renders a state a tick behind, and a frame with no transparent
 * entity rejects the request. Any other rejection is thrown at once.
 */
export async function readSortFrame(
  read: () => Promise<TransparentSortReadback>,
  accept: (r: TransparentSortReadback) => boolean,
  timeoutMs: number,
  now: () => number = () => performance.now(),
): Promise<TransparentSortReadback> {
  const deadline = now() + timeoutMs;
  let last = 'no answer yet';
  while (now() < deadline) {
    try {
      const r = await read();
      if (accept(r)) return r;
      last = `frame ${r.frame.stamp} (tick ${r.frame.tickCount}) does not hold the scene`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no transparent entities this frame/.test(msg)) throw err;
      last = msg;
    }
  }
  throw new Error(`no served frame held the scene within ${timeoutMs} ms (last: ${last})`);
}
```

- [ ] **Step 4: Esegui i test e verifica che passino, poi commit**

Run: `npx --prefix ts vitest run --root ts src/demo/transparent-sort-checks.test.ts`
Atteso: PASS, 18 test.

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Atteso: nessuna riga.

```bash
git add ts/src/demo/transparent-sort-checks.ts ts/src/demo/transparent-sort-checks.test.ts
git commit -m "$(cat <<'EOF'
feat(5b): verificatore della readback del sort (controlli a-f, i) e confronto per id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Scrivi il test del PNG (deve fallire)**

In `ts/src/demo/transparent-sort-checks.test.ts`, aggiungi agli import in cima:

```ts
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
```

e in fondo al file:

```ts
describe('sort-test-128.png (scripts/gen-sort-test-png.mjs)', () => {
  it('is a 128 × 128 RGBA PNG with four semi-transparent coloured quadrants', () => {
    const png = readFileSync(new URL('../../public/textures/sort-test-128.png', import.meta.url));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(128); // width
    expect(png.readUInt32BE(20)).toBe(128); // height
    expect(png[24]).toBe(8); // bits per channel
    expect(png[25]).toBe(6); // RGBA
    // The generator writes one IDAT right after IHDR (8 + 25 bytes in).
    const idatLength = png.readUInt32BE(33);
    expect(png.toString('ascii', 37, 41)).toBe('IDAT');
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    const stride = 1 + 128 * 4;
    const px = (x: number, y: number): number[] => [...raw.subarray(y * stride + 1 + x * 4, y * stride + 5 + x * 4)];
    expect(px(10, 10)).toEqual([230, 60, 60, 160]);
    expect(px(100, 10)).toEqual([60, 200, 90, 160]);
    expect(px(10, 100)).toEqual([60, 110, 230, 160]);
    expect(px(100, 100)).toEqual([240, 200, 50, 160]);
  });
});
```

Run: `npx --prefix ts vitest run --root ts src/demo/transparent-sort-checks.test.ts`
Atteso: FAIL solo nel test nuovo, con `ENOENT: no such file or directory ... sort-test-128.png`.

- [ ] **Step 6: Scrivi il generatore, genera il PNG e verifica**

Crea `scripts/gen-sort-test-png.mjs`:

```js
#!/usr/bin/env node
// scripts/gen-sort-test-png.mjs — writes ts/public/textures/sort-test-128.png,
// the texture of the transparent-sort scene in the 2D Twins tab (design
// 2026-09-27 §7.3.3): 128 × 128 RGBA, four semi-transparent coloured
// quadrants. A 128-px image lands in tier 1 (an overflow tier on a BC7/ASTC
// device), so every sprite that uses it fills an odd gather region
// (15 + 2 × type). Node built-ins only; run it from anywhere:
//   node scripts/gen-sort-test-png.mjs
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 128;
/** RGBA of the quadrants: top-left, top-right, bottom-left, bottom-right. */
const QUADRANTS = [
  [230, 60, 60, 160],
  [60, 200, 90, 160],
  [60, 110, 230, 160],
  [240, 200, 50, 160],
];

/** length, type, data, CRC-32 of type + data (PNG spec §5.3). */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(4 + body.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 4 + body.length);
  return out;
}

// Scanlines: filter byte 0 (none), then RGBA per pixel.
const stride = 1 + SIZE * 4;
const raw = Buffer.alloc(SIZE * stride);
for (let y = 0; y < SIZE; y++) {
  raw[y * stride] = 0;
  for (let x = 0; x < SIZE; x++) {
    const quadrant = (y < SIZE / 2 ? 0 : 2) + (x < SIZE / 2 ? 0 : 1);
    raw.set(QUADRANTS[quadrant], y * stride + 1 + x * 4);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); // width
ihdr.writeUInt32BE(SIZE, 4); // height
ihdr[8] = 8; // bits per channel
ihdr[9] = 6; // colour type: RGBA
// bytes 10-12 stay 0: deflate, adaptive filtering, no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'ts', 'public', 'textures', 'sort-test-128.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
```

Run: `node scripts/gen-sort-test-png.mjs && file ts/public/textures/sort-test-128.png`
Atteso: `wrote .../ts/public/textures/sort-test-128.png (420 bytes)` e `PNG image data, 128 x 128, 8-bit/color RGBA, non-interlaced`. `zlib.crc32` c'è da Node 22.2, e il repo richiede Node ^24.

Run: `npx --prefix ts vitest run --root ts src/demo/transparent-sort-checks.test.ts`
Atteso: PASS, 19 test.

```bash
git add scripts/gen-sort-test-png.mjs ts/public/textures/sort-test-128.png ts/src/demo/transparent-sort-checks.test.ts
git commit -m "$(cat <<'EOF'
test(5b): PNG di test 128×128 per le regioni con texture del gather

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Scrivi i test di `readSort` in `pixelCheck` (devono fallire)**

In fondo a `ts/src/demo/probe-checks.test.ts` aggiungi:

```ts
describe('pixelCheck readSort', () => {
  const sortEngine = (readTransparentSort: () => Promise<unknown>): Hyperion =>
    ({ debug: { readTransparentSort } }) as unknown as Hyperion;

  it('skips where the sort readback does not exist, like the pixel probe', async () => {
    const reporter = createTestReporter();
    const engine = sortEngine(() => Promise.reject(new Error('The debug probe needs the main-thread renderer of a dev build')));
    await pixelCheck(reporter, 'sort', engine, async (_probe, _rows, readSort) => {
      await readSort();
      return { ok: true, detail: '' };
    });
    expect(reporter.results()[0].status).toBe('skip');
  });

  it('skips when the renderer went away with the request (the sort probe was destroyed)', async () => {
    const reporter = createTestReporter();
    const engine = sortEngine(() => Promise.reject(new Error('TransparentSortProbe destroyed before the request was served')));
    await pixelCheck(reporter, 'sort', engine, async (_probe, _rows, readSort) => {
      await readSort();
      return { ok: true, detail: '' };
    });
    expect(reporter.results()[0]).toMatchObject({ status: 'skip', detail: expect.stringMatching(/TransparentSortProbe destroyed/) });
  });

  it('fails, with the reason, on any other rejection', async () => {
    const reporter = createTestReporter();
    const engine = sortEngine(() => Promise.reject(new Error('no transparent entities this frame: the sort did not run, there is nothing to read')));
    await pixelCheck(reporter, 'sort', engine, async (_probe, _rows, readSort) => {
      await readSort();
      return { ok: true, detail: '' };
    });
    expect(reporter.results()[0]).toMatchObject({ status: 'fail', detail: expect.stringMatching(/no transparent entities this frame/) });
  });

  it('fails after the timeout when no frame serves the readback', async () => {
    vi.useFakeTimers();
    const reporter = createTestReporter();
    const engine = sortEngine(() => new Promise(() => {}));
    const done = pixelCheck(reporter, 'sort', engine, async (_probe, _rows, readSort) => {
      await readSort();
      return { ok: true, detail: '' };
    });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    await done;
    vi.useRealTimers();
    expect(reporter.results()[0]).toMatchObject({ status: 'fail', detail: expect.stringMatching(/no frame served/) });
  });
});
```

Run: `npx --prefix ts vitest run --root ts src/demo/probe-checks.test.ts`
Atteso: FAIL nei 4 test nuovi. Il terzo argomento della callback è `undefined`, quindi `readSort is not a function`: `pixelCheck` lo registra come `fail` con `probe error: readSort is not a function`, e nessuna delle attese su skip, dettaglio e timeout è soddisfatta.

- [ ] **Step 8: Aggiungi `readSort` a `pixelCheck`**

In `ts/src/demo/probe-checks.ts`:

Dopo `import type { ProbeTarget, TransformsProbeResult } from '../render/debug-probe';` aggiungi:

```ts
import type { TransparentSortReadback } from '../render/transparent-sort-probe';
```

Dopo il tipo `ReadTransforms` (L15) aggiungi:

```ts
/** `engine.debug.readTransparentSort()`, under the same timeout and skip rule as `Probe`. */
export type ReadSort = () => Promise<TransparentSortReadback>;
```

Sostituisci
```ts
const UNAVAILABLE = /main-thread renderer|DebugProbe destroyed/;
```
con
```ts
const UNAVAILABLE = /main-thread renderer|DebugProbe destroyed|TransparentSortProbe destroyed/;
```

Nella firma di `pixelCheck` sostituisci
```ts
  check: (probe: Probe, readTransforms: ReadTransforms) => Promise<{ ok: boolean; detail: string }>,
```
con
```ts
  check: (probe: Probe, readTransforms: ReadTransforms, readSort: ReadSort) => Promise<{ ok: boolean; detail: string }>,
```

Dopo `const readTransforms: ReadTransforms = () => guarded(debug.readEntityTransforms());` aggiungi:
```ts
  const readSort: ReadSort = () => guarded(debug.readTransparentSort());
```

e sostituisci `const { ok, detail } = await check(probe, readTransforms);` con:
```ts
    const { ok, detail } = await check(probe, readTransforms, readSort);
```

Aggiorna anche il JSDoc di `pixelCheck`: "`check` reads pixels with the given probe (or GPU rows with `readTransforms`, the transparent sort with `readSort`) and returns the verdict."

Run: `npx --prefix ts vitest run --root ts src/demo/probe-checks.test.ts`
Atteso: PASS, compresi i 4 test nuovi. I chiamanti che passano callback con meno parametri continuano a compilare.

- [ ] **Step 9: Aggiungi la scena del sort e i due check al tab 2D Twins**

In `ts/src/demo/twin-2d.ts`:

(a) **Commento di testa.** Sostituisci la riga
```ts
// right, orders overlapping 2D sprites by depth (z = -depth).
```
con
```ts
// right, orders overlapping 2D sprites by depth (z = -depth). Further right
// (x = 80) a scene of every primitive type, transparent, untextured and with
// a PNG, reads the transparent sort back (engine.debug.readTransparentSort)
// and checks it against the CPU oracle; in Mode C again under spawn/despawn
// churn, on scatter frames that re-upload the id column.
```

(b) **Import.** Sostituisci il blocco L10-14 con:
```ts
import type { Hyperion } from '../hyperion';
import type { DemoSection, TestReporter } from './types';
import type { EntityHandle } from '../entity-handle';
import type { TextureHandle } from '../types';
import type { TransparentSortReadback } from '../render/transparent-sort-probe';
import { worldToUv } from '../render/debug-probe';
import { nextFrameStamp } from '../render/frame-inputs';
import { pixelCheck, fmt, frames, fitView, PROBE_TIMEOUT_MS, type Rgba } from './probe-checks';
import { verifySortReadback, sameIdOrder, readSortFrame } from './transparent-sort-checks';
```

(c) **Costanti e check.** Subito dopo la chiusura di `checkDepth` (la `}` a L117) e prima di `const section: DemoSection = {`, inserisci:

```ts
/** Centre of the transparent-sort scene: far from the twins (x within ±18) and from the depth scene (x 22-58). */
const SORT_X = 80;
/** Half-width fitView frames around it: the widest sprite ends 7.1 units from the centre. */
const SORT_HALF_WIDTH = 9;
/** 128 × 128 RGBA (scripts/gen-sort-test-png.mjs): tier 1, or an overflow tier on a BC7/ASTC device. */
const SORT_TEXTURE = '/textures/sort-test-128.png';
/** Frames the churn scene spawns and despawns through (design §7.3.3 (h)). */
const CHURN_FRAMES = 60;

/**
 * Each primitive type 0-5, built on a 2D handle. Transparent and untextured
 * it fills the gather's region 14 + 2t; with the PNG, region 15 + 2t. The
 * textured MSDF glyph samples the PNG as an MSDF and the textured gradient
 * takes stop 1's G/B from the index: fine for the gather, never for a pixel check.
 */
const SORT_TYPES: ReadonlyArray<(h: EntityHandle) => EntityHandle> = [
  (h) => h,                                                    // 0 quad
  (h) => h.line(-0.5, 0, 0.5, 0, 0.2),                          // 1 line
  (h) => h.primitive(2),                                        // 2 MSDF glyph
  (h) => h.bezier(0, 0.5, 0.5, 1, 1, 0.5, 0.08),                // 3 quadratic bezier
  (h) => h.gradient(0, 0, [0, 1, 0, 0, 1, 0]),                  // 4 gradient
  (h) => h.boxShadow(0.8, 0.8, 0.1, 0.05, 0.9, 0.5, 0.2, 0.7),   // 5 box shadow
];

/**
 * The transparent sort read back (engine.debug.readTransparentSort) and
 * checked against the CPU oracle: every type, untextured and textured, plus
 * many sprites at one depth; then, in Mode C, the same under churn. No
 * positionImmediate anywhere: a scatter frame never uploads patched bounds.
 * The scene is gone when this returns; the caller restores the camera.
 */
async function checkTransparentSort(engine: Hyperion, reporter: TestReporter): Promise<void> {
  const ORACLE = 'Transparent sort matches the oracle';
  const CHURN = 'Transparent sort under churn';
  let png: TextureHandle;
  try {
    png = await engine.loadTexture(SORT_TEXTURE);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const name of [ORACLE, CHURN]) {
      // Mode A has no renderer on this thread: nothing to read back there.
      if (/no renderer/.test(msg)) reporter.skip(name, `no main-thread renderer: ${msg}`);
      else reporter.check(name, false, `cannot load ${SORT_TEXTURE}: ${msg}`);
    }
    return;
  }

  const scene: EntityHandle[] = [];
  const textured = new Set<number>();
  engine.batch(() => {
    SORT_TYPES.forEach((build, t) => {
      const x = SORT_X + (t - 2.5) * 2.4;
      // Untextured, at depths 0 / 0.5 / 1 twice over: equal z across types.
      scene.push(build(engine.spawn({ mode: '2d' }).position(x, 2).scale(1.5, 1.5).depth((t % 3) * 0.5)).transparent());
      // With the PNG, all at one depth: the id orders them.
      const h = build(engine.spawn({ mode: '2d' }).position(x, -2).scale(1.5, 1.5).depth(0.25)).texture(png).transparent();
      textured.add(h.id);
      scene.push(h);
    });
    // Many sprites at the same z, the common 2D case.
    for (let k = 0; k < 24; k++) {
      scene.push(engine.spawn({ mode: '2d' })
        .position(SORT_X - 4.2 + (k % 8) * 1.2, 5 + Math.floor(k / 8) * 1.1)
        .scale(0.5, 0.5)
        .transparent());
    }
  });
  entities.push(...scene);
  const sceneIds = new Set(scene.map((h) => h.id));
  fitView(engine, SORT_X, 0, SORT_HALF_WIDTH);
  await frames(4);

  /** The frame holds the whole scene: every row present, transparent, the textured ones with their index. */
  const holdsScene = (r: TransparentSortReadback): boolean => {
    let found = 0;
    for (let s = 0; s < r.frame.entityCount; s++) {
      const id = r.frame.entityIds[s];
      if (!sceneIds.has(id)) continue;
      if ((r.frame.renderMeta[s * 2 + 1] & 0x100) === 0) return false;
      if (textured.has(id) && r.frame.texIndices[s] === 0) return false;
      found++;
    }
    return found === sceneIds.size;
  };

  await pixelCheck(reporter, ORACLE, engine, async (_probe, _rows, readSort) => {
    const r = await readSortFrame(readSort, holdsScene, PROBE_TIMEOUT_MS);
    const failures = verifySortReadback(r, { exactSet: true, requireAllRegions: true });
    // (g) Two requests issued together: consecutive frames, the same ids in the same order.
    const [a, b] = await Promise.all([readSort(), readSort()]);
    const consecutive = b.frame.stamp === nextFrameStamp(a.frame.stamp);
    const same = sameIdOrder(a, b);
    return {
      ok: failures.length === 0 && consecutive && same,
      detail: `frame ${r.frame.stamp}: ${r.n} sorted of ${r.frame.transparentCount} transparent rows`
        + (failures.length === 0 ? ', (a)-(f) and (i) hold' : `; ${failures.join(' | ')}`)
        + `; two requests together: stamps ${a.frame.stamp} → ${b.frame.stamp}${consecutive ? '' : ' (NOT consecutive)'}`
        + `, id order ${same ? 'identical' : 'DIFFERENT'}`,
    };
  });

  if (engine.mode !== 'C') {
    reporter.skip(CHURN, `Mode ${engine.mode}: only Mode C uploads through the scatter pass, which this checks (?mode=C)`);
  } else {
    await pixelCheck(reporter, CHURN, engine, async (_probe, _rows, readSort) => {
      // One quad in and the oldest out on every frame: the slot → id mapping
      // changes each frame while few rows are dirty, so Mode C uploads through
      // the scatter pass AND re-uploads the id column. All at depth 0.
      const churn: EntityHandle[] = [];
      let spawned = 0;
      const spawnOne = (): void => {
        const h = engine.spawn({ mode: '2d' })
          .position(SORT_X - 4.2 + (spawned % 8) * 1.2, -5 - (Math.floor(spawned / 8) % 3) * 1.1)
          .scale(0.5, 0.5)
          .transparent();
        spawned++;
        churn.push(h);
        entities.push(h);
      };
      for (let k = 0; k < 24; k++) spawnOne();
      let churned = 0;
      const step = (): void => {
        churn.shift()?.destroy();
        spawnOne();
        churned++;
      };
      engine.addHook('preTick', step);
      const failures: string[] = [];
      let read = 0;
      let scatterAndIds = 0;
      try {
        while (churned < CHURN_FRAMES) {
          const r = await readSort();
          read++;
          if (r.frame.usedScatter && r.frame.idsUploaded) scatterAndIds++;
          for (const msg of verifySortReadback(r)) failures.push(`frame ${r.frame.stamp}: ${msg}`);
        }
      } finally {
        engine.removeHook('preTick', step);
        for (const h of churn) if (h.alive) h.destroy();
      }
      const listed = failures.slice(0, 3).join(' | ') + (failures.length > 3 ? ` (+${failures.length - 3} more)` : '');
      return {
        ok: scatterAndIds > 0 && failures.length === 0,
        detail: `${churned} frames of churn, ${read} read back, ${scatterAndIds} with a scatter upload AND a new id column`
          + (failures.length === 0 ? '; every one passes (a)-(f)' : `; ${listed}`),
      };
    });
  }

  for (const h of scene) if (h.alive) h.destroy();
}
```

(d) **Chiamata in `setup`.** Sostituisci

```ts
    // ── 3. Depth: overlapping 2D sprites in depth order ────────────────
    await checkDepth(engine, reporter);
    fitView(engine, BLOCK_X + GAP / 2, 0, GAP / 2 + CELL * 1.5 + 1.5);
```

con

```ts
    // ── 3. Depth: overlapping 2D sprites in depth order ────────────────
    await checkDepth(engine, reporter);
    // ── 4. The transparent sort, read back (its scene is gone after) ──
    await checkTransparentSort(engine, reporter);
    fitView(engine, BLOCK_X + GAP / 2, 0, GAP / 2 + CELL * 1.5 + 1.5);
```

La scena del sort viene distrutta prima del `fitView` finale, quindi il tab torna nella vista dei gemelli con gli stessi pixel della baseline. La texture caricata resta nel tier 1: gli sprite con indice 0 sono bianchi per costruzione, e non cambiano.

- [ ] **Step 10: Type-check, test del demo, commit**

Run: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`
Atteso: nessuna riga.

Run: `npx --prefix ts vitest run --root ts src/demo`
Atteso: PASS. I due check dell'harness si verificano sulla GPU nel Task 18.

```bash
git add ts/src/demo/probe-checks.ts ts/src/demo/probe-checks.test.ts ts/src/demo/twin-2d.ts
git commit -m "$(cat <<'EOF'
feat(5b): check del sort trasparente nel tab 2D Twins (oracolo, ricambio in Mode C)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

### Task 18: cancello GPU del passo 3

Criterio d'uscita del passo 3 (§8 della spec):
- gather e sort validati da Chrome e da naga, un criterio bloccante;
- i controlli (a)-(h) di §7.3.3 verdi sulla GPU;
- il sort sotto 1 ms a 100 000 trasparenti;
- il `forward` misurato, con il `total`, che è il riferimento del passo 4;
- stati dei tab e insieme C invariati rispetto alla baseline.

Il draw non cambia ancora: tutti i punti di C devono essere identici al bit. Se un controllo fallisce, **fermati** e segui `superpowers:systematic-debugging`: prima un test che fallisce, poi la correzione. Se la soglia di 1 ms non regge, i rimedi di §5.7 sono decisioni di design: riporta i numeri all'utente e aspetta.

**Files:**
- Modify: `ts/src/render/dump-composed-wgsl.test.ts` (del Task 8): un `describe` in fondo che scrive i due kernel
- Create: `docs/plans/assets/2026-09-27-transparent-sort-validate-sort-wgsl.js`, il corpo di `evaluate_script` della validazione Chrome di gather e sort (come quello del Task 8 per i moduli composti)
- Create: `docs/plans/assets/2026-09-27-transparent-sort-step3/naga.txt` e `docs/plans/assets/2026-09-27-transparent-sort-step3/chrome-sort-wgsl.json`, le uscite dei due validatori
- Create: `docs/plans/assets/2026-09-27-transparent-sort-bench-step3.json`, l'uscita del benchmark committato

**Interfaces:**
- Consuma:
  - tutto il passo 3 (Task 13-17);
  - lo script di benchmark `docs/plans/assets/2026-09-27-transparent-sort-bench.js` (Task 2): pagina `http://localhost:5173/?mode=B&bench`, opzioni `window.__benchOpts = { label, sizes?, zModes? }`, JSON `{ …, results: [{ N, zMode: 'same' | 'distinct', …, stages, sort, forward, total, passes }] }`, letto per `(N, zMode)`;
  - la cattura `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js` con la procedura del Task 3 Step 9, e `compare.mjs` (Task 3): `node compare.mjs --base <dir> --run <dir> --mode B|C --step 0|1|2|3|4 [--allow-new-skip '<check>' …]`, uscita 0 PASS, 1 FAIL, 2 input sbagliato; la baseline;
  - il dump guardato da `DUMP_WGSL_DIR` (Task 8);
  - `scripts/validate-wgsl-naga.mjs <dir>` (Task 8): uscita 0 tutti validi, 1 uno non valido, 2 problema d'uso (naga assente, niente file);
  - la skill `/gpu-check`;
  - il server MCP `chrome-devtools-gpu`: ogni chiamata porta il `pageId` (da `list_pages`), ogni `evaluate_script` anche `waitForStableDom: false`.
- Produce: `bench-step3.json`, lo script `validate-sort-wgsl.js` con le uscite dei due validatori, e un `describe` nel test di dump. Nessun codice di produzione.

- [ ] **Step 1: WASM aggiornato**

Run: `find crates/hyperion-core/src crates/hyperion-core/Cargo.toml -newer ts/wasm/hyperion_core_bg.wasm \( -name '*.rs' -o -name Cargo.toml \) | head -3`

Se stampa qualcosa, esegui `npm --prefix ts run build:wasm`. Poi:

Run: `grep -c "engine_gpu_transparent_count\|engine_gpu_entity_ids_generation" ts/wasm/hyperion_core.d.ts`
Atteso: `4`: le due funzioni esportate del Task 9, ciascuna scritta due volte da wasm-bindgen nel d.ts (come `export function` e come voce `readonly` di `InitOutput`), come nel Task 12 Step 1.

- [ ] **Step 2: Validazione headless completa**

Run: `scripts/preflight.sh`
Atteso: tutto verde (matrice delle feature, clippy `-D warnings`, TS, protocollo).

- [ ] **Step 3: Estendi il dump per naga ai due kernel**

In `ts/src/render/dump-composed-wgsl.test.ts`, accanto agli import esistenti, aggiungi:

```ts
import transparentGatherSource from '../shaders/transparent-gather.wgsl?raw';
import transparentSortSource from '../shaders/transparent-sort.wgsl?raw';
```

Il file importa già `mkdirSync` e `writeFileSync` da `node:fs` e `join` da `node:path` (Task 8). Se uno dei tre manca, aggiungilo all'import esistente di quel modulo, senza duplicare la dichiarazione.

In fondo al file aggiungi:

```ts
// Passo 3: the two sort kernels, as the renderer loads them (no preprocessing), for `naga`.
describe.skipIf(!process.env.DUMP_WGSL_DIR)('dump the transparent-sort kernels (naga)', () => {
  it('writes transparent-gather.wgsl and transparent-sort.wgsl', () => {
    const dir = process.env.DUMP_WGSL_DIR!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'transparent-gather.wgsl'), transparentGatherSource);
    writeFileSync(join(dir, 'transparent-sort.wgsl'), transparentSortSource);
    expect(transparentGatherSource).toMatch(/fn gather_main\s*\(/);
    expect(transparentSortSource).toMatch(/fn scatter_main\s*\(/);
  });
});
```

Run: `cargo install --list | grep -E '^naga-cli' || cargo install naga-cli --locked`
Atteso: una riga `naga-cli v<versione>:` con versione ≥ 23 (installato al Task 8 Step 3; la direttiva `diagnostic` dell'uber richiede almeno quella). Con una versione più vecchia aggiorna con `cargo install naga-cli --locked --force`.

Run (lo script del Task 8, non un ciclo a mano: ha il suo codice d'uscita e riconosce un naga assente):
```bash
STEP3=docs/plans/assets/2026-09-27-transparent-sort-step3 && mkdir -p "$STEP3" \
  && D="$(mktemp -d)" \
  && DUMP_WGSL_DIR="$D" npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts \
  && { cargo install --list | grep -E '^naga-cli'; node scripts/validate-wgsl-naga.mjs "$D"; } > "$STEP3/naga.txt" 2>&1; \
echo "exit $?"; cat "$STEP3/naga.txt"
```
Atteso:
- `exit 0`;
- `naga.txt` contiene la riga `naga-cli v…:`, poi `ok` per esattamente questi 9 file: `transparent-gather.wgsl`, `transparent-sort.wgsl`, `type-0-quad.wgsl` … `type-5-box-shadow.wgsl` e `uber.wgsl` (i 7 moduli composti del passo 1 restano `ok`); nessuna riga `FAIL`; infine `9/9 valid (naga)`;
- `exit 1` vuol dire che un modulo o un kernel non è valido: il passo 3 è bloccato (§8 riga 3); fermati e segui `superpowers:systematic-debugging`;
- `exit 2` è un problema d'uso (naga assente, nessun file scritto nel dump), non un passaggio: correggi e rilancia.

Senza la variabile d'ambiente il `describe` resta in skip, quindi `npm --prefix ts test` non cambia.

```bash
git add ts/src/render/dump-composed-wgsl.test.ts docs/plans/assets/2026-09-27-transparent-sort-step3/naga.txt
git commit -m "$(cat <<'EOF'
test(5b): dump di transparent-gather e transparent-sort per la validazione naga

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Server di sviluppo e pagina sull'iGPU AMD (Mode B)**

Segui la skill `/gpu-check` (§2-3):
1. Avvia il server:
   - `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/`;
   - se non risponde `200`, avvialo in background con `npm --prefix ts run dev -- --strictPort --port 5173`;
   - se da quando gira un checkout o un merge ha riscritto uno shader, riavvialo.
2. `list_pages` → `pageId` (se non c'è una pagina, `new_page` con `url: "about:blank"`). Da qui fino alla fine del task: `pageId` su ogni chiamata MCP (`navigate_page`, `resize_page`, `evaluate_script`, `list_console_messages`) e `waitForStableDom: false` su ogni `evaluate_script` (il pannello dei check si ridisegna ogni 500 ms e l'HUD a ogni frame, quindi il DOM non si assesta mai). Gli step 5-9 lo danno per inteso.
3. Carica la pagina con `chrome-devtools-gpu` → `navigate_page`:
   - `type: "url"`, `url: "http://localhost:5173/?mode=B"`, `ignoreCache: true`;
   - `initScript`:
     ```js
     GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)
     ```
4. `resize_page` a `width: 1920, height: 1080`.
5. `list_console_messages` con i tipi `log`/`info`/`warn`: la riga dell'adapter deve dire AMD, non nvidia e non SwiftShader.

- [ ] **Step 5: Validazione Chrome di gather e sort (bloccante)**

Crea `docs/plans/assets/2026-09-27-transparent-sort-validate-sort-wgsl.js`, il corpo di `evaluate_script` per Chrome, committato come quello del Task 8 per i moduli composti:

```js
async () => {
  // Phase 5b, spec §8 row 3 — Chrome half of the WGSL gate for the two sort
  // kernels. Paste this whole file as the `function` of chrome-devtools
  // evaluate_script, on the harness page served by `npm run dev` (Mode B: the
  // renderer, which sets TransparentSortPass.GATHER_SOURCE / SORT_SOURCE,
  // lives on the main thread; the dynamic import resolves to the module
  // instance the app uses, since Vite serves the same URL).
  //
  // It compiles both kernels (getCompilationInfo) and runs a throwaway
  // TransparentSortPass.setup() on a pool of its own inside error scopes,
  // which builds the four compute pipelines (gather, upsweep, scan, scatter)
  // on the pass's explicit layouts.
  //
  // A FRESH adapter and device, never window.__hyperion.renderer.device: the
  // live renderer's frames and graph requests must not interleave with these
  // error scopes (an adapter is consumed by requestDevice, so one
  // requestAdapter per device).
  const { TransparentSortPass } = await import('/src/render/passes/transparent-sort-pass.ts');
  const { ResourcePool } = await import('/src/render/resource-pool.ts');
  const { CAP, HEADER_BYTES } = await import('/src/render/passes/transparent-sort-constants.ts');

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
  const device = await adapter.requestDevice();
  const out = { sources: {}, compilation: {}, setupErrors: [] };
  for (const [name, code] of [
    ['transparent-gather', TransparentSortPass.GATHER_SOURCE],
    ['transparent-sort', TransparentSortPass.SORT_SOURCE],
  ]) {
    out.sources[name] = code ? code.length : 0;
    if (!code) continue;
    const info = await device.createShaderModule({ code, label: `check-${name}` }).getCompilationInfo();
    out.compilation[name] = info.messages.map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`);
  }
  const U = GPUBufferUsage;
  const pool = new ResourcePool();
  const made = [];
  const add = (name, size, usage) => {
    const b = device.createBuffer({ size, usage, label: `check-${name}` });
    made.push(b);
    pool.setBuffer(name, b);
  };
  add('indirect-args', 28 * 5 * 4, U.STORAGE | U.INDIRECT | U.COPY_DST);
  add('visible-indices', 28 * CAP * 4, U.STORAGE);
  add('entity-bounds', CAP * 16, U.STORAGE | U.COPY_DST);
  add('entity-ids', CAP * 4, U.STORAGE | U.COPY_DST);
  add('transparent-order', CAP * 4, U.STORAGE | U.COPY_SRC);
  add('transparent-args', HEADER_BYTES, U.STORAGE | U.INDIRECT | U.COPY_DST | U.COPY_SRC);
  const pass = new TransparentSortPass();
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  let thrown = null;
  try { pass.setup(device, pool); } catch (err) { thrown = String(err); }
  const oom = await device.popErrorScope();
  const validation = await device.popErrorScope();
  pass.destroy();
  for (const b of made) b.destroy();
  if (thrown) out.setupErrors.push(`threw: ${thrown}`);
  if (oom) out.setupErrors.push(`out-of-memory: ${oom.message}`);
  if (validation) out.setupErrors.push(`validation: ${validation.message}`);
  const { vendor, architecture, description } = adapter.info;
  device.destroy();
  const ok = Object.values(out.sources).every((length) => length > 0)
    && Object.values(out.compilation).every((messages) => !messages.some((m) => m.startsWith('error')))
    && out.setupErrors.length === 0;
  return { ok, adapter: { vendor, architecture, description }, ...out };
}
```

Esegui `mcp__chrome-devtools-gpu__evaluate_script` con `pageId`, `waitForStableDom: false`, il contenuto di `docs/plans/assets/2026-09-27-transparent-sort-validate-sort-wgsl.js` alla lettera come `function` e `filePath: "/home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-step3/chrome-sort-wgsl.json"`.

Atteso, in `chrome-sort-wgsl.json`:
- `ok: true`, `adapter.vendor` = `"amd"`;
- `sources` con due lunghezze > 0 (le statiche impostate dal renderer);
- in `compilation`, nessuna voce che comincia con `error`. Le `warning` passano il cancello ma vanno riportate all'utente;
- `setupErrors: []`: le 4 pipeline compute (gather, upsweep, scan, scatter) si creano sui layout espliciti del pass.

Con `ok: false` il passo 3 è bloccato: le righe di `compilation` hanno `riga:colonna` nel kernel, `setupErrors` il messaggio dello scope. Il JSON e lo script si committano con le misure (step 10).

Poi `list_console_messages` con i tipi `error` e `warn`. Nessun messaggio che parli di WebGPU, validation, pipeline o device (il grafo iniziale ha già costruito il sort). È accettabile solo il 404 di `favicon.ico`.

- [ ] **Step 6: I due check nel tab 2D Twins, Mode B**

`evaluate_script`:

```js
async () => {
  const EXPECT = [
    'Twins draw the same pixels', 'GPU rows of 2D entities', 'Depth orders 2D sprites',
    'Transparent sort matches the oracle', 'Transparent sort under churn',
  ];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  [...document.querySelectorAll('.tab')].find((t) => t.textContent.trim().startsWith('2D Twins')).click();
  const read = () => [...document.querySelectorAll('.check-item')].map((item) => ({
    name: item.querySelector('.check-name').textContent,
    status: item.querySelector('.check-icon').className.replace('check-icon', '').trim(),
    detail: item.nextElementSibling?.classList.contains('check-detail') ? item.nextElementSibling.textContent : null,
  }));
  const t0 = performance.now();
  let checks = read();
  while (performance.now() - t0 < 20000) {
    await wait(500);
    checks = read();
    if (EXPECT.every((name) => checks.some((c) => c.name === name && c.status !== 'pending'))) break;
  }
  return {
    mode: window.__hyperion.mode,
    summary: document.getElementById('check-summary')?.textContent ?? null,
    seconds: ((performance.now() - t0) / 1000).toFixed(1),
    checks,
  };
}
```

Atteso in Mode B:
- `summary` = `4/5 passed · 1 skipped`;
- i tre check esistenti in `pass`;
- 'Transparent sort matches the oracle' in `pass`, con un dettaglio della forma `frame S: 36 sorted of 38 transparent rows, (a)-(f) and (i) hold; two requests together: stamps S1 → S1+1, id order identical`. Le 38 righe sono i 36 sprite della scena più i due box shadow dei gemelli, fuori vista e quindi non raccolti;
- 'Transparent sort under churn' in `skip`, con `Mode B: only Mode C uploads through the scatter pass, …`.

Poi `list_console_messages` (`error`/`warn`): nessun errore nuovo.

- [ ] **Step 7: I due check nel tab 2D Twins, Mode C**

1. `navigate_page` con lo stesso `initScript`, `url: "http://localhost:5173/?mode=C"`, `ignoreCache: true`.
2. `resize_page` 1920×1080.
3. Controlla la riga dell'adapter (AMD).
4. Ripeti l'`evaluate_script` dello step 6.

Atteso in Mode C:
- `summary` = `5/5 passed`;
- 'Transparent sort matches the oracle' come nel Mode B;
- 'Transparent sort under churn' in `pass`, con un dettaglio della forma `60 frames of churn, K read back, J with a scatter upload AND a new id column; every one passes (a)-(f)` e J ≥ 1: è il controllo (h);
- 'GPU rows of 2D entities' riporta ancora frame in scatter.

Poi `list_console_messages` (`error`/`warn`): nessun errore nuovo.

- [ ] **Step 8: Benchmark del passo 3**

1. `navigate_page`:
   - `url: "http://localhost:5173/?mode=B&bench"`, lo stesso URL del Task 2;
   - `ignoreCache: true`, stesso `initScript`.
2. `resize_page` 1920×1080, poi `list_console_messages` (`info`/`warn`): la riga dell'adapter (AMD) e la riga `[Hyperion] ?bench: no section opened; window.__hyperion is the engine`.
3. Bash `git rev-parse --short HEAD` → `<SHA>`. Poi `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__benchOpts = { label: 'step3 <SHA>' }; return true; }"` (con lo SHA vero al posto di `<SHA>`).
4. `evaluate_script` con `pageId`, `waitForStableDom: false`:
   - `function`: il contenuto INTEGRALE di `docs/plans/assets/2026-09-27-transparent-sort-bench.js`, identico a quello dei passi 0 e 1;
   - `filePath`: `/home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-bench-step3.json`.

   Se la chiamata va in timeout, non continuare su quella pagina: come nel Task 2 Step 4.4, rinaviga (punto 1), poi tre coppie di chiamate per N = 1000, 10000, 100000 in quest'ordine, `window.__benchOpts = { label: 'step3 <SHA>', sizes: [N] }` e poi lo scenario con lo stesso `filePath`. L'ultimo file contiene tutti e sei i risultati.
5. Riassumi i tre file di benchmark, letti per `(N, zMode)` come li scrive il Task 2:

```bash
node - <<'EOF'
const fs = require('node:fs');
const load = (s) => JSON.parse(fs.readFileSync(`docs/plans/assets/2026-09-27-transparent-sort-bench-step${s}.json`, 'utf8'));
const [j0, j1, j3] = [0, 1, 3].map(load);
console.log(`labels: ${j0.label} | ${j1.label} | ${j3.label}`);
const at = (j, r) => j.results.find((x) => x.N === r.N && x.zMode === r.zMode) ?? {};
const f = (x) => (typeof x === 'number' ? x.toFixed(3) : String(x));
for (const r of j3.results) {
  const a = at(j0, r), b = at(j1, r);
  console.log(`N=${r.N} z=${r.zMode} | sort ${f(r.sort)} | forward ${f(a.forward)} / ${f(b.forward)} / ${f(r.forward)} | total ${f(a.total)} / ${f(b.total)} / ${f(r.total)}`);
}
const bad = [];
if (j3.results.length !== 6) bad.push(`${j3.results.length} results`);
for (const r of j3.results) {
  if (typeof r.sort !== 'number') bad.push(`N=${r.N} z=${r.zMode}: sort ${r.sort} (a transparent-sort stage is missing from the timings)`);
}
for (const z of ['same', 'distinct']) {
  const r = j3.results.find((x) => x.N === 100000 && x.zMode === z);
  // typeof first: `null < 1` is true in JS.
  if (!r) bad.push(`no N=100000 z=${z} result`);
  else if (!(typeof r.sort === 'number' && r.sort < 1)) bad.push(`N=100000 z=${z}: sort ${f(r.sort)} (must be a number < 1 ms)`);
}
if (bad.length) { console.error('BAD: ' + bad.join('; ')); process.exit(1); }
console.log('step 3 bench OK');
EOF
```

Lo script stampa le tre etichette, poi una riga per `(N, zMode)`: il `sort` del passo 3 (somma dei quattro stadi, `results[i].sort`) e il `forward` e il `total` dei passi 0 / 1 / 3. Nei file dei passi 0 e 1 `sort` vale `null` (il pass non esisteva ancora) e lo script non li legge.

Atteso:
- sei righe `N=… z=… | sort … | forward p.0 / p.1 / p.3 | total p.0 / p.1 / p.3`, poi `step 3 bench OK`, exit 0;
- in `bench-step3.json`, per le DUE distribuzioni (`same`, depth tutte a 0, e `distinct`) con N = 100000, **sort < 1.000 ms**. Exit 1 blocca il passo; se la soglia non regge, i rimedi di §5.7 sono decisioni di design: riporta i numeri all'utente e aspetta;
- nessun `sort` `null` al passo 3: un `null` vuol dire che uno stadio `transparent-sort/*` manca dalle timing, cioè che `profileStages` non corrisponde a `mark` (il profiler butta il frame) oppure i nomi differiscono;
- il `forward` E il `total` del passo 3 vanno annotati: sono il riferimento del passo 4. Il profiler separa i pass con compute pass vuoti e parte dei frammenti del forward può cadere nel pass successivo (Task 2 Step 5): i delta del `forward` si leggono insieme a quelli del `total`.

Controlla infine `list_console_messages` (`error`/`warn`).

- [ ] **Step 9: Stati e insieme C contro la baseline (Mode B e Mode C)**

Crea una cartella di corsa FUORI dalla baseline: `mkdir -p <scratchpad>/step3-run`, con il percorso assoluto della scratchpad della sessione (è `DIR` qui sotto). Poi, per ciascun modo M ∈ {B, C}, la procedura del Task 3 Step 9, con una navigazione nuova per modo e con `pageId` su ogni chiamata e `waitForStableDom: false` su ogni `evaluate_script`:
1. `resize_page` con `width: 1920`, `height: 1080`, PRIMA della navigazione.
2. `navigate_page` con `type: "url"`, `url: "http://localhost:5173/?mode=M&bench"` (con la lettera vera al posto di `M`), `ignoreCache: true` e l'`initScript` low-power dello step 4. Senza `&bench`, `capture.js` lancia `capture from a ?bench page` alla prima chiamata.
3. `list_console_messages` con `types: ["info", "warn"]` → la riga dell'adapter `amd` (non nvidia, non SwiftShader) e la riga `[Hyperion] ?bench: no section opened; window.__hyperion is the engine`.
4. Per ogni chiave K, nell'ordine `primitives`, `scene-graph`, `input`, `audio`, `particles`, `rendering-fx`, `lighting`, `debug-tools`, `lifecycle`, `twin-2d`:
   - `evaluate_script` con `function: "() => { window.__captureOpts = { tab: 'K' }; return true; }"` (con la chiave vera al posto di `K`);
   - `evaluate_script` con `function` = il contenuto di `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js` alla lettera e `filePath: "<DIR>/M-K.json"`. Ogni chiamata dura da 2 a 12 s.
5. Stati, nella stessa corsa: `evaluate_script` con `function: "() => { window.__captureOpts = { statuses: true }; return true; }"`, poi `capture.js` alla lettera con `filePath: "<DIR>/statuses-M.json"`.
6. Se una chiamata restituisce un errore, la cattura di quel modo è da buttare: si riparte dal punto 1 (navigazione nuova) e si riscrivono tutti i file di quel modo in `DIR`.

Poi un confronto per modo, dalla radice del repo (con il percorso vero al posto di `<scratchpad>`):

```bash
BASE=docs/plans/assets/2026-09-27-transparent-sort-baseline
node "$BASE/compare.mjs" --base "$BASE" --run <scratchpad>/step3-run --mode B --step 3 --allow-new-skip 'Transparent sort under churn'; echo "exit $?"
node "$BASE/compare.mjs" --base "$BASE" --run <scratchpad>/step3-run --mode C --step 3; echo "exit $?"
```

Atteso, per ciascuno dei due: `exit 0` e `PASS` come ultima riga, con una riga `OK` per ogni tab: Lighting `excluded (Lighting: statuses only)`, ogni altro tab `C=… (grid N/2304)` con N ≥ 1152 (una riga `excluded` su un tab diverso da Lighting, o `… is not bit-exact …`, vuol dire che la camera si è mossa nella finestra: si rifà la cattura); e `B statuses      OK` / `C statuses      OK`. Un `exit 2` è un input sbagliato (una cartella o un file mancante, un'opzione), non un confronto: rileggi l'errore e rifai la cattura o il comando.
- **Pixel:** per ogni modo e ogni tab, 0 punti diversi su C = S_base ∩ S_run \ (M_base ∪ M_run). Al passo 3 il confronto al bit copre TUTTO C, perché i trasparenti usano ancora le pipeline per tipo. Il tab Lighting non contribuisce punti, per costruzione (§7.3.1).
- **Stati dei check della baseline:** ognuno ha lo stesso stato della baseline:
  - nessun check fallito;
  - gli stessi check in skip o pending della baseline, con Input a 2/6 e 4 check d'interazione in pending;
  - ogni check che passava passa ancora;
  - 'Velocity' e 'Backend lit' arrivano a pass come nella baseline.
- **Check nuovi di 2D Twins:** `compare.mjs` vuole in `pass` ogni check che la baseline non ha; l'unica eccezione ammessa è un check nominato da `--allow-new-skip`, che può essere `skip`. Quindi 'Transparent sort matches the oracle' deve passare in B e in C, e 'Transparent sort under churn' deve passare in C ed essere in skip in B (per questo solo il comando del Mode B porta `--allow-new-skip`). Una riga `new check '…' is …` fa FAIL.

Una differenza anche su un solo punto di C blocca il passo e va spiegata prima di andare avanti.

- [ ] **Step 10: Commit delle misure**

```bash
git add docs/plans/assets/2026-09-27-transparent-sort-bench-step3.json \
  docs/plans/assets/2026-09-27-transparent-sort-validate-sort-wgsl.js \
  docs/plans/assets/2026-09-27-transparent-sort-step3/chrome-sort-wgsl.json
git commit -m "$(cat <<'EOF'
test(5b): cancello GPU del passo 3 — naga e Chrome su gather/sort, check (a)-(h) verdi in B e C, bench al passo 3

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Nel messaggio o nel riepilogo per l'utente riporta:
- il sort a 100 000 per le due distribuzioni, e il `forward` e il `total` dei passi 0, 1 e 3;
- l'esito dei due validatori (`naga.txt`, `chrome-sort-wgsl.json`), con le eventuali `warning`;
- `N/M passed` di 2D Twins in B e C;
- l'esito di `compare.mjs` per B e per C;
- cosa NON è coperto: il Mode A (l'initScript non raggiunge i worker) e Safari.

### Task 19: draw uber in `ForwardPass`

Il sub-pass trasparente di `ForwardPass` smette di disegnare per tipo e diventa UN solo `drawIndexedIndirect(transparent-args, 0)` con la pipeline uber (costruita dal Task 6) e un secondo bind group del gruppo 0 il cui binding 2 è `transparent-order` (spec §6.2). Le 6 pipeline trasparenti per tipo spariscono.

**Files:**
- Modify: `ts/src/render/passes/forward-pass.ts`, con modifiche mirate sul testo che lasciano i Task 6 (sezione C, Step 4 (a)-(i)) e 15 (sezione G, Step 8): import, doc della classe, campi, `setup` (lookup del pool, loop delle pipeline, gruppo 0), guardia e sub-pass trasparente di `execute`, `destroy`. Tutto il resto (la guardia `UBER_SOURCE` del Task 6, `blendedTarget`/`transparentPipeline`, il letterale `reads` del Task 15) resta com'è.
- Test: `ts/src/render/passes/forward-pass.test.ts`, quello riscritto dal Task 6 (sezione C, Step 2) e allungato dal Task 15: il `setUp()` locale di `describe('ForwardPass group 1 follows the texture tiers')`, il `setUpForward()` a livello di modulo, il test 'sets group 2 for every pipeline it draws, including shaders that ignore it', il `describe('ForwardPass builds the uber pipeline, not drawn yet')` del Task 6, e un `describe` nuovo in fondo

**Interfaces:**
- Consumes:
  - `ForwardPass.UBER_SOURCE: string` (statica, Task 6), riempita da `publishPrimitiveShaders()` in `renderer.ts`; `setup()` lancia già se è vuota (Task 6, Step 4(e)), e questo task tiene quel `throw`
  - dal Task 6 in `forward-pass.ts`: `private uberPipeline`, già nella guardia di `execute()`; `blendedTarget` e l'helper `transparentPipeline(module)`, che restano e servono solo all'uber
  - dal Task 6 in `forward-pass.test.ts`: `UBER_STUB`, `setUpForward(options?, uberSource = UBER_STUB)` a livello di modulo, il test 'refuses to set up without an uber module …' (`toThrow(/UBER_SOURCE/)`); l'import `SCENE_HDR_FORMAT` c'è già
  - `FrameState.transparentCount: number` (Task 10, già normalizzato: sempre un intero finito ≥ 0)
  - buffer del pool `'transparent-order'` (CAP×4 B) e `'transparent-args'` (64 B), creati da `createRenderer` (Task 15) prima di `RenderGraphHost`
  - `H_DRAW = 0` da `ts/src/render/passes/transparent-sort-constants.ts` (Task 13): parola dell'header dove sta `DrawIndexedIndirect {6, n, 0, 0, 0}`
  - `ForwardPass.reads` contiene già `'transparent-order'` e `'transparent-args'` (Task 15)
- Produces:
  - `ForwardPass`: `private uberPipeline: GPURenderPipeline | null`, `private bindGroup0Sorted: GPUBindGroup | null`, `private transparentArgsBuffer: GPUBuffer | null`; `transparentPipelines` eliminato
  - sub-pass trasparente = `setPipeline(uberPipeline)`, `setBindGroup(0, bindGroup0Sorted)`, `setBindGroup(1, …)`, `setBindGroup(2, …)`, `drawIndexedIndirect(transparentArgs, H_DRAW * 4)`; saltato quando `frame.transparentCount === 0`
  - `setup()` lancia `"ForwardPass.setup: missing 'transparent-order' in ResourcePool"` / `"... 'transparent-args' ..."` se il pool non li ha

- [ ] **Step 1: I due pool del file contengono le uscite del sort**

Il file è quello lasciato dal Task 6 (e dal Task 15, che gli ha aggiunto in coda il `describe('ForwardPass reads the transparent sort outputs')`). Ha due fixture che chiamano `setup()`: il `setUp()` LOCALE di `describe('ForwardPass group 1 follows the texture tiers')` e la funzione `setUpForward()` a LIVELLO DI MODULO, che usano il `describe('ForwardPass @group(2): the light buffer')`, il describe dell'uber del Task 6 e i describe dei moduli composti (`primitiveLayouts()` compreso). Il describe `@group(2)` non ha un `setUp` suo.

In tutte e due le fixture il loop che registra i buffer diventa esattamente:

```ts
    for (const name of ['entity-transforms', 'visible-indices', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params', 'transparent-order', 'transparent-args']) {
      pool.setBuffer(name, {} as GPUBuffer);
    }
```

(in `setUpForward()` l'indentazione è di due spazi in meno: è una funzione di modulo). Senza questa modifica, dopo lo Step 5 ogni chiamante di `setUpForward()` lancia "missing 'transparent-order'", compreso `primitiveLayouts()` e quindi tutto il describe 'every binding an entry point reaches…'.

In `setUpForward()`, la riga del frame diventa (un trasparente almeno, così il draw uber è codificato):

```ts
  const frame = { canvasWidth: 64, canvasHeight: 64, transparentCount: 1 } as FrameState;
```

Il `setUp()` del gruppo 1 tiene il suo frame senza `transparentCount`: `undefined !== 0`, quindi dopo lo Step 5 codifica anche il draw uber, e i suoi due test leggono comunque il gruppo 1 di ogni draw.

- [ ] **Step 2: Il conteggio delle pipeline del test del gruppo 2 passa a 3 opache + 1 uber**

Nel `describe('ForwardPass @group(2): the light buffer')`, sostituisci per intero il test del Task 6 `it('sets group 2 for every pipeline it draws, including shaders that ignore it', …)` (quello con `expect(pipelines).toBe(6)`) con:

```ts
  it('sets group 2 for every pipeline it draws, including shaders that ignore it', () => {
    const { draw } = setUpForward();
    const calls = draw();
    const pipelines = calls.filter((c) => c.op === 'pipeline').length;
    // 3 types opaque + ONE uber pipeline for every transparent (design 5b §6.2).
    expect(pipelines).toBe(4);
    expect(calls.filter((c) => c.op === 'group' && c.index === 2)).toHaveLength(pipelines);
  });
```

- [ ] **Step 2b: Il describe dell'uber del Task 6 non dice più "not drawn yet"**

Nel `describe('ForwardPass builds the uber pipeline, not drawn yet', …)` del Task 6:
1. Cancella per intero `it('builds it once, from UBER_SOURCE, with exactly the transparent descriptor', …)`: le sue 7 pipeline e le 3 trasparenti per tipo non esistono più, e il test nuovo 'builds one opaque pipeline per type and ONE uber pipeline, with the transparent descriptor' (Step 3) controlla lo stesso descrittore.
2. Cancella per intero `it('does not draw it yet: the transparent sub-pass still draws each type with its own pipeline', …)`.
3. Rinomina il describe in `'ForwardPass requires the uber module'` e sostituisci il commento di quattro righe sopra di lui (quello che finisce con "the transparent sub-pass does not use it yet.") con quello del blocco qui sotto.
4. Tieni INVARIATO `it('refuses to set up without an uber module: publishPrimitiveShaders() runs first', …)`: `setUpForward({}, '')` arriva al `throw` di `UBER_SOURCE`, che sta prima di ogni lookup del pool.
5. Cancella la costante `codeOf` in testa al describe: dopo i punti 1 e 2 non la usa più nessuno.

Il describe diventa:

```ts
// The uber module (design 2026-09-27 §3.2): every primitive type behind one
// pipeline, which draws every transparent (design 5b §6.2). setup() refuses
// to run without it, before it looks at the pool.
describe('ForwardPass requires the uber module', () => {
  it('refuses to set up without an uber module: publishPrimitiveShaders() runs first', () => {
    expect(() => setUpForward({}, '')).toThrow(/UBER_SOURCE/);
  });
});
```

- [ ] **Step 3: Il `describe` nuovo sul draw uber (test che fallisce)**

In testa al file aggiungi agli import esistenti SOLO:

```ts
import { BUCKETS_PER_TYPE, OPAQUE_DRAW_BUCKETS } from './cull-pass';
```

`SCENE_HDR_FORMAT` lo importa già il file del Task 6 (`import { SCENE_HDR_FORMAT } from '../formats';`): un secondo import dà a `tsc` TS2300 (Duplicate identifier) e a esbuild una dichiarazione duplicata. `ResourcePool`, `FrameState` e `ForwardPass` sono anch'essi già importati.

In fondo al file aggiungi (il describe ha una fixture `setUp` sua, locale, che non tocca le altre):

```ts
// Design 5b §6.2: the transparent sub-pass is ONE draw. TransparentSortPass
// writes the visible transparents of types 0-5, back to front, into
// `transparent-order` and the draw arguments at byte 0 of `transparent-args`;
// ForwardPass draws them through the uber pipeline, with a second group 0
// whose binding 2 (visibleIndices in the shaders) is the sorted order.
describe('ForwardPass: the uber draw of the sorted transparents', () => {
  interface FakePipeline { desc: GPURenderPipelineDescriptor }
  interface FakeGroup { layout: unknown; entries: GPUBindGroupEntry[] }
  interface Call { op: 'pipeline' | 'group' | 'draw'; pipeline?: FakePipeline; index?: number; group?: FakeGroup; buffer?: unknown; offset?: number }

  const POOL_BUFFERS = ['entity-transforms', 'visible-indices', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params', 'transparent-order', 'transparent-args'];

  function setUp(omit: string[] = []) {
    const g = globalThis as Record<string, unknown>;
    g.GPUBufferUsage ??= { COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 };
    g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
    g.GPUTextureUsage ??= { COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

    const pipelines: FakePipeline[] = [];
    const groups: FakeGroup[] = [];
    const device = {
      createBuffer: () => ({ destroy() {} }),
      createShaderModule: (d: GPUShaderModuleDescriptor) => ({ code: d.code }),
      createSampler: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => ({ groups: [...d.bindGroupLayouts] }),
      createRenderPipeline: (desc: GPURenderPipelineDescriptor) => { const p = { desc }; pipelines.push(p); return p; },
      createBindGroup: (d: GPUBindGroupDescriptor) => { const bg = { layout: d.layout, entries: [...d.entries] }; groups.push(bg); return bg; },
      createTexture: () => ({ createView: () => ({}), destroy() {} }),
      queue: { writeBuffer() {}, writeTexture() {} },
    } as unknown as GPUDevice;

    const buffers: Record<string, { name: string }> = {};
    const pool = new ResourcePool();
    for (const name of POOL_BUFFERS) {
      buffers[name] = { name };
      if (!omit.includes(name)) pool.setBuffer(name, buffers[name] as unknown as GPUBuffer);
    }
    for (const name of ['tier0', 'tier1', 'tier2', 'tier3', 'ovf0', 'ovf1', 'ovf2', 'ovf3', 'scene-hdr']) {
      pool.setTextureView(name, { name } as unknown as GPUTextureView);
    }
    pool.setSampler('texSampler', {} as GPUSampler);

    // SHADER_SOURCES is filled in place by the renderer: mutate it, never replace it.
    const savedSources = { ...ForwardPass.SHADER_SOURCES };
    const savedUber = ForwardPass.UBER_SOURCE;
    const replaceSources = (next: Record<number, string>) => {
      for (const key of Object.keys(ForwardPass.SHADER_SOURCES)) delete ForwardPass.SHADER_SOURCES[Number(key)];
      Object.assign(ForwardPass.SHADER_SOURCES, next);
    };
    replaceSources({ 0: 'quad module', 1: 'line module', 4: 'gradient module' });
    ForwardPass.UBER_SOURCE = 'uber module';
    const pass = new ForwardPass();
    try {
      pass.setup(device, pool);
    } finally {
      replaceSources(savedSources);
      ForwardPass.UBER_SOURCE = savedUber;
    }

    const draw = (transparentCount: number): Call[] => {
      const calls: Call[] = [];
      const encoder = {
        beginRenderPass: () => ({
          setVertexBuffer() {}, setIndexBuffer() {}, end() {},
          setPipeline: (pipeline: FakePipeline) => { calls.push({ op: 'pipeline', pipeline }); },
          setBindGroup: (index: number, group: FakeGroup) => { calls.push({ op: 'group', index, group }); },
          drawIndexedIndirect: (buffer: unknown, offset: number) => { calls.push({ op: 'draw', buffer, offset }); },
        }),
      } as unknown as GPUCommandEncoder;
      pass.execute(encoder, { canvasWidth: 64, canvasHeight: 64, transparentCount } as FrameState, pool);
      return calls;
    };
    const uber = () => pipelines.find((p) => (p.desc.vertex.module as unknown as { code: string }).code === 'uber module');
    const binding = (group: FakeGroup, b: number) => (group.entries.find((e) => e.binding === b)!.resource as GPUBufferBinding).buffer;
    return { pipelines, groups, buffers, draw, uber, binding };
  }

  it('builds one opaque pipeline per type and ONE uber pipeline, with the transparent descriptor', () => {
    const { pipelines, uber } = setUp();
    expect(pipelines).toHaveLength(4); // 3 types opaque + the uber
    const u = uber();
    expect(u, 'a pipeline built from UBER_SOURCE').toBeDefined();
    const blended = pipelines.filter((p) => [...p.desc.fragment!.targets][0]!.blend);
    expect(blended).toEqual([u]);
    const d = u!.desc;
    expect(d.vertex.entryPoint).toBe('vs_main');
    expect(d.fragment!.entryPoint).toBe('fs_main');
    expect([...d.fragment!.targets][0]!.format).toBe(SCENE_HDR_FORMAT);
    expect([...d.fragment!.targets][0]!.blend).toEqual({
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    });
    expect(d.depthStencil).toEqual({ format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' });
    expect(d.primitive).toEqual({ topology: 'triangle-list', cullMode: 'back' });
    expect([...d.vertex.buffers!][0]).toEqual({ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] });
    // The same three-group layout as every opaque pipeline.
    for (const p of pipelines) expect(p.desc.layout).toBe(d.layout);
    expect((d.layout as unknown as { groups: unknown[] }).groups).toHaveLength(3);
  });

  it('builds a second group 0: bindGroup0 with binding 2 = transparent-order', () => {
    const { groups, buffers, binding } = setUp();
    const group0s = groups.filter((g) => g.entries.length === 6);
    expect(group0s).toHaveLength(2);
    const plain = group0s.find((g) => binding(g, 2) === buffers['visible-indices']);
    const sorted = group0s.find((g) => binding(g, 2) === buffers['transparent-order']);
    expect(plain, 'group 0 on visible-indices').toBeDefined();
    expect(sorted, 'group 0 on transparent-order').toBeDefined();
    expect(sorted!.layout).toBe(plain!.layout);
    for (const b of [0, 1, 3, 4, 5]) expect(binding(sorted!, b)).toBe(binding(plain!, b));
  });

  it('draws every transparent with ONE drawIndexedIndirect(transparent-args, 0), after the opaque draws', () => {
    const { draw, buffers, uber, binding } = setUp();
    const calls = draw(5);
    const draws = calls.filter((c) => c.op === 'draw');
    // Opaque: 3 types x 2 material buckets, from buckets 0-13 of indirect-args.
    const opaque = draws.filter((c) => c.buffer === buffers['indirect-args']);
    expect(opaque).toHaveLength(3 * BUCKETS_PER_TYPE);
    for (const c of opaque) expect(c.offset!).toBeLessThan(OPAQUE_DRAW_BUCKETS * 20);
    const transparent = draws.filter((c) => c.buffer === buffers['transparent-args']);
    expect(transparent).toEqual([{ op: 'draw', buffer: buffers['transparent-args'], offset: 0 }]);
    expect(draws.at(-1)).toBe(transparent[0]);
    // Its state: the uber pipeline, the sorted group 0, groups 1 and 2.
    const at = calls.indexOf(transparent[0]);
    const lastPipeline = calls.slice(0, at).filter((c) => c.op === 'pipeline').at(-1)!;
    expect(lastPipeline.pipeline).toBe(uber());
    const since = calls.slice(calls.indexOf(lastPipeline), at);
    const group = (n: number) => since.filter((c) => c.op === 'group' && c.index === n).at(-1)?.group;
    expect(binding(group(0)!, 2)).toBe(buffers['transparent-order']);
    expect(group(1), 'group 1 set for the uber draw').toBeDefined();
    expect(group(2), 'group 2 set for the uber draw').toBeDefined();
  });

  it('skips the uber draw when nothing is transparent (FrameState.transparentCount 0)', () => {
    const { draw, buffers, uber } = setUp();
    const calls = draw(0);
    expect(calls.filter((c) => c.op === 'draw' && c.buffer === buffers['transparent-args'])).toHaveLength(0);
    expect(calls.some((c) => c.op === 'pipeline' && c.pipeline === uber())).toBe(false);
    expect(calls.filter((c) => c.op === 'draw' && c.buffer === buffers['indirect-args'])).toHaveLength(3 * BUCKETS_PER_TYPE);
  });

  it('never binds transparent-args: in a render pass it is an INDIRECT buffer only', () => {
    const { groups, buffers, draw } = setUp();
    draw(3);
    for (const g of groups) for (const e of g.entries) {
      expect((e.resource as GPUBufferBinding).buffer).not.toBe(buffers['transparent-args']);
    }
  });

  it('reads the sort outputs, lit and unlit: that keeps TransparentSortPass alive and before it', () => {
    for (const lit of [false, true]) {
      const pass = new ForwardPass({ lit });
      expect(pass.reads).toContain('transparent-order');
      expect(pass.reads).toContain('transparent-args');
    }
  });

  it('fails loudly in setup without the renderer-owned sort buffers', () => {
    expect(() => setUp(['transparent-order'])).toThrow(/transparent-order/);
    expect(() => setUp(['transparent-args'])).toThrow(/transparent-args/);
  });
});
```

- [ ] **Step 4: Esegui i test: devono fallire**

Run: `npx --prefix ts vitest run --root ts src/render/passes/forward-pass.test.ts`

Expected: FAIL, contro il `forward-pass.ts` dei Task 6 e 15 e con gli Step 1-3 applicati. Falliscono esattamente sei test:
- 'sets group 2 for every pipeline it draws…' (6 `setPipeline`, non 4: le 3 pipeline trasparenti per tipo disegnano ancora);
- 'builds one opaque pipeline per type and ONE uber pipeline' (7 pipeline create: 3 opache, 3 trasparenti, l'uber);
- 'builds a second group 0' (un solo gruppo 0);
- 'draws every transparent with ONE drawIndexedIndirect' (6 draw trasparenti su `indirect-args`, nessuno su `transparent-args`);
- 'skips the uber draw' (i draw per tipo non dipendono dal conteggio);
- 'fails loudly in setup' (`setup` non guarda i due buffer).

Passano già: 'reads the sort outputs' e 'never binds transparent-args' (Task 15), 'refuses to set up without an uber module' (la guardia del Task 6) e tutti gli altri test del file, che con lo Step 1 trovano nel pool anche i due buffer del sort.

- [ ] **Step 5: `forward-pass.ts` passa al draw uber (modifiche mirate)**

Tutte le modifiche sono sul testo lasciato dai Task 6 (sezione C, Step 4 (a)-(i)) e 15 (sezione G, Step 8). Non riscrivere il file: la guardia `UBER_SOURCE` del Task 6, `blendedTarget` e l'helper `transparentPipeline`, la doc della statica `UBER_SOURCE` e il letterale `reads` del Task 15 (col suo commento) restano come sono.

(a) **Import.** Prima:
```ts
import { BUCKETS_PER_TYPE, OPAQUE_DRAW_BUCKETS } from './cull-pass';
```
Dopo:
```ts
import { BUCKETS_PER_TYPE } from './cull-pass';
import { H_DRAW } from './transparent-sort-constants';
```
`OPAQUE_DRAW_BUCKETS` serviva solo al loop trasparente che il punto (h) cancella: lasciato nell'import, `noUnusedLocals` dà TS6133.

(b) **Doc della classe.** Prima (il paragrafo scritto dal Task 6, Step 4(a)):
```ts
 * Each registered primitive type (via SHADER_SOURCES) gets TWO pipelines:
 * one opaque (depth-write enabled, no blend) and one transparent (depth-write
 * disabled, alpha blend enabled). UBER_SOURCE, every primitive type in one
 * module, gets one more pipeline with the transparent descriptor: built, and so
 * validated with every graph and every hot-reload probe, but not drawn yet.
```
Dopo:
```ts
 * Each registered primitive type (via SHADER_SOURCES, the COMPOSED per-type
 * modules) gets ONE opaque pipeline (depth write, no blend), drawn from the
 * material buckets 0-13 of `indirect-args`.
 *
 * Every transparent primitive is drawn by ONE uber pipeline, from UBER_SOURCE
 * (no depth write, straight alpha blend), back to front (design 5b §6.2).
 * TransparentSortPass gathers the visible transparents of types 0-5 (buckets
 * 14-25), sorts them by (world z, external id), and writes the slots into
 * `transparent-order` and the draw arguments {6, n, 0, 0, 0} at byte 0 of
 * `transparent-args`. The uber draw binds `bindGroup0Sorted`, a second group 0
 * whose binding 2 (`visibleIndices` in the shaders) is `transparent-order`, so
 * instance i is the i-th sprite back to front: drawIndexedIndirect(transparent-args, 0).
 * firstInstance is 0: this draw needs no `indirect-first-instance`. It is
 * skipped when `FrameState.transparentCount` is 0. Here `transparent-args` is an
 * INDIRECT buffer only, never bound: in a render pass the usage scope is the
 * whole pass.
```
Poco sotto, prima:
```ts
 * Sub-pass 1: Opaque entities (buckets 0-13) with depth write.
 * Sub-pass 2: Transparent entities (buckets 14-27) with alpha blend, no depth write.
```
Dopo:
```ts
 * Sub-pass 1: Opaque entities (buckets 0-13) with depth write.
 * Sub-pass 2: every transparent entity, in the ONE uber draw above.
```
Il resto della doc (il paragrafo di CullPass, quello di Light2D, quello del gruppo 2 riscritto dal Task 6) non cambia.

(c) **Campi.** Prima (dopo il Task 6, Step 4(c)):
```ts
  private opaquePipelines = new Map<number, GPURenderPipeline>();
  private transparentPipelines = new Map<number, GPURenderPipeline>();
  /** Every primitive type in one pipeline (UBER_SOURCE), transparent descriptor. Built, not drawn yet. */
  private uberPipeline: GPURenderPipeline | null = null;
  private bindGroup0: GPUBindGroup | null = null;
```
Dopo:
```ts
  private opaquePipelines = new Map<number, GPURenderPipeline>();
  /** ONE pipeline for every transparent primitive (UBER_SOURCE), transparent descriptor: the uber draw. */
  private uberPipeline: GPURenderPipeline | null = null;
  private bindGroup0: GPUBindGroup | null = null;
  /** `bindGroup0` with binding 2 = `transparent-order`: the uber draw's instance i is the i-th slot back to front. */
  private bindGroup0Sorted: GPUBindGroup | null = null;
```
Poi, dopo la riga `  private indirectBuffer: GPUBuffer | null = null;`, aggiungi:
```ts
  /** The sort's header (renderer-owned): DrawIndexedIndirect {6, n, 0, 0, 0} at word H_DRAW. */
  private transparentArgsBuffer: GPUBuffer | null = null;
```

(d) **`setup()`, lookup del pool.** La guardia del Task 6 (Step 4(e)) resta INVARIATA dov'è, subito dopo il `throw` "no shader sources set" e prima di ogni lookup del pool; è lei che fa passare 'refuses to set up without an uber module':
```ts
    if (!ForwardPass.UBER_SOURCE) {
      throw new Error('ForwardPass: no uber source set. Set UBER_SOURCE (renderer.ts: publishPrimitiveShaders) before calling setup()');
    }
```
Dopo la riga
```ts
    if (!primParamsBuffer) throw new Error("ForwardPass.setup: missing 'prim-params' in ResourcePool");
```
aggiungi:
```ts
    // The sort's outputs belong to the renderer (createRenderer), never to a
    // pass: an HMR probe runs setup() then destroy() against the LIVE pool.
    const transparentOrderBuffer = resources.getBuffer('transparent-order');
    if (!transparentOrderBuffer) throw new Error("ForwardPass.setup: missing 'transparent-order' in ResourcePool");
    const transparentArgsBuffer = resources.getBuffer('transparent-args');
    if (!transparentArgsBuffer) throw new Error("ForwardPass.setup: missing 'transparent-args' in ResourcePool");
    this.transparentArgsBuffer = transparentArgsBuffer;
```

(e) **`setup()`, pipeline (testo del Task 6, Step 4(f)).** Prima:
```ts
    // Transparent: depth write disabled, alpha blend. The per-type transparent
    // pipelines and the uber pipeline share this descriptor exactly.
```
Dopo:
```ts
    // Transparent: depth write disabled, straight-alpha blend. Only the uber
    // pipeline uses it (design 5b §6.2): there are no per-type transparent
    // pipelines any more.
```
`blendedTarget` e `transparentPipeline` restano invariati (è il descrittore che il Task 8 riproduce in `validate-wgsl.js`). Poi, prima:
```ts
    // --- Create opaque and transparent pipelines per primitive type ---
```
Dopo:
```ts
    // --- Opaque: one pipeline per primitive type (depth write, no blend) ---
```
Nel corpo del `for` cancella la riga:
```ts
      this.transparentPipelines.set(type, transparentPipeline(module));
```
Infine, prima:
```ts
    // The uber module: every primitive type behind one pipeline, for the sorted
    // transparent draw. Built here, so every graph and every hot-reload probe
    // validates it; not drawn yet: the transparent sub-pass still draws per type.
    this.uberPipeline = transparentPipeline(device.createShaderModule({ code: ForwardPass.UBER_SOURCE }));
```
Dopo:
```ts
    // --- Transparent: ONE uber pipeline for every primitive type (design 5b §6.2) ---
    // It draws every visible transparent of types 0-5, back to front, in the
    // one draw of execute().
    this.uberPipeline = transparentPipeline(device.createShaderModule({ code: ForwardPass.UBER_SOURCE }));
```

(f) **`setup()`, gruppo 0.** Prima (invariato dai Task 6 e 15):
```ts
    this.bindGroup0 = device.createBindGroup({
      layout: bindGroupLayout0,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: transformBuffer } },
        { binding: 2, resource: { buffer: visibleIndicesBuffer } },
        { binding: 3, resource: { buffer: texIndexBuffer } },
        { binding: 4, resource: { buffer: renderMetaBuffer } },
        { binding: 5, resource: { buffer: primParamsBuffer } },
      ],
    });
```
Dopo:
```ts
    // Two group 0s, identical but for binding 2: the cull's visible indices
    // for the opaque draws, the sorted order for the uber draw. The shaders
    // read `visibleIndices[instance_index]` either way. Both buffers are
    // created once by the renderer at a fixed size, so neither group is rebuilt.
    const cameraBuffer = this.cameraBuffer;
    const group0Entries = (visible: GPUBuffer): GPUBindGroupEntry[] => [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 1, resource: { buffer: transformBuffer } },
      { binding: 2, resource: { buffer: visible } },
      { binding: 3, resource: { buffer: texIndexBuffer } },
      { binding: 4, resource: { buffer: renderMetaBuffer } },
      { binding: 5, resource: { buffer: primParamsBuffer } },
    ];
    this.bindGroup0 = device.createBindGroup({ layout: bindGroupLayout0, entries: group0Entries(visibleIndicesBuffer) });
    this.bindGroup0Sorted = device.createBindGroup({ layout: bindGroupLayout0, entries: group0Entries(transparentOrderBuffer) });
```
La costante locale `cameraBuffer` serve perché dentro una closure TypeScript non tiene il restringimento di `this.cameraBuffer` (assegnato poco sopra in `setup()`): la costante vale `GPUBuffer`, non `GPUBuffer | null`.

(g) **`execute()`, guardia.** Prima (Task 6, Step 4(h)):
```ts
    if (this.opaquePipelines.size === 0 || !this.uberPipeline || !this.vertexBuffer || !this.indexBuffer || !this.bindGroup0 || !this.bindGroup1 || !bindGroup2 || !this.indirectBuffer) return;
```
Dopo:
```ts
    if (this.opaquePipelines.size === 0 || !this.uberPipeline || !this.vertexBuffer || !this.indexBuffer
      || !this.bindGroup0 || !this.bindGroup0Sorted || !this.bindGroup1 || !bindGroup2
      || !this.indirectBuffer || !this.transparentArgsBuffer) return;
```

(h) **`execute()`, sub-pass trasparente.** Sostituisci l'intero blocco, dal commento `    // --- Sub-pass 2: Transparent entities (buckets 14-27) ---` fino alla `}` che chiude il suo `for` (quello su `this.transparentPipelines`, con `OPAQUE_DRAW_BUCKETS + primType * BUCKETS_PER_TYPE + bucket`), con:
```ts
    // --- Sub-pass 2: every transparent primitive, back to front, in ONE draw ---
    // TransparentSortPass wrote the visible transparents of types 0-5 into
    // `transparent-order`, sorted by (world z, external id), and the draw
    // arguments at word H_DRAW of `transparent-args`. With nothing transparent
    // the sort encodes nothing: skip the draw too (prepare() has also reset n).
    if (frame.transparentCount !== 0) {
      renderPass.setPipeline(this.uberPipeline);
      renderPass.setVertexBuffer(0, this.vertexBuffer);
      renderPass.setIndexBuffer(this.indexBuffer, 'uint16');
      renderPass.setBindGroup(0, this.bindGroup0Sorted);
      renderPass.setBindGroup(1, this.bindGroup1);
      renderPass.setBindGroup(2, bindGroup2);
      renderPass.drawIndexedIndirect(this.transparentArgsBuffer, H_DRAW * 4);
    }
```
Il sub-pass opaco (sub-pass 1) non cambia.

(i) **`destroy()`.** Cancella la riga `    this.transparentPipelines.clear();`. Dopo `    this.bindGroup0 = null;` aggiungi `    this.bindGroup0Sorted = null;`. Sostituisci la riga `    this.indirectBuffer = null;` con:
```ts
    // Pool buffers: owned by the renderer, never destroyed here.
    this.indirectBuffer = null;
    this.transparentArgsBuffer = null;
```
`    this.uberPipeline = null;` (Task 6, Step 4(i)) resta.

Controllo:
```bash
grep -n "transparentPipelines\|OPAQUE_DRAW_BUCKETS\|not drawn yet" ts/src/render/passes/forward-pass.ts
grep -n "no uber source set\|'transparent-order', 'transparent-args'\|H_DRAW \* 4" ts/src/render/passes/forward-pass.ts
```
Expected: il primo `grep` non stampa nulla; il secondo stampa tre righe (la guardia del Task 6, il letterale `reads` del Task 15, il draw uber).

- [ ] **Step 6: I test del file passano**

Run: `npx --prefix ts vitest run --root ts src/render/passes/forward-pass.test.ts`

Expected: PASS, tutti i test del file: i sette del describe nuovo, i test del Task 6 (moduli composti, `@group(2)`, 'refuses to set up without an uber module' nel describe rinominato allo Step 2b) e quello del Task 15.

- [ ] **Step 7: Nessun altro riferimento a `transparentPipelines`; suite e tipi verdi**

Run:
```bash
grep -rn "transparentPipelines" ts/src --include="*.ts"
npm --prefix ts test
npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"
```
Expected: il `grep` non stampa nulla; vitest tutto verde (stesso numero di file, +5 test rispetto a prima di questo task: 7 nuovi nel describe dello Step 3, meno i 2 cancellati dal describe del Task 6 allo Step 2b); `tsc` senza output (a parte le righe TS2307 della WASM, filtrate).

- [ ] **Step 8: Prova sulla GPU (fumo, non è il cancello)**

Prima assicurati che il dev server risponda: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/` deve dare `200`, altrimenti avvialo in background (Bash `run_in_background`): `npm --prefix ts run dev -- --strictPort --port 5173`.

Con il server MCP **chrome-devtools-gpu**. `list_pages` → `pageId` (o `new_page` con `url: "about:blank"`); `pageId` su ogni chiamata MCP che segue e `waitForStableDom: false` su ogni `evaluate_script` (il pannello dei check si ridisegna ogni 500 ms e l'HUD a ogni frame: il DOM non si assesta mai).
1. `navigate_page` con `type: "url"`, `url: "http://localhost:5173/?mode=B"`, `ignoreCache: true`, `initScript`:
   ```js
   GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)
   ```
2. `list_console_messages` con `types: ["log", "info", "warn"]`: la riga dell'adapter deve dire AMD (non nvidia, non SwiftShader).
3. Per `KEY = 'primitives'`, `LABEL = 'Primitives'` e poi per `KEY = 'twin-2d'`, `LABEL = '2D Twins'`, `evaluate_script` (con `pageId` e `waitForStableDom: false`) con questa funzione (cambia le due costanti in testa):
   ```js
   async () => {
     const KEY = 'twin-2d', LABEL = '2D Twins';
     const section = (await import(`/src/demo/${KEY}.ts`)).default;
     const setup = section.setup;
     let done;
     const finished = new Promise((r) => { done = r; });
     section.setup = async function (...a) { try { return await setup.apply(this, a); } finally { section.setup = setup; done(); } };
     [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes(LABEL)).click();
     await Promise.race([finished, new Promise((r) => setTimeout(r, 60000))]);
     await new Promise((r) => setTimeout(r, 600));
     return [...document.querySelectorAll('.check-item')].map((item) => ({
       name: item.querySelector('.check-name')?.textContent,
       status: [...item.querySelector('.check-icon').classList].find((c) => c !== 'check-icon'),
       detail: item.nextElementSibling?.classList.contains('check-detail') ? item.nextElementSibling.textContent : '',
     }));
   }
   ```
4. `list_console_messages` con `types: ["error", "warn"]`.

Expected: Primitives tutto `pass` tranne l'MSDF in `skip` (come nella baseline); in 2D Twins tutti i check esistenti `pass` ('Twins draw the same pixels', 'GPU rows of 2D entities', 'Depth orders 2D sprites', 'Transparent sort matches the oracle'; 'Transparent sort under churn' in `skip` nel Mode B). In console nessun messaggio che nomini WebGPU, validation, pipeline o device; l'unico errore accettabile è il 404 di `favicon.ico`. Il cancello completo è il Task 21.

- [ ] **Step 9: Commit**

```bash
git add ts/src/render/passes/forward-pass.ts ts/src/render/passes/forward-pass.test.ts
git commit -m "feat(5b): draw uber dei trasparenti in ForwardPass" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: check pixel nuovi in 2D Twins ('Depth orders transparent sprites')

Un check nuovo, accanto a 'Depth orders 2D sprites' (che resta invariato), verifica sulla GPU che sprite `.transparent()` sovrapposti di tipi DIVERSI si compongano nell'ordine delle z, che a parità di z stia davanti l'id più alto e che l'ordine si inverta quando le depth cambiano a runtime (spec §7.3.4). I valori attesi vengono in forma chiusa da un helper puro con i suoi test.

Scelte che servono a rendere il check affidabile:
- **Colori piatti.** Un gradiente con `stop0Pos = 2` (oltre ogni `t` in [0,1]) è tutto `stop0`: un colore costante ad alfa 1, quindi il valore atteso non dipende dal punto campionato. Un box shadow senza blur e senza raggio con `rect = 1×1` copre tutto il quad: colore piatto ad alfa `a`.
- **Lo sprite con la texture** usa il PNG del Task 17, di cui questo task non conosce il contenuto. Il suo colore e il suo alfa nel texel campionato si MISURANO: la stessa texture, a pixel interi di distanza (quindi sullo stesso texel), letta sopra il clear e sopra un quad bianco opaco. Da due letture su due sfondi noti si ricavano `1 − a` e `c·a` per canale (il blend è affine nello sfondo).
- **Ogni coppia deve distinguere i due ordini**: il check calcola anche il valore dell'ordine opposto e fallisce se i due differiscono di meno di 0,1. Così non può passare a vuoto (per esempio con un texel trasparente).
- **Le coppie sono scelte contro l'ordine di prima**: prima della fase 5b i trasparenti si disegnavano per tipo (quad per primi, box shadow per ultimi), poi in ordine di cull. Le celle 0, 1 e 4 danno un altro colore con quell'ordine.
- **Posizione**: la scena sta a (−80, −60), lontano dalle coppie gemelle (|x| ≤ 18 e |y| ≤ 10 a zoom 1 su 1920×1080) e dalla scena della depth (x ≈ 34-46, y = 0), e viene distrutta dopo il check. Non tocca né i punti di 'Depth orders 2D sprites' né la vista che il `setup()` ripristina alla fine, quindi la regola dei pixel di §7.3.5 resta valida.

**Files:**
- Create: `ts/src/demo/blend-expect.ts`
- Test: `ts/src/demo/blend-expect.test.ts`
- Modify: `ts/src/demo/twin-2d.ts` (header L1-9, il blocco di import come l'ha lasciato il Task 17 Step 9(b), costanti e funzione nuova dopo `checkDepth` L67-117, chiamata dopo `await checkDepth(engine, reporter);` oggi L258)

**Interfaces:**
- Consumes:
  - il PNG `ts/public/textures/sort-test-128.png` (Task 17), servito come `/textures/sort-test-128.png`
  - il draw uber del Task 19 (è ciò che il check verifica)
  - `pixelCheck`, `fitView`, `frames`, `fmt` da `ts/src/demo/probe-checks.ts`; `worldToUv` da `ts/src/render/debug-probe.ts`; `engine.loadTexture(url): Promise<TextureHandle>`; `TextureHandle` da `ts/src/types.ts` (già importato in `twin-2d.ts` dal Task 17 Step 9(b), come `worldToUv`, `pixelCheck`, `fitView`, `frames` e `fmt`)
- Produces:
  - `ts/src/demo/blend-expect.ts`:
    ```ts
    export type Rgb = [number, number, number];
    export interface Layer { readonly keep: Rgb; readonly add: Rgb }
    export function straight(rgb: Rgb, alpha: number): Layer;
    export function over(dst: Rgb, layer: Layer): Rgb;
    export function composite(bg: Rgb, layers: readonly Layer[]): Rgb;
    export function measuredLayer(onA: Rgb, bgA: Rgb, onB: Rgb, bgB: Rgb): Layer;
    export interface SortedSprite { readonly depth: number; readonly id: number; readonly layer: Layer }
    export function backToFront<T extends { depth: number; id: number }>(sprites: readonly T[]): T[];
    export function expectedOverlap(bg: Rgb, sprites: readonly SortedSprite[]): Rgb;
    export function maxChannelDiff(a: readonly number[], b: readonly number[]): number;
    ```
  - il check 'Depth orders transparent sprites' nel tab 2D Twins (Mode B e C; `skip` dove non c'è il probe o il renderer del main thread)

- [ ] **Step 1: I test dell'helper (falliscono)**

Crea `ts/src/demo/blend-expect.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { straight, over, composite, measuredLayer, backToFront, expectedOverlap, maxChannelDiff, type Rgb } from './blend-expect';

const CLEAR: Rgb = [0.067, 0.067, 0.067];

describe('straight-alpha "over" (the transparent pipeline blend)', () => {
  it('mixes the colour by its alpha: dst * (1 - a) + c * a', () => {
    const got = over([0.2, 0.4, 0.6], straight([1, 0, 0], 0.5));
    [0.6, 0.2, 0.3].forEach((v, c) => expect(got[c]).toBeCloseTo(v, 12));
  });

  it('alpha 1 leaves the colour on top, whatever was below', () => {
    expect(over([0.3, 0.9, 0.1], straight([0.25, 0.75, 0.5], 1))).toEqual([0.25, 0.75, 0.5]);
  });

  it('alpha 0 leaves the colour below', () => {
    expect(over([0.3, 0.9, 0.1], straight([1, 1, 1], 0))).toEqual([0.3, 0.9, 0.1]);
  });
});

describe('composite: layers back to front', () => {
  it('the order of two layers matters, and the last one is on top', () => {
    const green = straight([0, 1, 0], 1);
    const red = straight([1, 0, 0], 0.5);
    expect(composite(CLEAR, [red, green])).toEqual([0, 1, 0]);
    const redOnTop = composite(CLEAR, [green, red]);
    [0.5, 0.5, 0].forEach((v, c) => expect(redOnTop[c]).toBeCloseTo(v, 12));
  });

  it('no layers: the background', () => {
    expect(composite(CLEAR, [])).toEqual(CLEAR);
  });
});

describe('measuredLayer: a texel whose colour and alpha are unknown', () => {
  it('recovers keep = 1 - a and add = c * a from reads over two backgrounds', () => {
    const texel = straight([0.3, 0.8, 0.1], 0.7);
    const white: Rgb = [1, 1, 1];
    const layer = measuredLayer(over(CLEAR, texel), CLEAR, over(white, texel), white);
    layer.keep.forEach((k) => expect(k).toBeCloseTo(0.3, 10));
    [0.21, 0.56, 0.07].forEach((v, c) => expect(layer.add[c]).toBeCloseTo(v, 10));
    // Over a third background it predicts what the blend gives.
    const teal: Rgb = [0.25, 0.75, 0.5];
    const want = over(teal, texel);
    over(teal, layer).forEach((v, c) => expect(v).toBeCloseTo(want[c], 10));
  });

  it('an opaque texel: keep 0, add = its colour', () => {
    const texel = straight([0.9, 0.2, 0.4], 1);
    const white: Rgb = [1, 1, 1];
    const layer = measuredLayer(over(CLEAR, texel), CLEAR, over(white, texel), white);
    layer.keep.forEach((k) => expect(k).toBeCloseTo(0, 10));
    [0.9, 0.2, 0.4].forEach((v, c) => expect(layer.add[c]).toBeCloseTo(v, 10));
  });

  it('refuses two backgrounds equal in a channel: they fix nothing there', () => {
    expect(() => measuredLayer([0.5, 0.5, 0.5], [0.2, 0.3, 0.4], [0.5, 0.5, 0.5], [0.9, 0.3, 0.9]))
      .toThrow(/channel 1/);
  });
});

describe('backToFront: the order TransparentSortPass draws in', () => {
  it('the larger depth first (z = -depth, the camera looks down -Z)', () => {
    const order = backToFront([{ depth: 1, id: 1 }, { depth: 3, id: 2 }, { depth: 2, id: 3 }]);
    expect(order.map((s) => s.depth)).toEqual([3, 2, 1]);
  });

  it('at equal depth, the higher external id is drawn last: in front', () => {
    const order = backToFront([{ depth: 2, id: 9 }, { depth: 2, id: 3 }, { depth: 1, id: 5 }]);
    expect(order.map((s) => s.id)).toEqual([3, 9, 5]);
  });

  it('does not reorder its input', () => {
    const input = [{ depth: 1, id: 1 }, { depth: 3, id: 2 }];
    backToFront(input);
    expect(input.map((s) => s.id)).toEqual([1, 2]);
  });
});

describe('expectedOverlap', () => {
  it('the nearer sprite is on top, whatever the spawn order', () => {
    const want = expectedOverlap(CLEAR, [
      { depth: 1, id: 10, layer: straight([0, 1, 0], 1) },
      { depth: 2, id: 11, layer: straight([1, 0, 0], 0.5) },
    ]);
    expect(want).toEqual([0, 1, 0]);
  });

  it('a tie goes to the higher id', () => {
    const magenta = { depth: 2, id: 4, layer: straight([1, 0, 1], 1) };
    const cyan = { depth: 2, id: 7, layer: straight([0, 1, 1], 1) };
    expect(expectedOverlap(CLEAR, [cyan, magenta])).toEqual([0, 1, 1]);
    expect(expectedOverlap(CLEAR, [magenta, cyan])).toEqual([0, 1, 1]);
  });
});

describe('maxChannelDiff', () => {
  it('is the largest absolute per-channel difference, alpha ignored', () => {
    expect(maxChannelDiff([0.1, 0.5, 0.9, 1], [0.2, 0.2, 0.9, 0])).toBeCloseTo(0.3, 12);
  });
});
```

- [ ] **Step 2: Esegui: deve fallire**

Run: `npx --prefix ts vitest run --root ts src/demo/blend-expect.test.ts`

Expected: FAIL, `Failed to resolve import "./blend-expect"`: il modulo non esiste ancora.

- [ ] **Step 3: L'helper**

Crea `ts/src/demo/blend-expect.ts`:

```ts
// ts/src/demo/blend-expect.ts — what the transparent pipeline's blend leaves on
// scene-hdr, in closed form, for the harness's pixel checks.
//
// The uber pipeline blends colour with (src-alpha, one-minus-src-alpha, add):
// straight alpha, "over". A layer is kept as the affine map it applies to what
// is below it, per channel: dst' = dst * keep + add. A straight-alpha colour c
// at alpha a is keep = 1 - a, add = c * a. A layer whose colour and alpha are
// not known (a texel of a PNG) is measured: two reads over two known
// backgrounds fix keep and add.

export type Rgb = [number, number, number];

/** What one layer does to the colour below it: dst' = dst * keep + add, per channel. */
export interface Layer {
  readonly keep: Rgb;
  readonly add: Rgb;
}

/** A straight-alpha colour at alpha `alpha` (a gradient is alpha 1, a box shadow its colour's alpha). */
export function straight(rgb: Rgb, alpha: number): Layer {
  return {
    keep: [1 - alpha, 1 - alpha, 1 - alpha],
    add: [rgb[0] * alpha, rgb[1] * alpha, rgb[2] * alpha],
  };
}

/** `layer` drawn over `dst`. */
export function over(dst: Rgb, layer: Layer): Rgb {
  return [0, 1, 2].map((c) => dst[c] * layer.keep[c] + layer.add[c]) as Rgb;
}

/** The layers, BACK TO FRONT, over `bg`. */
export function composite(bg: Rgb, layers: readonly Layer[]): Rgb {
  return layers.reduce<Rgb>((dst, layer) => over(dst, layer), bg);
}

/**
 * The layer that turned `bgA` into `onA` and `bgB` into `onB`. Per channel
 * dst' = dst * keep + add is linear in dst, so two backgrounds that differ in
 * every channel fix both keep and add.
 */
export function measuredLayer(onA: Rgb, bgA: Rgb, onB: Rgb, bgB: Rgb): Layer {
  const keep = [0, 1, 2].map((c) => {
    const span = bgB[c] - bgA[c];
    if (Math.abs(span) < 1e-3) throw new Error(`measuredLayer: backgrounds equal in channel ${c}`);
    return (onB[c] - onA[c]) / span;
  }) as Rgb;
  const add = [0, 1, 2].map((c) => onA[c] - bgA[c] * keep[c]) as Rgb;
  return { keep, add };
}

/** A sprite as the transparent sort sees it: its depth (world z = -depth), its external id, its layer. */
export interface SortedSprite {
  readonly depth: number;
  readonly id: number;
  readonly layer: Layer;
}

/**
 * Back to front, the order TransparentSortPass draws in: ascending world z.
 * The camera looks down -Z and a 2D row's z is -depth, so the LARGER depth
 * comes first. At equal z the higher external id is drawn last: in front.
 */
export function backToFront<T extends { depth: number; id: number }>(sprites: readonly T[]): T[] {
  return [...sprites].sort((a, b) => (b.depth - a.depth) || (a.id - b.id));
}

/** What the probe should read where all of `sprites` overlap, over `bg`. */
export function expectedOverlap(bg: Rgb, sprites: readonly SortedSprite[]): Rgb {
  return composite(bg, backToFront(sprites).map((s) => s.layer));
}

/** Largest absolute difference over the first three channels. */
export function maxChannelDiff(a: readonly number[], b: readonly number[]): number {
  return Math.max(...[0, 1, 2].map((c) => Math.abs(a[c] - b[c])));
}
```

- [ ] **Step 4: Esegui: deve passare; commit dell'helper**

Run: `npx --prefix ts vitest run --root ts src/demo/blend-expect.test.ts`

Expected: PASS (14 test).

```bash
git add ts/src/demo/blend-expect.ts ts/src/demo/blend-expect.test.ts
git commit -m "test(5b): valori attesi del blend dei trasparenti in forma chiusa" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Il check in `twin-2d.ts`**

1. Nell'header del file (oggi L1-9), dopo la frase "A third check, off to the right, orders overlapping 2D sprites by depth (z = -depth)." aggiungi la riga:
   ```ts
   // A fourth, far off at (-80, -60) and destroyed afterwards, orders overlapping
   // `.transparent()` sprites of different primitive types (phase 5b's GPU sort).
   ```
2. Agli import aggiungi UNA riga, dopo quella di `./transparent-sort-checks` che il Task 17 (Step 9(b)) ha aggiunto dopo `probe-checks`:
   ```ts
   import { straight, composite, measuredLayer, backToFront, expectedOverlap, maxChannelDiff, type Layer, type Rgb } from './blend-expect';
   ```
   Non re-importare `TextureHandle`, `worldToUv`, `pixelCheck`, `fitView`, `frames` né `fmt`: il blocco di import del Task 17 Step 9(b) li importa già (`import type { TextureHandle } from '../types';` compreso), e un secondo `import type { TextureHandle }` fa fallire `tsc` con TS2300 (Duplicate identifier).
3. Subito dopo la fine di `checkDepth` (la graffa che chiude la funzione, oggi L117) inserisci:

```ts
/** Centre of the transparent-order scene: far from the twins (|x| <= 18, |y| <= 10 at zoom 1) and the depth scene (x ~ 34..46). */
const ORDER_X = -80;
const ORDER_Y = -60;
/** The 128×128 PNG committed for the sort checks: tier 1, or an overflow tier on a BC7/ASTC device. */
const ORDER_TEXTURE_URL = '/textures/sort-test-128.png';
/** Per-channel tolerance on scene-hdr (rgba16float) against the closed form. */
const ORDER_TOLERANCE = 0.02;
/** Flat colours of the order scene. */
const TINT: Record<'green' | 'red' | 'teal' | 'blue' | 'yellow' | 'magenta' | 'cyan', Rgb> = {
  green: [0, 1, 0],
  red: [1, 0, 0],
  teal: [0.25, 0.75, 0.5],
  blue: [0.1, 0.3, 0.9],
  yellow: [1, 1, 0],
  magenta: [1, 0, 1],
  cyan: [0, 1, 1],
};

/**
 * Overlapping `.transparent()` sprites of DIFFERENT primitive types, drawn in
 * depth order (design 5b §7.3.4). Before phase 5b transparent draws went by
 * primitive type (quads first, box shadows last), then cull order: each pair
 * is chosen so that order gives another colour, and the check refuses a pair
 * whose two orders look alike. Six cells a whole number of pixels apart:
 *  0: a green gradient (type 4) in front of a red box shadow at alpha 0.5 (type 5);
 *  1: the textured quad (type 0) in front of a teal gradient (type 4);
 *  2: the same textured quad alone, over the clear;
 *  3: the same textured quad over an OPAQUE white quad (2 and 3 measure the
 *     texel's colour and alpha, which the PNG decides);
 *  4: a tie at depth 2: a blue box shadow (lower id) and a yellow gradient (higher id: in front);
 *  5: a tie at depth 2 of two gradients: magenta (lower id) and cyan (higher id: in front).
 * Then depths change at runtime: cell 0's gradient and cell 1's quad go
 * behind their partner, and cell 5's cyan behind the magenta (a depth beats
 * an id). Expected values: blend-expect.ts. The scene is destroyed afterwards.
 */
async function checkTransparentDepth(engine: Hyperion, reporter: TestReporter): Promise<void> {
  const name = 'Depth orders transparent sprites';
  if (!engine.debug) {
    reporter.skip(name, 'pixel probe unavailable: production build');
    return;
  }
  let texture: TextureHandle;
  try {
    texture = await engine.loadTexture(ORDER_TEXTURE_URL);
  } catch (err) {
    // No main-thread renderer (Mode A): the probe does not exist there either.
    reporter.skip(name, `test texture unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  fitView(engine, ORDER_X, ORDER_Y, 9);
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const width = canvas?.width ?? 1;
  const height = canvas?.height ?? 1;
  const vp = engine.cam.viewProjection;
  // Cells a whole number of pixels apart: the textured quads of cells 1, 2 and
  // 3 then sample the same texel at their probe points.
  const worldPerPx = 2 / (vp[0] * width);
  const step = Math.round(2.6 / worldPerPx) * worldPerPx;
  const cellX = (k: number) => ORDER_X + (k - 2.5) * step;
  // A world point moved to the centre of its texel (the probe floors uv * size).
  const snap = (x: number, y: number): [number, number] => {
    const [u, v] = worldToUv(x, y, vp);
    const cu = (Math.floor(u * width) + 0.5) / width;
    const cv = (Math.floor(v * height) + 0.5) / height;
    return [((cu - 0.5) * 2 - vp[12]) / vp[0], ((0.5 - cv) * 2 - vp[13]) / vp[5]];
  };
  const [p0x, p0y] = snap(cellX(0) + 0.2, ORDER_Y + 0.15);
  const points: [number, number][] = [
    snap(ORDER_X, ORDER_Y + 2.5),         // 0: the clear, no sprite
    snap(cellX(3) + 1.1, ORDER_Y + 0.15), // 1: cell 3's white quad, outside its textured quad
    ...[0, 1, 2, 3, 4, 5].map((k): [number, number] => [p0x + k * step, p0y]), // 2-7: cells 0-5
  ];

  const own: EntityHandle[] = [];
  const depthOf = new Map<EntityHandle, number>();
  const sprite = (k: number, depth: number, size = 2): EntityHandle => {
    const h = engine.spawn({ mode: '2d' }).position(cellX(k), ORDER_Y).scale(size, size).depth(depth);
    depthOf.set(h, depth);
    own.push(h);
    entities.push(h);
    return h;
  };
  const setDepth = (h: EntityHandle, depth: number) => {
    h.depth(depth);
    depthOf.set(h, depth);
  };
  // stop0Pos 2 lies past every t in [0, 1]: the whole gradient is stop0, a flat colour at alpha 1.
  const flat = (h: EntityHandle, [r, g, b]: Rgb) => h.transparent().gradient(0, 0, [2, r, g, b, 3, 0]);
  // No blur, no corner radius, the rect the whole quad: a flat colour at alpha a.
  const shadow = (h: EntityHandle, [r, g, b]: Rgb, a: number) => h.transparent().boxShadow(1, 1, 0, 0, r, g, b, a);

  let green!: EntityHandle;
  let red!: EntityHandle;
  let quad!: EntityHandle;
  let teal!: EntityHandle;
  let blue!: EntityHandle;
  let yellow!: EntityHandle;
  let magenta!: EntityHandle;
  let cyan!: EntityHandle;
  engine.batch(() => {
    green = flat(sprite(0, 1), TINT.green);
    red = shadow(sprite(0, 2), TINT.red, 0.5);
    quad = sprite(1, 1).transparent().texture(texture);
    teal = flat(sprite(1, 2), TINT.teal);
    sprite(2, 1).transparent().texture(texture);
    sprite(3, 1).transparent().texture(texture);
    sprite(3, 5, 2.4);                           // opaque and untextured: white, behind
    blue = shadow(sprite(4, 2), TINT.blue, 0.6); // spawned first: the lower id
    yellow = flat(sprite(4, 2), TINT.yellow);
    magenta = flat(sprite(5, 2), TINT.magenta);
    cyan = flat(sprite(5, 2), TINT.cyan);
  });
  await frames(4);

  try {
    await pixelCheck(reporter, name, engine, async (probe) => {
      const read = async (): Promise<Rgb[]> =>
        (await probe('scene-hdr', points)).map(([r, g, b]): Rgb => [r, g, b]);
      const judge = (v: Rgb[]) => {
        const [bg, white, c0, c1, alone, onWhite, c4, c5] = v;
        const texel = measuredLayer(alone, bg, onWhite, white);
        const pairs: Array<{ cell: number; got: Rgb; sprites: Array<[EntityHandle, Layer]> }> = [
          { cell: 0, got: c0, sprites: [[green, straight(TINT.green, 1)], [red, straight(TINT.red, 0.5)]] },
          { cell: 1, got: c1, sprites: [[quad, texel], [teal, straight(TINT.teal, 1)]] },
          { cell: 4, got: c4, sprites: [[blue, straight(TINT.blue, 0.6)], [yellow, straight(TINT.yellow, 1)]] },
          { cell: 5, got: c5, sprites: [[magenta, straight(TINT.magenta, 1)], [cyan, straight(TINT.cyan, 1)]] },
        ];
        return pairs.map(({ cell, got, sprites }) => {
          const sorted = sprites.map(([h, layer]) => ({ depth: depthOf.get(h)!, id: h.id, layer }));
          const want = expectedOverlap(bg, sorted);
          // The same two layers the other way round: if they look alike, the pair proves nothing.
          const other = composite(bg, backToFront(sorted).reverse().map((s) => s.layer));
          return {
            cell, got, want,
            ok: maxChannelDiff(got, want) <= ORDER_TOLERANCE,
            telling: maxChannelDiff(want, other) > 0.1,
          };
        });
      };
      const show = (ps: ReturnType<typeof judge>) =>
        ps.map((p) => `cell ${p.cell} (${fmt(p.got)}) want (${fmt(p.want)})`).join('; ');

      // Stable: right on 10 consecutive frames.
      const first = judge(await read());
      let rightFrames = first.every((p) => p.ok) ? 1 : 0;
      for (let f = 1; f < 10; f++) if (judge(await read()).every((p) => p.ok)) rightFrames++;
      // Swapped at runtime.
      setDepth(green, 3);
      setDepth(quad, 3);
      setDepth(cyan, 3);
      await frames(4);
      const after = judge(await read());
      const telling = [...first, ...after].every((p) => p.telling);
      return {
        ok: rightFrames === 10 && after.every((p) => p.ok) && telling,
        detail: `${show(first)}; right on ${rightFrames}/10 frames; after swapping depths: ${show(after)}`
          + (telling ? '' : '; a pair looks the same in both orders (is the texel at the probe point transparent, or teal?)'),
      };
    });
  } finally {
    for (const h of own) if (h.alive) h.destroy();
  }
}
```

4. In `setup`, subito dopo la riga `await checkDepth(engine, reporter);` (prima del `fitView` finale che ripristina la vista delle coppie, e senza toccare i check che il Task 17 ha aggiunto) inserisci:

```ts
    // ── 4. Depth: overlapping TRANSPARENT sprites, sorted on the GPU (phase 5b) ──
    await checkTransparentDepth(engine, reporter);
```

- [ ] **Step 6: Tipi e suite**

Run:
```bash
npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"
npm --prefix ts test
```
Expected: `tsc` senza output; vitest verde (+14 test, +1 file rispetto al Task 19).

- [ ] **Step 7: Il check passa sulla GPU, in Mode B e in Mode C**

Il server MCP è **chrome-devtools-gpu**; il dev server deve rispondere `200` (`curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/`). `list_pages` → `pageId` (o `new_page` con `url: "about:blank"`); `pageId` su ogni chiamata MCP che segue e `waitForStableDom: false` su ogni `evaluate_script`.
1. `navigate_page` con `type: "url"`, `url: "http://localhost:5173/?mode=B"`, `ignoreCache: true`, `initScript`:
   ```js
   GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)
   ```
2. `resize_page` con `width: 1920`, `height: 1080`, poi di nuovo lo stesso `navigate_page` (con l'`initScript`), così la pagina parte a quella dimensione.
3. `list_console_messages` (`types: ["log", "info", "warn"]`): adapter AMD.
4. `evaluate_script` con:
   ```js
   async () => {
     const KEY = 'twin-2d', LABEL = '2D Twins';
     const section = (await import(`/src/demo/${KEY}.ts`)).default;
     const setup = section.setup;
     let done;
     const finished = new Promise((r) => { done = r; });
     section.setup = async function (...a) { try { return await setup.apply(this, a); } finally { section.setup = setup; done(); } };
     [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes(LABEL)).click();
     await Promise.race([finished, new Promise((r) => setTimeout(r, 60000))]);
     await new Promise((r) => setTimeout(r, 600));
     return [...document.querySelectorAll('.check-item')].map((item) => ({
       name: item.querySelector('.check-name')?.textContent,
       status: [...item.querySelector('.check-icon').classList].find((c) => c !== 'check-icon'),
       detail: item.nextElementSibling?.classList.contains('check-detail') ? item.nextElementSibling.textContent : '',
     }));
   }
   ```
5. `list_console_messages` (`types: ["error", "warn"]`).
6. Ripeti i passi 1-5 con `url: "http://localhost:5173/?mode=C"`.

Expected, in entrambi i modi:
- 'Depth orders transparent sprites' è `pass`. Il `detail` mostra per le celle 0/1/4/5 valori entro 0,02 dai `want`, "right on 10/10 frames" e, dopo lo scambio: cella 0 ≈ (0.500, 0.500, 0.000), cella 1 ≈ (0.250, 0.750, 0.500), cella 4 ≈ (1.000, 1.000, 0.000), cella 5 ≈ (1.000, 0.000, 1.000);
- 'Depth orders 2D sprites', 'Twins draw the same pixels', 'GPU rows of 2D entities' e 'Transparent sort matches the oracle' sono `pass`; 'Transparent sort under churn' è `pass` in Mode C e `skip` in Mode B;
- in console nessun errore WebGPU/validation/pipeline/device; solo il 404 di `favicon.ico`.

- [ ] **Step 8: Il check vede davvero l'ordine sbagliato**

Rimetti temporaneamente nel working tree il `forward-pass.ts` di prima del Task 19 (i trasparenti tornano ai 6 draw per tipo):
```bash
SHA19=$(git log --format=%h -1 --grep='draw uber dei trasparenti')
git diff "$SHA19~1" "$SHA19" -- ts/src/render/passes/forward-pass.ts | git apply -R
```
La modifica di un file TS ricarica la pagina SENZA l'`initScript` (la pagina prende NVIDIA e perde il device): rifai i passi 1-4 dello Step 7 in `?mode=B`.

Expected: 'Depth orders transparent sprites' è `fail`. Nel `detail` le celle 0, 1 e 4 sono sbagliate: cella 0 ≈ (0.500, 0.500, 0.000) invece del verde, perché il box shadow si disegna per ultimo; cella 1 ≈ (0.250, 0.750, 0.500), perché il gradiente copre il quad; cella 4 ≈ (0.460, 0.580, 0.540), perché lo shadow copre il giallo. La cella 5 può passare o no: lì decide l'ordine del cull.

Poi ripristina e riverifica:
```bash
git checkout -- ts/src/render/passes/forward-pass.ts
git status --short
```
Expected: `git status` mostra solo le modifiche di questo task (`ts/src/demo/twin-2d.ts`). Rifai i passi 1-4 dello Step 7 in `?mode=B`: il check torna `pass`.

- [ ] **Step 9: Commit**

```bash
git add ts/src/demo/twin-2d.ts
git commit -m "test(5b): check 'Depth orders transparent sprites' nel tab 2D Twins" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21: cancello GPU del passo 4

Il cancello del passo 4 (spec §8): WASM ricostruita; tutti i 10 tab catturati in Mode B e in Mode C con lo script di cattura committato al passo 0; check nuovi verdi; stati uguali alla baseline per i check della baseline, e ogni check nuovo `pass` (l'unica eccezione, 'Transparent sort under churn' in `skip` nel Mode B, passata a `--allow-new-skip`); `compare.mjs`: i punti di C \ T identici al bit, quelli di C ∩ T entro 1/255; benchmark con lo scenario committato → `bench-step4.json`; il delta del `forward` rispetto al passo 3 misurato e documentato.

**Files:**
- Create: `docs/plans/assets/2026-09-27-transparent-sort-bench-step4.json`, `docs/plans/assets/2026-09-27-transparent-sort-step4-compare-B.txt`, `docs/plans/assets/2026-09-27-transparent-sort-step4-compare-C.txt`
- Modify: `docs/plans/2026-09-27-transparent-sort-uber-design.md` (sezione nuova in fondo: `## 11. Misure (passi 0-4)`)
- Uses (non modificati): `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js`, `.../compare.mjs` (Task 3), `docs/plans/assets/2026-09-27-transparent-sort-bench.js` e `...-bench-step{0,1,3}.json` (Task 2, 8, 18)

**Interfaces:**
- Consumes:
  - `capture.js`: corpo di `evaluate_script`, solo su una pagina `?bench` (altrimenti lancia `capture from a ?bench page`); la procedura è quella del Task 3 Step 9: il tab si sceglie con `window.__captureOpts = { tab: '<key>' }` impostato da un `evaluate_script` precedente, e `window.__captureOpts = { statuses: true }` + `capture.js` producono `statuses-<mode>.json`
  - `compare.mjs`: `node compare.mjs --base <dir> --run <dir> --mode B|C --step 4 [--allow-new-skip '<check>' …]` (`parseArgs` stretto: niente argomenti posizionali né opzioni diverse da queste); exit 0 PASS, 1 FAIL, 2 input sbagliato; carica sempre `statuses-<mode>.json` da `--base` e da `--run`
  - `bench.js`: corpo di `evaluate_script` su `http://localhost:5173/?mode=B&bench`, opzioni in `window.__benchOpts = { label, sizes? }`; restituisce `{ …, label, results: [{ N, zMode, …, stages, sort, forward, total, passes }] }` (medie del profiler per pass e per stadio); i consumatori leggono `results[i].sort/.forward/.total` per coppia `(N, zMode)`
- Produces: la corsa del passo 4 (file di confronto committati, `bench-step4.json`, §11 della spec)

- [ ] **Step 1: WASM e dev server aggiornati**

```bash
npm --prefix ts run build:wasm
```
Expected: `wasm-pack` termina senza errori e aggiorna `ts/wasm/`.

Riavvia il dev server (sul branch sono cambiati shader e moduli; un server vecchio può servire un `?import&raw` stantio con un 304): ferma il task in background che lo esegue, poi avvialo di nuovo in background (Bash `run_in_background`) con `npm --prefix ts run dev -- --strictPort --port 5173`. Verifica: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/` → `200`.

- [ ] **Step 2: Precondizioni headless**

```bash
npm --prefix ts test
npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"
mkdir -p /tmp/claude-1000/5b-runs/step4
```
Expected: vitest verde, `tsc` senza output.

- [ ] **Step 3: Cattura in Mode B**

Con **chrome-devtools-gpu**, la procedura del Task 3 Step 9 alla lettera, con `MODE = B` e `DIR = /tmp/claude-1000/5b-runs/step4` (creata allo Step 2). Ogni chiamata MCP porta il `pageId`; ogni `evaluate_script` porta anche `waitForStableDom: false` (il pannello dei check si ridisegna ogni 500 ms e l'HUD a ogni frame: il DOM non si assesta mai).
1. `list_pages` → `pageId` (o `new_page` con `url: "about:blank"`).
2. `resize_page` con `pageId`, `width: 1920`, `height: 1080`: PRIMA della navigazione, così la pagina parte a quella dimensione.
3. `navigate_page` con `pageId`, `type: "url"`, `url: "http://localhost:5173/?mode=B&bench"`, `ignoreCache: true`, `initScript`:
   ```js
   GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)
   ```
   Senza `&bench` il primo `capture.js` lancia `capture from a ?bench page` (senza il flag Primitives si apre al caricamento, fuori dalla cattura).
4. `list_console_messages` con `pageId`, `types: ["info", "warn"]`: la riga dell'adapter deve dire `amd` (annotala) e c'è la riga `[Hyperion] ?bench: no section opened; window.__hyperion is the engine`.
5. Leggi con Read `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js`. Per ogni chiave K, in quest'ordine fisso, **una volta sola** in questa navigazione: `primitives`, `scene-graph`, `input`, `audio`, `particles`, `rendering-fx`, `lighting`, `debug-tools`, `lifecycle`, `twin-2d`:
   - `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__captureOpts = { tab: 'K' }; return true; }"` (con la chiave vera al posto di `K`);
   - `evaluate_script` con `pageId`, `waitForStableDom: false`, `function` = il contenuto di `capture.js` alla lettera e `filePath: "/tmp/claude-1000/5b-runs/step4/B-K.json"`.
6. Gli stati, nella stessa corsa: `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__captureOpts = { statuses: true }; return true; }"`; poi `evaluate_script` con `pageId`, `waitForStableDom: false`, `function` = `capture.js` alla lettera e `filePath: "/tmp/claude-1000/5b-runs/step4/statuses-B.json"`.
7. Se una chiamata dei punti 5-6 restituisce un errore, la cattura è da buttare: rifai dal punto 3 (navigazione nuova) e riscrivi tutti i file `B-*.json` e `statuses-B.json`.
8. `list_console_messages` (`pageId`, `types: ["error", "warn"]`) e `list_network_requests` (`pageId`): l'unico errore ammesso è il 404 di `favicon.ico`; niente che nomini WebGPU, validation, pipeline o device.

Expected: 10 file `B-<key>.json` più `statuses-B.json` in `/tmp/claude-1000/5b-runs/step4/`.

- [ ] **Step 4: Confronto con la baseline (Mode B)**

```bash
node docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs \
  --base docs/plans/assets/2026-09-27-transparent-sort-baseline \
  --run /tmp/claude-1000/5b-runs/step4 --mode B --step 4 \
  --allow-new-skip 'Transparent sort under churn' \
  | tee docs/plans/assets/2026-09-27-transparent-sort-step4-compare-B.txt; echo "exit=${PIPESTATUS[0]}"
```
Expected, `exit=0`, l'ultima riga del report `PASS`, e nel report:
- canvas e `devicePixelRatio` uguali a quelli della baseline;
- **stati** (`B statuses      OK`): ogni check della baseline ha lo stesso stato che aveva lì. Per ogni tab gli stessi check in `skip`/`pending` della baseline (Input 2/6 con 4 `pending` d'interazione, 'Tonemap switch' in `skip`, l'MSDF di Primitives in `skip`, un check di Debug Tools in `skip`); ogni check che passava passa; 'Velocity' (Scene Graph) e 'Backend lit' (Lighting) arrivano a `pass`. Ogni check che NON è nella baseline deve essere `pass`; l'unica eccezione è un check nominato da `--allow-new-skip`, che può essere `skip`. Quindi 'Transparent sort matches the oracle' e 'Depth orders transparent sprites' devono passare, e 'Transparent sort under churn' è `skip` (in Mode C deve passare, e lì non si passa `--allow-new-skip`);
- **pixel**: in C \ T 0 punti diversi al bit; in C ∩ T nessun canale con |Δ| > 1/255 (0,00392). Il tab Lighting non contribuisce punti;
- ogni tab ha una riga `OK`: Lighting `excluded (Lighting: statuses only)`, tutti gli altri `C=… (grid N/2304) C\T=… C∩T=…` con N ≥ 1152 (una riga `… is not bit-exact …` vuol dire che la camera o la dimensione di `scene-hdr` è cambiata nella finestra: si rifà la cattura).

Se un punto di C \ T differisce, o uno di C ∩ T supera 1/255, o un check della baseline non passa più: è una regressione dell'uber, non un ordine nuovo (spec §7.3.5; nessun check esistente dipende dall'ordine dei trasparenti). Fermati e segui `superpowers:systematic-debugging` prima di andare avanti.

- [ ] **Step 5: I check nuovi di 2D Twins (Mode B)**

Il pannello mostra ancora il tab 2D Twins: `capture.js` clicca i tab uno per uno e 2D Twins è l'ultimo; la chiamata degli stati non cambia tab. `evaluate_script` con `pageId`, `waitForStableDom: false` e:
```js
() => [...document.querySelectorAll('.check-item')].map((item) => ({
  name: item.querySelector('.check-name')?.textContent,
  status: [...item.querySelector('.check-icon').classList].find((c) => c !== 'check-icon'),
  detail: item.nextElementSibling?.classList.contains('check-detail') ? item.nextElementSibling.textContent : '',
}))
```
Expected: 'Depth orders transparent sprites' `pass` (10/10 frame, poi i valori dopo lo scambio come nel Task 20); 'Transparent sort matches the oracle' `pass`; 'Transparent sort under churn' `skip` (solo Mode C); 'Depth orders 2D sprites', 'Twins draw the same pixels', 'GPU rows of 2D entities' `pass`.

- [ ] **Step 6: Cattura, confronto e check nuovi in Mode C**

Ripeti gli Step 3-5 con `MODE = C`: navigazione nuova (punti 2-3 dello Step 3) a `url: "http://localhost:5173/?mode=C&bench"`, i file `C-<key>.json` e `statuses-C.json` (punto 6, `filePath: "/tmp/claude-1000/5b-runs/step4/statuses-C.json"`) nella stessa cartella, e:
```bash
node docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs \
  --base docs/plans/assets/2026-09-27-transparent-sort-baseline \
  --run /tmp/claude-1000/5b-runs/step4 --mode C --step 4 \
  | tee docs/plans/assets/2026-09-27-transparent-sort-step4-compare-C.txt; echo "exit=${PIPESTATUS[0]}"
```
Expected: gli stessi criteri del Mode B (exit 0, ultima riga `PASS`), senza `--allow-new-skip`: in 2D Twins anche 'Transparent sort under churn' è `pass` (un `skip` qui fa FAIL con `new check 'Transparent sort under churn' is skip`), e 'GPU rows of 2D entities' con frame via scatter.

- [ ] **Step 7: Benchmark del passo 4**

Stesso `pageId` degli Step 3-6; ogni `evaluate_script` con `pageId` e `waitForStableDom: false`.
1. `resize_page` con `pageId`, 1920×1080, poi `navigate_page` con `pageId`, `type: "url"`, `url: "http://localhost:5173/?mode=B&bench"` (l'URL canonico del Task 2), `ignoreCache: true` e lo stesso `initScript`. È una pagina nuova: nessun probe della swapchain in questa sessione (il primo riconfigura la canvas con `TEXTURE_BINDING` e cambia i tempi).
2. `list_console_messages` (`pageId`, `types: ["info", "warn"]`): adapter AMD e la riga `?bench`.
3. Bash `git rev-parse --short HEAD` → `<SHA>`. Poi `evaluate_script` con `pageId`, `waitForStableDom: false`, `function: "() => { window.__benchOpts = { label: 'step4 <SHA>' }; return true; }"` (con lo SHA vero al posto di `<SHA>`).
4. `evaluate_script` con `pageId`, `waitForStableDom: false`, `function` = il contenuto di `docs/plans/assets/2026-09-27-transparent-sort-bench.js` alla lettera e `filePath: "/home/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-09-27-transparent-sort-bench-step4.json"`. Dura uno o due minuti.
5. Se la chiamata va in timeout: non continuare su quella pagina. Rifai il punto 1, poi tre coppie di chiamate, per N = 1000, 10000, 100000 in quest'ordine: `window.__benchOpts = { label: 'step4 <SHA>', sizes: [N] }` e poi lo scenario con lo stesso `filePath` (come il Task 2 Step 4.4). Ogni chiamata restituisce tutti i risultati accumulati, quindi l'ultimo file li contiene tutti e sei.
6. `list_console_messages` (`pageId`, `types: ["error", "warn"]`): nessun errore WebGPU.

Expected: il file JSON esiste, ha `label: 'step4 <SHA>'` e sei `results`, uno per coppia `(N, zMode)`: N = 1 000, 10 000 e 100 000, `zMode` `same` e `distinct`.

- [ ] **Step 8: Delta del `forward` e del `total`, e il sort**

Dalla radice del repo (i risultati si confrontano per coppia `(N, zMode)`, mai per posizione nell'array):
```bash
node - <<'EOF'
const fs = require('node:fs');
const steps = [0, 1, 3, 4];
const runs = steps.map((s) => JSON.parse(fs.readFileSync(`docs/plans/assets/2026-09-27-transparent-sort-bench-step${s}.json`, 'utf8')));
runs.forEach((j, i) => console.log(`step${steps[i]} label: ${j.label}`));
const [s0, s1, s3, s4] = runs.map((j) => j.results);
const at = (list, r) => list.find((x) => x.N === r.N && x.zMode === r.zMode) ?? {};
const f = (x) => (typeof x === 'number' ? x.toFixed(3) : '—');
const d = (a, b) => (typeof a === 'number' && typeof b === 'number' ? (a - b).toFixed(3) : '—');
console.log('N\tz\tfwd0\tfwd1\tfwd3\tfwd4\tfwd1-0\tfwd4-3\ttot0\ttot1\ttot3\ttot4\ttot1-0\ttot4-3\tsort3\tsort4');
for (const r of s4) {
  const [a, b, c] = [s0, s1, s3].map((l) => at(l, r));
  console.log([r.N, r.zMode, f(a.forward), f(b.forward), f(c.forward), f(r.forward), d(b.forward, a.forward), d(r.forward, c.forward),
    f(a.total), f(b.total), f(c.total), f(r.total), d(b.total, a.total), d(r.total, c.total), f(c.sort), f(r.sort)].join('\t'));
}
const bad = [];
if (s4.length !== 6) bad.push(`${s4.length} results`);
const big = s4.filter((r) => r.N === 100000);
if (big.length !== 2) bad.push(`${big.length} results at N=100000`);
for (const r of big) if (!(typeof r.sort === 'number' && r.sort < 1)) bad.push(`N=100000 z=${r.zMode}: sort ${r.sort}`);
if (bad.length) { console.error('BAD: ' + bad.join('; ')); process.exit(1); }
console.log('step 4 bench OK');
EOF
```
Expected: quattro righe `stepN label: stepN <sha>`, l'intestazione, sei righe identificate da `(N, z)` (nessun `—` nelle colonne dei passi 0, 1, 3 e 4 di `forward` e `total`, né in `sort3`/`sort4`), poi `step 4 bench OK`, exit 0. Il `typeof` nel controllo serve: in JS `null < 1` è vero. **Il sort a 100 000 (depth uguali e distinte) resta < 1 ms anche al passo 4:** un exit 1 blocca la fase (la soglia di D3 è un criterio della fase); fermati.

Il profiler separa i pass con compute pass vuoti, e parte del lavoro dei frammenti del `forward` può cadere nella finestra del pass successivo (Task 2, Step 5): i delta del `forward` si leggono sempre insieme a quelli di `total`.

- [ ] **Step 9: Le misure nella spec**

In fondo a `docs/plans/2026-09-27-transparent-sort-uber-design.md` aggiungi la sezione seguente (se un task precedente ha già creato un `## 11`, sostituiscilo per intero con questa). Le celle si riempiono con i numeri stampati dallo Step 8, una riga per coppia `(N, z)` (`same` = tutte a 0, `distinct` = distinte): `fwd0`…`fwd4` nelle colonne del forward, `fwd1-0`/`fwd4-3` in "1−0"/"4−3", `tot1-0`/`tot4-3` in "total 1−0"/"total 4−3", `sort3`/`sort4` nelle ultime due. L'adapter del paragrafo è la riga annotata allo Step 3.

```markdown
## 11. Misure (passi 0-4)

Scenario committato `assets/2026-09-27-transparent-sort-bench.js`, iGPU AMD (adapter low-power), canvas 1920×1080, illuminazione spenta, profiler acceso, media della finestra da 120 frame senza readback. Valori in ms; i JSON sono `assets/2026-09-27-transparent-sort-bench-step{0,1,3,4}.json`.

| Quad trasparenti | Depth | forward p.0 | forward p.1 | forward p.3 | forward p.4 | 1−0 (composizione) | 4−3 (draw uber) | total 1−0 | total 4−3 | sort p.3 | sort p.4 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 000 | tutte a 0 | | | | | | | | | | |
| 1 000 | distinte | | | | | | | | | | |
| 10 000 | tutte a 0 | | | | | | | | | | |
| 10 000 | distinte | | | | | | | | | | |
| 100 000 | tutte a 0 | | | | | | | | | | |
| 100 000 | distinte | | | | | | | | | | |

- 1−0 è il costo della composizione (moduli composti, `VertexOutput` più largo).
- 4−3 è il costo del passaggio al draw uber nel suo insieme: la pipeline uber, l'ordine ordinato, un draw al posto di 12. Non va attribuito alla sola pressione sui registri.
- Il profiler separa i pass con compute pass vuoti e parte dei frammenti del forward può cadere nel pass successivo: i delta del `forward` vanno letti insieme a quelli di `total` (somma di tutti i pass).
- "sort" è la somma delle medie di `transparent-sort/{gather,upsweep,scan,scatter}`. Con il profiler sono 22 compute pass più i marker contro 1, quindi è un limite superiore del costo in produzione. Soglia (D3): < 1 ms a 100 000.
- Cancello del passo 4: `assets/2026-09-27-transparent-sort-step4-compare-{B,C}.txt` (C \ T identici al bit, C ∩ T entro 1/255, stati uguali alla baseline).
```

- [ ] **Step 10: Commit**

```bash
git add docs/plans/assets/2026-09-27-transparent-sort-bench-step4.json \
  docs/plans/assets/2026-09-27-transparent-sort-step4-compare-B.txt \
  docs/plans/assets/2026-09-27-transparent-sort-step4-compare-C.txt \
  docs/plans/2026-09-27-transparent-sort-uber-design.md
git commit -m "test(5b): cancello GPU del passo 4 — check nuovi verdi, baseline invariata, forward misurato" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 22: documentazione e strumenti (§9 della spec)

Tutti i testi che descrivono ancora uno shader per primitiva, `RadixSortPass`, gli id "solo CPU" o i vecchi conti. Ogni sostituzione qui sotto dà il testo nuovo esatto. Le righe di tabella e i bullet lunghi si individuano con il loro inizio e si sostituiscono per intero; le sostituzioni parziali danno la stringa vecchia esatta. Si usa lo strumento Edit, non riscritture scriptate: CLAUDE.md avverte che una riscrittura da un'ancora ha già fatto sparire 142 righe.

**Files:**
- Modify: `CLAUDE.md`, `PROJECT_ARCHITECTURE.md`, `hyperion-masterplan.md` (tabella "Rischi Rendering"), `.claude/skills/new-primitive/SKILL.md`, `.claude/skills/gpu-check/SKILL.md`, `.claude/agents/wgsl-validator.md`, `.claude/agents/webgpu-pass-reviewer.md`, `.claude/agents/claude-md-auditor.md` (§8, L82-89), `.claude/hooks/post-edit-notices.sh`, `.claude/hooks/README.md`
- Modify (solo commenti): `ts/src/entity-handle.ts` (JSDoc di `depth()` e `transparent()`), `ts/src/prim-params-schema.ts:8`, `ts/src/demo/primitives.ts:52`, `ts/src/render/primitive-bindings.ts` (L3-6, L14-15, L29, L33), `ts/src/render/passes/occluder-seed-stage.ts` (L23, L30-35), `ts/src/hyperion.ts:745`

**Interfaces:**
- Consumes: i nomi prodotti dai Task 1-21 (file, funzioni, esportazioni WASM, check, statiche); i numeri del §11 della spec (Task 21)
- Produces: documentazione allineata al codice; hook dei WGSL diviso per percorso

- [ ] **Step 1: Conta i test**

```bash
cd /home/edoardocicognani/Code/HyperionEngine
lib() { cargo test -p hyperion-core --lib "$@" 2>&1 | grep -oE 'ok. [0-9]+ passed' | awk '{print $2}'; }
sum() { grep -oE 'ok. [0-9]+ passed' | awk '{s+=$2} END {print s}'; }
echo "lib: none=$(lib) physics-2d=$(lib --features physics-2d) dev-tools=$(lib --features dev-tools) all=$(lib --all-features)"
echo "total: none=$(cargo test -p hyperion-core 2>&1 | sum) physics-2d=$(cargo test -p hyperion-core --features physics-2d 2>&1 | sum) dev-tools=$(cargo test -p hyperion-core --features dev-tools 2>&1 | sum) all=$(cargo test -p hyperion-core --all-features 2>&1 | sum)"
for m in ring_buffer render_state components; do echo "$m=$(lib "$m")"; done
echo "engine=$(lib engine) +physics=$(lib --features physics-2d engine) +physics+dev=$(lib --features 'physics-2d dev-tools' engine) all=$(lib --all-features engine)"
echo "command_proc=$(lib command_proc) +physics=$(lib --features physics-2d command_proc)"
echo "systems=$(lib systems) +physics=$(lib --features physics-2d systems)"
for t in verify_findings verify_physics verify_ring verify_hier verify_snapshot verify_determinism verify_reuse verify_2d; do
  echo "$t=$(cargo test -p hyperion-core --all-features --test "$t" 2>&1 | grep -oE 'ok. [0-9]+ passed' | awk '{print $2}')"
done
npm --prefix ts test 2>&1 | grep -E 'Test Files|Tests '
for f in hyperion backpressure entity-handle render/passes/cull-pass physics-api lighting-api; do
  echo "$f: $(npx --prefix ts vitest run --root ts "src/$f.test.ts" 2>&1 | grep -E '^ +Tests ')"
done
```
Expected: una riga per ciascun numero. Annota i valori: servono allo Step 2.

- [ ] **Step 2: I conti in testa a CLAUDE.md**

Con i valori dello Step 1, in `CLAUDE.md` aggiorna ogni numero di queste righe (i testi restano, cambiano solo le cifre):
- `cargo test -p hyperion-core                  # All Rust unit tests (203 tests, 281 with physics-2d, 232 with dev-tools, 325 with all features)` → `lib` none / physics-2d / dev-tools / all;
- `# + 98 integration tests across 8 files (325 lib + 98 = 423 total)` → integrazione = total all − lib all; lib all; total all;
- i sei gruppi per modulo (`ring_buffer` 42; `engine` 16 / 25 / 64; `render_state` 55; `command_proc` 40 / 41; `systems` 24 / 26; `components` 28), con i valori `ring_buffer`, `engine`/`+physics`/`+physics+dev`, `render_state`, `command_proc`/`+physics`, `systems`/`+physics`, `components`;
- `# All vitest tests (1339 tests + 5 skipped, 95 files)` e `# 95 test files colocated …` → dalle righe `Test Files`/`Tests`;
- i sei esempi `(92 tests)`, `(101 tests)`, `(87 tests)`, `(43 tests)`, `(20 tests)`, `(21 tests)` → dalle righe per file;
- `# Includes physics simulation tests (281 lib tests, 370 with integration)` → lib physics-2d, total physics-2d;
- `# 325 lib tests (423 with integration)` → lib all, total all;
- `# Includes dev-tools gated tests (232 lib tests, 280 with integration)` → lib dev-tools, total dev-tools;
- nel gotcha "Per-module test counts need `--lib`": `(engine: 67 vs 62 — \`physics-debug\` adds 5)` → `all` e `+physics+dev` di `engine`, e la loro differenza;
- in "Regression coverage: 98 tests in … (verify_findings 19, verify_physics 37, verify_ring 8, verify_hier 8, verify_snapshot 5, verify_determinism 4, verify_reuse 10, verify_2d 7)" → la somma e i valori per file.

- [ ] **Step 3: CLAUDE.md, righe Rust dell'architettura**

1. Riga `lib.rs`: la stringa `` `engine_gpu_entity_ids_ptr/len`, `engine_compact_entity_map` `` diventa:
   ~~~~text
   `engine_gpu_entity_ids_ptr/len`, `engine_gpu_transparent_count`, `engine_gpu_entity_ids_generation`, `engine_compact_entity_map`
   ~~~~
2. Riga `engine.rs`: la fine `` `debug_lines: Vec<f32>` regenerated once per frame | `` diventa:
   ~~~~text
   `debug_lines: Vec<f32>` regenerated once per frame. Phase 5b: `ids_generation: u32` (`ids_generation()`), bumped at most once per frame in `update` when `RenderState::take_ids_changed()` reports a slot→id change, and always by `reset()`/`snapshot_restore()` — it lives in `Engine` because both recreate `RenderState` |
   ~~~~
3. Riga `render_state.rs`: la fine `` + `shrink_to_fit()` for memory compaction | `` diventa:
   ~~~~text
   + `shrink_to_fit()` for memory compaction + `recount_transparent()`/`transparent_count()` (bit 8 of renderMeta word 1 over `..gpu_count`, recomputed at the end of `collect_and_cache_dirty` and on restore; an upper bound, transparent Light2D rows included) + `take_ids_changed()` (raised by `assign_slot`, a non-empty `flush_pending_despawns`, `collect_gpu`) |
   ~~~~

- [ ] **Step 4: CLAUDE.md, righe TS del nucleo, bridge e harness**

1. Riga `hyperion.ts`: `` `recompileShader`, `compressionFormat`, `debug` (recording tap). `` diventa:
   ~~~~text
   `recompileShader` (for a primitive name the source is a PIECE, not a module), `compressionFormat`, `debug` (recording tap; dev builds: `probe`, `readEntityTransforms`, `readTransparentSort`).
   ~~~~
2. Riga `types.ts`: la fine `` `SpawnOptions` + `spawnIs2D()` (throws on an unknown mode, before any id is spent) | `` diventa:
   ~~~~text
   `SpawnOptions` + `spawnIs2D()` (throws on an unknown mode, before any id is spent), `MAX_GPU_ENTITIES` (100 000: the rows of every GPU buffer; `validateConfig` rejects a larger `maxEntities`, and it is the default) |
   ~~~~
3. Subito dopo la riga `types.ts` aggiungi:
   ~~~~text
   | `render-state.fixture.ts` | Test fixture `makeRenderState(overrides)`: the one `GPURenderState` literal the tests share (a new field is added once) |
   ~~~~
4. Riga `main.ts`: la fine `` so profiling/outlines/bloom/particles/overlays could not be checked | `` diventa:
   ~~~~text
   so profiling/outlines/bloom/particles/overlays could not be checked. `?bench` (`demo/bench-flag.ts`): no section opens, only `window.__hyperion` — the empty world of the committed benchmark scenario |
   ~~~~
5. Riga `worker-bridge.ts`: la stringa `` `createDirectBridge()` (C) `` diventa:
   ~~~~text
   `createDirectBridge(loadWasm?)` (C; `loadWasm` is a test seam, the default imports `../wasm/hyperion_core.js`)
   ~~~~
   e la fine `` drive the id quarantine | `` diventa:
   ~~~~text
   drive the id quarantine. `GPURenderState.transparentCount`/`entityIdsGeneration` (phase 5b) travel INSIDE `renderState` in all three modes, never on the message |
   ~~~~
6. Riga `engine-worker.ts`: `` Echoes the tick's `seq` in both `tick-done` branches | `` diventa:
   ~~~~text
   Echoes the tick's `seq` in its one `tick-done` message (empty world included); the `renderState` and its transfer list come from `captureRenderState` (`worker-render-state.ts`) |
   ~~~~
7. Riga `render-worker.ts`: `` also when it arrives before the renderer exists | `` diventa:
   ~~~~text
   also when it arrives before the renderer exists. Rebuilds its `GPURenderState` with `toGPURenderState` (`worker-render-state.ts`) |
   ~~~~
8. Subito dopo la riga `worker-bridge.ts` aggiungi:
   ~~~~text
   | `worker-render-state.ts` | Side-effect-free transport of the engine worker's render state (phase 5b): `WasmEngine` (the worker's WASM interface, the two phase-5b exports optional), `WorkerRenderState`, `captureRenderState(wasm)` (both literals: non-empty world with its SoA arrays and transfer list, empty world with neither; `transparentCount`/`entityIdsGeneration` as `?? NaN`, never 0), `toGPURenderState(rs)` (Mode A render worker's rebuild) |
   ~~~~

- [ ] **Step 5: CLAUDE.md, righe della pipeline di rendering**

1. Riga `renderer.ts`: la stringa
   ~~~~text
   shader HMR (20 WGSL files imported, 18 hot-reloadable — `pixel-probe` is dev-only and not one of them; the `sdf-jfa`/`light-accum` slots and the primitive slots probe a throwaway `LightGroupsPass`), device-lost recovery,
   ~~~~
   diventa:
   ~~~~text
   shader HMR (22 WGSL files imported, 20 hot-reloadable — `pixel-probe` is dev-only and not one of them; the 7 primitive PIECES (prelude + 6 libraries) are one slot each: a write recomposes the 6 per-type modules and the uber IN PLACE (`publishPrimitiveShaders`), the probe builds a throwaway `ForwardPass` (6 opaque + the uber pipeline) and `LightGroupsPass` (occluders), and the piece accepts go through a 50 ms `PieceReloadCollector` into `reloadShaders`; `transparent-gather`/`transparent-sort` probe a throwaway `TransparentSortPass`; the `sdf-jfa`/`light-accum` slots probe a throwaway `LightGroupsPass`), device lost: logs it and calls `onDeviceLost`,
   ~~~~
   e la fine `` (so dev GPU timings run on the production configuration until then) | `` diventa:
   ~~~~text
   (so dev GPU timings run on the production configuration until then). Phase 5b: creates the renderer-owned pool buffers `entity-ids` (uploaded whole only when `GPURenderState.entityIdsGeneration` changes, scatter frames included; a NaN generation uploads every frame), `transparent-order` and `transparent-args`; puts the normalized `transparentCount` and `frameStamp` (1..0xFFFFFFFE) into `FrameState`; warns once above `MAX_GPU_ENTITIES`; dev: `sortProbe` (`TransparentSortProbe`), finished right after the graph's submit |
   ~~~~
2. Riga `render/render-pass.ts`: `` `FrameState.lightGroups` (light layers) | `` diventa:
   ~~~~text
   `FrameState.lightGroups` (light layers), `FrameState.transparentCount` (normalized) and `frameStamp` (phase 5b) |
   ~~~~
3. Riga `render/graph-assembly.ts`: `` and `factories.scene(mode)` builds a ForwardPass that reads `light-buffer` | `` diventa:
   ~~~~text
   and `factories.scene(mode)` builds a ForwardPass that reads `light-buffer`. The scene factory is `[ScatterPass, CullPass, TransparentSortPass, ForwardPass]` in all six graphs (phase 5b) |
   ~~~~
4. Riga `render/graph-requests.ts`: `` `setLighting(enabled)` keeps the composite and its options; switching the composite keeps lighting | `` diventa:
   ~~~~text
   `setLighting(enabled)` keeps the composite and its options; switching the composite keeps lighting. `reloadShaders(entries)` (primitive pieces, phase 5b): the UNION of the batch is probed, then each entry alone over the current good sources; all go live if the union passes, none if only the singles pass (a conflict), otherwise the passing subset is probed again as a union — a graph is never built from a set a probe rejected or never tried together; versions are shared with `reloadShader` per name ('superseded') |
   ~~~~
5. Sostituisci per intero la riga che comincia con `` | `render/passes/forward-pass.ts` | `` con:
   ~~~~text
   | `render/passes/forward-pass.ts` | Forward pass to `scene-hdr`. Opaque: one pipeline per primitive type from the COMPOSED per-type modules (`SHADER_SOURCES`), two indirect draws each (buckets 0-13). Transparent (phase 5b): ONE uber pipeline from `UBER_SOURCE` (never in `SHADER_SOURCES`: no `fs_occluder`) and one `drawIndexedIndirect(transparent-args, 0)` with `bindGroup0Sorted` (group 0 whose binding 2 is `transparent-order`: instance i is the i-th sprite back to front), skipped when `FrameState.transparentCount` is 0; `reads` the sort outputs, which keeps `TransparentSortPass` alive and before it. Three-group layout: group 2 = light buffer as a `texture_2d_array` (one layer per light group), filtering sampler, 16-byte `LightingUniform {enabled, groupTableLo, groupTableHi}` rewritten every frame from `FrameState.lightGroups.layerToGroup`; bound for all 7 pipelines. `new ForwardPass({ lit: true })` reads `light-buffer` and follows its view; unlit binds a 1×1 white 2d-array placeholder. Camera uniform 80 B |
   ~~~~
6. Riga `render/light-groups.ts`: `` (`LIT_PRIMITIVE_TYPES` = quad, gradient; a test checks it against the shaders declaring `@group(2)`) `` diventa:
   ~~~~text
   (`LIT_PRIMITIVE_TYPES` = quad, gradient, derived from the `lit` flag of `PRIMITIVE_LIBRARIES`; a test checks it by REACHABILITY: a group-2 name is reachable from a composed `fs_main` iff the type is lit)
   ~~~~
7. Riga `render/passes/occluder-seed-stage.ts`: `` each primitive's own module through `fs_occluder` (`OCCLUDER_PASS = 1`) `` diventa:
   ~~~~text
   each primitive's composed per-type module (prelude + library) through `fs_occluder` (`OCCLUDER_PASS = 1`, declared once in the prelude; the uber module has no `fs_occluder` and never reaches it)
   ~~~~
8. Riga `render/primitive-bindings.ts`: `` The bind group layouts every primitive shader shares (group 0 columns, group 1 texture tiers) `` diventa:
   ~~~~text
   The bind group layouts the prelude declares (group 0 columns, group 1 texture tiers), shared by the 6 per-type pipelines, the uber pipeline and the occluder pipelines (groups 0 and 1 only)
   ~~~~
   e subito dopo quella riga aggiungi:
   ~~~~text
   | `render/primitive-shaders.ts` | Phase 5b composer, pure TS and total (concatenation only, never throws): `PRIMITIVE_LIBRARIES` (`{type, name, prefix, lit}`, types 0-5 — the one source of `LIT_PRIMITIVE_TYPES`), `composeTypeModule`/`composeTypeModules` (prelude + library + generated `vs_main`/`fs_main`/`fs_occluder`), `composeUberModule` (`UBER_DIRECTIVE` first, the prelude, all six libraries, a `vs_main` switching on the type clamped to 6 with Light2D → `culledVertex`, an `fs_main` switching on the flat `primType`). `pieceMarker` puts `// --- piece: <name> ---` before each piece. The statics (`primitivePieces`) and `publishPrimitiveShaders()` live in `renderer.ts`, next to the `?raw` imports their HMR accepts need |
   | `render/piece-reload-collector.ts` | `PieceReloadCollector` — the piece HMR accepts go through it: a trailing 50 ms debounce, the last NON-empty text per piece, then one `GraphRequests.reloadShaders` call; a window of empty saves sends nothing |
   | `render/frame-inputs.ts` | `normalizeTransparentCount` (missing or non-finite → `entityCount`: a lost field costs time, never correctness), `normalizeIdsGeneration` (missing → NaN, which uploads every frame; a constant default would freeze the upload), `nextFrameStamp` (1..0xFFFFFFFE, never 0 or the sentinel), `uploadEntityIds` (the one `entity-ids` upload, called by `renderer.ts` after the scatter/full-upload if/else and before the selection mask), `missingSortInputs` + `overCapacityWarning` (the renderer's one-time warnings) |
   | `render/transparent-sort-probe.ts` | Dev only: `TransparentSortProbe` behind `engine.debug.readTransparentSort()`. One request per frame, FIFO; the live pass copies the gather output, the header, `digitBase`/`diag` and the order into FRESH `MAP_READ` buffers of the request (never `mapAsync` in `prepare`/`execute`); `finish()` snapshots the frame's CPU state and maps. It rejects instead of answering zeros: a wrong stamp in header word 11 (0: the copy did not run, 0xFFFFFFFF: the gather did not run), a validation error in the frame, a frame with a queue and no sort (count 0: the head only), Mode A, paused, `destroy()` |
   ~~~~
9. Sostituisci per intero la riga che comincia con `` | `render/passes/radix-sort-pass.ts` | `` con:
   ~~~~text
   | `render/passes/transparent-sort-pass.ts` | `TransparentSortPass` (phase 5b) — optional graph node between `CullPass` and `ForwardPass`: reads `indirect-args`/`visible-indices`/`entity-bounds`/`entity-ids`, writes `transparent-order`/`transparent-args` (both renderer-owned). `prepare()` writes `GatherParams {limit = B, stamp}`, resets the 64-byte header (`{6,0,0,0,0, 0,1,1, 0, B, 0, 0xFFFFFFFF, …}`) and `diag`; `execute()` never calls `writeBuffer`. The gather (`ceil(B/256)` groups, `B = min(transparentCount, CAP)`) takes buckets 14-25 into SoA keys (`lo` = external id, `hi` = sortable world-z bits) and slots; then 7 × (upsweep, scan, scatter) 8-bit LSD passes, upsweep and scatter dispatched INDIRECTLY from header byte 20; the 7th pass writes values only, into `transparent-order`. Nothing at count 0 (`profileStages` → `[]`). One compute pass (two with a readback, 22 with the profiler: stages `gather`/`upsweep`/`scan`/`scatter`). Private buffers ~2.9 MB fixed, `minBindingSize` on every layout entry |
   | `render/passes/transparent-sort-constants.ts` | The sort's shared constants (`TILE` 1024, `PASSES` 7, `CAP = MAX_GPU_ENTITIES`, the header word indices `H_*`, `DISPATCH_OFFSET_BYTES` 20, `STAMP_SENTINEL`, the `sort-hist` layout), pinned against the WGSL by text tests |
   | `render/passes/transparent-sort-reference.ts` | CPU model of the SAME kernels, phase by phase (one loop over the lanes per barrier interval), with a workgroup-memory race checker and a cross-workgroup conflict checker: `runSortModel`, `oracleOrder`, `sortableZBits`, `digitOf` |
   ~~~~

- [ ] **Step 6: CLAUDE.md, righe del demo**

1. Riga `demo/twin-2d.ts`: la fine `` then again after the depths change at runtime (3 checks) | `` diventa:
   ~~~~text
   then again after the depths change at runtime. Phase 5b: 'Transparent sort matches the oracle' (`readTransparentSort()` on dedicated scenes filling all 12 gather regions, the committed 128×128 PNG included, checked by `verifySortReadback`), 'Transparent sort under churn' (Mode C only: spawns and despawns every frame at equal z, and needs a frame with `usedScatter && idsUploaded`; skipped elsewhere) and 'Depth orders transparent sprites' (overlapping `.transparent()` gradients, box shadows and the textured quad, far off at (-80, -60) and destroyed afterwards: z order, the higher id in front at equal z, flipped at runtime; expected values from `demo/blend-expect.ts`, the texel's colour and alpha measured over the clear and over an opaque white quad) (6 checks) |
   ~~~~
2. Subito dopo la riga `demo/twin-2d.ts` aggiungi:
   ~~~~text
   | `demo/bench-flag.ts` | `isBenchMode(search)`: `?bench` opens no section, so the committed benchmark scenario (`docs/plans/assets/2026-09-27-transparent-sort-bench.js`) runs in an empty world |
   | `demo/transparent-sort-checks.ts` | `verifySortReadback(readback, opts)` — the checks of a `readTransparentSort()` answer (gathered set, keys, order against the oracle, counts, `digitBase`, regions), `regionClass`, `sameIdOrder`, `readSortFrame(read, accept, timeoutMs)` (retries `read` until `accept` holds for an answer: a frame with no transparent entity or not holding the scene yet is retried, any other rejection thrown at once; rejects on timeout) |
   | `demo/blend-expect.ts` | Straight-alpha "over" in closed form for the pixel checks: `straight`, `over`, `composite`, `measuredLayer` (a texel from two reads over two backgrounds), `backToFront` (the sort's order: larger depth first, then ascending id), `expectedOverlap`, `maxChannelDiff` |
   ~~~~

- [ ] **Step 7: CLAUDE.md, tabella degli shader**

1. L'intestazione `` #### Shaders (`ts/src/shaders/`, loaded via Vite `?raw`) `` diventa:
   ~~~~text
   #### Shaders (`ts/src/shaders/`, loaded via Vite `?raw`; the primitives are PIECES in `ts/src/shaders/primitives/`, composed in TS by `render/primitive-shaders.ts` — a piece never compiles alone)
   ~~~~
2. Sostituisci le sei righe che cominciano con `` | `basic.wgsl` | ``, `` | `line.wgsl` | ``, `` | `gradient.wgsl` | ``, `` | `box-shadow.wgsl` | ``, `` | `bezier.wgsl` | ``, `` | `msdf-text.wgsl` | `` con:
   ~~~~text
   | `primitives/prelude.wgsl` | Phase 5b: what every primitive module shares, composed first. `CameraUniform` (80 B: `viewProjection`, `occluderLayers` at 64, `viewportWidth`/`viewportHeight` at 68/72, pad); the bindings of groups 0 (camera, transforms, visibleIndices, texLayerIndices, renderMeta, primParams), 1 (tier0-3, texSampler, ovf0-3) and 2 (lightBuffer 2d-array, lightSampler, lighting); `override OCCLUDER_PASS`, `CASTS_SHADOW_BIT` + `castsInto()`; the lighting block (`RECEIVES_LIGHT_BIT` = bit 10, `LightingUniform`, `lightGroupOf`, `applyLighting`); the superset `VertexOutput` (locations 0-5, `edgeScale` @6 perspective-interpolated, flat `transparent` @7, flat `primType` @8); helpers `culledVertex`, `finishVertex`, `unitQuadVertex`, `sampleTier` (the 8-way tier switch, raw), `sampleTierOrWhite` (packed index 0 → white), `occluderSeed` |
   | `primitives/quad.wgsl` | Type 0 (was `basic.wgsl`), prefix `quad_`: unit quad, `quad_shade` = `sampleTierOrWhite`; lit: `quad_fs` goes through `applyLighting` |
   | `primitives/line.wgsl` | Type 1, prefix `line_`. A quad expanded across the segment. Width in local units (scaled by the entity and the zoom) or, with `primParams[7] = 1` (`.line(..., { unit: 'px' })`), in screen pixels: the endpoints are projected and offset across the ON-SCREEN direction with the camera's viewport size. The quad is the stroke plus a 1-px AA margin (`edgeScale` maps its uv back to the stroke); the edge ramp is `2·fwidth(uv.y)` (the LINEAR interpolant: `fwidth` of the `abs()` collapsed at the centre inside a 2×2 quad) centred on the edge, before any branch of `line_shade`. Opaque entities keep exactly the stroke through the half-open `line_insideStroke` test (a W-px line covers W rows at any sub-pixel alignment; `transparent` is a flat varying from renderMeta bit 8), the uber (transparent) pipeline blends the ramp; `line_occluder` seeds exactly the opaque stroke, at least 2 px (one half-res seed texel) wide — `line_vs` reads `OCCLUDER_PASS` for it, which is why the prelude declares the override even in the uber. SDF dash pattern. All measured on GPU with `engine.debug.probe` |
   | `primitives/msdf-text.wgsl` | Type 2, prefix `msdf_`: MSDF median(r,g,b) signed distance + screen-pixel-range AA (`dpdx`/`dpdy`). Samples the atlas with the RAW `sampleTier`: index 0 → white would draw a full rectangle on BC7/ASTC |
   | `primitives/bezier.wgsl` | Type 3, prefix `bezier_`: quadratic Bezier SDF (Inigo Quilez), `fwidth()` anti-aliased stroke |
   | `primitives/gradient.wgsl` | Type 4, prefix `gradient_`: 2-stop gradient (linear/radial/conic); lit like quad (`applyLighting` in `gradient_fs`) |
   | `primitives/box-shadow.wgsl` | Type 5, prefix `boxshadow_`: SDF box shadow (Evan Wallace erf) |
   | uber module (generated, no file) | `composeUberModule`: `diagnostic(off, derivative_uniformity);` as its FIRST line (the derivatives of line, bezier and msdf sit inside a per-instance switch; the per-type modules keep the strict analysis), the prelude, all six libraries, a `vs_main` switching on `min(type, 6)` (6 → `culledVertex`) and an `fs_main` switching on `primType` (`case 5u, default`); no `fs_occluder`. In `ForwardPass.UBER_SOURCE`, never in `SHADER_SOURCES` |
   ~~~~
3. Nella riga `` | `basic-binding-array.wgsl` | ``: `` (not wired into ForwardPass, documents target WGSL structure) `` diventa:
   ~~~~text
   (not wired into ForwardPass; it predates the phase-5b composition: its bindings now live in the prelude's group 1 and its switch in `sampleTier`)
   ~~~~
4. Sostituisci la riga che comincia con `` | `radix-sort.wgsl` | `` con:
   ~~~~text
   | `transparent-gather.wgsl` | Phase 5b compute, `gather_main` (256 threads): thread 0 reads the 12 transparent buckets' counts and `firstInstance` (words `(14+k)*5+1` and `+4`) into workgroup memory; `n = min(raw, limit)`; workgroup 0 writes the header (draw `{6,n,0,0,0}`, dispatch `{ceil(n/1024),1,1}` at byte 20, raw/limit/overflow/stamp); every thread `i < n` writes `lo` = `entity-ids[slot]`, `hi` = the sortable bits of `entity-bounds[slot].z` read as `vec4<u32>` (-0 normalised), and the slot. 7 storage + 1 uniform |
   | `transparent-sort.wgsl` | Phase 5b compute, `upsweep_main`/`scan_main`/`scatter_main` (256 threads, one shared 6-storage + 1-uniform layout; `transparent-args` READ-ONLY, so `n` is uniform): per-tile digit histograms; a one-workgroup column scan + in-place Hillis-Steele (two barriers per step: the one-barrier form is a race); a STABLE scatter at `digitBase + tile prefix + round cursor + popcount rank` over `atomicOr` masks (13 barriers per tile; no atomic order ever reaches an address). The 7th pass writes values only. `diag[0]` bit 0: scan sum ≠ n, bit 1: a destination ≥ n |
   ~~~~
5. Dopo la riga `` | `pixel-probe.wgsl` | `` aggiungi:
   ~~~~text
   | `wgsl-analysis.ts` (TS, tests only) | WGSL text analysis for the headless tests: `stripComments`, `topLevelDecls`, `functionBody`, `functionParams`, `callGraph`, `reachableFrom`, `bindingDecls`, `localNames`, `directives`. The reachability checks (group 2 only from a lit `fs_main`, bindings against layouts and stage visibility) run on the COMPOSED modules |
   ~~~~

- [ ] **Step 8: CLAUDE.md, gotcha critici**

1. Sostituisci il bullet che comincia con `- **Indirect draw buffer needs STORAGE | INDIRECT | COPY_DST**` con:
   ~~~~text
   - **Indirect draw buffer needs STORAGE | INDIRECT | COPY_DST** — compute shader writes instanceCount (STORAGE), render pass reads it (INDIRECT), CPU resets it each frame (COPY_DST). `transparent-args` needs the same for the same reasons: the gather writes it, the sort's indirect dispatches and the uber draw read it, `prepare()` resets it.
   ~~~~
2. Sostituisci il bullet che comincia con `- **Multi-pipeline ForwardPass shared bind group layout**` con:
   ~~~~text
   - **The prelude declares the primitive bind groups ONCE** — `shaders/primitives/prelude.wgsl` declares groups 0 (camera, transforms, visibleIndices, texIndices, renderMeta, primParams), 1 (tier0-tier3 + sampler + ovf0-ovf3) and 2 (light buffer) for all 7 composed modules; a library declares no `@group`/`@binding`, so the per-type modules and the uber cannot drift apart. Every composed module DECLARES group 2, but only the lit types' `fs_main` (quad, gradient, and their cases in the uber) reach it, through `applyLighting`: a layout may hold groups a shader never uses, and the occluder pipelines' layout has groups 0-1 only. Unused bindings stay declared.
   ~~~~
3. Nel bullet "SoA buffers parallel indexed", `Entity IDs are CPU-only (not uploaded to GPU).` diventa:
   ~~~~text
   Entity IDs reach the GPU only as the renderer-owned `entity-ids` column (phase 5b), uploaded whole when `entityIdsGeneration` changes: the transparent sort's tie-break.
   ~~~~
4. Sostituisci il bullet che comincia con `- **ForwardPass group 2 (light buffer) is read in \`fs_main\` ONLY**` con:
   ~~~~text
   - **Group 2 (light buffer) must be reachable from `fs_main` ONLY** — `OccluderSeedStage` runs the composed per-type modules through `fs_occluder` on a TWO-group layout, and WebGPU rejects a pipeline whose entry points statically use a binding its layout lacks. The lighting lookup is the prelude's `applyLighting`, called only by `quad_fs` and `gradient_fs`: calling it from a `<p>_shade`, a `<p>_vs` or any prelude helper `fs_occluder` reaches makes every lit graph fail GPU validation — the request is rejected and lighting silently stays off. Never apply it after the uber's type switch either: the other types would become lit, which `deriveLightGroups` does not model. The reachability tests on the composed modules (the `wgsl-analysis.ts` call graph) pin it. The other half: `setBindGroup(2, …)` is issued for EVERY ForwardPass pipeline, the 6 opaque ones and the uber.
   ~~~~
5. Sostituisci il bullet che comincia con `` - **`CameraUniform` is 80 bytes in all six primitive shaders** `` con:
   ~~~~text
   - **`CameraUniform` is 80 bytes, declared once in the prelude** — `viewProjection` + `occluderLayers` (byte 64) + `viewportWidth`/`viewportHeight` (68, 72) + a pad. ForwardPass writes occluderLayers 0 (its camera buffer serves the uber too), OccluderSeedStage the set's layers; BOTH write the FULL canvas size, the seed stage too although it renders at half resolution, so a pixel-wide line casts the NDC footprint it is drawn with. Group-0 binding 0 declares `minBindingSize: 80`, so a 64-byte buffer fails at bind-group creation instead of at draw time. Changing the struct means the prelude, `ForwardPass`, `OccluderSeedStage` and `primitiveGroup0LayoutEntries` together.
   ~~~~
6. Nel bullet "Multi-tier textures require switch in WGSL", `Adding new tiers requires updating the shader \`switch\`.` diventa:
   ~~~~text
   Adding new tiers means updating `sampleTier` in the prelude (the one tier switch of the primitives) and the group-1 layout.
   ~~~~
7. Nel bullet su `scene-hdr`, `` consumed by BOTH `ForwardPass`'s 12 pipelines `` diventa `` consumed by BOTH `ForwardPass`'s 7 pipelines (6 opaque + the uber) ``.
8. Nel bullet "WGSL *can* be validated without anything rendering", dopo `and its entry point is \`cull_main\`, not \`main\`.` aggiungi:
   ~~~~text
    A primitive PIECE does not compile alone: validate the COMPOSED modules — `(await import('/src/render/passes/forward-pass.ts')).ForwardPass.SHADER_SOURCES` and `.UBER_SOURCE` in the live page (the same module instance the app uses), or the files `DUMP_WGSL_DIR=<dir> npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts` writes, which `scripts/validate-wgsl-naga.mjs` also runs through naga (Firefox's front-end; `cargo install naga-cli` once).
   ~~~~
9. Nel bullet "A box shadow must be `.transparent()`", `` `box-shadow.wgsl` puts its coverage in alpha `` diventa `` `boxshadow_shade` (`primitives/box-shadow.wgsl`) puts its coverage in alpha ``.
10. Nel bullet su `gradient()`, `` (`gradient.wgsl`) `` diventa `` (`gradient_shade`) ``.
11. Sostituisci il bullet che comincia con `- **A primitive casts shadows only if its shader exposes` con:
    ~~~~text
    - **A primitive casts shadows through the `fs_occluder` the composer gives its per-type module** — `composeTypeModule` writes `fn fs_occluder` (returning `<p>_occluder`) into every per-type module, and `OccluderSeedStage` still picks modules by the TEXT `fn fs_occluder` and sets `OCCLUDER_PASS = 1`; the prelude declares the override, so "entry without override" cannot happen in a composed module. Consequences: the string `fn fs_occluder` must never appear in a piece, not even in a comment, and the uber (no `fs_occluder`) must never be put into `SHADER_SOURCES`. The degenerate-triangle drop (`OCCLUDER_PASS && !castsInto(meta1, camera.occluderLayers)`) lives in the generated `vs_main` wrapper; `line_vs` also reads `OCCLUDER_PASS` for its minimum width. `<p>_occluder` is usually `occluderSeed(in, <p>_shade(in).a)` (alpha < 0.5 discarded); line's discards `a <= 0 || !line_insideStroke`. The bit is `CASTS_SHADOW_BIT` in the prelude and `RENDER_META_CASTS_SHADOW_BIT` in Rust, and a test compares the two.
    ~~~~
12. Sostituisci il bullet che comincia con `- **Adding a new primitive type requires 3 steps**` con:
    ~~~~text
    - **Adding a new primitive type is a library plus a table row** — (1) a library `shaders/primitives/<name>.wgsl` with prefixed names and `<p>_vs`/`<p>_fs`/`<p>_occluder` (no bindings, no entry points, no directive), (2) a row in `PRIMITIVE_LIBRARIES`, which generates its per-type module, its `case` in the uber and its `lit` flag, (3) the `?raw` import, the piece slot and the HMR accept in `renderer.ts`, (4) optionally `EntityHandle`. The `/new-primitive` skill has the full checklist: a new DRAWABLE id collides with Light2D being the last type. Types: 0=Quad, 1=Line, 2=SDFGlyph, 3=BezierPath, 4=Gradient, 5=BoxShadow, 6=Light2D. Type 6 has no library: `ForwardPass` never draws it, the uber sends it to `culledVertex`, the gather skips its buckets, and `LightAccumStage` reads them directly.
    ~~~~
13. Nel bullet "Indirect args are 28 entries (560 bytes)", dopo `which would break the flat indexing and branch the hot loop.` aggiungi:
    ~~~~text
     Since phase 5b the transparent buckets of types 0-5 (14-25) are not drawn from `indirect-args`: `TransparentSortPass` gathers them, and ForwardPass draws them in one `drawIndexedIndirect(transparent-args, 0)` — firstInstance 0, so that draw needs no `indirect-first-instance`.
    ~~~~
14. Nel bullet "`Depth` is the z of a 2D entity, and only of one":
    - `Equal depths overlap in NO defined order (cull atomics decide): documented, not tie-broken.` diventa `Two OPAQUE sprites at equal depths overlap in NO defined order (cull atomics decide); two transparent ones by id (below).`
    - la stringa
      ~~~~text
      **Depth orders a sprite against OPAQUE ones only**: the transparent pipeline writes no depth and nothing sorts it (`RadixSortPass` is dead in the graph — nothing reads `transparent-vals-sorted`), so two overlapping `.transparent()` sprites — every sprite with alpha, every box shadow — compose in draw order: primitive type (box shadows last), then cull order. The back-to-front sort is step 5b of the round.
      ~~~~
      diventa:
      ~~~~text
      **Transparent sprites are sorted too (phase 5b)**: the transparent pipeline writes no depth, so `TransparentSortPass` orders the visible transparents of types 0-5 back to front by WORLD z (`entity-bounds.z`, so a child's composed depth counts), and at equal z the higher external id is drawn in front — see the transparent-sort bullet. A transparent at the same z as an overlapping opaque stays hidden (strict `less`).
      ~~~~
    - `` `verify_2d.rs` D4-D7, the 2D Twins tab's depth check. `` diventa `` `verify_2d.rs` D4-D7, the 2D Twins tab's 'Depth orders 2D sprites' and 'Depth orders transparent sprites'. ``
15. Subito dopo il bullet "`Depth` is the z of a 2D entity" aggiungi i due bullet:
    ~~~~text
    - **Transparent primitives are sorted on the GPU, back to front by (world z, external id), and drawn in ONE uber draw** (phase 5b, design `2026-09-27-transparent-sort-uber-design.md`) — `TransparentSortPass` gathers buckets 14-25 (never the Light2D buckets 26/27, which stay `LightAccumStage`'s), keys each slot by (the sortable bits of `entity-bounds.z`, `entity-ids[slot]`) and runs a stable 7-pass 8-bit LSD radix sort into `transparent-order`; ForwardPass's uber pipeline draws it. Four facts that are easy to break: (1) at equal z the HIGHER external id is in front — the newest entity only while the allocator hands out fresh ids, i.e. for the first 1 048 576 cumulative spawns; after that, released ids come back oldest first, so order sprites with `.depth()`; (2) `entity-ids` is uploaded only when `GPURenderState.entityIdsGeneration` changes (`Engine` bumps it at most once per frame when a slot→id mapping changes, and on `reset`/`snapshot_restore`): a transport site that loses the field turns it into NaN, which uploads every frame (slower, still right), never a constant; (3) `transparentCount` (bit 8 recounted over the rows each frame, an upper bound) only SIZES the gather (`B = min(count, CAP)`) and skips everything at 0 — the sort itself runs from the GPU count through indirect dispatches; a count below the visible number sets the header's overflow flag, and the drawn set is then not deterministic; (4) `entity-ids`, `transparent-order` and `transparent-args` belong to the renderer, not to the pass: an HMR probe runs a pass's `setup()` then `destroy()` on the live pool. `MAX_GPU_ENTITIES` (100 000, `types.ts`) is the one capacity: `validateConfig` rejects a larger `maxEntities`. `engine.debug.readTransparentSort()` (dev) returns the gathered keys, `digitBase`, the order and the frame's CPU snapshot; `verifySortReadback` checks it against an `Array.sort` oracle.
    - **The uber module's first line is `diagnostic(off, derivative_uniformity);`, and only the uber has it** — its `fs_main` calls each library's `<p>_fs` from a `switch` on a per-instance flat varying, and the derivatives inside `line_shade` (`fwidth`), `bezier_shade` (`fwidth`) and `msdf_shade` (`dpdx`/`dpdy`) then fail the uniformity analysis. The severity is decided where the builtin is CALLED: an `@diagnostic` on the uber `fs_main` or on its `switch` does not silence them (verified on Chrome 154); only the module directive or an attribute on the callee does, and a callee attribute would also switch the check off in the per-type modules, which compile the same library code under the strict analysis. The switch is uniform over a 2×2 quad in practice (the type is per instance). Plan B if a front-end rejects the directive: hoist those derivatives out of the switch (design §10).
    ~~~~
16. Nel bullet "`basic-binding-array.wgsl` is a design artifact only", `Not in \`renderer.ts\` SHADER_SOURCES.` diventa `Not in the composer, and it predates it: its bindings now live in the prelude's group 1, its switch in \`sampleTier\`.`

- [ ] **Step 9: CLAUDE.md, note d'implementazione, convenzioni, automazioni, stato, documenti**

1. Sostituisci il bullet che comincia con `- **Packed texture index 0 = untextured = white, answered by the shader**` con:
   ~~~~text
   - **Packed texture index 0 = untextured = white, answered by the shader** — `sampleTierOrWhite` in the prelude returns `vec4f(1.0)` for tier 0 / layer 0 / not overflow, before any sampling. Layer 0 is reserved as the "default white", but on a compressed tier (BC7/ASTC) it is never filled, because `writeTexture` cannot take raw pixels there. An all-zero BC7 block decodes to transparent black. Until 2026-09-26 every untextured quad was black on desktop and white on rgba8-only devices. `quad_shade`, `line_shade` and `bezier_shade` sample through it (line and bezier replace only the COLOUR: their stroke coverage — AA, dashes, discard — still applies); `msdf_shade` deliberately calls the raw `sampleTier`, because its texture is the glyph atlas. A new library that samples the tiers uses `sampleTierOrWhite`; the composition tests check which library reaches which helper.
   ~~~~
2. Sostituisci il bullet che comincia con `- **Shader hot-reload validates each shader on its own, before any graph sees it**` con:
   ~~~~text
   - **Shader hot-reload validates each shader before any graph sees it — and the primitive PIECES together** — `GraphRequests.reloadShader` writes the new source into the static slot only for the synchronous duration of a throwaway probe pass's `setup()`, then puts the old one back; it keeps the new one only when the GPU reports no error. So a Save All with one broken INDEPENDENT file drops just that file, and a shader of a mode that is off (`bloom.wgsl` while bloom is off) is still validated — it used to be logged "hot-reloaded" unchecked, then make `disableBloom()` fail. The primitive pieces depend on each other (a prelude rename and its uses arrive as separate Vite updates), so their accepts go through `PieceReloadCollector` (50 ms trailing debounce, the last non-empty text per piece) into `reloadShaders`: the UNION of the batch is probed, then each entry alone over the current good sources; all go live if the union passes, none if only the singles pass (a conflict, e.g. a duplicated top-level name), otherwise the passing subset is probed again as a union — a graph is never built from a set a probe rejected or never tried together. Declared limit: a coupled edit saved together with a broken unrelated piece is rejected whole; re-save the coupled files after fixing the broken one (Vite resends only changed files). A piece slot's `write()` recomposes the 6 per-type modules and the uber IN PLACE and cannot throw (the composer is total); the empty-piece guard lives in the piece probe closure in `renderer.ts` and throws synchronously inside `validation.run`. `recompileShader(<piece>, src)` takes a piece, one slot at a time, no debounce. Adding a hot-reloadable shader means a `shaderSlots` entry with a `probe` and `usedBy`. `GraphRequests` numbers its requests: a verdict booked after a newer request (the host acts on it one microtask earlier) never undoes that request's state. Particle shaders follow the same rule through `ParticleSystem.buildSimulate/buildRender` + `installPipelines`, which also rebinds every emitter — their pipelines use `layout: 'auto'`, whose bind group layouts fit only the pipeline that made them, so a reload used to leave every live emitter failing validation.
   ~~~~
3. Nel bullet "Validation cannot see draw-time errors", `Dead-pass culling still drops optional passes whose outputs nothing alive reads (e.g. \`RadixSortPass\`).` diventa:
   ~~~~text
   Dead-pass culling still drops optional passes whose outputs nothing alive reads — `RadixSortPass` was dead that way until phase 5b removed it; `TransparentSortPass` stays alive only because ForwardPass `reads` `transparent-order` and `transparent-args`.
   ~~~~
4. Nel bullet "ResourcePool buffer naming", dopo `Sampler: \`texSampler\`.` aggiungi:
   ~~~~text
    TransparentSortPass reads `indirect-args`/`visible-indices`/`entity-bounds`/`entity-ids` and writes `transparent-order`/`transparent-args`, which ForwardPass reads too; those three buffers are created by `createRenderer`, like `selection-mask`.
   ~~~~
5. `- **Shader hot-reload rebuilds entire render graph** — Not incremental. Acceptable for dev, not production.` diventa:
   ~~~~text
   - **Shader hot-reload rebuilds entire render graph** — Not incremental. Acceptable for dev, not production. A library edit recompiles its per-type module, its occluder and the uber; a prelude edit all seven modules.
   ~~~~
6. Conventions: `- WGSL shaders live in \`ts/src/shaders/\`, loaded at dev time via Vite \`?raw\` imports.` diventa:
   ~~~~text
   - WGSL shaders live in `ts/src/shaders/`, loaded at dev time via Vite `?raw` imports. The primitive shaders are pieces under `ts/src/shaders/primitives/` (a prelude + six libraries with prefixed names), composed in TS by `render/primitive-shaders.ts`.
   ~~~~
7. Tabella degli hook: la riga `` | `post-edit-notices.sh` | PostToolUse | WGSL bind-group, protocol-sync, physics and structural-file reminders | `` diventa:
   ~~~~text
   | `post-edit-notices.sh` | PostToolUse | WGSL reminders split by path (the primitive prelude, a primitive library, a top-level shader), protocol-sync, physics and structural-file reminders |
   ~~~~
8. Skill: `` - `/new-primitive` — Add a new RenderPrimitiveType (shader + pipeline + API, 7-step checklist) `` diventa `` - `/new-primitive` — Add a new RenderPrimitiveType (library piece + `PRIMITIVE_LIBRARIES` row + HMR slot + API, 8-step checklist) ``.
9. Agent: `` - `wgsl-validator` — Cross-validates all 22 WGSL shaders for bind group layout consistency, ResourcePool naming, and tier coverage `` diventa:
   ~~~~text
   - `wgsl-validator` — Cross-validates all 24 WGSL files (the 7 primitive pieces included) and the 7 composed primitive modules: prelude-only bindings, library prefixes, the uber's directive and type clamp, group 2 reachability, ResourcePool naming, tier coverage, the sort kernels' budgets
   ~~~~
   e nella riga di `webgpu-pass-reviewer` `` (uniform padding, minBindingSize, per-pass slices, placeholders, view dimensions, storage budget, indirect offsets, missing bind groups) `` diventa `` (uniform padding, minBindingSize, per-pass slices, placeholders, view dimensions, storage budget, indirect offsets and the `transparent-args` header, missing bind groups, renderer-owned pool buffers) ``.
10. Stato: alla fine del paragrafo che comincia con `**Current: Phase 17 complete and merged to master` aggiungi (dentro il grassetto, prima dei `**` finali):
    ~~~~text
     Round 2026-09-27 step 5b (GPU transparent sort + uber pipeline) is done: see the 5b row.
    ~~~~
11. Riga della Phase 13: `GPU radix sort (transparency)` diventa `GPU radix sort (transparency — dead in the graph, removed in phase 5b and replaced by \`TransparentSortPass\`)`.
12. Dopo la riga `| 17-E | …` della tabella delle fasi aggiungi (i quattro numeri vengono dalla tabella del §11 della spec, righe 100 000: `sort p.4` con depth uguali e distinte, `1−0` e `4−3` con depth uguali):
    ~~~~text
    | 5b (round 2026-09-27) | Transparent sort + uber pipeline | Primitive shaders composed from a prelude + six prefixed libraries (`render/primitive-shaders.ts`: 6 per-type modules + 1 uber; grouped piece hot-reload); `entity-ids` GPU column + `transparentCount`/`ids_generation` (2 WASM exports); `TransparentSortPass` (gather + stable 7-pass radix, CPU model, dev readback `readTransparentSort`); ONE uber draw for every transparent primitive, back to front by (world z, id); `MAX_GPU_ENTITIES`; `RadixSortPass` removed. At 100 000 visible transparents on the AMD iGPU: sort <valore> / <valore> ms (equal / distinct depths); forward +<valore> ms from the composition, +<valore> ms from the uber draw (design §11) |
    ~~~~
    Sostituisci ciascun `<valore>` con il numero corrispondente del §11 prima di salvare.
13. Nella sezione "Documentation", dopo la voce `docs/plans/2026-09-26-phase17-light-layer-groups-plan.md` aggiungi:
    ~~~~text
    - `docs/plans/2026-09-27-transparent-sort-uber-design.md` — Phase 5b design (GPU sort + uber pipeline): decisions D1-D10, composition, id column, sort kernels, readback, tests, measurements (§11).
    - `docs/plans/2026-09-27-transparent-sort-uber-plan.md` — Phase 5b implementation plan (23 tasks).
    ~~~~

- [ ] **Step 10: I nomi citati esistono e il file non ha perso righe**

```bash
cd /home/edoardocicognani/Code/HyperionEngine
git diff -U0 -- CLAUDE.md | grep -E '^\+' | grep -oE '`[A-Za-z_][A-Za-z0-9_]*(\(\))?`' | tr -d '`()' | sort -u | while read -r id; do
  grep -rqF -- "$id" ts/src crates scripts .claude docs/plans/2026-09-27-transparent-sort-uber-design.md || echo "MISSING: $id"
done
git diff --numstat -- CLAUDE.md
find ts/src/shaders -name '*.wgsl' | wc -l
grep -cE "^import .*\.wgsl\?raw" ts/src/renderer.ts
grep -cE "import\.meta\.hot\.accept\('\./shaders/" ts/src/renderer.ts
```
Expected: nessuna riga `MISSING:` (un nome che manca si corregge nel testo con quello vero del codice, per esempio un nome prefissato della libreria `line`); `numstat` con le righe tolte non oltre il doppio di quelle aggiunte; `24`, `22`, `20`. Se un conto differisce, correggi il numero nella riga `renderer.ts` e nel bullet dell'agent `wgsl-validator`.

- [ ] **Step 11: PROJECT_ARCHITECTURE.md**

1. Albero dei file, le tre righe
   ~~~~text
           │       ├── forward-pass.ts     # ForwardPass: multi-pipeline forward rendering with
           │       │                       #   SHADER_SOURCES per primitive type, SoA transforms,
           │       │                       #   per-type drawIndexedIndirect. Writes scene-hdr
   ~~~~
   diventano:
   ~~~~text
           │       ├── forward-pass.ts     # ForwardPass: opachi = 1 pipeline per tipo (moduli
           │       │                       #   composti, SHADER_SOURCES); trasparenti = 1 pipeline
           │       │                       #   uber (UBER_SOURCE), 1 drawIndexedIndirect(transparent-
           │       │                       #   args, 0) nell'ordine del sort. Scrive scene-hdr
           │       ├── transparent-sort-pass.ts # TransparentSortPass (fase 5b): gather dei trasparenti
           │       │                            #   visibili + radix sort stabile a 7 passate per (z, id)
   ~~~~
2. Le sette righe
   ~~~~text
           │   ├── basic.wgsl              # Quad render: SoA transforms, visibility indirection,
           │   │                           #   renderMeta + primParams, multi-tier Texture2DArray
           │   ├── line.wgsl               # Line render: quad expanded across the segment, width in local units or pixels,
           │   │                           #   SDF dash pattern, anti-aliased edges
           │   ├── gradient.wgsl           # 2-stop gradient (linear, radial, conic)
           │   ├── box-shadow.wgsl         # SDF box shadow (Evan Wallace erf approximation)
           │   ├── msdf-text.wgsl          # MSDF text: median(r,g,b) signed distance + AA
   ~~~~
   diventano:
   ~~~~text
           │   ├── primitives/             # Fase 5b: pezzi, composti in TS da render/primitive-shaders.ts
           │   │   ├── prelude.wgsl        #   binding dei gruppi 0/1/2, CameraUniform, VertexOutput,
           │   │   │                       #   OCCLUDER_PASS/castsInto, blocco luci, helper (sampleTier, ...)
           │   │   ├── quad.wgsl           #   tipo 0 (quad_), era basic.wgsl
           │   │   ├── line.wgsl           #   tipo 1 (line_): quad lungo il segmento, larghezza locale o px
           │   │   ├── msdf-text.wgsl      #   tipo 2 (msdf_): median(r,g,b) + AA
           │   │   ├── bezier.wgsl         #   tipo 3 (bezier_): SDF di Bezier quadratica
           │   │   ├── gradient.wgsl       #   tipo 4 (gradient_): gradiente a 2 stop
           │   │   └── box-shadow.wgsl     #   tipo 5 (boxshadow_): box shadow SDF (erf)
   ~~~~
   e prima della riga `        │   └── prefix-sum.wgsl         # Compute: Blelloch exclusive scan (workgroup-level)` inserisci:
   ~~~~text
           │   ├── transparent-gather.wgsl # Fase 5b: gather dei trasparenti visibili (bucket 14-25)
           │   ├── transparent-sort.wgsl   # Fase 5b: radix LSD a 8 bit × 7 (upsweep, scan, scatter)
   ~~~~
3. Diagramma del frame (§4): sostituisci le nove righe che vanno da `    │  ┌─── Phase 7: GPU Draw (Indirect) ───────────┐   │` a `    │  └──────────────────────────────────────────────┘   │` (incluse) con:
   ~~~~text
       │  ┌─── Phase 7: GPU Sort + Draw (Indirect) ──────┐   │
       │  │  TransparentSortPass: gather + radix         │   │
       │  │    (7 passate) → transparent-order/-args     │   │
       │  │  opachi: 1 pipeline per tipo (preludio +     │   │
       │  │    libreria), drawIndexedIndirect/bucket     │   │
       │  │  trasparenti: 1 pipeline uber, un draw       │   │
       │  │    drawIndexedIndirect(transparent-args, 0)  │   │
       │  │  vertex: visibleIndices → transforms[idx]    │   │
       │  │  fragment: sampleTier / <p>_shade            │   │
       │  └──────────────────────────────────────────────┘   │
   ~~~~
4. §10 "Architettura del Renderer": la frase `` `createRenderer()` crea un `ResourcePool` con buffer GPU condivisi, wires `CullPass` + `ForwardPass`, compila un `RenderGraph` DAG, e restituisce un'interfaccia `Renderer`. Ogni frame: (1) uploada i buffer SoA nella GPU, (2) `CullPass` esegue frustum culling per-entity, (3) `ForwardPass` renderizza le entita visibili via `drawIndexedIndirect`. `` diventa:
   ~~~~text
   `createRenderer()` crea un `ResourcePool` con buffer GPU condivisi (compresi `entity-ids`, `transparent-order` e `transparent-args`, posseduti dal renderer), collega `ScatterPass` + `CullPass` + `TransparentSortPass` + `ForwardPass`, compila un `RenderGraph` DAG, e restituisce un'interfaccia `Renderer`. Ogni frame: (1) uploada i buffer SoA nella GPU (la colonna `entity-ids` solo quando cambia `entityIdsGeneration`), (2) `CullPass` esegue frustum culling per-entity, (3) `TransparentSortPass` ordina i trasparenti visibili dal fondo al davanti, (4) `ForwardPass` disegna gli opachi con una pipeline per tipo e tutti i trasparenti con un solo draw uber.
   ~~~~
   Nel diagramma sotto, sostituisci le tredici righe da `              ┌─── ForwardPass.prepare() ───────────┐                  │` fino alla prima `              └────────────────────┬────────────────┘` che segue `drawIndexedIndirect(indirectBuffer)` con:
   ~~~~text
                 ┌─── TransparentSortPass.prepare() ───┐                  │
                 │  B = min(transparentCount, CAP)     │                  │
                 │  writeBuffer(header, gatherParams)  │                  │
                 └────────────────────┬────────────────┘                  │
                                      ▼                                   │
                 ┌─── TransparentSortPass.execute() ───┐                  │
                 │  gather: bucket 14-25 → chiavi      │                  │
                 │    (zKey, id esterno) + slot        │                  │
                 │  7 × (upsweep, scan, scatter)       │                  │
                 │  → transparent-order, -args         │                  │
                 └────────────────────┬────────────────┘                  │
                                      ▼                                   │
                 ┌─── ForwardPass.prepare() ───────────┐                  │
                 │  writeBuffer(cameraBuf, viewProj)   │                  │
                 └────────────────────┬────────────────┘                  │
                                      ▼                                   │
                 ┌─── ForwardPass.execute() ───────────┐                  │
                 │  ensureDepthTexture(w, h)           │◄─────────────────┘
                 │  opachi: 6 pipeline per tipo,       │
                 │    drawIndexedIndirect per bucket   │
                 │  trasparenti: pipeline uber,        │
                 │    group 0 con transparent-order,   │
                 │    drawIndexedIndirect(             │
                 │      transparent-args, 0)           │
                 │  vertex: visibleIndices[inst_id]    │
                 │    → transforms[idx] → model mat    │
                 │  fragment: <p>_shade / sampleTier   │
                 └────────────────────┬────────────────┘
   ~~~~
   Tabella **Costanti**: le righe `` | `MAX_ENTITIES` | 100,000 | Limite massimo entita supportate | `` e `` | `INDIRECT_BUFFER_SIZE` | 120 bytes | 6 tipi × 5 × u32 (drawIndexedIndirect args per tipo primitivo) | `` diventano:
   ~~~~text
   | `MAX_GPU_ENTITIES` (`types.ts`) | 100,000 | Righe di ogni buffer GPU; `validateConfig` rifiuta un `maxEntities` maggiore |
   | `indirect-args` | 560 bytes | 7 tipi × 2 bucket di materiale × 2 blend × 5 u32 |
   | `transparent-args` | 64 bytes | Header del sort: draw `{6, n, 0, 0, 0}`, dispatch a 20 B, raw/limit/overflow/stamp alle parole 8-11 |
   ~~~~
   Tabella **Buffer layout GPU**: la riga `Camera uniform` diventa `` | Camera uniform | (ForwardPass internal) | `UNIFORM \| COPY_DST` | `CameraUniform` 80 B (viewProjection, occluderLayers, viewport) | Ogni frame in `ForwardPass.prepare()` | ``; la riga `Indirect draw args` diventa `` | Indirect draw args | `indirect-args` | `STORAGE \| INDIRECT \| COPY_DST` | 28 × 5 × u32 (560 bytes) | Reset in `CullPass.prepare()` + atomicAdd dal compute | ``; dopo di lei aggiungi:
   ~~~~text
   | Entity ids | `entity-ids` | `STORAGE \| COPY_DST` | `[u32]` × MAX_GPU_ENTITIES (id esterno per slot) | Tutta la colonna, solo quando cambia `entityIdsGeneration` (anche nei frame di scatter) |
   | Ordine dei trasparenti | `transparent-order` | `STORAGE` | `[u32]` × MAX_GPU_ENTITIES (slot dal fondo al davanti) | Scritto dall'ultima passata di `TransparentSortPass`, letto dal draw uber come group 0 binding 2 |
   | Header del sort | `transparent-args` | `STORAGE \| INDIRECT \| COPY_DST` | 16 × u32 (64 bytes) | Reset in `TransparentSortPass.prepare()`, scritto dal gather, argomenti indiretti dei dispatch e del draw uber |
   ~~~~
5. §10: sostituisci l'intera sottosezione `### Pipeline Render: Visibility Indirection (basic.wgsl)` (dal titolo fino al paragrafo "**ForwardPass lifecycle**" compreso) con:
   ~~~~markdown
   ### Pipeline Render: Visibility Indirection (preludio + moduli composti)

   **File**: `ts/src/shaders/primitives/prelude.wgsl` (binding e helper) e una libreria per tipo in `ts/src/shaders/primitives/`, composti da `ts/src/render/primitive-shaders.ts`

   Il render shader usa **visibility indirection**: il vertex shader non legge direttamente dall'`instance_index`, ma lo usa come indice nel buffer legato al binding 2 del gruppo 0, per ottenere l'indice reale dell'entita nei buffer SoA. Per gli opachi quel buffer e `visible-indices` (scritto dal cull); per il draw uber dei trasparenti e `transparent-order` (scritto dal sort). Lo shader e lo stesso, cambia solo il bind group.

   ```
   // Preludio — Bind Group 0 (camera, transforms e visibleIndices solo nel vertex stage)
   @group(0) @binding(0) var<uniform> camera: CameraUniform;               // 80 B
   @group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
   @group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;    // visible-indices o transparent-order
   @group(0) @binding(3) var<storage, read> texLayerIndices: array<u32>;   // tier|layer impacchettati
   @group(0) @binding(4) var<storage, read> renderMeta: array<u32>;        // 2 u32 per entita
   @group(0) @binding(5) var<storage, read> primParams: array<f32>;        // 8 f32 per entita
   // Bind Group 1: tier0-3 + texSampler + ovf0-3 (fragment). Bind Group 2: light buffer (fragment).

   // Modulo per tipo (schematico): wrapper generati attorno alla libreria <p>_
   @vertex fn vs_main(@location(0) position: vec3f, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
       let entityIdx = visibleIndices[instanceIdx];                          // indirection
       if (OCCLUDER_PASS && !castsInto(renderMeta[entityIdx * 2u + 1u], camera.occluderLayers)) { return culledVertex(); }
       var out = quad_vs(position, entityIdx);
       out.primType = 0u;
       return out;
   }
   @fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f { return quad_fs(in); }
   @fragment fn fs_occluder(in: VertexOutput) -> @location(0) vec4f { return quad_occluder(in); }

   // Modulo uber (schematico): stessa indirection, poi uno switch sul tipo dell'istanza
   //   vs_main: t = min(renderMeta[e * 2u + 1u] & 0xFFu, 6u); case 0-5 → <p>_vs, default (6) → culledVertex()
   //   fs_main: switch in.primType { ... case 5u, default: { return boxshadow_fs(in); } }
   ```

   Lo switch a 8 vie sui tier sta in `sampleTier(in)` nel preludio (WGSL non indicizza dinamicamente i binding di texture); `sampleTierOrWhite(in)` risponde bianco all'indice impacchettato 0. Il `drawIndexedIndirect` legge `instanceCount` da un buffer indiretto scritto dalla GPU: `indirect-args` (il cull) per gli opachi, `transparent-args` (il sort) per il draw uber.

   **ForwardPass lifecycle**: `setup()` crea una pipeline opaca per ogni modulo per tipo di `SHADER_SOURCES` e una sola pipeline uber da `UBER_SOURCE`, il vertex/index buffer (unit quad), il camera buffer e due bind group del gruppo 0 (`bindGroup0` con `visible-indices`, `bindGroup0Sorted` con `transparent-order`). `prepare()` scrive la camera e l'uniform delle luci. `execute()`: per ogni tipo opaco due `drawIndexedIndirect(indirect-args, slot * 20)`, poi, se `transparentCount > 0`, il draw uber `drawIndexedIndirect(transparent-args, 0)`. Scrive su `scene-hdr` (non direttamente su swapchain).
   ~~~~
6. Le righe sugli id "CPU-only":
   - `    entityIds: Uint32Array;        // SoA: 1 u32/entity (external ID, CPU-only for picking)` → `    entityIds: Uint32Array;        // SoA: 1 u32/entity (external ID: picking on the CPU, the sort's tie-break on the GPU as 'entity-ids')`
   - `    gpu_entity_ids: Vec<u32>,          // SoA: 1 u32/entity (external ID, CPU-only)` → `    gpu_entity_ids: Vec<u32>,          // SoA: 1 u32/entity (external ID; caricato come 'entity-ids' al cambio di generazione)`
   - `- **gpu_entity_ids**: 1 u32 per entita (external ID per picking e immediate-mode, CPU-only)` → `- **gpu_entity_ids**: 1 u32 per entita (external ID per picking e immediate-mode; dalla fase 5b anche sulla GPU, buffer \`entity-ids\`, caricato solo quando cambia \`entityIdsGeneration\`: e la seconda chiave del sort dei trasparenti)`
   - `Il buffer \`entityIds\` e CPU-only — non viene uploadato alla GPU.` → `Dalla fase 5b il buffer \`entityIds\` arriva anche sulla GPU (\`entity-ids\`, posseduto dal renderer), ma solo nei frame in cui \`entityIdsGeneration\` cambia: il sort dei trasparenti lo usa come seconda chiave.`
7. Glossario (§19): la riga `**RenderPrimitiveType**` diventa:
   ~~~~text
   | **RenderPrimitiveType** | Enum che identifica il tipo di primitiva: Quad=0, Line=1, SDFGlyph=2, BezierPath=3, Gradient=4, BoxShadow=5, Light2D=6. Usato dal CullPass per raggruppare le entita, dal ForwardPass per scegliere la pipeline opaca, e dallo switch per istanza del modulo uber (dove 6 finisce in `culledVertex`) |
   ~~~~
   la riga `**Multi-pipeline ForwardPass**` diventa:
   ~~~~text
   | **Multi-pipeline ForwardPass** | Dalla fase 5b: una `GPURenderPipeline` per tipo di primitiva per gli OPACHI (moduli composti preludio + libreria, stesso layout a tre gruppi, `drawIndexedIndirect` per bucket a offset `slot * 20`), e UNA pipeline uber per tutti i trasparenti, con un solo `drawIndexedIndirect(transparent-args, 0)` nell'ordine del sort |
   ~~~~
   e subito dopo aggiungi:
   ~~~~text
   | **Preludio / libreria** | Dalla fase 5b gli shader delle primitive sono pezzi in `ts/src/shaders/primitives/`: il preludio dichiara binding, `CameraUniform`, `VertexOutput` e helper; ogni libreria contiene solo funzioni con il suo prefisso (`quad_`, `line_`, …). Il compositore TS (`render/primitive-shaders.ts`) ne ricava i moduli per tipo e il modulo uber. Un pezzo non compila da solo |
   | **Modulo uber** | Il modulo con tutte e sei le librerie e un `vs_main`/`fs_main` che fanno uno switch sul tipo di primitiva dell'istanza. Disegna tutti i trasparenti in un solo draw. Prima riga: `diagnostic(off, derivative_uniformity);`, e solo lui ce l'ha |
   | **TransparentSortPass** | Pass compute (fase 5b) che raccoglie i trasparenti visibili dei tipi 0-5 e li ordina dal fondo al davanti per (z di mondo, id esterno) con un radix sort stabile a 7 passate; scrive `transparent-order` e gli argomenti del draw in `transparent-args` |
   ~~~~
8. §20.2: `Il buffer \`indirect-args\` contiene 6 × \`DrawIndirectArgs\` (5 u32 ciascuno = 120 bytes totali).` diventa `Il buffer \`indirect-args\` contiene 28 × \`DrawIndirectArgs\` (7 tipi × 2 bucket di materiale × 2 blend, 5 u32 ciascuno = 560 bytes).`
9. Sostituisci l'intero §20.3 (dal titolo `### 20.3 Multi-Pipeline ForwardPass` fino alla riga prima di `### 20.4`) con:
   ~~~~markdown
   ### 20.3 Multi-Pipeline ForwardPass

   (Riscritto nella fase 5b.) `ForwardPass.SHADER_SOURCES: Record<number, string>` mappa tipo di primitiva → modulo WGSL COMPOSTO (preludio + libreria + `vs_main`/`fs_main`/`fs_occluder` generati), prodotto da `composeTypeModules` in `render/primitive-shaders.ts`; `ForwardPass.UBER_SOURCE` contiene il modulo uber. Al `setup()` si creano una pipeline opaca per ogni tipo registrato e una sola pipeline uber trasparente, tutte con lo stesso `pipelineLayout` a tre gruppi.

   ```typescript
   for (const [primType, pipeline] of this.opaquePipelines) {
       renderPass.setPipeline(pipeline);
       for (let bucket = 0; bucket < BUCKETS_PER_TYPE; bucket++)
           renderPass.drawIndexedIndirect(indirectBuffer, (primType * BUCKETS_PER_TYPE + bucket) * 20);
   }
   if (frame.transparentCount !== 0) {
       renderPass.setPipeline(uberPipeline);
       renderPass.setBindGroup(0, bindGroup0Sorted);   // binding 2 = transparent-order
       renderPass.drawIndexedIndirect(transparentArgs, 0);
   }
   ```

   Aggiungere un tipo vuol dire aggiungere una libreria e una riga di `PRIMITIVE_LIBRARIES`: il modulo per tipo e il caso dell'uber si generano (skill `/new-primitive`).
   ~~~~
10. Sostituisci §24.1 e §24.2 (dal titolo `### 24.1 Meccanismo` fino alla riga prima di `---` che precede `## 25.`) con:
    ~~~~markdown
    ### 24.1 Meccanismo

    **File**: `ts/src/renderer.ts` — `recompileShader(passName, shaderCode)` — e `ts/src/render/graph-requests.ts`

    Il flusso di hot-reload:

    1. Vite HMR (o l'utente) chiama `recompileShader(passName, newWgslSource)`. Per le primitive il nome indica un PEZZO (`prelude`, `quad` con alias `basic`, `line`, `msdf-text`, `bezier`, `gradient`, `box-shadow`) e il testo e il pezzo, non un modulo completo.
    2. `GraphRequests.reloadShader` scrive la sorgente nuova nello slot solo per la durata sincrona del `setup()` di un pass di prova usa e getta, dentro gli error scope della GPU, poi rimette quella vecchia. Lo `write()` di uno slot di pezzo ricompone sul posto i 6 moduli per tipo e il modulo uber.
    3. Solo se la GPU non segnala errori la sorgente resta; se il modo richiesto la usa, `RenderGraphHost` costruisce un grafo nuovo e lo mette live solo dopo la validazione GPU.
    4. Gli `accept` dei pezzi passano da `PieceReloadCollector` (debounce di 50 ms): `reloadShaders` prova l'unione del lotto e ogni voce da sola, e non costruisce mai un grafo da un insieme respinto o mai provato insieme.

    **Non incrementale**: ogni grafo nuovo ricrea tutti i pass. Una libreria ricompila il suo modulo per tipo, il suo occluder e l'uber; il preludio tutti e sette i moduli. Accettabile per uno strumento di sviluppo, non per modifiche runtime in produzione.

    ### 24.2 Vite HMR Integration

    I 20 file WGSL ricaricabili a caldo (i 7 pezzi delle primitive compresi) hanno un `import.meta.hot.accept()` in `ts/src/renderer.ts`, il modulo che li importa: un pezzo senza il suo `accept` farebbe ricaricare l'intera pagina. L'handler:

    1. riceve il nuovo testo quando Vite rileva una modifica al file;
    2. lo passa a `renderer.recompileShader(passName, newSource)`, o, per un pezzo, al `PieceReloadCollector`;
    3. il rendering si aggiorna senza refresh della pagina, dopo la validazione GPU.

    Esposto sulla facade `Hyperion` come `recompileShader(passName, shaderCode)` che delega al renderer.
    ~~~~

- [ ] **Step 12: Masterplan, skill, agent, hook**

1. `hyperion-masterplan.md`, tabella "Rischi Rendering": la riga `| WGSL branching divergente con mix di primitive | Media | Medio | Pipeline separate per tipo (zero branching) |` diventa:
   ~~~~text
   | WGSL branching divergente con mix di primitive | Media | Medio | Opachi: pipeline separate per tipo (zero branching). Trasparenti (fase 5b): una pipeline uber con uno switch per istanza sul tipo, uniforme sul quad 2×2 (le derivate sotto `diagnostic(off, derivative_uniformity)`, solo nel modulo uber); costo del `forward` misurato ai passi 3 e 4 (design 5b §11) |
   ~~~~
   e la riga `` | Mancanza preprocessore WGSL | Alta | Medio | `naga_oil` o template string TS | `` diventa:
   ~~~~text
   | Mancanza preprocessore WGSL | — | — | **Risolto (fase 5b)**: un compositore TS (`render/primitive-shaders.ts`) concatena un preludio e librerie con nomi prefissati in 6 moduli per tipo + 1 uber, senza preprocessore; i marcatori `// --- piece: X ---` riconducono gli errori ai pezzi |
   ~~~~
2. `.claude/skills/new-primitive/SKILL.md`: sostituisci il file per intero con:
   ~~~~markdown
   ---
   name: new-primitive
   description: Add a new render primitive type (library piece + composer registration + API). Use when adding a new RenderPrimitiveType to the engine.
   ---

   Add a new RenderPrimitiveType to the Hyperion Engine. The user should provide: primitive name and SDF/geometry approach.

   Since phase 5b a primitive is not a shader file: it is a LIBRARY piece that the TypeScript
   composer (`ts/src/render/primitive-shaders.ts`) joins to the shared prelude, once as its own
   per-type module (opaque pipeline + occluder pipeline) and once as a `case` of the uber module
   (the one transparent pipeline). A piece never compiles alone.

   ## Prerequisites

   Read these first:
   - `ts/src/shaders/primitives/prelude.wgsl` — the bindings (groups 0/1/2), `CameraUniform`, `VertexOutput`, `OCCLUDER_PASS`/`castsInto`, the lighting block and the helpers (`culledVertex`, `finishVertex`, `unitQuadVertex`, `sampleTier`, `sampleTierOrWhite`, `occluderSeed`, `applyLighting`)
   - `ts/src/shaders/primitives/quad.wgsl` (the smallest library) and `line.wgsl` (its own vertex expansion and occluder rule)
   - `ts/src/render/primitive-shaders.ts` — `PRIMITIVE_LIBRARIES` and the three compose functions
   - `ts/src/entity-handle.ts` — `RenderPrimitiveType` (mirrored in `ts/src/prim-params-schema.ts`) and the fluent API pattern
   - `ts/src/render/passes/cull-pass.ts` and `ts/src/shaders/cull.wgsl` — `NUM_PRIM_TYPES`

   ## Checklist

   1. **Library** `ts/src/shaders/primitives/{name}.wgsl`:
      - NO `@group`/`@binding`, no entry point, no directive, and never the text `fn fs_occluder` (not even in a comment): the prelude and the composer own them;
      - EVERY top-level name carries the library's prefix (`{p}_`); no local `let`/`var`/`const` or parameter reuses a prelude global's name (WGSL would shadow it silently);
      - exactly `{p}_vs(position: vec3f, entityIdx: u32) -> VertexOutput`, `{p}_fs(in: VertexOutput) -> vec4f` and `{p}_occluder(in: VertexOutput) -> vec4f`, with the coverage in `{p}_shade(in: VertexOutput) -> vec4f`, reached by both `{p}_fs` and `{p}_occluder`;
      - `{p}_vs` ends in `finishVertex(...)`, or is `unitQuadVertex(...)` for a unit quad; `{p}_occluder` is usually `return occluderSeed(in, {p}_shade(in).a);`;
      - lighting only through `applyLighting(in, color)`, only from `{p}_fs`, and only if the type is lit — never from `{p}_shade`/`{p}_vs` (the occluder pipelines have no group 2);
      - derivatives (`fwidth`, `dpdx`) before any branch of `{p}_shade`: the per-type module compiles under the strict uniformity analysis;
      - sample the tiers with `sampleTierOrWhite(in)` (packed index 0 answers white) unless the texture is data, as msdf's atlas (raw `sampleTier`); `textureSampleLevel`, never `textureSample`, outside fragment code.
   2. **Register** it in `PRIMITIVE_LIBRARIES` (`ts/src/render/primitive-shaders.ts`): `{ type, name, prefix, lit }`. That derives its per-type module in `ForwardPass.SHADER_SOURCES`, its `case` in the uber `vs_main`/`fs_main`, and `LIT_PRIMITIVE_TYPES`.
   3. **renderer.ts**: the `?raw` import of the piece next to the others, its entry in `primitivePieces.libraries`, a piece slot in `shaderSlots` (the same probe as the other pieces, `usedBy: inEveryMode`), and its `import.meta.hot.accept` block feeding the `PieceReloadCollector`. A piece without its own accept turns every edit into a FULL page reload (on this machine: the NVIDIA adapter and a lost device).
   4. **Type id**: Light2D (6) is the last type, and `cull.wgsl`, `deriveLightGroups` and the uber `vs_main` clamp anything past it to 6 (a light). A new drawable type therefore means moving Light2D: `NUM_PRIM_TYPES` in `cull.wgsl` and `cull-pass.ts` (indirect args = NUM_PRIM_TYPES × 2 × 2 entries of 20 B; the "Indirect args are 28 entries" gotcha in CLAUDE.md), `PRIM_TYPE_LIGHT2D` in Rust, `LIGHT2D_ARG_SLOTS`, the gather's bucket range (`FIRST_TRANSPARENT_ARG`, `GATHER_REGIONS` in `transparent-sort-constants.ts` and in the WGSL) and the uber's clamp in the composer.
   5. **EntityHandle** (`ts/src/entity-handle.ts`): the `RenderPrimitiveType` value and a fluent method that sends `setRenderPrimitive` and its params; `PRIM_PARAMS_SCHEMA` in `prim-params-schema.ts`.
   6. **Barrel** (`ts/src/index.ts`) if public.
   7. **Tests**: the composer tests (the per-type module has `vs_main`/`fs_main`/`fs_occluder`, the uber has the new `case`, prefix and unique-name rules, group 2 reachable iff lit), `entity-handle.test.ts`, and `cull-pass.test.ts` if `NUM_PRIM_TYPES` moved.
   8. **Docs**: CLAUDE.md — a library row in the Shaders table, the type list of the "Adding a new primitive type" gotcha.

   ## Validation

   ```bash
   scripts/preflight.sh
   ```

   That script is the single definition of "validated" — do not reconstruct the command list
   here. See the `/validate` skill for what it covers.

   Then verify on a real GPU, which nothing automated can do — WebGPU returns null from
   `requestAdapter()` headless, so a green preflight says nothing about whether the new
   primitive draws: the `/gpu-check` skill (also with the primitive `.transparent()`, which
   draws through the uber pipeline).

   Run the **`wgsl-validator`** agent as well: it composes the 7 modules and checks the
   prelude-only bindings, the prefixes and the group-2 reachability.
   ~~~~
3. `.claude/skills/gpu-check/SKILL.md`:
   - `` An edit to one of the 18 hot-reloadable WGSL files (`import.meta.hot.accept` in `renderer.ts`) is swapped in place and the page stays: keep it when the shader hot-reload is what you are checking. `` diventa:
     ~~~~text
     An edit to one of the 20 hot-reloadable WGSL files (`import.meta.hot.accept` in `renderer.ts`; the 7 primitive pieces are grouped by a 50 ms debounce) is swapped in place and the page stays: keep it when the shader hot-reload is what you are checking. A WGSL file WITHOUT its own accept reloads the whole page.
     ~~~~
   - `` **2D Twins** (3/3) is the one check of scatter format 0: run it once with `?mode=C`, where its row check must report scatter frames (Mode B uploads every row, so there it reports 0). `` diventa:
     ~~~~text
     **2D Twins** (6 checks) holds the one check of scatter format 0 and the transparent-sort checks: run it with `?mode=C` too, where its row check must report scatter frames (Mode B uploads every row, so there it reports 0) and 'Transparent sort under churn' runs (in Mode B it skips: 5/6 passed · 1 skipped). Its setup takes several seconds (texture load, 10-frame reads): wait for it.
     ~~~~
4. `.claude/agents/wgsl-validator.md`: sostituisci il file per intero con:
   ~~~~markdown
   ---
   name: wgsl-validator
   description: Cross-validates every WGSL shader — the top-level ones and the composed primitive modules (prelude + libraries in ts/src/shaders/primitives/) — for bind group layout consistency, ResourcePool naming agreement, indirect-args sizing, texture tier coverage, the sort kernels' budgets and Metal-safe texture sampling. Use after creating or editing any .wgsl file or any render pass that owns a pipeline.
   tools: Read, Grep, Glob, Bash
   model: sonnet
   ---

   You are a WGSL shader validator for the Hyperion Engine.

   Validate shader correctness by checking:

   1. **Primitive composition (phase 5b)**: the primitive shaders are PIECES in `ts/src/shaders/primitives/` — `prelude.wgsl` plus six libraries (quad, line, msdf-text, bezier, gradient, box-shadow) — composed by `ts/src/render/primitive-shaders.ts` into 6 per-type modules (`ForwardPass.SHADER_SOURCES`) and one uber module (`ForwardPass.UBER_SOURCE`). A piece does not compile alone: check the COMPOSED modules (write them headless with `DUMP_WGSL_DIR=/tmp/claude-1000/wgsl npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts`, then read the files it writes there). Check that:
      - only the prelude declares `@group`/`@binding` (groups 0, 1 and 2), matching `primitiveGroup0LayoutEntries`, `textureTierLayoutEntries` and ForwardPass's group-2 layout, stage visibility included;
      - a library has no `@group`/`@binding`, no entry point, no directive, never the text `fn fs_occluder`, and every top-level name carries its prefix (`quad_`, `line_`, `msdf_`, `bezier_`, `gradient_`, `boxshadow_`); no name is declared twice across the prelude and the libraries;
      - each per-type module has `vs_main`, `fs_main`, `fs_occluder` and no directive; the uber has `diagnostic(off, derivative_uniformity);` as its FIRST line, no `fs_occluder`, clamps the type like `cull.wgsl` (`min(... & 0xFFu, 6u)`), and one `default` per switch;
      - group 2 (`lightBuffer`, `lightSampler`, `lighting`, `lightGroupOf`) is reachable only from `fs_main`, and only for the lit types (quad, gradient) — never from `vs_main` or `fs_occluder` (OccluderSeedStage runs `fs_occluder` on a two-group layout).
   2. **ResourcePool naming**: Buffer names in shaders must match ResourcePool registrations in renderer.ts, cull-pass.ts, scatter-pass.ts, forward-pass.ts, transparent-sort-pass.ts
   3. **ScatterPass / CullPass SoA agreement**: @group(1) in scatter.wgsl must write to the same buffers CullPass reads
   4. **Indirect args sizing**: cull.wgsl declares `array<DrawIndirectArgs, TOTAL_BUCKETS>`, derived from `NUM_PRIM_TYPES` = 7: 7 primitive types x 2 material buckets x 2 blend modes (opaque = entries 0-13, transparent = 14-27) = 28 entries = 560 bytes. Verify the WGSL array length, the cull-pass.ts buffer allocation, and any CLAUDE.md claim all agree. The transparent buckets 14-25 are GATHERED by `transparent-gather.wgsl` (`FIRST_TRANSPARENT_ARG` = 14, `GATHER_REGIONS` = 12), not drawn; 26/27 (Light2D) never.
   5. **Texture tier switch coverage**: `sampleTier` in the prelude handles every tier (tier0-tier3 + ovf0-ovf3); `sampleTierOrWhite` answers packed index 0 with white before sampling; msdf-text calls the raw `sampleTier`.
   6. **Subgroup directive**: cull.wgsl must NOT contain `enable subgroups;` inline (prepended at pipeline creation by prepareShaderSource())
   7. **Fragment-only functions**: No `textureSample()` in vertex/compute stages (must use `textureSampleLevel()` for macOS/Metal compatibility)
   8. **Sort kernels**: `transparent-gather.wgsl` (7 storage + 1 uniform) and `transparent-sort.wgsl` (6 storage + 1 uniform, one layout for its three entry points) stay within 8 storage buffers per stage, every declared binding read; `transparent-args` is read-only in the sort layout and read_write only in the gather; the WGSL `CAP` equals `MAX_GPU_ENTITIES`; workgroup memory per entry point ≤ 16 384 B; `PASSES` is odd, so the last pass writes `transparent-order`.

   Read all .wgsl files recursively (`ts/src/shaders/**/*.wgsl`) plus the composed modules, and cross-reference with the TypeScript pipeline files. Report mismatches with file:line references; for a composed module, the `// --- piece: <name> ---` marker above the line names the piece.
   ~~~~
5. `.claude/agents/webgpu-pass-reviewer.md`:
   - `` against the WGSL they drive (`ts/src/shaders/*.wgsl`). `` diventa `` against the WGSL they drive (`ts/src/shaders/**/*.wgsl`; for a primitive, the COMPOSED module — prelude + library — is what runs). ``
   - sostituisci l'item 7 (da `7. **Indirect draws.**` fino alla fine del suo paragrafo) con:
     ~~~~text
     7. **Indirect draws.** `drawIndexedIndirect(buffer, slot * 20)`: slot + 1 within the 28-entry,
        560-byte `indirect-args`; a non-zero `firstInstance` needs the `indirect-first-instance` device
        feature. For Light2D, LIGHT2D_ARG_SLOTS must be every slot cull.wgsl can fill (12, 13, 26, 27).
        The uber transparent draw is `drawIndexedIndirect(transparent-args, 0)`: its 64-byte header is
        DrawIndexedIndirect {6, n, 0, 0, 0} at word 0, DispatchIndirect {ceil(n/1024), 1, 1} at byte 20,
        raw/limit/overflow/stamp at words 8-11 — `prepare()` resets it, the gather fills it; firstInstance
        0, so it needs no feature. In a render pass `transparent-args` is INDIRECT only, never bound (the
        usage scope is the whole pass); the sort binds it read-only in the dispatches it also drives.
     ~~~~
   - sostituisci l'item 8 (da `8. **Groups a pipeline's layout lacks.**` fino alla fine del suo paragrafo) con:
     ~~~~text
     8. **Groups a pipeline's layout lacks.** An entry point that statically uses a binding its pipeline
        layout does not have fails pipeline creation. Every composed primitive module DECLARES group 2
        (the prelude does), but only the lit types' `fs_main` (quad, gradient; their cases in the uber)
        may reach it, through `applyLighting` — never `<p>_shade`, `<p>_vs` or a prelude helper that
        `fs_occluder` reaches, because OccluderSeedStage runs `fs_occluder` on a two-group layout.
        Conversely `setBindGroup(2, …)` is needed for every ForwardPass pipeline, the uber included. The
        uber module must never reach OccluderSeedStage (it is not in `SHADER_SOURCES`).
     ~~~~
   - dopo l'item 11 aggiungi:
     ~~~~text
     12. **Pool resources owned by the renderer.** A pass must not register pool resources in `setup()`:
         HMR probes run `setup()` then `destroy()` against the LIVE pool. `entity-ids`,
         `transparent-order` and `transparent-args` are created by `createRenderer`; `entity-ids` is
         uploaded there when `entityIdsGeneration` changes, scatter frames included, and nothing in
         `execute()` may call `writeBuffer` on a buffer an earlier pass of the same submit reads.
     ~~~~
6. `.claude/agents/claude-md-auditor.md`, §8: la riga `ls -1 ts/src/shaders/*.wgsl | wc -l                                  # on disk` diventa `find ts/src/shaders -name '*.wgsl' | wc -l                            # on disk (the primitive pieces in primitives/ included)`, e alla fine del paragrafo che comincia con `A shader can exist on disk yet be a design artifact` aggiungi: ` The 7 primitive pieces are imported and hot-reloadable but are not standalone modules: they compile only once composed (6 per-type modules + the uber).`
7. `.claude/hooks/post-edit-notices.sh`: sostituisci il primo blocco `case "$base" in *.wgsl) … esac` (oggi L29-38) con:
   ```bash
   case "$file" in
     */shaders/primitives/prelude.wgsl)
       add "Primitive PRELUDE modified ($base).
     The prelude is the ONLY place that declares the primitive bindings (groups 0, 1, 2),
     CameraUniform (80 B), VertexOutput, OCCLUDER_PASS/castsInto and the lighting block
     (applyLighting). Changing a binding means changing render/primitive-bindings.ts,
     ForwardPass (group 2 too) and OccluderSeedStage together; CameraUniform also means both
     camera writers. It is composed into all 7 modules (6 per-type + the uber). Run
       npx --prefix ts vitest run --root ts src/render/primitive-shaders.test.ts
     and the wgsl-validator agent before committing."
       ;;
     */shaders/primitives/*.wgsl)
       add "Primitive LIBRARY modified ($base).
     A library declares no @group/@binding, no entry point, no directive and never the
     text 'fn fs_occluder'. Every top-level name carries its prefix (quad_ line_ msdf_
     bezier_ gradient_ boxshadow_), and it exposes <prefix>_vs/_fs/_occluder only (plus its
     <prefix>_shade coverage). Lighting only through applyLighting, from quad_fs/gradient_fs.
     Derivatives before any branch. It is composed into its per-type module AND the uber. Run
       npx --prefix ts vitest run --root ts src/render/primitive-shaders.test.ts
     and the wgsl-validator agent before committing."
       ;;
     *.wgsl)
       add "WGSL shader modified ($base).
     The TS pass that builds its pipeline must declare the same bind group layout, and
     every pool resource it binds must be registered under the same name.
     ScatterPass @group(1) must also match what CullPass reads from the ResourcePool.
     Run the wgsl-validator agent before committing."
       ;;
   esac
   ```
8. `.claude/hooks/README.md`: la riga `` | `post-edit-notices.sh` | PostToolUse | various | Surfaces cross-cutting invariants no compiler checks (WGSL bind groups, protocol files, physics, structural files). | `` diventa:
   ~~~~text
   | `post-edit-notices.sh` | PostToolUse | various | Surfaces cross-cutting invariants no compiler checks: WGSL by path (the primitive prelude — the only bindings, composed into 7 modules; a primitive library — prefixes, no bindings or entry points; any other shader — its pass's layout), protocol files, physics, structural files. |
   ~~~~

- [ ] **Step 13: L'hook scatta per i tre percorsi**

```bash
cd /home/edoardocicognani/Code/HyperionEngine
for f in ts/src/shaders/primitives/prelude.wgsl ts/src/shaders/primitives/line.wgsl ts/src/shaders/cull.wgsl; do
  printf '%s' '{"tool_name":"Edit","tool_input":{"file_path":"'"$PWD/$f"'"}}' \
    | CLAUDE_PROJECT_DIR="$PWD" bash .claude/hooks/post-edit-notices.sh 2>&1 | head -1; echo "exit=${PIPESTATUS[1]}"
done
```
Expected: tre coppie di righe: `Primitive PRELUDE modified (prelude.wgsl).` / `exit=2`, `Primitive LIBRARY modified (line.wgsl).` / `exit=2`, `WGSL shader modified (cull.wgsl).` / `exit=2`.

- [ ] **Step 14: I commenti nel codice**

Per ciascuna voce: se la stringa vecchia non c'è più, un task precedente l'ha già corretta e si passa alla successiva.
1. `ts/src/entity-handle.ts`, JSDoc di `depth()`: le righe
   ```ts
      * It orders a sprite against OPAQUE ones only: between two `.transparent()`
      * sprites the draw order decides (primitive type, then cull order) until
      * transparent entities are sorted by depth. On a 3D entity, which takes its
   ```
   diventano:
   ```ts
      * It orders transparent sprites too: they are drawn back to front by world z,
      * and at equal z the entity with the higher id is in front (the newest one
      * only while ids are fresh: give sprites different depths to order them).
      * On a 3D entity, which takes its
   ```
2. `ts/src/entity-handle.ts`, JSDoc di `transparent()`: le righe
   ```ts
      * Mark entity as transparent: alpha-blended, drawn after the opaque ones,
      * with no depth write. Transparent entities are not sorted yet, so two that
      * overlap compose in draw order, whatever their depth. Returns `this`.
   ```
   diventano:
   ```ts
      * Mark entity as transparent: alpha-blended, drawn after the opaque ones,
      * with no depth write, back to front by world z (at equal z the higher id
      * is in front). Returns `this`.
   ```
3. `ts/src/prim-params-schema.ts:8`: `` * The mappings match the WGSL shader layouts (ts/src/shaders/*.wgsl) and the `` → `` * The mappings match the primitive libraries (ts/src/shaders/primitives/*.wgsl) and the ``.
4. `ts/src/demo/primitives.ts:52`: `// Rounded, and crisp: box-shadow.wgsl rounds the corners only in its` → `// Rounded, and crisp: the box-shadow library rounds the corners only in its`.
5. `ts/src/render/primitive-bindings.ts`:
   - `` * Bind group layouts shared by every pipeline that runs a primitive shader: `` / `` * the ForwardPass pipelines and the occluder pipelines (OccluderSeedStage). Both run the `` / `` * same WGSL modules, so both must hand the device the same layouts. `` → `` * Bind group layouts the primitive prelude declares, shared by every pipeline that `` / `` * runs a composed primitive module: the ForwardPass opaque pipelines, its uber pipeline `` / `` * and the occluder pipelines (OccluderSeedStage, groups 0 and 1 only). ``
   - `` // CameraUniform is 80 bytes in every primitive shader (viewProjection + `` / `` // occluderLayers + the viewport size line.wgsl reads + a pad). `` → `` // CameraUniform is 80 bytes, declared once in the prelude (viewProjection + `` / `` // occluderLayers + the viewport size line_vs reads + a pad). ``
   - `/** Group-1 resources of every primitive shader, in binding order: tier0-3, the sampler, ovf0-3. */` → `/** Group-1 resources the prelude declares, in binding order: tier0-3, the sampler, ovf0-3. */`
   - ` * The group-1 layout every primitive shader declares: four texture tiers, the` → ` * The group-1 layout the prelude declares: four texture tiers, the`
6. `ts/src/render/passes/occluder-seed-stage.ts`:
   - `/** CameraUniform in every primitive shader: viewProjection + occluderLayers + viewport size + pad. */` → `/** CameraUniform (the prelude): viewProjection + occluderLayers + viewport size + pad. */`
   - ` * It does not use a shader of its own. It runs each primitive's OWN module` → ` * It does not use a shader of its own. It runs each primitive's composed per-type module`
   - ` * no shadow or whose mask misses the set's layers (\`castsInto\`, in each` / ` * primitive shader). A primitive with no \`fs_occluder\` casts nothing.` → ` * no shadow or whose mask misses the set's layers (\`castsInto\`, in the` / ` * prelude). A module with no \`fs_occluder\` (the uber) casts nothing and is never given here.`
7. `ts/src/hyperion.ts`: `/** Recompile a named shader pass with new WGSL source (dev tool). */` → `/** Recompile a named shader pass with new WGSL source (dev tool). For a primitive ('prelude', 'quad'/'basic', 'line', 'msdf-text', 'bezier', 'gradient', 'box-shadow') the source is that PIECE, not a whole module. */`

Poi:
```bash
npm --prefix ts test
npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"
grep -rnE "basic\.wgsl|RadixSortPass|radix-sort|transparentPipelines|floatToSortKey|CPU-only|12 pipelines|18 hot-reloadable|20 WGSL files|22 WGSL shaders" \
  ts/src CLAUDE.md PROJECT_ARCHITECTURE.md hyperion-masterplan.md .claude --include="*.ts" --include="*.md" --include="*.sh" --include="*.js"
```
Expected: vitest verde, `tsc` senza output. Il `grep` può trovare solo menzioni storiche volute (la riga della Phase 13, "(was `basic.wgsl`)", "`RadixSortPass` was dead that way until phase 5b removed it", i documenti in `docs/plans`, esclusi) e le quattro righe volute del Task 15 Step 12: il commento in `forward-pass.ts`, il commento in `forward-pass.test.ts`, e in `transparent-sort-pass.test.ts` la riga `it('keeps no trace of RadixSortPass'` con la sua regex. Quel test è l'unica guardia headless del cablaggio di `renderer.ts`, quindi quelle righe restano. Ogni altra riga è un residuo da correggere con il testo di questo task.

- [ ] **Step 15: Commit**

```bash
git diff --numstat
git add CLAUDE.md PROJECT_ARCHITECTURE.md hyperion-masterplan.md \
  .claude/skills/new-primitive/SKILL.md .claude/skills/gpu-check/SKILL.md \
  .claude/agents/wgsl-validator.md .claude/agents/webgpu-pass-reviewer.md .claude/agents/claude-md-auditor.md \
  .claude/hooks/post-edit-notices.sh .claude/hooks/README.md \
  ts/src/entity-handle.ts ts/src/prim-params-schema.ts ts/src/demo/primitives.ts \
  ts/src/render/primitive-bindings.ts ts/src/render/passes/occluder-seed-stage.ts ts/src/hyperion.ts
git commit -m "docs(5b): documentazione e strumenti della fase 5b" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Expected: nel `numstat` nessun `.md` che perde molte più righe di quante ne guadagna (in PROJECT_ARCHITECTURE la sezione della visibility indirection e il §24 si accorciano di poco).

---

### Task 23: validazione finale, review avversariale, merge

**Files:**
- Modify: i file indicati dai finding confermati (con un test che fallisce prima), `docs/plans/2026-09-27-open-items-round-plan.md` (§4, nota del passo 5b)
- Modify (fuori dal repo): `/home/edoardocicognani/.claude/projects/-home-edoardocicognani-Code-HyperionEngine/memory/transparent-sort-phase.md`, `.../memory/open-items-round-2026-09-27.md`, `.../memory/MEMORY.md`

**Interfaces:**
- Consumes: il branch `feat/transparent-sort-uber` completo (Task 1-22); la workflow `adversarial-review`; gli agent `wgsl-validator`, `webgpu-pass-reviewer`, `protocol-sync-checker`, `claude-md-auditor`
- Produces: il merge `--no-ff` su `master`, pushato; la memoria aggiornata (fase 5b fatta, il giro riprende dal passo 6)

- [ ] **Step 1: Preflight completo**

Run: `scripts/preflight.sh --full`

Expected: ogni passo `OK` (matrice Rust, clippy `-D warnings`, `tsc`, vitest, build WASM release, gate < 200 KB, build fisica, coerenza del protocollo). Un passo `FALLITO` si corregge (test prima) e si rilancia da capo.

- [ ] **Step 2: Review avversariale**

Lancia la workflow (tool `Workflow`) con:
```js
Workflow({ name: 'adversarial-review', args: {
  range: '72c0f7e..HEAD',
  spec: 'docs/plans/2026-09-27-transparent-sort-uber-design.md',
  plan: 'docs/plans/2026-09-27-transparent-sort-uber-plan.md',
  context: 'Phase 5b of the 2026-09-27 round: GPU transparent sort + uber pipeline, branch feat/transparent-sort-uber, base 72c0f7e (the range includes the spec commits). GPU gates ran on the AMD iGPU in Modes B and C (plan Tasks 8, 12, 18, 21); evidence and measurements in docs/plans/assets/2026-09-27-transparent-sort-* and design §11.',
  accepted: [
    'D2: at equal world z the higher external id is in front; after 1,048,576 cumulative spawns released ids come back oldest first, so it is no longer the newest entity. Documented; .depth() is the ordering API.',
    'With overflow (visible transparents > transparentCount) the drawn set is not deterministic; overflow means the CPU count is wrong, and the GPU checks require overflow == 0.',
    'Mode A and Safari cannot be GPU-verified on this machine (accepted risk, design §10).',
    'A transparent at the same z as an overlapping opaque stays hidden (strict depthCompare less), as before.',
    'Transparent primitives receive no selection outline (SelectionSeedPass draws buckets 0/1 only), as before.',
    'The sort key is world z because the camera always looks down -Z; a rotating or perspective camera would need view depth.',
    'Order-independent transparency is out of scope.',
    "recompileShader('basic'|'quad'|...) now takes a PIECE, not a whole module.",
    'A coupled piece edit saved together with a broken unrelated piece is rejected whole (declared limit, design §3.3).',
    'engine_init restarts ids_generation at 0: safe because every bridge calls it once before any frame and every renderer starts its marker at NaN.',
    'transparentCount includes transparent Light2D rows: an upper bound, used only for sizing.',
  ],
  lenses: [
    'webgpu', 'protocol', 'docs',
    { key: 'sort', prompt: 'LENS: the GPU sort and its CPU model. Read transparent-gather.wgsl and transparent-sort.wgsl side by side with transparent-sort-reference.ts and transparent-sort-pass.ts: every barrier in uniform control flow; no non-atomic workgroup address written by one invocation and touched by another between two barriers; the stability argument of the scatter (digitBase + tile scan + round cursor + popcount rank); the last pass writing values only; header words (draw at 0, dispatch at byte 20, raw/limit/overflow/stamp at 8-11) against prepare() and the readback; B = min(transparentCount, CAP) and every dispatch count; layouts vs WGSL (<= 8 storage per stage, minBindingSize); no writeBuffer in execute(); profileStages vs mark(). Also the Rust recount of transparent_count and ids_generation (every slot->id change bumps it, reset/restore bump it) and every transport site of transparentCount/entityIdsGeneration in Modes A/B/C.' },
    { key: 'composition', prompt: 'LENS: shader composition and hot-reload. primitive-shaders.ts and ts/src/shaders/primitives/*: each composed per-type module behaves as the old per-file shader (lighting only from quad_fs/gradient_fs, msdf on the raw sampleTier, line discard/occluder rules, fwidth before branches, OCCLUDER_PASS early-out); the uber: the directive only there and first, the type clamp as cull.wgsl, one default per switch, no fs_occluder, never in SHADER_SOURCES; group 2 unreachable from vs_main/fs_occluder; reloadShaders/PieceReloadCollector: no graph from a rejected or untried set, versions and superseded, an empty piece never replaces a candidate, slots restored after a rejection; ForwardPass: bindGroup0Sorted binding 2 = transparent-order, one drawIndexedIndirect(transparent-args, 0), skipped at count 0, transparent-args never bound.' },
  ],
} })
```
Annota l'id della corsa (`wf_…`) e la lista dei finding confermati con la severità.

Expected: la workflow termina con la lista dei finding verificati; quelli respinti dagli scettici non contano.

- [ ] **Step 3: Gli agent**

Lancia, in parallelo, gli agent (tool Agent, `subagent_type` uguale al nome):
- `wgsl-validator` con il prompt: "Phase 5b branch feat/transparent-sort-uber. Validate every WGSL file recursively under ts/src/shaders and the 7 composed primitive modules (write them with DUMP_WGSL_DIR=/tmp/claude-1000/wgsl npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts), plus transparent-gather.wgsl and transparent-sort.wgsl against transparent-sort-pass.ts. Report mismatches with file:line.";
- `webgpu-pass-reviewer` con: "Review the passes changed in 72c0f7e..HEAD: ts/src/render/passes/forward-pass.ts, transparent-sort-pass.ts, occluder-seed-stage.ts, ts/src/render/transparent-sort-probe.ts, ts/src/renderer.ts (entity-ids upload, transparent-order/transparent-args creation, frameStamp, sortProbe wiring). Items 1-12 of your checklist.";
- `protocol-sync-checker` con: "Check the two new WASM exports engine_gpu_transparent_count and engine_gpu_entity_ids_generation (crates/hyperion-core/src/lib.rs) against every TS consumer. The engine worker's WASM calls moved out of engine-worker.ts in Task 10: check the WasmEngine interface and captureRenderState (both render-state literals, non-empty and empty world) in ts/src/worker-render-state.ts, which engine-worker.ts imports. Also check the Mode C WASM interface and reads in createDirectBridge(loadWasm?) in ts/src/worker-bridge.ts. Follow the GPURenderState/WorkerRenderState fields transparentCount/entityIdsGeneration through Mode A (the main-thread copy in worker-bridge.ts and toGPURenderState in worker-render-state.ts, called by render-worker.ts), Mode B and Mode C. CommandType tables, the ring-buffer header and payloads must be unchanged. Report every mismatch with file:line.";
- `claude-md-auditor` con: "Audit CLAUDE.md. The merge-base is 72c0f7e: build a worktree there and run the same commands on both sides, so drift caused by branch feat/transparent-sort-uber is separated from pre-existing drift. Focus on the phase-5b rows, the shader counts (find ts/src/shaders -name '*.wgsl'), the test counts and every backticked identifier the branch added."

Expected: ogni agent restituisce un rapporto; annota i problemi segnalati.

- [ ] **Step 4: Correggi Critical e Important, un test che fallisce prima**

Per ogni finding confermato Critical o Important (review o agent), in quest'ordine:
1. scrivi il test che riproduce il difetto: vitest colocato o `cargo test` per il codice headless; per ciò che solo la GPU vede, un check o un passo `/gpu-check` con il criterio esatto;
2. eseguilo (`npx --prefix ts vitest run --root ts src/<path>.test.ts` oppure `cargo test -p hyperion-core --lib <filtro>`): deve FALLIRE per il motivo descritto nel finding;
3. correggi il codice con la modifica minima;
4. rieseguilo: PASS; poi `npm --prefix ts test` e, se hai toccato Rust, `cargo test -p hyperion-core --all-features`;
5. commit:
   ```bash
   git add <file toccati>
   git commit -m "fix(5b): review <wf-id> — <titolo del finding in italiano>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
   ```
I finding Minor si correggono con lo stesso schema, oppure si annotano come accettati nella nota dello Step 7. Un finding che contraddice una decisione della §0 della spec non si "corregge": si riporta all'utente.

- [ ] **Step 5: Rivalida dopo le correzioni**

```bash
scripts/preflight.sh
SHA21=$(git log --format=%h -1 --grep='cancello GPU del passo 4')
git diff --stat "$SHA21"..HEAD -- ts/src crates
```
Expected: preflight tutto `OK`. Se il `diff --stat` mostra file sotto `ts/src/render`, `ts/src/shaders`, `ts/src/renderer.ts`, `ts/src/demo` o `crates`, riesegui il controllo GPU: `npm --prefix ts run build:wasm` se è cambiato Rust, riavvio del dev server, poi con **chrome-devtools-gpu** — `list_pages` → `pageId` (o `new_page` con `about:blank`); `pageId` su ogni chiamata MCP che segue e `waitForStableDom: false` su ogni `evaluate_script` — `navigate_page` (`?mode=B`, `ignoreCache: true`, l'`initScript` `GPU.prototype.requestAdapter = (o => function (x) { return o.call(this, { ...(x || {}), powerPreference: 'low-power' }); })(GPU.prototype.requestAdapter)`), `resize_page` 1920×1080, di nuovo `navigate_page`, e per ogni tab lo script di lettura dei check:
```js
async () => {
  const KEY = 'twin-2d', LABEL = '2D Twins';
  const section = (await import(`/src/demo/${KEY}.ts`)).default;
  const setup = section.setup;
  let done;
  const finished = new Promise((r) => { done = r; });
  section.setup = async function (...a) { try { return await setup.apply(this, a); } finally { section.setup = setup; done(); } };
  [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes(LABEL)).click();
  await Promise.race([finished, new Promise((r) => setTimeout(r, 60000))]);
  await new Promise((r) => setTimeout(r, 600));
  return [...document.querySelectorAll('.check-item')].map((item) => ({
    name: item.querySelector('.check-name')?.textContent,
    status: [...item.querySelector('.check-icon').classList].find((c) => c !== 'check-icon'),
    detail: item.nextElementSibling?.classList.contains('check-detail') ? item.nextElementSibling.textContent : '',
  }));
}
```
(con `KEY`/`LABEL` di ciascun tab: primitives/Primitives, scene-graph/Scene Graph, input/Input, audio/Audio, particles/Particles, rendering-fx/Rendering FX, lighting/Lighting, debug-tools/Debug Tools, lifecycle/Lifecycle, twin-2d/2D Twins), poi 2D Twins anche in `?mode=C`, e `list_console_messages` (`types: ["error", "warn"]`). Expected: gli stessi stati del Task 21 (nessun `fail`; Input 2/6 con 4 `pending`; i tre `skip` noti; in 2D Twins 6 check, 'Transparent sort under churn' `skip` in B e `pass` in C) e nessun errore WebGPU.

Se le correzioni hanno aggiunto o tolto test, rilancia lo script dei conteggi dello Step 1 del Task 22:
```bash
cd /home/edoardocicognani/Code/HyperionEngine
lib() { cargo test -p hyperion-core --lib "$@" 2>&1 | grep -oE 'ok. [0-9]+ passed' | awk '{print $2}'; }
sum() { grep -oE 'ok. [0-9]+ passed' | awk '{s+=$2} END {print s}'; }
echo "lib: none=$(lib) physics-2d=$(lib --features physics-2d) dev-tools=$(lib --features dev-tools) all=$(lib --all-features)"
echo "total: none=$(cargo test -p hyperion-core 2>&1 | sum) physics-2d=$(cargo test -p hyperion-core --features physics-2d 2>&1 | sum) dev-tools=$(cargo test -p hyperion-core --features dev-tools 2>&1 | sum) all=$(cargo test -p hyperion-core --all-features 2>&1 | sum)"
for m in ring_buffer render_state components; do echo "$m=$(lib "$m")"; done
echo "engine=$(lib engine) +physics=$(lib --features physics-2d engine) +physics+dev=$(lib --features 'physics-2d dev-tools' engine) all=$(lib --all-features engine)"
echo "command_proc=$(lib command_proc) +physics=$(lib --features physics-2d command_proc)"
echo "systems=$(lib systems) +physics=$(lib --features physics-2d systems)"
for t in verify_findings verify_physics verify_ring verify_hier verify_snapshot verify_determinism verify_reuse verify_2d; do
  echo "$t=$(cargo test -p hyperion-core --all-features --test "$t" 2>&1 | grep -oE 'ok. [0-9]+ passed' | awk '{print $2}')"
done
npm --prefix ts test 2>&1 | grep -E 'Test Files|Tests '
for f in hyperion backpressure entity-handle render/passes/cull-pass physics-api lighting-api; do
  echo "$f: $(npx --prefix ts vitest run --root ts "src/$f.test.ts" 2>&1 | grep -E '^ +Tests ')"
done
```
e aggiorna in CLAUDE.md i numeri che sono cambiati (le stesse righe dello Step 2 del Task 22), con un commit `docs(5b): conteggi dei test dopo la review`.

- [ ] **Step 6: Nota nel piano del giro**

In `docs/plans/2026-09-27-open-items-round-plan.md`, nella sezione `## 4. Trovato lungo la strada`, dopo il bullet che comincia con `- **Passo 5 (Depth → z) — fatto**` e i suoi sotto-punti, aggiungi (i valori vengono dallo Step 2 e dal §11 della spec):
```markdown
- **Passo 5b (ordinamento dei trasparenti, fase a sé) — fatto** (spec `2026-09-27-transparent-sort-uber-design.md`, piano `2026-09-27-transparent-sort-uber-plan.md`; review `<wf-id dello Step 2>`: <numero> finding confermati, corretti i Critical e gli Important). Gli shader delle primitive sono composti da un preludio + sei librerie; la colonna `entity-ids` arriva sulla GPU; `TransparentSortPass` fa gather + radix stabile a 7 passate; un solo draw uber disegna tutti i trasparenti, dal fondo al davanti per (z di mondo, id). Verificato sull'iGPU AMD in Mode B e C: check nuovi di 2D Twins verdi, stati uguali alla baseline, punti statici opachi identici al bit, trasparenti entro 1/255. Sort a 100k trasparenti visibili: <ms con depth uguali> / <ms con depth distinte> ms; `forward` 4−3: <ms> ms (§11 della spec).
```
Sostituisci i quattro campi tra `< >` con i valori prima di salvare. Poi:
```bash
git add docs/plans/2026-09-27-open-items-round-plan.md
git commit -m "docs: passo 5b fatto nel piano del giro" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Merge e push**

L'autonomia del giro (memoria `feedback-autonomous-round`) copre commit, merge e push per passo, senza chiedere.
```bash
git status --short
git checkout master
git pull --ff-only origin master
git merge --no-ff feat/transparent-sort-uber -m "Merge branch 'feat/transparent-sort-uber'" \
  -m "Passo 5b del giro: ordinamento GPU dei trasparenti (gather + radix stabile a 7 passate, per z di mondo e id) e un solo draw uber; shader delle primitive composti da preludio + sei librerie; colonna entity-ids e transparentCount; MAX_GPU_ENTITIES; RadixSortPass rimosso." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
git rev-parse --short HEAD
```
Expected: `git status` vuoto prima del checkout; il merge senza conflitti; il push accettato. Annota lo SHA stampato (`MERGE_SHA`). Il checkout ha riscritto gli shader su disco: prima di qualunque controllo GPU successivo, riavvia il dev server.

- [ ] **Step 8: Memoria**

1. Sostituisci per intero `/home/edoardocicognani/.claude/projects/-home-edoardocicognani-Code-HyperionEngine/memory/transparent-sort-phase.md` con (i campi tra `< >` vengono dagli Step 2 e 7, dal §11 della spec e da `date -u +%Y-%m-%dT%H:%M:%S.000Z`):
   ```markdown
   ---
   name: transparent-sort-phase
   description: "Phase 5b \"GPU sort + uber pipeline\" (back-to-front transparent sorting) — DONE, merged to master <MERGE_SHA> and pushed; the round resumes at step 6"
   metadata:
     node_type: memory
     type: project
     originSessionId: 37a7424f-7520-4696-ba3a-caeec676b4ec
     modified: <timestamp UTC>
   ---

   **DONE: merged `<MERGE_SHA>` on master, pushed.** Spec `docs/plans/2026-09-27-transparent-sort-uber-design.md` (measurements in §11), plan `docs/plans/2026-09-27-transparent-sort-uber-plan.md` (23 tasks).
   - Primitive shaders are pieces: `ts/src/shaders/primitives/` prelude + 6 prefixed libraries, composed by `render/primitive-shaders.ts` into 6 per-type modules + 1 uber (`diagnostic(off, derivative_uniformity)` as its first line, uber only). Piece HMR is grouped (`PieceReloadCollector` → `reloadShaders`).
   - `entity-ids` GPU column, uploaded when `entityIdsGeneration` changes; `transparentCount` recounted every frame; `MAX_GPU_ENTITIES` = 100 000.
   - `TransparentSortPass`: gather + stable 7-pass radix; `engine.debug.readTransparentSort()`; ONE uber draw for every transparent.
   - Step-4 GPU gate: 2D Twins new checks green in B and C, statuses = baseline, C\T bit-exact, C∩T within 1/255. Sort at 100k: <ms> ms; forward 4−3: <ms> ms.
   - Reviews: adversarial `<wf-id>` (<n> confirmed; Critical/Important fixed); wgsl-validator, webgpu-pass-reviewer, protocol-sync-checker, claude-md-auditor run.

   Worth remembering: D2 "higher id in front" stops meaning "most recent" after 1,048,576 cumulative spawns (id reuse); `.depth()` is the ordering API. Mode A and Safari are untested here.

   **Why:** the user made 5b a phase of its own on 2026-09-27 and planned it for the next session.
   **How to apply:** nothing to resume here; continue the round at step 6 ([[open-items-round-2026-09-27]]).
   ```
2. In `/home/edoardocicognani/.claude/projects/-home-edoardocicognani-Code-HyperionEngine/memory/open-items-round-2026-09-27.md`:
   - nel frontmatter, `(steps 1-5 merged; phase 5b planned mid-design, execute next session; then step 6)` diventa `(steps 1-5 and 5b merged; next step 6)`;
   - prima del bullet che comincia con `- AFTER phase 5b: resume the round at step 6` aggiungi:
     ```markdown
     - **Step 5b DONE** (merged `<MERGE_SHA>`, pushed): GPU transparent sort + uber pipeline — see [[transparent-sort-phase]]. Review `<wf-id>`; measurements in the design §11. Next: step 6 (L-c directional shadows): ask its deferred decisions (plan §2) first.
     ```
3. In `/home/edoardocicognani/.claude/projects/-home-edoardocicognani-Code-HyperionEngine/memory/MEMORY.md`:
   - `- [Open-items round 2026-09-27](open-items-round-2026-09-27.md) — H→S→L order, user decisions, progress: steps 1-5 merged (7a40aba); next = phase 5b, then step 6` diventa `- [Open-items round 2026-09-27](open-items-round-2026-09-27.md) — H→S→L order, user decisions, progress: steps 1-5 and 5b merged (<MERGE_SHA>); next = step 6 (L-c directional shadows)`;
   - `- [Phase 5b transparent sort — RESUME HERE](transparent-sort-phase.md) — design approved, spec written+reviewed on feat/transparent-sort-uber (aa9ee92); awaiting user spec review, then writing-plans` diventa `- [Phase 5b transparent sort — DONE](transparent-sort-phase.md) — GPU sort + uber pipeline merged (<MERGE_SHA>); measurements in the design §11`.

Expected: i tre file aggiornati, senza segnaposto `< >` rimasti (`grep -n '<' …/memory/transparent-sort-phase.md` trova solo i `<` di testo, nessun campo da riempire).

