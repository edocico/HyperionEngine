import { describe, it, expect } from 'vitest';
import {
  stripComments, topLevelDecls, functionBody, functionParams, callGraph, reachableFrom,
  bindingDecls, localNames, directives,
} from './wgsl-analysis';

// A cut-down primitive module in today's shape (basic.wgsl): bindings in three
// groups, a lit fs_main, an fs_occluder that must not reach group 2.
const MODULE = `
// Instanced quad shader.
struct CameraUniform {
    viewProjection: mat4x4f,
    occluderLayers: u32, // 0 in ForwardPass
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(0) @binding(1) var<storage, read> transforms: array<mat4x4f>;
@group(0) @binding(4) var<storage, read> renderMeta: array<u32>;
@group(1) @binding(0) var tier0Tex: texture_2d_array<f32>;
@group(1) @binding(4) var texSampler: sampler;
@binding(0) @group(2) var lightBuffer: texture_2d_array<f32>;
// @group(2) @binding(1) var commentedOut: sampler;

override OCCLUDER_PASS: bool = false;
const RECEIVES_LIGHT_BIT: u32 = 1u << 10u;
alias Color = vec4f;
const_assert RECEIVES_LIGHT_BIT == 1024u;

struct VertexOutput {
    @builtin(position) clipPosition: vec4f,
    @location(0) uv: vec2f,
    @location(1) @interpolate(flat) entityIdx: u32,
};

@vertex
fn vs_main(
    @location(0) position: vec3f,
    @builtin(instance_index) instanceIdx: u32,
) -> VertexOutput {
    var out: VertexOutput;
    let model = transforms[instanceIdx];
    out.clipPosition = camera.viewProjection * model * vec4f(position, 1.0);
    out.uv = position.xy + 0.5;
    return out;
}

fn shade(in: VertexOutput) -> vec4f {
    /* Nested /* block */ comment: fn hidden() {} */
    if (in.entityIdx == 0u) {
        return vec4f(1.0);
    }
    return textureSampleLevel(tier0Tex, texSampler, in.uv, 0, 0.0);
}

fn light(meta1: u32) -> vec3f {
    return textureSampleLevel(lightBuffer, texSampler, vec2f(0.5), 0, 0.0).rgb;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let color: Color = shade(in);
    let meta1 = renderMeta[in.entityIdx * 2u + 1u];
    if ((meta1 & RECEIVES_LIGHT_BIT) != 0u) {
        return vec4f(color.rgb * light(meta1), color.a);
    }
    return color;
}

@fragment
fn fs_occluder(in: VertexOutput) -> @location(0) vec4f {
    if (shade(in).a < 0.5) {
        discard;
    }
    return vec4f(in.uv, 1.0, 1.0);
}
`;

