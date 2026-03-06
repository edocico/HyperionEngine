# Phase 14: Tech Integrations 2026 — Design Document

> **Date**: 2026-03-06
> **Scope**: Masterplan §15 — Core 3 items (Subgroups v2, Sized Binding Arrays, CRDT/Loro)
> **Structure**: Phase 14a (GPU wins, ~3-4 days) + Phase 14b (Loro feasibility spike, ~2-3 days)
> **Prerequisite**: Phase 13 complete (155 Rust tests, 721 TS tests, 48KB WASM gzipped)

---

## Approach Decision

Three items selected from §15's five candidates:

| Item | Priority | Phase | Rationale |
|------|----------|-------|-----------|
| 15.1 Subgroups v2 (builtins + prefix-sum) | Critical | 14a | Guaranteed 2x cull perf on supported hardware |
| 15.2 Sized Binding Arrays (detection + arch) | Medium | 14a | Low-cost prep for future browser feature |
| 15.3 CRDT/Loro (feasibility spike) | Strategic | 14b | Highest-risk item needs empirical validation |

Excluded: 15.4 Wasm Memory64 (10-100% perf penalty, no benefit <4GB), 15.5 WebNN (browser adoption ~0%).

Split into 14a/14b because the GPU work and CRDT spike are completely orthogonal — different files, different concerns, different risk profiles. If Loro fails budget, 14a is already done and merged.

---

## Phase 14a: Subgroups v2 + Sized Binding Arrays

### Track 1: Subgroups v2 — Builtins + Prefix-Sum Compaction

**Goal**: Cull time 100k entities from ~0.8ms to <0.4ms by replacing atomic scatter with subgroup prefix-sum compaction.

**Current state**: The base CullPass path (cull.wgsl:146-156) uses per-entity `atomicAdd(&drawArgs[argSlot].instanceCount, 1)` for scatter. The `USE_SUBGROUPS` path (cull.wgsl:113-145) reduces this to per-subgroup batched atomics via `subgroupExclusiveAdd` + `subgroupElect()` + `subgroupBroadcastFirst()`. Neither path uses the standalone prefix-sum.wgsl. The 24-bucket layout (6 prim types x 2 material buckets x 2 blend modes) is already in place (cull.wgsl:19-20, cull-pass.ts:22).

#### 1. Detection Upgrade (capabilities.ts)

`SubgroupSupport` gains `hasSubgroupId: boolean`:

```typescript
export interface SubgroupSupport {
  supported: boolean;
  hasSubgroupId: boolean;
}

export function detectSubgroupSupport(
  adapterFeatures: ReadonlySet<string>,
): SubgroupSupport {
  return {
    supported: adapterFeatures.has('subgroups'),
    hasSubgroupId: !!(navigator.gpu as any)?.wgslLanguageFeatures?.has('subgroup_id'),
  };
}
```

When `hasSubgroupId` is true, the shader uses `@builtin(subgroup_id)` and `@builtin(num_subgroups)` directly, eliminating the implicit identity pattern via `subgroupElect()`.

#### 2. CullPass Strategy Change: Batched Atomics -> Shared-Memory Prefix-Sum Compaction

Current subgroup path: `subgroupExclusiveAdd(vote)` gives intra-subgroup offsets, but inter-subgroup coordination still uses `atomicAdd` (1 atomic per subgroup per bucket — 24 buckets x 8 subgroups = 192 atomics/workgroup at max visibility).

New subgroup path:

- **Intra-subgroup**: `subgroupExclusiveAdd(u32(visible && match))` produces per-subgroup compact offsets (unchanged)
- **Cross-subgroup**: Per-bucket subgroup totals written to `var<workgroup>` array indexed by `@builtin(subgroup_id)`. Shared-memory exclusive scan across subgroups (log2(256/SUBGROUP_SIZE) = 3 barriers for NVIDIA 32-wide, 2 for AMD 64-wide) replaces global atomics entirely
- **Final scatter**: Deterministic — each thread knows global offset = `workgroup_base + subgroup_prefix + intra_subgroup_offset`
- **Workgroup base**: Single `atomicAdd` per workgroup per active bucket (down from per-subgroup). This is the only remaining atomic.

This operates per-bucket across all 24 existing buckets (6 prim types x 2 material buckets x 2 blend modes).

**Workgroup size**: Remains 256. Cross-subgroup reduction handles 4-8 subgroups (AMD/NVIDIA) via shared memory — 2-3 barriers.

