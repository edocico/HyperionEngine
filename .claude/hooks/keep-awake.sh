#!/bin/sh
# PreToolUse(Workflow) — keep this Mac awake for as long as Claude Code runs.
#
# On battery this Mac sleeps after one idle minute (pmset sleep 1), and a sleep
# kills the in-flight agent requests of a long workflow, which then restart
# from scratch. Before a Workflow call this starts a detached
#   caffeinate -dimsu -w <Claude Code pid>
# which keeps the system, the disk and the display awake (GPU sessions need the
# display) and ends by itself when that Claude Code process exits.
#
# A side effect only: always exit 0. One line of context when it starts a
# caffeinate, silence otherwise (not macOS; one already waits on that pid). It
# never counts, waits on or stops any other caffeinate.
#
# Claude Code is the first ancestor, from $PPID up to 15 levels, whose command
# line names it: a program called claude (the CLI, the VS Code extension's
# native binary, node running the npm `claude` shim, a versioned binary under
# claude/versions/) or a path with claude-code in it (node running
# @anthropic-ai/claude-code, the extension's directory). Any "claude" would
# not do: the hook runner's own command line holds `.claude/hooks/` and
# `${CLAUDE_PROJECT_DIR}`, and a caffeinate waiting on the runner would end with
# this hook. So a command naming /.claude/hooks/ is skipped. Nor do the Bash
# tool's shell (~/.claude/shell-snapshots/) or a scratch path (/tmp/claude-501/)
# match: neither names a program called claude.
#
# One assistant message can hold several Workflow calls, whose hooks run
# concurrently, and pgrep cannot see a caffeinate that another call is still
# launching. So the check and the start hold a lock (a directory,
# keep-awake-<pid>.lock in the state dir below), released once the new
# caffeinate shows in ps. A call waits up to 2 s for it; a lock held longer
# was left by a hook that died holding it, and is taken over.
#
# Detached: stdio on /dev/null (Claude Code does not wait on the hook's
# pipes), cwd /, SIGHUP ignored (nohup), and in a session of its own when perl
# is there (POSIX::setsid): Claude Code runs a hook as a process-group leader,
# and a signal it sends to that group (an abort, a timeout) must not reach the
# caffeinate.
#
# None found: `caffeinate -dimsu -t 14400`, a 4-hour cap. Its pid is kept in
# ${TMPDIR:-/tmp}/hyperion-hooks-<uid>/, and the next Workflow call starts
# another only once that one is gone or has run a quarter of its time.
#
# Overrides (the tests use them):
#   KEEP_AWAKE_PID      wait on this pid instead of looking for Claude Code
#   KEEP_AWAKE_PATTERN  ERE, case-insensitive, that names the Claude Code process
#   KEEP_AWAKE_CAP      seconds of the fallback caffeinate (default 14400)

cat >/dev/null 2>&1
[ "$(uname -s 2>/dev/null)" = Darwin ] || exit 0
command -v caffeinate >/dev/null 2>&1 || exit 0

isnum() {
  case $1 in ''|*[!0-9]*) return 1 ;; esac
}

# The state dir: ours alone (a directory, not a link, owned by us), else none.
uid=$(id -u)
state=${TMPDIR:-/tmp}
state=${state%/}/hyperion-hooks-$uid
(umask 077 && mkdir -p "$state") 2>/dev/null
if [ ! -d "$state" ] || [ -L "$state" ] ||
   [ -z "$(find "$state" -prune -user "$uid" 2>/dev/null)" ]; then
  state=
fi

# lock NAME: hold $state/NAME.lock until this hook exits (no state dir: no
# lock). Waits up to 2 s, then takes the lock over; false when another call
# took it over first.
lock() {
  [ -n "$state" ] || return 0
  lk=$state/$1.lock
  n=0
  until mkdir "$lk" 2>/dev/null; do
    n=$((n + 1))
    if [ "$n" -gt 40 ]; then
      rmdir "$lk" 2>/dev/null
      mkdir "$lk" 2>/dev/null || return 1
      break
    fi
    sleep 0.05
  done
  trap 'rmdir "$lk" 2>/dev/null' EXIT
  trap 'exit 0' HUP INT TERM
}

