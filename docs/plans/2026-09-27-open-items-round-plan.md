# Piano del giro: harness (H), spawn 2D pubblico (S), residui di Phase 17 (L)

HEAD `1f04d40` (master), 2026-09-27. L'ordine è stato ricavato dal workflow `order-open-items` (`wf_22520d1f-e48`): 3 scout read-only, uno per filone, e un critico che ha ricontrollato nel codice le dipendenze che determinano l'ordine. Nessun file tracciato è stato modificato durante l'analisi. I riferimenti `file:riga` si riferiscono a quel HEAD.

## 1. I tre filoni, dopo la lettura del codice

**H — harness.** Due dei tre "minor" sono bug del motore.
- `EntityHandle.destroy()` (`entity-handle.ts:673-680`) invia solo `DespawnEntity`. `Hyperion.returnHandle()` (`hyperion.ts:406-410`) è l'unico punto che deregistra la handle dal LeakDetector e decrementa `entityCount`, e lo chiamano solo i test. Conseguenze:
  - `entityCount` cresce e basta: dopo `maxEntities` (100 000) spawn **cumulativi** `spawn()` lancia "Entity limit reached" per sempre, anche con zero entità vive (`hyperion.ts:386-391`);
  - i warning del LeakDetector sulle demo sono falsi positivi, perché le demo distruggono tutto;
  - il pool non ha mai riciclato una handle.

  Il bug esiste dalla Phase 5 (`a7a5c30`).
- Un cambio di tab mentre il `setup()` asincrono di una sezione è in corso lascia registrato un hook su handle distrutte (per esempio `lighting.ts:114`, `await frames(3)`). Quell'hook lancia un'eccezione, e `GameLoop.frame` (`game-loop.ts:134-142`) non ha try/catch prima di riarmare il RAF: il motore si ferma senza dire niente.
- I check contano gli spawn, leggono `.alive`, oppure verificano che non ci siano eccezioni; `lighting.ts:108` passa sempre. In Primitives i bezier e i gradienti sono fuori dal canvas.
- `line.wgsl:99-109` allarga la linea nello spazio del modello, mentre l'header (`:1`) e l'AA (`:172-174`) assumono pixel schermo.

**S — spawn 2D.** Il lato Rust dell'archetipo `Transform2D` è completo: spawn, batch, sistemi, staging formato 0, fisica, snapshot, `state_hash` e luci. Il lato TS però non invia mai `payload[0]=1`, quindi `scatter.wgsl` formato 0 (`:40-64`) non è mai girato su GPU. Gira solo in Mode B/C, sui frame con `dirtyRatio <= 0.3` e per le radici 2D dirty. Inoltre `.depth()` non ha effetto sulla GPU per **nessuna** entità: `gpu_depths` non ha consumatori TS e `RadixSortPass` viene rimosso dal culling.

**L — residui Phase 17.** Oggi tutti e tre falliscono in silenzio:
- `sprite` viene scartata (`light-accum.wgsl:184-186`);
- `mix` viene sommata come `add` (`:226-228`);
- `directional` è identica a `global` (`:75-76`, `:190`).

Il §7.3 del design dice "Mix in-shader", ma non si può fare: WebGPU non ha framebuffer fetch. Serve una seconda pipeline con blending fisso, e il risultato dipende dall'ordine, che le atomiche del cull rendono non deterministico.

## 2. Decisioni prese (2026-09-27)

| # | Decisione | Scelta |
|---|---|---|
| D1 | Che cosa fa `destroy()` con la handle | **Solo rilascio.** Deregistra la handle dal LeakDetector e decrementa `entityCount`. Nessun riciclo nel pool: una handle distrutta resta morta, quindi niente aliasing ABA |
| D2 | Verifica dei pixel nell'harness | **Probe in-page + readback della swapchain.** Il probe legge `scene-hdr`, `light-buffer` e le righe di `entity-transforms` (valori lineari); la swapchain copre composite, bloom, outline, particelle e overlay (richiede canvas `COPY_SRC`: è una modifica al motore). Mode A: skip con motivo |
| D3 | Unità della larghezza delle linee | **Entrambe, per linea.** Un flag in `primParams[7]` sceglie tra unità mondo e pixel schermo |
| D4 | Esposizione dello spawn 2D | **Opzione per entità** (`engine.spawn({ mode: '2d' })`); il default resta 3D. S e L restano indipendenti |

