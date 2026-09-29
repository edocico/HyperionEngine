# Test GPU sul MacBook M2 — prove ed esiti

Piano: `docs/handoff/2026-09-29-mac-m2-handoff.md`, sezione 4 (M0-M13). Regole: sezione 5. Qui ogni esito con le sue prove; i file stanno in questa cartella (`run2/` della baseline non si committa).

## Intestazione

| Voce | Valore |
|---|---|
| Branch / HEAD | `test/mac-m2-gpu` · base `f4a755d` (master), primo commit `22fd6b0` (solo `.node-version`, nessuna modifica al motore) |
| Macchina | MacBook Pro 14" (Mac14,9), Apple M2 Pro, GPU 16 core, Metal 4, 16 GB |
| `sw_vers` | macOS 27.0.1 (26A434) |
| Chrome | 154.0.8037.58 (stable, `/Applications`), avviato da chrome-devtools-mcp |
| Safari | 27.0.1 |
| Adapter | `[Hyperion] WebGPU adapter: apple / metal-3 / 0x0000, subgroups 32-32` — `description` "Apple M2 Pro", `isFallbackAdapter` false |
| Subgroup | 32-32: il cancello `subgroupCullSupported` si apre, il renderer vivo usa il percorso cull a subgroup |
| dpr / finestra CSS | dpr 2 · schermo 1512×982 · finestra CSS 1200×689 · canvas 1960×1248 (2026-09-29, 2.9) |
| WASM dell'harness | `npm --prefix ts run build:wasm` rifatta a `22fd6b0` (199970 B; `preflight --full` aveva lasciato in `ts/wasm` la build con il secondo `wasm-opt`) |
| Display | integrato Liquid Retina XDR, 1512×982 punti (3024×1964 px) a 120 Hz (ProMotion) |
| Alimentazione | 2026-09-29, inizio sessione: **batteria** (94 %, nessun alimentatore), Low Power Mode 0. I timing (M7-M9) solo con l'alimentatore collegato: annotarne i watt (il 2026-09-29 c'era un 35 W, specifica 67 W) |
| Etichetta dei timing | "Apple M2 Pro (16-core GPU) / Metal, Chrome 154.0.8037.58" |

Server MCP: "gpu" = `chrome-devtools-gpu` (`--enable-webgpu-developer-features`, profilo `~/.cache/chrome-devtools-mcp/chrome-profile-webgpu`), "stock" = `chrome-devtools` (nessun flag).

## Esiti

| ID | Esito | Prove |
|---|---|---|
| M0 | **passa** | `adapter-chrome.json` |
| M1 | **passa** | `wgsl-validation.json`, `wgsl-compile-all.json` |
| M2 | **passa** (verdetti = riferimento AMD) | `m2-tabs-B.json`, `m2-tabs-B-pass1.json`, `m2-primitives-B.png` |
| M3 | **passa** (2D Twins 6/6) | `m3-tabs-C.json` |
| M4 | **passa**: stabilità B e C `PASS`, verdetti = AMD | `baseline/run1/`, `baseline/stability-B.txt`, `baseline/stability-C.txt` |
| M6 | **passa**: Mode A parte, nessun `fail`, disegna | `m6-tabs-A.json`, `m6-primitives-A.png`, `m6-lighting-A.png` |
| M6b | **passa**: A = B al pixel; mondo vuoto come atteso | `m6b/` |
| M6c | **passa**: qualità e input del sort arrivano al render worker | `m6c-*.png`, `m6c-sort-map.json` |
| M7 | **fallisce**: zeri anche con il flag, perché i marker del profiler sono pass vuoti | `m7-timestamps-{gpu,stock}.json`, `m7-timestamp-probe-{gpu,stock}.json` |
| M8, M9 | **fermi**: dipendono da M7, aspettano la scelta sui timestamp | — |
| M10 | **bug confermato e corretto** (`f1b8ba9`): la crescita dei tier BC7/ASTC ora valida su Metal | `m10-tier-growth.json`, `m10-tier-growth-after-fix.json` |
| M5 | **passa**: il cull a subgroup a 32 lane archivia ogni indice nel bucket giusto; i controlli negativi hanno i denti | `cull-subgroup-check.js`, `cull-subgroup-check.json` |

### M0 — Adapter, feature, limiti

