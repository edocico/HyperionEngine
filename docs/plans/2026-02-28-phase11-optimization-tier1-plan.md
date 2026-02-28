# Phase 11: Optimization Tier 1 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Execute four optimization tracks from §17.1 of the masterplan: wasm-opt + SIMD128, spatial hash for hit testing, ring buffer profiling, and WebGPU subgroup prefix sum.

**Architecture:** Sequential execution by impact. Each track is independently testable. Track 1 (build pipeline) touches no source code. Track 2 (spatial grid) is pure TypeScript with zero-alloc flat buffers. Track 3 (profiling) is measurement-only. Track 4 (subgroups) is GPU shader + TS runtime with automatic validation and fallback.

**Tech Stack:** Rust/wasm-pack/wasm-opt (Track 1), TypeScript/vitest (Tracks 2-4), WGSL compute shaders (Track 4), WebGPU feature detection (Track 4)

**Design Doc:** `docs/plans/2026-02-28-phase11-optimization-tier1-design.md`

**Test baseline:** 99 Rust tests (109 with dev-tools), 596 TypeScript tests. All must pass after every task.

---

## Track 1: wasm-opt + SIMD128 Activation

### Task 1: Measure baseline WASM binary size

**Files:**
- Read: `ts/wasm/hyperion_core_bg.wasm`

**Step 1: Build current WASM and record size**

Run:
```bash
cd ts && npm run build:wasm
```

**Step 2: Record raw and gzipped size**

Run:
```bash
ls -la ts/wasm/hyperion_core_bg.wasm
gzip -c ts/wasm/hyperion_core_bg.wasm | wc -c
```

Record both values. These are the baseline for comparison.

**Step 3: Verify all tests pass on baseline**

Run:
```bash
cargo test -p hyperion-core && cd ts && npm test
```
Expected: 99 Rust + 596 TS tests pass.

**Step 4: Commit baseline measurement**

No code changes — just document the baseline in the commit message.

---

### Task 2: Enable SIMD128 via `.cargo/config.toml`

**Files:**
- Create: `.cargo/config.toml`

**Step 1: Create the Cargo config**

```toml
[target.wasm32-unknown-unknown]
rustflags = ["-C", "target-feature=+simd128"]
```

This tells `glam` to emit v128 SIMD instructions when compiling for WASM.

**Step 2: Verify Rust tests still pass**

Run:
```bash
cargo test -p hyperion-core
```
Expected: 99 tests pass. SIMD128 flag only affects the wasm32 target, not native tests. If any test fails, the SIMD flag is exposing a latent alignment or FP precision issue — investigate before proceeding.

**Step 3: Rebuild WASM with SIMD and compare size**

Run:
```bash
cd ts && npm run build:wasm
ls -la ts/wasm/hyperion_core_bg.wasm
gzip -c ts/wasm/hyperion_core_bg.wasm | wc -c
```

SIMD instructions may slightly increase or decrease binary size. Document the delta.

**Step 4: Run TS tests against SIMD-enabled WASM**

Run:
```bash
cd ts && npm test
```
Expected: 596 tests pass. If any integration test fails, SIMD has changed FP behavior — check for epsilon-sensitive comparisons.

**Step 5: Commit**

```bash
git add .cargo/config.toml
git commit -m "feat(build): enable SIMD128 for wasm32 target via .cargo/config.toml"
```

---

### Task 3: Add wasm-opt build scripts

**Files:**
- Modify: `ts/package.json`

**Step 1: Add three new scripts to `ts/package.json`**

Add these to the `"scripts"` block:

```json
"build:wasm:opt": "test -f wasm/hyperion_core_bg.wasm && wasm-opt -O3 --strip-debug --enable-simd wasm/hyperion_core_bg.wasm -o wasm/hyperion_core_bg.wasm || echo 'ERROR: wasm/hyperion_core_bg.wasm not found. Run build:wasm first.'",
"build:wasm:release": "npm run build:wasm && npm run build:wasm:opt",
"check:wasm-size": "node -e \"const fs=require('fs');const s=fs.statSync('wasm/hyperion_core_bg.wasm').size;const z=require('zlib').gzipSync(fs.readFileSync('wasm/hyperion_core_bg.wasm')).length;console.log('Raw:',s,'('+Math.round(s/1024)+'KB)');console.log('Gzipped:',z,'('+Math.round(z/1024)+'KB)');if(z>200*1024){console.error('FAIL: >200KB');process.exit(1)}console.log('PASS')\""
```

