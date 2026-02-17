# Revisione Critica — Hyperion Engine v2.1

**Documento:** Architectural Design Document
**Data revisione:** 17 Febbraio 2026
**Issue identificati:** 16 (4 Critici • 9 Alti • 3 Medi)

---

## 1. Valutazione Generale

Il documento dimostra una comprensione profonda dei vincoli della piattaforma web e presenta scelte architetturali ben motivate. Le aree di forza principali sono: la strategia di adaptive multi-threading con graceful degradation, la scelta ragionata di hecs su bevy_ecs per il target WASM, il pipeline di asset decoding tramite API native del browser, e l'isolamento audio via AudioWorklet.

Le aree critiche che richiedono intervento prima o durante lo sviluppo riguardano principalmente: la mancanza di dettagli implementativi chiave (backpressure del Ring Buffer, sizing delle Texture Array, layout dello struct GPU), l'assenza di una strategia di testing, e alcune feature classificate come "future" che dovrebbero essere priorità correnti (KTX2, error recovery, Worker supervision).

---

## 2. Riepilogo per Priorità

| Area | Critici | Alti | Medi | Totale |
|------|---------|------|------|--------|
| Architettura e Threading | 1 | 2 | 0 | 3 |
| Ring Buffer e Comunicazione | 1 | 1 | 0 | 2 |
| ECS e Memory Model | 0 | 1 | 1 | 2 |
| Rendering | 0 | 2 | 1 | 3 |
| Asset Pipeline | 1 | 1 | 0 | 2 |
| Audio | 0 | 0 | 1 | 1 |
| Input e Predictive Layer | 0 | 1 | 0 | 1 |
| Roadmap e Processi | 1 | 1 | 0 | 2 |
| **TOTALE** | **4** | **9** | **3** | **16** |

---

## 3. Architettura e Threading

### ARCH-01 [CRITICO] — Manca strategia di recovery per Worker crash

**Problema:** In Mode A il sistema utilizza tre thread separati (Main, Worker 1/ECS, Worker 2/Render). Il documento non prevede alcun meccanismo di supervisione, restart o degradazione dinamica se un Worker termina inaspettatamente. In un contesto browser, i Worker possono morire per out-of-memory, eccezioni non catturate, o tab throttling. Un crash di Worker 2 lascerebbe l'applicazione in uno stato inconsistente senza feedback all'utente.

**Raccomandazione:** Implementare un Worker Supervisor sul Main Thread che monitora heartbeat dai Worker via Ring Buffer. In caso di timeout o error event, il Supervisor tenta un restart del Worker. Se il restart fallisce, degradare dinamicamente (Mode A → Mode B → Mode C) con notifica allo sviluppatore via callback. Definire il protocollo di recovery in Phase 0.

**Fase impattata:** Phase 0 (Scaffold & Execution Harness)

---

### ARCH-02 [ALTO] — Budget entità Mode C non validato per hardware target

**Problema:** Il documento afferma che Mode C è "viable for scenes under ~10k entities at 60fps" senza specificare su quale hardware. Su dispositivi mobile mid-range, 10k entità con compute culling + ECS tick + rendering su un singolo thread del Main potrebbe già causare frame drop significativi, specialmente con garbage collection pressure.

**Raccomandazione:** Definire benchmark target per almeno tre fasce hardware (mobile low, mobile mid, desktop). Eseguire test di performance reali in Phase 0 con un prototipo minimale per validare i budget di entità dichiarati. Documentare i risultati come reference per gli sviluppatori consumatori dell'engine.

**Fase impattata:** Phase 0 (Scaffold & Execution Harness)

---

### ARCH-03 [ALTO] — Deployment requirements insufficientemente documentati

**Problema:** COOP/COEP headers sono menzionati come requisito ma non esiste una sezione dedicata ai vincoli di deployment. Molte piattaforme di hosting comuni (GitHub Pages, Netlify con configurazione default, alcuni CDN) non settano questi header. Sviluppatori che consumano l'engine potrebbero non capire perché Mode A/B non si attivano.

**Raccomandazione:** Creare una sezione dedicata "Deployment Guide" con: header HTTP necessari, configurazione per i principali hosting (Vercel, Netlify, Cloudflare Pages, GitHub Pages via _headers file), e un dev server preconfigurato con COOP/COEP abilitati. Rendere prominente nella documentazione di Phase 0.

**Fase impattata:** Phase 0 + Phase 7 (Documentation)

---

## 4. Ring Buffer e Comunicazione

