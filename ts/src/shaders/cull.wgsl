// GPU frustum culling compute shader with per-primitive-type grouping,
// opaque/transparent split, and temporal culling coherence.
// Dispatched with ceil(totalEntities / 256) workgroups.
// SoA layout: separate transforms, bounds, and renderMeta buffers.
//
// Temporal culling: entities that were visible last frame and haven't moved
// (not dirty) skip the bounds read entirely — the main bandwidth saving.
// A camera teleport sets the invalidate_all flag to force full re-cull.
//
// Pipeline override constants enable a subgroup-accelerated path.
// When USE_SUBGROUPS is true, `enable subgroups;` must be prepended
// at pipeline creation time (WGSL validation fails otherwise).

override USE_SUBGROUPS: bool = false;
override SUBGROUP_SIZE: u32 = 32u;
override USE_SUBGROUP_ID: bool = false;

const NUM_PRIM_TYPES: u32 = 6u;
const BUCKETS_PER_TYPE: u32 = 2u;   // bucket 0 = tier0 compressed, bucket 1 = other tiers
const OPAQUE_BUCKETS: u32 = NUM_PRIM_TYPES * BUCKETS_PER_TYPE;   // 12
const TOTAL_BUCKETS: u32 = OPAQUE_BUCKETS * 2u;                  // 24 (12 opaque + 12 transparent)

struct CullUniforms {
    frustumPlanes: array<vec4f, 6>,
    totalEntities: u32,
    maxEntitiesPerType: u32,  // MAX_ENTITIES — region size per type
    flags: u32,               // bit 0: invalidate_all (force full frustum test)
    _pad1: u32,
};

// Per-type-bucket indirect draw args. Packed as 24 consecutive DrawIndirectArgs
// (12 opaque + 12 transparent: each set = 6 prim types x 2 material buckets).
struct DrawIndirectArgs {
    indexCount: u32,
    instanceCount: atomic<u32>,
    firstIndex: u32,
    baseVertex: u32,
    firstInstance: u32,
};

// Group 0: existing SoA + indirect args
@group(0) @binding(0) var<uniform> cull: CullUniforms;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> bounds: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(4) var<storage, read_write> drawArgs: array<DrawIndirectArgs, 24>;
@group(0) @binding(5) var<storage, read> renderMeta: array<u32>;  // 2 u32/entity: [mesh, prim|flags]
@group(0) @binding(6) var<storage, read> texIndices: array<u32>;  // packed tex index per entity

// Group 1: temporal culling buffers
@group(1) @binding(0) var<storage, read> visibility_prev: array<u32>;
@group(1) @binding(1) var<storage, read> dirty_bits: array<u32>;
@group(1) @binding(2) var<storage, read_write> visibility_out: array<atomic<u32>>;

// Shared memory for subgroup prefix-sum compaction.
// Reduces global atomics from 192/workgroup (24 buckets × 8 subgroups) to
// at most 24/workgroup (one per active bucket).
const MAX_SUBGROUPS: u32 = 8u;  // 256 / 32
var<workgroup> sg_counts: array<u32, 192>;    // 24 buckets * 8 subgroups
var<workgroup> sg_prefixes: array<u32, 192>;  // exclusive prefix sums per bucket per subgroup
var<workgroup> wg_bases: array<u32, 24>;      // global base offset per bucket

