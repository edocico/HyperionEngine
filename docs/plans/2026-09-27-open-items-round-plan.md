# Piano del giro: harness (H), spawn 2D pubblico (S), residui di Phase 17 (L)

HEAD `1f04d40` (master), 2026-09-27. L'ordine è stato ricavato dal workflow `order-open-items` (`wf_22520d1f-e48`): 3 scout read-only, uno per filone, e un critico che ha ricontrollato nel codice le dipendenze che determinano l'ordine. Nessun file tracciato è stato modificato durante l'analisi. I riferimenti `file:riga` si riferiscono a quel HEAD.

## 1. I tre filoni, dopo la lettura del codice

**H — harness.** Due dei tre "minor" sono bug del motore.
- `EntityHandle.destroy()` (`entity-handle.ts:673-680`) invia solo `DespawnEntity`. `Hyperion.returnHandle()` (`hyperion.ts:406-410`) è l'unico punto che deregistra la handle dal LeakDetector e decrementa `entityCount`, e lo chiamano solo i test. Conseguenze:
  - `entityCount` cresce e basta: dopo `maxEntities` (100 000) spawn **cumulativi** `spawn()` lancia "Entity limit reached" per sempre, anche con zero entità vive (`hyperion.ts:386-391`);
  - i warning del LeakDetector sulle demo sono falsi positivi, perché le demo distruggono tutto;
  - il pool non ha mai riciclato una handle.

  Il bug esiste dalla Phase 5 (`a7a5c30`).
- Un cambio di tab mentre il `setup()` asincrono di una sezione è in corso lascia registrato un hook su handle distrutte (per esempio `lighting.ts:114`, `await frames(3)`). Quell'hook lancia un'eccezione, e `GameLoop.frame` (`game-loop.ts:134-142`) non ha try/catch prima di riarmare il RAF: il motore si ferma senza dire niente.
- I check contano gli spawn, leggono `.alive`, oppure verificano che non ci siano eccezioni; `lighting.ts:108` passa sempre. In Primitives i bezier e i gradienti sono fuori dal canvas.
- `line.wgsl:99-109` allarga la linea nello spazio del modello, mentre l'header (`:1`) e l'AA (`:172-174`) assumono pixel schermo.

**S — spawn 2D.** Il lato Rust dell'archetipo `Transform2D` è completo: spawn, batch, sistemi, staging formato 0, fisica, snapshot, `state_hash` e luci. Il lato TS però non invia mai `payload[0]=1`, quindi `scatter.wgsl` formato 0 (`:40-64`) non è mai girato su GPU. Gira solo in Mode B/C, sui frame con `dirtyRatio <= 0.3` e per le radici 2D dirty. Inoltre `.depth()` non ha effetto sulla GPU per **nessuna** entità: `gpu_depths` non ha consumatori TS e `RadixSortPass` viene rimosso dal culling.

**L — residui Phase 17.** Oggi tutti e tre falliscono in silenzio:
- `sprite` viene scartata (`light-accum.wgsl:184-186`);
- `mix` viene sommata come `add` (`:226-228`);
- `directional` è identica a `global` (`:75-76`, `:190`).

Il §7.3 del design dice "Mix in-shader", ma non si può fare: WebGPU non ha framebuffer fetch. Serve una seconda pipeline con blending fisso, e il risultato dipende dall'ordine, che le atomiche del cull rendono non deterministico.

## 2. Decisioni prese (2026-09-27)

| # | Decisione | Scelta |
|---|---|---|
| D1 | Che cosa fa `destroy()` con la handle | **Solo rilascio.** Deregistra la handle dal LeakDetector e decrementa `entityCount`. Nessun riciclo nel pool: una handle distrutta resta morta, quindi niente aliasing ABA |
| D2 | Verifica dei pixel nell'harness | **Probe in-page + readback della swapchain.** Il probe legge `scene-hdr`, `light-buffer` e le righe di `entity-transforms` (valori lineari); la swapchain copre composite, bloom, outline, particelle e overlay (richiede canvas `COPY_SRC`: è una modifica al motore). Mode A: skip con motivo |
| D3 | Unità della larghezza delle linee | **Entrambe, per linea.** Un flag in `primParams[7]` sceglie tra unità mondo e pixel schermo |
| D4 | Esposizione dello spawn 2D | **Opzione per entità** (`engine.spawn({ mode: '2d' })`); il default resta 3D. S e L restano indipendenti |

Decisioni rimandate, da prendere **prima del passo indicato**:
- **Passo 2:** dove vive il probe (API dev `engine.debug.probe()` usabile da `/gpu-check`, oppure solo demo) e cosa fanno le soglie dei check (tolleranze assolute oppure rapporti).
- **Passo 3:** se gli estremi di una linea devono guidare il `BoundingRadius`. Oggi la linea viene cullata sul quadrato unitario, anche quando è ancora visibile.
- **Passo 5:** se Depth→z (S2) rientra in questo giro, e che cosa significa `.depth()` su un'entità 3D.
- **Passo 6:** se `sdfOversize` rientra (senza, gli occluder fuori schermo compaiono di colpo al bordo), quale asse locale indica la direzione, quanto è ampia la penombra, e che le luci global non proiettano ombre.
- **Passo 7:** l'ordine dei `mix` sovrapposti (non definito e documentato, oppure deterministico per id).
- **Passo 8:** l'estensione della luce sprite (quadrato di lato = range con raggio `range·√2`, scala del transform, oppure disco), la sorgente della texture, e se la luce sprite proietta ombre.

## 3. Ordine e criteri di uscita

