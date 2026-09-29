# Profiler GPU: `timestampWrites` sui pass veri (design)

Branch `test/mac-m2-gpu`, HEAD `930936c`, 2026-09-29, sessione dei test sul MacBook M2. Il design è stato approvato sezione per sezione nel brainstorming dello stesso giorno. Prove e workflow usati:

| Fonte | Contenuto |
|---|---|
| M7, `assets/2026-09-29-mac-m2/m7-timestamps-{gpu,stock}.json`, `m7-timestamp-probe-{gpu,stock}.json` | Il profiler di oggi non riporta nulla su Metal, con o senza flag. Su un query set nuovo un compute pass vuoto legge 0; i pass con lavoro ricevono stamp veri. Chrome senza flag quantizza a 65 536 ns. Sull'M2 i pass indipendenti si sovrappongono |
| Probe 2, `m7-probe2-stale-empty-gpu.json` | Un pass non campionato lascia lo stamp **precedente** dell'indice, non 0. Un render pass con solo il clear ha l'inizio nuovo e la fine vecchia. Draw e dispatch indiretti a conteggio 0 si campionano. Chrome accetta un descrittore creato con `Object.create`. Due pass sulla stessa coppia: vince l'ultimo |
| Probe 3, `m7-probe3-own-property-override-gpu.json` | `beginRenderPass`/`beginComputePass` sovrascritti come proprietà proprie di un encoder vero: funziona, niente errori, prototipo e altri encoder intatti, descrittore originale intatto |
| Probe 4, `m7-probe4-work-sampling-gpu.json` | Quali comandi fanno campionare un pass: la tabella della §2 |
| `wf_37fbd118-55f` | Valutazione pro e contro, meccanismo automatico o su adesione per i pass dei plugin: due analisti e un critico, che ha letto la spec WebGPU, la spec WebIDL e i sorgenti di Dawn |

Le decisioni della §0 sono dell'utente.

## 0. Decisioni (2026-09-29)

| # | Domanda | Scelta |
|---|---|---|
| D1 | Come ottenere timestamp su Metal (M7) | **`timestampWrites` di inizio e fine sui pass veri**, al posto dei marker vuoti |
| D2 | Meccanismo | **Intercettazione**: nei soli frame misurati il grafo sovrascrive `beginRenderPass`/`beginComputePass` sull'encoder del frame e aggiunge i `timestampWrites`. I 16 punti che aprono pass non cambiano |
| D3 | Pass dei plugin | **Misurati di default, con opt-out**: `profile: false` sul pass, oppure un `timestampWrites` suo |
| D4 | Cambi di API (sezione 1) | Contratto `RenderPass`: `stage?` al posto di `mark`, `profile?`, niente `profileStages`. `getGpuTimings()` e `PassTiming` invariati. Lo span del frame come valore separato; `totalAverageMs()` rimosso; il `total` del bench diventa lo span |
| D5 | Il sort misurato | **Resta diviso in 22 pass** quando è misurato, come oggi |
| D6 | Una coppia con lavoro non valida | **Si scarta il frame intero** |
| D7 | Nome dell'API dello span | **`getGpuFrameTiming(): GpuFrameTiming \| null`** |

## 1. Problema, obiettivo e perimetro

**Il problema.** `GpuProfiler` (`ts/src/render/gpu-profiler.ts`) mette tra i pass del grafo dei compute pass vuoti che portano un timestamp ciascuno, e misura un pass come differenza tra due marker. Su Metal un pass senza lavoro non viene campionato. Nel profiler i marker sono sempre vuoti, quindi nessuno scrive mai i loro indici: il query set resta a 0 dalla creazione, e `consume()` scarta ogni frame (`gpu-profiler.ts:309-313`). Dopo 120 frame l'avviso attribuisce la colpa al flag mancante, e su Mac sbaglia: il flag toglie solo la quantizzazione. Anche con stamp veri, sull'M2 "marker successivo meno marker precedente" non misurerebbe un pass, perché i pass indipendenti si sovrappongono (M7). M8 (bench della 5b) e M9 (costo della lighting) sono fermi per questo.

