# Hyperion Engine — Piano di Sviluppo Completo

> **Versione**: 1.2 — Documento Unificato
> **Data**: 27 Febbraio 2026
> **Stato progetto**: v0.14.0 — Phase 0–9 + Phase 4b + Phase 10a + Phase 10b completate, Phase 10c prossima
> **Test**: 102 test Rust (7 moduli, con dev-tools) + 493 test TypeScript (50 file)
> **Scope**: Dalla visione fondativa all'ultimo dettaglio implementativo — passato, presente e futuro

---

## PARTE I — FONDAMENTA

---

## 1. Vision e Identità

### 1.1 Il Problema che Hyperion Risolve

Il web nel 2026 ha un gap infrastrutturale: non esiste un motore grafico universale che serva contemporaneamente chi sviluppa giochi, chi costruisce applicazioni professionali con canvas interattivi, e chi integra rendering avanzato in shell desktop. Le soluzioni esistenti servono ciascun caso singolarmente — nessuna copre tutti e tre partendo dalle stesse fondamenta.

Chi costruisce un gioco 2D web sceglie tra Phaser, PixiJS, PlayCanvas. Chi costruisce un canvas professionale tipo Figma o Miro riscrive il rendering da zero. Chi integra visualizzazioni complesse in Electron o Tauri si scontra con i limiti di SVG e Canvas 2D. Tre comunità con bisogni sovrapposti che risolvono gli stessi problemi — gestione efficiente di decine di migliaia di elementi, rendering GPU-accelerato, input multimodale, lifecycle delle risorse — ciascuna per conto proprio.

### 1.2 La Tesi Centrale

Un motore grafico web costruito su ECS in Rust/WASM, con rendering WebGPU e comunicazione inter-thread via ring buffer binario, può servire i tre mercati — gaming, canvas professionali, desktop embedding — con performance native e zero compromessi architetturali, a patto che ogni astrazione sia opt-in e che il costo di ciò che non si usa sia letteralmente zero.

Tre osservazioni tecniche fondano questa tesi:

- **WebGPU** ha chiuso il gap tra rendering web e nativo. Compute shader, storage buffer, render pass multipli — le stesse primitive dei motori desktop.
- **WASM** ha reso praticabile la simulazione ad alta performance nel browser. Un ECS in Rust raggiunge throughput comparabili al codice nativo per workload data-oriented.
- **SharedArrayBuffer + Web Workers** hanno abilitato il true multi-threading nel browser. Comunicazione lock-free via ring buffer atomico con latenze paragonabili ad applicazioni native.

### 1.3 Cosa Hyperion È e Cosa Non È

Hyperion è una **primitiva di rendering** — un livello di astrazione tra le API browser e il codice applicativo. Non è un game engine completo con editor visuale. Non è un framework UI. Non è un sostituto di React o Svelte. Non compete con Unity o Godot.

È la fondazione su cui si costruiscono game engine, canvas professionali, e visualizzatori integrati. Lo sviluppatore lo integra nel suo stack, non costruisce il suo stack intorno ad esso.

### 1.4 I Tre Mercati Target

**Game Engine 2D/2.5D**: Decine di migliaia di sprite, particle system, collisioni, input polling, audio spazializzato. Target: 100k entità a 60fps desktop, 20k a 60fps mobile. Competitori: PixiJS (renderer puro, no ECS), Phaser (single-thread, WebGL 1).

**Application Rendering (Canvas Professionali)**: Sessioni di ore, entità che fluttuano, primitive vettoriali (linee, curve, testo SDF), zoom/pan, hit testing, latenza drag < 33ms. Competitori: renderer proprietari (Figma, Miro — non riutilizzabili), Canvas 2D con ottimizzazioni custom.

**Desktop Embedding (Electron/Tauri)**: Hybrid dei primi due, performance desktop, sessioni lunghe. SharedArrayBuffer sempre disponibile = sempre Mode A. Embeddabile in un `<div>`, lifecycle esplicito, binary WASM compatto.

### 1.5 Posizionamento Competitivo

Hyperion si posiziona tra PixiJS (maturo ma limitato architetturalmente) e i renderer proprietari (performanti ma non riutilizzabili). Il vantaggio non è una singola feature — è l'architettura: un motore costruito da zero su WebGPU + WASM + multi-thread ha un ceiling di performance strutturalmente superiore a uno che ha aggiunto queste tecnologie come afterthought.

---

## 2. Principi Guida Non Negoziabili

1. **Il motore è una primitiva, non un framework.** Nessuna opinione su come l'applicazione è strutturata. Nessuna dipendenza transitiva. Nessun global state.
2. **Non paghi per ciò che non usi.** Ogni feature è opt-in. Il costo base è il minimo indivisibile.
3. **L'applicazione non muore mai.** Degradazione, non crash. Se il Worker muore, degrada. Se la GPU viene reclamata, ricostruisci. Se il buffer è pieno, accoda.
4. **Le performance si misurano, non si assumono.** Ogni claim è supportato da benchmark riproducibili.
5. **L'API è quasi irreversibile.** Dopo il primo utente esterno, ogni cambio è breaking. Le decisioni si prendono una volta, con cura.
6. **Open source è infrastruttura, closed source è prodotto.** Il motore non contiene mai logica specifica per un prodotto.
7. **La complessità accidentale è il nemico.** Ogni indirezione ha un costo cognitivo. Ogni astrazione si guadagna la propria esistenza.

---

## 3. Vincoli Architetturali

| Vincolo | Motivazione | Impatto sulle Decisioni |
|---------|------------|------------------------|
| **Zero dipendenze runtime TS** | L'engine è una primitiva — chi lo integra non vuole transitive deps | Tutto internal, nessuna libreria TS |
| **Binary WASM < 200KB gzipped** | 200KB ≈ 65ms download su 3G. Ogni KB conta per il first paint | hecs su bevy_ecs, niente wgpu compilato |
| **Nessun GC pressure nel game loop** | App professionali girano per ore — GC pauses = micro-jank | Object pooling, pre-allocated buffers, zero alloc nel hot path |
| **Graceful degradation obbligatoria** | Un'app Figma-like non può crashare se il Worker muore | Supervisor, heartbeat, degradazione A→B→C |
| **API ergonomica e type-safe** | Gli sviluppatori non vogliono manipolare ring buffer | Facade API che nasconde il protocollo binario |
| **Embeddabile** | L'engine deve funzionare in un `<div>` qualsiasi | Nessun global state, canvas injection, lifecycle esplicito |
| **Estensibile via plugin** | Terze parti devono poter estendere senza ricompilare WASM | Due livelli: Rust chiuso (core), TS aperto (plugin) |

---

## 4. Architettura di Alto Livello

### 4.1 Stack Tecnologico

| Dipendenza | Scopo | Motivazione |
|---|---|---|
| **Rust** (edition 2024, `wasm-bindgen`) | Core WASM | Sicurezza memoria senza GC, compilazione WASM con overhead minimo |
| **`hecs`** 0.11 | ECS | Binary footprint minimo (~50KB vs ~200KB di `bevy_ecs`). `bevy_ecs` perde il parallelismo su WASM (fallback single-thread) aggiungendo solo bloat |
| **`glam`** 0.29 (feat: `bytemuck`) | Matematica 3D | SIMD-accelerated, layout `repr(C)`, zero-cost GPU upload via `bytemuck` |
| **`bytemuck`** 1.x (feat: `derive`) | Cast sicuro struct↔byte | Componenti ECS `Pod + Zeroable` per upload GPU senza copie |
| **TypeScript** (ES2022, strict) | Browser integration | Type safety per API, moduli ESM nativi |
| **Vite** 7.x | Dev server + bundler | Hot reload, Worker ESM nativo, header COOP/COEP |
| **`vitest`** 4.x | Test runner TS | Compatibile con SharedArrayBuffer e Atomics |
| **`@webgpu/types`** | Type definitions WebGPU | Type declarations per `GPUDevice`, `GPURenderPipeline`, ecc. |
| **`wasm-pack`** | Build pipeline Rust→WASM | JS glue + `.wasm` binary + `.d.ts` in un comando |

### 4.2 Command Buffer Architecture

Il principio architetturale fondamentale è la separazione tra mutazioni e simulazione attraverso un protocollo binario su memoria condivisa. TypeScript non chiama mai funzioni WASM per singole mutazioni. Serializza comandi in un ring buffer che Rust consuma in batch all'inizio di ogni frame.

