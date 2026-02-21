# PLAN_DOC_SYNC.md — Disallineamenti PROJECT_ARCHITECTURE.md vs Codice Sorgente

> **Data audit**: 2026-02-21 | **Copertura**: Fasi 0-7 complete, doc ferma a ~Phase 5/parziale 5.5

---

## Causa Radice

`PROJECT_ARCHITECTURE.md` e stato aggiornato parzialmente in piu momenti. Le sezioni narrative (ring buffer layout, RenderState struct, WASM exports, file tree) riflettono lo stato pre-Phase 5.5. La tabella "Metriche Attuali" (Sezione 16) e stata parzialmente aggiornata per Phase 5.5 ma non per Phase 6-7. Le sezioni 1, 15 e 16 dichiarano ancora Phase 6 e 7 come non implementate.

---

## Elenco Disallineamenti

### D01 — Titolo/header: conteggi test errati

- **Riga 3**: `88 test Rust across 7 moduli + 291 test TypeScript across 33 file`
- **Realta**: 88 Rust (corretto), ma **364 test TypeScript across 37 file**
- **Correzione**: Aggiornare i numeri TS a 364/37
- **Nota**: Il "291" non corrisponde a nessuna fase storica; il conteggio e stato aggiornato parzialmente. La versione dichiarata "0.10.0" con "(Phase 0-5.5 + Phase 4.5 + Post-Plan Integration + Phase 6 Input completate)" manca di Phase 7 Audio.

### D02 — Sezione 1 "Cosa NON fa": audio presente

- **Riga 19**: `Non gestisce audio (Phase 7)`
- **Realta**: Phase 7 (Audio System) e completata. Esistono `audio-manager.ts`, `sound-registry.ts`, `playback-engine.ts`, `audio-types.ts` con 67 test.
- **Correzione**: Rimuovere la riga sull'audio. Aggiungere invece limitazioni reali attuali (es. no networking, no 3D mesh, no SIMD128).

### D03 — Sezione 3 file tree: 25+ file mancanti

Il file tree (righe 157-281) e fermo a circa Phase 5. Mancano:

**Rust (riga 184)**: Dice "11 variants incl. SetParent" — sono **13** (aggiungere SetPrimParams0, SetPrimParams1). Dice "Position, Rotation, Scale, Velocity, ModelMatrix, BoundingRadius, TextureLayerIndex, MeshHandle, RenderPrimitive, Active, Parent, Children, LocalMatrix" — mancano **PrimitiveParams** e **ExternalId** (15 componenti totali).

**TS - Phase 5.5 render passes mancanti** (sotto `render/passes/`):
- `fxaa-tonemap-pass.ts` + `.test.ts` (3 test)
- `selection-seed-pass.ts` + `.test.ts` (3 test)
- `jfa-pass.ts` + `.test.ts` (9 test)
- `outline-composite-pass.ts` + `.test.ts` (6 test)

**TS - Phase 5.5 shaders mancanti** (sotto `shaders/`): Il tree elenca solo `basic.wgsl`, `cull.wgsl`, `prefix-sum.wgsl`. Mancano 8 shader:
- `line.wgsl`, `gradient.wgsl`, `box-shadow.wgsl`, `msdf-text.wgsl`, `fxaa-tonemap.wgsl`, `selection-seed.wgsl`, `jfa.wgsl`, `outline-composite.wgsl`

**TS - Phase 6 file mancanti**:
- `selection.ts` + `.test.ts` (10 test)
- `input-manager.ts` + `.test.ts` (24 test)
- `hit-tester.ts` + `.test.ts` (8 test)
- `immediate-state.ts` + `.test.ts` (8 test)
- `input-picking.test.ts` (3 test)

**TS - Phase 7 file mancanti**:
- `audio-types.ts` + `.test.ts` (3 test)
- `sound-registry.ts` + `.test.ts` (13 test)
- `playback-engine.ts` + `.test.ts` (26 test)
- `audio-manager.ts` + `.test.ts` (25 test)