**Obiettivo.**
- Tempi GPU per pass, e per stage dove un pass li dichiara, che funzionano su Metal con Chrome, con e senza `--enable-webgpu-developer-features`, e su Vulkan e D3D12. Safari si verifica in M12.
- Più lo span del frame.
- Nomi invariati: il bench e il ciclo di M9 leggono le stesse chiavi.
- Costo zero quando il profiling è spento.

**Fuori perimetro:**
- Le particelle (`particle-system.ts`, 3 pass) e il probe di debug (`render/debug-probe.ts`, 1 pass) usano encoder propri, fuori dal grafo. Oggi non sono misurati e non lo saranno.
- Il costo del draw uber dentro `forward`. Opachi e trasparenti stanno in un solo render pass (`forward-pass.ts:341-383`), e nessun meccanismo con `timestampWrites` li separa. M8 confronta con AMD solo il totale del frame.
- Mode A. Il main thread non ha un renderer e `enableGpuProfiling()` resta `false`, come oggi.
- `timestamp-query-inside-passes`: la proposta è inattiva.

## 2. Cosa dicono le prove

Tutto su Apple M2 Pro, Chrome 154.0.8037.58, server "gpu" (con il flag) salvo dove indicato.

| Pass | Inizio | Fine | Fonte |
|---|---|---|---|
| compute senza dispatch (il marker di oggi) | vecchio | vecchio | probe 2 |
| compute con pipeline e bind group, senza dispatch | vecchio | vecchio | probe 4 |
| `dispatchWorkgroups(0)` diretto | vecchio | vecchio | probe 4 |
| render con solo il clear | nuovo | **vecchio** | probe 2 |
| render con solo `setPipeline` | nuovo | vecchio | probe 4 |
| render con `draw(3, 0)` diretto | nuovo | vecchio | probe 2 |
| render con `executeBundles` di un bundle vuoto | nuovo | vecchio | probe 4 |
| `drawIndexedIndirect` a 0 istanze | nuovo | nuovo (47-53 µs) | probe 2 |
| `dispatchWorkgroupsIndirect` a 0 gruppi | nuovo | nuovo (19-24 µs) | probe 2 |
| `draw(0)` diretto, `draw(3)` di un triangolo degenere o fuori schermo | nuovo | nuovo | probe 4 |
| `executeBundles` di un bundle con un draw | nuovo | nuovo | probe 4 |
| compute o render con lavoro | nuovo | nuovo | M7, probe 2-4 |

"Vecchio" vuol dire il valore che l'indice aveva dal submit precedente, identico al bit. Su un query set appena creato vale 0. Da qui gli zeri di M7: nel profiler di oggi nessun pass vero scrive mai gli indici dei marker. Uno stamp vecchio produce una durata credibile e falsa (25 µs nel probe 4) oppure negativa (−7,1 ms nel probe 2).

Altri fatti che il design usa:
- **Quantizzazione.** Senza flag Chrome restituisce multipli di 65 536 ns (M7): durate di 0 o 65,5 µs sui pass brevi. La media su 120 frame la compensa, come dice già il modulo oggi.
- **Sovrapposizione.** Nei cinque submit di M7 lo stesso render pass è durato 52,6 µs da solo e da 247 µs a 3,29 ms quando si sovrapponeva a un compute pesante codificato prima di lui. La somma delle durate non è il tempo del frame.
- **Valori assoluti tra submit.** In M7 i valori assoluti sono tornati indietro di circa 0,82 s tra due submit, mentre dentro un submit restano coerenti. Secondo il critico, Dawn ristima il periodo del timer su Metal con un filtro di Kalman e converte al resolve. Quindi confronti d'ordine e di span si fanno solo dentro un resolve.
- **Descrittori.** WebIDL legge i membri di un dizionario con [[Get]], che risale il prototipo (critico). Chrome accetta sia un `colorAttachments` ereditato sia un `timestampWrites` proprio (probe 2).
- **Capacità.** Un query set ha al massimo 4096 query (spec WebGPU).