- Console dopo `?mode=B`: (a) la riga dell'adapter qui sopra; (b) nessun `lacks 'indirect-first-instance'`; (c) **nessun** `Cull: atomic path`: il percorso subgroup è attivo; (d) nessun `initial render graph raised GPU errors`. Unico errore: il 404 di `favicon.ico`.
- Feature dell'adapter: `bgra8unorm-storage`, `clip-distances`, `core-features-and-limits`, `depth-clip-control`, `depth32float-stencil8`, `dual-source-blending`, `float32-blendable`, `float32-filterable`, `indirect-first-instance`, `primitive-index`, `rg11b10ufloat-renderable`, `shader-f16`, `subgroup-size-control`, `subgroups`, `texture-component-swizzle`, `texture-compression-astc`, `texture-compression-astc-sliced-3d`, `texture-compression-bc`, `texture-compression-bc-sliced-3d`, `texture-compression-etc2`, `texture-formats-tier1`, `texture-formats-tier2`, `timestamp-query`.
- Il renderer vivo: `compressionFormat` = `bc7-rgba-unorm` (BC7 prima di ASTC), `gpuProfilingSupported` = true, `CullPass.SUBGROUP_CONFIG` = `{useSubgroups: true, subgroupSize: 32, useSubgroupId: true}`. Con `useSubgroupId` il sorgente del cull comincia con `enable subgroups;` + `requires subgroup_id;` (`wgslLanguageFeatures` ha `subgroup_id`); la costante `USE_SUBGROUP_ID` è dichiarata in `cull.wgsl:13` e non è letta da nessuna parte, quindi cambia il testo del modulo ma non il comportamento.
- Limiti del device di default = i default della specifica WebGPU, voce per voce (`maxStorageBuffersPerShaderStage` 8, `maxComputeWorkgroupStorageSize` 16384, `maxTextureArrayLayers` 256, …): i budget verificati dai test valgono. L'adapter offre di più (10 storage buffer, 32 KiB di workgroup memory, 2048 layer), ma il renderer non lo chiede.

### M1 — WGSL e pipeline su Metal