### RING-01 [CRITICO] — Strategia di backpressure non definita

**Problema:** Il Ring Buffer è descritto come lock-free MPSC su SharedArrayBuffer con dimensione statica, ma il documento non specifica il comportamento quando il buffer si riempie. Le tre opzioni (drop comandi, bloccare il producer, sovrascrivere) hanno impatti radicalmente diversi sul gameplay: comandi persi significano input persi, bloccare il producer causa stutter sul Main Thread, sovrascrivere corrompe lo stato.

**Raccomandazione:** Definire esplicitamente la policy di backpressure. Raccomandazione: implementare un "drop with warning" — se il buffer è pieno, i nuovi comandi vengono droppati e un contatore di overflow viene incrementato atomicamente. Il Main Thread può leggere il contatore e loggare un warning. Dimensionare il buffer con margine 4x rispetto al throughput atteso. Documentare il dimensionamento nel design doc.

**Fase impattata:** Phase 0 (Ring Buffer implementation)

---

### RING-02 [ALTO] — Overhead DataView su hot path

**Problema:** L'uso di DataView per endianness safety è corretto ma potenzialmente costoso. DataView è significativamente più lento di typed array views (Float32Array, Uint32Array) in benchmark su hot paths. Il 99.9% dei dispositivi target è little-endian, rendendo il costo aggiuntivo inutile nella quasi totalità dei casi.

**Raccomandazione:** Implementare un fast path con typed array views e un runtime check all'inizializzazione: se l'architettura è little-endian (verificabile con `new Uint8Array(new Uint32Array([1]).buffer)[0] === 1`), usare typed arrays direttamente. Mantenere il fallback DataView per architetture big-endian. Questa è un'ottimizzazione da applicare in Phase 0.

**Fase impattata:** Phase 0 (Ring Buffer implementation)

---

## 5. ECS e Memory Model

### ECS-01 [ALTO] — trait World potrebbe non reggere migrazioni a ECS con storage model diverso

**Problema:** Il migration path tramite `trait World` è un'astrazione che dovrà coprire le differenze semantiche tra ECS basati su archetype (hecs, bevy_ecs) e quelli basati su sparse sets (flecs-rs). Queste differenze sono fondamentali e influenzano le API di query, iterazione, e storage. Un trait generico rischia di diventare un leaky abstraction o di richiedere riscrittura completa al momento della migrazione.

**Raccomandazione:** Documentare esplicitamente nel design doc quali operazioni il `trait World` deve supportare e quali no. Definire un'interfaccia minimale (spawn, despawn, query by component type, add/remove component) e dichiarare come "out of scope" le feature specifiche di storage model (e.g., parallel iteration di bevy_ecs). Questo evita false aspettative di portabilità.

**Fase impattata:** Phase 1 (ECS Core)

---

### ECS-02 [MEDIO] — Strategia per componenti con comportamento variabile non esplicitata

**Problema:** La regola "No `dyn Trait` in components" è corretta per performance ma il documento non specifica come gestire componenti con varianti multiple (diversi tipi di collider, diversi stati AI, diversi effetti particellari). Se la risposta è "un componente enum per ogni variante", questa decisione architetturale va documentata perché influenza il design di tutti i sistemi.

**Raccomandazione:** Aggiungere al documento una sezione "Component Design Patterns" che espliciti: uso di enum per varianti limitate e note a compile-time, uso di marker components per pattern strategy, e approccio consigliato per comportamenti dinamici. Fornire almeno un esempio concreto (e.g., collider variants).

**Fase impattata:** Phase 1 (ECS Core)

---

## 6. Rendering

### REND-01 [ALTO] — Texture2DArray: vincolo di dimensione uniforme non documentato

**Problema:** La scelta di Texture2DArray su texture atlas è ben argomentata, ma tutte le texture in un array devono avere dimensioni identiche. Il documento non menziona come gestire sprite con risoluzioni diverse. Questo è un vincolo hardware fondamentale che, se non affrontato, renderebbe il sistema inutilizzabile per la maggior parte dei giochi reali.

**Raccomandazione:** Documentare la strategia di gestione: array multipli raggruppati per fascia di dimensione (e.g., 64x64, 128x128, 256x256, 512x512), con padding opzionale per texture che non rientrano esattamente. Specificare il numero massimo di array e il criterio di allocazione. Implementare in Phase 4 con il Texture Array system.

**Fase impattata:** Phase 3–4 (GPU-Driven Pipeline + Asset Pipeline)

