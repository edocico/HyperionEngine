// Transparent sort, stages 2-4 (Phase 5b, design
// docs/plans/2026-09-27-transparent-sort-uber-design.md §5.3): a stable LSD
// radix sort of the gathered pairs (lo = external id, hi = z key), 7 passes of
// 8 bits. Passes 0-2 read the id, 3-6 the z key, so the result ascends by
// (z key, id): back to front, and at equal z the higher id is drawn later, in
// front. The keys are unique (the ids are), so the output is ONE permutation.
//
// Per pass p, three dispatches share this module's one layout:
//   upsweep_main  indirect (transparent-args at 20 B): one TILE-element tile per
//                 workgroup, its RADIX-bin histogram into hist.tiles[t]
//   scan_main     1 workgroup, lane d owns digit d: the exclusive scan of
//                 column d down the tiles, then an exclusive scan across the
//                 digits into hist.digitBase[p]
//   scatter_main  indirect: each element to digitBase + its tile's column
//                 prefix + the earlier rounds of its tile (cursor) + the earlier
//                 lanes of its round with its digit (popcount of a lane bitmask)
// The destination is a sum of counts: no atomic ordering ever reaches an
// address, so the sort is stable and the same from frame to frame.
//
// Bind group p reads A and writes B for even p, the reverse for odd p. PASSES
// is odd, so the result lands in B = transparent-order. The last pass writes no
// keys, in every build: nothing reads them (a readback recomputes them).
//
// n is header[H_INSTANCES], read through a READ-ONLY binding: a uniform value,
// so the tile guards before the barriers are in uniform control flow.
//
// Every const below is pinned by render/passes/transparent-sort-wgsl.test.ts:
// to the export of transparent-sort-constants.ts with the same name (LO_PASSES,
// MASK_WORDS and SCAN_CHUNK included), H_INSTANCES to H_DRAW +
// ARG_INSTANCE_COUNT, DIGIT_BITS and DIGIT_MASK to RADIX and to the CPU model's
// digitOf.

const WORKGROUP_SIZE: u32 = 256u;
const CAP: u32 = 100000u;
const TILE: u32 = 1024u;
const ROUNDS: u32 = 4u;             // TILE / WORKGROUP_SIZE
const RADIX: u32 = 256u;            // = WORKGROUP_SIZE: lane d owns digit d
const PASSES: u32 = 7u;
const LAST_PASS: u32 = 6u;
const LO_PASSES: u32 = 3u;          // passes 0-2 sort by the id (lo), 3-6 by the z key (hi)
const DIGIT_BITS: u32 = 8u;
const DIGIT_MASK: u32 = 0xFFu;
const MASK_WORDS: u32 = 8u;         // WORKGROUP_SIZE / 32: one bit per lane
const SCAN_CHUNK: u32 = 8u;         // tiles the column scan loads at once
const HEADER_WORDS: u32 = 16u;
const H_INSTANCES: u32 = 1u;        // H_DRAW + ARG_INSTANCE_COUNT: the draw's instanceCount, n
const DIAG_WORDS: u32 = 16u;
const DIAG_SCAN_MISMATCH: u32 = 1u;
const DIAG_SCATTER_OOB: u32 = 2u;