## 3. Architettura

**Chi fa cosa:**
- `GpuProfiler` fa tutto il lavoro: intercettazione, allocazione delle coppie, derivazione dei descrittori, registrazione del lavoro, resolve, validità, aggregazione e span.
- `RenderGraph.render` fa solo qualche chiamata.
- I pass non sanno di essere misurati, tranne i due con stage (§5).

**Un frame misurato, in `RenderGraph.render`** (oggi `render-graph.ts:193-246`):

```ts
const encoder = device.createCommandEncoder();
const measuring = this.profiler?.beginFrame() ?? false;
if (measuring) this.profiler!.instrument(encoder);
const stage = measuring ? (s: string) => this.profiler!.enterStage(s) : undefined;
try {
  for (const name of this.executionOrder) {
    const pass = this.passes.get(name)!;
    if (measuring) this.profiler!.enterNode(name, pass.profile !== false);
    pass.execute(encoder, frame, resources, stage);
  }
} catch (err) {
  if (measuring) this.profiler!.abortFrame();
  throw err;
}
if (measuring) this.profiler!.endFrame(encoder);
device.queue.submit([encoder.finish()]);
if (measuring) void this.profiler!.poll();
```

Un frame non misurato non chiama nessuno di questi metodi: encoder nativo, `stage` indefinito e costo zero, come oggi (`render-graph.ts:222-229`). Misurare non aggiunge pass, mentre oggi ne aggiunge N+1 vuoti. L'eccezione è il sort (D5, §5).

## 4. Intercettazione e descrittore

### 4.1 `instrument(encoder)`

Salva `encoder.beginRenderPass` e `encoder.beginComputePass` (i metodi del prototipo) e mette sull'istanza due **proprietà proprie** con lo stesso nome. Ciascuna deriva il descrittore (§4.2), chiama il metodo nativo con `call(encoder, …)` e avvolge il pass encoder che riceve (§4.4). L'encoder vive un frame solo e finisce con `finish()`, quindi non c'è niente da ripristinare.

Proprietà proprie e non il prototipo: il prototipo toccherebbe ogni encoder della pagina, compresi quelli delle particelle e del probe. Nel probe 3 un secondo encoder conserva il metodo del prototipo. Proprietà proprie e non un `Proxy`: l'oggetto resta nativo, e non c'è nessun controllo di brand da ingannare.

`resolveQuerySet` e `copyBufferToBuffer` non vengono toccati: `endFrame` li chiama sull'encoder come oggi.

### 4.2 Derivazione del descrittore

- **Nome corrente nullo** (nodo con `profile: false`, §4.3): il descrittore passa invariato, e il pass non è misurato.
- **Descrittore con un suo `timestampWrites`** (qualunque valore diverso da `undefined`): passa invariato e il pass non è misurato. Il pass misura sé stesso, e le sue query non si toccano.
- **Capacità esaurita** (§4.5): passa invariato e il frame è segnato troncato.
- **Altrimenti** prende la coppia successiva `k`, con gli indici `2k` e `2k+1`, e registra `{ nome: il nome corrente, lavoro: false }`. Poi passa al metodo nativo:

```ts
Object.create(desc ?? {}, {
  timestampWrites: {
    value: { querySet, beginningOfPassWriteIndex: 2 * k, endOfPassWriteIndex: 2 * k + 1 },
    enumerable: true,
  },
});
```

Il descrittore originale non viene mai scritto (probe 3), e i suoi membri si leggono per ereditarietà. `beginComputePass()` senza argomenti riceve un descrittore con il solo `timestampWrites`.

### 4.3 `enterNode(nome, misurato)` ed `enterStage(stage)`

