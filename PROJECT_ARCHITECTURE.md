# Architettura Tecnica: Hyperion Engine (v0.1.0)

> **Ultimo aggiornamento**: 2026-02-17 | **Versione**: 0.1.0 (Phase 0-1 completate) | **22 test Rust across 5 moduli + 11 test TypeScript across 3 file**

---

## 1. Panoramica Architetturale

### Scopo

Hyperion e un **game engine web general-purpose** che punta a performance di livello nativo dentro il browser. La simulazione ECS gira in Rust compilato a WebAssembly, la comunicazione tra TypeScript e WASM avviene tramite un ring buffer lock-free su SharedArrayBuffer, e il rendering (Phase 2+) sara affidato a WebGPU con GPU-Driven Rendering via WGSL Compute Shaders.

L'obiettivo architetturale primario e la **separazione fisica** tra UI, logica di simulazione e rendering: tre thread indipendenti che comunicano senza lock, con degradazione automatica a single-thread quando il browser non supporta le API necessarie.

### Cosa NON fa (attualmente)

- Non esegue rendering (Phase 2 non ancora implementata)
- Non gestisce asset (texture, audio, mesh) — Phase 4+
- Non espone una API utente ad alto livello (Phase 5)
- Non supporta networking o multiplayer
- Non compila con SIMD128 attivo (richiede flag target-feature specifici per wasm-pack)
- Non implementa ancora il collegamento ring buffer SAB → WASM memory (richiede `wasm-bindgen` SharedArrayBuffer support — Phase 2)

### Design Principle: "Command Buffer Architecture"

Il principio architetturale fondamentale e la **separazione tra mutazioni e simulazione** attraverso un protocollo binario su memoria condivisa. TypeScript non chiama mai funzioni WASM per singole mutazioni di entita. Serializza invece comandi in un ring buffer che Rust consuma in batch all'inizio di ogni frame.

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

Questo elimina due problemi critici:

1. **Overhead FFI per-call**: Ogni chiamata JS→WASM ha un costo di context switching misurabile. A 10k+ mutazioni/frame, il costo supera il tempo di simulazione. Il ring buffer riduce il crossing a uno per frame.
2. **Invalidazione delle viste**: `memory.grow` in WASM invalida silenziosamente tutte le `TypedArray` JS esistenti. Il ring buffer vive su un `SharedArrayBuffer` statico, separato dalla memoria lineare WASM.

| Caratteristica | FFI Sincrona (scartata) | Ring Buffer (adottato) |
|---|---|---|
| Context switching | Uno per mutazione di proprieta | Un singolo batch read per frame |
| Rischio memory detachment | Alto (`memory.grow` invalida le viste) | Nessuno (SharedArrayBuffer statico) |
| Scalabilita multi-thread | Impossibile | Lock-free SPSC nativo |
| Throughput | Degrada sopra 10k mutazioni/frame | Limitato solo dalla bandwidth di memoria |

### Stack Tecnologico

| Dipendenza | Scopo | Perche questa |
|---|---|---|
| **Rust** (edition 2024, `wasm-bindgen`) | Linguaggio per il core WASM | Sicurezza di memoria senza GC, compilazione a WASM con overhead minimo, SIMD nativo via `glam` |
| **`hecs`** 0.11 | ECS (Entity Component System) | Binary footprint minimo per WASM (~50KB vs ~200KB di `bevy_ecs`). `bevy_ecs` perde il parallelismo su `wasm32` (fallback a single-thread) aggiungendo solo binary bloat. `hecs` ha velocita di iterazione single-thread equivalente |
| **`glam`** 0.29 (feat: `bytemuck`) | Matematica 3D (Vec3, Quat, Mat4) | Tipi SIMD-accelerated, layout `repr(C)`, zero-cost conversion a byte slice via `bytemuck` per upload diretto a GPU |
| **`bytemuck`** 1.x (feat: `derive`) | Cast sicuro struct ↔ byte slice | Garantisce che i componenti ECS siano `Pod` + `Zeroable` per upload GPU senza copie. Derive macro elimina boilerplate |
| **TypeScript** (ES2022, strict) | Browser integration | Type safety per la API di coordinamento (Worker messages, ring buffer protocol), moduli ESM nativi |
| **Vite** 6.x | Dev server + bundler | Hot reload, supporto Worker ESM nativo, header COOP/COEP configurabili per SharedArrayBuffer |
| **`vitest`** 4.x | Test runner TypeScript | Compatibile con SharedArrayBuffer e Atomics in ambiente Node.js (critico per testare il ring buffer) |
| **`wasm-pack`** | Build pipeline Rust → WASM | Genera JS glue code + `.wasm` binary + `.d.ts` types in un singolo comando |

### Perche hecs e non bevy_ecs?

La scelta di `hecs` rispetto a `bevy_ecs` non e ovvia — Bevy e l'ecosistema Rust ECS dominante. Ma su `wasm32-unknown-unknown`:

1. **Parallelismo perso**: `bevy_ecs` usa `rayon` per iterazione parallela dei sistemi. Su WASM, `rayon` fallisce silenziosamente a single-thread. Si paga il costo dell'infrastruttura di scheduling (trait objects, task graph) senza il beneficio.
2. **Binary bloat**: `bevy_ecs` con le sue dipendenze transitive aggiunge ~150KB al `.wasm` compresso. Su una CDN, 150KB extra sono ~50ms di download addizionale su 3G.
3. **Velocita di iterazione**: In single-thread, `hecs::query_mut` e `bevy_ecs::Query` hanno throughput comparabile — il collo di bottiglia e la cache locality dei componenti, non l'overhead del query system.

La migrazione futura a `bevy_ecs` o `flecs-rs` richiederebbe solo la riscrittura del layer di sistema (`systems.rs`, `command_processor.rs`), non dell'intera architettura.

---

## 2. Esecuzione Adattiva: Tre Modi Runtime

L'engine seleziona automaticamente uno di tre modi di esecuzione al startup, basandosi sul feature detection del browser. La logica di selezione risiede in `ts/src/capabilities.ts`.

### Tabella Decisionale

```
+-------------------------------------------------------------------+
|               Browser Feature Detection                            |
+-------------------------------------------------------------------+
| SharedArrayBuffer? ──NO──> Mode C (Single Thread)                  |
|       |                                                            |
|      YES                                                           |
|       |                                                            |
| WebGPU in Worker? ──NO──> Mode B (Partial Isolation)               |
|       |                                                            |
|      YES                                                           |
|       |                                                            |
| OffscreenCanvas? ──NO──> Mode B (Partial Isolation)                |
|       |                                                            |
|      YES                                                           |
|       v                                                            |
| Mode A (Full Isolation)                                            |
+-------------------------------------------------------------------+
```

### Mode A — Full Isolation (Optimale)

