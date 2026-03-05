// radix-sort.wgsl — GPU radix sort for transparent entity ordering
//
// 8-bit radix, 4 passes for 32-bit keys.
// Sorts transparent entity indices by composite sort key:
//   (primType << 24) | (depth_descending >> 8)
//
// Designed for small transparent subsets (500-5000 entities).
// Simple single-dispatch approach per entry point.

struct RadixParams {
    count: u32,       // number of elements to sort
    bit_offset: u32,  // which 8-bit radix digit (0, 8, 16, 24)
}

// --- Bindings ---

@group(0) @binding(0) var<storage, read> keys_in: array<u32>;
@group(0) @binding(1) var<storage, read> vals_in: array<u32>;
@group(0) @binding(2) var<storage, read_write> keys_out: array<u32>;
@group(0) @binding(3) var<storage, read_write> vals_out: array<u32>;
@group(0) @binding(4) var<storage, read_write> histogram: array<atomic<u32>>;
@group(0) @binding(5) var<uniform> params: RadixParams;

override WORKGROUP_SIZE: u32 = 256;

// --- Sort key helpers ---

fn float_to_sort_key(f: f32) -> u32 {
    let bits = bitcast<u32>(f);
    let mask = select(0x80000000u, 0xFFFFFFFFu, (bits & 0x80000000u) != 0u);
    return bits ^ mask;
}

fn make_transparent_sort_key(prim_type: u32, depth: f32) -> u32 {
    let depth_bits = float_to_sort_key(depth);
    let depth_descending = ~depth_bits;
    return (prim_type << 24u) | (depth_descending >> 8u);
}

// --- Entry 1: Build histogram ---
// Counts occurrences of each radix digit (0-255) across all elements.
// Uses global atomics — acceptable for small element counts.

@compute @workgroup_size(WORKGROUP_SIZE)
fn build_histogram(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.count) { return; }
    let key = keys_in[gid.x];
    let digit = (key >> params.bit_offset) & 0xFFu;
    atomicAdd(&histogram[digit], 1u);
}

// --- Entry 2: Prefix sum over histogram ---
// Serial exclusive scan over 256 buckets.
// Single thread — acceptable because histogram is only 256 entries.

@compute @workgroup_size(1)
fn prefix_sum() {
    var sum = 0u;
    for (var i = 0u; i < 256u; i++) {
        let val = atomicLoad(&histogram[i]);
        atomicStore(&histogram[i], sum);
        sum += val;
    }
}

// --- Entry 3: Scatter ---
// Each thread reads its key, computes the digit, atomically increments
// the histogram bucket to get a unique destination, and writes key+value.

@compute @workgroup_size(WORKGROUP_SIZE)
fn scatter(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.count) { return; }
    let key = keys_in[gid.x];
    let val = vals_in[gid.x];
    let digit = (key >> params.bit_offset) & 0xFFu;
    let dest = atomicAdd(&histogram[digit], 1u);
    keys_out[dest] = key;
    vals_out[dest] = val;
}
