#!/bin/sh
# Tests for ../keep-awake.sh: one detached caffeinate per process it waits on,
# started at once, in a process group of its own, surviving the hook, ending
# with that process; still one when calls run concurrently or a lock was left
# behind; silence off macOS and when one already waits.
#
#   sh .claude/hooks/tests/keep-awake.test.sh
#
# It stops only processes it started: the `sleep`s to wait on, a fake Claude
# Code process, a decoy whose command line looks like a caffeinate waiting on
# another pid, and the caffeinates the hook starts for them (pids taken from
# the hook's own message, or new waiters on the test's own pids; the command
# is checked before any kill). The fallback case starts a 60-second
# `caffeinate -t`. Off macOS only the "silent off macOS" case runs. The hook
# runs under each of sh, dash and bash that is installed, or under
# HOOK_SHELLS. Exit status 0 when every assertion passed, 1 otherwise.

here=$(cd "$(dirname "$0")" && pwd) || exit 1
hook=$here/../keep-awake.sh
[ -f "$hook" ] || { echo "FAIL: $hook not found"; exit 1; }
unset KEEP_AWAKE_PID KEEP_AWAKE_PATTERN KEEP_AWAKE_CAP

darwin=no
[ "$(uname -s)" = Darwin ] && darwin=yes

shells=${HOOK_SHELLS:-}
if [ -z "$shells" ]; then
  for s in sh dash bash; do
    command -v "$s" >/dev/null 2>&1 && shells="$shells $s"
  done
fi

now_ms() {
  t=$(date +%s%N 2>/dev/null)
  case $t in
    ''|*[!0-9]*) ;;
    *) echo $((t / 1000000)); return ;;
  esac
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'
  else
    python3 -c 'import time; print(int(time.time() * 1000))'
  fi
}

tmp=${TMPDIR:-/tmp}
base=$(mktemp -d "${tmp%/}/keep-awake-test.XXXXXX") || exit 1
mine=
# stop PID: kill it only while it is still one of ours (a sleep, the fake
# Claude Code, the decoy, or a caffeinate the hook started for this test).
stop() {
  cmd=$(ps -ww -o command= -p "$1" 2>/dev/null) || return 0
  case $cmd in
    sleep*|*/sleep*|*fakecc/claude*|*/decoy/caffeinate*|caffeinate\ -dimsu*) kill "$1" 2>/dev/null ;;
  esac
}
cleanup() {
  for p in $mine; do stop "$p"; done
  find "$base" \( -type f -o -type l \) -exec rm -f {} + 2>/dev/null
  find "$base" -depth -type d -exec rmdir {} \; 2>/dev/null
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

payload=$base/payload
printf '%s' '{"tool_name":"Workflow","tool_input":{"name":"adversarial-review"}}' >"$payload"
mkdir -p "$base/linux" "$base/fakecc" "$base/decoy" "$base/home/.claude/shell-snapshots"
printf '#!/bin/sh\necho Linux\n' >"$base/linux/uname"
cat >"$base/fakecc/claude" <<'EOF'
#!/bin/sh
# Stands in for Claude Code: a program called claude, which the default
# pattern matches. It runs the hook two levels down, as Claude Code does: a
# shell like its Bash tool's, whose command line names ~/.claude/shell-snapshots/
# and /tmp/claude-501/ ("claude", but not Claude Code), then a hook runner
# whose command line carries the registered command,
# bash "${CLAUDE_PROJECT_DIR}/.claude/hooks/keep-awake.sh", plus claude-code,
# which the default pattern matches: only the runner rule (/.claude/hooks/)
# keeps the walk from stopping there. Then it lives on as `sleep`, same pid.
"$FAKECC_SNAPSHOT" /tmp/claude-501/scratchpad
: >"$FAKECC_OUT.done"
exec sleep 30
EOF
cat >"$base/home/.claude/shell-snapshots/snapshot-zsh-1.sh" <<'EOF'
#!/bin/sh
# The Bash tool's shell, as fakecc/claude describes it.
"$FAKECC_SHELL" -c '"$0" "$1" </dev/null >"$2" 2>&1; : bash "${CLAUDE_PROJECT_DIR}/.claude/hooks/keep-awake.sh" claude-code' \
  "$FAKECC_SHELL" "$FAKECC_HOOK" "$FAKECC_OUT"
:
EOF
cat >"$base/decoy/caffeinate" <<'EOF'
#!/bin/sh
# To pgrep -f, `.../caffeinate -dimsu -w <pid>`; it waits on nothing.
trap 'kill "$s" 2>/dev/null; exit 0' TERM INT HUP
sleep 60 &
s=$!
wait "$s"
EOF
chmod +x "$base/linux/uname" "$base/fakecc/claude" "$base/decoy/caffeinate" \
  "$base/home/.claude/shell-snapshots/snapshot-zsh-1.sh"

passed=0
failed=0
ok() { passed=$((passed + 1)); printf 'PASS  %s\n' "$1"; }
ko() {
  failed=$((failed + 1))
  printf 'FAIL  %s\n' "$1"
  [ -z "${2:-}" ] || printf '      %s\n' "$2"
}

# run [VAR=value...]: the hook under $sh_path, timed; $before lists the
# caffeinates that ran before it.
run() {
  before=$(pgrep -x caffeinate 2>/dev/null | tr '\n' ' ')
  t0=$(now_ms)
  out=$(env TMPDIR="$state" "$@" "$sh_path" "$hook" <"$payload" 2>"$base/stderr")
  rc=$?
  ms=$(($(now_ms) - t0))
  err=$(cat "$base/stderr")
}

# waiters PID: how many `caffeinate -dimsu -w PID` are running.
waiters() {
  pgrep -f "(^|/)caffeinate -dimsu -w $1\$" 2>/dev/null | wc -l | tr -d ' '
}

# started: $c = the caffeinate pid named by the hook's message (empty if
# none), remembered for the cleanup. Not run in $( ), so $mine keeps it.
started() {
  c=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null |
    sed -n 's/.*caffeinate pid \([0-9][0-9]*\).*/\1/p')
  [ -z "$c" ] || mine="$mine $c"
}

