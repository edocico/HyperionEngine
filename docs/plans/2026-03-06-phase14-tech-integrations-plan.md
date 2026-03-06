# Phase 14: Tech Integrations 2026 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver subgroup-accelerated culling (2x target), sized binding array architecture prep, and Loro CRDT feasibility validation with hard go/no-go numbers.

**Architecture:** Phase 14a upgrades WebGPU compute pipeline with subgroup v2 builtins and shared-memory prefix-sum compaction in the cull shader, plus detection + shader design for sized binding arrays. Phase 14b is a standalone feasibility spike that compiles Loro CRDT to WASM and measures binary size, merge latency, instantiation time, and bidirectional command mapping.

**Tech Stack:** WebGPU compute (WGSL), TypeScript, Rust/WASM (hyperion-core unchanged), Rust/WASM (loro-spike new crate), vitest, wasm-pack, wasm-opt.

**Design doc:** `docs/plans/2026-03-06-phase14-tech-integrations-design.md`

---

## Phase 14a: Subgroups v2 + Sized Binding Arrays

### Task 1: Upgrade SubgroupSupport detection

**Files:**
- Modify: `ts/src/capabilities.ts:90-108`
- Modify: `ts/src/capabilities.test.ts:68-83`

**Step 1: Write failing tests for hasSubgroupId**

Add to `ts/src/capabilities.test.ts` after the existing `detectSubgroupSupport` describe block (line 83):

```typescript
describe("detectSubgroupSupport v2 (subgroup_id builtins)", () => {
  it("returns hasSubgroupId=false when wgslLanguageFeatures not available", () => {
    const features = new Set<string>(["subgroups"]);
    const result = detectSubgroupSupport(features);
    expect(result.supported).toBe(true);
    expect(result.hasSubgroupId).toBe(false);
  });

  it("returns hasSubgroupId=true when subgroup_id in wgslLanguageFeatures", () => {
    // Mock navigator.gpu.wgslLanguageFeatures
    const origGpu = (globalThis as any).navigator?.gpu;
    (globalThis as any).navigator = {
      ...(globalThis as any).navigator,
      gpu: { wgslLanguageFeatures: new Set(["subgroup_id"]) },
    };
    try {
      const features = new Set<string>(["subgroups"]);
      const result = detectSubgroupSupport(features);
      expect(result.supported).toBe(true);
      expect(result.hasSubgroupId).toBe(true);
    } finally {
      if (origGpu !== undefined) {
        (globalThis as any).navigator.gpu = origGpu;
      } else {
        delete (globalThis as any).navigator.gpu;
      }
    }
  });

  it("returns hasSubgroupId=false when subgroups not supported", () => {
    const features = new Set<string>();
    const result = detectSubgroupSupport(features);
    expect(result.supported).toBe(false);
    expect(result.hasSubgroupId).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/capabilities.test.ts`
Expected: FAIL — `SubgroupSupport` has no `hasSubgroupId` property.

**Step 3: Update SubgroupSupport interface and detection**

In `ts/src/capabilities.ts`, replace lines 90-108:

```typescript
/**
 * Result of subgroup feature detection.
 */
export interface SubgroupSupport {
  supported: boolean;
  /** Chrome 144+: @builtin(subgroup_id) and @builtin(num_subgroups) available */
  hasSubgroupId: boolean;
}

/**
 * Detect whether the GPU adapter supports subgroup operations.
 *
 * - `supported`: adapter has 'subgroups' feature (subgroupExclusiveAdd, etc.)
 * - `hasSubgroupId`: WGSL has 'subgroup_id' language feature (Chrome 144+)
 *
 * At `requestDevice()` time, add `'subgroups'` to `requiredFeatures` if supported.
 */
export function detectSubgroupSupport(
  adapterFeatures: ReadonlySet<string>,
): SubgroupSupport {
  const supported = adapterFeatures.has('subgroups');
  const hasSubgroupId = supported &&
    !!(navigator as any).gpu?.wgslLanguageFeatures?.has('subgroup_id');
  return { supported, hasSubgroupId };
}
```

**Step 4: Update existing tests for new return shape**

In `ts/src/capabilities.test.ts`, update the existing tests (lines 68-83) to expect `hasSubgroupId`:

```typescript
describe("detectSubgroupSupport", () => {
  it("returns supported=false when feature not present", () => {
    const features = new Set<string>();
    const result = detectSubgroupSupport(features);
    expect(result.supported).toBe(false);
    expect(result.hasSubgroupId).toBe(false);
  });

  it("returns supported=true when subgroups feature present", () => {
    const features = new Set<string>(["subgroups"]);
    const result = detectSubgroupSupport(features);
    expect(result.supported).toBe(true);
    // hasSubgroupId depends on navigator.gpu.wgslLanguageFeatures (not mocked here)
  });

  it("returns supported=false for subgroups-f16-only (not what we need)", () => {
    const features = new Set<string>(["subgroups-f16"]);
    const result = detectSubgroupSupport(features);
    expect(result.supported).toBe(false);
    expect(result.hasSubgroupId).toBe(false);
  });
});
```

**Step 5: Run tests to verify they pass**

Run: `cd ts && npx vitest run src/capabilities.test.ts`
Expected: All PASS (existing + new tests).

**Step 6: Commit**

```
feat(#14a): SubgroupSupport.hasSubgroupId detection for Chrome 144+ builtins
```

---

### Task 2: Upgrade prepareShaderSource for 3-level directive handling

**Files:**
- Modify: `ts/src/render/passes/cull-pass.ts:64-75`
- Modify: `ts/src/render/passes/cull-pass.test.ts:99-109`

**Step 1: Write failing tests for 3-level prepareShaderSource**

Add to `ts/src/render/passes/cull-pass.test.ts` after the existing `prepareShaderSource` describe block (line 109):

