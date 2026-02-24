// Instanced line shader — screen-space quad expansion from line parameters.
// PrimParams layout for Line:
//   [0]=startX, [1]=startY, [2]=endX, [3]=endY, [4]=width, [5]=dashLen, [6]=gapLen, [7]=_pad

struct CameraUniform {
    viewProjection: mat4x4f,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> visibleIndices: array<u32>;
@group(0) @binding(3) var<storage, read> texLayerIndices: array<u32>;
@group(0) @binding(4) var<storage, read> renderMeta: array<u32>;
@group(0) @binding(5) var<storage, read> primParams: array<f32>;

// Texture bindings (needed for bind group compatibility, unused by lines)
@group(1) @binding(0) var tier0Tex: texture_2d_array<f32>;
@group(1) @binding(1) var tier1Tex: texture_2d_array<f32>;
@group(1) @binding(2) var tier2Tex: texture_2d_array<f32>;
@group(1) @binding(3) var tier3Tex: texture_2d_array<f32>;
@group(1) @binding(4) var texSampler: sampler;
// Overflow tiers (rgba8unorm, for mixed-mode dev)
@group(1) @binding(5) var ovf0Tex: texture_2d_array<f32>;
@group(1) @binding(6) var ovf1Tex: texture_2d_array<f32>;
@group(1) @binding(7) var ovf2Tex: texture_2d_array<f32>;
@group(1) @binding(8) var ovf3Tex: texture_2d_array<f32>;

struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) entityIdx: u32,
    @location(2) @interpolate(flat) texTier: u32,
    @location(3) @interpolate(flat) texLayer: u32,
    @location(4) @interpolate(flat) isOverflow: u32,
};

@vertex
fn vs_main(
    @location(0) position: vec3f,
    @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
    let entityIdx = visibleIndices[instanceIdx];
    let model = transforms[entityIdx];

    // Read line params
    let base = entityIdx * 8u;
    let startX = primParams[base + 0u];
    let startY = primParams[base + 1u];
    let endX   = primParams[base + 2u];
    let endY   = primParams[base + 3u];
    let width  = primParams[base + 4u];

    // Line direction and perpendicular
    let dir = vec2f(endX - startX, endY - startY);
    let len = length(dir);
    let d = select(vec2f(1.0, 0.0), dir / len, len > 0.001);
    let perp = vec2f(-d.y, d.x);

    // Unit quad position.xy maps [-0.5, 0.5] to line segment:
    //   x: along line (0 = start, 1 = end)
    //   y: across line (-0.5 = left, 0.5 = right)
    let along = position.x + 0.5;   // [0, 1]
    let across = position.y;         // [-0.5, 0.5]

    let worldPos = vec2f(startX, startY)
        + d * along * len
        + perp * across * width;

    // Decode texture tier and layer from packed u32
    let packed = texLayerIndices[entityIdx];
    let isOverflow = (packed >> 31u) & 1u;
    let tier = (packed >> 16u) & 0x7u;
    let layer = packed & 0xFFFFu;

    var out: VertexOutput;
    out.clipPosition = camera.viewProjection * model * vec4f(worldPos, 0.0, 1.0);
    out.uv = vec2f(along, across + 0.5);
    out.entityIdx = entityIdx;
    out.texTier = tier;
    out.texLayer = layer;
    out.isOverflow = isOverflow;

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    // Read line params for potential dash pattern
    let base = in.entityIdx * 8u;
    let width = primParams[base + 4u];
    let dashLen = primParams[base + 5u];
    let gapLen = primParams[base + 6u];

    // Read color from texture (with overflow support)
    var color: vec4f;
    if (in.isOverflow == 0u) {
        switch in.texTier {
            case 1u: { color = textureSample(tier1Tex, texSampler, in.uv, in.texLayer); }
            case 2u: { color = textureSample(tier2Tex, texSampler, in.uv, in.texLayer); }
            case 3u: { color = textureSample(tier3Tex, texSampler, in.uv, in.texLayer); }
            default: { color = textureSample(tier0Tex, texSampler, in.uv, in.texLayer); }
        }
    } else {
        switch in.texTier {
            case 1u: { color = textureSample(ovf1Tex, texSampler, in.uv, in.texLayer); }
            case 2u: { color = textureSample(ovf2Tex, texSampler, in.uv, in.texLayer); }
            case 3u: { color = textureSample(ovf3Tex, texSampler, in.uv, in.texLayer); }
            default: { color = textureSample(ovf0Tex, texSampler, in.uv, in.texLayer); }
        }
    }

    // SDF dash pattern (if dashLen > 0)
    if (dashLen > 0.0) {
        let totalLen = dashLen + gapLen;
        let along = in.uv.x;
        let lineLen = length(vec2f(
            primParams[base + 2u] - primParams[base + 0u],
            primParams[base + 3u] - primParams[base + 1u]
        ));
        let pos = along * lineLen;
        let phase = pos % totalLen;
        if (phase > dashLen) {
            discard;
        }
    }

    // Anti-alias edges (SDF from line center)
    let dist = abs(in.uv.y - 0.5) * width;
    let halfWidth = width * 0.5;
    let aa = 1.0 - smoothstep(halfWidth - 1.0, halfWidth, dist);
    color.a *= aa;

    return color;
}
