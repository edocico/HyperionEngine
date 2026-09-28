// Transparent sort, stage 1: the gather (Phase 5b, design
// docs/plans/2026-09-27-transparent-sort-uber-design.md §5.3).
//
// Collects the transparent primitives of types 0-5 that CullPass kept (the
// transparent draw buckets 14..25: 12 regions of visible-indices) into one list
// of n = min(raw, limit) elements. Element i holds
//     keysOut[i]       = lo = the external id of its slot (entity-ids)
//     keysOut[CAP + i] = hi = sortable bits of the slot's world z (entity-bounds.z)
//     valsOut[i]       = the slot
// and lane 0 of workgroup 0 writes the header of transparent-args (§5.2): the
// uber draw's args {6, n, 0, 0, 0}, the sort's dispatch args {ceil(n / TILE),
// 1, 1} at word 5, raw, limit, overflow and the frame stamp. Words 12-15 keep
// what prepare() wrote.
//
// Dispatched with ceil(B / 256) workgroups, B = limit. Buckets 0..13 (opaque)
// and 26/27 (Light2D) are never read. The z is read as vec4<u32>: no floating-
// point operation touches it, so -0, denormals and infinities keep their bits.
//
// Every const below is pinned by render/passes/transparent-sort-wgsl.test.ts
// to the export of transparent-sort-constants.ts with the same name
// (H_INSTANCES to H_DRAW + ARG_INSTANCE_COUNT; QUAD_INDEX_COUNT to the unit
// quad's 6 indices).

const WORKGROUP_SIZE: u32 = 256u;
const CAP: u32 = 100000u;
const TILE: u32 = 1024u;
const FIRST_TRANSPARENT_ARG: u32 = 14u;
const GATHER_REGIONS: u32 = 12u;
const ARG_WORDS: u32 = 5u;          // DrawIndexedIndirect: indexCount, instanceCount, firstIndex, baseVertex, firstInstance
const ARG_INSTANCE_COUNT: u32 = 1u; // DrawIndexedIndirect.instanceCount
const ARG_FIRST_INSTANCE: u32 = 4u; // DrawIndexedIndirect.firstInstance
const QUAD_INDEX_COUNT: u32 = 6u;
const HEADER_WORDS: u32 = 16u;
const H_DRAW: u32 = 0u;
const H_INSTANCES: u32 = 1u;        // H_DRAW + ARG_INSTANCE_COUNT: the draw's instanceCount, i.e. n
const H_DISPATCH: u32 = 5u;
const H_RAW: u32 = 8u;
const H_LIMIT: u32 = 9u;
const H_OVERFLOW: u32 = 10u;
const H_STAMP: u32 = 11u;

struct GatherParams {
    limit: u32,     // B: the gather collects at most this many elements
    stamp: u32,     // FrameState.frameStamp: never 0, never 0xFFFFFFFF
    _pad0: u32,
    _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: GatherParams;
@group(0) @binding(1) var<storage, read> indirectArgs: array<u32>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> bounds: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read> entityIds: array<u32>;
@group(0) @binding(5) var<storage, read_write> keysOut: array<u32>;
@group(0) @binding(6) var<storage, read_write> valsOut: array<u32>;
@group(0) @binding(7) var<storage, read_write> header: array<u32, HEADER_WORDS>;

// Inclusive prefix of the 12 region counts, and each region's first index in
// visible-indices (its firstInstance).
var<workgroup> regionEnd: array<u32, GATHER_REGIONS>;
var<workgroup> regionBase: array<u32, GATHER_REGIONS>;

// The z bits as an ascending u32: -0 becomes +0, a negative is flipped whole,
// a positive gets its sign bit set.
fn sortableZBits(bits: u32) -> u32 {
    var zb = bits;
    if (zb == 0x80000000u) { zb = 0u; }
    return select(zb | 0x80000000u, ~zb, (zb & 0x80000000u) != 0u);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn gather_main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
    if (lid == 0u) {
        var acc = 0u;
        for (var region = 0u; region < GATHER_REGIONS; region++) {
            let arg = (FIRST_TRANSPARENT_ARG + region) * ARG_WORDS;
            acc += indirectArgs[arg + ARG_INSTANCE_COUNT];
            regionEnd[region] = acc;
            regionBase[region] = indirectArgs[arg + ARG_FIRST_INSTANCE];
        }
    }
    workgroupBarrier();

    let raw = regionEnd[GATHER_REGIONS - 1u];
    let n = min(raw, params.limit);

    // The one writer of the header: no atomics needed.
    if (wid.x == 0u && lid == 0u) {
        header[H_DRAW] = QUAD_INDEX_COUNT;
        header[H_INSTANCES] = n;
        header[H_DRAW + 2u] = 0u;
        header[H_DRAW + 3u] = 0u;
        header[H_DRAW + 4u] = 0u;
        header[H_DISPATCH] = (n + TILE - 1u) / TILE;
        header[H_DISPATCH + 1u] = 1u;
        header[H_DISPATCH + 2u] = 1u;
        header[H_RAW] = raw;
        header[H_LIMIT] = params.limit;
        header[H_OVERFLOW] = select(0u, 1u, raw > params.limit);
        header[H_STAMP] = params.stamp;
    }

    let i = wid.x * WORKGROUP_SIZE + lid;
    if (i >= n) { return; }

    // Region k holds the output elements [regionEnd[k - 1], regionEnd[k]).
    var k = 0u;
    for (var q = 0u; q < GATHER_REGIONS; q++) {
        if (regionEnd[q] <= i) { k += 1u; }
    }
    var start = 0u;
    if (k > 0u) { start = regionEnd[k - 1u]; }
    let slot = visibleIndices[regionBase[k] + i - start];

    keysOut[i] = entityIds[slot];
    keysOut[CAP + i] = sortableZBits(bounds[slot].z);
    valsOut[i] = slot;
}
