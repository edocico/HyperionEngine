# Passaggio al MacBook M2 — handoff del 2026-09-29

Stato alla partenza: `master` è a `b2ccd0c` (merge di `feat/transparent-sort-uber`, la fase 5b: sort GPU dei trasparenti + pipeline uber), pushato il 2026-09-29. Sopra c'è il commit che aggiunge questo documento, la copia della memoria di Claude in `docs/handoff/claude-memory/` e i puntatori in `CLAUDE.md` e nel piano del giro. Il giro degli open-items (`docs/plans/2026-09-27-open-items-round-plan.md`) è **in pausa prima del passo 6**: le sue decisioni aperte aspettano la fine dei test sul Mac. Si passa al Mac perché sulla macchina Fedora non si possono verificare Metal, Safari e Mode A. Mode A lì non si controlla perché l'initScript low-power non arriva ai worker, e la NVIDIA non presenta sul canvas. Sul Mac c'è una sola GPU, niente initScript e niente flag Vulkan. Inoltre l'M2 potrebbe essere la prima GPU che presenta sul canvas con il percorso cull a subgroup attivo (32 lane), e sul Mac ci sono timing reali. Su Metal non gira nulla dal 2026-08-04 (`04b973b`): da allora sono passati 166 commit, tra cui la lighting della fase 17, il probe, le linee in pixel, il riuso degli id, la depth 2D e la 5b.

Chi legge cosa:
- la **sezione 1** è per te, da fare nel Terminale prima di avviare `claude`;
- dalla **sezione 2** in poi il testo è per la sessione di Claude Code sul Mac, che legge questo documento al primo turno.

---

## 1. Prima di avviare `claude` sul Mac (solo tu)

Due regole per incollare i comandi in zsh:
- nessun commento `#` sulla riga del comando: in una zsh interattiva `#` non è un commento, finisce tra gli argomenti e rompe il comando (per esempio `git pull`);
- gli URL con `?` vanno tra apici: senza apici zsh prova a espanderli come glob e si ferma con `no matches found` prima di eseguire il comando.

Fai tutto nella **stessa finestra del Terminale**: i passi dal 5 in poi usano le variabili `R` e `S`.

### 1.1 Architettura (niente Rosetta)

```
uname -m
sysctl -n sysctl.proc_translated
```

Deve dare `arm64` e `0`. Se `proc_translated` vale `1`, il Terminale gira sotto Rosetta. In quel caso vai in Finder → Applicazioni → Utility → Terminale → Ottieni informazioni, togli "Apri con Rosetta" e riapri il Terminale. Sotto Rosetta tutto diventerebbe x86_64 senza avvisi: rustup, node, e con loro `@esbuild/darwin-x64`.

### 1.2 Xcode Command Line Tools

```
xcode-select -p || xcode-select --install
```

Portano `cc`/`ld` (il linker per i test nativi Rust), `git` e `/usr/bin/python3`. Se si apre la finestra di installazione, aspetta che finisca.

### 1.3 Homebrew in `/opt/homebrew`

```
brew --prefix
```

Deve stampare `/opt/homebrew`. Se `brew` manca:

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Se trovi un Homebrew in `/usr/local` (residuo di una migrazione da Intel), non usarlo per questo progetto.

### 1.4 Claude Code aggiornato

```
claude --version
claude update
claude --version
claude doctor
```

Serve almeno la **2.1.284**, la versione di questa macchina. Se `claude update` fallisce: `curl -fsSL https://claude.ai/install.sh | bash`. Una versione di agosto potrebbe non avere il tool Workflow: senza, la `adversarial-review` prima dei merge non gira e skill e impostazioni si caricano in modo diverso.

### 1.5 Il repository

**Dove sta il clone.** Si tiene quello che c'è già in `/Users/edoardocicognani/Desktop/Code/HyperionEngine`. Lo sposti in `~/Code/HyperionEngine` **solo** se iCloud sincronizza la Scrivania. Per controllare: Impostazioni di Sistema → [il tuo nome] → iCloud → iCloud Drive → "Cartelle Scrivania e Documenti". In Finder, con la sincronizzazione attiva, "Scrivania" compare sotto iCloud nella barra laterale. Con la sincronizzazione attiva `target/` e `ts/node_modules` (GB) finirebbero su iCloud.

Caso normale (Scrivania non sincronizzata):

```
R=~/Desktop/Code/HyperionEngine
S="$HOME/.claude/projects/-Users-edoardocicognani-Desktop-Code-HyperionEngine"
```

Caso iCloud attivo. Prima guarda nel vecchio clone se c'è lavoro di agosto (i comandi di controllo qui sotto, eseguiti con `R` sul vecchio percorso). Poi spostalo, oppure clonalo da capo: il clone nuovo è più sicuro se è attiva "Ottimizza spazio di archiviazione Mac", perché alcuni file potrebbero non essere in locale. Fallo **prima** di `claude mcp add` (1.12) e del ripristino della memoria (1.13): lo scope local di MCP e la cartella della memoria dipendono dal percorso.

```
mkdir -p ~/Code
git clone https://github.com/edocico/HyperionEngine.git ~/Code/HyperionEngine
R=~/Code/HyperionEngine
S="$HOME/.claude/projects/-Users-edoardocicognani-Code-HyperionEngine"
```

Con il clone spostato, nella sezione 6 il task 6.6 (percorso di close-phase) diventa obbligatorio.

**Aggiornamento.** Il vecchio clone è fermo a `04b973b` (2026-08-04), 166 commit indietro. Prima controlla che non contenga lavoro di agosto:

```
cd "$R"
git status
git stash list
git branch -vv
git log --oneline origin/master..HEAD
```

Se trovi modifiche o commit locali, non buttarli: salvali su un branch (`git switch -c mac-august-leftovers`, poi commit) oppure con `git stash`. Poi:

```
git fetch --prune origin
git switch master
git pull --ff-only
git log --oneline -3
git merge-base --is-ancestor b2ccd0c HEAD && echo OK
ls docs/handoff
```

Risultato atteso: in cima il commit dell'handoff, che aggiunge `docs/handoff/`, sotto `b2ccd0c`, poi `OK` e l'elenco `2026-09-29-mac-m2-handoff.md` e `claude-memory`. Non fare checkout di `origin/feat/transparent-sort-uber`: è un ref vecchio, 23 commit dietro master, che contiene già tutto il suo lavoro (i 22 commit del branch locale di Linux mai pushati sul branch sono arrivati su master con il merge). Anche `origin/feat/phase17-lighting-2d` è già mergiato.

Il `target/` di agosto può restare: è aarch64 e cargo lo ricompila (`cargo clean` solo se una build si comporta in modo strano). `ts/node_modules`, `ts/wasm` e `ts/wasm-physics` li ricostruisce la sezione 2. **Non copiare mai `node_modules` o `target/` da Linux**: contengono binari x86_64-linux.

### 1.6 Rust (rustup, non `brew install rust`)

Il Rust di Homebrew ignora `rust-toolchain.toml` e non ha la std wasm32, quindi `wasm-pack` fallisce. Controlla quale rustc trovi:

```
which -a rustc cargo rustup
```

Se compare `/opt/homebrew/bin/rustc`, rimuovilo con `brew uninstall rust`. Se rustup manca:

```
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none
. "$HOME/.cargo/env"
```

Poi, sia con un rustup nuovo sia con uno di agosto:

```
rustup self update
cd "$R"
rustup toolchain install
rustup component add rust-analyzer rust-src --toolchain 1.97.1
rustup show active-toolchain
rustc -vV
rustup target list --installed
```

`rustup toolchain install` senza argomenti legge `rust-toolchain.toml` (1.97.1 + `wasm32-unknown-unknown` + clippy + rustfmt) e richiede rustup ≥ 1.28; su Linux c'è la 1.29.1. Risultati attesi:
- `1.97.1-aarch64-apple-darwin (overridden by '…/rust-toolchain.toml')`;
- in `rustc -vV`: `release: 1.97.1` e `host: aarch64-apple-darwin`;
- tra i target installati: `wasm32-unknown-unknown`.

`rust-analyzer` è facoltativo: serve al plugin `rust-analyzer-lsp`, abilitato in `.claude/settings.json`, che anche su Linux era senza binario. Controlla che `~/.zprofile` (o `~/.zshenv`) contenga `. "$HOME/.cargo/env"`. L'installer di rustup di solito lo aggiunge da solo.

### 1.7 wasm-pack e naga (le stesse versioni di Linux)

```
cargo install wasm-pack --version 0.14.0 --locked
cargo install naga-cli --version 30.0.1 --locked
wasm-pack --version
naga --version
```

Se una delle due c'è già in una versione diversa, aggiungi `--force`. Alla prima build `wasm-pack` scarica da solo `wasm-bindgen-cli` 0.2.126 (quello di `Cargo.lock`) in `~/Library/Caches/.wasm-pack`. `naga` serve a `scripts/validate-wgsl-naga.mjs`.

### 1.8 binaryen, Node 24, jq, gh, Pillow

```
brew install binaryen node@24 jq gh python pillow
echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.zprofile
. ~/.zprofile
```

`node@24` è keg-only, per questo serve la riga del PATH. `ts/.nvmrc` dice `24`, `ts/package.json` ha `engines ^24` e `ts/.npmrc` ha `engine-strict=true`: con qualsiasi altra major `npm ci` si ferma con `EBADENGINE`. `wasm-opt` va preso da binaryen, non da `cargo install wasm-opt` come dice `CLAUDE.md:118`: su Linux è la version 126 del pacchetto Fedora. Controlli:

```
which -a node python3
node -v
node -p process.arch
npm -v
wasm-opt --version
jq --version
python3 -c 'import PIL; print(PIL.__version__)'
```

Risultati attesi:
- node `v24.x` (Linux: v24.21.0, npm 11.19.0), arch `arm64`;
- `wasm-opt version 12x`;
- jq 1.x;
- una versione di Pillow (Linux: 12.3.0).

`python3` deve risolversi in `/opt/homebrew/bin/python3`, altrimenti il `pillow` di brew non si vede. In alternativa usa un venv: `python3 -m venv ~/.venvs/hyperion && ~/.venvs/hyperion/bin/pip install Pillow`, e poi chiama `pixels.py` con quel python.

**`jq` non è facoltativo.** Tutti gli hook del repo leggono il payload con `jq … 2>/dev/null`. Senza jq ogni hook esce con 0 senza dire nulla, compresa la guardia bloccante sul protocollo. Quindi `claude` va avviato da una shell di login che abbia questo PATH: gli hook e i server MCP basati su npx ereditano il PATH della shell. Una shell lanciata da un'app grafica potrebbe non averlo.

### 1.9 git e GitHub

```
gh auth status
gh auth login
gh auth setup-git
git config --global user.name
git config --global user.email
```

`gh auth login` serve solo se `status` dice che non sei autenticato. Se nome o email sono vuoti, usa gli stessi dei commit fatti su Linux (li leggi da un commit di master):

```
git -C "$R" log -1 --format='%an <%ae>' b2ccd0c
git config --global user.name 'edoardo cicognani'
git config --global user.email '<l email stampata dalla prima riga>'
```

Il remote è `https://github.com/edocico/HyperionEngine.git`. Il plugin `github` resta disabilitato (in `.claude/settings.json`): per il lavoro bastano `git` e `gh`.

### 1.10 Browser

**Chrome.** Se non è installato: `brew install --cask google-chrome`. Poi:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version
```

Deve essere il canale stable in `/Applications`, perché il server MCP avvia quello. Aggiornalo almeno alla 154 (Linux: 154.0.8037.57) da `chrome://settings/help`. Canary non serve.

**Safari**, configurazione da fare una volta sola:

```
sw_vers
sudo safaridriver --enable
```

Poi in Safari:
1. Impostazioni → Avanzate → "Mostra funzioni per sviluppatori web".
2. Menu Sviluppo → "Consenti automazione remota".
3. Se nella console `navigator.gpu` risulta `undefined`: Sviluppo → Feature Flags → WebGPU.

