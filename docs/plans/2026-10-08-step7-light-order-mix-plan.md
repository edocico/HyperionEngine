# Passo 7 del giro — una lista ordinata per tutte le luci e il blend mix (L-b): piano di implementazione

> **Per chi esegue:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans, un task alla volta. Gli step usano le checkbox (`- [ ]`).

HEAD `1d19575` (master, pulito), 2026-10-08. Branch `feat/step7-light-order-mix`, base `1d19575`. Ogni `file:riga` è verificato a quel HEAD.

**Goal:** ogni luce si disegna da **una sola lista costruita sulla CPU**, ordinata dallo stato ECS (classe di blend, z di mondo dal fondo al davanti, id esterno), con **una sola pipeline** a blend «over» premoltiplicato e **una draw diretta per gruppo di luci**. Il `mix` porta il light buffer verso colore × energia col peso dell'intensità; add e sub restano identici al bit a parità di ordine; `LightAccumStage` non dipende più da `indirect-first-instance`, e il §10.2 del design 17 diventa vero alla lettera sullo stesso device.

**Architettura:**
1. `render/light-groups.ts`: la scansione di `deriveLightGroups` costruisce anche la lista. Ci entra ogni Light2D che il test sfera-frustum **esatto** del cull tiene (`dist < -radius`, `cull.wgsl:82-89`; il margine ×1,01 + 1e-3 resta per le chiavi dei gruppi). Chiave intera e totale: classe (add, sub e il 3 non assegnato prima, mix dopo), `sortableZBits` dei bit della z, id esterno, slot. Escono `lightOrder` (gli slot) e `lightIds`. Gli id arrivano con `entityIds` in `LightGroupsInput` e `FrameState`, dal `state.entityIds` del renderer in tutte le modalità.
2. `light-accum.wgsl`: binding 2 = `lightOrder`, letto da `vs_main`; `fs_main` restituisce (c, 0) per add, (−c, 0) per sub, (colore·w, w) per mix, w = `clamp(intensity, 0, 1)`.
3. `LightAccumStage`: una pipeline con `LIGHT_BLEND` (colore `{add, one, one-minus-src-alpha}`, alpha `{add, zero, one}`), un buffer privato grow-only `light-order` scritto una volta per frame in `prepare()`, una `drawIndexed(6, k, 0, 0, 0)` per gruppo; spariscono `LIGHT2D_ARG_SLOTS` e le letture di `indirect-args` e `visible-indices`.
4. JSDoc (i tre blend, l'ordine, near/far, `.transparent()`) e l'avviso di `indirect-first-instance`.
5. Tre check col probe nel tab Lighting, su una sotto-scena in (0, −200), e un banco committato (`regress`, `order`, `permute`, `grow`, `scene`) che misura **prima su master** se il cull riordina davvero le luci (Task 1) e poi verifica il passo (Task 9).

**Cosa non cambia:** Rust (due commenti di documentazione in `components.rs`); il protocollo (`MAX_COMMAND_TYPE` 57); `LightUniform` (80 B, fette da 256 B); HSNP v3 e `state_hash`, che contengono già la chiave; il codice di `cull.wgsl` (le luci vanno ancora nei bucket 12/13/26/27, che nessuno disegna più); `ForwardPass`, `OccluderSeedStage` e `SelectionSeedPass`, che hanno ancora bisogno di `indirect-first-instance`.

**Tech stack:** TypeScript + Vite + vitest (Node 24), WGSL/WebGPU (Chrome su Metal, Apple M2 Pro), `naga-cli` 30.0.1, `node:test`, MCP `chrome-devtools-gpu`.

**Decisioni, da non richiedere** (piano del giro, §2 "Passo 7 — deciso (2026-09-30)" e §3 riga 7; ricerca `wf_c4b94385-585`):
- **Lista ordinata:** tutte le luci da una lista CPU nata nella scansione di `deriveLightGroups`, col test esatto del cull; ordine classe di blend (add e sub prima dei mix), z di mondo dal fondo al davanti, id esterno; a z uguale vince l'id più alto, come per i trasparenti del 5b.
- **Una pipeline** «over» premoltiplicata e una draw diretta per gruppo.
- **Peso del mix** = intensità (falloff × cono × ombra); bersaglio = colore × energia, premoltiplicati sul wire.
- **Da documentare:** una luce la cui z esce da near/far più del suo range viene scartata dal cull.
- **Criterio d'uscita:** vitest su blend state, chiave e lista; col probe, un mix a intensità piena porta il layer al colore del mix, e lo scambio a runtime della depth di due luci sovrapposte scambia il colore; stabilità su N frame dove il cull riordina davvero (Safari, oppure luci a ≥ 256 slot; in Chrome sul Mac il cull a subgroup tiene fermo l'ordine delle scene piccole). **La sede, dal criterio stesso:** Chrome con le luci a ≥ 256 slot, se il Task 1 mostra che lì su master il cull le riordina; altrimenti Safari, nel passo 7. Rinviarla al passo 9 lascerebbe il passo senza un punto del criterio approvato: sarebbe un emendamento della riga 7 del §3, che scrive il proprietario. Resta da chiedere un solo punto interpretativo, la sotto-decisione 1: se il percorso atomico del cull, forzato in Chrome sull'M2, conta come «dove il cull riordina davvero».

**Fatti verificati durante la stesura:** l'«over» con alpha 0 dà `dst + c` al bit come `{one, one}`, con alpha w `dst·(1 − w) + w·L`, e l'alpha del light buffer non la legge nessuno (`prelude.wgsl:204` campiona `.rgb`); l'ordine dei caster non arriva all'SDF: il seed scrive `(u, v, 1, 1)` senza blend (`prelude.wgsl:187-192`, `occluder-seed-stage.ts:95`), quindi il suo rg è quello del caster disegnato per ultimo, ma il primo passo della catena SDF (`LOAD_PASS`) legge solo l'alpha (`sdf-jfa.wgsl:12-15`, `:80-87`); gli slot seguono l'ordine dei comandi (`command_processor.rs:615-627`) solo in un update senza despawn in sospeso: `assign_slot` accoda (`render_state.rs:562-568`), e `flush_pending_despawns` toglie le righe morte in ordine di slot decrescente, spostando ogni volta l'ultima riga nello slot liberato (`render_state.rs:788-833`), alla fine dello stesso `update` (`render_state.rs:1032-1033`, `engine.rs:247`), quando `engine_push_commands` ha già eseguito tutto il batch (`lib.rs:59-68`): despawn e spawn nello stesso update ruotano la scena nuova, e in Mode B il worker passa al motore tutto ciò che trova nel ring buffer (`engine-worker.ts:71`), quindi un frame fra i due non basta; col cull a subgroup i bucket si scrivono nell'ordine delle lane dentro un workgroup (`cull.wgsl:187`) e fra workgroup con una `atomicAdd` per workgroup (`:167`, mai misurata), col percorso atomico con una per entità (`:198`); `recompileShader('cull', …)` ricostruisce il grafo (`graph-requests.ts:237-370`) e `CullPass.setup` rilegge `CullPass.SUBGROUP_CONFIG` (`cull-pass.ts:178-188`), quindi il percorso atomico si forza a runtime.

**Prototipi** (in uno scratchpad): shader del Task 3 validato con naga; codice dei Task 2-5 scritto in uno specchio di `ts/`, col RED e il GREEN descritti qui (alla fine 115 file, 2089 + 7 saltati, `tsc` pulito): i test incollati nei Task 1-5 sono quelli dello specchio, e ogni conteggio RED/GREEN e ogni insieme di test che uccide un mutante (7 mutanti della lista, 7 dello stadio e dello shader) è misurato su di loro; i check eseguiti su un modello del light buffer; il banco eseguito in node su un motore finto (prima delle aggiunte della revisione: `grow`, le guardie sulla classe del cull, gli slot delle luci e i metadati nuovi, che la prova in node dello Step 3 del Task 1 copre); costo CPU della lista +0,03 ms con 300 luci e +0,12 ms con 1000 (M2 Pro); modello fp16: con tre `add` sovrapposte, la rotazione degli slot di un despawn cambia circa metà dei texel della sovrapposizione di 1-2 passi fp16, l'osservabile del Task 1.

## Vincoli globali

- **Add e sub al bit:** in `fs_main` restano testualmente `var c = color * intensity;` e la negazione per `BLEND_SUB`; lo verifica `regress` (Task 9).
- **La chiave viene dallo stato ECS**, mai dagli slot da soli né dal cull: z come bit (vista `Uint32Array` su `bounds`) via `sortableZBits`, spostata in `transparent-sort-constants.ts` e riesportata da `transparent-sort-reference.ts`; comparatore intero e totale; classe = `=== BLEND_MIX` (2) su entrambi i lati, mai `>=` (il 3, che Rust conserva, `command_processor.rs:1040-1043`, va con add).
- **Test esatto per la lista, margine per le chiavi** (`drawn || inView`).
- **Buffer:** binding 2 `read-only-storage`, solo vertex, `minBindingSize: 4`; `light-order` è **dello stadio** (`setup()`/`destroy()`, mai nel pool: una sonda HMR fa `setup()` e `destroy()` su un pass usa e getta, `renderer.ts:640-647`, `:756-761`), cresce alla potenza di due, non si restringe, svuota la cache dei bind group quando cresce, si scrive una volta in `prepare()`, che azzera anche il conteggio.
- **`indirect-first-instance` resta richiesto** (11 delle 12 draw opache di `ForwardPass`, 23 delle 24 di `OccluderSeedStage` per set, una delle due di `SelectionSeedPass`).
- **Fallback senza `lightGroups`:** un gruppo di ogni layer, un set di ogni caster, nessuna luce; il renderer imposta `lightGroups` in ogni frame lit (`renderer.ts:1057-1058`).
- **Harness:** check e soglie dei passi 3 e 6 invariati.
- **Lingua:** `docs/` in italiano; codice, commenti, CLAUDE.md, agent, skill e JSON in inglese. Commit `<tipo>(7): <descrizione in italiano>`, riga vuota, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Comandi:** `npx --prefix ts vitest run --root ts src/<path>.test.ts`; `npm --prefix ts test`; `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`; naga `D="$(mktemp -d)"; cp ts/src/shaders/light-accum.wgsl "$D/"; node scripts/validate-wgsl-naga.mjs "$D"`; `scripts/preflight.sh`. Mai `grep -P`; glob e URL con `?` tra virgolette.
- **GPU (Mac):** skill `/gpu-check` §3 e §7; solo **chrome-devtools-gpu** (adapter `apple / metal-3 / 0x0000, subgroups 32-32`); `ignoreCache` e l'`initScript` anti-reload; dev server riavviato prima di ogni sessione e dopo ogni modifica a un modulo dell'app; `filePath` **dentro** il repo e assoluto (`<repo>` nei task è `/Users/edoardocicognani/Code/HyperionEngine`, e `…/` è `/Users/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-10-08-step7/`); il banco si carica con `fetch` + `(0, eval)` da un asset server locale. Prima di ogni sessione GPU (Task 1 Step 4, Task 3 Step 5, Task 5 Step 6, Task 9) e di ogni workflow lungo: `nohup caffeinate -dimsu -t <secondi> >/dev/null 2>&1 & disown`, meglio all'alimentatore (`-s` vale solo lì; `-d` e `-i` tengono acceso lo schermo, e con lui il `requestAnimationFrame`, anche a batteria), confermato con `pgrep -fl caffeinate`; la finestra di Chrome resta visibile; a fine sessione caffeinate si ferma. Uno schermo che si spegne ferma il rAF, quindi motore e probe, e le attese di 20 s del banco lanciano (memoria `mac-sleep-kills-agents`).
- **SDD con Workflow** (memoria `sdd-workflow-lessons`): i rapporti tornano nell'output strutturato, perché un subagent non può scrivere file di rapporto; uno script nuovo si passa inline, mai `scriptPath` insieme a `script`; i verificatori bloccano solo sulle aspettative di questo piano.
- **Fuori dal passo:** la luce `sprite` (8); un campo esplicito per l'ordine (backlog); il padding dell'SDF (8c); togliere le luci dai bucket del cull (backlog); la gamba Safari (9), salvo le corse di stabilità, e la validazione WGSL che le precede, se la sede è Safari (Task 1, Task 9); la base AMD del 5b.

## Review Focus

1. **La lista deve guidare la draw**, o l'ordine CPU sarebbe ignorato in silenzio: test di testo su `vs_main`, draw diretta senza `visible-indices`/`indirect-args`, consegna di `LightGroupsPass` (Task 3); check 'Light list: exact cull, id at equal depth' (Task 5) e `permute` a 0 texel (Task 9).
2. **Classi e buffer non clampato:** 'add and sub before mix' (Task 2); `lightsBackToFront`/`expectedLight`, i check 'Mix light replaces the light buffer' (fase global) e 'Mix order follows depth' (R sotto P e Q) (Task 5).
3. **La z e near/far:** i test di ordine, −0, NaN e near/far, anche con la camera di default (Task 2); la fase del piano far del check 'Light list…' (Task 5).
4. **Id e colonna mancante:** test di permutazione, ripiego «tutto o niente», pin del renderer, `lighting-api` (Task 2); fase a depth uguali dopo il despawn (Task 5); fase 3 della scena di Mode A, `regress`, `permute` (Task 9).
5. **Il blend e l'identità al bit:** test del blend state, dei due `return` di `fs_main` e del legame di `BLEND_SUB`/`BLEND_MIX` con Rust e la lista (Task 3); `regress` e le sue tre gambe, intero, stadio e shader (Task 9).
6. **Una misura vale solo con la sua precondizione:** la pulizia del banco prima di ogni scena e gli slot delle luci registrati, che `summarizeRegress`, `summarizeOrder` e `summarizePermute` controllano e rifiutano (Task 1); il percorso del cull letto e scritto sulla classe che il grafo usa (Task 1); il ramo di crescita del buffer della lista, che solo `grow` porta sulla GPU (Task 3 e 9); la tela 1960×1248 del cancello `details` (Task 5 e 9).

## Struttura dei file

| File | Azione | Task |
|---|---|---|
| `docs/plans/assets/2026-10-08-step7-light-order-bench.js`, `docs/plans/assets/2026-10-08-step7/step7-stats.mjs` (+ `.test.mjs`) | crea: banco e statistica | 1 |
| `docs/plans/assets/2026-10-08-step7/` (JSON, PNG, `modeA-vs-B/`, `baseline/`) | crea: evidenze GPU | 1, 3, 5, 9 |
| `ts/src/render/light-groups.ts` (+ test), `passes/transparent-sort-constants.ts`, `passes/transparent-sort-reference.ts`, `render-pass.ts`, `renderer.ts`, `passes/debug-line-pass.test.ts`, `lighting-api.test.ts` | modifica: la lista, `entityIds` | 2 |
| `ts/src/render/passes/light-groups-pass.ts` (+ test) | modifica | 2, 3 |
| `ts/src/shaders/light-accum.wgsl`, `passes/light-accum-stage.ts` (+ test) | modifica: lista, blend, draw diretta | 3 |
| `ts/src/entity-handle.ts`, `lighting-api.ts`, `capabilities.ts` (+ test) | modifica: JSDoc, avviso | 4 |
| `ts/src/demo/blend-expect.ts` (+ test), `demo/lighting-mix.ts` (+ test, crea), `demo/lighting.ts` | modifica/crea: i tre check | 5 |
| commenti (`cull-pass.ts`, `cull.wgsl`, `forward-pass.ts`, `transparent-sort-constants.ts`, `transparent-sort-wgsl.test.ts`, `capabilities.test.ts`, `components.rs`), design 17, design dei light layers, design del 5b, `CLAUDE.md`, agent, skill `new-primitive` | modifica | 6 |
| `CLAUDE.md`, skill `gpu-check`, `docs/plans/assets/2026-09-29-mac-m2/README.md` | modifica: numeri e base M4 | 9, 10 |
| `docs/plans/2026-09-27-open-items-round-plan.md` | modifica: §1, §2, §3, §4, §5 | 0, 6, 10 |

## Task

Base e misura su master (Task 0-1, con la sotto-decisione al Task 0); codice (Task 2-5, con un cancello GPU rapido al Task 3 e un giro del tab Lighting al Task 5); documenti, preflight e revisione (Task 6-8); verifica GPU, numeri e merge (Task 9-10).

### Task 0: branch, base verde, sotto-decisione

- [ ] **Step 0: prima del Task 1** (regola del giro, memoria `feedback-autonomous-round`), si chiede al proprietario la sola domanda interpretativa della sotto-decisione 1 in fondo al piano (il percorso atomico del cull, forzato in Chrome sull'M2, conta come «dove il cull riordina davvero» prima di ripiegare su Safari?) e si presenta il default rifiutabile (`lightIds`). La sede in sé non si chiede: la fissa il criterio approvato (la riga 7 del §3; "Decisioni, da non richiedere"), e la risposta sceglie solo il ramo per un esito che il Task 1 misura. Le risposte vanno nel §2 del piano del giro, sotto "Passo 7 — deciso (2026-09-30)", come bullet "**Sotto-decisioni del piano del passo 7** (<data>)", con la risposta registrata come interpretazione della riga 7 del §3, nel primo commit del branch.
- [ ] **Step 1: branch:** `git status --short` vuoto; `git checkout master && git pull --ff-only origin master`; `git rev-parse --short HEAD` (`1d19575`, o la base nuova da annotare); `git checkout -b feat/step7-light-order-mix`.
- [ ] **Step 2: base:** `scripts/preflight.sh` tutto `OK`; vitest 114 file, 2037 + 7 saltati (CLAUDE.md:66).
- [ ] **Step 3: strumenti GPU** nello spazio SDD (`.superpowers/sdd/` è ignorato da git):
```bash
SDD=.superpowers/sdd/2026-10-08-step7-light-order-mix-plan
mkdir -p "$SDD/tools/gpu"
cp .superpowers/sdd/2026-09-30-step6-directional-shadows-plan/tools/asset-server.py "$SDD/tools/"
cp .superpowers/sdd/2026-09-30-step6-directional-shadows-plan/tools/task10/{anti-reload-init.js,tab-runner.js,lighting-tab.js,map-modeA.js,map-modeB.js} "$SDD/tools/gpu/"
git show 1d19575:ts/src/shaders/light-accum.wgsl > "$SDD/tools/master-light-accum.wgsl"
```
In `lighting-tab.js`, `'hyperion-step6-harness/1'` → `'hyperion-step7-harness/1'`. Poi `$SDD/tools/gpu/load-bench.js`:
```js
async () => {
  // Loads the committed step-7 bench (served live by the asset server) and
  // master's light-accum.wgsl into the page (the step-6 ruling R12).
  const src = await (await fetch('http://127.0.0.1:8765/2026-10-08-step7-light-order-bench.js', { cache: 'no-store' })).text();
  window.__benchFn = (0, eval)('(' + src + ')');
  const old = await fetch('http://127.0.0.1:8765/old-light-accum.wgsl', { cache: 'no-store' });
  window.__step7OldLightAccum = old.ok ? await old.text() : undefined;
  return { benchBytes: src.length, benchType: typeof window.__benchFn, oldShaderBytes: window.__step7OldLightAccum?.length ?? 0 };
}
```
L'asset server, in background e con percorsi assoluti (una chiamata Bash nuova non ha `$SDD`): `python3 /Users/edoardocicognani/Code/HyperionEngine/.superpowers/sdd/2026-10-08-step7-light-order-mix-plan/tools/asset-server.py /Users/edoardocicognani/Code/HyperionEngine/.superpowers/sdd/2026-10-08-step7-light-order-mix-plan/tools/master-light-accum.wgsl` (127.0.0.1:8765, CORS e CORP). Ogni task del banco: `window.__benchOpts = { task, label: '<sha>', … }`, poi `async () => await window.__benchFn()` con `filePath`.
- [ ] **Step 4: commit** del piano del giro (e di questo piano, se non è su master): `docs(7): risposte alle sotto-decisioni del piano del passo 7`.

### Task 1: banco committato, statistica, e la misura su master del riordino

Prima di ogni modifica al motore: si prova su master che lo scenario della stabilità riordina, e si calibra l'osservabile. Su master un `mix` si somma come un `add`, ma due ordini di somma delle luci `add` sovrapposte danno texel diversi di 1-2 passi fp16: una griglia che cambia fra due letture è un ordine che cambia.

**Files:** crea `docs/plans/assets/2026-10-08-step7/step7-stats.mjs` (+ `.test.mjs`), `docs/plans/assets/2026-10-08-step7-light-order-bench.js`, `docs/plans/assets/2026-10-08-step7/master-{B,C}.json` e i `*.stats.json` (con la sede Safari anche `master-safari-B.json`).

**Interfaces:**
- `step7-stats.mjs`, puro tranne la CLI; usa `compareGrids`, `decodeGrid`, `detailsDiff` e `STEP3_CHECKS` di `../2026-09-30-step6/step6-stats.mjs`. Esporta:
  - `LIGHTING_DETAIL_CHECKS` (i tre di `STEP3_CHECKS` più 'Directional shadow', 'Directional shadow length', 'Directional edge pop (measured)'); `CENTRE_CELL = 18 * 64 + 32`; `WORKGROUP = 256` (il workgroup del cull: il percorso a subgroup ordina le lane dentro un workgroup, e fra workgroup decide una `atomicAdd` per workgroup); `DETAILS_TOL = 0.002 + 1e-9` (0,002 come stampato, più il margine della sottrazione: 1,100 − 1,098 fa 0,0020000000000000018); `HARNESS_CANVAS = [1960, 1248]` (la finestra 1200×689 CSS a dpr 2, dove la base del passo 6 ha stampato i suoi dettagli);
  - `summarizeOrder(bench)` → per risultato `{ label, K, apart, blend, reads, cullPath, distinctGrids, overflow (sequence ha −1), changedReads (letture con sequence ≠ 0), unstablePoints (punti diversi dalla griglia 0 in qualche griglia), maxSteps (il massimo worst.ulps di compareGrids(griglia 0, g)), centre (la cella CENTRE_CELL, null se manca), list, lights: [{ id, slot, workgroup }] (workgroup = floor(slot / 256)), minSlotDistance, refusals }`; rifiuta (in `refusals`) una corsa senza slot, una con `apart` ≥ 256 e due luci nello stesso workgroup (non può mostrare un riordino fra workgroup) e il controllo `apart` 1 con le luci in più di un workgroup;
  - `summarizePermute(bench, { cull = 'subgroup' } = {})` → per risultato `{ label, cullPath, n, changed: n − identical, maxSteps, maxAbs, lights: { first, second }, permuted, refusals }`, `permuted` = l'ordine degli slot delle luci cambia fra le due letture; rifiuta una corsa senza permutazione (il suo «0 texel cambiati» non proverebbe niente) e un `cullPath` diverso da `cull` (per esempio un percorso atomico rimasto da un task prima; Safari, che non ha subgroup, si riassume con `{ cull: 'atomic' }`);
  - `summarizeRegress(master, step7, { cull = 'subgroup' } = {})` → `{ ok, refusals, layers: [{ whole, stage, shader }], cullPath }`, per layer tre `compareGrids`: **intero** (il passo 7 contro master), **stadio** (lo shader di master nello stadio del passo 7 contro master: lo stesso shader, cambiano blend state, ordine della lista e draw diretta) e **shader** (il passo 7 contro lo shader di master nello stesso stadio, sulla stessa pagina: cambia solo lo shader); `ok` solo senza rifiuti e con ogni punto di ogni gamba identico. Rifiuta: le luci di master che, ordinate per slot, non sono in ordine di id (in questa scena, add e sub a z 0, l'ordine di id è quello della lista: altrimenti il cull di master ha disegnato un altro ordine, e una differenza sarebbe dell'ordine, non del passo 7); le luci di master in più di un workgroup; un `cullPath` diverso da `cull` da una delle due parti; una corsa del passo 7 senza `oldShaderLayers`. Lancia senza un risultato `regress` o con layer in numero diverso (`"<s> layers against <m>"`);
  - `summarizeDetails(harness, statuses)` → `{ ok, refusals, checks }`, con `detailsDiff(…, LIGHTING_DETAIL_CHECKS, DETAILS_TOL)` (il quarto parametro, `tol`, di `step6-stats.mjs`, che non cambia); rifiuta un harness la cui tela non è `HARNESS_CANVAS`, perché quei dettagli dipendono dalla tela.
  - CLI: `order <bench.json>`, `permute <bench.json> [--cull subgroup|atomic]`, `regress <master> <step7>`, `details <harness.json> <statuses.json>`; stampa il riassunto in JSON; exit 0 se va, 1 fuori tolleranza (`regress` non `ok`, `details` con un numero oltre `DETAILS_TOL`), 2 uso sbagliato, 3 rifiutato (un riassunto con `refusals`: la corsa non ha la precondizione, si rifà, e i suoi numeri non si leggono); gira solo se `realpathSync(argv[1])` è il file stesso.
- Il banco: `window.__benchOpts = { task, label, … }`, risultati in `window.__benchResults`, restituisce `{ format: 'hyperion-step7-bench/1', task, label, mode, search, canvas, dpr, adapter, chrome, userAgent, platformVersion, results }`. Ogni risultato porta `lights: [{ id, slot }]` (per `permute`, in `first` e in `second`); `order`, `permute` e `regress` anche `cullPath`, e `order` con `atomic` anche `cullPathRestored`.

- [ ] **Step 1: i test (RED).** `step7-stats.test.mjs`, 13 test, su griglie di 3 punti codificate come il banco; `moved(i, s)` alza di s·2⁻¹¹ il rosso del punto i, cioè di s passi fp16 per il punto 0, il cui rosso (0,5) sta in [0,5, 1). `summarizeOrder` con una griglia su 4 letture (1, 0, 0, 0) e con tre griglie e `sequence` `[0, 1, 0, 2, 1]` (3, 3, 1, 2); `CENTRE_CELL` = 1184 e `centre` (null su 3 punti); `[0, -1, 0]` → `changedReads` 1, `overflow`; slot, workgroup e distanza minima delle luci; i tre rifiuti dell'ordine (una scena ruotata con due luci nel workgroup 0 a `apart` 256, il controllo `apart` 1 a cavallo di due workgroup, una luce senza slot); `summarizePermute` (1 texel e `maxSteps` 2; poi 0) e i suoi due rifiuti (l'ordine degli slot invariato; il `cullPath` atomico, accettato con `{ cull: 'atomic' }`); `summarizeRegress` (uguali → `ok`; il passo 7 spostato di un passo in tutte e due le sue letture → cambiano intero e stadio, lo shader no, `withinUlp` 3; spostato solo con lo shader suo → la gamba shader; `/1 layers against 2/`) e i suoi quattro rifiuti (la disposizione di un `regress` lanciato subito dopo `permute` senza pulizia, col punto luce per ultimo; due workgroup; `cullPath` atomico; nessun `oldShaderLayers`); i sei nomi e la tela; `summarizeDetails` (1,098 → 1,100 passa, 1,101 no, una tela 1920×1080 è rifiutata); gli aiutanti del banco (`encodeGrid` fa il giro di `decodeGrid`, due griglie uguali hanno lo stesso hash, a un passo fp16 l'una dall'altra no); la CLI (`regress` 0/1/3, `details` 0/1/3, `permute` 3 e, con `--cull atomic`, 0; uso sbagliato 2). Il file intero:
```js
// docs/plans/assets/2026-10-08-step7/step7-stats.test.mjs
// Run: node --test docs/plans/assets/2026-10-08-step7/step7-stats.test.mjs
//
// The offline summaries of the step-7 bench (step7-stats.mjs) on small
// synthetic outputs in the format of
// docs/plans/assets/2026-10-08-step7-light-order-bench.js
// ('hyperion-step7-bench/1'), their refusals, the CLI's exit codes, and two
// helpers of the bench itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CENTRE_CELL, DETAILS_TOL, HARNESS_CANVAS, LIGHTING_DETAIL_CHECKS, WORKGROUP,
  summarizeDetails, summarizeOrder, summarizePermute, summarizeRegress,
} from './step7-stats.mjs';
import { decodeGrid } from '../2026-09-30-step6/step6-stats.mjs';

const SCRIPT = fileURLToPath(new URL('./step7-stats.mjs', import.meta.url));
const BENCH = new URL('../2026-10-08-step7-light-order-bench.js', import.meta.url);

/**
 * One function of the bench, evaluated (as step6-stats.test.mjs does). The
 * bench is the body of an evaluate_script call, not a module, so the
 * definition is read from the file: `const <name> = (<arg>) => { … };` at its
 * indentation. It must be self-contained (no free name but globals).
 */
function benchFunction(name) {
  const text = readFileSync(BENCH, 'utf8');
  const m = new RegExp(`\\n  const ${name} = (\\(\\w+\\) => \\{\\n[\\s\\S]*?\\n  \\});\\n`).exec(text);
  assert.ok(m, `the bench defines ${name}`);
  return new Function(`return ${m[1]};`)();
}

/** A grid as the bench stores it: float32 RGBA, little-endian, base64. */
function grid(values) {
  const f = new Float32Array(values.length * 4);
  values.forEach((v, i) => f.set(v, 4 * i));
  return { encoding: 'f32-rgba-base64', count: values.length, data: Buffer.from(f.buffer).toString('base64') };
}
const BASE = [[0.5, 0.25, 0.125, 1], [1.5, 0.75, 0.375, 1], [0.0625, 0.07, 0.12, 1]];
/** BASE with point `i`'s red channel `steps`·2^-11 up: `steps` fp16 steps for point 0, whose red (0.5) is in [0.5, 1), where one step is 2^-11. */
const moved = (i, steps) => BASE.map((p, k) => (k === i ? [p[0] + steps * 2 ** -11, p[1], p[2], p[3]] : p));
const bench = (results) => ({ format: 'hyperion-step7-bench/1', results });
/** Lights as the bench records them. */
const at = (...pairs) => pairs.map(([id, slot]) => ({ id, slot }));

// ── order ────────────────────────────────────────────────────────────────

const orderResult = (over) => ({
  task: 'order', K: 3, apart: 256, blend: 'add', reads: 4, cullPath: 'subgroup', sequence: [0, 0, 0, 0],
  distinct: [{ hash: 'a', firstRead: 0, grid: grid(BASE) }], list: null, lights: at([11, 1], [12, 257], [13, 513]), ...over,
});

test('summarizeOrder: one grid over every read is stable; two grids name the points that moved and by how many fp16 steps', () => {
  const stable = summarizeOrder(bench([orderResult({})]));
  assert.deepEqual(stable.map(({ distinctGrids, changedReads, unstablePoints, maxSteps, refusals }) => ({ distinctGrids, changedReads, unstablePoints, maxSteps, refusals })),
    [{ distinctGrids: 1, changedReads: 0, unstablePoints: 0, maxSteps: 0, refusals: [] }]);
  const moving = summarizeOrder(bench([orderResult({
    reads: 5, cullPath: 'atomic', sequence: [0, 1, 0, 2, 1],
    distinct: [{ hash: 'a', firstRead: 0, grid: grid(BASE) }, { hash: 'b', firstRead: 1, grid: grid(moved(0, 1)) },
      { hash: 'c', firstRead: 3, grid: grid(moved(0, 2)) }],
  })]))[0];
  assert.equal(moving.distinctGrids, 3);
  assert.equal(moving.changedReads, 3);
  assert.equal(moving.unstablePoints, 1);
  assert.equal(moving.maxSteps, 2);
  assert.equal(moving.overflow, false);
  assert.equal(moving.cullPath, 'atomic');
});

test('summarizeOrder: the centre cell of a full 64x36 grid, where every light of the scene overlaps', () => {
  assert.equal(CENTRE_CELL, 1184);
  const values = Array.from({ length: 64 * 36 }, () => [0.06, 0.07, 0.12, 1]);
  values[CENTRE_CELL] = [0.25, 0.5, 1, 1];
  const r = summarizeOrder(bench([orderResult({ apart: 1, blend: 'mix', reads: 1, sequence: [0], lights: at([11, 1], [12, 2], [13, 3]),
    distinct: [{ hash: 'a', firstRead: 0, grid: grid(values) }] })]))[0];
  assert.deepEqual(r.centre, [0.25, 0.5, 1, 1]);
  assert.equal(summarizeOrder(bench([orderResult({ sequence: [0], distinct: [{ grid: grid(BASE) }] })]))[0].centre, null);
});

test('summarizeOrder: a read past the kept grids (-1) is counted as changed and flagged', () => {
  const r = summarizeOrder(bench([orderResult({ K: 2, apart: 1, blend: 'mix', reads: 3, sequence: [0, -1, 0], lights: at([11, 1], [12, 2]) })]))[0];
  assert.equal(r.changedReads, 1);
  assert.equal(r.overflow, true);
});

test("summarizeOrder: each light's slot and cull workgroup, and the smallest slot distance", () => {
  const r = summarizeOrder(bench([orderResult({})]))[0];
  assert.equal(WORKGROUP, 256);
  assert.deepEqual(r.lights, [{ id: 11, slot: 1, workgroup: 0 }, { id: 12, slot: 257, workgroup: 1 }, { id: 13, slot: 513, workgroup: 2 }]);
  assert.equal(r.minSlotDistance, 256);
});

test('summarizeOrder refuses apart >= 256 with two lights in one workgroup (a rotated scene), and the apart-1 control across two', () => {
  // A scene spawned in the update that despawned the previous one: L2 at 3, L0 at 5, L1 at 261.
  const rotated = summarizeOrder(bench([orderResult({ lights: at([11, 5], [12, 261], [13, 3]) })]))[0];
  assert.match(rotated.refusals.join(), /share a cull workgroup/);
  const control = summarizeOrder(bench([orderResult({ apart: 1, lights: at([11, 254], [12, 255], [13, 256]) })]))[0];
  assert.match(control.refusals.join(), /apart 1, but the lights span 2 cull workgroups/);
  const unknown = summarizeOrder(bench([orderResult({ lights: at([11, 1], [12, -1], [13, 513]) })]))[0];
  assert.match(unknown.refusals.join(), /no slot for light 12/);
});

// ── permute ──────────────────────────────────────────────────────────────

const permuteResult = (over) => ({
  task: 'permute', cullPath: 'subgroup',
  first: { grid: grid(BASE), lights: at([21, 2], [22, 3], [23, 4]) },
  second: { grid: grid(moved(0, 2)), lights: at([21, 2], [22, 3], [23, 1]) },
  ...over,
});

test('summarizePermute: the texels a slot permutation changed, and by how many fp16 steps', () => {
  const diff = summarizePermute(bench([permuteResult({})]))[0];
  assert.equal(diff.permuted, true);
  assert.deepEqual(diff.refusals, []);
  assert.equal(diff.changed, 1);
  assert.equal(diff.maxSteps, 2);
  const same = summarizePermute(bench([permuteResult({ second: { grid: grid(BASE), lights: at([21, 2], [22, 3], [23, 1]) } })]))[0];
  assert.equal(same.changed, 0);
  assert.deepEqual(same.refusals, []);
});

test("summarizePermute refuses a run whose lights' slot order did not change, and a cull path other than the expected one", () => {
  // The filler destroyed was not below the lights: the floor moved, the lights kept their order.
  const vacuous = summarizePermute(bench([permuteResult({ second: { grid: grid(BASE), lights: at([21, 1], [22, 2], [23, 3]) } })]))[0];
  assert.equal(vacuous.permuted, false);
  assert.match(vacuous.refusals.join(), /the permutation never happened/);
  const atomic = summarizePermute(bench([permuteResult({ cullPath: 'atomic' })]))[0];
  assert.match(atomic.refusals.join(), /cull path atomic, want subgroup/);
  // Safari has no subgroups: its runs are summarised with { cull: 'atomic' }.
  assert.deepEqual(summarizePermute(bench([permuteResult({ cullPath: 'atomic' })]), { cull: 'atomic' })[0].refusals, []);
});

// ── regress ──────────────────────────────────────────────────────────────

const LIGHTS = at([5, 4], [6, 5], [7, 6], [8, 7], [9, 8]);
const masterRun = (over = {}) => bench([{ task: 'regress', cullPath: 'subgroup', lights: LIGHTS, layers: [grid(BASE), grid(BASE)], ...over }]);
const step7Run = (over = {}) => bench([{
  task: 'regress', cullPath: 'subgroup', lights: LIGHTS, layers: [grid(BASE), grid(BASE)], oldShaderLayers: [grid(BASE), grid(BASE)], ...over,
}]);

test('summarizeRegress: three legs per layer (whole, stage, shader); ok only if every point of every leg is identical', () => {
  const same = summarizeRegress(masterRun(), step7Run());
  assert.equal(same.ok, true);
  assert.deepEqual(same.refusals, []);
  assert.deepEqual(same.layers.map((l) => [l.whole.identical, l.stage.identical, l.shader.identical]), [[3, 3, 3], [3, 3, 3]]);
  // Step 7 off by an fp16 step against master, in both its own run and the old shader's: whole and stage move, shader does not.
  const stage = summarizeRegress(masterRun(), step7Run({ layers: [grid(BASE), grid(moved(0, 1))], oldShaderLayers: [grid(BASE), grid(moved(0, 1))] }));
  assert.equal(stage.ok, false);
  assert.deepEqual(stage.layers.map((l) => [l.whole.identical, l.stage.identical, l.shader.identical]), [[3, 3, 3], [2, 2, 3]]);
  assert.equal(stage.layers[1].whole.withinUlp, 3);
  // The shader alone: the old shader's grid equals master's, step 7's does not.
  const shader = summarizeRegress(masterRun(), step7Run({ layers: [grid(moved(2, 1)), grid(BASE)] }));
  assert.equal(shader.ok, false);
  assert.deepEqual(shader.layers[0].shader.identical, 2);
  assert.throws(() => summarizeRegress(masterRun(), step7Run({ layers: [grid(BASE)], oldShaderLayers: [grid(BASE)] })), /1 layers against 2/);
});

test("summarizeRegress refuses when master's lights are not in id order by slot, span two workgroups, or a run took another cull path", () => {
  // The rotated layout of a regress spawned right after `permute`: the point light (id 5) last.
  const rotated = summarizeRegress(masterRun({ lights: at([5, 8], [6, 0], [7, 1], [8, 2], [9, 3]) }), step7Run());
  assert.equal(rotated.ok, false);
  assert.match(rotated.refusals.join(), /master's lights by slot are 6, 7, 8, 9, 5, not in id order/);
  const spread = summarizeRegress(masterRun({ lights: at([5, 250], [6, 251], [7, 252], [8, 253], [9, 256]) }), step7Run());
  assert.match(spread.refusals.join(), /span 2 cull workgroups/);
  const atomic = summarizeRegress(masterRun({ cullPath: 'atomic' }), step7Run());
  assert.match(atomic.refusals.join(), /master's cull path is atomic, want subgroup/);
  const noLeg = summarizeRegress(masterRun(), step7Run({ oldShaderLayers: undefined }));
  assert.equal(noLeg.ok, false);
  assert.match(noLeg.refusals.join(), /no oldShaderLayers/);
  assert.equal(noLeg.layers[0].stage, null);
});

// ── details ──────────────────────────────────────────────────────────────

test('LIGHTING_DETAIL_CHECKS: the step-3 and the step-6 checks of the Lighting tab, whose details step 7 must not move', () => {
  assert.deepEqual(LIGHTING_DETAIL_CHECKS, [
    'Lit vs unlit', 'Layer shadow on screen', 'Light layers',
    'Directional shadow', 'Directional shadow length', 'Directional edge pop (measured)',
  ]);
  assert.deepEqual(HARNESS_CANVAS, [1960, 1248]);
});

const detailRun = (printed, canvas = HARNESS_CANVAS) => ({
  canvas, lighting: LIGHTING_DETAIL_CHECKS.map((name, i) => ({ name, status: 'pass', detail: `${name} 0.500, ${i === 1 ? printed : '1.098'}` })),
});
const detailBase = { tabs: { lighting: { checks: detailRun('1.098').lighting } } };

test('summarizeDetails: a printed 1.098 -> 1.100 passes (0.002 within float rounding), 0.003 fails; any other canvas is refused', () => {
  assert.ok(Math.abs(1.1 - 1.098) > 0.002, 'the float subtraction overshoots 0.002');
  assert.ok(DETAILS_TOL > 0.002 && DETAILS_TOL < 0.0021);
  assert.equal(summarizeDetails(detailRun('1.100'), detailBase).ok, true);
  assert.equal(summarizeDetails(detailRun('1.101'), detailBase).ok, false);
  const bench1080 = summarizeDetails(detailRun('1.098', [1920, 1080]), detailBase);
  assert.equal(bench1080.ok, false);
  assert.match(bench1080.refusals.join(), /1920x1080 canvas, want 1960x1248/);
});

// ── The bench's own helpers ──────────────────────────────────────────────

test("the bench's encodeGrid and fnv1a: a grid round-trips through decodeGrid, equal grids hash alike, one fp16 step apart they do not", () => {
  const encodeGrid = benchFunction('encodeGrid');
  const fnv1a = benchFunction('fnv1a');
  const values = Array.from({ length: 64 * 36 }, (_, i) => [i / 7, 0.25, -0.125, 1]);
  const g = encodeGrid(values);
  assert.equal(g.encoding, 'f32-rgba-base64');
  assert.equal(g.count, values.length);
  assert.deepEqual(decodeGrid(g), values.map((p) => p.map(Math.fround)));
  assert.equal(fnv1a(encodeGrid(values.map((p) => [...p])).data), fnv1a(g.data));
  const step = values.map((p) => [...p]);
  step[1000][1] = 0.25 + 2 ** -12;  // one fp16 step at 0.25
  assert.notEqual(fnv1a(encodeGrid(step).data), fnv1a(g.data));
  assert.match(fnv1a('light-accum'), /^[0-9a-f]{8}$/);
});

// ── CLI ──────────────────────────────────────────────────────────────────

test('CLI: `regress` exits 0, 1 out of tolerance, 3 refused; `details` 0, 1 and 3; `permute --cull atomic`; bad usage exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step7-stats-'));
  try {
    const write = (name, value) => {
      const file = join(dir, name);
      writeFileSync(file, JSON.stringify(value));
      return file;
    };
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    const master = write('master.json', masterRun());
    assert.equal(run('regress', master, write('same.json', step7Run())).status, 0);
    assert.equal(run('regress', master, write('off.json', step7Run({ layers: [grid(moved(1, 1)), grid(BASE)] }))).status, 1);
    assert.equal(run('regress', write('rotated.json', masterRun({ lights: at([5, 8], [6, 0], [7, 1], [8, 2], [9, 3]) })), write('s.json', step7Run())).status, 3);
    const base = write('base.json', detailBase);
    assert.equal(run('details', write('h.json', detailRun('1.100')), base).status, 0);
    assert.equal(run('details', write('shifted.json', detailRun('1.101')), base).status, 1);
    assert.equal(run('details', write('h1080.json', detailRun('1.098', [1920, 1080])), base).status, 3);
    const safari = write('safari.json', bench([permuteResult({ cullPath: 'atomic' })]));
    assert.equal(run('permute', safari).status, 3);
    assert.equal(run('permute', safari, '--cull', 'atomic').status, 0);
    assert.equal(run('regress', master).status, 2);
    assert.equal(run('permute', safari, '--cull', 'nonsense').status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```
