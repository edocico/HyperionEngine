# Passo 6 del giro — ombre directional (L-c): piano di implementazione

> **Per chi esegue:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (consigliato) oppure superpowers:executing-plans, un task alla volta. Gli step usano le checkbox (`- [ ]`).

HEAD `2f43e42` (master, pulito), 2026-09-30. Branch `feat/step6-directional-shadows`, base `2f43e42`. Ogni `file:riga` di questo piano è verificato a quel HEAD.

**Goal:** una luce `directional` con `shadowIntensity > 0` proietta ombre. Splende verso il suo asse +x locale, con la stessa regola dello spot. L'ombra di ogni caster è lunga quanto il `range` della luce e sfuma verso la fine, con la penombra fissa `u.sourceFraction`. La marcia si ferma a min(range, uscita dall'SDF) e oltre l'SDF conta come illuminato. Le luci `global` non proiettano ombre nel backend `lit`: lo dicono il JSDoc e un avviso dev del renderer. Point e spot restano identici al bit (con la risposta (b) alla sotto-decisione 3, solo quelli col centro in vista).

**Architettura:**
1. `light-accum.wgsl`. `shadow()` diventa la marcia condivisa (origine, direzione, percorso, angolo, sfumatura) con due prologhi: `pointShadow`, cioè il prologo di oggi parola per parola, e `sunShadow`. `lightFacing` è l'asse +x condiviso da spot e sole. `vs_main` calcola una volta per luce il raggio del sole in texel dell'SDF (`directionalRay`, varying flat), per cui il binding 5 diventa visibile anche al vertex stage. Il gate dei tipi ombreggiati è una funzione sola, `shadowedLightType`, e lo slot 7 si legge una volta.
2. `light-groups.ts` conta le directional ombreggiate **nello stesso commit** (`SHADOWED_LIGHT_TYPES`), e un test di testo lega i due gate. Un flag `shadowedGlobalLight` alimenta l'avviso del renderer.
3. Il JSDoc dell'API.
4. Tre check col probe nel tab Lighting, su una sotto-scena lontana dalla scena del tab. Le sue 5 entità alzano di 5 gli id dei tab successivi: la base del cancello di pixel M4 si ricattura (Task 5 e Task 10).
5. Uno script di benchmark committato (scena statica, regressione point/spot, A/B dell'angolo con la cattura di tutto il light buffer per i soli allineati agli assi, comparsa al bordo, costo a due coppie; fuori dal criterio, il costo di point e spot senza sole e la gamba Chrome dell'A/B dell'uber del 5b) più un modulo di statistica e il modello CPU della marcia, ciascuno con i suoi test.

Nessuna modifica a Rust, al protocollo, a `LightUniform` (80 B), a `LIGHT_SOURCE_FRACTION` (0,02) o a `SHADOW_HARDNESS` (8).

**Tech stack:** TypeScript + Vite + vitest (Node 24), WGSL/WebGPU (Chrome 154 su Metal, Apple M2 Pro), `naga-cli` 30.0.1, `node:test`, MCP `chrome-devtools-gpu`.

**Decisioni, da non richiedere** (piano del giro `docs/plans/2026-09-27-open-items-round-plan.md`, §2 "Passo 6 — deciso (2026-09-30)" e §3 riga 6; ricerche `wf_c4b94385-585`, etichette G4, G3 e coverage-critic):
- **Direzione:** asse +x locale (`m[0].xy`), come lo spot, con un helper condiviso e un test di testo che lega le due luci. Il JSDoc documenta l'asse di entrambe: `rotation(-Math.PI/2)` splende verso il basso (il mondo è y-up) e una scala x negativa specchia.
- **Penombra:** angolo fisso `u.sourceFraction` (0,02 rad). Uniform e API non cambiano. Il valore si conferma con un A/B su GPU di 2-3 angoli a 48 passi, su raggi di sole lunghi quanto lo schermo.
- **Lunghezza:** `range` (slot 3, default 100), con sfumatura verso la fine. La marcia finisce a min(range, uscita dall'SDF) e oltre l'SDF è illuminato: niente estrapolazione all'infinito.
- **`sdfOversize`:** fuori dal passo. Un check col probe misura la comparsa dell'ombra al bordo dal lato del sole; si decide al passo 8c.
- **`global`:** niente ombre nel backend `lit`. Servono il JSDoc e un avviso dev emesso una volta dal renderer tramite un flag di `deriveLightGroups`, come `multiBitReceiver`. Il "per ora" del design dei light layers diventa definitivo per il backend `lit`.
- **Criterio d'uscita** (approvato):
  - test in `light-groups.test.ts` più il test di testo sui gate;
  - con il probe, un sole dietro un muro scurisce il lato lontano;
  - un check misura la comparsa al bordo;
  - i check point/spot del passo 3 restano invariati;
  - una riga M2 nel §13.2 del design 17: A/B dello span a 1920×1080 su una scena `?bench` statica committata, timestamp non quantizzati, Mac all'alimentatore, altro browser fermo, due coppie, media ± SE con limite t a n−1 gradi di libertà. "Sotto la risoluzione, < X ms" vale come esito. La riga AMD è facoltativa.

**Prototipo, fatto durante la stesura.**
- Lo shader finale di questo piano (Task 1 + Task 2) è stato scritto in una copia fuori dal repo e validato con naga 30.0.1 (`Validation successful`). L'analizzatore `ts/src/shaders/wgsl-analysis.ts`, eseguito su quella copia, conferma le proprietà che i test del piano fissano:
  - `vs_main` raggiunge `sdf`;
  - `[0].xy` compare una sola volta;
  - i tre `select` su `fading` hanno come operando falso `0.0`, `q`, `q`;
  - nessun locale oscura un nome di modulo.
- Durante la revisione del piano, sulla stessa copia: la `directionalRay` col prodotto `range · texel` limitato e la variante (b) della sotto-decisione 3 passano naga; l'asserzione sui rami del gate (Task 2) passa sul prototipo e fallisce se `SPRITE` entra in `shadowedLightType` senza un ramo di marcia in `fs_main`.
- Un modello CPU della marcia ha controllato la geometria dei check del Task 5 e ha previsto gli esiti del Task 6, compresa la griglia di tutto il light buffer: vedi "Rischi e punti aperti" e le sotto-decisioni. L'SDF è una trasformata di distanza esatta (Felzenszwalb) dei semi ritagliati alla vista, sui texel del light buffer a metà risoluzione; la marcia ha la stessa aritmetica dello shader, in f64. Si committa al Task 5 (Step 0) come `docs/plans/assets/2026-09-30-step6/march-model.mjs`, con un `node:test` che fissa i numeri citati in questo piano. Il sorgente della stesura è `sim/march.mjs` nello scratchpad della sessione che ha scritto il piano; se non c'è più, lo si riscrive da questa descrizione, e i test dicono se torna.

## Vincoli globali

- **Point e spot invariati.** Il prologo di `pointShadow` è il codice di `light-accum.wgsl:121-130` parola per parola. Nella marcia condivisa ogni termine nuovo passa per `select(<valore di prima>, <valore del sole>, fading)` con `fading = fadeReach > 0.0`, e `pointShadow` passa `fadeReach = 0.0`. Mai `mix(1.0, q, w)` né `1.0 - w * (1.0 - q)` al posto di `q`: in f32 non sono l'identità. `sunFade(t, 0.0)` restituisce 1.0 prima di ogni `smoothstep`, così `smoothstep` non vede mai estremi uguali. Con la risposta (a) alla sotto-decisione 3 (raccomandata), la marcia point/spot **non** si ferma all'uscita dall'SDF: una luce col centro fuori schermo continua a marciare nella riga di bordo clampata, come oggi, e la cosa passa al passo 8c. Con (b), `pointShadow` passa `min(travel, exitDistance(origin, dir, fsize))`, e l'identità al bit vale per le luci col centro in vista.
- **Uniform e layout.** `LightUniform` resta di 80 B, senza padding interno (`uniform-layout.test.ts`). Restano invariati anche `LIGHT_UNIFORM_SIZE` e `minBindingSize: 80`, le fette da 256 B scritte una volta in `prepare()` e i valori scritti a 64/68/72/76. Nessun binding nuovo. L'unica modifica al layout è la visibilità del binding 5 (l'SDF), che diventa `VERTEX | FRAGMENT` (`light-accum-stage.ts:102`), perché `vs_main` chiama `textureDimensions(sdf)`. È una query, non un campionamento: la regola `textureSampleLevel` fuori dal fragment non si applica, e l'SDF si legge solo con `textureLoad`.
- **Regole della marcia (gotcha di CLAUDE.md, vincolanti).** Valgono per ogni tipo di luce:
  - (1) angolo apparente: `min(1/k, sourceRadius / D)` per point/spot; per il sole un angolo costante, `u.sourceFraction`, mai 1/k. Nel termine di Quilez l'angolo è la larghezza della penombra per unità di distanza: una rampa larga angolo·t, cioè circa il **diametro** angolare della sorgente (0,02 rad ≈ 1,15°), non il raggio;
  - (2) un pixel dentro un occluder ne esce, e la penombra si misura da lì;
  - (3) finiti i passi, l'ultima distanza libera si estrapola fino alla fine del raggio: per il sole `travel = min(range, uscita)`, mai l'infinito;
  - (4) nuova: il sole si ferma all'uscita dall'SDF, e oltre è illuminato. Nessun campione fuori da `[0, size)`.
  - L'SDF deve raggiungere tutta la texture (`SdfChainStage`, invariato): un texel non raggiunto (`valid = 0` → 1e6) farebbe saltare la marcia oltre `travel`.
- **Gruppi di binding.** `light-accum.wgsl` resta un modulo autonomo con il solo gruppo 0. Il vincolo "gruppo 2 raggiungibile solo da `fs_main`" riguarda i moduli composti delle primitive, che il passo non tocca.
- **Niente infiniti né NaN in WGSL.** Va limitato il **prodotto** `range · texel`, non solo `range`: `CameraAPI.zoom` non ha limite superiore (`camera-api.ts:42`), quindi i texel per unità possono essere enormi, e `min(range * texels, 1e30)` traboccherebbe già nella moltiplicazione. Si scrive `min(max(range, 0.0), 1e30 / texels) * texels`: con `texels` ≥ 1e-6 il quoziente è finito e il prodotto resta ≤ 1e30. L'uscita usa la sentinella `1e30`; una camera degenere (texel per unità < 1e-6) dà raggio nullo, quindi luce piena.
- **Gate TS e WGSL nello stesso commit** (Task 2): se lo shader ombreggia un sole che `light-groups.ts` non conta, il suo gruppo non ha un SDF set e il sole non ombreggia mai, in silenzio.
- **Global:** lo slot 7 continua ad arrivare dal filo (`light()` e `shadows()` non lo normalizzano), perché il flag del renderer lo deve vedere. L'avviso è solo dev (`if (dev && …)`, come `renderer.ts:908`), una volta per renderer.
- **Harness:** la scena del tab Lighting e i suoi check del passo 3 ('Lit vs unlit', 'Layer shadow on screen', 'Light layers') restano invariati nel codice e nelle soglie. I check del sole girano su una sotto-scena lontana (Task 5), distrutta prima che le luci del tab comincino a muoversi. Le sue 5 entità prendono id freschi, quindi i tab dopo Lighting hanno id più alti di 5: la base del cancello M4 si ricattura al Task 10 (scelta motivata al Task 5, "Id delle entità").
- **Lingua:** i documenti in `docs/` in italiano; codice, JSDoc, commenti, CLAUDE.md e JSON in inglese. Commit `<tipo>(6): <descrizione in italiano>`, riga vuota, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Almeno un commit per task.
- **Comandi.**
  - Un file TS: `npx --prefix ts vitest run --root ts src/<path>.test.ts`.
  - Tutto: `npm --prefix ts test`.
  - Tipi: `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`.
  - naga su un file: `D="$(mktemp -d)"; cp <file> "$D/"; node scripts/validate-wgsl-naga.mjs "$D"`.
  - `node:test`: `node --test <file>`.
  - Validazione: `scripts/preflight.sh` (`--full` al Task 12).
  - Mai `grep -P`; i glob di `--include` sempre tra virgolette; ogni URL con `?` tra virgolette.
- **GPU (Mac).**
  - Skill `/gpu-check`, §3 Mac e §7 Mode A.
  - Le misure di tempo si prendono solo su **chrome-devtools-gpu**: la riga dell'adapter dev'essere `apple / metal-3 / 0x0000, subgroups 32-32`.
  - Si naviga con l'`initScript` anti-reload della skill e con `ignoreCache: true`.
  - Il dev server si riavvia dopo ogni checkout o merge che riscrive uno shader.
  - `npm --prefix ts run build:wasm` solo se l'hook `guard-stale-wasm` lo segnala: il passo non tocca Rust.
  - Nessun probe della swapchain prima o durante le misure di tempo.
  - `window.__hyperion` è il facade nelle build di dev.
- **Fuori dal passo:**
  - `sdfOversize` e ogni padding (8c);
  - un angolo per luce (backlog, stesso default);
  - l'uscita dall'SDF per point/spot (8c, con la risposta (a) alla sotto-decisione 3);
  - `sprite` e `mix` (passi 8 e 7);
  - la gamba Safari (passo 9);
  - la riga AMD (prossima sessione Fedora, facoltativa);
  - l'A/B senza codice dell'uber del 5b (design 5b §11): la sua gamba Chrome gira nella sessione del Task 11, fuori dal criterio e in un JSON suo; la gamba Safari passa al passo 9.

## Review Focus

1. **Segni del raggio del sole.** Il raggio verso la luce è `-lightFacing`, proiettato con w = 0 e con la y ribaltata come in `toScreenUV`. `rotation(-Math.PI/2)` deve gettare le ombre verso il **basso** dello schermo. Coperto da: il test di testo su `directionalRay` (Task 2); sulla GPU il check 'Directional shadow', con un sole a −30° e i due punti specchiati, che fallisce con un messaggio diverso per la marcia rovesciata, la y ribaltata e la x ribaltata (Task 5, verdetto testato con fixture); il cancello rapido del Task 2 (sole a −π/2).
2. **Point/spot al bit.** Coperto da: `select` con `q`/`0.0` come operando falso, verificato dal test del Task 1; sulla GPU la cattura `regress` confronta 2304 punti del light buffer con lo shader di `2f43e42` ricaricato a caldo nella stessa pagina (Task 6 e Task 10). Tolleranza: 1 ULP fp16; atteso identico. Con la risposta (b) alla sotto-decisione 3 l'identità vale per le luci col centro in vista, e la point col centro fuori schermo ha un confronto a parte con cambiamento atteso (solo più chiara). Il costo per point e spot senza sole si misura a parte, fuori dal criterio (coppia `pointspot`, Task 11).
3. **La regola d'uscita.** `travel = min(range·texel, uscita dal rettangolo)`. Casi limite: un gruppo senza set, che lega l'SDF 1×1 "nessun occluder"; `range` ≤ 0 o enorme; uno zoom enorme (il prodotto `range·texel` si limita senza calcolarlo prima); camera degenere. Coperto dai test di testo di `sunShadow`/`exitDistance` (Task 2) e sulla GPU dal punto E del check 'Directional edge pop (measured)': se la marcia legge oltre l'SDF, E vale ~0,2 del sole invece di 1 (modello CPU, Task 5).
4. **Coerenza dei gate.** `shadowedLightType` (WGSL) deve coincidere con `SHADOWED_LIGHT_TYPES` (TS), stesso commit. Lo slot 7 si legge una volta sola. Le `global` sono segnalate, non ombreggiate. Coperto dal test che lega i due gate, anche nel comportamento su tutti gli 8 tipi e nei rami di `fs_main` (ogni tipo del gate ha un ramo che marcia, e non c'è altra marcia: un tipo aggiunto ai due gate senza il suo ramo, come potrebbe capitare alla sprite del passo 8, fa fallire il test), e da 'a shadowed directional light gets an SDF set like a point, wherever its transform is' (Task 2); sulla GPU dal check 'Directional shadow', che richiede 1 gruppo e 1 SDF set nella sotto-scena, dove il sole è l'unica luce ombreggiata.
5. **I check nuovi.** Devono fallire sui difetti che dichiarano, andare in skip in Mode A senza effetti collaterali, distruggere le proprie entità, rimettere la camera e lasciare invariati i check del passo 3 e lo stato stabile di M9. Gli id dei tab successivi crescono di 5, e nient'altro cambia. Coperto da: `lighting-directional.test.ts` (Task 5); le corse dell'harness in B, C e A, con i dettagli del passo 3 confrontati numericamente con la base M4, e il cancello M4 ricatturato (Task 10).

## Struttura dei file

| File | Azione | Responsabilità | Task |
|---|---|---|---|
| `ts/src/shaders/light-accum.wgsl` | modifica | `lightFacing`, `sunFade`, `shadow()` generalizzata, `pointShadow` (T1); `directionalRay`, varying `sunRay`, `exitDistance`, `sunShadow`, `shadowedLightType`, ramo directional, header (T2); con la sotto-decisione 2 (b), il budget doppio del sole (T6) | 1, 2, 6 |
| `ts/src/render/passes/light-accum-stage.ts` | modifica | binding 5 `VERTEX \| FRAGMENT`; doc di `LIGHT_SOURCE_FRACTION`, di `SHADOW_HARDNESS` e della classe (T2); rimando all'A/B (T6) | 2, 6 |
| `ts/src/render/passes/light-accum-stage.test.ts` | modifica | test della marcia riscritti su `functionBody`, asse condiviso, sfumatura (T1); visibilità dei binding, raggio del sole col prodotto limitato, uscita, gate, e con la sotto-decisione 3 (b) l'uscita di point e spot (T2); con la sotto-decisione 2 (b), i passi come parametro (T6) | 1, 2, 6 |
| `ts/src/render/light-groups.ts` | modifica | `SHADOWED_LIGHT_TYPES` e gate (T2); `shadowedGlobalLight` (T3) | 2, 3 |
| `ts/src/render/light-groups.test.ts` | modifica | sole ombreggiato, maschera del sole, legame dei gate, anche con i rami di marcia di `fs_main` (helper `branches`) (T2); luce globale, avviso nel renderer (T3) | 2, 3 |
| `ts/src/render/passes/light-groups-pass.ts` | modifica | `shadowedGlobalLight: false` nel letterale `EVERYTHING` | 3 |
| `ts/src/render/passes/light-groups-pass.test.ts` | modifica | lo stesso campo nell'helper `groups()` | 3 |
| `ts/src/renderer.ts` | modifica | avviso dev, una volta, per una luce globale con ombra | 3 |
| `ts/src/lighting-api.ts` (+ `.test.ts`) | modifica | JSDoc di `groups` (T3) e di `setAmbient` (T4); test del flag (T3); JSDoc di `shadowSteps` secondo la sotto-decisione 2 (T6) | 3, 4, 6 |
| `ts/src/entity-handle.ts` (+ `.test.ts`) | modifica | JSDoc di `LightType`, `LightOptions`, `rotation()`, `light()`, `shadows()`, `castsShadow()`; due test di caratterizzazione del filo (T4); con la sotto-decisione 2 (a), il caso allineato agli assi nel JSDoc di `LightType` (T6) | 4, 6 |
| `ts/src/prim-params-schema.ts` | modifica | commento degli slot Light2D | 4 |
| `ts/src/demo/probe-checks.ts` (+ `.test.ts`) | modifica | `viewBounds(vp)` | 5 |
| `ts/src/demo/lighting-directional.ts` | crea | sotto-scena del sole, tre check, verdetti puri | 5 |
| `ts/src/demo/lighting-directional.test.ts` | crea | verdetti con fixture, Mode A finta | 5 |
| `ts/src/demo/lighting.ts` | modifica | costanti `AMBIENT`/`GLOBAL_LIGHT`, `fitView`/`frames` importati, chiamata a `checkDirectional`, etichetta | 5 |
| `docs/plans/assets/2026-09-30-step6/march-model.mjs` (+ `march-model.test.mjs`) | crea | il modello CPU della marcia (SDF esatto dei semi ritagliati alla vista, stessa aritmetica dello shader) e un `node:test` sui numeri che il piano cita | 5 |
| `docs/plans/assets/2026-09-30-step6/step6-stats.mjs` (+ `step6-stats.test.mjs`) | crea | statistica offline: ABBA + limite t, larghezze di penombra, errori, riassunto delle griglie, comparsa al bordo, confronto delle griglie; verdetti in inglese | 6 |
| `docs/plans/assets/2026-09-30-step6-directional-bench.js` | crea | corpo di un `evaluate_script`: task `scene`, `regress`, `penumbra` (anche la griglia di tutto il light buffer), `edgepop`, `cost` (coppie `march`, `set`, e fuori dal criterio `pointspot` e `uber`) | 6 |
| `docs/plans/assets/2026-09-30-step6/*.json`, `*.png` | crea | A/B dell'angolo e griglia (T6); regressione, harness con metadati, avviso delle global, comparsa al bordo, Mode A contro B (T10); costo e A/B dell'uber, gamba Chrome (T11) | 6, 10, 11 |
| `docs/plans/assets/2026-09-30-step6/baseline/` | crea | base nuova del cancello M4 (catture B e C, `compare-{B,C}.txt` contro `run1`) | 10 |
| `docs/plans/assets/2026-09-29-mac-m2/README.md` | modifica | §M4, "Uso come cancello": la base nuova dal passo 6 | 10 |
| `docs/plans/2026-08-04-phase17-lighting-2d-design.md` | modifica | §4-B:221, E2:470, :488, §7.3:571 + nota nuova, §9.2:762, §11 e :876, :944, :952 (T7); §13.2 riga M2 e §17 punto 1 (T12) | 7, 12 |
| `docs/plans/2026-09-26-phase17-light-layer-groups-design.md` | modifica | righe 53 e 224 | 7 |
| `docs/plans/2026-09-27-transparent-sort-uber-design.md` | modifica | §11, dopo `:791`: la gamba Chrome dell'A/B dell'uber | 12 |
| `CLAUDE.md` | modifica | righe dei moduli e gotcha (T7); conteggi, riga di fase, numeri, base del cancello (T12) | 7, 12 |
| `.claude/skills/gpu-check/SKILL.md` | modifica | riga Mode A del tab Lighting, rimisurata; attesa del tab | 12 |
| `docs/plans/2026-09-27-open-items-round-plan.md` | modifica | §2 "Passo 6": le risposte alle sotto-decisioni (T0); §4 "Passo 6 — fatto", la voce del 5b, la riga 8c (T12) | 0, 12 |

## Task

Quattro gruppi: il codice (Task 0-4, con le tre sotto-decisioni chieste al Task 0 e un cancello GPU rapido al Task 2), i check dell'harness e il banco (Task 5-6, che usano la GPU del Mac), documenti e revisione (Task 7-9), verifica finale, costo e merge (Task 10-12).

### Task 0: branch e base verde

- [ ] **Step 0: le tre sotto-decisioni, prima del Task 1.** Sono decisioni di design del passo, e la regola del giro (memoria `feedback-autonomous-round`) le vuole chieste prima di cominciare. Si chiedono al proprietario le tre sotto-decisioni in fondo al piano, ciascuna con i numeri del modello CPU che il suo testo riporta. Il modello prevede già che la 2 scatti, e proprio sull'esempio del JSDoc (`rotation(-Math.PI/2)`): chiederla solo quando l'A/B del Task 6 la fa scattare vorrebbe dire fermarsi in mezzo a una sessione GPU. Insieme si presenta un default del piano che il proprietario può rifiutare: `SUN_FADE_START = 0,75`, cioè forza piena per i primi 3/4 dell'ombra e poi una smoothstep fino a 0. Il §2 dice solo "sfuma a 0 verso la fine", e gli screenshot 0,75 contro 0 arrivano al Task 6.
  - Non si comincia il Task 1 senza le tre risposte.
  - Le risposte, e il default con l'eventuale veto, si registrano nel §2 del piano del giro, sotto "Passo 6 — deciso (2026-09-30)", come bullet "**Sotto-decisioni del piano del passo 6** (<data>)", nel primo commit del branch (Step 3).
  - Ogni risposta sceglie un ramo per ogni esito. Il Task 6 esegue il ramo scelto e si ferma a richiedere solo se la GPU smentisce il modello su cui il proprietario ha risposto (la condizione è scritta in ciascuna sotto-decisione).

- [ ] **Step 1: branch**
```bash
cd /Users/edoardocicognani/Code/HyperionEngine
git status --short                       # vuoto
git checkout master && git pull --ff-only origin master
git rev-parse --short HEAD               # 2f43e42, oppure la base nuova da annotare
git checkout -b feat/step6-directional-shadows
```
- [ ] **Step 2: base**
```bash
scripts/preflight.sh
npm --prefix ts test 2>&1 | grep -E 'Test Files|Tests '
```
Expected: ogni passo `OK`; si annotano i conteggi vitest, la base per CLAUDE.md al Task 12.
- [ ] **Step 3: le risposte sul branch.** Questo piano è già su master: l'ha committato il 2026-09-30 la sessione che l'ha scritto, fermata lì per decisione dell'utente. Sul branch si committano le risposte dello Step 0, e con esse, se lo Step 0 cambia qualcosa, il piano stesso.
```bash
git add docs/plans/2026-09-27-open-items-round-plan.md docs/plans/2026-09-30-step6-directional-shadows-plan.md
git commit -m "docs(6): risposte alle sotto-decisioni del piano del passo 6" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1: `light-accum.wgsl` — asse condiviso e marcia generalizzata, point/spot invariati

**Files:**
- Modify: `ts/src/shaders/light-accum.wgsl` (`:101-177` `shadow()`, `:200-203` asse dello spot, `:221` chiamata)
- Modify: `ts/src/render/passes/light-accum-stage.test.ts` (`:1-7` import, `:174-212` i quattro test della marcia)

**Interfaces:**
- Produces: `fn lightFacing(m: mat4x4f) -> vec2f`; `const SUN_FADE_START: f32 = 0.75`; `fn sunFade(t: f32, reach: f32) -> f32`; `fn shadow(origin: vec2f, dir: vec2f, travel: f32, angle: f32, fadeReach: f32) -> f32`; `fn pointShadow(fromUV: vec2f, toUV: vec2f, sourceRadius: f32) -> f32`. Nessun cambiamento di comportamento: il sole resta senza ombra fino al Task 2.

- [ ] **Step 1: i test che falliscono**

In `light-accum-stage.test.ts`, aggiungi agli import `import { callGraph, functionBody, functionParams, stripComments } from '../../shaders/wgsl-analysis';`. Poi aggiungi, prima di `describe('light-accum.wgsl'`, l'helper:
```ts
/** The comment-blanked body of `fn name` in light-accum.wgsl; fails the test when the function is missing. */
function body(name: string): string {
  const text = functionBody(lightShaderSource, name);
  expect(text, `fn ${name} in light-accum.wgsl`).not.toBeNull();
  return text!;
}
```
I tre test di `:174-204` affettano da `indexOf('fn shadow')`, e un'altra funzione il cui nome comincia per `shadow` (arriva `shadowedLightType` al Task 2) li renderebbe vuoti. Sostituiscili, con `:206-212`, con questi otto (i quattro riscritti e quattro nuovi):
```ts
  it('uses the original Quilez soft-shadow term, not the Aaltonen correction', () => {
    // The correction assumes an exact SDF. A jump-flood field over-estimates,
    // and y = h*h / (2*ph) amplifies that (design §7.3, A2).
    expect(body('shadow')).toMatch(/let\s+q\s*=\s*h\s*\/\s*\(\s*\(\s*t\s*-\s*start\s*\)\s*\*\s*angle\s*\)/);
    expect(lightShaderSource).not.toMatch(/h\s*\*\s*h\s*\/\s*\(\s*2\.0\s*\*/);
  });

  it('a march that runs out of steps extrapolates its last clearance to the end of the ray, never assumes "lit"', () => {
    // A ray hugging a long wall advances by 1-2 texels and can spend all its
    // steps before it proves anything (a leak above its top, at 24 steps).
    const march = body('shadow');
    const afterLoop = march.slice(march.indexOf('t += h;'));  // the loop's last statement onwards
    expect(afterLoop).toMatch(/if\s*\(\s*t\s*<\s*travel\s*\)/);
    expect(afterLoop).toMatch(/h\s*\/\s*\(\s*\(\s*travel\s*-\s*start\s*\)\s*\*\s*angle\s*\)/);
  });

  it('a pixel inside an occluder leaves it and keeps marching: only its OWN occluder does not shadow it', () => {
    const march = body('shadow');
    expect(march).not.toMatch(/if\s*\(\s*h0\s*<=\s*0\.0\s*\)\s*\{\s*return\s+1\.0\s*;/);
    expect(march).toMatch(/while\s*\(\s*h\s*<=\s*0\.0/);
    expect(march).toMatch(/let\s+start\s*=\s*t\s*;/);
  });

  it("caps a point or spot light's apparent size by its real one: min(1/k, sourceRadius / distance)", () => {
    expect(body('pointShadow')).toMatch(/min\(\s*1\.0\s*\/\s*u\.shadowHardness\s*,\s*sourceRadius\s*\/\s*travel\s*\)/);
  });

  it('the march is shared: shadow(origin, dir, travel, angle, fadeReach), and pointShadow hands it no fade', () => {
    expect(functionParams(lightShaderSource, 'shadow')).toEqual(['origin', 'dir', 'travel', 'angle', 'fadeReach']);
    expect(body('pointShadow')).toMatch(/return\s+shadow\(\s*origin\s*,\s*dir\s*,\s*travel\s*,\s*angle\s*,\s*0\.0\s*\)/);
    const calls = callGraph(lightShaderSource).get('fs_main')!;
    expect(calls.has('pointShadow')).toBe(true);
    expect(calls.has('shadow')).toBe(false);
  });

  it('a march without fade is the arithmetic of before step 6: every select on `fading` keeps q (or 0.0) as its false operand', () => {
    // 1 - w*(1 - q) with w = 1 is not q in f32 (q = 0.1f gives 0.10000002f):
    // point and spot must take the select's false operand, never a blend.
    const march = body('shadow');
    expect(march).toMatch(/let\s+fading\s*=\s*fadeReach\s*>\s*0\.0\s*;/);
    const falseOperands = [...march.matchAll(/select\(\s*([^,]+?)\s*,[^;]*?,\s*fading\s*\)/g)].map((m) => m[1]);
    expect(falseOperands.sort()).toEqual(['0.0', 'q', 'q']);
    expect(march.match(/\bfading\b/g)).toHaveLength(4);  // the let and the three selects
  });

  it('sunFade: full strength without a reach; with one, a smoothstep over the last quarter', () => {
    expect(stripComments(lightShaderSource)).toMatch(/const\s+SUN_FADE_START\s*:\s*f32\s*=\s*0\.75\s*;/);
    const fade = body('sunFade');
    expect(fade).toMatch(/if\s*\(\s*reach\s*<=\s*0\.0\s*\)\s*\{\s*return\s+1\.0\s*;/);  // smoothstep never sees equal edges
    expect(fade).toMatch(/1\.0\s*-\s*smoothstep\(\s*SUN_FADE_START\s*\*\s*reach\s*,\s*reach\s*,\s*t\s*\)/);
  });

  it('spot and directional lights share one facing rule: lightFacing is the only reader of the world matrix column 0', () => {
    expect(stripComments(lightShaderSource).match(/\[0\]\.xy/g)).toHaveLength(1);
    const facing = body('lightFacing');
    expect(facing).toMatch(/\[0\]\.xy/);
    expect(facing).toMatch(/select\(\s*vec2f\(\s*1\.0\s*,\s*0\.0\s*\)\s*,\s*normalize\(\s*axis\s*\)\s*,\s*length\(\s*axis\s*\)\s*>\s*1e-6\s*\)/);
    expect(callGraph(lightShaderSource).get('fs_main')!.has('lightFacing')).toBe(true);
  });
```
- [ ] **Step 2: RED**

Run: `npx --prefix ts vitest run --root ts src/render/passes/light-accum-stage.test.ts`
Expected: FAIL in sei test: Quilez (`let q` assente), il limite `min(1/k, …)` (`pointShadow` assente), la marcia condivisa, i `select` su `fading`, `sunFade` e `lightFacing`. I due test riscritti per le regole 2 e 3 passano già, perché la marcia di oggi le rispetta; passa anche il test di `textureLoad`. Questo esito è stato controllato durante la stesura, con le stesse espressioni regolari, sullo shader di oggi e sul prototipo.

- [ ] **Step 3: lo shader**

In `light-accum.wgsl`:

1. Dopo `toScreenUV` (`:55-58`) inserisci:
```wgsl
// The way a light's light travels: its local +x axis, column 0 of the world
// matrix (sx * (cos, sin)). A spot's cone axis and a directional light's
// direction: one rule for both. The scale enters only through its sign (a
// negative x-scale mirrors the light); a zero x-scale falls back to world +x.
fn lightFacing(m: mat4x4f) -> vec2f {
    let axis = m[0].xy;
    return select(vec2f(1.0, 0.0), normalize(axis), length(axis) > 1e-6);
}
```
Va **prima** di `vs_main`: il test del filtro di gruppo (`:161-165`) affetta da `fn vs_main` a `fn sdfDistance`.

2. Dopo le costanti di tipo (`:37-42`) aggiungi:
```wgsl
// A sun's shadow keeps full strength for this fraction of its length, then
// fades out (sunFade).
const SUN_FADE_START: f32 = 0.75;
```
3. Sostituisci il commento `:101-119` e la funzione `:120-177` con queste tre funzioni. Il commento di `:107-110` ("Right for a sun, wrong for a torch") passa in `pointShadow` corretto: la **forma** a angolo costante è quella di una luce all'infinito, ma il sole non usa 1/k.
```wgsl
// A caster t texels from the pixel casts at this strength. `reach` <= 0: full
// strength everywhere (point and spot lights). A sun: full strength for the
// first SUN_FADE_START of its shadow's length, then a smoothstep down to 0 at
// the end (C1 at both ends: no Mach band on a smooth floor). The early return
// keeps smoothstep from ever seeing equal edges.
fn sunFade(t: f32, reach: f32) -> f32 {
    if (reach <= 0.0) {
        return 1.0;
    }
    return 1.0 - smoothstep(SUN_FADE_START * reach, reach, t);
}

// How much of the light reaches a pixel, 0..1. A sphere march on the signed SDF
// from `origin` along the unit `dir`, in SDF texels, for `travel` texels, with
// Quilez's soft-shadow term: h/t is the angle the nearest occluder subtends
// from the current point, compared with `angle`. That comparison is what makes
// the penumbra: it ramps from 0 to 1 over angle * t texels on the lit side of
// the edge, the width a source of angular DIAMETER `angle` would give (the
// penumbra's width per texel of distance).
//
// pointShadow and sunShadow choose origin, dir, travel and angle; everything
// below is shared. `fadeReach` > 0 (a sun): a caster t texels away casts at
// strength sunFade(t, fadeReach). 0 (point, spot): every select below takes its
// false operand, exactly the arithmetic of before step 6.
//
// This is deliberately the ORIGINAL form, not the Aaltonen correction
// (y = h*h / (2*ph), d = sqrt(h*h - y*y), ...). That correction assumes an
// exact SDF, and a jump-flood field only ever over-estimates h (design §6.2,
// A1). The y term amplifies exactly that error, so the "better" formula would
// make shadows worse here (§7.3, A2).
fn shadow(origin: vec2f, dir: vec2f, travel: f32, angle: f32, fadeReach: f32) -> f32 {
    let size = vec2i(textureDimensions(sdf));
    let fading = fadeReach > 0.0;
    var t = 0.0;
    var h = sdfDistance(vec2i(origin), size);
    var i = 0u;
    // A pixel inside an occluder (a sprite that both casts and receives) is not
    // shadowed by the occluder it belongs to, but must be by every other one:
    // leave it first, then march. Inside, |h| is the distance to the nearest
    // free texel, a lower bound on the way out in any direction, so a step of
    // |h| never overshoots the exit. Returning "lit" here instead left every
    // such sprite fully lit inside a wall's shadow.
    while (h <= 0.0 && i < u.shadowSteps) {
        t += max(-h, 1.0);
        if (t >= travel) {
            return 1.0;  // the light (a sun: the end of the ray) is inside the same occluder
        }
        h = sdfDistance(vec2i(origin + dir * t), size);
        i++;
    }
    if (h <= 0.0) {
        return 1.0;  // never got out: no other occluder was tested
    }
    // Penumbra distances run from where the ray leaves its own occluder (the
    // pixel itself, for a pixel in free space). Measured from the pixel, a
    // sprite would go dark along its own outline, where h is ~0.
    let start = t;
    var res = 1.0;
    t += max(h, 1.0);
    for (; i < u.shadowSteps; i++) {
        if (t >= travel) {
            break;
        }
        h = sdfDistance(vec2i(origin + dir * t), size);
        if (h <= 0.0) {
            // Every later caster is farther away, so fainter: this is the minimum.
            return select(0.0, min(res, 1.0 - sunFade(t, fadeReach)), fading);
        }
        let q = h / ((t - start) * angle);
        res = min(res, select(q, 1.0 - sunFade(t, fadeReach) * (1.0 - q), fading));
        t += h;
    }
    // Out of steps before the end of the ray: the rest of it is unproven. A
    // ray hugging a long wall spends its steps 1-2 texels at a time, and the
    // running `res` alone lit pixels squarely behind the wall. Returning 0
    // would darken long rays through open space instead. Assume the clearance
    // stays the last one seen, all the way to the end of the ray (a sun: at
    // the fade of the point where the steps ran out, the darkest one left).
    if (t < travel) {
        let q = h / ((travel - start) * angle);
        res = min(res, select(q, 1.0 - sunFade(t, fadeReach) * (1.0 - q), fading));
    }
    return clamp(res, 0.0, 1.0);
}

// A point or spot light: from the pixel toward the light's centre, at the
// light's apparent angle min(1/k, sourceRadius / travel). Quilez's k alone
// is a CONSTANT angle, the apparent size of a light at infinity; for a torch
// it is a light whose radius grows with the pixel's distance (travel/k), and a
// light beside a wall then darkened pixels on the far side of it, because the
// last steps of their march pass within h of the wall. Measured 2026-09-26:
// free rays 23-42% darker, in radial bands. The second term is the light's
// real size, so a far pixel sees a small light.
fn pointShadow(fromUV: vec2f, toUV: vec2f, sourceRadius: f32) -> f32 {
    let size = vec2i(textureDimensions(sdf));
    let fsize = vec2f(size);
    let origin = fromUV * fsize;
    let lightPos = toUV * fsize;
    let travel = distance(origin, lightPos);
    if (travel < 1.0) {
        return 1.0;
    }
    let dir = (lightPos - origin) / travel;
    let angle = min(1.0 / u.shadowHardness, sourceRadius / travel);
    return shadow(origin, dir, travel, angle, 0.0);
}
```
4. Nel ramo spot (`:200-203`) le tre righe (commento, `let axis`, `let facing`) diventano `let facing = lightFacing(m);`.
5. A `:221` `shadow(in.screenUV, lightUV, sourceRadius)` diventa `pointShadow(in.screenUV, lightUV, sourceRadius)`.

- [ ] **Step 4: GREEN e naga**
```bash
npx --prefix ts vitest run --root ts src/render/passes/light-accum-stage.test.ts
D="$(mktemp -d)"; cp ts/src/shaders/light-accum.wgsl "$D/"; node scripts/validate-wgsl-naga.mjs "$D"
npx --prefix ts vitest run --root ts src/shaders/uniform-layout.test.ts src/shaders/storage-budget.test.ts
```
Expected: tutti verdi; naga `Validation successful`.

- [ ] **Step 5: commit**
```bash
git add ts/src/shaders/light-accum.wgsl ts/src/render/passes/light-accum-stage.test.ts
git commit -m "refactor(6): light-accum.wgsl, asse +x condiviso e marcia generalizzata; point e spot invariati" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: le ombre del sole — WGSL, binding 5, gate TS nello **stesso commit**

**Files:**
- Modify: `ts/src/shaders/light-accum.wgsl` (header `:1-12`, `VertexOutput` `:44-49`, `vs_main` `:75-76`, funzioni nuove, `fs_main` `:187-223`)
- Modify: `ts/src/render/passes/light-accum-stage.ts` (`:102` binding 5; doc `:26-33` e `:41-57`)
- Modify: `ts/src/render/passes/light-accum-stage.test.ts` (`setUp` `:30`, test nuovi)
- Modify: `ts/src/render/light-groups.ts` (`:58-63`, `:112-115`)
- Modify: `ts/src/render/light-groups.test.ts` (`:3`, `:6`, `:18`, test nuovi)

**Interfaces:**
- Produces (WGSL): varying `@location(3) @interpolate(flat) sunRay: vec3f`, cioè la direzione unitaria verso la luce in texel dell'SDF legato (xy) e la lunghezza dell'ombra in quei texel (z); `fn directionalRay(e: u32) -> vec3f`; `fn exitDistance(origin: vec2f, dir: vec2f, size: vec2f) -> f32`; `fn sunShadow(fromUV: vec2f, ray: vec3f) -> f32`; `fn shadowedLightType(kind: u32) -> bool`.
- Produces (TS): `export const SHADOWED_LIGHT_TYPES: readonly number[]` (`[0, 1, 2]`) in `light-groups.ts`.
- Consumes: `LightUniform.viewProjection` e `u.sourceFraction` (già scritti a 0 e 72), `primParams` slot 3 e 7.

- [ ] **Step 1: i test che falliscono (stage)**

In `setUp()` di `light-accum-stage.test.ts` registra i layout: `const layouts: GPUBindGroupLayoutDescriptor[] = [];` e `createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => { layouts.push(d); return {}; },` (oggi `() => ({})`, `:30`). Aggiungi `layouts` all'oggetto restituito e `bindingDecls, reachableFrom` agli import di `wgsl-analysis`. Poi aggiungi, nel `describe('light-accum.wgsl')`:
```ts
  it('every binding an entry point reaches is visible to its stage: the SDF to vs_main too', () => {
    // A binding the vertex stage uses but the layout hides fails
    // createRenderPipeline; GPU validation then rejects the lit graph and
    // lighting silently stays off. No mock device sees it.
    LightAccumStage.SHADER_SOURCE = lightShaderSource;
    const { layouts } = setUp();
    const visibility = new Map([...layouts[0].entries].map((e) => [e.binding, e.visibility]));
    for (const [entry, stage] of [['vs_main', GPUShaderStage.VERTEX], ['fs_main', GPUShaderStage.FRAGMENT]] as const) {
      const reached = reachableFrom(lightShaderSource, entry);
      for (const b of bindingDecls(lightShaderSource).filter((d) => reached.has(d.name))) {
        expect((visibility.get(b.binding) ?? 0) & stage, `${entry} reaches ${b.name} (binding ${b.binding})`).not.toBe(0);
      }
    }
    expect(reachableFrom(lightShaderSource, 'vs_main').has('sdf')).toBe(true);  // not vacuous
  });

  it('a directional light carries its shadow ray to the fragment stage: flat, computed once per light in vs_main', () => {
    expect(lightShaderSource).toMatch(/@location\(3\)\s*@interpolate\(flat\)\s*sunRay:\s*vec3f/);
    expect(body('vs_main')).toMatch(/if\s*\(\s*kind\s*==\s*DIRECTIONAL\s*\)\s*\{\s*out\.sunRay\s*=\s*directionalRay\(\s*e\s*\)\s*;/);
  });

  it('directionalRay: the facing TOWARD the light, projected as a vector (w = 0), y flipped like toScreenUV, range as the length, bounded without overflow', () => {
    const ray = body('directionalRay');
    expect(ray).toMatch(/vec4f\(\s*-lightFacing\(\s*transforms\[e\]\s*\)\s*,\s*0\.0\s*,\s*0\.0\s*\)/);
    expect(ray).toMatch(/vec2f\(\s*clip\.x\s*,\s*-clip\.y\s*\)/);
    expect(ray).toMatch(/textureDimensions\(\s*sdf\s*\)/);
    // The PRODUCT range * texels stays finite, and is never computed first:
    // CameraAPI.zoom has no upper bound, so texels can be huge.
    expect(ray).toMatch(/min\(\s*max\(\s*primParams\[e \* 8u \+ 3u\]\s*,\s*0\.0\s*\)\s*,\s*1e30\s*\/\s*texels\s*\)\s*\*\s*texels/);
    expect(reachableFrom(lightShaderSource, 'vs_main').has('lightFacing')).toBe(true);
  });

  it('a sun marches min(range, SDF exit): beyond the SDF counts as lit, never to infinity', () => {
    const sun = body('sunShadow');
    expect(sun).toMatch(/let\s+travel\s*=\s*min\(\s*ray\.z\s*,\s*exitDistance\(\s*origin\s*,\s*ray\.xy\s*,\s*fsize\s*\)\s*\)/);
    expect(sun).toMatch(/if\s*\(\s*travel\s*<\s*1\.0\s*\)\s*\{\s*return\s+1\.0\s*;/);
    const exit = body('exitDistance');
    expect(exit).toMatch(/select\(\s*vec2f\(\s*0\.0\s*\)\s*,\s*size\s*,\s*dir\s*>\s*vec2f\(\s*0\.0\s*\)\s*\)/);
    expect(exit).toMatch(/select\(\s*vec2f\(\s*1e30\s*\)/);
  });

  it('a sun uses the fixed angle u.sourceFraction, not 1/k, and fades over its range', () => {
    const sun = body('sunShadow');
    // Exact text: the angle A/B of docs/plans/assets/2026-09-30-step6-directional-bench.js patches it.
    expect(sun).toMatch(/return shadow\(origin, ray\.xy, travel, u\.sourceFraction, ray\.z\);/);
    expect(sun).not.toMatch(/shadowHardness/);
  });

  it('the shadow gate: slot 7 is read once, through shadowedLightType, and a directional light marches with it', () => {
    const code = stripComments(lightShaderSource);
    expect(code.match(/primParams\[p \+ 7u\]/g)).toHaveLength(1);
    expect(code).toMatch(/let shadowStrength = select\(0\.0, clamp\(primParams\[p \+ 7u\], 0\.0, 1\.0\), shadowedLightType\(kind\)\);/);
    expect(body('fs_main')).toMatch(/else if \(kind == DIRECTIONAL && shadowStrength > 0\.0\) \{\s*intensity \*= mix\(1\.0, sunShadow\(in\.screenUV, in\.sunRay\), shadowStrength\);/);
  });

  it('LightUniform stays 80 bytes: step 6 adds no uniform', () => {
    expect(structSize(lightShaderSource, 'LightUniform')).toBe(80);
  });
```
(`structSize` da `'../../shaders/uniform-layout'`.)

Solo con la risposta (b) alla sotto-decisione 3, anche questo test; e nel test del Task 1 'the march is shared' l'attesa su `pointShadow` diventa la stessa riga `return shadow(…)`:
```ts
  it('a point or spot light also stops at the SDF exit (sub-decision 3 (b)); its angle still comes from the distance to the light', () => {
    const point = body('pointShadow');
    expect(point).toMatch(/let\s+angle\s*=\s*min\(\s*1\.0\s*\/\s*u\.shadowHardness\s*,\s*sourceRadius\s*\/\s*travel\s*\)/);
    expect(point).toMatch(/return\s+shadow\(\s*origin\s*,\s*dir\s*,\s*min\(\s*travel\s*,\s*exitDistance\(\s*origin\s*,\s*dir\s*,\s*fsize\s*\)\s*\)\s*,\s*angle\s*,\s*0\.0\s*\)/);
  });
```
Con (a) nessun test in più: l'identità al bit la fissano il test del Task 1 sui `select` e la cattura `regress`.

- [ ] **Step 2: i test che falliscono (gruppi)**

In `light-groups.test.ts`:
- `:3`: importa anche `SHADOWED_LIGHT_TYPES`;
- `:6`: importa anche `functionBody` e `callGraph`;
- `:18`: diventa `const POINT = 0, DIRECTIONAL = 2, GLOBAL = 3;`.

Dopo il tipo `E` (`:20`), l'helper:
```ts
/** Every `if (cond) { block }` of a comment-blanked WGSL body, `else if` and nested ones included. */
function branches(body: string): { cond: string; block: string }[] {
  const close = (s: string, from: number, open: string, shut: string): number => {
    for (let i = from, depth = 0; i < s.length; i++) {
      if (s[i] === open) depth++;
      else if (s[i] === shut && --depth === 0) return i;
    }
    return s.length;
  };
  return [...body.matchAll(/\bif\s*\(/g)].map((m) => {
    const p0 = m.index! + m[0].length - 1;
    const p1 = close(body, p0, '(', ')');
    const b0 = body.indexOf('{', p1);
    return { cond: body.slice(p0 + 1, p1), block: body.slice(b0, close(body, b0, '{', '}') + 1) };
  });
}
```
Poi aggiungi:
```ts
  it('a shadowed directional light gets an SDF set like a point, wherever its transform is', () => {
    const sun = (shadow: number) => light(0xffff, shadow, { type: DIRECTIONAL, x: 100, r: 3.4e38 });
    const on = deriveLightGroups(scene([sun(1), drawable(CAST | RECV)]));
    expect(on.groups).toEqual([{ layers: 1, sdfSet: 0 }]);
    expect(on.sdfSets).toEqual([{ occluderLayers: 1 }]);
    expect(deriveLightGroups(scene([sun(0), drawable(CAST | RECV)])).groups).toEqual([{ layers: 1, sdfSet: -1 }]);
  });

  it('a sun shadows only the layers in its mask', () => {
    const g = deriveLightGroups(scene([
      light(0b10, 1, { type: DIRECTIONAL, r: 3.4e38 }), light(0b01), drawable(RECV, 0b01), drawable(RECV, 0b10), drawable(CAST, 0),
    ]));
    expect(g.groups).toEqual([{ layers: 0b01, sdfSet: -1 }, { layers: 0b10, sdfSet: 0 }]);
  });

  it('counts as shadowed exactly the light types light-accum.wgsl marches (shadowedLightType ↔ SHADOWED_LIGHT_TYPES)', () => {
    // The shader gate and this one must change together: a type the shader
    // shadows but the grouping does not count gets no SDF set and never
    // shadows; the other way round, a flood nobody reads (~1.8 ms).
    const wgsl = stripComments(readFileSync(new URL('../shaders/light-accum.wgsl', import.meta.url), 'utf8'));
    const ids = new Map([...wgsl.matchAll(/const\s+([A-Z_]+)\s*:\s*u32\s*=\s*(\d+)u\s*;/g)].map((m) => [m[1], Number(m[2])]));
    expect(ids.get('LIGHT_TYPE_SHIFT')).toBe(11);
    const gate = functionBody(wgsl, 'shadowedLightType');
    expect(gate, 'fn shadowedLightType in light-accum.wgsl').not.toBeNull();
    const types = [...gate!.matchAll(/kind\s*==\s*([A-Z_]+)/g)].map((m) => ids.get(m[1]));
    expect(types.every((t) => t !== undefined)).toBe(true);
    expect([...types].sort()).toEqual([...SHADOWED_LIGHT_TYPES].sort());
    expect(types).not.toContain(ids.get('GLOBAL'));
    // Each gated type reaches a march in fs_main. A type both lists count but
    // no branch marches (a sprite light added to the gates in step 8 without
    // its branch) floods an SDF set nothing reads, and never shadows.
    const main = functionBody(wgsl, 'fs_main')!;
    const marched = new Set<number | undefined>();
    for (const { cond, block } of branches(main)) {
      if (!/\b(?:pointShadow|sunShadow)\(/.test(block)) continue;
      for (const m of cond.matchAll(/kind\s*==\s*([A-Z_]+)/g)) marched.add(ids.get(m[1]));
    }
    expect([...marched].sort()).toEqual([...types].sort());
    // …and no other march: one call of each, from fs_main only.
    expect(main.match(/\b(?:pointShadow|sunShadow)\(/g)).toHaveLength(2);
    for (const [fn, callees] of callGraph(wgsl)) {
      if (fn !== 'fs_main') expect(callees.has('pointShadow') || callees.has('sunShadow'), `${fn} calls a march`).toBe(false);
    }
    // One road to a shadow: slot 7 read once, through the gate.
    expect(wgsl.match(/primParams\[p \+ 7u\]/g)).toHaveLength(1);
    expect(wgsl).toMatch(/select\(0\.0, clamp\(primParams\[p \+ 7u\], 0\.0, 1\.0\), shadowedLightType\(kind\)\)/);
    // And in behaviour, over all eight wire values of the type field.
    for (let t = 0; t < 8; t++) {
      const g = deriveLightGroups(scene([light(0xffff, 1, { type: t, r: 3.4e38 }), drawable(CAST | RECV)]));
      expect(g.sdfSets.length, `light type ${t}`).toBe(types.includes(t) ? 1 : 0);
    }
  });
```
- [ ] **Step 3: RED**
```bash
npx --prefix ts vitest run --root ts src/render/passes/light-accum-stage.test.ts src/render/light-groups.test.ts
```
Expected: FAIL nei test nuovi, tranne quello dei 80 B, che è una guardia e passa già. Il test di visibilità fallisce sull'ultima riga, perché `vs_main` non raggiunge `sdf`. `SHADOWED_LIGHT_TYPES` non è esportato, e `shadowedLightType` non esiste.

- [ ] **Step 4: lo shader**

In `light-accum.wgsl`:
1. **Header `:1-12`** (lo lista la §5 del piano del giro). Sostituiscilo con:
```wgsl
// Light accumulation (Phase 17, Task 9; directional shadows: round 2026-09-27,
// step 6): every visible Light2D, added into the half-resolution light buffer.
// The buffer is cleared to the ambient light, and ForwardPass multiplies lit
// sprites by it.
//
// Point and spot lights are a quad covering their range, around the light's
// position. The transform's scale is ignored, because a light's extent IS its
// range (the same rule as its culling radius). Global and directional lights
// cover the screen. Light2D primParams: [colorR, colorG, colorB] with energy
// premultiplied, range, innerCos, outerCos, falloff, shadowIntensity.
//
// Spot and directional lights shine toward their local +x axis (lightFacing).
// A directional light (a sun) has no position: each caster's shadow runs
// along that axis, away from the light, for `range` world units and fades out
// over the last quarter, at a fixed apparent angle, u.sourceFraction. Global
// lights never cast shadows in the lit backend: their shadowIntensity is
// ignored.
//
// Not yet: the `sprite` light type (discarded) and the `mix` blend mode (added
// like `add`).
```
2. Nella struct, il commento di `sourceFraction` (`:19`) diventa `// A light's source radius as a fraction of its range (LIGHT_SOURCE_FRACTION),` + `// and a directional light's penumbra angle in radians (sunShadow): the` + `// penumbra's width per unit of distance, about the source's angular diameter.`. Sopra `@binding(5)` aggiungi `// Visible to the vertex stage too: directionalRay reads its size.`.
3. In `VertexOutput`, dopo `entityIdx`:
```wgsl
    // A directional light's shadow ray (directionalRay), once per light.
    @location(3) @interpolate(flat) sunRay: vec3f,
```
4. Dopo `lightFacing`, prima di `vs_main`:
```wgsl
// A directional light's shadow ray, computed once per light in vs_main: the
// unit direction TOWARD the light in texels of the bound SDF (xy), and the
// shadow's length, `range` world units, in those texels (z). The facing is
// projected as a vector (w = 0), so the camera's translation drops out; the y
// flip is toScreenUV's (the world is y-up, the texture y-down).
fn directionalRay(e: u32) -> vec3f {
    let size = vec2f(textureDimensions(sdf));
    let clip = (u.viewProjection * vec4f(-lightFacing(transforms[e]), 0.0, 0.0)).xy;
    let perUnit = vec2f(clip.x, -clip.y) * 0.5 * size;  // one world unit toward the light, in texels
    let texels = length(perUnit);
    if (texels < 1e-6) {
        return vec3f(0.0);  // a degenerate camera: no shadow
    }
    // The shadow's length in texels. Rust accepts any finite range, and
    // CameraAPI.zoom has no upper bound: bound the PRODUCT without computing it
    // first (1e30 / texels is finite for texels >= 1e-6). A range of 0 or less
    // casts no shadow.
    let reach = min(max(primParams[e * 8u + 3u], 0.0), 1e30 / texels) * texels;
    return vec3f(perUnit / texels, reach);
}
```
(Validato con naga 30.0.1 su una copia del prototipo durante la revisione del piano.)
5. In `vs_main` il ramo `if (kind == GLOBAL || kind == DIRECTIONAL)` (`:75-76`) diventa:
```wgsl
    if (kind == GLOBAL || kind == DIRECTIONAL) {
        out.position = vec4f(position.xy * 2.0, 0.0, 1.0);
        if (kind == DIRECTIONAL) {
            out.sunRay = directionalRay(e);
        }
    } else {
```
6. Dopo `pointShadow`, prima di `@fragment`:
```wgsl
// Texels from `origin` (inside the texture) to where a ray along the unit
// `dir` leaves the size.x x size.y rectangle: a slab test. An axis the ray
// does not move along never ends it; a unit dir moves along at least one.
fn exitDistance(origin: vec2f, dir: vec2f, size: vec2f) -> f32 {
    let moving = abs(dir) > vec2f(1e-6);
    let side = select(vec2f(0.0), size, dir > vec2f(0.0));
    let t = select(vec2f(1e30), (side - origin) / select(vec2f(1.0), dir, moving), moving);
    return min(t.x, t.y);
}

// A directional light: from the pixel toward the light, for the shadow's
// length (`ray.z`, its range) or until the ray leaves the SDF, whichever comes
// first. Beyond the SDF nothing is known, and it counts as lit: the clamped
// read would repeat the edge texel forever, and a light at infinity would make
// the out-of-steps rule 0. A light at infinity has a constant apparent size:
// u.sourceFraction (0.02 rad, about 1.15 degrees), the penumbra's width per
// unit of distance, i.e. about the source's angular diameter; the same angle
// every point light has at the edge of its range (not 1/k: 0.125 rad is 13x
// the real sun's diameter, 0.0093 rad).
fn sunShadow(fromUV: vec2f, ray: vec3f) -> f32 {
    let fsize = vec2f(textureDimensions(sdf));
    let origin = fromUV * fsize;
    let travel = min(ray.z, exitDistance(origin, ray.xy, fsize));
    if (travel < 1.0) {
        return 1.0;
    }
    return shadow(origin, ray.xy, travel, u.sourceFraction, ray.z);
}

// The light types that cast shadows in the lit backend. Never GLOBAL: it has
// no position and no direction to cast from, and its shadowIntensity is
// ignored. light-groups.ts counts exactly these as shadowed
// (SHADOWED_LIGHT_TYPES); light-groups.test.ts ties the two lists.
fn shadowedLightType(kind: u32) -> bool {
    return kind == POINT || kind == SPOT || kind == DIRECTIONAL;
}
```
7. In `fs_main`, subito dopo `let color = …` (`:187`):
```wgsl
    // The one read of shadowIntensity (slot 7), through the type gate.
    let shadowStrength = select(0.0, clamp(primParams[p + 7u], 0.0, 1.0), shadowedLightType(kind));
```
Poi togli `let shadowStrength = clamp(primParams[p + 7u], 0.0, 1.0);` (`:213`); il blocco point/spot resta com'è, con `if (shadowStrength > 0.0 && intensity > 0.0)`. Infine la chiusura del blocco `if (kind == POINT || kind == SPOT) { … }` (`:223`) diventa:
```wgsl
    } else if (kind == DIRECTIONAL && shadowStrength > 0.0) {
        intensity *= mix(1.0, sunShadow(in.screenUV, in.sunRay), shadowStrength);
    }
```
8. Solo con la risposta (b) alla sotto-decisione 3: l'ultima riga di `pointShadow` diventa `return shadow(origin, dir, min(travel, exitDistance(origin, dir, fsize)), angle, 0.0);`. L'angolo resta quello della distanza vera dal centro della luce. Per una luce col centro in vista il segmento dal pixel al centro sta tutto nel rettangolo (convessità), quindi `min` restituisce `travel`: stessi pixel.
- [ ] **Step 5: lo stage**

In `light-accum-stage.ts`:
- `:102`: `visibility: GPUShaderStage.FRAGMENT` diventa `visibility: vsFs`, con il commento `// signed SDF (vs_main reads its size: directionalRay)`;
- doc di `LIGHT_SOURCE_FRACTION` (`:26-32`): aggiungi in fondo "It is also a directional light's penumbra angle, in radians, fixed engine-wide (round step 6): the penumbra's width per unit of distance, i.e. about the source's angular diameter (0.02 rad, about 1.15°). A sun gets the penumbra a point light has at the edge of its range.";
- doc di `SHADOW_HARDNESS` (`:19-23`): "Soft-shadow hardness k: the light's apparent angle is at most 1/k." diventa "Soft-shadow hardness k of point and spot lights: their apparent angle is at most 1/k. A directional light uses LIGHT_SOURCE_FRACTION instead (round step 6).";
- doc della classe (`:50-52`): "A point or spot light is a quad of its range; a global or directional light covers the screen. See light-accum.wgsl for the falloff, the spot cone, the sun's direction and the shadow march."

- [ ] **Step 6: il gate TS**

In `light-groups.ts`, dopo `const SPOT = 1;` (`:63`):
```ts
const DIRECTIONAL = 2;
/**
 * The light types whose shadowIntensity makes light-accum.wgsl march the SDF:
 * its `shadowedLightType`, which light-groups.test.ts compares with this list.
 * Never GLOBAL: a global light has no position and no direction to cast from.
 * Sprite lights join in round step 8, on both sides in the same commit.
 */
export const SHADOWED_LIGHT_TYPES: readonly number[] = [POINT, SPOT, DIRECTIONAL];
const SHADOWED = new Uint8Array(8);
for (const type of SHADOWED_LIGHT_TYPES) SHADOWED[type] = 1;
```
e `:112-115` (lo cita anche la §5 del piano del giro, come `:110-113`) diventa:
```ts
      // The shader's gate (shadowedLightType in light-accum.wgsl): point, spot
      // or directional, with a shadow strength above 0.
      const type = (word >>> LIGHT_TYPE_SHIFT) & 7;
      const strength = Math.min(Math.max(primParams[i * 8 + 7], 0), 1);
      if (SHADOWED[type] === 1 && strength > 0) shadowedLayers |= mask;
```
`SHADOWED_LIGHT_TYPES` non entra in `index.ts`: resta interno, come `LIT_PRIMITIVE_TYPES`.

- [ ] **Step 7: GREEN, naga, tipi**
```bash
npx --prefix ts vitest run --root ts src/render/passes/light-accum-stage.test.ts src/render/light-groups.test.ts src/render/passes/light-groups-pass.test.ts src/shaders/uniform-layout.test.ts
D="$(mktemp -d)"; cp ts/src/shaders/light-accum.wgsl "$D/"; node scripts/validate-wgsl-naga.mjs "$D"
npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"
npm --prefix ts test
```
Expected: tutto verde; naga `Validation successful`; nessun errore di tipo.

- [ ] **Step 8: cancello GPU rapido (Mac, prima del commit)**

Non ne esistono prove headless: la validazione della pipeline con il layout nuovo, e il segno del raggio.
1. Avvia il dev server: `npm --prefix ts run dev`, in background.
2. Su **chrome-devtools-gpu**: `navigate_page` a `"http://localhost:5173/?mode=B&bench"` con `ignoreCache: true` e l'`initScript` anti-reload di `.claude/skills/gpu-check/SKILL.md` §3. Leggi la riga dell'adapter.
3. `evaluate_script`:
```js
async () => {
  const engine = window.__hyperion;
  const src = (await import('/src/shaders/light-accum.wgsl?raw')).default;
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const info = await device.createShaderModule({ code: src }).getCompilationInfo();
  device.destroy();  // a throwaway device: never left alive next to the engine's
  const frames = (n) => new Promise((r) => { const s = (k) => (k <= 0 ? r() : requestAnimationFrame(() => s(k - 1))); s(n); });
  engine.cam.position(0, 0, 0); engine.cam.zoom(1);
  const hs = [];
  engine.batch(() => {
    hs.push(engine.spawn().position(0, 0, -0.5).scale(40, 24, 1).receivesLight(true));
    hs.push(engine.spawn().position(0, 2, 0).scale(4, 0.6, 1).castsShadow(true));
    hs.push(engine.spawn().rotation(-Math.PI / 2).light({ type: 'directional', color: [1, 1, 1], energy: 1, shadowIntensity: 1 }));
  });
  engine.lighting.setBackend('lit');
  await frames(8);
  const live = engine.renderer.graph.executionOrder.includes('light-groups');
  const g = engine.lighting.groups;
  const r = await engine.debug.probe({ target: 'light-buffer', world: [[0, -1], [0, 5], [6, -1]], layer: 0 });
  for (const h of hs) h.destroy();
  engine.lighting.setBackend('off');
  return { messages: info.messages.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`), live, groups: g && [g.groups.length, g.sdfSets.length], below: r.values[0], above: r.values[1], beside: r.values[2] };
}
```
Se il probe risponde `not in the live render graph`, aspetta altri frame e riprova, come `lighting.ts:148-156`.

Expected:
- `messages` vuoto;
- `live` true;
- `groups` [1, 1];
- `below` (sotto il muro: `rotation(-π/2)` splende verso il basso) scuro, circa l'ambient: la luminanza è meno di metà di quella di `above` e di `beside`, che valgono ambient + 1;
- in console (`list_console_messages`, `error`/`warn`) nessun messaggio WebGPU.

Se `below` è chiaro e `above` scuro, il segno è rovesciato: si corregge con un test di testo che fissi il segno giusto prima del commit.

- [ ] **Step 9: commit (unico: gate WGSL e TS insieme)**
```bash
git add ts/src/shaders/light-accum.wgsl ts/src/render/passes/light-accum-stage.ts ts/src/render/passes/light-accum-stage.test.ts ts/src/render/light-groups.ts ts/src/render/light-groups.test.ts
git commit -m "feat(6): ombre delle luci directional (asse +x, lunghezza = range con sfumatura, marcia fino all'uscita dall'SDF) e light-groups le conta" -m "Il gate di light-accum.wgsl (shadowedLightType) e quello di light-groups.ts (SHADOWED_LIGHT_TYPES) cambiano nello stesso commit; un test di testo li lega. Il binding 5 è visibile anche al vertex stage." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: luci `global` — flag `shadowedGlobalLight` e avviso del renderer

**Files:**
- Modify: `ts/src/render/light-groups.ts` (`:34-47`, `:98-100`, gate, `:176-183`)
- Modify: `ts/src/render/light-groups.test.ts`
- Modify: `ts/src/render/passes/light-groups-pass.ts` (`:14-21`), `ts/src/render/passes/light-groups-pass.test.ts` (`:87-93`)
- Modify: `ts/src/renderer.ts` (`:543`, `:1056-1062`)
- Modify: `ts/src/lighting-api.ts` (`:111-122`), `ts/src/lighting-api.test.ts`

**Interfaces:**
- Produces: `LightGroups.shadowedGlobalLight: boolean`, obbligatorio come `multiBitReceiver`. Vale true quando una luce globale in vista ha `shadowIntensity` > 0.

- [ ] **Step 1: i test che falliscono**

In `light-groups.test.ts`, nel test 'default scene' (`:41-46`) aggiungi `expect(g.shadowedGlobalLight).toBe(false);`. Poi:
```ts
  it('a global light never shadows: its shadowIntensity makes no SDF set and raises shadowedGlobalLight', () => {
    const glob = (shadow: number) => light(0xffff, shadow, { type: GLOBAL, r: 3.4e38 });
    const g = deriveLightGroups(scene([glob(1), drawable(CAST | RECV)]));
    expect(g.groups).toEqual([{ layers: 1, sdfSet: -1 }]);
    expect(g.sdfSets).toEqual([]);
    expect(g.shadowedGlobalLight).toBe(true);
    expect(deriveLightGroups(scene([glob(0), drawable(CAST | RECV)])).shadowedGlobalLight).toBe(false);
    const withPoint = deriveLightGroups(scene([glob(1), light(0xffff, 1), drawable(CAST | RECV)]));
    expect(withPoint.groups).toEqual([{ layers: 1, sdfSet: 0 }]);
    expect(withPoint.shadowedGlobalLight).toBe(true);
  });

  it('renderer.ts warns once, in dev builds, about a shadowed global light', () => {
    // createRenderer needs a GPU: the wiring is pinned on the text, like the
    // piece registration above.
    const renderer = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
    expect(renderer).toMatch(/let warnedShadowedGlobalLight = false;/);
    const block = renderer.slice(renderer.indexOf('frameState.lightGroups = deriveLightGroups(frameState);'));
    expect(block).toMatch(/if \(dev && frameState\.lightGroups\.shadowedGlobalLight && !warnedShadowedGlobalLight\) \{\s*warnedShadowedGlobalLight = true;\s*console\.warn\(/);
  });
```
In `lighting-api.test.ts`, nel `describe('LightingAPI — groups (light layers)')`:
```ts
  it('reports a shadowed global light (shadowedGlobalLight), which the lit backend ignores', () => {
    const GLOBAL = 3;
    const renderMeta = new Uint32Array([0, (LIGHT | (GLOBAL << 11) | (0xffff << 16)) >>> 0, 0, RECV]);
    const bounds = new Float32Array([0, 0, 0, 3.4e38, 0, 0, 0, 1]);
    const primParams = new Float32Array(16);
    primParams[7] = 1;
    const groups = withState(emptyRenderState({ entityCount: 2, renderMeta, bounds, primParams }), () => view).groups!;
    expect(groups.shadowedGlobalLight).toBe(true);
    expect(groups.sdfSets).toEqual([]);
  });
```
- [ ] **Step 2: RED**
```bash
npx --prefix ts vitest run --root ts src/render/light-groups.test.ts src/lighting-api.test.ts
```
Expected: FAIL sui tre test nuovi e sull'asserzione aggiunta al 'default scene' (il campo è `undefined`).

- [ ] **Step 3: il codice**

1. `light-groups.ts`, interfaccia, dopo `multiBitReceiver`:
```ts
  /**
   * A global light in view has shadowIntensity > 0. The lit backend ignores it:
   * a global light has no position and no direction to cast from. The renderer
   * warns once (dev builds); use a directional light for a sun.
   */
  shadowedGlobalLight: boolean;
```
2. `const GLOBAL = 3;` dopo `DIRECTIONAL`; `let shadowedGlobalLight = false;` accanto a `multiBitReceiver` (`:100`). Il gate del Task 2 diventa:
```ts
      // The shader's gate (shadowedLightType in light-accum.wgsl): point, spot
      // or directional, with a shadow strength above 0. A global light's
      // strength is ignored there: flag it for the renderer's warning.
      const type = (word >>> LIGHT_TYPE_SHIFT) & 7;
      const strength = Math.min(Math.max(primParams[i * 8 + 7], 0), 1);
      if (strength > 0) {
        if (SHADOWED[type] === 1) shadowedLayers |= mask;
        else if (type === GLOBAL) shadowedGlobalLight = true;
      }
```
e `shadowedGlobalLight,` nel `return`, dopo `multiBitReceiver,`.

3. `shadowedGlobalLight: false,` nel letterale `EVERYTHING` (`light-groups-pass.ts:18`) e nell'helper `groups()` di `light-groups-pass.test.ts:91`.

4. `renderer.ts`: `let warnedShadowedGlobalLight = false;` dopo `:543`. Nel blocco `if (host.mode.lighting) {` (`:1056`), dopo il `if` di `multiBitReceiver`:
```ts
        if (dev && frameState.lightGroups.shadowedGlobalLight && !warnedShadowedGlobalLight) {
          warnedShadowedGlobalLight = true;
          console.warn("[Hyperion] A global light has shadowIntensity > 0: global lights cast no shadows in the lit backend (no position, no direction), so it is ignored. Use type 'directional' for a sun.");
        }
```
L'avviso arriva in dev e solo mentre il grafo vivo è lit. In Mode A lo emette il render worker, e `list_console_messages` lo mostra: lo verifica dal vivo il Task 10, Step 6, in B e in A, perché la luce global del tab Lighting ha `shadowIntensity` 0 e nessun check lo fa scattare.

5. `lighting-api.ts`, JSDoc di `groups` (`:111-122`): aggiungi il paragrafo "It also reports `shadowedGlobalLight`: a global light in view asks for shadows, which the lit backend never casts from a global light (the renderer warns once in dev builds)."

- [ ] **Step 4: GREEN e tipi**
```bash
npx --prefix ts vitest run --root ts src/render/light-groups.test.ts src/lighting-api.test.ts src/render/passes/light-groups-pass.test.ts
npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"
```
- [ ] **Step 5: commit**: `feat(6): una luce globale con ombra alza shadowedGlobalLight, e il renderer avvisa una volta in dev`.

### Task 4: JSDoc e API

Non introduce comportamento nuovo. I due test sono di **caratterizzazione**: fissano il filo da cui dipende il flag del Task 3 e passano subito. Il RED si ottiene con una prova di mutazione.

**Files:**
- Modify: `ts/src/entity-handle.ts` (`:35`, `:53-75`, `:239-250`, `:512-519`, `:559-573`, `:581-584`)
- Modify: `ts/src/entity-handle.test.ts` (dopo `:677`)
- Modify: `ts/src/prim-params-schema.ts` (`:60-63`), `ts/src/lighting-api.ts` (`:156-161`)

- [ ] **Step 1: i due test, e la prova che mordono**
```ts
  it('a directional light carries its shadow length in range (slot 3)', () => {
    const p = mockProducer();
    new EntityHandle(1, p).light({ type: 'directional', range: 40, shadowIntensity: 1 });
    expect(p.setLightFlags).toHaveBeenCalledWith(1, 2, 0, 0xffff);
    expect((p.setPrimParams0 as any).mock.calls[0][4]).toBe(40);
    expect((p.setPrimParams1 as any).mock.calls[0].slice(1)).toEqual([-1, -1, 1, 1]);
  });

  it('a global light still sends its shadowIntensity: the renderer ignores it and warns, not the handle', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = mockProducer();
    new EntityHandle(1, p).light({ type: 'global', shadowIntensity: 1 });
    expect((p.setPrimParams1 as any).mock.calls[0][4]).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
```
Eseguili (`npx --prefix ts vitest run --root ts src/entity-handle.test.ts`): PASS. Poi, **solo nel working tree**, due mutazioni, una alla volta:
- `light()` scrive lo slot 7 = 0 per `'global'`: il secondo test deve FALLIRE;
- `light()` manda range 0 per `'directional'`: il primo test deve FALLIRE.

Rimetti il codice e verifica che tornino PASS.

- [ ] **Step 2: il JSDoc**

1. `entity-handle.ts:35`, `LightType`:
```ts
/**
 * Light shape.
 * - `point`: lights a disc of radius `range` around its position.
 * - `spot`: a point light cut to a cone (`innerAngle`/`outerAngle`) around
 *   its axis.
 * - `directional`: a sun, infinitely far away. It lights every pixel of the
 *   layers in its mask, shining along its axis; its position is ignored. With
 *   `shadowIntensity` > 0 each caster throws a shadow along the axis, `range`
 *   world units long and fading out toward its end, with a fixed engine-wide
 *   penumbra. A caster casts only while it is on screen, so a shadow can
 *   appear at the edge the light comes from as the view pans. A shadowed sun
 *   marches every texel of the light buffer once per light group its layers
 *   reach.
 * - `global`: a uniform light over the layers in its mask, added on top of
 *   `engine.lighting.setAmbient()` (a masked one is a per-layer ambient). No
 *   position, no direction and no shadows in the lit backend:
 *   `shadowIntensity` is ignored (the renderer warns once in dev builds). Use
 *   `directional` for a sun.
 * - `sprite`: not drawn yet.
 *
 * The axis of a spot or directional light is its local +x in world space, and
 * the light shines TOWARD it: `rotation(angle)` aims it. 0 shines right,
 * `rotation(-Math.PI / 2)` shines down the screen (the world is y-up), and
 * `rotation(Math.atan2(dy, dx))` shines along (dx, dy). A parent's rotation
 * composes into it and a negative x-scale mirrors it; the size of the scale
 * is ignored, because a light's extent is its range.
 */
```
2. `LightOptions`:
   - `range` (`:61`):
```ts
  /**
   * World units. Default 100.
   * - `point`, `spot`: the light's radius, which is also its culling radius.
   * - `directional`: the length of its shadows, which fade out toward the end
   *   (0 or less casts none). It does not limit what the light lights: a sun
   *   covers the whole view and is never culled.
   * - `global`: unused (never culled either).
   */
```
   - `innerAngle` e `outerAngle`: "…half-angle in degrees, around the light's axis (its local +x, see {@link LightType}). Default 30 (45). Ignored by other types.";
   - `falloff`: "Attenuation exponent of a point or spot light: (1 − d/range)^falloff. Default 1 (linear). Ignored by other types.";
   - `shadowIntensity`: "Shadow strength: 0 = none (default), 1 = fully opaque. Point, spot and directional lights; ignored on a global light in the lit backend (a dev warning, once). See {@link EntityHandle.shadows}."
3. `rotation()` (`:239-250`): aggiungi la riga "On a spot or directional light it aims the light (see {@link LightType})."
4. `light()` (`:512-519`): "— which is why `range` also drives its culling radius rather than needing a separate call." diventa "— which is why a point or spot light's `range` also drives its culling radius rather than needing a separate call (global and directional lights light the whole view and are never culled). Aim a spot or a sun with `rotation()` (see {@link LightType})."
5. `shadows()` (`:559-573`), dopo la prima riga: "Point, spot and directional lights (a sun's shadows are `range` world units long, see {@link LightType}). A shadowed directional light marches every texel of the light buffer once per light group its layers reach. A global light never casts shadows in the lit backend: the value is stored and ignored, and the renderer warns once in dev builds. Use a directional light for a sun."
6. `castsShadow()` (`:581-584`): aggiungi "A light entity never casts: a light's own shadows are {@link EntityHandle.shadows}."
7. `prim-params-schema.ts:60-63`: "`range` (slot 3) is also the single source of truth for the light's culling radius." diventa "`range` (slot 3) is the single source of truth for a point or spot light's culling radius; on a directional light it is the length of its shadows (global and directional lights are never culled). `shadowIntensity` is ignored on a global light (lit backend)." Nessun alias nuovo nello schema.
8. `lighting-api.ts:156-158`, `setAmbient`: "Global ambient light — the light every surface receives regardless of any light entity." diventa "The engine's ambient light: the clear colour of every light group's light buffer, which every lit surface receives whatever the light entities do. Not a `global` light, which is an entity added on top of it and limited to its layers (a per-layer ambient)."

Nel JSDoc pubblico nessun numero per la penombra: il valore sta solo nella doc di `LIGHT_SOURCE_FRACTION`. Il caso del sole allineato agli assi (sotto-decisione 2) entra nel JSDoc al Task 6, Step 6, con i numeri misurati.

- [ ] **Step 3: verifica e commit**
```bash
npx --prefix ts vitest run --root ts src/entity-handle.test.ts src/lighting-api.test.ts src/prim-params-schema.test.ts
npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"
git commit -am "docs(6): JSDoc delle luci, asse di spot e sole, range come lunghezza dell'ombra, global senza ombre" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(`git commit -am` solo se `git status --short` mostra esattamente i file di questo task.)

### Task 5: i check dell'harness (tab Lighting)

**Files:**
- Create: `docs/plans/assets/2026-09-30-step6/march-model.mjs`, `docs/plans/assets/2026-09-30-step6/march-model.test.mjs` (Step 0)
- Modify: `ts/src/demo/probe-checks.ts` (+ `probe-checks.test.ts`): `viewBounds`
- Create: `ts/src/demo/lighting-directional.ts`, `ts/src/demo/lighting-directional.test.ts`
- Modify: `ts/src/demo/lighting.ts` (`:6`, `:15-21`, `:54`, `:62-65`, `:104-111`, dopo `:173`)

**Interfaces:**
- Produces:
  - `viewBounds(vp: Float32Array): [xMin, xMax, yMin, yMax]`;
  - `checkDirectional(engine, reporter, entities, floor: Rgb, restoreView: () => void): Promise<void>`;
  - i verdetti puri `sunPoints`, `directionalShadowVerdict`, `shadowLengthVerdict`, `edgePopVerdict`;
  - i check 'Directional shadow', 'Directional shadow length' e 'Directional edge pop (measured)'.
- Il tab passa da 6 a 9 check e l'harness da 57 a 60. Il criterio ne chiede due; il terzo (lunghezza) fissa sulla GPU la semantica decisa (range in unità mondo, sfumatura, fine dell'ombra), che nient'altro controlla.

**Geometria**, verificata col modello CPU della marcia:
- **Sotto-scena:** centro `SUN_SCENE = [0, 200]`. Nessuna luce del tab ci arriva: le sfere delle luci principali stanno sotto y ≈ 16, e la vista resta sopra y ≈ 140 anche a un aspect di 0,3. L'inquadratura è `fitView(engine, 0, 200, 17.6)`. Ci sono:
  - un pavimento `scale(200, 100)` con `receivesLight(true)`: senza un ricevitore in vista non c'è gruppo, e senza gruppo non c'è SDF set;
  - il muro A nel centro C, `rotation(-π/6).scale(0.5, 2.4)`, `castsShadow(true)`: sottile lungo il sole, semilunghezza 1,2 di traverso;
  - il sole, `rotation(-π/6).light({ type: 'directional', color: SUN_COLOR = [1, 0.9, 0.7], energy: 1, shadowIntensity: 1 })`, con il range di default 100.
- **Check 1**, con dir = (cos −30°, sin −30°): S = C + 2,5·dir (sottovento, 2,25 dietro la faccia), U = C − 2,5·dir, Ry = C + 2,5·(0,866, 0,5), Rx = C + 2,5·(−0,866, −0,5). Nel modello: S = 0 e U = Rx = Ry = 1. La marcia rovesciata scurisce solo U, la y ribaltata solo Ry, la x ribaltata solo Rx.
- **Check 2:** il sole di nuovo con `range: 6`. Punti a 0,5, 2, 4, 5,25 e 7,5 unità oltre la faccia lontana, più U. Il modello dà 0, 0, 0, 0,50 e 1: la sfumatura comincia a 4,5 e finisce a 6.
- **Check 3:** il sole di nuovo con `rotation(0)` e range di default. Il lato del sole è il bordo sinistro, `xL = viewBounds(vp)[0]`. Due caster 0,6 × 2: W_out in `(xL − 0.55, C.y + 3)`, tutto fuori schermo (faccia destra 0,25 fuori); W_in in `(xL + 0.2, C.y + 8)`, faccia destra 0,5 dentro. Tre righe, out (C.y+3), in (C.y+8) e ref (C.y+5,5), a `xL + d` per d = 1, 2, …, ⌊W − 0,5⌋, più E = `(xL + 1, C.y + 6.6)`, 0,4 accanto a W_in. Nel modello, a range 100: pop = 1 su tutta la larghezza, L_out = L_ref ed E = 1. Con la marcia che legge oltre l'SDF, E ≈ 0,20 mentre L_out resta 1: E è l'unico punto che vede quel difetto.

**Id delle entità (scelta del piano).** Gli id si danno freschi per primi. Le 5 entità della sotto-scena (pavimento, muro A, sole, W_out, W_in) alzano quindi di 5 gli id di ogni tab dopo Lighting: Debug Tools, Lifecycle e 2D Twins (`TAB_KEYS` in `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js:30`). Il cancello di pixel M4 (`compare.mjs:106-110`, nella stessa cartella) fallirebbe su quei tab con "mover ids differ". Il progetto lo evita apposta: in Primitives "no entity is spawned, so later tabs keep their ids" (`CLAUDE.md:351`). Il piano **ricattura la base M4** al HEAD del passo 6 (Task 10, Step 7), e non riusa le handle del tab. Perché:
- riusarle vorrebbe dire spostare e poi rimettere esattamente pavimento, due muri e la luce globale, trasformata in directional e poi di nuovo in global. I check nuovi resterebbero legati alla scena del tab, e un ripristino sbagliato non lo vedrebbe nessun cancello: `compare.mjs` confronta Lighting solo per stati (`:94-98`). I passi 7-8 aggiungeranno altri check al tab, e dovrebbero fare lo stesso;
- la ricattura si verifica da sola. Contro `run1` deve fallire solo per "mover ids differ", con ogni id della corsa uguale all'id della base + 5, e passare ogni confronto di pixel. Così il passo guadagna anche il cancello M4 come regressione, che nel piano non girava.

La base AMD del 5b (`docs/plans/assets/2026-09-27-transparent-sort-baseline/`) invecchia allo stesso modo: si ricattura alla prossima sessione Fedora (lista D della memoria, Task 12).

- [ ] **Step 0: il modello CPU della marcia, committato**

`docs/plans/assets/2026-09-30-step6/march-model.mjs`, puro, con un `node:test` in `march-model.test.mjs`. È la base di ogni soglia dei check di questo task e delle previsioni del Task 6. Esporta:
- `makeCamera(cx, cy, canvasW = 1920, canvasH = 1080)`: camera ortografica alta 20 unità a zoom 1 sul light buffer a metà risoluzione (960×540, 27 texel per unità a 1080p), con `toTexel(x, y)` (y ribaltata come `toScreenUV`), `xL` e `texPerUnit`;
- `buildSdf(cam, rects)`: l'SDF con segno in texel, trasformata di distanza esatta (Felzenszwalb) dei soli semi dentro la vista, come il seed che rasterizza solo la parte a schermo di un caster; `rects` sono `{ x, y, hx, hy, rot }` in unità mondo;
- `shadow(sdf, ox, oy, dx, dy, travel, angle, fadeReach, steps)`, `sunShadowAt(cam, sdf, x, y, theta, range, angle, steps)` e `sunGrid(cam, sdf, theta, range, angle, steps, gx = 128, gy = 72)`: l'aritmetica di `shadow`, `sunShadow`, `sunFade` ed `exitDistance` dei Task 1-2, in f64, con `sdfDistance` clampato al bordo; `sunGrid` legge i centri di cella di una griglia UV, come il probe;
- `FADE_START` (0,75).

I test fissano i numeri che il piano cita (conteggi esatti, valori entro 0,005):
- check 1 (sotto-scena in (0, 200), sole a −30°, muro A): S 0; U, Ry e Rx 1. Con la marcia rovesciata scende solo U, con la y ribaltata solo Ry, con la x ribaltata solo Rx;
- check 2 (range 6): 0, 0, 0, 0,503 e 1 a 0,5, 2, 4, 5,25 e 7,5 unità oltre la faccia;
- check 3: E = 1 con l'uscita, 0,204 se la marcia va fino al range senza uscita; a range 100 pop 1 su tutta la riga; a range 10 pop 1 a d = 8 e 0 a d = 12;
- la scena `penumbra` del Task 6 (muro (−12, −4) 0,6×6, piattaforma (0, 5) 24×0,5, sole a 0°), a 48 passi contro 1024:
  - profili del muro: errore massimo 0,000 a 0,01, 0,02 e 0,04 rad;
  - `w10-90` contro 0,8·angolo·d, a d = 12 e 26: rapporto fra 0,98 e 1,03;
  - i 125 punti di lettura della piattaforma: a 0,02, massimo 0,69 e 20 punti sopra 0,1, fino a 0,42 unità sopra la faccia;
  - la diagonale (sole a −20°): 0,000;
- la piattaforma campionata fitta (D da 1 a 23 a passo 0,5, altezze da 0,02 a 0,98 a passo 0,02: 2205 punti; riferimento 2048 passi): 241, 368 e 180 punti sopra 0,1 a 0,01, 0,02 e 0,04 rad, massimi 0,60, 0,69 e 0,34; a 96 passi e 0,02, 80 punti e massimo 0,27;
- la griglia 128×72 della scena `scene` (Task 6) a 0,02, point senza ombra, 48 passi contro 1024:
  - `rotation(0)`: 95 punti su 9216 sopra 0,1·sole, massimo 1,00; a 96 passi 53 e 0,58;
  - `rotation(-Math.PI/2)`: 77, massimo 1,00; a 96 passi 10 e 0,22;
  - `rotation(-Math.PI/6)`: 0;
  - 1024 contro 2048: 0 punti in tutte e tre.

Run: `node --test docs/plans/assets/2026-09-30-step6/march-model.test.mjs`. Prima RED (il modulo manca), poi GREEN. Commit: `test(6): modello CPU della marcia e i suoi test (i numeri del piano)`.

- [ ] **Step 1: i test che falliscono**

1. `probe-checks.test.ts`, test 'viewBounds: the world rectangle of an orthographic view-projection, camera offset included'. Si costruisce VP = `mat4Multiply(orthographic(-17.78, 17.78, -10, 10, -1, 1000), view)` con `orthographic` e `mat4Multiply` di `camera.ts`, dove `view` è l'identità con la colonna 3 = (−3, −200, 0, 1), cioè la camera in (3, 200); atteso `[-14.78, 20.78, 190, 210]` entro 1e-4.

2. `lighting-directional.test.ts`, con `floor = [0.185, 0.17, 0.295]`, `sun = [1, 0.9, 0.7]`, `lit = floor + sun`:
   - 'sunPoints: S downwind, U upwind, Rx and Ry the mirrors across the axes': coordinate lungo e di traverso rispetto al sole per θ = −π/6 (S: +2,5/0; U: −2,5/0; Ry: +1,25/+2,165; Rx: −1,25/−2,165).
   - 'directionalShadowVerdict: a sun behind a wall darkens the far side': S = floor, gli altri lit → `ok`; nel `detail` c'è `1 group, 1 SDF set`.
   - 'directionalShadowVerdict names the bug': marcia rovesciata (S lit, U = floor) → il messaggio contiene `upwind`; y di segno sbagliato (S lit, Ry = floor) → `y-mirror`; x di segno sbagliato (S lit, Rx = floor) → `x-mirror`.
   - 'directionalShadowVerdict: no SDF set means the grouping does not count the sun as shadowed': `sdfSets` 0 → fallisce con `does not count the directional light as shadowed`.
   - 'shadowLengthVerdict: dark at the caster, lit past the range, never darker farther away': i profili sono `floor + f·sun`, e passano sia quello lineare (f = 0,08, 0,33, 0,67, 0,88, 1) sia quello a coda (f = 0, 0, 0, 0,5, 1).
   - 'shadowLengthVerdict fails a shadow that never ends, or ends too early': f = (0, 0, 0, 0, 0) e f = (1, 1, 1, 1, 1) falliscono.
   - 'edgePopVerdict measures the pop and pins the step-6 edge rule': righe sintetiche → `pop` ≈ 1, e il `detail` contiene `max`, `far edge`, `% of the width`, `range 100` e le dimensioni.
   - 'edgePopVerdict fails when the march reads past the SDF, an off-screen caster casts, or the caster in view casts nothing': E = floor + 0,2·sun → `past the SDF`; L_out ≠ L_ref → `off-screen caster already casts … step 8c`; pop(1) < 0,5 → `casts nothing`.
   - 'checkDirectional in Mode A: three skips, every handle destroyed, the view restored'. Motore finto come `modeAEngine()` di `rendering-fx.test.ts`, con handle concatenabili (`position/rotation/scale/castsShadow/receivesLight/light/destroy`), `cam.viewProjection` reale, `debug.probe` che rifiuta con `The debug probe needs the main-thread renderer of a dev build`, e `requestAnimationFrame`/`document` stubbati. Atteso: i tre nomi con stato `skip`, ogni handle distrutto, `restoreView` chiamata una volta, `entities` contiene le handle della sotto-scena.

- [ ] **Step 2: RED**: `npx --prefix ts vitest run --root ts src/demo/lighting-directional.test.ts src/demo/probe-checks.test.ts`. FAIL: il modulo non c'è e `viewBounds` non c'è.

- [ ] **Step 3: il codice**

1. `probe-checks.ts`:
```ts
/** The world rectangle an orthographic, unrotated view-projection shows: [xMin, xMax, yMin, yMax]. */
export function viewBounds(vp: Float32Array): [number, number, number, number] {
  return [(-1 - vp[12]) / vp[0], (1 - vp[12]) / vp[0], (-1 - vp[13]) / vp[5], (1 - vp[13]) / vp[5]];
}
```
2. `lighting-directional.ts`, con l'intestazione che spiega il perché della sotto-scena: la scena del tab nasconderebbe un gate TS rotto, perché la sua point già crea il set. Costanti: `SUN_SCENE`, `SUN_COLOR`, `SUN_ROTATION = -Math.PI / 6`, `PROBE_DISTANCE = 2.5`, `SHORT_RANGE = 6`, `LENGTH_DISTANCES = [0.5, 2, 4, 5.25, 7.5]`, `SUB_HALF_WIDTH = 17.6`, `TOL = 0.03`. Le regole:
   - **Luce del sole e strato.** `lum(sun) = luminance([...SUN_COLOR, 1])` (0,907). Lo strato si legge **prima** del probe: `layerToGroup[0] & 0xf` di `engine.lighting.groups`, 0 se `groups` è null. I conteggi di gruppi e set per il verdetto si leggono **dopo** il probe, così che in Mode A il check vada in skip prima di guardarli.
   - **`directionalShadowVerdict`**, `ok` solo se valgono tutte:
     - 1 gruppo e 1 SDF set; altrimenti "no SDF set for the sun's group: deriveLightGroups does not count the directional light as shadowed", oppure "N groups, M SDF sets (expected 1 and 1)";
     - `lum(S)·2 < min(lum(U), lum(Rx), lum(Ry))`;
     - U, Rx e Ry entro `TOL` per canale;
     - U entro `TOL` da `floor + sun` per canale (un sole non ha falloff: il suo contributo è un colore statico);
     - S ≤ `floor + 0.1·sun` per canale.
     - Se uno fra U, Rx e Ry è sotto metà di `lum(floor + sun)`, il messaggio lo nomina: U "the shadow falls upwind: the march runs away from the light"; Ry "the shadow falls on the y-mirror: the y of the texel ray has the wrong sign (toScreenUV flips y)"; Rx "the shadow falls on the x-mirror: the x of the texel ray has the wrong sign".
     - `detail`: i quattro valori con `fmt`, poi `1 group, 1 SDF set`.
   - **`shadowLengthVerdict(profile, lit, sun)`**, `ok` se valgono tutte:
     - le luminanze non scendono mai più di 0,02 da un punto al successivo;
     - `lum(profile[0]) < lum(lit) − 0.5·lum(sun)`;
     - l'ultimo punto è entro `TOL` da `lit` per canale.
     - `detail`: le cinque luminanze con le distanze e `range 6`.
   - **`edgePopVerdict({ out, inn, ref, e }, ds, sun, meta)`**. `pop[i] = (lum(out[i]) − lum(inn[i])) / lum(sun)`. È valido se valgono tutte:
     - `out[i]` entro `TOL` da `ref[i]` per ogni i; altrimenti "an off-screen caster already casts (d = …): padding? update this check in step 8c";
     - E entro `TOL` da `ref[0]`; altrimenti "the march reads past the SDF: E, beside the caster at the edge, is darker than the open row";
     - `pop[0] ≥ 0.5`; altrimenti "the caster in view casts nothing".
     - `detail`: `pop X max, Y at the far edge (d = D), >= 0.1 over P% of the width; view W units at zoom Z, range 100, canvas CW×CH, light buffer LW×LH`. Il light buffer è `max(1, floor(canvas / 2))` per asse, come `halfResolution`; `canvas` da `document.getElementById('canvas')`.
   - **`checkDirectional`**:
     1. `fitView(engine, ...SUN_SCENE, SUB_HALF_WIDTH)`, poi lo spawn in un `engine.batch` (pavimento, muro A, sole), ogni handle in una lista propria **e** in `entities`, poi `frames(4)`.
     2. Check 1, con **una** lettura di S, U, Rx e Ry.
     3. `sun.light({ …, range: SHORT_RANGE })`, `frames(4)`, check 2 con **una** lettura dei cinque punti più U.
     4. `sun.rotation(0).light({ … })` col range di default, spawn di W_out e W_in, `frames(4)`, check 3 con **una** lettura delle tre righe più E.
     5. `finally`: `destroy()` di ogni handle della sotto-scena, `frames(4)`, `restoreView()`.
     - Ogni check passa per `pixelCheck`, che in Mode A e in produzione va in skip. In Mode A la sotto-scena si crea lo stesso; il sole, mai cullato, schiarisce per qualche frame la scena del tab nel render worker, ma è solo un effetto visivo.
3. `lighting.ts`:
   - Importa `{ pixelCheck, fmt, fitView, frames }` da `./probe-checks` e togli il `frames` locale (`:15-21`), che è identico.
   - `:62-65` diventa `fitView(engine, 0, 0, SCENE_HALF_WIDTH);`, lo stesso comportamento.
   - Costanti di modulo `AMBIENT: [number, number, number] = [0.06, 0.07, 0.12]` e `GLOBAL_LIGHT = { color: [0.25, 0.2, 0.35] as [number, number, number], energy: 0.5 }`, usate da `:105-106` e `:111`.
   - Etichetta (`:54`): `'Lighting (point / spot / directional / global, shadows, lit vs unlit)'`.
   - Dopo 'Layer shadow on screen' (`:173`) e prima di "Motion":
```ts
    // ── 6. A directional light's shadow, on a sub-scene far from this one ──
    // (round step 6): the sun is never culled, so it must not light this scene
    // or its checks. The view comes back before the lights start moving.
    const floor = AMBIENT.map((c, i) => c + GLOBAL_LIGHT.color[i] * GLOBAL_LIGHT.energy) as [number, number, number];
    await checkDirectional(engine, reporter, entities, floor, () => fitView(engine, 0, 0, SCENE_HALF_WIDTH));
```
   - Il codice e le soglie dei check 1-5 non cambiano.

- [ ] **Step 4: GREEN**: `npx --prefix ts vitest run --root ts src/demo/lighting-directional.test.ts src/demo/probe-checks.test.ts`, poi `npm --prefix ts test` e `tsc`.

- [ ] **Step 5: GPU (Mac, prima del commit)**
1. **Riavvia il dev server.** I file di `ts/src/demo/` sono cambiati: Vite servirebbe il modulo modificato con `?t=`, lo script per-tab ne avvolgerebbe un'altra istanza e aspetterebbe i suoi 60 s (memoria `mac-m2-gpu-tests`, "Captures").
2. Su chrome-devtools-gpu `navigate_page` a `"http://localhost:5173/?mode=B"` con `ignoreCache: true` e l'`initScript` anti-reload; `resize_page` a 1200×689 CSS (dpr 2), la finestra di M4.
3. Tab Lighting con lo script per-tab (Task 10, Step 3); attendi la fine del setup.
4. Ripeti in `?mode=C`.

Expected:
- 9 check `pass` in B e in C;
- i dettagli dei tre check nuovi coerenti con la geometria (S ≈ floor; profilo di lunghezza crescente fino a lit; pop ≈ 1 su ~100 % della larghezza);
- 'Lit vs unlit', 'Layer shadow on screen' e 'Light layers' confrontati **numericamente** con la base M4, `docs/plans/assets/2026-09-29-mac-m2/baseline/run1/statuses-{B,C}.json`: `lit 0.489, 0.101, unlit x light 0.489, 0.101 (light 0.813, 0.672, 0.630)`, `blue: in the band 0.295, mirrored point 1.098` e `2 groups, 2 SDF sets`, uguali in B e in C. Ogni numero stampato entro 0,002, cioè la stampa a 3 decimali più 1-2 ULP fp16, perché l'ordine delle luci può spostarli; i conteggi uguali. La base vale: M4 è stata presa con la stessa finestra, e dopo M4 l'unico commit sul codice della lighting è `ee0df52` (lo `stage()` del profiler), che non cambia pixel;
- console senza errori né avvisi nuovi.

Se un check fallisce, la causa si cerca con `superpowers:systematic-debugging` prima di toccare le soglie.

- [ ] **Step 6: commit**: `test(6): tre check col probe per il sole (ombra dietro un muro, lunghezza, comparsa al bordo dal lato del sole)`.

### Task 6: banco committato, statistica, A/B dell'angolo di penombra

**Files:**
- Create: `docs/plans/assets/2026-09-30-step6/step6-stats.mjs`, `docs/plans/assets/2026-09-30-step6/step6-stats.test.mjs`
- Create: `docs/plans/assets/2026-09-30-step6-directional-bench.js`
- Create: `docs/plans/assets/2026-09-30-step6/penumbra-ab-m2.json` (profili e griglia), `penumbra-{0.01,0.02,0.04}-B.png`, `fade-{0.75,0}-B.png`
- Modify: `ts/src/render/passes/light-accum-stage.ts` (doc di `LIGHT_SOURCE_FRACTION`: rimando all'A/B)
- Modify, secondo il ramo della sotto-decisione 2 (Step 6): `ts/src/lighting-api.ts` (JSDoc di `shadowSteps`); con (a) `ts/src/entity-handle.ts` (JSDoc di `LightType`); con (b) `ts/src/shaders/light-accum.wgsl` e `ts/src/render/passes/light-accum-stage.test.ts`

**Interfaces:**
- `step6-stats.mjs`, puro, eseguibile con `node step6-stats.mjs <cost|penumbra|regress|edgepop> <file.json>` e `node step6-stats.mjs details <harness.json> <statuses.json>`:
  - `detailsDiff(checks, baseStatuses, names, tol = 0.002)` → per ogni check nominato, i numeri estratti dai due `detail` (quello della corsa e quello di `tabs.lighting` della base M4), le differenze e `ok` (stessa quantità di numeri, ogni differenza ≤ `tol`);
  - `T975` (tabella di t(0,975; gdl) per 1-12 gdl, con 7 → 2,365);
  - `abbaEffects(blocks)` → `e_b = (on1 + on2 − off1 − off2) / 2`;
  - `tSummary(effects)` → `{ n, mean, sd, se, dof, t, lo, hi, verdict }`. Il verdetto è in inglese, come ogni stringa del modulo e ogni JSON (vincolo "Lingua"): "`<mean> ± <SE> ms (95% CI [lo, hi], n = N)`" quando `lo > 0`, altrimenti "`below resolution: < <hi> ms (mean … ± …, 95% CI […], n = N)`". Si traduce in italiano solo scrivendo la riga del §13.2 e la voce del §4 (Task 12);
  - `width1090(profile, lo, hi)`;
  - `maxRelDiff(a, b, scale)` e `countAbove(a, b, scale, thr)`;
  - `gridSummary(steps, ref, sunLum)` → `{ n, above01, fracAbove01, max, darker, lighter }`: per una griglia letta a un budget contro il riferimento, i punti fuori di più di 0,1·sole (in luminanza), il massimo, e quanti sono più scuri o più chiari del riferimento;
  - `popSummary(ds, pop)` → `{ maxPop, popFar, dFar, fracAbove01 }`;
  - `compareGrids(a, b)` → `{ n, identical, withinUlp, maxAbs, worst }`, con 1 ULP fp16 = `2^(floor(log2|v|) − 10)`.
- Lo script (un corpo di `evaluate_script`, come `2026-09-27-transparent-sort-bench.js`):
  - si configura con `window.__benchOpts = { task, label, … }`;
  - accumula i risultati in `window.__benchResults`;
  - restituisce `{ format: 'hyperion-step6-bench/1', task, label, mode, search, canvas, dpr, adapter, chrome, results }`, dove `chrome` è la `fullVersionList` di `navigator.userAgentData.getHighEntropyValues`.

- [ ] **Step 1: i test di `step6-stats` (RED)**

`step6-stats.test.mjs` (`node:test`), con valori calcolati a mano:
- `abbaEffects` su due blocchi noti;
- `detailsDiff`: il dettaglio di M4 `lit 0.489, 0.101, unlit x light 0.489, 0.101 (light 0.813, 0.672, 0.630)` contro sé stesso → `ok`; con un numero spostato di 0,001 → `ok`; di 0,003 → non `ok`; con un numero in meno → non `ok`;
- `tSummary`: n = 8, effetti `[0.30, 0.25, 0.40, 0.35, 0.20, 0.30, 0.45, 0.35]`, atteso media 0,325, gdl 7, t 2,365, `lo > 0`, verdetto col ± e `95% CI`; poi effetti a cavallo di 0 → verdetto `below resolution: < …`;
- `width1090` su una rampa lineare nota;
- `gridSummary` su una griglia sintetica con un punto più scuro e uno più chiaro di 0,2·sole e uno di 0,05·sole: 2 punti sopra 0,1, uno più scuro e uno più chiaro;
- `popSummary` su un profilo sintetico;
- `compareGrids`: identici; una differenza di 1 ULP fp16 (`withinUlp`); una di 3 ULP (fuori).

Run: `node --test docs/plans/assets/2026-09-30-step6/step6-stats.test.mjs`. Expected: FAIL, perché il modulo manca.

- [ ] **Step 2: `step6-stats.mjs` (GREEN)**: `node --test …` PASS.

- [ ] **Step 3: lo script, task per task**

**Guardie comuni:**
- `window.__hyperion` presente;
- pagina `?bench`;
- per `regress`, `penumbra` ed `edgepop`: `engine.mode` B o C e `engine.debug.probe` presente;
- per `cost`: `engine.mode === 'B'`, `gpuProfilingSupported` e `getGpuFrameTiming` funzione;
- ogni task distrugge le entità del task precedente (`window.__step6Entities`) e lascia le proprie vive per uno screenshot;
- `engine.resize(1920, 1080)` e camera (0, 0) con zoom 1, tranne `scene` con `resize: false`. La dimensione si controlla con un probe di **`scene-hdr`** (`targetSize` [1920, 1080]), mai della swapchain; con `resize: false` (gli screenshot, Mode A) il controllo si salta.

**Scena `scene`**, statica e deterministica: la scena del costo e degli screenshot A/B. Coordinate mondo; la vista 1920×1080 a zoom 1 è x ∈ [−17,78, 17,78], y ∈ [−10, 10].
- Pavimento `(0, 0, -0.5)` `scale(40, 24)` `receivesLight(true)`.
- Caster (`castsShadow(true)`):
  - muri `(-12, -1)` 0,6×5, `(-2, -4)` 0,6×4, `(9, 5)` 0,6×4;
  - piattaforme parallele ai raggi `(-4, 6.5)` 10×0,5 e `(6, -6.5)` 12×0,5;
  - scatole `(-8, -6)` e `(13, -1)` 1,5×1,5.
- Point `(-13, -3)`: `{ type: 'point', color: '#ffd9a0', energy: 1.2, range: 5, shadowIntensity: pointShadow }`.
- Sole `rotation(sunRotation ?? 0)`: `{ type: 'directional', color: [1, 0.95, 0.85], energy: 1, range: 100, shadowIntensity: sunShadow }`.
- `setAmbient([0.06, 0.07, 0.12], 1)`, `setBackend('lit')`, `shadowSteps` 48.
- Restituisce gli id, i gruppi e `probePoints`, cioè le coppie sottovento/sopravento di ogni muro a 3 unità dalle facce, per `pixels.py`.
- Si può lanciare anche in Mode A (niente probe).

**`regress`**, il criterio "point/spot invariati":
- Richiede `window.__step6OldLightAccum`, lo shader di `2f43e42` come stringa. Lo si imposta prima con un `evaluate_script` che incolla l'output di `git show 2f43e42:ts/src/shaders/light-accum.wgsl | jq -Rs .`.
- Scena senza sole:
  - pavimento e i muri `(-6, 2)` 0,8×5 e `(5, -3)` 6×0,8, più la scatola `(10, 5)` 1,5×1,5;
  - point `(-9, 0)` range 12 falloff 1,2 ombra 1;
  - spot `(12, -6)` `rotation(2.3)` range 18, inner 18, outer 30, ombra 1;
  - point col centro fuori schermo `(-21, 4)` range 8 ombra 1.
- Con la risposta (b) alla sotto-decisione 3, la point `(-21, 4)` esce da questa scena, che resta di sole luci col centro in vista. Ha una seconda cattura, `offscreen`, con le stesse due letture e un **cambiamento atteso**: ogni punto nuovo ≥ vecchio entro 1 ULP fp16, e si riporta quanti punti cambiano. Fermarsi all'uscita può solo schiarire: i campioni sono un prefisso di quelli di prima, e la regola 3 estrapola su un tratto più corto. Con (a) la point resta nella scena al bit.
- Legge il light buffer (gruppo 0) su una griglia UV 64×36 di centri di cella (2304 punti) con lo shader nuovo.
- Poi `engine.recompileShader('light-accum', OLD)` e attende che valgano `LightAccumStage.SHADER_SOURCE === OLD` (dal modulo `await import('/src/render/passes/light-accum-stage.ts')`, la stessa istanza dell'app) e `engine.renderer.graph !== g0`, più `frames(4)`. Rilegge.
- Rimette lo shader nuovo con la stessa attesa e verifica `SHADER_SOURCE === NEW`.
- Restituisce le due griglie. Lo shader vecchio gira col layout nuovo: il binding 5 visibile a più stadi non invalida uno shader che lo usa solo nel fragment.

**`penumbra`**, l'A/B deciso. La scena:
- pavimento;
- muro `(-12, -4)` 0,6×6;
- piattaforma `(0, 5)` 24×0,5, parallela ai raggi: il caso allineato agli assi con la faccia più lunga;
- sole `rotation(0)`, range 100, unica luce ombreggiata, così i raggi vanno fino all'uscita dall'SDF (fino a 960 texel).

Le letture (una sola lettura per ogni coppia angolo/passi):
- **muro:** profili di traverso al bordo superiore della sua banda d'ombra (y = −1) a d = 2, 12 e 26 unità oltre la faccia: 41 punti per y ∈ [−2, 0];
- **piattaforma:** profili sopra la faccia superiore a D = 2, 6, 9,5, 16 e 22 unità dal suo capo sopravento: 25 punti per altezze da 0,02 a 0,98;
- **diagonale:** gli stessi profili della piattaforma con il sole a `rotation(-20 * Math.PI / 180)`;
- **griglia** (opzione `grid`): tutto il light buffer della scena `scene`, con i soli allineati agli assi. Profili e diagonale non vedono i soli a `rotation(0)` e `rotation(-Math.PI/2)` sopra caster dritti, cioè l'esempio del JSDoc sopra ogni sprite non ruotato: è lì che il modello mette gli errori.

Opzioni:
- `{ angle }`: sostituisce nel sorgente **una** occorrenza esatta di `return shadow(origin, ray.xy, travel, u.sourceFraction, ray.z);` con il letterale (asserendo una sostituzione sola), la ricarica con `engine.recompileShader('light-accum', patched)` e l'attesa sopra, e per `shadowSteps` 48 e 1024 (`setQuality`, attesa di `_needsRebuild === false`, `frames(4)`) legge i profili; lascia attivi 48 passi per lo screenshot;
- `{ convergence: true }` (a 0,02): 2048 contro 1024;
- `{ grid: true }` (all'angolo in prova, di default 0,02): costruisce la scena `scene` con `pointShadow: 0`, così solo il sole dipende dal budget, e `sunShadow: 1`. Per `rotation(0)`, `rotation(-Math.PI/2)` e `rotation(-Math.PI/6)`, a 48, 96, 1024 e 2048 passi, legge il light buffer (gruppo 0) su una griglia UV 128×72 di centri di cella: 9216 punti in una chiamata del probe, che non ha un limite di punti (`debug-probe.ts:175-181` dimensiona i buffer sulla richiesta). Restituisce le griglie grezze, il colore del sole (`[1, 0.95, 0.85]`, energia 1) e i metadati;
- `{ fadeStart, range: 12 }`: sostituisce `const SUN_FADE_START: f32 = 0.75;` con un letterale float (per esempio `0.0`), solo per lo screenshot della sfumatura;
- `{ restore: true }`: rimette il sorgente originale e `shadowSteps` 48 e lo verifica.

**`edgepop`**, la misura per il passo 8c. È la geometria del check 3 intorno all'origine: W_out `(xL − 0.55, 3)`, W_in `(xL + 0.2, 8)`, righe y = 3, 8, 5,5 con d da 0,5 a W − 0,5 a passo 0,5, ed E `(xL + 1, 6.6)`. Il sole è a `rotation(0)`, per `ranges: [100, 30, 10]` (il range si rimanda con `light()`, poi `frames(4)`). Restituisce le righe grezze e i metadati (W, zoom, canvas, light buffer).

**`cost`**, con `{ pairs: ['march'] | ['set'] | ['pointspot'] | ['uber'], blocks, … }` (8 blocchi per `march`, `set` e `uber`, 4 per `pointspot`; `uber` prende anche `n` e `quadPx`):
- **Condizioni sulla scena `scene`:**
  - `march`: ON = point 1, sole 1; OFF = point 1, sole 0. Isola la marcia, perché l'SDF set resta vivo;
  - `set`: ON = point 0, sole 1; OFF = point 0, sole 0. Include il set del sole.
  - Si applicano con `point.shadows(p)` e `sun.shadows(s)`.
- **Coppie fuori dal criterio** (Task 11; il criterio del §3 ne chiede due, e queste non lo toccano):
  - `pointspot`: la scena di `regress` senza sole, con le sole luci col centro in vista. ON = `light-accum.wgsl` nuovo, OFF = quello di `2f43e42`, scambiati con `engine.recompileShader('light-accum', …)` e l'attesa di `regress`. Misura quanto costano a point e spot i termini nuovi della marcia condivisa: un `select` valuta entrambi gli operandi, quindi `sunFade` e il `select` per passo restano, a meno che il compilatore non li tolga;
  - `uber` (design 5b §11, `:791`: la gamba Chrome dell'A/B senza codice). La scena del banco del 5b: `n` quad 2D `.transparent()` di `quadPx` px (10 000 e 16 px, poi 2 px), posizioni dal PRNG con seme di `2026-09-27-transparent-sort-bench.js`, depth tutte 0, lighting spenta. ON = le librerie committate; OFF = le cinque librerie diverse dal quad (`line`, `msdf-text`, `bezier`, `gradient`, `box-shadow`) sostituite da stub con `engine.recompileShader(<nome>, stub)`. Uno stub tiene le tre funzioni che il compositore chiama: `<p>vs(position: vec3f, entityIdx: u32) -> VertexOutput`, che restituisce `culledVertex()`, e `<p>fs(in: VertexOutput) -> vec4f` e `<p>occluder(in: VertexOutput) -> vec4f`, che restituiscono `vec4f(0.0)`; più il commento `// step6-uber-stub`. Prima della corsa l'uber composto con gli stub (`ForwardPass.UBER_SOURCE`) passa `getCompilationInfo()` senza messaggi, come al cancello del Task 2. Gli originali tornano dai `?raw` dei pezzi.
- **Segnale di vita**, ad ogni frame fino a 60:
  - `engine.lighting.groups.sdfSets.length` uguale a 1, 1, 1, 0 per march ON, march OFF, set ON, set OFF, e a 1 nelle due condizioni di `pointspot`;
  - per `march` e `set`, lo slot 7 di sole e point in `engine.bridge.latestRenderState.primParams` (slot da `entityIds.indexOf(id)`) uguale alla condizione;
  - `engine.renderer.graph.executionOrder` contiene `light-groups` (non per `uber`, che ha la lighting spenta);
  - `engine.lighting._needsRebuild === false`;
  - `pointspot`: `LightAccumStage.SHADER_SOURCE` uguale allo shader della condizione, e il grafo cambiato dopo lo scambio; `uber`: `ForwardPass.UBER_SOURCE` (dal modulo `/src/render/passes/forward-pass.ts`, la stessa istanza dell'app) contiene `step6-uber-stub` solo in OFF, e il grafo cambiato dopo lo scambio.
- **Una finestra:**
  1. 30 frame di assestamento;
  2. `disableGpuProfiling(); enableGpuProfiling();`;
  3. snapshot di `discardReasons`;
  4. attesa via `requestAnimationFrame` di `getGpuFrameTiming().sampleCount >= 120` (timeout 20 s), registrando i timestamp di rAF;
  5. nello stesso turno sincrono: `frameTiming`, `getGpuTimings()`, la copia di `engine.renderer.graph.profiler.window.spans`, `discardReasons`, `skippedFrames`, la dimensione del canvas, i gruppi, l'oggetto grafo.
- **Validità di una finestra:**
  - 120 campioni;
  - 0 scarti nuovi;
  - fps ≥ 0,95 × la cadenza misurata su 60 frame all'avvio del task;
  - canvas 1920×1080;
  - condizione e grafo invariati dall'inizio alla fine.
- **Quantizzazione:** dopo la prima finestra, se ogni span è un multiplo di 0,065536 ms entro 1e-6 lo script si ferma con `quantized timestamps: run on chrome-devtools-gpu`.
- **Blocchi:** `[ON, OFF, OFF, ON]`. Un blocco con una finestra non valida si rifà in coda, e la finestra resta nel JSON con il motivo; al massimo 4 rifacimenti per coppia, oltre si ferma e riporta.
- **Ambiente:** `opts.environment` (lo compila chi esegue: `pmset`, browser, campionatore) finisce nell'output.

- [ ] **Step 4: prova dello script sulla GPU (Mac, Mode B)**
1. Riavvia il dev server se nel frattempo c'è stato un checkout.
2. chrome-devtools-gpu, `"http://localhost:5173/?mode=B&bench"` con l'`initScript` anti-reload.
3. `scene` (niente errori, `groups` [1, 1]), poi `regress` (con lo shader vecchio impostato prima).
4. `node docs/plans/assets/2026-09-30-step6/step6-stats.mjs regress <out>`.

Expected: 2304 punti, **identici** oppure entro 1 ULP fp16; ogni punto fuori tolleranza si indaga prima di andare avanti (Review Focus 2).

- [ ] **Step 5: l'A/B dell'angolo e la griglia (Mac, Mode B). Decide la regola fissata prima, con i rami che il proprietario ha scelto allo Step 0 del Task 0.**
1. `penumbra` con `angle` 0,01, poi 0,02, poi 0,04. Dopo ciascuno, `take_screenshot` in `docs/plans/assets/2026-09-30-step6/penumbra-<angolo>-B.png`, con `filePath` assoluto.
2. `convergence` a 0,02; se 1024 e 2048 differiscono di più di 0,01·sole, il riferimento diventa 4096 e si rifà.
3. `grid` a 0,02. Se in un punto della griglia 1024 e 2048 passi differiscono di più di 0,01·sole, il riferimento diventa 4096 e si rifà.
4. `fadeStart` 0,75 e 0 con `range: 12`, uno screenshot ciascuno; poi `restore`.
5. Salva l'output in `penumbra-ab-m2.json` e passa `node … step6-stats.mjs penumbra penumbra-ab-m2.json`.

Per ogni angolo la statistica riporta:
- la pendenza di `w10-90(d)` contro 0,8·angolo·d (a d = 12 e 26);
- `max |L48 − Lref| / sole` sui profili del muro e sulla diagonale;
- sulla piattaforma parallela: lo stesso massimo, i punti fuori di più di 0,1·sole e lo spessore della banda.

Per la griglia, per ogni rotazione (`gridSummary`): la frazione dei 9216 punti fuori di più di 0,1·sole a 48 passi contro il riferimento, il massimo, quanti sono più scuri e quanti più chiari; lo stesso a 96 passi; e 1024 contro 2048.

**Regola, fissata prima della corsa:**
- 0,02 è **confermato** se a 0,02 l'errore a 48 passi è ≤ 0,05·sole sui profili del muro e della diagonale, e la pendenza è entro ±50 % di 0,8·0,02 a d = 12 e 26;
- la banda della piattaforma parallela e la griglia non sono un criterio dell'angolo: gli errori ci sono a ogni angolo, perché dipendono dal budget di passi;
- se la pendenza fallisce a ogni angolo, è un difetto: si indaga (`superpowers:systematic-debugging`) prima di ogni altra cosa;
- se 0,02 non passa e un altro angolo sì, si applica il ripiego scelto per la sotto-decisione 1 e lo si scrive nel rapporto finale: il modello prevedeva la conferma;
- sulla griglia vale la sotto-decisione 2, scelta sui numeri del modello a `rotation(-Math.PI/2)`, l'esempio del JSDoc. La GPU **conferma** il modello se lì, a 48 passi, più dello 0,1 % dei punti è fuori di più di 0,1·sole (modello: 0,84 %): lo Step 6 esegue il ramo scelto. Altrimenti la GPU smentisce il modello: ci si ferma e si richiede la sotto-decisione 2, con i numeri misurati.

Il proprietario si richiede solo in quel caso. Il rapporto finale (Task 12) porta comunque gli screenshot dei tre angoli e della sfumatura, e i numeri.

Il modello CPU (Task 5, Step 0) prevede:
- la conferma di 0,02: errore 0,000 sui profili del muro a tutti e tre gli angoli, 0,000 sulla diagonale, pendenze fra 0,98 e 1,03 volte 0,8·angolo·d;
- sulla piattaforma parallela, a 0,02 e 48 passi, una banda: sui 125 punti letti, massimo 0,69 e 20 punti sopra 0,1, fino a 0,42 unità sopra la faccia (campionata fitta: 368 punti su 2205);
- sulla griglia, a 48 passi: `rotation(0)` 1,03 % dei punti sopra 0,1·sole, massimo 1,00; `rotation(-Math.PI/2)` 0,84 %, massimo 1,00, con 30 dei 75 punti liberi più chiari del riferimento, cioè luce che passa; `rotation(-Math.PI/6)` 0. A 96 passi: 0,58 % (massimo 0,58) e 0,11 % (0,22). 1024 e 2048 coincidono.

- [ ] **Step 6: esito nel codice, secondo i rami scelti**

**Sotto-decisione 1.** Con 0,02 confermato, alla doc di `LIGHT_SOURCE_FRACTION` si aggiunge "(confirmed by the GPU A/B of round step 6: docs/plans/assets/2026-09-30-step6/penumbra-ab-m2.json)". Se il ripiego scelto è (b), la costante `SUN_ANGLE` entra con lo stesso schema TDD del ramo (b) qui sotto, e l'A/B si rifà al valore nuovo.

**Sotto-decisione 2, ramo (a): limite documentato.** I numeri sono quelli misurati sulla griglia, non quelli del modello.
- JSDoc di `LightType` (`entity-handle.ts`), nel paragrafo dell'asse, subito dopo l'esempio `rotation(-Math.PI / 2)`: "An axis-aligned sun (rotation 0, ±π/2 or π, like the examples above) over casters about 2 world units or more along its rays can exhaust the shadow-march budget along the faces parallel to its rays: thin dark streaks beside them, and light leaking past the next caster (at `rotation(-Math.PI / 2)` and the default 48 steps, <X> % of the light buffer is off by more than a tenth of the sun; round step 6). Raise `LightingQuality.shadowSteps` (e.g. 96) in such scenes."
- JSDoc di `LightingQuality.shadowSteps` (`lighting-api.ts:59-70`), dopo "(2026-09-26).": "An axis-aligned directional light (rotation 0, ±π/2 or π) over casters about 2 world units or more along its rays spends the budget along the faces parallel to its rays: at 48 steps <X> % of the light buffer is off by more than a tenth of the sun at `rotation(-Math.PI / 2)` and <Y> % at `rotation(0)`, at 96 steps <X96> % and <Y96> % (round step 6, docs/plans/assets/2026-09-30-step6/penumbra-ab-m2.json). 96 raises the budget of point and spot lights too."

**Sotto-decisione 2, ramo (b): budget doppio del sole.** Un giro TDD in più, prima del Task 7:
1. test di testo che falliscono, in `light-accum-stage.test.ts`:
   - `functionParams(…, 'shadow')` diventa `['origin', 'dir', 'travel', 'angle', 'fadeReach', 'steps']`, e in `body('shadow')` non c'è più `u.shadowSteps` (i due limiti del loop diventano `i < steps`);
   - `pointShadow` passa `u.shadowSteps`, quindi point e spot restano identici; le attese dei test del Task 1 e del Task 2 su quella riga cambiano con lei;
   - `sunShadow` finisce con `return shadow(origin, ray.xy, travel, u.sourceFraction, ray.z, 2u * u.shadowSteps);`. È il testo esatto che la patch `{ angle }` del banco cerca: il banco si aggiorna nello stesso commit;
2. la modifica; vitest, naga e `npm --prefix ts test`;
3. sulla GPU: `regress` di nuovo (identico) e la griglia a 48 passi, che per il sole ora ne valgono 96;
4. JSDoc di `shadowSteps`, dopo "(2026-09-26).": "A directional light marches up to twice this budget (round step 6): an axis-aligned sun over casters about 2 world units or more along its rays spends it along the faces parallel to its rays. Casters longer than about 4 units along the rays can still exhaust it: at `rotation(0)`, <Y2> % of the light buffer is off by more than a tenth of the sun (docs/plans/assets/2026-09-30-step6/penumbra-ab-m2.json)."
5. commit `feat(6): budget doppio per la marcia del sole (sotto-decisione 2 (b))`.

La coppia `march` del Task 11 misura poi il costo con il ramo scelto.

- [ ] **Step 7: commit**
```bash
git add docs/plans/assets/2026-09-30-step6-directional-bench.js docs/plans/assets/2026-09-30-step6/ ts/src/render/passes/light-accum-stage.ts
git commit -m "test(6): banco committato (scena statica, regressione point/spot, A/B dell'angolo e griglia, comparsa al bordo, costo a due coppie) e statistica" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Col ramo (a) della sotto-decisione 2 entrano anche `ts/src/lighting-api.ts` ed `ts/src/entity-handle.ts`; il ramo (b) ha il suo commit (Step 6).

### Task 7: documenti obsoleti (§5 del piano del giro) e note nuove

**Files:**
- `docs/plans/2026-08-04-phase17-lighting-2d-design.md`
- `docs/plans/2026-09-26-phase17-light-layer-groups-design.md`
- `CLAUDE.md`

Nessun test. Dopo ogni modifica a un documento lungo: `git diff --numstat` (gotcha di CLAUDE.md).

- [ ] **Step 1: design 17** (italiano)
1. **§4-B, `:221`**: "✅ La **luce globale è letteralmente il clear color** del light buffer. Costa zero." diventa "✅ In Unity la **luce globale è letteralmente il clear color** del light buffer: costa zero. (In Hyperion il clear è l'ambient del motore, `setAmbient`; una luce `global` è un'entità additiva e mascherata, un ambient per layer, e nel backend `lit` non proietta ombre.)"
2. **E2, `:470`**: "L'oversize serve a evitare che occluder appena fuori schermo smettano di proiettare ombra — artefatto reale e visibile." diventa "In Godot l'oversize allarga l'SDF 2D, che le ombre integrate delle `Light2D` non leggono (usano l'atlante d'ombra 1D, E1): serve a `texture_sdf()` dei canvas_item, alle collisioni delle particelle e alle ombre marciate su SDF, per le quali evita che occluder appena fuori schermo smettano di proiettare ombra — artefatto reale e visibile. Le ombre di Hyperion sono marciate sull'SDF: il caso è il nostro (misura al §17, punto 1)."
3. **`:488`**: "oppure oversize 110% (1,21× i pixel) come compromesso." diventa "oppure oversize 110% (1,2× per asse, **1,44× i pixel**, con la semantica di Godot e del codice: il margine va su entrambi i lati) come compromesso."
4. **§7.3, `:571`**: "**Clear color = luce ambientale globale.** Come Unity: costa zero." diventa "**Clear color = l'ambient del motore** (`setAmbient`), per ogni gruppo: costa zero. Una luce `global` non è il clear: è un quad a schermo intero additivo e mascherato (un ambient per layer), e nel backend `lit` non proietta ombre."
5. **§7.3, dopo la nota "Implementato 2026-09-26" di A2 (`:600`)**, la nota nuova:
   > 🆕 **Ombre directional, passo 6 del giro (2026-09-30).** Una luce directional splende verso il suo asse +x locale (`lightFacing`, lo stesso helper dello spot): `rotation(-Math.PI/2)` la fa splendere verso il basso dello schermo, perché il mondo è y-up. `vs_main` calcola una volta per luce il raggio verso la luce in texel dell'SDF (proiezione come vettore, w = 0) e la lunghezza dell'ombra, il `range` della luce in texel. Il fragment marcia (`sunShadow`) fino a min(range, uscita dall'SDF), e oltre l'SDF conta come illuminato: la lettura clampata ripeterebbe il bordo all'infinito, e la regola dei passi finiti, estrapolata all'infinito, darebbe 0. L'angolo è fisso, `u.sourceFraction`: 0,02 rad (circa 1,15°), la larghezza della penombra per unità di distanza, cioè circa il **diametro** angolare della sorgente; è l'angolo di ogni point al bordo del suo range (1/k = 0,125 rad sarebbe 13 volte il diametro del sole vero, 0,0093 rad). Un caster a distanza t dal pixel ombreggia a forza piena fino a 3/4 del range, poi sfuma con una smoothstep fino a 0. Un caster fuori schermo non proietta nulla; la comparsa al bordo dal lato del sole è al §17, punto 1. Le luci `global` non proiettano ombre nel backend `lit`. Costo nel §13.2; A/B dell'angolo in `assets/2026-09-30-step6/penumbra-ab-m2.json`.
6. **§9.2, `:762` e `:766`**: le righe degli slot 3 e 7 diventano
```text
| 3 | `range` | raggio in unità mondo (point, spot); per una directional, la lunghezza dell'ombra |
| 7 | `shadowIntensity` | `0` = nessuna ombra; ignorata sulle `global` nel backend `lit` |
```
7. **§11, l'esempio (`:853-873`)**:
   - `torcia.setParent(personaggio);` diventa `torcia.parent(personaggio.id);`;
   - `shadowSteps: 24,` diventa `shadowSteps: 48,`;
   - i commenti di `bufferScale` e `sdfOversize` prendono "(non ancora onorato: il renderer avvisa una volta)";
   - dopo `muro…` aggiungi:
```ts
// Un sole: splende verso il suo +x locale; l'ombra è lunga `range` e sfuma verso la fine
const sole = engine.spawn()
  .rotation(-Math.PI / 3)                 // da in alto a sinistra verso in basso a destra (mondo y-up)
  .light({ type: 'directional', color: '#fff4e0', energy: 1.2, range: 40, shadowIntensity: 1 });
```
   - nella stessa modifica, la frase subito sotto l'esempio (`:876`), "`setBackend()` provoca un `rebuildGraph()`. Stessa meccanica di `enableBloom` / `enableOutlines`.", diventa "Al cambio del backend `setBackend()` fa richiedere al renderer il grafo lit (`followLightingBackend`), che va live dopo la validazione GPU, come i grafi di `enableBloom` / `enableOutlines`." (`rebuildGraph` non esiste più in `ts/src`).
8. **`:944`** e **`:952`**. La tabella di `:940-945` conta pass di JFA puro (960×540 → 10), e per quella convenzione l'11 di 1344×756 è giusto. La catena di Hyperion però è 1+JFA, quindi le due righe diventano
```text
| 🆕 1344×756 (half + oversize 120%) | 11 (12 con il load pass di 1+JFA) | **~0,35 ms** |
| **catena 1+JFA, 12 pass** (half + oversize) | entrambi | **~0,35 ms** 🆕 (era "non misurato") |
```
   e sotto la tabella di `:940-945` va la nota "> I conteggi di questa tabella sono pass di JFA puro: la catena di Hyperion (1+JFA, §6.2 A3) ne aggiunge uno."
9. §10.2 e §7.3:577 ("Mix in-shader") restano al passo 7.

- [ ] **Step 2: design dei light layers**
- `:53`: "È lo stesso test dello shader: point o spot con `clamp(primParams[7], 0, 1) > 0`. Globali e direzionali per ora non proiettano ombre." diventa "È lo stesso test dello shader (`shadowedLightType`): point, spot o directional con `clamp(primParams[7], 0, 1) > 0`. Le globali non proiettano ombre nel backend `lit`: `shadowIntensity` è ignorata, e il renderer avvisa una volta in dev (`shadowedGlobalLight`)."
- `:224`: "- le ombre delle luci globali e direzionali." diventa "- le ombre delle luci globali: mai, nel backend `lit` (le directional le proiettano dal passo 6 del giro)."

- [ ] **Step 3: CLAUDE.md** (inglese)
1. `:250` (riga `renderer.ts`): "with a one-time warning for multi-bit receivers)" diventa "with a one-time warning for multi-bit receivers and, in dev builds, one for a global light with `shadowIntensity` > 0)".
2. `:268` (riga `render/light-groups.ts`): prima di " A shadowed layer with no caster gets no set |" inserisci "Shadowed lights: `SHADOWED_LIGHT_TYPES` (point, spot, directional), tied by a text test to `shadowedLightType` in `light-accum.wgsl`; a global light with `shadowIntensity` > 0 only raises `shadowedGlobalLight` (the renderer's dev warning)."
3. `:276` (riga `render/passes/light-accum-stage.ts`): da "A point or spot light is a quad of its range" alla fine diventa: "A point or spot light is a quad of its range, a global or directional light covers the screen. Binding 5 (the SDF) is visible to the vertex stage too: `vs_main` computes a directional light's shadow ray from its size. `light-accum.wgsl` applies (1 − d/range)^falloff and the spot cone (spot and directional lights face their local +x, `lightFacing`), and when `shadowIntensity > 0` it sphere-marches the signed SDF with Quilez's original h/t term (not Aaltonen): point/spot (`pointShadow`) against the light's angle `min(1/k, sourceRadius / D)`, `sourceRadius = LIGHT_SOURCE_FRACTION × range`; directional (`sunShadow`) toward the light along its axis for min(range, SDF exit) texels (beyond the SDF counts as lit) at the fixed angle `u.sourceFraction` (0.02 rad: the penumbra's width per unit of distance, about the source's angular diameter), each caster's strength fading over the last quarter of the range; a pixel inside an occluder leaves it first, and penumbra distances run from that exit; a march out of steps extrapolates its last clearance to the end of the ray. Global lights never cast shadows in the lit backend. Not yet: the `sprite` light type, the `mix` blend mode |".
4. `:359` (riga `demo/lighting.ts`): prima di "(6 checks)" aggiungi "Then a sub-scene far away (`demo/lighting-directional.ts`), where a shadowed sun is the only shadowed light in view: 'Directional shadow' (a wall at −30°, the far side dark, both mirrors lit, 1 group and 1 SDF set), 'Directional shadow length' (range 6: dark at the caster, lit past the range) and 'Directional edge pop (measured)' (casters straddling the upwind edge: the pop, and a point beside the caster that stays lit only if the march stops at the SDF); destroyed, and the view restored, before the lights move"; poi "(6 checks)" diventa "(9 checks)".
5. `:416` (riga `light-accum.wgsl`): dopo "attenuation + spot cone," aggiungi "the shared `lightFacing` (+x), the sun's ray (`directionalRay`, in `vs_main`) and march (`sunShadow`: min(range, SDF exit), fade),".
6. `:444` (gotcha del range): in fondo "On a directional light slot 3 is the length of its shadows (fading out over the last quarter; 0 or less casts none), and its `BoundingRadius` stays `f32::MAX`."
7. `:446` (gotcha dei light layers): dopo "(0: none; global/directional obey it too)" inserisci "; shadows come from point, spot and directional lights, never from a global one in the lit backend".
8. `:452` (gotcha della marcia): in fondo "(4) A sun (directional light) marches toward the light for min(range, SDF exit) and counts everything beyond the SDF as lit: the clamped read would extrude the edge row forever, and rule (3) extrapolated to infinity is 0, so never march a sun to infinity. A caster off screen therefore casts nothing: the upwind edge pop, measured in round step 6 and decided in step 8c." Poi la frase del ramo scelto per la sotto-decisione 2, con i numeri misurati al Task 6: con (a), "An axis-aligned sun (rotation 0, ±π/2, π) over casters about 2 world units or more along its rays exhausts 48 steps along the faces parallel to its rays (<X> % of the light buffer off by more than a tenth of the sun at rotation(-Math.PI/2)): documented in `LightType` and `shadowSteps`, remedy 96 steps"; con (b), "A sun marches with twice the budget (`2u * u.shadowSteps`); casters longer than about 4 units along an axis-aligned sun's rays can still exhaust it (<Y2> % at rotation(0))". Con la risposta (a) alla sotto-decisione 3, anche: "Point and spot lights do NOT stop at the SDF exit: a light centred off screen marches the clamped edge row toward its centre (round step 8c)."
9. `:751` ("Open: …"): "Open: `sprite` lights, the `mix` blend, shadows from global/directional lights." diventa "Open: `sprite` lights and the `mix` blend (round steps 7-8); global lights never cast shadows in the lit backend (round step 6, by design)."
10. `:783`: "today 10 tabs, 57 checks" diventa "today 10 tabs, 60 checks".
11. `:348` (riga `demo/probe-checks.ts`): dopo "`near`, `luminance`, `fmt`, `frames`, `fitView` (centres the camera and zooms out, never in, until a half-width fits)" aggiungi ", `viewBounds(vp)` (the world rectangle `[xMin, xMax, yMin, yMax]` of an orthographic, unrotated view-projection)".
12. Una riga nuova dopo `:359`, per `demo/lighting-directional.ts`: "| `demo/lighting-directional.ts` | The Lighting tab's directional-light checks (round step 6), on a sub-scene centred at (0, 200) where a shadowed sun is the only shadowed light in view, so a TS gate that does not count directional lights fails them (the tab's point would otherwise create the SDF set). `checkDirectional(engine, reporter, entities, floor, restoreView)` and the pure verdicts `sunPoints`, `directionalShadowVerdict`, `shadowLengthVerdict`, `edgePopVerdict`, each tested with fixtures; the geometry and thresholds come from the committed CPU model (`docs/plans/assets/2026-09-30-step6/march-model.mjs`). Its 5 entities take fresh ids, so the tabs after Lighting have ids 5 higher than at the M4 capture |".
13. `:323` (riga `lighting-api.ts`): dopo "the debug readout for what splits them" aggiungi "; it also carries `shadowedGlobalLight` (a global light in view asks for shadows, which the lit backend never casts from a global light: the renderer warns once in dev builds)".
14. Il gotcha del range (`:444`), dopo la frase del punto 6: "Scenes, command tapes and snapshots with a shadowed directional light (`shadowIntensity > 0`) cast nothing before round step 6; they now cast `range`-long shadows, 100 world units by default, and pay the sun's march." (lo stesso avviso che il gotcha della rotazione dà per i tape vecchi).
15. La lista della Documentation, dopo `:823`: "- `docs/plans/2026-09-30-step6-directional-shadows-plan.md` — Round step 6 implementation plan (directional shadows): sub-decisions, committed bench and CPU march model, GPU checks."

- [ ] **Step 4: controllo e commit**
```bash
git diff --numstat
git add docs/plans/2026-08-04-phase17-lighting-2d-design.md docs/plans/2026-09-26-phase17-light-layer-groups-design.md CLAUDE.md
git commit -m "docs(6): ombre directional nel design 17 e nei light layers; correzioni di E2, 110 %, pass 1+JFA, §11; CLAUDE.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Expected: nessun documento perde molte più righe di quante ne guadagni.

### Task 8: preflight

- [ ] **Step 1**: `preflight.sh` non esegue i file `node:test` (cargo, clippy, tsc, vitest, WASM e protocollo), quindi i due si lanciano a parte:
```bash
scripts/preflight.sh
node --test docs/plans/assets/2026-09-30-step6/step6-stats.test.mjs docs/plans/assets/2026-09-30-step6/march-model.test.mjs
```
Expected: tutto `OK`, e i due `node:test` verdi. Un passo che fallisce si corregge (test prima) e si rilancia da capo.

### Task 9: review avversariale e agent

- [ ] **Step 1: la workflow.** Le voci `<…>` di `accepted` si scrivono prima di lanciarla, con le risposte del Task 0 e l'esito misurato del Task 6, mai col testo di questo piano: un `accepted` che dice più di quanto misurato nasconderebbe un finding.
```js
Workflow({ name: 'adversarial-review', args: {
  range: 'master..feat/step6-directional-shadows',
  spec: 'docs/plans/2026-09-27-open-items-round-plan.md (§2 "Passo 6 — deciso (2026-09-30)", §3 row 6)',
  plan: 'docs/plans/2026-09-30-step6-directional-shadows-plan.md',
  context: 'Round 2026-09-27, step 6 (L-c): directional-light shadows in light-accum.wgsl, the TS shadow gate in light-groups.ts in the same commit, a dev warning for shadowed global lights, three probe checks in the Lighting tab, a committed ?bench scene and statistics. Headless tests and naga pass; GPU checks ran on an Apple M2 Pro in Chrome (Modes B and C with the probe).',
  accepted: [
    'A directional light shines toward its local +x (lightFacing, shared with the spot); scale enters only by its sign; a zero x-scale falls back to world +x.',
    '<angle, from Task 6: "The sun uses the fixed angle u.sourceFraction (0.02 rad: the penumbra\'s width per unit of distance, about the source\'s angular diameter), shared with the point/spot source fraction; no uniform or API change (confirmed by the step-6 GPU A/B, penumbra-ab-m2.json)." — or, if the rule did not confirm 0.02, the fallback chosen for sub-decision 1 and its numbers>',
    'A sun shadow is range world units long (slot 3, default 100), each caster fading over the last quarter (smoothstep, SUN_FADE_START 0.75, a plan default recorded in the round plan §2); the march ends at min(range, SDF exit) and everything beyond the SDF counts as lit, so an off-screen caster casts nothing: the upwind edge pop is known, measured, and decided in round step 8c (sdfOversize stays unsupported).',
    '<sub-decision 3: (a) "Point/spot marches are unchanged: a light whose centre is off screen still marches the clamped edge row toward it (owner, sub-decision 3 (a): moved to round step 8c)." | (b) "Point/spot marches stop at the SDF exit too (owner, sub-decision 3 (b)): bit-identical for lights centred in view; a light centred off screen only gets lighter (regress, offscreen comparison)." >',
    'Global lights never cast shadows in the lit backend; slot 7 is still sent; the warning is dev-only, once per renderer, raised from deriveLightGroups (not per handle); the multiBitReceiver warning stays always-on.',
    'Rule 3 extrapolates a sun ray only to min(range, SDF exit), never to infinity (binding shadow-march rule).',
    '<sub-decision 2, with the GPU grid of Task 6: (a) "An axis-aligned sun over casters about 2+ world units along its rays exhausts the 48-step budget along the faces parallel to its rays (at rotation(-PI/2): X % of the light buffer off by > 0.1 sun, max M): a documented limit in LightType and shadowSteps, remedy shadowSteps 96 (owner, sub-decision 2 (a))." | (b) "The sun marches with twice the budget (2u * u.shadowSteps; owner, sub-decision 2 (b)); casters longer than about 4 units along an axis-aligned sun\'s rays can still exhaust it (at rotation(0): Y %)." >',
    'The Lighting tab\'s sub-scene spawns 5 entities, so every tab after Lighting has ids 5 higher, by design (plan, Task 5): the M4 pixel gate\'s base is re-captured at the step-6 HEAD (Task 10, docs/plans/assets/2026-09-30-step6/baseline/), where it must differ from run1 only in those ids.',
    'Mode A has no probe: its check is a screenshot of the committed bench scene against Mode B.',
    'The §13.2 M2 row is a frame-span A/B with 1 light group, not comparable to the AMD per-pass rows; the pointspot and uber pairs are outside the step-6 criterion.',
  ],
  lenses: [
    'webgpu', 'docs',
    { key: 'march', prompt: 'LENS: the shadow march and its sign conventions. Read light-accum.wgsl (lightFacing, directionalRay, sunFade, shadow, pointShadow, exitDistance, sunShadow, shadowedLightType, vs_main, fs_main) against git diff master..feat/step6-directional-shadows. (1) Point and spot lights must compute exactly the pre-step-6 values (with sub-decision 3 (b): those centred in view; one centred off screen may only get lighter): verbatim prologue in pointShadow, every new term behind select(<old value>, …, fading) with fadeReach 0.0, no reordered expression. (2) The sun ray: -facing projected with w = 0 through u.viewProjection, y flipped like toScreenUV, normalised; rotation(-PI/2) must throw shadows DOWN the screen (the world is y-up). (3) travel = min(range in texels, slab exit): no sample outside [0, size); no infinity or NaN for range <= 0, a huge finite range or zoom (range * texels must be bounded without computing the product first), a degenerate camera, the 1x1 no-occluder SDF of a group without a set. (4) The three shadow-march rules of CLAUDE.md hold for every light type; the fade is monotone and smoothstep never gets equal edges. (5) Any path where an unreached SDF texel (valid = 0 -> 1e6) changes a sun pixel. (6) LightAccumStage binding 5 visibility against what vs_main reaches; the flat varying at location 3.' },
    { key: 'harness', prompt: 'LENS: the new GPU checks and the benchmark. ts/src/demo/lighting-directional.ts, lighting.ts, probe-checks.ts, docs/plans/assets/2026-09-30-step6-directional-bench.js, docs/plans/assets/2026-09-30-step6/step6-stats.mjs and march-model.mjs (the CPU model behind every threshold; its node:test pins the numbers the plan quotes). Each check must FAIL on the defect it claims to catch (a reversed march, a flipped x or y in the texel ray, a TS gate that does not count directional lights, a march reading past the SDF, a range in the wrong units) and PASS on correct code; skip in Mode A without side effects; destroy its entities; restore the camera; leave the step-3 checks and the Lighting tab steady state unchanged; keep every probe point inside the view at any canvas aspect. Bench: its guards (?bench, Mode B, unquantized timestamps, 1920x1080 via a scene-hdr probe, live condition), the ABBA effect and t bound, the regress comparison tolerance.' },
  ],
} })
```
Annota l'id (`wf_…`) e i finding confermati con la severità.

- [ ] **Step 2: gli agent** (in parallelo):
- `webgpu-pass-reviewer`: "Review ts/src/render/passes/light-accum-stage.ts and ts/src/shaders/light-accum.wgsl as changed in master..feat/step6-directional-shadows: binding 5 now VERTEX|FRAGMENT (vs_main calls textureDimensions(sdf)); LightUniform unchanged (80 B, minBindingSize 80, one 256-byte slice per group written once in prepare()); the new flat varying at location 3. Items of your checklist."
- `wgsl-validator`: "Validate ts/src/shaders/light-accum.wgsl after round step 6 (new fns lightFacing, directionalRay, sunFade, pointShadow, exitDistance, sunShadow, shadowedLightType): bindings vs LightAccumStage's layout and stage visibility, textureLoad only, uniform layout, and naga (scripts/validate-wgsl-naga.mjs on a directory holding only this file)."

- [ ] **Step 3: correzioni.** Ogni finding Critical o Important, e ogni Minor che non sia accettato nella nota del Task 12, segue lo schema: test che fallisce (vitest, `node:test` o un passo GPU con il criterio esatto), RED, correzione minima, GREEN, `npm --prefix ts test`, commit `fix(6): review <wf-id> — <titolo in italiano>`. Un finding che contraddice una decisione del §2 non si corregge: si riporta al proprietario. Se le correzioni toccano `light-accum.wgsl`, `light-accum-stage.ts` o `ts/src/demo/`, si rifà una review mirata sul solo range delle correzioni prima del Task 10.

### Task 10: verifica GPU sul Mac (Chrome B e C col probe, Mode A da screenshot)

Per ciascun modo: dev server **riavviato**, chrome-devtools-gpu, `navigate_page` con `ignoreCache: true` e l'`initScript` anti-reload, la riga dell'adapter, `resize_page` a 1200×689 CSS a dpr 2. È la finestra di M4 e di M9, e la chiedono il confronto numerico dei dettagli del passo 3 e il cancello M4 (`framingDiff` rifiuta un'altra finestra). Dopo ogni navigazione un `evaluate_script` imposta `window.__harnessMeta = { head: '<git rev-parse --short HEAD>', adapterLine: '<la riga dell'adapter, da list_console_messages>' }`.

**Metadati delle evidenze.** Ogni file `harness-m2-*.json` è un oggetto `{ format: 'hyperion-step6-harness/1', head, adapterLine, date, mode, search, adapter, chrome, canvas, css, dpr, tabs, lighting }`, come i JSON del banco: `tabs` è l'output del runner della §4, `lighting` quello dello script per-tab, e il resto lo legge lo script per-tab qui sotto.

- [ ] **Step 1: WGSL.** Nella pagina: `getCompilationInfo()` di `(await import('/src/shaders/light-accum.wgsl?raw')).default` senza messaggi; naga come al Task 2. Expected: puliti.

- [ ] **Step 2: point/spot invariati (B e C).** `regress` in `?mode=B&bench` e `?mode=C&bench` → `regress-m2-B.json`, `regress-m2-C.json`. Expected: `compareGrids` identico o entro 1 ULP fp16 su tutti i 2304 punti. Con la risposta (a) alla sotto-decisione 3 la scena include la point col centro fuori schermo. Con (b) quella point ha la cattura `offscreen`: ogni punto nuovo ≥ vecchio entro 1 ULP fp16, con il numero di punti cambiati nel JSON.

- [ ] **Step 3: harness in B e C.** Il runner della §4 di `/gpu-check` su tutti i tab, poi il tab Lighting con lo script per-tab:
```js
async () => {
  const KEY = 'lighting', LABEL = 'Lighting';
  const section = (await import(`/src/demo/${KEY}.ts`)).default;
  const setup = section.setup;
  let done;
  const finished = new Promise((r) => { done = r; });
  section.setup = async function (...a) { try { return await setup.apply(this, a); } finally { section.setup = setup; done(); } };
  [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes(LABEL)).click();
  await Promise.race([finished, new Promise((r) => setTimeout(r, 60000))]);
  await new Promise((r) => setTimeout(r, 600));
  const checks = [...document.querySelectorAll('.check-item')].map((item) => ({
    name: item.querySelector('.check-name')?.textContent,
    status: [...item.querySelector('.check-icon').classList].find((c) => c !== 'check-icon'),
    detail: item.nextElementSibling?.classList.contains('check-detail') ? item.nextElementSibling.textContent : '',
  }));
  // The evidence's metadata, read like the bench's.
  const meta = window.__harnessMeta ?? {};
  let adapter = null;
  try {
    const a = await navigator.gpu?.requestAdapter();
    adapter = a ? { vendor: a.info?.vendor ?? '', architecture: a.info?.architecture ?? '', description: a.info?.description ?? '' } : null;
  } catch { adapter = null; }
  const chrome = (await navigator.userAgentData?.getHighEntropyValues(['fullVersionList']))?.fullVersionList ?? null;
  const canvas = document.getElementById('canvas');
  return {
    format: 'hyperion-step6-harness/1', head: meta.head ?? null, adapterLine: meta.adapterLine ?? null,
    date: new Date().toISOString(), mode: window.__hyperion.mode, search: location.search, adapter, chrome,
    canvas: [canvas.width, canvas.height], css: [canvas.clientWidth, canvas.clientHeight], dpr: window.devicePixelRatio,
    lighting: checks,
  };
}
```
Salva gli esiti in `harness-m2-B.json` e `harness-m2-C.json` (metadati sopra).

Expected:
- Lighting **9/9** in B e in C;
- 'Lit vs unlit', 'Layer shadow on screen' e 'Light layers' uguali alla base M4 (`docs/plans/assets/2026-09-29-mac-m2/baseline/run1/statuses-{B,C}.json`), confrontati numericamente come al Task 5, Step 5: ogni numero stampato entro 0,002, i conteggi uguali. Il diff, numero per numero, va nel JSON dell'evidenza (`step3Diff`): `node docs/plans/assets/2026-09-30-step6/step6-stats.mjs details harness-m2-<modo>.json docs/plans/assets/2026-09-29-mac-m2/baseline/run1/statuses-<modo>.json`;
- gli altri tab come prima: Input 2/6 con 4 ⏳, e gli skip noti di Primitives (MSDF), Rendering FX (Tonemap) e Debug Tools (hash);
- 2D Twins 5/6 con uno skip in B e 6/6 in C;
- `list_console_messages` (`error`, `warn`) con solo il 404 di `favicon.ico`.

- [ ] **Step 4: Mode A.**
1. Il runner della §4 in `?mode=A` → `harness-m2-A.json`, con i metadati dello Step 3 (lo script per-tab li legge anche in Mode A). Expected: nessun `fail`, Lighting **4/9 · 5 skipped** (prima 4/6 · 2), gli altri tab come nella riga datata della skill §7; in tutto 17 pass, 39 skip e 4 in attesa sui 60 check.
2. `?mode=A&bench`, task `scene` con `resize: false`, poi `take_screenshot` → `modeA-vs-B/A.png`, e la mappa con il `vp` del render worker (skill §7) → `modeA-vs-B/map-A.json`.
3. Lo stesso in `?mode=B&bench` → `B.png` e `map-B.json`.
4. `python3 .claude/skills/gpu-check/scripts/pixels.py` sui `probePoints` restituiti da `scene`, su entrambe le coppie.

Expected:
- in A e in B ogni punto sottovento più scuro del suo sopravento;
- A e B uguali entro 2/255 punto per punto (M6c: a parità di inquadratura, 0/255);
- console di A (worker compresi) con solo la riga dell'adapter, quella del modo e il 404.

- [ ] **Step 5: comparsa al bordo, per il passo 8c.** `edgepop` in B e in C → `edge-pop-m2-B.json`, `edge-pop-m2-C.json`; `node … step6-stats.mjs edgepop <file>`. Expected: a range 100 pop ≈ 1 su tutta la larghezza; a 30 e a 10 la banda è lunga circa quanto il range. Nel modello, a 10: pop 1 fino a d ≈ 8 e 0 da d ≈ 10,5, perché la faccia di W_in sta a 0,5 dal bordo e la sfumatura va da 7,5 a 10 unità dal caster.

- [ ] **Step 6: l'avviso delle luci global, dal vivo (B e A).** Il test di testo del Task 3 fissa il cablaggio, ma nessun check lo fa scattare: la luce global del tab Lighting ha `shadowIntensity` 0 (`demo/lighting.ts:105-106`). In `?mode=B&bench` e poi in `?mode=A&bench`, con una console appena aperta:
```js
async () => {
  const engine = window.__hyperion;
  const frames = (n) => new Promise((r) => { const s = (k) => (k <= 0 ? r() : requestAnimationFrame(() => s(k - 1))); s(n); });
  const hs = [];
  engine.batch(() => {
    hs.push(engine.spawn().position(0, 0, -0.5).scale(40, 24, 1).receivesLight(true));
    hs.push(engine.spawn().light({ type: 'global', color: [0.3, 0.3, 0.3], energy: 1, shadowIntensity: 1 }));
  });
  engine.lighting.setBackend('lit');
  await frames(10);
  window.__globalWarnHandles = hs;
  return 'spawned';
}
```
Poi `list_console_messages` (`warn`); poi altri 60 frame (`frames(60)` in un secondo `evaluate_script`, che alla fine distrugge le handle e rimette il backend `off`), e di nuovo `list_console_messages`.
Expected: dopo i primi 10 frame **esattamente un** `[Hyperion] A global light has shadowIntensity > 0…` (in Mode A lo emette il render worker, e chrome-devtools mostra i messaggi dei worker); dopo altri 60 frame ancora uno solo. I messaggi, con il modo, vanno in `global-warning-m2.json`.

- [ ] **Step 7: cancello M4 e base nuova (B e C).** La sotto-scena alza di 5 gli id dei tab dopo Lighting (Task 5, "Id delle entità").
1. In `?mode=B&bench`, finestra dello Step 3, dev server appena riavviato: `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js` sui 10 tab nell'ordine fisso, poi `statuses`, esattamente come in M4 (README del Mac, §M4, "Procedura": un caricamento per modo, `timeOrigin` invariato). Le catture vanno in `docs/plans/assets/2026-09-30-step6/baseline/`.
2. Lo stesso in `?mode=C&bench`.
3. `node docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs --base docs/plans/assets/2026-09-29-mac-m2/baseline/run1 --run docs/plans/assets/2026-09-30-step6/baseline --mode B --step 0`, poi `--mode C`; gli output in `baseline/compare-B.txt` e `compare-C.txt`.

Expected: `FAIL`, e gli unici problemi sono "mover ids differ" nei tab dopo Lighting, con ogni id della corsa uguale all'id della base + 5; nessun punto di C diverso, nessun punto instabile nuovo, stati `OK` (i tre check nuovi passano). Qualunque altra differenza si indaga prima di andare avanti. Poi la base nuova diventa quella del cancello: nel README del Mac, §M4, "Uso come cancello", una riga datata dice che dal passo 6 `--base` è `docs/plans/assets/2026-09-30-step6/baseline`, perché gli id dei tab dopo Lighting sono cresciuti di 5, e che `compare-{B,C}.txt` mostra che nient'altro è cambiato.

- [ ] **Step 8: A/B dell'angolo di nuovo, solo se** il Task 9 ha toccato la marcia (`shadow`, `sunShadow` o `sunFade`).

- [ ] **Step 9: commit.** `test(6): verifica GPU sul Mac (B, C col probe; A da screenshot), avviso delle global, cancello M4 ricatturato e misura della comparsa al bordo`, con `docs/plans/assets/2026-09-30-step6/` (JSON, PNG e `baseline/`) e `docs/plans/assets/2026-09-29-mac-m2/README.md`.

### Task 11: costo sul Mac all'alimentatore (le due coppie del criterio, più due misure fuori dal criterio)

- [ ] **Step 1: condizioni** (si registrano nel JSON, campo `environment`):
- `pmset -g batt | head -1` contiene `AC Power`; `pmset -g adapter`; batteria, Low Power Mode 0 (`pmset -g | grep -i lowpowermode`).
- `caffeinate -dimsu` con `run_in_background: true` e un `timeout` Bash ≥ 3 600 000 ms (memoria `mac-sleep-kills-agents`).
- Campionatore `while :; do date +%T; pmset -g batt | head -1; ps -Ao pcpu,comm -r | head -6; sleep 2; done > "$TMPDIR/step6-cost-sampler.log"`, in background con lo stesso timeout, fuori dal repo.
- Browser stock fermo: `list_pages` di **chrome-devtools** (il server stock) solo su `about:blank`, controllato **prima e dopo ogni coppia**; Safari chiuso (`pgrep -x Safari` vuoto); VS Code inattivo.
- Dev server riavviato; pagina `"http://localhost:5173/?mode=B&bench"` su **chrome-devtools-gpu** con `ignoreCache` e l'`initScript` anti-reload; riga dell'adapter `apple / metal-3 / 0x0000`.
- Finestra non coperta e non ridimensionata durante la corsa; nessun probe della swapchain nella sessione.

- [ ] **Step 2: la corsa del criterio.** `__benchOpts = { task: 'cost', pairs: ['march'], blocks: 8, label: '<sha>', environment: {…} }`, poi `pairs: ['set']`, ciascuno in una chiamata; `evaluate_script` con `filePath` → `docs/plans/assets/2026-09-30-step6/cost-m2.json` (le due coppie in `results`).

- [ ] **Step 3: fuori dal criterio, nella stessa sessione e alle stesse condizioni.** Nessuna delle due entra nel criterio del §3, e nessuna lo blocca.
1. **Point e spot senza sole:** `pairs: ['pointspot'], blocks: 4`, con lo shader vecchio impostato prima come per `regress`; il risultato si aggiunge a `cost-m2.json` come terza coppia, marcata `outsideCriterion: true`.
2. **A/B senza codice dell'uber, gamba Chrome** (design 5b §11, `:791`; lista D della memoria, "Next Mac GPU session"). Il proprietario l'ha messo in coda per la prossima sessione GPU sul Mac, che è questa: `pairs: ['uber'], blocks: 8, n: 10000, quadPx: 16`, poi `quadPx: 2`, in `docs/plans/assets/2026-09-30-step6/uber-ab-m2-chrome.json`. La gamba Safari passa al passo 9, che ha già la sessione Safari (Task 12, Step 5 e Step 9).

Alla fine `window.__viteWsCloses` vuoto, e il campionatore e `caffeinate` fermati.

- [ ] **Step 4: statistica.** `node docs/plans/assets/2026-09-30-step6/step6-stats.mjs cost docs/plans/assets/2026-09-30-step6/cost-m2.json`, e lo stesso su `uber-ab-m2-chrome.json`. Expected: per coppia del criterio n = 8, media ± SE, IC 95 % con t(0,975; 7) = 2,365 e il verdetto; come contesto, P2 − P1 (≈ un set). Per `pointspot` n = 4 e t(0,975; 3) = 3,182, con un verdetto "below resolution: < X ms" o un numero. Numero di blocchi, formula e soglia sono fissati **qui, prima** della corsa: niente finestre aggiunte dopo per arrivare alla significatività.

- [ ] **Step 5: commit.** `perf(6): costo delle ombre directional sull'M2 (A/B dello span, due coppie), point/spot senza sole e gamba Chrome dell'A/B dell'uber`.

### Task 12: numeri nei documenti, auditor, preflight completo, merge, memoria, rapporto

- [ ] **Step 1: design 17, §13.2.** Dopo `:1009`, prima del `---` di `:1011`, aggiungi:
```markdown
#### 🆕 Ombre directional (passo 6 del giro) — Apple M2 Pro / Metal, Chrome <versione> — misurato <data>

Stesse condizioni della riga M9 (alimentatore, `chrome-devtools-gpu` con timestamp non quantizzati, altro browser fermo, controllato prima e dopo ogni coppia), ma **scena statica committata** (`assets/2026-09-30-step6-directional-bench.js`, task `scene`: pavimento, tre muri, due piattaforme parallele ai raggi, due scatole, una point di range 5; il sole a `rotation(0)`, range 100, cioè raggi fino all'uscita dall'SDF, i più lunghi della marcia), 1920×1080, `shadowSteps` 48 <con il ramo (b) della sotto-decisione 2: "(96 per il sole)">, **1 gruppo di luci**. Metodo: 8 blocchi ABBA `[ON, OFF, OFF, ON]` di finestre da 120 frame per coppia; effetto per blocco `(ON1 + ON2 − OFF1 − OFF2) / 2`; media ± SE, IC 95 % con t a 7 gradi di libertà. Non si confronta con le righe AMD (marker per pass) né con M9 (tab animato). Un sole ombreggiato marcia ogni texel del light buffer una volta per gruppo di luci che la sua maschera raggiunge, e ogni set di caster distinto fra quei gruppi aggiunge un flood: con più gruppi il costo si moltiplica.

| Coppia | Cosa isola | Span ON | Span OFF | Costo ± SE (n) | IC 95 % (t, n−1 gdl) |
|---|---|---|---|---|---|
| marcia | ombra del sole on/off, con una point ombreggiata che tiene vivo l'SDF set | <ms> | <ms> | <verdetto> | [<lo>, <hi>] |
| set | il sole unica luce ombreggiata: seed + flood + marcia | <ms> | <ms> | <verdetto> | [<lo>, <hi>] |

<Una o due righe di lettura: P2 − P1 come costo di un set; il confronto con l'A/B dell'angolo, che non cambia il numero di passi.> Fuori dal criterio, point e spot senza sole, `light-accum.wgsl` nuovo contro quello di `2f43e42` (coppia `pointspot`, n = 4): <verdetto>. Dati in `assets/2026-09-30-step6/cost-m2.json`.
```
I verdetti di `step6-stats.mjs` sono in inglese: qui si traducono ("below resolution: < X ms" diventa "sotto la risoluzione, < X ms").
- [ ] **Step 2: design 17, §17 punto 1 (`:1084`).** In fondo al punto: "🆕 **Misurato al passo 6 del giro (<data>):** con un sole a range 100 un caster che entra dal bordo dal lato del sole porta in un frame tutta la sua ombra: pop <max> su <P> % della larghezza della vista (<W> unità; `assets/2026-09-30-step6/edge-pop-m2-*.json`); a range 30 e 10 la banda è lunga circa quanto il range. Un rettangolo dell'SDF guidato dalla luce, per toglierla, dovrebbe allargarsi controvento di almeno il range e di traverso di circa range·`u.sourceFraction`, per la penombra laterale; la scelta fra padding simmetrico e rettangolo guidato dalle luci resta al passo 8c."
- [ ] **Step 3: CLAUDE.md.**
  - Conteggi vitest (`:66`, `:73`, `:76`, `:79`), dalle righe `Test Files`/`Tests` di `npm --prefix ts test` e dei file citati (`npx --prefix ts vitest run --root ts src/<file>.test.ts`).
  - Nella tabella delle fasi, dopo la riga 5b, la riga (i campi tra `< >` dai Task 6, 10 e 11):
```text
| 6 (round 2026-09-27) | Directional shadows | `lightFacing` (+x, shared with the spot); `directionalRay` in `vs_main` (binding 5 VERTEX\|FRAGMENT); `shadow()` generalised + `pointShadow`/`sunShadow`; the sun marches min(range, SDF exit), beyond = lit, fading over the last quarter, at `u.sourceFraction` (A/B: <esito>); `shadowedLightType` ↔ `SHADOWED_LIGHT_TYPES`; `shadowedGlobalLight` + dev warning; Lighting tab +3 checks (upwind pop at range 100: <pop>). Cost on the Apple M2 Pro (span A/B, n = 8, 1 light group; a shadowed sun marches the whole light buffer once per light group it reaches): march <X ± SE> ms, sun as the only shadowed light <Y ± SE> ms (design 17 §13.2) |
```
  - Nel gotcha di Mode A (`:494`), la frase "(at `08e2a5d`, 2026-09-30: 17 pass, 36 skips, 4 pending over the 57 checks, the 36 being the 33 of M6 plus the 3 bezier checks added since)" prende i conteggi misurati al Task 10, Step 4, con HEAD e data (attesi: 17 pass, 39 skips, 4 pending over the 60 checks, Lighting 4/9, i 3 skip nuovi essendo i check del sole).
  - Nella riga di `demo/lighting-directional.ts` aggiunta al Task 7, in fondo: "; the Mac pixel gate's base is therefore `docs/plans/assets/2026-09-30-step6/baseline/` (re-captured at the step-6 HEAD; against M4's `run1` it differs only in those ids)".
  - Nella riga "Current:" (`:751`), "Round 2026-09-27 step 5b (GPU transparent sort + uber pipeline) is done: see the 5b row." diventa "Round 2026-09-27 steps 5b (GPU transparent sort + uber pipeline) and 6 (directional shadows) are done: see their rows."
- [ ] **Step 4: skill gpu-check.** §7, la riga datata di Mode A: sostituiscila con la misura dello Step 4 del Task 10, con data e HEAD; se il tab Lighting ha chiesto più di ~7 s, aggiorna l'attesa della §4.
- [ ] **Step 5: piano del giro, design 5b.** Nel piano del giro, in §4, dopo il bullet del passo 5b:
```markdown
- **Passo 6 (ombre directional) — fatto** (piano `2026-09-30-step6-directional-shadows-plan.md`; review `<wf-id>`: <n> finding confermati, <esito>). La directional splende verso il suo +x locale (helper condiviso con lo spot), marcia l'SDF per min(range, uscita dall'SDF) con la penombra fissa `u.sourceFraction` e sfuma nell'ultimo quarto del range; `light-groups.ts` conta le directional ombreggiate nello stesso commit dello shader, e un test di testo lega i due gate; le `global` non proiettano ombre nel backend `lit` (JSDoc + avviso dev dal renderer, visto dal vivo in B e in A). Sotto-decisioni (§2): <le tre risposte, e l'esito di ciascuna>. A/B dell'angolo: <esito della regola>, con i numeri (pendenze, errori a 48 passi) e gli screenshot `assets/2026-09-30-step6/penumbra-{0.01,0.02,0.04}-B.png`; sfumatura `SUN_FADE_START` <0,75, o il valore scelto>, screenshot `fade-{0.75,0}-B.png`. Griglia di tutto il light buffer a 48 passi: <frazione e massimo a `rotation(0)`, `rotation(-Math.PI/2)` e `rotation(-Math.PI/6)`> (modello: 1,03 %, 0,84 %, 0), <il ramo della sotto-decisione 2 e il suo esito>. Verificato sul Mac (M2 Pro, Chrome <versione>) in Mode B e C col probe (Lighting 9/9; dettagli del passo 3 uguali alla base M4 entro 0,002; point/spot invariati su 2304 punti) e in Mode A da screenshot. Il cancello M4 è ricatturato: la sotto-scena alza di 5 gli id dei tab dopo Lighting, e nient'altro cambia (`assets/2026-09-30-step6/baseline/`). Comparsa al bordo dal lato del sole a range 100: <pop> (design 17 §17, punto 1). Costo (A/B dello span, n = 8, 1 gruppo di luci): marcia <X ± SE> ms, sole unica luce ombreggiata <Y ± SE> ms (§13.2); fuori dal criterio, point e spot senza sole <verdetto>. Cambia l'aspetto (e il costo) delle scene, dei tape e degli snapshot esistenti con `type: 'directional'` e `shadowIntensity > 0`, che prima non facevano ombra.
```
Nella riga 8c della §3, dopo "fatta nel passo 6": "(misura: design 17 §17, punto 1; `assets/2026-09-30-step6/edge-pop-m2-*.json`)". Con la risposta (a) alla sotto-decisione 3, alla fine della colonna "Passo" della stessa riga: "Nello stesso passo: la marcia di point e spot col centro fuori schermo si ferma all'uscita dall'SDF (oggi marcia nella riga di bordo clampata, e un caster che tocca il bordo diventa un'estrusione infinita verso la luce; deciso al passo 6, sotto-decisione 3 (a))."

Nel bullet del passo 5b della §4, "per il 4−3 dell'M2 c'è un A/B senza codice in coda per la prossima sessione GPU sul Mac (design 5b §11)" prende "(gamba Chrome fatta al passo 6: <esito>, `assets/2026-09-30-step6/uber-ab-m2-chrome.json`; gamba Safari al passo 9)". Nel design 5b, §11, dopo il bullet di `:791`, un sotto-bullet "**Gamba Chrome, misurata <data>** (passo 6 del giro, sessione del Task 11): <esito a 16 px e a 2 px, in ms ± SE>. La gamba Safari passa al passo 9, e il punto si chiude su entrambe."
- [ ] **Step 6: `claude-md-auditor` sui documenti.** Gli Step 1-5 scrivono CLAUDE.md, il design 17, la skill e il piano del giro dopo la review del Task 9. Prima del merge si lancia l'agent `claude-md-auditor` con la merge-base (`2f43e42`, o la base annotata al Task 0): costruisce un worktree lì e separa la deriva causata dal branch da quella preesistente. Quella del passo si corregge, test prima dove c'è codice, con commit `docs(6): claude-md-auditor — <titolo>`; quella preesistente va nella lista del passo 9.
- [ ] **Step 7: preflight completo.**
```bash
scripts/preflight.sh --full
node --test docs/plans/assets/2026-09-30-step6/step6-stats.test.mjs docs/plans/assets/2026-09-30-step6/march-model.test.mjs
```
Expected: tutto `OK`, e i due `node:test` verdi.
- [ ] **Step 8: merge e push** (autonomia del giro: senza chiedere):
```bash
git status --short
git checkout master && git pull --ff-only origin master
git merge --no-ff feat/step6-directional-shadows -m "Merge branch 'feat/step6-directional-shadows'" \
  -m "Passo 6 del giro: ombre delle luci directional (asse +x condiviso con lo spot, lunghezza = range con sfumatura, marcia fino all'uscita dall'SDF, penombra u.sourceFraction); gate WGSL e TS legati; luci global senza ombre nel backend lit, con avviso dev; tre check col probe; banco committato e costo sull'M2." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
git branch -d feat/step6-directional-shadows
git rev-parse --short HEAD
```
Il checkout ha riscritto gli shader su disco: prima di ogni controllo GPU successivo si riavvia il dev server.
- [ ] **Step 9: memoria** (fuori dal repo, in `~/.claude/projects/-Users-edoardocicognani-Code-HyperionEngine/memory/`).
  - `open-items-round-2026-09-27.md`: "**Step 6 DONE** (merged `<sha>`, pushed)" con review, esito dell'A/B e della griglia, pop e costo; "NEXT: step 7".
  - `MEMORY.md`: la riga del giro, "steps 1-5, 5b and 6 merged (<sha>); next = step 7".
  - `round-pending-decisions.md`, lista D:
    - "Next Fedora session": aggiunge "the step-6 AMD row (same bench, task `cost`)" e "re-capture the AMD pixel baseline of 5b (`docs/plans/assets/2026-09-27-transparent-sort-baseline/`): since step 6 the Lighting tab spawns 5 entities, so every later tab's ids are 5 higher";
    - "Next Mac GPU session: the uber A/B …" diventa "The uber A/B: Chrome leg done in step 6 (<result>); the Safari leg goes to step 9's Mac/Safari session; close A.2 on both";
    - con la risposta (a) alla sotto-decisione 3, la voce dell'8c prende "+ stop point/spot marches at the SDF exit for a light centred off screen (step 6, sub-decision 3 (a))";
  - in E, le risposte alle sotto-decisioni del passo 6 e il default `SUN_FADE_START`.
- [ ] **Step 10: rapporto finale al proprietario** (in italiano). Le tre sotto-decisioni e l'esito di ciascuna; i tre screenshot dell'angolo e i due della sfumatura (percorsi assoluti), con i numeri dell'A/B e della griglia; il cancello M4 ricatturato e il perché; l'avviso delle global visto in B e in A; pop al bordo; costo, con la coppia `pointspot`; la gamba Chrome dell'A/B dell'uber. Il default `SUN_FADE_START` si ricorda come veto ancora possibile.

## Rischi e punti aperti

1. **Striature false lungo le facce parallele ai raggi di un sole allineato agli assi (budget di passi).** Riguarda un sole a `rotation(0)`, `rotation(±Math.PI/2)` o `rotation(Math.PI)`, cioè anche l'esempio del JSDoc, sopra **qualunque** caster lungo circa 2 unità mondo o più nella direzione dei raggi: ogni sprite non ruotato alto o largo così, non solo le piattaforme lunghe. I raggi del sole sono paralleli, quindi ogni faccia parallela a loro viene rasa per tutta la lunghezza. Un raggio che la rade a δ texel avanza di δ a passo, e finisce i 48 passi su un caster più lungo di circa 48·δ texel (con δ ≈ 1 e 27 texel per unità, ~2 unità). Poi la regola 3 estrapola l'ultima distanza libera fino alla fine del raggio, che per un sole arriva a ~960-1100 texel invece di restare nel range di una torcia. Il risultato: striature scure larghe 1-3 texel lungo ogni bordo d'ombra parallelo al sole, e luce che passa oltre il caster successivo. Il modello CPU dice:
   - piattaforma di 24 unità a 0° (la scena `penumbra`), campionata fitta: errore massimo 0,60 / 0,69 / 0,34 per angoli 0,01 / 0,02 / 0,04 e 241 / 368 / 180 punti su 2205 sopra 0,1, fino a ~0,5 unità sopra la faccia; a 96 passi, a 0,02, 0,27 e 80 punti; con il sole a −20°, 0;
   - tutto il light buffer della scena `scene` (griglia 128×72, 0,02): a 48 passi, `rotation(0)` 1,03 % dei punti oltre 0,1·sole (massimo 1,00), `rotation(-Math.PI/2)` 0,84 % (massimo 1,00, con 30 dei 75 punti liberi più chiari del riferimento), `rotation(-Math.PI/6)` 0; a 96 passi 0,58 % (0,58) e 0,11 % (0,22).

   Il Task 6 lo misura sulla GPU, sulla stessa griglia. È la sotto-decisione 2, chiesta al Task 0 con questi numeri. La regola 3 non si tocca: è un gotcha vincolante.
2. **Comparsa al bordo dal lato del sole, voluta.** Il seed rasterizza solo la parte a schermo di un caster. Quando il primo texel di un caster entra, tutta la sua ombra attraversa la vista in un frame: a range 100, tutta la larghezza. Il check la misura e la fissa: il check fallisce quando l'8c introdurrà il padding, e l'8c lo aggiornerà (il suo criterio lo prevede già). Il JSDoc di `LightType` la documenta come limite noto.
3. **Point/spot col centro fuori schermo.** È la sotto-decisione 3. Con (a) continuano a marciare nella riga di bordo clampata, e un caster che tocca il bordo resta un'estrusione infinita verso la luce: un artefatto che esiste già oggi, e che passa all'8c insieme al padding, scritto nella sua riga. Con (b) si fermano all'uscita, e cambiano i pixel delle scene con luci che entrano dal bordo.
4. **Precisione dell'SDF.** Le UV del seme più vicino in `rgba16float` sono quantizzate a ~2^-11: fino a ~0,47 texel a destra e in basso di un SDF largo 960. Penombre sotto ~2 texel (caster entro ~100 texel a 0,02 rad) sono di fatto dure e possono fare bande. Lo stesso vale oggi per le point al bordo del range; per il sole a ogni distanza.
5. **Costo e cambi di comportamento.** Un sole ombreggiato marcia ogni texel del light buffer (960×540 a 1080p) in ogni gruppo che la sua maschera raggiunge, e può creare SDF set dove non c'erano (+1,84 ms per set sull'iGPU AMD; sull'M2 circa 1,37 ms per una catena a 980×624, dalla timeline di M7). Scene, tape e snapshot esistenti con `type: 'directional'` e `shadowIntensity > 0` prima non facevano ombra: ora sì, con ombre lunghe 100 unità di default. È detto nella nota del piano del giro.
6. **Point/spot al bit.** Il codice spostato può essere schedulato diversamente dal compilatore di Metal (contrazioni FMA). Il `select` garantisce la stessa aritmetica nel sorgente, non nel binario. La cattura `regress` confronta 2304 punti con tolleranza di 1 ULP fp16; un solo punto fuori si indaga.
7. **Binding 5 al vertex stage.** Chrome/Tint lo deve accettare, e lo verifica il cancello del Task 2; WebKit si verifica nella gamba Safari del passo 9. In compatibility mode lo stage di luce usava già storage buffer nel vertex: nessuna esposizione nuova.
8. **Sfumatura.** `SUN_FADE_START` = 0,75 (smoothstep) è un default del piano, che legge "sfuma a 0 verso la fine" (§2). Si presenta al Task 0 come default che il proprietario può rifiutare, e si registra così nel §2; gli screenshot 0,75 contro 0 del Task 6 vanno nel rapporto finale e nella voce del §4. È una costante sola, e si cambia senza toccare altro.
9. **Risoluzione del costo.** Deviazione standard fra finestre ~0,19 ms (M9) → SE ≈ 0,07 ms e mezza ampiezza dell'IC ≈ 0,16 ms con n = 8. La marcia da sola può risultare "sotto la risoluzione, < X ms": è un esito valido. Dentro una finestra lit lo span oscilla (3-6,5 ms in M9, causa non misurata); lo assorbono i blocchi ABBA.
10. **Tab Lighting più lento** di ~0,5 s (tre fasi con `frames(4)` e tre letture). Il runner della §4 aspetta 3,5 s: per quel tab conta lo script per-tab.
11. **Avviso solo dev per le global, sempre attivo per `multiBitReceiver`.** È un'incoerenza accettata, come da decisione.
12. **L'A/B senza codice dell'uber del 5b** (design 5b §11, `:791`; piano del giro `:123`; lista D della memoria). Il proprietario l'ha messo in coda per "la prossima sessione GPU sul Mac", che è quella del passo 6. Deciso nel piano: la gamba Chrome gira al Task 11, alle stesse condizioni e con un JSON suo, fuori dal criterio del passo; la gamba Safari passa al passo 9, che ha la sessione Safari. Lo registrano il piano del giro e la memoria (Task 12).
13. **Id dei tab dopo Lighting.** La sotto-scena crea 5 entità e alza di 5 gli id di Debug Tools, Lifecycle e 2D Twins. Il cancello M4 si ricattura (Task 10, Step 7; la scelta è motivata al Task 5); la base AMD del 5b si ricattura alla prossima sessione Fedora.

## Sotto-decisioni per il proprietario

Si chiedono tutte e tre allo Step 0 del Task 0, prima del Task 1, e le risposte si registrano nel §2 del piano del giro. Ogni risposta sceglie un ramo per ogni esito. Il Task 6 esegue il ramo scelto e richiede solo se la GPU smentisce il modello su cui il proprietario ha risposto. Insieme si presenta il default `SUN_FADE_START = 0,75` (rischio 8), che il proprietario può rifiutare.

1. **Se l'A/B non conferma 0,02 rad** (regola del Task 6), quale ripiego?
   - (a) tenere comunque `u.sourceFraction` e documentarlo;
   - (b) una costante WGSL `SUN_ANGLE` col valore vincente, senza toccare uniform, API né point/spot;
   - (c) cambiare `LIGHT_SOURCE_FRACTION`: sposta la penombra di ogni point e spot e rompe "passo 3 invariato".

   Raccomandazione: (b). Il modello CPU prevede la conferma: errore 0,000 su muro e diagonale, pendenze fra 0,98 e 1,03 volte l'attesa. Il ripiego scelto si applica senza fermarsi; ci si ferma solo se nessun angolo passa, perché allora è un difetto.

2. **Striature a 48 passi con un sole allineato agli assi** (rischio 1): `rotation(0)`, `rotation(±Math.PI/2)` o `rotation(Math.PI)`, sopra qualunque caster lungo circa 2 unità mondo o più nella direzione dei raggi. Cioè ogni sprite dritto abbastanza alto o largo, non solo le piattaforme lunghe. Si decide sui numeri di `rotation(-Math.PI/2)`, l'esempio del JSDoc. Il modello, su tutto il light buffer della scena committata (griglia 128×72, 0,02 rad), conta i punti fuori di più di 0,1·sole:
   - −π/2: 0,84 % a 48 passi, massimo 1,00; dei 75 punti liberi, 45 più scuri e 30 più chiari del riferimento, cioè striature e luce che passa. A 96 passi 0,11 % (massimo 0,22);
   - 0: 1,03 % (1,00); a 96 passi 0,58 % (0,58), perché le piattaforme di 10-12 unità superano anche 96 passi;
   - −π/6: 0.

   Opzioni:
   - (a) limite documentato nel JSDoc di `LightType` (accanto all'esempio −π/2), in quello di `shadowSteps` e nel gotcha, con i numeri misurati e il rimedio `shadowSteps: 96`, che costa anche a point e spot;
   - (b) budget doppio solo per il sole: `shadow()` prende i passi come parametro, `pointShadow` passa `u.shadowSteps` (point e spot identici), `sunShadow` `2u * u.shadowSteps`. Niente uniform né API; il costo nella coppia "marcia", la griglia rimisurata, il residuo sopra caster di oltre ~4 unità documentato;
   - (c) cambiare la regola 3 per il sole: contraddice il gotcha vincolante.

   Raccomandazione: (b). Il caso difettoso è l'esempio che il JSDoc dà per primo, sopra ogni sprite dritto, e ci passa luce: con (a) quell'esempio chiederebbe un budget più alto per tutte le luci. Il budget in più di (b) lo pagano solo i raggi che esauriscono i 48 passi. Si richiede solo se la GPU smentisce il modello: a −π/2 e 48 passi, al più lo 0,1 % dei punti fuori di più di 0,1·sole.

3. **Uscita dall'SDF per point e spot.** La riga 6 del §3 dice "`shadow()` generalizzata a origine + direzione + uscita dall'SDF", ma il piano ferma all'uscita solo il sole. Una point o una spot col centro fuori schermo marcia nella riga di bordo clampata (`light-accum.wgsl:91`, `:96-98`): un caster che tocca il bordo diventa un'estrusione infinita verso la luce. Le luci col centro in vista non cambiano con nessuna opzione (convessità), quindi i check del passo 3 restano identici.
   - (a) point e spot identici al bit, come nel piano. Il Task 12 aggiunge "fermare all'uscita dall'SDF la marcia di point e spot col centro fuori schermo" alla riga 8c e alla lista D della memoria. L'artefatto, già presente oggi, resta fino all'8c; `regress` resta un confronto al bit di tutta la griglia.
   - (b) `pointShadow` passa `min(travel, exitDistance(origin, dir, fsize))`, con l'angolo dalla distanza vera. L'identità al bit vale solo per le luci col centro in vista; la point `(-21, 4)` di `regress` passa a un confronto a parte (ogni punto nuovo ≥ vecchio), più un test di testo. L'artefatto sparisce subito, ma cambiano pixel di scene esistenti in un passo il cui criterio dice "point/spot invariati", e l'8c potrebbe spostare di nuovo l'uscita.

   Raccomandazione: (a). L'uscita di point e spot dipende dal padding dell'8c, che con un SDF più grande dello schermo la sposta: deciderla lì evita di cambiare due volte gli stessi pixel. Al passo 8 la luce sprite marcerà dal centro e prenderà la stessa regola. L'artefatto non l'introduce il passo 6. Nessun ramo dipende dalla GPU: con (a) `regress` identico, con (b) solo schiarimenti nel confronto `offscreen`; un altro esito si indaga.
