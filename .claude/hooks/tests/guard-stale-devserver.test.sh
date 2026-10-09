#!/bin/sh
# Tests for ../guard-stale-devserver.sh: it must FIRE when a watched file
# changed after this checkout's Vite dev server started, and stay SILENT
# otherwise.
#
#   sh .claude/hooks/tests/guard-stale-devserver.test.sh
#
# Hermetic. The "dev servers" are one small python3 listener, copied to where
# a server would run from and started on free ports in 5190-5199:
#   main   this tree's ts/node_modules/.bin/vite, run from outside the tree
#          (the default pattern; the command line names <root>/ts/)
#   other  another checkout's vite (repo-other/, a sibling whose name starts
#          with the tree's own), named and run there
#   cwd    a vite outside any tree, run in this tree's ts/ (the working
#          directory rule)
#   shim   a "node" under .vite-plus/js_runtime/ (the Vite+ shim's layout, so
#          its command line holds "vite"), run in this tree's ts/: not Vite
# The sources are a throwaway tree shared by the suites (reset by each), the
# hook's state a throwaway TMPDIR per suite. A fake `ps` answers etime, a fake
# `date` the time, and a fake `ss` stands in when lsof is hidden. It stops
# only the listeners it started. Needs python3, jq, and lsof or ss (SKIP
# without them). The hook runs under each of sh, dash and bash that is
# installed, or under HOOK_SHELLS. Exit status 0 when every assertion passed,
# 1 otherwise.

here=$(cd "$(dirname "$0")" && pwd) || exit 1
hook=$here/../guard-stale-devserver.sh
[ -f "$hook" ] || { echo "FAIL: $hook not found"; exit 1; }
unset HYPERION_DEVSERVER_PORT HYPERION_DEVSERVER_PATTERN HYPERION_SRC_DIR CLAUDE_PROJECT_DIR

for tool in python3 jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "SKIP: $tool not found"; exit 0; }
done
if command -v lsof >/dev/null 2>&1; then
  have_lsof=yes
elif command -v ss >/dev/null 2>&1; then
  have_lsof=no
else
  echo "SKIP: neither lsof nor ss found"
  exit 0
fi

# listeners PORT: the pids listening on it (lsof, else ss).
listeners() {
  if [ "$have_lsof" = yes ]; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null
  else
    ss -ltnp "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | sed 's/^pid=//' | sort -u
  fi
}

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

# touch_at EPOCH FILE: set FILE's modification time (BSD date, else GNU date).
touch_at() {
  stamp=$(TZ=UTC0 date -r "$1" +%Y%m%d%H%M.%S 2>/dev/null) ||
    stamp=$(TZ=UTC0 date -d "@$1" +%Y%m%d%H%M.%S 2>/dev/null) || return 1
  TZ=UTC0 touch -t "$stamp" "$2"
}

# touch_frac EPOCH FRAC FILE: modification time EPOCH.FRAC (BSD touch -d takes
# ISO 8601 with a fraction, GNU touch -d takes @EPOCH.FRAC).
touch_frac() {
  iso=$(date -u -r "$1" +%Y-%m-%dT%H:%M:%S 2>/dev/null) &&
    touch -d "$iso.${2}Z" "$3" 2>/dev/null && return 0
  touch -d "@$1.$2" "$3"
}

tmp=${TMPDIR:-/tmp}
base=$(mktemp -d "${tmp%/}/stale-devserver-test.XXXXXX") || exit 1
spids=
cleanup() {
  # Only what this script started: each listener's command line names $base.
  for p in $spids; do
    case $(ps -ww -o command= -p "$p" 2>/dev/null) in
      *"$base/"*) kill "$p" 2>/dev/null ;;
    esac
  done
  find "$base" \( -type f -o -type l \) -exec rm -f {} + 2>/dev/null
  find "$base" -depth -type d -exec rmdir {} \; 2>/dev/null
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# Five free ports in our range: four listeners and one that stays idle.
free=
for p in 5190 5191 5192 5193 5194 5195 5196 5197 5198 5199; do
  [ -n "$(listeners "$p")" ] || free="$free $p"
