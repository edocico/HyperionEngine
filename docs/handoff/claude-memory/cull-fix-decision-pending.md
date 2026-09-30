---
name: cull-fix-decision-pending
description: 2026-09-26 Phase 17 DONE on master; rotation(angle) + queue-fairness fixes on master (1c2bf6f); what stayed open moved into the 2026-09-27 open-items round
metadata:
  node_type: memory
  type: project
  originSessionId: 3924f2a4-71f3-4c1e-a190-785b94e0f374
  modified: 2026-09-26T11:53:50.349Z
---

First 6 commits (`6331b5c`..`a25164b`) on `feat/phase17-lighting-2d`, not pushed. The decisions and evidence are in `docs/plans/2026-09-26-cull-temporal-firstinstance-brief.md`.
- `6331b5c`: the dead `transforms` binding is gone and cull is at 8 storage buffers. This unblocks every graph rebuild: bloom, outlines, hot-reload.
- `a65cb59`: the device requests `indirect-first-instance`. Without it, 24 of 26 indirect draws were silent no-ops.
- `bb2d2fa`: temporal culling and the exported dirty-bits chain are removed (BREAKING WASM exports). It had a measured benefit of 0 µs.
- `003f64c`: storage-buffer budget test over all shaders, plus doc fixes.
- `303cad4`: `mark_post_system_dirty` marks physics bodies before the descendant pass. The children of Rapier-moved bodies used to freeze.
- `a25164b`: GPU rows of parented entities take the transform and sphere centre from ModelMatrix. 2D children used to draw at their local offset, and every child was culled at its local position.

The visual session of 2026-09-26 on the AMD iGPU (see [[linux-webgpu-chrome-flags]]) showed the engine drawing, with 0 console errors on Primitives. The GPU per-bucket counts match the spawned entities exactly (25 quads, 10 lines, 3 beziers, 3 gradients, 3 box shadows). An A/B without the feature left only the quads.

**Adversarial review (workflow `wf_0f1c63fd-853`) confirmed 5 findings. All are fixed:**
- `369e385`: the cull subgroup path only at exactly 32 lanes (`subgroupCullSupported`). On the AMD iGPU (32-64) it corrupted the indices while keeping the counts right, which is what hid 9 of the 10 lines and all 3 beziers.
- `ab64066`: orphans are re-staged at once.
- `0330ca2`: a parented physics body is drawn on its collider (`pose_is_world` in `propagate_transforms`).
- `3cffd92`: doc/comment fixes; the brief has an "Esito" section.

`93f725b` fixed bloom:
- a dedicated 1x1 placeholder, never a render target;
- one 256-byte param slice per sub-pass.
On the AMD iGPU this went from 250 errors to 0.

The whole series is 11 commits, `6331b5c`..`93f725b`, not pushed. preflight.sh is green.

**Later the same day (pushed, `d507be4`):** all five "Before Track B" checks of the Phase 17 plan are closed.
- `e87deb1`: texture-tier growth destroyed textures still bound by ForwardPass. Fixed with `onViewsChanged` plus a per-frame group-1 rebind.
- `e4f0042`: particles dropped every frame; auto-layout bind groups are now built per pipeline.
- `7796b6b`: untextured quads were black on BC7 devices. `basic.wgsl` now answers packed index 0 with white.
- The HDR baseline screenshots are in `docs/plans/assets/2026-09-26-hdr-baseline/`. All 8 tabs show 0 WebGPU messages.
- `56f5cbb`: the harness exposes `window.__hyperion` in dev builds, for GPU sessions driven from devtools.