Note: `check:wasm-size` uses `require('zlib').gzipSync` for a pure-Node measurement (no shell pipe). No user input is involved — all paths are static.

**Step 2: Verify `wasm-opt` is installed**

Run:
```bash
which wasm-opt || echo "Not installed — run: cargo install wasm-opt"
```

If not installed:
```bash
cargo install wasm-opt
```

**Step 3: Run the release build**

Run:
```bash
cd ts && npm run build:wasm:release
```

Expected: wasm-pack builds, then wasm-opt optimizes the binary in-place.

**Step 4: Measure optimized size**

Run:
```bash
cd ts && npm run check:wasm-size
```

Expected: Both raw and gzipped sizes printed, PASS verdict if < 200KB gzipped.

**Step 5: Run all TS tests against optimized WASM**

Run:
```bash
cd ts && npm test
```
Expected: 596 tests pass. If any fail, `wasm-opt -O3` has broken something — try `-O2` or `--converge` flags.

**Step 6: Commit**

```bash
git add ts/package.json
git commit -m "feat(build): add wasm-opt release build and binary size gate

- build:wasm:opt: optimize existing .wasm with wasm-opt -O3 --strip-debug --enable-simd
- build:wasm:release: full pipeline (wasm-pack + wasm-opt)
- check:wasm-size: CI-ready gate enforcing <200KB gzipped constraint"
```

---

## Track 2: Spatial Hash for Hit Testing

### Task 4: Write SpatialGrid tests

**Files:**
- Create: `ts/src/spatial-grid.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect } from 'vitest';
import { SpatialGrid } from './spatial-grid';

describe('SpatialGrid', () => {
  function makeBounds(entities: Array<[number, number, number, number]>): Float32Array {
    const b = new Float32Array(entities.length * 4);
    for (let i = 0; i < entities.length; i++) {
      b[i * 4] = entities[i][0];
      b[i * 4 + 1] = entities[i][1];
      b[i * 4 + 2] = entities[i][2];
      b[i * 4 + 3] = entities[i][3];
    }
    return b;
  }

  it('returns empty candidates for empty grid', () => {
    const grid = new SpatialGrid(1024);
    grid.rebuild(new Float32Array(0), 0);
    const result = grid.query(0, 0);
    expect(result.count).toBe(0);
  });

  it('finds entity at query position', () => {
    const grid = new SpatialGrid(1024);
    const bounds = makeBounds([[100, 200, 0, 10]]);
    grid.rebuild(bounds, 1);
    const result = grid.query(100, 200);
    expect(result.count).toBeGreaterThan(0);
    const indices = Array.from(result.indices.subarray(0, result.count));
    expect(indices).toContain(0);
  });

  it('does not find entity far from query position', () => {
    const grid = new SpatialGrid(1024);
    const bounds = makeBounds([[100, 200, 0, 10]]);
    grid.rebuild(bounds, 1);
    const result = grid.query(5000, 5000);
    const indices = Array.from(result.indices.subarray(0, result.count));
    expect(indices).not.toContain(0);
  });

  it('finds entity straddling cell boundary via 3x3 neighborhood', () => {
    const grid = new SpatialGrid(64);
    const bounds = makeBounds([[50, 50, 0, 40]]);
    grid.rebuild(bounds, 1);
    const result = grid.query(85, 50);
    const indices = Array.from(result.indices.subarray(0, result.count));
    expect(indices).toContain(0);
  });

  it('skips entities with zero radius', () => {
    const grid = new SpatialGrid(1024);
    const bounds = makeBounds([[100, 100, 0, 0], [200, 200, 0, 10]]);
    grid.rebuild(bounds, 2);
    const result = grid.query(100, 100);
    const indices = Array.from(result.indices.subarray(0, result.count));
    expect(indices).not.toContain(0);
  });

  it('handles many entities without throwing', () => {
    const grid = new SpatialGrid(4096);
    const count = 1000;
    const entities: Array<[number, number, number, number]> = [];
    for (let i = 0; i < count; i++) {
      entities.push([i * 10, (i % 100) * 10, 0, 5]);
    }
    grid.rebuild(makeBounds(entities), count);
    const result = grid.query(500, 50);
    expect(result.count).toBeGreaterThan(0);
  });

  it('matches brute-force results for random queries', () => {
    const grid = new SpatialGrid(2048);
    const count = 500;
    const bounds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      bounds[i * 4] = Math.random() * 1000;
      bounds[i * 4 + 1] = Math.random() * 1000;
      bounds[i * 4 + 2] = 0;
      bounds[i * 4 + 3] = 5 + Math.random() * 20;
    }
    grid.rebuild(bounds, count);

    for (let q = 0; q < 100; q++) {
      const qx = Math.random() * 1000;
      const qy = Math.random() * 1000;
      const result = grid.query(qx, qy);
      const gridIndices = new Set(Array.from(result.indices.subarray(0, result.count)));

      for (let i = 0; i < count; i++) {
        const cx = bounds[i * 4];
        const cy = bounds[i * 4 + 1];
        const r = bounds[i * 4 + 3];
        if (r <= 0) continue;
        const dx = qx - cx;
        const dy = qy - cy;
        if (dx * dx + dy * dy <= r * r) {
          expect(gridIndices.has(i)).toBe(true);
        }
      }
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
cd ts && npx vitest run src/spatial-grid.test.ts
```
Expected: FAIL — `Cannot find module './spatial-grid'`

