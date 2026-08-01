#!/usr/bin/env bash
# PreToolUse(Bash) — refuse `git commit` while the Rust and TypeScript
# ring-buffer command tables disagree.
#
# WHY THIS EXISTS
# The command protocol is defined twice: once in crates/hyperion-core/src/ring_buffer.rs
# (compiled into the WASM binary) and once in ts/src/ring-buffer.ts (compiled into the
# producer). Nothing in either toolchain checks that they agree. When they drift, the
# failure is silent and data-dependent: the consumer hits an opcode it does not know,
# discards the remainder of the batch, and bumps engine_dropped_command_bytes(). Entities
# stop responding for reasons that look like a renderer bug.
#
# Bypass for a single commit:  touch .claude/.skip-drift-guard
#
# Contract: exit 2 blocks the Bash call and feeds stderr back to Claude.
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -n "$cmd" ] || exit 0

# Only guard commits. `git commit --amend`, `git commit -m ...` all match.
case "$cmd" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$root" ]; then
  root=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
fi
[ -n "$root" ] && [ -d "$root" ] || exit 0

# Explicit escape hatch for mid-refactor commits.
if [ -f "$root/.claude/.skip-drift-guard" ]; then
  rm -f "$root/.claude/.skip-drift-guard"
  echo "protocol-drift-guard: bypassed via .claude/.skip-drift-guard (flag consumed)"
  exit 0
fi

rust_file="$root/crates/hyperion-core/src/ring_buffer.rs"
ts_enum_file="$root/ts/src/ring-buffer.ts"
ts_max_file="$root/ts/src/backpressure.ts"

# If the layout ever changes, stay silent rather than blocking every commit.
[ -f "$rust_file" ] && [ -f "$ts_enum_file" ] && [ -f "$ts_max_file" ] || exit 0

# Pull `Name = N` pairs out of the CommandType enum body on either side.
# Both languages spell the variants identically: leading whitespace, name,
# " = ", integer, trailing comma.
extract_pairs() {
  sed -n '/enum CommandType {/,/^}/p' "$1" \
    | grep -oE '^[[:space:]]*[A-Za-z][A-Za-z0-9_]* = [0-9]+,' \
    | sed -E 's/^[[:space:]]*//; s/ = /=/; s/,$//' \
    | sort
}

rust_pairs=$(extract_pairs "$rust_file")
ts_pairs=$(extract_pairs "$ts_enum_file")

# A parse that finds nothing means the file shape changed. Do not block blindly.
if [ -z "$rust_pairs" ] || [ -z "$ts_pairs" ]; then
  exit 0
fi

rust_max=$(grep -oE 'MAX_COMMAND_TYPE: u8 = [0-9]+' "$rust_file" | grep -oE '[0-9]+$' | head -1)
ts_max=$(grep -oE 'MAX_COMMAND_TYPE = [0-9]+' "$ts_max_file" | grep -oE '[0-9]+$' | head -1)

# Highest discriminant actually declared in the Rust enum.
rust_top=$(printf '%s\n' "$rust_pairs" | sed -E 's/.*=//' | sort -n | tail -1)

problems=""

only_rust=$(comm -23 <(printf '%s\n' "$rust_pairs") <(printf '%s\n' "$ts_pairs"))
only_ts=$(comm -13 <(printf '%s\n' "$rust_pairs") <(printf '%s\n' "$ts_pairs"))

if [ -n "$only_rust" ]; then
  problems="${problems}
  In ring_buffer.rs but NOT in ts/src/ring-buffer.ts:
$(printf '%s\n' "$only_rust" | sed 's/^/    /')"
fi

if [ -n "$only_ts" ]; then
  problems="${problems}
  In ts/src/ring-buffer.ts but NOT in ring_buffer.rs:
$(printf '%s\n' "$only_ts" | sed 's/^/    /')"
fi

if [ -n "$rust_max" ] && [ -n "$ts_max" ] && [ "$rust_max" != "$ts_max" ]; then
  problems="${problems}
  MAX_COMMAND_TYPE disagrees:
    ring_buffer.rs   = $rust_max
    backpressure.ts  = $ts_max"
fi

if [ -n "$rust_max" ] && [ -n "$rust_top" ] && [ "$rust_max" -ne $((rust_top + 1)) ]; then
  problems="${problems}
  MAX_COMMAND_TYPE is not one past the last discriminant:
    highest variant  = $rust_top
    MAX_COMMAND_TYPE = $rust_max  (expected $((rust_top + 1)))"
fi

if [ -z "$problems" ]; then
  exit 0
fi

cat >&2 <<EOF
BLOCKED: ring-buffer protocol drift between Rust and TypeScript.
$problems

Commands the consumer does not recognise are discarded along with the REST of the
batch, and counted by engine_dropped_command_bytes(). This fails silently at runtime.

Fix both sides (see the /new-command checklist), or bypass this once with:
  touch .claude/.skip-drift-guard
EOF
exit 2