```typescript
describe('prepareShaderSource v2 (3-level)', () => {
  it('returns unchanged source for no subgroups', () => {
    const src = 'override USE_SUBGROUPS: bool = false;';
    expect(prepareShaderSource(src, false, false)).toBe(src);
  });

  it('prepends enable subgroups when subgroups used but no subgroup_id', () => {
    const src = 'override USE_SUBGROUPS: bool = false;';
    const result = prepareShaderSource(src, true, false);
    expect(result).toBe('enable subgroups;\n' + src);
  });

  it('prepends enable subgroups + requires subgroup_id when both available', () => {
    const src = 'override USE_SUBGROUPS: bool = false;';
    const result = prepareShaderSource(src, true, true);
    expect(result).toBe('enable subgroups;\nrequires subgroup_id;\n' + src);
  });

  it('ignores subgroup_id when subgroups not supported', () => {
    const src = 'fn main() {}';
    expect(prepareShaderSource(src, false, true)).toBe(src);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/render/passes/cull-pass.test.ts`
Expected: FAIL — `prepareShaderSource` doesn't accept 3 arguments.

**Step 3: Update prepareShaderSource signature**

In `ts/src/render/passes/cull-pass.ts`, replace the function (lines 72-75):

```typescript
/**
 * Conditionally prepend WGSL directives for subgroup support.
 *
 * 3 levels:
 * - No subgroups: unchanged source
 * - Subgroups: prepend `enable subgroups;`
 * - Subgroups + subgroup_id (Chrome 144+): also prepend `requires subgroup_id;`
 */
export function prepareShaderSource(
  baseSource: string,
  useSubgroups: boolean,
  useSubgroupId: boolean = false,
): string {
  if (!useSubgroups) return baseSource;
  let prefix = 'enable subgroups;\n';
  if (useSubgroupId) prefix += 'requires subgroup_id;\n';
  return prefix + baseSource;
}
```

**Step 4: Verify existing 2-arg tests still pass**

The existing tests at lines 99-109 call `prepareShaderSource(src, false)` and `prepareShaderSource(src, true)` — these still work because `useSubgroupId` defaults to `false`.

**Step 5: Run all tests**

Run: `cd ts && npx vitest run src/render/passes/cull-pass.test.ts`
Expected: All PASS.

**Step 6: Commit**

```
feat(#14a): prepareShaderSource 3-level directive handling (enable subgroups + requires subgroup_id)
```

---

### Task 3: Add USE_SUBGROUP_ID override constant to cull shader

**Files:**
- Modify: `ts/src/shaders/cull.wgsl:14-15`

**Step 1: Add the override constant**

In `ts/src/shaders/cull.wgsl`, after line 15 (`override SUBGROUP_SIZE: u32 = 32u;`), add:

```wgsl
override USE_SUBGROUP_ID: bool = false;
```

This is a passive change — the constant exists for pipeline override but isn't consumed yet. The shader is still valid.

**Step 2: Verify WGSL parses (type-check via tsc)**

