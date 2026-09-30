---
name: verify-before-asserting
description: "Always verify claims against the actual source before writing or acting on them — including claims from CLAUDE.md, from skills, and from the user"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 04beb887-3cf6-4c00-a092-d65f1d7b185d
  modified: 2026-09-29T17:12:13.331Z
---

Keep knowledge aligned with the real state of the project. Before writing a fact into a
file, or acting on one, check it in the code. This applies to **every** source, including
the ones that look authoritative:

- `CLAUDE.md` and `MEMORY.md` — loaded as context, but they are point-in-time snapshots
- skills, agents, script header comments — written once, rarely re-checked
- **statements from the user** — they are working from the same stale sources

**Why:** on 2026-08-01 a single session found: 32 false claims in CLAUDE.md (including
`MAX_COMMAND_TYPE` asserted as 48 in two bullets and 53 in two others, and the snapshot
format documented as HSNP v2 when `SNAPSHOT_VERSION` is 3); four skills that had silently
diverged from `scripts/preflight.sh`; a script header comment that was itself wrong; and
two false premises in the user's own task description. Writing any of them down would have
propagated the error into more files — the exact multi-source-of-truth failure the repo is
trying to eliminate.

The failure mode is always the same: something is asserted confidently, nothing contradicts
it, and it is wrong. Verification is cheap (one grep, one test run); propagation is not.

**How to apply:**
- Recount mechanically rather than trusting prose: `awk`/`grep` the enum, run the test and
  read `test result:`, open the function and count the passes.
- When the user supplies a number or a premise, check it before building on it. If it is
  wrong, say so and show the evidence instead of quietly writing it down.
- Before any irreversible git action, verify the assumption behind it — `git branch -vv`
  before `--amend` (this was missed once, and rewrote a commit already on origin).
- Prefer structural anchors over numbers that rot: "verify_physics.rs reports 0 tests under
  the default build" outlives "197 of 344".
- After a change, re-check the files that describe it. The `claude-md-auditor` agent
  (`.claude/agents/`) and the `/close-phase` skill mechanise this.
- A fix that turns a test green does not prove the mechanism you wrote next to it. On
  2026-09-29 (Mac M2), `ad91e4f` repaired the bezier cancellation band and its comment,
  commit and README blamed `p = ky - kx^2`. The adversarial review fed an exact `p` and
  saw no change: the real cause was Cardano's `(h - |q|)/2` inside the cube root, and
  the true fix (Vieta, `cb0ddc6`) also repaired a case the first fix missed. Before you
  document a numerical cause, isolate it: substitute the exact value of the suspect term
  (f64, or an f32 emulation) and check that the error goes away.