Che WebGPU in Safari sia attivo di default dipende dalla versione di Safari e di macOS: da verificare sul Mac, `sw_vers` dice quale hai.

### 1.11 Plugin e impostazioni locali

I plugin abilitati da `.claude/settings.json` vanno installati sul Mac:

```
claude plugin marketplace list
claude plugin marketplace add anthropics/claude-plugins-official
for p in superpowers commit-commands pr-review-toolkit code-review code-simplifier feature-dev claude-security claude-md-management claude-code-setup plugin-dev hookify skill-creator session-report remember lumen gitkraken rust-analyzer-lsp typescript-lsp learning-output-style explanatory-output-style; do claude plugin install "$p@claude-plugins-official"; done
npm i -g typescript-language-server typescript
```

`marketplace add` serve solo se il marketplace manca dall'elenco. `rootly` risulta abilitato ma non era installato nemmeno su Linux: saltalo. Non copiare il `~/.claude/settings.json` di Linux. Se vuoi le stesse impostazioni, riporta solo `"effortLevel": "xhigh"` e `modelSettings` (`claude-opus-5` e `claude-opus-5-5` a `xhigh`).

`.claude/settings.local.json` è in `.gitignore` e quello sul Mac è di agosto. Salvalo fuori dal repo e scrivi quello nuovo:

```
cd "$R"
[ -f .claude/settings.local.json ] && cp .claude/settings.local.json ~/settings.local.json.mac-2026-08-04.bak
cat > .claude/settings.local.json <<'EOF'
{
  "permissions": {
    "allow": [
      "Bash(rustup target:*)",
      "Bash(wasm-pack --version)",
      "Bash(cargo install:*)",
      "Bash(npm install:*)",
      "Bash(npm --version)",
      "Bash(npm run:*)",
      "Bash(npm test *)",
      "Bash(cargo test *)",
      "Read(//Users/edoardocicognani/.claude/**)"
    ]
  },
  "enabledMcpjsonServers": ["context7", "playwright", "chrome-devtools"],
  "enabledPlugins": { "lumen@claude-plugins-official": false }
}
EOF
```

Questo file approva i tre server di `.mcp.json` e, rispetto a Linux, cambia solo il percorso della regola `Read`. `lumen` è spento perché vuole Ollama su `localhost:11434` con il modello `ordis/jina-embeddings-v2-base-code`. Non c'era nemmeno su Linux, dove i suoi suggerimenti a ogni comando erano solo rumore. Se lo vuoi davvero: `brew install ollama`, `brew services start ollama`, `ollama pull ordis/jina-embeddings-v2-base-code`, e togli la riga `enabledPlugins`.

### 1.12 Il server MCP `chrome-devtools-gpu`

Su Linux esiste solo nello scope local di `~/.claude.json`, con i flag Vulkan, quindi sul Mac va creato. Aggiungilo dalla radice del repo, nel suo percorso definitivo, perché lo scope local dipende dal percorso:

```
cd "$R"
claude mcp list
claude mcp add -s local chrome-devtools-gpu -- npx -y chrome-devtools-mcp@latest --userDataDir=$HOME/.cache/chrome-devtools-mcp/chrome-profile-webgpu --chromeArg=--enable-webgpu-developer-features
claude mcp list
```

Se il primo `claude mcp list` mostra già un `chrome-devtools-gpu` di agosto, rimuovilo prima con `claude mcp remove -s local chrome-devtools-gpu`. Perché proprio così:
- **Il nome resta `chrome-devtools-gpu`**: lo usano la skill `/gpu-check` e il matcher dell'hook stale-wasm (`.claude/settings.json:25`).
- **Niente `--enable-unsafe-webgpu`, `--enable-features=Vulkan` o `--use-angle=vulkan`.** Su macOS Chrome ha WebGPU su Metal di default. `unsafe-webgpu` toglierebbe la blocklist ed esporrebbe feature sperimentali, e allora non sarebbe più il Chrome di un utente.
- **`--enable-webgpu-developer-features`** toglie la quantizzazione di `timestamp-query`: senza, Chrome dà multipli di 65 536 ns su Metal. Gli zeri del 2026-08-04 venivano dai marker vuoti del profiler vecchio (M7 del 2026-09-29, spec `docs/plans/2026-09-29-gpu-profiler-timestamp-writes-design.md`).
- **Nessun altro flag.** chrome-devtools-mcp (verificato sulla 1.10.1) avvia Chrome tramite puppeteer, i cui argomenti di default includono già `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`, `--disable-background-timer-throttling` e `--force-color-profile=srgb`.
- **La `userDataDir` deve essere diversa da quella del server stock** (`~/.cache/chrome-devtools-mcp/chrome-profile`), altrimenti il secondo avvio fallisce con "The browser is already running". Essendo persistente, conserva anche la cache degli shader tra una sessione e l'altra.

I server MCP si collegano all'avvio di `claude`: se lo aggiungi dopo, riavvia `claude`.

### 1.13 Ripristino della memoria di Claude

La memoria viaggia via git: su Linux `sshd` è spento, quindi niente `scp` dal Mac, e AirDrop da Linux non esiste. Nella cartella di progetto sul Mac c'è la memoria vecchia di agosto (`MEMORY.md` + `phases-completed.md`, ferma alla fase 16). Mettila da parte e copia al suo posto quella nuova:

```
cd "$R"
pwd | sed 's|[^A-Za-z0-9]|-|g'
ls -la "$S/memory"
[ -d "$S/memory" ] && mv "$S/memory" "$S/memory.mac-2026-08-04.bak"
mkdir -p "$S/memory"
cp docs/handoff/claude-memory/*.md "$S/memory/"
ls "$S/memory"
```

La prima riga deve stampare esattamente il nome finale di `$S`, cioè `-Users-edoardocicognani-Desktop-Code-HyperionEngine`, oppure `-Users-edoardocicognani-Code-HyperionEngine` se hai spostato il clone. Claude Code ricava la cartella dal percorso assoluto sostituendo con `-` ogni carattere non alfanumerico. L'ultimo `ls` deve elencare 9 file: `MEMORY.md`, `cull-fix-decision-pending.md`, `feedback-autonomous-round.md`, `linux-webgpu-chrome-flags.md`, `mac-m2-gpu-tests.md`, `open-items-round-2026-09-27.md`, `project-moved-macos-to-linux.md`, `round-pending-decisions.md`, `transparent-sort-phase.md`. `phases-completed.md` resta nel backup, come storico delle fasi.

`.remember/`, cioè i riassunti del plugin remember, non viaggia: è in `.gitignore`, `now.md` su Linux era vuoto, e la fonte da cui ripartire è la memoria automatica.

### 1.14 Avvio

Prima dei test con timing: Mac collegato alla corrente e Modalità risparmio energetico spenta.

```
cd "$R"
claude
```

Avvialo dalla shell di login che hai usato finora, sul percorso esatto: stesse maiuscole, nessun link simbolico. Gli hook post-edit confrontano il percorso come stringa, e APFS non distingue le maiuscole: con un percorso scritto in modo diverso saltano ogni modifica senza dire nulla.

Primo prompt suggerito:

> Leggi `docs/handoff/2026-09-29-mac-m2-handoff.md` ed esegui la sezione 2. Poi porta avanti il piano della sezione 4 sul branch `test/mac-m2-gpu`, fermandoti sulle domande elencate nella sezione 5.

---

## 2. Primo turno della sessione sul Mac (per Claude)

### 2.1 Cosa leggere

1. Questo documento, per intero.
2. `CLAUDE.md`, che si carica da solo. La sua riga "Machine handoff" rimanda qui. Molti gotcha descrivono la macchina Fedora: la sezione 3 dice quali.
3. L'indice della memoria, già nel contesto.

### 2.2 Controllare che la memoria sia quella ripristinata

L'indice `MEMORY.md` deve elencare `mac-m2-gpu-tests` e `round-pending-decisions`. Se invece parla di `phases-completed.md` o si ferma ad agosto, il ripristino (1.13) non è stato fatto. In quel caso esegui tu i comandi di 1.13, che sono solo un `mv` e un `cp` nella cartella della memoria, e poi leggi i file direttamente con Read: l'indice si carica solo all'avvio.

Poi fai queste modifiche, solo sulla copia ripristinata (`$S/memory/`) e non su `docs/handoff/claude-memory/`, che si aggiorna alla fine:
- `MEMORY.md`, riga 1: aggiungi in testa `LINUX ONLY (Fedora RTX 4060 + iGPU AMD) — `.
- `linux-webgpu-chrome-flags.md`: come prima riga del corpo, `Non vale sul Mac M2: Metal, un solo adapter, nessun flag Vulkan, nessun initScript.`
- `MEMORY.md`, riga 4: `next = step 6 (L-c directional shadows)` diventa `next = step 6, IN PAUSA per i test sul Mac (vedi round-pending-decisions)`.
- `open-items-round-2026-09-27.md`, ultima riga ("How to apply"): aggiungi `— salvo che round-pending-decisions dica che il giro è in pausa`.

`cull-fix-decision-pending.md` dice "Mode A cannot be checked visually here" e propone l'initScript AMD: sono fatti della macchina Linux. La regola resta quella di `round-pending-decisions.md`: niente passo 6 e nessuna delle sue domande finché l'utente non dice che i test sul Mac sono finiti.

### 2.3 Controlli dell'ambiente

```
uname -m
node -p process.arch
rustc -vV
rustup show active-toolchain
brew --prefix
node -v
command -v jq wasm-pack wasm-opt naga gh
wasm-pack --version
naga --version
wasm-opt --version
npx --prefix ts vitest --version
claude --version
sw_vers
git status --short
git log --oneline -3
```

| Controllo | Atteso | Valore su Linux (2026-09-29) |
|---|---|---|
| `uname -m` / `node -p process.arch` | `arm64` / `arm64` | — |
| `rustc -vV` | `release: 1.97.1`, `host: aarch64-apple-darwin` | rustc 1.97.1, rustup 1.29.1 |
| `rustup show active-toolchain` | `1.97.1-aarch64-apple-darwin (overridden by …rust-toolchain.toml)` | — |
| `brew --prefix` | `/opt/homebrew` | — |
| node / npm | `v24.x` | v24.21.0 / 11.19.0 |
| wasm-pack / naga | 0.14.0 / 30.0.1 | 0.14.0 / 30.0.1 |
| wasm-opt | `version 12x` | 126 |
| vitest / vite / tsc | 4.0.18 / 6.4.1 / 5.9.3 (da `package-lock.json`) | uguali |
| claude | ≥ 2.1.284 | 2.1.284 |
| Chrome | ≥ 154 | 154.0.8037.57 |
| altri | — | jq 1.8.1, gh 2.97.0, Python 3.14.7 + Pillow 12.3.0, git 2.55.0, chrome-devtools-mcp 1.10.1 |

Se compare `x86_64`, `x64` o `/usr/local`, fermati e chiedi all'utente di rifare 1.1-1.3: sotto Rosetta i test nativi non dicono nulla su aarch64.

### 2.4 Server MCP e workflow

Esegui `claude mcp list` da Bash: `chrome-devtools-gpu`, `chrome-devtools`, `playwright` e `context7` devono risultare connessi, e i tool `mcp__chrome-devtools-gpu__*` devono essere disponibili. Se `chrome-devtools-gpu` manca, chiedi all'utente di fare 1.12 e di riavviare `claude`. Il server stock basta per i controlli pass/fail, ma non dà timing. Controlla anche che il tool Workflow elenchi `adversarial-review` (`.claude/workflows/adversarial-review.js`): serve prima di ogni merge.

### 2.5 Far scattare gli hook

Un hook si verifica facendolo scattare, perché il silenzio non prova nulla:

```
printf '%s' '{"tool_name":"Edit","tool_input":{"file_path":"'"$PWD"'/ts/wasm/x.js"}}' | CLAUDE_PROJECT_DIR="$PWD" bash .claude/hooks/guard-generated.sh; echo "exit=$?"
```

Deve stampare `BLOCKED` e `exit=2`. La guardia del protocollo, in forme sicure anche con gli strumenti BSD (verificata su Linux):

```
T=$(mktemp -d); mkdir -p $T/crates/hyperion-core/src $T/ts/src; cp crates/hyperion-core/src/ring_buffer.rs $T/crates/hyperion-core/src/; cp ts/src/ring-buffer.ts ts/src/backpressure.ts $T/ts/src/; sed -i.bak 's/MAX_COMMAND_TYPE = 57/MAX_COMMAND_TYPE = 58/' $T/ts/src/backpressure.ts; printf '{"tool_input":{"command":"git commit -m x"}}' | CLAUDE_PROJECT_DIR=$T bash .claude/hooks/guard-protocol-drift.sh; echo exit=$?
```

Anche qui ci si aspetta `BLOCKED` e `exit=2`. Se non esce nulla con `exit=0`, l'hook è morto: manca jq sul PATH, oppure `claude` è partito senza il PATH di `~/.zprofile`.

### 2.6 Build e prova del setup

```
npm --prefix ts ci
npm --prefix ts run build:wasm
npm --prefix ts run build:wasm:physics
scripts/preflight.sh
scripts/preflight.sh --full
cargo test -p hyperion-core --all-features 2>&1 | grep -oE 'ok. [0-9]+ passed' | awk '{s+=$2} END {print s}'
```

L'ordine conta. `build:wasm` va prima di `preflight.sh`, perché `tsc --noEmit` senza `ts/wasm` esce con 2 e TS2307 in `engine-worker.ts:41` e `worker-bridge.ts:384`. `build:wasm:physics` serve solo allo script di determinismo. Dopo il pull, `guard-stale-wasm` segnala tutti i `.rs` come più recenti della WASM, finché non la ricostruisci. Numeri di Linux da ritrovare:

| Passo | Atteso |
|---|---|
| Rust, test lib / totale con integrazione | nessuna feature 216/259 · `physics-2d` 294/383 · `dev-tools` 247/295 · `--all-features` **340/438** |
| Integrazione con `--all-features` (98) | verify_2d 7, verify_determinism 4, verify_findings 19, verify_hier 8, verify_physics 37, verify_reuse 10, verify_ring 8, verify_snapshot 5 |
| Clippy `--all-features --all-targets -D warnings` | pulito |
| `tsc --noEmit` | exit 0 |
| vitest | **1878 passed + 7 skipped, 109 file** |
| Protocollo | `Rust=57  TypeScript=57` |
| `--full`, gate WASM | `Gzipped: … PASS` (< 200 KB). Linux: 200294 B raw / 71067 B gzip. Fisica: 873310 B / 339781 B. Con un `wasm-opt` diverso dalla 126 qualche punto percentuale di scarto è normale |
| La somma cargo | `438` |

Cosa vuol dire uno scarto:
- **`npm ci` si ferma con `EBADENGINE`**: la Node sul PATH non è la 24.
- **`--full` scrive `ERROR: wasm/hyperion_core_bg.wasm not found. Run build:wasm first.` ed esce con 0**: il file c'è, manca `wasm-opt`. `build:wasm:opt` in `ts/package.json:10` nasconde l'errore 127, quindi il gate ha misurato un binario non ottimizzato. Il physics release invece fallisce in modo esplicito, con "command not found".
- **Un conteggio Rust diverso**: un test compilato fuori da un `#[cfg]`, oppure una configurazione della matrice sbagliata. Va indagato, e non dipende dalla piattaforma.
- **Un test Rust che fallisce solo sul Mac con una differenza nell'ultima cifra di un float**: i test nativi girano su aarch64, con la libm di Apple, e la fisica si assesta su valori un po' diversi da x86_64 e wasm32 (`CLAUDE.md:518`). Il test sta fissando un float che dipende dalla piattaforma. Si corregge il test, passando a un invariante o a una tolleranza, con la procedura della sezione 5. Non è una regressione del motore. Non aggiungere hash d'oro presi dal Mac: il confronto tra macchine resta wasm contro wasm.
- **vitest con un numero diverso di test o file**: `node_modules` non viene da `npm ci`, oppure la Node è sbagliata. I test che leggono sorgenti in `crates/` falliscono se vitest non parte dalla radice del repo.

### 2.7 Branch e cartella delle prove

```
git switch -c test/mac-m2-gpu
mkdir -p docs/plans/assets/2026-09-29-mac-m2
```

Crea subito `docs/plans/assets/2026-09-29-mac-m2/README.md` con l'intestazione della sezione 5.

### 2.8 Dev server

Avvialo in background (Bash con `run_in_background`):

```
npm --prefix ts run dev -- --strictPort --port 5173
```

Poi `curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:5173/'` deve dare `200`. Dopo un checkout, un pull o un merge che tocca un `.wgsl`, riavvialo: Vite può servire con un 304 una trasformazione vecchia di `?import&raw` (`CLAUDE.md:460`).

### 2.9 Prima navigazione

Con `chrome-devtools-gpu` → `navigate_page`, usa `type: "url"`, `url: "http://localhost:5173/?mode=B"`, `ignoreCache: true`, **senza initScript**. Poi `list_console_messages` (tipi log/info/warn/error). La riga dell'adapter deve essere `[Hyperion] WebGPU adapter: apple / <architettura>…, subgroups X-Y`; il formato è `vendor / architecture / device`, le stringhe esatte dell'M2 sono da verificare. Non deve contenere `SOFTWARE FALLBACK`. Primo `evaluate_script`:

```js
() => ({ dpr: devicePixelRatio, screen: [screen.width, screen.height], css: [innerWidth, innerHeight], canvas: (c => [c.width, c.height])(document.getElementById('canvas')), mode: window.__hyperion.mode })
```

Segna il risultato nel README delle prove, poi comincia la sezione 4 da M0.

---

## 3. Cosa cambia rispetto a Linux

### 3.1 Shell, strumenti, percorsi

- **zsh ovunque.** Sul Mac sono zsh sia il Terminale sia il tool Bash di Claude. `NOMATCH` è attivo di default, quindi un URL con `?` non quotato fa fallire il comando prima che parta: per esempio `curl http://localhost:5173/?mode=B`, o il `curl` di `?raw` suggerito in `CLAUDE.md:460`. Metti sempre gli URL tra apici. Le globs di `--include` vanno quotate (`CLAUDE.md:415`, di nuovo vero). Nei comandi da far incollare all'utente, niente `#` in linea.
- **grep.** Nel tool Bash di Claude `grep` è una funzione che chiama l'ugrep incluso in Claude Code, su entrambi i sistemi. Ha `--ignore-files`, quindi una ricerca ricorsiva salta le cartelle in `.gitignore`: `ts/wasm`, `ts/node_modules`, `target/`, `.remember/`. Per cercare nei binding generati usa `command grep -n X ts/wasm/hyperion_core.d.ts` oppure `cat`. Il `/usr/bin/grep` BSD gira solo negli hook e negli script, che sono già sicuri per bash 3.2/BSD. `grep -P` resta vietato negli script (`CLAUDE.md:414`, di nuovo letterale sul Mac).
- **sed e mktemp.** Nei comandi estemporanei usa `sed -i.bak` e non `sed -i`, e `mktemp -d` senza il `-p` di GNU.
- **`/tmp` è un link simbolico a `/private/tmp`**, e `$TMPDIR` punta sotto `/private/var`. Fino al fix 6.25 `compare.mjs`, lanciato da una copia o da un percorso con link simbolici, usciva con 0 senza stampare nulla: la guardia `import.meta.url === pathToFileURL(argv[1])` era falsa, perché Node risolve i link simbolici per `import.meta.url` ma lascia quelli di `argv[1]`, e il risultato era un PASS falso. Ora la guardia (`isEntryPoint()`) confronta i `realpathSync` di entrambi, con un test che passa da un link, quindi il percorso da cui lo lanci non conta più. Giudica comunque sull'ultima riga, che deve essere `PASS`. Le cartelle `--base`/`--run` possono stare dove vuoi.
- **`/tmp/claude-1000` è di Linux** (uid 1000). È scritto fisso in `.claude/workflows/adversarial-review.js:33` e `.claude/agents/wgsl-validator.md:12`. Sul Mac (uid 501) usa la scratchpad della sessione oppure `mktemp -d` (task 6.17, 6.18).
- **Test Rust nativi su `aarch64-apple-darwin`.** La fisica si assesta su valori diversi da x86_64 e da wasm32. I test verificano invarianti, quindi i conteggi non cambiano (vedi 2.6).
- **Link simbolici e maiuscole**: vedi 1.14.
- **`.remember/` non viaggia** (1.13). `.superpowers/` è vuota e non serve.

### 3.2 GPU e browser

- **Una GPU, Metal.** Niente NVIDIA/AMD, niente flag Vulkan, niente initScript low-power. Un full reload di Vite dopo una modifica TS non fa perdere nulla, basta rilanciare i tab. `CLAUDE.md:452`, `CLAUDE.md:487` e `/gpu-check` §3 descrivono la Fedora (task in 6).
- **Mode A si può verificare.** Chrome con `?mode=auto` sceglie Mode A: l'euristica sull'UA mette `webgpuInWorker` per Chromium (`capabilities.ts:33-36`). L'harness forza B di default (`demo/preferred-mode.ts`), quindi Mode A va chiesto con `?mode=A`. In Mode A:
  - il render worker ha una camera sua (`render-worker.ts:18,41,66`; `CLAUDE.md:626`), 20·aspect × 20 nell'origine con zoom 1, e i `fitView` dei tab non la muovono;
  - un mondo vuoto non viene disegnato e l'ultimo frame resta sullo schermo (il bridge scarta gli stati con `entityCount 0`, `render-worker.ts:72`; è il passo 10 del giro);
  - non ci sono bloom, outline, particelle, profiler, probe e texture sul main thread, né upload scatter;
  - i check sui pixel vanno in skip.

  Sono lacune note del motore, non bug di Metal.
