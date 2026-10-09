# Claude Code hooks

Hook scripts for this repo. Registered in [`../settings.json`](../settings.json) and invoked as
`bash "${CLAUDE_PROJECT_DIR}/.claude/hooks/<script>.sh"`.

Each script reads the hook payload as **JSON on stdin** (`jq -r '.tool_input.file_path'`) and
resolves the repo root from `$CLAUDE_PROJECT_DIR`, falling back to `.cwd` from the payload.
`keep-awake.sh` needs neither: it only drains stdin.

## Scripts

| Script | Event | Fires on | Behaviour |
|---|---|---|---|
| `guard-generated.sh` | PreToolUse | `Edit`/`Write` | **Blocks** edits under `ts/wasm/`, `ts/wasm-physics/`, `ts/loro-spike-wasm/`, `ts/rapier-spike-wasm/` — wasm-pack overwrites these. |
| `guard-protocol-drift.sh` | PreToolUse | `Bash` containing `git commit` | **Blocks** the commit when the Rust and TypeScript command tables disagree. |
| `post-edit-rust.sh` | PostToolUse | `*.rs` | Runs `cargo clippy -p hyperion-core`; warns when `cfg(feature = ...)` code was touched. |
| `guard-stale-wasm.sh` | PreToolUse | chrome-devtools `navigate_page` | **Advisory.** Adds context when `ts/wasm/hyperion_core_bg.wasm` is older than `crates/hyperion-core/src` (by mtime, as cargo decides — a checkout also trips it). |
| `guard-stale-devserver.sh` | PreToolUse | chrome-devtools `navigate_page`/`evaluate_script` | **Advisory.** Adds context when this checkout's Vite dev server started before a `*.ts`/`*.wgsl` under `ts/src` changed: a page script's `import('/src/…')` may get a second module instance, and `?raw` imports may be stale. `navigate_page` warns every time; `evaluate_script` once per batch of edits. |
| `keep-awake.sh` | PreToolUse | `Workflow` | **Side effect, macOS only.** Starts a detached `caffeinate -dimsu -w <Claude Code pid>`, once per Claude Code process (concurrent calls included), so a Mac on battery (`pmset sleep 1`) does not sleep through a long workflow. One line of context when it starts one. |
| `post-edit-ts.sh` | PostToolUse | `ts/src/**/*.ts` | Runs the colocated `*.test.ts` via vitest. A failure after editing the test file itself is returned as context (exit 0, the expected TDD RED); after a source edit it is an error (exit 2). |
| `post-edit-notices.sh` | PostToolUse | various | Surfaces cross-cutting invariants no compiler checks: WGSL by path (the primitive prelude — the only bindings, composed into 7 modules; a primitive library — prefixes, no bindings or entry points; any other shader — its pass's layout), protocol files, physics, structural files. |
| `guard-doc-shrink.sh` | PostToolUse | `Bash`/`Edit`/`Write` | Warns when a `*.md` lost ≥ `DOC_SHRINK_MIN` (40) lines and more than twice what it gained — in the working tree, and in the commit just made when the command was `git commit`/`git merge`. Each distinct finding is reported once (state in `.git/claude-doc-shrink-seen`). |

## Exit-code contract

- `0` — success, nothing to say. Stdout goes to the transcript.
- `2` — **PreToolUse: blocks the call.** **PostToolUse: the tool already ran**, stderr is fed back to Claude as feedback.
- anything else — non-blocking error.

The PostToolUse scripts exit `2` when they have a finding and `0` silently otherwise, so a clean
edit produces no noise at all.

## The drift guard

`guard-protocol-drift.sh` is the only *blocking* check. It parses `Name = N,` pairs out of the
`CommandType` enum body in both `crates/hyperion-core/src/ring_buffer.rs` and
`ts/src/ring-buffer.ts`, then refuses the commit if any of these hold:

- a variant exists on one side but not the other
- `MAX_COMMAND_TYPE` differs between `ring_buffer.rs` and `backpressure.ts`
- `MAX_COMMAND_TYPE` is not exactly one past the highest discriminant

**Why blocking rather than advisory:** the failure it prevents is silent. An opcode the consumer
does not recognise causes `drain()` to resync `read_head` to `write_head`, discarding every
remaining command in that batch. The symptom is entities that stop responding, which reads as a
renderer bug. Nothing in either toolchain catches it.

Bypass for one commit:

```bash
touch .claude/.skip-drift-guard
```

The flag is **consumed on use** — the next commit is guarded again.

The guard **fails open**: if either enum body fails to parse, or the files are missing, it exits 0
rather than blocking every commit. It is a backstop, not a substitute for the tests.

## Testing a hook

Hooks take JSON on stdin, so they can be exercised directly:

```bash
printf '%s' '{"tool_name":"Edit","tool_input":{"file_path":"'"$PWD"'/ts/wasm/x.js"}}' \
  | CLAUDE_PROJECT_DIR="$PWD" bash .claude/hooks/guard-generated.sh; echo "exit=$?"
```

Verify a hook by making it **fire**, not by observing silence — a script that fails early exits
non-zero with no output, which is indistinguishable from "ran clean". That is exactly how the
previous generation of hooks in this repo went unnoticed: they used `grep -oP` (unsupported by
macOS `/usr/bin/grep`) and `cd` to a hardcoded Linux path, so all six were silent no-ops.

[`tests/`](tests/) holds hermetic POSIX-sh tests that prove a hook both fires and stays silent.
Each runs the hook under every shell installed among `sh`, `dash` and `bash` (or the ones named
in `HOOK_SHELLS`), prints one `PASS`/`FAIL` line per case and exits non-zero on any failure:

```bash
sh .claude/hooks/tests/guard-stale-devserver.test.sh
sh .claude/hooks/tests/keep-awake.test.sh
```

## The two 2026-09-26 guards

`guard-doc-shrink.sh` exists because a scripted "rewrite from an anchor" dropped 142 lines of the
Phase 17 design doc and nothing said so (`714a8cf`, `+12 -141`). Replayed over the whole branch it
flags that commit and nothing else. `guard-stale-wasm.sh` exists because a GPU check after a Rust
change exercises the old engine until `npm --prefix ts run build:wasm` runs; the harness build has
no `physics-2d` at all.

## The dev-server guard and keep-awake (2026-10-09)

Both are POSIX `sh` (BSD and GNU userlands), registered through `bash` like the others, and both
always exit `0`.

**`guard-stale-devserver.sh`** exists because Vite does not always serve what is on disk. After a
checkout that rewrote a shader, the browser kept the old `?import&raw` transform (2026-09-27). After
any edit, the app imports the edited module as `?t=…`, so a page script's `import('/src/…')` by
the bare URL gets a second module instance: the step-6 bench read
`LightAccumStage.SHADER_SOURCE` as `''`. CLAUDE.md's remedy is to restart the dev server.

- The dev server is the process listening on the port (`lsof`, else `ss`) whose command line runs
  Vite: a program or script called `vite` or `vite.js`, by the ERE `(^|[/ ])vite(\.js)?( |$)`. A
  bare `vite` substring would match every `node` on the Mac, which runs as
  `~/.vite-plus/js_runtime/node/<v>/bin/node` (the Vite+ shim).
- It must also be this checkout's, by the rule of `gpu-infra.sh`'s `is_repo_vite`: its command
  line names `<root>/ts/` (`npm --prefix ts run dev` runs `node <root>/ts/node_modules/.bin/vite`),
  or it runs in `<root>/ts` or below (`/proc/<pid>/cwd`, else `lsof -d cwd`). Both spellings of the
  root count, as given and with its symlinks resolved. Another checkout's Vite (the main checkout
  and a worktree cannot both hold 5173) gets no warning: this tree's edits do not make it stale,
  and the advice to stop it would hit a server another session uses.