@compute @workgroup_size(256)
fn cull_main(@builtin(global_invocation_id) gid: vec3u) {
    let idx = gid.x;

    // Frustum culling — with temporal coherence skip-bounds optimisation
    var visible = false;
    var primType = 0u;
    var bucket = 0u;  // 0 = tier0 compressed, 1 = other tiers
    var isTransparent = false;
    if (idx < cull.totalEntities) {
        // Temporal culling: check if we can skip the bounds read
        let word = idx / 32u;
        let bit = idx % 32u;
        let was_visible = (visibility_prev[word] >> bit) & 1u;
        let is_dirty = (dirty_bits[word] >> bit) & 1u;
        let invalidate_all = (cull.flags & 1u) != 0u;

        if (invalidate_all || is_dirty == 1u || was_visible == 0u) {
            // Full frustum test — entity moved, wasn't visible, or camera teleported
            let sphere = bounds[idx];
            let center = sphere.xyz;
            let radius = sphere.w;

            var vis = true;
            for (var i = 0u; i < 6u; i = i + 1u) {
                let plane = cull.frustumPlanes[i];
                let dist = dot(plane.xyz, center) + plane.w;
                if (dist < -radius) {
                    vis = false;
                    break;
                }
            }
            visible = vis;
        } else {
            // Skip bounds read — was visible + not dirty + no invalidation
            visible = true;
        }

        // Write visibility result for next frame's temporal culling
        if (visible) {
            atomicOr(&visibility_out[word], 1u << bit);
        }

        if (visible) {
            let metaVal = renderMeta[idx * 2u + 1u];
            primType = min(metaVal & 0xFFu, NUM_PRIM_TYPES - 1u);

            // Bit 8 of renderMeta = transparency flag
            isTransparent = (metaVal & 0x100u) != 0u;

            // Determine texture tier bucket from packed texture index:
            // bit 31 = overflow flag, bits 18-16 = tier, bits 15-0 = layer
            let texIdx = texIndices[idx];
            let tier = (texIdx >> 16u) & 7u;
            let isOverflow = (texIdx >> 31u) & 1u;
            bucket = select(0u, 1u, tier > 0u || isOverflow > 0u);
        }
    }

    if (USE_SUBGROUPS) {
        // Shared-memory prefix-sum compaction: reduces global atomics from
        // up to 192/workgroup (24 buckets × 8 subgroups) to at most
        // 24/workgroup (one atomicAdd per active bucket).
        //
        // Three phases:
        //  1. Intra-subgroup: subgroupExclusiveAdd per bucket, leader writes
        //     per-subgroup total to sg_counts[bucket][sg_id]
        //  2. Cross-subgroup exclusive prefix sum over sg_counts → sg_prefixes,
        //     plus one global atomicAdd per active bucket → wg_bases
        //  3. Re-derive intra-subgroup offset, combine with sg_prefix + wg_base
        //     for deterministic scatter into visibleIndices

        let lid = gid.x % 256u;
        let sg_id = lid / SUBGROUP_SIZE;
        let num_sg = 256u / SUBGROUP_SIZE;

        // Compute this thread's bucket index (only meaningful if visible)
        let blendOff = select(0u, OPAQUE_BUCKETS, isTransparent);
        let myBucket = blendOff + primType * BUCKETS_PER_TYPE + bucket;

        // --- Phase 1: Intra-subgroup count per bucket ---
        // All threads participate in subgroup ops (even non-visible, voting 0).
        // The subgroup leader writes the total count to shared memory.
        for (var bk = 0u; bk < TOTAL_BUCKETS; bk = bk + 1u) {
            let vote = select(0u, 1u, visible && myBucket == bk);
            let total = subgroupAdd(vote);
            if (subgroupElect()) {
                sg_counts[bk * MAX_SUBGROUPS + sg_id] = total;
            }
        }

        workgroupBarrier();

        // --- Phase 2: Cross-subgroup exclusive prefix sum + global reserve ---
        // First 24 threads each handle one bucket: scan across subgroup totals,
        // write per-subgroup prefix sums, then one atomicAdd for the whole
        // workgroup's contribution to that bucket.
        if (lid < TOTAL_BUCKETS) {
            let bk = lid;
            var running = 0u;
            for (var s = 0u; s < num_sg; s = s + 1u) {
                let c = sg_counts[bk * MAX_SUBGROUPS + s];
                sg_prefixes[bk * MAX_SUBGROUPS + s] = running;
                running = running + c;
            }
            // Reserve a contiguous range in the global drawArgs for this workgroup
            if (running > 0u) {
                wg_bases[bk] = atomicAdd(&drawArgs[bk].instanceCount, running);
            } else {
                wg_bases[bk] = 0u;
            }
        }

        workgroupBarrier();

        // --- Phase 3: Deterministic scatter ---
        // Re-derive the intra-subgroup exclusive offset per bucket (same vote
        // as Phase 1). Each visible thread writes to its computed global slot:
        //   region + wg_base + sg_prefix + intra_offset
        for (var bk = 0u; bk < TOTAL_BUCKETS; bk = bk + 1u) {
            let vote = select(0u, 1u, visible && myBucket == bk);
            let intra = subgroupExclusiveAdd(vote);

            if (vote == 1u) {
                let sg_prefix = sg_prefixes[bk * MAX_SUBGROUPS + sg_id];
                let wg_base = wg_bases[bk];
                let region = bk * cull.maxEntitiesPerType;
                visibleIndices[region + wg_base + sg_prefix + intra] = idx;
            }
        }
    } else {
        // Original atomic path — one global atomic per visible entity
        if (visible) {
            // Opaque slots: primType * 2 + bucket (indices 0-11)
            // Transparent slots: 12 + primType * 2 + bucket (indices 12-23)
            let blendOffset = select(0u, OPAQUE_BUCKETS, isTransparent);
            let argSlot = blendOffset + primType * BUCKETS_PER_TYPE + bucket;
            let slot = atomicAdd(&drawArgs[argSlot].instanceCount, 1u);
            let offset = argSlot * cull.maxEntitiesPerType;
            visibleIndices[offset + slot] = idx;
        }
    }
}
