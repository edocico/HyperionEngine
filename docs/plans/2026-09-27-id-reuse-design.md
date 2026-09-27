# Passo 1b: riuso degli id esterni in quarantena (design)

HEAD `4fa4609` (master), 2026-09-27. Prodotto dal workflow `id-reuse-map` (`wf_f39b6322-af4`): 4 scout read-only (stato TS, ciclo di vita dei comandi, stato Rust, determinismo e API) e una sintesi. Le decisioni della §0 sono dell'utente.

## 0. Decisioni (2026-09-27)

| # | Domanda | Scelta |
|---|---|---|
| Q1 | Ordine di allocazione | **Prima i nuovi**: il contatore sale fino a `MAX_EXTERNAL_ID`, poi si pesca dal pool FIFO. La quarantena è attiva da subito |
| Q2 | `raw.despawn` su un id non vivo o di una handle viva | **No-op con warning `__DEV__`** se l'id non è vivo; **errore** se l'id appartiene a una handle viva |
| Q3 | `.id` di una handle distrutta | **Resta leggibile**; si documenta che quel numero può passare a un'altra entità |
| — | PhysicsAPI mai collegata alla WASM (trovato durante la mappatura) | Diventa un **passo nuovo del giro**, dopo L e prima della chiusura |

Il rafforzamento Rust della §3 (R1-R6) fa parte del passo 1b, in un commit a parte.

## 1. Meccanismo

**Proposta: solo quarantena, senza generation bits, con allocazione *fresh-first*.** Il contatore monotono resta com'è oggi (`hyperion.ts:72`, `:404-412`) e sale fino a `MAX_EXTERNAL_ID`. Solo quando lo spazio è esaurito si pesca da un pool **FIFO** di id già rilasciati. La quarantena è attiva fin dal primo `destroy()`, quindi gira in ogni sessione. Quello che si rimanda è solo il pop dal pool.

Motivi:
- **Perché niente generation bits.** Romperebbero:
  - il raycast, che restituisce `i32` (`lib.rs:623`, `physics.rs:409 id as i32`): un id con generazione ≥ 2048 diventa negativo e viene letto come "nessun hit";
  - il sentinel `u32::MAX` usato per "nessun genitore" (`components.rs:134-140`, `entity-handle.ts:278`);
  - la maschera di selezione indicizzata per id (`selection.ts:78-86`);
  - ogni metodo di `EntityMap`.
  
  Il formato dei comandi sul filo resta `u32`, quindi i generation bits si possono aggiungere più avanti senza rompere nulla.
- **Perché fresh-first.** Sotto 2^20 spawn cumulativi la sequenza degli id è identica a quella di oggi. Quindi `state_hash` (`engine.rs:1039-1195` hasha i VALORI degli id) e i tape restano indipendenti da modo, frame rate e backpressure. Il costo è che la `EntityMap` cresce fino al suo massimo storico (circa 9 MB a 1M di id), ma questo succede già oggi.
- **Perché FIFO.** Un id torna in uso il più tardi possibile, e questo riduce l'aliasing sugli id raw stantii.

**Cosa succede a chi tiene un riferimento stantio:**

| Riferimento | Esito |
|---|---|
| `EntityHandle` distrutta | Ogni metodo lancia un errore, come oggi. `.id` resta leggibile (vedi Q3). I 5 metodi dei joint lanciano se `!target.alive` |
| id raw in quarantena o nel pool | I comandi `raw.*` vengono scartati, con un warning `__DEV__` una sola volta |
| id raw dopo il riuso | **Colpisce l'entità nuova, in silenzio (ABA).** Si documenta. Con fresh-first capita solo dopo 1 048 576 spawn |
| id da picking o eventi fisici | Valido solo finché l'entità non viene distrutta (va documentato) |

## 2. Segnale "elaborato" e dove vive il pool

Serve un nuovo `ts/src/entity-id-allocator.ts`, posseduto da `Hyperion` sul main thread in tutti i modi, al posto di `nextEntityId`. Contiene:
- `next`;
- un bitset `live` da 2^20 bit (128 KB) più un bit di proprietario (handle o raw);
- la coda di quarantena, FIFO di `{id, seq, mark}`;
- il pool, un ring `Uint32Array` che raddoppia quando serve.