done
set -- $free
[ $# -ge 5 ] || { echo "SKIP: fewer than five free ports in 5190-5199"; exit 0; }
P_main=$1 P_idle=$2 P_other=$3 P_cwd=$4 P_shim=$5

repo=$base/repo
src=$repo/ts/src
other=$base/repo-other
mkdir -p "$src" "$repo/ts/node_modules/.bin" "$other/ts/node_modules/.bin" \
  "$base/global/bin" "$base/home/.vite-plus/js_runtime/node/24.21.0/bin"
cat >"$base/fake-server" <<'EOF'
# Stands in for a dev server: listens on 127.0.0.1:<--port>, accepts nothing.
import socket, sys, time
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[sys.argv.index("--port") + 1])))
s.listen(5)
while True:
    time.sleep(3600)
EOF
vite_main=$repo/ts/node_modules/.bin/vite
vite_other=$other/ts/node_modules/.bin/vite
vite_global=$base/global/bin/vite
shim_node=$base/home/.vite-plus/js_runtime/node/24.21.0/bin/node
for f in "$vite_main" "$vite_other" "$vite_global" "$shim_node"; do
  cp "$base/fake-server" "$f"
done

# serve DIR SCRIPT PORT: python3 SCRIPT --port PORT, run in DIR; $lp = the pid
# that listens on PORT (false when none does within 10 s).
serve() {
  (cd "$1" && exec python3 "$2" --port "$3") >>"$base/servers.log" 2>&1 &
  spids="$spids $!"
  lp=
  i=0
  while [ "$i" -lt 100 ]; do
    lp=$(listeners "$3" | head -n 1)
    [ -n "$lp" ] && return 0
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}
setup_fail() {
  echo "FAIL: the test listener on :$1 did not start"
  cat "$base/servers.log"
  exit 1
}
serve "$base" "$vite_main" "$P_main" || setup_fail "$P_main"
lp_main=$lp
serve "$other/ts" "$vite_other" "$P_other" || setup_fail "$P_other"
lp_other=$lp
serve "$repo/ts" "$vite_global" "$P_cwd" || setup_fail "$P_cwd"
lp_cwd=$lp
serve "$repo/ts" "$shim_node" "$P_shim" || setup_fail "$P_shim"
lp_shim=$lp
for l in "main $P_main $lp_main" "other $P_other $lp_other" "cwd $P_cwd $lp_cwd" "shim $P_shim $lp_shim"; do
  set -- $l
  echo "listener $1: pid $3 on :$2 (...$(ps -ww -o command= -p "$3" | sed "s|^.*$base/||"))"
done
echo "idle port: $P_idle; lsof: $have_lsof; hook shells:$shells"
# The hook adds a second to a server's start time, so wait past that before
# any edit meant to count as "after the server started".
sleep 3

pl=$base/payloads
mkdir -p "$pl" "$base/fakebin" "$base/nobin" "$base/nolsof" "$base/nonet"
printf '%s' '{"tool_name":"mcp__chrome-devtools-gpu__navigate_page","tool_input":{"type":"reload","pageId":1}}' >"$pl/nav"
printf '%s' '{"tool_name":"mcp__chrome-devtools__evaluate_script","tool_input":{"function":"() => 1","pageId":1}}' >"$pl/eval"
nav_url() {  # nav_url NAME URL
  printf '{"tool_name":"mcp__chrome-devtools__navigate_page","tool_input":{"type":"url","url":"%s","pageId":1}}' "$2" >"$pl/$1"
}
nav_url nav-url "http://127.0.0.1:$P_main/?mode=B"
nav_url nav-url-q "http://127.0.0.1:$P_main?mode=B"
nav_url nav-url6 "http://u:p@[::1]:$P_main#frag"
nav_url nav-upper "HTTP://127.0.0.1:$P_main/"
nav_url nav-zero "http://127.0.0.1:0$P_main/"
nav_url nav-idle "http://localhost:$P_idle/"
printf '%s' '{"tool_name": "mcp__chrome-devtools__navigate_page", "tool_input": {' >"$pl/malformed"
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"ls"}}' >"$pl/other"

real_ps=$(command -v ps)
real_date=$(command -v date)
cat >"$base/fakebin/ps" <<'EOF'
#!/bin/sh
# ps, except that `-o etime=` answers $FAKE_ETIME.
case " $* " in
  *" etime= "*) printf '%s\n' "$FAKE_ETIME"; exit 0 ;;
