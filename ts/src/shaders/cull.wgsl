// GPU frustum culling compute shader with per-primitive-type grouping.
// Dispatched with ceil(totalEntities / 256) workgroups.
// SoA layout: separate transforms, bounds, and renderMeta buffers.
//
// Pipeline override constants enable a subgroup-accelerated path.
// When USE_SUBGROUPS is true, `enable subgroups;` must be prepended
// at pipeline creation time (WGSL validation fails otherwise).

override USE_SUBGROUPS: bool = false;
override SUBGROUP_SIZE: u32 = 32u;

const NUM_PRIM_TYPES: u32 = 6u;
const BUCKETS_PER_TYPE: u32 = 2u;   // bucket 0 = tier0 compressed, bucket 1 = other tiers
const TOTAL_BUCKETS: u32 = NUM_PRIM_TYPES * BUCKETS_PER_TYPE;

struct CullUniforms {
    frustumPlanes: array<vec4f, 6>,
    totalEntities: u32,
    maxEntitiesPerType: u32,  // MAX_ENTITIES — region size per type
    _pad1: u32,
    _pad2: u32,
};

// Per-type-bucket indirect draw args. Packed as 12 consecutive DrawIndirectArgs
// (6 prim types x 2 buckets: tier0 compressed, then other tiers).
struct DrawIndirectArgs {
    indexCount: u32,
    instanceCount: atomic<u32>,
    firstIndex: u32,
    baseVertex: u32,
    firstInstance: u32,
};

@group(0) @binding(0) var<uniform> cull: CullUniforms;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> bounds: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> visibleIndices: array<u32>;
@group(0) @binding(4) var<storage, read_write> drawArgs: array<DrawIndirectArgs, 12>;
@group(0) @binding(5) var<storage, read> renderMeta: array<u32>;  // 2 u32/entity: [mesh, prim]
@group(0) @binding(6) var<storage, read> texIndices: array<u32>;  // packed tex index per entity

@compute @workgroup_size(256)
fn cull_main(@builtin(global_invocation_id) gid: vec3u) {
    let idx = gid.x;

    // Frustum culling — shared by both paths
    var visible = false;
    var primType = 0u;
    var bucket = 0u;  // 0 = tier0 compressed, 1 = other tiers
    if (idx < cull.totalEntities) {
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

        if (visible) {
            primType = min(renderMeta[idx * 2u + 1u], NUM_PRIM_TYPES - 1u);

            // Determine texture tier bucket from packed texture index:
            // bit 31 = overflow flag, bits 18-16 = tier, bits 15-0 = layer
            let texIdx = texIndices[idx];
            let tier = (texIdx >> 16u) & 7u;
            let isOverflow = (texIdx >> 31u) & 1u;
            bucket = select(0u, 1u, tier > 0u || isOverflow > 0u);
        }
    }

    if (USE_SUBGROUPS) {
        // Subgroup-accelerated path: reduces global atomics from N to
        // N/SUBGROUP_SIZE by batching within each subgroup.
        for (var p = 0u; p < NUM_PRIM_TYPES; p = p + 1u) {
            for (var b = 0u; b < BUCKETS_PER_TYPE; b = b + 1u) {
                let vote = select(0u, 1u, visible && primType == p && bucket == b);
                let subOffset = subgroupExclusiveAdd(vote);
                let subTotal = subgroupAdd(vote);

                let argSlot = p * BUCKETS_PER_TYPE + b;

                // Thread 0 of the subgroup (subgroupElect) does the batched atomic.
                // subgroupBroadcastFirst broadcasts from thread 0, so they match.
                var baseSlot = 0u;
                if (subTotal > 0u) {
                    if (subgroupElect()) {
                        baseSlot = atomicAdd(&drawArgs[argSlot].instanceCount, subTotal);
                    }
                    baseSlot = subgroupBroadcastFirst(baseSlot);
                }

                if (vote == 1u) {
                    let offset = argSlot * cull.maxEntitiesPerType;
                    visibleIndices[offset + baseSlot + subOffset] = idx;
                }
            }
        }
    } else {
        // Original atomic path — one global atomic per visible entity
        if (visible) {
            let argSlot = primType * BUCKETS_PER_TYPE + bucket;
            let slot = atomicAdd(&drawArgs[argSlot].instanceCount, 1u);
            let offset = argSlot * cull.maxEntitiesPerType;
            visibleIndices[offset + slot] = idx;
        }
    }
}
