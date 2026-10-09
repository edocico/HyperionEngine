#!/bin/sh
# gpu-infra.sh - the processes of a GPU bench session on the harness, as one
# unit: caffeinate (macOS only), a FRESH Vite dev server on :5173, and
# asset-server.py on 127.0.0.1:8765. .claude/skills/gpu-check/SKILL.md,
# "Bench session". POSIX sh, macOS and Linux.
#
#   gpu-infra.sh up [asset-server.py args...]
#   gpu-infra.sh down
#   gpu-infra.sh status
#
#   e.g. gpu-infra.sh up --git /old-light-accum.wgsl=1d19575:ts/src/shaders/light-accum.wgsl
#
# The repo is the CODE UNDER TEST: $HYPERION_ROOT, else $CLAUDE_PROJECT_DIR
# (when set, the checkout the Claude session was opened on, which need not be
# the worktree you work in), else the checkout this script is in. Vite serves
# $ROOT/ts, so the page runs $ROOT's ts/src and ts/wasm, and the asset
# server's default root is $ROOT/docs/plans/assets. To check a worktree's
# change, serve the worktree: it needs its own ts/node_modules (npm --prefix ts
# ci) and ts/wasm (npm --prefix ts run build:wasm). HYPERION_ROOT=<another
# checkout> runs THAT checkout's code, and serves its benches: right only when
# the app code does not matter, as in a check of these scripts.
# State: ${TMPDIR:-/tmp}/hyperion-gpu-infra-<uid>: per service a pid file
# (NAME.pid, and NAME.start, its start time, against pid reuse) and the logs
# vite.log and asset-server.log. It follows TMPDIR: run down and status with
# the TMPDIR of up (the last line of up prints that command). $PYTHON
# (default python3) runs the asset server.
#
# up      Checks first, and changes nothing when a check fails: the asset
#         server's arguments (asset-server.py --check), $ROOT/ts/node_modules,
#         and the two ports, free or held by this repo's vite / this script's
#         asset server (anything else: exit 1). Then (1) macOS: caffeinate
#         -dimsu -t 28800, detached, unless the recorded one still runs;
#         (2) Vite fresh: this repo's vite on :5173 stopped (TERM, KILL after
#         10 s), `npm --prefix $ROOT/ts run dev -- --strictPort --port 5173`
#         started detached, until http://localhost:5173/ answers (60 s) with
#         COOP and COEP; (3) the asset server restarted with the given
#         arguments, until it answers (30 s). A failure in (1)-(3) stops
#         everything recorded, as down does, and exits 1. Run twice: Vite and
#         the asset server restart, caffeinate stays. Its summary notes a
#         $ROOT other than the checkout of this script, and a $ROOT/ts/wasm
#         that is missing or older than the Rust sources (SKILL.md section 1).
#         Worst case about 3 minutes (each stop waits up to 13 s, Vite up to
#         60 s, the asset server 30 s): give the Bash call a 300000 ms timeout.
# down    Stops exactly the recorded processes (TERM, KILL after 10 s), each
#         re-checked first against its expected command and start time: a pid
#         that now runs something else is left alone. Removes the pid files.
#         With nothing recorded it does nothing.
# status  Per service: running or not, its pid, whether its port listens.
#         Exit 0 when every service runs, 3 otherwise.
# The HTTP probes ignore any proxy variable (curl --noproxy '*').

set -u

VITE_PORT=5173
ASSET_PORT_DEFAULT=8765
CAFFEINATE_SECONDS=28800
PYTHON=${PYTHON:-python3}

say() { printf '%s\n' "$*"; }
warn() { printf 'gpu-infra: %s\n' "$*" >&2; }
die() { warn "error: $*"; exit 1; }
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