**TS - Conteggi test errati nei commenti del file tree**:
| File | Dichiarato | Reale |
|---|---|---|
| `hyperion.test.ts` | 26 test | **45** test |
| `entity-handle.test.ts` | 17 test | **28** test |
| `backpressure.test.ts` | 12 test | **18** test |
| `camera.test.ts` | 10 test | **19** test |
| `types.test.ts` | 7 test | **4** test |
| `ring-buffer.test.ts` | 14 test | **16** test |
| `supervisor.test.ts` | 4 test | **5** test |
| `cull-pass.test.ts` | 1 test | **2** test |
| `forward-pass.test.ts` | 1 test | **2** test |

**TS - Descrizioni moduli stale nel file tree**:
- `hyperion.ts` (riga 203): Mancano `loadTextures`, `enableOutlines()/disableOutlines()`, `enablePostProcessing()`, `input`, `picking`, `audio`, `selection`
- `entity-handle.ts` (riga 208): Mancano `.line`, `.gradient`, `.boxShadow`, `.positionImmediate`, `.clearImmediate`
- `renderer.ts` (riga 246): Manca menzione di FXAATonemapPass, selection outlines, multi-pipeline, JFA pipeline
- `camera.ts` (riga 253): Mancano `mat4Inverse()`, `screenToRay()`

**docs/plans/ mancanti**:
- Il tree elenca un generico `2026-02-17-hyperion-engine-design.md` — il file reale si chiama `hyperion-engine-design-v3.md`
- Mancano completamente: `hyperion-engine-roadmap-unified-v3.md`, `2026-02-18-phase-4.5-stabilization-arch-foundations.md`, `2026-02-20-phase-5.5-rendering-primitives.md`, `2026-02-20-phase5-typescript-api-lifecycle.md`, `2026-02-20-post-plan-integration-wiring.md`, `2026-02-21-phase-6-input-system.md`, `2026-02-21-phase-7-audio-system.md`

### D04 — Sezione 4: Diagramma Phase 2 (Command Processing) incompleto

- **Righe 421-433**: La tabella CommandType elenca solo 11 varianti (Noop attraverso SetParent). Mancano **SetPrimParams0 (11)** e **SetPrimParams1 (12)** con le rispettive azioni ECS e payload (16 bytes ciascuno).
- **Riga 337**: Il diagramma di Phase 2 non menziona SetMeshHandle, SetRenderPrimitive, SetParent, SetPrimParams0/1.
- **Correzione**: Aggiungere le 2 righe mancanti alla tabella e i comandi mancanti al diagramma sintetico.

### D05 — Sezione 5.1: Header ring buffer 16 byte vs 32 byte

- **Righe 471-480**: Il diagramma mostra un header di 16 byte con 4 campi (write_head, read_head, capacity, padding) e data region a offset 16.
- **Realta**: L'header e **32 byte** con 8 campi: write_head, read_head, capacity, padding, heartbeat_w1, heartbeat_w2, supervisor_flags, overflow_counter. Data region inizia a offset 32.
- **Fonte**: `ring_buffer.rs:25` (`HEADER_SIZE = 32`), `ring-buffer.ts:1-13` (`HEADER_SIZE = 32`).
- **Correzione**: Aggiornare il diagramma dell'header e tutta la sezione che lo descrive.

### D06 — Sezione 6: ECS Components — Componenti mancanti

- **Righe 603-615**: La tabella dei componenti elenca 14 tipi ma ne mancano 2: `PrimitiveParams([f32; 8])` e `ExternalId(u32)`.
- **Righe 617-629**: La tabella dei default manca delle stesse 2 voci.
- **Correzione**: Aggiungere PrimitiveParams e ExternalId alle tabelle.

### D07 — Sezione 6: CommandType — Varianti mancanti