describe('stripComments', () => {
  it('blanks line and block comments, keeping the length and every newline', () => {
    const out = stripComments(MODULE);
    expect(out).toHaveLength(MODULE.length);
    expect(out.split('\n')).toHaveLength(MODULE.split('\n').length);
    expect(out).not.toMatch(/Instanced quad shader|0 in ForwardPass|commentedOut|hidden/);
    expect(out).toMatch(/fn shade\(in: VertexOutput\) -> vec4f \{/);
  });

  it('nests block comments, as WGSL does', () => {
    const out = stripComments('/* outer /* inner */ still a comment */ fn kept() {}');
    expect(out).not.toMatch(/still a comment/);
    expect(out.trim()).toBe('fn kept() {}');
  });

  it('ignores // inside a block comment and /* inside a line comment', () => {
    expect(stripComments('/* a // b\n c */ fn f() {}').trim()).toBe('fn f() {}');
    expect(stripComments('// no /* block here\nfn g() {}').trim()).toBe('fn g() {}');
  });

  it('runs an unterminated block comment to the end, without throwing', () => {
    expect(stripComments('fn f() {}\n/* never closed\nfn g() {}').trim()).toBe('fn f() {}');
  });
});

describe('topLevelDecls', () => {
  it('lists module-scope declarations in order, and nothing inside a body or a comment', () => {
    expect(topLevelDecls(MODULE)).toEqual([
      { kind: 'struct', name: 'CameraUniform' },
      { kind: 'var', name: 'camera' },
      { kind: 'var', name: 'transforms' },
      { kind: 'var', name: 'renderMeta' },
      { kind: 'var', name: 'tier0Tex' },
      { kind: 'var', name: 'texSampler' },
      { kind: 'var', name: 'lightBuffer' },
      { kind: 'override', name: 'OCCLUDER_PASS' },
      { kind: 'const', name: 'RECEIVES_LIGHT_BIT' },
      { kind: 'alias', name: 'Color' },
      { kind: 'struct', name: 'VertexOutput' },
      { kind: 'fn', name: 'vs_main' },
      { kind: 'fn', name: 'shade' },
      { kind: 'fn', name: 'light' },
      { kind: 'fn', name: 'fs_main' },
      { kind: 'fn', name: 'fs_occluder' },
    ]);
  });
});

describe('functionBody and functionParams', () => {
  it('returns the text between the braces, nested blocks included, comments blanked', () => {
    const body = functionBody(MODULE, 'fs_occluder')!;
    expect(body.trim().startsWith('if (shade(in).a < 0.5) {')).toBe(true);
    expect(body.trim().endsWith('return vec4f(in.uv, 1.0, 1.0);')).toBe(true);
    expect(functionBody(MODULE, 'shade')).not.toMatch(/Nested|hidden/);
  });

  it('finds the exact name, not a longer one that starts with it, nor one in a comment', () => {
    const src = '// fn shade(x) { wrong }\nfn shade_twice() -> f32 { return 2.0; }\nfn shade() -> f32 { return 1.0; }';
    expect(functionBody(src, 'shade')!.trim()).toBe('return 1.0;');
    expect(functionBody(src, 'shade_twice')!.trim()).toBe('return 2.0;');
  });

  it('answers null / [] for a function the module does not have', () => {
    expect(functionBody(MODULE, 'missing')).toBeNull();
    expect(functionParams(MODULE, 'missing')).toEqual([]);
    expect(functionBody(MODULE, 'not an identifier(')).toBeNull();
  });

  it('lists parameter names without their attributes, types or a trailing comma', () => {
    expect(functionParams(MODULE, 'vs_main')).toEqual(['position', 'instanceIdx']);
    expect(functionParams(MODULE, 'fs_main')).toEqual(['in']);
    expect(functionParams('fn f(a: array<f32, 4>, b: vec2<u32>) {}', 'f')).toEqual(['a', 'b']);
    expect(functionParams('fn g() {}', 'g')).toEqual([]);
  });
});

describe('callGraph and reachableFrom', () => {
  it('maps each function to the module-scope names it mentions, struct types included', () => {
    const graph = callGraph(MODULE);
    expect([...graph.get('vs_main')!].sort()).toEqual(['VertexOutput', 'camera', 'transforms']);
    expect([...graph.get('fs_main')!].sort()).toEqual(['Color', 'RECEIVES_LIGHT_BIT', 'VertexOutput', 'light', 'renderMeta', 'shade']);
    expect([...graph.get('fs_occluder')!].sort()).toEqual(['VertexOutput', 'shade']);
    expect(graph.has('camera')).toBe(false);
  });

  it('does not count member names, attribute arguments or number suffixes as references', () => {
    const src = `
const position = 1u;
const u = 2u;
struct S { lighting: u32 };
@group(0) @binding(0) var<uniform> lighting: S;
fn f(@builtin(position) p: vec4f, s: S) -> u32 { return s.lighting + 0xFFu + 1u; }`;
    expect([...callGraph(src).get('f')!]).toEqual(['S']);
  });

  it('counts an address-of use (&wgHist[lid]) as a reference to the module-scope name', () => {
    const src = `
var<workgroup> wgHist: array<u32, 8>;
fn f(lid: u32) { atomicAdd(&wgHist[lid], 1u); }`;
    expect([...callGraph(src).get('f')!]).toEqual(['wgHist']);
  });

  it('follows calls transitively and collects the globals on the way', () => {
    const fromMain = reachableFrom(MODULE, 'fs_main');
    expect(fromMain.has('lightBuffer')).toBe(true);
    expect(fromMain.has('tier0Tex')).toBe(true);
    expect(fromMain.has('fs_main')).toBe(false);
    const fromOccluder = reachableFrom(MODULE, 'fs_occluder');
    expect(fromOccluder.has('shade')).toBe(true);
    expect(fromOccluder.has('texSampler')).toBe(true);
    expect(fromOccluder.has('lightBuffer')).toBe(false);
    expect(fromOccluder.has('renderMeta')).toBe(false);
    expect(reachableFrom(MODULE, 'missing').size).toBe(0);
  });
});

describe('bindingDecls', () => {
  it('reads group, binding and name in either attribute order, skipping comments and non-bindings', () => {
    expect(bindingDecls(MODULE)).toEqual([
      { group: 0, binding: 0, name: 'camera' },
      { group: 0, binding: 1, name: 'transforms' },
      { group: 0, binding: 4, name: 'renderMeta' },
      { group: 1, binding: 0, name: 'tier0Tex' },
      { group: 1, binding: 4, name: 'texSampler' },
      { group: 2, binding: 0, name: 'lightBuffer' },
    ]);
    expect(bindingDecls('var<private> counter: u32;\nfn f() { var x = 1u; }')).toEqual([]);
  });
});

describe('localNames', () => {
  it('lists parameters and every let, var, var<function>, const and for-loop var, per function', () => {
    const src = `
fn helper(a: u32, @builtin(position) p: vec4f) -> u32 {
    let b = a * 2u;
    var c: u32 = b;
    var<function> d = 0u;
    const e = 3u;
    for (var i = 0u; i < 4u; i++) { c += i; }
    return c + d + e;
}`;
    expect(localNames(src)).toEqual([
      { fn: 'helper', name: 'a', kind: 'param' },
      { fn: 'helper', name: 'p', kind: 'param' },
      { fn: 'helper', name: 'b', kind: 'let' },
      { fn: 'helper', name: 'c', kind: 'var' },
      { fn: 'helper', name: 'd', kind: 'var' },
      { fn: 'helper', name: 'e', kind: 'const' },
      { fn: 'helper', name: 'i', kind: 'var' },
    ]);
    expect(localNames(MODULE).filter((l) => l.fn === 'fs_main').map((l) => l.name)).toEqual(['in', 'color', 'meta1']);
  });
});

describe('directives', () => {
  it('reads the leading directives, past comments and blank lines, and stops at the first declaration', () => {
    const src = '// header\n\ndiagnostic(off,   derivative_uniformity);\n/* x */ enable f16;\nconst a = 1u;\nenable subgroups;';
    expect(directives(src)).toEqual(['diagnostic(off, derivative_uniformity);', 'enable f16;']);
    expect(directives(MODULE)).toEqual([]);
    expect(directives('')).toEqual([]);
  });
});