Decisioni rimandate, da prendere **prima del passo indicato**:
- **Passo 2 — deciso (2026-09-27):** il probe è un'API dev del motore, `engine.debug.probe()` (solo `__DEV__`), usata sia dai check dei tab sia da `/gpu-check`; i check usano rapporti tra punti della stessa lettura per luci e ombre, e valori assoluti in HDR lineare con tolleranza per i colori statici.
- **Passo 3 — deciso (2026-09-27):** l'unità di default di `.line()` resta il mondo (`{ unit: 'px' }` per i pixel, flag in `primParams[7]`), e gli estremi guidano il `BoundingRadius` in Rust, come il range delle Light2D.
- **Passo 4 — deciso (2026-09-27):** su un'entità 2D gli argomenti che hanno senso solo in 3D (z ≠ 0, `sz`, `vz`, un quaternione inclinato su X/Y) vengono ignorati come già fa Rust, con un `console.warn` dev per handle alla prima occorrenza; una sola classe `EntityHandle`, con z opzionale per tutti (`position`/`velocity` default 0, `scale` default `sz = 1`) e `handle.is2D`; i prefab entrano nel passo, con la modalità per template (`PrefabTemplate.mode: '2d'`, niente nodi misti).
- **Passo 5 — deciso (2026-09-27):** Depth→z entra nel giro. `.depth(d)` vale solo per le entità 2D (è la z di un archetipo che non ne ha); su un'entità 3D viene ignorato con lo stesso avviso dev del passo 4. La depth di un figlio 2D è relativa, come la posizione: entra nella sua matrice locale. A parità di depth, l'ordine di due sprite sovrapposti resta indefinito, e lo si documenta. **Trasparenza (review `wf_60bf12aa-fa0`, deciso 2026-09-27):** la pipeline trasparente non scrive la depth e niente ordina, quindi la depth ordina uno sprite `.transparent()` solo rispetto agli opachi; il passo 5 lo documenta, e un nuovo **passo 5b** fa l'ordinamento vero (back-to-front delle entità trasparenti visibili per depth, disegnate in quell'ordine anche tra tipi di primitiva diversi), con un suo design. **Deciso 2026-09-27:** il passo 5b è una fase a sé, *GPU sort + uber pipeline* (radix sort sulla GPU delle entità trasparenti visibili per z di mondo, e UN solo draw con un modulo che copre tutte e sei le primitive), pianificata in questa sessione ed eseguita nella prossima; a parità di z vince la più recente, per id.
- **Passo 6 — deciso (2026-09-30):**
  - **Direzione.** La luce directional splende verso il suo asse +x locale, come lo spot. Un helper condiviso e un test di testo legano le due luci. Il JSDoc documenta l'asse di entrambe: `rotation(-Math.PI/2)` fa splendere verso il basso dello schermo (il mondo è y-up), e una scala x negativa specchia.
  - **Penombra.** Il sole ha un angolo fisso di motore, `u.sourceFraction`: 0,02 rad, l'angolo che ogni point ha al bordo del suo range. Uniform e API non cambiano. Il valore si conferma con un A/B su GPU di 2-3 angoli a 48 passi; un angolo per luce si potrà aggiungere dopo, con lo stesso default.
  - **Lunghezza.** L'ombra del sole è lunga quanto il `range` della luce (lo slot 3, oggi inutilizzato per le directional) e sfuma a 0 verso la fine. La marcia si ferma a min(range, uscita dall'SDF), e oltre l'SDF conta come illuminato: niente estrapolazione all'infinito.
  - **`sdfOversize`.** Non entra nel passo 6. Il passo aggiunge un check col probe che misura la comparsa dell'ombra al bordo dal lato del sole, e il padding si decide dopo i passi 7-8, nel passo 8c.
  - **Luci `global`.** Non proiettano ombre nel backend `lit`: `shadowIntensity` è ignorata, e per un sole si usa una directional. Servono il JSDoc e un avviso dev emesso una volta, lanciato dal renderer tramite `deriveLightGroups` come `multiBitReceiver`, così copre anche l'API raw, i prefab e i replay. Il "per ora" del design dei light layers diventa definitivo per il backend `lit`.