Run `node --test docs/plans/assets/2026-10-08-step7/step7-stats.test.mjs`: FAIL, il modulo manca.
- [ ] **Step 2: il modulo (GREEN):** lo stesso comando: 12 test su 13 verdi; quello degli aiutanti del banco fallisce con `ENOENT` finché il banco non c'è (Step 3).
- [ ] **Step 3: il banco**, il corpo di un `evaluate_script`, con un'intestazione che spiega task e convenzioni. Gira su master e sul passo 7 (`list` = `lightOrder`/`lightIds` di `engine.lighting.groups` se esistono, altrimenti null).
  - **Guardie:** `window.__hyperion`; pagina `?bench`; task valido; tranne `scene`, Mode B o C ed `engine.debug.probe`; attese di 20 s con un messaggio che dice cosa aspettavano. In B e C, prima di ogni altra cosa, il banco importa `CullPass` e `LightAccumStage` dai moduli dell'app (`/src/render/passes/cull-pass.ts`, `/src/render/passes/light-accum-stage.ts`) e lancia se uno dei due ha `SHADER_SOURCE` vuoto. Il renderer li imposta all'avvio (`renderer.ts:390`, `:404`); dopo una modifica Vite serve all'app il modulo come `?t=…`, e l'import per URL nudo ne dà una seconda istanza, ferma a `''` e al `SUBGROUP_CONFIG` di default: ogni `cullPath` letto lì direbbe «atomic», e la forzatura del percorso atomico scriverebbe su una classe che il grafo non usa. Il rimedio è riavviare il dev server. (Equivalente, e immune: la classe del cull presa dal grafo vivo, `renderer.graph.passes.get('cull').constructor`, un campo privato solo per TypeScript.)
  - **Pulizia, la regola del banco (B e C):** ogni task comincia con `clearEntities`, cioè `destroy()` delle entità del task precedente (`window.__step7Entities`) e poi `await settledAt(0)`: zero righe GPU in un hook `frameEnd` (`views.entityCount === 0`) ed `engine.stats.overflowCount === 0`, come `clearEntities` del banco del passo 6. Di `scene` lo fa solo la fase 1: in ogni modo le fasi 2-3 cambiano in posto le entità della fase 1. Ogni spawn viene dopo quell'attesa. Spawn e despawn che arrivano nello stesso update ruotano la scena nuova (Fatti verificati): `regress`, `order` e `permute` perderebbero la loro premessa, e `step7-stats.mjs` rifiuterebbe la corsa. **Mode A:** ci gira solo `scene`, e il bridge scarta gli stati vuoti (`worker-bridge.ts:272`), quindi zero righe non arriva mai: la fase 1 è il primo task di una pagina appena caricata, e le fasi 2-3 cambiano in posto le entità della fase 1, senza ricostruirle; M non si distrugge mai nello stesso frame di uno spawn. (Se un giorno servisse svuotare in Mode A: `const s = engine.bridge.nextTickSeq` subito dopo i `destroy()`, poi l'attesa di `engine.bridge.processed.seq >= s`, confermato prima di quel filtro, `worker-bridge.ts:258`, più un frame.)
  - **Comune** (tranne `scene`): `engine.resize(1920, 1080)`, camera (0, 0), zoom 1, controllati col `targetSize` di un probe di `scene-hdr`; ambient `[0.06, 0.07, 0.12]`, `setBackend('lit')`; attesa delle righe GPU (`views.entityCount` in un hook `frameEnd`), di `light-groups` in `renderer.graph.executionOrder` e di 4 frame. Una lettura = ogni gruppo di `engine.lighting.groups` su una griglia UV 64×36 di centri di cella, riprovando finché il light buffer non è nel grafo live; griglie in float32 RGBA base64 (`{ encoding: 'f32-rgba-base64', count, data }`); `slots` da `engine.debug.readEntityTransforms()`. Ogni risultato registra lo slot di ognuna delle sue luci, `lights: [{ id, slot }]`, con `engine.bridge.latestRenderState.entityIds.indexOf(id)` (lo `slotOf` del banco del passo 6, valido nei tre modi), letto dopo l'attesa e prima delle letture: è la precondizione che `step7-stats.mjs` controlla.
  - **Metadati:** accanto a `chrome`, `userAgent` (`navigator.userAgent`: in Safari `userAgentData` manca, e la versione resta solo lì) e `platformVersion` (da `navigator.userAgentData?.getHighEntropyValues(['platformVersion'])`, la versione di macOS: il compilatore Metal cambia col sistema, non solo con Chrome).
  - **Aiutanti col loro test:** `encodeGrid` e `fnv1a` sono definizioni autonome `const <nome> = (<arg>) => { … };` a due spazi di rientro, senza nomi liberi se non i globali (`btoa`, `Math`, …): il test `benchFunction` di `step7-stats.test.mjs` le legge dal file e le valuta, come `step6-stats.test.mjs:30-35` fa col banco del passo 6. Un hash che confondesse due griglie si leggerebbe come «nessun riordino».
  - **Pezzi:** pavimento `position(0, 0, -0.5).scale(40, 24, 1).receivesLight(true)`; filler `position(0, -1000)`; `LIGHT_COLORS = [[1, 0.375, 0.25], [0.25, 1, 0.375], [0.25, 0.5, 1], [1, 0.875, 0.25]]` (esatti in fp16); `pointLight(j, k, blend)`: point in `((j − (k − 1)/2)·1.5, 0)`, `LIGHT_COLORS[j % 4]`, range 6, falloff 0 per `mix`, 1 per `add`.
  - **`regress`:** un batch con pavimento, un ricevitore del layer 1 `(13, 6, -0.4)` 6×6, caster `(-4, 2)` 0,8×5 e `(6, -4)` 6×0,8, point `(-9, 0)` range 12 falloff 1,2 ombra 1 layers 0b01, spot `(12, -6)` `rotation(2.3)` range 18 inner 18 outer 30 ombra 1 layers 0b11, directional `rotation(-π/6)` range 8 ombra 1 layers 0b01, global `(500, 500)` energia 0,5 layers 0b11, sub point `(2, 4)` range 7 layers 0b01: add o sub, z 0. Dopo `clearEntities` pavimento, ricevitore e caster prendono gli slot 0-3 e le cinque luci, in ordine di id, i 4-8, nello stesso workgroup del cull: l'ordine del cull di master (gli slot) e quello della lista coincidono, e `summarizeRegress` lo controlla sui `lights` registrati. Legge `layers`. Poi, su una pagina del passo 7 con `window.__step7OldLightAccum` (lo shader di master, che contiene `visibleIndices`), `engine.recompileShader('light-accum', old)`, attesa di `SHADER_SOURCE === old` (modulo `/src/render/passes/light-accum-stage.ts`) e di un grafo nuovo, `oldShaderLayers`, e lo shader del passo 7 rimesso allo stesso modo in un `finally`.
  - **`order { K = 3, apart = 256, blend = 'add', reads = 240, atomic = false }`:** con `atomic`, il banco lancia se il `useSubgroups` di partenza non è `true` (la configurazione viva sull'M2; una seconda istanza tiene il default `false`); poi `CullPass.SUBGROUP_CONFIG = { ...prima, useSubgroups: false }`, `recompileShader('cull', <cull.wgsl?raw>)` e un grafo nuovo. `reloadShaders` non salta mai un sorgente uguale (`graph-requests.ts:237-370`), quindi un grafo nuovo da solo non prova che il percorso sia cambiato: il `cullPath` si registra dalla classe verificata, a grafo vivo. Nel `finally` la configurazione si ripristina, si ricompila, si aspetta un grafo nuovo e si controlla che `useSubgroups` sia di nuovo `true`, registrato in `cullPathRestored`. Dopo `clearEntities`, pavimento (slot 0) e K luci `pointLight` con `apart − 1` filler fra due luci: le luci negli slot 1, 1 + apart, …, quindi a `apart` ≥ 256 ognuna nel suo workgroup e a `apart` 1 tutte nel primo; `reads` letture del layer 0, hash FNV-1a, al più 8 griglie distinte con la loro prima lettura, `sequence[r]` (−1 oltre 8).
  - **`permute`:** dopo `clearEntities`, pavimento (slot 0), un filler F (1), tre luci `add` (2-4); una lettura; F distrutto: la luce 3, l'ultima riga, va nello slot 1, e l'ordine degli slot delle luci diventa 3, 1, 2; un'altra lettura (`first`, `second`, ciascuna coi suoi `lights`).
  - **`grow`** (solo sulle pagine del passo 7; su master lancia, perché lì `lightOrder` non c'è): il ramo di crescita del buffer della lista (distruggere il vecchio, crearne uno più grande, svuotare la cache dei bind group, ricollegare) non gira con nessun'altra scena del piano, che ha al più 5 luci in vista contro una capacità iniziale di 64; è la classe di difetto che solo la GPU vede (gotcha dei tier che crescono in CLAUDE.md). Dopo `clearEntities`, il pavimento e 100 luci point `add` su una griglia 10×10 dentro la vista (x = −13,5 + 3i, y = −8,1 + 1,8j), range 0,4, falloff 0, colori `LIGHT_COLORS[(i + j) % 4]`; una lettura del layer 0 in ogni centro (atteso, per canale, `Math.f16round(Math.f16round(ambient) + colore)`, entro 1 ULP fp16) e nei punti medi fra due vicini (atteso l'ambient, entro 1 ULP); poi 60 luci distrutte, `settledAt(41)` e la stessa lettura: le 40 rimaste uguali, i centri delle distrutte all'ambient, e il buffer da 128 resta. Registra `lightOrder.length` (100, poi 40) e `worstUlps` delle due letture. Un buffer distrutto e ancora legato farebbe rifiutare il probe col suo errore di validazione; la console (solo il 404 di `favicon.ico`) la guarda chi esegue.
  - **`scene { phase, resize = false }`** (gli screenshot di Mode A). La preparazione della fase 1 è quella del passo 6 (`setView(false)` + `lightUp`): `clearEntities` in B e C (in Mode A la pagina è appena caricata), camera (0, 0) a zoom 1, `setAmbient([0.06, 0.07, 0.12], 1)`, `setBackend('lit')`, poi l'attesa delle righe (in Mode A, la riga dell'ultima entità in `engine.bridge.latestRenderState` e 30 frame), senza resize. Il banco lancia se 10·a ≤ 12,5, con a = floor(clientWidth·dpr)/floor(clientHeight·dpr), l'aspetto della vista del render worker (skill `gpu-check` §7): il punto del pavimento (−12, −7) deve cadere nella tela (alla finestra 1200×689, a = 1,57). Fase 1, pavimento e quattro luci 2D a falloff 0: M `(-8, 3)` mix [1, 0.5, 0.25] range 2; R `(3, -1)` depth 0,5 add [0, 0.5, 0] range 5; P `(1.5, -1)` depth 1 `.transparent()` mix [1, 0.25, 0.25] range 3; Q `(4.5, -1)` depth 2 mix [0.25, 0.25, 1] range 3. Fase 2 (in posto): depth di P e Q scambiate. Fase 3 (in posto): M distrutta (Q, l'ultima riga, va nel suo slot), P e Q a depth 1; il banco lancia se slot(Q) ≥ slot(P), perché solo con slot(Q) < slot(P) lo screenshot distingue la regola dell'id dall'ordine degli slot. Restituisce `points` (floor (−12, −7), mIn (−8, 3), pOnly (0, −1), overlap (3, −1), qOnly (6, −1), rOnly (3, 2,5)), gli id, gli slot (`lights`) ed `expected8`, la regola del passo 7 a 8 bit: floor (15, 18, 31); mIn (255, 128, 64), il floor in fase 3; pOnly (255, 64, 64); overlap (255, 64, 64) in fase 1 e (64, 64, 255) poi; qOnly (64, 64, 255); rOnly (15, 145, 31). In B e C anche `measured` (il light buffer nei punti) e `maxDiff`.
  - Una prova in node contro un motore finto, su ogni task e ogni ramo, toglie gli errori di battitura dai percorsi che la GPU non tocca subito.
  - Poi `node --test docs/plans/assets/2026-10-08-step7/step7-stats.test.mjs`: 13/13 (il test degli aiutanti legge il banco appena scritto).
- [ ] **Step 4: la sessione su master (Mac).** Il motore è quello di master (`ts/wasm` si ricostruisce solo se lo chiede `guard-stale-wasm`). Caffeinate avviato (Vincoli globali); nel registro SDD `sw_vers -productVersion -buildVersion` e la versione di Chrome, che il Task 9 confronta. Dev server riavviato e asset server avviati; `"http://localhost:5173/?mode=B&bench"` con `ignoreCache` e `initScript` = `anti-reload-init.js`; la riga dell'adapter; `load-bench.js` (`benchType` `'function'`). Con `label: '1d19575'` e `filePath` = `<repo>/docs/plans/assets/2026-10-08-step7/master-B.json`, in quest'ordine: `permute` (la calibrazione); `order` K 3 `apart` 1 (il controllo); `order` K 3 `apart` 256; `order` K 4 `apart` 1024; `regress` (la base del Task 9). Con la risposta (a) e una sola griglia a 256 e a 1024, anche `order` `apart` 1 e 256 con `atomic: true`. Poi `?mode=C&bench`: `permute` e `regress` → `master-C.json`. Console: solo il 404 di `favicon.ico`. Ogni task comincia dalla pulizia del banco; una corsa che `step7-stats.mjs` rifiuta (exit 3: gli slot o il percorso del cull non sono quelli che il riassunto presuppone) si rifà, e i suoi numeri non si leggono.
- [ ] **Step 5: statistica e ramo**, fissati prima della corsa. In una sola chiamata, dalla radice del repo: `A=docs/plans/assets/2026-10-08-step7; for m in B C; do node $A/step7-stats.mjs permute $A/master-$m.json > $A/master-$m.permute.stats.json; done; node $A/step7-stats.mjs order $A/master-B.json > $A/master-B.order.stats.json` (un exit 3 è un rifiuto: la corsa si rifà; `master-B.permute.stats.json` è il file che cita il Task 6):
  - **Calibrazione:** `permute` con `permuted` vero (nessun rifiuto), `changed` > 0 e `maxSteps` ≤ 2 in B e in C; con 0 l'osservabile è cieco: ci si ferma e lo si riporta (proposta: una lettura dev di `visible-indices`).
  - **Controllo:** `apart` 1, le luci in un workgroup → una griglia. Più di una è un fatto nuovo, da registrare, e basta come sede.
  - **Riordino:** una corsa con `apart` ≥ 256, non rifiutata (le luci in workgroup distinti), con più griglie → la sede è Chrome, Mode B, quella configurazione.
  - **Nessun riordino:** il criterio porta a Safari, nel passo 7; la risposta alla sotto-decisione 1 dice solo se prima si prova il percorso atomico. (a) Se una corsa `atomic` riordina, la sede è Chrome col percorso atomico; altrimenti Safari. (b) Subito Safari. In Safari: un driver safaridriver minimo nello spazio SDD, sul modello della §M12 del README del Mac (`safaridriver -p 4444`, endpoint W3C `/session`, `/url`, `/timeouts` con uno script timeout più lungo della corsa, `/execute/async`, finestra 1200×741; Safari in primo piano con `open -a Safari`, perché coperto ferma il rAF, e `document.visibilityState` registrato), `permute` e `order` (`apart` 1 e 256) su master in `?mode=B&bench` → `master-safari-B.json`, riassunti con `node docs/plans/assets/2026-10-08-step7/step7-stats.mjs permute docs/plans/assets/2026-10-08-step7/master-safari-B.json --cull atomic > docs/plans/assets/2026-10-08-step7/master-safari-B.permute.stats.json` e `node docs/plans/assets/2026-10-08-step7/step7-stats.mjs order docs/plans/assets/2026-10-08-step7/master-safari-B.json > docs/plans/assets/2026-10-08-step7/master-safari-B.order.stats.json` (Safari non ha subgroup). Il driver resta nello spazio SDD fino al passo 9, che committa quello definitivo; il JSON ne registra lo sha256, la riga di comando e le versioni di Safari e di safaridriver.
  - Il ramo e il perché vanno nel registro SDD, e da lì nel gotcha nuovo (Task 6) e nella voce del §4 (Task 10).
- [ ] **Step 6: commit** del banco e di `docs/plans/assets/2026-10-08-step7/`: `test(7): banco committato (regressione, ordine, permutazione, crescita della lista, scena di Mode A) e statistica; la misura su master del riordino delle luci`.

### Task 2: la lista delle luci nella scansione di `deriveLightGroups`

**Files:**
- Modify: `ts/src/render/light-groups.ts` (import `:1-2`, header `:21-25`, `LightGroups` `:34-53`, `LightGroupsInput` `:55-62`, costanti `:64-71`, commento del margine `:81-86`, scansione `:106-145`, `return` `:204-212`) e `light-groups.test.ts` (import `:3` e `:6`, costanti e `E` `:17-20`, `scene()` `:39-53`, test nuovi in fondo)
- Modify: `ts/src/render/passes/transparent-sort-constants.ts` (prima di `:34`), `transparent-sort-reference.ts` (`:25-69`)
- Modify: `ts/src/render/render-pass.ts` (`:7`), `ts/src/renderer.ts` (`:1045`), `ts/src/render/passes/debug-line-pass.test.ts` (`:22`)
- Modify: `ts/src/render/passes/light-groups-pass.ts` (`:21`), `light-groups-pass.test.ts` (`:91`), `ts/src/lighting-api.test.ts` (dopo `:231`)

**Interfaces:**
- Produces (`light-groups.ts`): `LightGroups.lightOrder: Uint32Array<ArrayBuffer>` (gli slot in ordine di disegno, un array nuovo a ogni chiamata); `LightGroups.lightIds: Uint32Array<ArrayBuffer>` (i loro id; lo slot, se la colonna è inutilizzabile); `LightGroupsInput.entityIds?: Uint32Array`; `export const BLEND_MIX = 2`.
- Produces: `FrameState.entityIds: Uint32Array`, obbligatorio; `sortableZBits(bits: number): number` in `transparent-sort-constants.ts`, riesportata da `transparent-sort-reference.ts`.
- Consumes: `isSphereInFrustum`, `extractFrustumPlanes` (`camera.ts:142`, `:210`); `GPURenderState.entityIds` (`worker-bridge.ts:22`).
- Fra questo commit e quello del Task 3 la lista esiste ma lo stadio disegna ancora i bucket.

- [ ] **Step 1: i test che falliscono.** In `light-groups.test.ts`:
  - l'import di `:3` prende `BLEND_MIX`; dopo `:6`, `import { extractFrustumPlanes, isSphereInFrustum, orthographic } from '../camera';`;
  - accanto a `LIGHT`/`POINT`/… (`:17-18`), `const ADD = 0, SUB = 1, MIX = 2;`. `E` (`:20`) prende `x?`, `y?`, `z?`, `r?`, `zBits?` (i bit grezzi della z della riga: −0, NaN), `id?` (default: la riga) e `blend?`. `scene()` (`:39-53`) scrive `(blend << 14)` nella parola delle luci, `bounds` = (x, y, z o `zBits`, r) e una colonna `entityIds` (id o riga). Le righe dei 30 test esistenti non cambiano: id = riga, blend 0, y e z 0. La camera resta `[0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]`, che tiene in vista z ∈ [−r, 1 + r];
  - in fondo, `mulberry32` (come `transparent-sort-reference.test.ts`), `const drawn = (input: LightGroupsInput): number[] => [...deriveLightGroups(input).lightIds]` (tipizzato: `tsconfig.json` ha `strict` e include i test, e un parametro senza tipo è TS7006), `const ENGINE_VIEW = orthographic(-160 / 9, 160 / 9, -10, 10, -1, 1000)` (la camera di default a 16:9), e `describe('deriveLightGroups: the light list (round step 7)')` con 15 test, che usano gli helper `light(mask, shadow, extra)` e `drawable(flags, mask, extra)` di HEAD:
    1. `[drawable(RECV), light(…, {id: 7}), drawable(CAST), light(…, {id: 3, x: 100}), light(…, {id: 9})]` → `lightOrder` [1, 4], `lightIds` [7, 9]; una chiamata successiva su un'altra scena non tocca gli array restituiti (contenuto uguale dopo, `buffer` diversi: array riusati fra le chiamate, per esempio viste `subarray` di un buffer di modulo, li riscriverebbero, e il renderer ed `engine.lighting.groups` ne tengono uno ciascuno); scrivere nell'array restituito non cambia la chiamata dopo;
    2. maschere 0b01, 0b10 in x 15,02 (r 5) e 0b100 in x 14,98 (r 5), un ricevitore per layer → `lightOrder` [0, 2], `lightMasks` {0b01, 0b10, 0b100}; più due pin di testo: `cull.wgsl` (senza commenti) con `let dist = dot(plane.xyz, center) + plane.w;` seguito da `if (dist < -radius)`, `camera.ts` con `if (dist < -radius) return false;`;
    3. 600 sfere a ±0,05 dalla tangenza con uno dei sei piani di `ENGINE_VIEW`, raggio 0,5-20, `mulberry32(7)` → `lightOrder` ordinato = ciò che `isSphereInFrustum` tiene col raggio vero (fra 100 e 500);
    4. 'add and sub before mix, whatever their z or id': id 1 MIX z 0, 2 ADD z 0,9, 3 SUB z 0,5, 4 MIX z −0,5 → [3, 2, 4, 1];
    5. in una classe, z crescente: id 1 z 0,75, 2 z −0,5, 3 z −3, 4 z 0,25 (r 5) → [3, 2, 4, 1];
    6. a z uguale, id crescente: id 40, 7, 1000 → [7, 40, 1000]; e −0 vale +0: la luce a −0 (`zBits` 0x80000000) ha l'id più alto (9) e lo slot prima della luce a +0 (id 4) → [4, 9]. Senza la normalizzazione −0 avrebbe la chiave 0x7FFFFFFF, sotto lo 0x80000000 di +0, e andrebbe per prima qualunque id ([9, 4]); con −0 sull'id più basso il test passerebbe in ogni caso. La coppia al contrario (−0 con id 4) resta;
    7. NaN: `zBits` 0x7fc00000, z 0,5, `zBits` 0xffc00000, z −0,5 → `lightOrder` [2, 3, 1, 0];
    8. cinque luci (id 11 MIX z 0,5; 12 ADD z 0,5; 13 MIX z 0,1; 14 SUB z 0,1; 15 MIX z 0,5) in quattro permutazioni degli slot → sempre [14, 12, 13, 11, 15];
    9. come il cull: una luce di maschera 0 (id 1), una sprite (tipo 4, id 2), `drawable(7, 0xffff, {id: 3})` (tipo oltre 6) e un ricevitore (id 4) → [1, 2, 3]; il blend 3 va con add: [MIX id 1, blend 3 id 2] → [2, 1];
    10. global (x 1e6, z 5, r 3,4e38, id 1) e directional (x −1e6, r 3,4e38, id 2) → [2, 1];
    11. near/far con la camera di `scene()`: id 1 z −1, 2 z −1,0001, 3 z 2, 4 z 2,0001 → [1, 3]; con `ENGINE_VIEW` e r 5: id 1 z 6, 2 z 6,01, 3 z −1005, 4 z −1005,01 → [3, 1];
    12. id 50, 2 e 99 (z −0,5) → `lightIds` [99, 2, 50]; con `entityIds` assente, vuota o dei primi 2 → `lightOrder` e `lightIds` [2, 0, 1];
    13. mondo vuoto, oppure nessuna luce in vista → liste vuote;
    14. `components.rs`: `RENDER_META_LIGHT_BLEND_SHIFT` = 14, `LightBlendMode` = {Add 0, Sub 1, Mix 2} = ADD/SUB/MIX, `BLEND_MIX` = Mix;
    15. `renderer.ts`: il letterale `const frameState: FrameState = {…};`, delimitato dal suo primo `};` (`renderer.ts:1039-1055`), contiene la riga `entityIds: state.entityIds,`, e c'è `frameState.lightGroups = deriveLightGroups(frameState);`. Il limite serve: la stessa riga c'è già due volte più giù (`:1097`, `:1134`), e una ricerca senza limite, come quella del test vicino (`light-groups.test.ts:357`), passerebbe già a HEAD.

  In `lighting-api.test.ts`, nel `describe('LightingAPI — groups (light layers)')` dopo `:231`, due test: slot 0 MIX z 0 id 5, slot 1 add z 0,5 id 9, slot 2 add z 0 id 2 → `lightOrder` [2, 1, 0], `lightIds` [2, 9, 5]; e senza `entityIds` (il default di `makeRenderState`) → `lightIds` [0, 1].

  Il codice. In `light-groups.test.ts`, gli import di `:3` e `:6` come sopra; costanti ed `E` al posto di `:17-20`:
```ts
const LIGHT = 6, CAST = 1 << 9, RECV = 1 << 10;
const POINT = 0, DIRECTIONAL = 2, GLOBAL = 3;
/** Light blend modes on the wire, renderMeta bits 14-15 (LightBlendMode in components.rs). */
const ADD = 0, SUB = 1, MIX = 2;

type E = {
  kind: 'light' | 'drawable'; mask?: number; flags?: number; type?: number; shadow?: number; range?: number;
  x?: number; y?: number; z?: number; r?: number;
  /** The row's z as raw f32 bits (-0, NaN), in place of `z`. */
  zBits?: number;
  /** The external id; default: the row. */
  id?: number;
  blend?: number;
};
```
  `scene()` e il suo doc al posto di `:39-53`:
```ts
/**
 * A scene in the SoA layout of GPURenderState. The view spans x, y in [-10, 10],
 * and clip z = z: a sphere of radius r is in view for z in [-r, 1 + r]. A
 * light's range defaults to light()'s 100, an entity's external id to its row.
 */
function scene(es: E[]): LightGroupsInput {
  const n = es.length;
  const renderMeta = new Uint32Array(n * 2), primParams = new Float32Array(n * 8), bounds = new Float32Array(n * 4);
  const boundsBits = new Uint32Array(bounds.buffer);
  const entityIds = new Uint32Array(n);
  es.forEach((e, i) => {
    const mask = (e.mask ?? (e.kind === 'light' ? 0xffff : 0)) << 16;
    const lightWord = LIGHT | ((e.type ?? POINT) << 11) | ((e.blend ?? ADD) << 14);
    renderMeta[i * 2 + 1] = ((e.kind === 'light' ? lightWord : e.flags ?? 0) | mask) >>> 0;
    if (e.kind === 'light') primParams[i * 8 + 3] = e.range ?? 100;
    primParams[i * 8 + 7] = e.shadow ?? 0;
    bounds[i * 4] = e.x ?? 0;
    bounds[i * 4 + 1] = e.y ?? 0;
    if (e.zBits !== undefined) boundsBits[i * 4 + 2] = e.zBits;
    else bounds[i * 4 + 2] = e.z ?? 0;
    bounds[i * 4 + 3] = e.r ?? 1;
    entityIds[i] = e.id ?? i;
  });
  const cameraViewProjection = new Float32Array([0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return { entityCount: n, renderMeta, primParams, bounds, cameraViewProjection, entityIds };
}
```
  In fondo al file:
```ts
// ── The light list (round step 7) ────────────────────────────────────────────
// Every light is drawn from ONE list deriveLightGroups builds in its scan: the
// lights the cull's EXACT sphere test keeps (no grouping margin), ordered by
// blend class (add and sub before mix), world z back to front, then external
// id, the higher id last (round plan §2, "Passo 7").

/** mulberry32, as transparent-sort-reference.test.ts: a failure replays. */
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

/** The external ids of a frame's light list, in draw order. */
const drawn = (input: LightGroupsInput): number[] => [...deriveLightGroups(input).lightIds];

/** The default camera's projection at 16:9, at the origin (CameraAPI: 20 units tall at zoom 1, near -1, far 1000). */
const ENGINE_VIEW = orthographic(-160 / 9, 160 / 9, -10, 10, -1, 1000);

describe('deriveLightGroups: the light list (round step 7)', () => {
  it('lists the slots of the lights in view in draw order, with their ids, in fresh arrays', () => {
    const s = scene([drawable(RECV), light(0xffff, 0, { id: 7 }), drawable(CAST), light(0xffff, 0, { id: 3, x: 100 }), light(0xffff, 0, { id: 9 })]);
    const g = deriveLightGroups(s);
    // A call on another scene must not touch what an earlier call returned:
    // arrays reused across calls (subarray views of one module buffer, say)
    // would rewrite them, and the renderer and engine.lighting.groups each
    // hold one.
    const other = deriveLightGroups(scene([light(0xffff, 0, { id: 3 })]));
    expect([...g.lightOrder]).toEqual([1, 4]);
    expect([...g.lightIds]).toEqual([7, 9]);
    expect(other.lightOrder.buffer).not.toBe(g.lightOrder.buffer);
    expect(other.lightIds.buffer).not.toBe(g.lightIds.buffer);
    g.lightOrder[0] = 99;  // the caller owns what it got: the next frame's list is new
    expect([...deriveLightGroups(s).lightOrder]).toEqual([1, 4]);
  });

  it("takes the cull's exact sphere test, not the grouping margin: a light in the margin keys the groups but is not drawn", () => {
    const g = deriveLightGroups(scene([
      light(0b01), light(0b10, 0, { x: 15.02, r: 5 }), light(0b100, 0, { x: 14.98, r: 5 }),
      drawable(RECV, 0b01), drawable(RECV, 0b10), drawable(RECV, 0b100),
    ]));
    expect([...g.lightOrder]).toEqual([0, 2]);
    expect([...g.lightMasks].sort((a, b) => a - b)).toEqual([0b01, 0b10, 0b100]);
    // The same strict test on both sides: a sphere is culled when dist < -radius.
    const cull = stripComments(readFileSync(new URL('../shaders/cull.wgsl', import.meta.url), 'utf8'));
    expect(cull).toMatch(/let dist = dot\(plane\.xyz, center\) \+ plane\.w;\s*if \(dist < -radius\)/);
    expect(readFileSync(new URL('../camera.ts', import.meta.url), 'utf8')).toMatch(/if \(dist < -radius\) return false;/);
  });

  it('lists exactly the spheres isSphereInFrustum keeps at their bare radius, near every plane of the default camera', () => {
    // 600 spheres within 0.05 of tangency with one of the six planes (near -1,
    // far 1000 included): the margin, or any other test, lists another set.
    const rand = mulberry32(7);
    // [axis, the plane's coordinate, +1 when the view lies above it on that axis]
    const planes: Array<[number, number, number]> = [[0, -160 / 9, 1], [0, 160 / 9, -1], [1, -10, 1], [1, 10, -1], [2, 1, -1], [2, -1000, 1]];
    const lights: E[] = [];
    for (let k = 0; k < 600; k++) {
      const [axis, at, inward] = planes[k % 6];
      const r = 0.5 + 19.5 * rand();
      const c = [(rand() * 2 - 1) * 8, (rand() * 2 - 1) * 5, -rand() * 500];
      c[axis] = at - inward * (r + (rand() * 2 - 1) * 0.05);
      lights.push(light(0xffff, 0, { x: c[0], y: c[1], z: c[2], r }));
    }
    const s = { ...scene(lights), cameraViewProjection: ENGINE_VIEW };
    const fp = extractFrustumPlanes(ENGINE_VIEW);
    const b = s.bounds;
    const want = lights.map((_, i) => i).filter((i) => isSphereInFrustum(fp, b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]));
    expect(want.length).toBeGreaterThan(100);
    expect(want.length).toBeLessThan(500);
    expect([...deriveLightGroups(s).lightOrder].sort((x, y) => x - y)).toEqual(want);
  });

  it('add and sub before mix, whatever their z or id', () => {
    expect(drawn(scene([
      light(0xffff, 0, { id: 1, blend: MIX, z: 0 }), light(0xffff, 0, { id: 2, z: 0.9 }),
      light(0xffff, 0, { id: 3, blend: SUB, z: 0.5 }), light(0xffff, 0, { id: 4, blend: MIX, z: -0.5 }),
    ]))).toEqual([3, 2, 4, 1]);
  });

  it('within a class, back to front: the smaller world z first (a 2D light: the larger depth)', () => {
    expect(drawn(scene([
      light(0xffff, 0, { id: 1, z: 0.75, r: 5 }), light(0xffff, 0, { id: 2, z: -0.5, r: 5 }),
      light(0xffff, 0, { id: 3, z: -3, r: 5 }), light(0xffff, 0, { id: 4, z: 0.25, r: 5 }),
    ]))).toEqual([3, 2, 4, 1]);
  });

  it('at equal z the higher external id is drawn later, in front (the 5b rule); -0 equals +0', () => {
    expect(drawn(scene([light(0xffff, 0, { id: 40 }), light(0xffff, 0, { id: 7 }), light(0xffff, 0, { id: 1000 })]))).toEqual([7, 40, 1000]);
    // sortableZBits maps -0 to +0, as the 5b gather does. Without that step
    // -0 keys 0x7FFFFFFF, below +0's 0x80000000, and is drawn first whatever
    // its id: so the -0 light has the HIGHER id, in the earlier slot.
    expect(drawn(scene([light(0xffff, 0, { id: 9, zBits: 0x80000000 }), light(0xffff, 0, { id: 4, z: 0 })]))).toEqual([4, 9]);
    expect(drawn(scene([light(0xffff, 0, { id: 4, zBits: 0x80000000 }), light(0xffff, 0, { id: 9, z: 0 })]))).toEqual([4, 9]);
  });

  it('keys z by its bits as the GPU holds them: a NaN z has a fixed place, never left to the sort', () => {
    // sortableZBits: +NaN after +Inf, -NaN before -Inf. A float comparator is
    // inconsistent with a NaN, and the order would depend on the sort algorithm.
    const s = scene([
      light(0xffff, 0, { zBits: 0x7fc00000 }), light(0xffff, 0, { z: 0.5 }),
      light(0xffff, 0, { zBits: 0xffc00000 }), light(0xffff, 0, { z: -0.5 }),
    ]);
    expect([...deriveLightGroups(s).lightOrder]).toEqual([2, 3, 1, 0]);
  });

  it('is a function of the ECS state: the same lights in other slots give the same ids in the same order', () => {
    // A despawn swap-removes rows (render_state.rs), snapshot_restore reassigns the slots.
    const lights = [
      light(0xffff, 0, { id: 11, z: 0.5, blend: MIX }), light(0xffff, 0, { id: 12, z: 0.5 }), light(0xffff, 0, { id: 13, z: 0.1, blend: MIX }),
      light(0xffff, 0, { id: 14, z: 0.1, blend: SUB }), light(0xffff, 0, { id: 15, z: 0.5, blend: MIX }),
    ];
    for (const perm of [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 4, 0, 3, 2]]) {
      expect(drawn(scene(perm.map((p) => lights[p]))), perm.join()).toEqual([14, 12, 13, 11, 15]);
    }
  });

  it('lists what the cull draws as a light: a mask-0 light, a sprite light, a type past Light2D; the unclaimed blend 3 sorts with add', () => {
    // vs_main drops a mask-0 light in every group, fs_main discards a sprite
    // light until step 8, and cull.wgsl clamps a type past 6 to Light2D.
    const SPRITE = 4, PAST_LAST = 7;
    expect(drawn(scene([light(0, 0, { id: 1 }), light(0xffff, 0, { id: 2, type: SPRITE }), drawable(PAST_LAST, 0xffff, { id: 3 }), drawable(RECV, 0, { id: 4 })])))
      .toEqual([1, 2, 3]);
    // Rust stores a 3 (masked, never rejected): light-accum.wgsl draws it like add, so it sorts with add.
    expect(drawn(scene([light(0xffff, 0, { id: 1, blend: MIX }), light(0xffff, 0, { id: 2, blend: 3 })]))).toEqual([2, 1]);
  });

  it('lists a global or directional light wherever its transform is (radius f32::MAX), ordered by z like any other', () => {
    expect(drawn(scene([
      light(0xffff, 0, { id: 1, type: GLOBAL, x: 1e6, z: 5, r: 3.4e38 }),
      light(0xffff, 0, { id: 2, type: DIRECTIONAL, x: -1e6, r: 3.4e38 }),
    ]))).toEqual([2, 1]);
  });

  it('a light whose z leaves near or far by more than its radius is not listed (decision 4)', () => {
    // scene()'s camera keeps z in [-r, 1 + r].
    expect(drawn(scene([
      light(0xffff, 0, { id: 1, z: -1 }), light(0xffff, 0, { id: 2, z: -1.0001 }),
      light(0xffff, 0, { id: 3, z: 2 }), light(0xffff, 0, { id: 4, z: 2.0001 }),
    ]))).toEqual([1, 3]);
    // The default camera (near -1, far 1000, at z 0): a light of range 5 is listed for z in [-1005, 6].
    expect(drawn({ ...scene([
      light(0xffff, 0, { id: 1, z: 6, r: 5 }), light(0xffff, 0, { id: 2, z: 6.01, r: 5 }),
      light(0xffff, 0, { id: 3, z: -1005, r: 5 }), light(0xffff, 0, { id: 4, z: -1005.01, r: 5 }),
    ]), cameraViewProjection: ENGINE_VIEW })).toEqual([3, 1]);
  });

  it('without a usable id column the slot stands in for every id: all or nothing, never read past it', () => {
    const s = scene([light(0xffff, 0, { id: 50 }), light(0xffff, 0, { id: 2 }), light(0xffff, 0, { id: 99, z: -0.5 })]);
    expect([...deriveLightGroups(s).lightIds]).toEqual([99, 2, 50]);
    for (const entityIds of [undefined, new Uint32Array(0), s.entityIds!.slice(0, 2)]) {
      const g = deriveLightGroups({ ...s, entityIds });
      expect([...g.lightOrder], `${entityIds?.length ?? 'no'} ids`).toEqual([2, 0, 1]);
      expect([...g.lightIds]).toEqual([2, 0, 1]);
    }
  });

  it('an empty world, or no light in view: empty lists', () => {
    for (const s of [scene([]), scene([drawable(RECV), light(0xffff, 0, { x: 100 })])]) {
      const g = deriveLightGroups(s);
      expect(g.lightOrder).toHaveLength(0);
      expect(g.lightIds).toHaveLength(0);
    }
  });

  it("BLEND_MIX and the blend field's shift are Rust's (LightBlendMode, RENDER_META_LIGHT_BLEND_SHIFT)", () => {
    const rust = readFileSync(new URL('../../../crates/hyperion-core/src/components.rs', import.meta.url), 'utf8');
    expect(Number(/pub const RENDER_META_LIGHT_BLEND_SHIFT: u32 = (\d+);/.exec(rust)?.[1])).toBe(14);
    const modes = new Map([.../pub enum LightBlendMode \{([^}]*)\}/.exec(rust)![1].matchAll(/(\w+)\s*=\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
    expect(modes).toEqual(new Map([['Add', ADD], ['Sub', SUB], ['Mix', MIX]]));
    expect(BLEND_MIX).toBe(modes.get('Mix'));
  });

  it('renderer.ts hands the slot -> id column to the grouping: FrameState.entityIds = state.entityIds', () => {
    // createRenderer needs a GPU: the wiring is pinned on the text.
    const renderer = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
    // Bounded to the literal: renderer.ts already says `entityIds: state.entityIds,`
    // twice further down (the sort probe's snapshot, the debug probe).
    const start = renderer.indexOf('const frameState: FrameState = {');
    expect(start).toBeGreaterThan(-1);
    const literal = renderer.slice(start, renderer.indexOf('};', start));
    expect(literal).toMatch(/\n\s*entityIds: state\.entityIds,\n/);
    expect(renderer).toMatch(/frameState\.lightGroups = deriveLightGroups\(frameState\);/);
  });
});
```
  In `lighting-api.test.ts`, dopo `:231` (dentro il `describe`, che usa già `LIGHT`, `emptyRenderState`, `withState` e `view`):
```ts
  it("reports the light list in draw order, keyed by the render state's entity ids (round step 7)", () => {
    const MIX = 2;  // LightBlendMode::Mix, at bits 14-15 (light-groups.test.ts ties both to Rust)
    const renderMeta = new Uint32Array([
      0, (LIGHT | (MIX << 14) | (0xffff << 16)) >>> 0, // slot 0: mix at z 0, id 5
      0, (LIGHT | (0xffff << 16)) >>> 0,                // slot 1: add at z 0.5, id 9
      0, (LIGHT | (0xffff << 16)) >>> 0,                // slot 2: add at z 0, id 2
    ]);
    const bounds = new Float32Array([0, 0, 0, 1, 0, 0, 0.5, 1, 0, 0, 0, 1]);
    const rs = emptyRenderState({ entityCount: 3, renderMeta, bounds, primParams: new Float32Array(24), entityIds: new Uint32Array([5, 9, 2]) });
    const groups = withState(rs, () => view).groups!;
    expect([...groups.lightOrder]).toEqual([2, 1, 0]);
    expect([...groups.lightIds]).toEqual([2, 9, 5]);
  });

  it("orders by slot when the render state has no id column (makeRenderState's default)", () => {
    const renderMeta = new Uint32Array([0, (LIGHT | (0xffff << 16)) >>> 0, 0, (LIGHT | (0xffff << 16)) >>> 0]);
    const rs = emptyRenderState({ entityCount: 2, renderMeta, bounds: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), primParams: new Float32Array(16) });
    expect([...withState(rs, () => view).groups!.lightIds]).toEqual([0, 1]);
  });
```
- [ ] **Step 2: RED.** `npx --prefix ts vitest run --root ts src/render/light-groups.test.ts src/lighting-api.test.ts`. Expected: FAIL in 17 test, i nuovi (15 + 2, il 15 compreso grazie al limite); passano i 52 che c'erano (30 + 22).
- [ ] **Step 3: il codice**
  1. `transparent-sort-constants.ts`, prima di `// ── What the gather reads from the cull ──` (`:34`):
```ts
// ── Keys ─────────────────────────────────────────────────────────────────────

/**
 * The z key (design §5.1), from the bits of `entity-bounds[slot].z` as the
 * gather computes it: -0 becomes +0 by an integer compare (no float operation
 * touches z), then the flip that makes unsigned order follow float order — a
 * negative z has every bit inverted, a positive one gets the sign bit set.
 * The light list (render/light-groups.ts, round step 7) keys its z with it
 * too, so lights and transparent sprites follow one rule.
 */
export function sortableZBits(bits: number): number {
  let zb = bits >>> 0;
  if (zb === 0x80000000) zb = 0;
  return ((zb & 0x80000000) !== 0 ? ~zb : zb | 0x80000000) >>> 0;
}

```
     In `transparent-sort-reference.ts`: l'import di `:25-55` prende `sortableZBits,` dopo `WORKGROUP_SIZE,`; dopo la sua chiusura, una riga vuota ed `export { sortableZBits };`; il doc e la funzione di `:59-69` se ne vanno (il titolo `// ── Keys ──` di `:57` resta, sopra `digitOf`). Chi la importa da qui non cambia. Il modulo delle costanti è già nel grafo del renderer (`renderer.ts:38`); il modello CPU del sort, con lo stato di modulo che ha, no.
  2. `light-groups.ts`:
     - terza riga di import: `import { sortableZBits } from './passes/transparent-sort-constants';`;
     - in fondo all'header (`:21-25`):
```ts
 *
 * The same scan builds the frame's light list (round step 7): the order in
 * which LightAccumStage draws every light, into every group. It holds each
 * Light2D the cull's EXACT sphere-frustum test keeps (cull.wgsl; the grouping
 * keeps its margin), sorted by blend class (add and sub before mix), then world
 * z back to front, then external id, the higher id last: the 5b rule of the
 * transparent sort, and a function of the ECS state, never of the slots or of
 * the cull's atomics.
```
     - in `LightGroups`, dopo `occluderMasks: number[];` (`:52`), `lightOrder: Uint32Array<ArrayBuffer>;` e `lightIds: Uint32Array<ArrayBuffer>;`, con un doc ciascuno: la lista (gli slot delle luci che il test esatto del cull tiene, qualunque maschera o tipo, ordinati per classe, `sortableZBits` della z e id, l'id più alto dopo; un array nuovo a ogni chiamata) e gli id esterni nello stesso ordine (lo slot per tutti, se la colonna è più corta di `entityCount`);
     - in `LightGroupsInput` (`:55-62`) il doc dice che la grouping e la lista leggono queste colonne, e dopo `cameraViewProjection` c'è `entityIds?: Uint32Array;`, col doc: lo spareggio della lista; una colonna più corta di `entityCount`, o nessuna, si ignora per intero, e lo slot fa da id (un ordine fermo da un frame all'altro, ma non attraverso un despawn o un restore).
     - dopo `const LIGHT_TYPE_SHIFT = 11;` (`:67`):
```ts
/** renderMeta word 1, bits 14-15: the light's blend mode (RENDER_META_LIGHT_BLEND_SHIFT in components.rs). */
const LIGHT_BLEND_SHIFT = 14;
/**
 * The wire value of the `mix` blend mode (LightBlendMode::Mix, LIGHT_BLEND_IDS,
 * BLEND_MIX in light-accum.wgsl): the one class drawn after the others. Add
 * (0), sub (1) and the unclaimed 3, which light-accum.wgsl draws like add,
 * come first.
 */
export const BLEND_MIX = 2;
```
     - il commento del margine (`:81-86`) diventa:
```ts
/**
 * The grouping keeps every entity the GPU could draw, and a few more: the
 * cull's sphere-frustum test with a slightly larger radius. A receiver or a
 * caster the GPU draws but the CPU left out of the keys could land in a group
 * it was not keyed for. Lights are drawn from the light list, which takes the
 * exact test (round step 7): every listed light is inside this margin too, so
 * its mask is among the keys.
 */
```
     - prima di `export function deriveLightGroups` (`:106`):
```ts
/**
 * The light list's order: blend class, then sortableZBits of the row's z (the
 * bits the GPU holds: a view over `bounds`, no float round trip, so -0 is +0
 * and a NaN has a fixed place), then the id, then the slot. Every key is an
 * integer and the slots are unique, so the comparator is a total order: one
 * sorted permutation, whatever the sort algorithm.
 */
function orderLights(
  slots: readonly number[],
  renderMeta: Uint32Array,
  bounds: Float32Array,
  ids: Uint32Array | null,
): { lightOrder: Uint32Array<ArrayBuffer>; lightIds: Uint32Array<ArrayBuffer> } {
  const k = slots.length;
  const lightOrder = new Uint32Array(k);
  const lightIds = new Uint32Array(k);
  if (k === 0) return { lightOrder, lightIds };
  const zBits = new Uint32Array(bounds.buffer, bounds.byteOffset, bounds.length);
  const cls = new Uint8Array(k);
  const zKey = new Uint32Array(k);
  const id = new Uint32Array(k);
  for (let j = 0; j < k; j++) {
    const s = slots[j];
    cls[j] = ((renderMeta[s * 2 + 1] >>> LIGHT_BLEND_SHIFT) & 3) === BLEND_MIX ? 1 : 0;
    zKey[j] = sortableZBits(zBits[s * 4 + 2]);
    id[j] = ids === null ? s : ids[s];
  }
  const idx = Array.from({ length: k }, (_, j) => j);
  idx.sort((a, b) => (cls[a] - cls[b]) || (zKey[a] - zKey[b]) || (id[a] - id[b]) || (slots[a] - slots[b]));
  for (let j = 0; j < k; j++) {
    lightOrder[j] = slots[idx[j]];
    lightIds[j] = id[idx[j]];
  }
  return { lightOrder, lightIds };
}

```
     - in `deriveLightGroups`, dopo `inView` (`:111`):
```ts
  // All or nothing: a short column is a transport bug, and mixing ids with
  // slots as keys would compare two numberings.
  const ids = input.entityIds !== undefined && input.entityIds.length >= entityCount ? input.entityIds : null;
  const listed: number[] = [];
```
     - nel ramo delle luci, `if (!inView(i)) continue;` (`:128`) diventa:
```ts
      // The cull's own test, radius as is: the light list decides what is drawn.
      const drawn = isSphereInFrustum(planes, bounds[i * 4], bounds[i * 4 + 1], bounds[i * 4 + 2], bounds[i * 4 + 3]);
      // `drawn ||` keeps every listed light among the keys, whatever its radius.
      if (!drawn && !inView(i)) continue;
      if (drawn) listed.push(i);
```
     - nel `return` (`:204-212`), dopo `occluderMasks: occluders,`: `...orderLights(listed, renderMeta, bounds, ids),`.
  3. `render-pass.ts`, in `FrameState` dopo `primParams` (`:7`):
```ts
  /**
   * Slot -> external id (`GPURenderState.entityIds`): the tie-break of the
   * light list (`deriveLightGroups`, round step 7). The renderer passes the
   * column as it got it; a short one is the transport bug `uploadEntityIds`
   * warns about.
   */
  entityIds: Uint32Array;
```
     Obbligatorio: `tsc` costringe ogni costruttore di un `FrameState` completo a passarlo (`renderer.ts:1039`, `debug-line-pass.test.ts:15`).
  4. `renderer.ts`, nel letterale di `:1039-1055`, dopo `primParams: state.primParams ?? new Float32Array(0),` (`:1045`): `entityIds: state.entityIds,`. La riga `:1058` resta identica (ci si aggancia il test dell'avviso delle global, `light-groups.test.ts:357`).
  5. `debug-line-pass.test.ts`, in `makeFrame` dopo `primParams: new Float32Array(0),` (`:22`): `entityIds: new Uint32Array(0),`.
  6. `light-groups-pass.ts`, in `EVERYTHING` dopo `occluderMasks: [],` (`:21`), due righe, `  lightOrder: new Uint32Array(0),` e `  lightIds: new Uint32Array(0),` (una proprietà per riga come le altre: per questo al Task 3 `:98` è `:100`). In `light-groups-pass.test.ts`, nel `return` di `groups()` dopo `:91`, una riga: `    lightOrder: new Uint32Array(0), lightIds: new Uint32Array(0),` (il fallback passa da `:153-159` a `:154-160`).
  7. `lighting-api.ts` non cambia: il getter `groups` passa `{ ...rs, cameraViewProjection }` (`:136`), che porta già `rs.entityIds`.
- [ ] **Step 4: GREEN e tipi**
```bash
npx --prefix ts vitest run --root ts src/render/light-groups.test.ts src/lighting-api.test.ts src/render/passes/light-groups-pass.test.ts src/render/passes/debug-line-pass.test.ts src/render/passes/transparent-sort-reference.test.ts src/render/passes/transparent-sort-wgsl.test.ts src/demo/transparent-sort-checks.test.ts
npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"
npm --prefix ts test 2>&1 | grep -E 'Test Files|Tests '
```
Expected: verde (`light-groups.test.ts` 45/45, `lighting-api.test.ts` 24/24); nessun errore di tipo; 114 file, 2054 + 7 saltati.
- [ ] **Step 5: la prova che i test mordono** (solo nel working tree, una mutazione alla volta, poi i due file di test; i numeri sono quelli dello Step 1, L1 e L2 i due test di `lighting-api`). Ogni mutante deve far fallire esattamente questi test (misurati nello specchio):
  - il margine nella lista (`if (drawn) listed.push(i);` → `if (inView(i)) listed.push(i);`) → 2, 3, 11;
  - z decrescente (`(zKey[a] - zKey[b])` → `(zKey[b] - zKey[a])`) → L1, 4, 5, 7, 8, 10, 11, 12;
  - id decrescente (`(id[a] - id[b])` → `(id[b] - id[a])`) → L2, 1, 2, 6, 8, 9, 12;
  - `>= BLEND_MIX` nella classe → 9;
  - `const ids = input.entityIds ?? null;` → L2, 12;
  - il flip in linea senza il controllo di −0, al posto di `zKey[j] = sortableZBits(zBits[s * 4 + 2]);`: `{ const zb = zBits[s * 4 + 2] >>> 0; zKey[j] = ((zb & 0x80000000) !== 0 ? ~zb : zb | 0x80000000) >>> 0; }` → 6 (mutare `sortableZBits` stessa lo prende già `transparent-sort-reference.test.ts:371`);
  - array di modulo restituiti come viste: `const CACHE_ORDER = new Uint32Array(4096);` e `const CACHE_IDS = new Uint32Array(4096);` prima di `orderLights`, e `const lightOrder = CACHE_ORDER.subarray(0, k);`, `const lightIds = CACHE_IDS.subarray(0, k);` → 1.

  Rimetti il codice e verifica il verde.
- [ ] **Step 6: commit**
```bash
git add ts/src/render/light-groups.ts ts/src/render/light-groups.test.ts ts/src/render/passes/transparent-sort-constants.ts ts/src/render/passes/transparent-sort-reference.ts ts/src/render/render-pass.ts ts/src/renderer.ts ts/src/render/passes/debug-line-pass.test.ts ts/src/render/passes/light-groups-pass.ts ts/src/render/passes/light-groups-pass.test.ts ts/src/lighting-api.test.ts
git commit -m "feat(7): la lista delle luci nasce nella scansione di deriveLightGroups (test esatto del cull, classe di blend, z di mondo, id esterno)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: shader e stadio — la lista guida la draw, una pipeline «over», il blend `mix`

Shader, stadio e `LightGroupsPass` cambiano in un commit solo: il binding 2 dello shader nuovo è la lista, che solo lo stadio nuovo lega e solo il pass nuovo consegna. Il tipo resta `array<u32>` letto da `vs_main`, quindi lo shader di master gira anche nello stadio nuovo, leggendo la lista: servono a questo le gambe «stadio» (lo shader di master nello stadio nuovo, contro master) e «shader» (il passo 7 contro lo shader di master nello stesso stadio, sulla stessa pagina) di `regress` (Task 9).

**Files** (righe di HEAD; dopo il Task 2 `light-groups-pass.ts:98` è `:100`, e il fallback di `light-groups-pass.test.ts` è `:154-160`): `ts/src/shaders/light-accum.wgsl`; `ts/src/render/passes/light-accum-stage.ts` e `.test.ts`; `ts/src/render/passes/light-groups-pass.ts` e `.test.ts`; crea `docs/plans/assets/2026-10-08-step7/gate-m2.json`, `gate-m2-scene.json` e `gate-m2-grow-{B,C}.json`.

**Interfaces:** consuma `LightGroups.lightOrder` e `BLEND_MIX`; produce `export const LIGHT_BLEND: GPUBlendState`, `export const MIN_LIGHT_ORDER_CAPACITY = 64`, `LightAccumStage.prepare(device, frame, groups, lightOrder: Uint32Array<ArrayBuffer>): void`, e nello shader `@group(0) @binding(2) var<storage, read> lightOrder: array<u32>;` e `const BLEND_MIX: u32 = 2u;`. Sparisce `LIGHT2D_ARG_SLOTS` (a HEAD la importa solo il suo test). `LightGroupsPass.reads` non cambia: `OccluderSeedStage` legge ancora `visible-indices` e `indirect-args`.

- [ ] **Step 1: i test che falliscono**

`light-accum-stage.test.ts`:
- import: + `readFileSync`, `LIGHT_BLEND`, `MIN_LIGHT_ORDER_CAPACITY`, `BLEND_MIX` (da `'../light-groups'`); − `LIGHT2D_ARG_SLOTS` e l'import di `cull-pass`.
- `setUp(poolBuffers = POOL_BUFFERS)`: i buffer registrano `label` e `destroyed`; `writeBuffer` registra `offset` e rispetta `dataOffset`/`size` (elementi per un typed array, byte per un `ArrayBuffer`); i buffer del pool sono distruggibili (mappa `poolBuffer`); `list()` = l'ultimo buffer STORAGE vivo; `encode` registra le `drawIndexed` in `indexed`; `setUp` restituisce anche `pool`. Helper `direct(args)` (i default di WebGPU riempiti), `bindingOf(bg, binding)`, `NO_LIGHTS`, `lights(...slots)`. Le sette chiamate a `prepare` che restano (`:81`, `:100`, `:120`, `:157`, `:164`, `:170`, `:172`) prendono `NO_LIGHTS`.
- Il commento e i due test dei bucket (`:126-153`) diventano 8 test: (1) clear all'ambient (`{0.1, 0.2, 0.3, 1}` per `[0.2, 0.4, 0.6, 0.5]`) e una draw diretta `[6, 3, 0, 0, 0]` per `lights(5, 9, 2)`, nessuna indiretta; (2) la stessa draw in ognuno dei tre gruppi; (3) lista vuota: il clear e nessuna draw; (4) un frame con due luci disegna `[[6, 2, 0, 0, 0]]`, e un frame senza luci dopo non disegna niente, né diretto né indiretto (così fallisce anche al codice del Task 2, il cui stadio disegna quattro indirette; è l'unico test che vede un conteggio aggiornato solo per le liste non vuote); (5) una sola scrittura della lista per frame, in `prepare()`, a offset 0, `[5, 9, 2]`, e `encode()` non scrive; (6) binding 2 = `VERTEX`, `{ type: 'read-only-storage', minBindingSize: 4 }`, e il buffer legato lì esiste da `setup()` (`MIN_LIGHT_ORDER_CAPACITY * 4` byte, label `'light-order'`), non è uno dei buffer del pool, e il pool non ha `'light-order'` né dopo `setup()` né dopo `prepare()`; (6b) una sonda HMR sullo stesso pool (un secondo stadio, `setup()` e poi `destroy()`, come fa `renderer.ts:640-647` con un `LightGroupsPass` usa e getta) lascia allo stadio vivo il suo buffer: dopo `prepare` ed `encode` il binding 2 è ancora quello, non distrutto, e il pool continua a non avere `'light-order'`; (7) con 1000 luci cresce a 1024 × 4 (il vecchio distrutto) e il bind group cambia; una lista più corta dopo tiene buffer e bind group.
- 'blends additively into an HDR target' (`:177-182`) diventa 3 test: (8) senza `visible-indices` e `indirect-args` nel pool disegna `[6, 1, 0, 0, 0]`; (9) `destroy()` distrugge il buffer della lista e nessuno del pool; (10) una sola pipeline, target `SCENE_HDR_FORMAT`, `blend` = `LIGHT_BLEND` = `{ color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' } }`.
- In fondo, `describe('light-accum.wgsl: the light list and the blend modes (round step 7)')`: (11) `body('vs_main')` contiene `let e = lightOrder[instanceIdx];`, il codice senza commenti non nomina `visibleIndices`, il binding 2 è `var<storage, read> lightOrder: array<u32>`, e `lightOrder` non è raggiungibile da `fs_main`; (12) i `return` di `fs_main`, senza spazi e ordinati, sono esattamente `['vec4f(c,0.0)', 'vec4f(color*w,w)']`, con `let w = clamp(intensity, 0.0, 1.0);`, `if (blend == BLEND_MIX) {`, `if (blend == BLEND_SUB) { c = -c;` e `var c = color * intensity;`, e il ramo mix viene dopo l'ultimo `intensity *=` (il peso è l'intensità intera, decisione 3: falloff × cono × ombra); (13) da `components.rs`: lo shift 14 è `LIGHT_BLEND_SHIFT`, `BLEND_SUB` = Sub, `BLEND_MIX` = Mix = `BLEND_MIX` del TS; un solo `>> LIGHT_BLEND_SHIFT`, in `let blend = (renderMeta[e * 2u + 1u] >> LIGHT_BLEND_SHIFT) & 3u;`; nessun `[<>]=?\s*BLEND_(MIX|SUB)`; (14) l'header non dice più che il mix si somma come un add, con un pattern che attraversa l'a capo del commento (`` /added\s+(?:\/\/\s*)?like\s+`?add/ ``: a HEAD la frase è spezzata, "(added" / "// like `add`)", e una ricerca letterale non la troverebbe mai), e il file dice "Not yet: the `sprite` light type (discarded)."

`light-groups-pass.test.ts`: il device registra buffer e scritture; il pass finto registra `drawIndexed` in `ev.indexed` e `drawIndexedIndirect` in `ev.indirect`; `listBuffer()` = l'ultimo buffer STORAGE; `groups(gs, sets, lightOrder: number[] = [])` riempie `lightOrder` e `lightIds`. Il fallback diventa '…, and no light (only tests come here)': il pass di accumulo non registra né una draw diretta né una indiretta (al codice del Task 2 ne fa quattro indirette, e il test fallisce prima del codice). Test nuovo: `groups([[1, 0], [2, -1], [4, 0]], [5], [8, 3, 6, 1])` → una sola scrittura del buffer della lista, `[8, 3, 6, 1]`; accumulo su `light-buffer#0`, `#2`, `#1` (set-major), ognuno con una `drawIndexed` che comincia con `[6, 4]`.

Il codice. In `light-accum-stage.test.ts`, gli import al posto di `:1-9`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { LightAccumStage, LIGHT_BLEND, MIN_LIGHT_ORDER_CAPACITY, SLICE } from './light-accum-stage';
import { ResourcePool } from '../resource-pool';
import { SCENE_HDR_FORMAT } from '../formats';
import { BLEND_MIX } from '../light-groups';
import type { FrameState } from '../render-pass';
import lightShaderSource from '../../shaders/light-accum.wgsl?raw';
import { bindingDecls, callGraph, functionBody, functionParams, reachableFrom, stripComments } from '../../shaders/wgsl-analysis';
import { structSize } from '../../shaders/uniform-layout';
```
Il commento, `POOL_BUFFERS`, `setUp` e gli helper al posto di `:11-71` (`view` e `groups3`, `:73-74`, restano):
```ts
// LightAccumStage accumulates the lights of ONE light group into one layer of
// the light buffer (design 2026-09-26). Every group has its own 256-byte
// uniform slice, written once per frame: a writeBuffer between the render
// passes of one frame would land only with its last write. Since round step 7
// every group draws the frame's ONE light list (deriveLightGroups), in one
// direct draw, through ONE pipeline with a premultiplied "over" blend.

const POOL_BUFFERS = ['entity-transforms', 'visible-indices', 'indirect-args', 'render-meta', 'prim-params'];

function setUp(poolBuffers = POOL_BUFFERS) {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 };
  g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

  const pipelines: GPURenderPipelineDescriptor[] = [];
  const buffers: Array<{ size: number; usage: number; label?: string; destroyed: boolean }> = [];
  const bindGroups: GPUBindGroupDescriptor[] = [];
  const writes: Array<{ buffer: unknown; offset: number; data: ArrayBuffer }> = [];
  const layouts: GPUBindGroupLayoutDescriptor[] = [];
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => {
      const b = { size: d.size, usage: d.usage, label: d.label, destroyed: false, destroy() { b.destroyed = true; } };
      buffers.push(b);
      return b;
    },
    createShaderModule: () => ({}),
    createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => { layouts.push(d); return {}; },
    createPipelineLayout: () => ({}),
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => { pipelines.push(d); return {}; },
    createBindGroup: (d: GPUBindGroupDescriptor) => { bindGroups.push(d); return { d }; },
    queue: {
      // dataOffset and size count elements for a typed array, bytes for an ArrayBuffer (WebGPU's rule).
      writeBuffer: (buffer: unknown, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const unit = data instanceof ArrayBuffer ? 1 : ((data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1);
        const start = dataOffset * unit;
        writes.push({ buffer, offset, data: bytes.slice(start, size === undefined ? bytes.length : start + size * unit).buffer });
      },
    },
  } as unknown as GPUDevice;

  const pool = new ResourcePool();
  /** The pool's buffers, by name: the stage must never destroy one (an HMR probe runs setup() then destroy()). */
  const poolBuffer = new Map<string, { name: string; destroyed: boolean; destroy(): void }>();
  for (const name of poolBuffers) {
    const b = { name, destroyed: false, destroy() { b.destroyed = true; } };
    poolBuffer.set(name, b);
    pool.setBuffer(name, b as unknown as GPUBuffer);
  }
  const stage = new LightAccumStage();
  stage.setup(device, pool);
  const frame = (over: Partial<FrameState> = {}) =>
    ({ canvasWidth: 800, canvasHeight: 600, cameraViewProjection: new Float32Array(16), ...over }) as FrameState;
  const uniform = () => buffers.filter((b) => (b.usage & GPUBufferUsage.UNIFORM) !== 0 && !b.destroyed).at(-1)!;
  /** The light list's buffer: the stage's only STORAGE buffer. */
  const list = () => buffers.filter((b) => (b.usage & GPUBufferUsage.STORAGE) !== 0 && !b.destroyed).at(-1)!;

  const encode = (g: number, target: GPUTextureView, sdf: GPUTextureView, f = frame()) => {
    const passes: Array<{ desc: GPURenderPassDescriptor; draws: number[]; indexed: number[][]; groups: unknown[] }> = [];
    const encoder = {
      beginRenderPass: (desc: GPURenderPassDescriptor) => {
        const rec = { desc, draws: [] as number[], indexed: [] as number[][], groups: [] as unknown[] };
        passes.push(rec);
        return {
          setPipeline() {}, setVertexBuffer() {}, setIndexBuffer() {}, end() {},
          setBindGroup: (_i: number, bg: unknown) => { rec.groups.push(bg); },
          drawIndexedIndirect: (_b: GPUBuffer, offset: number) => { rec.draws.push(offset); },
          drawIndexed: (...args: number[]) => { rec.indexed.push(args); },
        };
      },
    } as unknown as GPUCommandEncoder;
    stage.encode(encoder, g, target, sdf, f);
    return passes[0];
  };
  return { stage, device, pipelines, buffers, bindGroups, writes, layouts, pool, poolBuffer, frame, uniform, list, encode };
}

/** drawIndexed's five arguments, WebGPU's defaults filled in. */
const direct = (args: number[]) => [args[0], args[1] ?? 1, args[2] ?? 0, args[3] ?? 0, args[4] ?? 0];
/** The resource a recorded bind group (the mock returns { d: descriptor }) binds at `binding`. */
const bindingOf = (bg: unknown, binding: number) =>
  [...(bg as { d: GPUBindGroupDescriptor }).d.entries].find((e) => e.binding === binding)!.resource;
/** A frame without lights. */
const NO_LIGHTS = new Uint32Array(0);
/** A frame's light list: slots in draw order. */
const lights = (...slots: number[]) => Uint32Array.from(slots);
```
I test (1)-(7) e (6b) al posto di `:126-153`:
```ts
  // Round step 7: every light comes from deriveLightGroups' list, in its order
  // (add and sub, then mix; world z back to front; external id), one DIRECT
  // draw per group. No indirect record, so no indirect-first-instance, and
  // `.transparent()` or a tier > 0 texture no longer moves a light later.
  it('clears its target to the ambient light, then draws the whole list in one direct draw, firstInstance 0', () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3, lights(5, 9, 2));
    const target = view('layer0');
    const pass = encode(0, target, view('sdf'), frame({ ambient: [0.2, 0.4, 0.6, 0.5] }));
    const attachment = [...pass.desc.colorAttachments][0]!;
    expect(attachment.view).toBe(target);
    expect(attachment.loadOp).toBe('clear');
    expect(attachment.clearValue).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    expect(pass.draws).toEqual([]);
    expect(pass.indexed.map(direct)).toEqual([[6, 3, 0, 0, 0]]);
  });

  it('draws the same list into every group: the vertex stage drops a light whose mask misses the group', () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3, lights(5, 9, 2));
    for (let g = 0; g < groups3.length; g++) {
      expect(encode(g, view(`layer${g}`), view('sdf')).indexed.map(direct), `group ${g}`).toEqual([[6, 3, 0, 0, 0]]);
    }
  });

  it('an empty list still clears the layer to the ambient, and draws nothing', () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3, NO_LIGHTS);
    const pass = encode(0, view('layer0'), view('sdf'), frame({ ambient: [0.2, 0.4, 0.6, 0.5] }));
    expect([...pass.desc.colorAttachments][0]!.clearValue).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    expect(pass.indexed).toEqual([]);
    expect(pass.draws).toEqual([]);
  });

  it("never draws an earlier frame's list: a frame without lights draws none", () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3, lights(5, 9));
    expect(encode(0, view('layer0'), view('sdf')).indexed.map(direct)).toEqual([[6, 2, 0, 0, 0]]);
    stage.prepare(device, frame(), groups3, NO_LIGHTS);
    const pass = encode(0, view('layer0'), view('sdf'));
    expect(pass.indexed).toEqual([]);
    expect(pass.draws).toEqual([]);
  });

  it('writes the list once per frame, in prepare(), at offset 0; encode() writes nothing', () => {
    const { stage, device, frame, writes, list, encode } = setUp();
    stage.prepare(device, frame(), groups3, lights(5, 9, 2));
    const mine = writes.filter((w) => w.buffer === list());
    expect(mine).toHaveLength(1);
    expect(mine[0].offset).toBe(0);
    expect([...new Uint32Array(mine[0].data)]).toEqual([5, 9, 2]);
    const before = writes.length;
    for (let g = 0; g < groups3.length; g++) encode(g, view(`layer${g}`), view('sdf'));
    expect(writes.length).toBe(before);
  });

  it('binding 2 is the list: vertex-only read-only storage with minBindingSize 4, a stage-private buffer', () => {
    const { stage, device, frame, layouts, list, pool, poolBuffer, encode } = setUp();
    const entry = [...layouts[0].entries].find((e) => e.binding === 2)!;
    expect(entry.visibility).toBe(GPUShaderStage.VERTEX);
    expect(entry.buffer).toEqual({ type: 'read-only-storage', minBindingSize: 4 });
    expect(pool.getBuffer('light-order')).toBeUndefined();
    stage.prepare(device, frame(), groups3, NO_LIGHTS);
    expect(pool.getBuffer('light-order')).toBeUndefined();
    // Created in setup(): every bind group is valid from the first frame, an empty one included.
    expect(list()).toMatchObject({ size: MIN_LIGHT_ORDER_CAPACITY * 4, label: 'light-order' });
    const bound = (bindingOf(encode(0, view('t'), view('sdf')).groups[0], 2) as GPUBufferBinding).buffer;
    expect(bound).toBe(list());
    expect([...poolBuffer.values()]).not.toContain(bound);
  });

  it('an HMR probe on the same pool (setup(), then destroy()) leaves the live stage its own list buffer', () => {
    // renderer.ts probes a reloaded shader with a throwaway LightGroupsPass on
    // the LIVE pool: a list buffer registered there, or shared, would die with it.
    const { stage, device, frame, pool, list, encode } = setUp();
    const own = list();
    const probe = new LightAccumStage();
    probe.setup(device, pool);
    probe.destroy();
    stage.prepare(device, frame(), groups3, lights(5, 9, 2));
    const bound = (bindingOf(encode(0, view('t'), view('sdf')).groups[0], 2) as GPUBufferBinding).buffer;
    expect(bound).toBe(own);
    expect(own.destroyed).toBe(false);
    expect(pool.getBuffer('light-order')).toBeUndefined();
  });

  it('grows the list buffer to the next power of two, never shrinks it, and rebuilds the cached bind groups only when it grows', () => {
    const { stage, device, frame, list, encode } = setUp();
    const sdf = view('sdf');
    stage.prepare(device, frame(), groups3, lights(1, 2, 3));
    const small = list();
    const first = encode(0, view('t'), sdf).groups[0];
    stage.prepare(device, frame(), groups3, new Uint32Array(1000));
    const big = list();
    expect(small.destroyed).toBe(true);
    expect(big.size).toBe(1024 * 4);
    const grown = encode(0, view('t'), sdf).groups[0];
    expect(grown).not.toBe(first);
    expect((bindingOf(grown, 2) as GPUBufferBinding).buffer).toBe(big);
    stage.prepare(device, frame(), groups3, lights(1, 2));
    expect(list()).toBe(big);
    expect(encode(0, view('t'), sdf).groups[0]).toBe(grown);
  });
