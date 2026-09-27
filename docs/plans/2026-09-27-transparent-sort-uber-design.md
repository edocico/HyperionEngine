# Fase 5b: ordinamento dei trasparenti — GPU sort + uber pipeline (design)

HEAD `72c0f7e` (master), 2026-09-27. Il design è stato approvato sezione per sezione in due sessioni di brainstorming (lo stato è in `2026-09-27-transparent-sort-uber-brainstorm.md`). I workflow usati:

| Workflow | Contenuto |
|---|---|
| `wf_537ea535-af9` | 3 designer indipendenti, 2 giudici e 2 scettici sul sort. Il JSON completo è in `assets/2026-09-27-transparent-sort-design-workflow.json` |
| `wf_ad447cec-c9d` | Verifica dei fatti su cull, buffer, ForwardPass e spec WGSL. Le regole della spec sono state provate compilando shader su Chrome 154 con l'iGPU AMD |
| `wf_5bce1f00-66e` | Inventario dei sei shader, dei test sul testo WGSL, degli slot HMR e della documentazione |
| `wf_7b307272-b6a` | Siti Rust che cambiano la mappatura slot→id o il bit trasparente; trasporto di `GPURenderState` nei tre Mode |

Le decisioni della §0 sono dell'utente.

## 0. Decisioni (2026-09-27)

| # | Domanda | Scelta |
|---|---|---|
| D1 | Approccio | **GPU sort + un solo draw uber**, come fase a sé |
| D2 | Trasparenti alla stessa z | **Sta davanti l'id esterno più alto**, cioè l'entità più recente |
| D3 | Scala | Fino a **~100k trasparenti visibili, sort < 1 ms** sull'iGPU AMD. Serve un radix sort STABILE su GPU; bitonic è escluso |
| D4 | Modulo uber | **Preludio + una libreria per primitiva** con funzioni prefissate. Un compositore TS ricava dagli stessi pezzi sia i moduli per tipo sia il modulo uber |
| D5 | Id sulla GPU | **Colonna `entity-ids` separata.** La parola 0 di `renderMeta` resta al `MeshHandle`, perché arriveranno le mesh 3D |
| D6 | Upload degli id | Tutta la colonna, **solo quando la mappatura slot→id cambia**. Si rileva con un **contatore di generazione** in `Engine` (è il raffinamento approvato del "flag per frame") |
| D7 | A cosa serve `transparentCount` | Dimensiona solo il gather e fa da salto a costo zero. **Il sort si dimensiona dal conteggio GPU**, con dispatch indiretti |
| D8 | Dettagli della composizione | `primType` come varying flat; reload dei pezzi raggruppati; `basic.wgsl` rinominato in `quad` |
| D9 | Come si ottiene `transparentCount` | **Ricalcolo** sulle righe ogni frame, non contatore incrementale |
| D10 | `maxEntities` oltre la capacità GPU | `validateConfig` **rifiuta** `maxEntities > MAX_GPU_ENTITIES` |

## 1. Obiettivo e perimetro

**Il problema.** La review del passo 5 (`wf_60bf12aa-fa0`) ha trovato che la depth non ordina due sprite `.transparent()` sovrapposti. La pipeline trasparente non scrive la depth e niente ordina: `RadixSortPass` è morto nel grafo, e comunque è rotto. L'ordine tra trasparenti quindi viene dal draw: prima il tipo di primitiva, con i box shadow per ultimi, poi l'ordine del cull, che dipende dagli atomic ed è indefinito. Quasi ogni sprite 2D con alfa è trasparente (PNG, ombre), quindi il buco è concreto.

**Obiettivo.** Le primitive trasparenti di tipo 0-5 si disegnano **dal fondo al davanti per z di mondo** (`entity-bounds.z`). A parità di z sta davanti l'id più alto. L'ordine è deterministico da un frame all'altro, e tutto passa in **un solo draw**.

**Fuori perimetro. Queste cose non cambiano:**
- Le pipeline opache, l'occluder, `LightAccumStage` (legge ancora i bucket 26/27), la selezione e i 28 bucket del cull. `cull.wgsl` e `CullPass` non si toccano.
- Un trasparente alla stessa z di un opaco sovrapposto resta nascosto, per il `depthCompare: 'less'` stretto. È così già oggi.
- I trasparenti non ricevono il contorno di selezione: `SelectionSeedPass` disegna solo i bucket 0/1. È così già oggi.
- La chiave è la z di mondo perché la camera guarda sempre lungo -Z. Una camera che ruota o prospettica richiederebbe la profondità di vista come chiave. Non esiste oggi.
- Mode A: la trasparenza funziona lì come altrove, ma su questa macchina non si può verificare sulla GPU (passo 10 del giro).
- La trasparenza indipendente dall'ordine (OIT).

**Criteri di successo:**
- I check pixel nuovi (§7.3) sono verdi in Mode B e Mode C.
- I 10 tab dell'harness sono verdi.
- Gli opachi sono identici al pixel alla baseline.
- `readTransparentSort()` coincide con l'oracolo CPU ed è stabile tra frame consecutivi.
- Il sort resta sotto 1 ms a 100k trasparenti visibili sull'iGPU AMD.
- Il costo del `forward` rispetto a master è misurato e documentato.

## 2. Architettura

```
ScatterPass → CullPass (invariato) → TransparentSortPass → ForwardPass
                                      gather                 opachi: 6 pipeline per tipo (invariate)
                                      7 × (upsweep,          trasparenti: 1 pipeline uber,
                                           scan, scatter)      1 drawIndexedIndirect(transparent-args, 0)
```

La fase si compone di quattro pezzi, da implementare in quest'ordine (§8). Ognuno si verifica da solo:
1. **Composizione degli shader** (§3): preludio + librerie + compositore. Nessun cambio di comportamento.
2. **Colonna id e conteggio dei trasparenti** (§4): Rust, trasporto, upload.
3. **Gather + sort** (§5): `TransparentSortPass`.
4. **Draw uber** (§6): il sub-pass trasparente di `ForwardPass` diventa un solo draw.

## 3. Composizione degli shader

### 3.1 File e pezzi

`ts/src/shaders/primitives/` contiene `prelude.wgsl` più sei librerie:

| Libreria | Tipo | Viene da | Prefisso |
|---|---|---|---|
| `quad.wgsl` | 0 | `basic.wgsl` | `quad_` |
| `line.wgsl` | 1 | `line.wgsl` | `line_` |
| `msdf-text.wgsl` | 2 | `msdf-text.wgsl` | `msdf_` |
| `bezier.wgsl` | 3 | `bezier.wgsl` | `bezier_` |
| `gradient.wgsl` | 4 | `gradient.wgsl` | `gradient_` |
| `box-shadow.wgsl` | 5 | `box-shadow.wgsl` | `boxshadow_` |

I sei file di oggi in `ts/src/shaders/` vengono eliminati.

