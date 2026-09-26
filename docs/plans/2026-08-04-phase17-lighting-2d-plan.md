# Phase 17: 2D Lighting — `lit` Backend — Implementation Plan

> **Date**: 2026-08-04
> **Design**: `2026-08-04-phase17-lighting-2d-design.md`
> **Baseline**: commit `10bfa1d` — 165/243/191/284 Rust, 885 TS (+5 skipped, 78 files)
> **Already landed** (commits `30001fa`, `10bfa1d`): prerequisite #0 — `scene-hdr` at
> `rgba16float` via `render/formats.ts`, FXAA moved after tonemapping in both
> post-process shaders, `GpuProfiler` + `timestamp-query` in the RenderGraph.

Eleven tasks in three tracks. Track A is the whole data model and protocol and is
**fully verifiable headless** — `cargo test` plus `vitest` cover it end to end.
Tracks B and C touch the GPU, so their gate is a visual check in `npm run dev`;
plan them for a sitting where you can look at the screen.

Track order A → B → C is forced: nothing can cull or accumulate a light until the
light exists as an entity (A), and nothing can shadow until the SDF exists (B).

---

## Decisions taken up front

These were open in the design. Resolving them here, because each one is a place
where the implementation would otherwise stall or silently pick the wrong thing.

**D1 — The light's range has one source of truth: `primParams[3]`.**
`CullPass` frustum-tests `BoundingRadius`, but the shader reads range from
`primParams[3]`. Mirroring the value into both from the TypeScript producer would
work until someone changes range through `raw-api.ts` and forgets the second
write — the light then culls against a stale radius and pops at the frustum edge.
Instead, `update_bounding_radii` (systems.rs:202) gains a second query that sets
`radius.0 = params.0[3]` for entities with `RenderPrimitive(6)`. Consequence to
document: a light's transform *scale* does not affect its culling radius, which
is correct — a light's extent is its range.

> ⚠️ **Erratum, found while implementing.** The paragraph above originally
> continued: *"the existing `Without<..., &BoundsOverride>` query already skips
> them from matrix-derived bounds because they are handled by the new query."*
> **That is false.** `SpawnEntity` gives *every* entity a `ModelMatrix`
> (`command_processor.rs:632` and `:649`, both archetypes), so the existing
> query matches lights too and would overwrite their radius with the
> circumradius of the light quad's matrix.
>
> What makes the result correct is the **order**: the light query runs second
> and wins. That is a correctness invariant, not style, and
> `light_radius_ignores_transform_scale` pins it — with scale 40x the matrix
> path would give ~34.6 instead of the intended 300.
>
> `BoundsOverride` still wins over both, so `SetBoundingRadius` keeps working on
> a light.

**D2 — Type 6 gets all four buckets, three of which stay empty.**
`visible-indices` is `TOTAL_DRAW_BUCKETS * MAX_ENTITIES * 4` = 24 × 100_000 × 4 =
9.6 MB today, 11.2 MB at 28 buckets. Lights have neither a material sort (tier0 vs
other) nor a transparent variant, so **1.2 MB of the +1.6 MB is dead space**. The
alternative — a variable bucket count per type — breaks the uniform
`blendOff + primType * BUCKETS_PER_TYPE + bucket` indexing in `cull.wgsl` and adds
a branch to the hot loop. Take the waste; revisit only if 100k-entity scenes turn
out to be memory-bound.

**D3 — Lights are never drawn by `ForwardPass`.**
No shader is registered for `primType 6` in `SHADER_SOURCES`, so the
`for (const [primType, pipeline] of this.pipelines)` loop simply never finds them.
No opt-out flag needed, no branch. `LightAccumPass` reads their bucket directly.

**D4 — The 16-bit `lightMask` is one field with three meanings, not two pairs.**
Godot uses two orthogonal mask pairs and `shadow_item_cull_mask` ends up doing
double duty; the confusion that causes is documented at length by its users. One
field means an entity that is both sprite and occluder cannot receive light from
one layer set and cast shadow for another. That is almost always what you want,
and separating them costs a new SoA column. Ship one field, document the limit.