| # | Passo | Criterio di uscita |
|---|---|---|
| 0 | Questo documento | Decisioni registrate |
| 1 | **H2**: `destroy()` rilascia la handle al motore; il cambio tab non si sovrappone più a un setup in corso; un hook che lancia non ferma il loop | Vitest RED→GREEN: `destroy()` da solo decrementa `entityCount` e deregistra la handle (spy sul LeakDetector); si può fare spawn oltre `maxEntities` cumulativi; niente più `returnHandle` manuali nei test; lo switch dei tab è testato con sezioni finte; `preflight.sh` verde |
| 2 | **H1a**: probe (`scene-hdr`, `light-buffer`, righe `entity-transforms` tramite compute copy) + readback della swapchain | WGSL e pipeline validati sotto error scope sull'adapter AMD; test headless per reads/writes, layout degli uniform e mapping mondo→pixel; sul tab Lighting il probe riproduce i fatti noti (clear a 0.067, asimmetria dei pilastri ≈2.3x); Mode A → `unavailable` |
| 3 | **H3** (flag mondo/pixel per le linee, AA con `fwidth`), poi **H1b** (nuovo layout di Primitives; i check a conteggio e i no-op diventano check sul probe in Primitives, Scene Graph, Lifecycle, Lighting e Rendering FX) | Ogni tab mostra N/M con check reali e 0 messaggi WebGPU; Tonemap resta `skip` onesto finché l'API è uno stub (`hyperion.ts:534-538`); baseline HDR rifatte |
| 4 | **S1**: `spawn({ mode: '2d' })`, RawAPI, `z` opzionale + scena gemella 2D contro 3D con meno del 30% delle entità in moto | Il readback mostra le righe formato 0 uguali a `latestRenderState` **sui frame scatter**; ogni sprite 2D sta sullo stesso pixel del suo gemello 3D; vitest per payload 1 sotto backpressure; test Rust per una Light2D su `Transform2D` |
| 5 | **S2** (se entra nel giro): Depth → z | Test Rust su z della radice, eredità nei figli, formato 0 e ri-staging dei figli dopo `SetDepth`; il probe mostra sprite 2D sovrapposti nell'ordine giusto e stabile |
| 6 | **L-c**: ombre directional (`shadow()` generalizzata a origine + direzione) + `light-groups.ts:113` **nello stesso commit**; per le global: nessuna ombra, dichiarato nell'API | Test in `light-groups.test.ts`; con il probe, un sole dietro un muro scurisce il lato lontano; i check delle ombre point/spot del passo 3 restano invariati; costo misurato e annotato nel §13.2 |
| 7 | **L-b**: `mix` come seconda pipeline, dopo add e sub | Test del blend state; il layer del `light-buffer` vale il colore del mix sotto un mix a intensità piena; nessun flicker, oppure ordine documentato come non definito |
| 8 | **L-a**: luce sprite. Nell'ordine: raggio in Rust, poi texture tier in `LightAccumStage` (`TextureTierBinding`), poi shader, poi API TS, poi demo con un cookie procedurale | Test Rust sul raggio; indice 0 = bianco coperto dal guard di `forward-pass.test.ts`; sulla GPU AMD: cookie campionato su texel noti, crescita dei tier con 0 errori, nessun pop al bordo del frustum |
| 9 | Chiusura: documenti obsoleti, CLAUDE.md, `claude-md-auditor`, `adversarial-review` sull'intero range | `preflight.sh --full` verde; `/gpu-check` con tutti i tab e i conteggi |

Perché H viene prima: c'è un bug del motore da correggere, e il probe è la base di verifica per S e per L. Il formato 0 e il `mix` si possono controllare solo su valori lineari; uno screenshot a 8 bit non basta.

Perché S viene prima di L: con il 2D opt-in i due filoni sono indipendenti, ma S espone subito un percorso GPU mai eseguito, con zero modifiche a Rust.

Dentro L l'ordine è directional → mix → sprite: prima il raggio d'azione più piccolo, e `shadow()` va generalizzata prima che la luce sprite la riusi.

## 4. Documenti obsoleti da correggere lungo la strada

Ognuno va corretto nel commit del passo che lo tocca:
- **H:**
  - l'header di `line.wgsl:1` e le righe "screen-space" in CLAUDE.md, `PROJECT_ARCHITECTURE.md:366,1738` e `hyperion-masterplan.md:1109`;
  - in CLAUDE.md: `entity-pool.ts` ("recycling"), `leak-detector.ts`, `debug-tools.ts` (7 check, non 5), `rendering-fx.ts` (tonemap stub);
  - il commento di `hyperion.ts:402-405`;
  - il §5 di `.claude/skills/gpu-check/SKILL.md`.
- **S:**
  - CLAUDE.md: `Depth` ("opt-in 2.5D"), il gotcha sulla colonna Depth, `tlv-parser` (15 tipi, Rust ne emette fino a 19), il canale lento di `ecs-inspector` (è uno stub);
  - `components.rs:229`, `components.rs:252-253`, `systems.rs:236`, `command_processor.rs:950`;
  - il §4 del design di Phase 13.
- **L:**
  - nel design Phase 17: §7.3:577 ("Mix in-shader"), §4-B:221 e §7.3:571 (global = clear color), §10.2:832-834 (determinismo), l'API di esempio del §11:861;
  - il design dei light layers, righe 53 e 224;
  - `light-groups.ts:110-113`;
  - l'header di `light-accum.wgsl`;
  - la riga di `light-accum-stage.ts` in CLAUDE.md.
