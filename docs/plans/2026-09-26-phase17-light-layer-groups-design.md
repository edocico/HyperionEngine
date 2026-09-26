# Phase 17 — Light layers: un light buffer per gruppo di layer

**Stato:** design approvato il 2026-09-26, sezione per sezione. Implementazione autorizzata in autonomia.
**Estende:** `2026-08-04-phase17-lighting-2d-design.md` §7.3-§7.4, che diceva che la maschera "si applica in lettura nel ForwardPass". Con un solo light buffer non si può fare: il buffer ha già sommato tutte le luci prima che il ricevitore lo legga.
**Ricerca:** workflow `wf_ed15a7b7-75d` sul 2026-09-26. Ha letto i sorgenti di Unity 2D (`Unity-Technologies/Graphics` a7e4c051) e di Godot 4 (master 4617300) e ha mappato il codice Hyperion.

## 1. Scopo

`lightLayers()` oggi non ha effetto. Il flag viene salvato, entra nell'hash e nello snapshot, ma nessuno shader lo legge. Questo design lo rende operativo come fa Unity 2D: i layer con lo stesso insieme di luci e di caster condividono un light buffer.

Criteri di successo:
- uno sprite sul layer B non è illuminato da una luce che non ha B nella maschera;
- un occluder fa ombra solo sui ricevitori dei layer nella sua maschera;
- la scena di default (nessuno chiama `lightLayers()`) fa **esattamente** il lavoro GPU di oggi;
- nessun cambio di protocollo del ring buffer, di export WASM, di snapshot o di `state_hash`;
- il check "Light layers" della demo diventa reale.

## 2. Decisioni dell'utente

| Domanda | Scelta |
|---|---|
| Solo luci, o anche ombre per layer? | **Luci e ombre**: un occluder è assente dall'SDF dei gruppi che non ombreggia |
| Tetto agli SDF distinti | **Nessun tetto**: semantica sempre esatta, il costo cresce con i caster set distinti |
| Maschera 0 | **Default per ruolo, come Unity**: ricevitore → layer 0, occluder → tutti i layer, luce con `lightLayers(0)` esplicito → nessun layer |
| Ricevitore con più bit | **Solo il bit più basso, come Unity**. Si ottengono le stesse immagini spostando i bit sulle luci, e si evita l'ambiguità delle ombre |
| Architettura | **B: un nodo unico `light-groups`, set-major**, con le texture SDF riusate (memoria costante) |

## 3. Semantica delle maschere

La maschera è la parola 1 di `renderMeta`, bit 16-31: un campo con un ruolo diverso a seconda dell'entità.

| Ruolo | Riconosciuto da | Regola | Maschera 0 |
|---|---|---|---|
| **Luce** | primType 6 | Illumina i ricevitori dei layer nella maschera. Vale anche per le luci **globali e direzionali**, a differenza del DirectionalLight2D di Godot: una globale mascherata diventa un ambient per layer. | Nessun layer. `light()` usa 0xFFFF di default. |
| **Ricevitore** | bit 10 (`receivesLight`) | Appartiene a **un solo** layer, il bit più basso della maschera. Gli altri bit sono ignorati, con un avviso una volta sola. | Layer 0 |
| **Occluder** | bit 9 (`castsShadow`) | Fa ombra ai ricevitori dei layer nella maschera. Dall'SDF di un gruppo che non ombreggia è *assente*: non viene mascherato al momento del contatto, quindi non produce false penombre. | Tutti i layer |

Un'entità può essere insieme ricevitore e occluder (un muro, una cassa): usa la stessa maschera nei due ruoli. È nel proprio SDF solo se la maschera include il suo layer di ricevitore. La logica "esci dal tuo occluder" di `shadow()` resta com'è.

Limiti accettati, da documentare:
- la chiave dell'occluder è il layer del RICEVITORE, non la luce come in Godot (`occluder_light_mask`);
- "illuminato da L ma non ombreggiato da L" (la terza relazione di Godot 4.4) non si esprime con un solo campo. Il rimedio è quello che usano anche gli utenti Godot: due luci;
- l'ambient di motore pulisce **ogni** buffer di gruppo. Un layer senza luci mostra l'ambient, mai nero: in Unity è una trappola nota.

## 4. Derivazione dei gruppi

`render/light-groups.ts` esporta una funzione pura, `deriveLightGroups(input): LightGroups`. È testabile headless e gira ogni frame sul lato render, solo quando il grafo live è illuminato.

**Input:** `renderMeta`, `primParams` e `bounds` di `GPURenderState`, `entityCount`, e i piani del frustum della camera (`extractFrustumPlanes`).

