#!/usr/bin/env bash
# PreToolUse(chrome-devtools navigate_page) — say so when the WASM the harness
# loads is older than the Rust source.
#
# The harness imports ts/wasm/hyperion_core.js, built by `npm run build:wasm`
# (default features, no physics-2d). A GPU check after a Rust change, without
# that rebuild, silently exercises the old engine.
#
# Advisory, never blocking: it adds context to the navigation and exits 0.
# Staleness is by modification time, as cargo itself decides: a checkout or a
# merge that rewrites the sources flags it too, even with identical content —
# the cost of that false alarm is one ~10 s rebuild.
set -uo pipefail

input=$(cat)
root="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$root" ]; then
  root=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
fi
[ -n "$root" ] && [ -d "$root/crates/hyperion-core" ] || exit 0

wasm="$root/ts/wasm/hyperion_core_bg.wasm"
if [ ! -f "$wasm" ]; then
  note="ts/wasm/hyperion_core_bg.wasm does not exist: run \`npm --prefix ts run build:wasm\` before loading the harness."
else
  newer=$(find "$root/crates/hyperion-core/src" "$root/crates/hyperion-core/Cargo.toml" \
    -newer "$wasm" \( -name '*.rs' -o -name 'Cargo.toml' \) 2>/dev/null | head -3 | sed "s|$root/||")
  [ -n "$newer" ] || exit 0
  note="The harness WASM (ts/wasm) is older than the Rust source ($(printf '%s' "$newer" | tr '\n' ' ')). Run \`npm --prefix ts run build:wasm\` first, or this GPU check exercises the old engine. Physics is not in that build at all: verify it with the Rust tests."
fi

jq -n --arg note "$note" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $note}}'
exit 0