**Ciclo di vita di un id:**
1. **Free.** Viene da `releaseHandle` (`hyperion.ts:419`) o da `raw.despawn` (`raw-api.ts:24`). Se l'id è live: si azzera il bit, si mette l'id in quarantena, si invia `DespawnEntity`. Se non è live, non succede nulla. Così non ci sono doppi free e un id non è mai live due volte.
2. **Scritto.** `BackpressuredProducer` aggiunge un `flushSeq` (incrementato in `flush()`) e un listener dei despawn scritti. Il listener viene chiamato nel ciclo dei critici di `drainTo` (`backpressure.ts:210-219`) ed è separato dal recording tap, che l'utente può sostituire. Il listener timbra `seq = flushSeq`. Sotto backpressure il despawn resta nella coda TS e la voce resta senza timbro, quindi non si contano frame.
3. **Elaborato.** `EngineBridge` espone `processed: {seq, tickCount}`:
   - **Modo C:** assegnato alla fine di `tick()` (`worker-bridge.ts:414`). Push e update sono sincroni.
   - **Modo B:** il messaggio `tick` porta `seq` (`worker-bridge.ts:150`). `engine-worker.ts` lo rimanda in entrambi i rami di `tick-done` (`:212`, `:217`). Il bridge lo assegna nello stesso ramo di `latestRenderState` (`:116`). L'handler k parte dopo il flush k e legge fino al write head, quindi ha consumato il despawn.
   - **Modo A:** come B, ma `processed` va assegnato **prima** del filtro `entityCount > 0` (`:238`). Anche `latestRenderState` va sostituito con lo stato vuoto: oggi, con il mondo vuoto, si congela e il picking restituisce id morti. L'inoltro al render worker resta filtrato.
4. **Rilascio.** Avviene alla fine di `Hyperion.tick()`, dopo `_dispatch` (`:708`) e dopo il render:
   - una voce con `processed.seq ≥ seq` prende `mark = processed.tickCount`;
   - viene rilasciata quando `processed.tickCount > mark`, cioè dopo almeno un tick fisso successivo all'elaborazione.
   
   Il tick in più serve perché Rapier emette `Stopped` con l'id vecchio solo allo step successivo (`command_processor.rs:1439-1449`), e perché `update` può eseguire 0 tick (`engine.rs:205-209`). Effetto collaterale utile: lo spawn che riusa l'id riceve un'etichetta di tape strettamente maggiore di quella del despawn (`hyperion.ts:264`), quindi `ReplayPlayer` (`replay-player.ts:29-41`) non li mette mai nello stesso push.

   I critici escono in ordine, quindi la FIFO è monotona in `seq` e il rilascio si ferma alla prima voce non pronta: costo O(rilasciati).
   
   Segnali scartati:
   - `tickCount` da solo: non avanza nei frame a 0 tick, può tornare indietro e in Modo A si congela;
   - read head e heartbeat: in Modo C non esistono, e non dicono niente sullo stato del main thread.

## 3. Stato indicizzato per id

**TypeScript**

