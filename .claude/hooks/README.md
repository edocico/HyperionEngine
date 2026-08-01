# Claude Code hooks

Hook scripts for this repo. Registered in [`../settings.json`](../settings.json) and invoked as
`bash "${CLAUDE_PROJECT_DIR}/.claude/hooks/<script>.sh"`.

Each script reads the hook payload as **JSON on stdin** (`jq -r '.tool_input.file_path'`) and
resolves the repo root from `$CLAUDE_PROJECT_DIR`, falling back to `.cwd` from the payload.

## Scripts

| Script | Event | Fires on | Behaviour |
|---|---|---|---|
| `guard-generated.sh` | PreToolUse | `Edit`/`Write` | **Blocks** edits under `ts/wasm/`, `ts/wasm-physics/`, `ts/loro-spike-wasm/`, `ts/rapier-spike-wasm/` — wasm-pack overwrites these. |
| `guard-protocol-drift.sh` | PreToolUse | `Bash` containing `git commit` | **Blocks** the commit when the Rust and TypeScript command tables disagree. |
| `post-edit-rust.sh` | PostToolUse | `*.rs` | Runs `cargo clippy -p hyperion-core`; warns when `cfg(feature = ...)` code was touched. |
| `post-edit-ts.sh` | PostToolUse | `ts/src/**/*.ts` | Runs the colocated `*.test.ts` via vitest. |
| `post-edit-notices.sh` | PostToolUse | various | Surfaces cross-cutting invariants no compiler checks (WGSL bind groups, protocol files, physics, structural files). |

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

## Notes

- Settings changes are picked up by the file watcher; no restart needed.
- Hooks matching the same event run **in parallel** and cannot see each other's output. The three
  PostToolUse scripts are split by cost so the fast notices are not serialised behind clippy/vitest.
- `post-edit-rust.sh` deliberately omits `--all-targets`: it surfaces a long-standing dead-code
  warning in test-only helpers that would make the hook fire on every single Rust edit.
- All scripts ignore files outside `$CLAUDE_PROJECT_DIR`, so scratchpad and `/tmp` edits are silent.
