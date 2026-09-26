# Brief decisionale: cull pipeline, temporal culling, firstInstance

HEAD `109e36e` (branch `feat/phase17-lighting-2d`), 2026-09-26. Prodotto dal workflow `cull-options-deep-dive`: 6 investigatori, di cui uno che misura su una RTX 4060 reale, e 3 verificatori avversariali. Analisi read-only: nessun file tracciato è stato modificato. Nel testo **[V]** indica un fatto verificato (codice, spec o GPU), **[I]** un'inferenza, **[W]** una claim indebolita da un verificatore, **[R]** una claim confutata.

---

## 1. TL;DR

- **Il Problema 1 si risolve senza decidere nulla sul temporal culling.** Il binding `transforms` (`cull.wgsl:50`) è dichiarato ma non viene mai letto, in tutte le 11 revisioni da `234df5f` in poi **[V]**. Il limite conta le entry del layout, non l'uso che ne fa lo shader (spec `index.bs:6245-6300`), quindi toglierlo porta la pipeline da 9 a 8. Un verificatore lo ha provato sull'RTX 4060 con un device a limite 8: `popErrorScope` restituisce null sia col path subgroup sia con quello strippato **[V]**. Il menu R / C+inv / A+inv era quindi una falsa dicotomia.
- **Il Problema 1 è più grave di quanto pensassimo.** Dal commit `b4db737` ogni `request()` di grafo include una `new CullPass()` (`renderer.ts:417`) e viene rifiutata dalla validazione GPU (`graph-host.ts:143-160`). Di conseguenza `enableBloom()`, `enableOutlines()` e gli hot-reload di shader vengono tutti rifiutati in silenzio. Va live solo il grafo iniziale, e i suoi errori vengono solo loggati (`graph-host.ts:110-117`) **[V]**.
- **Problema 3 confermato sull'hardware da due verifiche indipendenti.** Senza la feature `'indirect-first-instance'`, un draw indiretto con `firstInstance ≠ 0` non disegna nulla e non produce nessun errore di validazione. Il probe dà px `[0,0,0,0]` con error scope null, contro `[5,0,0,255]` quando la feature è abilitata **[V]**. Appena si sistema il Problema 1, in Chrome e in Firefox disegna **solo il bucket 0**, cioè i quad opachi tier-0 o non texturizzati **[I, forte]**.
- **Il Problema 3 è indipendente da Q1, ma condiziona ogni verifica visiva.** Blocca anche la Phase 17 Track B (OccluderSeedPass itera tutti i bucket opachi, `plan.md:199-205`), non solo Track C.
- **Temporal culling: il beneficio misurato è zero.** A parità di visibilità (100%), saltare tutte le letture di bounds costa quanto non saltarle: 42 contro 43 µs a 100k, 336.9 contro 336.9 µs a 1M, stesso risultato sul path non-subgroup **[V, 1 GPU NVIDIA]**. I costi misurati sono circa 19 µs di CPU per frame a 100k e +7 µs di GPU a 1M con tutto dirty **[V]**. Le stime basate sui byte (~6 µs di risparmio) sono **confutate**: il kernel gira a 76-95 GB/s su 256 di picco, quindi non è bandwidth-bound.
- **Il difetto del temporal culling produce solo overdraw, mai pixel mancanti** **[V]**, per dimostrazione strutturale, modello CPU e GPU. I dirty bits però arrivano alla GPU **solo in Mode C**. In Mode B (il default dell'harness) e in Mode A (il default di Chrome), un'entità vista una volta resta "visibile" fino al rebuild successivo del grafo, anche se si muove **[V]**.
- **Q2: rimuovere tutta la catena è solo una cancellazione, ed è reversibile.** Un trial in scratch è tornato verde; l'impatto sulle performance è trascurabile. Nessun consumer futuro dell'export compare nei piani **[V]**.
- **Bug collaterale reale, estraneo al temporal culling (TMP-10):** i figli di un corpo fisico non vengono mai marcati dirty. Sulla GPU restano congelati: nel probe ECS vale `ty=131.86`, SoA `ty=0`, quindi **pixel sbagliati in tutte le modalità** **[V]**.

---

## 2. Problema 3 (firstInstance): verdetto

**Verdetto: confermato.** Dal punto di vista della priorità viene **prima di qualunque verifica visiva** ed è **indipendente dalla scelta Q1**.

| Evidenza | Fonte | Stato |
|---|---|---|
| Spec: *"If the "indirect-first-instance" feature is not enabled and firstInstance is not zero the drawIndexedIndirect() call will be treated as a no-op"*; non è un errore di validazione | gpuweb ED 23-09-2026, `index.bs:13553-13555` | [V] |
| In Dawn, `fail()` azzera tutti i parametri se `!HasFeature(IndirectFirstInstance)`. Il controllo sta nel frontend, quindi vale su tutti i backend, ed esiste dal 2022 | `IndirectDrawValidationEncoder.cpp:171-177, 236-242, 578-583`; commit Dawn `1ee244b3d3` | [V] |
| Probe su RTX 4060 / Chrome 154 / Vulkan, riprodotto da due verificatori | GPU-2, skeptic-correctness, skeptic-evidence | [V] |
| Il repo non chiede mai la feature | `renderer.ts:137-146` | [V] |
| `firstInstance = i * 100_000` | `cull-pass.ts:380` | [V] |
| Draw coinvolti: 24 in ForwardPass e 2 in SelectionSeed; 25 su 26 hanno `firstInstance ≠ 0`. GPU-5 parlava di "28 bucket": sbagliato, il tipo 6 non ha pipeline | `forward-pass.ts:277-300`, `selection-seed-pass.ts:156-157` | [V] |
| Firefox (wgpu) produce anch'esso un no-op | `validate_draw.wgsl:67-83` | [V, da sorgente] |
| Safari lascia passare `baseInstance`: un test su Safari nasconderebbe il bug | `Device.mm:813`, condizionato da `:806-807` | **[W]** |
| Il rendering multi-tipo non è **mai** stato corretto in Chrome, in nessuna delle 3 finestre storiche (`092f86e` → `51faf0a` → `4ea6cb5` → oggi) | FI-13 | [V] per le prime due, [I] per la terza |
| Nessuno se n'è accorto perché 7 tab su 8 usano solo quad opachi non texturizzati (bucket 0) e i check del Primitives tab contano spawn, non pixel. Con grafo invalido e device perso l'harness ha riportato "5/6 passed" | FI-15, skeptic-correctness | [V] |
| La feature è quasi universale: 99.97% complessivo, 99.71% su Android | web3dsurvey | [non ri-verificato] |

**Opzioni di fix**

| Opzione | Diff | Portabilità | Note |
|---|---|---|---|
| **1. Chiedere la feature se l'adapter la espone**, poi controllare `device.features` (non l'adapter) e dare un warning forte se manca | ~3 righe | ~99.97% | Il retry in `renderer.ts:158` la conserva già: filtra solo subgroups e timestamp. Non cambia layout né shader |
| **2b. Dynamic offset su `visibleIndices`**, `firstInstance = 0` | ~40-60 righe | 100% | La stride delle regioni deve passare a **100032**: 400000 mod 256 = 128 **[V]**. Il valore 100000 compare in 3 punti (`renderer.ts:43/201`, `cull-pass.ts:335`, `:373`). Cambia il layout ForwardPass condiviso (6 shader, wgsl-validator check #1, skill new-primitive). È testabile headless (`REGION_BYTES % 256 === 0`) |
| 2c. Trucco con baseVertex | — | rischioso | Dawn documenta che su macOS Intel pre-Gen9 il baseVertex indiretto viene ignorato (`Toggles.cpp:895`). Sconsigliato |
| 2e. Immediates | — | **non verificato** | Lo stato di rilascio nei browser è ignoto |

---

## 3. Q1: matrice delle opzioni

Il binding `transforms` (T) è morto e toglierlo è ortogonale a tutto il resto. Le righe indicano quindi il conteggio "con T" quando applicabile.

| Opzione | Meccanismo | Correttezza | Portabilità | Costo/beneficio misurato | Diff | 10° binding futuro | Phase 17 |
|---|---|---|---|---|---|---|---|
| **T** (da sola) | Toglie `cull.wgsl:50`, `cull-pass.ts:211, :246` → 8 | Pipeline valida **[V live]**. Il temporal culling però gira per la prima volta con il leak del Problema 2 (solo overdraw) | Spec floor 8: ovunque | Nessun effetto a runtime | +3 righe, ~+20 di test | Fallisce ovunque, 0 slot liberi, visibile anche sulla macchina di sviluppo | Nessun binding in più (OPT-16) |
| **T + invalidate forzato** (interim) | T più `flags \|= 1` ogni frame in `prepare` | Visible set esatto in tutte le modalità | Ovunque | Tiene i costi di V0 (19 µs CPU a 100k) senza nessun beneficio | ~+4 | 0 slot | Nessuno |
| **R + T** | Toglie `@group(1)` e il branch di skip → **5** storage | Esatto: resta solo il frustum test | Ovunque | Beneficio perso: **0 µs misurati**. Costi eliminati: ~19 µs CPU a 100k, +7 µs GPU a 1M con tutto dirty, 1 `createBindGroup` per frame | −220 (solo TS), −430 (FULL). Trial verde | 3 slot liberi (RadixSort key producer +2 ci sta) | Coerente con il principio "no history" (`design:812-826`) |
| **C (+inv)** | Un solo buffer con due metà e bit di parità → 8 (7 con T) | Esatto solo con R1+R2 (sez. 4). Il test "halves swap" resta verde: **non testabile headless**. L'"8/8 frames" è **non verificabile**, patch perse | Ovunque | Come V0: beneficio 0. COST-14 per C è [W] | ~+160, +40 di wiring | 0 (1 con T) | Nessuno |
| **C3** | `[dirty \| visA \| visB]` in un buffer → 6 con T | Rischio di parità più rischio di offset delle regioni | Ovunque | Come V0 | ~+180 | 2 | Nessuno |
| **U2 + T (+inv)** | `dirty` e `prev` in uniform, ruoli fissi, `copyBufferToBuffer` e `clearBuffer` → **6** | Senza la classe di bug dello swap. Richiede comunque R1+R2+R3 (+R4) | Core fino a 524k entità, compat 131k (il cap reale è 100k) | Come V0: beneficio 0 | ~+80, +40 di wiring | 2 | Nessuno |
| U-dirty + T | Solo `dirty_bits` in uniform → 7 | Come sopra | Idem | Come V0 | ~+30 | 1 | Nessuno |
| M0 / D + T | Toglie `texIndices` da cull (bit in renderMeta word 0, oppure rinuncia allo split tier0) → 7 | Nessun impatto sulla correttezza del cull | Ovunque | Il valore dello split non è mai stato misurato | +40 / +15 | 1 | Nessuno |
| O12 merge SoA | Fonde le colonne renderMeta e texIndices | — | Ovunque | — | **300+**, tocca 6 shader forward | 1 | Rischio sul layout condiviso |
| O13 args in testa a indices | Un solo buffer STORAGE\|INDIRECT | — | Ovunque | — | ~+60, 4+ pass | 1 | Tocca i consumer di indirect-args |
| S (2 pipeline) | Pass temporale e pass di compattazione (4 + 5) | Con inv | Ovunque | Un dispatch in più | ~+100 | 3-4 | Nessuno |
| **A (+inv)** | `requiredLimits` = numero derivato dallo shader | Serve rifare il retry: oggi `renderer.ts:158-164` scarta i limiti e ricade su 8 in silenzio **[V]** | **No** su Chrome tier-0 e compat. Mac = 10 | Come V0 | ~+70 | **Nascosto** sull'RTX 4060 (16), rotto su tier-0 o al 11° binding su Mac | Nessuno |
| **B** | Chiedere il massimo dell'adapter | — | Come A. La spec lo sconsiglia (`index.bs:1612-1616`) | Come V0 | ~+5 | Nascosto fino a 16 (dev) o 10 (Mac) | Nessuno |
| A → fallback C/R | Variante scelta da `adapter.limits` | Due path | Ovunque | Come V0 | ~+200 | Dipende dal device. Il fallback non gira mai in locale: è la stessa classe di bug dell'outage subgroups | Nessuno |

La compat mode non distingue tra le opzioni: ForwardPass ha già 5 storage buffer nel vertex stage (compat ne ammette 0) e cull usa `@workgroup_size(256)` (compat ammette 128) **[V]**.

---

## 4. Correttezza del temporal culling, path per path

Regola: `visible = fullTest(bounds) OR (was_visible AND !dirty AND !invalidate)`, `cull.wgsl:92-111`. Il risultato è sempre un superset del frustum test **[V]**.

| Path | Verdetto | Tipo di errore | Dirty bit? |
|---|---|---|---|
| Pan della camera | Visibilità "appiccicosa" (modello: 10× dopo 900 frame) | overdraw | nessuna invalidazione cablata (`cull-pass.ts:59, :315` senza caller) |
| Zoom in / zoom out | In: 40× nel modello. Out: corretto | overdraw | n/a |
| Resize (shrink) | stale | overdraw | `CullPass.resize` è un no-op (`:401-403`) |
| Teleport | resta disegnata anche la vista vecchia | overdraw | n/a |
| Sequenza misurata su GPU A→B→C→D→E | V0 5135→7550→7550→8823→8823 contro V1 5135→4972→0→1273→0 | overdraw monotono | GPU-10 [V] |
| **Mode A e Mode B** | ogni slot visto una volta resta visibile fino al rebuild del grafo, **anche quando l'entità si muove** | overdraw | **mai consegnati** (`engine-worker.ts` non li invia, `render-worker.ts:106` è hard-coded a null). Il commit `4ea6cb5` diceva il contrario ed era falso |
| Mode C | corretto, salvo camera e modifiche solo di bounds | overdraw | solo bit transform |
| `SetBoundingRadius`, range di Light2D | stale se il raggio si riduce | overdraw (viola l'invariante del test V3) | **no**: si marcano solo bounds o meta (`command_processor.rs:908-919`, `:827-837`) |
| Swap-remove, respawn, snapshot_restore | Mode C corretto; A/B ereditano bit stale | overdraw | sì [V probe] |
| Frame a 0 tick (Mode C) | corretto | — | esattamente i bit del frame |
| ImmediateState patch | stale solo se l'entità era già visibile | overdraw | no (lato TS) |
| **Figlio di un corpo fisico (TMP-10)** | SoA congelata | **pixel sbagliati in ogni modalità, non dovuti al temporal culling** | no: pass 2 (`engine.rs:273`) gira prima del pass 3 (`:302`) |
| `computeInvalidationFlag` così com'è stato progettato | confronta frame consecutivi, quindi un pan fluido non scatta mai. Il "self-corrects" del design Phase 13 (`design:419`) è falso | — | TMP-6 [V] |

**Per tenerlo in modo esatto servono** (TMP):
- **R1:** invalidare quando cambia la view-projection. Conseguenza: skip spento in ogni frame in cui la camera si muove.
- **R2:** bit mancanti vanno trattati come invalidazione.
- **R3:** esportare l'unione transform\|bounds\|meta.
- **R4:** se il beneficio deve arrivare anche ad A/B, trasporto dei bit più numero di sequenza o OR-accumulation.

Nessuna delle proposte C+inv / A+inv originali includeva R2, R3 o R4.

---

## 5. Costo e beneficio dello skip: misure

Setup: RTX 4060 Laptop, Chrome 154, Vulkan, timestamp-query reale con quantizzazione di 1.024 µs. È una sola GPU, con working set caldo in L2. C'è un drift di circa 5 µs tra run diverse, quindi solo i confronti **dentro la stessa run** sono validi.

| N | Scenario | V1 (R) | V0 (HEAD / A / B) | Delta | Fonte |
|---|---|---|---|---|---|
| 10k | sg, 50% visibili, S1/S2/S3 | 13.3 µs | 13.3 µs | 0 | GPU-12 |
| 100k | sg, 50% visibili | 47.1 | 47.1 | 0 | GPU-12 |
| 1M | sg, 50%, S1 / S2 / S3 | 337.9 | 342.0 / 344.1 / 344.1 | **V0 più lento** dell'1.2-1.8% | GPU-12 |
| **100k** | **sg, 100% visibili, skip di tutti i bounds** | 42 | 43 | **0 (V0 non più veloce)** | skeptic-evidence (deconfuso) |
| **1M** | sg, 100%, skipAll / dirtyAll | 336.9 | 336.9 / 344.1 | 0 / +7 | idem |
| 100k / 1M | nosg, 100%, skipAll | 66.6 / 605.2 | 66.6 / 605.2 | 0 | idem |
| 100k / 1M | nosg, "S1max" contro V1 al 50% | 41.0 / 318.5 | 70.7 / 608.3 | ~1.7-1.9× **[W]**: dovuto al doppio delle entità visibili (overdraw dello stale), non alla logica temporale | GPU-13 |
| 10k / 100k / 1M | CPU host: 2 upload di zeri in `prepare()` | 0 | 3.1 / **19.4** / 125 µs | limite inferiore (esclude `createBindGroup`) | GPU-15 |
| 100k | wall-clock netto | 39.6 | 45.2 | +5.6, fuori dal pass timed, specifico del bench | GPU-14 [W] |

**Confutate [R]:**
- **COST-3** (risparmio "ideale" di 5.6-59 µs): misurato 0.
- **COST-5** (roofline: V1 a 12.5-16.6 µs a 100k): misurato 41-47 µs.
- **OPT-21** (~6 µs a 272 GB/s): misurato 0. Inoltre il picco della macchina di sviluppo è 256 GB/s, non 272.
- **Causa comune:** il kernel non è memory-bound.

**Indebolite [W]:**
- **COST-12:** il break-even al 22% di stale non ha più senso, perché col risparmio a zero ogni entità stale è una perdita pura.
- **COST-7:** il limite alto sul costo delle atomics è smentito su NVIDIA, dove le atomics risultano nascoste.

**Dove modello e misura divergono:**
- Il modello prevedeva V0 più veloce in S1; la misura dice pari o più lento.
- Il modello prevedeva V1 a 5-25 µs a 100k; misurato 41-47.
- Il modello diceva che il path subgroup è più veloce; in realtà al 50% di visibilità il path non-subgroup è **più veloce** (100k: 37-41 contro 42-47 µs), il che contraddice la claim di Phase 14a in CLAUDE.md.

**Non misurati:** iGPU 780M, cache fredda, ordine spaziale coerente, costo dell'overdraw nel forward pass. Quest'ultimo si potrà misurare solo dopo aver risolto P1 e P3.

---

## 6. Q2: perimetro della pulizia (se si sceglie R)

| | **FULL** (Rust + WASM + TS + GPU) | **Solo GPU/TS** |
|---|---|---|
| Rust | Toglie `exported_dirty_bits` (`render_state.rs:244/282/337/919/1037-1039/1111-1122/1148`), gli export `lib.rs:393-418`, 3 test unitari e l'assert a `:2516`. **Riscrive** V3 su `staging_indices`: è l'unica copertura end-to-end di velocity → staging (DIRTY-9) | invariato: resta una copia N/8 B per frame che nessuno legge, in tutte le modalità |
| TS/WGSL | identico nei due piani (cull.wgsl, cull-pass.ts, worker-bridge, render-worker:106, renderer:775, render-pass:13, 3 fixture) | identico |
| Test (trial DIRTY-10, **non ri-eseguito dai verificatori**) | lib 196/274/225/318 → 193/271/222/315; integration invariato (64) se V3 viene riscritto; vitest 1015 → 1006; cull-pass 44 → 35 | Rust invariato; vitest 1015 → 1006 |
| Diff | Rust +12/−208, TS/WGSL +21/−296 | solo TS/WGSL |
| Perf | differenza ≤ 2-4 µs CPU a 100k (COST-15): irrilevante | — |
| WASM | −245 B gzip (non ri-verificato) | 0 |
| Rischio | ordine: Rust e TS **nello stesso commit**. Con WASM nuovo e TS vecchio si ha un TypeError a ogni tick in Mode C, invisibile a tsc (`worker-bridge.ts:343` cast) | export morto con 0 caller; viola la regola 5 di protocol-sync-checker |
| API pubblica | nessun simbolo esportato da `index.ts`: nessuna rottura | idem |
| Reversibilità | `DirtyTracker` e `transforms_words()` restano. Riaggiungere l'export vuol dire ~60 righe Rust o un `git revert`. Ma un consumer corretto richiederebbe comunque una catena diversa (bit di unione, trasporto A/B, accumulo): quella attuale non è una base riusabile | massima, ma conserva codice che nessuno usa |

**Consumer futuri trovati nei piani: nessuno per il bitfield esportato** (DIRTY-14, confermato).
- Phase 17 riusa *"Upload parziale | DirtyTracker + ScatterPass"* (`design:417`), cioè il tracker e non l'export.
- *"Frustum culling delle luci sulla GPU | CullPass"* (`design:418`).
- *"Non usa accumulo temporale ... né history buffer"* (`design:826`).
- LightCullPass: *"Non progettare l'ottimizzazione prima di aver misurato"* (`design:565`).
- SpatialGrid incrementale: la fonte prevista è TS (`BackpressuredProducer`), e il grid non è nemmeno cablato.
- CRDT: lavora a livello di comando.
- Unico riferimento superstite: il masterplan (`:879`, `:1129`) elenca ancora il temporal culling come "Pianificato".

**Documenti da aggiornare** (FULL):
- CLAUDE.md alle righe :167, :449, :468 (sostituire con una riga storica P1-16 "snapshot prima del clear"), :469, :697, più i conteggi.
- Masterplan :879 e :1129.
- Design Phase 13 §6.

---

## 7. Cosa implica l'evidenza

**Problema 3: da fare subito, indipendentemente da Q1.**
- **Minimo:** opzione 1 (chiedere `'indirect-first-instance'` quando c'è, poi controllare `device.features`, warning forte se manca).
- **Se** vuoi un solo comportamento su Chrome, Firefox e Safari e un test headless → 2b come path unico (stride 100032, costante unificata nei 3 punti).
- **Se** vuoi il diff minimo → opzione 1, con 2b rimandata a quando comparirà un device senza la feature (~0.03%).
- **Condizione:** va fatto **prima** di qualunque screenshot di verifica. Altrimenti le primitive mancanti verranno attribuite erroneamente al fix del cull.

**Q1: raccomandazione R + T.**
- Motivazioni:
  - beneficio misurato zero;
  - costo misurato non nullo;
  - non ha mai girato su una GPU;
  - input disponibile solo in Mode C;
  - una correzione esatta lo spegne comunque a ogni movimento di camera;
  - lascia 3 slot liberi e nessun comportamento che dipenda dal device.
- **Se** vuoi prima una misura su iGPU o a cache fredda → applica **T + invalidate forzato** come interim (~4 righe, esatto in tutte le modalità) e decidi R dopo.
- **Se** decidi di tenerlo → **T + U2** con R1+R2+R3 (e R4 se deve servire in A/B), **non C**: C non raggiunge più slot liberi e ha una classe di bug che nessun test headless può coprire.
- **A e B sono sconsigliate in ogni caso:** spostano il fallimento su hardware diverso da quello di sviluppo, lo stesso schema dell'outage subgroups.

**Q2: raccomandazione FULL, con V3 riscritto** e Rust e TS nello stesso commit.
- **Se** hai un piano concreto per riattivare il temporal culling a breve → solo GPU/TS. Anche in quel caso la catena attuale andrebbe comunque riprogettata.
- Da verificare prima: che nessun progetto esterno (per esempio Lumière) chiami `engine_dirty_bits_*`.

**In ogni caso:**
- Test headless di "binding budget": un mock device che somma le entry BGL per stage, ≤ 8, per cull e scatter (scatter è già a 7).
- Correggere wgsl-validator check #4: dice 24/480, i valori attuali sono 28/560.
- Fix e regression test per TMP-10 (ordine dei pass in `mark_post_system_dirty`: physics prima di hierarchy), su un commit separato.

**Sequenza proposta:**
1. T (sblocca subito bloom, outlines e hot-reload).
2. P3, opzione 1.
3. R e pulizia FULL.
4. Test di budget e documentazione.
5. TMP-10.
6. Sessione GPU di verifica visiva.

---

## 8. Incognite residue e come chiuderle

| Incognita | Perché conta | Come chiuderla |
|---|---|---|
| Beneficio dello skip su iGPU (780M) o a cache fredda | È l'unico scenario in cui il temporal culling potrebbe servire | Bench deconfuso sul 780M, verificando prima che la subgroup size sia 32 (COST-19: `renderer.ts:276` è hard-coded) |
| Un frame del grafo non è mai stato osservato eseguire dopo `4ea6cb5` (OPT-20 [W]) | Conferma che P1 azzerava tutto il frame | Dopo T: screenshot in `?mode=B` |
| Problema 4 (OOM del primo device) ha ucciso il device **dell'engine**, non uno usa-e-getta, e il recovery non è intervenuto entro ~7 s | Rende inaffidabile qualunque sessione GPU sull'harness | Pianificare reload o device usa-e-getta; indagine a parte sul dual-GPU |
| Previsioni P3/P4 di FI (solo bucket 0 visibile, poi tutto visibile con la feature) | Validano il fix del Problema 3 sui pixel | Sessione GPU dopo T: Primitives tab senza feature, poi con feature |
| Costo dell'overdraw stale nel forward pass | Unico costo reale in frame time del Problema 2 | Misurabile solo dopo T e P3. Diventa inutile se si sceglie R |
| Conteggi del trial FULL (DIRTY-10/11) | Non ri-eseguiti dai verificatori | `scripts/preflight.sh --full` sul branch reale |
| Chiamanti esterni di `engine_dirty_bits_*` | Rischio di rottura fuori dal repo | Grep sui progetti che consumano il WASM |
| Limiti su Firefox, leniency effettiva di Safari (FI-10 [W], OPT-5 [W]) | Rilevante solo se si scelgono A/B o si testa su Safari | Probe `adapter.limits` e il probe FI su Firefox e Safari reali |
| Valore dello split tier0/altro in cull | Rilevante solo per M0/D | Bench A/B con e senza split |
| La quantizzazione del timestamp in CLAUDE.md e il commento `renderer.ts:143-145` (100 µs) sono smentiti su Linux/Vulkan (1.024 µs senza flag) | Protocollo di misura | Correggere il gotcha rendendolo per piattaforma |
| Claim di Phase 14a (subgroup più veloce) contraddetta al 50% di visibilità | Riguarda eventuali rework del cull | Bench sg contro nosg su più livelli di visibilità, fuori dallo scope attuale |

Il materiale grezzo (modelli, sorgenti dei bench, il trial del piano FULL) era nello scratchpad della sessione sotto `/tmp`, quindi non è conservato. I numeri riportati sopra vengono da lì. Per rifare una misura si riparte dal protocollo della sezione 5.

---

## Decisione (2026-09-26)

- **Q1:** R + T. Si toglie il binding morto `transforms` e si rimuove il temporal culling.
- **Q2:** pulizia FULL della catena dei dirty bit esportati. Rust e TS vanno nello stesso commit.
- **Problema 3:** opzione 1. Si chiede `'indirect-first-instance'` quando l'adapter la espone, poi si controlla `device.features` e si emette un warning se manca.
- **Sequenza:** T → P3 → R + FULL → test di budget e documentazione → TMP-10 → sessione GPU di verifica visiva.
