#!/bin/sh
# PreToolUse(chrome-devtools navigate_page|evaluate_script) — say so when this
# checkout's Vite dev server started before files under ts/src changed.
#
# Vite does not always serve what is on disk. After a checkout that rewrote a
# shader, the browser kept running the old `?import&raw` transform (2026-09-27).
# And after ANY edit, the app imports the edited module as `/src/x.ts?t=<n>`,
# so a page script's `import('/src/x.ts')` by the bare URL gets a SECOND module
# instance, not the app's: the step-6 bench read LightAccumStage.SHADER_SOURCE
# as '' (2026-10-05). The fix is the CLAUDE.md gotcha: restart the dev server.
#
# Advisory, never blocking: it adds context to the call and exits 0. It is
# silent when the server is fresh and whenever it cannot tell (no jq; neither
# lsof nor ss; nothing listening; a listener that is not Vite, or is another
# checkout's; an unreadable start time; a malformed payload). navigate_page
# warns every time the server is stale: a navigation loads the stale module
# graph. evaluate_script warns only when a file changed after the last warning
# for this server, so a run of scripts gets one warning per batch of edits
# (state: ${TMPDIR:-/tmp}/hyperion-hooks-<uid>/).
#
# The dev server is the process listening on the port (lsof, else ss) whose
# command line runs Vite, a program or script called vite or vite.js. A bare
# "vite" substring would not do: on the Mac every node runs as
# ~/.vite-plus/js_runtime/node/<v>/bin/node (the Vite+ shim). It must also be
# THIS checkout's (gpu-infra.sh's is_repo_vite rule): its command line names
# <root>/ts/ (`npm --prefix ts run dev` runs node <root>/ts/node_modules/.bin/vite)
# or it runs in <root>/ts. Another checkout's Vite serves another tree; this
# tree's edits do not make it stale, and "stop it" would hit a server another
# session uses.
#
# Changed = a regular *.ts or *.wgsl file under the sources, modified after the
# server process started, except *.test.ts, *.fixture.ts (test-only: no app
# module imports one) and *.d.ts (types, never served).
#
# The port is the explicit one of a navigate_page http(s) URL (scheme in any
# case, leading zeros dropped), else 5173: a URL without a port, a reload, a
# back or forward, and every evaluate_script check 5173.
#
# POSIX sh, BSD and GNU userlands alike. Overrides (the tests use them):
#   HYPERION_DEVSERVER_PORT     port to check (default: as above)
#   HYPERION_DEVSERVER_PATTERN  ERE the listener's command line must match
#                               (default: (^|[/ ])vite(\.js)?( |$))
#   HYPERION_SRC_DIR            sources to compare (default: <root>/ts/src)

command -v jq >/dev/null 2>&1 || exit 0
input=$(cat)

tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
case $tool in
  mcp__chrome-devtools-gpu__navigate_page|mcp__chrome-devtools__navigate_page) kind=navigate ;;
  mcp__chrome-devtools-gpu__evaluate_script|mcp__chrome-devtools__evaluate_script) kind=evaluate ;;
  *) exit 0 ;;
esac

root=${CLAUDE_PROJECT_DIR:-}
if [ -z "$root" ]; then
  root=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
fi
root=${root%/}
[ -n "$root" ] && [ -d "$root" ] || exit 0
# The root with its symlinks resolved, which is how lsof reports a cwd.
proot=$(CDPATH= cd -- "$root" 2>/dev/null && pwd -P) || proot=
src=${HYPERION_SRC_DIR:-$root/ts/src}
[ -d "$src" ] || exit 0