- **Righe 636-652**: Lo schema affiancato Rust/TS mostra solo 11 varianti (Noop..SetParent). Mancano `SetPrimParams0 = 11` e `SetPrimParams1 = 12`.
- **Righe 656-670**: La tabella dei payload non include SetPrimParams0 (16 byte, 4 x f32) e SetPrimParams1 (16 byte, 4 x f32).
- **Riga 654**: Dice "Il prossimo discriminante libero e `11`" — errato, dovrebbe essere **13**.
- **Correzione**: Aggiungere le 2 varianti mancanti e aggiornare il prossimo discriminante libero.

### D08 — Sezione 6: EngineBridge e GPURenderState — Campi mancanti

- **Righe 688-694**: `GPURenderState` mostra solo entityCount, transforms, bounds, renderMeta, texIndices. Mancano:
  - `primParams: Float32Array` (aggiunto in Phase 5.5)
  - `entityIds: Uint32Array` (aggiunto in Phase 6)
- **Correzione**: Aggiungere i 2 campi mancanti all'interfaccia.

### D09 — Sezione 6: RenderState struct Rust — Completamente stale

- **Righe 1113-1119**: Mostra 4 campi (`matrices`, `gpu_data`, `gpu_tex_indices`, `gpu_count`). Il campo `gpu_data` **non esiste** nel codice.
- **Realta** (`render_state.rs:170-186`): La struct ha **9 campi**: `matrices`, `gpu_transforms`, `gpu_bounds`, `gpu_render_meta`, `gpu_tex_indices`, `gpu_prim_params`, `gpu_entity_ids`, `gpu_count`, `dirty_tracker`.
- **Righe 1122-1127**: La descrizione di `collect_gpu()` dice che itera 5 componenti — in realta ne itera **9**: Position, ModelMatrix, BoundingRadius, TextureLayerIndex, MeshHandle, RenderPrimitive, PrimitiveParams, ExternalId, Active.
- **Correzione**: Riscrivere interamente il blocco RenderState con la struct corretta e i buffer SoA reali.

### D10 — Sezione 7: WASM Exports — Conteggio e lista errati

- **Riga 727**: Dice "16 funzioni esterne + 1 smoke test". **Reale**: 24 + 1 = **25**.
- **Righe 730-760**: La lista delle funzioni e incompleta. Elenca funzioni fantasma (`engine_gpu_data_ptr`, `engine_gpu_data_f32_len`) che non esistono nel codice. Mancano completamente:
  - `engine_gpu_transforms_ptr`, `engine_gpu_transforms_f32_len`
  - `engine_gpu_bounds_ptr`, `engine_gpu_bounds_f32_len`
  - `engine_gpu_render_meta_ptr`, `engine_gpu_render_meta_len`
  - `engine_gpu_prim_params_ptr`, `engine_gpu_prim_params_f32_len`
  - `engine_gpu_entity_ids_ptr`, `engine_gpu_entity_ids_len`
- **Correzione**: Sostituire l'intera lista con le 25 funzioni reali.

### D11 — Sezione 9: Layer diagram — Layer mancanti

- **Righe 822-891**: Il diagramma a strati non include:
  - **Input/Selection layer**: `input-manager.ts`, `hit-tester.ts`, `immediate-state.ts`, `selection.ts`
  - **Audio layer**: `audio-manager.ts`, `sound-registry.ts`, `playback-engine.ts`, `audio-types.ts`
  - Render passes mancanti: FXAATonemapPass, SelectionSeedPass, JFAPass, OutlineCompositePass
  - Shader mancanti: line, gradient, box-shadow, msdf-text, fxaa-tonemap, selection-seed, jfa, outline-composite
  - Componenti ECS mancanti: PrimitiveParams, ExternalId
- **Correzione**: Aggiungere i nuovi layer/moduli al diagramma.

### D12 — Sezione 10: Rendering Pipeline — Post-processing e outlines assenti

- **Righe 909-960**: Il diagramma della render pipeline non include:
  - FXAATonemapPass (reads `scene-hdr`, writes `swapchain`)
  - Selection outline pipeline (SelectionSeedPass -> JFAPass x N -> OutlineCompositePass)
  - Multi-pipeline ForwardPass (era mono-pipeline, ora ha 6 tipi primitivi)
  - `primParams` buffer nella lista dei buffer uploadati
  - Il ForwardPass scrive su `scene-hdr` non direttamente su swapchain
