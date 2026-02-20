// Selection seed pass: renders selected entity pixels as seeds for JFA.
// Output: R = normalized X position, G = normalized Y position (seed coords).
// Non-selected pixels: (0, 0, 0, 0).
//
// Uses the same vertex-stage bindings as the forward pass but additionally
// reads a selection-mask buffer.  Unselected entities are discarded by
// emitting degenerate triangles (all-zero positions).

struct CameraUniform {
    viewProjection: mat4x4f,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> selectionMask: array<u32>;

struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs_main(
    @location(0) position: vec3f,
    @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
    let entityIdx = visibleIndices[instanceIdx];
    let selected = selectionMask[entityIdx];

    var out: VertexOutput;

    if (selected == 0u) {
        // Degenerate triangle — effectively culled
        out.clipPosition = vec4f(0.0, 0.0, 0.0, 1.0);
        out.uv = vec2f(0.0, 0.0);
        return out;
    }

    let model = transforms[entityIdx];
    out.clipPosition = camera.viewProjection * model * vec4f(position, 1.0);
    // Compute normalized-device UV from clip position for seed encoding.
    // The fragment shader will receive the interpolated UV.
    out.uv = (out.clipPosition.xy / out.clipPosition.w) * 0.5 + 0.5;
    // Flip Y so that UV (0,0) is top-left to match texture coordinate space
    out.uv.y = 1.0 - out.uv.y;

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    // Output seed position as normalized UV coordinates.
    // B channel = 1.0 marks this pixel as a valid seed.
    return vec4f(in.uv.x, in.uv.y, 1.0, 1.0);
}