`enterNode` imposta il nome corrente al nome del nodo, oppure a nullo se `misurato` è falso, e azzera lo stage. `enterStage` vale solo dentro un nodo misurato e imposta il nome corrente a `nodo/stage`. Le regole sui nomi sono nella §5.

### 4.4 Il lavoro del pass

Il pass encoder che il metodo nativo restituisce riceve a sua volta proprietà proprie per i comandi di lavoro. Ognuna segna `lavoro: true` sulla coppia del pass quando il comando rispetta la regola, poi chiama il metodo nativo:

| Comando | Conta come lavoro se |
|---|---|
| `draw(v, i = 1)` | `v > 0` e `i > 0` |
| `drawIndexed(c, i = 1)` | `c > 0` e `i > 0` |
| `drawIndirect`, `drawIndexedIndirect` | sempre (si campionano anche a 0, probe 2) |
| `dispatchWorkgroups(x, y = 1, z = 1)` | `x`, `y` e `z` > 0 |
| `dispatchWorkgroupsIndirect` | sempre (probe 2) |
| `executeBundles(bundles)` | almeno un bundle. Il contenuto non si vede: un bundle vuoto lascia la fine vecchia, e i controlli della §6 lo prendono |

La regola sbaglia solo da un lato. `draw(0)` si campiona (probe 4) ma non fa nulla, e contarlo come "senza lavoro" non costa niente. `executeBundles` viene prima convertito in array, perché un iterabile generico si consuma una volta sola.

**Nel motore di oggi ogni pass che si apre ha lavoro.** Cull, scatter e overlay escono prima di aprire il pass quando non hanno niente da fare (`cull-pass.ts:238`, `scatter-pass.ts:188`, `debug-line-pass.ts:158`). Tutti gli altri pass del grafo contengono un draw a schermo intero oppure un draw o un dispatch indiretto. La regola serve per i plugin e per i pass futuri.

### 4.5 Capacità

- Un query set di **1024 query** (512 coppie, 8 KB), creato con il profiler da `enableGpuProfiling()` e mai ingrandito. Il costruttore diventa `new GpuProfiler(device, maxPairs = 512)`.
- Il caso peggiore stimato sta intorno alle 300 coppie:
  - sort 22;
  - per ogni set SDF: seed 1, catena circa 13 alla mezza risoluzione di 1080p, accumulo 1 per gruppo, con fino a 16 set;
  - JFA circa 12 più seed e composito;
  - bloom 6, poi i pass della scena e gli overlay.
- Un frame che supera la capacità smette di iniettare, si scarta intero con motivo "troncato", e al primo caso compare un avviso con il nome del parametro.

### 4.6 Chiusura

`endFrame(encoder)` risolve le `2n` query usate nel resolve buffer e le copia in uno dei 3 buffer di readback a rotazione, come oggi. Il frame in attesa porta le coppie (nome e lavoro), `n` e la generazione. `abortFrame()` resta com'è: un pass che lancia fa abbandonare l'encoder senza submit, quindi la GPU non scrive niente.

## 5. Nomi e stage