**Passo 1, raccolta.** Una scansione di `renderMeta` parola 1:
- **luci**: i valori distinti di maschera delle luci che **possono raggiungere lo schermo**. Si usa lo stesso test sfera-frustum del CullPass, con il raggio *ingrandito* (×1,01 + 1e-3) in modo che l'insieme CPU sia un sovrainsieme di quello GPU. Una globale o direzionale ha raggio f32::MAX ed è sempre dentro.
- **`shadowedLayers`**: l'OR delle maschere delle luci visibili che proiettano ombra. È lo stesso test dello shader: point o spot con `clamp(primParams[7], 0, 1) > 0`. Globali e direzionali per ora non proiettano ombre.
- **occluder**: i valori distinti di maschera normalizzati (0 → 0xFFFF) degli occluder che possono raggiungere lo schermo, con lo stesso test conservativo. L'SDF è screen-space, quindi un occluder fuori schermo non conta niente. Non filtrarli invece creerebbe set inutili da 1,8 ms.
- **`receiverLayers`**: l'OR di `1 << layerOf(mask)` sui ricevitori delle primitive che campionano il light buffer (quad e gradient, `LIT_PRIMITIVE_TYPES`; review 2026-09-26) ~~senza filtro frustum. Un gruppo in più costa poco.~~ **in vista, con lo stesso test conservativo delle luci** (review 2026-09-26: un layer fuori schermo i cui caster in vista differiscono riceve un SDF set tutto suo, +1,84 ms per pixel che nessuno campiona). `layerOf(0) = 0`, altrimenti il bit più basso. Se un ricevitore ha più di un bit si alza il flag `multiBitReceiver`.

**Passo 2, chiavi.** Ogni layer occupato `b` ha una chiave:
- il bit `b` di ogni valore distinto di maschera luce;
- solo se `b ∈ shadowedLayers`, anche il bit `b` di ogni valore distinto di maschera occluder. Altrimenti la parte caster è "nessuna": i caster non contano dove nessuna ombra arriva, e la regola di Unity ("ogni caster diverso spezza il batch") dividerebbe gruppi senza motivo.

**Passo 3, gruppi e set.**
- Layer con la stessa chiave formano un gruppo. Unity chiede anche che i layer siano consecutivi, ma solo perché disegna gli sprite per intervalli di sorting layer; il ForwardPass di Hyperion è unico, quindi qui la regola non serve.
- Gruppi con la stessa parte caster condividono un **SDF set**.
- Un gruppo con parte caster "nessuna" non ha set.

**Output (`FrameState.lightGroups`):**

```ts
interface LightGroups {
  groups: Array<{ layers: number /* u16 */, sdfSet: number /* -1 = no SDF */ }>;
  sdfSets: Array<{ occluderLayers: number /* u16: the layers of its groups */ }>;
  layerToGroup: [lo: number, hi: number];  // 16 × 4 bits, bit b → group index
  multiBitReceiver: boolean;
  /** For the debug readout: the distinct values that split the groups. */
  lightMasks: number[]; occluderMasks: number[];
}
```

Con più di 16 gruppi non ci si arriva: i layer sono 16, quindi i gruppi sono al massimo 16 e i set al massimo 16. Con zero ricevitori resta un gruppo fittizio, che mantiene valido il binding del ForwardPass.

Le chiavi dipendono dai **valori** delle maschere, non dalle entità. Spostare le cose non basta a rifare i gruppi: cambiano quando un valore compare o sparisce, o quando una luce, un occluder o un ricevitore illuminato entra o esce dalla vista (review 2026-09-26: da quando i ricevitori hanno il filtro frustum, anche uno sprite da solo sul suo layer può portarsi dietro un intero SDF set).

Costo misurato del prototipo (Node 24, dati sintetici, senza filtro frustum): 0,018 ms a 10k entità, 0,15-0,19 ms a 100k. Il filtro frustum si applicava allora solo a luci e occluder; dal 2026-09-26 anche ai ricevitori.

## 5. Struttura GPU

### 5.1 Il nodo `light-groups` (`LightGroupsPass`)

Sostituisce i nodi `occluder-seed`, `sdf-0..N` e `light-accum`. Legge `visible-indices`, `entity-transforms`, `indirect-args`, `render-meta`, `tex-indices` e `prim-params`; scrive `light-buffer`.

Possiede le sue texture, dimensionate a `halfResolution` del canvas ogni frame, grow-only sul numero di layer:
- `seed` e il ping-pong `sdfA`/`sdfB` (JFA_FORMAT), **riusati** da ogni set;
- `lightBuffer`: rgba16float 2d-array con `max(1, G)` layer, `textureBindingViewDimension: '2d-array'`. Una vista `2d` per layer (`baseArrayLayer = g`) per il rendering, una vista `2d-array` registrata nel pool come `light-buffer`;
- `noOccluder`: SDF placeholder 1×1 (valid = 0, che vale "nessun occluder") per i gruppi senza set.

