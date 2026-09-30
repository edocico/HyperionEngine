---
name: close-phase
description: Close out an engine development phase — run the full feature matrix, refresh every stale count in CLAUDE.md, append the phase record to MEMORY.md, and stage the commit. Use when a phase's implementation is done and validated.
disable-model-invocation: true
---

Close a completed phase. The user should specify which phase (e.g. "Phase 16", "Phase 15e").

`/start-phase` opens a phase; this closes it. The stale constants and contradictory bullets that accumulate in CLAUDE.md are the residue of phases that ended without this pass.

## 1. Confirm the work is actually done

```bash
git status --short
git log --oneline master..HEAD
```
Every deliverable from the phase plan in `docs/plans/` should be committed. If anything is still dirty, stop and finish it — this skill records reality, it does not create it.

## 2. Validate

```bash
scripts/preflight.sh
```

`scripts/preflight.sh` is the single definition of "validated" — do not reconstruct the
command list here. It runs the whole feature matrix, which matters because the crate has
four features and the `process_commands` signature is **cfg-conditional**: code can
compile under one combination and break another.

This is the gate. It must be green before you continue.

## 3. Harvest the counts

Separate job, separate commands. Preflight tells you *whether* the suite passes; it does
not report per-combination totals, and those are what the docs record. Run these **for the
numbers**, not to validate:

```bash
cargo test -p hyperion-core
cargo test -p hyperion-core --features dev-tools
cargo test -p hyperion-core --features physics-2d
cargo test -p hyperion-core --all-features
cd ts && npm test
```

**Record the real numbers.** Two traps:

- **`cargo test` prints one summary per test binary.** The crate has a lib binary plus seven integration binaries (`tests/verify_*.rs`). The headline number is the **sum**, not the lib line. Sum them mechanically:
  ```bash
  cargo test -p hyperion-core [--features X] 2>/dev/null \
    | grep -oE '^test result: ok\. [0-9]+ passed' | grep -oE '[0-9]+' | paste -sd+ - | bc
  ```
- **`--all-features` and `--features "physics-debug dev-tools"` are the same build** — `physics-debug` implies `physics-2d`, so cargo emits identical binary hashes. They will always report the same number; document one figure for both.

Integration files only run under the features that gate them: `verify_physics.rs` needs `physics-2d`, `verify_snapshot.rs` needs `dev-tools`. Under the default build both report 0.

## 4. Refresh the counts in CLAUDE.md

Every `(N tests)` comment in the Build & Test Commands section, plus the regression-suite figure in the audit table.

⚠️ **State which number each claim means.** CLAUDE.md has historically mixed conventions — printing a lib-only count next to a bare `cargo test` invocation that actually reports the whole-suite total. Pick one convention per line and make the comment say which.

Per-file vitest counts (the `# e.g. X (N tests)` comments) are best refreshed from JSON rather than the TTY output:
```bash
cd ts && npx vitest run --reporter=json --outputFile=/tmp/vitest.json
node -e "const r=require('/tmp/vitest.json');for(const t of r.testResults)console.log(t.name,t.assertionResults.length)"
```

## 5. Update the CLAUDE.md architecture tables

For every module the phase created or changed:
- add/refresh its row in the crate table or the `ts/src/` tables
- update any enum variant count, WASM export list, or byte-size claim the phase moved
- add new WGSL shaders to the shader table
- add new `ts/src/index.ts` exports to the barrel-export row

## 6. Add the phase to the Implementation Status table

Append a row: phase number, name, key additions. Update the **Current:** line at the top of that section to name this phase and propose the next candidates.

## 7. Run the claude-md-auditor agent

```
claude-md-auditor
```
It mechanically re-checks constants, enum counts, test counts, symbol inventories and — critically — **CLAUDE.md's internal self-consistency**. Fix everything it reports before committing.

Pay particular attention to its *contradiction* findings. When a remediation pass appends a corrected bullet instead of editing the original, both survive and future sessions read whichever they hit first. **Delete the superseded bullet rather than editing it**, so the contradiction cannot re-form.

## 8. Update MEMORY.md

`~/.claude/projects/<slug>/memory/`, where `<slug>` is the working directory (the repo root) with every non-alphanumeric character replaced by `-`: `pwd | sed 's|[^A-Za-z0-9]|-|g'`. Compute it on the machine you are on instead of copying one: on Linux it is `-home-edoardocicognani-Code-HyperionEngine`, on the Mac `-Users-edoardocicognani-Code-HyperionEngine`. A clone that was moved leaves its old slug behind with the old memory, so check that `ls -d ~/.claude/projects/<slug>/memory` exists before writing to it.

⚠️ **The per-phase test-count lines in MEMORY.md are historical records pinned to a commit. Do NOT rewrite them to today's numbers.** A line like `| 12 | COMPLETE (cd56fdd) | 110 Rust, 632 TS |` documents what was true at `cd56fdd`. Rewriting it destroys the record and makes the progression meaningless.

**Append** a new phase section with today's numbers instead. Keep the `MEMORY.md` index to one line per memory — it is loaded every session, and it is already over its size budget, so put detail in a topic file and link it.

## 9. Documentation

- Move the phase plan in `docs/plans/` to its completed state, and note any design-doc errata the implementation uncovered (this repo has a strong track record of design docs diverging from what shipped — record the divergence rather than silently fixing the code to match).
- Update `PROJECT_ARCHITECTURE.md` if the phase changed a subsystem boundary.

## 10. Commit

```bash
git add -A
git commit
```

The commit is gated by `.claude/hooks/guard-protocol-drift.sh` if the phase touched the command protocol. If it blocks, fix both sides rather than bypassing — the bypass (`touch .claude/.skip-drift-guard`) exists for mid-refactor commits, not for closing a phase.

## Checklist

- [ ] `scripts/preflight.sh` green (feature matrix + clippy + TypeScript + protocol check)
- [ ] Test counts in CLAUDE.md refreshed, with the convention stated per line
- [ ] Architecture tables updated for every new/changed module
- [ ] Implementation Status row added, **Current:** line updated
- [ ] `claude-md-auditor` run and all findings resolved
- [ ] MEMORY.md **appended** (historical rows untouched)
- [ ] Phase plan doc updated with errata
- [ ] Committed
