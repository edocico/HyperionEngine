# Phase 17: 2D Lighting — Design

> **Date**: 2026-08-04
> **Plan**: `2026-08-04-phase17-lighting-2d-plan.md`
> **Repo at time of analysis**: `master @ 47fd337`, updated through `10bfa1d`
> **Previous phase**: Phase 16 complete + audit 2026-07 remediation

Evaluation of six candidate lighting architectures against the engine as it
actually is, followed by the chosen design. Every claim about the codebase was
read from source; every external claim carries a dated citation. §0 records what
a second, independent research pass corrected in the first draft.
---

## 0. Changelog v1 → v2

La v1 è stata sottoposta a una seconda tornata di ricerca indipendente (Godot `4.7-stable` e `master` letti a sorgente, Unity `Graphics@master`, `bevy_light_2d@main`, spec WebGPU normativa dal Bikeshed su `main`, paper RC/HRC/Split-RC, misure di Ben Golus). Ne sono usciti **tre errori** e dodici integrazioni sostanziali.

### Errori corretti

| # | Cosa diceva la v1 | Cosa è vero | Dove |
|---|---|---|---|
| **E1** | *"Godot fa esattamente questo [SDF+raymarch] per le ombre morbide direzionali"* | **Falso.** Le ombre 2D di Godot — posizionali *e* direzionali — passano tutte da `light_shadow_compute()` che campiona `shadow_atlas_texture` (shadow map 1D a 4 facce). La SDF è esposta **solo** agli shader `canvas_item` dell'utente via `texture_sdf()` e alla collisione di `GPUParticles2D`. La doc ufficiale Godot suggerisce la SDF come **workaround manuale**, non come implementazione built-in | §4-D, §6.2 |
| **E2** | *"oversize della SDF al 120% del viewport, come Godot"*, contato come costo trascurabile | **Il 120% costa +96% di pixel, non +20%.** `margin = (size × 120/100) − size` applicato **su entrambi i lati di entrambi gli assi** → rect finale `1,4×` per asse = **1,96× i pixel**. La combinazione default di Godot (120% oversize + 50% scale) a 1080p produce 1344×756 ≈ 1,02 Mpx, **quasi il conto di pixel del viewport full-res** | §6.2, §13.1 |
| **E3** | *"il costo del JFA non è mai stato misurato, nessuno sa quanto costi"* | Vero **per Hyperion**, ma esiste un ancoraggio esterno solido: Ben Golus misura **67–75 μs per pass** a 1080p su RTX 2080 Super, init 28 μs, effetto completo 0,6–1 ms. Il rischio si declassa da salto nel buio a stima con barra d'errore | §13.2, rischio #2 |

### Integrazioni

**A1** L'errore del JFA è **sempre una sovrastima** della distanza — la direzione pericolosa per lo sphere tracing (§6.2).
**A2** La correzione di Aaltonen alla soft shadow di Quilez è **controindicata** con un SDF da JFA (§7.3).
**A3** Il trucco di Godot per ottenere un SDF **firmato in una sola catena** JFA (§6.2).
**A4** `TRANSIENT_ATTACHMENT` (Chrome 146, feb 2026) — l'unica leva architetturale seria per GPU mobile (§3.1).
**A5** `kornelski/bevy_flatland_radiance_cascades`: WGSL, **CC0-1.0**, pre-averaging e direction-first già implementati (§8.4).
**A6** Il verdetto "RC non si estende al 3D" ora ha nomi e citazioni dirette, incluso l'autore stesso (§5.3).
**A7** PoE 2: disattivare la GI dà **~17% di FPS**; è *"the highest-cost setting in the game"* (§8.3).
**A8** La memoria "limitata a 2×M₀" vale **solo** col branching 2×; col 4× cresce linearmente (§8.3).
**A9** **Nessuna** implementazione GI 2D pubblica è deterministica — verifica esaustiva, non aneddotica (§10).
**A10** Overhead strutturale dei safety check WebGPU: **+14% medio, fino a +42%** vs nativo (§3.1).
**A11** `bevy_light_2d` è il precedente di produzione più vicino a D — e **non ha soft shadow** (§4-D).
**A12** Sezione nuova: **cosa è table stakes e cosa è premium** nel 2026 (§4.5).

### Cosa NON è cambiato

La scelta architetturale. **L'errore E1 toglie un argomento d'autorità all'opzione D, non la sua validità**: il ragionamento che la sceglie — Hyperion non ha poligoni di occlusione e non può averli a costo ragionevole — è indipendente da cosa faccia Godot. Ma cambia la lettura del rischio: nessun engine di produzione fa JFA → SDF → raymarch con penombra di Quilez per le ombre 2D. Hyperion sarebbe il primo. Vedi §4.4.

> ### Stato di verifica
>
> **Tutte le affermazioni sul codice sono verificate sul sorgente**, `master @ 47fd337`, 2026-08-02. Nessuna voce resta aperta.
>
> Primo giro: camera solo ortografica; i 6 tipi di primitiva e la loro mappatura shader (`renderer.ts:190-200`); `scene-hdr` con formato swapchain (`renderer.ts:174-179`); `ForwardPass` con split opaco/trasparente su `depth24plus`; `PRIM_PARAMS_SCHEMA` senza entry per `Quad`; `renderMeta` a 2 u32 con transparent bit 8 (`render_state.rs:674-677`); esistenza dei pass JFA/bloom/FXAA/radix-sort/scatter; `CLAUDE.md` riga 634 ("Phase 16 complete. Next: TBD").
>
> Secondo giro (le 7 voci che erano rimaste aperte per la caduta del bridge):
>
> | Voce | Esito | Evidenza |
> |---|---|---|
> | `MAX_COMMAND_TYPE = 53` | ✅ | `ring_buffer.rs:111` e `backpressure.ts:25`. Ultimo discriminante: `SetCharacterUp = 52`. **53 è libero** |
> | Writer unico per risorsa | ✅ | `compile()`: `throw new Error(\`Resource '${w}' has multiple writers: ...\`)` |
> | `addPass()` non chiama `setup()` | ✅ | Fa solo `passes.set()` + `_needsRecompile = true` |
> | `rebuildGraph()` cancella i pass dei plugin | ✅ | `renderer.ts:345` `graph.destroy()`, `:364` `new RenderGraph()`, poi riaggiunge **solo** i built-in. Invocata a 444, 450, 461, 469, 476, **547** |
> | `rebuildGraph()` scatta sull'hot-reload di shader | ✅ | `renderer.ts:547`, dentro l'handler HMR |
> | `RadixSortPass` sempre dead-culled | ✅ | `transparent-keys` / `transparent-vals-in` compaiono **solo** in `radix-sort-pass.ts` e nel suo test. Nessuno le registra |
> | `gpu_depths` non arriva a TypeScript | ✅ | `engine_gpu_depths_ptr()` e `_f32_len()` esistono in `lib.rs:305-321`; `grep depth worker-bridge.ts` → **zero risultati** |
> | `physics-debug` scarta l'identità dell'occluder | ✅ | `fn draw_line(&mut self, _object: DebugRenderObject, ...)` — il parametro è scartato con l'underscore. Output: 8 f32 per linea, nessuna identità |
>
> 🆕 **Scoperta collaterale che semplifica il prerequisito #0:** vedi §6.4.

---

## 1. Scopo

Progettare un sistema di illuminazione che serva **quattro obiettivi**, tutti confermati come in scope:

| Obiettivo | Cosa chiede alla luce | Vincolo dominante |
|---|---|---|
| **Giochi 2D** (tech demo Swarm) | Torce, esplosioni, luce del personaggio, ombre proiettate, ciclo giorno-notte | Scala (centinaia di luci) |
| **Lumière** (authoring animazioni) | Luce come effetto artistico su vettori e bitmap, scrubbable sulla timeline, esportabile | **Determinismo assoluto** frame-per-frame |
| **Canvas / design tool** | Glow, ombre morbide, materiali; poche entità | Qualità visiva, integrazione con `box-shadow` e `gradient` esistenti |
| **Vetrina tecnica** | Qualcosa che nessun altro motore web ha | Il risultato deve essere **visibilmente diverso** dalla concorrenza |

### Vincoli decisi a monte

| Vincolo | Valore | Conseguenza |
|---|---|---|
| **Architettura** | Due livelli: core condiviso + backend `lit` / `gi` intercambiabili | §5 |
| **Performance** | **Desktop-first, mobile best-effort** | Il backend `gi` è una feature reale, non un forse |
| **Orizzonte 3D** | 2D ora, ma l'architettura deve reggere un'estensione 3D | §5.3 |

> Il quarto obiettivo non è decorativo: è quello che sposta la valutazione. Il backend `lit` da solo replica ciò che Godot e Unity fanno da anni — scelta corretta come default, ma non differenzia. La ricerca conferma che **non esiste alcuna libreria di illuminazione 2D WebGPU production-ready in JavaScript**, e la lacuna è visibile da entrambe le direzioni: PixiJS ha WebGPU ma il suo plugin luci è fermo a luglio 2023 e non è mai stato portato a v8; Phaser 4 ha aggiunto dynamic lighting a maggio 2026 ma non ha renderer WebGPU e ha un cap di 10 luci; Bevy ha entrambi ma è Rust.

---

## 2. Stato verificato del motore

### 2.1 Il motore è 2D puro

- Camera **solo ortografica** (`camera.ts`, `orthographic()`). `mat4Inverse` è generale e commentata come "forward-compatible con camere prospettiche", ma **la prospettiva non esiste**.
- Fisica **Rapier2D**.
- 6 primitive: `Quad=0`, `Line=1`, `SDFGlyph=2`, `BezierPath=3`, `Gradient=4`, `BoxShadow=5`.
- `Mesh3D = 6` è **commentato** nella roadmap v3.

> **Conseguenza:** il "clustered forward lighting" che la roadmap rimanda a Phase 8/12+ non è progettabile oggi. Richiede mesh pipeline 3D, camera prospettica e normali per-vertice che non esistono. La roadmap stessa lo etichetta *"esce dallo scope 2D/2.5D"*. Questo documento non lo tratta.

### 2.2 Pipeline attuale

```
CullPass → [ScatterPass] → ForwardPass (→ scene-hdr) → FXAATonemapPass (→ swapchain)
                                      ↘ [SelectionSeedPass → JFA×N → OutlineComposite (→ swapchain)]
                                      ↘ [BloomPass (→ swapchain)]
```

- `ForwardPass`: due sub-pass (opaco con depth-write, trasparente con alpha blend), `depth24plus`, 24 bucket indiretti (6 tipi × 2 material sort × 2 blend).
- `RenderGraph`: DAG con Kahn + dead-pass culling. **Un solo writer per risorsa**.
  > **Aggiornato 2026-09-23.** Resta un solo writer *cieco* per risorsa, ma un pass che elenca la risorsa sia in `reads` sia in `writes` è un read-modify-write e si accoda al writer precedente, in ordine di registrazione (overlay con `loadOp: 'load'` sulla swapchain). Il controllo sui writer avviene *prima* del culling: il vecchio "FXAATonemapPass viene dead-culled da outline/bloom" non è mai successo, e `compile()` lanciava. Ora `render/graph-assembly.ts` registra un solo composite finale. Per le Track B/C: `occluder-seed`, `sdf-iter-N`, `light-buffer` hanno ciascuno un solo writer, quindi il vincolo non cambia nulla — **a patto che** la catena SDF usi nomi di pass e di risorse suoi. Oggi `JFAPass` li cabla (`jfa-N`, `jfa-iter-N`): con gli outline attivi una seconda catena collide (`already registered` / `multiple writers`). Parametrizzarli è già prerequisito del Task 8.
- `ResourcePool`: registry nominato per buffer / texture / view / sampler.
- Pattern ping-pong già collaudato: `jfa-iter-N` come nomi logici su 2 texture fisiche.

### 2.3 Le tre cose che rendono questo progetto fattibile

1. **Il pass JFA esiste già** ed è **agnostico rispetto al contenuto**: legge `inputResource`, scrive `outputResource`, non sa nulla della selezione. `jfa.wgsl` non contiene riferimenti alla selezione. Una seconda catena JFA da un seed diverso funziona **senza toccare `JFAPass`**.
2. **8 f32 per entità completamente liberi.** `PrimitiveParams` è `[f32; 8]` e `Quad` non ne usa nessuno.
3. **23 bit liberi in `renderMeta`.** `gpu_render_meta[slot*2+1]` usa i bit 0-7 (primType) e il bit 8 (transparent). I bit 9-31 sono liberi.

Insieme, permettono di aggiungere un intero sistema di luci **senza una singola nuova colonna SoA**, senza nuovi export WASM per i dati per-entità, e senza cambiare lo stride dello staging (32 u32). È il vincolo di integrazione più importante di tutto il design.

### 2.4 Il problema bloccante: `scene-hdr` non è HDR

```ts
// renderer.ts:174-179
let sceneHdrTexture = device.createTexture({
  size: { width: canvas.width, height: canvas.height },
  format: format,                        // ← formato swapchain, 8 bit per canale
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
});
```

