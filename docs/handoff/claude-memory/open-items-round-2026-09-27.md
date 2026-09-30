---
name: open-items-round-2026-09-27
description: "2026-09-27 round closing harness (H), public 2D spawn (S), Phase 17 leftovers (L) — order, user decisions, progress (steps 1-5 and 5b merged; next step 6, paused for the Mac tests)"
metadata:
  node_type: memory
  type: project
  originSessionId: df7ee902-6496-4e89-9073-f4776e2f51ef
  modified: 2026-09-29T09:54:29.281Z
---

The user wants all three open items closed, in the order from workflow `wf_22520d1f-e48`. The plan lives in `docs/plans/2026-09-27-open-items-round-plan.md`: order, exit criteria, deferred decisions per step, and the stale docs to fix.

Order:
0. The plan doc.
1. H2 — `destroy()` releases the handle to the engine, and the tab switch is serialized. This is an ENGINE bug: `entityCount` never decrements, so `spawn()` dies after 100k cumulative spawns.
2. H1a — the probe, plus swapchain readback.
3. H3 then H1b — lines, then real pixel checks.
4. S1 — opt-in 2D spawn, verifying scatter format 0 on scatter frames.
5. S2 — Depth→z (optional).
6. L-c — directional shadows.
7. L-b — mix as a second pipeline.
8. L-a — sprite light.
9. Close-out.

User decisions 2026-09-27:
- D1: `destroy()` only releases the handle (unregister + decrement). It is not recycled into the pool, so there is no ABA.
- D2: pixel checks use an in-page probe (scene-hdr, light-buffer, entity-transforms rows) PLUS swapchain readback (canvas COPY_SRC).
- D3: line width is world or pixel units, chosen per line by a flag in `primParams[7]`.
- D4: the 2D spawn is a per-entity opt-in, `spawn({ mode: '2d' })`, and the default stays 3D.

Later the same day:
- D5: entity ids are reused under quarantine, as step 1b right after step 1. An id is reusable only once its DespawnEntity has been WRITTEN to the ring buffer and WASM has confirmed a later tick.
- Step 10, the user's pick: `HyperionConfig.powerPreference` forwarded to the render worker, so that Mode A becomes GPU-checkable on the Linux machine. It is to be tried after the round.

Progress:
- **Step 1 DONE**: merged to master as `4fa4609` and pushed. It covers:
  - `destroy()` releases the handle; the pool and `init()` are gone;
  - GameLoop hook isolation: hooks are `{fn, failures}` entries with null tombstones, removed after 60 consecutive failures;
  - `SectionSwitcher`;
  - `allocateId` throws past `MAX_EXTERNAL_ID`;
  - the prefab partial-failure undo.
- Evidence: reviews `wf_fc1e6644-ae6` (10 confirmed, all fixed) and `wf_2265dd05-9b8` (2 doc minors, fixed); the GPU A/B against master reproduced both the engine stop and 1160 leak warnings.
- Step 1b is being mapped by workflow `wf_f39b6322-af4`, which also weighs generation bits in the upper 12 bits of the id.

- Step 1b design approved: `docs/plans/2026-09-27-id-reuse-design.md`. Decisions: Q1 fresh-first then a FIFO pool; Q2 raw.despawn is a no-op with a dev warning when the id is not live, and throws when the id belongs to a live handle; Q3 a dead handle's `.id` stays readable.
- New step 8b, added by the user: wire PhysicsAPI to WASM. `_init` is never called, so events, raycast and queries are no-ops in the live facade.

- **Step 1b DONE** (merged `dc03fd7`, pushed):
  - TS: `EntityIdAllocator` + `TickSequencer` (the `seq` echo in tick-done) + the queue's despawn-written listener, SetParent guard and purge index;
  - Rust R1-R6 (`tests/verify_reuse.rs`), done by a worktree subagent;
  - reviews: `wf_f28f7089-de1` (14 minors, all fixed) and a clean protocol-sync check.
  - GPU-verified the reuse in Mode B and C by forcing the fresh counter past `maxId` (`window.__hyperion.ids.next = ids.maxId + 1`).
- Perf lesson: a `const enum` imported from another module is NOT inlined under vitest's per-file transform. A comparison in a hot path cost +2.3% flush time at 10k entities until it was hoisted to a module constant.
- **Step 2 DONE** (merged `2389646`, pushed).
  - API: `engine.debug.probe({target:'scene-hdr'|'swapchain'|'light-buffer', world|uv, layer})` and `engine.debug.readEntityTransforms()`, dev builds only.
  - How it reads: a compute `textureLoad` (`pixel-probe.wgsl`).
  - It REJECTS instead of answering zeros: on GPU errors, on a retired light-buffer, on a bad layer, and while paused.
  - The canvas gets TEXTURE_BINDING only after the first swapchain probe.
  - User decisions: the probe is a dev engine API; checks use ratios for light and absolute values ±tolerance for static colours.
  - Found: the scatter upload runs in Mode C ONLY (the worker never sends staging), so format-0 checks must use `?mode=C`.
