# Hyperion e un gioco 2D completo: a che punto sarà l'engine a fine giro

Analisi del 2026-10-16, chiesta dal proprietario durante il passo 8 del giro: «una volta completati tutti i passi, quale sarà lo stato di readiness dell'engine per testarlo in un progetto pratico, lo sviluppo di un gioco complesso completo?».

Il caso di riferimento è un gioco 2D completo e complesso, per esempio un action-adventure o un platform:
- molti livelli;
- animazioni degli sprite, fisica, HUD e menu;
- audio e musica, salvataggi;
- tastiera, gamepad e touch;
- particelle e luci 2D;
- distribuito sul web e come app desktop.

«A fine giro» vuol dire dopo i passi 8 (in corso), 8b, 8c, 10 e 9, più il passo dell'audio WebKit che lo segue (piano del giro, §2 e §3).

## 1. Il verdetto

**A fine giro Hyperion non è pronto per un gioco 2D completo e complesso.** È adatto a un **prototipo tecnico o a una vertical slice** su desktop, a quattro condizioni:
- Mode B forzata;
- HUD e menu in DOM;
- arte pensata per i quadrati dei tier;
- fisica solo dopo l'8b.

Un gioco completo richiede prima sull'engine un lavoro che il giro non fa e che il masterplan non pianifica:
- il modello delle texture (rettangoli UV, scaricamento);
- lo specchio e la tinta degli sprite;
- l'interpolazione;
- l'input;
- la build e il pacchetto;
- la gestione degli errori e il recupero del device.

Sopra c'è lo strato di gioco (animazione, livelli, testo, audio da gioco), che un team scriverebbe comunque in TS, o che diventa una libreria a parte (§6).

Il nucleo è forte, e su alcuni punti è più avanti dei motori 2D web affermati (§5):
- rendering guidato dalla GPU fino a 100 000 entità;
- ordinamento dei trasparenti sulla GPU;
- luci 2D con ombre morbide su SDF;
- ECS in WASM con Rapier;
- determinismo per target.

Manca invece quello che un team si aspetta di trovare pronto per fare un gioco: sprite sheet, animazioni, tilemap, testo, input completo, livelli, musica, pacchetto installabile.

Il masterplan lo dice esplicitamente: Hyperion è definito come «una primitiva di rendering», non un motore di gioco completo (`hyperion-masterplan.md:33-37`). Diventare un motore per giochi completi è una scelta strategica, ancora da fare (§6).

| Uso | Stato a fine giro |
|---|---|
| App canvas, visualizzazioni, scene 2D con molte entità | **Pronto con riserve** (Mode B/C, desktop) |
| Prototipo o vertical slice di un gioco 2D | **Fattibile** a fine giro, alle quattro condizioni sopra (ricetta al §8); il lavoro del §7 serve per il gioco completo |
| Gioco 2D completo e complesso | **Non pronto**: un bloccante (§2) e una cinquantina di problemi maggiori (§3) |
| Gioco su mobile, Firefox, Windows o app desktop | **Non verificato**: mai girato su queste piattaforme |

## 2. Il bloccante che resta dopo il giro: il modello delle texture

Su 5 bloccanti verificati, 4 sono lo stesso tema visto da quattro ricercatori diversi. Il quinto è la fisica, che oggi un gioco non può usare (il `PhysicsAPI` non è collegato al WASM): lo chiude il passo 8b.

Il modello delle texture ha questi limiti:
- **Nessun rettangolo UV.** Un quad campiona sempre l'intero layer della sua texture (`quad.wgsl:5-7`): niente atlanti, sprite sheet o tileset. Un'animazione a frame richiede una texture, cioè un layer, per ogni frame.
- **Ogni PNG o JPEG viene ridimensionato a un quadrato** di 64, 128, 256 o 512 px, scelto dalla dimensione maggiore. Si perde il rapporto d'aspetto e oltre 512 px si rimpicciolisce (`texture-manager.ts:686-701`).
- **Al più 255 immagini per array e per sessione.** Il layer 0 è riservato e ci sono quattro tier: in tutto circa 1020 immagini per sessione (`texture-manager.ts:5-7`, `:733-740`).
- **Niente si scarica.** La cache per URL non libera mai nulla e `compact()` non fa niente (`texture-manager.ts:183-899`, `hyperion.ts:675-680`): un gioco a livelli non può liberare l'arte di un livello finito.
- **Un solo campionatore lineare, al mip 0.** Le catene di mip sono allocate ma mai scritte, e non c'è un filtro *nearest*: la pixel art viene sfocata e lo zoom indietro tremola (`texture-manager.ts:216-220`, `prelude.wgsl:151-171`).
- **Il percorso KTX2/Basis**, la via di produzione prevista dal design, non ha mai caricato un asset reale su una GPU.

