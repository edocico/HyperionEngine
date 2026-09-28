// Quad (type 0, prefix quad_): an instanced sprite, sampled from the texture
// tiers, white when untextured. Lit: quad_fs applies the light buffer.
// A library of the primitive modules: see prelude.wgsl.

fn quad_vs(position: vec3f, entityIdx: u32) -> VertexOutput {
    return unitQuadVertex(position, entityIdx, position.xy + 0.5);
}

// The quad's colour and coverage. Shared by both entry points: a sprite casts
// the shadow of exactly the texels it draws.
fn quad_shade(in: VertexOutput) -> vec4f {
    return sampleTierOrWhite(in);
}

fn quad_fs(in: VertexOutput) -> vec4f {
    return applyLighting(in, quad_shade(in));
}

// A seed wherever the quad is at least half covered.
fn quad_occluder(in: VertexOutput) -> vec4f {
    return occluderSeed(in, quad_shade(in).a);
}