**Still open (minor):**
- The harness checks count spawns, not pixels.
- The demos leak EntityHandles (LeakDetector warnings on tab switch).
- The demo lines are huge because the demo passes width 2 and line.wgsl widens in world units, so six lines at 2-unit spacing merge into one block. That is a parameter mismatch in the demo. (They WERE black because of the BC7 untextured bug, fixed in `f8375ef`.)
- **Phase 17 Task 7 is done** (`63d160f` stage 1 plus `d84c950` stage 2, pushed). OccluderSeedPass runs each primitive's own shader via `fs_occluder` plus `override OCCLUDER_PASS`, so all 6 primitives cast their exact shape (user decision). - **Task 8 is done** (`7b58577`): `SdfJfaPass` plus `sdf-jfa.wgsl`, signed 1+JFA. On GPU it matched an exact distance transform (within 0.1 texel on 100% of texels, sign always right). `JfaIterationPass` is the base class, with `JFAPass` and `SdfJfaPass` as siblings. Not yet wired into the graph.
- **Outlines never rendered until `e9b0e8b`**: two uniform structs (`JFAParams`, `OutlineParams`) had implicit vec2f padding. `src/shaders/uniform-layout.test.ts` now guards every uniform struct.
- **Task 9 done** (`e72a332`): LightAccumPass + light-accum.wgsl, GPU numbers match (0.601 vs 0.600, umbra 0.1).
- **Task 10 done** (`67806ad`), plus the graph wiring: GraphMode.lighting (orthogonal to the composite), GraphRequests.setLighting, followLightingBackend (acts on CHANGE of state.lightingBackend), ForwardPass @group(2) read only in fs_main (occluder pipelines use a 2-group layout). First light on screen 2026-09-26 on AMD: lit vs unlit gradient, soft wall shadow, off-screen global light, toggles and resize with 0 WebGPU messages.
- Found on GPU and fixed: global/directional lights were culled (`434b63c`, radius f32::MAX); picking hit lights (`52a5133`).
- **Light mask resolved (user chose Unity-style: one light buffer per layer group).** Spec/plan `docs/plans/2026-09-26-phase17-light-layer-groups-{design,plan}.md`, commits `e776d1e`..`9634e69` (pushed). User decisions: lights AND shadows per layer, no cap on SDF sets, mask 0 per role, lowest-bit receivers, one set-major node `LightGroupsPass`. GPU: default scene pixel-identical; +1.84 ms per extra SDF set, +0.34 per extra group (1080p iGPU). Final review wf_d626458f-1b8: fixed the design doc §14-18 lost in `714a8cf` (`4be94c1`) and receivers not frustum-filtered (`5ad446f`). Deferred minors: transparent casters/lights keyed but never drawn; profiler keeps stale seed/sdf entries; non-lit primitives still occupy layers; the Lighting tab does not show per-layer shadow on screen.
- **Task 11 done** (`96c0b5c` demo tab, `3ea68bd` docs). GPU cost at 1080p on the AMD iGPU: SDF chain 1.77 ms, light-accum 0.22, backend lit ≈ 2.3 ms (design §13.2).
- **Adversarial review of Track C** (workflow wf_74f03165-d20): 5 confirmed, all fixed — caster+receiver never shadowed (`1675a92`), SDF chain after resize (`5f0e8fb` power-of-two steps + GraphRequests.rebuild), lost switch-off intent (`4487bfe`), Mode A quality (`bd6087d`), fixed-k penumbra (`2c77d87`). Also: step-budget light leaks → default shadowSteps 48 (`0815e58`).
- **Mode A cannot be checked visually on the Fedora box:** the low-power initScript patches only the page, not workers; Mode A's render worker gets NVIDIA and loses the device.
- **Deferred minors fixed** (`63fc16b`..`9ad94c8`): profiler forgets vanished stages, transparent casters/lights drawn (slots 12,13,26,27), only quad/gradient receive, Lighting tab shows per-layer shadow (two symmetric pillars, measured 29.4 vs 67.5). **Second review** (wf_4ce100c0-af1, 14 confirmed minors) fixed in `7d32de0`..`a995225`: profiler per-frame means + forget after WINDOW absent + mismatched frames dropped + buffer always unmapped + getGpuTimings [] when disabled; Rust rejects SetRenderPrimitive > 6 (counted in rejected_command_count), deriveLightGroups mirrors cull's clamp; stale bucket comments; demo spot rotates (quaternion) and is layer 0 only; Lighting tab zooms to fit (check passed at aspect 1.185).
- **MERGED to master 2026-09-26: `47806a8` (--no-ff), pushed; local feature branch deleted (remote copy kept).**
- **rotation(angle) decided and done (user chose option A, 2026-09-26):** SetRotation2D on a 3D entity = rotation about Z (replaces the quaternion); physics bodies take the angle from the command, repositions merge per batch, bodies are built at the entity's rotation, SetRotation (quat) also repositions bodies (Rotation::z_angle); the TS queue drains in LAST-call order. Review wf_e4c9ebf8-3e0 (12 confirmed) all fixed. Merged to master `4a58ce2`, pushed. Still NOT done: a public 2D spawn (option C) — the Transform2D archetype is unreachable from the public API.
- **Queue fairness regression (mine, f4d2c80) found and fixed the same day** by the first run of the saved `adversarial-review` workflow: moving an overwritten key to the end starved the tail of any update loop > 64 KB ring buffer. Measured live in Mode C with the recording tap: 3480/6000 entities never written on master; 0 after `1c2bf6f` (first-position order kept + `SUPERSEDES` table; TeleportBody now merged in call order in Rust). Lesson: measure starvation with `commandBuffer.setRecordingTap` DURING the load — reading positions after the load stops hides it (the backlog drains), and Mode B hides it too (the worker drains concurrently).
- **Automation setup applied 2026-09-26, committed by the user in `1f04d40` ("claude update", pushed):** hooks guard-doc-shrink/guard-stale-wasm, post-edit-ts RED-as-context, /gpu-check skill (+pixels.py), .claude/workflows/adversarial-review.js, webgpu-pass-reviewer agent, Playwright MCP package fixed (@playwright/mcp), github plugin disabled.
- The leftovers (sprite/mix/global shadows, public 2D spawn, harness minors) are the 2026-09-27 round: see [[open-items-round-2026-09-27]].
- **Lesson:** a python append that rewrote a doc from an anchor silently dropped everything after it (`714a8cf`). After scripted doc edits, check `git diff --numstat` for unexpected deletions.

**Why:** a future session must not re-derive any of this.
**How to apply:** check `git log` for these hashes first. On the Fedora box only, a GPU visual session needs the AMD low-power initScript from [[linux-webgpu-chrome-flags]]; the Mac needs no initScript ([[mac-m2-gpu-tests]]).