esac
exec "$REAL_PS" "$@"
EOF
cat >"$base/fakebin/date" <<'EOF'
#!/bin/sh
# date, except that `date +%s` answers $FAKE_NOW when it is set.
if [ "$*" = +%s ] && [ -n "${FAKE_NOW:-}" ]; then
  printf '%s\n' "$FAKE_NOW"
  exit 0
fi
exec "$REAL_DATE" "$@"
EOF
chmod +x "$base/fakebin/ps" "$base/fakebin/date"

# PATH without lsof: nolsof has ss (a fake one reading the real lsof, or the
# real ss on a box without lsof), nonet has neither.
for t in awk cat cut date find grep head id jq ls mkdir ps readlink rm sed sort touch tr wc; do
  p=$(command -v "$t" 2>/dev/null) || continue
  case $p in
    /*) ln -s "$p" "$base/nolsof/$t"; ln -s "$p" "$base/nonet/$t" ;;
  esac
done
real_lsof=
if [ "$have_lsof" = yes ]; then
  real_lsof=$(command -v lsof)
  cat >"$base/nolsof/ss" <<'EOF'
#!/bin/sh
# ss -ltnp "sport = :PORT" as iproute2 prints it, from the real lsof.
port=
for a in "$@"; do
  case $a in *"sport = :"*) port=${a##*:} ;; esac
done
echo 'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process'
[ -n "$port" ] || exit 0
for p in $("$REAL_LSOF" -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null); do
  printf 'LISTEN 0      5          127.0.0.1:%s      0.0.0.0:*    users:(("python3",pid=%s,fd=3))\n' "$port" "$p"
done
EOF
  chmod +x "$base/nolsof/ss"
else
  ln -s "$(command -v ss)" "$base/nolsof/ss"
fi

passed=0
failed=0
ok() { passed=$((passed + 1)); printf 'PASS  %s\n' "$1"; }
ko() {
  failed=$((failed + 1))
  printf 'FAIL  %s\n' "$1"
  [ -z "${2:-}" ] || printf '      %s\n' "$2"
}

# run PAYLOAD [VAR=value...]: the hook under $sh_path; later assignments win.
# The fakes find the real tools through REAL_*.
run() {
  payload=$pl/$1
  shift
  t0=$(now_ms)
  out=$(env CLAUDE_PROJECT_DIR="$repo" TMPDIR="$state" HYPERION_DEVSERVER_PORT="$P_main" \
    REAL_PS="$real_ps" REAL_DATE="$real_date" REAL_LSOF="$real_lsof" \
    "$@" "$sh_path" "$hook" <"$payload" 2>"$base/stderr")
  rc=$?
  ms=$(($(now_ms) - t0))
  err=$(cat "$base/stderr")
}

silent() {
  if [ "$rc" -eq 0 ] && [ -z "$out" ] && [ -z "$err" ]; then
    ok "[$label] $1 ($ms ms)"
  else
    ko "[$label] $1" "exit=$rc stdout=$out stderr=$err"
  fi
}

# warns NAME TEXT...: exit 0, nothing on stderr, the advisory envelope, and a
# context that contains every TEXT.
warns() {
  name=$1
  shift
  if [ "$rc" -ne 0 ] || [ -n "$err" ]; then
    ko "[$label] $name" "exit=$rc stderr=$err"
    return
  fi
  ctx=$(printf '%s' "$out" | jq -er 'select(.hookSpecificOutput.hookEventName == "PreToolUse")
    | .hookSpecificOutput.additionalContext | strings' 2>/dev/null)
  if [ -z "$ctx" ]; then
    ko "[$label] $name" "not the advisory envelope: $out"
    return
  fi
  for text in "$@"; do
    case $ctx in
      *"$text"*) ;;
      *) ko "[$label] $name" "no '$text' in: $ctx"; return ;;
    esac
  done
  ok "[$label] $name ($ms ms)"
}

suite() {
  label=$1
  sh_path=$2
  state=$base/$label/state
  sd=$state/hyperion-hooks-$(id -u)
  mkdir -p "$state"
  # The shared tree, reset: every file older than the listeners.
  find "$src" -type f -exec rm -f {} + 2>/dev/null
  mkdir -p "$src/sub"
  for f in a.ts b.wgsl c.test.ts d.fixture.ts e.d.ts sub/f.ts; do
    : >"$src/$f"
    touch -t 200001010000 "$src/$f"
  done

  run nav HYPERION_DEVSERVER_PORT="$P_idle"
  silent "nothing listening on :$P_idle: silent"

  run nav
  silent "this tree's vite, no watched file newer than it: silent"

  touch "$src/c.test.ts" "$src/d.fixture.ts" "$src/e.d.ts"
  run nav
  silent "only a *.test.ts, *.fixture.ts and *.d.ts touched: silent"

  touch "$src/sub/f.ts"
  run nav
  warns "a .ts touched after this tree's vite started (default pattern): warns and names it" \
    ":$P_main (pid $lp_main)" "1 file(s) under ts/src" "(newest first: ts/src/sub/f.ts)"
  [ -n "$shown" ] || { shown=1; printf '      context: %s\n' "$ctx"; }

  run nav HYPERION_DEVSERVER_PATTERN='^not-the-listener$'
  silent "a listener whose command does not match the pattern: silent"

  # Which listener is this checkout's dev server.
  run nav HYPERION_DEVSERVER_PORT="$P_shim"
  silent "a node under .vite-plus/ (the Vite+ shim) in this tree's ts/: not Vite, silent"

  run nav HYPERION_DEVSERVER_PORT="$P_other"
  silent "another checkout's vite (repo-other/, named and run there): silent"

  run nav HYPERION_DEVSERVER_PORT="$P_cwd"
  warns "a vite whose command line names no tree, run in this tree's ts/: warns" \
    ":$P_cwd (pid $lp_cwd)"

  run nav PATH="$base/nolsof"
  warns "no lsof on PATH: ss finds the listener, warns" ":$P_main (pid $lp_main)"

  run nav PATH="$base/nonet"
  silent "neither lsof nor ss on PATH: silent"

  # The port of a navigate_page URL.
  run nav-url HYPERION_DEVSERVER_PORT=
  warns "navigate_page to http://127.0.0.1:$P_main/?mode=B: checks :$P_main" ":$P_main (pid $lp_main)"

  run nav-url-q HYPERION_DEVSERVER_PORT=
  warns "navigate_page to http://127.0.0.1:$P_main?mode=B: checks :$P_main" ":$P_main (pid $lp_main)"

  run nav-url6 HYPERION_DEVSERVER_PORT=
  warns "navigate_page to http://u:p@[::1]:$P_main#frag: checks :$P_main" ":$P_main (pid $lp_main)"

  run nav-upper HYPERION_DEVSERVER_PORT=
  warns "navigate_page to HTTP://127.0.0.1:$P_main/ (upper-case scheme): checks :$P_main" \
    ":$P_main (pid $lp_main)"

  run nav-zero HYPERION_DEVSERVER_PORT=
  warns "navigate_page to http://127.0.0.1:0$P_main/: names the port :$P_main" ":$P_main (pid $lp_main)"

  run nav-idle HYPERION_DEVSERVER_PORT=
  silent "navigate_page to http://localhost:$P_idle/ (nothing listening): silent"

  # One evaluate_script warning per batch of edits.
  run eval
  silent "evaluate_script with no edit since the last warning: silent"

  sleep 1
  touch "$src/a.ts"
  run eval
  warns "evaluate_script after a new edit: warns" \
    "2 file(s)" "(newest first: ts/src/a.ts, ts/src/sub/f.ts)"

  run eval
  silent "evaluate_script again, no new edit: silent"

  run nav
  warns "navigate_page while still stale: warns again" "2 file(s)"

  sleep 1
  touch "$src/b.wgsl"
  run eval
  warns "evaluate_script after editing a .wgsl: warns, newest first" \
    "3 file(s)" "(newest first: ts/src/b.wgsl, ts/src/a.ts, ts/src/sub/f.ts)"

  sleep 1
  : >"$src/sub/g.ts"
  run nav
  warns "four changed files: the newest three and a count of the rest" \
    "4 file(s)" "(newest first: ts/src/sub/g.ts, ts/src/b.wgsl, ts/src/a.ts and 1 more)"

  # The state dir.
  : >"$sd/devserver-$P_main-1.start"
  : >"$sd/devserver-$P_main-1.warned"
  : >"$sd/devserver-$P_idle-1.warned"
  run nav
  if [ "$rc" -eq 0 ] && [ ! -e "$sd/devserver-$P_main-1.start" ] &&
     [ ! -e "$sd/devserver-$P_main-1.warned" ] && [ -e "$sd/devserver-$P_idle-1.warned" ] &&
     [ -e "$sd/devserver-$P_main-$lp_main.start" ]; then
    ok "[$label] the stamps of an earlier server on :$P_main go, another port's stay"
  else
    ko "[$label] the stamps of an earlier server on :$P_main go, another port's stay" \
      "exit=$rc state: $(ls "$sd" | tr '\n' ' ')"
  fi

  mkdir -p "$base/$label/symtmp" "$base/$label/elsewhere"
  ln -s "$base/$label/elsewhere" "$base/$label/symtmp/hyperion-hooks-$(id -u)"
  run nav TMPDIR="$base/$label/symtmp"
  if [ "$rc" -eq 0 ] && [ -z "$out" ] && [ -z "$err" ] &&
     [ -z "$(ls -A "$base/$label/elsewhere")" ]; then
    ok "[$label] a state dir that is a symlink: silent, writes nothing through it ($ms ms)"
  else
    ko "[$label] a state dir that is a symlink: silent, writes nothing through it" \
      "exit=$rc stdout=$out stderr=$err written: $(ls -A "$base/$label/elsewhere" | tr '\n' ' ')"
  fi

  run malformed
  silent "malformed payload: silent, exit 0"

  run other
  silent "a tool it does not watch: silent"

  run nav HYPERION_SRC_DIR="$base/no-such-dir"
  silent "a source dir that does not exist: silent"

  run nav PATH="$base/nobin"
  silent "no jq on PATH: silent"

  # The start time comes from `ps -o etime=`: [[dd-]hh:]mm:ss, leading zeros
  # included (08 is not octal), or nothing at all when unreadable.
  esrc=$base/$label/etime-src
  mkdir -p "$esrc"
  now=$(date +%s)
  for c in "08:09 300 warns" "08:09 600 silent" "02:03:04 7000 warns" \
    "02:03:04 8000 silent" "1-00:00:00 80000 warns" "1-00:00:00 90000 silent" \
    "garbage 10 silent" "-5:00 10 silent" "1:2:3:4 10 silent"; do
    set -- $c
    touch_at $((now - $2)) "$esrc/x.ts"
    run nav PATH="$base/fakebin:$PATH" FAKE_ETIME="$1" HYPERION_SRC_DIR="$esrc"
    if [ "$3" = warns ]; then
      warns "etime $1, a file changed $2 s ago: warns" "1 file(s)"
    else
      silent "etime $1, a file changed $2 s ago: silent"
    fi
  done
  run nav PATH="$base/fakebin:$PATH" FAKE_ETIME= HYPERION_SRC_DIR="$esrc"
  silent "empty etime: silent"

  # The boundary, with the clock fixed: etime 01:40 at FAKE_NOW gives a
  # reported start S = now - 100, while the server really started somewhere in
  # (S - 1, S + 1). A file is counted only when newer than S + 1, so a file
  # written before the server started never is.
  for c in "-1 0 silent S-1" "0 9 silent S+0.9" "1 0 silent S+1" "1 5 warns S+1.5"; do
    set -- $c
    touch_frac $((now - 100 + $1)) "$2" "$esrc/x.ts"
    run nav PATH="$base/fakebin:$PATH" FAKE_ETIME=01:40 FAKE_NOW="$now" HYPERION_SRC_DIR="$esrc"
    case $4 in
      S-1) what="before the reported start" ;;
      S+0.9) what="possibly before the real start" ;;
      S+1) what="at the counted start itself" ;;
      *) what="after the real start" ;;
    esac
    if [ "$3" = warns ]; then
      warns "boundary: a file written at $4 ($what): warns" "1 file(s)"
    else
      silent "boundary: a file written at $4 ($what): silent"
    fi
  done
}

shown=
for s in $shells; do
  suite "$s" "$(command -v "$s")"
done

echo "guard-stale-devserver: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