- **Richiede**: `SharedArrayBuffer` + `OffscreenCanvas` + WebGPU in Worker
- **Layout**: Main Thread (UI/Input) → Worker 1 (ECS/WASM) → Worker 2 (Render/WebGPU)
- **Comunicazione**: Ring Buffer SPSC su SharedArrayBuffer

```
+------------------+     Ring Buffer (SAB)     +------------------+     Render State     +------------------+
|   Main Thread    |  ======================>  |    Worker 1      |  ================>   |    Worker 2      |
|   UI + Input     |   [commands: binary]      |   ECS + Physics  |   [model matrices]   |   WebGPU Render  |
|   RAF loop       |                           |   WASM module    |                      |   OffscreenCanvas|
+------------------+                           +------------------+                      +------------------+
```

### Mode B — Partial Isolation (Firefox)

- **Richiede**: `SharedArrayBuffer` + WebGPU su Main Thread
- **Layout**: Main Thread (UI + Render) → Worker 1 (ECS/WASM)
- **Comunicazione**: Ring Buffer per comandi, `postMessage` con `ArrayBuffer` trasferibile per render state

### Mode C — Single Thread (Fallback Massima Compatibilita)

- **Richiede**: Solo WebGPU su Main Thread
- **Layout**: Main Thread esegue tutto sequenzialmente: Input → ECS tick → Render
- **Comunicazione**: Chiamate dirette, nessun Ring Buffer necessario
- **Nota**: Viabile per scene sotto ~10k entita a 60fps

### Requisito di Deploy: COOP/COEP

I Mode A e B richiedono `crossOriginIsolated === true` nel browser. Senza gli header HTTP corretti, `SharedArrayBuffer` non e disponibile e l'engine degrada a Mode C con un warning chiaro nella console.

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite dev server li configura automaticamente (`ts/vite.config.ts`). In produzione, il CDN/web server deve servirli.

### Rilevamento Capabilities

`detectCapabilities()` (`ts/src/capabilities.ts:18`) sonda le API del browser:

| Capability | Come la rileva | Note |
|---|---|---|
| `crossOriginIsolated` | `globalThis.crossOriginIsolated` | Prerequisito per SAB |
| `sharedArrayBuffer` | `crossOriginIsolated && typeof SharedArrayBuffer !== "undefined"` | SAB disponibile solo se isolato |
| `offscreenCanvas` | `typeof OffscreenCanvas !== "undefined"` | Per render in Worker |
| `webgpu` | `"gpu" in navigator` | API WebGPU presente |
| `webgpuInWorker` | Euristica UA (Chrome/Edge = si, Firefox = no) | Non testabile dal Main Thread; usa heuristic conservativa |

La detection di `webgpuInWorker` usa una euristica basata su User-Agent perche non esiste un modo affidabile per testare WebGPU in un Worker dal Main Thread senza avviare effettivamente un Worker e tentare `navigator.gpu.requestAdapter()`.

---

## 3. Struttura dei File

```
HyperionEngine/
├── Cargo.toml                          # Workspace root (edition 2024, fat LTO in release)
├── Cargo.lock                          # Lockfile delle dipendenze Rust
├── CLAUDE.md                           # Istruzioni per Claude Code
├── PROJECT_ARCHITECTURE.md             # Questo documento
├── docs/
│   └── plans/
│       ├── 2026-02-17-hyperion-engine-design.md     # Architectural Design Document (completo)
│       └── 2026-02-17-hyperion-engine-phase0-phase1.md  # Implementation plan Phase 0-1
├── crates/
│   └── hyperion-core/
│       ├── Cargo.toml                  # Crate config: wasm-bindgen, hecs, glam, bytemuck
│       └── src/
│           ├── lib.rs                  # WASM exports: engine_init, engine_attach_ring_buffer,
│           │                           #   engine_update, engine_tick_count
│           ├── engine.rs               # Engine struct: fixed-timestep accumulator, tick loop,
│           │                           #   spiral-of-death cap, interpolation alpha
│           ├── command_processor.rs     # EntityMap (sparse Vec + free-list) + process_commands()
│           ├── ring_buffer.rs          # SPSC consumer: atomic heads, circular read, CommandType enum
│           ├── components.rs           # Position, Rotation, Scale, Velocity, ModelMatrix, Active
│           │                           #   — tutti #[repr(C)] Pod per GPU upload
│           └── systems.rs              # velocity_system, transform_system, count_active
└── ts/
    ├── package.json                    # Scripts: dev, build, build:wasm, test
    ├── tsconfig.json                   # strict, ES2022, bundler moduleResolution
    ├── vite.config.ts                  # COOP/COEP headers, esnext target
    ├── index.html                      # Canvas + info overlay + module script entry
    └── src/
        ├── main.ts                     # Entry point: detect → bridge → RAF loop
        ├── capabilities.ts             # detectCapabilities(), selectExecutionMode(), logCapabilities()
        ├── capabilities.test.ts        # 4 test: mode selection across capability combinations
        ├── ring-buffer.ts              # RingBufferProducer: Atomics-based SPSC producer, CommandType enum
        ├── ring-buffer.test.ts         # 5 test: write/read/overflow/sequential
        ├── worker-bridge.ts            # EngineBridge interface, createWorkerBridge(), createDirectBridge()
        ├── engine-worker.ts            # Web Worker: WASM init + tick loop dispatch
        └── integration.test.ts         # 2 test: binary protocol validation + graceful degradation
```

---

## 4. Core Pipeline: Flusso di un Frame

### Diagramma Completo