- The port is the explicit one in a `navigate_page` http(s) URL (the scheme in any case, leading
  zeros dropped), else 5173: a URL without a port, a reload or back/forward, and every
  `evaluate_script` check 5173, as does `gpu-infra.sh`'s Vite (`--strictPort --port 5173`).
- Its start is `now − ps -o etime=` plus one second, because both ends are truncated to the
  second. A file written just before the server started therefore never counts.
- A changed file is a `*.ts`/`*.wgsl` under `ts/src` modified after that start, except
  `*.test.ts`, `*.fixture.ts` (test-only: no app module imports one) and `*.d.ts` (never served).
  The message names up to three, newest first.
- `evaluate_script` warns only when a file changed after the last warning for that server pid.
  The last warning is kept as a stamp in `${TMPDIR:-/tmp}/hyperion-hooks-<uid>/`; a new server on
  the port drops the old one's stamps.
- It is silent when it cannot tell: no `jq`, neither `lsof` nor `ss`, nothing listening, a
  listener that is not Vite or is another checkout's, an unreadable start time, a malformed
  payload, a state dir that is a symlink or not the user's.
- Overrides: `HYPERION_DEVSERVER_PORT`, `HYPERION_DEVSERVER_PATTERN` (the ERE above),
  `HYPERION_SRC_DIR` (default `$CLAUDE_PROJECT_DIR/ts/src`).