- **Di default vale il nome del nodo** per tutti i pass che il nodo apre. Per esempio i 6 sotto-pass del bloom si sommano sotto `bloom`, come oggi.
- **Stage.** Il quarto argomento di `execute` diventa `stage?: (nome: string) => void` ed esiste solo nei frame misurati. Dopo `stage('seed')` i pass del nodo si chiamano `nodo/seed`, fino al prossimo `stage()` o al nodo successivo. Un pass aperto prima del primo `stage()` prende il nome del nodo.
- **I nomi ripetuti in un frame si sommano**, come oggi (`gpu-profiler.ts:316-324`).
- **`profileStages` sparisce.** Oggi un pass con stage deve elencarli in anticipo, e un elenco che non corrisponde alle chiamate di `mark` fa scartare il frame (`gpu-profiler.ts:239-242`). Con i nomi attaccati ai pass nel momento in cui si aprono, non c'è più niente da allineare.
- **Qualunque pass può chiamare `stage`**, anche quelli dei plugin.
- **`LightGroupsPass`** (`light-groups-pass.ts:108-128`): le quattro chiamate `mark?.(encoder)` diventano `stage?.('seed')`, `stage?.('sdf')`, `stage?.('accum')` e, per i gruppi senza set, `stage?.('accum')`, negli stessi punti. Le chiavi `light-groups/seed|sdf|accum`, che M9 legge, restano identiche. Ognuna è ora la somma dei pass dello stage: seed 1 per set, catena SDF circa 13 per set, accumulo 1 per gruppo.
- **`TransparentSortPass`** (`transparent-sort-pass.ts:291-332`) capisce di essere misurato da `stage !== undefined` (D5). In quel caso si divide in 22 compute pass come oggi, e chiama `stage('gather')` e poi `stage('upsweep' | 'scan' | 'scatter')` prima di ciascuno. Le chiavi del bench (`transparent-sort/{gather,upsweep,scan,scatter}`) restano identiche. Le copie della readback di dev tra gather e upsweep non sono pass e non cambiano. Da non misurato resta un solo pass, due con una readback.
- **Effetto della misura.** Misurato, il sort ha 22 confini di pass invece di uno. È una scelta dell'utente: dà gli stage e permette di confrontare M8 voce per voce con le misure AMD della 5b. Lo span del frame mostra l'effetto complessivo.

## 6. Validità e aggregazione

### 6.1 Coppie senza lavoro

Si ignorano. Il loro pass non ha fatto niente, quindi contribuiscono 0 ms al loro nome, e il nome compare nel frame.

### 6.2 Coppie con lavoro

Una coppia con lavoro è valida solo se passa quattro controlli, tutti su valori dello stesso resolve:

| # | Controllo | Motivo dello scarto |
|---|---|---|
| 1 | inizio ≠ 0 e fine ≠ 0 | `zero`: query mai scritta, per esempio un browser che non serve timestamp |
| 2 | fine ≥ inizio | `reversed` |
| 3 | inizio ≠ l'ultimo valore letto per l'indice `2k` | `stale` |
| 4 | fine ≠ l'ultimo valore letto per l'indice `2k+1` | `stale` |

I controlli 3 e 4 sono una rete di sicurezza per comportamenti non visti: un'altra versione di Dawn, Safari, un bundle vuoto. Non possono scartare una coppia buona, perché due stamp veri dello stesso indice distano almeno un frame. Possono invece lasciar passare uno stamp vecchio se il periodo ristimato ha cambiato la conversione tra due resolve: per questo sono solo una rete, e la difesa vera è la regola del lavoro.

### 6.3 La storia per indice

Il profiler conserva, per ogni indice, l'ultimo valore letto. La aggiorna con **ogni** frame letto, anche quando lo scarta, per qualunque motivo, generazione compresa, e la aggiorna nell'ordine dei submit (`poll()` consuma già in ordine). Tre casi:
- se un readback non si riesce a leggere, i suoi indici diventano "sconosciuti", e per quegli indici i controlli 3-4 saltano un frame;
- `reset()` segna tutta la storia sconosciuta;
- i frame saltati (nessun buffer libero) e quelli abortiti non scrivono query, e la storia resta esatta.

### 6.4 Il frame

**Un frame conta solo se tutte le sue coppie con lavoro sono valide (D6).** Si scarta intero se una coppia non lo è, se il frame è troncato, o se non ha nessuna coppia con lavoro (motivo `empty`). Così restano vere le proprietà che `getGpuTimings()` promette oggi: ogni voce ha lo stesso `sampleCount`, un nome assente in un frame vale 0 ms in quel frame, e ogni media è per frame.

### 6.5 Aggregazione e span

