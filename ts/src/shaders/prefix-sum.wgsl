// Blelloch exclusive prefix sum (workgroup-level, 256 elements)
// For >256 entities, dispatch multiple workgroups + second-level scan

@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@group(0) @binding(1) var<storage, read_write> blockSums: array<u32>;

var<workgroup> temp: array<u32, 512>;

@compute @workgroup_size(256)
fn prefix_sum_main(
    @builtin(global_invocation_id) gid: vec3u,
    @builtin(local_invocation_id) lid: vec3u,
    @builtin(workgroup_id) wid: vec3u,
) {
    let n = 256u * 2u; // Each workgroup processes 512 elements
    let offset = wid.x * n;
    let thid = lid.x;

    // Load into shared memory
    temp[2u * thid] = data[offset + 2u * thid];
    temp[2u * thid + 1u] = data[offset + 2u * thid + 1u];

    // Up-sweep
    var d = 1u;
    var stride = n;
    loop {
        stride = stride >> 1u;
        if (stride == 0u) { break; }
        workgroupBarrier();
        if (thid < stride) {
            let ai = d * (2u * thid + 1u) - 1u;
            let bi = d * (2u * thid + 2u) - 1u;
            temp[bi] += temp[ai];
        }
        d = d << 1u;
    }

    // Store block sum, set last to 0
    if (thid == 0u) {
        blockSums[wid.x] = temp[n - 1u];
        temp[n - 1u] = 0u;
    }

    // Down-sweep
    d = n >> 1u;
    loop {
        if (d == 0u) { break; }
        workgroupBarrier();
        let stride2 = n / (d << 1u);
        if (thid < stride2) {
            let ai = d * (2u * thid + 1u) - 1u;
            let bi = d * (2u * thid + 2u) - 1u;
            let t = temp[ai];
            temp[ai] = temp[bi];
            temp[bi] += t;
        }
        d = d >> 1u;
    }
    workgroupBarrier();

    // Write back
    data[offset + 2u * thid] = temp[2u * thid];
    data[offset + 2u * thid + 1u] = temp[2u * thid + 1u];
}

// Subgroup-accelerated exclusive prefix sum.
// Requires `enable subgroups;` prepended at pipeline creation time.

override SG_SIZE: u32 = 32u;

var<workgroup> sg_totals_ps: array<u32, 8>;  // max 256/32 = 8 subgroups
var<workgroup> sg_prefixes_ps: array<u32, 8>;

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
        sg_totals_ps[sg_id] = sg_total0 + sg_total1;
    }
    workgroupBarrier();

    // Cross-subgroup prefix sum (single thread)
    if (thid == 0u) {
        var running = 0u;
        for (var s = 0u; s < num_sg; s = s + 1u) {
            sg_prefixes_ps[s] = running;
            running += sg_totals_ps[s];
        }
        blockSums[wid.x] = running;
    }
    workgroupBarrier();

    // Final write: intra-subgroup offset + subgroup prefix
    let prefix = sg_prefixes_ps[sg_id];
    data[offset + 2u * thid] = prefix + scan0;
    data[offset + 2u * thid + 1u] = prefix + sg_total0 + scan1;
}