`format` viene da `getPreferredCanvasFormat()` → `bgra8unorm` o `rgba8unorm`. **Solo i mip del bloom sono `rgba16float`.** Tre conseguenze, tutte già presenti oggi:

- Il **tonemapping è sostanzialmente inerte**: PBR Neutral / ACES applicati a valori già clampati a [0,1].
- Il **bloom parte da una sorgente clampata**: il threshold non può isolare valori >1 perché non ne esistono.
- Qualsiasi **accumulo additivo di luci** saturerebbe a 1.0 dopo poche luci sovrapposte.

> **Prerequisito #0.** Nessun backend ha senso finché `scene-hdr` non è `rgba16float`. Costo: +8,3 MB a 1080p. Beneficio collaterale: bloom e tonemap iniziano a funzionare davvero.

### 2.5 Osservazioni che cambiano il design — tutte verificate

| Osservazione | File | Impatto |
|---|---|---|
| Due pass che scrivono `swapchain` fanno **lanciare** `compile()` | `render-graph.ts:55-59` | I pass di illuminazione **non devono** scrivere `swapchain` né `scene-hdr` |
| `RenderGraph.addPass()` **non chiama** `setup()` | `render-graph.ts:21-27` | I pass vanno registrati e inizializzati in `renderer.ts`, come i built-in |
| `rebuildGraph()` **distrugge** i pass dei plugin, e scatta a ogni toggle outline/bloom e a ogni hot-reload di shader | `renderer.ts:345,364,547` | **Il sistema luci deve essere built-in, non un plugin** |
| `RadixSortPass` registrato ma **sempre dead-culled** | `radix-sort-pass.ts` | L'ordinamento back-to-front dei trasparenti non è attivo. Debito noto, non blocca le luci |
| `gpu_depths` calcolato ed esportato da Rust ma **non arriva a TypeScript** | `lib.rs:305-316` vs `worker-bridge.ts:13-35` | Non si può contare su un ordinamento per depth lato luci |
| I collider Rapier **non sono estraibili** come poligoni | `physics.rs:906-917` | **Gli occluder non possono venire dalla fisica.** Vedi §6.2 |
| `JFAPass.SHADER_SOURCE` è **statico di classe** | `jfa-pass.ts:55` | Due catene JFA nello stesso frame solo con lo **stesso** shader. Il design lo rispetta |

---

## 3. Vincoli

### 3.1 WebGPU

Verificati sul sorgente Bikeshed della spec (`spec/index.bs` e `wgsl/index.bs` su `main`), CR Draft del 14 luglio 2026.

| Vincolo | Valore | Impatto |
|---|---|---|
| `rgba16float` renderabile + **blendabile** + filtrabile | **core, nessuna feature** | ✅ È il formato dell'accumulo luci. Unica scelta HDR garantita ovunque |
| `rg11b10ufloat` renderabile | feature `rg11b10ufloat-renderable` | ❌ Firefox non ce l'ha. E **non risparmia budget**: costo RT 8 B, come `rgba16float`, malgrado siano 4 B in memoria |
| `rgba32float` blendabile / filtrabile | `float32-blendable` / `float32-filterable` | ❌ `float32-filterable` **non esiste su Safari** (limite Metal, non svista) |
| `r16snorm` / `rg16snorm` | feature `texture-formats-tier1` | ⚠️ Chrome 142+ (ott 2025), Safari 26.2. Firefox non verificato → **non usabili in core**. Rilevante per l'SDF firmato, §6.2 |
| `maxColorAttachmentBytesPerSample` | **32** | **Massimo 4 target `rgba16float` simultanei** — il limite è questo, non `maxColorAttachments` |
| `maxBindGroups` | **4** | Ne usiamo 2 oggi. Group(2) e (3) liberi |
| `maxComputeInvocationsPerWorkgroup` | **256** core, **128** compat | Tile 16×16 ok in core, 8×8 per coprire compat |
| `maxComputeWorkgroupStorageSize` | **16 KiB** = 4096 u32 | Ampio per liste luce per-tile |
| Float atomics in WGSL | **non esistono** | ❌ L'accumulo HDR **deve** usare blending additivo hardware in render pass, non `atomicAdd` |
| `binding_array` in WGSL | proposal **Draft**, non implementata | ❌ Niente bindless. Cookie texture → `texture_2d_array` o atlas |
| Runtime-sized array in `uniform` | vietato | La lista luci va in uno **storage buffer** |
| `textureSample` in control flow non uniforme | **errore di compilazione** | ❌ Nel loop luci obbligatorio `textureSampleLevel`. Coincide col check #7 di `wgsl-validator` |
| Preprocessore WGSL | non esiste | Variantizzazione via `override` (solo scalari) o templating TS |
| `subgroups` | Chrome 134+, **zero su Safari e Firefox** | Solo fast-path opzionale |
| **`TRANSIENT_ATTACHMENT`** 🆕 | `GPUTextureUsage` 0x20, **Chrome 146** (feb 2026) | ✅ *"render pass operations stay in tile memory, which avoids VRAM traffic"* e *"the driver may not need to allocate VRAM for it at all"*. **L'unica leva architetturale seria per Adreno/Mali/Apple.** Candidati naturali: `light-buffer` e le cascate intermedie |

**Copertura (caniuse, dataset 2026-07-16):** 82,17% pieno + 2,83% parziale ≈ **85%**. I buchi non sono marginali: Firefox non ha WebGPU su **Linux, Android e macOS Intel**; Chrome Android esclude GPU non-Adreno/Mali/PowerVR e Android < 12; Windows ARM64 non è shippato; Safari richiede macOS 26 / iOS 26.

**Il minimo comune denominatore è: core features, zero optional.** Il vincolo reale non è Safari — che da Safari 26 (set 2025) ha WebGPU di default ed espone `float32-blendable` e `rg11b10ufloat-renderable` — ma **Firefox**, che non espone nessuna feature opzionale.

> 🆕 **Da mettere nel budget:** WebGPU impone bounds checking obbligatori che costano **+14% in media, fino a +42%** rispetto al nativo su alcuni device (misurato su 16 device, arXiv 2605.20706, maggio 2026). Ogni stima derivata da numeri nativi o desktop va maggiorata di conseguenza.

### 3.2 Vincoli del motore

- **Payload ring buffer: max 16 byte**, limite strutturale. Oltre → due comandi, come `SetPrimParams0/1`.
- **Primo CommandType libero: 53.**
- **I 6 shader del ForwardPass condividono lo stesso `pipelineLayout`.** Qualunque binding aggiunto a group(0)/group(1) va replicato identico in tutti e 6 — check #1 di `wgsl-validator`.
- **`indirect-args` = `array<DrawIndirectArgs, 24>`** (6 tipi × 2 material × 2 blend), 480 byte — check #4 di `wgsl-validator`.
- Nessun benchmark GPU nel repo: `profiler.ts` è un overlay DOM, non ci sono timestamp query.
- `preflight.sh` non copre il rendering: *"WebGPU non è testabile headless"*.

---

## 4. Valutazione delle opzioni

### A — Forward, loop luci nel fragment shader (modello Godot 4)

Ogni fragment itera le luci che lo toccano, in un solo pass. Godot impacchetta gli indici luce a 8 bit nella draw data dell'item.

- ✅ Zero render target intermedi, zero memoria aggiuntiva.
- ✅ Precisione piena: nessun downsampling del light buffer.
- ❌ **Cap hard di 15 luci per item.** `canvas.glsl:641`: `uint light_count = read_draw_data_flags & 15u; //max 15 lights`. È il difetto architetturale più visibile del sistema Godot, e la proposal per alzarlo è stata **rifiutata**: Calinou, aprile 2024, *"you can't just increase this constant and expect lighting to still work correctly"*. Il workaround suggerito — spezzare gli oggetti in nodi più piccoli — l'utente che l'ha proposto documenta richiederebbe *"1000s of nodes"*.
- ❌ Nessun ordinamento per importanza: **vince la prima luce che arriva nella lista**. È la causa documentata del flickering quando >15 luci si sovrappongono.
- ❌ Il costo scala con **i pixel degli sprite illuminati** × luci sovrapposte.
- ❌ Richiede una lista luci per-entità calcolata CPU-side, che Hyperion non ha e che costerebbe una nuova colonna SoA.

### B — Light buffer screen-space (modello Unity URP 2D)

Le luci si accumulano in una texture a risoluzione ridotta (Unity: `m_LightRenderTextureScale = 0.5f` di default); il material shader fa un solo lookup e applica la formula a due accumulatori:

```hlsl
finalOutput = _HDREmulationScale * (color * finalModulate + finalAdditve);
```

- ✅ **Nessun limite al numero di luci per oggetto.** La sovrapposizione diventa fill rate, non branching.
- ✅ Il costo per luce è **fill rate sull'area coperta**, indipendente da quanti sprite illumina — l'opposto di A.
- ✅ La **luce globale è letteralmente il clear color** del light buffer. Costa zero.
- ✅ Half-res dimezza il costo con perdita accettabile: Unity lo documenta come *"good performance with almost no noticeable artifact in most situations"*.
- ⚠️ Vincolo dal sorgente Unity: *"Normals and Light textures have to be of the same renderTextureScale, to prevent any sampling artifacts"*.
- ❌ Perde i dettagli fini della luce sui bordi.

> Nota utile sul costo reale di Unity: il collo di bottiglia non è il numero di luci ma il **sorting layer batching**. Ogni batch alloca N light texture (una per blend style), 1 normals texture, M shadow texture. La doc ufficiale raccomanda *"up to 2 blend styles in a scene"*, e le normal map sono definite *"currently a very expensive operation"*.

### C — Shadow map 1D / polare

Per ogni luce, gli occluder vengono proiettati in un atlas dove ogni riga rappresenta le direzioni attorno alla luce e ogni texel la distanza al primo blocker.

- ✅ **Il costo di generazione è disaccoppiato dall'area della luce.** Una luce che copre metà schermo costa quanto una da 32 px. **Nessun'altra tecnica in questo elenco ha questa proprietà.**
- ✅ Rob Ware (2018) dimostra **64 luci con ombre in una singola draw call instanced**, usando righe da 0–540° invece di 360° per eliminare il branching sul wraparound.
- ❌ **Richiede bordi poligonali degli occluder.** Hyperion non ne ha: quad texturati, curve di Bézier SDF, glifi MSDF, box-shadow. Estrarre poligoni da queste è un progetto a sé.
- ❌ Godot spende **`4 × N_occluder` draw call per luce**, col TODO nel sorgente che dice cosa fare: *"The slowest part about this whole function is that we have to draw the occluders one by one, 4 times."* Con 20 luci e 50 occluder sono 4.000 draw call/frame solo per le ombre.
- ❌ Il PCF di Godot è **monodimensionale sull'asse angolare** (il vettore di offset ha solo la componente x) e produce streak documentati. Non è penombra fisica.
- ❌ In WebGPU `r32float` non è filtrabile senza `float32-filterable`, assente su Safari → il PCF con sampler lineare si rompe. Servirebbe `r16float`/`rg16float`.

### D — Ray marching su SDF generato da JFA

Un jump flood produce un campo di distanza dell'intera scena; ogni luce fa sphere-marching verso il fragment per il termine d'ombra.

- ✅ **Funziona su qualunque primitiva rasterizzabile**, senza poligoni: quad, Bézier, testo MSDF, box-shadow. Per Hyperion è decisivo.
- ✅ **Una sola struttura condivisa da tutte le luci.** Il costo di generazione è `O(log₂ dim)` pass, **indipendente da numero di luci e di occluder**.
- ✅ Soft shadow fisicamente plausibili quasi gratis col fattore di Quilez `min(res, k·h/t)` accumulato lungo il raggio — **penombra vera, senza geometria extra, riusando le distanze già calcolate per il marching**. È l'unica tecnica dell'elenco in cui la penombra è quasi a costo zero.
- ✅ **La stessa SDF serve al backend GI.** È l'elemento che unifica i due livelli.
- ✅ **L'infrastruttura JFA esiste già** in Hyperion, agnostica rispetto al contenuto.
- ⚠️ Il ray march **per-fragment × per-luce** collassa oltre ~20 luci. **Si risolve facendo il march dentro il light buffer (opzione B)**: il costo diventa `area_luce × step`, non `tutti_i_pixel × luci`.
- ❌ Risoluzione limitata: a metà scala i dettagli sottili spariscono, banding sui bordi.
- ❌ La JFA di Hyperion produce distanza **unsigned**. Serve il segno per evitare l'auto-ombreggiamento — risolvibile, §6.2.