# gone PID: true once PID has exited, within 3 s.
gone() {
  n=0
  while ps -p "$1" >/dev/null 2>&1; do
    n=$((n + 1))
    [ "$n" -le 30 ] || return 1
    sleep 0.1
  done
}

envelope() {
  printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "PreToolUse"
    and (.hookSpecificOutput.additionalContext | type) == "string"' >/dev/null 2>&1
}

# check_silent NAME PID: no output, exit 0, no caffeinate waits on PID. On a
# failure it stops what the call started (the caffeinate its message names,
# any new waiter on PID): a regression must not leave one behind, least of all
# a `caffeinate -w 1`, which would wait on launchd for ever.
check_silent() {
  if [ "$rc" -eq 0 ] && [ -z "$out" ] && [ -z "$err" ] && [ "$(waiters "$2")" = 0 ]; then
    ok "[$label] $1 ($ms ms)"
    return
  fi
  ko "[$label] $1" "exit=$rc stdout=$out stderr=$err waiters=$(waiters "$2")"
  started
  [ -z "$c" ] || stop "$c"
  for w in $(pgrep -f "(^|/)caffeinate -dimsu -w $2\$" 2>/dev/null); do
    case " $before " in
      *" $w "*) ;;
      *) stop "$w" ;;
    esac
  done
}

# target: $t = a new `sleep 60` to wait on.
target() {
  sleep 60 &
  t=$!
  mine="$mine $t"
}