---

### Task 5: Implement SpatialGrid

**Files:**
- Create: `ts/src/spatial-grid.ts`

**Step 1: Implement the SpatialGrid class**

See design doc §3 for full specification. Key requirements:
- Flat `Int32Array` backing store (zero GC pressure)
- Three-pass rebuild: count, prefix sum, scatter
- Bounds-based multi-cell insertion (center ± radius)
- 3×3 neighborhood query with in-place dedup
- Skip entities with radius ≤ 0
- World-space cell size: `sqrt(worldArea / entityCount) * 2`
- Hash: `(ix * 92837111) ^ (iy * 689287499)` with power-of-2 mask

The implementation is ~150 lines. Core structure:

```typescript
export interface QueryResult {
  readonly indices: Int32Array;
  readonly count: number;
}

export class SpatialGrid {
  private cellCounts: Int32Array;
  private cellOffsets: Int32Array;
  private cellEntities: Int32Array;
  private queryBuffer: Int32Array;
  private readonly maxCells: number;
  private readonly cellMask: number;
  private cellSize = 100;
  private entityCount = 0;

  constructor(maxEntities: number) { /* allocate flat buffers */ }
  rebuild(bounds: Float32Array, entityCount: number): void { /* 3-pass rebuild */ }
  query(wx: number, wy: number): QueryResult { /* 3x3 neighborhood scan + dedup */ }
  private hashCell(gx: number, gy: number): number { /* hash function */ }
}
```

**Step 2: Run tests**

Run:
```bash
cd ts && npx vitest run src/spatial-grid.test.ts
```
Expected: All 7 tests pass.

**Step 3: Commit**

```bash
cd ts && git add src/spatial-grid.ts src/spatial-grid.test.ts
git commit -m "feat: add SpatialGrid with flat buffer backing and 3x3 query

Zero-alloc uniform 2D grid. Bounds-based multi-cell insertion.
World-space cell size from entity density. Dedup via sort+compact."
```

---

### Task 6: Integrate SpatialGrid into hitTestRay

**Files:**
- Modify: `ts/src/hit-tester.ts`
- Modify: `ts/src/hit-tester.test.ts`