Ordine per frame, **set-major**:

```
for set s:
    seed(s)            occluder pipelines, uniform slice {VP, occluderLayers = s.layers}
    sdfChain(s)        1 + iterationsForDimension(maxDim) passes, power-of-two steps, over seed → sdfA/sdfB
    for group g with sdfSet == s:
        accumulate(g)  render pass on lightBuffer layer g, clear = ambient,
                       Light2D buckets (args 12, 13, 26, 27), uniform slice {…, groupLayers = g.layers},
                       SDF = final ping-pong texture of s
for group g with sdfSet == -1:
    accumulate(g)      SDF = noOccluder
```

Tutti gli uniform per set e per gruppo stanno in slice allineate a 256 byte e si scrivono **una volta** in `prepare()`. Come nel gotcha del BloomPass, un `writeBuffer` tra un pass e l'altro dello stesso frame arriva solo con l'ultima scrittura.

`OccluderSeedPass`, `SdfJfaPass` e `LightAccumPass` diventano **stadi** del nodo, non più nodi del grafo: `OccluderSeedStage`, `SdfChainStage` e `LightAccumStage`, nei file `*-stage.ts`. Ognuno ha le sue pipeline, `setup(device, resources)`, `destroy()` e un metodo di encode per il singolo set o gruppo. I loro test seguono.

### 5.2 Shader

- **`light-accum.wgsl`:** `LightUniform._pad1` diventa `groupLayers: u32`. `vs_main` emette un triangolo degenere quando `((renderMeta[e*2+1] >> 16) & u.groupLayers) == 0`, quindi una luce con maschera 0 non disegna niente.
- **I sei shader primitivi:**
  - `CameraUniform` passa da 64 a 80 B (`viewProjection`, `occluderLayers: u32` e tre pad scalari);
  - il test occluder in `vs_main` diventa "degenere se NON castsShadow **oppure** `(normalized(mask) & camera.occluderLayers) == 0`", con `normalized(0) = 0xFFFF`;
  - il ForwardPass scrive `occluderLayers = 0` (non lo usa);
  - il camera buffer del ForwardPass e quelli di seed passano a 80 B, e la voce del layout ha `minBindingSize: 80`, così un disaccordo è un errore di validazione e non di draw.
- **`basic.wgsl` / `gradient.wgsl`:**
  - il gruppo 2 binding 0 diventa `texture_2d_array<f32>`;
  - `LightingUniform` è `{enabled, groupTableLo, groupTableHi, _pad}`, sempre 16 B;
  - `fs_main` calcola `layer = select(firstTrailingBit(mask), 0, mask == 0)` e da lì `group = (table >> 4·(layer % 8)) & 0xF`, poi fa un solo `textureSampleLevel(lightBuffer, sampler, uv, group, 0)`.
- **`sdf-jfa.wgsl`:** invariato.

## 6. Integrazione

- **Grafo:**
  - `GraphMode` è invariato;
  - `factories.lighting()` restituisce `[new LightGroupsPass()]`;
  - la validazione degli overlay vede i nuovi nomi;
  - il grafo illuminato scende da 17 a 5 pass vivi;
  - il numero di gruppi o set può cambiare a ogni frame **senza rebuild**.
- **Renderer:**
  - escono le texture ping-pong SDF, `sdfChain()`, `ensureSdfChainFits`, `updateSdfTextureViews`, il tracciamento `instanceof SdfJfaPass` e il ramo lighting di `prepareMode`;
  - esce `GraphRequests.rebuild()`, che resta senza utilizzatori, con i suoi test;
  - `render()` calcola `frameState.lightGroups` solo quando `host.mode.lighting` è vero.
- **ForwardPass:** in `prepare()` legge la tabella da `FrameState.lightGroups` e riscrive il suo uniform da 16 B. Il placeholder diventa un 2d-array a 1 layer.
- **Hot-reload:** le probe degli slot `sdf-jfa` e `light-accum` usano un `LightGroupsPass` usa-e-getta, il cui setup compila tutti gli stadi. Gli slot dei primitivi compilano anche le pipeline occluder.
- **Profiler:**
  - un `RenderPass` può esporre `profileStages?(frame): string[]`, i nomi degli stadi che marcherà in quel frame, e riceve una funzione `mark(encoder)` come quarto argomento di `execute`;
  - i tempi escono come `light-groups/seed`, `light-groups/sdf` e `light-groups/accum`, sommati sui set: `consume()` somma gli intervalli con lo stesso nome nello stesso frame;
  - la capacità del profiler passa da 32 a **256 marker**. Il query set costa 2 KB ed esiste solo con il profiling attivo. Per costruzione un frame ha al massimo circa 20 pass del grafo più 16 set × 3 stadi, quindi non serve un query set che cresce.