```
TypeScript (Main Thread)            SharedArrayBuffer              Rust/WASM (Worker)
+-------------------------+    +----------------------------+    +-------------------------+
| RingBufferProducer      |    | [write_head][read_head]    |    | RingBufferConsumer      |
|   .spawnEntity(id)      |--->| [capacity  ][padding    ]  |--->|   .drain()              |
|   .setPosition(id,x,y,z)|    | [cmd|eid|payload|cmd|...]  |    |                         |
|   .despawnEntity(id)    |    +----------------------------+    | process_commands()      |
+-------------------------+                                      | Engine.update(dt)       |
                                                                 +-------------------------+
```

Questo elimina: overhead FFI per-call (riduce il crossing a uno per frame) e invalidazione delle viste (il ring buffer vive su SharedArrayBuffer statico, separato dalla memoria WASM).

### 4.3 Tre Modi di Esecuzione

**Mode A — Full Isolation (Ottimale)**: Richiede SharedArrayBuffer + OffscreenCanvas + WebGPU in Worker. Main Thread (UI/Input) → Worker 1 (ECS/WASM) → Worker 2 (Render/WebGPU). Ring Buffer SPSC su SharedArrayBuffer.

**Mode B — Partial Isolation (Firefox)**: Richiede SharedArrayBuffer + WebGPU su Main Thread. Main Thread (UI + Render) → Worker 1 (ECS/WASM). Ring Buffer per comandi, `postMessage` per render state.

**Mode C — Single Thread (Fallback)**: Solo WebGPU su Main Thread. Esegue tutto sequenzialmente. Viabile per scene sotto ~10k entità a 60fps.

**Mode C senza WebGPU — Simulation Only**: ECS/WASM gira comunque, rendering disabilitato. Futuro: fallback WebGL 2 o Canvas 2D.

### 4.4 Worker Supervisor e Degradazione Dinamica

In Modes A e B, un **Worker Supervisor** con heartbeat atomico sul SharedArrayBuffer monitora la salute dei Worker. Tre heartbeat mancati consecutivi (~3 secondi) triggerano recovery: `worker.terminate()`, flush del ring buffer, tentativo di restart, eventuale degradazione al mode inferiore.

```
SharedArrayBuffer Layout (header 32 bytes):
Offset 0-15:   Ring Buffer header (write_head, read_head, capacity, padding)
Offset 16-19:  heartbeat_counter Worker 1 (u32, atomic)
Offset 20-23:  heartbeat_counter Worker 2 (u32, atomic)
Offset 24-27:  supervisor_flags (u32, atomic)
Offset 28-31:  reserved
Offset 32+:    Ring Buffer data region (default 2MB)
```

### 4.5 GPU Buffer Layout — Structure of Arrays (SoA)

4 buffer GPU separati anziché struct monolitico, per partial update efficiente e cache-friendly compute culling:

| Buffer | Contenuto | Size/entity | Binding |
|--------|-----------|-------------|---------|
| A — Transform | mat4x4f | 64 byte | @group(0) @binding(1) |
| B — BoundingSphere | vec4f (center + radius) | 16 byte | @group(0) @binding(2) |
| C — RenderMeta | meshHandle + renderPrimitive (packed vec2u) | 8 byte | @group(0) @binding(3) |
| D — PrimParams | 8 f32 parametri primitiva | 32 byte | @group(0) @binding(4) |

Totale: 120 byte/entity (con 88 byte attivi). DirtyTracker con BitSet per-buffer, threshold 30% per partial vs full upload.

### 4.6 RenderGraph DAG

Il renderer è organizzato come DAG (Directed Acyclic Graph) di pass con resource lifetime management e dead-pass culling. Il grafo compila l'ordine di esecuzione tramite topological sort sulle dipendenze reads/writes.

```
Pipeline attuale:
[Compute Cull] → [Forward Render] → [Selection Seed?] → [JFA ×10?] → [Outline Composite?] → [FXAA/Tonemap?] → [Bloom?]

Dove ? = pass opzionale con dead-pass culling se non attivo.
```

Il RenderGraph supporta `addPass()`/`removePass()` con ricompilazione lazy — fondamentale per il plugin system.

### 4.7 Bind Group Layout

| Group | Scopo | Contenuto |
|-------|-------|-----------|
| 0 | Frame-level | Camera VP, entity buffers SoA, frame uniforms |
| 1 | Entity-level | Instance data, draw indirect buffer |
| 2 | Material | Texture2DArray, sampler, atlas metadata |
| 3 | **Plugin reserved** | Layout definito dal plugin al momento della registrazione |

---

## PARTE II — FASI COMPLETATE

---

## 5. Phase 0–4: Fondamenta (✅ Completate)

### Deliverable Complessivi

Project structure, COOP/COEP dev server, capability detection, adaptive mode selection (A/B/C), SharedArrayBuffer Ring Buffer, Web Worker instantiation, `hecs` integration, SoA components, transform system, spatial hashing, deterministic tick loop, command buffer consumption, wgpu initialization, OffscreenCanvas transfer, basic draw pipeline, debug overlay, WGSL compute culling, Storage Buffer layout, indirect draw, Texture2DArray system, `createImageBitmap` flow, Texture Array packing.

---

## 6. Phase 4.5: Stabilizzazione e Fondamenta Architetturali (✅ Completata)

**Durata prevista**: 4–5 settimane

### Deliverable

- Worker Supervisor + heartbeat atomico con 3 missed = recovery
- Backpressure retry queue per comandi critici (Spawn/Despawn)
- TypedArray fast path per upload
- TextureManager con lazy allocation
- **SoA buffer layout** — 4 buffer separati (Transform, Bounds, RenderMeta, PrimParams)
- **MeshHandle + RenderPrimitive** — componenti ECS con range 0–31 core, 32–63 extended, 64–127 plugin
- `writeBuffer` come upload esclusivo
- **RenderGraph DAG** con resource lifetime, dead-pass culling, addPass/removePass
- **Indirect draw single buffer** — fix Dawn 300× validazione
- **Prefix sum (Blelloch)** + stream compaction — compute shader riutilizzabile
- Scene graph opt-in design (Parent/Children/LocalMatrix)
- Memory compaction design (compact() API)
- Bind Group 3 documentato per plugin
- Benchmark suite + test matrix su 3 fasce hardware

### Validazione Phase 4.5

- [x] SoA layout produce lo stesso rendering visuale (test regressione screenshot)
- [x] Prefix sum corretto su batch da 1, 100, 10k, 100k entità
- [x] RenderGraph DAG con 2 nodi = stesso output della sequenza lineare
- [x] Supervisor rileva heartbeat timeout e degrada A→B→C
- [x] Backpressure retry queue non perde comandi critici
- [x] Benchmark baseline stabilita su 3 fasce hardware
- [x] Indirect draw single buffer elimina overhead Dawn
- [x] RenderGraph supporta addPass/removePass con ricompilazione lazy
- [x] RenderPrimitiveType range 64–127 documentato e ForwardPass delega

---

## 7. Phase 5: TypeScript API & Lifecycle (✅ Completata)

**Durata prevista**: 4–6 settimane

### Deliverable

- API pubblica facade ergonomica e type-safe con zero-knowledge del ring buffer
- Entity handle pooling: 100k spawn+destroy senza GC pause
- `dispose()` + `using` (TC39 Explicit Resource Management)
- Scene graph opt-in con propagazione e dirty flag
- Dirty-flag partial upload
- `compact()` API per sessioni long-running
- `device.lost` recovery trasparente con texture re-upload
- Error handling strutturato
- `HyperionConfig.plugins` field
- `engine.use()`/`unuse()` stubs
- `engine.plugins` namespace con has/get/list
- `.data()` nel builder di entità per plugin storage
- Pre-tick/post-tick hooks nel game loop
- CommandType range 64–127 riservato per plugin

### Validazione Phase 5

- [x] API pubblica ergonomica e type-safe
- [x] Entity handle pool: 100k spawn+destroy senza GC pause (< 1ms)
- [x] Scene graph: entità gerarchiche con propagazione e dirty flag
- [x] Compact() API funzionale per sessioni long-running
- [x] device.lost recovery trasparente
- [x] `engine.use()`/`unuse()` funzionali con install/cleanup lifecycle
- [x] Pre-tick/post-tick hooks eseguiti nell'ordine corretto di priorità
- [x] `.data()` nel builder delega correttamente al plugin storage

---

## 8. Phase 5.5: Rendering Primitives (✅ Completata)

**Durata prevista**: 5–6 settimane

### Deliverable — 5 Primitive di Rendering Core