---

### REND-02 [ALTO] — Layout struct GPU da 64 byte non specificato

**Problema:** Il budget di 64 byte per entità nello Storage Buffer è dichiarato ma il layout esatto non è documentato. Considerando: posizione (vec3, 12B), rotazione (quat, 16B), scala (vec3, 12B), texture layer index (u32, 4B), color tint (vec4, 16B), entity ID (u32, 4B), visibility flags (u32, 4B) = 68 byte senza padding. Con allineamento WGSL a 16 byte, il budget potrebbe non bastare.

**Raccomandazione:** Definire il layout esatto dello struct nel design document con annotazioni di allineamento WGSL. Questo è un contratto tra ECS e GPU che va fissato prima dell'implementazione. Valutare se 80 byte (5×16B) è un budget più realistico, aggiornando di conseguenza i calcoli di VRAM budget (80B × 100k = 8MB, ancora ampiamente nel budget).

**Fase impattata:** Phase 3 (GPU-Driven Pipeline)

---

### REND-03 [MEDIO] — Bindless textures rinviato ma parzialmente disponibile

**Problema:** Il documento rimanda le bindless textures alla maturazione dello standard WebGPU, ma l'estensione `texture_binding_array` è già disponibile in Chrome e Edge. Pianificarla come enhancement opzionale non richiede di aspettare la standardizzazione completa e potrebbe migliorare significativamente le performance su browser che la supportano.

**Raccomandazione:** Aggiungere come enhancement opzionale in Phase 3 con feature detection a runtime. Se l'estensione è disponibile, usarla; altrimenti fallback a Texture2DArray. Questo non blocca lo sviluppo ma prepara il terreno.

**Fase impattata:** Phase 3 (GPU-Driven Pipeline)

---

## 7. Asset Pipeline

### ASSET-01 [CRITICO] — Nessuna strategia di loading management

**Problema:** Il flusso `fetch → Blob → createImageBitmap → copyExternalImageToTexture` è corretto per singoli asset, ma manca completamente una strategia per il caricamento su scala. Per un engine generico, 200+ sprite caricati in parallelo senza limiti di concorrenza possono saturare la rete, esaurire la memoria, e causare jank durante il gameplay. Non esiste menzione di priorità, code di caricamento, streaming progressivo, o loading screen.

**Raccomandazione:** Aggiungere al design una sezione Asset Loading Manager che definisca: limite di concorrenza sui fetch (suggerito: 6–8 paralleli), sistema di priorità (asset visibili > asset fuori frustum > prefetch), callback per progress tracking (loading screen), e strategia di caching (Cache API del browser o IndexedDB per asset già scaricati). Implementare in Phase 4.

**Fase impattata:** Phase 4 (Asset Pipeline & Textures)

---

### ASSET-02 [ALTO] — KTX2/Basis Universal classificato come future ma necessario per il target di 100k entità

**Problema:** KTX2/Basis Universal è l'unico modo per avere texture compresse in VRAM (riduzione 4–8x della GPU memory). Con texture non compresse, 100k entità con sprite 256x256 RGBA consumerebbero ~25GB di VRAM, rendendo il target dichiarato irrealistico senza compressione. Classificare questa feature come "future" è incongruente con gli obiettivi del documento.

**Raccomandazione:** Riclassificare KTX2/Basis Universal da "future" a deliverable di Phase 4. La compressione GPU-nativa è un prerequisito per raggiungere gli obiettivi di scala dichiarati. Valutare l'uso di `basis_universal-rs` come transcoder WASM.

**Fase impattata:** Phase 4 (Asset Pipeline & Textures)

---

## 8. Audio

### AUDIO-01 [MEDIO] — Build system per doppio binario WASM non specificato

**Problema:** Il design prevede due binari WASM separati (engine principale + audio DSP dedicato per AudioWorklet) ma non menziona come il build system gestisce questa dualità. Due crate WASM con target e ottimizzazioni diverse richiedono un workspace Cargo strutturato, script di build coordinati, e potenzialmente toolchain diversi.

**Raccomandazione:** Specificare nel documento: struttura del workspace Cargo (workspace root con crate `engine-core` e crate `audio-dsp`), profili di build separati per i due target, e script di build che coordini wasm-pack per entrambi. Documentare in Phase 0, implementare in Phase 6.

**Fase impattata:** Phase 0 + Phase 6 (Audio & Input)

---

## 9. Input e Predictive Layer