> 🆕 **Correzione E1 — chi la usa davvero.** La v1 attribuiva a Godot l'uso della SDF per le ombre. **È falso.** Godot genera una SDF 2D con jump flooding (`canvas_sdf.glsl`), ma **il suo sistema di ombre non la usa**: sia le luci posizionali sia le direzionali passano da `light_shadow_compute()` che campiona `shadow_atlas_texture`. La SDF è esposta solo agli shader utente via `texture_sdf()` e alla collisione di `GPUParticles2D`. Anzi, la doc ufficiale la propone come **workaround** al limite delle ombre direzionali: *"you should disable shadows in the DirectionalLight2D and use a custom shader that reads from the 2D signed distance field instead."*
>
> 🆕 **Il vero precedente di produzione è `bevy_light_2d`** (MIT, v0.9.0 del 16 marzo 2026, ~34k download) — ed è istruttivo su due fronti opposti:
> - Costruisce la SDF **analiticamente e brute-force**, `min` su tutti gli occluder per ogni fragment, cap `MAX_OCCLUDERS = 256`, solo box e cerchio. **Non è un jump flood.** Costo `O(occluder)` per pixel. Il vantaggio di Hyperion (JFA già presente, `O(log dim)` indipendente dagli occluder) è quindi reale e non teorico.
> - Il suo `raymarch()` ha **max 32 step e ritorna 0.0 o 1.0 — binario. Nessuna penombra.**
>
> **Conclusione onesta: la combinazione JFA → SDF firmato → soft shadow di Quilez non esiste in nessun engine di produzione.** Bevy fa SDF+raymarch ma senza JFA e senza penombra; Godot ha il JFA ma non lo usa per le ombre; Unity fa penombra ma con estrusione geometrica e a ±15° fissi. Questo aumenta il valore rispetto all'obiettivo "vetrina tecnica", **e aumenta il rischio esecutivo**: non c'è un'implementazione da cui copiare i dettagli.

### E — Radiance Cascades 2D

Gerarchia di cascate: ogni livello ha 4× meno probe, 4× più raggi, intervalli 4× più lunghi; merge bilineare top-down. In produzione in Path of Exile 2.

- ✅ **Il costo è funzione della risoluzione, non del numero di luci.** Il whitepaper misura *"2, 102 and 1002 particles in the same amount of time of about 12ms"*. Nessun'altra tecnica dell'elenco ha questa proprietà.
- ✅ **Deterministica per costruzione**: *"radiance fields are built 'from scratch' every frame without reusing any data from the previous frame"* e *"every application of radiance fields in this paper explicitly does not rely on temporal reuse"*. **Niente TAA, niente denoiser.** Per Lumière è il punto decisivo.
- ✅ Illuminazione **indiretta** vera: color bleeding, penombre naturali, luce che gira gli angoli.
- ✅ Può fungere da **solver di bake** per lightmap statiche.
- ❌ **Non esiste una libreria WGSL production-ready.**
- ❌ **Costo reale alto.** HRC su RTX 3080 Laptop: **1,85 ms a 512²**, **7,67 ms a 1024²**, **33,9 ms a 2048²**.
- ❌ **Pre-averaging e direction-first layout sono strutturali, non ottimizzazioni.** Senza, la memoria a 1080p con 1 probe/pixel arriva a ~465 MB.
- ❌ Ammissione dell'autore: *"calculating just cascade 0 in a high level of detail can take milliseconds, which can already be over the budget for some realtime applications"*, e *"these arbitrary parameters dramatically affect both accuracy and performance, and can take some amount of fiddling to get right"*.
- ❌ **Cattiva sulle ombre nette.** mxcop: *"RC is notoriously bad at representing very sharp shadows."* Sannikov lo gira in feature — il degrado è graceful, le ombre diventano penombre da area light — ma va detto.
- ❌ **Non ha il concetto di "luce" come oggetto** con maschere e blend mode. L'input è un buffer di emissività, l'output irradianza. È incompatibile con l'API a light-object e va progettato come backend alternativo.

> 🆕 **Calibrazione dalle aspettative reali (A7):** in Path of Exile 2 il setting *"Lighting Mode: Shadows + GI"* è, secondo la guida settings del titolo, *"the highest-cost setting in the game"*, e disattivare la GI dà **~17% di FPS in più**. Anche in produzione su un AAA con un'implementazione dell'autore stesso, le RC sono la voce più cara del frame.

### F — Lightmap 2D precalcolate

- ✅ Costo runtime ≈ 0. Determinismo totale per costruzione.
- ✅ Qualità limitata solo dal solver — e **le RC stesse possono essere il solver**.
- ❌ Solo scene statiche. Sannikov: le lightmap *"provide no easy way of storing the directional aspect of precomputed radiance"*.
- 🎯 **Per Lumière è perfetta per i layer di background statici**: bake una volta, costo runtime zero, determinismo assoluto, parte animata realtime.

### Scartate senza approfondire

- **Light Propagation Volumes 2D**: zero letteratura e zero implementazioni 2D. La fonte primaria (Kaplanyan, CryEngine 3, SIGGRAPH 2009) è 3D.
- **Voxel Cone Tracing 2D**: non esiste. Sannikov lo cita come predecessore sorpassato.
- **SSGI 2D**: in un motore 2D ortografico screen space e world space coincidono per la porzione visibile — collassa in D.
- **Shadow geometry extrusion**: tecnicamente eccellente (Unity la fa nel vertex shader da mesh precalcolata) ma richiede poligoni. Stesso blocco di C.

### 4.4 Tabella comparativa

| | A — Forward loop | B — Light buffer | C — Shadow map 1D | D — SDF + raymarch | E — Radiance Cascades | F — Lightmap bake |
|---|---|---|---|---|---|---|
| **Scala con N luci** | ❌ cap 15/item | ✅ fill rate | ✅ ottima | ⚠️ buona se nel light buffer | ✅ `O(1)` | n/a |
| **Scala con N occluder** | n/a | n/a | lineare | ✅ **`O(log dim)`, indipendente** | indipendente | n/a |
| **Serve geometria poligonale** | no | no | **sì** ❌ | **no** ✅ | no | no |
| **Riusa infra Hyperion** | no | parziale | no | **JFA esistente** ✅ | SDF condivisa | — |
| **Ombre** | via C o D | via C o D | hard + PCF 1D | **soft vere** ✅ | penombre naturali | bake |
| **Luce indiretta** | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Deterministico** | ✅ | ✅ | ✅ | ✅ (se step fissi) | ✅ (se no reproiezione) | ✅ totale |
| **Costo @1080p** | scala coi pixel illuminati | ~1-3 ms half-res | basso | **~1-2,5 ms** (E3) | **~15 ms full-res** ❌ | ~0 |
| **Memoria @1080p** | 0 | ~4 MB half-res | 8 MB atlas | **~16 MB** con oversize (E2) | 29-116 MB | 1 texture |
| **Precedente di produzione** | Godot | Unity URP 2D | Godot, Defold, Ware | ⚠️ **`bevy_light_2d`, ma senza JFA e senza penombra** | PoE 2 | diffuso |
| **Fit con Hyperion** | scarso | **ottimo** | **bloccato** | **ottimo** | buono (opt-in) | ottimo (Lumière) |

### 4.5 🆕 Table stakes vs premium nel 2026

Utile per calibrare l'ambizione rispetto ai tre mercati. Il metro migliore è il mercato di asset a pagamento, dove si vede cosa la gente compra davvero — **Crystal 2D Lighting Engine** (GameMaker, $59, v2.3 dell'8 giugno 2026) offre: 8 tipi di luce, hard **e** soft shadow con **penombra e umbra regolabili per luce**, self-shadow, sprite shadow con prospettiva, normal map con rotazione, **PBR con GGX**, SSR in 2D, ciclo giorno/notte con LUT, e rivendica 5.000–10.000 luci simultanee.

| | Table stakes (ci si aspetta che ci sia) | Premium (differenzia) |
|---|---|---|
| **Tipi di luce** | point, spot, global/ambient | freeform poligonale, sprite/cookie, line light |
| **Ombre** | hard shadow da occluder | **soft shadow con penombra variabile**, self-shadow, sprite shadow |
| **Materiali** | tinta e intensità | **normal map**, specular, height/parallax |
| **Organizzazione** | light layer / mask | blend style multipli, per-layer batching |
| **Scala** | decine di luci | migliaia |
| **Indiretta** | — | **GI, color bleeding** ← qui non c'è quasi nessuno |

Due letture:

1. Il backend `lit` come progettato copre le table stakes **tranne le normal map** — che sono l'unica feature "attesa" esclusa dalla prima versione (§7.5). È il buco più visibile per un utente che arriva da Godot o Unity.
2. La penombra vera per-luce, che in D esce quasi gratis dalla formula di Quilez, è nella colonna premium: Unity la approssima con un ventaglio fisso a ±15° indipendente dalla distanza, Godot la fa con un blur angolare 1D. **È un differenziatore reale anche senza il backend `gi`.**

### Scelta

**Backend `lit` = B + D.** Light buffer screen-space a risoluzione ridotta, con il termine d'ombra calcolato per sphere-marching sulla SDF condivisa **dentro la pass di accumulo**, non nel ForwardPass. Combina lo scaling di B con le soft shadow di D senza il collasso per-fragment.

**Backend `gi` = E.** Radiance Cascades 2D flatland, opt-in, che consuma **la stessa SDF** e un buffer di emissività. Pre-averaging e direction-first obbligatori.

**F resta come modalità di bake per Lumière**, fuori dallo scope di questo design.

**C è bloccata** e non è una questione di preferenza: produrre poligoni da curve di Bézier e glifi MSDF sarebbe un progetto più grande dell'intero sistema di luci.

---

## 5. Architettura: core condiviso + due backend

```
┌──────────────────────────────────────────────────────────────────────┐
│  API TypeScript — identica per entrambi i backend                    │
│  engine.spawn().light({...})    engine.lighting.setBackend('lit'|'gi')│
├──────────────────────────────────────────────────────────────────────┤
│  CORE CONDIVISO                                                       │
│  ① Light Data Model      luci = entità ECS, primType 6                │
│     → primParams[8] + bit di renderMeta. Zero nuove colonne SoA       │
│  ② Occluder → SDF        OccluderSeedPass → sdf-iter-0..N (JFA)       │
│     → riusa JFAPass invariato. Consumata da ENTRAMBI i backend        │
│  ③ Emission buffer       EmissionPass → scene-emission                │
│  ④ HDR target            scene-hdr → rgba16float (PREREQUISITO #0)    │
├───────────────────────────────┬──────────────────────────────────────┤
│  BACKEND "lit" (default)      │  BACKEND "gi" (opt-in)               │
│  LightCullPass (compute)      │  RadianceCascadePass × N              │
│  LightAccumPass (render,      │    (compute, pre-averaging,           │
│    blend additivo rgba16float,│     direction-first layout)           │
│    ombra = sphere march SDF)  │  MergePass (top-down, bilineare)      │
│         ↓                     │           ↓                           │
│    light-buffer               │      cascade-0 → light-buffer         │
└───────────────────────────────┴──────────────────────────────────────┘
                                ↓
              ForwardPass legge light-buffer via @group(2)
                    out = albedo * (ambient + light)
```

**Primo punto di unificazione:** entrambi i backend producono **la stessa risorsa finale**, `light-buffer` (`rgba16float`, risoluzione ridotta). Il `ForwardPass` non sa quale backend è attivo. Cambiare backend è un `rebuildGraph()`, non una modifica agli shader.

**Secondo punto di unificazione:** entrambi consumano `scene-sdf`. Il costo del JFA è pagato una volta sola.

### 5.3 Estendibilità al 3D

**Sopravvive senza modifiche — è dove conviene investire ora:**

| Elemento | Perché regge |
|---|---|
| **Luce = entità ECS** | `Position` è già `Vec3`, `Rotation` è già `Quat`. Una point light 3D è la stessa entità con una z diversa. Gerarchia, spawn/despawn, snapshot, replay funzionano identici |
| **Culling delle luci via `CullPass`** | Il test è già sfera-frustum su 6 piani in 3D. Con una camera prospettica funziona **così com'è**, senza una riga di modifica |
| **Il pattern "backend intercambiabile"** | È esattamente il meccanismo con cui si aggiungerebbe `clustered` come terzo backend |
| **Il protocollo dei comandi** | `SetPrimParams0/1` e i bit di `renderMeta` sono agnostici rispetto alla dimensionalità |
| **HDR + tonemap + bloom** | Prerequisito comune a 2D e 3D |

**Non sopravvive — ed è giusto così:**

| Elemento | Perché cade | Costo di prepararsi ora |
|---|---|---|
| **Light buffer screen-space** | In 3D serve clustered forward | Alto e inutile: il clustered *è* il backend alternativo |
| **SDF screen-space da JFA** | In 3D servono shadow map o SDF world-space | Alto. Il JFA 2D non si estende |
| **Radiance Cascades flatland** | Vedi sotto | **Non prepararsi affatto** |

