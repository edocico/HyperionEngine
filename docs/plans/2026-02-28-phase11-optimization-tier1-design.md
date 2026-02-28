# Phase 11: Optimization Tier 1 — Design Document

**Status:** Approved
**Date:** 2026-02-28
**Prerequisites:** Phase 10c-DX complete (commit `dc51531`)
**Masterplan Reference:** §17.1 (Quick Wins), §15.1 (WebGPU Subgroups)
**Approach:** Sequential by impact — wasm-opt → spatial hash → ring buffer profiling → subgroups

---

## 1. Scope and Goals

Four optimization tracks from the masterplan's Tier 1 quick wins, executed sequentially with measurement between each step.

| # | Track | Target | Estimated Effort |
|---|-------|--------|-----------------|
| 1 | wasm-opt + SIMD128 | 15–25% binary size reduction | 0.5 days |
| 2 | Spatial hash for hit testing | ~100× picking speedup for 1000+ entities | 1 day |
| 3 | Ring buffer saturation profiling | Data-driven decision on coalescing | 0.5 days |
| 4 | WebGPU subgroup prefix sum | Profile-dependent GPU culling improvement | 1–2 days |

**Note on SIMD128:** `glam` auto-uses `core::arch::wasm32` v128 on wasm32, but only if Rust compiles with `target-feature=+simd128`. Currently no `.cargo/config.toml` sets this flag. SIMD activation is bundled with the wasm-opt track since both affect the build pipeline.

**Note on Command Coalescing:** Removed from scope. The existing overwrite dedup in `BackpressuredProducer` is the right optimization at the right layer. A 2MB ring buffer at 1–5% utilization in realistic scenarios does not benefit from further coalescing. If profiling (Track 3) reveals saturation, the intervention is `writeMultiple()` (bulk SAB copy), not application-layer shadow state.

---

## 2. Track 1: wasm-opt Post-Build + SIMD128 Activation

### Problem

`wasm-pack build` produces the `.wasm` with LTO fat + codegen-units=1 but no post-processing. The binary may contain dead code, redundant instructions, and unoptimized patterns that `wasm-opt` can eliminate. Additionally, SIMD128 instructions are not emitted because `target-feature=+simd128` is not set.

### Risk Assessment

Almost zero, not zero. `wasm-opt -O3` can in rare cases expose latent bugs from floating-point reordering or dead code elimination that removes code with hidden side effects in `unsafe` Rust. Mitigation: all 99 Rust + 596 TS tests must pass after optimization.

### Design

**SIMD128 Activation:**
- Create `.cargo/config.toml` with `RUSTFLAGS = "-C target-feature=+simd128"` for the wasm32 target
- This enables `glam` to emit v128 SIMD instructions, which `wasm-opt --enable-simd` can then further optimize

**Build Scripts (`ts/package.json`):**
- `build:wasm` → `wasm-pack build` only (dev, fast iteration)
- `build:wasm:release` → `wasm-pack build` + `wasm-opt -O3 --strip-debug --enable-simd` (production)
- `build:wasm:opt` → `wasm-opt` only on existing `.wasm` (iterate optimization flags without recompiling Rust). Includes guard: `[ -f ts/wasm/hyperion_core_bg.wasm ]`

**Binary Size Gate:**
- npm script `check:wasm-size` that measures gzipped `.wasm` size and fails if > 200KB (architectural constraint from masterplan §3)
- Ready for CI integration

**Output path:** `ts/wasm/hyperion_core_bg.wasm` (hardcoded by `wasm-pack --out-dir ../../ts/wasm`).

### Files

- `ts/package.json` — 3 new scripts (`build:wasm:release`, `build:wasm:opt`, `check:wasm-size`)
- `.cargo/config.toml` — new, RUSTFLAGS for wasm32 SIMD128

### Validation

- [ ] `.wasm` size measured before/after (raw + gzipped), improvement documented
- [ ] All 99 Rust tests pass with SIMD enabled
- [ ] All 596 TS tests pass with optimized binary
- [ ] `check:wasm-size` verifies < 200KB gzipped

---

## 3. Track 2: Spatial Hash for Hit Testing

### Problem

`hit-tester.ts` performs O(n) brute-force ray-sphere intersection on all entities. At 10k+ entities, this dominates click/hover response time.

### Design

A **Uniform Grid 2D** in TypeScript (not Rust — hit testing is CPU-side TS, SoA transforms are available via `SystemViews`).

**Backing Store — Flat Buffer (Zero GC Pressure):**
- `cellOffsets: Int32Array(maxCells + 1)` — offset table (prefix sum)
- `cellEntities: Int32Array(maxEntities)` — entity indices packed contiguously
- Rebuild flow: (1) count per cell, (2) prefix sum on counts → offsets, (3) scatter entities. Three linear passes, zero allocations after init.

**Rebuild Strategy — Incremental with Dirty Flags:**
- Frame 0 / resize: full rebuild O(n)
- Subsequent frames: only entities whose transform changed. `BackpressuredProducer` already knows which entities receive `SetPosition` — a `BitSet` dirty flag that resets at frame end
- Fallback: if > 30% entities are dirty, full rebuild is cheaper than incremental remove+reinsert
- Interface includes `remove(entityIndex)` from the start for incremental entity destruction