**1. MSDF Text Rendering**
- Atlas MSDF con shelf packing (1024×1024 default, 2048 opt-in)
- Fragment shader: `median(r, g, b)` + screen-pixel-range scaling anti-aliasing
- Ogni glyph = un instanced quad, blocco di testo = singolo draw call per atlas page
- LRU eviction per font con character set ampi
- Leggibile a zoom 0.5×–8× senza artefatti

**2. JFA Selection Outlines**
- Jump Flood Algorithm per outlines uniformi e anti-aliased
- Selection seed pass → 10 JFA pass → Outline composite
- Width configurabile 1–10px
- Mutuamente esclusivo con Bloom (entrambi scrivono su swapchain)

**3. Instanced Line Rendering**
- Screen-space expansion: ogni segmento = instanced quad espanso perpendicolarmente
- Caps (round/square) e joins (miter/round/bevel)
- Dash pattern via SDF
- 10k linee a 60fps su hardware mid-range

**4. Gradients + SDF Box Shadows**
- Gradienti lineari/radiali via 1D LUT texture con interpolazione hardware
- Box shadow O(1) per pixel via Evan Wallace SDF technique (erf approximation Abramowitz-Stegun)
- Blur radius 0–100 senza degradazione performance

**5. FXAA + Tonemapping**
- FXAA (Lottes, NVIDIA) come post-process pass
- PBR Neutral tonemapping (Khronos) come default
- ACES filmic come alternativa
- FXAA riduce aliasing senza blurring eccessivo del testo MSDF

### RenderPrimitiveType Enum

```rust
#[repr(u8)]
pub enum RenderPrimitiveType {
    Quad = 0,           // Phase 4 — quad texture base
    Line = 1,           // Phase 5.5 — linee con spessore
    SDFGlyph = 2,       // Phase 5.5 — testo MSDF
    BezierPath = 3,     // Phase 9 — curve vettoriali
    Gradient = 4,       // Phase 5.5 — fill gradiente
    BoxShadow = 5,      // Phase 5.5 — ombre SDF
    // 6–31: Core reserved
    // 32–63: Extended reserved
    // 64–127: Plugin reserved
}
```

### Validazione Phase 5.5

- [x] MSDF text leggibile a zoom 0.5×–8× senza artefatti
- [x] JFA outline visibile, uniforme, anti-aliased con width 1–10px
- [x] 10k linee a 60fps su hardware mid-range
- [x] Box shadow con blur 0–100 senza degradazione
- [x] FXAA riduce aliasing senza blurring eccessivo del testo
- [x] 100k entità miste (quad + text + line + gradient) a 60fps desktop, 20k mobile

---

## 9. Phase 6: Input & Audio (✅ Completata)

**Durata prevista**: 3–4 settimane

### Deliverable

- Input buffering + shared state
- GPU-based picking (Color ID)
- CPU ray-sphere picking come fallback
- Immediate mode + dead reckoning per interazioni fluide
- AudioWorklet isolation (audio in Worker dedicato)
- Spatial audio system
- Dual WASM binary (Cargo workspace con crate audio separata)

---

## 10. Phase 7: Polish & DX (✅ Completata)

**Durata prevista**: 4–5 settimane

### Deliverable

- **Shader hot-reload** con Vite HMR integration (10 file WGSL con handler `import.meta.hot.accept()`)
- Dev watch mode
- Performance profiler (ProfilerOverlay DOM-based)
- Deployment guide (7 piattaforme)
- Documentazione

---

## 11. Phase 8: Plugin System & Advanced Infrastructure (✅ Completata)

### Deliverable

**Plugin System v2 — PluginContext Architecture**

Sostituisce l'interfaccia plugin semplice (`install(engine)`) con un sistema basato su `PluginContext` — oggetto strutturato con 5 sotto-API:

| Sub-API | Classe | Scopo |
|---------|--------|-------|
| `ctx.systems` | `PluginSystemsAPI` | `addPreTick`/`removePreTick`, `addPostTick`/`removePostTick`, `addFrameEnd`/`removeFrameEnd` |
| `ctx.events` | `PluginEventAPI` | `on`/`off`/`once`/`emit` — pub/sub tipizzato via EventBus condiviso |
| `ctx.rendering` | `PluginRenderingAPI` | `addPass`/`removePass` — gestione pass nel RenderGraph |
| `ctx.gpu` | `PluginGpuAPI` | `device`, `createBuffer`/`createTexture`/`destroyTracked` — risorse GPU tracciate |
| `ctx.storage` | `PluginStorageAPI` | `createMap<T>`/`getMap<T>`/`destroyAll` — side-table per entity data |

**Dependency Resolution**: verifica che tutte le dipendenze siano installate prima di procedere. **Error Boundaries**: try/catch su install e cleanup, isolamento dei fallimenti. **EventBus**: pub/sub minimale per comunicazione inter-plugin senza accoppiamento diretto.

**Shader Hot-Reload** avanzato: `recompileShader(passName, shaderCode)` con `rebuildGraph()` completo. Tutti i file WGSL hanno HMR via Vite.

**Performance Profiler**: ProfilerOverlay DOM-based con FPS, entity count, frame timing, mode. Posizionamento configurabile. `Hyperion.enableProfiler(config?)` / `disableProfiler()`.

---

## PARTE III — COMPLETATE (RECENTI)

---

## 12. Phase 9: Advanced 2D Rendering (✅ Completata)

Phase 9 aggiunge tre feature avanzate di rendering suddivise in tre track paralleli.

### Track A — Quadratic Bézier SDF

Rendering delle curve Bézier quadratiche tramite distanza SDF analitica (algoritmo Inigo Quilez). Punti di controllo in spazio UV [0,1]² relativo al quad. Anti-aliasing con `smoothstep()` + `fwidth()`.

**PrimParams Layout Bézier**: p0x, p0y, p1x, p1y, p2x, p2y, width, _pad (8 f32 = 32 byte)

**API**: `EntityHandle.bezier(p0x, p0y, p1x, p1y, p2x, p2y, width)` → imposta `RenderPrimitiveType.BezierPath` (3).

### Track B — Dual Kawase Bloom

Pipeline a 6 sub-pass:
1. **Extract** — pixel luminosi con soglia configurabile
2. **Downsample 1** — scene-hdr → bloom-half (Kawase 4-tap)
3. **Downsample 2** — bloom-half → bloom-quarter
4. **Upsample 1** — bloom-quarter → bloom-half (Kawase 9-tap tent)
5. **Upsample 2** — output bloom contribution
6. **Composite** — scene + bloom additivo + tonemapping

Texture intermedie `rgba16float`: bloom-half, bloom-quarter. Ricreate al resize.

**Mutua esclusività con Outlines**: Bloom e outlines scrivono entrambi su swapchain. `enableBloom()` disabilita outlines e viceversa.

**BloomConfig**: threshold (0.7), intensity (1.0), levels (2), tonemapMode (0=none, 1=PBR Neutral, 2=ACES).

### Track C — GPU Particle System

Particelle interamente GPU-side, **non** entità ECS. Evita saturazione del ring buffer per migliaia di particelle/frame.

```
ParticleSystem.update(encoder, swapchainView, cameraVP, dt, entityPositions)
  Per ogni emitter:
    → Compute: simulate (gravity, age, interpolazione colore/dimensione)
    → Compute: spawn (probing lineare su slot liberi, PCG hash PRNG)
    → Render: instanced point sprites (triangle strip, circle SDF, alpha blending)
```

**Particle struct**: 48 byte (position vec2f, velocity vec2f, color vec4f, lifetime f32, age f32, size f32, _pad f32).

**Spawn accumulator**: per evitare perdita di particelle a frame rate variabile.

**Entity position tracking**: emitter possono seguire entità ECS opzionalmente.

**Rendering post-RenderGraph**: particelle dopo il pass compositing, non influenzate da bloom/FXAA.

### Nuovi Shader Phase 9

| Shader | Entry Points | HMR Pass Name |
|--------|-------------|----------------|
| `bezier.wgsl` | `vs_main`, `fs_main` | `bezier` |
| `bloom.wgsl` | `vs_main`, `fs_extract`, `fs_downsample`, `fs_upsample`, `fs_composite` | `bloom` |
| `particle-simulate.wgsl` | `simulate`, `spawn` | `particle-simulate` |
| `particle-render.wgsl` | `vs_main`, `fs_main` | `particle-render` |

Totale file WGSL con HMR: 14 (da 10 in Phase 8).

### Validazione Phase 9

- [x] Bézier quadratiche SDF con AA via fwidth() + smoothstep()
- [x] Dual Kawase Bloom 6-pass (extract, 2× downsample, 2× upsample, composite)
- [x] Bloom/outlines mutua esclusività con warning console
- [x] GPU Particle System con spawn accumulator (preserva frazioni)
- [x] Entity position tracking per emitter particelle
- [x] 14 file WGSL con HMR
- [x] Demo interattiva con Bézier + Bloom + particelle click-to-spawn