> 🆕 **A6 — Sul fatto che le RC non si estendano al 3D, ora abbiamo le fonti dirette.** Non è una cautela nostra:
> - **Alexander Sannikov**, l'autore: *"I never pitched 3d RC as the ultimate GI solution. I never even pitched it as a good GI solution."*
> - **Juan Linietsky**, creatore di Godot: *"For 2D it's actually really useful due to how 2D works, but for 3D to me it's a non starter for the most part."*
> - **Epic Games** (thread Unreal, 8 febbraio 2025): Lumen aveva una screen-probe hierarchy molto simile a RC, poi **sostituita** da screen-space + world-space probes perché più efficiente.
> - **Bevy Solari**: ha tentato RC 3D, ha incontrato *"artifacts and performance costs"* irrisolvibili, è passato a **ReSTIR**.
>
> Split Radiance Cascades (arXiv:2607.20384, **22 luglio 2026** — undici giorni fa) è il tentativo più recente e credibile, ed è ancora un preprint che ammette *"light leaking artifacts"*, *"misses details smaller than the base probe spacing"* e *"overblurring when trying to resolve hard shadows"*.

**Le due sole scelte che vale la pena fare ora per il 3D**, perché costano quasi nulla:

1. **Riservare valori nell'enum `lightType`**: 3 bit (8 valori), ne uso 5, riservo esplicitamente `5 = Point3D`, `6 = Spot3D`, `7 = Area`.
2. **Non premoltiplicare l'energy nel colore a livello di API.** Nel buffer GPU sì (§9.2), ma l'API TypeScript deve tenere `color` e `energy` separati.

**Quello che NON va fatto** è generalizzare `primParams[8]` a un layout "3D-ready": gli 8 slot sono esattamente riempiti dai parametri 2D, e una luce 3D avrà bisogno di dati diversi.

---

## 6. Il core condiviso

### 6.1 Le luci sono entità ECS

Una luce è un'entità con `RenderPrimitive(6)`. Non un oggetto in una lista separata. Riusa gratuitamente:

| Cosa si ottiene gratis | Come |
|---|---|
| Posizione, rotazione, scala | `Transform2D` / `Position`+`Rotation` |
| Gerarchia (torcia attaccata al personaggio) | `Parent` / `Children` + `propagate_transforms` |
| Ciclo di vita spawn/despawn | `EntityMap`, slot GPU, `queue_despawn` |
| Upload parziale | `DirtyTracker` + `ScatterPass` |
| **Frustum culling delle luci sulla GPU** | `CullPass` con `BoundingRadius` = raggio della luce |
| **Snapshot / restore** | HSNP v3 — determinismo e time-travel per Lumière |
| Replay / command tape | `CommandTapeRecorder`, `ReplayPlayer` |
| API fluente | `EntityHandle` |

Il culling gratuito è più importante di quanto sembri: una mappa con 5.000 torce paga solo le ~50 sullo schermo, e la logica esiste già.

**Costo strutturale:** `indirect-args` passa da 24 a 28 bucket (7 tipi × 2 × 2), da 480 a 560 byte; `visible-indices` da 9,6 a 11,2 MB. Tre dei quattro bucket del tipo 6 restano inutilizzati. È **spreco uniforme** che non introduce casi speciali in `cull.wgsl` e non rompe il check #4 di `wgsl-validator`.

**Le luci non vengono disegnate dal ForwardPass**: basta non registrare uno shader per `primType 6` in `SHADER_SOURCES`. Il loop `for (const [primType, pipeline] of this.pipelines)` semplicemente non le trova.

### 6.2 Da dove vengono gli occluder

**Non dalla fisica.** L'unica geometria estraibile da Rapier è il line-soup di `physics-debug`, con tre problemi che lo escludono: disponibile solo con la feature `physics-debug`; `LineCollector::draw_line` **scarta `DebugRenderObject`**, quindi le linee arrivano come pool indistinta; mescola shape, joint e assi. Non c'è winding né chiusura.

**Dal rasterizzatore.** Un `OccluderSeedPass` disegna tutte le entità con il bit `castsShadow` in una seed texture. Poi la catena JFA produce la SDF.

Questo è **il motivo per cui D vince per Hyperion**: una curva di Bézier, un glifo MSDF e un box-shadow proiettano ombra correttamente **senza che nessuno scriva un estrattore di poligoni**, perché il contributo passa dal loro stesso fragment shader.

`OccluderSeedPass` **non** è `SelectionSeedPass` riadattato: quello filtra su `selection-mask` e disegna solo 2 dei 24 bucket; l'occluder pass deve iterare **tutti** i bucket opachi. Il filtro è il bit `castsShadow` di `renderMeta`, letto nel vertex shader — stesso meccanismo dei triangoli degeneri.

`JFAPass` si riusa **invariato**. Nomi risorsa: `occluder-seed`, `sdf-iter-0..N`.

#### 🆕 A3 — Ottenere un SDF firmato in una sola catena JFA

Il rischio dell'auto-ombreggiamento (un occluder che si ombreggia da solo) si risolve col segno. Godot lo fa **senza raddoppiare il JFA**, e il trucco vale la pena copiarlo (`canvas_sdf.glsl`):

- Il buffer di lavoro contiene **coordinate intere del seed**, non UV normalizzate.
- L'interno è codificato **nel segno della coordinata stessa**: `rel = -rel - ivec2(1)`. `MODE_LOAD` scrive `ivec2(-32767)` per i pixel solidi e `ivec2(+32767)` per i vuoti.
- **Interno ed esterno vengono flooded nella stessa catena.** Il cuore è una riga di `MODE_PROCESS`:
  ```glsl
  if (src_solid != solid) {
      src_rel = ivec2(src_pos << params.shift); // point to itself if of different type
  }
  ```
  Un vicino di tipo opposto si comporta come se fosse lui stesso il seed → i due fronti si propagano contemporaneamente senza mescolarsi.

⚠️ **Caveat WebGPU**: Godot usa `rg16i` / `r16snorm`. In WebGPU `r16snorm` e `rg16snorm` **non sono formati core** — richiedono `texture-formats-tier1` (Chrome 142+, Safari 26.2, Firefox non verificato). Un'implementazione core-only deve usare `rg16float`/`rgba16float`, che è già la scelta di Hyperion. Il canale A della JFA attuale è sempre 1.0 → **è lì che va il flag interno/esterno**.

#### 🆕 A1 — L'errore del JFA è sempre una sovrastima, ed è la direzione pericolosa

Il JFA propaga **posizioni di seed reali**: può non trovare il seed più vicino, ma non può inventarne uno più vicino di quello vero. Quindi `d_JFA ≥ d_true`, sempre.

**Per lo sphere tracing questo è il verso sbagliato**: uno step troppo lungo può attraversare un occluder sottile, producendo luce che filtra attraverso i muri. Due mitigazioni note:

- **`1+JFA`** — un pass con step 1 **prima** della catena standard. Rong & Tan (ISVD 2007): *"the rate of errors of 1+JFA is far less than that of JFA+1"*, a parità di costo (+1 pass).
- **Margine sullo step**: `t += d × 0.95`.

Nota compensativa: la magnitudine dell'errore in distanza è minuscola proprio dove l'errore di identità è probabile (i vertici di Voronoi sono equidistanti da ≥3 seed, scambiarli lì cambia poco). Il precedente sperimentale più diretto è di Rong & Tan (2006) su soft shadow image-based: *"no significant and noticeable visual differences"* rispetto al flooding esatto su 462 frame. **L'artefatto che si vede non è l'errore JFA, è la risoluzione.**

#### 🆕 E2 — Risoluzione e oversize: il conto vero

Godot usa `rendering/2d/sdf/scale = 50%` (25% dei pixel) e `rendering/2d/sdf/oversize = 120%`. L'oversize serve a evitare che occluder appena fuori schermo smettano di proiettare ombra — artefatto reale e visibile.

**Ma il naming inganna.** Dal sorgente (`_render_target_get_sdf_rect`):
```cpp
margin = (rt->size * scale / 100) - rt->size;
r.position -= margin;
r.size += margin * 2;
```
A "120%" il margine è 0,2× per lato → rect finale **1,4× per asse = 1,96× i pixel**. Il costo del padding non è +20%, è **+96%**.

Conseguenza sul budget a 1080p:

| Config | Risoluzione SDF | Pixel | vs viewport full-res |
|---|---|---|---|
| Half-res, no oversize | 960×540 | 0,52 Mpx | 25% |
| **Half-res + oversize 120%** | **1344×756** | **1,02 Mpx** | **49%** |
| Full-res + oversize 120% | 2688×1512 | 4,06 Mpx | 196% |

La combinazione di default di Godot costa **quasi quanto un viewport pieno**. Va scelta consapevolmente: partire senza oversize, misurare quanto si vede l'artefatto ai bordi, e salire solo se necessario — oppure oversize 110% (1,21× i pixel) come compromesso.

### 6.3 Il buffer di emissività

`scene-emission` (`rgba16float`, stessa risoluzione della SDF): RGB = radianza emessa, A = opacità.

- Nel backend **`gi`** è l'input primario: le RC campionano questo buffer nei punti di hit del ray march.
- Nel backend **`lit`** è opzionale, utile per far contribuire gli sprite emissivi al bloom separatamente dall'albedo.

Le luci stesse si rasterizzano qui come dischi (point), coni (spot) o full-screen (global): è così che l'API a light-object viene tradotta nel modello a buffer che le RC richiedono. **È il ponte tra i due backend.**

> Nota di correttezza: nelle implementazioni 2D didattiche emissive e albedo **sono lo stesso buffer** (jason.today, Yaazarai, samuelbigos). È un limite reale — un rimbalzo corretto è `L_out = emission + albedo · L_in`, e se i due termini vivono nello stesso canale o si perde l'emissione o si perde la modulazione per albedo. Per rimbalzi multipli corretti servirebbe un terzo buffer `scene-albedo`. **Per il primo rimbalzo non serve**, e il backend `lit` non ne ha bisogno affatto.

### 6.4 Prerequisito #0 — `scene-hdr` a `rgba16float`

🆕 **È più semplice di quanto la v1 stimasse.** La v1 diceva "i `fragment.targets[0].format` delle 12 pipeline vanno aggiornati". In realtà `forward-pass.ts:140` calcola il formato **una volta sola** in una costante locale:

```ts
const format = navigator.gpu.getPreferredCanvasFormat();   // riga 140
...
fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },   // righe 158 e 172
```

Tutte e 12 le pipeline (6 tipi × opaco/trasparente) leggono quella costante. **I punti da toccare sono due, non dodici:** `renderer.ts:176` per la texture, e `forward-pass.ts:140` per le pipeline.

⚠️ Nota di design: `forward-pass.ts` **interroga `getPreferredCanvasFormat()` per conto proprio** invece di riceverlo. Conviene passarglielo — o meglio, far leggere a entrambi il formato di `scene-hdr` da un'unica sorgente di verità, perché oggi il pass e la texture possono divergere senza che nulla se ne accorga.

Tre effetti a valle:
1. `ForwardPass` — cambia il formato del target (i due punti sopra).
2. `BloomPass` — il threshold ora vede valori >1 e inizia a funzionare come previsto.
3. `FXAATonemapPass` — il tonemapping inizia ad avere effetto. **Va verificato visivamente che le scene esistenti non cambino aspetto in modo inaccettabile.**

Memoria: +8,3 MB a 1080p.

#### ⚠️ Il prerequisito #0 rende osservabile un bug di ordinamento preesistente

Verificato sul sorgente: in **entrambi** gli shader di post-processing l'FXAA gira **prima** del tonemapping.

- `fxaa-tonemap.wgsl` — `fs_main` calcola `fxaaLuma` sui 5 tap (M, NW, NE, SW, SE) alle righe 79-83, poi applica `pbrNeutralTonemap` / `acesTonemap` alle righe 92-95.
- `bloom.wgsl` — `fs_composite` è documentato come *"additive bloom blend + PBR Neutral tonemapping + FXAA"* e ha la stessa struttura.

L'FXAA di Lottes è progettato per operare su output **tonemappato e gamma-encoded**. Il test di soglia è `lumaRange < max(0.0312, lumaMax * 0.125)`: il pavimento assoluto `0.0312` è tarato su un intervallo [0,1].

Finché `scene-hdr` era LDR il problema era latente — l'input era comunque clampato, quindi l'FXAA lavorava nell'intervallo per cui è tarato. Con `rgba16float` l'input diventa non limitato, e l'edge detection diventa **ipersensibile nelle zone luminose e insensibile in quelle scure**.

**Non è una regressione introdotta dal cambio: è un difetto che il cambio rende visibile.** La correzione non è un semplice riordino, perché l'FXAA campiona 5 texel e ciascuno andrebbe tonemappato prima del confronto di luma — o, più pulito, l'FXAA va spostato in una pass separata a valle del tonemapping. Ha un costo in performance e cambia l'aspetto, quindi va fatta **con gli occhi sul risultato**, non alla cieca.

**Da trattare come il passo 1b**, subito dopo la verifica visiva del passo 1.

---

## 7. Backend `lit`

### 7.1 Pipeline

```
CullPass                              ─┐
  ↓ visible-indices (bucket tipo 6)    │  già esistenti
OccluderSeedPass    → occluder-seed    │
  ↓                                    │
JFAPass ×N          → sdf-iter-0..N    │  JFAPass invariato
  ↓ scene-sdf                          │
LightCullPass       → tile-light-list ─┘  compute, tile 16×16 (opzionale)
  ↓
LightAccumPass      → light-buffer        render, blend additivo
  ↓
ForwardPass         → scene-hdr           legge light-buffer via @group(2)
  ↓
BloomPass / FXAATonemapPass → swapchain
```

