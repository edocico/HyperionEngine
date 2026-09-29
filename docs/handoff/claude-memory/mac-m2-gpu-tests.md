---
name: mac-m2-gpu-tests
description: "From 2026-09-29 development moves to a MacBook Apple M2 to test the GPU on Metal (Mode A, Safari, subgroup cull, ASTC, timings); the handoff doc in docs/handoff/ is the plan; the Mac is the canonical machine"
metadata:
  node_type: memory
  type: project
  originSessionId: df7ee902-6496-4e89-9073-f4776e2f51ef
  modified: 2026-09-29T10:25:24.177Z
---

On 2026-09-29, with master at `b2ccd0c` (phase 5b merged), the user moved development from the Fedora Linux machine to a MacBook with an Apple M2. The goal is to test the GPU there: Metal, Chrome and Safari, and Mode A (checkable there because the Mac has a single GPU and needs no initScript).

- The plan, the setup steps and the test list are in `docs/handoff/2026-09-29-mac-m2-handoff.md`.
- A copy of the Claude memory as it was on Linux is in `docs/handoff/claude-memory/`. The repo is PUBLIC; the user chose this on 2026-09-29.
- The Mac is the canonical machine from 2026-09-29.
- Mac work goes on a branch, not on master. Ask the user before merging it to master: the standing autonomy covers only the steps of the open-items round.
- When the Mac work ends, refresh `docs/handoff/claude-memory/` from the Mac memory and commit it, so that a return to Linux can restore it. `sshd` is off on the Linux machine, so git is the only way to carry memory between the two.
- The open-items round is paused. Its open decisions are in [[round-pending-decisions]]; ask them only after the user says the Mac tests are done.

**Why:** the user wants the engine verified on Apple hardware before going on with the round (steps 6-10).
**How to apply:** at the start of a Mac session, follow the handoff doc's first-turn list. Report GPU findings with their evidence, and fix engine bugs test-first on the branch. Related: [[project-moved-macos-to-linux]], [[linux-webgpu-chrome-flags]].
