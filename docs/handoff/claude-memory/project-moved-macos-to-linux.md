---
name: project-moved-macos-to-linux
description: HyperionEngine moved from macOS to Fedora Linux around Aug-Sep 2026; old Claude memory stayed on the Mac
metadata:
  node_type: memory
  type: project
  originSessionId: 313ad3ec-7cae-433f-b2d5-90ac7dd0565f
  modified: 2026-09-23T17:33:29.056Z
---

Development moved from macOS (`/Users/edoardocicognani/Desktop/Code/HyperionEngine`) to Fedora Linux (`/home/edoardocicognani/Code/HyperionEngine`). The last commit on the Mac was 2026-08-04; work resumed on Linux on 2026-09-23.

The old auto-memory (MEMORY.md, phases-completed.md) lives only on the Mac at `~/.claude/projects/-Users-edoardocicognani-Desktop-Code-HyperionEngine/memory/`, and `.claude/skills/close-phase/SKILL.md` still points there.

**Why:** found during the 2026-09-23 resume audit. `ts/wasm` was also a stale March build, and `wasm-opt` was not installed.
**How to apply:** if phase history is needed, ask the user whether the Mac is still reachable before assuming it is lost. Every macOS-specific gotcha in CLAUDE.md (BSD grep, Metal) is now a cross-platform warning, not the local reality. See [[linux-webgpu-chrome-flags]].