```
                              MAIN THREAD
                    ┌─────────────────────────────┐
                    │         main.ts              │
                    │                              │
                    │  requestAnimationFrame(frame) │
                    │         │                    │
                    │         ▼                    │
                    │  dt = (now - lastTime) / 1000│
                    │         │                    │
                    │         ▼                    │
                    │  bridge.tick(dt)              │
                    └──────────┬──────────────────-┘
                               │
                   ┌───────────┴───────────┐
                   │ Mode A/B              │ Mode C
                   ▼                       ▼
    ┌────────────────────────┐  ┌────────────────────────┐
    │ worker.postMessage(    │  │ (direct function call)  │
    │   { type:"tick", dt }) │  │                        │
    └──────────┬─────────────┘  └──────────┬─────────────┘
               │                           │
               ▼                           ▼
              ENGINE WORKER (o Main Thread in Mode C)
    ┌────────────────────────────────────────────────────┐
    │                engine_update(dt)                    │
    │                                                    │
    │  ┌─── Phase 1: Command Drain ──────────────────┐   │
    │  │  RingBufferConsumer.drain()                  │   │
    │  │    ▼ read write_head (Acquire)               │   │
    │  │    ▼ while read_head != write_head:          │   │
    │  │        parse [cmd_type: u8]                  │   │
    │  │        parse [entity_id: u32 LE]             │   │
    │  │        parse [payload: 0-16 bytes]           │   │
    │  │    ▼ store read_head (Release)               │   │
    │  │  Output: Vec<Command>                        │   │
    │  └─────────────────────────────────────────────┘   │
    │                      │                             │
    │                      ▼                             │
    │  ┌─── Phase 2: Command Processing ─────────────┐   │
    │  │  process_commands(&commands, &world, &map)   │   │
    │  │    for cmd in commands:                      │   │
    │  │      SpawnEntity   → world.spawn(archetype)  │   │
    │  │      DespawnEntity → world.despawn(entity)   │   │
    │  │      SetPosition   → pos.0 = Vec3::new(...)  │   │
    │  │      SetRotation   → rot.0 = Quat::new(...)  │   │
    │  │      SetScale      → scale.0 = Vec3::new(..) │   │
    │  │      SetVelocity   → vel.0 = Vec3::new(...)  │   │
    │  └─────────────────────────────────────────────┘   │
    │                      │                             │
    │                      ▼                             │
    │  ┌─── Phase 3: Fixed-Timestep Tick Loop ───────┐   │
    │  │  accumulator += dt                           │   │
    │  │  cap: accumulator = min(acc, FIXED_DT * 10)  │   │
    │  │                                              │   │
    │  │  while accumulator >= FIXED_DT:              │   │
    │  │    ┌── fixed_tick() ──────────────────────┐  │   │
    │  │    │  velocity_system(&world, FIXED_DT)   │  │   │
    │  │    │    pos.0 += vel.0 * dt               │  │   │
    │  │    └──────────────────────────────────────┘  │   │
    │  │    accumulator -= FIXED_DT                   │   │
    │  │    tick_count += 1                           │   │
    │  └──────────────────────────────────────────────┘   │
    │                      │                             │
    │                      ▼                             │
    │  ┌─── Phase 4: Transform Recomputation ────────┐   │
    │  │  transform_system(&world)                    │   │
    │  │    Mat4::from_scale_rotation_translation(    │   │
    │  │        scale.0, rot.0, pos.0)                │   │
    │  │    matrix.0 = m.to_cols_array()              │   │
    │  │  Output: ModelMatrix — GPU-ready [f32; 16]   │   │
    │  └──────────────────────────────────────────────┘   │
    └────────────────────────────────────────────────────┘
```

### Phase 1: Command Drain

**File**: `crates/hyperion-core/src/ring_buffer.rs` — `RingBufferConsumer::drain()`

Il consumer legge `write_head` con `Ordering::Acquire` (garanzia: tutte le scritture del producer prima dello store di `write_head` sono visibili). Poi itera il buffer circolare decodificando messaggi:

```
Byte 0:     cmd_type (u8)  — discriminant CommandType
Bytes 1-4:  entity_id (u32, little-endian)
Bytes 5+:   payload (0, 12, o 16 bytes a seconda di cmd_type)
```

Ogni messaggio ha dimensione variabile determinata da `CommandType::message_size()`. Il consumer gestisce il wrap-around modulo `capacity` sia per il byte singolo che per letture multi-byte. Al termine, aggiorna `read_head` con `Ordering::Release` per segnalare al producer che lo spazio e stato liberato.

**Gestione errori**: Se `CommandType::from_u8()` restituisce `None` (byte corrotto), il consumer salta a `write_head` (recovery) e interrompe il drain. Se il messaggio e incompleto (meno byte disponibili di `message_size`), il drain si ferma e ritenta al frame successivo.

### Phase 2: Command Processing

**File**: `crates/hyperion-core/src/command_processor.rs` — `process_commands()`

Itera il `Vec<Command>` e muta il mondo ECS via pattern matching sul `CommandType`:

| CommandType | Azione ECS | Payload |
|---|---|---|
| `SpawnEntity` (1) | `world.spawn((Position, Rotation, Scale, Velocity, ModelMatrix, Active))` + `entity_map.insert(id, entity)` | Nessuno |
| `DespawnEntity` (2) | `world.despawn(entity)` + `entity_map.remove(id)` | Nessuno |
| `SetPosition` (3) | `pos.0 = Vec3::new(x, y, z)` | 12 bytes: 3 × f32 LE |
| `SetRotation` (4) | `rot.0 = Quat::from_xyzw(x, y, z, w)` | 16 bytes: 4 × f32 LE |
| `SetScale` (5) | `scale.0 = Vec3::new(x, y, z)` | 12 bytes: 3 × f32 LE |
| `SetVelocity` (6) | `vel.0 = Vec3::new(x, y, z)` | 12 bytes: 3 × f32 LE |
| `Noop` (0) | Nulla | Nessuno |

I comandi su entita inesistenti vengono silenziosamente ignorati (nessun panic). Questo e intenzionale: tra la scrittura del comando su JS e il suo processamento su Rust, l'entita potrebbe essere stata gia despawnata.

### Phase 3: Fixed-Timestep Tick Loop

**File**: `crates/hyperion-core/src/engine.rs` — `Engine::update()`

Il pattern **fixed-timestep con accumulatore** garantisce determinismo fisico indipendentemente dal framerate. `dt` (variabile, da `requestAnimationFrame`) viene accumulato. Quando l'accumulatore supera `FIXED_DT` (1/60s = 16.67ms), uno o piu tick fissi vengono eseguiti:

```
dt: 33ms (30 FPS)
accumulator prima: 0ms
accumulator dopo += 33ms
tick 1: accumulator 33ms >= 16.67ms → velocity_system(FIXED_DT) → accumulator = 16.33ms
tick 2: accumulator 16.33ms >= 16.67ms? NO → esce
tick_count: +1
accumulator residuo: 16.33ms (usato per interpolation_alpha)
```

**Spiral of death cap**: Se il frame impiega troppo (es. tab in background per secondi), `accumulator` verrebbe saturato causando centinaia di tick di recupero. Il cap `FIXED_DT * 10` limita a massimo 10 tick per frame, sacrificando la correttezza temporale per evitare il freeze.

### Phase 4: Transform Recomputation

**File**: `crates/hyperion-core/src/systems.rs` — `transform_system()`

Eseguita **una volta dopo tutti i tick** (non per-tick), computa la `ModelMatrix` 4×4 da Position + Rotation + Scale usando `glam::Mat4::from_scale_rotation_translation()`. Il risultato e un array `[f32; 16]` in layout colonna-maggiore, pronto per upload diretto in un `StorageBuffer` WebGPU.

---

## 5. Algoritmi e Logica Chiave

### 5.1 Ring Buffer: Protocollo Binario SPSC

Il ring buffer implementa il pattern **Single-Producer Single-Consumer** (SPSC) senza lock, basandosi esclusivamente sulle garanzie di ordering degli atomics.

**Layout memoria** (SharedArrayBuffer):

