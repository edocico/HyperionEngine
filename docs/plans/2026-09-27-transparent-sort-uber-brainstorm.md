# Fase 5b — ordinamento dei trasparenti: GPU sort + uber pipeline (stato del brainstorming)

> **Stato al 2026-09-27, sessione chiusa qui su richiesta dell'utente.** Il brainstorming è a metà: la sezione 1 del design è approvata, la sezione 2 (il sort) ha un design candidato NON ancora presentato né approvato, e restano da presentare le sezioni 3-6. La spec vera si scrive solo dopo l'approvazione di tutte le sezioni, poi la rivede l'utente, poi il piano con writing-plans, poi l'esecuzione.
>
> Il JSON completo del workflow di design (vincitore, secondi, giudici, problemi) sta in `docs/plans/assets/2026-09-27-transparent-sort-design-workflow.json`. Il run del workflow è `wf_537ea535-af9`; lo script è salvato nella directory della sessione, ma il JSON basta per riprendere.
>
> **Aggiornamento, seconda sessione (2026-09-27 sera):** la sezione 2 è APPROVATA ("si ok") nella forma corretta qui sotto ("Sezione 2 — APPROVATA"). Il testo candidato più in basso resta come riferimento. Prima della presentazione, il workflow `wf_ad447cec-c9d` ha verificato i fatti sul codice e sulla spec WGSL, con shader di prova compilati su Chrome 154 e l'iGPU AMD.

## Sezione 5 — APPROVATA ("ok mi torna", seconda sessione)

- **Grafo.** Il factory `scene` diventa `[ScatterPass, CullPass, TransparentSortPass, ForwardPass]` in tutti e sei i grafi (3 composite × illuminazione accesa/spenta).
  - `RadixSortPass` e `radix-sort.wgsl` si ELIMINANO, con il loro test, lo slot, l'accept HMR e il commento in `graph-assembly`. Oggi è morto e anche rotto: scatter con `atomicAdd` non stabile, parametri scritti 4 volte nello stesso buffer.
  - `TransparentSortPass` legge `indirect-args`, `visible-indices`, `entity-bounds`, `entity-ids`; scrive `transparent-order` e `transparent-args`, ed è l'unico a scriverle. È `optional`.
  - `ForwardPass` (lit e unlit) LEGGE `transparent-order` + `transparent-args`: è ciò che tiene vivo il sort e lo ordina prima del forward.
  - Test di composizione: in tutti e 6 i grafi `transparent-sort` sta dopo `cull` e prima di `forward`.
  - `entity-ids` lo scrive solo la CPU, come già `selection-mask`.
- **Possesso dei buffer.** Del renderer, nel pool: `entity-ids`, `transparent-order`, `transparent-args`. Privati del pass: chiavi A/B, valori A, `sort-hist`, gli uniform. Motivo: i probe HMR fanno `setup()`+`destroy()` sul pool VIVO.
  - Slot HMR `transparent-gather` e `transparent-sort`, con probe = un `TransparentSortPass` usa e getta.
- **Draw uber in `ForwardPass`.**
  - Una pipeline uber prende il posto delle 6 pipeline trasparenti, con lo stesso descrittore: blend src-alpha/one-minus-src-alpha, alfa one/one-minus-src-alpha, depth `less` senza scrittura, cull back, stesso vertex buffer.
  - Un secondo bind group del gruppo 0 ha `transparent-order` al binding 2.
  - Un solo `drawIndexedIndirect(transparent-args, 0)`: con `firstInstance` 0 non serve `indirect-first-instance`.
  - Draw saltato con `transparentCount == 0`.
  - Il test "6 pipeline per 3 tipi" diventa 3 opache + 1 uber.
- **Casi limite:**
  - count 0 o mondo vuoto: nulla viene codificato, `profileStages` restituisce `[]`, nessun draw;
  - tutti i trasparenti fuori schermo: dispatch indiretti a 0, in silenzio;
  - overflow (visibili > B): si limita a B, con flag nell'header;
  - Light2D `.transparent()` escluso (i bucket 26/27 restano a `LightAccumStage`);
  - trasparente e opaco alla stessa z: il trasparente resta nascosto (`less` stretto), invariato;
  - i trasparenti non vengono contornati (`SelectionSeedPass` disegna solo i bucket 0/1), invariato e fuori scope;
  - Mode A: non verificabile qui.
- **Capacità.**
  - Una costante esportata `MAX_GPU_ENTITIES = 100_000` al posto delle 3 copie.
  - Warning una tantum nel renderer quando `entityCount > MAX_GPU_ENTITIES`.
  - **Decisione dell'utente:** `validateConfig` RIFIUTA `maxEntities > MAX_GPU_ENTITIES`, con un errore chiaro. Gli spawn di `RawAPI` non vengono contati: per loro resta solo il warning.
- **Profiler.**
  - Un solo compute pass senza profiler.
  - Con il profiler, un compute pass per stadio: 22 marker e 4 nomi (`transparent-sort/gather|upsweep|scan|scatter`).
  - Test: `profileStages` corrisponde a `mark`, anche nel caso saltato.
- **Readback di dev `engine.debug.readTransparentSort()`.**
  - Nel frame successivo si copiano: l'uscita del gather (chiavi/valori A subito dopo il dispatch), l'header, `sort-hist` (i `digitBase` delle 7 passate + i diag) e l'ordine finale.
  - `COPY_SRC` in dev solo sui buffer del sort: gli input (`bounds`, `entityIds`) la CPU li ha già in `state`.
  - RIFIUTA quando l'header non contiene il `limit` atteso, nel Mode A, senza renderer, in pausa.
  - Le chiavi si ricalcolano dai dati CPU contro l'oracolo: una colonna id vecchia qui si vede.
  - Niente anello per frame (problema 11, superato).