### INPUT-01 [ALTO] — Riconciliazione con exponential smoothing può produrre artefatti visibili

**Problema:** Il sistema di shadow state usa exponential smoothing per riconciliare lo stato predetto con quello autoritativo. Questo può causare "sliding" visibile del personaggio verso la posizione corretta, specialmente con discrepanze significative tra modello semplificato e modello autoritativo. Inoltre, il "simplified movement model" dello shadow state è una duplicazione di logica che può divergere dal modello principale nel tempo.

**Raccomandazione:** Valutare alternative: dead reckoning con rollback (più complesso ma più preciso), o threshold-based snap (se la differenza è sotto una soglia, snap immediato; sopra, interpola). Per la duplicazione di logica, considerare di estrarre le costanti di movimento in una shared config consumata sia dal modello completo che dallo shadow state. Documentare la scelta e i tradeoff.

**Fase impattata:** Phase 6 (Audio & Input)

---

## 10. Roadmap e Processi

### ROAD-01 [CRITICO] — Assenza completa di strategia di testing

**Problema:** Il documento non menziona come testare un engine con 3 execution mode, 2 binari WASM, comunicazione asincrona via Ring Buffer, e GPU compute. Senza una strategia di test definita, bug nell'interazione tra i componenti emergeranno tardi e saranno costosi da diagnosticare. La combinatoria dei mode (A/B/C) moltiplica il rischio.

**Raccomandazione:** Aggiungere una sezione Testing Strategy con almeno: unit test Rust puri per ECS e Ring Buffer logic (`cargo test`), integration test per il protocollo Ring Buffer (producer/consumer in contesto WASM), test di rendering headless tramite wgpu in modalità software (senza GPU, per CI), benchmark automatizzati per regression di performance con threshold definiti, e test matrix per i tre execution mode. Definire in Phase 0, implementare progressivamente.

**Fase impattata:** Phase 0 (trasversale a tutte le fasi)

---

### ROAD-02 [ALTO] — Stime temporali e sezioni documentali mancanti

**Problema:** La roadmap ha 7 fasi senza stime temporali, rendendo impossibile valutare la fattibilità del progetto. Inoltre mancano sezioni cruciali: error handling strategy (WebGPU `device.lost`, shader compilation errors), serialization/save state (come fare snapshot dell'ECS da un Worker), e almeno un accenno a networking/multiplayer (che influenzerebbe il design del tick loop per determinismo).

**Raccomandazione:** Aggiungere stime rough (in settimane) per ogni fase. Aggiungere le sezioni mancanti: Error Recovery (gestione `device.lost`, shader errors, OOM), State Serialization (protocollo per snapshot/restore dello stato ECS attraverso il confine Worker), e un paragrafo Networking Considerations che documenti le decisioni di design che preservano o precludono il determinismo del tick loop.

**Fase impattata:** Documento di design (aggiornamento immediato)

---

## 11. Mappa Impatto per Fase di Sviluppo

| Fase | Issue Correlati | Rischio |
|------|----------------|---------|
| Phase 0 | ARCH-01, ARCH-02, ARCH-03, RING-01, ROAD-01 | **Molto Alto** |
| Phase 1 | ECS-01, ECS-02, RING-01 | **Alto** |
| Phase 2 | ARCH-03, REND-02, ROAD-02 | **Alto** |
| Phase 3 | REND-01, REND-02, REND-03 | Medio |
| Phase 4 | ASSET-01, ASSET-02 | **Alto** |
| Phase 5 | ECS-01, ROAD-02 | Medio |
| Phase 6 | AUDIO-01, INPUT-01 | Medio |
| Phase 7 | ROAD-01, ROAD-02 | Basso |

---

## 12. Azioni Immediate Raccomandate

Le seguenti azioni dovrebbero essere completate prima di iniziare l'implementazione:

- Definire la policy di backpressure del Ring Buffer e documentare il dimensionamento (RING-01)
- Progettare il Worker Supervisor con protocollo di heartbeat e degradazione dinamica (ARCH-01)
- Specificare il layout esatto dello struct GPU con annotazioni di allineamento WGSL (REND-02)
- Definire la strategia di testing con test matrix per i tre execution mode (ROAD-01)
- Riclassificare KTX2/Basis Universal da "future" a Phase 4 deliverable (ASSET-02)
- Aggiungere stime temporali rough alla roadmap e le sezioni mancanti (ROAD-02)
- Eseguire benchmark Mode C su hardware target per validare il budget entità (ARCH-02)
