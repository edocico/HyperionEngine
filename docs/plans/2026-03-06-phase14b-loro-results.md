# Phase 14b: Loro CRDT Feasibility Spike Results

## Spike 0: Feature Flag Audit

- Feature flags: `counter`, `jsonpath`, `logging` (all optional, none help with size)
- Container cherry-picking: NOT possible (monolithic)
- Heavy mandatory deps: pest, im, serde, parking_lot, rand, md5, xxhash-rust, lz4_flex, postcard, serde_columnar, generic-btree, quick_cache
- Total transitive dependencies: 127 crates (vs hyperion-core's ~20)

## Spike 1: Binary Size

| Metric | Value |
|--------|-------|
| Raw WASM (wasm-pack release) | 1,898,500 bytes (1,854 KB) |
| wasm-opt -Oz (strip+vacuum) | 1,887,478 bytes (1,843 KB) |
| Gzipped (optimized) | 680,554 bytes (664 KB) |
| Budget | 120,000 bytes (120 KB) |
| hyperion-core (comparison) | 59,769 bytes (58 KB) gzipped |
| **Over budget by** | **547 KB (5.7x)** |
| **Verdict** | **FAIL** |

### Analysis

- The minimal Loro spike (4 exported functions, no business logic) produces a 664KB gzipped WASM binary
- This is **5.7x** the 120KB total WASM budget for the entire engine
- Loro alone is **11.4x** larger than hyperion-core (58KB gzipped), which contains the full ECS + ring buffer + systems + render state
- wasm-opt second pass has negligible effect (~0.6% size reduction) because wasm-pack already runs wasm-opt internally in release mode
- No feature flags exist that could reduce the core CRDT binary size
- The monolithic architecture means even unused containers (List, Text, Tree, MovableList) are included

### Dependency Weight Breakdown (estimated contribution)

The heaviest transitive deps are:
- `im` (persistent data structures) — core to CRDT internals
- `pest` / `pest_derive` — parser generator, used for query/path syntax
- `serde` + `serde_json` + `serde_columnar` + `postcard` — serialization framework
- `parking_lot` — sync primitives (unnecessary on wasm32 but still compiled)
- `rand` + `rand_chacha` + `rand_xoshiro` — RNG for peer IDs
- `lz4_flex` — compression for snapshots
- `generic-btree` — B-tree for ordered sequences

## Spike 2: Merge Latency

Skipped — binary size verdict is "fail", making merge latency measurements moot for integration decision. The WASM module was built successfully and merge benchmarks are scaffolded in `ts/src/loro-bench.test.ts` for future reference if a JS-only Loro path is explored.

## Spike 3: Bidirectional Data Flow

### Draft Mapping Table

| CommandType | Loro Operation | Loro Delta Event | Reverse CommandType |
|---|---|---|---|
| SpawnEntity | `map.getOrCreateContainer(id, "Map")` | MapDiff: containerCreated | SpawnEntity |
| SetPosition | `entityMap.insert("pos_x", x)` x3 | MapDiff: fieldUpdated x3 | SetPosition |
| SetVelocity | `entityMap.insert("vel_x", x)` x3 | MapDiff: fieldUpdated x3 | SetVelocity |
| SetScale | `entityMap.insert("sx", x)` x3 | MapDiff: fieldUpdated x3 | SetScale |
| SetRotation | `entityMap.insert("qx/qy/qz/qw", v)` x4 | MapDiff: fieldUpdated x4 | SetRotation |
| SetTexture | `entityMap.insert("tex", layer)` | MapDiff: fieldUpdated | SetTexture |
| SetParent | `entityMap.insert("parent", parentId)` | MapDiff: fieldUpdated | SetParent |
| DestroyEntity | `map.delete(id)` | MapDiff: fieldDeleted | DestroyEntity |

### Concerns

1. **Operation amplification**: A single `SetPosition` (12 bytes in ring buffer) becomes 3 Loro map operations with full CRDT metadata (peer ID, Lamport timestamp, etc.). At 10k entities moving per frame, that is 30k Loro ops/frame.
2. **No binary path**: Loro's Map uses string keys and LoroValue (tagged union). No way to batch-insert raw `[f32; 3]` without per-field overhead.
3. **Memory overhead**: Each Loro MapContainer maintains full version vectors, operation logs, and undo history. For 10k entities with 5+ fields each, this is substantial.

## Recommendation

**Loro in WASM is not viable for Hyperion.** At 664KB gzipped, it exceeds the entire engine WASM budget by 5.7x with zero business logic included.

### Alternative Approaches for Multiplayer/Collaboration

1. **Loro JS-only (loro-crdt npm package)**: Use the official JS/WASM bundle maintained by Loro team, loaded as a separate module. This avoids bloating hyperion-core but adds a second WASM module (~600KB). Acceptable for apps that opt into multiplayer.

2. **Custom delta protocol**: Implement a lightweight last-writer-wins register per entity using the existing `CommandTape` infrastructure. Binary diff of ring-buffer commands between peers. No CRDT conflict resolution, but sufficient for authoritative-server topologies.

3. **Yjs via y-wasm**: Similar CRDT library but potentially smaller footprint. Worth a spike if CRDT semantics are required.

4. **Application-layer integration**: Expose a `Hyperion.onCommand` hook that lets the application layer route commands to any sync library (Loro JS, Yjs, Automerge) without baking it into the engine WASM.

**Recommended path**: Option 4 (hook-based) for the engine, with Option 1 (Loro JS) as an optional plugin for applications that need CRDT semantics.
