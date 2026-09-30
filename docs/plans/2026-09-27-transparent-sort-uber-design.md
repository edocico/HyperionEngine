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
| D2 | Trasparenti alla stessa z | **Sta davanti l'id esterno più alto.** Coincide con l'entità più recente finché l'allocatore distribuisce id nuovi, cioè per i primi 1 048 576 spawn cumulativi. Dopo, gli id rilasciati tornano dal più vecchio, e un'entità nuova può finire dietro una più vecchia alla stessa z. L'ordine resta deterministico; per ordinare gli sprite l'API giusta è `.depth()` (§6.3) |
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

**Obiettivo.** Le primitive trasparenti di tipo 0-5 si disegnano **dal fondo al davanti per z di mondo** (`entity-bounds.z`). A parità di z sta davanti l'id più alto (D2). Senza overflow (§6.3) l'ordine è deterministico da un frame all'altro, e tutto passa in **un solo draw**.

**Fuori perimetro. Queste cose non cambiano:**
- Le pipeline opache, l'occluder, `LightAccumStage` (legge ancora i bucket 26/27), la selezione e i 28 bucket del cull. `cull.wgsl` non cambia; `CullPass` prende soltanto la costante condivisa della capacità (§6.4), con lo stesso valore.
- Un trasparente alla stessa z di un opaco sovrapposto resta nascosto, per il `depthCompare: 'less'` stretto. È così già oggi.
- I trasparenti non ricevono il contorno di selezione: `SelectionSeedPass` disegna solo i bucket 0/1. È così già oggi.
- La chiave è la z di mondo perché la camera guarda sempre lungo -Z. Una camera che ruota o prospettica richiederebbe la profondità di vista come chiave. Non esiste oggi.
- Mode A: la trasparenza funziona lì come altrove, ma su questa macchina non si può verificare sulla GPU (passo 10 del giro).
- La trasparenza indipendente dall'ordine (OIT).