- Gli script `…-validate-wgsl.js` e `…-validate-sort-wgsl.js` del 2026-09-27, eseguiti invariati in una sola chiamata su un device fresco: `ok: true`. I 7 moduli composti compilano **senza nessun messaggio** (nemmeno warning); le 19 pipeline (opaque, transparent e occluder per ciascuno dei 6 tipi, più l'uber transparent) hanno tutti gli error scope vuoti; ogni modulo coincide con quello pubblicato dal renderer. Gather e sort compilano senza messaggi e `TransparentSortPass.setup()` costruisce le 4 pipeline compute senza errori. Il `diagnostic(off, derivative_uniformity);` dell'uber è accettato da Tint anche con l'uscita MSL.
- Estensione (non chiesta dall'handoff): **tutti** gli altri moduli WGSL dell'app compilati su Metal (`wgsl-compile-all.json`): il cull nelle tre varianti (senza subgroup, con subgroup, con subgroup + `subgroup_id` come nel renderer vivo), scatter, fxaa-tonemap, selection-seed, jfa, outline-composite, bloom, particle-simulate, particle-render, debug-line, sdf-jfa, light-accum, pixel-probe, transparent-gather, transparent-sort: 17 su 17 senza messaggi. Fuori conteggio: `prefix-sum` compila con `enable subgroups;`; `basic-binding-array` fallisce come previsto (`binding_array` richiede `sized_binding_array`, che il browser non ha: è l'artefatto di design che nessuno importa).
- Parte statica: agente `wgsl-validator` sull'albero di `772c791` (shader identici a `b2ccd0c`), senza browser. Gli 8 check passano. `scripts/validate-wgsl-naga.mjs` dà **9/9 valid** (i 6 moduli per tipo, l'uber, gather, sort). Con naga validano anche i 12 shader top-level e il cull senza subgroup; la variante con `enable subgroups;` naga 30.0.1 non la sa leggere (wgpu#5555), e l'agente l'ha verificata con un proxy. Ha poi compilato l'MSL prodotto da naga con il compilatore Metal di Apple su questa macchina (`MTLDevice.makeLibrary`): 23 librerie, 11 pipeline state compute e 25 render, 0 errori (è l'MSL di naga, non quello di Tint, che resta coperto dal risultato dal vivo qui sopra). Uniformità verificata a mano, perché naga non la controlla. Punti trovati, **nessuno blocca Metal**:
  - **F1 (basso, portabile, non di Metal)**: `shaders/primitives/bezier.wgsl:27` `let kk = 1.0 / dot(B, B);`. Con il punto di controllo esattamente a metà della corda (una bezier dritta) B = 0 e `kk` è infinito. Nella simulazione dell'agente, sull'M2 il campo collassa sulla distanza da p0 e la curva diventerebbe un disco attorno a p0; in f32 stretto tutto NaN. `EntityHandle.bezier()` non lo impedisce. Le curve della demo hanno |B| tra 1 e 2 e non lo toccano. Fix proposto: ripiegare sulla distanza dal segmento quando `dot(B, B) < eps`. Da verificare dal vivo e da decidere (vedi le domande).
  - **F2 (info)**: `outline-composite.wgsl:121` `smoothstep(outlineWidth + 1.0, outlineWidth - 1.0, dist)` ha i bordi invertiti, un caso non definito dalle specifiche MSL e GLSL. Sull'M2 dà il valore atteso: misurato, uguale a `1 - smoothstep(W-1, W+1, x)` entro 6e-8. La forma esplicita non dipenderebbe da un comportamento non specificato (utile per Safari).
  - **F3 (info)**: identificatori che in MSL sono nomi riservati o di libreria: `half` (`box-shadow.wgsl:39`, quindi anche nell'uber) e `step` come variabile locale (`jfa.wgsl:43`, `sdf-jfa.wgsl:71`). Tint li rinomina (le pipeline qui sopra sono vive); da tenere d'occhio per il compilatore WGSL di Safari (M12).
  - **F4 (basso, non di Metal)**: il "PBR Neutral (Khronos)" di `bloom.wgsl:86-96` non è la curva di riferimento che implementa `fxaa-tonemap.wgsl:36-55`. Con un grigio 2.0 dà 1.314 contro 0.960, quindi l'uscita supera 1 e la swapchain a 8 bit la taglia. `BloomPass` parte con `tonemapMode` 1.
  - **F5 (info, strumenti)**: `cull.wgsl:8` contiene `enable subgroups;` in un commento, e un controllo testuale ingenuo lo scambierebbe per una direttiva; `USE_SUBGROUP_ID` non è mai letta; `.claude/agents/wgsl-validator.md` usa `/tmp/claude-1000` (è il task 6.18); `validate-wgsl-naga.mjs` copre solo i 9 moduli composti o del sort.

### M2 — Harness in Mode B

Cache degli shader fredda al primo giro (profilo `chrome-profile-webgpu` mai usato con l'harness): già al primo giro, con le attese di 3,5 s del runner, tutti i verdetti erano quelli attesi (`m2-tabs-B-pass1.json`). Secondo giro con il runner esteso (stato, nome e dettaglio di ogni check; 7 s su Lighting, Rendering FX, Lifecycle e 2D Twins), identico (`m2-tabs-B.json`):

| Tab | Esito | Note |
|---|---|---|
| Primitives | 5/6 · 1 skip | skip: MSDF ("no font atlas in demo assets"). Linee: "horizontal covers 3 pixel rows (want 3)" a dpr 2 |
| Scene Graph | 5/5 | |
| Input | 2/6 | i 4 ⏳ aspettano input reale (tastiera, click, puntatore, scroll) |
| Audio | 4/4 | |
| Particles | 4/4 | |
| Rendering FX | 3/4 · 1 skip | skip: Tonemap (stub). Bloom 0.067 → 0.082 a 6 px dal quad; outline arancione (0.961, 0.482, 0.004) solo accanto al quad selezionato |
| Lighting | 6/6 | 2 gruppi, 2 SDF set; lit = unlit × luce (0.489, 0.101) |
| Debug Tools | 6/7 · 1 skip | skip: hash di determinismo (WASM senza `dev-tools`) |
| Lifecycle | 6/6 | |
| 2D Twins | 5/6 · 1 skip | twin 4749/4749 texel uguali; skip: 'Transparent sort under churn' (solo Mode C) |

Console: solo `Failed to load resource … 404`, che `list_network_requests` attribuisce a `favicon.ico`. Screenshot di Primitives (`m2-primitives-B.png`): tutte le 6 linee verticali e le 4 orizzontali, tutte e tre le bezier. È il contrario del sintomo AMD con il percorso subgroup rotto (una linea sola, nessuna bezier), qui con il percorso subgroup **attivo**. Il bloom e l'outline, cioè i grafi ricostruiti a runtime, vanno in vivo, e così il grafo lit.

### M3 — Harness in Mode C

`?mode=C`, runner esteso su tutti i tab (`m3-tabs-C.json`): stessi verdetti di B, più **2D Twins 6/6**:
- 'GPU rows of 2D entities': "12 frames, 12 via scatter (Mode C); worst GPU/CPU difference 1.2e-7". Il rischio sulla precisione di `sin`/`cos` in MSL non si presenta: 1.2e-7 contro la tolleranza di 1e-5, quindi non c'è nessuna domanda di tolleranza da fare;
- 'Transparent sort under churn': "60 frames of churn, 60 read back, 59 with a scatter upload AND a new id column; every one passes (a)-(f)";
- 'Transparent sort matches the oracle', 'Twins draw the same pixels' (4749/4749) e le due 'Depth orders…' passano come in B.

Console: solo il 404 di `favicon.ico`.

### M4 — Baseline di pixel dell'M2

La baseline del Mac per i fix che seguiranno. Presa a `22fd6b0` (nessuna modifica al motore rispetto a master `b2ccd0c`), con `ts/wasm` = `build:wasm`. Finestra CSS 1200×689 per tutta la cattura, dpr 2, canvas 1960×1248 (CSS 980×624), display integrato a 120 Hz, a batteria. Server "gpu".

- **Procedura.** È `capture.js` del 2026-09-27, eseguito invariato. Il corpo viene assegnato a `window.__captureFn` una volta per caricamento di pagina, e ogni tab si cattura con `window.__captureOpts = { tab }` seguito da `await window.__captureFn()`. Questa chiamata unica sostituisce le due `evaluate_script` dell'handoff e non cambia nulla. Prima della prima cattura ho confrontato il sorgente definito nella pagina con il file (`Function.prototype.toString`, senza commenti e spazi): 10322 caratteri uguali. Un caricamento per run e per modo (`?mode=B&bench`, `?mode=C&bench`): `performance.timeOrigin` resta lo stesso dalla definizione allo `statuses`, e `__captureVisited` elenca i 10 tab nell'ordine fisso.
- **Stabilità run1 contro run2**: `stability-B.txt` e `stability-C.txt` finiscono entrambi con `PASS`. Coprono quasi quanto AMD: in C primitives C=2364, scene-graph 2297, twin-2d 3609 (AMD: 2364, 2299, 3612). Lighting ha solo i verdetti, come su AMD (`NO_BIT_EXACT`).
- **Verdetti contro AMD** (`compareStatuses`, ammesso il churn in B): `OK` in B e in C.
- **Note.** twin-2d scarta 4 punti di 'Depth orders 2D sprites' (x = 36-42) perché cadono fuori dall'inquadratura: anche la baseline AMD scarta gli stessi 4. C-twin-2d ha 5 punti instabili, per il churn che c'è solo in Mode C; `compare.mjs` li esclude.
- **Anomalia (una volta).** Durante il primo tentativo di run1-B la pagina si è ricaricata da sola tra rendering-fx e lighting. In console c'era `[vite] server connection lost. Polling for restart...` e poi un nuovo caricamento. Il dev server era sempre lo stesso processo (PID invariato) e non aveva scritto nulla nel log. Nessuno degli agenti in background aveva toccato il browser o la porta 5173 (verificato nei loro transcript). È caduta la WebSocket HMR, per una causa esterna al repo. Ho rifatto run1-B da capo, in un solo caricamento. Da qui in poi `timeOrigin` si controlla a ogni run.
- **Uso come cancello.** Dopo ogni fix: `node docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs --base docs/plans/assets/2026-09-29-mac-m2/baseline/run1 --run <cartella nuova> --mode B|C --step <n>`, con la stessa finestra (CSS 1200×689, dpr 2), altrimenti `framingDiff` rifiuta il confronto. `run2/` resta solo in locale (`.git/info/exclude`).

### M6 — Mode A

- `?mode=A`: `window.__hyperion.mode` = `'A'`, nessun renderer sul main thread. La riga dell'adapter arriva in console anche in Mode A. L'unico punto che la stampa è `createRenderer` (`renderer.ts:214`), che in Mode A gira solo nel render worker (`render-worker.ts:37`): quindi **chrome-devtools-mcp mostra i messaggi dei worker** e non serve cambiare contesto in DevTools a mano.
- Runner esteso su tutti i tab (`m6-tabs-A.json`): **nessun `fail`**. Verdi Velocity, Hit testing, Audio 4/4, Lighting 4/6 (backend, ambient, quality, layers), Debug Tools 6/7, `EntityHandle.data()`. Tutti gli skip sono delle classi previste: 21 "pixel probe unavailable", 7 "no renderer" (selection, particelle, outline), 2 "no main-thread renderer" (texture), più MSDF, Tonemap, hash di determinismo e churn. La regola "ogni check verde in B è verde o in skip in A", controllata a macchina contro `m2-tabs-B.json`, dà 0 violazioni. La WebSocket di Vite non è caduta durante il run (vedi l'anomalia in M4 e la nota sotto).
- Screenshot: Primitives (`m6-primitives-A.png`) disegna gradienti, box shadow, la griglia di quad e le linee. Lighting (`m6-lighting-A.png`) disegna la scena lit: luce puntiforme, spot con le ombre dei muri, gradienti illuminati, luce blu del layer 1. L'inquadratura è quella della camera del render worker, che i `fitView` dei tab non muovono (lacuna nota della 3.2): le bezier (x = 21) e due linee verticali restano fuori a destra, e il "pavimento" della demo Lighting non copre le strisce in alto e in basso.
- Console di Mode A, worker compresi: solo la riga dell'adapter, quella del modo e il 404 di `favicon.ico`. Nessun errore di validazione.
- `?mode=auto` sceglie **A** (Chrome su macOS).
- **Nota sulla WebSocket di Vite.** La prima corsa del runner in Mode A si è interrotta con `Execution context was destroyed`: di nuovo `[vite] server connection lost` e un reload, la seconda volta in questa sessione. Nel client di Vite 6.4 **qualunque** `close` della WebSocket HMR, anche pulito, porta al reload (`client.mjs`: `vite:ws:disconnect` → `waitForSuccessfulPing` → `location.reload()`). Il motore non usa WebSocket né `location.reload` (grep su `ts/src`), e il processo del server è rimasto lo stesso. Da qui in poi le navigazioni di test passano un `initScript` che avvolge `WebSocket` solo per il protocollo `vite-hmr`. Registra ogni chiusura (code, reason, wasClean, ora) in `window.__viteWsCloses` e in console, e ferma il reload con `stopImmediatePropagation`. Non tocca l'adapter né l'engine, e resta fuori dal repo. Da quel momento: zero chiusure registrate.

### M6b — Mode A contro B alla stessa inquadratura

Tre entità 2D nell'origine con camera in (0,0,0) e zoom 1: quad bianco in x = -4, gradient in 0 (i parametri dell'handoff danno un rosso uniforme, perché `stop1` ha solo il rosso), quad `.transparent()` in 4.
- `map.json` di A con la `vp` della camera del worker, `orthographic(-10a, 10a, -10, 10, -1, 1000)` con la view identità, verificata su `camera.ts` e `render-worker.ts:41`. L'aspetto da usare è quello del **backing store** che il worker riceve all'init, 1960/1248 = 1.5705: la `cam.viewProjection` del main thread ha lo stesso `vp[0]` = 0.063673. L'handoff suggerisce `rect.width / rect.height`, che qui è 1.5718 perché l'altezza CSS è frazionaria (623,5): 0,08 % di scarto, meno di 1 px ai punti usati.
- A e B campionati con `pixels.py` in (-4,0), (0,0), (4,0), (-4,1.2): bianco 255, rosso (255,0,0), bianco 255, clear 17, identici nei due modi. Confronto su una griglia di 7525 punti attorno ai tre quad, esclusi i bordi (±0,1 unità): **scarto massimo 0/255**.
- Mondo vuoto (tutto distrutto, 30 frame): **B** torna al clear (17 in tutti e quattro i punti). **A** tiene l'ultimo frame con i tre quad, e `latestRenderState.entityCount` resta 3, perché il bridge scarta gli stati vuoti: è la lacuna nota del passo 10, non una regressione.

### M6c — Mode A: stato che arriva per messaggio

- **Qualità della lighting.** La demo Lighting non si presta: la luce puntiforme gira e lo spot oscilla a ogni tick (`demo/lighting.ts:179-180`), e il suo check 'Quality' chiama `setQuality` senza verificare che il valore arrivi al renderer. Ho quindi costruito in `?mode=A&bench` una **scena statica**: pavimento che riceve luce, due muri con `castsShadow`, una luce puntiforme con ombre.
  - `shadowSteps` 48 fotografato due volte di seguito: 0 pixel diversi su 2 444 120, quindi la scena è davvero statica.
  - 4 contro 48: cambia il 6,35 % dei pixel del canvas (54 136 di almeno 16/255, massimo 171/255). A 4 passi la luce trapela dietro i muri, con bordi d'ombra a gradini e un cuneo illuminato tra i due muri; a 48 passi le ombre sono pulite (`m6c-quality-steps4.png`, `m6c-quality-steps48.png`, maschera `m6c-quality-diff-4-vs-48.png`).
  - Percorso "in sospeso": ricaricata la pagina, `setQuality({ shadowSteps: 4 })` è la prima cosa del primo `evaluate_script`, poi la stessa scena. Il risultato è **identico** allo scatto a 4 passi della prima pagina: i due PNG erano uguali byte per byte (`cmp`), quindi nel repo c'è solo `m6c-quality-steps4.png`. Anche i due scatti a 48 passi erano uguali byte per byte. Però nel codice di oggi il ramo `pendingQuality` di `render-worker.ts:54-57` **non si raggiunge dal facade**. `Hyperion.create` aspetta `bridge.ready()` (`hyperion.ts:182`), che in Mode A si risolve solo dopo il `ready` del render worker, mandato dopo `createRenderer`. E la qualità viaggia solo da `tick()` (`hyperion.ts:835-839`). Quella prova quindi passa per il percorso normale; il ramo in sospeso è codice difensivo.
- **Input del sort 5b.** Tre gradient 2D `.transparent()` sovrapposti nell'origine: rosso uniforme a depth 0.2, verde→nero a 0.5, blu→nero a 0.8.
  - `pixels.py` in (-0.6,0), (0,0), (0.6,0), (-0.6,0.6): rosso (255,0,0) davanti ovunque.
  - Scambiate a runtime le depth di rosso e blu: blu davanti, con il suo gradiente (202 → 126 → 51 per u = 0,2 → 0,5 → 0,8).
  - Nessun `The render state lacks transparentCount` né altri avvisi nella console, worker compresi.

### M7 — `timestamp-query`

- **Server "gpu"** (con `--enable-webgpu-developer-features`, verificato sulla riga di comando dei 4 processi del profilo `chrome-profile-webgpu`): `?mode=B`, tab Lighting, `enableGpuProfiling()`, quattro letture in 6 s. `getGpuTimings()` resta **vuoto**. Dopo 120 frame compare `[Hyperion] GPU profiling is enabled but this browser returned 120 frames of zeroed timestamps…`.
- **Server "stock"** (nessun flag): stesso esito, stesso avviso, come dice `CLAUDE.md:450`. Senza il flag `adapter.info.device` è vuoto, quindi la riga dell'adapter diventa `apple / metal-3, subgroups 32-32`.
- **Perché: la diagnosi.** Su un device fresco, cinque submit, e in ognuno sei tipi di pass con `timestampWrites` (`m7-timestamp-probe-gpu.json`, `…-stock.json`):

  | Pass | Con il flag | Stock |
  |---|---|---|
  | compute **vuoto**, solo `beginningOfPassWriteIndex` (il marker del profiler) | **0** | **0** |
  | compute vuoto, inizio + fine | 0 e 0 | 0 e 0 |
  | compute con 1 workgroup | valori veri, durata 3,3-5,3 µs | valori veri, quantizzati a 65 536 ns (durata 0 o 65,5 µs) |
  | compute pesante (4096 workgroup × 2000 iterazioni) | 7,9-10,2 ms | 6,1-10,9 ms, multipli di 65 536 ns |
  | render pass (clear + triangolo a schermo intero, 1024²) | 53 µs-3,3 ms | 65-328 µs, multipli di 65 536 ns |
  | compute con dispatch, solo inizio o solo fine | valori veri | valori veri |

  Due conclusioni. Primo, su Metal un compute pass **vuoto** non riceve timestamp: sono gli zeri dei marker del profiler (`gpu-profiler.ts:199-211`) a far scartare ogni frame (`gpu-profiler.ts:310`), con o senza flag. Il flag toglie solo la quantizzazione a 65,5 µs di Chrome. Quindi il gotcha di `CLAUDE.md:450` ha la causa sbagliata, e l'avviso del profiler ("…unless started with --enable-webgpu-developer-features") su Mac manda fuori strada. Secondo, sull'M2 **i pass indipendenti si sovrappongono**: in tutti e 5 i submit il render pass è partito prima della fine del compute pesante codificato prima di lui, e due volte è cominciato addirittura prima. Su questa GPU, "marker successivo meno marker precedente" non misura un pass. Curiosità: tra il submit 2 e il 3 i valori assoluti sono tornati indietro di circa 0,82 s; dentro un submit sono coerenti.
- **Esito.** È il ramo "zeri anche con il flag" dell'handoff: il bench (M8) e il costo della lighting (M9) non si lanciano finché l'utente non sceglie la strada per il profiler (domanda sotto).

### M10 — Crescita dei tier compressi

Lo script dell'handoff, invariato (`m10-tier-growth.json`), su un device fresco per formato, porta il tier 0 (64 px, 16 layer) a 17 layer:
- `rgba8unorm`: `ok`;
- `astc-4x4-unorm` e `bc7-rgba-unorm`: `copySize.width (2) is not a multiple of compressed texture format block width (4)`, in `CopyTextureToTexture` durante la crescita.

L'analisi dell'handoff regge. `texture-manager.ts:505-516` copia ogni mip con `Math.max(1, size >> mip)`, e i mip 2×2 e 1×1 non sono multipli del blocco 4×4. L'encoder diventa invalido, e subito dopo la vecchia texture viene distrutta con tutti i layer caricati. Il bug è portabile (BC7 anche su Linux e Windows) e non si è mai visto perché non esiste un asset KTX2 e, su un device BC, i PNG finiscono nel tier di overflow rgba8. Gli upload (KTX2 diretto e transcodificato, `texture-manager.ts:779` e `:823`) scrivono solo il mip 0, la cui dimensione è sempre multipla di 4, quindi non hanno lo stesso problema; la copia del tier di overflow (`:409`) è rgba8. Il fix è quello prescritto dall'handoff (vitest con device finto, poi la copia sulla dimensione fisica arrotondata al blocco): da fare test-first sul branch.

### M5 — Cull a subgroup a 32 lane: insiemi di indici

- **Lo script** (`cull-subgroup-check.js`, 759 righe) lo ha scritto un workflow (`wf_99092386-7be`): un autore, che l'ha provato in node su un WebGPU finto che emula `cull.wgsl`; tre revisori avversari (semantica dello shader, API WebGPU, comparatore e controlli), con 6 punti minori; un fixer che li ha applicati tutti. Ho riletto io l'intero file prima di eseguirlo.
- **Esecuzione.** È il file committato, identico: la pagina lo ha caricato da una copia temporanea in `ts/public/__m5-tmp/`, poi cancellata, e lo SHA-256 del testo eseguito (`bc99d913…875a`) è quello del file. Server "gpu", `?mode=B&bench`, device fresco con `subgroups`. Uscita in `cull-subgroup-check.json`. **`ok: true`** in 3,9 s: 600 dispatch, 3,6 ms di media ciascuno.
- **Sonde delle lane**: 8 subgroup da 32 invocazioni **contigue** per workgroup (`o[l] = (l & ~31)·1000 + (l | 31)` per ogni l). `subgroupElect()` sceglie l'invocazione più bassa di ciascuno (0, 32, …, 224). `liveConfig`, ricavato con i predicati del renderer (`detectSubgroupSupport`, `subgroupCullSupported`), conferma che il renderer vivo usa proprio la pipeline `live`.
- **Pipeline positive**: `live` (il testo e le costanti del renderer vivo: `enable subgroups;` + `requires subgroup_id;`, `{1, 32, 1}`), `handoff` (`{1, 32, 0}`) e `atomic`. **120 casi su 120** ciascuna: N ∈ {1000, 99937, 100000} × 10 seed × 4 scenari (misto ~31 % visibile, metà ~52 %, tutto visibile, sequenze che attraversano i confini di subgroup e workgroup). Per ogni slot sono giusti il conteggio e l'insieme esatto degli indici (niente duplicati né buchi), la coda della regione è intatta e gli args non toccati sono intatti. Coordinate multiple di 1/64, quindi valori esatti in f32; 187 928 casi a filo di piano e 149 957 appena fuori.
- **Controlli negativi**:
  - `wrongWidth` (`SUBGROUP_SIZE` 16 su hardware a 32 lane): fallisce 120/120.
  - `wrongWidthMax16` (lo stesso con `MAX_SUBGROUPS` 16, così nessun array sfora): fallisce 120/120 **con tutti i conteggi giusti e gli insiemi sbagliati**. È la classe di guasto vista sull'AMD (32-64 lane), riprodotta qui: il check la vede.
  - L'auto-test del comparatore coglie tutte e 6 le iniezioni: duplicato + buco, indice spostato, scambio, conteggio +1, indice oltre la finestra, `firstInstance` +1.
- **Esito.** Sull'M2 il percorso cull a subgroup, che il renderer usa davvero, è corretto indice per indice. Il cancello `subgroupCullSupported` (esattamente 32-32) è giusto così com'è per Apple: nessuna domanda da fare. `CLAUDE.md:487` va aggiornato con questo esito (task 6.8).

## Fix fatti sul branch (2026-09-29)

Ognuno test-first, in un commit suo, con il design breve approvato dall'utente.

| Commit | Cosa | Test | GPU |
|---|---|---|---|
| `f1b8ba9` fix(texture) | M10: la crescita di un tier compresso copia ogni mip in blocchi 4×4 interi (`Math.max(4, size >> mip)`; rgba8 invariato) | `texture-manager.test.ts`: un device finto registra le estensioni copiate (BC7 e ASTC tier 0, BC7 tier 3, rgba8), con valori ricavati a mano; prima del fix 3 test rossi | M10 rilanciato: `ok` per ASTC, BC7 e rgba8, tier 0 e tier 3 (`m10-tier-growth-after-fix.json`) |
| `db55fed` fix(bloom) | F4: `pbrNeutralTonemap` di `bloom.wgsl` è ora la curva Khronos di `fxaa-tonemap.wgsl` | `bloom-pass.test.ts` confronta i due corpi (commenti e spazi esclusi): la forma approvata dall'utente | naga valido, Tint su Metal senza messaggi. Misura: con il bloom a intensità 0 lo sfondo 0.067 esce a 0.027 = 7/255, il valore Khronos (0.02806); la curva vecchia dava 0.067 |
| `ba3fb6f` fix(bezier) | F1: sotto `dot(B, B) < 1e-9` (punto di controllo entro 1,6e-5 dalla metà della corda) `bezier_sd` usa la distanza dal segmento | nuovo check 'Straight bezier' in Primitives: l'onda viene resa dritta, poi quasi dritta a 1e-5, 1e-4, 1e-3 e 1e-2 (a cavallo della soglia), e ripristinata; nessuna entità nuova. Prima del fix falliva solo la curva esattamente dritta, con la linea al clear 0.067: la formula di Quilez regge già a \|B\| = 2e-5. Dopo il fix passano tutte e cinque | naga 9/9 sui moduli composti; Primitives 6/7 · 1 skip |
| `c1b513d` docs(line) | `{ unit: 'px' }` = pixel del device (decisione dell'utente): JSDoc di `line()` e `CLAUDE.md` | — | — |
| `cd8e398` test(bloom) | il check 'Bloom' confrontava la pipeline senza tonemap con il bloom in PBR Neutral: con la curva giusta falliva (0.067 senza bloom, 0.043 con). L'utente ha deciso di tenere PBR Neutral come default di `enableBloom`, e il check ora confronta lo stesso composite a intensità 0 e 0.5; la soglia del centro del quad scende a 0.8, perché Khronos porta 1.0 a 0.869 | — | 0.027 a intensità 0, 0.043 a 0.5, centro 0.894 |

- **Cancello M4** dopo i fix (al HEAD `cd8e398`, dev server appena riavviato): `compare.mjs --step 0` contro `baseline/run1` dà **PASS** in B e in C (`baseline/after-fixes-B.txt`, `…-C.txt`). La `scene-hdr` è identica al bit in ogni tab, e il check nuovo 'Straight bezier' passa. Il run nuovo resta solo in locale.
- **Lezione per le catture.** Un file `ts/src/demo/*.ts` modificato con il dev server acceso viene servito all'harness come `…?t=<timestamp>`, mentre `capture.js` lo importa senza `?t` e ottiene **un'altra istanza** del modulo. Il `setup` avvolto non viene mai chiamato, e la cattura va in timeout dopo 30 s ("setup of 'primitives' did not finish"), mentre i check nella pagina passano. Prima di catturare dopo aver toccato una sezione della demo va riavviato il dev server.
- **WebSocket di Vite.** Nei due caricamenti prima del primo riavvio del server la WebSocket HMR si è chiusa con **code 1006** (senza frame di chiusura) a circa 50-53 s dal caricamento. Visibilità e rAF erano intatti: nessun cambio di `visibilityState`, nessun buco di rAF oltre 250 ms. Dopo i riavvii del dev server, zero chiusure in quattro caricamenti oltre i 50 s. La causa non è stata isolata; l'`initScript` resta, e resta anche la registrazione.

## Domande all'utente e decisioni (2026-09-29)

1. **Timestamp su Metal (M7)**: scelta la strada dei **`timestampWrites` di inizio e fine sui pass veri**. È un cambio architetturale (il contratto tra `RenderGraph`, `GpuProfiler` e ogni `RenderPass`, compresi i pass dei plugin), quindi prima ci sono il design e la spec in `docs/plans/`, poi il piano. M8 e M9 aspettano il nuovo profiler, e l'alimentatore collegato.
2. **`{ unit: 'px' }`**: restano **pixel del device**; solo documentazione (`c1b513d`).
3. **F1 e F4**: **corretti tutti e due qui** (`ba3fb6f`, `db55fed`).
4. **M11 (ASTC)**: **saltato**, nessun target solo-ASTC.
5. **Default del tonemap del bloom** (emerso dal fix F4): `enableBloom` resta **PBR Neutral** per default; si corregge il check 'Bloom' (`cd8e398`).