HERE=$(CDPATH= cd "$(dirname "$0")" && pwd -P) || exit 1
if [ -n "${HYPERION_ROOT:-}" ]; then ROOT_IN=$HYPERION_ROOT; ROOT_FROM='$HYPERION_ROOT'
elif [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then ROOT_IN=$CLAUDE_PROJECT_DIR; ROOT_FROM='$CLAUDE_PROJECT_DIR'
else ROOT_IN=$HERE/../../../..; ROOT_FROM='the checkout of this script'
fi
ROOT=$(CDPATH= cd "$ROOT_IN" 2>/dev/null && pwd -P) || die "repo root not found: $ROOT_IN"
SELF_ROOT=$(CDPATH= cd "$HERE/../../../.." 2>/dev/null && pwd -P) || SELF_ROOT=
TMPBASE=${TMPDIR:-/tmp}
STATE=${TMPBASE%/}/hyperion-gpu-infra-$(id -u)

# --- the state directory: ours alone (not a link, owned by us, mode 700) ---
state_ok() { [ -d "$STATE" ] && [ ! -L "$STATE" ] && [ -O "$STATE" ]; }
state_exists() { [ -e "$STATE" ] || [ -L "$STATE" ]; }
make_state() {
  (umask 077 && mkdir -p "$STATE") 2>/dev/null
  state_ok || die "$STATE is not a directory of yours: remove it, or set TMPDIR"
  chmod 700 "$STATE"
}

# --- processes and ports ---
# -ww: procps-ng (Linux) cuts the args column at $COLUMNS even into a pipe, and
# the checks below match paths that run past 80 columns.
proc_args() { ps -ww -o args= -p "$1" 2>/dev/null; }
proc_start() {  # $1 pid: its start, the same for its whole life whatever the env (against pid reuse)
  if [ -r "/proc/$1/stat" ]; then
    # Linux: field 22 of /proc/PID/stat, the start in clock ticks after boot
    # (procps derives lstart from a boot time that moves with the wall clock).
    # Field 2, the command name, may hold spaces and ')': count from the last ') '.
    sed -n 's/.*) //p' "/proc/$1/stat" 2>/dev/null | awk '{ print "ticks " $20 }'
  else
    # macOS: lstart is local time, so pin the zone and the locale: a down or a
    # status with another TZ than up's must see the same string.
    TZ=UTC0 LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'
  fi
}
proc_alive() {  # a zombie counts as gone
  kill -0 "$1" 2>/dev/null || return 1
  case $(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ') in ''|Z*) return 1 ;; esac
  return 0
}
proc_cwd() {
  if [ -d "/proc/$1" ]; then readlink "/proc/$1/cwd" 2>/dev/null
  elif command -v lsof >/dev/null 2>&1; then lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | sed -n '1p'
  fi
}
listeners() {  # $1 port: the pids listening on it, one per line
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u
  elif command -v ss >/dev/null 2>&1; then
    ss -Hltnp "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
  fi
}
answers() {  # $1 URL: does an HTTP server answer there (any status)? Never through a proxy.
  _an_code=$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' --max-time 2 "$1" 2>/dev/null)
  [ -n "$_an_code" ] && [ "$_an_code" != 000 ]
}
port_state() {  # $1 port, $2 URL
  _ps_pids=$(listeners "$1" | tr '\n' ' ' | sed 's/ *$//')
  if [ -n "$_ps_pids" ]; then say "listening (pid $_ps_pids)"
  elif answers "$2"; then say "listening"
  else say "free"
  fi
}
is_repo_vite() {  # $1 pid: a vite of $ROOT/ts, by its command line or its cwd?
  _rv_args=$(proc_args "$1")
  # A program called vite, not any argv holding "vite": on the Mac every node runs
  # from the Vite+ shim (~/.vite-plus/js_runtime/node/...).
  printf '%s\n' "$_rv_args" | grep -Eq '(^|[/ ])vite(\.js)?( |$)' || return 1
  case $_rv_args in *"$ROOT/ts/"*) return 0 ;; esac
  _rv_cwd=$(proc_cwd "$1")
  case $_rv_cwd in "$ROOT/ts"|"$ROOT/ts/"*) return 0 ;; esac
  return 1
}
is_our_asset_server() {  # $1 pid: this script's asset-server.py?
  case $(proc_args "$1") in *"$HERE/asset-server.py"*) return 0 ;; esac
  return 1
}