# launch ARGS...: start `caffeinate -dimsu ARGS` detached. Every step execs,
# so $! is the caffeinate's pid.
launch() {
  if perl -MPOSIX -e 1 >/dev/null 2>&1; then
    (cd / && exec nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or exit 1' \
      caffeinate -dimsu "$@") </dev/null >/dev/null 2>&1 &
  else
    (cd / && exec nohup caffeinate -dimsu "$@") </dev/null >/dev/null 2>&1 &
  fi
}

# shows PID ARGS...: within 1 s, ps shows PID as `caffeinate -dimsu ARGS`, as
# the next call's check will look for it.
shows() {
  sp=$1
  shift
  n=0
  until [ "$(ps -ww -o command= -p "$sp" 2>/dev/null)" = "caffeinate -dimsu $*" ]; do
    n=$((n + 1))
    [ "$n" -le 50 ] || return 1
    sleep 0.02
  done
}

target=
what=
if [ -n "${KEEP_AWAKE_PID:-}" ]; then
  isnum "$KEEP_AWAKE_PID" || exit 0
  [ "$KEEP_AWAKE_PID" -gt 1 ] 2>/dev/null || exit 0
  ps -p "$KEEP_AWAKE_PID" >/dev/null 2>&1 || exit 0
  target=$KEEP_AWAKE_PID
  what="pid $target (KEEP_AWAKE_PID)"
else
  pattern=${KEEP_AWAKE_PATTERN:-}
  [ -n "$pattern" ] || pattern='(^|/)claude( |$)|claude-code|/claude/versions/'
  p=$PPID
  i=0
  while [ "$i" -lt 15 ] && isnum "$p" && [ "$p" -gt 1 ]; do
    cmd=$(ps -ww -o command= -p "$p" 2>/dev/null) || break
    case $cmd in
      */.claude/hooks/*) ;;
      *)
        if printf '%s\n' "$cmd" | grep -Eiq -- "$pattern" 2>/dev/null; then
          target=$p
          what="Claude Code (pid $target)"
          break
        fi
        ;;
    esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    i=$((i + 1))
  done
fi

if [ -n "$target" ]; then
  lock "keep-awake-$target" || exit 0
  pgrep -f "(^|/)caffeinate -dimsu -w $target\$" >/dev/null 2>&1 && exit 0
  launch -w "$target"
  cpid=$!
  shows "$cpid" -w "$target" || kill -0 "$cpid" 2>/dev/null || exit 0
  note="keep-awake: caffeinate pid $cpid (-dimsu -w $target) keeps this Mac and its display awake until $what exits."
else
  cap=${KEEP_AWAKE_CAP:-14400}
  { isnum "$cap" && [ "$cap" -gt 0 ]; } 2>/dev/null || cap=14400
  lock keep-awake-fallback || exit 0
  now=$(date +%s)
  rec=
  [ -z "$state" ] || rec=$state/keep-awake-fallback
  if [ -n "$rec" ] && [ -f "$rec" ] && read -r opid ostart ocap < "$rec" &&
     isnum "$opid" && isnum "$ostart" && isnum "$ocap" && isnum "$now" &&
     [ $((now - ostart)) -lt $((ocap / 4)) ]; then
    case $(ps -ww -o command= -p "$opid" 2>/dev/null) in
      *caffeinate" -dimsu -t $ocap") exit 0 ;;
    esac
  fi
  launch -t "$cap"
  cpid=$!
  shows "$cpid" -t "$cap" || kill -0 "$cpid" 2>/dev/null || exit 0
  [ -n "$rec" ] && printf '%s %s %s\n' "$cpid" "$now" "$cap" > "$rec" 2>/dev/null
  note="keep-awake: no Claude Code process among this hook's ancestors, so caffeinate pid $cpid (-dimsu -t $cap) keeps this Mac and its display awake for $cap seconds at most."
fi

printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"%s"}}\n' "$note"
exit 0