- **Timestamp.** Senza flag Chrome quantizza a 65 536 ns su Metal; gli zeri di M7 venivano dai marker vuoti del profiler vecchio (spec `docs/plans/2026-09-29-gpu-profiler-timestamp-writes-design.md`). `chrome-devtools-gpu` passa `--enable-webgpu-developer-features`, che toglie la quantizzazione. Nessun check dell'harness dipende dai timing: ne dipendono solo il bench, il costo della lighting e il profiler.
- **Due server Chrome, due ruoli.** `chrome-devtools` (da `.mcp.json`, senza flag) è "il Chrome di un utente": serve per i verdetti pass/fail. `chrome-devtools-gpu` serve per i timing. rAF si ferma comunque con la finestra minimizzata, con lo schermo in stop o bloccato. Per le sessioni lunghe tieni la finestra visibile e lancia `caffeinate -dimsu` in background (`kill` alla fine).
- **Retina, dpr 2.** Leggilo a ogni sessione: su Linux era 1.25, poi 1.667. Vale `px screenshot = px CSS × dpr`, e `pixels.py` legge il dpr da `map.json`. Il backing store del canvas è `clientWidth × dpr` (`main.ts:82-85`), quindi a finestra piena ci sono circa 2,5 volte i pixel di Linux a dpr 1.25 e i timing a finestra piena non si confrontano. Per ogni misura fissa la dimensione con `window.__hyperion.resize(1920, 1080)`, come fa il bench.
- **`{ unit: 'px' }` vuol dire pixel del device.** Lo shader della linea riceve la dimensione piena del canvas. A dpr 2 una linea da 3 px è larga 1,5 px CSS e negli screenshot sembra più sottile che sulla Fedora. Il check di Primitives conta texel e passa comunque. Non "correggerlo": è una domanda per l'utente (sezione 5).
- **Colore.** Gli screenshot del Chrome avviato dall'MCP sono sRGB (default di puppeteer). Display-P3 conta solo per un Chrome aperto a mano e per Safari. Per i valori usa il probe dentro il motore, dove esiste (B e C).
- **Primo avvio e compilazione Metal.** Al primo caricamento Dawn compila in MSL tutte le pipeline: 12 forward, l'uber, gli occluder, cull, sort, lighting, JFA. Se il processo GPU si blocca per più di `PROBE_TIMEOUT_MS` = 3000 ms (`demo/probe-checks.ts:25`), un check sui pixel fallisce per timeout. Prima di fare diagnosi rilancia quel tab una volta: con la cache degli shader calda (la `userDataDir` è persistente) conta solo un fallimento che si ripete. Nei risultati annota se la cache era fredda o calda.
- **Alimentazione e refresh.** Prima di ogni timing:
  - il Mac va collegato alla corrente;
  - `pmset -g | grep -i lowpowermode` deve dare `0`;
  - la finestra va tenuta sul display integrato;
  - la frequenza del display va annotata (60 Hz su Air/MBP 13", 120 Hz con ProMotion), perché cambia il campo `fps` del bench e la durata della finestra da 120 frame.
- **Safari.** Non lo pilota chrome-devtools: si usa a mano o con `safaridriver`. Differenze:
  - niente subgroups, quindi la regione subgroup del cull viene tolta dal testo e si usa il percorso atomic;
  - forse niente `timestamp-query`;
  - **non applica la regola di `indirect-first-instance`** (`CLAUDE.md:500`): un verde in Safari non è una prova per quel percorso;
  - con `?mode=auto` l'euristica sceglie B;
  - un `?mode=A` forzato può finire in un canvas bianco. Il canvas è già trasferito e il fallback su B non riesce ad avere un contesto: vedi `hyperion.ts:163-206`, dove l'errore di `createRenderer` viene inghiottito.
- **I gotcha "rigore di Metal"** (`CLAUDE.md:475-477`) risultano già rispettati nel codice:
  - `textureSampleLevel` fuori dal fragment;
  - niente `RENDER_ATTACHMENT` sulle texture compresse;
  - near a -1 in entrambe le camere;
  - `depth24plus` diventa `depth32float` su Apple.

  Li controllano M1-M3.
- **Le baseline e i timing di Linux non si confrontano.** Sono stati presi su iGPU AMD, dpr 1.667, canvas 2833×1691. `compare.mjs` rifiuta un'inquadratura diversa (`framingDiff`, righe 70-84), e i texel f16 non coincidono al bit tra vendor diversi. Sul Mac serve una baseline sua (M4).
- **Il fallback software.** Il suggerimento stampato da `capabilities.ts:180-182` nomina solo i flag Linux. Sul Mac un fallback vuol dire GPU in blocklist, oppure SwiftShader forzato.
- **Il percorso cull a subgroup** potrebbe girare per la prima volta su una GPU che presenta sul canvas (M5).

### 3.3 Build e plugin

- **`wasm-opt` mancante** dà un errore sbagliato con exit 0 (vedi 2.6). Prima di `preflight.sh --full` o di `/check-size`, controlla `command -v wasm-opt`.
- **`tsc` ha bisogno di `ts/wasm`** (2.6). vitest invece no.
- **L'harness carica `ts/wasm`** (`build:wasm`, senza `physics-2d`). La fisica è coperta solo da `cargo test` su aarch64, come su Linux.
- **LSP.** `rust-analyzer-lsp` e `typescript-lsp` erano abilitati senza binario anche su Linux (1.6, 1.11).
- **`lumen`** è spento in `settings.local.json` (1.11).
- **Il plugin `github`** resta disabilitato; `gh auth status` dice se il token del Mac funziona.

---

## 4. Piano di test GPU sull'M2

Ordine: prima i bloccanti; la baseline M4 va presa **prima di qualsiasi modifica al motore**. Le prove vanno in `docs/plans/assets/2026-09-29-mac-m2/` (`filePath` di `evaluate_script`/`take_screenshot`), e ogni esito nel README di quella cartella. "gpu" = server `chrome-devtools-gpu`, "stock" = `chrome-devtools`.

| ID | Test | Priorità | Dove |
|---|---|---|---|
| M0 | Adapter, feature, limiti del device | **bloccante** | gpu · `?mode=B` |
| M1 | WGSL e pipeline su Metal | **bloccante** | gpu · `?mode=B` |
| M2 | Harness in Mode B, tutti i tab | **bloccante** | gpu · `?mode=B` |
| M3 | Harness in Mode C (scatter formato 0, sort sotto churn) | **bloccante** | gpu · `?mode=C` |
| M4 | Baseline di pixel dell'M2, due run stabili | **bloccante**, prima di ogni fix | gpu · `?mode=B&bench`, `?mode=C&bench` |
| M5 | Cull a subgroup a 32 lane: insiemi di indici, non conteggi | **bloccante** se M0 dice che è attivo | gpu · `?mode=B&bench` |
| M6 | Mode A: parte, verdetti, screenshot | **bloccante** | gpu · `?mode=A` |
| M6b | Mode A contro B alla stessa inquadratura, mondo vuoto | importante | `?mode=A&bench`, `?mode=B&bench` |
| M6c | Mode A: qualità delle luci e input del sort via messaggio | importante | `?mode=A`, `?mode=A&bench` |
| M7 | `timestamp-query` con e senza flag | importante (serve a M8 e M9) | gpu + stock |
| M8 | Bench 5b sull'M2 (la domanda del +1,137 ms) | importante | gpu · `?mode=B&bench` (+ worktree su :5174) |
| M9 | Costo della lighting (design 17 §13.2) | importante | gpu · `?mode=B&bench` |
| M10 | Crescita dei tier compressi (bug probabile) | importante | gpu · `evaluate_script` |
| M11 | Percorso ASTC | facoltativo | gpu · `evaluate_script` |
| M12 | Safari: WGSL + harness B, C, A | importante | Safari a mano o `safaridriver` |
| M13 | Rigore di Metal | nota | coperto da M1-M3 |

### M0 — Adapter, feature, limiti (bloccante)

- **Perché qui.** Su Metal nessuno ha mai registrato i fatti da cui dipende tutto il resto:
  - il range dei subgroup, che decide il percorso cull (`renderer.ts:252-257`);
  - se il device ha `indirect-first-instance`: senza, ogni bucket tranne i quad opachi del tier 0 diventa un draw nullo silenzioso;
  - quale compressione sceglie `detectCompressedFormat` (BC7 prima di ASTC, `capabilities.ts:85-86`);
  - i limiti del device.
- **Procedura.** Dopo la navigazione di 2.9, cerca in `list_console_messages`:
  - (a) la riga dell'adapter, e annota `subgroups X-Y`;
  - (b) che **non** ci sia `[Hyperion] The GPU device lacks 'indirect-first-instance'`;
  - (c) se c'è `[Hyperion] Cull: atomic path (the subgroup path needs subgroups of exactly 32 lanes)`;
  - (d) che non ci sia `[Hyperion] The initial render graph raised GPU errors`.

  Poi `evaluate_script` con `filePath: docs/plans/assets/2026-09-29-mac-m2/adapter-chrome.json`:

  ```js
  async () => {
    const a = await navigator.gpu.requestAdapter();
    const lim = {};
    for (const k in a.limits) lim[k] = a.limits[k];
    const d = await a.requestDevice();
    const dlim = {};
    for (const k in d.limits) dlim[k] = d.limits[k];
    d.destroy();
    const { CullPass } = await import('/src/render/passes/cull-pass.ts');
    return {
      info: { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description, sgMin: a.info.subgroupMinSize, sgMax: a.info.subgroupMaxSize, fallback: a.info.isFallbackAdapter },
      features: [...a.features].sort(), adapterLimits: lim, defaultDeviceLimits: dlim,
      cull: CullPass.SUBGROUP_CONFIG, wgsl: [...navigator.gpu.wgslLanguageFeatures], ua: navigator.userAgent,
    };
  }
  ```
- **Atteso.**
  - Vendor `apple`, nessun fallback.
  - Tra le feature `indirect-first-instance`, `timestamp-query`, `subgroups` e `texture-compression-bc`, probabilmente anche `-astc`.
  - `sgMin`/`sgMax` = 32/32: probabile, da verificare. In quel caso `cull.useSubgroups` è `true` e M5 diventa un cancello vero.
  - I limiti del device uguali ai default di WebGPU: `renderer.ts:229-238` non chiede `requiredLimits`, quindi i budget verificati dai test restano validi (cull a 6 binding sotto 8, circa 11 KB di workgroup memory nel sort, 256 layer per tier).
- **Se fallisce.**
  - Fallback: Chrome ha WebGPU spento o la GPU in blocklist, e i flag Linux non c'entrano.
  - Manca `indirect-first-instance`: fermati e riferisci, perché ogni altro verdetto sarebbe falso.
  - Errori nel grafo iniziale: passa subito a M1.
  - Un limite del device sotto il default (possibile in Safari): è un bug del browser.

### M1 — WGSL e pipeline su Metal (bloccante)

- **Perché qui.** Sul Mac Tint emette MSL, non SPIR-V: un modulo valido su Linux può fallire la creazione della pipeline su Metal. I due casi più a rischio:
  - l'uber, con lo `switch` e `diagnostic(off, derivative_uniformity);` in testa (`render/primitive-shaders.ts`);
  - le pipeline occluder dei sei tipi.

  Nel renderer un fallimento del genere si vede solo come errore nel log, o come grafo rifiutato: bloom, outline e lit restano spenti senza dirlo.
- **Procedura.** Su `?mode=B`, `evaluate_script` con l'intera funzione di `docs/plans/assets/2026-09-27-transparent-sort-validate-wgsl.js`, poi con `…-validate-sort-wgsl.js`. Gli script usano un device fresco con `powerPreference: 'low-power'`, che sul Mac va bene così. Salva le due uscite in `wgsl-validation.json`. Poi lancia l'agente `wgsl-validator`: il suo check 7 riguarda `textureSample` fuori dal fragment.
- **Atteso.** Nessun messaggio di tipo `error` per i 7 moduli composti e per gather/sort. Tutti gli error scope `null`: per ogni tipo le pipeline opaque, transparent e occluder, più l'uber transparent e le 4 pipeline del sort.
- **Se fallisce.** È un problema del backend Metal e blocca tutto il resto. Per capire se l'errore è nel WGSL o nell'MSL: `D="$(mktemp -d)"; DUMP_WGSL_DIR="$D" npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts && node scripts/validate-wgsl-naga.mjs "$D"`. Se naga passa, il WGSL è valido e il problema sta nella traduzione in MSL: riporta il messaggio.

### M2 — Harness in Mode B (bloccante)

- **Perché qui.** Mode B non ha mai girato sull'M2 da quando c'è la pipeline cull valida (`6331b5c`), e dopo sono arrivati la scena HDR, la lighting e il sort 5b.
- **Procedura.**
  1. `?mode=B` con `ignoreCache`, senza initScript.
  2. Il tab runner di `.claude/skills/gpu-check/SKILL.md` §4, con `ONLY = []`.
  3. Per Lighting, Rendering FX, Lifecycle e 2D Twins i 3,5 s del runner non bastano: rilanciali con `ONLY` sul loro nome, aspettando circa 7 s.
  4. `list_console_messages` con error e warn.
  5. `take_screenshot` di Primitives.
- **Atteso.** È il riferimento AMD (`docs/plans/assets/2026-09-27-transparent-sort-baseline/statuses-B.json` + SKILL.md §4):

  | Tab | Atteso |
  |---|---|
  | Primitives | 5/6 · 1 skip (MSDF) |
  | Scene Graph | 5/5 |
  | Input | 2/6: i 4 ⏳ aspettano input reale, non sono una regressione |
  | Audio | 4/4 |
  | Particles | 4/4 |
  | Rendering FX | 3/4 · 1 skip (Tonemap) |
  | Lighting | 6/6 |
  | Debug Tools | 6/7 · 1 skip |
  | Lifecycle | 6/6 |
  | 2D Twins | 5/6 · 1 skip: 'Transparent sort under churn' salta in B |

  In console è accettabile solo il 404 di `favicon.ico`: controllalo con `list_network_requests`. Nello screenshot di Primitives devono esserci tutte le linee e tutte le bezier: su AMD, con il percorso subgroup rotto, si vedeva una linea sola e nessuna bezier. I valori dei pixel cambiano da GPU a GPU, i verdetti no.
- **Se fallisce.** Prima rilancia il tab una volta (compilazione a freddo, 3.2). Un `fail` che si ripete è una regressione su Metal, da sistemare prima di qualsiasi lavoro sulle feature. Qualsiasi messaggio che parli di WebGPU, validazione, pipeline o device è un fallimento.

### M3 — Harness in Mode C (bloccante)

- **Perché qui.** Solo Mode C ha l'upload scatter, formato 0 compreso. Il parent 2D ruotato e in movimento viene ricostruito sulla GPU a ogni frame con `cos/sin(angle)` (`scatter.wgsl`) e confrontato con le righe della CPU con tolleranza relativa 1e-5 (`demo/twin-2d.ts:585`). WGSL garantisce `sin`/`cos` in f32 solo a 2^-11 in assoluto: su Metal (MSL, forse con fast-math) il check può fallire per la sola precisione.
- **Procedura.** `?mode=C`, il runner su tutti i tab (almeno 2D Twins, con ~7 s di attesa).
- **Atteso.** 2D Twins 6/6:
  - 'GPU rows of 2D entities' passa, con 'N via scatter' > 0;
  - 'Transparent sort under churn' gira (non in skip) e passa;
  - 'Transparent sort matches the oracle' passa, qui come in B;
  - 'Twins draw the same pixels' e le due 'Depth orders…' passano.
- **Se fallisce.**
  - 'GPU rows' fallisce con uno scarto massimo intorno a 1e-4..5e-4, oppure il mismatch dei twin riguarda solo il parent ruotato in movimento o il suo figlio: è la precisione della trigonometria sulla GPU, non lo scatter. Annota la stringa di dettaglio. Tra alzare la tolleranza e far viaggiare cos/sin precalcolati nello staging decide l'utente (sezione 5).
  - Qualsiasi altro fallimento è un bug vero di Metal nello scatter o nel sort.

### M4 — Baseline di pixel dell'M2 (bloccante, prima di ogni modifica al motore)

- **Perché qui.** La baseline committata di Linux (AMD, dpr 1.6667, canvas 2833×1691) non può fare da cancello sul Mac (3.2). Senza una baseline dell'M2 non c'è modo di vedere una regressione di pixel prodotta dai fix che seguiranno.
- **Procedura.** È `capture.js` (`docs/plans/assets/2026-09-27-transparent-sort-baseline/capture.js`), che rifiuta le pagine senza `?bench`, vuole i tab nell'ordine fisso e un caricamento di pagina per run.
  1. `navigate_page` su `http://localhost:5173/?mode=B&bench` con `ignoreCache`. Da qui la finestra non cambia più dimensione e non passa su un altro display, perché il dpr cambierebbe.
  2. Per ogni chiave in `primitives, scene-graph, input, audio, particles, rendering-fx, lighting, debug-tools, lifecycle, twin-2d`:
     - `evaluate_script` con `() => { window.__captureOpts = { tab: '<chiave>' }; }`;
     - `evaluate_script` con il corpo di `capture.js` e `filePath: docs/plans/assets/2026-09-29-mac-m2/baseline/run1/B-<chiave>.json`.
  3. `window.__captureOpts = { statuses: true }` e ancora `capture.js` → `run1/statuses-B.json`.
  4. Una navigazione nuova su `?mode=C&bench`, poi gli stessi passi → `run1/C-*.json`, `run1/statuses-C.json`.
  5. Tutto di nuovo in `run2/`, con caricamenti di pagina nuovi.
- **Cancello di stabilità.**

  ```
  node docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs --base docs/plans/assets/2026-09-29-mac-m2/baseline/run1 --run docs/plans/assets/2026-09-29-mac-m2/baseline/run2 --mode B --step 0
  ```

  Stesso comando con `--mode C`. Ciascuno deve finire con `PASS`, come `stability-B.txt` su AMD. Salva le due uscite in `baseline/stability-B.txt` e `baseline/stability-C.txt`, e nel README scrivi la riga dell'adapter, le versioni di macOS e Chrome, la dimensione CSS della finestra, il dpr e HEAD. Si committano `run1/` e i due `.txt`, non `run2/` (un set completo pesa circa 1,5 MB).
- **Confronto dei verdetti con AMD** (facoltativo, B e C):

  ```
  node --input-type=module -e "import {compareStatuses,parseJsonOutput} from './docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs'; import {readFileSync} from 'node:fs'; const l=p=>parseJsonOutput(readFileSync(p,'utf8')); const r=compareStatuses(l('docs/plans/assets/2026-09-27-transparent-sort-baseline/statuses-B.json'), l('docs/plans/assets/2026-09-29-mac-m2/baseline/run1/statuses-B.json'), ['Transparent sort under churn']); console.log(r.ok?'OK':r.problems.join('\n'))"
  ```

  Il file AMD è precedente ai check 5b. Un check nuovo che passa va bene; uno nuovo in skip è ammesso solo se è nell'elenco (in B: il churn).
- **Se fallisce.** Se run1 contro run2 non dà PASS, c'è qualcosa di non deterministico sull'M2 (animazioni, compilazione a freddo, finestra spostata). Va capito prima di usare la baseline come cancello. Non confrontare mai i pixel AMD con quelli dell'M2.

### M5 — Cull a subgroup a 32 lane (bloccante se è attivo)

- **Perché qui.** Il percorso subgroup gira solo se l'adapter dichiara `subgroupMinSize === subgroupMaxSize === 32` (`capabilities.ts:248-250`). Presuppone lane contigue (`sg_id = lid / SUBGROUP_SIZE`, `cull.wgsl:132-134`). Nessun hardware che passa quel cancello l'ha mai disegnato sul canvas: la NVIDIA (32-32) non presenta, l'AMD è 32-64. Il guasto noto lascia giusti i conteggi per bucket e sparpaglia gli indici (duplicati più buchi), quindi confrontare i conteggi non prova nulla. Il renderer vivo non si può rileggere: `visible-indices` è solo STORAGE e `indirect-args` non ha COPY_SRC.
- **Procedura.** Scrivi `docs/plans/assets/2026-09-29-mac-m2/cull-subgroup-check.js` e lancialo con `evaluate_script` su `?mode=B&bench`.
  1. Device fresco: `a = await navigator.gpu.requestAdapter(); d = await a.requestDevice({ requiredFeatures: ['subgroups'] })`.
  2. Sonda della mappatura delle lane:

     ```wgsl
     enable subgroups;
     @group(0) @binding(0) var<storage, read_write> o: array<u32>;
     @compute @workgroup_size(256) fn m(@builtin(local_invocation_index) l: u32, @builtin(subgroup_size) s: u32) {
       o[l] = select(0xFFFFFFFFu, subgroupMin(l) * 1000u + subgroupMax(l), s == 32u);
     }
     ```

     Ogni `o[l]` deve valere `(l & ~31) * 1000 + (l | 31)`: prova che le lane sono 32 e contigue.
  3. Due pipeline cull costruite su `src = (await import('/src/shaders/cull.wgsl?raw')).default` con `prepareShaderSource` di `/src/render/passes/cull-pass.ts`, entry `cull_main`, sul layout a 6 binding di `cull-pass.ts:167-176`:
     - `prepareShaderSource(src, true)` con le costanti `{ USE_SUBGROUPS: 1, SUBGROUP_SIZE: 32, USE_SUBGROUP_ID: 0 }`;
     - `prepareShaderSource(src, false)` con `USE_SUBGROUPS: 0`.

     **Non assegnare mai** `CullPass.SHADER_SOURCE`/`SUBGROUP_CONFIG`: sono statici del renderer vivo. Usa buffer tuoi, con `COPY_SRC`.
     - Uniform da 112 B: `f32[0..23]` sono i piani (±1,0,0,10), (0,±1,0,10), (0,0,±1,1000); `u32[24]` = N; `u32[25]` = M = N.
     - Bounds: centri casuali in [-20,20]² con r 0,5, più un caso visibile al 100%.
     - `renderMeta[2i+1]`: tipo 0..7 (il 7 esercita il clamp di `cull.wgsl:93`), con il bit 8 casuale.
     - `texIndices`: tier 0/1 casuale, più il bit 31 casuale.
     - I draw args si azzerano come in `cull-pass.ts:224-231`.
     - Dispatch `ceil(N/256)` per N in {1000, 99937, 100000}, con 10 seed.
  4. Criteri, per ogni bucket `b` e per **entrambe** le pipeline: `args[5b+1]` uguale al conteggio della CPU, e `sorted(visible[b*M .. b*M+count])` uguale alla lista della CPU ordinata, senza duplicati. Lo slot sulla CPU è `(transp ? 14 : 0) + min(type, 6) * 2 + (tier > 0 || ovf)`.
- **Atteso.** Mappatura contigua e insiemi uguali in entrambe le pipeline.
- **Se fallisce.**
  - Conteggi giusti e insiemi diversi: il cancello deve restare chiuso su Apple (fix test-first sul branch), oppure bisogna collegare `USE_SUBGROUP_ID`. La scelta è dell'utente.
  - Tutto giusto ma l'adapter dichiara un range diverso da 32-32: il cancello è troppo prudente per Apple. È una domanda da fare, non un fix.
  - Se il percorso è attivo nel renderer, Primitives in M2 deve mostrare tutte le linee e le bezier.

### M6 — Mode A (bloccante)

- **Perché qui.** Mode A è quello che Chrome sceglie davvero per gli utenti Mac (`?mode=auto`) e non è mai stato verificato su una GPU. Un fallimento di Mode A è silenzioso: `transferControlToOffscreen` non si può annullare (`worker-bridge.ts:223`), il fallback su B chiama `createRenderer` su un canvas già trasferito e l'errore viene inghiottito (`hyperion.ts:200-206`). Il risultato è un canvas bianco che dichiara Mode B.
- **Procedura.**
  1. `?mode=A` con `ignoreCache`, poi `evaluate_script` `() => window.__hyperion.mode`: deve dare `'A'`. Se dà `'B'`, cerca in console `[Hyperion] Mode A failed, trying next fallback` oppure `Render Worker error`.
  2. Il runner su tutti i tab.
  3. `take_screenshot` di Primitives e di Lighting, per vedere che disegna.
  4. La riga dell'adapter e gli errori di validazione arrivano dal render worker. Se `list_console_messages` non mostra i messaggi dei worker (da verificare), chiedi all'utente di scegliere il contesto del render worker nel menu della Console di DevTools.
  5. Una volta sola, `?mode=auto`: deve scegliere A.
- **Atteso.** Nessun `fail`. Gli skip previsti:
  - i check sui pixel: "pixel probe unavailable";
  - le texture: "no main-thread renderer";
  - Particles: 4 skip;
  - Bloom e Outline: skip.

  La regola: ogni check che passa in B passa oppure va in skip in A.
- **Se fallisce.** Un `fail` o un canvas bianco con `mode` = `'A'` è un bug di Mode A, da trattare test-first. Scene inquadrate in modo diverso da B e un'immagine che resta dopo la distruzione di tutto sono le lacune note di 3.2, non fallimenti.

### M6b — Mode A contro B alla stessa inquadratura (importante)

- **Procedura.** Nell'origine, con zoom 1, le due camere coincidono (`hyperion.ts:571-574` contro `render-worker.ts:41`).
  1. Su `?mode=A&bench`:

     ```js
     () => {
       const e = window.__hyperion;
       e.cam.position(0, 0, 0);
       e.cam.zoom(1);
       window.__ab = [[-4, 0], [0, 1], [4, 2]].map(([x, c]) => {
         const h = e.spawn({ mode: '2d' }).position(x, 0).scale(2, 2);
         if (c === 1) h.gradient(0, 0, [0, 1, 0, 0, 1, 1]);
         if (c === 2) h.transparent();
         return h;
       });
     }
     ```

  2. `map.json` come in SKILL.md §6, ma in Mode A con la camera **del worker**: con `a = rect.width / rect.height`, usa `vp = [1/(10*a),0,0,0, 0,0.1,0,0, 0,0,-1/1001,0, 0,0,1/1001,1]` al posto di `cam.viewProjection`. È verificata sul codice di `camera.ts`: la view è l'identità, perché il worker non chiama mai `setPosition`.
  3. `take_screenshot`, poi `python3 .claude/skills/gpu-check/scripts/pixels.py shot.png map.json -4,0 0,0 4,0 -4,1.2`.
  4. Lo stesso su `?mode=B&bench`, con `cam.viewProjection`.
  5. Mondo vuoto: `() => window.__ab.forEach((h) => h.destroy())`, 30 frame, screenshot, in A e in B.
- **Atteso.** Valori A = B entro 1/255. Dopo la distruzione, in B il canvas torna al colore di clear. In A i quad restano: è la lacuna nota del passo 10, non una regressione.

### M6c — Mode A: stato che viaggia per messaggio (importante)

- **Perché qui.** Due percorsi di trasporto non sono mai stati provati su una GPU. La qualità della lighting passa per `hyperion.ts:849-853` → `worker-bridge.ts:373-375` → `render-worker.ts:54-57`, compreso il valore in sospeso che arriva prima che il renderer esista. Gli input del sort 5b, `transparentCount`/`entityIdsGeneration`, viaggiano nello stato inoltrato (design 5b §10, "Mode A non verificabile qui").
- **Procedura.**
  - Qualità: su `?mode=A`, tab Lighting. `window.__hyperion.lighting.setQuality({ shadowSteps: 4 })` e screenshot, poi `setQuality({ shadowSteps: 48 })` e screenshot. Per il percorso "in sospeso": ricarica la pagina e chiama `setQuality` nel primo `evaluate_script`.
  - Sort: su `?mode=A&bench`, tre gradient `.transparent()` sovrapposti nell'origine, con colori diversi e `.depth(0.2)`, `.depth(0.5)`, `.depth(0.8)`. Controlla con `pixels.py` che davanti ci sia la depth minore, poi scambia le depth a runtime e ricontrolla.
- **Atteso.**
  - Con 4 step la luce trapela dietro i muri, con 48 no: le ombre cambiano in modo visibile.
  - L'ordine segue la depth anche dopo lo scambio.
  - Nella console del worker non c'è `[Hyperion] The render state lacks transparentCount …`.
- **Se fallisce.** Un campo perso in un sito di trasporto è un bug del bridge: test-first.

### M7 — `timestamp-query` (importante, prerequisito di M8 e M9)

- **Perché qui.** Su Metal il profiler vecchio leggeva solo zeri. I marker del profiler vecchio erano compute pass **vuoti** con i soli `timestampWrites` (`d3c520f:ts/src/render/gpu-profiler.ts:203-207`), e le GPU Apple campionano i contatori solo ai confini degli stage: potrebbero dare 0 anche con il flag. (Storico: dal 2026-09-29 il profiler mette i `timestampWrites` sui pass veri.)
- **Procedura.** Con `chrome-devtools-gpu`, prima di qualsiasi probe della swapchain (il primo probe riconfigura il canvas):
  1. `?mode=B`, tab Lighting.
  2. `window.__hyperion.enableGpuProfiling()`, circa 4 s di attesa (almeno 130 frame), poi `window.__hyperion.getGpuTimings()`.
  3. Lo stesso una volta con il server stock `chrome-devtools`.
- **Atteso.**
  - Con il flag: voci (`cull`, `forward`, `light-groups/seed|sdf|accum`, `fxaa-tonemap`) con `averageMs > 0`, `sampleCount` che sale fino a 120, e `getGpuFrameTiming()` non nullo.
  - Con il server stock: le stesse voci, con valori multipli di 65 536 ns (0 o 0,0655 ms sui pass brevi) e medie stabili, e nessun avviso del profiler. Fino al profiler nuovo qui compariva l'avviso: gli zeri venivano dai marker vuoti (M7 del 2026-09-29, spec `docs/plans/2026-09-29-gpu-profiler-timestamp-writes-design.md`).
- **Se fallisce.** Voci vuote dopo 4 s: **fermati**, non lanciare il bench, e riferisci l'avviso del profiler, che dice il motivo (e, per `zero`/`reversed`/`stale`, il pass).

### M8 — Bench 5b sull'M2 (importante)

- **Perché qui.** È la domanda rimasta aperta dalla 5b. Su AMD, a 100k trasparenti con depth distinte, il totale del frame cresce di +1,137 ms dal passo 3 al 4, contro +0,251 ms con depth uguali. Il costo finisce nel bracket `fxaa-tonemap`, cioè nell'ordine di blend ordinato e sparso (design 5b §11). L'AMD è una GPU immediate-mode. Sull'M2, che è TBDR, il blend avviene in tile memory e quel costo dovrebbe quasi sparire. Le scritture sparse del sort in compute (upsweep 0,59 ms su AMD, misurato con i marker) potrebbero però costare in modo diverso sulla memoria unificata.
- **Prerequisiti.** M7 verde, alimentazione e refresh come in 3.2, `caffeinate`.
- **Procedura.**
  ⚠️ Durante le misure l'altra istanza di Chrome MCP resta su `about:blank`: con la scena lit aperta nell'altra, il sort a 10 000 (depth uguali) è passato da 0,53 a 1,32 ms (Task 8, `m7-profiler-diag-gpu-bench-other-blank.json`).
  ⚠️ La soglia D3 "Sort < 1 ms a 100 000" usa `sort`, la somma dei 4 stage, cioè 22 intervalli di compute pass dipendenti. Il Task 8 ha visto sovrapporsi i render pass dipendenti, non ancora la catena del sort: prima di giudicare D3 confronta `passSum` con `total` e, se la somma supera di molto lo span, cattura una timeline dei 22 pass.
  1. HEAD: `http://localhost:5173/?mode=B&bench`, senza probe prima.
  2. `evaluate_script` con `() => { window.__benchOpts = { label: 'm2 HEAD <sha>' }; }`, poi il corpo di `docs/plans/assets/2026-09-27-transparent-sort-bench.js` con `filePath: docs/plans/assets/2026-09-29-mac-m2/bench-head.json`. Se la chiamata MCP va in timeout, dividi per `sizes` (`window.__benchOpts.sizes = [100000]`).
  3. Riferimento del passo 3: il label di `bench-step3.json` è `step3 6ff494f`. Subito dopo `git worktree add`, prima di `npm ci`, fai il `git cherry-pick` dei commit di codice del profiler (piano `docs/plans/2026-09-29-gpu-profiler-timestamp-writes-plan.md`, "Dopo il piano", punto 2), e lo stesso nel worktree del passo 4: senza, il bench si ferma con `engine.getGpuFrameTiming() is missing`.

     ```
     git worktree add ../hyperion-5b-step3 6ff494f
     npm --prefix ../hyperion-5b-step3/ts ci
     npm --prefix ../hyperion-5b-step3/ts run build:wasm
     npm --prefix ../hyperion-5b-step3/ts run dev -- --strictPort --port 5174
     ```

     Il dev server va in background. Poi lancia lo **stesso** `bench.js` di HEAD (formato `/2`) su `http://localhost:5174/?mode=B&bench` → `bench-step3.json`. Se serve, anche il passo 4, il cui label è `step4 608a113`. Alla fine: `git worktree remove ../hyperion-5b-step3`.
- **Atteso.** Sort < 1 ms a 100 000 (D3). Con l'AMD si confronta solo `total` (lo span) con il `total` dei JSON AMD `/1`: le voci per pass e gli stage del sort sono misurati in modo diverso (coppie sui pass veri qui, bracket di marker su AMD) e non si confrontano una a una (spec §11).
- **Come leggerlo.**
  - Se sull'M2 total(distinte) ≈ total(uguali) a HEAD, il +1 ms di AMD è un costo di località delle GPU immediate-mode.
  - Se anche l'M2 mostra circa +1 ms, il costo è intrinseco (per esempio l'indirezione dell'ordine dei trasparenti), e vale la pena ottimizzarlo su tutte le GPU.

  Scrivi una tabella M2 separata nel design 5b §11, con l'etichetta "Apple M2 / Metal, Chrome <ver>", senza toccare quella AMD. La decisione se la cosa conta resta dell'utente (`round-pending-decisions`).

### M9 — Costo della lighting (importante)

- **Perché qui.** Il costo della lighting esiste solo per l'iGPU AMD a 1920×1081 (design 17 §13.2): catena SDF 1,77 ms, backend lit ≈ 2,3 ms; con light layers, "2 set, 2 gruppi" = **3,66 ms** (seed 0,406, sdf 3,042, accum 0,213). Sull'M2 ognuno degli ~11 passi della catena SDF è un render pass completo, con uno store per tile.
- **Procedura.**
  ⚠️ Da decidere con l'utente prima di M9: sull'M2 anche i pass dipendenti si sovrappongono, e la somma seed + sdf + accum (38,1 ms) supera di molto lo span del frame (4,8 ms) (Task 8, `m7-profiler-gpu-B.json` e `m7-profiler-diag-pass-timeline-gpu-B.json`): il passo 4 non misura il costo della lighting. Il passo 4 resta com'è finché l'utente non sceglie la misura.
  1. `?mode=B&bench`, poi `() => window.__hyperion.resize(1920, 1080)`. Non ridimensionare la finestra: il listener di resize di `main.ts` annullerebbe la dimensione.
  2. `document.querySelectorAll('.tab')[6].click()` (Lighting), 7 s di attesa, `enableGpuProfiling()`.
  3. Interroga `getGpuTimings()` finché `light-groups/sdf` non ha `sampleCount >= 120`.
  4. Registra seed, sdf, accum e la loro somma, cioè il costo della lighting da confrontare con la riga "2 set, 2 gruppi" (3,66 ms su AMD, misurata con i marker); poi `forward`, lo span (`getGpuFrameTiming().averageMs`, solo come contesto del frame: §13.2 non ha un equivalente AMD) e `window.__hyperion.lighting.groups`: la demo ha 2 gruppi e 2 SDF set.
  5. Ripeti con `lighting.setQuality({ shadowSteps: 24 })` per ricontrollare il "+2% tra 48 e 24".
  6. Salva tutto in `lighting-cost.json`.
- **Atteso.** Numeri e basta. Vanno in una riga M2 separata nel §13.2, senza sovrascrivere quella AMD.

### M10 — Crescita dei tier compressi (importante, bug probabile)

- **Perché qui.** Quando un tier compresso cresce (16 → 32 layer), `texture-manager.ts:505-516` copia ogni mip con `width = height = Math.max(1, size >> mip)`. Per BC7/ASTC 4×4 gli ultimi due mip (2×2 e 1×1) non sono multipli del blocco: la copia dovrebbe dare un errore di validazione, l'encoder diventa invalido e la vecchia texture viene distrutta subito dopo, con tutti i layer caricati. Il bug non ha mai girato perché non esiste un asset KTX2 e, su un device BC, i PNG vanno nel tier di overflow rgba8. È un'analisi fatta leggendo il codice: da verificare.
- **Procedura.** `evaluate_script` su `?mode=B`:

  ```js
  async () => {
    const { TextureManager } = await import('/src/texture-manager.ts');
    const out = {};
    for (const [feat, fmt] of [['texture-compression-astc', 'astc-4x4-unorm'], ['texture-compression-bc', 'bc7-rgba-unorm'], [null, null]]) {
      const a = await navigator.gpu.requestAdapter();
      if (feat && !a.features.has(feat)) { out[fmt] = 'not advertised'; continue; }
      const d = await a.requestDevice({ requiredFeatures: feat ? [feat] : [] });
      const tm = new TextureManager(d, { compressedFormat: fmt });
      d.pushErrorScope('validation');
      tm.getTierView(0); tm.ensureTierCapacity(0, 1); tm.ensureTierCapacity(0, 17);
      const e = await d.popErrorScope();
      out[fmt ?? 'rgba8unorm'] = e ? e.message : 'ok';
      tm.destroy(); d.destroy();
    }
    return out;
  }
  ```
- **Atteso, se l'analisi regge.** `rgba8unorm` dà `ok`; `astc-4x4-unorm` e `bc7-rgba-unorm` danno un errore di allineamento al blocco nella copia.
- **Se è confermato.** Fix test-first sul branch: prima un vitest con un device finto che verifica le dimensioni copiate, poi la copia sulla dimensione fisica arrotondata al blocco (`Math.max(4, size >> mip)` per i formati 4×4). Tocca BC7 anche su Linux e Windows.

### M11 — Percorso ASTC (facoltativo)

Si fa solo se M0 mostra sia BC sia ASTC (`detectCompressedFormat` sceglie BC7) **e** un target solo-ASTC (iOS) conta. Le texture di prova si fanno con KTX-Software, il `.pkg` di `toktx` dalle release di KhronosGroup/KTX-Software:
- `toktx --t2 --encode astc --astc_blk_d 4x4 <scratch>/astc.ktx2 ts/public/textures/sort-test-128.png` per il percorso diretto;
- `toktx --t2 --encode uastc <scratch>/uastc.ktx2 ts/public/textures/sort-test-128.png` per il transcode.

Servile da `ts/public` solo per il tempo del test, senza committarle. Poi, su un device fresco con `texture-compression-astc`:
1. `new TextureManager(d, { compressedFormat: 'astc-4x4-unorm' })`;
2. `await tm.loadTexture('/textures/<file>.ktx2')` dentro un error scope di validazione.

Atteso: nessun errore, e colori entro l'errore di ASTC.

### M12 — Safari (importante)

- **Perché qui.** Safari compila il WGSL con il compilatore di WebKit, non con Tint. La 5b l'aveva accettato come non verificabile (design 5b §7.3.2 e §10). Il rischio principale è `diagnostic(off, derivative_uniformity);` globale nell'uber. Se WebKit lo rifiuta, disegna solo il grafo iniziale: bloom, outline e lit restano spenti, e con il draw uber si perde ogni frame che ha trasparenti. L'harness non ha mai girato in Safari.
- **Procedura, parte a (WGSL).**
  1. In Safari, `http://localhost:5173/?mode=B`, Web Inspector. Controlla `crossOriginIsolated === true` e `!!navigator.gpu`.
  2. In console: `(<incolla la funzione di docs/plans/assets/2026-09-27-transparent-sort-validate-wgsl.js>)().then(r => console.log(JSON.stringify(r)))`, poi lo stesso con `…-validate-sort-wgsl.js`.
  3. Cerca `The initial render graph raised GPU errors`.
  4. Lancia anche la funzione di M0 e salva il risultato come `adapter-safari.json`.
- **Procedura, parte b (harness).** Apri `?mode=B`, poi `?mode=C`, poi `?mode=A`, e incolla in console `(<tab runner di SKILL.md §4>)().then(r => console.log(JSON.stringify(r, null, 1)))`. In alternativa, con uno script che Claude può lanciare:
  1. `safaridriver -p 4444` in background.
  2. Uno script node con `fetch`: `POST /session` con `{capabilities:{alwaysMatch:{browserName:'safari'}}}`, `POST /session/:id/timeouts` con `{script:120000}`, `POST /session/:id/url`.
  3. `POST /session/:id/execute/async` con `const done = arguments[arguments.length - 1]; (<fn>)().then(r => done(JSON.stringify(r)), e => done('ERR ' + e))`.

  L'automazione è facoltativa e non ancora verificata.
- **Atteso.**
  - Nessun errore di compilazione e tutti gli scope `null`.
  - Gli stessi verdetti di Chrome in B e C, tranne Audio: l'AudioContext vuole un gesto vero e sotto automazione può restare in attesa.
  - `window.__hyperion.mode` uguale all'URL.
  - Il profiler in Safari: `enableGpuProfiling()` su `?mode=B`, poi `getGpuTimings()` e `getGpuFrameTiming()` dopo circa 4 s. Voci non vuote e nessun errore di validazione in console: verifica il meccanismo del profiler: override come proprietà proprie dell'encoder, e un descrittore derivato come `Proxy` su un oggetto vuoto che legge ogni membro dall'originale (probe 5, `m7-probe5-derive-proxy-gpu.json`). Se Safari rifiuta il `Proxy`, il ripiego della spec §8.2 (`{ ...desc, timestampWrites }`) vale solo per i descrittori letterali: su un descrittore di classe perde i getter del prototipo.
- **Se fallisce.**
  - `diagnostic` rifiutato: il piano B è nel design 5b §10, prima riga dei rischi (portare `fwidth(uv.y)`/`dpdx`/`dpdy` fuori dallo `switch` e riscrivere il `fwidth` della bezier con la regola della catena). È una modifica di design: chiedila.
  - `?mode=A` forzato con canvas bianco dopo `[Hyperion] Mode A failed, trying next fallback`: è il difetto di fallback descritto in 3.2, non un guasto della GPU. Annotalo e segnalalo come domanda.
  - Un verde in Safari non vale mai come prova per `indirect-first-instance`.
  - Qualsiasi altro `fail` tranne Audio è un bug di Safari o del motore.

### M13 — Rigore di Metal (nota)

Non c'è un test a parte: la verifica sono M1-M3 e M6 con la console pulita. Se compare un errore solo di Metal al momento del draw ("Invalid …", validazione durante il submit), dividi per tab e ricontrolla prima questi cinque punti:
- `textureSampleLevel` fuori dal fragment;
- niente `RENDER_ATTACHMENT` sulle texture compresse;
- near -1;
- `depth32float` al posto di `depth24plus` (le depth uguali restano senza ordine definito);
- le 9 location di `VertexOutput`, sotto il limite di 16.

---

## 5. Regole di lavoro sul Mac

- **Branch.** Tutto va su `test/mac-m2-gpu`, creato da master (2.7). Si può committare e pushare il branch. **Prima di mergiare su master chiedi all'utente.** L'autonomia di `feedback-autonomous-round.md` (commit/merge/push senza chiedere) copre solo i passi del giro degli open-items, non questo lavoro.
- **Prove.** Vanno sotto `docs/plans/assets/2026-09-29-mac-m2/`: `adapter-chrome.json`, `adapter-safari.json`, `wgsl-validation.json`, `baseline/run1/`, i `stability-*.txt`, `cull-subgroup-check.js` con la sua uscita, `bench-*.json`, `lighting-cost.json` e gli screenshot che contano. `run2/` non si committa.
- **Ordine.** La baseline M4 si prende al commit base del branch, prima di qualsiasi modifica al motore.
- **Bug del motore.** Si correggono test-first sullo stesso branch:
  1. un test che fallisce (vitest con device finto, o cargo);
  2. il fix;
  3. `scripts/preflight.sh`;
  4. la review: il workflow `adversarial-review` sul range del fix, più `webgpu-pass-reviewer` / `wgsl-validator` quando il fix tocca pass o shader;
  5. di nuovo `/gpu-check` sul tab interessato, confrontato con la baseline M4.
- **Domande da fare all'utente**, senza decidere da solo:
  - cambi di tolleranza, per esempio 1e-5 in `twin-2d.ts:585` contro cos/sin precalcolati;
  - la semantica di `{ unit: 'px' }` (pixel del device, come oggi, o pixel CSS);
  - il cancello del cull a subgroup su Apple;
  - la strada per i timestamp se restano a zero;
  - il piano B di `diagnostic` in Safari;
  - il difetto del fallback da Mode A;
  - qualsiasi cambio di API;
  - qualsiasi modifica ai criteri del piano del giro.
- **Adattamenti degli strumenti (sezione 6).** Ognuno va verificato sul Mac prima del commit, in commit separati sullo stesso branch.
- **Come riportare.** `docs/plans/assets/2026-09-29-mac-m2/README.md` ha un'intestazione con:
  - HEAD;
  - `sw_vers`;
  - le versioni di Chrome e Safari;
  - la riga dell'adapter e il range dei subgroup;
  - dpr e dimensione CSS della finestra;
  - la frequenza del display;
  - corrente o batteria, e lo stato di Low Power Mode.

  Sotto, una sezione per ogni ID di test con esito, file di prova e note (cache fredda o calda). Le righe con i timing portano l'etichetta "Apple M2 / Metal, Chrome <ver>". Alla fine aggiungi a questo documento una sezione `## 9. Esito sul Mac` con il riassunto e il link al README.
- **Chiusura.**
  1. Aggiorna la memoria sul Mac: `mac-m2-gpu-tests.md` con gli esiti, più "ora vanno chiese le decisioni di round-pending-decisions".
  2. Aggiorna `docs/handoff/claude-memory/` (sezione 7) e committa.
  3. Solo quando l'utente dice che i test sul Mac sono finiti, fai le domande di `round-pending-decisions.md`, tenendo conto degli esiti:
     - il passo 10 alla luce di M6;
     - il +1,137 ms alla luce di M8;
     - le decisioni dei passi 6, 7 e 8. Il passo 8b non ha decisioni aperte.

  Il passo 6 non comincia prima.
- **Lingua.** I documenti in italiano come `docs/plans/`; i messaggi di commit nello stile di quelli già presenti (per esempio `test(mac): …`, `fix(texture): …`).

---

## 6. Adattamenti degli strumenti da fare sul Mac

Da applicare **sul Mac, dopo averli verificati lì**. Qui non sono stati toccati. I numeri di riga si riferiscono al commit dell'handoff.

| # | File:riga | Modifica |
|---|---|---|
| 6.1 | `.claude/skills/gpu-check/SKILL.md:3` | Descrizione: "on the AMD adapter" → "on a hardware adapter (AMD iGPU on Fedora, Apple GPU on the Mac)". |
| 6.2 | `.claude/skills/gpu-check/SKILL.md:33-54` (§3) | Dividere per macchina. Mac: `chrome-devtools-gpu` per i timing, `chrome-devtools` per il comportamento stock; `navigate_page` su `http://localhost:5173/?mode=B` con `ignoreCache`, **senza** initScript; la riga dell'adapter deve essere Apple e non un fallback; un reload dopo una modifica TS è innocuo; si lanciano anche `?mode=C` e `?mode=A`. La parte Fedora (initScript, VK_ERROR_OUT_OF_DEVICE_MEMORY) resta sotto l'etichetta "Fedora". |
| 6.3 | `.claude/skills/gpu-check/SKILL.md:14` | Controllo di freschezza: `[ -f ts/wasm/hyperion_core_bg.wasm ] \|\| echo MISSING` prima del `find` (se il file non esiste, `find` non stampa nulla e sembra "fresco"). |
| 6.4 | `.claude/skills/gpu-check/SKILL.md` §4, §6 e Report (:84, :131-133) | Una sezione Mode A: skip previsti, `vp` della camera del worker per `map.json` (M6b), immagine che resta su mondo vuoto (passo 10). Nel report sul Mac: "Mode A: solo screenshot" invece di "did NOT cover Mode A". |
| 6.5 | `.claude/skills/gpu-check/scripts/pixels.py:11` | Esempio `"dpr": 1.25` → leggerlo sempre (2 sul Retina). Se Pillow è nel venv, la skill deve chiamare quel python. |
| 6.6 | `.claude/skills/close-phase/SKILL.md:92` | Percorso portabile: `~/.claude/projects/<cwd con ogni non alfanumerico → '-'>/memory/` (`pwd \| sed 's\|[^A-Za-z0-9]\|-\|g'`), con i due slug come esempi. **Obbligatorio** se il clone è stato spostato in `~/Code`. |
| 6.7 | `CLAUDE.md:452` | Dividere per macchina: il blocco Fedora così com'è; il blocco macOS: "Apple M2, Chrome stable: WebGPU hardware senza flag, una GPU, niente initScript, Mode A verificabile; leggere comunque la riga dell'adapter". |
| 6.8 | `CLAUDE.md:487` | "On the AMD RDNA 3 iGPU here" → "on the Fedora AMD iGPU"; aggiungere l'esito di M0/M5 (range dell'M2, percorso attivo o no, insiemi di indici). |
| 6.9 | `CLAUDE.md:450` | Aggiungere l'esito di M7 (con e senza `--enable-webgpu-developer-features`), e che `chrome-devtools-gpu` sul Mac passa quel flag. |
| 6.10 | `CLAUDE.md:456` | "(1.25 here)" → "(leggerlo a ogni sessione: 1.25 o 1.667 sulla Fedora, 2 sul Retina del Mac)". |
| 6.11 | `CLAUDE.md:414-415` | Il `grep` del tool Bash è l'ugrep di Claude Code con `--ignore-files`; hook e script usano il grep di sistema. zsh: quotare gli URL con `?`; `#` in linea non è un commento in una zsh interattiva. |
| 6.12 | `CLAUDE.md:109-122` (e `:118`) | Una riga "macOS setup": rustup (non `brew rust`), `wasm-pack` 0.14.0 e `naga-cli` 30.0.1 con `--locked`, `brew install binaryen` (non `cargo install wasm-opt`), `node@24`, jq, Pillow. |
| 6.13 | `CLAUDE.md:696` | Nella lista delle skill, "AMD adapter" → "a hardware adapter (AMD iGPU on Fedora, Apple GPU on the Mac; Modes B, C and, on the Mac, A)". |
| 6.14 | `CLAUDE.md:722` | "a token this machine does not provide" → "the Fedora box". Anche la frase "lists **all** installed plugins" è già vecchia: lo scope user abilita altri 9 plugin (planetscale, railway, exa, superdesign, mongodb-atlas, streaming-skills-plugin, unity, mattpocock-skills, math-olympiad). |
| 6.15 | `CLAUDE.md:475-477` | Dopo M1-M3: "Metal verificato a `<sha>`". |
| 6.16 | `CLAUDE.md:457`, `:478`, `:626` | Aggiornare le note su Mode A con gli esiti di M6/M6b/M6c. |
| 6.17 | `.claude/workflows/adversarial-review.js:33` | "scratch files only under /tmp/claude-1000/" → "…under the session scratchpad directory named in your system prompt (or `$(mktemp -d)`)". |
| 6.18 | `.claude/agents/wgsl-validator.md:12` | `DUMP_WGSL_DIR=/tmp/claude-1000/wgsl` → `D="$(mktemp -d)"; DUMP_WGSL_DIR="$D" npx --prefix ts vitest run --root ts src/render/dump-composed-wgsl.test.ts`, poi leggere `"$D"` (è la forma di `dump-composed-wgsl.test.ts:14`). Lasciare com'è il piano storico della 5b. |
| 6.19 | `.claude/skills/new-primitive/SKILL.md:33` | "(on this machine: the NVIDIA adapter and a lost device)" → "(a full reload: harness state is lost; on the Fedora box it also loses the low-power initScript and the device)". |
| 6.20 | `.claude/agents/claude-md-auditor.md:36-37` | `\s` → `[[:space:]]`. Innocuo e non bloccante: quei comandi girano con l'ugrep di Claude. |
| 6.21 | `scripts/determinism-cross-version.mjs:15-16` | La ricetta crea `$SB` ma non `$SB/old`, quindi `tar -x -C` fallisce su entrambi i sistemi: `SB=$(mktemp -d); mkdir -p $SB/old; git archive <ref> \| tar -x -C $SB/old`. Confronti solo wasm contro wasm. |
| 6.22 | `ts/package.json:10` (facoltativo) | `build:wasm:opt`: con `wasm-opt` assente fallire in modo esplicito, invece di stampare "not found. Run build:wasm first" con exit 0 (per esempio controllando prima `command -v wasm-opt`). |
| 6.23 | `ts/src/capabilities.ts:180-182` | Nel messaggio di fallback aggiungere il caso macOS (nessun flag; un fallback vuol dire GPU in blocklist o `--use-webgpu-adapter=swiftshader`). Test-first se un test fissa il testo. |
| 6.24 | `docs/plans/assets/2026-09-27-transparent-sort-bench.js:6`, `…-baseline/capture.js:5` | Intestazione "AMD low-power adapter" → "a hardware adapter (no initScript on the Mac)". Facoltativo: nel bench un controllo rapido che si fermi se dopo circa 300 frame non c'è nessun campione, senza cambiare la misura. |
| 6.25 | `docs/plans/assets/2026-09-27-transparent-sort-baseline/compare.mjs:244` (facoltativo) | La guardia del main confronta `realpathSync(process.argv[1])`, così un percorso con link simbolici non dà più il PASS silenzioso. |
| 6.26 | `docs/plans/2026-09-27-open-items-round-plan.md`, righe della tabella §3 | **Solo alla ripresa del giro, insieme all'utente:** passo 6 (riga 59), costo in una riga M2 separata del §13.2, misurato con `engine.resize(1920,1080)` e il flag; passo 8 (riga 61), "su una GPU hardware (AMD o M2), in Mode B, con il probe", più la crescita dei tier BC7 sul Mac; passo 9 (riga 63), `/gpu-check` per macchina, browser e modo (sul Mac anche A e Safari); passo 10 (riga 64), dividerlo in (a) la lacuna del mondo vuoto in Mode A, verificabile sul Mac, e (b) `powerPreference`, con i soli test unitari e il criterio GPU "solo Fedora", chiedendo se serve ancora. |
| 6.27 | `.claude/settings.json:25` (condizionale) | Se si aggiunge un altro server MCP per un browser (per esempio Canary), aggiungere `mcp__<nome>__navigate_page` al matcher, altrimenti `guard-stale-wasm` non scatta. |
| 6.28 | `.mcp.json` (idea, non ora) | Un `chrome-devtools-gpu` portabile nel progetto: la voce local con lo stesso nome ha la precedenza, quindi Linux terrebbe la sua. Richiede di scegliere la `userDataDir` (`--isolated` perde la cache degli shader) e un'approvazione in `enabledMcpjsonServers`. |