```
Offset (bytes)    Dimensione    Descrizione
+──────────────────────────────────────────────────────────+
| 0                4 bytes       write_head (u32, atomic)  |  ← scritto da JS
| 4                4 bytes       read_head  (u32, atomic)  |  ← scritto da Rust
| 8                4 bytes       capacity   (u32, const)   |
| 12               4 bytes       padding (allineamento 16) |
+──────────────────────────────────────────────────────────+
| 16               capacity      data region (comandi)     |
+──────────────────────────────────────────────────────────+
```

**Protocollo di sincronizzazione**:

```
                    JS (Producer)                         Rust (Consumer)
                    ─────────────                         ───────────────
                    1. Scrivi dati nella data region
                    2. Atomics.store(write_head, new_pos)
                       ↓ [Release semantics]
                                                          3. AtomicU32.load(write_head, Acquire)
                                                             ↓ [vede tutte le scritture prima del Release]
                                                          4. Leggi dati dalla data region
                                                          5. AtomicU32.store(read_head, new_pos, Release)
                       ↓ [next frame]
                    6. Atomics.load(read_head)
                       ↓ [sa quanto spazio e libero]
```

**Formato messaggio** (variable-length):

```
+----------+-----------+-------------------+
| cmd_type | entity_id |     payload       |
|  1 byte  |  4 bytes  |  0-16 bytes       |
|   u8     |  u32 LE   |  f32[] LE         |
+----------+-----------+-------------------+
```

**Distinzione full vs empty**: Il buffer riserva sempre 1 byte — `freeSpace = capacity - 1` quando vuoto. Questo evita l'ambiguita tra `write_head == read_head` (vuoto) e `write_head == read_head` dopo un giro completo (pieno).

**Wrap-around**: Sia il producer che il consumer applicano `offset % capacity` su ogni accesso alla data region. Per letture multi-byte che attraversano il confine, il consumer legge byte per byte con wrap individuale (non `memcpy` — sarebbe scorretto ai confini).

### 5.2 EntityMap: Sparse Vec con Free-List Recycling

**File**: `crates/hyperion-core/src/command_processor.rs` — `EntityMap`

Il problema: TypeScript assegna ID sequenziali alle entita (0, 1, 2, ...). `hecs` usa `Entity` opachi interni. Serve un mapping bidirezionale veloce.

**Soluzione**: `Vec<Option<hecs::Entity>>` indicizzato dall'ID esterno (O(1) lookup) + free-list `Vec<u32>` per riciclare ID dopo despawn.

```
                EntityMap
                ┌───────────────────────────────────┐
  map (Vec):    │ Some(E0) │ None │ Some(E2) │ None │
  index:        │    0     │  1   │    2     │  3   │
                └───────────────────────────────────┘
  free_list:    [1, 3]    ← ID riciclabili (LIFO)
  next_id:      4         ← prossimo ID se free_list vuota

  allocate() → pop free_list → 3
  allocate() → pop free_list → 1
  allocate() → free_list vuota → next_id++ → 4
```

**Perche non una HashMap?** Per 100k entita, una `HashMap<u32, Entity>` ha overhead di hashing e chaining. Un `Vec` indicizzato direttamente ha lookup O(1) con cache-friendliness perfetta. Il costo e spazio — se gli ID sono sparsi, il Vec ha buchi. Ma con la free-list, gli ID vengono riciclati mantenendo il Vec compatto.

### 5.3 Timestep Fisso con Accumulatore

**File**: `crates/hyperion-core/src/engine.rs`

L'algoritmo e il classico "Fix Your Timestep" (Fiedler, 2004):

```
const FIXED_DT: f32 = 1.0 / 60.0;  // 16.67ms

fn update(&mut self, dt: f32, commands: &[Command]) {
    process_commands(commands, ...);     // 1. Muta il mondo

    self.accumulator += dt;              // 2. Accumula tempo variabile

    // 3. Cap anti spiral-of-death
    if self.accumulator > FIXED_DT * 10.0 {
        self.accumulator = FIXED_DT * 10.0;
    }

    // 4. Tick fissi deterministici
    while self.accumulator >= FIXED_DT {
        self.fixed_tick();               //    velocity_system(FIXED_DT)
        self.accumulator -= FIXED_DT;
        self.tick_count += 1;
    }

    transform_system(&mut self.world);   // 5. Model matrix (una volta)
}
```

**Perche il transform_system e fuori dal loop dei tick?** Le model matrix servono solo per il rendering, che avviene una volta per frame. Ricalcolarle per ogni tick fisso sprecherebbe cicli — il rendering vedra solo lo stato dell'ultimo tick.

**Interpolation alpha**: `accumulator / FIXED_DT` (range 0.0–1.0) rappresenta quanto del prossimo tick e gia accumulato. Utile per il rendering interpolato tra tick fissi (smooth visual motion a framerate superiori a 60fps). Esposto come `Engine::interpolation_alpha()`.

### 5.4 Transform System: SRT → Mat4 Column-Major

**File**: `crates/hyperion-core/src/systems.rs` — `transform_system()`

```rust
let m = Mat4::from_scale_rotation_translation(scale.0, rot.0, pos.0);
matrix.0 = m.to_cols_array();
```

`glam::Mat4::from_scale_rotation_translation()` compone la matrice nell'ordine standard GPU: **Scale → Rotate → Translate**. Il risultato e un array `[f32; 16]` in layout **colonna-maggiore** (column-major), che e il formato nativo di WebGPU/WGSL:

```
Indice:  [0]  [1]  [2]  [3]  [4]  [5]  [6]  [7]  [8]  [9]  [10] [11] [12] [13] [14] [15]
Layout:  sx   0    0    0    0    sy   0    0    0    0    sz   0    tx   ty   tz   1
         ├── col 0 ──┤  ├── col 1 ──┤  ├── col 2 ──┤  ├── col 3 ──┤
         (X axis)       (Y axis)       (Z axis)       (Translation)
```

(Con rotazione e scale non-unitaria la struttura e piu complessa, ma le colonne 12-14 sono sempre la traslazione.)

---

## 6. Strutture Dati Chiave

### ECS Components

Tutti i componenti spaziali sono `#[repr(C)]` con `bytemuck::Pod` + `Zeroable`. Questo garantisce:
- **Layout deterministico** indipendente dal compilatore (nessun padding arbitrario)
- **Cast sicuro a byte slice** per upload diretto in `StorageBuffer` GPU
- **Nessun campo non-Pod** (no String, no Vec, no puntatori) — solo dati plain

```rust
#[repr(C)] struct Position(pub Vec3);       // 12 bytes (3 × f32)
#[repr(C)] struct Rotation(pub Quat);       // 16 bytes (4 × f32)
#[repr(C)] struct Scale(pub Vec3);          // 12 bytes (3 × f32)
#[repr(C)] struct Velocity(pub Vec3);       // 12 bytes (3 × f32)
#[repr(C)] struct ModelMatrix(pub [f32; 16]); // 64 bytes (4×4 matrix)
            struct Active;                    // 0 bytes (tag component)
```

