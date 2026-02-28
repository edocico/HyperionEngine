// scatter.wgsl — GPU compute scatter for dirty entity data

struct ScatterUniforms {
    dirty_count: u32,
}

// @group(0): source data
@group(0) @binding(0) var<uniform> uniforms: ScatterUniforms;
@group(0) @binding(1) var<storage, read> staging: array<u32>;
@group(0) @binding(2) var<storage, read> dirty_indices: array<u32>;

// @group(1): destination SoA buffers
@group(1) @binding(0) var<storage, read_write> transforms: array<u32>;
@group(1) @binding(1) var<storage, read_write> bounds: array<u32>;
@group(1) @binding(2) var<storage, read_write> render_meta: array<u32>;
@group(1) @binding(3) var<storage, read_write> tex_indices: array<u32>;
@group(1) @binding(4) var<storage, read_write> prim_params: array<u32>;

const STAGING_STRIDE: u32 = 32u;

@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= uniforms.dirty_count) { return; }

    let dst = dirty_indices[i];
    let src = i * STAGING_STRIDE;

    // Format flag at position 31: 1 = pre-computed mat4x4 (direct copy)
    // Task 12 will add format 0 = compressed 2D transform
    let format = staging[src + 31u];

    // Transforms: 16 u32
    let t = dst * 16u;
    if (format == 0u) {
        // Compressed 2D: reconstruct mat4x4 from pos(3f) + rot(1f) + scale(2f)
        // (Task 12 placeholder — for now all entities use format 1)
        let px = bitcast<f32>(staging[src]);
        let py = bitcast<f32>(staging[src + 1u]);
        let pz = bitcast<f32>(staging[src + 2u]);
        let angle = bitcast<f32>(staging[src + 3u]);
        let sx = bitcast<f32>(staging[src + 4u]);
        let sy = bitcast<f32>(staging[src + 5u]);
        let c = cos(angle);
        let s_val = sin(angle);
        transforms[t]      = bitcast<u32>(sx * c);
        transforms[t + 1u] = bitcast<u32>(sx * s_val);
        transforms[t + 2u] = 0u;
        transforms[t + 3u] = 0u;
        transforms[t + 4u] = bitcast<u32>(-sy * s_val);
        transforms[t + 5u] = bitcast<u32>(sy * c);
        transforms[t + 6u] = 0u;
        transforms[t + 7u] = 0u;
        transforms[t + 8u]  = 0u;
        transforms[t + 9u]  = 0u;
        transforms[t + 10u] = bitcast<u32>(1.0);
        transforms[t + 11u] = 0u;
        transforms[t + 12u] = bitcast<u32>(px);
        transforms[t + 13u] = bitcast<u32>(py);
        transforms[t + 14u] = bitcast<u32>(pz);
        transforms[t + 15u] = bitcast<u32>(1.0);
    } else {
        // Pre-computed mat4x4: copy directly
        for (var j = 0u; j < 16u; j++) {
            transforms[t + j] = staging[src + j];
        }
    }

    // Bounds: 4 u32
    let b = dst * 4u;
    for (var j = 0u; j < 4u; j++) {
        bounds[b + j] = staging[src + 16u + j];
    }

    // RenderMeta: 2 u32
    let m = dst * 2u;
    render_meta[m]      = staging[src + 20u];
    render_meta[m + 1u] = staging[src + 21u];

    // TexIndices: 1 u32
    tex_indices[dst] = staging[src + 22u];

    // PrimParams: 8 u32
    let p = dst * 8u;
    for (var j = 0u; j < 8u; j++) {
        prim_params[p + j] = staging[src + 23u + j];
    }
}