---

## 7. Tornare su Linux

Dal 2026-09-29 la macchina canonica è il Mac.

**Alla fine del lavoro sul Mac**, dalla radice del repo, con `S` come in 1.5:

```
rm docs/handoff/claude-memory/*.md
cp "$S/memory/"*.md docs/handoff/claude-memory/
git add docs/handoff/claude-memory
git commit -m 'docs(handoff): memoria di Claude dal Mac'
git push
```

Si committa sul branch, oppure su master se il merge è già stato approvato. `sshd` su Linux è spento, quindi git è l'unico mezzo per portare la memoria da una macchina all'altra.

**Su Linux:**

```
cd ~/Code/HyperionEngine
git fetch --prune origin
git switch master
git pull --ff-only
npm --prefix ts ci
npm --prefix ts run build:wasm
M=~/.claude/projects/-home-edoardocicognani-Code-HyperionEngine/memory
mv "$M" "$M.linux-2026-09-29.bak"
mkdir -p "$M"
cp docs/handoff/claude-memory/*.md "$M/"
scripts/preflight.sh
```

Se il branch del Mac non è ancora su master, al posto di `git switch master` va `git switch test/mac-m2-gpu`. La voce `chrome-devtools-gpu` di Linux, con i flag Vulkan, resta in `~/.claude.json`. Sulla Fedora le note "LINUX ONLY" tornano a essere la realtà: per i controlli visivi serve di nuovo l'initScript low-power (`linux-webgpu-chrome-flags.md`), e il vecchio `ts/wasm` va comunque ricostruito, come sopra.

