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

struct CullUniforms {
    frustumPlanes: array<vec4f, 6>,
    totalEntities: u32,
    maxEntitiesPerType: u32,  // MAX_ENTITIES — region size per type
    _pad1: u32,
    _pad2: u32,
};

// Per-type indirect draw args. Packed as 6 consecutive DrawIndirectArgs.
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
@group(0) @binding(4) var<storage, read_write> drawArgs: array<DrawIndirectArgs, 6>;
@group(0) @binding(5) var<storage, read> renderMeta: array<u32>;  // 2 u32/entity: [mesh, prim]

@compute @workgroup_size(256)
fn cull_main(@builtin(global_invocation_id) gid: vec3u) {
    let idx = gid.x;

    // Frustum culling — shared by both paths
    var visible = false;
    var primType = 0u;
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
        }
    }

    if (USE_SUBGROUPS) {
        // Subgroup-accelerated path: reduces global atomics from N to
        // N/SUBGROUP_SIZE by batching within each subgroup.
        for (var p = 0u; p < NUM_PRIM_TYPES; p = p + 1u) {
            let vote = select(0u, 1u, visible && primType == p);
            let subOffset = subgroupExclusiveAdd(vote);
            let subTotal = subgroupAdd(vote);

            // Thread 0 of the subgroup (subgroupElect) does the batched atomic.
            // subgroupBroadcastFirst broadcasts from thread 0, so they match.
            var baseSlot = 0u;
            if (subTotal > 0u) {
                if (subgroupElect()) {
                    baseSlot = atomicAdd(&drawArgs[p].instanceCount, subTotal);
                }
                baseSlot = subgroupBroadcastFirst(baseSlot);
            }

            if (vote == 1u) {
                let offset = p * cull.maxEntitiesPerType;
                visibleIndices[offset + baseSlot + subOffset] = idx;
            }
        }
    } else {
        // Original atomic path — one global atomic per visible entity
        if (visible) {
            let slot = atomicAdd(&drawArgs[primType].instanceCount, 1u);
            let offset = primType * cull.maxEntitiesPerType;
            visibleIndices[offset + slot] = idx;
        }
    }
}