**Il preludio** contiene i nomi condivisi, senza prefisso:
1. `struct CameraUniform`, nella forma di `line.wgsl` (80 B): `viewProjection`, `occluderLayers`, `viewportWidth` (68), `viewportHeight` (72) e un pad.
2. I binding del gruppo 0 (b0-5), del gruppo 1 (b0-8) e del gruppo 2 (b0-2), identici a oggi.
3. `override OCCLUDER_PASS: bool = false`, `CASTS_SHADOW_BIT`, `castsInto`.
4. Il blocco luci: `RECEIVES_LIGHT_BIT`, `LightingUniform`, `lightGroupOf`, `applyLighting(in, color)`. È il blocco illuminato di oggi, alla lettera.
5. `struct VertexOutput` come superinsieme:
   - locazioni 0-5 come oggi;
   - 6 `edgeScale: f32`, interpolato con la prospettiva e NON flat;
   - 7 `@interpolate(flat) transparent: u32`;
   - 8 `@interpolate(flat) primType: u32`.

   Sono 9 locazioni sul limite di 16 (`maxInterStageShaderVariables`). I campi in più valgono zero, perché `var out: VertexOutput` è inizializzato a zero.
6. Gli helper:
   - `culledVertex()`;
   - `finishVertex(clip, uv, entityIdx)`: decodifica la texture impacchettata, calcola `screenUV` e i campi flat;
   - `unitQuadVertex(position, entityIdx, uv)`;
   - `sampleTier(in)`: lo switch a 8 vie, CRUDO;
   - `sampleTierOrWhite(in)`: restituisce il bianco quando l'indice impacchettato è 0;
   - `occluderSeed(in, alpha)`.

**Il contratto di una libreria.**
- Espone esattamente tre funzioni: `<p>_vs(position: vec3f, entityIdx: u32) -> VertexOutput`, `<p>_fs(in: VertexOutput) -> vec4f` e `<p>_occluder(in: VertexOutput) -> vec4f`.
- Ogni altro nome di primo livello comincia con il suo prefisso.
- Nessun binding, nessun entry point, nessuna direttiva.
- Nessun riferimento a `lighting`, `lightBuffer` o `lightGroupOf`. L'illuminazione passa solo per `applyLighting`, chiamata esclusivamente da `quad_fs` e `gradient_fs`.
- La stringa `fn fs_occluder` non compare in nessun pezzo.

**Comportamento da conservare alla lettera:**
- `msdf_shade` usa `sampleTier` crudo, senza il bianco sull'indice 0. Con `sampleTierOrWhite`, un glifo con indice 0 diventerebbe un rettangolo pieno su BC7/ASTC.
- `line` tiene:
  - il suo `fs`: `discard` fuori dal tratto quando `transparent == 0`;
  - il suo `occluder`: `a <= 0 || !insideStroke`;
  - `transparent` calcolato dal bit 8 e non cablato;
  - `edgeScale` interpolato con la prospettiva;
  - `fwidth(in.uv.y)` come prima istruzione di `line_shade`.
- `line_vs` legge `OCCLUDER_PASS` per la larghezza minima del tratto. Per questo l'override sta nel preludio, anche nell'uber.
- L'illuminazione resta per caso, dentro `quad_fs` e `gradient_fs`. Non si applica mai dopo lo switch dell'uber: gli altri tipi diventerebbero illuminati, e `deriveLightGroups` non lo modella.
- Il gruppo 2 si raggiunge staticamente solo da `fs_main`. Dichiararlo in ogni modulo è valido, come verificato sulla GPU: una pipeline `fs_occluder` si crea sul layout a due gruppi finché non lo raggiunge.
- `camera`, `transforms` e `visibleIndices` sono visibili solo al vertex stage: il fragment non li può leggere.

### 3.2 Compositore

Il compositore sta in `ts/src/render/primitive-shaders.ts` ed è TS puro:
- la tabella `PRIMITIVE_LIBRARIES: readonly {type, name, prefix, lit}[]`. È l'unica fonte da cui si ricava `LIT_PRIMITIVE_TYPES`, che oggi è scritto a mano in `light-groups.ts:78`;
- i pezzi correnti in statiche: `prelude` e `libraries[type]`;
- `composeTypeModule(pieces, type)`, `composeTypeModules(pieces)` e `composeUberModule(pieces)`.

È **totale**: fa solo concatenazione e non lancia eccezioni. Mette un marcatore `// --- piece: <nome> ---` davanti a ogni pezzo, così le righe degli errori di compilazione si possono ricondurre al pezzo. Le dichiarazioni di modulo in WGSL si possono usare prima di essere dichiarate, quindi l'ordine dei pezzi non conta. Solo le direttive devono venire prima di tutto.

**Modulo per tipo** = preludio + libreria + questi wrapper generati:
```wgsl
@vertex
fn vs_main(@location(0) position: vec3f, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
    let entityIdx = visibleIndices[instanceIdx];
    if (OCCLUDER_PASS && !castsInto(renderMeta[entityIdx * 2u + 1u], camera.occluderLayers)) { return culledVertex(); }
    var out = P_vs(position, entityIdx);
    out.primType = T;
    return out;
}
@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f { return P_fs(in); }
@fragment fn fs_occluder(in: VertexOutput) -> @location(0) vec4f { return P_occluder(in); }
```
Le condizioni dell'early-out dell'occluder restano quelle di oggi. `OccluderSeedStage` riconosce i moduli con `code.includes('fn fs_occluder')`, e questo non cambia.

**Modulo uber** = `diagnostic(off, derivative_uniformity);` in **prima riga**, poi il preludio, le sei librerie e questi wrapper:
- `vs_main`:
  1. `e = visibleIndices[instanceIdx]`;
  2. `t = min(renderMeta[e*2u+1u] & 0xFFu, 6u)`, lo stesso clamp di `cull.wgsl`;
  3. `switch t`: i casi 0-5 chiamano `<p>_vs`, il `default` (6 = Light2D) restituisce `culledVertex()`;
  4. `out.primType = t`.

  Non c'è l'early-out dell'occluder.
- `fs_main`: `switch in.primType`, un caso per libreria, e ogni caso restituisce `<p>_fs(in)`.
- Non c'è `fs_occluder`, e l'uber non sta in `ForwardPass.SHADER_SOURCES`.

**Perché la direttiva sta solo nell'uber.**
- In WGSL la severità di un diagnostic si decide dove viene chiamata la builtin, non dove sta il ramo. Verificato: `@diagnostic` su `fs_main` o sullo `switch` NON spegne l'errore quando `fwidth`/`dpdx` sono dentro `line_shade`, `bezier_shade` o `msdf_shade`. Funzionano solo la direttiva globale e l'attributo sulla funzione chiamata.
- L'attributo sulla funzione chiamata finirebbe anche nei moduli per tipo, e spegnerebbe il controllo pure lì.
- Con la direttiva solo nell'uber, i moduli per tipo compilano lo **stesso codice di libreria** sotto l'analisi stretta. Una derivata davvero non uniforme introdotta in una libreria viene quindi segnalata lì.
- Nell'uber lo switch è uniforme sul quad 2×2: il tipo è per istanza, e i quattro frammenti di un quad appartengono allo stesso triangolo.

### 3.3 Pipeline e hot-reload

**Pipeline.**
- `ForwardPass.SHADER_SOURCES` contiene i 6 moduli per tipo composti; `ForwardPass.UBER_SOURCE` contiene il modulo uber.
- Le pipeline opache per tipo e gli occluder (`LightGroupsPass` → `OccluderSeedStage`) restano come oggi.
- La pipeline uber sta in `ForwardPass` (§6.2).