| Componente | Default | Scopo |
|---|---|---|
| `Position` | `Vec3::ZERO` | Posizione world-space |
| `Rotation` | `Quat::IDENTITY` | Rotazione come quaternione |
| `Scale` | `Vec3::ONE` | Scala non-uniforme |
| `Velocity` | `Vec3::ZERO` | Velocita lineare (unita/secondo) |
| `ModelMatrix` | `Mat4::IDENTITY` | Matrice 4×4 per la GPU, ricalcolata ogni frame |
| `Active` | — | Marker component: entita attiva e simulabile |

**Perche `Active` e un marker component e non un bool?** In un ECS, i marker component permettono di filtrare le query senza overhead. `world.query::<&Active>()` itera solo le entita con il tag, usando l'archetype index di `hecs`. Un `bool` richiederebbe un branch per entita.

### CommandType (sincronizzato Rust ↔ TypeScript)

```
      Rust (ring_buffer.rs)                TypeScript (ring-buffer.ts)
      ─────────────────────                ─────────────────────────────
      #[repr(u8)]                          const enum CommandType {
      pub enum CommandType {                 Noop = 0,
          Noop = 0,                          SpawnEntity = 1,
          SpawnEntity = 1,                   DespawnEntity = 2,
          DespawnEntity = 2,                 SetPosition = 3,
          SetPosition = 3,                   SetRotation = 4,
          SetRotation = 4,                   SetScale = 5,
          SetScale = 5,                      SetVelocity = 6,
          SetVelocity = 6,                 }
      }
```

I discriminanti `u8` **devono restare sincronizzati manualmente**. Non esiste code generation automatica tra Rust e TypeScript. Aggiungere un comando richiede la modifica di entrambi i file + la tabella `PAYLOAD_SIZES` in TypeScript + `payload_size()` in Rust.

### Command

```rust
pub struct Command {
    pub cmd_type: CommandType,  // Discriminante del comando
    pub entity_id: u32,         // ID entita esterna (dal TS)
    pub payload: [u8; 16],      // Max 16 bytes (quaternione). Solo i primi
                                // cmd_type.payload_size() bytes sono significativi.
}
```

Il payload e un array fisso di 16 byte (il massimo — `SetRotation` usa 4 × f32 = 16). I comandi con payload piu piccolo (o nessuno) usano solo i primi N byte; il resto e zero-padded.

### EngineBridge (TypeScript)

```typescript
interface EngineBridge {
    mode: ExecutionMode;           // "A", "B", o "C"
    commandBuffer: RingBufferProducer;
    tick(dt: number): void;        // Worker: postMessage. Mode C: sync call.
    ready(): Promise<void>;        // Risolve quando WASM e caricato.
    destroy(): void;               // Worker: terminate(). Mode C: noop.
}
```

`EngineBridge` e il **contratto uniforme** tra il main loop e il backend di esecuzione. Il codice in `main.ts` non sa (e non deve sapere) se gira in Worker o in single-thread. La factory `createWorkerBridge()` o `createDirectBridge()` restituisce l'implementazione corretta.

### Engine (Rust)

```rust
pub struct Engine {
    pub world: World,              // hecs ECS world
    pub entity_map: EntityMap,     // ID esterno → Entity interno
    accumulator: f32,              // Tempo residuo non ancora consumato da tick fissi
    tick_count: u64,               // Contatore monotono di tick fissi eseguiti
}
```

L'Engine e il **Mediator** che coordina tutti i sottosistemi. Non e un singleton nel senso classico — e wrappato in un `Option<Engine>` statico mutable solo perche WASM richiede un punto di accesso globale per le funzioni `#[wasm_bindgen]`. Su wasm32 (single-threaded per definizione), `static mut` e sicuro con adeguati commenti `// SAFETY`.

---

## 7. WASM Layer: Singletoni e Safety

**File**: `crates/hyperion-core/src/lib.rs`

Il layer WASM espone 4 funzioni esterne + 1 smoke test:

```rust
static mut ENGINE: Option<Engine> = None;
static mut RING_BUFFER: Option<RingBufferConsumer> = None;

#[wasm_bindgen] pub fn engine_init()
#[wasm_bindgen] pub fn engine_attach_ring_buffer(ptr: *mut u8, capacity: usize)
#[wasm_bindgen] pub fn engine_update(dt: f32)
#[wasm_bindgen] pub fn engine_tick_count() -> u64
#[wasm_bindgen] pub fn add(a: i32, b: i32) -> i32  // smoke test
```

**Perche `static mut` e safe qui?** `wasm32-unknown-unknown` e single-threaded per specifica. Non esiste parallelismo reale — anche con `SharedArrayBuffer`, il modulo WASM gira su un singolo thread. Ogni `unsafe` block ha un commento `// SAFETY` che documenta questa invariante.

**Perche `addr_of_mut!()` invece di `&mut`?** Rust 2024 edition rende UB la creazione di riferimenti a `static mut` non inizializzati. `addr_of_mut!(ENGINE).write(Some(...))` scrive attraverso un raw pointer senza mai creare un `&mut Option<Engine>`, evitando il problema.

**Perche `engine_tick_count()` restituisce `u64` (che diventa `BigInt` in JS)?** Il tick counter puo superare 2^32 dopo ~828 giorni di esecuzione continua. `wasm-bindgen` mappa `u64` a `BigInt` automaticamente. Il Worker wrappa con `Number(...)` che e safe per valori < 2^53 (~2.85 × 10^8 anni).

---

## 8. Worker Architecture

### Ciclo di Vita del Worker

**File**: `ts/src/engine-worker.ts`

```
Main Thread                                  Engine Worker
────────────                                 ─────────────
postMessage({type:"init", commandBuffer})
    ──────────────────────────────────>
                                             import("../wasm/hyperion_core.js")
                                             await wasm.default()
                                             wasm.engine_init()
                                             store commandBufferRef
    <──────────────────────────────────
postMessage({type:"ready"})

[RAF loop starts]

postMessage({type:"tick", dt: 0.016})
    ──────────────────────────────────>
                                             wasm.engine_update(msg.dt)
                                             tickCount = Number(wasm.engine_tick_count())
    <──────────────────────────────────
postMessage({type:"tick-done", dt, tickCount})
```

### Messaggi Worker

| Messaggio | Direzione | Payload | Scopo |
|---|---|---|---|
| `init` | Main → Worker | `{ commandBuffer: SharedArrayBuffer }` | Passa il SAB e avvia init WASM |
| `ready` | Worker → Main | `{}` | Segnala che WASM e pronto |
| `error` | Worker → Main | `{ error: string }` | Errore durante init |
| `tick` | Main → Worker | `{ dt: number }` | Richiede un frame update |
| `tick-done` | Worker → Main | `{ dt, tickCount }` | Conferma completamento frame |

