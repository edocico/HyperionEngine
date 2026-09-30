---
name: round-pending-decisions
description: "Round paused 2026-09-29 for Mac M2 GPU tests (finished 2026-09-30, fe20736) — the user's still-open design decisions for steps 6, 7, 8 (and 8b/10), plus the Mac tests' open questions, to ask now, before step 6"
metadata:
  node_type: memory
  type: project
  originSessionId: df7ee902-6496-4e89-9073-f4776e2f51ef
  modified: 2026-09-29T10:25:26.743Z
---

**Paused on 2026-09-29.** The user is moving development to a MacBook with an Apple M2 to test the GPU there (Metal, Mode A, Safari). Master is at `b2ccd0c`, which includes phase 5b. The user said: save the choices still to be made and take them up again **after the Mac tests are finished**.

**The Mac tests finished on 2026-09-30** (merged into master at `fe20736`; outcomes in handoff §9 "Esito sul Mac"). What is left is the user's answers: do not start step 6 before them.

Do not start step 6 until the user has finished the Mac tests AND answered these. Source: `docs/plans/2026-09-27-open-items-round-plan.md` §2 (deferred decisions) and §3 (exit criteria).

- **Step 6 — L-c directional shadows.** `shadow()` gets generalised to an origin + direction, with `light-groups.ts:113` changed in the same commit. Global lights cast no shadow, and the API says so. Decisions to ask:
  1. Does `sdfOversize` come back? Without it, off-screen occluders pop in at the screen edge.
  2. Which local axis of the light's transform gives the direction?
  3. How wide is the penumbra?
  4. Confirm that global lights cast no shadows.
- **Step 7 — L-b `mix` blend.** `mix` becomes a second pipeline, drawn after add and sub. Decision to ask: the order of overlapping `mix` lights — left undefined and documented, or deterministic by id?
- **Step 8 — L-a sprite light.** Decisions to ask:
  1. The extent: a square of side = range with radius `range·√2`, the transform's scale, or a disc.
  2. The texture source.
  3. Whether a sprite light casts shadows.
- **Step 8b — PhysicsAPI wiring.** The user added this step; it has no open decision. `PhysicsAPI._init` has no callers. Mode A and B need a bridge protocol for events and queries.
- **Step 10 — `HyperionConfig.powerPreference`.** It was meant to make Mode A checkable on the Linux machine, where the render worker got NVIDIA and lost the device. On the Mac, which has a single GPU, Mode A may be checkable without it. Ask whether step 10 is still wanted once the Mac tests have shown Mode A working, or not. The Mac tests did show it: Mode A runs on the M2 in Chrome (M6) and in Safari (M12) with no `powerPreference`.
- **Carried from phase 5b.** At 100k transparents with DISTINCT depths the frame total grew +1.137 ms from step 3 to step 4 (design §11); equal depths grew +0.251 ms. The code shows no avoidable cause. Re-measuring on the M2 is a candidate Mac test. Ask whether it matters. M8 re-measured it: on the M2 the distinct-minus-same difference does not reproduce (6 paired comparisons within -0.14..+0.21 ms, against +0.954 on AMD), and the mechanism is not measured; only the /2 bench on the Fedora AMD box can settle it.

- **From the Mac tests (handoff §9.4).** Two questions to ask with the ones above:
  1. Audio in automated runs: without a real gesture the Audio section's setup never ends and the tab switcher waits for it (M12). Should Audio's resume, or section setup in general, get a timeout?
  2. The step-3 to step-4 uber cost: about +0.21/+0.23 ms at 10k on the M2 (M8). Does it matter?

**Why:** the user asked, on 2026-09-29, to keep these for after the Mac GPU tests.
**How to apply:** a Mac session is the one that RUNS the GPU tests ([[mac-m2-gpu-tests]]). So do not ask these while the tests are in progress. Ask them when the user says the Mac tests are done (or asks to resume the round), before starting step 6. Take the Mac results into account; for example, step 10 may be unnecessary if Mode A already works on the M2. Related: [[open-items-round-2026-09-27]], [[transparent-sort-phase]], [[feedback-autonomous-round]].
