# Roadmap Operativa Unificata â€” Hyperion Engine v3.0

> **Data**: 18 Febbraio 2026 | **Scope**: Phase 4.5 â†’ Phase 7 | **Vision**: Motore grafico universale per tecnologie web  
> **Origine**: Fusione della Roadmap Operativa v2.1 con l'Addendum Rendering Integration (basato su *Rendering Algorithms for the Hyperion Engine: WebGPU Graphics Pipeline and Roadmap Analysis*)

---

## 0. Premessa: Vision e Vincoli Architetturali

Hyperion non Ã¨ "un altro game engine web". L'obiettivo Ã¨ costruire un **motore grafico universale** per le tecnologie web che possa servire tre mercati distinti:

1. **Game engine**: sviluppo di giochi 2D/2.5D con target 100k+ entitÃ  a 60fps
2. **Application rendering**: motore di rendering per applicazioni professionali tipo Figma, Miro, Excalidraw â€” dove il canvas contiene migliaia di elementi interattivi con zoom/pan fluido
3. **Desktop embedding**: motore integrato in applicazioni Electron/Tauri per rendering 2D/3D avanzato che supera i limiti di Canvas 2D e SVG

Questa vision impone vincoli architetturali specifici che guidano ogni decisione della roadmap:

| Vincolo | Motivazione | Impatto sulle decisioni |
|---------|------------|------------------------|
| **Zero dipendenze runtime TS** | L'engine Ã¨ una primitiva â€” chi lo integra non vuole transitive deps | Nessuna libreria TS aggiuntiva, tutto internal |
| **Binary WASM < 200KB gzipped** | Tempo di download su 3G: 200KB â‰ˆ 65ms. Ogni KB conta per il first paint | hecs su bevy_ecs, niente wgpu compilato |
| **Nessun GC pressure nel game loop** | Applicazioni professionali girano per ore â€” GC pauses causano micro-jank visibili | Object pooling, pre-allocated buffers, zero allocazioni nel hot path |
| **Graceful degradation obbligatoria** | Un'app Figma-like non puÃ² crashare se il Worker muore | Supervisor, heartbeat, degradazione Aâ†’Bâ†’C |
| **API ergonomica e type-safe** | Gli sviluppatori consumer non vogliono manipolare ring buffer | Facade API che nasconde il protocollo binario |
| **Embeddabile** | L'engine deve funzionare in un `<div>` qualsiasi, non possedere l'intera pagina | Nessun global state, canvas injection, lifecycle esplicito |
| **Estensibile via plugin** | Terze parti devono poter estendere rendering, logica e input senza ricompilare WASM | Modello a due livelli: Rust chiuso (core), TS aperto (plugin). Predisposizioni a costo zero in Phase 4.5/5 |

---

## 0.1 Analisi Architetturale: Cinque Tensioni Strutturali

L'architettura attuale Ã¨ solida nelle fondamenta: ring buffer SPSC, degradazione Aâ†’Bâ†’C, separazione Rust/TS, fixed timestep. Ma la vision "motore universale" espone cinque tensioni strutturali che, se non affrontate ora, diventano debito tecnico irreversibile una volta stabilizzata l'API pubblica.

Il principio guida Ã¨: **aggiungere indirezioni a costo zero oggi per non precludere percorsi ad alto valore domani.**

### Tensione 1: Il vincolo "una entitÃ  = un quad" Ã¨ hardcoded

L'architettura attuale assume implicitamente che ogni entitÃ  Ã¨ un quad 2D instanziato. Questa assunzione Ã¨ pervasiva:

- Il vertex buffer Ã¨ un unit quad immutabile creato all'init
- Lo shader `basic.wgsl` ha vertici quad hardcoded
- Il buffer GPU ha 20 f32/entity (model matrix + bounding sphere) senza riferimento a quale geometria usare
- Il compute culling usa una bounding sphere per entitÃ , non per mesh

Per un game engine 2D o un canvas tipo Figma, questo funziona. Ma la vision include "rendering 2D/3D avanzato" e "applicazioni Electron/Tauri". Scenari concreti che si rompono:

| Scenario | PerchÃ© fallisce con l'architettura attuale |
|----------|-------------------------------------------|
| App CAD 2D con linee, archi, poligoni | Non sono quad â€” servono primitive vettoriali |
| Visualizzatore dati 3D in Tauri | Mesh 3D arbitrarie, non solo quad |
| Editor di mappe tile-based con decorazioni 3D | Mix di quad 2D e mesh 3D nella stessa scena |
| Dashboard con grafici, testo, e icone | Testo SDF, linee, aree filled â€” nessuno Ã¨ un quad |

**Intervento (Phase 4.5 + Phase 5.5)**: Aggiungere due componenti ECS â€” `MeshHandle(u32)` e `RenderPrimitive(u8)` â€” che oggi hanno un solo valore (`Quad = 0`) ma creano l'indirezione necessaria. Phase 5.5 implementa concretamente 5 primitive (Text, Lines, Gradients, Shadows, Outlines). Costo iniziale: 5 byte per entitÃ  nel buffer GPU. Beneficio: il renderer puÃ² raggruppare per mesh type e primitive type senza riscrittura.

### Tensione 2: Il renderer Ã¨ monolitico

`renderer.ts` gestisce: creazione pipeline, gestione buffer, compute culling, render pass, resize, bind group rebuild. Per due pass (cull + render) Ã¨ gestibile. Ma la vision richiede pass aggiuntivi:

```
Oggi:       [Compute Cull] â†’ [Forward Render]
App Figma:  [Compute Cull] â†’ [Forward Render] â†’ [Selection Seed] â†’ [JFA Ã—10] â†’ [Outline Composite] â†’ [FXAA] â†’ [UI]
Game:       [Compute Cull] â†’ [Shadow Map] â†’ [Forward Render] â†’ [Bloom Extract â†’ Blur] â†’ [Tonemap + FXAA] â†’ [UI]
```

Senza un'astrazione di render pass come **DAG leggero**, ogni nuovo pass richiede di modificare il monolite â€” con rischio crescente di regressioni e accoppiamento tra pass indipendenti.

**Intervento (Phase 4.5)**: Refactoring di `renderer.ts` in pass modulari con interfaccia `RenderPass` comune, orchestrati da un **RenderGraph DAG con resource lifetime management e dead-pass culling**. Il render graph compila l'ordine di esecuzione tramite topological sort sulle dipendenze reads/writes.

### Tensione 3: Mancano le primitive di rendering per applicazioni professionali

Per scenari tipo Figma, servono primitive che non esistono:

| Primitiva | Uso tipico | Tecnica di rendering |
|-----------|-----------|---------------------|
| **Linee** (con spessore, dash, cap/join) | Connettori, bordi, grafi | Instanced screen-space expansion |
| **Testo** (glyph rendering) | Label, tooltip, UI text | MSDF atlas + instanced quads |
| **Curve di BÃ©zier** | Path di design, SVG import | Tessellazione o analytical rendering |
| **Gradienti** (lineari, radiali) | Sfondi, fill di forme | 1D LUT texture + fragment shader |
| **Ombre** (drop shadow, box shadow) | Elevazione UI, card design | SDF box shadow O(1) (Evan Wallace) |
| **Mask e clip path** | Compositing, viewport clipping | Stencil buffer o alpha mask |
| **Outlines di selezione** | Selezione in canvas editor | Jump Flood Algorithm (JFA) |

**Intervento (Phase 4.5 predisposizione + Phase 5.5 implementazione)**: Il componente `RenderPrimitive(u8)` Ã¨ il punto di estensione. L'enum Ã¨ progettato per crescere:

```rust
#[repr(u8)]
pub enum RenderPrimitiveType {
    Quad = 0,           // Phase 4 (attuale)
    Line = 1,           // Phase 5.5: linee con spessore
    SDFGlyph = 2,       // Phase 5.5: testo MSDF
    BezierPath = 3,     // Futuro: curve vettoriali (Loop-Blinn)
    Gradient = 4,       // Phase 5.5: fill gradiente
    BoxShadow = 5,      // Phase 5.5: ombre SDF
    // Futuro:
    // Mesh3D = 6,       // Phase 7+ â€” mesh 3D arbitrarie
    // Particle = 7,     // Phase 7+ â€” GPU particles
}
```

Il ForwardPass usa pipeline separate per tipo di primitiva â€” zero branching nello shader, massima performance GPU. Il CullPass (stream compaction) produce indici giÃ  raggruppati per tipo come byproduct naturale.

### Tensione 4: Il modello di memoria non regge sessioni long-running

Un gioco ha sessioni di 30-120 minuti. Un'app tipo Figma gira per ore, a volte giorni (tab aperto, sospeso, risvegliato). Profilo di memoria a confronto:

```
Gioco (2 ore):
  EntitÃ : picco 100k, stabile dopo il loading
  Texture: caricate all'init, mai rilasciate
  WASM memory: cresce durante il loading, poi stabile
  Spawn/despawn: burst occasionali (esplosioni, particelle)

App professionale (8+ ore):
  EntitÃ : fluttua tra 100 e 50k (apertura/chiusura documenti)
  Texture: caricate e rilasciate continuamente (cambio file, undo/redo)
  WASM memory: cresce e non torna mai indietro (memory.grow unidirezionale)
  Spawn/despawn: milioni cumulativi (ogni operazione utente)
```

Problemi specifici:

| Problema | Causa | Impatto dopo 8 ore |
|----------|-------|-------------------|
| EntityMap fragmentation | Free-list LIFO + Vec che non si compatta | Vec con 50k slot ma solo 5k usati |
| WASM memory bloat | `memory.grow` Ã¨ unidirezionale | 50MB allocati, 10MB in uso effettivo |
| GPU tier memory leak | Tier allocati lazy ma mai shrinkati | 256 layer allocati, 3 in uso |
| RenderState Vec growth | `Vec<f32>` mantiene peak capacity dopo `clear()` | Buffer da 100k entitÃ  per una scena da 1k |

**Intervento (Phase 4.5 design + Phase 5 implementazione)**: API esplicita di compaction e memory hints:

```typescript
engine.compact();           // Compatta EntityMap, shrinke tier inutilizzati
engine.memoryHint('low');   // Suggerisce all'engine di minimizzare il footprint
```

In Rust, aggiungere `EntityMap::compact()` che ricostruisce il Vec eliminando i buchi, e `RenderState::shrink_to_fit()` che rilascia la capacity eccedente.

### Tensione 5: L'assenza di scene graph preclude applicazioni gerarchiche

In un'app Figma-like, le entitÃ  hanno **relazioni gerarchiche**: un frame contiene gruppi che contengono forme. Muovere il frame muove tutto il contenuto. Nell'architettura attuale ogni entitÃ  ha una model matrix indipendente â€” non c'Ã¨ concetto di parent-child.

Implementare un scene graph completo nell'ECS Ã¨ possibile ma costoso: la propagazione delle trasformazioni Ã¨ un tree traversal che rompe la cache locality dell'iterazione ECS lineare.

**Intervento (Phase 4.5 design + Phase 5 implementazione)**: Scene graph **opt-in**, non strutturale:

```
EntitÃ  flat (default):     Entity â†’ ModelMatrix (calcolata da Position/Rotation/Scale)
                           Zero overhead, cache-friendly, perfetto per giochi

EntitÃ  gerarchica (opt-in): Entity â†’ Parent(EntityId) + LocalTransform
                            â†’ propagate_transforms() calcola ModelMatrix globale
                            Costo: proporzionale alla profonditÃ , non al totale entitÃ 
```

Chi non usa la gerarchia non paga nulla. Chi la usa, attiva un `TransformHierarchy` che aggiunge i componenti `Parent`, `Children`, e `LocalTransform` e un sistema di propagazione.

### Riepilogo Interventi Architetturali

| Intervento | Fase | Costo Implementativo | Costo se Rimandato |
|-----------|------|---------------------|-------------------|
| MeshHandle + RenderPrimitive components | Phase 4.5 | Basso (2 componenti ECS + 5 byte/entity GPU) | Alto (riscrittura renderer + shader + buffer layout) |
| Renderer modulare con RenderGraph DAG | Phase 4.5 | Medio (refactor 1 file in 4-5 file + topological sort) | Molto alto (ogni nuovo pass aumenta la complessitÃ  quadraticamente) |
| SoA buffer layout per entity data GPU | Phase 4.5 | Medio (refactoring shader + buffer management) | Critico (re-layout dell'intero buffer GPU Ã¨ breaking change) |
| Prefix sum (Blelloch) + stream compaction | Phase 4.5 | Medio (nuovo compute shader, riutilizzabile) | Alto (fondamento per tutto il GPU-driven rendering) |
| Scene graph opt-in design | Phase 4.5 (design), Phase 5 (impl) | Basso (design), Medio (implementazione) | Critico (breaking change API se aggiunto dopo) |
| Memory compaction API | Phase 5 | Basso (compact + shrink_to_fit) | Medio (utenti long-running sperimentano degradazione) |
| Rendering Primitives (Text, Lines, Gradients, Shadows, Outlines, FXAA) | Phase 5.5 | Alto (5-6 settimane) | Critico (senza primitive, l'engine produce solo quad con texture) |
| Plugin system predispositions (range enum, addPass/removePass, hooks, config) | Phase 4.5/5 (predisposizione), Phase 7 (impl) | Basso (solo indirezioni e range riservati) | Critico (breaking change su API pubblica + RenderGraph + ring buffer) |

---

## 1. Phase 4.5 â€” Stabilizzazione, Risoluzione CriticitÃ  e Fondamenta Rendering

**Durata stimata**: 4â€“5 settimane  
**Prerequisito per**: Phase 5 (API & Lifecycle), Phase 5.5 (Rendering Primitives)  
**CriticitÃ  risolte**: ARCH-01, RING-01, RING-02, ASSET-01 (parziale), REND-01 (parziale), REND-04, REND-05, REND-06  
**Interventi architetturali**: SoA buffer layout, MeshHandle + RenderPrimitive, RenderGraph DAG, Prefix sum, Indirect draw single buffer, Scene graph design

Questa fase intermedia risolve le criticitÃ  bloccanti identificate nella review e stabilisce le fondamenta rendering informate dalla ricerca sugli algoritmi grafici, prima di esporre un'API pubblica. Costruire un'API consumer sopra fondamenta instabili Ã¨ un errore irreversibile: ogni bug strutturale diventa un breaking change.

---

### 1.1 Worker Supervisor e Recovery [ARCH-01]

#### Il Problema in Dettaglio

In Mode A, tre thread indipendenti cooperano: Main Thread (UI/Input), Worker 1 (ECS/WASM), Worker 2 (Render/WebGPU). Nessuno di questi thread ha garanzia di sopravvivenza nel contesto browser:

- **Out-of-Memory**: Un Worker che supera il memory budget del browser viene terminato senza preavviso. Su Chrome mobile, il budget per Worker Ã¨ significativamente inferiore a desktop (spesso 256MBâ€“512MB)
- **Eccezioni non catturate**: Un panic in WASM si propaga come eccezione JS non catturata nel Worker. Se non c'Ã¨ un `try/catch` globale, il Worker muore
- **Tab throttling**: Chrome riduce aggressivamente i timer dei tab in background. Un Worker con `setTimeout`/`setInterval` puÃ² sembrare morto anche se Ã¨ solo rallentato
- **`device.lost` WebGPU**: La GPU puÃ² essere reclamata dal sistema operativo (switch utente, driver crash, power saving). Il Worker 2 perde il device senza recovery automatico

Lo stato attuale: nessun meccanismo rileva questi fallimenti. L'applicazione si congela o mostra un canvas nero senza feedback.

#### Soluzione: Heartbeat Atomico + Error Handler

##### Opzione A: Heartbeat su SharedArrayBuffer (Raccomandata)

Il Worker incrementa un contatore atomico sul SAB ad ogni tick completato. Il Main Thread legge il contatore ogni N frame e verifica che sia avanzato.

```
SharedArrayBuffer Layout (esteso):
Offset 0-15:   Ring Buffer header (esistente)
Offset 16-19:  heartbeat_counter (u32, atomic) â€” Worker 1 scrive, Main legge
Offset 20-23:  heartbeat_counter_w2 (u32, atomic) â€” Worker 2 scrive, Main legge
Offset 24-27:  supervisor_flags (u32, atomic) â€” Main scrive comandi al supervisor
Offset 28+:    Ring Buffer data region (spostata di 12 bytes)
```

**Protocollo**:

```
Main Thread (Supervisor)                     Worker
â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”                     â€”â€”â€”â€”â€”â€”
Ogni 60 frame (~1 secondo):
  last = heartbeat
  heartbeat = Atomics.load(counter)
  if (heartbeat === last):
    missedBeats++
    if (missedBeats >= 3):                   // 3 secondi senza heartbeat
      worker.terminate()
      attemptRestart()
      if (restartFailed):
        degradeMode()                        // Aâ†’B o Bâ†’C
  else:
    missedBeats = 0
                                             Ogni tick completato:
                                               Atomics.add(counter, 1)
```

**Pro**: Costo trascurabile (~nanosecond per frame), nessun `postMessage`, funziona anche con message queue bloccata, contatore monotono.

**Contro**: Richiede di spostare l'offset della data region di 12 byte (breaking change interno), Worker throttled appare morto.

##### Opzione B: `postMessage` Ping/Pong

**Pro**: Non modifica SAB layout, funziona in Mode C, round-trip time misurabile.
**Contro**: ~50-200Î¼s per `postMessage`, non rileva freeze, aggiunge complessitÃ .

##### Opzione C: `Worker.onerror` + `Worker.onmessageerror` (Complemento)

**Pro**: Zero overhead, cattura eccezioni esplicite.
**Contro**: Non rileva freeze o deadlock â€” solo crash espliciti.

##### Decisione

**Implementare Opzione A (Heartbeat) + Opzione C (onerror) in combinazione.** L'heartbeat rileva freeze e crash silenziosi. Gli error handler rilevano crash espliciti con informazioni diagnostiche.

#### Protocollo di Degradazione

```
1. worker.terminate()                       // Forza terminazione
2. Flush ring buffer (set read_head = write_head)  // Previeni comandi stale
3. Tenta restart:
   a. Crea nuovo Worker
   b. Re-invia init message con SAB
   c. Attendi "ready" con timeout 5s
4. Se restart OK:
   a. Re-sincronizza stato (re-spawn entitÃ  attive)
   b. Log warning per lo sviluppatore
5. Se restart FALLISCE:
   a. Degrada mode: Aâ†’B (merge render su main), Bâ†’C (tutto su main)
   b. Notifica sviluppatore via callback onModeChange(oldMode, newMode, reason)
   c. Log errore con diagnostica
```

**Nota critica**: La degradazione dinamica Ã¨ fondamentale per applicazioni professionali. Un tool tipo Figma non puÃ² permettersi un crash â€” deve continuare a funzionare anche a performance ridotte.

#### Implementazione

**File nuovi**:
- `ts/src/supervisor.ts`: `WorkerSupervisor` class con heartbeat monitoring, restart logic, mode degradation
- Modifica `ts/src/worker-bridge.ts`: integrare il supervisor in `createWorkerBridge()` e `createFullIsolationBridge()`

**Modifica SAB layout**: Estendere il header da 16 a 32 byte (16 di padding per future estensioni).

**Test**:
- `supervisor.test.ts`: simulare heartbeat timeout, restart success/failure, degradation chain
- Aggiornare `ring-buffer.test.ts`: verificare nuovi offset header

---

### 1.2 Ring Buffer Backpressure [RING-01]

#### Il Problema in Dettaglio

Il ring buffer ha dimensione statica. Quando il buffer Ã¨ pieno, il comportamento attuale non Ã¨ definito:

| Strategia | Conseguenza nel gioco | Conseguenza in app professionale |
|-----------|----------------------|----------------------------------|
| **Drop silenzioso** | Input persi â†’ personaggio non si muove | Operazioni utente perse â†’ data loss |
| **Blocco producer** | Main thread si blocca â†’ UI freeze | InterattivitÃ  persa â†’ UX inaccettabile |
| **Sovrascrittura circolare** | Stato corrotto â†’ crash ECS | Stato corrotto â†’ crash applicazione |

#### Soluzione: Prioritized Retry Queue (Default) + Drop (Gaming)

##### Opzione A: Drop with Overflow Counter (Per gaming)

Se lo spazio libero Ã¨ insufficiente, il comando viene scartato. Un contatore atomico sul SAB traccia quanti comandi sono stati droppati.

```typescript
writeCommand(cmd: CommandType, entityId: number, payload?: ArrayBuffer): boolean {
    const msgSize = 1 + 4 + PAYLOAD_SIZES[cmd];
    const free = this.freeSpace();
    if (free < msgSize) {
        Atomics.add(this.overflowCounter, 0, 1);
        return false;
    }
    // ... scrittura normale ...
    return true;
}
```

##### Opzione B: Drop with Prioritized Retry Queue (Per applicazioni professionali â€” Raccomandata)

I comandi droppati vengono inseriti in una coda TypeScript-side drenata al frame successivo con prioritÃ . Comandi critici (Spawn, Despawn) hanno prioritÃ  alta; comandi ripetibili (SetPosition, SetVelocity) hanno prioritÃ  bassa e vengono sovrascritti dall'ultimo valore.

```typescript
class PrioritizedCommandQueue {
    private critical: Command[] = [];        // Spawn, Despawn â€” mai droppati
    private overwrites: Map<number, Command>; // Per-entity: solo l'ultimo SetPosition/etc.

    enqueue(cmd: Command): void {
        if (cmd.type === CommandType.SpawnEntity || cmd.type === CommandType.DespawnEntity) {
            this.critical.push(cmd);
        } else {
            this.overwrites.set(cmd.entityId * 256 + cmd.type, cmd);
        }
    }

    drainTo(ringBuffer: RingBufferProducer): void {
        for (const cmd of this.critical) {
            if (!ringBuffer.writeCommand(cmd)) break;
        }
        for (const cmd of this.overwrites.values()) {
            if (!ringBuffer.writeCommand(cmd)) break;
        }
        this.clear();
    }
}
```

##### Decisione

**Opzione B (Prioritized Retry Queue)** come default, con API per scegliere Opzione A (fire-and-forget) per scenari gaming.

```typescript
const engine = Hyperion.create({
    backpressure: 'retry-queue'  // default per app professionali
    // oppure
    backpressure: 'drop'         // per gaming ad alta frequenza
});
```

#### Dimensionamento del Buffer

```
Worst case gaming:     100k entitÃ  Ã— SetPosition (17 bytes) = 1.7 MB/frame
Typical gaming:        5k mutazioni/frame Ã— avg 15 bytes    = 75 KB/frame
Typical app:           500 mutazioni/frame Ã— avg 15 bytes   = 7.5 KB/frame
```

**Raccomandazione**: Buffer default 2MB con opzione di override. 2MB copre il caso tipico con margine 10x+.

---

### 1.3 Ottimizzazione DataView â†’ TypedArray [RING-02]

#### Il Problema

`DataView` garantisce endianness-safety ma ha un costo misurabile nel hot path:

```
Operazione                  DataView      Float32Array    Speedup
set 1M float32              ~12ms         ~3ms            4x
get 1M float32              ~10ms         ~2.5ms          4x
```

Il 99.97% dei dispositivi con browser moderno Ã¨ little-endian.

#### Soluzione: Fast Path con Runtime Detection

```typescript
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

class RingBufferProducer {
    private f32View: Float32Array;  // Solo se LE
    private u32View: Uint32Array;   // Solo se LE

    writeFloat32(offset: number, value: number): void {
        if (IS_LITTLE_ENDIAN) {
            this.f32View[offset >> 2] = value;
        } else {
            this.dataView.setFloat32(offset, value, true);
        }
    }
}
```

**Decisione**: Opzione B (TypedArray per payload dove allineato, DataView per header). Il guadagno reale Ã¨ nel payload â€” 3 float per SetPosition sono 12 byte che beneficiano del fast path.

---

### 1.4 TextureManager: Lazy Allocation [REND-01, ASSET-01 parziale]

#### Il Problema

L'allocazione upfront di 256 layer per tutti e 4 i tier consuma **356.52 MB** â€” dealbreaker su mobile.

#### Soluzione: Allocazione Lazy per Tier con Chunk Growth

```typescript
class TextureManager {
    private tiers: TierState[];

    constructor(device: GPUDevice) {
        this.tiers = TIER_SIZES.map(size => ({
            size,
            texture: null,           // Non allocato finchÃ© non serve
            allocatedLayers: 0,
            nextFreeLayer: 0,
        }));
    }

    private ensureTierCapacity(tierIdx: number, neededLayers: number): void {
        const tier = this.tiers[tierIdx];
        if (tier.allocatedLayers >= neededLayers) return;
        // Crescita esponenziale: 16 â†’ 32 â†’ 64 â†’ 128 â†’ 256
        const newCapacity = Math.min(256,
            Math.max(neededLayers, tier.allocatedLayers * 2 || 16));
        // ... riallocazione con copia GPU ...
    }
}
```

**Impatto sulla memoria iniziale**:

```
Allocazione iniziale (lazy, 16 layers per tier usato):
Tier 0: 64Ã—64Ã—4 Ã— 16   =  0.26 MB   (vs 4.19 MB)
Tier 1: 128Ã—128Ã—4 Ã— 16  =  1.05 MB   (vs 16.78 MB)
Tier 2: non allocato     =  0 MB      (vs 67.11 MB)
Tier 3: non allocato     =  0 MB      (vs 268.44 MB)
                  TOTALE:   1.31 MB   (vs 356.52 MB)
                  RIDUZIONE: 99.6%
```

#### Bind Group Rebuild

Quando un tier viene riallocato, il bind group diventa invalido. Meccanismo lazy rebuild con flag `texBindGroupDirty`. Costo trascurabile (~microsecond), avviene solo al resize di un tier.

---

### 1.5 Test di Stress e Benchmark Baseline [ROAD-01, ARCH-02]

#### Benchmark Suite Minima

| Benchmark | Cosa misura | Target (desktop) | Target (mobile mid) |
|-----------|------------|-------------------|---------------------|
| `ring-buffer-throughput` | Comandi/sec nel ring buffer | > 5M cmds/sec | > 1M cmds/sec |
| `ecs-tick-10k` | Tempo di `engine_update` con 10k entitÃ  | < 2ms | < 5ms |
| `ecs-tick-100k` | Tempo di `engine_update` con 100k entitÃ  | < 16ms | < 40ms |
| `spawn-despawn-churn` | 1000 spawn + 1000 despawn per frame, 600 frame | Nessun leak memoria | Nessun leak |
| `gpu-upload-100k` | Tempo di `writeBuffer` per 100kÃ—88 byte (SoA) | < 3ms | < 8ms |
| `compute-cull-100k` | Tempo del compute pass di culling 100k entitÃ  | < 0.5ms | < 2ms |
| `prefix-sum-100k` | Tempo del Blelloch scan su 100k entitÃ  | < 0.3ms | < 1ms |
| `full-frame-100k` | Tempo totale frame con 100k entitÃ  (tick+render) | < 16ms | N/A (target 30fps) |
| `mode-c-10k` | Frame time Mode C con 10k entitÃ  | < 16ms | < 33ms |

#### Hardware Target

| Fascia | Dispositivo di riferimento | Budget frame | Target entitÃ  |
|--------|--------------------------|--------------|---------------|
| Desktop high | MacBook Pro M3, RTX 3060 | 16ms (60fps) | 100k |
| Desktop mid | Intel UHD 630, GTX 1050 | 16ms (60fps) | 50k |
| Mobile high | iPhone 15, Galaxy S24 | 16ms (60fps) | 20k |
| Mobile mid | iPhone 12, Galaxy A54 | 33ms (30fps) | 10k |
| Electron/Tauri | Varia (desktop GPU) | 16ms (60fps) | 100k |

---

### 1.6 Buffer GPU: da Struct Monolitico a Structure of Arrays (SoA) [REND-04]

#### Il Problema

La roadmap v2.1 prevedeva un layout monolitico a 22 f32/entity. L'analisi degli algoritmi di rendering ha evidenziato tre problemi critici:

1. **Partial update inefficiency**: quando cambia solo la posizione, bisogna comunque indirizzare un blocco da 88 byte. Con SoA, l'upload parziale tocca solo il buffer delle trasformazioni.
2. **Compute shader cache miss**: il compute culling legge solo bounding sphere e transform, ma ogni read carica anche dati inutili. Su GPU mobili con cache L1 piccole (16-32KB), riduce il throughput.
3. **EstensibilitÃ  bloccata**: le nuove primitive richiedono parametri aggiuntivi per-entity. Aggiungere campi al struct monolitico forza il re-layout dell'intero buffer GPU.

#### Soluzione: Storage Buffer SoA

```
Buffer A â€” Transform (16 f32/entity, 64 byte):
  [mat4x4f] Ã— N

Buffer B â€” BoundingSphere (4 f32/entity, 16 byte):
  [vec4f center_radius] Ã— N

Buffer C â€” RenderMeta (2 u32/entity, 8 byte):
  [meshHandle, renderPrimitive] Ã— N

Buffer D â€” PrimitiveParams (8 f32/entity, 32 byte) [Phase 5.5]:
  [param0..param7] Ã— N   // Interpretazione dipende da renderPrimitive
```

**Totale**: 88 byte/entity (identico al layout monolitico), ma separato in buffer indipendenti.

#### Impatto sugli Shader

```wgsl
// SoA binding layout
@group(1) @binding(0) var<storage, read> transforms: array<mat4x4f>;
@group(1) @binding(1) var<storage, read> bounds: array<vec4f>;
@group(1) @binding(2) var<storage, read> renderMeta: array<vec2u>;
@group(1) @binding(3) var<storage, read> primParams: array<mat2x4f>;
```

Il compute culling legge **solo** `transforms` e `bounds` â€” nessun dato superfluo nella cache.

#### Bind Group Layout Completo

```
Bind Group 0 â€” Frame-level (camera, time, frustum):
  @binding(0) camera: uniform
  @binding(1) frustumPlanes: uniform
  @binding(2) frameParams: uniform

Bind Group 1 â€” Entity data (SoA):
  @binding(0) transforms: storage<read>
  @binding(1) bounds: storage<read>
  @binding(2) renderMeta: storage<read>
  @binding(3) primParams: storage<read>

Bind Group 2 â€” Textures:
  @binding(0) textureArray: texture_2d_array
  @binding(1) sampler: sampler
  @binding(2) texIndices: storage<read>

Bind Group 3 â€” Pass-specific (varia per pass):
  // CullPass: indirect draw buffer, visibility buffer
  // PickingPass: picking output texture
  // OutlinePass: JFA textures
```

#### Dirty Tracking per-Buffer

```rust
pub struct DirtyTracker {
    transform_dirty: BitSet,    // Posizione/rotazione/scala cambiata
    bounds_dirty: BitSet,       // Bounding sphere cambiata (raro dopo init)
    meta_dirty: BitSet,         // MeshHandle/RenderPrimitive cambiato (rarissimo)
    params_dirty: BitSet,       // Parametri primitiva cambiati
}
```

Nella pratica, dopo l'inizializzazione, `bounds_dirty` e `meta_dirty` sono quasi sempre vuoti â€” l'engine uploada solo i transform delle entitÃ  in movimento.

#### FrameState Aggiornato

```typescript
interface FrameState {
    entityCount: number;
    transforms: Float32Array;      // 16 f32/entity
    bounds: Float32Array;          // 4 f32/entity
    renderMeta: Uint32Array;       // 2 u32/entity
    primParams: Float32Array;      // 8 f32/entity (zero-filled per quad)
    texIndices: Uint32Array;       // 1 u32/entity
    camera: Camera;
    canvasWidth: number;
    canvasHeight: number;
    deltaTime: number;
}
```

#### Costanti Aggiornate

La costante `FLOATS_PER_GPU_ENTITY = 22` viene rimossa. Al suo posto:

```typescript
const FLOATS_PER_TRANSFORM = 16;    // mat4x4f
const FLOATS_PER_BOUNDS = 4;        // vec4f
const U32S_PER_RENDER_META = 2;     // meshHandle + renderPrimitive
const FLOATS_PER_PRIM_PARAMS = 8;   // parametri primitiva
```

---

### 1.7 Componenti ECS: MeshHandle e RenderPrimitive [Tensione 1, 3]

#### Implementazione

**Rust** (`components.rs`) â€” Due nuovi componenti:

```rust
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct MeshHandle(pub u32);   // 0 = unit quad (default)

impl Default for MeshHandle {
    fn default() -> Self { Self(0) }
}

#[derive(Debug, Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct RenderPrimitive(pub u8); // 0 = Quad

impl Default for RenderPrimitive {
    fn default() -> Self { Self(0) }
}
```

**Nuovi comandi Ring Buffer**:
```
SetMeshHandle      = 8    // payload: 4 byte (u32 LE)
SetRenderPrimitive = 9    // payload: 1 byte (u8) â€” padded a 4 per allineamento
```

**Rust** (`render_state.rs`) â€” `collect_gpu()` produce quattro slice SoA separati (transforms, bounds, renderMeta, primParams) invece di un monolitico.

**TypeScript** â€” Aggiornare `CommandType` e `PAYLOAD_SIZES`.

**Test**: Test Rust e TypeScript per serializzazione nuovi comandi, SoA output, regressione visuale.

---

### 1.8 GPU Upload: `writeBuffer()` come Fast Path Esclusivo

L'analisi del Chrome GPU team conferma: `queue.writeBuffer()` Ã¨ il percorso raccomandato per WASM â€” il browser gestisce internamente lo staging. `mapAsync` non Ã¨ necessario e viene rimosso come alternativa.

Con il layout SoA, nel caso peggiore (tutte le entitÃ  dirty) sono 4 chiamate `writeBuffer()` â€” 20Î¼s totali (~5Î¼s per chiamata). Il delta rispetto a una singola chiamata su buffer monolitico Ã¨ trascurabile.

**Decisione**: Confermare `writeBuffer()` come unico metodo di upload. Eliminare `mapAsync` dalla roadmap per ridurre la superficie decisionale.

---

### 1.9 Renderer Modulare: RenderGraph DAG con Resource Lifetime [Tensione 2]

#### Il Problema

`renderer.ts` Ã¨ un monolite. La ricerca descrive pipeline complesse per future fasi:

```
App Figma:  [Compute Cull] â†’ [Forward Render] â†’ [JFA Outline Pass 1..N] â†’ [Outline Composite] â†’ [FXAA] â†’ [UI]
Game:       [Compute Cull] â†’ [Shadow Map] â†’ [Forward Render] â†’ [Bloom Extract â†’ Blur] â†’ [Tonemap + FXAA] â†’ [UI]
```

Una sequenza lineare di pass non gestisce texture intermediate, ping-pong buffer, o dipendenze di risorse.

#### Architettura Target

```
ts/src/
  renderer.ts              â†’ RIMOSSO
  render/
    render-graph.ts        â†’ DAG con resource lifetime + dead-pass culling
    render-pass.ts         â†’ Interfaccia RenderPass + FrameState
    resource-pool.ts       â†’ Pool di buffer GPU riutilizzabili + transient textures
    passes/
      cull-pass.ts         â†’ Compute culling + prefix sum + stream compaction
      forward-pass.ts      â†’ Render pass principale con pipeline per tipo primitiva
```

#### Interfaccia RenderPass

```typescript
interface RenderPassDescriptor {
    readonly name: string;
    readonly reads: string[];       // Risorse lette (nomi logici)
    readonly writes: string[];      // Risorse scritte
    readonly optional: boolean;     // Disabilitabile senza invalidare il graph
}

interface RenderPass extends RenderPassDescriptor {
    setup(device: GPUDevice, resources: ResourcePool): void;
    prepare(device: GPUDevice, frame: FrameState): void;
    execute(encoder: GPUCommandEncoder, frame: FrameState, resources: ResourcePool): void;
    resize(width: number, height: number): void;
    destroy(): void;
}
```

#### RenderGraph DAG

```typescript
class RenderGraph {
    private passes: RenderPass[] = [];
    private executionOrder: number[] = [];
    private compiled = false;

    addPass(pass: RenderPass): void {
        pass.setup(this.device, this.resources);
        this.passes.push(pass);
        this.compiled = false;
    }

    compile(): void {
        // 1. Topological sort basato su reads/writes (Kahn's algorithm)
        this.executionOrder = this.topologicalSort();
        
        // 2. Calcola lifetime di ogni risorsa transient
        const lifetimes = this.computeResourceLifetimes();
        
        // 3. Alloca texture transient dal pool con aliasing
        this.resources.planTransientAllocations(lifetimes);
        
        // 4. Dead-pass culling: rimuovi pass opzionali i cui output non sono letti
        this.cullDeadPasses();
        
        this.compiled = true;
    }

    render(frame: FrameState): void {
        if (!this.compiled) this.compile();

        for (const idx of this.executionOrder) {
            this.passes[idx].prepare(this.device, frame);
        }

        const encoder = this.device.createCommandEncoder();
        for (const idx of this.executionOrder) {
            this.passes[idx].execute(encoder, frame, this.resources);
        }

        this.device.queue.submit([encoder.finish()]);
        this.resources.reclaimTransients();
    }
}
```

#### Dead-Pass Culling

Se un pass opzionale ha tutte le sue risorse di output non lette da nessun pass successivo, viene automaticamente escluso dall'esecuzione (propagazione backward dal swapchain).

#### ResourcePool con Transient Textures

```typescript
class ResourcePool {
    private buffers: Map<string, GPUBuffer> = new Map();
    private textures: Map<string, GPUTexture> = new Map();

    // Buffer SoA entity data
    getEntityTransforms(): GPUBuffer    // Buffer A
    getEntityBounds(): GPUBuffer        // Buffer B
    getEntityRenderMeta(): GPUBuffer    // Buffer C
    getEntityPrimParams(): GPUBuffer    // Buffer D

    getBuffer(key: string, descriptor: GPUBufferDescriptor): GPUBuffer { ... }
    getTexture(key: string, descriptor: GPUTextureDescriptor): GPUTexture { ... }
    planTransientAllocations(lifetimes: Map<string, Lifetime>): void { ... }
    reclaimTransients(): void { ... }
    destroy(): void { ... }
}
```

**Nota**: Nella Phase 4.5, il DAG ha esattamente 2 nodi (CullPass â†’ ForwardPass) â€” la complessitÃ  extra Ã¨ zero a runtime. La complessitÃ  paga quando Phase 5.5 aggiunge nodi.

---

### 1.10 Indirect Draw da Single Buffer [REND-05]

La ricerca documenta un problema critico di performance su Chrome/Dawn: con buffer separati per ogni indirect draw, la validazione consumava ~3ms (50% del frame time); combinando in un singolo buffer si riduce a ~10Î¼s â€” **miglioramento 300Ã—**.

```typescript
const indirectBuffer = device.createBuffer({
    size: MAX_DRAW_CALLS * 20,  // 5 u32 per drawIndexedIndirect call
    usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE,
});
```

Il compute shader popola il buffer con gli argomenti per ogni draw call raggruppati per `RenderPrimitive` type. Il ForwardPass esegue N `drawIndexedIndirect` dallo stesso buffer con offset diversi.

---

### 1.11 Prefix Sum e Stream Compaction [REND-06]

Prefix sum Ã¨ il building block fondamentale per GPU-driven rendering. Il compute culling produce un flag "visible/not visible" per entitÃ . Per passare a indirect draws GPU-driven, serve **stream compaction**: dato un array di flag, produrre un array compatto degli indici visibili e il conteggio.

Pattern: `predicate â†’ prefix sum â†’ scatter`

```wgsl
// Step 1: Predicate (nel CullPass esistente)
visibility[i] = frustumTest(bounds[i], frustumPlanes) ? 1u : 0u;

// Step 2: Prefix sum (Blelloch algorithm â€” O(n) work, O(2 log n) depth)
// Input:  [0, 1, 1, 0, 1, 0, 1, 1]
// Output: [0, 0, 1, 2, 2, 3, 3, 4]  (exclusive scan)

// Step 3: Scatter
if (visibility[i] == 1u) {
    compactedIndices[prefixSum[i]] = i;
}
// Output: [1, 2, 4, 6, 7]  (solo gli indici visibili)
```

**Nota sulle subgroup operations**: Chrome 134+ supporta `subgroupExclusiveAdd` che accelera il prefix sum 2â€“3Ã— su hardware compatibile. Implementare come enhancement opzionale:

```typescript
const hasSubgroups = device.features.has('subgroups');
const prefixSumShader = hasSubgroups ? prefixSumSubgroups : prefixSumBlelloch;
```

---

### 1.12 Scene Graph Opt-in: Design del Modello Gerarchico [Tensione 5]

#### Modello: Flat-by-Default, Hierarchy-on-Demand

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                    EntitÃ  FLAT (default)                  â”‚
â”‚  Position + Rotation + Scale â†’ transform_system()        â”‚
â”‚  â†’ ModelMatrix (world space, diretta)                    â”‚
â”‚  Costo: O(1) per entitÃ , cache-friendly                 â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜

â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚               EntitÃ  GERARCHICHE (opt-in)                â”‚
â”‚  Position + Rotation + Scale (LOCAL space)               â”‚
â”‚  + Parent(EntityId) + Children(SmallVec<EntityId>)       â”‚
â”‚  â†’ propagate_transforms() calcola ModelMatrix WORLD      â”‚
â”‚  Costo: O(profonditÃ  albero) per entitÃ                   â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

#### Componenti ECS per Gerarchia

```rust
pub struct Parent(pub u32);                   // External entity ID
pub struct Children(pub SmallVec<[u32; 4]>);  // Inline per â‰¤4 figli
pub struct LocalMatrix(pub [f32; 16]);
```

#### Nuovo Comando Ring Buffer

```
SetParent       = 10   // payload: 4 byte (parent external entity ID)
                       // 0xFFFFFFFF = rimuovi parent (torna flat)
```

#### API TypeScript (design per Phase 5)

```typescript
const frame = engine.spawn().position(0, 0, 0);
const child = engine.spawn()
    .parent(frame)              // Rende figlia di frame
    .localPosition(10, 20, 0);  // Posizione relativa al parent

child.parent(otherFrame);       // Reparenting
child.unparent();               // Torna flat
frame.children;                 // EntityHandle[]
child.worldPosition;            // Posizione world-space calcolata
```

**Decisione**: `position()` Ã¨ world space per entitÃ  flat, local space per entitÃ  con parent. `worldPosition` (read-only) per entitÃ  gerarchiche.

Mitigazioni performance: propagazione solo se dirty, sorted array per depth, limite profonditÃ  a 32 livelli.

---

### 1.13 Memory Compaction Strategy [Tensione 4]

Design per long-running sessions. L'implementazione completa avviene in Phase 5.

- **EntityMap::shrink_to_fit()**: Tronca trailing None, rilascia capacity eccedente (sicuro, no remapping)
- **EntityMap::compact()**: Ricostruisce eliminando buchi (aggressivo, richiede ID remapping)
- **TextureManager::shrinkTier()**: Riallocazione con copia se <50% dei layer in uso
- **RenderState::shrink_to_fit()**: Rilascia capacity eccedente su tutti i buffer SoA

---

### 1.14 Predisposizioni Plugin System [Tensione 6]

Nessuna implementazione del plugin system in Phase 4.5, ma le seguenti decisioni architetturali devono tener conto dei plugin per non precludere l’estensibilità.

#### RenderGraph: slot per pass esterni

Il `RenderGraph` supporta l’aggiunta dinamica di nodi dopo la compilazione iniziale. Il graph si ricompila lazy quando un nodo viene aggiunto/rimosso (al prossimo frame). Questo abilita i plugin di rendering a inserire pass custom.

```typescript
class RenderGraph {
    private dirty = false;

    addPass(pass: RenderPass): void {
        if (this.passes.has(pass.name)) throw new Error(`RenderPass '${pass.name}' already registered`);
        this.passes.set(pass.name, pass);
        this.dirty = true;  // Ricompila al prossimo frame
    }

    removePass(name: string): void {
        const pass = this.passes.get(name);
        if (pass) { pass.destroy(); this.passes.delete(name); this.dirty = true; }
    }

    compile(): void {
        if (!this.dirty) return;
        // Topological sort, lifetime analysis, allocation, dead-pass culling
        this.dirty = false;
    }
}
```

**Costo se non fatto**: Se il RenderGraph non supporta addPass/removePass, i plugin di rendering richiedono un refactoring completo del graph.

#### RenderPrimitiveType: range riservato per futuri primitivi

L’enum `RenderPrimitiveType` è organizzato in range:
- **0–31**: Core primitives (gestite dal motore)
- **32–63**: Extended primitives (estensioni first-party)
- **64–127**: Plugin primitives (registrate a runtime)
- **128–255**: Riservate per uso futuro

Il ForwardPass delega il rendering dei valori 64–127 al plugin che ha registrato quel tipo. Se nessun handler è registrato, skip silenzioso (graceful degradation).

```typescript
// Nel ForwardPass (renderer TS):
if (primitiveType < 32) {
    this.renderCorePrimitive(encoder, primitiveType, entities);
} else if (primitiveType < 64) {
    this.renderExtendedPrimitive(encoder, primitiveType, entities);
} else if (primitiveType < 128) {
    const handler = this.pluginPrimitiveHandlers.get(primitiveType);
    if (handler) handler.render(encoder, entities, frame);
    // Se nessun handler, skip silenzioso
}
```

#### Bind Group 3: riservato per dati plugin nei pass custom

Il layout attuale usa Group 0 (camera/globals), Group 1 (entity SoA), Group 2 (textures). **Bind Group 3 è documentato come pass-specific/plugin data**, rispettando il limite WebGPU di `maxBindGroups: 4` e dando ai plugin un bind group completo per i propri dati GPU.

#### Costo totale predisposizioni Phase 4.5

Zero implementazione aggiuntiva. Le uniche differenze sono:
- `addPass()`/`removePass()` nel RenderGraph (necessari comunque per il refactoring modulare)
- Range documentati nell’enum `RenderPrimitiveType` (solo allocazione valori)
- Bind Group 3 documentato (solo documentazione)

---

### 1.15 Riepilogo Modifiche Phase 4.5

| Modifica | Prima | Dopo | Costo Aggiuntivo |
|----------|-------|------|------------------|
| Buffer layout | 22 f32/entity monolitico | SoA 4 buffer separati (88 byte/entity totale) | Medio â€” refactoring shader + buffer |
| GPU upload | writeBuffer + mapAsync alternativa | writeBuffer esclusivo | Negativo (semplificazione) |
| RenderGraph | Sequenza lineare di pass | DAG leggero con resource lifetime + dead-pass culling | Medio â€” topological sort + lifetime tracking |
| Indirect draw | Non specificato | Single buffer per tutti i draw indiretti (fix Dawn 300Ã—) | Basso |
| Prefix sum | Non previsto | Blelloch compute shader + stream compaction | Medio â€” nuovo compute shader riutilizzabile |
| Dirty tracking | Un bitset globale | Un bitset per-buffer (transform, bounds, meta, params) | Basso |
| MeshHandle/RenderPrimitive | Non esistenti | 2 componenti ECS + enum extensibile | Basso |
| Supervisor | Non esistente | Heartbeat atomico + degradazione dinamica | Medio |
| Backpressure | Non definita | Prioritized retry queue + overflow counter | Medio |
| Plugin predispositions | Non esistenti | Range enum 64–127, addPass/removePass, Bind Group 3 documentato | Zero (indirezioni, documentazione) |

---

## 2. Phase 5 â€” TypeScript API & Lifecycle

**Durata stimata**: 4â€“6 settimane  
**Prerequisiti**: Phase 4.5 completata  
**CriticitÃ  risolte**: ECS-01, ECS-02, ROAD-02 (parziale)  
**Interventi architetturali**: Scene graph opt-in (impl), Memory compaction API

Questa Ã¨ la fase che trasforma Hyperion da un "proof of concept interno" a un "prodotto utilizzabile da altri". Ogni decisione API Ã¨ quasi irreversibile dopo il primo utente esterno.

---

### 2.1 Design dell'API Pubblica

#### Principi di Design

1. **Zero-knowledge del ring buffer**: L'utente non sa che `entity.setPosition(x, y, z)` serializza 17 byte
2. **Fluent chaining**: `world.spawn().position(x, y, z).velocity(vx, vy, vz)`
3. **Type-safe con inference**: TypeScript inferisce i tipi senza annotazioni manuali
4. **Embeddable**: L'engine si attacca a un canvas esistente
5. **Disposable**: `using` (TC39 Explicit Resource Management) per lifecycle automatico

#### API Surface Completa

```typescript
// ============================================================
// Entry Point
// ============================================================

import { Hyperion, type HyperionConfig } from 'hyperion-engine';

const engine = await Hyperion.create({
    canvas: document.getElementById('game-canvas') as HTMLCanvasElement,
    maxEntities: 100_000,
    commandBufferSize: 2 * 1024 * 1024,
    backpressure: 'retry-queue',
    fixedTimestep: 1 / 60,
    preferredMode: 'auto',
    onModeChange: (from, to, reason) => {},
    onOverflow: (dropped) => {},
});

// ============================================================
// Entity Management
// ============================================================

const entity = engine.spawn()
    .position(100, 200, 0)
    .scale(2, 2, 1)
    .velocity(50, 0, 0)
    .texture(myTextureHandle);

entity.position(150, 200, 0);
entity.velocity(0, -100, 0);

engine.batch(() => {
    for (let i = 0; i < 1000; i++) {
        engine.spawn().position(i * 10, 0, 0);
    }
});

entity.destroy();

// ============================================================
// Scene Graph (opt-in, Tensione 5)
// ============================================================

const frame = engine.spawn().position(0, 0, 0);
const child = engine.spawn()
    .parent(frame)
    .localPosition(10, 20, 0);

child.parent(otherFrame);
child.unparent();
frame.children;
child.worldPosition;

// ============================================================
// Geometria e Primitive (Tensione 1, 3)
// ============================================================

entity.mesh(meshHandle);
entity.primitive('quad');

// ============================================================
// Rendering Primitives (Phase 5.5)
// ============================================================

const label = engine.spawn()
    .primitive('text')
    .text('Hello Hyperion', { font: fontHandle, size: 24, color: [1,1,1,1] })
    .position(100, 200, 0);

const line = engine.spawn()
    .primitive('line')
    .line({ start: [100,200], end: [300,400], width: 2, color: [1,0,0,1] });

const bg = engine.spawn()
    .primitive('gradient')
    .gradient({ type: 'linear', from: [0,0], to: [0,1],
        stops: [{ offset: 0, color: [0.1,0.1,0.3,1] }, { offset: 1, color: [0.3,0.1,0.5,1] }] });

const card = engine.spawn()
    .primitive('box-shadow')
    .boxShadow({ blur: 20, spread: 0, offset: [0,4], color: [0,0,0,0.25], cornerRadius: 8 });

// ============================================================
// Selection & Outlines (Phase 5.5 + Phase 6)
// ============================================================

engine.outlines.enable({ color: [0.2, 0.5, 1.0, 1.0], width: 3, softness: 1.5 });
engine.selection.select(entity);
engine.selection.selectMultiple([e1, e2, e3]);
engine.selection.clear();

// ============================================================
// Post-Processing (Phase 5.5)
// ============================================================

engine.postProcessing.enable({
    fxaa: true,
    tonemapping: 'pbr-neutral',   // 'pbr-neutral' | 'aces' | 'agx' | 'none'
});

// ============================================================
// Asset Loading
// ============================================================

const tex = await engine.loadTexture('/sprites/hero.png');
entity.texture(tex);

const textures = await engine.loadTextures([...], {
    onProgress: (loaded, total) => updateLoadingBar(loaded / total),
    concurrency: 6,
});

// ============================================================
// Camera
// ============================================================

engine.camera.position(0, 0);
engine.camera.zoom(2.0);
engine.camera.setOrthographic({ width: window.innerWidth, height: window.innerHeight });

// ============================================================
// Lifecycle
// ============================================================

engine.start();
engine.pause();
engine.resume();
engine.destroy();

{ using engine = await Hyperion.create({ canvas }); }

// ============================================================
// Memory Management (Tensione 4)
// ============================================================

engine.compact({
    entityMap: true,
    textures: true,
    renderState: true,
    aggressive: false,
});

engine.stats.memory;   // { wasmHeap, gpuEstimate, entityMapUtil, tierUtil[] }
engine.stats;          // { fps, entityCount, mode, tickCount, overflowCount }
```

#### Entity Handle: Opaque Handle (API primaria) + Numeric ID (raw API)

```typescript
// API ergonomica (default)
const entity = engine.spawn().position(100, 200, 0);

// API raw (performance-critical)
const id = engine.raw.spawn();
engine.raw.setPosition(id, 100, 200, 0);
```

Object pool per EntityHandle con cap a 1024. Benchmark target: 100k spawn+destroy senza GC pause visibili.

---

### 2.2 Lifecycle e Resource Management

`dispose()` + `using` + `FinalizationRegistry` (solo warning diagnostico).

Ordine di shutdown critico:
```
1. Stop RAF loop                    â† Nessun nuovo frame
2. Flush ring buffer                â† Processa comandi pendenti
3. Terminate Worker 1 (ECS)         â† Nessuna nuova simulazione
4. Terminate Worker 2 (Render)      â† Nessun nuovo render
5. Destroy GPU textures             â† Libera VRAM
6. Destroy GPU buffers              â† Libera VRAM
7. Destroy GPU pipeline             â† Rilascia shader compilati
8. device.destroy()                 â† Rilascia il GPUDevice
9. Nullify references               â† Aiuta il GC
```

---

### 2.3 Error Handling Strategy

#### `device.lost` â€” GPU Recovery

TextureManager mantiene cache CPU-side degli `ImageBitmap` per reuploading dopo device.lost. Costo: ~2x memoria per le texture, ma obbligatorio per la vision "universal engine".

#### Shader Compilation Errors

Uso di `shaderModule.getCompilationInfo()` con errori dettagliati (line, column, source).

---

### 2.4 Dirty-Flag per Partial Upload

**Opzione A (Dirty BitSet) per Phase 5**: bitset per-buffer (SoA) in Rust, upload parziale con threshold a 30%. Se meno del 30% delle entitÃ  Ã¨ dirty, upload parziale per-buffer; altrimenti upload completo per-buffer.

Il bitset costa 100k/8 = 12.5 KB per buffer â€” trascurabile.

---

### 2.5 Plugin System: Stubs e Hooks nel Game Loop [Tensione 6, PLUG-01 parziale]

Phase 5 introduce i punti di aggancio necessari per il plugin system, senza implementare il `PluginContext` completo. Costo implementativo minimale.

#### `HyperionConfig.plugins`

```typescript
interface HyperionConfig {
    canvas: HTMLCanvasElement;
    maxEntities?: number;
    // ... campi esistenti ...

    /** Plugin da installare all’inizializzazione. Ordine rispettato per priorità. */
    plugins?: HyperionPlugin[];
}
```

#### `engine.use()` / `engine.unuse()` e `engine.plugins`

```typescript
engine.use(myPlugin());              // Registra e chiama install()
engine.unuse('my-plugin');           // Chiama cleanup, rimuove
engine.plugins.has('my-plugin');     // boolean
engine.plugins.get('my-plugin');     // PluginInstance | undefined
engine.plugins.list();               // string[]
```

#### Entity builder: `.data()` generico

```typescript
const entity = engine.spawn()
    .position(100, 200, 0)
    .data('steering-ai', { target: [500, 300], speed: 100, behavior: 'seek' });
// Delega al plugin storage side-table
```

#### Pre-tick / Post-tick / Frame-end hooks nel game loop

```typescript
// Internamente il game loop diventa:
// 1. Input handlers (plugin + built-in)
// 2. preTick callbacks (array, O(n), priority-ordered)
// 3. ECS tick (Rust/WASM — non estensibile)
// 4. postTick callbacks (array, O(n), priority-ordered)
// 5. RenderGraph execute (include plugin passes)
// 6. frameEnd callbacks
```

Nessun overhead se nessun plugin è registrato: gli array di callback sono vuoti.

#### CommandType: range riservato 64–127

```typescript
const enum CommandType {
    // 0–63: core + input commands (esistenti)
    // 64–127: riservati per comandi plugin (documentazione, nessun codice)
    // 128–191: riservati per comandi di sistema (diagnostica, profiling)
    // 192–255: riservati per uso futuro
}
```

I plugin NON scrivono direttamente nel ring buffer. Usano l’API pubblica che serializza per loro. Il range è riservato per future necessità.

---

## 3. Phase 5.5 â€” Rendering Primitives

**Durata stimata**: 5â€“6 settimane  
**Prerequisiti**: Phase 5 completata (API pubblica, scene graph, entity handles)  
**Dipendenze dalla Phase 4.5**: SoA buffer layout, RenderGraph DAG, prefix sum, indirect draws, RenderPrimitive enum  
**CriticitÃ  risolte**: REND-07, REND-08, REND-09, REND-10, REND-11, TENS-01 (impl), TENS-03 (impl)

Questa fase implementa le capacitÃ  di rendering che trasformano Hyperion da un quad renderer in un motore grafico per applicazioni reali. Le feature sono selezionate per ROI su tre assi: valore di mercato, complessitÃ  implementativa, dipendenze sbloccate.

---

### 3.1 MSDF Text Rendering [REND-07]

**ROI**: Massimo â€” highest-ROI primitive per entrambi i mercati (game + canvas). Sblocca: UI di gioco, label, tooltip, text editing in canvas professionali.

#### Tecnica

MSDF (Multi-channel Signed Distance Field) codifica informazioni di distanza su tre canali RGB con edge coloring, preservando angoli netti. Il fragment shader ricostruisce la distanza con `median(r, g, b)` e applica anti-aliasing via screen-pixel-range scaling.

Ogni glifo Ã¨ un instanced quad (2 triangoli) â€” nativamente supportato da Hyperion. Un blocco di testo diventa un singolo draw call per pagina dell'atlas.

#### Componenti

**1. Atlas MSDF (Rust-side)**

```rust
pub struct GlyphParams {
    pub atlas_uv_min: [f32; 2],     // UV min nell'atlas
    pub atlas_uv_max: [f32; 2],     // UV max nell'atlas
    pub screen_px_range: f32,       // Range per AA
    pub color: [f32; 3],            // RGB del testo
}
```

**2. Atlas Management**: `msdf-atlas-gen` offline â†’ atlas PNG + JSON metadata. Runtime: shelf packing via crate `etagere` (da Mozilla WebRender).

**3. WGSL Fragment Shader**:

```wgsl
fn median(r: f32, g: f32, b: f32) -> f32 {
    return max(min(r, g), min(max(r, g), b));
}

@fragment
fn fs_msdf_glyph(in: VertexOutput) -> @location(0) vec4f {
    let msdf = textureSample(msdfAtlas, msdfSampler, in.uv);
    let sd = median(msdf.r, msdf.g, msdf.b);
    let screenPxDistance = screenPxRange * (sd - 0.5);
    let opacity = clamp(screenPxDistance + 0.5, 0.0, 1.0);
    if (opacity < 0.01) { discard; }
    return vec4f(textColor.rgb, opacity * textColor.a);
}
```

**4. Text Layout Engine**: Partire con layout custom minimale (kerning table, line breaking greedy). Hook per layout esterno:

```typescript
engine.text.setLayoutEngine(customLayoutFn);  // Per HarfBuzz o altro
```

**5. API Pubblica**: `engine.spawn().primitive('text').text('Hello', { font, size, color, align })`. Internamente N entitÃ  glifo raggruppate sotto un parent invisibile (scene graph Phase 5).

#### Test e Benchmark

- 10.000 glifi simultanei a 60fps
- Anti-aliasing a zoom 0.5Ã—â€“8Ã— senza artefatti
- Confronto con Canvas 2D `fillText` come baseline

**Stima: 1.5â€“2 settimane**

---

### 3.2 JFA Selection Outlines [REND-08]

**ROI**: Alto â€” essenziale per il mercato canvas. Sblocca: selezione visiva in editor tipo Figma.

#### Tecnica

Jump Flood Algorithm: propaga iterativamente la posizione del seed piÃ¹ vicino con step dimezzati. Dopo logâ‚‚(maxDim) passaggi, ogni pixel conosce il seed piÃ¹ vicino. Performance: ~530Î¼s at 1080p per outline 100px, tempo costante rispetto alla larghezza.

#### Pipeline nel RenderGraph

```
[CullPass] â†’ [ForwardPass] â†’ [SelectionSeedPass] â†’ [JFA Pass Ã—10] â†’ [OutlineCompositePass] â†’ [Present]
```

```typescript
class SelectionSeedPass implements RenderPass {
    readonly name = 'selection-seed';
    readonly reads = ['entity-transforms', 'entity-render-meta'];
    readonly writes = ['jfa-seed-texture'];
    readonly optional = true;
}

class JFAPass implements RenderPass {
    readonly name = 'jfa-step';
    readonly reads = ['jfa-ping'];
    readonly writes = ['jfa-pong'];
    readonly optional = true;
    // Internamente esegue tutti gli step N in execute()
}

class OutlineCompositePass implements RenderPass {
    readonly name = 'outline-composite';
    readonly reads = ['forward-output', 'jfa-final'];
    readonly writes = ['swapchain'];
    readonly optional = true;
}
```

#### Interazione con Picking (Phase 6)

Picking e outline condividono l'identitÃ  dell'entitÃ . Il picking seleziona, l'outline evidenzia.

#### API Pubblica

```typescript
engine.outlines.enable({ color: [0.2, 0.5, 1.0, 1.0], width: 3, softness: 1.5 });
engine.selection.select(entity);
engine.selection.selectMultiple([e1, e2, e3]);
engine.selection.deselect(entity);
engine.selection.clear();
engine.selection.selected;              // Set<EntityHandle>
```

**Stima: 1â€“1.5 settimane**

---

### 3.3 Instanced Line Rendering [REND-09]

**ROI**: Alto per entrambi i mercati. Sblocca: connettori tra nodi, bordi, grafi, griglie.

#### Tecnica

Instanced screen-space expansion: ogni segmento diventa un quad espanso perpendicolarmente nel vertex shader. Storage buffer + indexing via `vertex_index / 6` e `vertex_index % 6`.

```rust
pub struct LineParams {
    pub start: [f32; 2],
    pub end: [f32; 2],
    pub width: f32,             // Spessore in pixel (screen space)
    pub dash_length: f32,       // 0 = solido
    pub cap_type: f32,          // 0 = butt, 1 = round, 2 = square
    pub _padding: f32,
}
```

Phase 5.5: solo **butt caps** e **no joins**. Round caps e joins sono ottimizzazione futura.

Dash pattern via SDF nel fragment shader con `fract(distanceAlongLine / dashLength)`.

#### API Pubblica

```typescript
const line = engine.spawn()
    .primitive('line')
    .line({ start: [100,200], end: [300,400], width: 2, color: [1,0,0,1], dash: 0, cap: 'butt' });

// Polyline helper
const polyline = engine.spawnPolyline({
    points: [[0,0], [100,50], [200,0], [300,75]],
    width: 2, color: [1,1,1,1], closed: false,
});
```

**Stima: 1 settimana**

---

### 3.4 Gradients e SDF Box Shadows [REND-10]

**ROI**: Alto per il mercato canvas. Sblocca: sfondi, fill di forme, elevazione UI.

#### Gradients via 1D LUT Texture

Texture array 1D (o texture 2D come array di righe, 256Ã—256) con hardware linear interpolation. Supporto linear, radial, conic gradient.

```rust
pub struct GradientParams {
    pub gradient_type: f32,        // 0 = linear, 1 = radial, 2 = conic
    pub start_or_center: [f32; 2],
    pub end_or_radius: [f32; 2],
    pub lut_index: f32,
    pub _padding: [f32; 2],
}
```

#### SDF Box Shadows â€” O(1) per Pixel

Tecnica Evan Wallace: closed-form convolution di Gaussian 1D con box function usando la error function (erf). Blur radius 2 o 200 â€” stesso costo.

```wgsl
fn boxShadow(fragCoord: vec2f, boxCenter: vec2f, boxSize: vec2f,
             cornerRadius: f32, blurRadius: f32, shadowColor: vec4f) -> vec4f {
    let d = abs(fragCoord - boxCenter) - boxSize * 0.5 + vec2f(cornerRadius);
    let dist = length(max(d, vec2f(0.0))) - cornerRadius;
    let shadow = 0.5 - 0.5 * erf(dist / (blurRadius * sqrt(2.0)));
    return vec4f(shadowColor.rgb, shadowColor.a * shadow);
}
```

Nota: `erf()` non Ã¨ built-in in WGSL â€” approssimazione polinomiale di Abramowitz-Stegun (6 termini, errore max ~1.5Ã—10â»â·).

**Stima: 1 settimana**

---

### 3.5 FXAA + Tonemapping Post-Processing [REND-11]

**ROI**: Medio-alto. Migliora la qualitÃ  visiva di tutte le primitive senza costo per-primitiva.

FXAA (Lottes, NVIDIA): singolo full-screen pass, compute luma + edge detection + blend.

```typescript
class FXAAPass implements RenderPass {
    readonly name = 'fxaa';
    readonly reads = ['post-process-output'];
    readonly writes = ['swapchain'];
    readonly optional = true;  // Disabilitabile per performance su mobile
}
```

#### Tonemapping

- **Khronos PBR Neutral**: 1:1 color reproduction, 13 righe shader. Per canvas/design.
- **ACES**: look filmico con desaturazione highlights. Per giochi.

Entrambi nel pass FXAA (combinati per evitare lettura texture aggiuntiva).

**Stima: 0.5â€“1 settimana**

---

### 3.6 Riepilogo Phase 5.5

| Feature | Mercato Primario | Stima | RenderPrimitive | Nuovi Pass nel Graph |
|---------|-----------------|-------|-----------------|---------------------|
| MSDF Text | Gaming + Canvas | 1.5â€“2 sett. | `SDFGlyph = 2` | Nessuno (ForwardPass shader variant) |
| JFA Outlines | Canvas | 1â€“1.5 sett. | â€” (post-process) | SelectionSeed + JFA + OutlineComposite |
| Instanced Lines | Canvas + Gaming | 1 sett. | `Line = 1` | Nessuno (ForwardPass shader variant) |
| Gradients + Shadows | Canvas | 1 sett. | `Gradient = 4`, `BoxShadow = 5` | Nessuno |
| FXAA + Tonemapping | Tutti | 0.5â€“1 sett. | â€” (post-process) | FXAAPass |
| **Totale** | | **5â€“6.5 sett.** | | |

#### Shader Dispatch nel ForwardPass

**Approccio: Pipeline Separate** â€” una `GPURenderPipeline` per ogni `RenderPrimitiveType`. Il ForwardPass raggruppa le entitÃ  per tipo ed esegue un draw call per gruppo. Nessun branching nello shader. Il CullPass (stream compaction) produce indici giÃ  raggruppati per tipo come byproduct naturale.

---

## 4. Phase 4b â€” KTX2/Basis Universal [ASSET-02]

**Durata stimata**: 2â€“3 settimane (in parallelo con Phase 5 e Phase 5.5)  
**CriticitÃ  risolta**: ASSET-02

### Il Problema Quantificato

Senza compressione GPU-nativa: 256Ã—256 RGBA8 Ã— 256 layers = 67 MB per tier 2. Con BC7 (4:1): 16.7 MB. Con ASTC 4Ã—4 (5.33:1): ~12.5 MB.

### Strategia

KTX2 container + Basis Universal codec. Transcoding runtime al formato nativo GPU:

| GPU | Formato | Compressione | QualitÃ  |
|-----|---------|-------------|---------|
| Desktop (BC7) | `bc7-rgba-unorm` | 4:1 | Eccellente |
| Mobile (ASTC 4Ã—4) | `astc-4x4-unorm` | 5.33:1 | Molto buona |
| Fallback | `rgba8unorm` | 1:1 | Perfetta |

Transcoder WASM (~200KB) caricato lazy solo quando KTX2 richiesto. Feature detection: `device.features.has('texture-compression-bc')` / `'texture-compression-astc'`.

---

## 5. Phase 6 â€” Input & Audio

**Durata stimata**: 3â€“4 settimane  
**CriticitÃ  risolte**: INPUT-01, AUDIO-01

---

### 5.1 Sistema di Input

Tre paradigmi: game input (polling), application input (hit testing), hybrid.

**Input Buffering via Ring Buffer** (gaming) + **Shared State via SAB** (applicazioni). L'API li astrae:

```typescript
engine.input.onKey('Space', () => { /* jump */ });
engine.input.isKeyDown('W');
engine.input.pointerPosition;
```

Nuovi CommandType: InputKeyDown(16), InputKeyUp(17), InputPointerMove(18), InputPointerDown(19), InputPointerUp(20), InputScroll(21).

#### Hit Testing â€” GPU-based Picking via Color ID

Render pass secondario off-screen con entityID encoded come colore RGB. `readPixel` sul click restituisce l'ID. Opt-in â€” non tutte le applicazioni ne hanno bisogno.

**Interazione con JFA Outlines (Phase 5.5)**: Picking seleziona, outline evidenzia. Set condiviso:

```typescript
engine.input.onClick((e) => {
    const entityId = engine.picking.hitTest(e.x, e.y);
    if (entityId) engine.selection.select(entityId);
});
```

---

### 5.2 Sistema Audio â€” AudioWorklet Isolation

AudioWorklet thread dedicato con WASM audio DSP separato.

#### Build System Doppio Binario WASM [AUDIO-01]

```
HyperionEngine/
â”œâ”€â”€ Cargo.toml                    # [workspace]
â”œâ”€â”€ crates/
â”‚   â”œâ”€â”€ hyperion-core/            # Engine WASM (~150KB)
â”‚   â””â”€â”€ hyperion-audio/           # Audio DSP WASM (~30-50KB)
```

Binary audio caricato lazy solo quando richiesto.

---

### 5.3 Riconciliazione Input Predittivo [INPUT-01]

**Opzione B (Immediate Mode per UI)** come default per drag/resize/pan/zoom (zero latenza). **Opzione A (Dead Reckoning)** per predizione gameplay.

```typescript
entity.setPositionImmediate(x, y, z);  // Shadow state + ring buffer (zero latency)
entity.setPosition(x, y, z);           // Solo ring buffer (1-2 frame latency)
```

---

## 6. Phase 7 â€” Polish, DX, e Production Readiness

**Durata stimata**: 3â€“4 settimane  
**CriticitÃ  risolte**: ARCH-03, ROAD-02

---

### 6.1 Deployment Guide [ARCH-03]

| Piattaforma | COOP/COEP Config | Note |
|-------------|------------------|------|
| **Vercel** | `vercel.json` headers | Supporto nativo |
| **Netlify** | `_headers` file | Supporto nativo |
| **Cloudflare Pages** | `_headers` file | Supporto nativo |
| **GitHub Pages** | Service Worker workaround | `coi-serviceworker` |
| **Electron** | Non necessario | SAB disponibile nativamente |
| **Tauri** | Non necessario | WebView2/Webkit ha SAB |
| **Self-hosted** | Nginx/Apache config | Snippet forniti |

### 6.2 Shader Hot-Reload

Vite HMR con `?raw` imports per file `.wgsl`:

```typescript
if (import.meta.hot) {
    import.meta.hot.accept('./shaders/basic.wgsl?raw', (newShader) => {
        renderer.recompileShader('basic', newShader.default);
    });
}
```

### 6.3 Performance Profiler Integrato

```typescript
engine.enableProfiler({
    overlay: true,
    position: 'top-left',
    metrics: ['fps', 'entities', 'mode', 'drawCalls', 'gpuTime', 'cpuTime',
              'ringBufferUsage', 'overflowCount', 'vramEstimate'],
});
```

### 6.4 DevTools Extension (Futuro)

Chrome DevTools extension per: entity inspector, ECS world state, ring buffer graph, GPU memory, frame timeline. Post-Phase 7 ma pianificato ora.

---

### 6.5 Plugin System – Implementazione Completa [Tensione 6, PLUG-01]

Le predisposizioni di Phase 4.5 (RenderGraph addPass/removePass, range enum, Bind Group 3) e gli stub di Phase 5 (`engine.use()`, hooks nel game loop, `.data()`) convergono qui nell’implementazione completa.

#### `PluginContext` con 5 Assi di Estensione

```typescript
interface PluginContext {
    readonly engine: HyperionEngine;
    readonly rendering: PluginRenderingAPI;   // addPass, removePass, declareResource, createPipeline
    readonly systems: PluginSystemsAPI;       // addPreTick, addPostTick, addFrameEnd
    readonly input: PluginInputAPI;           // addHandler (con priorità e event consumption)
    readonly storage: PluginStorageAPI;       // createMap<T>, createGpuBuffer (side-table per entità)
    readonly gpu: PluginGpuAPI;              // device access per risorse GPU custom
    readonly events: PluginEventAPI;         // emit/on/once per comunicazione inter-plugin
}
```

#### Deliverables

- `PluginContext` completo con tutte e 5 le API
- `engine.use()` / `engine.unuse()` per hot-loading plugin
- Plugin dependency resolution (topological sort)
- Plugin sandbox: error boundary per plugin che crashano (try/catch per hook, non propagano crash)
- Plugin GPU resource tracking con cleanup automatico
- Performance budget: 2ms per hook, warning + downgrade automatico
- Documentazione per plugin authors
- Template `create-hyperion-plugin` (npm scaffolding)

#### Rischi Specifici

| Rischio | Mitigazione |
|---------|-------------|
| Plugin causa memory leak GPU | `PluginGpuAPI` traccia tutte le risorse; `cleanup()` distrugge automaticamente |
| Plugin blocca main thread | Budget 2ms per system hook; warning + esecuzione ogni-N-frame |
| Due plugin scrivono stessa risorsa | RenderGraph valida dipendenze; errore a compile-time del graph |
| Aggiornamento engine rompe plugin | SemVer sull’interfaccia `HyperionPlugin`; `PluginContext` versionato |

#### Post-Phase 7: Ecosistema Plugin

- Registry di plugin (npm scope `@hyperion-plugin/*`)
- DevTools per plugin debugging
- Plugin performance profiling (tempo per frame per plugin)

---

## 7. Timeline Unificata

```
            Feb 2026          Mar 2026          Apr 2026          Mag 2026          Giu 2026          Lug 2026
            â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€>
Phase 4.5   â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–‘â–‘â–‘â–‘
(Stabiliz.  4-5 settimane
 + Arch     SoA layout, RenderGraph DAG, prefix sum, indirect draw,
 + Render   supervisor, backpressure, MeshHandle/RenderPrimitive,
 foundations) scene graph design, benchmark

Phase 4b                     â–‘â–‘â–‘â–‘â–‘â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–‘â–‘â–‘â–‘
(KTX2)                       2-3 settimane (parallelo con Phase 5/5.5)

Phase 5                          â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆ
(API &                           4-6 settimane
 Lifecycle                       API pubblica, entity pooling, dispose,
 + Scene graph                   scene graph opt-in impl, dirty-flag, compact()
 + Memory)

Phase 5.5                                                          â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆ
(Rendering                                                         5-6 settimane [NUOVA]
 Primitives)                                                       MSDF Text, JFA Outlines, Lines,
                                                                    Gradients, Box Shadows, FXAA

Phase 6                                                                                      â–‘â–‘â–‘â–‘â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆ
(Input &                                                                                     3-4 settimane
 Audio)

Phase 7                                                                                                  â–‘â–‘â–‘â–‘â–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆâ–ˆ
(Polish &                                                                                                3-4 settimane
 DX)

            TOTALE STIMATO: 20-27 settimane (5-7 mesi)
```

---

## 8. Dipendenze tra Fasi

```
Phase 4.5 â”€â”€> Phase 5       (API dipende da backpressure + supervisor + SoA layout + RenderGraph DAG)
Phase 4.5 â”€â”€> Phase 4b      (lazy allocation abilita compressione senza OOM)
Phase 4.5 â”€â”€> Phase 5.5     (SoA buffer, RenderPrimitive, prefix sum, RenderGraph DAG sono prerequisiti)
Phase 5   â”€â”€> Phase 5.5     (API pubblica, scene graph, entity handles necessari per API rendering)
Phase 5   â”€â”€> Phase 6       (input API dipende da entity handle system + scene graph per hit testing)
Phase 5.5 â”€â”€> Phase 6       (JFA outlines + picking pass formano un'unitÃ  coerente con input system)
Phase 5   â”€â”€> Phase 7       (profiler dipende dalle metriche esposte dall'API)
Phase 4b  â”€â”€> Phase 6       (audio puÃ² richiedere asset compressed)
Phase 5.5 â”€â”€> Phase 7       (FXAA/tonemapping sono prerequisiti per la "production readiness")
```

**Dipendenza critica**: Phase 5.5 dipende sia da Phase 4.5 (fondamenta rendering) che da Phase 5 (API pubblica). Non puÃ² iniziare finchÃ© entrambe non sono completate. Phase 4b puÃ² procedere in parallelo.

---

## 9. Matrice di Risoluzione CriticitÃ  Completa

### CriticitÃ  dalla Review v2.1

| ID | SeveritÃ  | Fase | Strategia | Stato |
|----|----------|------|-----------|-------|
| ARCH-01 | CRITICO | Phase 4.5 Â§1.1 | Heartbeat atomico + degradazione dinamica | Pianificato |
| RING-01 | CRITICO | Phase 4.5 Â§1.2 | Prioritized retry queue + overflow counter | Pianificato |
| ASSET-02 | CRITICO | Phase 4b | KTX2/Basis Universal con transcoding runtime | Pianificato |
| ROAD-01 | CRITICO | Phase 4.5 Â§1.5 + trasversale | Benchmark suite + test matrix per mode A/B/C | Pianificato |
| ARCH-02 | ALTO | Phase 4.5 Â§1.5 | Benchmark su 3 fasce hardware | Pianificato |
| ARCH-03 | ALTO | Phase 7 Â§6.1 | Deployment guide per 7 piattaforme | Pianificato |
| RING-02 | ALTO | Phase 4.5 Â§1.3 | Fast path TypedArray con detection LE | Pianificato |
| ECS-01 | ALTO | Phase 5 Â§2.1 | API facade nasconde storage model | Pianificato |
| REND-01 | ALTO | Phase 4.5 Â§1.4 | Lazy tier allocation con chunk growth | Pianificato |
| REND-02 | ALTO | Risolto + esteso Phase 4.5 Â§1.6-1.7 | SoA buffer layout + MeshHandle + RenderPrimitive | âœ… + estensione |
| ASSET-01 | ALTO | Phase 4.5 Â§1.4 + Phase 5 | Concurrency limiter + progress callback | Parziale |
| INPUT-01 | ALTO | Phase 6 Â§5.3 | Immediate mode per UI + dead reckoning per game | Pianificato |
| ROAD-02 | ALTO | Questo documento | Stime temporali + sezioni mancanti | âœ… Completato |
| ECS-02 | MEDIO | Phase 5 Â§2.1 | Documentazione pattern componenti | Pianificato |
| REND-03 | MEDIO | Post-Phase 7 | Feature detection bindless come enhancement | Futuro |
| AUDIO-01 | MEDIO | Phase 6 Â§5.2 | Workspace Cargo con due crate WASM | Pianificato |

### CriticitÃ  Rendering (dalla ricerca)

| ID | SeveritÃ  | Fase | Strategia | Stato |
|----|----------|------|-----------|-------|
| REND-04 | ALTO | Phase 4.5 Â§1.6 | SoA buffer layout per entity data GPU | Pianificato |
| REND-05 | ALTO | Phase 4.5 Â§1.10 | Indirect draw da single buffer (Dawn 300Ã— fix) | Pianificato |
| REND-06 | ALTO | Phase 4.5 Â§1.11 | Prefix sum (Blelloch) + stream compaction | Pianificato |
| REND-07 | ALTO | Phase 5.5 Â§3.1 | MSDF text rendering con atlas management | Pianificato |
| REND-08 | MEDIO | Phase 5.5 Â§3.2 | JFA selection outlines | Pianificato |
| REND-09 | MEDIO | Phase 5.5 Â§3.3 | Instanced line rendering | Pianificato |
| REND-10 | MEDIO | Phase 5.5 Â§3.4 | Gradients (LUT) + SDF box shadows | Pianificato |
| REND-11 | MEDIO | Phase 5.5 Â§3.5 | FXAA + tonemapping (PBR Neutral default) | Pianificato |

### Tensioni Strutturali

| ID | Tensione | Fase | Strategia | Stato |
|----|----------|------|-----------|-------|
| TENS-01 | Vincolo "entitÃ  = quad" | Phase 4.5 Â§1.7 + **Phase 5.5** | MeshHandle + RenderPrimitive + implementazione 5 primitive | Aggiornato |
| TENS-02 | Renderer monolitico | Phase 4.5 Â§1.9 | **RenderGraph DAG** con resource lifetime + dead-pass culling | Aggiornato |
| TENS-03 | Primitive rendering mancanti | **Phase 5.5** | Text, Lines, Gradients, Shadows, Outlines | Aggiornato |
| TENS-04 | Memoria long-running | Phase 4.5 Â§1.13 (design) + Phase 5 (impl) | compact() API + EntityMap shrink + tier shrink | Pianificato |
| TENS-05 | Scene graph assente | Phase 4.5 Â§1.12 (design) + Phase 5 (impl) | Parent/Children/LocalMatrix opt-in + propagate_transforms | Pianificato |

---

## 10. Rischi e Mitigazioni Completi

| Rischio | ProbabilitÃ  | Impatto | Mitigazione |
|---------|-------------|---------|-------------|
| WebGPU non disponibile su Safari mobile | Media | Alto | WebGL 2 fallback renderer (Phase 7+) |
| `SharedArrayBuffer` deprecato o ristretto | Bassa | Critico | Mode C deve restare funzionale come fallback completo |
| Basis Universal transcoder WASM troppo grande (>200KB) | Media | Medio | Lazy loading del transcoder |
| Performance Mode C su mobile mid sotto target | Alta | Alto | Benchmark in Phase 4.5; se fallisce, documentare limiti |
| `device.lost` recovery non funziona su tutti i browser | Media | Alto | Test su Chrome/Firefox/Safari; fallback a page reload |
| Ring buffer 2MB insufficiente per scenari estremi | Bassa | Medio | API per override + warning a >75% utilizzo |
| Buffer GPU 88B/entity troppo grande per mobile | Bassa | Medio | 88B Ã— 100k = 8.4MB â€” nel budget. Monitorare |
| Renderer refactor introduce regressioni visuali | Media | Medio | Screenshot comparison test prima/dopo |
| Scene graph propagation degrada con alberi profondi | Bassa | Medio | Limite depth 32, sorted array, dirty flag globale |
| WASM linear memory non rilasciabile dopo picco | Alta | Medio | Memory pool interno, documentazione limiti |
| MSDF atlas troppo grande per mobile (2048Ã—2048) | Bassa | Medio | Atlas 1024Ã—1024 default, 2048 opt-in. LRU eviction |
| JFA performance insufficiente su GPU mobile | Media | Medio | Ridurre risoluzione JFA a metÃ  (quarter-res, bilinear upsample) |
| WGSL branching divergente con mix di primitive | Media | Medio | Pipeline separate per tipo (zero branching) |
| SoA layout aumenta `writeBuffer` calls (4 vs 1) | Bassa | Basso | 4 Ã— 5Î¼s = 20Î¼s â€” trascurabile |
| Mancanza preprocessore WGSL rende shader verbose | Alta | Medio | `naga_oil` (#import, #ifdef) o template string TS |
| RenderGraph DAG overhead per soli 2 pass | Bassa | Basso | DAG con 2 nodi degenera in sequenza â€” overhead zero |
| erf() non built-in in WGSL | Media | Basso | Approssimazione Abramowitz-Stegun (errore ~1.5Ã—10â»â·) |

---

## 11. Cosa Rimane Fuori (Post-Phase 7)

| CapacitÃ  | ComplessitÃ  | Motivazione per Esclusione | Fase Suggerita |
|----------|------------|---------------------------|----------------|
| BÃ©zier curves (Loop-Blinn) | Media | Use case piÃ¹ ristretto rispetto a linee | Phase 7+ |
| Stencil clip paths | Alta | Stencil buffer management complesso | Phase 7+ |
| GPU particle system | Alta | Ping-pong buffer + spawn/death management | Phase 7+ |
| Bloom (Dual Kawase) | Media | Nice-to-have per giochi, non critico | Phase 7+ |
| Clustered forward lighting | Alta | Esce dallo scope 2D/2.5D | Phase 8+ |
| Shadow mapping (CSM + PCF) | Alta | Dipende da clustered forward | Phase 8+ |
| PBR materials + IBL | Alta | Richiede 3D mesh pipeline completo | Phase 8+ |
| Meshlet rendering | Molto Alta | Ottimizzazione per scene 3D pesanti | Phase 8+ |
| glTF loading | Alta | Dipende da PBR + mesh pipeline | Phase 8+ |
| TAA (Temporal Anti-Aliasing) | Alta | Velocity buffer, jitter, history | Phase 8+ |
| Vello-style compute 2D renderer | Molto Alta | Sistema completo alternativo, non incrementale | Valutazione futura |
| Plugin registry/marketplace | Media | Richiede infrastruttura hosting + discovery | Phase 7+ |
| Plugin DevTools extension | Media | Dipende da DevTools base + plugin system completo | Phase 7+ |
| Plugin hot-reload in sviluppo | Bassa | `engine.unuse()` + `engine.use()` sufficiente, DX improvement | Phase 7+ |
| Plugin GPU error isolation | Media | `device.pushErrorScope()` limitato in WebGPU | Phase 7+ |

---

## 12. Checklist di Validazione

### Phase 4.5

- [ ] SoA layout produce lo stesso rendering visuale attuale (test regressione screenshot)
- [ ] Prefix sum produce risultati corretti su batch da 1, 100, 10k, 100k entitÃ 
- [ ] RenderGraph DAG con 2 nodi produce lo stesso output della sequenza lineare
- [ ] Supervisor rileva heartbeat timeout e degrada correttamente Aâ†’Bâ†’C
- [ ] Backpressure retry queue non perde comandi critici (Spawn/Despawn)
- [ ] Benchmark baseline stabilita su 3 fasce hardware
- [ ] Indirect draw single buffer elimina overhead validazione Dawn
- [ ] RenderGraph supporta addPass/removePass con ricompilazione lazy
- [ ] RenderPrimitiveType range 64–127 documentato e ForwardPass delega correttamente

### Phase 5

- [ ] API pubblica ergonomica e type-safe con zero-knowledge del ring buffer
- [ ] Entity handle pool: 100k spawn+destroy senza GC pause (< 1ms)
- [ ] Scene graph: entitÃ  gerarchiche con propagazione e dirty flag
- [ ] Compact() API funzionale per sessioni long-running
- [ ] device.lost recovery trasparente con reuploading texture
- [ ] `engine.use()`/`unuse()` funzionali con install/cleanup lifecycle
- [ ] Pre-tick/post-tick hooks eseguiti nell’ordine corretto di priorità
- [ ] `.data()` nel builder di entità delega correttamente al plugin storage

### Phase 5.5

- [ ] MSDF text leggibile a zoom 0.5Ã—â€“8Ã— senza artefatti
- [ ] JFA outline visibile, uniforme, e anti-aliased con width 1â€“10px
- [ ] 10k linee renderizzate a 60fps su hardware mid-range
- [ ] Box shadow con blur radius 0â€“100 senza degradazione performance
- [ ] FXAA riduce aliasing senza blurring eccessivo del testo MSDF
- [ ] **100k entitÃ  miste (quad + text + line + gradient) a 60fps su desktop, 20k su mobile**

---

> **Documenti correlati**: *Hyperion Engine v3.0 — Architectural Design Document* (design architetturale), *Plugin System Design — Hyperion Engine* (design completo del sistema plugin con le 5 API di estensione, pattern di plugin previsti, e anti-pattern).
>
> **Prossimo aggiornamento**: Al completamento di Phase 4.5, con risultati dei benchmark SoA vs monolitico, validazione del prefix sum, validazione che RenderGraph supporta addPass/removePass, e decisioni implementative finali.
