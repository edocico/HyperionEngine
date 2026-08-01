#!/usr/bin/env bash
# PostToolUse(Edit|Write) — clippy the crate after a Rust edit, and warn when a
# change lands inside feature-gated code that the default build will not compile.
#
# Contract: exit 2 feeds stderr back to Claude (the tool already ran, so this
# surfaces findings rather than blocking). Exit 0 with no output when clean.
set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -n "$file" ] || exit 0
case "$file" in *.rs) ;; *) exit 0 ;; esac

root="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$root" ]; then
  root=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
fi
[ -n "$root" ] && [ -d "$root" ] || exit 0

# Ignore Rust files that are not part of this workspace (scratchpads, /tmp, deps).
case "$file" in "$root"/*) ;; *) exit 0 ;; esac

cd "$root" || exit 0

# Matches the project's documented lint command (CLAUDE.md "Full validation").
# Deliberately NOT --all-targets: that surfaces a long-standing dead-code warning
# in test-only helpers, which would make this hook fire on every single Rust edit.
out=$(cargo clippy -p hyperion-core --message-format=short 2>&1)
status=$?

findings=$(printf '%s\n' "$out" | grep -E '^[^ ].*: (warning|error)' | head -20)

# `cfg(feature = ...)` code compiles under one feature set and can break another.
# process_commands even changes ARITY between the default and physics-2d builds,
# so a green default clippy proves very little about the gated paths.
gated=""
if grep -q 'cfg(feature' "$file" 2>/dev/null; then
  gated="
Feature-gated code was touched in $(basename "$file"). The default build is only one
of five meaningful configurations — verify the others before considering this done:
  cargo test -p hyperion-core --features dev-tools
  cargo test -p hyperion-core --features physics-2d
  cargo test -p hyperion-core --features \"physics-debug dev-tools\"
  cargo test -p hyperion-core --all-features"
fi

if [ $status -ne 0 ] || [ -n "$findings" ]; then
  {
    echo "cargo clippy -p hyperion-core reported issues:"
    if [ -n "$findings" ]; then
      printf '%s\n' "$findings"
    else
      printf '%s\n' "$out" | tail -20
    fi
    [ -n "$gated" ] && printf '%s\n' "$gated"
  } >&2
  exit 2
fi

if [ -n "$gated" ]; then
  printf '%s\n' "$gated" >&2
  exit 2
fi

exit 0