- Cost on this repo (148 watched files), measured on the Mac with `sh`, `dash` and `bash`:
  36–40 ms with nothing listening; 58–65 ms with a Vite named by its command line, 75–82 ms when
  the working-directory rule needs its extra `lsof`; 77–102 ms when it warns.

**`keep-awake.sh`** exists because this Mac sleeps after one idle minute on battery
(`pmset sleep 1`), and a sleep kills the in-flight agent requests of a long workflow. Before a
`Workflow` call it starts `nohup caffeinate -dimsu -w <pid>`, fully detached: stdio on
`/dev/null`, adopted by launchd once the hook exits, and in a session of its own
(`perl -MPOSIX`'s `setsid`, when perl is there). Claude Code runs each hook as a process-group
leader, and a signal it sends to that group on an abort or a timeout must not reach the
caffeinate. The caffeinate keeps the system and the display awake, which GPU sessions need, and
ends with that process: that is the whole life of the Claude Code process, idle stretches
included, not only the workflow.

- Claude Code is the first ancestor, walking up from `$PPID` for at most 15 levels, whose command
  line names it: a program called `claude`, a path containing `claude-code`, or a binary under
  `claude/versions/`.
- A plain "claude" substring would be wrong. The hook runner's own command line holds
  `.claude/hooks/…` and `${CLAUDE_PROJECT_DIR}`, and a caffeinate waiting on the runner would end
  with the hook. So any command naming `/.claude/hooks/` is skipped. The Bash tool's shell
  (`~/.claude/shell-snapshots/…`) and scratch paths (`/tmp/claude-501/…`) say "claude" too, but
  name no program called `claude`. The test's walk case runs the hook through both.
- It does not start a second caffeinate for the same pid (one exception below). One assistant message can hold several
  `Workflow` calls, whose hooks run concurrently, and `pgrep -f` cannot see a caffeinate that
  another call is still launching. So the check and the start hold a lock,
  `keep-awake-<pid>.lock` in the state dir above, released once the new caffeinate shows in `ps`.
  A call waits up to 2 s for it, and takes over a lock held longer (its hook died holding it).
  The exception: two calls taking over a dead hook's lock at the same instant can both launch;
  harmless, since both caffeinates end with the same pid.
  It never looks at any other caffeinate.
- When no Claude Code process is found, it falls back to `caffeinate -dimsu -t 14400` (4 hours).
  The pid is recorded in the state dir above, and the next call starts another only once that one
  has exited or used up a quarter of its time.
- Off macOS it does nothing.
- Overrides: `KEEP_AWAKE_PID` (the pid to wait on), `KEEP_AWAKE_PATTERN` (case-insensitive ERE that
  names Claude Code), `KEEP_AWAKE_CAP` (seconds of the fallback).
- Cost, measured on the Mac: about 80 ms when it starts a caffeinate, 50 ms when one already
  waits; five concurrent calls take about 290 ms in all.

## Notes

- Settings changes are picked up by the file watcher; no restart needed.
- Hooks matching the same event run **in parallel** and cannot see each other's output. The three
  PostToolUse scripts are split by cost so the fast notices are not serialised behind clippy/vitest.
- `post-edit-rust.sh` deliberately omits `--all-targets`: it surfaces a long-standing dead-code
  warning in test-only helpers that would make the hook fire on every single Rust edit.
- All scripts ignore files outside `$CLAUDE_PROJECT_DIR`, so scratchpad and `/tmp` edits are silent.