- **Per nome**: la somma delle durate `(fine − inizio)` delle sue coppie valide, oppure 0 se il nome ha solo coppie senza lavoro. Finestra di 120 frame (`WINDOW`), `lastMs` e `sampleCount` come oggi. Un nome visto la prima volta vale 0 nei frame precedenti della finestra, e un nome assente per una finestra intera viene dimenticato (`gpu-profiler.ts:326-348`).
- **Span del frame**: la fine massima meno l'inizio minimo sulle coppie valide con lavoro, dentro un solo resolve. Ha una sua serie sugli stessi frame.
- **Sovrapposizione**: sull'M2 le somme per nome possono superare lo span. Lo dicono il JSDoc di `getGpuTimings()` e quello di `getGpuFrameTiming()`.

### 6.6 Diagnostica

- **Contatori:**
  - `discardedFrames`, il totale che esiste già;
  - i frame scartati per motivo: `zero`, `stale`, `reversed`, `truncated`, `empty`;
  - `skippedFrames`, invariato.
- **Un solo avviso**, dopo 120 frame scartati di fila, con il motivo più frequente e il nome del pass colpevole. Per esempio: "pass 'overlay/x' did work but its end timestamp was not refreshed".
- L'avviso di oggi su `--enable-webgpu-developer-features` (`gpu-profiler.ts:370-386`) sparisce. Il commento del modulo spiega invece la quantizzazione a 65,5 µs di Chrome su Metal senza flag, da citare con `averageMs`.

## 7. API e consumatori

### 7.1 Pubbliche

| API | Cambio |
|---|---|
| `Hyperion.getGpuFrameTiming(): GpuFrameTiming \| null` | **nuova**. Lo span del frame, sugli stessi frame e con la stessa finestra di `getGpuTimings()`. `null` quando il profiling è spento, non supportato, o prima del primo frame valido |
| `type GpuFrameTiming = { averageMs: number; lastMs: number; sampleCount: number }` | **nuovo**, esportato da `index.ts` accanto a `PassTiming` (`index.ts:38`) |
| `Hyperion.getGpuTimings()`, `PassTiming`, `enableGpuProfiling()`, `disableGpuProfiling()`, `gpuProfilingSupported` | invariati. Si aggiorna il JSDoc (`hyperion.ts:674-704`): la quantizzazione non è "100 µs di default" ma dipende da piattaforma e flag, e le somme possono superare lo span |

Lo span è un valore separato, e non una voce in più di `getGpuTimings()`, per non farlo contare due volte a chi somma le voci.

### 7.2 Interne

| API | Cambio |
|---|---|
| `RenderPass.execute(encoder, frame, resources, stage?)` | il quarto argomento passa da `mark?: (encoder) => void` a `stage?: (nome: string) => void`. Un pass che dichiara tre parametri resta compatibile |
| `RenderPass.profile?: boolean` | **nuovo**: `false` esclude il pass dalla misura |
| `RenderPass.profileStages` | **rimosso** |
| `Renderer.getGpuFrameTiming()` | **nuovo** (`renderer.ts:172-190`), `null` a profiling spento come `getGpuTimings()` (`renderer.ts:1139-1143`) |
| `GpuProfiler` | `beginFrame()` senza nomi, `instrument`, `enterNode`, `enterStage`, `frameTiming()`, i contatori per motivo; il costruttore prende `maxPairs`; `mark` e `totalAverageMs()` rimossi |

### 7.3 Bench

`docs/plans/assets/2026-09-27-transparent-sort-bench.js`:
- `total` diventa `engine.getGpuFrameTiming()?.averageMs`;
- nuovo campo `passSum`, la somma delle voci, per continuità con le misure AMD (`bench.js:131`, dove oggi è `total`);
- il commento in testa (`bench.js:12-18`) spiega il cambio: con i marker il bracket di un pass conteneva anche il lavoro che lo precedeva, con le coppie no.

L'attesa della finestra (`forwardSamples() >= WINDOW`) e le chiavi degli stage non cambiano.

### 7.4 Documentazione