### Stato Attuale del Ring Buffer nel Worker

Il collegamento ring buffer SAB → WASM non e ancora completato. Attualmente il Worker:
1. Riceve il SAB e lo conserva in `commandBufferRef`
2. Chiama `engine_update(dt)` che internamente crea un `Vec::new()` vuoto (nessun comando)
3. L'attach di `engine_attach_ring_buffer` richiede il passaggio del puntatore SAB nella memoria lineare WASM, che necessita di supporto `wasm-bindgen` per SharedArrayBuffer (previsto Phase 2)

---

## 9. Architettura a Strati (Layered)

```
+═══════════════════════════════════════════════════════════════+
║                    Browser Entry (HTML + Vite)                ║
║  index.html → <script type="module" src="main.ts">           ║
+═══════════════════════════════════════════════════════════════+
║                   Orchestration Layer (TS)                    ║
║  main.ts → detectCapabilities → selectMode → createBridge    ║
║            → requestAnimationFrame loop → bridge.tick(dt)     ║
+═══════════════════════════════════════════════════════════════+
║                   Bridge Layer (TS)                           ║
║  worker-bridge.ts → EngineBridge interface                    ║
║    createWorkerBridge() — Mode A/B (Worker + SAB)             ║
║    createDirectBridge() — Mode C (direct + ArrayBuffer)       ║
+═══════════════════════════════════════════════════════════════+
║               Communication Layer (TS ↔ Rust)                 ║
║  ring-buffer.ts → RingBufferProducer (Atomics, DataView)      ║
║  ring_buffer.rs → RingBufferConsumer (AtomicU32, raw ptr)     ║
║  SharedArrayBuffer: [header 16B][data region]                 ║
+═══════════════════════════════════════════════════════════════+
║                   Simulation Layer (Rust/WASM)                ║
║  lib.rs       → WASM exports (engine_init, engine_update)     ║
║  engine.rs    → Fixed-timestep accumulator, tick loop         ║
║  command_processor.rs → EntityMap + process_commands()         ║
+═══════════════════════════════════════════════════════════════+
║                     ECS Layer (Rust)                          ║
║  components.rs → Position, Rotation, Scale, Velocity, etc.   ║
║  systems.rs    → velocity_system, transform_system            ║
║  hecs::World   → Archetype storage, component queries         ║
+═══════════════════════════════════════════════════════════════+
║                    Math Foundation (Rust)                     ║
║  glam::Vec3, glam::Quat, glam::Mat4 — SIMD-accelerated      ║
║  bytemuck::Pod — safe transmute to GPU-uploadable bytes       ║
+═══════════════════════════════════════════════════════════════+
```

Ogni strato dipende solo dallo strato immediatamente inferiore. I componenti ECS non sanno nulla del ring buffer. Il ring buffer non sa nulla del Worker. Il bridge non sa nulla di `requestAnimationFrame`. Questo permette di testare ogni strato in isolamento.

---

## 10. Testing

### Struttura (22 test Rust across 5 moduli + 11 test TypeScript across 3 file)

Il test suite e organizzato in due livelli per linguaggio:

**Rust** — Unit test inline `#[cfg(test)] mod tests` in ogni modulo:

```
crates/hyperion-core/src/
  ring_buffer.rs          5 test: empty drain, spawn read, position+payload, multiple cmds, read_head advance
  components.rs           4 test: default values (position, rotation, scale), Pod transmute (ModelMatrix)
  command_processor.rs    5 test: spawn, set position, despawn, ID recycling, nonexistent entity safety
  engine.rs               4 test: commands+ticks integration, accumulator, spiral-of-death, model matrix
  systems.rs              4 test: velocity moves position, transform→matrix, scale in matrix, count_active
```

**TypeScript** — File `.test.ts` colocati in `ts/src/`:

```
ts/src/
  capabilities.test.ts    4 test: Mode A/B/C selection across capability combinations
  ring-buffer.test.ts     5 test: free space, spawn write, position+payload, overflow, sequential writes
  integration.test.ts     2 test: binary protocol validation (offset assertions), graceful degradation
```

### Pattern di Test: Cross-Boundary Protocol Verification

I test di integrazione TypeScript verificano che i byte prodotti da `RingBufferProducer` corrispondano esattamente al formato atteso dal consumer Rust. Non testano il consumer Rust direttamente (non possono — sono in processi diversi), ma asseriscono sugli offset, sui valori dei byte e sull'avanzamento dell'`write_head`:

```typescript
// Verifica che spawn(0) + setPosition(0, ...) + despawn(0) producano esattamente 27 bytes
// e che i discriminanti siano nelle posizioni corrette
expect(writeHead).toBe(27);           // 5 + 17 + 5
expect(data[0]).toBe(CommandType.SpawnEntity);   // offset 0
expect(data[5]).toBe(CommandType.SetPosition);   // offset 5
expect(data[22]).toBe(CommandType.DespawnEntity); // offset 22
```

I test Rust verificano il lato consumer con buffer simulati in memoria heap (non veri SharedArrayBuffer — non disponibili in `cargo test`). I test impostano `write_head` e dati manualmente, poi chiamano `drain()` e asseriscono sul contenuto dei `Command` parsati.

### Convenzioni

- **Inline**: I test Rust vivono nel file del modulo che testano, dentro `#[cfg(test)] mod tests {}`. Nessuna directory `tests/` separata.
- **Colocated**: I test TypeScript vivono accanto al modulo (es. `ring-buffer.ts` → `ring-buffer.test.ts`). Nessuna directory `__tests__/`.
- **Factory helpers**: Sia Rust che TypeScript usano funzioni helper per creare fixture con defaults sensati (`make_spawn_cmd()`, `makeCaps()`, `makeBuffer()`).
- **Nessun mock I/O**: Tutti i test sono puri — nessun mock di filesystem, network o browser API.

### Comandi

```bash
# Rust — 22 test
cargo test -p hyperion-core                           # Tutti
cargo test -p hyperion-core engine::tests::spiral_of_death_capped  # Singolo
cargo clippy -p hyperion-core                         # Lint

# TypeScript — 11 test
cd ts && npm test                                     # Tutti (vitest run)
cd ts && npm run test:watch                           # Watch mode
cd ts && npx vitest run src/ring-buffer.test.ts       # Singolo file
cd ts && npx tsc --noEmit                             # Type-check solo
```

---

## 11. Build Pipeline

### WASM Build

```bash
cd ts && npm run build:wasm
# Equivale a:
wasm-pack build ../crates/hyperion-core --target web --out-dir ../../ts/wasm
```

**Output** in `ts/wasm/`:

| File | Scopo |
|---|---|
| `hyperion_core.js` | JS glue code (ESM) — init(), funzioni wrapper |
| `hyperion_core_bg.wasm` | Binary WASM compilato |
| `hyperion_core.d.ts` | Type declarations per TypeScript |
| `hyperion_core_bg.wasm.d.ts` | Types per il modulo raw WASM |
| `package.json` | Metadata wasm-pack |