struct PassParams {
    passIndex: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

struct SortHist {
    diag: array<atomic<u32>, DIAG_WORDS>,
    digitBase: array<u32, PASSES * RADIX>,  // row p: the exclusive digit scan of pass p
    tiles: array<u32>,                      // tile t, digit d at t * RADIX + d
}

@group(0) @binding(0) var<uniform> params: PassParams;
@group(0) @binding(1) var<storage, read> keysIn: array<u32>;
@group(0) @binding(2) var<storage, read> valsIn: array<u32>;
@group(0) @binding(3) var<storage, read_write> keysOut: array<u32>;
@group(0) @binding(4) var<storage, read_write> valsOut: array<u32>;
@group(0) @binding(5) var<storage, read> header: array<u32, HEADER_WORDS>;
@group(0) @binding(6) var<storage, read_write> hist: SortHist;

var<workgroup> wgHist: array<atomic<u32>, RADIX>;                // upsweep
var<workgroup> totals: array<u32, RADIX>;                        // scan
var<workgroup> masks: array<atomic<u32>, RADIX * MASK_WORDS>;    // scatter: digit d, lane word w
var<workgroup> cursor: array<u32, RADIX>;                        // scatter

// The shift of pass p's digit inside the key word it reads.
fn digitShift(p: u32) -> u32 {
    if (p < LO_PASSES) { return p * DIGIT_BITS; }
    return (p - LO_PASSES) * DIGIT_BITS;
}

// Pass p's digit of the key (lo, hi).
fn digitOf(lo: u32, hi: u32, p: u32) -> u32 {
    return (select(hi, lo, p < LO_PASSES) >> digitShift(p)) & DIGIT_MASK;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn upsweep_main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
    let n = header[H_INSTANCES];
    let t = wid.x;
    if (t * TILE >= n) { return; }
    let p = params.passIndex;
    // Only the word of the digit is read: lo at [0, CAP), hi at [CAP, 2 CAP).
    let wordBase = select(CAP, 0u, p < LO_PASSES);
    let shift = digitShift(p);

    atomicStore(&wgHist[lid], 0u);
    workgroupBarrier();
    for (var r = 0u; r < ROUNDS; r++) {
        let i = t * TILE + r * WORKGROUP_SIZE + lid;
        if (i < n) {
            atomicAdd(&wgHist[(keysIn[wordBase + i] >> shift) & DIGIT_MASK], 1u);
        }
    }
    workgroupBarrier();
    hist.tiles[t * RADIX + lid] = atomicLoad(&wgHist[lid]);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn scan_main(@builtin(local_invocation_index) lid: u32) {
    let n = header[H_INSTANCES];
    let p = params.passIndex;
    let d = lid;
    let numTiles = (n + TILE - 1u) / TILE;

    // 1. Down column d, no barriers: each tile's count of d becomes the count
    //    of d in the tiles before it. SCAN_CHUNK loads in flight at a time.
    var sum = 0u;
    let batches = numTiles / SCAN_CHUNK;
    for (var b = 0u; b < batches; b++) {
        let t0 = b * SCAN_CHUNK;
        var c: array<u32, SCAN_CHUNK>;
        for (var j = 0u; j < SCAN_CHUNK; j++) { c[j] = hist.tiles[(t0 + j) * RADIX + d]; }
        for (var j = 0u; j < SCAN_CHUNK; j++) {
            hist.tiles[(t0 + j) * RADIX + d] = sum;
            sum += c[j];
        }
    }
    for (var t = batches * SCAN_CHUNK; t < numTiles; t++) {
        let c = hist.tiles[t * RADIX + d];
        hist.tiles[t * RADIX + d] = sum;
        sum += c;
    }

    // 2. Across the digits: inclusive Hillis-Steele IN PLACE (the 1024 B
    //    budget leaves no second array), two barriers per step. The one-barrier
    //    form `totals[d] += totals[d - off]` is a race.
    totals[d] = sum;
    workgroupBarrier();
    for (var off = 1u; off < RADIX; off <<= 1u) {
        var v = 0u;
        if (d >= off) { v = totals[d - off]; }
        workgroupBarrier();
        totals[d] += v;
        workgroupBarrier();
    }

    let incl = totals[d];
    hist.digitBase[p * RADIX + d] = incl - sum;
    if (d == RADIX - 1u && incl != n) {
        atomicOr(&hist.diag[0], DIAG_SCAN_MISMATCH);
    }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn scatter_main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) lid: u32) {
    let n = header[H_INSTANCES];
    let t = wid.x;
    if (t * TILE >= n) { return; }
    let p = params.passIndex;

    // Phase 0: preload this lane's ROUNDS elements, seed the cursors, clear
    // the masks (lane l clears the words of digit l).
    var lo: array<u32, ROUNDS>;
    var hi: array<u32, ROUNDS>;
    var val: array<u32, ROUNDS>;
    for (var r = 0u; r < ROUNDS; r++) {
        let i = t * TILE + r * WORKGROUP_SIZE + lid;
        if (i < n) {
            lo[r] = keysIn[i];
            hi[r] = keysIn[CAP + i];
            val[r] = valsIn[i];
        }
    }
    cursor[lid] = hist.digitBase[p * RADIX + lid] + hist.tiles[t * RADIX + lid];
    for (var w = 0u; w < MASK_WORDS; w++) {
        atomicStore(&masks[lid * MASK_WORDS + w], 0u);
    }
    workgroupBarrier();                                      // B0

    let word = lid / 32u;
    let bit = 1u << (lid % 32u);
    // A constant trip count: lanes past n do nothing but cross every barrier.
    for (var r = 0u; r < ROUNDS; r++) {
        let i = t * TILE + r * WORKGROUP_SIZE + lid;
        let live = i < n;
        var d = 0u;
        // (a) mark this lane under its digit
        if (live) {
            d = digitOf(lo[r], hi[r], p);
            atomicOr(&masks[d * MASK_WORDS + word], bit);
        }
        workgroupBarrier();                                  // B1
        // (b) count the digit's lanes and those before this one; read the cursor. No writes.
        var total = 0u;
        var rank = 0u;
        var base = 0u;
        if (live) {
            for (var w = 0u; w < MASK_WORDS; w++) {
                let m = countOneBits(atomicLoad(&masks[d * MASK_WORDS + w]));
                total += m;
                if (w < word) { rank += m; }
            }
            rank += countOneBits(atomicLoad(&masks[d * MASK_WORDS + word]) & (bit - 1u));
            base = cursor[d];
        }
        workgroupBarrier();                                  // B2
        // (c) write, clear this lane's mask word, move the cursor (one writer per digit)
        if (live) {
            let dst = base + rank;
            if (dst < n) {
                valsOut[dst] = val[r];
                if (p != LAST_PASS) {
                    keysOut[dst] = lo[r];
                    keysOut[CAP + dst] = hi[r];
                }
            } else {
                atomicOr(&hist.diag[0], DIAG_SCATTER_OOB);
            }
            atomicStore(&masks[d * MASK_WORDS + word], 0u);
            if (rank == total - 1u) { cursor[d] = base + total; }
        }
        workgroupBarrier();                                  // B3
    }
}