- **Righe 962-985**: La tabella dei buffer GPU e parzialmente corretta ma manca:
  - Prim Params buffer (`prim-params`, `STORAGE | COPY_DST`)
  - Entity IDs buffer (CPU-only, non uploadato)
  - Selection mask buffer (`selection-mask`, `STORAGE | COPY_DST`)
  - Selection seed texture, JFA textures (`jfa-a`/`jfa-b`)
  - `scene-hdr` HDR texture (output ForwardPass, input FXAATonemapPass/OutlineComposite)
  - Indirect args e ora 6 x 20 bytes (non piu singolo)
- **Riga 967**: `INDIRECT_BUFFER_SIZE` dice 20 bytes (singolo). Dovrebbe essere **120 bytes** (6 tipi x 20 bytes) o la costante non c'e piu.
- **Correzione**: Aggiornare il diagramma e la tabella dei buffer.

### D13 — Sezione 10: CullPass e ForwardPass — Descrizioni stale

- **Riga 1029**: CullPass `prepare()` dice che resetta indirect args a `[6, 0, 0, 0, 0]`. Con 6 tipi primitivi, resetta **6 x 5 u32** (30 u32 totali).
- **Righe 1031-1073**: ForwardPass descritto come mono-pipeline. In realta e multi-pipeline con `SHADER_SOURCES: Record<number, string>` e per-type `drawIndexedIndirect` a offset `primType * 20`.
- **Correzione**: Aggiornare le descrizioni di entrambi i pass.

### D14 — Sezione 11: Conteggi test Rust errati

- **Riga 1219**: Header dice "81 test Rust across 7 moduli + 175 test TypeScript across 23 file"
- **Realta**: **88 test Rust** + **364 test TypeScript across 37 file**
- **Conteggi per modulo errati**:

| Modulo | Dichiarato (riga) | Reale |
|---|---|---|
| `ring_buffer.rs` | 15 (1227) | **17** |
| `components.rs` | 19 (1230) | **20** |
| `command_processor.rs` | 11 (1233) | **13** |
| `engine.rs` | 6 (1236) | 6 (OK) |
| `systems.rs` | 6 (1238) | 6 (OK) |
| `render_state.rs` | 24 (1241) | **27** |

- **Righe 1310-1317**: Comandi Rust con conteggi diversi (e errati):
  - Ring buffer: dice 13 → reale **17**
  - Render state: dice 25 → reale **27**
  - Components: dice 19 → reale **20**
  - Command proc: dice 8 → reale **13**
  - Systems: dice 6 → OK
  - Manca conteggio per `engine`

### D15 — Sezione 11: Conteggi test TypeScript errati + file mancanti

- **Riga 1320**: Header dice "175 test"
- **Realta**: **364 test**
- Mancano interamente dalla lista tutti i file test di Phase 5.5 (outlines), Phase 6 e Phase 7
- Vedi tabella conteggi in D03 per i file presenti ma con numeri sbagliati
- **File test mancanti da Sezione 11** (non elencati):
  - `fxaa-tonemap-pass.test.ts` (3 test)
  - `selection-seed-pass.test.ts` (3 test)
  - `jfa-pass.test.ts` (9 test)
  - `outline-composite-pass.test.ts` (6 test)
  - `selection.test.ts` (10 test)
  - `input-manager.test.ts` (24 test)
  - `hit-tester.test.ts` (8 test)
  - `immediate-state.test.ts` (8 test)
  - `input-picking.test.ts` (3 test)
  - `audio-types.test.ts` (3 test)
  - `sound-registry.test.ts` (13 test)
  - `playback-engine.test.ts` (26 test)
  - `audio-manager.test.ts` (25 test)

### D16 — Sezione 15: Limitazioni — Informazioni stale