# The port: the explicit one of a navigate_page http(s) URL, else Vite's 5173.
port=5173
if [ "$kind" = navigate ]; then
  url=$(printf '%s' "$input" | jq -r '.tool_input.url // empty | strings' 2>/dev/null)
  case $url in
    [Hh][Tt][Tt][Pp]://*|[Hh][Tt][Tt][Pp][Ss]://*)
      hp=${url#*://}
      hp=${hp%%/*}; hp=${hp%%\?*}; hp=${hp%%#*}
      hp=${hp##*@}
      case $hp in
        *\]:*) p=${hp##*\]:} ;;
        \[*) p= ;;
        *:*) p=${hp##*:} ;;
        *) p= ;;
      esac
      case $p in ''|*[!0-9]*) ;; *) port=$p ;; esac
      ;;
  esac
fi
port=${HYPERION_DEVSERVER_PORT:-$port}
case $port in ''|*[!0-9]*) exit 0 ;; esac
while :; do
  case $port in 0?*) port=${port#0} ;; *) break ;; esac
done

# listeners PORT: the pids listening on it.
listeners() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | sed 's/^pid=//' | sort -u
  fi
}

# cwd_of PID: its working directory (/proc on Linux, else lsof).
cwd_of() {
  if [ -d "/proc/$1" ]; then
    readlink "/proc/$1/cwd" 2>/dev/null
  elif command -v lsof >/dev/null 2>&1; then
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
  fi
}

# ours PID COMMAND: the listener belongs to this checkout. Its command line
# names <root>/ts/ as a word of its own (or after an `=`), or it runs in
# <root>/ts or below; either spelling of the root.
ours() {
  for r in "$root" "$proot"; do
    [ -n "$r" ] || continue
    case " $2" in *[\ =]"$r/ts/"*) return 0 ;; esac
  done
  dir=$(cwd_of "$1")
  [ -n "$dir" ] || return 1
  for r in "$root" "$proot"; do
    [ -n "$r" ] || continue
    case $dir in "$r/ts"|"$r/ts/"*) return 0 ;; esac
  done
  return 1
}

# The dev server: the listener on the port that runs Vite, for this checkout.
pattern=${HYPERION_DEVSERVER_PATTERN:-}
[ -n "$pattern" ] || pattern='(^|[/ ])vite(\.js)?( |$)'
pid=
for p in $(listeners "$port"); do
  case $p in ''|*[!0-9]*) continue ;; esac
  cmd=$(ps -ww -o command= -p "$p" 2>/dev/null) || continue
  printf '%s\n' "$cmd" | grep -Eq -- "$pattern" 2>/dev/null || continue
  ours "$p" "$cmd" || continue
  pid=$p
  break
done
[ -n "$pid" ] || exit 0

# When it started, from its elapsed time, [[dd-]hh:]mm:ss (macOS ps has no
# etimes). Both ends are truncated to the second, so one second is added: a
# file written just before the server started never counts, at the price of
# missing an edit made in the server's first two seconds.
elapsed=$(ps -o etime= -p "$pid" 2>/dev/null | awk '
  { gsub(/[ \t]/, "") }
  /^([0-9]+-)?([0-9]+:)?[0-9]+:[0-9]+$/ {
    d = 0
    i = index($0, "-")
    if (i) { d = substr($0, 1, i - 1); $0 = substr($0, i + 1) }
    n = split($0, f, ":")
    s = (n == 3) ? f[1] * 3600 + f[2] * 60 + f[3] : f[1] * 60 + f[2]
    printf "%d\n", d * 86400 + s
  }
  { exit }')
case $elapsed in ''|*[!0-9]*) exit 0 ;; esac
now=$(date +%s 2>/dev/null)
case $now in ''|*[!0-9]*) exit 0 ;; esac
start=$((now - elapsed + 1))
when=$(TZ=UTC0 date -r "$start" +%Y%m%d%H%M.%S 2>/dev/null) ||
  when=$(TZ=UTC0 date -d "@$start" +%Y%m%d%H%M.%S 2>/dev/null) || exit 0
case $when in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].[0-9][0-9]) ;;
  *) exit 0 ;;
esac

uid=$(id -u)
state=${TMPDIR:-/tmp}
state=${state%/}/hyperion-hooks-$uid
(umask 077 && mkdir -p "$state") 2>/dev/null
[ -d "$state" ] && [ ! -L "$state" ] || exit 0
[ -n "$(find "$state" -prune -user "$uid" 2>/dev/null)" ] || exit 0
ref=$state/devserver-$port-$pid.start
warned=$state/devserver-$port-$pid.warned
TZ=UTC0 touch -t "$when" "$ref" 2>/dev/null || exit 0
# Forget the servers that used to listen on this port.
for f in "$state"/devserver-"$port"-*; do
  case $f in "$state/devserver-$port-$pid".*) ;; *) rm -f "$f" ;; esac
done

# sources REF [ACTION...]: the watched files modified after REF.
sources() {
  newer=$1
  shift
  find "$src" -type f \( -name '*.ts' -o -name '*.wgsl' \) \
    ! -name '*.test.ts' ! -name '*.fixture.ts' ! -name '*.d.ts' \
    -newer "$newer" "$@" 2>/dev/null
}

changed=$(sources "$ref" -exec ls -t {} +)
[ -n "$changed" ] || exit 0
if [ "$kind" = evaluate ] && [ -f "$warned" ]; then
  [ -n "$(sources "$warned" | head -n 1)" ] || exit 0
fi

# rel PATH: PATH relative to the repo root when it lies inside it. A function,
# because bash 3.2 (macOS sh) misparses a case pattern inside $( ).
rel() {
  case $1 in "$root"/*) printf '%s' "${1#"$root"/}"; return ;; esac
  printf '%s' "$1"
}

count=$(printf '%s\n' "$changed" | wc -l | tr -d ' ')
names=$(printf '%s\n' "$changed" | head -n 3 | while IFS= read -r f; do
  printf '%s, ' "$(rel "$f")"
done)
names=${names%, }
if [ "$count" -gt 3 ]; then
  names="$names and $((count - 3)) more"
fi
where=$(rel "$src")

note="The dev server on :$port (pid $pid) started before $count file(s) under $where changed (newest first: $names). A page script's import('/src/...') may get a second module instance, not the app's (the app imports an edited module as ?t=...), and ?raw imports may be stale. Restart it (stop it, then \`npm --prefix ts run dev\`) and navigate again before a bench or probe session."

jq -n --arg note "$note" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $note}}' || exit 0
touch "$warned" 2>/dev/null
exit 0