```
I test (8)-(10) al posto di `:177-182` (il `});` del `describe` resta):
```ts
  it('needs neither visible-indices nor indirect-args from the pool', () => {
    const { stage, device, frame, encode } = setUp(['entity-transforms', 'render-meta', 'prim-params']);
    stage.prepare(device, frame(), groups3, lights(1));
    expect(encode(0, view('t'), view('sdf')).indexed.map(direct)).toEqual([[6, 1, 0, 0, 0]]);
  });

  it('destroy() destroys the list buffer and no pool buffer', () => {
    const { stage, device, frame, list, poolBuffer } = setUp();
    stage.prepare(device, frame(), groups3, lights(1, 2));
    const mine = list();
    stage.destroy();
    expect(mine.destroyed).toBe(true);
    for (const [name, b] of poolBuffer) expect(b.destroyed, name).toBe(false);
  });

  it('one pipeline, premultiplied "over" into an HDR target: rgb + dst·(1 − a), and the alpha keeps the clear value', () => {
    // A fragment alpha of 0 (add, sub) keeps dst whole: dst + c, what
    // {one, one} gave. Alpha w (mix): dst·(1 − w) + target·w.
    const { pipelines } = setUp();
    expect(pipelines).toHaveLength(1);
    const target = [...(pipelines[0].fragment?.targets ?? [])][0]!;
    expect(target.format).toBe(SCENE_HDR_FORMAT);
    expect(target.blend).toBe(LIGHT_BLEND);
    expect(LIGHT_BLEND).toEqual({
      color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
    });
  });