- **Riga 1451**: "Nessun input handling" con "Phase 6" e "Futuro" — **Phase 6 e completata**
- **Correzione**: Rimuovere questa riga o segnarla come "Completata"
- Potrebbe servire aggiungere nuove limitazioni reali (es. no 3D mesh, no perspective camera, no networking, max 32 children)

### D17 — Sezione 16: Roadmap — Fasi 6 e 7 dichiarate "Pianificata"

- **Riga 1477**: "Phase 6 | Audio & Input | Pianificata" — In realta Phase 6 e **Input System** (completata), Phase 7 e **Audio System** (completata). I nomi delle fasi sono invertiti/accorpati erroneamente.
- **Riga 1478**: "Phase 7 | Polish & DX | Pianificata" — In realta Phase 7 e Audio (completata). "Phase 8" sarebbe il prossimo.
- **Correzione**: Aggiornare la roadmap con le fasi corrette e i loro stati.

### D18 — Sezione 16: Metriche Attuali — Numeri stale

| Metrica | Dichiarato (riga) | Reale |
|---|---|---|
| Test Rust | 86 (1484) | **88** |
| Test TypeScript | 224 (1485) | **364** |
| File test TypeScript | 29 (1488) | **37** |
| WASM exports | 19 (1492) | **25** (24 + 1 smoke) |
| ECS Components | 14 (1493) — manca ExternalId | **15** |
| CommandType variants | 13 (1494) | 13 (OK) |
| WGSL Shaders | 11 (1495) | 11 (OK) |
| Render Passes | 6 (1496) | 6 (OK) |

### D19 — Sezione 17.1: "Prossimo discriminante libero"

- **Riga 1514**: "Il prossimo discriminante libero e `13`" — Deve dire la stessa cosa ma e corretto solo se non ci sono state aggiunte oltre SetPrimParams1=12. Verificato: **13 e corretto**.
- **Nota**: La riga 1506 parla di "SetColor = 8" come esempio, ma 8 e gia usato da SetMeshHandle. L'esempio andrebbe corretto con un numero libero (es. 13).

### D20 — Sezione 17.5: "Aggiungere un Nuovo Tier di Texture"

- **Riga 1555**: Dice di aggiungere `1024` a `TIER_SIZES: [64, 128, 256, 512, 1024]`. Dice che `NUM_TIERS` si aggiorna automaticamente. Verificare se questa costante esiste ancora o se la lazy allocation ha cambiato il pattern. Questo punto e probabilmente corretto ma va verificato durante l'applicazione.

### D21 — Sezione 3: docs/plans/ — File mancanti e nome errato

- **Riga 165**: Elenca `2026-02-17-hyperion-engine-design.md` — il file reale e `hyperion-engine-design-v3.md`
- Mancano tutti i piani post-Phase 4:
  - `hyperion-engine-roadmap-unified-v3.md`
  - `2026-02-18-phase-4.5-stabilization-arch-foundations.md`
  - `2026-02-20-phase-5.5-rendering-primitives.md`
  - `2026-02-20-phase5-typescript-api-lifecycle.md`
  - `2026-02-20-post-plan-integration-wiring.md`
  - `2026-02-21-phase-6-input-system.md`
  - `2026-02-21-phase-7-audio-system.md`

---

## Riepilogo Impatto

| Gravita | Sezioni | Descrizione |
|---|---|---|
| **Critico** | 3, 6, 7, 9, 10, 16 | File tree, componenti, WASM exports, render pipeline, roadmap — informazioni strutturalmente errate |
| **Alto** | 1, 4, 5.1, 11, 15 | Limitazioni false, header layout errato, conteggi test tutti sbagliati |
| **Medio** | 17.1 | Esempio con discriminante gia in uso |

---

## Azione Richiesta

Attendo la tua approvazione esplicita su questo piano prima di applicare le correzioni a `PROJECT_ARCHITECTURE.md`. Puoi:

1. **Approvare tutto** — Applico tutte le correzioni D01-D21
2. **Approvare parzialmente** — Indica quali D-items vuoi correggere e quali lasciare
3. **Modificare** — Suggerisci cambiamenti al piano
