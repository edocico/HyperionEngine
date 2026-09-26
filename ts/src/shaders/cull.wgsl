// GPU frustum culling compute shader with per-primitive-type grouping and
// opaque/transparent split.
// Dispatched with ceil(totalEntities / 256) workgroups.
// Reads the bounds, renderMeta and texIndices SoA columns. The culling test
// needs only the bounding sphere, never the transform.
//
// Pipeline override constants enable a subgroup-accelerated path.
// When USE_SUBGROUPS is true, `enable subgroups;` must be prepended
// at pipeline creation time (WGSL validation fails otherwise).

override USE_SUBGROUPS: bool = false;
override SUBGROUP_SIZE: u32 = 32u;
override USE_SUBGROUP_ID: bool = false;

// 7 = Quad, Line, SDFGlyph, BezierPath, Gradient, BoxShadow, Light2D.
// Light2D has no material sort and no transparent variant, so three of its four
// buckets stay empty. Uniform waste, and the alternative — a variable bucket
// count per type — would break the `blendOff + primType * BUCKETS_PER_TYPE + bk`
// indexing below and add a branch to the hot loop.
const NUM_PRIM_TYPES: u32 = 7u;
const BUCKETS_PER_TYPE: u32 = 2u;   // bucket 0 = tier0 compressed, bucket 1 = other tiers
const OPAQUE_BUCKETS: u32 = NUM_PRIM_TYPES * BUCKETS_PER_TYPE;   // 14
const TOTAL_BUCKETS: u32 = OPAQUE_BUCKETS * 2u;                  // 28 (14 opaque + 14 transparent)
const MAX_SUBGROUPS: u32 = 8u;  // 256 / 32

struct CullUniforms {
    frustumPlanes: array<vec4f, 6>,
    totalEntities: u32,
    maxEntitiesPerType: u32,  // MAX_ENTITIES — region size per type
    _pad0: u32,
    _pad1: u32,
};

// Per-type-bucket indirect draw args. Packed as TOTAL_BUCKETS consecutive
// DrawIndirectArgs (14 opaque + 14 transparent: each set = 7 prim types x 2
// material buckets).
struct DrawIndirectArgs {
    indexCount: u32,
    instanceCount: atomic<u32>,
    firstIndex: u32,
    baseVertex: u32,
    firstInstance: u32,
};

// The only bind group: SoA columns + indirect args.
@group(0) @binding(0) var<uniform> cull: CullUniforms;
@group(0) @binding(1) var<storage, read> bounds: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read_write> drawArgs: array<DrawIndirectArgs, TOTAL_BUCKETS>;
@group(0) @binding(4) var<storage, read> renderMeta: array<u32>;  // 2 u32/entity: [mesh, prim|flags]
@group(0) @binding(5) var<storage, read> texIndices: array<u32>;  // packed tex index per entity

// Shared memory for subgroup prefix-sum compaction.
// Reduces global atomics from TOTAL_BUCKETS × MAX_SUBGROUPS per workgroup to at
// most TOTAL_BUCKETS (one per active bucket).
//
// Sized by const-expression rather than by literal on purpose: these three used
// to be 192/192/24 written out by hand, so a change to NUM_PRIM_TYPES had four
// separate numbers to keep in step — with no test able to catch a miss, since
// WGSL cannot be compiled headless. At 28 buckets this is ~1.8 KB of workgroup
// storage, well inside the 16 KiB limit.
var<workgroup> sg_counts: array<u32, TOTAL_BUCKETS * MAX_SUBGROUPS>;
var<workgroup> sg_prefixes: array<u32, TOTAL_BUCKETS * MAX_SUBGROUPS>;
var<workgroup> wg_bases: array<u32, TOTAL_BUCKETS>;

@compute @workgroup_size(256)
fn cull_main(@builtin(global_invocation_id) gid: vec3u) {
    let idx = gid.x;

    // Frustum culling: a bounding sphere against the 6 planes, every frame.
    var visible = false;
    var primType = 0u;
    var bucket = 0u;  // 0 = tier0 compressed, 1 = other tiers
    var isTransparent = false;
    if (idx < cull.totalEntities) {
        let sphere = bounds[idx];
        let center = sphere.xyz;
        let radius = sphere.w;

        visible = true;
        for (var i = 0u; i < 6u; i = i + 1u) {
            let plane = cull.frustumPlanes[i];
            let dist = dot(plane.xyz, center) + plane.w;
            if (dist < -radius) {
                visible = false;
                break;
            }
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
        // BEGIN-SUBGROUPS-ONLY
        //
        // ⚠️ These markers are load-bearing, not decoration. `prepareShaderSource()`
        // deletes everything between them when the device has no `subgroups`
        // feature, and the deletion is what makes this shader compile there.
        //
        // `override USE_SUBGROUPS` gates whether this branch *runs*, but WGSL
        // validates every builtin call in the module regardless of any override
        // value — so `subgroupAdd` left in the text is a hard compile error on a
        // device without the extension, taking the whole renderer down with it.
        // There is no WGSL preprocessor; textual stripping is the only tool.
        //
        // Shared-memory prefix-sum compaction: reduces global atomics from
        // up to TOTAL_BUCKETS × MAX_SUBGROUPS per workgroup to at most
        // TOTAL_BUCKETS (one atomicAdd per active bucket).
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
        // First TOTAL_BUCKETS (28) threads each handle one bucket: scan across subgroup totals,
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
        // END-SUBGROUPS-ONLY
    } else {
        // Original atomic path — one global atomic per visible entity
        if (visible) {
            // Opaque slots: primType * 2 + bucket (indices 0-13)
            // Transparent slots: OPAQUE_BUCKETS (14) + primType * 2 + bucket (indices 14-27)
            let blendOffset = select(0u, OPAQUE_BUCKETS, isTransparent);
            let argSlot = blendOffset + primType * BUCKETS_PER_TYPE + bucket;
            let slot = atomicAdd(&drawArgs[argSlot].instanceCount, 1u);
            let offset = argSlot * cull.maxEntitiesPerType;
            visibleIndices[offset + slot] = idx;
        }
    }
}