---

## 12b. Phase 4b: Asset Pipeline — KTX2/Basis Universal (✅ Completata)

Phase parallela a Phase 5 (come da roadmap), implementata e mergiata dopo Phase 9 come "Phase 10" nel codebase (commit `b9c31a0`).

### Deliverable

- **KTX2 Parser** (`ktx2-parser.ts`) — custom header reader ~60 righe, magic validation, `VK_FORMAT` constants (BC7, ASTC)
- **Basis Universal Transcoder** (`basis-transcoder.ts`) — singleton WASM wrapper (~200KB gzipped), lazy-loaded, BC7/ASTC/RGBA8 targets
- **Compressed Format Detection** (`capabilities.ts`) — `detectCompressedFormat()` probes BC7 (desktop) / ASTC (mobile)
- **Overflow Tiers** — per-tier rgba8unorm fallback per mixing PNG/JPEG con texture compresse
- **Packed Index Overflow Bit** — bit 31 = overflow flag, bits 18-16 = tier, bits 15-0 = layer. Backward compatible
- **9-Binding Shader Layout** — tutti i 6 shader WGSL + ForwardPass aggiornati con ovf0-ovf3
- **Renderer Integration** — device requested con compression feature, overflow views in ResourcePool
- **`compressionFormat` API** — public getter su Hyperion facade

### Nuovi File

| File | Ruolo | Test |
|------|-------|------|
| `ts/src/ktx2-parser.ts` | KTX2 container parser | 10 test |
| `ts/src/basis-transcoder.ts` | Basis Universal WASM transcoder | 11 test |
| `ts/wasm-vendor/basis_transcoder.*` | Vendored Basis WASM module | — |

### Validazione Phase 4b

- [x] KTX2 parsing con magic validation e corrupt data handling
- [x] Basis transcoder singleton con race protection
- [x] BC7/ASTC probing su adapter features
- [x] Overflow tiers con lazy allocation e pack/unpack index
- [x] 9-binding layout in tutti i 6 shader primitiva
- [x] Backward compatibility packed index (bit 31 = 0 per non-overflow)
- [x] `compressionFormat` getter funzionale
- [x] Demo mostra formato compressione attivo

---

## PARTE IV — SVILUPPO FUTURO

---

## 13. Phase 10: Developer Experience (DX)

**Stato**: 🟡 In corso — Sub-phase 10a e 10b completate, 10c prossima
**Piano di implementazione**: `docs/plans/2026-02-26-phase10-dx-plan.md` (30 task, 3 sub-fasi)
**Priorità ordinata**:

### 13.1 Prefabs & Declarative Scene Composition (1–2 giorni) — ✅ Completata (Phase 10b, 2026-02-27)

**Problema**: L'API fluente è eccellente per entità singole, ma quando un "Nemico" è composto da 5 entità gerarchiche, l'istanziazione via codice diventa verbosa.

**Design**: Sistema interamente TypeScript, zero modifiche WASM. Factory che chiamano l'API fluente sotto il cofano.

```typescript
engine.prefabs.register('Orc', {
  root: { position: [0, 0, 0], texture: Assets.Textures.OrcBody, scale: 1.5 },
  children: {
    shadow: { position: [0, -2, -0.1], primitive: RenderPrimitiveType.BoxShadow, primParams: { width: 48, height: 16, blur: 8 } },
    healthBar: { position: [0, 24, 0.1], primitive: RenderPrimitiveType.Gradient, primParams: { width: 40, height: 4 } },
    weapon: { position: [16, 0, 0.05], texture: Assets.Textures.Sword, scale: 0.8 },
  },
});

const orc = engine.prefabs.spawn('Orc', { x: 100, y: 200 });
orc.destroyAll();  // Despawn root + tutti i children
```

**Sinergie**: Prefab JSON serializzabili → editor livelli. CRDT + prefab = editing collaborativo. Asset Pipeline + prefab = type safety.

### 13.2 Debug Camera Plugin (Poche ore) — ✅ Completata (Phase 10a)

Plugin `debugCameraPlugin` in `ts/src/debug/debug-camera.ts` con WASD + scroll zoom, F1 toggle. Test in `debug-camera.test.ts`.

```typescript
engine.use(debugCameraPlugin({ moveSpeed: 300, zoomSpeed: 0.1, enableKey: 'F1' }));
```

### 13.3 Debug Bounds Visualizer (2–3 giorni) — ✅ Completata (Phase 10b, 2026-02-27)

Wireframe delle bounding sphere/box delle entità e dei collider. Dipende da LinePass (Phase 5.5). Integrato nell'engine (`engine.debug.*`).

### 13.4 ECS Inspector Visivo (1–2 settimane) — ✅ Completata (Phase 10a)

Pannello HTML overlay (`ts/src/debug/ecs-inspector.ts`) con F12 toggle, dual data channels (SystemViews fast path + WASM TLV slow path). Export WASM `engine_debug_get_components()` dietro feature flag `dev-tools`. TLV parser per 15 tipi di componenti (`ts/src/debug/tlv-parser.ts`). Test in `ecs-inspector.test.ts` e `tlv-parser.test.ts`.

### 13.5 Asset Pipeline Tipizzata (1 settimana) — ✅ Completata (Phase 10b, 2026-02-27)

Build-time scanning delle texture → generazione di costanti type-safe. Due package: `@hyperion-plugin/assets` + `vite-plugin-hyperion-assets`.

```typescript
// Generato automaticamente
const Assets = {
  Textures: {
    OrcBody: { handle: TextureHandle, layer: 0, width: 128, height: 128 },
    Sword: { handle: TextureHandle, layer: 1, width: 64, height: 64 },
  }
} as const;
```

### 13.6 Integrazione Fisica Zero-Config (3–4 settimane) — ⏳ Non iniziata

Vedi Phase dedicata alla fisica (sezione 16).

### 13.7 TypeScript Systems con SoA Access (1–2 settimane) — ✅ Completata (Phase 10a)

Interfaccia `SystemViews` (`ts/src/system-views.ts`) con 7 campi read-only: `entityCount`, `transforms`, `bounds`, `texIndices`, `renderMeta`, `primParams`, `entityIds`. Hook `HookFn` esteso a `(dt: number, views?: SystemViews)`. GameLoop wira le views da GPURenderState a tutti i preTick/postTick/frameEnd hook. Test in `system-views.test.ts`.

```typescript
engine.systems.addPreTick('my-ai', (dt, views) => {
  if (!views) return;
  const positions = views.transforms; // Float32Array read-only
  for (let i = 0; i < views.entityCount; i++) {
    // accesso diretto ai dati SoA
  }
});
```

### 13.8 Time-Travel Debugging — Livello 1: Replay (1 settimana) — ⏳ Non iniziata

Registrazione di tutti i comandi ring buffer in un "command tape". Replay deterministico dal tick 0 per riprodurre bug frame-by-frame.

```typescript
const tape = engine.debug.startRecording();
// ... gioca ...
engine.debug.stopRecording();
engine.debug.replayFromTick(0, tape); // replay deterministico
```