**Performance model**: The gain is proportional to visibility ratio and active bucket count. At 80%+ visibility with all buckets active, atomic contention on global drawArgs dominates — reduction from ~75k atomics (391 workgroups x 192 atomics/wg) to ~9.4k (391 x 24 active buckets) yields ~8x less contention. At 20% visibility with 2-3 active buckets, baseline atomics are already fast and the gain is marginal. The `GPUComputePassTimestampWrites` benchmark must test both high-visibility (>80%, all prim types) and low-visibility (<20%, single prim type) scenarios.

#### 3. prepareShaderSource() Extended (cull-pass.ts)

Handles 3 levels:
- Base: no directives
- Subgroups: prepend `enable subgroups;\n`
- Subgroups + subgroup_id: prepend `enable subgroups;\nrequires subgroup_id;\n`

New override constant: `USE_SUBGROUP_ID: bool = false`.

#### 4. Standalone prefix-sum.wgsl Upgrade

New entry point `prefix_sum_subgroups` alongside existing `prefix_sum_main`:
- Intra-subgroup via `subgroupExclusiveAdd()`
- Inter-subgroup via shared memory reduction
- For use in multi-dispatch scenarios (e.g., future radix sort subgroup path)
- CullPass inlines its own scan directly — prefix-sum.wgsl is a reusable building block

### Track 2: Sized Binding Arrays — Detection + Architecture Prep

**Goal**: Ready-to-activate architecture for when browsers ship `bindingArraySize`.

#### 1. Detection (capabilities.ts)

`detectSizedBindingArrays()` upgraded from stub:

```typescript
export interface SizedBindingArraySupport {
  supported: boolean;
  maxSize: number;  // 0 if unsupported
}

export function detectSizedBindingArrays(device: GPUDevice): SizedBindingArraySupport {
  // Try/catch — API shape not finalized in W3C proposal
  try {
    device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { bindingArraySize: 256 } as any,
      }],
    });
    // If we reach here, feature is supported. Probe maxSize.
    // W3C proposal hasn't finalized the limit name.
    // Empirical probing: try 256, 512, 1024 with fallback.
    return { supported: true, maxSize: probeSizedArrayLimit(device) };
  } catch {
    return { supported: false, maxSize: 0 };
  }
}
```

Note: `maxSize` discovery is uncertain — W3C proposal hasn't finalized the limit name. If no explicit device limit exists, use empirical probing (try 256, 512, 1024) with fallback to 256.

#### 2. Shader Variant Design (new: shaders/basic-binding-array.wgsl)

Read-only design artifact — NOT wired into ForwardPass:

```wgsl
// Design artifact for sized binding arrays (not active).
// Documents the target WGSL structure for when browsers ship bindingArraySize.
@group(2) @binding(0) var textures: binding_array<texture_2d<f32>, 256>;
@group(2) @binding(1) var texSampler: sampler;
```

Sampling via flat global index instead of tier+layer decomposition. Documents the encoding change: from packed `(overflow<<31)|(tier<<16)|(layer)` (current, per cull.wgsl:105) to flat global index `[0, N)`.

#### 3. TextureManager Migration Path (documented, not implemented)

When activated:
- Individual `texture_2d` per texture instead of `Texture2DArray` tiers
- ForwardPass bind group layout: 8 texture views (4 tiers + 4 overflow) -> 1 binding array
- CullPass material bucket logic simplified: no tier-based bucketing needed

### 14a Success Criteria

- **Subgroups v2**: Cull pass uses `subgroup_id` builtins on Chrome 144+, shared-memory prefix-sum replaces inter-subgroup atomics. Measurable via `GPUComputePassTimestampWrites` (primary), `performance.now()` CPU-side (secondary). Benchmark both high-visibility (>80%) and low-visibility (<20%) scenarios.
- **Sized Binding Arrays**: Detection probes real device capabilities, shader variant documents target WGSL structure, zero dead code in production bundle.

---

## Phase 14b: Loro CRDT Feasibility Spike

**Goal**: Empirical validation of four hard numbers before committing to CrdtBridge architecture: binary size, instantiation latency, merge latency, bidirectional data flow.

### Spike 0: Loro Crate Feature Flag Audit (pre-step, no code)

Before writing any code, inspect the `loro` crate:

- Check `Cargo.toml` on crates.io for per-container feature flags
- If per-container flags exist: configure Map + List only for Spike 1
- If they don't (expected — Loro's containers share a monolithic OpLog/Eg-walker core): Spike 1 tests the full crate, relying on `wasm-opt` dead-code elimination as the sole size reduction strategy