Il giro non tocca niente di questo. Il passo 8 raddrizza soltanto le immagini dei tier, e il suo piano lascia fuori esplicitamente lo scaricamento e i mip.

## 3. I problemi maggiori, per area

Dopo la verifica i problemi maggiori sono 53, più 2 trovati dallo scettico. Qui sono raggruppati; il dettaglio, con file e riga, è nelle evidenze (§9).

### Contenuti e rendering
- **Gli sprite specchiati spariscono.** `scale(-1, 1)` è il modo normale di girare un personaggio, ma inverte l'avvolgimento dei triangoli, e le pipeline delle entità scartano le facce posteriori (`cullMode: 'back'` in `forward-pass.ts:271`, `:285`, `occluder-seed-stage.ts:96`, `selection-seed-pass.ts:107`). La correzione è di poche righe. È registrata per il passo 9 (piano del giro §4, punto (1b)) come candidata, da decidere col proprietario: nessun passo si è impegnato a farla, e il criterio d'uscita del passo 9 non la comprende.
- **Niente tinta, opacità o visibilità per sprite.** Non c'è un comando né un metodo per farlo; per nascondere un'entità serve `scale(0, 0)` oppure distruggerla.
- **Testo:** lo shader MSDF esiste, ma `TextManager` è un segnaposto non esportato e il layout gestisce una sola riga, senza a capo né kerning. Non c'è un'API per i glifi e l'harness salta il check MSDF per mancanza di un font.
- **Niente tilemap** e nessun import da Tiled o LDtk.
- **Movimento a scatti sopra i 60 Hz:** non c'è interpolazione fra i tick fissi a 60 Hz, e `fixedTimestep` nella config non viene letto.
- **Particelle minime:** cerchi senza texture, disegnati sopra tutto e assenti in Mode A.
- **Nessun punto d'estensione per effetti propri** (trovato dallo scettico): niente materiali o shader per sprite (dissolvenza, cambio di palette, flash) e nessuna catena di post-processing. Il composite è uno solo: outline, altrimenti bloom, altrimenti FXAA + tonemap.
- **Ombre in spazio schermo** (trovato dallo scettico): un occluditore fuori vista non proietta nulla.
  - Oggi: scorrendo la camera, l'ombra di un sole entra di colpo dal bordo controvento (misurato al passo 6).
  - Dopo l'8c anche le point e le spot col centro fuori schermo si fermeranno all'uscita dall'SDF. Sparisce l'estrusione infinita di oggi, ma i caster fuori vista fra la luce e la vista smettono di fare ombra.
  - L'8c potrà aggiungere al più un padding opzionale, spento di default.
- **Device lost non recuperato:** il renderer lo registra e chiama `onDeviceLost`, ma nulla lo ricostruisce né ricarica le texture.