**Slot HMR.**
- 7 slot di pezzo (`prelude`, `quad` con alias `basic`, `line`, `msdf-text`, `bezier`, `gradient`, `box-shadow`) prendono il posto dei 6 slot di modulo.
- `write()` di un pezzo aggiorna la statica e **ricompone sul posto** `SHADER_SOURCES` e `UBER_SOURCE`, mantenendo lo stesso oggetto: i riferimenti tenuti da factory e probe restano validi.
- Il probe resta `new ForwardPass()` (6 pipeline opache + l'uber) più `new LightGroupsPass(SHADER_SOURCES)` (occluder). Tutti gli slot di pezzo sono `usedBy: inEveryMode`.
- Il ripristino dopo un rifiuto funziona già, a condizione che `write()` ricomponga.

**Due rinforzi a `GraphRequests`:**
- **`write()` non può lanciare.** Il compositore è totale. La guardia sul pezzo vuoto sta DENTRO il probe (nel `setup`), che lancia in modo sincrono.
- **Reload raggruppato.** Nuovo `reloadShaders(entries)`: scrive tutti i candidati, esegue una sola volta l'unione dei loro probe, ripristina tutto e tiene una versione per nome. Gli `accept` dei pezzi si raccolgono con un breve debounce. Senza questo, un nome cambiato nel preludio insieme al suo uso in una libreria arriva come due update Vite separati, entrambi vengono rifiutati, e ricaricare la pagina su questa macchina significa perdere il device.

**Gli altri punti toccati:**
- Gli `accept` restano in `renderer.ts`, accanto agli import `?raw` dei pezzi: `hot.accept(dep)` funziona solo nel modulo che importa `dep`.
- `recompileShader('basic' | 'quad' | …)` ora riceve un PEZZO, non un modulo completo. Va detto nel suo JSDoc.
- Lo slot `radix-sort` va via, ed entrano `transparent-gather` e `transparent-sort` (§5.8).
- Conti finali: **22 file WGSL importati, 20 ricaricabili a caldo**. In totale i file `.wgsl` diventano 24: 17 al primo livello più i 7 pezzi.

### 3.4 Test della composizione

I 133 `expect` che oggi leggono il testo dei sei file (36 A / 74 B / 21 C / 2 D; il dettaglio è nell'inventario di `wf_5bce1f00-66e`) si riscrivono sui **moduli composti**, che il compositore produce senza browser.
- I controlli uguali in tutti i moduli (58) diventano controlli sul preludio più uno solo: "ogni modulo composto contiene il preludio alla lettera".
- Gli ancoraggi per slice e regex che nominano simboli di libreria passano ai nomi con prefisso. Ogni ancoraggio deve esistere (indice ≥ 0) prima di un `not.toMatch`.
- I controlli di "file che dichiarano `@group(2)`" diventano controlli di **raggiungibilità**: si costruisce il grafo delle chiamate dal testo composto, e `applyLighting` deve essere raggiungibile da `fs_main` ⇔ il tipo è `lit`, sia nei moduli per tipo sia in ogni caso dell'uber. Da `fs_occluder` e da `vs_main` non devono essere raggiungibili né `lighting` né `lightBuffer`.

**Test nuovi:**
- Nell'uber tutti i nomi di primo livello sono unici, e ogni nome di libreria ha il suo prefisso.
- Nessun `let` locale ha lo stesso nome di un globale del preludio (in WGSL lo nasconderebbe in silenzio).
- La direttiva sta solo nell'uber, in prima riga; i moduli per tipo non ne hanno.
- L'uber non ha `fs_occluder`, fa il clamp del tipo come `cull.wgsl`, e il caso 6 restituisce `culledVertex`.
- Le librerie non hanno binding, entry point, direttive né `fn fs_occluder`.
- `LIT_PRIMITIVE_TYPES` è ricavato dalla tabella.
- `uniform-layout.test.ts` e `storage-budget.test.ts` girano ANCHE sui 7 moduli composti, uber compreso. Il loro glob esclude i pezzi, e le soglie sul numero di file vanno aggiornate: oggi `storage-budget` si aspetta almeno 19 file.

## 4. Colonna id e conteggio dei trasparenti

### 4.1 Rust

**`transparent_count`: si ricalcola.** Si contano i bit 8 (`RENDER_META_TRANSPARENT_BIT`) di `gpu_render_meta[1 + 2i]` per `i < gpu_count`:
- alla fine di `collect_and_cache_dirty`, dopo la riscrittura delle righe sporche;
- in `snapshot_restore`;
- `reset` lo porta a 0.

Costo nativo: 7-17 µs a 100k. Il conto va limitato a `gpu_count`: le righe oltre contengono dati vecchi, e gli accessor `gpu_render_meta()`/`gpu_entity_ids()` restituiscono tutto il Vec. Il conteggio include le Light2D trasparenti, quindi è un **limite superiore** di ciò che il forward ordina. Va bene così: serve a dimensionare.

Un contatore incrementale è stato scartato per due motivi:
- `clear_slot` gira dopo `gpu_count += 1`, su una riga che può avere un bit vecchio mai contato;
- il componente `Transparent` è in anticipo di un frame sulla riga, quindi un contatore basato sul componente sbaglierebbe.

**`ids_generation: u32`.** Vive in **`Engine`**, non in `RenderState`, perché `reset`, `snapshot_restore` ed `engine_init` ricreano `RenderState` da zero. Un contatore lì ripartirebbe da 0 e potrebbe coincidere con il valore già caricato in TS.
- `RenderState` alza un flag interno `ids_changed` in tre punti:
  - `assign_slot`, dopo l'early return idempotente;
  - `flush_pending_despawns`, quando rimuove almeno una riga;
  - `collect_gpu` (legacy).
- `Engine::update` raccoglie e azzera il flag dopo `collect_and_cache_dirty`, e fa `wrapping_add(1)` **al massimo una volta per frame**.
- `reset` e `snapshot_restore` incrementano sempre.
- Il riuso degli id (`SpawnEntity` su un id vivo) passa da `queue_despawn` + `assign_slot`, quindi è coperto.

**Esportazioni** (`lib.rs`, stesso schema di `engine_gpu_entity_count`, con un commento SAFETY): `engine_gpu_transparent_count() -> u32` ed `engine_gpu_entity_ids_generation() -> u32`.

### 4.2 Trasporto

`transparentCount` ed `entityIdsGeneration` diventano campi di `GPURenderState`. Viaggiano **dentro `renderState`**, non sul messaggio: `tickCount`, che sta sul messaggio, nel render worker del Mode A vale 0 per questo motivo.

| Sito | Cambio |
|---|---|
| Mode C, `worker-bridge.ts` ~495-522 e ~524-545 (pieno e vuoto) | letti con `engine.engine_x?.()`; interfaccia WASM ~378-432 |
| `engine-worker.ts` 190-216 e 218-234, più il tipo inline 129-146 | nei due literal di `renderState` |
| Mode B, `worker-bridge.ts` ~133-155 | `rs.transparentCount`, `rs.entityIdsGeneration` |
| Mode A, copia sul main thread ~267-289 | come il Mode B; `rs` viene inoltrato intero al render worker |
| `render-worker.ts`: tipo `RenderState` 21-39 e ricostruzione 92-113 | i due campi |
| `render/render-pass.ts`, `FrameState` | `transparentCount` (già normalizzato) |

**Normalizzazione nel renderer.** I messaggi dei worker sono `any`, quindi `tsc` non vede un campo dimenticato. La regola è che un campo mancante costi tempo, mai correttezza:
- conteggio assente o non finito → `entityCount`;
- generazione assente o non finita → `NaN`. Siccome `NaN !== NaN`, l'upload avviene a ogni frame: corretto, solo più lento;
- in dev, un warning una tantum.

Un default costante come 0 sulla generazione congelerebbe l'upload dopo il primo frame, quindi è **vietato**.

**Test.** Una factory condivisa `makeRenderState(overrides)` prende il posto dei tre literal scritti a mano (`integration.test.ts:59`, `hyperion.test.ts:315`, `lighting-api.test.ts:9`); `debug-line-pass.test.ts:15` va aggiornato per `FrameState`.

### 4.3 Upload

- `entity-ids` è un **buffer del pool posseduto dal renderer**, creato in `createRenderer` accanto a `selection-mask`: `MAX_GPU_ENTITIES × 4` B, `STORAGE | COPY_DST`, più `COPY_SRC` in dev.
- Il marcatore `uploadedIdsGeneration` è una **variabile locale della closure**, inizializzata a `NaN`.
- Il `writeBuffer(entity-ids, 0, state.entityIds, 0, entityCount)` sta **tra la fine dell'if/else degli upload (`renderer.ts` ~831) e la selection mask (~833)**. Così gira anche nei frame con lo scatter del Mode C: lo staging a 32 parole non ha spazio per l'id, e uno swap-remove sposta le righe tra gli slot.
- Né il buffer né il marcatore possono vivere in un pass: gli swap del grafo e i probe dell'hot-reload rifanno il `setup()`, e il buffer tornerebbe vuoto mentre il marcatore dice "già caricato".
- A 100k sono 400 KB, solo nei frame in cui la mappatura cambia.

## 5. Il sort

### 5.1 Chiave

Ogni elemento ha due parole: **`lo = id esterno`** (al massimo 20 bit, `MAX_EXTERNAL_ID = 2^20 − 1`) e **`hi = zKey`**.
- `zb` sono i bit di `entity-bounds[slot].z`, letto come `vec4<u32>` perché nessuna operazione in virgola mobile tocchi la z.
- Il -0 si normalizza con un confronto intero: `if (zb == 0x80000000u) { zb = 0u; }`.
- `zKey = select(zb | 0x80000000u, ~zb, (zb & 0x80000000u) != 0u)`.

L'ordine crescente per (zKey, id) va **dal fondo al davanti**. La camera guarda lungo -Z e la z di una riga 2D è -depth, quindi una z minore è più lontana. A parità di z, l'id più alto viene disegnato dopo, cioè sta davanti.

**7 passate LSD da 8 bit**, con `digit(p) = p < 3 ? (lo >> 8p) & 0xFF : (hi >> 8(p−3)) & 0xFF`. Le passate 0-2 guardano solo l'id, le 3-6 solo la z. Le chiavi sono uniche perché gli id lo sono, quindi l'uscita è **un'unica permutazione**, confrontabile bit per bit con un `Array.sort` in JS.

Non si usa la colonna `gpu_depths`: per il 2D contiene +depth senza la composizione del genitore, per il 3D la z locale.

### 5.2 Buffer (a `CAP = MAX_GPU_ENTITIES = 100 000`)

| Buffer | Possessore | Dimensione | Usage | Contenuto |
|---|---|---|---|---|
| `entity-ids` | renderer, pool | 400 000 B | STORAGE, COPY_DST (+COPY_SRC dev) | slot → id esterno (§4.3) |
| `transparent-args` | renderer, pool | 64 B | STORAGE, INDIRECT, COPY_DST (+COPY_SRC dev) | l'header, qui sotto |
| `transparent-order` | renderer, pool | 400 000 B | STORAGE (+COPY_SRC dev) | = valori B: gli slot ordinati, letti dal draw uber |
| `sort-keys-a` / `sort-keys-b` | pass, privati | 800 000 B ciascuno | STORAGE (+COPY_SRC dev) | SoA in un solo buffer: `lo[0..CAP)`, poi `hi[CAP..2CAP)` |
| `sort-vals-a` | pass, privato | 400 000 B | STORAGE (+COPY_SRC dev) | slot, lato A |
| `sort-hist` | pass, privato | (16 + 7·256 + 98·256) × 4 = 107 584 B | STORAGE, COPY_DST (+COPY_SRC dev) | `diag: array<atomic<u32>,16>`, `digitBase: array<u32, 1792>` (una riga per passata), `tiles: array<u32>` (98 tile × 256) |
| `sort-gather-params` | pass | 16 B | UNIFORM, COPY_DST | `{limit, _pad0, _pad1, _pad2}` |
| `sort-pass-params` | pass | 7 × 256 B | UNIFORM, COPY_DST | slice *p* = `{passIndex = p, 0, 0, 0}` |

**L'header `transparent-args`, parola per parola:**
- 0-4: `DrawIndexedIndirect {6, n, 0, 0, 0}`;
- 5-7: `DispatchIndirect {ceil(n/1024), 1, 1}`, all'offset 20 B;
- 8: `raw`, la somma dei 12 conteggi;
- 9: `limit`;
- 10: `overflow = raw > limit`;
- 11-15: riservate.

`diag[0]` ha due bit: bit 0 = la somma dello scan è ≠ n; bit 1 = una destinazione dello scatter è ≥ n.

Totale circa 2,9 MB, fissi. Non c'è un percorso di crescita, e ogni voce di layout ha `minBindingSize`. Si creano 8 bind group nel `setup()`: 1 per il gather e 7 per il sort. Il bind group della passata *p* fissa la sua slice e la direzione: A→B per *p* pari, B→A per *p* dispari. `PASSES = 7` è dispari, quindi il risultato finisce in B = `transparent-order`.

I buffer del pool sono del renderer perché i probe dell'hot-reload fanno `setup()` e poi `destroy()` sul pool VIVO. Oggi nessun pass registra buffer nel pool durante il `setup()`, e questa regola si mantiene.

### 5.3 Kernel

I kernel stanno in due moduli: `transparent-gather.wgsl` (`gather_main`) e `transparent-sort.wgsl` (`upsweep_main`, `scan_main`, `scatter_main`). Ogni workgroup ha 256 thread e i layout sono espliciti.

**gather.** Dispatch diretto di `ceil(B/256)` gruppi, con `B = min(transparentCount normalizzato, CAP)`: 391 a 100k. Binding: 7 storage + 1 uniform:

| Binding | Tipo | Risorsa | Accesso |
|---|---|---|---|
| b0 | uniform | `GatherParams` | lettura |
| b1 | storage | `indirect-args` | lettura |
| b2 | storage | `visible-indices` | lettura |
| b3 | storage `array<vec4<u32>>` | `entity-bounds` | lettura |
| b4 | storage | `entity-ids` | lettura |
| b5 | storage | `sort-keys-a` | scrittura |
| b6 | storage | `sort-vals-a` | scrittura |
| b7 | storage | `transparent-args` | scrittura |

1. `lid == 0` legge, per k = 0..11, il conteggio (parola `(14+k)*5+1`) e la base della regione (`firstInstance`, parola `(14+k)*5+4`). Scrive in memoria di workgroup `regionEnd[12]` (prefisso inclusivo) e `regionBase[12]`. Non c'è `100_000` cablato.
2. `workgroupBarrier()`: al primo livello, ed è l'unica barriera.
3. `raw = regionEnd[11]`, `n = min(raw, limit)`.
4. Se `wid == 0 && lid == 0`, scrive l'header (§5.2). È l'unico scrittore, quindi niente atomic.
5. `i = wid*256 + lid`; se `i >= n`, return. Viene dopo la barriera.
6. `k` = numero di `q` con `regionEnd[q] <= i`; `start = k ? regionEnd[k−1] : 0`; `slot = visibleIndices[regionBase[k] + i − start]`.
7. Calcola la chiave (§5.1). Scrive `keysA[i] = id`, `keysA[CAP+i] = zKey`, `valsA[i] = slot`.

I bucket 26/27 (Light2D) e 0..13 (opachi) non vengono mai letti. L'uscita *i* è una funzione pura dei conteggi e del contenuto delle regioni. Tra un frame e l'altro cambia solo l'ordine dentro una regione, mai l'insieme, e il sort cancella quell'ordine.

**Layout condiviso da upsweep, scan e scatter** (6 storage + 1 uniform):

| Binding | Tipo | Risorsa | Accesso |
|---|---|---|---|
| b0 | uniform | `PassParams`, slice *p* | lettura |
| b1 | storage | chiavi in ingresso | lettura |
| b2 | storage | valori in ingresso | lettura |
| b3 | storage | chiavi in uscita | lettura/scrittura |
| b4 | storage | valori in uscita | lettura/scrittura |
| b5 | storage | `transparent-args` | **sola lettura** |
| b6 | storage | `sort-hist` | lettura/scrittura |

Grazie a b5 in sola lettura, `n` è un valore UNIFORME. Lo stesso buffer fa anche da argomenti indiretti degli stessi dispatch: storage in lettura più INDIRECT nello stesso dispatch è una combinazione valida, verificata su Chrome 154.

**upsweep ×7.** `dispatchWorkgroupsIndirect(transparent-args, 20)`.
1. `t = wid.x`; `if (t*1024 >= n) { return; }`. È valido prima delle barriere, perché dipende da `workgroup_id` e da un valore letto in sola lettura. Resta anche se ridondante con il dispatch indiretto.
2. `atomicStore(&wgHist[lid], 0)`; barriera.
3. Per r = 0..3: `i = t*1024 + r*256 + lid`; se `i < n`, `atomicAdd(&wgHist[digit], 1)`. Si legge solo la parola della cifra: `keysIn[i]` per p < 3, `keysIn[CAP+i]` altrimenti. Barriera.
4. `tiles[t*256 + lid] = atomicLoad(&wgHist[lid])`.

**scan ×7.** Un workgroup, dispatch diretto `(1)`. Il thread *d* possiede la cifra *d*; `T = ceil(n/1024)`.
1. Scan per colonna, senza barriere nel loop: `c = tiles[t*256+d]; tiles[t*256+d] = sum; sum += c`, a blocchi di 8 load.
2. `totals[d] = sum`; barriera.
3. Hillis-Steele inclusivo con `off = 1..128`: il loop ha lunghezza costante, quindi le barriere al suo interno sono in flusso uniforme.
4. `digitBase[p*256 + d] = incl − sum`.
5. Se `d == 255 && incl != n`, `atomicOr(&diag[0], 1)`.

**scatter ×7.** `dispatchWorkgroupsIndirect(transparent-args, 20)`. Memoria di workgroup: `masks: array<atomic<u32>, 2048>` (256 cifre × 8 parole, 8 KB) e `cursor: array<u32, 256>` (1 KB), in tutto 9216 B. La guardia sul tile è quella dell'upsweep.
- **Fase 0.** Ogni thread precarica le sue 4 terne (lo, hi, val) con `active_r = i_r < n`, dove `i_r = t*1024 + r*256 + lid`. `cursor[lid] = digitBase[p*256+lid] + tiles[t*256+lid]`. Il thread `lid` azzera `masks[lid*8 .. lid*8+7]` con `atomicStore`. Barriera **B0**.
- **Per r = 0..3** (loop costante: i thread inattivi non fanno nulla ma attraversano ogni barriera):
  - (a) se attivo: `d = digit`, poi `atomicOr(&masks[d*8 + lid/32], 1u << (lid%32))`. Barriera **B1**.
  - (b) se attivo: `total` = somma dei popcount delle 8 parole; `rank` = popcount delle parole con indice `< lid/32` + `countOneBits(masks[d*8+lid/32] & ((1u << (lid%32)) − 1u))`; `base = cursor[d]`. Nessuna scrittura. Barriera **B2**.
  - (c) se attivo: `dst = base + rank`. Se `dst < n`: `valsOut[dst] = val`, e, **se `passIndex != 6`**, `keysOut[dst] = lo` e `keysOut[CAP+dst] = hi`. Altrimenti `atomicOr(&diag[0], 2)`. Poi `atomicStore(&masks[d*8+lid/32], 0)`; se `rank == total − 1`, `cursor[d] = base + total` (un solo scrittore per cifra). Barriera **B3**.
- Sono 13 barriere per tile.

**Stabilità.** `dst` è la somma di quattro conteggi: gli elementi con cifra minore (`digitBase`), quelli con cifra *d* nei tile precedenti (scan per colonna), nei round precedenti del tile (`cursor`) e nei thread con indice minore del round corrente (popcount). Il risultato è esattamente la posizione del counting sort stabile. Nessun ordine di atomic arriva mai a un indirizzo, perché OR e popcount sono commutativi.

**L'ultima passata non scrive le chiavi, in OGNI build.** Dev e produzione eseguono lo stesso codice: non c'è un override `WRITE_KEYS`. La readback ricalcola le chiavi finali sulla CPU.

### 5.4 Uniform

- `PassParams`: 7 slice costanti, scritte **una volta** nel `setup()`.
- In `prepare()`, una volta per frame: `GatherParams {limit = B}`, il reset dell'header (`{6,0,0,0,0, 0,1,1, 0, B, 0, …}`) e l'azzeramento dei 64 B di `diag`.
- **`execute()` non chiama mai `writeBuffer`**: la regola che `writeBuffer` arriva prima del *prossimo* submit la rende una trappola.
- `prepare()` gira prima dell'encoding di tutti i pass. Per questo i conteggi del cull il gather li legge sulla GPU, non la CPU.
- Le due struct uniform sono 4 × u32 con i pad espliciti. Le copre `uniform-layout.test.ts`.

### 5.5 Encoding e profiler

- **Senza profiler:** un solo compute pass con i 22 dispatch. In un compute pass ogni dispatch è un proprio usage scope, e le scritture di uno sono visibili al successivo.
- **Con il profiler:** un compute pass per stadio, 22 marker (il budget di 256 è condiviso con `LightGroupsPass`) e 4 nomi sommati: `transparent-sort/gather|upsweep|scan|scatter`. `profileStages` corrisponde uno a uno alle chiamate a `mark`. Con il sort saltato restituisce `[]`: una differenza tra i due fa perdere a `GpuProfiler` l'intero frame.
- **Con `transparentCount` normalizzato uguale a 0:** nessun dispatch. Un `dispatchWorkgroups(0)` diretto genera un warning di Dawn; un indiretto `{0,1,1}` è silenzioso.

### 5.6 Costo stimato

A 100k il traffico è di circa 29 MB per frame:
- gather: circa 3,6 MB;
- 7 passate da circa 3,6 MB ciascuna, contando la tabella dei tile. Con le chiavi SoA l'upsweep legge 4 B invece di 8.

A 60-100 GB/s sono 0,3-0,5 ms, più 0,04-0,1 ms per svuotare la pipeline tra i 22 dispatch dipendenti. **Stima: 0,3-0,7 ms, da confermare con il profiler** sull'iGPU AMD, sia con z tutte uguali (il caso 2D comune e il peggiore per le contese sugli atomic in memoria di workgroup) sia con z tutte distinte.

### 5.7 Fuori dalla v1 e scartati

**Follow-up da fare solo dopo le misure, con i loro vincoli:**
- **Saltare le passate banali.** Per un id massimo < 2^16 si può saltare la passata 2; con z costanti le passate 3-6. Serve un bind group per (passata, parità), l'ultima passata eseguita deve scrivere `transparent-order`, e un test sul modello CPU deve fissare le configurazioni saltate.
- **Upsweep fuso nello scatter.** Serve una tabella dei tile doppia, una letta e una accumulata, perché lo scatter *p* legge la tabella che l'upsweep fuso di *p+1* scriverebbe.
- **Passata 0 fusa nel gather.** La cosa da verificare è il limite di 8 storage buffer.
- **Istogrammi dell'upsweep privatizzati per lane**, 8 copie.
- **Tile da 2048/4096.**

**Scartati:**
- onesweep / decoupled look-back: WebGPU non garantisce il forward progress;
- lo scan dell'ultimo workgroup: WGSL non ha un fence a livello di device;
- il ranking con i subgroup: questa iGPU ha subgroup da 32 a 64, e ricadrebbe nel problema dei 32 lane che ha già il cull;
- bitonic: escluso da D3.

### 5.8 Hot-reload del sort

Due slot, `transparent-gather` e `transparent-sort`, con probe = un `TransparentSortPass` usa e getta e `usedBy: inEveryMode`. Il probe non tocca il pool, perché i buffer del pool già esistono quando gira.

## 6. Grafo, draw uber e casi limite

### 6.1 Grafo

- In tutti e sei i grafi (3 composite × illuminazione accesa/spenta) il factory `scene` diventa `[ScatterPass, CullPass, TransparentSortPass, ForwardPass]`.
- `TransparentSortPass` legge `indirect-args`, `visible-indices`, `entity-bounds` ed `entity-ids`, e scrive `transparent-order` e `transparent-args`. È l'unico a scriverle ed è `optional`.
- `ForwardPass`, sia lit sia unlit, **legge `transparent-order` e `transparent-args`**. È ciò che tiene vivo il sort e lo ordina prima del forward. `RadixSortPass` è morto proprio perché nessuno leggeva la sua uscita.
- `entity-ids` lo scrive solo la CPU; un grafo può leggere una risorsa che nessun pass scrive, come fa già `selection-mask`.

**Da eliminare:** `RadixSortPass`, `radix-sort.wgsl`, `radix-sort-pass.test.ts`, e in `renderer.ts` l'import (L17), la statica (L328), la voce nel factory (L466), lo slot (L577-582) e l'accept (L1020-1022). Va aggiornato anche il commento di `GraphPassFactories.scene` (`graph-assembly.ts:25`). `floatToSortKey` sparisce con il pass: il modello CPU ha la sua conversione (§7.1).

### 6.2 Draw uber in `ForwardPass`

- **Una pipeline** `uberPipeline` prende il posto delle 6 pipeline trasparenti. Descrittore identico a quello di oggi:
  - blend colore `src-alpha / one-minus-src-alpha / add`;
  - blend alfa `one / one-minus-src-alpha / add`;
  - depth `depth24plus`, `depthWriteEnabled: false`, `depthCompare: 'less'`;
  - cull `back`;
  - stesso vertex buffer (unit quad, `float32x3`) e stesso index buffer;
  - layout a tre gruppi.
- **Un secondo bind group del gruppo 0**, uguale a `bindGroup0` salvo il binding 2, che punta a `transparent-order`. Il codice dei vertex shader non cambia: legge ancora `visibleIndices[instance_index]`.
- **Il sub-pass trasparente:** `setPipeline(uber)`, i gruppi 0 (ordinato), 1 e 2, poi `drawIndexedIndirect(transparent-args, 0)`. Con `firstInstance = 0` il draw **non richiede** `indirect-first-instance`.
- **Draw saltato con `frame.transparentCount == 0`.** È una seconda cintura, oltre al reset dell'header in `prepare()`.
- `transparent-args` in questo render pass è solo INDIRECT e non va mai legato `read_write`: in un render pass l'usage scope è l'intero pass.
- Il test "6 pipeline per 3 tipi" diventa 3 opache + 1 uber.

### 6.3 Casi limite

| Caso | Comportamento |
|---|---|
| `transparentCount == 0` / mondo vuoto | Il sort non codifica nulla, `profileStages` restituisce `[]`, niente draw uber |
| Tutti i trasparenti fuori schermo (`n = 0`, `B > 0`) | Gather da `ceil(B/256)` gruppi; upsweep e scatter indiretti a 0 gruppi, in silenzio; 7 scan con T = 0 (controllano `incl == 0 == n`); draw da 0 istanze |
| `n = 1`, `n` non multiplo di 1024 | I thread inattivi attraversano ogni barriera senza contare, marcare né scrivere |
| Visibili > B (conteggio sbagliato) | `n = B`, flag di overflow nell'header, visibile dalla readback |
| Light2D `.transparent()` | Escluso dal gather: i bucket 26/27 restano a `LightAccumStage` |
| Tipo ≥ 7 in `renderMeta` | Il cull lo mette già a 6 (bucket 26/27); l'uber fa lo stesso clamp e 6 → `culledVertex` |
| Mode A | Stesso renderer nel render worker; i campi arrivano perché `rs` viene inoltrato intero. Il problema del mondo vuoto resta com'è |

### 6.4 Capacità

- Una costante esportata **`MAX_GPU_ENTITIES = 100_000`**, in `types.ts` accanto a `MAX_EXTERNAL_ID`. Prende il posto delle tre copie: `renderer.ts:56`, `cull-pass.ts:215` (uniform `maxEntitiesPerType`) e `cull-pass.ts:223` (`firstInstance`). Il valore non cambia, quindi `cull.wgsl` resta com'è.
- **`validateConfig` rifiuta `maxEntities > MAX_GPU_ENTITIES`** (D10), con un errore che nomina il limite.
- Il renderer emette un warning una tantum quando `entityCount > MAX_GPU_ENTITIES`, per gli spawn raw, che il facade non conta. Oltre quel valore oggi è già tutto rotto: il `writeBuffer` degli SoA fallisce la validazione.

### 6.5 Readback di dev: `engine.debug.readTransparentSort()`

- **Quando.** Solo nei build di dev, costruita sul modello di `DebugProbe`. La richiesta viene servita nel frame **successivo** renderizzato.
- **Cosa copia.** Il pass codifica delle copie nei propri buffer di staging:
  - l'uscita del gather (chiavi e valori A, subito dopo il dispatch del gather: si chiude il compute pass, si copia, se ne apre un altro);
  - l'header;
  - `sort-hist` (i `digitBase` delle 7 passate, `diag`, la tabella dei tile dell'ultima passata);
  - `transparent-order`.
- **Cosa restituisce:** `{ n, raw, limit, overflow, diag, gathered: {keys, vals}, digitBase, order }`.
- **Input.** La CPU ha già `state.bounds` e `state.entityIds`, quindi `COPY_SRC` in dev serve solo sui buffer del sort. `visible-indices`, `entity-bounds` e `indirect-args` non si toccano.
- **Rifiuti.** Rifiuta invece di rispondere con degli zeri:
  - quando l'header copiato non contiene il `limit` atteso per quel frame, cioè la copia non è partita;
  - nel Mode A, senza renderer, in pausa;
  - con `transparentCount` normalizzato uguale a 0, perché non c'è niente da leggere.
- **Niente anello per frame.** Con il limite B vero e i dispatch indiretti non avrebbe più un compito.
- I tempi del profiler vanno letti in frame senza readback.

## 7. Test e verifica

### 7.1 Modello CPU

Due file: `ts/src/render/passes/transparent-sort-reference.ts` e `transparent-sort-constants.ts`. Le costanti (`TILE`, `ROUNDS`, `RADIX`, `PASSES`, `FIRST_TRANSPARENT_ARG = 14`, `GATHER_REGIONS = 12`, `CAP`) si condividono con il pass e con i test di accordo del testo WGSL. È un simulatore a fasi degli **stessi** kernel.
- **Buffer:** `Uint32Array` con il layout GPU parola per parola (header, `SortHist`, chiavi SoA, valori), così una readback si confronta direttamente.
- **Kernel:** `cpuGather`, `cpuUpsweep`, `cpuScan` e `cpuScatter` sono liste di fasi, una per intervallo tra barriere, e rispecchiano il WGSL riga per riga. **Ogni fase WGSL separata da una barriera è un loop sui lane in TS.**
- **Driver:** esegue i workgroup di un dispatch nell'ordine scelto dal chiamante (mescolato nei test). Dentro un workgroup, la fase *k* gira per i 256 thread in una permutazione scelta dal chiamante prima della fase *k+1*.
- **Verificatore di race sulla memoria di workgroup:** un indirizzo scritto non atomicamente da un thread in una fase e toccato da un altro nella stessa fase lancia un errore. Gli atomic sono modellati come operazioni commutative.
- **Verificatore di conflitti sulla memoria globale, per dispatch:** un indirizzo scritto da un workgroup e letto non atomicamente da un altro nello stesso dispatch lancia un errore.
- **`sortableZBits(bits)`** replica il WGSL: normalizzazione di -0, poi il ribaltamento.

**Test contro l'oracolo** (`Array.sort` per (zKey, id)):
- dimensioni 0, 1, 2, 255, 256, 257, 1023, 1024, 1025, 2047, 4097 e 100 000;
- distribuzioni: z tutte uguali (vince l'ordine degli id), due valori di z, tutte distinte, decrescenti, id 0 e 0xFFFFF, z = ±0, denormali, ±Inf.

**Invarianti:**
- ogni scatter è un counting sort stabile sulla sua cifra;
- `digitBase[p]` è lo scan esclusivo dell'istogramma della cifra *p*;
- il risultato non cambia mescolando il contenuto delle regioni, l'ordine dei tile o quello dei thread;
- overflow: `n = B`, flag alzato, argomenti del draw `{6, B, 0, 0, 0}`;
- input vuoto: argomenti `{6, 0, 0, 0, 0}` e nessuna scrittura;
- i bucket 0..13 e 26/27, **riempiti apposta**, non vengono mai letti.

### 7.2 Test headless del codice

- **Accordo tra testo WGSL e TS:**
  - costanti ed entry point;
  - tipi dei binding contro i layout;
  - storage per layout ≤ 8 (gather 7, sort 6), e ogni binding dichiarato viene letto;
  - memoria di workgroup per entry point ≤ 16 384 B (96 / 1024 / 1024 / 9216);
  - `PASSES` dispari, quindi il risultato va in `transparent-order`.
- **`TransparentSortPass` su device finto:**
  - `PassParams` scritti una volta nel `setup()`;
  - `GatherParams`, header e `diag` una volta per `prepare()`;
  - **nessun `writeBuffer` in `execute()`**;
  - il bind group *p* punta all'offset 256·*p* con la direzione giusta;
  - dispatch diretti (391 / 1) e indiretti all'offset 20;
  - 1 compute pass senza profiler e 22 con; `profileStages` uguale a `mark`, anche nel caso saltato;
  - con count 0 non si codifica nulla;
  - `minBindingSize` su ogni voce;
  - il `setup()` non scrive nel pool.
- **`ForwardPass`:** una pipeline uber con il descrittore trasparente; il bind group ordinato ha il binding 2 su `transparent-order`; un solo `drawIndexedIndirect(transparent-args, 0)`; il draw si salta a count 0; `reads` contiene le uscite del sort.
- **Composizione del grafo:** in tutti e 6 i grafi `transparent-sort` sta dopo `cull` e prima di `forward`.
- **Compositore** (§3.4), **Rust** (§4.1), **bridge e upload** (§4.2-4.3), **`validateConfig`** (§6.4).

**Test Rust in dettaglio:**
- **Generazione:** sale con `assign_slot` e con un flush non vuoto; non sale con l'assign idempotente, con `write_slot` del proprietario, con `collect_dirty_staging` senza cambi di mappatura né con `shrink_to_fit`; `reset` e `restore` la fanno salire; `SpawnEntity` su un id vivo dà una generazione nuova e gli id giusti.
- **Conteggio:**
  - confronto con un ricalcolo a forza bruta su `gpu_render_meta[..gpu_count*2]` lungo sequenze casuali con seed di spawn, despawn e `SetTransparent`;
  - `SetTransparent` più despawn nello stesso frame;
  - una riga `last` trasparente spostata in uno slot opaco morto, e il contrario;
  - la coda vecchia oltre `gpu_count` non conta;
  - `collect_gpu` coincide con il percorso a slot stabili.

**Test TS del trasporto e dell'upload:**
- i campi arrivano nel Mode C e nel Mode B;
- nel Mode A arrivano alla copia del main thread e alla ricostruzione del render worker;
- l'upload degli id scatta solo al cambio di generazione e **anche nei frame con lo scatter**;
- con la generazione mancante l'upload avviene a ogni frame.

### 7.3 GPU reale

Si verifica sull'iGPU AMD, con la skill `/gpu-check`, in Mode B e in Mode C.

1. **Prima di costruire il resto:** `getCompilationInfo` e creazione delle pipeline dentro `pushErrorScope('validation')` per gather, sort, uber e i 6 moduli per tipo composti. Si prova anche la direttiva `diagnostic` su Firefox, se si riesce a lanciarlo su questa macchina.
2. **`readTransparentSort()` su scene vere:**
   - `order` uguale all'oracolo con le chiavi ricalcolate da `state.bounds` e `state.entityIds`: una colonna id vecchia qui si vede;
   - `diag == 0`;
   - ordine **identico in due frame consecutivi**;
   - con `?mode=C` e un ricambio continuo di spawn e despawn, per verificare l'upload degli id nei frame con lo scatter.
3. **Pixel nel tab 2D Twins**, estendendo il check sulla depth:
   - sprite `.transparent()` di tipi diversi (quad, gradient, box shadow, line) sovrapposti, disegnati nell'ordine di z;
   - a parità di z sta davanti l'id più alto;
   - l'ordine si inverte quando le depth cambiano a runtime;
   - i valori attesi si calcolano in forma chiusa dal blend a alfa dritto e si leggono con il probe su `scene-hdr`.
4. **Nessuna regressione:**
   - tutti i 10 tab verdi;
   - gli opachi identici al pixel rispetto alla baseline del 2026-09-27 (`assets/2026-09-27-harness-baseline`);
   - i trasparenti con tolleranza;
   - i check del tab Primitives che contavano sui box shadow disegnati per ultimi vanno ricalcolati sul nuovo ordine.
5. **Prestazioni**, con una scena di benchmark lanciata da `evaluate_script`:
   - gli stadi del sort a 1k, 10k e 100k trasparenti visibili, con z tutte uguali e con z tutte distinte;
   - **soglia: sort < 1 ms a 100k**;
   - il `forward` misurato su master **prima** del passo 4 e dopo, con la stessa scena. È il costo della pressione sui registri dell'uber.
   - Le misure si salvano in `docs/plans/assets/`.

### 7.4 Prima del merge

`scripts/preflight.sh --full`, poi `adversarial-review` sul range del branch, e gli agent `wgsl-validator`, `webgpu-pass-reviewer` e `protocol-sync-checker` (per le due esportazioni nuove).

## 8. Ordine di implementazione

| Passo | Contenuto | Criterio di uscita |
|---|---|---|
| 0 | Baseline | Tempo di `forward` su master con la scena di benchmark a 1k/10k/100k trasparenti, salvato in `assets/` |
| 1 | Composizione (§3) | Test headless verdi. Sulla GPU i 7 moduli composti compilano e le pipeline si creano (uber compreso, ancora non disegnato). **Tutti i pixel identici alla baseline**: in questo passo i trasparenti usano ancora le pipeline per tipo. L'HMR di un pezzo funziona, compreso il reload raggruppato |
| 2 | Colonna id e conteggio (§4), capacità (§6.4) | Test Rust e TS verdi, `protocol-sync-checker` pulito, i 10 tab verdi |
| 3 | Gather + sort (§5), readback (§6.5) | Modello CPU e test del pass verdi. `ForwardPass` legge già le uscite del sort, quindi il sort gira a ogni frame, ma il draw non cambia ancora. Sulla GPU la readback coincide con l'oracolo ed è stabile; il sort misurato resta < 1 ms a 100k |
| 4 | Draw uber (§6.2) | Check pixel nuovi verdi; 10 tab verdi; opachi identici; `forward` misurato contro il passo 0 |
| 5 | Chiusura | Documentazione (§9), `preflight --full`, review avversariale, merge |

## 9. Documentazione e strumenti da aggiornare

- **CLAUDE.md:**
  - la tabella degli shader: pezzi, compositore, `transparent-gather`/`transparent-sort`, niente `radix-sort`;
  - le righe di `renderer.ts`/`forward-pass.ts`, con "device-lost recovery" corretto in "logga e chiama `onDeviceLost`";
  - i gotcha: `fs_occluder` + `OCCLUDER_PASS`, `CameraUniform` a 80 B nel preludio, gruppo 2 solo da `fs_main`, "aggiungere una primitiva" (libreria + riga di tabella + caso uber generato), la direttiva dell'uber, `ForwardPass`'s 12 pipeline, `RadixSortPass` morto;
  - i conti: 22 importati / 20 ricaricabili a caldo, 24 file `.wgsl`;
  - una voce nuova per `TransparentSortPass`, `entity-ids`, la generazione e `transparentCount`;
  - il conteggio dei test.
- **Skill `new-primitive`:** una primitiva nuova diventa una libreria in `shaders/primitives/`, più una riga in `PRIMITIVE_LIBRARIES`, più i test del compositore.
- **Agent** `wgsl-validator` (i moduli composti, "22 WGSL shaders") e `webgpu-pass-reviewer` (l'header `transparent-args`, gli argomenti del draw uber).
- **PROJECT_ARCHITECTURE.md:** le sezioni sul render, sulla visibility indirection, sulla ForwardPass multi-pipeline, sull'hot-reload e il glossario.
- **Masterplan:** il rischio "manca un preprocessore WGSL" risulta risolto dal compositore TS.

## 10. Rischi

| Rischio | Contromisura |
|---|---|
| Un browser rifiuta la direttiva globale `diagnostic`. Il grafo iniziale si costruisce in modo sincrono, e una pipeline non valida annulla tutto il command buffer: ogni frame diventa nero | Validare su Chrome (fatto) e su Firefox (naga la supporta dalla PR #6148). Piano B documentato: portare fuori dallo switch `fwidth(uv.y)` di `line` e `dpdx`/`dpdy(uv)` di `msdf`, e riscrivere `fwidth(d)` di `bezier` con la regola della catena |
| La pressione sui registri dell'uber, dimensionata sul caso più pesante, rallenta i quad semplici | Misura del `forward` ai passi 0 e 4 |
| Contese sugli atomic in memoria di workgroup con z tutte uguali | Misura del caso peggiore; se serve, privatizzazione (§5.7) |
| Colonna id vecchia (generazione non trasportata o non incrementata): pareggi rotti senza nessun diag | Normalizzazione a `NaN`, test per ogni sito di trasporto, readback con le chiavi ricalcolate |
| `transparentCount` perso in un sito di trasporto (Mode A non verificabile qui) | Normalizzazione a `entityCount`, test della ricostruzione nel render worker |
| Il modello CPU e il WGSL restano due codebase | Rispecchiamento riga per riga, test di accordo del testo, readback confrontata con l'oracolo |
| Il nuovo ordine cambia i check pixel dei trasparenti | Ricalcolo dei valori attesi al passo 4 |
| Le righe degli errori di compilazione non corrispondono ai file | Marcatori `// --- piece: X ---` |
| Il budget del profiler (256 marker) è condiviso | 22 marker più quelli di `LightGroupsPass` per set. Oltre il budget `beginFrame` lascia il frame non misurato; nessun effetto sul rendering |
