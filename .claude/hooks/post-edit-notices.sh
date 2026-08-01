#!/usr/bin/env bash
# PostToolUse(Edit|Write) — surface cross-cutting invariants that no compiler checks.
#
# Each notice points at a specific, non-obvious coupling in this repo: a file whose
# correctness depends on another file that nothing links it to. These are cheap
# string checks and run instantly, so they live apart from the slow clippy/vitest
# hooks and all fire in parallel with them.
#
# Contract: exit 2 feeds stderr back to Claude. Exit 0 silently when nothing applies.
set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -n "$file" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$root" ]; then
  root=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
fi
[ -n "$root" ] && [ -d "$root" ] || exit 0
case "$file" in "$root"/*) ;; *) exit 0 ;; esac

base=$(basename "$file")
notices=""
add() { notices="${notices}
$1
"; }

case "$base" in
  *.wgsl)
    add "WGSL shader modified ($base).
  Every primitive shader must declare an IDENTICAL bind group layout, including
  bindings it never reads — group 0: camera, transforms, visibleIndices, texIndices,
  renderMeta, primParams; group 1: tier0-tier3 + sampler + ovf0-ovf3.
  ScatterPass @group(1) must also match what CullPass reads from the ResourcePool.
  Run the wgsl-validator agent before committing."
    ;;
esac

case "$base" in
  ring_buffer.rs|ring-buffer.ts|backpressure.ts|lib.rs|worker-bridge.ts|engine-worker.ts)
    add "Cross-language protocol file modified ($base).
  CommandType discriminants, payload sizes and WASM export signatures are declared
  independently in Rust and TypeScript; nothing but agreement makes them work.
  Run the protocol-sync-checker agent before committing.
  The commit itself is gated by .claude/hooks/guard-protocol-drift.sh."
    ;;
esac

case "$base" in
  physics.rs|physics_commands.rs)
    add "Physics file modified ($base).
  Body/collider/joint/character handles are tracked in four parallel maps that must
  all be cleaned up on despawn, and events are drained per-frame but accumulated
  per-tick. Run the physics-integration-checker agent before committing."
    ;;
esac

case "$base" in
  lib.rs|index.ts|components.rs|ring_buffer.rs)
    add "Structural file modified ($base).
  CLAUDE.md is loaded as authoritative context in every session and carries hard
  counts and tables describing this file (WASM exports, component list, CommandType
  count). Update it in the same change, or run the claude-md-auditor agent."
    ;;
esac

[ -n "$notices" ] || exit 0

printf '%s' "$notices" >&2
exit 2