- **Mode A:** lo stesso `renderer.render()` gira nel render worker.
- **Debug:** `engine.lighting.groups` applica la stessa funzione pura a `latestRenderState`, con la camera del main thread. In Mode A è approssimato, perché la camera del worker non è sincronizzata (gap noto); in B e C è esatto. Restituisce il numero di gruppi e di set e le maschere che li dividono.

## 7. Costi attesi

Riferimento: iGPU AMD RDNA 3, 1080p, design §13.2.

| Scena | Costo GPU | Memoria |
|---|---|---|
| Default (1 gruppo, 1 set) | identico a oggi, ≈ 2,3 ms | identica |
| Luci illuminanti senza ombre | l'SDF è saltato, **−1,8 ms** rispetto a oggi | come oggi |
| +1 gruppo che condivide un set | + l'accumulo delle sue luci, più un clear half-res | +4,15 MB (un layer) |
| +1 caster set distinto | +1,8 ms (seed + catena) | **nessuna** |
| Luce che colpisce k gruppi | disegnata e marciata k volte | — |
| Lato CPU | 0,02 ms a 10k entità, ≈ 0,2 ms a 100k, solo col grafo illuminato | — |

## 8. Test e verifica

**Headless**, in TDD con i test scritti prima (RED):
1. `deriveLightGroups`:
   - scena di default → 1/1;
   - default per ruolo della maschera 0;
   - bit più basso e flag multi-bit;
   - raggruppamento per valore;
   - caster contati solo dove arriva una luce con ombra;
   - dedup dei set, gruppo senza set;
   - frustum conservativo al bordo: luce appena fuori esclusa, appena dentro inclusa, globale sempre;
   - 16 layer distinti → 16/16;
   - impacchettamento della tabella;
   - zero ricevitori.
2. `LightGroupsPass` con device mock:
   - ordine set-major;
   - riuso delle stesse texture;
   - slice a offset di 256 byte scritte una volta;
   - una vista per layer;
   - riallocazione grow-only;
   - SDF saltato senza luci con ombra;
   - lunghezza della catena dalla dimensione corrente;
   - clear all'ambient su ogni layer.
3. Shader, sul testo:
   - filtro in light-accum;
   - 80 B e test occluder nei sei primitivi;
   - array e tabella in basic e gradient;
   - `uniform-layout.test` e storage budget.
4. ForwardPass:
   - gruppo 2 a 2d-array;
   - camera a 80 B con `minBindingSize`;
   - tabella aggiornata ogni frame.
5. Profiler:
   - stadi sommati;
   - capacità oltre 32.
6. Grafo: test di graph-assembly, graph-host e graph-requests aggiornati.

**GPU** (Chrome, adapter AMD, harness Mode B):
1. Una luce sul layer 1 non illumina uno sprite sul layer 0: readback dei pixel.
2. Un muro con maschera "layer 0" ombreggia solo i ricevitori del layer 0.
3. La scena di default è identica a prima: readback prima e dopo sullo stesso frame.
4. Un cambio di maschera a runtime cambia i gruppi senza rebuild.
5. Resize.
6. Si misura il costo per set e per gruppo, poi si annota in §13.2.
7. Zero messaggi WebGPU.
8. Review avversariale finale (workflow).

## 9. Rischi

- **Render su un layer di un 2d-array:** non esiste ancora nel codice. Va validato in Chrome. In modalità compatibility non si può campionare una vista `2d` di un array multi-layer, quindi le texture SDF restano texture separate.
- **Il `CameraUniform` a 80 B deve cambiare in tutti e sei gli shader e in tutti i buffer insieme.** È il motivo di `minBindingSize`.
- **CPU e GPU devono concordare su cosa è una luce con ombra.** Se non concordano, un gruppo paga un SDF inutile, oppure marcia sul placeholder e perde le ombre.
- **Senza tetto**, una sola chiamata a `lightLayers()` può aggiungere 1,8 ms. Per questo servono il readout di debug e la sezione di CLAUDE.md.

## 10. Fuori scope

Restano fuori:
- la semantica OR per i ricevitori con più bit;
- la terza relazione di Godot, "illuminato ma non ombreggiato";
- l'ambient per layer, oltre a quello già ottenibile con globali mascherate;
- l'MRT per accumulare una luce su più gruppi in un pass;
- `TRANSIENT_ATTACHMENT`;
- le ombre delle luci globali e direzionali.