Run: `cd ts && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: No new errors (WGSL is loaded as raw string, not type-checked by tsc).

**Step 3: Run existing cull tests to ensure no regression**

Run: `cd ts && npx vitest run src/render/passes/cull-pass.test.ts`
Expected: All PASS (override constant doesn't affect tests that don't create a GPU pipeline).

**Step 4: Commit**

```
feat(#14a): USE_SUBGROUP_ID override constant in cull.wgsl
```

---

### Task 4: Rewrite cull shader subgroup path with shared-memory prefix-sum compaction

**Files:**
- Modify: `ts/src/shaders/cull.wgsl` (the `if (USE_SUBGROUPS)` block, lines 113-145)

**Step 1: Design the shared-memory layout**

The cull shader processes 24 buckets. Each workgroup has up to 8 subgroups (256 / SUBGROUP_SIZE). The shared memory stores per-bucket subgroup totals:

```wgsl
// Shared memory for cross-subgroup prefix sum.
// Layout: [bucket][subgroup] — bucket count per subgroup.
// Max 24 buckets x 8 subgroups = 192 entries.
const MAX_SUBGROUPS: u32 = 8u;
var<workgroup> sg_counts: array<u32, 192>;    // 24 * 8
var<workgroup> sg_offsets: array<u32, 192>;    // prefix sums
var<workgroup> wg_totals: array<atomic<u32>, 24>;  // per-bucket workgroup total (for global atomic)
```

**Step 2: Implement the new subgroup path**

Replace the `if (USE_SUBGROUPS) { ... }` block (lines 113-145) in `ts/src/shaders/cull.wgsl` with:

```wgsl
    if (USE_SUBGROUPS) {
        // Phase 1: Intra-subgroup prefix sum per bucket.
        // Each thread determines its bucket, does subgroupExclusiveAdd within
        // its subgroup, and the subgroup leader writes the total to shared memory.

        // Determine this thread's bucket (or -1 if invisible)
        let myBucket = select(
            -1i,
            i32(select(0u, OPAQUE_BUCKETS, isTransparent) + primType * BUCKETS_PER_TYPE + bucket),
            visible
        );

        // Get subgroup identity — use builtin if available, else reconstruct
        var sg_id = 0u;
        var sg_size = SUBGROUP_SIZE;
        if (USE_SUBGROUP_ID) {
            // Chrome 144+: direct builtins (requires `requires subgroup_id;` prepended)
            // These builtins are injected by the WGSL compiler when the directive is present.
            // Without the directive, this code is dead (USE_SUBGROUP_ID = false).
            sg_id = subgroup_id_builtin;
            sg_size = SUBGROUP_SIZE;
        } else {
            // Reconstruct subgroup ID from local invocation index
            let lid = gid.x % 256u;
            sg_id = lid / SUBGROUP_SIZE;
        }

        // Clear shared memory
        let lid = gid.x % 256u;
        if (lid < TOTAL_BUCKETS * MAX_SUBGROUPS) {
            sg_counts[lid] = 0u;
            sg_offsets[lid] = 0u;
        }
        if (lid < TOTAL_BUCKETS) {
            atomicStore(&wg_totals[lid], 0u);
        }
        workgroupBarrier();

        // Per-bucket subgroup scan
        for (var b = 0u; b < TOTAL_BUCKETS; b = b + 1u) {
            let vote = select(0u, 1u, myBucket == i32(b));
            let intra_offset = subgroupExclusiveAdd(vote);
            let sg_total = subgroupAdd(vote);

            // Subgroup leader writes total to shared memory
            if (subgroupElect() && sg_total > 0u) {
                sg_counts[b * MAX_SUBGROUPS + sg_id] = sg_total;
            }
        }
        workgroupBarrier();

        // Phase 2: Cross-subgroup exclusive prefix sum in shared memory.
        // Each thread that is the first in its subgroup scans across subgroups.
        let num_subgroups = (256u + SUBGROUP_SIZE - 1u) / SUBGROUP_SIZE;
        if (lid < TOTAL_BUCKETS) {
            let b = lid;
            var running = 0u;
            for (var s = 0u; s < num_subgroups; s = s + 1u) {
                let val = sg_counts[b * MAX_SUBGROUPS + s];
                sg_offsets[b * MAX_SUBGROUPS + s] = running;
                running += val;
            }
            // Batch atomic: one per bucket per workgroup
            if (running > 0u) {
                atomicStore(&wg_totals[b], atomicAdd(&drawArgs[b].instanceCount, running));
            }
        }
        workgroupBarrier();

        // Phase 3: Deterministic scatter.
        if (visible) {
            let b = u32(myBucket);
            let vote = 1u;
            let intra_offset = subgroupExclusiveAdd(vote);
            let sg_base = sg_offsets[b * MAX_SUBGROUPS + sg_id];
            let wg_base = atomicLoad(&wg_totals[b]);
            let global_offset = wg_base + sg_base + intra_offset;
            let region_offset = b * cull.maxEntitiesPerType;
            visibleIndices[region_offset + global_offset] = idx;

            // Write visibility bit
            let word = idx / 32u;
            let bit = idx % 32u;
            atomicOr(&visibility_out[word], 1u << bit);
        }
    }
```

> **Note to implementer:** The `subgroup_id_builtin` reference above is a placeholder. When `requires subgroup_id;` is prepended, the actual WGSL syntax is `@builtin(subgroup_id) sg_id_param: u32` in the function signature. The `USE_SUBGROUP_ID` path needs the entry point signature updated to include these builtins conditionally. Because WGSL doesn't support conditional builtins, this will likely require a second entry point `cull_main_sg_id` or using the pipeline override to dead-code-eliminate the path. Resolve during implementation — the key architectural change (shared-memory scan replacing per-subgroup atomics) is correct regardless of how the builtin is plumbed.

**Step 3: Verify existing tests still pass**

Run: `cd ts && npx vitest run src/render/passes/cull-pass.test.ts`
Expected: All PASS (tests don't execute WGSL, they test TypeScript helpers).

**Step 4: Commit**

```
feat(#14a): cull shader shared-memory prefix-sum compaction replacing per-subgroup atomics
```

---

### Task 5: Wire subgroup detection into renderer pipeline creation

**Files:**
- Modify: `ts/src/renderer.ts:66-85` (createRenderer adapter/device)
- Modify: `ts/src/renderer.ts:164-190` (CullPass setup)

**Step 1: Import and use subgroup detection**

In `ts/src/renderer.ts`, add import:

```typescript
import { detectCompressedFormat, detectSubgroupSupport } from './capabilities';
import { prepareShaderSource } from './render/passes/cull-pass';
```

In `createRenderer()`, after adapter detection (line 76), add subgroup detection:

```typescript
  const subgroupSupport = detectSubgroupSupport(adapter.features);
```

In the `requiredFeatures` array (lines 79-81), add subgroups if supported:

```typescript
  if (subgroupSupport.supported) requiredFeatures.push('subgroups' as GPUFeatureName);
```

Wrap the device request in a try/catch — fallback without subgroups if the feature request fails:

```typescript
  let device: GPUDevice;
  let useSubgroups = subgroupSupport.supported;
  try {
    device = await adapter.requestDevice({
      requiredFeatures: requiredFeatures.length > 0 ? requiredFeatures : undefined,
    });
  } catch {
    // Subgroup request failed — retry without
    useSubgroups = false;
    const fallbackFeatures = requiredFeatures.filter(f => f !== 'subgroups');
    device = await adapter.requestDevice({
      requiredFeatures: fallbackFeatures.length > 0 ? fallbackFeatures : undefined,
    });
  }
```

Before setting `CullPass.SHADER_SOURCE` (line 167), apply prepareShaderSource:

```typescript
  CullPass.SHADER_SOURCE = prepareShaderSource(
    cullShaderCode,
    useSubgroups,
    useSubgroups && subgroupSupport.hasSubgroupId,
  );
```

**Step 2: Set pipeline override constants in CullPass.setup()**

This requires modifying `CullPass.setup()` in `ts/src/render/passes/cull-pass.ts` to accept and pass override constants. Add a static config:

```typescript
  static SUBGROUP_CONFIG: { useSubgroups: boolean; subgroupSize: number; useSubgroupId: boolean } =
    { useSubgroups: false, subgroupSize: 32, useSubgroupId: false };
```

In `setup()`, use override constants when creating the pipeline (line 187-189):

```typescript
    this.pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout0, this.bindGroupLayout1] }),
      compute: {
        module: shaderModule,
        entryPoint: 'cull_main',
        constants: {
          USE_SUBGROUPS: CullPass.SUBGROUP_CONFIG.useSubgroups ? 1 : 0,
          SUBGROUP_SIZE: CullPass.SUBGROUP_CONFIG.subgroupSize,
          USE_SUBGROUP_ID: CullPass.SUBGROUP_CONFIG.useSubgroupId ? 1 : 0,
        },
      },
    });
