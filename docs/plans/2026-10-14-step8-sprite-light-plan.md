# Passo 8 del giro — la luce sprite (L-a): piano di implementazione

> **Per chi esegue:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (consigliato, col workflow salvato `sdd-tasks`) oppure superpowers:executing-plans, un task alla volta. Gli step usano le checkbox (`- [ ]`).

HEAD `443dc7f` (master, pulito), 2026-10-14. Branch `feat/step8-sprite-light`, base: il commit di questo piano e del record delle sue sotto-decisioni nel §2 del piano del giro, su master (Task 0, Step 0). Ogni `file:riga` è verificato a quel HEAD; dopo un task, le righe dei task successivi si ritrovano col testo citato.

**Goal:** la luce sprite (tipo 4) disegna il suo cookie: un quadrato di semilato `range` che ruota con l'asse +x locale, nella forma e nei colori della texture dell'entità, presa dai tier del motore e diritta, come da questo passo ogni immagine dei tier (quad, linee, bezier e cookie: sotto-decisione 2). Il raggio di culling in Rust diventa `range·√2`, saturato a `f32::MAX`. Al layer 0 dell'indice (l'indice 0 compreso: sotto-decisione 4) non disegna nulla, né con un layer oltre il suo array; il renderer avvisa una volta, in dev, quando una sprite resta con un indice che non nomina una texture caricata da lui (il layer 0, o un layer pari o oltre quelli in uso del suo array) per un secondo di frame illuminati senza caricamenti di texture in corso, e nomina le entità. Le ombre partono dal centro, come per una point. In Mode A le texture non si caricano: limitazione dichiarata.

**Architettura:** (0) `primitives/prelude.wgsl`: `sampleTierOrWhite` gira v dopo la risposta bianca dell'indice 0 (`var image = in; image.uv = vec2f(in.uv.x, 1.0 - in.uv.y); return sampleTier(image);`), così ogni immagine dei tier si disegna diritta; il cookie copia le due righe in `fs_main`; nessun uv di vertice cambia, msdf resta grezzo. (1) `update_bounding_radii` (`systems.rs`): per `LightType::Sprite` il raggio è `(range * SQRT_2).min(f32::MAX)`, dopo il guard di oggi. (2) `LightAccumStage`: binding 6 = `tex-indices` (VERTEX), gruppo 1 = `textureTierLayoutEntries()` via un `TextureTierBinding` risolto dal pool a ogni `encode(…, resources)`, `cullMode: 'none'` esplicito. (3) `light-accum.wgsl`: il gruppo 1 del preludio; `vs_main` decodifica l'indice come `finishVertex`, scarta un layer 0 o un `range` ≤ 0, gira il quadrato con `spriteAxes` all'uv del quad texturizzato; `fs_main` scarta un layer oltre il suo array (`cookieLayers`) e campiona con una copia di `sampleTier` a LOD 0 (`color *= cookie.rgb; intensity = cookie.a;`), senza falloff né cono, con l'ombra della point. (4) `light-groups.ts`: SPRITE nei due gate nello stesso commit; una luce ombreggiata che non può disegnare (`range` ≤ 0, o una sprite senza texture) non apre un set SDF; un solo predicato esportato, `untexturedPredicate` (il layer 0, o un layer pari o oltre i layer in uso del suo array, `textureLayersUsed`, col ramo di default dei tier), per il gate, il flag `untexturedSpriteLight` e `untexturedSpriteIds`; l'avviso dopo `UNTEXTURED_SPRITE_MS` (1000 ms) di frame illuminati, in pausa finché `TextureManager.pendingLoads` > 0 (`persistentWarning`), con fino a tre id (`untexturedSpriteIds`, `untexturedSpriteMessage`). (5) JSDoc, `lighting-api`, `prim-params-schema`. (6) Harness: una sotto-scena del tab Lighting con un cookie procedurale (PNG `data:`) e quattro check col probe, `engine.debug.textureTiers()`, `gpuErrorWitness`, `step8-compare.mjs`; in 2D Twins un check del quad e della linea con texture, diritti (`checkImageOrientation`, Task 5), e il probe di 'Depth orders transparent sprites' a `ORDER_Y - 0.15` (Task 3, Step 0).

**Cosa non cambia:** il protocollo (`MAX_COMMAND_TYPE` 57), le esportazioni WASM (`texIndices` viaggia già in A, B e C), `LightUniform`, la lista delle luci, `LIGHT_BLEND`, l'aritmetica di point, spot, directional e global e la coda del blend (spostate in un ramo annidato: il Task 9 le verifica al bit), `state_hash` (senza raggio, parametri né indice di texture, `engine.rs:1064-1225`), HSNP v3, `TextureManager` (salvo un getter in sola lettura, `pendingLoads`), il TS di `ForwardPass` e di `OccluderSeedStage` (i loro moduli composti cambiano solo in `sampleTierOrWhite`: l'uscita senza texture è identica al bit, msdf non cambia), `cull.wgsl`.

**Cosa cambia, osservabile:** le sprite prima erano scartate (`light-accum.wgsl:333-335`): con una texture ora disegnano; al layer 0, o con un layer che il renderer non ha (un tape o uno snapshot di un'altra sessione, la Mode A), restano spente, e il renderer avvisa una volta quando una sprite resta così, con un indice che non nomina una texture caricata da lui. Il raggio passa da `range` a `range·√2`; una sprite ombreggiata che può disegnare apre un set SDF, e una point o spot ombreggiata con `range` ≤ 0 non apre più un set SDF né divide un gruppo (stessi pixel: cambiano solo il costo e `engine.lighting.groups`). I quad, le linee e le bezier con texture, e le loro ombre, ora sono diritti, dove prima erano specchiati dall'alto in basso: scene, tape e snapshot vecchi li mostrano girati rispetto a prima (solo il disegno). Lighting passa da 12 a 16 check, 2D Twins da 6 a 7, il totale da 63 a 68; gli id dei tab dopo Lighting crescono di 4 (base M4 ricatturata).

**Tech stack:** Rust 1.97.1, TypeScript + Vite + vitest (Node 24), WGSL/WebGPU (Chrome su Metal, M2 Pro), `naga-cli` 30.0.1, `node:test`, `chrome-devtools-gpu`, i workflow `sdd-tasks`, `gpu-leg`, `adversarial-review`.

**Decisioni del proprietario, da non richiedere** (piano del giro, §2 "Passo 8 — deciso (2026-09-30)", §3 riga 8, §4 "Guard dell'indice 0" e "Mode A e le texture"):
- **Forma:** un quadrato di semilato `range` che ruota con l'asse +x locale, come lo spot (`lightFacing`, `light-accum.wgsl:100-103`); in Rust il raggio `range·√2`, la scala ignorata.
- **Cookie:** niente falloff radiale, luce = colore × rgb·a del cookie, dai tier (`loadTexture` + `.texture()`, la colonna `tex-indices`, `TextureTierBinding` di `primitive-bindings.ts:53-74` come gruppo 1); una copia di `sampleTier` (`prelude.wgsl:151-169`) legata da un test.
- **Indice 0:** senza texture nessuna luce, con un avviso dev emesso una volta; il guard di `forward-pass.test.ts` (`:365-420`) si estende a `light-accum.wgsl` (la sotto-decisione 4 estende la regola al layer 0 di ogni array, che non contiene mai una texture, e, lato CPU (flag, avviso e gate SDF), a ogni layer pari o oltre quelli in uso del suo array: un indice che questo renderer non ha caricato).
- **Ombre:** dal centro, come una point; `SHADOWED_LIGHT_TYPES` (`light-groups.ts:119-127`) cambia nello stesso commit di `shadowedLightType` (`light-accum.wgsl:320-326`).
- **Mode A:** le texture non si caricano (`hyperion.ts:519-522`): limitazione dichiarata.
- **Ordine:** raggio in Rust, tier in `LightAccumStage`, shader, API TS, demo con un cookie procedurale.
- **Criterio d'uscita:** un test Rust sul raggio; il guard dell'indice 0 esteso a `light-accum.wgsl`, più l'avviso; su una GPU hardware, in Mode B, col probe su `light-buffer`: il cookie a texel noti; il tier che lo contiene (l'overflow rgba8 su un device BC/ASTC) CRESCE mentre la luce disegna, con 0 errori; nessun pop al bordo del frustum, a nessuna rotazione; l'ombra di una sprite dietro un muro; Mode A: limitazione dichiarata.

**Fatti verificati** (a `443dc7f`): `LightAccumStage` ha un solo gruppo (`light-accum-stage.ts:126-148`), `encode` senza pool (`:196`) e nessun `cullMode` (`:147`; le entità hanno `'back'`); il quad delle luci non ruota (`light-accum.wgsl:149-154`); `OccluderSeedStage` risolve il gruppo 1 a ogni `encode` (`occluder-seed-stage.ts:124-128`) e `createRenderer` registra le viste dei tier a ogni `onViewsChanged` (`renderer.ts:365-376`). I tier (`texture-manager.ts`): overflow bit 31, tier 16-18, layer 0-15; PNG e JPEG all'overflow rgba8 su un device compresso (`:694-720`), ridimensionati al quadrato del tier (`:674-690`); layer 0 riservato in ogni array (`:401-403`, `:498-500`); la crescita copia e DISTRUGGE la texture vecchia (`:349-433`); solo il mip 0 (`:705-709`); cache per URL (`:545-547`). Il submit del frame è sincrono e fuori dallo scope del probe (`debug-probe.ts:197-208`). Un quad, una linea e una bezier con texture mostrano l'immagine specchiata dall'alto in basso: il loro uv locale cresce verso +y (`quad.wgsl:6`, `line.wgsl:77`, `bezier.wgsl:8`), mentre la riga 0 della texture è la prima riga dell'immagine (`copyExternalImageToTexture` senza `flipY`, `texture-manager.ts:705`, `:731`; il KTX2 si scrive grezzo, `:785`, `:829`, e `KTXorientation` non si legge); il device lo conferma (statuses del passo 7, 2D Twins, 'Depth orders transparent sprites', cella 1: (0,686, 0,769, 0,307), il quadrante in basso a destra del PNG sopra il teal). Nessuna trasformazione li rimette a posto: una scala negativa li fa scartare (`cullMode: 'back'`, `forward-pass.ts:271`, `:285`, `occluder-seed-stage.ts:96`, `selection-seed-pass.ts:107`) e una rotazione di π li specchia da sinistra a destra. Un `await` nella catena dello spawn lista la luce senza texture per i frame del caricamento. naga accetta un `textureSample` implicito nel ramo della sprite, Tint no. `f32::MAX·√2` è +inf; un quadrato girato di α sporge di `range·(|cos α|+|sin α|)`.

**Prototipi** (in uno specchio di `443dc7f`, fuori dal repo, un commit per task): ogni RED, GREEN e mutante dei Task 1-5 è stato eseguito, prima delle sotto-decisioni del controller (2026-10-14). Quello che esse aggiungono o cambiano (il Task 3 Step 0, il test che lega il giro del cookie al preludio, lo Step 7b, già provato da un giudice in un clone dello specchio, l'avviso a tempo del Task 4 coi suoi Step 7-11, il check di 2D Twins, il giro nel ramo della sprite di `fs_main` (la sua regex e i due mutanti nuovi dello Step 5b), la geometria del cookie del Task 5 (`cookieUv`, `cookiePoint` e il loro test) e il testimone del cancello) la seconda prova lo riesegue alla lettera: i conteggi che spostano sono derivati dai test aggiunti, e lì si rimisurano. Il gate GPU del Task 3: solo `node --check`.

## Vincoli globali

- **Il raggio vive in `primParams[3]`:** il raggio di culling lo deriva Rust, mai il produttore TS; sempre finito, saturato a `f32::MAX`.
- **Il gruppo 1 è quello del preludio:** stesse dichiarazioni, layout `textureTierLayoutEntries()`, `TextureTierBinding` risolto dal pool a ogni `encode()`. Lo stadio non registra nulla nel pool (una sonda HMR fa `setup()` e `destroy()` sul pool vivo).
- **Binding 6 solo VERTEX, `minBindingSize: 4`;** storage per stadio: vertex 5 su 8, fragment 3 su 8.
- **`textureSampleLevel(…, 0.0)` e basta:** mai la parola `textureSample` seguita da altro che `Level`, nemmeno in un commento (`light-accum-stage.test.ts:341` legge il sorgente grezzo).
- **Senza texture è il layer 0** (sotto-decisione 4; l'indice 0 ne è un caso): si decide in `vs_main`, mai bianco; un layer oltre il suo array si scarta in `fs_main` (`cookieLayers`), mai limitato all'ultimo; lato CPU `TEXTURE_LAYER_MASK` (`0xffff`) e, quando il renderer li dà, anche i layer in uso del `TextureManager` (`textureLayersUsed`): un layer pari o oltre quelli in uso del suo array conta come senza texture, col ramo di default dei tier (un tier oltre il 3 legge il conto del tier 0), mai «tier > 3 senza texture». Un solo predicato, `untexturedPredicate` di `light-groups.ts`, per il gate SDF, il flag e gli id dell'avviso.
- **Immagini diritte** (sotto-decisione 2): un'immagine dei tier si disegna diritta nel riferimento locale della sua primitiva, prima riga verso +y locale, prima colonna verso −x; il giro di v vive solo in `sampleTierOrWhite`, dopo la risposta bianca, e nella sua copia prima del campionamento del cookie; nessun uv di vertice cambia, `sampleTier` resta in coordinate di texture, msdf resta grezzo; mai `flipY` al caricamento (il KTX2 non potrebbe seguirlo).
- **Point, spot, directional, global, sub e mix al bit:** cambia solo il rientro (Task 9). **I due gate nello stesso commit** (Task 3). **Harness:** i check dei passi 3, 6 e 7 non cambiano; il check del 5b 'Depth orders transparent sprites' sposta il suo probe a `ORDER_Y - 0.15` (Task 3, Step 0): legge lo stesso texel, coi valori di prima; in Mode A la sotto-scena non spawna nulla.
- **Lingua:** `docs/` in italiano; codice, commenti, JSDoc, CLAUDE.md, agent, skill e JSON in inglese. Commit `<tipo>(8): <descrizione in italiano>`, riga vuota, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Comandi** (dalla radice): vitest `npx --prefix ts vitest run --root ts src/<path>.test.ts` e `npm --prefix ts test`; tipi `npx --prefix ts tsc --noEmit -p ts 2>&1 | grep -v "wasm/hyperion_core"`; naga `D="$(mktemp -d)"; cp ts/src/shaders/light-accum.wgsl "$D/"; node scripts/validate-wgsl-naga.mjs "$D"`; `cargo test -p hyperion-core [--features …] [--lib …]`; `cargo clippy -p hyperion-core --all-features --all-targets -- -D warnings`; `node --test docs/plans/assets/2026-10-08-step7/step7-stats.test.mjs docs/plans/assets/2026-09-30-step6/step6-stats.test.mjs docs/plans/assets/2026-09-30-step6/march-model.test.mjs`; `scripts/preflight.sh`. Mai `grep -P`; mai `rm -rf`; gli URL con `?` tra virgolette.
- **GPU (Mac):**
  - skill `/gpu-check`, solo `chrome-devtools-gpu`; la riga dell'adapter è `[Hyperion] WebGPU adapter: apple / metal-3 / 0x0000, subgroups 32-32`; finestra 1200×689 CSS a dpr 2 (tela 1960×1248);
  - `sh .claude/skills/gpu-check/scripts/gpu-infra.sh up` e `… down` (stesso `TMPDIR`); nessuna modifica al checkout mentre Vite gira;
  - ogni sessione è una gamba di `gpu-leg` (passi e aspettative nello spazio SDD); evidenze in `docs/plans/assets/2026-10-14-step8/` (nei passi delle gambe `<ev>`: `gpu-leg` rende assoluto il `filePath` di un nome nudo o di `<ev>/…`; nei comandi di shell il percorso si scrive per esteso), i verdetti in `legs/task-<n>-result.json` coi percorsi locali sostituiti da `<repo>`, `~` e `<tmp>`, più un `legs/README.md` (lezione 8);
  - `ts/wasm`: il Task 0 lo costruisce sulla base e ne registra lo SHA-256; nessuno lo ricostruisce fino al Task 5 (Step 8), dove col raggio vecchio fa da RED; l'avviso di `guard-stale-wasm` è atteso, e le gambe su quel `ts/wasm` (il cancello del Task 3, il RED del Task 5) lo dicono nel `context` con la frase "ts/wasm is intentionally the 443dc7f build (Task 0 Step 2), older than Task 1's Rust change. guard-stale-wasm's warning is EXPECTED and is NOT stale code for this leg: copy it into anomalies and go on; never return BLOCKED for it.";
  - nel `context` di ogni gamba: "run no evaluate_script, fetch or curl the steps do not give; a suspicion goes into anomalies; Vite's 304s under ignoreCache are expected";
  - Mode A: la tela legge 300×150 finché il render worker non presenta un frame (lezione 5): nessuna aspettativa la vincola prima di un frame disegnato.
- **Fuori dal passo:** padding dell'SDF (8c), PhysicsAPI (8b), Mode A (10), tipi 5-7, scaricamento delle texture, texture in Mode A, mip dei tier, Safari (9), misure di costo, il quad specchiato che sparisce (`cullMode: 'back'` delle pipeline delle entità, §4 del giro, punto (1b)), `KTXorientation`, la convenzione del rettangolo dell'atlante MSDF.

## Review Focus

1. **Un tier che cresce mentre una sprite disegna** (un gruppo 1 stantio fa rifiutare ogni submit, e il probe non lo vede): Task 2, il gate GPU col controllo negativo (Task 3), i check col testimone `uncapturederror` (Task 5, 9).
2. **Orientamento, rotazione e specchio del cookie, e l'immagine diritta di ogni primitiva** (sotto-decisione 2): il giro di v in `sampleTierOrWhite` dopo la risposta bianca, nessun uv di vertice cambiato, msdf grezzo (Task 3, Step 0); la copia del giro prima del campionamento del cookie, legata al preludio da un test di testo (Task 3); test di testo su `spriteAxes`, uv e decodifica (Task 3); `cullMode: 'none'` (Task 2); il check del cookie a 0, ¼ di giro e π/6, e K specchiata in y e in x (Task 5); il check di 2D Twins sul quad e sulla linea con texture, e il probe di 'Depth orders transparent sprites' sul texel giallo (Task 3 Step 0, Task 5); d9 per una texture cambiata da sola (Task 1).
3. **Layer 0, un layer oltre l'array o oltre quelli in uso, e range ≤ 0** (niente luce, l'avviso se dura, nessun flood): guard di `forward-pass.test.ts`, drop in `vs_main`, `cookieLayers`, gate SDF (Task 3; Step 7b: anche point e spot con `range` ≤ 0); il testimone a cinque letture del cancello GPU (Task 3, Step 8); flag, sweep sugli 8 tipi, `persistentWarning` a tempo e in pausa con `pendingLoads`, `untexturedSpriteIds`, `lighting-api` (Task 4); i layer in uso (`textureLayersUsed`, `textureLayerCounts`, il ramo di default dei tier) e il pin di `texture-manager` (Task 4, Step 7-11); skip di Mode A (Task 5); l'avviso dal vivo in B e A (Task 9, 9e).
4. **Il raggio a ogni rotazione e al limite di f32:** test Rust e d8 (Task 1); il check del pop, rosso col raggio vecchio nel modello e sul device (Task 5).
5. **Point, spot, directional, global, sub e mix al bit con `fs_main` ristrutturato:** test di testo dei passi 6 e 7 e quello strutturale di `fs_main` (Task 3); `regress` in quattro gambe e `order` in mix contro il passo 7 nella stessa sessione, `step8-compare.mjs details` (Task 5, 9).
6. **Il mix con un cookie:** la lettura in mix del check del cookie (Task 5); il ramo `mix` resta il testo del passo 7 (Task 3).

## Struttura dei file

| File | Task |
|---|---|
| `crates/hyperion-core/src/systems.rs`, `components.rs`, `engine.rs`, `tests/verify_2d.rs`: il raggio | 1 |
| `ts/src/render/passes/light-accum-stage.ts`, `light-groups-pass.ts` (+ test): gruppo 1, binding 6 | 2 |
| `ts/src/shaders/primitives/prelude.wgsl`, `primitives/line.wgsl` (un commento), `ts/src/demo/twin-2d.ts` (+ test), `forward-pass.test.ts`: le immagini diritte (Step 0) | 3 |
| `ts/src/shaders/light-accum.wgsl`, `ts/src/render/light-groups.ts` (+ test), `light-accum-stage.test.ts`, `forward-pass.test.ts`, `tools/gate-step8.js`: la sprite, i gate, il cancello GPU | 3 |
| `light-groups.ts`, `light-groups-pass.ts`, `renderer.ts`, `render/frame-inputs.ts`, `render/render-pass.ts`, `texture-manager.ts`, `lighting-api.ts`, `entity-handle.ts`, `hyperion.ts`, `prim-params-schema.ts` (+ test): flag, avviso, layer in uso, JSDoc | 4 |
| `ts/src/demo/lighting-sprite.ts` (+ test), `demo/twin-2d.ts` (+ test), `demo/probe-checks.ts` (+ test), `hyperion.ts` (+ test), `demo/lighting.ts`: i quattro check della sprite e quello delle immagini diritte | 5 |
| questo piano e il §2 del piano del giro (su master), `tools/lighting-tab.js`, `tools/twin-tab.js`, `tools/step8-compare.mjs` | 0 |
| commenti, design, `PROJECT_ARCHITECTURE.md`, `CLAUDE.md`, agent, skill, hook, piano del giro | 6 |
| `docs/plans/assets/2026-10-14-step8/` (evidenze, `legs/`), README del Mac | 3, 5, 9 |
| `CLAUDE.md`, skill, piano del giro, memoria: numeri e stato | 10 |

## Task

Task 0: il piano e le sotto-decisioni su master, base, ruling, strumenti; Task 1-5: il codice, nell'ordine del proprietario, con un cancello GPU dopo il Task 3 e il tab Lighting sul device dopo il Task 5; Task 6-8: documenti, preflight, review; Task 9-10: verifica GPU, numeri, merge, memoria. I Task 1-5 girano con `sdd-tasks` in due tornate (1-3 e 4-5); gli step GPU sono del controller, dopo il commit del loro task.

### Task 0: il piano e le sotto-decisioni su master, branch, base verde, ruling, strumenti

- [ ] **Step 0: il piano e le sotto-decisioni su master** (il controller), prima di tutto, come ai passi 6 e 7 (`e2c5c39`, `5b36b6a`). Le sotto-decisioni le ha prese il controller il 2026-10-14, su delega del proprietario (memoria `feedback-autonomous-round`; l'ultima sezione di questo piano ne dà opzioni, pro e contro e ragioni). Il loro record va nel §2 del piano del giro, come ultimo punto di "Passo 8 — deciso (2026-09-30)" (`:65-70`, dopo il punto "**Mode A.**"), nello stesso commit del piano:
```markdown
  - **Sotto-decisioni del piano del passo 8, decise dal controller su delega del proprietario (2026-10-14)** («le decisioni prendile tu dopo un'accurata analisi dei pro e contro; dobbiamo puntare al miglior prodotto possibile, con la qualità migliore che riusciamo ad ottenere»; il piano `2026-10-14-step8-sprite-light-plan.md` ne dà nell'ultima sezione opzioni, pro e contro e ragioni; analisi: workflow `wf_947b5912-a44`, tre lenti per forca — la qualità per chi usa l'API, la coerenza del motore, il costo e il rischio — e un giudice per forca; il proprietario può ribaltarle). La 2, la 3 e la 4 estendono il passo oltre la luce sprite: il rapporto finale le segnala.
    - **1, lo specchio con una scala negativa: (a).** `spriteAxes` prende il facing (`lightFacing`, il +x locale) e l'asse laterale girato col segno del determinante della parte 2×2: il cookie si specchia come l'immagine di un quad (una x negativa da sinistra a destra, una y negativa dall'alto in basso, entrambe di mezzo giro). Pro: esatta per ogni parte 2×2 fuori dal ripiego di `lightFacing`, shear compreso (`dot(side, colonna 1) = det / |colonna 0|`; modello f32: 0 discordanze su 500 000 trasformazioni, angoli entro 1,3e-7 di `range·√2`); si compone nella gerarchia (un rig girato con `scale(-1, 1)` specchia le sue luci); più espressiva di (b), il cui mezzo giro è `rotation(θ + π)`; tiene la parola del passo 6, «una scala x negativa specchia». Contro: il segno della scala y conta per la prima volta (invisibile su spot e sole; la grandezza della scala resta ignorata). Costo nullo: la pipeline delle luci non ha mai scartato facce (`cullMode` di default `'none'`), e il Task 2 lo rende esplicito. Scartata (b), un quarto di giro dal facing: una y negativa ignorata e un mezzo giro al posto dello specchio. Il difetto dei quad specchiati, che oggi spariscono (`cullMode: 'back'` delle pipeline delle entità), va nel §4 (punto (1b)): il passo 8 non lo corregge.
    - **2, l'orientamento delle immagini: (e), estensione del passo.** Verificato anche sul device: oggi un'immagine dei tier si disegna specchiata dall'alto in basso (la prima riga, la cima, cade sul lato −y locale: `quad.wgsl:6`, `line.wgsl:77`, `bezier.wgsl:8`; il mondo è y-up; nessun `flipY` al caricamento; nelle letture M2 del passo 7 il quadrante in alto a destra del quad di 2D Twins ha il colore di quello in basso a destra del PNG), e su un quad nessuna trasformazione la raddrizza (una scala negativa lo fa scartare, una rotazione di π lo specchia da sinistra a destra). Scelta: `sampleTierOrWhite` del preludio gira v dopo la risposta bianca dell'indice 0, e il cookie copia quelle due righe prima di `sampleTier`; nessun uv di vertice cambia (bordi delle linee, punti dei bezier, gradient intatti), i pixel senza texture restano identici al bit, msdf resta grezzo. Quad, linee, bezier e cookie disegnano l'immagine diritta nel loro riferimento locale, la prima riga verso +y. Pro: un'API nuova giusta dal primo giorno, e chiuso un difetto che nessuno poteva aggirare; una regola per ogni primitiva con un'immagine; nessun banco committato usa texture; un solo check da adattare (il probe di 'Depth orders transparent sprites' scende a `ORDER_Y − 0,15`: stesso texel, stessi valori). Contro: tocca il preludio di tutti e sette i moduli (il cancello M4 resta il testimone al bit dei pixel senza texture); scene, tape e snapshot con quad, linee o bezier texturizzati li mostrano girati rispetto a prima (solo il disegno, ombre comprese). Un commit suo (Task 3, Step 0) e un check nuovo in 2D Twins (Task 5). Scartate: (a) il cookie capovolto come il quad (un difetto misurato dentro un'API nuova); (b) due convenzioni per lo stesso PNG; (c) la correzione nel solo `quad_vs` (linee e bezier resterebbero girate rispetto ai quad); (d) un passo a parte (lo stesso prodotto con un ciclo in più); `flipY` al caricamento (i blocchi KTX2 non possono seguirlo).
    - **3, il set SDF di una luce ombreggiata che non può disegnare: (c), estensione del passo.** Una regola per ogni tipo ombreggiato: apre o raggiunge un set SDF solo con `range` > 0, e una sprite solo con una texture. Stessi pixel di (b) per costruzione (una luce che non può disegnare non arriva mai a una marcia; 80 000 scene casuali, 0 differenze); toglie i flood che nessuno legge (+1,84 ms a 1080p sull'iGPU AMD per set) anche alle point e spot con `range` ≤ 0, un difetto visto al passo 6 e mai registrato. Un commit suo (Task 3, Step 7b), che generalizza il test del sole: nessun conteggio cambia, e un `git revert` lo toglie.
    - **4, il layer 0 e i layer che il renderer non ha: (a) + (c) + (d), estensione del passo nel solo verso che spegne.** Sulla GPU, come nel piano: `vs_main` scarta `layer == 0u` (l'indice 0 è un caso: la regola dell'indice 0 si estende alla lettera al layer 0 di ogni array, che non contiene mai una texture) e `fs_main` un layer oltre il suo array (`cookieLayers`). (c) Lato CPU, un solo predicato (`untexturedPredicate` di `light-groups.ts`) per il gate SDF, il flag e l'avviso conta come senza texture anche un layer pari o oltre i layer IN USO del suo array (`textureLayersUsed`, dal `TextureManager`, col ramo di default dei tier come `sampleTier`): una handle di un'altra sessione, di un tape, di uno snapshot o della Mode A avvisa e non apre un set, e nessuna handle legittima può cadere oltre (ogni caricamento prende `nextFreeLayer` e lo incrementa prima di risolvere). (d) Un testimone di cinque letture nel cancello GPU del Task 3 prova le due guardie sul device. Un fatto corretto: il layer 0 è bianco se rgba8, nero trasparente se BC7, ma il colore d'errore se ASTC (magenta opaco, o quattro NaN in una decodifica lineare: un blocco tutto zero ha una modalità di blocco riservata; dalla specifica, non misurato: l'M2 usa BC7). Scartata (b), l'indice 0 alla lettera: quadrati bianchi o magenta a seconda del device, e in Mode A ogni indice non nullo accenderebbe un quadrato, senza avviso.
    - **D3, la sede dei check: (a), tenuta.** Una sotto-scena del tab Lighting in (200, 0), come ai passi 6 e 7: gira in ogni corsa di `/gpu-check`, nel cancello M4, nella gamba Safari del passo 9 e nella sessione Fedora; +4 id ai tab dopo Lighting (base M4 ricatturata).
    - **D4, l'avviso: (d').** Dal flag di `deriveLightGroups`, una volta per renderer, solo in dev, dopo `UNTEXTURED_SPRITE_MS` (1000 ms) di frame illuminati (`performance.now()`, al più 100 ms per frame), in pausa finché il `TextureManager` ha caricamenti in corso (`pendingLoads`); nomina fino a tre id esterni. Su un modello di 84 scenari (21 casi a 60, 120, 165 e 240 Hz): 4 falsi positivi e 4 falsi negativi, contro i 36 e 0 della regola dei 60 frame (a 120 Hz, quelli dell'M2, 60 frame sono mezzo secondo: avviserebbe su un caricamento corretto); una pausa e non un reset, perché un caricamento altrove non deve nascondere una luce senza texture.
```
  `git status --short` stampa solo ` M docs/plans/2026-09-27-open-items-round-plan.md` e `?? docs/plans/2026-10-14-step8-sprite-light-plan.md` (altrimenti ci si ferma), poi:
```bash
git add docs/plans/2026-10-14-step8-sprite-light-plan.md docs/plans/2026-09-27-open-items-round-plan.md
git commit -m "docs(8): piano del passo 8 del giro (la luce sprite) e le sue sotto-decisioni nel §2" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
```
  Se il push fallisce per le credenziali, il commit resta locale e lo si dice nel rapporto finale.
- [ ] **Step 1: branch.** `git status --short` vuoto; `git checkout master && git pull --ff-only origin master`; `git checkout -b feat/step8-sprite-light`.
- [ ] **Step 2: base verde.** `scripts/preflight.sh` `OK`; vitest 115 file, 2125 + 7 saltati; Rust (`cargo test -p hyperion-core [--features …] 2>&1 | grep -oE 'ok. [0-9]+ passed' | awk '{s+=$2} END {print s}'`) 259, 383 (`physics-2d`), 295 (`dev-tools`), 438 (`--all-features`); `node:test` 64/64. Poi `npm --prefix ts run build:wasm` sulla base, e nel registro SDD la data del `.wasm` e `shasum -a 256 ts/wasm/hyperion_core_bg.wasm`, che la gamba RED del Task 5 ricontrolla (il cancello del Task 3 non lo usa: apre un device suo): questo `ts/wasm`, col raggio vecchio, resta fino al Task 5 (Step 8), dove fa da RED.
- [ ] **Step 3: le sotto-decisioni, come ruling.** Qui non si decide nulla: le sotto-decisioni sono quelle registrate allo Step 0 (il §2 del piano del giro; la sezione «Sotto-decisioni» di questo piano). Il controller apre lo spazio SDD
```bash
SK=/Users/edoardocicognani/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/subagent-driven-development
WS="$(bash "$SK/scripts/sdd-workspace" docs/plans/2026-10-14-step8-sprite-light-plan.md)"; echo "$WS"
```
  e vi scrive `global-constraints.md` (in inglese): i Vincoli globali, le decisioni del §2 e, sotto «Rulings (the controller's sub-decisions, 2026-10-14; never re-decide them)», le sotto-decisioni 1 (a), 2 (e), 3 (c), 4 (a) + (c) + (d), D3 (a) e D4 (d'), una riga ciascuna con la scelta e ciò che cambia nei task. Le stesse righe vanno come ruling nel `context` di ogni task di `sdd-tasks` (Step 6). Un finding di una review contro una di esse non si corregge nel giro: va nel rapporto finale, perché il proprietario possa ribaltarla.
- [ ] **Step 4: spazio SDD e strumenti** (`.superpowers/sdd/` è ignorato da git):
```bash
SK=/Users/edoardocicognani/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/subagent-driven-development
for n in 1 2 3 4 5; do bash "$SK/scripts/task-brief" docs/plans/2026-10-14-step8-sprite-light-plan.md $n; done
mkdir -p docs/plans/assets/2026-10-14-step8/tools docs/plans/assets/2026-10-14-step8/legs
sed "s/'hyperion-step7-harness\/1'/'hyperion-step8-harness\/1'/" docs/plans/assets/2026-10-08-step7/tools/lighting-tab.js > docs/plans/assets/2026-10-14-step8/tools/lighting-tab.js
grep -c "hyperion-step8-harness/1" docs/plans/assets/2026-10-14-step8/tools/lighting-tab.js
sed -e "s/const KEY = 'lighting', LABEL = 'Lighting';/const KEY = 'twin-2d', LABEL = '2D Twins';/" -e "s/'hyperion-step8-harness\/1'/'hyperion-step8-twin\/1'/" -e 's/^    lighting: checks,$/    twin2d: checks,/' docs/plans/assets/2026-10-14-step8/tools/lighting-tab.js > docs/plans/assets/2026-10-14-step8/tools/twin-tab.js
grep -c -e "const KEY = 'twin-2d', LABEL = '2D Twins';" -e "'hyperion-step8-twin/1'" -e '^    twin2d: checks,$' docs/plans/assets/2026-10-14-step8/tools/twin-tab.js
```
  Il secondo comando stampa `1`, l'ultimo `3`: `twin-tab.js` fa per il tab 2D Twins quello che `lighting-tab.js` fa per Lighting (i check col loro dettaglio, sotto `twin2d`), per la gamba GREEN del Task 5. Poi `docs/plans/assets/2026-10-14-step8/tools/step8-compare.mjs`, i confronti offline delle gambe GPU (Task 5, Task 9): `details` confronta i dettagli dei check dei passi 3, 6 e 7 con la base del passo 7 (`detailsDiff` di `step6-stats.mjs`), con gli id della lista mascherati (dipendono dai tab girati prima: `ids P 105, Q 106` nella base, `267/268` in B e `351/352` in C al secondo ingresso del passo 7, `64/65` su una pagina fresca); `mix` confronta al bit i mix del banco del passo 7 (task `order`) fra i motori dei passi 7 e 8:
```js
// docs/plans/assets/2026-10-14-step8/tools/step8-compare.mjs: the offline gates
// of the step-8 GPU legs (round step 8, the sprite light). Prints JSON; exits 0
// fine, 1 out of tolerance, 2 bad usage or input, 3 refused.
//   node step8-compare.mjs details <harness.json> <statuses.json>
//     The Lighting details of steps 3, 6 and 7 against the step-7 base, within
//     DETAILS_TOL; refused off the 1960x1248 canvas. The light-list check's
//     external ids are masked: they depend on the tabs a page ran before.
//   node step8-compare.mjs mix <step7-bench.json> <step8-bench.json>
//     The last `order` run with blend 'mix' of each side (the step-7 bench):
//     one grid over its reads and the same scene (refused otherwise), then
//     every point identical.
import { readFileSync } from 'node:fs';
import { compareGrids, decodeGrid, detailsDiff } from '../../2026-09-30-step6/step6-stats.mjs';
import { DETAILS_TOL, HARNESS_CANVAS, LIGHTING_DETAIL_CHECKS } from '../../2026-10-08-step7/step7-stats.mjs';

const NAMES = [...LIGHTING_DETAIL_CHECKS, 'Mix light replaces the light buffer', 'Mix order follows depth', 'Light list: exact cull, id at equal depth'];
const lighting = (x) => (x?.lighting ?? x?.tabs?.lighting?.checks ?? [])
  .map((c) => ({ ...c, detail: String(c.detail ?? '').replace(/ids P \d+, Q \d+/g, 'ids P, Q') }));
const mixRun = (bench) => (bench?.results ?? []).filter((r) => r.task === 'order' && r.blend === 'mix').at(-1);
const slots = (r) => (r.lights ?? []).map((l) => l.slot).join();
const [command, fileA, fileB] = process.argv.slice(2);
let out;
try {
  const [a, b] = [fileA, fileB].map((f) => JSON.parse(readFileSync(f, 'utf8')));
  if (command === 'details') {
    const c = a.canvas ?? [];
    const refusals = c[0] === HARNESS_CANVAS[0] && c[1] === HARNESS_CANVAS[1] ? [] : [`a ${c.join('x') || 'missing'} canvas, want ${HARNESS_CANVAS.join('x')}`];
    const checks = detailsDiff(lighting(a), lighting(b), NAMES, DETAILS_TOL);
    out = { ok: checks.every((x) => x.ok), refusals, checks };
  } else if (command === 'mix') {
    const [s7, s8] = [mixRun(a), mixRun(b)];
    if (!s7 || !s8) throw new Error("no order run with blend 'mix' on a side");
    const refusals = [s7, s8].filter((r) => r.distinct?.length !== 1).map((r) => `${r.distinct?.length ?? 0} grids over ${r.reads} reads, want 1`);
    if (slots(s7) !== slots(s8) || s7.K !== s8.K || s7.apart !== s8.apart) refusals.push(`another scene: slots ${slots(s7)} against ${slots(s8)}`);
    const c = refusals.length ? null : compareGrids(decodeGrid(s7.distinct[0].grid), decodeGrid(s8.distinct[0].grid));
    out = { ok: c !== null && c.identical === c.n, refusals, n: c?.n ?? 0, identical: c?.identical ?? 0, maxAbs: c?.maxAbs ?? null };
  } else {
    throw new Error('usage: details <harness.json> <statuses.json> | mix <step7-bench.json> <step8-bench.json>');
  }
} catch (err) {
  console.error(`step8-compare: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
console.log(JSON.stringify(out, null, 2));
process.exitCode = out.refusals.length > 0 ? 3 : out.ok ? 0 : 1;
```
  La prova sui file del passo 7: `node docs/plans/assets/2026-10-14-step8/tools/step8-compare.mjs details docs/plans/assets/2026-10-08-step7/harness-m2-B.json docs/plans/assets/2026-10-08-step7/baseline/statuses-B.json` e lo stesso con `C` (exit 0, i nove check `ok`); `node docs/plans/assets/2026-10-14-step8/tools/step8-compare.mjs mix docs/plans/assets/2026-10-08-step7/order-m2-B.json docs/plans/assets/2026-10-08-step7/order-m2-B.json` (exit 0, `identical` 2304); `node docs/plans/assets/2026-10-14-step8/tools/step8-compare.mjs details docs/plans/assets/2026-10-08-step7/harness-task5-B.json docs/plans/assets/2026-10-08-step7/baseline/statuses-B.json` (exit 1: il formato di prima della fix wave del passo 7). Nello spazio SDD anche `progress.md` (il registro); `global-constraints.md` è dello Step 3.
- [ ] **Step 5: commit**
```bash
git add docs/plans/assets/2026-10-14-step8/tools/lighting-tab.js docs/plans/assets/2026-10-14-step8/tools/twin-tab.js docs/plans/assets/2026-10-14-step8/tools/step8-compare.mjs
git commit -m "docs(8): gli script dei tab Lighting e 2D Twins e step8-compare" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
- [ ] **Step 6: la prima tornata SDD** (`startBase` = `git rev-parse HEAD` dopo lo Step 5):
```js
Workflow({ name: 'sdd-tasks', args: {
  repo: '/Users/edoardocicognani/Code/HyperionEngine',
  plan: 'docs/plans/2026-10-14-step8-sprite-light-plan.md',
  ws: '/Users/edoardocicognani/Code/HyperionEngine/.superpowers/sdd/2026-10-14-step8-sprite-light-plan',
  sk: '/Users/edoardocicognani/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/subagent-driven-development',
  startBase: '<SHA>',
  branch: 'feat/step8-sprite-light',
  fixCommitPrefix: 'fix(8)',
  project: 'Hyperion, a web game engine (Rust/WASM simulation + TypeScript WebGPU rendering). Round step 8: the sprite light (type 4) draws its cookie, a square of half-side range turned with the light, shaped by the entity texture from the engine texture tiers; every tier image (quads, lines, beziers, the cookie) is drawn upright (sampleTierOrWhite turns v over after its white answer, the cookie copies the two lines); Rust culls the sprite light on range*sqrt(2); untextured (layer 0) it draws nothing, and a layer past its array is discarded; on the CPU a layer at or past its array\'s used count is untextured too (one predicate, untexturedPredicate, for the SDF gate, the flag and a dev warning after 1 s of lit frames with no texture load in flight, naming the lights); a shadowed light of range <= 0 opens no SDF set; it casts shadows from its centre; the Task 3 GPU gate also reads five texels of its target as a witness of the layer-0 drop and the cookieLayers bound.',
  constraints: '/Users/edoardocicognani/Code/HyperionEngine/.superpowers/sdd/2026-10-14-step8-sprite-light-plan/global-constraints.md',
  gpuRule: 'Task 3 Step 8 and Task 5 Step 8 (gpu-leg legs) are the controller\'s, after your commit. Never rebuild ts/wasm.',
  anchorsRule: 'The file:line references are anchored to 443dc7f; after an earlier task they shift, so find each edit by its quoted text.',
  tasks: [
    { n: 1, title: 'Il raggio di una luce sprite in Rust', context: 'SCOPE: the whole task, headless. RULINGS: global-constraints.md, "Rulings": the controller\'s sub-decisions 1 (a), 2 (e), 3 (c), 4 (a)+(c)+(d), D3 (a), D4 (d\'); never re-decide them.' },
    { n: 2, title: 'I tier delle texture in LightAccumStage', context: 'SCOPE: the whole task, headless. RULINGS: global-constraints.md, "Rulings": the controller\'s sub-decisions 1 (a), 2 (e), 3 (c), 4 (a)+(c)+(d), D3 (a), D4 (d\'); never re-decide them.' },
    { n: 3, title: 'Lo shader della luce sprite e i due gate', context: "SCOPE: Steps 0-7b, three commits (Step 0, Step 7, Step 7b, each its own) plus any review fix as fix(8); Step 8 (GPU) is the controller's. RULINGS: global-constraints.md, \"Rulings\": the controller's sub-decisions 1 (a), 2 (e), 3 (c), 4 (a)+(c)+(d), D3 (a), D4 (d'); never re-decide them.", reviewContext: 'Step 0, its own commit, turns v over in the prelude\'s sampleTierOrWhite after the white answer (every tier image upright; no vertex uv changes, msdf stays raw) and moves the 2D Twins depth probe to ORDER_Y - 0.15. Both gates in one commit (Step 7); the sampleTier copy text-identical to the prelude, the cookie\'s two flip lines tied to the prelude\'s by a text test, cookieLayers counting layers only, untexturedPredicate exported; the steps 6 and 7 text tests keep their assertions (Step 1 rewords one comment of the step-6 tie test, and Step 7b generalises the step-6 sun test in place), except the step-7 header test ("the header no longer says mix is added like add"), which this task extends to the sprite light. Step 7b, its own commit, makes the SDF gate one rule (range > 0 for every shadowed type, plus a texture for a sprite light) by generalising the sun test in place: point and spot pixels are unchanged, the type lists are untouched, so both gates still change in Step 7\'s commit.' },
  ],
} })
```
  La seconda ha la stessa forma: `startBase` = HEAD dopo il cancello del Task 3, `tasks` il 4 ("SCOPE: the whole task, headless, two commits: Steps 1-6, then Steps 7-11." più la riga RULINGS) e il 5 ("SCOPE: Steps 1-7; Steps 7b (harness-check-auditor) and 8 (GPU) are the controller's." più la riga RULINGS). Il controller salva rapporti e review nello spazio SDD.

### Task 1: il raggio di culling di una luce sprite in Rust

Il quadrato che ruota raggiunge `range·√2` dal centro a 45°: col raggio `range` sparisce mentre un angolo è in vista. Il prodotto trabocca da range ≈ 2,406e38 e satura a `f32::MAX`.

**Files:** `crates/hyperion-core/src/systems.rs`, `components.rs`, `engine.rs`, `tests/verify_2d.rs`. **Interfaces:** nessuna nuova; consuma `LightType::Sprite` (`components.rs:358`), `spawn_light` (`systems.rs:581-601`), `spawn_cmd`/`FIXED_DT`/`Command` (`engine.rs`), `cmd`/`spawn`/`floats`/`primitive`/`gpu_row`/`staged`/`assert_close` (`verify_2d.rs:8-57`); produce gli aiutanti di test `spawn_sprite_light`, `light_type(id, t)` e `texture(id, packed)`.

- [ ] **Step 1: i test che falliscono.** In `systems.rs`, il test `:771-783` diventa (il resto del corpo invariato):
```rust
    #[test]
    fn point_and_spot_lights_keep_their_range() {
        for kind in [LightType::Point, LightType::Spot] {
```
  Fra la sua chiusura e `#[test] fn bounds_override_pins_a_light_radius_too()` (`:785`):
```rust
    // --- Round step 8: a sprite light is a square of half-side `range` that
    // turns with the light, so it culls on its half-diagonal. ---

    fn spawn_sprite_light(world: &mut World, range: f32, scale: f32) -> hecs::Entity {
        let e = spawn_light(world, range, scale);
        world
            .insert_one(e, LightFlags::new(LightType::Sprite, LightBlendMode::Add, 1))
            .unwrap();
        e
    }

    #[test]
    fn sprite_light_radius_is_its_range_times_sqrt_2() {
        for range in [50.0f32, 3.0, 0.1, 1.0e6] {
            let mut world = World::new();
            let e = spawn_sprite_light(&mut world, range, 1.0);
            update_bounding_radii(&mut world);
            // Bit for bit the f32 product.
            assert_eq!(
                world.get::<&BoundingRadius>(e).unwrap().0,
                range * std::f32::consts::SQRT_2,
                "range {range}"
            );
        }
    }

    #[test]
    fn sprite_light_radius_reaches_its_farthest_corner_at_any_rotation() {
        // Turned by `a`, the square reaches range * (|cos a| + |sin a|).
        let range = 50.0f32;
        let mut world = World::new();
        let e = spawn_sprite_light(&mut world, range, 1.0);
        update_bounding_radii(&mut world);
        let r = f64::from(world.get::<&BoundingRadius>(e).unwrap().0);
        let ulps = 2.0 * f64::from(f32::EPSILON); // the f32 rounding of the product
        let mut widest = 0.0f64;
        for deg in 0..=360 {
            let a = f64::from(deg).to_radians();
            let reach = f64::from(range) * (a.cos().abs() + a.sin().abs());
            assert!(reach <= r * (1.0 + ulps), "{deg} deg: a corner {reach} past the radius {r}");
            widest = widest.max(reach);
        }
        assert!(widest >= r * (1.0 - ulps), "the radius is the half-diagonal, no more: {widest} vs {r}");
    }

    #[test]
    fn sprite_light_radius_ignores_a_scaled_rotated_parent() {
        // Parent x3 and 0.7 rad, light x40 and -1.1 rad: a matrix-derived
        // radius would be about 104; the square ignores the matrix.
        let mut world = World::new();
        let parent = world.spawn((
            Position(Vec3::new(100.0, -20.0, 0.0)),
            Rotation(Quat::from_rotation_z(0.7)),
            Scale(Vec3::splat(3.0)),
            ModelMatrix::default(),
            Active,
        ));
        let light = spawn_sprite_light(&mut world, 50.0, 40.0);
        world.insert_one(light, Parent(0)).unwrap();
        world.get::<&mut Rotation>(light).unwrap().0 = Quat::from_rotation_z(-1.1);
        transform_system(&mut world);
        propagate_transforms(&mut world, &HashMap::from([(0u32, parent), (1u32, light)]));
        let m = world.get::<&ModelMatrix>(light).unwrap().0;
        assert!((Vec3::new(m[0], m[1], m[2]).length() - 120.0).abs() < 1e-3, "premise: world x scale 3 * 40");
        assert!((m[12] - 100.0).abs() < 1e-3, "premise: composed with the parent");
        update_bounding_radii(&mut world);
        assert_eq!(world.get::<&BoundingRadius>(light).unwrap().0, 50.0 * std::f32::consts::SQRT_2);
    }

    #[test]
    fn sprite_light_radius_saturates_at_f32_max() {
        // range * sqrt(2) overflows past about 2.4e38: saturated like a
        // global light's radius, never an infinity in the snapshot.
        assert!((f32::MAX * std::f32::consts::SQRT_2).is_infinite(), "premise");
        for range in [2.5e38f32, f32::MAX] {
            let mut world = World::new();
            let e = spawn_sprite_light(&mut world, range, 1.0);
            update_bounding_radii(&mut world);
            assert_eq!(world.get::<&BoundingRadius>(e).unwrap().0, f32::MAX, "range {range}");
        }
    }

    #[test]
    fn sprite_light_radius_rejects_non_positive_and_non_finite_range() {
        for bad in [-1.0f32, -0.0, 0.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut world = World::new();
            let e = spawn_sprite_light(&mut world, bad, 1.0);
            update_bounding_radii(&mut world);
            let r = world.get::<&BoundingRadius>(e).unwrap().0;
            assert_eq!(r.to_bits(), 0, "range {bad} must collapse to +0.0, got {r}");
        }
    }

    #[test]
    fn bounds_override_pins_a_sprite_light_radius_too() {
        let mut world = World::new();
        let e = spawn_sprite_light(&mut world, 300.0, 1.0);
        world.insert_one(e, BoundsOverride).unwrap();
        world.insert_one(e, BoundingRadius(12.0)).unwrap();
        update_bounding_radii(&mut world);
        assert_eq!(world.get::<&BoundingRadius>(e).unwrap().0, 12.0);
    }

```
  In `engine.rs`, dopo la chiusura di `switching_a_light_to_global_reaches_the_gpu_bounds` (`:1986`):
```rust

    #[test]
    fn switching_a_light_to_sprite_reaches_the_gpu_bounds() {
        // SetLightFlags and SetPrimParams0 mark only `meta` dirty; the staged
        // row carries this frame's radius.
        let mut engine = Engine::new();
        engine.process_commands(&[spawn_cmd(0)]);
        let mut prim = [0u8; 16];
        prim[0] = crate::components::PRIM_TYPE_LIGHT2D;
        let range = |r: f32| {
            let mut p = [0u8; 16];
            p[12..16].copy_from_slice(&r.to_le_bytes());
            Command { cmd_type: CommandType::SetPrimParams0, entity_id: 0, payload: p }
        };
        let set_type = |t: u8| {
            let mut p = [0u8; 16];
            p[0] = t;
            p[2..4].copy_from_slice(&1u16.to_le_bytes());
            Command { cmd_type: CommandType::SetLightFlags, entity_id: 0, payload: p }
        };
        engine.process_commands(&[
            Command { cmd_type: CommandType::SetRenderPrimitive, entity_id: 0, payload: prim },
            range(80.0),
        ]);
        engine.update(FIXED_DT);
        let e = engine.entity_map.get(0).unwrap();
        let slot = engine.render_state.get_slot(e).unwrap() as usize;
        let gpu_radius = |engine: &Engine| engine.render_state.gpu_bounds()[slot * 4 + 3];
        assert_eq!(gpu_radius(&engine), 80.0);

        engine.process_commands(&[set_type(crate::components::LightType::Sprite as u8)]);
        engine.update(FIXED_DT);
        assert_eq!(gpu_radius(&engine), 80.0 * std::f32::consts::SQRT_2, "a sprite light culls on its half-diagonal");

        engine.process_commands(&[range(20.0)]);
        engine.update(FIXED_DT);
        assert_eq!(gpu_radius(&engine), 20.0 * std::f32::consts::SQRT_2, "a range change alone re-stages it");

        engine.process_commands(&[set_type(crate::components::LightType::Point as u8)]);
        engine.update(FIXED_DT);
        assert_eq!(gpu_radius(&engine), 20.0, "back to its range");
    }
```
  In fondo a `tests/verify_2d.rs`:
```rust

// ─────────────────────────────────────────────────────────────────
// Sprite light (round step 8): a square of half-side `range` that turns
// with the light, shaped by its cookie, the texture index any entity takes.
// ─────────────────────────────────────────────────────────────────

fn light_type(id: u32, t: u8) -> Command {
    let mut p = [0u8; 16];
    p[0] = t;
    p[2..4].copy_from_slice(&1u16.to_le_bytes()); // layer 0
    cmd(CommandType::SetLightFlags, id, p)
}
fn texture(id: u32, packed: u32) -> Command {
    let mut p = [0u8; 16];
    p[0..4].copy_from_slice(&packed.to_le_bytes());
    cmd(CommandType::SetTextureLayer, id, p)
}

#[test]
fn d8_a_sprite_light_culls_on_its_half_diagonal_and_carries_its_cookie_in_both_archetypes() {
    // An overflow-tier layer, where a PNG cookie lands on a BC/ASTC device.
    const COOKIE: u32 = (1 << 31) | (2 << 16) | 3;
    let mut e = Engine::new();
    e.process_commands(&[spawn(0, true), spawn(1, false)]);
    let mut cmds = Vec::new();
    for id in [0, 1] {
        cmds.push(floats(CommandType::SetPosition, id, &[5.0, 6.0, 0.0]));
        cmds.push(floats(CommandType::SetRotation2D, id, &[0.7]));
        cmds.push(floats(CommandType::SetScale, id, &[40.0, 40.0, 1.0]));
        cmds.push(primitive(id, 6));
        cmds.push(light_type(id, 4)); // LightType::Sprite
        cmds.push(floats(CommandType::SetPrimParams0, id, &[1.0, 0.8, 0.6, 12.0]));
        cmds.push(texture(id, COOKIE));
    }
    e.process_commands(&cmds);
    e.update(1.0 / 60.0);

    let want = 12.0f32 * std::f32::consts::SQRT_2;
    let (t2, b2) = gpu_row(&e, 0);
    let (t3, b3) = gpu_row(&e, 1);
    assert_eq!(&b2[..3], &[5.0, 6.0, 0.0]);
    assert_eq!(b2[3], want, "the radius is range * sqrt(2), scale and rotation ignored");
    assert_close(&t2, &t3, "transform");
    assert_close(&b2, &b3, "bounds");

    for (id, format) in [(0u32, 0u32), (1, 1)] {
        let slot = e.render_state.get_slot(e.entity_map.get(id).unwrap()).unwrap() as usize;
        assert_eq!(e.render_state.gpu_tex_indices()[slot], COOKIE, "id {id}: the tex-indices column");
        let row = staged(&e, id).expect("the light is staged in the frame that set it up");
        assert_eq!(row[31], format, "id {id}: a 2D root travels as format 0, a 3D one as format 1");
        assert_eq!(f32::from_bits(row[19]), want, "id {id}: the staged radius");
        assert_eq!(row[21] & 0xFF, 6, "id {id}: Light2D");
        assert_eq!((row[21] >> 11) & 0b111, 4, "id {id}: the sprite type in renderMeta");
        assert_eq!(row[22], COOKIE, "id {id}: the staged texture index");
    }
}

#[test]
fn d9_a_texture_set_frames_before_the_light_and_a_cookie_cleared_or_changed_alone_reach_the_gpu() {
    // SetTextureLayer and SetLightFlags mark only `meta` dirty: each change
    // must still be staged and reach the tex-indices column.
    const COOKIE: u32 = (1 << 31) | 3;
    const COOKIE2: u32 = (1 << 31) | 4;
    let mut e = Engine::new();
    e.process_commands(&[spawn(0, true), spawn(1, false)]);
    e.process_commands(&[texture(0, COOKIE), texture(1, COOKIE)]);
    e.update(1.0 / 60.0);
    let slot = |e: &Engine, id: u32| e.render_state.get_slot(e.entity_map.get(id).unwrap()).unwrap() as usize;
    let want = 12.0f32 * std::f32::consts::SQRT_2;

    let mut cmds = Vec::new();
    for id in [0, 1] {
        cmds.push(primitive(id, 6));
        cmds.push(light_type(id, 4)); // LightType::Sprite, no texture command
        cmds.push(floats(CommandType::SetPrimParams0, id, &[1.0, 0.8, 0.6, 12.0]));
    }
    e.process_commands(&cmds);
    e.update(1.0 / 60.0);
    for id in [0u32, 1] {
        let row = staged(&e, id).expect("the light commands stage the row");
        assert_eq!(row[22], COOKIE, "id {id}: the texture set a frame earlier");
        assert_eq!((row[21] >> 11) & 0b111, 4, "id {id}: the sprite type");
        assert_eq!(f32::from_bits(row[19]), want, "id {id}: the radius");
        assert_eq!(e.render_state.gpu_tex_indices()[slot(&e, id)], COOKIE, "id {id}: the tex-indices column");
    }

    // Cleared alone: layer 0, the light draws nothing again.
    e.process_commands(&[texture(0, 0), texture(1, 0)]);
    e.update(1.0 / 60.0);
    for id in [0u32, 1] {
        let row = staged(&e, id).expect("SetTextureLayer alone stages the row");
        assert_eq!(row[22], 0, "id {id}: the cleared index");
        assert_eq!(f32::from_bits(row[19]), want, "id {id}: the radius unchanged");
        assert_eq!(e.render_state.gpu_tex_indices()[slot(&e, id)], 0, "id {id}: the tex-indices column");
    }

    // Changed alone.
    e.process_commands(&[texture(0, COOKIE2), texture(1, COOKIE2)]);
    e.update(1.0 / 60.0);
    for id in [0u32, 1] {
        assert_eq!(staged(&e, id).expect("staged again")[22], COOKIE2, "id {id}: the new cookie");
        assert_eq!(e.render_state.gpu_tex_indices()[slot(&e, id)], COOKIE2, "id {id}: the tex-indices column");
    }
}
```
  d8 manda la texture nel frame dello spawn, prima del primo `update()` (dove `assign_slot` sporca comunque tutta la riga: senza il `mark_meta_dirty` di `SetTextureLayer` d8 passa); d9 copre la texture un frame prima della luce e un cookie tolto o cambiato da solo, che solo il `mark_meta_dirty` di `SetTextureLayer` (`command_processor.rs:778-780`) porta alla riga e alla colonna `tex-indices`.
- [ ] **Step 2: RED.** `cargo test -p hyperion-core --lib sprite`: 5 FAILED su 7 (`sprite_light_radius_is_its_range_times_sqrt_2`, `…_reaches_its_farthest_corner_at_any_rotation`, `…_ignores_a_scaled_rotated_parent`, `…_saturates_at_f32_max`, `engine::tests::switching_a_light_to_sprite_reaches_the_gpu_bounds`; le due guardie passano già). `cargo test -p hyperion-core --test verify_2d -- d8 d9`: 2 FAILED sul raggio, `left: 12.0, right: 16.970562`.
- [ ] **Step 3: il codice.** In `systems.rs` la coda della seconda query (`:277-285`) diventa (il guard resta primo: un range non finito arriva da `snapshot_restore`, `engine.rs:779`):
```rust
        // A light's transform scale does NOT affect its culling radius: a
        // light's extent is its range. Negative and non-finite ranges collapse
        // to 0 rather than reaching the sphere-frustum test.
        //
        // A sprite light's square turns with it (round step 8): its corners
        // lie range * sqrt(2) from its centre, saturated at f32::MAX (the
        // product overflows past about 2.4e38), like a global light's radius.
        let range = params.0[3];
        radius.0 = if !(range.is_finite() && range > 0.0) {
            0.0
        } else if kind == LightType::Sprite as u8 {
            (range * std::f32::consts::SQRT_2).min(f32::MAX)
        } else {
            range
        };
```
- [ ] **Step 4: GREEN e matrice.** `--lib sprite` 7/7, `--test verify_2d` 9/9; lib 223, 301 (`physics-2d`), 254 (`dev-tools`), 347 (`--all-features`); totali 268, 392, 304, 447; clippy (`--all-features --all-targets -- -D warnings`) e `cargo check -p hyperion-core --target wasm32-unknown-unknown` puliti.
- [ ] **Step 4b: la prova che i test mordono** (una mutazione alla volta, poi il verde): senza `.min(f32::MAX)` → `sprite_light_radius_saturates_at_f32_max`; `else if kind != 255 {` al posto del ramo della sprite → `switching_a_light_to_sprite…`, `switching_a_light_to_global…`, `light_radius_follows_prim_params_slot_3`, `light_radius_ignores_transform_scale`, `point_and_spot_lights_keep_their_range` e `d3_a_light_on_transform2d_culls_against_its_range_in_format_0`; senza il `mark_meta_dirty` di `SetTextureLayer` (`command_processor.rs:778-780`, codice di HEAD) → solo d9.
- [ ] **Step 5: i commenti.** In `systems.rs`, `:228-229` ("A light's culling radius is its range, and range has exactly one source / of truth: `primParams[3]`, the same slot the accumulation shader reads."):
```rust
    // A light's culling radius comes from its range (the range itself; for a
    // sprite light, whose square turns with it, range * sqrt(2)), and range
    // has exactly one source of truth: `primParams[3]`, the same slot the
    // accumulation shader reads.
```
  e `:237-239` (il riferimento stantio "command_processor.rs:632 and :649"):
```rust
    // (`process_commands`: its single and its batch spawn, both archetypes),
    // so the pass above matches lights too and would otherwise leave them with
    // a radius derived from the light quad's scale.
```
  In `components.rs`, il doc di `TextureLayerIndex` (`:54-57`):
```rust
/// Packed texture layer index for per-entity texture lookup.
/// Encoding: `(overflow << 31) | (tier << 16) | layer`: the tier (bits 16-18)
/// selects which Texture2DArray, the layer (bits 0-15) the slice within it,
/// and the overflow bit the rgba8 overflow arrays (a PNG or JPEG on a device
/// with a compressed format; `packTextureIndex` in texture-manager.ts).
/// Default 0 = tier 0, layer 0: white on a primitive (the prelude's
/// `sampleTierOrWhite`), and no light at all on a sprite light, whose cookie
/// it is (round step 8).
```
  le prime cinque righe del paragrafo "Slot 3" di `PrimitiveParams` (`:102-106`, fino a "`f32::MAX`."; la frase "Slot 4 doubles as `height` for point lights once normal maps land.", che a HEAD comincia in coda a `:106` e finisce a `:107`, resta dopo il blocco qui sotto, riavvolta su due righe `///` sue, non in coda alla sua ultima riga):
```rust
/// Slot 3 (`range`) lives here and nowhere else. On a point or spot light it
/// is the light's extent; on a sprite light, the half-side of its square,
/// which turns with the light (round step 8); on a directional light, the
/// length of its shadows. It drives `BoundingRadius` through
/// `systems::update_bounding_radii` (a sprite light's is range * sqrt(2), the
/// square's half-diagonal, saturated at `f32::MAX`), except on global and
/// directional lights, which light the whole screen and get `f32::MAX`.
```
  e prima di `Sprite = 4,` (`:358`), senza "parola = numero" (`light-accum-stage.test.ts` legge l'enum con `(\w+)\s*=\s*(\d+)`):
```rust
    /// A cookie light (round step 8): a square of half-side `range`, turned
    /// with the light, in the shape and colours of its texture
    /// (`TextureLayerIndex`); without one it lights nothing.
```
  Poi clippy e `cargo test -p hyperion-core --lib` (223) di nuovo.
- [ ] **Step 6: commit**
```bash
git add crates/hyperion-core/src/systems.rs crates/hyperion-core/src/components.rs crates/hyperion-core/src/engine.rs crates/hyperion-core/tests/verify_2d.rs
git commit -m "feat(8): il raggio di culling di una luce sprite è range·√2, saturato a f32::MAX" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: i tier delle texture in `LightAccumStage`

Lo stadio prende il gruppo 1 del preludio attraverso un `TextureTierBinding`, e il binding 6 (`tex-indices`). Lo shader non li usa ancora, e un layout può avere binding inutilizzati: il commit resta valido sulla GPU.

**Files:** `ts/src/render/passes/light-accum-stage.ts` (+ test), `ts/src/render/passes/light-groups-pass.ts` (+ test); le ancore negli step.

**Interfaces:** produce `LightAccumStage.encode(encoder: GPUCommandEncoder, g: number, target: GPUTextureView, sdf: GPUTextureView, frame: FrameState, resources: ResourcePool): void`, il binding 6 del gruppo 0 = `tex-indices` (VERTEX, `{ type: 'read-only-storage', minBindingSize: 4 }`) e il layout della pipeline [gruppo 0, `textureTierLayoutEntries()`]; consuma `TextureTierBinding` e `textureTierLayoutEntries` (`primitive-bindings.ts:37-74`), `ResourcePool` (`getBuffer`, `getTextureView`, `getSampler`).

- [ ] **Step 1: i test che falliscono.** In `light-accum-stage.test.ts`, dopo l'import di `BLEND_MIX` (`:6`):
```ts
import { textureTierLayoutEntries } from '../primitive-bindings';
```
  `POOL_BUFFERS` e la firma di `setUp` (`:19-21`):
```ts
const POOL_BUFFERS = ['entity-transforms', 'visible-indices', 'indirect-args', 'render-meta', 'prim-params', 'tex-indices'];
/** The texture tier views createRenderer registers in the pool (the sampler too), group 1 of the light pipeline since round step 8. */
const TIER_VIEWS = ['tier0', 'tier1', 'tier2', 'tier3', 'ovf0', 'ovf1', 'ovf2', 'ovf3'];

function setUp(poolBuffers = POOL_BUFFERS, { tiers = true }: { tiers?: boolean } = {}) {
```
  Dopo `const layouts: GPUBindGroupLayoutDescriptor[] = [];` (`:30`): `const pipelineLayouts: GPUPipelineLayoutDescriptor[] = [];`. Le righe del device `:38-39`:
```ts
    createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => { layouts.push(d); return { d }; },
    createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => { pipelineLayouts.push(d); return { d }; },
```
  Dopo il ciclo dei buffer del pool (`:56-60`), prima di `const stage = new LightAccumStage();`:
```ts
  if (tiers) {
    for (const name of TIER_VIEWS) pool.setTextureView(name, view(name));
    pool.setSampler('texSampler', { name: 'texSampler' } as unknown as GPUSampler);
  }
```
  `encode` e il `return` di `setUp` (`:69-86`):
```ts
  const encode = (g: number, target: GPUTextureView, sdf: GPUTextureView, f = frame()) => {
    const passes: Array<{
      desc: GPURenderPassDescriptor; draws: number[]; indexed: number[][]; groups: unknown[];
      /** Every setBindGroup with its index, and the calls in order: `group <i>`, `draw`. */
      sets: Array<[number, unknown]>; ops: string[];
    }> = [];
    const encoder = {
      beginRenderPass: (desc: GPURenderPassDescriptor) => {
        const rec = { desc, draws: [] as number[], indexed: [] as number[][], groups: [] as unknown[], sets: [] as Array<[number, unknown]>, ops: [] as string[] };
        passes.push(rec);
        return {
          setPipeline() {}, setVertexBuffer() {}, setIndexBuffer() {}, end() {},
          setBindGroup: (i: number, bg: unknown) => { rec.groups.push(bg); rec.sets.push([i, bg]); rec.ops.push(`group ${i}`); },
          drawIndexedIndirect: (_b: GPUBuffer, offset: number) => { rec.draws.push(offset); },
          drawIndexed: (...args: number[]) => { rec.indexed.push(args); rec.ops.push('draw'); },
        };
      },
    } as unknown as GPUCommandEncoder;
    stage.encode(encoder, g, target, sdf, f, pool);
    return passes[0];
  };
  return { stage, device, pipelines, buffers, bindGroups, writes, layouts, pipelineLayouts, pool, poolBuffer, frame, uniform, list, encode };
}
```
  Dopo `lights` (`:97`):
```ts
/** The bind group a recorded pass set last at group `index`. */
const groupAt = (pass: { sets: Array<[number, unknown]> }, index: number): unknown => pass.sets.filter(([i]) => i === index).at(-1)?.[1];
/** The descriptor a mock object was made from: the fake device's create* calls return `{ d }`. */
const descOf = <T>(made: unknown): T => (made as { d: T }).d;
```
  Tre test esistenti cambiano: 'binds slice g' (`:144-150`) non legge più l'ultimo bind group creato, che dipende dall'ordine di creazione (il testo di oggi passerebbe ancora, perché il gruppo dei tier nasce in `setup()`; un gruppo dei tier ricostruito in `encode()` dopo il gruppo 0, dopo una crescita o senza il `current()` di `setup()`, gli farebbe leggere il gruppo sbagliato):
```ts
  it('binds slice g: offset g * 256, the 80 bytes of LightUniform', () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3, NO_LIGHTS);
    expect(bindingOf(groupAt(encode(2, view('layer2'), view('sdf')), 0), 0)).toMatchObject({ offset: 2 * 256, size: 80 });
  });
```
  in 'needs neither visible-indices nor indirect-args from the pool' (`:290`) la lista diventa `['entity-transforms', 'render-meta', 'prim-params', 'tex-indices']`; 'every binding an entry point reaches is visible to its stage' (`:416-430`) diventa per gruppo e binding (oggi i binding 0-8 del gruppo 1 si confronterebbero col gruppo 0):
```ts
  it('every binding an entry point reaches is in its group of the pipeline layout, visible to its stage: the SDF to vs_main too', () => {
    // A binding the vertex stage uses but the layout hides fails
    // createRenderPipeline; GPU validation then rejects the lit graph and
    // lighting silently stays off. No mock device sees it. Keyed by group AND
    // binding: group 1's bindings 0-8 are not group 0's (round step 8).
    LightAccumStage.SHADER_SOURCE = lightShaderSource;
    const { pipelineLayouts } = setUp();
    const groups = [...pipelineLayouts[0].bindGroupLayouts].map((l) => descOf<GPUBindGroupLayoutDescriptor>(l));
    const visibility = (group: number, binding: number): number =>
      [...(groups[group]?.entries ?? [])].find((e) => e.binding === binding)?.visibility ?? 0;
    for (const [entry, stage] of [['vs_main', GPUShaderStage.VERTEX], ['fs_main', GPUShaderStage.FRAGMENT]] as const) {
      const reached = reachableFrom(lightShaderSource, entry);
      for (const b of bindingDecls(lightShaderSource).filter((d) => reached.has(d.name))) {
        expect(visibility(b.group, b.binding) & stage, `${entry} reaches ${b.name} (group ${b.group}, binding ${b.binding})`).not.toBe(0);
      }
    }
    expect(reachableFrom(lightShaderSource, 'vs_main').has('sdf')).toBe(true);  // not vacuous
  });
```
  Prima di `describe('light-accum.wgsl: the group filter'` (`:319`), il `describe` nuovo:
```ts
// Round step 8: the prelude's group 1 (a TextureTierBinding resolved from the
// pool in every encode(): a grown tier destroys its old texture) and binding 6,
// the pool's tex-indices.
describe('LightAccumStage: the texture tiers, group 1 (round step 8)', () => {
  beforeAll(() => { LightAccumStage.SHADER_SOURCE = lightShaderSource; });

  it("builds its one pipeline on two groups: its own group 0 (bindings 0-6) and the prelude's texture-tier layout as group 1", () => {
    const { pipelines, pipelineLayouts, layouts } = setUp();
    expect(pipelines).toHaveLength(1);
    expect(pipelineLayouts).toHaveLength(1);
    expect(descOf<GPUPipelineLayoutDescriptor>(pipelines[0].layout)).toBe(pipelineLayouts[0]);
    const groups = [...pipelineLayouts[0].bindGroupLayouts].map((l) => descOf<GPUBindGroupLayoutDescriptor>(l));
    // Group 0 is created first: the tests above read layouts[0] as group 0.
    expect(groups).toEqual([layouts[0], layouts[1]]);
    expect([...groups[0].entries].map((e) => e.binding)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...groups[1].entries]).toEqual(textureTierLayoutEntries());
  });

  it("culls no face: a sprite light under a mirroring transform is wound clockwise, and both windings must draw", () => {
    const { pipelines } = setUp();
    expect(pipelines[0].primitive).toEqual({ topology: 'triangle-list', cullMode: 'none' });
  });

  it("binding 6 is the pool's tex-indices: vertex-only read-only storage, minBindingSize 4, in every group's bind group; setup() throws without it", () => {
    const { stage, device, frame, layouts, pool, encode } = setUp();
    const entry = [...layouts[0].entries].find((e) => e.binding === 6);
    expect(entry, 'binding 6').toBeDefined();
    expect(entry!.visibility).toBe(GPUShaderStage.VERTEX);
    expect(entry!.buffer).toEqual({ type: 'read-only-storage', minBindingSize: 4 });
    stage.prepare(device, frame(), groups3, lights(1));
    for (let g = 0; g < groups3.length; g++) {
      const bound = bindingOf(groupAt(encode(g, view(`layer${g}`), view('sdf')), 0), 6) as GPUBufferBinding;
      expect(bound.buffer, `group ${g}`).toBe(pool.getBuffer('tex-indices'));
    }
    expect(() => setUp(POOL_BUFFERS.filter((n) => n !== 'tex-indices'))).toThrow(/'tex-indices'/);
  });

  it("sets group 1 in every group's pass, before its draw: the pool's eight tier views and the sampler, in binding order", () => {
    const { stage, device, frame, encode } = setUp();
    stage.prepare(device, frame(), groups3, lights(5, 9));
    const want = ['tier0', 'tier1', 'tier2', 'tier3', 'texSampler', 'ovf0', 'ovf1', 'ovf2', 'ovf3'].map((name, binding) => [binding, name]);
    for (let g = 0; g < groups3.length; g++) {
      const pass = encode(g, view(`layer${g}`), view('sdf'));
      const tiers = groupAt(pass, 1);
      expect(tiers, `group ${g}`).toBeDefined();
      expect([...descOf<GPUBindGroupDescriptor>(tiers).entries].map((e) => [e.binding, (e.resource as unknown as { name: string }).name])).toEqual(want);
      expect(pass.ops).toEqual(['group 0', 'group 1', 'draw']);
      expect(pass.indexed.map(direct)).toEqual([[6, 2, 0, 0, 0]]);
    }
  });

  it('builds group 1 in setup() already: the graph host and the HMR probes validate it there', () => {
    const { bindGroups, pipelineLayouts } = setUp();
    expect(bindGroups).toHaveLength(1);
    expect([...bindGroups[0].entries].map((e) => e.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // On the pipeline's group-1 layout, never group 0's.
    expect(bindGroups[0].layout).toBe([...pipelineLayouts[0].bindGroupLayouts][1]);
  });

  it("rebuilds group 1 when a tier's view changes (a tier that grows destroys its old texture), keeps it while nothing changes, and group 0 does not follow the tiers", () => {
    const { stage, device, frame, pool, encode, bindGroups } = setUp();
    stage.prepare(device, frame(), groups3, lights(1));
    const sdf = view('sdf');
    const before = encode(0, view('t'), sdf);
    const made = bindGroups.length;
    expect(groupAt(encode(0, view('t'), sdf), 1)).toBe(groupAt(before, 1));
    expect(bindGroups.length, 'nothing changed: no bind group made').toBe(made);
    // What TextureManager.onViewsChanged -> registerTextureViews (renderer.ts) does on a growth.
    const grown = view('ovf0 after growth');
    pool.setTextureView('ovf0', grown);
    const after = encode(0, view('t'), sdf);
    expect(groupAt(after, 1)).not.toBe(groupAt(before, 1));
    expect(bindingOf(groupAt(after, 1), 5)).toBe(grown);  // ovf0 is group-1 binding 5
    expect(groupAt(after, 0)).toBe(groupAt(before, 0));
    expect(after.indexed.map(direct)).toEqual([[6, 1, 0, 0, 0]]);
  });

  it('without the tier views in the pool it still clears the layer to the ambient, and draws nothing: the one pipeline has group 1', () => {
    const { stage, device, frame, encode } = setUp(POOL_BUFFERS, { tiers: false });
    stage.prepare(device, frame(), groups3, lights(5, 9));
    const pass = encode(0, view('layer0'), view('sdf'), frame({ ambient: [0.2, 0.4, 0.6, 0.5] }));
    expect([...pass.desc.colorAttachments][0]!.clearValue).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    expect(pass.indexed).toEqual([]);
    expect(groupAt(pass, 1)).toBeUndefined();
  });

  it("an HMR probe on the same pool destroys no pool buffer, tex-indices included, and the live stage still binds the pool's tier views", () => {
    const { stage, device, frame, pool, poolBuffer, encode } = setUp();
    const probe = new LightAccumStage();
    probe.setup(device, pool);
    probe.destroy();
    for (const [name, b] of poolBuffer) expect(b.destroyed, name).toBe(false);
    stage.prepare(device, frame(), groups3, lights(1));
    const g1 = groupAt(encode(0, view('t'), view('sdf')), 1);
    expect(g1, 'group 1').toBeDefined();
    expect(bindingOf(g1, 0)).toBe(pool.getTextureView('tier0'));
  });

  it('at most 8 storage buffers per shader stage, counted on the layout entries (an unread one counts too): vertex 5, fragment 3', () => {
    const { layouts } = setUp();
    const entries = layouts.flatMap((l) => [...l.entries]);
    const storage = (stage: number) => entries.filter((e) => e.buffer?.type === 'read-only-storage' && (e.visibility & stage) !== 0).length;
    expect(storage(GPUShaderStage.VERTEX)).toBe(5);
    expect(storage(GPUShaderStage.FRAGMENT)).toBe(3);
    // Sampled textures, of 16 per stage: the SDF and the eight tiers.
    expect(entries.filter((e) => e.texture !== undefined && (e.visibility & GPUShaderStage.FRAGMENT) !== 0)).toHaveLength(9);
  });
});

```
  In `light-groups-pass.test.ts` il pass finto separa il gruppo 0 (l'SDF al binding 5) dal gruppo 1, il cui binding 5 è `ovf0` (oggi sovrascriverebbe `ev.sdf`, e 'accumulates each group against its set's final SDF' lancerebbe un `TypeError`): il tipo degli eventi (`:70`) prende `tiers?: GPUBindGroupEntry[];` dopo `sdf?: View;`; `ev` (`:73-76`) prende `tiers: undefined as GPUBindGroupEntry[] | undefined,` prima di `indexed`; `setBindGroup` (`:82-85`):
```ts
          // Group 0 holds the SDF at binding 5; group 1 (the texture tiers) has its own binding 5, ovf0.
          setBindGroup: (i: number, bg: { entries: GPUBindGroupEntry[] }) => {
            if (i === 1) ev.tiers = bg.entries;
            if (i !== 0) return;
            const sdf = bg.entries.find((e) => e.binding === 5);
            if (sdf) ev.sdf = sdf.resource as unknown as View;
          },
```
  nel predicato di `passes` (`:95`), `sdf?: View;` diventa `sdf?: View; tiers?: GPUBindGroupEntry[];`; il test nuovo va prima di 'no shadowed light: no seed and no flood at all' (`:195`):
```ts
  it("binds the pool's texture tiers as group 1 in every accumulation pass, and a tier view that changes reaches every group of the next frame", () => {
    // Round step 8: a sprite light's cookie. A tier that grows replaces its
    // view in the pool (renderer.ts registerTextureViews) and destroys the old
    // texture, so every group of the next frame must bind the new one.
    const { frame, label, passes, pool } = setUp();
    const lg = groups([[1, 0], [2, -1], [4, 0]], [5], [3]);
    const names = (tiers: GPUBindGroupEntry[] | undefined) => tiers?.map((e) => (e.resource as unknown as { name?: string }).name ?? 'sampler');
    const accum = (events: ReturnType<typeof frame>) => passes(events).filter((e) => label(e.target).startsWith('light-buffer'));
    const first = accum(frame(lg));
    expect(first).toHaveLength(3);
    for (const e of first) {
      expect(names(e.tiers), label(e.target)).toEqual(['tier0', 'tier1', 'tier2', 'tier3', 'sampler', 'ovf0', 'ovf1', 'ovf2', 'ovf3']);
    }
    pool.setTextureView('ovf0', { name: 'ovf0 grown' } as unknown as GPUTextureView);
    for (const e of accum(frame(lg))) expect(names(e.tiers)?.[5], label(e.target)).toBe('ovf0 grown');
    // Set-less groups alone (no shadowed light), right after a growth: no set's
    // accumulation rebuilds the stage's group 1 before them in this frame.
    pool.setTextureView('ovf0', { name: 'ovf0 grown again' } as unknown as GPUTextureView);
    for (const e of accum(frame(groups([[1, -1], [2, -1]], [], [3])))) expect(names(e.tiers)?.[5], label(e.target)).toBe('ovf0 grown again');
  });

```
- [ ] **Step 2: RED.** `npx --prefix ts vitest run --root ts src/render/passes/light-accum-stage.test.ts src/render/passes/light-groups-pass.test.ts`: 10 falliti su 62, i nove nuovi dello stadio e quello del pass, ciascuno su un'asserzione (le guardie `toBeDefined` danno "binding 6: expected undefined to be defined", "group 0: expected undefined to be defined" e "group 1: expected undefined to be defined", non un `TypeError`); gli altri 52 passano (lo stadio di oggi ignora il sesto argomento di `encode`).
- [ ] **Step 3: il codice.** In `light-accum-stage.ts`, dopo l'import di `SCENE_HDR_FORMAT` (`:4`):
```ts
import { TextureTierBinding, textureTierLayoutEntries } from '../primitive-bindings';
```
  In fondo al doc della classe (`:60-75`), prima di ` */`:
```ts
 *
 * Since round step 8 a second group, the prelude's group 1 (the texture
 * tiers, FRAGMENT), holds a sprite light's cookie, and binding 6 of group 0 is
 * the pool's `tex-indices` (vs_main). Group 1 is a `TextureTierBinding`
 * resolved from the pool in every `encode()`: a tier that grows destroys its
 * old texture. The stage registers nothing in the pool (an HMR probe's setup()
 * then destroy() leaves it whole). No face is culled: a mirrored sprite light
 * is wound clockwise (spriteAxes).
```
  I campi `:93-94`:
```ts
  /** The pool's columns, by binding: transforms (1), primParams (3), renderMeta (4), texIndices (6). */
  private columns: Array<[number, GPUBuffer]> = [];
  /** Group 1, the texture tiers (round step 8): follows the pool's views. */
  private tierBinding: TextureTierBinding | null = null;
```
  In `setup`, `:110`:
```ts
    const columns: Array<[number, string]> = [[1, 'entity-transforms'], [3, 'prim-params'], [4, 'render-meta'], [6, 'tex-indices']];
```
  Dopo la voce del binding 5 (`:134`), dentro `entries`:
```ts
        // The packed texture index of every slot, read by vs_main only (a
        // sprite light's cookie, round step 8). 4 bytes: one u32.
        { binding: 6, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage', minBindingSize: 4 } },
```
  Fra la chiusura di `createBindGroupLayout` (`:136`) e `const module = …` (`:138`):
```ts
    // Group 1: the prelude's texture-tier layout, created after group 0.
    const tierLayout = device.createBindGroupLayout({ entries: textureTierLayoutEntries() });
```
  `:140` diventa `layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout, tierLayout] }),` e `:147` (`primitive: { topology: 'triangle-list' },`):
```ts
      // Both windings draw: spriteAxes winds a sprite light under a mirroring
      // transform (scale(1, -1) included) clockwise. Never cullMode 'back'
      // here, as the entity pipelines have it: those lights would vanish.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
```
  Dopo la chiusura di `createRenderPipeline` (`:148`), prima della `}` di `setup`:
```ts
    this.tierBinding = new TextureTierBinding(tierLayout);
    // Built now too, as ForwardPass does: the graph host and the HMR probes
    // run setup() inside their GPU error scopes, so a layout that does not
    // fit the pool's views rejects the graph instead of a later frame.
    this.tierBinding.current(device, resources);
```
  Il doc e la testa di `encode` (`:195-199`):
```ts
  /**
   * Clear `target` to the ambient light, then draw the frame's light list into
   * group `g`, shadowed by `sdf`, with the texture tiers `resources` holds now
   * (a sprite light's cookie).
   */
  encode(encoder: GPUCommandEncoder, g: number, target: GPUTextureView, sdf: GPUTextureView, frame: FrameState, resources: ResourcePool): void {
    if (!this.device || !this.pipeline || !this.vertexBuffer || !this.indexBuffer) return;
    const bindGroup = this.bindGroupFor(g, sdf);
    if (!bindGroup) return;
    // Rebuilt when a tier's view changed. null only while the pool has never
    // held every tier view (tests): the layer is then cleared and nothing
    // drawn, since the one pipeline's layout has group 1 for every light.
    const tiers = this.tierBinding?.current(this.device, resources) ?? null;
```
  e la fine (`:212-216`):
```ts
    pass.setBindGroup(0, bindGroup);
    if (tiers) pass.setBindGroup(1, tiers);
    // Instance i is the list's i-th light, firstInstance 0 (no
    // indirect-first-instance). WebGPU blends in primitive order: the list's
    // order is the blend order.
    if (tiers && this.lightCount > 0) pass.drawIndexed(6, this.lightCount, 0, 0, 0);
```
  In `destroy`, dopo `this.columns = [];` (`:252`): `this.tierBinding = null;`. Il gruppo 0 resta impostato anche senza luci (i test esistenti lo leggono; senza draw WebGPU non valida i gruppi). In `light-groups-pass.ts`, `:117` e `:123` passano `resources` come ultimo argomento:
```ts
        if (group.sdfSet === s) this.accum.encode(encoder, g, this.layerViews[g], sdf, frame, resources);
```
```ts
        if (group.sdfSet < 0) this.accum.encode(encoder, g, this.layerViews[g], this.noOccluderView!, frame, resources);
```
- [ ] **Step 4: GREEN e tipi.** Il comando dello Step 2: 62/62 (lo stadio 50, il pass 12); `tsc` pulito; `npm --prefix ts test`: 115 file, 2135 + 7 saltati.
- [ ] **Step 4b: la prova che i test mordono** (una mutazione alla volta, poi i due file; ciascuna fa fallire almeno un test): il gruppo 1 in cache una volta per sempre (`const tiers = (this as unknown as { cached?: GPUBindGroup | null }).cached ??= this.tierBinding?.current(this.device, resources) ?? null;`); senza `if (tiers) pass.setBindGroup(1, tiers);`; binding 6 `vsFs`; il layout col solo gruppo 0; `cullMode: 'back'` (o `{ topology: 'triangle-list' }`); senza il `current()` in `setup()`; il `TextureTierBinding` sul layout del gruppo 0 (`new TextureTierBinding(this.bindGroupLayout)`); la draw anche senza `tiers`; senza `[6, 'tex-indices']` fra le colonne; `LightGroupsPass` che passa un altro pool, a ciascuna delle due chiamate (`:117`, `:123`) da sola (quella dei gruppi senza set la uccide solo il terzo frame del test del pass: `TextureTierBinding.current()` tiene il suo ultimo gruppo quando al pool manca una vista, e nel secondo frame il ciclo dei set lo ricostruisce prima). Poi il codice di nuovo, e il verde. Niente GPU qui: lo shader non usa ancora gruppo 1 e binding 6, e lo valida il cancello del Task 3.
- [ ] **Step 5: commit**
```bash
git add ts/src/render/passes/light-accum-stage.ts ts/src/render/passes/light-accum-stage.test.ts ts/src/render/passes/light-groups-pass.ts ts/src/render/passes/light-groups-pass.test.ts
git commit -m "feat(8): LightAccumStage lega i tier delle texture come gruppo 1 e la colonna tex-indices, ricostruiti a ogni encode" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: lo shader della luce sprite e i due gate, nello stesso commit

Prima, in un commit suo (Step 0, sotto-decisione 2), ogni immagine dei tier si raddrizza: `sampleTierOrWhite` gira v dopo la risposta bianca dell'indice 0, e il probe di 'Depth orders transparent sprites' passa sul texel che leggeva prima (`ORDER_Y - 0.15`). Poi la sprite diventa un quadrato che ruota (`spriteAxes`), all'uv del quad texturizzato, con l'immagine diritta come ogni immagine dei tier (le due righe del giro, copiate dal preludio); `vs_main` decodifica l'indice del cookie e scarta un layer 0 (l'indice 0 compreso) o un `range` ≤ 0; `fs_main` scarta un layer oltre il suo array (`cookieLayers`) e campiona con una copia di `sampleTier` a LOD 0. I due gate prendono SPRITE nello stesso commit, e una sprite che non può disegnare non apre un set SDF; il predicato della sprite senza texture, `untexturedPredicate`, è esportato (il Task 4 lo usa per il flag e per gli id dell'avviso, e gli aggiunge i layer in uso). Lo Step 7b, in un commit suo, estende la regola a ogni tipo: una luce ombreggiata con `range` ≤ 0 non apre un set SDF. Il task chiude anche le guardie di testo e i commenti della marcia che il §4 del piano del giro rinviava al passo 9 (`:143-:149`): lo shader cambia comunque qui. Il commit dello Step 7 comprende lo script del cancello GPU, che il controller esegue dopo (Step 8).

**Files:** Step 0: `ts/src/shaders/primitives/prelude.wgsl`, `ts/src/shaders/primitives/line.wgsl` (un commento), `ts/src/demo/twin-2d.ts` (+ test), `forward-pass.test.ts`. Step 1-7b: `ts/src/shaders/light-accum.wgsl`; `ts/src/render/light-groups.ts`; i test `light-accum-stage.test.ts`, `forward-pass.test.ts` e `light-groups.test.ts`; crea `docs/plans/assets/2026-10-14-step8/tools/gate-step8.js`. Le ancore sono negli step; nei file già toccati dal Task 2 si ritrovano col testo.

**Interfaces:** produce, nel preludio (Step 0), `sampleTierOrWhite(in: VertexOutput) -> vec4f` che gira v dopo la risposta bianca (`var image = in; image.uv = vec2f(in.uv.x, 1.0 - in.uv.y); return sampleTier(image);`) e, in `demo/twin-2d.ts`, `export const ORDER_PROBE_OFFSET: readonly [number, number] = [0.2, -0.15]`; in WGSL, `@group(0) @binding(6) var<storage, read> texLayerIndices: array<u32>`, il gruppo 1 del preludio, `VertexOutput` con `@location(4) uv: vec2f` e, flat, `@location(5) texTier`, `@location(6) texLayer`, `@location(7) isOverflow`, `fn spriteAxes(m: mat4x4f) -> mat2x2f`, `fn sampleTier(in: VertexOutput) -> vec4f` (la copia) e `fn cookieLayers(in: VertexOutput) -> u32`; in TS `export const TEXTURE_LAYER_MASK = 0xffff`, `export function untexturedPredicate(input: Pick<LightGroupsInput, 'entityCount' | 'texIndices'>): (slot: number) => boolean`, `LightGroupsInput.texIndices?: Uint32Array` e `SHADOWED_LIGHT_TYPES` = [POINT, SPOT, DIRECTIONAL, SPRITE]. Consuma il layout a due gruppi del Task 2, `packTextureIndex` (`texture-manager.ts:36`), `loadPrimitivePieces`, gli aiutanti di `shaders/wgsl-analysis.ts` e `FrameState.texIndices`/`GPURenderState.texIndices`, che arrivano già a `deriveLightGroups` (`renderer.ts:1059`, `lighting-api.ts:143`).

- [ ] **Step 0: le immagini dei tier diritte, un commit suo** (sotto-decisione 2 (e)). Oggi la riga 0 della texture, la prima dell'immagine, cade sul lato −y locale di un quad, di una linea e di una bezier (Fatti verificati), e nessuna trasformazione la rimette a posto. Il giro va una volta sola, alla lettura dell'immagine, in `sampleTierOrWhite`, l'helper di tutti e tre (`quad.wgsl:12`, `line.wgsl:119`, `bezier.wgsl:139`), dopo la risposta bianca dell'indice 0: nessun uv di vertice cambia (la geometria di linee, bezier, gradient e box shadow resta com'è), i pixel senza texture restano identici al bit, e msdf, che chiama `sampleTier` grezzo col rettangolo del suo atlante, non cambia. Col giro, sotto il probe di 'Depth orders transparent sprites' (sul quad texturizzato) passa l'altra metà dell'immagine: il probe va da `ORDER_Y + 0.15` a `ORDER_Y - 0.15`, dove l'immagine diritta mostra il texel che leggeva prima (il quadrante giallo in basso a destra del PNG). A +0,15 il quadrante verde sopra il teal ne differirebbe di 0,0923, sotto lo 0,1 che rende la coppia distinguibile; a −0,15 di 0,4337, come oggi (modello del giudice, `sd2-judge/models.mjs`).

  RED. In `forward-pass.test.ts`, nel test 'sampleTierOrWhite returns white for packed index 0 before it samples a tier' (`:377-384`), `:382` diventa:
```ts
    expect(fn.indexOf('sampleTier(image)')).toBeGreaterThan(untextured);
```
  e prima di `it('sampleTier is the one function that samples the tiers: all eight, with textureSampleLevel'` (`:386`):
```ts
  // Round step 8 (sub-decision 2 (e)): a tier image is drawn upright in its
  // primitive's local frame, its first row along local +y. The local uv grows
  // toward +y (quad_vs: position + 0.5) and texture memory keeps the image's
  // row order (no flipY at upload), so sampleTierOrWhite turns v over once,
  // after the white answer. No library changes its vertex uv, and msdf, whose
  // atlas rect is in texture coordinates, keeps the raw sampleTier.
  it('a tier image is drawn upright: sampleTierOrWhite turns v over after the white answer, and no vertex uv changes', () => {
    const fn = body(prelude, 'sampleTierOrWhite');
    const white = fn.search(/in\.isOverflow == 0u && in\.texTier == 0u && in\.texLayer == 0u\s*\)\s*\{\s*return vec4f\(1\.0\);\s*\}/);
    const flip = fn.search(/var image = in;\s*image\.uv = vec2f\(in\.uv\.x, 1\.0 - in\.uv\.y\);\s*return sampleTier\(image\);/);
    expect(white, 'the white answer').toBeGreaterThan(-1);
    expect(flip, 'the flip, then the raw sample').toBeGreaterThan(white);
    expect(body(prelude, 'sampleTier'), 'sampleTier stays in texture coordinates').not.toMatch(/1\.0 - in\.uv/);
    for (const name of ['quad', 'bezier'] as PrimitiveLibraryName[]) {
      expect(body(moduleOf(name), fnOf(name, 'vs'))).toMatch(/unitQuadVertex\(position, entityIdx, position\.xy \+ 0\.5\)/);
    }
    expect(body(moduleOf('line'), fnOf('line', 'vs'))).toMatch(/finishVertex\(clipPosition, vec2f\(along, across \+ 0\.5\), entityIdx\)/);
    expect(body(moduleOf('msdf-text'), fnOf('msdf-text', 'vs'))).toMatch(/mix\(atlasV0, atlasV1, localUV\.y\)/);
    expect(body(moduleOf('msdf-text'), fnOf('msdf-text', 'shade'))).toMatch(/let msdf = sampleTier\(in\);/);
  });

```
  In `ts/src/demo/twin-2d.test.ts`, gli import di `:1-2` diventano:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { checkTransparentDepth, checkTransparentSort, ORDER_PROBE_OFFSET } from './twin-2d';
import { maxChannelDiff, over, straight, type Rgb } from './blend-expect';
```
  e in fondo al file:
```ts

// Round step 8 (sub-decision 2 (e)): tier images are upright, so the probe of
// 'Depth orders transparent sprites' moved to local y -0.15, where the
// upright image shows the texel it read before: the PNG's bottom-right
// (yellow) quadrant, over the teal of cell 1.
describe("2D Twins: the depth check's probe reads a telling texel of the upright image", () => {
  /** sort-test-128.png's RGBA at texel (x, y), y from the image's top row (filter 0 on every row: scripts/gen-sort-test-png.mjs). */
  function texel(x: number, y: number): number[] {
    const png = readFileSync(new URL('../../public/textures/sort-test-128.png', import.meta.url));
    const idat: Buffer[] = [];
    for (let at = 8; at < png.length;) {
      const length = png.readUInt32BE(at);
      if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
      at += 12 + length;
    }
    const rows = inflateSync(Buffer.concat(idat));
    const stride = 1 + 128 * 4;
    expect(rows[y * stride], `row ${y}: filter byte`).toBe(0);
    return [...rows.subarray(y * stride + 1 + x * 4, y * stride + 1 + x * 4 + 4)];
  }

  it('cell 1 (the textured quad, scale 2, over teal): the probe shows the yellow quadrant, more than 0.1 off the teal', () => {
    const [dx, dy] = ORDER_PROBE_OFFSET;
    // The quad's uv (position + 0.5, half-side 1), turned over at the lookup: texture v = 1 - uv.y.
    const [u, v] = [0.5 + dx / 2, 1 - (0.5 + dy / 2)];
    const [r, g, b, a] = texel(Math.floor(u * 128), Math.floor(v * 128));
    expect([r, g, b, a], 'the bottom-right quadrant').toEqual([240, 200, 50, 160]);
    const teal: Rgb = [0.25, 0.75, 0.5];  // TINT.teal
    const shown = over(teal, straight([r / 255, g / 255, b / 255], a / 255));
    expect(maxChannelDiff(shown, teal)).toBeGreaterThan(0.1);
  });
});
```
  GREEN. In `ts/src/shaders/primitives/prelude.wgsl`, il commento e il corpo di `sampleTierOrWhite` (`:171-183`):
```wgsl
// The entity's colour: white for packed index 0 (tier 0, layer 0, not
// overflow), which means "untextured": layer 0 is reserved and never holds a
// real texture. Answered here instead of sampling: on a compressed tier
// (BC7/ASTC) layer 0 is never filled (writeTexture cannot take raw pixels
// there), and an all-zero BC7 block decodes to transparent black. The varyings
// are flat, so the branch is uniform across the quad. msdf_shade must NOT use
// this: a glyph's coverage is its texel, and white would draw a solid box.
//
// Any other index is an image, drawn upright (round step 8): its first row
// along the primitive's local +y edge, its first column along local -x. The
// local uv grows toward +y (quad_vs: position + 0.5; line_vs: across + 0.5
// on the left of start->end), while texture memory keeps the image's row
// order (PNG and JPEG are copied without flipY, a KTX2 is written as stored,
// top row first), so v is turned over here, once. Never flipY at upload: a
// KTX2's blocks could not follow. msdf stays raw (its atlas rect is in
// texture coordinates). light-accum.wgsl copies these two lines before it
// samples a sprite light's cookie. Before round step 8 every image was drawn
// upside down.
fn sampleTierOrWhite(in: VertexOutput) -> vec4f {
    if (in.isOverflow == 0u && in.texTier == 0u && in.texLayer == 0u) {
        return vec4f(1.0);
    }
    var image = in;
    image.uv = vec2f(in.uv.x, 1.0 - in.uv.y);
    return sampleTier(image);
}
```
  il commento di `sampleTier` (`:147-150`):
```wgsl
// The texel at in.uv from the entity's tier (with overflow support), RAW: a
// packed index 0 samples tier 0 layer 0 like any other. in.uv is in texture
// coordinates, (0, 0) at the image's top-left (sampleTierOrWhite turns a
// primitive's local uv over first; msdf passes its atlas rect).
// textureSampleLevel with explicit LOD 0 avoids the uniform-control-flow
// requirement of textureSample (texTier/isOverflow vary per-instance).
```
  in `ts/src/shaders/primitives/line.wgsl`, `:28` (`//   y: across line (-0.5 = left, 0.5 = right)`, il contrario di `perp`, che è la direzione girata di un quarto in senso antiorario):
```wgsl
    //   y: across line (-0.5 = right of start->end, 0.5 = left)
```
  in `ts/src/demo/twin-2d.ts`, dopo `const ORDER_Y = -60;` (`:133`):
```ts
/**
 * Where the depth check reads each cell, from its centre: on the textured
 * quad (scale 2) the PNG's bottom-right, yellow quadrant. Images are upright
 * since round step 8 (sampleTierOrWhite turns v over), so the texel the probe
 * read at local y +0.15 before sits at -0.15 now; at +0.15 the green quadrant
 * over the teal would differ by 0.092, under the 0.1 that tells a pair's two
 * orders apart (twin-2d.test.ts decodes the PNG).
 */
export const ORDER_PROBE_OFFSET: readonly [number, number] = [0.2, -0.15];
```
  e `:199` diventa:
```ts
  const [p0x, p0y] = snap(cellX(0) + ORDER_PROBE_OFFSET[0], ORDER_Y + ORDER_PROBE_OFFSET[1]);
```
  (`:202`, il punto sul quad bianco della cella 3, resta a `ORDER_Y + 0.15`: senza texture.) In `forward-pass.test.ts`, il commento di `:404-405` (la correzione dell'ASTC della sotto-decisione 4, nel `describe` che questo task tocca) diventa:
```ts
  // A glyph with index 0 stays what the raw sample gives (on BC7 transparent
  // black, discarded; on ASTC the error colour, round plan §4 (4)), not a
  // solid white box.
```

  Comandi: `npx --prefix ts vitest run --root ts src/render/passes/forward-pass.test.ts src/demo/twin-2d.test.ts`: al RED 3 falliti su 65 (`forward-pass` 2 su 59: quello di `:382` e il nuovo; `twin-2d` 1 su 6: `ORDER_PROBE_OFFSET` non esiste ancora), al GREEN 65/65; `npm --prefix ts test`: 115 file, 2137 + 7 saltati; `tsc` pulito; naga sui moduli composti, `D="$(mktemp -d)"; DUMP_WGSL_DIR="$D" npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts && node scripts/validate-wgsl-naga.mjs "$D"`: `9/9 valid (naga)` (i sette moduli composti, `transparent-gather`, `transparent-sort`; il giudice li ha passati a naga 30.0.1 col giro, `sd2-judge/compose.mjs`). Mutanti (uno alla volta, poi il verde; ciascuno fa fallire almeno un test): il giro tolto (`return sampleTier(in);`); il giro su u (`image.uv = vec2f(1.0 - in.uv.x, in.uv.y);`); il giro spostato in `quad_vs` (tolto da `sampleTierOrWhite`, e `vec2f(position.x + 0.5, 0.5 - position.y)` in `quad_vs`: il quad resta diritto, linea e bezier si girano); un secondo giro in `quad_vs` (lo stesso uv, col giro del preludio tenuto: un doppio giro sul quad); il giro spostato in `sampleTier` (il suo uv `vec2f(in.uv.x, 1.0 - in.uv.y)`, che girerebbe anche msdf); `ORDER_PROBE_OFFSET` di nuovo a `[0.2, 0.15]`.
```bash
git add ts/src/shaders/primitives/prelude.wgsl ts/src/shaders/primitives/line.wgsl ts/src/render/passes/forward-pass.test.ts ts/src/demo/twin-2d.ts ts/src/demo/twin-2d.test.ts
git commit -m "fix(8): le immagini dei tier si disegnano diritte (sampleTierOrWhite gira v); il probe di 'Depth orders transparent sprites' resta sul texel giallo" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 1: i test che falliscono.**

  **`light-accum-stage.test.ts`:** dopo `import { textureTierLayoutEntries } from '../primitive-bindings';` (Task 2):
```ts
import { loadPrimitivePieces } from '../primitive-pieces.fixture';
```
  Il test 'the header no longer says mix is added like add' (`:539-543` a HEAD, l'ultimo del `describe` del passo 7) e la chiusura del suo `describe` diventano:
```ts
  it('the header no longer says mix is added like add, nor that sprite lights are discarded', () => {
    // At HEAD the phrase breaks across two comment lines: "(added" / "// like `add`)".
    const header = lightShaderSource.slice(0, lightShaderSource.indexOf('struct LightUniform'));
    expect(header).not.toMatch(/added\s+(?:\/\/\s*)?like\s+`?add/);
    expect(lightShaderSource).not.toMatch(/Not yet: the `sprite` light type/);
    expect(header).toMatch(/A sprite light \(round step 8\) takes its shape from its cookie/);
  });
});

// Round step 8: the sprite light. The prelude is the reference for group 1,
// the packed-index decode, sampleTier and the textured quad's uv.
const PRELUDE = stripComments(loadPrimitivePieces().prelude);
const DECL = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]+)>)?\s+(\w+)\s*:\s*([^;]+);/g;
/** `<binding> <name>: <address space>type` of every declaration of group `group`, whitespace dropped. */
const declsOf = (src: string, group: number): string[] => [...stripComments(src).matchAll(DECL)]
  .filter((m) => Number(m[1]) === group)
  .map((m) => `${m[2]} ${m[4]}: ${m[3] ? `<${m[3].replace(/\s+/g, '')}>` : ''}${m[5].replace(/\s+/g, '')}`);
/** The `{ … }` block that follows `head` in `text`, braces included; fails the test when `head` is missing. */
function blockAfter(text: string, head: string): string {
  const at = text.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  const open = text.indexOf('{', at + head.length - 1);
  for (let i = open, depth = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}
const TIERS = ['tier0Tex', 'tier1Tex', 'tier2Tex', 'tier3Tex', 'ovf0Tex', 'ovf1Tex', 'ovf2Tex', 'ovf3Tex'];

describe('light-accum.wgsl: the sprite light (round step 8)', () => {
  it('declares group 1 exactly as the prelude does: the same nine bindings, names and types', () => {
    expect(declsOf(PRELUDE, 1)).toHaveLength(9);
    expect(declsOf(lightShaderSource, 1)).toEqual(declsOf(PRELUDE, 1));
  });

  it("every entry of both layouts is a binding the shader declares in that group; binding 6 is texLayerIndices, a read-only array<u32>", () => {
    LightAccumStage.SHADER_SOURCE = lightShaderSource;
    const { pipelineLayouts } = setUp();
    const groups = [...pipelineLayouts[0].bindGroupLayouts].map((l) => descOf<GPUBindGroupLayoutDescriptor>(l));
    const decls = bindingDecls(lightShaderSource);
    groups.forEach((layout, group) => {
      for (const e of layout.entries) {
        expect(decls.some((d) => d.group === group && d.binding === e.binding), `group ${group} binding ${e.binding}`).toBe(true);
      }
    });
    expect(declsOf(lightShaderSource, 0)).toContain('6 texLayerIndices: <storage,read>array<u32>');
  });

  it("sampleTier is the prelude's, text for text: the same eight arms at LOD 0, the only function that samples a tier; cookieLayers only counts their layers", () => {
    const squash = (t: string): string => t.replace(/\s+/g, ' ').trim();
    const reference = functionBody(PRELUDE, 'sampleTier');
    expect(reference).not.toBeNull();
    expect(squash(body('sampleTier'))).toBe(squash(reference!));
    expect(functionParams(lightShaderSource, 'sampleTier')).toEqual(functionParams(PRELUDE, 'sampleTier'));
    for (const tier of TIERS) {
      expect(body('sampleTier')).toMatch(new RegExp(`textureSampleLevel\\(\\s*${tier}\\s*,\\s*texSampler\\s*,\\s*in\\.uv\\s*,\\s*in\\.texLayer\\s*,\\s*0\\.0\\s*\\)`));
    }
    const readers = [...callGraph(lightShaderSource)].filter(([, refs]) => TIERS.some((t) => refs.has(t))).map(([name]) => name);
    expect(readers).toEqual(['sampleTier', 'cookieLayers']);
    // cookieLayers: sampleTier's eight arms, one textureNumLayers each, nothing sampled.
    const layers = body('cookieLayers');
    for (const tier of TIERS) expect(layers).toMatch(new RegExp(`textureNumLayers\\(\\s*${tier}\\s*\\)`));
    expect(layers.match(/textureNumLayers\(/g)).toHaveLength(8);
    expect(layers).not.toMatch(/textureSample/);
    expect(functionParams(lightShaderSource, 'cookieLayers')).toEqual(functionParams(PRELUDE, 'sampleTier'));
    // Explicit LOD 0: non-uniform control flow, and only mip 0 is filled.
    const code = stripComments(lightShaderSource);
    expect(code.match(/textureSampleLevel\(/g)).toHaveLength(8);
    expect(code.match(/textureSampleLevel\([^;]*,\s*0\.0\s*\)/g)).toHaveLength(8);
  });

  it("vs_main decodes the packed index as the prelude's finishVertex does, and hands fs_main the cookie in the prelude's varyings", () => {
    const finish = functionBody(PRELUDE, 'finishVertex');
    expect(finish).not.toBeNull();
    const vs = body('vs_main');
    for (const line of [/let isOverflow = \(packed >> 31u\) & 1u;/, /let tier = \(packed >> 16u\) & 0x7u;/, /let layer = packed & 0xFFFFu;/]) {
      expect(finish).toMatch(line);
      expect(vs).toMatch(line);
    }
    expect(vs).toMatch(/let packed = texLayerIndices\[e\];/);
    // …and hands them on as finishVertex does: a field swapped or dropped samples another layer or another array.
    const sprite = blockAfter(vs, 'if (kind == SPRITE) {');
    for (const line of [/out\.texTier = tier;/, /out\.texLayer = layer;/, /out\.isOverflow = isOverflow;/]) {
      expect(finish).toMatch(line);
      expect(sprite).toMatch(line);
    }
    expect(reachableFrom(lightShaderSource, 'vs_main').has('texLayerIndices')).toBe(true);
    expect(reachableFrom(lightShaderSource, 'fs_main').has('texLayerIndices')).toBe(false);
    expect(lightShaderSource).toMatch(/@location\(4\)\s*uv:\s*vec2f,/);
    expect(lightShaderSource).toMatch(/@location\(5\)\s*@interpolate\(flat\)\s*texTier:\s*u32,/);
    expect(lightShaderSource).toMatch(/@location\(6\)\s*@interpolate\(flat\)\s*texLayer:\s*u32,/);
    expect(lightShaderSource).toMatch(/@location\(7\)\s*@interpolate\(flat\)\s*isOverflow:\s*u32,/);
  });

  it('a sprite light at layer 0 (no texture: the untextured index 0 among them) or without extent (range 0 or less) is a degenerate triangle, dropped before its square', () => {
    const sprite = blockAfter(body('vs_main'), 'if (kind == SPRITE) {');
    const drop = sprite.search(/if\s*\(\s*layer == 0u\s*\|\|\s*!\(\s*range > 0\.0\s*\)\s*\)\s*\{\s*out\.position = vec4f\(0\.0, 0\.0, 0\.0, 1\.0\);\s*return out;/);
    expect(drop).toBeGreaterThan(sprite.indexOf('let layer = packed & 0xFFFFu;'));
    expect(drop).toBeLessThan(sprite.indexOf('out.world ='));
  });

  it("the square turns with the light (spriteAxes: its facing and a mirrored side axis), half-side range, at the textured quad's uv", () => {
    const axes = body('spriteAxes');
    expect(axes).toMatch(/let facing = lightFacing\(m\);/);
    expect(axes).toMatch(/let side = vec2f\(-facing\.y, facing\.x\);/);
    expect(axes).toMatch(/return mat2x2f\(facing, select\(side, -side, dot\(side, m\[1\]\.xy\) < 0\.0\)\);/);
    const sprite = blockAfter(body('vs_main'), 'if (kind == SPRITE) {');
    expect(sprite).toMatch(/out\.world = center \+ spriteAxes\(m\) \* \(position\.xy \* 2\.0 \* range\);/);
    expect(sprite).toMatch(/out\.uv = position\.xy \+ 0\.5;/);
    // The textured quad's mapping (quad_vs): the cookie lies on the square as an image on a quad.
    expect(stripComments(loadPrimitivePieces().libraries[0])).toMatch(/unitQuadVertex\(position, entityIdx, position\.xy \+ 0\.5\)/);
  });

  it('fs_main: the cookie is the shape, without falloff or cone; a layer past its array is discarded; its rgb tints the colour, its alpha is the intensity', () => {
    const fs = body('fs_main');
    expect(fs).not.toMatch(/if\s*\(\s*kind\s*==\s*SPRITE\s*\)\s*\{\s*discard/);
    expect(fs).toMatch(/var color = vec3f\(primParams\[p\], primParams\[p \+ 1u\], primParams\[p \+ 2u\]\);/);
    expect(fs).toMatch(/if \(kind == POINT \|\| kind == SPOT \|\| kind == SPRITE\) \{/);
    const sprite = blockAfter(fs, 'if (kind == SPRITE) {');
    expect(sprite).toMatch(/if \(in\.texLayer >= cookieLayers\(in\)\) \{\s*discard;\s*\}\s*var image = in;\s*image\.uv = vec2f\(in\.uv\.x, 1\.0 - in\.uv\.y\);\s*let cookie = sampleTier\(image\);\s*color \*= cookie\.rgb;\s*intensity = cookie\.a;/);
    // The bound's discard is the branch's only one: no range test, no falloff, no cone.
    expect(sprite.match(/\bdiscard\b/g)).toHaveLength(1);
    expect(sprite).not.toMatch(/\b(?:pow|distance|smoothstep|lightFacing)\b/);
    expect(fs.match(/sampleTier\(/g)).toHaveLength(1);
    expect(fs.match(/cookieLayers\(/g)).toHaveLength(1);
  });

  it("the cookie is turned over as the prelude's sampleTierOrWhite turns every tier image: the same two lines, right before its sample", () => {
    const squash = (t: string): string => t.replace(/\s+/g, ' ').trim();
    const white = functionBody(PRELUDE, 'sampleTierOrWhite');
    expect(white).not.toBeNull();
    const flip = /var image = in;\s*image\.uv = [^;]*;/.exec(white!);
    expect(flip, "the prelude's flip").not.toBeNull();
    const sprite = squash(blockAfter(body('fs_main'), 'if (kind == SPRITE) {'));
    expect(sprite).toContain(`${squash(flip![0])} let cookie = sampleTier(image);`);
  });

  it('fs_main: falloff, range discard and cone unreachable for a sprite light; the march reachable', () => {
    // The bound's discard (the sprite branch's own) aside, every distance,
    // pow, discard and smoothstep of fs_main sits in the non-sprite branch,
    // and the shared march comes after both.
    const fs = body('fs_main').replace(/if \(in\.texLayer >= cookieLayers\(in\)\) \{\s*discard;\s*\}/, '');
    const outer = blockAfter(fs, 'if (kind == POINT || kind == SPOT || kind == SPRITE) {');
    const sprite = blockAfter(outer, 'if (kind == SPRITE) {');
    const after = outer.slice(outer.indexOf(sprite) + sprite.length);
    expect(after).toMatch(/^\s*else\s*\{/);
    const otherwise = blockAfter(after, 'else {');
    for (const re of [/\bdistance\(in\.world/g, /\bpow\(/g, /\bdiscard\b/g, /\bsmoothstep\(/g]) {
      expect(fs.match(re)?.length ?? 0, String(re)).toBe(otherwise.match(re)?.length ?? 0);
    }
    const tail = after.slice(after.indexOf(otherwise) + otherwise.length);
    expect(tail).toMatch(/if \(shadowStrength > 0\.0 && intensity > 0\.0\) \{[^]*\bpointShadow\(/);
    expect(otherwise).not.toMatch(/\bpointShadow\(/);
  });

  // The step-9 list's text guards on the march (round plan §4, step 6): the
  // sprite light marches through pointShadow and shadow() too.
  it('pointShadow: from the pixel toward the centre, the travel checked before it divides', () => {
    expect(body('pointShadow')).toMatch(/let travel = distance\(origin, lightPos\);\s*if \(travel < 1\.0\) \{\s*return 1\.0;\s*\}\s*let dir = \(lightPos - origin\) \/ travel;/);
  });

  it("shadow(): a pixel inside an occluder leaves it from its first read on; res starts lit and leaves clamped", () => {
    const march = body('shadow');
    expect(march).toMatch(/var h = sdfDistance\(vec2i\(origin\), size\);\s*var i = 0u;\s*while \(h <= 0\.0 && i < steps\) \{/);
    expect(march).toMatch(/var res = 1\.0;/);
    expect(march).toMatch(/return clamp\(res, 0\.0, 1\.0\);\s*$/);
  });

  it('exitDistance takes (origin, dir, size), the order sunShadow passes them in', () => {
    expect(functionParams(lightShaderSource, 'exitDistance')).toEqual(['origin', 'dir', 'size']);
  });

  it("the light type ids are Rust's LightType (components.rs), SPRITE 4 among them", () => {
    const rust = readFileSync(new URL('../../../../crates/hyperion-core/src/components.rs', import.meta.url), 'utf8');
    const types = new Map([.../pub enum LightType \{([^}]*)\}/.exec(rust)![1].matchAll(/(\w+)\s*=\s*(\d+)/g)].map((m) => [m[1].toUpperCase(), Number(m[2])]));
    expect(types).toEqual(new Map([['POINT', 0], ['SPOT', 1], ['DIRECTIONAL', 2], ['GLOBAL', 3], ['SPRITE', 4]]));
    const ids = new Map([...stripComments(lightShaderSource).matchAll(/const\s+([A-Z_]+)\s*:\s*u32\s*=\s*(\d+)u\s*;/g)].map((m) => [m[1], Number(m[2])]));
    for (const [name, id] of types) expect(ids.get(name), name).toBe(id);
  });
});
```
  L'ultimo test passa già a HEAD (una guardia sugli id di Rust). `body` (`:332-336`), `setUp` e `descOf` (Task 2) e gli import di `wgsl-analysis` (`:9`) e `readFileSync` (`:2`) esistono già.

  **`forward-pass.test.ts`:** dopo `import { structSize } from '../../shaders/uniform-layout';` (`:15`):
```ts
import lightAccumSource from '../../shaders/light-accum.wgsl?raw';
```
  Il titolo del `describe` di `:376` diventa `describe('packed index 0: white in every tier-sampling primitive, no light in light-accum.wgsl (layer 0 there)', () => {`; prima della sua chiusura (`:420`), dopo `it.each(['gradient', 'box-shadow'] …)` (`:415-419`):
```ts

  // A sprite light's cookie is its shape (round step 8): at layer 0, reserved
  // in every array (index 0 among them), it lights NOTHING, never white nor a
  // device-dependent reserved layer; a layer past its array is discarded.
  it('light-accum.wgsl: layer 0 (packed index 0 among them) lights nothing, decided in vs_main before any tier is sampled; a layer past its array is discarded', () => {
    const light = stripComments(lightAccumSource);
    const vs = body(light, 'vs_main');
    const untextured = vs.search(/if\s*\(\s*layer == 0u\s*\|\|[^)]*\)\s*\)\s*\{\s*out\.position = vec4f\(0\.0, 0\.0, 0\.0, 1\.0\);\s*return out;/);
    expect(untextured, 'the untextured early return').toBeGreaterThan(-1);
    expect(untextured).toBeLessThan(vs.indexOf('out.uv = position.xy + 0.5;'));
    expect(light).not.toMatch(/sampleTierOrWhite/);
    // sampleTier samples the tiers; cookieLayers only counts their layers.
    const readers = [...callGraph(light)].filter(([, refs]) => TIERS.some((t) => refs.has(t))).map(([name]) => name);
    expect(readers).toEqual(['sampleTier', 'cookieLayers']);
    expect(body(light, 'cookieLayers')).not.toMatch(/textureSample/);
    expect(reachableFrom(light, 'fs_main').has('sampleTier')).toBe(true);
    expect(reachableFrom(light, 'fs_main').has('cookieLayers')).toBe(true);
    expect(reachableFrom(light, 'vs_main').has('sampleTier')).toBe(false);
    for (const tier of TIERS) {
      expect(body(light, 'sampleTier')).toMatch(new RegExp(`textureSampleLevel\\(\\s*${tier}\\s*,\\s*texSampler\\s*,\\s*in\\.uv\\s*,\\s*in\\.texLayer\\s*,\\s*0\\.0\\s*\\)`));
    }
  });
```
  (`body(src, fn)` è quello di `:349-353`, `TIERS` quello di `:373`.)

  **`light-groups.test.ts`:** l'import di `:3` diventa:
```ts
import {
  deriveLightGroups, receiverLayer, LIT_PRIMITIVE_TYPES, SHADOWED_LIGHT_TYPES, BLEND_MIX, LIGHT2D, TEXTURE_LAYER_MASK, type LightGroupsInput,
} from './light-groups';
import { packTextureIndex } from '../texture-manager';
```
  `:21` diventa `const POINT = 0, DIRECTIONAL = 2, GLOBAL = 3, SPRITE = 4;`; in `type E`, dopo `blend?: number;` (`:32`):
```ts
  /** The packed texture index (round step 8). The column exists only when some entity of the scene sets it. */
  tex?: number;
```
  in `scene()`, dopo `const entityIds = new Uint32Array(n);` (`:61`):
```ts
  const texIndices = es.some((e) => e.tex !== undefined) ? Uint32Array.from(es, (e) => e.tex ?? 0) : undefined;
```
  il `return` di `:76`:
```ts
  return { entityCount: n, renderMeta, primParams, bounds, cameraViewProjection, entityIds, ...(texIndices ? { texIndices } : {}) };
```
  nel test del legame (`:339-341`), il commento:
```ts
    // Each gated type reaches a march in fs_main. A type both lists count but
    // no branch marches (a type added to the gates without its march branch)
    // floods an SDF set nothing reads, and never shadows.
```
  prima di `it('a global light never shadows: …'` (`:364`):
```ts
  // Round step 8. COOKIE: where a PNG cookie lands on a BC/ASTC device.
  const COOKIE = packTextureIndex(0, 1, true);
  const sprite = (shadow: number, extra: Partial<E> = {}): E => light(0xffff, shadow, { type: SPRITE, tex: COOKIE, ...extra });

  it('a shadowed sprite light with a texture gets an SDF set like a point light (round step 8)', () => {
    const on = deriveLightGroups(scene([sprite(1), drawable(CAST | RECV)]));
    expect(on.groups).toEqual([{ layers: 1, sdfSet: 0 }]);
    expect(on.sdfSets).toEqual([{ occluderLayers: 1 }]);
    expect(deriveLightGroups(scene([sprite(0), drawable(CAST | RECV)])).sdfSets).toEqual([]);
    expect(deriveLightGroups(scene([drawable(CAST | RECV), sprite(1)])).sdfSets, 'a sprite light in slot 1: its own index').toEqual([{ occluderLayers: 1 }]);
  });

  it('a shadowed sprite light that draws nothing gets no SDF set: a range of 0 or less, or no texture (layer 0)', () => {
    // 0x7ff80000: bits nobody decodes; then reserved layers 0 of two arrays.
    for (const extra of [{ range: 0 }, { range: -5 }, { tex: 0 }, { tex: 0x7ff80000 }, { tex: packTextureIndex(0, 0, true) }, { tex: packTextureIndex(1, 0) }]) {
      const g = deriveLightGroups(scene([sprite(1, extra), drawable(CAST | RECV)]));
      expect(g.sdfSets, JSON.stringify(extra)).toEqual([]);
      expect(g.groups).toEqual([{ layers: 1, sdfSet: -1 }]);
      expect([...g.lightOrder], 'still listed: vs_main drops it').toEqual([0]);
    }
    expect(deriveLightGroups(scene([sprite(1, { range: 0.5 }), drawable(CAST | RECV)])).sdfSets).toEqual([{ occluderLayers: 1 }]);
    // Why nothing reads it: vs_main drops such a light before its square.
    const wgsl = stripComments(readFileSync(new URL('../shaders/light-accum.wgsl', import.meta.url), 'utf8'));
    expect(functionBody(wgsl, 'vs_main')).toMatch(/if\s*\(\s*layer == 0u\s*\|\|\s*!\(\s*range > 0\.0\s*\)\s*\)/);
  });

  it('without a usable tex-indices column every sprite light counts as textured: all or nothing, never read past it', () => {
    const s = scene([sprite(1, { tex: 0 }), drawable(CAST | RECV)]);
    expect(deriveLightGroups(s).sdfSets).toEqual([]);
    for (const texIndices of [undefined, new Uint32Array(0), s.texIndices!.slice(0, 1)]) {
      expect(deriveLightGroups({ ...s, texIndices }).sdfSets, `${texIndices?.length ?? 'no'} indices`).toEqual([{ occluderLayers: 1 }]);
    }
  });

  it("TEXTURE_LAYER_MASK is the layer field light-accum.wgsl decodes and drops at 0: bits 0-15, whatever the tier and the overflow bit", () => {
    expect(TEXTURE_LAYER_MASK).toBe(packTextureIndex(0, 0xffff) >>> 0);
    const vs = functionBody(stripComments(readFileSync(new URL('../shaders/light-accum.wgsl', import.meta.url), 'utf8')), 'vs_main');
    expect(vs).toMatch(/let layer = packed & 0xFFFFu;/);
    expect(vs).toMatch(/if \(layer == 0u \|\|/);
    for (const tier of [0, 1, 7]) {
      for (const layer of [0, 1, 0xffff]) {
        for (const overflow of [false, true]) {
          const untextured = (packTextureIndex(tier, layer, overflow) & TEXTURE_LAYER_MASK) === 0;
          expect(untextured, `tier ${tier}, layer ${layer}, overflow ${overflow}`).toBe(layer === 0);
        }
      }
    }
  });

```
  e nel test 'lists what the cull draws as a light: …' (`:522-527`), il commento e la costante locale (`:523-525`; la `SPRITE` del file vale per tutti):
```ts
    // vs_main drops a mask-0 light in every group and a sprite light without
    // a texture, and cull.wgsl clamps a type past Light2D to Light2D.
    const PAST_LAST = LIGHT2D + 1;
```

- [ ] **Step 2: RED.**
```bash
npx --prefix ts vitest run --root ts src/render/passes/light-accum-stage.test.ts src/render/light-groups.test.ts src/render/passes/forward-pass.test.ts
```
  Expected: 15 falliti su 174: in `light-accum-stage.test.ts` il test dell'header e 9 dei test sulla sprite, quello del giro del cookie compreso (passano già quello sugli id di Rust e le tre guardie della marcia: `pointShadow`, `shadow()`, `exitDistance`); in `light-groups.test.ts` i 4 nuovi; in `forward-pass.test.ts` quello nuovo. Il test del legame fra i due gate (`:326-362`) resta verde: a HEAD nessuno dei due elenchi ha SPRITE.

- [ ] **Step 3: lo shader** (`ts/src/shaders/light-accum.wgsl`). Il primo paragrafo dell'header (`:1-5`):
```wgsl
// Light accumulation (Phase 17, Task 9; directional shadows: round 2026-09-27,
// step 6; one light list and the mix blend: step 7; sprite lights: step 8):
// the lights in view, drawn into the half-resolution light buffer in the order
// of the frame's light list. The buffer is cleared to the ambient light, and
// ForwardPass multiplies lit sprites by it.
```
  `:16-28` ("Point and spot lights are a quad …" fino a "… ignored."):
```wgsl
// Point and spot lights are a quad covering their range, around the light's
// position. A sprite light is the square of half-side `range` around its
// position, turned with its local +x axis (spriteAxes): its corners lie
// range * sqrt(2) away, its culling radius (systems.rs update_bounding_radii).
// The size of the transform's scale is ignored, because a light's extent IS
// its range (the same rule as its culling radius). Global and directional
// lights cover the screen. Light2D primParams: [colorR, colorG, colorB] with
// energy premultiplied, range, innerCos, outerCos, falloff, shadowIntensity; a
// sprite light reads the colour, the range and shadowIntensity only.
//
// Spot and directional lights shine toward their local +x axis (lightFacing),
// and a sprite light's square turns with it. A directional light (a sun) has
// no position: each caster's shadow runs along that axis, away from the light,
// for `range` world units and fades out over the last quarter, at a fixed
// apparent angle, u.sourceFraction. Its march gets 4x the step budget of a
// point or spot light (sunShadow). Global lights never cast shadows in the lit
// backend: their shadowIntensity is ignored.
```
  `:30` ("// Not yet: the `sprite` light type (discarded)."):
```wgsl
// A sprite light (round step 8) takes its shape from its cookie: the entity's
// texture, in the engine's texture tiers (group 1, declared as the prelude
// declares it), sampled at LOD 0 by sampleTier, a copy of the prelude's, at
// the uv a textured quad gives its image, turned over at the lookup as the
// prelude's sampleTierOrWhite turns every tier image: upright, its first row
// along the light's local +y. No falloff and no cone: it lights
// color * rgb * a, and a mix sprite light moves the buffer toward color * rgb
// by a. Its shadows march from its centre, like a point light's. Without a
// texture (layer 0 of its packed index: the untextured index 0, or the layer
// every tier array reserves) or with a range of 0 or less it draws nothing:
// vs_main drops it like a light outside the group. Nor does a layer past the
// end of its array (cookieLayers), which a sample would clamp to the last one.
```
  Dopo `@group(0) @binding(5) var sdf: texture_2d<f32>;` (`:56`):
```wgsl
// The packed texture index of every slot (the pool's tex-indices column):
// overflow bit 31, tier bits 16-18, layer bits 0-15. vs_main reads it for a
// sprite light's cookie; LightAccumStage's layout makes it vertex-only.
@group(0) @binding(6) var<storage, read> texLayerIndices: array<u32>;

// Group 1: the engine's texture tiers, a sprite light's cookie (round step 8).
// Declared exactly as primitives/prelude.wgsl declares them (bindings, names,
// types): LightAccumStage binds the prelude's layout, textureTierLayoutEntries(),
// through a TextureTierBinding, and light-accum-stage.test.ts compares the two.
// FRAGMENT only: only fs_main samples a cookie.
@group(1) @binding(0) var tier0Tex: texture_2d_array<f32>;
@group(1) @binding(1) var tier1Tex: texture_2d_array<f32>;
@group(1) @binding(2) var tier2Tex: texture_2d_array<f32>;
@group(1) @binding(3) var tier3Tex: texture_2d_array<f32>;
@group(1) @binding(4) var texSampler: sampler;
@group(1) @binding(5) var ovf0Tex: texture_2d_array<f32>;
@group(1) @binding(6) var ovf1Tex: texture_2d_array<f32>;
@group(1) @binding(7) var ovf2Tex: texture_2d_array<f32>;
@group(1) @binding(8) var ovf3Tex: texture_2d_array<f32>;
```
  In `VertexOutput`, fra `@location(3) @interpolate(flat) sunRay: vec3f,` (`:84`) e `};` (`:85`):
```wgsl
    // A sprite light's cookie (0 for every other light): the uv a textured
    // quad gives its image (quad_vs: the vertex position + 0.5; fs_main turns
    // v over before the sample, as the prelude's sampleTierOrWhite does), and
    // the packed texture index as the prelude's finishVertex decodes it. The
    // prelude's names: sampleTier below is its copy, text for text.
    @location(4) uv: vec2f,
    @location(5) @interpolate(flat) texTier: u32,
    @location(6) @interpolate(flat) texLayer: u32,
    @location(7) @interpolate(flat) isOverflow: u32,
```
  Dopo la chiusura di `lightFacing` (`:103`):
```wgsl

// A sprite light's axes, the columns of the result: its facing (lightFacing,
// its local +x) and the side axis a quarter turn from it, turned over when
// the transform mirrors: dot(side, column 1) = det / |column 0|, the sign of
// the determinant of the matrix's 2D part (Gram-Schmidt from column 0). So
// the cookie lies on the square as a textured quad's image lies on the quad
// (its uv mapping: the entity pipelines cull a mirrored quad, this one culls
// no face), mirrored by a negative x- or y-scale and turned half a turn by
// both, whatever the scale's size. Orthonormal under any transform, a sheared
// parent's included: the corners stay range * sqrt(2) from the centre, inside
// the culling radius. Below lightFacing's 1e-6 (a zero x-scale) the facing is
// world +x, as a spot's is, and the side axis follows column 1's y: a
// degenerate frame. A zero y-scale keeps the side axis unmirrored.
fn spriteAxes(m: mat4x4f) -> mat2x2f {
    let facing = lightFacing(m);
    let side = vec2f(-facing.y, facing.x);
    return mat2x2f(facing, select(side, -side, dot(side, m[1].xy) < 0.0));
}
```
  Il ramo `else` di `vs_main` (`:149-154`):
```wgsl
    } else {
        let m = transforms[e];
        let center = m[3].xy;
        let range = primParams[e * 8u + 3u];
        if (kind == SPRITE) {
            // Its cookie's packed index, decoded as the prelude's finishVertex
            // decodes it.
            let packed = texLayerIndices[e];
            let isOverflow = (packed >> 31u) & 1u;
            let tier = (packed >> 16u) & 0x7u;
            let layer = packed & 0xFFFFu;
            // No texture or no extent: nothing rasterised. Layer 0 is reserved
            // in every tier array, primary or overflow, and never holds a
            // texture (the untextured index 0, tier 0 layer 0, is one of
            // them): white in an rgba8 array, transparent black in a BC7 one,
            // ASTC's error colour (opaque magenta, or NaN) in an ASTC one, a
            // light that would depend on the device. A range of 0 or less is
            // culled on radius 0. A sprite light has no shape but its cookie.
            if (layer == 0u || !(range > 0.0)) {
                out.position = vec4f(0.0, 0.0, 0.0, 1.0);
                return out;
            }
            out.world = center + spriteAxes(m) * (position.xy * 2.0 * range);
            out.uv = position.xy + 0.5;
            out.texTier = tier;
            out.texLayer = layer;
            out.isOverflow = isOverflow;
        } else {
            out.world = center + position.xy * 2.0 * range;
        }
        out.position = u.viewProjection * vec4f(out.world, 0.0, 1.0);
    }
```
  Nei commenti di `sunFade` (`:174`), `shadow()` (`:195`, `:198`), `pointShadow` (`:261`) e `sunShadow` (`:308-309`) la sprite si aggiunge alle point e spot (righe riavvolte): "(point, spot and sprite lights)", "0 (point, spot, sprite)", "u.shadowSteps for a point, spot or sprite light", "A point, spot or sprite light: from the pixel", "Point, spot and sprite lights keep u.shadowSteps: point and spot pixels are those of before step 6.". Tre commenti si completano (voci `:145`, `:147`, `:148` del §4 del giro): `directionalRay` (`:110-112`; "// y-up, the texture y-down)." diventa la prima riga):
```wgsl
// y-up, the texture y-down). The bounded product below assumes `texels` is
// finite: from a zoom of about 6.8e17, length(perUnit) overflows f32 and the
// ray is NaN (0 * inf). Nothing guards that; no camera gets there.
```
  `sdfDistance` (`:159-161`; "// anywhere, which means there is no occluder in view." diventa la prima):
```wgsl
// anywhere, which means there is no occluder in view. The clamp is not dead
// code: it holds rule (4) of the march (a sun stops at the SDF's exit), whose
// last sample can still land on index `size` in f32. Padding the SDF (round
// step 8c) must keep it.
```
  `pointShadow` (`:267-268`; "// real size, so a far pixel sees a small light." diventa la prima):
```wgsl
// real size, so a far pixel sees a small light. It is an angular RADIUS, and
// shadow() reads `angle` as an angular DIAMETER: the penumbra is that of a
// source sourceRadius texels wide, half the size the name says. Tuned and
// measured that way (2026-09-26); a factor of 2 here would widen every point,
// spot and sprite penumbra.
```
  `shadowedLightType` (`:320-326`) diventa, seguito dalla copia di `sampleTier` e da `cookieLayers`:
```wgsl
// The light types that cast shadows in the lit backend. A sprite light casts
// from its centre, like a point light (round step 8). Never GLOBAL: it has no
// position and no direction to cast from, and its shadowIntensity is ignored.
// light-groups.ts counts exactly these as shadowed (SHADOWED_LIGHT_TYPES);
// light-groups.test.ts ties the two lists.
fn shadowedLightType(kind: u32) -> bool {
    return kind == POINT || kind == SPOT || kind == DIRECTIONAL || kind == SPRITE;
}

// The texel at in.uv from the entity's tier (with overflow support), RAW like
// the prelude's: it would sample layer 0 like any other, but vs_main drops a
// layer-0 sprite light and fs_main discards a layer past its array
// (cookieLayers) first. A COPY of the prelude's sampleTier
// (primitives/prelude.wgsl), text for text, which
// light-accum-stage.test.ts compares: a new tier changes both. LOD 0,
// explicitly: the call sits in one light type's branch, non-uniform control
// flow, where only an explicit level is legal, and the tiers fill mip 0 only.
fn sampleTier(in: VertexOutput) -> vec4f {
    var texColor: vec4f;
    if (in.isOverflow == 0u) {
        switch in.texTier {
            case 1u: { texColor = textureSampleLevel(tier1Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 2u: { texColor = textureSampleLevel(tier2Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 3u: { texColor = textureSampleLevel(tier3Tex, texSampler, in.uv, in.texLayer, 0.0); }
            default: { texColor = textureSampleLevel(tier0Tex, texSampler, in.uv, in.texLayer, 0.0); }
        }
    } else {
        switch in.texTier {
            case 1u: { texColor = textureSampleLevel(ovf1Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 2u: { texColor = textureSampleLevel(ovf2Tex, texSampler, in.uv, in.texLayer, 0.0); }
            case 3u: { texColor = textureSampleLevel(ovf3Tex, texSampler, in.uv, in.texLayer, 0.0); }
            default: { texColor = textureSampleLevel(ovf0Tex, texSampler, in.uv, in.texLayer, 0.0); }
        }
    }
    return texColor;
}

// The layer count of the cookie's array (in.isOverflow, in.texTier). A layer
// at or past it does not exist on this renderer (an index from a tape or a
// snapshot of another session, or Mode A's render worker, whose arrays are
// 1-layer placeholders), and a sample would clamp it to the last layer, white
// in an rgba8 placeholder: fs_main discards it instead. sampleTier's arms,
// textureNumLayers only; light-accum-stage.test.ts pins both.
fn cookieLayers(in: VertexOutput) -> u32 {
    var layers: u32;
    if (in.isOverflow == 0u) {
        switch in.texTier {
            case 1u: { layers = textureNumLayers(tier1Tex); }
            case 2u: { layers = textureNumLayers(tier2Tex); }
            case 3u: { layers = textureNumLayers(tier3Tex); }
            default: { layers = textureNumLayers(tier0Tex); }
        }
    } else {
        switch in.texTier {
            case 1u: { layers = textureNumLayers(ovf1Tex); }
            case 2u: { layers = textureNumLayers(ovf2Tex); }
            case 3u: { layers = textureNumLayers(ovf3Tex); }
            default: { layers = textureNumLayers(ovf0Tex); }
        }
    }
    return layers;
}
```
  In `fs_main`, `:332-336` (da `let kind = lightType(e);` a `let color = …;`, scarto compreso):
```wgsl
    let kind = lightType(e);
    var color = vec3f(primParams[p], primParams[p + 1u], primParams[p + 2u]);
```
  e `:340-362`, da `var intensity = 1.0;` alla riga `if (shadowStrength > 0.0 && intensity > 0.0) {` compresa:
```wgsl
    var intensity = 1.0;
    if (kind == POINT || kind == SPOT || kind == SPRITE) {
        let m = transforms[e];
        let center = m[3].xy;
        let range = primParams[p + 3u];
        if (kind == SPRITE) {
            // The cookie is the shape: no falloff, no cone. vs_main drew
            // nothing for layer 0; a layer this renderer does not hold is
            // discarded here, never clamped to the last one. The image is
            // upright, as every tier image is: v is turned over before the
            // sample, the two lines of the prelude's sampleTierOrWhite, copied
            // (light-accum-stage.test.ts ties them). The texels hold
            // straight alpha: copyExternalImageToTexture writes them
            // unpremultiplied (its default); a browser that decodes
            // premultiplied (Chrome's createImageBitmap default) has already
            // rounded rgb * a to 8 bits, so color * rgb * a stays within about
            // 1/255 of the image's, while rgb alone can be far off where a is
            // small. The light is color * rgb * a, and for a mix light a is
            // the weight and color * rgb the target.
            if (in.texLayer >= cookieLayers(in)) {
                discard;
            }
            var image = in;
            image.uv = vec2f(in.uv.x, 1.0 - in.uv.y);
            let cookie = sampleTier(image);
            color *= cookie.rgb;
            intensity = cookie.a;
        } else {
            let d = distance(in.world, center);
            if (d >= range) {
                discard;
            }
            intensity = pow(1.0 - d / range, max(primParams[p + 6u], 0.0));

            if (kind == SPOT) {
                let facing = lightFacing(m);
                let toPixel = select(facing, (in.world - center) / d, d > 1e-4);
                let cosAngle = dot(facing, toPixel);
                let innerCos = primParams[p + 4u];
                let outerCos = primParams[p + 5u];
                // smoothstep is undefined when its edges meet: a hard cone then.
                let cone = select(step(outerCos, cosAngle), smoothstep(outerCos, innerCos, cosAngle), innerCos > outerCos + 1e-5);
                intensity *= cone;
            }
        }

        // From the light's centre, a sprite light's too.
        if (shadowStrength > 0.0 && intensity > 0.0) {
```
  Il corpo dell'ombra, il ramo directional e la coda del blend restano; nel commento del mix (`:378-379`) "(falloff, cone and shadow each are)" → "(the attenuation, the cone, a cookie's alpha and the shadow each are)", righe riavvolte.

- [ ] **Step 4: il gate CPU** (`light-groups.ts`). In `LightGroupsInput`, dopo `entityIds?: Uint32Array;` (`:90`):
```ts
  /**
   * Slot -> packed texture index (round step 8): a sprite light's cookie. A
   * sprite light without one (layer 0, TEXTURE_LAYER_MASK) draws nothing, so
   * its shadows need no SDF. A column shorter than `entityCount`, or none, is
   * ignored whole, and every sprite light counts as textured: a flood too
   * many costs time, one too few would cost shadows.
   */
  texIndices?: Uint32Array;
```
  `:118-125` (da `const GLOBAL = 3;` a `SHADOWED_LIGHT_TYPES`):
```ts
const GLOBAL = 3;
const SPRITE = 4;
/**
 * The light types whose shadowIntensity makes light-accum.wgsl march the SDF:
 * its `shadowedLightType`, which light-groups.test.ts compares with this list.
 * Never GLOBAL: a global light has no position and no direction to cast from.
 * A sprite light casts from its centre, like a point light (round step 8).
 */
export const SHADOWED_LIGHT_TYPES: readonly number[] = [POINT, SPOT, DIRECTIONAL, SPRITE];
```
  Dopo `const MARGIN_ADD = 1e-3;` (`:137`):
```ts

/**
 * The layer field of a packed texture index (bits 0-15), as the prelude's
 * finishVertex and light-accum.wgsl's vs_main decode it. Layer 0 is reserved
 * in every tier array, primary or overflow, and never holds a texture; the
 * untextured index 0 (tier 0, layer 0, not overflow) is one such index. A
 * sprite light at layer 0 draws nothing (round step 8): vs_main tests
 * `layer == 0u`, whatever the tier and the overflow bit.
 */
export const TEXTURE_LAYER_MASK = 0xffff;

/**
 * The one rule for a sprite light without a texture (round step 8), shared by
 * every reader of a cookie's index (the SDF gate first). The layer of the
 * slot's packed index is 0 (TEXTURE_LAYER_MASK), which light-accum.wgsl's
 * vs_main draws nothing for. All or nothing, like the ids: without a usable
 * `texIndices` column (shorter than `entityCount`, or none) no slot is
 * untextured, since a flood too many costs time where one too few would cost
 * shadows.
 */
export function untexturedPredicate(input: Pick<LightGroupsInput, 'entityCount' | 'texIndices'>): (slot: number) => boolean {
  const tex = input.texIndices !== undefined && input.texIndices.length >= input.entityCount ? input.texIndices : null;
  return (slot) => tex !== null && (tex[slot] & TEXTURE_LAYER_MASK) === 0;
}
```
  Dopo `const ids = …;` (`:199`):
```ts
  // The same all-or-nothing rule for the cookies (untexturedPredicate):
  // without a usable column every sprite light counts as textured.
  const untextured = untexturedPredicate(input);
```
  `:223-232` (dal commento "The shader's gate …" a `if (type !== DIRECTIONAL || …) shadowedLayers |= mask;`; il ramo `} else if (type === GLOBAL) {` che segue resta):
```ts
      // The shader's gate (shadowedLightType in light-accum.wgsl): point,
      // spot, directional or sprite, with a shadow strength above 0. A global
      // light's strength is ignored there: flag it for the renderer's warning.
      const type = (word >>> LIGHT_TYPE_SHIFT) & 7;
      const strength = Math.min(Math.max(primParams[i * 8 + 7], 0), 1);
      if (strength > 0) {
        if (SHADOWED[type] === 1) {
          // Only a light that reads the flood asks for one: a sun with a
          // range > 0; a sprite light that draws (vs_main drops one at
          // layer 0 or with a range of 0 or less).
          const range = primParams[i * 8 + 3];
          const reads = type === DIRECTIONAL ? range > 0
            : type === SPRITE ? range > 0 && !untextured(i)
            : true;
          if (reads) shadowedLayers |= mask;
```

- [ ] **Step 5: GREEN e cancelli headless.** Il comando dello Step 2: 174/174 (lo stadio 63, `light-groups` 51, `forward-pass` 60); `npm --prefix ts test`: 115 file, 2155 + 7 saltati; `tsc` pulito; naga (`D="$(mktemp -d)"; cp ts/src/shaders/light-accum.wgsl "$D/"; node scripts/validate-wgsl-naga.mjs "$D"`): `ok   light-accum.wgsl`, `1/1 valid (naga)`; i `node:test` 64/64.

- [ ] **Step 5b: la prova che i test mordono** (una mutazione alla volta, poi i tre file dello Step 2; ogni mutante fa fallire almeno un test): `shadowedLightType` senza `|| kind == SPRITE`; `SHADOWED_LIGHT_TYPES` senza SPRITE; `case 1u` e `case 2u` di `sampleTier` scambiati; il ramo della sprite che moltiplica ancora per `pow(1.0 - distance(in.world, center) / range, 1.0)`; `spriteAxes` che restituisce `mat2x2f(facing, side)`; `out.uv = vec2f(position.x + 0.5, 0.5 - position.y);`; il giro del cookie tolto (`let cookie = sampleTier(in);`); il giro del cookie su u (`image.uv = vec2f(1.0 - in.uv.x, in.uv.y);`); il drop senza `|| !(range > 0.0)` o senza il layer 0; `TEXTURE_LAYER_MASK = 0x8007ffff`; in `untexturedPredicate`, la colonna senza `length >= input.entityCount`, o `tex[0]` al posto di `tex[slot]`; nel ramo della sprite di `vs_main`, `out.texLayer = tier;`, `out.isOverflow = 0u;` o senza `out.texTier = tier;`; `ovf0Tex` al binding 9; il tier con `& 0x3u`; `fs_main` senza il limite di `cookieLayers`; `case 2u` di `cookieLayers` su `ovf1Tex`; i tre mutanti di `fs_main` validi per naga, visti solo dallo strutturale: (A) il blocco `if (shadowStrength > 0.0 && intensity > 0.0) { … pointShadow … }` nell'`else` non sprite, (B) `let dd = distance(in.world, center); if (dd >= range) { discard; }` prima di `if (kind == SPRITE)`, (C) `if (kind == SPRITE) { intensity *= pow(max(1.0 - distance(in.world, center) / range, 0.0), max(primParams[p + 6u], 0.0)); }` dopo il ramo del cookie; le guardie della marcia (`if (travel < 0.5)` in `pointShadow`, `return res;` in `shadow()`, `exitDistance(dir: vec2f, origin: vec2f, size: vec2f)`). Poi il codice di nuovo, e il verde.
- [ ] **Step 6: lo script del cancello GPU** `docs/plans/assets/2026-10-14-step8/tools/gate-step8.js`, una funzione per `evaluate_script`:
```js
async () => {
  // Round step 8, Task 3 GPU gate, on a device of its own: the step-8 shader
  // compiles, and so do the seven composed primitive modules, each with the
  // image flip of sampleTierOrWhite (sub-decision 2); the two-group pipeline
  // passes createGpuValidation; a frame drawing a sprite light through the
  // overflow tier submits with 0 errors after the tier GROWS, while a pool
  // left on the old view (the negative control) does not; then five texels
  // of the target (sub-decision 4 (d)): a loaded cookie lights, and index 0,
  // primary tier 1 layer 0, overflow tier 0 layer 0 and a layer past a
  // 1-layer array light nothing. Returns the evidence object (pass it a
  // filePath).
  const { LightAccumStage } = await import('/src/render/passes/light-accum-stage.ts');
  const { ForwardPass } = await import('/src/render/passes/forward-pass.ts');
  const { ResourcePool } = await import('/src/render/resource-pool.ts');
  const { createGpuValidation } = await import('/src/render/graph-host.ts');
  const { TextureManager, packTextureIndex } = await import('/src/texture-manager.ts');
  const source = LightAccumStage.SHADER_SOURCE;
  if (!source) {
    throw new Error('LightAccumStage.SHADER_SOURCE is empty: this import is a second module instance (restart the dev server and navigate again)');
  }
  // The six per-type modules and the uber, as the live renderer composed them.
  const primitiveSources = [...Object.values(ForwardPass.SHADER_SOURCES), ForwardPass.UBER_SOURCE];
  if (primitiveSources.length !== 7 || primitiveSources.some((s) => !s)) {
    throw new Error('ForwardPass.SHADER_SOURCES or UBER_SOURCE is empty: this import is a second module instance (restart the dev server and navigate again)');
  }
  const meta = window.__harnessMeta ?? {};
  let chrome = null;
  try {
    chrome = (await navigator.userAgentData?.getHighEntropyValues(['fullVersionList']))?.fullVersionList ?? null;
  } catch {
    chrome = null;
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('navigator.gpu.requestAdapter() returned null');
  const info = adapter.info ?? {};
  const device = await adapter.requestDevice();
  try {
    const compilation = await device.createShaderModule({ code: source }).getCompilationInfo();
    const messages = compilation.messages.map((m) => ({ type: m.type, line: m.lineNum, column: m.linePos, message: m.message }));
    const primitiveMessages = [];
    for (const [module, code] of primitiveSources.entries()) {
      for (const m of (await device.createShaderModule({ code }).getCompilationInfo()).messages) {
        primitiveMessages.push({ module, type: m.type, line: m.lineNum, column: m.linePos, message: m.message });
      }
    }
    const flip = /var image = in;\s*image\.uv = vec2f\(in\.uv\.x, 1\.0 - in\.uv\.y\);\s*return sampleTier\(image\);/;
    const imageFlipInEveryModule = primitiveSources.every((code) => flip.test(code.replace(/\/\/[^\n]*/g, '')));
    const validation = createGpuValidation(device);
    // One sprite light in slot 0: identity transform (centre 0, 0), white,
    // range 0.5, type 4, every layer; its cookie at overflow tier 0, layer 1.
    const storage = (label, data) => {
      const b = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: `gate-${label}` });
      device.queue.writeBuffer(b, 0, data);
      return b;
    };
    const cookie = packTextureIndex(0, 1, true) >>> 0;
    const textures = new TextureManager(device);
    const pools = { live: new ResourcePool(), stale: new ResourcePool() };
    for (const pool of Object.values(pools)) {
      pool.setBuffer('entity-transforms', storage('transforms', new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])));
      pool.setBuffer('prim-params', storage('prim-params', new Float32Array([1, 1, 1, 0.5, -1, -1, 1, 0])));
      pool.setBuffer('render-meta', storage('render-meta', new Uint32Array([0, (6 | (4 << 11) | (0xffff << 16)) >>> 0])));
      pool.setBuffer('tex-indices', storage('tex-indices', new Uint32Array([cookie])));
    }
    // What renderer.ts registerTextureViews does, on the live pool only.
    const register = (pool) => {
      for (let t = 0; t < 4; t++) {
        pool.setTextureView(`tier${t}`, textures.getTierView(t));
        pool.setTextureView(`ovf${t}`, textures.getOverflowTierView(t));
      }
      pool.setSampler('texSampler', textures.getSampler());
    };
    register(pools.live);
    register(pools.stale);
    textures.onViewsChanged = () => register(pools.live);
    textures.ensureOverflowCapacity(0, 2);  // the first allocation: 16 layers, layer 1 the cookie's
    register(pools.stale);
    const stages = { live: new LightAccumStage(), stale: new LightAccumStage() };
    const setupErrors = {};
    for (const [name, stage] of Object.entries(stages)) setupErrors[name] = await validation.run(() => stage.setup(device, pools[name]));
    const targetTexture = device.createTexture({ size: { width: 64, height: 64 }, format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, label: 'gate-target' });
    const target = targetTexture.createView();
    const sdf = device.createTexture({ size: { width: 1, height: 1 }, format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING, label: 'gate-sdf' }).createView();
    const frame = { canvasWidth: 128, canvasHeight: 128, cameraViewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), ambient: [0, 0, 0, 1], shadowSteps: 48 };
    const draw = (name) => validation.run(() => {
      const stage = stages[name];
      stage.prepare(device, frame, [{ layers: 1, sdfSet: -1 }], new Uint32Array([0]));
      const encoder = device.createCommandEncoder();
      stage.encode(encoder, 0, target, sdf, frame, pools[name]);
      device.queue.submit([encoder.finish()]);
    });
    const before = { live: await draw('live'), stale: await draw('stale') };
    textures.ensureOverflowCapacity(0, 17);  // 16 -> 32: the copy, then the old texture destroyed
    const after = { live: await draw('live'), stale: await draw('stale') };
    // Sub-decision 4 (d): five texels of the target, each after a frame drawn
    // with one index in slot 0. This TextureManager has no compressed format,
    // so every layer 0 is white and an unallocated tier is a 1-layer WHITE
    // placeholder: without the layer-0 drop of vs_main the target lights at
    // index 0, primary tier 1 layer 0 and overflow tier 0 layer 0, and
    // without the cookieLayers bound of fs_main overflow tier 3's layer 1 is
    // clamped to that placeholder's white layer 0. The cookie, a 4 x 4
    // rgb(255, 128, 0) PNG (primary tier 0, layer 1), is the positive control.
    const png = new OffscreenCanvas(4, 4);
    const ctx = png.getContext('2d');
    ctx.fillStyle = 'rgb(255, 128, 0)';
    ctx.fillRect(0, 0, 4, 4);
    const url = URL.createObjectURL(await png.convertToBlob({ type: 'image/png' }));
    const cookieIndex = await textures.loadTexture(url);
    URL.revokeObjectURL(url);
    const half = (h) => {
      const sign = h & 0x8000 ? -1 : 1;
      const e = (h >> 10) & 0x1f;
      const m = h & 0x3ff;
      if (e === 0) return sign * m * 2 ** -24;
      if (e === 31) return m ? NaN : sign * Infinity;
      return sign * (1 + m / 1024) * 2 ** (e - 15);
    };
    // Texel (32, 32), inside the light's square (pixels 16-48 of the target).
    const readTexel = async () => {
      const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'gate-readback' });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: targetTexture, origin: { x: 32, y: 32 } }, { buffer, bytesPerRow: 256 }, { width: 1, height: 1 });
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const h = new Uint16Array(buffer.getMappedRange(0, 8).slice(0));
      buffer.unmap();
      buffer.destroy();
      return [half(h[0]), half(h[1]), half(h[2])];
    };
    const cases = {
      cookie: cookieIndex,
      index0: 0,
      tier1Layer0: packTextureIndex(1, 0),
      overflowLayer0: packTextureIndex(0, 0, true),
      pastTheEnd: packTextureIndex(3, 1, true),
    };
    const witness = {};
    for (const [name, index] of Object.entries(cases)) {
      device.queue.writeBuffer(pools.live.getBuffer('tex-indices'), 0, new Uint32Array([index >>> 0]));
      const errors = await draw('live');
      witness[name] = { index: index >>> 0, errors, rgb: await readTexel() };
    }
    for (const stage of Object.values(stages)) stage.destroy();
    const code = source.replace(/\/\/[^\n]*/g, '');
    return {
      gate: 'step8-task3',
      head: meta.head ?? null,
      adapterLine: meta.adapterLine ?? null,
      date: new Date().toISOString(),
      mode: window.__hyperion?.mode ?? null,
      search: location.search,
      adapter: { vendor: info.vendor ?? '', architecture: info.architecture ?? '', description: info.description ?? '' },
      chrome,
      userAgent: navigator.userAgent,
      shaderBytes: source.length,
      stepEightShader: /@group\(1\)\s*@binding\(5\)\s*var ovf0Tex/.test(code) && /\bspriteAxes\b/.test(code) && /\bcookieLayers\b/.test(code) && !/kind == SPRITE\) \{\s*discard/.test(code),
      messages,
      primitiveMessages,
      imageFlipInEveryModule,
      setupErrors,
      overflowLayers: textures.getOverflowAllocatedLayers(0),
      drawErrors: { before, after },
      cookieIndex,
      witness,
    };
  } finally {
    device.destroy();
  }
}
```
  `node --check docs/plans/assets/2026-10-14-step8/tools/gate-step8.js` non stampa nulla ed esce 0 (il file è un'unica espressione: la analizza senza eseguirla).
- [ ] **Step 7: commit**
```bash
git add ts/src/shaders/light-accum.wgsl ts/src/render/light-groups.ts ts/src/render/light-groups.test.ts ts/src/render/passes/light-accum-stage.test.ts ts/src/render/passes/forward-pass.test.ts docs/plans/assets/2026-10-14-step8/tools/gate-step8.js
git commit -m "feat(8): la luce sprite disegna il suo cookie (quadrato che ruota, tier delle texture, LOD 0, ombre dal centro); shadowedLightType e SHADOWED_LIGHT_TYPES prendono SPRITE insieme" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
- [ ] **Step 7b: una regola per il set SDF di ogni luce ombreggiata, un commit suo** (sotto-decisione 3 (c)). Oggi una point o una spot ombreggiata con `range` ≤ 0 apre un set SDF (verificato a HEAD: un set, e può dividere un gruppo: 2 gruppi e 1 set dove la regola dà 1 gruppo e nessun set), ma non legge mai il flood: a range 0 il suo quad ha area nulla, e `fs_main` scarta ogni pixel a `d >= range` prima della marcia. Il sole lo fa già dal passo 6 (`bbf7183`); il gate dello Step 4 aveva tre casi, qui ne resta uno. Gli elenchi dei tipi non cambiano: i due gate restano cambiati insieme nel commit dello Step 7. Il giudice l'ha provato in un clone dello specchio (`sd3-judge-13064`), su 172 test.
  (i) RED. In `light-groups.test.ts` la riga delle costanti (Task 3, Step 1) diventa `const POINT = 0, SPOT = 1, DIRECTIONAL = 2, GLOBAL = 3, SPRITE = 4;`, e il test 'a sun whose shadow has no length (range <= 0) gets no SDF set: nothing would read the flood' (`:302-317` a HEAD) si sostituisce sul posto, nessun test in più:
```ts
  it('a shadowed light that draws nothing (range <= 0) gets no SDF set and splits no group: nothing would read the flood', () => {
    // Review wf_cf354af4-c53 [5]: such a sun cost a seed and a full flood
    // (~1.8 ms at 1080p) every frame for an image identical to shadow 0.
    // Round step 8: point and spot lights too (step 6 fixed the sun only);
    // sprite lights: the tests of round step 8 below. Rust gives a point or
    // spot light of range <= 0 the radius 0: listed while its centre is in view.
    const shapes: Array<[string, Partial<E>]> = [
      ['directional', { type: DIRECTIONAL, x: 100, r: 3.4e38 }], ['point', { type: POINT, r: 0 }], ['spot', { type: SPOT, r: 0 }],
    ];
    for (const [name, shape] of shapes) {
      for (const range of [0, -5]) {
        const g = deriveLightGroups(scene([light(0xffff, 1, { ...shape, range }), drawable(CAST | RECV)]));
        expect(g.sdfSets, `${name}, range ${range}`).toEqual([]);
        expect(g.groups, `${name}, range ${range}`).toEqual([{ layers: 1, sdfSet: -1 }]);
        expect([...g.lightOrder], `${name}, range ${range}: still listed`).toEqual([0]);
      }
      expect(deriveLightGroups(scene([light(0xffff, 1, { ...shape, range: 0.5 }), drawable(CAST | RECV)])).sdfSets, name).toEqual([{ occluderLayers: 1 }]);
    }
    // Nor does it split a group: layer 1, which no caster shadows, joins layer 0.
    const merged = deriveLightGroups(scene([
      light(0xffff, 1, { range: 0, r: 0 }), light(0xffff), drawable(RECV, 0b01), drawable(RECV, 0b10), drawable(CAST, 0b01),
    ]));
    expect(merged.groups).toEqual([{ layers: 0b11, sdfSet: -1 }]);
    // Why the shader reads no SDF for them. A sun: the range is clamped at 0,
    // so the ray's length is 0, and sunShadow returns before its first read.
    const wgsl = stripComments(readFileSync(new URL('../shaders/light-accum.wgsl', import.meta.url), 'utf8'));
    expect(functionBody(wgsl, 'directionalRay')).toMatch(/min\(\s*max\(\s*primParams\[e \* 8u \+ 3u\]\s*,\s*0\.0\s*\)/);
    expect(functionBody(wgsl, 'sunShadow')).toMatch(/if\s*\(\s*travel\s*<\s*1\.0\s*\)\s*\{\s*return\s+1\.0\s*;/);
    // A point or spot light: fs_main discards every pixel at d >= range
    // (all of them, d >= 0 >= range) before its march.
    const fs = functionBody(wgsl, 'fs_main')!;
    const cut = fs.search(/let d = distance\(in\.world, center\);\s*if \(d >= range\) \{\s*discard;\s*\}/);
    expect(cut, 'the range discard of a point or spot light').toBeGreaterThan(-1);
    expect(cut).toBeLessThan(fs.search(/\bpointShadow\(/));
  });
```
  Il comando dello Step 2: 1 fallito su 174, `point, range 0: expected [ { occluderLayers: 1 } ] to deeply equal []` (il giudice: 1 su 172, prima del test di `forward-pass` dello Step 0 e di quello del giro del cookie).
  (ii) Il codice. In `light-groups.ts`, nel gate dello Step 4, da `// Only a light that reads the flood asks for one: a sun with a` a `if (reads) shadowedLayers |= mask;`:
```ts
          // Only a light that reads the flood asks for one, and none does
          // with a range of 0 or less: sunShadow returns before its first SDF
          // read, fs_main discards every point or spot pixel at d >= range
          // before its march, and vs_main drops such a sprite light, as it
          // drops one without a texture (untexturedPredicate).
          if (primParams[i * 8 + 3] > 0 && (type !== SPRITE || !untextured(i))) shadowedLayers |= mask;
```
  (iii) GREEN: 174/174; `npm --prefix ts test`: 115 file, 2155 + 7 saltati (nessun test in più); `tsc` pulito.
  (iv) Mutanti (uno alla volta, poi il verde; ciascuno fa fallire almeno un test): `>= 0` al posto di `> 0`; il ternario dello Step 4 di nuovo; senza la clausola della sprite (`if (primParams[i * 8 + 3] > 0) shadowedLayers |= mask;`).
  (v) Commit:
```bash
git add ts/src/render/light-groups.ts ts/src/render/light-groups.test.ts
git commit -m "perf(8): una luce ombreggiata con range ≤ 0 non apre un set SDF, a ogni tipo (point e spot come il sole del passo 6): stessi pixel" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
- [ ] **Step 8: il cancello GPU** (il controller, dopo il commit; `ts/wasm` non si ricostruisce). `sh .claude/skills/gpu-check/scripts/gpu-infra.sh up`, poi una gamba `gpu-leg` (`title: 'Step 8 Task 3 GPU gate'`, `head` = `git rev-parse HEAD` a fine tornata SDD, cioè il commit dello Step 7b più le eventuali correzioni `fix(8)` delle review (con lo SHA dello Step 7b dopo una correzione la gamba torna BLOCKED), `evidenceDir: 'docs/plans/assets/2026-10-14-step8'`, il `context` dei Vincoli globali con la frase su `ts/wasm`), con nello spazio SDD:
  - `task-3-gpu-steps.md`: (1) `git rev-parse HEAD` e `git status --short --untracked-files=no` (vuoto); (2) naga in una cartella sotto `target/gpu-check/`, l'unico posto dove una gamba scrive file di lavoro: `D="$(mktemp -d "$PWD/target/gpu-check/naga.XXXXXX")"; cp ts/src/shaders/light-accum.wgsl "$D/"; node scripts/validate-wgsl-naga.mjs "$D"`; (3) la pagina `"http://localhost:5173/?mode=B&bench"` (`ignoreCache`, initScript `anti-reload-init.js`, `resize_page` 1200×689, la riga dell'adapter, `window.__harnessMeta = { head, adapterLine }`); (4) `tools/gate-step8.js` con filePath `<ev>/gate-m2.json`; (5) `window.__viteWsCloses` e la console (error, warn).
  - `task-3-gpu-expectations.md`: (1) naga `1/1 valid`; (2) dpr 2, modalità B, la riga dell'adapter esatta, `__viteWsCloses` [], al più il 404 di `favicon.ico`; (3) `stepEightShader` true; `messages`, `primitiveMessages`, `setupErrors.live`/`stale`, `drawErrors.before.live`/`stale` e `drawErrors.after.live` vuoti; `imageFlipInEveryModule` true; `overflowLayers` 32; (4) `drawErrors.after.stale` NON vuoto (il controllo negativo: il gruppo fermo sulla vista distrutta), col primo messaggio citato; (5) da riportare: `head` e `adapterLine`; (6) il testimone: `cookieIndex` 1; `witness.cookie.rgb` con r > 0,95, 0,45 < g < 0,55 e b < 0,02; `witness.index0`, `witness.tier1Layer0`, `witness.overflowLayer0` e `witness.pastTheEnd` con `rgb` esattamente [0, 0, 0]; ogni `witness.*.errors` vuoto.

  Poi `… gpu-infra.sh down`. Il verdetto in `docs/plans/assets/2026-10-14-step8/legs/task-3-result.json`, coi percorsi locali sostituiti da `<repo>`, `~` e `<tmp>`. Con `pass` true:
```bash
git add docs/plans/assets/2026-10-14-step8/gate-m2.json docs/plans/assets/2026-10-14-step8/legs/task-3-result.json
git commit -m "test(8): cancello GPU del Task 3 sul Mac: lo shader e i moduli composti compilano, la pipeline a due gruppi passa la validazione, un tier che cresce non rompe il frame, cinque texel confermano il cookie e gli scarti" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
  Con `pass` false, `superpowers:systematic-debugging` prima del Task 4 (correzioni `fix(8)` col loro test). Se fallisce solo l'aspettativa 4, il gate prova meno di quanto promette: si annota e si decide; il check del Task 5 resta il cancello sul motore vivo. Se fallisce solo il controllo positivo dell'aspettativa 6 (per esempio il giro del PNG per `fetch(blob:)` e `createImageBitmap`), si corregge il testimone; i quattro zeri esatti non si allentano mai.

### Task 4: l'API TS: l'avviso della sprite senza texture, i layer in uso e il JSDoc

`deriveLightGroups` alza `untexturedSpriteLight` per una sprite listata (il test esatto del cull) senza texture secondo `untexturedPredicate` (il layer 0, l'indice 0 compreso), solo con una colonna `texIndices` usabile; il renderer avvisa una volta in dev quando il flag è durato `UNTEXTURED_SPRITE_MS` (1000 ms) di frame illuminati, ogni frame contato al più `HELD_STEP_CAP_MS` (100 ms), in pausa finché `TextureManager.pendingLoads` > 0 (`persistentWarning`, aiutante puro di `render/frame-inputs.ts`): una texture attesa dentro la catena dello spawn arriva dopo `.light()`, e quel codice giusto non deve consumare l'unico avviso, mentre un caricamento altrove non deve nascondere una texture che manca. Il messaggio nomina fino a tre luci (`untexturedSpriteIds`, `untexturedSpriteMessage`); `lighting-api` espone il flag in `groups`; il JSDoc descrive la sprite e l'idioma «carica prima, poi spawna». Poi, in un secondo commit (Step 7-11, sotto-decisione 4 (c)), il predicato conta come senza texture anche un layer pari o oltre i layer in uso del suo array, presi dal `TextureManager` del renderer (`textureLayerCounts`, `FrameState.textureLayersUsed`) e, per `engine.lighting.groups`, da quello del thread principale: l'avviso, il flag e il gate SDF coprono ogni indice che non nomina una texture caricata da questo renderer.

**Files:** Step 1-6: `ts/src/render/light-groups.ts` (+ test), `render/passes/light-groups-pass.ts` (+ test), `renderer.ts`, `render/frame-inputs.ts` (+ test), `texture-manager.ts` (+ test), `lighting-api.ts` (+ test), `prim-params-schema.ts`, `entity-handle.ts`, `hyperion.ts`; Step 7-11: `light-groups.ts` (+ test), `render/frame-inputs.ts` (+ test), `render/render-pass.ts`, `renderer.ts`, `lighting-api.ts` (+ test), `hyperion.ts` (+ test), `texture-manager.test.ts`, `entity-handle.ts`; le ancore negli step.

**Interfaces:** produce `LightGroups.untexturedSpriteLight: boolean`; `untexturedSpriteIds(groups: Pick<LightGroups, 'lightOrder' | 'lightIds'>, input: LightGroupsInput): number[]` (`light-groups.ts`); `persistentWarning(ms: number): { update(raised: boolean, paused: boolean, now: number): boolean }`, `UNTEXTURED_SPRITE_MS = 1000`, `HELD_STEP_CAP_MS = 100` e `untexturedSpriteMessage(ids: readonly number[]): string` (`render/frame-inputs.ts`); `TextureManager.pendingLoads: number` (un getter); il messaggio dev `untexturedSpriteMessage(…)` (`"[Hyperion] Sprite light 42 has no texture …"`), da `const untexturedSpriteWarning = persistentWarning(UNTEXTURED_SPRITE_MS);`. Negli Step 7-11: `LightGroupsInput.textureLayersUsed?: ArrayLike<number>` e `FrameState.textureLayersUsed?: ArrayLike<number>`, `untexturedPredicate(input: Pick<LightGroupsInput, 'entityCount' | 'texIndices' | 'textureLayersUsed'>): (slot: number) => boolean`, `textureLayerCounts(tm: Pick<TextureManager, 'getLayerCount' | 'getOverflowLayerCount'>, out?: Uint16Array): Uint16Array` (`render/frame-inputs.ts`), il quarto parametro di `LightingAPI._init`, `textureLayersUsed?: () => ArrayLike<number> | undefined`. Consuma `untexturedPredicate`, `SPRITE` e `TEXTURE_LAYER_MASK` del Task 3, `drawn` (`light-groups.ts:218`) e `getLayerCount`/`getOverflowLayerCount` del `TextureManager` (`texture-manager.ts:289`, `:299`).

- [ ] **Step 1: i test che falliscono.** In `light-groups.test.ts`, l'import del Task 3 prende `untexturedSpriteIds,` dopo `TEXTURE_LAYER_MASK,`, e il test di `:376-383` ('renderer.ts warns once, in dev builds, about a shadowed global light') diventa un aiutante più cinque test; l'avviso della sprite non passa da `warnsOnce` (lo fissa la chiamata di `persistentWarning` nel blocco del grafo illuminato), lo sweep sugli 8 tipi prende il caso del §4 del piano del giro (`:152`), una global fuori vista con ombra > 0 non alza il flag, e il test del flag controlla che `untexturedSpriteIds` nomini qualcuno esattamente quando il flag è alzato.
```ts
  /** renderer.ts's one-time dev warning for `flag`, pinned on the text: a guard declared once, before render(). Returns the message. */
  function warnsOnce(flag: string, guard: string): string {
    const renderer = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
    const declaration = `let ${guard} = false;`;
    expect(renderer.split(declaration), `${guard} declared once`).toHaveLength(2);
    expect(renderer.indexOf(declaration), `${guard} declared before render()`).toBeLessThan(renderer.indexOf('render(state: GPURenderState'));
    const block = renderer.slice(renderer.indexOf('frameState.lightGroups = deriveLightGroups(frameState);'));
    const branch = new RegExp(`if \\(dev && frameState\\.lightGroups\\.${flag} && !${guard}\\) \\{\\s*${guard} = true;\\s*console\\.warn\\("([^"]*)"\\);`).exec(block);
    expect(branch, `the ${flag} warning`).not.toBeNull();
    return branch![1];
  }

  it('renderer.ts warns once, in dev builds, about a shadowed global light', () => {
    expect(warnsOnce('shadowedGlobalLight', 'warnedShadowedGlobalLight')).toMatch(/^\[Hyperion\] A global light has shadowIntensity > 0/);
  });

  it('renderer.ts warns once, in dev builds, about a sprite light that stays without a texture for UNTEXTURED_SPRITE_MS of lit time with no texture load in flight, naming it (round step 8)', () => {
    const renderer = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
    const declaration = 'const untexturedSpriteWarning = persistentWarning(UNTEXTURED_SPRITE_MS);';
    expect(renderer.split(declaration), 'declared once').toHaveLength(2);
    expect(renderer.indexOf(declaration), 'declared before render()').toBeLessThan(renderer.indexOf('render(state: GPURenderState'));
    const lit = renderer.slice(renderer.indexOf('frameState.lightGroups = deriveLightGroups(frameState);'), renderer.indexOf('// Dev readback (engine.debug.readTransparentSort'));
    // The message itself: untexturedSpriteMessage (frame-inputs.test.ts).
    expect(lit, "in the lit graph's block: paused while a texture loads, the lights named").toMatch(
      /if \(dev && untexturedSpriteWarning\.update\(frameState\.lightGroups\.untexturedSpriteLight, textureManager\.pendingLoads > 0, performance\.now\(\)\)\) \{\s*console\.warn\(untexturedSpriteMessage\(untexturedSpriteIds\(frameState\.lightGroups, frameState\)\)\);/,
    );
  });

  it('raises untexturedSpriteLight for a listed sprite light at layer 0 (packed index 0 among them), and for no other (round step 8)', () => {
    const raised = (es: E[]): boolean => {
      const s = scene(es);
      const g = deriveLightGroups(s);
      // untexturedSpriteIds names a light exactly when the flag is raised (these scenes carry every column).
      expect(untexturedSpriteIds(g, s).length > 0, JSON.stringify(es)).toBe(g.untexturedSpriteLight);
      return g.untexturedSpriteLight;
    };
    expect(raised([sprite(0, { tex: 0 })])).toBe(true);
    expect(raised([sprite(0, { tex: 0x7ff80000 })]), 'only bits nobody decodes').toBe(true);
    expect(raised([sprite(0, { tex: 0, mask: 0 })]), 'mask 0: listed, still without a cookie').toBe(true);
    expect(raised([sprite(0), sprite(0, { tex: 0 })]), 'one among textured ones').toBe(true);
    expect(raised([sprite(0)])).toBe(false);
    // Layer 0 of any array is reserved: vs_main draws nothing there either.
    expect(raised([sprite(0, { tex: packTextureIndex(0, 0, true) })]), 'overflow tier 0, layer 0').toBe(true);
    expect(raised([sprite(0, { tex: packTextureIndex(1, 0) })]), 'tier 1, layer 0').toBe(true);
    expect(raised([sprite(0, { tex: packTextureIndex(1, 1) })]), 'tier 1, layer 1').toBe(false);
    // The list's members only (the cull's exact test), as LightAccumStage gets them.
    expect(raised([sprite(0, { tex: 0, x: 100 })]), 'out of view').toBe(false);
    expect(raised([sprite(0, { tex: 0, x: 15.02, r: 5 })]), "kept by the grouping's margin only").toBe(false);
    expect(raised([sprite(0, { tex: 0, x: 14.98, r: 5 })]), 'just listed').toBe(true);
    // Without a usable column: never (all or nothing, like the ids).
    const s = scene([sprite(0, { tex: 0 }), sprite(0, { tex: 0 })]);
    for (const texIndices of [undefined, new Uint32Array(0), s.texIndices!.slice(0, 1)]) {
      expect(deriveLightGroups({ ...s, texIndices }).untexturedSpriteLight, `${texIndices?.length ?? 'no'} indices`).toBe(false);
    }
  });

  it('each flag names its own type, over all eight wire values: shadowedGlobalLight a global light, untexturedSpriteLight a sprite light', () => {
    for (let t = 0; t < 8; t++) {
      const g = deriveLightGroups(scene([light(0xffff, 1, { type: t, r: 3.4e38, tex: 0 }), drawable(CAST | RECV)]));
      expect(g.shadowedGlobalLight, `type ${t}`).toBe(t === GLOBAL);
      expect(g.untexturedSpriteLight, `type ${t}`).toBe(t === SPRITE);
    }
    expect(deriveLightGroups(scene([drawable(RECV, 0, { tex: 0 })])).untexturedSpriteLight, 'a drawable at index 0').toBe(false);
    // Out of view, neither flag: the global light's flag too (round plan §4, step 6).
    const away = deriveLightGroups(scene([light(0xffff, 1, { type: GLOBAL, x: 100, r: 5 }), light(0xffff, 1, { type: SPRITE, x: 100, r: 5, tex: 0 }), drawable(CAST | RECV)]));
    expect(away.shadowedGlobalLight, 'a global light out of view').toBe(false);
    expect(away.untexturedSpriteLight, 'a sprite light out of view').toBe(false);
  });

  it('untexturedSpriteIds names the listed sprite lights without a texture by external id, in list order; nobody without both columns (round step 8)', () => {
    // List order is z back to front: slot 1 (z 0.25) before slot 0 (z 0.5).
    const s = scene([
      sprite(0, { tex: 0, id: 42, z: 0.5 }),
      sprite(0, { tex: packTextureIndex(1, 0), id: 7, z: 0.25 }),
      sprite(0, { id: 57 }),
      light(0xffff, 0, { tex: 0, id: 61 }),
      sprite(0, { tex: 0, x: 100, id: 99 }),
    ]);
    const g = deriveLightGroups(s);
    expect(untexturedSpriteIds(g, s), 'ids, not slots; a textured sprite light, a point light at index 0 and an unlisted one named by none').toEqual([7, 42]);
    // A short column names nobody: no ids to name, or no rule.
    expect(untexturedSpriteIds(g, { ...s, entityIds: s.entityIds!.slice(0, 2) })).toEqual([]);
    expect(untexturedSpriteIds(g, { ...s, texIndices: s.texIndices!.slice(0, 2) })).toEqual([]);
  });
```
  (`sprite`, `COOKIE`, `SPRITE`, `packTextureIndex` e il campo `tex` di `E` vengono dal Task 3; `renderer.ts:906` contiene `render(state: GPURenderState`, `:1070` il commento `// Dev readback (engine.debug.readTransparentSort`, la fine del blocco illuminato.)

  In `lighting-api.test.ts`, dopo il test che termina a `:245` (l'ordine per `lightIds`):
```ts

  it('reports a sprite light without a texture (untexturedSpriteLight), from the render state\'s tex-indices column (round step 8)', () => {
    const SPRITE = 4;  // LightType::Sprite, at bits 11-13
    const renderMeta = new Uint32Array([0, (LIGHT | (SPRITE << 11) | (0xffff << 16)) >>> 0]);
    const rs = (texIndices?: Uint32Array) => emptyRenderState({
      entityCount: 1, renderMeta, bounds: new Float32Array([0, 0, 0, 1]), primParams: new Float32Array(8), ...(texIndices ? { texIndices } : {}),
    });
    expect(withState(rs(new Uint32Array([0])), () => view).groups!.untexturedSpriteLight).toBe(true);
    expect(withState(rs(new Uint32Array([(1 << 16) | 1])), () => view).groups!.untexturedSpriteLight).toBe(false);
    // makeRenderState's default column is empty: shorter than entityCount, ignored whole.
    expect(withState(rs(), () => view).groups!.untexturedSpriteLight).toBe(false);
  });
```
  (`LIGHT`, `view` e `withState` sono del `describe` a `:189-192`; `emptyRenderState` è l'import di `:6`.) In `light-groups-pass.test.ts:106`, l'oggetto di `groups()`:
```ts
    layerToGroup: [0, 0], multiBitReceiver: false, shadowedGlobalLight: false, untexturedSpriteLight: false, lightMasks: [], occluderMasks: [],
```
  In `frame-inputs.test.ts`, l'import di `:3-6` prende `persistentWarning, untexturedSpriteMessage, UNTEXTURED_SPRITE_MS, HELD_STEP_CAP_MS,` dopo `overCapacityWarning,`, e in fondo (i vettori, in millisecondi interi, esatti in f64, sono quelli del prototipo del giudice, `d4-judge/proto.mjs`: 9 vettori passano, 6 mutanti muoiono; a 60, 120, 144, 165 e 240 Hz l'avviso cade a 1000,00 ms):
```ts

// Round step 8: the dev warning for a sprite light without a texture fires
// once the flag has held for UNTEXTURED_SPRITE_MS of lit frame time, each
// call adding at most HELD_STEP_CAP_MS; a call with a texture load in flight
// pauses the count (it neither adds nor resets), a call without the flag
// resets it. Whole milliseconds: exact in f64.
describe('persistentWarning', () => {
  type Call = [raised: boolean, paused: boolean, now: number];
  const run = (w: { update(raised: boolean, paused: boolean, now: number): boolean }, calls: Call[]): number[] =>
    calls.flatMap(([raised, paused, now], i) => (w.update(raised, paused, now) ? [i] : []));
  /** `n` calls `stepMs` apart from `start`. */
  const ticks = (stepMs: number, n: number, start = 0, raised = true, paused = false): Call[] =>
    Array.from({ length: n }, (_, i): Call => [raised, paused, start + i * stepMs]);

  it('warns when the flag has held UNTEXTURED_SPRITE_MS (1000 ms), not before', () => {
    expect(UNTEXTURED_SPRITE_MS).toBe(1000);
    expect(HELD_STEP_CAP_MS).toBe(100);
    expect(run(persistentWarning(UNTEXTURED_SPRITE_MS), ticks(8, 125)), '992 ms').toEqual([]);
    expect(run(persistentWarning(UNTEXTURED_SPRITE_MS), ticks(8, 126)), '1000 ms').toEqual([125]);
    expect(run(persistentWarning(UNTEXTURED_SPRITE_MS), ticks(16, 64)), '1008 ms').toEqual([63]);
  });

  it('warns once, never again, whatever follows', () => {
    expect(run(persistentWarning(100), [...ticks(10, 11), [false, false, 110], ...ticks(10, 30, 120)])).toEqual([10]);
  });

  it('a call without the flag resets the count: a texture that lands in time raises nothing', () => {
    expect(run(persistentWarning(100), [...ticks(10, 10), [false, false, 100], ...ticks(10, 10, 110)])).toEqual([]);
  });

  it('a call with a texture load in flight neither adds nor resets, and the paused gap is not bridged', () => {
    expect(run(persistentWarning(100), [...ticks(10, 6), ...ticks(10, 50, 60, true, true), ...ticks(10, 7, 560)])).toEqual([61]);
    expect(run(persistentWarning(100), ticks(10, 500, 0, true, true)), 'a load always in flight').toEqual([]);
  });

  it('one call adds at most HELD_STEP_CAP_MS, and slow frames still warn', () => {
    expect(run(persistentWarning(1000), [[true, false, 0], [true, false, 5000], [true, false, 5008]]), 'a 5-s stall').toEqual([]);
    expect(run(persistentWarning(1000), ticks(250, 11)), '250-ms frames').toEqual([10]);
  });
});

describe('untexturedSpriteMessage', () => {
  it('names up to three sprite lights by id, then how many more; says why the light is dark and what to do', () => {
    expect(untexturedSpriteMessage([42])).toMatch(/^\[Hyperion\] Sprite light 42 has no texture/);
    expect(untexturedSpriteMessage([42, 57])).toMatch(/^\[Hyperion\] Sprite lights 42, 57 have no texture/);
    expect(untexturedSpriteMessage([42, 57, 61, 70, 71])).toMatch(/^\[Hyperion\] Sprite lights 42, 57, 61 and 2 more have no texture/);
    expect(untexturedSpriteMessage([])).toMatch(/^\[Hyperion\] A sprite light has no texture/);
    for (const ids of [[], [42], [42, 57, 61, 70, 71]]) {
      const message = untexturedSpriteMessage(ids);
      expect(message).toContain('no texture load in flight');
      expect(message).toContain('const cookie = await engine.loadTexture(url)');
      expect(message).toMatch(/rejected/);
      expect(message).toMatch(/Mode A/);
    }
  });
});
```
  In `texture-manager.test.ts`, l'import di `:1` diventa `import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";`, e in fondo (i mock di `:627-631` rispondono subito: qui `fetch` aspetta):
```ts

// Round step 8: the renderer's untextured-sprite warning pauses while a
// texture load is in flight (TextureManager.pendingLoads).
describe("pendingLoads", () => {
  afterEach(() => vi.unstubAllGlobals());
  /** A macrotask: every promise chain a settled fetch started has run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("counts a load from its call until its promise settles, resolved or rejected; a cached URL never enters", async () => {
    const replies = new Map<string, { resolve: (response: unknown) => void; reject: (err: Error) => void }>();
    vi.stubGlobal("fetch", vi.fn((url: string) => new Promise((resolve, reject) => { replies.set(url, { resolve, reject }); })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 64, height: 64, close: () => {} })));
    const ok = { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    const tm = new TextureManager(createMockDevice());
    expect(tm.pendingLoads).toBe(0);
    const loads = Array.from({ length: 7 }, (_, k) => tm.loadTexture(`t${k}.png`));
    expect(replies.size, "6 fetches at once").toBe(6);
    expect(tm.pendingLoads, "6 fetching, 1 queued").toBe(7);
    const priority = tm.loadTextureWithPriority("p.png", 1);
    expect(tm.pendingLoads, "and one by priority").toBe(8);
    replies.get("t0.png")!.resolve(ok);
    await loads[0];
    await settle();
    expect(tm.pendingLoads, "a resolved load leaves").toBe(7);
    replies.get("t1.png")!.reject(new Error("offline"));
    await expect(loads[1]).rejects.toThrow("offline");
    await settle();
    expect(tm.pendingLoads, "a rejected load leaves").toBe(6);
    for (const url of ["t2.png", "t3.png", "t4.png", "t5.png", "t6.png", "p.png"]) replies.get(url)!.resolve(ok);
    await Promise.all([...loads.slice(2), priority]);
    await settle();
    expect(tm.pendingLoads).toBe(0);
    await tm.loadTexture("t0.png");
    expect(tm.pendingLoads, "a cached URL never enters").toBe(0);
  });
});
```
- [ ] **Step 2: RED.**
```bash
npx --prefix ts vitest run --root ts src/render/light-groups.test.ts src/lighting-api.test.ts src/render/passes/light-groups-pass.test.ts src/render/frame-inputs.test.ts src/texture-manager.test.ts
```
  Expected: 12 falliti su 164 (`light-groups` 55, `lighting-api` 25, `light-groups-pass` 12, `frame-inputs` 20, `texture-manager` 52): in `light-groups` l'avviso, il flag, lo sweep e `untexturedSpriteIds` ("untexturedSpriteIds is not a function"); il test di `lighting-api`; in `frame-inputs` i 5 di `persistentWarning` e quello del messaggio ("… is not a function"; il primo, "expected undefined to be 1000": `UNTEXTURED_SPRITE_MS` non c'è ancora); in `texture-manager` `pendingLoads`. Quello della global passa già, attraverso `warnsOnce`.
- [ ] **Step 3: il codice.** In `light-groups.ts`, nell'interfaccia `LightGroups`, dopo `shadowedGlobalLight: boolean;` (`:57`):
```ts
  /**
   * A sprite light in the light list has no texture (untexturedPredicate: the
   * layer of its packed index is 0), and light-accum.wgsl draws nothing for
   * it (round step 8). The renderer warns once (dev builds) when it holds for
   * UNTEXTURED_SPRITE_MS of lit time with no texture load in flight. Never
   * raised without a usable `texIndices` column.
   */
  untexturedSpriteLight: boolean;
```
  In `deriveLightGroups`, dopo `let shadowedGlobalLight = false;` (`:207`): `let untexturedSpriteLight = false;`; nel ramo delle luci, subito dopo `const type = (word >>> LIGHT_TYPE_SHIFT) & 7;`:
```ts
      // Listed only, as LightAccumStage gets the lights: the renderer's warning.
      if (drawn && type === SPRITE && untextured(i)) untexturedSpriteLight = true;
```
  e nel `return`, dopo `shadowedGlobalLight,`: `untexturedSpriteLight,`. In fondo a `light-groups.ts`, dopo la chiusura di `deriveLightGroups`:
```ts

/**
 * The external ids of the listed sprite lights without a texture
 * (untexturedPredicate), in list order: the ones the renderer's dev warning
 * names (round step 8). Empty unless `entityIds` covers `entityCount` (a slot
 * is no id to name) and `texIndices` does (no rule without it).
 */
export function untexturedSpriteIds(groups: Pick<LightGroups, 'lightOrder' | 'lightIds'>, input: LightGroupsInput): number[] {
  if (input.entityIds === undefined || input.entityIds.length < input.entityCount) return [];
  const untextured = untexturedPredicate(input);
  const ids: number[] = [];
  for (let j = 0; j < groups.lightOrder.length; j++) {
    const slot = groups.lightOrder[j];
    if (((input.renderMeta[slot * 2 + 1] >>> LIGHT_TYPE_SHIFT) & 7) === SPRITE && untextured(slot)) ids.push(groups.lightIds[j]);
  }
  return ids;
}
```
  In `light-groups-pass.ts`, in `EVERYTHING`, dopo `shadowedGlobalLight: false,` (`:20`): `untexturedSpriteLight: false,`. In `texture-manager.ts`, dopo il getter `pendingPriorityCount` (`:602-604`):
```ts

  /**
   * Loads in flight (round step 8): fetching, or queued, plain or by
   * priority. A load counts from its `loadTexture`/`loadTextureWithPriority`
   * call until its promise has settled, resolved or rejected; a cached URL
   * never counts. The renderer's untextured-sprite warning pauses while this
   * is above 0. Not `total - loaded`: a rejected load never raises `loaded`.
   */
  get pendingLoads(): number {
    return this.activeFetches + this.fetchQueue.length + this.priorityQueue.size;
  }
```
  In fondo a `render/frame-inputs.ts`:
```ts

/**
 * Lit frame time, in ms, a sprite light must stay without a texture, with no
 * texture load in flight, before the renderer's dev warning (round step 8): a
 * texture awaited inside the spawn chain lands after `.light()`, and that is
 * no mistake.
 */
export const UNTEXTURED_SPRITE_MS = 1000;

/** The most one frame adds to that time: a stall or a hidden tab does not age it. */
export const HELD_STEP_CAP_MS = 100;

/**
 * A once-only warning for a condition that must HOLD for `ms` of frame time.
 * `update(raised, paused, now)` (`now` in ms, from performance.now(): Mode A's
 * render worker gets no frame dt) is true exactly once, when the time the
 * flag has held reaches `ms`. A call adds the time since the previous counted
 * call, at most HELD_STEP_CAP_MS; a call without the flag resets the count; a
 * paused call (a texture load in flight) neither adds nor resets, and the
 * next counted call does not bridge the pause.
 */
export function persistentWarning(ms: number): { update(raised: boolean, paused: boolean, now: number): boolean } {
  let held = 0;
  let last = NaN;
  let warned = false;
  return {
    update(raised: boolean, paused: boolean, now: number): boolean {
      if (warned) return false;
      if (paused) {
        last = NaN;
        return false;
      }
      if (!raised) {
        held = 0;
        last = NaN;
        return false;
      }
      if (!Number.isNaN(last)) held += Math.min(Math.max(now - last, 0), HELD_STEP_CAP_MS);
      last = now;
      if (held < ms) return false;
      warned = true;
      return true;
    },
  };
}

/**
 * The dev warning for listed sprite lights without a texture: up to three
 * external ids (`untexturedSpriteIds`; none when the render state has no id
 * column), why the light is dark and what to do.
 */
export function untexturedSpriteMessage(ids: readonly number[]): string {
  const who = ids.length === 0 ? 'A sprite light has'
    : ids.length === 1 ? `Sprite light ${ids[0]} has`
    : `Sprite lights ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ` and ${ids.length - 3} more` : ''} have`;
  return `[Hyperion] ${who} no texture (layer 0 of its packed index: index 0, or a reserved layer) after a second of lit frames `
    + "with no texture load in flight: a sprite light's cookie is its shape, so it lights nothing until it has one. "
    + 'Load the texture first (const cookie = await engine.loadTexture(url)) and set .texture(cookie) with .light(); '
    + 'a loadTexture that rejected leaves it without one, and in Mode A textures do not load (no main-thread renderer).';
}
```
  In `renderer.ts`, l'import di `./render/light-groups` (`:42`) diventa `import { deriveLightGroups, untexturedSpriteIds } from './render/light-groups';`, l'import di `./render/frame-inputs` (`:60-62`) prende `  persistentWarning, untexturedSpriteMessage, UNTEXTURED_SPRITE_MS,` dopo la riga di `overCapacityWarning`; dopo `let warnedShadowedGlobalLight = false;` (`:544`):
```ts
  // Round step 8: once per renderer, dev builds, after UNTEXTURED_SPRITE_MS
  // of lit time with no texture load in flight: a load in flight pauses the
  // count, so a texture still loading is no fault and loads elsewhere do not
  // hide a missing one.
  const untexturedSpriteWarning = persistentWarning(UNTEXTURED_SPRITE_MS);
```
  e dopo il ramo dell'avviso della global (`:1064-1067`), dentro `if (host.mode.lighting) {` (fuori il flag non esiste, e un frame non illuminato non conta; `textureManager` è quello di `:284`, che `render()` già chiude):
```ts
        if (dev && untexturedSpriteWarning.update(frameState.lightGroups.untexturedSpriteLight, textureManager.pendingLoads > 0, performance.now())) {
          console.warn(untexturedSpriteMessage(untexturedSpriteIds(frameState.lightGroups, frameState)));
        }
```
- [ ] **Step 4: il JSDoc.** In `lighting-api.ts`, nel doc di `groups`, dopo il paragrafo su `shadowedGlobalLight` (`:125-127`):
```ts
   *
   * And `untexturedSpriteLight` (round step 8): a sprite light in the light
   * list has no texture (layer 0 of its packed index), so it lights nothing
   * until it has one. The flag is readable in every build; only the warning
   * is dev-only: the renderer warns once, when the flag has held for a second
   * of lit frames with no texture load in flight. Await the texture before
   * spawning, `const cookie = await engine.loadTexture(url)`. Textures do not
   * load in Mode A.
```
  In `prim-params-schema.ts`, `:62-66` (da "`range` (slot 3) is the single source" a "backend)."):
```ts
  // frees slot 7 for `shadowIntensity`. `range` (slot 3) is the single source
  // of truth for a point, spot or sprite light's culling radius (a sprite
  // light's: range·√2, the half-diagonal of its square of half-side range); on
  // a directional light it is the length of its shadows (global and
  // directional lights are never culled). `shadowIntensity` is ignored on a
  // global light (lit backend). A sprite light ignores `innerCos`, `outerCos`
  // and `falloff`: its cookie, the entity's texture, is its shape.
```
  e prima di `[RenderPrimitiveType.SDFGlyph]: {` (`:44`), per la convenzione che il passo 8 lascia a msdf:
```ts
  // An MSDF glyph samples its atlas raw: the rect is in texture coordinates
  // (u from the left, v from the image's top row), and msdf_vs mixes it along
  // the glyph's local axes, so atlasV0 is the v at the glyph's bottom edge
  // (local −y) and atlasV1 the v at its top (round step 8 left msdf out of
  // the upright image rule of sampleTierOrWhite).
```
  In `entity-handle.ts`: `:59` (`* - \`sprite\`: not drawn yet.`) diventa:
```ts
 * - `sprite`: a cookie light (round step 8). It lights the square of side
 *   2·`range` around its position, turned with its axis (below), in the
 *   shape and colours of its cookie: the entity's texture. Await the handle
 *   before spawning, `const cookie = await engine.loadTexture(url);
 *   engine.spawn({ mode: '2d' }).texture(cookie).light({ type: 'sprite', … })`
 *   (`.texture()` and `.light()` in either order, in the same turn): the
 *   light lights nothing until its texture lands, so an `await` inside the
 *   chain leaves it dark for the frames the load takes. A texel lights
 *   `color` × `energy` × its rgb × its alpha (`add`, `sub`); a `mix` sprite
 *   light moves the buffer toward `color` × `energy` × rgb by that alpha. No
 *   falloff and no cone (`falloff`, `innerAngle` and `outerAngle` are
 *   ignored): bake a falloff into the cookie's alpha. The image lies on the
 *   square upright, as on a textured quad: its first row along the light's
 *   local +y edge, its first column along −x; a negative y-scale mirrors it
 *   top to bottom, a negative x-scale left to right, both a half turn. Use a
 *   square PNG or JPEG: it is stretched to its tier's square (64, 128, 256
 *   or 512 px), and a smaller image is upscaled and blurred. A KTX2 cookie is
 *   not resized: it must be square, exactly its tier's size and stored top
 *   row first (orientation 'rd': `KTXorientation` is not read); a smaller
 *   one fills only the corner at the light's local (−x, +y), a larger one
 *   fails to upload. Keep a
 *   transparent border of a few texels (the square's edge is not
 *   anti-aliased in the half-resolution light buffer), and give fully
 *   transparent texels the colour of their opaque neighbours (rgb and alpha
 *   are filtered apart). Texels hold straight alpha and are sampled
 *   bilinearly at full resolution only: a cookie with more texels across
 *   than its square spans in the light buffer (half the canvas) is
 *   undersampled, and fine detail shimmers as the light moves or turns. With
 *   `shadowIntensity` > 0 it casts shadows from its centre, like a point
 *   light of its range, whatever the cookie. Its culling radius is the
 *   square's half-diagonal, `range`·√2. Layer 0 of a packed index never
 *   holds a texture (index 0, the default, and the layer every tier array
 *   reserves): a sprite light there lights nothing, and the renderer warns
 *   once in dev builds when one stays so for a second of lit frames with no
 *   texture load in flight. Any other index samples what its layer holds on
 *   this renderer: a layer never loaded holds zeroes (no light in an rgba8
 *   or BC7 array; ASTC decodes them to its error colour, opaque magenta or
 *   NaN) and a layer past the end of its array is discarded, both without a
 *   warning, while a layer loaded with another texture lights that one.
 *   Handles are valid only in the session that loaded them: a tape or a
 *   snapshot recorded elsewhere names layers this page may hold differently.
 *   In Mode A textures do not load (`loadTexture` throws) and the render
 *   worker's arrays hold one layer, so every sprite light lights nothing
 *   there.
```
  `:61-67`:
```ts
 * The axis of a spot, directional or sprite light is its local +x in world
 * space: a spot or a sun shines TOWARD it, and a sprite light's square turns
 * with it. `rotation(angle)` aims it. 0 shines right,
 * `rotation(-Math.PI / 2)` shines down the screen (the world is y-up), and
 * `rotation(Math.atan2(dy, dx))` shines along (dx, dy). A parent's rotation
 * and mirror compose into it (the world transform decides: a rig flipped
 * with `scale(-1, 1)` mirrors its lights with it), and a negative x-scale
 * mirrors it in its own frame (a spot or a sun then shines along its −x; a
 * sprite light's cookie is mirrored left to right, by a negative y-scale top
 * to bottom, and turned half a turn by both); the size of the scale is
 * ignored, because a light's extent is its range. An x-scale of 0 aims it
 * along world +x.
```
  `:73-76` (in `LightBlendMode`):
```ts
 * starts at the ambient light (`engine.lighting.setAmbient()`). With `c` the
 * light's `color` × `energy` (a sprite light's also × its cookie's rgb at the
 * pixel) and `w` its intensity at a pixel (the attenuation
 * (1 − d/range)^falloff × spot cone × shadow, from 0 to 1; the shadow alone
 * for a directional light, the cookie's alpha × shadow for a sprite light, 1
 * for a global light):
```
  in `range`, la voce `point`, `spot` (`:142-144`) diventa, seguita dalla voce nuova della sprite:
```ts
   * - `point`, `spot`: the light's radius, which is also its culling radius:
   *   a light whose z is more than `range` outside the camera's near-far span
   *   lights nothing (see {@link EntityHandle.light}). 0 or less: the light
   *   lights nothing and casts no shadow (no SDF flood).
   * - `sprite`: half the side of its square. Its culling radius is the
   *   square's half-diagonal, `range`·√2 (at most the largest f32): a sprite
   *   light whose z is more than that outside the near-far span lights
   *   nothing.
```
  `shadowIntensity` (`:169-171`):
```ts
   * Shadow strength: 0 = none (default), 1 = fully opaque. Point, spot,
   * directional and sprite lights (a sprite light casts from its centre);
   * ignored on a global light in the lit backend (a dev warning, once). See
   * {@link EntityHandle.shadows}.
```
  `:357` (in `rotation`):
```ts
   * On a spot or directional light it aims the light, on a sprite light it
   * turns its square and its cookie (see {@link LightType}).
```
  `:391-393` (in `depth`, from "{@link LightBlendMode}); a point or spot light whose world depth (its own," to "1000 + range (the default camera) is culled and lights nothing. On a 3D"):
```ts
   * {@link LightBlendMode}); a point, spot or sprite light whose world depth
   * (its own, composed with its parents' for a child) is outside −1 − range to
   * 1000 + range (the default camera; range·√2 for a sprite light) is culled
   * and lights nothing. On a 3D
```
  `:424` (`/** Set entity texture layer. Returns \`this\` for chaining. */`):
```ts
  /**
   * Set the entity's texture: a handle from `engine.loadTexture()`. A quad or
   * a bezier shows the image upright in its local frame (round step 8): its
   * first row along local +y, its first column along local −x; a line shows
   * it as a quad turned along start→end, its first row on the left of the
   * direction. An MSDF glyph takes its atlas rect instead (`atlasU0`…`atlasV1`,
   * see `PRIM_PARAMS_SCHEMA`). On a sprite light it is the cookie, the light's
   * shape: await the handle before the spawn chain, not inside it (see
   * {@link LightType}). Returns `this` for chaining.
   */
```
  nel doc di `light()`, `:634-637` (da "snapshot and replay for free" a "(see {@link LightType})."):
```ts
   * snapshot and replay for free — which is why a point, spot or sprite
   * light's `range` also drives its culling radius (a sprite light's is
   * `range`·√2) rather than needing a separate call (global and directional
   * lights light the whole view and are never culled). Aim a spot or a sun,
   * and turn a sprite light, with `rotation()`. A sprite light takes its shape
   * from its texture, `.texture(cookie)` in the same turn as this call, either
   * order, with the handle awaited before the chain (`const cookie = await
   * engine.loadTexture(url)`), and lights nothing until it has one (see
   * {@link LightType}).
```
  `:644-649` (da "`position()`, a child's its world z. Like any entity" a "lights are never culled."):
```ts
   * `position()`, a child's its world z. Like any entity, a point, spot or
   * sprite light is culled, and lights nothing, when that world z is more than
   * its culling radius (`range`; `range`·√2 for a sprite light) outside the
   * camera's near-far span: with the default camera a 2D point or spot light's
   * world depth must stay within [−1 − range, 1000 + range], a 3D one's world
   * z within [−1000 − range, 1 + range]. Global and directional lights are
   * never culled.
```
  e in `shadows()`, `:699-700` (da "Point, spot and directional lights" a "A shadowed directional light marches"):
```ts
   * Point, spot, directional and sprite lights (a sprite light casts from its
   * centre, like a point light of its range, whatever its cookie; a sun's
   * shadows are `range` world units long, see {@link LightType}). A light
   * that cannot draw (range 0 or less; a sprite light without a texture)
   * casts nothing and costs no shadow pass. A shadowed directional light
   * marches
```
  In `hyperion.ts`, il doc di `loadTexture` (`:514-518`):
```ts
  /**
   * Load a single texture from a URL (`blob:` and `data:` URLs too). Returns a
   * packed TextureHandle (overflow << 31 | tier << 16 | layer) for
   * `entity.texture(handle)`: a quad's image, a sprite light's cookie, shown
   * upright (the image keeps its row order: nothing is flipped at upload;
   * see `EntityHandle.texture`). A PNG
   * or JPEG is resized to the square of the smallest tier that holds its
   * larger side (64, 128, 256 or 512 px; a larger image to 512) and, on a
   * device with a compressed format (BC7/ASTC), goes to the rgba8 overflow
   * tiers. The URL is the cache key: loading it again returns the same
   * handle, valid in this session only. Await it before the spawn chain that
   * uses it (see `LightType`'s `sprite`). Throws if no renderer is available:
   * in Mode A (the render worker loads no textures) and without WebGPU, where
   * a sprite light therefore lights nothing. Throws too when the target array
   * of that tier (primary, or the rgba8 overflow array on a device with a
   * compressed format) already holds 255 textures (256 layers, layer 0
   * reserved).
   */
```
  e in `loadTextures` "is invoked after each texture finishes loading." (`:528`) → "is invoked after each texture finishes loading. Throws like `loadTexture`.".
- [ ] **Step 5: GREEN.** Il comando dello Step 2: 164/164; `npm --prefix ts test` (115 file, 2167 + 7 saltati); `tsc` pulito.
- [ ] **Step 5b: la prova che i test mordono** (una mutazione alla volta; ciascuna fa fallire almeno un test): il flag su `inView(i)` invece di `drawn`; il flag senza `type === SPRITE`; `} else {` al posto di `} else if (type === GLOBAL) {`; `persistentWarning` senza `if (warned) return false;`; una chiamata senza il flag che tiene `held` (`if (!raised) { last = NaN; return false; }`); una pausa che tiene `last` (`if (paused) return false;`: il buco si colma); senza il tetto (`held += Math.max(now - last, 0);`); il renderer che ignora i caricamenti (`untexturedSpriteWarning.update(frameState.lightGroups.untexturedSpriteLight, false, performance.now())`); la forma che azzera, `untexturedSpriteWarning.update(frameState.lightGroups.untexturedSpriteLight && !(textureManager.pendingLoads > 0), false, performance.now())`; `!(textureManager.pendingLoads > 0) &&` davanti a `untexturedSpriteWarning.update(…)` (nessuna chiamata durante un caricamento: né somma né azzera, ma tiene `last` e colma fino al tetto il buco della pausa; lo vede solo il testo); senza `dev &&`; `pendingLoads` senza `this.activeFetches`; `pendingLoads` come `this.total - this.loaded` (lo uccide il caricamento rifiutato); `untexturedSpriteIds` che prende `groups.lightOrder[j]` al posto di `groups.lightIds[j]`; il flag della global alzato prima del test di vista (`if (((word >>> LIGHT_TYPE_SHIFT) & 7) === GLOBAL && primParams[i * 8 + 7] > 0) shadowedGlobalLight = true;` sopra `if (!drawn && !inView(i)) continue;`). Poi il codice di nuovo, e il verde.
- [ ] **Step 6: commit**
```bash
git add ts/src/render/light-groups.ts ts/src/render/light-groups.test.ts ts/src/render/passes/light-groups-pass.ts ts/src/render/passes/light-groups-pass.test.ts ts/src/renderer.ts ts/src/render/frame-inputs.ts ts/src/render/frame-inputs.test.ts ts/src/texture-manager.ts ts/src/texture-manager.test.ts ts/src/lighting-api.ts ts/src/lighting-api.test.ts ts/src/prim-params-schema.ts ts/src/entity-handle.ts ts/src/hyperion.ts
git commit -m "feat(8): avviso dev per una luce sprite senza texture (untexturedSpriteLight, dopo un secondo senza caricamenti in corso, con gli id) e JSDoc della luce sprite" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
- [ ] **Step 7: i layer in uso, i test che falliscono** (sotto-decisione 4 (c), il secondo commit del task). Un indice al layer 1 o oltre, ma oltre i layer in uso del suo array (una handle di un'altra sessione, di un tape, di uno snapshot, o la Mode A), oggi non avvisa, e ombreggiato apre un flood che nessuno legge. Il `TextureManager` del renderer sa quanti layer ha in uso ogni array (`getLayerCount`/`getOverflowLayerCount`, `texture-manager.ts:289`, `:299`), e ogni handle che consegna nomina un layer sotto quel conto (`:704`/`:719`, `:730`/`:748`, `:782`/`:796`, `:818`/`:840`): un conto dei layer IN USO non segna mai un cookie caricato (quello dei layer allocati sì: un segnaposto ne riporta 0 con una vista di un layer). Il modello del giudice (`sd4-judge-model/model.mjs`, 336 celle: 2 modi × 3 device × 56 indici) dà 264 celle buie senza avviso con la regola del layer 0 e 0 con questa; il ramo di default dei tier ne segna 4 dove la GPU disegna (il colore d'errore dell'ASTC, ora con l'avviso), mentre «tier > 3 senza texture» ne segnerebbe 14, 10 delle quali texture vere.
  **`light-groups.test.ts`**, dopo il test di `untexturedSpriteIds` (Step 1):
```ts

  it("with the texture arrays' used layers, a sprite light whose cookie names a layer at or past its array's count is untextured too: the flag, no SDF set, still listed (round step 8, sub-decision 4 (c))", () => {
    // Used layers: primary tiers 0-3, then overflow 0-3, the reserved layer 0 included.
    const used = Uint16Array.from([1, 4, 0, 0, 3, 0, 0, 0]);
    // null, not undefined, for no counts: an undefined argument takes the default.
    const run = (tex: number, counts: ArrayLike<number> | null = used) => {
      const g = deriveLightGroups({ ...scene([sprite(1, { tex }), drawable(CAST | RECV)]), textureLayersUsed: counts ?? undefined });
      return { flag: g.untexturedSpriteLight, sets: g.sdfSets.length, listed: [...g.lightOrder] };
    };
    // Below its array's count: a texture this renderer loaded.
    expect(run(packTextureIndex(1, 3)), 'primary tier 1, layer 3 of 4').toEqual({ flag: false, sets: 1, listed: [0] });
    expect(run(packTextureIndex(0, 2, true)), 'overflow tier 0: entry 4').toEqual({ flag: false, sets: 1, listed: [0] });
    // At or past it: untextured, still listed (vs_main keeps its square; fs_main discards past the array).
    for (const tex of [packTextureIndex(1, 4), packTextureIndex(1, 9), packTextureIndex(0, 3, true), packTextureIndex(2, 1), packTextureIndex(0, 1)]) {
      expect(run(tex), `0x${(tex >>> 0).toString(16)}`).toEqual({ flag: true, sets: 0, listed: [0] });
    }
    // The primary and the overflow entries apart: overflow tier 1 holds nothing.
    expect(run(packTextureIndex(1, 3, true)).flag, 'overflow tier 1: entry 5').toBe(true);
    // A tier past 3 samples tier 0's array (sampleTier's default arm): it reads tier 0's count.
    expect(run(packTextureIndex(5, 3), Uint16Array.from([4, 0, 0, 0, 0, 0, 0, 0])).flag, 'tier 5, layer 3 below 4').toBe(false);
    expect(run(packTextureIndex(5, 3), Uint16Array.from([3, 4, 4, 4, 4, 4, 4, 4])).flag, 'tier 5, layer 3 at 3').toBe(true);
    // Without the counts, or a short list: layer 0 alone.
    for (const counts of [null, Uint16Array.from([1, 4, 0, 0])]) {
      expect(run(packTextureIndex(1, 9), counts).flag, `${counts?.length ?? 'no'} counts`).toBe(false);
      expect(run(packTextureIndex(1, 0), counts).flag, `${counts?.length ?? 'no'} counts, layer 0`).toBe(true);
    }
  });

  it("renderer.ts hands deriveLightGroups the texture arrays' used layers, refreshed in every frame's FrameState (round step 8)", () => {
    const renderer = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
    const declaration = 'const textureLayersUsed = new Uint16Array(8);';
    expect(renderer.split(declaration), 'one buffer, declared once').toHaveLength(2);
    expect(renderer.indexOf(declaration), 'declared before render()').toBeLessThan(renderer.indexOf('render(state: GPURenderState'));
    const literal = renderer.slice(renderer.indexOf('const frameState: FrameState = {'), renderer.indexOf('frameState.lightGroups = deriveLightGroups(frameState);'));
    expect(literal).toMatch(/textureLayersUsed: textureLayerCounts\(textureManager, textureLayersUsed\),/);
  });
```
  **`frame-inputs.test.ts`**: l'import prende `textureLayerCounts,` dopo `HELD_STEP_CAP_MS,`; nel `describe('untexturedSpriteMessage'` dello Step 1, prima della sua chiusura:
```ts

  it('says what counts as no texture since the used layers count (sub-decision 4 (c)): an index this renderer did not load', () => {
    for (const ids of [[], [42]]) {
      const message = untexturedSpriteMessage(ids);
      expect(message).toContain('no texture this renderer loaded (index 0, the reserved layer 0, or a handle from another session, a tape, a snapshot or Mode A)');
      expect(message).toContain('a handle is valid only in the session that loaded it');
    }
  });
```
  e in fondo al file:
```ts

// Round step 8 (sub-decision 4 (c)): the used layers of the eight texture
// arrays, in the order deriveLightGroups reads them.
describe('textureLayerCounts', () => {
  it('lists the used layers of primary tiers 0-3, then overflow 0-3, into `out` when given one', () => {
    const tm = { getLayerCount: (t: number) => 10 + t, getOverflowLayerCount: (t: number) => 20 + t };
    expect([...textureLayerCounts(tm)]).toEqual([10, 11, 12, 13, 20, 21, 22, 23]);
    const out = new Uint16Array(8);
    expect(textureLayerCounts(tm, out)).toBe(out);
    expect([...out]).toEqual([10, 11, 12, 13, 20, 21, 22, 23]);
  });
});
```
  **`lighting-api.test.ts`**: `withState` (`:192-199`) prende un terzo parametro e lo passa a `_init`:
```ts
  function withState(rs: GPURenderState | null, viewProjection?: () => Float32Array, textureLayersUsed?: () => ArrayLike<number> | undefined) {
    const sab = new SharedArrayBuffer(HEADER + 4096);
    const producer = new BackpressuredProducer(new RingBufferProducer(sab));
    const bridge = { get latestRenderState() { return rs; } } as unknown as EngineBridge;
    const api = new LightingAPI();
    api._init(producer, bridge, viewProjection, textureLayersUsed);
    return api;
  }
```
  e dopo il test dello Step 1 ('reports a sprite light without a texture …'):
```ts

  it("passes the renderer's texture counts on (the 4th accessor): a sprite light past its array's used layers is untextured (round step 8)", () => {
    const SPRITE = 4;
    const renderMeta = new Uint32Array([0, (LIGHT | (SPRITE << 11) | (0xffff << 16)) >>> 0]);
    const rs = emptyRenderState({
      entityCount: 1, renderMeta, bounds: new Float32Array([0, 0, 0, 1]), primParams: new Float32Array(8),
      texIndices: new Uint32Array([(1 << 16) | 3]),  // primary tier 1, layer 3
    });
    const counts = (tier1: number) => () => Uint16Array.from([1, tier1, 0, 0, 0, 0, 0, 0]);
    expect(withState(rs, () => view, counts(4)).groups!.untexturedSpriteLight, 'layer 3 below the 4 in use').toBe(false);
    expect(withState(rs, () => view, counts(3)).groups!.untexturedSpriteLight, 'layer 3 at the count').toBe(true);
    expect(withState(rs, () => view).groups!.untexturedSpriteLight, 'no accessor (Mode A): layer 0 alone').toBe(false);
  });
```
  **`hyperion.test.ts`**, in fondo al `describe('Hyperion lighting quality'` (`:875-939`), prima della sua chiusura:
```ts

  it("engine.lighting.groups reads the main-thread renderer's texture counts: a sprite light at or past its array's used layers is untextured (round step 8)", () => {
    const SPRITE_LIGHT = (6 | (4 << 11) | (0xffff << 16)) >>> 0;  // Light2D, LightType::Sprite, every layer
    const state = makeRenderState({
      entityCount: 1, renderMeta: new Uint32Array([0, SPRITE_LIGHT]), bounds: new Float32Array([0, 0, 0, 1]),
      primParams: new Float32Array(8), texIndices: new Uint32Array([(1 << 16) | 3]),  // primary tier 1, layer 3
    });
    const bridgeWith = (): EngineBridge => {
      const bridge = mockBridge();
      Object.defineProperty(bridge, 'latestRenderState', { get: () => state });
      return bridge;
    };
    const used = [1, 4, 0, 0, 0, 0, 0, 0];
    const renderer = mockRenderer();
    Object.assign(renderer.textureManager, { getLayerCount: (t: number) => used[t], getOverflowLayerCount: (t: number) => used[4 + t] });
    const engine = Hyperion.fromParts(defaultConfig(), bridgeWith(), renderer);
    engine.cam.setOrthographic(20, 20);
    expect(engine.lighting.groups!.untexturedSpriteLight, 'layer 3 below the 4 in use').toBe(false);
    used[1] = 3;
    expect(engine.lighting.groups!.untexturedSpriteLight, 'layer 3 at the count').toBe(true);
    const modeA = Hyperion.fromParts(defaultConfig(), bridgeWith(), null);
    modeA.cam.setOrthographic(20, 20);
    expect(modeA.lighting.groups!.untexturedSpriteLight, 'no renderer on this thread: layer 0 alone').toBe(false);
    engine.destroy();
    modeA.destroy();
  });
```
  **`texture-manager.test.ts`**, in fondo al file (passano già: fissano quello su cui la regola conta, e muoiono se il layer 0 smette di essere riservato):
```ts

// Round step 8 (sub-decision 4 (c)): every handle names a layer below its
// array's used count (getLayerCount / getOverflowLayerCount), and layer 0 is
// reserved. light-groups.ts untexturedPredicate counts a sprite light at or
// past that count as untextured: it must never flag a handle this manager gave.
describe("every handle names a layer below its array's used count, layer 0 reserved", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([null, "bc7-rgba-unorm", "astc-4x4-unorm"] as const)("PNG, compressedFormat %s: layers 1 then 2, in the overflow array exactly on a compressed device", async (format) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 64, height: 64, close: () => {} })));
    const tm = new TextureManager(createMockDevice(), { compressedFormat: format });
    for (const [url, want] of [["a.png", 1], ["b.png", 2]] as const) {
      const { tier, layer, overflow } = unpackTextureIndex(await tm.loadTexture(url));
      expect({ tier, layer, overflow }, url).toEqual({ tier: 0, layer: want, overflow: format !== null });
      expect(overflow ? tm.getOverflowLayerCount(tier) : tm.getLayerCount(tier), url).toBeGreaterThan(layer);
    }
  });

  it("KTX2 uploaded as stored on a BC7 device (vkFormat 145, no supercompression): the primary tier, layer 1", async () => {
    // The fixture of 'rejects direct-upload KTX2 with mismatched vkFormat', with BC7_UNORM_BLOCK.
    const headerSize = 80;
    const buf = new ArrayBuffer(headerSize + 24 + 64);
    const view = new DataView(buf);
    new Uint8Array(buf).set(KTX2_MAGIC, 0);
    view.setUint32(12, 145, true);
    view.setUint32(20, 64, true);
    view.setUint32(24, 64, true);
    view.setUint32(40, 1, true);
    view.setUint32(44, 0, true);
    view.setBigUint64(headerSize, BigInt(headerSize + 24), true);
    view.setBigUint64(headerSize + 8, BigInt(64), true);
    view.setBigUint64(headerSize + 16, BigInt(64), true);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => buf })));
    const tm = new TextureManager(createMockDevice(), { compressedFormat: "bc7-rgba-unorm" });
    const { tier, layer, overflow } = unpackTextureIndex(await tm.loadTexture("cookie.ktx2"));
    expect({ tier, layer, overflow }).toEqual({ tier: 0, layer: 1, overflow: false });
    expect(tm.getLayerCount(tier)).toBeGreaterThan(layer);
  });
});
```
- [ ] **Step 8: RED.**
```bash
npx --prefix ts vitest run --root ts src/render/light-groups.test.ts src/render/frame-inputs.test.ts src/lighting-api.test.ts src/hyperion.test.ts src/texture-manager.test.ts
```
  Expected: 6 falliti su 270 (`light-groups` 57, `frame-inputs` 22, `lighting-api` 26, `hyperion` 109, `texture-manager` 56): in `light-groups` quello dei conti e quello del testo di `renderer.ts`; in `frame-inputs` il messaggio e `textureLayerCounts` ("textureLayerCounts is not a function"); quello di `lighting-api`; quello di `hyperion`. I 4 del pin di `texture-manager` passano già.
- [ ] **Step 9: il codice.** In `light-groups.ts`, in `LightGroupsInput`, dopo `texIndices?: Uint32Array;` (Task 3):
```ts
  /**
   * The layers in use of each texture array (round step 8, sub-decision 4
   * (c)): primary tiers 0-3, then overflow tiers 0-3, the reserved layer 0
   * included, 0 for an array never allocated (`textureLayerCounts`). A sprite
   * light whose cookie's layer is at or past its array's count names no
   * texture this renderer loaded: untextured, like layer 0. A tier past 3
   * reads tier 0's count, as sampleTier's default arm samples tier 0. Absent,
   * or shorter than 8 (Mode A's main thread, tests): layer 0 alone is
   * untextured.
   */
  textureLayersUsed?: ArrayLike<number>;
```
  `untexturedPredicate` (Task 3) diventa, doc compreso:
```ts
/**
 * The one rule for a sprite light without a texture this renderer loaded
 * (round step 8): the SDF gate, `untexturedSpriteLight` and
 * `untexturedSpriteIds` all ask it. Untextured: the layer of the slot's
 * packed index is 0 (TEXTURE_LAYER_MASK), which light-accum.wgsl's vs_main
 * draws nothing for; or, when `textureLayersUsed` is given, a layer at or
 * past the layers its array has in use (a handle from another session, a
 * tape, a snapshot or Mode A: fs_main discards a layer past the array, and a
 * layer the array allocated but never loaded holds zeroes). Every handle this
 * renderer's TextureManager gave names a layer below its array's count, so the
 * rule never flags a loaded cookie. The tier maps as sampleTier's arms do: a
 * tier past 3 takes the default arm, tier 0 (never "a tier past 3 is
 * untextured"). All or nothing, like the ids: without a usable `texIndices`
 * column (shorter than `entityCount`, or none) no slot is untextured, since a
 * flood too many costs time where one too few would cost shadows.
 */
export function untexturedPredicate(input: Pick<LightGroupsInput, 'entityCount' | 'texIndices' | 'textureLayersUsed'>): (slot: number) => boolean {
  const tex = input.texIndices !== undefined && input.texIndices.length >= input.entityCount ? input.texIndices : null;
  const used = input.textureLayersUsed !== undefined && input.textureLayersUsed.length >= 8 ? input.textureLayersUsed : null;
  return (slot) => {
    if (tex === null) return false;
    const packed = tex[slot];
    const layer = packed & TEXTURE_LAYER_MASK;
    if (layer === 0) return true;
    if (used === null) return false;
    const tier = (packed >>> 16) & 7;
    return layer >= used[(packed >>> 31) * 4 + (tier < 4 ? tier : 0)];
  };
}
```
  e il doc di `LightGroups.untexturedSpriteLight` (Step 3):
```ts
  /**
   * A sprite light in the light list has no texture this renderer loaded
   * (untexturedPredicate: layer 0, or a layer at or past its array's used
   * count when `textureLayersUsed` is given), so it lights nothing (round
   * step 8; on an ASTC device a layer its array allocated but never loaded
   * shows the error colour instead). The renderer warns once (dev builds)
   * when it holds for UNTEXTURED_SPRITE_MS of lit time with no texture load
   * in flight. Never raised without a usable `texIndices` column.
   */
```
  In `render/render-pass.ts`, in `FrameState`, dopo `texIndices: Uint32Array;     // 1 u32/entity` (`:6`):
```ts
  /**
   * The used layers of the eight texture arrays, primary tiers 0-3 then
   * overflow 0-3 (`textureLayerCounts`, round step 8): `deriveLightGroups`
   * counts a sprite light whose cookie names a layer at or past its array's
   * count as untextured. Absent: layer 0 alone is.
   */
  textureLayersUsed?: ArrayLike<number>;
```
  In `render/frame-inputs.ts`, dopo `import { MAX_GPU_ENTITIES } from '../types';` (`:13`): `import type { TextureManager } from '../texture-manager';`; in fondo al file:
```ts

/**
 * The layers in use of the eight texture arrays, primary tiers 0-3 then
 * overflow 0-3, the reserved layer 0 included (`getLayerCount`,
 * `getOverflowLayerCount`; an array never allocated counts 0): what
 * `deriveLightGroups` compares a sprite light's cookie with (round step 8).
 * Every handle the manager gave names a layer below its array's count. Writes
 * into `out` (the renderer reuses one) and returns it.
 */
export function textureLayerCounts(
  tm: Pick<TextureManager, 'getLayerCount' | 'getOverflowLayerCount'>,
  out: Uint16Array = new Uint16Array(8),
): Uint16Array {
  for (let tier = 0; tier < 4; tier++) {
    out[tier] = tm.getLayerCount(tier);
    out[4 + tier] = tm.getOverflowLayerCount(tier);
  }
  return out;
}
```
  e il `return` di `untexturedSpriteMessage` (Step 3), un solo messaggio con gli id, il tempo, i caricamenti e gli indici che questo renderer non ha caricato:
```ts
  return `[Hyperion] ${who} no texture this renderer loaded (index 0, the reserved layer 0, or a handle from another session, a tape, a snapshot or Mode A) `
    + "after a second of lit frames with no texture load in flight: a sprite light's cookie is its shape, so it lights nothing until it has one. "
    + 'Load the texture first (const cookie = await engine.loadTexture(url)) and set .texture(cookie) with .light(); '
    + 'a loadTexture that rejected leaves it without one, a handle is valid only in the session that loaded it, '
    + 'and in Mode A textures do not load (no main-thread renderer).';
```
  In `renderer.ts`, l'import di `./render/frame-inputs` (Step 3) prende `textureLayerCounts,` dopo `UNTEXTURED_SPRITE_MS,`; dopo `const untexturedSpriteWarning = persistentWarning(UNTEXTURED_SPRITE_MS);` (Step 3):
```ts
  // Round step 8 (sub-decision 4 (c)): the texture arrays' used layers, one
  // buffer refreshed in every frame's FrameState (textureLayerCounts).
  const textureLayersUsed = new Uint16Array(8);
```
  e nel letterale di `FrameState`, dopo `frameStamp,` (`:1055`): `        textureLayersUsed: textureLayerCounts(textureManager, textureLayersUsed),`. In `lighting-api.ts`, dopo `private viewProjection: (() => Float32Array) | null = null;` (`:105`): `  private textureLayersUsed: (() => ArrayLike<number> | undefined) | null = null;`; `_init` (`:109-117`):
```ts
  /**
   * @internal Wired by `Hyperion` at construction.
   * @param viewProjection the main-thread camera, for {@link groups}.
   * @param textureLayersUsed the main-thread renderer's texture counts
   *   (`textureLayerCounts`), for {@link groups}; none in Mode A.
   */
  _init(producer: BackpressuredProducer, bridge: EngineBridge, viewProjection?: () => Float32Array, textureLayersUsed?: () => ArrayLike<number> | undefined): void {
    this.producer = producer;
    this.bridge = bridge;
    this.viewProjection = viewProjection ?? null;
    this.textureLayersUsed = textureLayersUsed ?? null;
  }
```
  il `return` di `groups` (`:143`): `    return deriveLightGroups({ ...rs, cameraViewProjection: this.viewProjection(), textureLayersUsed: this.textureLayersUsed?.() });`; e il paragrafo di `untexturedSpriteLight` (Step 4) diventa:
```ts
   *
   * And `untexturedSpriteLight` (round step 8): a sprite light in the light
   * list has no texture this renderer loaded (layer 0 of its packed index,
   * or a layer at or past those its array has in use, from the main-thread
   * renderer's texture manager: in Mode A the main thread has none, so layer
   * 0 alone counts here, while the render worker's own warning applies the
   * whole rule), so it lights nothing until it has one. The flag is readable
   * in every build; only the warning is dev-only: the renderer warns once,
   * when the flag has held for a second of lit frames with no texture load
   * in flight. Await the texture before spawning,
   * `const cookie = await engine.loadTexture(url)`. Textures do not load in
   * Mode A.
```
  In `hyperion.ts`, dopo `import { LightingAPI } from './lighting-api';` (`:45`): `import { textureLayerCounts } from './render/frame-inputs';`, e `:116`:
```ts
    this.lightingApi._init(bridge.commandBuffer, bridge, () => this.camera.viewProjection,
      () => (this.renderer ? textureLayerCounts(this.renderer.textureManager) : undefined));
```
  In `entity-handle.ts`, nel paragrafo `sprite` (Step 4), le righe da « *   square's half-diagonal, `range`·√2. Layer 0 of a packed index never» a « *   there.» diventano una sola regola:
```ts
 *   square's half-diagonal, `range`·√2. An index that names no texture this
 *   renderer loaded lights nothing, and the renderer warns once in dev builds
 *   when a sprite light stays so for a second of lit frames with no texture
 *   load in flight: layer 0 (index 0, the default, and the layer every tier
 *   array reserves), a layer past the end of its array (discarded), and a
 *   layer its array allocated but never loaded (it holds zeroes: no light in
 *   an rgba8 or BC7 array, while ASTC decodes them to its error colour,
 *   opaque magenta or NaN, which the light then shows, with the warning). A
 *   layer loaded with another texture lights that one, without a warning:
 *   handles are valid only in the session that loaded them, and a tape or a
 *   snapshot recorded elsewhere names layers this page may hold differently.
 *   In Mode A textures do not load (`loadTexture` throws) and the render
 *   worker's arrays hold one layer, so every sprite light lights nothing
 *   there, and the render worker warns once.
```
- [ ] **Step 10: GREEN e mutanti.** Il comando dello Step 8: 270/270; `npm --prefix ts test`: 115 file, 2177 + 7 saltati; `tsc` pulito. Mutanti (uno alla volta, poi il verde; ciascuno fa fallire almeno un test): `>` al posto di `>=`; le voci primarie e di overflow scambiate (`(1 - (packed >>> 31)) * 4 + …`); senza il ramo di default (`used[(packed >>> 31) * 4 + tier]`); i conti ignorati (`return false;` al posto di `return layer >= used[…];`: la sola regola del layer 0); `textureLayerCounts` con l'overflow prima; il campo di `FrameState` mancante; il cablaggio di `lighting-api` (il quarto parametro non passato a `deriveLightGroups`) o di `hyperion.ts` (`_init` senza il quarto argomento) mancante; la riserva tolta in `texture-manager.ts` (`state.nextFreeLayer = 1;` → `0` a `:500`), che il pin vede. Poi il codice di nuovo, e il verde.
- [ ] **Step 11: commit**
```bash
git add ts/src/render/light-groups.ts ts/src/render/light-groups.test.ts ts/src/render/frame-inputs.ts ts/src/render/frame-inputs.test.ts ts/src/render/render-pass.ts ts/src/renderer.ts ts/src/lighting-api.ts ts/src/lighting-api.test.ts ts/src/hyperion.ts ts/src/hyperion.test.ts ts/src/texture-manager.test.ts ts/src/entity-handle.ts
git commit -m "feat(8): una luce sprite con un indice che questo renderer non ha caricato conta come senza texture (avviso, nessun set SDF)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: la demo con un cookie procedurale, i quattro check del probe e le immagini diritte in 2D Twins

Una sotto-scena del tab Lighting in (200, 0). Il cookie è un PNG 64×64 codificato in TS (URL `data:`): 4×4 blocchi, (i, j) = (85 i, 85 j, 255, A), A = 255 tranne (2, 1) a 64 e (2, 2) a 128; ogni codice unico, il bordo opaco, il blu 255·A. I quattro check, col probe su `light-buffer`:
- **'Sprite cookie at known texels':** i 16 centri dei blocchi a 0, π/2 e π/6, con l'immagine diritta (sotto-decisione 2: il blocco (0, 0) in alto a sinistra del quadrato non girato); a θ = 0, K specchiata da (3, −0,5) e (−3, 0,5), dove ogni centro mostra il blocco speculare (sotto-decisione 1); K in `mix`, dove il buffer va verso energia × rgb col peso alpha (le soglie separano "sommata come add" e "alpha ignorata"); fallisce anche su un errore GPU dal caricamento del cookie in poi, la prima allocazione del tier compresa.
- **'Cookie tier grows while the light draws':** filler di 1 px nel tier del cookie finché cresce (16 → 32 su una pagina fresca); il frame subito dopo la crescita, e uno dopo una rotazione (un buffer congelato lo rivela); 0 errori GPU (`gpuErrorWitness`).
- **'Sprite light: no pop at the frustum edge':** K, range 6, centrata fuori dal bordo sinistro, ne mostra una scheggia profonda 1 a ogni 15° di un quarto di giro; col raggio vecchio sparisce fra 11° e 79°.
- **'Sprite light shadow behind a wall':** S dietro W è scura; S' (specchio di S rispetto a L) e U (fra L e W) restano accese.

In 2D Twins, un check in più (sotto-decisione 2): **'Textured quad and line show their image upright':** un quad (scala 4) e una linea (da x −3 a 3, larga 2) opachi, col PNG del 5b (`sort-test-128.png`: quattro quadranti distinti, la coppia più vicina a 0,549 nel canale più diverso), in (−80, 60); i quattro centri dei quadranti di ciascuno, letti su `scene-hdr`, nominano la simmetria del quadrato: diritta passa; v girata nomina il giro mancante di `sampleTierOrWhite`; la sola linea girata, il giro spostato in `quad_vs`. Gli otto simmetrici del quadrato sono otto permutazioni distinte delle quattro letture (modello del giudice, `sd2-judge/check-model.mjs`).

In Mode A i quattro check della sprite saltano prima di spawnare, e quello di 2D Twins salta al caricamento della texture (`reportTextureLoadFailure`). Ogni caricamento ha un limite (`LOAD_TIMEOUT_MS`, 10 s): uno bloccato fa fallire i check col suo nome invece di appendere il tab.

**Files:** crea `ts/src/demo/lighting-sprite.ts` (+ test); modifica `demo/probe-checks.ts` (+ test), `hyperion.ts` (+ test), `demo/lighting.ts`, `demo/twin-2d.ts` (+ test).

**Interfaces:** produce `engine.debug.textureTiers(): TextureTiersState | null`, `gpuErrorWitness(engine, name?): GpuErrorWitness | null`, `checkSprite(engine, reporter, entities, floor, restoreView, { loadTimeoutMs }?)` coi verdetti puri `cookieVerdict`, `mixVerdict`, `growthVerdict`, `popVerdict`, `spriteShadowVerdict`, e `blockMix`, `MIRRORS`, `LOAD_TIMEOUT_MS`; in `demo/twin-2d.ts` `checkImageOrientation(engine, reporter)`, il verdetto puro `imageOrientationVerdict(r: ImageReads): { ok: boolean; detail: string }` e `IMAGE_QUADRANTS`; consuma i getter del `TextureManager` (`texture-manager.ts:210`, `:289-304`), `unpackTextureIndex`, `lightTexelsPerUnit` (`demo/lighting-mix.ts:234`), `halfResolution`, `maxChannelDiff`, `over`, `straight` (`demo/blend-expect.ts`), `pixelCheck`, `fitView`, `frames`, `viewBounds`, `reportTextureLoadFailure` (`probe-checks.ts`), `engine.use`/`unuse` (`PluginContext.gpu.device`).

- [ ] **Step 1: i test che falliscono.** Crea `ts/src/demo/lighting-sprite.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crc32 as zlibCrc32, inflateSync } from 'node:zlib';
import {
  blockCentres, blockLight, blockMix, checkSprite, cookiePixels, cookieTexel, cookieUv, cookieVerdict, crc32, decodeBlock, encodePng,
  fillerUrl, growthVerdict, mixVerdict, pokeGeometry, popVerdict, spriteShadowVerdict, COOKIE_SIZE, COOKIE_THETAS, COOKIE_URL, ENERGY,
  LOAD_TIMEOUT_MS, MIRRORS, POKE_DEPTH, POP_RANGE, POP_THETAS, SHADOW_POINTS, SPRITE_SCENE, TOL, type CookieRead, type GrowthReads,
  type PopRead,
} from './lighting-sprite';
import { createTestReporter } from './types';
import { Camera } from '../camera';
import { CameraAPI } from '../camera-api';
import { packTextureIndex, unpackTextureIndex } from '../texture-manager';
import { viewBounds, type Rgba } from './probe-checks';
import type { Rgb } from './blend-expect';
import type { Hyperion } from '../hyperion';
import type { EntityHandle } from '../entity-handle';

// The Lighting tab's floor (ambient + its global light) under the sub-scene.
const F: Rgb = [0.185, 0.17, 0.295];
const rgba = (c: readonly number[]): Rgba => [c[0], c[1], c[2], 1];
const sum = (a: readonly number[], b: readonly number[]): Rgb => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

describe('the procedural cookie', () => {
  it('64 x 64, 4 x 4 blocks of 16 px: every block code unique, the border opaque, blue 255 everywhere', () => {
    const px = cookiePixels();
    expect(px).toHaveLength(COOKIE_SIZE * COOKIE_SIZE * 4);
    expect([...px.subarray(0, 4)]).toEqual(cookieTexel(0, 0));
    expect([...px.subarray(((63 * 64) + 63) * 4, ((63 * 64) + 63) * 4 + 4)]).toEqual(cookieTexel(3, 3));
    // Pixel (x 40, y 20): column 2, row 1, the alpha-64 block.
    expect([...px.subarray((20 * 64 + 40) * 4, (20 * 64 + 40) * 4 + 4)]).toEqual([170, 85, 255, 64]);
    const codes = new Set<string>();
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        codes.add(blockLight(i, j, ENERGY).map((v) => v.toFixed(4)).join());
        if (i === 0 || i === 3 || j === 0 || j === 3) expect(cookieTexel(i, j)[3], `(${i},${j})`).toBe(255);
        expect(cookieTexel(i, j)[2]).toBe(255);
      }
    }
    expect(codes.size).toBe(16);
  });

  it('is a valid PNG with stored deflate blocks: CRC-32 as zlib computes it, the IDAT inflating to the filtered rows', () => {
    const png = encodePng(COOKIE_SIZE, COOKIE_SIZE, cookiePixels());
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const chunks: Array<{ type: string; data: Uint8Array; crc: number }> = [];
    for (let at = 8; at < png.length;) {
      const length = view.getUint32(at);
      const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
      chunks.push({ type, data: png.subarray(at + 8, at + 8 + length), crc: view.getUint32(at + 8 + length) });
      at += 12 + length;
    }
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    for (const c of chunks) expect(c.crc).toBe(zlibCrc32(Buffer.from([...c.type].map((ch) => ch.charCodeAt(0)).concat([...c.data]))));
    expect(crc32(new Uint8Array([1, 2, 3, 250]))).toBe(zlibCrc32(Buffer.from([1, 2, 3, 250])));
    const rows = inflateSync(chunks[1].data);
    expect(rows).toHaveLength(COOKIE_SIZE * (1 + COOKIE_SIZE * 4));
    expect([...rows.subarray(0, 5)]).toEqual([0, ...cookieTexel(0, 0)]);
  });

  it('travels as a data: URL, the same string on every load, and every filler URL is its own', () => {
    expect(COOKIE_URL.startsWith('data:image/png;base64,')).toBe(true);
    expect(Buffer.from(COOKIE_URL.slice(22), 'base64')).toEqual(Buffer.from(encodePng(COOKIE_SIZE, COOKIE_SIZE, cookiePixels())));
    expect(new Set([2, 3, 255, 256, 511].map(fillerUrl)).size).toBe(5);
  });
});

describe('sprite-light geometry', () => {
  it("the cookie's uv is the textured quad's, turned over at the lookup: the image's first row along the light's local +y edge (upright at rotation 0)", () => {
    expect(cookieUv([-4, 4], 4)).toEqual([0, 0]);
    expect(cookieUv([4, -4], 4)).toEqual([1, 1]);
    // Unturned: block (0, 0), the image's top-left, at the top left of the square on the y-up screen.
    const centres = blockCentres([0, 0], 0, 4);
    expect(centres[0]).toEqual({ i: 0, j: 0, at: [-3, 3] });
    expect(centres[15]).toEqual({ i: 3, j: 3, at: [3, -3] });
    // A quarter turn: local +x is world +y.
    const turned = blockCentres([0, 0], Math.PI / 2, 4)[3];
    expect(turned.at[0]).toBeCloseTo(-3);
    expect(turned.at[1]).toBeCloseTo(3);
  });

  it('decodes a read back to its block and alpha', () => {
    for (const [i, j] of [[0, 0], [2, 1], [2, 2], [3, 3]]) {
      const got = decodeBlock(sum(F, blockLight(i, j, ENERGY)), F, ENERGY);
      expect(got).toMatchObject({ i, j });
      expect(got!.a).toBeCloseTo(cookieTexel(i, j)[3] / 255);
    }
    expect(decodeBlock(F, F, ENERGY)).toBeNull();
  });

  it('the pop geometry: the square centred d outside the edge, a sliver POKE_DEPTH deep, the control past its tip', () => {
    const ds = POP_THETAS.map((t) => pokeGeometry(t, POP_RANGE, POKE_DEPTH).d);
    expect(ds.map((d) => d.toFixed(3))).toEqual(['5.000', '6.348', '7.196', '7.485', '7.196', '6.348']);
    for (const theta of POP_THETAS) {
      const g = pokeGeometry(theta, POP_RANGE, POKE_DEPTH);
      const local = (p: readonly number[]): number[] => {
        const [dx, dy] = [p[0] + g.d, p[1]];
        return [dx * Math.cos(theta) + dy * Math.sin(theta), -dx * Math.sin(theta) + dy * Math.cos(theta)];
      };
      expect(Math.max(...local(g.poke).map(Math.abs)), `the poke inside at ${theta}`).toBeLessThan(POP_RANGE);
      expect(Math.max(...local(g.control).map(Math.abs)), `the control outside at ${theta}`).toBeGreaterThan(POP_RANGE);
      // Kept by range·√2 at every angle; by the radius before step 8, range, only up to 11° and from 79°.
      expect(g.d).toBeLessThanOrEqual(POP_RANGE * Math.SQRT2);
      expect(g.d <= POP_RANGE, `old radius at ${theta}`).toBe(theta === 0);
    }
    expect(pokeGeometry(Math.PI / 4, POP_RANGE, POKE_DEPTH).halfWidth).toBeCloseTo(0.5);
  });
});

/** K's 16 reads at `theta`: the floor plus blockLight, or another block (`map`), or nothing. */
function cookieRead(theta: number, map: (i: number, j: number) => [number, number] | null = (i, j) => [i, j]): CookieRead {
  const values = blockCentres([0, 0], theta, 1).map(({ i, j }) => {
    const m = map(i, j);
    return rgba(m ? sum(F, blockLight(m[0], m[1], ENERGY)) : F);
  });
  return { theta, values, floor: rgba(F) };
}

describe('cookieVerdict', () => {
  it('passes the blocks as drawn, within TOL', () => {
    const v = cookieVerdict(COOKIE_THETAS.map((t) => cookieRead(t)), ENERGY);
    expect(v).toEqual({ ok: true, detail: 'blocks 0° 16/16, 90° 16/16, 30° 16/16' });
    const shifted = cookieRead(0);
    shifted.values[5] = rgba(sum(shifted.values[5], [TOL * 0.9, 0, 0]));
    expect(cookieVerdict([shifted], ENERGY).ok).toBe(true);
  });

  it('names a flipped, transposed or unturned mapping, nothing lit, and the alpha', () => {
    const cases: Array<[(i: number, j: number) => [number, number] | null, RegExp]> = [
      [(i, j) => [i, 3 - j], /v is flipped \(the uv convention\)/],
      [(i, j) => [3 - i, j], /u is flipped/],
      [(i, j) => [j, i], /u and v are swapped/],
      [(i, j) => [j, 3 - i], /a quarter turn off/],
      [() => null, /nothing lit at any block/],
    ];
    for (const [map, cause] of cases) {
      const v = cookieVerdict([cookieRead(Math.PI / 2, map)], ENERGY);
      expect(v.ok).toBe(false);
      expect(v.detail).toMatch(cause);
    }
    // The alpha ignored: the translucent blocks read as opaque ones.
    const alpha = cookieRead(0);
    alpha.values[1 * 4 + 2] = rgba(sum(F, [ENERGY * 2 / 3, ENERGY / 3, ENERGY]));
    alpha.values[2 * 4 + 2] = rgba(sum(F, [ENERGY * 2 / 3, ENERGY * 2 / 3, ENERGY]));
    expect(cookieVerdict([alpha], ENERGY).detail).toMatch(/the cookie's alpha is not the weight/);
  });

  it('judges a mirrored read against its mirror image, and names a mirror not applied', () => {
    for (const m of MIRRORS) {
      expect(cookieVerdict([{ ...cookieRead(0, m.expect), label: m.label, expect: m.expect }], ENERGY)).toEqual({ ok: true, detail: `blocks ${m.label} 16/16` });
    }
    const [y, x] = MIRRORS;
    expect(cookieVerdict([{ ...cookieRead(0), label: y.label, expect: y.expect }], ENERGY).detail)
      .toContain("at y-mirrored 0°: every block read unmirrored: the side axis does not follow the transform's determinant");
    expect(cookieVerdict([{ ...cookieRead(0, (i, j) => [3 - i, 3 - j]), label: x.label, expect: x.expect }], ENERGY).detail)
      .toContain('at x-mirrored 0°: every block read half a turn off, not mirrored');
    // The other mirror instead of the expected one: named by its symmetry, relative to the expected blocks.
    expect(cookieVerdict([{ ...cookieRead(0, x.expect), label: y.label, expect: y.expect }], ENERGY).detail).toContain('half a turn off');
  });

  it('a non-finite read is off, never within TOL', () => {
    const one = cookieRead(0);
    one.values[5] = [NaN, NaN, NaN, 1];
    expect(cookieVerdict([one], ENERGY)).toMatchObject({ ok: false, detail: expect.stringMatching(/^blocks 0° 15\/16; at 0°: 1 blocks off/) });
    const all = cookieRead(0);
    all.values = all.values.map((): Rgba => [NaN, NaN, NaN, 1]);
    expect(cookieVerdict([all], ENERGY).ok).toBe(false);
    expect(cookieVerdict([{ ...cookieRead(0), floor: [NaN, NaN, NaN, 1] }], ENERGY).ok).toBe(false);
  });
});

describe('mixVerdict', () => {
  /** K's 16 mix reads, `at` each block. */
  const read = (at: (i: number, j: number) => readonly number[]): CookieRead =>
    ({ theta: 0, values: blockCentres([0, 0], 0, 1).map(({ i, j }) => rgba(at(i, j))), floor: rgba(F) });

  it('passes floor·(1 − a) + energy × rgb·a at every block', () => {
    expect(mixVerdict(read((i, j) => blockMix(F, i, j, ENERGY)), ENERGY)).toEqual({ ok: true, detail: 'mix 0° 16/16' });
    // An opaque block replaces the floor; the alpha-64 block keeps 3/4 of it.
    expect(blockMix(F, 0, 0, ENERGY)).toEqual([0, 0, 2]);
    expect(blockMix(F, 2, 1, ENERGY)[2]).toBeCloseTo(F[2] * (1 - 64 / 255) + 2 * (64 / 255));
  });

  it('names a mix added like add, a weight that ignores the alpha, and a non-finite read', () => {
    expect(mixVerdict(read((i, j) => sum(F, blockLight(i, j, ENERGY))), ENERGY).detail).toBe('mix 0° 0/16; mix added like add (floor + target × alpha)');
    const target = (i: number, j: number) => cookieTexel(i, j).slice(0, 3).map((v) => (ENERGY * v) / 255);
    expect(mixVerdict(read(target), ENERGY).detail).toContain("the mix weight ignores the cookie's alpha (the target at every block)");
    const nan = read((i, j) => blockMix(F, i, j, ENERGY));
    nan.values[0] = [NaN, NaN, NaN, 1];
    expect(mixVerdict(nan, ENERGY)).toEqual({ ok: false, detail: 'mix 0° 15/16; 1 blocks off: (0,0)' });
  });
});

describe('growthVerdict', () => {
  const ok: GrowthReads = {
    before: { used: 2, allocated: 16 }, after: { used: 17, allocated: 32 },
    fillerLayers: Array.from({ length: 15 }, (_, k) => 2 + k),
    first: cookieRead(Math.PI / 6), turned: cookieRead(0), turnedAtFirst: cookieRead(Math.PI / 6), errors: 0, errorMessages: [],
  };

  it('passes a doubled tier, the next layers, the cookie in the first frame and after a turn, and no GPU error', () => {
    expect(growthVerdict(ok, ENERGY)).toEqual({
      ok: true, detail: '16 -> 32 layers (15 fillers, layers 2-16), cookie 30° and 0°, 0 GPU errors',
    });
  });

  it('names a frozen light buffer, GPU errors, a tier that did not grow and fillers out of place', () => {
    // A stale group 1: every frame after the growth dropped, the buffer still at 30°.
    const frozen = growthVerdict({ ...ok, turned: cookieRead(0, () => null), errors: 12, errorMessages: ['Destroyed texture used in a submit'] }, ENERGY);
    expect(frozen.ok).toBe(false);
    expect(frozen.detail).toContain('after the turn the light buffer still shows 30°: the frames since the growth did not run');
    expect(frozen.detail).toContain('12 GPU errors (Destroyed texture used in a submit)');
    const flat = growthVerdict({ ...ok, after: { used: 17, allocated: 16 } }, ENERGY);
    expect(flat.detail).toContain('the tier did not double: 16 -> 16 layers');
    const skipped = growthVerdict({ ...ok, fillerLayers: [2, 3, 5] }, ENERGY);
    expect(skipped.detail).toContain('the fillers took layers 2,3,5, not 2-4');
    expect(growthVerdict({ ...ok, errors: null }, ENERGY).detail).toContain('no GPU error witness');
    expect(growthVerdict({ ...ok, errors: 11, errorMessages: [] }, ENERGY).detail).toContain('11 GPU errors (messages not kept: cap reached)');
    // A non-finite read in the first frame after the growth fails it.
    const nan = cookieRead(Math.PI / 6);
    nan.values[0] = [NaN, NaN, NaN, 1];
    expect(growthVerdict({ ...ok, first: nan }, ENERGY).detail).toContain('first frame after the growth: blocks 30° 15/16');
  });
});

describe('popVerdict', () => {
  const lit = (theta: number, over: Partial<PopRead> = {}): PopRead => ({
    theta, poke: rgba(sum(F, [ENERGY, ENERGY, ENERGY])), control: rgba(F), floor: rgba(F), listed: true, ...over,
  });

  it('passes a lit sliver and a dark control at every angle', () => {
    const v = popVerdict(POP_THETAS.map((t) => lit(t)), ENERGY);
    expect(v.ok).toBe(true);
    expect(v.detail).toMatch(/^blue over the floor, sliver\/control: 0° 2\.000\/0\.000, 15° 2\.000\/0\.000/);
  });

  it('names a light missing from the list, a square that does not turn, and one too large', () => {
    const culled = popVerdict([lit(Math.PI / 4, { poke: rgba(F), listed: false })], ENERGY);
    expect(culled.detail).toContain('45°: K is not in the light list (its culling radius is under range·√2)');
    const unturned = popVerdict([lit(Math.PI / 4, { poke: rgba(F) })], ENERGY);
    expect(unturned.detail).toContain('45°: listed but the sliver is dark');
    const large = popVerdict([lit(0, { control: rgba(sum(F, [0, 0, ENERGY])) })], ENERGY);
    expect(large.detail).toContain("0°: lit past the square's tip");
  });
});

describe('spriteShadowVerdict', () => {
  const open = rgba(sum(F, [ENERGY, ENERGY, ENERGY]));
  it("passes S dark behind the wall, S' and U lit", () => {
    expect(spriteShadowVerdict({ S: rgba(F), S2: open, U: open, floor: rgba(F), groups: 1, sdfSets: 1 }, ENERGY)).toEqual({
      ok: true, detail: "L's light at S 0.000, S' 1.000, U 1.000; 1 group(s), 1 SDF set(s)",
    });
  });

  it('names the TS gate (no SDF set), the WGSL gate, and a march away from the light', () => {
    expect(spriteShadowVerdict({ S: open, S2: open, U: open, floor: rgba(F), groups: 1, sdfSets: 0 }, ENERGY).detail)
      .toContain('light-groups.ts does not count a shadowed sprite light');
    expect(spriteShadowVerdict({ S: open, S2: open, U: open, floor: rgba(F), groups: 1, sdfSets: 1 }, ENERGY).detail)
      .toContain('light-accum.wgsl does not march for a sprite light');
    expect(spriteShadowVerdict({ S: rgba(F), S2: open, U: rgba(F), floor: rgba(F), groups: 1, sdfSets: 1 }, ENERGY).detail)
      .toContain('the march runs away from the light');
  });

  it('names a non-finite read, never a pass', () => {
    const nan: Rgba = [NaN, NaN, NaN, 1];
    const v = spriteShadowVerdict({ S: nan, S2: open, U: nan, floor: rgba(F), groups: 1, sdfSets: 1 }, ENERGY);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain('a non-finite read at S, U');
    expect(spriteShadowVerdict({ S: rgba(F), S2: open, U: open, floor: nan, groups: 1, sdfSets: 1 }, ENERGY).detail).toContain('a non-finite read at floor');
  });
});

// ── checkSprite, end to end on a model of the engine ─────────────────────────

/** The defects the model can carry, each one the cause one check names. */
type Defect = 'none' | 'oldRadius' | 'flipV' | 'staleGroup' | 'staleFirst' | 'tsGate' | 'reversedMarch' | 'noMirror' | 'mixAsAdd' | 'mixAlphaIgnored';

interface FakeHandle {
  id: number;
  x: number;
  y: number;
  theta: number;
  /** The scale's signs matter to a sprite light (spriteAxes), its size does not. */
  sx: number;
  sy: number;
  light: { range: number; shadow: number; blend: 'add' | 'sub' | 'mix' } | null;
  tex: number;
  casts: boolean;
  destroyed: boolean;
}

/**
 * A model of the engine: the probe reads F plus every listed sprite light
 * (radius range·√2, or range with 'oldRadius') lighting its turned square with
 * blockLight (v flipped with 'flipV'), mirrored by a negative scale as
 * spriteAxes does (not with 'noMirror'), or as a straight "over" for a mix
 * light (added like add with 'mixAsAdd', at weight 1 with 'mixAlphaIgnored'),
 * shadowed where the segment to its centre (away from it with
 * 'reversedMarch') crosses the caster, unless 'tsGate'. PNGs go to the
 * overflow tier (16 layers, doubling). 'staleGroup': every frame after a
 * growth is dropped, each probe raising an uncaptured GPU error;
 * 'staleFirst': the same from the tier's first allocation. `full`: the tier
 * already at 256 layers, the cookie cached. `stall`: that load never resolves.
 * `loadErrors`: uncaptured GPU errors raised while the cookie loads, the
 * pixels right.
 */
function modelEngine(defect: Defect = 'none', opts: { modeA?: boolean; production?: boolean; full?: boolean; stall?: 'cookie' | 'filler'; loadErrors?: number } = {}) {
  const handles: FakeHandle[] = [];
  const cache = new Map<string, number>();
  const tier = { used: 0, allocated: 0 };
  if (opts.full) {
    cache.set(COOKIE_URL, packTextureIndex(0, 1, true));
    Object.assign(tier, { used: 256, allocated: 256 });
  }
  const device = new EventTarget();
  const plugins = new Map<string, (() => void) | void>();
  let frozen: FakeHandle[] | null = null;
  let nextId = 300;
  const spawn = () => {
    const h: FakeHandle = { id: nextId++, x: 0, y: 0, theta: 0, sx: 1, sy: 1, light: null, tex: 0, casts: false, destroyed: false };
    handles.push(h);
    let size: [number, number] = [1, 1];
    const api = {
      get id() { return h.id; },
      position: (x: number, y: number) => { h.x = x; h.y = y; return api; },
      scale: (sx: number, sy: number) => { size = [sx, sy]; h.sx = sx; h.sy = sy; return api; },
      rotation: (t: number) => { h.theta = t; return api; },
      receivesLight: () => api,
      castsShadow: () => { h.casts = true; (h as FakeHandle & { size?: [number, number] }).size = size; return api; },
      light: (o: { range: number; shadowIntensity?: number; blend?: 'add' | 'sub' | 'mix' }) => {
        h.light = { range: o.range, shadow: o.shadowIntensity ?? 0, blend: o.blend ?? 'add' };
        return api;
      },
      texture: (t: number) => { h.tex = t; return api; },
      destroy: () => { h.destroyed = true; },
    };
    return api;
  };
  const cam = new CameraAPI(new Camera());
  cam.setOrthographic((20 * 1920) / 1080, 20);
  const lights = (from: FakeHandle[]) => from.filter((h) => h.light !== null && !h.destroyed && h.tex !== 0);
  const listed = (from: FakeHandle[]): FakeHandle[] => {
    const [x0, x1, y0, y1] = viewBounds(cam.viewProjection);
    return lights(from).filter((h) => {
      const r = h.light!.range * (defect === 'oldRadius' ? 1 : Math.SQRT2);
      const dx = Math.max(x0 - h.x, 0, h.x - x1);
      const dy = Math.max(y0 - h.y, 0, h.y - y1);
      return Math.hypot(dx, dy) <= r;
    });
  };
  const caster = (): (FakeHandle & { size?: [number, number] }) | undefined => handles.find((h) => h.casts && !h.destroyed);
  const crosses = (a: readonly number[], b: readonly number[]): boolean => {
    const w = caster();
    if (!w) return false;
    const [sx, sy] = w.size ?? [1, 1];
    for (let s = 0; s <= 1; s += 1e-3) {
      const x = a[0] + (b[0] - a[0]) * s;
      const y = a[1] + (b[1] - a[1]) * s;
      if (Math.abs(x - w.x) <= sx / 2 && Math.abs(y - w.y) <= sy / 2) return true;
    }
    return false;
  };
  const shadowed = (): boolean => defect !== 'tsGate' && lights(handles).some((h) => h.light!.shadow > 0);
  const lightAt = (p: readonly [number, number], from: FakeHandle[]): Rgba => {
    let c: Rgb = [...F];
    for (const h of listed(from)) {
      const r = h.light!.range;
      const dx = p[0] - h.x;
      const dy = p[1] - h.y;
      // spriteAxes: the facing follows the x-scale's sign (lightFacing), the side axis the determinant's.
      const facing = Math.sign(h.sx) || 1;
      const side = defect === 'noMirror' ? facing : (Math.sign(h.sy) || 1);
      const [c0, s0] = [Math.cos(h.theta), Math.sin(h.theta)];
      const local: [number, number] = [facing * (dx * c0 + dy * s0), side * (-dx * s0 + dy * c0)];
      if (Math.max(Math.abs(local[0]), Math.abs(local[1])) > r) continue;
      let [u, v] = cookieUv(local, r);
      if (defect === 'flipV') v = 1 - v;
      const i = Math.min(3, Math.max(0, Math.floor(u * 4)));
      const j = Math.min(3, Math.max(0, Math.floor(v * 4)));
      let shadow = 1;
      if (h.light!.shadow > 0 && shadowed()) {
        const away: [number, number] = [p[0] + (p[0] - h.x), p[1] + (p[1] - h.y)];
        shadow = crosses(p, defect === 'reversedMarch' ? away : [h.x, h.y]) ? 0 : 1;
      }
      if (h.light!.blend === 'mix' && defect !== 'mixAsAdd') {
        const [cr, cg, cb, ca] = cookieTexel(i, j).map((x) => x / 255);
        const w = (defect === 'mixAlphaIgnored' ? 1 : ca) * shadow;
        c = [c[0] * (1 - w) + ENERGY * cr * w, c[1] * (1 - w) + ENERGY * cg * w, c[2] * (1 - w) + ENERGY * cb * w];
      } else {
        c = sum(c, blockLight(i, j, ENERGY * shadow));
      }
    }
    return rgba(c);
  };
  const snapshot = (): FakeHandle[] => handles.map((h) => ({ ...h, light: h.light ? { ...h.light } : null }));
  const engine = {
    batch: (fn: () => void) => fn(),
    spawn, cam,
    async loadTexture(url: string, tierIndex?: number) {
      if (opts.modeA) throw new Error('Cannot load textures: no renderer available');
      if (opts.stall === (url === COOKIE_URL ? 'cookie' : 'filler')) return new Promise<number>(() => {});
      const cached = cache.get(url);
      if (cached !== undefined) return cached;
      for (let e = 0; e < (url === COOKIE_URL ? opts.loadErrors ?? 0 : 0); e++) {
        device.dispatchEvent(Object.assign(new Event('uncapturederror'), { error: { message: 'load error' } }));
      }
      if (tier.allocated === 0) {
        tier.allocated = 16;
        tier.used = 1;
        if (defect === 'staleFirst') frozen = snapshot();
      } else if (tier.used + 1 > tier.allocated) {
        tier.allocated *= 2;
        if (defect === 'staleGroup') frozen = snapshot();
      }
      const packed = packTextureIndex(tierIndex ?? 0, tier.used++, true);
      cache.set(url, packed);
      return packed;
    },
    lighting: {
      get groups() {
        return {
          groups: [{ layers: 1, sdfSet: shadowed() ? 0 : -1 }], sdfSets: shadowed() ? [{ occluderLayers: 1 }] : [],
          layerToGroup: [0, 0], lightIds: Uint32Array.from(listed(handles).map((h) => h.id)),
        };
      },
    },
    debug: opts.production ? null : {
      async probe(request: { target: string; world: [number, number][]; layer?: number }) {
        if (frozen) device.dispatchEvent(Object.assign(new Event('uncapturederror'), { error: { message: 'Destroyed texture used in a submit' } }));
        return { values: request.world.map((p) => lightAt(p, frozen ?? handles)) };
      },
      textureTiers: () => ({
        compressedFormat: 'bc7-rgba-unorm',
        tiers: [64, 128, 256, 512].map((size, t) => ({ size, layers: 0, allocated: 0, overflowLayers: t === 0 ? tier.used : 0, overflowAllocated: t === 0 ? tier.allocated : 0 })),
      }),
    },
    use(plugin: { name: string; install(ctx: unknown): (() => void) | void }) {
      if (plugins.has(plugin.name)) throw new Error(`Plugin "${plugin.name}" is already installed`);
      plugins.set(plugin.name, plugin.install({ gpu: opts.modeA ? null : { device } }));
    },
    unuse(name: string) {
      const cleanup = plugins.get(name);
      if (cleanup) cleanup();
      plugins.delete(name);
    },
  } as unknown as Hyperion;
  return { engine, handles, tier, plugins };
}

describe('checkSprite', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubs = () => {
    vi.stubGlobal('document', { getElementById: () => ({ width: 1920, height: 1080 }) });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  };
  const run = async (defect: Defect, opts: Parameters<typeof modelEngine>[1] = {}, check: Parameters<typeof checkSprite>[5] = {}) => {
    stubs();
    const model = modelEngine(defect, opts);
    const reporter = createTestReporter();
    const entities: EntityHandle[] = [];
    const restoreView = vi.fn();
    await checkSprite(model.engine, reporter, entities, F, restoreView, check);
    return { ...model, reporter, entities, restoreView, results: reporter.results().map(({ name, status, detail }) => ({ name, status, detail: detail ?? '' })) };
  };

  it('in Mode A: four skips (no texture loads), nothing spawned, no witness left, the view untouched', async () => {
    const r = await run('none', { modeA: true });
    expect(r.results.map(({ status }) => status)).toEqual(['skip', 'skip', 'skip', 'skip']);
    expect(r.results[0].detail).toMatch(/no main-thread renderer: Cannot load textures/);
    expect(r.handles).toHaveLength(0);
    expect(r.plugins.size).toBe(0);
    expect(r.restoreView).not.toHaveBeenCalled();
  });

  it('in a production build: four skips before any texture loads', async () => {
    const r = await run('none', { production: true });
    expect(r.results.map(({ status }) => status)).toEqual(['skip', 'skip', 'skip', 'skip']);
    expect(r.tier.allocated).toBe(0);
  });

  it('on the step-8 rules: four passes, the tier grown 16 -> 32 by 15 fillers, the scene put back', async () => {
    const r = await run('none');
    expect(r.results.map(({ name, status, detail }) => [name, status, status === 'pass' ? '' : detail])).toEqual([
      ['Sprite cookie at known texels', 'pass', ''],
      ['Cookie tier grows while the light draws', 'pass', ''],
      ['Sprite light: no pop at the frustum edge', 'pass', ''],
      ['Sprite light shadow behind a wall', 'pass', ''],
    ]);
    expect(r.results[1].detail).toMatch(/^16 -> 32 layers \(15 fillers, layers 2-16\), cookie 30° and 0°, 0 GPU errors/);
    expect(r.results[0].detail).toMatch(/^blocks 0° 16\/16, 90° 16\/16, 30° 16\/16, y-mirrored 0° 16\/16, x-mirrored 0° 16\/16; mix 0° 16\/16; 0 GPU errors since the cookie loaded; cookie overflow tier 0 layer 1;/);
    expect(r.results[3].detail).toContain('1 group(s), 1 SDF set(s)');
    // The floor, K, L and the wall; every one destroyed, and in the tab's list.
    expect(r.handles).toHaveLength(4);
    expect(r.handles.every((h) => h.destroyed)).toBe(true);
    expect(r.entities).toHaveLength(4);
    expect(r.plugins.size).toBe(0);
    expect(r.restoreView).toHaveBeenCalledTimes(1);
    // K's cookie is the first texture, layer 1 of overflow tier 0, on K and L both.
    expect(unpackTextureIndex(r.handles[1].tex)).toEqual({ overflow: true, tier: 0, layer: 1 });
    expect(r.handles[2].tex).toBe(r.handles[1].tex);
  });

  it('on a second entry the cached cookie keeps layer 1, and fillers of their own grow the tier again, 32 -> 64', async () => {
    stubs();
    const model = modelEngine('none');
    const enter = async () => {
      const reporter = createTestReporter();
      await checkSprite(model.engine, reporter, [], F, () => {});
      return reporter.results();
    };
    await enter();
    const second = await enter();
    expect(second.map(({ status }) => status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(second[1].detail).toMatch(/^32 -> 64 layers \(16 fillers, layers 17-32\), cookie 30° and 0°, 0 GPU errors/);
    expect(second[0].detail).toContain('cookie overflow tier 0 layer 1');
  });

  it('each defect fails the check that names it', async () => {
    const failing = async (defect: Defect) => (await run(defect)).results.filter((x) => x.status === 'fail').map((x) => [x.name, x.detail]);
    const [cookie] = await failing('flipV');
    expect(cookie[0]).toBe('Sprite cookie at known texels');
    expect(cookie[1]).toMatch(/v is flipped \(the uv convention\)/);
    expect(await failing('oldRadius')).toEqual([['Sprite light: no pop at the frustum edge', expect.stringContaining('its culling radius is under range·√2')]]);
    // A stale group 1 drops every frame after the growth: the growth check names it, and the later checks read a frozen buffer too.
    expect((await failing('staleGroup'))[0]).toEqual(['Cookie tier grows while the light draws', expect.stringContaining('the frames since the growth did not run')]);
    expect(await failing('tsGate')).toEqual([['Sprite light shadow behind a wall', expect.stringContaining('light-groups.ts does not count a shadowed sprite light')]]);
    expect(await failing('reversedMarch')).toEqual([['Sprite light shadow behind a wall', expect.stringContaining('the march runs away from the light')]]);
    // The mirror and the mix, read by the cookie check only.
    expect(await failing('noMirror')).toEqual([['Sprite cookie at known texels', expect.stringContaining('at y-mirrored 0°: every block read unmirrored')]]);
    expect(await failing('mixAsAdd')).toEqual([['Sprite cookie at known texels', expect.stringContaining('mix added like add')]]);
    expect(await failing('mixAlphaIgnored')).toEqual([['Sprite cookie at known texels', expect.stringContaining("the mix weight ignores the cookie's alpha")]]);
  });

  it("a stale group from the tier's first allocation fails the cookie check, naming the GPU errors; so do errors alone", async () => {
    const r = await run('staleFirst');
    expect(r.results[0].status).toBe('fail');
    expect(r.results[0].detail).toMatch(/; [1-9]\d* GPU errors since the cookie loaded \(Destroyed texture used in a submit/);
    // Errors with the right pixels: the count alone fails the check, and the growth counts from its own start.
    const errors = await run('none', { loadErrors: 2 });
    expect(errors.results.map(({ status }) => status)).toEqual(['fail', 'pass', 'pass', 'pass']);
    expect(errors.results[0].detail).toContain('; mix 0° 16/16; 2 GPU errors since the cookie loaded (load error | load error);');
    // The growth names its own errors, never the load's.
    const both = await run('staleGroup', { loadErrors: 1 });
    expect(both.results[1].detail).toContain('GPU errors (Destroyed texture used in a submit');
    expect(both.results[1].detail).not.toContain('load error');
  });

  it('a texture load that never resolves fails its checks after LOAD_TIMEOUT_MS, naming it, instead of hanging the tab', async () => {
    expect(LOAD_TIMEOUT_MS).toBe(10000);
    const cookie = await run('none', { stall: 'cookie' }, { loadTimeoutMs: 20 });
    expect(cookie.results.map(({ status }) => status)).toEqual(['fail', 'fail', 'fail', 'fail']);
    expect(cookie.results[0].detail).toBe('cannot load the procedural cookie (a 64 x 64 PNG data: URL): timed out after 20 ms');
    expect(cookie.handles).toHaveLength(0);
    expect(cookie.plugins.size).toBe(0);
    const filler = await run('none', { stall: 'filler' }, { loadTimeoutMs: 20 });
    expect(filler.results.map(({ status }) => status)).toEqual(['pass', 'fail', 'pass', 'pass']);
    expect(filler.results[1].detail).toBe('cannot load filler 2 (a 1 x 1 PNG data: URL): timed out after 20 ms; 0 of 15 fillers loaded');
    expect(filler.handles.every((h) => h.destroyed)).toBe(true);
    expect(filler.plugins.size).toBe(0);
  });

  it('skips the growth when the tier is full (a page that entered the tab too often), the other three run', async () => {
    const r = await run('none', { full: true });
    expect(r.results.map(({ status }) => status)).toEqual(['pass', 'skip', 'pass', 'pass']);
    expect(r.results[1].detail).toMatch(/the cookie's tier is full \(256 layers\): reload the page/);
  });

  it('the shadow points sit on opaque blocks of L, and the sub-scene is far from the tab', () => {
    // L at (8, 0), turned a quarter turn, range 4.
    for (const p of Object.values(SHADOW_POINTS)) {
      const [dx, dy] = [p[0] - 8, p[1]];
      const [u, v] = cookieUv([dy, -dx], 4);
      expect(cookieTexel(Math.floor(u * 4), Math.floor(v * 4))[3]).toBe(255);
    }
    expect(SPRITE_SCENE[0] - 17.6 - 6 * Math.SQRT2).toBeGreaterThan(30);
  });
});
```

  `modelEngine` (il suo JSDoc elenca i difetti) fa fallire a ogni difetto il check che lo nomina; il secondo ingresso gira due volte sullo stesso modello (il cookie resta al layer 1, 16 filler nuovi portano il tier da 32 a 64); i verdetti sono a prova di NaN (`!(x <= TOL)`, mai `x > TOL`), come al passo 7. Con l'immagine diritta i punti di `SHADOW_POINTS` cadono su altri blocchi, tutti opachi (S (2, 0) → (2, 3), S' (1, 3) → (1, 0), U (1, 1) → (1, 2)), le schegge del pop restano nella colonna 3, opaca, e `MIRRORS` dà 16/16 con l'una e l'altra regola (modello del giudice, `sd2-judge/models.mjs`).

  In `ts/src/demo/twin-2d.test.ts` (dopo lo Step 0 del Task 3): l'import da `./twin-2d` diventa `import { checkImageOrientation, checkTransparentDepth, checkTransparentSort, imageOrientationVerdict, IMAGE_QUADRANTS, ORDER_PROBE_OFFSET } from './twin-2d';`; nel commento sopra `const NOT_FOUND` (`:6-10` a HEAD) "The two 2D Twins checks that load" diventa "The 2D Twins checks that load" (con quello del passo 8 sono tre) e "Both checks return right after a failed load" diventa "Each returns right after a failed load"; nel `describe('2D Twins: a failed test-texture load'`, dopo il test 'Mode C, the file is missing: both sort checks fail with the error':
```ts

  it.each(['B', 'C'] as const)('Mode %s, the file is missing: the orientation check fails with the error (round step 8)', async (mode) => {
    const reporter = createTestReporter();
    await checkImageOrientation(engine(mode, NOT_FOUND), reporter);
    expect(reporter.results()).toEqual([
      { name: 'Textured quad and line show their image upright', status: 'fail', detail: expect.stringContaining(NOT_FOUND) },
    ]);
  });
```
  il test di Mode A diventa:
```ts
  it('Mode A, no main-thread renderer: all four checks skip', async () => {
    const reporter = createTestReporter();
    await checkTransparentDepth(engine('A', NO_RENDERER), reporter);
    await checkTransparentSort(engine('A', NO_RENDERER), reporter);
    await checkImageOrientation(engine('A', NO_RENDERER), reporter);
    expect(statusOf(reporter)).toEqual({
      'Depth orders transparent sprites': 'skip',
      'Transparent sort matches the oracle': 'skip',
      'Transparent sort under churn': 'skip',
      'Textured quad and line show their image upright': 'skip',
    });
  });
```
  e in fondo al file:
```ts

// Round step 8 (sub-decision 2 (e)): a textured quad and a textured line
// show the PNG upright; its four distinct quadrants tell every symmetry of
// the square apart.
describe('imageOrientationVerdict', () => {
  const CLEAR: Rgb = [0.067, 0.067, 0.067];
  /** A shape whose corners (upper left, upper right, lower left, lower right) show these quadrants; -1 shows the clear. */
  const reads = (shows: readonly number[]): Rgb[] => shows.map((q) => (q < 0 ? CLEAR : IMAGE_QUADRANTS[q].rgb));
  const UPRIGHT = [0, 1, 2, 3];
  const V_FLIPPED = [2, 3, 0, 1];

  it('passes both shapes upright', () => {
    expect(imageOrientationVerdict({ quad: reads(UPRIGHT), line: reads(UPRIGHT), clear: CLEAR }))
      .toEqual({ ok: true, detail: 'quad TL TR BL BR, line TL TR BL BR (at the upper left, upper right, lower left, lower right)' });
  });

  it('names each other symmetry of either shape, and v flipped on both: the lookup does not turn v over', () => {
    const others: Array<[number[], string]> = [
      [[1, 0, 3, 2], 'u flipped'], [[3, 2, 1, 0], 'half a turn off'], [[0, 2, 1, 3], 'transposed (u and v swapped)'],
      [[3, 1, 2, 0], 'transposed across the other diagonal'], [[1, 3, 0, 2], 'a quarter turn off'], [[2, 0, 3, 1], 'three quarters of a turn off'],
    ];
    for (const [shows, name] of others) {
      for (const shape of ['quad', 'line'] as const) {
        const v = imageOrientationVerdict({ quad: reads(shape === 'quad' ? shows : UPRIGHT), line: reads(shape === 'line' ? shows : UPRIGHT), clear: CLEAR });
        expect(v.ok, `${shape}: ${name}`).toBe(false);
        expect(v.detail).toContain(`the ${shape} is ${name}`);
      }
    }
    const both = imageOrientationVerdict({ quad: reads(V_FLIPPED), line: reads(V_FLIPPED), clear: CLEAR });
    expect(both.ok).toBe(false);
    expect(both.detail).toContain('the quad is v flipped (sampleTierOrWhite does not turn v over)');
    expect(both.detail).toContain('the line is v flipped (sampleTierOrWhite does not turn v over)');
  });

  it('names a flip that sits in one library: the line alone flipped, the quad alone flipped, each with both of its causes', () => {
    expect(imageOrientationVerdict({ quad: reads(UPRIGHT), line: reads(V_FLIPPED), clear: CLEAR }).detail)
      .toContain('the line only is v flipped: one library turns v over on its own (the flip moved from sampleTierOrWhite into quad_vs, or a second flip in line_vs)');
    expect(imageOrientationVerdict({ quad: reads(V_FLIPPED), line: reads(UPRIGHT), clear: CLEAR }).detail)
      .toContain('the quad only is v flipped: one library turns v over on its own (a second flip in quad_vs, or the flip moved from sampleTierOrWhite into line_vs)');
  });

  it('names a shape that draws nothing, and reads no quadrant explains, NaN included: never a pass', () => {
    const none = imageOrientationVerdict({ quad: reads(UPRIGHT), line: reads([-1, -1, -1, -1]), clear: CLEAR });
    expect(none.ok).toBe(false);
    expect(none.detail).toContain('the line draws nothing (the clear at its four corners)');
    const nan = imageOrientationVerdict({ quad: [[NaN, NaN, NaN], ...reads(UPRIGHT).slice(1)], line: reads(UPRIGHT), clear: CLEAR });
    expect(nan.ok).toBe(false);
    expect(nan.detail).toContain('the quad: no quadrant within 0.03 at the upper left (NaN, NaN, NaN)');
  });
});
```

  In `probe-checks.test.ts`, l'import di `:2` prende `gpuErrorWitness`:
```ts
import { pixelCheck, near, luminance, PROBE_TIMEOUT_MS, reportTextureLoadFailure, viewBounds, gpuErrorWitness } from './probe-checks';
```
  e in fondo al file, dopo `:217`:
```ts

// Round step 8: what reaches the device's uncapturederror event.
describe('gpuErrorWitness', () => {
  /** An engine whose use() installs a plugin on a context with `device` (or none), and unuse() runs its cleanup. */
  function pluginEngine(device: EventTarget | null) {
    const plugins = new Map<string, (() => void) | void>();
    const engine = {
      use(plugin: { name: string; install(ctx: unknown): (() => void) | void }) {
        if (plugins.has(plugin.name)) throw new Error(`Plugin "${plugin.name}" is already installed`);
        plugins.set(plugin.name, plugin.install({ gpu: device ? { device } : null }));
      },
      unuse(name: string) {
        const cleanup = plugins.get(name);
        if (cleanup) cleanup();
        plugins.delete(name);
      },
    } as unknown as Hyperion;
    return { engine, plugins };
  }
  const gpuError = (message: string): Event => Object.assign(new Event('uncapturederror', { cancelable: true }), { error: { message } });

  it('counts the uncaptured GPU errors of the device and keeps their messages, until stop()', () => {
    const device = new EventTarget();
    const { engine, plugins } = pluginEngine(device);
    const witness = gpuErrorWitness(engine)!;
    expect(witness).not.toBeNull();
    device.dispatchEvent(gpuError('Destroyed texture used in a submit'));
    device.dispatchEvent(gpuError('second'));
    expect(witness.count).toBe(2);
    expect(witness.messages).toEqual(['Destroyed texture used in a submit', 'second']);
    witness.stop();
    expect(plugins.size).toBe(0);
    device.dispatchEvent(gpuError('after stop'));
    expect(witness.count).toBe(2);
  });

  it('replaces a witness a dead run left installed, and never cancels the event: the console keeps it', () => {
    const device = new EventTarget();
    const { engine } = pluginEngine(device);
    const stale = gpuErrorWitness(engine)!;  // never stopped
    const witness = gpuErrorWitness(engine)!;
    const event = gpuError('x');
    device.dispatchEvent(event);
    expect(witness.count).toBe(1);
    expect(stale.count).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('is null without a main-thread device (Mode A, headless), and leaves no plugin behind', () => {
    const { engine, plugins } = pluginEngine(null);
    expect(gpuErrorWitness(engine)).toBeNull();
    expect(plugins.size).toBe(0);
  });
});
```
  In `hyperion.test.ts`, nel `describe('debug API'` (`:947`), prima di `it('readTransparentSort delegates to the renderer sort probe'` (`:996`):
```ts
  it("textureTiers reports the texture manager's layer counts per tier, and null without a main-thread renderer (round step 8)", () => {
    expect(Hyperion.fromParts(defaultConfig(), mockBridge(), null).debug!.textureTiers()).toBeNull();
    const renderer = mockRenderer();
    Object.assign(renderer.textureManager, {
      compressedFormat: 'bc7-rgba-unorm',
      getLayerCount: (t: number) => t,
      getAllocatedLayers: (t: number) => 16 * t,
      getOverflowLayerCount: (t: number) => 2 + t,
      getOverflowAllocatedLayers: (t: number) => (t === 0 ? 16 : 0),
    });
    const engine = Hyperion.fromParts(defaultConfig(), mockBridge(), renderer);
    expect(engine.debug!.textureTiers()).toEqual({
      compressedFormat: 'bc7-rgba-unorm',
      tiers: [
        { size: 64, layers: 0, allocated: 0, overflowLayers: 2, overflowAllocated: 16 },
        { size: 128, layers: 1, allocated: 16, overflowLayers: 3, overflowAllocated: 0 },
        { size: 256, layers: 2, allocated: 32, overflowLayers: 4, overflowAllocated: 0 },
        { size: 512, layers: 3, allocated: 48, overflowLayers: 5, overflowAllocated: 0 },
      ],
    });
  });

```
- [ ] **Step 2: RED.**
```bash
npx --prefix ts vitest run --root ts src/demo/lighting-sprite.test.ts src/demo/probe-checks.test.ts src/hyperion.test.ts src/demo/twin-2d.test.ts
```
  Expected: `lighting-sprite.test.ts` non si carica (`Cannot find module './lighting-sprite'`); in `probe-checks.test.ts` falliscono i 3 test di `gpuErrorWitness` ("gpuErrorWitness is not a function"); in `hyperion.test.ts` quello di `textureTiers` ("textureTiers is not a function"); in `twin-2d.test.ts` 7 su 12, i due del file mancante e quello di Mode A ("checkImageOrientation is not a function") e i 4 di `imageOrientationVerdict` (`IMAGE_QUADRANTS` non esiste ancora).
- [ ] **Step 3: il testimone e `textureTiers`.** In `probe-checks.ts`, fra la chiusura di `reportTextureLoadFailure` (`:95`) e `export function near` (`:97`):
```ts

/** The GPU errors nobody captured on the main-thread device: see {@link gpuErrorWitness}. */
export interface GpuErrorWitness {
  /** Uncaptured errors since the witness was installed. */
  readonly count: number;
  /** Their messages, oldest first (the first 10). */
  readonly messages: readonly string[];
  /** Uninstalls the witness. */
  stop(): void;
}

/**
 * Counts the GPU errors of the frame's own submit, which reach the device's
 * `uncapturederror` event: the probe's error scope covers its own dispatch
 * only, so a dropped frame leaves it answering the last good pixels. A
 * plugin (`engine.use`, for `gpu.device`) under `name`, replacing one a dead
 * run left; never preventDefault (the console keeps the errors). `null`,
 * nothing installed, without a main-thread renderer (Mode A, headless).
 */
export function gpuErrorWitness(engine: Hyperion, name = 'harness-gpu-error-witness'): GpuErrorWitness | null {
  let count = 0;
  const messages: string[] = [];
  const installed = { device: null as GPUDevice | null };
  const onError = (event: Event): void => {
    count++;
    if (messages.length < 10) messages.push((event as GPUUncapturedErrorEvent).error?.message ?? event.type);
  };
  engine.unuse(name);
  engine.use({
    name,
    version: '1.0.0',
    install(ctx) {
      installed.device = ctx.gpu?.device ?? null;
      installed.device?.addEventListener('uncapturederror', onError);
      return () => installed.device?.removeEventListener('uncapturederror', onError);
    },
  });
  if (!installed.device) {
    engine.unuse(name);
    return null;
  }
  return {
    get count() { return count; },
    get messages() { return messages; },
    stop: () => engine.unuse(name),
  };
}
```
  In `hyperion.ts`, dopo `import { LightingAPI } from './lighting-api';` (`:45`):
```ts
import { TIER_SIZES } from './texture-manager';
```
  dopo `const PROBE_PAUSED = …;` (`:48`):
```ts

/** `engine.debug.textureTiers()`: the texture tiers' layer counts (round step 8). */
export interface TextureTiersState {
  /** The primary tiers' format, null for rgba8unorm (then PNG and JPEG go to the primary tiers too). */
  compressedFormat: GPUTextureFormat | null;
  /** Per tier (TIER_SIZES): layers used (the reserved layer 0 included) and allocated, primary and overflow. */
  tiers: Array<{ size: number; layers: number; allocated: number; overflowLayers: number; overflowAllocated: number }>;
}
```
  e nel getter `debug`, dopo la chiusura di `readTransparentSort()` (`:336`, `},`) e prima del doc di `setPhysicsDebugRender`:
```ts
      /**
       * The texture tiers' layer counts now (round step 8): per tier, used
       * (the reserved layer 0 included) and allocated, primary and rgba8
       * overflow. `null` without a main-thread renderer (Mode A, headless).
       */
      textureTiers(): TextureTiersState | null {
        const tm = self.renderer?.textureManager;
        if (!tm) return null;
        return {
          compressedFormat: tm.compressedFormat,
          tiers: TIER_SIZES.map((size, tier) => ({
            size,
            layers: tm.getLayerCount(tier),
            allocated: tm.getAllocatedLayers(tier),
            overflowLayers: tm.getOverflowLayerCount(tier),
            overflowAllocated: tm.getOverflowAllocatedLayers(tier),
          })),
        };
      },
```
- [ ] **Step 4: i check.** Crea `ts/src/demo/lighting-sprite.ts`:
```ts
// ts/src/demo/lighting-sprite.ts — the Lighting tab's sprite-light checks
// (round step 8) on a sub-scene at SPRITE_SCENE: a floor, a wall W and two 2D
// sprite lights with a procedural cookie, K (scaled 3 x 0.5: only the sign of
// a scale counts, which two mirrored reads check; a third switches K to mix)
// and L (shadowed, a quarter turn). `floor` is ambient + the tab's global
// light. Mode A loads no texture: four skips, nothing spawned. Every load is
// bounded (LOAD_TIMEOUT_MS). Four fresh ids: later tabs' ids are 4 higher.
//
// The cookie: 64 x 64, 4 x 4 blocks of 16 px, block (i, j) = (85 i, 85 j,
// 255, A) from the image's left and top, A = 255 but (2, 1) 64 and (2, 2)
// 128. A PNG data: URL in stored deflate, the same bytes on every run.
import type { Hyperion } from '../hyperion';
import type { EntityHandle, LightOptions } from '../entity-handle';
import type { TestReporter } from './types';
import { maxChannelDiff, over, straight, type Rgb } from './blend-expect';
import { lightTexelsPerUnit } from './lighting-mix';
import { halfResolution } from '../render/passes/occluder-seed-stage';
import { unpackTextureIndex } from '../texture-manager';
import {
  pixelCheck, fmt, fitView, frames, viewBounds, reportTextureLoadFailure, gpuErrorWitness, type Rgba,
} from './probe-checks';

/** A point in world units, from SPRITE_SCENE. */
type Xy = readonly [number, number];

/** Past the tab's lights (x ≈ 30) and the step-6/7 sub-scenes at (0, ±200). */
export const SPRITE_SCENE: [number, number] = [200, 0];
/** The tab's own framing (zoom 1 at 16:9). */
const SUB_HALF_WIDTH = 17.6;
/** Both sprite lights: white, `add`. */
export const ENERGY = 2;
/** K in the cookie check: centre and range (half-side). */
const K_AT: Xy = [-8, 0];
const K_RANGE = 4;
/** K's angles in the cookie check; the growth check starts at the last. */
export const COOKIE_THETAS = [0, Math.PI / 2, Math.PI / 6];
/** K's mirrored reads at θ = 0 (spriteAxes): `expect` is the block each unmirrored centre shows. */
export const MIRRORS: ReadonlyArray<{ label: string; scale: [number, number]; expect: (i: number, j: number) => [number, number] }> = [
  { label: 'y-mirrored 0°', scale: [3, -0.5], expect: (i, j) => [i, 3 - j] },
  { label: 'x-mirrored 0°', scale: [-3, 0.5], expect: (i, j) => [3 - i, j] },
];
/** L, the shadowed sprite light (its +x up the screen). */
const L_AT: Xy = [8, 0];
const L_RANGE = 4;
const L_THETA = Math.PI / 2;
/** W, the wall between L and S. */
const W_AT: Xy = [10, 0];
const W_SIZE: Xy = [0.5, 3];
/** S behind W; S' (S mirrored through L) and U (between L and W) in the open. */
export const SHADOW_POINTS = { S: [11.5, 0.5] as Xy, S2: [4.5, -0.5] as Xy, U: [9.25, -0.5] as Xy };
/** No light of the sub-scene reaches it: every check's floor read. */
const FLOOR_AT: Xy = [0, 8];
/** The pop check: K's range, the sliver's depth, the angles of a quarter turn. */
export const POP_RANGE = 6;
export const POKE_DEPTH = 1;
export const POP_THETAS = [0, 15, 30, 45, 60, 75].map((d) => (d * Math.PI) / 180);
/** Per-channel tolerance: far above fp16 rounding, far below the 0.5 between two block codes. */
export const TOL = 0.03;
/** MAX_LAYERS_PER_TIER (texture-manager.ts). */
const MAX_LAYERS = 256;
/** A load's bound: loadTexture has none, and a stalled load would hang the tab. */
export const LOAD_TIMEOUT_MS = 10000;

// ── The cookie ──────────────────────────────────────────────────────────────

/** TIER_SIZES[0]: the resize keeps every texel. */
export const COOKIE_SIZE = 64;
export const BLOCKS = 4;

/** Block (i, j)'s RGBA8: column i from the left, row j from the top. */
export function cookieTexel(i: number, j: number): [number, number, number, number] {
  const a = i === 2 && j === 1 ? 64 : i === 2 && j === 2 ? 128 : 255;
  return [85 * i, 85 * j, 255, a];
}

/** RGBA8, row by row from the top. */
export function cookiePixels(): Uint8Array {
  const block = COOKIE_SIZE / BLOCKS;
  const px = new Uint8Array(COOKIE_SIZE * COOKIE_SIZE * 4);
  for (let y = 0; y < COOKIE_SIZE; y++) {
    for (let x = 0; x < COOKIE_SIZE; x++) px.set(cookieTexel(Math.floor(x / block), Math.floor(y / block)), (y * COOKIE_SIZE + x) * 4);
  }
  return px;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32, the PNG chunks' checksum. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** RGBA8 as a PNG: filter 0, STORED deflate blocks, so the bytes depend on the pixels alone. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = 1 + width * 4;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  const z: number[] = [0x78, 0x01];
  for (let off = 0; ; off += 65535) {
    const len = Math.min(65535, raw.length - off);
    const last = off + len >= raw.length;
    z.push(last ? 1 : 0, len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff);
    for (let k = 0; k < len; k++) z.push(raw[off + k]);
    if (last) break;
  }
  const be32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  z.push(...be32(adler32(raw)));
  const chunk = (type: string, data: readonly number[]): number[] => {
    const body = new Uint8Array([...type].map((c) => c.charCodeAt(0)).concat(data));
    return [...be32(data.length), ...body, ...be32(crc32(body))];
  };
  const header = [...be32(width), ...be32(height), 8, 6, 0, 0, 0];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', header), ...chunk('IDAT', z), ...chunk('IEND', [])]);
}

/** A PNG as a data: URL (base64 in chunks: no argument-count limit). */
export function pngDataUrl(png: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < png.length; i += 0x2000) binary += String.fromCharCode(...png.subarray(i, i + 0x2000));
  return `data:image/png;base64,${btoa(binary)}`;
}

/** The same string on every call: a cache hit after the first load. */
export const COOKIE_URL = pngDataUrl(encodePng(COOKIE_SIZE, COOKIE_SIZE, cookiePixels()));
/** Named by a load failure instead of the 22 KB URL. */
const COOKIE_LABEL = 'the procedural cookie (a 64 x 64 PNG data: URL)';

/** A 1 x 1 PNG encoding `n`: one URL per layer it takes. */
export function fillerUrl(n: number): string {
  return pngDataUrl(encodePng(1, 1, new Uint8Array([n & 0xff, (n >>> 8) & 0xff, 90, 255])));
}

// ── Geometry ────────────────────────────────────────────────────────────────

/**
 * The cookie's texture uv of `local`, in the light's frame: the textured
 * quad's uv (quad_vs: position + 0.5), v turned over at the lookup as
 * sampleTierOrWhite turns every tier image (round step 8): the image upright,
 * its first row along local +y.
 */
export function cookieUv(local: Xy, range: number): [number, number] {
  return [local[0] / (2 * range) + 0.5, 0.5 - local[1] / (2 * range)];
}

/** The world point of cookie coordinates `uv` (texture uv, as cookieUv gives them) on a sprite light. */
export function cookiePoint(centre: Xy, theta: number, range: number, uv: Xy): [number, number] {
  const lx = (uv[0] - 0.5) * 2 * range;
  const ly = (0.5 - uv[1]) * 2 * range;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [centre[0] + lx * c - ly * s, centre[1] + lx * s + ly * c];
}

/** The world centres of the 16 blocks, row by row (j, then i). */
export function blockCentres(centre: Xy, theta: number, range: number): Array<{ i: number; j: number; at: [number, number] }> {
  const out: Array<{ i: number; j: number; at: [number, number] }> = [];
  for (let j = 0; j < BLOCKS; j++) {
    for (let i = 0; i < BLOCKS; i++) out.push({ i, j, at: cookiePoint(centre, theta, range, [(i + 0.5) / BLOCKS, (j + 0.5) / BLOCKS]) });
  }
  return out;
}

/** What a white `add` sprite light adds on block (i, j): energy × rgb × a. */
export function blockLight(i: number, j: number, energy: number): Rgb {
  const [r, g, b, a] = cookieTexel(i, j).map((v) => v / 255);
  return [energy * r * a, energy * g * a, energy * b * a];
}

/** The block a read shows: alpha from blue, then i and j from red and green; null if unlit. */
export function decodeBlock(read: readonly number[], floor: readonly number[], energy: number): { i: number; j: number; a: number } | null {
  const a = (read[2] - floor[2]) / energy;
  if (a < 0.05) return null;
  return { i: Math.round((3 * (read[0] - floor[0])) / (energy * a)), j: Math.round((3 * (read[1] - floor[1])) / (energy * a)), a };
}

/** The turned square's y-interval on the line x = `x`, or null. */
export function crossSection(centre: Xy, range: number, theta: number, x: number): [number, number] | null {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const dx = x - centre[0];
  let lo = -Infinity;
  let hi = Infinity;
  // |a + b·dy| <= range, local x: (a, b) = (dx·c, s); local y: (−dx·s, c).
  for (const [a, b] of [[dx * c, s], [-dx * s, c]]) {
    if (Math.abs(b) < 1e-12) {
      if (Math.abs(a) > range) return null;
      continue;
    }
    const e1 = (-range - a) / b;
    const e2 = (range - a) / b;
    lo = Math.max(lo, Math.min(e1, e2));
    hi = Math.min(hi, Math.max(e1, e2));
  }
  return lo <= hi ? [centre[1] + lo, centre[1] + hi] : null;
}

/** Edge at x = 0, view on the right: the square, `d` outside, reaches `depth` in; poke in the sliver, control past its tip. */
export function pokeGeometry(theta: number, range: number, depth: number): { d: number; poke: [number, number]; control: [number, number]; halfWidth: number } {
  const d = range * (Math.abs(Math.cos(theta)) + Math.abs(Math.sin(theta))) - depth;
  const section = crossSection([-d, 0], range, theta, depth / 2);
  if (!section) throw new Error(`pokeGeometry: the square misses x = ${depth / 2} at ${theta} rad`);
  const ymid = (section[0] + section[1]) / 2;
  return { d, poke: [depth / 2, ymid], control: [depth + 0.5, ymid], halfWidth: (section[1] - section[0]) / 2 };
}

// ── Verdicts ────────────────────────────────────────────────────────────────

/** The values read, then each cause found, joined by `; `. */
interface Verdict {
  ok: boolean;
  detail: string;
}

const deg = (theta: number): string => `${Math.round((theta * 180) / Math.PI)}°`;
const plus = (a: readonly number[], b: readonly number[]): Rgb => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** The square's symmetries and what each says about the mapping. */
const SYMMETRIES: Array<{ map: (i: number, j: number) => [number, number]; cause: string }> = [
  { map: (i, j) => [3 - i, j], cause: 'every block read as its mirror left to right: u is flipped' },
  { map: (i, j) => [i, 3 - j], cause: 'every block read as its mirror top to bottom: v is flipped (the uv convention): light-accum.wgsl misses the flip of sampleTierOrWhite before the cookie sample, or its out.uv is not the quad uv' },
  { map: (i, j) => [3 - i, 3 - j], cause: 'every block read half a turn off' },
  { map: (i, j) => [j, i], cause: 'every block read transposed: u and v are swapped' },
  { map: (i, j) => [3 - j, 3 - i], cause: 'every block read transposed across the other diagonal' },
  { map: (i, j) => [j, 3 - i], cause: 'every block read a quarter turn off: the square or its uv does not turn with the light' },
  { map: (i, j) => [3 - j, i], cause: 'every block read a quarter turn off: the square or its uv does not turn with the light' },
];

/** blockCentres' order. */
const BLOCK_ORDER = Array.from({ length: BLOCKS * BLOCKS }, (_, n) => ({ i: n % BLOCKS, j: Math.floor(n / BLOCKS) }));

/** K at `theta`: the 16 block centres (blockCentres' order) and the floor, one frame. */
export interface CookieRead {
  theta: number;
  values: Rgba[];
  floor: Rgba;
  /** The name in the detail; the angle by default. */
  label?: string;
  /** The block each centre shows (MIRRORS); (i, j) by default. */
  expect?: (i: number, j: number) => [number, number];
}

const same = (i: number, j: number): [number, number] => [i, j];

/** floor + blockLight of the expected block at every centre; a failure names the symmetry, a missing mirror, the alpha or the misreads. NaN-safe. */
export function cookieVerdict(reads: readonly CookieRead[], energy: number): Verdict {
  const parts: string[] = [];
  const causes: string[] = [];
  let ok = true;
  for (const r of reads) {
    const want = r.expect ?? same;
    const wrong = BLOCK_ORDER.filter(({ i, j }, n) => !(maxChannelDiff(r.values[n], plus(r.floor, blockLight(...want(i, j), energy))) <= TOL));
    const name = r.label ?? deg(r.theta);
    parts.push(`${name} ${BLOCK_ORDER.length - wrong.length}/${BLOCK_ORDER.length}`);
    if (wrong.length === 0) continue;
    ok = false;
    const decoded = BLOCK_ORDER.map(({ i, j }, n) => ({ i, j, got: decodeBlock(r.values[n], r.floor, energy) }));
    const shows = (d: (typeof decoded)[number], [ei, ej]: [number, number]): boolean => d.got !== null && d.got.i === ei && d.got.j === ej;
    const at = `at ${name}`;
    if (decoded.every((d) => d.got === null)) {
      causes.push(`${at}: nothing lit at any block (the light is culled, untextured, or not drawn)`);
      continue;
    }
    if (r.expect) {
      const plain = decoded.every((d) => shows(d, [d.i, d.j]));
      if (plain || decoded.every((d) => shows(d, [3 - d.i, 3 - d.j]))) {
        causes.push(`${at}: every block read ${plain ? 'unmirrored' : 'half a turn off, not mirrored'}: the side axis does not follow the transform's determinant (spriteAxes)`);
        continue;
      }
    }
    const symmetry = SYMMETRIES.find(({ map }) => decoded.every((d) => shows(d, map(...want(d.i, d.j)))));
    if (symmetry) {
      causes.push(`${at}: ${symmetry.cause}`);
      continue;
    }
    const sameBlocks = decoded.every((d) => shows(d, want(d.i, d.j)));
    const translucentOnly = wrong.every(({ i, j }) => {
      const [wi, wj] = want(i, j);
      return wi === 2 && (wj === 1 || wj === 2);
    });
    if (sameBlocks && translucentOnly) {
      causes.push(`${at}: only the translucent blocks (2,1) and (2,2) are off: the cookie's alpha is not the weight`);
      continue;
    }
    const misread = decoded.filter((d) => !shows(d, want(d.i, d.j))).slice(0, 4)
      .map((d) => `(${d.i},${d.j}) read ${d.got ? `(${d.got.i},${d.got.j}) a ${d.got.a.toFixed(2)}` : 'unlit'}`);
    causes.push(`${at}: ${wrong.length} blocks off${misread.length > 0 ? `: ${misread.join(', ')}` : ' within their codes: a value off by more than TOL (or not finite)'}`);
  }
  return { ok, detail: [`blocks ${parts.join(', ')}`, ...causes].join('; ') };
}

/** A white mix sprite light over `floor` on block (i, j): floor·(1 − a) + energy × rgb·a. */
export function blockMix(floor: readonly number[], i: number, j: number, energy: number): Rgb {
  const [r, g, b, a] = cookieTexel(i, j).map((v) => v / 255);
  return over([floor[0], floor[1], floor[2]], straight([energy * r, energy * g, energy * b], a));
}

/** K in mix, unturned: blockMix at every centre; names a mix added like add or a weight blind to alpha. NaN-safe. */
export function mixVerdict(r: CookieRead, energy: number): Verdict {
  const near = (n: number, want: readonly number[]): boolean => maxChannelDiff(r.values[n], want) <= TOL;
  const off = BLOCK_ORDER.filter(({ i, j }, n) => !near(n, blockMix(r.floor, i, j, energy)));
  const detail = `mix ${r.label ?? deg(r.theta)} ${BLOCK_ORDER.length - off.length}/${BLOCK_ORDER.length}`;
  if (off.length === 0) return { ok: true, detail };
  const target = (i: number, j: number): Rgb => {
    const [cr, cg, cb] = cookieTexel(i, j).map((v) => (energy * v) / 255);
    return [cr, cg, cb];
  };
  const cause = BLOCK_ORDER.every(({ i, j }, n) => near(n, plus(r.floor, blockLight(i, j, energy))))
    ? 'mix added like add (floor + target × alpha)'
    : BLOCK_ORDER.every(({ i, j }, n) => near(n, target(i, j)))
      ? "the mix weight ignores the cookie's alpha (the target at every block)"
      : `${off.length} blocks off: ${off.slice(0, 4).map(({ i, j }) => `(${i},${j})`).join(', ')}`;
  return { ok: false, detail: `${detail}; ${cause}` };
}

/** The cookie's array (primary or overflow), from engine.debug.textureTiers. */
export interface TierCount {
  used: number;
  allocated: number;
}

/** What 'Cookie tier grows while the light draws' read. */
export interface GrowthReads {
  before: TierCount;
  after: TierCount;
  fillerLayers: number[];
  /** The first frame after the growth. */
  first: CookieRead;
  /** After a turn. */
  turned: CookieRead;
  /** That frame at `first`'s centres: a frozen buffer still shows `first`. */
  turnedAtFirst: CookieRead;
  /** Uncaptured GPU errors from the first filler on; null without a witness. */
  errors: number | null;
  errorMessages: readonly string[];
}

/** The tier doubled, the fillers took the next layers, the cookie drew right after the growth and after a turn, no GPU error. */
export function growthVerdict(r: GrowthReads, energy: number): Verdict {
  const causes: string[] = [];
  if (r.after.allocated !== 2 * r.before.allocated) causes.push(`the tier did not double: ${r.before.allocated} -> ${r.after.allocated} layers`);
  const want = Array.from({ length: r.fillerLayers.length }, (_, k) => r.before.used + k);
  if (r.fillerLayers.join() !== want.join()) causes.push(`the fillers took layers ${r.fillerLayers.join(',')}, not ${want[0]}-${want.at(-1)}`);
  const first = cookieVerdict([r.first], energy);
  if (!first.ok) causes.push(`first frame after the growth: ${first.detail}`);
  const turned = cookieVerdict([r.turned], energy);
  if (!turned.ok) {
    const frozen = cookieVerdict([r.turnedAtFirst], energy).ok;
    causes.push(frozen
      ? `after the turn the light buffer still shows ${deg(r.first.theta)}: the frames since the growth did not run (a stale texture group?)`
      : `after the turn: ${turned.detail}`);
  }
  if (r.errors === null) causes.push('no GPU error witness: no main-thread device');
  else if (r.errors > 0) causes.push(`${r.errors} GPU errors (${r.errorMessages.length > 0 ? r.errorMessages.slice(0, 2).join(' | ') : 'messages not kept: cap reached'})`);
  const counts = `${r.before.allocated} -> ${r.after.allocated} layers (${r.fillerLayers.length} fillers, layers ${r.fillerLayers[0]}-${r.fillerLayers.at(-1)}), `
    + `cookie ${deg(r.first.theta)} and ${deg(r.turned.theta)}, ${r.errors ?? '?'} GPU errors`;
  return { ok: causes.length === 0, detail: [counts, ...causes].join('; ') };
}

/** One angle: the reads, and whether the light list held K. */
export interface PopRead {
  theta: number;
  poke: Rgba;
  control: Rgba;
  floor: Rgba;
  listed: boolean;
}

/** The sliver lit (half K's blue at least), the control at the floor. */
export function popVerdict(reads: readonly PopRead[], energy: number): Verdict {
  const causes: string[] = [];
  const rows = reads.map((r) => {
    const lit = r.poke[2] - r.floor[2] >= energy / 2;
    const controlDark = maxChannelDiff(r.control, r.floor) <= TOL;
    if (!lit) {
      causes.push(r.listed
        ? `${deg(r.theta)}: listed but the sliver is dark (the square does not turn with the light, or is smaller than range)`
        : `${deg(r.theta)}: K is not in the light list (its culling radius is under range·√2)`);
    }
    if (!controlDark) causes.push(`${deg(r.theta)}: lit past the square's tip (the square is larger than range)`);
    return `${deg(r.theta)} ${(r.poke[2] - r.floor[2]).toFixed(3)}/${(r.control[2] - r.floor[2]).toFixed(3)}${r.listed ? '' : ' unlisted'}`;
  });
  return { ok: causes.length === 0, detail: [`blue over the floor, sliver/control: ${rows.join(', ')}`, ...causes].join('; ') };
}

/** The shadow check's reads and the frame's groups. */
export interface ShadowReads {
  S: Rgba;
  S2: Rgba;
  U: Rgba;
  floor: Rgba;
  groups: number;
  sdfSets: number;
}

/** L's blue: S at most 0.1, S' at least 0.9, U at least 0.8 (opaque blocks). NaN-safe. */
export function spriteShadowVerdict(r: ShadowReads, energy: number): Verdict {
  const share = (v: Rgba): number => (v[2] - r.floor[2]) / energy;
  const [s, s2, u] = [share(r.S), share(r.S2), share(r.U)];
  const causes: string[] = [];
  const bad = (['S', 'S2', 'U', 'floor'] as const).filter((k) => !r[k].slice(0, 3).every(Number.isFinite));
  if (bad.length > 0) causes.push(`a non-finite read at ${bad.map((k) => (k === 'S2' ? "S'" : k)).join(', ')}`);
  if (!(s <= 0.1) && bad.length === 0) {
    causes.push(r.sdfSets === 0
      ? 'S is lit behind the wall, and the frame has no SDF set: light-groups.ts does not count a shadowed sprite light'
      : 'S is lit behind the wall with an SDF set: light-accum.wgsl does not march for a sprite light, or marches along its facing');
  }
  if (!(s2 >= 0.9) && bad.length === 0) causes.push(`S' is shadowed in the open (${s2.toFixed(3)})`);
  if (!(u >= 0.8) && bad.length === 0) causes.push(`U, between the light and the wall, is shadowed (${u.toFixed(3)}): the march runs away from the light`);
  const detail = `L's light at S ${s.toFixed(3)}, S' ${s2.toFixed(3)}, U ${u.toFixed(3)}; ${r.groups} group(s), ${r.sdfSets} SDF set(s)`;
  return { ok: causes.length === 0, detail: [detail, ...causes].join('; ') };
}

// ── The checks ──────────────────────────────────────────────────────────────

const NAMES = ['Sprite cookie at known texels', 'Cookie tier grows while the light draws', 'Sprite light: no pop at the frustum edge', 'Sprite light shadow behind a wall'];

/**
 * The four checks; `restoreView` brings the camera back. Every handle also
 * goes into `entities` and is destroyed here whatever happens. No
 * engine.debug, or no texture (Mode A): four skips, nothing spawned.
 */
export async function checkSprite(
  engine: Hyperion,
  reporter: TestReporter,
  entities: EntityHandle[],
  floor: Rgb,
  restoreView: () => void,
  { loadTimeoutMs = LOAD_TIMEOUT_MS }: { loadTimeoutMs?: number } = {},
): Promise<void> {
  const debug = engine.debug;
  if (!debug) {
    for (const name of NAMES) reporter.skip(name, 'pixel probe unavailable: production build');
    return;
  }
  const load = async (url: string, tierIndex?: number): Promise<number> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${loadTimeoutMs} ms`)), loadTimeoutMs);
    });
    try {
      return await Promise.race([engine.loadTexture(url, tierIndex), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  // Before the first load: a first allocation replaces a placeholder too.
  const witness = gpuErrorWitness(engine);
  let cookie: number;
  try {
    cookie = await load(COOKIE_URL);
  } catch (err) {
    witness?.stop();
    for (const name of NAMES) reportTextureLoadFailure(reporter, name, COOKIE_LABEL, err);
    return;
  }
  const [cx, cy] = SPRITE_SCENE;
  const at = ([x, y]: Xy): [number, number] => [cx + x, cy + y];
  const scene: EntityHandle[] = [];
  const keep = (h: EntityHandle): EntityHandle => {
    scene.push(h);
    entities.push(h);
    return h;
  };
  const sprite = (range: number, shadowIntensity = 0): LightOptions => ({ type: 'sprite', color: [1, 1, 1], energy: ENERGY, range, shadowIntensity });
  // The floor's light group (layer 0), read right before each probe.
  const floorGroup = (): number => (engine.lighting.groups?.layerToGroup[0] ?? 0) & 0xf;
  const { tier: cookieTier, layer: cookieLayer, overflow } = unpackTextureIndex(cookie);
  const count = (): TierCount | null => {
    const t = debug.textureTiers()?.tiers[cookieTier];
    if (!t) return null;
    return overflow ? { used: t.overflowLayers, allocated: t.overflowAllocated } : { used: t.layers, allocated: t.allocated };
  };
  try {
    fitView(engine, cx, cy, SUB_HALF_WIDTH);
    let k!: EntityHandle;
    engine.batch(() => {
      keep(engine.spawn().position(cx, cy, -0.5).scale(200, 100, 1).receivesLight(true));
      k = keep(engine.spawn({ mode: '2d' }).position(...at(K_AT)).scale(3, 0.5).rotation(COOKIE_THETAS[0]).light(sprite(K_RANGE)).texture(cookie));
      keep(engine.spawn({ mode: '2d' }).position(...at(L_AT)).rotation(L_THETA).light(sprite(L_RANGE, 1)).texture(cookie));
      keep(engine.spawn().position(...at(W_AT), 0).scale(W_SIZE[0], W_SIZE[1], 1).castsShadow(true));
    });
    await frames(4);
    const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
    const density = (): string => `${lightTexelsPerUnit(engine.cam.viewProjection, halfResolution(canvas?.width ?? 0, canvas?.height ?? 0)).toFixed(3)} light texels per unit`;
    const index = `cookie ${overflow ? 'overflow' : 'primary'} tier ${cookieTier} layer ${cookieLayer}`;
    const readCookie = async (probe: (world: [number, number][]) => Promise<Rgba[]>, ...thetas: number[]): Promise<CookieRead[]> => {
      const values = await probe([...thetas.flatMap((theta) => blockCentres(at(K_AT), theta, K_RANGE).map((b) => b.at)), at(FLOOR_AT)]);
      const floorRead = values[values.length - 1];
      return thetas.map((theta, t) => ({ theta, values: values.slice(16 * t, 16 * t + 16), floor: floorRead }));
    };

    // ── 1. The cookie at known texels: three angles, two mirrors, a mix ─
    await pixelCheck(reporter, NAMES[0], engine, async (probe) => {
      const read = (world: [number, number][]): Promise<Rgba[]> => probe('light-buffer', world, floorGroup());
      const reads: CookieRead[] = [];
      for (const theta of COOKIE_THETAS) {
        k.rotation(theta);
        await frames(4);
        reads.push(...await readCookie(read, theta));
      }
      k.rotation(0);
      for (const m of MIRRORS) {
        k.scale(...m.scale);
        await frames(4);
        const [r] = await readCookie(read, 0);
        reads.push({ ...r, label: m.label, expect: m.expect });
      }
      k.scale(3, 0.5);
      k.light({ ...sprite(K_RANGE), blend: 'mix' });
      await frames(4);
      const [mixRead] = await readCookie(read, 0);
      k.light(sprite(K_RANGE)).rotation(COOKIE_THETAS[COOKIE_THETAS.length - 1]);
      const verdict = cookieVerdict(reads, ENERGY);
      const mix = mixVerdict(mixRead, ENERGY);
      // Nothing else of the tab may reach the floor.
      const floorOff = !(maxChannelDiff(reads[0].floor, floor) <= TOL);
      const floorCause = floorOff ? `; the floor reads ${fmt(reads[0].floor.slice(0, 3))}, not the tab's ${fmt(floor)}: another light reaches the sub-scene` : '';
      const errors = witness ? `${witness.count} GPU errors since the cookie loaded${witness.count > 0 ? ` (${witness.messages.slice(0, 2).join(' | ')})` : ''}` : 'no GPU error witness: no main-thread device';
      const ok = verdict.ok && mix.ok && !floorOff && witness !== null && witness.count === 0;
      return { ok, detail: `${verdict.detail}; ${mix.detail}${floorCause}; ${errors}; ${index}; ${density()}` };
    });

    // ── 2. The cookie's tier grows while K draws, with no GPU error ─────
    const before = count();
    if (before && before.allocated >= MAX_LAYERS) {
      reporter.skip(NAMES[1], `the cookie's tier is full (${before.allocated} layers): reload the page to run this check again`);
    } else {
      await pixelCheck(reporter, NAMES[1], engine, async (probe) => {
        if (!before) return { ok: false, detail: 'engine.debug.textureTiers() returned nothing after the cookie loaded' };
        // K as read here, whatever check 1 left.
        const lastTheta = COOKIE_THETAS[COOKIE_THETAS.length - 1];
        k.scale(3, 0.5).light(sprite(K_RANGE)).rotation(lastTheta);
        await frames(4);
        const errorsBefore = witness?.count ?? 0;
        const firstMessage = witness?.messages.length ?? 0;
        const fillerLayers: number[] = [];
        const need = before.allocated - before.used + 1;
        for (let n = 0; n < need; n++) {
          try {
            fillerLayers.push(unpackTextureIndex(await load(fillerUrl(before.used + n), cookieTier)).layer);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, detail: `cannot load filler ${before.used + n} (a 1 x 1 PNG data: URL): ${msg}; ${n} of ${need} fillers loaded` };
          }
        }
        // The frame right after the growth.
        const [first] = await readCookie((world) => probe('light-buffer', world, floorGroup()), lastTheta);
        k.rotation(0);
        await frames(4);
        const [turned, turnedAtFirst] = await readCookie((world) => probe('light-buffer', world, floorGroup()), 0, lastTheta);
        await frames(2);  // an uncaptured error arrives after its frame
        const verdict = growthVerdict({
          before, after: count() ?? before, fillerLayers, first, turned, turnedAtFirst,
          errors: witness ? witness.count - errorsBefore : null,
          errorMessages: witness ? witness.messages.slice(firstMessage) : [],
        }, ENERGY);
        return { ok: verdict.ok, detail: `${verdict.detail}; ${index}; primary tiers ${debug.textureTiers()?.compressedFormat ?? 'rgba8unorm'}` };
      });
    }

    // ── 3. No pop at the frustum edge, at every angle of a quarter turn ──
    await pixelCheck(reporter, NAMES[2], engine, async (probe) => {
      k.light(sprite(POP_RANGE));
      const [xLeft] = viewBounds(engine.cam.viewProjection);
      const reads: PopRead[] = [];
      for (const theta of POP_THETAS) {
        const g = pokeGeometry(theta, POP_RANGE, POKE_DEPTH);
        k.position(xLeft - g.d, cy).rotation(theta);
        await frames(4);
        const [poke, control, floorRead] = await probe('light-buffer', [[xLeft + g.poke[0], cy + g.poke[1]], [xLeft + g.control[0], cy + g.control[1]], at(FLOOR_AT)], floorGroup());
        reads.push({ theta, poke, control, floor: floorRead, listed: engine.lighting.groups?.lightIds.includes(k.id) ?? false });
      }
      const verdict = popVerdict(reads, ENERGY);
      return { ok: verdict.ok, detail: `${verdict.detail}; range ${POP_RANGE}, sliver ${POKE_DEPTH} deep; ${density()}` };
    });

    // ── 4. L's shadow behind W ─────────────────────────────────────────
    await pixelCheck(reporter, NAMES[3], engine, async (probe) => {
      const [S, S2, U, floorRead] = await probe('light-buffer', [at(SHADOW_POINTS.S), at(SHADOW_POINTS.S2), at(SHADOW_POINTS.U), at(FLOOR_AT)], floorGroup());
      const g = engine.lighting.groups;
      return spriteShadowVerdict({ S, S2, U, floor: floorRead, groups: g?.groups.length ?? 0, sdfSets: g?.sdfSets.length ?? 0 }, ENERGY);
    });
  } finally {
    for (const h of scene) h.destroy();
    await frames(4);
    witness?.stop();
    restoreView();
  }
}
```

- [ ] **Step 5: il tab Lighting e il check di 2D Twins.** In `ts/src/demo/lighting.ts`, dopo `import { checkMix } from './lighting-mix';` (`:8`):
```ts
import { checkSprite } from './lighting-sprite';
```
  L'etichetta (`:53`) diventa:
```ts
  label: 'Lighting (point / spot / directional / global / sprite, add / mix, shadows, lit vs unlit)',
```
  Dopo `await checkMix(…);` (`:180`), prima del blocco "Motion":
```ts

    // ── 8. The sprite light, on a sub-scene right of this one ──────────
    // (round step 8): the cookie, its tier's growth, the frustum edge, the
    // shadow. Skipped in Mode A, where no texture loads.
    await checkSprite(engine, reporter, entities, floor, () => fitView(engine, 0, 0, SCENE_HALF_WIDTH));
```
  In `ts/src/demo/twin-2d.ts`, in fondo al commento di testa (dopo "// id column."):
```ts
// A last one, far off at (-80, 60) and destroyed afterwards, reads a textured
// quad and a textured line: the image upright (round step 8).
```
  dopo la chiusura di `checkTransparentSort`, prima di `const section: DemoSection = {`:
```ts

/** Centre of the image-orientation scene: far from the twins (|x| <= 18), the depth scene (x 22-58), the order scene (y -60) and the sort scene (x 80). */
const IMAGE_X = -80;
const IMAGE_Y = 60;
/** The quad (scale 4) left of the centre, the line (from local x -3 to 3, width 2) right of it. */
const IMAGE_QUAD_X = IMAGE_X - 5;
const IMAGE_LINE_X = IMAGE_X + 4;
/**
 * sort-test-128.png's quadrants (scripts/gen-sort-test-png.mjs), from the
 * image's top left, row by row. An opaque sprite draws their rgb: the opaque
 * pipeline ignores the alpha (160).
 */
export const IMAGE_QUADRANTS: ReadonlyArray<{ name: 'TL' | 'TR' | 'BL' | 'BR'; rgb: Rgb }> = [
  { name: 'TL', rgb: [230 / 255, 60 / 255, 60 / 255] },
  { name: 'TR', rgb: [60 / 255, 200 / 255, 90 / 255] },
  { name: 'BL', rgb: [60 / 255, 110 / 255, 230 / 255] },
  { name: 'BR', rgb: [240 / 255, 200 / 255, 50 / 255] },
];
/** Per-channel tolerance against a quadrant: the closest two differ by 0.549, an 8-bit decode and copy by far less. */
const IMAGE_TOLERANCE = 0.03;
/** Where a shape's four reads lie, in their order. */
const IMAGE_CORNERS = ['upper left', 'upper right', 'lower left', 'lower right'] as const;
/** The square's 8 symmetries, as the quadrant (IMAGE_QUADRANTS' index) each corner shows. */
const IMAGE_SYMMETRIES: ReadonlyArray<{ shows: readonly number[]; name: string }> = [
  { shows: [0, 1, 2, 3], name: 'upright' },
  { shows: [2, 3, 0, 1], name: 'v flipped (sampleTierOrWhite does not turn v over)' },
  { shows: [1, 0, 3, 2], name: 'u flipped' },
  { shows: [3, 2, 1, 0], name: 'half a turn off' },
  { shows: [0, 2, 1, 3], name: 'transposed (u and v swapped)' },
  { shows: [3, 1, 2, 0], name: 'transposed across the other diagonal' },
  { shows: [1, 3, 0, 2], name: 'a quarter turn off' },
  { shows: [2, 0, 3, 1], name: 'three quarters of a turn off' },
];

/** What 'Textured quad and line show their image upright' read: each shape's corners, in IMAGE_CORNERS' order, and the clear beside them. */
export interface ImageReads {
  quad: readonly Rgb[];
  line: readonly Rgb[];
  clear: Rgb;
}

/**
 * Each read decoded to the quadrant within IMAGE_TOLERANCE; a shape passes
 * upright. A failure names its symmetry (v flipped: the lookup does not turn
 * v over), a flip in one library only (the line alone flipped: the flip moved
 * into quad_vs, or a second one in line_vs; the quad alone: a second flip in
 * quad_vs, or the flip moved into line_vs), a shape that draws nothing, or
 * the reads no quadrant explains. NaN-safe.
 */
export function imageOrientationVerdict(r: ImageReads): { ok: boolean; detail: string } {
  const decode = (v: Rgb): number => IMAGE_QUADRANTS.findIndex((q) => maxChannelDiff(v, q.rgb) <= IMAGE_TOLERANCE);
  const shape = (name: 'quad' | 'line', reads: readonly Rgb[]) => {
    const shows = reads.map(decode);
    return {
      name,
      shows,
      symmetry: IMAGE_SYMMETRIES.find((s) => s.shows.every((q, k) => shows[k] === q)),
      nothing: reads.every((v) => maxChannelDiff(v, r.clear) <= IMAGE_TOLERANCE),
      unread: reads.flatMap((v, k) => (shows[k] < 0 ? [`the ${IMAGE_CORNERS[k]} (${fmt(v)})`] : [])),
    };
  };
  const quad = shape('quad', r.quad);
  const line = shape('line', r.line);
  const upright = (s: typeof quad): boolean => s.symmetry === IMAGE_SYMMETRIES[0];
  const vFlipped = (s: typeof quad): boolean => s.symmetry === IMAGE_SYMMETRIES[1];
  const causes: string[] = [];
  if (upright(quad) && vFlipped(line)) causes.push('the line only is v flipped: one library turns v over on its own (the flip moved from sampleTierOrWhite into quad_vs, or a second flip in line_vs)');
  else if (upright(line) && vFlipped(quad)) causes.push('the quad only is v flipped: one library turns v over on its own (a second flip in quad_vs, or the flip moved from sampleTierOrWhite into line_vs)');
  else {
    for (const s of [quad, line]) {
      if (upright(s)) continue;
      if (s.nothing) causes.push(`the ${s.name} draws nothing (the clear at its four corners)`);
      else if (s.symmetry) causes.push(`the ${s.name} is ${s.symmetry.name}`);
      else causes.push(`the ${s.name}: no quadrant within ${IMAGE_TOLERANCE} at ${s.unread.join(', ')}`);
    }
  }
  const show = (s: typeof quad): string => `${s.name} ${s.shows.map((q) => (q < 0 ? '?' : IMAGE_QUADRANTS[q].name)).join(' ')}`;
  return { ok: causes.length === 0, detail: [`${show(quad)}, ${show(line)} (at the upper left, upper right, lower left, lower right)`, ...causes].join('; ') };
}

/**
 * A textured quad and a textured line, opaque, show sort-test-128.png upright
 * (round step 8, sub-decision 2 (e)): the image's top-left quadrant at the
 * upper left of the quad, and at the upper left of the line drawn from left
 * to right. Its four distinct quadrants tell every symmetry of the square
 * apart, so a v flip (the image upside down, as before round step 8) and a
 * flip moved into one library's uv are named. Far off at (-80, 60), destroyed
 * afterwards; the caller restores the camera.
 */
export async function checkImageOrientation(engine: Hyperion, reporter: TestReporter): Promise<void> {
  const name = 'Textured quad and line show their image upright';
  if (!engine.debug) {
    reporter.skip(name, 'pixel probe unavailable: production build');
    return;
  }
  let texture: TextureHandle;
  try {
    texture = await engine.loadTexture(ORDER_TEXTURE_URL);
  } catch (err) {
    // A skip only without a main-thread renderer (Mode A); a missing or broken texture fails.
    reportTextureLoadFailure(reporter, name, ORDER_TEXTURE_URL, err);
    return;
  }
  fitView(engine, IMAGE_X, IMAGE_Y, 9);
  const own: EntityHandle[] = [];
  const keep = (h: EntityHandle): EntityHandle => {
    own.push(h);
    entities.push(h);
    return h;
  };
  engine.batch(() => {
    keep(engine.spawn({ mode: '2d' }).position(IMAGE_QUAD_X, IMAGE_Y).scale(4, 4).texture(texture));
    keep(engine.spawn({ mode: '2d' }).position(IMAGE_LINE_X, IMAGE_Y).line(-3, 0, 3, 0, 2).texture(texture));
  });
  await frames(4);
  try {
    await pixelCheck(reporter, name, engine, async (probe) => {
      // A shape's four quadrant centres, in IMAGE_CORNERS' order.
      const corners = (x: number, y: number, dx: number, dy: number): [number, number][] =>
        [[x - dx, y + dy], [x + dx, y + dy], [x - dx, y - dy], [x + dx, y - dy]];
      const values = (await probe('scene-hdr', [
        ...corners(IMAGE_QUAD_X, IMAGE_Y, 1, 1), ...corners(IMAGE_LINE_X, IMAGE_Y, 1.5, 0.5), [IMAGE_X, IMAGE_Y + 4],
      ])).map(([r, g, b]): Rgb => [r, g, b]);
      return imageOrientationVerdict({ quad: values.slice(0, 4), line: values.slice(4, 8), clear: values[8] });
    });
  } finally {
    for (const h of own) if (h.alive) h.destroy();
  }
}
```
  e in `setup`, dopo `await checkTransparentSort(engine, reporter);` (`:595`):
```ts
    // ── 6. Images upright: a textured quad and a textured line (round step 8) ──
    await checkImageOrientation(engine, reporter);
```
  I centri dei quadranti del quad stanno a 1 unità dai confini fra i quadranti, quelli della linea a 0,5 (la linea è larga 2, più 1 px di margine): a zoom 1 sulla tela dell'harness (1960×1248, 20 unità di altezza) circa 62 e 31 px, quindi nessun punto va spostato sul centro di un texel. In Mode A la texture non si carica e il check salta prima di spawnare.
- [ ] **Step 6: GREEN.** Il comando dello Step 2: `lighting-sprite` 28/28, `probe-checks` 25/25, `hyperion` 110/110, `twin-2d` 12/12; `npm --prefix ts test`: 116 file, 2215 + 7 saltati; `tsc` pulito; `node:test` 64/64. I mutanti, oltre ai difetti del modello (uno alla volta; ciascuno fa fallire almeno un test di `lighting-sprite`, `probe-checks` o `twin-2d`): `fillerUrl(n)` al posto di `fillerUrl(before.used + n)`; `event.preventDefault();` in `gpuErrorWitness`; `for (const m of MIRRORS.slice(0, 0))`; la lettura in mix con `k.light(sprite(K_RANGE))`; `cookieVerdict` con `maxChannelDiff(…) > TOL`; `spriteShadowVerdict` senza la causa dei NaN; `load` senza la corsa col limite (il test arriva al timeout di vitest); il check del cookie senza il testimone nell'`ok`; la crescita con `witness.messages` senza `slice(firstMessage)`; `mixVerdict` che si aspetta la somma; `imageOrientationVerdict` che ignora la linea (`for (const s of [quad])` e senza i due rami «only»); `imageOrientationVerdict` che accetta una v girata (`const upright = (s: typeof quad): boolean => s.symmetry === IMAGE_SYMMETRIES[0] || s.symmetry === IMAGE_SYMMETRIES[1];`); `cookieUv` col v di prima (`local[1] / (2 * range) + 0.5`).
- [ ] **Step 7: commit**
```bash
git add ts/src/demo/lighting-sprite.ts ts/src/demo/lighting-sprite.test.ts ts/src/demo/lighting.ts ts/src/demo/twin-2d.ts ts/src/demo/twin-2d.test.ts ts/src/demo/probe-checks.ts ts/src/demo/probe-checks.test.ts ts/src/hyperion.ts ts/src/hyperion.test.ts
git commit -m "test(8): quattro check della luce sprite nel tab Lighting, quello delle immagini diritte in 2D Twins, engine.debug.textureTiers e gpuErrorWitness" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
- [ ] **Step 7b: l'audit dei check, prima delle gambe** (il controller; CLAUDE.md: "Run it after changing a check and before a `/gpu-check` run"): `harness-check-auditor` su `ts/src/demo/lighting-sprite.ts` (+ test), `gpuErrorWitness`, `demo/lighting.ts` e `demo/twin-2d.ts` (+ test: il check nuovo e il punto spostato di 'Depth orders transparent sprites'), sui commit del Task 3 Step 0 e del Task 5. Un finding: test rosso, correzione, verde, commit `fix(8): audit dei check — <titolo>`, prima dello Step 8; il rapporto nello spazio SDD. L'auditor del Task 8 resta l'audit finale.
- [ ] **Step 8: il tab Lighting sul device** (il controller): due gambe di `gpu-leg`, `head` = `git rev-parse HEAD` dopo lo Step 7b (lo Step 7 più le correzioni `fix(8)` della tornata SDD e dell'audit: con lo SHA dello Step 7 la gamba torna BLOCKED), `evidenceDir: 'docs/plans/assets/2026-10-14-step8'`.
  1. **RED, sul `ts/wasm` di base** (il raggio vecchio; non si ricostruisce). `gpu-infra.sh up`; il `context` dei Vincoli globali con la frase su `ts/wasm`.
     - Passi: `shasum -a 256 ts/wasm/hyperion_core_bg.wasm`; una pagina `"http://localhost:5173/?mode=B&bench"` (come al Task 3, tela 1960×1248); `tools/lighting-tab.js` con filePath `<ev>/harness-task5-red-B.json`; `__viteWsCloses` e la console.
     - Aspettative: lo SHA-256 del `.wasm` è `<lo SHA-256 del Task 0 Step 2, copiato dal registro SDD prima della gamba>` (il verificatore giudica solo sulle aspettative); 16 check; 'Sprite light: no pop at the frustum edge' `fail`, con "K is not in the light list (its culling radius is under range·√2)" per 15°, 30°, 45°, 60° e 75° e non per 0°; tutti gli altri `pass`; al più il 404 di `favicon.ico`. Poi `gpu-infra.sh down`.
  2. **GREEN.** `npm --prefix ts run build:wasm`, `gpu-infra.sh up --git /old-prelude.wgsl=443dc7f:ts/src/shaders/primitives/prelude.wgsl` (il preludio di prima, per la RED delle immagini).
     - Passi: la stessa sessione di pagina in `?mode=B&bench` → `harness-task5-B.json`, poi `node docs/plans/assets/2026-10-14-step8/tools/step8-compare.mjs details docs/plans/assets/2026-10-14-step8/harness-task5-B.json docs/plans/assets/2026-10-08-step7/baseline/statuses-B.json > docs/plans/assets/2026-10-14-step8/harness-task5-B.details.json; echo "exit $?"` (i check dei passi 3, 6 e 7, gli id della lista mascherati; exit 3 = tela sbagliata: si rifà la pagina una volta); sulla stessa pagina `tools/twin-tab.js` → `<ev>/twin-task5-B.json`; poi, solo in B, la RED delle immagini sul device, il preludio di `443dc7f` (il server degli asset risponde con `Access-Control-Allow-Origin: *`): `async () => { const text = await (await fetch('http://127.0.0.1:8765/old-prelude.wgsl', { cache: 'no-store' })).text(); window.__hyperion.recompileShader('prelude', text); await new Promise((resolve) => { let n = 60; const frame = () => (--n <= 0 ? resolve() : requestAnimationFrame(frame)); requestAnimationFrame(frame); }); return { bytes: text.length, flipGone: !text.includes('var image = in;') }; }` (`flipGone` true), e di nuovo `tools/twin-tab.js` → `<ev>/twin-task5-red-B.json`; poi una pagina nuova; lo stesso in `?mode=C&bench` (senza la RED delle immagini), contro `statuses-C.json`, con `twin-task5-C.json`.
     - Aspettative: Lighting 16/16 in B e C; 2D Twins: 7 check, in B 6 `pass` e 'Transparent sort under churn' `skip`, in C 7 `pass`; 'Textured quad and line show their image upright' `pass`, il dettaglio comincia con "quad TL TR BL BR, line TL TR BL BR"; 'Depth orders transparent sprites' `pass`, e nel suo dettaglio la cella 1 legge (0.686, 0.769, 0.307) ± 0.005, i valori dello statuses del passo 7; in `twin-task5-red-B.json` 'Textured quad and line show their image upright' `fail` con "the quad is v flipped (sampleTierOrWhite does not turn v over)" e "the line is v flipped", e 'Depth orders transparent sprites' `fail`, con "a pair looks the same in both orders"; il cookie comincia con "blocks 0° 16/16, 90° 16/16, 30° 16/16, y-mirrored 0° 16/16, x-mirrored 0° 16/16; mix 0° 16/16; 0 GPU errors since the cookie loaded; cookie overflow tier 0 layer 1"; la crescita comincia con "16 -> 32 layers (15 fillers, layers 2-16), cookie 30° and 0°, 0 GPU errors" e contiene "primary tiers bc7-rgba-unorm"; il pop: sei angoli, ogni scheggia ≥ 1.000, ogni controllo entro 0.030, nessun "unlisted"; l'ombra: S ≤ 0.100, S' ≥ 0.900, U ≥ 0.800, "1 group(s), 1 SDF set(s)"; `details` exit 0 in B e C; console: al più il 404, nessun avviso di sprite senza texture né errore WebGPU; da riportare: la durata di `lighting-tab.js` e i quattro dettagli. Poi `gpu-infra.sh down`.

  I verdetti in `docs/plans/assets/2026-10-14-step8/legs/task-5-red-result.json` e `task-5-green-result.json`, coi percorsi locali sostituiti. Con entrambe a `pass`:
```bash
git add docs/plans/assets/2026-10-14-step8/harness-task5-red-B.json docs/plans/assets/2026-10-14-step8/harness-task5-B.json docs/plans/assets/2026-10-14-step8/harness-task5-B.details.json docs/plans/assets/2026-10-14-step8/harness-task5-C.json docs/plans/assets/2026-10-14-step8/harness-task5-C.details.json docs/plans/assets/2026-10-14-step8/twin-task5-B.json docs/plans/assets/2026-10-14-step8/twin-task5-C.json docs/plans/assets/2026-10-14-step8/twin-task5-red-B.json docs/plans/assets/2026-10-14-step8/legs/task-5-red-result.json docs/plans/assets/2026-10-14-step8/legs/task-5-green-result.json
git commit -m "test(8): il tab Lighting sul Mac, 16/16 in B e C; col WASM di base fallisce solo il pop; 2D Twins mostra le immagini diritte, e col preludio di prima girate" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
  Un fallimento si indaga con `superpowers:systematic-debugging` prima di toccare una soglia.

### Task 6: i documenti (testo; i numeri sono del Task 10)

Lo shader non si tocca più (il Task 9 verifica il testo del Task 3). Ancore di `443dc7f`.

- [ ] **Step 1: commenti** che nominano la sprite e il suo raggio: `render-pass.ts:28` ("as point, spot and sprite lights use it"); `hit-tester.ts:70-71` ("is its range (a sprite light's, range·√2), and a global or directional light's covers the world"); `primitive-bindings.ts:3-7`, `:33-35` (il gruppo 1 serve anche `LightAccumStage`); `renderer.ts:366-367` ("every TextureTierBinding (ForwardPass, OccluderSeedStage, LightAccumStage) rebinds when it sees it"); `light-accum-stage.test.ts:516` ("(decision 3: the attenuation × cone × shadow; a sprite light's, its cookie's alpha × shadow)").
- [ ] **Step 2: design 17** (`docs/plans/2026-08-04-phase17-lighting-2d-design.md`): `:174` (il cookie, layer dei tier, gruppo 1 del preludio); `:313` ("sprite/cookie (✅ passo 8 del giro)"); `:420` (raggio `range·√2`); `:581` (il cookie al posto dell'attenuazione: colore × rgb, intensità = alpha); `:772` (slot 3: il semilato); `:775` (niente falloff per la sprite). Dopo `:610`, la nota "🆕 **La luce sprite, passo 8 del giro (2026-10-14).**" (Architettura, sotto-decisioni, evidenze in `docs/plans/assets/2026-10-14-step8/`, e la frase: le sprite prima non disegnavano nulla; con texture ora disegnano il cookie e, ombreggiate, aprono un set SDF; senza texture restano spente, con un avviso dev). Nel §10.2 (`:842-846`), dopo la nota del passo 7: il light buffer dipende anche dai contenuti dei tier a cui puntano gli indici delle righe (l'alpha di un caster texturizzato, già prima; dal passo 8 il cookie di una sprite), caricati per URL, fuori dal tape, dallo snapshot e da `state_hash`: un replay su una pagina fresca campiona quello che quei layer contengono lì. Nell'esempio del §11, dopo `:883`:
```ts
// Una luce sprite: il quadrato di semilato `range`, girato con la luce, prende forma e colori dal cookie (la texture dell'entità)
const cookie = await engine.loadTexture('/textures/vetrata.png');
const vetrata = engine.spawn({ mode: '2d' }).position(-20, 10).rotation(Math.PI / 8).texture(cookie)
  .light({ type: 'sprite', color: '#ffffff', energy: 1.5, range: 30, shadowIntensity: 1 });
```
- [ ] **Step 3: design dei light layers:** `:49` (gli input `texIndices` e, quando il renderer li dà, `textureLayersUsed`); `:53` (una regola per ogni tipo ombreggiato: conta solo con `range` > 0, perché `sunShadow` esce prima di leggere l'SDF, point e spot scartano ogni pixel a `d >= range` prima della marcia e `vs_main` scarta la sprite; una sprite conta solo con una texture che questo renderer ha caricato, secondo `untexturedPredicate`: layer ≠ 0 e, coi layer in uso, sotto quelli del suo array; senza colonna conta come texturizzata); dopo `:75` (`untexturedSpriteLight: boolean;`, e `untexturedSpriteIds`); `:92` (`tex-indices` anche per `LightAccumStage`). `PROJECT_ARCHITECTURE.md`: `:1839`, `:2777` (`LightAccumStage` usa `textureTierLayoutEntries()`); `:1841` (un tier nuovo va anche nel gruppo 1, nella copia di `sampleTier` e in `cookieLayers`); `:1265` (lo switch dei tier ha una copia in `light-accum.wgsl`, legata da un test; `sampleTierOrWhite` gira v dopo la risposta bianca, così l'immagine si disegna diritta, e il cookie ne copia le due righe).
- [ ] **Step 4: `CLAUDE.md`** (in inglese): `:183` (systems.rs: il raggio sprite); `:192` (hyperion.ts: `textureTiers` fra i dev); `:193` (entity-handle.ts: il cookie da `.texture()`, l'handle atteso prima della catena, `.texture(cookie)` e `.light()` in ogni ordine; l'immagine diritta di quad, linee e bezier); `:250` (renderer.ts: l'avviso `untexturedSpriteLight` dopo `UNTEXTURED_SPRITE_MS` (1 s) di frame illuminati, al più 100 ms per frame, in pausa finché `textureManager.pendingLoads` > 0, una volta, in dev, con fino a tre id (`persistentWarning`, `untexturedSpriteIds`, `untexturedSpriteMessage`); `FrameState.textureLayersUsed` da `textureLayerCounts`, un buffer per renderer); `:251` (texture-manager.ts: `pendingLoads`, i caricamenti in corso, che un rifiuto fa uscire); `:268` (light-groups.ts: la sprite nei gate se può disegnare; il gate SDF è una regola per ogni tipo ombreggiato, `range` > 0, più una texture per una sprite; un solo predicato, `untexturedPredicate`: il layer 0 (`TEXTURE_LAYER_MASK`) o, con `textureLayersUsed`, un layer pari o oltre quelli in uso del suo array, col ramo di default dei tier; il flag e `untexturedSpriteIds`); `:271` (primitive-bindings.ts: anche `LightAccumStage`); `:274` (frame-inputs.ts: `persistentWarning` a tempo, in pausa e col tetto, `UNTEXTURED_SPRITE_MS`, `HELD_STEP_CAP_MS`, `untexturedSpriteMessage`, `textureLayerCounts`); `:276` (light-accum-stage.ts: `spriteAxes`, `cullMode: 'none'` (a mirrored sprite light is wound clockwise; the entity pipelines keep 'back': round plan §4 (1b)), gruppo 1 risolto a ogni `encode(…, resources)`, binding 6, nessuna draw senza viste dei tier, LOD 0, il cookie girato come `sampleTierOrWhite` gira ogni immagine, `pointShadow` dal centro; "Not yet: the `sprite` light type" → "A sprite light at layer 0 (packed index 0 among them) or with range ≤ 0 is a degenerate triangle in `vs_main`, and one whose layer is past its array is discarded in `fs_main` (`cookieLayers`)"); `:299` (hit-tester.ts); `:323` (lighting-api.ts: il flag si legge in ogni build, solo l'avviso è dev; il quarto parametro di `_init`, i conti del renderer del thread principale; in Mode A, il solo layer 0); `:348` (probe-checks.ts: `gpuErrorWitness`, gli errori del submit del frame, null in Mode A); `:359` (demo/lighting.ts: la terza sotto-scena, "(16 checks)"); `:361` (la base del cancello dei pixel del Mac: quella del passo 7 fino al passo 8, vedi la riga nuova) e, dopo, la riga di `demo/lighting-sprite.ts` (i quattro check e il difetto di ciascuno, i verdetti puri su un modello, Mode A senza spawn, 4 id freschi con la base `docs/plans/assets/2026-10-14-step8/baseline/`, il tier pieno dal quinto ingresso); `:362` (demo/twin-2d.ts: 7 check; 'Textured quad and line show their image upright', in (−80, 60), coi quadranti del PNG e la simmetria nominata; il probe di 'Depth orders transparent sprites' a `ORDER_Y - 0.15`, `ORDER_PROBE_OFFSET`); `:395` (prelude.wgsl: `sampleTierOrWhite` gira v dopo la risposta bianca, ogni immagine diritta; `sampleTier` in coordinate di texture); `:396` (quad.wgsl: l'immagine diritta); `:397` (line.wgsl: l'immagine come su un quad girato lungo start→end, la prima riga a sinistra della direzione; −0,5 è la destra); `:398` (msdf-text.wgsl: grezzo; `atlasV0` è il v del bordo inferiore del glifo, `atlasV1` di quello superiore); `:399` (bezier.wgsl: l'immagine diritta, l'uv della geometria invariato); `:418` (light-accum.wgsl: sprite e binding 6, il giro del cookie copiato dal preludio); gotcha `:447` (slot 3 = semilato, raggio `range·√2`, e dopo la frase del passo 6: "Scenes, command tapes and snapshots with sprite lights drew nothing before round step 8; a textured one now draws its cookie and, shadowed, opens an SDF set; an untextured one still draws nothing (one dev warning). A shadowed point or spot light of range 0 or less no longer opens an SDF set (it never lit a pixel): only `engine.lighting.groups` and the frame cost change."), `:449`, `:455` (la sprite con le point e spot), `:460` (la copia di `sampleTier`, `cookieLayers`, il gruppo 1, le due righe del giro), gotcha `:482` (lo spazio uv è y verso l'alto, (0, 0) in basso a sinistra del quad; l'immagine si gira solo alla lettura), `:497` (Mode A: la sprite non illumina mai, e il render worker, i cui conti sono tutti 0, avvisa per ogni luce sprite), `:522` (fatto (2): i contenuti dei tier, come nel §10.2 del design 17; fatto (5): il raggio della sprite), `:541` (il raggio per tipo; chiude il §4 `:176`), `:601` (ogni `TextureTierBinding`, anche quello di `LightAccumStage`, si risolve a ogni frame, e il tab Lighting fa crescere un tier mentre una sprite disegna; chiude il §4 `:166`), `:602` (layer 0 e layer oltre l'array; un blocco BC7 tutto zero è nero trasparente, uno ASTC il colore d'errore, mai "transparent black on BC7/ASTC"; i layer in uso lato CPU; la regola dell'immagine, mai `flipY` al caricamento, il KTX2 scritto riga in alto per prima, 'rd') e, subito dopo, un gotcha nuovo: "**Tier images are drawn upright since round step 8**" (first row along the primitive's local +y; `sampleTierOrWhite` turns v over once, the cookie copies it; scenes, tapes and snapshots with textured quads, lines and beziers render them the other way round than before, shadows included; a mirrored quad is still culled, round plan §4 (1b); `KTXorientation` is not read: a KTX2 written 'ru' shows upside down); `:644` (il gruppo 1 dei tre utenti); agent (`:727`, `:729`); documenti (dopo `:838`): il piano del passo 8. Poi `git diff --numstat CLAUDE.md`: 37 aggiunte e 34 cancellazioni attese (le 34 righe elencate, modificate, più 3 nuove: la riga di `demo/lighting-sprite.ts`, il gotcha delle immagini diritte e il piano del passo 8; aggiunte = cancellazioni + 3, nessuna riga persa; nel prototipo, prima delle sotto-decisioni, 28 e 26) e `grep -n "bindTextureTiers" CLAUDE.md` (vuoto).
- [ ] **Step 5: agent, skill, hook, piano del giro.**
  - `wgsl-validator.md` voci 5 (`:20`: la copia di `sampleTier`, `cookieLayers`, il gruppo 1; il giro di v in `sampleTierOrWhite`, dopo la risposta bianca, e la sua copia prima del campionamento del cookie) e 9 (`:24`: binding 6, il drop del layer 0, `cookieLayers`, LOD 0 solo in `fs_main`, SPRITE nei due gate); `webgpu-pass-reviewer.md` voci 10 (`LightAccumStage` risolve il suo `TextureTierBinding` a ogni frame) e 13 (secondo gruppo, binding 6, storage 5 e 3, `cullMode: 'none'`).
  - `gpu-check/SKILL.md`: `:156-157` (Lighting carica il cookie e fino a 64 filler di 1 px per ingresso, 15, 16, 32 e 64 agli ingressi 1-4; dal quinto la crescita salta: ricaricare la pagina); `:157-158` ("**2D Twins** (6 checks)" → "(7 checks)", e fra quelli che tiene anche 'Textured quad and line show their image upright', un quad e una linea con texture letti diritti); `:160` ("in Mode B it skips: 5/6 passed · 1 skipped" → "6/7 passed · 1 skipped"); `:287` (in Mode A la sprite non illumina e i quattro check saltano).
  - `new-primitive/SKILL.md`, la voce di `:31` diventa: "   - sample the tiers with `sampleTierOrWhite(in)` (packed index 0 answers white; it turns v over itself, so pass the local, y-up uv, `position.xy + 0.5` for a unit quad, and never flip v in `{p}_vs`: the image is upright, round step 8) unless the texture is data, as msdf's atlas (raw `sampleTier`, in texture coordinates); `textureSampleLevel`, never `textureSample`, outside fragment code."
  - `.claude/hooks/post-edit-notices.sh`, caso del preludio (`:30-38`): dopo "OccluderSeedStage together;" la frase "group 1, sampleTier and the two lines of sampleTierOrWhite that turn v over are also copied, text for text, in shaders/light-accum.wgsl (LightAccumStage, round step 8; light-accum-stage.test.ts compares them, with cookieLayers);" e, nel comando vitest, `src/render/passes/light-accum-stage.test.ts` dopo `src/render/primitive-shaders.test.ts`. Prova dalla radice: `printf '{"tool_input":{"file_path":"%s/ts/src/shaders/primitives/prelude.wgsl"}}' "$PWD" | CLAUDE_PROJECT_DIR="$PWD" bash .claude/hooks/post-edit-notices.sh; echo "exit $?"` stampa su stderr la riga nuova ed esce 2.
  - Piano del giro (righe di `443dc7f`; sul branch il record del Task 0, Step 0, sette righe dopo `:70`, le sposta tutte di 7 salvo `:21`: `:150`-`:156`, `:157`-`:159`, `:173`, `:183`, `:196`, `:214`, `:217`, `:233-236`, il punto nuovo fra `:209` e `:210`): §1 `:21` → "— ✅ passo 8"; §4 ✅: `:143`-`:149` (Task 3), `:150`-`:152` (Task 4), `:166`, `:176`, `:189` («attenuation»), `:207` (il guard esteso); `:210` limitazione dichiarata; §5 `:226-229`: sprite ✅ passo 8; e nel §4, dopo l'ultimo punto della deriva del passo 7 (`:202`) e prima di "**Bug preesistente**" (`:203`; il bullet "Passo 8 — fatto" del Task 10 andrà prima di questo punto), il punto nuovo "**Trovato al passo 8 (2026-10-14)**", per il passo 9 (righe di `443dc7f`): (1) i quad, le linee e le bezier con texture mostravano l'immagine specchiata dall'alto in basso: corretto al passo 8 (sotto-decisione 2 (e)), con un giro di v in `sampleTierOrWhite` che il cookie copia; restano `KTXorientation`, che non si legge (un KTX2 scritto 'ru' si mostra capovolto), e il quad specchiato, che sparisce invece di specchiarsi (punto (1b)); (1b) una trasformazione che specchia (scala x o y negativa, l'idioma 2D `scale(-1, 1)`; un'inclinazione 3D oltre 90°) avvolge in senso orario ogni primitiva di `unitQuadVertex` (quad, gradient, box shadow, bezier, testo MSDF) e le linee in unità locali, e `cullMode: 'back'` (`forward-pass.ts:271`, `:285`, `occluder-seed-stage.ts:96`, `selection-seed-pass.ts:107`) la scarta: niente disegno, niente ombra, niente contorno, mentre il cull la conta (`systems.rs:312-322`) e il picking la colpisce (`hit-tester.ts:83-85`); le linee in pixel restano (`line.wgsl:64-72`); dal passo 8 il cookie di una luce sprite si specchia (sotto-decisione 1 (a)). Correzione candidata, da decidere col proprietario: `cullMode: 'none'` in quelle quattro famiglie (nessun pixel cambia senza una trasformazione che specchia; l'harness non ne ha), con check GPU suoi e una regola per le facce posteriori 3D; (2) un KTX2 BC7/ASTC passa `formatMatchesTier` su un tier rgba8 (`texture-manager.ts:802-805`), l'upload fallisce senza che il motore lo dica e la handle nomina un layer vuoto; (3) a 256 layer un caricamento rialloca, copia e distrugge l'array e scambia le viste prima di lanciare "is full" (`:349-433`, `:442-534`; circa 341 MiB sul tier 3): la correzione (uscire prima di allocare quando `allocated >= MAX_LAYERS_PER_TIER`, con un test che conta `createTexture`) tocca `TextureManager`, fuori dal passo; (4) un blocco ASTC tutto zero ha una modalità di blocco riservata, quindi è illegale (KHR_texture_compression_astc_hdr, tabella C.2.8, C.2.24) e si decodifica nel colore d'errore, magenta opaco o quattro NaN in una decodifica lineare come `astc-4x4-unorm` (C.2.5): il layer 0 mai riempito di un tier ASTC lo mostra ai glifi MSDF all'indice 0 (che campionano grezzo; quad, linee e bezier all'indice 0 rispondono bianco, e lo mostrano solo al layer 0 dei tier 1-3: punto (5)), un NaN avvelenerebbe il light buffer (solo specifica, non misurato: l'M2 usa BC7; il commento di `forward-pass.test.ts:404-405`, che diceva "BC7/ASTC transparent black", è corretto al passo 8, Task 3 Step 0); correzione candidata: un blocco void-extent bianco scritto nel layer 0 alla prima allocazione; (5) le primitive rispondono bianco solo all'indice 0: il layer 0 di un altro array (i tier 1-3, gli overflow) campiona la riserva; correzione candidata: `sampleTierOrWhite` su `in.texLayer == 0u`; (6) una handle stantia (un'altra sessione, un tape, uno snapshot) che nomina un layer caricato con un'altra texture la mostra senza avviso, sui quad come sulle sprite: un controllo dev al punto di chiamata (`.texture()`, `raw.setTexture()`) per ogni primitiva, in un passo suo; (7) `TextureHandle` è un `number` senza marca (`types.ts:4`): ogni numero passa per una handle.
- [ ] **Step 6: controlli e commit.** `npm --prefix ts test` (116 file, 2215 + 7) e la prova dell'hook, poi:
```bash
git add ts/src/render/render-pass.ts ts/src/hit-tester.ts ts/src/render/primitive-bindings.ts ts/src/renderer.ts ts/src/render/passes/light-accum-stage.test.ts docs/plans/2026-08-04-phase17-lighting-2d-design.md docs/plans/2026-09-26-phase17-light-layer-groups-design.md PROJECT_ARCHITECTURE.md CLAUDE.md .claude/agents/wgsl-validator.md .claude/agents/webgpu-pass-reviewer.md .claude/skills/gpu-check/SKILL.md .claude/skills/new-primitive/SKILL.md .claude/hooks/post-edit-notices.sh docs/plans/2026-09-27-open-items-round-plan.md
git commit -m "docs(8): la luce sprite nei commenti, nei design, in CLAUDE.md, negli agent, in /gpu-check e nel piano del giro" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: preflight

- [ ] `scripts/preflight.sh` tutto `OK`, coi conteggi dei Task 1-5 (Rust: lib 223, 301, 254, 347, totali 268, 392, 304, 447 senza feature, `physics-2d`, `dev-tools`, `--all-features`; vitest 116 file, 2215 + 7 saltati); i `node:test` 64/64; naga `1/1 valid` su `light-accum.wgsl` e `9/9 valid` sui moduli composti e sui due kernel del sort (`DUMP_WGSL_DIR`, il comando del Task 3, Step 0: il preludio è cambiato); gli stessi due controlli sono il «naga» dello Step 1 del Task 9, dopo le correzioni del Task 8. Nessun commit: un passo rosso torna al suo task con un `fix(8)`.

### Task 8: review avversariale e agent

- [ ] **Step 1:** la voce `<…>` di `accepted` viene dagli esiti misurati dei Task 3 e 5. In `accepted` solo le decisioni del proprietario (§2) e gli esiti misurati: il workflow le dà ai finder come "Decisions already accepted by the user — do NOT report these as defects" (`.claude/workflows/adversarial-review.js:37`); le sotto-decisioni del controller (Task 0, Step 0) vanno nel `context`, come scelte rivedibili.
```js
Workflow({ name: 'adversarial-review', args: {
  range: '443dc7f..feat/step8-sprite-light',
  spec: 'docs/plans/2026-09-27-open-items-round-plan.md (§2 "Passo 8 — deciso (2026-09-30)": owner decisions, then the controller sub-decisions; §3 row 8)',
  plan: 'docs/plans/2026-10-14-step8-sprite-light-plan.md',
  context: 'Round step 8: the sprite light draws its cookie (the entity texture) through the prelude group 1 in LightAccumStage (a TextureTierBinding resolved from the pool in every encode, cullMode none) and binding 6 = tex-indices; light-accum.wgsl copies sampleTier (LOD 0), turns the square with spriteAxes, drops layer 0 or range <= 0 in vs_main, discards a layer past its array (cookieLayers), shadows from the centre; every tier image is drawn upright: the prelude\'s sampleTierOrWhite turns v over after its white answer (no vertex uv changes, msdf stays raw) and the cookie copies its two lines; Rust culls on range*sqrt(2) saturated at f32::MAX; the SDF gate is one rule (range > 0 for every shadowed type, plus a texture for a sprite light); one exported predicate, untexturedPredicate (layer 0, or a layer at or past its array\'s used count from the renderer\'s TextureManager, textureLayersUsed, with sampleTier\'s default arm for tiers past 3), feeds the SDF gate, the untexturedSpriteLight flag and a dev warning after a second of lit time with no texture load in flight (paused, not reset, while TextureManager.pendingLoads > 0; at most 100 ms per frame), naming up to three entities; four probe checks with a procedural PNG cookie (mirrored and mix reads included), a 2D Twins check of a textured quad and line, the 5b depth probe moved to ORDER_Y - 0.15; the Task 3 GPU gate also reads five texels (a cookie, index 0, tier 1 layer 0, overflow layer 0, a layer past a 1-layer array). GPU: M2 Pro, Chrome, B and C with the probe, A by screenshot. Sub-decisions taken by the controller under the owner delegation of 2026-10-14 (round plan §2): 1 (a), the mirror by the determinant sign (the mirrored-quad culling is recorded, not fixed: round plan §4 (1b)); 2 (e), every tier image upright through sampleTierOrWhite (a scope extension: textured quads, lines and beziers change); 3 (c), one SDF rule for every shadowed type (a scope extension: point and spot lights of range <= 0 open no set; CPU only, same pixels); 4 (a)+(c)+(d), layer 0 dropped on the GPU, used layers on the CPU, a five-texel device witness (a scope extension); D3 (a), a Lighting sub-scene; D4 (d\'), the paused one-second warning naming ids. They are reviewable: a finding with evidence that their analysis missed something is in scope.',
  accepted: [
    'The five owner decisions of §2 (shape, cookie, index 0, shadows, Mode A).',
    'Mix with a cookie: weight = alpha x shadow, target = colour x energy x rgb; LOD 0 only; straight alpha.',
    'Later tabs\' ids +4 (M4 base re-captured); the growth check skips from the fifth Lighting entry in one page.',
    '<the measured outcomes of Tasks 3 and 5: the GPU gate, Lighting 16/16 in B and C, the RED of the pop on the base WASM>',
  ],
  lenses: [
    'webgpu', 'docs',
    { key: 'cookie', prompt: 'LENS: the cookie path (light-accum.wgsl, light-accum-stage.ts, light-groups-pass.ts, primitives/prelude.wgsl): group 1 and the sampleTier copy against the prelude, the image flip in sampleTierOrWhite and its copy before the cookie sample (every tier image upright, no vertex uv changed, msdf raw), LOD 0, the decode, a tier growth between frames, a pool without tier views, HMR probes, the storage budget, the uv under a mirrored or sheared transform, mix and sub with a cookie, Mode A.' },
    { key: 'radius', prompt: 'LENS: culling and the CPU gates (systems.rs, verify_2d.rs, light-groups.ts, renderer.ts, lighting-api.ts, frame-inputs.ts, texture-manager.ts): range*sqrt(2) at every rotation, saturation, bad ranges, BoundsOverride, same-frame GPU rows; both gates together; the one SDF rule (range > 0 for every shadowed type, a texture for a sprite); untexturedPredicate with the used layer counts (never flagging a handle the TextureManager gave; the default arm for tiers past 3); the warning once, dev only, listed sprites only, paused, not reset, while a texture load is in flight, at most 100 ms per frame, naming up to three ids.' },
    { key: 'harness', prompt: 'LENS: lighting-sprite.ts (+ test), twin-2d.ts (+ test), gpuErrorWitness, textureTiers, lighting.ts: each check fails on the defect it names; the PNG encoder and URL cache; fillers across entries and the skip at 256; the frame after the growth; the witness never cancels and is always stopped; Mode A skips before spawning; cleanup; points in view and on opaque blocks; the image orientation check (every symmetry named, a flip in one library) and the depth probe moved to ORDER_Y - 0.15; the step 3, 6 and 7 checks unchanged.' },
  ],
} })
```
- [ ] **Step 2:** in parallelo, sul range `443dc7f..HEAD`: `webgpu-pass-reviewer` su `light-accum-stage.ts`, `light-groups-pass.ts` e lo shader (voci 8, 10, 12, 13); `wgsl-validator` su `light-accum.wgsl` e `primitives/prelude.wgsl` (voci 5, 9); `harness-check-auditor` su `demo/lighting-sprite.ts`, `demo/twin-2d.ts`, `gpuErrorWitness` e `demo/lighting.ts`.
- [ ] **Step 3: le correzioni, e la regola che le fa convergere** (memoria `sdd-workflow-lessons`, lezione 7; ruling R16 del passo 7, dopo le ondate 8f1-8f6, 21 commit):
  1. I finding confermati (review e tre agenti; Critical, Important e Minor) si correggono in UN'ondata: ciascuno test rosso, correzione, verde, commit `fix(8): review <wf-id> — <titolo>`; un'ondata grande si divide in task di `sdd-tasks` con id stringa ('8f1', '8f2', …); un finding contro il §2 va al proprietario.
  2. La review mirata di quell'ondata, e ogni review dopo di essa prima del Task 9, riapre il codice solo per un Critical o un Important.
  3. I suoi Minor si parcheggiano, ciascuno con un ruling nel registro SDD, nel §4 "Registrati per il passo 9" (Task 10); un Minor di soli documenti si corregge nel testo, senza altri giri (ruling R21 del passo 7).
  4. Poi il codice è chiuso per il Task 9, e il registro ne annota lo SHA.

### Task 9: verifica GPU sul Mac

Gambe di `gpu-leg` nella forma del Task 3 (ogni pagina come lì; in Mode A la tela come nei Vincoli globali); il registro annota le versioni di macOS e Chrome; i verdetti in `legs/task-9<x>-result.json`.

- [ ] **Step 1:** `git status --short` vuoto; `npm --prefix ts run build:wasm`; naga.
- [ ] **Step 2: 9a, il motore del passo 7 nella stessa sessione** (il cancello è al bit). Prima `git restore --source=443dc7f --staged --worktree -- ts/src`, poi `gpu-infra.sh up --git /old-light-accum.wgsl=1d19575:ts/src/shaders/light-accum.wgsl`. Passi: (1) `git diff --cached --quiet 443dc7f -- ts/src` e `git diff --quiet -- ts/src` escono 0; (2) `curl -s "http://localhost:5173/src/shaders/light-accum.wgsl?raw" | grep -c spriteAxes` stampa 0; (3) in `?mode=B&bench`: `window.__benchSpec = { bench: '/2026-10-08-step7-light-order-bench.js', globals: { __step7OldLightAccum: '/old-light-accum.wgsl' } }` e `load-bench.js`; `window.__benchOpts = { task: 'regress', label: '443dc7f' }` e `window.__benchFn()` → `<ev>/step7-regress-m2-B.json`; `window.__benchOpts = { task: 'order', label: '443dc7f', K: 3, apart: 1, blend: 'mix', reads: 8 }` e `window.__benchFn()` → `<ev>/step7-mix-m2-B.json`; (4) lo stesso in C. Dopo: `gpu-infra.sh down`, `git restore --source=HEAD --staged --worktree -- ts/src`, `git status --short --untracked-files=no` vuoto (le evidenze restano non tracciate fino allo Step 6).
- [ ] **Step 3: 9b, il passo 8.** `gpu-infra.sh up --git …` come sopra. Passi: `tools/gate-step8.js` → `gate-m2-final.json`; in B e C `regress` → `regress-m2-{B,C}.json`, poi `order` coi parametri dello Step 2 (`label` lo SHA corto di HEAD) → `mix-m2-{B,C}.json`; poi, per modo (qui B), `regress` in quattro gambe (passo 7 contro passo 8; shader vecchio contro passo 8 sulla stessa pagina; shader vecchio contro passo 7 sulla pagina del passo 7; shader vecchio sulle due pagine: separano stadio, motore e sessione dalla compilazione del `fs_main` nuovo):
```bash
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const { decodeGrid, compareGrids } = await import(process.cwd() + "/docs/plans/assets/2026-09-30-step6/step6-stats.mjs");
const [s7File, s8File, outFile] = process.argv.slice(1);
const last = (f) => JSON.parse(readFileSync(f, "utf8")).results.filter((r) => r.task === "regress").at(-1);
const s7 = last(s7File), s8 = last(s8File);
const cmp = (a, b) => a.map((g, i) => { const c = compareGrids(decodeGrid(g), decodeGrid(b[i])); return { n: c.n, identical: c.identical, maxAbs: c.maxAbs }; });
const legs = { step7VsStep8: cmp(s7.layers, s8.layers), step8VsOldShader: cmp(s8.oldShaderLayers, s8.layers), step7VsOldShader: cmp(s7.oldShaderLayers, s7.layers), oldShaderStep7VsStep8: cmp(s7.oldShaderLayers, s8.oldShaderLayers) };
const ok = Object.values(legs).every((l) => l.length > 0 && l.every((c) => c.identical === c.n));
writeFileSync(outFile, JSON.stringify({ ok, legs, shaders: { step7: s7.shaders, step8: s8.shaders }, cullPath: { step7: s7.cullPath, step8: s8.cullPath } }, null, 2) + "\n");
console.log(JSON.stringify({ ok, legs }));
process.exitCode = ok ? 0 : 1;
' docs/plans/assets/2026-10-14-step8/step7-regress-m2-B.json docs/plans/assets/2026-10-14-step8/regress-m2-B.json docs/plans/assets/2026-10-14-step8/regress-m2-B.stats.json
```
  e i mix: `node docs/plans/assets/2026-10-14-step8/tools/step8-compare.mjs mix docs/plans/assets/2026-10-14-step8/step7-mix-m2-B.json docs/plans/assets/2026-10-14-step8/mix-m2-B.json > docs/plans/assets/2026-10-14-step8/mix-m2-B.stats.json; echo "exit $?"`; lo stesso con `C`. Expected: il gate come al Task 3, aspettative 3-6 (i sette moduli composti col giro dell'immagine e il testimone a cinque letture compresi); `regress-m2-{B,C}.stats.json` con `ok` true, ogni punto identico nelle quattro gambe; `mix` exit 0 in B e C (2304 punti identici). Un punto diverso si indaga, non si accetta (rischio 12): se le gambe dello shader sono identiche e `step7VsStep8` no, la causa è nello stadio, nel motore o nella sessione; se differisce `step8VsOldShader`, una gamba di bisezione: `target/gpu-check/bisect-light-accum.wgsl` (lo shader del passo 8 col `fs_main` di `443dc7f`), servito con `gpu-infra.sh up … --map /bisect-light-accum.wgsl=target/gpu-check/bisect-light-accum.wgsl`, caricato con `engine.recompileShader('light-accum', <testo>)` finché `LightAccumStage.SHADER_SOURCE` è il testo, poi `regress` → `bisect-regress-m2-<modo>.json`; identico al passo 7, con le righe di point e spot spostate alla lettera, vuol dire la compilazione del `fs_main` nuovo: si riporta al proprietario coi numeri, senza accettarla e senza allentare il cancello.
- [ ] **Step 4: 9c, harness e Mode A.** Passi: in B e C, su una pagina nuova, `tab-runner.js` poi `lighting-tab.js` (il secondo ingresso) → `harness-m2-{B,C}.json` e `node docs/plans/assets/2026-10-14-step8/tools/step8-compare.mjs details docs/plans/assets/2026-10-14-step8/harness-m2-B.json docs/plans/assets/2026-10-08-step7/baseline/statuses-B.json > docs/plans/assets/2026-10-14-step8/harness-m2-B.details.json; echo "exit $?"` (lo stesso con `C`); in A `tab-runner.js` e `lighting-tab.js` → `harness-m2-A.json`; A contro B: il `scene` del banco del passo 7, fasi 1-3, su una pagina appena caricata per modo, con screenshot, `map-json.js` e `pixels.py` → `<ev>/modeA-vs-B/`, come al passo 7. Expected:
  - B e C: Lighting 16/16, la crescita del secondo ingresso "32 -> 64 layers (16 fillers, layers 17-32), cookie 30° and 0°, 0 GPU errors", `details` exit 0; 2D Twins 6/7 · 1 skipped in B e 7/7 in C, 'Textured quad and line show their image upright' `pass`; totali 60/4/4 in B e 61/3/4 in C su 68;
  - A: nessun `fail`, Lighting 4/16 · 12 skipped, e in 2D Twins il check nuovo salta, come i tre di prima che caricano la texture; 17 pass, 47 skip e 4 in attesa su 68;
  - la tela in Mode A può leggere 300×150 prima di un frame (si annota); 1960×1248 si vincola sul `canvas` di `lighting-tab.js` e su quello in cima a `scene-A.json`, letti dopo frame disegnati;
  - A contro B entro 2/255 (il gruppo 1 è valido anche nel render worker); console: al più il 404.
- [ ] **Step 4b: 9e, l'avviso della sprite senza texture, dal vivo** (sotto-decisione D4; sul modello della gamba del passo 6, piano del passo 6 `:1485-1502`, `global-warning-m2.json`). Il criterio d'uscita chiede l'avviso, e nessun check lo fa scattare: l'harness carica il cookie prima e in Mode A non spawna nulla. Una gamba sua, dopo 9c e prima di 9d, sull'infrastruttura che lo Step 3 ha alzato e che lo Step 5 chiude: qui nessun `up` né `down` (un `down` lascerebbe lo Step 5 senza dev server, e un `up` riavvierebbe Vite e il server degli asset senza il `--git` dello Step 3); evidenze in `<ev>/sprite-warning-m2.json`, verdetto in `legs/task-9e-result.json`.
  - Passi: (1) su una pagina `"http://localhost:5173/?mode=B&bench"` appena navigata, con una console appena aperta:
```js
async () => {
  const engine = window.__hyperion;
  const hs = [];
  engine.batch(() => {
    hs.push(engine.spawn().position(0, 0, -0.5).scale(40, 24, 1).receivesLight(true));
    hs.push(engine.spawn({ mode: '2d' }).light({ type: 'sprite', range: 5 }));
  });
  engine.lighting.setBackend('lit');
  // Mode B: the renderer warns on this thread, and seconds pass between a
  // step's return and list_console_messages (which gives no message time):
  // the script times the warnings itself, in ms since setBackend. Mode A's
  // render worker warns on its own console: these numbers say nothing there.
  const t0 = performance.now();
  const times = [];
  const warn0 = console.warn;
  console.warn = (...a) => {
    if (/^\[Hyperion\] (?:Sprite lights? |A sprite light )/.test(String(a[0]))) times.push(Math.round(performance.now() - t0));
    return warn0.apply(console, a);
  };
  window.__spriteWarnTimes = times;
  await new Promise((r) => setTimeout(r, 600));
  window.__spriteWarnHandles = hs;
  return { id: hs[1].id, untexturedSpriteLight: engine.lighting.groups?.untexturedSpriteLight ?? null, warnsBy600: times.length };
}
```
  poi `list_console_messages` (`warn`); poi `async () => { await new Promise((r) => setTimeout(r, 1000)); return [...(window.__spriteWarnTimes ?? [])]; }` e di nuovo `list_console_messages`; poi lo stesso un'altra volta; poi `() => { for (const h of window.__spriteWarnHandles) h.destroy(); window.__hyperion.lighting.setBackend('off'); return 'cleaned'; }`. (2) Lo stesso su `"http://localhost:5173/?mode=A&bench"`: l'avviso lo emette il render worker, e chrome-devtools mostra i messaggi dei worker. (3) Il cancello dei caricamenti, su una pagina B nuova:
```js
async () => {
  const engine = window.__hyperion;
  const fetch0 = window.fetch;
  window.fetch = async (...args) => { await new Promise((r) => setTimeout(r, 2500)); return fetch0(...args); };
  const png = new OffscreenCanvas(8, 8);
  const ctx = png.getContext('2d');
  ctx.fillStyle = 'rgb(255, 255, 255)';
  ctx.fillRect(0, 0, 8, 8);
  const url = URL.createObjectURL(await png.convertToBlob({ type: 'image/png' }));
  const hs = [];
  let light;
  engine.batch(() => {
    hs.push(engine.spawn().position(0, 0, -0.5).scale(40, 24, 1).receivesLight(true));
    light = engine.spawn({ mode: '2d' }).light({ type: 'sprite', range: 5 });
    hs.push(light);
  });
  engine.lighting.setBackend('lit');
  const t0 = performance.now();
  let frames = 0;
  let counting = true;
  const tick = () => { if (counting) { frames++; requestAnimationFrame(tick); } };
  requestAnimationFrame(tick);
  light.texture(await engine.loadTexture(url));
  const untexturedMs = performance.now() - t0;
  counting = false;
  window.fetch = fetch0;
  await new Promise((r) => setTimeout(r, 1500));
  const flagAtEnd = engine.lighting.groups?.untexturedSpriteLight ?? null;
  for (const h of hs) h.destroy();
  engine.lighting.setBackend('off');
  URL.revokeObjectURL(url);
  return { untexturedMs, frames, flagAtEnd };
}
```
  poi `list_console_messages` (`warn`).
  - Aspettative: in B e in A `untexturedSpriteLight` true al passo (1); in B `warnsBy600` 0 (60 frame a 120 Hz l'avrebbero già dato) e, dopo il primo secondo d'attesa, un solo tempo nel risultato del passo, ≥ 1000 ms (lo script cronometra da sé: fra il ritorno di un passo e `list_console_messages` passano secondi, e la lista non dà il momento di un messaggio); in A, dove l'avviso viene dal render worker, i soli conteggi della console; in B e in A, dopo il primo secondo d'attesa esattamente un avviso, che comincia con "[Hyperion] Sprite light <id> has no texture" con l'id restituito dal passo (1); dopo il secondo ancora uno solo; il cancello: nessun avviso di sprite, `untexturedMs` ≥ 2000 (un conto senza la pausa avrebbe avvisato), `flagAtEnd` false. I messaggi e i risultati, col modo, vanno in `sprite-warning-m2.json`.
- [ ] **Step 5: 9d, il cancello M4.** `docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js` (SHA-256 `9912ecff9444998a1def7229a21e831bb866f2dacf7faad004a1620a19643bb5`) sui 10 tab e `statuses`, come in M4 (README del Mac §M4, "Procedura"): su una pagina `"http://localhost:5173/?mode=B&bench"` appena navigata, poi su una `"http://localhost:5173/?mode=C&bench"` (un caricamento per modo) → `docs/plans/assets/2026-10-14-step8/baseline/`; poi, dalla radice, `node docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs --base docs/plans/assets/2026-10-08-step7/baseline --run docs/plans/assets/2026-10-14-step8/baseline --mode B --step 0 > docs/plans/assets/2026-10-14-step8/baseline/compare-B.txt`, e lo stesso con `--mode C` in `compare-C.txt`. Expected: `FAIL` per il solo "mover ids differ" di twin-2d, id + 4 (183-186 → 187-190); i conteggi C come al passo 7; stati `OK`, coi quattro check nuovi di Lighting e quello nuovo di 2D Twins contati come check nuovi che passano (`compare.mjs:174-178`). Poi `gpu-infra.sh down` (stesso `TMPDIR`), prima che lo Step 6 tocchi il checkout.
- [ ] **Step 6:** nel README del Mac, §M4 "Uso come cancello", il punto "**Base dal passo 8 (<data>, `<sha>`).**" come quello del passo 7 (`:105`), con +4 id e la cartella nuova; i verdetti (`legs/task-9{a,b,c,d,e}-result.json`) e un `legs/README.md` come quello del passo 7, che elenca anche quelli dei Task 3 e 5 e ogni `pass: false` accettato col suo ruling, coi percorsi locali sostituiti da `<repo>`, `~` e `<tmp>`.
```bash
git add docs/plans/assets/2026-10-14-step8 docs/plans/assets/2026-09-29-mac-m2/README.md
git commit -m "test(8): verifica GPU sul Mac, point, spot, directional, global, sub e mix al bit contro il passo 7, cancello M4 ricatturato" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: numeri, auditor, preflight completo, merge, memoria, rapporto

- [ ] **Step 1: CLAUDE.md** (ogni numero si riconta coi comandi prima di scriverlo): `:24` 223 (268), 301/392, 254/304, 347/447; `:25` 100 integrazione (347 + 100 = 447); `:32` 22, 31, 72; `:35` 30, 32; `:66` 2215 + 7, 116 file; `:73` 116; `:74` 110; `:79` 26; `:82` 301/392; `:86` 347/447; `:90` 254/304; `:362` "(7 checks)"; `:437` 77 vs 72; `:778` 100 test, verify_2d 9, più D8 e D9; `:794` 68 checks; il gotcha di Mode A (`:497`): 17 pass, 47 skip, 4 pending su 68, Lighting 4/16, a `<sha>`; lo SHA della base M4 nella riga di `lighting-sprite.ts`; lo stato (`:760`/`:762`): passo 8 fatto, il prossimo è l'8b, resta aperto solo che le texture non si caricano in Mode A; dopo `:813`, la riga "| 8 (round 2026-09-27) | The sprite light | … |" coi fatti e i numeri del Task 9.
- [ ] **Step 2: skill `gpu-check`:** la riga di Mode A di §7 coi numeri del Task 9; nel §4, «**2D Twins** (6 checks)» (`:157`) diventa 7 e, in Mode B, «5/6 passed · 1 skipped» (`:160`) diventa «6/7 passed · 1 skipped» (il check delle immagini diritte, sotto-decisione 2 (e)); l'attesa di Lighting nel §4 sale se il setup supera 7 s.
- [ ] **Step 3: piano del giro.** §3, riga 8: "(fatto: §4)". §4, dopo il passo 7, il bullet "**Passo 8 (la luce sprite) — fatto**": piano e review; la sprite; le sotto-decisioni del controller (rimando al §2) e le tre estensioni del passo: le immagini dei tier diritte (2 (e), 2D Twins 7/7, la RED col preludio di prima), una regola per il set SDF di ogni luce ombreggiata (3 (c), lo Step 7b), i layer in uso lato CPU e il testimone a cinque letture del cancello (4 (c)+(d)); i numeri del Mac (16/16, il cookie specchiato e in mix, la crescita 16 → 32 e 32 → 64 con 0 errori, il pop rosso col WASM di base, point, spot, directional, global, sub e mix al bit, Mode A, l'avviso dal vivo in B e in A e il suo cancello sui caricamenti, 9e); il cancello M4; la frase sul comportamento del Task 6 (Step 2), come ai passi 6 e 7; la lista del passo 9 (la gamba Safari della sprite, con la copia di struct `var image = in;` del preludio fra le cose da compilare in WebKit; il sub con un cookie mai girato sul device; i residui conservativi del gate SDF che nessuna opzione chiude: un `range` positivo sotto un texel dell'SDF, una luce ombreggiata nel margine del raggruppamento ma non listata, un `range` +inf da `snapshot_restore`, rischio 8; i Minor rinviati; la deriva preesistente dell'auditor; le voci per il proprietario dei giudici D3 e D4: gli id dei mover di M4 confrontati relativi al tab (`compare.mjs:106-111`: oggi ogni spawn dell'harness in un tab prima di 2D Twins chiede una base nuova), le etichette delle texture dei tier e dei gruppi `TextureTierBinding` (un errore del testimone direbbe quale dei tre utenti teneva il gruppo stantio), l'avviso della global del passo 6 che non nomina l'entità).
- [ ] **Step 3b:** un commit per file: `docs(8): CLAUDE.md — …`, `docs(8): skill gpu-check — …`, `docs(8): piano del giro — passo 8 fatto, lista del passo 9`.
- [ ] **Step 4:** `claude-md-auditor` con la merge-base `443dc7f`: la deriva del passo si corregge (`docs(8): claude-md-auditor — <titolo>`), quella preesistente va nella lista del passo 9.
- [ ] **Step 4b: la review finale del branch, a due sedi** (lezione 8; al passo 7 il ruling R20, `wf_e1378aa6-d63`, trovò 14 minor di documenti che ogni review del codice aveva mancato), su `443dc7f..HEAD`, sul modello più capace, con uno scettico per ogni Critical o Important: sede 1, codice e piano (il code-reviewer di superpowers, col triage dei Minor parcheggiati); sede 2, ogni numero dei documenti ricondotto a un file di `docs/plans/assets/2026-10-14-step8/` o a un comando, e il criterio d'uscita del §3, riga 8, clausola per clausola. Le correzioni in un passaggio (`docs(8): review finale — …`), poi una re-review mirata i cui residui vanno solo nel testo (ruling R21).
- [ ] **Step 5:** `scripts/preflight.sh --full` e i `node:test`: tutto `OK`.
- [ ] **Step 6: merge e push** (autonomia del giro; `git status --short` vuoto, o ci si ferma):
```bash
git checkout master && git pull --ff-only origin master
git merge --no-ff feat/step8-sprite-light -m "Merge branch 'feat/step8-sprite-light'" \
  -m "Passo 8 del giro: la luce sprite disegna il suo cookie (quadrato che ruota, tier delle texture come gruppo 1 di LightAccumStage, ombre dal centro); raggio di culling range·√2; senza texture nessuna luce e un avviso dev; quattro check col probe; Mode A: limitazione dichiarata." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin master
git branch -d feat/step8-sprite-light
```
  Se il push fallisce per le credenziali, il merge resta locale, e lo si dice.
- [ ] **Step 7: memoria** (`~/.claude/projects/-Users-edoardocicognani-Code-HyperionEngine/memory/`): `open-items-round-2026-09-27.md` ("Step 8 DONE (merged `<sha>`, pushed)", "NEXT: step 8b (write its plan first)", la riga 8 di "Order"); `MEMORY.md` ("steps 1-5, 5b, 6, 7 and 8 merged; order 8b→8c→10→9"); `round-pending-decisions.md`: lista E, le sotto-decisioni del passo 8 (decisioni di Claude, ribaltabili; tre estendono il passo: 2 (e), 3 (c), 4 (c)+(d)); lista D, la base AMD del 5b con gli id + 14, le texture in Mode A, "mirrored quads vanish: cullMode 'back' in the four entity pipeline families (round plan §4 (1b))" e `KTXorientation` non letto ("Latent bugs no step owns"), i blocchi ASTC tutto zero (il colore d'errore, §4 (4)), la regola dell'indice 0 delle primitive (§4 (5)), il controllo delle handle stantie al punto di chiamata (§4 (6)), `TextureHandle` senza marca (§4 (7)), la gamba Safari della sprite, le voci rinviate al passo 9.
- [ ] **Step 8: rapporto finale** in italiano: le sotto-decisioni con la loro ragione, in evidenza le tre estensioni del passo: la 2 (e), che raddrizza le immagini di quad, linee e bezier con texture, ombre comprese, anche in scene, tape e snapshot vecchi; la 3 (c), che toglie il set SDF a point e spot ombreggiate con `range` ≤ 0 (solo CPU, stessi pixel), con lo SHA dello Step 7b; la 4 (c)+(d), che estende la lettera della decisione 3 dall'indice 0 al layer 0 di ogni array e, lato CPU, a ogni indice che questo renderer non ha caricato, sempre verso il lato chiuso; una riga per la 1 (a): il segno della scala y conta, da qui, per una luce sprite, mentre la sua grandezza resta ignorata come dice il §2 «Forma»; e la proposta al proprietario del difetto dei quad specchiati (§4 (1b)) come voce sua; i quattro check della sprite e quello di 2D Twins; l'avviso dal vivo (9e); il RED del raggio; point, spot, directional, global, sub e mix al bit; A contro B; il cancello M4; review e correzioni; lo SHA del merge; la lista del passo 9.

## Rischi e punti aperti

1. **Il controllo negativo del gate GPU** conta su Dawn che segnali, negli scope del submit, una texture distrutta ancora legata; se non la segnala, resta il check della crescita col testimone.
2. **Il frame dopo la crescita:** oggi fra crescita e submit non c'è una finestra; un `TextureManager` che crescesse fra codifica e submit romperebbe un frame che nessun test headless vede (lo vede il testimone).
3. **Alpha lineare e filtro bilineare:** ai bordi di un cookie con rgb nero sotto l'alpha 0 la luce scurisce un poco (rgb e alpha si filtrano separati; il JSDoc chiede il colore dei vicini opachi); i check leggono i centri dei blocchi.
4. **Solo il mip 0:** un cookie con più texel dei pixel del light buffer sfarfalla (documentato).
5. **Mode A:** gli array del worker hanno un layer: una sprite non illumina mai (layer 0 scartato in `vs_main`, ogni altro in `fs_main`), e il render worker, i cui conti dei layer in uso sono tutti 0, avvisa per ogni luce sprite che resta così un secondo (sotto-decisione 4 (c)); il thread principale non ha un `TextureManager`, e il suo `engine.lighting.groups` tiene la sola regola del layer 0. La (b), scartata, vi avrebbe acceso un quadrato intero per ogni indice di overflow o rgba8 non nullo (a mano, o da un tape o uno snapshot di B o C), senza avviso. Il gruppo 1 è valido anche nel worker (A contro B, Task 9).
6. **Il tier pieno a 256 layer:** dal quinto ingresso in una pagina la crescita salta; un caricamento a tier pieno rialloca e copia prima di lanciare (preesistente, §4).
7. **Scene, tape e snapshot vecchi:** le sprite con texture ora disegnano; il raggio di uno snapshot vecchio si ricalcola al primo `update()`, `state_hash` non cambia. Le handle valgono nella sessione che le ha caricate (JSDoc, design 17 §10.2). Una point o spot ombreggiata con `range` ≤ 0 non apre più un set SDF né divide un gruppo (sotto-decisione 3 (c): stessi pixel, cambiano solo `engine.lighting.groups` e il costo del frame); i quad, le linee e le bezier con texture si disegnano girati rispetto a prima (rischio 15).
8. **Range enormi:** da circa 2,4e38 gli angoli traboccano in `vs_main` (patologico). Un range non finito arriva solo da `snapshot_restore`: raggio +0.0 in Rust (listata finché il centro è in vista), e +inf passa `!(range > 0.0)` e disegna geometria NaN, come una point o spot con range +inf a HEAD: un guard, se mai, va su tutte e tre.
9. **Costo** (un campionamento per pixel, un set SDF per sprite ombreggiata), **i tipi 5-7** (quadrati non ruotati a intensità piena, come al passo 7) e **Safari** (gruppo 1, binding 6, LOD 0, `cookieLayers` e crescita mai girati in WebKit): fuori dal passo.
10. **Un cookie KTX2 compresso** va nei tier primari, la cui crescita nessuna sprite esercita (il gruppo 1 è lo stesso `TextureTierBinding` di `ForwardPass`).
11. **Gli id dei tab dopo Lighting crescono di 4:** si ricattura la base M4; la base AMD del 5b (+14) alla prossima sessione Fedora.
12. **La compilazione del `fs_main` ristrutturato:** `let color` diventa `var color` in un ramo annidato, e su Metal la compilazione può cambiare un bit. Il cancello resta al bit (rischio 1 del passo 7): un punto diverso si indaga con le quattro gambe di `regress` e la bisezione (Task 9, Step 3); una differenza della sola compilazione va al proprietario coi numeri, senza accettarla né allentare il cancello.
13. **L'avviso dopo un secondo:** conta solo il tempo illuminato senza caricamenti di texture in corso, al più 100 ms per frame; una sprite senza texture per meno di un secondo così non avvisa, per scelta (`engine.lighting.groups` la mostra); un caricamento che non si conclude mai, o uno sempre in corso, rimanda l'avviso; un `await` di altro tipo, più lungo di un secondo, fra `.light()` e `.texture()` avvisa una volta. Un layer che il renderer non ha caricato avvisa (sotto-decisione 4 (c)); uno caricato con un'altra texture no (una handle stantia, §4 del giro, punto (6)).
14. **Il sub con un cookie** è verificato solo nel testo (la coda del blend è del passo 7); il mix lo legge il check del cookie.
15. **Ogni immagine dei tier si gira rispetto a prima** (sotto-decisione 2 (e); solo il disegno, ombre comprese): solo 2D Twins legge texture, e il cancello M4 non vede mai un pixel con texture (`capture.js` legge dopo il setup, e le tre scene con texture (l'ordine trasparente, il sort e le immagini diritte) si distruggono dentro il setup); nessun banco committato usa texture, quindi `regress`, `order` e `mix` restano al bit. Il cancello M4 (Task 9, 9d) è però il solo testimone al bit su `scene-hdr` che i pixel senza texture non cambiano coi moduli ricomposti: i punti C di ogni tab tranne Lighting (sulle primitive opache i moduli per tipo, quad, linee, bezier e gradient; sui trasparenti, i punti C∩T, l'uber: 115 in Primitives e 208 in 2D Twins, in B e in C, al passo 7). Un punto diverso lì, oltre agli id dei mover, si indaga, non si accetta (rischio 12): una cattura su una pagina nuova col preludio di `443dc7f` installato da `recompileShader('prelude', …)` prima del primo tab (`gpu-infra.sh up … --git /old-prelude.wgsl=443dc7f:ts/src/shaders/primitives/prelude.wgsl`); coi punti C identici al passo 7, la causa è la compilazione del preludio nuovo, che va al proprietario coi numeri, senza accettarla né allentare il cancello. Un KTX2 scritto 'ru' resta capovolto (`KTXorientation` non si legge).

## Sotto-decisioni, decise dal controller il 2026-10-14 (delega del proprietario)

Il proprietario ha delegato le sotto-decisioni al controller ("le decisioni prendile tu dopo un'accurata analisi dei pro e contro; dobbiamo puntare al miglior prodotto possibile"; memoria `feedback-autonomous-round`): per ciascuna un gruppo di analisti e un giudice, col criterio della qualità del prodotto. Le prove dei giudici citate negli step (`judge-sd1-mirror/`, `sd2-judge/`, `sd3-judge-13064/`, `sd4-judge-model/`, `d4-judge/`, `d3-judge/`) stanno nello spazio di lavoro della sessione del controller, non nel repo. Il record va nel §2 del piano del giro, nello stesso commit del piano (Task 0, Step 0); lo Step 3 del Task 0 le passa come ruling a `sdd-tasks`. Il rapporto finale le elenca, perché il proprietario possa ribaltarle, e segnala le tre che estendono il passo: la 2 (e), la 3 (c), la 4 (c)+(d).

1. **Lo specchio, con una scala negativa: (a).** Opzioni: (a) `spriteAxes` col segno del determinante; (b) solo un quarto di giro dal facing (determinante sempre +1). Fuori: la colonna 1 normalizzata (un parallelogramma oltre `range·√2`, esclusa dal §2), la decomposizione polare (sotto shear il facing lascia il +x locale), il determinante calcolato a parte (un secondo lettore della colonna 0 fuori da `lightFacing`, e peggio a θ = π), lo specchio nell'uv invece che nella geometria (stessi pixel, ma perde il legame col `quad_vs`).
   - (a), pro: esatta per ogni parte 2×2 dove `lightFacing` non ripiega, shear compreso: `dot(side, colonna 1) = det / |colonna 0|` (modello f32 del giudice: 0 discordanze su 500 000 trasformazioni, angoli entro 1,3e-7 di `range·√2`); si compone nella gerarchia (un rig girato con `scale(-1, 1)` specchia il cookie delle luci figlie, esatto; (b) lo gira di mezzo giro); più espressiva di (b), il cui mezzo giro è `rotation(θ + π)` in (a); una y negativa specchia il cookie dall'alto in basso; tiene la parola del §2 al passo 6, «una scala x negativa specchia», che (b) farebbe diventare un mezzo giro. Nessun costo a runtime: la pipeline delle luci a HEAD non ha `cullMode` (`light-accum-stage.ts:147`, default WebGPU `'none'`) e nessuna luce di oggi è avvolta in senso orario; il Task 2 rende `'none'` esplicito e lo fissa con un test e un mutante.
   - (a), contro: «come un quad» vale per la mappatura uv (`quad_vs`), non per ciò che un quad mostra: oggi un quad con la stessa trasformazione non si disegna (`cullMode: 'back'` in `forward-pass.ts:271`, `:285`, `occluder-seed-stage.ts:96`, `selection-seed-pass.ts:107`; §4, punto (1b)); il segno della scala y conta per la prima volta (invisibile su spot e sole); sotto il ripiego di `lightFacing` (|colonna 0| ≤ 1e-6) il facing è il +x del mondo, come per uno spot, e il lato segue la y della colonna 1: un frame degenere.
   - (b): una x negativa dà un mezzo giro, una y negativa si ignora, un rig girato gira il cookie invece di specchiarlo; il suo solo vantaggio, nessuna faccia oraria, non vale nulla (la pipeline delle luci non ha mai scartato facce).
   - **Scelta: (a)**, il codice dei task. Il difetto dei quad specchiati va nel §4 del giro, punto (1b), con una correzione candidata che il proprietario colloca: il passo 8 non lo corregge. Con (b) sarebbero cambiati `spriteAxes` e il suo test (Task 3); il mutante `mat2x2f(facing, side)` dello Step 5b, che è (b) stessa; il test, il doc della classe e il commento della pipeline del Task 2 («wound clockwise»); il JSDoc (Task 4); l'`expect` di `MIRRORS` (in y (i, j), in x (3−i, 3−j)), il difetto `noMirror` coi suoi test, la sua causa nel verdetto e la testata di `lighting-sprite.ts` (Task 5); la riga di CLAUDE.md `:276` e la voce 13 di `webgpu-pass-reviewer` (Task 6); il `context` del Task 8; il Review Focus 2.
2. **L'orientamento delle immagini: (e), estensione del passo.** A HEAD la prima riga dell'immagine cade sul lato −y locale di quad, linea e bezier (`quad.wgsl:6`, `line.wgsl:77`, `bezier.wgsl:8`): l'immagine appare specchiata dall'alto in basso (statuses del passo 7, cella 1: (0,686, 0,769, 0,307); il modello del giudice dà 0,684/0,772/0,309), e su un quad nessuna trasformazione la corregge.
   - (a) il cookie copia il quad, capovolto: nessun rischio, ma un'API nuova sbagliata per difetto, con un rimedio (`scale(1, -1)`) che vale solo sulle luci e che una correzione futura romperebbe in silenzio; (b) cookie diritto e quad com'è: due convenzioni per lo stesso PNG; (c) il giro in `quad_vs`: quad e cookie diritti, ma linee e bezier con texture restano girate rispetto ai quad (oggi i tre concordano); (d) un passo a sé: lo stesso prodotto con un ciclo intero in più, o i difetti di (a) nel frattempo; (f) `flipY` al caricamento: i blocchi KTX2 non possono seguirlo; (k) girare ogni uv del quad unitario: rompe la geometria di gradient e bezier.
   - (e), il giro alla lettura in `sampleTierOrWhite`: una regola per ogni primitiva con un'immagine; nessun uv di vertice cambia, i pixel senza texture restano identici al bit (l'indice 0 risponde bianco prima del giro), le librerie future ereditano la regola, il codice di vertice del cookie già provato resta com'è. Contro: tocca il preludio dei 7 moduli; `sampleTierOrWhite` prende l'uv locale e `sampleTier` coordinate di texture (documentato e fissato da un test); cambiano anche linee e bezier con texture; un secondo legame di testo per il cookie. Costo vicino a (c).
   - **Scelta: (e)**, del giudice (due analisi su tre preferivano (c); (e) raggiunge anche linee e bezier allo stesso costo, senza toccare un uv di vertice). La regola: un'immagine dei tier si disegna diritta nel riferimento locale della sua primitiva, la prima riga verso +y e la prima colonna verso −x; il giro vive una volta in `sampleTierOrWhite`, dopo la risposta bianca (`var image = in; image.uv = vec2f(in.uv.x, 1.0 - in.uv.y); return sampleTier(image);`), e il cookie copia le due righe; msdf resta grezzo. Un commit suo (Task 3, Step 0), col probe di 'Depth orders transparent sprites' a `ORDER_Y - 0.15` (lo stesso texel, gli stessi valori), e un check nuovo in 2D Twins (Task 5). Estensione del passo: cambia come si disegnano tutti i quad, le linee e le bezier con texture, e le loro ombre, anche in scene, tape e snapshot vecchi (solo il disegno, revocabile come un commit). `MIRRORS` non dipende dalla convenzione (16/16 con l'una e con l'altra regola): l'affermazione di prima, che (b) lo cambiasse, era sbagliata. Restano registrati: il quad specchiato che sparisce (§4 (1b)), `KTXorientation`, la convenzione del rettangolo dell'atlante MSDF (solo documentata).
3. **Il set SDF di una luce ombreggiata che non può disegnare (`range` ≤ 0, o una sprite al layer 0): (c), estensione del passo.** Le tre opzioni danno gli stessi pixel (struttura verificata dal giudice; 0 discordanze su 80 000 scene a caso nei modelli): una luce che non può disegnare non raggiunge mai una marcia. Cambiano il costo, quello che dice `engine.lighting.groups` e la semplicità della regola.
   - (a) contarla sempre: un flood per niente (+1,84 ms a 1080p sull'iGPU AMD per set), permanente in Mode A; contraddice la correzione del passo 6 per il sole; due test si invertirebbero, e il locale `untextured` di `deriveLightGroups` passerebbe al Task 4 (nel Task 3 nessuno lo leggerebbe, e `noUnusedLocals` rifiuta un locale mai letto), e con lui `untexturedPredicate`, che nel Task 3 nessuno chiamerebbe. (b) solo se può disegnare, per la sprite (il codice dello Step 4): lascia lo stesso spreco a point e spot (verificato a HEAD: una point ombreggiata a range 0 apre un set e può dividere un gruppo, 2 gruppi e 1 set dove (c) dà 1 gruppo e nessuno), un difetto visto al passo 6 e mai registrato; il commento del suo gate sarebbe falso per point e spot; tre casi in una regola. (c) una regola per ogni tipo ombreggiato, `primParams[i * 8 + 3] > 0 && (type !== SPRITE || !untextured(i))`: solo CPU, più corta; uno slider, un tween a 0 o una luce parcheggiata a range 0 smettono di pagare un flood; nessuna scena, banco o test ha un `range` ≤ 0.
   - **Scelta: (c)**, nella forma del giudice: lo Step 7b del Task 3, un commit suo, che generalizza sul posto il test del sole (nessun conteggio cambia; un `git revert` lo toglie, come il `bbf7183` del passo 6), coi suoi mutanti, provato dal giudice in un clone dello specchio. Gli elenchi dei tipi non cambiano lì: i due gate cambiano insieme nello Step 7. Estensione del passo (point e spot, solo CPU, stessi pixel): il rapporto finale la segnala con lo SHA dello Step 7b. Restano, conservativi (un flood di troppo, mai un'ombra persa), per il passo 9: un `range` positivo sotto un texel dell'SDF, una luce ombreggiata nel margine del raggruppamento ma non listata, un `range` +inf da `snapshot_restore` (rischio 8); il quarto residuo del giudice, una sprite con un layer oltre il suo array, lo chiude la 4 (c) in Mode B e C.
4. **Il layer 0 e i layer che il renderer non ha: (a) sulla GPU, più (c) e (d), estensione del passo.** La decisione 3 del §2 dice: senza texture (l'indice 0) nessuna luce, con un avviso. Ma il layer 0, riservato in ogni array, non contiene mai una texture: bianco se rgba8 (l'overflow sempre, il primario senza formato compresso), nero trasparente se BC7 (un blocco tutto zero è la modalità riservata 8, che dà zeri), il colore d'errore se ASTC (un blocco tutto zero ha una modalità di blocco riservata, quindi è illegale: magenta opaco, o quattro NaN in una decodifica lineare come `astc-4x4-unorm`; KHR_texture_compression_astc_hdr, C.2.5, tabella C.2.8, C.2.24; solo specifica, non misurato: l'M2 usa BC7); un layer oltre l'array si limita all'ultimo; in Mode A ogni array ha un layer.
   - (b) l'indice 0 alla lettera: tiene la lettera e tradisce l'intento (il layer 0 di un overflow accende un quadrato bianco su ogni device; quello di un primario dei tier 1-3 bianco su rgba8, niente su BC7, il colore d'errore su ASTC; un layer oltre l'array prende l'ultimo; in Mode A ogni indice di overflow accende un quadrato bianco; tutto senza avviso). (a) il layer 0 sulla GPU (`vs_main` scarta `layer == 0u`, `fs_main` `in.texLayer >= cookieLayers(in)`): chiusa su ogni device, ma ogni altro indice che non nomina una texture resta buio senza avviso e, ombreggiato, apre un flood che nessuno legge; e lasciarlo senza avviso non ha una ragione vera: il renderer ha i conti dei layer di ogni array, e il `textureTiers` del Task 5 li legge.
   - (c), in più lato CPU i layer IN USO di ogni array (`getLayerCount`/`getOverflowLayerCount`): flag, gate SDF e avviso contano come senza texture anche un layer pari o oltre quel conto, col tier mappato come il ramo di default di `sampleTier` e `cookieLayers`. Ogni handle del `TextureManager` nomina un layer sotto quel conto (`texture-manager.ts:704`/`:719`, `:730`/`:748`, `:782`/`:796`, `:818`/`:840`): la regola non segna mai un cookie caricato (un conto dei layer allocati sì: un segnaposto ne riporta 0 con una vista di un layer). Nel modello del giudice (336 celle: 2 modi × 3 device × 56 indici) le celle buie senza avviso passano da 264 a 0; restano 4 celle segnate dove la GPU disegna, il colore d'errore dell'ASTC, ora con l'avviso; «tier > 3 senza texture» ne segnerebbe 14, 10 delle quali texture vere: scartata. Contro: circa 30 righe e 10 test non provati prima; un input facoltativo in più per `deriveLightGroups`; in Mode A il thread principale, senza `TextureManager`, tiene la regola del layer 0 (il render worker, che disegna, applica la regola intera). Residui: una handle stantia che nomina un layer caricato con un'altra texture accende quella (anche sui quad; il rimedio è un controllo al punto di chiamata, in un passo suo); su ASTC un indice estraneo nella parte mai caricata di un array allocato mostra il colore d'errore, con l'avviso. (d) un testimone a cinque letture nel cancello GPU del Task 3: col `TextureManager` rgba8 del cancello ogni layer protetto è bianco, e un guard mancante accende il bersaglio. Scartati anche i conti in `LightUniform` (un cambio GPU largo per un angolo dell'ASTC) e un controllo dev a `.texture()`/`raw.setTexture()`, che completa (c) ma non vede tape, snapshot né la Mode A (§4 (6)).
   - **Scelta: (a) sulla GPU, invariata, più (c) e (d)**, con la correzione dell'ASTC nei commenti, nel JSDoc e in CLAUDE.md e un test che fissa la riserva del layer 0 nel `TextureManager`. Il lavoro nuovo è un secondo commit del Task 4 (Step 7-11; mai un titolo «Task 4b»: l'`awk` di `task-brief` lo inghiottirebbe nel brief del Task 4). Un solo predicato, `untexturedPredicate` di `light-groups.ts`, per il flag, il gate SDF della 3 (c) e gli id dell'avviso. Estensione del passo: la regola dell'indice 0 si estende alla lettera al layer 0 di ogni array e, lato CPU, a ogni indice che questo renderer non ha caricato, sempre verso il lato chiuso (niente luce, un avviso).

**Conseguenze del §2 e del codice, non forche:** **D1, il mix con un cookie** (peso = alpha × ombra, bersaglio = colore × energia × rgb): l'unica lettura che dà colore × rgb·a per add, dal §2 del passo 7 ("il peso è l'intensità") e del passo 8 ("luce = colore × rgb·a"); piegare a nel bersaglio raddoppierebbe l'alpha per add o annerirebbe i texel trasparenti per mix; il check del cookie la legge sul device. **D2, LOD 0:** i PNG e i JPEG scrivono solo il mip 0 (`texture-manager.ts:705-709`) su catene intere (`:375-383`), e il ramo della sprite è flusso non uniforme, dove Tint rifiuta un LOD implicito.

**Forche con un default, decise:** **D3, la sede dei check: (a), tenuta.** (a) una sotto-scena del tab Lighting gira dovunque giri l'harness (`/gpu-check` in B e C, gli stati del cancello M4 a ogni passo dopo, la gamba Safari del passo 9, la sessione Fedora) ed è il primo controllo di routine che copia e distrugge un array popolato mentre i tre utenti del gruppo 1 disegnano, sotto un testimone; costi: +4 id ai tab dopo (la base M4 si ricattura e si controlla da sé), la crescita salta dal quinto ingresso in una pagina (le gambe previste entrano al più due volte), circa 1-1,7 s di setup in più. (b) un tab nuovo: `capture.js`, fissato dal cancello M4, ha una lista fissa di 10 tab e andrebbe cambiato nel passo che giudica; dopo Lighting ha gli stessi +4 id. (c) solo un banco: opt-in, fuori da `/gpu-check`, M4, Safari e Fedora, e piega la parola «demo» della riga 8 del §3. **Scelta: (a)**, il codice del Task 5. I due ritocchi di solo testo che il giudice dava come facoltativi non sono nel piano (R1: la skip del check 2 dice «full (256 layers)» quando al quinto ingresso il tier ne usa 129, e così il JSDoc di `modelEngine`, il suo test e il rischio 6; R2: la testata di `lighting-sprite.ts` non dice che il cookie e i filler restano caricati per la pagina): se l'auditor dei check (Task 5, Step 7b) li solleva, si correggono come un suo finding. **D4, l'avviso: (d').** Sul modello del giudice (21 scenari a 60, 120, 165 e 240 Hz, 84 celle; falsi positivi su codice giusto / falsi negativi su un errore vero): (a) 60 frame senza cancello, 36/0 (a 120 Hz avvisa su un caricamento giusto di mezzo secondo, e consuma l'unico avviso); (b) in `EntityHandle`, cieca a raw, replay e snapshot; (c) al primo frame, 48/0; (d) dell'analisi, il cancello che azzera il conto a ogni frame con un caricamento, 12/16 (un cookie dimenticato non avvisa mai mentre altri caricamenti si ripetono); il cancello in pausa con 60 frame, 12/4; (e) 1 s senza cancello, 24/0; (g) riarmato e (h) in produzione, contro la lettera della decisione 3. **Scelta: (d')**, 4/4: dal flag di `deriveLightGroups`, una volta per renderer, solo in dev, dopo `UNTEXTURED_SPRITE_MS` = 1000 ms di tempo illuminato (`performance.now()`: il render worker della Mode A non ha dt), ogni frame al più `HELD_STEP_CAP_MS` = 100 ms (uno stallo o una scheda nascosta non invecchiano il conto), in pausa finché `TextureManager.pendingLoads` > 0 (un frame con un caricamento in corso né conta né azzera: una texture in arrivo non è un errore, e un caricamento altrove non nasconde una texture che manca); il messaggio nomina fino a tre id esterni e il caricamento rifiutato. I 4 falsi positivi sono `await` di altro tipo oltre un secondo; i 4 falsi negativi, un caricamento che non si conclude mai. Un secondo e non 60 frame: un contratto che non dipende dallo schermo (l'M2 gira Chrome a 120 Hz). Il ripiego, se servisse un diff più piccolo: lo stesso cancello in pausa coi 60 frame, mai la forma che azzera. Il flag si legge in ogni build da `engine.lighting.groups`; l'avviso lo prova una gamba dal vivo in B e in A, più il cancello su un caricamento rallentato in B (Task 9, 9e).