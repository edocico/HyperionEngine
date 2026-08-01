#!/usr/bin/env bash
# PreToolUse(Edit|Write) — refuse edits to build artifacts.
#
# wasm-pack rewrites these directories wholesale on every build, so an edit here
# is silently discarded the next time anyone runs `npm run build:wasm`.
#
# Contract: hook input arrives as JSON on stdin. Exit 2 blocks the tool call and
# feeds stderr back to Claude; exit 0 allows it.
set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -n "$file" ] || exit 0

case "$file" in
  */ts/wasm/*|*/ts/wasm-physics/*|*/ts/loro-spike-wasm/*|*/ts/rapier-spike-wasm/*)
    cat >&2 <<EOF
BLOCKED: $file is generated output, not source.

wasm-pack overwrites this directory on every build, so this edit would be lost.
Edit the Rust source under crates/hyperion-core/src/ instead, then rebuild:

  cd ts && npm run build:wasm             # standard  -> ts/wasm/
  cd ts && npm run build:wasm:physics     # physics-2d -> ts/wasm-physics/
EOF
    exit 2
    ;;
esac

exit 0