```

In `renderer.ts`, before `cullPass.setup()`, set the config:

```typescript
  CullPass.SUBGROUP_CONFIG = {
    useSubgroups,
    subgroupSize: 32,  // TODO: query actual subgroup size from adapter if API available
    useSubgroupId: useSubgroups && subgroupSupport.hasSubgroupId,
  };
```

**Step 3: Run all TS tests**

Run: `cd ts && npm test`
Expected: All 721+ tests PASS. CullPass tests don't create real GPU pipelines, so override constants are irrelevant.

**Step 4: Commit**

```
feat(#14a): wire subgroup detection + override constants into renderer pipeline creation
```

---

### Task 6: Add subgroup-accelerated entry point to prefix-sum.wgsl

**Files:**
- Modify: `ts/src/shaders/prefix-sum.wgsl`
- Modify: `ts/src/render/passes/prefix-sum.test.ts`
- Modify: `ts/src/render/passes/prefix-sum-reference.ts`

**Step 1: Write CPU reference test for subgroup-simulated prefix sum**

In `ts/src/render/passes/prefix-sum-reference.ts`, add after the existing function:

```typescript
/**
 * Simulates subgroup-accelerated exclusive scan.
 * Uses subgroup-sized chunks with intra-chunk scan + cross-chunk reduction.
 * CPU reference to verify the subgroup WGSL variant produces identical results.
 */
export function exclusiveScanSubgroupSimCPU(input: number[], subgroupSize: number): number[] {
  const n = input.length;
  if (n === 0) return [];
  const result = new Array(n).fill(0);

  // Phase 1: Intra-subgroup exclusive scan
  const numSubgroups = Math.ceil(n / subgroupSize);
  const subgroupTotals = new Array(numSubgroups).fill(0);

  for (let sg = 0; sg < numSubgroups; sg++) {
    let running = 0;
    for (let lane = 0; lane < subgroupSize; lane++) {
      const idx = sg * subgroupSize + lane;
      if (idx >= n) break;
      result[idx] = running;
      running += input[idx];
    }
    subgroupTotals[sg] = running;
  }

  // Phase 2: Cross-subgroup exclusive prefix sum
  const sgPrefixes = new Array(numSubgroups).fill(0);
  let running = 0;
  for (let sg = 0; sg < numSubgroups; sg++) {
    sgPrefixes[sg] = running;
    running += subgroupTotals[sg];
  }

  // Phase 3: Add subgroup prefix to each element
  for (let sg = 0; sg < numSubgroups; sg++) {
    for (let lane = 0; lane < subgroupSize; lane++) {
      const idx = sg * subgroupSize + lane;
      if (idx >= n) break;
      result[idx] += sgPrefixes[sg];
    }
  }

  return result;
}
```

**Step 2: Write test in prefix-sum.test.ts**

Add to `ts/src/render/passes/prefix-sum.test.ts`:

```typescript
import { exclusiveScanCPU, exclusiveScanSubgroupSimCPU } from './prefix-sum-reference';

describe('Subgroup-simulated prefix sum', () => {
  it('produces same result as Blelloch for simple input (sgSize=4)', () => {
    const input = [0, 1, 1, 0, 1, 0, 1, 1];
    const blelloch = exclusiveScanCPU(input);
    const subgroup = exclusiveScanSubgroupSimCPU(input, 4);
    expect(subgroup).toEqual(blelloch);
  });

  it('produces same result for all-visible (sgSize=32)', () => {
    const input = new Array(64).fill(1);
    expect(exclusiveScanSubgroupSimCPU(input, 32)).toEqual(exclusiveScanCPU(input));
  });

  it('produces same result for sparse visibility (sgSize=32)', () => {
    const input = new Array(256).fill(0);
    for (let i = 0; i < 256; i += 7) input[i] = 1;
    expect(exclusiveScanSubgroupSimCPU(input, 32)).toEqual(exclusiveScanCPU(input));
  });

  it('produces correct compacted indices (sgSize=8)', () => {
    const visibility = [0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0];
    const scan = exclusiveScanSubgroupSimCPU(visibility, 8);
    const compacted: number[] = [];
    for (let i = 0; i < visibility.length; i++) {
      if (visibility[i] === 1) compacted[scan[i]] = i;
    }
    expect(compacted).toEqual([1, 2, 4, 6, 7, 10]);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd ts && npx vitest run src/render/passes/prefix-sum.test.ts`
Expected: FAIL — `exclusiveScanSubgroupSimCPU` not exported.

**Step 4: Implement (already written in Step 1)**

Export the function from `prefix-sum-reference.ts`.

**Step 5: Run tests**

Run: `cd ts && npx vitest run src/render/passes/prefix-sum.test.ts`
Expected: All PASS.

**Step 6: Add subgroup entry point to prefix-sum.wgsl**

Append to `ts/src/shaders/prefix-sum.wgsl`:

```wgsl
// Subgroup-accelerated exclusive prefix sum.
// Uses subgroupExclusiveAdd for intra-subgroup scan,
// shared memory for inter-subgroup reduction.
// Requires `enable subgroups;` prepended at pipeline creation.

override SG_SIZE: u32 = 32u;

var<workgroup> sg_totals: array<u32, 8>;  // max 256/32 = 8 subgroups
var<workgroup> sg_prefixes: array<u32, 8>;

@compute @workgroup_size(256)
fn prefix_sum_subgroups(
    @builtin(global_invocation_id) gid: vec3u,
    @builtin(local_invocation_id) lid: vec3u,
    @builtin(workgroup_id) wid: vec3u,
) {
    let n = 256u * 2u;
    let offset = wid.x * n;
    let thid = lid.x;
    let sg_id = thid / SG_SIZE;
    let num_sg = (256u + SG_SIZE - 1u) / SG_SIZE;

    // Each thread processes 2 elements
    let val0 = data[offset + 2u * thid];
    let val1 = data[offset + 2u * thid + 1u];

    // Intra-subgroup exclusive scan (pairs flattened)
    let scan0 = subgroupExclusiveAdd(val0);
    let sg_total0 = subgroupAdd(val0);
    let scan1 = subgroupExclusiveAdd(val1);
    let sg_total1 = subgroupAdd(val1);

    // Subgroup leader writes total
    if (subgroupElect()) {
        sg_totals[sg_id] = sg_total0 + sg_total1;
    }
    workgroupBarrier();

    // Cross-subgroup prefix sum (single thread)
    if (thid == 0u) {
        var running = 0u;
        for (var s = 0u; s < num_sg; s = s + 1u) {
            sg_prefixes[s] = running;
            running += sg_totals[s];
        }
        blockSums[wid.x] = running;
    }
    workgroupBarrier();

    // Final write: intra-subgroup offset + subgroup prefix
    let prefix = sg_prefixes[sg_id];
    data[offset + 2u * thid] = prefix + scan0;
    data[offset + 2u * thid + 1u] = prefix + sg_total0 + scan1;
}
```

**Step 7: Commit**

```
feat(#14a): subgroup-accelerated prefix sum (CPU reference + WGSL entry point)
```

---

### Task 7: Upgrade detectSizedBindingArrays with real probing

**Files:**
- Modify: `ts/src/capabilities.ts:110-119`
- Modify: `ts/src/capabilities.test.ts:85-90`
- Modify: `ts/src/index.ts:48`

**Step 1: Write failing tests**

Replace the existing `detectSizedBindingArrays` describe block in `ts/src/capabilities.test.ts` (lines 85-90):

```typescript
describe("detectSizedBindingArrays", () => {
  it("returns supported=false and maxSize=0 when feature not available", () => {
    // Mock device whose createBindGroupLayout throws on bindingArraySize
    const mockDevice = {
      features: new Set(),
      createBindGroupLayout: () => { throw new Error("not supported"); },
    } as unknown as GPUDevice;
    const result = detectSizedBindingArrays(mockDevice);
    expect(result.supported).toBe(false);
    expect(result.maxSize).toBe(0);
  });

  it("returns supported=true when createBindGroupLayout accepts bindingArraySize", () => {
    // Mock device that accepts bindingArraySize without throwing
    const mockLayout = {};
    const mockDevice = {
      features: new Set(),
      createBindGroupLayout: () => mockLayout,
    } as unknown as GPUDevice;
    const result = detectSizedBindingArrays(mockDevice);
    expect(result.supported).toBe(true);
    expect(result.maxSize).toBeGreaterThanOrEqual(256);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd ts && npx vitest run src/capabilities.test.ts`
Expected: FAIL — `detectSizedBindingArrays` returns `boolean`, not object.

**Step 3: Implement**

In `ts/src/capabilities.ts`, replace lines 110-119:

```typescript
/**
 * Result of sized binding array feature detection.
 */
export interface SizedBindingArraySupport {
  supported: boolean;
  /** Maximum binding array size (0 if unsupported). Discovery is empirical. */
  maxSize: number;
}

/**
 * Detect WebGPU sized binding arrays support.
 * Uses try/catch on createBindGroupLayout with bindingArraySize.
 * W3C proposal hasn't finalized the limit name, so maxSize is probed empirically.
 */
export function detectSizedBindingArrays(device: GPUDevice): SizedBindingArraySupport {
  try {
    device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { bindingArraySize: 256 } as any,
      }],
    });
    // Probe max size: try 256, 512, 1024
    let maxSize = 256;
    for (const size of [512, 1024]) {
      try {
        device.createBindGroupLayout({
          entries: [{
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { bindingArraySize: size } as any,
          }],
        });
        maxSize = size;
      } catch {
        break;
      }
    }
    return { supported: true, maxSize };
  } catch {
    return { supported: false, maxSize: 0 };
  }
}
```

**Step 4: Update index.ts export**

In `ts/src/index.ts`, line 48 currently exports `detectSizedBindingArrays`. The return type changed from `boolean` to `SizedBindingArraySupport`. Also export the new type:

```typescript
export { detectCompressedFormat, detectSizedBindingArrays } from './capabilities';
export type { SizedBindingArraySupport } from './capabilities';
```

**Step 5: Run tests**

Run: `cd ts && npx vitest run src/capabilities.test.ts`
Expected: All PASS.

**Step 6: Type-check**

Run: `cd ts && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: No new errors (check that no code relies on `detectSizedBindingArrays` returning `boolean`).

**Step 7: Commit**

```
feat(#14a): detectSizedBindingArrays with real try/catch probing + empirical maxSize
```

---

### Task 8: Create basic-binding-array.wgsl shader variant (design artifact)

**Files:**
- Create: `ts/src/shaders/basic-binding-array.wgsl`

**Step 1: Write the shader variant**

Create `ts/src/shaders/basic-binding-array.wgsl`:

```wgsl
// Design artifact: sized binding array texture sampling.
// NOT wired into ForwardPass — documents the target WGSL structure
// for when browsers ship `bindingArraySize` in GPUBindGroupLayoutEntry.
//
// Current encoding: (overflow<<31) | (tier<<16) | layer
// Target encoding: flat global index [0, N)
//
// Migration path when activated:
// - TextureManager allocates individual texture_2d per texture (no Texture2DArray tiers)
// - ForwardPass bind group: 8 texture views (4 tiers + 4 overflow) -> 1 binding array
// - CullPass: no tier-based material bucketing needed
// - All 6 fragment shaders simplified: single texture_sample with flat index

@group(0) @binding(0) var<uniform> camera: mat4x4f;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> texIndices: array<u32>;

// Sized binding array: all textures in a single indexable binding
@group(1) @binding(0) var textures: binding_array<texture_2d<f32>, 256>;
@group(1) @binding(1) var texSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) texIndex: u32,
};

@vertex
fn vs_main(
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
    let entityIdx = visibleIndices[instanceIndex];
    let model = transforms[entityIdx];
    let texIdx = texIndices[entityIdx]; // flat global index [0, N)

    // Standard quad vertices (2 triangles)
    let quadPos = array<vec2f, 6>(
        vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5),
        vec2f(-0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5),
    );
    let quadUV = array<vec2f, 6>(
        vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
        vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(0.0, 0.0),
    );

    let pos = quadPos[vertexIndex];
    let worldPos = model * vec4f(pos, 0.0, 1.0);

    var out: VertexOutput;
    out.position = camera * worldPos;
    out.uv = quadUV[vertexIndex];
    out.texIndex = texIdx;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    // Single indexed texture sample — no tier/layer decomposition, no switch
    return textureSampleLevel(textures[in.texIndex], texSampler, in.uv, 0.0);
}
```

**Step 2: Verify no build impact**

Run: `cd ts && npx vitest run`
Expected: All tests still pass. File exists but isn't imported anywhere.

**Step 3: Commit**

```
feat(#14a): basic-binding-array.wgsl design artifact for sized binding array architecture
```

---

### Task 9: Full Phase 14a validation

**Files:** None (validation only)

**Step 1: Run all TypeScript tests**

Run: `cd ts && npm test`
Expected: All tests PASS (721+ existing + new tests from Tasks 1-8).

**Step 2: Run Rust tests (no changes expected)**

Run: `cargo test -p hyperion-core`
Expected: All 155 tests PASS.

**Step 3: Run Rust clippy**

Run: `cargo clippy -p hyperion-core`
Expected: No warnings.

**Step 4: Type-check**

Run: `cd ts && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`
Expected: No new errors.

**Step 5: Commit (if any fixups needed)**

```
chore(#14a): Phase 14a validation pass
```

---

## Phase 14b: Loro CRDT Feasibility Spike

### Task 10: Spike 0 — Loro crate feature flag audit

**Files:** None (research only)

**Step 1: Inspect Loro crate on crates.io**

Run: `cargo search loro --limit 5`

Then inspect the Cargo.toml:

Run: `cargo install --list 2>/dev/null; curl -sL "https://crates.io/api/v1/crates/loro/versions" | head -20`

Alternatively, clone or read the Cargo.toml from the loro repo to check for `[features]`:

Run: `curl -sL "https://raw.githubusercontent.com/loro-dev/loro/main/crates/loro/Cargo.toml" | head -40`

**Step 2: Document findings**

Create a brief note at the top of the loro-spike crate (next task) documenting:
- Which feature flags exist (if any)
- Whether per-container selection is possible
- Impact on binary size strategy

**Step 3: No commit (findings folded into Task 11)**

---

### Task 11: Create loro-spike crate

**Files:**
- Create: `crates/loro-spike/Cargo.toml`
- Create: `crates/loro-spike/src/lib.rs`
- Modify: `Cargo.toml` (workspace members)

**Step 1: Create crate directory**

Run: `mkdir -p crates/loro-spike/src`

**Step 2: Write Cargo.toml**

Create `crates/loro-spike/Cargo.toml`:

```toml
[package]
name = "loro-spike"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
loro = "1"   # Adjust version based on Spike 0 findings
js-sys = "0.3"

[profile.release]
opt-level = "z"  # Optimize for size
lto = "fat"
codegen-units = 1
```

> **Note to implementer:** The `loro` version must be verified in Spike 0. If per-container feature flags exist, use them: `loro = { version = "1", default-features = false, features = ["map", "list"] }`.

**Step 3: Write minimal lib.rs**

Create `crates/loro-spike/src/lib.rs`:

```rust
use wasm_bindgen::prelude::*;
use loro::LoroDoc;

/// Create a new LoroDoc and return a handle.
/// The doc is stored in a thread-local for later access.
#[wasm_bindgen]
pub fn create_doc() -> u32 {
    let doc = LoroDoc::new();
    DOCS.with(|docs| {
        let mut docs = docs.borrow_mut();
        let id = docs.len() as u32;
        docs.push(doc);
        id
    })
}

/// Apply N map-insert operations to a doc (simulating entity spawns).
#[wasm_bindgen]
pub fn apply_operations(doc_id: u32, count: u32) {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = &docs[doc_id as usize];
        let map = doc.get_map("entities");
        for i in 0..count {
            let key = format!("entity_{}", i);
            map.insert(&key, i as f64).unwrap();
        }
    });
}

/// Export all updates as bytes.
#[wasm_bindgen]
pub fn export_updates(doc_id: u32) -> Vec<u8> {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = &docs[doc_id as usize];
        doc.export(loro::ExportMode::Updates {
            from: &Default::default(),
        })
    })
}

/// Import updates from bytes into a doc.
#[wasm_bindgen]
pub fn import_updates(doc_id: u32, data: &[u8]) {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = &docs[doc_id as usize];
        doc.import(data).unwrap();
    });
}

thread_local! {
    static DOCS: std::cell::RefCell<Vec<LoroDoc>> = std::cell::RefCell::new(Vec::new());
}
```

> **Note to implementer:** The Loro API may differ from what's shown. Check the actual `loro` crate docs before implementing. The key operations needed are: create doc, get/create Map container, insert values, export updates, import updates. Adjust API calls to match the actual crate version.

**Step 4: Add to workspace**

In `Cargo.toml` (root), update members:

```toml
[workspace]
resolver = "2"
members = ["crates/hyperion-core", "crates/loro-spike"]
```

**Step 5: Verify it compiles natively**

Run: `cargo build -p loro-spike`
Expected: Compiles (possibly with warnings about API mismatches — fix as needed).

**Step 6: Commit**

```
feat(#14b): loro-spike crate with minimal WASM surface for feasibility testing
```

---

### Task 12: Spike 1 — Binary size + instantiation benchmark

**Files:**
- Create: `ts/src/loro-bench.test.ts`

**Step 1: Build loro-spike to WASM**

Run: `wasm-pack build crates/loro-spike --target web --out-dir ../../ts/loro-spike-wasm`

Run: `wasm-opt -Oz --strip-debug --strip-producers --vacuum --remove-unused-module-elements ts/loro-spike-wasm/loro_spike_bg.wasm -o ts/loro-spike-wasm/loro_spike_opt.wasm`

Run: `gzip -9 -k ts/loro-spike-wasm/loro_spike_opt.wasm && ls -la ts/loro-spike-wasm/loro_spike_opt.wasm.gz`

**Step 2: Record binary sizes**

Run: `ls -la ts/loro-spike-wasm/loro_spike_bg.wasm ts/loro-spike-wasm/loro_spike_opt.wasm ts/loro-spike-wasm/loro_spike_opt.wasm.gz`

**Step 3: Decision gate**

- < 120KB gzipped → proceed
- 120-150KB → proceed with warning
- \> 150KB → stop, document, evaluate alternatives

**Step 4: Write instantiation benchmark test**

Create `ts/src/loro-bench.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// Note: This test requires the loro-spike WASM to be built first.
// Run: wasm-pack build crates/loro-spike --target web --out-dir ../../ts/loro-spike-wasm

describe('Loro CRDT Feasibility Spike', () => {
  describe('Spike 1: Binary size', () => {
    it('documents binary size (manual verification)', () => {
      // This test documents the binary size findings.
      // Actual sizes are measured via CLI commands above.
      // Record findings here after measurement:
      const findings = {
        rawWasm: 0,       // bytes — fill after build
        wasmOpt: 0,       // bytes — fill after wasm-opt
        gzipped: 0,       // bytes — fill after gzip -9
        target: 120_000,  // 120KB budget
        verdict: 'pending' as 'pass' | 'warning' | 'fail' | 'pending',
      };
      console.log('Loro binary size findings:', findings);
      // Uncomment after filling in values:
      // expect(findings.gzipped).toBeLessThan(findings.target);
    });
  });

  describe('Spike 1: Instantiation latency', () => {
    it.skip('measures WASM instantiation + first doc creation', async () => {
      // Unskip after loro-spike WASM is built
      const t0 = performance.now();
      const module = await import('../loro-spike-wasm/loro_spike.js');
      await module.default();
      const t1 = performance.now();
      const docId = module.create_doc();
      const t2 = performance.now();
      module.apply_operations(docId, 1);
      const t3 = performance.now();

      console.log(`WASM instantiate: ${(t1 - t0).toFixed(2)}ms`);
      console.log(`First create_doc: ${(t2 - t1).toFixed(2)}ms`);
      console.log(`First operation: ${(t3 - t2).toFixed(2)}ms`);
      console.log(`Total startup: ${(t3 - t0).toFixed(2)}ms`);

      expect(t3 - t0).toBeLessThan(100); // < 100ms desktop target
    });
  });
});
```

**Step 5: Run test**

Run: `cd ts && npx vitest run src/loro-bench.test.ts`
Expected: Size test passes (no assertion yet), instantiation test skipped.

**Step 6: Commit**

```
feat(#14b): Spike 1 binary size + instantiation benchmark scaffold
```

---

### Task 13: Spike 2 — Merge latency benchmark

**Files:**
- Modify: `ts/src/loro-bench.test.ts`

**Step 1: Add merge latency tests**

Append to `ts/src/loro-bench.test.ts`:

```typescript
  describe('Spike 2: Merge latency', () => {
    it.skip('measures merge latency for 100 concurrent operations', async () => {
      const module = await import('../loro-spike-wasm/loro_spike.js');
      await module.default();

      const docA = module.create_doc();
      const docB = module.create_doc();

      // Peer A: 100 operations
      module.apply_operations(docA, 100);
      const updatesA = module.export_updates(docA);

      // Peer B: 100 different operations
      module.apply_operations(docB, 100);

      // Merge A's updates into B
      const t0 = performance.now();
      module.import_updates(docB, updatesA);
      const t1 = performance.now();

      console.log(`Merge 100 ops: ${(t1 - t0).toFixed(3)}ms`);
      console.log(`Update size: ${updatesA.length} bytes`);
      expect(t1 - t0).toBeLessThan(1); // < 1ms target
    });

    it.skip('measures merge latency scaling (100, 1000, 10000)', async () => {
      const module = await import('../loro-spike-wasm/loro_spike.js');
      await module.default();

      for (const count of [100, 1000, 10000]) {
        const docA = module.create_doc();
        const docB = module.create_doc();

        module.apply_operations(docA, count);
        const updatesA = module.export_updates(docA);

        module.apply_operations(docB, count);

        const runs = 5;
        const times: number[] = [];
        for (let r = 0; r < runs; r++) {
          const freshB = module.create_doc();
          module.apply_operations(freshB, count);
          const t0 = performance.now();
          module.import_updates(freshB, updatesA);
          const t1 = performance.now();
          times.push(t1 - t0);
        }

        times.sort((a, b) => a - b);
        const p50 = times[Math.floor(runs * 0.5)];
        const p99 = times[runs - 1];
        console.log(`Merge ${count} ops — p50: ${p50.toFixed(3)}ms, p99: ${p99.toFixed(3)}ms, size: ${updatesA.length}B`);
      }
    });
  });
```

**Step 2: Run test**

Run: `cd ts && npx vitest run src/loro-bench.test.ts`
Expected: All skip (can't run without WASM), non-skip tests pass.

**Step 3: Commit**

```
feat(#14b): Spike 2 merge latency benchmark (100/1K/10K ops with p50/p99)
```

---

### Task 14: Spike 3 — Bidirectional data flow + mapping table

**Files:**
- Modify: `ts/src/loro-bench.test.ts`

**Step 1: Add bidirectional round-trip tests**

Append to `ts/src/loro-bench.test.ts`:

```typescript
  describe('Spike 3: Bidirectional data flow', () => {
    // Draft mapping table (deliverable of this spike):
    //
    // | CommandType     | Loro Operation                              | Loro Delta Event           | Reverse CommandType |
    // |----------------|---------------------------------------------|----------------------------|---------------------|
    // | SpawnEntity    | map.getOrCreateContainer(id, "Map")         | MapDiff: containerCreated  | SpawnEntity         |
    // | SetPosition    | entityMap.set("pos_x", x); .set("pos_y", y)| MapDiff: fieldUpdated x2   | SetPosition         |
    // | SetVelocity    | entityMap.set("vel_x", x); .set("vel_y", y)| MapDiff: fieldUpdated x2   | SetVelocity         |
    // | SetScale       | entityMap.set("sx", x); .set("sy", y)      | MapDiff: fieldUpdated x2   | SetScale            |
    // | DestroyEntity  | map.delete(id)                              | MapDiff: fieldDeleted      | DestroyEntity       |
    //
    // Trade-off: scalar fields (pos_x/pos_y) chosen over array [x,y] because:
    // - Individual field updates generate smaller deltas (only changed axis)
    // - Merge conflicts resolve per-field (last-writer-wins on x and y independently)
    // - Array would merge at container level (entire position replaced on conflict)

    it.skip('outbound: CommandType -> LoroDoc -> export', async () => {
      const module = await import('../loro-spike-wasm/loro_spike.js');
      await module.default();

      const docId = module.create_doc();
      // Simulate SpawnEntity + SetPosition
      // Implementation depends on actual Loro API — adjust as needed
      module.apply_operations(docId, 1);
      const updates = module.export_updates(docId);
      expect(updates.length).toBeGreaterThan(0);
    });

    it.skip('inbound: import -> delta events -> reconstruct commands', async () => {
      const module = await import('../loro-spike-wasm/loro_spike.js');
      await module.default();

      // Create source doc with operations
      const srcDoc = module.create_doc();
      module.apply_operations(srcDoc, 5);
      const updates = module.export_updates(srcDoc);

      // Import into target doc
      const tgtDoc = module.create_doc();
      module.import_updates(tgtDoc, updates);

      // Verify data round-tripped
      // (Exact verification depends on Loro subscription API)
      expect(updates.length).toBeGreaterThan(0);
    });

    it.skip('full round-trip: command -> loro -> export -> import -> command', async () => {
      const module = await import('../loro-spike-wasm/loro_spike.js');
      await module.default();

      // This test validates the complete bidirectional mapping.
      // Implementer: expand with actual RingBufferProducer integration
      // for the 5 command types listed in the mapping table above.
      const docA = module.create_doc();
      module.apply_operations(docA, 10);
      const updates = module.export_updates(docA);

      const docB = module.create_doc();
      module.import_updates(docB, updates);
      const reExported = module.export_updates(docB);

      // Both docs should have same state
      expect(reExported.length).toBeGreaterThan(0);
    });
  });
```

**Step 2: Run test**

Run: `cd ts && npx vitest run src/loro-bench.test.ts`
Expected: All Spike 3 tests skip, rest pass.

**Step 3: Commit**

```
feat(#14b): Spike 3 bidirectional data flow tests + draft CommandType mapping table
```

---

### Task 15: Execute Loro spikes and record results

**Files:**
- Create: `docs/plans/2026-03-06-phase14b-loro-results.md`

**Step 1: Build and measure (Spike 0 + Spike 1)**

Run: `wasm-pack build crates/loro-spike --target web --out-dir ../../ts/loro-spike-wasm --release`

Run: `wasm-opt -Oz --strip-debug --strip-producers --vacuum --remove-unused-module-elements ts/loro-spike-wasm/loro_spike_bg.wasm -o ts/loro-spike-wasm/loro_spike_opt.wasm`

Run: `gzip -9 -k ts/loro-spike-wasm/loro_spike_opt.wasm`

Run: `ls -la ts/loro-spike-wasm/loro_spike_bg.wasm ts/loro-spike-wasm/loro_spike_opt.wasm ts/loro-spike-wasm/loro_spike_opt.wasm.gz`

Record sizes in the results doc.

**Step 2: Unskip and run benchmarks (Spike 2 + 3)**

If Spike 1 passes the decision gate (< 150KB), unskip the `.skip` tests and run:

Run: `cd ts && npx vitest run src/loro-bench.test.ts`

Record all numbers.

**Step 3: Write results document**

Create `docs/plans/2026-03-06-phase14b-loro-results.md` with:
- Spike 0: Feature flag audit findings
- Spike 1: Binary size (raw, wasm-opt, gzipped) + instantiation latency
- Spike 2: Merge latency curve (100/1K/10K) with p50/p99 + export size
- Spike 3: Round-trip verification results + finalized mapping table
- **Verdict: GO / NO-GO** with reasoning

**Step 4: Commit**

```
docs(#14b): Loro CRDT feasibility spike results with go/no-go verdict
```

---

### Task 16: Final validation + CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Run full validation pipeline**

Run: `cargo test -p hyperion-core && cargo clippy -p hyperion-core && cd ts && npm test && npx tsc --noEmit 2>&1 | grep -v "wasm/hyperion_core"`

Expected: All pass.

**Step 2: Update CLAUDE.md**

Add Phase 14 to the Implementation Status table. Update test counts. Add new files to the Architecture section. Add any new gotchas discovered during implementation.

**Step 3: Commit**

```
docs: update CLAUDE.md with Phase 14 tech integrations
```
