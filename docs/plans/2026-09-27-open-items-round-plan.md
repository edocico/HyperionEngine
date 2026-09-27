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
- **Passo 6:** se `sdfOversize` rientra (senza, gli occluder fuori schermo compaiono di colpo al bordo), quale asse locale indica la direzione, quanto è ampia la penombra, e che le luci global non proiettano ombre.
- **Passo 7:** l'ordine dei `mix` sovrapposti (non definito e documentato, oppure deterministico per id).
- **Passo 8:** l'estensione della luce sprite (quadrato di lato = range con raggio `range·√2`, scala del transform, oppure disco), la sorgente della texture, e se la luce sprite proietta ombre.

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
| 6 | **L-c**: ombre directional (`shadow()` generalizzata a origine + direzione) + `light-groups.ts:113` **nello stesso commit**; per le global: nessuna ombra, dichiarato nell'API | Test in `light-groups.test.ts`; con il probe, un sole dietro un muro scurisce il lato lontano; i check delle ombre point/spot del passo 3 restano invariati; costo misurato e annotato nel §13.2 |
| 7 | **L-b**: `mix` come seconda pipeline, dopo add e sub | Test del blend state; il layer del `light-buffer` vale il colore del mix sotto un mix a intensità piena; nessun flicker, oppure ordine documentato come non definito |
| 8 | **L-a**: luce sprite. Nell'ordine: raggio in Rust, poi texture tier in `LightAccumStage` (`TextureTierBinding`), poi shader, poi API TS, poi demo con un cookie procedurale | Test Rust sul raggio; indice 0 = bianco coperto dal guard di `forward-pass.test.ts`; sulla GPU AMD: cookie campionato su texel noti, crescita dei tier con 0 errori, nessun pop al bordo del frustum |
| 8b | **PhysicsAPI collegata alla WASM** (trovato il 2026-09-27, messo nel giro dall'utente): `PhysicsAPI._init(wasm)` non ha chiamanti, quindi nel facade reale eventi di collisione, `raycast`, `queryAABB`/`queryCircle` e `isGrounded` non fanno nulla. In Mode C basta collegarla; in Mode A/B la WASM è nel worker e serve un protocollo nel bridge per eventi e query | Test sul collegamento in ogni modo; un check nell'harness con la build fisica (oggi l'harness carica `ts/wasm` senza `physics-2d`) |
| 9 | Chiusura: documenti obsoleti, CLAUDE.md, `claude-md-auditor`, `adversarial-review` sull'intero range | `preflight.sh --full` verde; `/gpu-check` con tutti i tab e i conteggi |
| 10 | **Mode A verificabile** (scelta dell'utente, 2026-09-27): `HyperionConfig.powerPreference` passato a `requestAdapter()` sia sul main thread sia nel render worker (messaggio di init). Utile anche per i laptop a doppia GPU | Test su `renderer.ts`/`render-worker.ts` per l'opzione; sulla macchina Fedora, con `?mode=A` e `powerPreference: 'low-power'`, il render worker ottiene l'adapter AMD e l'harness disegna (oggi prende NVIDIA e perde il device, perché l'`initScript` di DevTools non raggiunge i worker) |

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
- **Bug preesistente (stessa review):** `SelectionManager.uploadMask` scrive la maschera per id esterno, mentre `selection-seed.wgsl` la legge per slot SoA (`visibleIndices`). Quando id e slot divergono, le outline evidenziano l'entità sbagliata. Va affrontato nel passo 3, quando i check a pixel coprono le outline.

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
  - la riga di `light-accum-stage.ts` in CLAUDE.md.
