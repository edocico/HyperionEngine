#!/usr/bin/env bash
#
# Pipeline di validazione completa. Da lanciare dalla root del repo.
# Si ferma al primo errore.
#
#   scripts/preflight.sh          # test + lint + TypeScript  (~30 s)
#   scripts/preflight.sh --full   # + build WASM release e gate di dimensione
#
# Perché non basta `cargo test -p hyperion-core`:
#   - buona parte dei test è dietro feature flag (physics-2d, dev-tools,
#     physics-debug). L'invocazione di default compila ed esegue anche i file
#     in `tests/`, ma verify_physics.rs e verify_snapshot.rs riportano 0 test:
#     il loro contenuto è azzerato da #[cfg]. Serve la matrice completa.
#   - `cargo clippy` senza `--all-targets` linta solo il target lib, quindi
#     tutto il codice di test resta non lintato. Per questo il passo di lint
#     usa `--all-targets` — a `cargo test` non serve, i file in `tests/` li
#     compila comunque.
#   - Rust e TypeScript mantengono DUE tabelle di comandi separate, senza
#     codegen fra loro. Se divergono i comandi vengono inquadrati male e lo
#     stream si desincronizza da quel byte in poi, in silenzio. L'ultimo passo
#     confronta almeno `MAX_COMMAND_TYPE` fra i due lati.

set -euo pipefail

FULL=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "opzione sconosciuta: $arg (usa --full o --help)" >&2; exit 2 ;;
  esac
done

BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; OFF=$'\033[0m'
step=0

run() {
  step=$((step + 1))
  printf '\n%s[%02d] %s%s\n' "$BOLD" "$step" "$1" "$OFF"
  printf '%s     $ %s%s\n' "$DIM" "$2" "$OFF"
  # Subshell: senza, un `cd ts` resterebbe attivo per i passi successivi.
  if ( eval "$2" ); then
    printf '%s     OK%s\n' "$GREEN" "$OFF"
  else
    printf '%s     FALLITO — mi fermo qui%s\n' "$RED" "$OFF"
    exit 1
  fi
}

cd "$(dirname "$0")/.."
printf '%sPreflight — branch %s%s%s\n' \
  "$BOLD" "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')" \
  "$( [ "$FULL" = 1 ] && echo ' (--full)' )" "$OFF"

# ── Rust: matrice delle feature ────────────────────────────────
run "Rust — nessuna feature"        "cargo test -p hyperion-core"
run "Rust — physics-2d"             "cargo test -p hyperion-core --features physics-2d"
run "Rust — dev-tools"              "cargo test -p hyperion-core --features dev-tools"
run "Rust — tutte le feature"       "cargo test -p hyperion-core --all-features"

# ── Lint: zero warning, test inclusi ───────────────────────────
run "Clippy — zero warning" \
    "cargo clippy -p hyperion-core --all-features --all-targets -- -D warnings"

# ── TypeScript ─────────────────────────────────────────────────
run "TypeScript — type check"       "cd ts && npx tsc --noEmit"
run "TypeScript — vitest"           "cd ts && npm test"

# ── WASM (solo --full: sono ~1 minuto di build) ────────────────
if [ "$FULL" = 1 ]; then
  run "WASM — build standard (release)"  "cd ts && npm run build:wasm:release"
  run "WASM — gate dimensione <200KB"    "cd ts && npm run check:wasm-size"
  run "WASM — build fisica (release)"    "cd ts && npm run build:wasm:physics:release"
  run "WASM — dimensione build fisica" \
      "cd ts && node -e \"const z=require('zlib').gzipSync(require('fs').readFileSync('wasm-physics/hyperion_core_bg.wasm')).length;console.log('Physics gzipped:',z,'('+Math.round(z/1024)+'KB)')\""
fi

# ── Coerenza del protocollo Rust <-> TypeScript ────────────────
printf '\n%s[--] Coerenza protocollo Rust <-> TypeScript%s\n' "$BOLD" "$OFF"
# `[0-9]+$` e non `[0-9]+`: senza l'ancora il secondo grep pescherebbe anche
# l'8 di `u8`, e il confronto fallirebbe su valori in realtà identici.
RUST_MAX=$(grep -oE 'MAX_COMMAND_TYPE: u8 = [0-9]+' crates/hyperion-core/src/ring_buffer.rs | grep -oE '[0-9]+$')
TS_MAX=$(grep -oE 'MAX_COMMAND_TYPE = [0-9]+' ts/src/backpressure.ts | grep -oE '[0-9]+$')
printf '     Rust=%s  TypeScript=%s\n' "$RUST_MAX" "$TS_MAX"
if [ "$RUST_MAX" = "$TS_MAX" ]; then
  printf '%s     OK%s\n' "$GREEN" "$OFF"
else
  printf '%s     DISALLINEATI — aggiungendo un CommandType vanno aggiornati entrambi%s\n' "$RED" "$OFF"
  exit 1
fi

printf '\n%s%sTutti i controlli sono verdi.%s\n' "$BOLD" "$GREEN" "$OFF"
if [ "$FULL" = 0 ]; then
  printf '%s(build WASM e gate di dimensione saltati — rilancia con --full)%s\n' "$DIM" "$OFF"
fi
printf '%sWebGPU non è testabile headless: per il percorso di rendering serve\n' "$DIM"
printf 'comunque un giro a mano con `cd ts && npm run dev`.%s\n' "$OFF"