**Cell Size — World-Space, not Viewport-Space:**
- Based on entity density: `sqrt(worldArea / entityCount) * 2`, producing ~4 entities/cell for uniform distribution
- Recalculated only on full rebuild, not every frame
- `worldArea` derived from extreme bounds of entities (min/max x/y from SoA transforms)

**Hash Function:**
- `(ix * 92837111) ^ (iy * 689287499)` — two large odd primes that decorrelate the two dimensions
- Cell index: `hash & (maxCells - 1)` (power-of-2 sizing)

**Query — 3×3 Neighborhood:**
- Click maps to a cell, but query scans the **3×3 neighborhood** (9 cells) to catch entities straddling cell boundaries
- Ray-sphere narrowing reduces candidates from 9 × ~4 = ~36 to few actual hits

**Insertion — Bounds-Based Multi-Cell:**
- Each entity inserted into all cells intersected by its **bounds** (center ± radius from SoA bounds), not just center position
- Entities without bounds (no `BoundingRadius` or radius 0) are **skipped** in rebuild — they are not hit-testable

**API:** Internal — `SpatialGrid` is an implementation detail of `hitTestRay()`. Public API (`engine.picking`) unchanged.

### Files

- `ts/src/spatial-grid.ts` — new, ~150–180 lines
- `ts/src/hit-tester.ts` — modified: accepts `SpatialGrid`, narrows candidates if available
- `ts/src/spatial-grid.test.ts` — new: rebuild, query, multi-cell, dirty incremental, skip no-bounds, remove

### Validation

- [ ] Zero allocations in hot path (no `new Array`, no `Map`, no `.push()` in rebuild/query)
- [ ] Hit testing functionally identical to brute-force (same results)
- [ ] Entities straddling cell boundaries found correctly (3×3 + bounds-based insert)
- [ ] Entities without bounds skipped
- [ ] Benchmark: picking time with 10k entities before/after

---

## 4. Track 3: Ring Buffer Saturation Profiling

### Problem

The masterplan §17.1 lists "command coalescing" as a Tier 1 optimization targeting 30–50% traffic reduction. However, the ring buffer (2MB, ~100k command capacity) operates at 1–5% utilization in realistic scenarios (1000–5000 commands/frame with 100 moving entities). Reducing 1–5% utilization by 30–50% produces no measurable improvement.

The existing overwrite dedup in `BackpressuredProducer` (per entity+command type, last-write-wins) is already the right optimization at the right layer. Further coalescing (shadow state comparison, no-op elimination, entity-grouped drain) adds complexity in the wrong layer for a problem that may not exist.

### Design

Instead of coalescing, a **micro-benchmark of ring buffer saturation** under stress. No optimization code — measurement only.

- Stress test: 10k entities, 100% in movement, 60fps for 10 seconds
- Metrics collected: commands/frame, % ring buffer capacity used, average `flush()` time, peak utilization
- Output: console report with pass/fail verdict against thresholds
- If saturation < 10%: this track closes — no optimization needed
- If saturation > 50%: evaluate `writeMultiple()` (bulk write with single SAB operation) as targeted intervention

### Files

- `ts/src/ring-buffer-bench.ts` — new, ~60 lines, standalone stress test script

### Validation

- [ ] Benchmark executable and reproducible
- [ ] Metrics documented in report output
- [ ] Decision documented: optimize or close

---

## 5. Track 4: WebGPU Subgroup Prefix Sum

### Problem

The compute cull pass uses workgroup-level Blelloch prefix sum with shared memory (512 elements per workgroup, 18 `workgroupBarrier()` calls). GPUs supporting WebGPU subgroups can eliminate most barriers via hardware-level `subgroupExclusiveAdd()`.

### Critical Prerequisite: Profile-First

Before writing any subgroup shader, **profile the cull pass** to isolate the cost of the prefix sum component versus the total (frustum test + prefix sum + scatter write). Use `GPUComputePassDescriptor.timestampWrites` where supported.

- If prefix sum is < 20% of cull time: this track closes — the gain is marginal regardless of subgroup speedup
- If prefix sum is > 30%: proceed with subgroup implementation

### Design

**Single Shader File with Pipeline Constants:**

Zero file duplication. A single `cull.wgsl` with branching via pipeline-overridable constants:

```wgsl
override USE_SUBGROUPS: bool = false;
override SUBGROUP_SIZE: u32 = 32;
```

The TS side passes constants at `createComputePipeline` time:

```typescript
pipeline = device.createComputePipeline({
  compute: {
    module: shaderModule,
    entryPoint: 'main',
    constants: {
      USE_SUBGROUPS: hasSubgroups ? 1 : 0,
      SUBGROUP_SIZE: subgroupSize,
    }
  }
});
```

Branching on `override` constants is resolved at compile-time by the WGSL compiler — dead branches are eliminated, zero runtime cost. One codebase, one culling logic to maintain.

