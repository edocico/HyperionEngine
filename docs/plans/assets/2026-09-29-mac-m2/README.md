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

### M0 — Adapter, feature, limiti

- Console dopo `?mode=B`: (a) la riga dell'adapter qui sopra; (b) nessun `lacks 'indirect-first-instance'`; (c) **nessun** `Cull: atomic path`: il percorso subgroup è attivo; (d) nessun `initial render graph raised GPU errors`. Unico errore: il 404 di `favicon.ico`.
- Feature dell'adapter: `bgra8unorm-storage`, `clip-distances`, `core-features-and-limits`, `depth-clip-control`, `depth32float-stencil8`, `dual-source-blending`, `float32-blendable`, `float32-filterable`, `indirect-first-instance`, `primitive-index`, `rg11b10ufloat-renderable`, `shader-f16`, `subgroup-size-control`, `subgroups`, `texture-component-swizzle`, `texture-compression-astc`, `texture-compression-astc-sliced-3d`, `texture-compression-bc`, `texture-compression-bc-sliced-3d`, `texture-compression-etc2`, `texture-formats-tier1`, `texture-formats-tier2`, `timestamp-query`.
- Il renderer vivo: `compressionFormat` = `bc7-rgba-unorm` (BC7 prima di ASTC), `gpuProfilingSupported` = true, `CullPass.SUBGROUP_CONFIG` = `{useSubgroups: true, subgroupSize: 32, useSubgroupId: true}`. Con `useSubgroupId` il sorgente del cull comincia con `enable subgroups;` + `requires subgroup_id;` (`wgslLanguageFeatures` ha `subgroup_id`); la costante `USE_SUBGROUP_ID` è dichiarata in `cull.wgsl:13` e non è letta da nessuna parte, quindi cambia il testo del modulo ma non il comportamento.
- Limiti del device di default = i default della specifica WebGPU, voce per voce (`maxStorageBuffersPerShaderStage` 8, `maxComputeWorkgroupStorageSize` 16384, `maxTextureArrayLayers` 256, …): i budget verificati dai test valgono. L'adapter offre di più (10 storage buffer, 32 KiB di workgroup memory, 2048 layer), ma il renderer non lo chiede.

### M1 — WGSL e pipeline su Metal

- Gli script `…-validate-wgsl.js` e `…-validate-sort-wgsl.js` del 2026-09-27, eseguiti invariati in una sola chiamata su un device fresco: `ok: true`. I 7 moduli composti compilano **senza nessun messaggio** (nemmeno warning); le 19 pipeline (opaque, transparent e occluder per ciascuno dei 6 tipi, più l'uber transparent) hanno tutti gli error scope vuoti; ogni modulo coincide con quello pubblicato dal renderer. Gather e sort compilano senza messaggi e `TransparentSortPass.setup()` costruisce le 4 pipeline compute senza errori. Il `diagnostic(off, derivative_uniformity);` dell'uber è accettato da Tint anche con l'uscita MSL.
- Estensione (non chiesta dall'handoff): **tutti** gli altri moduli WGSL dell'app compilati su Metal (`wgsl-compile-all.json`): il cull nelle tre varianti (senza subgroup, con subgroup, con subgroup + `subgroup_id` come nel renderer vivo), scatter, fxaa-tonemap, selection-seed, jfa, outline-composite, bloom, particle-simulate, particle-render, debug-line, sdf-jfa, light-accum, pixel-probe, transparent-gather, transparent-sort: 17 su 17 senza messaggi. Fuori conteggio: `prefix-sum` compila con `enable subgroups;`; `basic-binding-array` fallisce come previsto (`binding_array` richiede `sized_binding_array`, che il browser non ha: è l'artefatto di design che nessuno importa).
- Parte statica (agente `wgsl-validator` + naga): _vedi sotto quando arriva_.

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