- **Step 3a DONE** (merged `f412bd3`, pushed).
  - API: `.line(..., width, {unit:'px'})`, with the flag in `primParams[7]`; the default stays world units (user decision).
  - `CameraUniform` bytes 68/72 now carry the viewport size.
  - Rust: the line culling radius comes from its endpoints (Frobenius norm for the width), per the user's decision.
  - AA uses a 1-px margin quad with `edgeScale` and a ramp from `2·fwidth(uv.y)` centred on the edge. Opaque strokes use the half-open `insideStroke` test; the occluder seed uses the same test, at least 2 px wide.
  - Verified with the probe: W rows at every sub-pixel offset, and a stable 3-px shadow.
- **Step 3b DONE** (merged `bb0c83a`, pushed).
  - Every tab checks pixels through `pixelCheck` (`demo/probe-checks.ts`): skips where no probe exists, fails after 3 s without a frame; `fitView` frames each scene at any aspect (green at 540x935 too).
  - Engine fixes it surfaced: the selection mask is indexed by GPU slot (was by id: outlines hit the wrong entity), an empty world renders its clear (the last image stayed), the bounds visualizer clears on an empty world.
  - Review `wf_d87d17e2-4c1`: 17 confirmed, all fixed (`52e417d`).
  - Lesson: after a git checkout/merge Vite can serve a stale `?import&raw` WGSL (304): restart the dev server before a GPU check.
- **Step 4 DONE** (merged `b783174`, pushed). User decisions (asked 2026-09-27): 3D-only args on a 2D handle ignored + one dev warning per EntityHandle; one EntityHandle class with z optional (`position`/`velocity` 0, `scale` sz 1) + `is2D`; prefabs per template (`mode: '2d'`). Rust already handled payload 1 since Phase 13 (`tests/verify_2d.rs` pins it). New tab "2D Twins" (10 tabs now): texel-exact twins + GPU rows = CPU rows; Mode C 12/12 scatter frames (format 0 parent, format 1 child). Review `wf_24bad90e-4e1` 8 minors fixed (incl. `PrefabInstance.moveTo` dropping `overrides.z`). Lesson: the 2D archetype saves ECS memory only; GPU rows are 16 words either way.
- **Step 5 DONE** (merged `7a40aba`, pushed). User decisions: in the round; `.depth()` 2D-only (ignored + warning on 3D); relative in children; equal depths undefined. My convention: depth = distance into the screen, row z = -depth (`Depth::z()`). Review `wf_60bf12aa-fa0`: depth does NOT order two `.transparent()` sprites (no depth write, RadixSortPass dead) → user chose "document + new step 5b" (real back-to-front sort). Also fixed: 2D immediate shadow patches x/y only (z null); physics body depth is world; ring-buffer bench flaky timeout (pre-existing) given 30 s.
- Step 5b decided (user, 2026-09-27): a PHASE of its own, "GPU sort + uber pipeline" — GPU radix sort of the visible transparent entities by world z, ONE draw through a single module covering all six primitives. Tie-break at equal z: the newer entity (higher id) in front. The user said: PLAN it in this session, EXECUTE it in the NEXT session. State and how to resume: [[transparent-sort-phase]] (brainstorming paused mid-design: Section 1 approved, the Section 2 sort candidate + 14 review issues saved in `docs/plans/2026-09-27-transparent-sort-uber-brainstorm.md`).
- **Step 5b DONE** (merged `b2ccd0c`, pushed, 2026-09-29): GPU transparent sort + uber pipeline — see [[transparent-sort-phase]]. Review `wf_61c6a580-afa`; measurements in the design §11. Next: step 6 (L-c directional shadows): ask its deferred decisions (plan §2) first. **PAUSED 2026-09-29** while the user tests the GPU on a Mac M2: the open decisions are saved in [[round-pending-decisions]]. The Mac tests finished on 2026-09-30 (merged `fe20736`): ask those decisions, then start step 6.
- AFTER phase 5b: resume the round at step 6 (L-c directional shadows), then 7 (mix), 8 (sprite light), 8b (PhysicsAPI wiring), 9 (close-out), 10 (`powerPreference` for Mode A). Ask each step's deferred decisions (plan §2) first.

**Why:** the user asked for the best order and made these four calls. The other decisions are deferred to specific steps (listed in the plan doc §2).
**How to apply:** open the plan doc, find the first step without a merged commit (check `git log`), and ask its deferred decisions before starting it — unless [[round-pending-decisions]] says the round is paused. Related: [[cull-fix-decision-pending]].