- **`gpu-profiler.ts`**: il commento del modulo, che oggi spiega i marker, e il JSDoc delle API.
- **`CLAUDE.md`**:
  - le righe di `render/gpu-profiler.ts`, `render/render-pass.ts`, `render/render-graph.ts`, `render/passes/transparent-sort-pass.ts` ("22 with the profiler") e `render/passes/light-groups-pass.ts`;
  - il gotcha "A graph pass can time its own stages", da riscrivere per `stage`;
  - il gotcha "`timestamp-query` on a stock Chrome is platform-dependent": su Metal gli zeri venivano dai marker vuoti, e Chrome senza flag quantizza a 65,5 µs;
  - la riga di `hyperion.ts`, che guadagna `getGpuFrameTiming`.
- **README delle prove Mac**: la sezione M7 con l'esito del profiler nuovo.

## 8. Test e verifica

### 8.1 Headless (vitest, test-first)

- **`gpu-profiler.test.ts`**, riscritto su device, encoder e pass encoder finti:
  - **intercettazione**:
    - proprietà proprie solo sull'encoder del frame;
    - il prototipo e un altro encoder restano intatti;
    - nessuna intercettazione nei frame non misurati;
  - **derivazione del descrittore**:
    - coppie consecutive;
    - l'originale non viene scritto, e i membri ereditati restano leggibili;
    - un `timestampWrites` proprio passa intatto e il pass non è misurato;
    - un compute senza descrittore ne riceve uno;
  - **nomi e stage**:
    - il nodo, `nodo/stage`, un pass prima del primo `stage()`;
    - l'opt-out con `profile: false`;
  - **lavoro**: ogni riga della tabella della §4.4, compresi `draw(0)`, `draw(3, 0)`, un bundle vuoto e un iterabile di bundle;
  - **capacità**: frame troncato, scartato e contato, con l'avviso una volta sola;
  - **validità**:
    - i quattro controlli, ciascuno con il suo motivo;
    - una coppia senza lavoro e con stamp vecchi non fa scartare il frame;
    - una coppia con lavoro e fine vecchia sì;
  - **storia**:
    - aggiornata anche dai frame scartati e da quelli di una generazione vecchia;
    - un readback perso rende sconosciuti i suoi indici;
    - `reset()`;
  - **aggregazione**:
    - le somme per nome;
    - i nomi assenti a 0 e lo stesso `sampleCount` per tutte le voci;
    - un nome dimenticato dopo una finestra;
    - lo span con coppie sovrapposte, minore della somma;
  - **avviso** dopo 120 frame scartati di fila, con motivo e pass;
  - **ciclo di vita**: `abortFrame`, `destroy`.
- **`render-graph.test.ts`**:
  - in un frame misurato, `instrument` una volta, `enterNode` per ogni nodo con il flag di `profile`, e `stage` passato a ogni pass;
  - in un frame non misurato nessuna chiamata e `stage` indefinito;
  - un pass che lancia porta ad `abortFrame`.
- **`transparent-sort-pass.test.ts`**: 22 compute pass se e solo se `stage` è presente, con la sequenza `gather` e poi `upsweep`, `scan`, `scatter` sette volte. Sostituisce il test del contratto di `mark` (`transparent-sort-pass.test.ts:435-446`).
- **`light-groups-pass.test.ts`**: `seed`, `sdf` e `accum` per set, più `accum` per i gruppi senza set. Sostituisce `light-groups-pass.test.ts:193-200`.
- **`renderer` e `hyperion`**: `getGpuFrameTiming()` arriva fino alla facade, e vale `null` a profiling spento o senza renderer.

### 8.2 GPU (M7 rifatto, sull'M2)

- **Server "gpu" e server "stock"**, `?mode=B`, `enableGpuProfiling()`:
  - sulla tab Lighting e sulla scena del bench, le voci non sono vuote e sono plausibili, e lo span c'è;
  - `discardedFrames` resta circa 0 dopo il riscaldamento;
  - sullo stock i valori sono multipli di 65,5 µs, e le medie sono stabili su 120 frame.