Nessun pass di illuminazione scrive `swapchain` o `scene-hdr`: il vincolo "un solo writer per risorsa" è rispettato.

### 7.2 `LightCullPass` (compute) — solo se serve

Tile 16×16 (`@workgroup_size(16,16)` = 256 invocazioni, esattamente il default core; **8×8 per coprire Compatibility Mode**, dove il limite è 128). Test cerchio-AABB per tile, lista in `var<workgroup>`, contatore con `atomicAdd<u32>` (l'unico tipo disponibile in WGSL).

> **Nota di onestà:** con il light buffer a metà risoluzione e luci di raggio tipico, il light culling potrebbe non ripagarsi. La prima implementazione può saltarlo e disegnare ogni luce come quad del suo raggio, che è già una forma di culling geometrico. **Non progettare l'ottimizzazione prima di aver misurato il problema.**

### 7.3 `LightAccumPass` (render)

Target: `light-buffer`, `rgba16float`, **metà risoluzione per asse**. Blend `{operation:'add', srcFactor:'one', dstFactor:'one'}` — renderabile e blendabile in **core**.

**Clear color = luce ambientale globale.** Come Unity: costa zero.

Una draw instanced, un'istanza per luce visibile, quad che copre il raggio (`drawIndexedIndirect` sul bucket del tipo 6 — l'`instanceCount` l'ha già scritto il `CullPass`). Nel fragment, per ciascun pixel:

1. Attenuazione radiale/conica dai parametri della luce.
2. Se `shadowIntensity > 0`: **sphere marching sulla SDF** dal pixel verso il centro della luce.
3. Blend mode (Add / Sub / Mix) in-shader.
4. Il `lightMask` si applica in lettura, nel ForwardPass (§7.4).

#### 🆕 A2 — Quale versione della soft shadow di Quilez usare

La formula base:
```glsl
res = min(res, k * h / t);   // h = distanza SDF, t = distanza percorsa, k = durezza (8–128)
```
Il termine `k·h/t` è **l'angolo sotteso dall'occluder più vicino** visto dal punto corrente del raggio. È il motivo per cui la penombra esce gratis: `h` e `t` sono già calcolati per il marching.

Esiste una **versione corretta**, attribuita da Quilez a Sebastian Aaltonen, che elimina l'over-darkening:
```glsl
float y = h*h/(2.0*ph);
float d = sqrt(h*h - y*y);
res = min(res, k*d/max(0.0, t-y));
ph = h;
```

⚠️ **Non usarla con un SDF da JFA.** La correzione assume che `map()` sia un SDF **esatto**; con un campo da jump flood `h` è già una sovrastima (A1), e il termine `y = h²/(2·ph)` **amplifica l'errore**. Nessuna fonte analizza questa interazione — l'ho verificato esplicitamente. **Partire dalla forma originale `k·h/t`**, che è anche quella che Ronja usa in 2D.

**Step count**: `bevy_light_2d` usa 32, jason.today 32, Yaazarai indica *"the optimal case seems to be 32-64 steps"*, davidtme (marzo 2026) *"approximately 10-20 steps per pixel"* con SDF. **16–32 è la fascia di lavoro.**

**Costo.** Una luce di raggio 300 px a metà risoluzione copre ~70k pixel; con 24 step sono ~1,7 M campionamenti SDF. Venti luci ≈ **34 M campionamenti/frame**.

> ⚠️ **Il messaggio di design:** il costo dell'accumulo non è il blending, è **l'area coperta**. Le ottimizzazioni vere sono ridurre il raggio delle luci e la risoluzione del buffer, non ridurre le draw call.

### 7.4 Consumo nel `ForwardPass`

**Nuovo bind group `@group(2)`**, non un'estensione di group(0)/group(1). I 6 shader condividono lo stesso `pipelineLayout` e il check #1 di `wgsl-validator` impone che group(0) e group(1) siano identici in tutti e 6.

Un `pipelineLayout` a 3 gruppi dove un dato shader dichiara solo i primi 2 è legale: la validazione WebGPU richiede che i binding **usati** esistano nel layout, non il contrario. **Solo gli shader che vogliono l'illuminazione dichiarano `@group(2)`.**

> ⚠️ **Ma il bind group va comunque legato.** `ForwardPass.execute()` deve chiamare `setBindGroup(2, ...)` **per tutte** le pipeline, anche quelle che non lo usano. Una sola chiamata prima del loop — ma dimenticarla produce un errore di validazione oscuro.

```wgsl
@group(2) @binding(0) var lightBuffer: texture_2d<f32>;
@group(2) @binding(1) var lightSampler: sampler;
@group(2) @binding(2) var<uniform> lighting: LightingUniform;
```

```wgsl
let lit = (meta1 >> 10u) & 1u;                       // bit receivesLight
if (lighting.enabled == 1u && lit == 1u) {
    let L = textureSampleLevel(lightBuffer, lightSampler, screenUV, 0.0);
    texColor = vec4f(texColor.rgb * L.rgb, texColor.a);
}
```

`textureSampleLevel`, non `textureSample` — obbligatorio. Il bit è `@interpolate(flat)` per istanza, quindi il branch è uniforme sul quad.

**Il secondo accumulatore** (additivo puro, per glow ed emissive) è un'estensione naturale via MRT: entro `maxColorAttachmentBytesPerSample = 32` si arriva a 4 target `rgba16float`. Non serve nella prima versione.

### 7.5 Normal map (differita)

Sono la feature che dà il salto di qualità visiva percepito, e §4.5 le colloca nelle **table stakes**: Godot, Unity, Phaser e PixiJS le hanno tutti. Ma richiedono **una nuova colonna SoA** (`gpu_normal_indices`, 1 u32/entità) con nuovo export WASM, nuovo campo in `GPURenderState`, e **stride dello staging da 32 a 33 u32** → tocca `collect_dirty_staging`, `scatter.wgsl`, `ScatterPass`. `texIndices` non ha spazio: restano 12 bit, insufficienti per un secondo (tier, layer).

Vincoli da rispettare, entrambi dal sorgente Unity:
- *"Normals and Light textures have to be of the same renderTextureScale"*.
- La doc Unity le definisce *"currently a very expensive operation"* e raccomanda di disattivarle se non servono.

Tooling per gli utenti: **Laigter** (GPL-3.0, v1.13.1 del 16 dicembre 2025, attivamente mantenuto) genera normal, specular, occlusion e parallax; SpriteIlluminator (commerciale) solo normal.

**Raccomandazione: escludere dalla prima versione**, trattare come sotto-fase separata. È l'unica parte del design che richiede una modifica invasiva alla pipeline dati — e per questo il costo di introdurle dopo è identico a quello di introdurle ora, il che rende la decisione rinviabile senza penalità.

---

## 8. Backend `gi`

### 8.1 Configurazione obbligatoria

1. **Pre-averaging** — casta 4 raggi, ne memorizza 1 mediato. Riduce la memoria del 75% e i tap del merge da 16 a 4.
2. **Direction-first probe layout** — riordina lo storage per direzione anziché per posizione, sfruttando l'interpolazione hardware. Porta il merge da 16 sample a 1.
3. **Nessuna reproiezione temporale, nessun merge stocastico, nessuna ammortizzazione multi-frame** — romperebbero il determinismo (§10).

Le prime due non sono ottimizzazioni: senza, a 1080p con 1 probe/pixel si arriva a **~465 MB**.

### 8.2 Pipeline

```
OccluderSeedPass → JFAPass ×N → scene-sdf     ─┐  condiviso con lit
EmissionPass                  → scene-emission ─┘
  ↓
RadianceCascadePass ×N (compute) → cascade-N .. cascade-0   (top-down merge)
  ↓
cascade-0 → light-buffer      (stessa risorsa che produce il backend lit)
  ↓
ForwardPass (identico, non sa quale backend è attivo)
```

Stesso pattern ping-pong di `jfa-iter-N`. Un solo writer per risorsa → il DAG compila.

### 8.3 Parametri e budget

```
mem_per_cascata = (W/s) · (H/s) · R₀ · 8 byte
```

> 🆕 **A8 — Attenzione al branching factor.** La proprietà spesso citata "in 2D la memoria di tutte le cascate è limitata a 2× la cascata 0" vale **solo con branching 2×** (probe ÷4, raggi ×2 → intervalli che dimezzano). Con **branching 4×** — quello che usano quasi tutte le implementazioni reali, e quello assunto qui — gli intervalli per cascata restano **costanti**, quindi il totale cresce **linearmente** col numero di cascate. mxcop: *"I recommend using the 4x branching method where interval count remains equal, it is simpler to work with in practice."* Il vantaggio compensativo: con intervalli che crescono 4× per livello servono **circa metà delle cascate** per coprire la diagonale.

| Config | Risoluzione | probe spacing `s` | Cascate | Mem/cascata | Totale | + ping-pong |
|---|---|---|---|---|---|---|
| Full-res, senza pre-avg | 1920×1080 | 1 | 7 | 66,4 MB | **465 MB** | 930 MB — **inaccettabile** |
| Full-res, pre-avg | 1920×1080 | 2 | 7 | 4,15 MB | **29 MB** | 58 MB |
| **Half-res, pre-avg** | **960×540** | **2** | **5-6** | **1,04 MB** | **~6,2 MB** | **~12,4 MB** ✅ |

**Costo.** Il dato più solido è HRC (arXiv:2505.02041, maggio 2025) su RTX 3080 Laptop: **1,85 ms a 512²**, **7,67 ms a 1024²**, **33,9 ms a 2048²**. A 960×540 (~518k pixel) l'ordine di grandezza è **~4 ms su GPU discreta di fascia alta**; su integrata media, 3-5× → **12-20 ms**.

Gli altri numeri che circolano, elencati per non doverli ricercare:
- **"~3 ms su GTX 1050"** per PoE 2 — caption di figura nel whitepaper, nessun dettaglio su risoluzione o settings.
- **"0,8 ms a 4K su 4090"** — commento su Hacker News di uno sviluppatore GGG (ott 2024). **Non è comunicazione ufficiale.**
- **"0,3 ms su GTX 970"** (demo, 80.lv, nov 2023) — risoluzione e complessità ignote. **Non usare per pianificare.**
- **25,95 ms a 1920×1080 su RTX 3080** (GM Shaders, lug 2024) — reale, ma con **4 probe per pixel**, cioè 4× la densità tipica. Il confronto interno position-first vs direction-first è valido, il valore assoluto no.

**Conclusione col target desktop-first:** il backend `gi` è **fattibile come feature reale**.

- **Desktop con GPU discreta**: half-res a ~4 ms, o full-res con pre-averaging a ~10-15 ms.
- **Desktop con GPU integrata**: half-res, 12-20 ms → 30-45 fps con il resto della pipeline. Accettabile in preview Lumière, marginale per un gioco.
- **Mobile**: quarter-res o backend `lit`. Il fallback non è un ripiego, è il comportamento previsto. **`TRANSIENT_ATTACHMENT` (§3.1) è la leva da usare qui.**

> 🆕 Per calibrare: in Path of Exile 2, con l'implementazione dell'autore stesso, la GI è *"the highest-cost setting in the game"* e disattivarla dà **~17% di FPS**. Non aspettarsi che sia economica.

**Il parametro da tarare per primo è la spaziatura probe di cascata 0, non il numero di cascate.**

### 8.4 Riferimenti implementativi

| Progetto | Tech | Licenza | Perché guardarlo |
|---|---|---|---|
| 🆕 **kornelski/bevy_flatland_radiance_cascades** | **WGSL** + Rust/Bevy | **CC0-1.0** (public domain) | **La reference WGSL con zero attrito di licenza.** Pre-averaging, direction-first storage, gear fix, ping-pong **già implementati**. 6 cascate, 16 angoli, probe spacing 2. Marcia su density map senza SDF né mipmap. Ultimo push 28 set 2025. L'autore la descrive come *"poorly implementing"*, quindi va letta come riferimento strutturale, non copiata |
| **jason.today** (Parti 1 e 2) | WebGL | MIT | **JFA → SDF → sphere marching già integrati.** Port WebGL→WGSL meccanico. La base migliore per la catena completa |
| **tmpvar playground** | **WebGPU** | codice MIT | Unica risorsa WebGPU con probe spacing / ray count / branching / cascade level esposti **e frame timing integrato**. Per esplorare il parameter space senza scrivere codice |
| **@typegpu/radiance-cascades** | WebGPU + WGSL | MIT, npm v0.11.0 (28 apr 2026) | Il più vicino a un pacchetto pronto: prende callback SDF + callback colore, gestisce texture e dispatch. ⚠️ Solo **2 versioni mai pubblicate**; la doc **non espone** cascade count, ray count, probe spacing né chiarisce se implementa il bilinear fix. **Va valutato leggendo il sorgente** |
| **Yaazarai/GMShaders-Radiance-Cascades** | GameMaker/GLSL | Unlicense | Implementa Vanilla / Bilinear-Fix / Nearest-Fix / Nearest-Interlaced-Fix come varianti separate. **La migliore reference per confrontare i fix** |
| **entropylost/amitabha** | Rust | ⚠️ non dichiarata | Implementazione di riferimento di HRC. Verificare la licenza prima di riusare |

### 8.5 Artefatti da mettere in conto

| Artefatto | Fix | Costo |
|---|---|---|
| **Ringing** (anelli attorno alle luci) | Bilinear Fix: 4× raggi, uno riproiettato su ciascuna probe bilineare | **4× costo raggi** |
| " " | Nearest Fix (pixelizzazione) / Nearest-Interlaced (dithering) | ~1× / intermedio |
| **Parallax** (duplicazione di energia) | Parallax Fix (mxcop) | non documentato |
| **Gear / seam tra cascate** | Gear Fix (kornelski) — già nella reference CC0 | basso |
| **Light leaking** | Clamp ai confini di merge | trascurabile |
| **Ombre nette impossibili** | Nessuno | — |
| **Ringing peggiorato dalla correzione sRGB** | Documentato da jason.today | attenzione al color space |
| **Popping su pan/zoom** | Griglia probe ancorata | ⚠️ **Ipotesi da testare** — nessuna fonte lo documenta per il 2D |

**Nota quantitativa:** Osborne & Sannikov (RASTI 2024) misurano il ringing nel caso peggiore a poco oltre il **10% di errore relativo**; in modelli realistici *"typically less than a few per cent"*, e aggiungono che il bilinear fix *"is not typically employed"*. **Non partire dal bilinear fix.** Partire da vanilla, misurare, aggiungere solo se l'artefatto è visibile.

---

## 9. Protocollo

### 9.1 `renderMeta[slot*2+1]` — layout proposto

| bit | campo | note |
|---|---|---|
| 0-7 | `primType` | invariato. Aggiunto il valore **6 = Light2D** |
| 8 | `transparent` | invariato |
| **9** | **`castsShadow`** | l'entità entra nel seed occluder |
| **10** | **`receivesLight`** | opt-in illuminazione. Sprite unlit saltano il lookup |
| **11-13** | **`lightType`** | `Point=0`, `Spot=1`, `Directional=2`, `Global=3`, `Sprite=4`. **Riservati: `Point3D=5`, `Spot3D=6`, `Area=7`** |
| **14-15** | **`lightBlendMode`** | `Add=0`, `Sub=1`, `Mix=2` |
| **16-31** | **`lightMask`** | 16 layer |

Esattamente 32 bit. **Zero nuove colonne SoA, zero nuovi export WASM, stride dello staging invariato.**

**Semantica di `lightMask`** — un campo, tre significati secondo il ruolo: su una **luce**, quali layer illumina; su un **disegnabile**, a quale layer appartiene; su un **occluder**, per quali layer proietta ombra.

> **Limite accettato.** Godot usa due coppie ortogonali (`range_item_cull_mask` ∩ `light_mask` per la ricezione, `shadow_item_cull_mask` ∩ `occluder_light_mask` per l'ombra), il che significa che `shadow_item_cull_mask` fa **doppio lavoro**: decide sia chi riceve l'ombra sia chi la proietta. 🆕 È la sorgente documentata di una confusione reale — c'è un articolo che descrive **sei mesi di tentativi** per risolvere l'auto-ombreggiamento delle tile in Godot 4, finito con un workaround a due TileMap. La nostra maschera singola è più semplice e copre il caso normale (un muro riceve luce e ombreggia dagli stessi layer); separarle costerebbe una nuova colonna SoA. **Da documentare come limite noto, non da nascondere.**

### 9.2 `PrimitiveParams` per `Light2D = 6`

| slot | nome | note |
|---|---|---|
| 0-2 | `colorR/G/B` | HDR — **energy premoltiplicata nel colore** |
| 3 | `range` | raggio in unità mondo |
| 4 | `innerCos` | coseno angolo interno (Spot) / `height` (Point, per normal map) |
| 5 | `outerCos` | coseno angolo esterno (Spot) |
| 6 | `falloff` | esponente di attenuazione |
| 7 | `shadowIntensity` | `0` = nessuna ombra |

8 su 8. Premoltiplicare l'energy libera lo slot per `shadowIntensity`.

> ⚠️ **La premoltiplicazione è un dettaglio del buffer GPU, non dell'API.** Lato TypeScript `color` ed `energy` restano separati (§5.3).

**Popolamento senza nuovi comandi**: `SetPrimParams0` (slot 0-3) e `SetPrimParams1` (slot 4-7) esistono già e validano ogni float con `is_finite()`.

> ⚠️ **Trappola evitata:** impacchettare i flag in uno slot `f32` via bitcast sarebbe tentante ma è **sbagliato**: `read_f32` valida con `is_finite()` e un bitfield arbitrario può produrre un NaN, rifiutato silenziosamente. Per questo i flag stanno in `renderMeta` (u32).

### 9.3 Nuovi CommandType

Primo libero: **53**. `MAX_COMMAND_TYPE` → **57**.

| # | nome | payload | scrive |
|---|---|---|---|
| 53 | `SetLightFlags` | 4 B: `u8 lightType`, `u8 blendMode`, `u16 lightMask` | renderMeta bit 11-31 |
| 54 | `SetLightingFlags` | 1 B: bit0 `castsShadow`, bit1 `receivesLight` | renderMeta bit 9-10 |
| 55 | `SetAmbientLight` | 16 B: `f32 r, g, b, intensity` | engine-level (`entity_id = 0`) |
| 56 | `SetLightingBackend` | 1 B: `0=off, 1=lit, 2=gi` | engine-level (`entity_id = 0`) |

Solo 4, perché i parametri riusano `SetPrimParams0/1` e la posizione riusa il transform. Tutti coalescabili last-write-wins; nessuno porta un ID secondario nel payload, quindi la chiave `entityId * 256 + cmd` è corretta.

**Comandi engine-level** (55, 56): `entity_id = 0` come sentinella, intercettati in `Engine::process_commands` **prima** del dispatch ECS, sul modello di `SetPhysicsDebugRender`.

Da seguire la skill `/new-command`. Punti di enforcement automatici: `payload_size` (match senza catch-all → E0004), `PAYLOAD_SIZES` in TS (TS2741), il test `max_command_type_matches_last_discriminant`, l'hook `guard-protocol-drift.sh`. **Il punto senza enforcement è `from_u8`**, che ha un catch-all `_ => None`: dimenticarlo produce un drop silenzioso.

### 9.4 Risorse del ResourcePool

| nome | formato | risoluzione | note |
|---|---|---|---|
| `scene-hdr` | **`rgba16float`** ⚠️ cambio | full | prerequisito #0 |
| `occluder-seed` | `rgba16float` | half (+oversize) | `(U, V, valid, inside)` |
| `sdf-iter-0..N` | `rgba16float` | half (+oversize) | ping-pong su 2 texture fisiche |
| `scene-emission` | `rgba16float` | half | RGB radianza, A opacità |
| `light-buffer` | `rgba16float` | half | **prodotta da entrambi i backend**. Candidato a `TRANSIENT_ATTACHMENT` |
| `tile-light-list` | buffer | — | solo `lit`, solo se il profiling lo giustifica |
| `cascade-0..N` | `rgba16float` | vedi §8.3 | solo `gi` |
| `lighting-uniform` | buffer | 32 B | ambient, exposure, enabled |

---

## 10. Determinismo — il requisito di Lumière

**Le Radiance Cascades sono deterministiche per costruzione.** Il whitepaper è esplicito:

> *"radiance fields are built 'from scratch' every frame without reusing any data from the previous frame, and in a matter of milliseconds allow calculating a solution to global illumination that is accurate enough so that it does not need any additional denoising."*

> *"every application of radiance fields in this paper explicitly does not rely on temporal reuse and reacts instantaneously to arbitrarily dramatic scene, viewport and lighting changes."*

HRC le descrive come *"a single-shot scene-agnostic radiance transfer algorithm"*.

> 🆕 **A9 — Quanto è raro, verificato esaustivamente.** Ho controllato **tutte** le implementazioni pubbliche di GI 2D basate su raymarching stocastico: **jason.today** (`mix(finalRadiance, prevRadiance, 0.9)`), **Yaazarai** (blue noise con offset golden-ratio **funzione di `sceneTime`**, più reinserimento del frame precedente per i rimbalzi), **samuelbigos** (rimbalzo rileggendo l'emissive del frame precedente), **bevy-magic-light-2d** (accumulo sugli 8 frame precedenti + filtro edge-aware). **Nessuna è deterministica frame-per-frame nella sua configurazione pubblicata.**
>
> Questo non è un dettaglio: significa che per Lumière **il ramo stocastico è escluso in blocco**, e che la scelta è binaria — o RC, o ray march usato solo per il termine d'ombra con step fissi e senza history (che è esattamente quello che fa il backend `lit`).

### 10.1 Le tre feature vietate in modalità deterministica

| Feature | Perché rompe il determinismo |
|---|---|
| **Reproiezione temporale** (*"each cascade can be efficiently reprojected from the previous frame"*) | Il frame N dipende dal frame N-1 |
| **Merge stocastico** (variante di `amida`, 4× più veloce del bilinear normale) | Se il seed dipende dal frame index, l'output cambia |
| **Ammortizzazione multi-frame** (toggle *"Reduce Demand"* del playground ufficiale) | L'output frame-singolo non è completo |

**Proposta:** un flag `deterministic: true` (default per Lumière) che le **vieta a livello di configurazione**. Vanno esposte e documentate, perché sono esattamente le tre ottimizzazioni che verrebbero naturali da attivare sotto pressione di performance.

### 10.2 Il backend `lit` è deterministico senza condizioni

Non usa accumulo temporale, blue noise, jitter né history buffer. Lo sphere marching con step fissi è puramente funzionale dello stato della scena.

### 10.3 Caveat: determinismo ≠ stabilità temporale

- **Determinismo**: a parità di input, output identico. ✅ Garantito da entrambi i backend.
- **Stabilità temporale**: al variare *continuo* dell'input, l'output varia con continuità. ⚠️ La griglia di probe delle RC è ancorata; un pan sub-pixel o uno zoom possono causare popping. Il paper DiGRA 2026 classifica la stabilità temporale delle RC come *"medium"* e osserva che *"struggles with high-frequency local lighting changes"* — ma è un test 3D screen-space in Unity, non 2D flatland. **Da verificare sperimentalmente.**

Per lo scrubbing con camera fissa il problema non si pone. Per un export con camera in movimento va testato.

### 10.4 Riproducibilità cross-device

Una tecnica algoritmicamente deterministica può produrre bit diversi su GPU diverse: ordine di riduzione in floating point, fp16 vs fp32, FMA, precisione delle trascendenti. Per un export video su una singola macchina è irrilevante. Per test di regressione visuale su CI servono **tolleranze percettuali**, non confronto bit-exact.

`engine_state_hash` (FNV-1a 64) copre lo stato della simulazione e continua a funzionare — le luci sono entità ECS, quindi rientrano gratis. **Il rendering non è coperto da quell'hash e non lo diventa con questo design.**

---

## 11. API TypeScript

```ts
// Una luce è un'entità: eredita transform, gerarchia, lifecycle, snapshot
const torcia = engine.spawn()
  .light({ type: 'point', color: '#ffcc88', energy: 2.0, range: 300 })
  .position(120, 80)
  .shadows(0.8)
  .lightLayers(0b0000_0000_0000_0011);

torcia.setParent(personaggio);          // gerarchia gratis

muro.castsShadow(true).receivesLight(true).lightLayers(0b11);

engine.lighting.setBackend('lit');      // 'off' | 'lit' | 'gi'
engine.lighting.setAmbient('#101828', 1.0);
engine.lighting.setQuality({
  bufferScale: 0.5,        // risoluzione del light buffer e della SDF
  sdfOversize: 1.0,        // 1.0 = nessun padding; 1.2 costa +96% di pixel (§6.2)
  shadowSteps: 24,
  cascades: 6,             // solo backend 'gi'
  deterministic: true,     // vieta reproiezione, merge stocastico, ammortizzazione
});
```

`setBackend()` provoca un `rebuildGraph()`. Stessa meccanica di `enableBloom` / `enableOutlines`.

---

## 12. Integrazione nel RenderGraph

### 12.1 Il sistema luci deve essere built-in, non un plugin

Tre ragioni:

1. `RenderGraph.addPass()` **non chiama** `setup()`. I due plugin che oggi usano `ctx.rendering.addPass()` non lo chiamano nemmeno loro → pipeline `null` → `execute()` esce subito. Non emerge nei test perché `ctx.rendering.addPass` è mockato e WebGPU non è testabile headless.
2. Il **`ResourcePool` non è esposto in `PluginContext`**, quindi un plugin non può registrare le sue risorse.
3. `rebuildGraph()` ricrea il grafo e riaggiunge **solo i pass built-in**. Scatta a ogni toggle outline/bloom **e a ogni hot-reload di shader**.

### 12.2 Ordine e vincoli del DAG

Nessun pass di illuminazione scrive `swapchain` né `scene-hdr`. `light-buffer` ha un solo writer (il backend attivo — mai entrambi, perché `setBackend()` ricostruisce il grafo).

Il dead-pass culling funziona a favore: se il backend è `'off'`, nessun pass vivo legge `light-buffer` e **tutta la catena viene eliminata automaticamente** — a patto che tutti i pass di illuminazione siano `optional: true`. Costo zero quando l'illuminazione è spenta.

### 12.3 Riuso del ping-pong

Il pattern di `updateJFATextureViews` si applica identico a `sdf-iter-N` e `cascade-N`. È l'unico modo per avere una catena iterativa in un DAG con vincolo di writer unico.

⚠️ `JFAPass.SHADER_SOURCE` è **statico di classe**: le due catene (outline e SDF) devono usare **lo stesso shader**. Lo usano — ma se servisse una variante (per esempio SDF firmata secondo §6.2), **il campo statico va rifattorizzato a campo di istanza**. Questo è ora più probabile di quanto sembrasse nella v1, perché il trucco del segno di Godot richiede una logica di `MODE_PROCESS` diversa.

---

## 13. Budget

### 13.1 Memoria a 1920×1080 — **incremento** rispetto a oggi

Aggiornata con la correzione E2. Due colonne: senza oversize, e con oversize 120%.

| Risorsa | Formato | Ris. | Senza oversize | 🆕 Con oversize 120% |
|---|---|---|---|---|
| `scene-hdr` — da 8 bit a float | `rgba16float` | full | +8,3 MB | +8,3 MB |
| `occluder-seed` | `rgba16float` | half | +4,1 MB | **+8,1 MB** |
| `sdf-iter-*` (2 texture fisiche) | `rgba16float` | half | +8,3 MB | **+16,3 MB** |
| `light-buffer` | `rgba16float` | half | +4,1 MB | +4,1 MB |
| `visible-indices` — 24 → 28 bucket | buffer | — | +1,6 MB | +1,6 MB |
| **Totale backend `lit`** | | | **+26,4 MB** | **🆕 +38,4 MB** |
| `scene-emission` (solo `gi`) | `rgba16float` | half | +4,1 MB | +4,1 MB |
| `cascade-*` (`gi`, half-res, pre-avg, ping-pong) | `rgba16float` | §8.3 | +12,4 MB | +12,4 MB |
| **Totale backend `gi`** | | | **+42,9 MB** | **🆕 +54,9 MB** |

Verifica del calcolo delle cascate (half-res, `s=2`, `R₀=4`, pre-averaging ÷4): `(960/2) × (540/2) × 4 × 8 B = 4,15 MB` per cascata → `1,04 MB` con pre-averaging → × 5 cascate (diagonale 1101 px → `ceil(log₄ 1101) − 1 = 5`) → **5,2 MB**, ping-pong ×2 → **~10,4 MB**, arrotondato a 12,4 per margine.

Da confrontare con quello che il motore già alloca: `entity-transforms` 6,4 MB, `visible-indices` 9,6 MB, `prim-params` 3,2 MB, più le texture tier.

### 13.2 🆕 Costo per frame — ora con un ancoraggio esterno

La v1 diceva "non misurato, nessuno sa". Vero per Hyperion, ma **Ben Golus ha misurato il JFA** (*The Quest for Very Wide Outlines*, 18 luglio 2020, RTX 2080 Super @ 1920×1080):

| Misura | Valore |
|---|---|
| **Un singolo pass di jump flood** | **67–75 μs** |
| Init pass | 28 μs |
| Effetto outline completo, raggio 2000+ px (≈ full screen) | **~1 ms** |
| Confronto: gaussian blur 30 px | ~1,1 ms |
| Confronto: brute force 30 px ottimizzato | ~2,5 ms |

Estrapolazione dal per-pass (**aritmetica, non misura**):

| Configurazione | Pass | Costo estrapolato (classe 2080 Super) |
|---|---|---|
| 1920×1080 full res | 11 | ~0,77 ms |
| 960×540 half res | 10 | **~0,18 ms** |
| 🆕 1344×756 (half + oversize 120%) | 11 | **~0,35 ms** |
| 480×270 quarter | 9 | ~0,04 ms |

Su GPU integrata attendersi **3-5×**, più l'overhead WebGPU di §3.1.

| Pass | Backend | Stima @1080p, GPU discreta |
|---|---|---|
| `OccluderSeedPass` | entrambi | ~ come `SelectionSeedPass` ma su tutti i bucket |
| **`JFAPass ×11`** (half + oversize) | entrambi | **~0,35 ms** 🆕 (era "non misurato") |
| `LightAccumPass` (20 luci r=300) | `lit` | ~34 M campionamenti SDF → frazioni di ms |
| `RadianceCascadePass ×6` | `gi` | ~4 ms su RTX 3080-class; 12-20 ms su integrata |

**Il backend `lit` completo dovrebbe stare sotto 1,5 ms su GPU discreta a 1080p.** Resta da misurare in casa, ma non è più un salto nel buio.

> ⚠️ **Il numero che non esiste in letteratura**, e che è il più utile: il costo misurato di un light-accumulation pass con sphere marching SDF a 1080p con N luci. **Nessuno l'ha pubblicato.** Va misurato con `timestamp-query`.

---

## 14. Rischi e mitigazioni

| # | Rischio | Prob. | Impatto | Mitigazione |
|---|---|---|---|---|
| 1 | Il cambio di `scene-hdr` a float **altera l'aspetto delle scene esistenti** | **Alta** | Medio | È il primo passo, isolato. Screenshot di riferimento prima/dopo sul demo harness |
| 2 | 🔽 La catena JFA raddoppia e non è mai stata misurata **in casa** | Alta | **Medio** (era Alto) | Ancoraggio esterno: ~0,35 ms half-res+oversize su 2080 Super (§13.2). Misurare comunque con `timestamp-query` |
| 3 | `indirect-args` da 24 a 28 bucket: disallineamento WGSL/TS/CLAUDE.md | Media | Alto | Check #4 di `wgsl-validator`. Aggiornare `cull.wgsl`, `cull-pass.ts` e CLAUDE.md nello stesso commit |
| 4 | `@group(2)` rompe la compatibilità dei 6 shader | Bassa | Alto | Layout a 3 gruppi con shader che ne dichiarano 2 è legale. **Verificare sul primo shader prima di toccare gli altri.** Ricordare `setBindGroup(2)` su tutte le pipeline |
| 5 | 🔽 La SDF unsigned causa **auto-ombreggiamento** | Alta | **Basso** (era Medio) | 🆕 Soluzione nota e provata: il trucco a singola catena di Godot (§6.2). Il canale A della JFA è libero. ⚠️ Richiede però `JFAPass.SHADER_SOURCE` da statico a istanza |
| 6 | 🆕 **Lo step del sphere march attraversa occluder sottili** (sovrastima JFA) | **Media** | Medio | `1+JFA` (+1 pass) o margine `d × 0.95`. §6.2 |
| 7 | 🆕 Si usa la correzione Aaltonen alla soft shadow, che con SDF da JFA **amplifica l'errore** | Media | Basso | Usare la forma originale `k·h/t`. Documentarlo nello shader, perché la "versione migliore" è la tentazione naturale |
| 8 | RC troppo costose anche desktop-first | Media | **Alto** — è uno dei quattro obiettivi | Prototipare su `tmpvar` **prima**, fuori dal repo. Pre-averaging + direction-first non negoziabili. Tarare per prima la spaziatura probe di cascata 0 |
| 9 | Popping delle RC su pan/zoom | Media | Medio | **Ipotesi non documentata in letteratura per il 2D.** Test dedicato con camera in movimento |
| 10 | Ringing delle RC visibile | Media | Basso | Partire da vanilla. Il bilinear fix costa 4× i raggi e *"is not typically employed"* |
| 11 | 🔼 Occluder fuori schermo smettono di ombreggiare, **e l'oversize costa il doppio del previsto** | Alta | **Medio-alto** | 🆕 Il 120% costa +96% di pixel (§6.2). Partire senza oversize, misurare l'artefatto, salire a 110% o 120% consapevolmente |
| 12 | Nuova colonna SoA per le normal map (stride 32→33) | Media | Alto | **Escludere dalla prima versione.** Il costo di introdurle dopo è identico |
| 13 | I 4 nuovi CommandType divergono tra Rust e TS | Bassa | Alto | `guard-protocol-drift.sh` blocca il commit. Seguire `/new-command` |
| 14 | `from_u8` ha un catch-all `_ => None` → **drop silenzioso** | Media | Alto | Unico punto senza enforcement del compilatore. Test esplicito per ciascun nuovo opcode |
| 15 | 🆕 **Nessun engine di produzione fa JFA→SDF→Quilez**: non c'è da chi copiare | Certa | Medio | `bevy_light_2d` dà l'ossatura (SDF+raymarch, 32 step) ma senza JFA e senza penombra; jason.today dà JFA+SDF ma per la GI. **I due pezzi vanno uniti a mano** |
| 16 | Compatibility Mode: workgroup 128, `maxTextureDimension2D` 4096 | Bassa | Medio | Tile 8×8 se si vuole coprire compat. Il design non usa MSAA |
| 17 | Firefox non espone nessuna feature opzionale | Certa | Nullo | **Il design usa solo core features.** `rgba16float` è core |

---

## 15. Cosa resta fuori

| Capacità | Perché |
|---|---|
| **Normal map su sprite** | Nuova colonna SoA + cambio stride staging. Sotto-fase separata (§7.5). **È l'unica table stake esclusa** |
| **Specular / Blinn-Phong** | Dipende dalle normal map |
| **Poligoni di occlusione espliciti** | La SDF da raster copre tutte le primitive senza authoring |
| **Occluder dalla fisica Rapier** | Impossibile con l'API attuale (§6.2) |
| **Bake di lightmap (opzione F)** | Ha senso per Lumière ma è un sotto-sistema separato con formato e tooling propri |
| **Volumetrico / god rays** | Estensione naturale del light buffer, non un prerequisito |
| **Luci ad area (LTC)** | Modello 3D. In 2D il concetto è già implicito nella penombra della SDF |
| **HRC (Holographic Radiance Cascades)** | Migliore delle RC vanilla in 2D (RMSE 2× migliore), ma **nessun port WebGPU esiste** e la reference è in Rust con licenza non dichiarata. Valutabile in futuro |
| **Terzo buffer `scene-albedo`** | Serve solo per rimbalzi multipli fisicamente corretti (§6.3) |

---

## 16. Ordine di lavoro proposto

| # | Passo | Sblocca | Rischi |
|---|---|---|---|
| **0** | ✅ **Fatto** — `timestamp-query` nel RenderGraph (`render/gpu-profiler.ts`, `enableGpuProfiling()`) | Decisioni di budget | #2 |
| **1** | ✅ **Codice fatto** — `scene-hdr` → `rgba16float` (`render/formats.ts`). ⏳ **Manca la verifica visiva sugli 8 tab del demo** | Tutto il resto | #1 |
| **1b** | 🆕 Spostare l'FXAA **dopo** il tonemapping (§6.4) | Qualità dell'immagine con HDR reale | #1 |
| **2** | `renderMeta` bit 9-31 + `primType 6` + `indirect-args` 24→28 | Le luci come entità | #3 |
| **3** | 4 CommandType (53-56) + API `EntityHandle` | Authoring delle luci | #13, #14 |
| **4** | `OccluderSeedPass` + catena `sdf-iter-N` **firmata** (§6.2) | Entrambi i backend | #2, #5, #6, #11 |
| **5** | `LightAccumPass` + `@group(2)` nel ForwardPass | Backend `lit` completo | #4, #7, #15 |
| **6** | Prototipo RC su `tmpvar` — **fuori dal repo, in parallelo a 1-5** | Decisione informata sul backend `gi` | #8, #9 |
| **7** | `EmissionPass` + `RadianceCascadePass` | Backend `gi` | #8, #9, #10 |
| **8** | `LightCullPass` — **solo se il profiling lo giustifica** | Scala oltre ~50 luci | — |

I passi 1-5 producono un sistema di illuminazione 2D completo. Il passo 6 è un **gate di decisione a costo quasi nullo** — `tmpvar` espone probe spacing, ray count, branching e cascade level con frame timing integrato — e va fatto **in parallelo**, non dopo: non tocca il codice, e il suo esito determina quanto lavoro mettere nel passo 7.

---

## 17. Domande aperte

### Chiuse

| Domanda | Risposta |
|---|---|
| Target hardware per `gi` | **Desktop-first, mobile best-effort.** Obiettivo esplicito, non un forse |
| Il sistema deve preparare il 3D? | **Sì, ma solo dove costa poco** (§5.3): riservare i valori dell'enum `lightType`, tenere `color`/`energy` separati nell'API. Nient'altro — ora con le fonti dirette che confermano che RC non si estende (A6) |
| Serve differenziazione tecnica? | **Sì**, ed è confermata: nessuna libreria di illuminazione 2D WebGPU production-ready esiste in JavaScript |

### Ancora aperte

1. **Oversize della SDF: quanto?** 🆕 Ora che sappiamo che il 120% costa +96% di pixel, la scelta non è ovvia. Proposta: default `1.0` (nessun padding), esporlo come parametro, e alzarlo solo se l'artefatto ai bordi si rivela visibile nei test. Godot lo dà a 120% di default, ma Godot non paga anche un light buffer.
2. **Il light buffer a metà risoluzione è accettabile per il caso Canvas/design tool?** Unity lo usa nei giochi, ma per un tool tipo Figma i bordi morbidi potrebbero essere visibili su UI ad alta densità. Con desktop-first, `bufferScale: 1.0` è ragionevole come default per quel prodotto — ma raddoppia il costo dell'accumulo.
3. **Le normal map sono un requisito o un nice-to-have?** 🆕 §4.5 le colloca nelle table stakes: chi arriva da Godot, Unity, Phaser o PixiJS se le aspetta. Sono anche l'unica parte che tocca invasivamente la pipeline dati. Il costo di introdurle dopo è identico a introdurle ora — quindi la decisione è rinviabile senza penalità tecnica, ma non senza penalità di percezione.
4. **16 light layer bastano?** Godot ne espone 20, Unity usa i sorting layer. 16 è quanto entra in `renderMeta` senza nuove colonne.
5. **Per Lumière serve il realtime, o il bake è sufficiente?** Se i background sono statici e solo i personaggi animati, l'opzione F (bake con RC come solver) dà qualità superiore a costo runtime zero. Col backend `gi` presente, il solver esisterebbe già.
6. **Il debito di `RadixSortPass` sempre dead-culled e `gpu_depths` che non arriva a TS va chiuso prima?** Non blocca l'illuminazione, ma è strano progettare sopra una pipeline con un pass morto e una colonna dati che non arriva a destinazione.
7. **`@typegpu/radiance-cascades` va adottato o si scrive da zero?** 🆕 Aggiornamento: solo **2 versioni mai pubblicate** (v0.11.0 del 28 apr 2026), doc che non espone i parametri di tuning. **In alternativa `kornelski/bevy_flatland_radiance_cascades` è CC0-1.0 con pre-averaging e direction-first già fatti** — meno pronto all'uso ma senza attrito di licenza e con l'architettura giusta. Da decidere al passo 6, leggendo il sorgente di entrambi.

---

## 18. Fonti

### Sorgente Hyperion (letto il 2026-08-02, `master @ 47fd337`)
`ts/src/renderer.ts` · `ts/src/render/render-graph.ts` · `ts/src/render/render-pass.ts` · `ts/src/render/resource-pool.ts` · `ts/src/render/passes/{forward,cull,jfa,selection-seed,bloom,fxaa-tonemap,debug-line,radix-sort,scatter}-pass.ts` · `ts/src/shaders/*.wgsl` · `ts/src/camera.ts` · `ts/src/prim-params-schema.ts` · `ts/src/backpressure.ts` · `ts/src/worker-bridge.ts` · `crates/hyperion-core/src/{components,render_state,ring_buffer,command_processor,engine,physics,lib}.rs` · `.claude/skills/new-command/SKILL.md` · `.claude/agents/wgsl-validator.md` · `scripts/preflight.sh` · `CLAUDE.md`

### Radiance Cascades
- Sannikov, A. — *Radiance Cascades: A Novel Approach to Calculating Global Illumination* — [github.com/Raikiri/RadianceCascadesPaper](https://github.com/Raikiri/RadianceCascadesPaper) — CC BY-ND 3.0, mai peer-reviewed, **documento vivo** (`\submitted{\today}`), prima presentazione ExileCon nov 2023
- Osborne, C. M. J. & Sannikov, A. — [arXiv:2408.14425](https://arxiv.org/abs/2408.14425), **26 ago 2024**, peer-reviewed su RASTI (doi:10.1093/rasti/rzae062) — analisi quantitativa del ringing
- Freeman, R., Sannikov, A., Margel, A. — *Holographic Radiance Cascades for 2D GI* — [arXiv:2505.02041](https://arxiv.org/abs/2505.02041), **4 mag 2025** — **i numeri di performance più solidi per il 2D**
- Freeman, R. & Sannikov, A. — *Split Radiance Cascades* — [arXiv:2607.20384](https://arxiv.org/abs/2607.20384), **22 lug 2026** — è 3D
- mxcop — [*Fundamentals of Radiance Cascades*](https://m4xc.dev/articles/fundamental-rc/) — **22 ott 2024** — penumbra condition, 2× vs 4× branching
- Xor & Yaazarai — GM Shaders [Parte 1](https://mini.gmshaders.com/p/radiance-cascades) (13 apr 2024) e [Parte 2](https://mini.gmshaders.com/p/radiance-cascades2) (13 lug 2024) — pre-averaging, direction-first, 25,95 ms @1080p RTX 3080
- McGhee, J. — [*Real-Time GI Parte 1*](https://jason.today/gi) (27 lug 2024) e [*Parte 2*](https://jason.today/rc) — **MIT**, JFA→SDF→raymarching
- [tmpvar playground](https://tmpvar.com/poc/radiance-cascades/) — **WebGPU**, codice MIT
- [kornelski/bevy_flatland_radiance_cascades](https://github.com/kornelski/bevy_flatland_radiance_cascades) — **WGSL, CC0-1.0**, 28 set 2025
- [@typegpu/radiance-cascades](https://docs.swmansion.com/TypeGPU/ecosystem/typegpu-radiance-cascades/) — MIT, npm v0.11.0 (28 apr 2026)
- [Yaazarai/GMShaders-Radiance-Cascades](https://github.com/Yaazarai/GMShaders-Radiance-Cascades) — Unlicense — le 4 varianti dei fix
- [Epic Developer Community — *Radiance Cascades in Unreal*](https://forums.unrealengine.com/t/radiance-cascades-in-unreal/1939802) — lug 2024 → feb 2025 — le citazioni di Sannikov, Linietsky, Epic, Bevy
- [radiance.wiki](https://radiance.wiki/) — hub della community (pagine datate 25 mar 2026 = data del sito, non dei contenuti)

**⚠️ Non verificato:** IEEE Xplore doc. 11307155 *"Radiance Cascades for Real-Time 2D Global Illumination"* — esiste ma è dietro paywall (418/429). DiGRA art. 2775 — bloccato da robots.txt.
**⚠️ Inesistenti:** "Radiance Cascades 2.0" come release ufficiale; "ring buffer cascades" (probabile confusione con l'artefatto *ringing*); "Kernel-Based JFA".

### JFA e SDF
- Rong, G. & Tan, T-S. — [*Jump Flooding in GPU*, I3D 2006](https://www.comp.nus.edu.sg/~tants/jfa/i3d06-submitted.pdf) — *"90% of errors as single errors"*
- Rong, G. & Tan, T-S. — [*Variants of JFA*, ISVD 2007](https://www.comp.nus.edu.sg/~tants/jfa/JFA-Variants.pdf) — 1+JFA, JFA+1, JFA+2
- Rong, G. & Tan, T-S. — [*Utilizing Jump Flooding in Image-Based Soft Shadows*, 2006](https://www.comp.nus.edu.sg/~tants/softShadow/jfaSoftShadow-techreport.pdf) — *"no significant and noticeable visual differences"*
- Golus, B. — [*The Quest for Very Wide Outlines*](https://bgolus.medium.com/the-quest-for-very-wide-outlines-ba82ed442cd9), **18 lug 2020** — **67–75 μs per pass @1080p RTX 2080 Super**
- Quilez, I. — [*Soft shadows in raymarched SDFs*](https://iquilezles.org/articles/rmshadows/) — `k·h/t` e la correzione Aaltonen
- Ronja — [*2D SDF Shadows*](https://www.ronja-tutorials.com/post/037-2d-shadows/), 1 dic 2018 — 32 sample
- davidtme — [*SDF Shadows*](https://davidtme.github.io/2026/03/23/sdf-shadows.html), **23 mar 2026** — 10-20 step vs 1000

### Motori di produzione (sorgente letto il 2026-08-02)
- **Godot 4.7-stable e master (4.8.0-dev)**: `servers/rendering/renderer_rd/renderer_canvas_render_rd.cpp` (atlas 2048×512 `R32_SFLOAT`, `4 × N_occluder` draw/luce + TODO) · `shaders/canvas.glsl` (`light_count & 15u`, PCF 1D) · `shaders/canvas_sdf.glsl` (**il trucco del segno a singola catena**) · `storage_rd/texture_storage.cpp` (`_render_target_get_sdf_rect`, **oversize 1,96× i pixel**) · `doc/classes/{Light2D,PointLight2D,DirectionalLight2D,LightOccluder2D,CanvasTexture}.xml` · `tutorials/2d/2d_lights_and_shadows.rst` (**la SDF come workaround, non come implementazione**)
- **Unity 6.5 / URP 17.5**: `Runtime/2D/{Renderer2DData,Lights/Light2D,Lights/Light2DBlendStyle,Shadows/ShadowCaster2D,Rendergraph/Renderer2DRendergraph,Passes/Utility/LightBatch}.cs` · `Shaders/2D/Include/{LightingUtility,CombinedShapeLightShared,ShadowProjectVertex,NormalsRenderingShared}.hlsl` — `m_LightRenderTextureScale = 0.5f`, `k_MaxShadowSoftnessAngle = 15`, `m_MaxShadowRenderTextureCount = 1`
- **`bevy_light_2d`** (jgayfer, MIT, v0.9.0 del **16 mar 2026**): `src/render/sdf/sdf.wgsl` (`MAX_OCCLUDERS = 256`, SDF analitica brute-force) · `src/render/light_map/light_map.wgsl` (raymarch 32 step, **risultato binario**)
- Ware, R. — [*Fast 2D shadows in Unity using 1D shadow mapping*](https://www.gamedeveloper.com/programming/fast-2d-shadows-in-unity-using-1d-shadow-mapping), 26 feb 2018 — 64 luci in una draw call
- Slembcke, D. — [*2D Lighting Techniques*](https://www.slembcke.net/blog/2DLightingTechniques/) — ⚠️ senza data, non menziona RC → verosimilmente pre-2023
- Phaser 4 — [annuncio dynamic lighting, 19 mag 2026](https://phaser.io/news/2026/05/phaser-4-dynamic-lighting) — cap 10 luci, nessun WebGPU
- `@pixi/lights` v4.1.0 (**12 lug 2023**) — mai portato a PixiJS v8 né a WebGPU
- Crystal 2D Lighting Engine (GameMaker), v2.3 dell'**8 giu 2026**, $59 — il metro del mercato premium
- Laigter (azagaya, GPL-3.0), **v1.13.1 del 16 dic 2025** — normal/specular/occlusion/parallax

### WebGPU
- [WebGPU — W3C CR Draft, 14 luglio 2026](https://www.w3.org/TR/2026/CRD-webgpu-20260714/) e sorgente Bikeshed `spec/index.bs` + `wgsl/index.bs` su `main` (scaricati 2026-08-02) — tabelle limiti e Plain color formats
- [gpuweb — Implementation Status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status) e [Proposals README](https://github.com/gpuweb/gpuweb/blob/main/proposals/README.md) — stato Merged/Draft/Inactive
- [Chrome — What's New in WebGPU 146](https://developer.chrome.com/blog/new-in-webgpu-146), 25 feb 2026 — **`TRANSIENT_ATTACHMENT`**, compat mode shipped
- [Chrome — What's New in WebGPU 142](https://developer.chrome.com/blog/new-in-webgpu-142), 22 ott 2025 — `texture-formats-tier1/tier2`
- [caniuse — dataset `webgpu.json`](https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/webgpu.json), aggiornato 2026-07-16 — 82,17% + 2,83%
- [gpuweb issue #5006](https://github.com/gpuweb/gpuweb/issues/5006) — `shader-f16` esclude tutti i device Qualcomm
- [arXiv:2605.20706 — *Llamas on the Web*](https://arxiv.org/html/2605.20706v1), 20 mag 2026 — **overhead safety check +14% medio, +42% picco**, su 16 device
- [WebKit — Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/), 15 set 2025

**⚠️ Non trovato in letteratura, da misurare in casa:**
1. Costo di un light-accumulation pass con sphere marching SDF a 1080p con N luci — **nessuno l'ha pubblicato**
2. Punto di pareggio in numero di luci tra raymarching SDF e Radiance Cascades
3. Benchmark di Radiance Cascades su GPU mobile o integrata — **cercato ripetutamente, non esiste**
4. Misure di VRAM in MB pubblicate per RC 2D — i numeri di §8.3 sono aritmetica dalla struttura dati
5. Interazione tra la correzione Aaltonen e un SDF approssimato da JFA
6. Costo del blending additivo `rgba16float` a 1080p in WebGPU
7. Disponibilità di `texture-formats-tier1` su Firefox
