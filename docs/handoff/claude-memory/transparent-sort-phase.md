---
name: transparent-sort-phase
description: "Phase 5b \"GPU sort + uber pipeline\" (back-to-front transparent sorting) — DONE, merged to master b2ccd0c and pushed; the round resumes at step 6"
metadata:
  node_type: memory
  type: project
  originSessionId: 37a7424f-7520-4696-ba3a-caeec676b4ec
  modified: 2026-09-29T09:47:35.293Z
---

**DONE: merged `b2ccd0c` on master, pushed (2026-09-29).** Spec `docs/plans/2026-09-27-transparent-sort-uber-design.md` (measurements in §11), plan `docs/plans/2026-09-27-transparent-sort-uber-plan.md` (23 tasks, executed with subagent-driven development over two sessions).
- Primitive shaders are pieces: `ts/src/shaders/primitives/` prelude + 6 prefixed libraries, composed by `render/primitive-shaders.ts` into 6 per-type modules + 1 uber (`diagnostic(off, derivative_uniformity)` as its first line, uber only). Piece HMR is grouped (`PieceReloadCollector` → `reloadShaders`); `reloadShader` now delegates to `reloadShaders` with one entry.
- `entity-ids` GPU column, uploaded when `entityIdsGeneration` changes; `transparentCount` recounted every frame; `MAX_GPU_ENTITIES` = 100 000.
- `TransparentSortPass`: gather + stable 7-pass radix; `engine.debug.readTransparentSort()`; ONE uber draw for every transparent.
- Step-4 GPU gate: 2D Twins new checks green in B and C, statuses = baseline, C\T bit-exact, C∩T within 1/255. Sort at 100k: 0.787 / 0.869 ms (equal / distinct depths); forward 4−3: −0.021 ms, but the frame TOTAL 4−3 is +0.251 / +1.137 ms (distinct depths: unexplained; hypothesis = scattered SoA reads in sorted order).
- Reviews: adversarial `wf_61c6a580-afa` (18 confirmed, all minor, all fixed); wgsl-validator, webgpu-pass-reviewer, protocol-sync-checker clean; claude-md-auditor's 16 doc items fixed.

Worth remembering: D2 "higher id in front" stops meaning "most recent" after 1,048,576 cumulative spawns (id reuse); `.depth()` is the ordering API. Mode A and Safari are untested here. The sort has a ~0.25 ms fixed cost even at 1k transparents (22 compute passes with the profiler).

**Why:** the user made 5b a phase of its own on 2026-09-27 and planned it for the next session.
**How to apply:** nothing to resume here; continue the round at step 6 ([[open-items-round-2026-09-27]]). If the +1.137 ms distinct-depth cost matters, measure it first (not a gate criterion).