**Note on `enable subgroups` directive:** The directive must be present in the source for subgroup builtins to compile. When the device doesn't support subgroups, the shader compilation would fail with `enable subgroups`. Solution: prepend `enable subgroups;\n` to the shader source string at pipeline creation time only when subgroups are enabled. The culling logic itself is identical.

**Feature Detection at Device Creation:**

Detection happens in `capabilities.ts` at `requestDevice` time, not after:

```typescript
const wantedFeatures: GPUFeatureName[] = [];
if (adapter.features.has('subgroups')) {
  wantedFeatures.push('subgroups');
}
const device = await adapter.requestDevice({
  requiredFeatures: wantedFeatures,
});
const hasSubgroups = device.features.has('subgroups');
```

If `requestDevice` fails with subgroups, retry without. The `subgroupSize` is read from a minimal probe shader (1 workgroup, reads `subgroup_size` builtin, writes to buffer) at init time.

**Adaptive Workgroup Size:**

Not fixed at 256. Workgroup size = `min(256, subgroupSize * MAX_SUBGROUPS_PER_WG)` where `MAX_SUBGROUPS_PER_WG = 8`.

| GPU | Subgroup Size | Workgroup Size | Subgroups/WG |
|-----|--------------|----------------|-------------|
| Intel iGPU | 8 | 64 | 8 |
| NVIDIA/Apple | 32 | 256 | 8 |
| AMD | 64 | 256 | 4 |

Inter-subgroup reduction uses shared memory with an array of size `MAX_SUBGROUPS_PER_WG` — a simple linear scan on 4–8 elements, not recursive Blelloch.

**Correct Performance Numbers:**

Baseline (Blelloch on 512 elements): `2 × log2(512) = 18` steps, each with 1 `workgroupBarrier()` = **18 barriers**.

Subgroup variant (subgroup=32, workgroup=256, 8 subgroups):
- Intra-subgroup: `subgroupExclusiveAdd()` = 0 explicit barriers (hardware sync)
- Inter-subgroup: linear scan on 8 values with **2 barriers** (write partial sums → barrier → read → barrier → final add)
- Total: **2 barriers**

Gain on prefix sum component: 18→2 barriers ≈ 9× on the prefix sum in isolation. **End-to-end gain on cull pass depends on the fraction that prefix sum represents** — this is the datum that profiling must provide before proceeding.

**Non-Full Workgroups:**

The last workgroup of a dispatch may not be full. Inactive invocations in a partially active subgroup may or may not participate in `subgroupExclusiveAdd()` depending on the driver. The shader handles this with:

```wgsl
let is_active = global_id.x < entity_count;
let vote = select(0u, visibility_result, is_active);
let offset = subgroupExclusiveAdd(vote);
if (is_active && vote != 0u) {
  // write to output
}
```

The invocation does NOT early return — it contributes 0 to the subgroup operation, maintaining participation in the subgroup op. This matches the baseline `cull.wgsl` pattern.

**Automatic Validation Pass:**

For the first 10 frames after subgroup activation, the renderer executes **both** pipelines (baseline and subgroup) and compares `indirect-args` output. If they diverge, subgroups are permanently disabled for the session and a warning is logged. Cost: ~10 frames at double cull time (irrelevant over 10 frames). After validation, only the subgroup pipeline executes.

### Files

- `ts/src/capabilities.ts` — modified: subgroups detection + probe subgroup_size + conditional requestDevice
- `ts/src/shaders/cull.wgsl` — modified: added override constants + subgroup path with branching
- `ts/src/render/passes/cull-pass.ts` — modified: pipeline constants, adaptive workgroup size, validation pass
- `ts/src/render/passes/cull-pass.test.ts` — new tests: pipeline constant selection, workgroup sizing, validation logic

### Validation

- [ ] Profiling cull pass: % prefix sum vs total measured and documented
- [ ] Single shader file, zero culling logic duplication
- [ ] Feature detection at `requestDevice`, retry without if fails
- [ ] Workgroup size adaptive to subgroup size (tested with mock subgroup=8, 32, 64)
- [ ] Non-full workgroups handled correctly (entity_count not multiple of wg_size)
- [ ] Validation pass compares baseline vs subgroup output for first 10 frames
- [ ] Automatic fallback if divergence detected

---

## 6. Success Criteria

| Metric | Target |
|--------|--------|
| WASM binary size (gzipped) | ≥ 15% reduction from baseline, < 200KB |
| Hit test time (10k entities) | < 0.1ms (from ~1ms brute-force) |
| Ring buffer saturation | Measured and documented |
| Cull pass time (100k entities) | Profile-dependent; improvement only if prefix sum > 30% of cull time |

## 7. Non-Goals

- No changes to the ring buffer binary protocol (Rust)
- No new `CommandType` variants
- No application-layer command coalescing
- No 3D spatial structures (the grid is 2D only)
- No multi-workgroup prefix sum (stays within single workgroup)

## 8. Test Impact

- Rust tests: unchanged (99, or 109 with dev-tools)
- TS tests: +15–25 new tests (spatial grid, ring buffer bench, cull pass subgroup logic)
- All existing tests must pass unchanged after each track
