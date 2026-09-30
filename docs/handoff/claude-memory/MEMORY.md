# Hyperion Engine — Memory

- [User preferences](user-preferences.md) — reply in Italian; commits and docs/ designs in Italian, code/CLAUDE.md/skills/memory in English; masterplan is the authority; report discrepancies, surface design forks
- [Verify before asserting](verify-before-asserting.md) — check every claim against the source before writing or acting on it, including the user's own premises
- LINUX ONLY (Fedora RTX 4060 + AMD iGPU) — [Linux WebGPU Chrome flags](linux-webgpu-chrome-flags.md) — three flags for hardware WebGPU; NVIDIA adapter cannot present to a canvas (compositor on AMD iGPU) → use low-power initScript for visual checks, re-navigate after every TS edit
- [Machine history](project-moved-macos-to-linux.md) — Mac Desktop clone (→ 08-04) → Fedora (09-23..09-29) → Mac fresh clone ~/Code (09-29); August Mac memory kept at the Desktop slug; close-phase computes the slug from the clone since 2026-09-30 (6.6)
- [Phase 17 progress 2026-09-26](cull-fix-decision-pending.md) — Phase 17 + rotation + queue-fairness fixes on master (1c2bf6f, pushed); automations committed (1f04d40); leftovers moved to the 09-27 round; Mode A not GPU-checkable on Linux
- [Open-items round 2026-09-27](open-items-round-2026-09-27.md) — H→S→L order, user decisions, progress: steps 1-5 and 5b merged (b2ccd0c); next = step 6, after the answers to round-pending-decisions (Mac tests finished 2026-09-30)
- [Autonomy for the H/S/L round](feedback-autonomous-round.md) — commit/merge/push per step without asking; still ask plan §2 design decisions
- [Mac M2 GPU tests — handoff 2026-09-29](mac-m2-gpu-tests.md) — dev moved to the Mac (canonical), clone at ~/Code/HyperionEngine (Desktop is iCloud-synced); machine facts + setup proof; plan in docs/handoff/2026-09-29-mac-m2-handoff.md; work on a branch, ask before merging; refresh docs/handoff/claude-memory/ at the end; FINISHED 2026-09-30 and merged to master (fe20736): M0-M10 + M12 pass, M11 skipped; outcomes in handoff §9 and the M2 README; anti-reload initScript for test navigations
- [Round PAUSED for Mac M2 tests — open decisions](round-pending-decisions.md) — steps 6/7/8 design decisions (+8b, 10) + the Mac tests' open questions; the Mac tests are finished (fe20736): ask them NOW, before step 6
- [Phase 5b transparent sort — DONE](transparent-sort-phase.md) — GPU sort + uber pipeline merged (b2ccd0c); measurements in the design §11

**Current state lives in the repo, not here:** CLAUDE.md (architecture, gotchas, phase table), `docs/plans/` (per-phase design), `scripts/preflight.sh` (the single definition of "validated"). This index is for what those cannot record.