This changes the decision gate: if Loro is monolithic and over budget, the fallback isn't "tree-shake containers" but rather evaluate forking Loro to strip containers at source level, or pivot to alternatives (Yjs WASM, Automerge, custom delta protocol).

### Spike 1: Binary Budget + Instantiation Latency

**Targets**:
- Binary: < 120KB gzipped (masterplan 15.3)
- Instantiation: < 100ms desktop, < 300ms mobile

**Method**:
- Create `crates/loro-spike/` — standalone crate, NOT integrated into `hyperion-core`
- Depend on `loro` with feature flags from Spike 0 findings (or full crate if monolithic)
- Expose minimal WASM surface: `create_doc()`, `apply_op()`, `export_updates()`, `import_updates()`
- Build: `wasm-pack --target web` -> `wasm-opt -Oz --strip-debug --strip-producers --vacuum --remove-unused-module-elements` -> `gzip -9`
- Record: raw `.wasm`, post-wasm-opt, gzipped. If monolithic, also measure how much `--remove-unused-module-elements` recovers
- Instantiation benchmark (`ts/src/loro-bench.test.ts`): `performance.now()` around `WebAssembly.instantiate()` + first `create_doc()` + first operation

**Decision gate**:
- < 120KB gzipped -> proceed to Spike 2
- 120-150KB gzipped -> proceed but document that CrdtBridge design must account for budget overshoot (lazy loading mandatory, possible fork needed)
- \> 150KB gzipped -> evaluate alternatives (Yjs WASM, Automerge, custom delta protocol), document findings, stop phase 14b

### Spike 2: Merge Latency Validation

**Targets**: < 1ms merge for 100 concurrent operations, < 5KB/s at typical edit rates.

**Method** (TypeScript benchmark in `ts/src/loro-bench.test.ts`):
- Two LoroDoc instances (peer A, peer B)
- Peer A: batch N operations (Map inserts for entity spawns, nested field sets for component updates)
- Peer B: batch N different concurrent operations
- Export A's updates -> import into B, `performance.now()` around merge
- Scale: N = 100, 1000, 10000 — record p50/p99 merge time
- Measure `export_updates()` byte size per operation count (validates < 5KB/s claim)

### Spike 3: Bidirectional Data Flow (Loopback)

**Target**: Prove that the Loro <-> CommandType mapping is lossless in both directions.

**Outbound (local action -> Loro -> delta)**:
- Create a CommandType programmatically (e.g., `SetPosition(entity_42, 100.0, 200.0)`)
- Write the equivalent into a LoroDoc (mapping to be determined by this spike)
- Export the update bytes

**Inbound (delta -> Loro -> CommandType -> RingBuffer)**:
- Import exported update into a second LoroDoc
- Subscribe to Loro change events, translate delta back to CommandType
- Feed into RingBufferProducer -> read back with consumer logic
- Assert: reconstructed command matches the original

**Full round-trip verification**: Test >= 5 command types (SpawnEntity, SetPosition, SetVelocity, SetScale, DestroyEntity). Verify bidirectional lossless mapping.

**Key deliverable**: Draft mapping table (CommandType -> Loro operation -> Loro delta -> CommandType) for all 5 tested command types. This table becomes the input specification for the future CrdtBridge design. The spike validates that a lossless mapping exists; the table documents the specific mapping chosen and its trade-offs (e.g., scalar fields vs array containers for position, granularity of merge conflict resolution).

### What Phase 14b Does NOT Do

- No CrdtBridge abstraction (future phase)
- No networking (WebSocket/WebRTC)
- No command range 64-79 reservation
- No integration with hyperion-core or engine.rs
- No Loro Text or Tree containers (validate Map + List only)

### 14b Output Artifacts

- `crates/loro-spike/` — standalone Rust crate with minimal Loro wrapper
- `ts/src/loro-bench.test.ts` — benchmark suite (binary size, instantiation, merge latency, bidirectional round-trip)
- `docs/plans/2026-03-06-phase14b-loro-results.md` — results document with go/no-go verdict, all measured numbers, and draft CommandType mapping table

### 14b Success Criteria

- Spike 0: Feature flag audit documented
- Spike 1: Binary size number + instantiation latency (desktop/mobile)
- Spike 2: Merge latency curve (100/1K/10K ops) with p50/p99 + export size per op
- Spike 3: Bidirectional command round-trip (>= 5 command types, lossless) + draft mapping table
- Clear go/no-go verdict for proceeding to CrdtBridge implementation