- **Passo 7 — deciso (2026-09-30):**
  - **Lista ordinata.** Tutte le luci, non solo i `mix`, si disegnano da una lista costruita sulla CPU. La lista nasce nella scansione di `deriveLightGroups`, con il test sfera-frustum esatto del cull (senza il margine del raggruppamento). L'ordine è: classe di blend (add e sub prima dei mix), poi z di mondo dal fondo al davanti, poi id esterno. A parità di z vince l'id più alto, come per i trasparenti del 5b.
  - **Una pipeline.** Una sola pipeline con blend "over" premoltiplicato e un draw diretto per gruppo. Il §10.2 del design 17 diventa vero alla lettera sullo stesso device, la seconda pipeline non serve, e `LightAccumStage` non dipende più da `indirect-first-instance`.
  - **Peso del mix.** Il peso è l'intensità della luce (falloff × cono × ombra); il bersaglio è colore × energia, già premoltiplicati sul wire.
  - **Da documentare.** Una luce la cui z esce da near/far più del suo range viene scartata dal cull.
- **Passo 8 — deciso (2026-09-30):**
  - **Forma.** La luce sprite è un quadrato di semilato = range (il quad che lo shader già disegna) che ruota con l'asse +x locale, come lo spot. In Rust il raggio di culling diventa `range·√2`, e la scala resta ignorata.
  - **Cookie.** La forma la dà il cookie: niente falloff radiale, luce = colore × rgb·a del cookie. Il cookie viene dai tier del motore: `loadTexture` + `.texture()`, colonna `tex-indices`, `TextureTierBinding` nel gruppo 1 di `LightAccumStage`. `light-accum.wgsl` ha una copia dello switch dei tier, legata al preludio da un test.
  - **Indice 0.** Una luce sprite senza texture non disegna nulla, con un avviso dev emesso una volta.
  - **Ombre.** La luce sprite proietta ombre dal centro, come una point; `light-groups.ts` conta le sprite nello stesso commit.
  - **Mode A.** Le texture non si caricano: limitazione dichiarata.
- **Passo 9 — deciso (2026-09-30):** la review avversariale copre i passi 6-10, da `185358e`; il `claude-md-auditor` copre tutto il giro.
- **Passo 10 — deciso (2026-09-30):**
  - **10(b), `powerPreference`: esce dal giro.** Su Chrome per Windows (e quindi in Electron e WebView2) l'hint non ha effetto, su Apple Silicon c'è una sola GPU, e la Mode A si verifica già sul Mac (M6, M12). Resta in backlog come parità con PixiJS e three.js. Sulla macchina Fedora si prova il flag di Chrome `--use-webgpu-power-preference=default-low-power` nel server MCP locale.
  - **10(a), mondo vuoto in Mode A: si fa prima del passo 9,** insieme all'inoltro del device lost in Mode A (worker → bridge → `config.onDeviceLost`).
  - **Masterplan.** Nello stesso commit si corregge il masterplan (righe 232 e 247), che dà per fatto il recupero trasparente dopo un device lost.
- **Dopo il giro — deciso (2026-09-30):** un passo per l'audio su WebKit. Dal sorgente di WebKit (non misurato su Safari), `suspend()` su un AudioContext mai partito non si risolve e impedisce ai suoni successivi di avviare il contesto finché non si chiama `resume()`. Il passo porta:
  - un `suspend()` che si risolve anche in quel caso;
  - `audio.state`;
  - un hook di sblocco al primo gesto, verificato in Safari;
  - una segnalazione su bugs.webkit.org, perché la spec non chiede un gesto per `suspend()`.