**Nota `--out-dir`**: Il path e relativo alla directory del crate (`crates/hyperion-core/`), non alla workspace root. `../../ts/wasm` naviga due livelli su e poi in `ts/wasm`.

### Profili di Compilazione Rust

```toml
# Cargo.toml (workspace root)
[profile.release]
opt-level = 3        # Massima ottimizzazione
lto = "fat"          # Link-Time Optimization cross-crate
codegen-units = 1    # Singola unita per migliore inlining

[profile.dev]
opt-level = 1        # Minima ottimizzazione (build veloce ma non lento a runtime)
debug = true         # Debug symbols per stack traces leggibili
```

`lto = "fat"` e `codegen-units = 1` in release sono critici per WASM: permettono al compilatore di eliminare tutto il dead code cross-crate, riducendo significativamente la dimensione del `.wasm`.

### Dev Server

```bash
cd ts && npm run dev   # vite
```

Il Vite dev server serve gli header COOP/COEP necessari per SharedArrayBuffer e compila TypeScript e il Worker ESM al volo. Il Worker usa `new URL("./engine-worker.ts", import.meta.url)` — Vite riconosce il pattern e bundla il Worker separatamente.

---

## 12. Decisioni Architetturali Chiave

| Decisione | Alternative Valutate | Motivazione |
|---|---|---|
| **hecs** per ECS | `bevy_ecs`, `specs`, `legion` | `bevy_ecs` perde parallelismo su WASM + binary bloat. `hecs` ha iterazione single-thread equivalente con footprint minimo |
| **Ring buffer su SAB** | FFI sincrona, `postMessage` con transferable | FFI: overhead per-call insostenibile a scale. `postMessage`: serialization cost + nessun shared state |
| **Fixed timestep 1/60s** | Variable timestep, timestep adattivo | Determinismo fisico. Replay possibile. Nessun jitter dipendente dal framerate |
| **Spiral-of-death cap a 10 tick** | Cap a 3, nessun cap, time scaling | 10 e un compromesso: permette catch-up dopo brevi stall senza freeze catastrofici |
| **`addr_of_mut!()` per static mut** | `lazy_static`, `OnceCell`, raw pointers | Required da Rust 2024 edition. `lazy_static` e `OnceCell` aggiungono overhead di inizializzazione che non serve su wasm32 single-threaded |
| **`#[repr(C)]` + `Pod` su tutti i componenti** | `repr(Rust)`, serde serialization | Upload GPU diretto senza copie. `bytemuck::bytes_of()` costa zero runtime |
| **`const enum` in TypeScript** | `enum`, string union, numeric constants | `const enum` e inlinato dal compiler — zero overhead runtime, nessun reverse mapping (non serve) |
| **Vite (non webpack/esbuild)** | webpack 5, esbuild standalone | Vite ha supporto nativo per Worker ESM, header custom, e HMR. Webpack richiederebbe plugin per Worker bundling |
| **Sparse Vec + free-list per EntityMap** | `HashMap<u32, Entity>`, `SlotMap` | O(1) lookup con cache-friendliness perfetta. Free-list mantiene ID compatti senza frammentazione |

---

## 13. Gotchas e Insidie

| Insidia | Causa | Soluzione Adottata |
|---|---|---|
| `hecs 0.11 query_mut` restituisce component tuples direttamente | API breaking tra 0.10 e 0.11 | `for (pos, vel) in world.query_mut::<(&mut Position, &Velocity)>()` — NO `(Entity, components)` |
| `u64` Rust → `BigInt` JS via wasm-bindgen | wasm-bindgen non ha altra scelta per u64 | Wrappare con `Number(wasm.engine_tick_count())` nel Worker (safe per valori < 2^53) |
| `wasm-bindgen` non puo esportare `unsafe fn` | Limitazione del proc macro | `#[allow(clippy::not_unsafe_ptr_arg_deref)]` su `engine_attach_ring_buffer` |
| `const enum` TS non ha reverse mapping | `CommandType[3]` non funziona (TS2476) | Loggare valori numerici direttamente, non tentare lookup inverso |
| `wasm-pack --out-dir` e relativo al crate | Non alla workspace root | Path `../../ts/wasm` nel script `build:wasm` |
| `SharedArrayBuffer` richiede COOP/COEP | Security policy del browser | Headers in `vite.config.ts`; in produzione serve configurazione server |
| `Atomics` non disponibili senza cross-origin isolation | Conseguenza di COOP/COEP mancanti | Fallback a `ArrayBuffer` + Mode C in `createRingBuffer()` |
| `static mut` in Rust 2024 | Creating references to `static mut` is UB | `addr_of_mut!()` per scrivere senza creare `&mut` |
| Tipi public con `new()` senza parametri | Clippy `new_without_default` | `impl Default` esplicito su `Engine` e `EntityMap` |

---

## 14. Limitazioni Note e Blind Spot

| Limitazione | Causa | Impatto | Stato |
|---|---|---|---|
| Ring buffer non collegato a WASM memory | `wasm-bindgen` non supporta passaggio puntatore SAB in memory lineare | Commands prodotti da TS non ancora consumati da Rust nel Worker | Phase 2 risolvera |
| Mode C `tick()` e un noop | Implementazione placeholder | Single-thread mode non esegue simulazione | Phase 2 risolvera |
| Nessun rendering | Phase 2 non implementata | L'engine calcola model matrices ma non le visualizza | Prossima fase |
| Nessun input handling | Phase 6 | L'engine non processa eventi tastiera/mouse | Futuro |
| `webgpuInWorker` detection via UA string | Non esiste API per testare WebGPU in Worker dal Main Thread | Falsi negativi su browser non-Chromium con supporto futuro | Aggiornare euristica quando Firefox supporta |
| `RingBufferConsumer::drain()` alloca `Vec` per frame | Nessun object pool | Pressione GC minima (il Vec e in Rust, non JS) ma non zero-alloc | Ottimizzazione futura con pre-allocated buffer |
| Entity IDs non compattati dopo molti spawn/despawn | Free-list LIFO puo lasciare buchi nel Vec | Spreco di memoria per mappe molto sparse | Accettabile per < 1M entita |
| Nessuna validazione del quaternione in `SetRotation` | Il payload e accettato cosi com'e | Quaternioni non normalizzati producono scale anomale nella model matrix | Aggiungere normalizzazione in `process_commands` |

---

## 15. Stato di Implementazione

### Roadmap Fasi

