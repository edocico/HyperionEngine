// GPU frustum culling compute shader.
// Dispatched with ceil(totalEntities / 256) workgroups.
// SoA layout: separate transforms and bounds buffers.

struct CullUniforms {
    frustumPlanes: array<vec4f, 6>,  // 6 normalized frustum planes
    totalEntities: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

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
@group(0) @binding(4) var<storage, read_write> drawArgs: DrawIndirectArgs;

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
    // If the sphere is fully behind any plane, it's culled.
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
        let slot = atomicAdd(&drawArgs.instanceCount, 1u);
        visibleIndices[slot] = idx;
    }
}
