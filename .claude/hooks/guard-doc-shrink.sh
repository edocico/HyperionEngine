#!/usr/bin/env bash
# PostToolUse(Bash|Edit|Write) — warn when a Markdown file has lost far more
# lines than it gained.
#
# Why: on 2026-09-26 a Python rewrite of a design doc "from an anchor" wrote the
# new section and silently dropped everything after it — 142 lines of risks,
# open questions and sources (714a8cf, restored in 4be94c1). No tool reported
# anything; `git diff --numstat` showed "+18 -141" the whole time.
#
# What it checks: the working tree against HEAD, and — when the command was a
# `git commit` — the commit just made (an edit and a commit in one command
# leave a clean working tree). A doc is flagged when it lost at least
# DOC_SHRINK_MIN lines (default 40) and more than twice what it gained.
#
# Each distinct finding is reported once: the last report is remembered in the
# git dir, so the same shrink does not repeat on every command until committed.
#
# Contract: exit 2 feeds stderr back to Claude. Exit 0 silently otherwise.
set -uo pipefail

input=$(cat)
root="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$root" ]; then
  root=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
fi
[ -n "$root" ] && [ -d "$root" ] || exit 0
cd "$root" || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

min="${DOC_SHRINK_MIN:-40}"
shrunk() {
  awk -v min="$min" -v where="$1" '
    $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $2 >= min && $2 > 2 * $1 {
      printf "  %s: +%s -%s (%s)\n", $3, $1, $2, where
    }'
}

findings=$(git diff HEAD --numstat -- '*.md' 2>/dev/null | shrunk "uncommitted")

command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
case "$command" in
  *"git commit"*|*"git merge"*)
    committed=$(git show --numstat --format= HEAD -- '*.md' 2>/dev/null | shrunk "in $(git rev-parse --short HEAD 2>/dev/null)")
    findings=$(printf '%s\n%s' "$findings" "$committed" | grep -v '^$')
    ;;
esac

seen="$(git rev-parse --git-dir)/claude-doc-shrink-seen"
if [ -z "$findings" ]; then
  # Resolved (restored or committed on purpose): forget it, so the same
  # shrink happening again later is reported again.
  rm -f "$seen"
  exit 0
fi
if [ -f "$seen" ] && [ "$(cat "$seen")" = "$findings" ]; then
  exit 0
fi
printf '%s' "$findings" > "$seen"

{
  echo "A Markdown file lost far more lines than it gained:"
  printf '%s\n' "$findings"
  echo "If that was not the intent (a scripted edit that rewrote from an anchor, a heredoc that"
  echo "replaced the file), restore the lost part: git diff HEAD -- <file> / git show HEAD -- <file>."
} >&2
exit 2