# --- recorded services: caffeinate, vite (the listener), vite-launcher (npm), asset-server ---
read_pid() {
  [ -f "$STATE/$1.pid" ] || return 0
  _rp_pid=$(sed -n '1p' "$STATE/$1.pid")
  case $_rp_pid in ''|*[!0-9]*) ;; *) say "$_rp_pid" ;; esac
}
record() { say "$2" > "$STATE/$1.pid"; proc_start "$2" > "$STATE/$1.start"; }
forget() { rm -f "$STATE/$1.pid" "$STATE/$1.start"; }
expected() {  # $1 service, $2 pid: still the process that was recorded?
  _ex_args=$(proc_args "$2")
  case $1:$_ex_args in
    caffeinate:*"caffeinate -dimsu -t $CAFFEINATE_SECONDS") ;;
    vite:*vite*) ;;
    vite-launcher:*npm*) ;;
    asset-server:*asset-server.py*) ;;
    *) return 1 ;;
  esac
  [ ! -s "$STATE/$1.start" ] || [ "$(proc_start "$2")" = "$(cat "$STATE/$1.start")" ]
}
running() {  # $1 service: prints its pid while the recorded process runs
  _rn_pid=$(read_pid "$1")
  [ -n "$_rn_pid" ] && proc_alive "$_rn_pid" && expected "$1" "$_rn_pid" && say "$_rn_pid"
}
stop_pid() {  # $1 pid: TERM, KILL after 10 s; prints how it ended
  kill -TERM "$1" 2>/dev/null || { say "had already exited"; return 0; }
  _sp_i=0
  while proc_alive "$1"; do
    if [ "$_sp_i" -ge 10 ]; then
      kill -KILL "$1" 2>/dev/null
      _sp_j=0
      while proc_alive "$1" && [ "$_sp_j" -lt 3 ]; do sleep 1; _sp_j=$((_sp_j + 1)); done
      if proc_alive "$1"; then say "still running after KILL"; return 1; fi
      say "stopped (KILL after 10 s)"
      return 0
    fi
    sleep 1
    _sp_i=$((_sp_i + 1))
  done
  say "stopped"
}
stop_service() {  # $1 service: stops the recorded process; returns 1 when none was recorded
  _ss_pid=$(read_pid "$1")
  if [ -z "$_ss_pid" ]; then forget "$1"; return 1; fi
  if ! proc_alive "$_ss_pid"; then
    say "  $1: pid $_ss_pid had already exited"
  elif ! expected "$1" "$_ss_pid"; then
    say "  $1: pid $_ss_pid now runs something else, left alone: $(proc_args "$_ss_pid")"
  else
    say "  $1: pid $_ss_pid $(stop_pid "$_ss_pid")"
  fi
  forget "$1"
  return 0
}
wait_port_free() {  # $1 port: up to 10 s for no listener
  _wf_i=0
  while [ -n "$(listeners "$1")" ]; do
    [ "$_wf_i" -lt 10 ] || return 1
    sleep 1
    _wf_i=$((_wf_i + 1))
  done
}
asset_port() {  # the --port among the asset server's arguments
  _ap_port=$ASSET_PORT_DEFAULT
  while [ $# -gt 0 ]; do
    case $1 in
      --port) if [ $# -ge 2 ]; then _ap_port=$2; shift; fi ;;
      --port=*) _ap_port=${1#--port=} ;;
    esac
    shift
  done
  say "$_ap_port"
}
shq() {  # $1 as one single-quoted shell word
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}
down_command() {  # the down that finds this state: the same TMPDIR
  say "TMPDIR=$(shq "$TMPBASE") sh $(shq "$HERE/gpu-infra.sh") down"
}
root_notes() {  # what to know about the code under test, one line each
  if [ -n "$SELF_ROOT" ] && [ "$ROOT" != "$SELF_ROOT" ]; then
    say "the page runs the code of $ROOT (from $ROOT_FROM), not of $SELF_ROOT, the checkout of this script"
  fi
  _no_w=$ROOT/ts/wasm/hyperion_core_bg.wasm
  if [ ! -f "$_no_w" ]; then
    say "$_no_w is missing, so the harness cannot load the engine: npm --prefix $ROOT/ts run build:wasm, then up again (SKILL.md section 1)"
    return 0
  fi
  _no_new=$(find "$ROOT/crates/hyperion-core/src" "$ROOT/crates/hyperion-core/Cargo.toml" -newer "$_no_w" \( -name '*.rs' -o -name Cargo.toml \) 2>/dev/null | sed -n '1p')
  if [ -n "$_no_new" ]; then
    say "$ROOT/ts/wasm is older than $_no_new: npm --prefix $ROOT/ts run build:wasm, then up again, unless only mtimes changed (SKILL.md section 1)"
  fi
  return 0
}

# --- commands ---
do_down() {
  if ! state_exists; then
    say "gpu-infra down: nothing recorded ($STATE does not exist; the state follows TMPDIR: run down with the TMPDIR of up)"
    return 0
  fi
  state_ok || die "$STATE is not a directory of yours: touching nothing"
  say "gpu-infra down (state $STATE)"
  _dn_n=0
  for _dn_s in asset-server vite vite-launcher caffeinate; do
    if stop_service "$_dn_s"; then _dn_n=$((_dn_n + 1)); fi
  done
  rm -f "$STATE/asset-server.port"
  [ "$_dn_n" -gt 0 ] || say "  nothing recorded"
  return 0
}

fail_up() {  # $1 message, $2 a log to show: stops everything recorded, exits 1
  warn "error: $1"
  if [ -n "${2:-}" ] && [ -s "$2" ]; then
    warn "the last lines of $2:"
    tail -n 20 "$2" >&2
  fi
  warn "up failed: stopping what is recorded"
  do_down >&2
  exit 1
}

do_up() {
  # Checks: nothing changes when one fails.
  for _up_t in curl npm ps "$PYTHON"; do
    command -v "$_up_t" >/dev/null 2>&1 || die "$_up_t is not on PATH"
  done
  command -v lsof >/dev/null 2>&1 || command -v ss >/dev/null 2>&1 || die "lsof or ss is needed, to see who listens on a port"
  [ -f "$ROOT/ts/package.json" ] || die "$ROOT has no ts/package.json: not the Hyperion repo (set HYPERION_ROOT)"
  [ -e "$ROOT/ts/node_modules/.bin/vite" ] || die "$ROOT/ts/node_modules has no vite (a fresh worktree has none). $ROOT is the code under test (from $ROOT_FROM): to check it, npm --prefix $ROOT/ts ci, and npm --prefix $ROOT/ts run build:wasm if ts/wasm is missing. HYPERION_ROOT=<another checkout> would run THAT checkout's code, right only when the app code does not matter"
  for _up_a in "$@"; do
    case $_up_a in -h|--help) die "the asset server's options: $PYTHON $HERE/asset-server.py --help" ;; esac
  done
  make_state
  APORT=$(asset_port "$@")
  CHECK=$(HYPERION_ROOT=$ROOT "$PYTHON" "$HERE/asset-server.py" --check "$@" 2>&1) || die "the asset server's arguments: $CHECK"
  for _up_p in $(listeners "$VITE_PORT"); do
    is_repo_vite "$_up_p" || die "port $VITE_PORT is held by pid $_up_p, not a vite of $ROOT/ts: $(proc_args "$_up_p")"
  done
  if [ -z "$(listeners "$VITE_PORT")" ] && answers "http://localhost:$VITE_PORT/"; then
    die "a server lsof/ss cannot see answers on :$VITE_PORT"
  fi
  _up_rec=$(running asset-server)
  for _up_p in $(listeners "$APORT"); do
    [ "$_up_p" = "$_up_rec" ] || is_our_asset_server "$_up_p" ||
      die "port $APORT is held by pid $_up_p, not this script's asset server: $(proc_args "$_up_p")"
  done
  if [ -z "$(listeners "$APORT")" ] && answers "http://127.0.0.1:$APORT/"; then
    die "a server lsof/ss cannot see answers on :$APORT"
  fi

  say "gpu-infra up (root $ROOT, state $STATE)"
  # (1) caffeinate: the display and the system stay awake (a dark display stops requestAnimationFrame).
  if [ "$(uname -s)" = Darwin ]; then
    _up_caf=$(running caffeinate)
    if [ -n "$_up_caf" ]; then
      _up_caf="pid $_up_caf, kept"
    else
      forget caffeinate
      # Launched from a command substitution: orphaned at once, so never a job of
      # this shell (no "Terminated" notice when fail_up stops it, no zombie).
      _up_caf=$(nohup caffeinate -dimsu -t "$CAFFEINATE_SECONDS" </dev/null >/dev/null 2>&1 & echo "$!")
      record caffeinate "$_up_caf"
      _up_caf="pid $_up_caf, started (-dimsu -t $CAFFEINATE_SECONDS)"
    fi
  else
    _up_caf="not macOS: none"
  fi
  say "  caffeinate: $_up_caf"

  # (2) Vite, fresh: a page script's import('/src/...') must get the app's own module instance.
  stop_service vite
  stop_service vite-launcher
  for _up_p in $(listeners "$VITE_PORT"); do
    if is_repo_vite "$_up_p"; then say "  vite: pid $_up_p (not recorded) $(stop_pid "$_up_p")"; fi
  done
  wait_port_free "$VITE_PORT" || fail_up "port $VITE_PORT is still in use"
  : > "$STATE/vite.log"
  _up_launcher=$( (CDPATH= cd "$ROOT" && exec nohup npm --prefix "$ROOT/ts" run dev -- --strictPort --port "$VITE_PORT") \
    </dev/null >>"$STATE/vite.log" 2>&1 & echo "$!")
  record vite-launcher "$_up_launcher"
  _up_deadline=$(( $(date +%s) + 60 ))
  while :; do
    _up_code=$(curl --noproxy '*' -s -o /dev/null -D "$STATE/vite.headers" -w '%{http_code}' --max-time 5 "http://localhost:$VITE_PORT/" 2>/dev/null)
    [ "$_up_code" = 200 ] && break
    proc_alive "$_up_launcher" || fail_up "Vite exited before answering on :$VITE_PORT" "$STATE/vite.log"
    [ "$(date +%s)" -lt "$_up_deadline" ] || fail_up "Vite did not answer on :$VITE_PORT within 60 s" "$STATE/vite.log"
    sleep 1
  done
  _up_coop=$(grep -i '^cross-origin-opener-policy:' "$STATE/vite.headers" | tr -d '\r' | sed 's/^[^:]*:[[:space:]]*//')
  _up_coep=$(grep -i '^cross-origin-embedder-policy:' "$STATE/vite.headers" | tr -d '\r' | sed 's/^[^:]*:[[:space:]]*//')
  if [ -z "$_up_coop" ] || [ -z "$_up_coep" ]; then
    fail_up "Vite answers without COOP and COEP (headers in $STATE/vite.headers): no SharedArrayBuffer, no harness"
  fi
  _up_vite=
  for _up_p in $(listeners "$VITE_PORT"); do
    if is_repo_vite "$_up_p"; then _up_vite=$_up_p; fi
  done
  [ -n "$_up_vite" ] || fail_up "no vite of $ROOT/ts listens on :$VITE_PORT" "$STATE/vite.log"
  record vite "$_up_vite"
  say "  vite: pid $_up_vite (launcher $_up_launcher), COOP $_up_coop, COEP $_up_coep"

  # (3) the asset server, restarted with these arguments.
  stop_service asset-server
  for _up_p in $(listeners "$APORT"); do
    if is_our_asset_server "$_up_p"; then say "  asset-server: pid $_up_p (not recorded) $(stop_pid "$_up_p")"; fi
  done
  wait_port_free "$APORT" || fail_up "port $APORT is still in use"
  : > "$STATE/asset-server.log"
  _up_asset=$(HYPERION_ROOT=$ROOT nohup "$PYTHON" "$HERE/asset-server.py" "$@" </dev/null >>"$STATE/asset-server.log" 2>&1 & echo "$!")
  record asset-server "$_up_asset"
  say "$APORT" > "$STATE/asset-server.port"
  _up_deadline=$(( $(date +%s) + 30 ))
  until answers "http://127.0.0.1:$APORT/"; do
    proc_alive "$_up_asset" || fail_up "the asset server exited" "$STATE/asset-server.log"
    [ "$(date +%s)" -lt "$_up_deadline" ] || fail_up "the asset server did not answer on 127.0.0.1:$APORT within 30 s" "$STATE/asset-server.log"
    sleep 1
  done
  say "  asset-server: pid $_up_asset"

  say "gpu-infra up: ready"
  say "  caffeinate    $_up_caf"
  say "  vite          pid $_up_vite  http://localhost:$VITE_PORT/  log $STATE/vite.log"
  say "  asset-server  pid $_up_asset  http://127.0.0.1:$APORT/  log $STATE/asset-server.log"
  say "$CHECK" | sed 's/^/    /'
  root_notes | sed 's/^/  note: /'
  say "  stop it all (status and down find this state only with this TMPDIR):"
  say "    $(down_command)"
}