| Stato | Dove | Oggi | Cosa fa il passo 1b |
|---|---|---|---|
| Override di `ImmediateState` | `immediate-state.ts:10` | Pulito da `destroy()` (`entity-handle.ts:674`); **non** da `raw.despawn` | `clear(id)` al free, per entrambi i percorsi |
| `SelectionManager.selected` | `selection.ts:10` | Mai pulito | `selection?.deselect(id)` al free (in Modo A è null e non c'è nulla da pulire) |
| `entityId` dell'emitter di particelle | `particle-system.ts:29`, `:247` | Mai pulito; quando l'id sparisce l'emitter torna a (0,0) | Nuovo `forgetEntity(id)` al free: aspetto identico, ma l'emitter non segue più il nuovo proprietario |
| `_sensorEnter` / `_sensorExit` | `physics-api.ts:126-127` | Mai puliti. Latenti: `_init` (`:130`) non ha chiamanti | Puliti **al rilascio**, così l'ultimo exit arriva ancora alla registrazione vecchia |
| Overwrite in coda con chiave X | `backpressure.ts:139`, `:172-181` | Già purgati all'accodamento del despawn | Il controllo live in `RawAPI` blocca quelli accodati dopo |
| `SetParent(figlio, X)` in coda | `backpressure.ts:335` | **Non purgato**: la sonda S1 lo aggancia alla X nuova | Purgato all'accodamento del despawn, con un indice genitore→figli nella coda |
| Joint verso un target morto | `entity-handle.ts:592-623` | Nessun controllo | Lancia se `!target.alive` |
| Storage dei plugin `Map<number,T>` | `plugin-context.ts:61`, `:69` | Nessuna notifica | Evento `entity:released` sull'EventBus al rilascio; contratto documentato |
| `LeakDetector`, `JointHandle`, prefab, audio, SpatialGrid | — | Già corretti o senza stato per id | Niente |

**Rust**

| Stato | Dove | Oggi | Cosa fa il passo 1b |
|---|---|---|---|
| `EntityMap`, slot, gerarchia, `character_map`, `joint_map`, `pending_teleports` | `command_processor.rs:686-693`, `:1083-1091`, `:1341-1362` | Già corretti (`verify_findings` v1/v2, `verify_hier` h1/h3) | Niente |
| `MoveCharacter` → `pending_moves` | `physics_commands.rs:247-268` | Nessun controllo sull'id; la voce sopravvive ai frame a 0 tick | Scartare se l'id non è mappato |
| Creazione di joint → `pending_joints` | `command_processor.rs:1142-1245` | Nessun controllo su A e B | Rifiutare se A o B non sono mappati, come fa `SetParent` (`:826`) |
| Spawn su un id ancora vivo | `command_processor.rs:462-477` | Niente `despawn_physics_cleanup`: il corpo Rapier resta orfano e la CC passa al nuovo id | Chiamarlo sotto `physics-2d` |
| Id duplicato in un run di spawn | `command_processor.rs:493-497`, `:612` | Un'entità resta orfana | Dedupe dentro il run |
| Seconda passata nello stesso batch | `engine.rs:163-179` | I comandi della vecchia X finiscono sulla X nuova | La passata 2 ignora i comandi per X che precedono l'ultimo re-spawn di X nel batch |
| `EntityMap::allocate` / `free_list` | `command_processor.rs:89-97`, `:186` | Codice morto; dopo un restore restituisce id live | Da eliminare |
| `collider_to_entity` indicizzato solo per indice | — | Difetto preesistente: attribuisce `Stopped` a un'altra entità | **Separato**, da registrare. Il commento a `:1447-1449` è sbagliato |

## 4. Piano di test (tutti rossi prima di toccare il codice)

**Vitest**
1. `entity-id-allocator.test.ts`, con `maxId = 3` iniettato:
   - un loop spawn/destroy oltre il cap non lancia;
   - nessun rilascio finché manca uno fra: scritto, `processed.seq ≥ seq`, tick avanzato;
   - l'ordine del pool è FIFO;
   - un doppio free non fa uscire lo stesso id due volte.
2. `backpressure.test.ts`:
   - il listener scatta alla **scrittura**, non all'accodamento;
   - con un ring piccolo (`new SharedArrayBuffer(32 + cap)`) il despawn resta in coda per N flush e l'id non viene rilasciato, anche con tick avanzati;
   - `SetParent(5, X)` viene purgato dal despawn di X (sonda S1).
3. `hyperion.test.ts`, con un bridge mock che espone `processed`:
   - un frame a 0 tick trattiene l'id;
   - lo spawn che riusa l'id finisce in un flush successivo, con etichetta di tape strettamente maggiore di quella del despawn;
   - dopo `select`, `positionImmediate`, un emitter e `onSensorEnter` sulla vecchia X, poi destroy e riuso: la nuova X non eredita nulla, e l'ultimo `Stopped` arriva alla callback vecchia.
4. `raw-api.test.ts`:
   - doppio `raw.despawn` o id mai allocato: un solo `DespawnEntity`;
   - `raw.setPosition` su un id in quarantena viene scartato;
   - `raw.despawn(handle.id)` si comporta secondo Q2.
5. `entity-handle.test.ts`: tutti e 5 i joint verso un target morto lanciano.
6. Estrarre in `worker-bridge.ts` un helper puro `readTickAck(msg)` e testarlo: B e A rimandano `seq`, e A avanza anche con `entityCount == 0`.

**Rust** (`tests/verify_reuse.rs`, `--all-features`)
- R1: `[MoveCharacter 7, Despawn 7]` in un frame a 0 tick non lascia nulla in `pending_moves` (sonde C/D).
- R2: `[Despawn 7, CreateFixedJoint(1,7)]`, poi re-spawn con corpo: `joint_map` vuoto (sonde D/E).
- R3: spawn su un 7 vivo con corpo e CC: 0 corpi orfani, nessuna CC (sonda F).
- R4: `[Spawn 7, Spawn 7]`: `world.len() == 1` (sonda G).
- R5: `[SetGravityScale 7, Despawn 7, Spawn 7, CreateRigidBody 7, CreateCollider 7]` in **un** batch: `gravity_scale == 1.0` (sonda A).
- R6: lo stesso in due push, come guardia di regressione (sonda B).

**Harness GPU**
- Check nel tab Lifecycle con un cap di id piccolo, impostato tramite un seam solo `__DEV__`, nei Modi B e C (il Modo A dipende dal passo 10).

## 5. Rischi e decisioni

**Rischi**
- **Percorso del pool freddo.** Il pop dal pool gira solo dopo 2^20 spawn. Il seam per il cap (test e harness) è obbligatorio.
- **Latenza.** Un id aspetta almeno 1 tick fisso più un giro di messaggi. Con fresh-first è irrilevante.
- **Time-travel.** Il restore non è collegato al facade. Quando lo sarà, deve chiamare `allocator.resync(liveIds)`, altrimenti il pool conterrà id live. Il vincolo va scritto nel doc dell'allocatore.
- **Despawn perso.** Un opcode sconosciuto scarta la coda del batch (`engine.rs:375`), `DespawnEntity` compreso, ma l'ack arriva comunque. R3 impedisce che ne esca fisica orfana.
- **Documenti da riscrivere in questo passo:**
  - `types.ts:61-66`, `hyperion.ts:399-418` e `PROJECT_ARCHITECTURE.md:1698`, che dicono "ids are never reused";
  - in CLAUDE.md: la riga su `entity-pool.ts` e quella su "pool init()";
  - in CLAUDE.md: il default del tape, che è 1 000 000 (`command-tape.ts:22`) e non 600 000;
  - in CLAUDE.md: il campo `entity_id` dei comandi joint, che è `_entityA`.
- **Fuori scope, da registrare:**
  - `ecs-inspector.ts:114` chiama `selection.selectedIds()` come metodo, ma è un getter che restituisce un iteratore, e `selection` può essere null. Il mock in `ecs-inspector.test.ts:26` nasconde il bug;
  - la maschera di selezione indicizzata per id contro lo slot SoA è già nel piano al passo 3.

**Decisioni per te**
- **Q1. Ordine di allocazione.**
  - (a) fresh-first con pool FIFO;
  - (b) riuso subito, FIFO: id densi, ma id e hash dipendono dal timing fin dal primo destroy;
  - (c) riuso subito, LIFO: aliasing più rapido.
  
  **Consiglio (a).**
- **Q2. `raw.despawn` su un id non live, o su un id posseduto da una handle viva.**
  - (a) id non live: no-op con warning `__DEV__`; id di una handle: lancia;
  - (b) no-op in entrambi i casi;
  - (c) uccide anche la handle (serve una mappa id→`WeakRef`).
  
  **Consiglio (a).** In `ts/src` non esiste nessuna chiamata a `raw.despawn` fuori dai test.
- **Q3. `.id` di una handle distrutta.**
  - (a) resta leggibile, e si documenta;
  - (b) lancia: cambia l'API pubblica, e il numero si può comunque copiare prima.
  
  **Consiglio (a).**

L'hardening Rust della §3 è difesa in profondità. Si può staccare in un commit a parte, perché nessun test TS dipende da esso. La mia proposta è farlo nel passo 1b.
