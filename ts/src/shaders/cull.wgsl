// GPU frustum culling compute shader with per-primitive-type grouping.
// Dispatched with ceil(totalEntities / 256) workgroups.
// SoA layout: separate transforms, bounds, and renderMeta buffers.

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
    if (idx >= cull.totalEntities) {
        return;
    }

    let sphere = bounds[idx];
    let center = sphere.xyz;
    let radius = sphere.w;

    // Test sphere against all 6 frustum planes.
    var visible = true;
    for (var i = 0u; i < 6u; i = i + 1u) {
        let plane = cull.frustumPlanes[i];
        let dist = dot(plane.xyz, center) + plane.w;
        if (dist < -radius) {
            visible = false;
            break;
        }
    }

    if (visible) {
        // Read primitive type from renderMeta (second u32 per entity)
        let primType = min(renderMeta[idx * 2u + 1u], NUM_PRIM_TYPES - 1u);

        // Atomic increment for this primitive type's instance count
        let slot = atomicAdd(&drawArgs[primType].instanceCount, 1u);

        // Write entity index to the correct per-type region
        let offset = primType * cull.maxEntitiesPerType;
        visibleIndices[offset + slot] = idx;
    }
}