| Fase | Nome | Stato | Deliverables |
|---|---|---|---|
| **0** | Scaffold & Execution Harness | **Completata** | Workspace Rust, Vite dev server, capability detection, mode selection A/B/C, ring buffer SPSC, Worker bridge |
| **1** | ECS Core | **Completata** | `hecs` integration, componenti SoA, transform system, tick loop deterministico, command processor |
| **2** | Render Core | Prossima | wgpu init, OffscreenCanvas transfer (Mode A), draw pipeline base, debug overlay |
| **3** | GPU-Driven Pipeline | Pianificata | WGSL compute culling, StorageBuffer layout, indirect draw, Texture2DArray |
| **4** | Asset Pipeline & Textures | Pianificata | `createImageBitmap` flow, texture array packing, KTX2/Basis Universal |
| **5** | TypeScript API & Lifecycle | Pianificata | API consumer, `dispose()` + `using`, FinalizationRegistry, entity pooling |
| **6** | Audio & Input | Pianificata | AudioWorklet isolation, predictive input layer |
| **7** | Polish & DX | Pianificata | Shader hot-reload, dev watch mode, performance profiler |

### Metriche Attuali

| Metrica | Valore |
|---|---|
| Test Rust | 22 (tutti passanti) |
| Test TypeScript | 11 (tutti passanti) |
| Moduli Rust | 5 (`lib`, `engine`, `command_processor`, `ring_buffer`, `components`, `systems`) |
| Moduli TypeScript | 5 (`main`, `capabilities`, `ring-buffer`, `worker-bridge`, `engine-worker`) |
| Dipendenze Rust (runtime) | 4 (`wasm-bindgen`, `hecs`, `glam`, `bytemuck`) |
| Dipendenze TypeScript (dev) | 3 (`typescript`, `vite`, `vitest`) |
| Dipendenze TypeScript (runtime) | 0 |

---

## 16. Guida all'Estendibilita

### 16.1 Aggiungere un Nuovo Comando

Per aggiungere un comando (es. `SetColor(r, g, b, a)`):

**Rust** (`ring_buffer.rs`):
1. Aggiungere variante a `CommandType`: `SetColor = 7`
2. Aggiungere `from_u8`: `7 => Some(Self::SetColor)`
3. Aggiungere `payload_size`: `Self::SetColor => 16` (4 × f32)

**Rust** (`command_processor.rs`):
4. Aggiungere branch nel match di `process_commands`

**TypeScript** (`ring-buffer.ts`):
5. Aggiungere a `CommandType`: `SetColor = 7`
6. Aggiungere a `PAYLOAD_SIZES`: `[CommandType.SetColor]: 16`
7. (Opzionale) Aggiungere convenience method su `RingBufferProducer`

**Test**:
8. Test Rust in `ring_buffer.rs::tests` per il parsing
9. Test Rust in `command_processor.rs::tests` per la mutazione ECS
10. Test TypeScript in `ring-buffer.test.ts` per la serializzazione
11. Test in `integration.test.ts` per la verifica cross-boundary degli offset

### 16.2 Aggiungere un Nuovo Componente ECS

1. Definire la struct in `components.rs` con `#[derive(Debug, Clone, Copy, Pod, Zeroable)]` e `#[repr(C)]`
2. Implementare `Default`
3. Aggiungere al bundle di spawn in `command_processor.rs` (se ogni entita lo ha)
4. Scrivere un sistema in `systems.rs` che opera sul nuovo componente
5. Registrare il sistema nel tick loop in `engine.rs` (`fixed_tick()` o `update()`)

### 16.3 Aggiungere un Nuovo Sistema ECS

I sistemi sono funzioni pure che prendono `&mut World` (e opzionalmente `dt`):

```rust
pub fn my_system(world: &mut World, dt: f32) {
    for (comp_a, comp_b) in world.query_mut::<(&mut CompA, &CompB)>() {
        // logica
    }
}
```

**Dove registrarlo**:
- Se deve girare a **frequenza fissa** (fisca, collision): dentro `Engine::fixed_tick()`
- Se deve girare **una volta per frame** (rendering prep, UI sync): dentro `Engine::update()`, dopo il loop dei tick

### 16.4 Aggiungere un Nuovo Execution Mode

Se emergesse la necessita di un Mode D (es. WebTransport per cloud rendering):

1. Aggiungere variante a `ExecutionMode` in `capabilities.ts`
2. Aggiungere logica di selezione in `selectExecutionMode()`
3. Creare nuova factory `createMyBridge()` in `worker-bridge.ts` che restituisca `EngineBridge`
4. Aggiungere branch in `main.ts`

Il codice del main loop non cambia — opera solo sull'interfaccia `EngineBridge`.

---

## 17. Glossario

| Termine | Significato |
|---|---|
| **SPSC** | Single-Producer Single-Consumer — pattern di ring buffer dove un solo thread scrive e un solo thread legge |
| **SAB** | SharedArrayBuffer — buffer di memoria condiviso tra thread (Main Thread e Worker) |
| **COOP/COEP** | Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy — header HTTP necessari per `crossOriginIsolated` |
| **ECS** | Entity Component System — pattern architetturale dove le entita sono ID, i componenti sono dati puri, i sistemi sono funzioni che iterano sui componenti |
| **SoA** | Struct of Arrays — layout di memoria dove componenti dello stesso tipo sono contigui, massimizzando cache hits |
| **Pod** | Plain Old Data — tipo che puo essere copiato bit-a-bit senza effetti collaterali (nessun Drop, nessun puntatore) |
| **FFI** | Foreign Function Interface — meccanismo di chiamata tra linguaggi diversi (qui JS ↔ WASM) |
| **Fixed timestep** | Simulazione a passo temporale fisso (1/60s) per determinismo, indipendente dal framerate di rendering |
| **Spiral of death** | Condizione dove il tempo accumulato cresce piu velocemente di quanto i tick fissi possano consumarlo, causando freeze esponenziale |
| **Accumulator** | Variabile `f32` che accumula il tempo di frame non ancora consumato da tick fissi |
| **Interpolation alpha** | Rapporto `accumulator / FIXED_DT` (0.0–1.0) usato per interpolare visivamente tra due tick fissi |
| **Column-major** | Layout di matrice dove le colonne sono contigue in memoria — formato nativo di WebGPU/WGSL e OpenGL |
| **EntityMap** | Mapping bidirezionale tra ID entita esterni (TypeScript, u32 sequenziali) e Entity interni (hecs, opachi) |
| **Free-list** | Stack LIFO di ID riciclabili dopo despawn, per evitare frammentazione degli ID |
| **EngineBridge** | Interfaccia TypeScript che astrae il transport (Worker `postMessage` vs chiamata diretta) |
| **Marker component** | Componente senza dati (`Active`) usato come filtro per le query ECS |
| **wasm-bindgen** | Macro e toolchain Rust che generano il JS glue code per le funzioni `#[wasm_bindgen]` |
| **addr_of_mut!()** | Macro Rust per ottenere un raw pointer a un `static mut` senza creare un riferimento (richiesto da edition 2024) |