suite() {
  label=$1
  sh_path=$2
  state=$base/$label/state
  sd=$state/hyperion-hooks-$(id -u)
  mkdir -p "$state"
  target
  sp=$t

  run KEEP_AWAKE_PID="$sp" PATH="$base/linux:$PATH"
  check_silent "off macOS (uname says Linux): silent, starts nothing" "$sp"

  [ "$darwin" = yes ] || return 0

  run KEEP_AWAKE_PID="$sp"
  started
  c1=$c
  if [ "$rc" -eq 0 ] && [ -z "$err" ] && envelope && [ -n "$c1" ] &&
     [ "$(waiters "$sp")" = 1 ] && [ "$(pgrep -f "caffeinate -dimsu -w $sp\$")" = "$c1" ] &&
     [ "$ms" -lt 1000 ]; then
    ok "[$label] first call: exactly one caffeinate -dimsu -w $sp (pid $c1), returned in $ms ms"
    [ -n "$shown" ] || { shown=1; printf '      stdout: %s\n' "$out"; }
  else
    ko "[$label] first call: exactly one caffeinate, under 1 s" \
      "exit=$rc ms=$ms waiters=$(waiters "$sp") stdout=$out stderr=$err"
  fi

  # Detached: the hook has exited (its stdout pipe closed, or run would still
  # be waiting), and the caffeinate lives on, adopted by launchd, in a process
  # group of its own.
  n=0
  while [ "$(ps -o ppid= -p "${c1:-0}" 2>/dev/null | tr -d ' ')" != 1 ] && [ "$n" -lt 10 ]; do
    sleep 0.1
    n=$((n + 1))
  done
  cmd=$(ps -ww -o command= -p "${c1:-0}" 2>/dev/null)
  ppid=$(ps -o ppid= -p "${c1:-0}" 2>/dev/null | tr -d ' ')
  pgid=$(ps -o pgid= -p "${c1:-0}" 2>/dev/null | tr -d ' ')
  if [ "$cmd" = "caffeinate -dimsu -w $sp" ] && [ "$ppid" = 1 ]; then
    ok "[$label] the caffeinate survives the hook: '$cmd', parent pid 1"
  else
    ko "[$label] the caffeinate survives the hook" "command='$cmd' ppid='$ppid'"
  fi
  if command -v perl >/dev/null 2>&1; then
    if [ -n "$c1" ] && [ "$pgid" = "$c1" ]; then
      ok "[$label] the caffeinate leads a process group of its own (pgid $pgid)"
    else
      ko "[$label] the caffeinate leads a process group of its own" \
        "pid=$c1 pgid=$pgid (the test shell's group: $(ps -o pgid= -p $$ | tr -d ' '))"
    fi
  fi

  run KEEP_AWAKE_PID="$sp"
  if [ "$rc" -eq 0 ] && [ -z "$out" ] && [ -z "$err" ] && [ "$(waiters "$sp")" = 1 ] &&
     [ "$ms" -lt 1000 ]; then
    ok "[$label] second call: starts none, silent, returned in $ms ms"
  else
    ko "[$label] second call: starts none" \
      "exit=$rc ms=$ms waiters=$(waiters "$sp") stdout=$out stderr=$err"
    started
  fi

  kill "$sp"
  if gone "${c1:-0}" && [ "$(waiters "$sp")" = 0 ]; then
    ok "[$label] the caffeinate exits once the sleep is killed"
  else
    ko "[$label] the caffeinate exits once the sleep is killed" "still running: $c1"
  fi

  run KEEP_AWAKE_PID="$sp"
  check_silent "KEEP_AWAKE_PID of an exited process: silent, starts nothing" "$sp"
  for bad in abc 0 1; do
    run KEEP_AWAKE_PID="$bad"
    check_silent "KEEP_AWAKE_PID=$bad: silent, starts nothing" "$bad"
  done

  # pgrep's $ anchor: a caffeinate waiting on <pid>5 does not wait on <pid>.
  target
  sp3=$t
  "$base/decoy/caffeinate" -dimsu -w "${sp3}5" &
  dp=$!
  mine="$mine $dp"
  n=0
  until [ -n "$(pgrep -f "(^|/)caffeinate -dimsu -w ${sp3}5\$")" ] || [ "$n" -ge 30 ]; do
    sleep 0.1
    n=$((n + 1))
  done
  run KEEP_AWAKE_PID="$sp3"
  started
  c3=$c
  if [ "$rc" -eq 0 ] && envelope && [ -n "$c3" ] &&
     [ "$(ps -ww -o command= -p "$c3" 2>/dev/null)" = "caffeinate -dimsu -w $sp3" ]; then
    ok "[$label] a caffeinate waiting on pid ${sp3}5 is not one on pid $sp3: starts one (pid $c3)"
  else
    ko "[$label] a caffeinate waiting on pid ${sp3}5 is not one on pid $sp3: starts one" \
      "exit=$rc stdout=$out stderr=$err"
  fi
  stop "$dp"
  kill "$sp3"
  gone "${c3:-0}"

  # Concurrent calls (one assistant message can hold several Workflow calls):
  # still one caffeinate, and one message.
  target
  sp4=$t
  hs=
  i=1
  while [ "$i" -le 5 ]; do
    env TMPDIR="$state" KEEP_AWAKE_PID="$sp4" "$sh_path" "$hook" <"$payload" \
      >"$base/$label/conc.$i" 2>&1 &
    hs="$hs $!"
    i=$((i + 1))
  done
  t0=$(now_ms)
  for h in $hs; do wait "$h"; done
  ms=$(($(now_ms) - t0))
  msgs=0
  named=
  for i in 1 2 3 4 5; do
    out=$(cat "$base/$label/conc.$i")
    started
    [ -z "$c" ] || { msgs=$((msgs + 1)); named="$named $c"; }
  done
  w=$(waiters "$sp4")
  if [ "$msgs" = 1 ] && [ "$w" = 1 ]; then
    ok "[$label] five concurrent calls: one caffeinate (pid${named}), one message, $ms ms"
  else
    ko "[$label] five concurrent calls: one caffeinate" "messages=$msgs waiters=$w named:$named"
  fi
  for x in $(pgrep -f "(^|/)caffeinate -dimsu -w $sp4\$" 2>/dev/null); do mine="$mine $x"; done
  kill "$sp4"

  # A lock left behind by a hook that died holding it: taken over, not obeyed
  # for ever.
  target
  sp5=$t
  mkdir -p "$sd"
  mkdir "$sd/keep-awake-$sp5.lock"
  run KEEP_AWAKE_PID="$sp5"
  started
  c5=$c
  if [ "$rc" -eq 0 ] && [ -z "$err" ] && envelope && [ -n "$c5" ] &&
     [ "$(waiters "$sp5")" = 1 ] && [ ! -d "$sd/keep-awake-$sp5.lock" ] && [ "$ms" -lt 4000 ]; then
    ok "[$label] a lock left by a dead hook: taken over, one caffeinate (pid $c5), lock gone, $ms ms"
  else
    ko "[$label] a lock left by a dead hook: taken over" \
      "exit=$rc ms=$ms waiters=$(waiters "$sp5") lock=$([ -d "$sd/keep-awake-$sp5.lock" ] && echo kept || echo gone) stdout=$out stderr=$err"
  fi
  rmdir "$sd/keep-awake-$sp5.lock" 2>/dev/null
  kill "$sp5"
  gone "${c5:-0}"

  # Claude Code runs a hook as a process-group leader. A signal to that group
  # (an abort, a timeout) after the hook has started the caffeinate must not
  # reach it.
  if command -v perl >/dev/null 2>&1; then
    target
    sp6=$t
    gout=$base/$label/group.out
    perl -e 'setpgrp(0, 0); exec @ARGV or exit 1' \
      env TMPDIR="$state" KEEP_AWAKE_PID="$sp6" "$sh_path" "$hook" <"$payload" >"$gout" 2>&1 &
    hp=$!
    wait "$hp"
    out=$(cat "$gout")
    started
    c6=$c
    # Only the hook's own group: its leader is the hook (pid $hp), already gone.
    kill -s TERM -- "-$hp" 2>/dev/null
    sleep 0.3
    if [ -n "$c6" ] && [ "$(ps -ww -o command= -p "$c6" 2>/dev/null)" = "caffeinate -dimsu -w $sp6" ]; then
      ok "[$label] a TERM to the hook's process group leaves the caffeinate running (pid $c6)"
    else
      ko "[$label] a TERM to the hook's process group leaves the caffeinate running" \
        "caffeinate pid '$c6': $(ps -ww -o pid=,pgid=,command= -p "${c6:-0}" 2>/dev/null) stdout=$out"
    fi
    kill "$sp6"
    gone "${c6:-0}"
  fi

  # The walk: from the hook's parent (the runner, skipped) past the Bash tool's
  # shell (it says claude, but not Claude Code) to the fake Claude Code,
  # recognised by the DEFAULT pattern (a program called claude).
  fout=$base/$label/fakecc.out
  env FAKECC_SHELL="$sh_path" FAKECC_HOOK="$hook" FAKECC_OUT="$fout" TMPDIR="$state" \
    FAKECC_SNAPSHOT="$base/home/.claude/shell-snapshots/snapshot-zsh-1.sh" \
    "$base/fakecc/claude" &
  fpid=$!
  mine="$mine $fpid"
  n=0
  while [ ! -f "$fout.done" ] && [ "$n" -lt 50 ]; do
    sleep 0.1
    n=$((n + 1))
  done
  out=$(cat "$fout" 2>/dev/null)
  started
  c2=$c
  if envelope && [ -n "$c2" ] && [ "$(waiters "$fpid")" = 1 ] &&
     [ "$(pgrep -f "caffeinate -dimsu -w $fpid\$")" = "$c2" ]; then
    case $out in
      *"until Claude Code (pid $fpid) exits"*)
        ok "[$label] walk: skips the runner and the Bash tool's shell, waits on the fake Claude Code (pid $fpid)" ;;
      *) ko "[$label] walk: names the Claude Code pid" "stdout=$out" ;;
    esac
  else
    ko "[$label] walk: waits on the fake Claude Code (pid $fpid)" \
      "waiters=$(waiters "$fpid") stdout=$out"
  fi
  kill "$fpid"
  if gone "${c2:-0}"; then
    ok "[$label] walk: the caffeinate exits with the fake Claude Code"
  else
    ko "[$label] walk: the caffeinate exits with the fake Claude Code" "still running: $c2"
  fi

  # No Claude Code among the ancestors: a capped caffeinate, recorded, not
  # repeated while it has most of its time left, replaced once it is gone.
  nomatch='^no-such-process-for-keep-awake$'
  run KEEP_AWAKE_PATTERN="$nomatch" KEEP_AWAKE_CAP=60
  started
  c4=$c
  cmd=$(ps -ww -o command= -p "${c4:-0}" 2>/dev/null)
  if [ "$rc" -eq 0 ] && [ -z "$err" ] && envelope && [ "$cmd" = "caffeinate -dimsu -t 60" ] &&
     [ "$ms" -lt 1000 ]; then
    ok "[$label] fallback: no Claude Code ancestor, caffeinate -dimsu -t 60 (pid $c4), $ms ms"
  else
    ko "[$label] fallback: caffeinate -dimsu -t 60" \
      "exit=$rc ms=$ms command='$cmd' stdout=$out stderr=$err"
  fi
  run KEEP_AWAKE_PATTERN="$nomatch" KEEP_AWAKE_CAP=60
  if [ "$rc" -eq 0 ] && [ -z "$out" ] && [ -z "$err" ] && ps -p "${c4:-0}" >/dev/null 2>&1; then
    ok "[$label] fallback: a second call while it runs starts none ($ms ms)"
  else
    ko "[$label] fallback: a second call starts none" "exit=$rc stdout=$out stderr=$err"
    started
  fi
  stop "${c4:-0}"
  gone "${c4:-0}"
  run KEEP_AWAKE_PATTERN="$nomatch" KEEP_AWAKE_CAP=60
  started
  c7=$c
  if [ -n "$c7" ] && [ "$c7" != "$c4" ] &&
     [ "$(ps -ww -o command= -p "$c7" 2>/dev/null)" = "caffeinate -dimsu -t 60" ]; then
    ok "[$label] fallback: once it is gone, the next call starts another (pid $c7)"
  else
    ko "[$label] fallback: once it is gone, the next call starts another" "stdout=$out"
  fi
  stop "${c7:-0}"
}

shown=
echo "macOS: $darwin; hook shells:$shells"
for s in $shells; do
  suite "$s" "$(command -v "$s")"
done

echo "keep-awake: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