**Criteri di successo** (ognuno ha il suo controllo in §7):
- I check pixel nuovi (§7.3.4) passano in Mode B e Mode C.
- Gli stati dei 10 tab dell'harness coincidono con quelli registrati al passo 0 (§7.3.5): nessun check fallito, gli stessi check in skip o pending, e ogni check che passava passa ancora. L'Input resta a 2/6 come su master.
- I punti statici opachi della baseline senza perdita del passo 0 sono identici al bit (§7.3.5).
- `readTransparentSort()` supera i controlli di §7.3.3 (insieme raccolto, chiavi, ordine, `digitBase`, due frame consecutivi uguali).
- Il sort, cioè la somma dei quattro stadi, gather compreso, resta sotto 1 ms a 100 000 trasparenti visibili sull'iGPU AMD, con lo scenario di benchmark committato (§7.3.6).
- Il costo del `forward` è misurato ai passi 0, 1, 3 e 4 e documentato (§7.3.6).

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
  - `fwidth(in.uv.y)` prima di qualunque ramo (`switch`/`discard`/`if`) di `line_shade`, come oggi: la derivata vuole flusso di controllo uniforme. Il test di `forward-pass.test.ts:276-279` passa sul modulo composto.
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
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f { return P_fs(in); }
@fragment
fn fs_occluder(in: VertexOutput) -> @location(0) vec4f { return P_occluder(in); }
```
Le condizioni dell'early-out dell'occluder restano quelle di oggi. `OccluderSeedStage` riconosce i moduli con `code.includes('fn fs_occluder')`, e questo non cambia. Gli attributi di stage stanno su una riga a sé, come oggi; i test usano regex che tollerano spazi e a capo (`/@fragment\s+fn fs_occluder\s*\(/`).

**Modulo uber** = `diagnostic(off, derivative_uniformity);` in **prima riga**, poi il preludio, le sei librerie e questi wrapper:
- `vs_main`:
  1. `e = visibleIndices[instanceIdx]`;
  2. `t = min(renderMeta[e*2u+1u] & 0xFFu, 6u)`, lo stesso clamp di `cull.wgsl`;
  3. `switch t`: i casi 0-5 chiamano `<p>_vs`, il `default` (6 = Light2D) restituisce `culledVertex()`;
  4. `out.primType = t`.

  Non c'è l'early-out dell'occluder.
- `fs_main`: `switch in.primType`, un caso per libreria, e ogni caso restituisce `<p>_fs(in)`. WGSL esige un `default`: si fonde con l'ultimo caso, `case 5u, default: { return boxshadow_fs(in); }`, così ogni percorso restituisce un colore di libreria. Non va bene un `default: { discard; }`: il suo comportamento è {Next}, e la funzione non compila per "must return a value". Il `default` è comunque irraggiungibile, perché il vertex stage porta il 6 a `culledVertex`.
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
- **`write()` non può lanciare.** Il compositore è totale.
- **La guardia sul pezzo vuoto guarda le statiche GREZZE dei pezzi** (`prelude`, `libraries[t]`), mai il testo composto. Sta nella closure del probe degli slot di pezzo in `renderer.ts`: se un pezzo è vuoto o fatto solo di spazi, lancia in modo sincrono DENTRO `validation.run`, che toglie i suoi error scope e rilancia (`graph-host.ts:32-39`). `reloadShader` intercetta l'eccezione, restituisce 'rejected' e ripristina la sorgente vecchia nel `finally`, prima di incrementare la versione (`graph-requests.ts:166-178`). `reloadShaders` deve rispettare lo stesso ordine per tutti i suoi probe. La guardia resta come rete di sicurezza per le chiamate dirette `recompileShader(pezzo, '')`. Va corretto anche il commento/mock di `graph-requests.test.ts:175-190`, che oggi fa pensare a una guardia per voce dentro `ForwardPass`.
- **Reload raggruppato.** Senza di esso, un nome cambiato nel preludio insieme al suo uso in una libreria arriva come due update Vite separati. Ognuno viene provato contro il testo VECCHIO dell'altro, entrambi vengono rifiutati, e ricaricare la pagina su questa macchina significa perdere il device.
  1. **Raccolta.** Solo gli `accept` dei pezzi passano da un debounce finale di 50 ms: ogni `accept` fa ripartire il timer. Si tiene l'ultimo valore NON vuoto per nome e si ignora `''`, così un salvataggio vuoto non sostituisce mai un candidato buono in attesa. Una finestra con soli vuoti non manda niente.
  2. **Verifica.** Nuovo `reloadShaders(entries): Promise<Map<string, ReloadOutcome>>`. Nella stessa finestra sincrona esegue il probe dell'UNIONE (tutti i candidati scritti) e poi un probe SINGOLO per voce (solo quella voce scritta sopra le sorgenti buone correnti). Ognuno è il suo scrivi-prova-ripristina, come fa oggi `reloadShader`, quindi niente di non validato sopravvive alla finestra.
  3. **Verdetto.** Nessun grafo si costruisce mai da un insieme che un probe ha già respinto, o che nessun probe ha provato insieme:
     - se l'unione passa, si tengono tutte le voci e si fa un solo `requestGraph`;
     - se l'unione fallisce e TUTTE le voci passano da sole, sono in conflitto tra loro (per esempio un nome di primo livello duplicato): tutte rifiutate, con una sola riga di log, nessuna scrittura e nessun `requestGraph`. Una richiesta di modo in attesa (per esempio un `enableOutlines`) non viene toccata;
     - se l'unione fallisce e solo ALCUNE voci passano da sole, si fa un ulteriore scrivi-prova-ripristina di quel sottoinsieme come unione, contro le sorgenti buone correnti, e si chiede un grafo solo se passa.

     Un verdetto riguarda le sorgenti correnti quando il suo probe è partito. Se nell'attesa un altro reload ha scritto le sue sorgenti, o un grafo respinto le ha ripristinate (un contatore di scritture), l'insieme tenuto si riprova sopra le sorgenti correnti, finché un verdetto arriva senza scritture nel mezzo. Vale anche per `recompileShader(pezzo)`: `reloadShader` è una finestra di una sola voce (review `wf_61c6a580-afa` #17; prima si fidava del verdetto del suo probe).

     La garanzia è quella di oggi, ristretta ai **file indipendenti**: con un "Save All" di file indipendenti in cui c'è un solo file rotto, si perde solo quel file. **Limite dichiarato:** una modifica accoppiata (una rinomina nel preludio più i suoi usi) salvata insieme a un pezzo rotto e scollegato viene respinta per intero. Preludio e libreria vanno salvati di nuovo dopo aver corretto il pezzo rotto, perché Vite rimanda solo i file che cambiano. Stessa sorte se un pezzo di una finestra accoppiata viene salvato di nuovo prima del verdetto (A = {preludio P', quad Q'}, poi B = {quad Q''}): A perde quad e il preludio da solo non compila, B viene provato contro il preludio vecchio, e di solito vengono respinte tutte e due; vanno salvati di nuovo, insieme, entrambi i file.
  4. **Versioni.** `reloadShaders` incrementa la versione di ogni voce che porta, solo dopo che i suoi probe sono partiti, come fa oggi `reloadShader` (così un pezzo vuoto non annulla niente). Al verdetto, una voce la cui versione si è mossa viene scartata e segnalata come 'superseded'. `recompileShader(pezzo)` condivide le stesse versioni per nome: una chiamata diretta sostituisce la voce in attesa di una finestra, e viceversa.
  5. **API pubblica.** `recompileShader(name, src)` resta a slot singolo e chiama direttamente `reloadShader`, senza debounce; `reloadShader` è `reloadShaders` con una voce, quindi segue il punto 3.
  6. **Test** passando dal raccoglitore, non da `reloadShader`:
     - una rinomina nel preludio insieme al suo uso in una libreria, nella stessa finestra: entrambi vanno live;
     - `line` rotto insieme a `quad` valido e indipendente: `quad` va live, `line` viene rifiutato;
     - X e Y passano da sole ma l'unione fallisce: nessun `host.request`, tutte e due 'rejected', e un `enableOutlines` in attesa va comunque live;
     - rinomina nel preludio + `line` che la usa + `quad` rotto e scollegato: tutte e tre respinte (il limite dichiarato);
     - una voce sostituita da una finestra successiva risulta 'superseded', ed è live la sorgente più nuova;
     - `v1` poi `''` per lo stesso pezzo: va live `v1`;
     - `''` poi `v1`: va live `v1`.

**Gli altri punti toccati:**
- Gli `accept` restano in `renderer.ts`, accanto agli import `?raw` dei pezzi: `hot.accept(dep)` funziona solo nel modulo che importa `dep`.
- `recompileShader('basic' | 'quad' | …)` ora riceve un PEZZO, non un modulo completo. Va detto nel suo JSDoc.
- Lo slot `radix-sort` va via, ed entrano `transparent-gather` e `transparent-sort` (§5.8).
- Conti finali: **22 file WGSL importati, 20 ricaricabili a caldo**. In totale i file `.wgsl` diventano 24: 17 al primo livello più i 7 pezzi.

### 3.4 Test della composizione

I 133 `expect` che oggi leggono il testo dei sei file (36 A / 74 B / 21 C / 2 D; il dettaglio è nell'inventario di `wf_5bce1f00-66e`) si riscrivono sui **moduli composti**, che il compositore produce senza browser.
I controlli si dividono in tre gruppi, secondo dove sta il testo che verificano:
- **Preludio.** I 58 controlli uguali in tutti i moduli (struct, `castsInto`, override, bit) girano una volta sul preludio. Si aggiunge un controllo: "ogni modulo composto contiene il preludio alla lettera". Nell'uber il preludio viene dopo la direttiva; la regola è "contiene", non "comincia con".
- **Wrapper, su ciascuno dei 6 moduli per tipo e mai sull'uber.** Sono i 36 controlli di classe A: il testo dell'early-out in `vs_main`, l'entry `fn fs_occluder`, `out.primType = T`.
- **Librerie, tramite il grafo delle chiamate.** Per ogni libreria, `<p>_fs` e `<p>_occluder` raggiungono entrambe la stessa funzione di copertura con il prefisso (lo `shade` di oggi, rinominato `<p>_shade`). Non si usa più la regex generica "il primo `fn X(in: VertexOutput) -> vec4f`", che adesso catturerebbe un helper del preludio (`occluder-seed-stage.test.ts:199-204`).

Gli ancoraggi per slice e regex che nominano simboli di libreria passano ai nomi con prefisso. Ogni ancoraggio deve esistere (indice ≥ 0) prima di un `not.toMatch`.

I controlli di "file che dichiarano `@group(2)`" diventano controlli di **raggiungibilità** sul grafo delle chiamate costruito dal testo composto:
- I nomi del gruppo 2 si ricavano dalle dichiarazioni `@group(2)` del preludio, non da una lista scritta a mano (oggi `lightBuffer`, `lightSampler`, `lighting`), più `lightGroupOf`.
- Un nome del gruppo 2 raggiungibile da `fs_main` ⇔ il tipo è `lit`. La regola vale per ogni modulo per tipo e per ogni caso dell'uber.
- Mai raggiungibile da `fs_occluder` né da `vs_main`.
- **Binding contro layout.** Ogni binding di modulo raggiunto da un entry point va confrontato con il layout della pipeline che lo esegue: occluder = gruppi 0-1, `ForwardPass` = gruppi 0-2. Si verifica anche la visibilità per stage: `camera`, `transforms` e `visibleIndices` solo VERTEX; gruppo 1 e gruppo 2 solo FRAGMENT. Una volta che il grafo delle chiamate esiste costa poco, e prende qualunque binding nuovo del preludio.

**Test nuovi:**
- Nell'uber tutti i nomi di primo livello sono unici, e ogni nome di libreria ha il suo prefisso.
- Nessun `let`, `var`, `const` locale o parametro di funzione ha lo stesso nome di un globale del preludio: in WGSL lo nasconderebbe in silenzio.
- La direttiva sta solo nell'uber, in prima riga; i moduli per tipo non ne hanno.
- L'uber non ha `fs_occluder` e fa il clamp del tipo come `cull.wgsl`. Nello switch di `vs_main` e in quello di `fs_main` c'è esattamente un `default`: quello del vertex restituisce `culledVertex`, quello del fragment finisce con un `return`. Né il compositore né vitest compilano WGSL, quindi questo controllo sul testo è l'unica guardia headless.
- Le librerie non hanno binding, entry point, direttive, `fn fs_occluder` né alcun nome del gruppo 2 o `lightGroupOf`.
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

**`ids_generation: u32`.** Vive in **`Engine`**, non in `RenderState`, perché `reset` e `snapshot_restore` ricreano `RenderState` ma non `Engine`. Un contatore in `RenderState` ripartirebbe da 0 e potrebbe coincidere con il valore già caricato in TS.
- `engine_init` invece crea un `Engine` nuovo, quindi lì la generazione riparte da 0. È sicuro solo perché ogni bridge chiama `engine_init` una volta sola, prima di qualunque frame, e ogni renderer parte con il marcatore a `NaN`.
- Se un giorno il motore venisse reinizializzato sotto un renderer vivo, quel renderer dovrebbe rimettere il marcatore a `NaN`.
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
| `engine-worker.ts` 190-216 e 218-234, più il tipo inline 129-146 e l'interfaccia `WasmEngine` 12-55 | nei due literal di `renderState`; le due esportazioni nuove, opzionali, nell'interfaccia |
| Mode B, `worker-bridge.ts` ~133-155 | `rs.transparentCount`, `rs.entityIdsGeneration` |
| Mode A, copia sul main thread ~267-289 | come il Mode B; `rs` viene inoltrato intero al render worker |
| `render-worker.ts`: tipo `RenderState` 21-39 e ricostruzione 92-113 | i due campi |
| `render/render-pass.ts`, `FrameState` | `transparentCount` (già normalizzato) e `frameStamp`. Quest'ultimo viene da un contatore locale della closure di `createRenderer`, quindi sopravvive agli swap del grafo e ai probe dell'HMR. Avanza una volta per `render()` con `stamp = stamp % 0xFFFFFFFE + 1`, e resta in [1, 0xFFFFFFFE]: mai 0, il valore di uno staging nuovo, e mai 0xFFFFFFFF, la sentinella (§5.2, §6.5) |

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
| `sort-gather-params` | pass | 16 B | UNIFORM, COPY_DST | `{limit, stamp, _pad0, _pad1}`. `stamp` è `FrameState.frameStamp` (§4.2), sempre in [1, 0xFFFFFFFE] |
| `sort-pass-params` | pass | 7 × 256 B | UNIFORM, COPY_DST | slice *p* = `{passIndex = p, 0, 0, 0}` |

**L'header `transparent-args`, parola per parola:**
- 0-4: `DrawIndexedIndirect {6, n, 0, 0, 0}`;
- 5-7: `DispatchIndirect {ceil(n/1024), 1, 1}`, all'offset 20 B;
- 8: `raw`, la somma dei 12 conteggi;
- 9: `limit`;
- 10: `overflow = raw > limit`;
- 11: `stamp`. `prepare()` ci scrive la sentinella 0xFFFFFFFF, e il gather la sovrascrive con lo `stamp` del frame. È l'unica parola che solo il gather può produrre, quindi prova che il gather è partito in quel frame (§6.5);
- 12-15: riservate.

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
4. Se `wid == 0 && lid == 0`, scrive l'header (§5.2), `stamp` compreso. È l'unico scrittore, quindi niente atomic.
5. `i = wid*256 + lid`; se `i >= n`, return. Viene dopo la barriera.
6. `k` = numero di `q` con `regionEnd[q] <= i`; `start = k ? regionEnd[k−1] : 0`; `slot = visibleIndices[regionBase[k] + i − start]`.
7. Calcola la chiave (§5.1). Scrive `keysA[i] = id`, `keysA[CAP+i] = zKey`, `valsA[i] = slot`.

I bucket 26/27 (Light2D) e 0..13 (opachi) non vengono mai letti. L'uscita *i* è una funzione pura dei conteggi e del contenuto delle regioni. Senza overflow, tra un frame e l'altro cambia solo l'ordine dentro una regione, mai l'insieme, e il sort cancella quell'ordine. Con overflow il taglio cade dentro una regione, in un punto deciso dall'ordine degli atomic del cull, quindi l'insieme disegnato non è deterministico (§6.3).

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
3. Hillis-Steele inclusivo **in place** su `totals` (il budget di 1024 B esclude un secondo array), con due barriere per passo:
   ```wgsl
   for (var off = 1u; off < 256u; off <<= 1u) {
       var v = 0u;
       if (d >= off) { v = totals[d - off]; }
       workgroupBarrier();
       totals[d] += v;
       workgroupBarrier();
   }
   ```
   Sono 8 passi e 16 barriere, 17 contando quella del punto 2. Il loop ha lunghezza costante, quindi sono tutte in flusso uniforme; l'unico ramo non uniforme non contiene barriere. La forma con una barriera sola (`totals[d] += totals[d-off]`) è una race. `select(0u, totals[d - off], d >= off)` non va bene: `select` valuta l'indice fuori intervallo anche per `d < off`.
4. `incl = totals[d]`; `digitBase[p*256 + d] = incl − sum`.
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
- In `prepare()`, una volta per frame: `GatherParams {limit = B, stamp = frame.frameStamp}`, il reset dell'header (`{6,0,0,0,0, 0,1,1, 0, B, 0, 0xFFFFFFFF, 0, …}`) e l'azzeramento dei 64 B di `diag`.
- **`execute()` non chiama mai `writeBuffer`**: la regola che `writeBuffer` arriva prima del *prossimo* submit la rende una trappola.
- `prepare()` gira prima dell'encoding di tutti i pass. Per questo i conteggi del cull il gather li legge sulla GPU, non la CPU.
- Le due struct uniform sono 4 × u32 con i pad espliciti. Le copre `uniform-layout.test.ts`.

### 5.5 Encoding e profiler

- **Senza profiler e senza readback:** un solo compute pass con i 22 dispatch. In un compute pass ogni dispatch è un proprio usage scope, e le scritture di uno sono visibili al successivo.
- **Con una readback in attesa (§6.5):** 2 compute pass. Il primo contiene il gather; poi vengono le copie dell'uscita del gather, poi il secondo pass con il sort, poi le altre copie.
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

**Da eliminare:** `RadixSortPass`, `radix-sort.wgsl`, `radix-sort-pass.test.ts`, e in `renderer.ts`: l'import `?raw` dello shader (L17), l'import della classe (L33), il commento di sezione (L327), la statica (L328), la voce nel factory (L466), lo slot (L577-582) e l'accept (L1020-1022). Va aggiornato anche il commento di `GraphPassFactories.scene` (`graph-assembly.ts:25`). `floatToSortKey` sparisce con il pass: il modello CPU ha la sua conversione (§7.1).

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
| Visibili > B (conteggio sbagliato) | `n = B`, flag di overflow nell'header, visibile dalla readback. **L'insieme disegnato non è deterministico**: il taglio cade dentro una regione, in un punto deciso dall'ordine degli atomic del cull. È accettabile solo perché l'overflow vuol dire che il conteggio della CPU è sbagliato. Le verifiche GPU pretendono `overflow == 0` (§7.3.3) |
| Parità di z dopo il riuso degli id | Resta davanti l'id più alto, che dopo 1 048 576 spawn cumulativi non è più per forza il più recente (D2). L'ordine resta deterministico; per ordinare gli sprite si usa `.depth()` |
| Light2D `.transparent()` | Escluso dal gather: i bucket 26/27 restano a `LightAccumStage` |
| Tipo ≥ 7 in `renderMeta` | Il cull lo mette già a 6 (bucket 26/27); l'uber fa lo stesso clamp e 6 → `culledVertex` |
| Mode A | Stesso renderer nel render worker; i campi arrivano perché `rs` viene inoltrato intero. Il problema del mondo vuoto resta com'è |

### 6.4 Capacità

- Una costante esportata **`MAX_GPU_ENTITIES = 100_000`**, in `types.ts` accanto a `MAX_EXTERNAL_ID`. Prende il posto delle quattro copie:
  - `renderer.ts:56`;
  - `cull-pass.ts:215` (uniform `maxEntitiesPerType`);
  - `cull-pass.ts:223` (`firstInstance`);
  - `types.ts:105`, il default `config.maxEntities ?? MAX_GPU_ENTITIES`. Se non fosse legato alla costante, abbassarla farebbe rifiutare a `validateConfig` il suo stesso default.

  Il valore non cambia, quindi `cull.wgsl` resta com'è. Il `CAP` del sort è `export const CAP = MAX_GPU_ENTITIES` in `transparent-sort-constants.ts`, non un literal nuovo. Il test di accordo del testo confronta il `CAP` del WGSL con quell'import.
- **`validateConfig` rifiuta `maxEntities > MAX_GPU_ENTITIES`** (D10), con un errore che nomina il limite.
- Il renderer emette un warning una tantum quando `entityCount > MAX_GPU_ENTITIES`, per gli spawn raw, che il facade non conta. Oltre quel valore oggi è già tutto rotto: il `writeBuffer` degli SoA fallisce la validazione.

### 6.5 Readback di dev: `engine.debug.readTransparentSort()`

`DebugProbe` non è un modello che si possa copiare così com'è. Serve dopo il submit del grafo, con un encoder suo (`renderer.ts:928`). L'uscita del gather invece va copiata DENTRO l'encoder del grafo, prima che la passata 1 la sovrascriva. E `RenderPass` non ha un hook dopo il submit.

- **Possesso.**
  - Le richieste vivono in un oggetto di sola dev posseduto dal renderer, `TransparentSortProbe`, accanto a `DebugProbe`. Si crea solo quando esiste `debugProbe` ed è esposto su `Renderer`.
  - Il facade lo raggiunge come fa `readEntityTransforms`: `engine.debug.readTransparentSort(): Promise<TransparentSortReadback>`.
  - L'oggetto sopravvive agli swap del grafo. Il suo `destroy()` rifiuta tutte le richieste in attesa.
- **Instradamento.**
  - Il factory `scene` passa l'oggetto al costruttore: `new TransparentSortPass(sortProbe)`.
  - Lo slot HMR costruisce `new TransparentSortPass()` senza, quindi le istanze usa e getta non vedono mai le richieste.
  - I grafi in attesa e quelli ritirati non eseguono mai `execute()`, quindi serve solo l'istanza viva.
- **Servizio: una richiesta per frame, in ordine FIFO.**
  - Se in `execute()` c'è una richiesta in attesa e il sort gira in quel frame, il pass prende quella in TESTA e le consegna `frame.frameStamp`. Le altre restano in coda per i frame successivi. Il probe allora crea per QUELLA richiesta buffer di staging NUOVI (`MAP_READ | COPY_DST`), che appartengono alla richiesta e non al pass: un `destroy()` del pass non può interrompere un map.
  - Il pass si limita a codificare le copie:
    - l'uscita del gather (chiavi `lo`/`hi` e valori A), subito dopo il dispatch del gather: si chiude il compute pass, si copia, se ne apre un altro;
    - alla fine, l'header, `digitBase` + `diag` di `sort-hist`, e `transparent-order`.
  - **`execute()` e `prepare()` non chiamano mai `mapAsync`.** Un buffer in attesa di map al momento del submit invalida il command buffer di tutto il frame.
  - N richieste emesse insieme leggono N frame consecutivi.
- **Mappatura.**
  - Dopo `host.graph.render()`, nello stesso punto di `debugProbe.serve`, il renderer chiama `sortProbe.finish(source)`, che fa `mapAsync` sui buffer della richiesta servita.
  - Solo nei frame con una readback, `host.graph.render()` è avvolto negli error scope `validation` e `out-of-memory`. Un errore in quel frame rifiuta la richiesta.
  - Se `host.graph.render()` lancia, il renderer rifiuta la richiesta presa e tutte quelle in coda prima di rilanciare.
  - I buffer si distruggono dopo `unmap` o al rifiuto.
- **Snapshot della CPU**, preso in `finish(source)` in modo sincrono, prima di qualunque `await`, come fa `serveTransforms`: al momento della risposta `latestRenderState` è già stato sostituito. Il pass vede solo `FrameState`, quindi lo snapshot lo compone il renderer, dai valori ancora in scope subito dopo `host.graph.render()`:
  - `state.tickCount`, `frameStamp`, `state.entityCount`;
  - il conteggio e la generazione normalizzati, e il flag "id caricati in questo frame";
  - `Boolean(useScatter)` e `camera.viewProjection`;
  - fette di `state.bounds`, `state.entityIds`, `state.renderMeta` e `state.texIndices`.
- **Risultato:**
  ```ts
  interface TransparentSortReadback {
    frame: {
      tickCount: number; stamp: number; entityCount: number;
      transparentCount: number;            // normalizzato (§4.2)
      idsGeneration: number; idsUploaded: boolean; usedScatter: boolean;
      viewProjection: Float32Array;        // 16
      bounds: Float32Array;                // 4 × entityCount, fetta dello state del frame
      entityIds: Uint32Array;              // entityCount
      renderMeta: Uint32Array;             // 2 × entityCount
      texIndices: Uint32Array;             // entityCount: la regione (tier > 0 o overflow)
    };
    n: number; raw: number; limit: number; overflow: boolean;
    diag: Uint32Array;                     // 16
    gathered: { lo: Uint32Array; hi: Uint32Array; vals: Uint32Array };  // n ciascuno
    digitBase: Uint32Array;                // 7 × 256
    order: Uint32Array;                    // n
  }
  ```
  La tabella dei tile non si copia: nessun controllo la usa.
- **Input.** La CPU ha già gli input nello snapshot, quindi `COPY_SRC` in dev serve solo sui buffer del sort. `visible-indices`, `entity-bounds` e `indirect-args` non si toccano.
- **Rifiuti.** Si rifiuta invece di rispondere con degli zeri:
  - quando la parola 11 dell'header copiato (§5.2) non è lo `stamp` di quel frame. I valori sbagliati hanno due firme: 0 vuol dire che la copia non è partita (lo staging è nuovo, e WebGPU lo inizializza a zero); 0xFFFFFFFF vuol dire che il gather non è partito (la sentinella di `prepare()`). Lo stamp non può valere nessuno dei due;
  - **dopo un frame in cui la coda non era vuota e il pass vivo non ha preso nessuna richiesta** (sort saltato con conteggio 0, oppure nessun `TransparentSortPass` vivo ha eseguito `execute()`): il renderer rifiuta la richiesta in TESTA, con l'errore "nessun trasparente in questo frame". Quelle dietro restano in coda e seguono la stessa regola nei frame successivi. Il probe sa se `take()` è stato chiamato nel frame grazie a un flag per frame che `finish()` controlla e azzera. Una richiesta presa si rifiuta solo per lo stamp o per l'error scope. Uno swap del grafo da solo non impedisce di prendere una richiesta: il pass vivo nuovo nasce con lo stesso `sortProbe`;
  - quando c'è un errore di validazione nel frame;
  - nel Mode A, senza renderer, in pausa, e al `destroy()`.
- **Niente anello per frame.** Con il limite B vero e i dispatch indiretti non avrebbe più un compito.
- I tempi del profiler vanno letti in frame senza readback.

## 7. Test e verifica

### 7.1 Modello CPU

Due file: `ts/src/render/passes/transparent-sort-reference.ts` e `transparent-sort-constants.ts`. Le costanti (`TILE`, `ROUNDS`, `RADIX`, `PASSES`, `FIRST_TRANSPARENT_ARG = 14`, `GATHER_REGIONS = 12`, `CAP = MAX_GPU_ENTITIES`, importato da `types.ts`) si condividono con il pass e con i test di accordo del testo WGSL. È un simulatore a fasi degli **stessi** kernel.
- **Buffer:** `Uint32Array` con il layout GPU parola per parola (header, `SortHist`, chiavi SoA, valori), così una readback si confronta direttamente.
- **Kernel:** `cpuGather`, `cpuUpsweep`, `cpuScan` e `cpuScatter` sono liste di fasi, una per intervallo tra barriere, e rispecchiano il WGSL riga per riga. **Ogni fase WGSL separata da una barriera è un loop sui lane in TS.** `cpuScan` modella ogni passo di Hillis-Steele come DUE fasi: prima la lettura in una `v` per lane, poi la scrittura. Così il verificatore di race fissa quella struttura.
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
- con `raw ≤ limit`, il risultato non cambia mescolando il contenuto delle regioni, l'ordine dei tile o quello dei thread;
- overflow (`raw > limit`): `n = B`, flag alzato, argomenti del draw `{6, B, 0, 0, 0}`, e l'uscita è una permutazione ordinata del prefisso raccolto. L'invarianza al mescolamento delle regioni qui NON vale;
- lo `stamp` del frame arriva nella parola 11 dell'header;
- input vuoto: argomenti `{6, 0, 0, 0, 0}` e nessuna scrittura;
- i bucket 0..13 e 26/27, **riempiti apposta**, non vengono mai letti.

### 7.2 Test headless del codice

- **Accordo tra testo WGSL e TS:**
  - costanti ed entry point;
  - tipi dei binding contro i layout;
  - storage per layout ≤ 8 (gather 7, sort 6), e ogni binding dichiarato viene letto;
  - memoria di workgroup per entry point ≤ 16 384 B (96 / 1024 / 1024 / 9216);
  - `PASSES` dispari, quindi il risultato va in `transparent-order`;
  - il `CAP` del WGSL è uguale a `MAX_GPU_ENTITIES`;
  - `scan_main` contiene nel testo esattamente 3 `workgroupBarrier()`: una prima del loop, dopo `totals[d] = sum`, e 2 nel corpo di Hillis-Steele, con la lettura in `v` prima della prima e `totals[d] += v` fra le due. Il conteggio ESEGUITO, ricavato dai limiti del loop letti nel testo (off = 1..128, 8 iterazioni), è 1 + 2·8 = 17, e deve coincidere con i confini di fase di `cpuScan` (numero di fasi − 1). Un WGSL con una barriera per passo darebbe 2 nel testo e 9 eseguite: la deriva si vede in entrambi i controlli.
- **`TransparentSortPass` su device finto:**
  - `PassParams` scritti una volta nel `setup()`;
  - `GatherParams`, header e `diag` una volta per `prepare()`;
  - **nessun `writeBuffer` in `execute()`**;
  - il bind group *p* punta all'offset 256·*p* con la direzione giusta;
  - dispatch diretti (391 / 1) e indiretti all'offset 20;
  - 1 compute pass senza profiler e senza readback, 2 con una readback in attesa, 22 con il profiler; `profileStages` uguale a `mark`, anche nel caso saltato;
  - con count 0 non si codifica nulla;
  - `minBindingSize` su ogni voce;
  - il `setup()` non scrive nel pool.
- **`TransparentSortProbe` su device finto:**
  - `execute()` e `prepare()` non chiamano mai `mapAsync`;
  - le copie di un frame con readback vanno in buffer presi dalla richiesta, mai dal pass;
  - due richieste emesse insieme, con conteggio > 0: dopo il frame 1 la prima è servita e la seconda è ancora in coda (non rifiutata); dopo il frame 2 è servita anche la seconda, con lo stamp successivo. Le due usano buffer diversi;
  - due richieste in coda con conteggio 0: dopo il frame viene rifiutata solo quella in testa, e la seconda resta in coda;
  - se `host.graph.render()` lancia, la richiesta presa e quelle in coda vengono rifiutate;
  - un pass costruito senza probe (quello dell'HMR) non tocca le richieste;
  - uno `stamp` sbagliato nell'header copiato fa rifiutare la richiesta, e così un header tutto a zero (la copia non è partita);
  - il contatore del renderer: il primo stamp vale 1, e dopo 0xFFFFFFFE torna a 1;
  - `destroy()` rifiuta tutte le richieste in attesa.
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

Si verifica sull'iGPU AMD (adapter low-power), con la skill `/gpu-check`, in Mode B e in Mode C, con la pagina a una dimensione fissa (`resize_page` 1920×1080). Si registrano la dimensione della canvas e il `devicePixelRatio`, perché `fitView` inquadra in base all'aspetto.

1. **La baseline del passo 0**, senza perdita. Si cattura sul commit base del branch e si salva in `docs/plans/assets/2026-09-27-transparent-sort-baseline/`, con lo script di cattura committato accanto: il corpo di `evaluate_script`, riusato identico ai passi 1-4.
   - **Punto di cattura**, definito nello script: (1) un clic sul tab; (2) attesa della FINE del `setup()` del tab. Si osserva senza codice dell'app: prima del clic lo script avvolge `setup` del modulo della sezione (`const m = await import('/src/demo/<key>.ts')`; l'import lazy di `main.ts` risolve alla stessa istanza del modulo). In alternativa si usa un'attesa fissa oltre il setup più lento (almeno 7 s) più due letture identiche degli stati a 1 s di distanza; (3) `frames(4)`; (4) la finestra per S; (5) gli stati, letti in quello stesso punto: nessun check in pending tranne i 4 d'interazione dell'Input. Ogni tab si visita una volta sola per cattura, in ordine fisso, da una navigazione pulita, perché rientrare in un tab ne rilancia il `setup`.
   - **Punti:** si legge `engine.debug.probe({ target: 'scene-hdr', uv })` su una griglia UV fissa 64×36, più i punti del mondo copiati dai check esistenti. Questi si proiettano con la `viewProjection` del frame di cattura (lo stesso `worldToUv` del probe) e si scartano quelli fuori da [0,1]: un solo punto fuori schermo fa rifiutare al probe l'intera richiesta. Gli scartati si registrano. Per esempio, la scena della depth di 2D Twins (x ≈ 36-43) al momento della cattura è fuori schermo: la baseline non la copre, e la coprono direttamente i check nuovi di §7.3.4.
   - Si salva `<mode>-<tab>.json` con dimensione della canvas, `devicePixelRatio`, `viewProjection`, punti, valori e punti scartati.
   - **Maschera statica S_x di una corsa x:** i punti con valori identici al bit in 10 letture successive.
   - **Impronta del moto M_x:** 10 letture non bastano, perché la fase di un'animazione dipende dal tempo e cambia fra una corsa e l'altra. M_x si ricava dalla CPU:
     - due istantanee di `engine.debug.readEntityTransforms()` (righe CPU + id per slot), prese ad almeno 1 s di distanza; un'entità si muove se la sua riga cambia fra le due;
     - l'impronta di un'entità mobile è la sua sfera proiettata, di raggio ½·(|colonna 0| + |colonna 1|) della riga (conservativo per un quad sotto scala e rotazione), spazzata fra le due posizioni e dilatata di 2 px;
     - il **tab Lighting** anima tutto ciò che le sue luci raggiungono, quindi non contribuisce punti al confronto al bit: lo coprono i suoi check e i suoi stati.
   - **Insieme di confronto C = S_base ∩ S_run \ (M_base ∪ M_run).**
   - **T ⊂ C:** i punti coperti da un'entità `.transparent()`, ricavati dalla CPU in modo conservativo (sfera di bounds proiettata con la `viewProjection`).
   - **Verifica preliminare al passo 0:** due catture dello stesso commit, fatte in due caricamenti di pagina diversi, coincidono al bit su C. Dimostra che C elimina la varianza fra le corse prima di usarlo come cancello.
   - **Stati:** per tab e per modo, il testo `N/M passed` più il nome e lo stato di ogni check (`statuses-<mode>.json`), letti nella stessa corsa, senza fermare le animazioni: 'Velocity' e il check delle righe in scatter del Mode C in 2D Twins dipendono dal moto. Oggi l'Input è a 2/6 con 4 check di interazione in pending, e in Rendering FX 'Tonemap switch' è in skip.
   - I vecchi JPEG di `assets/2026-09-27-harness-baseline` restano solo come riferimento visivo: sono con perdita, coprono 5 tab su 10 e sono più vecchi di HEAD.
2. **Validazione degli shader.** Per i 7 moduli composti (uber compreso) è bloccante al passo 1; per `transparent-gather.wgsl` e `transparent-sort.wgsl` è bloccante al passo 3:
   - Chrome: `getCompilationInfo` e creazione delle pipeline dentro `pushErrorScope('validation')` per gather, sort, uber e i 6 moduli per tipo composti.
   - Firefox: uno script scrive su file i moduli composti (e al passo 3 gather e sort), e la CLI `naga` (`cargo install naga-cli`, lo stesso front-end di Firefox) li valida tutti.
   - Safari: non si può provare qui. È un rischio accettato (§10).
3. **`readTransparentSort()` su scene vere.** Le scene dedicate riempiono **tutte e 12 le regioni del gather**. Per OGNI tipo 0-5 c'è almeno un'entità `.transparent()` a schermo con indice di texture 0 (regione pari 14+2t) e almeno una con l'indice impacchettato di un PNG 128×128 committato in `ts/public/` (regione dispari 15+2t). Quel PNG finisce nel tier 1, o in overflow, su qualunque device; oggi nessun tab carica texture.
   - `.texture()` vale per ogni primitiva. In un gradiente texturizzato però G/B dello stop 1 vengono dai byte bassi dell'indice (il gotcha del gradiente), e msdf campiona il PNG come MSDF. Ai controlli del gather non importa, ma queste entità non si riusano nei check pixel di §7.3.4.
   - Ogni controllo prima aspetta che lo stato del frame contenga la scena, riprovando sul rifiuto "nessun trasparente in questo frame" con un timeout di 3 s come `pixelCheck`. Nel Mode B `latestRenderState` è indietro di un tick.
   - Ogni controllo usa lo snapshot `frame` della stessa risposta:
   - (a) **Insieme raccolto.** I `gathered.vals` sono unici, ognuno `< entityCount`, con il bit 8 e un tipo (`& 0xFF`) ≤ 5 in `frame.renderMeta`. `order` ne è una permutazione.
   - (b) **Sovrainsieme.** Ogni slot raccolto supera il test sfera-frustum a raggio ALLARGATO che usa `deriveLightGroups` (`r·1.01 + 1e-3`).
   - (c) **Sottoinsieme.** Ogni riga trasparente di tipo 0-5 che supera il test a raggio RIDOTTO (`r·0.99 − 1e-3`) è presente. Nelle scene dedicate, dove tutti i trasparenti sono a schermo, questo diventa un'uguaglianza esatta di insiemi.
   - (d) **Conteggi.** `overflow == 0`, `n == raw`, `raw ≤ frame.transparentCount`, `diag == 0`.
   - (e) **Chiavi, elemento per elemento:** `gathered.lo[i] == frame.entityIds[vals[i]]` e `gathered.hi[i] == sortableZBits(bits di frame.bounds[4·vals[i]+2])`, con i bit letti tramite una vista `Uint32Array`. Qui si vede una colonna id vecchia, a qualunque distribuzione di z. Le scene non usano `positionImmediate`, perché nei frame con lo scatter il Mode C non carica i bounds corretti da `patchBounds`.
   - (f) **Ordine.** `order` è uguale all'oracolo (`Array.sort` dell'insieme raccolto per chiavi ricalcolate). `digitBase[p]` è uguale allo scan esclusivo dell'istogramma della cifra *p* delle chiavi ricalcolate, perché non dipende dall'ordine.
   - (g) **Due frame consecutivi.** Due richieste emesse insieme vengono servite in frame consecutivi: gli `stamp` sono consecutivi. In una scena statica, la sequenza degli id in `order` è identica.
   - (h) **Mode C con ricambio.** `?mode=C` con spawn e despawn a ogni frame, e molti trasparenti alla stessa z (il caso 2D comune, così l'oracolo esercita il pareggio per id). Almeno un frame servito deve avere `usedScatter && idsUploaded`.
   - (i) **Regioni.** Si classifica ogni slot raccolto per `(renderMeta & 0xFF, tier > 0 || overflow)`, con tier e overflow letti da `frame.texIndices`. Tutte e 12 le classi devono essere non vuote.
4. **Pixel nel tab 2D Twins: check NUOVI con un nome loro** (per esempio 'Depth orders transparent sprites'). Stanno accanto a `checkDepth` e ne riusano la struttura: gradienti colorati, probe su `scene-hdr`, 10 frame stabili, depth cambiate a runtime. 'Depth orders 2D sprites' resta invariato. Gli sprite nuovi non coprono i punti del probe del check esistente, e stanno fuori dalla vista delle coppie gemelle che il `setup()` ripristina alla fine (`twin-2d.ts:259`), oppure vengono rimossi dopo il loro check. Così la regola dei pixel di §7.3.5 resta valida per 2D Twins. I check verificano:
   - sprite `.transparent()` sovrapposti di tipi diversi, disegnati nell'ordine di z. Le coppie devono distinguere l'ordine: gradienti di colori diversi, un box shadow colorato e semitrasparente, lo sprite con la texture. Due sprite bianchi opachi, per esempio quad su quad, danno lo stesso colore in entrambi gli ordini e non provano niente;
   - a parità di z sta davanti l'id più alto;
   - l'ordine si inverte quando le depth cambiano a runtime;
   - i valori attesi si calcolano in forma chiusa dal blend a alfa dritto (`bg·(1−a) + c·a`; con alfa 1, il colore di sopra) e si leggono con il probe su `scene-hdr`.
5. **Nessuna regressione**, contro la baseline del punto 1:
   - **stati**: nessun check fallito; ogni tab ha gli stessi check in skip o pending della baseline; ogni check che passava passa ancora; un pending che nella baseline arriva a pass (Scene Graph 'Velocity', Lighting 'Backend lit') ci arriva anche qui. Si confrontano solo i nomi di check già presenti nella baseline: 2D Twins ne guadagna di nuovi, che devono passare;
   - **pixel**: ai passi 1, 2 e 3 tutti i punti di C sono identici al bit (f16). Al passo 4 lo sono i punti di C \ T, mentre quelli di C ∩ T stanno entro |Δ| ≤ 1/255 per canale;
   - **i check esistenti passano INVARIATI al passo 4.** Nessun trasparente esistente si sovrappone a un altro trasparente: i tre box shadow di Primitives e la cella box shadow di 2D Twins sono isolati. Un fallimento lì è quindi una regressione dell'uber, non un nuovo ordine. Solo i check nuovi del punto 4 dipendono dall'ordine dei trasparenti.
6. **Prestazioni**, con lo **scenario di benchmark committato**: `docs/plans/assets/2026-09-27-transparent-sort-bench.js`, il corpo di `evaluate_script`, usato identico ai passi 0, 1, 3 e 4. Il file fissa:
   - canvas 1920×1080;
   - un mondo altrimenti vuoto: il passo 0 aggiunge a `main.ts` un flag di sola dev `?bench`, che non apre nessuna sezione;
   - N = 1 000, 10 000 e 100 000 quad 2D `.transparent()` da 16×16 px a schermo, tutti dentro la vista. 100 000 è esattamente `CAP` (98 tile pieni): il facade controlla `entityCount >= maxEntities` PRIMA dello spawn, quindi un mondo di esattamente `maxEntities` ci sta. Lo script distrugge il lotto precedente prima di crearne uno nuovo; `destroy()` abbassa `entityCount` subito;
   - depth tutte a 0, oppure tutte distinte in [0, 999], dentro near/far della camera di default;
   - illuminazione spenta, profiler acceso, media della finestra da 120 frame, in frame senza readback.

   **Soglia: "sort" = la somma delle medie di `transparent-sort/{gather,upsweep,scan,scatter}`, < 1 ms a 100 000.** L'encoding del profiler (22 compute pass più i marker, contro 1) ne fa un limite superiore del costo in produzione.

   **Il `forward`** si misura ai passi 0, 1, 3 e 4 con lo stesso scenario:
   - 1 − 0 è il costo della composizione (moduli composti, `VertexOutput` più largo);
   - 4 − 3 è il costo del passaggio al draw uber: la pipeline, l'ordine ordinato, un draw al posto di 12. Non va attribuito solo alla pressione sui registri.

   Le misure si salvano in `docs/plans/assets/`.

### 7.4 Prima del merge

`scripts/preflight.sh --full`, poi `adversarial-review` sul range del branch, e gli agent `wgsl-validator`, `webgpu-pass-reviewer` e `protocol-sync-checker` (per le due esportazioni nuove).

## 8. Ordine di implementazione

| Passo | Contenuto | Criterio di uscita |
|---|---|---|
| 0 | Baseline, sul commit base e senza codice nuovo tranne il flag `?bench` | Baseline senza perdita e stati dei tab (§7.3.1), in Mode B e C. Tempo di `forward` con lo scenario di benchmark committato (§7.3.6). Tutto salvato in `assets/` |
| 1 | Composizione (§3) | Test headless verdi. Validazione di §7.3.2 per i 7 moduli composti (uber compreso): Chrome, più naga per Firefox; è un criterio bloccante. Sulla GPU i 7 moduli composti compilano e le pipeline si creano, uber compreso, ancora non disegnato. **Stati uguali alla baseline e tutti i punti di C identici al bit**: in questo passo i trasparenti usano ancora le pipeline per tipo. `forward` misurato. L'HMR di un pezzo funziona, compreso il reload raggruppato |
| 2 | Colonna id e conteggio (§4), capacità (§6.4) | Test Rust e TS verdi, `protocol-sync-checker` pulito, stati uguali alla baseline, C identico al bit |
| 3 | Gather + sort (§5), readback (§6.5) | Modello CPU e test del pass verdi. Validazione di §7.3.2 per `transparent-gather.wgsl` e `transparent-sort.wgsl` (Chrome + naga), bloccante. `ForwardPass` legge già le uscite del sort, quindi il sort gira a ogni frame, ma il draw non cambia ancora. Sulla GPU, i controlli (a)-(h) di §7.3.3 passano; il sort misurato resta < 1 ms a 100 000; `forward` misurato (è il riferimento del passo 4); stati e C invariati |
| 4 | Draw uber (§6.2) | Check pixel nuovi (§7.3.4) verdi; nessuna regressione (§7.3.5); `forward` misurato contro il passo 3 |
| 5 | Chiusura | Documentazione (§9), `preflight --full`, review avversariale, merge |

## 9. Documentazione e strumenti da aggiornare

- **CLAUDE.md:**
  - la tabella degli shader: pezzi, compositore, `transparent-gather`/`transparent-sort`, niente `radix-sort`;
  - le righe di `renderer.ts`/`forward-pass.ts`, con "device-lost recovery" corretto in "logga e chiama `onDeviceLost`";
  - i gotcha: `fs_occluder` + `OCCLUDER_PASS`, `CameraUniform` a 80 B nel preludio, gruppo 2 solo da `fs_main`, "aggiungere una primitiva" (libreria + riga di tabella + caso uber generato), la direttiva dell'uber, `ForwardPass`'s 12 pipeline, `RadixSortPass` morto;
  - da riscrivere in termini di preludio:
    - "Multi-pipeline ForwardPass shared bind group layout": il preludio dichiara i gruppi 0, 1 e 2 una volta per tutti i moduli composti, e il gruppo 2 si raggiunge solo da `fs_main` tramite `applyLighting`;
    - "Packed texture index 0": `sampleTierOrWhite` nel preludio, con `msdf` volutamente su `sampleTier` crudo;
    - la riga di `render/light-groups.ts`: `LIT_PRIMITIVE_TYPES` è ricavato da `PRIMITIVE_LIBRARIES`, e il test è di raggiungibilità, non di dichiarazione di `@group(2)`;
  - la nota sull'hot-reload: i pezzi si validano insieme, e da soli come ripiego, e un grafo non nasce mai da un insieme respinto o non provato; con file indipendenti, un solo file rotto non blocca gli altri, ma una modifica accoppiata salvata insieme a un pezzo rotto va risalvata (§3.3);
  - i conti: 22 importati / 20 ricaricabili a caldo, 24 file `.wgsl`;
  - una voce nuova per `TransparentSortPass`, `entity-ids`, la generazione e `transparentCount`. Deve riportare l'avvertenza di D2: a parità di z vince l'id più alto, che dopo il riuso degli id non è più per forza il più recente; per ordinare si usa `.depth()`;
  - il conteggio dei test.
- **Skill `new-primitive`:** una primitiva nuova diventa una libreria in `shaders/primitives/`, più una riga in `PRIMITIVE_LIBRARIES`, più i test del compositore.
- **Agent:**
  - `wgsl-validator`: il punto 1 passa da "i sei shader" a preludio più moduli composti ("22 WGSL shaders" va aggiornato); il punto 5 dice che lo switch dei tier ora sta in `sampleTier` nel preludio;
  - `webgpu-pass-reviewer`: l'header `transparent-args`, gli argomenti del draw uber;
  - `claude-md-auditor.md:85`: conta anche `ts/src/shaders/primitives/*.wgsl` (per esempio `find ts/src/shaders -name '*.wgsl'`).
- **Hook `.claude/hooks/post-edit-notices.sh`:** il caso `*.wgsl` si divide per percorso:
  - `*/shaders/primitives/prelude.wgsl`: binding, `CameraUniform` e blocco luci vivono solo qui; cambiare un binding vuol dire cambiare `primitive-bindings.ts` e i due pass; eseguire i test del compositore;
  - gli altri pezzi in `*/shaders/primitives/`: una libreria non dichiara binding, entry point, direttive né `fn fs_occluder`, ed espone solo `<prefix>_vs/_fs/_occluder`; eseguire i test di `primitive-shaders`;
  - il messaggio di oggi resta solo per gli shader di primo livello.

  Va aggiornata di conseguenza la riga dell'hook in `.claude/hooks/README.md`.
- **PROJECT_ARCHITECTURE.md:** le sezioni sul render, sulla visibility indirection, sulla ForwardPass multi-pipeline, sull'hot-reload e il glossario.
- **Masterplan:** il rischio "manca un preprocessore WGSL" risulta risolto dal compositore TS.

## 10. Rischi

| Rischio | Contromisura |
|---|---|
| Un front-end WGSL rifiuta la direttiva globale `diagnostic`. **Dal passo 1**, `ForwardPass.setup` costruisce l'uber, quindi `RenderGraphHost` rifiuta ogni grafo che non sia quello iniziale: `enableBloom`/`enableOutlines` non vanno mai live, il backend `'lit'` resta spento in silenzio, e ogni probe dell'hot-reload che include `ForwardPass` viene rifiutato. Continua a disegnare solo il grafo iniziale, costruito in modo sincrono. **Dal passo 4** si perdono anche i frame con trasparenti | La validazione è un criterio bloccante del passo 1 (§7.3.2): Chrome con `getCompilationInfo` più pipeline in un error scope; Firefox con la CLI `naga`, lo stesso front-end (la direttiva è supportata dalla PR #6148). Safari non si può provare qui: è un rischio accettato, perché la direttiva è WGSL core coperto dalla CTS. Piano B se arriva una segnalazione: portare fuori dallo switch `fwidth(uv.y)` di `line` e `dpdx`/`dpdy(uv)` di `msdf`, e riscrivere `fwidth(d)` di `bezier` con la regola della catena |
| Il passaggio al draw uber rallenta il `forward`: registri dimensionati sul caso più pesante, ordine ordinato, un draw al posto di 12 | Misura del `forward` ai passi 3 e 4 (§7.3.6), attribuita al passaggio nel suo insieme e non alla sola pressione sui registri |
| Contese sugli atomic in memoria di workgroup con z tutte uguali | Misura del caso peggiore; se serve, privatizzazione (§5.7) |
| Colonna id vecchia (generazione non trasportata o non incrementata): pareggi rotti senza nessun diag | Normalizzazione a `NaN`, test per ogni sito di trasporto, readback con le chiavi ricalcolate |
| `transparentCount` perso in un sito di trasporto (Mode A non verificabile qui) | Normalizzazione a `entityCount`, test della ricostruzione nel render worker |
| Il modello CPU e il WGSL restano due codebase | Rispecchiamento riga per riga, test di accordo del testo, readback confrontata con l'oracolo |
| Una regressione dell'uber scambiata per "nuovo ordine" | Nessun check esistente dipende dall'ordine dei trasparenti (§7.3.5): passano invariati, e un loro fallimento è una regressione. Solo i check nuovi di §7.3.4 dipendono dall'ordine |
| La composizione (passo 1) cambia gli ultimi bit dei vertici (contrazione FMA, inlining) | C identico al bit al passo 1 è bloccante: una differenza si spiega prima di andare avanti |
| Le righe degli errori di compilazione non corrispondono ai file | Marcatori `// --- piece: X ---` |
| Il budget del profiler (256 marker) è condiviso | 22 marker più quelli di `LightGroupsPass` per set. Oltre il budget `beginFrame` lascia il frame non misurato; nessun effetto sul rendering |

## 11. Misure (passi 0-4)

Scenario committato `assets/2026-09-27-transparent-sort-bench.js`, iGPU AMD (adapter low-power: `amd / rdna-3, subgroups 32-64`), canvas 1920×1080, illuminazione spenta, profiler acceso, media della finestra da 120 frame senza readback. Valori in ms; i JSON sono `assets/2026-09-27-transparent-sort-bench-step{0,1,3,4}.json`.

| Quad trasparenti | Depth | forward p.0 | forward p.1 | forward p.3 | forward p.4 | 1−0 (composizione) | 4−3 (draw uber) | total 1−0 | total 4−3 | sort p.3 | sort p.4 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 000 | tutte a 0 | 0.162 | 0.161 | 0.170 | 0.177 | -0.001 | 0.006 | -0.002 | 0.016 | 0.248 | 0.249 |
| 1 000 | distinte | 0.163 | 0.162 | 0.169 | 0.176 | -0.001 | 0.007 | -0.003 | 0.015 | 0.248 | 0.248 |
| 10 000 | tutte a 0 | 0.192 | 0.189 | 0.185 | 0.183 | -0.003 | -0.002 | 0.002 | 0.011 | 0.328 | 0.314 |
| 10 000 | distinte | 0.191 | 0.188 | 0.182 | 0.186 | -0.003 | 0.004 | 0.002 | 0.055 | 0.336 | 0.343 |
| 100 000 | tutte a 0 | 0.262 | 0.265 | 0.235 | 0.214 | 0.003 | -0.021 | -0.129 | 0.251 | 0.813 | 0.787 |
| 100 000 | distinte | 0.264 | 0.265 | 0.229 | 0.211 | 0.001 | -0.018 | -0.043 | 1.137 | 0.867 | 0.869 |

- 1−0 è il costo della composizione (moduli composti, `VertexOutput` più largo).
- 4−3 è il costo del passaggio al draw uber nel suo insieme: la pipeline uber, l'ordine ordinato, un draw al posto di 12. Non va attribuito alla sola pressione sui registri.
- Il profiler separa i pass con compute pass vuoti e parte dei frammenti del forward può cadere nel pass successivo: i delta del `forward` vanno letti insieme a quelli di `total` (somma di tutti i pass).
- "sort" è la somma delle medie di `transparent-sort/{gather,upsweep,scan,scatter}`. Con il profiler sono 22 compute pass più i marker contro 1, quindi è un limite superiore del costo in produzione. Soglia (D3): < 1 ms a 100 000.
- Cancello del passo 4: `assets/2026-09-27-transparent-sort-step4-compare-{B,C}.txt` (C \ T identici al bit, C ∩ T entro 1/255, stati uguali alla baseline).

**Apple M2 Pro / Metal, Chrome 154.0.8037.58** (MacBook Pro 14", GPU a 16 core; test M8 del Mac, 2026-09-30; alimentatore collegato, 65 W, Low Power Mode 0, ma a batteria dalle 09:17:31 alle 09:20:01, prima di qualsiasi run, e il primo run è partito alle 09:20:25; l'altra istanza di Chrome su `about:blank` per tutta la prova). Stesso scenario, nel formato `/2` (profiler con i `timestampWrites` sui pass veri), `?mode=B&bench`, canvas 1920×1080, illuminazione spenta. I passi 3 e 4 sono `6ff494f` e `608a113` con sopra i 9 commit di codice del profiler; HEAD è `038fc0b`. Media di due run per passo, ognuno con un caricamento di pagina nuovo; valori in ms. I JSON e i valori per run sono in `assets/2026-09-29-mac-m2/` (`bench-{step3,step4,head}.json`, `bench-{step3,step4,head}-run2.json`, README § M8).

| Quad trasparenti | Depth | total p.3 | total p.4 | total HEAD | total 4−3 | sort p.3 | sort p.4 | sort HEAD | forward p.3 | forward p.4 | forward HEAD |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 000 | tutte a 0 | 1.180 | 1.238 | 1.217 | 0.058 | 0.479 | 0.467 | 0.476 | 0.127 | 0.126 | 0.132 |
| 1 000 | distinte | 1.196 | 1.295 | 1.213 | 0.099 | 0.482 | 0.493 | 0.478 | 0.129 | 0.134 | 0.133 |
| 10 000 | tutte a 0 | 1.732 | 1.945 | 1.949 | 0.213 | 0.550 | 0.546 | 0.548 | 0.455 | 0.650 | 0.652 |
| 10 000 | distinte | 1.714 | 1.942 | 1.935 | 0.228 | 0.542 | 0.547 | 0.541 | 0.452 | 0.650 | 0.650 |
| 100 000 | tutte a 0 | 4.834 | 5.174 | 5.285 | 0.339 | 0.818 | 0.655 | 0.682 | 3.467 | 4.040 | 4.110 |
| 100 000 | distinte | 4.869 | 5.227 | 5.333 | 0.359 | 0.846 | 0.688 | 0.704 | 3.475 | 4.055 | 4.131 |

- `total` è lo span del frame (`getGpuFrameTiming()`) e si confronta con il `total` AMD della tabella sopra. `sort` e `forward` qui sono intervalli dei pass veri, non bracket fra marker, e non si confrontano uno a uno con le colonne AMD. Sull'M2 `forward` e `fxaa-tonemap` si sovrappongono, quindi `forward` non è il costo del forward.
- I due run di un passo differiscono al massimo di 0.138 ms a 1 000, di 0.034 a 10 000 e di 0.835 a 100 000 (HEAD, a 15 minuti l'uno dall'altro). A 100 000 ogni secondo run è più veloce del primo (6 casi su 6) e la differenza segue la distanza fra i due run: passo 4 (partiti alle 09:32 e alle 09:33) 0.155/0.169, passo 3 (09:29 e 09:37) 0.391/0.742, HEAD (09:20 e 09:35) 0.835/0.601. Sembra una deriva, o uno stato di clock della GPU, non un effetto del ricaricare la pagina. A 10 000 i delta fra passi escono dal rumore; a 1 000 no (4−3 vale +0.058/+0.099 ms, contro 0.138), e a 100 000 no.
- 4−3 sull'M2: +0.213/+0.228 ms a 10 000 (per run da +0.198 a +0.233), +0.339/+0.359 a 100 000 in media (per run da +0.07 a +0.65). Le depth distinte non costano di più: distinte − uguali vale −0.069 e +0.165 ms a HEAD nei due run, contro +0.954 su AMD al passo 4. Il +1.137 ms di AMD a 100 000 con depth distinte non si riproduce sull'M2 (6 confronti appaiati entro −0.14..+0.21 ms, contro +0.954 su AMD); la regola della handoff (`docs/handoff/2026-09-29-mac-m2-handoff.md`, M8) lo leggerebbe come costo di località delle GPU immediate-mode, ma qui non è misurato (due GPU, due profiler, AMD a run singolo: lo deciderebbe il bench `/2` sull'AMD, spec del profiler §8.2). Resta un costo del draw uber che non dipende dalla distribuzione delle depth, a 10 000 più alto che su AMD (+0.011): si attribuisce al `forward` perché fra `6ff494f` e `608a113` sul percorso di render cambia solo `forward-pass.ts`, non perché l'intervallo lo misuri (sull'M2 `forward` e `fxaa-tonemap` si sovrappongono).
- HEAD − passo 4: da −0.082 a +0.004 ms a 1 000 e 10 000, +0.11 a 100 000, dentro il rumore (quel +0.11 porta con sé la deriva: i due run di HEAD differiscono di 0.835 ms, quelli del passo 4 di 0.155).
- D3 sull'M2: a 100 000 i 22 pass del sort vanno in fila, senza sovrapporsi (timeline di 362 frame, `assets/2026-09-29-mac-m2/m8-diag-sort-timeline-100k.json`). La catena, dalla fine del cull all'ultimo scatter, dura in media 0.764 / 0.695 ms (tutte a 0 / distinte), al massimo 0.951 / 0.995 ms: nessun frame supera 1 ms, ma il margine è sottile (sopra 0.9 ms, cioè con meno del 10 % di margine, ci sono 42 frame su 181 con depth uguali e 12 con distinte, e il frame peggiore lascia lo 0.5 %). Soglia rispettata sul profilo a 22 pass; che sia un limite superiore del sort di produzione (un solo compute pass) è un'assunzione (spec del profiler, D5), non una misura.