do_status() {
  if state_exists; then state_ok || die "$STATE is not a directory of yours"; fi
  say "gpu-infra status (root $ROOT, state $STATE)"
  state_exists || say "  (no state at $STATE: if up ran with another TMPDIR, run status with that one)"
  _st_rc=0
  if [ "$(uname -s)" = Darwin ]; then
    _st_pid=$(running caffeinate)
    if [ -n "$_st_pid" ]; then say "  caffeinate    running, pid $_st_pid"
    else say "  caffeinate    not running"; _st_rc=3
    fi
  else
    say "  caffeinate    not macOS: none"
  fi
  _st_pid=$(running vite)
  _st_port=$(port_state "$VITE_PORT" "http://localhost:$VITE_PORT/")
  if [ -n "$_st_pid" ]; then
    _st_l=$(running vite-launcher)
    say "  vite          running, pid $_st_pid${_st_l:+ (launcher $_st_l)}, :$VITE_PORT $_st_port"
  else
    say "  vite          not running, :$VITE_PORT $_st_port"; _st_rc=3
  fi
  _st_aport=$(sed -n '1p' "$STATE/asset-server.port" 2>/dev/null)
  case $_st_aport in ''|*[!0-9]*) _st_aport=$ASSET_PORT_DEFAULT ;; esac
  _st_pid=$(running asset-server)
  _st_port=$(port_state "$_st_aport" "http://127.0.0.1:$_st_aport/")
  if [ -n "$_st_pid" ]; then say "  asset-server  running, pid $_st_pid, :$_st_aport $_st_port"
  else say "  asset-server  not running, :$_st_aport $_st_port"; _st_rc=3
  fi
  return "$_st_rc"
}

case ${1:-} in
  up) shift; do_up "$@" ;;
  down) [ $# -le 1 ] || die "down takes no arguments"; do_down ;;
  status) [ $# -le 1 ] || die "status takes no arguments"; do_status; exit $? ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