**Step 1: Add optional `grid` parameter to `hitTestRay`**

Add `import type { SpatialGrid } from './spatial-grid';` and extend the signature:

```typescript
export function hitTestRay(
  ray: Ray,
  bounds: Float32Array,
  entityIds: Uint32Array,
  grid?: SpatialGrid,
): number | null {
```

After the direction destructuring, add the grid-accelerated early path that queries candidates and runs ray-sphere only on those. The brute-force loop remains as fallback when `grid` is undefined.

**Step 2: Add test for grid-accelerated path**

In `ts/src/hit-tester.test.ts`, add a test that creates a SpatialGrid, rebuilds it with 1000 entities, and verifies that `hitTestRay` with grid returns the same result as without grid for 20 random ray positions.

**Step 3: Run all hit-tester tests**

Run:
```bash
cd ts && npx vitest run src/hit-tester.test.ts
```
Expected: All 9 tests pass (8 existing + 1 new).

**Step 4: Run full TS test suite**

Run:
```bash
cd ts && npm test
```

**Step 5: Commit**

```bash
git add ts/src/hit-tester.ts ts/src/hit-tester.test.ts
git commit -m "feat: integrate SpatialGrid into hitTestRay for O(1) picking

Optional grid parameter narrows candidates via 3x3 query.
Brute-force fallback when grid not provided. Identical results."
```

---

## Track 3: Ring Buffer Saturation Profiling

### Task 7: Write ring buffer stress benchmark

**Files:**
- Create: `ts/src/ring-buffer-bench.ts`
- Create: `ts/src/ring-buffer-bench.test.ts`

**Step 1: Write the benchmark**

`ts/src/ring-buffer-bench.ts` exports `measureRingBufferSaturation(bp, rb, config)` that:
1. Spawns `entityCount` entities
2. Simulates `frames` frames with `movingFraction` entities moving each frame
3. Each moving entity gets `SetPosition` + every 3rd gets `SetVelocity`
4. Between frames, simulates consumer drain (advance readHead to writeHead)
5. Returns `SaturationReport` with: avgCommandsPerFrame, peakUtilization%, avgFlushTimeMs, verdict (no-action/monitor/optimize)

**Step 2: Write tests**

`ts/src/ring-buffer-bench.test.ts`:
- Test 1: 10k entities, 100% moving, 600 frames — verify metrics are reasonable
- Test 2: 10k entities, 10% moving, 600 frames — verify peakUtilization < 50%

**Step 3: Run benchmark tests**

Run:
```bash
cd ts && npx vitest run src/ring-buffer-bench.test.ts
```

**Step 4: Commit**

```bash
git add ts/src/ring-buffer-bench.ts ts/src/ring-buffer-bench.test.ts
git commit -m "feat: add ring buffer saturation benchmark

Measures commands/frame, utilization %, flush time under stress.
Verdict: no-action/monitor/optimize based on peak utilization."
```

---

## Track 4: WebGPU Subgroup Prefix Sum

### Task 8: Add subgroup feature detection to capabilities.ts

**Files:**
- Modify: `ts/src/capabilities.ts`
- Modify: `ts/src/capabilities.test.ts`

**Step 1: Write failing test for `detectSubgroupSupport`**