## Sezione 4 — APPROVATA ("si ok", seconda sessione)

Fatti dal workflow `wf_7b307272-b6a` (siti di mutazione in Rust + trasporto TS).

- **`transparentCount`: ricalcolo, non contatore.**
  - Conta il bit 8 in `gpu_render_meta[..gpu_count*2]` alla fine di `collect_and_cache_dirty`, dopo la riscrittura delle righe sporche. Il conteggio va anche in `snapshot_restore`; `reset` lo porta a 0.
  - Costo nativo: 7-17 µs a 100k.
  - Perché non un contatore incrementale: `clear_slot` gira DOPO `gpu_count += 1` su una riga con un bit vecchio mai contato; il componente `Transparent` è in anticipo di un frame sulla riga; le righe oltre `gpu_count` contengono dati vecchi, quindi si conta sempre entro `gpu_count`.
  - Include le Light2D trasparenti: è un limite superiore.
- **`ids_generation: u32` in `Engine`, NON in `RenderState`.**
  - `reset`, `snapshot_restore` e `engine_init` ricreano `RenderState` da zero.
  - `RenderState` alza un flag interno in `assign_slot` (dopo l'early return), nel flush che rimuove righe e in `collect_gpu`. `Engine` lo raccoglie e incrementa (`wrapping_add`) al massimo una volta per frame.
  - `reset` e `snapshot_restore` incrementano sempre.
  - Raffina la decisione 6 dell'utente (flag → generazione): nei Mode A/B più `tick-done` si sovrascrivono tra due RAF.
- **Esportazioni:** `engine_gpu_transparent_count()` e `engine_gpu_entity_ids_generation()`, `u32`, con commento SAFETY.
- **Trasporto.** Entrambi i campi DENTRO `renderState`, non sul messaggio: per questo `tickCount` vale 0 nel render worker del Mode A. Siti da toccare:
  - Mode C: il literal pieno e quello vuoto (`worker-bridge.ts` ~495-545) + l'interfaccia WASM;
  - `engine-worker.ts`: due literal + il tipo inline;
  - Mode B: ricostruzione (`worker-bridge.ts` ~133-155);
  - Mode A: copia sul main thread (~267-289), più il tipo `RenderState` e la ricostruzione in `render-worker.ts`.
  - `FrameState.transparentCount`. Una factory di test condivisa `makeRenderState(overrides)` al posto dei tre literal (`integration.test.ts:59`, `hyperion.test.ts:315`, `lighting-api.test.ts:9`); `debug-line-pass.test.ts:15` per `FrameState`.
- **Normalizzazione nel renderer.** Conteggio mancante o non finito → `entityCount`. Generazione mancante → `NaN`, quindi upload a ogni frame: corretto e più lento. Warning una tantum in dev. MAI un default costante sulla generazione.
- **Upload.**
  - `entity-ids` è un buffer del pool creato in `createRenderer` accanto a `selection-mask`: `CAP×4`, `STORAGE | COPY_DST`, `+COPY_SRC` in dev.
  - Il marcatore è una variabile locale della closure, inizializzata a `NaN`.
  - Il `writeBuffer` di `entityCount` id sta tra la fine dell'if/else degli upload (`renderer.ts` ~831) e la selection mask (~833), così gira anche nei frame con lo scatter del Mode C.
  - Buffer e marcatore MAI in un pass: gli swap del grafo e i probe rifanno il `setup()`.
- **Test Rust.**
  - Generazione: sale con `assign_slot` e con un flush non vuoto; non sale con l'assign idempotente, con `write_slot`, con `shrink_to_fit` né con `collect_dirty_staging` senza cambi; `reset` e `restore` la fanno salire.
  - Conteggio: confronto con un ricalcolo a forza bruta su sequenze casuali con seed di spawn, despawn e toggle, inclusa la coda vecchia e i casi di swap trasparente↔opaco.
- **Test TS.** Un test per bridge che il campo arrivi; l'upload scatta solo al cambio di generazione e anche nei frame con lo scatter.
- **Mode A.** Funziona perché `rs` viene inoltrato intero, ma qui non si verifica sulla GPU (passo 10). Il problema del mondo vuoto resta com'è.
- **Documentazione.** CLAUDE.md dice "device-lost recovery", ma il codice si limita a loggare (`renderer.ts:205-208`): va corretto.

## Sezione 3 — APPROVATA ("si ok", seconda sessione)

Fatti dal workflow `wf_5bce1f00-66e` (quattro inventari; le prove sono state compilate su Chrome 154 con l'iGPU AMD).

- **Correzione alla sezione 1.** `@diagnostic(off, derivative_uniformity)` messo su `fs_main` o sullo `switch` NON spegne l'errore quando la derivata sta in una funzione chiamata (la severità si decide dove viene chiamata la builtin). Funzionano solo la direttiva globale e l'attributo sulla funzione chiamata.
- **File.** `ts/src/shaders/primitives/`: `prelude.wgsl` + `quad.wgsl` (ex `basic`), `line`, `msdf-text`, `bezier`, `gradient`, `box-shadow`.
- **Preludio.** Contiene:
  - i gruppi 0/1/2;
  - `CameraUniform` nella forma di `line` (`viewportWidth`/`viewportHeight` ai byte 68/72);
  - `override OCCLUDER_PASS`, `CASTS_SHADOW_BIT`, `castsInto`;
  - `RECEIVES_LIGHT_BIT`, `LightingUniform`, `lightGroupOf`, `applyLighting`;
  - `VertexOutput` superinsieme: locazioni 0-5 come oggi, 6 `edgeScale` (prospettiva), 7 `transparent` flat, 8 `primType` flat;
  - gli helper `culledVertex`, `finishVertex`, `unitQuadVertex`, `sampleTier` (crudo), `sampleTierOrWhite`, `occluderSeed`.
- **Librerie.** Ognuna espone solo `<p>_vs(position, entityIdx)`, `<p>_fs(in)` e `<p>_occluder(in)`. Gli altri nomi di primo livello sono prefissati. Nessun binding, entry point o direttiva, e nessun riferimento a `lighting`/`lightBuffer`.
- **Comportamento da preservare:**
  - `msdf` usa `sampleTier` crudo, senza il bianco sull'indice 0;
  - l'illuminazione sta solo in `quad_fs`/`gradient_fs`, mai dopo lo switch;
  - `line` tiene i suoi `fs`/`occluder`, `transparent` calcolato dal bit 8 ed `edgeScale` interpolato con la prospettiva.
- **Compositore TS puro e totale** (solo concatenazione, non lancia eccezioni).
  - Tabella `PRIMITIVE_LIBRARIES` `{type, name, prefix, lit}`, da cui si ricava `LIT_PRIMITIVE_TYPES`.
  - Modulo per tipo = preludio + libreria + wrapper `vs_main` (con il testo dell'early-out dell'occluder identico a oggi) / `fs_main` / `fs_occluder`.
  - Modulo uber = `diagnostic(off, derivative_uniformity);` in PRIMA riga, poi preludio, sei librerie, `vs_main` con switch sul tipo clampato a 6 (6 → `culledVertex`) e `fs_main` con switch su `in.primType`. Niente `fs_occluder`, e l'uber non sta in `SHADER_SOURCES`.
  - La direttiva va SOLO nell'uber: i moduli per tipo restano sotto l'analisi stretta, sullo stesso codice di libreria.
  - Marcatori `// --- piece: X ---` per ricondurre le righe degli errori al pezzo.
- **Hot-reload.** 7 slot di pezzo al posto dei 6 slot di modulo.
  - `write()` ricompone sul posto `ForwardPass.SHADER_SOURCES` e `UBER_SOURCE`.
  - Il probe è `ForwardPass` (6 pipeline opache + l'uber) più `LightGroupsPass` (gli occluder).
  - Reload di più pezzi raggruppati con un debounce e validati insieme (`reloadShaders`); la guardia sul pezzo vuoto sta dentro il probe.
  - `recompileShader('basic')` resta come alias di `'quad'`.
  - Lo slot `radix-sort` va via; entrano due slot per il sort. Conti finali: 22 file importati, 20 ricaricabili a caldo.
- **Test.** I 133 expect sul testo dei sei file (36 A / 74 B / 21 C / 2 D) si riscrivono sui MODULI COMPOSTI. Quelli uguali in tutti i moduli diventano controlli sul preludio più "ogni modulo contiene il preludio alla lettera". Test nuovi:
  - prefissi e assenza di duplicati sull'uber;
  - direttiva solo nell'uber, in prima riga;
  - niente `fs_occluder` nell'uber;
  - clamp del tipo e Light2D vuoto;
  - `applyLighting` raggiungibile esattamente per i tipi `lit`;
  - le librerie non contengono binding né la stringa `fn fs_occluder`;
  - `uniform-layout` e `storage-budget` eseguiti anche sui moduli composti, uber compreso.
- **Documentazione:** skill `new-primitive`, agent `wgsl-validator` e `webgpu-pass-reviewer`, CLAUDE.md, PROJECT_ARCHITECTURE.md, e il rischio "nessun preprocessore WGSL" nel masterplan, che risulta risolto.
- **Rischi da misurare:**
  - registri dell'uber e tempo del forward trasparente;
  - direttiva su Firefox;
  - il nuovo ordine dei trasparenti cambia i check pixel che contavano sui box shadow disegnati per ultimi.

## Sezione 2 — APPROVATA ("si ok", seconda sessione)

Correzioni rispetto al candidato: problemi 1, 2, 5, 9 e 14 risolti; gli innesti rischiosi sono rimandati.

- **Chiave.** Due parole per elemento: `lo = id esterno` (20 bit usati) e `hi = zKey`. `zKey` si ricava dai bit di `entity-bounds.z`, la z di mondo: -0 diventa +0 con un confronto intero, poi si ribalta il segno.
  - Ordine crescente per (z, id): dal fondo al davanti. A parità di z l'id più alto viene disegnato dopo, cioè davanti.
  - 7 passate LSD da 8 bit: le passate 0-2 sui byte dell'id, le 3-6 sui byte della z.
  - Chiavi in SoA in un buffer per lato del ping-pong: `lo[CAP]` poi `hi[CAP]`. Ogni passata legge solo la parola della sua cifra.
  - Non usare la colonna `gpu_depths`: per il 2D contiene +depth senza la composizione del genitore, per il 3D la z locale.
- **Kernel, 22 dispatch per frame.**
  - **gather**: dispatch diretto, `ceil(B/256)`, con `B = min(transparentCount ?? entityCount, CAP)`.
    - Legge i 12 conteggi (parola `b*5+1`) e le basi (`firstInstance`, parola `b*5+4`) dei bucket 14..25 da `indirect-args`. Niente 100_000 cablato.
    - Compatta in ordine di regione.
    - Il thread 0 del gruppo 0 scrive l'header `transparent-args`: draw `{6, n, 0, 0, 0}` alle parole 0-4, dispatch `{ceil(n/1024), 1, 1}` alle parole 5-7, conteggio grezzo, limite, overflow.
  - **upsweep ×7**: indiretto dall'header, istogramma a 256 cifre per tile da 1024.
  - **scan ×7**: 1 workgroup; scan per colonna sui tile, poi scan dei 256 totali. `digitBase` è tenuto per passata.
  - **scatter ×7**: indiretto. Ranking stabile nel tile: maschere da 256 bit per cifra + popcount + cursore, 4 round da 256, 13 barriere.
    - **L'ultima passata scrive solo gli slot, in OGNI build.** Niente override `WRITE_KEYS`: dev e produzione eseguono lo stesso codice.
- **Perché upsweep e scatter indiretti.** Il costo segue gli `n` VISIBILI, non `B`, e nessun gruppo resta vuoto.
  - `transparentCount` dimensiona solo il gather e, a 0, salta tutto. È una deviazione accettata dalla sezione 1.
  - Fatti verificati su Chrome 154:
    - `storage, read` + INDIRECT sullo stesso buffer nello stesso dispatch è valido;
    - `{0,1,1}` indiretto è silenzioso, mentre `dispatchWorkgroups(0)` diretto dà un warning di Dawn;
    - un X indiretto > 65535 viene saltato in silenzio (qui `numTiles` ≤ 98);
    - una guardia su `workgroup_id` contro un `n` letto da binding read-only è valida prima delle barriere, una su `global_id` NO;
    - un loop con trip count non uniforme e senza barriere dentro è seguito da flusso uniforme.
- **Uniform.**
  - 7 slice `PassParams` da 256 B, scritte una volta nel `setup()`. Il bind group di ogni passata fissa la sua slice e la direzione A→B / B→A.
  - Per frame, in `prepare()`, si scrivono solo `{limit}` più i reset dell'header e dei diag. `execute()` non chiama `writeBuffer`.
- **Buffer.**
  - Fissi a `CAP = 100k`, con UNA costante esportata al posto delle tre copie di 100_000 (`renderer.ts:56`, `cull-pass.ts:215`, `cull-pass.ts:223`). Circa 2,5 MB in totale.
  - `minBindingSize` su ogni voce.
  - Storage per stadio: gather 7, sort 6 (limite 8).
  - 8 bind group (1 per il gather + 7 per il sort).
  - Nessun binding `read_write` e `read` sullo stesso buffer nello stesso dispatch.
- **Encoding.**
  - Senza profiler, un solo compute pass: i dispatch sono ordinati e visibili tra loro.
  - Con il profiler, un compute pass per stadio, 22 marker e 4 nomi sommati (`gather`/`upsweep`/`scan`/`scatter`). Con `transparentCount == 0`, `profileStages` restituisce `[]` e non si codifica nulla.
- **Costo stimato** 0,3-0,7 ms a 100k sull'iGPU, da misurare.
- **Fuori dalla v1** (follow-up solo dopo le misure, con i vincoli del problema 13):
  - salto delle passate banali;
  - upsweep fuso, che richiede una tabella dei tile doppia;
  - passata 0 fusa nel gather;
  - istogrammi privatizzati per lane;
  - tile più grandi.
- **Scartati:**
  - onesweep / decoupled look-back: nessuna garanzia di forward progress in WebGPU;
  - scan del last-workgroup: WGSL non ha un fence di device;
  - ranking con i subgroup: problema dei 32 lane su questa iGPU (32-64);
  - bitonic.

## Perché

La review del passo 5 (`wf_60bf12aa-fa0`) ha trovato che la depth non ordina due sprite `.transparent()` sovrapposti. La pipeline trasparente non scrive la depth, e niente ordina: `RadixSortPass` esiste ma è morto nel grafo, e comunque è rotto. Così l'ordine tra trasparenti è quello di disegno: prima il tipo di primitiva, con i box shadow per ultimi, poi l'ordine del cull, che non è definito. Quasi ogni sprite 2D con alfa è trasparente (PNG, ombre), quindi il buco è concreto.

## Decisioni dell'utente (2026-09-27)

1. **Approccio: GPU sort + uber pipeline**, una fase a sé. Si pianifica in questa sessione e si esegue nella prossima.
2. **A parità di z** vince la più recente, per id: l'id esterno più alto sta davanti.
3. **Scala: fino a ~100k trasparenti visibili per frame, sotto 1 ms di GPU sull'iGPU AMD.** Serve quindi un radix sort STABILE sulla GPU; bitonic è escluso.
4. **Modulo uber: preludio + librerie per primitiva.** I sei file diventano librerie con funzioni prefissate (quad_vs, line_shade…) e senza duplicati. Un `prelude.wgsl` comune porta i binding, `CameraUniform`, un `VertexOutput` che li copre tutti, `castsInto` e l'illuminazione. Un compositore TS ricava dagli stessi pezzi i moduli per tipo (opachi e occluder, con comportamento invariato) e il modulo uber.
5. **Id sulla GPU: una colonna `entity-ids` separata.** La parola 0 di `renderMeta` resta al `MeshHandle`, perché **arriveranno le mesh 3D** (l'utente l'ha chiesto esplicitamente).
6. **Upload della colonna id: tutta, ma solo quando cambia.** Rust espone un flag "mappatura slot→id cambiata in questo frame", che scatta su spawn, despawn con swap-remove e compact. Scatter e staging non si toccano.

## Sezione 1 del design — APPROVATA ("si ok")

Quattro pezzi, in quest'ordine, ognuno verificabile da solo:
1. **Composizione degli shader, senza cambi di comportamento.** Preludio + librerie; il compositore produce i moduli per tipo (stessi entry point `vs_main`/`fs_main`/`fs_occluder`, pixel identici) e il modulo uber: `vs_main`/`fs_main` con uno `switch` sul tipo letto da `renderMeta`, più `diagnostic(off, derivative_uniformity)`. È sicuro, perché i frammenti di un quad 2×2 appartengono allo stesso triangolo, quindi alla stessa istanza.
2. **Colonna id + conteggio dei trasparenti.** Rust espone `entity-ids` con il flag di cambio, e il numero di entità trasparenti. Quel numero è il limite superiore dei dispatch, e a 0 salta l'intero percorso trasparente a costo zero.
3. **Gather + sort**, in un nuovo pass del grafo `TransparentSortPass` dopo il cull, che **non si tocca**. Il gather legge i 12 bucket trasparenti (tipi 0-5, **Light2D escluso**, slot 26/27). Poi un radix sort LSD stabile su una chiave a 64 bit: `zKey(z di mondo)` nella parte alta, `id` nella bassa, 7 passate da 8 bit. Infine scrive gli argomenti del draw unico.
4. **Draw unico.** In `ForwardPass` il sub-pass trasparente (oggi 6 pipeline × 2 bucket) diventa **una** pipeline uber e **un** `drawIndexedIndirect`, con il gruppo 0 che al binding 2 ha il buffer ordinato al posto di `visible-indices`. Il codice dei vertex shader non cambia (`visibleIndices[instanceIdx]`).

Non cambiano: le pipeline opache, l'occluder, `LightAccumStage` (legge ancora i bucket 26/27), la selezione, i 28 bucket del cull.

## Sezione 2 (il sort) — design candidato, DA PRESENTARE all'utente

Workflow `wf_537ea535-af9`: tre designer indipendenti (banda, semplicità, verificabilità), due giudici, due scettici (correttezza, WebGPU). Punteggi pesati: {'verifiability': 83.5, 'simplicity': 81.5, 'bandwidth': 68.5}. Ha vinto **verifiability**.

**Riassunto (dal JSON, in inglese):** TransparentSortPass runs as four kernels in two WGSL modules. A deterministic GATHER compacts cull regions 14..25 in region-major order into (key, slot) pairs in buffer A. From the same kernel it also writes the draw args and a sort-state header: n = min(raw, limit), overflow flag, tile count. A classic reduce-then-scan LSD radix sort follows: 7 passes of 8-bit digits over the 52-bit key (zKey<<20 | id). Each pass is 3 dispatches: UPSWEEP (per-tile 256-bin histogram in workgroup atomics), SCAN (a single workgroup does a column-wise exclusive scan over tiles, then a 256-entry scan of the digit totals; the dispatch boundary is the only global barrier, so no workgroup waits on another), and SCATTER (stable in-tile ranking without subgroups). The ranking handles a tile of 1024 as 4 ordered rounds of 256. Within a round each element's rank is the popcount of lower-thread bits in a per-digit 256-bit mask in workgroup memory, and a per-digit cursor carries the offset from one round to the next. So each element lands exactly at its textbook stable counting-sort position. All keys are unique because ids are unique, so the correct output is one exact permutation: it is identical every frame and can be compared bit for bit with a JS sort. Per-pass parameters are constant 256-byte uniform slices written once at setup, one bind group per pass. The only per-frame writes are one 16-byte GatherParams and the state/diag reset, both in prepare(). Every buffer is fixed-size at MAX_ENTITIES, so capacity overflow cannot happen by construction. The only reachable over-count is a wrong CPU bound: it is clamped, flagged in the state header, and checked every frame in dev. A CPU model runs each kernel in barrier phases with shuffled thread and workgroup order and a workgroup-memory race checker. It mirrors every GPU buffer word for word, and a dev per-stage readback compares each kernel's GPU output with it. Estimated cost at 100k: about 0.35-0.8 ms on the iGPU.

- Cifre: 8 bit, 7 passate, tile di 1024 elementi.
- Dispatch per frame a 100k: 22.
- **Banda a 100k:** N = 100,000; per-element traffic. GATHER: reads visible-indices 4 B + entity-bounds 16 B (a vec4 line share; slots within a cull region arrive roughly ascending) + entity-ids 4 B, writes keys 8 B + vals 4 B = 36 B, so 3.6 MB. Pessimistic, with fully random slots costing a 64 B line each for bounds and ids: 4+64+64+12 = 144 B, so 14.4 MB. PER RADIX PASS: upsweep reads keys 8 B (only one word is used, but the vec2 line comes along); scatter reads keys 8 + vals 4 and writes keys 8 + vals 4. That is 32 B x 1e5 = 3.2 MB, plus the tile table (98 x 256 x 4 = 100 KB) written by upsweep, read+written by scan and read by scatter, about 0.4 MB, for 3.6 MB per pass. x 7 passes = 25.2 MB. TOTAL: about 28.8 MB typical, 39.6 MB pessimistic. At 60 GB/s: 0.48 ms (0.66 ms pessimistic); at 100 GB/s: 0.29 ms (0.40 ms). Fixed costs: 22 dependent dispatches x ~2-5 us of pipeline drain = 0.04-0.11 ms. The single-workgroup scan chain (13 chunks of L2 loads) is about 5 us x 7 = 0.035 ms. Scatter compute (13 barriers + 8 LDS loads + popcounts per round, 98 workgroups on 12 CUs, about 1-2 waves of residency at 9 KB LDS each) is about 5-8 us per pass, largely overlapped with its memory traffic. Estimate: about 0.35-0.8 ms < 1 ms. It is pessimistic in one respect: each pass's working set (1.2 MB in + 1.2 MB out + 0.1 MB table) mostly stays in the iGPU's L2, and upsweep then scatter re-read the same keys, so the real DRAM traffic is lower. Scattered writes form per-digit runs (in-tile runs are adjacent to the neighbouring tiles' runs of the same digit), which combine in L2. The number must be confirmed with the staged profiler (transparent-sort/gather|upsweep|scan|scatter) on the AMD iGPU at 100k. If scatter dominates, the first optimisation is to fuse upsweep p+1 into scatter p through global atomicAdd on tiles[dst/1024][digit_{p+1}] (commutative, so still deterministic). That saves 0.8 MB and one dispatch per pass.

### Kernel
- **gather (ts/src/shaders/transparent-gather.wgsl, entry gather_main)** — workgroup 256, 7 storage buffer, 48 B di memoria di workgroup. Dispatch: ceil(L / 256) workgroups, 1-D, computed on the CPU from L = min(transparentCount, MAX_ENTITIES=100000); 391 at L=100k. Not dispatched at all when L == 0.
- **upsweep (ts/src/shaders/transparent-sort.wgsl, entry upsweep_main)** — workgroup 256, 6 storage buffer, 1024 B di memoria di workgroup. Dispatch: ceil(L / 1024) workgroups (98 at 100k), one per tile, CPU-computed. Tiles with t*1024 >= n return at once. 7 dispatches per frame, one per radix pass, each with bind group p.
- **scan (transparent-sort.wgsl, entry scan_main)** — workgroup 256, 6 storage buffer, 1024 B di memoria di workgroup. Dispatch: 1 workgroup per radix pass (7 per frame), with bind group p. Its dispatch boundary is the global barrier between upsweep and scatter, so it relies on no cross-workgroup forward progress.
- **scatter (transparent-sort.wgsl, entry scatter_main)** — workgroup 256, 6 storage buffer, 9216 B di memoria di workgroup. Dispatch: ceil(L / 1024) workgroups (98 at 100k), one per tile, CPU-computed; tiles with t*1024 >= n return. 7 dispatches per frame with bind group p (p even: A to B, p odd: B to A; pass 6 ends in B = 'transparent-order').

Dettagli completi di ogni kernel (binding, algoritmo con le barriere, buffer, uniform, gestione del conteggio, modello CPU, rischi) nel JSON: `winner.kernels`, `winner.buffers`, `winner.uniformHandling`, `winner.countHandling`, `winner.cpuReference`, `winner.risks`.

### Innesti suggeriti dai giudici (da valutare prima della spec)
- From bandwidth: SoA key words inside ONE buffer per ping-pong side (lo[CAP] then hi[CAP], at offsets) instead of array<vec2u>. The upsweep then reads only the 4 B word its digit lives in (about -0.4 MB per pass), and the binding count stays at 6: splitting into separate lo/hi bindings would reach the 8-storage limit.
- From bandwidth: lane-privatized upsweep histograms (8 copies selected by lid & 7, 8 KB). With all z equal, passes 3..6 otherwise make 1024-way serialized LDS atomicAdd on a single bin per tile, and that case is the common 2D one.
- From bandwidth: the final pass writes only slots into transparent-order. Keys are written in pass 6 only in dev/readback builds, selected by an override constant (for example WRITE_KEYS), which saves about 0.8 MB at 100k. Keep keys-b for the per-stage readback in dev.
- From bandwidth: have the gather record per-digit min/max (atomicMax of d and of MASK^d into the state header, which clearBuffer or writeBuffer zeroes). Expose it in the dev readback so the digitBase checks can also assert which passes were trivial. Skip trivial passes only as a measured later optimization, not in v1.
- From bandwidth: set minBindingSize on EVERY storage layout entry (state 64, hist 7236, key/val sizes), not only on the uniforms, so a size mismatch fails at bind-group creation instead of at dispatch time.
- From bandwidth, as a documented fallback if the profiler shows dispatch overhead dominating: fold the scan into the scatter with redundant per-workgroup row sums (bounded because the tile count is capped). That removes 7 dispatches without any cross-workgroup dependency.
- From simplicity: send the per-frame uniform data (GatherParams, plus the args/diag reset if it is kept as writeBuffer) in as few writes as possible, and pin in a mock-device test that execute() issues no writeBuffer. Keep the explicit rejected-alternatives list: a last-workgroup scan needs a device-scope fence WGSL lacks, onesweep needs forward progress, and the in-tile bitonic/1-bit split needs 36-128 barriers.
- From simplicity: the test that non-empty Light2D regions 26/27 (and the opaque 0..13) are excluded, with populated inputs rather than merely unread slots, plus the LSD-invariant check after every pass.
- Fix in the winner: the '22 bind groups' text should read 8 (1 gather + 7 sort). Validate the uniformity of the read-only-storage early exit (getCompilationInfo plus an error-scoped createComputePipeline on the AMD adapter) before writing the rest; otherwise switch to lid0 -> workgroup var -> workgroupUniformLoad from the start.
- From bandwidth: store the key as SoA words (zKey-hi and lo/id in separate arrays) so each upsweep reads only the 4-byte word its digit lives in. That saves about 0.4 MB per pass at 100k.
- From bandwidth: the final radix pass writes only the slots to transparent-order. Writing keys-b becomes dev-only, behind the readback, which saves about 0.8 MB per frame.
- From bandwidth: privatize the upsweep histogram per lane, with 8 copies selected by lid & 7 (8 KB). With skewed digits (all z = 0, a pass-6 digit of at most 16 values) at most 4-8 lanes then contend per wave instead of 32-64.
- From bandwidth: as a measured follow-up, skip trivial digits. atomicMax of d and of MASK^d is taken in gather and upsweep, and a constant digit is an identity pass. In the common 2D case (z = 0) that removes the 4 z passes. It needs the GPU-side parity or lastNT emit, so it should come only after the profiler justifies it. A cheaper first step, from simplicity: skip the id-high pass using a CPU-known id high-water mark, with a fixed output buffer so the parity never moves.
- From bandwidth: fuse pass 0 into the gather (a histogram half, then a scatter half), so the unsorted list is never written and one full read and write of the keys is saved.
- From bandwidth: evaluate larger tiles (2048/4096 as 8/16 rounds of 256). Per-digit runs get longer and fewer partial write lines stay live at once (tiles x 256 against the 2 MB L2), which reduces write amplification in the scatter. Measure it with the transparent-sort/scatter stage.
- From bandwidth: set minBindingSize on EVERY layout entry (state 64, hist 7236, key and value arrays at full size), and keep workgroupUniformLoad of n as the documented fallback if Tint or the AMD path rejects the guard that relies on read-only storage being uniform.
- From simplicity: one constants module (TILE, ROUNDS, RADIX, PASS_TABLE, FIRST_TRANSPARENT_ARG = 14, GATHER_REGIONS = 12), imported by TransparentSortPass, the CPU model and the WGSL text-agreement tests. Also keep the rule that every barrier-separated WGSL phase is one lane loop in TypeScript.
- From simplicity: keep resetting the draw args in prepare() every frame AND have ForwardPass skip the draw on transparentCount == 0, belt and braces against replaying stale indirect args (bandwidth's T == 0 path lacks this).
- Fix verifiability's doc slip: there are 8 bind groups (1 gather + 7 sort), not 22.

### Problemi trovati dagli scettici (14): da risolvere nella spec
Titoli e correzioni in inglese, come nel JSON:
1. **[important]** WRITE_KEYS override gates every scatter pass, not just the last, and production runs a variant no check ever exercises
   - *Correzione proposta:* Make pass 6 skip its key writes in every build, so dev and production run the same code. Either gate it as `if (params.passIndex != LAST_PASS) { keysOut[dst] = key }` (passIndex is already in the uniform), or give pass 6 its own scatter pipeline. The readback then derives the final keys on the CPU from order[], the captured bounds and the captured ids. If a dev/prod split is kept anyway, run the headless oracle tests on the CPU model in BOTH configurations, and add a mock-device test that the production pipeline set is the one the model covers.
2. **[important]** The "skip the id-high pass" graft is wrong with the chosen key packing, and skipping any pass breaks the baked A/B bind groups
   - *Correzione proposta:* Repack the key as hi = zKey (the whole word) and lo = id (20 bits). That is still 7 passes (lo: 8, 8 and 4 bits; hi: 4 × 8), with digit(k, p) = p < 3 ? (lo >> 8p) & 0xFF : (hi >> 8(p-3)) & 0xFF. Pass 2 is then purely id bits 16..19 and can be skipped when the id high-water mark is < 2^16, and the z digits become byte-aligned for the trivial-digit skip. Any pass skipping needs bind groups for both directions (14, indexed by (pass, parity)), chosen on the CPU from the number of passes actually run. The last pass run must write transparent-order, and a CPU-model test must pin the skipped configurations against the oracle.
3. **[important]** Fused upsweep (atomicAdd into tiles from scatter p) races with scatter p's own reads of the single shared tile table
   - *Correzione proposta:* If the fusion is ever done, double-buffer the tile table: tilesRead for pass p, tilesAccum (atomic) for p+1, cleared with encoder.clearBuffer before each scatter dispatch. Swap the roles per pass through the per-pass bind groups (hist grows by 98×256 u32, and the binding count is unchanged if both live in sort-hist at fixed offsets). Add a per-dispatch global-memory conflict checker to the CPU model: an address written, atomically or not, by one workgroup and read non-atomically by another in the same dispatch must throw.
4. **[minor]** Per-digit min/max graft does not fit the 7 reserved header words and races with the gather's non-atomic header write
   - *Correzione proposta:* Put the 14 atomic maxima in hist.diag[1..14]: diag has 16 atomic words, is already zeroed in prepare(), and is already in the dev ring's 64-B copy. Keep the lane-0 header write to words 0..8 only, and pin that in a text test.
5. **[minor]** The CPU bound is the only source of truth for coverage: a zero or undefined transparentCount drops every transparent entity, even in dev
   - *Correzione proposta:* Bound the gather dispatch and GatherParams.limit by min(entityCount, MAX_ENTITIES), which is always a true bound. Have the gather write {numTiles, 1, 1} into transparent-args (for example words 9-11, a 4-byte-aligned offset of 36; the buffer already has INDIRECT) and use dispatchWorkgroupsIndirect for upsweep and scatter. Their size then follows n, not the CPU bound. Keep transparentCount only as the zero-skip, normalise it with `?? entityCount`, and in dev assert it on the CPU against the count of renderMeta bit 8 with type < 6 in state.renderMeta (the full array is on the CPU in every mode).
6. **[minor]** 'Capacity cannot be exceeded by construction' relies on entityCount <= 100000, which nothing enforces
   - *Correzione proposta:* Enforce the cap at the source: reject maxEntities > MAX_ENTITIES in resolveConfig, count RawAPI spawns against the limit, or clamp entityCount to MAX_ENTITIES in renderer.render with a one-time warning. Also add a GPU guard in the gather: if slot >= regionSize, drop the entry and atomicOr a diag bit. Then say in the design which of these makes the sort's input well-formed.
7. **[important]** The dev readback copies inputs from three buffers that have no COPY_SRC usage
   - *Correzione proposta:* In renderer.ts add `(dev ? GPUBufferUsage.COPY_SRC : 0)` to entity-bounds, visible-indices and indirect-args, the same way entity-transforms has it. Add a test that builds the renderer's buffer descriptors with __DEV__ true and asserts COPY_SRC on every buffer the readback copies from. Also wrap the readback submit in validation and out-of-memory error scopes, as DebugProbe does, so a missing usage rejects the promise instead of answering zeros.
8. **[important]** If ForwardPass does not read the sort outputs, the sort pass is culled or ordered by accident
   - *Correzione proposta:* Make ForwardPass (lit and unlit) declare `reads` of 'transparent-order' and 'transparent-args', and keep TransparentSortPass optional so graph liveness follows from that read. Add a compose test in graph-assembly: for each of the 3 composites with lighting on and off, 'transparent-sort' must be in compile() output after 'cull' and before 'forward'.
9. **[important]** transparentCount is not carried in Mode B, and a missing value makes dispatchWorkgroups throw inside render()
   - *Correzione proposta:* Add transparentCount at all four sites plus GPURenderState/FrameState, and test each bridge's state for it. In the pass, compute `const bound = Number.isFinite(frame.transparentCount) ? frame.transparentCount >>> 0 : frame.entityCount; L = Math.min(bound, MAX_ENTITIES)`. entityCount is always a valid upper bound, so a missing field costs time, never entities or a throw. Use the same L in prepare, profileStages and execute.
10. **[important]** Derivatives inside the uber shader's per-instance type switch fail WGSL derivative uniformity
   - *Correzione proposta:* Either add `diagnostic(off, derivative_uniformity)` on the uber fs entry or on the switch, with a comment giving the reason: the type is flat per instance and a 2x2 quad never spans two triangles, so the branch is quad-uniform. Or hoist every derivative before the switch: fwidth(uv.y), dpdx/dpdy(uv), and fwidth of the bezier distance, which means computing sdBezier unconditionally. Validate with getCompilationInfo on the AMD adapter before building the rest, and add a text test that no derivative call sits inside the type switch unless the diagnostic is present.
11. **[important]** The 3-deep dev MAP_READ ring copied every frame has no skip rule, so a busy ring invalidates whole frames
   - *Correzione proposta:* Take a ring slot only when its state is 'unmapped' (track it: set pending before mapAsync, clear it after unmap). Otherwise skip the copy for that frame and count the skips. Add a mock-device test in which all three slots stay pending: execute() must encode no copy into them.
12. **[minor]** The final-only sort-hist readback cannot pinpoint whether upsweep or scan diverged
   - *Correzione proposta:* With {stages:true}, copy sort-hist, or only the first ceil(n/1024)*256 tile words plus digitBase, after each upsweep and after each scan: 14 copies of at most 107 KB. The compute pass is already ended after every dispatch (22 compute passes). Compare them with cpuUpsweep and cpuScan outputs word for word.
13. **[minor]** The listed follow-up optimisations hide WebGPU hazards: a shared tile table, atomics in read-only state, indirect args and the 8-binding limit
   - *Correzione proposta:* Record these constraints next to the follow-ups. (a) Keep two fixed-size tile tables inside SortHist (capacity is fixed), declare the accumulating one as array<atomic<u32>>, zero it in scan p, and read the other one. (b) Put the min/max atomics in sort-hist, keep state as var<storage, read> in transparent-sort.wgsl with its own atomic-free struct declaration, and have indirect-dispatch args written only by the gather into a buffer the sort dispatches bind read-only, such as an extended transparent-args. (c) Add the fused gather to the text test that counts storage bindings per layout, with a hard <= 8 assertion.
14. **[minor]** No radix pass is id-only, so skipping the 'id-high' pass by an id high-water mark mis-sorts
   - *Correzione proposta:* Widen the id field to 24 bits: key = (zKey << 24) | id (56 bits, still 7 passes of 8), with lo = (zKey << 24) | id and hi = zKey >> 8. Passes 0-2 are then id-only and passes 3-6 z-only, so both 'skip the id-high pass' and 'skip the 4 z passes when z is constant' become byte-exact. Update the digit() helper, the CPU model and the text-agreement test together.

Nota: diversi problemi riguardano gli *innesti* (salto delle passate banali, upsweep fuso, WRITE_KEYS), non il design di base. Alcuni vanno oltre il sort e toccano le sezioni successive:
- la derivative uniformity nello switch dell'uber (sezione 3);
- `transparentCount` in Mode B (sezione 4);
- il `COPY_SRC` per la readback dev e l'ordine nel grafo tramite i reads di `ForwardPass` (sezione 5).

## Da fare alla ripresa (nella prossima sessione)

1. Presentare all'utente la **sezione 2** (sort): il design vincitore già corretto dei problemi importanti e con gli innesti accettati. Prendere la sua approvazione.
2. Presentare le sezioni rimanenti, una alla volta, con approvazione dopo ciascuna:
   - **3. Composizione degli shader**:
     - struttura dei file (`shaders/primitives/prelude.wgsl` + 6 librerie);
     - API del compositore;
     - moduli per tipo contro modulo uber;
     - `diagnostic(off, derivative_uniformity)`;
     - slot HMR e probe;
     - riscrittura dei ~40 test che leggono il testo WGSL (`forward-pass.test.ts`, `occluder-seed-stage.test.ts`, `light-groups.test.ts`, `uniform-layout`, `storage-budget`);
     - aggiornamento della skill `new-primitive` e degli agent `wgsl-validator`/`webgpu-pass-reviewer`.
   - **4. Colonna id + conteggio dei trasparenti**:
     - esportazioni Rust (flag di cambio mappatura, `transparentCount`);
     - trasporto in Mode A/B/C (`GPURenderState`, worker);
     - upload in TS; buffer `entity-ids` nel ResourcePool.
   - **5. Integrazione nel grafo e casi limite**:
     - reads/writes di `TransparentSortPass` e di `ForwardPass`, perché il pass non venga culled o ordinato per caso;
     - count 0 e overflow; Mode A;
     - stadi del profiler (`gather`, `sort`);
     - readback dev per `engine.debug`.
   - **6. Test e verifica**:
     - modello CPU identico al GPU;
     - test del testo WGSL;
     - check GPU nel tab 2D Twins: trasparenti di tipi diversi nell'ordine di z, pareggio per id, stabilità;
     - pixel identici per gli opachi;
     - misure a 1k/10k/100k con il profiler, soglia < 1 ms a 100k.
3. Scrivere la spec (`docs/superpowers/specs/` o `docs/plans/`, seguendo la convenzione del repo `docs/plans/AAAA-MM-GG-…-design.md`), fare l'autorevisione e farla rivedere all'utente.
4. Invocare **writing-plans** per il piano di implementazione. L'utente sceglie il metodo di esecuzione, poi si esegue.
5. Dopo la fase: riprendere il giro dal passo 6 (ombre direzionali), poi 7, 8, 8b, 9 e 10 del piano `2026-09-27-open-items-round-plan.md`.