**Ripreso il 2026-09-30.** Dal 2026-09-29 il giro era in pausa per i test sul Mac (`docs/handoff/2026-09-29-mac-m2-handoff.md`, esito al §9). Le decisioni rimandate sono state preparate dal workflow `wf_c4b94385-585`, che ha riverificato ogni domanda nel codice e le ha passate a verificatori scettici. Su `sdfOversize` c'è stata anche una seconda ricerca indipendente. Le scelte sono state prese dall'utente il 2026-09-30 (sopra). Ordine da qui: 6 → 7 → 8 → 8b → 8c → 10 → 9.

## 3. Ordine e criteri di uscita

| # | Passo | Criterio di uscita |
|---|---|---|
| 0 | Questo documento | Decisioni registrate |
| 1 | **H2**: `destroy()` rilascia la handle al motore; il cambio tab non si sovrappone più a un setup in corso; un hook che lancia non ferma il loop | Vitest RED→GREEN: `destroy()` da solo decrementa `entityCount` e deregistra la handle (spy sul LeakDetector); si può fare spawn oltre `maxEntities` cumulativi; niente più `returnHandle` manuali nei test; lo switch dei tab è testato con sezioni finte; `preflight.sh` verde |
| 1b | **Riuso degli id in quarantena** (decisione 2026-09-27) | Uno spawn/destroy in loop oltre `MAX_EXTERNAL_ID` non lancia; un id non viene riassegnato finché il suo despawn non è stato scritto ed elaborato (test sotto backpressure); nessuno stato indicizzato per id (selezione, eventi fisici, joint, emitter, ImmediateState) passa all'entità nuova |
| 2 | **H1a**: probe (`scene-hdr`, `light-buffer`, righe `entity-transforms` tramite compute copy) + readback della swapchain | WGSL e pipeline validati sotto error scope sull'adapter AMD; test headless per reads/writes, layout degli uniform e mapping mondo→pixel; sul tab Lighting il probe riproduce i fatti noti (clear a 0.067, asimmetria dei pilastri ≈2.3x); Mode A → `unavailable` |
| 3 | **H3** (flag mondo/pixel per le linee, AA con `fwidth`), poi **H1b** (nuovo layout di Primitives; i check a conteggio e i no-op diventano check sul probe in Primitives, Scene Graph, Lifecycle, Lighting e Rendering FX) | Ogni tab mostra N/M con check reali e 0 messaggi WebGPU; Tonemap resta `skip` onesto finché l'API è uno stub (`hyperion.ts:534-538`); baseline HDR rifatte |
| 4 | **S1**: `spawn({ mode: '2d' })`, RawAPI, `z` opzionale + scena gemella 2D contro 3D con meno del 30% delle entità in moto | Il readback mostra le righe formato 0 uguali a `latestRenderState` **sui frame scatter**; ogni sprite 2D sta sullo stesso pixel del suo gemello 3D; vitest per payload 1 sotto backpressure; test Rust per una Light2D su `Transform2D` |
| 5 | **S2** (se entra nel giro): Depth → z | Test Rust su z della radice, eredità nei figli, formato 0 e ri-staging dei figli dopo `SetDepth`; il probe mostra sprite 2D sovrapposti nell'ordine giusto e stabile |
| 5b | **S2b**: ordinamento back-to-front delle entità trasparenti per depth (deciso 2026-09-27) | Due sprite `.transparent()` sovrapposti, anche di tipi diversi (quad e box shadow), si compongono nell'ordine delle depth, stabile tra i frame; il probe lo verifica nel tab 2D Twins; costo GPU misurato |
| 6 | **L-c**: ombre directional (asse +x locale, penombra fissa `u.sourceFraction`, lunghezza = `range` con sfumatura; `shadow()` generalizzata a origine + direzione + uscita dall'SDF) + `light-groups.ts:115` **nello stesso commit**; per le global: nessuna ombra nel backend `lit`, dichiarato nell'API e avvisato dal renderer | Test in `light-groups.test.ts`, più un test di testo che lega i gate di WGSL e TS. Con il probe: un sole dietro un muro scurisce il lato lontano, un check misura la comparsa dell'ombra al bordo dal lato del sole, e i check delle ombre point/spot del passo 3 restano invariati. **Costo (criterio approvato il 2026-09-30):** una riga M2 nel §13.2 del design 17, misurata con A/B dello span a 1920×1080 su una scena statica committata (`?bench`). Condizioni: timestamp non quantizzati (`chrome-devtools-gpu`), Mac all'alimentatore, altro browser fermo. Due coppie: ombra del sole on/off con una point già ombreggiata; poi il sole come unica luce ombreggiata. Esito: media ± SE con limite t (n−1 gradi di libertà); "sotto la risoluzione, < X ms" vale come esito. La riga AMD è facoltativa (prossima sessione Fedora) |
| 7 | **L-b**: tutte le luci da una lista CPU ordinata (classe di blend, z di mondo, id), una pipeline "over"; `mix` con peso = intensità | **Criterio approvato il 2026-09-30.** Vitest su blend state, chiave d'ordine e lista. Con il probe: un mix a intensità piena porta il layer del `light-buffer` al colore del mix, e scambiando a runtime la depth di due luci sovrapposte il colore si scambia. Stabilità su N frame dove il cull riordina davvero: Safari, oppure luci a ≥256 slot di distanza. In Chrome sul Mac il cull a subgroup tiene fermo l'ordine delle scene piccole |
| 8 | **L-a**: luce sprite. Nell'ordine: raggio in Rust (`range·√2`), poi texture tier in `LightAccumStage` (`TextureTierBinding`), poi shader, poi API TS, poi demo con un cookie procedurale | **Criterio approvato il 2026-09-30.** Test Rust sul raggio; guard dell'indice 0 esteso a `light-accum.wgsl` (niente luce, più un avviso). Su una GPU hardware (AMD o M2), in Mode B, con il probe: cookie campionato su texel noti; il tier che contiene il cookie (l'overflow rgba8 sui device BC) cresce mentre la luce disegna, con 0 errori; nessun pop al bordo del frustum a nessuna rotazione; l'ombra di una luce sprite dietro un muro. Mode A: limitazione dichiarata, perché lì le texture non si caricano |
| 8b | **PhysicsAPI collegata alla WASM** (trovato il 2026-09-27, messo nel giro dall'utente): `PhysicsAPI._init(wasm)` non ha chiamanti, quindi nel facade reale eventi di collisione, `raycast`, `queryAABB`/`queryCircle` e `isGrounded` non fanno nulla. In Mode C basta collegarla; in Mode A/B la WASM è nel worker e serve un protocollo nel bridge per eventi e query. **Da decidere all'inizio del passo** (trovato il 2026-09-30). (1) La forma delle query in Mode A/B: asincrone, sincrone su uno snapshot di un tick prima, oppure solo in Mode C. (2) Come un'app e l'harness ottengono la build fisica: un'opzione di config, un alias di build, oppure l'harness sulla build fisica. (3) Se la correzione di `collider_handle_to_entity`, che ignora la generazione (`physics.rs:471-474`), entra in questo passo | Test sul collegamento in ogni modo; un check nell'harness con la build fisica (oggi l'harness carica `ts/wasm` senza `physics-2d`) |
| 8c | **Padding dell'SDF** (`sdfOversize`, deciso il 2026-09-30): la scelta si prende dalla misura della comparsa al bordo fatta nel passo 6, dopo che i passi 7-8 hanno fissato penombra e ombre delle sprite. Le alternative sono un padding simmetrico (default 1.0, semantica di Godot, che servirà anche al backend `gi`) o un rettangolo guidato dalle luci. Da solo un SDF più grande non basta: servono un cull degli occluder sul rettangolo allargato, una camera del seed allargata e la rimappatura delle UV nell'accumulo | Decisione registrata con la misura. Se si implementa: default identico al pixel; un check col probe su un caster appena fuori quadro; costo A/B nel §13.2 |
| 10 | **Mode A** (deciso il 2026-09-30, si fa **prima del passo 9**): (a) il mondo vuoto, cioè il filtro del bridge (`worker-bridge.ts:272`) con la sua transfer list, lo skip di `render-worker.ts:72` e lo stato del main thread fermo sull'ultimo mondo; più l'inoltro del device lost in Mode A (worker → bridge → `config.onDeviceLost`). Nello stesso commit si corregge il masterplan (righe 232 e 247). 10(b) `powerPreference`: fuori dal giro, in backlog | Vitest: un `tick-done` vuoto porta a 0 lo stato del main thread e viene inoltrato con una transfer list di soli ArrayBuffer; il render loop disegna uno stato vuoto; il device lost arriva a `config.onDeviceLost`. Sul Mac: la procedura di M6b in Mode A torna a 17/255 come la B, e `chrome://gpucrash` in `?mode=A` chiama `onDeviceLost` |
| 9 | Chiusura: documenti obsoleti, CLAUDE.md, `claude-md-auditor` su tutto il giro, `adversarial-review` sui passi 6-10 (da `185358e`) | **Criterio approvato il 2026-09-30.** `preflight.sh --full` verde. `/gpu-check` sul Mac in Chrome, modi B, C e A. Safari B, C e A con una sezione Safari nuova in `/gpu-check` e il driver safaridriver committato; la console si controlla in Chrome. Fedora B e C alla prossima sessione, non bloccante |

Perché H viene prima: c'è un bug del motore da correggere, e il probe è la base di verifica per S e per L. Il formato 0 e il `mix` si possono controllare solo su valori lineari; uno screenshot a 8 bit non basta.

Perché S viene prima di L: con il 2D opt-in i due filoni sono indipendenti, ma S espone subito un percorso GPU mai eseguito, con zero modifiche a Rust.

Dentro L l'ordine è directional → mix → sprite: prima il raggio d'azione più piccolo, e `shadow()` va generalizzata prima che la luce sprite la riusi.

## 4. Trovato lungo la strada

- **Passo 1, review `wf_fc1e6644-ae6`:** gli id esterni non vengono mai riusati, quindi `MAX_EXTERNAL_ID` (1 048 575) limita gli spawn CUMULATIVI di una sessione. Ora `spawn()` e `raw.spawn()` lanciano un errore invece di lasciare che la WASM scarti lo spawn in silenzio. **Deciso e fatto (2026-09-27): riuso in quarantena, passo 1b** (design `docs/plans/2026-09-27-id-reuse-design.md`; review `wf_f28f7089-de1`: 14 minori confermati, tutti corretti; `protocol-sync-checker` pulito). Un id liberato (`destroy()`, `raw.despawn()`) torna disponibile solo quando il suo `DespawnEntity` è stato scritto nel ring buffer e la WASM ha confermato almeno un tick successivo. Sotto backpressure il comando può restare nella coda TS per diversi frame, quindi contare i frame non basta. Prima del design va mappato tutto lo stato indicizzato per id (TS e Rust).
- **Passo 1b, mappatura `wf_f39b6322-af4`:** design in `docs/plans/2026-09-27-id-reuse-design.md` (decisioni Q1-Q3). Trovati anche, fuori scope:
  - `collider_to_entity` indicizzato solo per indice: un `Stopped` può essere attribuito all'entità sbagliata;
  - `ecs-inspector.ts:114` chiama `selection.selectedIds()` come metodo, ma è un getter (il mock del test lo nasconde);
  - CLAUDE.md dà 600 000 come default del tape, ma è 1 000 000 (`command-tape.ts:22`).
- **Passo 2 (probe) — fatto** (review `wf_bf97d75c-ec7` + `webgpu-pass-reviewer`: 10 + 4 finding, tutti corretti e verificati su GPU). Lo scatter gira SOLO in Mode C, perché `engine-worker.ts` non invia mai `dirtyCount`/`stagingData`, quindi in Mode B e A ogni frame fa l'upload completo delle SoA. È una lacuna di prestazioni, non di correttezza. Per il passo 4, il formato 0 va verificato con `?mode=C`. Il probe legge la swapchain con `TEXTURE_BINDING` (configurato solo in dev) invece che con `COPY_SRC`: la capacità è la stessa (D2).
- **Passo 3b (check a pixel) — fatto.** Trovati e corretti lungo la strada:
  - la maschera di selezione ora è per slot, e il check Outline lo verifica;
  - un mondo vuoto non disegnava nulla e lasciava l'ultima immagine a schermo (Mode B/C; la Mode A resta per il passo 10);
  - il cull a zero entità dava un warning;
  - i box shadow della demo erano opachi, quindi quadrati pieni.

  Registrati ma non corretti:
  - `gradient()` non può impostare G/B dello stop1;
  - Vite può servire la trasformazione stantia di uno shader dopo un checkout (bisogna riavviare il dev server).
- **Passo 4 (spawn 2D pubblico) — fatto** (review `wf_24bad90e-4e1`: 8 finding minori, tutti corretti). Rust gestiva già tutto (payload 1 di SpawnEntity, da Phase 13): `tests/verify_2d.rs` lo fissa (gemelli con la stessa riga GPU; una Light2D su Transform2D culla sul range, formato 0). Criteri d'uscita verificati sull'iGPU AMD: in Mode C 12/12 frame via scatter, righe GPU = CPU entro 1.2e-7 (genitore in formato 0, figlio in formato 1); 4629/4629 texel uguali tra 2D e 3D, e mezzo pixel di scarto, anche sul solo figlio, fa fallire il check. Trovati lungo la strada:
  - `PrefabInstance.moveTo` dimenticava la z di `overrides.z` (corretto);
  - un reload di Vite dopo una modifica TS perde l'initScript: la pagina prende NVIDIA e perde il device (`VK_ERROR_OUT_OF_DEVICE_MEMORY`) — documentato nella skill gpu-check;
  - la doc prometteva un upload ridotto per il 2D: non esiste, ogni riga resta 16 parole (il risparmio è solo nel componente ECS).
- **Passo 5 (Depth → z) — fatto** (review `wf_60bf12aa-fa0`: 10 finding confermati, corretti o documentati). La riga di un'entità 2D porta z = -depth (distanza dentro lo schermo), relativa nei figli, nel formato 0 alla parola 2; `SetDepth` ignorato sulle 3D. Verificato sull'iGPU AMD: sprite sovrapposti nell'ordine giusto per 10 frame e dopo il cambio a runtime (anche il figlio che segue il genitore); in Mode C la z arriva via scatter uguale alla CPU. Trovati lungo la strada:
  - la depth non ordina due sprite trasparenti (niente depth write, nessun ordinamento) → documentato, **passo 5b**;
  - `positionImmediate` congelava la z di un'entità 2D → l'ombra immediata 2D ora patcha solo x e y;
  - un corpo fisico ha la depth in coordinate mondo, come la posizione (documentato);
  - il benchmark del ring buffer stava a 1 s dal timeout di vitest e sotto carico falliva (preesistente): timeout esplicito.
- **Passo 5b (ordinamento dei trasparenti, fase a sé) — fatto** (spec `2026-09-27-transparent-sort-uber-design.md`, piano `2026-09-27-transparent-sort-uber-plan.md`; review `wf_61c6a580-afa`: 18 finding confermati, tutti minor, tutti corretti, più i 16 punti di documentazione del `claude-md-auditor` e 2 irrobustimenti del `webgpu-pass-reviewer`). Gli shader delle primitive sono composti da un preludio + sei librerie; la colonna `entity-ids` arriva sulla GPU; `TransparentSortPass` fa gather + radix stabile a 7 passate; un solo draw uber disegna tutti i trasparenti, dal fondo al davanti per (z di mondo, id). Verificato sull'iGPU AMD in Mode B e C: check nuovi di 2D Twins verdi, stati uguali alla baseline, punti statici opachi identici al bit, trasparenti entro 1/255. Sort a 100k trasparenti visibili: 0.787 / 0.869 ms (depth uguali / distinte); `forward` 4−3: −0.021 ms a depth uguali, ma il `total` del frame 4−3 è +0.251 / +1.137 ms (§11 della spec; ipotesi non misurata: con depth distinte l'ordine ordinato legge le colonne SoA per slot sparsi). **Deciso il 2026-09-30:** il +1,137 ms è chiuso come dipendente dalla cache, con un test in coda per la prossima sessione Fedora; per il 4−3 dell'M2 c'è un A/B senza codice in coda per la prossima sessione GPU sul Mac (design 5b §11).
- **Bug preesistente (stessa review):** `SelectionManager.uploadMask` scrive la maschera per id esterno, mentre `selection-seed.wgsl` la legge per slot SoA (`visibleIndices`). Quando id e slot divergono, le outline evidenziano l'entità sbagliata. Va affrontato nel passo 3, quando i check a pixel coprono le outline.
- **Preparazione della ripresa (2026-09-30):** il workflow `wf_c4b94385-585` (7 ricercatori, 7 verificatori scettici, un critico di copertura) e una seconda ricerca indipendente su `sdfOversize`. Trovato, oltre alle decisioni del §2:
  - **Device lost in Mode A.** Il device lost resta nel render worker, che fa solo un `console.error`, e il masterplan (righe 232 e 247) dà per fatto il "recupero trasparente". → passo 10.
  - **Audio in WebKit.** `suspend()` su un AudioContext mai partito resta appeso (dal sorgente di WebKit, non misurato su Safari). Nell'harness fa segnare ad Audio un falso "3/3 passed" e blocca i tab successivi; nel motore ferma un gioco che mette in pausa prima del primo tocco. → correzione dell'harness con il tooling Safari del passo 9, e un passo per il motore dopo il giro.
  - **Guard dell'indice 0.** Il guard di `forward-pass.test.ts` guarda solo i moduli composti delle primitive, non `light-accum.wgsl`. → criterio del passo 8.
  - **Ordine delle luci.** Anche add e sub dipendono dall'ordine delle luci, di 1-2 ULP fp16 (modello su CPU, non misurato su GPU). Il §10.2 del design 17 quindi oggi vale solo a meno di un ULP. → passo 7, lista ordinata per tutte le luci.
  - **Luci e parola 0 di `renderMeta`.** Per le luci nessuno legge la parola 0 di `renderMeta` (MeshHandle): è il posto di un eventuale ordine esplicito delle luci, alla Unity.
  - **Mode A e le texture.** In Mode A le texture non si caricano (`loadTexture` lancia): tocca i cookie del passo 8, e anche gli sprite di chi usa Chromium di default o il desktop embedding.

## 5. Documenti obsoleti da correggere lungo la strada

Ognuno va corretto nel commit del passo che lo tocca:
- **H:**
  - l'header di `line.wgsl:1` e le righe "screen-space" in CLAUDE.md, `PROJECT_ARCHITECTURE.md:366,1738` e `hyperion-masterplan.md:1109`;
  - in CLAUDE.md: `entity-pool.ts` ("recycling"), `leak-detector.ts`, `debug-tools.ts` (7 check, non 5), `rendering-fx.ts` (tonemap stub);
  - il commento di `hyperion.ts:402-405`;
  - il §5 di `.claude/skills/gpu-check/SKILL.md`.
- **S:**
  - CLAUDE.md: `Depth` ("opt-in 2.5D"), il gotcha sulla colonna Depth, `tlv-parser` (15 tipi, Rust ne emette fino a 19), il canale lento di `ecs-inspector` (è uno stub);
  - `components.rs:229`, `components.rs:252-253`, `systems.rs:236`, `command_processor.rs:950`;
  - il §4 del design di Phase 13.
- **L:**
  - nel design Phase 17: §7.3:577 ("Mix in-shader"), §4-B:221 e §7.3:571 (global = clear color), §10.2:832-834 (determinismo), l'API di esempio del §11:861;
  - il design dei light layers, righe 53 e 224;
  - `light-groups.ts:110-113`;
  - l'header di `light-accum.wgsl`;
  - la riga di `light-accum-stage.ts` in CLAUDE.md;
  - trovati il 2026-09-30, nel design Phase 17:
    - riga 488: con la semantica del codice, 110% vale 1,44× i pixel, non 1,21×;
    - righe 944 e 952: 1344×756 fa 12 passate con 1+JFA, non 11;
    - E2 va precisato: le ombre integrate di Godot non leggono l'SDF, quelle marciate su SDF sì, e per loro l'oversize serve.
- **Mode A (passo 10):**
  - `hyperion-masterplan.md` righe 232 e 247 (recupero dopo un device lost);
  - CLAUDE.md, la riga di `worker-bridge.ts` e il gotcha sul mondo vuoto in Mode A;
  - `.claude/skills/gpu-check/SKILL.md` righe 162 e 252-259.