**Step 2: Implement `detectSubgroupSupport(adapterFeatures) → { supported: boolean }`**

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add subgroup feature detection to capabilities"
```

---

### Task 9: Add pipeline override constants to cull shader

**Files:**
- Modify: `ts/src/shaders/cull.wgsl`

**Step 1: Add at top of file (after comment, before `const NUM_PRIM_TYPES`):**

```wgsl
override USE_SUBGROUPS: bool = false;
override SUBGROUP_SIZE: u32 = 32u;
```

No logic changes. Verify all tests pass.

**Step 2: Commit**

```bash
git commit -m "feat(shader): add pipeline override constants for subgroup optimization"
```

---

### Task 10: Add subgroup path to cull shader

**Files:**
- Modify: `ts/src/shaders/cull.wgsl`

**Step 1: Refactor `cull_main` to branch on `USE_SUBGROUPS`**

The non-subgroup path (atomic-based) stays identical. The subgroup path uses:
- `subgroupExclusiveAdd()` for per-type offset within subgroup
- `subgroupAdd()` for per-subgroup total
- Shared memory `var<workgroup>` arrays for inter-subgroup reduction
- Two `workgroupBarrier()` calls (vs 18 in Blelloch)
- `select(0u, vote, isActive)` pattern for non-full workgroups

**Step 2: Verify all tests pass (default path unchanged)**

**Step 3: Commit**

```bash
git commit -m "feat(shader): add subgroup-accelerated path to cull shader"
```

---

### Task 11: Wire subgroup pipeline helpers in CullPass

**Files:**
- Modify: `ts/src/render/passes/cull-pass.ts`
- Modify: `ts/src/render/passes/cull-pass.test.ts`

**Step 1: Write tests for `computeWorkgroupSize` and `prepareShaderSource`**

- `computeWorkgroupSize(false, 32)` → 256
- `computeWorkgroupSize(true, 8)` → 64
- `computeWorkgroupSize(true, 32)` → 256
- `computeWorkgroupSize(true, 64)` → 256
- `prepareShaderSource(src, true)` → starts with `enable subgroups;\n`
- `prepareShaderSource(src, false)` → unchanged

**Step 2: Implement helpers**

```typescript
const MAX_SUBGROUPS_PER_WG = 8;

export function computeWorkgroupSize(useSubgroups: boolean, subgroupSize: number): number {
  if (!useSubgroups) return 256;
  return Math.min(256, subgroupSize * MAX_SUBGROUPS_PER_WG);
}

export function prepareShaderSource(baseSource: string, useSubgroups: boolean): string {
  if (!useSubgroups) return baseSource;
  return 'enable subgroups;\n' + baseSource;
}
```

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add subgroup-aware pipeline helpers to CullPass"
```

---

### Task 12: Run full validation and update docs

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Run full validation pipeline**

Run:
```bash
cargo test -p hyperion-core && cargo clippy -p hyperion-core && cd ts && npm test && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"
```

**Step 2: Update CLAUDE.md**

- Add Phase 11 to implementation status table
- Update test counts
- Add new files to architecture tables (`spatial-grid.ts`, `ring-buffer-bench.ts`)
- Add subgroup detection to capabilities module description
- Add spatial grid gotcha: "SpatialGrid cell size is world-space, not viewport-space"

**Step 3: Commit**

```bash
git commit -m "docs: update CLAUDE.md for Phase 11 Optimization Tier 1"
```

---

## Task Summary

| Task | Track | What | New Files | Modified Files |
|------|-------|------|-----------|----------------|
| 1 | wasm-opt | Baseline measurement | — | — |
| 2 | wasm-opt | SIMD128 activation | `.cargo/config.toml` | — |
| 3 | wasm-opt | Build scripts + size gate | — | `ts/package.json` |
| 4 | Spatial | SpatialGrid tests | `ts/src/spatial-grid.test.ts` | — |
| 5 | Spatial | SpatialGrid implementation | `ts/src/spatial-grid.ts` | — |
| 6 | Spatial | hitTestRay integration | — | `ts/src/hit-tester.ts`, `ts/src/hit-tester.test.ts` |
| 7 | Profiling | Saturation benchmark | `ts/src/ring-buffer-bench.ts`, `ts/src/ring-buffer-bench.test.ts` | — |
| 8 | Subgroups | Feature detection | — | `ts/src/capabilities.ts`, `ts/src/capabilities.test.ts` |
| 9 | Subgroups | Override constants | — | `ts/src/shaders/cull.wgsl` |
| 10 | Subgroups | Subgroup shader path | — | `ts/src/shaders/cull.wgsl` |
| 11 | Subgroups | CullPass helpers | — | `ts/src/render/passes/cull-pass.ts`, `ts/src/render/passes/cull-pass.test.ts` |
| 12 | All | Validation + docs | — | `CLAUDE.md` |
