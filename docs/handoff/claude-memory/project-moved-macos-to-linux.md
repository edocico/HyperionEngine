---
name: project-moved-macos-to-linux
description: "HyperionEngine machine history — Mac Desktop clone until 2026-08-04, Fedora 2026-09-23..09-29, Mac fresh clone ~/Code/HyperionEngine from 2026-09-29 — and where each copy of the Claude memory lives"
metadata:
  node_type: memory
  type: project
  originSessionId: 313ad3ec-7cae-433f-b2d5-90ac7dd0565f
  modified: 2026-09-29T12:08:00.000Z
---

Machine history of the clone:
- macOS, `~/Desktop/Code/HyperionEngine`, until 2026-08-04 (last Mac commit `04b973b`).
- Fedora Linux, `/home/edoardocicognani/Code/HyperionEngine`, from 2026-09-23 to 2026-09-29 (RTX 4060 + AMD iGPU, see [[linux-webgpu-chrome-flags]]).
- macOS again from 2026-09-29: a fresh clone at `~/Code/HyperionEngine` on an Apple M2 Pro, the canonical machine ([[mac-m2-gpu-tests]]). The Desktop clone is iCloud-synced and obsolete.

Memory copies: the August Mac memory (6 files: MEMORY.md, user-preferences, verify-before-asserting, rapier-api-errata, phases-completed, phase10-dx-progress) stays at the Desktop slug `~/.claude/projects/-Users-edoardocicognani-Desktop-Code-HyperionEngine/memory/` as a backup. On 2026-09-29 user-preferences and verify-before-asserting were carried into this set; the other four are superseded by CLAUDE.md or are history only. `.claude/skills/close-phase/SKILL.md` no longer points at the Desktop slug: since 2026-09-30 (handoff row 6.6, commit 41e277c) it computes the slug from the clone, the same from a worktree or a subdirectory.

**Why:** found in the 2026-09-23 Linux resume audit (`ts/wasm` was a stale March build, `wasm-opt` was missing) and in the 2026-09-29 Mac setup audit (the handoff assumed the Mac memory had 2 files; it had 6).
**How to apply:** memory travels between machines only through `docs/handoff/claude-memory/` in git. On the Mac the macOS gotchas in CLAUDE.md (BSD grep, Metal) are the local reality again; the Linux ones (Vulkan flags, initScript, NVIDIA) are not.