---

## 8. Riferimenti

**Copia della memoria:** `docs/handoff/claude-memory/`, presa da Linux il 2026-09-29. Il repo è pubblico: l'utente ha scelto di metterla lì.

| File | Contenuto |
|---|---|
| `MEMORY.md` | L'indice, 8 voci. |
| `mac-m2-gpu-tests.md` | Il lavoro sul Mac: macchina canonica, branch, chiedere prima del merge, aggiornare la memoria alla fine. |
| `round-pending-decisions.md` | Il giro in pausa. Decisioni dei passi 6 (4 domande), 7, 8 (3 domande), 8b (nessuna), 10 (serve ancora?) e il +1,137 ms della 5b. Si chiedono solo dopo i test sul Mac. |
| `open-items-round-2026-09-27.md` | La storia del giro: ordine dei passi, decisioni D1-D5 dell'utente, avanzamento dei passi 1-5b con gli hash dei merge. |
| `feedback-autonomous-round.md` | Autonomia per i passi del giro (commit/merge/push per passo, chiedere le decisioni di design). **Non** copre i merge del lavoro sul Mac. |
| `transparent-sort-phase.md` | La fase 5b chiusa (`b2ccd0c`): struttura, misure, la domanda del +1,137 ms. |
| `cull-fix-decision-pending.md` | La storia della fase 17 del 2026-09-26: fix del cull, `indirect-first-instance`, lighting, review. Il suo "Mode A not checkable here" vale per Linux. |
| `linux-webgpu-chrome-flags.md` | Solo Linux: i flag Vulkan, la NVIDIA che non presenta, l'initScript low-power. |
| `project-moved-macos-to-linux.md` | Lo storico delle macchine. La vecchia memoria del Mac (`phases-completed.md`) sta nel backup di 1.13. |