---

## Track A — Light data model and protocol (headless)

- [x] **Task 1: `renderMeta` bit layout (Rust)** — landed in `6b9d686`
  - `render_state.rs`: extend the word at `gpu_render_meta[slot*2+1]`. Bits 0-7
    `primType`, bit 8 `transparent` stay as they are; add bit 9 `castsShadow`,
    bit 10 `receivesLight`, bits 11-13 `lightType`, bits 14-15 `lightBlendMode`,
    bits 16-31 `lightMask`. Touches all three write sites (`collect_gpu` ~l.383,
    and the two incremental paths ~l.677 and ~l.754) — they must agree.
  - `components.rs`: `LightFlags(pub u32)` component holding bits 9-31, so the
    encode is one OR rather than five field reads.
  - Tests: encode/decode roundtrip per field, field independence (setting one
    does not disturb another), default is all-zero, `transparent` bit survives.
    (~8 tests)
  - Gate: `cargo test -p hyperion-core render_state`

- [x] **Task 2: `RenderPrimitive(6)` = Light2D + range→radius derivation (Rust)** — landed in `c64827b`
  - `components.rs`: document `6 = Light2D` on `RenderPrimitive`; add the
    `PrimitiveParams` slot map for it in the doc comment (0-2 colour with energy
    premultiplied, 3 range, 4 innerCos/height, 5 outerCos, 6 falloff,
    7 shadowIntensity).
  - `systems.rs`: `update_bounding_radii` — second query setting
    `radius.0 = params.0[3]` for `RenderPrimitive(6)`. See **D1**.
  - Tests: radius follows `primParams[3]`, ignores transform scale, a non-light
    entity is unaffected, radius 0 does not panic the frustum test. (~5 tests)
  - Gate: `cargo test -p hyperion-core systems`

- [x] **Task 3: four CommandTypes, 53-56 (Rust)** — landed in `2065f0f`
  - Follow `/new-command` step by step — 16 steps, and steps 2 and 7.1 are the
    two that fail *silently*.
  - `ring_buffer.rs`: `SetLightFlags = 53` (4B: u8 lightType, u8 blendMode,
    u16 lightMask), `SetLightingFlags = 54` (1B: bit0 castsShadow,
    bit1 receivesLight), `SetAmbientLight = 55` (16B: 4×f32),
    `SetLightingBackend = 56` (1B). Then `from_u8` arms, then `payload_size`
    arms, **then** `MAX_COMMAND_TYPE` 53 → 57 — in that order, same commit.
  - `command_processor.rs`: real handlers for 53/54 (resolve entity, validate,
    mutate `LightFlags`, `mark_meta_dirty`); no-op arms for 55/56.
  - `engine.rs`: intercept 55/56 before ECS dispatch on the `entity_id == 0`
    sentinel, same shape as `SetPhysicsDebugRender` (engine.rs:83-90).
  - Tests: `from_u8` roundtrip for each of the four (the arm the compiler will
    not check), payload sizes, handler mutates the right bits, dirty marking
    fires, engine-level commands do not reach the ECS. (~12 tests)
  - Gate: `cargo test -p hyperion-core ring_buffer command_proc`

