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