### Gameplay
- **Fisica (dopo l'8b):** diventa raggiungibile (con le riserve sulle query in Mode A e B del §4), ma restano tre limiti:
  - i default sono in pixel con y verso il basso (gravità (0, +980), 100 unità per metro), mentre il renderer ha y verso l'alto e una vista di 20 unità, e TS non li può configurare;
  - ci sono solo tre forme di collider;
  - non c'è modo di impostare o leggere la velocità, né il blocco della rotazione, le piattaforme attraversabili dal basso o i filtri dei raggi.
- **Input:** solo tastiera, un puntatore e la rotella. Non ci sono gamepad, multi-touch né mappatura delle azioni, e i tasti restano premuti se la finestra perde il focus.
- **Niente ciclo di vita dei livelli:** nessun modo di svuotare il mondo, nessuna distruzione a cascata, `compact()` che non fa nulla.
- **Lettura dello stato:** `EntityHandle` non ha getter della posizione, e le viste di sistema sono per slot GPU, senza velocità. Il nucleo Rust è chiuso per progetto e la logica di gioco vive in TS, come nei motori TS: per lo scettico questo non è un difetto, e anche il salvataggio di gioco si fa lato TS, come in Phaser. Quello che rende maggiore il punto è la lettura dello stato del motore.
- **Audio da effetti, non da musica:** niente streaming, bus o dissolvenze, niente pausa per singolo suono. Lo sblocco al primo gesto su WebKit arriva dopo il giro.
- **Niente UI o HUD nel canvas:** si usa un overlay DOM.

### Piattaforme e robustezza
- **Nessun fallback WebGL:** senza WebGPU il canvas resta nero e l'app non riceve alcun segnale.
- **Un'eccezione nel frame ferma il motore per sempre:** `tickFn` non è isolato. In Mode B `Hyperion.create` resta appeso se il worker va in errore, e un worker morto lascia il gioco congelato con un solo messaggio in console.
- **Verificato su poche combinazioni:** Mac M2 (Chrome e Safari) e una macchina Linux (Chrome con flag). Windows/D3D12, Edge, Firefox, Android, iOS, Electron e Tauri non sono mai stati provati. Non c'è CI.
- **Mobile:** l'input è pensato per il desktop (un solo puntatore, niente `pointercancel` né `touch-action`).
- **App desktop:** esiste solo come testo nella guida di deployment, e quel testo contraddice i controlli dell'engine.

### Prodotto e strumenti
- **La build di produzione fallisce:** `npm run build` si rompe perché Vite impacchetta i worker in IIFE e i worker hanno import dinamici. La correzione probabile è una riga (`worker.format: 'es'`), ma il bundle di produzione non è mai stato eseguito, e il preflight non lo costruisce.
- **Nessun pacchetto installabile:**
  - `ts/package.json` è privato, versione 0.1.0, senza `exports`;
  - non ci sono `.d.ts` pubblicati né WASM precompilati;
  - i percorsi del WASM sono fissi nel codice;
  - funziona solo con Vite.
- **Nessuna documentazione per chi usa l'engine:** niente README per l'utente né esempi.
  - L'unica guida, `docs/deployment-guide.md`, è ferma al 2026-02-22 e in parte sbagliata: consiglia Node 18+, usa le chiavi di Tauri v1 e promette log di capacità che l'engine non stampa.
  - Per il resto ci sono l'harness di verifica e CLAUDE.md, che è scritto per gli agent.
- **Niente editor né strumenti per i livelli:** la pipeline degli asset genera solo i percorsi delle texture.
- **Il WASM della fisica:** oggi un'app non può scegliere quella build; l'8b decide come.

## 4. Cosa porta il giro

| Passo | Cosa chiude per un gioco |
|---|---|
| 8 (in corso) | Luci sprite col cookie: con il passo 8 ci sono tutti i tipi di luce. Quelle della Phase 17 sono verificate sull'iGPU AMD e sull'M2; directional, mix e sprite (passi 6-8) solo sull'M2. Immagini dei tier diritte; un avviso per una luce sprite senza texture |
| 8b | **La fisica diventa raggiungibile da TS:** eventi e sensori in ogni modo; raycast, query AABB e cerchio e `isGrounded` nella forma che il passo sceglie per le Mode A e B (asincrone, su uno snapshot di un tick prima, oppure solo in Mode C, che escluderebbe la Mode B della ricetta del §8); come un'app carica la build con la fisica |
| 8c | La decisione sul padding dell'SDF; le marce di point e spot che si fermano all'uscita dall'SDF |
| 10 | Mode A: il mondo vuoto si disegna e il device lost arriva a `onDeviceLost` |
| 9 | Chiusura: documenti, review avversariale, verifica GPU in Chrome e Safari sul Mac |
| Audio WebKit | `suspend()` che si risolve prima del primo gesto, `audio.state`, uno sblocco al primo gesto |

Restano fuori dal giro:
- il modello delle texture;
- lo specchio, la tinta e la visibilità degli sprite (lo specchio è soltanto candidato per il passo 9, §3);
- l'interpolazione;
- l'input;
- testo e UI;
- particelle e musica;
- tilemap e livelli;
- gli effetti propri;
- build, pacchetto, licenza, documentazione per l'utente e CI;
- la gestione degli errori e il recupero del device;
- il fallback WebGL;
- la verifica su Windows, mobile, Firefox e app desktop.

## 5. Dove Hyperion è già avanti

Il confronto è con Phaser 3/4, PixiJS 8, Excalibur.js, l'export web di Godot 4 e Defold, a livello di lista di funzionalità; le loro funzionalità vengono dalla documentazione pubblica e non sono state riverificate in questa analisi. Hyperion è più avanti in cinque punti:
- **Scala sulla GPU:** culling in compute, draw indiretti, ordinamento dei trasparenti.
  - Il cull misura 42-47 µs a 100 000 entità su una RTX 4060. Sull'M2 Pro il profiler gli assegna un intervallo di 0,16 ms, che sull'M2 non è un costo, perché i pass si sovrappongono.
  - 100 000 sprite trasparenti statici tengono 120 fps in Mode B sull'M2 Pro.
  - L'ordinamento dei trasparenti sulla GPU resta sotto 1 ms a 100 000.
- **Luci 2D con ombre morbide su SDF e layer di luce:** luci point, spot, directional, global e sprite; costano circa 2,3 ms a 1080p sull'iGPU AMD e circa 4 ms di frame sull'M2. Solo Godot è paragonabile, e in più ha le normal map.
- **ECS in Rust/WASM con Rapier nello stesso binario:** in Mode A e B gira in un worker separato dal thread principale e da quello di render; l'ECS stesso (hecs) usa un solo thread. Pesa circa 70 KB gzip il core, circa 338 KB con la fisica.
- **Determinismo per target:** bit a bit sullo stesso target, coperto dai test Rust, più la registrazione dei comandi nelle build di sviluppo. Replay e time-travel esistono come librerie, ma il facade non le collega: servono una build WASM dev-tools caricata a parte e callback scritte a mano.
- **Profilazione GPU per pass** e hot reload degli shader validato sulla GPU: più avanti di Phaser, PixiJS ed Excalibur. Per Godot e Defold le evidenze non lo affermano.

Fuori dal confronto, il nucleo è ben coperto da test:
- 447 test Rust, contati nel sorgente con tutte le feature;
- 2223 test TS più 7 saltati, eseguiti a fine Task 6 del passo 8, il 2026-10-16;
- un harness GPU di 68 check, in gran parte con probe sui pixel e guidato a mano.

Non c'è CI.

## 6. Una scelta strategica prima della strada

Il masterplan definisce Hyperion come una primitiva di rendering e lascia lo strato di gioco a chi lo usa. Il proprietario però vuole servire allo stesso modo tre mercati: motore di gioco, app canvas ed embedding desktop.

Prima di pianificare le fasi dopo il giro va decisa una forca:
- **(a) Hyperion resta un nucleo di rendering e simulazione.** L'animazione, le tilemap, le scene, la UI, i salvataggi e l'audio da gioco diventano una libreria TS a parte, o plugin, sopra l'API pubblica. Il nucleo deve comunque aggiungere quello che solo lui può dare: rettangoli UV, tinta, opacità, visibilità, specchio, scaricamento, mip e campionatore, interpolazione, isolamento degli errori, lettura dello stato.
- **(b) Hyperion diventa un motore di gioco completo**, con quello strato al suo interno: più lavoro, un'API più larga da mantenere, e il masterplan da riscrivere.

In entrambi i casi il lavoro sul nucleo (§7, fasi 1-3) è lo stesso. Cambia chi possiede il resto.

## 7. Una strada realistica verso un gioco completo

È un ordine proposto, da decidere col proprietario. Ogni fase è indipendente dal genere del gioco.

1. **Contenuti nel nucleo.**
   - Un rettangolo UV per i quad, quindi atlanti e sprite sheet.
   - Tinta, opacità e visibilità per entità.
   - Lo specchio (`cullMode: 'none'` sulle pipeline delle entità, con check GPU propri).
   - Lo scaricamento delle texture e un ciclo di vita per livello.
   - Texture non quadrate e sopra 512 px.
   - I mip e un campionatore *nearest* per la pixel art.
   - Un interruttore per l'FXAA.
2. **Loop e input.**
   - L'interpolazione fra i tick, oppure un passo fisso configurabile.
   - `tickFn` isolato dagli errori.
   - Una scala del tempo.
   - Gamepad, multi-touch, mappatura delle azioni e reset al cambio di focus.
3. **Prodotto.**
   - La build di produzione corretta e provata nel preflight.
   - Una licenza: nel `Cargo.toml` del workspace l'intenzione è MIT, ma manca il file.
   - Un pacchetto npm con i tipi e il WASM precompilato.
   - Una guida d'uso e un gioco d'esempio fuori dall'harness.
   - La CI.
4. **Strato di gioco** (in (a) libreria a parte, in (b) nell'engine).
   - Animazione a frame, con import Aseprite/TexturePacker.
   - Tween e timer.
   - Tilemap con import Tiled/LDtk e generazione dei collider.
   - Scene e livelli.
   - Testo: la pipeline MSDF completa, oppure helper per un HUD DOM ancorato al mondo.
   - Salvataggi.
   - Audio da gioco: musica in streaming, bus, dissolvenze.
   - Una camera con follow, limiti e scossa.
5. **Robustezza e piattaforme.**
   - Il recupero del device lost.
   - Gli errori d'avvio che rifiutano invece di restare appesi.
   - Il controllo di flusso dei tick in A e B.
   - Una Mode A alla pari, oppure fuori dal default su Chromium.
   - La verifica su Windows, Firefox e mobile.
   - La decisione sul fallback WebGL 2.
6. **Fisica per piattaforme e action:**
   - unità e gravità configurabili da TS e coerenti con la camera;
   - poligoni e collider da tile;
   - velocità, blocco della rotazione e piattaforme attraversabili dal basso;
   - filtri dei raggi.

## 8. Se lo vuoi provare subito in un progetto

Una ricetta che funziona già a fine giro, per un prototipo su desktop:
- Il repo come submodule; il WASM costruito con la toolchain fissata (`rust-toolchain.toml`, wasm-pack 0.14.0).
- **`preferredMode: 'B'` nella config.** Il default `'auto'` sceglie la Mode A su ogni Chromium isolato, e la Mode A non carica texture né muove la camera; almeno fallisce in modo evidente al primo `loadTexture`. Servono gli header COOP/COEP.
- In `vite.config.ts`, `worker: { format: 'es' }`, poi provare davvero il bundle di produzione.
- HUD e menu in DOM, sopra il canvas.
- Arte:
  - una texture per frame;
  - al più 255 immagini per tier e per sessione;
  - immagini quadrate da 64 a 512 px;
  - ogni sprite con pixel trasparenti marcato `.transparent()`, perché la pipeline opaca non ha alpha cutout e disegnerebbe il quad pieno;
  - niente scale negative, a meno di correggere `cullMode` in locale;
  - niente pixel art.
- La fisica dopo l'8b. I default sono gravità (0, +980), cioè verso l'alto dello schermo, e 100 unità per metro, e TS non li può cambiare. Vanno compensati:
  - `gravityScale(-1)` su ogni corpo dinamico;
  - `characterUp(0, 1)` su ogni controller;
  - una camera in unità adatte, da riapplicare dopo ogni `resize()`.
- Lo stato di gioco salvato lato TS.
- Solo desktop, Chrome o Safari su macOS: è l'unica combinazione verificata. Chrome su Linux funziona solo coi flag WebGPU; Edge e Windows non sono mai stati provati.

## 9. Metodo, evidenze e limiti

**Metodo.** Workflow `wf_92ca4389-831`:
- sei ricercatori in sola lettura, uno per dimensione: rendering e contenuti, modi e piattaforme, gameplay, strumenti e distribuzione, prestazioni e robustezza, roadmap e confronto;
- ogni affermazione verificata nel codice a `4d1940f` del branch `feat/step8-sprite-light`, cioè il passo 8 quasi completo;
- poi uno scettico su tutti i 75 problemi bloccanti o maggiori: 50 confermati, 25 ridimensionati in parte, 0 confutati, 2 trovati in più;
- in tutto 3,1 milioni di token e 795 chiamate di strumenti.

Questo documento è stato poi controllato da altri due agenti indipendenti (workflow `wf_b56de36b-4e7`), uno sui fatti e uno sulla fedeltà ai verdetti; le 27 correzioni che hanno trovato sono applicate.

**Dopo la verifica:**
- 5 bloccanti: quattro sono il modello delle texture, uno è la fisica, che chiude l'8b;
- 53 problemi maggiori, più i 2 trovati dallo scettico;
- 17 problemi minori.

Fra i minori ci sono:
- tutto il gruppo della Mode A di default: è reale, ma fallisce in modo evidente e si evita con `preferredMode: 'B'`;
- l'animazione e i tween: un animatore a frame si scrive lato gioco in TS, e la difficoltà vera è il modello delle texture (§2);
- la licenza (un file);
- la premessa su Firefox: secondo lo scettico, Gecko mappa `indirect-first-instance`, ma non è stato provato.

**Evidenze.** `docs/plans/assets/2026-10-16-readiness/assessment.json` contiene i sei rapporti, con capacità, problemi e citazioni file:riga, poi l'elenco dei 75 problemi e i verdetti dello scettico. Le citazioni sono relative al repo: il file non contiene percorsi locali.

**Limiti:**
- È un'analisi statica: nessuna misura di prestazione nuova.
  - I tempi vengono dalle evidenze committate dei passi precedenti.
  - Le dimensioni del WASM sono state lette sulle build locali (`ts/wasm` del 2026-10-16, `ts/wasm-physics` del 2026-10-10).
  - I test Rust sono contati nel sorgente a `4d1940f`.
- Il confronto con gli altri motori è a livello di lista di funzionalità.
- La stima di cosa porterà il giro segue il piano del giro (§2-§3): le scelte ancora aperte dell'8b e dell'8c possono spostare dettagli, non il verdetto.