```
In fondo al file, i test (11)-(14):
```ts
describe('light-accum.wgsl: the light list and the blend modes (round step 7)', () => {
  it('vs_main takes its light from the list by instance index; nothing reads visibleIndices', () => {
    expect(body('vs_main')).toMatch(/let\s+e\s*=\s*lightOrder\[\s*instanceIdx\s*\]\s*;/);
    const code = stripComments(lightShaderSource);
    expect(code).not.toMatch(/\bvisibleIndices\b/);
    expect(code).toMatch(/@group\(0\)\s*@binding\(2\)\s*var<storage,\s*read>\s*lightOrder\s*:\s*array<u32>\s*;/);
    expect(bindingDecls(lightShaderSource).find((b) => b.binding === 2)?.name).toBe('lightOrder');
    expect(reachableFrom(lightShaderSource, 'fs_main').has('lightOrder')).toBe(false);  // vertex-only, like its layout entry
  });

  it('fs_main returns (c, 0) for add and sub, and (color·w, w) for mix, w its intensity clamped to [0, 1]', () => {
    const fs = body('fs_main');
    const returns = [...fs.matchAll(/return\s+([^;]+);/g)].map((m) => m[1].replace(/\s+/g, ''));
    expect(returns.sort()).toEqual(['vec4f(c,0.0)', 'vec4f(color*w,w)']);
    expect(fs).toMatch(/let\s+w\s*=\s*clamp\(\s*intensity\s*,\s*0\.0\s*,\s*1\.0\s*\)\s*;/);
    expect(fs).toMatch(/if\s*\(\s*blend\s*==\s*BLEND_MIX\s*\)\s*\{/);
    expect(fs).toMatch(/if\s*\(\s*blend\s*==\s*BLEND_SUB\s*\)\s*\{\s*c\s*=\s*-c\s*;/);
    // The add and sub arithmetic of before step 7: the over blend adds c whole.
    expect(fs).toMatch(/var\s+c\s*=\s*color\s*\*\s*intensity\s*;/);
    // The weight is the WHOLE intensity (decision 3: falloff × cone × shadow):
    // the mix branch comes after the last factor, never between two of them.
    expect(fs.indexOf('if (blend == BLEND_MIX)')).toBeGreaterThan(fs.lastIndexOf('intensity *='));
  });

  it('the blend field is read once, in fs_main, with the wire values of Rust and of the light list: a 3 blends like add', () => {
    const rust = readFileSync(new URL('../../../../crates/hyperion-core/src/components.rs', import.meta.url), 'utf8');
    const shift = Number(/pub const RENDER_META_LIGHT_BLEND_SHIFT: u32 = (\d+);/.exec(rust)?.[1]);
    const modes = new Map([.../pub enum LightBlendMode \{([^}]*)\}/.exec(rust)![1].matchAll(/(\w+)\s*=\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
    const code = stripComments(lightShaderSource);
    const ids = new Map([...code.matchAll(/const\s+([A-Z_]+)\s*:\s*u32\s*=\s*(\d+)u\s*;/g)].map((m) => [m[1], Number(m[2])]));
    expect(shift).toBe(14);
    expect(ids.get('LIGHT_BLEND_SHIFT')).toBe(shift);
    expect(ids.get('BLEND_SUB')).toBe(modes.get('Sub'));
    expect(ids.get('BLEND_MIX')).toBe(modes.get('Mix'));
    // The CPU list draws exactly what the shader mixes after everything else.
    expect(ids.get('BLEND_MIX')).toBe(BLEND_MIX);
    expect(code.match(/>>\s*LIGHT_BLEND_SHIFT/g)).toHaveLength(1);
    expect(body('fs_main')).toMatch(/let\s+blend\s*=\s*\(\s*renderMeta\[e \* 2u \+ 1u\]\s*>>\s*LIGHT_BLEND_SHIFT\s*\)\s*&\s*3u\s*;/);
    // Equality only: `>= BLEND_MIX` would mix a 3 that the list sorts with add.
    expect(code).not.toMatch(/[<>]=?\s*BLEND_(?:MIX|SUB)\b/);
  });

  it('the header no longer says mix is added like add', () => {
    // At HEAD the phrase breaks across two comment lines: "(added" / "// like `add`)".
    expect(lightShaderSource.slice(0, lightShaderSource.indexOf('struct LightUniform'))).not.toMatch(/added\s+(?:\/\/\s*)?like\s+`?add/);
    expect(lightShaderSource).toMatch(/Not yet: the `sprite` light type \(discarded\)\./);
  });
});
```
In `light-groups-pass.test.ts`, `setUp` e `groups` al posto di `:23-93` di HEAD (`:23-94` dopo il Task 2):
```ts
function setUp() {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { COPY_DST: 0x8, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100 };
  g.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
  g.GPUTextureUsage ??= { COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

  const textures: Tex[] = [];
  const buffers: Array<{ size: number; usage: number }> = [];
  const writes: Array<{ buffer: unknown; data: ArrayBuffer }> = [];
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => { const b = { size: d.size, usage: d.usage, destroy() {} }; buffers.push(b); return b; },
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: (d: GPURenderPipelineDescriptor) => ({ d }),
    createBindGroup: (d: GPUBindGroupDescriptor) => ({ entries: [...d.entries] }),
    createTexture: (desc: GPUTextureDescriptor) => {
      const t: Tex = { desc, destroyed: false, views: [] };
      textures.push(t);
      return {
        createView: (d?: GPUTextureViewDescriptor) => { const v: View = { tex: t, d }; t.views.push(v); return v; },
        destroy() { t.destroyed = true; },
      };
    },
    queue: {
      writeBuffer: (buffer: unknown, _o: number, data: ArrayBuffer | ArrayBufferView) => {
        writes.push({ buffer, data: data instanceof ArrayBuffer ? data.slice(0) : (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength) });
      },
      writeTexture() {},
    },
  } as unknown as GPUDevice;

  const pool = new ResourcePool();
  for (const name of ['entity-transforms', 'visible-indices', 'tex-indices', 'indirect-args', 'render-meta', 'prim-params']) {
    pool.setBuffer(name, {} as GPUBuffer);
  }
  for (const name of ['tier0', 'tier1', 'tier2', 'tier3', 'ovf0', 'ovf1', 'ovf2', 'ovf3']) {
    pool.setTextureView(name, { name } as unknown as GPUTextureView);
  }
  pool.setSampler('texSampler', {} as GPUSampler);

  const pass = new LightGroupsPass({ 0: OCCLUDER });
  pass.setup(device, pool);

  /** Render one frame. Returns the events: one per render pass (its target) or stage name. */
  const frame = (lightGroups: LightGroups | undefined, w = 128, h = 64, withStage = false) => {
    const f = { canvasWidth: w, canvasHeight: h, cameraViewProjection: new Float32Array(16), lightGroups } as unknown as FrameState;
    const events: Array<{ kind: 'pass'; target: View; sdf?: View; indexed: number[][]; indirect: number[] } | { kind: 'stage'; name: string }> = [];
    const encoder = {
      beginRenderPass: (desc: GPURenderPassDescriptor) => {
        const ev = {
          kind: 'pass' as const, target: [...desc.colorAttachments][0]!.view as unknown as View, sdf: undefined as View | undefined,
          indexed: [] as number[][], indirect: [] as number[],
        };
        events.push(ev);
        return {
          setPipeline() {}, setVertexBuffer() {}, setIndexBuffer() {}, draw() {}, end() {},
          drawIndexed: (...args: number[]) => { ev.indexed.push(args); },
          drawIndexedIndirect: (_b: GPUBuffer, offset: number) => { ev.indirect.push(offset); },
          setBindGroup: (_i: number, bg: { entries: GPUBindGroupEntry[] }) => {
            const sdf = bg.entries.find((e) => e.binding === 5);
            if (sdf) ev.sdf = sdf.resource as unknown as View;
          },
        };
      },
    } as unknown as GPUCommandEncoder;
    pass.prepare(device, f);
    pass.execute(encoder, f, pool, withStage ? (name: string) => { events.push({ kind: 'stage', name }); } : undefined);
    return events;
  };
  const label = (v: View) => `${v.tex.desc.label}${v.d?.baseArrayLayer !== undefined ? `#${v.d.baseArrayLayer}` : ''}`;
  const passes = (events: ReturnType<typeof frame>) =>
    events.filter((e): e is { kind: 'pass'; target: View; sdf?: View; indexed: number[][]; indirect: number[] } => e.kind === 'pass');
  /** LightAccumStage's light-list buffer: the only STORAGE buffer the node creates. */
  const listBuffer = () => buffers.filter((b) => (b.usage & GPUBufferUsage.STORAGE) !== 0).at(-1);
  return { pass, pool, textures, frame, label, passes, device, writes, listBuffer };
}

/** A frame's LightGroups; `lightOrder`: the light list's slots, in draw order. */
function groups(gs: Array<[number, number]>, sets: number[], lightOrder: number[] = []): LightGroups {
  return {
    groups: gs.map(([layers, sdfSet]) => ({ layers, sdfSet })),
    sdfSets: sets.map((occluderLayers) => ({ occluderLayers })),
    layerToGroup: [0, 0], multiBitReceiver: false, shadowedGlobalLight: false, lightMasks: [], occluderMasks: [],
    lightOrder: Uint32Array.from(lightOrder), lightIds: Uint32Array.from(lightOrder),
  };
}
```
e il fallback (`:153-159`) diventa questo, seguito dal test nuovo:
```ts
  it('without lightGroups, one group of every layer over one set of every caster, and no light (only tests come here)', () => {
    const { frame, label, passes } = setUp();
    const events = passes(frame(undefined));
    const got = events.map((e) => label(e.target));
    expect(got[0]).toBe('light-seed');
    expect(got.at(-1)).toBe('light-buffer#0');
    const accum = events.filter((e) => label(e.target).startsWith('light-buffer'));
    expect(accum).toHaveLength(1);
    // Cleared to the ambient, nothing drawn: neither a direct draw nor the
    // four indirect bucket draws of before step 7.
    expect(accum[0].indexed).toEqual([]);
    expect(accum[0].indirect).toEqual([]);
  });

  it("hands the frame's light list to every group: written once in prepare(), drawn whole into each layer", () => {
    const { frame, label, passes, writes, listBuffer } = setUp();
    const before = writes.length;
    const events = frame(groups([[1, 0], [2, -1], [4, 0]], [5], [8, 3, 6, 1]));
    const listWrites = writes.slice(before).filter((w) => w.buffer === listBuffer());
    expect(listWrites).toHaveLength(1);
    expect([...new Uint32Array(listWrites[0].data)]).toEqual([8, 3, 6, 1]);
    const accum = passes(events).filter((e) => label(e.target).startsWith('light-buffer'));
    expect(accum.map((e) => label(e.target))).toEqual(['light-buffer#0', 'light-buffer#2', 'light-buffer#1']);
    for (const e of accum) expect(e.indexed.map((a) => a.slice(0, 2)), label(e.target)).toEqual([[6, 4]]);
  });
```
- [ ] **Step 2: RED.** `npx --prefix ts vitest run --root ts src/render/passes/light-accum-stage.test.ts src/render/passes/light-groups-pass.test.ts`. Expected: nello stadio falliscono 15 test su 40, tutti i nuovi o riscritti, (1)-(14) e (6b); nel pass 2 su 11, il fallback (al codice del Task 2 lo stadio fa ancora quattro draw indirette) e la consegna.
- [ ] **Step 3: il codice**

`light-accum.wgsl`: `:1-4` diventano
```wgsl
// Light accumulation (Phase 17, Task 9; directional shadows: round 2026-09-27,
// step 6; one light list and the mix blend: step 7): the lights in view, drawn
// into the half-resolution light buffer in the order of the frame's light
// list. The buffer is cleared to the ambient light, and ForwardPass multiplies
// lit sprites by it.
//
// The list (lightOrder, built on the CPU by deriveLightGroups) holds every
// Light2D the cull's exact sphere test keeps: add and sub lights first, then
// mix lights, each class back to front by world z, then by external id (the
// higher id later, in front). ONE premultiplied "over" blend serves every blend
// mode: rgb + dst * (1 - a). An add or sub light returns alpha 0, so it adds
// (or takes away) its light, bit for bit as the additive blend did before step
// 7. A mix light returns (color * w, w), w its intensity: the buffer moves
// toward the light's colour, dst * (1 - w) + color * w.
```
`:20-21` ("Not yet: …") diventano la riga ``// Not yet: the `sprite` light type (discarded).``; il binding 2 (`:39`)
```wgsl
// The frame's light list, slots in draw order: instance i draws the i-th
// light. Written once per frame by LightAccumStage.prepare(); every group
// draws all of it (vs_main drops a light outside the group's layers).
@group(0) @binding(2) var<storage, read> lightOrder: array<u32>;
```
`const BLEND_SUB: u32 = 1u;` (`:54`)
```wgsl
// Blend modes, renderMeta bits 14-15 (LightBlendMode in components.rs,
// LIGHT_BLEND_IDS in entity-handle.ts, BLEND_MIX in light-groups.ts). 0 is
// add; the unclaimed 3 blends like add, here and in the light list, which
// draws BLEND_MIX, and only it, after the others.
const BLEND_SUB: u32 = 1u;
const BLEND_MIX: u32 = 2u;
```
in `vs_main` `:117` diventa `let e = lightOrder[instanceIdx];`; la coda di `fs_main` (`:358-363`)
```wgsl
    let blend = (renderMeta[e * 2u + 1u] >> LIGHT_BLEND_SHIFT) & 3u;
    if (blend == BLEND_MIX) {
        // Toward the light's colour by its intensity: dst * (1 - w) + color * w
        // under the over blend. w is in [0, 1] by construction (falloff, cone
        // and shadow each are); the clamp keeps a pow that overshoots 1 from
        // turning the blend into an extrapolation.
        let w = clamp(intensity, 0.0, 1.0);
        return vec4f(color * w, w);
    }
    var c = color * intensity;
    if (blend == BLEND_SUB) {
        c = -c;
    }
    // Alpha 0: the over blend keeps dst whole and adds c, as {one, one} did.
    return vec4f(c, 0.0);
```

`light-accum-stage.ts`: via l'import di `cull-pass` (`:5`) e `const add` (`:122`). `:8-17` diventano
```ts
/**
 * The one blend state of the light pipeline (round step 7): premultiplied
 * "over" on colour, rgb + dst·(1 − a). light-accum.wgsl returns alpha 0 for an
 * add or sub light, which keeps dst whole, dst + c: what {one, one} gave, bit
 * for bit. A mix light returns (color·w, w): dst·(1 − w) + color·w. The alpha
 * component keeps dst's alpha, the clear's 1, whatever a light returns; nobody
 * reads it (the prelude's applyLighting samples rgb).
 */
export const LIGHT_BLEND: GPUBlendState = {
  color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
};

/** The light list buffer's first capacity, in lights (256 bytes); it grows to the next power of two. */
export const MIN_LIGHT_ORDER_CAPACITY = 64;
```
il doc della classe (`:56-72`)
```ts
/**
 * Accumulates the lights of ONE light group into one layer of the light buffer
 * (Phase 17; light layers, design 2026-09-26). A stage of LightGroupsPass, not
 * a graph node. The target is `halfResolution`, the SDF's texels, in
 * `SCENE_HDR_FORMAT`, cleared to the ambient light.
 *
 * Since round step 7 it draws the frame's light list (`deriveLightGroups`)
 * through ONE pipeline with a premultiplied "over" blend (LIGHT_BLEND), in ONE
 * direct instanced draw per group: instance i is the list's i-th light, so
 * neither the cull's order nor `indirect-first-instance` reaches the lights.
 * The vertex stage drops a light whose mask misses the group's layers; see
 * light-accum.wgsl for the shapes, the shadows and the blend modes. The
 * uniform slices and the list are written once, in `prepare()`: a writeBuffer
 * between the passes of one frame would land only with its last write. The
 * list's buffer is this stage's own: an HMR probe runs setup() then destroy().
 */
```
i campi `indirectBuffer` e `columns` (`:85-86`)
```ts
  /** The light list, `light-order`: grow-only, written once per frame in prepare(). */
  private orderBuffer: GPUBuffer | null = null;
  private orderCapacity = 0;
  /** This frame's list length, set by every prepare(): a frame never draws an earlier one's list. */
  private lightCount = 0;
  /** The pool's columns, by binding: transforms (1), primParams (3), renderMeta (4). */
  private columns: Array<[number, GPUBuffer]> = [];
```
in `setup`, le colonne e `indirect-args` (`:102-107`)
```ts
    const columns: Array<[number, string]> = [[1, 'entity-transforms'], [3, 'prim-params'], [4, 'render-meta']];
    this.columns = columns.map(([binding, name]) => {
      const buffer = resources.getBuffer(name);
      if (!buffer) throw new Error(`LightAccumStage.setup: missing '${name}' in ResourcePool`);
      return [binding, buffer];
    });
    // Created now, so that every bind group is valid from the first frame,
    // an empty list included.
    this.orderCapacity = MIN_LIGHT_ORDER_CAPACITY;
    this.orderBuffer = device.createBuffer({
      size: this.orderCapacity * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'light-order',
    });
```
la voce del binding 2 (`:114`)
```ts
        // The light list, read by vs_main only. 4 bytes: one u32, the least an array<u32> binds.
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage', minBindingSize: 4 } },
```
la riga `fragment` (`:130`)
```ts
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: SCENE_HDR_FORMAT, blend: LIGHT_BLEND }] },
```
doc e firma di `prepare` (`:135-136`)
```ts
  /**
   * One uniform slice per group and the frame's light list, each written in
   * one call. Both buffers grow, never shrink, and a growth drops the cached
   * bind groups. `lightOrder`: `LightGroups.lightOrder`, slots in draw order.
   */
  prepare(device: GPUDevice, frame: FrameState, groups: readonly LightGroup[], lightOrder: Uint32Array<ArrayBuffer>): void {
```
dopo `device.queue.writeBuffer(this.uniformBuffer, 0, data);` (`:157`)
```ts

    this.lightCount = lightOrder.length;
    if (!this.orderBuffer || lightOrder.length > this.orderCapacity) {
      let capacity = Math.max(this.orderCapacity, MIN_LIGHT_ORDER_CAPACITY);
      while (capacity < lightOrder.length) capacity *= 2;
      this.orderBuffer?.destroy();
      this.orderBuffer = device.createBuffer({
        size: capacity * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        label: 'light-order',
      });
      this.orderCapacity = capacity;
      this.bindGroups.clear();
    }
    if (lightOrder.length > 0) device.queue.writeBuffer(this.orderBuffer, 0, lightOrder);
```
in `encode`, il doc (`:160`) diventa "Clear `target` to the ambient light, then draw the frame's light list into group `g`, shadowed by `sdf`.", la guardia (`:162`) perde `|| !this.indirectBuffer`, e il ciclo delle draw indirette (`:178`) diventa
```ts
    // Instance i is the list's i-th light, firstInstance 0 (no
    // indirect-first-instance). WebGPU blends in primitive order: the list's
    // order is the blend order.
    if (this.lightCount > 0) pass.drawIndexed(6, this.lightCount, 0, 0, 0);
```
in `bindGroupFor` la guardia (`:183`) prende `|| !this.orderBuffer` prima di `|| g >= this.slices`, e la riga delle colonne (`:190`) diventa
```ts
        ...this.columns.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
        { binding: 2, resource: { buffer: this.orderBuffer } },
```
in `destroy`, `this.orderBuffer?.destroy();` dopo `:201`; `this.orderBuffer = null;`, `this.orderCapacity = 0;` e `this.lightCount = 0;` dopo `:204`; via `this.indirectBuffer = null;` (`:210`).

`light-groups-pass.ts`: nel doc di `EVERYTHING`, `:11-12` diventano
```ts
 * group of every layer, one set of every caster, and NO light: the light list
 * is born in deriveLightGroups' scan (round step 7). The renderer gives every
 * frame of a lit graph its groups, so only tests come here.
```
e `:98` diventa `this.accum.prepare(device, frame, lg.groups, lg.lightOrder);`.

Applicate a HEAD, queste modifiche danno stadio e shader identici, riga per riga, a quelli dello specchio della stesura.
- [ ] **Step 4: GREEN, naga, tipi, node.** `npx --prefix ts vitest run --root ts src/render/passes/light-accum-stage.test.ts src/render/passes/light-groups-pass.test.ts src/shaders/uniform-layout.test.ts src/render/light-groups.test.ts`; naga su `light-accum.wgsl` (il comando dei Vincoli globali); `tsc`; `npm --prefix ts test`; poi i tre `node:test`, perché `march-model.test.mjs` legge `light-accum.wgsl` (`:51`, `:59`), che questo task riscrive, e `preflight.sh` non li esegue: `node --test docs/plans/assets/2026-10-08-step7/step7-stats.test.mjs docs/plans/assets/2026-09-30-step6/step6-stats.test.mjs docs/plans/assets/2026-09-30-step6/march-model.test.mjs`. Expected: 40/40, 11/11, 31/31 e 45/45; naga `ok   light-accum.wgsl` e `1/1 valid (naga)`; nessun errore di tipo; 114 file, 2067 + 7 saltati; i `node:test` senza fallimenti.
- [ ] **Step 4b: la prova che i test mordono** (solo nel working tree, una mutazione alla volta, poi i due file dello Step 2; alla fine rimetti il codice e verifica il verde). Ogni mutante deve far fallire esattamente questi test (misurati nello specchio):
  - niente `this.bindGroups.clear()` quando il buffer della lista cresce → (7);
  - `lightCount` assegnato solo per una lista non vuota (`if (lightOrder.length > 0) { this.lightCount = lightOrder.length; device.queue.writeBuffer(this.orderBuffer, 0, lightOrder); }`, senza l'assegnazione di prima) → (4);
  - la lista scritta in `encode()` invece che in `prepare()` → (5) e il test della consegna del pass;
  - la crescita alla lunghezza esatta (`capacity = Math.max(capacity, lightOrder.length);` al posto del ciclo) → (7); nessuna crescita (`if (!this.orderBuffer) {`) → (7);
  - `vs_main` che legge ancora `visibleIndices[instanceIdx]`, col binding 2 dichiarato di nuovo `visibleIndices` → (11);
  - `if (blend >= BLEND_MIX)` nello shader → (12) e (13);
  - l'ombra del sole spostata sotto il ramo mix (un mix che ignora la sua ombra: il `} else if (kind == DIRECTIONAL …)` tolto da lì e rimesso, come `if`, prima di `var c`) → (12) e il test del passo 6 'the shadow gate: slot 7 is read once…'.
- [ ] **Step 5: cancello GPU rapido (Mac, Mode B e C), prima del Task 4.** Nessun test headless vede se lo shader compila su Metal, se la pipeline valida, cosa disegna, e se il buffer della lista sopravvive alla sua crescita.
  1. `$SDD/tools/gpu/gate-task3.js`, un `async () => { … }`: importa `LightAccumStage`, `ResourcePool` e `createGpuValidation` dai moduli dell'app (`/src/render/passes/light-accum-stage.ts`, `/src/render/resource-pool.ts`, `/src/render/graph-host.ts`; `createGpuValidation` è pura, e una sua seconda istanza non fa danni); lancia se `LightAccumStage.SHADER_SOURCE` è vuoto (una seconda istanza del modulo: riavviare il dev server); su un device suo (`requestAdapter()` + `requestDevice()`, distrutto in un `finally`) fa `getCompilationInfo()` del sorgente, mette in un `ResourcePool` tre buffer STORAGE da 256 B (`entity-transforms`, `prim-params`, `render-meta`), crea `const stage = new LightAccumStage()` e chiama `const pipelineErrors = await createGpuValidation(device).run(() => stage.setup(device, pool));`, poi `stage.destroy()`. È la validazione con cui il motore accetta un grafo (`graph-host.ts:20-51`): le error scope internal, out-of-memory e validation, poppate tutte e tre anche se `setup` lancia. Una sola scope `validation` non vedrebbe un errore interno, come una compilazione MSL fallita, cioè proprio la classe di errore di Metal per cui c'è questo cancello. Restituisce `{ gate: 'step7-task3', head, date, mode, search, adapter, chrome, userAgent, stepSevenShader (c'è lightOrder e non visibleIndices), messages, pipelineErrors }`, con `head` da `window.__harnessMeta` e gli altri metadati come quelli del banco.
  2. Caffeinate avviato; dev server riavviato, asset server attivo; `"http://localhost:5173/?mode=B&bench"` con `ignoreCache` e l'`initScript`; `resize_page` a 1200×689 CSS (dpr 2: con a = 1,57 il punto del pavimento di `scene` cade nella tela); `window.__harnessMeta = { head, adapterLine }`; riga dell'adapter.
  3. `gate-task3.js` con `filePath` = `<repo>/docs/plans/assets/2026-10-08-step7/gate-m2.json`. Expected: `stepSevenShader` true, `messages` vuoto, `pipelineErrors` `[]`.
  4. `load-bench.js`; `scene` fase 1 e fase 2 (`label: '<sha>'`), l'ultima con `filePath` = `…/gate-m2-scene.json`. Expected: `maxDiff` ≤ 0,002 in entrambe; `measured.overlap` = P `[1, 0.25, 0.25]` in fase 1 e Q `[0.25, 0.25, 1]` in fase 2; `measured.mIn` = M `[1, 0.5, 0.25]` (un `mix` a intensità piena).
  5. `grow` (`filePath` = `…/gate-m2-grow-B.json`), poi su una pagina `"http://localhost:5173/?mode=C&bench"` aperta allo stesso modo `load-bench.js` e `grow` → `gate-m2-grow-C.json`. Expected: `worstUlps` ≤ 1 in tutte e due le letture, `lightOrder.length` 100 e poi 40.
  6. Console: solo il 404 di `favicon.ico`. Un altro esito ferma il task (`superpowers:systematic-debugging`).
- [ ] **Step 6: commit** dei cinque file e dei quattro JSON: `feat(7): una sola pipeline «over» premoltiplicata e una draw diretta per gruppo sulla lista delle luci; il blend mix`.

### Task 4: l'avviso di `indirect-first-instance` e il JSDoc dell'API

L'avviso di un device senza la feature dice ancora "every transparent entity is missing": falso dal 5b (la draw uber ha firstInstance 0), e dal Task 3 anche per le luci. Il JSDoc descrive il blend come solo additivo, e tace su ordine e near/far.

**Files:** `ts/src/capabilities.ts` (`:248-250`) e `.test.ts` (dopo `:327`); `ts/src/entity-handle.ts` (`:27-31`, `:48-52`, `:65`, `:77`, `:105`, `:135`, `:346-348`, `:357-360`, `:581-583`, dopo `:587`); `ts/src/lighting-api.ts` (`:87`, dopo `:126`, `:167-172`). **Interfaces:** nessuna nuova.

- [ ] **Step 1: il test che fallisce.** In `capabilities.test.ts`, nel test 'warns on a device without it, naming the feature and what goes missing', dopo `:327`:
```ts
    // Lights (one direct draw per group, round step 7) and transparent
    // entities (the uber draw, phase 5b) draw from firstInstance 0.
    expect(warning).toMatch(/Lights and transparent entities still draw/);
    expect(warning).not.toMatch(/every transparent entity is missing/i);
```
- [ ] **Step 2: RED.** `npx --prefix ts vitest run --root ts src/capabilities.test.ts`: FAIL in quel test solo.
- [ ] **Step 3: l'avviso.** `capabilities.ts:248-250` diventano:
```ts
  return "[Hyperion] The GPU device lacks 'indirect-first-instance': indirect draws with a non-zero "
    + 'firstInstance are no-ops, so only opaque quads on texture tier 0 (untextured ones included) render among '
    + 'the opaque entities, and only they cast shadows or get an outline. Lights and transparent entities still draw.';
```
Run: PASS, 32/32. Commit `fix(7): l'avviso di indirect-first-instance dice che luci e trasparenti si disegnano anche senza la feature` (`git add ts/src/capabilities.ts ts/src/capabilities.test.ts`).
- [ ] **Step 4: il JSDoc** (inglese; nessun comportamento cambia: lo verificano sulla GPU i check del Task 5).

`entity-handle.ts`:
1. `RenderPrimitiveType.Light2D` (`:27-31`):
```ts
  /**
   * A 2D light. The one primitive type the ForwardPass never draws — no shader
   * is registered for it, so the per-type pipeline loop never finds it.
   * `LightAccumStage` (inside LightGroupsPass) draws every light in view from
   * the frame's light list, which `deriveLightGroups` builds on the CPU (round
   * step 7), not from the cull's buckets.
   */
```
2. il punto `global` di `LightType` (`:48-52`):
```ts
 * - `global`: a uniform light over the layers in its mask, combined with
 *   `engine.lighting.setAmbient()` by its blend mode: added on top of it by
 *   default (a masked one is a per-layer ambient), while with blend `'mix'`
 *   it sets its layers to its `color` × `energy` (as half float, over a
 *   finite buffer: see {@link LightBlendMode} for a texel that is not),
 *   replacing the ambient and every `add` or `sub` light there. No position,
 *   no direction and no shadows in the lit backend: `shadowIntensity` is
 *   ignored (the renderer warns once in dev builds). Use `directional` for a
 *   sun.
```
3. `LightBlendMode` (`:65`):
```ts
/**
 * How a light combines into the light buffer of its layers, which every frame
 * starts at the ambient light (`engine.lighting.setAmbient()`). With `c` the
 * light's `color` × `energy` and `w` its intensity at a pixel (falloff × spot
 * cone × shadow, from 0 to 1; 1 for a global light):
 * - `add` (the default): buffer + c·w.
 * - `sub`: buffer − c·w. Nothing clamps the buffer at 0: where `sub` lights
 *   take more than there is, it goes negative (a lit sprite shows 0 in those
 *   channels), and a `mix` light drawn later starts from that negative value.
 * - `mix`: buffer·(1 − w) + c·w, toward the light's colour by its intensity.
 *   Where `w` is 1 the buffer becomes exactly `c` (as half float) over a
 *   finite buffer: the light replaces the ambient and every `add` or `sub`
 *   light under it. A texel that already holds a NaN, or an infinity (an
 *   `add` light or a sum of lights past half-float range, 65504, on hardware
 *   that rounds to infinity), gives c + dst·0 = NaN: a mix does not clear it.
 *   `energy` scales the colour it moves toward, not how far it moves.
 *
 * The order (round step 7): every `add` and `sub` light first, then every
 * `mix` light; within each class back to front by world z (a root 2D light's
 * z is −{@link EntityHandle.depth}, so the larger depth first, and a child's
 * is its world z, its depth composed with its parents'; a root 3D light's is
 * its `position()` z, a child's its world z), then by external id, the higher
 * id last, so on top (the newest light only while ids are fresh, as for
 * transparent sprites). `add` and `sub` lights commute up to rounding in the
 * half-float buffer (a step or two where several overlap): the order decides
 * which `mix` light ends on top. It
 * comes from the ECS state alone, never from the GPU's culling, so a still
 * scene lights the same from frame to frame.
 */
```
4. `LIGHT_BLEND_IDS` (`:77`):
```ts
/**
 * Wire values for `renderMeta` bits 14-15. 3 is unclaimed: Rust keeps it as
 * sent, and the light list and `light-accum.wgsl` sort and draw it like `add`.
 */
```
5. `LightOptions.range`, punto `point`/`spot` (`:105`):
```ts
   * - `point`, `spot`: the light's radius, which is also its culling radius:
   *   a light whose z is more than `range` outside the camera's near-far span
   *   lights nothing (see {@link EntityHandle.light}).
```
6. `LightOptions.blend` (`:135`):
```ts
  /** How the light combines into its layers' light buffer, and when it is drawn: see {@link LightBlendMode}. Default `'add'`. */
```
7. `depth()`, le ultime righe del doc (`:346-348`):
```ts
   * one. Give sprites different depths to order them. On a 2D light it orders
   * the light list (round step 7): within a blend class the larger depth is
   * drawn first and the smaller one on top, the higher id at equal depths (see
   * {@link LightBlendMode}); a point or spot light whose world depth (its own,
   * composed with its parents' for a child) is outside −1 − range to
   * 1000 + range (the default camera) is culled and lights nothing. On a 3D
   * entity, which takes its z from `position()`, it is ignored (a warning in
   * dev builds). Returns `this`.
   */
```
8. `transparent()` (`:357-360`):
```ts
   * Mark entity as transparent: alpha-blended, drawn after the opaque ones,
   * with no depth write, back to front by world z (at equal z the higher id
   * is in front). On a light it changes nothing on screen: every light is
   * drawn from one list, in the order of {@link LightBlendMode} (round step
   * 7). Returns `this`.
   */
```
9. `light()`, dopo la riga vuota che segue "Aim a spot or a sun with `rotation()` (see {@link LightType})." (`:586-587`):
```ts
   * Lights are drawn in one fixed order, described at {@link LightBlendMode}:
   * `add` and `sub` first, then `mix`, each back to front by world z, then by
   * id. A light's z orders and culls it, and never moves what it lights: a
   * root 2D light's z is −{@link EntityHandle.depth}, a child's its world z
   * (its depth composed with its parents'); a root 3D light's is the z of
   * `position()`, a child's its world z. Like any entity, a point or spot
   * light is culled, and lights nothing, when that world z is more than
   * `range` outside the camera's near-far span: with the default camera a 2D
   * light's world depth must stay within [−1 − range, 1000 + range], a 3D
   * light's world z within [−1000 − range, 1 + range]. Global and directional
   * lights are never culled.
   *
```
10. `light()`, `:581-583` (lo «GPU frustum culling» di `:582` non vale più per le luci, che il cull archivia ma nessuno disegna dai suoi bucket):
```ts
   * A light is an ordinary ECS entity, so it inherits position, hierarchy
   * (a torch parented to a character), spawn/despawn, frustum culling (for a
   * light, the cull's test, run on the CPU by the light list, round step 7),
   * snapshot and replay for free — which is why a point or spot light's
```

`lighting-api.ts`:
1. `deterministic`, `:87` diventa:
```ts
   * the `gi` backend, so it changes nothing yet. The lit backend needs none of
   * the three, and no flag: on one device its light buffer is a function of
   * the frame's state, every light drawn in one fixed order (round step 7).
```
2. nel doc di `groups`, dopo la riga vuota che chiude il paragrafo di `shadowedGlobalLight` (`:126`):
```ts
   * It carries the frame's light list too (round step 7): `lightOrder`, the
   * slots of the lights the cull keeps, in the order they are drawn, and
   * `lightIds`, their external ids (the order is described at
   * `LightBlendMode`).
   *
```
3. `setAmbient`, `:167-172`:
```ts
   * The engine's ambient light: the clear colour of every light group's light
   * buffer, the base every lit surface receives before the light entities
   * combine into it — an `add` light adds to it, a `sub` light takes from it,
   * a `mix` light moves it toward its own colour (`LightBlendMode`). Not a
   * `global` light, which is an entity drawn on top of it and limited to its
   * layers (a per-layer ambient). Unlike every other light in the scene it is
   * genuinely free: the clear happens anyway.
```

I limiti near/far del JSDoc sono quelli della camera di default, fissati dal test 11 del Task 2 e misurati sulla GPU dal check 'Light list…' del Task 5; valgono per la z di mondo composta, quella della riga (`write_world_matrix`, `render_state.rs:631-634`, `:709-713`), che per un figlio comprende il genitore. Il "front-to-back sorting" di `opaque()` (`:367`) è una deriva preesistente: va nella lista del passo 9 (Task 10).
- [ ] **Step 5: verifica e commit.** `npx --prefix ts vitest run --root ts src/entity-handle.test.ts src/lighting-api.test.ts src/capabilities.test.ts` (91, 24, 32) e `tsc`; poi `git add ts/src/entity-handle.ts ts/src/lighting-api.ts` e commit `docs(7): JSDoc dei tre blend, dell'ordine delle luci e del cull near/far; transparent() non sposta più una luce`.

### Task 5: i check dell'harness (tab Lighting)

**Files:**
- Modify: `ts/src/demo/blend-expect.ts` (dopo `:76`) e `.test.ts` (`:2`, dopo `:101`)
- Create: `ts/src/demo/lighting-mix.ts`, `ts/src/demo/lighting-mix.test.ts`
- Modify: `ts/src/demo/lighting.ts` (`:7`, `:52`, dopo `:174`)
- Create: `docs/plans/assets/2026-10-08-step7/harness-task5-{B,C}.json` (Step 6)

**Interfaces:**
- `blend-expect.ts`: `type LightBlend`; `interface ExpectedLight { blend; depth; id; color: Rgb; weight }`; `lightLayer(light): Layer`; `lightsBackToFront<T extends { blend: LightBlend; depth: number; id: number }>(lights: readonly T[]): T[]` (con un `T` libero il corpo non potrebbe leggere `blend`, `depth` e `id`: TS2339), l'oracolo dei test, scritto a parte dal comparatore del motore; `expectedLight(base, lights): Rgb`.
- `lighting-mix.ts`: le costanti della sotto-scena; `fp16Ulp`, `pointWeight`, `lightTexelCentre`; `mixReplacesVerdict(reads: MixReads, floor, target)`, `mixOrderVerdict(before: OrderRead[], after: OrderRead, floor)`, `listVerdict(reads: ListReads, floor, target)`, ciascuno `{ ok, detail }`; `checkMix(engine, reporter, entities, floor: Rgb, restoreView: () => void): Promise<void>`; i check 'Mix light replaces the light buffer', 'Mix order follows depth', 'Light list: exact cull, id at equal depth'. I tipi e le firme esportate, su cui i test dello Step 3 costruiscono le loro fixture:
```ts
// ts/src/demo/lighting-mix.ts: the types and the exported signatures (.d.ts
// form) that lighting-mix.test.ts builds its fixtures against. The bodies are
// described below; Rgb is blend-expect's, Rgba probe-checks'.

/** A check's verdict: the values read, then each cause found, separated by `; `. */
interface Verdict { ok: boolean; detail: string }

export const MIX_SCENE: [number, number];   // [0, -200]
export const M_TARGET: Rgb;                  // [2, 1, 0.5]: M's colour × energy
export const P_COLOR: Rgb;                   // [1, 0.25, 0.25]
export const Q_COLOR: Rgb;                   // [0.25, 0.25, 1]
export const R_COLOR: Rgb;                   // [0, 0.5, 0]
export const POINTS: {                       // from MIX_SCENE
  mIn: readonly [number, number]; floor: readonly [number, number]; away: readonly [number, number];
  pOnly: readonly [number, number]; overlap: readonly [number, number]; qOnly: readonly [number, number];
  rOnly: readonly [number, number];
};
export const ORDER_READS: number;            // 10

export function fp16Ulp(v: number): number;
export function pointWeight(at: readonly [number, number], centre: readonly [number, number], range: number, falloff: number): number;
export function lightTexelCentre(world: readonly [number, number], vp: Float32Array, size: readonly [number, number]): [number, number];

/** What 'Mix light replaces the light buffer' read. */
export interface MixReads {
  /** M_IN with M a point mix light of falloff 0 (weight 1). */
  full: Rgba;
  /** FLOOR, in the same read: the ambient plus the tab's global light. */
  floor: Rgba;
  /** With falloff 1: each point at its texel centre and M's weight there, and FLOOR in the same read. */
  partial: Array<{ read: Rgba; w: number }>;
  partialFloor: Rgba;
  /** M turned global, still mix: FLOOR, M_IN and AWAY, where no other light of the sub-scene reaches. */
  global: Rgba[];
}

/** One read of the order check. */
export interface OrderRead {
  pOnly: Rgba;
  overlap: Rgba;
  qOnly: Rgba;
  rOnly: Rgba;
  floor: Rgba;
}

/** What 'Light list: exact cull, id at equal depth' read. */
export interface ListReads {
  /** M_IN with M just inside its listed limit, then just outside it. */
  inside: Rgba;
  outside: Rgba;
  /** OVERLAP with P and Q at equal depths after M's despawn, and their slots and ids in that frame. */
  overlap: Rgba;
  slots: { p: number; q: number };
  ids: { p: number; q: number };
}

export function mixReplacesVerdict(reads: MixReads, floor: Rgb, target: Rgb): Verdict;
export function mixOrderVerdict(before: readonly OrderRead[], after: OrderRead, floor: Rgb): Verdict;
export function listVerdict(reads: ListReads, floor: Rgb, target: Rgb): Verdict;
export function checkMix(engine: Hyperion, reporter: TestReporter, entities: EntityHandle[], floor: Rgb, restoreView: () => void): Promise<void>;
```
- Consumes: `pixelCheck`, `fmt`, `fitView`, `frames`, `Rgba` (`probe-checks.ts`); `halfResolution` (`occluder-seed-stage.ts`).
- Il tab passa da 9 a 12 check, l'harness da 60 a 63.

**Id delle entità.** Le 5 entità della sotto-scena prendono id freschi: i tab dopo Lighting (Debug Tools, Lifecycle, 2D Twins) hanno id più alti di 5 rispetto alla base del passo 6 (`docs/plans/assets/2026-09-30-step6/baseline/`), di 10 rispetto a `run1` di M4. È la scelta del passo 6, che il suo piano aveva previsto per i passi 7-8: il cancello M4 si ricattura al Task 9 in `docs/plans/assets/2026-10-08-step7/baseline/`; la base AMD del 5b alla prossima sessione Fedora.

- [ ] **Step 1: `blend-expect` (RED).** L'import di `blend-expect.test.ts` (`:2`) prende `lightLayer`, `lightsBackToFront`, `expectedLight`; in fondo, 5 test, con `below = [0.2, 0.4, 0.6]`:
  1. `over(below, lightLayer({blend: 'add', color: [1, 1, 0], weight: 0.5}))` = [0.7, 0.9, 0.6], e con `'sub'` [−0.3, −0.1, 0.6], per canale con `toBeCloseTo(v, 12)` come i test di `:9` (in JS 0,4 − 0,5 fa −0,09999999999999998; i test 2 e 5, esatti, restano `toEqual`);
  2. `lightLayer` mix a 0,25 = `straight([2, 1, 0.5], 0.25)`; a peso 1 `over` dà [2, 1, 0.5], a peso 0 `below`;
  3. `lightsBackToFront` su mix depth 5 id 1, add depth 0 id 9, sub depth 1 id 2 → id [2, 9, 1];
  4. tre mix (depth 1 id 4, depth 2 id 8, depth 1 id 3) → [8, 3, 4], e l'input resta [4, 8, 3];
  5. `expectedLight([0.2, 0.2, 0.3], [add depth 0,5 id 3 (0, 0,5, 0) peso 1, mix depth 1 id 4 (1, 0,25, 0,25) peso 1])` = [1, 0.25, 0.25].

  Il codice (in fondo al file):
```ts
// ── Lights (round step 7): LightAccumStage's premultiplied "over" blend ──────

describe('lightLayer: what one light does to the light buffer at weight w', () => {
  const below: Rgb = [0.2, 0.4, 0.6];

  it('add keeps what is below and adds colour × w; sub takes it away', () => {
    [0.7, 0.9, 0.6].forEach((v, c) => expect(over(below, lightLayer({ blend: 'add', color: [1, 1, 0], weight: 0.5 }))[c]).toBeCloseTo(v, 12));
    [-0.3, -0.1, 0.6].forEach((v, c) => expect(over(below, lightLayer({ blend: 'sub', color: [1, 1, 0], weight: 0.5 }))[c]).toBeCloseTo(v, 12));
  });

  it('mix at weight w is straight(colour, w): below · (1 − w) + colour · w, the colour itself at w = 1', () => {
    expect(lightLayer({ blend: 'mix', color: [2, 1, 0.5], weight: 0.25 })).toEqual(straight([2, 1, 0.5], 0.25));
    expect(over(below, lightLayer({ blend: 'mix', color: [2, 1, 0.5], weight: 1 }))).toEqual([2, 1, 0.5]);
    expect(over(below, lightLayer({ blend: 'mix', color: [2, 1, 0.5], weight: 0 }))).toEqual(below);
  });
});

describe('lightsBackToFront: the light list order', () => {
  it('add and sub before mix, whatever their depth or id', () => {
    const lights = [
      { blend: 'mix' as const, depth: 5, id: 1 }, { blend: 'add' as const, depth: 0, id: 9 }, { blend: 'sub' as const, depth: 1, id: 2 },
    ];
    expect(lightsBackToFront(lights).map((l) => l.id)).toEqual([2, 9, 1]);
  });

  it('within a class the larger depth first, then the higher id last; the input is not reordered', () => {
    const lights = [
      { blend: 'mix' as const, depth: 1, id: 4 }, { blend: 'mix' as const, depth: 2, id: 8 }, { blend: 'mix' as const, depth: 1, id: 3 },
    ];
    expect(lightsBackToFront(lights).map((l) => l.id)).toEqual([8, 3, 4]);
    expect(lights.map((l) => l.id)).toEqual([4, 8, 3]);
  });
});

describe('expectedLight', () => {
  it('a full-weight mix light covers an add light nearer than it: the class comes before the depth', () => {
    const floor: Rgb = [0.2, 0.2, 0.3];
    const got = expectedLight(floor, [
      { blend: 'add', depth: 0.5, id: 3, color: [0, 0.5, 0], weight: 1 },
      { blend: 'mix', depth: 1, id: 4, color: [1, 0.25, 0.25], weight: 1 },
    ]);
    expect(got).toEqual([1, 0.25, 0.25]);
  });
});
```
  Run `npx --prefix ts vitest run --root ts src/demo/blend-expect.test.ts`: FAIL nei 5 nuovi, i 14 di HEAD passano.
- [ ] **Step 2: `blend-expect` (GREEN).** In fondo a `blend-expect.ts`, sotto un titolo `// ── Lights (round step 7) ──` che spiega l'«over» premoltiplicato dello stadio: `export type LightBlend = 'add' | 'sub' | 'mix'`; `ExpectedLight` (`blend`, `depth` di una luce 2D, `id`, `color` = colore × energia, `weight`); `lightLayer(light)` = `straight(color, weight)` per `mix`, altrimenti `{ keep: [1, 1, 1], add: color · (±weight) }` (meno per `sub`); `lightsBackToFront(lights)` ordina una copia per (mix ? 1 : 0), depth decrescente, id crescente; `expectedLight(base, lights)` = `composite(base, lightsBackToFront(lights).map(lightLayer))`:
```ts
// ── Lights (round step 7) ────────────────────────────────────────────────────
// LightAccumStage blends every light with ONE premultiplied "over":
// rgb + dst · (1 − a). An add light returns (c·w, 0), a sub one (−c·w, 0), a
// mix one (c·w, w), c its colour × energy and w its weight (its intensity) at
// the texel. The light list draws add and sub before mix, then back to front.

/** A light's blend mode, as LightBlendMode in entity-handle.ts. */
export type LightBlend = 'add' | 'sub' | 'mix';

/** A light as the light list orders it, and its colour × energy and weight at one texel. */
export interface ExpectedLight {
  readonly blend: LightBlend;
  /** A root 2D light's depth: its world z is -depth (a child's composes its parents'). */
  readonly depth: number;
  readonly id: number;
  readonly color: Rgb;
  readonly weight: number;
}

/** What one light does to the light buffer: add and sub keep it and add ±c·w, mix is straight(c, w). */
export function lightLayer(light: Pick<ExpectedLight, 'blend' | 'color' | 'weight'>): Layer {
  if (light.blend === 'mix') return straight(light.color, light.weight);
  const s = light.blend === 'sub' ? -light.weight : light.weight;
  return { keep: [1, 1, 1], add: [light.color[0] * s, light.color[1] * s, light.color[2] * s] };
}

/**
 * The light list's order, written apart from the engine's comparator
 * (render/light-groups.ts) so that a wrong key there cannot pass here too: add
 * and sub before mix, then the larger depth first (back to front), then the
 * higher id last.
 */
export function lightsBackToFront<T extends { blend: LightBlend; depth: number; id: number }>(lights: readonly T[]): T[] {
  const cls = (l: T): number => (l.blend === 'mix' ? 1 : 0);
  return [...lights].sort((a, b) => (cls(a) - cls(b)) || (b.depth - a.depth) || (a.id - b.id));
}

/** The light buffer where `lights` reach, over `base` (the ambient and every light not listed). */
export function expectedLight(base: Rgb, lights: readonly ExpectedLight[]): Rgb {
  return composite(base, lightsBackToFront(lights).map(lightLayer));
}
```
  Run `npx --prefix ts vitest run --root ts src/demo/blend-expect.test.ts`: 19/19.
- [ ] **Step 3: `lighting-mix.test.ts` (RED).** Con `F = [0.185, 0.17, 0.295]` (il floor del tab: ambient + la sua global):
  - `fp16Ulp(1)` = 2⁻¹⁰, `(2)` = 2⁻⁹, `(0.5)` = 2⁻¹¹, `(−1.5)` = 2⁻¹⁰, `(0)` = 2⁻²⁴; `pointWeight` = 0,75 a d 1 di 4 (falloff 1), 0,25 a d 2 (falloff 2), 1 a d 3,9 con falloff 0, 0 a d = range; `lightTexelCentre` (vista 16:9, 960×540) sta entro mezzo texel dal punto ed è un punto fisso;
  - `mixReplacesVerdict`: passa con bersaglio a peso 1, `straight` ai pesi 0,75 e 0,5 e la fase global al bersaglio (dettaglio con '0.0 fp16 ULP from 2.000, 1.000, 0.500'); a peso 1 nomina, uno solo per volta, 'the mix light is added like add' (F + bersaglio), 'the mix light is not drawn' (F), 'the target is clamped at 1' ([1, 1, 0.5]); ai pesi parziali 'the weight is ignored', 'added like add', 'not premultiplied'; una global sommata → 'does not bring its whole layer to its target';
  - `mixOrderVerdict`: P su 10 letture e Q dopo lo scambio passa ('overlap P over 10 reads with P nearer, Q after the swap'); nomina, uno per volta, 'the order is reversed' (Q poi P), 'follows the ids or the slots' (Q poi Q), 'P stays on top' (P poi P); R sopra P e Q → 'R is drawn after the mix lights' e non 'added like add'; mix sommati → 'the mix lights are added like add' e non 'R is drawn after'; una lettura diversa → 'changes from read to read';
  - `listVerdict` (slot P 15, Q 13; id P 120, Q 121): passa con dentro = bersaglio, fuori = F, overlap Q; fuori al bersaglio → 'still drawn'; dentro = F → 'is not drawn'; overlap P → 'follows the slots'; slot d'accordo con gli id → 'cannot tell the id rule from slot order';
  - `checkMix` su un **modello**: un motore finto le cui handle registrano solo `depth`, `transparent`, `light` (`<tipo>/<falloff o ->`) e `destroy` (non `position`), con `destroy` idempotente come `EntityHandle.destroy()` (`entity-handle.ts:831-841`: logga solo la prima chiamata, e il `finally` di `checkMix`, che distrugge di nuovo M, non aggiunge niente), e le cui righe si spostano come in Rust (swap-remove), con un probe che compone `F` e ogni luce che il test esatto al far tiene, nell'ordine `'list'` (`lightsBackToFront`) o `'slot'` (le righe), con `lightLayer` al peso di `pointWeight` (1 per una global); id da 120. In Mode A (il probe rifiuta): tre `skip`, 5 handle tutte distrutte e in `entities`, `restoreView` una volta. Con `'list'`: tre `pass`, ogni lettura sul layer 0, il dettaglio del check 1 con `1 group, 0 SDF sets`, e le chiamate esatte: R `['depth 0.5', 'light point/0', 'destroy']`, P `['depth 1', 'transparent', 'light point/0', 'depth 2', 'depth 1', 'destroy']`, Q `['depth 2', 'light point/0', 'depth 1', 'depth 1', 'destroy']`, M `light point/0`, `point/1`, `global/-`, `point/0`, poi depth ≈ 1002,985 e 1003,015 e `destroy`. Con `'slot'`: pass, fail, fail, e il terzo dice 'follows the slots'.

  Il file intero:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkMix, fp16Ulp, lightTexelCentre, listVerdict, mixOrderVerdict, mixReplacesVerdict, pointWeight,
  M_TARGET, P_COLOR, Q_COLOR, R_COLOR, ORDER_READS, type OrderRead,
} from './lighting-mix';
import { createTestReporter } from './types';
import { Camera, orthographic } from '../camera';
import { CameraAPI } from '../camera-api';
import { composite, lightLayer, lightsBackToFront, straight, type LightBlend, type Rgb } from './blend-expect';
import type { Hyperion } from '../hyperion';
import type { EntityHandle } from '../entity-handle';
import type { Rgba } from './probe-checks';

// The Lighting tab's floor (ambient + its global light) under the sub-scene.
const F: Rgb = [0.185, 0.17, 0.295];
const rgba = (c: readonly number[]): Rgba => [c[0], c[1], c[2], 1];
const sum = (...cs: Rgb[]): Rgb => cs.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]);

describe('fp16Ulp, pointWeight, lightTexelCentre', () => {
  it('fp16Ulp: 2^(floor(log2|v|) - 10), 2^-24 below the normal range', () => {
    expect(fp16Ulp(1)).toBe(2 ** -10);
    expect(fp16Ulp(2)).toBe(2 ** -9);
    expect(fp16Ulp(0.5)).toBe(2 ** -11);
    expect(fp16Ulp(-1.5)).toBe(2 ** -10);
    expect(fp16Ulp(0)).toBe(2 ** -24);
  });

  it('pointWeight: (1 - d/range)^falloff inside the range, 0 from it on; falloff 0 is 1 inside', () => {
    expect(pointWeight([1, 0], [0, 0], 4, 1)).toBeCloseTo(0.75, 12);
    expect(pointWeight([0, 2], [0, 0], 4, 2)).toBeCloseTo(0.25, 12);
    expect(pointWeight([3.9, 0], [0, 0], 4, 0)).toBe(1);
    expect(pointWeight([4, 0], [0, 0], 4, 0)).toBe(0);
  });

  it('lightTexelCentre: the centre of the light-buffer texel under a point, at most half a texel away', () => {
    const vp = orthographic(-160 / 9, 160 / 9, -10, 10, -1, 1000);
    const size: [number, number] = [960, 540];
    const texel = 20 / 540;  // world units per texel at this view
    for (const p of [[0.3, -0.7], [-10, 1], [5.55, 3.21]] as const) {
      const c = lightTexelCentre(p, vp, size);
      expect(Math.abs(c[0] - p[0])).toBeLessThanOrEqual(texel / 2 + 1e-9);
      expect(Math.abs(c[1] - p[1])).toBeLessThanOrEqual(texel / 2 + 1e-9);
      const again = lightTexelCentre(c, vp, size);
      expect(again[0]).toBeCloseTo(c[0], 9);
      expect(again[1]).toBeCloseTo(c[1], 9);
    }
  });
});

describe('mixReplacesVerdict', () => {
  const ws = [0.75, 0.5];
  const read = (partial: (w: number) => Rgb, full: Rgb = M_TARGET, global: Rgb = M_TARGET) => ({
    full: rgba(full),
    floor: rgba(F),
    partial: ws.map((w) => ({ read: rgba(partial(w)), w })),
    partialFloor: rgba(F),
    global: [rgba(global), rgba(global), rgba(global)],
  });
  const right = (w: number) => composite(F, [straight(M_TARGET, w)]);

  it('passes the rule: the target at weight 1, floor·(1 − w) + target·w, the whole layer as a global light', () => {
    const v = mixReplacesVerdict(read(right), F, M_TARGET);
    expect(v.ok).toBe(true);
    expect(v.detail).toContain('0.0 fp16 ULP from 2.000, 1.000, 0.500');
  });

  it('names the defect at weight 1: added like add, not drawn, the target clamped', () => {
    const cases: Array<[Rgb, string]> = [
      [sum(F, M_TARGET), 'the mix light is added like add'],
      [F, 'the mix light is not drawn'],
      [[1, 1, 0.5], 'the target is clamped at 1'],
    ];
    for (const [full, cause] of cases) {
      const v = mixReplacesVerdict(read(right, full), F, M_TARGET);
      expect(v.ok, cause).toBe(false);
      expect(v.detail).toContain(cause);
      for (const [, other] of cases.filter(([, c]) => c !== cause)) expect(v.detail).not.toContain(other);
    }
  });

  it('names the defect at a partial weight: the weight ignored, added like add, not premultiplied', () => {
    const cases: Array<[(w: number) => Rgb, string]> = [
      [() => M_TARGET, 'the weight is ignored'],
      [(w) => sum(F, M_TARGET.map((c) => c * w) as Rgb), 'added like add'],
      [(w) => sum(M_TARGET, F.map((c) => c * (1 - w)) as Rgb), 'not premultiplied'],
    ];
    for (const [partial, cause] of cases) {
      const v = mixReplacesVerdict(read(partial), F, M_TARGET);
      expect(v.ok, cause).toBe(false);
      expect(v.detail).toContain(cause);
      for (const [, other] of cases.filter(([, c]) => c !== cause)) expect(v.detail).not.toContain(other);
    }
  });

  it('fails when the global mix light does not bring the whole layer to its target', () => {
    const v = mixReplacesVerdict(read(right, M_TARGET, sum(F, M_TARGET)), F, M_TARGET);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('does not bring its whole layer to its target');
  });
});

describe('mixOrderVerdict', () => {
  const at = (front: Rgb, extra: Partial<Record<keyof OrderRead, Rgb>> = {}): OrderRead => ({
    pOnly: rgba(extra.pOnly ?? P_COLOR),
    overlap: rgba(extra.overlap ?? front),
    qOnly: rgba(extra.qOnly ?? Q_COLOR),
    rOnly: rgba(extra.rOnly ?? sum(F, R_COLOR)),
    floor: rgba(extra.floor ?? F),
  });
  const reads = (front: Rgb, extra: Partial<Record<keyof OrderRead, Rgb>> = {}) => Array.from({ length: ORDER_READS }, () => at(front, extra));

  it('passes the rule: P over the overlap while nearer, Q after the swap; R under both', () => {
    const v = mixOrderVerdict(reads(P_COLOR), at(Q_COLOR), F);
    expect(v.ok).toBe(true);
    expect(v.detail).toContain('overlap P over 10 reads with P nearer, Q after the swap');
  });

  it('names the rule the overlap follows instead', () => {
    const cases: Array<[Rgb, Rgb, string]> = [
      [Q_COLOR, P_COLOR, 'the order is reversed'],
      [Q_COLOR, Q_COLOR, 'follows the ids or the slots'],
      [P_COLOR, P_COLOR, 'P stays on top'],
    ];
    for (const [before, after, cause] of cases) {
      const v = mixOrderVerdict(reads(before), at(after), F);
      expect(v.ok, cause).toBe(false);
      expect(v.detail).toContain(cause);
      for (const [, , other] of cases.filter(([, , c]) => c !== cause)) expect(v.detail).not.toContain(other);
    }
  });

  it('names a class order broken (R after the mix lights) and mix lights added like add', () => {
    const late = mixOrderVerdict(reads(sum(P_COLOR, R_COLOR), { pOnly: sum(P_COLOR, R_COLOR), qOnly: sum(Q_COLOR, R_COLOR) }),
      at(sum(Q_COLOR, R_COLOR), { pOnly: sum(P_COLOR, R_COLOR), qOnly: sum(Q_COLOR, R_COLOR) }), F);
    expect(late.ok).toBe(false);
    expect(late.detail).toContain('R is drawn after the mix lights');
    expect(late.detail).not.toContain('added like add');
    const summed = sum(F, R_COLOR, P_COLOR);
    const added = mixOrderVerdict(reads(sum(F, R_COLOR, P_COLOR, Q_COLOR), { pOnly: summed }), at(sum(F, R_COLOR, P_COLOR, Q_COLOR), { pOnly: summed }), F);
    expect(added.ok).toBe(false);
    expect(added.detail).toContain('the mix lights are added like add');
    expect(added.detail).not.toContain('R is drawn after');
  });

  it('fails an overlap that changes from read to read', () => {
    const before = reads(P_COLOR);
    before[4] = at(Q_COLOR);
    const v = mixOrderVerdict(before, at(Q_COLOR), F);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('changes from read to read');
  });
});

describe('listVerdict', () => {
  const right = { inside: rgba(M_TARGET), outside: rgba(F), overlap: rgba(Q_COLOR), slots: { p: 15, q: 13 }, ids: { p: 120, q: 121 } };

  it('passes the rule: listed just inside the limit, not just outside; at equal depths the higher id, against the slots', () => {
    expect(listVerdict(right, F, M_TARGET).ok).toBe(true);
  });

  it('fails the grouping margin (drawn just outside), a light not drawn inside, and slot order', () => {
    const margin = listVerdict({ ...right, outside: rgba(M_TARGET) }, F, M_TARGET);
    expect(margin.ok).toBe(false);
    expect(margin.detail).toContain('still drawn');
    const missing = listVerdict({ ...right, inside: rgba(F) }, F, M_TARGET);
    expect(missing.detail).toContain('is not drawn');
    const slots = listVerdict({ ...right, overlap: rgba(P_COLOR) }, F, M_TARGET);
    expect(slots.ok).toBe(false);
    expect(slots.detail).toContain('follows the slots');
  });

  it('fails when the slots agree with the ids: the read cannot tell the two rules apart', () => {
    const v = listVerdict({ ...right, slots: { p: 13, q: 15 } }, F, M_TARGET);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('cannot tell the id rule from slot order');
  });
});

// ── checkMix, end to end on a model of the light buffer ──────────────────────

interface FakeLight {
  type?: string;
  blend?: LightBlend;
  color?: readonly number[];
  energy?: number;
  range?: number;
  falloff?: number;
}

/**
 * A handle of the fake engine: it records what the check sets, and its row
 * moves like Rust's (swap-remove). `calls` logs depth, transparent, light
 * (`<type>/<falloff or ->`) and destroy, nothing else (not position); destroy
 * is idempotent, like EntityHandle.destroy(), and logs its first call only.
 */
interface FakeHandle {
  id: number;
  is2D: boolean;
  x: number;
  y: number;
  d: number;
  isTransparent: boolean;
  lightOptions: FakeLight | null;
  destroyed: boolean;
  calls: string[];
}

/**
 * An engine whose probe reads a model of the light buffer: the floor, then
 * every light the exact far-plane test keeps, in the order `rule` gives
 * ('list': the step-7 rule, blend-expect's oracle; 'slot': the rows), each
 * through lightLayer at its weight (pointWeight, a global light 1).
 */
function modelEngine(rule: 'list' | 'slot', probeUnavailable = false) {
  const rows: FakeHandle[] = [];
  const handles: FakeHandle[] = [];
  const requests: Array<{ target: string; world: [number, number][]; layer?: number }> = [];
  let nextId = 120;
  const spawn = (opts?: { mode?: '2d' | '3d' }) => {
    const h: FakeHandle = { id: nextId++, is2D: opts?.mode === '2d', x: 0, y: 0, d: 0, isTransparent: false, lightOptions: null, destroyed: false, calls: [] };
    rows.push(h);
    handles.push(h);
    const api = {
      get id() { return h.id; },
      position: (x: number, y: number) => { h.x = x; h.y = y; return api; },
      scale: () => api,
      receivesLight: () => api,
      depth: (d: number) => { h.d = d; h.calls.push(`depth ${d}`); return api; },
      transparent: () => { h.isTransparent = true; h.calls.push('transparent'); return api; },
      light: (o: FakeLight) => { h.lightOptions = o; h.calls.push(`light ${o.type}/${o.falloff ?? '-'}`); return api; },
      destroy: () => {
        if (h.destroyed) return;
        h.destroyed = true;
        h.calls.push('destroy');
        const i = rows.indexOf(h);
        const last = rows.pop()!;
        if (last !== h) rows[i] = last;
      },
    };
    return api;
  };
  const cam = new CameraAPI(new Camera());
  cam.setOrthographic((20 * 1920) / 1080, 20);
  const lightBufferAt = ([x, y]: [number, number]): Rgba => {
    const vp = cam.viewProjection;
    const farDepth = (vp[14] - 1) / vp[10];
    const lights = rows.filter((h) => h.lightOptions !== null).map((h) => {
      const o = h.lightOptions!;
      const range = o.range ?? 100;
      const weight = o.type === 'global' ? 1 : pointWeight([x, y], [h.x, h.y], range, o.falloff ?? 1);
      const energy = o.energy ?? 1;
      const color = (o.color ?? [1, 1, 1]).map((c) => c * energy) as Rgb;
      return { h, blend: o.blend ?? 'add', depth: h.d, id: h.id, color, weight, listed: o.type === 'global' || h.d <= farDepth + range };
    }).filter((l) => l.listed);
    const ordered = rule === 'list' ? lightsBackToFront(lights) : lights;
    return rgba(composite(F, ordered.map((l) => lightLayer(l))));
  };
  const probe = async (request: { target: string; world: [number, number][]; layer?: number }) => {
    requests.push(request);
    if (probeUnavailable) throw new Error('The debug probe needs the main-thread renderer of a dev build');
    return { values: request.world.map(lightBufferAt) };
  };
  const readEntityTransforms = async () => ({ entityIds: Uint32Array.from(rows.map((h) => h.id)) });
  const engine = {
    batch: (fn: () => void) => fn(), spawn, cam,
    lighting: { groups: { groups: [{ layers: 1, sdfSet: -1 }], sdfSets: [], layerToGroup: [0x10, 0] } },
    debug: { probe, readEntityTransforms, readTransparentSort: async () => ({}) },
  } as unknown as Hyperion;
  return { engine, handles, rows, requests };
}

describe('checkMix', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubs = () => {
    vi.stubGlobal('document', { getElementById: () => ({ width: 1920, height: 1080 }) });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  };

  it('in Mode A: three skips, every handle destroyed, the view restored', async () => {
    stubs();
    const { engine, handles } = modelEngine('list', true);
    const reporter = createTestReporter();
    const entities: EntityHandle[] = [];
    const restoreView = vi.fn();
    await checkMix(engine, reporter, entities, F, restoreView);
    expect(reporter.results().map(({ name, status }) => [name, status])).toEqual([
      ['Mix light replaces the light buffer', 'skip'],
      ['Mix order follows depth', 'skip'],
      ['Light list: exact cull, id at equal depth', 'skip'],
    ]);
    // The floor, M, R, P and Q.
    expect(handles).toHaveLength(5);
    expect(handles.every((h) => h.destroyed)).toBe(true);
    expect(entities).toHaveLength(5);
    expect(restoreView).toHaveBeenCalledTimes(1);
  });

  it('on the step-7 rule: three passes, every read on the floor group, and the scene put back', async () => {
    stubs();
    const { engine, handles, requests } = modelEngine('list');
    const reporter = createTestReporter();
    const restoreView = vi.fn();
    await checkMix(engine, reporter, [], F, restoreView);
    expect(reporter.results().map(({ name, status, detail }) => [name, status, status === 'pass' ? '' : detail])).toEqual([
      ['Mix light replaces the light buffer', 'pass', ''],
      ['Mix order follows depth', 'pass', ''],
      ['Light list: exact cull, id at equal depth', 'pass', ''],
    ]);
    // layerToGroup [0x10, 0]: layer 0 is group 0 (and layer 1 group 1): every read asks for the floor's.
    expect(new Set(requests.map((r) => `${r.target}#${r.layer}`))).toEqual(new Set(['light-buffer#0']));
    // The first check reports the frame's groups and SDF sets (report only, never gated).
    expect(reporter.results()[0].detail).toContain('1 group, 0 SDF sets');
    const [, m, r, p, q] = handles;
    expect(r.calls).toEqual(['depth 0.5', 'light point/0', 'destroy']);
    // P nearer, then the swap, then equal depths; `.transparent()` must not move P after Q.
    expect(p.calls).toEqual(['depth 1', 'transparent', 'light point/0', 'depth 2', 'depth 1', 'destroy']);
    expect(q.calls).toEqual(['depth 2', 'light point/0', 'depth 1', 'depth 1', 'destroy']);
    // Weight 1, weight w, global, back to weight 1; then just inside and just outside its listed limit, and despawned.
    expect(m.calls.slice(0, 4)).toEqual(['light point/0', 'light point/1', 'light global/-', 'light point/0']);
    expect(m.calls.slice(4, 6).map((c) => Number(c.split(' ')[1]))).toEqual([expect.closeTo(1002.985, 3), expect.closeTo(1003.015, 3)]);
    expect(m.calls.at(-1)).toBe('destroy');
    expect(handles.every((h) => h.destroyed)).toBe(true);
    expect(restoreView).toHaveBeenCalledTimes(1);
  });

  it('on slot order (the cull of a small scene on a 32-lane GPU): the order and the tie fail', async () => {
    stubs();
    const { engine } = modelEngine('slot');
    const reporter = createTestReporter();
    await checkMix(engine, reporter, [], F, vi.fn());
    expect(reporter.results().map(({ name, status }) => [name, status])).toEqual([
      ['Mix light replaces the light buffer', 'pass'],
      ['Mix order follows depth', 'fail'],
      ['Light list: exact cull, id at equal depth', 'fail'],
    ]);
    expect(reporter.results()[2].detail).toContain('follows the slots');
  });
});
```
  Run `npx --prefix ts vitest run --root ts src/demo/lighting-mix.test.ts`: FAIL, `./lighting-mix` non si risolve.
- [ ] **Step 4: `lighting-mix.ts` (GREEN).** L'intestazione dice a cosa servono la sotto-scena e i tre check, e perché colori e bersagli sono esatti in fp16. Le costanti, con un doc ciascuna (coordinate relative al centro; ogni punto sta ad almeno 1 unità dal bordo di ogni disco che lo contiene):
- `MIX_SCENE = [0, -200]` (esportata; sotto la scena del tab, le cui luci scendono fino a y ≈ −24, e lontano dal sole del passo 6); `SUB_HALF_WIDTH = 17.6`;
- `M_LIGHT = { color: [1, 0.5, 0.25], energy: 2, range: 3 }` e `M_TARGET = [2, 1, 0.5]` (sopra 1, perché un clamp si veda, ed esatto in fp16); `P_COLOR = [1, 0.25, 0.25]`, `Q_COLOR = [0.25, 0.25, 1]`, `R_COLOR = [0, 0.5, 0]`, a energia 1;
- centri `M_AT [-10, 0]`, `R_AT [6, 0]`, `P_AT [4.5, 0]`, `Q_AT [7.5, 0]`; `R_RANGE = 5`, `PQ_RANGE = 3`; `R_DEPTH = 0.5`, `P_DEPTH = 1`, `Q_DEPTH = 2` (R la più vicina);
- `POINTS = { mIn: [-10, 1], floor: [-16, 0], away: [-4, 6], pOnly: [3, 0], overlap: [6, 0], qOnly: [9, 0], rOnly: [6, 4] }` (M_IN solo in M; P_ONLY in P e R; OVERLAP in P, Q e R; Q_ONLY in Q e R; R_ONLY solo in R; FLOOR e AWAY in nessuna);
- `PARTIAL_OFFSETS = [0.75, 1.5]`, `ORDER_READS = 10`, `TOL = 0.03`, `PARTIAL_TOL = 0.004` (2 ULP fp16 al rosso del bersaglio, 4 in [1, 2)), `FAR_EPS = 0.015`; esportate quelle che il test importa (`M_TARGET`, `P_COLOR`, `Q_COLOR`, `R_COLOR`, `ORDER_READS`, `POINTS`).
Gli helper: `fp16Ulp(v)` = 2^(⌊log2|v|⌋ − 10), 2⁻²⁴ sotto 2⁻¹⁴; `withinUlp(got, want)` per canale; `pointWeight(at, centre, range, falloff)` = 0 da `range` in su, altrimenti (1 − d/range)^falloff, come `light-accum.wgsl`; `lightTexelCentre(world, vp, size)`: uv = (vp[0]·x + vp[12])/2 + 1/2 e 1/2 − (vp[5]·y + vp[13])/2, il centro del texel `floor(uv · size)` (quello che il probe legge), di nuovo in coordinate mondo.
I verdetti restituiscono `{ ok, detail }`: il `detail` elenca i valori letti con `fmt` e, se fallisce, aggiunge le cause separate da `; `, con le frasi che i test dello Step 3 cercano.
- `mixReplacesVerdict`: FLOOR entro `TOL` dal floor del tab; M_IN entro 1 ULP fp16 dal bersaglio (altrimenti la causa, riconosciuta in quest'ordine: vicino a floor + bersaglio, al floor, al bersaglio clampato a 1; se no "M_IN is not M's target"); ogni punto parziale entro `PARTIAL_TOL` da `composite(floor letto, [straight(bersaglio, w)])` (altrimenti, con `w <w>:` davanti: letto come il bersaglio, come floor + bersaglio·w, come bersaglio + floor·(1 − w), o "not floor·(1 − w) + target·w"); i tre punti global entro 1 ULP dal bersaglio. Il dettaglio comincia con `M <valori>, <n> fp16 ULP from <bersaglio>`.
- `mixOrderVerdict`: P e Q diversi di più di 0,1 in un canale. In ogni lettura P_ONLY e Q_ONLY entro 1 ULP dalla loro luce (altrimenti, con `before <i>:` o `after:` davanti: vicino a luce + R → R disegnata dopo i mix; vicino a floor + R + P → mix sommati come add; se no "P_ONLY or Q_ONLY is not its own light"), R_ONLY entro `TOL` da floor + R, FLOOR dal floor. L'overlap si legge come 'P', 'Q' o i valori: deve essere sempre P prima e Q dopo, e se no il verdetto nomina la regola seguita (letture diverse fra loro; Q/P ordine rovesciato; Q/Q id o slot; P/P `.transparent()`; nessuna delle due). Il dettaglio: `overlap <P|Q> over <n> reads with P nearer, <Q|P> after the swap; …`.
- `listVerdict`: dentro entro 1 ULP dal bersaglio; fuori entro `TOL` dal floor; la lettura a depth uguali conta solo se `(id Q > id P) !== (slot Q > slot P)`, altrimenti fallisce perché non distingue le regole; se conta, l'overlap dev'essere la luce con l'id più alto (con l'altra: "follows the slots").

`checkMix`, in un `try`/`finally`:
1. `fitView(engine, ...MIX_SCENE, 17.6)`. Un `engine.batch` crea il pavimento `position(cx, cy, -0.5).scale(200, 100, 1).receivesLight(true)` e le luci M, R, P (`.transparent()`) e Q, tutte 2D: M point `mix`, `M_LIGHT` a falloff 0; R `add`, `R_COLOR`, range `R_RANGE`, falloff 0, depth `R_DEPTH`; P e Q `mix`, `P_COLOR`/`Q_COLOR`, range `PQ_RANGE`, falloff 0, depth `P_DEPTH`/`Q_DEPTH`. Ogni handle va in una lista propria e in `entities`. Poi `frames(4)`. Ogni lettura chiede il layer del gruppo del pavimento: `layerToGroup[0] & 0xf`, letto subito prima del probe.
2. Check 1: M_IN e FLOOR; M a falloff 1, `frames(4)`, i punti M + (0,75, 0) e M + (1,5, 0) portati al centro del loro texel (`lightTexelCentre` con `halfResolution` del canvas), più FLOOR; M `global` `mix` (stesso colore ed energia), `frames(4)`, FLOOR, M_IN e AWAY; M di nuovo point a falloff 0, `frames(4)`. Poi `mixReplacesVerdict` con i pesi `pointWeight` di quei punti; al suo dettaglio si aggiungono, dopo `; `, i gruppi e i set SDF letti subito dopo la terza lettura (`groupCounts()`, un aiutante privato di `lighting-mix.ts`: `plural(groups.length, 'group')` e `plural(sdfSets.length, 'SDF set')` di `engine.lighting.groups` separati da `, `, 0 e 0 se è null, con un `plural` locale uguale a quello non esportato di `lighting-directional.ts:121`: `1 group, 0 SDF sets` sulla sotto-scena, dove nessuna luce fa ombra). Solo riportati, come in 'Directional shadow', perché un cambio di raggruppamento si veda: non sono un cancello.
3. Check 2: `ORDER_READS` letture di P_ONLY, OVERLAP, Q_ONLY, R_ONLY e FLOOR; `p.depth(Q_DEPTH)`, `q.depth(P_DEPTH)`, `frames(4)`; una lettura; `mixOrderVerdict`.
4. Check 3: `limit = (vp[14] − 1) / vp[10] + M_LIGHT.range`; M a depth `limit − FAR_EPS`, `frames(4)`, M_IN; a `limit + FAR_EPS`, `frames(4)`, M_IN; `m.destroy()`, P e Q a `P_DEPTH`, `frames(4)`; OVERLAP e il readback delle righe nello stesso frame (`Promise.all` di probe e `readTransforms`); gli slot da `entityIds.indexOf(id)`; `listVerdict`.
5. `finally`: `destroy()` di ogni handle (M l'ha già distrutta il check 3: `destroy()` è idempotente), `frames(4)`, `restoreView()`.

Ogni check passa per `pixelCheck`, che in Mode A e in produzione va in skip. In Mode A ogni check si ferma al suo primo probe (il check 3 sposta prima la depth di M): M non diventa mai global, e la sotto-scena, fuori dalla vista del render worker, si crea e si distrugge e basta.

Run `npx --prefix ts vitest run --root ts src/demo/lighting-mix.test.ts src/demo/blend-expect.test.ts`: 17/17 e 19/19.
- [ ] **Step 5: il tab.** In `lighting.ts`: `import { checkMix } from './lighting-mix';` dopo `:7`; l'etichetta (`:52`) diventa `'Lighting (point / spot / directional / global, add / mix, shadows, lit vs unlit)'`; dopo `await checkDirectional(...)` (`:174`):
```ts
    // ── 7. The light list and the mix blend, on a sub-scene below this one ──
    // (round step 7): M turns global for a moment, and the view comes back
    // before the lights start moving.
    await checkMix(engine, reporter, entities, floor, () => fitView(engine, 0, 0, SCENE_HALF_WIDTH));
```
Codice e soglie dei check dei passi 3 e 6 non cambiano. Poi `npm --prefix ts test` (115 file, 2089 + 7 saltati) e `tsc`.
- [ ] **Step 6: GPU (Mac, prima del commit).** Riavvia il dev server. `"http://localhost:5173/?mode=B"` con `ignoreCache` e l'`initScript`; `resize_page` a 1200×689 CSS (dpr 2); `window.__harnessMeta = { head, adapterLine }`; `lighting-tab.js` con `filePath` = `/Users/edoardocicognani/Code/HyperionEngine/docs/plans/assets/2026-10-08-step7/harness-task5-B.json`; `node docs/plans/assets/2026-10-08-step7/step7-stats.mjs details docs/plans/assets/2026-10-08-step7/harness-task5-B.json docs/plans/assets/2026-09-30-step6/baseline/statuses-B.json`. Lo stesso in `?mode=C`. Expected: Lighting **12/12** in B e in C; dettagli coerenti con la geometria (M a 0,0 ULP dal bersaglio; 'overlap P over 10 reads with P nearer, Q after the swap'; lo slot di Q sotto quello di P; `1 group, 0 SDF sets`); `details` esce 0 (3 se la tela non è 1960×1248: si rifà la pagina). La previsione: rispetto alla base del passo 6 può cambiare ordine solo il gruppo del layer 1, cioè la global e la luce blu, che sole raggiungono (15, 2) e (15, 6); i gruppi del layer 0 (point, spot, global) e della sotto-scena del sole (global, sole) tengono il loro ordine. Quindi 'Layer shadow on screen' può muoversi di un passo fp16, al più 0,001 come stampato, e gli altri cinque check di dettaglio restano uguali. Console pulita. Nel registro SDD va la durata della chiamata a `lighting-tab.js`, che non misura `setupMs`. L'attesa della §4 di `/gpu-check` (Task 10, Step 2) si decide sul `setupMs` di `tab-runner.js` al Task 9, Step 4. Un check che fallisce si indaga (`superpowers:systematic-debugging`) prima di toccare le soglie.
- [ ] **Step 7: commit** dei cinque file e dei due JSON: `test(7): tre check col probe per la lista delle luci e il blend mix, su una sotto-scena del tab Lighting`.

### Task 6: commenti, agent e skill, design, CLAUDE.md, piano del giro

Nessun test nuovo. Dopo ogni modifica a un documento lungo, `git diff --numstat` (gotcha di CLAUDE.md).

- [ ] **Step 1: commenti del codice** (inglese)
1. `cull-pass.ts:33-38` diventano:
```ts
 * Light2D (type 6) is filed like any other type: bucket 1 for a texture of tier
 * > 0, the transparent half for `.transparent()`. Nothing draws those four
 * buckets since round step 7: LightAccumStage draws the light list that
 * deriveLightGroups builds on the CPU with the same sphere test. Their waste is
 * uniform, which is the point — a variable bucket count per type would break the flat
 * `blendOffset + primType * BUCKETS_PER_TYPE + bucket` indexing in `cull.wgsl`
 * and put a branch in the hot loop.
```
2. `cull.wgsl:16-20` (solo un commento; il Task 9 ricompila comunque il cull):
```wgsl
// Light2D is filed like any other type (bucket 1 for a tier > 0 texture, the
// transparent half for bit 8), and since round step 7 nothing draws those
// buckets: LightAccumStage draws the light list built on the CPU. Uniform
// waste, and the alternative — a variable bucket count per type — would break
// the `blendOff + primType * BUCKETS_PER_TYPE + bk` indexing below and add a
// branch to the hot loop.
```
3. `capabilities.test.ts:281-287`:
```ts
// cull-pass.ts gives every bucket but 0 a non-zero firstInstance (the offset of
// its region in visible-indices). That is 11 of ForwardPass's 12 opaque indirect
// draws, 23 of OccluderSeedStage's 24 per SDF set, plus 1 of SelectionSeedPass's
// 2 when outlines are on. Without the 'indirect-first-instance' feature the spec
// turns each of those draws into a no-op, with no validation error. Measured on
// an RTX 4060: 0 pixels without the feature, drawn with it. Only bucket 0
// (opaque tier-0 quads) survives among them. Transparent entities (the uber draw
// of transparent-args, phase 5b) and lights (one direct draw per light group,
// round step 7) draw from firstInstance 0, so they never needed it.
```
4. `transparent-sort-constants.ts` (`:40` di HEAD, `:56` dopo il Task 2): "stay LightAccumStage's." → "are drawn by nothing since round step 7 (LightAccumStage draws the CPU light list)." (la frase comincia con "Records 26/27 (a `.transparent()` Light2D)", che nomina già le luci); `transparent-sort-wgsl.test.ts:232`: `// 26/27 hold transparent Light2Ds, which nothing draws since round step 7.`
5. `components.rs:82-83` e `:341-342`: "reads its draw bucket directly." → "draws every light from the light list `deriveLightGroups` builds on the CPU (round step 7)."; "reads their draw bucket directly." → "draws them from the CPU light list (round step 7)." Poi `cargo clippy -p hyperion-core --all-features --all-targets` pulito.
6. `forward-pass.ts:50-51`: "Its buckets are read directly by the light accumulation pass." → "Nothing draws its buckets since round step 7: LightAccumStage draws the light list deriveLightGroups builds on the CPU."

- [ ] **Step 2: agent e skill** (inglese)
1. `webgpu-pass-reviewer.md:34`: "For Light2D, LIGHT2D_ARG_SLOTS must be every slot cull.wgsl can fill (12, 13, 26, 27)." → "Lights take no indirect record since round step 7: `LightAccumStage` makes one direct `drawIndexed(6, k, 0, 0, 0)` per light group over its own `light-order` buffer (firstInstance 0, no feature)." Voce 13 nuova: "**The light list (round step 7).** `LightAccumStage` has ONE pipeline, blend `LIGHT_BLEND` (colour {add, one, one-minus-src-alpha}, alpha {add, zero, one}): add or sub return alpha 0, which must stay `{one, one}` bit for bit. Its `light-order` buffer is the stage's own (created in `setup()`, destroyed in `destroy()`, never in the pool), grows to the next power of two, never shrinks, drops the cached bind groups when it grows, and is written once, in `prepare()`, which also sets the light count; binding 2 is VERTEX-only `read-only-storage` with `minBindingSize: 4`."
2. `wgsl-validator.md`, voce 9 nuova: "**Light accumulation (round step 7)**: binding 2 of `light-accum.wgsl` is `lightOrder: array<u32>`, read only by `vs_main` as `lightOrder[instanceIdx]` (nothing reads `visibleIndices`), matching `LightAccumStage`'s layout (VERTEX, read-only-storage, `minBindingSize: 4`); it is the stage's own `light-order` buffer, never a ResourcePool name, so check 2 does not apply to it; `fs_main` reads the blend field once, mixes only on `blend == BLEND_MIX`, negates only on `blend == BLEND_SUB` (never `>=`), returns `vec4f(c, 0.0)` for add and sub and `vec4f(color * w, w)` for mix, `w = clamp(intensity, 0.0, 1.0)`; `BLEND_SUB`/`BLEND_MIX` match `components.rs` and `light-groups.ts`."
3. `new-primitive/SKILL.md:34`: via "`LIGHT2D_ARG_SLOTS`, ".

- [ ] **Step 3: design 17** (italiano)
1. `:552`: "render, blend additivo" → "render, «over» premoltiplicato (passo 7)".
2. `:569`: "Blend `{operation:'add', srcFactor:'one', dstFactor:'one'}`" → "Blend «over» premoltiplicato, colore `{add, one, one-minus-src-alpha}` e alpha `{add, zero, one}` (dal passo 7; prima `{one, one}`, che l'«over» con alpha 0 riproduce al bit)".
3. `:571`: "additivo e mascherato (un ambient per layer)," → "mascherato, additivo di default (un ambient per layer) e sostitutivo col blend `mix`,".
4. `:573`: "(`drawIndexedIndirect` sul bucket del tipo 6 — l'`instanceCount` l'ha già scritto il `CullPass`)" → "(dal passo 7 una `drawIndexed` diretta per gruppo sulla lista che `deriveLightGroups` ordina sulla CPU; prima una `drawIndexedIndirect` per bucket del tipo 6)".
5. `:577`: "3. Blend mode (Add / Sub / Mix) in-shader." → "3. Blend mode in-shader, sotto l'unico «over» della pipeline: Add (c, 0), Sub (−c, 0), Mix (colore·w, w) con w = intensità (passo 7, nota sotto)."
6. Dopo la nota del passo 6 (`:602`): "> 🆕 **Una lista per tutte le luci e il blend `mix`, passo 7 del giro (2026-10-08).** Ogni Light2D che il test **esatto** del cull tiene entra in una lista costruita sulla CPU da `deriveLightGroups`, ordinata per classe di blend (add e sub, poi mix), z di mondo dal fondo al davanti (`sortableZBits`) e id esterno. `LightAccumStage` la disegna con una draw diretta per gruppo: WebGPU fonde nell'ordine delle primitive, quindi l'ordine è quello della lista e non quello degli atomici del cull, e serve niente `indirect-first-instance`. Add e sub restituiscono alpha 0 (al bit come `{one, one}`), un mix (colore·w, w), w = falloff × cono × ombra. Ricerca `wf_c4b94385-585`."
7. `:748`: "`Mix=2` |" → "`Mix=2`; il 3 non è assegnato, e lista e shader lo trattano come `Add` (passo 7) |".
8. §10.2, dopo `:836`: "> 🆕 **Vero alla lettera dal passo 7 del giro.** Prima l'ordine delle luci lo decidevano gli atomici del cull, e due ordini danno texel diversi di qualche passo fp16 (su master la permutazione del banco ne cambiava <`changed` di `assets/2026-10-08-step7/master-B.permute.stats.json`>). Ora l'ordine viene dallo stato ECS, e il primo passo della catena SDF (`LOAD_PASS`) legge solo l'alpha del seed, quindi l'ordine dei caster (ancora quello del cull, visibile nel rg del seed) non arriva all'SDF: sullo stesso device il light buffer è funzione pura delle righe (id esterni compresi), qualunque sia il loro slot, e di camera, canvas, ambient e qualità (fra device, §10.4)."
9. §11, dopo il `sole` (`:870`): `const finestra = engine.spawn({ mode: '2d' }).position(40, 60).depth(1).light({ type: 'point', blend: 'mix', color: '#80a0ff', energy: 1, range: 150, falloff: 0 });`, col commento "una luce mix porta il light buffer verso colore × energia col peso della sua intensità; fra mix sovrapposte vince la più vicina".
10. `:221` (§4-B): "una luce `global` è un'entità additiva e mascherata, un ambient per layer," → "una luce `global` è un'entità mascherata, additiva di default (un ambient per layer) e sostitutiva col blend `mix` (passo 7),".
11. Dopo il diagramma del §5 (il blocco chiuso a `:363`, che a `:355` dice "blend additivo rgba16float"): "> 🆕 **Passo 7 del giro.** Nel backend `lit` le luci si fondono con un «over» premoltiplicato, dalla lista che `deriveLightGroups` costruisce sulla CPU (§7.3): add e sub restituiscono alpha 0, al bit come il blend additivo del diagramma, un `mix` (colore·w, w)." Il diagramma non cambia: i suoi bordi a colonna fissa non reggono una riga più lunga.
12. Dopo il paragrafo "Il culling gratuito…" (`:423`), sotto la tabella del §6.1 che a `:418` dice "Frustum culling delle luci sulla GPU": "> 🆕 **Dal passo 7 del giro** quel test sfera-frustum gira sulla CPU, nella lista delle luci di `deriveLightGroups`, ed è lui a decidere quali luci si disegnano; il `CullPass` archivia ancora le luci nei bucket del tipo 6, che nessuno legge più."
13. `:425`: "Tre dei quattro bucket del tipo 6 restano inutilizzati." → "Tre dei quattro bucket del tipo 6 restano inutilizzati (🆕 dal passo 7 del giro nessuno legge i quattro bucket del tipo 6: `LightAccumStage` disegna la lista CPU)."
14. Dopo il diagramma del §7.1 (il blocco chiuso a `:557`, che a `:545` dice "↓ visible-indices (bucket tipo 6)"): "> 🆕 **Passo 7 del giro.** L'accumulo (oggi `LightAccumStage`, dentro `LightGroupsPass`) non legge più `visible-indices` né i bucket del tipo 6: disegna la lista CPU delle luci, con un «over» premoltiplicato (§7.3)."

- [ ] **Step 4: design dei light layers** (italiano): `:49`, dopo "(`extractFrustumPlanes`)", "e, dal passo 7, `entityIds` (lo spareggio della lista delle luci)"; `:52`, in fondo, "Dal passo 7 la stessa scansione costruisce la **lista delle luci** (`lightOrder`, `lightIds`), col test **esatto** del cull; ogni luce della lista è anche fra le chiavi (`drawn || inView`)."; nell'interfaccia, prima di `}` (`:78`), `lightOrder: Uint32Array; lightIds: Uint32Array;`; `:106`, "Light2D buckets (args 12, 13, 26, 27)," → "the light list, one direct draw (args 12, 13, 26, 27 until round step 7),"; dopo `:162`, "| Lista delle luci (passo 7) | +0,03 ms con 300 luci, +0,12 ms con 1000 (M2 Pro, Node 24) | due `Uint32Array` per frame (`lightOrder`, `lightIds`) |".

- [ ] **Step 4b: design del 5b** (italiano, `docs/plans/2026-09-27-transparent-sort-uber-design.md`): `:36`, in fondo al punto "Le pipeline opache, l'occluder, `LightAccumStage` (legge ancora i bucket 26/27), …": " 🆕 Dal passo 7 del giro `LightAccumStage` disegna la lista CPU delle luci, e i bucket 26/27 non li legge più nessuno."; `:489`, la riga "Light2D `.transparent()`": "Escluso dal gather: i bucket 26/27 restano a `LightAccumStage`" → "Escluso dal gather: i bucket 26/27 restano a `LightAccumStage` (🆕 dal passo 7 del giro nessuno li legge: `LightAccumStage` disegna la lista CPU delle luci)".

- [ ] **Step 5: CLAUDE.md** (inglese)
1. `:250`: "`FrameState.ambient`/`shadowSteps`/`lightGroups` (from `deriveLightGroups`," → "`FrameState.ambient`/`shadowSteps`/`entityIds`/`lightGroups` (from `deriveLightGroups`, the light list included,".
2. `:252`: "`FrameState.lightGroups` (light layers)" → "`FrameState.lightGroups` (light layers; since round step 7 also the light list), `FrameState.entityIds` (slot → external id, the light list's tie-break; required)".
3. `:268`: dopo "every entity the GPU draws is kept).", "The same scan builds the LIGHT LIST (round step 7): `lightOrder` (slots in draw order) and `lightIds`, every Light2D the cull's EXACT test keeps (always among the keys), ordered by `orderLights`: blend class (`BLEND_MIX` = 2 last), `sortableZBits` of the row's z bits, external id (`LightGroupsInput.entityIds`; a short column makes the slot stand in for every id), slot."; e "transparent casters and lights count like opaque ones, because the stages draw both blend modes." → "transparent casters count like opaque ones, because the seed stage draws both blend modes, and a `.transparent()` light is listed like any other."
4. `:276`: "indirect-args slots 12-13 and 26-27 (`LIGHT2D_ARG_SLOTS`: a light marked `.transparent()` lands in the transparent buckets and still lights), `SCENE_HDR_FORMAT`, additive," → "the frame's light list (`LightGroups.lightOrder`, round step 7) in ONE direct `drawIndexed(6, k, 0, 0, 0)` (no `indirect-first-instance`) from its own grow-only `light-order` buffer (binding 2, VERTEX, `minBindingSize: 4`, written once in `prepare()`), `SCENE_HDR_FORMAT`, ONE pipeline with `LIGHT_BLEND` (premultiplied over),"; in fondo, "Not yet: the `sprite` light type, the `mix` blend mode |" → "Blend modes: add (c, 0) and sub (−c, 0), `{one, one}` bit for bit; mix (color·w, w), w = `clamp(intensity, 0, 1)`. Not yet: the `sprite` light type |".
5. `:283`, in fondo: ", and `sortableZBits` (the z key, shared with the light list since round step 7)"; `:284`: "`sortableZBits`" → "`sortableZBits` (re-exported from the constants)".
6. `:323`: dopo "the renderer warns once in dev builds)", " and the light list, `lightOrder`/`lightIds` (round step 7)".
7. `:359`: prima di " (9 checks)", "; then a second sub-scene below it (`demo/lighting-mix.ts`, round step 7): 'Mix light replaces the light buffer', 'Mix order follows depth', 'Light list: exact cull, id at equal depth'"; "(9 checks)" → "(12 checks)".
8. Dopo `:360`: "| `demo/lighting-mix.ts` | The Lighting tab's light-list and mix checks (round step 7), on a sub-scene at (0, −200): a full-weight mix light brings its texels to its target (partial weights and a global mix too); two overlapping mix lights under a nearer add light swap when their depths swap at runtime; the exact cull at the far plane; the higher id against slot order at equal depths. `checkMix` and the pure verdicts `mixReplacesVerdict`, `mixOrderVerdict`, `listVerdict`, tested on a model of the light buffer. Its 5 entities take fresh ids: later tabs have ids 5 higher than at step 6 |".
9. `:364`, in fondo: "; for the light buffer (round step 7): `lightLayer`, `lightsBackToFront` (the light list's order, written apart from the engine's), `expectedLight`".
10. `:417`: "Sub blend as a negative contribution." → "drawn from `lightOrder` (binding 2; `vs_main` reads `lightOrder[instanceIdx]`, the `instance_index` builtin) under ONE premultiplied over blend: add (c, 0), sub (−c, 0), mix (color·w, w), w = `clamp(intensity, 0, 1)` (`BLEND_MIX` 2, tied by text tests to Rust and `light-groups.ts`)."
11. `:454`: dopo "(`light-accum.wgsl` draws them full-screen)", ", and so they are always in the light list (round step 7)".
12. `:478`: "and `LightAccumStage` reads them directly." → "and since round step 7 nothing draws them: `LightAccumStage` draws the CPU light list."
13. `:517`: "; `LightAccumStage` draws all four)" → "), which nothing draws since round step 7 (`LightAccumStage` draws the CPU light list with one direct draw per group, so lights need no `indirect-first-instance`)"; in fondo, "Still needing the feature: 11 of ForwardPass's 12 opaque draws, 23 of OccluderSeedStage's 24 per SDF set, one of SelectionSeedPass's two."
14. `:518`: dopo "two transparent ones by id (below).", " A 2D light's depth orders the light list instead (round step 7); it never moves what the light lights."
15. `:519`: "which stay `LightAccumStage`'s)" → "which nothing draws since round step 7)"; dopo "(1) at equal z the HIGHER external id is in front", " (the light list follows the same rule, with the same `sortableZBits`)".
16. Gotcha nuovo dopo `:519`:
```markdown
- **Every light is drawn from ONE CPU-sorted list, through ONE premultiplied "over" pipeline** (round step 7, plan `docs/plans/2026-10-08-step7-light-order-mix-plan.md`) — `deriveLightGroups` builds `lightOrder` (slots, in draw order) and `lightIds` in the scan that forms the groups; `LightAccumStage` writes the list once per frame into its own `light-order` buffer and draws it with one `drawIndexed(6, k, 0, 0, 0)` per light group, so WebGPU's primitive-order blending follows it. Five facts that are easy to break: (1) the list takes the cull's EXACT sphere test (bare radius) while the group keys keep the ×1.01 + 1e-3 margin: a margin in the list draws lights just beyond near or far, whose quad is still on screen because a light's z only culls it, and `drawn || inView` keeps every listed light among the keys; (2) the key is (blend class, `sortableZBits` of the row's z, external id, slot), all ECS state, never the slots alone or the cull's order: it survives a swap-remove and a snapshot restore, and on one device the light buffer is a function of the rows (external ids included), whatever their slots, and of camera, canvas, ambient and quality (design 17 §10.2; the SDF chain's first pass, `LOAD_PASS`, reads only the seed's alpha, so the casters' draw order, still the cull's and visible in the seed's rg, cannot reach the SDF). The class test is `== BLEND_MIX` (2) in `light-groups.ts` and `light-accum.wgsl`, never `>=`: the unclaimed 3 sorts and blends like add; (3) `LIGHT_BLEND` is colour {add, one, one-minus-src-alpha}, alpha {add, zero, one}: add or sub return alpha 0, `{one, one}` bit for bit; mix returns (color·w, w), w = `clamp(intensity, 0, 1)`; nothing clamps the buffer at 0 after a sub; (4) the ids come through `FrameState.entityIds` (= `GPURenderState.entityIds`, Mode A's render worker included): a column shorter than `entityCount` makes the slot stand in for EVERY id; (5) a point or spot light whose world z (a child's composed with its parents') is more than its range outside near/far is culled and lights nothing (default camera: a root 2D light's depth within −1 − range .. 1000 + range); global and directional lights never are; the cull still files lights into buckets 12/13/26/27, which nothing reads. Measured on master before the change (round step 7, Task 1, `docs/plans/assets/2026-10-08-step7/master-*.json`): <the branch sentence>. Scenes, command tapes and snapshots with `mix` lights render differently since round step 7: a `mix` light used to be added like an `add` one. Without mix lights only the draw order changed (`.transparent()` and tier>0-textured lights used to be drawn after the others, each bucket in the cull's order), which moves texels where add or sub lights overlap by a few half-float steps (1-2 with three lights: the `maxSteps` of `master-B.permute.stats.json`).
```
    La frase del ramo (`<the branch sentence>`), dal Task 1: "on the M2's subgroup path Chrome drew overlapping add lights in a different order from frame to frame once they were 256 or more slots apart (<D> distinct light buffers over 240 reads)" | "on the M2 Chrome's subgroup cull kept the order fixed, while the atomic path, forced through `CullPass.SUBGROUP_CONFIG`, did not (<D> distinct over 240 reads)" | "Chrome on the M2 never reordered them, Safari did (<D> distinct over 240 reads, `master-safari-B.json`)".
17. Documentation, dopo `:826`: "- `docs/plans/2026-10-08-step7-light-order-mix-plan.md` — Round step 7 implementation plan (one CPU-sorted light list, the mix blend): the sub-decision, the master measurement of the cull's light order, committed bench, GPU checks."
18. Agents: `:720` (`wgsl-validator`), in fondo: ", the light list binding and blend branches of `light-accum.wgsl`"; `:722` (`webgpu-pass-reviewer`), dopo "renderer-owned pool buffers": ", the light pipeline's blend state and its stage-private list buffer" (le voci 9 e 13 nuove dello Step 2).

- [ ] **Step 6: piano del giro, §5 e §1.** Nel filone L del §5 (`:198-207`; le righe che cita valgono per `1f04d40`) ogni voce prende il suo segno. Il §5 oggi non ne ha nessuno: segnare solo le voci del passo 7 farebbe sembrare ancora da fare quelle che il passo 6 ha già corretto, e il passo 9 le ricontrollerebbe per niente. Le righe `:199-207` diventano:
```markdown
  - nel design Phase 17: §7.3:577 ("Mix in-shader") — ✅ passo 7; §4-B:221 e §7.3:571 (global = clear color) — ✅ passo 6 (`d381d92`) e passo 7 per il mix; §10.2:832-834 (determinismo, oggi `:834-836`) — ✅ passo 7; l'API di esempio del §11:861 — ✅ passo 6 (`d381d92`) e passo 7 per il mix;
  - il design dei light layers, righe 53 (✅ passo 6 per le directional, `d381d92`; le sprite al passo 8) e 224 (✅ passo 6, `d381d92`);
  - `light-groups.ts:110-113` — ✅ passo 6 per le directional (`3b61719`, poi `b05f09d` e `bbf7183`; oggi `:130-143`); le sprite al passo 8;
  - l'header di `light-accum.wgsl` — ✅ passo 6 (directional) e passo 7 (mix); lo sprite resta al passo 8;
  - la riga di `light-accum-stage.ts` in CLAUDE.md — ✅ passo 6 (directional) e passo 7 (mix); lo sprite resta al passo 8;
  - trovati il 2026-09-30, nel design Phase 17:
    - riga 488: con la semantica del codice, 110% vale 1,44× i pixel, non 1,21× — ✅ passo 6 (`d381d92`);
    - righe 944 e 952: 1344×756 fa 12 passate con 1+JFA, non 11 — ✅ passo 6 (`d381d92`);
    - E2 va precisato: le ombre integrate di Godot non leggono l'SDF, quelle marciate su SDF sì, e per loro l'oversize serve — ✅ passo 6 (`d381d92`).
```
  Il "passo 7 per il mix" di `:221`, `:571` e §11 sono i punti 10, 3 e 9 dello Step 3. Nel §1, filone L (`:25`), in fondo al paragrafo "Il §7.3 del design dice «Mix in-shader» … rendono non deterministico.": " (Superata dal §2, passo 7, deciso il 2026-09-30: ogni luce da una lista CPU, una sola pipeline «over» premoltiplicata; al passo 7.)"
- [ ] **Step 7: controllo e commit.** `git diff --numstat`; `npx --prefix ts vitest run --root ts src/capabilities.test.ts src/render/passes/transparent-sort-wgsl.test.ts src/render/passes/cull-pass.test.ts src/render/passes/forward-pass.test.ts`; commit `docs(7): la lista delle luci e il blend mix nel design 17, nei light layers, nel design del 5b, in CLAUDE.md, negli agent e nei commenti del cull`. Expected: verde; nessun documento perde molte più righe di quante ne guadagni.

### Task 7: preflight

- [ ] `scripts/preflight.sh` e `node --test docs/plans/assets/2026-10-08-step7/step7-stats.test.mjs docs/plans/assets/2026-09-30-step6/step6-stats.test.mjs docs/plans/assets/2026-09-30-step6/march-model.test.mjs` (`preflight.sh` non esegue i `node:test`; `march-model.test.mjs` legge `light-accum.wgsl`, `lighting-directional.ts`, `probe-checks.ts`, `hyperion.ts` e `camera-api.ts`). Expected: tutto `OK` e i tre verdi; un passo che fallisce si corregge, test prima, e si rilancia da capo.

### Task 8: review avversariale e agent

- [ ] **Step 1: la workflow.** Le voci `<…>` di `accepted` si scrivono con le risposte del Task 0 e gli esiti misurati: un `accepted` che dice più del misurato nasconde un finding.
```js
Workflow({ name: 'adversarial-review', args: {
  range: 'master..feat/step7-light-order-mix',
  spec: 'docs/plans/2026-09-27-open-items-round-plan.md (§2 "Passo 7 — deciso (2026-09-30)", §3 row 7)',
  plan: 'docs/plans/2026-10-08-step7-light-order-mix-plan.md',
  context: 'Round step 7 (L-b): every Light2D is drawn from one CPU list built by deriveLightGroups (exact cull test; blend class, world z via sortableZBits, external id), written once per frame into a LightAccumStage-private buffer and drawn with one direct drawIndexed per light group through ONE premultiplied over pipeline; the mix blend (weight = intensity); FrameState.entityIds; JSDoc; three probe checks on a Lighting sub-scene; a committed bench run on master before the change and after. GPU: Apple M2 Pro, Chrome, B and C with the probe, A by screenshot.',
  accepted: [
    'Every light, as the cull draws it, comes from one list with the EXACT sphere test; the x1.01 + 1e-3 margin stays for the keys, and every listed light is among them.',
    'Order: class (== BLEND_MIX last; the unclaimed 3 with add), sortableZBits of the z bits, id ascending, slot. A short id column makes the slot stand in for every id (a transport bug).',
    'ONE pipeline, LIGHT_BLEND; add/sub alpha 0, bit-identical to {one, one} at equal order; mix (color*w, w), w = clamp(intensity, 0, 1); no clamp at 0 after a sub (documented).',
    'The cull still fills buckets 12/13/26/27 (nothing reads them; backlog); ForwardPass, OccluderSeedStage and SelectionSeedPass still need indirect-first-instance. Without FrameState.lightGroups (tests only) no light is drawn.',
    'Decision 4: a light whose z leaves near/far by more than its range is culled, documented. CPU cost of the list about +0.03 ms at 300 lights.',
    'The sub-scene raises later tabs\' ids by 5 (M4 base re-captured); Mode A is checked by screenshot.',
    '<default lightIds: accepted | vetoed>',
    '<stability venue and its numbers, from Task 1 and sub-decision 1>',
  ],
  lenses: [
    'webgpu', 'docs',
    { key: 'order', prompt: 'LENS: the light list (light-groups.ts, transparent-sort-constants.ts, render-pass.ts, renderer.ts, lighting-api.ts, the Mode A transport). Exactly what the GPU cull keeps, every listed light among the keys; a total integer comparator (z bits, -0 = +0, NaN fixed, == BLEND_MIX on both sides); ids in all three modes, the all-or-nothing fallback; nothing but the last tie-break depends on slots; per-frame cost.' },
    { key: 'blend', prompt: 'LENS: the blend and the stage (light-accum.wgsl, light-accum-stage.ts, light-groups-pass.ts). Add/sub bit-identical at equal order; mix = dst*(1-w) + color*w, w clamped, global mix, mix after sub, NaN paths; the list buffer (setup, power-of-two growth dropping the bind-group cache, minBindingSize 4 with an empty list, written once in prepare, count reset, never a pool buffer); the indirect-first-instance claims.' },
    { key: 'harness', prompt: 'LENS: lighting-mix.ts (+ test), blend-expect.ts, lighting.ts, the bench, step7-stats.mjs. Each check FAILS on the defect it names and PASSES on correct code; the equal-depth read makes slot and id order disagree; Mode A skips cleanly; entities destroyed, camera restored, points in view at any aspect; steps 3 and 6 checks unchanged. Bench: guards, what one grid over N reads proves, regress bit-identical, shader and cull path restored in a finally; the clear-wait before every scene and the slot preconditions step7-stats refuses on (exit 3); the cull class checked before cullPath is read or written; grow exercising the list buffer growth on the GPU; the details gate refusing a canvas other than 1960x1248.' },
  ],
} })
```
Annota l'id (`wf_…`) e i finding confermati.
- [ ] **Step 2: gli agent** (in parallelo): `webgpu-pass-reviewer` su `light-accum-stage.ts`, `light-groups-pass.ts` e `light-accum.wgsl` del range (binding 2 privato, VERTEX, `minBindingSize: 4`, crescita a potenze di due, scritto una volta in `prepare()`; una `drawIndexed(6, k, 0, 0, 0)` per gruppo; una pipeline con `LIGHT_BLEND`; voci 7 e 13); `wgsl-validator` su `light-accum.wgsl` (binding 2 `lightOrder`, `BLEND_MIX`, il ramo mix, naga; voce 9).
- [ ] **Step 3: correzioni.** Ogni Critical o Important, e ogni Minor non accettato nella voce del §4: test che fallisce, RED, correzione minima, GREEN, `npm --prefix ts test`, commit `fix(7): review <wf-id> — <titolo>`. Un finding contro il §2 si riporta al proprietario. Correzioni a shader, stadio, `light-groups.ts` o `ts/src/demo/` → una review mirata sul loro range prima del Task 9.

### Task 9: verifica GPU sul Mac (Chrome B e C col probe, Mode A da screenshot)

Prima della sessione, una volta: `npm --prefix ts run build:wasm`. Il Task 6 ha toccato due commenti di `components.rs`: il binario non cambia, ma `guard-stale-wasm` confronta le date e a ogni navigazione segnalerebbe `ts/wasm` come vecchio (in alternativa si sa che l'avviso, dopo il Task 6, è atteso e innocuo). Caffeinate avviato (Vincoli globali); nel registro SDD `sw_vers -productVersion -buildVersion` e la versione di Chrome, da confrontare con quelli del Task 1. Per ogni modo: dev server **riavviato**, chrome-devtools-gpu, `ignoreCache` e `initScript`, riga dell'adapter; per l'harness e per `scene` `resize_page` a 1200×689 CSS a dpr 2 (la finestra che i cancelli `details` e M4 richiedono, e in cui il punto del pavimento di `scene` cade nella tela) e `window.__harnessMeta = { head, adapterLine }`. Evidenze in `docs/plans/assets/2026-10-08-step7/`, coi metadati del banco o dello script per-tab.

- [ ] **Step 1: WGSL e pipeline, e la crescita della lista.** `gate-task3.js` in `?mode=B&bench` → `wgsl-m2.json` (`pipelineErrors` `[]`), e naga: come al Task 3. Poi `grow` in B e in C → `grow-m2-{B,C}.json`, con gli expected del Task 3.
- [ ] **Step 2: add e sub al bit (B e C).** Master si ricattura sempre, nella stessa sessione, con lo stesso Chrome e lo stesso macOS: il cancello è al bit, e il compilatore Metal che il rischio 1 nomina viene col sistema, non solo con Chrome. `git status --short` vuoto; `git checkout 1d19575 -- ts/src` (o la base del Task 0; documenti e banco restano), dev server riavviato, `regress` in B e C → `master-{B,C}-recapture.json` (dopo la pulizia del banco: `summarizeRegress` ne controlla gli slot); `git checkout HEAD -- ts/src` (`git status --short` di nuovo vuoto), dev server riavviato. Poi `load-bench.js` (`oldShaderBytes` > 0) e `{ task: 'regress' }` in B e C → `regress-m2-{B,C}.json`; per modo, dalla radice: `node docs/plans/assets/2026-10-08-step7/step7-stats.mjs regress docs/plans/assets/2026-10-08-step7/master-B-recapture.json docs/plans/assets/2026-10-08-step7/regress-m2-B.json`, poi lo stesso con `C` (due chiamate: `{B,C}` in zsh darebbe quattro file a un comando che ne prende due). Expected: exit 0 in entrambi: nessun rifiuto, e ogni punto di ogni layer identico nelle tre gambe (intero, stadio, shader). Un rifiuto (exit 3) si rifà; un punto diverso si indaga (rischio 1). Se la ricattura differisce da `master-{B,C}.json` del Task 1, la differenza va nel registro, con le versioni di Chrome e di macOS delle due sessioni.
- [ ] **Step 3: stabilità e permutazione.** `permute` in B e C → `permute-m2-{B,C}.json` e, per modo, `node docs/plans/assets/2026-10-08-step7/step7-stats.mjs permute docs/plans/assets/2026-10-08-step7/permute-m2-B.json > docs/plans/assets/2026-10-08-step7/permute-m2-B.stats.json` (poi lo stesso con `C`): `changed` 0 con `permuted` vero e nessun rifiuto (su master era > 0). Nella sede del Task 1, le stesse corse `order` (`atomic: true` se c'era) → `order-m2-<sede>.json` e il suo `.stats.json`: `distinctGrids` 1 dove master ne dava più di una, e nessun rifiuto; la stessa configurazione con `blend: 'mix'`: `distinctGrids` 1 e `centre` = `LIGHT_COLORS[(K − 1) % 4]`, la luce con l'id più alto. **Sede Safari** (il default del criterio, o la (a) che ci ricade), col driver del Task 1. È la prima volta che `light-accum.wgsl` del passo 7 e la pipeline con `LIGHT_BLEND` girano in WebKit, e WebDriver non legge la console di Safari: un grafo lit rifiutato resterebbe spento senza traccia (`followLightingBackend`), e il banco scadrebbe aspettando `light-groups` senza una causa. Prima delle corse `order`, quindi, sulla stessa pagina: `gate-task3.js`, adattato al callback di `/execute/async` → `wgsl-safari.json`; dopo `setBackend('lit')` il driver controlla che `light-groups` sia in `renderer.graph.executionOrder`, e se l'attesa scade lo riporta come causa; lo script timeout di `/timeouts` più lungo della corsa; Safari in primo piano (`open -a Safari`) e `document.visibilityState` registrato, come in M12. Poi `permute` e `order` → `order-safari-B.json`, riassunti con `--cull atomic`, con lo sha256 e la riga di comando del driver nel JSON.
- [ ] **Step 4: harness in B e C.** Prima una pagina nuova, `"http://localhost:5173/?mode=B&bench"` (poi C), con `ignoreCache` e l'`initScript` anti-reload, `resize_page` a 1200×689 e `window.__harnessMeta`: le corse del banco degli Step 1-3 lasciano la tela a 1920×1080 (in B e C `engine.resize` la fissa finché la finestra non manda un `resize`, `main.ts:81-88`), le entità del loro ultimo task vive dentro la vista del tab e gli id avanzati, e i dettagli dipendono dalla tela. `tab-runner.js`, poi `lighting-tab.js` → `harness-m2-{B,C}.json`; `node docs/plans/assets/2026-10-08-step7/step7-stats.mjs details docs/plans/assets/2026-10-08-step7/harness-m2-B.json docs/plans/assets/2026-09-30-step6/baseline/statuses-B.json`, poi lo stesso con `C` (rifiuta, exit 3, una tela diversa da 1960×1248). Expected: Lighting **12/12**; `details` exit 0, con la previsione del Task 5 (può cambiare ordine solo il gruppo del layer 1: 'Layer shadow on screen' al più 0,001 come stampato, gli altri cinque uguali); gli altri tab come prima (Input 2/6 con 4 ⏳, gli skip noti di Primitives, Rendering FX e Debug Tools, 2D Twins 5/6 in B e 6/6 in C); console con solo il 404 di `favicon.ico`.
- [ ] **Step 5: Mode A.** `tab-runner.js` su una pagina nuova `"http://localhost:5173/?mode=A&bench"` (l'header del runner chiede una pagina `?bench`, e così sono state prese la riga datata di Mode A della skill e `harness-m2-A.json` del passo 6) → `harness-m2-A.json`: nessun `fail`, Lighting **4/12 · 8 skipped**, 17 pass, 42 skip e 4 in attesa sui 63 check. Poi `scene` fasi 1-3 (`resize` false), su una pagina appena caricata alla finestra 1200×689 per ciascun modo, `?mode=A&bench` e `?mode=B&bench` (in Mode A la fase 1 è il primo task della pagina, e le fasi 2-3 cambiano le stesse entità): `take_screenshot` (`modeA-vs-B/{A,B}-<fase>.png`), `map-modeA.js`/`map-modeB.js`, `pixels.py` sui `points` (`modeA-vs-B/pixels.json`). Expected: in B `maxDiff` ≤ 0,002; A, B ed `expected8` entro 2/255 l'uno dall'altro (la fase 3 mostra Q, l'id più alto, con lo slot sotto P: il banco lancia altrimenti); console di A con solo adapter, modo e il 404. In Mode A la fase 3 controlla anche che `entityIds` arrivi al render worker: lo spareggio della lista dipende da lì.
- [ ] **Step 6: cancello M4 e base nuova.** `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js` sui 10 tab e `statuses`, come in M4 (README del Mac §M4, "Procedura"), in `?mode=B&bench` e `?mode=C&bench` → `docs/plans/assets/2026-10-08-step7/baseline/`; poi `node docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs --base docs/plans/assets/2026-09-30-step6/baseline --run docs/plans/assets/2026-10-08-step7/baseline --mode B --step 0 > docs/plans/assets/2026-10-08-step7/baseline/compare-B.txt`, e lo stesso con `--mode C` in `compare-C.txt`. Expected: `FAIL` per il solo "mover ids differ" di twin-2d, ogni id + 5 (178-181 → 183-186); nessun punto di C diverso o instabile nuovo; stati `OK`. Nel README del Mac, §M4, "Uso come cancello", il punto "**Base dal passo 7 (<data>, `<sha>`).**": da qui `--base` è `docs/plans/assets/2026-10-08-step7/baseline`, perché la sotto-scena crea altre 5 entità, e `compare-{B,C}.txt` mostrano che nient'altro è cambiato.
- [ ] **Step 7: commit** di `docs/plans/assets/2026-10-08-step7/` e del README: `test(7): verifica GPU sul Mac (B e C col probe, A da screenshot), add e sub al bit contro master, stabilità dell'ordine, cancello M4 ricatturato`.

### Task 10: numeri nei documenti, auditor, preflight completo, merge, memoria, rapporto

- [ ] **Step 1: CLAUDE.md.** Conteggi vitest (`:66`, `:73`, `:79`: 115 file, 2089 + 7, `lighting-api.test.ts` 24). Dopo la riga del passo 6 (`:802`): "| 7 (round 2026-09-27) | One light list + the mix blend | `deriveLightGroups` builds the light list (`lightOrder`/`lightIds`: exact cull test; blend class, `sortableZBits` of world z, external id); `LightAccumStage`: ONE pipeline with `LIGHT_BLEND`, a stage-private grow-only `light-order` buffer, one direct `drawIndexed` per group (no `LIGHT2D_ARG_SLOTS`, no `indirect-first-instance`); mix = (color·w, w); `FrameState.entityIds`; add and sub bit-identical to master on the M2; Lighting +3 checks (<dettagli del Task 9, in inglese>). Measured on master: <la frase del ramo> |". Gotcha di Mode A (`:495`): "(at `c19cc6a`, 2026-10-06: 17 pass, 39 skips, 4 pending over the 60 checks, Lighting 4/9, the 39 being the 33 of M6 plus the 3 bezier checks and the 3 directional-shadow checks added since)" → "(at `<sha>`, <data>: 17 pass, 42 skips, 4 pending over the 63 checks, Lighting 4/12, the 42 being the 33 of M6 plus the 3 bezier checks, the 3 directional-shadow checks and the 3 light-list and mix checks added since)", coi conteggi misurati al Task 9. `:784`: "60 checks" → "63 checks". Riga di `demo/lighting-mix.ts`, in fondo: "; the Mac pixel gate's base is therefore `docs/plans/assets/2026-10-08-step7/baseline/` (re-captured at `<sha>`; against step 6's it differs only in those ids)". La coda di `:360` (`demo/lighting-directional.ts`), "Its 5 entities take fresh ids, so the tabs after Lighting have ids 5 higher than at the M4 capture; the Mac pixel gate's base is therefore `docs/plans/assets/2026-09-30-step6/baseline/` (re-captured at the step-6 HEAD, `c19cc6a`; against M4's `run1` it differs only in those ids) |", diventa "Its 5 entities take fresh ids (5 of the 10 that the tabs after Lighting gained over the M4 capture by round step 7); `docs/plans/assets/2026-09-30-step6/baseline/` was the Mac pixel gate's base until round step 7, which re-captured it in `docs/plans/assets/2026-10-08-step7/baseline/` (see the `demo/lighting-mix.ts` row) |": così una riga sola nomina la base corrente. `:750`: "step 6 (directional shadows) is done and merged into master (2026-10-07, branch `feat/step6-directional-shadows`), and the next step is 7." → "steps 6 (directional shadows) and 7 (one light list, the mix blend) are done and merged into master (2026-10-07 and <data>), and the next step is 8.". `:752`: "Open: `sprite` lights and the `mix` blend (round steps 7-8);" → "Open: `sprite` lights (round step 8);", e " and 6 (directional shadows) are done" (con lo spazio iniziale) → ", 6 (directional shadows) and 7 (one light list, the mix blend) are done".
- [ ] **Step 2: skill `gpu-check`.** §7: la riga di Mode A misurata al Task 9, con data e HEAD; nel paragrafo "State that travels by message" (`:261-270`), una frase: "The light list's id tie-break (round step 7) needs `entityIds` in the render worker too: checked by the step-7 bench's `scene` phase 3 in `?mode=A&bench` (<data>, `<sha>`: at equal depths Q, the higher id, is in front of P, with its slot below P's)."; §4: se il `setupMs` di Lighting supera 7 s, l'attesa per Lighting sale a quel valore arrotondato al secondo.
- [ ] **Step 3: piano del giro.** Nel §4, dopo il bullet del passo 6: "- **Passo 7 (una lista per tutte le luci, blend mix) — fatto** (piano `2026-10-08-step7-light-order-mix-plan.md`; review `<wf-id>`: <esito>). Ogni Light2D che il test esatto del cull tiene entra in una lista costruita sulla CPU da `deriveLightGroups` (classe di blend, z di mondo dal fondo al davanti, id esterno). `LightAccumStage` la disegna con una sola pipeline «over» premoltiplicata (`LIGHT_BLEND`) e una `drawIndexed` diretta per gruppo dal suo buffer `light-order`, senza più `indirect-first-instance`, e il blend `mix` porta il light buffer verso colore × energia col peso dell'intensità, mentre add e sub restituiscono alpha 0 e restano al bit come `{one, one}`. Sotto-decisione 1: <risposta>; default `lightIds`: <esito>. Misurato su master: <la frase del ramo, coi numeri>. Verificato sul Mac (M2 Pro, Chrome <versione>) in B e C (Lighting 12/12, i check dei passi 3 e 6 entro 0,002, add e sub identici a master, `permute` 0 texel, stabilità: <esito>) e in A da screenshot; cancello M4 ricatturato. Cambia l'aspetto di scene, tape e snapshot con luci `mix` (prima sommate come `add`); senza mix cambia solo l'ordine di disegno, di pochi passi fp16 dove le luci si sovrappongono (il `maxSteps` di `permute` su master)." Sotto, "Registrati per il passo 9": la gamba Safari di `light-accum.wgsl` e della pipeline `LIGHT_BLEND` (se la sede della stabilità non era Safari; se lo era, c'è già `wgsl-safari.json`); il NaN al bordo di una luce a falloff 0 (rischio 7: `pow(0, 0)` quando `d/range` si arrotonda a 1, ora anche attraverso il `clamp` di un mix; preesistente per add); `opaque()` ("front-to-back sorting", `entity-handle.ts:367`, preesistente); `CameraAPI.zoom()` che riapplica near −1 e far 1000 (`camera-api.ts:41-55`, preesistente, tocca la decisione 4); la riga "Lato CPU" del design dei light layers (`:162`) mai rimisurata; la deriva preesistente dello Step 4. Nella §3, riga 7: "(fatto: §4)".
- [ ] **Step 3b: commit dei documenti** degli Step 1-3, prima dell'auditor, uno per file come al passo 6 (`a1fcee5`, `eb20de4`, `61e4108`):
  - `docs(7): CLAUDE.md — conteggi vitest, riga del passo 7, Mode A sui 63 check, base del cancello, stato del giro`;
  - `docs(7): skill gpu-check — la Mode A misurata al passo 7`;
  - `docs(7): piano del giro — passo 7 fatto, lista del passo 9`.

  Le correzioni dell'auditor (Step 4) restano nei loro commit `docs(7): claude-md-auditor — …`.
- [ ] **Step 4: `claude-md-auditor`** con la merge-base `1d19575` (o quella del Task 0): la deriva del passo si corregge (`docs(7): claude-md-auditor — <titolo>`), la preesistente va nella lista del passo 9.
- [ ] **Step 5: preflight completo.** `scripts/preflight.sh --full` e i tre `node:test` del Task 7: tutto `OK`, build WASM release e cancelli di dimensione compresi.
- [ ] **Step 6: merge e push** (autonomia del giro). `git status --short` è un cancello: deve stampare niente, altrimenti ci si ferma. CLAUDE.md e il piano del giro differiscono già fra il branch e master, quindi con una loro modifica non committata `git checkout master` rifiuterebbe, e un file che il branch non tocca finirebbe su master fuori dal merge:
```bash
git status --short
git checkout master && git pull --ff-only origin master
git merge --no-ff feat/step7-light-order-mix -m "Merge branch 'feat/step7-light-order-mix'" \
  -m "Passo 7 del giro: ogni luce si disegna da una lista ordinata sulla CPU (test esatto del cull; classe di blend, z di mondo, id esterno), con una sola pipeline «over» premoltiplicata e una draw diretta per gruppo; il blend mix (peso = intensità); add e sub identici a master; tre check col probe; banco e misura su master del riordino." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
git branch -d feat/step7-light-order-mix
```
Se il push fallisce per le credenziali (`osxkeychain`), il merge resta locale e lo si dice nel rapporto. Dopo il checkout, il dev server si riavvia prima di ogni controllo GPU.
- [ ] **Step 7: memoria** (`~/.claude/projects/-Users-edoardocicognani-Code-HyperionEngine/memory/`): `open-items-round-2026-09-27.md`, "**Step 7 DONE** (merged `<sha>`, pushed)" con review e stabilità, "NEXT: step 8 (write its plan first)", e la riga 21 dell'elenco "Order" ("7. L-b — mix as a second pipeline.", contraria alla decisione 2) diventa "7. L-b — one CPU-sorted light list, one premultiplied over pipeline, the mix blend (DONE)."; `MEMORY.md`, "steps 1-5, 5b, 6 and 7 merged (<sha>); order 8→8b→8c→10→9; NEXT = step 8"; `round-pending-decisions.md`: lista D (sessione Fedora: la base AMD del 5b, id più alti di 10; sessione Mac/Safari: `light-accum.wgsl` e `LIGHT_BLEND` in WebKit, se il passo 7 non li ha già validati in Safari; in "Backlog" il rischio 10, togliere le luci dai bucket del cull, con una misura, e il rischio 9, un radix in JS per la lista; in "Latent bugs no step owns" il rischio 7, il NaN di `pow(0, 0)` al bordo di una luce a falloff 0, ora anche attraverso il `clamp` di un mix, preesistente per add) e lista E (le risposte di questo passo).
- [ ] **Step 8: rapporto finale al proprietario** (in italiano): sotto-decisione 1 e ramo, coi numeri su master; il default `lightIds`; add e sub identici a master; i tre check e i loro dettagli; la stabilità; A contro B (percorsi assoluti); il cancello M4 ricatturato e perché; review e correzioni; SHA del merge e push; la lista per il passo 9.

## Rischi e punti aperti

1. **Add e sub al bit.** Il testo dell'aritmetica è lo stesso, ma la coda di `fs_main` ha un ramo in più e il compilatore di Metal potrebbe schedulare in un altro modo (contrazioni FMA). Il cancello `regress` è al bit su 2304 punti per layer, e le gambe «stadio» (lo shader di master nello stadio nuovo) e «shader» (il passo 7 contro lo shader di master, sulla stessa pagina) separano lo stadio (blend state, ordine, draw diretta) dallo shader; master si ricattura nella stessa sessione (Task 9), perché il compilatore viene col sistema. Un punto diverso si indaga; se la causa è solo nella compilazione, lo si riporta al proprietario coi numeri, senza allentare il cancello.
2. **Cambi d'aspetto voluti.** Su master una luce `.transparent()` o con texture di tier > 0 andava dopo le altre (ordine dei bucket 12, 13, 26, 27), e un `mix` si sommava come un `add`. Ora le `add` sovrapposte, `.transparent()` o con texture comprese, cambiano di pochi passi fp16 (1-2 con tre luci: il `maxSteps` di `permute` su master, Task 1): su master ogni blend era additivo (`light-accum.wgsl:358-363` nega solo il sub, e una sola pipeline `{one, one}` disegnava i quattro bucket). Scene, tape e snapshot cambiano davvero solo con luci `mix`, prima sommate come `add`. Il rendering non è in `state_hash` (design 17 §10.4).
3. **Chrome potrebbe non riordinare.** Allora la sede è Safari, per il criterio stesso; la sotto-decisione 1 chiede solo se prima conti il percorso atomico forzato in Chrome. Il Task 1 lo misura prima di tutto. Se l'osservabile fp16 è cieco (`permute` con `changed` 0 su master), ci si ferma e lo si riporta.
4. **Colonna degli id mancante o corta.** Si ripiega sugli slot, tutto o niente: l'ordine resta fermo da un frame all'altro, ma non attraverso un despawn. È un difetto di trasporto, che `uploadEntityIds` segnala una volta in dev.
5. **La trappola near/far** (decisione 4) è documentata. Preesistente: `CameraAPI.zoom()` riapplica near −1 e far 1000 e perde un near/far personalizzato (lista del passo 9).
6. **Buffer non clampato.** Dopo un `sub` che toglie più di quanto c'è, il buffer va sotto zero, e un `mix` successivo parte da lì. È documentato; clampare cambierebbe add e sub.
7. **NaN al bordo di una luce a falloff 0.** Se `d/range` si arrotonda a 1 mentre d < range, `pow(0, 0)` calcolato come `exp2(0 · log2 0)` dà NaN. Con un `add` succedeva già prima; con un `mix` passa da `clamp`, che su un NaN dipende dall'implementazione. Riguarda solo texel a meno di range·2⁻²⁴ dal bordo: nessun punto dei check. Non si corregge nel passo. Accanto: un `mix` a peso pieno non ripara un texel non finito, perché `c·1 + dst·0` con dst ±Inf o NaN dà NaN (un `add` oltre 65504, il massimo del half float, su un hardware che arrotonda a infinito, o questo NaN); è nel JSDoc di `LightBlendMode` (Task 4).
8. **Tipi riservati e sprite** entrano nella lista come oggi li disegna il cull. La sprite la scarta `fs_main` fino al passo 8. Una luce di tipo 5-7, raggiungibile solo con un `SetLightFlags` costruito a mano (Rust maschera il campo a 3 bit e tiene 5-7, `command_processor.rs:1040-1043`), si disegna come un quadrato a intensità piena di lato 2·range: niente disco né falloff, perché il discard di `d >= range` e il falloff stanno solo nel ramo POINT/SPOT di `fs_main` (`light-accum.wgsl:324-332` a HEAD); da `mix` sostituisce tutto quel quadrato.
9. **Costo della lista:** +0,03 ms con 300 luci, +0,12 ms con 1000; 2,1 ms a 10 000 (un radix in JS 0,38: backlog).
10. **Bucket morti** del cull per le luci: toglierli è backlog, con una misura.
11. **Readout di Mode A:** `engine.lighting.groups` usa la camera del main thread, come già per i gruppi.
12. **Id dei tab dopo Lighting** più alti di 5: il cancello M4 si ricattura (Task 9), la base AMD del 5b (+10) alla prossima sessione Fedora.
13. **Safari.** `light-accum.wgsl` e la pipeline con `LIGHT_BLEND` in WebKit li controlla il passo 9; se la sede della stabilità è Safari, il Task 9 li valida prima delle sue corse (`wgsl-safari.json`, `light-groups` nel grafo live), perché WebDriver non legge la console di Safari e un grafo lit rifiutato resterebbe spento senza traccia.
14. **Il profiler:** con la lista vuota il pass di accumulo non fa draw, e il profiler ne ignora la coppia (prima le 4 draw indirette contavano sempre come lavoro).
15. **Il fallback senza `lightGroups`** non disegna luci: un percorso futuro che accendesse il grafo lit senza di loro le perderebbe in silenzio (lo dicono il doc di `EVERYTHING` e il suo test).
16. **L'alpha del light buffer resta 1:** nessuno la legge, e non porterebbe il peso del `mix`.

## Sotto-decisioni per il proprietario

Si chiede la sotto-decisione 1, una domanda interpretativa sulla sede che il criterio già fissa, allo Step 0 del Task 0, prima del Task 1, insieme al default qui sotto; le risposte vanno nel §2 del piano del giro. Le decisioni del §2 e le risposte già nella lista E della memoria non si richiedono.

1. **Il percorso atomico del cull, forzato in Chrome, conta come «dove il cull riordina davvero»?** La sede della stabilità su N frame la fissa il criterio approvato (§3, riga 7: "Safari, oppure luci a ≥256 slot di distanza"): Chrome con le luci a ≥ 256 slot, se il Task 1 mostra che lì su master il cull le riordina; altrimenti Safari, nel passo 7. Resta un punto interpretativo, da registrare nel §2 come interpretazione della riga 7: prima di ripiegare su Safari, una corsa col percorso atomico del cull forzato in Chrome sull'M2 (`CullPass.SUBGROUP_CONFIG.useSubgroups = false` più `recompileShader('cull', …)`, a `apart` 1 e 256) vale come sede?
   - (a) **sì:** se il percorso atomico riordina, la sede è Chrome con quel percorso; se no, Safari nel passo 7, con un driver safaridriver minimo nello spazio SDD (quello definitivo lo committa il passo 9);
   - (b) **no:** se Chrome non riordina col suo percorso a subgroup, subito Safari nel passo 7, con lo stesso driver.

   Rinviare la stabilità al passo 9 non è un'opzione di questo piano: il passo 7 si chiuderebbe senza un punto del criterio approvato. Se il proprietario lo vuole, è un emendamento: riscrive lui la riga 7 del §3, e il Task 10 non scrive "(fatto: §4)" sul testo originale.

   Raccomandazione: **(a)**. Il percorso atomico è quello che gira dove i subgroup a 32 lane non ci sono, cioè su Safari (nessun subgroup) e sull'iGPU AMD (32-64): forzarlo misura lo stesso codice sullo stesso GPU senza tooling nuovo, ed è una sede dove il cull riordina davvero, se riordina. Safari resta l'ultima risorsa, e il passo non si chiude senza il punto del criterio. Il ramo scelto agisce al Task 1 (Step 4 e Step 5), al Task 9 (Step 3), e nei testi dei Task 6, 8 e 10.

**Default del piano, rifiutabile:** `LightGroups` porta `lightIds` accanto a `lightOrder`. Costa un `Uint32Array` per frame e rende leggibile l'ordine nel readout, nei test (`drawn()`) e nel banco (`list`). Se il proprietario lo rifiuta, `lightIds` esce da:
- `LightGroups` e `orderLights` (Task 2);
- `EVERYTHING` in `light-groups-pass.ts` e `groups()` di `light-groups-pass.test.ts` (Task 2 e 3);
- il JSDoc di `groups` (Task 4);
- i testi del Task 6 (CLAUDE.md punti 3 e 6, design dei light layers `:52` e `:78`).

Inoltre `drawn` mappa `lightOrder` attraverso `input.entityIds` col ripiego tutto-o-niente, i test 1 e 12 di `light-groups.test.ts` e i due di `lighting-api` controllano solo `lightOrder`, e il banco registra solo gli slot.

