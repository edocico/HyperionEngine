---
name: feedback-autonomous-round
description: For the 2026-09-27 H/S/L round the user said "continua tu in autonomia" — proceed step by step without asking, commit per step on branches
metadata:
  type: feedback
---

On 2026-09-27 the user answered "continua tu in autonomia" when asked whether to commit per step. Proceed autonomously through the round in [[open-items-round-2026-09-27]]:
- work one branch per step;
- develop TDD;
- run preflight and adversarial-review before each merge;
- commit, merge `--no-ff` to master and push, as in the earlier Phase 17 practice.

Still ask the deferred user decisions that the plan doc lists per step, because those are design calls, not execution.

**Why:** the user wants the round to move without per-action confirmations; they still want to make the design decisions.
**How to apply:** do not ask "may I commit/merge?". Do ask the per-step decisions (plan §2) before starting that step.
