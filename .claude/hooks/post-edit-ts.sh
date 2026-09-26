#!/usr/bin/env bash
# PostToolUse(Edit|Write) — run the colocated vitest file after a TypeScript edit.
#
# Tests in this repo live next to their source (foo.ts -> foo.test.ts), so the
# relevant test is always derivable from the edited path. Editing a *.test.ts
# runs that file directly.
#
# Contract: exit 2 feeds stderr back to Claude. Exit 0 silently when green.
# A failure right after editing a *.test.ts is reported as context, not as an
# error: in TDD that is the expected RED of a test written before the code, and
# a "blocking error" on every such edit was noise (a dozen times on 2026-09-26).
set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -n "$file" ] || exit 0
case "$file" in *.ts) ;; *) exit 0 ;; esac
case "$file" in *.d.ts) exit 0 ;; esac

root="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$root" ]; then
  root=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
fi
[ -n "$root" ] && [ -d "$root" ] || exit 0

# Only files inside ts/src/ have a colocated suite.
case "$file" in "$root"/ts/src/*) ;; *) exit 0 ;; esac

case "$file" in
  *.test.ts) test_file="$file" ;;
  *)         test_file="${file%.ts}.test.ts" ;;
esac
[ -f "$test_file" ] || exit 0

# vitest wants a path relative to the ts/ package root.
rel="${test_file#"$root"/ts/}"

cd "$root/ts" || exit 0

out=$(npx vitest run "$rel" --reporter=dot 2>&1)
status=$?

if [ $status -ne 0 ]; then
  case "$file" in
    *.test.ts)
      note=$(printf 'vitest RED for %s (expected if this test was just written to fail first):\n%s' \
        "$rel" "$(printf '%s\n' "$out" | tail -25)")
      jq -n --arg note "$note" \
        '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $note}}'
      exit 0
      ;;
  esac
  {
    echo "vitest failed for $rel:"
    printf '%s\n' "$out" | tail -40
  } >&2
  exit 2
fi

exit 0