**Audit.** Workflow `wf_4a942df9-1e6` del 2026-09-29, fatto su Linux con il repo in sola lettura: quattro lettori (tooling, istruzioni, piano GPU, setup) più un critico di completezza, che dove correggeva un lettore ha avuto l'ultima parola. L'uscita non è nel repo: questo documento ne è la sintesi.

**Piani e prove:**
- `docs/plans/2026-09-27-open-items-round-plan.md`: §2 le decisioni rimandate, §3 i criteri di uscita, la nota di pausa;
- `docs/plans/2026-09-27-transparent-sort-uber-design.md`: §11 le misure dei passi 0-4 (AMD), §10 i rischi (piano B di `diagnostic`, trasporto in Mode A), §7.3 la procedura GPU;
- `docs/plans/2026-08-04-phase17-lighting-2d-design.md`: §13.2, il costo della lighting su AMD;
- `docs/plans/2026-09-26-cull-temporal-firstinstance-brief.md`: il percorso cull a subgroup e `indirect-first-instance`;
- `docs/plans/assets/2026-09-27-transparent-sort-baseline/`: `capture.js`, `compare.mjs`, la baseline AMD, `statuses-{B,C}.json`, `stability-{B,C}.txt`;
- `docs/plans/assets/2026-09-27-transparent-sort-bench.js` e `…-bench-step{0,1,3,4}.json`, con i label `5c97619`, `c57a4c1`, `6ff494f`, `608a113`;
- `docs/plans/assets/2026-09-27-transparent-sort-validate-wgsl.js` e `…-validate-sort-wgsl.js`;
- `.claude/skills/gpu-check/SKILL.md` e `scripts/pixels.py`; `.claude/hooks/README.md`, che spiega come verificare un hook.