- **Overlay**: il visualizzatore dei bounds (F2) viene misurato da solo, e un pass con `profile: false` resta fuori.
- **Mode C**: lo stesso controllo, con i frame di scatter.
- **Safari (M12)**: l'override come proprietà propria, i membri ereditati e i timestamp. Se Safari rifiuta i membri ereditati, il ripiego è la copia `{ ...desc, timestampWrites }`: equivalente per i nostri descrittori, che sono letterali.
- **Linux (Vulkan)**, al ritorno sulla macchina Fedora: gli stessi controlli.

## 9. Ordine di implementazione

1. `GpuProfiler`: intercettazione, derivazione del descrittore, lavoro e nomi (test prima).
2. `GpuProfiler`: validità, storia, aggregazione, span e diagnostica (test prima).
3. `RenderGraph` e contratto `RenderPass`: `stage`, `profile`, niente `profileStages` (test prima).
4. `LightGroupsPass` e `TransparentSortPass` passano a `stage` (test prima).
5. `renderer.ts`, `hyperion.ts`, `index.ts`: `getGpuFrameTiming` (test prima).
6. Il bench.
7. Documentazione (§7.4).
8. `scripts/preflight.sh`, la review avversaria del range, `webgpu-pass-reviewer`.
9. La verifica sulla GPU (§8.2), poi M8 e M9 (§11).

## 10. Rischi

| Rischio | Effetto | Difesa |
|---|---|---|
| Safari tratta diversamente override o membri ereditati | pass con descrittori sbagliati, frame invalidi | M12 prima di fidarsi dei numeri su Safari; ripiego della §8.2 |
| Una versione futura di Dawn cambia quando un pass si campiona | stamp vecchi su pass con lavoro | i controlli 3-4, lo scarto del frame, l'avviso con il nome del pass |
| Un plugin esegue ogni frame un bundle vuoto | il profiler non misura più nulla | l'avviso nomina il pass; `profile: false` lo esclude |
| Più di 512 coppie in un frame | frame troncati | contatore, avviso, parametro `maxPairs` |
| Somme lette come tempo del frame | conclusioni sbagliate su GPU che sovrappongono i pass | lo span separato; JSDoc; il `total` del bench è lo span |
| Il sort misurato ha 22 pass | i tempi del sort sono un po' più alti di quelli di produzione | scelta esplicita (D5), documentata |
| Un pass apre pass su un encoder suo, o chiama il metodo del prototipo direttamente | quel pass non viene misurato | come le particelle: fuori perimetro, documentato |
| Il costo in JS dell'intercettazione | qualche chiusura per pass, solo nei frame misurati | nessuna nei frame non misurati |

## 11. Dopo: M8 e M9

- **La patch sui commit di riferimento.** `render-graph.ts`, `gpu-profiler.ts`, `render-pass.ts`, `light-groups-pass.ts`, `transparent-sort-pass.ts` e i loro test sono identici a `6ff494f` (passo 3) e a `608a113` (passo 4), mentre `renderer.ts` differisce di 5 righe e `hyperion.ts` e `index.ts` sono identici. I commit del profiler si portano con `cherry-pick` sui worktree dei due commit, per i run del bench della handoff (M8).
- **Condizioni:** alimentatore collegato, con i watt annotati, e `caffeinate` per tutta la durata. La handoff chiede i timing solo così.
- **Confronto con AMD:** solo sul totale del frame, cioè lo span sul Mac contro il `total` dei marker su AMD. Sui marker AMD il costo del draw uber cadeva nel bracket di `fxaa-tonemap` (`bench.js:15-18`); con le coppie cade in `forward`. Le voci per pass non sono confrontabili una a una.
- **M9:** il ciclo della handoff legge `light-groups/seed|sdf|accum`, chiavi invariate. Sono somme di pass, non bracket.