**Sinergia**: Combinato con ECS Inspector (#4) = debug chirurgico frame-by-frame.

### 13.9 HMR State di Gioco (2+ settimane) — ⏳ Non iniziata

Pattern e helper per preservare lo stato di gioco durante Hot Module Replacement. `createHotSystem()` che registra hook HMR e ripristina stato automaticamente.

```typescript
const { state, system } = createHotSystem('enemy-ai', import.meta.hot, {
  initialState: () => ({ wave: 1, score: 0 }),
  tick: (state, views) => { /* logica AI */ },
});
```

### 13.10 Time-Travel Debugging — Livello 2: Rewind (3+ settimane) — ⏳ Non iniziata

Step-backward senza replay dall'inizio. Snapshot periodici (ogni 300 tick = 5s) dello stato WASM completo + replay incrementale dal keyframe più vicino.

Richiede nuovi export WASM: `snapshot_create() → Vec<u8>` e `snapshot_restore(data: &[u8]) → bool`.

**Budget memoria**: ~1MB per snapshot (10k entità × 100B), 60 keyframes per 5 minuti = ~60MB. Accettabile per dev mode.

### Sub-phase 10a — Completata (27 Feb 2026)

Foundations & Introspection: feature flag `dev-tools`, SystemViews SoA, Debug Camera plugin, ECS Inspector (WASM exports + TLV parser + HTML panel). 10 task, 3 test Rust aggiuntivi, 18 test TS aggiuntivi.

File aggiunti: `ts/src/system-views.ts`, `ts/src/debug/debug-camera.ts`, `ts/src/debug/tlv-parser.ts`, `ts/src/debug/ecs-inspector.ts` + relativi test.

### Distribuzione DX Features

| Feature | Package | Stato | Note |
| --- | --- | --- | --- |
| Debug Camera | `ts/src/debug/debug-camera.ts` | ✅ 10a | Plugin con WASD + F1 toggle |
| ECS Inspector | `ts/src/debug/ecs-inspector.ts` | ✅ 10a | HTML overlay + TLV + WASM exports |
| TS Systems (SoA) | Core engine (`system-views.ts`) | ✅ 10a | SystemViews in hook |
| Prefabs | Core engine | ✅ 10b | Troppo fondamentale per plugin separato |
| Asset Pipeline | `@hyperion-plugin/assets` + `vite-plugin-hyperion-assets` | ✅ 10b | Due package |
| Bounds Viz | Core engine (`engine.debug.*`) | ✅ 10b | Integrato |
| Time-Travel L1 | `@hyperion-plugin/replay` | ⏳ 10c | Command tape + replay |
| Time-Travel L2 | `@hyperion-plugin/replay` | ⏳ 10c | Snapshot + rewind |
| HMR State | Core engine + docs | ⏳ 10c | Pattern documentato + helper |
| Physics | Core engine (feature flag) | ⏳ Differita | Vedi §16 |

### Principio Trasversale: Don't Pay For What You Don't Use

Tutte le feature dev-only devono avere costo zero in produzione:
- Feature flag Rust: `#[cfg(debug_assertions)]` o `#[cfg(feature = "dev-tools")]`
- Tree shaking TS: import condizionali eliminati in prod build
- Hook array vuoti: zero overhead nel game loop se nessun plugin registrato

---

## 14. Plugin System — Design Completo (✅ Implementato in Phase 8)

### 14.1 Il Boundary Fondamentale: Rust Chiuso, TypeScript Aperto

L'ECS (`hecs`) vive in Rust/WASM. I componenti sono `#[repr(C)]` con `Pod + Zeroable`. Un plugin non può aggiungere nuovi componenti Rust a runtime — il WASM binary è immutabile.

**Livello 1 — Core Primitives (Rust, WASM)**: Position, Velocity, Rotation, Scale, MeshHandle, RenderPrimitive, Parent, Children, ModelMatrix. Estensibili solo da chi compila il WASM.

**Livello 2 — Plugin Layer (TypeScript + WGSL)**: Custom RenderPass, custom shader, custom data buffer, custom input handler, lifecycle hooks, UI overlay. Estensibili da chiunque via `engine.use(plugin)`.

### 14.2 Interfaccia HyperionPlugin

```typescript
interface HyperionPlugin {
    readonly name: string;
    readonly version: string;
    readonly dependencies?: string[];
    install(ctx: PluginContext): PluginCleanup | void;
}
```

### 14.3 Le 5 API di Estensione (PluginContext)

**PluginRenderingAPI** — Inserire render pass custom nel RenderGraph. I pass dichiarano reads/writes per dependency tracking. Il DAG ricompila automaticamente.

**PluginSystemsAPI** — Registrare hook nel tick loop. Priorità numerica per ordinamento. Budget temporale: warning se un hook supera 2ms.

**PluginInputAPI** — Handler per keyboard, mouse, touch. Il plugin riceve eventi filtrati, non intercetta il flusso globale.

**PluginStorageAPI** — Storage key-value per dati plugin-specifici associati a entità. Side-table TS, non componenti ECS. Cleanup automatico su entity destroy.

**PluginGpuAPI** — Accesso al GPUDevice, creazione risorse tracciate (buffer, texture, bind group). Cleanup automatico su unuse(). Bind Group 3 riservato.

### 14.4 Pattern di Plugin Previsti

**Rendering Plugins**: Bloom, Minimap, Particle system, Trail renderer, Grid overlay, Fog of war  
**Logic Plugins**: Steering AI, Physics, Pathfinding (A*), Network sync, ECS query helper  
**Tool Plugins**: Selection box, Transform gizmo, Debug inspector, Performance HUD

### 14.5 Anti-Pattern Espliciti

1. Plugin **non possono** modificare componenti ECS core
2. Plugin **non possono** accedere al ring buffer direttamente
3. Plugin **non possono** sostituire pass built-in non-opzionali (CullPass, ForwardPass)
4. Plugin **non possono** creare Worker aggiuntivi
5. Plugin **non possono** registrare endpoint di rete

### 14.6 Roadmap Ecosistema Plugin (Post-Phase 10)

- Registry di plugin (npm scope `@hyperion-plugin/*`)
- Template `create-hyperion-plugin`
- DevTools per plugin debugging
- Plugin performance profiling (tempo per plugin per frame)
- Plugin hot-reload migliorato
- Plugin GPU error isolation via `device.pushErrorScope()`

---

## 15. Integrazione Tecnologie 2026 — ⏳ Non iniziate

### 15.1 WebGPU Subgroups (🔴 Critica — Phase 5.5) — ⏳ Non iniziata

**Stato**: Implementato come dual shader variant con feature detection runtime.

`cull_subgroups.wgsl` usa `subgroupExclusiveAdd` per prefix sum in hardware SIMD, eliminando i passi di shared memory. Il baseline `cull.wgsl` resta invariato come fallback.

```typescript
const hasSubgroups = adapter.features.has('subgroups');
const cullShaderSource = hasSubgroups ? CULL_SUBGROUPS_WGSL : CULL_BASELINE_WGSL;
```

Chrome 144 aggiunge `subgroup_id` e `num_subgroups` built-in, eliminando ricostruzione via atomics. Richiede detection separata (`navigator.gpu.wgslLanguageFeatures.has('subgroup_id')`) e `requires subgroup_id;` directive in WGSL (non `enable`). Chrome 145 introduce `subgroup_uniformity` language extension che migliora l'analisi di uniformità per codice subgroup.

```typescript
// Detection subgroup_id (Chrome 144+)
const hasSubgroupId = navigator.gpu.wgslLanguageFeatures?.has('subgroup_id');
```

```wgsl
// WGSL usage — nota: `requires` non `enable` per subgroup_id
enable subgroups;
requires subgroup_id;

@compute @workgroup_size(64)
fn main(@builtin(subgroup_id) sg_id: u32,
        @builtin(num_subgroups) num_sg: u32,
        @builtin(subgroup_invocation_id) sg_lane: u32) {
    // sg_id elimina necessità di ricostruzione via atomics
}
```

**Target**: Cull time 100k entità da ~0.8ms a < 0.4ms (2× improvement).

### 15.2 Sized Binding Arrays (🟡 Media — Phase 11+) — ⏳ Non iniziata

Stepping stone verso bindless. `bindingArraySize` su `GPUBindGroupLayoutEntry`, hardware ubiquo. Eliminerebbe il size-tiering Texture2DArray attuale.

```wgsl
@group(2) @binding(0) var textures: binding_array<texture_2d<f32>, 256>;
```

**Timeline**: Dipende da Chrome stable. Se non disponibile in H2 2026, il sistema di tiering resta. Zero rischio architetturale.

### 15.3 CRDT Multiplayer con Loro (🟢 Strategica — Phase 11+) — ⏳ Non iniziata

Differenziatore di mercato. Loro CRDT compilato a WASM con lazy loading separato.

**Architettura CrdtBridge**:
- Loro intercetta comandi ring buffer in post-tick → cattura delta stato
- In pre-tick → inietta comandi remoti da peer
- Loro containers: Map + List (essenziali), Text (Fugue + Peritext per rich text, opzionale), Tree (per scene hierarchy)
- Loro supporta anche MovableList (riordinamento collaborativo) e Counter — disponibili ma non richiesti per CrdtBridge MVP
- Network layer: WebSocket per relay + WebRTC DataChannel per P2P

**Punto critico**: Binary size WASM di Loro. Target: < 120KB gzipped separato.

**Metrica sync**: < 5KB/s per peer in editing attivo. < 1ms latenza merge per 100 operazioni.

### 15.4 Wasm Memory64 (⚪ Monitoraggio — Post-Phase 11) — ⏳ Differita

Standard dal 17 settembre 2025 (Wasm 3.0). Chrome 133 e Firefox 134 stabili. Safari dietro flag.

**Caveat critico**: Penalty performance 10–100% rispetto a wasm32 (benchmark Emscripten). Hyperion non ne beneficia fino a scenari > 4GB (CAD/BIM). L'integrazione resta post-Phase 11 per ragioni di performance.

### 15.5 WebNN Neural Rendering (⚪ Plugin Demo — Post-Phase 11) — ⏳ Non iniziata

Plugin demo `@hyperion-plugin/neural-upscale` per validare PluginContext e PluginGpuAPI. Rendering a risoluzione ridotta (50%) + upscale neural in tempo reale.

- Modello: Real-ESRGAN Lite (~2MB ONNX)
- Budget frame: < 4ms su GPU discreta
- Auto-disable se frame time supera soglia
- Interop WebGPU: `MLContext` da `GPUDevice` esistente

**Rischio alto**: Dipende da maturazione WebNN nei browser (0.000029% attivazione Chrome Platform Status).

---

## 16. Integrazione Fisica — Design Completo — ⏳ Non iniziata

### 16.1 Strategia: Maximum Performance

Rapier2D compilato direttamente dentro `hyperion-core` via Cargo feature flag, condividendo la stessa memoria lineare WASM. Zero overhead di serializzazione, FFI boundary, e copia dati.

### 16.2 Due Livelli

**Spatial Grid** — sempre nel core (~10-15KB). Query spaziali per tutti gli use case (hit-testing, overlap, viewport culling CPU-side). `SpatialGrid` con cell size = viewport_width/4. O(n) costruzione, O(1) query per cella.

**Rapier Full** — feature flag (~300-400KB extra gzipped). Simulazione fisica completa con rigid body, collider, joints, character controller.

### 16.3 Workspace Cargo

```
HyperionEngine/
├── Cargo.toml                    # [workspace]
├── crates/
│   ├── hyperion-core/            # Feature: physics-2d, physics-3d
│   │   └── src/
│   │       ├── spatial.rs        # SpatialGrid (sempre compilato)
│   │       └── physics.rs        # Rapier wrapper (solo con feature)
│   └── hyperion-audio/           # Crate audio separata
└── ts/
    ├── src/physics-api.ts        # TypeScript physics facade
    └── wasm/
        ├── core/                 # ~150KB gzipped (senza fisica)
        └── core-physics/         # ~450-550KB gzipped (con Rapier)
```

### 16.4 Feature Flags

```toml
[features]
default = []
physics-2d = ["dep:rapier2d"]
physics-3d = ["dep:rapier3d"]
physics-2d-deterministic = ["physics-2d", "rapier2d/enhanced-determinism"]
physics-serialization = ["dep:bincode", "dep:serde", "rapier2d/serde-serialize"]
```

### 16.5 Integration Points

**Nuovi CommandType ring buffer**: `CreateRigidBody` (28 byte), `CreateCollider` (28 byte), `ApplyForce`, `ApplyImpulse`, `RemoveRigidBody`, `CreateJoint` (per tipo).

**Tick loop modificato**:
```
1. drain_commands() — include comandi fisici
2. plugin pre-tick hooks
3. physics_sync_pre() — crea rigid body/collider, applica forze, aggiorna collision map
4. rapier.step() — simulazione fisica con 13 parametri
5. physics_sync_post() — write-back posizioni Rapier → ECS (skip sleeping bodies)
6. velocity_system() — filtrato: skip entità PhysicsControlled
7. plugin post-tick hooks
8. hierarchy_system() — propagazione trasformazioni
```

**Collision Events**: `mpsc::channel` in Rust → `HyperionCollisionEvent` → callback TS. Collision groups via `InteractionGroups`.

**Scene Queries**: Raycast, overlap AABB, overlap shape, intersect point — tutte tramite `QueryPipeline` di Rapier.

### 16.6 Punto Critico: `length_unit`

`IntegrationParameters::length_unit` **deve** essere impostato a `100.0` per pixel space. Il **default Rapier è 1.0 (metri)** — senza override esplicito, sleeping thresholds e contact tolerance sono calibrati per scala metrica, rendendo la simulazione in pixel space erratica. Hyperion imposta `length_unit = 100.0` nel costruttore come invariante obbligatoria, con assert in debug mode.

### 16.7 TypeScript Physics API

```typescript
const engine = await Hyperion.create({
    canvas: document.getElementById('game'),
    maxEntities: 100_000,
    physics: '2d',  // false | '2d' | '3d' — determina quale WASM caricare
});

engine.physics.createRigidBody(entityId, { type: 'dynamic', gravityScale: 1.0 });
engine.physics.createCollider(entityId, { shape: 'ball', radius: 16 });
engine.physics.onCollision((a, b, type) => { /* started | stopped */ });
engine.physics.raycast(origin, direction, maxToi, (hit) => { /* ... */ });
```

### 16.8 Impatto sul Roadmap

| Fase | Aggiunte Physics | Settimane Extra |
|---|---|---|
| Phase 4.5 | Spatial grid, componenti fisici placeholder, CommandType riservati | +0.5 |
| Phase 5 | Physics API stubs, build pipeline dual-variant | +1 |
| Phase 10 (DX) | CreateRigidBody/Collider commands, physics_sync, Rapier integration | +3-4 |
| Phase 11+ | Debug rendering, joints, character controller, determinismo, snapshot | +2-3 |

---

## 17. Strategia di Ottimizzazione — 🟡 Solo LTO configurato

### 17.1 Tier 1: Quick Wins (1–3 giorni ciascuno)

| # | Ottimizzazione | Area | Headroom | Effort |
|---|---------------|------|----------|--------|
| 1 | **SIMD128 activation** | ECS/WASM | 2–3× transform compute | 1 giorno |
| 2 | **Subgroup prefix sum** | GPU Culling | 5–8% frame time | 1–2 giorni |
| 3 | **wasm-opt + LTO thin** | Binary | 15–25% smaller | 0.5 giorni |
| 4 | **Spatial hash for hit test** | Input | 100× faster picking | 1 giorno |
| 5 | **Command coalescing** | Ring Buffer | 30–50% less traffic | 1 giorno |

### 17.2 Tier 2: Medium Term (1–2 settimane ciascuno)

| # | Ottimizzazione | Area | Headroom | Effort |
|---|---------------|------|----------|--------|
| 6 | **Compute scatter upload** | GPU Buffer | 10–20× sparse updates | 1 settimana |
| 7 | **Material sort keys** | Rendering | 10–30% GPU time | 3–5 giorni |
| 8 | **Compressed 2D transforms** | GPU Buffer | 2.3× less bandwidth | 1 settimana |
| 9 | **Batch spawn command** | Ring Buffer | 10–100× mass spawn | 2–3 giorni |
| 10 | **Texture streaming** | Assets | Eliminazione startup stutter | 1 settimana |

### 17.3 Tier 3: Long Term (2+ settimane)

| # | Ottimizzazione | Area | Headroom | Effort |
|---|---------------|------|----------|--------|
| 11 | **Temporal culling coherence** | Rendering | ~50% culling cost | 2–3 settimane |
| 12 | **Sized binding arrays** | Textures | Eliminazione tier system | 1 settimana |
| 13 | **2D component optimization** | ECS | 2× iteration throughput | 1 settimana |
| 14 | **GPU radix sort for transparency** | Rendering | Correct alpha compositing | 1 settimana |
| 15 | **Time-travel debug integration** | DX | Debug senza overhead prod | 2–3 settimane |

### 17.4 Impatto Cumulativo Stimato

**Scenario Canvas (10k entità, sessione 8h)**:

| Metrica | Attuale | Post-Tier 1 | Post-Tier 2 | Post-Tier 3 |
|---------|---------|-------------|-------------|-------------|
| Frame time | ~8ms | ~6ms | ~4.5ms | ~3ms |
| Headroom gameplay | ~8ms | ~10ms | ~11.5ms | ~13ms |
| Hit test | ~1ms | ~0.01ms | ~0.01ms | ~0.01ms |

**Scenario Game (100k entità, 60fps)**:

| Metrica | Attuale | Post-Tier 1 | Post-Tier 2 | Post-Tier 3 |
|---------|---------|-------------|-------------|-------------|
| Frame time | ~14ms | ~10ms | ~7ms | ~5ms |
| Max entità @60fps | ~100k | ~140k | ~200k | ~280k |
| Spawn 100k time | ~500ms | ~400ms | ~50ms | ~50ms |

---

## 18. Tech Demo — Showcase Completo — ⏳ Solo demo educativa

Quattro demo in un'unica applicazione con tabs/scene switch e counter FPS/entity count sempre visibile.

### 18.1 "Hyperion Canvas" — Editor Collaborativo (Priorità strategica)

Mini-Figma per level design collaborativo in tempo reale. Mostra: MSDF text, JFA outlines, instanced lines, gradienti + box shadows, CRDT Loro, compute culling su 10k+ elementi, hit testing GPU, FXAA + tonemapping.

**Perché è devastante**: Dimostra il mercato Canvas Professionale end-to-end. Nessun engine web offre CRDT + GPU-driven rendering + selection outlines in un pacchetto.

### 18.2 "Swarm" — 100K Entità Autonome (Impatto virale)

100.000 creature con comportamento emergente (boids, flocking, predator-prey), fisica Rapier. Mostra: ECS a pieno regime, compute culling + prefix sum, subgroups, indirect draw, SoA, Rapier physics, degradazione adattiva live.

**Perché è devastante**: "100K entità a 60fps nel browser" si vende da solo. Demo da Hacker News.

### 18.3 "Atlas" — Visualizzatore di Grafi

Knowledge graph con migliaia di nodi e archi, zoom semantico. Mostra tutte le primitive rendering, scene graph gerarchico, zoom semantico LOD, hit testing GPU, force-directed layout compute shader, KTX2/Basis Universal, compact() API.

**Perché è devastante**: I graph visualizer sono un pain point reale (Cytoscape crolla a poche migliaia di nodi). In un wrapper Tauri è un prodotto.

### 18.4 "Forge" — Stress Test Plugin System

Scena modulare dove ogni modulo è un plugin: particelle, meteo con shader custom, neural upscale WebNN, audio-reactive. Mostra: plugin system completo, WebNN, AudioWorklet, shader custom, lazy loading, hot-swap.

**Perché è devastante**: Dimostra che Hyperion è una piattaforma, non un engine monolitico.

---

## PARTE V — ORIZZONTE LONTANO (Post-Phase 11)

---

## 19. Capacità Future — Post Phase 11 — ⏳ Non iniziate

| Capacità | Complessità | Motivazione | Fase Suggerita |
|----------|------------|-------------|----------------|
| Bézier curves (Loop-Blinn cubiche) | Media | Use case più ristretto | Phase 11+ |
| Stencil clip paths | Alta | Stencil buffer management complesso | Phase 11+ |
| WebGL 2 fallback renderer | Alta | Copertura browser universale | Phase 11+ |
| Clustered forward lighting | Alta | Esce dallo scope 2D/2.5D | Phase 12+ |
| Shadow mapping (CSM + PCF) | Alta | Dipende da clustered forward | Phase 12+ |
| PBR materials + IBL | Alta | Richiede 3D mesh pipeline | Phase 12+ |
| Meshlet rendering | Molto Alta | Ottimizzazione scene 3D pesanti | Phase 12+ |
| glTF loading | Alta | Dipende da PBR + mesh pipeline | Phase 12+ |
| TAA (Temporal Anti-Aliasing) | Alta | Velocity buffer, jitter, history | Phase 12+ |
| Vello-style compute 2D renderer | Molto Alta | Sistema completo alternativo | Valutazione futura |
| Dynamic Binding Arrays (true bindless) | Alta | Quando standardizzate | Post-2027 |

---

## 20. Visione di Lungo Termine (2027+)

### Dimensione Tecnica

Supporto 3D completo (mesh arbitrarie, PBR, luci dinamiche), text rendering di qualità tipografica (SDF + sub-pixel), rendering vettoriale completo (SVG import, path editing), plugin system maturo.

### Dimensione Commerciale

Suite di prodotti closed-source che generano ricavi per sostenere lo sviluppo del motore open-source. Community abbastanza ampia da contribuire stabilità e copertura piattaforme.

### Dimensione Ecosistema

Integrazioni con framework web (React, Svelte, Vue, Solid), template Electron/Tauri, possibilmente editor visuale leggero per dimostrare le capacità.

---

## PARTE VI — GESTIONE DEL RISCHIO

---

## 21. Matrice Rischi Completa

### Rischi Architetturali

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|------------|---------|-------------|
| WebGPU non disponibile su Safari mobile | Media | Alto | WebGL 2 fallback renderer |
| `SharedArrayBuffer` deprecato o ristretto | Bassa | Critico | Mode C come fallback completo |
| Performance Mode C su mobile mid sotto target | Alta | Alto | Benchmark in Phase 4.5; documenta limiti |
| `device.lost` recovery non funziona su tutti i browser | Media | Alto | Test Chrome/Firefox/Safari; fallback page reload |
| Ring buffer 2MB insufficiente | Bassa | Medio | API per override + warning a >75% |
| WASM linear memory non rilasciabile dopo picco | Alta | Medio | Memory pool interno, documenta limiti |

### Rischi Rendering

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|------------|---------|-------------|
| MSDF atlas troppo grande per mobile | Bassa | Medio | 1024×1024 default, 2048 opt-in, LRU eviction |
| JFA performance insufficiente su GPU mobile | Media | Medio | Ridurre risoluzione JFA (quarter-res, bilinear upsample) |
| WGSL branching divergente con mix di primitive | Media | Medio | Pipeline separate per tipo (zero branching) |
| Mancanza preprocessore WGSL | Alta | Medio | `naga_oil` o template string TS |
| `erf()` non built-in in WGSL | Media | Basso | Approssimazione Abramowitz-Stegun |

### Rischi Physics

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|------------|---------|-------------|
| Rapier WASM binary troppo grande (>500KB gzip) | Media | Alto | `lto = "fat"` + `codegen-units = 1`, profiling con `twiggy` |
| `nalgebra` ↔ `glam` conversione | Bassa | Basso | `convert-glam029` feature su nalgebra, layout Vec2/Vec3 identico (f32 array) |
| Write-back Rapier→ECS insufficiente per 100k | Bassa | Alto | Sleeping check, batch write-back unsafe |
| `length_unit` non configurato per pixel space | Alta (se dimenticato) | Alto | Override a 100.0 nel costruttore (Rapier default è 1.0), assert in debug, documenta prominentemente |

### Rischi Plugin

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|------------|---------|-------------|
| Plugin causa memory leak GPU | Alta | Alto | `PluginGpuAPI` traccia risorse, cleanup automatico |
| Plugin blocca main thread nel pre-tick | Alta | Alto | Budget temporale 2ms, warning + downgrade |
| Due plugin scrivono nella stessa texture | Media | Alto | RenderGraph valida dipendenze a compile-time |
| Aggiornamento engine rompe plugin | Alta | Alto | SemVer separata su interfaccia plugin |

### Rischi Tecnologie 2026

| Rischio | Probabilità | Impatto | Mitigazione |
|---------|------------|---------|-------------|
| Safari WebGPU subgroups delay | Media | Basso | Fallback trasparente a shared memory |
| Loro breaking changes | Bassa | Medio | Pin versione, astrazione CrdtBridge |
| Browser vendor divergenza WebNN | Alta | Basso | Plugin opzionale, progressive enhancement |
| Memory64 perf penalty | Bassa | Basso | Audit senza migrazione, benchmark prima |

---

## 22. Hardware Target e Performance Budget

| Tier | Dispositivo | Frame Budget | Target Entità |
|------|------------|--------------|---------------|
| Desktop high | MacBook Pro M3, RTX 3060 | 16ms (60fps) | 100k |
| Desktop mid | Intel UHD 630, GTX 1050 | 16ms (60fps) | 50k |
| Mobile high | iPhone 15, Galaxy S24 | 16ms (60fps) | 20k |
| Mobile mid | iPhone 12, Galaxy A54 | 33ms (30fps) | 10k |
| Electron/Tauri | Varies (desktop GPU) | 16ms (60fps) | 100k |

### Benchmark Target

| Benchmark | Target Desktop | Target Mobile |
|-----------|---------------|---------------|
| `ecs-tick-10k` | < 2ms | < 5ms |
| `ecs-tick-100k` | < 16ms | < 40ms |
| `spawn-despawn-churn` (1000+1000/frame, 600 frames) | No memory leak | No leak |
| `gpu-upload-100k` (SoA writeBuffer) | < 3ms | < 8ms |
| `compute-cull-100k` | < 0.5ms | < 2ms |
| `prefix-sum-100k` | < 0.3ms | < 1ms |
| `full-frame-100k` (tick+render) | < 16ms | N/A (30fps) |
| `mode-c-10k` | < 16ms | < 33ms |

---

## PARTE VII — APPENDICI

---

## A. Dipendenze tra Fasi

```
Phase 0-4  ──→ Phase 4.5    (fondamenta)                         ✅
Phase 4.5  ──→ Phase 5      (API dipende da supervisor + SoA)    ✅
Phase 4.5  ──→ Phase 4b     (lazy allocation abilita compr.)     ✅
Phase 4.5  ──→ Phase 5.5    (SoA, RenderPrimitive, prefix sum)   ✅
Phase 5    ──→ Phase 5.5    (API pubblica, scene graph)           ✅
Phase 5    ──→ Phase 6      (input API dipende da entity handles) ✅
Phase 5.5  ──→ Phase 6      (JFA outlines + picking)             ✅
Phase 5    ──→ Phase 7      (profiler dipende da metriche API)   ✅
Phase 5.5  ──→ Phase 7      (FXAA/tonemapping prerequisiti)      ✅
Phase 7    ──→ Phase 8      (profiler → plugin system)           ✅
Phase 8    ──→ Phase 9      (PluginContext → particle system)    ✅
Phase 9    ──→ Phase 10 DX  (feature complete → DX polish)       ⏳ PROSSIMA
Phase 10   ──→ Phase 11+    (DX → tecnologie avanzate + demo)   ⏳

Parallele:
Phase 4b (KTX2/Basis Universal) — parallelo a Phase 5            ✅ Completata
Physics Spatial Grid — previsto in Phase 10 DX (§13.6)           ⏳
Physics Rapier Full — previsto in Phase 10 DX (§13.6)            ⏳
```

## B. Dipendenze tra Feature DX

```
1. Prefabs ──────────────────────────────── standalone
2. Debug Camera ─────────────────────────── standalone
3. Bounds Visualizer ── usa LinePass ─────── standalone
4. ECS Inspector ────── usa Bounds (#3) ─── dipende da #3
5. Asset Pipeline ───────────────────────── standalone
6. Physics Zero-Config ── usa Bounds (#3) ─ standalone (design pronto)
7. TS Systems ───────────────────────────── standalone
8. Time-Travel Lvl 1 ── sinergia con #4 ── standalone
9. HMR State ────────────────────────────── standalone
10. Time-Travel Lvl 2 ── command tape ──── dipende da #8

Sinergie:
  #3 + #4: Inspector evidenzia entità selezionata nei bounds
  #4 + #8: Replay frame-by-frame + inspector = debug chirurgico
  #1 + #5: Prefab con asset type-safe
  #3 + #6: Debug visualizer mostra collider shapes
  #7 + #9: TS systems + HMR = modifica logica senza perdere stato
```

## C. Algoritmi di Rendering — Catalogo per Area

### Area 1: Primitive Vettoriali 2D

| Tecnica | Metodo | Fase | Stato |
|---------|--------|------|-------|
| Line rendering — instanced screen-space expansion | Quad expansion in vertex shader | Phase 5.5 | ✅ |
| Line rendering — SDF | distance_to_segment per fragment | Futuro | Pianificato |
| MSDF text | median(r,g,b) + screen-pixel-range | Phase 5.5 | ✅ |
| Bézier quadratiche — SDF Inigo Quilez | Distanza analitica + Cardano/trig | Phase 9 | ✅ |
| Bézier cubiche — Loop-Blinn | Classification + canonical coordinates | Phase 11+ | Pianificato |
| Gradienti — 1D LUT | Linear/radial/conic via texture sample | Phase 5.5 | ✅ |
| Box shadows — Evan Wallace SDF | erf() approximation, O(1)/pixel | Phase 5.5 | ✅ |
| Clip paths — stencil | IncrementClamp + compare Equal | Phase 11+ | Pianificato |
| Lyon tessellation | CPU monotone polygon decomposition | Disponibile | Rust crate |

### Area 2: Culling e Batching GPU-Driven

| Tecnica | Metodo | Fase | Stato |
|---------|--------|------|-------|
| Compute frustum culling | WGSL compute shader | Phase 4 | ✅ |
| Prefix sum — Blelloch | Shared memory scan | Phase 4.5 | ✅ |
| Prefix sum — Subgroups | `subgroupExclusiveAdd` hardware | Phase 11+ | ⏳ |
| Stream compaction | Prefix sum → compact output | Phase 4.5 | ✅ |
| Indirect draw single buffer | Pack all args in one GPUBuffer | Phase 4.5 | ✅ |
| Material sort keys | 64-bit key per draw call | Phase 10+ | Pianificato |
| Temporal culling coherence | Frame-to-frame visibility cache | Phase 11+ | Pianificato |

### Area 3: Post-Processing

| Tecnica | Metodo | Fase | Stato |
|---------|--------|------|-------|
| FXAA (Lottes) | Edge detection + subpixel AA | Phase 5.5 | ✅ |
| PBR Neutral tonemapping | Khronos standard | Phase 5.5 | ✅ |
| ACES filmic tonemapping | Filmic curve | Phase 5.5 | ✅ |
| JFA selection outlines | Jump Flood Algorithm ×10 pass | Phase 5.5 | ✅ |
| Dual Kawase Bloom | Downsample/upsample chain | Phase 9 | ✅ |
| TAA | Halton jitter + variance clipping | Phase 12+ | Pianificato |
| SSAO/GTAO | Visibility bitmask | Phase 12+ | Pianificato |

### Area 4: 3D (Futuro)

| Tecnica | Metodo | Fase | Stato |
|---------|--------|------|-------|
| Cook-Torrance BRDF | GGX NDF + Schlick Fresnel + Smith-GGX G | Phase 12+ | Pianificato |
| Clustered forward lighting | 3D frustum grid + light assignment | Phase 12+ | Pianificato |
| Shadow mapping (CSM + PCF) | Cascaded shadow maps | Phase 12+ | Pianificato |
| glTF loading | Full PBR materials | Phase 12+ | Pianificato |
| Meshlet rendering | GPU-driven mesh shading | Phase 12+ | Pianificato |

## D. Insights da GDevelop

L'analisi dell'architettura GDevelop ha fornito insights utili per Hyperion su: struttura editor/runtime, gestione asset, event system, e limiti architetturali. GDevelop dimostra sia il potenziale di un motore web-based (community ampia, accessibilità) sia i limiti di un'architettura non progettata per performance (single-thread, DOM-based rendering, nessun ECS).

Le lezioni chiave applicate a Hyperion:
- **Separazione runtime/editor**: il core engine deve funzionare indipendentemente dall'editor
- **Asset management**: pipeline tipizzata con lazy loading e compression è essenziale
- **Estensibilità**: il plugin system deve essere first-class, non afterthought
- **Performance**: l'architettura deve partire dalla performance (WASM, multi-thread, GPU-driven), non aggiungerla dopo

---

## E. Documenti di Riferimento del Progetto

| Documento | Contenuto | Stato |
|-----------|-----------|-------|
| `hyperion-engine-vision.md` | Vision fondativa, principi guida, tre mercati | Fondativo |
| `PROJECT_ARCHITECTURE.md` | Architettura tecnica completa v0.11.0 (Phase 0-9) | Aggiornato |
| `hyperion-engine-design-v3.md` | Design architetturale v3.0 | Approvato |
| `hyperion-engine-roadmap-unified-v3.md` | Roadmap unificata Phase 4.5-7 | Superato da questo documento |
| `hyperion-roadmap-rendering-integration.md` | Integrazione rendering nella roadmap | Integrato |
| `hyperion-plugin-system-design.md` | Design completo plugin system | Proposta integrata |
| `hyperion-physics-integration-design.md` | Design integrazione Rapier | Proposta validata |
| `hyperion-2026-tech-integration-design.md` | 5 tecnologie 2026 | Draft integrato |
| `hyperion-dx-roadmap.md` | 10 feature DX prioritizzate | Pianificazione integrata |
| `hyperion-optimization-analysis.md` | Analisi ottimizzazione profonda | Analisi integrata |
| `Rendering_Algorithms_for_the_Hyperion_Engine.md` | 60+ algoritmi rendering catalogati | Riferimento |
| `physics-validation-report.md` | Validazione API Rapier vs Context7 | Validazione completata |
| `2026-02-18-hyperion-engine-roadmap-v2_1.md` | Roadmap originale v2.1 | Superato |
| `GDevelop_s_Architecture.md` | Teardown tecnico GDevelop | Riferimento |
| `hyperion-gdevelop-insights.docx` | Insights da GDevelop per Hyperion | Riferimento |

---

> **Questo documento è il riferimento unico per l'intero progetto Hyperion Engine.** Ogni decisione tecnica, architetturale e di prioritizzazione viene ricondotta a queste pagine. Quando c'è dubbio, si torna qui.
>
> **Ultimo aggiornamento**: 25 Febbraio 2026 — Phase 9 + Phase 4b completate. Aggiornati stati di tutte le sezioni.
> **Prossimo aggiornamento**: Al completamento di Phase 10 DX (o subset selezionato).