- [x] **Task 4: TypeScript protocol mirror** — landed in `2065f0f`
  - `ring-buffer.ts`: the four CommandTypes + `PAYLOAD_SIZES` (TS2741 catches an
    omission here).
  - `backpressure.ts`: `MAX_COMMAND_TYPE` 53 → 57, four producer methods, all
    four coalescable last-write-wins — none carries a secondary id in its
    payload, so the `entityId * 256 + cmd` key is sound.

    > ⚠️ **Erratum, found at the 2026-09-23 resume audit.** The key is sound;
    > *last-write-wins* is not — not since `3556e08` gave 53 and 54 preserve
    > bits for `.lightLayers()` / `.castsShadow()` / `.receivesLight()`. A
    > partial update replaced wholesale drops the fields it left alone:
    > `castsShadow(true).receivesLight(true)` in one frame reached Rust as
    > receivesLight only, so the Task 7 occluder filter on bit 9 would have
    > seen no occluders. Fixed on `feat/phase17-lighting-2d` by merging 53/54
    > field by field in `PrioritizedCommandQueue.enqueue`
    > (`mergePartialPayload`). The mock producer in `entity-handle.test.ts` could
    > not see this; the regression tests drive the real queue and fold the ring
    > buffer bytes with the Rust handler semantics.
  - `prim-params-schema.ts`: `RenderPrimitiveType.Light2D = 6` and its schema
    entry, mirroring Task 2.
  - `entity-handle.ts`: `RenderPrimitiveType.Light2D = 6` (this file is the
    authoritative TS declaration; `prim-params-schema.ts` re-declares it and the
    two must not drift).
  - Tests: producer emits the right opcode and payload, coalescing, mask
    round-trips 16 bits, schema resolves named params to the right slots.
    (~14 tests)
  - Gate: run the **protocol-sync-checker** agent.

- [x] **Task 5: `indirect-args` 24 → 28 buckets** — landed in `fb060c5`
  - `cull-pass.ts`: `NUM_PRIM_TYPES` 6 → 7. `OPAQUE_DRAW_BUCKETS`,
    `TOTAL_DRAW_BUCKETS`, `TRANSPARENT_BUCKET_OFFSET` all derive from it.
    `INDIRECT_BUFFER_SIZE` follows.
  - `cull.wgsl`: `NUM_PRIM_TYPES` 6u → 7u; `drawArgs: array<DrawIndirectArgs, 24>`
    → 28; `sg_counts`/`sg_prefixes` `array<u32, 192>` → 224 (28 × 8 subgroups);
    `wg_bases` `array<u32, 24>` → 28. Workgroup storage goes to ~1.8 KB, well
    inside the 16 KiB limit.
  - `renderer.ts`: `visible-indices` grows to 11.2 MB (see **D2**).
  - ⚠️ The WGSL constant and the TS constant are **separate declarations of the
    same number**. This is check #4 of `wgsl-validator` and rule #3 in the design
    risk table — land both in one commit.
  - Tests: bucket index math for type 6 opaque and transparent, buffer sizing,
    reset writes 28 entries. (~7 tests)
  - Gate: run the **wgsl-validator** agent.

- [x] **Task 6: fluent API + facade** — landed in `3556e08`
  - `entity-handle.ts`: `.light({ type, color, energy, range, innerAngle,
    outerAngle, falloff })`, `.shadows(intensity)`, `.castsShadow(bool)`,
    `.receivesLight(bool)`, `.lightLayers(mask)`.
    `color` and `energy` stay separate in the API and are premultiplied only when
    writing `SetPrimParams0` — design §5.3, second of the two 3D-readiness moves.
  - `hyperion.ts`: `lighting.setAmbient()`, `lighting.setBackend()`,
    `lighting.setQuality()`. `index.ts` barrel export.
  - Tests: each method emits the expected commands, premultiplication happens at
    the boundary and not in the API surface, defaults, chaining. (~18 tests)
  - Gate: `cd ts && npx vitest run src/entity-handle.test.ts src/hyperion.test.ts`

**End of Track A.** At this point lights exist as entities, are culled by
`CullPass`, survive snapshot/restore and replay, and appear in `engine_state_hash`
— and nothing is rendered yet. Run `scripts/preflight.sh` before starting B.

---

## Before Track B — checks for the first GPU session (added 2026-09-23)

Found by code review, not reproducible headless. Check each with the WebGPU
adapter on the RTX 4060 (Chrome flags in the project memory), Mode B:

- [x] **`indirect-first-instance`** — `CullPass` writes `firstInstance = slot * 100000`
  but the device never requests the feature. If Dawn enforces the spec, every
  bucket but slot 0 draws nothing — Task 9's type-6 draw included.
  → Confirmed on hardware, fixed in `a65cb59`. The cull pipeline itself had been
  invalid since March (9 storage buffers), fixed in `6331b5c`. See
  `2026-09-26-cull-temporal-firstinstance-brief.md`.
- [x] **Texture tier growth vs. the ResourcePool** — `TextureManager` replaces a
  tier's texture and view when it grows, but the pool's `tier0..3` views are
  registered once at init, so `ForwardPass`'s bind group may point at a
  destroyed texture after the first texture load.
  → Confirmed on hardware ("Destroyed texture used in a submit" on every frame
  after one `loadTexture`). Fixed with `onViewsChanged` + a per-frame group-1
  rebind in `ForwardPass`.
- [x] **Bloom blur radius** — `BloomPass` rewrites ONE uniform buffer between its
  sub-passes of the same submit, so every sub-pass reads the last write (the
  composite's texel size): the blur is 2-8x too narrow.
  → Fixed in `d0b3cee`, together with a worse one: pass 3 sampled its own
  render target, which dropped every bloom frame.
- [x] **Subgroup size** — the cull path assumes 32; check `adapter.info.subgroupMinSize/MaxSize`.
  → It corrupts indices at other widths. Gated to exactly 32 in `369e385`.
- [x] **HDR baseline** — screenshots of the 8 demo tabs (design §16 rows 1/1b).
  → `assets/2026-09-26-hdr-baseline/` (AMD RDNA 3 iGPU, Mode B, 1600×900).
  All 8 tabs render with **0 WebGPU messages**. The only console noise left is
  LeakDetector warnings from demo handles never destroyed on a tab switch. The
  baseline turned up two more defects, both fixed before it was taken:
  - particles dropped every frame (bind groups not built from their own
    pipeline's auto layout);
  - untextured quads were black on BC7 devices. Now white: packed index 0 is
    answered by `basic.wgsl`.
  The white quads also make the bloom halo visible in the Rendering FX tab.

All five checks are closed. Track B can start.

## Track B — Occluders and the signed SDF (needs GPU eyes)

- [ ] **Task 7: `OccluderSeedPass` + `shaders/occluder-seed.wgsl`**
  > **Decision (2026-09-26): exact shape per primitive, no `occluder-seed.wgsl`.**
  > A single seed shader would make every occluder its bounding quad, which
  > drops the design §6.2 argument for the SDF backend. Instead the pass runs
  > each primitive's own shader through a second entry point `fs_occluder`
  > that reuses its coverage, with `override OCCLUDER_PASS` doing the castsShadow
  > filter in the vertex stage. It lands in stages:
  > - [x] **Stage 1 — quads and sprites** (`basic.wgsl`: texture alpha ≥ 0.5).
  >   GPU readback on NVIDIA and AMD: a caster fills its quad with correct UVs, a
  >   non-caster writes nothing, a checker-alpha sprite writes exactly 50%.
  > - [x] **Stage 2 — line, gradient, box-shadow, bezier, MSDF** (one agent per
  >   shader, same pattern). GPU check: all 12 ForwardPass and 6 occluder pipelines
  >   are valid. Measured seed coverage: quad/MSDF/gradient 1.0, a bezier its
  >   arch (0.117 of the quad, arch visible in readback), box-shadow as drawn, a
  >   non-caster 0. Lines cast from width ≈ 2 world units up. The shadow follows
  >   `shade()`, which is the same code that draws the line.
  >   Caveats, from the conversion:
  >   - box-shadow alpha is opacity, so a shadow with a < 0.5 does not occlude;
  >   - transparent-bucket entities never occlude (opaque buckets only);
  >   - untextured lines and beziers sampled black on BC7. Fixed in the next
  >     commit.
  > - [ ] Wire into the graph with the lighting backend (needs a reader: Task 8).
  - New pass, **not** a reworked `SelectionSeedPass`: that one filters on
    `selection-mask` and draws 2 of the 24 buckets; this one filters on
    `renderMeta` bit 9 and must iterate every opaque bucket.
  - Same degenerate-triangle trick in the vertex shader for entities that do not
    cast.
  - Writes `occluder-seed` at `JFA_FORMAT`, half resolution, **oversize 1.0 by
    default** — design §6.2 established the 120% Godot default costs +96% pixels,
    not +20%, so it is opt-in and not the starting point.
  - Tests: pass lifecycle, resource declarations, empty-scene no-op, resize.
    (~8 tests)

- [ ] **Task 8: signed SDF chain**
  > **Landed 2026-09-26, apart from graph wiring:** `SdfJfaPass` plus `sdf-jfa.wgsl`.
  > - Instead of an instance field, `JfaIterationPass` is a common base with
  >   `JFAPass` and `SdfJfaPass` as siblings, each with its own static shader slot.
  >   That keeps one hot-reload slot per WGSL file, and keeps
  >   `instanceof JFAPass` meaning "outline chain".
  > - Distances are in texels, not uv: uv is anisotropic on a non-square target.
  > - Seeds are read with `textureLoad`.
  > - GPU check against a brute-force exact distance transform (a square plus a
  >   thin rotated bar, 128×128): sign 100% right, 0 invalid texels, 0
  >   under-estimates, 100% within 0.1 texel.
  > - Found on the way: the outline chain's `JFAParams` struct is 24 bytes in
  >   WGSL against a 16-byte buffer, so every outline frame failed. Fixed separately.
  - Reuse `JFAPass` unmodified for the iterations; resources `sdf-iter-0..N` on
    the same two-physical-texture ping-pong as `jfa-iter-N`.
  - Sign: adopt Godot's single-chain encoding (`canvas_sdf.glsl`) — a neighbour of
    opposite fill type acts as its own seed, so interior and exterior fronts
    propagate together in one pass chain. Godot stores it in `rg16i`/`r16snorm`,
    which are **not core WebGPU** (they need `texture-formats-tier1`); encode in
    the free alpha channel of `JFA_FORMAT` instead.
  - ⚠️ **This forces `JFAPass.SHADER_SOURCE` from a static class field to an
    instance field** — the outline chain and the SDF chain now need different
    shaders. Design §12.3 flagged this as conditional; the sign decision makes it
    certain.
  - Add `1+JFA` (one extra pass at step 1 *before* the standard chain): JFA error
    is always an over-estimate of distance, which is the direction that lets a
    sphere-march step tunnel through a thin occluder. Rong & Tan measure 1+JFA at
    roughly JFA+2 accuracy for JFA+1 cost.
  - Tests: instance-field shader source does not leak between chains, iteration
    count `ceil(log2(max(w,h)))`, ping-pong resource naming, sign in alpha.
    (~10 tests)
  - Gate: **wgsl-validator**; visual check that an occluder's interior reads
    negative and its exterior positive.

---

## Track C — Light accumulation (needs GPU eyes)

- [x] **Task 9: `LightAccumPass` + `shaders/light-accum.wgsl`** (`e72a332`)
  - Target `light-buffer`, `SCENE_HDR_FORMAT`, half resolution, additive blend
    (`one`/`one`, core WebGPU). **Clear colour is the ambient light** — free, the
    way Unity does it.
  - One instanced draw off the type-6 bucket via `drawIndexedIndirect`;
    `instanceCount` is already written by `CullPass`.
  - Fragment: radial/conic attenuation, then if `shadowIntensity > 0` a sphere
    march on `scene-sdf` toward the light with Quilez's `res = min(res, k*h/t)`,
    16-32 steps with early-out.
  - ⚠️ Use the **original** Quilez form, not the Aaltonen correction. The
    correction assumes an exact SDF; with a jump-flood field `h` is already an
    over-estimate and `y = h²/(2·ph)` amplifies it. Put that reasoning in the
    shader comment — the "better" version is the obvious thing for the next
    reader to reach for.
  - Tests: pass lifecycle, resource declarations, blend state, clear colour
    tracks ambient, no-lights no-op. (~10 tests)
  > **Done 2026-09-26.** GPU readback on NVIDIA: attenuation 0.601 where 0.600
  > is expected, 0.1 in the umbra, radial profile within 0.001. Not yet: the
  > `sprite` type, the `mix` blend, shadows from global/directional lights.

- [x] **Task 10: `@group(2)` in `ForwardPass`**
  - Three bindings: `light-buffer` texture, sampler, `lighting-uniform`.
  - A 3-group `pipelineLayout` where a shader declares only groups 0-1 is legal —
    validation requires that bindings *used* exist in the layout, not the
    converse. So only `basic.wgsl` and `gradient.wgsl` declare group 2.
  - ⚠️ But `execute()` must still `setBindGroup(2, ...)` for **every** pipeline,
    including those whose shaders ignore it. One call before the type loop.
    Forgetting it produces an obscure validation error.
  - `textureSampleLevel`, never `textureSample` — `derivative_uniformity` is an
    error by default and this is check #7 of `wgsl-validator`.
  - Gate on bit 10 `receivesLight`, `@interpolate(flat)` so the branch is
    uniform across the quad.
  - Tests: bind group layout shape, group-2 presence per shader, uniform packing.
    (~8 tests)
  - Gate: **wgsl-validator**; visual check — a lit sprite and an unlit sprite in
    the same scene.
  > **Done 2026-09-26, with the graph wiring the plan left implicit.**
  > - The lookup lives in `fs_main`, not in the shared `shade()`: OccluderSeedPass
  >   runs the same modules through `fs_occluder` on a two-group layout.
  > - `GraphMode.lighting`, orthogonal to the composite; `GraphRequests.setLighting`;
  >   the host validates overlays against all six graphs; the renderer requests the
  >   lit graph when `GPURenderState.lightingBackend` CHANGES (`followLightingBackend`:
  >   following the value would retry a GPU-rejected graph every frame).
  > - Found on the GPU: global/directional lights were culled like point lights.
  >   They now get `BoundingRadius = f32::MAX`. And picking hit lights, whose sphere
  >   is their range; `hitTestRay` now skips Light2D.
  > - Visual check (AMD adapter, harness Mode B): lit vs unlit gradient in the same
  >   light, soft shadow from a wall, an off-screen global light tinting the scene,
  >   bloom/outlines/off/on toggles and a resize — 0 WebGPU messages.
  >
  > ⚠️ **The light mask cannot be applied as designed.** §7.3 says "applied on read,
  > in the ForwardPass", but a single screen-space buffer has already summed every
  > light. Layers need one buffer per layer group. So Task 11's "light-layer toggle"
  > has nothing to show until that is designed.

- [x] **Task 11: demo tab, measurement, docs** — demo tab (`96c0b5c`), measurement (design §13.2 "Misurato 2026-09-26": SDF chain 1.77 ms at 1080p on the AMD iGPU, backend `lit` ≈ 2.3 ms), docs.
  > The adversarial review of Track C (workflow, 4 reviewers + 7 verifiers)
  > confirmed 5 findings; all are fixed with tests and, where visible, a GPU
  > check: caster+receiver sprites were never shadowed by other occluders
  > (`1675a92`); the SDF chain stopped covering the texture after a resize
  > (`5f0e8fb`, power-of-two steps + rebuild); a switch-off was lost when a
  > later request was rejected (`4487bfe`); quality never reached Mode A's
  > render worker (`bd6087d`); the fixed-k penumbra (`2c77d87`, found on GPU
  > first). Also found on GPU: light leaking where the 24-step budget ran out
  > (`2c77d87` extrapolation, `0815e58` default 48 steps).
  - `demo/lighting.ts`: new tab with point/spot/global lights, an occluder wall,
    a shadow-intensity slider, a light-layer toggle. Register in `demo/types.ts`
    and the report.
  - **Take the measurement.** Chrome with `--enable-webgpu-developer-features`
    (stock Chrome on Metal returns all zeroes — CLAUDE.md gotcha), run
    `enableGpuProfiling()`, record `averageMs` for the JFA chain with and without
    the SDF chain. This is the number design §13.2 has been estimating at
    ~0.35 ms; write the real one into the design doc.
  - Full `scripts/preflight.sh --full`, including the WASM size gates.
  - CLAUDE.md: module tables (`render_state.rs` bit layout, `systems.rs`,
    `components.rs`, new passes, new shaders, `entity-handle.ts`, `hyperion.ts`),
    Gotchas (`MAX_COMMAND_TYPE = 57`; 28 buckets and the WGSL/TS pairing;
    light range lives in `primParams[3]` and drives `BoundingRadius`;
    `JFAPass.SHADER_SOURCE` is now per-instance; Quilez original not Aaltonen),
    Implementation Status row Phase 17, test counts.
  - Commit style as 15e/16: one commit per task, `feat(#17):` / `docs:`.

---

## Execution Order

```
Task 1 (renderMeta bits) ──┐
Task 2 (primType 6 + radius) ←─(1)
Task 3 (CommandTypes) ←────(1)
Task 4 (TS protocol) ←─────(3)
Task 5 (24→28 buckets) ────── independent of 1-4, but before 6
Task 6 (fluent API) ←──────(4,5)
        ── preflight gate ──
Task 7 (OccluderSeedPass) ←(5)
Task 8 (signed SDF) ←──────(7)
Task 9 (LightAccumPass) ←──(6,8)
Task 10 (@group(2)) ←──────(9)
Task 11 (demo + measure + docs) ←─(all)
```

Critical path: 1 → 3 → 4 → 6 → 9 → 10 → 11.

Tasks 1, 2, 3 and 5 are independent enough to land in any order within Track A;
5 is the one worth doing early, because the bucket-count change touches a shader
and a hot compute loop and is the least pleasant thing to debug late.

Estimated new tests: ~25 Rust, ~65 TS → targets ≈ 190/268/216/309 Rust,
~950 TS. Record actuals in CLAUDE.md at Task 11.

---

## What this phase deliberately leaves out

| Capability | Why |
|---|---|
| **Normal maps on sprites** | Needs a new SoA column and the staging stride 32 → 33 u32. It is the only table-stakes feature excluded, and the cost of adding it later is identical to adding it now, so the decision is deferrable without penalty. Design §7.5 |
| **`LightCullPass` (tile compute)** | With a half-res light buffer and typical radii it may not repay itself. Drawing each light as a quad of its own radius is already geometric culling. Measure first. Design §7.2 |
| **Backend `gi` (Radiance Cascades)** | Separate phase. Gate it on the `tmpvar` prototype, which costs no repo code and can run any time |
| **Second accumulator (additive/glow)** | MRT is affordable — `maxColorAttachmentBytesPerSample` 32 allows 4 `rgba16float` targets — but it is not needed for a first version |
| **Occluders from Rapier colliders** | Not extractable: `LineCollector::draw_line` discards `DebugRenderObject`, so the lines arrive as an undifferentiated pool. Design §6.2 |

## Note on repo hygiene

~~`/close-phase` instructs appending a record to `MEMORY.md`, and that file does
not exist anywhere in the repo.~~

**Withdrawn — this was a misreading.** `MEMORY.md` is not meant to be a repo
file. `.claude/skills/close-phase/SKILL.md:92` gives the path directly under the
heading: `~/.claude/projects/-Users-edoardocicognani-Desktop-Code-HyperionEngine/memory/`.
The file is there, alongside `phases-completed.md` and the other topic files it
indexes. Nothing to create, nothing to correct.
