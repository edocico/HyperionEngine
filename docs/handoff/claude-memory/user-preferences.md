---
name: user-preferences
description: "How the user works on Hyperion — language of replies and of each kind of artifact, workflow, and which documents are authoritative"
metadata: 
  node_type: memory
  type: user
  originSessionId: 04beb887-3cf6-4c00-a092-d65f1d7b185d
  modified: 2026-09-29T12:15:00.000Z
---

- **Communicates in Italian: reply in Italian.** Written artifacts follow the practice in use since 2026-07-31, which the user confirmed on 2026-09-29 (the August rule "commit bodies in English" was already stale when it was saved):
  - Italian: commit subjects and bodies, after the English conventional prefix (`fix(5b): …`, `test(mac): …`); design docs, briefs, round plans and handoffs under `docs/`.
  - English: code, code comments, CLAUDE.md, skills, agents, hooks, and these memory files.
- **`hyperion-masterplan.md` is the authoritative high-level reference.** In the user's words:
  *"quello è il tuo riferimento principale."* Phases come from there, not from the design
  docs, which have repeatedly diverged from what shipped.
- Wants all three markets served equally: game engine, canvas apps, desktop embedding.
- Works on a feature branch and merges to master; happy to have branches pushed, but
  **verify `git branch -vv` before any history rewrite** — see [[verify-before-asserting]].
- Expects discrepancies to be reported rather than silently worked around, even when the
  wrong premise is the user's own.
- Learning/explanatory output style: give insights as the work happens, and surface
  genuine design forks instead of picking silently.
